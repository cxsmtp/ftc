// The event workspace's Overview as a live command centre:
//  (1) GET /api/admin/competitions/:id/overview-pulse is SCOPED — an event
//      admin reads their own event, is refused a decoy (and an unknown id, with
//      the same answer), a superadmin control reads both; the payload carries
//      no answer text, and only the asked event's activity (asserted by value);
//  (2) a global admin adds and removes an organiser from the Organisers card
//      (asserted by API state), while an event admin sees the list read-only,
//      no add control, and the reason;
//  (3) the challenge list and each row's facts open IN PLACE (aria-expanded,
//      content appears, focus stays on the toggle);
//  (4) reduced motion paints the KPI figures' final values at once, while the
//      default count-up does not (control).
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE, gradingHashFor } = require("./helpers");
const { adminLogin, loginViaApi, clickTab, viewComp, openOverviewDetail } = require("./ui-admin-helpers");
const { H, buildWorld, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `zebra-key-${stamp}`;
const WRONG = `wrong-guess-${stamp}`;
let W;                 // the event-admin world (mine / theirs / ea / zero / inMine / inTheirs)
let taskA, taskB, taskD, cand, p2;
const extraTasks = [];

async function solve(email, compId, taskId, answer) {
  const s = await apiLogin(email, PARTICIPANT_PASS);
  try {
    const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
    const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf),
      data: { answer, gradingHash: await gradingHashFor(s.api, taskId) } });
    expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  } finally { await s.api.dispose(); }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  W = await buildWorld();
  const { sa, saCsrf } = W;
  // mine: two challenges (one stays unsolved, so the event never auto-ends —
  // fixture item 1), plus eight more for the in-place list; theirs: a decoy.
  taskA = await makeTask(sa, saCsrf, "ovA", { correct_answer: KEY });
  taskB = await makeTask(sa, saCsrf, "ovB", { correct_answer: KEY, difficulty: "hard" });
  taskD = await makeTask(sa, saCsrf, "ovDecoy", { correct_answer: KEY });
  await assignTask(sa, saCsrf, taskA.id, [W.mine.id]);
  await assignTask(sa, saCsrf, taskB.id, [W.mine.id]);
  await assignTask(sa, saCsrf, taskD.id, [W.theirs.id]);
  for (let i = 0; i < 8; i++) {
    const t = await makeTask(sa, saCsrf, `ovX${i}`, { correct_answer: KEY });
    await assignTask(sa, saCsrf, t.id, [W.mine.id]);
    extraTasks.push(t);
  }
  p2 = await makeParticipant(sa, saCsrf, "ovp2");
  await enrol(sa, saCsrf, W.mine.id, [p2.id]);
  cand = await makeParticipant(sa, saCsrf, `ovcand${stamp}`);
  const ok = await solve(W.inMine.email, W.mine.id, taskA.id, KEY);
  expect(ok.correct, "inMine solves A").toBe(true);
  const bad = await solve(p2.email, W.mine.id, taskB.id, WRONG);
  expect(bad.correct, "p2 answers B wrong").toBe(false);
  const dec = await solve(W.inTheirs.email, W.theirs.id, taskD.id, KEY);
  expect(dec.correct, "the decoy event has its own solve").toBe(true);
  // challenge_events are written post-commit: poll until both events show them.
  await expect.poll(async () => {
    const d = await (await sa.get(`/api/admin/competitions/${W.mine.id}/overview-pulse`)).json();
    return d.totals && d.totals.answers;
  }, { timeout: 15000, message: "mine's two answers reach the pulse" }).toBe(2);
});

test.afterAll(async () => {
  if (!W) return;
  // A fresh session: the browser sign-ins above ended W.sa's.
  const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
  for (const c of [W.mine, W.theirs]) await sa.delete(`/api/admin/competitions/${c.id}`, { headers: H(saCsrf) }).catch(() => {});
  for (const p of [W.ea, W.zero, W.inMine, W.inTheirs, p2, cand].filter(Boolean)) await sa.delete(`/api/admin/participants/${p.id}`, { headers: H(saCsrf) }).catch(() => {});
});

