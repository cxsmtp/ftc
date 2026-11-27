// @ts-check
//
// v8.14.5 — THE ADMIN SIDE OF A MULTIPLE-CHOICE CHALLENGE: what the editor keeps,
// what the preview draws, and the two edit forms' conflict check.
//
// The conflict tests pin the v8.14.5 fix. Both forms used to read their
// `expectedUpdatedAt` from the LIST model at Save, and both lists reload under an
// open form (returning to the tab; for events also the 15 s poll), so the token
// was usually the newest one and another admin's change was silently overwritten.
// Each test was seen failing against the code it guards: the reverted fix, or
// the mutation named in its comment.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { H, uniq, makeCompetition, storedTask, dbGet, makeTier, mkChoice } = require("./choice-locks-fixture");

test.use({ baseURL: BASE });

const tagOf = (label) => uniq(label).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const markup = (T) => [
  { text: `<b>bold ${T}</b>`, correct: true }, { text: `a<b ${T}` }, { text: `He said "yes" & left ${T}` }, { text: `Plain ${T}` },
];

/**
 * Leave the tab and come back, through the app's own visibilitychange handler:
 * on the admin page it reloads the lists. The caller polls the list model for the
 * version it expects, since a response to a request sent BEFORE the change can
 * land after this returns (seen under full-suite load).
 */
async function tabAwayAndBack(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => w.__hidden });
    document.dispatchEvent(new Event("visibilitychange"));
    w.__hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Open the challenge editor on a task, as the row's Edit item does. */
async function openEditor(page, taskId) {
  await expect.poll(() => page.evaluate((id) => !!(/** @type {any} */ (window).adminTasksData || []).find((t) => t.id === id), taskId),
    { timeout: 15000, message: "the challenge is in the admin list model" }).toBe(true);
  await page.evaluate((id) => /** @type {any} */ (window).editTask(id), taskId);
  await expect(page.locator("#admin-task-form")).toBeVisible();
  await expect(page.locator("#edit-task-id")).toHaveValue(taskId);
}

/** Press Save Challenge and return the PUT's status and body. */
async function saveEditor(page, taskId) {
  const put = page.waitForResponse((r) => r.url().endsWith(`/api/admin/tasks/${taskId}`) && r.request().method() === "PUT");
  await page.locator("#save-task-btn").click();
  const r = await put;
  return { status: r.status(), body: await r.text() };
}

