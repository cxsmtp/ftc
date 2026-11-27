// @ts-check
//
// ONE BROWSER, ONE SESSION, ONE CSRF TOKEN PER TAB.
//
// Every tab of a browser shares the session cookie, but each holds its own CSRF
// token, and a token is bound to the session that issued it. When one tab
// REPLACED the session — a sign-in, the view switch, impersonation in or out, a
// password change — the other tabs kept the old session's token, and the server
// ends any session carrying an identity on a refused token: the stale tab's next
// write (its 30 s keepalive at the latest) signed out the session the other tab
// had just made. (CLAUDE.md recorded it as a known gap until this spec.)
//
// Each tab now publishes a fingerprint of every token it is issued (localStorage
// `ha:csrf-fp`), and a tab whose own token no longer matches re-syncs before a
// write leaves (core/api.js `ensureFreshCsrf`): a token for the live session only
// when that is the account it shows, acting as itself, in the view it shows, or
// when it shows nobody; otherwise it sends nothing more and says it is out of
// date.
//
// Two pages of ONE browser context share the cookie jar and localStorage, as two
// tabs do. Where an arm must isolate the check made before each write from the
// eager re-sync a `storage` event starts, the "other tab" is the context's own
// API client (no page, so nothing is published) and the arm publishes the new
// fingerprint from the stale tab itself: a page's own localStorage write fires
// no `storage` event in that page.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { expectSpaBooted, loginViaApi, fillBreakGlass, submitLogin } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");
const { makeAdmin } = require("./admin-inflight-helpers");

test.use({ baseURL: BASE });

const { OUT_OF_DATE, csrfEnds, booted, signedInTab, watchWrites, replaceByPasswordChange, publishFrom, keepalive } = require("./cross-tab-fixture");

/** The server's own answer to GET `path` sent with `cookie` alone (a raw request, no cookie jar). */
function rawGet(path, cookie) {
  const http = require("http");
  const u = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: { cookie } }, (resp) => {
      let body = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => { body += c; });
      resp.on("end", () => resolve({ status: resp.statusCode, contentType: resp.headers["content-type"], body }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("rawGet timed out")));
    req.end();
  });
}

/** A promise the test resolves itself: park a routed request, then act. */
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }

