// @ts-check
//
// THE POOLED RELAY HOLDS ITS BOUND (sweep gap #275; lib/email.js `pool: true`).
//
// tests/smtp-pool-drain.spec.js proves pooled mail is delivered and drained at
// shutdown. An UNPOOLED transport delivers and drains just the same, so that lock
// cannot see the pool being removed; what the pool changes is how many relay
// connections a burst of mail opens. So this counts them, through a TCP relay of
// its own in front of the capturing SMTP server:
//
//   * with SMTP_POOL_MAX_CONNECTIONS=2, six sign-up codes sent while the relay
//     withholds its answer open at most TWO connections, two messages are in
//     flight and the other four wait in the pool's queue in memory, and
//     /metrics' hack_arena_smtp_sends_pending counts all six;
//   * released, all six arrive, still over those two connections (reused, not
//     reopened), and the gauge returns to zero;
//   * a mail waiting for a connection is checked when it leaves: its recipient
//     deleted while it waited is never mailed.
// Without the pool every mail opens its own connection: six at once.
//
// NODE_ENV=test, so the boot-time SMTP probe (lib/email.js `_probeSmtp`) opens no
// connection of its own; the server is its own (a fixed SPAWNER_OFFSETS port),
// as the pool size is fixed at boot.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");

const PORT = PORT_BASE + 115;
const BASE = `http://127.0.0.1:${PORT}`;
const POOL = 2;
const MAILS = 6;

test.beforeEach(() => guardFixedPortSpec());

/** A TCP relay in front of `targetPort` that counts the connections made through it. */
async function countingRelay(targetPort) {
  const st = { opened: 0, open: 0, maxOpen: 0 };
  const sockets = new Set();
  const server = net.createServer((down) => {
    st.opened++; st.open++; st.maxOpen = Math.max(st.maxOpen, st.open);
    const up = net.connect(targetPort, "127.0.0.1");
    sockets.add(down); sockets.add(up);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; st.open--;
      down.destroy(); up.destroy();
      sockets.delete(down); sockets.delete(up);
    };
    down.on("error", close); up.on("error", close);
    down.on("close", close); up.on("close", close);
    down.pipe(up); up.pipe(down);
  });
  server.on("error", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: /** @type {import("net").AddressInfo} */ (server.address()).port,
    st,
    async close() {
      for (const s of sockets) { try { s.destroy(); } catch (_) { /* already gone */ } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

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
    const text = await r.text();
    let body = text;
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body, text };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, d, h) => call("POST", p, d, h),
    del: (p, h) => call("DELETE", p, undefined, h),
    async csrf() { const r = await call("GET", "/api/csrf-token"); return { "x-csrf-token": r.body.csrfToken }; },
  };
}

/**
 * The spawned server behind a counting relay with a pool of POOL, signed in as
 * the built-in superadmin; `fn` gets everything a test needs, and everything is
 * torn down after it.
 */
async function withPooledServer(fn) {
  const smtp = await startSmtpCapture();
  const relay = await countingRelay(smtp.port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smtppoolbound-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "smtppoolbound-up-"));
  let child = null;
  let log = "";
  let exited = null;
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
        PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: String(relay.port), SMTP_ALLOW_PLAINTEXT: "1",
        SMTP_POOL_MAX_CONNECTIONS: String(POOL), SMTP_POOL_MAX_MESSAGES: "100",
        SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", d => { log += d; });
    child.stderr.on("data", d => { log += d; });
    child.on("exit", (code) => { exited = code; });
    // POSITIVE IDENTITY: a boot stamp newer than the spawn, then its own password file.
    const spawnedAt = Date.now();
    let up = false;
    for (const deadline = Date.now() + 40_000; Date.now() < deadline && exited === null;) {
      try {
        const r = await fetch(`${BASE}/api/config`);
        if (r.ok) {
          const cfg = await r.json();
          if (cfg.server_started_at && new Date(cfg.server_started_at).getTime() >= spawnedAt - 2000
              && fs.existsSync(path.join(dataDir, ".superadmin-password"))) { up = true; break; }
        }
      } catch (_) { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(up, `the server came up. Log:\n${log.slice(-2000)}`).toBe(true);
    expect(relay.st.opened, "PRECONDITION: nothing has spoken to the relay yet (no boot probe under test)").toBe(0);

    const admin = client();
    const login = await admin.post("/api/login", { username: "superadmin", password: fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim() }, await admin.csrf());
    expect(login.ok, `superadmin login: ${login.status} ${login.text}`).toBe(true);
    // /metrics is memoised for a second, so a gauge is polled, never read once.
    const pending = async () => {
      const r = await admin.get("/metrics");
      expect(r.ok, `metrics: ${r.status}`).toBe(true);
      const m = /^hack_arena_smtp_sends_pending (\d+)$/m.exec(r.text);
      expect(m, "the gauge is published").toBeTruthy();
      return Number(m[1]);
    };
    expect(await pending(), "PRECONDITION: nothing pending").toBe(0);
    await fn({ smtp, relay, admin, pending, dataDir });
  } finally {
    try { smtp.release(); } catch (_) { /* nothing held */ }
    if (child && exited === null) {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    }
    await relay.close().catch(() => {});
    await smtp.close().catch(() => {});
    for (const d of [dataDir, uploadsDir]) fs.rmSync(d, { recursive: true, force: true });
  }
}

