// THE FULL EVENT AND PERSON EXPORTS RE-ASK AFTER THEIR LAST AWAIT.
//
// Both downloads check access, build the files, then deflate them (their one
// await) and send. Until the re-ask, nothing was checked after the deflate: an
// administrator demoted meanwhile, an organiser whose event was taken from them,
// or an admin who started competing in the event still got the file, and it was
// recorded as exported. Each route now re-asks after the deflate, with nothing
// awaited from there to the send, the top-three ZIP's shape (CLAUDE.md
// *Roles, scope and impersonation*: adminAuthzDenied after the last await).
//
// Held through the commit park (POST /api/test/admin-commit-delay), each arm
// beside a control parked with nothing changed:
//   * an administrator demoted while the event file is prepared: 403
//     admin_access_revoked, nothing recorded;
//   * an organiser whose grant is removed out of band while their scope cache is
//     warm: 403 event_admin_out_of_scope (the cache flushed, warmed and the park
//     released inside its two seconds, so only a fresh read sees the change);
//   * an administrator enrolled meanwhile in the staff-compete event they are
//     exporting: 403 competitor_cannot_edit;
//   * the person export's ZIP: the same demotion and organiser arms. Its JSON
//     variant has no await and is recorded as before (the control for the
//     recording itself);
//   * the person export's ZIP for an organiser of TWO events the person is in,
//     who loses one while the file is prepared: still allowed the person (they
//     share the other), but the file was built with the lost event's rows, so
//     it is refused, 403 event_admin_out_of_scope, and nothing is recorded.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { signIn, makeAdmin, parked } = require("./admin-inflight-helpers");

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
const EVENT_URL = (id) => `/api/admin/competitions/${id}/export/full`;
const PERSON_URL = (id, q = "?format=zip-csv") => `/api/admin/participants/${id}/export/full${q}`;
/** data_exported rows recorded for this event's full export. */
const eventExports = (compId) => sql(db => db.prepare(
  "SELECT COUNT(*) AS n FROM orphan_events WHERE scope='export' AND scope_id='competition-full' AND event_type='data_exported' AND json_extract(details,'$.competition_id')=?"
).get(compId)).n;
/** …and for this person's export. */
const personExports = (userId) => sql(db => db.prepare(
  "SELECT COUNT(*) AS n FROM orphan_events WHERE scope='export' AND scope_id='person-full' AND event_type='data_exported' AND json_extract(details,'$.user_id')=?"
).get(userId)).n;
const isZip = (r) => expect(r.headers()["content-type"], "a ZIP").toMatch(/application\/zip/);

/** While a request is parked: flush the organiser's cached role and scope (an
 *  idempotent re-grant), warm them with a request of their own, delete the grant
 *  out of band and release the park at once. Returns the release time. */
async function dropGrantWarm(sa, csrf, E, compId, eaId) {
  await grantEventAdmin(sa, csrf, compId, eaId);
  const t0 = Date.now();
  const w = await E.api.get("/api/admin/competitions");
  expect(w.ok(), `warm-up: ${w.status()}`).toBeTruthy();
  sql(db => db.prepare("DELETE FROM competition_admins WHERE competition_id=? AND user_id=?").run(compId, eaId));
  const rel = await sa.post("/api/test/admin-commit-delay", { data: { release: true } });
  expect((await rel.json()).released, "PRECONDITION: the download was let go").toBe(1);
  return t0;
}

