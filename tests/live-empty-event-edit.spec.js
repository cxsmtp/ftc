// v8.3.10 — A SUPERADMIN MAY CORRECT A LIVE EVENT NOBODY HAS TOUCHED.
//
// The operator's rule: an event that is running but has no users associated with
// it may still be edited, including its start date and time — the ordinary case
// being an event that went live on a mistyped date with nobody in it.
//
// WHAT MAKES THIS MORE THAN A RELAXED GUARD, and what most of this file is
// actually protecting: `start_time` is an INPUT to the status function
// (`_singleSlotStatus` is `now < start -> upcoming`), so moving it forward flips
// the event live -> upcoming. That is the platform's only un-start, and every
// "locked once started" guard keys on that time-derived status, so they all
// re-open. That is CORRECT here and only here, because the footprint predicate
// has already established the event has no history for those guards to protect.
// Weaken `eventParticipantFootprint` and the whole argument collapses — which is
// why the controls below matter more than the happy path.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const fs = require("fs");
const path = require("path");

const SRC = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
// Strip comments before scanning, keeping line count. Several comments added by
// this very change quote the calls the scanners below forbid or require, and a
// scanner that reads its own documentation is the v7.21.13 trap.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `lee${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${await r.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Live", lastName: "Empty", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `search` is a NO-OP on this endpoint (it is page 1 ordered created_at ASC),
  // so the documented 5000 cap is what actually finds a just-created account.
  const list = await (await api.get("/api/admin/participants?limit=5000")).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} findable among ${(list.participants || []).length} participants`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email };
}

/**
 * A SLOTLESS competition that is live right now. No challenges and nobody
 * enrolled, so it is pristine by construction — and with zero participants the
 * all-solved auto-end cannot fire (fixture checklist item 1).
 */
async function makeLiveComp(api, csrf, { minsAgo = 30, duration = 240 } = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `LiveEmpty ${uniq()}`,
      start_time: new Date(Date.now() - minsAgo * 60_000).toISOString(),
      duration_minutes: duration,
    },
  });
  expect(r.ok(), `create live comp: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  expect(comp.status, "fixture must actually be LIVE, or every assertion here is about the wrong state").toBe("live");
  return comp;
}

const listComp = async (api, id) =>
  (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);

