// @ts-check
//
// v8.3.39 (external audit) — A HALF-APPLIED MIGRATION MUST NOT REPORT READY.
//
// `db.js` runs ~60 migrations and wraps almost all of them in a try/catch that
// logs and carries on. That is right for the ones whose loss costs a feature and
// wrong for the ones a write path names by column — `submissions.answer_canonical`
// (every multiple-choice submit) and `users.login_code_hash` (every sign-in
// code) are both in the second group and both fail open. Nothing
// checked afterwards, and `/readyz` structurally could not: it probes `settings`
// and `users` by primary key, which succeeds whether or not a COLUMN or an INDEX
// ever landed. So an instance whose submit path 500s on every request answered
// 200 to the load balancer.
//
// IT IS NOT HYPOTHETICAL, AND THIS SPEC DOES NOT SIMULATE IT. v8.3.11 shipped a
// `CREATE UNIQUE INDEX` positioned above the ALTER that adds its column: it
// failed with `no such column`, was swallowed, and was not retried until the next
// process start. The decoy below reproduces that exact shape — a real db.js boot,
// a real migration failure, a real swallowed catch — rather than reaching into
// the database afterwards, which would prove nothing about the boot path.
//
// WHY A DECOY TABLE. Every migration in db.js is self-healing by design (probe
// the column, ALTER if absent), so dropping an object and restarting simply puts
// it back. The one thing db.js cannot repair is a NAME COLLISION: with a TABLE
// called `uq_users_linkedin_sub` present, `CREATE UNIQUE INDEX IF NOT EXISTS
// uq_users_linkedin_sub` raises "there is already a table named …" — `IF NOT
// EXISTS` does not suppress it, because a table is a different object class — and
// the catch swallows it exactly as it swallowed the v8.3.11 one. Measured: the
// server boots, serves, and the index is genuinely absent.
//
// SPAWNED SERVERS, because readiness is decided ONCE at boot from the state of
// the database that server opened. It cannot be produced on the shared test
// server, whose schema is complete — which is also what makes the second server
// the control: it proves an ordinary deployment is untouched.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { verifySchema, REQUIRED_COLUMNS, REQUIRED_INDEXES } = require("../lib/schema-required");

