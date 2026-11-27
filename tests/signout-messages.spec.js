// @ts-check
//
// WHAT A SIGNED-OUT TAB SAYS, for two causes that used to read wrong
// (operator rulings, 21 Oct 2026):
//
//   • Signing out in one tab ended the session every other tab of the browser
//     held, and those tabs, finding it gone with no reason recorded, said
//     "signed out due to inactivity" to somebody who had just pressed Sign out.
//     The tab that signs out now leaves the fingerprint of the session's token in
//     the browser's storage, and a tab holding that very session says "You
//     signed out in another tab of this browser". Only a match counts: a session
//     ended any other way, or a note left by an earlier session, still reads as
//     before. Both doors share one sign-out (the header's Sign out, the expiry
//     warning's Logout now), which re-syncs a stale token first, so a stale
//     tab's sign-out is a sign-out, not a refused token.
//   • "Signed in elsewhere" told every user account to change its password,
//     which an account that signs in with emailed codes cannot do. The kick
//     context says whether the account uses a password (`passwordless`, from the
//     account itself whichever door signed in): a code account is told to tell
//     an organiser and to make sure nobody else can get into its email; a
//     password account is told to sign in with a code, change its password and
//     tell an organiser. Each arm is asserted by its own full words, so neither
//     can pass on the sentence the two share.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, BASE, PARTICIPANT_PASS, codeLogin, TEST_DB_PATH } = require("./helpers");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const { H, makeParticipant } = require("./event-admin-helpers");
const { makeAdmin } = require("./admin-inflight-helpers");
const { OUT_OF_DATE, dbAll, csrfEnds, booted, signedInTab, watchWrites, replaceByPasswordChange, publishFrom } = require("./cross-tab-fixture");

test.use({ baseURL: BASE });

const SIGNED_OUT_HERE = "You signed out in another tab of this browser. Sign in again to continue.";
const INACTIVITY = "You were signed out due to inactivity. Please sign in again to continue.";
const CODE_ACCOUNT_ADVICE = "If this wasn't you, tell an organiser straight away. Your account signs in with codes sent to your email, so also make sure nobody else can get into your email.";
const PASSWORD_ACCOUNT_ADVICE = "If this wasn't you, sign in with an emailed code (Email me a code instead), change your password under Profile \u2192 How you sign in, and tell an organiser straight away.";

const events = (userId, type) => dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type=?", userId, type);
/** The popup `page` shows, once it shows one. */
async function popup(page) {
  const title = page.locator("#modal-overlay.open #modal-title");
  await expect(title).toBeVisible({ timeout: 15_000 });
  return { title: (await title.textContent()).trim(), body: (await page.locator("#modal-overlay.open #modal-body").textContent()).trim() };
}
/** Make a booted tab notice a dead session now, rather than at its next 30 s tick. */
const poke = (page) => page.evaluate(() => { fetch("/api/me"); });

