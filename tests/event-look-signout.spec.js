"use strict";

// AN EVENT'S LOOK ENDS WITH THE SESSION (ui/theme.js setEventLook; the look is
// kept per tab in sessionStorage `hck-event-look`, which theme-boot.js paints
// before the app runs, so a reload inside the event wears it at once).
//
// The defect: only showMain/showPage took it off, and sign-out, a kick, expiry
// and a restart all reload the page instead; the signed-out boot reaches
// neither, so the next visitor at a shared booth tablet met the last event's
// look on the sign-in page. Now every session end takes it off
// (features/session-monitor.js), and boot takes it off for a page that loads
// signed out with no join pending (core/main.js).
//
//   * a participant inside a locked-look event signs out: the sign-in page that
//     follows wears the platform's look, and the tab holds no event look;
//   * a page that loads signed out with an event look left in the tab drops it
//     — beside a control proving theme-boot alone would still paint it.

const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const { pressAccountMenuItem } = require("./chrome-helpers");

test.use({ baseURL: BASE });

const EVENT_LOOK = "signature";
const lookOf = (page) => page.evaluate(() => document.documentElement.getAttribute("data-look"));
const storedEventLook = (page) => page.evaluate(() => { try { return sessionStorage.getItem("hck-event-look"); } catch (_) { return "n/a"; } });

test.describe("an event's look ends with the session", () => {
  let sa, csrf, comp, part, baseline;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    ({ api: sa, csrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, csrf, "lookout");
    const lk = await sa.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: EVENT_LOOK, locked: true } });
    expect(lk.ok(), `set the event look: ${lk.status()} ${await lk.text()}`).toBeTruthy();
    // One event only, so the sign-in lands inside it (the sole-event landing).
    part = await makeParticipant(sa, csrf, "lookout");
    await enrol(sa, csrf, comp.id, [part.id]);
    // What a fresh, signed-out visitor wears: the look the sign-out must return to.
    const ctx = await browser.newContext({ baseURL: BASE });
    try {
      const p = await ctx.newPage();
      await p.goto("/");
      await p.locator("#login-email").waitFor({ state: "visible", timeout: 20000 });
      baseline = await lookOf(p);
    } finally { await ctx.close(); }
    expect(baseline, "PRECONDITION: the platform's look is not the event's, so a leak would show").not.toBe(EVENT_LOOK);
  });
  test.afterAll(async () => { if (sa) await sa.dispose(); });

  test("sign-out takes it off: the next visitor's sign-in page wears the platform's look", async ({ page }) => {
    // What each document finds in the tab BEFORE any of its scripts run — what
    // theme-boot paints first. Sign-out must take the look off before its
    // reload, not leave it for the next page's boot to remove after a paint.
    await page.addInitScript(() => { try { window.__eventLookAtStart = sessionStorage.getItem("hck-event-look"); } catch (_) { window.__eventLookAtStart = "n/a"; } });
    await loginViaApi(page, part.email, PARTICIPANT_PASS);
    await page.goto("/");
    // POSITIVE: inside the event, the event's look is on and kept in the tab.
    await expect.poll(() => lookOf(page), { message: "inside the event its look is worn", timeout: 20000 }).toBe(EVENT_LOOK);
    expect(await storedEventLook(page), "and kept for a reload").toContain(EVENT_LOOK);

    await pressAccountMenuItem(page, "do-logout");
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 20000 });
    await expect.poll(() => lookOf(page), { message: "the sign-in page after sign-out wears the platform's look", timeout: 15000 }).toBe(baseline);
    expect(await storedEventLook(page), "no event look is left in the tab").toBeNull();
    expect(await page.evaluate(() => window.__eventLookAtStart), "the page after sign-out started with no event look: its first paint is the platform's").toBeNull();
  });

  test("a page that loads signed out drops an event look left in the tab", async ({ browser }) => {
    const stale = JSON.stringify({ look: EVENT_LOOK, locked: true });
    const prime = (v) => { try { if (!sessionStorage.getItem("primed")) { sessionStorage.setItem("hck-event-look", v); sessionStorage.setItem("primed", "1"); } } catch (_) { /* no storage */ } };

    // CONTROL: with the app's module blocked, theme-boot alone paints the stale
    // look — so it is the app's boot that takes it off below.
    const c1 = await browser.newContext({ baseURL: BASE });
    try {
      const p1 = await c1.newPage();
      await p1.addInitScript(prime, stale);
      let blocked = 0;
      await p1.route(/\/js\/core\/main\.js/, (r) => { blocked++; return r.abort(); });
      await p1.goto("/", { waitUntil: "domcontentloaded" });
      expect(blocked, "PRECONDITION: the app module was blocked").toBeGreaterThan(0);
      expect(await lookOf(p1), "CONTROL: theme-boot paints the look the tab holds").toBe(EVENT_LOOK);
    } finally { await c1.close(); }

    const c2 = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await c2.newPage();
      await p2.addInitScript(prime, stale);
      await p2.goto("/");
      await p2.locator("#login-email").waitFor({ state: "visible", timeout: 20000 });
      await expect.poll(() => lookOf(p2), { message: "the signed-out boot takes the event's look off", timeout: 15000 }).toBe(baseline);
      expect(await storedEventLook(p2), "and forgets it").toBeNull();
    } finally { await c2.close(); }
  });
});