/** Whether a captured message went to `addr`. */
const sentTo = (smtp, addr) => smtp.messages.some(m => m.rcptTo.some(t => t.toLowerCase() === addr));

test("a burst of six mails through a pool of two opens two relay connections; the rest wait in the queue, counted", async () => {
  test.setTimeout(120_000);
  await withPooledServer(async ({ smtp, relay, pending }) => {
    // The burst: a room pressing Continue with new work addresses, each mailed an
    // address proof through the pool, while the relay withholds its answer.
    smtp.hold();
    const stamp = Date.now().toString(36);
    const addresses = Array.from({ length: MAILS }, (_, i) => `pool-${stamp}-${i}@company.co`);
    for (const email of addresses) {
      const c = client();
      const r = await c.post("/api/auth/code/request", { email }, await c.csrf());
      expect(r.ok && r.body && r.body.ok, `code request ${email}: ${r.status} ${r.text}`).toBe(true);
    }
    await expect.poll(() => smtp.heldCount(), { timeout: 15_000, message: "the pool's two connections each carry one mail, parked" }).toBe(POOL);
    await expect.poll(pending, { timeout: 15_000, message: "all six are pending: two in flight, four queued in memory" }).toBe(MAILS);
    expect(relay.st.maxOpen, `${MAILS} mails held open at most ${POOL} relay connections`).toBeLessThanOrEqual(POOL);
    expect(relay.st.opened, "and opened no more than that").toBeLessThanOrEqual(POOL);
    expect(smtp.heldCount(), "the queue waits in the server, not at the relay").toBe(POOL);

    smtp.release();
    await expect.poll(() => addresses.filter(a => sentTo(smtp, a)).length,
      { timeout: 20_000, message: "released, every mail arrives" }).toBe(MAILS);
    await expect.poll(pending, { timeout: 15_000, message: "and nothing is left pending" }).toBe(0);
    expect(relay.st.opened, `all ${MAILS} went over the pool's connections, reused rather than reopened`).toBeLessThanOrEqual(POOL);
    expect(relay.st.maxOpen).toBeLessThanOrEqual(POOL);
    expect(relay.st.opened, "anti-vacuity: the relay saw the pool's connections").toBeGreaterThan(0);
  });
});

