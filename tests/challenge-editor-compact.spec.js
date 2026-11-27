// @ts-check
//
// v8.17.0 — THE COMPACT CHALLENGE EDITOR, held as GEOMETRY (Recurring rules:
// lock layout defects as edges and distances, not markup structure).
//
//   1. At 1440×900 the whole New Challenge form, and a multiple-choice EDIT, fit
//      the window on open: the Save buttons are on screen without scrolling.
//   2. At 390×844 nothing scrolls sideways and the Save row is pinned on screen
//      while the form itself is taller than the window (the anti-vacuity half:
//      a short form would pass "on screen" without the pin).
//   3. The collapsible rows are presentation only: a hint typed into a row that
//      was opened, a difficulty picked on the segmented control and an author
//      typed into its row all reach the stored challenge, and the closed rows
//      summarise what they hold when the challenge is reopened.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { uniq, mkChoice } = require("./choice-locks-fixture");

test.use({ baseURL: BASE });

/** Every visible Save button's box, against the window. */
async function saveButtons(page) {
  return page.evaluate(() => ["save-draft-btn", "save-publish-btn", "save-task-btn"]
    .map((id) => document.getElementById(id))
    .filter((b) => b && getComputedStyle(b).display !== "none")
    .map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, top: r.top, bottom: r.bottom, vh: innerHeight }; }));
}

async function openNew(page) {
  await clickTab(page, "Challenges");
  await page.locator("[data-action='open-task-form']").first().click();
  await expect(page.locator("#tf-title")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe("v8.17.0 — the challenge editor fits one screen", () => {
  test("1440×900: a new challenge and a multiple-choice edit open with Save on screen", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const id = await mkChoice(page.request, csrf, [
      { text: "Port 443", correct: true }, { text: "Port 80" }, { text: "Port 22" }, { text: "Port 8080" },
    ], { title: uniq("Compact MC") });

    await openNew(page);
    const nb = await saveButtons(page);
    expect(nb.map((b) => b.id), "PRECONDITION: the create form offers draft and publish").toEqual(["save-draft-btn", "save-publish-btn"]);
    for (const b of nb) {
      expect(b.top, `${b.id} is not above the window`).toBeGreaterThanOrEqual(0);
      expect(b.bottom, `${b.id} is on screen without scrolling`).toBeLessThanOrEqual(b.vh);
    }
    const formBottom = await page.locator("#admin-task-form").evaluate((f) => f.getBoundingClientRect().bottom);
    expect(formBottom, "the whole form fits the window on open").toBeLessThanOrEqual(900);

    await page.locator("[data-action='close-task-form']").click();
    await expect.poll(() => page.evaluate((tid) => !!(/** @type {any} */ (window).adminTasksData || []).find((t) => t.id === tid), id),
      { timeout: 15000 }).toBe(true);
    await page.evaluate((tid) => /** @type {any} */ (window).editTask(tid), id);
    await expect(page.locator("#tf-choices-list .choice-row"), "PRECONDITION: the edit shows its four choices").toHaveCount(4);
    await page.evaluate(() => window.scrollTo(0, 0));
    const eb = await saveButtons(page);
    expect(eb.map((b) => b.id)).toEqual(["save-task-btn"]);
    expect(eb[0].bottom, "Save challenge is on screen on a multiple-choice edit").toBeLessThanOrEqual(eb[0].vh);
    expect(eb[0].top).toBeGreaterThanOrEqual(0);
  });

  test("390×844: one column, no sideways scroll, and the Save row is pinned on screen", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await openNew(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const g = await page.evaluate(() => {
      const f = document.getElementById("admin-task-form").getBoundingClientRect();
      const main = document.querySelector("#admin-task-form .ce-main").getBoundingClientRect();
      const rail = document.querySelector("#admin-task-form .ce-rail").getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, vw: innerWidth, formH: f.height, vh: innerHeight, railTop: rail.top, mainBottom: main.bottom, railLeft: rail.left, mainLeft: main.left };
    });
    expect(g.sw, "nothing scrolls sideways").toBeLessThanOrEqual(g.vw);
    expect(g.formH, "PRECONDITION: the form is taller than the phone, so the pin is what keeps Save on screen").toBeGreaterThan(g.vh);
    expect(g.railTop, "one column: the settings follow the question").toBeGreaterThanOrEqual(g.mainBottom - 1);
    expect(Math.abs(g.railLeft - g.mainLeft)).toBeLessThan(2);
    for (const b of await saveButtons(page)) expect(b.bottom, `${b.id} is pinned on screen`).toBeLessThanOrEqual(b.vh);
  });

  test("collapsed rows keep their values: hint, author and difficulty reach the challenge and are summarised on reopen", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await openNew(page);
    const title = uniq("Compact rows");
    await page.fill("#tf-title", title);
    await page.fill("#tf-answer", "flag");
    await expect(page.locator("#tf-hint-body"), "the hint row starts closed").toBeHidden();
    await page.locator('[aria-controls="tf-hint-body"]').click();
    await expect(page.locator('[aria-controls="tf-hint-body"]')).toHaveAttribute("aria-expanded", "true");
    await page.locator("#tf-hint .rich-body").click();
    await page.keyboard.type("Check the port");
    await page.locator('[aria-controls="tf-hint-body"]').click();
    await expect(page.locator("#tf-hint-body")).toBeHidden();
    await expect(page.locator("#tf-hint-sum"), "a closed row says what it holds").toHaveText("Check the port");
    await page.locator('[aria-controls="tf-author-body"]').click();
    await page.fill("#tf-author-name", "Ada Lovelace");
    await page.locator("label.ce-seg-opt", { hasText: "Hard" }).click();
    await expect(page.locator("#tf-diff")).toHaveValue("hard");
    await page.locator("#save-draft-btn").click();
    await expect(page.locator("#admin-task-table-card")).toBeVisible({ timeout: 15000 });
    let row;
    await expect.poll(async () => { row = await page.evaluate((t) => (/** @type {any} */ (window).adminTasksData || []).find((x) => x.title === t), title); return !!row; }, { timeout: 15000 }).toBe(true);
    expect(row.difficulty).toBe("hard");
    expect(row.hint).toContain("Check the port");
    expect(row.author_name).toBe("Ada Lovelace");
    // CONTROL: the untouched explanation stayed empty, so the summaries above
    // are the values, not a row that always says something.
    expect(row.explanation || "").toBe("");

    await page.evaluate((tid) => /** @type {any} */ (window).editTask(tid), row.id);
    await expect(page.locator("#tf-hint-body"), "an edit opens with the rows closed").toBeHidden();
    await expect(page.locator("#tf-hint-sum")).toHaveText("Check the port");
    await expect(page.locator("#tf-author-sum")).toHaveText("Ada Lovelace");
    await expect(page.locator("#tf-explanation-sum")).toHaveText("+ Add explanation");
    await expect(page.locator('input[name="tf-diff-seg"][value="hard"]')).toBeChecked();
  });
});
