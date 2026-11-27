// NEVER A WRITE WITHOUT A TOKEN. Behind one venue NAT the per-IP
// /api/csrf-token limit answers 429; the sign-in client used to post its code
// request anyway with an EMPTY token, every post answered 403 csrf_invalid, and
// those 403s fed the scanner tracker until the whole venue address was blocked
// (load test: 55,380 such posts, 76 of 1000 signed in). The door now waits for a
// token (Retry-After / capped exponential back-off), says "Busy — retrying…",
// and sends exactly ONE request once a token is issued.
const { test, expect } = require("./isolated-test");
const { BASE, freshCtx, registerPost } = require("./helpers");
test.use({ baseURL: BASE });

test("csrf-token answering 429: zero code requests are sent until a token is issued, then exactly one", async ({ page }) => {
  let refuse = true, tokenCalls = 0;
  await page.route("**/api/csrf-token", async (route) => {
    tokenCalls++;
    if (refuse) return route.fulfill({ status: 429, headers: { "Retry-After": "1", "Content-Type": "application/json" }, body: JSON.stringify({ error: "Too many requests" }) });
    return route.continue();
  });
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/auth/code/request")) posts.push(r.headers()["x-csrf-token"] || ""); });
  await page.goto("/");
  await page.locator("#login-email").waitFor({ state: "visible" });
  await page.fill("#login-email", `busy-${Date.now()}@company.example`);
  await page.click("#login-submit");
  await expect(page.locator("#login-error"), "the card says it is waiting").toHaveText(/Busy — retrying/, { timeout: 10000 });
  // Several refused token fetches, and still nothing posted.
  await expect.poll(() => tokenCalls, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  expect(posts, "no code request leaves while there is no token").toEqual([]);
  refuse = false;
  await page.locator("#sc-code").waitFor({ state: "visible", timeout: 20000 });
  expect(posts.length, "exactly one request once a token is issued").toBe(1);
  expect(posts[0], "…and it carries the token").not.toBe("");
});

// A SIGN-IN REPLACES THE SESSION, SO THE TOKEN IN HAND IS DEAD. When the fresh
// token fetch after the redeem was throttled, the client kept the pre-sign-in
// token, sent its first write (select-competition) with it, got 403
// csrf_invalid — which ends the brand-new session — and the polls that followed
// answered 401: in the 1000-user one-NAT storm those countable 4xx blocked the
// venue address. The door now drops the old token and waits for a real one.
test("after a code sign-in, a throttled token refresh never leaves the pre-sign-in token in hand", async ({ page }) => {
  const label = `adopt${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { keepState: true,
      headers: { "x-csrf-token": rc, "content-type": "application/json" },
      data: { firstName: "Ada", lastName: "Token", email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }

  let refuse = false, refusedAfterRedeem = 0;
  await page.route("**/api/csrf-token", async (route) => {
    if (refuse) { refusedAfterRedeem++; return route.fulfill({ status: 429, headers: { "Retry-After": "1", "Content-Type": "application/json" }, body: JSON.stringify({ error: "Too many requests" }) }); }
    return route.continue();
  });
  const csrf403 = [];
  page.on("response", async (rs) => {
    if (rs.status() === 403 && rs.request().method() !== "GET") {
      const t = await rs.text().catch(() => "");
      if (t.includes("csrf_invalid")) csrf403.push(rs.url());
    }
  });

  await page.goto("/");
  await page.locator("#login-email").waitFor({ state: "visible" });
  await page.fill("#login-email", email);
  await page.click("#login-submit");
  await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
  const before = await page.evaluate(() => window.csrfToken);
  expect(before, "PRECONDITION: the anonymous session's token is in hand").toBeTruthy();
  const code = (await (await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent(email))).json()).code;
  await page.fill("#sc-code", code);
  refuse = true;
  await page.click("#signin-code-overlay [data-action='signin-code-redeem']");

  await expect.poll(() => refusedAfterRedeem, { message: "the post-sign-in token fetch was refused", timeout: 10000 }).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => window.csrfToken), "the dead pre-sign-in token is dropped while no new one is issued").toBe("");

  refuse = false;
  await expect.poll(() => page.evaluate(() => window.csrfToken), { timeout: 20000 }).toBeTruthy();
  expect(await page.evaluate(() => window.csrfToken), "the token adopted is the new session's").not.toBe(before);
  expect(csrf403, "no write was refused for a dead token").toEqual([]);
});

// A SIGN-IN WHOSE TOKEN REFRESH GAVE UP leaves no token in hand
// (`adoptNewSessionToken` answers false). The next write must not leave with an
// EMPTY token: its 403 csrf_invalid would end the session the sign-in just made.
// It waits for a token the way a door does, and is not sent while there is none.
test("after a sign-in whose token refresh gave up, no write leaves without a token, and the session survives", async ({ page }) => {
  const label = `giveup${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { keepState: true,
      headers: { "x-csrf-token": rc, "content-type": "application/json" },
      data: { firstName: "Gave", lastName: "Up", email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }

  // A refusal that is not transient (400), so the refresh gives up at once
  // rather than after its ~60 s of back-off.
  let refuse = false, refused = 0;
  await page.route("**/api/csrf-token", async (route) => {
    if (refuse) { refused++; return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "refused" }) }); }
    return route.continue();
  });
  const keepalives = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/session/keepalive")) keepalives.push(r.headers()["x-csrf-token"] || ""); });

  await page.goto("/");
  await page.locator("#login-email").waitFor({ state: "visible" });
  await page.fill("#login-email", email);
  await page.click("#login-submit");
  await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
  const code = (await (await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent(email))).json()).code;
  await page.fill("#sc-code", code);
  refuse = true;
  await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 20000 });
  expect(refused, "PRECONDITION: the post-sign-in token fetch was refused").toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => window.csrfToken), "PRECONDITION: no token is in hand").toBe("");

  // A write the way the app sends one: through its fetch, with the token in hand
  // (csrfHeaders), which the interceptor re-stamps once one is issued.
  const write = () => page.evaluate(() => {
    window.__wStatus = null;
    fetch("/api/session/keepalive", { method: "POST", headers: { "X-CSRF-Token": window.csrfToken } })
      .then((r) => { window.__wStatus = r.status; }, () => { window.__wStatus = -1; });
  });
  await write();
  await expect.poll(async () => (keepalives.length ? "sent" : await page.evaluate(() => window.__wStatus)), { timeout: 15000 }).not.toBeNull();
  expect(keepalives, "no write left without a token").toEqual([]);
  expect(await page.evaluate(() => window.__wStatus), "the caller is told nothing was sent").toBe(503);
  expect((await page.request.get("/api/me")).status(), "the new session is alive").toBe(200);

  // CONTROL: once a token can be had, the same write fetches one and is sent with it.
  refuse = false;
  await write();
  await expect.poll(() => page.evaluate(() => window.__wStatus), { timeout: 15000 }).toBe(200);
  expect(keepalives.length).toBe(1);
  expect(keepalives[0], "the write carried the new session's token").not.toBe("");
});

