// v7.29.0 — emailed sign-in codes, built and provably OFF.
//
// Three layers, because the feature ships dark and a lock that cannot fail is
// not a lock:
//   1. the ENABLED path, on a server this spec spawns itself. The shared test
//      server deliberately stays OFF — pinning the flag on in tests/server-env.js
//      would run ~1,800 tests for six phases against a configuration production
//      does not have, which is precisely the RATE_LIMIT_DISABLED failure the
//      v7.15.34 lock exists to prevent, in the file written to prevent it.
//   2. the DISABLED branch, on the shared server. Because off is the default, the
//      shipped branch is what the whole suite exercises continuously.
//   3. a config scan: no file we ship turns it on.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost } = require("./helpers");
const fs = require("fs");
const path = require("path");
const { freshCtx, PORT_BASE, TEST_DB_PATH, BASE } = require("./helpers");
const { readySpawnedServer } = require("./spawned-server");

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

// ── Layer 2: the SHIPPED branch, on the shared server ────────────────────────
//
// v8.1.0 (PR 33) — these used to assert the DISABLED branch, because
// LOGIN_CODES_ENABLED shipped off for six phases. The flag is gone, so the same
// fixtures now exercise the branch production actually runs — and they run it on
// the SHARED server, i.e. continuously, which the spawned-server layer below
// could only do once.
// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.1.0 — sign-in codes, on the shipped path", () => {
  test("request answers 200 {ok:true} and MINTS a code for an eligible account", async () => {
    const Database = require("better-sqlite3");
    const stamp = Date.now();
    const email = `codeoff-${stamp}@company.co`;
    const { api, csrf } = await freshCtx();
    const reg = await registerPost(api, "/api/register", {
      headers: h(csrf),
      data: {
        firstName: "Code", lastName: "Off", nickname: `codeoff_${stamp}`,
        company: "C", title: "T", country: "US", timezone: "America/New_York",
        email, password: "chosen-at-signup-1",
      },
    });
    expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    const db = new Database(TEST_DB_PATH);
    // v8.1.4 — `approved` joined the eligibility predicate, because redeem has
    // always refused an unapproved account: without it the platform emailed
    // codes that could never be redeemed and counted them "sent". A plain
    // self-registration is unapproved, so this fixture — whose subject is an
    // ELIGIBLE account — has to say so. (The admin route refuses to approve an
    // unverified account, and verification is not what this test is about.)
    try {
      db.prepare("UPDATE users SET password_set_at=NULL, approved=1 WHERE email=?").run(email);
    } finally { db.close(); }

    const r = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
    expect(r.status(), "never a 4xx — a non-429 4xx feeds the scanner counter that blocks a whole venue NAT").toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    const db2 = new Database(TEST_DB_PATH);
    try {
      const row = db2.prepare("SELECT login_code_hash, login_code_at, login_code_sends FROM users WHERE email=?").get(email);
      // HASH-ONLY AT REST — the plaintext is never stored, which is what forces
      // mint-fresh-each-time (forgot-password can re-send its live code because it
      // stores the plaintext; this cannot, by construction).
      expect(row.login_code_hash, "an eligible account gets a code").toBeTruthy();
      expect(row.login_code_hash, "stored as a sha256, never the code itself").toMatch(/^[0-9a-f]{64}$/);
      expect(row.login_code_at, "the send window is anchored").toBeTruthy();
      expect(row.login_code_sends, "and the send is counted against the cap").toBe(1);
    } finally { db2.close(); }
    await api.dispose();
  });

  // The flag must not itself be an oracle: OFF has to look exactly like
  // "this address has no passwordless account".
  test("the disabled answer is byte-identical to the ineligible one", async () => {
    const { api, csrf } = await freshCtx();
    const a = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email: "nobody-at-all@nowhere.invalid" } });
    const b = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email: "alice@acme.com" } });
    expect(a.status()).toBe(b.status());
    expect(await a.text()).toBe(await b.text());
    await api.dispose();
  });

  test("redeem answers 200 {ok:false}, never a 4xx", async () => {
    const { api, csrf } = await freshCtx();
    const r = await api.post("/api/auth/code/redeem", { headers: h(csrf), data: { email: "alice@acme.com", code: "ABCD-EFGH" } });
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ ok: false });
    await api.dispose();
  });

  test("/metrics reports the flag state without shell access", async () => {
    const { apiLogin } = require("./helpers");
    const { api } = await apiLogin("superadmin");
    const body = await (await api.get("/metrics")).text();
    // v8.1.0 (PR 33) — the gauge went with the flag: it could only ever report 1,
    // and a constant is not a signal. The outcome COUNTERS remain, and they are
    // the only monitoring these 200-always endpoints have.
    expect(body, "the gauge is gone with the flag").not.toMatch(/hack_arena_login_code_enabled/);
    await api.dispose();
  });
});

// ── The code object, as a unit ───────────────────────────────────────────────
test.describe("v7.29.0 — the code itself", () => {
  test("8 Crockford characters, and a human can mistype it within reason", () => {
    // Required INSIDE the test: lib/login-code can reach db.js, and a module-scope
    // bind would predate the per-file recycle (v7.20.2).
    const { normaliseCode, formatCode, mintCode, ALPHABET, CODE_LEN } = require("../lib/login-code");
    const c = mintCode();
    expect(c).toHaveLength(CODE_LEN);
    for (const ch of c) expect(ALPHABET).toContain(ch);
    // Crockford excludes I L O U precisely so these are unambiguous on paper.
    for (const ch of "ILOU") expect(ALPHABET).not.toContain(ch);
    expect(normaliseCode(formatCode(c))).toBe(c);
    expect(normaliseCode(formatCode(c).toLowerCase())).toBe(c);
    expect(normaliseCode(` ${formatCode(c)} `)).toBe(c);
    // Confusables decode rather than failing the holder.
    expect(normaliseCode("OI234567")).toBe("01234567");
    // Anything not a well-formed code is refused with no query at all.
    expect(normaliseCode("ABC")).toBe("");
    expect(normaliseCode("")).toBe("");
  });

  test("entropy is ~40 bits, not ~20 — the reason the length is a one-way door", () => {
    const { ALPHABET, CODE_LEN } = require("../lib/login-code");
    // 8 characters over a 32-symbol alphabet. At 6 digits the same budget
    // (~60 guesses across a 6-hour event) is ~1.8% across a 300-person cohort.
    expect(Math.log2(Math.pow(ALPHABET.length, CODE_LEN))).toBeGreaterThanOrEqual(40);
  });
});