test.describe("a tab whose session another tab replaced", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  test("THE GAP: its write leaves with the live session's token, and the session the other tab made survives", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "xtab1");
    await signedInTab(page, p.email);
    const live = await replaceByPasswordChange(page, "Xtab-other-2026!");
    await publishFrom(page, live);
    const w = watchWrites(page);
    try {
      expect(await keepalive(page), "the stale tab's keepalive is answered, not refused").toBe(200);
    } finally { w.stop(); }
    expect(w.seen, "it was sent once, carrying the LIVE session's token").toEqual([{ path: "/api/session/keepalive", token: live }]);
    expect(await page.evaluate(() => window.csrfToken)).toBe(live);
    const st = await (await page.context().request.get("/api/session/status")).json();
    expect(st, "the replacement session is alive").toMatchObject({ active: true, user_id: p.id });
    expect(csrfEnds(p.id), "no session was ended for a refused token").toEqual([]);
  });

  test("CONTROL: the same stale token with nothing published is refused — and the refusal ends the live session", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "xtab1c");
    await signedInTab(page, p.email);
    await replaceByPasswordChange(page, "Xtab-other-2026!");
    // No publish: nothing tells this tab, which is the behaviour without storage.
    const w = watchWrites(page);
    const refusal = page.waitForResponse(r => new URL(r.url()).pathname === "/api/session/keepalive");
    // Fired, not awaited: the interceptor answers the refusal with its
    // never-settling sign-out.
    await page.evaluate(() => { fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }); });
    const r = await refusal;
    w.stop();
    expect(w.seen.map(s => s.path)).toEqual(["/api/session/keepalive"]);
    expect([r.status(), (await r.json()).error], "refused for its token").toEqual([403, "csrf_invalid"]);
    await expect.poll(() => csrfEnds(p.id).length, { message: "the refusal ended the session" }).toBe(1);
    expect((await (await page.context().request.get("/api/session/status")).json()).active, "the live session is gone").toBe(false);
  });

  test("a second tab of the same account: the stale tab takes the new token as soon as it is published, before it writes anything", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "xtab2");
    await signedInTab(page, p.email);
    const b = await page.context().newPage();
    try {
      await booted(b);
      const before = await page.evaluate(() => window.csrfToken);
      expect(await b.evaluate(() => window.csrfToken), "PRECONDITION: both tabs hold the one session's token").toBe(before);
      const w = watchWrites(page);
      try {
        // The other tab signs in again as the same account (an emailed code; the
        // session regenerates), then the token fetch its UI makes.
        const live = await b.evaluate(async ({ email }) => {
          const H = () => window.csrfHeaders({ "Content-Type": "application/json" });
          const rq = await fetch("/api/auth/code/request", { method: "POST", headers: H(), body: JSON.stringify({ email }) });
          if (!rq.ok) throw new Error(`code request ${rq.status}`);
          const { code } = await (await fetch("/api/test/last-login-code?email=" + encodeURIComponent(email))).json();
          const r = await fetch("/api/auth/code/redeem", { method: "POST", headers: H(), body: JSON.stringify({ email, code }) });
          const d = await r.json();
          if (!d.ok) throw new Error(`redeem ${r.status}`);
          await window.loadCsrfToken();
          return window.csrfToken;
        }, { email: p.email });
        expect(live).not.toBe(before);
        await expect.poll(() => page.evaluate(() => window.csrfToken), { message: "the stale tab re-synced on its own" }).toBe(live);
        expect(w.seen, "…without sending a single write").toEqual([]);
        expect(await keepalive(page)).toBe(200);
        expect(await keepalive(b), "the other tab is still signed in").toBe(200);
      } finally { w.stop(); }
      expect(csrfEnds(p.id)).toEqual([]);
    } finally { await b.close(); }
  });

  test("a read that left on the session another tab then replaced comes back 401: the tab stays signed in and re-syncs; after a real sign-out the same answer signs it out (control)", async ({ page }) => {
    // v9.2.5 — the flake this holds (the full suite, 22 Nov 2026: the keepalive
    // above never settled). Tabs share the cookie, so when another tab signs in
    // again the session regenerates under a read this tab already sent: the
    // server answers that read 401 "Not authenticated" (its session is gone),
    // and the interceptor took it for a sign-out of the browser, announcing
    // "Signed out" and halting the tab while the browser was signed in. The
    // read's answer here is the server's own, for this tab's old session.
    const p = await makeParticipant(sa, saCsrf, "xtab401");
    await signedInTab(page, p.email);
    const sid = (await page.context().cookies()).find((c) => c.name === "connect.sid");
    expect(sid, "PRECONDITION: the tab holds a session cookie").toBeTruthy();
    // Another tab signs in again as the same account: the session regenerates.
    const live = await replaceByPasswordChange(page);
    const stale = await rawGet("/api/my-competitions", `connect.sid=${sid.value}`);
    expect([stale.status, JSON.parse(stale.body).error], "PRECONDITION: the server refuses a read on the replaced session")
      .toEqual([401, "Not authenticated"]);
    const answerStale = (route) => route.fulfill({ status: stale.status, contentType: stale.contentType, body: stale.body });

    await page.route("**/api/my-competitions", answerStale, { times: 1 });
    // A tab that signs itself out answers every request with a promise that
    // never settles: bound the wait, so that failure says so at once.
    expect(await page.evaluate(() => Promise.race([fetch("/api/my-competitions").then((r) => r.status),
      new Promise((r) => setTimeout(() => r("never answered: the tab signed itself out"), 5000))])),
    "the refusal goes back to the read").toBe(401);
    expect(await page.evaluate(() => ({ halted: !!window.S._pollsHalted, announced: !!window.S._signoutAnnounced })),
      "the tab did not sign itself out").toEqual({ halted: false, announced: false });
    expect(await page.evaluate(() => window.csrfToken), "it re-synced to the live session's token").toBe(live);
    expect(await keepalive(page), "and writes with it").toBe(200);
    expect(csrfEnds(p.id)).toEqual([]);

    // CONTROL: the session really ended. The same answer now signs the tab out.
    const out = await page.context().request.post("/api/logout", { headers: H(live) });
    expect(out.ok(), `sign-out: ${out.status()}`).toBeTruthy();
    await page.route("**/api/my-competitions", answerStale, { times: 1 });
    await page.evaluate(() => { fetch("/api/my-competitions").catch(() => {}); });
    await expect.poll(() => page.evaluate(() => !!window.S._pollsHalted && !!window.S._signoutAnnounced),
      { message: "CONTROL: a refusal on a session that really ended still signs the tab out" }).toBe(true);
  });

  test("another tab switched to Participant View: the admin tab says it is out of date, sends nothing, and Reload opens the view now in force", async ({ page }) => {
    const admin = await makeAdmin(sa, saCsrf, "xtab3");
    await signedInTab(page, admin.email);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20_000 });
    const b = await page.context().newPage();
    try {
      await booted(b);
      await expect(b.locator("#admin-page")).toBeVisible({ timeout: 20_000 });
      const w = watchWrites(page);
      try {
        await b.evaluate(() => window.toggleAdminView(false));
        await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText(OUT_OF_DATE, { timeout: 10_000 });
        expect(await page.evaluate(() => window._sessionOutOfDate)).toBe(true);
        // A write attempted now is never sent, and never settles.
        await page.evaluate(() => { window.__xtabWrite = fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status); });
        expect(await page.evaluate(() => Promise.race([window.__xtabWrite, new Promise(r => setTimeout(() => r("pending"), 500))]))).toBe("pending");
        expect(w.seen, "nothing left the out-of-date tab").toEqual([]);
      } finally { w.stop(); }
      const st = await (await page.context().request.get("/api/session/status")).json();
      expect(st, "the other tab's participant view is untouched").toMatchObject({ active: true, user_id: admin.id, admin_view: false });
      expect(csrfEnds(admin.id)).toEqual([]);
      await page.locator("#modal-confirm-btn").click();
      await expect.poll(() => page.evaluate(() => !!window.csrfToken && window.isAdminView === false && !!(window.currentUser && window.currentUser.id)), { timeout: 20_000 }).toBe(true);
      await expect(page.locator("#admin-page")).toBeHidden();
    } finally { await b.close(); }
  });

  test("another tab signed in as SOMEBODY ELSE: nothing this tab sends is saved under that account", async ({ page }) => {
    const x = await makeParticipant(sa, saCsrf, "xtab4x");
    const y = await makeParticipant(sa, saCsrf, "xtab4y");
    await signedInTab(page, x.email);
    const b = await page.context().newPage();
    // B boots SIGNED IN as X (the jar is shared), and the app never asks a
    // signed-in tab to sign in: here B's own session monitor sent a keepalive
    // with X's token that reached the server just AFTER B's sign-in as Y, was
    // refused, and the refusal ended Y's session (the CSRF rule), so this tab
    // was told "signed out" — 1 run in ~150 at 24 workers, on main too. So B
    // finishes booting, its monitor is stopped and its writes have landed
    // before it signs in.
    const bWrites = new Set();
    b.on("request", (q) => { if (q.method() !== "GET" && q.method() !== "HEAD") bWrites.add(q); });
    const landed = (q) => bWrites.delete(q);
    b.on("requestfinished", landed); b.on("requestfailed", landed);
    try {
      await booted(b);
      // Booted means signed in as X with the monitor's first tick done (its
      // keepalive leaves only after its status read): `booted` returns at the
      // first token, before boot has finished.
      await expect.poll(() => b.evaluate(() => !!(window.currentUser && window.currentUser.id)), { timeout: 20_000 }).toBe(true);
      await b.waitForLoadState("networkidle");
      await b.evaluate(() => window.stopSessionMonitor());
      await expect.poll(() => bWrites.size, { message: "PRECONDITION: B has no write in flight before it signs in" }).toBe(0);
      const w = watchWrites(page);
      try {
        await b.evaluate(async ({ email }) => {
          const H = () => window.csrfHeaders({ "Content-Type": "application/json" });
          const rq = await fetch("/api/auth/code/request", { method: "POST", headers: H(), body: JSON.stringify({ email }) });
          if (!rq.ok) throw new Error(`code request ${rq.status}`);
          const { code } = await (await fetch("/api/test/last-login-code?email=" + encodeURIComponent(email))).json();
          const r = await fetch("/api/auth/code/redeem", { method: "POST", headers: H(), body: JSON.stringify({ email, code }) });
          const d = await r.json();
          if (!d.ok) throw new Error(`login ${r.status}`);
          await window.loadCsrfToken();
        }, { email: y.email });
        await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText(OUT_OF_DATE, { timeout: 10_000 });
        await page.evaluate(() => { window.__xtabWrite = fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status); });
        expect(await page.evaluate(() => Promise.race([window.__xtabWrite, new Promise(r => setTimeout(() => r("pending"), 500))]))).toBe("pending");
        expect(w.seen).toEqual([]);
      } finally { w.stop(); }
      const st = await (await page.context().request.get("/api/session/status")).json();
      expect(st, "the other tab's sign-in stands").toMatchObject({ active: true, user_id: y.id });
      expect(csrfEnds(y.id)).toEqual([]);
    } finally { await b.close(); }
  });

  test("the session's owner cannot be learnt: nothing is sent, the caller is told, and the next write re-syncs", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "xtab5");
    await signedInTab(page, p.email);
    const live = await replaceByPasswordChange(page, "Xtab-other-2026!");
    await publishFrom(page, live);
    await page.route("**/api/session/status", (r) => r.abort());
    const w = watchWrites(page);
    let refused;
    try {
      refused = await page.evaluate(() => fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(async r => ({ status: r.status, body: await r.json() })));
    } finally { await page.unroute("**/api/session/status"); }
    expect(refused).toEqual({ status: 503, body: { error: "Could not check this tab's session with the server, so nothing was sent. Please try again." } });
    expect(w.seen, "not sent").toEqual([]);
    expect(await keepalive(page), "once the server answers, the write goes through").toBe(200);
    w.stop();
    expect(w.seen).toEqual([{ path: "/api/session/keepalive", token: live }]);
    expect(csrfEnds(p.id)).toEqual([]);
  });

  test("a tab left on the sign-in page after another tab signed in: its sign-in goes through first time, with no refused token", async ({ page }) => {
    const x = await makeParticipant(sa, saCsrf, "xtab6x");
    const y = await makeParticipant(sa, saCsrf, "xtab6y");
    await booted(page);
    await expectSpaBooted(page, "the login page");
    expect(await page.evaluate(() => !window.currentUser && !window.isAdmin)).toBe(true);
    // Another tab signs in as X on the anonymous session this tab's token belongs to.
    const other = page.context().request;
    const anonToken = await page.evaluate(() => window.csrfToken);
    const li = await codeLogin(other, x.email, H(anonToken));
    expect(li.ok(), `the other tab's sign-in: ${li.status()}`).toBeTruthy();
    const live = (await (await other.get("/api/csrf-token")).json()).csrfToken;
    await publishFrom(page, live);
    const logins = [];
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/auth/code/redeem") logins.push(r.status()); });
    await page.locator("#login-email").fill(y.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);
    await expect.poll(() => page.evaluate(() => window.currentUser && window.currentUser.id), { timeout: 20_000 }).toBe(y.id);
    expect(logins, "one sign-in, answered — never refused for its token").toEqual([200]);
    expect(csrfEnds(x.id), "the other tab's session was replaced by a sign-in, not ended by a refusal").toEqual([]);
  });
});

