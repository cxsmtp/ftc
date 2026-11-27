"use strict";

// A PARTICIPANT'S HISTORY MUST NOT NAME AN EVENT OUTSIDE THE READER'S SCOPE,
// WHATEVER KEY NAMES IT.
//
// The History dialog (`GET /api/admin/participants/:id/events`) narrowed only on
// `details.competition_id`. `active_competition_changed` names its two events as
// `from` / `to`, so an event admin scoped to A read "moved from A to B" — B's id,
// and with it the fact the participant plays an event they do not organise. The
// person export already dropped such rows with a JS walk of its own; both now
// pass the ONE clause `userEventCompetitionScopeSql` (lib/event-admin.js).
//
// Fixtures, each owned here:
//   * REAL rows: a participant enrolled in A (in scope) and B (out of scope)
//     selects A, then B, then A — the select-competition route writes
//     `active_competition_changed` {from,to} for each move. Each enrolment also
//     mails them, and that `email_sent` row records its event (operator ruling,
//     17 Nov 2026: lib/email.js `sendEmailLogged`'s `about`).
//   * PLANTED email rows: an older one with no event recorded whose subject
//     names B (a scoped reader gets it WITHOUT its subject: userEventDetailsSql),
//     one recorded about B (withheld), about A and about no event (both shown
//     with their subjects).
//   * PLANTED rows (the read is the subject, not the writer): a pin move whose
//     `from` names a DELETED event (only the strict-key arm can see it — no
//     competitions row exists to match), an unlisted nested key naming B (only
//     the any-value backstop sees it), and a `role_changed` whose from/to are
//     roles (must stay visible: the strict from/to compare is confined to
//     `active_competition_changed`).
//
// Every withheld assertion has a superadmin control proving the row exists.

