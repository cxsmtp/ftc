// @ts-check
//
// v8.8.25 — ONE ORIGIN MAY NOT SPEND THE WHOLE ACCOUNT'S SEND BUDGET.
//
// v8.8.9 restated the residual honestly and left it undesigned. Its own words:
// three emailed sends per window is a GLOBAL PER-ACCOUNT budget, spendable by
// anyone who can reach the endpoint, for up to ten minutes, learning nothing
// (every answer is 200). What it explicitly REFUSED was the obvious remedy —
// re-keying the cap on `(account, IP/24)` — and the refutation still stands and
// is the whole reason this shape is different:
//
//   the cap returns BEFORE `mintCode()`, so it also bounds how often a victim's
//   LIVE code can be invalidated under them. A per-/24 budget MULTIPLIES both
//   the mail they receive and the invalidations of the code they are typing.
//
// So this is a SUB-budget, never a parallel one. The account cap stays at three
// and still bounds outbound mail exactly as before; within it, one origin may
// spend at most two. Nothing is multiplied — the ceiling is unchanged — and the
// third send is reserved for somebody who is not the first caller.
//
// THE ANTI-VACUITY PROBLEM THIS FILE IS BUILT AROUND: on the shared test server
// every request comes from 127.0.0.1, i.e. ONE origin, so "three requests spent
// only two" is equally satisfied by a build that simply lowered the account cap
// to two — which would be a REGRESSION, taking a send away from the legitimate
// participant who asks three times. Only a SECOND origin can tell the two apart,
// and a second origin needs `TRUST_PROXY`, which the shared server does not set.
// Hence the spawned server: the third arm is what makes the first mean anything.

const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH, PORT_BASE } = require("./helpers");
const Database = require("better-sqlite3");
const { spawn } = require("child_process");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const os = require("os");
const path = require("path");

// This spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = (l) => `${l}-${Date.now().toString(36)}-${Math.floor(Math.random() * 9973)}`;

function sends(userId) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT login_code_sends FROM users WHERE id=?").get(userId)?.login_code_sends; }
  finally { db.close(); }
}

