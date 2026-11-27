// @ts-check
//
// THE EMAILED ONE-TIME SHARE PAGE (GET /badge/:link/post), in a browser. It is
// the only certificate surface for a holder who never signs in, and its client
// (public/js/features/certificate-share-page.js) runs outside the SPA:
//   • "Copy post" copies; "Copy post & open LinkedIn" copies, opens the composer,
//     and spends the link, publishing the certificate page once;
//   • its POST carries a token fetched just before it, so a sign-in in another
//     tab since the page loaded is not ended by a stale token;
//   • a POST that never answers says so and can be repeated;
//   • a page whose script never arrived says how to recover.
// LinkedIn itself is stubbed: nothing here leaves the test server.
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const { heldCertificate, shareLink } = require("./certificate-fixture");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const linkUsed = (badgeToken) => dbGet("SELECT used_at FROM certificate_share_links WHERE badge_token=?", badgeToken).used_at;
const pageShared = (badgeToken) => dbGet("SELECT shared_at FROM achievement_badges WHERE token=?", badgeToken).shared_at;

/** Stub LinkedIn for the whole context, so the composer pop-up stays local. */
async function stubLinkedIn(context) {
  await context.route("https://www.linkedin.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>linkedin stub</p>" }));
}

test("Copy post copies, and Copy post & open LinkedIn opens the composer and publishes the page once", async ({ page, context }) => {
  const { mint } = await heldCertificate("sharepage");
  const link = shareLink(mint.token);
  await stubLinkedIn(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.goto(`/badge/${link}/post`);
  await expect(page.locator("#share-post-text")).toBeVisible();
  // The page's own script ran: it removes the "reload this page" notice.
  await expect(page.locator("#share-post-fallback"), "the module loaded and ran").toHaveCount(0, { timeout: 10000 });
  const text = await page.locator("#share-post-text").inputValue();
  expect(text, "PRECONDITION: the post names the certificate's verification link").toContain("/credential?code=");

  await page.locator("#share-post-copy").click();
  await expect(page.locator("#share-post-status")).toHaveText(/Post copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText()), "the post reached the clipboard").toBe(text);
  expect(linkUsed(mint.token), "Copy post alone spends nothing").toBeNull();

  // The clipboard answers in a LATER task, as a real one does (here 400 ms late,
  // the real write behind it); the composer must open before that, in the
  // click's own task, which is the only time a pop-up blocker allows a window.
  await page.evaluate(() => {
    window.__copySettled = false; window.__openBeforeCopySettled = null;
    const write0 = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) => new Promise((res, rej) => setTimeout(() => {
      write0(t).then(() => { window.__copySettled = true; res(); }, rej);
    }, 400));
    const open0 = window.open.bind(window);
    window.open = (...a) => {
      if (window.__openBeforeCopySettled === null) window.__openBeforeCopySettled = !window.__copySettled;
      return open0(...a);
    };
  });
  const popup = page.waitForEvent("popup");
  await page.locator("#share-post-go").click();
  const composer = await popup;
  expect(composer.url()).toContain("https://www.linkedin.com/feed/?shareActive=true&text=");
  await expect(page.locator("#share-post-status")).toHaveText("Post copied — paste it into LinkedIn. Your certificate page is now published.", { timeout: 10000 });
  expect(await page.evaluate(() => window.__openBeforeCopySettled), "the composer opened in the click's task, before the clipboard answered").toBe(true);
  expect(linkUsed(mint.token), "the press spent the link").toBeTruthy();
  expect(pageShared(mint.token), "and published the certificate page").toBeTruthy();
});