test.describe("a tab replacing its OWN session never sends a write with the token it is replacing", () => {
  // The view switch (and impersonation in or out, a password change or first
  // password) regenerates the session. A write of the same tab that reached the
  // server after it with the old token was refused, and the refusal ended the
  // NEW session: the session monitor's keepalive racing a view switch did it.
  // Each arm holds one request with page.route, so the order is the arm's.
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  test("a write already on its way is let finish BEFORE the switch is sent", async ({ page }) => {
    const admin = await makeAdmin(sa, saCsrf, "xtab7");
    await signedInTab(page, admin.email);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20_000 });
    await page.route("**/api/session/keepalive", async (route) => { await sleep(1500); await route.continue(); });
    const at = {};
    page.on("response", (r) => { const pth = new URL(r.url()).pathname; if (pth === "/api/session/keepalive") at.kaAnswered = Date.now(); });
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/toggle-admin-view") at.toggleSent = Date.now(); });
    await page.evaluate(() => { window.__ka = fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status); });
    await page.evaluate(() => window.toggleAdminView(false));
    expect(await page.evaluate(() => window.__ka), "the write in flight was answered on the session it was made for").toBe(200);
    expect(at.toggleSent, "the switch was sent only once that write had been answered").toBeGreaterThanOrEqual(at.kaAnswered);
    const st = await (await page.context().request.get("/api/session/status")).json();
    expect(st, "the switched session survives").toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("a write started after the switch was sent waits for the new token, and leaves with it", async ({ page }) => {
    const admin = await makeAdmin(sa, saCsrf, "xtab8");
    await signedInTab(page, admin.email);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20_000 });
    let holdToken = false;
    await page.route("**/api/csrf-token", async (route) => { if (holdToken) await sleep(1500); await route.continue(); });
    const old = await page.evaluate(() => window.csrfToken);
    const toggled = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/toggle-admin-view");
    holdToken = true;
    await page.evaluate(() => { window.__tog = window.toggleAdminView(false); });
    expect((await toggled).status(), "PRECONDITION: the session was replaced").toBe(200);
    const w = watchWrites(page);
    const status = await page.evaluate(() => Promise.race([
      fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status),
      new Promise(r => setTimeout(() => r("never answered"), 8000)),
    ]));
    w.stop();
    const fresh = await page.evaluate(() => window.csrfToken);
    expect(fresh, "PRECONDITION: the switch's token arrived").not.toBe(old);
    expect(status).toBe(200);
    const kas = w.seen.filter(x => x.path === "/api/session/keepalive");
    expect(kas.length, "sent").toBeGreaterThanOrEqual(1);
    expect(kas.map(x => x.token), "every keepalive (the monitor's own may join) carried the NEW session's token").toEqual(kas.map(() => fresh));
    const st = await (await page.context().request.get("/api/session/status")).json();
    expect(st).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });
});



