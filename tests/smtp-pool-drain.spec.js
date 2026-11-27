// @ts-check
//
// THE POOLED SMTP TRANSPORT AND THE SHUTDOWN DRAIN (lib/email.js, server.js
// gracefulShutdown).
//
// The transport became a pool (`pool: true`) so a room pressing "Send code" at
// once queues behind a bounded set of relay connections instead of opening one
// each. A pooled send can sit in the pool's queue, so the shutdown drain must
// still wait for it: a SIGTERM while a sign-in mail is mid-send must deliver it,
// report "mail drained", close the pool and exit 0 — never close the database
// under it.
//
// This needs a REAL SIGTERM path, which NODE_ENV=test switches off, so the file
// spawns its own server under NODE_ENV=development against a capturing relay.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 199;
const BASE = `http://127.0.0.1:${PORT}`;

test.beforeEach(() => guardFixedPortSpec());

/** Best-effort cleanup steps record what failed instead of hiding it. */
const cleanupNotes = [];
const note = (what) => (e) => { cleanupNotes.push(`${what}: ${e && e.message ? e.message : String(e)}`); };

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
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body, text: t };
  };
  return {
    post: (p, d, h) => call("POST", p, d, h),
    async csrf() { const r = await call("GET", "/api/csrf-token"); return { "x-csrf-token": r.body.csrfToken }; },
  };
}

async function spawnServer(smtpPort, dataDir, uploadsDir) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1", LOG_CONSOLE_MIRROR: "1",
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const st = { out: "", exit: null };
  child.stdout.on("data", d => { st.out += d; });
  child.stderr.on("data", d => { st.out += d; });
  child.on("exit", (code) => { st.exit = code; });
  const spawnedAt = Date.now();
  const deadline = Date.now() + 40000;
  let lastProbe = "";
  while (Date.now() < deadline && st.exit === null) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.server_started_at && new Date(cfg.server_started_at).getTime() >= spawnedAt - 2000
            && fs.existsSync(path.join(dataDir, ".superadmin-password"))) return { child, st };
      }
    } catch (e) { lastProbe = e && e.message ? e.message : String(e); }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill("SIGKILL");
  throw new Error(`server never became ready (last probe: ${lastProbe}). Log:\n${st.out.slice(-2000)}`);
}

// The entry screen's Continue for a new work address: it mails an address proof
// (the email-first sign-up's code) through the same detached, tracked send as a
// sign-in code, and answers {ok:true} without waiting for SMTP.
async function register(tag) {
  const c = client();
  const email = `${tag}-${Date.now()}@company.co`.toLowerCase();
  const r = await c.post("/api/auth/code/request", { email }, await c.csrf());
  expect(r.ok && r.body && r.body.ok, `code request ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  return email;
}

test("a sign-in mail held mid-send at SIGTERM is delivered, the drain reports it, and the process exits 0", async () => {
  test.setTimeout(120_000);
  const smtp = await startSmtpCapture();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smtppool-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smtppool-up-"));
  let child = null;
  try {
    const s = await spawnServer(smtp.port, dataDir, uploadsDir);
    child = s.child;
    // Positive control first: with the relay answering, mails sent through the
    // pool arrive.
    const a = await register("poolA");
    const b = await register("poolB");
    await expect.poll(() => smtp.messages.filter(m => m.rcptTo.some(t => t.toLowerCase() === a || t.toLowerCase() === b)).length, { timeout: 15000 }).toBe(2);

    // Now hold the relay's answer, send one more, and SIGTERM while it is parked.
    smtp.hold();
    const c = await register("poolC");
    await expect.poll(() => smtp.heldCount(), { timeout: 15000, message: "PRECONDITION: the mail is parked mid-send" }).toBe(1);
    child.kill("SIGTERM");
    // The drain must be WAITING on it: nothing has exited yet.
    await new Promise(r => setTimeout(r, 1000));
    expect(s.st.exit, "the process is still draining while the mail is unanswered").toBeNull();
    smtp.release();
    await expect.poll(() => s.st.exit, { timeout: 15000, message: `the process exits once the mail is answered. Log:\n${s.st.out.slice(-1500)}` }).not.toBeNull();
    expect(s.st.exit, s.st.out.slice(-1500)).toBe(0);
    // lib/log.js routes console output to app.jsonl (and mirrors it to stdout when
    // LOG_CONSOLE_MIRROR is on), so read both.
    const logDir = path.join(dataDir, "logs");
    const appLog = fs.existsSync(logDir)
      ? fs.readdirSync(logDir).filter(f => f.startsWith("app-")).map(f => fs.readFileSync(path.join(logDir, f), "utf8")).join("\n")
      : "";
    expect(s.st.out + "\n" + appLog, "the drain reports the mail as drained, not timed out").toMatch(/Shutdown complete \([^)]*mail drained/);
    expect(smtp.messages.some(m => m.rcptTo.some(t => t.toLowerCase() === c)), "the held mail was delivered").toBe(true);
  } finally {
    try { smtp.release(); } catch (e) { note("release")(e); }
    if (child && child.exitCode === null) { try { child.kill("SIGKILL"); } catch (e) { note("kill")(e); } }
    await smtp.close().catch(note("smtp close"));
    for (const d of [dataDir, uploadsDir]) fs.rmSync(d, { recursive: true, force: true });
    if (cleanupNotes.length) console.warn(`[smtp-pool-drain] cleanup: ${cleanupNotes.join("; ")}`);
  }
});
