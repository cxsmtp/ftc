"use strict";

// "SHOW ME THIS" LINKS (public/js/features/admin-crossnav.js): a person or a
// challenge clicked in Activity or Rankings is always what the organiser lands on.
//   • inside an event workspace the link stays in the event: its own Participants
//     or Challenges section (the event is not closed);
//   • heading filters (ui/table-columns.js) that would hide the row are cleared,
//     as the status chips always were (Participants, Challenges, Groups);
//   • the People list widens to whoever it would leave out: inside a workspace
//     everyone on the platform (an admin's own answers come from someone who is
//     not a member), outside it the admin accounts (a competing admin is on a board).
// Each arm has a control showing the row was hidden before the link.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { adminLogin, loginViaApi, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const STAMP = Date.now().toString(36);
const W = {};

async function promote(sa, csrf, label) {
  const u = await makeParticipant(sa, csrf, label);
  const r = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(csrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${await r.text()}`).toBeTruthy();
  return u;
}

async function answer(who, compId, taskId, ans) {
  const s = await apiLogin(who.email, PARTICIPANT_PASS);
  try {
    const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf), data: { answer: ans, gradingHash: await gradingHashFor(s.api, taskId) } });
    expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  } finally { await s.api.dispose(); }
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: { name: `Xnav ${STAMP}`, event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 } });
    expect(r.ok(), await r.text()).toBeTruthy();
    W.ev = (await r.json()).competition;
    W.easy = await makeTask(sa, csrf, "xnaveasy", { difficulty: "easy", correct_answer: "right" });
    W.hard = await makeTask(sa, csrf, "xnavhard", { difficulty: "hard", correct_answer: "right" });
    await assignTask(sa, csrf, W.easy.id, [W.ev.id]);
    await assignTask(sa, csrf, W.hard.id, [W.ev.id]);
    W.p = await makeParticipant(sa, csrf, "xnavp");
    await enrol(sa, csrf, W.ev.id, [W.p.id]);
    // An admin who is not a member tries the event's challenge (staff answer without a row).
    W.ad = await promote(sa, csrf, "xnavad");
  } finally { await sa.dispose(); }
  await answer(W.p, W.ev.id, W.easy.id, "right");
  await answer(W.ad, W.ev.id, W.easy.id, "wrong");
});

async function openActivity(page) {
  await adminLogin(page);
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), W.ev.id), { timeout: 15000 }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-submissions-tab" }), { id: W.ev.id, n: W.ev.name });
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(`#admin-submissions-tab [data-action="submissions-open-participant"][data-nickname="${W.p.nickname}"]`).first()).toBeVisible({ timeout: 15000 });
}

const inWorkspaceOn = async (page, section) => {
  await expect(page.locator("#admin-workspace"), "the event is still open").toBeVisible();
  await expect(page.locator(`#ws-tabs .ws-tab[data-section="${section}"]`), "on its own section").toHaveAttribute("aria-current", "page");
};

test("from the event's Activity a person opens in the event's Participants, members and non-members alike", async ({ page }) => {
  await openActivity(page);
  // CONTROL: the event's own list holds its members, so the admin who answered
  // without being one is not in it. (The search is seen to apply: the member's
  // row goes when the admin's name is typed.)
  await page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]').click();
  await expect(page.locator("#p-ws-everyone")).not.toBeChecked();
  const rows = page.locator("#admin-participants-body tr");
  await narrowPeopleTable(page, W.p.nickname);
  await expect(rows.filter({ hasText: W.p.nickname })).toHaveCount(1, { timeout: 15000 });
  await narrowPeopleTable(page, W.ad.nickname);
  await expect(rows.filter({ hasText: W.p.nickname }), "the search applied").toHaveCount(0, { timeout: 15000 });
  await expect(rows.filter({ hasText: W.ad.nickname }), "members only: the admin is not listed").toHaveCount(0);

  // The admin's link: still in the event, on its Participants, widened to show them.
  await page.locator('#ws-tabs .ws-tab[data-section="admin-submissions-tab"]').click();
  await page.locator(`#admin-submissions-tab [data-action="submissions-open-participant"][data-nickname="${W.ad.nickname}"]`).first().click();
  await inWorkspaceOn(page, "admin-participants-tab");
  await expect(page.locator("#participants-search")).toHaveValue(W.ad.nickname);
  await expect(rows.filter({ hasText: W.ad.nickname })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator("#p-ws-everyone"), "the list says it widened").toBeChecked();

  // A member's link: the same section, their row.
  await page.locator('#ws-tabs .ws-tab[data-section="admin-submissions-tab"]').click();
  await page.locator(`#admin-submissions-tab [data-action="submissions-open-participant"][data-nickname="${W.p.nickname}"]`).first().click();
  await inWorkspaceOn(page, "admin-participants-tab");
  await expect(page.locator("#participants-search")).toHaveValue(W.p.nickname);
  await expect(rows.filter({ hasText: W.p.nickname })).toHaveCount(1, { timeout: 15000 });
});

