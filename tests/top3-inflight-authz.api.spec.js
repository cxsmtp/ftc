// SWEEP #235 — "DOWNLOAD TOP 3" RE-ASKS AFTER ITS LAST AWAIT.
//
// GET /api/admin/competitions/:id/certificates/top3.zip reads the event's
// placement certificates, then renders each PDF and deflates the archive (every
// await it makes), then sends. Its only check after those awaits used to be the
// scope test, which answers "unscoped" for every global admin (one demoted
// meanwhile included) and read a 2 s cache for an event admin; the certificates
// were never read again, so one a superadmin revoked meanwhile still went out;
// and every file was recorded as downloaded before the archive was built.
//
// The route now re-asks after the deflate, with nothing awaited from there to the
// send: the admin (role, account and session, read live: a regular admin's
// read-only view of an organiser is a read, so admitted), the event still theirs
// (scope read fresh), each certificate still unrevoked. Held here through the
// commit park (POST /api/test/admin-commit-delay), each arm with its control:
//   * a certificate revoked while the file is prepared is left out, counted in
//     X-Top3-Revoked, and not recorded; every one revoked answers 409;
//   * an administrator demoted meanwhile (through the role door, and out of band)
//     is refused 403 admin_access_revoked, in a download's own words, and nothing
//     is recorded;
//   * an organiser whose grant is removed out of band is refused while their
//     scope cache is warm: inside the park the cache is flushed, warmed by a
//     request of their own, the grant deleted, and the park released at once,
//     all inside the cache's two seconds, so only a fresh read sees the change;
//   * a regular admin viewing an organiser's panel still downloads (the read arm),
//     and is refused once blocked meanwhile.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { signIn, makeAdmin, parked } = require("./admin-inflight-helpers");

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
const zipNames = (buf) => {
  const out = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const n = buf.readUInt16LE(i + 28);
    out.push(buf.slice(i + 46, i + 46 + n).toString("utf8"));
  }
  return out;
};
const downloads = (compId) => sql(db => db.prepare(
  "SELECT details FROM competition_events WHERE competition_id=? AND event_type='badge_certificate_downloaded' ORDER BY rowid").all(compId)).map(r => JSON.parse(r.details));
const top3 = (compId) => `/api/admin/competitions/${compId}/certificates/top3.zip`;

