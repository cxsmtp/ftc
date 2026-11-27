// @ts-check
//
// v8.3.13 — A CSRF TOKEN IS WORTHLESS WITHOUT THE SESSION IT BELONGS TO.
//
// Reported from production as "many login attempts fail with csrf_invalid, and
// the server has not been restarted". The name was the problem: nothing about
// CSRF was broken. `SECURE_COOKIE` is true whenever NODE_ENV=production OR
// BASE_URL is https OR trust-proxy is on, and express-session then refuses to
// emit `Set-Cookie` for any request it does not consider secure —
//   `if (req.session.cookie.secure && !issecure(req, trustProxy)) return;`
// — while `GET /api/csrf-token` cheerfully answered 200 with a token anyway. The
// browser held a token for a session it could never present, so the next POST
// was 403 `csrf_invalid`, for ever, for that visitor. Measured against the live
// deployment: no `X-Forwarded-Proto` → 200, a valid token, and NO `Set-Cookie`.
//
// It needs no code change and no restart to begin: the process listens on
// 0.0.0.0, so a direct hit on the port, a second ingress, or a proxy hop that
// stops forwarding the header all land in it — and express-session's own notice
// is `debug()`-only, so the operator's single signal was an error naming the
// wrong subsystem.
//
// THIS SPEC SPAWNS ITS OWN SERVERS because the condition is a property of the
// server's ENVIRONMENT (SECURE_COOKIE) and cannot be produced on the shared test
// server, which runs over plain http with no trust proxy — where the branch is
// correctly unreachable. That is also the control: the second server proves the
// ordinary deployment is byte-identical to before.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE, BASE, freshCtx } = require("./helpers");