test("a heading filter that would hide the row is cleared: Challenges and Participants", async ({ page }) => {
  await openActivity(page);
  // Challenges: Difficulty = hard hides the easy challenge.
  await page.locator('#ws-tabs .ws-tab[data-section="admin-tasks-tab"]').click();
  await expect(page.locator("#admin-task-body tr").filter({ hasText: W.easy.title }), "PRECONDITION: listed before the filter").toHaveCount(1, { timeout: 15000 });
  await page.locator("#admin-task-table thead th[data-col='difficulty'] .tcol-hbtn").click();
  const pop = page.locator(".tcol-pop[role='dialog']");
  await pop.locator("select").selectOption("hard");
  await pop.locator("[data-tcol-done]").click();
  await expect(page.locator("#admin-task-body tr").filter({ hasText: W.easy.title }), "CONTROL: the filter hides it").toHaveCount(0);
  await page.locator('#ws-tabs .ws-tab[data-section="admin-submissions-tab"]').click();
  await page.locator(`#admin-submissions-tab [data-action="submissions-open-challenge"][data-title="${W.easy.title}"]`).first().click();
  await inWorkspaceOn(page, "admin-tasks-tab");
  await expect(page.locator("#admin-task-body tr").filter({ hasText: W.easy.title })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-clear"), "the heading filter is gone").toBeHidden();

  // Participants: Company contains something nobody's company holds.
  await page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]').click();
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: W.p.nickname }), "PRECONDITION: listed before the filter").toHaveCount(1, { timeout: 15000 });
  await page.locator("#p-table thead th[data-col='company'] .tcol-hbtn").click();
  await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially(`nobody-${STAMP}`, { delay: 10 });
  await page.locator(".tcol-pop [data-tcol-done]").click();
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: W.p.nickname }), "CONTROL: the filter hides them").toHaveCount(0);
  await page.locator('#ws-tabs .ws-tab[data-section="admin-submissions-tab"]').click();
  await page.locator(`#admin-submissions-tab [data-action="submissions-open-participant"][data-nickname="${W.p.nickname}"]`).first().click();
  await inWorkspaceOn(page, "admin-participants-tab");
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: W.p.nickname })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator(".tcol-bar[data-tcols-for='participants'] .tcol-clear")).toBeHidden();
});

// A staff-compete event (sealed challenges only) where an admin competes and answered.
async function competingAdminEvent(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let sc, comp, task;
  try {
    const author = await promote(sa, csrf, `xnavauthor${label}`);
    const a = await apiLogin(author.email, PARTICIPANT_PASS);
    let spareTask;
    try {
      const t = await a.api.post("/api/admin/tasks", { headers: H(a.csrf), data: { title: `Xnav sealed ${label} ${STAMP}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published", answer_sealed: true } });
      expect(t.ok(), `sealed task: ${await t.text()}`).toBeTruthy();
      task = await t.json();
      const t2 = await a.api.post("/api/admin/tasks", { headers: H(a.csrf), data: { title: `Xnav sealed 2 ${label} ${STAMP}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published", answer_sealed: true } });
      expect(t2.ok(), `sealed task 2: ${await t2.text()}`).toBeTruthy();
      spareTask = await t2.json();
    } finally { await a.api.dispose(); }
    const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: { name: `Xnav compete ${label} ${STAMP}`, event_kind: "tournament", staff_compete: true, start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 } });
    expect(r.ok(), await r.text()).toBeTruthy();
    sc = (await r.json()).competition;
    await assignTask(sa, csrf, task.id, [sc.id]);
    await assignTask(sa, csrf, spareTask.id, [sc.id]);
    comp = await promote(sa, csrf, `xnavcomp${label}`);
    await enrol(sa, csrf, sc.id, [comp.id]);
  } finally { await sa.dispose(); }
  await answer(comp, sc.id, task.id, "wrong");
  return { sc, comp };
}

// People has no "Show admin accounts" (owner's decision, 27 Nov 2026: admin
// accounts live on Roles & permissions). A link to one still shows them: that
// one entry lists admin accounts too, and the list says so above the table.
test("from the cross-event Live rankings a competing admin opens in People, the list saying it shows admin accounts", async ({ page }) => {
  test.setTimeout(120_000);
  const { comp } = await competingAdminEvent("sa");

  await adminLogin(page);
  await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
  await narrowPeopleTable(page, comp.nickname);
  await expect(page.locator("#p-include-admins"), "People has no admin-accounts box").toHaveCount(0);
  await expect(page.locator("#p-admins-note"), "PRECONDITION: admin accounts are not shown").toBeHidden();
  // The search applied and matched nobody: the competing admin is not listed.
  await expect(page.locator("#admin-participants-body"), "CONTROL: so the competing admin is not listed").toContainText("No participants match", { timeout: 15000 });
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: comp.nickname })).toHaveCount(0);

  await page.locator('.admin-nav-item[data-tab-id="admin-rankings-tab"]').click();
  const link = page.locator(`#admin-rankings-tab [data-action="rankings-open-participant"][data-nickname="${comp.nickname}"]`).first();
  await expect(link, "PRECONDITION: the competing admin is on the board").toBeVisible({ timeout: 20000 });
  await link.click();
  await expect(page.locator("#admin-participants-tab")).toBeVisible();
  await expect(page.locator("#admin-workspace"), "no event was opened").toBeHidden();
  await expect(page.locator("#p-admins-note"), "the list says it shows admin accounts").toBeVisible();
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: comp.nickname })).toHaveCount(1, { timeout: 15000 });
  // Entering People again from the sidebar lists participants only.
  await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
  await narrowPeopleTable(page, comp.nickname);
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: comp.nickname }), "the next entry leaves them out").toHaveCount(0, { timeout: 15000 });
  await expect(page.locator("#p-admins-note")).toBeHidden();
});