test.describe("v8.14.5 — the challenge editor, the preview and the edit-conflict check", () => {
  test("a re-save through the editor keeps every option's id and text exactly", async ({ page }) => {
    // Survived before: the editor rebuilding its rows without their ids
    // (challenges-admin.js editTask), so an unchanged re-save minted new ids and
    // orphaned every earlier answer; and the editor writing an option's text
    // into its input unescaped, so a quote truncated it.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("keep");
    const id = await mkChoice(sa, csrf, markup(T), { title: `Keep ${T}` });
    await sa.dispose();
    const before = storedTask(id);

    await adminLogin(page);
    await clickTab(page, "challenges");
    await openEditor(page, id);
    expect(await page.locator("#tf-choices-list input.choice-text").evaluateAll((els) => els.map((e) => /** @type {HTMLInputElement} */ (e).value)),
      "each option's text loads into its input as typed").toEqual(markup(T).map((o) => o.text));
    await page.locator("#tf-title").fill(`Keep ${T} renamed`);
    const r = await saveEditor(page, id);
    expect(r.status, r.body).toBe(200);
    const after = storedTask(id);
    expect(after.title, "PRECONDITION: the save landed").toBe(`Keep ${T} renamed`);
    expect(after.choices, "the options, ids included, are byte-identical").toBe(before.choices);
    expect(after.correct_answer).toBe(before.correct_answer);
  });

  test("View as Participant draws markup options as literal text, in author order", async ({ page }) => {
    // The preview's own copy of the option renderer: esc() is its only defence.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("prev");
    const id = await mkChoice(sa, csrf, markup(T));
    await sa.dispose();

    await adminLogin(page);
    await clickTab(page, "challenges");
    await expect.poll(() => page.evaluate((tid) => !!(/** @type {any} */ (window).adminTasksData || []).find((t) => t.id === tid), id)).toBe(true);
    await page.evaluate((tid) => /** @type {any} */ (window).viewTaskAsParticipant(tid), id);
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay).toBeVisible();
    expect(await overlay.locator(".choice-review .tpc-text").allTextContents()).toEqual(markup(T).map((o) => o.text));
    expect(await overlay.locator(".choice-review b, .choice-review img").count()).toBe(0);
  });

  test("the challenge editor refuses a save over a change it never showed, even after the list reloads", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("cc");
    const id = await mkChoice(sa, csrf, [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }], { title: `Start ${T}` });
    const other = await makeTier(sa, csrf, "cc-other", "admin");
    await sa.dispose();

    await adminLogin(page);
    await clickTab(page, "challenges");
    await openEditor(page, id);
    // Another organiser changes the challenge while this form is open…
    const theirs = await other.api.put(`/api/admin/tasks/${id}`, { headers: H(other.csrf), data: { title: `Theirs ${T}` } });
    expect(theirs.ok(), `the other admin's edit: ${await theirs.text()}`).toBeTruthy();
    // …and this admin switches tabs and back, which reloads the list under the form.
    await tabAwayAndBack(page);
    await expect.poll(() => page.evaluate((tid) => /** @type {any} */ (window).adminTasksData.find((t) => t.id === tid)?.updated_at, id),
      { timeout: 15000, message: "PRECONDITION: the reloaded list model holds the other admin's version" }).toBe(storedTask(id).updated_at);

    await page.locator("#tf-title").fill(`Mine ${T}`);
    const r = await saveEditor(page, id);
    expect(r.status, `the stale form is refused: ${r.body}`).toBe(409);
    await expect(page.locator(".toast").filter({ hasText: "modified by another admin" })).toBeVisible();
    expect(storedTask(id).title, "the other admin's change stands").toBe(`Theirs ${T}`);

    // The remedy the guide gives: close the form and open it again.
    await page.evaluate(() => /** @type {any} */ (window).closeTaskForm());
    await openEditor(page, id);
    await expect(page.locator("#tf-title")).toHaveValue(`Theirs ${T}`);
    await page.locator("#tf-title").fill(`Mine ${T}`);
    const again = await saveEditor(page, id);
    expect(again.status, `CONTROL: a form opened on the latest version saves: ${again.body}`).toBe(200);
    expect(storedTask(id).title).toBe(`Mine ${T}`);
    await other.api.dispose();
  });

  test("the event form refuses a save over a change it never showed, even after the list reloads", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const ev = await makeCompetition(sa, csrf, "ef", { start_time: new Date(Date.now() + 86400e3).toISOString() });
    const other = await makeTier(sa, csrf, "ef-other", "admin");
    await sa.dispose();
    const T = tagOf("ef");
    const nameNow = () => dbGet("SELECT name, updated_at FROM competitions WHERE id=?", ev.id);

    await adminLogin(page);
    await clickTab(page, "competitions");
    const openForm = async () => {
      await expect.poll(() => page.evaluate((cid) => !!(/** @type {any} */ (window).adminCompetitionsData || []).find((c) => c.id === cid), ev.id),
        { timeout: 15000 }).toBe(true);
      await page.evaluate((cid) => /** @type {any} */ (window).editCompetition(cid), ev.id);
      await expect(page.locator("#comp-form-overlay #comp-name")).toBeVisible();
    };
    const save = async () => {
      const put = page.waitForResponse((r) => r.url().endsWith(`/api/admin/competitions/${ev.id}`) && r.request().method() === "PUT");
      await page.locator('#comp-form-overlay [data-action="comp-save"]').click();
      // An edit asks "Save changes to …?" first.
      await page.locator("#modal-overlay.open #modal-confirm-btn").click();
      const r = await put;
      return { status: r.status(), body: await r.text() };
    };

    await openForm();
    const theirs = await other.api.put(`/api/admin/competitions/${ev.id}`, { headers: H(other.csrf), data: { name: `Theirs ${T}` } });
    expect(theirs.ok(), `the other admin's edit: ${await theirs.text()}`).toBeTruthy();
    await tabAwayAndBack(page);
    await expect.poll(() => page.evaluate((cid) => /** @type {any} */ (window).adminCompetitionsData.find((c) => c.id === cid)?.updated_at, ev.id),
      { timeout: 15000, message: "PRECONDITION: the reloaded list model holds the other admin's version" }).toBe(nameNow().updated_at);

    await page.locator("#comp-form-overlay #comp-name").fill(`Mine ${T}`);
    const r = await save();
    expect(r.status, `the stale form is refused: ${r.body}`).toBe(409);
    await expect(page.locator(".toast").filter({ hasText: "modified by another admin" })).toBeVisible();
    expect(nameNow().name, "the other admin's change stands").toBe(`Theirs ${T}`);

    await page.locator('#comp-form-overlay [data-action="overlay-close"]').click();
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
    await openForm();
    await expect(page.locator("#comp-form-overlay #comp-name")).toHaveValue(`Theirs ${T}`);
    await page.locator("#comp-form-overlay #comp-name").fill(`Mine ${T}`);
    const again = await save();
    expect(again.status, `CONTROL: a form opened on the latest version saves: ${again.body}`).toBe(200);
    expect(nameNow().name).toBe(`Mine ${T}`);
    await other.api.dispose();
  });
});
