// v8.1.0 — PR 23: what a participant actually sees when a challenge is capped.
//
// THE LOAD-BEARING TEST HERE IS THE FIRST ONE. The refusal is a 200 (a non-429
// 4xx would feed the scanner-reputation counter and can ban a whole venue), so a
// client that does not branch on `d.refused` BEFORE its existing `if (!d.correct)`
// renders "Incorrect. −5 pts penalty." and announces a penalty the server never
// took. Everything else in this file is the affordance matching the rule.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `au${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A live competition with ONE capped challenge, and an enrolled participant. */
async function fixture(api, csrf, cap) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
            duration_minutes: 600, timezone: "UTC" },
  });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const comp = (await cr.json()).competition;

  const title = `${uniq()} Capped`;
  const tr = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title, description: "answer it", difficulty: "easy", answer_type: "text",
            correct_answer: "correct-one", status: "published", attempt_cap: cap },
  });
  expect(tr.ok(), await tr.text()).toBeTruthy();
  const taskId = (await tr.json()).id;
  expect(taskId).toBeTruthy();
  const asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
  expect(asg.ok(), await asg.text()).toBeTruthy();

  // Two participants: the second never submits, so the all-solved auto-end
  // cannot end the competition underneath the test.
  const users = [];
  for (let i = 0; i < 2; i++) {
    const label = uniq();
    const email = `${label}@company.example`;
    const reg = await registerPost(api, "/api/register", {
      headers: H(csrf),
      data: { firstName: "Cap", lastName: "UI", nickname: label, email,
              company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
              password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" },
    });
    expect(reg.status(), await reg.text()).toBe(200);
    const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
    const u = (list.participants || []).find(p => p.email === email);
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
    users.push({ id: u.id, email });
  }
  const asg2 = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [comp.id] },
  });
  expect(asg2.ok(), await asg2.text()).toBeTruthy();
  expect((await asg2.json()).assigned).toBe(2);
  return { comp, taskId, title, users };
}

/** Sign in through the browser and open the challenge detail view. */
async function openChallenge(page, f) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await codeLogin(page.request, f.users[0].email, H(csrfToken));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: f.comp.id } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  // Establish the session BEFORE navigating (v7.21.26): an anonymous SPA started
  // first would 401 its polls the instant the login regenerates the session, and
  // its interceptor would log that session out.
  await page.goto("/");
  // v8.1.0 — WAIT FOR THE CHALLENGE'S OWN CARD, not for the nav.
  //
  // Seen once as a flake whose diagnostic named it outright: `#ans-text` present
  // but HIDDEN, with the active page reported as `tasks-page`. `showMain()`
  // reveals `#main-nav` for ANY main page, so the old signal went true partway
  // through boot — `openTask` then switched to the detail view and boot's own
  // later `showMain('tasks-page')` (main.js, the enter-competition routing) yanked
  // it straight back to the list. The wait for `#task-detail-page.active`
  // succeeded, because the bounce happened after it.
  //
  // A card carrying THIS challenge's id cannot exist before `loadTasks` has
  // rendered, which is after boot has finished routing — the v7.22.0 rule that a
  // settle signal must be something that cannot be true before this entry's JS has
  // run. Clicking it is also the path a participant actually takes.
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  const card = page.locator(`#task-grid [data-task-id="${f.taskId}"]`);
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.click();
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
  // And it STAYED there — a late bounce is exactly what this helper exists to
  // rule out, so prove the view is stable rather than merely reached.
  await expect(page.locator("#ans-text, .attempts-exhausted").first()).toBeVisible({ timeout: 15000 });
}

/**
 * Type an answer and confirm the submit dialog.
 *
 * v8.1.0 — every wait REPORTS THE VIEW on failure. Seen once as a bare
 * "Test timeout of 60000ms exceeded" with nothing else, which is true of four
 * different situations: the challenge never opened, the panel already locked so
 * there is no input, the confirm never appeared, or the confirm appeared with
 * different copy. No mechanism is claimed — it did not reproduce in three
 * repeats — but the next occurrence will name itself instead of costing another
 * round (the v7.21.34 rule: stop widening, start explaining).
 */
