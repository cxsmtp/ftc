// @ts-check
//
// THE SIGN-IN CARD LEARNS THE CODE'S LIFETIME FROM THE SERVER.
//
// Continue for an address this tab was mailed a code for reopens the code step
// without asking for another — but only while that code can still work, and its
// lifetime is the operator's `LOGIN_CODE_TTL_MS`, not a copy of the 10-minute
// default. The SPA shell carries it (`<body data-login-code-ttl>`), so a
// throttled GET /api/config at a venue NAT cannot hide it, and that answer's
// `login_code_ttl_ms` is the same value; known to neither, the card reuses
// nothing. Driven with the real code request behind it; the server's own value
// with a non-default lifetime is held by tests/login-code.spec.js, which boots a
// server with a 7-minute one.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { expectSpaBooted } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

/**
 * Continue twice for one address, closing the code step between; counts the
 * code requests sent. `beforeSecond(page)` runs before the second Continue.
 */
async function continueTwice(page, email, beforeSecond) {
  let requested = 0;
  page.on("request", (r) => { if (r.url().includes("/api/auth/code/request")) requested++; });
  await page.goto("/");
  await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
  await expectSpaBooted(page);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-submit").click();
  await expect(page.locator("#sc-code")).toBeVisible({ timeout: 10000 });
  await expect.poll(() => requested, { message: "the first Continue asked for a code" }).toBe(1);
  await page.locator('#signin-code-overlay [data-action="overlay-close"]').click();
  await expect(page.locator("#sc-code")).toHaveCount(0);
  if (beforeSecond) await beforeSecond(page);
  await page.locator("#login-submit").click();
  await expect(page.locator("#sc-code")).toBeVisible({ timeout: 10000 });
  return () => requested;
}

/** Answer GET /api/config with the server's body, its code lifetime replaced. */
async function lifetimeIs(page, ms) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, login_code_ttl_ms: ms } });
  });
}

/** GET /api/config throttled, as at a venue NAT: a 429 every time. */
async function configThrottled(page) {
  await page.route("**/api/config", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }) }));
}

/** Wait until the card has taken the lifetime /api/config answered. */
const configLifetimeArrived = (ms) => async (page) => {
  await expect.poll(() => page.evaluate(() => window.S && window.S.loginCodeTtlMs),
    { message: "the /api/config lifetime reached the card" }).toBe(ms);
};

/** The page's own lifetime, as the shell delivered it. */
const pageLifetime = (page) => page.evaluate(() => document.body.dataset.loginCodeTtl);

test.describe("the code step's reuse follows the server's code lifetime", () => {
  test("the shared server reports its configured lifetime, in the page and on GET /api/config", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      const d = await (await api.get("/api/config")).json();
      expect(d.login_code_ttl_ms, "tests/server-env.js pins LOGIN_CODE_TTL_MS to ten minutes").toBe(600000);
      const shell = await (await api.get("/")).text();
      expect(shell, "the SPA shell carries the same lifetime").toContain('data-login-code-ttl="600000"');
      expect(shell, "…substituted, never the placeholder").not.toContain("{{loginCodeTtl}}");
    } finally { await api.dispose(); }
  });

  test("a code still alive by the server's clock is reused: the second Continue asks for nothing", async ({ page }) => {
    await lifetimeIs(page, 600000);
    const count = await continueTwice(page, `ttl-live-${Date.now()}@company.example`, configLifetimeArrived(600000));
    await expect(page.locator("#signin-code-overlay"), "the step says the code is already on its way").toContainText("already on its way");
    expect(count(), "no second request").toBe(1);
  });

  test("a code dead by the server's clock is not: a short lifetime makes the second Continue ask again", async ({ page }) => {
    // One millisecond: the code the first Continue asked for is dead by the time
    // the second is pressed. A client keeping its own ten-minute copy reuses it.
    await lifetimeIs(page, 1);
    const count = await continueTwice(page, `ttl-dead-${Date.now()}@company.example`, configLifetimeArrived(1));
    await expect.poll(() => count(), { message: "the second Continue asked for a new code" }).toBe(2);
    await expect(page.locator("#signin-code-overlay")).not.toContainText("already on its way");
  });

  test("a throttled /api/config still reuses the live code: the page itself carries the lifetime", async ({ page }) => {
    // The venue-NAT case: every /api/config answer is a 429, so a card that
    // learned the lifetime only there would reuse nothing, and a second
    // Continue after the two-minute suppression would supersede the code in
    // the inbox.
    await configThrottled(page);
    const count = await continueTwice(page, `ttl-nat-${Date.now()}@company.example`, async (p) => {
      expect(await p.evaluate(() => window.S && window.S.loginCodeTtlMs), "PRECONDITION: /api/config told the card nothing").toBeFalsy();
      expect(await pageLifetime(p), "PRECONDITION: the page carries the server's lifetime").toBe("600000");
    });
    await expect(page.locator("#signin-code-overlay"), "the step says the code is already on its way").toContainText("already on its way");
    expect(count(), "no second request").toBe(1);
  });

  test("the page's lifetime is the one honoured when /api/config is throttled: a code dead by it is not reused", async ({ page }) => {
    // CONTROL for the arm above: the page's value is used AS the lifetime, not
    // merely as a sign that one exists.
    await configThrottled(page);
    const count = await continueTwice(page, `ttl-natdead-${Date.now()}@company.example`, async (p) => {
      await p.evaluate(() => { document.body.dataset.loginCodeTtl = "1"; });
    });
    await expect.poll(() => count(), { message: "the second Continue asked for a new code" }).toBe(2);
    await expect(page.locator("#signin-code-overlay")).not.toContainText("already on its way");
  });

  test("with no lifetime from the page or from /api/config nothing is reused", async ({ page }) => {
    await page.route("**/api/config", (route) => route.abort());
    const count = await continueTwice(page, `ttl-none-${Date.now()}@company.example`, async (p) => {
      await p.evaluate(() => { delete document.body.dataset.loginCodeTtl; });
      expect(await pageLifetime(p), "PRECONDITION: the page's lifetime is gone").toBeUndefined();
    });
    await expect.poll(() => count(), { message: "the second Continue asked for a new code" }).toBe(2);
  });
});
