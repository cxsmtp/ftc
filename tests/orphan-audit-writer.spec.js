// @ts-check
//
// THE ORPHANED-EVENT WRITER (lib/audit.js `recordOrphanedAuditEvent`): the DB
// copy the Audit page lists for an event that has no `*_events` row of its own
// (a deleted entity, an export, a credential lookup).
//
// Locked here, each with a control:
//   * the event a copy is about is lifted from `details.competition_id` /
//     `details.timeslot_id`, or else from the scope id itself, but only for its
//     own scope (an event admin's Audit page filters on these columns in SQL);
//   * details are stored through the log redactor: a secret named in them never
//     reaches the stored copy, while an ordinary value is kept;
//   * the copy is NON-FATAL: a refused insert inside a caller's transaction does
//     not undo the caller's write (the copy must never undo the act it records);
//   * live: deleting an event leaves a `deleted` copy tied to the deleted id,
//     which only the scope fallback can supply (the route passes no id in details).
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

test("the writer lifts each copy's event, redacts its details and never undoes the caller's write", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-orphan-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-orphan-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const { recordOrphanedAuditEvent } = R("lib/audit.js");
    const row = (type) => db.prepare("SELECT competition_id, timeslot_id, details FROM orphan_events WHERE event_type=?").get(type) || null;
    const ids = (type) => { const r = row(type); return r && [r.competition_id, r.timeslot_id]; };
    const out = {};
    recordOrphanedAuditEvent("competition", "C1", "t_comp_scope", "a", { name: "x" });
    recordOrphanedAuditEvent("export", "team-leads", "t_details_comp", "a", { competition_id: "C2" });
    recordOrphanedAuditEvent("timeslot", "T1", "t_ts_scope", "a", { competition_id: "C3" });
    recordOrphanedAuditEvent("user", "U1", "t_details_ts", "a", { timeslot_id: "T2" });
    recordOrphanedAuditEvent("user", "U2", "t_none", "a", {});
    out.lift = { compScope: ids("t_comp_scope"), detailsComp: ids("t_details_comp"), tsScope: ids("t_ts_scope"), detailsTs: ids("t_details_ts"), none: ids("t_none") };
    recordOrphanedAuditEvent("user", "U9", "t_redact", "a", { password: "PW1secret", join_code: "JC1secret", nested: { csrf_token: "TK1secret" }, note: "keep-me" });
    out.redacted = row("t_redact").details;
    // A copy the database refuses, inside a caller's transaction.
    db.exec("CREATE TRIGGER orphan_boom BEFORE INSERT ON orphan_events WHEN NEW.event_type='t_boom' BEGIN SELECT RAISE(ABORT, 'refused'); END");
    out.txnThrew = null;
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO settings (key, value) VALUES ('orphan_probe', '1')").run();
        recordOrphanedAuditEvent("user", "U3", "t_boom", "a", {});
      })();
      out.txnThrew = false;
    } catch (e) { out.txnThrew = String(e && e.message); }
    out.probe = !!db.prepare("SELECT 1 FROM settings WHERE key='orphan_probe'").get();
    out.boom = !!row("t_boom");
    db.exec("DROP TRIGGER orphan_boom");
    recordOrphanedAuditEvent("user", "U4", "t_fine", "a", {});
    out.fine = !!row("t_fine");
    process.stdout.write("\\nORPHAN_OUT " + JSON.stringify(out) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("ORPHAN_OUT "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    const out = JSON.parse(line.slice("ORPHAN_OUT ".length));
    expect(out.lift).toEqual({
      compScope: ["C1", null],     // a competition-scoped copy names its own id
      detailsComp: ["C2", null],   // any scope: the details' competition_id
      tsScope: ["C3", "T1"],       // a session-scoped copy names its own id, and its event from details
      detailsTs: [null, "T2"],     // any scope: the details' timeslot_id
      none: [null, null],          // CONTROL: the scope fallback is for its own scope only
    });
    for (const secret of ["PW1secret", "JC1secret", "TK1secret"]) expect(out.redacted, `${secret} is not stored`).not.toContain(secret);
    const d = JSON.parse(out.redacted);
    expect([d.password, d.join_code, d.nested.csrf_token], "each named secret is marked redacted").toEqual(["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
    expect(d.note, "CONTROL: an ordinary value is kept").toBe("keep-me");
    expect(out.txnThrew, "the refused copy did not throw out of the caller's transaction").toBe(false);
    expect(out.probe, "the caller's own write committed").toBe(true);
    expect(out.boom, "the refused copy is not stored").toBe(false);
    expect(out.fine, "CONTROL: with the refusal gone, a copy is stored").toBe(true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("deleting an event leaves its 'deleted' copy tied to the deleted event's id", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const H = { "x-csrf-token": csrf, "content-type": "application/json" };
  const name = `Orphan del ${Date.now().toString(36)}`;
  const cr = await sa.post("/api/admin/competitions", { headers: H, data: {
    name, event_kind: "tournament", start_time: new Date(Date.now() + 86400e3).toISOString(), duration_minutes: 60, timezone: "UTC",
  } });
  expect(cr.status(), await cr.text()).toBe(200);
  const id = (await cr.json()).competition.id;
  const Database = require("better-sqlite3");
  const read = () => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return db.prepare("SELECT competition_id, details FROM orphan_events WHERE scope='competition' AND scope_id=? AND event_type='deleted'").all(id);
    } finally { db.close(); }
  };
  expect(read(), "PRECONDITION: no copy before the delete").toEqual([]);
  const del = await sa.delete(`/api/admin/competitions/${id}`, { headers: H });
  expect(del.status(), await del.text()).toBe(200);
  const rows = read();
  expect(rows, "one copy of the deletion").toHaveLength(1);
  expect(JSON.parse(rows[0].details).competition_id, "PRECONDITION: the route names no event in details").toBeUndefined();
  expect(rows[0].competition_id, "the copy is tied to the deleted event").toBe(id);
});
