// @ts-check
//
// THE MAIL SERVER SAVED IN THE APP (Settings → Email (SMTP); lib/email.js
// effectiveSmtpConfig / reloadSmtpTransport, lib/smtp-settings.js,
// routes/smtp-settings.js), driven against REAL relays.
//
// Each test spawns its own server.js beside two capturing relays (tests/smtp-
// capture.js, AUTH LOGIN on, so each sign-in's username and password are
// recorded): the ENVIRONMENT's relay and the one a superadmin saves. Held here:
//   • nothing saved: the environment's relay, values and sources;
//   • "Test with these values" reaches the UNSAVED relay and changes nothing;
//     a test or save naming another host never reuses the password in force;
//   • Save swaps the pool live (no restart): the next mail goes to the new relay
//     with the new sender, while a mail held mid-send on the old one completes;
//   • the saved password is stored ENCRYPTED: after a restart the relay receives
//     it decrypted, and no file in DATA_DIR (database, WAL, logs) nor any answer
//     (the read, the settings export, the audit) carries it; the key file is
//     0600 and 32 bytes;
//   • a restore without the key (`.smtp-key` is BACKUP_EXEMPT): the password is
//     unreadable, mail goes through the environment's relay meanwhile, the card
//     says so, the password must be typed again;
//   • the saved relay boots a server whose environment names none, which then
//     refuses Remove; with neither, boot stops FATAL and says how to fix it;
//   • the relay's health check is reported, with its time.
const { test, expect, guardFixedPortSpec, _waitPortFree } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORT = PORT_BASE + 174;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV_USER = "env-relay-user";
const ENV_PASS = "Env-Relay-Pass-7731";
const APP_USER = "app-relay-user";
const APP_PASS = "App-Relay-Secret-9q4Z";
const ENV_SENDER = "env-sender@acme.test";
const APP_SENDER = "app-sender@acme.test";

test.beforeEach(() => guardFixedPortSpec());

function client() {
  const jar = [];
  const call = async (method, p, data, headers = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { "content-type": "application/json", ...(jar.length ? { cookie: jar.join("; ") } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(";")[0], k = kv.split("=")[0];
      const i = jar.findIndex(x => x.startsWith(k + "="));
      if (i >= 0) jar[i] = kv; else jar.push(kv);
    }
    const t = await r.text();
    let body = t;
    try { body = JSON.parse(t); } catch (e) { body = t; }
    return { status: r.status, body, text: t };
  };
  let csrf = null;
  const c = {
    async refreshCsrf() { csrf = (await call("GET", "/api/csrf-token")).body.csrfToken; },
    get: (p) => call("GET", p),
    send: (m, p, d) => call(m, p, d, { "x-csrf-token": csrf }),
  };
  return c;
}

/** Spawn server.js on the fixed port; resolves with a signed-in superadmin client. */
async function boot(dataDir, envOverrides) {
  const out = { text: "" };
  const spawnedAt = Date.now();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
    PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: path.join(dataDir, "uploads"), BASE_URL: BASE,
    SMTP_ALLOW_PLAINTEXT: "1", SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1", HSTS: "0",
    LOG_CONSOLE_MIRROR: "0", NODE_OPTIONS: "",
    ...envOverrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => { out.text += d; });
  child.stderr.on("data", d => { out.text += d; });
  const closed = new Promise(r => child.once("close", r));
  const password = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => out.text });
  const c = client();
  await c.refreshCsrf();
  const li = await c.send("POST", "/api/login", { username: "superadmin", password });
  expect(li.status, `superadmin sign-in: ${li.text}`).toBe(200);
  await c.refreshCsrf();
  return { child, out, c, async stop() { if (child.exitCode === null) child.kill("SIGKILL"); await closed; await _waitPortFree(PORT); } };
}

function envFor(relay) {
  return { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(relay.port), SMTP_USER: ENV_USER, SMTP_PASS: ENV_PASS, EMAIL_FROM: ENV_SENDER };
}
const appValues = (relay, extra = {}) => ({ host: "127.0.0.1", port: relay.port, security: "starttls", username: APP_USER, password: APP_PASS, sender: APP_SENDER, ...extra });

/** Continue on the entry screen for a new work address: an address proof, sent through the pool. */
async function mailProof(tag) {
  const c = client();
  await c.refreshCsrf();
  const email = `${tag}-${Date.now().toString(36)}@company.co`;
  const r = await c.send("POST", "/api/auth/code/request", { email });
  expect(r.status, `code request ${tag}: ${r.text}`).toBe(200);
  return email;
}
const to = (relay, addr) => relay.messages.find(m => m.rcptTo.some(t => t.toLowerCase() === addr.toLowerCase()));