// ── Layer 3: the flag is GONE, and stays gone ────────────────────────────────
//
// v8.1.0 (PR 33) — this used to assert that nothing we ship turned the flag ON.
// The flag is deleted, so the guard inverts: the NAME must not come back. A
// re-introduced `LOGIN_CODES_ENABLED` would be a switch nothing reads — dead
// config that reads as a control, which is worse than no control at all.
test("v8.1.0: LOGIN_CODES_ENABLED is gone from the shipped tree", () => {
  const root = path.join(__dirname, "..");
  const dirs = ["lib", "routes", "public/js", "docs"];
  const files = ["server.js", "db.js", "docker-compose.yml", "Dockerfile",
                 "perf/env.perf.example", "ci/Dockerfile.cross-browser",
                 "tests/server-env.js", "swagger.yaml", "README.md"];
  const walk = (d) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walk(fp));
      else if (/\.(js|yaml|yml|md)$/.test(e.name)) out.push(fp);
    }
    return out;
  };
  const targets = [
    ...dirs.flatMap(d => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : [])),
    ...files.map(f => path.join(root, f)).filter(f => fs.existsSync(f)),
  ];
  // COMMENTS ARE STRIPPED FIRST, and this is the v7.21.13 lesson arriving on
  // schedule: the comment explaining why the pin was removed NAMES the pin, so an
  // unstripped scan flags the very file that documents the fix. Line count is
  // preserved so an offender's position stays meaningful.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*#[^\n]*$/gm, (m) => m.replace(/[^\n]/g, " "));   // YAML + Dockerfile comments
  const offenders = targets
    .filter(f => strip(fs.readFileSync(f, "utf8")).includes("LOGIN_CODES_ENABLED"))
    .map(f => path.relative(root, f));
  expect(offenders,
    "the flag and its only reason to exist died in the same diff — re-adding the name means a control nothing honours")
    .toEqual([]);
});