async function answer(page, text) {
  const view = async () => JSON.stringify(await page.evaluate(() => ({
    page: (document.querySelector(".page.active") || {}).id || "none",
    hasInput: !!document.getElementById("ans-text"),
    hasSubmit: !!document.querySelector('[data-action="task-submit-answer"]'),
    locked: !!document.querySelector(".attempts-exhausted"),
    attemptsBox: (document.querySelector(".attempts-left") || {}).textContent || null,
    modal: (() => { const m = document.getElementById("modal-overlay"); return m && m.className.includes("open") ? (m.textContent || "").replace(/\s+/g, " ").slice(0, 120) : null; })(),
    toast: [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()).slice(-1)[0] || null,
  })));
  await page.locator("#ans-text").waitFor({ state: "visible", timeout: 15000 })
    .catch(async (e) => { throw new Error(`answer(): no answer input. View: ${await view()}\n${e.message}`); });
  await page.locator("#ans-text").fill(text);
  await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
  await page.locator("#modal-overlay").waitFor({ state: "visible", timeout: 15000 })
    .catch(async (e) => { throw new Error(`answer(): the submit confirm never appeared. View: ${await view()}\n${e.message}`); });
  await page.locator("#modal-overlay button:has-text('Submit')").first().click({ timeout: 10000 })
    .catch(async (e) => { throw new Error(`answer(): the confirm has no Submit button. View: ${await view()}\n${e.message}`); });
}

