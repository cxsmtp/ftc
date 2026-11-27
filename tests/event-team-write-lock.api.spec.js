"use strict";

// EVENT TEAM WRITES WAIT OUT A BRIEF EXTERNAL WRITE LOCK.
//
// Adding a team member reads (the size cap, a duplicate) before it writes, and
// the targets PUT reads its version before the upsert. As DEFERRED transactions
// those reads took a shared lock and the write's upgrade failed SQLITE_BUSY at
// once, busy_timeout never consulted, while another process held the write lock
// (an operator's sqlite3 session, `scripts/purge.sh --apply`): a generic 500.
// Taken IMMEDIATE, each waits the lock out like any other write.
//
// Each arm holds `BEGIN IMMEDIATE` on the worker server's database, releases it
// only once the server is SEEN parked on it (tests/transient-lock.js), and then
// asserts the write landed by value and that the request really contended.

const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeCompetition } = require("./event-admin-helpers");
const { withTransientLock, expectContended } = require("./transient-lock");

function dbGet(sql, ...a) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
}

let sa, saCsrf;
test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
});
test.afterAll(async () => { try { await sa?.dispose(); } catch (_) {} });

test.describe("event team writes, parked on a brief external write lock", () => {
  test("adding a team member waits the lock out and stores the member", async () => {
    const comp = await makeCompetition(sa, saCsrf, "teamlock-add");
    // The allowed-domain list is a global setting: restored to its default (none) below.
    const d = await sa.put("/api/admin/team-report-domains", { headers: H(saCsrf), data: { domains: ["corp.example"] } });
    expect(d.ok(), `domains: ${d.status()} ${await d.text()}`).toBeTruthy();
    try {
      const email = `${uniq("lockadd").toLowerCase()}@corp.example`;
      const h = await withTransientLock(() => sa.post(`/api/admin/competitions/${comp.id}/team`, {
        headers: H(saCsrf), data: { role: "marketing", name: "Mona", email }, timeout: 30_000,
      }));
      const txt = await h.r.text();
      expect(h.r.status(), `waited out, not refused: ${txt}`).toBe(200);
      const member = JSON.parse(txt).member;
      expect(member && member.email).toBe(email);
      const row = dbGet("SELECT role, name, email FROM event_team_members WHERE id=? AND competition_id=?", member.id, comp.id);
      expect(row, "the member is stored").toEqual({ role: "marketing", name: "Mona", email });
      expect(dbGet("SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='team_member_added'", comp.id).c, "recorded once").toBe(1);
      await expectContended(h);
    } finally {
      const r = await sa.put("/api/admin/team-report-domains", { headers: H(saCsrf), data: { domains: [] } });
      expect(r.ok(), `restore domains: ${r.status()}`).toBeTruthy();
      expect((await (await sa.get("/api/admin/team-report-domains")).json()).domains).toEqual([]);
    }
  });

  test("saving the team's targets waits the lock out and stores them", async () => {
    const comp = await makeCompetition(sa, saCsrf, "teamlock-targets");
    const before = await (await sa.get(`/api/admin/competitions/${comp.id}/team`)).json();
    expect(before.targets, "PRECONDITION: no targets yet").toEqual({ lead_target: null, hot_lead_target: null });
    const h = await withTransientLock(() => sa.put(`/api/admin/competitions/${comp.id}/team-targets`, {
      headers: H(saCsrf), data: { lead_target: 42, hot_lead_target: 7, expectedUpdatedAt: before.targets_updated_at }, timeout: 30_000,
    }));
    const txt = await h.r.text();
    expect(h.r.status(), `waited out, not refused: ${txt}`).toBe(200);
    expect(JSON.parse(txt).targets).toEqual({ lead_target: 42, hot_lead_target: 7 });
    expect(dbGet("SELECT lead_target, hot_lead_target FROM event_team_settings WHERE competition_id=?", comp.id)).toEqual({ lead_target: 42, hot_lead_target: 7 });
    await expectContended(h);
  });
});
