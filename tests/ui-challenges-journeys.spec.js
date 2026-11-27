// @ts-check
//
// v8.12.4 — challenges-pane controls no test had ever DRIVEN.
//
// Same finding as ui-participants-journeys.spec.js: a coverage run showed these
// row handlers never executing in a browser. The lock, the visibility toggle,
// publishing and a version restore were all exercised through the API (and the
// menu items asserted present), never by pressing them. Each test here presses
// the control and reads the stored result.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, clickTab, openKebab, narrowChallengesTable } = require("./ui-admin-helpers");
const { H, uniq } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });
// The difficulty chips live in the Filters panel; open it before the first page.goto.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};

async function mkTask(sa, csrf, title, extra = {}) {
  const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", ...extra } });
  expect(r.ok(), `create ${title}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).id;
}

/** Narrow the paginated challenges table and wait for it to settle. */
async function narrow(page, query) {
  await narrowChallengesTable(page, query);
  const tbody = page.locator("#admin-task-body");
  await expect(async () => {
    const a = await tbody.locator("tr").count();
    await page.waitForTimeout(250);
    expect(await tbody.locator("tr").count()).toBe(a);
  }).toPass({ timeout: 8000 });
}
async function kebabAction(page, title, action) {
  await narrow(page, title);
  const row = page.locator(`#admin-task-body tr:has-text("${title}")`).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await openKebab(page, row);
  await page.locator(`#kebab-portal [data-action="${action}"]`).first().click();
}
async function confirmModal(page, expectText) {
  const ov = page.locator("#modal-overlay.open");
  await ov.waitFor({ state: "visible", timeout: 8000 });
  if (expectText) await expect(ov).toContainText(expectText);
  await page.locator("#modal-confirm-btn").click();
}

test.describe("v8.12.4 — challenges pane, driven through its own controls", () => {
  test("Lock and then Unlock from the row menu, each persisted", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const title = uniq("LockMe"), id = await mkTask(sa, csrf, title);
      await adminLogin(page); await clickTab(page, "Challenges");
      await kebabAction(page, title, "task-toggle-lock");
      await expect.poll(() => dbGet("SELECT locked FROM tasks WHERE id=?", id).locked, { timeout: 10000 }).toBe(1);
      await kebabAction(page, title, "task-toggle-lock");
      await expect.poll(() => dbGet("SELECT locked FROM tasks WHERE id=?", id).locked, { timeout: 10000 }).toBe(0);
    } finally { await sa.dispose(); }
  });

  test("Hide and then Show from the row menu, each confirmed and persisted", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const title = uniq("HideMe"), id = await mkTask(sa, csrf, title);
      await adminLogin(page); await clickTab(page, "Challenges");
      await kebabAction(page, title, "task-toggle-visibility");
      await confirmModal(page, /Hide Challenge/);
      await expect.poll(() => dbGet("SELECT active FROM tasks WHERE id=?", id).active, { timeout: 10000 }).toBe(0);
      await kebabAction(page, title, "task-toggle-visibility");
      await confirmModal(page, /Show Challenge/);
      await expect.poll(() => dbGet("SELECT active FROM tasks WHERE id=?", id).active, { timeout: 10000 }).toBe(1);
    } finally { await sa.dispose(); }
  });

  test("Publish on a DRAFT, confirmed, makes it published", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const title = uniq("DraftMe"), id = await mkTask(sa, csrf, title, { status: "draft" });
      await adminLogin(page); await clickTab(page, "Challenges");
      await kebabAction(page, title, "task-publish");
      await confirmModal(page, /Publish Challenge/);
      await expect.poll(() => dbGet("SELECT status FROM tasks WHERE id=?", id).status, { timeout: 10000 }).toBe("published");
    } finally { await sa.dispose(); }
  });

  test("History → Restore on an earlier version brings its content back", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const original = uniq("Restorable"), id = await mkTask(sa, csrf, original);
      const cur = dbGet("SELECT updated_at FROM tasks WHERE id=?", id);
      const edited = `${original} EDITED`;
      const put = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { title: edited, expectedUpdatedAt: cur.updated_at } });
      expect(put.ok(), `edit: ${await put.text()}`).toBeTruthy();
      expect(dbGet("SELECT title FROM tasks WHERE id=?", id).title, "PRECONDITION: the title moved").toBe(edited);

      // Read the history BEFORE the browser signs in: the platform keeps ONE
      // session per user, so the page's superadmin login ends this API session.
      const list = await (await sa.get(`/api/admin/tasks/${id}/versions`)).json();
      const arr = Array.isArray(list) ? list : (list.versions || list.events || []);
      const titleOf = (v) => { const sn = typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : v.snapshot; return sn && sn.title; };
      const first = arr.find(v => titleOf(v) === original);
      expect(first, `a version holding the original title exists: ${JSON.stringify(arr.map(v => [v.version_num, v.change_type, titleOf(v)]))}`).toBeTruthy();

      await adminLogin(page); await clickTab(page, "Challenges");
      await kebabAction(page, edited, "task-history");
      const hist = page.locator("#hist-overlay");
      await hist.waitFor({ state: "visible", timeout: 10000 });
      await hist.locator(`[data-action="task-restore-version"][data-version-id="${first.id}"]`).click();
      await confirmModal(page, /Restore/);
      await expect.poll(() => dbGet("SELECT title FROM tasks WHERE id=?", id).title, { timeout: 10000 }).toBe(original);
      await expect(page.locator("#hist-overlay"), "the dialog closes so the result is visible").toHaveCount(0);
    } finally { await sa.dispose(); }
  });

  test("the difficulty chips narrow the table to that difficulty, and All brings the rest back", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const prefix = uniq("DiffChip");
      await mkTask(sa, csrf, `${prefix} E`, { difficulty: "easy" });
      await mkTask(sa, csrf, `${prefix} H`, { difficulty: "hard" });
      await adminLogin(page); await clickTab(page, "Challenges");
      await narrow(page, prefix);
      const titles = () => page.locator("#admin-task-body tr").evaluateAll(
        (rs, p) => rs.map(r => (r.textContent || "").match(new RegExp(p + " ([EH])")) ).filter(Boolean).map(m => m[1]).sort(), prefix);
      await expect.poll(titles, { timeout: 8000 }).toEqual(["E", "H"]);
      await page.locator('[data-action="toggle-task-diff-filter"][data-val="hard"]').click();
      await expect.poll(titles, { timeout: 8000 }).toEqual(["H"]);
      await page.locator('[data-action="toggle-task-diff-filter"][data-val="all"]').click();
      await expect.poll(titles, { timeout: 8000 }).toEqual(["E", "H"]);
    } finally { await sa.dispose(); }
  });

  test("the × on a challenge's tag chip removes that tag and leaves the others", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const title = uniq("TagChip"), id = await mkTask(sa, csrf, title);
      for (const tag of ["keep-me", "drop-me"]) {
        const r = await sa.post(`/api/admin/tasks/${id}/tags`, { headers: H(csrf), data: { tag } });
        expect(r.ok(), await r.text()).toBeTruthy();
      }
      const tags = () => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(id).map(r => r.tag); } finally { db.close(); }
      };
      expect(tags(), "PRECONDITION: both tags applied").toEqual(["drop-me", "keep-me"]);
      await adminLogin(page); await clickTab(page, "Challenges");
      await narrow(page, title);
      const row = page.locator(`#admin-task-body tr:has-text("${title}")`).first();
      await row.locator('[data-action="task-tag-remove"][data-tag="drop-me"]').click();
      await expect.poll(tags, { timeout: 10000 }).toEqual(["keep-me"]);
    } finally { await sa.dispose(); }
  });
});