// A mail waiting behind the backlog is checked when it LEAVES. Two address
// proofs occupy both connections; sign-in codes for two existing accounts, C and
// D, wait behind them; C's account is deleted meanwhile. Released: D's code
// arrives (the control), C's never leaves, and the suppression is recorded
// against C's id. Checked at the queue, C's mail would have gone to the
// address its deletion erased.
test("a mail queued behind the pool is checked when it leaves: its recipient deleted meanwhile is never mailed", async () => {
  test.setTimeout(120_000);
  await withPooledServer(async ({ smtp, admin, pending, dataDir }) => {
    const stamp = Date.now().toString(36);
    const account = async (tag) => {
      const email = `pool-${tag}-${stamp}@company.co`;
      const r = await admin.post("/api/admin/participants/desk-invite", { email, firstName: "Pool", lastName: tag.toUpperCase() }, await admin.csrf());
      expect(r.ok, `desk-invite ${tag}: ${r.status} ${r.text}`).toBe(true);
      return { id: r.body.userId || r.body.id, email };
    };
    const C = await account("c"), D = await account("d");
    expect(C.id && D.id, "PRECONDITION: both accounts exist").toBeTruthy();
    // The shortcut showed each a desk code, and a live desk code is never replaced
    // by an emailed one: expire them, so the requests below mint emailed codes.
    {
      const db = new Database(path.join(dataDir, "hackathon.db"));
      try {
        db.prepare("UPDATE users SET login_code_at=? WHERE id IN (?, ?)")
          .run(new Date(Date.now() - 60 * 60_000).toISOString(), C.id, D.id);
      } finally { db.close(); }
    }
    smtp.hold();
    for (const email of [`pool-a-${stamp}@company.co`, `pool-b-${stamp}@company.co`, C.email, D.email]) {
      const c = client();
      const r = await c.post("/api/auth/code/request", { email }, await c.csrf());
      expect(r.ok && r.body && r.body.ok, `code request ${email}: ${r.status} ${r.text}`).toBe(true);
    }
    await expect.poll(() => smtp.heldCount(), { timeout: 15_000, message: "the two proofs hold both connections" }).toBe(POOL);
    await expect.poll(pending, { timeout: 15_000, message: "C's and D's codes wait behind them" }).toBe(4);

    const gone = await admin.del(`/api/admin/participants/${C.id}`, await admin.csrf());
    expect(gone.ok, `delete C: ${gone.status} ${gone.text}`).toBe(true);

    smtp.release();
    await expect.poll(() => sentTo(smtp, D.email), { timeout: 20_000, message: "CONTROL: D's queued code is delivered" }).toBe(true);
    await expect.poll(pending, { timeout: 15_000, message: "nothing is left pending" }).toBe(0);
    expect(sentTo(smtp, C.email), "nothing reached the deleted account's address").toBe(false);
    const db = new Database(path.join(dataDir, "hackathon.db"), { readonly: true });
    try {
      const rows = db.prepare("SELECT details FROM orphan_events WHERE event_type='email_suppressed'").all()
        .map(r => JSON.parse(r.details));
      const mine = rows.filter(d => d.user_id === C.id);
      expect(mine.length, `the suppression names C: ${JSON.stringify(rows)}`).toBe(1);
      expect(mine[0].skipped).toBe("recipient_deleted");
    } finally { db.close(); }
  });
});

// The SMTP diagnostic (POST /api/admin/test-email) skips the recipient checks and
// the email_sent record, but takes a relay connection like every send: with both
// connections held it waits in the server's queue, counted as pending, and is not
// queued inside the pool. Released, it reaches the relay and answers 200.
test("the SMTP diagnostic waits for a relay connection like every send, counted as pending", async () => {
  test.setTimeout(120_000);
  await withPooledServer(async ({ smtp, admin, pending }) => {
    const stamp = Date.now().toString(36);
    smtp.hold();
    for (const email of [`pool-x-${stamp}@company.co`, `pool-y-${stamp}@company.co`]) {
      const c = client();
      const r = await c.post("/api/auth/code/request", { email }, await c.csrf());
      expect(r.ok && r.body && r.body.ok, `code request ${email}: ${r.status} ${r.text}`).toBe(true);
    }
    await expect.poll(() => smtp.heldCount(), { timeout: 15_000, message: "the two proofs hold both connections" }).toBe(POOL);
    const probe = `pool-diag-${stamp}@company.co`;
    const diag = admin.post("/api/admin/test-email", { to: probe }, await admin.csrf());
    await expect.poll(pending, { timeout: 15_000, message: "the diagnostic waits in the server's queue, counted" }).toBe(POOL + 1);
    expect(smtp.heldCount(), "and has not reached the relay").toBe(POOL);
    expect(sentTo(smtp, probe), "nor been delivered").toBe(false);
    smtp.release();
    const r = await diag;
    expect(r.ok, `test-email: ${r.status} ${r.text}`).toBe(true);
    await expect.poll(() => sentTo(smtp, probe), { timeout: 20_000, message: "released, the diagnostic arrives" }).toBe(true);
    await expect.poll(pending, { timeout: 15_000, message: "nothing is left pending" }).toBe(0);
  });
});