test.describe("the full exports re-ask after their last await", () => {
  test("event export: an administrator demoted while the file is prepared gets nothing, and nothing is recorded", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const comp = await makeCompetition(sa, csrf, "fxinfl");
    const p = await makeParticipant(sa, csrf, "fxinflp");
    await enrol(sa, csrf, comp.id, [p.id]);
    const a = await makeAdmin(sa, csrf, "fxinfla", "admin");
    const A = await signIn(a.email, PARTICIPANT_PASS);
    try {
      // CONTROL: parked with nothing changed, the file goes and is recorded once.
      let base = eventExports(comp.id);
      const ok = await parked(sa, () => A.api.get(EVENT_URL(comp.id)), null);
      expect(ok.status(), (await ok.text()).slice(0, 200)).toBe(200);
      isZip(ok);
      expect(eventExports(comp.id) - base, "the file sent is recorded").toBe(1);
      // Demoted out of band while parked: no session ends, only the row moves.
      base = eventExports(comp.id);
      const r = await parked(sa, () => A.api.get(EVENT_URL(comp.id)), async () => {
        sql(db => db.prepare("UPDATE users SET role='participant' WHERE id=?").run(a.id));
      });
      expect(r.status(), (await r.text()).slice(0, 200)).toBe(403);
      expect((await r.json()).code).toBe("admin_access_revoked");
      expect(eventExports(comp.id), "a refused file is not recorded").toBe(base);
    } finally { await A.api.dispose(); }
  });

  test("event export: an organiser whose grant is removed out of band is refused, though their scope is still cached", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const comp = await makeCompetition(sa, csrf, "fxinfo");
    const ea = await makeParticipant(sa, csrf, "fxinforg");
    await grantEventAdmin(sa, csrf, comp.id, ea.id);
    const E = await signIn(ea.email, PARTICIPANT_PASS);
    try {
      const ok = await parked(sa, () => E.api.get(EVENT_URL(comp.id)), null, 800);
      expect(ok.status(), "CONTROL: their own event, nothing changed").toBe(200);
      const base = eventExports(comp.id);
      let t0 = 0;
      const r = await parked(sa, () => E.api.get(EVENT_URL(comp.id)), async () => {
        t0 = await dropGrantWarm(sa, csrf, E, comp.id, ea.id);
      }, 5000);
      expect(Date.now() - t0, "PRECONDITION: answered inside the 2 s cache window").toBeLessThan(2000);
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe("event_admin_out_of_scope");
      expect(eventExports(comp.id)).toBe(base);
    } finally { await E.api.dispose(); }
  });

  test("event export: an administrator who starts competing in the event while the file is prepared is refused", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const comp = await makeCompetition(sa, csrf, "fxinfc", { staff_compete: true });
    const a = await makeAdmin(sa, csrf, "fxinfca", "admin");
    const A = await signIn(a.email, PARTICIPANT_PASS);
    try {
      const ok = await parked(sa, () => A.api.get(EVENT_URL(comp.id)), null);
      expect(ok.status(), "CONTROL: not competing, the file goes").toBe(200);
      const base = eventExports(comp.id);
      const r = await parked(sa, () => A.api.get(EVENT_URL(comp.id)), async () => {
        await enrol(sa, csrf, comp.id, [a.id]);
      });
      expect(r.status(), (await r.text()).slice(0, 200)).toBe(403);
      expect((await r.json()).code).toBe("competitor_cannot_edit");
      expect(eventExports(comp.id)).toBe(base);
    } finally { await A.api.dispose(); }
  });

  test("person export ZIP: a demoted administrator and an organiser who lost the event get nothing; the JSON is recorded as before", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const comp = await makeCompetition(sa, csrf, "fxinfp");
    const p = await makeParticipant(sa, csrf, "fxinfpp");
    await enrol(sa, csrf, comp.id, [p.id]);
    const a = await makeAdmin(sa, csrf, "fxinfpa", "admin");
    const A = await signIn(a.email, PARTICIPANT_PASS);
    const ea = await makeParticipant(sa, csrf, "fxinfporg");
    await grantEventAdmin(sa, csrf, comp.id, ea.id);
    const E = await signIn(ea.email, PARTICIPANT_PASS);
    try {
      // CONTROL: the JSON (no await) and the parked ZIP each go and are recorded once.
      let base = personExports(p.id);
      const j = await A.api.get(PERSON_URL(p.id, ""));
      expect(j.status()).toBe(200);
      expect(personExports(p.id) - base, "the JSON is recorded").toBe(1);
      base = personExports(p.id);
      const ok = await parked(sa, () => A.api.get(PERSON_URL(p.id)), null);
      expect(ok.status(), (await ok.text()).slice(0, 200)).toBe(200);
      isZip(ok);
      expect(personExports(p.id) - base, "the ZIP sent is recorded").toBe(1);
      // Demoted out of band while the ZIP is parked.
      base = personExports(p.id);
      const r = await parked(sa, () => A.api.get(PERSON_URL(p.id)), async () => {
        sql(db => db.prepare("UPDATE users SET role='participant' WHERE id=?").run(a.id));
      });
      expect(r.status(), (await r.text()).slice(0, 200)).toBe(403);
      expect((await r.json()).code).toBe("admin_access_revoked");
      expect(personExports(p.id), "a refused file is not recorded").toBe(base);
      // The organiser: CONTROL, then their grant removed while their scope is cached.
      const eok = await parked(sa, () => E.api.get(PERSON_URL(p.id)), null, 800);
      expect(eok.status(), "CONTROL: a participant of their event").toBe(200);
      base = personExports(p.id);
      let t0 = 0;
      const r2 = await parked(sa, () => E.api.get(PERSON_URL(p.id)), async () => {
        t0 = await dropGrantWarm(sa, csrf, E, comp.id, ea.id);
      }, 5000);
      expect(Date.now() - t0, "PRECONDITION: answered inside the 2 s cache window").toBeLessThan(2000);
      expect(r2.status()).toBe(403);
      expect((await r2.json()).code).toBe("event_admin_out_of_scope");
      expect(personExports(p.id)).toBe(base);
    } finally { await A.api.dispose(); await E.api.dispose(); }
  });

  test("person export ZIP: an organiser of two events who loses one while the file is prepared is refused (CONTROL: the same request with nothing changed)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const c1 = await makeCompetition(sa, csrf, "fxnarrow1");
    const c2 = await makeCompetition(sa, csrf, "fxnarrow2");
    const p = await makeParticipant(sa, csrf, "fxnarrowp");
    await enrol(sa, csrf, c1.id, [p.id]);
    await enrol(sa, csrf, c2.id, [p.id]);
    const ea = await makeParticipant(sa, csrf, "fxnarroworg");
    await grantEventAdmin(sa, csrf, c1.id, ea.id);
    await grantEventAdmin(sa, csrf, c2.id, ea.id);
    const E = await signIn(ea.email, PARTICIPANT_PASS);
    try {
      const ok = await parked(sa, () => E.api.get(PERSON_URL(p.id)), null, 800);
      expect(ok.status(), "CONTROL: both events still theirs, the file goes").toBe(200);
      isZip(ok);
      const base = personExports(p.id);
      let t0 = 0;
      const r = await parked(sa, () => E.api.get(PERSON_URL(p.id)), async () => {
        t0 = await dropGrantWarm(sa, csrf, E, c1.id, ea.id);
      }, 5000);
      expect(Date.now() - t0, "PRECONDITION: answered inside the 2 s cache window").toBeLessThan(2000);
      expect(r.status(), (await r.text()).slice(0, 200)).toBe(403);
      expect((await r.json()).code).toBe("event_admin_out_of_scope");
      expect(personExports(p.id), "a refused file is not recorded").toBe(base);
      // They still share c2 with the person, so a fresh request goes: the refusal
      // was the narrowing seen mid-request, not a lost person.
      const again = await E.api.get(PERSON_URL(p.id));
      expect(again.status(), "PRECONDITION: the person is still theirs through the other event").toBe(200);
    } finally { await E.api.dispose(); }
  });
});
