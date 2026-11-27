// @ts-check
//
// v8.14.5 — the Booth tap card's ORDER and its "Not correct" marks.
//
// Each test was written against a mutation that survived the whole suite before
// it existed (named in its comment), and was seen failing with it applied. The
// tile letters were already pinned to display position; the order the tiles are
// drawn in, and a tried tile staying disabled, were not.
const { test, expect } = require("./isolated-test");
const {
  sa, SHORT, eventWithChoices, participantIn, deviceContext, signInTo, openChallenge, countSubmits, choiceIdsFor,
} = require("./booth-choice-tap-fixture");

const confirmOpen = (page) => page.locator("#modal-overlay.open");

/** Tap a tile and confirm, waiting out the confirm's double-tap guard (armMs). */
async function tapAndConfirm(page, text) {
  await page.locator(".mcf-tile", { hasText: text }).click();
  await expect(confirmOpen(page)).toBeVisible();
  await page.waitForTimeout(450);
  await page.locator("#modal-confirm-btn").click();
  await expect(confirmOpen(page)).toHaveCount(0);
}

test.describe("v8.14.5 — the booth tap card", () => {
  test("the tiles are drawn in this participant's order, not the author's or any other", async ({ browser }) => {
    // Survived before: renderTapCard drawing `opts.slice().reverse()`. The letters
    // still ran A, B, C… down the screen, so the letter lock could not see it.
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    await api.dispose();
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      const served = (await choiceIdsFor(page, ids[0])).map((c) => c.id);
      await openChallenge(page, ids[0]);
      const tiles = page.locator(".mcf-options .mcf-tile");
      await expect(tiles).toHaveCount(SHORT.length);
      expect(await tiles.evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.choiceId)),
        "tile order is the served order").toEqual(served);
    } finally { await ctx.close(); }
  });

  test("a tile marked Not correct stays disabled through the next answer", async ({ browser }) => {
    // Survived before: setTapBusy clearing aria-disabled from EVERY tile when an
    // answer settled, so the second wrong answer re-enabled the first wrong tile.
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { cap: 3, tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    await api.dispose();
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      const posts = countSubmits(page);
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      await tapAndConfirm(page, "FTP");
      const ftp = page.locator(".mcf-tile", { hasText: "FTP" });
      await expect(ftp, "PRECONDITION: the first wrong tile is marked").toHaveAttribute("aria-disabled", "true");
      await tapAndConfirm(page, "Telnet");
      const telnet = page.locator(".mcf-tile", { hasText: "Telnet" });
      await expect(telnet).toContainText("Not correct");
      await expect(telnet).toHaveAttribute("aria-disabled", "true");
      expect(posts.n, "PRECONDITION: two answers were sent").toBe(2);
      await expect(ftp, "the first wrong tile is still disabled").toHaveAttribute("aria-disabled", "true");
      await expect(ftp).toContainText("Not correct");
      await expect(page.locator(".mcf-tile", { hasText: "HTTPS" }), "CONTROL: an untried tile is live").not.toHaveAttribute("aria-disabled", "true");
      await ftp.click({ force: true });   // aria-disabled, so Playwright would wait for it to "enable"
      await page.waitForTimeout(450);
      await expect(confirmOpen(page), "a tap on it opens nothing").toHaveCount(0);
      expect(posts.n, "and sends nothing").toBe(2);
    } finally { await ctx.close(); }
  });
});