test("overview-pulse is scoped; no answer text; only the asked event's activity", async () => {
  const { sa } = W;
  const mine = await (await sa.get(`/api/admin/competitions/${W.mine.id}/overview-pulse`)).json();
  expect(mine.ok).toBe(true);
  expect(mine.totals).toMatchObject({ answers: 2, correct: 1, solvers: 1 });
  expect(mine.totals.joined, "both enrolled participants are counted").toBe(2);
  const tA = mine.tasks.find(t => t.id === taskA.id);
  expect(tA, "challenge A is listed").toMatchObject({ attempters: 1, solvers: 1, answers: 1 });
  expect(mine.tasks.find(t => t.id === taskB.id)).toMatchObject({ attempters: 1, solvers: 0, answers: 1 });
  expect(mine.buckets.reduce((n, b) => n + b.answers, 0), "the series adds up to the total").toBe(2);
  expect(mine.recent.some(r => r.type === "solved" && r.nickname === W.inMine.nickname && r.task_title === taskA.title), "the solve is in the feed").toBe(true);
  const body = JSON.stringify(mine);
  for (const secret of [KEY, WRONG]) expect(body, `no answer text (${secret}) in the payload`).not.toContain(secret);
  // Only this event: the decoy's challenge and solver appear nowhere (by value).
  expect(body).not.toContain(taskD.title);
  expect(body).not.toContain(W.inTheirs.nickname);

  // Superadmin CONTROL: the decoy is readable and carries its own activity.
  const theirs = await (await sa.get(`/api/admin/competitions/${W.theirs.id}/overview-pulse`)).json();
  expect(JSON.stringify(theirs)).toContain(taskD.title);
  expect(theirs.recent.some(r => r.nickname === W.inTheirs.nickname)).toBe(true);

  // The event admin: own event yes, the decoy and an unknown id refused alike.
  const own = await W.eaApi.get(`/api/admin/competitions/${W.mine.id}/overview-pulse`);
  expect(own.status()).toBe(200);
  expect((await own.json()).totals.answers).toBe(2);
  const dec = await W.eaApi.get(`/api/admin/competitions/${W.theirs.id}/overview-pulse`);
  expect(dec.status(), "the decoy is refused").toBe(403);
  const decBody = await dec.text();
  expect(decBody).not.toContain(taskD.title);
  expect(decBody).not.toContain(W.inTheirs.nickname);
  const ghost = await W.eaApi.get(`/api/admin/competitions/no-such-event-${stamp}/overview-pulse`);
  expect(ghost.status(), "an unknown id answers as the decoy does (scope before existence)").toBe(403);
  const zero = await W.zeroApi.get(`/api/admin/competitions/${W.mine.id}/overview-pulse`);
  expect(zero.status(), "a zero-grant event admin sees nothing").toBe(403);
  // Superadmin, unknown id: a plain 404.
  expect((await sa.get(`/api/admin/competitions/no-such-event-${stamp}/overview-pulse`)).status()).toBe(404);
});

test("a global admin adds and removes an organiser from the Overview's Organisers card", async ({ page }) => {
  // Read through the PAGE's session: the browser sign-in ends every other
  // superadmin session (one session per principal), W.sa's included.
  const orgIds = async () => {
    const r = await page.request.get(`/api/admin/competitions/${W.mine.id}/admins`);
    expect(r.ok(), `the organiser list read: ${r.status()}`).toBeTruthy();
    return ((await r.json()).admins || []).map(a => a.id);
  };
  await adminLogin(page);
  expect(await orgIds(), "PRECONDITION: the candidate does not organise the event").not.toContain(cand.id);
  expect(await orgIds(), "PRECONDITION: the event admin does").toContain(W.ea.id);
  await clickTab(page, "Events");
  await viewComp(page, W.mine.name);
  await openOverviewDetail(page);
  const card = page.locator("#ws-ov-orgs");
  await expect(card, "the existing organiser is listed").toContainText(W.ea.email, { timeout: 15000 });
  await expect(card.locator(`[data-action="ws-org-remove"][data-user-id="${W.ea.id}"]`), "each organiser has Remove").toBeVisible();
  const search = page.locator("#ws-org-search");
  await expect(search, "the add picker is offered to a global admin").toBeVisible();
  await search.pressSequentially(cand.email.split("@")[0], { delay: 20 });
  const pick = page.locator(`#ws-org-results [data-action="ws-org-add"][data-user-id="${cand.id}"]`);
  await expect(pick, "the candidate is found").toBeVisible({ timeout: 15000 });
  // Granting changes a participant's role and signs them out everywhere, so it
  // is confirmed first. Cancel grants nothing (asserted by API state).
  await pick.click();
  const modal = page.locator("#modal-overlay.open");
  await expect(modal, "picking someone asks first").toBeVisible();
  await expect(page.locator("#modal-body"), "the confirm says what the grant does to a participant's account").toContainText("signed out everywhere");
  await page.locator("#modal-cancel-btn").click();
  await expect(modal).toHaveCount(0);
  expect(await orgIds(), "Cancel granted nothing").not.toContain(cand.id);
  await expect(page.locator("#ws-ov-orgs-msg"), "and reported nothing").toHaveText("");
  await pick.click();
  await expect(modal).toBeVisible();
  await page.locator("#modal-confirm-btn").click();
  // The outcome line names what happened (a refusal would show its reason here).
  await expect(page.locator("#ws-ov-orgs-msg")).toContainText("is now an organiser", { timeout: 15000 });
  await expect.poll(orgIds, { timeout: 15000, message: "the grant reached the server" }).toContain(cand.id);
  await expect(card, "the card re-reads and lists the new organiser").toContainText(cand.email, { timeout: 15000 });

  await card.locator(`[data-action="ws-org-remove"][data-user-id="${cand.id}"]`).click();
  await expect(page.locator("#modal-overlay.open")).toBeVisible();
  await page.locator("#modal-confirm-btn").click();
  await expect.poll(orgIds, { timeout: 15000, message: "the revoke reached the server" }).not.toContain(cand.id);
  await expect(card).not.toContainText(cand.email, { timeout: 15000 });
  // CONTROL: removing one left the other alone.
  expect(await orgIds()).toContain(W.ea.id);
});