/** Every byte under DATA_DIR (database, WAL, logs, key) that holds `needle`. */
function filesHolding(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes(Buffer.from(needle, "utf8"))) hits.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return hits;
}

function tmpDataDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `smtp-${tag}-`)); }

test("nothing saved: the environment's relay; a test reaches unsaved values; Save swaps the relay live and a held mail completes", async () => {
  test.setTimeout(150_000);
  const envRelay = await startSmtpCapture({ auth: true });
  const appRelay = await startSmtpCapture({ auth: true });
  const dataDir = tmpDataDir("swap");
  let srv = null;
  try {
    srv = await boot(dataDir, envFor(envRelay));
    const { c } = srv;
    const g = await c.get("/api/admin/smtp-settings");
    expect(g.status, g.text).toBe(200);
    expect(g.body.in_use).toEqual({ source: "environment", host: "127.0.0.1", port: envRelay.port, security: "starttls",
      username: ENV_USER, sender: ENV_SENDER, sender_source: "environment", password_set: true });
    expect(g.body.saved).toBeNull();
    expect(g.body.version).toBeNull();
    expect(g.body.can_edit).toBe(true);
    expect(g.text, "the read never carries the environment's password").not.toContain(ENV_PASS);

    // Positive control: mail goes to the environment's relay, signed in with its credentials.
    const a = await mailProof("envmail");
    const ma = await envRelay.waitFor(m => m.rcptTo.includes(a));
    expect(ma.envelopeFrom).toBe(ENV_SENDER);
    expect(envRelay.logins).toContainEqual({ user: ENV_USER, pass: ENV_PASS });

    // Test with UNSAVED values: reaches the other relay, signs in with the typed password, saves nothing.
    const t = await c.send("POST", "/api/admin/smtp-settings/test", { ...appValues(appRelay), to: "tester@acme.test" });
    expect(t.status, t.text).toBe(200);
    const mt = await appRelay.waitFor(m => m.rcptTo.includes("tester@acme.test"));
    expect(mt.envelopeFrom, "the test is sent from the candidate sender").toBe(APP_SENDER);
    expect(appRelay.logins).toContainEqual({ user: APP_USER, pass: APP_PASS });
    expect((await c.get("/api/admin/smtp-settings")).body.in_use.source, "a test saves nothing").toBe("environment");

    // The password in force is never sent to another host: a test (and a save)
    // naming a new host with the box empty is refused, and the other relay is
    // not signed in to with the environment's password.
    const { password: _drop, ...noPw } = appValues(appRelay);
    const refusedTest = await c.send("POST", "/api/admin/smtp-settings/test", { ...noPw, host: "localhost", to: "tester2@acme.test" });
    expect(refusedTest.status, refusedTest.text).toBe(400);
    expect(refusedTest.body.code).toBe("smtp_password_required");
    const refusedSave = await c.send("PUT", "/api/admin/smtp-settings", { ...noPw, host: "localhost", expectedVersion: null });
    expect(refusedSave.body.code).toBe("smtp_password_required");
    expect(appRelay.logins.some(l => l.pass === ENV_PASS), "the environment's password never reached another relay").toBe(false);

    // A stale version is refused before anything is written.
    const stale = await c.send("PUT", "/api/admin/smtp-settings", { ...appValues(appRelay), expectedVersion: "0123456789abcdef" });
    expect(stale.status, stale.text).toBe(409);
    expect(stale.body.code).toBe("smtp_settings_changed");

    // A mail held mid-send on the environment's relay while the relay is swapped.
    envRelay.hold();
    const held = await mailProof("heldmail");
    await expect.poll(() => envRelay.heldCount(), { timeout: 15000, message: "PRECONDITION: a mail is parked mid-send" }).toBe(1);
    const s = await c.send("PUT", "/api/admin/smtp-settings", { ...appValues(appRelay), expectedVersion: null });
    expect(s.status, s.text).toBe(200);
    expect(s.body.in_use).toMatchObject({ source: "app", port: appRelay.port, username: APP_USER, sender: APP_SENDER, sender_source: "app", password_set: true });
    expect(s.body.saved).toMatchObject({ password_set: true, sender: APP_SENDER });
    expect(typeof s.body.version).toBe("string");
    expect(s.text, "the save's answer never carries the password").not.toContain(APP_PASS);

    // The next mail goes to the saved relay, no restart.
    const b = await mailProof("appmail");
    const mb = await appRelay.waitFor(m => m.rcptTo.includes(b));
    expect(mb.envelopeFrom, "the sender address follows the saved relay").toBe(APP_SENDER);
    expect(to(envRelay, b), "the new mail did not go to the old relay").toBeUndefined();

    // The held mail completes on the retired pool.
    envRelay.release();
    const db = new (require("better-sqlite3"))(path.join(dataDir, "hackathon.db"), { readonly: true });
    try {
      const sent = () => db.prepare("SELECT details FROM orphan_events WHERE event_type='email_sent'").all().map(r => JSON.parse(r.details));
      await expect.poll(() => sent().length, { timeout: 15000, message: "every proof mail is recorded" }).toBeGreaterThanOrEqual(3);
      expect(sent().filter(d => d.success !== true), "no mail failed, the one held across the swap included").toEqual([]);
    } finally { db.close(); }
    expect(to(envRelay, held), "the held mail reached the relay it started on").toBeTruthy();
  } finally {
    try { envRelay.release(); } catch (_) {}
    if (srv) await srv.stop();
    await envRelay.close(); await appRelay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the saved password is encrypted: it survives a restart, appears in no file, answer, export or audit row, and a restore without the key falls back to the environment", async () => {
  test.setTimeout(180_000);
  const envRelay = await startSmtpCapture({ auth: true });
  const appRelay = await startSmtpCapture({ auth: true });
  const dataDir = tmpDataDir("enc");
  let srv = null;
  try {
    srv = await boot(dataDir, envFor(envRelay));
    expect(fs.existsSync(path.join(dataDir, ".smtp-key")), "PRECONDITION: no key before a password is saved").toBe(false);
    const s = await srv.c.send("PUT", "/api/admin/smtp-settings", { ...appValues(appRelay), expectedVersion: null });
    expect(s.status, s.text).toBe(200);
    const keyPath = path.join(dataDir, ".smtp-key");
    const st = fs.statSync(keyPath);
    expect(st.mode & 0o777, "the key file is owner-only").toBe(0o600);
    expect(st.size).toBe(32);

    // The audit names what changed, never the secret values.
    const ev = await srv.c.get("/api/admin/settings/events?limit=50");
    expect(ev.status, ev.text).toBe(200);
    expect(ev.text).toContain("password_changed");
    expect(ev.text).toContain(`"host"`);
    expect(ev.text).not.toContain(APP_PASS);
    expect(ev.text, "the username is half a credential: named, not written").not.toContain(APP_USER);
    const ex = await srv.c.get("/api/admin/export/settings");
    expect(ex.status, ex.text).toBe(200);
    expect(ex.body.settings.smtp_config, "the saved relay is redacted from the settings export").toBe("[REDACTED]");
    expect(ex.text).not.toContain(APP_PASS);

    // Restart on the same data: the relay receives the DECRYPTED password.
    await srv.stop();
    srv = await boot(dataDir, envFor(envRelay));
    const g = await srv.c.get("/api/admin/smtp-settings");
    expect(g.body.in_use.source).toBe("app");
    expect(g.body.password_unreadable).toBe(false);
    const a = await mailProof("restart");
    await appRelay.waitFor(m => m.rcptTo.includes(a));
    expect(appRelay.logins.at(-1)).toEqual({ user: APP_USER, pass: APP_PASS });
    await srv.stop(); srv = null;
    expect(filesHolding(dataDir, APP_PASS), "the password is in no file under DATA_DIR (database, WAL, logs)").toEqual([]);
    // Negative control for the search: a non-secret saved value IS found in the database.
    expect(filesHolding(dataDir, APP_SENDER).some(f => f.startsWith("hackathon.db")), "the search reads the database files").toBe(true);

    // A RESTORE: the backup carries the database, never the key.
    fs.rmSync(keyPath);
    srv = await boot(dataDir, envFor(envRelay));
    const u = await srv.c.get("/api/admin/smtp-settings");
    expect(u.body.password_unreadable).toBe(true);
    expect(u.body.in_use.source, "mail goes through the environment's relay meanwhile").toBe("environment");
    expect(u.body.saved).toMatchObject({ host: "127.0.0.1", port: appRelay.port, password_set: true });
    const b = await mailProof("restored");
    await envRelay.waitFor(m => m.rcptTo.includes(b));
    expect(to(appRelay, b)).toBeUndefined();
    // The unreadable password is never "kept": it must be typed again.
    const { password: _drop, ...noPw } = appValues(appRelay);
    const r1 = await srv.c.send("PUT", "/api/admin/smtp-settings", { ...noPw, expectedVersion: u.body.version });
    expect(r1.status, r1.text).toBe(400);
    expect(r1.body.code).toBe("smtp_password_required");
    const r2 = await srv.c.send("PUT", "/api/admin/smtp-settings", { ...appValues(appRelay), expectedVersion: u.body.version });
    expect(r2.status, r2.text).toBe(200);
    expect(r2.body.in_use.source).toBe("app");
    expect(r2.body.password_unreadable).toBe(false);
    const c2 = await mailProof("retyped");
    await appRelay.waitFor(m => m.rcptTo.includes(c2));

    // Saving again with the box empty keeps the saved password (same host and username).
    const r3 = await srv.c.send("PUT", "/api/admin/smtp-settings", { ...noPw, sender: "app-sender-2@acme.test", expectedVersion: r2.body.version });
    expect(r3.status, r3.text).toBe(200);
    const d3 = await mailProof("kept");
    await appRelay.waitFor(m => m.rcptTo.includes(d3));
    expect(appRelay.logins.at(-1), "the kept password still signs in").toEqual({ user: APP_USER, pass: APP_PASS });

    // Remove: back to the environment.
    const del = await srv.c.send("DELETE", "/api/admin/smtp-settings", { expectedVersion: r3.body.version });
    expect(del.status, del.text).toBe(200);
    expect(del.body.in_use.source).toBe("environment");
    expect(del.body.saved).toBeNull();
    const e = await mailProof("removed");
    await envRelay.waitFor(m => m.rcptTo.includes(e));
  } finally {
    if (srv) await srv.stop();
    await envRelay.close(); await appRelay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a saved relay starts a server whose environment names none, and Remove is then refused; with neither, boot stops and says how to fix it", async () => {
  test.setTimeout(150_000);
  const appRelay = await startSmtpCapture({ auth: true });
  const envRelay = await startSmtpCapture({ auth: true });
  const dataDir = tmpDataDir("noenv");
  const bare = tmpDataDir("bare");
  let srv = null;
  try {
    // With neither: FATAL, naming SMTP_HOST and the Settings page.
    const r = spawnSync(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PORT: String(PORT), DATA_DIR: bare,
        UPLOADS_DIR: path.join(bare, "uploads"), BASE_URL: BASE, NODE_OPTIONS: "" },
      encoding: "utf8", timeout: 60_000,
    });
    expect(r.status, "boot stops without any relay").toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/FATAL: no mail relay is configured\. Set SMTP_HOST[^]*Settings → Email \(SMTP\)/);

    // Save a relay, then start without any SMTP_* in the environment.
    srv = await boot(dataDir, envFor(envRelay));
    const s = await srv.c.send("PUT", "/api/admin/smtp-settings", { ...appValues(appRelay), expectedVersion: null });
    expect(s.status, s.text).toBe(200);
    await srv.stop();
    srv = await boot(dataDir, { SMTP_HOST: undefined, EMAIL_FROM: undefined });
    const g = await srv.c.get("/api/admin/smtp-settings");
    expect(g.body.in_use.source).toBe("app");
    expect(g.body.environment_relay).toBe(false);
    const a = await mailProof("noenv");
    await appRelay.waitFor(m => m.rcptTo.includes(a));
    const del = await srv.c.send("DELETE", "/api/admin/smtp-settings", { expectedVersion: g.body.version });
    expect(del.status, del.text).toBe(409);
    expect(del.body.code).toBe("smtp_environment_missing");
    expect((await srv.c.get("/api/admin/smtp-settings")).body.in_use.source, "nothing was removed").toBe("app");
  } finally {
    if (srv) await srv.stop();
    await envRelay.close(); await appRelay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("the relay's health check is reported with its time, and starts over when the relay changes", async () => {
  test.setTimeout(120_000);
  const envRelay = await startSmtpCapture({ auth: true });
  const dataDir = tmpDataDir("health");
  let srv = null;
  try {
    // Outside NODE_ENV=test the platform probes its relay 3 s after start.
    srv = await boot(dataDir, { ...envFor(envRelay), NODE_ENV: "development" });
    await expect.poll(async () => (await srv.c.get("/api/admin/smtp-settings")).body.health.state, { timeout: 20000 }).toBe(true);
    const h = (await srv.c.get("/api/admin/smtp-settings")).body.health;
    expect(Number.isFinite(Date.parse(h.checked_at)), `a check time: ${JSON.stringify(h)}`).toBe(true);
    // Saving a relay that does not answer: the state starts over, then reports the failure.
    const deadPort = PORT_BASE + 175;
    const s = await srv.c.send("PUT", "/api/admin/smtp-settings", { host: "127.0.0.1", port: deadPort, security: "starttls", username: "", sender: APP_SENDER, expectedVersion: null });
    expect(s.status, s.text).toBe(200);
    expect(s.body.health.state, "a new relay has not been checked yet").toBeNull();
    await expect.poll(async () => (await srv.c.get("/api/admin/smtp-settings")).body.health.state, { timeout: 30000 }).toBe(false);
  } finally {
    if (srv) await srv.stop();
    await envRelay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