// THE WAIT HAS A KNOWN END, AND THERE IS ONE OF IT. Seven asks with the back-off
// between them (1, 2, 4, 8, 15, 15 s, each ±25 %: ~45 s), and the answer comes
// at once after the seventh rather than after one more wait that asks nothing.
// Every caller that finds no token shares the one wait, so writes queued behind
// a throttled venue do not each ask for tokens of their own. The page's clock is
// driven by hand, step by step, so no real minute passes.
test("a token wait asks seven times, answers at once after the last, and is shared by every caller", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.locator("#login-email").waitFor({ state: "visible" });
  expect(await page.evaluate(() => typeof window.adoptNewSessionToken), "PRECONDITION: the api module is on window").toBe("function");
  await page.clock.pauseAt(Date.now() + 5000);

  let calls = 0;
  await page.route("**/api/csrf-token", (route) => {
    calls++;
    return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }) });
  });
  // Two callers at once: both must be answered by ONE wait.
  await page.evaluate(() => {
    window.__w1 = null; window.__w2 = null;
    window.adoptNewSessionToken().then((v) => { window.__w1 = v; });
    window.adoptNewSessionToken().then((v) => { window.__w2 = v; });
  });
  const answers = () => page.evaluate(() => [window.__w1, window.__w2]);
  for (let i = 0; i < 7; i++) {
    await expect.poll(() => calls, { message: `ask ${i + 1} was made`, timeout: 10000 }).toBeGreaterThanOrEqual(i + 1);
    if (i < 6) {
      expect(await answers(), `no answer before the last ask (after ask ${i + 1})`).toEqual([null, null]);
      await page.clock.runFor(Math.ceil(Math.min(15000, 1000 * 2 ** i) * 1.25) + 50);
    }
  }
  // No clock moves after the seventh refusal: an answer can only come at once.
  await expect.poll(answers, { message: "both callers are told no token could be had, with no further wait", timeout: 10000 }).toEqual([false, false]);
  expect(calls, "the two callers shared one wait: seven asks in all").toBe(7);
});