test("a sign-in in another tab before the press is not ended by the page's stale token", async ({ page, context }) => {
  const { mint, other } = await heldCertificate("sharestale");
  const link = shareLink(mint.token);
  await stubLinkedIn(context);
  const posts = [];
  page.on("response", (rs) => {
    if (rs.request().method() === "POST" && rs.url().includes(`/badge/${link}/post`)) posts.push(rs.status());
  });
  await page.goto(`/badge/${link}/post`);
  await expect(page.locator("#share-post-fallback")).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".share-post-note"), "the page says, before the press, that it publishes (operator ruling, 17 Nov 2026)").toContainText("publishes your certificate page");
  // Another tab of this browser signs in: the session the page's token was
  // issued for is replaced.
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await codeLogin(page.request, other.email, { "x-csrf-token": csrfToken, "content-type": "application/json" });
  expect(li.ok(), `PRECONDITION: the other tab signed in: ${await li.text()}`).toBeTruthy();
  expect((await page.request.get("/api/me")).status(), "PRECONDITION: this browser is signed in").toBe(200);

  const popup = page.waitForEvent("popup");
  await page.locator("#share-post-go").click();
  await popup;
  await expect(page.locator("#share-post-status")).toContainText("Your certificate page is now published", { timeout: 10000 });
  expect(posts, "one POST, accepted").toEqual([200]);
  expect((await page.request.get("/api/me")).status(), "the signed-in session survived the press").toBe(200);
  expect(pageShared(mint.token)).toBeTruthy();
});

test("a press whose request never answers says the page was not published, and can be repeated", async ({ page, context }) => {
  const { mint } = await heldCertificate("sharelost");
  const link = shareLink(mint.token);
  await stubLinkedIn(context);
  await page.goto(`/badge/${link}/post`);
  await expect(page.locator("#share-post-fallback")).toHaveCount(0, { timeout: 10000 });
  const lost = (r) => (r.request().method() === "POST" ? r.abort("failed") : r.continue());
  await page.route(`**/badge/${link}/post`, lost);

  const popup1 = page.waitForEvent("popup");
  await page.locator("#share-post-go").click();
  await popup1;
  await expect(page.locator("#share-post-status")).toContainText("was not published", { timeout: 10000 });
  await expect(page.locator("#share-post-go"), "the press can be repeated").toBeEnabled();
  expect(linkUsed(mint.token), "nothing was spent").toBeNull();
  expect(pageShared(mint.token)).toBeNull();

  await page.unroute(`**/badge/${link}/post`, lost);
  const popup2 = page.waitForEvent("popup");
  await page.locator("#share-post-go").click();
  await popup2;
  await expect(page.locator("#share-post-status")).toContainText("Your certificate page is now published", { timeout: 10000 });
  expect(linkUsed(mint.token)).toBeTruthy();
  expect(pageShared(mint.token)).toBeTruthy();
});

test("a share page whose script never arrived tells the holder to reload", async ({ page }) => {
  const { mint } = await heldCertificate("sharenojs");
  const link = shareLink(mint.token);
  await page.route("**/js/features/certificate-share-page.js", (r) => r.abort("failed"));
  await page.goto(`/badge/${link}/post`);
  await expect(page.locator("#share-post-go"), "PRECONDITION: the page itself rendered").toBeVisible();
  const notice = page.locator("#share-post-fallback");
  await expect(notice).toBeVisible({ timeout: 10000 });
  await expect(notice).toHaveText("If the buttons do not respond, reload this page.");
});

test("a pop-up the browser refuses leaves a plain Open LinkedIn link, and the page is still published", async ({ page, context }) => {
  const { mint } = await heldCertificate("sharepopup");
  const link = shareLink(mint.token);
  await stubLinkedIn(context);
  await page.goto(`/badge/${link}/post`);
  await expect(page.locator("#share-post-fallback")).toHaveCount(0, { timeout: 10000 });
  // A pop-up blocker's answer: no window.
  await page.evaluate(() => { window.open = () => null; });
  await page.locator("#share-post-go").click();
  const open = page.locator("#share-post a.btn", { hasText: "Open LinkedIn" });
  await expect(open, "the composer is offered as a plain link instead").toBeVisible({ timeout: 10000 });
  await expect(open).toHaveAttribute("href", /^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=/);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(page.locator("#share-post-go"), "it takes the button's place").toHaveCount(0);
  await expect(page.locator("#share-post-status")).toContainText("Your certificate page is now published");
  expect(linkUsed(mint.token), "the press spent the link").toBeTruthy();
});