test.describe("v8.1.0 — the attempt budget on the participant's screen", () => {
  test("a refusal does NOT claim a penalty that was never taken", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 1);
      await openChallenge(page, f);
      await expect(page.locator("#ans-text"), "the input is live to begin with").toBeVisible();

      // SPEND THE ATTEMPT SOMEWHERE ELSE, so this page is a stale tab holding a
      // live input over a budget that is already gone. That is the only way the
      // client's own submit path ever RECEIVES a refusal — once the panel has
      // locked there is no input left to submit from — and it is a real
      // situation: a second tab, or a page left open while an organiser watched.
      const spent = await page.request.post(`/api/tasks/${f.taskId}/submit`, {
        headers: { "x-csrf-token": (await (await page.request.get("/api/csrf-token")).json()).csrfToken },
        multipart: {
          answer: "spent-elsewhere",
          // REQUIRED since v7.20.9 F1 — a submit with no grading token is 409
          // `task_changed` before anything else is examined, so a probe that
          // omitted it would measure that refusal and prove nothing about the cap.
          gradingHash: (await (await page.request.get(`/api/tasks/${f.taskId}`)).json()).grading_hash || "",
        },
      });
      expect(spent.ok(), `the attempt was spent: ${await spent.text()}`).toBeTruthy();

      // Now submit from the stale page, through the app's own handler.
      await answer(page, "too-late");
      // The outcome is a TOAST, deliberately: the refusal re-renders the card
      // into its locked state, so anything written into `#submit-result` would be
      // destroyed by that same re-render — it would flash and vanish, which is
      // worse than saying nothing.
      const toast = page.locator(".toast").last();
      await expect(toast).toContainText(/No attempts left/i, { timeout: 15000 });
      // THE ASSERTION THIS FILE EXISTS FOR. The refusal is a 200 (a non-429 4xx
      // would feed the scanner-reputation counter and can ban a whole venue), so
      // a client that tested `!d.correct` first would render "Incorrect. −5 pts
      // penalty." and announce a penalty the server never took.
      await expect(toast, "a 200 refusal must not fall into the incorrect branch")
        .not.toContainText(/pts penalty/i);
      await expect(page.locator("#task-detail-card"), "…nor anywhere on the card")
        .not.toContainText(/pts penalty/i);
      await expect(page.locator(".attempts-exhausted"), "and the panel is locked").toBeVisible();
      // …and the score really did not move.
      const me = await (await page.request.get("/api/me")).json();
      expect(me.score, "no penalty was taken").toBe(-5); // exactly the ONE wrong answer above
    } finally { await api.dispose(); }
  });

  test("the count is shown, and the LAST attempt is called out", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 3);
      await openChallenge(page, f);
      const box = page.locator(".attempts-left");
      await expect(box).toContainText("3 of 3 attempts left");
      // Quiet at three, quiet at two…
      await answer(page, "w1");
      await expect(page.locator("#submit-result")).toContainText(/2 attempts left/i, { timeout: 15000 });
      await page.evaluate((id) => window.openTask(id), f.taskId);
      await expect(box).toContainText("2 of 3 attempts left");
      await expect(box, "two left is not urgent").not.toHaveClass(/attempts-last/);

      // …and loud at one, because that is the only irreversible moment.
      await answer(page, "w2");
      await page.evaluate((id) => window.openTask(id), f.taskId);
      await expect(box).toContainText(/Last attempt/i);
      await expect(box).toHaveClass(/attempts-last/);
    } finally { await api.dispose(); }
  });

  test("the input is REPLACED by a locked panel, not left live", async ({ page }) => {
    // An input in front of a submission that can only be refused is an affordance
    // that lies. The same rule the ended-competition branch already follows.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 1);
      await openChallenge(page, f);
      await expect(page.locator("#ans-text"), "the input is there to begin with").toBeVisible();
      await answer(page, "the-only-one");
      await expect(page.locator(".attempts-exhausted"), "the locked panel replaces it").toBeVisible({ timeout: 15000 });
      await expect(page.locator("#ans-text")).toHaveCount(0);
      await expect(page.locator('[data-action="task-submit-answer"]')).toHaveCount(0);
      await expect(page.locator(".attempts-exhausted")).toContainText(/all 1 attempts/i);
    } finally { await api.dispose(); }
  });

  test("an admin grant puts the input back", async ({ page }) => {
    // The recovery half. Without it, "the panel locks" is a dead end rather than
    // a recoverable state.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 1);
      await openChallenge(page, f);
      await answer(page, "burn-it");
      await expect(page.locator(".attempts-exhausted")).toBeVisible({ timeout: 15000 });

      const g = await api.post(`/api/admin/tasks/${f.taskId}/attempt-grant`, {
        headers: H(csrf), data: { userId: f.users[0].id, competitionId: f.comp.id, extra: 1 },
      });
      expect(g.ok(), `grant: ${g.status()} ${await g.text()}`).toBeTruthy();

      await page.evaluate((id) => window.openTask(id), f.taskId);
      await expect(page.locator("#ans-text"), "the participant can act again").toBeVisible({ timeout: 15000 });
      await expect(page.locator(".attempts-exhausted")).toHaveCount(0);
      // The count reflects base + grant, never the base.
      await expect(page.locator(".attempts-left")).toContainText(/Last attempt/i);
      await answer(page, "correct-one");
      // Scoped to the congrats dialog by its own heading: a bare
      // `.result-msg.correct` also matches the REGISTER page's "If an account
      // with that email…" line, which is still in the DOM on an SPA sign-in —
      // measured, it resolved to that and waited 15 s for it to become visible.
      await expect(page.locator("h2:has-text('Challenge Solved!')")).toBeVisible({ timeout: 15000 });
    } finally { await api.dispose(); }
  });

  test("an UNCAPPED challenge shows no budget at all — the control", async ({ page }) => {
    // Without this, every assertion above is equally satisfied by a build that
    // renders the budget unconditionally.
    const { api, csrf } = await sa();
    try {
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${uniq()} Free`, start_time: new Date(Date.now() - 3600e3).toISOString(),
                duration_minutes: 600, timezone: "UTC" },
      });
      const comp = (await cr.json()).competition;
      const tr = await api.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title: `${uniq()} Uncapped`, description: "d", difficulty: "easy", answer_type: "text",
                correct_answer: "correct-one", status: "published" },
      });
      const taskId = (await tr.json()).id;
      await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      const label = uniq(); const email = `${label}@company.example`;
      await registerPost(api, "/api/register", {
        headers: H(csrf),
        data: { firstName: "No", lastName: "Cap", nickname: label, email,
                company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
                password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" },
      });
      const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
      const u = (list.participants || []).find(p => p.email === email);
      await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
      await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
      const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [comp.id] } });
      expect((await asg.json()).assigned).toBe(1);

      await openChallenge(page, { comp, taskId, users: [{ email }] });
      await expect(page.locator(".attempts-left")).toHaveCount(0);
      await expect(page.locator(".attempts-exhausted")).toHaveCount(0);
      await answer(page, "still-wrong");
      await expect(page.locator("#submit-result")).toContainText(/pts penalty/i, { timeout: 15000 });
      await expect(page.locator("#submit-result"),
        "and no attempt count is invented for an uncapped challenge").not.toContainText(/attempts? left/i);
      await expect(page.locator("#ans-text"), "the input stays live").toBeVisible();
    } finally { await api.dispose(); }
  });

  test("an admin can SET and CLEAR the cap from the forms, on both levels", async ({ page }) => {
    // NEITHER PR 22 (server) NOR PR 23 (participant) included an admin control,
    // so a cap could only be set through the API — a feature no operator can
    // reach. These two inputs close that, and this is the lock that they really
    // round-trip rather than merely rendering.
    //
    // EVERY read goes through `page.request`, never a second API context: signing
    // in twice as the same principal trips the single-session rule and silently
    // kills the first session, which surfaces as `all.find is not a function`
    // when an error object arrives where the list was expected (v7.19.0).
    const { adminLogin, clickTab, viewComp, openCompCreateForm } = require("./ui-admin-helpers");
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const tasks = async () => (await (await page.request.get("/api/admin/tasks")).json());
    const comps = async () => (await (await page.request.get("/api/admin/competitions")).json());

    // ── challenge level ──────────────────────────────────────────────────────
    await clickTab(page, "Challenges");
    const title = `${uniq()} FormCap`;
    // Through the app's own entry point rather than a guessed button selector.
    await page.evaluate(() => window.openTaskForm());
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#tf-title").fill(title);
    await page.locator("#tf-answer").fill("a");
    await page.locator("#tf-attempt-cap").fill("4");
    // CREATE shows Save-as-Draft / Save-and-Publish; EDIT shows a single "Save
    // Challenge" and hides the other two. Click whichever is actually visible
    // rather than pinning one id and timing out on the other form.
    await page.locator('[data-action="save-task"]:visible').last().click();

    await expect.poll(async () => ((await tasks()).find(t => t.title === title) || {}).attempt_cap ?? null,
      { timeout: 15000, message: "the form's cap reaches the row" }).toBe(4);
    const created = (await tasks()).find(t => t.title === title);

    // …and CLEARING it really uncaps, which is the half a COALESCE cannot do.
    // WAIT FOR THE CLIENT MODEL, not just for the row to exist server-side.
    //
    // `editTask` resolves the challenge out of `S.adminTasksData` and, when it is
    // not there, deliberately CLOSES the form and toasts "no longer available" —
    // so calling it before the post-save `loadAdminTasks` has landed leaves the
    // editor shut, and the failure reads as `#tf-attempt-cap` resolving to a
    // HIDDEN element 24 times with nothing about the cause. Seen once under
    // --repeat-each; the same class as the v8.1.0 `viewComp` model race.
    await expect.poll(
      async () => page.evaluate((id) => !!(window.S?.adminTasksData || []).find(t => t.id === id), created.id),
      { timeout: 15000, message: "the new challenge reaches the admin list model before editTask reads it" },
    ).toBe(true);
    await page.evaluate((id) => window.editTask(id), created.id);
    await page.locator("#tf-attempt-cap").waitFor({ state: "visible", timeout: 10000 })
      .catch(async (e) => {
        const why = await page.evaluate(() => ({
          inModel: (window.S?.adminTasksData || []).length,
          toast: [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()).slice(-1)[0] || null,
        }));
        throw new Error(`the challenge editor did not open. ${JSON.stringify(why)}\n${e.message}`);
      });
    await expect(page.locator("#tf-attempt-cap"), "the editor shows the stored cap").toHaveValue("4");
    await page.locator("#tf-attempt-cap").fill("");
    await page.locator('[data-action="save-task"]:visible').last().click();
    await expect.poll(async () => ((await tasks()).find(t => t.id === created.id) || {}).attempt_cap ?? null,
      { timeout: 15000, message: "clearing the box really uncaps" }).toBeNull();

    // ── event level ──────────────────────────────────────────────────────────
    // Driven through the CREATE form, which is the same control and exercises the
    // collector as well. The clear path for a competition is locked at API level
    // in attempt-caps.spec.js; what needs proving here is that the input exists
    // and its value reaches the row.
    await clickTab(page, "Events");
    const compName = `${uniq()} FormComp`;
    await openCompCreateForm(page);
    await page.locator("#comp-name").fill(compName);
    await page.locator("#comp-date").fill("2032-05-04");
    await page.locator("#comp-time").fill("10:00");
    await page.locator("#comp-tz").fill("UTC");
    await page.locator("#comp-dur-h").fill("2");
    await expect(page.locator("#comp-attempt-cap"), "blank means uncapped").toHaveValue("");
    await page.locator("#comp-attempt-cap").fill("6");
    await page.locator('[data-action="comp-save"]').first().click();
    const confirm = page.locator("#modal-overlay");
    await expect(confirm).toContainText("Create Competition?", { timeout: 10000 });
    await confirm.locator("button", { hasText: /^Create$/ }).first().click();

    await expect.poll(async () => ((await comps()).find(c => c.name === compName) || {}).attempt_cap ?? null,
      { timeout: 15000, message: "the event-level cap round-trips through the form" }).toBe(6);
  });
});

