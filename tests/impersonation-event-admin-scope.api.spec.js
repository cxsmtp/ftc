"use strict";

// v8.8.6 — AN EVENT ADMIN IMPERSONATING SEES ONLY THE EVENTS THEY ORGANISE.
//
// `docs/user-guide/event-admin.md:8` has promised for two releases that "every
// list you open is already narrowed to your events". Impersonation was the one
// place that was false — which makes this a REPAIR of a stated promise rather
// than a new restriction, and is the honest framing of the whole change.
//
// The bypass is structural: `isEventAdmin(req)` returns FALSE whenever
// `req.session.impersonator` is set (correctly — while impersonating,
// `req.session.userId` is the TARGET, so a bare role read answers about the
// wrong person), so `scopedCompetitionIds` returns `null` and every predicate in
// the module answers "unscoped". The fix is a SEPARATE predicate keyed on
// `req.session.impersonator`, never a relaxation of that carve-out.
//
// MEASURED before the fix, in one event-admin impersonation session: the picker
// listed the other organiser's event; `select-competition` accepted it; `/api/tasks`
// served its challenges; `/api/tasks/:id` on an ended event with reveal-on returned
// the ANSWER KEY; `/api/leaderboard` named a third participant's nickname and
// score; and `POST /api/competitions/:id/badge` MINTED A REAL CERTIFICATE on that
// event — a durable write, because the mint is the read-only tier's one carve-out.
//
// EVERY SCOPED ASSERTION CARRIES AN UNSCOPED CONTROL. "The other event is absent"
// is equally satisfied by a build that shows nobody anything, and the participant's
// own session must be untouched — the change narrows one viewer in one session,
// not the record.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { H, buildWorld, makeParticipant, enrol, grantEventAdmin, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/** Enter impersonation from a fresh session for `email`. */
async function impersonate(email, targetId) {
  const s = email === "superadmin" ? await apiLogin("superadmin") : await apiLogin(email, PARTICIPANT_PASS);
  const r = await s.api.post(`/api/admin/participants/${targetId}/impersonate`, { headers: H(s.csrf) });
  expect(r.ok(), `impersonate ${targetId} as ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const t = await (await s.api.get("/api/csrf-token")).json();
  return { api: s.api, csrf: t.csrfToken };
}

const idsOf = async (api, path) => {
  const r = await api.get(path);
  expect(r.ok(), `${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const b = await r.json();
  return (Array.isArray(b) ? b : b.competitions || []).map(c => c.id);
};

test.describe("v8.8.6 — the impersonated view is scoped to the organiser", () => {
  /** @type {any} */ let w;
  let dual, ga;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();

    // THE FIXTURE THE WHOLE SUITE TURNS ON: one participant enrolled in BOTH the
    // event the organiser runs and one they do not. With a single-event target,
    // a list-only fix and a correct fix are indistinguishable.
    dual = await makeParticipant(w.sa, w.saCsrf, "dual");
    await enrol(w.sa, w.saCsrf, w.mine.id, [dual.id]);
    await enrol(w.sa, w.saCsrf, w.theirs.id, [dual.id]);

    // The UNSCOPED control actor: a global admin, whose impersonation must be
    // completely unchanged by this release.
    ga = await makeParticipant(w.sa, w.saCsrf, "globaladmin");
    const rr = await w.sa.post(`/api/admin/participants/${ga.id}/role`, { headers: H(w.saCsrf), data: { role: "admin" } });
    expect(rr.ok(), `promote control admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();

    // PRECONDITION: the target really is in both, or every assertion below is
    // about a fixture that never existed.
    const own = await apiLogin(dual.email, PARTICIPANT_PASS);
    const mineIds = await idsOf(own.api, "/api/me");
    expect(mineIds, "PRECONDITION — the participant is in the organiser's event").toContain(w.mine.id);
    expect(mineIds, "PRECONDITION — …and in one they do not organise").toContain(w.theirs.id);
  });

  // ── the lists ──────────────────────────────────────────────────────────────

  test("both list surfaces narrow to the organiser's own events", async () => {
    const s = await impersonate(w.ea.email, dual.id);
    for (const path of ["/api/me", "/api/my-competitions"]) {
      const ids = await idsOf(s.api, path);
      expect(ids, `${path}: the event they organise is shown`).toContain(w.mine.id);
      expect(ids, `${path}: the event they do not organise is not`).not.toContain(w.theirs.id);
    }
    // Both, or the picker and the boot payload disagree about what exists.
  });

  test("CONTROL — a GLOBAL ADMIN impersonating sees the participant's whole list", async () => {
    const s = await impersonate(ga.email, dual.id);
    const ids = await idsOf(s.api, "/api/me");
    expect(ids, "an unscoped tier is unchanged").toEqual(expect.arrayContaining([w.mine.id, w.theirs.id]));
  });

  test("CONTROL — the participant's OWN session is untouched", async () => {
    // The change narrows one viewer in one session; it must not narrow the record.
    const own = await apiLogin(dual.email, PARTICIPANT_PASS);
    const ids = await idsOf(own.api, "/api/me");
    expect(ids, "they still see both of their own events").toEqual(
      expect.arrayContaining([w.mine.id, w.theirs.id]));
  });

  // ── the entry gate: the test that decides whether the change is real ────────

  test("select-competition REFUSES an out-of-scope event — the list is not the boundary", async () => {
    // Narrowing the picker alone leaves the change cosmetic: boot re-selects from
    // the session pointer, and a hand-made POST needs no picker at all.
    const s = await impersonate(w.ea.email, dual.id);
    const bad = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.theirs.id } });
    expect(bad.status(), "an event they do not organise is refused").toBe(403);
    expect((await bad.json()).code, "…with the one code the client already knows").toBe("event_admin_out_of_scope");

    // CONTROL — refusing everything would make the feature useless rather than safe.
    const good = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.mine.id } });
    expect(good.ok(), `their own event still opens: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await s.api.get("/api/status")).ok(), "…and its context serves").toBeTruthy();
  });

  test("a grant revoked MID-SESSION stops the event serving, and writes nothing to the participant", async () => {
    const s = await impersonate(w.ea.email, dual.id);
    const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.mine.id } });
    expect(sel.ok(), "PRECONDITION — it opened while the grant was live").toBeTruthy();

    const before = await (await w.sa.get(`/api/admin/participants?limit=5000`)).json();
    const beforeRow = (before.participants || before).find(p => p.id === dual.id);

    const rev = await w.sa.delete(`/api/admin/competitions/${w.mine.id}/admins/${w.ea.id}`, { headers: H(w.saCsrf) });
    expect(rev.ok(), `revoke: ${rev.status()} ${await rev.text()}`).toBeTruthy();

    const after = await s.api.get("/api/status");
    expect(after.status(), "the scope is re-read per request, not taken from the session snapshot").toBe(403);
    expect((await after.json()).code).toBe("event_admin_out_of_scope");

    // THE TRAP THIS BRANCH EXISTS FOR: the not-found branch beside it durably
    // NULLs the TARGET's auto-resume marker and audits it against them. A GET by
    // an admin who is merely looking must write nothing to the participant.
    const afterAll = await (await w.sa.get(`/api/admin/participants?limit=5000`)).json();
    const afterRow = (afterAll.participants || afterAll).find(p => p.id === dual.id);
    expect(afterRow.active_competition_id, "the participant's own marker is untouched")
      .toBe(beforeRow.active_competition_id);

    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, w.ea.id);   // restore for later tests
  });

  // ── the empty-scope catcher ────────────────────────────────────────────────

  test("an organiser whose LAST grant is revoked mid-session sees an EMPTY list, not the whole one", async () => {
    // `null` means unscoped and `[]` means nothing; collapsing them is the
    // documented likeliest fail-open, and it shows THIS actor everything.
    //
    // RE-POINTED from "a zero-grant organiser impersonates": that is unreachable,
    // and finding out why is worth recording. Impersonation ENTRY is already
    // scoped (v8.7.0 `participantDenied`), so an organiser with no grants shares
    // no event with anybody and cannot impersonate at all. The `[]` arm is
    // therefore reached only by a grant revoked while the session is live — which
    // is a real path, and the one an organiser actually meets.
    const s = await impersonate(w.ea.email, dual.id);
    expect(await idsOf(s.api, "/api/me"), "PRECONDITION — one event while the grant is live")
      .toEqual([w.mine.id]);

    const rev = await w.sa.delete(`/api/admin/competitions/${w.mine.id}/admins/${w.ea.id}`, { headers: H(w.saCsrf) });
    expect(rev.ok(), `revoke: ${rev.status()} ${await rev.text()}`).toBeTruthy();

    expect(await idsOf(s.api, "/api/me"), "no grants left, so no events — not all of them").toEqual([]);
    expect(await idsOf(s.api, "/api/my-competitions"), "…on both surfaces").toEqual([]);

    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, w.ea.id);   // restore for later tests
  });


  // ── the one durable write, and the capability the list hands over ──────────

  test("the certificate mint is REFUSED on an out-of-scope event, and writes nothing", async () => {
    // The mint is the read-only tier's SINGLE durable carve-out (v8.3.25), so it
    // was the one way an impersonating organiser could change the platform — and
    // it was unscoped. Measured before the fix: 200, and `achievement_badges` went
    // 0 to 1 on an event they do not organise, publishing a permanent artefact in
    // that participant's name.
    //
    // The refusal sits ABOVE the eligibility ladder deliberately, so this needs no
    // ended-and-earned fixture: an out-of-scope event is refused whatever the
    // participant's standing in it, and refusing before the idempotent
    // existing-badge return is what stops the token — a live capability opening
    // the PNG, the PDF and the public page with no auth — being handed over.
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const count = () => { const d = new Database(TEST_DB_PATH); try { return d.prepare("SELECT COUNT(*) c FROM achievement_badges WHERE user_id=?").get(dual.id).c; } finally { d.close(); } };

    const before = count();
    const s = await impersonate(w.ea.email, dual.id);
    const r = await s.api.post(`/api/competitions/${w.theirs.id}/badge`, { headers: H(s.csrf) });
    expect(r.status(), "an event they do not organise is refused").toBe(403);
    expect((await r.json()).code, "…by the scope, not by the read-only tier").toBe("event_admin_out_of_scope");
    expect(count(), "and nothing was written").toBe(before);
  });

  test("CONTROL — a GLOBAL ADMIN impersonating is not refused BY THE SCOPE", async () => {
    // Without this, "the mint is refused" is satisfied by a build that disabled the
    // v8.3.25 carve-out outright — which would take the certificate away from every
    // organiser standing beside a participant, the thing that carve-out exists for.
    const s = await impersonate(ga.email, dual.id);
    const r = await s.api.post(`/api/competitions/${w.theirs.id}/badge`, { headers: H(s.csrf) });
    const body = await r.json().catch(() => ({}));
    expect(body.code, "an unscoped tier meets the ordinary eligibility ladder, not the scope gate")
      .not.toBe("event_admin_out_of_scope");
  });

  test("the certificate list hides out-of-scope events — both what they hold and what they could claim", async () => {
    // This payload carries the badge TOKEN, so leaving it unscoped while scoping
    // the mint would close the write and leave the read wide open.
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const tok = `tok${uniq("t")}`;
    const db2 = new Database(TEST_DB_PATH);
    try {
      // image_id and nickname_snapshot are NOT NULL — the row only has to be
      // well-formed enough to be SELECTed, since the read is what is under test.
      db2.prepare(`INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot, created_at)
                   VALUES (?,?,?,NULL,1,?,?,?)`)
        .run(tok, dual.id, w.theirs.id, `img${tok}`, "dualnick", new Date().toISOString());
    } finally { db2.close(); }

    // PRECONDITION via the unscoped control: the badge really exists and is
    // reachable, so "the organiser cannot see it" is about the narrowing.
    const gs = await impersonate(ga.email, dual.id);
    const gaBody = await (await gs.api.get("/api/me/certificates")).json();
    expect(JSON.stringify(gaBody), "PRECONDITION — a global admin sees it").toContain(w.theirs.id);

    const s = await impersonate(w.ea.email, dual.id);
    const body = await (await s.api.get("/api/me/certificates")).json();
    const blob = JSON.stringify(body);
    expect(blob, "the out-of-scope event is not named").not.toContain(w.theirs.id);
    expect(blob, "…nor is its badge token, which opens the artefacts with no auth").not.toContain(tok);
  });

  // ── the worst case: a staff-tagged target ──────────────────────────────────

  test("a STAFF-tagged target does not expose the whole platform", async () => {
    // The staff branch of the list builder is an UNFILTERED `SELECT … FROM
    // competitions` — staff may join anything without an assignment row — so
    // before the fix this returned EVERY competition on the platform, including
    // ones nobody is enrolled in. A fix narrowing only the membership join would
    // leave it fully open, which is why the narrowing is applied to the result.
    const staffer = await makeParticipant(w.sa, w.saCsrf, "stafftgt");
    await enrol(w.sa, w.saCsrf, w.mine.id, [staffer.id]);
    const tg = await w.sa.post(`/api/admin/participants/${staffer.id}/tags`, { headers: H(w.saCsrf), data: { tag: "staff" } });
    expect(tg.ok(), `tag staff: ${tg.status()} ${await tg.text()}`).toBeTruthy();

    const s = await impersonate(w.ea.email, staffer.id);
    const ids = await idsOf(s.api, "/api/me");
    expect(ids, "the event they organise is there").toContain(w.mine.id);
    expect(ids, "and the platform is not").not.toContain(w.theirs.id);
    expect(ids.length, "exactly their own grants, nothing wider").toBeLessThanOrEqual(1);
  });

  test("CONTROL — the staff bypass still works for the participant themselves", async () => {
    // Without this, "staff sees one event" is satisfied by a build that broke the
    // staff bypass outright, which would be a real regression for real staff.
    const staffer2 = await makeParticipant(w.sa, w.saCsrf, "staffown");
    const tg = await w.sa.post(`/api/admin/participants/${staffer2.id}/tags`, { headers: H(w.saCsrf), data: { tag: "staff" } });
    expect(tg.ok()).toBeTruthy();
    const own = await apiLogin(staffer2.email, PARTICIPANT_PASS);
    const ids = await idsOf(own.api, "/api/me");
    expect(ids.length, "a staff member still sees every event in their own session").toBeGreaterThan(1);
  });
});