// ── Layer 1: the full round trip, against a REAL capturing SMTP server ───────
//
// v8.1.0 (PR 33) — no longer needs its own server to switch a flag on; it keeps
// one because it is the only test that reads the code out of a real DELIVERED
// email, which the shared server (pointed at a dead SMTP port) cannot do.
test.describe("v8.1.0 — sign-in codes end to end", () => {
  test.setTimeout(120_000);

  test("request → email carries a usable code; redeem signs the holder in", async () => {
    const { spawn } = require("child_process");
    const os = require("os");
    const Database = require("better-sqlite3");
    const port = PORT_BASE + 140; // registry: see CLAUDE.md's spawned-port list
    const BASE = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logincode-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        LOG_DISABLE_ACCESS: "1",
        RATE_LIMIT_DISABLED: "1",
        // A code lifetime of 7 minutes, not the 10-minute default: GET /api/config
        // must report the operator's value (the sign-in card reads it there).
        LOGIN_CODE_TTL_MS: "420000",
        NODE_ENV: "test",
        NODE_OPTIONS: "", // v7.15.30 — never inherit the runner's flags
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", b => { out += b.toString(); });
    child.stderr.on("data", b => { out += b.toString(); });
    try {
      await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => out });

      let cookie = "";
      const go = async (p, opts = {}) => {
        const headers = {};
        if (cookie) headers.cookie = cookie;
        if (opts.body) headers["content-type"] = "application/json";
        if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
        const r = await fetch(`${BASE}${p}`, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
        return { status: r.status, json: await r.json().catch(() => null) };
      };

      // The sign-in card learns the code's lifetime from the server, never a copy
      // of the default: this server's own value is what it is told.
      expect((await go("/api/config")).json.login_code_ttl_ms, "GET /api/config reports the configured code lifetime").toBe(420000);
      // …and so does the SPA shell, which a throttled /api/config cannot hide.
      const shell = await (await fetch(`${BASE}/`)).text();
      expect(shell, "the SPA shell carries the configured code lifetime").toContain('data-login-code-ttl="420000"');

      const stamp = Date.now();
      const email = `codeon-${stamp}@company.co`;
      let tok = (await go("/api/csrf-token")).json.csrfToken;
      // Email first: prove the address (the code request answers an address with
      // no account with an address proof), then submit the form.
      await go("/api/auth/code/request", { method: "POST", csrf: tok, body: { email } });
      const proof = (await go("/api/test/last-login-code?email=" + encodeURIComponent(email))).json;
      await go("/api/auth/code/redeem", { method: "POST", csrf: tok, body: { email, code: proof && proof.code } });
      tok = (await go("/api/csrf-token")).json.csrfToken;
      const reg = await go("/api/register", {
        method: "POST", csrf: tok,
        body: {
          firstName: "Code", lastName: "On", nickname: `codeon_${stamp}`,
          company: "C", title: "T", country: "US", timezone: "America/New_York",
          email, password: "chosen-at-signup-1",
        },
      });
      expect(reg.status, `register: ${JSON.stringify(reg.json)}`).toBeLessThan(400);
      // The registration signed the new account in (a new session): a fresh token.
      cookie = "";
      tok = (await go("/api/csrf-token")).json.csrfToken;

      const dbFile = path.join(dataDir, "hackathon.db");
      const db = new Database(dbFile);
      try {
        // The passwordless, approved, verified shape a Booth walk-up will have.
        db.prepare("UPDATE users SET password_set_at=NULL, approved=1, verified=1 WHERE email=?").run(email);

        const req1 = await go("/api/auth/code/request", { method: "POST", csrf: tok, body: { email } });
        expect(req1.status).toBe(200);
        expect(req1.json).toEqual({ ok: true });

        const row = db.prepare("SELECT login_code_hash, login_code_at, login_code_sends FROM users WHERE email=?").get(email);
        expect(row.login_code_hash, "a code IS minted when the flag is on").toBeTruthy();
        expect(row.login_code_sends).toBe(1);

        // The plaintext is unrecoverable by design (hash-only at rest), so drive
        // the redeem against a code we plant ourselves through the same helper
        // the server uses — which is exactly the property under test: the server
        // accepts a code it can only verify, never one it can re-read.
        const { hashCode, mintCode, formatCode } = require("../lib/login-code");
        const known = mintCode();
        db.prepare("UPDATE users SET login_code_hash=? WHERE email=?").run(hashCode(known), email);

        // A WRONG code is 200 {ok:false} — never a 4xx.
        const bad = await go("/api/auth/code/redeem", { method: "POST", csrf: tok, body: { email, code: formatCode(mintCode()) } });
        expect(bad.status, "a wrong code must not feed the scanner counter").toBe(200);
        expect(bad.json).toEqual({ ok: false });

        // The right one, in its human display form, signs the holder in.
        const good = await go("/api/auth/code/redeem", { method: "POST", csrf: tok, body: { email, code: formatCode(known) } });
        expect(good.status).toBe(200);
        expect(good.json).toMatchObject({ ok: true });

        const me = (await go("/api/me")).json;
        expect(me.email, "the session really is the code holder's").toBe(email);

        // Single-use: the same code cannot be replayed.
        tok = (await go("/api/csrf-token")).json.csrfToken;
        const replay = await go("/api/auth/code/redeem", { method: "POST", csrf: tok, body: { email, code: formatCode(known) } });
        expect(replay.json).toEqual({ ok: false });
        expect(db.prepare("SELECT login_code_hash FROM users WHERE email=?").get(email).login_code_hash,
          "redeeming clears the code").toBeNull();

        // ── The desk fallback, where it can actually run ──────────────────────
        // Sign in as the superadmin on THIS server and mint a code onto the
        // admin's own screen — the path that exists because an emailed round trip
        // is the only way in and corporate gateways greylist first contact.
        cookie = "";
        const pass = fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
        let atok = (await go("/api/csrf-token")).json.csrfToken;
        expect((await go("/api/login", { method: "POST", csrf: atok, body: { email: "superadmin", password: pass } })).status).toBe(200);
        // The login REGENERATES the session, so the token minted above is bound to
        // a session that no longer exists — re-fetch, exactly as the SPA does.
        atok = (await go("/api/csrf-token")).json.csrfToken;
        const signedId = db.prepare("SELECT id FROM users WHERE email=?").get(email).id;
        // This account has signed in, so the desk shows it no code: after a first
        // sign-in the desk can only email one (operator ruling, 14 Nov 2026).
        const revSigned = await go(`/api/admin/participants/${signedId}/login-code/reveal`, { method: "POST", csrf: atok, body: {} });
        expect(revSigned.status, `reveal for a signed-in account: ${JSON.stringify(revSigned.json)}`).toBe(409);
        expect(revSigned.json.code).toBe("signed_in_before");

        // A walk-up added at the desk has never signed in: the desk shows a code.
        const deskEmail = `codeon-desk-${stamp}@company.co`;
        const inv = await go("/api/admin/participants/desk-invite", { method: "POST", csrf: atok, body: { email: deskEmail } });
        expect(inv.status, `desk-invite: ${JSON.stringify(inv.json)}`).toBe(200);
        const uid = inv.json.id;
        const rev = await go(`/api/admin/participants/${uid}/login-code/reveal`, { method: "POST", csrf: atok, body: {} });
        expect(rev.status, `reveal: ${JSON.stringify(rev.json)}`).toBe(200);
        expect(rev.json.code, "the code is returned to the ADMIN, deliberately").toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        expect(rev.json.expires_in_minutes, "the configured lifetime, not the default's").toBe(7);
        // Audited against the PARTICIPANT, so it shows in their History: the
        // desk sign-up's own reveal, and this one.
        const ev = db.prepare("SELECT event_type, changed_by FROM user_events WHERE user_id=? AND event_type='login_code_revealed'").all(uid);
        expect(ev.length, "both reveals are on the record").toBe(2);
        expect(ev[1].changed_by, "attributed to the admin who did it").toBe("superadmin");

        // …and the revealed code really works.
        cookie = "";
        const ptok = (await go("/api/csrf-token")).json.csrfToken;
        const used = await go("/api/auth/code/redeem", { method: "POST", csrf: ptok, body: { email: deskEmail, code: rev.json.code } });
        expect(used.json, "a desk-revealed code is a real credential").toMatchObject({ ok: true });

        // An UNAPPROVED account is refused with a reason, not silently (a desk
        // code cannot approve).
        db.prepare("UPDATE users SET approved=0 WHERE id=?").run(uid);
        cookie = "";
        atok = (await go("/api/csrf-token")).json.csrfToken;
        expect((await go("/api/login", { method: "POST", csrf: atok, body: { email: "superadmin", password: pass } })).status).toBe(200);
        atok = (await go("/api/csrf-token")).json.csrfToken;
        const rev2 = await go(`/api/admin/participants/${uid}/login-code/reveal`, { method: "POST", csrf: atok, body: {} });
        expect(rev2.status).toBe(409);
        expect(rev2.json.code).toBe("not_approved");
      } finally { db.close(); }

      const metrics = await fetch(`${BASE}/api/config`); // sanity: server still healthy
      expect(metrics.status).toBeLessThan(500);
    } finally {
      child.kill("SIGKILL");
      // kill() returns before the kernel releases the socket; a later spawn on
      // this port would die of EADDRINUSE and its readiness probe would be
      // answered by whatever still holds it (v7.21.10).
      for (let i = 0; i < 60; i++) {
        try { await fetch(`${BASE}/api/config`); } catch (_) { break; }
        await new Promise(r => setTimeout(r, 100));
      }
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

// ── PR5: the desk fallback ───────────────────────────────────────────────────
test.describe("v7.29.0 — the admin desk fallback", () => {
  const { apiLogin } = require("./helpers");

  // With the flag OFF the route must SAY SO rather than answering 200 like the
  // public endpoints. Those are 200-always for anti-enumeration; this one is
  // admin-gated with no enumeration surface, and an admin hitting a route that
  // silently succeeds while producing nothing is v7.14.2 at API level.
  test("reveal names the disabled state instead of succeeding silently", async () => {
    const Database = require("better-sqlite3");
    const stamp = Date.now();
    const email = `reveal-${stamp}@company.co`;
    const { api, csrf } = await freshCtx();
    const reg = await registerPost(api, "/api/register", {
      headers: h(csrf),
      data: {
        firstName: "Rev", lastName: "Eal", nickname: `reveal_${stamp}`,
        company: "C", title: "T", country: "US", timezone: "America/New_York",
        email, password: "chosen-at-signup-1",
      },
    });
    expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    await api.dispose();
    const db = new Database(TEST_DB_PATH);
    let uid;
    try {
      uid = db.prepare("SELECT id FROM users WHERE email=?").get(email).id;
      db.prepare("UPDATE users SET password_set_at=NULL, approved=1, verified=1 WHERE id=?").run(uid);
    } finally { db.close(); }

    const { api: admin, csrf: aCsrf } = await apiLogin("superadmin");
    const r = await admin.post(`/api/admin/participants/${uid}/login-code/reveal`, { headers: h(aCsrf), data: {} });
    // v8.1.0 (PR 33) — with the flag gone this is the desk fallback working: the
    // admin reads a code off their own screen when the mail is greylisted, which
    // is the whole reason the route exists. It is an explicit carve-out from "no
    // production response ever contains a credential", and the code is returned
    // ONCE, to an admin-gated caller, for a participant-role target.
    expect(r.status(), `reveal: ${await r.text()}`).toBe(200);
    const revealed = await r.json();
    // Grouped `XXXX-XXXX`, because the admin READS IT ALOUD across a desk and
    // eight characters in a row are miscopied. Crockford, so no I/L/O/U.
    expect(revealed.code, "the admin is given the code to read out").toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(JSON.stringify(revealed), "and never the stored hash").not.toMatch(/[0-9a-f]{64}/);
    await admin.dispose();
  });

});

// ── PR5: the SMTP-degraded banner ────────────────────────────────────────────
test.describe("v7.29.0 — the SMTP banner", () => {
  const { apiLogin } = require("./helpers");

  test("the alerts poll carries smtp_healthy, so the probe finally has a human consumer", async () => {
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get("/api/admin/alerts")).json();
    // The shared test server points at a dead SMTP port, so the probe is either
    // "not yet run" (null) or "failed" (false) — never true. Asserting the KEY is
    // present is the contract; asserting a value would pin the fixture's mail
    // setup rather than the wire.
    expect(Object.prototype.hasOwnProperty.call(d, "smtp_healthy"),
      "smtpHealthy() was a Prometheus gauge with no operator surface — this is the surface").toBe(true);
    expect([true, false, null]).toContain(d.smtp_healthy);
    await api.dispose();
  });

  test("a null probe must NOT render as a failure", async ({ page }) => {
    // The distinction that matters: `null` means the five-minute probe has not run
    // yet, which is the state of every freshly booted server. Rendering that as
    // "email delivery is failing" would put a false alarm on every admin's screen
    // for the first five minutes of every deploy.
    await page.goto(BASE);
    // boot() restores the module namespace on window at DOM-ready, so wait for it
    // rather than racing the SPA's own startup.
    await page.waitForFunction(() => typeof window._renderSmtpBanner === "function");
    const shown = await page.evaluate(() => {
      // The REAL element from index.html, not a fabricated one: getElementById
      // returns the first match, so appending a second #smtp-banner would leave
      // the function operating on the static element while the test read its own
      // orphan — which is exactly how the first draft of this test passed
      // vacuously in one direction and failed in the other.
      const el = document.getElementById("smtp-banner");
      if (!el) return { mounted: false };
      window._renderSmtpBanner(null);
      const a = !el.hidden;
      window._renderSmtpBanner(true);
      const b = !el.hidden;
      window._renderSmtpBanner(false);
      const c = !el.hidden;
      const text = el.textContent || "";
      window._renderSmtpBanner(true); // leave the shell as we found it
      return { mounted: true, onNull: a, onTrue: b, onFalse: c, text };
    });
    expect(shown.mounted, "the banner is mounted statically, so no pane loader can destroy it").toBe(true);
    expect(shown.onNull, "not probed yet is not a failure").toBe(false);
    expect(shown.onTrue, "healthy shows nothing").toBe(false);
    expect(shown.onFalse, "an explicit failure is the only thing that renders").toBe(true);
    expect(shown.text, "and it names the desk fallback, which is the whole point").toMatch(/sign-in code/i);
  });
});

// ── PR5: the per-event delivery panel ────────────────────────────────────────
test.describe("v7.29.0 — the delivery panel", () => {
  const { apiLogin } = require("./helpers");

  test("counts enrolled, verified and email-failed for the enrolled cohort only", async () => {
    const Database = require("better-sqlite3");
    const { api: admin, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();

    // Own fixture: a competition with two enrolled participants, one of them
    // unverified, plus a THIRD participant who is NOT enrolled and who has a
    // failed send — the decoy that separates a cohort-scoped count from a
    // platform-wide one. Without it, dropping the competition_users join
    // produces the same numbers and the test proves nothing.
    const mk = async (tag, verified) => {
      const email = `dlv-${tag}-${stamp}@company.co`;
      const { api, csrf: c } = await freshCtx();
      const r = await registerPost(api, "/api/register", {
        headers: h(c),
        data: {
          firstName: "D", lastName: tag, nickname: `dlv_${tag}_${stamp}`,
          company: "C", title: "T", country: "US", timezone: "America/New_York",
          email, password: "chosen-at-signup-1",
        },
      });
      expect(r.ok(), `register ${tag}: ${r.status()} ${await r.text()}`).toBeTruthy();
      await api.dispose();
      const db = new Database(TEST_DB_PATH);
      try {
        const id = db.prepare("SELECT id FROM users WHERE email=?").get(email).id;
        db.prepare("UPDATE users SET verified=?, approved=1 WHERE id=?").run(verified, id);
        return id;
      } finally { db.close(); }
    };
    const inA = await mk("ina", 1);
    const inB = await mk("inb", 0);   // enrolled but unverified — the gap that matters
    const out = await mk("out", 1);   // NOT enrolled — the decoy

    const cr = await admin.post("/api/admin/competitions", {
      headers: h(csrf),
      data: { name: `Delivery ${stamp}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60, timezone: "UTC" },
    });
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const asg = await admin.post("/api/admin/competitions/assign", {
      headers: h(csrf), data: { competitionIds: [compId], userIds: [inA, inB] },
    });
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();

    // One failed send for an ENROLLED participant, one for the decoy.
    const db = new Database(TEST_DB_PATH);
    try {
      const ins = db.prepare("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)");
      const det = JSON.stringify({ to: "x@y.z", subject: "s", reason: "verification", success: false });
      ins.run(`ev-in-${stamp}`, inA, "email_sent", "system", new Date().toISOString(), det);
      ins.run(`ev-in2-${stamp}`, inA, "email_sent", "system", new Date().toISOString(), det); // same person twice
      ins.run(`ev-out-${stamp}`, out, "email_sent", "system", new Date().toISOString(), det);
    } finally { db.close(); }

    const d = await (await admin.get(`/api/admin/competitions/${compId}/delivery`)).json();
    expect(d.enrolled, "the cohort in the room").toBe(2);
    expect(d.verified, "one of them has never proved an address works").toBe(1);
    // BOTH enrolled participants legitimately have a failed send: registration
    // itself mails a verification link, and the shared test server points at a
    // dead SMTP port. inA additionally has the two planted rows, so it also
    // proves the count is per PERSON — three bounces to one attendee is still one
    // person to go and help. And the decoy is excluded: without the
    // competition_users join this would be every participant on the platform with
    // a failed send, which in a shared database is far more than 2.
    expect(d.email_failed, "per PERSON, and scoped to the cohort — the unenrolled decoy is not ours").toBe(2);
    await admin.dispose();
  });
});

// ── v8.1.0 (PR 33): the client branches on the PAYLOAD, never on the status ──
//
// THE SINGLE RISKIEST LINE IN THE RELEASE. Both endpoints answer 200 for every
// outcome, including every failure, because the scanner-reputation counter counts
// every non-429 4xx per IP and blocks the WHOLE address for fifteen minutes at
// 100 in ten — so at a venue behind one NAT, 300 attendees each mistyping once
// would lock the room out of the API exactly when the event starts.
//
// A future refactor "fixing" the missing status code reopens that cascade
// silently. A comment cannot stop it; a failing test can.
test.describe("v8.1.0 — the sign-in code affordance", () => {
  test("a WRONG code is reported as wrong, and the page does NOT treat 200 as success", async ({ page }) => {
    await page.goto(BASE);
    await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });

    // The login card's one button requests a code and opens the code step.
    await page.locator("#login-email").fill("nobody-at-all@nowhere.invalid");
    await page.locator("#login-submit").click();
    // The request answer is UNIFORM — it must not reveal whether the address
    // exists — so the code step is reached regardless and the copy promises
    // nothing: the operator's wording (14 Nov 2026) says a code is on its way IF
    // the address can sign in or sign up, and names personal addresses.
    await expect(page.locator("#sc-code")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#signin-code-overlay")).toContainText("nobody-at-all@nowhere.invalid");
    await expect(page.locator("#signin-code-overlay")).toContainText("If this address can sign in or sign up, a code is on its way.");
    await expect(page.locator("#signin-code-overlay")).toContainText("Personal addresses (Gmail, Outlook…) can't open an account without an invitation.");
    await expect(page.locator("#signin-code-overlay"), "the step never claims a code was sent").not.toContainText(/emailed a code/i);

    // Redeem a code that cannot possibly be valid. The SERVER answers 200.
    let redeemStatus = null;
    page.on("response", (r) => { if (r.url().includes("/api/auth/code/redeem")) redeemStatus = r.status(); });
    await page.locator("#sc-code").fill("ZZZZ-ZZZZ");
    await page.locator("[data-action='signin-code-redeem']").click();

    // THE TWO HALVES, AND BOTH ARE LOAD-BEARING.
    // 1. The server really did answer 200 — if this ever becomes a 4xx the
    //    cascade is back and the client fix below is beside the point.
    await expect.poll(() => redeemStatus, { timeout: 10000, message: "the redeem response arrives" }).not.toBeNull();
    expect(redeemStatus, "a rejected code must NOT be a 4xx — it would feed the scanner counter").toBe(200);
    // 2. ...and the client still told the user it failed, which is only possible
    //    by branching on the payload.
    await expect(page.locator("#sc-error"), "the client branched on d.ok, not r.ok")
      .toContainText(/not accepted/i, { timeout: 10000 });

    // And it did NOT sign anyone in.
    await expect(page.locator("#login-page.active"), "still on the login page").toBeVisible();
  });

  test("asking for a code with no email says so, and sends nothing", async ({ page }) => {
    // The one refusal that IS the client's own: without an address there is
    // nothing to send to, and a silent no-op would read as a broken link.
    await page.goto(BASE);
    await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
    let requested = 0;
    page.on("request", (r) => { if (r.url().includes("/api/auth/code/request")) requested++; });
    await page.locator("#login-email").fill("");
    // Email first: the card's one button is the only way to a code, and it asks
    // for the address on the card itself.
    await page.locator("#login-submit").click();
    await expect(page.locator("#login-error")).toContainText(/enter your email/i, { timeout: 10000 });
    expect(requested, "nothing is sent without an address").toBe(0);
    await expect(page.locator("#sc-code"), "and it does not advance to the code step").toHaveCount(0);
  });

  test("the code step says when a code is on its way and names personal addresses — an INVITED one is sent its proof, an uninvited one nothing (CONTROL)", async ({ page, browser }) => {
    // The operator's wording (14 Nov 2026), the same for every address because
    // the answer is: "If this address can sign in or sign up, a code is on its
    // way. Personal addresses (Gmail, Outlook…) can't open an account without an
    // invitation." A NEW free-mail address gets nothing on its own; one an
    // invitation riding the page names gets its address proof (routes/auth.js
    // `_sendEmailProof`), which the wording's "without an invitation" covers.
    const { apiLogin } = require("./helpers");
    const Database = require("better-sqlite3");
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e5)}`;
    const invited = `inv-copy-${stamp}@gmail.com`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const inv = await sa.post("/api/admin/invitations", { headers: h(saCsrf), data: { emails: [invited], competitionIds: [] } });
      expect(inv.ok(), `invite: ${inv.status()} ${await inv.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const invId = (() => { try { return db.prepare("SELECT id FROM invitations WHERE email=?").get(invited).id; } finally { db.close(); } })();
    expect(invId, "PRECONDITION: the invitation exists").toBeTruthy();
    const lastCode = async (email) => {
      const r = await page.request.get(`${BASE}/api/test/last-login-code?email=${encodeURIComponent(email)}`);
      return r.status() === 200 ? (await r.json()).via : null;
    };

    await page.goto(`${BASE}/?invitation=${invId}`);
    await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#login-email"), "the entry screen is filled with the invited address").toHaveValue(invited, { timeout: 10000 });
    await page.locator("#login-submit").click();
    await expect(page.locator("#sc-code")).toBeVisible({ timeout: 10000 });
    const ON_ITS_WAY = "If this address can sign in or sign up, a code is on its way.";
    const PERSONAL = "Personal addresses (Gmail, Outlook…) can't open an account without an invitation.";
    await expect(page.locator("#signin-code-overlay")).toContainText(ON_ITS_WAY);
    await expect(page.locator("#signin-code-overlay")).toContainText(PERSONAL);
    await expect(page.locator("#signin-code-overlay"), "no claim that a code was sent").not.toContainText(/emailed a code/i);
    await expect.poll(() => lastCode(invited), { timeout: 10000, message: "the invited free-mail address really was sent its proof" }).toBe("proof");

    // CONTROL: on the plain entry screen (no invitation) the same words stand,
    // and a free-mail address is sent nothing — the wording's rule holds.
    const ctx = await browser.newContext();
    try {
      const plain = await ctx.newPage();
      const loose = `no-inv-${stamp}@gmail.com`;
      await plain.goto(BASE);
      await plain.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
      await plain.locator("#login-email").fill(loose);
      await plain.locator("#login-submit").click();
      await expect(plain.locator("#sc-code")).toBeVisible({ timeout: 10000 });
      await expect(plain.locator("#signin-code-overlay")).toContainText(ON_ITS_WAY);
      await expect(plain.locator("#signin-code-overlay")).toContainText(PERSONAL);
      await expect(plain.locator("#signin-code-overlay")).not.toContainText(/emailed a code/i);
      expect(await lastCode(loose), "an uninvited free-mail address is sent nothing").toBeNull();
    } finally { await ctx.close(); }
  });
});

// ── v8.1.x: WHAT A REDEMPTION PROVES, AND WHAT IT COSTS ──────────────────────
//
// Two findings, and both are about the redeem ladder being thinner than every
// document describing it:
//
//   #16 — redeem omits the `verified` check on purpose (a passwordless Booth
//         account has no other door), but `requireParticipant` DESTROYS any
//         session whose user is unverified with no active grace. So an
//         approved-but-unverified passwordless account got {ok:true}, reloaded,
//         and had its brand-new session destroyed by boot's own GET /api/me —
//         back at the login screen, one single-use code spent, and asking for
//         another looped identically. The fix keys on HOW the code was
//         delivered: an EMAILED one proves the mailbox and verifies; a
//         DESK-revealed one proves nothing and gets the ordinary 48h grace.
//
//   #18 — lib/lockout.js, lib/login-code.js's header and the arithmetic that
//         chose an 8-character code all say the code shares the account's
//         ten-failure budget. The handler implemented none of it.
test.describe("v8.1.x — the redeem ladder", () => {
  const Database = require("better-sqlite3");
  const { apiLogin } = require("./helpers");

  const readUser = (email, cols) => {
    const db = new Database(TEST_DB_PATH);
    try { return db.prepare(`SELECT ${cols} FROM users WHERE email=?`).get(email); } finally { db.close(); }
  };
  const writeUser = (email, sql, ...args) => {
    const db = new Database(TEST_DB_PATH);
    try { return db.prepare(`UPDATE users SET ${sql} WHERE email=?`).run(...args, email); } finally { db.close(); }
  };

  // EVERY TEST OWNS ITS PARTICIPANT. The lifecycle is written directly rather
  // than through POST .../approve, which REFUSES an unverified account — and
  // unverified-but-approved is precisely the shape finding #16 is about.
  async function mkPasswordless(tag, { verified = 0, approved = 1 } = {}) {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `ladder-${tag}-${stamp}@company.co`;
    const { api, csrf } = await freshCtx();
    const reg = await registerPost(api, "/api/register", {
      headers: h(csrf),
      data: {
        firstName: "Lad", lastName: tag, nickname: `ladder_${tag}_${stamp}`,
        company: "C", title: "T", country: "US", timezone: "America/New_York",
        email, password: "chosen-at-signup-1",
      },
    });
    expect(reg.ok(), `register ${tag}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    await api.dispose();
    // password_set_at NULL is the eligibility discriminator (v7.29.0); registering
    // stamps it, so a walk-up's passwordless shape has to be written here.
    writeUser(email, "password_set_at=NULL, verified=?, approved=?", verified, approved);
    const row = readUser(email, "id, verified, approved, password_set_at");
    expect(row, "the fixture account exists").toBeTruthy();
    expect({ verified: row.verified, approved: row.approved, pw: row.password_set_at },
      "PRECONDITION: approved, not verified, and passwordless").toEqual({ verified, approved, pw: null });
    return { email, id: row.id };
  }

  // Plant a code whose plaintext we know, WITHOUT touching the provenance the
  // server just wrote. The hash is all the server can check (hash-only at rest),
  // so this is the same trick the end-to-end layer above uses.
  function plantKnownCode(email) {
    const { hashCode, mintCode, formatCode } = require("../lib/login-code");
    const known = mintCode();
    writeUser(email, "login_code_hash=?", hashCode(known));
    return formatCode(known);
  }

  test("an EMAILED code verifies the account, and the session it creates SURVIVES its first request", async () => {
    const { email } = await mkPasswordless("mail", { verified: 0, approved: 1 });
    // A live grace window, so "cleared once verified" below has something to clear.
    writeUser(email, "self_enroll_grace_until=?", new Date(Date.now() + 3600_000).toISOString());
    expect(readUser(email, "self_enroll_grace_until").self_enroll_grace_until,
      "PRECONDITION: in a live grace window").toBeTruthy();
    const { api, csrf } = await freshCtx();

    const req = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
    expect(req.status(), "200 always").toBe(200);
    expect(await req.json()).toEqual({ ok: true });
    // The provenance the whole fix keys on. Asserted here rather than inferred
    // from behaviour, because a default flipped to 'email' would make the DESK
    // test below pass for the wrong reason.
    expect(readUser(email, "login_code_via").login_code_via,
      "the emailed mint SAYS it was emailed").toBe("email");

    const code = plantKnownCode(email);
    const r = await api.post("/api/auth/code/redeem", { headers: h(csrf), data: { email, code } });
    expect(r.status(), "200 always — a 4xx here feeds the scanner counter").toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });

    const after = readUser(email, "verified, first_verified_at, self_enroll_grace_until, login_code_hash, login_code_via");
    expect(after.verified, "an emailed code proves mailbox control, exactly as an emailed reset link does").toBe(1);
    expect(after.first_verified_at, "stamped — the unverified-account reaper reads it").toBeTruthy();
    expect(after.self_enroll_grace_until, "dead state once verified").toBeNull();
    expect(after.login_code_hash, "single use").toBeNull();
    expect(after.login_code_via, "and its provenance goes with it").toBeNull();

    // THE HALF THAT IS THE ACTUAL DEFECT. Asserting the column alone would pass
    // against a build that still ejects: requireParticipant re-reads the row on
    // every request and destroys the session when it finds an unverified user
    // with no grace, so the only proof is an authenticated request that WORKS.
    const me = await api.get("/api/me");
    expect(me.status(), `the session survived its first request: ${await me.text()}`).toBe(200);
    expect((await me.json()).email).toBe(email);
    await api.dispose();
  });

  test("a DESK-revealed code signs the holder in WITHOUT verifying them — and that session works too", async () => {
    const { email, id } = await mkPasswordless("desk", { verified: 0, approved: 1 });

    const { api: admin, csrf: aCsrf } = await apiLogin("superadmin");
    const rev = await admin.post(`/api/admin/participants/${id}/login-code/reveal`, { headers: h(aCsrf), data: {} });
    expect(rev.status(), `reveal: ${await rev.text()}`).toBe(200);
    const revealed = (await rev.json()).code;
    expect(revealed, "the admin is handed a code to read out").toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    await admin.dispose();

    // NOT asserted as the literal 'desk': a NULL provenance (a legacy row, or a
    // mint that did not say how it was delivered) MUST behave identically, so
    // the discriminating property is that it is not 'email'. Pinning the string
    // would test which word the desk route passes, not the rule.
    expect(readUser(email, "login_code_via").login_code_via,
      "an admin reading a code off their own screen proves nothing about the mailbox").not.toBe("email");

    const { api, csrf } = await freshCtx();
    const r = await api.post("/api/auth/code/redeem", { headers: h(csrf), data: { email, code: revealed } });
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });

    const after = readUser(email, "verified, self_enroll_grace_until");
    expect(after.verified, "a desk code must NEVER verify — nobody proved the mailbox").toBe(0);
    expect(after.self_enroll_grace_until, "but the session has to work, so the ordinary 48h grace is stamped").toBeTruthy();
    expect(new Date(after.self_enroll_grace_until).getTime(),
      "and the grace is in the future, or requireParticipant destroys the session on its first request")
      .toBeGreaterThan(Date.now());

    // BOTH HALVES MATTER: "verified stayed 0" is equally satisfied by a build
    // that signs the holder into a session that is destroyed one request later —
    // which is the eject loop this whole change exists to end.
    const me = await api.get("/api/me");
    expect(me.status(), `the desk session survived its first request: ${await me.text()}`).toBe(200);
    const meBody = await me.json();
    expect(meBody.email).toBe(email);
    expect(meBody.verified, "still unverified, and the SPA shows the verify-by countdown").toBeFalsy();
    await api.dispose();
  });

  test("wrong codes spend the account's failure budget, and the tenth arms the lock", async () => {
    // THE THRESHOLD IS READ OUT OF ITS ONE DEFINITION, NOT REQUIRED AND NOT
    // RETYPED. `require("../lib/lockout")` opens the database AT MODULE SCOPE,
    // and the Playwright worker does not inherit the server's DATA_DIR — so the
    // require would open a DIFFERENT, real database in the worker process
    // (v7.20.2 / v8.1.0 PR 20, and the v7.21.14 lib/email incident that killed
    // CI workers outright). A second copy of the number would drift, which is
    // the thing lib/lockout.js exists to prevent, so parse it instead.
    const lockoutSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "lockout.js"), "utf8");
    const LOCKOUT_MAX = Number((lockoutSrc.match(/\bconst\s+LOCKOUT_MAX\s*=\s*(\d+)/) || [])[1]);
    expect(Number.isInteger(LOCKOUT_MAX) && LOCKOUT_MAX > 1,
      `lib/lockout.js must still declare LOCKOUT_MAX (read: ${LOCKOUT_MAX}) — otherwise this test loops zero times and asserts nothing`).toBe(true);
    const { email } = await mkPasswordless("lock", { verified: 1, approved: 1 });
    const { api, csrf } = await freshCtx();
    const wrong = async (code) => {
      const r = await api.post("/api/auth/code/redeem", { headers: h(csrf), data: { email, code } });
      expect(r.status(), "every refusal is 200 — a 4xx would block the venue's whole NAT").toBe(200);
      expect(await r.json()).toEqual({ ok: false });
    };

    // A TYPO IS NOT A GUESS. Eight characters read off one screen and typed into
    // another get fumbled; a string that is not even in the code space cannot be
    // an attempt at the credential, and charging it would let someone lock
    // themselves out of the one door they have.
    await wrong("abc");
    expect(readUser(email, "failed_login_count").failed_login_count,
      "a malformed code does not spend the budget").toBe(0);

    for (let i = 0; i < LOCKOUT_MAX - 1; i++) await wrong("ZZZZ-ZZZZ");
    let row = readUser(email, "failed_login_count, locked_until");
    expect(row.failed_login_count, "a WELL-FORMED wrong code is a guess, and it counts").toBe(LOCKOUT_MAX - 1);
    expect(row.locked_until, "…but not yet at the threshold").toBeNull();
    const userId = readUser(email, "id").id;
    const lockEvents = () => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='auto_locked' ORDER BY rowid").all(userId)
          .map(r => JSON.parse(r.details || "{}"));
      } finally { db.close(); }
    };
    expect(lockEvents(), "no lock is recorded below the threshold").toEqual([]);

    await wrong("ZZZZ-ZZZZ");
    row = readUser(email, "failed_login_count, locked_until");
    expect(row.failed_login_count).toBe(LOCKOUT_MAX);
    expect(row.locked_until, "the tenth arms the SAME lock a wrong password arms — one budget, one threshold").toBeTruthy();
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now());
    expect(lockEvents().map(d => ({ method: d.method, failed_count: d.failed_count, until: !!d.until })),
      "…and the lock is recorded once, naming the code door").toEqual([{ method: "login_code", failed_count: LOCKOUT_MAX, until: true }]);
    // A guess while locked is not counted again, nor recorded as a second lock.
    await wrong("ZZZZ-ZZZZ");
    expect(lockEvents().length, "no second lock is recorded").toBe(1);
    await api.dispose();
  });

  // POSITIVE CONTROL for the test above. Without it, "the budget is shared" is
  // equally satisfied by a build that turned the code door into a DoS: anyone
  // can arm this lock with ten guesses and no credential at all, so refusing the
  // holder would let an anonymous caller shut a named participant out for an
  // hour, repeatedly. v7.20.9 (F5) settled that for passwords; this is the same
  // decision on the other door.
  //
  // It uses its OWN participant and sets the lock directly, because arming it
  // through the endpoint fires the lockout email — whose reset-code mint clears
  // the live sign-in code, so there would be no correct code left to honour.
  test("a CORRECT code is honoured while the account is LOCKED, and clears the lock", async () => {
    const { email } = await mkPasswordless("locked", { verified: 1, approved: 1 });
    const { api, csrf } = await freshCtx();
    const req = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
    expect(req.status()).toBe(200);
    const code = plantKnownCode(email);

    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    writeUser(email, "locked_until=?, failed_login_count=?, failed_login_first=?", until, 10, new Date().toISOString());
    expect(readUser(email, "locked_until").locked_until, "PRECONDITION: the account really is locked").toBe(until);

    const r = await api.post("/api/auth/code/redeem", { headers: h(csrf), data: { email, code } });
    expect(r.status()).toBe(200);
    expect(await r.json(), "the person holding the code was never the one being throttled").toMatchObject({ ok: true });

    const after = readUser(email, "locked_until, failed_login_count");
    expect(after.locked_until, "and the lock is lifted, exactly as a correct password lifts it").toBeNull();
    expect(after.failed_login_count, "counters zeroed on a successful sign-in").toBe(0);
    // v8.12.4 — and the release is on the account's History with the reason that
    // separates it from a lockout simply expiring. No test had read it.
    {
      const db = new (require("better-sqlite3"))(TEST_DB_PATH, { readonly: true });
      try {
        const uid = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id;
        const ev = db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='auto_unlocked' ORDER BY rowid DESC").get(uid);
        expect(ev, "the unlock is recorded").toBeTruthy();
        expect(JSON.parse(ev.details || "{}").reason).toBe("correct_login_code");
      } finally { db.close(); }
    }

    const me = await api.get("/api/me");
    expect(me.status(), `signed in: ${await me.text()}`).toBe(200);
    await api.dispose();
  });



  test("an UNAPPROVED account is sent a code, and redeeming the EMAILED code approves it", async () => {
    // With `require_account_approval` off (the default) the emailed code proves
    // the inbox and approves a pending, not-denied account; a DENIED one is never
    // sent a code (the control).
    const no = await mkPasswordless("unapp", { verified: 0, approved: 0 });
    const denied = await mkPasswordless("denied", { verified: 1, approved: 0 });
    { const Database = require("better-sqlite3"); const db = new Database(TEST_DB_PATH);
      try { db.prepare("UPDATE users SET denied_at=?, blocked=1, login_code_hash=NULL, login_code_at=NULL, login_code_via=NULL, login_code_sends=0 WHERE email=?").run(new Date().toISOString(), denied.email); } finally { db.close(); } }
    const { api, csrf } = await freshCtx();
    for (const who of [no, denied]) {
      const r = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email: who.email } });
      expect(r.status(), "uniform, always — the answer must not reveal eligibility").toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    expect(readUser(denied.email, "login_code_hash").login_code_hash, "a denied account is sent nothing").toBeNull();
    const code = (await (await api.get(`/api/test/last-login-code?email=${encodeURIComponent(no.email)}`)).json()).code;
    const r = await api.post("/api/auth/code/redeem", { headers: h(csrf), data: { email: no.email, code } });
    expect(await r.json()).toMatchObject({ ok: true });
    const after = readUser(no.email, "approved, verified, approved_by");
    expect(after, "the emailed code verified AND approved the account").toMatchObject({ approved: 1, verified: 1, approved_by: "login_code" });
    await api.dispose();
  });

  test("a re-issued code does not buy a fresh window, and the email says the truth", async () => {
    // #19 (half) — `login_code_at` anchors to the FIRST mint and a re-issue
    // deliberately does not move it, so a second code dies when the ORIGINAL
    // window ends. The mail hard-coded "It expires in 10 minutes", which is
    // wrong on every send after the first and wrong in the direction that leaves
    // someone typing a code that died two minutes ago.
    const { email } = await mkPasswordless("reissue", { verified: 1, approved: 1 });
    const { api, csrf } = await freshCtx();
    const ask = () => api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
    expect((await ask()).status()).toBe(200);
    const first = readUser(email, "login_code_at, login_code_sends");
    // A second ask inside two minutes is suppressed (the code in the inbox stays
    // the live one); forget that on purpose to reach the re-issue.
    await api.post("/api/test/reset-recent-code-sends", { headers: h(csrf) });
    expect((await ask()).status()).toBe(200);
    const second = readUser(email, "login_code_at, login_code_sends");
    expect(second.login_code_at, "the window is anchored to the FIRST mint").toBe(first.login_code_at);
    expect(second.login_code_sends, "and the send is counted against the cap").toBe(first.login_code_sends + 1);
    await api.dispose();

    // The remaining-minutes arithmetic is what the mail prints, and the mail body
    // is not observable from here (the shared server points at a dead SMTP port
    // and user_events.email_sent records the subject, never the body). So the flat
    // literal is pinned out of the source instead.
    //
    // COMMENTS ARE STRIPPED FIRST — the comment above and the one at the template
    // both quote the sentence being forbidden, which is the v7.21.13 lesson
    // arriving in the lock for the very fix that teaches it.
    //
    // v8.3.6 — RE-POINTED, NOT WEAKENED. The template moved out of the route into
    // `lib/email.js` (`sendLoginCodeEmail`) when registration became a second
    // sender of the same mail, so pinning `routes/auth.js` alone would have gone
    // quietly vacuous — it would still find no "expires in 10 minutes" there and
    // no `expiresInMinutes` either. Both files are scanned now: the forbidden
    // literal must appear in NEITHER, and the arithmetic must appear SOMEWHERE.
    // That survives the template moving again.
    //
    // The body itself is now asserted for real, on a delivered message, by
    // `registration-email-dispositions.spec.js` — which is the coverage this
    // source lock has always been a stand-in for.
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
    const routeSrc = strip(fs.readFileSync(path.join(__dirname, "..", "routes", "auth.js"), "utf8"));
    const emailSrc = strip(fs.readFileSync(path.join(__dirname, "..", "lib", "email.js"), "utf8"));
    for (const [name, src] of [["routes/auth.js", routeSrc], ["lib/email.js", emailSrc]]) {
      expect(src, `${name}: the sign-in-code mail must not promise a window a re-issue does not get`)
        .not.toMatch(/expires in 10 minutes/i);
    }
    expect(`${routeSrc}\n${emailSrc}`, "it renders the remaining minutes issueCode computed from the anchor")
      .toContain("expiresInMinutes");
  });
});