test.describe("the hold, door by door (v8.14.2 review, round 2)", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function adminTab(page, label) {
    const admin = await makeAdmin(sa, saCsrf, label);
    await signedInTab(page, admin.email);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20_000 });
    return admin;
  }

  test("doors run one at a time: a second view switch waits for the first one's new token, and is sent with it", async ({ page }) => {
    const admin = await adminTab(page, "xtab12");
    let holdToken = false;
    await page.route("**/api/csrf-token", async (route) => { if (holdToken) await sleep(1500); await route.continue(); });
    const sent = [];
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/toggle-admin-view") sent.push({ at: Date.now(), token: q.headers()["x-csrf-token"] }); });
    let tokenAt = 0;
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/csrf-token") tokenAt = Date.now(); });
    const first = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/toggle-admin-view");
    holdToken = true;
    await page.evaluate(() => { window.__t1 = window._sessionTransitionPost("/api/toggle-admin-view", { mode: "participant" }).then(r => r && r.status); });
    expect((await first).status()).toBe(200);
    // The second press lands while the first one's token is still on its way.
    await page.evaluate(() => { window.__t2 = window._sessionTransitionPost("/api/toggle-admin-view", { mode: "admin" }).then(r => r && r.status); });
    // The first press's own caller fetches the token (here, by hand).
    await page.evaluate(() => window.loadCsrfToken());
    expect(await page.evaluate(() => window.__t2)).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1].at, "the second door left only after the first door's token arrived").toBeGreaterThanOrEqual(tokenAt);
    expect(sent[1].token, "…carrying that new token").not.toBe(sent[0].token);
    expect((await (await page.context().request.get("/api/session/status")).json())).toMatchObject({ active: true, user_id: admin.id });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("a door whose new token never comes: past the limit, a held write is not sent with the dead token", async ({ page }) => {
    test.setTimeout(90_000);
    const admin = await adminTab(page, "xtab13");
    let refuseToken = false;
    await page.route("**/api/csrf-token", async (route) => {
      if (refuseToken) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }) });
      return route.continue();
    });
    const switched = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/toggle-admin-view");
    refuseToken = true;
    await page.evaluate(() => { window._sessionTransitionPost("/api/toggle-admin-view", { mode: "participant" }).then(() => window.loadCsrfToken()); });
    expect((await switched).status(), "PRECONDITION: the session was replaced").toBe(200);
    const w = watchWrites(page);
    const answer = await page.evaluate(() => fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(async r => ({ status: r.status, body: await r.json() })));
    w.stop();
    expect(answer.status, "held past the limit, then refused here rather than sent").toBe(503);
    expect(w.seen, "nothing left with the dead token").toEqual([]);
    expect((await (await page.context().request.get("/api/session/status")).json()), "the switched session survives").toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
    refuseToken = false;
    expect(await page.evaluate(() => fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status)), "once a token can be had, writes go again").toBe(200);
  });

  test("a write that was waiting on a token check when a door started is held for that door, and leaves after it", async ({ page }) => {
    const admin = await adminTab(page, "xtab14");
    // Another tab of the same account replaced the session; this tab has heard.
    const live = await replaceByPasswordChange(page, "Xtab-wait-2026!");
    await publishFrom(page, live);
    const statusGate = gate();
    await page.route("**/api/session/status", async (route) => { await statusGate.p; await route.continue(); });
    const at = {};
    page.on("request", (q) => { const pth = new URL(q.url()).pathname; if (pth === "/api/session/keepalive") { at.ka = Date.now(); at.kaToken = q.headers()["x-csrf-token"]; } });
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/csrf-token") at.token = Date.now(); });
    const parked = page.waitForRequest((q) => new URL(q.url()).pathname === "/api/session/status");
    await page.evaluate(() => { window.__w = fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status); });
    await parked;   // the write is inside its re-sync, parked on the probe
    await page.evaluate(() => { window.__sw = window.toggleAdminView(false).then(() => true); });
    statusGate.open();
    expect(await page.evaluate(() => window.__sw)).toBe(true);
    expect(await page.evaluate(() => window.__w)).toBe(200);
    expect(at.ka, "the write left only after the switch's token arrived").toBeGreaterThanOrEqual(at.token);
    expect(at.kaToken, "…carrying it").toBe(await page.evaluate(() => window.csrfToken));
    expect((await (await page.context().request.get("/api/session/status")).json())).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("a door re-checks the token AFTER waiting for writes in flight: a session another tab replaced meanwhile is re-synced first", async ({ page }) => {
    const admin = await adminTab(page, "xtab15");
    // A write the server has already answered, still in flight for this tab. Its
    // answer is delivered without its Set-Cookie: held here past the session
    // change it predates, that cookie would put the replaced session back in the
    // jar — an artefact of holding it, since the server stops sending a cookie
    // for a replaced session (`_dropRevokedSessionCookie`) once it is replaced.
    const kaGate = gate();
    let served = null;
    const servedP = new Promise((r) => { served = r; });
    await page.route("**/api/session/keepalive", async (route) => {
      const resp = await route.fetch();
      served();
      const headers = { ...resp.headers() };
      delete headers["set-cookie"];
      const body = await resp.body();
      await kaGate.p;
      await route.fulfill({ status: resp.status(), headers, body });
    });
    await page.evaluate(() => { window.__ka = fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status); });
    await servedP;   // the server has answered it; the tab is still waiting
    let switchSent = false;
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/toggle-admin-view") switchSent = true; });
    await page.evaluate(() => { window.__sw = window.toggleAdminView(false).then(() => true); });
    // While the door waits for that write, another tab of this account replaces the session.
    const live = await replaceByPasswordChange(page, "Xtab-meanwhile-2026!");
    await publishFrom(page, live);
    expect(switchSent, "PRECONDITION: the switch is still waiting for the write in flight").toBe(false);
    kaGate.open();
    expect(await page.evaluate(() => window.__sw)).toBe(true);
    expect(await page.evaluate(() => window.__ka)).toBe(200);
    expect((await (await page.context().request.get("/api/session/status")).json()), "the switch was made on the re-synced session").toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("readyToWrite waits out this tab's own session change", async ({ page }) => {
    await adminTab(page, "xtab16");
    let holdToken = false;
    await page.route("**/api/csrf-token", async (route) => { if (holdToken) await sleep(1500); await route.continue(); });
    let tokenAt = 0;
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/csrf-token") tokenAt = Date.now(); });
    const switched = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/toggle-admin-view");
    holdToken = true;
    await page.evaluate(() => { window.toggleAdminView(false); });
    await switched;
    const t0 = Date.now();
    expect(await page.evaluate(() => window.readyToWrite())).toBe(true);
    const tDone = Date.now();
    expect(tokenAt, "the token arrived").toBeGreaterThan(t0);
    expect(tDone, "readyToWrite answered only after it").toBeGreaterThanOrEqual(tokenAt);
  });

  test("three presses while the first one's token is on its way: each door leaves after the previous one's token, with it", async ({ page }) => {
    const admin = await adminTab(page, "xtab17");
    let holdToken = false;
    await page.route("**/api/csrf-token", async (route) => { if (holdToken) await sleep(800); await route.continue(); });
    const sent = [], tokens = [];
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/toggle-admin-view") sent.push({ at: Date.now(), token: q.headers()["x-csrf-token"] }); });
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/csrf-token") tokens.push(Date.now()); });
    const answer = (n) => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/toggle-admin-view" && sent.length >= n);
    holdToken = true;
    let a = answer(1);
    await page.evaluate(() => { window.__d1 = window._sessionTransitionPost("/api/toggle-admin-view", { mode: "participant" }).then(r => r && r.status); });
    await a;
    await page.evaluate(() => {
      window.__d2 = window._sessionTransitionPost("/api/toggle-admin-view", { mode: "admin" }).then(r => r && r.status);
      window.__d3 = window._sessionTransitionPost("/api/toggle-admin-view", { mode: "participant" }).then(r => r && r.status);
    });
    a = answer(2);
    await page.evaluate(() => window.loadCsrfToken());
    await a;
    a = answer(3);
    await page.evaluate(() => window.loadCsrfToken());
    await a;
    await page.evaluate(() => window.loadCsrfToken());
    expect(await page.evaluate(() => Promise.all([window.__d1, window.__d2, window.__d3]))).toEqual([200, 200, 200]);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map(x => x.token)).size, "three doors, three tokens").toBe(3);
    expect(sent[1].at).toBeGreaterThanOrEqual(tokens[tokens.length - 3]);
    expect(sent[2].at).toBeGreaterThanOrEqual(tokens[tokens.length - 2]);
    expect((await (await page.context().request.get("/api/session/status")).json())).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("a token REQUESTED before a door was sent is never adopted, even when its answer arrives after: the hold waits for the door's own", async ({ page }) => {
    const admin = await adminTab(page, "xtab18");
    const early = gate(), late = gate(), earlyServed = gate();
    let n = 0;
    await page.route("**/api/csrf-token", async (route) => {
      n++;
      if (n === 1) {   // answered by the server NOW (the session about to be replaced), delivered later
        const resp = await route.fetch();
        earlyServed.open();
        const headers = { ...resp.headers() }; delete headers["set-cookie"];
        const body = await resp.body();
        await early.p;
        return route.fulfill({ status: resp.status(), headers, body });
      }
      await late.p;
      return route.continue();
    });
    const served = page.waitForRequest((q) => new URL(q.url()).pathname === "/api/csrf-token");
    await page.evaluate(() => { window.__early = window.loadCsrfToken(); });
    await served;
    // The SERVER must have answered it before the switch, as the arm says. The
    // route handler runs in this process, and under load it ran after the switch
    // had replaced the session: the server then minted an anonymous session for
    // the dead cookie, and `route.fetch()` — which shares the context's cookie
    // jar — put that cookie over the switch's, so every later request was
    // anonymous and the held write "never answered" (1 run in ~500 at 48 workers).
    await earlyServed.p;
    const old = await page.evaluate(() => window.csrfToken);
    const switched = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/toggle-admin-view");
    await page.evaluate(() => { window.toggleAdminView(false); });
    expect((await switched).status()).toBe(200);
    early.open();
    await page.evaluate(() => window.__early);
    expect(await page.evaluate(() => window.csrfToken), "the early answer was not adopted").toBe(old);
    const kaTok = [];
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/session/keepalive") kaTok.push(q.headers()["x-csrf-token"]); });
    await page.evaluate(() => { window.__ka = Promise.race([fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status), new Promise(r => setTimeout(() => r("never answered"), 10000))]); });
    await sleep(300);
    expect(kaTok, "the write is still held").toEqual([]);
    late.open();
    expect(await page.evaluate(() => window.__ka)).toBe(200);
    const fresh = await page.evaluate(() => window.csrfToken);
    expect(fresh).not.toBe(old);
    expect(kaTok.every(t => t === fresh), "it left with the door's own token").toBe(true);
    expect((await (await page.context().request.get("/api/session/status")).json())).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("a token requested WHILE a door is in flight (the old cookie still in the jar) is never adopted either", async ({ page }) => {
    const admin = await adminTab(page, "xtab20");
    const doorGate = gate();
    let served = null; const servedP = new Promise((r) => { served = r; });
    await page.route("**/api/toggle-admin-view", async (route) => {
      const resp = await route.fetch();   // the server has replaced the session…
      served();
      await doorGate.p;                   // …and the tab has not heard yet
      await route.fulfill({ response: resp });
    });
    const old = await page.evaluate(() => window.csrfToken);
    await page.evaluate(() => { window.__sw = window.toggleAdminView(false).then(() => true); });
    await servedP;
    // A token fetched now carries the old cookie: whatever it is answered with
    // belongs to no session this tab may write with.
    await page.evaluate(() => window.loadCsrfToken());
    expect(await page.evaluate(() => window.csrfToken), "the in-flight answer was not adopted").toBe(old);
    const kaTok = [];
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/session/keepalive") kaTok.push(q.headers()["x-csrf-token"]); });
    await page.evaluate(() => { window.__ka = Promise.race([fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status), new Promise(r => setTimeout(() => r("never answered"), 10000))]); });
    await sleep(300);
    expect(kaTok, "the write is still held").toEqual([]);
    doorGate.open();
    expect(await page.evaluate(() => window.__sw)).toBe(true);
    expect(await page.evaluate(() => window.__ka)).toBe(200);
    const fresh = await page.evaluate(() => window.csrfToken);
    expect(fresh).not.toBe(old);
    expect(kaTok.length).toBeGreaterThanOrEqual(1);
    expect(kaTok.every(t => t === fresh), "it left with the switched session's token").toBe(true);
    expect((await (await page.context().request.get("/api/session/status")).json())).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
    expect(csrfEnds(admin.id)).toEqual([]);
  });

  test("a write that waited on the impersonation confirm asks again after it: a session Exit replaced meanwhile is not written with the old token", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "xtab19");
    await loginViaApi(page, "superadmin", getSuperadminPass());
    const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const imp = await page.request.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(c), data: { view: "participant" } });
    expect(imp.ok(), `impersonate: ${await imp.text()}`).toBeTruthy();
    await booted(page);
    await expect.poll(() => page.evaluate(() => !!(window.impersonation && window.impersonation.superadmin)), { timeout: 20_000 }).toBe(true);
    // The participant view's polls would meet the built-in session after Exit and
    // announce a sign-out over the confirm: stop them, this arm is about one write.
    // _stopAllPolls also halts the tab for good (as after a sign-out, the
    // interceptor then sends nothing); this arm still writes, so lift the halt.
    await page.evaluate(() => { window._stopAllPolls(); window.stopCompDataPoll(); window._pollsHalted = false; });
    const tok = [];
    // A harmless write that meets the confirm (the witness is the token it carries).
    page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/test/rate-limit-sweep") tok.push(q.headers()["x-csrf-token"]); });
    await page.evaluate(() => { window.__w = fetch("/api/test/rate-limit-sweep", { method: "POST", headers: window.csrfHeaders({ "Content-Type": "application/json" }), body: "{}" }).then(r => r.status); });
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Impersonation mode", { timeout: 10_000 });
    // Exit, which does not share that confirm, replaces the session meanwhile.
    expect(await page.evaluate(() => window._sessionTransitionPost("/api/impersonation/exit").then(r => r && r.status))).toBe(200);
    await page.evaluate(() => window.loadCsrfToken());
    const fresh = await page.evaluate(() => window.csrfToken);
    await expect(page.locator("#modal-overlay.open #modal-title"), "PRECONDITION: the confirm is still the one open").toHaveText("Impersonation mode");
    await page.locator("#modal-confirm-btn").click();
    await page.evaluate(() => window.__w);
    expect(tok, "the write left once, with the token of the session Exit made").toEqual([fresh]);
    expect((await (await page.context().request.get("/api/session/status")).json()), "the superadmin's own session survives").toMatchObject({ active: true, role: "superadmin" });
    // The page's built-in sign-in ended this describe's own superadmin client
    // (one session per principal): sign it back in for the arms after this one.
    await sa.dispose();
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  });
});

