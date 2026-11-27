"use strict";

// THE FILTERS PATTERN: one "Filters" button per admin list opens the panel
// holding the chip groups; "Filters · N" and removable chips while any is
// active; Clear all resets; the open state is remembered per browser; removing
// a chip keeps keyboard focus in the chip row (then on the Filters button).

const { test, expect } = require("./isolated-test");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { BASE } = require("./helpers");

// Operator ruling, 14 Nov 2026: ON A PHONE the open panel is a sheet over the
// page, so it keeps the shared dialog contract — a scrim, role="dialog" with
// aria-modal, Tab held inside it, Escape closing it, focus back on the Filters
// button — and it is opened by a press, never by a page load (the remembered
// open state is restored on a wide screen, where the panel is inline: the
// control, which takes none of the contract).
async function filtersProbe(browser, viewport) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport });
  try {
    const page = await ctx.newPage();
    // Remembered open, as a wide screen leaves it.
    await page.addInitScript(() => { try { localStorage.setItem("ha:filters-open:comp-filters-panel", "1"); } catch (_) { /* no storage */ } });
    await adminLogin(page);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    const btn = page.locator("#comp-filters-btn");
    const panel = page.locator("#comp-filters-panel");
    await expect(btn).toBeVisible({ timeout: 15000 });
    const openedByLoad = await panel.isVisible();
    // Then the press path on both widths: closed with its Done, opened with Filters.
    if (openedByLoad) {
      await panel.locator('[data-action="filters-toggle"]').click();
      await expect(panel).toBeHidden();
    }
    await btn.click();
    await expect(panel).toBeVisible();
    const state = () => panel.evaluate((el) => ({
      role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"),
      scrim: !!(el.previousElementSibling && el.previousElementSibling.classList.contains("filters-scrim") && el.previousElementSibling.getClientRects().length),
      position: getComputedStyle(el).position,
    }));
    const open = await state();
    const stops = await panel.evaluate((el) => el.querySelectorAll("button, input, select, a[href]").length);
    // From inside the panel, as a keyboard user who opened it starts.
    await panel.locator(".filter-btn").first().focus();
    let escaped = false;
    for (let i = 0; i < stops * 3 + 5 && !escaped; i++) {
      await page.keyboard.press("Tab");
      escaped = !(await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest("#comp-filters-panel")));
    }
    await panel.locator(".filter-btn").first().focus();
    await page.keyboard.press("Escape");
    const closed = await panel.isHidden();
    const focusBack = await page.evaluate(() => document.activeElement && document.activeElement.id === "comp-filters-btn");
    const after = closed ? await state() : null;
    return { openedByLoad, open, stops, escaped, closed, focusBack, after };
  } finally { await ctx.close(); }
}

test.use({ baseURL: BASE });

