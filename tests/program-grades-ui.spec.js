// PROGRAM GRADES ON THE LEARNER'S SCREEN (owner decision, 27 Nov 2026): "the
// program should tell you where you stand". The Challenges page's certificate
// card (badge-share.js renderCertificateCta) names a learner's grade; under 60%
// it says to try the quiz again and offers Try again, which starts a fresh
// attempt; at 60% or more the claim names the grade. Every value is the
// server's (GET /api/me/certificates `programs`); the API half is
// tests/program-grades.api.spec.js.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

/** A live Program with one easy challenge (answer "right", a hint), the learner enrolled. */
async function programFor(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const c = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `PGUI ${uniq(label)}`, event_kind: "program", start_time: new Date(Date.now() - 60_000).toISOString(),
      deadline_at: new Date(Date.now() + 30 * 86400e3).toISOString(), timezone: "UTC", add_qualifying: false } });
    expect(c.ok(), await c.text()).toBeTruthy();
    const comp = (await c.json()).competition;
    const t = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `PGUI ${uniq(label)}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right",
      hint: "<p>a hint</p>", status: "published" } });
    expect(t.ok(), await t.text()).toBeTruthy();
    const a = await sa.post(`/api/admin/tasks/${(await t.json()).id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(a.ok(), await a.text()).toBeTruthy();
    const taskId = (await a.json()).copies[0].task_id;
    const p = await makeParticipant(sa, csrf, label);
    await enrol(sa, csrf, comp.id, [p.id]);
    return { comp, taskId, p };
  } finally { await sa.dispose(); }
}

/** Answer as the learner through the real doors; `hint` first when asked. */
async function play(p, compId, taskId, { hint = false, wrong = 0 } = {}) {
  const s = await apiLogin(p.email);
  try {
    const h = { ...H(s.csrf), "x-competition-id": compId };
    expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
    if (hint) expect((await s.api.post(`/api/tasks/${taskId}/hint`, { headers: h })).ok()).toBeTruthy();
    const send = async (answer) => {
      const v = await (await s.api.get(`/api/tasks/${taskId}`, { headers: { "x-competition-id": compId } })).json();
      const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: h, data: { answer, gradingHash: v.grading_hash || "" } });
      expect(r.ok(), await r.text()).toBeTruthy();
    };
    for (let i = 0; i < wrong; i++) await send(`wrong-${i}`);
    await send("right");
  } finally { await s.api.dispose(); }
}

test("under 60% the card says to try the quiz again; Try again starts a fresh attempt and the card shows where they stand", async ({ page }) => {
  const f = await programFor("low");
  await play(f.p, f.comp.id, f.taskId, { hint: true, wrong: 3 });   // 50 − 15 − 15 = 20 of 50: 40%
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  const cta = page.locator("#cert-cta");
  await expect(cta).toBeVisible({ timeout: 20000 });
  await expect(cta).toContainText("Your grade: 40%");
  await expect(cta).toContainText("try the quiz again");
  await expect(cta).toContainText("A certificate needs 60% or more");
  const again = cta.locator('[data-action="program-retake"]');
  await expect(again).toHaveText("Try again");
  await again.click();
  const overlay = page.locator("#modal-overlay");
  await expect(overlay).toContainText("Try the program again?");
  await overlay.getByRole("button", { name: "Try again" }).click();
  await expect(cta, "a fresh attempt: nothing earned yet").toContainText("Where you stand: 0%", { timeout: 15000 });
  await expect(cta).toContainText("This is attempt 2.");
  await expect(cta).toContainText("Your last attempt ended on 40%.");
  await expect(cta.locator('[data-action="program-retake"]'), "no Try again mid-attempt").toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window.S.allTasks || []).map((t) => !!t.solved)),
    { message: "the challenge is open again" }).toEqual([false]);
});

test("at 60% or more the claim names the grade (control: no Try again)", async ({ page }) => {
  const f = await programFor("high");
  await play(f.p, f.comp.id, f.taskId, { wrong: 2 });               // 50 − 10 = 40 of 50: 80%
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  const cta = page.locator("#cert-cta");
  await expect(cta).toBeVisible({ timeout: 20000 });
  await expect(cta).toContainText("Your certificate is ready");
  await expect(cta).toContainText("with a grade of Very good (80%)");
  await expect(cta.locator('[data-action="program-retake"]')).toHaveCount(0);
});

test("the organisers' Rankings on a Program lists each learner's grade under Progress", async ({ page }) => {
  const { adminLogin, clickTab } = require("./ui-admin-helpers");
  const f = await programFor("org");
  await play(f.p, f.comp.id, f.taskId, { hint: true, wrong: 3 });   // 40%, finished
  await adminLogin(page);
  await clickTab(page, "Events");
  await page.evaluate((id) => { window.S.adminRankingsCompId = id; }, f.comp.id);
  await clickTab(page, "Rankings");
  await page.evaluate(() => window.loadAdminLeaderboard());
  const grades = page.locator("#admin-rankings-content #rk-grades");
  await expect(grades).toContainText("Grades");
  const row = grades.locator(`.rk-grade-row[data-user-id="${f.p.id}"]`);
  await expect(row, "the learner's line, by value").toContainText("40% · Try again");
  await expect(row).toHaveAttribute("data-band", "try_again");
  await expect(grades, "out of the Program's maximum").toContainText("out of 50");
});