const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { H, makeParticipant, makeCompetition, enrol, grantEventAdmin, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const HISTORY = (id) => `/api/admin/participants/${id}/events?paginated=1&limit=200`;
const PERSON = (id) => `/api/admin/participants/${id}/export/full`;

test.describe("participant History — an event admin sees no row naming another event", () => {
  /** @type {any} */ let w = {};

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const s = await apiLogin("superadmin");
    w.sa = s.api; w.saCsrf = s.csrf;
    w.A = await makeCompetition(w.sa, w.saCsrf, "histA");
    w.B = await makeCompetition(w.sa, w.saCsrf, "histB");
    w.ea = await makeParticipant(w.sa, w.saCsrf, "histea");
    w.p = await makeParticipant(w.sa, w.saCsrf, "histp");
    await enrol(w.sa, w.saCsrf, w.A.id, [w.p.id]);
    await enrol(w.sa, w.saCsrf, w.B.id, [w.p.id]);
    await grantEventAdmin(w.sa, w.saCsrf, w.A.id, w.ea.id);
    const l = await apiLogin(w.ea.email, PARTICIPANT_PASS);
    w.eaApi = l.api;
    const me = await (await w.eaApi.get("/api/admin/me")).json();
    expect(me.isEventAdmin, "PRECONDITION — the actor holds the tier").toBe(true);
    expect(me.eventAdminCompetitionCount, "…scoped to exactly event A").toBe(1);

    // The participant moves A -> B -> A through the real route.
    const pl = await apiLogin(w.p.email, PARTICIPANT_PASS);
    for (const cid of [w.A.id, w.B.id, w.A.id]) {
      const r = await pl.api.post("/api/select-competition", { headers: H(pl.csrf), data: { competitionId: cid } });
      expect(r.ok(), `select ${cid}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }

    // Planted rows, each carrying a unique marker so it can be found by value.
    w.deletedId = `deleted-${uniq("ev")}`;
    w.markDeleted = uniq("mdel");
    w.markNested = uniq("mnest");
    w.markRole = uniq("mrole");
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const db = new Database(TEST_DB_PATH);
    try {
      const ins = db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      const at = new Date().toISOString();
      ins.run(uniq("ue"), w.p.id, "active_competition_changed", "system", at,
        JSON.stringify({ from: w.deletedId, to: null, reason: "parent_deleted", marker: w.markDeleted }));
      ins.run(uniq("ue"), w.p.id, "test_cross_event", "system", at,
        JSON.stringify({ marker: w.markNested, provenance: { source: [{ event: w.B.id }] } }));
      ins.run(uniq("ue"), w.p.id, "role_changed", "system", at,
        JSON.stringify({ from: "participant", to: "event_admin", marker: w.markRole }));
      // Email rows, each found by its `to` (kept on every row) and its subject marker.
      for (const k of ["Old", "B", "A", "None"]) { w[`mail${k}`] = `${uniq("m" + k.toLowerCase())}@example.test`; w[`subj${k}`] = uniq("s" + k.toLowerCase()); }
      const mail = (to, subject, reason, about) => ins.run(uniq("ue"), w.p.id, "email_sent", "system", at,
        JSON.stringify({ to, subject, reason, success: true, ...about }));
      mail(w.mailOld, `Hack Arena — ${w.B.name} starts in 1 hour ${w.subjOld}`, "reminder", {});
      mail(w.mailB, `Your certificate for ${w.B.name} ${w.subjB}`, "certificate_awarded", { competition_id: w.B.id });
      mail(w.mailA, `Your certificate for ${w.A.name} ${w.subjA}`, "certificate_awarded", { competition_id: w.A.id });
      mail(w.mailNone, `Your password was changed ${w.subjNone}`, "password_changed_notification", { competition_id: null });
    } finally { db.close(); }
  });

  test("the real pin moves are written, and a superadmin sees every row (CONTROL)", async () => {
    const r = await w.sa.get(HISTORY(w.p.id));
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    const moves = body.events.filter(e => e.event_type === "active_competition_changed")
      .map(e => (typeof e.details === "string" ? JSON.parse(e.details) : e.details));
    expect(moves.some(d => d.from === w.A.id && d.to === w.B.id), "A -> B was recorded").toBe(true);
    expect(moves.some(d => d.from === w.B.id && d.to === w.A.id), "B -> A was recorded").toBe(true);
    const blob = JSON.stringify(body);
    for (const v of [w.B.id, w.deletedId, w.markDeleted, w.markNested, w.markRole]) {
      expect(blob, `the superadmin sees ${v}`).toContain(v);
    }
    expect(body.total).toBe(body.events.length);
  });

  test("the event admin's History names no out-of-scope event, by value, and total matches", async () => {
    const r = await w.eaApi.get(HISTORY(w.p.id));
    expect(r.ok(), `history: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const blob = JSON.stringify(body);
    expect(blob, "event A is still named").toContain(w.A.id);
    for (const [v, what] of [[w.B.id, "B's id"], [w.B.name, "B's name"], [w.deletedId, "a deleted event's id"],
      [w.markDeleted, "the deleted-event pin row"], [w.markNested, "the nested-key row"]]) {
      expect(blob, `${what} is absent`).not.toContain(v);
    }
    // NEGATIVE CONTROL — from/to holding roles is not an event; the row stays.
    expect(blob, "a role_changed row (from/to are roles) is still shown").toContain(w.markRole);
    // An in-scope pin move (from null / to A) survives: not "hide every move".
    const moves = body.events.filter(e => e.event_type === "active_competition_changed");
    expect(moves.length, "the first pin to A is still shown").toBeGreaterThan(0);
    expect(body.total, "the count is over the narrowed set").toBe(body.events.length);
  });

  test("the person export uses the same definition: the same rows are absent", async () => {
    const r = await w.eaApi.get(PERSON(w.p.id));
    expect(r.status(), await r.text()).toBe(200);
    const text = JSON.stringify(await r.json());
    for (const v of [w.B.id, w.B.name, w.deletedId, w.markDeleted, w.markNested]) {
      expect(text, `${v} is absent from the export`).not.toContain(v);
    }
    expect(text, "the role row is kept").toContain(w.markRole);
    expect(text, "an older email row reaches the export without its subject").not.toContain(w.subjOld);
    expect(text, "a mail recorded about A keeps its subject").toContain(w.subjA);
    expect(text, "a mail about B is absent").not.toContain(w.mailB);
    const c = await w.sa.get(PERSON(w.p.id));
    expect(c.status()).toBe(200);
    const ctext = JSON.stringify(await c.json());
    for (const v of [w.B.id, w.deletedId, w.markNested]) expect(ctext, `CONTROL — superadmin export has ${v}`).toContain(v);
  });

  test("email rows: one about another event is withheld, an older one loses its subject, a recorded one keeps it", async () => {
    const rows = async (api) => {
      const r = await api.get(HISTORY(w.p.id));
      expect(r.ok(), `history: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).events.filter(e => e.event_type === "email_sent")
        .map(e => (typeof e.details === "string" ? JSON.parse(e.details) : e.details));
    };
    const byTo = (list, to) => list.filter(d => d.to === to);
    const assignFor = (list, cid) => list.filter(d => d.reason === "competition_assignment" && Array.isArray(d.competition_ids) && d.competition_ids.includes(cid));
    // CONTROL — the superadmin sees every row whole, and each real enrolment mail names its event.
    const all = await rows(w.sa);
    for (const k of ["Old", "B", "A", "None"]) {
      expect(byTo(all, w[`mail${k}`]).length, `the planted ${k} row exists`).toBe(1);
      expect(byTo(all, w[`mail${k}`])[0].subject, `…with its subject`).toContain(w[`subj${k}`]);
    }
    expect(assignFor(all, w.A.id).length, "the real mail enrolling them in A recorded A").toBe(1);
    expect(assignFor(all, w.B.id).length, "the real mail enrolling them in B recorded B").toBe(1);
    // The event admin of A.
    const ea = await rows(w.eaApi);
    const blob = JSON.stringify(ea);
    const old = byTo(ea, w.mailOld);
    expect(old.length, "an older email row is still listed").toBe(1);
    expect(old[0].subject, "…without its subject").toBeUndefined();
    expect(old[0].subject_withheld, "…and says so").toBe(true);
    expect(blob, "the older row's subject is nowhere").not.toContain(w.subjOld);
    expect(byTo(ea, w.mailB).length, "a mail recorded about B is withheld").toBe(0);
    expect(blob, "B's subject marker is nowhere").not.toContain(w.subjB);
    expect(byTo(ea, w.mailA)[0].subject, "a mail recorded about A keeps its subject").toContain(w.subjA);
    expect(byTo(ea, w.mailNone)[0].subject, "a mail recorded about no event keeps its subject").toContain(w.subjNone);
    expect(assignFor(ea, w.B.id).length, "the real mail about B is withheld").toBe(0);
    const mine = assignFor(ea, w.A.id);
    expect(mine.length, "the real mail about A is shown").toBe(1);
    expect(mine[0].subject, "…with its subject").toBeTruthy();
  });
});