test("an event admin's link to a competing admin on their Live rankings opens that admin in People, saying the list now shows admin accounts", async ({ page }) => {
  test.setTimeout(120_000);
  const { sc, comp } = await competingAdminEvent("ea");
  const { api: sa, csrf } = await apiLogin("superadmin");
  let ea;
  try {
    ea = await makeParticipant(sa, csrf, "xnavea");
    const g = await sa.post(`/api/admin/competitions/${sc.id}/admins`, { headers: H(csrf), data: { userId: ea.id } });
    expect(g.ok(), `grant: ${await g.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
  await loginViaApi(page, ea.email, PARTICIPANT_PASS);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  // CONTROL: the event admin's People list leaves the competing admin out, and
  // offers no admin-accounts box.
  await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
  await expect(page.locator("#p-admins-note"), "PRECONDITION: admin accounts are not shown").toBeHidden();
  await narrowPeopleTable(page, comp.nickname);
  await expect(page.locator("#admin-participants-body"), "CONTROL: so the competing admin is not listed").toContainText("No participants match", { timeout: 15000 });

  await page.locator('.admin-nav-item[data-tab-id="admin-rankings-tab"]').click();
  const link = page.locator(`#admin-rankings-tab [data-action="rankings-open-participant"][data-nickname="${comp.nickname}"]`).first();
  await expect(link, "PRECONDITION: the competing admin is on the event admin's board").toBeVisible({ timeout: 20000 });
  await link.click();
  await expect(page.locator("#admin-participants-tab")).toBeVisible();
  await expect(page.locator("#admin-workspace"), "no event was opened").toBeHidden();
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: comp.nickname }), "the competing admin is shown").toHaveCount(1, { timeout: 15000 });
  await expect(page.locator("#p-admins-note"), "the list says why").toBeVisible();
  // Entering People again leaves them out.
  await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
  await narrowPeopleTable(page, comp.nickname);
  await expect(page.locator("#admin-participants-body tr").filter({ hasText: comp.nickname }), "the next entry: left out").toHaveCount(0, { timeout: 15000 });
});

test("a group link clears the Groups heading filter that would hide it", async ({ page }) => {
  const alpha = `Xnav Alpha ${STAMP}`, beta = `Xnav Beta ${STAMP}`;
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    for (const name of [alpha, beta]) {
      const g = await sa.post("/api/admin/groups", { headers: H(csrf), data: { name } });
      expect(g.ok(), `group ${name}: ${await g.text()}`).toBeTruthy();
    }
  } finally { await sa.dispose(); }
  await adminLogin(page);
  await page.locator('.admin-nav-item[data-tab-id="admin-groups-tab"]').click();
  const rows = page.locator("#groups-tbody tr");
  await expect(rows.filter({ hasText: alpha }), "PRECONDITION: listed before the filter").toBeVisible({ timeout: 15000 });
  await page.locator("table[data-tcols='groups'] thead th[data-col='name'] .tcol-hbtn").click();
  await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially(`Beta ${STAMP}`, { delay: 10 });
  await page.locator(".tcol-pop [data-tcol-done]").click();
  // A plain table hides the rows a filter leaves out (they stay in the DOM).
  await expect(rows.filter({ hasText: beta }), "the filter applied").toBeVisible();
  await expect(rows.filter({ hasText: alpha }), "CONTROL: the filter hides it").toBeHidden();
  // The Rankings group board's link (rankings-open-group) calls this.
  await page.evaluate((n) => window.adminShowGroup(n), alpha);
  await expect(rows.filter({ hasText: alpha })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".tcol-bar[data-tcols-for='groups'] .tcol-clear"), "the heading filter is gone").toBeHidden();
});