test.describe("every write that bypasses the interceptor asks readyToWrite (or is a session-replacing door)", () => {
  test("source: each _origFetch write and XMLHttpRequest in public/js sits with its question", () => {
    const fs = require("fs");
    const path = require("path");
    // Comments blanked, LINE NUMBERS KEPT (the doc-registry stripper's pattern):
    // a reported site must be the line to open.
    const blankComments = (raw) => raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g,
      (m, pre) => (pre === undefined ? "" : pre) + m.slice(pre === undefined ? 0 : pre.length).replace(/[^\n]/g, " "));
    const code = (t) => t.replace(/\s+/g, " ");
    const ROOT = path.join(__dirname, "..", "public", "js");
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
    walk(ROOT);
    // Decided per site, never per file: the interceptor's own POST after a
    // refused token follows a session that refusal has already ended.
    const EXEMPT_SITES = [{ file: path.join("core", "api.js"), before: /if \(d\.error === 'csrf_invalid'\) \{\s*$/ }];
    const sites = [], bad = [], exempted = [];
    const scan = (rel, raw, out) => {
      const src = blankComments(raw);
      // `await ready()` counts only where this file's `ready` is the closure
      // that asks readyToWrite (the sign-out's).
      const readyAsks = /const ready\s*=\s*async\s*\(\)\s*=>\s*\{[^}]*readyToWrite\(/.test(src);
      const re = new RegExp("_origFetch(?:\\.(?:call|apply))?\\(|new XMLHttp" + "Request\\(", "g");
      // Each site answers for itself: its own question between the previous
      // write site and it (at most 600 characters of CODE back — comments and
      // whitespace do not count), and registration as in flight right at it
      // (`trackInflightWrite(` in the last 120 characters of code); or it is
      // the `const <name> = () =>` closure the file hands to
      // `sendReplacingSession(`, which does both.
      let m, prevEnd = 0;
      while ((m = re.exec(src))) {
        const call = src.slice(m.index, m.index + 300);
        const isWrite = m[0].startsWith("new") || /method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(call);
        if (!isWrite) continue;
        const span = code(src.slice(prevEnd, m.index));
        const before = span.slice(-600);
        const closure = /const\s+(\w+)\s*=\s*\(\)\s*=>\s*$/.exec(src.slice(Math.max(0, m.index - 80), m.index));
        const site = `${rel}@${src.slice(0, m.index).split("\n").length}`;
        prevEnd = m.index + m[0].length;
        if (EXEMPT_SITES.some(e => e.file === rel && e.before.test(src.slice(Math.max(0, m.index - 120), m.index)))) { out.exempted.push(site); continue; }
        out.sites.push(site);
        const asked = /\breadyToWrite\(/.test(before) || (readyAsks && /\bawait ready\(\)/.test(before));
        const tracked = /\btrackInflightWrite\(/.test(span.slice(-120));
        const door = closure && src.includes(`sendReplacingSession(${closure[1]})`);
        if (!door && !(asked && tracked)) out.bad.push(`${site}${asked ? "" : " (asks nothing)"}${tracked ? "" : " (not tracked in flight)"}`);
      }
    };
    for (const f of files) scan(path.relative(ROOT, f), fs.readFileSync(f, "utf8"), { sites, bad, exempted });
    // PLANTED CONTROLS: a site with neither, one whose `await ready()` is some
    // other `ready`, and the accepted shape — the scanner tells them apart.
    const planted = { sites: [], bad: [], exempted: [] };
    scan("planted.js", [
      "async function a(){ await _origFetch('/x',{method:'POST'}); }",
      "const ready=async()=>{ return document.fonts.ready; };",
      "async function b(){ await ready(); await trackInflightWrite(_origFetch('/y',{method:'POST'})); }",
    ].join("\n"), planted);
    expect(planted.bad.map(x => x.replace(/@\d+/, "")), "the planted bad sites are caught").toEqual(["planted.js (asks nothing) (not tracked in flight)", "planted.js (asks nothing)"]);
    const good = { sites: [], bad: [], exempted: [] };
    scan("good.js", "async function c(){ if(!(await readyToWrite()))return; await trackInflightWrite(_origFetch('/z',{method:'POST'})); }", good);
    expect(good, "…and the accepted shape passes").toEqual({ sites: ["good.js@1"], bad: [], exempted: [] });
    expect(sites.length, `anti-vacuity: the known bypassing writes were found: ${sites.join(", ")}`).toBeGreaterThanOrEqual(4);
    expect(exempted.length, "each exemption still names a live site").toBe(EXEMPT_SITES.length);
    expect(bad, "a write that bypasses the interceptor must wait out this tab's session change and check another tab's (readyToWrite) and register in flight (trackInflightWrite), or be a door that replaces the session (sendReplacingSession)").toEqual([]);
    // The interceptor's own retry after the profile gate passes a variable init,
    // so the loop above cannot class it: pinned by name. The gate can stay open
    // for minutes and can itself set a first password.
    const api = blankComments(fs.readFileSync(path.join(ROOT, "core", "api.js"), "utf8"));
    const at = api.indexOf("_origFetch.apply(this, retryArgs)");
    expect(at, "the profile-gate retry is still where this pin looks").toBeGreaterThan(0);
    const lead = code(api.slice(Math.max(0, at - 700), at));
    expect(lead, "the retry asks readyToWrite").toMatch(/readyToWrite\(\)/);
    expect(lead.slice(-60), "the retry is registered in flight").toMatch(/trackInflightWrite\($/);
  });
});

test.describe("GET /api/session/status says which view a live session is in", () => {
  test("admin_view: a participant false, an admin true and false after switching, the built-in superadmin true, nobody false", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      expect(await (await sa.get("/api/session/status")).json()).toMatchObject({ active: true, user_id: null, admin_view: true });
      const p = await makeParticipant(sa, saCsrf, "xtabv");
      const admin = await makeAdmin(sa, saCsrf, "xtabva");
      const { signIn } = require("./admin-inflight-helpers");
      const pp = await signIn(p.email, PARTICIPANT_PASS);
      expect(await (await pp.api.get("/api/session/status")).json()).toMatchObject({ active: true, user_id: p.id, admin_view: false });
      const ap = await signIn(admin.email, PARTICIPANT_PASS);
      expect(await (await ap.api.get("/api/session/status")).json()).toMatchObject({ active: true, user_id: admin.id, admin_view: true });
      const t = await ap.api.post("/api/toggle-admin-view", { headers: H(ap.csrf), data: { mode: "participant" } });
      expect(t.ok(), await t.text()).toBeTruthy();
      expect(await (await ap.api.get("/api/session/status")).json()).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
      await pp.api.post("/api/logout", { headers: H(pp.csrf) });
      expect(await (await pp.api.get("/api/session/status")).json()).toMatchObject({ active: false, admin_view: false });
      await pp.api.dispose(); await ap.api.dispose();
    } finally { await sa.dispose(); }
  });
});