test.describe("v8.3.10 — editing a LIVE event that nobody has touched", () => {
  test("a superadmin moves the start of a pristine live event, and it un-starts", async () => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeLiveComp(api, csrf);
      // The wire must OFFER it before we try — the affordance and the refusal
      // come from one predicate, so a null flag is the promise the PUT keeps.
      expect((await listComp(api, comp.id)).start_time_locked,
        "a superadmin viewing a pristine live event must be offered the control").toBeNull();

      const moved = new Date(Date.now() + 2 * 3600_000).toISOString();
      const r = await api.put(`/api/admin/competitions/${comp.id}`, { headers: H(csrf), data: { start_time: moved } });
      expect(r.status(), `pristine live start move: ${await r.text()}`).toBe(200);

      const after = await listComp(api, comp.id);
      expect(new Date(after.start_time).toISOString()).toBe(moved);
      // The un-start itself. This is the behaviour the operator asked for, and
      // asserting the STATUS rather than just the column is what proves the move
      // did what it looks like it did.
      expect(after.status, "moving the start into the future un-starts the event").toBe("upcoming");
    } finally { await api.dispose(); }
  });

  test("a REGULAR admin is refused — the permission is superadmin-only", async () => {
    const { api, csrf } = await sa();
    const { api: ra, csrf: rc0 } = await freshCtx();
    try {
      const comp = await makeLiveComp(api, csrf);
      const admin = await makeParticipant(api, csrf, uniq());
      expect((await api.post(`/api/admin/participants/${admin.id}/role`, { headers: H(csrf), data: { role: "admin" } })).ok()).toBeTruthy();

      expect((await codeLogin(ra, admin.email, H(rc0))).ok()).toBeTruthy();
      const rc = (await (await ra.get("/api/csrf-token")).json()).csrfToken;

      // The form must WITHHOLD it for this tier, with its reason.
      const seen = (await (await ra.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      expect(seen.start_time_locked, "a regular admin is not offered the control").toBe("requires_superadmin");

      const r = await ra.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(rc), data: { start_time: new Date(Date.now() + 2 * 3600_000).toISOString() },
      });
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe("start_time_locked_tier");
    } finally { await ra.dispose(); await api.dispose(); }
  });

  test("a live event WITH an enrolled participant is refused", async () => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeLiveComp(api, csrf);
      const p = await makeParticipant(api, csrf, uniq());
      const asg = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { competitionIds: [comp.id], userIds: [p.id] },
      });
      expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
      // The assign endpoint SILENTLY SKIPS ineligible users, so assert it landed
      // or this test measures an empty event and passes for the wrong reason.
      expect((await asg.json()).assigned, "the participant must actually be enrolled").toBe(1);

      expect((await listComp(api, comp.id)).start_time_locked).toBe("has_participants");
      // TWO attach points, and they are genuinely separate code: the admin LIST
      // builds its own curated projection, while every single-competition
      // response goes through `_compWire`. Pinning only the list left the
      // `_compWire` half unpinned — a mutation nulling it there passed the entire
      // file. An ordinary name-change PUT is the stable place to assert it: the
      // reason here is "somebody is enrolled", which no clock boundary can move.
      const named = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { name: `LiveEmpty renamed ${uniq()}` },
      });
      expect(named.status(), await named.text()).toBe(200);
      expect((await named.json()).competition.start_time_locked,
        "_compWire must publish the reason too, not only the admin list").toBe("has_participants");

      const r = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { start_time: new Date(Date.now() + 2 * 3600_000).toISOString() },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).code).toBe("start_time_locked_in_use");
    } finally { await api.dispose(); }
  });

  test("ZERO MEMBERS IS NOT PRISTINE — a removed participant still locks it", async () => {
    // THE LOAD-BEARING TEST. A head-count of `competition_users` says this event
    // is empty; it is not. Removing a member who has ENTERED deletes the
    // membership row and deliberately preserves the history (the v8.1.0 leave
    // rule — a re-join is lossless), recording an absence row that carries the
    // solve-clock anchor. Staff are the other half of the same hole: they act
    // with no membership row at all. If this predicate is ever "simplified" to a
    // COUNT of competition_users, this test is what goes red.
    //
    // THE PARTICIPANT MUST ACTUALLY ENTER, and that is not ceremony: the absence
    // row is written only for somebody who ENTERED (lib/competitions.js
    // `recordRemovalAbsence`: an anchor, or an entry on a first-open clock), so an
    // assigned-but-never-entered participant who is then removed leaves NOTHING
    // — correctly, because nothing happened. Selecting the competition is what
    // stamps the anchor and makes the removal leave a mark.
    const { api, csrf } = await sa();
    try {
      const comp = await makeLiveComp(api, csrf);
      const p = await makeParticipant(api, csrf, uniq());
      const asg = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { competitionIds: [comp.id], userIds: [p.id] },
      });
      expect((await asg.json()).assigned).toBe(1);

      const { api: pa, csrf: pc0 } = await freshCtx();
      try {
        expect((await codeLogin(pa, p.email, H(pc0))).ok()).toBeTruthy();
        const pc = (await (await pa.get("/api/csrf-token")).json()).csrfToken;
        const sel = await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } });
        expect(sel.ok(), `participant must actually enter: ${await sel.text()}`).toBeTruthy();
      } finally { await pa.dispose(); }

      const rem = await api.delete(`/api/admin/competitions/${comp.id}/users/${p.id}`, { headers: H(csrf) });
      expect(rem.ok(), `remove: ${await rem.text()}`).toBeTruthy();
      expect((await rem.json()).removed, "the membership must actually be gone, or the premise fails").toBe(true);

      const seen = await listComp(api, comp.id);
      expect(seen.participant_count, "the head-count really is zero — that is the trap").toBe(0);
      expect(seen.start_time_locked, "…and the event is still NOT pristine").toBe("has_participants");

      const r = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { start_time: new Date(Date.now() + 2 * 3600_000).toISOString() },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).code).toBe("start_time_locked_in_use");
    } finally { await api.dispose(); }
  });

  test("a start that would push the end into the past is refused, not silently ended", async () => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeLiveComp(api, csrf, { minsAgo: 10, duration: 60 });
      // Back far enough that start + duration is behind us.
      const r = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { start_time: new Date(Date.now() - 5 * 3600_000).toISOString() },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).code).toBe("start_time_would_end_event");
      const after = await listComp(api, comp.id);
      expect(after.status, "the refusal must leave the event exactly as it was").toBe("live");
      expect(new Date(after.start_time).toISOString()).toBe(new Date(comp.start_time).toISOString());
    } finally { await api.dispose(); }
  });

  test("an ENDED event is still refused", async () => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeLiveComp(api, csrf);
      const ended = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf), data: {} });
      expect(ended.ok()).toBeTruthy();
      // v8.12.4 — the `_compWire` half is asserted on the end-now RESPONSE again.
      // It was withdrawn because `_singleSlotStatus` treated a stamped `ended_at`
      // as INCLUSIVE, so the response, built a few synchronous statements after
      // the stamp, could read `live` for that one millisecond. A stamped end is
      // exclusive now (lib/competitions.js), so the response is deterministic.
      const endedBody = await ended.json();
      expect(endedBody.competition.status, "the end-now response already says ended").toBe("ended");
      expect(endedBody.competition.start_time_locked).toBe("ended");
      expect((await listComp(api, comp.id)).start_time_locked).toBe("ended");
      const r = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { start_time: new Date(Date.now() + 2 * 3600_000).toISOString() },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).code).toBe("start_time_locked_ended");
    } finally { await api.dispose(); }
  });

  test("echoing the UNCHANGED start still passes (v7.7.26 preserved)", async () => {
    // The whole-form client round-trips start_time on every save. This has been
    // true since v7.7.26 and the relaxation must not have quietly re-broken it —
    // note it must also hold for a NON-pristine event, which is the case the
    // v7.7.26 fix was actually about.
    const { api, csrf } = await sa();
    try {
      const comp = await makeLiveComp(api, csrf);
      const p = await makeParticipant(api, csrf, uniq());
      expect((await (await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { competitionIds: [comp.id], userIds: [p.id] },
      })).json()).assigned).toBe(1);

      const stored = (await listComp(api, comp.id)).start_time;
      const r = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { name: `LiveEmpty renamed ${uniq()}`, start_time: new Date(stored).toISOString() },
      });
      expect(r.status(), `unchanged start on a comp WITH members: ${await r.text()}`).toBe(200);
    } finally { await api.dispose(); }
  });

  test("an UPCOMING event's start is still freely editable (nothing narrowed)", async () => {
    // The control for the whole file: every refusal above is equally satisfied by
    // a build that locked start_time harder, which would be a regression.
    const { api, csrf } = await sa();
    try {
      const r0 = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `Upcoming ${uniq()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 },
      });
      const comp = (await r0.json()).competition;
      expect(comp.status).toBe("upcoming");
      expect(comp.start_time_locked, "an upcoming event never locks its start").toBeNull();
      const moved = new Date(Date.now() + 5 * 3600_000).toISOString();
      const r = await api.put(`/api/admin/competitions/${comp.id}`, { headers: H(csrf), data: { start_time: moved } });
      expect(r.status(), await r.text()).toBe(200);
      expect(new Date((await listComp(api, comp.id)).start_time).toISOString()).toBe(moved);
    } finally { await api.dispose(); }
  });

  test("DELETE gains the same carve-out: a pristine live event goes, one in use does not", async () => {
    const { api, csrf } = await sa();
    try {
      // In use -> refused, and the refusal names WHY rather than the old flat sentence.
      const used = await makeLiveComp(api, csrf);
      const p = await makeParticipant(api, csrf, uniq());
      expect((await (await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { competitionIds: [used.id], userIds: [p.id] },
      })).json()).assigned).toBe(1);
      const refused = await api.delete(`/api/admin/competitions/${used.id}`, { headers: H(csrf) });
      expect(refused.status()).toBe(400);
      expect((await refused.json()).error).toMatch(/in use/i);
      expect(await listComp(api, used.id), "the refused competition must survive").toBeTruthy();

      // Pristine -> deleted.
      const pristine = await makeLiveComp(api, csrf);
      const gone = await api.delete(`/api/admin/competitions/${pristine.id}`, { headers: H(csrf) });
      expect(gone.status(), `delete pristine live: ${await gone.text()}`).toBe(200);
      expect(await listComp(api, pristine.id), "the pristine competition must be gone").toBeFalsy();
    } finally { await api.dispose(); }
  });

  // ---------------------------------------------------------------------------
  // SOURCE LOCKS — the two halves nothing above can reach, pinned honestly.
  // Neither is claimed as behaviourally covered; each says what it does prove.
  // ---------------------------------------------------------------------------

  test("SOURCE: the footprint is re-asked INSIDE the write transaction", () => {
    // The window between the pre-flight check and the commit is real — at a
    // Booth Event the /join QR can be scanned inside it — but it cannot be driven
    // from a spec: the transaction body is synchronous, so there is no moment at
    // which a second request could be issued. What IS checkable is that the
    // re-check exists, sits inside `editTxn`, and is scoped so the ordinary edit
    // does not pay for it.
    const src = stripComments(SRC("routes/competitions.js"));
    const i = src.indexOf("const editTxn = db.transaction(");
    expect(i, "editTxn must exist").toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("\n  });", i));
    expect(body, "the footprint must be re-asked inside the transaction, not only before it")
      .toMatch(/eventParticipantFootprint\(/);
    expect(body, "and it must be scoped to a start change on a live event")
      .toMatch(/_startChanged\s*&&\s*oldStatus === "live"/);
  });

  test("SOURCE: the admin form READS start_time_locked, it does not re-derive it", () => {
    // The affordance half. If the client keeps deriving the lock from the status
    // it holds, the whole server relaxation is unreachable from a browser — which
    // by this repo's doctrine is not a shipped feature. A browser test would need
    // a live pristine event rendered in the form; this pins the mechanism, not
    // the pixels, and is the reason the old `compStatus==='live'` derivation must
    // not come back.
    const src = stripComments(SRC("public/js/features/competitions-admin.js"));
    expect(src, "the form must consult the server's answer").toMatch(/comp\.start_time_locked/);
    expect(src, "the pre-v8.3.10 local derivation must not be the lock's source again")
      .not.toMatch(/const lockStart\s*=\s*comp\s*&&\s*\(compStatus\s*===\s*'live'/);
    // Every reason the server can return needs a sentence, or the control is
    // withheld with no explanation — the v7.14.2 support-ticket shape.
    for (const reason of ["has_participants", "requires_superadmin", "has_sessions", "ended"]) {
      expect(src, `_startLockNote must explain "${reason}"`).toContain(`case '${reason}':`);
    }
  });
});
