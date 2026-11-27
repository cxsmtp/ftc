"use strict";

// THE RESTORE'S EMAIL CHOICE: scripts/restore-mail.sh (operator ruling, 17 Nov
// 2026, "Choose at restore"). Step 4 of a backup's RESTORE.txt runs it with the
// server stopped: `mark-sent` writes `settings.restore_mail_floor_at` (forward
// only) and a settings_events row; `resend` writes only the row. The workers
// that read the floor are locked where they live (tests/certificate-dispatch.spec.js,
// tests/event-team-reports.spec.js); this file holds the script:
//   • SOURCE (runs everywhere): every sqlite3 call carries the pinned flags (a
//     ~/.sqliterc cannot reshape what it reads), none is softened by `|| echo`,
//     the upsert only moves forward, and the grandfather floor
//     (`certificate_dispatch_floor_at`) is never named outside the comments;
//   • with a real sqlite3 (CI has it; skipped with a reason where absent), on a
//     database built by db.js itself: what each verb writes, forward only, the
//     8.14 trap (the grandfather key stays absent), and every refusal leaving the
//     database byte for byte as it was.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { ROOT, stripShellComments } = require("./doc-registry");

const SCRIPT = path.join(ROOT, "scripts", "restore-mail.sh");
const HAVE_SQLITE3 = spawnSync("sh", ["-c", "command -v sqlite3"]).status === 0;
const NO_SQLITE3 = "this runner has no sqlite3, so the script cannot run; the SOURCE arm covers it";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test.describe("scripts/restore-mail.sh — SOURCE", () => {
  test("pinned sqlite3 flags on every call, no softened failure, a forward-only upsert, never the grandfather key", () => {
    const code = stripShellComments(fs.readFileSync(SCRIPT, "utf8"));
    const calls = code.split("\n").filter(l => /(^|[\s;&|(])sqlite3\s+-/.test(l));
    expect(calls.length, "anti-vacuity: the probe and the write").toBeGreaterThanOrEqual(2);
    for (const l of calls) expect(l, "a sqlite3 call without the pinned flags").toMatch(/sqlite3 -init \/dev\/null -batch -noheader -list /);
    expect(code, "a failed sqlite3 read is never turned into a value").not.toMatch(/sqlite3[^\n]*\|\|\s*echo/);
    expect(code.match(/WHERE excluded\.value > settings\.value/g) || [], "the floor only moves forward").toHaveLength(1);
    expect(code, "the script never writes the grandfather floor (db.js derives two upgrade decisions from its absence)")
      .not.toContain("certificate_dispatch_floor_at");
    expect(code, "BEGIN IMMEDIATE: the whole choice is one transaction").toMatch(/BEGIN IMMEDIATE;[\s\S]*COMMIT;/);
  });
});

test.describe("scripts/restore-mail.sh — with a real sqlite3", () => {
  let template, work;
  test.beforeAll(() => {
    if (!HAVE_SQLITE3) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), "restore-mail-"));
    const dataDir = path.join(work, "template");
    const uploads = path.join(work, "uploads");
    fs.mkdirSync(dataDir); fs.mkdirSync(uploads);
    // db.js builds the real schema (every migration) and stamps the grandfather floor.
    const r = spawnSync(process.execPath, ["-e", "require('./db').close()"], {
      cwd: ROOT, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dataDir, UPLOADS_DIR: uploads, NODE_OPTIONS: "" },
    });
    expect(r.status, `build the fixture database: ${r.stderr}`).toBe(0);
    for (const f of ["hackathon.db-wal", "hackathon.db-shm"]) fs.rmSync(path.join(dataDir, f), { force: true });
    template = path.join(dataDir, "hackathon.db");
  });
  test.afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

  let n = 0;
  const fresh = () => {
    const dir = path.join(work, `d${++n}`);
    fs.mkdirSync(dir);
    fs.copyFileSync(template, path.join(dir, "hackathon.db"));
    return dir;
  };
  const run = (args, env = {}) => spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  const q = (dir, sqlText) => {
    const r = spawnSync("sqlite3", ["-init", "/dev/null", "-batch", "-noheader", "-list", path.join(dir, "hackathon.db"), sqlText], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const floor = (dir) => q(dir, "SELECT value FROM settings WHERE key='restore_mail_floor_at'");
  const grand = (dir) => q(dir, "SELECT value FROM settings WHERE key='certificate_dispatch_floor_at'");
  const audits = (dir) => q(dir, "SELECT event_type||'|'||changed_by||'|'||changed_at||'|'||details FROM settings_events WHERE setting_key='restore_mail_floor_at' ORDER BY rowid")
    .split("\n").filter(Boolean).map(l => { const [type, by, at, ...d] = l.split("|"); return { type, by, at, details: JSON.parse(d.join("|")) }; });
  const sha = (dir) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "hackathon.db"))).digest("hex");

  test.beforeEach(() => { test.skip(!HAVE_SQLITE3, NO_SQLITE3); });

  test("mark-sent writes the floor (now, ISO) and one audit row, and nothing else; resend writes only the row", () => {
    const dir = fresh();
    const g0 = grand(dir);
    expect(g0, "PRECONDITION: db.js stamped the grandfather floor").toMatch(ISO);
    const before = new Date(Date.now() - 1000).toISOString();
    const r = run(["mark-sent"], { DATA_DIR: dir });
    const after = new Date(Date.now() + 1000).toISOString();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Marked as sent");
    const f = floor(dir);
    expect(f).toMatch(ISO);
    expect(f > before && f < after, `${f} is the restore instant`).toBe(true);
    const a = audits(dir);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: "updated", by: "system", at: f, details: { choice: "mark_sent", via: "scripts/restore-mail.sh", from: null, to: f } });
    expect(grand(dir), "the grandfather floor is untouched").toBe(g0);
    for (const x of ["hackathon.db-wal", "hackathon.db-shm"]) expect(fs.existsSync(path.join(dir, x)), `${x} is left behind`).toBe(false);

    // CONTROL: resend records the choice and writes no floor.
    const d2 = fresh();
    const r2 = run(["resend"], { DATA_DIR: d2 });
    expect(r2.status, r2.stderr).toBe(0);
    expect(floor(d2)).toBe("");
    expect(audits(d2).map(x => x.details)).toEqual([{ choice: "resend", via: "scripts/restore-mail.sh", to: null }]);
  });

  test("the floor only moves forward; resend never lowers it", () => {
    const dir = fresh();
    q(dir, "INSERT INTO settings (key, value) VALUES ('restore_mail_floor_at', '2999-01-01T00:00:00.000Z')");
    expect(run(["mark-sent"], { DATA_DIR: dir }).status).toBe(0);
    expect(floor(dir), "a later floor is kept").toBe("2999-01-01T00:00:00.000Z");
    expect(audits(dir)[0].details).toMatchObject({ from: "2999-01-01T00:00:00.000Z", to: "2999-01-01T00:00:00.000Z" });
    expect(run(["resend"], { DATA_DIR: dir }).status).toBe(0);
    expect(floor(dir), "resend leaves it").toBe("2999-01-01T00:00:00.000Z");
    // CONTROL: an earlier floor moves to now.
    const d2 = fresh();
    q(d2, "INSERT INTO settings (key, value) VALUES ('restore_mail_floor_at', '2000-01-01T00:00:00.000Z')");
    expect(run(["mark-sent"], { DATA_DIR: d2 }).status).toBe(0);
    expect(floor(d2) > "2026-01-01", "moved forward").toBe(true);
    expect(audits(d2)[0].details.from).toBe("2000-01-01T00:00:00.000Z");
  });

  test("mark-sent marks start reminders already due as sent, and only those; resend leaves them", () => {
    const seed = (dir) => q(dir, `INSERT INTO users (id,email,nickname,first_name,last_name,password_hash,created_at)
        VALUES ('u1','rm@acme.com','rmnick','R','M','x','2026-01-01T00:00:00.000Z');
      INSERT INTO competitions (id,name,start_time,duration_minutes,created_at,event_kind)
        VALUES ('c1','Ev1','2026-01-01T00:00:00.000Z',60,'2026-01-01T00:00:00.000Z','tournament'),
               ('c2','Ev2','2999-01-01T00:00:00.000Z',60,'2026-01-01T00:00:00.000Z','tournament');
      INSERT INTO email_reminders (user_id,competition_id,send_at,sent,created_at)
        VALUES ('u1','c1','2000-01-01T00:00:00.000Z',0,'2000-01-01T00:00:00.000Z'),
               ('u1','c2','2998-12-31T23:00:00.000Z',0,'2000-01-01T00:00:00.000Z');`);
    const sent = (dir) => q(dir, "SELECT competition_id||'='||sent FROM email_reminders ORDER BY competition_id").split("\n");
    const dir = fresh();
    seed(dir);
    expect(run(["mark-sent"], { DATA_DIR: dir }).status).toBe(0);
    expect(sent(dir), "the one already due is marked; the future one is left").toEqual(["c1=1", "c2=0"]);
    expect(audits(dir)[0].details.reminders_marked).toBe(1);
    // CONTROL: resend marks nothing.
    const d2 = fresh();
    seed(d2);
    expect(run(["resend"], { DATA_DIR: d2 }).status).toBe(0);
    expect(sent(d2)).toEqual(["c1=0", "c2=0"]);
  });

  test("a database from 8.14 keeps its grandfather key absent", () => {
    const dir = fresh();
    q(dir, "DELETE FROM settings WHERE key='certificate_dispatch_floor_at'");
    expect(run(["mark-sent"], { DATA_DIR: dir }).status).toBe(0);
    expect(floor(dir), "CONTROL: the restore floor is written").toMatch(ISO);
    expect(grand(dir), "the key db.js reads as 'this database is from 8.14' is still absent").toBe("");
  });

  test("every refusal changes nothing", () => {
    const dir = fresh();
    const h0 = sha(dir);
    const expectRefused = (r, says, what) => {
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stderr, what).toMatch(says);
      expect(sha(dir), `${what}: the database is unchanged`).toBe(h0);
    };
    expectRefused(run(["mark-sent"]), /DATA_DIR is required/, "no DATA_DIR");
    expectRefused(run(["mark-sent"], { DATA_DIR: "" }), /DATA_DIR is required/, "an empty DATA_DIR");
    expectRefused(run(["mark-sent"], { DATA_DIR: path.join(dir, "hackathon.db") }), /not a directory/, "DATA_DIR is a file");
    expectRefused(run([], { DATA_DIR: dir }), /mark-sent[\s\S]*resend/, "no verb");
    expectRefused(run(["mark-as-sent"], { DATA_DIR: dir }), /mark-sent[\s\S]*resend/, "an unknown verb");
    const empty = path.join(work, `empty${++n}`);
    fs.mkdirSync(empty);
    const r = run(["mark-sent"], { DATA_DIR: empty });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no database/);
    fs.writeFileSync(path.join(dir, "hackathon.db-wal"), "");
    expectRefused(run(["mark-sent"], { DATA_DIR: dir }), /running/, "a write-ahead log beside the database");
    fs.rmSync(path.join(dir, "hackathon.db-wal"));
    const help = run(["--help"]);
    expect(help.status, "--help needs no DATA_DIR").toBe(0);
    expect(help.stdout).toContain("Usage:");
    // CONTROL: the same database, nothing in the way.
    expect(run(["mark-sent"], { DATA_DIR: dir }).status).toBe(0);
    expect(sha(dir)).not.toBe(h0);
  });
});
