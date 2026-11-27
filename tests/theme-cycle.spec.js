// @ts-check
//
// THE MODE PREFERENCE ("hck-theme": system | light | dark).
//
// The header's day/night toggle is gone: signed in, the mode is the Appearance
// page's Mode control (Auto / Light / Dark); signed out, the look picker's
// (Auto / Day / Night). Both write the same per-browser preference, which
// public/theme-boot.js paints before the first frame. What is pinned here:
//   - a fresh visitor follows the device (the house mode, "system");
//   - the Appearance page's Mode control stores each choice, paints it, says
//     which one is in force, and Auto returns to following the device;
//   - the look picker's mode writes the same preference;
//   - "system" resolves from the OS and a pinned mode ignores it, at first
//     paint and when the OS changes while the page is open.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, codeLogin } = require("./helpers");
const { makeParticipant } = require("./event-admin-helpers");
const { openAppearance } = require("./chrome-helpers");

test.use({ baseURL: BASE });

/** Load with a given OS preference and a clean (or given) stored preference. */
async function open(page, { colorScheme = "dark", stored = null } = {}) {
  await page.emulateMedia({ colorScheme });
  await page.addInitScript((v) => {
    try { v === null ? localStorage.removeItem("hck-theme") : localStorage.setItem("hck-theme", v); } catch (_) {}
  }, stored);
  await page.goto("/");
  await expect(page.locator('html[data-booted="1"]'), "the app booted").toBeAttached({ timeout: 20000 });
}
const pref = (page) => page.evaluate(() => { try { return localStorage.getItem("hck-theme"); } catch (_) { return null; } });
const applied = (page) => page.getAttribute("html", "data-theme");

let member = null;

test.describe("The mode preference", () => {
  test.beforeAll(async () => {
    const s = await apiLogin("superadmin");
    try { member = await makeParticipant(s.api, s.csrf, "mode"); }
    finally { await s.api.dispose(); }
  });

  test("a fresh visitor follows the device (the house mode)", async ({ page }) => {
    // A fresh visitor is pinned to nothing and gets the house mode, "system":
    // the device's own mode (operator ruling, 13 Nov 2026).
    await open(page, { colorScheme: "light" });
    expect(await applied(page), "CONTROL: a light OS paints light").toBe("light");
    await open(page, { colorScheme: "dark" });
    expect(await pref(page), "an untouched install stores nothing").toBeNull();
    expect(await applied(page), "…and a dark OS paints dark").toBe("dark");
  });

  test("Appearance's Mode control stores and paints each choice, says which is in force, and Auto follows the device again", async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => { try { localStorage.removeItem("hck-theme"); } catch (_) {} });
    const r = await codeLogin(page.request, member.email);
    expect(r.ok(), `sign in: ${r.status()}`).toBeTruthy();
    await page.goto("/");
    await expect(page.locator('html[data-booted="1"]')).toBeAttached({ timeout: 20000 });
    const ap = await openAppearance(page);
    const group = ap.locator('[role=group][aria-label="Mode"]');
    const btn = (m) => group.locator(`[data-action="appearance-mode"][data-mode="${m}"]`);
    await expect(group.locator('[data-action="appearance-mode"]'), "Auto, Light and Dark").toHaveCount(3);
    const pressed = () => group.locator('[aria-pressed="true"]').evaluateAll(els => els.map(e => e.dataset.mode));
    expect(await pressed(), "nothing chosen: the house mode, Auto, is the one in force").toEqual(["system"]);
    expect(await pref(page), "…and nothing is stored").toBeNull();

    await btn("light").click();
    await expect.poll(() => pref(page), { timeout: 3000 }).toBe("light");
    expect(await applied(page), "a light pin paints light on a dark OS").toBe("light");
    expect(await pressed(), "Light is the one in force").toEqual(["light"]);
    await expect(btn("light"), "focus stays on the pressed control across the re-render").toBeFocused();

    await btn("dark").click();
    await expect.poll(() => pref(page), { timeout: 3000 }).toBe("dark");
    expect(await applied(page)).toBe("dark");
    expect(await pressed()).toEqual(["dark"]);

    await btn("system").click();
    await expect.poll(() => pref(page), { timeout: 3000 }).toBe("system");
    expect(await pressed()).toEqual(["system"]);
    expect(await applied(page), "Auto on a dark OS paints dark").toBe("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => applied(page), { timeout: 3000, message: "Auto follows the device again" }).toBe("light");
  });

  test("signed out, the look picker's mode writes the same preference", async ({ page }) => {
    await open(page, { colorScheme: "light" });
    await page.locator("#look-picker-btn").click();
    const dlg = page.locator("#look-picker-overlay [role=dialog]");
    await expect(dlg).toBeVisible();
    const btn = (m) => dlg.locator(`[data-action="look-picker-mode"][data-mode="${m}"]`);
    await btn("dark").click();
    await expect.poll(() => pref(page), { timeout: 3000 }).toBe("dark");
    expect(await applied(page), "Night pins dark on a light OS").toBe("dark");
    await btn("light").click();
    await expect.poll(() => pref(page), { timeout: 3000 }).toBe("light");
    await btn("system").click();
    await expect.poll(() => pref(page), { timeout: 3000 }).toBe("system");
    expect(await applied(page), "Auto on a light OS paints light").toBe("light");
  });

  test("'system' resolves from the OS, not from a remembered pin", async ({ page }) => {
    // The whole point of the third state: on a LIGHT machine, system means light.
    await open(page, { colorScheme: "light", stored: "system" });
    expect(await applied(page)).toBe("light");
    await open(page, { colorScheme: "dark", stored: "system" });
    expect(await applied(page)).toBe("dark");
  });

  test("a PINNED mode ignores the OS", async ({ page }) => {
    // The other half of the contract — a pin must survive a light machine.
    await open(page, { colorScheme: "light", stored: "dark" });
    expect(await applied(page)).toBe("dark");
    await open(page, { colorScheme: "dark", stored: "light" });
    expect(await applied(page)).toBe("light");
  });

  test("an OS change repaints while on 'system' and is ignored once pinned", async ({ page }) => {
    await open(page, { colorScheme: "dark", stored: "system" });
    expect(await applied(page)).toBe("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => applied(page), { timeout: 3000 }).toBe("light");

    // Now the other half, in a fresh load so the init script does not fight it:
    // pinned dark on a DARK os, then move the OS to light. The pin must win.
    // (Reloading in place does not work here — addInitScript re-runs on every
    // navigation and would rewrite the stored preference before the page reads
    // it, which is a property of the harness rather than of the feature.)
    await open(page, { colorScheme: "dark", stored: "dark" });
    expect(await applied(page)).toBe("dark");
    // A witness that the change was delivered: a listener added AFTER boot's own
    // runs after it (change events fire oldest MediaQueryList first), so once it
    // has counted the change, the app's listener has already decided.
    await page.evaluate(() => {
      window.__osChanges = 0;
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { window.__osChanges++; });
    });
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => page.evaluate(() => window.__osChanges), { timeout: 3000, message: "the OS change reached the page" }).toBe(1);
    expect(await applied(page), "an OS change must not override an explicit pin").toBe("dark");
  });
});
