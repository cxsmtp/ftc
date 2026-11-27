// @ts-check
//
// STAGE B — the Question bank's screens (features/topics-admin.js,
// challenges-admin.js), pinned in a browser:
//
//   1. THE RENAMED COPY: the sidebar item and the page heading read Question
//      bank (the identifiers unchanged), and inside an event the same section
//      reads Questions with "+ Add from bank" and "+ New question".
//   2. THE TOPIC FILTER narrows the bank to one topic (a question in another
//      topic and one with none are left out), No topic to the unfiled; the Topic
//      column shows the name. The tags are not shown anywhere on the row.
//   3. THE TOPICS DIALOG adds a topic, renames it, and deletes a held one only
//      through the move step, moving its questions where it was told.
//   4. THE EDITOR files a question under a topic (stored `topic_id`), and makes a
//      topic in place with + New topic.
//   5. INSIDE AN EVENT: + New question makes the event's OWN question (never a
//      bank row), and Save to bank on it makes a new bank question.
//   6. The client's KNOWN_NEEDS mirrors lib/challenge-fit.js KNOWN_NEEDS.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
const { adminLogin, clickTab, narrowChallengesTable, viewComp } = require("./ui-admin-helpers");
const { H, uniq, makeCompetition, makeTask } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

function ro(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const taskRow = (id) => ro(db => db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
const topicByName = (name) => ro(db => db.prepare("SELECT * FROM topics WHERE name=?").get(name));

let sa, saCsrf, P, tWeb, tApi, qWeb, qApi, qNone;
test.beforeAll(async () => {
  const l = await apiLogin("superadmin");
  sa = l.api; saCsrf = l.csrf;
  P = uniq("TopUI");
  const mk = async (name) => (await (await sa.post("/api/admin/topics", { headers: H(saCsrf), data: { name } })).json()).id;
  tWeb = await mk(`${P} web`); tApi = await mk(`${P} api`);
  qWeb = await makeTask(sa, saCsrf, `${P}-w`, { topic_id: tWeb });
  qApi = await makeTask(sa, saCsrf, `${P}-a`, { topic_id: tApi });
  qNone = await makeTask(sa, saCsrf, `${P}-n`);
  const r = await sa.post(`/api/admin/tasks/${qWeb.id}/tags`, { headers: H(saCsrf), data: { tag: "secret-free-tag" } });
  expect(r.ok()).toBeTruthy();
});
test.afterAll(async () => { await sa.dispose().catch(() => {}); });

const rowTitles = (page) => page.locator("#admin-task-body tr").evaluateAll(rs => rs.map(r => (r.querySelector("td:nth-child(2)") || {}).textContent || "").map(s => s.trim()).filter(Boolean).sort());

test.describe("Stage B — the Question bank", () => {
  test("the page reads Question bank, filters by topic and shows the topic, never the tags", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await expect(page.locator('button.admin-nav-item[data-tab-id="admin-tasks-tab"] .admin-nav-label')).toHaveText("Question bank");
    await expect(page.locator("#tasks-pane-title")).toHaveText("Question bank");
    await expect(page.locator("#new-task-btn-row [data-action='open-task-form']")).toHaveText("+ New question");
    await narrowChallengesTable(page, P);
    await expect.poll(() => rowTitles(page), { timeout: 10000 }).toEqual([qApi.title, qNone.title, qWeb.title].sort());
    // The topic column shows the name; the row carries no tag text at all.
    const webRow = page.locator("#admin-task-body tr", { hasText: qWeb.title });
    await expect(webRow.locator("td[data-col='topic']")).toHaveText(`${P} web`);
    await expect(webRow, "the free tag is not shown on the row").not.toContainText("secret-free-tag");
    await expect(page.locator("#admin-task-table thead th[data-tcol='tags']"), "no Tags column").toHaveCount(0);

    const sel = page.locator("#task-topic-filter");
    await sel.selectOption(tWeb);
    await expect.poll(() => rowTitles(page), { timeout: 5000 }).toEqual([qWeb.title]);
    await sel.selectOption("__none__");
    await expect.poll(() => rowTitles(page), { timeout: 5000 }).toEqual([qNone.title]);
    await sel.selectOption("");
    await expect.poll(() => rowTitles(page), { timeout: 5000 }).toEqual([qApi.title, qNone.title, qWeb.title].sort());
  });

  test("the Topics dialog adds, renames, and deletes a held topic only through the move step", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await page.locator("#task-topics-btn").click();
    const dlg = page.locator("#topics-overlay");
    await expect(dlg.locator("#topics-list")).toContainText(`${P} web`);
    const added = `${P} cloud`;
    await dlg.locator("#topic-new-name").fill(added);
    await dlg.locator("#topic-new-add").click();
    await expect(dlg.locator("#topics-list")).toContainText(added);
    expect(topicByName(added), "the topic was stored").toBeTruthy();

    // Rename it.
    const renamed = `${P} cloud2`;
    await dlg.locator(`[data-topic-act="rename"][aria-label="Rename ${added}"]`).click();
    await page.locator("#prompt-input").fill(renamed);
    await page.locator("#prompt-ok").click();
    await expect(dlg.locator("#topics-list")).toContainText(renamed);
    expect({ old: topicByName(added) ?? null, now: !!topicByName(renamed) }).toEqual({ old: null, now: true });

    // Delete the held web topic: asked where its questions go; Cancel changes nothing.
    await dlg.locator(`[data-topic-act="delete"][aria-label="Delete ${P} web"]`).click();
    await page.locator("#modal-confirm-btn").click();
    const mv = page.locator("#topic-move-overlay");
    await expect(mv, "a held topic asks where its questions go").toBeVisible();
    await mv.locator("#topic-move-cancel").click();
    expect(taskRow(qWeb.id).topic_id, "Cancel: nothing moved").toBe(tWeb);
    expect(topicByName(`${P} web`), "…and nothing deleted").toBeTruthy();
    await dlg.locator(`[data-topic-act="delete"][aria-label="Delete ${P} web"]`).click();
    await page.locator("#modal-confirm-btn").click();
    await mv.locator("#topic-move-to").selectOption(tApi);
    await mv.locator("#topic-move-ok").click();
    await expect.poll(() => taskRow(qWeb.id).topic_id, { timeout: 10000 }).toBe(tApi);
    expect(topicByName(`${P} web`) ?? null, "the topic is gone").toBeNull();
    await dlg.locator("#topics-close").click();
    await expect(dlg).toHaveCount(0);
  });

  test("the editor files a question under a topic, and makes one in place", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate((tid) => !!(window.adminTasksData || []).find(t => t.id === tid), qNone.id), { timeout: 10000 }).toBe(true);
    await page.evaluate((tid) => window.editTask(tid), qNone.id);
    await page.locator('[aria-controls="tf-org-body"]').click();
    await expect(page.locator("#tf-org-sum")).toHaveText("No topic");
    await page.locator("#tf-topic").selectOption(tApi);
    await expect(page.locator("#tf-org-sum")).toHaveText(`${P} api`);
    await page.locator("#save-task-btn").click();
    await expect.poll(() => taskRow(qNone.id).topic_id, { timeout: 10000 }).toBe(tApi);

    // + New topic, in place.
    await expect.poll(() => page.evaluate((tid) => ((window.adminTasksData || []).find(t => t.id === tid) || {}).topic_id, qNone.id), { timeout: 10000 }).toBe(tApi);
    await page.evaluate((tid) => window.editTask(tid), qNone.id);
    await page.locator('[aria-controls="tf-org-body"]').click();
    const fresh = `${P} fresh`;
    await page.locator("#tf-topic-new").click();
    await page.locator("#prompt-input").fill(fresh);
    await page.locator("#prompt-ok").click();
    await expect(page.locator("#tf-topic option:checked")).toHaveText(fresh);
    await page.locator("#save-task-btn").click();
    await expect.poll(() => taskRow(qNone.id).topic_id, { timeout: 10000 }).toBe((topicByName(fresh) || {}).id);
    // CONTROL: the other questions kept theirs.
    expect(taskRow(qApi.id).topic_id).toBe(tApi);
  });

  test("inside an event: Questions, + New question makes the event's own, Save to bank copies it out", async ({ page }) => {
    // Its own API session: a browser's superadmin sign-in ends the file's one.
    const s2 = await apiLogin("superadmin");
    const comp = await makeCompetition(s2.api, s2.csrf, "topui-ev");
    await s2.api.dispose();
    await adminLogin(page);
    await viewComp(page, comp.name);
    await clickTab(page, "Challenges");
    await expect(page.locator('#ws-tabs .ws-tab[data-section="admin-tasks-tab"]')).toContainText("Questions");
    await expect(page.locator("#tasks-pane-title")).toHaveText("Questions");
    await expect(page.locator("#add-tasks-to-comp-btn")).toHaveText("+ Add from bank");
    await expect(page.locator("#task-topics-btn"), "topics are managed on the bank's own page").toBeHidden();

    const title = `${P} Made in event`;
    await page.locator("#new-task-btn-row [data-action='open-task-form']").click();
    await page.locator("#tf-title").fill(title);
    await page.locator("#tf-answer").fill("an-answer");
    await page.locator('[aria-controls="tf-org-body"]').click();
    await expect(page.locator("#tf-shared-group"), "an event's own question has no shared switch").toBeHidden();
    await expect(page.locator("#tf-shared-note")).toBeVisible();
    await page.locator("#save-publish-btn").click();
    await expect.poll(() => ro(db => db.prepare("SELECT COUNT(*) n FROM tasks WHERE title=?").get(title).n), { timeout: 10000 }).toBe(1);
    const rows = ro(db => db.prepare("SELECT id, owner_competition_id FROM tasks WHERE title=?").all(title));
    expect(rows.map(r => r.owner_competition_id), "one question, owned by the event (no bank row)").toEqual([comp.id]);
    const own = rows[0].id;

    const row = page.locator("#admin-task-body tr", { hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    const btn = row.locator('[data-action="task-save-to-bank"]');
    await expect(btn, "Save to bank is offered on the event's own question").toHaveCount(1);
    await btn.evaluate((el) => el.click());
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => ro(db => db.prepare("SELECT owner_competition_id FROM tasks WHERE title=? ORDER BY rowid").all(title).map(r => r.owner_competition_id ?? null)), { timeout: 10000 })
      .toEqual([comp.id, null]);
    expect(taskRow(own).owner_competition_id, "the event's question stays the event's").toBe(comp.id);
    // CONTROL: a bank row listed in the workspace is not offered Save to bank.
    await narrowChallengesTable(page, P);
    const bankRow = page.locator("#admin-task-body tr", { hasText: qApi.title }).first();
    await expect(bankRow).toBeVisible({ timeout: 10000 });
    await expect(bankRow.locator('[data-action="task-save-to-bank"]')).toHaveCount(0);
  });

  test("the client's KNOWN_NEEDS mirrors the server's", async ({ page }) => {
    await adminLogin(page);
    const client = await page.evaluate(() => ({ ...(window.KNOWN_NEEDS || {}) }));
    const { KNOWN_NEEDS } = require("../lib/challenge-fit");
    expect(Object.keys(client).length, "anti-vacuity: the client copy is on window").toBeGreaterThan(0);
    expect(client).toEqual({ ...KNOWN_NEEDS });
  });
});