/**
 * v8.13.1 — make the NEXT answer's response vanish on its way back.
 *
 * The request really reaches the server and is graded there (`route.fetch`), and
 * only then does the browser see a network failure (`route.abort`) — the venue
 * wi-fi case the external auditor named: the participant cannot tell whether it
 * counted, and presses Submit again with the same answer. A fault that dropped
 * the request BEFORE the server would leave nothing to fold, so it would test a
 * different, already-correct path. Every later request passes through untouched.
 *
 * Returns the lost response's body, so a test can assert as a PRECONDITION that
 * the lost answer really was graded and charged — without it "the card shows the
 * right count afterwards" is equally satisfied by a fault that never reached the
 * server at all.
 */
async function loseNextAnswerResponse(page, taskId) {
  const lost = { body: null, at: 0 };
  let used = false;
  await page.route(`**/api/tasks/${taskId}/submit`, async (route) => {
    if (used) return route.continue();
    used = true;
    const resp = await route.fetch();
    lost.body = await resp.json().catch(() => null);
    lost.at = Date.now();
    await route.abort("failed");
  });
  return lost;
}

/**
 * Re-send the same answer and return the server's reply to it. The reply is
 * asserted to be a FOLD, with how long after the lost answer it was sent: the
 * server folds only a repeat inside three seconds, so a slow run that missed the
 * window would otherwise read as the client mishandling a reply it never got.
 */
