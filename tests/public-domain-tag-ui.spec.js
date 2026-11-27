"use strict";

// THE PUBLIC-DOMAIN MARKER IS OFFERED, NOT TYPED.
//
// v8.8.2 reported: an event admin could not see challenges "marked as public
// domain". The server rule was never broken, but the value had to be typed
// exactly into a free-text box that accepts anything, so "public domain" was
// stored verbatim and granted nothing. v8.8.2 offered the reserved tag as a
// chip; v8.8.3 refused near misses and marked an existing one with a Fix.
//
// STAGE B (owner: "I hate the tags") removed the tag box and the Tags column.
// The marker is now the editor's "Shared with all organisers" switch, in its
// Topic and sharing row, and a look-alike already stored is named beside that
// switch, which repairs it. The same properties are pinned on the new control:
//   * the switch applies EXACTLY the reserved value, and is explained;
//   * it reads ON once applied, and OFF removes exactly that tag (no control
//     whose only effect would be a no-op);
//   * CONTROL — a save that leaves the switch alone writes no marker and keeps
//     every other stored tag (a build applying it to everything fails);
//   * a near miss already stored reads NOT shared, is named beside the switch,
//     and turning the switch on adds the real marker and removes the look-alike;
//     CONTROL — an ordinary tag raises no such note; the note is readable in the
//     LIGHT theme.
//
// public-domain-visibility.api.spec.js pins the RULE the switch satisfies and
// stays green with the switch removed — the reason both halves exist.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, appearanceSettled } = require("./helpers");
const { adminLogin, clickTab, findSeededTaskRow } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = "public-domain";
const uniq = () => `pdui${Date.now().toString(36)}${Math.floor(performance.now() * 1000) % 9973}`;

async function makeTask(api, csrf, label) {
  const title = `PD ${label} ${uniq()}`;
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
  });
  expect(r.ok(), `create task: ${await r.text()}`).toBeTruthy();
  return { id: (await r.json()).id, title };
}