const { spawn } = require("child_process");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// `NODE_OPTIONS: ""` is not optional — v7.15.30: a spawned server must run OUR
// node flags, never the runner's.
async function spawnServer(port, damage) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-ready-"));
  if (damage) {
    const db = new Database(path.join(dataDir, "hackathon.db"));
    try { damage(db); } finally { db.close(); }
  }
  let out = "";
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PORT: String(port), DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
      BASE_URL: `http://127.0.0.1:${port}`,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "1",
      RATE_LIMIT_DISABLED: "1", NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", b => { out += b.toString(); });
  child.stderr.on("data", b => { out += b.toString(); });

  const base = `http://127.0.0.1:${port}`;
  // Ready when THIS child answers (tests/spawned-server.js), never /readyz: it is
  // the thing under test and on the damaged server it never turns green, so
  // waiting on it would hang the whole file.
  await readySpawnedServer({ base, child, dataDir, spawnedAt, output: () => out });
  return { child, base, dataDir, log: () => out };
}

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.3.39 — readiness reports an incomplete schema", () => {
  let broken = null;   // a real swallowed migration
  let intact = null;   // the control

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    broken = await spawnServer(PORT_BASE + 180, (db) => {
      db.exec("CREATE TABLE uq_users_linkedin_sub (decoy TEXT)");
    });
    intact = await spawnServer(PORT_BASE + 181, null);
  });

  test.afterAll(async () => {
    for (const s of [broken, intact]) {
      try { s?.child?.kill("SIGKILL"); } catch (_) {}
      try { fs.rmSync(s.dataDir, { recursive: true, force: true }); } catch (_) {}
    }
    await sleep(200);   // let the kernel release the ports (v7.29.0)
  });

  test("a swallowed migration is REPORTED, not served", async () => {
    // The premise first: db.js really did fail and really did carry on. Without
    // this the test could pass on a build where the ALTER simply never ran.
    expect(broken.log(), "the migration failed and was swallowed, exactly as in production")
      .toMatch(/users linkedin_sub migration failed/);

    const r = await fetch(`${broken.base}/readyz`);
    expect(r.status, "an instance missing a required index is NOT ready").toBe(503);
    const body = await r.json();
    expect(body.ready).toBe(false);
    expect(body.reason, "and it says which kind of problem it is").toBe("db_schema");
    // Distinct from db_integrity on purpose: "the file is corrupt" sends the
    // operator to the backups, "the upgrade did not finish" does not.
    expect(body.reason).not.toBe("db_integrity");

    // The reason is coarse because /readyz is unauthenticated. The column and
    // index names belong in the boot log, where the operator already is — and
    // they have to be THERE, or draining the box tells nobody what to fix.
    expect(body).not.toHaveProperty("missingColumns");
    // Scoped to the SCHEMA warning, not to the log as a whole. The swallowed
    // migration prints the same index name in its own error line one screen
    // earlier, so an unscoped match is satisfied by a build whose schema report
    // names nothing at all — measured: it survived the mutation that drops the
    // index list from this line.
    const at = broken.log().indexOf("schema is INCOMPLETE");
    expect(at, "the boot emits the schema warning").toBeGreaterThanOrEqual(0);
    const warn = broken.log().slice(at);
    expect(warn.slice(0, 800), "and it names the missing object").toMatch(/Missing:.*uq_users_linkedin_sub/);
    expect(warn.slice(0, 800), "…and says what happens next").toMatch(/readyz/i);

    // LIVENESS IS UNCHANGED, which is the whole point of the split: the
    // orchestrator drains the instance without killing the shell an operator
    // needs to log in and triage.
    const h = await fetch(`${broken.base}/healthz`);
    expect(h.status, "the process is alive and must stay reachable").toBe(200);
  });

  test("CONTROL: an ordinary deployment is untouched", async () => {
    // Without this, "the damaged server is not ready" is equally satisfied by a
    // build where /readyz never returns 200 for anybody.
    const r = await fetch(`${intact.base}/readyz`);
    const text = await r.text();
    expect(r.status, `a complete schema is ready: ${text}`).toBe(200);
    expect(JSON.parse(text).ready).toBe(true);
    expect(intact.log(), "and nothing is reported against it").not.toMatch(/schema is INCOMPLETE/);
  });

  test("verifySchema: what it detects, and what it says", async () => {
    // Driven against the CONTROL server's own database — a real, fully-migrated
    // file rather than a fixture, so the manifest is measured against what db.js
    // actually produces rather than against a copy of itself.
    const db = new Database(path.join(intact.dataDir, "hackathon.db"));
    try {
      const clean = verifySchema(db);
      expect(clean.ok, `a fully-migrated database is clean: ${JSON.stringify(clean)}`).toBe(true);
      expect(clean.missingColumns).toEqual([]);
      expect(clean.missingIndexes).toEqual([]);

      // A missing COLUMN, a missing INDEX, and both at once — each named.
      db.exec("ALTER TABLE submissions DROP COLUMN answer_canonical");
      db.exec("DROP INDEX uq_users_email_nocase");
      const hurt = verifySchema(db);
      expect(hurt.ok).toBe(false);
      expect(hurt.missingColumns).toContain("submissions.answer_canonical");
      expect(hurt.missingIndexes).toContain("uq_users_email_nocase");
      // Nothing ELSE is reported: an over-eager check that fired on a healthy
      // object would be silenced by whoever hit it next.
      expect(hurt.missingColumns).toHaveLength(1);
      expect(hurt.missingIndexes).toHaveLength(1);
    } finally { db.close(); }
  });

  test("verifySchema: a read failure is NOT a pass, and the manifest is not empty", async () => {
    // "The schema could not be read" is not evidence that it is fine — the same
    // direction the boot integrity check takes.
    const exploding = { prepare() { throw new Error("disk went away"); } };
    const r = verifySchema(exploding);
    expect(r.ok, "an unreadable schema is not ready").toBe(false);
    expect(r.error).toMatch(/disk went away/);

    // A missing TABLE is the missing-column case: PRAGMA table_info on a table
    // that does not exist returns an empty list rather than throwing, so this
    // would silently pass if the check trusted the absence of an error.
    const empty = new Database(":memory:");
    try {
      const r2 = verifySchema(empty);
      expect(r2.ok).toBe(false);
      expect(r2.missingColumns.length, "every required column of every missing table").toBeGreaterThan(50);
    } finally { empty.close(); }

    // ANTI-VACUITY. A rename on either side would leave the manifest matching
    // nothing and every assertion above green.
    const cols = Object.values(REQUIRED_COLUMNS).reduce((n, c) => n + c.length, 0);
    expect(cols, "the column manifest is populated").toBeGreaterThan(50);
    expect(REQUIRED_INDEXES.length, "the index manifest is populated").toBeGreaterThan(8);
  });
});
