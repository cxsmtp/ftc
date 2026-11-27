// @ts-check
//
// v7.26.0 — the outbound SENDER: display name from Settings → Platform Name,
// address from the operator's EMAIL_FROM.
//
// WHY THIS SPEC SPAWNS A SERVER AND A REAL SMTP SERVER. The From header is the
// one property of an outbound email that cannot be observed anywhere else in
// this suite. `sendEmailLogged` records an `email_sent` user_event carrying
// `to` / `subject` / `reason` / `success` and deliberately NOT `from`, and the
// shared test server points at a dead SMTP port, so every existing email
// assertion can only check what we COMPOSED.
//
// That distinction is the whole subject here. The pre-v7.26.0 code composed a
// string — `${getPlatformName()} <no-reply@…>` — which looked correct at the
// call site and which nodemailer then RE-PARSED into a different sender: a
// platform name containing an angle-addr supplied the address, taking over both
// the visible From and the SMTP envelope MAIL FROM. A lock that read our own
// variable back would have passed throughout that defect. So these tests read
// the bytes the SMTP server actually received.
//
// Verified by mutation: restoring the string form makes "cannot hijack the
// sender" report envelope MAIL FROM = attacker@evil.test.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const { readySpawnedServer } = require("./spawned-server");

// The operator's deploy-time value. Its DISPLAY NAME is deliberately something
// no test ever sets as a platform name, so "the platform name won" and "the
// EMAIL_FROM name was ignored" are separately observable rather than one
// assertion wearing two hats.
const SENDER_ADDRESS = "no-reply@sender.test";
const EMAIL_FROM = `Deploy-Time Name <${SENDER_ADDRESS}>`;

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("Outbound sender name follows the platform name (v7.26.0)", () => {
  test.describe.configure({ mode: "serial" });

  let child, sink, BASE, dataDir, childOut = "";

  /** Minimal cookie-jar client — the spawned server is outside the Playwright fixture. */
  class Client {
    constructor() { this.cookie = ""; this.csrf = ""; }
    async go(p, opts = {}) {
      const headers = {};
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (this.csrf) headers["x-csrf-token"] = this.csrf;
      if (this.cookie) headers["cookie"] = this.cookie;
      const r = await fetch(`${BASE}${p}`, {
        method: opts.method || "GET", headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
      let json = null; try { json = await r.json(); } catch (_) {}
      return { status: r.status, json };
    }
    async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
  }

  let sa;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    sink = await startSmtpCapture();
    const port = PORT_BASE + 130; // outside the worker-slot range, and unused by other spawners
    BASE = `http://localhost:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-name-"));
    const spawnedAt = Date.now();
    child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        // The point of the whole spec: a real SMTP server that keeps what it is sent.
        SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sink.port), SMTP_ALLOW_PLAINTEXT: "1",
        EMAIL_FROM,
        // Nothing here is about throttling, and a limiter firing mid-fixture
        // would be an unrelated flake.
        RATE_LIMIT_DISABLED: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        NODE_OPTIONS: "", // v7.15.30 — a spawned server runs OUR node flags, never the runner's.
        // NODE_ENV deliberately unset: `production` forces a Secure cookie,
        // which express-session refuses to emit over plain HTTP, so there would
        // be no session at all.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });

    const pass = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => childOut });
    sa = new Client();
    await sa.refreshCsrf();
    const li = await sa.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } });
    expect(li.status, "superadmin signs in").toBe(200);
    await sa.refreshCsrf();
  });

  test.afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch (_) {}
    try { await sink?.close(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  /** Set the platform name, asserting it took — a silently-refused PATCH would make every later assertion vacuous. */
  async function setPlatformName(name) {
    const r = await sa.go("/api/admin/settings", { method: "PATCH", body: { platform_name: name } });
    expect(r.status, `PATCH platform_name ${JSON.stringify(name)}: ${JSON.stringify(r.json)}`).toBe(200);
    expect(r.json.platform_name).toBe(name);
  }

  /**
   * Trigger a REAL transactional send (the address proof the entry screen
   * mails a new work address) to a unique address, and return the message the
   * SMTP server received.
   *
   * The real door is used rather than a stub because it goes through
   * `sendEmailLogged` — the wrapper behind every template sender — so the
   * assertion covers the path all the call sites use.
   */
  async function sendAndCapture(tag) {
    const c = new Client();
    await c.refreshCsrf();
    const addr = `recip-${tag}@acme.test`;
    const r = await c.go("/api/auth/code/request", { method: "POST", body: { email: addr } });
    expect(r.status, `code request ${addr}: ${JSON.stringify(r.json)}`).toBe(200);
    return await sink.waitFor(m => m.rcptTo.includes(addr));
  }

  test("the sender NAME is the platform name and the ADDRESS is the operator's EMAIL_FROM", async () => {
    const name = `Sender Alpha ${Date.now().toString(36)}`;
    await setPlatformName(name);

    const msg = await sendAndCapture(`alpha-${Date.now().toString(36)}`);

    // Plain, space-only names need no quoting, so this is the exact header.
    expect(msg.header("from")).toBe(`${name} <${SENDER_ADDRESS}>`);
    // The envelope is what SPF authenticates and where bounces go. It must be
    // the operator's address and must not follow the display name.
    expect(msg.envelopeFrom).toBe(SENDER_ADDRESS);

    // The EMAIL_FROM display name is IGNORED. Asserted separately from the
    // above so a regression that dropped the platform name back to the
    // deploy-time value fails on a statement about the thing that changed.
    expect(msg.header("from")).not.toContain("Deploy-Time Name");
  });

  test("renaming the platform moves the sender name with NO restart", async () => {
    const before = `Sender Before ${Date.now().toString(36)}`;
    await setPlatformName(before);
    const first = await sendAndCapture(`before-${Date.now().toString(36)}`);
    expect(first.header("from")).toBe(`${before} <${SENDER_ADDRESS}>`);

    // Same process, no redeploy — the memo is invalidated by the PATCH.
    const after = `Sender After ${Date.now().toString(36)}`;
    await setPlatformName(after);
    const second = await sendAndCapture(`after-${Date.now().toString(36)}`);
    expect(second.header("from")).toBe(`${after} <${SENDER_ADDRESS}>`);
    expect(second.header("from")).not.toContain(before);
  });

  test("a platform name containing an angle-addr cannot hijack the sender, the envelope, or inject a header", async () => {
    // The exact shape that used to work: with string composition this produced
    // From: "Evil no-reply@sender.test" <attacker@evil.test> and an envelope
    // MAIL FROM of attacker@evil.test.
    await setPlatformName("Evil <attacker@evil.test>");
    const msg = await sendAndCapture(`hijack-${Date.now().toString(36)}`);

    // The address half is untouched, in BOTH the header and the envelope.
    expect(msg.header("from")).toBe(`"Evil <attacker@evil.test>" <${SENDER_ADDRESS}>`);
    expect(msg.envelopeFrom, "the SMTP MAIL FROM — SPF identity and bounce path").toBe(SENDER_ADDRESS);
    expect(msg.rcptTo).not.toContain("attacker@evil.test");

    // ...and nothing new appeared in the header block.
    expect(msg.headers).not.toHaveProperty("bcc");
    expect(msg.headers).not.toHaveProperty("cc");
  });

  test("a bare-address platform name is neutralised too — the variant a `<>` blocklist would miss", async () => {
    // This one carries no angle brackets at all, so "reject < and >" would let
    // it through; under string composition nodemailer's addressparser took it
    // as the addr-spec.
    await setPlatformName("x@evil.test");
    const msg = await sendAndCapture(`bare-${Date.now().toString(36)}`);
    expect(msg.header("from")).toBe(`"x@evil.test" <${SENDER_ADDRESS}>`);
    expect(msg.envelopeFrom).toBe(SENDER_ADDRESS);
  });

  test("the List-Unsubscribe mailto domain follows the operator's ADDRESS, not the platform name", async () => {
    // Bulk reasons carry RFC 2369 / RFC 8058 headers whose mailto alias is built
    // from the sender domain. That domain used to be re-parsed out of the
    // composed From string with a second regex, which a name containing an
    // address hijacked independently of the From itself.
    await setPlatformName("Evil <attacker@evil.test>");

    const invitee = `invitee-${Date.now().toString(36)}@acme.test`;
    const r = await sa.go("/api/admin/invitations", { method: "POST", body: { emails: [invitee] } });
    expect(r.status, `invite: ${JSON.stringify(r.json)}`).toBe(200);

    const msg = await sink.waitFor(m => m.rcptTo.includes(invitee));
    const lu = msg.header("list-unsubscribe") || "";
    expect(lu, "the bulk headers are present at all").toContain("mailto:unsubscribe@");
    expect(lu).toContain(`mailto:unsubscribe@sender.test`);
    expect(lu).not.toContain("evil.test");
  });

  test("the SMTP diagnostic reports the SAME sender as real mail", async () => {
    // /api/admin/test-email bypasses sendEmailLogged and builds its own message.
    // It exists to tell an operator what real mail looks like, so a second
    // resolver here would make the diagnostic lie.
    const name = `Diag Arena ${Date.now().toString(36)}`;
    await setPlatformName(name);

    const real = await sendAndCapture(`diag-${Date.now().toString(36)}`);

    const probe = `probe-${Date.now().toString(36)}@acme.test`;
    const r = await sa.go("/api/admin/test-email", { method: "POST", body: { to: probe } });
    expect(r.status, `test-email: ${JSON.stringify(r.json)}`).toBe(200);
    const diag = await sink.waitFor(m => m.rcptTo.includes(probe));

    expect(diag.header("from")).toBe(real.header("from"));
    expect(diag.header("from")).toBe(`${name} <${SENDER_ADDRESS}>`);
    expect(diag.envelopeFrom).toBe(SENDER_ADDRESS);
  });

  test("a non-ASCII platform name is RFC 2047 encoded rather than emitted raw", async () => {
    await setPlatformName("Arène Zürich");
    const msg = await sendAndCapture(`utf8-${Date.now().toString(36)}`);
    const from = msg.header("from");
    expect(from).toMatch(/^=\?UTF-8\?/);           // encoded-word, not raw bytes
    expect(from).toContain(`<${SENDER_ADDRESS}>`);
    expect(from).not.toContain("Arène");            // i.e. it really was encoded
    expect(msg.envelopeFrom).toBe(SENDER_ADDRESS);
  });

  test("PATCH /api/admin/settings is SUPERADMIN-only", async () => {
    // Build a REGULAR admin on this pristine server, email first: the entry
    // screen mails the new address a proof, redeeming it grants the sign-up,
    // the form creates the (verified, approved) account; then promote. Each step
    // is asserted, so a fixture that silently failed would report as a fixture
    // failure rather than passing this test vacuously. This server runs without
    // NODE_ENV=test, so every code is read off the captured mail; the subject is
    // RFC 2047-encoded, so a mail is told apart by the code it carries.
    const tag = Date.now().toString(36);
    const adminEmail = `regadmin-${tag}@acme.test`;
    const CODE_RE = /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/;
    // Read the code from the BODY only. The header block carries nodemailer's
    // Message-ID, `<8hex-4hex-4hex-4hex-12hex@…>`: two adjacent 4-hex groups
    // that happen to be all digits (about 4% of mails) match CODE_RE ahead of
    // the real code, and the redeem then answers {ok:false}, a flake that only
    // looked like a sign-in regression.
    const bodyOf = (x) => {
      const crlf = x.raw.indexOf("\r\n\r\n");
      const at = crlf >= 0 ? crlf : x.raw.indexOf("\n\n");
      expect(at, "the captured mail has a header/body separator").toBeGreaterThan(0);
      return x.raw.slice(at);
    };
    const codeFrom = async (sinceIdx) => {
      const m = await sink.waitFor(x => sink.messages.indexOf(x) >= sinceIdx && x.rcptTo.includes(adminEmail) && CODE_RE.test(bodyOf(x)));
      return (bodyOf(m).match(CODE_RE) || [])[1];
    };
    const reg = new Client();
    await reg.refreshCsrf();
    let since = sink.messages.length;
    expect((await reg.go("/api/auth/code/request", { method: "POST", body: { email: adminEmail } })).status).toBe(200);
    const proof = await codeFrom(since);
    expect(proof, "the entry screen mailed the new address a proof").toBeTruthy();
    const pr = await reg.go("/api/auth/code/redeem", { method: "POST", body: { email: adminEmail, code: proof } });
    expect(pr.json?.needsProfile, `the proof grants the sign-up: ${JSON.stringify(pr.json)}`).toBe(true);
    await reg.refreshCsrf();   // the redeem regenerated the session
    const rr = await reg.go("/api/register", {
      method: "POST",
      body: {
        firstName: "Reg", lastName: "Admin", nickname: `regadmin-${tag}`,
        email: adminEmail, company: "Acme", title: "Engineer",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      },
    });
    expect(rr.status, `register admin: ${JSON.stringify(rr.json)}`).toBe(200);
    expect(rr.json?.ok, `register admin: ${JSON.stringify(rr.json)}`).toBe(true);

    const list = await sa.go("/api/admin/participants?limit=200");
    expect(list.status).toBe(200);
    const row = (list.json.participants || []).find(p => p.email === adminEmail);
    expect(row, "the freshly registered admin is in the participant list").toBeTruthy();
    expect((await sa.go(`/api/admin/participants/${row.id}/role`, { method: "POST", body: { role: "admin" } })).status).toBe(200);

    const ad = new Client();
    await ad.refreshCsrf();
    // Every account but the built-in signs in with an emailed code.
    since = sink.messages.length;
    expect((await ad.go("/api/auth/code/request", { method: "POST", body: { email: adminEmail } })).status).toBe(200);
    const code = await codeFrom(since);
    expect(code, "the entry screen mailed the account a sign-in code").toBeTruthy();
    const li = await ad.go("/api/auth/code/redeem", { method: "POST", body: { email: adminEmail, code } });
    expect(li.status, `regular admin signs in: ${JSON.stringify(li.json)}`).toBe(200);
    expect(li.json?.ok, `regular admin signs in: ${JSON.stringify(li.json)}`).toBe(true);
    await ad.refreshCsrf();

    // POSITIVE CONTROL: this really is a working admin session, so a 403 below
    // is about the tier and not about a broken login.
    expect((await ad.go("/api/admin/participants?limit=1")).status, "the session IS an admin session").toBe(200);
    expect((await ad.go("/api/admin/settings")).status, "GET stays admin-readable").toBe(200);

    const denied = await ad.go("/api/admin/settings", { method: "PATCH", body: { platform_name: "Regular Admin Was Here" } });
    expect(denied.status, "a regular admin may not change the sender identity").toBe(403);

    // ...and the value really did not move.
    const cfg = await sa.go("/api/config");
    expect(cfg.json.platform_name).not.toBe("Regular Admin Was Here");

    // The superadmin still can — or the 403 above could be a broken endpoint.
    await setPlatformName(`Superadmin Still Can ${tag}`);
  });

  test("a platform name carrying control characters is REFUSED, and the stored name is unchanged", async () => {
    const good = `Control Baseline ${Date.now().toString(36)}`;
    await setPlatformName(good);

    for (const bad of ["Arena\r\nBcc: attacker@evil.test", "Arena\nX", "Arena\tX", "Arena\u0000X", "Arena\u007FX"]) {
      const r = await sa.go("/api/admin/settings", { method: "PATCH", body: { platform_name: bad } });
      expect(r.status, `platform_name ${JSON.stringify(bad)} must be refused`).toBe(400);
      expect(String(r.json?.error || "")).toMatch(/line break|control character/i);
    }

    // Nothing was written by any of the refusals.
    const cfg = await sa.go("/api/config");
    expect(cfg.json.platform_name).toBe(good);

    // POSITIVE CONTROL: ordinary punctuation that a real brand name uses is
    // still accepted — a guard that refused everything would pass the loop above.
    await setPlatformName(`Acme, Inc. "Arena" <Europe> ${Date.now().toString(36)}`);
  });
});

// The settings route refuses control characters, so on a database written by
// this release the sink can never see one. `_safeDisplayName` is defence in
// depth for the two paths that bypass that route entirely: a row stored BEFORE
// the validation existed, and the `COMPETITION_NAME` env fallback, which is
// uncapped and unvalidated and is what `getPlatformName()` returns when no
// setting row exists at all.
//
// COMPETITION_NAME is the reachable one, so it is what this drives. Without it
// the sanitiser would be untested code justified by a comment — and the failure
// it prevents is silent: a literal `=0D=0A` in the recipient's From line.
test.describe("The sender name is sanitised even when it bypasses the settings route (v7.26.0)", () => {
  test("a control-character COMPETITION_NAME fallback still yields a clean From", async () => {
    test.setTimeout(180_000);
    const sink = await startSmtpCapture();
    const port = PORT_BASE + 131;
    const BASE = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-legacy-"));
    let childOut = "";
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sink.port), SMTP_ALLOW_PLAINTEXT: "1",
        // A BARE address, deliberately — the other server uses the `Name <addr>`
        // form, so between them both alternations of `_extractSenderAddress` are
        // exercised. Without this the bare branch could be deleted outright and
        // every test would still pass, while the shape the README now recommends
        // as "the clearer form" silently fell back to no-reply@hackathon.local.
        EMAIL_FROM: SENDER_ADDRESS,
        // No platform_name row is ever written here, so getPlatformName() falls
        // through to this — carrying a tab, a newline and a doubled space.
        // NOT a NUL: an env value physically cannot contain one (Node refuses
        // to spawn), so that case is reachable only from a legacy DB row. The
        // sanitiser covers both; only this half is drivable from a test.
        COMPETITION_NAME: "Legacy\tArena\nName  Two",
        RATE_LIMIT_DISABLED: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });

    try {
      await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => childOut });

      // PRECONDITION: the fallback really is in play, control characters and
      // all. Without this the test could pass because the name was something
      // else entirely.
      const cfg = await (await fetch(`${BASE}/api/config`)).json();
      expect(cfg.platform_name, "the raw fallback reaches /api/config unsanitised").toMatch(/[\t\n]/);

      const csrf = (await (await fetch(`${BASE}/api/csrf-token`)).json()).csrfToken;
      // A cookie jar is unnecessary here: the CSRF token rides the session the
      // same request established, so reuse that Set-Cookie.
      const jar = (await fetch(`${BASE}/api/csrf-token`, { headers: {} }));
      const cookies = (jar.headers.getSetCookie ? jar.headers.getSetCookie() : []).map(c => c.split(";")[0]).join("; ");
      const tok = (await jar.json()).csrfToken || csrf;

      const addr = `legacy-${Date.now().toString(36)}@acme.test`;
      // The entry screen's Continue for a new work address mails it an address
      // proof through sendEmailLogged — a real transactional send.
      const rr = await fetch(`${BASE}/api/auth/code/request`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": tok, cookie: cookies },
        body: JSON.stringify({ email: addr }),
      });
      expect(rr.status, `code request: ${await rr.text()}`).toBe(200);

      const msg = await sink.waitFor(m => m.rcptTo.includes(addr));
      // Control characters became spaces, the run collapsed, nothing encoded.
      expect(msg.header("from")).toBe(`Legacy Arena Name Two <${SENDER_ADDRESS}>`);
      expect(msg.header("from")).not.toMatch(/=0D|=0A|=00|=09/);
      expect(msg.envelopeFrom).toBe(SENDER_ADDRESS);
    } finally {
      try { child.kill("SIGKILL"); } catch (_) {}
      try { await sink.close(); } catch (_) {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