test.describe("Filters button and panel", () => {
  test("Events: closed by default, chips inside, Filters · N with removable chips, Clear all", async ({ page }) => {
    await adminLogin(page);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    const btn = page.locator("#comp-filters-btn");
    const panel = page.locator("#comp-filters-panel");
    await expect(btn).toBeVisible();
    await expect(panel, "the panel starts closed").toBeHidden();
    await expect(page.locator("#comp-status-filters [data-status='live']"), "the chips are inside it").toBeHidden();
    // The default view filters to live, upcoming and late entry: three active.
    await expect(btn).toHaveText("Filters · 3");
    const chips = page.locator("#comp-filters-panel-active .filter-chip");
    await expect(chips).toHaveCount(3);

    // Remove one from beside the button: the chip it names turns off.
    await chips.filter({ hasText: "Upcoming" }).click();
    await expect(page.locator("#comp-status-filters [data-status='upcoming']")).not.toHaveClass(/\bactive\b/);
    await expect(btn).toHaveText("Filters · 2");

    // Open, press a chip, Clear all.
    await btn.click();
    await expect(panel).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await page.locator("#comp-status-filters [data-status='ended']").click();
    await expect(btn).toHaveText("Filters · 3");
    await panel.locator('[data-action="filters-clear"]').click();
    await expect(btn, "Clear all leaves no filter").toHaveText("Filters");
    await expect(chips).toHaveCount(0);
    await expect(page.locator("#comp-status-filters [data-status='all']")).toHaveClass(/\bactive\b/);

    // Remembered per browser.
    await page.reload();
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await expect(panel, "the panel stays open after a reload").toBeVisible();
    await panel.locator('[data-action="filters-toggle"]').click();
    await expect(panel).toBeHidden();
  });

  test("Participants and the Challenge library have the same button", async ({ page }) => {
    await adminLogin(page);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await clickTab(page, "Participants");
    await expect(page.locator("#p-filters-btn")).toBeVisible();
    await expect(page.locator("#p-status-filters"), "the status chips are in the panel").toBeHidden();
    await page.locator("#p-filters-btn").click();
    await page.locator('#p-status-filters [data-value="blocked"]').click();
    await expect(page.locator("#p-filters-btn")).toHaveText("Filters · 1");
    await expect(page.locator("#p-filters-panel-active .filter-chip")).toHaveText(/Blocked/);
    await page.locator("#p-filters-panel-active .filter-chip").click();
    await expect(page.locator("#p-filters-btn")).toHaveText("Filters");
    await expect(page.locator('#p-status-filters [data-value="all"]')).toHaveClass(/\bactive\b/);

    await clickTab(page, "Challenges");
    await expect(page.locator("#task-filters-btn")).toBeVisible();
    await expect(page.locator("#task-diff-filters")).toBeHidden();
  });

  test("on a phone the Filters panel is a modal sheet: never opened by a page load, a scrim, Tab stays in it, Escape closes it, focus returns (wide: an inline panel, control)", async ({ browser }) => {
    test.setTimeout(120_000);
    const phone = await filtersProbe(browser, { width: 390, height: 844 });
    expect(phone.open.position, "PRECONDITION: on a phone the open panel is a fixed sheet").toBe("fixed");
    expect(phone.stops, "PRECONDITION: the sheet's controls were counted").toBeGreaterThan(3);
    expect(phone.openedByLoad, "a page load never opens the sheet, whatever was remembered").toBe(false);
    expect(phone.open, "a modal dialog with a scrim while open").toEqual({ role: "dialog", modal: "true", scrim: true, position: "fixed" });
    expect(phone.escaped, "Tab never leaves the sheet").toBe(false);
    expect(phone.closed, "Escape closes it").toBe(true);
    expect(phone.focusBack, "focus returns to the Filters button").toBe(true);
    expect(phone.after, "closed: a group again, no scrim").toEqual({ role: "group", modal: null, scrim: false, position: "static" });
    const wide = await filtersProbe(browser, { width: 1440, height: 900 });
    expect(wide.openedByLoad, "CONTROL: a wide screen restores the remembered panel").toBe(true);
    expect(wide.open, "CONTROL: an inline panel, opened by a press, is no dialog and has no scrim").toEqual({ role: "group", modal: null, scrim: false, position: "static" });
    expect(wide.escaped, "CONTROL: Tab moves on past it").toBe(true);
    expect(wide.closed, "CONTROL: and Escape does not close it").toBe(false);
  });

  // Crossing the breakpoint never leaves a sheet without its contract, nor the
  // contract on an inline panel: an inline panel the window narrows under is
  // closed (a sheet opens by a press), and a sheet the window widens under stays
  // open inline, a plain group again that Escape does not close. Keyboard focus
  // is never lost on the way: out of a panel that closes, to its Filters button;
  // in a panel that stays open, where it was.
  test("crossing the phone breakpoint: an open inline panel closes, focus to its Filters button; an open sheet stays open inline, without the contract, focus where it was", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    const btn = page.locator("#comp-filters-btn");
    const panel = page.locator("#comp-filters-panel");
    const scrim = page.locator(".filters-scrim");
    await expect(btn).toBeVisible({ timeout: 15000 });
    if (await panel.isHidden()) await btn.click();
    await expect(panel, "PRECONDITION: open inline").toBeVisible();
    await expect(panel).toHaveAttribute("role", "group");
    // The second chip: opening the panel focuses its first.
    const chip = panel.locator(".filter-btn").nth(1);
    await chip.focus();
    await expect(chip, "PRECONDITION: focus is in the inline panel").toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel, "narrowed under it: closed, never a sheet without the contract").toBeHidden();
    await expect(scrim).toHaveCount(0);
    await expect(btn, "focus goes to its Filters button, never down to the page").toBeFocused();
    // A sheet, opened by a press, then widened under.
    await btn.click();
    await expect(panel).toBeVisible();
    await expect(panel, "PRECONDITION: a sheet").toHaveAttribute("aria-modal", "true");
    await expect(scrim, "PRECONDITION: with its scrim").toHaveCount(1);
    await chip.focus();
    await expect(chip, "PRECONDITION: focus is in the sheet").toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(panel, "widened under it: still open, inline").toBeVisible();
    await expect(panel, "a group again").toHaveAttribute("role", "group");
    expect(await panel.getAttribute("aria-modal"), "not modal").toBeNull();
    await expect(scrim, "no scrim").toHaveCount(0);
    await expect(chip, "focus stays where it was, in the panel that stays open").toBeFocused();
    expect(await btn.evaluate((el) => el === document.activeElement), "CONTROL: never handed back to the Filters button").toBe(false);
    await panel.locator(".filter-btn").first().focus();
    await page.keyboard.press("Escape");
    await expect(panel, "Escape no longer closes an inline panel").toBeVisible();
  });

  test("removing a filter chip keeps keyboard focus in the chip row, then on the Filters button", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').evaluate(el => el.click());
    const box = page.locator("#comp-filters-panel-active");
    const chips = () => box.locator(".filter-chip").evaluateAll(els => els.map(e => e.textContent.replace(/[×\s]+/g, " ").trim()));
    await expect.poll(chips, { timeout: 15000 }).toEqual(["Live", "Upcoming", "Late entry"]);
    const focused = () => page.evaluate(() => {
      const a = document.activeElement;
      return a && a.classList.contains("filter-chip") ? a.textContent.replace(/[×\s]+/g, " ").trim() : (a && a.id) || (a && a.tagName);
    });
    await box.locator(".filter-chip").first().focus();
    await page.keyboard.press("Enter");
    await expect.poll(chips).toEqual(["Upcoming", "Late entry"]);
    expect(await focused(), "the chip now in its place").toBe("Upcoming");
    await box.locator(".filter-chip").last().focus();
    await page.keyboard.press("Enter");
    await expect.poll(chips).toEqual(["Upcoming"]);
    expect(await focused(), "the last one went: the one before it").toBe("Upcoming");
    await page.keyboard.press("Enter");
    await expect.poll(chips).toEqual([]);
    expect(await focused(), "none left: the Filters button").toBe("comp-filters-btn");
  });
});
