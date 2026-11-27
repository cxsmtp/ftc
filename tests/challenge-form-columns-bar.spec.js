// @ts-check
//
// The challenge library's Columns bar (ui/table-columns.js puts it just before
// the table card) belongs to the table: while the challenge form replaces the
// table, a Columns button would offer the columns of a table that is not on
// screen. It goes with the table card and comes back with it, on both doors
// into the form (New and Edit).
const { test, expect } = require("./isolated-test");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { apiLogin, BASE } = require("./helpers");
const { makeTask } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

test("the Columns bar is hidden while the challenge form is open, and back when it closes", async ({ page }) => {
  const { api, csrf } = await apiLogin("superadmin");
  let task;
  try { task = await makeTask(api, csrf, "colbar"); } finally { await api.dispose(); }

  await adminLogin(page);
  await clickTab(page, "Challenges");
  const bar = page.locator('.tcol-bar[data-tcols-for="challenges"]');
  const card = page.locator("#admin-task-table-card");
  await expect(card, "PRECONDITION: the library table is on screen").toBeVisible({ timeout: 15000 });
  await expect(bar, "PRECONDITION: so is its Columns bar").toBeVisible();
  const colsBtn = page.locator('#admin-tasks-tab .tcol-cols-btn[data-tcol-columns="challenges"]:visible');
  await expect(colsBtn, "PRECONDITION: with its Columns button").toHaveCount(1);

  for (const [door, open] of [
    ["New", () => page.evaluate(() => window.openTaskForm())],
    ["Edit", () => page.evaluate((id) => window.editTask(id), task.id)],
  ]) {
    await open();
    await expect(page.locator("#admin-task-form"), `${door}: the form is open`).toBeVisible({ timeout: 10000 });
    await expect(card, `${door}: the table it replaces is hidden`).toBeHidden();
    await expect(bar, `${door}: and so is the table's Columns bar`).toBeHidden();
    await expect(colsBtn, `${door}: no Columns button for a table that is not on screen`).toHaveCount(0);
    await page.evaluate(() => window.closeTaskForm());
    await expect(card, `${door}: closing brings the table back`).toBeVisible({ timeout: 10000 });
    await expect(bar, `${door}: with its Columns bar`).toBeVisible();
    await expect(colsBtn, `${door}: and its Columns button`).toHaveCount(1);
  }
});