// The load test models this wait (perf/k6/scenarios/login-storm.js
// `ensureToken`), and its give-up time is what the storm reports, so the model
// must stop where the SPA stops: the same number of asks, and in both loops the
// last ask leaves BEFORE the wait. Source arms (k6 is not part of the suite);
// any `if (…the tries constant…) break` counts, comments stripped first.
test("the k6 login storm waits for a token as the SPA does: seven asks, no wait after the last (source)", () => {
  const fs = require("fs");
  const path = require("path");
  const { stripJsComments } = require("./doc-registry");
  const read = (rel) => stripJsComments(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
  // The `for` loop of the named function, to its matching brace.
  const loopOf = (src, head) => {
    const at = src.indexOf(head);
    expect(at, `PRECONDITION: ${head} is found`).toBeGreaterThan(-1);
    const start = src.indexOf("for (", at);
    const open = src.indexOf("{", start);
    let depth = 0, end = open;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    return src.slice(start, end + 1);
  };
  const spa = read("public/js/core/api.js");
  const k6 = read("perf/k6/scenarios/login-storm.js");
  expect(spa, "the SPA asks seven times").toMatch(/const _TOKEN_WAIT_TRIES = 7;/);
  expect(k6, "…and so does the model").toMatch(/const TOKEN_WAIT_TRIES = 7;/);
  const arms = [
    ["the SPA", loopOf(spa, "async function _waitForToken"), "_TOKEN_WAIT_TRIES", "setTimeout"],
    ["the k6 model", loopOf(k6, "function ensureToken"), "TOKEN_WAIT_TRIES", "sleep"],
  ];
  for (const [who, loop, tries, wait] of arms) {
    const lastAsk = loop.search(new RegExp(`if\\s*\\([^)]*\\b${tries}\\b[^)]*\\)\\s*break`));
    const waits = loop.search(new RegExp(`\\b${wait}\\(`));
    expect(waits, `PRECONDITION: ${who} waits between asks`).toBeGreaterThan(-1);
    expect(lastAsk, `${who}: the last ask leaves the loop`).toBeGreaterThan(-1);
    expect(lastAsk, `${who}: …before the wait, not after it`).toBeLessThan(waits);
  }
});

// THE SIGN-IN CARD'S WHOLE GIVE-UP. When every token ask is refused, the
// card's Continue waits through the seven asks, then gives up WITHOUT posting
// (a local 503 `csrf_unavailable`, never a tokenless request that the server
// would answer 403 and count against the venue address) and says the site is
// busy. The first test above is the control: a token that arrives is used for
// exactly one post.
test("the sign-in card gives up after seven refused token asks, sends nothing, and says the site is busy", async ({ page }) => {
  const { expectSpaBooted } = require("./ui-admin-helpers");
  await page.clock.install();
  let calls = 0;
  await page.route("**/api/csrf-token", (route) => {
    calls++;
    return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }) });
  });
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/auth/")) posts.push(new URL(r.url()).pathname); });
  await page.goto("/");
  await expectSpaBooted(page, "the login page");
  await page.locator("#login-email").waitFor({ state: "visible" });
  expect(await page.evaluate(() => window.csrfToken || ""), "PRECONDITION: no token is in hand").toBe("");
  await page.clock.pauseAt(Date.now() + 5000);

  const base = calls;
  await page.fill("#login-email", `giveup-card-${Date.now()}@company.example`);
  await page.click("#login-submit");
  await expect.poll(() => calls - base, { message: "the first ask was made", timeout: 10000 }).toBe(1);
  // Each later ask waits on a page timer armed only once the refusal has come
  // back, so the clock is stepped until the next ask is seen, never past it.
  for (let i = 1; i < 7; i++) {
    expect(posts, `nothing posted while waiting (after ask ${i})`).toEqual([]);
    await expect.poll(async () => { await page.clock.runFor(1000); return calls - base; },
      { message: `ask ${i + 1} was made`, timeout: 30000, intervals: [50] }).toBeGreaterThanOrEqual(i + 1);
  }
  // No clock moves after the seventh refusal: the give-up can only come at once.
  await expect(page.locator("#login-error"), "the card says the site is busy").toHaveText(/The site is busy right now/, { timeout: 10000 });
  // Seven asks by the wait (plus at most the one token refresh the card starts
  // after a busy answer); the wait's own count is held by the test above.
  expect(calls - base, "the wait made its seven asks").toBeGreaterThanOrEqual(7);
  expect(calls - base, "…and did not keep asking").toBeLessThanOrEqual(8);
  expect(posts, "no sign-in request left without a token").toEqual([]);
});