async function retrySameAnswer(page, f, text, lost) {
  const replyP = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/api/tasks/${f.taskId}/submit`));
  await answer(page, text);
  const d = await (await replyP).json();
  expect(d.deduped, `precondition: the retry must be folded into the lost answer (sent ${Date.now() - lost.at} ms after it was graded; the fold window is 3000 ms)`).toBe(true);
  return d;
}

test.describe("v8.13.1 — the count after a wrong answer, and after a lost answer's retry", () => {
  test("a wrong answer updates the count IN PLACE, and the second turns it into the last-attempt warning", async ({ page }) => {
    // The standard card's "N of M attempts left" line used to keep the count from
    // when the challenge was opened: after a wrong answer it read "3 of 3" beside
    // a message saying 2 were left, and the "Last attempt" warning never appeared
    // before the answer that locks the card. (The test above re-opens the
    // challenge between answers, which is why it never saw this.)
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 3);
      await openChallenge(page, f);
      const box = page.locator("#task-detail-card .attempts-left");
      const res = page.locator("#submit-result");
      const head = page.locator("#task-detail-card .attempts-count");
      await expect(box).toHaveText("3 of 3 attempts left on this challenge.");
      await expect(head).toHaveText("No attempts yet");

      await answer(page, "w1");
      await expect(res).toContainText(/2 attempts left/i, { timeout: 15000 });
      await expect(box, "the line takes the server's count").toHaveText("2 of 3 attempts left on this challenge.");
      // The header's count of submissions moves with it, or the card shows two
      // numbers that disagree ("0 attempt(s)" beside "2 of 3 left").
      await expect(head, "the header count moves with the line").toHaveText("1 attempt");
      await expect(box, "two left is not urgent").not.toHaveClass(/attempts-last/);
      // IN PLACE: the result line is still on the card. A re-open would also show
      // the right count, but it replaces the card — the message and anything the
      // participant had typed with it.
      await expect(res, "the card was updated, not re-rendered").toContainText(/2 attempts left/i);

      await answer(page, "w2");
      await expect(res).toContainText(/1 attempt left/i, { timeout: 15000 });
      await expect(box, "the next answer is the irreversible one, and the card says so").toHaveClass(/attempts-last/);
      await expect(box).toContainText(/Last attempt\..*not be able to try again/);
      await expect(head).toHaveText("2 attempts");
      await expect(res).toContainText(/1 attempt left/i);
      await expect(page.locator("#ans-text"), "one is left, so the input stays live").toBeVisible();
    } finally { await api.dispose(); }
  });

  test("a lost answer retried: the fold names the count, and the card shows the LAST attempt", async ({ page }) => {
    // The auditor's finding on the standard card. The answer reached the server
    // and spent the second-to-last attempt; its response never arrived, so the
    // card still said "2 of 2". The retry is folded into it — and until v8.13.1
    // the fold carried no count, so the card went on saying 2 when 1 was left.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 2);
      await openChallenge(page, f);
      const box = page.locator("#task-detail-card .attempts-left");
      await expect(box).toHaveText("2 of 2 attempts left on this challenge.");
      // The score pill is the other stale number: the lost answer's −5 is charged
      // and its response — the only thing that refreshes the pill on this path —
      // never arrives. The 15-second leaderboard poll ALSO refreshes it, so it is
      // stopped BEFORE the lost answer is sent, or "the pill caught up" would be
      // satisfied by the poll (and a poll landing after the charge would fail the
      // precondition below on a correct build).
      // Since v8.17.0 the pulse (S.statusPollInterval) paints the pill, so both stop.
      await page.evaluate(() => { clearInterval(window.S.lbInterval); window.S.lbInterval = null; clearTimeout(window.S.statusPollInterval); window.S.statusPollInterval = null; });
      const pill = page.locator("#header-score");
      const head = page.locator("#task-detail-card .attempts-count");

      const lost = await loseNextAnswerResponse(page, f.taskId);
      await answer(page, "lost-answer");
      await expect(page.locator("#submit-result"), "precondition: the browser saw a failure")
        .toContainText(/could not be sent/i, { timeout: 15000 });
      expect(lost.body && lost.body.attempts_left, "precondition: the lost answer WAS graded, and charged").toBe(1);
      await expect(box, "precondition: the card still shows the count from before the lost answer")
        .toHaveText("2 of 2 attempts left on this challenge.");
      await expect(pill, "precondition: the pill still shows the score from before the lost answer").toHaveText("0 pts");
      await expect(head, "precondition: the header still counts no submission").toHaveText("No attempts yet");

      const d = await retrySameAnswer(page, f, "lost-answer", lost);
      expect(d.attempts_left, "precondition: the server reports the real standing").toBe(1);
      // The COUNT first: it is the finding, so it is what an unfixed build fails on.
      await expect(box, "the card now says the next answer is the last one").toHaveClass(/attempts-last/);
      await expect(box).toContainText(/Last attempt/);
      const msg = page.locator("#submit-result .result-msg");
      await expect(msg, "a fold is not a graded wrong answer").toHaveClass(/notice/);
      await expect(msg).toContainText("already submitted a moment ago and was not correct");
      await expect(msg).toContainText("1 attempt left.");
      await expect(msg, "a fold charged nothing").not.toContainText(/penalty/i);
      await expect(page.locator("#ans-text"), "one is left, so the input stays live").toBeVisible();
      const me = await (await page.request.get("/api/me")).json();
      expect(me.score, "one penalty, for the one answer the server graded").toBe(-5);
      await expect(pill, "the pill takes the charged score with the fold, not at the next poll").toHaveText("-5 pts");
      await expect(head, "one submission was stored — the fold stores none").toHaveText("1 attempt");
    } finally { await api.dispose(); }
  });

  test("a lost LAST answer retried: the card locks, exactly as after any last wrong answer", async ({ page }) => {
    // The lost answer was the only attempt. The stale card still offers the input
    // (it believes one is left), and the retry is folded — so without the count
    // the participant was told "it wasn't counted twice" over a live input for a
    // challenge they can no longer answer, which every later submit refuses.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 1);
      await openChallenge(page, f);
      await expect(page.locator(".attempts-left")).toContainText(/Last attempt/);

      const lost = await loseNextAnswerResponse(page, f.taskId);
      await answer(page, "the-only-one");
      await expect(page.locator("#submit-result")).toContainText(/could not be sent/i, { timeout: 15000 });
      expect(lost.body && lost.body.attempts_left, "precondition: the lost answer spent the only attempt").toBe(0);
      await expect(page.locator("#ans-text"), "precondition: the stale card still offers the input").toBeVisible();

      const d = await retrySameAnswer(page, f, "the-only-one", lost);
      expect(d.attempts_left).toBe(0);
      // A TOAST, for the reason the refusal uses one: the card is replaced by the
      // locked panel, so a message written into it would flash and vanish.
      const toast = page.locator(".toast", { hasText: "now locked" });
      await expect(toast).toBeVisible({ timeout: 15000 });
      await expect(toast).toContainText("already submitted a moment ago and was not correct");
      await expect(toast, "a fold charged nothing").not.toContainText(/penalty/i);
      await expect(page.locator(".attempts-exhausted"), "the locked panel replaces the input").toBeVisible({ timeout: 15000 });
      await expect(page.locator("#ans-text")).toHaveCount(0);
      await expect(page.locator('[data-action="task-submit-answer"]')).toHaveCount(0);
    } finally { await api.dispose(); }
  });

  test("an UNCAPPED challenge's fold names no budget, and only the header count moves — the control", async ({ page }) => {
    // Without this, the two tests above are equally satisfied by a client that
    // prints a count for every challenge ("undefined attempts left") or locks on
    // anything that is not a positive number. (v8.13.2 — retitled from "names no
    // count and changes nothing else": the header's count of STORED answers now
    // follows the fold too, which is the external audit's finding. The BUDGET is
    // still never invented for an uncapped challenge.)
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, null);
      await openChallenge(page, f);
      await expect(page.locator(".attempts-left"), "precondition: no budget is drawn").toHaveCount(0);

      const lost = await loseNextAnswerResponse(page, f.taskId);
      await answer(page, "free-wrong");
      await expect(page.locator("#submit-result")).toContainText(/could not be sent/i, { timeout: 15000 });
      expect(lost.body && lost.body.correct, "precondition: the lost answer was graded").toBe(false);
      expect(lost.body).not.toHaveProperty("attempts_left");

      const head = page.locator("#task-detail-card .attempts-count");
      await expect(head, "precondition: the header still counts no submission").toHaveText("No attempts yet");

      const d = await retrySameAnswer(page, f, "free-wrong", lost);
      expect(d).not.toHaveProperty("attempts_left");
      const msg = page.locator("#submit-result .result-msg");
      await expect(msg).toHaveClass(/notice/);
      await expect(msg).toHaveText("That answer was already submitted a moment ago and was not correct — it wasn't counted twice.");
      await expect(page.locator(".attempts-left"), "no count is invented").toHaveCount(0);
      await expect(page.locator(".attempts-exhausted"), "and nothing locks").toHaveCount(0);
      await expect(page.locator("#ans-text")).toBeVisible();
      // v8.13.2 — the header DOES move: the lost answer was stored (one), the
      // fold stores none. Uncapped is no reason for the card's own count to lag.
      expect(d.attempts, "precondition: the fold carries the stored count").toBe(1);
      await expect(head, "the header takes the stored count from the fold").toHaveText("1 attempt");
    } finally { await api.dispose(); }
  });
});

// v8.13.2 (external audit, P3) — on an UNCAPPED challenge the card's "N
// attempt(s)" header kept the count from when the challenge was opened: after a
// wrong answer the score moved and the header did not, until the challenge was
// reopened. The header update sat below the cap gate in the client, and an
// uncapped answer's response carried no count for it to use anyway.
test.describe("v8.13.2 — an uncapped challenge's attempt count follows each answer", () => {
  test("a wrong answer moves the header IN PLACE, beside the score, with no budget invented", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, null);
      await openChallenge(page, f);
      const head = page.locator("#task-detail-card .attempts-count");
      const res = page.locator("#submit-result");
      await expect(page.locator(".attempts-left"), "precondition: uncapped, so no budget line").toHaveCount(0);
      await expect(head).toHaveText("No attempts yet");

      await answer(page, "w1");
      await expect(res, "precondition: graded wrong").toContainText(/Incorrect/i, { timeout: 15000 });
      // The finding's own words: the SCORE was updated, the count was not. The
      // score is the control that the answer really landed in this card.
      await expect(res).toContainText("Score: -5.");
      await expect(head, "the header takes the server's count").toHaveText("1 attempt");
      // IN PLACE: the result line is still on the card. A re-open would also show
      // the right count, but it replaces the card and the message with it.
      await expect(res, "the card was updated, not re-rendered").toContainText(/Incorrect/i);

      await answer(page, "w2");
      await expect(res).toContainText("Score: -10.", { timeout: 15000 });
      await expect(head).toHaveText("2 attempts");
      await expect(page.locator(".attempts-left"), "an uncapped card still draws no budget").toHaveCount(0);
      await expect(page.locator(".attempts-exhausted"), "and nothing locks").toHaveCount(0);
      await expect(page.locator("#ans-text"), "the input stays live").toBeVisible();
    } finally { await api.dispose(); }
  });
});
