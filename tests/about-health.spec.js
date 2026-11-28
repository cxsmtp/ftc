// @ts-check
//
// SETTINGS → ABOUT & HEALTH: WHAT IS RUNNING, AND THE BACKUPS THE APP CAN SEE
// (lib/build-info.js, lib/backup-status.js, GET /api/admin/system-health; owner
// decision, 27 Nov 2026: real details, never placeholders).
//
// A spawned server, built as the release workflow builds the image (the commit,
// build time and release channel in its environment) and given a backups folder
// (BACKUP_DIR) holding planted backups of known times and sizes. By value:
//   • the build facts are the build's, each normalised; a malformed one is null;
//   • the backups: how many, when the newest finished (its BACKUP_COMPLETE),
//     whether it did, and its size for a superadmin only (CONTROL: a regular
//     admin gets the count and time without the size);
//   • a newest backup with no BACKUP_COMPLETE is reported unfinished;
//   • a BACKUP_DIR the app cannot list says so, never zero backups.
// The shared server's "no build, no backups" answer: tests/system-health.api.spec.js.
const { test, expect, guardFixedPortSpec, _waitPortFree } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 176;
const BASE = `http://127.0.0.1:${PORT}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test.beforeEach(() => guardFixedPortSpec());

async function boot(dataDir, extraEnv) {
  const out = { text: "" };
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: path.join(dataDir, "uploads"), BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: "9", SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0", NODE_OPTIONS: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => { out.text += d; });
  child.stderr.on("data", d => { out.text += d; });
  const closed = new Promise(r => child.once("close", r));
  const password = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => out.text });
  const jar = [];
  const call = async (method, p, body, csrf) => {
    const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(jar.length ? { cookie: jar.join("; ") } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(";")[0], k = kv.split("=")[0];
      const i = jar.findIndex(x => x.startsWith(k + "=")); if (i >= 0) jar[i] = kv; else jar.push(kv);
    }
    const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch (_) { b = t; }
    return { status: r.status, body: b };
  };
  const tok = (await call("GET", "/api/csrf-token")).body.csrfToken;
  const li = await call("POST", "/api/login", { username: "superadmin", password }, tok);
  expect(li.status, `superadmin sign-in: ${JSON.stringify(li.body)}`).toBe(200);
  const csrf = (await call("GET", "/api/csrf-token")).body.csrfToken;
  return { call, csrf, async stop() { if (child.exitCode === null) child.kill("SIGKILL"); await closed; await _waitPortFree(PORT); } };
}

/** A regular admin on the spawned server, signed in with an emailed code (read back in test mode). */
async function adminClient(srv) {
  const email = `about-admin-${Date.now().toString(36)}@company.co`;
  const add = await srv.call("POST", "/api/admin/users", { email, role: "admin", first_name: "About", last_name: "Admin" }, srv.csrf);
  expect(add.status, `add admin: ${JSON.stringify(add.body)}`).toBeLessThan(300);
  const jar = [];
  const call = async (method, p, body, csrf) => {
    const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(jar.length ? { cookie: jar.join("; ") } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(";")[0], k = kv.split("=")[0];
      const i = jar.findIndex(x => x.startsWith(k + "=")); if (i >= 0) jar[i] = kv; else jar.push(kv);
    }
    const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch (_) { b = t; }
    return { status: r.status, body: b };
  };
  const tok = (await call("GET", "/api/csrf-token")).body.csrfToken;
  await call("POST", "/api/auth/code/request", { email }, tok);
  const code = (await call("GET", `/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
  const rd = await call("POST", "/api/auth/code/redeem", { email, code }, tok);
  expect(rd.body && rd.body.ok, `admin sign-in: ${JSON.stringify(rd.body)}`).toBe(true);
  return { call };
}

/** A backup directory holding `bytes` in one file, finished (or not) at `at`. */
function plantBackup(root, name, at, bytes, complete) {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(d, "hackathon.db"), Buffer.alloc(bytes, 1));
  fs.writeFileSync(path.join(d, "attachments", "a.zip"), Buffer.alloc(1024, 2));
  const t = new Date(at);
  if (complete) { fs.writeFileSync(path.join(d, "BACKUP_COMPLETE"), ""); fs.utimesSync(path.join(d, "BACKUP_COMPLETE"), t, t); }
  fs.utimesSync(d, t, t);
}

test("a release build and a mounted backups folder are reported by value; the backup size is a superadmin's", async () => {
  test.setTimeout(120_000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "about-health-"));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), "about-health-bk-"));
  let srv = null;
  try {
    plantBackup(backups, "20261125T010000Z", "2026-11-25T01:00:00.000Z", 1024 * 1024, true);
    plantBackup(backups, "2026-11-26T01-00-00Z", "2026-11-26T01:00:00.000Z", 3 * 1024 * 1024, true);
    fs.writeFileSync(path.join(backups, "not-a-backup.txt"), "x");       // a file is not a backup
    fs.mkdirSync(path.join(backups, ".hidden"));                          // nor a dot-directory
    srv = await boot(dataDir, { BUILD_COMMIT: COMMIT.toUpperCase(), BUILD_TIME: "2026-11-27T08:30:00Z", RELEASE_CHANNEL: "stable", BACKUP_DIR: backups });
    const r = await srv.call("GET", "/api/admin/system-health");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.build).toEqual({ commit: COMMIT, built_at: "2026-11-27T08:30:00.000Z", channel: "stable" });
    expect(r.body.backups).toEqual({ visible: true, count: 2, newest_at: "2026-11-26T01:00:00.000Z", newest_complete: true,
      newest_size_mib: 3, newest_size_exact: true });
    expect(JSON.stringify(r.body), "no path is answered").not.toContain(backups);
    // CONTROL: a regular admin gets the count and the time, not the size.
    const admin = await adminClient(srv);
    const a = await admin.call("GET", "/api/admin/system-health");
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.backups).toEqual({ visible: true, count: 2, newest_at: "2026-11-26T01:00:00.000Z", newest_complete: true });
    expect(a.body.build, "the build facts are everyone's").toEqual(r.body.build);

    // A newer backup with no BACKUP_COMPLETE: the newest, and unfinished.
    plantBackup(backups, "20261127T010000Z", "2026-11-27T01:00:00.000Z", 2 * 1024 * 1024, false);
    const u = await srv.call("GET", "/api/admin/system-health");
    expect(u.body.backups).toMatchObject({ count: 3, newest_at: "2026-11-27T01:00:00.000Z", newest_complete: false, newest_size_mib: 2 });
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backups, { recursive: true, force: true });
  }
});

test("a malformed build value is unknown, and a backups folder the app cannot list says so", async () => {
  test.setTimeout(120_000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "about-health2-"));
  let srv = null;
  try {
    srv = await boot(dataDir, { BUILD_COMMIT: "not-a-commit; rm -rf /", BUILD_TIME: "yesterday-ish", RELEASE_CHANNEL: "unknown", BACKUP_DIR: path.join(dataDir, "no-such-folder") });
    const r = await srv.call("GET", "/api/admin/system-health");
    expect(r.body.build).toEqual({ commit: null, built_at: null, channel: null });
    expect(r.body.backups).toEqual({ visible: false, reason: "unreadable" });
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