test("an event admin sees the organisers read-only, with the reason and no add control", async ({ page }) => {
  await loginViaApi(page, W.ea.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await clickTab(page, "Events");
  await viewComp(page, W.mine.name);
  await openOverviewDetail(page);
  const card = page.locator("#ws-ov-orgs");
  await expect(card, "the list is shown").toContainText(W.ea.email, { timeout: 15000 });
  await expect(page.locator("#ws-ov-orgs-add .ws-org-reason")).toHaveText("Only an administrator can add or remove organisers.");
  await expect(page.locator("#ws-org-search"), "no add picker").toHaveCount(0);
  await expect(page.locator('[data-action="ws-org-remove"]'), "no Remove control").toHaveCount(0);
});

test("the challenge list and a challenge's facts open in place; focus stays on the toggle", async ({ page }) => {
  await adminLogin(page);
  await clickTab(page, "Events");
  await viewComp(page, W.mine.name);
  await openOverviewDetail(page);
  const list = page.locator("#ws-ov-tasks");
  const rows = list.locator('[data-action="ws-task-facts"]');
  await expect(rows, "six challenges show at first").toHaveCount(6, { timeout: 20000 });
  const more = page.locator("#ws-ov-tasks-more");
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toHaveText("Show 4 more");
  await more.click();
  await expect(rows, "all ten open in place").toHaveCount(10);
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(more, "focus stays on the toggle").toBeFocused();
  await expect(page.locator("#admin-event-overview-tab"), "still on the Overview").toBeVisible();

  const toggle = list.locator(`[data-action="ws-task-facts"][data-task-id="${taskA.id}"]`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(`#ws-tf-${taskA.id}`);
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Points");
  await expect(panel).toContainText("50");
  await expect(panel, "the pulse's solve count is in the facts").toContainText("1 of 1 who tried", { timeout: 15000 });
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();

  await more.click();
  await expect(rows, "Show fewer folds it back").toHaveCount(6);
  // The live parts painted from the pulse.
  await expect(page.locator("#ws-ov-rates")).toContainText("1 of 1 · 100%");
  await expect(page.locator("#ws-ov-ticker")).toContainText(W.inMine.nickname);
  await expect(page.locator("#ws-ov-chart figcaption")).toContainText("2 answers (1 correct)");
});

// Every value the Joined and Answers figures show. Answers is the one that
// proves the count-up: its first figure comes from the live read, so it counts
// up from 0 there, while Joined (the roster) is drawn before the read answers
// and a re-render can land it at once.
async function recordKpiCounts(page) {
  await page.addInitScript(() => {
    window.__kpiSeen = { joined: [], answers: [] };
    new MutationObserver(() => {
      for (const k of ["joined", "answers"]) for (const el of document.querySelectorAll(`.ws-count[data-kpi="${k}"]`)) window.__kpiSeen[k].push(el.textContent);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

test("reduced motion: the KPI figures are final at once; the default counts up (control)", async ({ browser }) => {
  for (const reduced of [true, false]) {
    const ctx = await browser.newContext({ baseURL: BASE, reducedMotion: reduced ? "reduce" : "no-preference" });
    const page = await ctx.newPage();
    try {
      await recordKpiCounts(page);
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, W.mine.name);
  await openOverviewDetail(page);
      const joined = page.locator('.ws-kpi[data-kpi-tile="joined"] .ws-count');
      await expect(joined).toHaveAttribute("data-count", "2", { timeout: 15000 });
      await expect(joined, "the figure settles on its value").toHaveText("2");
      await expect(page.locator('.ws-kpi[data-kpi-tile="answers"] .ws-count'), "the live Answers figure arrives").toHaveText("2", { timeout: 15000 });
      const seen = await page.evaluate(() => window.__kpiSeen);
      expect(seen.answers.length, "the observer saw the live figure").toBeGreaterThan(0);
      if (reduced) {
        expect([...seen.joined, ...seen.answers].filter(v => v !== "2"), "reduced motion never shows an in-between value").toEqual([]);
        expect(await page.locator(".ws-kpi-flash").count(), "and no flash").toBe(0);
      } else {
        expect(seen.answers, "CONTROL: the default counts up from 0, through the value between").toEqual(expect.arrayContaining(["0", "1"]));
      }
    } finally { await ctx.close(); }
  }
});
