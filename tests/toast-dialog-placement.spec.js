// @ts-check
//
// A TOAST NEVER COVERS A DIALOG'S PRIMARY ACTION.
//
// Toasts sit at the bottom right, which is where a dialog keeps its primary
// action. A toast raised while a dialog was open covered the button, and the
// toast pauses its countdown while the pointer is over it (WCAG 2.2.1), so a
// person (or a test) pointing at the button kept the toast there for good: the
// event form's "Finish creating" could not be pressed after a refused save
// (tests/event-form-paths.spec.js). While any dialog is open (ui/modal.js
// `overlayDismiss` keeps `body.dialog-open`) the stack sits at the top.
//
// Locked by geometry and by the press itself, at a desktop and a phone width;
// CONTROL: with no dialog open the stack is at the bottom, as before.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const LONG = "The settings could not be applied, so they may not have been saved. Press the primary action to try again — this message is long enough to wrap.";

for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`at ${vp.width}x${vp.height}, a toast raised over an open dialog leaves its primary action clear and pressable; with no dialog it sits at the bottom`, async ({ page }) => {
    await page.setViewportSize(vp);
    await adminLogin(page);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(() => typeof window.showModal === "function" && typeof window.showToast === "function");

    // CONTROL first: no dialog, the stack is at the bottom of the screen.
    await page.evaluate((m) => window.showToast(m, "error"), LONG);
    const free = await page.locator("#toast-stack .toast").last().boundingBox();
    expect(free && free.y + free.height, "with no dialog the toast sits at the bottom").toBeGreaterThan(vp.height - 120);
    await page.evaluate(() => document.querySelectorAll("#toast-stack .toast").forEach((t) => t.remove()));

    // A dialog, then a toast while it is open.
    await page.evaluate(() => { window.__modalAnswer = window.showModal({ title: "Finish it?", message: "One more step.", confirmText: "Finish creating" }); });
    const btn = page.locator("#modal-overlay.open #modal-confirm-btn");
    await expect(btn).toBeVisible({ timeout: 5000 });
    await expect(page.locator("body.dialog-open"), "the open dialog is known").toHaveCount(1);
    await page.evaluate((m) => window.showToast(m, "error"), LONG);
    const toast = page.locator("#toast-stack .toast").last();
    await expect(toast).toBeVisible();
    const t = await toast.boundingBox(), b = await btn.boundingBox();
    expect(t && b, "both boxes measured").toBeTruthy();
    const overlap = !(t.x + t.width <= b.x || b.x + b.width <= t.x || t.y + t.height <= b.y || b.y + b.height <= t.y);
    expect(overlap, `the toast ${JSON.stringify(t)} must not cover the primary action ${JSON.stringify(b)}`).toBe(false);
    // The point a press lands on is the button itself, and the press answers.
    const hit = await page.evaluate(() => {
      const r = document.querySelector("#modal-overlay.open #modal-confirm-btn").getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!el && !!el.closest("#modal-confirm-btn");
    });
    expect(hit, "nothing lies over the button's centre").toBe(true);
    await btn.click({ timeout: 5000 });
    expect(await page.evaluate(() => window.__modalAnswer), "the press confirmed the dialog").toBe(true);
    await expect(page.locator("body.dialog-open"), "and the stack goes back down once it closes").toHaveCount(0);
  });
}