test.describe("a sign-out in another tab of the same browser is named as one", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  for (const [door, press] of [
    ["the header's Sign out", (b) => b.evaluate(() => { window.doLogout(); })],
    ["the expiry warning's Logout now", (b) => b.evaluate(() => { window._sessionWarnLogoutNow(); })],
  ]) {
    test(`${door} in one tab: the other tab says the user signed out there, not that they were idle`, async ({ page }) => {
      const p = await makeParticipant(sa, saCsrf, "sout1");
      await signedInTab(page, p.email);
      const b = await page.context().newPage();
      try {
        await booted(b);
        expect(await b.evaluate(() => window._csrfFp)).toBe(await page.evaluate(() => window._csrfFp));
        await press(b);
        expect(await popup(page)).toEqual({ title: "Signed out", body: SIGNED_OUT_HERE });
      } finally { await b.close(); }
      expect(events(p.id, "logout_manual"), "a real sign-out was recorded").toHaveLength(1);
      expect(csrfEnds(p.id)).toEqual([]);
    });
  }

  test("CONTROL: a session ended any other way — even with an earlier sign-out's note in storage — still reads as before", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout2");
    await signedInTab(page, p.email);
    // A note from some other session this browser signed out: not this one.
    await page.evaluate(() => localStorage.setItem("ha:signed-out-fp", "0badf00d"));
    expect(await page.evaluate(() => window._csrfFp)).not.toBe("0badf00d");
    // The session ends without any tab signing it out (the context's API client,
    // which leaves no note).
    const other = page.context().request;
    const lo = await other.post("/api/logout", { headers: H(await page.evaluate(() => window.csrfToken)) });
    expect(lo.ok()).toBeTruthy();
    await poke(page);
    expect(await popup(page)).toEqual({ title: "Signed out", body: INACTIVITY });
  });

  test("a STALE tab's sign-out re-syncs first: a real sign-out, no refused token, and the other tab names it", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout3");
    await signedInTab(page, p.email);
    const b = await page.context().newPage();
    try {
      await booted(b);
      // Another tab's password change replaces the session; B itself publishes the
      // new fingerprint, so A re-syncs at once (a storage event) and B stays stale.
      const live = await replaceByPasswordChange(b, "Sout-stale-2026!");
      await publishFrom(b, live);
      await expect.poll(() => page.evaluate(() => window.csrfToken), { message: "A took the live token" }).toBe(live);
      expect(await b.evaluate(() => window.csrfToken), "PRECONDITION: B still holds the dead token").not.toBe(live);
      const w = watchWrites(b);
      await b.evaluate(() => { window.doLogout(); });
      expect(await popup(page)).toEqual({ title: "Signed out", body: SIGNED_OUT_HERE });
      w.stop();
      expect(w.seen.filter(s => s.path === "/api/logout"), "B signed out once, with the LIVE token").toEqual([{ path: "/api/logout", token: live }]);
    } finally { await b.close(); }
    expect(events(p.id, "logout_manual")).toHaveLength(1);
    expect(csrfEnds(p.id), "never ended by a refused token").toEqual([]);
  });

  test("a STALE tab whose re-sync cannot finish signs nothing out, sends nothing, and says so", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout5");
    await signedInTab(page, p.email);
    const b = await page.context().newPage();
    try {
      await booted(b);
      const live = await replaceByPasswordChange(b, "Sout-probe-2026!");
      await publishFrom(b, live);   // B stays stale; A re-syncs
      await expect.poll(() => page.evaluate(() => window.csrfToken)).toBe(live);
      await b.route("**/api/session/status", (r) => r.abort());
      const w = watchWrites(b);
      await b.evaluate(() => { window.doLogout(); });
      await expect(b.locator("#toast-stack .toast").filter({ hasText: "you are still signed in" })).toBeVisible({ timeout: 10_000 });
      w.stop();
      expect(w.seen, "no sign-out was sent with the dead token").toEqual([]);
      await b.unroute("**/api/session/status");
    } finally { await b.close(); }
    const st = await (await page.context().request.get("/api/session/status")).json();
    expect(st, "the live session is untouched").toMatchObject({ active: true, user_id: p.id });
    expect(csrfEnds(p.id)).toEqual([]);
    expect(events(p.id, "logout_manual")).toEqual([]);
  });

  test("a sign-out the server never carried out withdraws its note, and a token issued for the session withdraws a stale one", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout6");
    await signedInTab(page, p.email);
    const fp = await page.evaluate(() => window._csrfFp);
    // The POST fails (maintenance, a dropped connection): the session lives on.
    await page.route("**/api/logout", (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    expect(await page.evaluate(() => window.signOutThisBrowser())).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("ha:signed-out-fp")), "the note was withdrawn with the failed request").toBeNull();
    await page.unroute("**/api/logout");
    // A note naming this live session (left by a sign-out whose page went away
    // before it could withdraw it) goes as soon as a token is issued for it.
    await page.evaluate((f) => localStorage.setItem("ha:signed-out-fp", f), fp);
    await page.evaluate(() => window.loadCsrfToken());
    expect(await page.evaluate(() => window._csrfFp)).toBe(fp);
    expect(await page.evaluate(() => localStorage.getItem("ha:signed-out-fp"))).toBeNull();
    expect((await (await page.context().request.get("/api/session/status")).json()).active).toBe(true);
  });

  test("a server-recorded cause beats a stale note: a session taken over elsewhere says so, even with a note naming it", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout7");
    await signedInTab(page, p.email);
    // A note naming exactly this tab's session, left without the session ending.
    await page.evaluate(() => localStorage.setItem("ha:signed-out-fp", window._csrfFp));
    const { api: other } = await freshCtx();
    try {
      const csrf = (await (await other.get("/api/csrf-token")).json()).csrfToken;
      expect((await codeLogin(other, p.email, H(csrf))).ok()).toBeTruthy();
      await poke(page);
      const { title, body } = await popup(page);
      expect(title).toBe("Signed in elsewhere");
      expect(body, "a code account is told to guard its inbox").toContain(CODE_ACCOUNT_ADVICE);
      expect(body, "and not to change a password it does not use").not.toContain("change your password");
    } finally { await other.dispose(); }
  });

  test("a PASSWORD account taken over elsewhere is told to change its password, not to guard an inbox it does not sign in with", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout11");
    // This participant chose a password (Profile -> How you sign in).
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("UPDATE users SET login_method='password', password_hash=?, password_set_at=? WHERE id=?")
        .run(bcrypt.hashSync("Sout11-password!", 4), new Date().toISOString(), p.id);
    } finally { db.close(); }
    await signedInTab(page, p.email);
    const { api: other } = await freshCtx();
    try {
      const csrf = (await (await other.get("/api/csrf-token")).json()).csrfToken;
      expect((await codeLogin(other, p.email, H(csrf))).ok(), "an emailed code still signs a password account in").toBeTruthy();
      await poke(page);
      const { title, body } = await popup(page);
      expect(title).toBe("Signed in elsewhere");
      expect(body).toContain(PASSWORD_ACCOUNT_ADVICE);
      expect(body, "the code account's advice is not given").not.toContain("make sure nobody else can get into your email");
    } finally { await other.dispose(); }
  });

  test("a DOUBLE-CLICKED Sign out is one sign-out: one request, and the other tab still names it", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout8");
    await signedInTab(page, p.email);
    const b = await page.context().newPage();
    try {
      await booted(b);
      const w = watchWrites(b);
      await b.evaluate(() => { window.doLogout(); window.doLogout(); });
      expect(await popup(page)).toEqual({ title: "Signed out", body: SIGNED_OUT_HERE });
      w.stop();
      expect(w.seen.filter(x => x.path === "/api/logout"), "one sign-out request").toHaveLength(1);
    } finally { await b.close(); }
  });

  test("a sign-out whose answer is lost after the server acted keeps its note: the other tab still names it", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout9");
    await signedInTab(page, p.email);
    const b = await page.context().newPage();
    try {
      await booted(b);
      // The server signs the session out; the answer never reaches the tab.
      await b.route("**/api/logout", async (route) => { await route.fetch(); await route.abort("connectionreset"); });
      expect(await b.evaluate(() => window.signOutThisBrowser())).toBe(true);
      expect(await b.evaluate(() => localStorage.getItem("ha:signed-out-fp")), "the note stays: the session was seen gone").toBe(await b.evaluate(() => window._csrfFp));
      await b.unroute("**/api/logout");
      await poke(page);
      expect(await popup(page)).toEqual({ title: "Signed out", body: SIGNED_OUT_HERE });
    } finally { await b.close(); }
    expect(events(p.id, "logout_manual")).toHaveLength(1);
  });

  test("the session monitor reads an error answer (maintenance, a block) as nothing, never as a dead session", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout10");
    await signedInTab(page, p.email);
    await page.route("**/api/session/status", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The platform is undergoing scheduled maintenance." }) }));
    await page.evaluate(() => window._sessionMonTick());
    // The tick has run to its end: nothing was announced, nothing stopped.
    expect(await page.evaluate(() => ({ announced: window._signoutAnnounced, polling: !!window._sessionMon.pollHandle })))
      .toEqual({ announced: false, polling: true });
    await expect(page.locator("#modal-overlay.open"), "no sign-out popup").toHaveCount(0);
    await page.unroute("**/api/session/status");
    // CONTROL: the same tick on a session that really is gone does announce it.
    const lo = await page.context().request.post("/api/logout", { headers: H(await page.evaluate(() => window.csrfToken)) });
    expect(lo.ok()).toBeTruthy();
    await page.evaluate(() => window._sessionMonTick());
    expect((await popup(page)).title).toBe("Signed out");
  });

  test("the sign-out asks again right before its POST: a session replaced while its navigated-away row was on its way is signed out properly", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout11");
    await signedInTab(page, p.email);
    const b = await page.context().newPage();
    try {
      await booted(b);
      // An open challenge, so the sign-out first sends its navigated-away row —
      // parked here until the test lets it go (well inside the 3 s the sign-out
      // allows it).
      let release; const parkedP = new Promise((r) => { release = r; });
      await b.route("**/navigated-away", async (route) => { await parkedP; await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
      // The session is replaced first, but nobody has heard yet: the sign-out's
      // FIRST question finds nothing stale.
      const live = await replaceByPasswordChange(b, "Sout-reask-2026!");
      const parked = b.waitForRequest((q) => q.url().includes("/navigated-away"));
      const w = watchWrites(b);
      // The challenge is "open" from the same task that presses Sign out, so no
      // visibility change in between can spend it.
      await b.evaluate(() => { window._openedTaskId = "00000000-0000-4000-8000-000000000000"; window.doLogout(); });
      await parked;
      // Word arrives while the row is parked (B publishes; A re-syncs at once).
      await publishFrom(b, live);
      await expect.poll(() => page.evaluate(() => window.csrfToken)).toBe(live);
      release();
      expect(await popup(page)).toEqual({ title: "Signed out", body: SIGNED_OUT_HERE });
      w.stop();
      expect(w.seen.filter(x => x.path === "/api/logout"), "the sign-out left with the LIVE token").toEqual([{ path: "/api/logout", token: live }]);
    } finally { await b.close(); }
    expect(csrfEnds(p.id)).toEqual([]);
    expect(events(p.id, "logout_manual")).toHaveLength(1);
  });

  test("a navigated-away row that never answers does not stop the sign-out", async ({ page }) => {
    const p = await makeParticipant(sa, saCsrf, "sout12");
    await signedInTab(page, p.email);
    await page.route("**/navigated-away", () => { /* never answered */ });
    const logout = page.waitForRequest((q) => new URL(q.url()).pathname === "/api/logout" && q.method() === "POST", { timeout: 10_000 });
    const t0 = Date.now();
    await page.evaluate(() => { window._openedTaskId = "00000000-0000-4000-8000-000000000000"; window.doLogout(); });
    await logout;
    expect(Date.now() - t0, "after the bound, not never").toBeGreaterThanOrEqual(2500);
    await expect.poll(() => events(p.id, "logout_manual").length).toBe(1);
  });

  test("an OUT-OF-DATE tab's Sign out signs nothing out: the session another tab switched to stays open", async ({ page }) => {
    const admin = await makeAdmin(sa, saCsrf, "sout4");
    await signedInTab(page, admin.email);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20_000 });
    const b = await page.context().newPage();
    try {
      await booted(b);
      await expect(b.locator("#admin-page"), "PRECONDITION: B has booted into its panel").toBeVisible({ timeout: 20_000 });
      await b.evaluate(() => window.toggleAdminView(false));
      await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText(OUT_OF_DATE, { timeout: 10_000 });
      const w = watchWrites(page);
      await page.evaluate(() => window.doLogout());
      w.stop();
      expect(w.seen, "nothing left the out-of-date tab").toEqual([]);
      const st = await (await page.context().request.get("/api/session/status")).json();
      expect(st).toMatchObject({ active: true, user_id: admin.id, admin_view: false });
      expect(events(admin.id, "logout_manual")).toEqual([]);
    } finally { await b.close(); }
  });
});
