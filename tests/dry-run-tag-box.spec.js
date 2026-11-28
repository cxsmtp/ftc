// @ts-check
//
// THE EVENT FORM'S "DRY RUN" BOX IS THE `test/dry run` TAG (owner's decision,
// 27 Nov 2026): one fact, two controls. Ticking the box and saving adds the tag;
// removing the tag anywhere (the Events list's ×) unticks the box; adding the tag
// anywhere ticks it. Each direction is asserted against the server's stored
// tags, read by API, with the box read in a form opened afresh, so a form that
// only remembered its own last state cannot pass.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin, viewComp, openCompAdvanced, narrowEventsTable } = require("./ui-admin-helpers");
const { H, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
// The Events list's Tags column is past its default set: show it (before the first goto).
test.beforeEach(async ({ page }) => { const U = require("./ui-admin-helpers"); await U.showAllTableColumns(page, "events", U.EVENT_ALL_COLUMNS); });
const DRY = "test/dry run";

let comp;
test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const name = `Dry run box ${uniq("e")}`;
    const r = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name, event_kind: "tournament", start_time: new Date(Date.now() + 2 * 86400e3).toISOString(), duration_minutes: 60 },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const d = await r.json();
    comp = { id: (d.competition && d.competition.id) || d.id, name };
  } finally { await api.dispose(); }
});

// Read through the page's OWN session: a second superadmin sign-in would end it
// (one session per principal).
async function storedTags(page) {
  const list = await (await page.request.get("/api/admin/competitions")).json();
  return ((Array.isArray(list) ? list : list.competitions).find(c => c.id === comp.id) || {}).tags || [];
}

/** Open the event's Edit settings from its workspace ⋯ menu, Advanced open. */
async function openEdit(page) {
  await viewComp(page, comp.name);
  await page.locator("#ws-quick .ws-more-btn").click();
  await page.locator('#kebab-portal.open [data-action="comp-edit"]').click();
  await page.locator("#comp-form-overlay #comp-name").waitFor({ state: "visible", timeout: 15000 });
  await openCompAdvanced(page);
  return page.locator("#comp-internal");
}
async function closeForm(page) {
  await page.locator('#comp-form-overlay [data-action="overlay-close"]').first().click();
  await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
}

test("ticking Dry run adds the tag; removing the tag in the list unticks it; adding it ticks it", async ({ page }) => {
  test.setTimeout(120_000);
  await adminLogin(page);

  // The box is labelled Dry run, and starts unticked with no tag (CONTROL).
  let box = await openEdit(page);
  await expect(page.locator("label.checkbox-row", { has: box })).toContainText(/^\s*Dry run\s*$/);
  expect(await storedTags(page), "PRECONDITION: no tag yet").not.toContain(DRY);
  await expect(box, "no tag, no tick").not.toBeChecked();

  // 1. Tick and save: the tag is stored.
  await box.check();
  await page.locator('#comp-form-overlay [data-action="comp-save"]').click();
  const confirm = page.locator("#modal-overlay.open #modal-confirm-btn");
  await expect(page.locator("#modal-overlay"), "the Update confirmation opened").toHaveClass(/open/, { timeout: 10000 });
  await expect(page.locator("#modal-title")).toHaveText(/^Update/);
  await confirm.click();
  await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => storedTags(page), { timeout: 15000, message: "ticking stored the tag" }).toContain(DRY);

  // 2. Remove the tag in the Events list: the box reads unticked.
  await page.locator("#admin-scope-banner [data-action=\"scope-clear\"]").first().click();
  await expect(page.locator("#admin-competitions-tab")).toBeVisible();
  await narrowEventsTable(page, comp.name);
  await page.locator(`#admin-comp-body tr:has-text("${comp.name}") [data-action="comp-tag-remove"][data-tag="${DRY}"]`).click();
  await expect.poll(() => storedTags(page), { timeout: 15000, message: "the list's × removed the tag" }).not.toContain(DRY);
  box = await openEdit(page);
  await expect(box, "the tag is gone, so the box is unticked").not.toBeChecked();
  await closeForm(page);

  // 3. Add the tag elsewhere (the tag route): the box reads ticked.
  {
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const r = await page.request.post(`/api/admin/competitions/${comp.id}/tags`, { headers: H(csrf), data: { tag: DRY } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  await page.reload();
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  box = await openEdit(page);
  await expect(box, "the tag is back, so the box is ticked").toBeChecked();
  // 4. Untick and save: the tag goes.
  await box.uncheck();
  await page.locator('#comp-form-overlay [data-action="comp-save"]').click();
  await expect(page.locator("#modal-overlay"), "the Update confirmation opened").toHaveClass(/open/, { timeout: 10000 });
  await expect(page.locator("#modal-title")).toHaveText(/^Update/);
  await confirm.click();
  await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => storedTags(page), { timeout: 15000, message: "unticking removed the tag" }).not.toContain(DRY);
});