/** The stored tags, read back from the server rather than from the DOM. */
async function storedTags(page, taskId) {
  const r = await page.request.get("/api/admin/tasks");
  expect(r.ok(), `tasks: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the challenge is in the list").toBeTruthy();
  return (row.tags || []).slice().sort();
}

/** Open the challenge's editor at its Topic and sharing row. */
async function openSharing(page, t) {
  const row = await findSeededTaskRow(page, t.title);
  await expect(row.first(), `the challenge "${t.title}" is visible`).toBeVisible();
  await page.evaluate((tid) => /** @type {any} */ (window).editTask(tid), t.id);
  await page.locator('[aria-controls="tf-org-body"]').click();
  const sw = page.locator("#tf-shared");
  await expect(sw, "the Shared with all organisers switch is offered").toBeVisible({ timeout: 15000 });
  return sw;
}
async function saveEdit(page) {
  await page.locator("#save-task-btn").click();
  await expect(page.locator("#admin-task-form")).toBeHidden({ timeout: 15000 });
}

test.describe("Stage B — the public-domain marker is a switch", () => {
  /** @type {any} */ let sa;
  let target, ordinary;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const l = await apiLogin("superadmin");
    sa = l;
    target = await makeTask(l.api, l.csrf, "target");
    ordinary = await makeTask(l.api, l.csrf, "ordinary");
    const r = await l.api.post(`/api/admin/tasks/${ordinary.id}/tags`, { headers: H(l.csrf), data: { tag: "needs-review" } });
    expect(r.ok(), `ordinary tag: ${await r.text()}`).toBeTruthy();
  });

  test("one switch applies EXACTLY the reserved tag, and it is explained", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const sw = await openSharing(page, target);
    await expect(sw, "PRECONDITION: not shared yet").not.toBeChecked();
    // Offered WITH its reason: a switch that silently changes who can see the
    // question would be worse than the typing it replaces.
    await expect(page.locator('#tf-shared-group [aria-label="About Shared with all organisers"]'), "its ? explains it").toHaveCount(1);
    await sw.check();
    await saveEdit(page);
    const tags = await storedTags(page, target.id);
    expect(tags, "the STORED value is the reserved tag, character for character").toContain(TAG);
    expect(tags.some(t => t !== TAG && /public/i.test(t)), "…and no near-miss variant was written").toBe(false);
  });

  test("the switch reads ON once applied, and OFF removes exactly that tag", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    expect(await storedTags(page, target.id), "precondition: already shared").toContain(TAG);
    const sw = await openSharing(page, target);
    await expect(sw, "the switch shows the stored state").toBeChecked();
    await sw.uncheck();
    await saveEdit(page);
    await expect.poll(() => storedTags(page, target.id), { timeout: 10000 }).toEqual([]);
  });

  test("CONTROL — a save that leaves the switch alone writes no marker and keeps every other tag", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const sw = await openSharing(page, ordinary);
    await expect(sw).not.toBeChecked();
    await page.locator("#tf-title").fill(`${ordinary.title} edited`);
    ordinary.title = `${ordinary.title} edited`;
    await saveEdit(page);
    const tags = await storedTags(page, ordinary.id);
    expect(tags, "the free tag the editor never shows is kept").toEqual(["needs-review"]);
    expect(tags, "…and the reserved tag was NOT applied").not.toContain(TAG);
  });
});

// v8.8.3 — a near miss can no longer be typed (the tag route refuses it), but one
// stored before then, or arriving through the deliberately unguarded importer or
// a version restore, is still on the question. It grants nothing, and a soft
// hyphen or a zero-width space renders identically to the real value.
test.describe("v8.8.3, on the switch — a stored near miss is named and repaired", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const plant = (id, tag) => {
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(id, tag); }
    finally { db.close(); }
  };

  test("a near miss reads NOT shared, is named beside the switch, and turning it on repairs it", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "marked");
    plant(t.id, "public domain");   // planted directly, because the route refuses it — which is the point
    await adminLogin(page);
    await clickTab(page, "challenges");
    const row = await findSeededTaskRow(page, t.title);
    await expect(row.first().locator(".badge.shared-pool"), "a near miss is not shared, so no badge").toHaveCount(0);
    const sw = await openSharing(page, t);
    await expect(sw, "the switch reads off").not.toBeChecked();
    const note = page.locator("#tf-shared-nearmiss");
    await expect(note, "the look-alike is named").toBeVisible();
    await expect(note).toContainText("public domain");
    await sw.check();
    await saveEdit(page);
    await expect.poll(() => storedTags(page, t.id), { timeout: 15000 }).toEqual([TAG]);
  });

  test("CONTROL — an ordinary tag raises no near-miss note", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "plain");
    const r = await sa.api.post(`/api/admin/tasks/${t.id}/tags`, { headers: H(sa.csrf), data: { tag: "reuse-2026" } });
    expect(r.ok(), `tag: ${await r.text()}`).toBeTruthy();
    await adminLogin(page);
    await clickTab(page, "challenges");
    await openSharing(page, t);
    expect(await storedTags(page, t.id), "PRECONDITION: the ordinary tag is stored").toEqual(["reuse-2026"]);
    await expect(page.locator("#tf-shared-nearmiss"), "no note for an ordinary tag").toBeHidden();
  });

  test("the near-miss note is readable in the LIGHT theme", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "lightpal");
    plant(t.id, "public­domain");   // a soft hyphen: invisible on screen
    await adminLogin(page);
    await appearanceSettled(page);
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
      try { localStorage.setItem("hck-theme", "light"); } catch (_) {}
    });
    await clickTab(page, "challenges");
    await openSharing(page, t);
    const note = page.locator("#tf-shared-nearmiss");
    await expect(note).toBeVisible();
    const ratio = await note.evaluate((el) => {
      const px = (c) => { const p = c.match(/[\d.]+/g).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const over = (t2, b) => ({ r: t2.r * t2.a + b.r * (1 - t2.a), g: t2.g * t2.a + b.g * (1 - t2.a), b: t2.b * t2.a + b.b * (1 - t2.a), a: 1 });
      const st = [];
      for (let x = el; x && x.nodeType === 1; x = x.parentElement) { const c = px(getComputedStyle(x).backgroundColor); if (c.a > 0) st.push(c); if (c.a >= 1) break; }
      let bg = st.length && st[st.length - 1].a >= 1 ? st.pop() : { r: 255, g: 255, b: 255, a: 1 };
      for (let i = st.length - 1; i >= 0; i--) bg = over(st[i], bg);
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const fg = px(getComputedStyle(el).color);
      const [x, y] = lum(fg) > lum(bg) ? [lum(fg), lum(bg)] : [lum(bg), lum(fg)];
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    });
    expect(ratio, `the note must be readable in light (measured ${ratio}:1)`).toBeGreaterThanOrEqual(4.5);
  });
});