test.describe("v8.8.25 — the sign-in code's per-origin sub-budget", () => {
  /** @type {any} */ let sa, csrf;
  let walkUp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;
    // The desk shortcut makes the account this is about: verified, approved and
    // PASSWORDLESS, so the emailed code is a real door rather than a decoration.
    const email = `${uniq("origin")}@acme.com`;
    const r = await sa.post("/api/admin/participants/desk-invite", {
      headers: H(csrf), data: { email, firstName: "Origin", lastName: "Budget" },
    });
    expect(r.ok(), `desk-invite: ${r.status()} ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    walkUp = { id: b.userId || b.id, email };
    expect(walkUp.id, "the shortcut returns the new account's id").toBeTruthy();
    // The shortcut showed a desk code, and a LIVE desk code is never replaced by
    // an emailed request (lib/login-code.js `deskCodeLive`): expire it, so the
    // asks below are emailed mints this file can count.
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE users SET login_code_at=? WHERE id=?").run(new Date(Date.now() - 60 * 60_000).toISOString(), walkUp.id); }
    finally { db.close(); }
  });

  // The sub-budget is PROCESS-RESIDENT (single-process invariant), so it does
  // not reset with the row. Without this every later assertion in the file
  // measures whatever the previous test spent.
  test.beforeEach(async () => {
    const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const r = await sa.post("/api/test/reset-origin-code-budget", { headers: H(c) });
    expect(r.ok(), "the sub-budget is cleared between tests").toBeTruthy();
  });

  async function ask(email) {
    const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    // A code under two minutes old is never replaced (the re-send suppression),
    // which would answer every ask after the first before either budget is
    // reached. Forget it, so each ask reaches the budgets this file is about.
    await sa.post("/api/test/reset-recent-code-sends", { headers: H(c) });
    const r = await sa.post("/api/auth/code/request", { headers: H(c), data: { email } });
    // 200 for EVERY outcome, refusal included — the anti-enumeration contract,
    // which this change does not touch. The budget is observable only in the row.
    expect(r.status(), "the handler still answers 200 whatever it decided").toBe(200);
    return r;
  }

  test("one origin asking three times sends only TWO", async () => {
    for (let i = 0; i < 3; i++) await ask(walkUp.email);
    expect(sends(walkUp.id),
      "the third ask from the same /24 buys nothing — the account's third send is reserved").toBe(2);
  });

  test("a window ROLLOVER does not hand the origin a free send", async () => {
    // THE FRESH BRANCH SPENDS TOO, and nothing else in this file reaches it:
    // the desk shortcut already minted a code, so every ask above is a REISSUE
    // and takes the `live` arm. Age the anchor and the next mint opens a new
    // window — where, without the spend, the origin's own entry has expired
    // alongside it and the first send of every window would be free. Measured:
    // three asks would land THREE sends rather than two.
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("UPDATE users SET login_code_at=? WHERE id=?")
        .run(new Date(Date.now() - 60 * 60_000).toISOString(), walkUp.id);
    } finally { db.close(); }

    for (let i = 0; i < 3; i++) await ask(walkUp.email);
    expect(sends(walkUp.id),
      "the window's FIRST send is the origin's first, not a free one").toBe(2);
  });

  test("CONTROL — the refusal is SILENT and spends nothing else", async () => {
    // A refused request must not be distinguishable from a delivered one, and
    // must not consume the account's window: `login_code_at` is the anchor, and
    // moving it would shorten the code the holder already has.
    for (let i = 0; i < 2; i++) await ask(walkUp.email);
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const before = db.prepare("SELECT login_code_at, login_code_hash FROM users WHERE id=?").get(walkUp.id);
    db.close();

    await ask(walkUp.email);          // the refused third

    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const after = db2.prepare("SELECT login_code_at, login_code_hash FROM users WHERE id=?").get(walkUp.id);
    db2.close();
    expect(after.login_code_at, "a refused ask does not re-anchor the window").toBe(before.login_code_at);
    expect(after.login_code_hash, "…and does not invalidate the code they hold").toBe(before.login_code_hash);
  });

  test("the refusal names WHICH budget, so a History line is not a false alarm", async () => {
    // Both budgets refuse identically on the wire, so the participant's own
    // History is the only place an operator can tell them apart — and reading
    // them as one would put "the send limit ... was reached" beside a counter
    // showing 2 of 3, which reads as a platform fault rather than as this
    // caller having had their share.
    for (let i = 0; i < 3; i++) await ask(walkUp.email);
    const r = await sa.get(`/api/admin/participants/${walkUp.id}/events?limit=50`);
    expect(r.ok(), `history: ${r.status()}`).toBeTruthy();
    const body = await r.json();
    const rows = Array.isArray(body) ? body : (body.events || body.rows || []);
    // The endpoint may hand back `details` as a blob or already parsed; take both.
    const refusals = rows.filter(e => e.event_type === "login_code_refused")
      .map(e => (typeof e.details === "string"
        ? (() => { try { return JSON.parse(e.details); } catch (_) { return {}; } })()
        : (e.details || {})));
    expect(refusals.length, `the refused third ask left a trace: ${JSON.stringify(rows.slice(0, 3))}`).toBeGreaterThan(0);
    const origin = refusals.find(d => d.reason === "origin_cap_reached");
    expect(origin, `a refusal names the ORIGIN budget: ${JSON.stringify(refusals)}`).toBeTruthy();
    expect(origin.sends, "…and the account still has a send left").toBeLessThan(3);
  });

  test("the DESK reveal is unaffected — it sends no mail, so it spends no origin share", async () => {
    // The v8.8.9 rule, one budget down. The reveal must stay reachable for the
    // walk-up standing at the desk, which is the whole point of it.
    for (let i = 0; i < 3; i++) await ask(walkUp.email);
    const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const r = await sa.post(`/api/admin/participants/${walkUp.id}/login-code/reveal`, { headers: H(c) });
    expect(r.status(), `the desk reveal must not be refused: ${await r.text()}`).toBe(200);
    expect((await r.json()).code, "…and hands the admin a real code").toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The arm that makes the file non-vacuous. A SECOND origin must still be able to
// spend the account's third send — otherwise this is a lowered cap, not a
// sub-budget, and the legitimate participant asking three times has lost one.
// ---------------------------------------------------------------------------
test.describe("v8.8.25 — it is a SUB-budget, not a lowered cap", () => {
  test("a DIFFERENT origin still reaches the account's third send", async () => {
    test.setTimeout(180_000);
    const port = PORT_BASE + 196;
    const B = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-budget-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: B, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        // The whole reason for a spawned server: without trust proxy every
        // caller is 127.0.0.1 and the two origins are one.
        TRUST_PROXY: "1",
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        // The limiter would answer 429 long before the budget did, and a 429 is
        // not the subject here.
        RATE_LIMIT_DISABLED: "1",
        NODE_OPTIONS: "",
        // NODE_ENV=test (never production: that forces a Secure cookie, which
        // express-session refuses over plain HTTP) for the test-only hook that
        // clears the two-minute re-send suppression between asks.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", b => { out += b.toString(); });
    child.stderr.on("data", b => { out += b.toString(); });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    class Client {
      constructor(ip) { this.ip = ip; this.cookie = ""; this.csrf = ""; }
      async go(p, opts = {}) {
        const headers = { "x-forwarded-for": this.ip, "x-forwarded-proto": "https" };
        if (opts.body) headers["content-type"] = "application/json";
        if (this.csrf) headers["x-csrf-token"] = this.csrf;
        if (this.cookie) headers["cookie"] = this.cookie;
        const r = await fetch(`${B}${p}`, {
          method: opts.method || "GET", headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
        let json = null; try { json = await r.json(); } catch (_) {}
        return { status: r.status, json };
      }
      async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
    }

    try {
      const pass = await readySpawnedServer({ base: B, child, dataDir, spawnedAt, output: () => out });

      const admin = new Client("203.0.113.9");
      await admin.refreshCsrf();
      const li = await admin.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } });
      expect(li.status, "admin signs in").toBe(200);
      await admin.refreshCsrf();

      const email = `${uniq("twoorig")}@acme.com`;
      const mk = await admin.go("/api/admin/participants/desk-invite", {
        method: "POST", body: { email, firstName: "Two", lastName: "Origins" },
      });
      expect(mk.status, `desk-invite: ${JSON.stringify(mk.json)}`).toBe(200);
      const uid = mk.json.userId || mk.json.id;
      // Expire the desk code the shortcut showed (a live one is never replaced).
      {
        const db = new Database(path.join(dataDir, "hackathon.db"));
        try { db.prepare("UPDATE users SET login_code_at=? WHERE id=?").run(new Date(Date.now() - 60 * 60_000).toISOString(), uid); }
        finally { db.close(); }
      }

      const forgetRecentSends = async () => {
        const r = await admin.go("/api/test/reset-recent-code-sends", { method: "POST", body: {} });
        expect(r.status, "the re-send suppression is cleared between asks").toBe(200);
      };
      const readSends = () => {
        const db = new Database(path.join(dataDir, "hackathon.db"), { readonly: true });
        try { return db.prepare("SELECT login_code_sends FROM users WHERE id=?").get(uid)?.login_code_sends; }
        finally { db.close(); }
      };

      // Origin A spends its two, and is then refused its third.
      const a = new Client("198.51.100.7");
      await a.refreshCsrf();
      for (let i = 0; i < 3; i++) {
        await forgetRecentSends();
        const r = await a.go("/api/auth/code/request", { method: "POST", body: { email } });
        expect(r.status, "uniform 200").toBe(200);
      }
      expect(readSends(), "origin A spent exactly its two").toBe(2);

      // …and a caller on a DIFFERENT /24 still gets the account's third. This is
      // the assertion a lowered cap fails.
      const b = new Client("192.0.2.44");
      await b.refreshCsrf();
      await forgetRecentSends();
      const rb = await b.go("/api/auth/code/request", { method: "POST", body: { email } });
      expect(rb.status, "uniform 200").toBe(200);
      expect(readSends(), "a second origin reaches the account's third send").toBe(3);

      // CONTROL — and the ACCOUNT cap still binds. Without this, "a second
      // origin gets through" is satisfied by a build that removed the cap.
      const c = new Client("192.0.2.99");
      await c.refreshCsrf();
      await forgetRecentSends();
      const rc = await c.go("/api/auth/code/request", { method: "POST", body: { email } });
      expect(rc.status, "uniform 200").toBe(200);
      expect(readSends(), "three is still the account's ceiling, whoever asks").toBe(3);
    } finally {
      child.kill("SIGKILL");
      await sleep(300);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