async function solveN(who, comp, tasks, n) {
  const p = await apiLogin(who.email, PARTICIPANT_PASS);
  try {
    expect((await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
    for (const t of tasks.slice(0, n)) {
      const g = await (await p.api.get(`/api/tasks/${t.id}`, { headers: { "x-competition-id": comp.id } })).json();
      const s = await p.api.post(`/api/tasks/${t.id}/submit`, { headers: { ...H(p.csrf), "x-competition-id": comp.id }, data: { answer: "yes", gradingHash: g.grading_hash } });
      expect(s.ok(), await s.text()).toBeTruthy();
      expect((await s.json()).correct).toBe(true);
    }
  } finally { await p.api.dispose(); }
}

/** An ended event whose first and second places hold issued certificates. */
async function podium(sa, saCsrf, label) {
  const comp = await makeCompetition(sa, saCsrf, label);
  const tasks = [];
  for (let i = 0; i < 2; i++) tasks.push(await makeTask(sa, saCsrf, `${label}t${i}`, { correct_answer: "yes" }));
  const spare = await makeTask(sa, saCsrf, `${label}s`, { correct_answer: "no" });   // unsolved: no all-solved end
  for (const t of [...tasks, spare]) await assignTask(sa, saCsrf, t.id, [comp.id]);
  const first = await makeParticipant(sa, saCsrf, `${label}a`), second = await makeParticipant(sa, saCsrf, `${label}b`);
  await enrol(sa, saCsrf, comp.id, [first.id, second.id]);
  await solveN(first, comp, tasks, 2);
  await solveN(second, comp, tasks, 1);
  const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.ok(), await end.text()).toBeTruthy();
  const tick = await sa.post("/api/test/certificate-dispatch-tick", { headers: H(saCsrf), data: { force: true, competitionId: comp.id } });
  expect(tick.ok(), await tick.text()).toBeTruthy();
  const tokenOf = (u) => sql(db => db.prepare("SELECT token FROM achievement_badges WHERE competition_id=? AND user_id=? AND revoked_at IS NULL").get(comp.id, u.id)).token;
  const pre = await sa.get(top3(comp.id));
  expect(pre.status(), "PRECONDITION: both places are downloadable").toBe(200);
  expect(zipNames(Buffer.from(await pre.body())).map(n => n.slice(0, 2)).sort()).toEqual(["1-", "2-"]);
  return { comp, first, second, tokenOf, base: downloads(comp.id).length };
}

test.describe("sweep #235 — the top-three ZIP re-asks after its last await", () => {
  test("a certificate revoked while the file is prepared is left out, counted, and not recorded; all revoked answers 409", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const f = await podium(sa, csrf, "t3rev");
    const a = await makeAdmin(sa, csrf, "t3reva", "admin");
    const A = await signIn(a.email, PARTICIPANT_PASS);
    // CONTROL: parked with nothing changed, both files go and both are recorded.
    const ok = await parked(sa, () => A.api.get(top3(f.comp.id)), null);
    expect(ok.status()).toBe(200);
    expect(zipNames(Buffer.from(await ok.body())).length).toBe(2);
    expect(ok.headers()["x-top3-revoked"]).toBeUndefined();
    expect(downloads(f.comp.id).length - f.base).toBe(2);
    // The second place revoked while the ZIP is prepared.
    const second = f.tokenOf(f.second);
    let base = downloads(f.comp.id).length;
    const r = await parked(sa, () => A.api.get(top3(f.comp.id)), async () => {
      const rv = await sa.post(`/api/admin/badges/${second}/revoke`, { headers: H(csrf), data: { reason: "sweep #235" } });
      expect(rv.ok(), await rv.text()).toBeTruthy();
    });
    expect(r.status()).toBe(200);
    const names = zipNames(Buffer.from(await r.body()));
    expect(names, "only the first place").toHaveLength(1);
    expect(names[0]).toMatch(/^1-/);
    expect(r.headers()["x-top3-count"]).toBe("1");
    expect(r.headers()["x-top3-revoked"]).toBe("1");
    const rec = downloads(f.comp.id).slice(base);
    expect(rec.map(d => d.user_id), "only the file sent is recorded").toEqual([f.first.id]);
    // Every one revoked meanwhile: nothing to send, nothing recorded.
    const first = f.tokenOf(f.first);
    base = downloads(f.comp.id).length;
    const none = await parked(sa, () => A.api.get(top3(f.comp.id)), async () => {
      const rv = await sa.post(`/api/admin/badges/${first}/revoke`, { headers: H(csrf), data: { reason: "sweep #235" } });
      expect(rv.ok(), await rv.text()).toBeTruthy();
    });
    expect(none.status()).toBe(409);
    expect((await none.json()).code).toBe("no_placement_certificates");
    expect(downloads(f.comp.id).length).toBe(base);
    await A.api.dispose();
  });

  test("an administrator demoted while the file is prepared gets nothing, and nothing is recorded", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const f = await podium(sa, csrf, "t3dem");
    // Through the role door.
    const b = await makeAdmin(sa, csrf, "t3demb", "admin");
    const B = await signIn(b.email, PARTICIPANT_PASS);
    let base = downloads(f.comp.id).length;
    const r = await parked(sa, () => B.api.get(top3(f.comp.id)), async () => {
      const d = await sa.post(`/api/admin/participants/${b.id}/role`, { headers: H(csrf), data: { role: "participant" } });
      expect(d.ok(), await d.text()).toBeTruthy();
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe("admin_access_revoked");
    expect(body.error, "in a download's own words").toMatch(/nothing was downloaded/);
    expect(downloads(f.comp.id).length).toBe(base);
    await B.api.dispose();
    // Out of band (direct SQL: no session is ended, only the row moves).
    const c = await makeAdmin(sa, csrf, "t3demc", "admin");
    const C = await signIn(c.email, PARTICIPANT_PASS);
    base = downloads(f.comp.id).length;
    const r2 = await parked(sa, () => C.api.get(top3(f.comp.id)), async () => {
      sql(db => db.prepare("UPDATE users SET role='participant' WHERE id=?").run(c.id));
    });
    expect(r2.status()).toBe(403);
    expect((await r2.json()).code).toBe("admin_access_revoked");
    expect(downloads(f.comp.id).length).toBe(base);
    // CONTROL: the certificates are still there for an admin who kept access.
    expect((await sa.get(top3(f.comp.id))).status()).toBe(200);
    await C.api.dispose();
  });

  test("an organiser whose grant is removed out of band is refused, though their scope is still cached", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const f = await podium(sa, csrf, "t3ea");
    const ea = await makeParticipant(sa, csrf, "t3eaorg");
    await grantEventAdmin(sa, csrf, f.comp.id, ea.id);
    const E = await signIn(ea.email, PARTICIPANT_PASS);
    // CONTROL: their own event, nothing changed.
    const ok = await parked(sa, () => E.api.get(top3(f.comp.id)), null, 800);
    expect(ok.status()).toBe(200);
    const base = downloads(f.comp.id).length;
    // While the download is parked: flush the organiser's cached role and scope
    // (an idempotent re-grant), warm them again with a request of their own (the
    // Events list reads both), delete the grant out of band (no cache is told),
    // and release the park at once. The re-check then runs inside the cache's
    // two seconds, so only a fresh read of the scope sees the grant gone.
    let t0 = 0;
    const r = await parked(sa, () => E.api.get(top3(f.comp.id)), async () => {
      await grantEventAdmin(sa, csrf, f.comp.id, ea.id);
      t0 = Date.now();
      const w = await E.api.get("/api/admin/competitions");
      expect(w.ok(), `warm-up: ${w.status()}`).toBeTruthy();
      sql(db => db.prepare("DELETE FROM competition_admins WHERE competition_id=? AND user_id=?").run(f.comp.id, ea.id));
      const rel = await sa.post("/api/test/admin-commit-delay", { data: { release: true } });
      expect((await rel.json()).released, "PRECONDITION: the download was let go").toBe(1);
    }, 5000);
    expect(Date.now() - t0, "PRECONDITION: answered inside the 2 s cache window, so a cached scope would still have admitted it").toBeLessThan(2000);
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("event_admin_out_of_scope");
    expect(downloads(f.comp.id).length).toBe(base);
    await E.api.dispose();
  });

  test("a regular admin viewing an organiser's panel still downloads; blocked meanwhile, they get nothing", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const f = await podium(sa, csrf, "t3imp");
    const org = await makeParticipant(sa, csrf, "t3imporg");
    await grantEventAdmin(sa, csrf, f.comp.id, org.id);
    const hand = await makeAdmin(sa, csrf, "t3imph", "admin");
    const S = await signIn(hand.email, PARTICIPANT_PASS);
    const e = await S.api.post(`/api/admin/participants/${org.id}/impersonate`, { headers: H(S.csrf), data: { view: "admin" } });
    expect(e.ok(), `view as the organiser: ${await e.text()}`).toBeTruthy();
    // The read arm: a regular admin's view is read-only, and this is a read.
    let base = downloads(f.comp.id).length;
    const ok = await parked(sa, () => S.api.get(top3(f.comp.id)), null);
    expect(ok.status(), "the read-only view downloads").toBe(200);
    expect(zipNames(Buffer.from(await ok.body())).length).toBe(2);
    expect(downloads(f.comp.id).length - base).toBe(2);
    base = downloads(f.comp.id).length;
    const r = await parked(sa, () => S.api.get(top3(f.comp.id)), async () => {
      sql(db => db.prepare("UPDATE users SET blocked=1 WHERE id=?").run(hand.id));
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("admin_access_revoked");
    expect(downloads(f.comp.id).length).toBe(base);
    sql(db => db.prepare("UPDATE users SET blocked=0 WHERE id=?").run(hand.id));
    await S.api.dispose();
  });
});
