"use strict";
// Helpers for the app chrome: the signed-in header keeps only Search
// (#app-search-btn, the command palette) and ONE account button
// (#profile-menu-btn); the view switch, the Appearance row, Profile, Help,
// What's new and Sign out live in its menu (#profile-menu-overlay). A spec that
// used to click a header control opens the menu first.
//
// Required lazily from specs; it takes only `expect` from @playwright/test.
const { expect } = require("@playwright/test");

/** Open the account menu (idempotent) and return its overlay locator. */
async function openAccountMenu(page) {
  const overlay = page.locator("#profile-menu-overlay");
  if (await overlay.count()) return overlay;
  const btn = page.locator("#profile-menu-btn");
  await expect(btn, "PRECONDITION: the signed-in header rendered its account button").toBeVisible({ timeout: 20000 });
  await btn.click();
  await expect(overlay).toBeVisible();
  return overlay;
}

/** Press an account-menu item by its data-action (and data-on for the view item). */
async function pressAccountMenuItem(page, action, on) {
  const overlay = await openAccountMenu(page);
  const sel = on === undefined ? `[data-action="${action}"]` : `[data-action="${action}"][data-on="${on}"]`;
  await overlay.locator(sel).click();
}

/** The view-switch item's label without leaving the menu open. */
async function accountMenuViewLabel(page) {
  const overlay = await openAccountMenu(page);
  const item = overlay.locator('[data-action="toggle-admin-view"]');
  const text = (await item.count()) ? (await item.innerText()).trim() : null;
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  return text;
}

/**
 * Appearance is one row of the menu ("Appearance ›") that opens the Appearance
 * page (#appearance-overlay); its mode, look and ambient controls live there.
 */
async function openAppearance(page) {
  const existing = page.locator("#appearance-overlay");
  if (await existing.count()) return existing;
  await pressAccountMenuItem(page, "open-appearance");
  const overlay = page.locator("#appearance-overlay");
  await expect(overlay).toBeVisible();
  return overlay;
}

/** Open the command palette from the header's Search button. */
async function openPalette(page) {
  const overlay = page.locator("#command-palette-overlay");
  if (await overlay.count()) return overlay;
  const btn = page.locator("#app-search-btn");
  await expect(btn, "PRECONDITION: the signed-in header rendered its Search button").toBeVisible({ timeout: 20000 });
  await btn.click();
  await expect(overlay).toBeVisible();
  return overlay;
}

// Help: signed out, the header's "?" (#help-icon-btn); signed in, the account
// menu's Help item — pressAccountMenuItem(page, "help-open") — or a Help result
// of the palette.

module.exports = { openAccountMenu, pressAccountMenuItem, accountMenuViewLabel, openAppearance, openPalette };