// The shared per-worker server, for the browser-driven half.
test.use({ baseURL: BASE });
const { spawn } = require("child_process");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A spawned server plus its captured output. `NODE_OPTIONS: ""` is not optional
// — v7.15.30: a spawned server must run OUR node flags, never the runner's.
async function spawnServer(port, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "csrf-delivery-"));
  let out = "";
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PORT: String(port), DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "1",
      RATE_LIMIT_DISABLED: "1",
      NODE_OPTIONS: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", b => { out += b.toString(); });
  child.stderr.on("data", b => { out += b.toString(); });

  const base = `http://127.0.0.1:${port}`;
  await readySpawnedServer({ base, child, dataDir, spawnedAt, output: () => out });
  return { child, base, dataDir, log: () => out };
}

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.3.13 — the CSRF token and the session cookie travel together", () => {
  let secure = null;   // SECURE_COOKIE on: https BASE_URL + trust proxy, i.e. production's shape
  let plain = null;    // the control: plain http, no trust proxy — SECURE_COOKIE off

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // Ports outside the worker-slot range and clear of the other spawners
    // (email-sender uses +130, login-code +140).
    secure = await spawnServer(PORT_BASE + 150, { BASE_URL: "https://csrf.test", TRUST_PROXY: "1" });
    plain = await spawnServer(PORT_BASE + 151, { BASE_URL: `http://127.0.0.1:${PORT_BASE + 151}` });
  });

  test.afterAll(async () => {
    for (const s of [secure, plain]) {
      try { s?.child?.kill("SIGKILL"); } catch (_) {}
      try { fs.rmSync(s.dataDir, { recursive: true, force: true }); } catch (_) {}
    }
    await sleep(200);   // let the kernel release the ports (v7.29.0)
  });

  test("a request the session cookie cannot reach is REFUSED, not handed a dead token", async () => {
    // THE DEFECT, exactly as production met it: no X-Forwarded-Proto, so
    // express-session will drop the cookie.
    const r = await fetch(`${secure.base}/api/csrf-token`);
    const body = await r.json();

    // The load-bearing assertion is the ABSENCE of a token: handing one out is
    // what made this silent, because the failure then surfaced two requests
    // later under a name from the wrong subsystem.
    expect(body.csrfToken, "a token that cannot be used must not be issued").toBeFalsy();
    expect(r.status, "503 — the DEPLOYMENT is wrong, not the request").toBe(503);
    expect(body.error).toBe("session_cookie_blocked");
    // The remedy has to be in the message. An operator meeting this has no other
    // signal — express-session's own notice is debug-only (v7.29.0's rule that a
    // refusal names an action the reader can take).
    expect(body.message, "the refusal names the fix").toMatch(/X-Forwarded-Proto|HTTPS/i);

    // …and the response is not cacheable. It never set any cache header, so a
    // CDN could have served one visitor's token to another.
    expect(r.headers.get("cache-control"), "a per-session credential is never cacheable").toMatch(/no-store/);

    // AND THE OPERATOR IS TOLD, which is the half that would have turned this
    // report into a two-minute diagnosis. Asserted HERE rather than in a test of
    // its own, and that is deliberate: the warning is rate-limited to one line a
    // minute (the condition holds for every request, so a line each would bury
    // it), so only the FIRST request to this server is guaranteed to emit — and a
    // separate test would either depend on this one having run or need its own
    // server. Same event, same assertion, no order dependence.
    await sleep(300);
    const out = secure.log();
    expect(out, "the log must name the condition").toMatch(/session cookie SUPPRESSED/);
    // The three fields that decide the verdict, because they are exactly what the
    // operator has to go and look at.
    expect(out).toMatch(/x_forwarded_proto/);
    expect(out).toMatch(/trust_proxy/);
    expect(out).toMatch(/secure_cookie/);
  });

  test("with the header a correct proxy sends, the cookie and the token both arrive", async () => {
    // THE CONTROL, and it carries the weight: without it, "no token was issued"
    // is equally satisfied by a build where this endpoint never works at all.
    const r = await fetch(`${secure.base}/api/csrf-token`, { headers: { "X-Forwarded-Proto": "https" } });
    expect(r.status).toBe(200);
    expect((await r.json()).csrfToken, "a real token").toBeTruthy();
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    expect(sc.join(";"), "and the session it belongs to").toMatch(/connect\.sid=/);
  });

  test("a plain-http deployment is completely unaffected", async () => {
    // The SECOND control. SECURE_COOKIE is false here, so the new branch is
    // unreachable and dev behaviour is byte-identical to before.
    const r = await fetch(`${plain.base}/api/csrf-token`);
    expect(r.status).toBe(200);
    expect((await r.json()).csrfToken).toBeTruthy();
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    expect(sc.join(";"), "plain http still gets its session").toMatch(/connect\.sid=/);
  });

  test("a chain that MATCHES TRUST_PROXY is silent — the control for the warning", async () => {
    // Without this, "the mismatch is reported" is equally satisfied by a build
    // that warns on every request, which would be noise an operator learns to
    // ignore (v7.25.0: a detector that cries wolf is not conservative, it is
    // broken).
    //
    // v8.12.4 — this runs BEFORE the mismatch test, deliberately. The warning is
    // rate-limited to one line a minute, so after the mismatch test has emitted
    // one, a build that warned on a MATCHING chain would be silenced by the rate
    // limit and this control would pass for the wrong reason. Here it is the first
    // request to this server carrying X-Forwarded-For at all.
    const before = (secure.log().match(/carries MORE hops/g) || []).length;
    for (let i = 0; i < 3; i++) {
      await fetch(`${secure.base}/api/csrf-token`, {
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9" },
      });
    }
    await sleep(300);
    expect((secure.log().match(/carries MORE hops/g) || []).length,
      "a single-hop chain with TRUST_PROXY=1 is correct and must say nothing").toBe(before);
  });

  test("a proxy chain longer than TRUST_PROXY is reported — every visitor would share one bucket", async () => {
    // The strongest explanation for a fault that starts with no restart: put a
    // CDN in front of an existing nginx and `req.ip` becomes the inner proxy's
    // address for EVERY client, so one 120/min bucket and one scanner counter
    // serve the whole population. The app cannot know the topology, so it
    // reports the discrepancy rather than guessing at it.
    await fetch(`${secure.base}/api/csrf-token`, {
      headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9, 10.0.0.7" },
    });
    await sleep(300);
    expect(secure.log(), "the hop mismatch must be named").toMatch(/carries MORE hops than TRUST_PROXY/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE AMPLIFIER — why a rare fault read as "many situations".
//
// Three things composed. `loadCsrfToken()` did `S.csrfToken = d.csrfToken || ''`,
// so ANY response without a token (a 429 from the 120/min per-IP cap, a whole-IP
// scanner block, the 503 above) was silently stored as an empty token. The
// EBADCSRFTOKEN handler then DESTROYED the session — including an anonymous one,
// which is the very session a retry needs. And `doLogin` never re-fetched, so the
// first failure was permanent for that page and rendered the raw machine string
// `csrf_invalid` at the user.
//
// Any ONE of the triggers is transient. Together with these three it became a
// login card that never worked again until the tab was reloaded.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.3.13 — one bad token no longer poisons the page", () => {
  const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

  test("after a refused token, the SAME anonymous session survives — its original token still works", async () => {
    // v8.3.13 stopped the EBADCSRFTOKEN handler destroying an ANONYMOUS session,
    // on the reasoning that it is the very session a retry needs. As first
    // written this test refreshed the token after the refusal, and a client that
    // accepts `Set-Cookie` simply gets a NEW session that way — MEASURED, an
    // unconditional destroy left it GREEN, so the carve-out was recorded as
    // DEFENCE IN DEPTH. v8.13.4 closes that: the token minted BEFORE the refusal
    // is reused, and only the SAME session accepts it. An unconditional destroy
    // now fails here, and the anonymous carve-out is LOCKED rather than declared
    // (csrf-session-end.api.spec.js (C) holds it too, with its audit half).
    //
    // A fresh cookie jar, so the anonymous session under test is this test's own.
    const { api: ctx } = await freshCtx();
    try {
      const first = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      expect(first, "a token to start from").toBeTruthy();

      const bad = await ctx.post("/api/login", {
        headers: H("definitely-not-the-token"), data: { email: "x@y.test", password: "nope" },
      });
      expect(bad.status(), "a wrong token is still refused").toBe(403);
      expect((await bad.json()).error).toBe("csrf_invalid");

      // THE ASSERTION: the SAME session is still there. It hands back the token
      // it already holds (csrf-sync does not overwrite one), and that ORIGINAL
      // token is accepted. A destroyed session would mint a different token
      // for a new session, and the original would be refused.
      const second = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      expect(second, "the surviving session hands back the token it already holds").toBe(first);
      const good = await ctx.post("/api/login", {
        headers: H(first), data: { email: "x@y.test", password: "nope" },
      });
      expect(good.status(),
        "past the CSRF gate — 401 is the credential being wrong, which is the point"
      ).toBe(401);
    } finally { await ctx.dispose(); }
  });

  test("the SPA refreshes a stale token and retries, so the user never sees csrf_invalid", async ({ page }) => {
    // Driven in a real browser, because the fix is the client's. The token is
    // sabotaged in place — which is exactly the state a 429'd refresh, a swept
    // 60-minute anonymous session or a suppressed cookie leaves the page in.
    await page.goto("/");
    await page.waitForFunction(() => !!window.S && typeof window.S.csrfToken === "string" && window.S.csrfToken.length > 0);
    await page.evaluate(() => { window.S.csrfToken = "stale-and-worthless"; });

    const res = await page.evaluate(async () => {
      const r = await window.postWithCsrfRetry("/api/login", (t) => ({
        method: "POST",
        headers: { "X-CSRF-Token": t, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@nowhere.test", password: "wrong" }),
      }));
      return { status: r.status, body: await r.json().catch(() => null) };
    });

    // 401 = the credential was wrong, i.e. it got PAST the CSRF gate on the
    // retry. Pre-fix this was a 403 csrf_invalid with the raw code on screen.
    expect(res.status, `retry must clear the CSRF gate (got ${JSON.stringify(res.body)})`).toBe(401);
    expect(res.body && res.body.error, "and it is a credential refusal, not a CSRF one").not.toBe("csrf_invalid");
  });

  test("a throttled refresh does NOT blank a working token", async ({ page }) => {
    // `S.csrfToken = d.csrfToken || ''` turned one throttled refresh into a page
    // that could never POST again. A failed refresh must leave what we have.
    await page.goto("/");
    await page.waitForFunction(() => !!window.S && typeof window.S.csrfToken === "string" && window.S.csrfToken.length > 0);
    const before = await page.evaluate(() => window.S.csrfToken);

    await page.route("**/api/csrf-token", (r) => r.fulfill({
      status: 429, contentType: "application/json",
      body: JSON.stringify({ error: "Too many requests. Please try again later." }),
    }));
    const got = await page.evaluate(() => window.loadCsrfToken());
    await page.unroute("**/api/csrf-token");

    expect(await page.evaluate(() => window.S.csrfToken),
      "a 429 must not replace a good token with an empty string").toBe(before);
    expect(got, "…and the caller is told a token is still in hand").toBe(true);
  });
});
