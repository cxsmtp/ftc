// @ts-check
//
// v7.19.0 — multiple choice, browser side: the admin choices editor and the
// participant's radio/checkbox answer UI.
const { test, expect } = require("./isolated-test");
const { narrowChallengesTable } = require("./ui-admin-helpers"); // v9.2.5 — the one way to type into the admin search boxes
const { apiLogin, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const GUH = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

async function adminPage(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", {
    headers: GUH(csrfToken), data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

async function openTaskForm(page) {
  await page.locator("button[data-tab-id='admin-tasks-tab']").click();
  await page.locator("[data-action='open-task-form']").first().click();
  await page.locator("#tf-title").waitFor({ state: "visible", timeout: 15000 });
}

test.describe("Admin: the multiple-choice editor (v7.19.0)", () => {
  test("choosing Multiple Choice swaps the single answer input for the choices editor", async ({ page }) => {
    await adminPage(page);
    await openTaskForm(page);

    // Before: the plain Correct Answer input, no choices editor.
    await expect(page.locator("#tf-answer-group")).toBeVisible();
    await expect(page.locator("#tf-choices-group")).toBeHidden();

    await page.locator("#tf-atype").selectOption("choice");
    // After: swapped. The plain input is HIDDEN rather than left on screen
    // holding a value nothing reads — the correct answer is derived from ticks.
    await expect(page.locator("#tf-choices-group")).toBeVisible();
    await expect(page.locator("#tf-answer-group")).toBeHidden();
    // It opens with two rows, because two is the minimum a question can have.
    await expect(page.locator("#tf-choices-list .choice-row")).toHaveCount(2);

    // Switching back restores the plain input.
    await page.locator("#tf-atype").selectOption("text");
    await expect(page.locator("#tf-answer-group")).toBeVisible();
    await expect(page.locator("#tf-choices-group")).toBeHidden();
  });

  test("rows can be added and removed, and the last two cannot be removed", async ({ page }) => {
    await adminPage(page);
    await openTaskForm(page);
    await page.locator("#tf-atype").selectOption("choice");
    const rows = page.locator("#tf-choices-list .choice-row");

    await page.locator("#tf-add-choice").click();
    await page.locator("#tf-add-choice").click();
    await expect(rows).toHaveCount(4);

    // Typing into one row must survive adding another — the editor renders from
    // a model for exactly this reason.
    await page.locator("#tf-choices-list .choice-text").nth(0).fill("First choice");
    await page.locator("#tf-add-choice").click();
    await expect(rows).toHaveCount(5);
    await expect(page.locator("#tf-choices-list .choice-text").nth(0)).toHaveValue("First choice");

    await page.locator("#tf-choices-list [data-action='task-choice-remove']").nth(4).click();
    await expect(rows).toHaveCount(4);

    // Down to the two-row floor, removal is disabled rather than silently
    // producing an unanswerable question.
    for (let i = 0; i < 2; i++) {
      await page.locator("#tf-choices-list [data-action='task-choice-remove']").last().click();
    }
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#tf-choices-list [data-action='task-choice-remove']").first()).toBeDisabled();
  });

  test("the same rules the server enforces are surfaced while typing", async ({ page }) => {
    await adminPage(page);
    await openTaskForm(page);
    await page.locator("#tf-atype").selectOption("choice");
    const err = page.locator("#tf-choices-err");
    const texts = page.locator("#tf-choices-list .choice-text");
    const ticks = page.locator("#tf-choices-list input[data-change-action='task-choice-correct']");

    await expect(err, "empty rows are flagged before a save is attempted").toContainText(/needs some text/i);
    await texts.nth(0).fill("Alpha");
    await texts.nth(1).fill("alpha");
    await expect(err, "a duplicate is caught case-insensitively, as on the server").toContainText(/same text/i);
    await texts.nth(1).fill("Beta");
    // Row 0 is ticked correct by default, so this should now be clean.
    await expect(err).toHaveText("");
    // Ticking everything correct is refused — the question could not be got wrong.
    await ticks.nth(1).check();
    await expect(err).toContainText(/at least one choice must be incorrect/i);
    await ticks.nth(1).uncheck();
    await ticks.nth(0).uncheck();
    await expect(err).toContainText(/at least one choice as correct/i);
  });

  test("a choice challenge saves, and re-opening it rehydrates the ticks", async ({ page }) => {
    const csrf = await adminPage(page);
    await openTaskForm(page);
    await page.locator("#tf-atype").selectOption("choice");
    await page.locator("#tf-add-choice").click();
    const texts = page.locator("#tf-choices-list .choice-text");
    await texts.nth(0).fill("Parameterised queries");
    await texts.nth(1).fill("String concatenation");
    await texts.nth(2).fill("Prepared statements");
    // rows 0 and 2 correct (row 0 is ticked by default)
    await page.locator("#tf-choices-list input[data-change-action='task-choice-correct']").nth(2).check();

    const title = `MCUI ${Date.now()}`;
    await page.locator("#tf-title").fill(title);
    await page.locator("#save-publish-btn").click();

    await expect.poll(async () => {
      const l = await (await page.request.get("/api/admin/tasks")).json();
      return (l.tasks || l).find((t) => t.title === title) ? "yes" : "no";
    }, { timeout: 15000 }).toBe("yes");

    const l = await (await page.request.get("/api/admin/tasks")).json();
    const row = (l.tasks || l).find((t) => t.title === title);
    expect(row.answer_type).toBe("choice");
    const choices = JSON.parse(row.choices);
    const correct = JSON.parse(row.correct_answer);
    expect(choices.map((c) => c.text)).toEqual([
      "Parameterised queries", "String concatenation", "Prepared statements",
    ]);
    expect([...correct].sort()).toEqual([choices[0].id, choices[2].id].sort());

    // Re-open it: the editor must come back with the same rows AND the same
    // ticks, rehydrated from the id list in correct_answer.
    // Narrow first: the challenges table paginates at 30 and the worker DB
    // accumulates (the v7.15.29 rule).
    await narrowChallengesTable(page, title);
    // Row actions live behind the ⋮ kebab, which portals its menu to
    // #kebab-portal on document.body — so the menu item is NOT inside the row.
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator(".kebab-btn").first().click();
    // Scope to the OPEN portal: every row renders its own (hidden) task-edit
    // button, so an unscoped .first() picks a hidden one from another row.
    await page.locator("#kebab-portal [data-action='task-edit']").click();
    await page.locator("#tf-choices-group").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#tf-choices-list .choice-row")).toHaveCount(3);
    await expect(page.locator("#tf-choices-list .choice-text").nth(2)).toHaveValue("Prepared statements");
    const ticks = page.locator("#tf-choices-list input[data-change-action='task-choice-correct']");
    await expect(ticks.nth(0)).toBeChecked();
    await expect(ticks.nth(1)).not.toBeChecked();
    await expect(ticks.nth(2)).toBeChecked();

    await page.request.delete(`/api/admin/tasks/${row.id}`, { headers: { "x-csrf-token": csrf } });
  });
});

test.describe("Admin: View as Participant renders a choice question (v7.19.0)", () => {
  test("the preview shows the OPTIONS and a readable correct answer, not raw ids", async ({ page }) => {
    // Reported: "multiple choice questions don't render correctly when admin
    // hits the view button." Two defects in one screen — the preview rendered
    // the description and then nothing (no options at all, so the question was
    // unanswerable on screen), and it printed `correct_answer` verbatim, which
    // for this type is a JSON array of choice IDs: `["4c94ea2a","b2c74eba"]`.
    // Technically the stored value; useless to the admin reading it.
    const csrf = await adminPage(page);
    const title = `MCPrev ${Date.now()}`;
    const r = await page.request.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: { title, difficulty: "easy", answer_type: "choice", status: "published",
        description: "<p>Which of these are safe?</p>",
        choices: [
          { text: "Parameterised queries", correct: true },
          { text: "String concatenation" },
          { text: "Prepared statements", correct: true },
        ] },
    });
    expect(r.ok(), `seed: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;

    await page.locator("button[data-tab-id='admin-tasks-tab']").click();
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 10000 });

    // Every option is on screen, in author order.
    await expect(page.locator(".choice-review-row")).toHaveCount(3);
    await expect(page.locator(".choice-review-row").nth(0)).toContainText("Parameterised queries");
    await expect(page.locator(".choice-review-row").nth(1)).toContainText("String concatenation");
    await expect(page.locator(".choice-review-row").nth(2)).toContainText("Prepared statements");
    // The correct ones are marked — this is the author checking their own key.
    await expect(page.locator(".choice-review-row.is-correct")).toHaveCount(2);
    await expect(page.locator(".choice-review-row.is-correct").nth(0)).toContainText("Parameterised queries");
    // Two correct → the preview says "select all that apply", matching what a
    // participant will actually be shown.
    await expect(page.locator(".choice-review-label")).toContainText(/select all that apply/i);

    // v7.20.3 — the answer lives with the OPTIONS and nowhere else. The
    // Solution box used to restate it, which said the same thing twice on one
    // screen; the marked options are the better of the two, because they say it
    // in context.
    await expect(page.locator(".task-preview-answer"),
      "the Solution box must not restate the answer for a choice task").toHaveCount(0);
    const shown = await page.locator("#task-preview-overlay").textContent();
    expect((shown.match(/Parameterised queries/g) || []).length,
      "the correct option appears once — in the option list").toBe(1);

    await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("a SINGLE-answer question previews as select-one", async ({ page }) => {
    const csrf = await adminPage(page);
    const title = `MCPrev1 ${Date.now()}`;
    const r = await page.request.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: { title, difficulty: "easy", answer_type: "choice", status: "published",
        choices: [{ text: "The right one", correct: true }, { text: "Nope" }] },
    });
    const id = (await r.json()).id;
    await page.locator("button[data-tab-id='admin-tasks-tab']").click();
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator(".choice-review-label")).toContainText(/select one/i);
    await expect(page.locator(".choice-review-row.is-correct")).toHaveCount(1);
    await expect(page.locator(".choice-review-row.is-correct")).toContainText("The right one");
    await expect(page.locator(".task-preview-answer"),
      "no duplicate Correct Answer line for a choice task").toHaveCount(0);
    await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("a NON-choice challenge previews exactly as before", async ({ page }) => {
    // The preview is shared, so the new branch must not disturb the other types.
    const csrf = await adminPage(page);
    const title = `MCPrevText ${Date.now()}`;
    const r = await page.request.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: { title, difficulty: "easy", answer_type: "text", status: "published",
        correct_answer: "the plain answer" },
    });
    const id = (await r.json()).id;
    await page.locator("button[data-tab-id='admin-tasks-tab']").click();
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator(".choice-review")).toHaveCount(0);
    expect(await page.locator(".task-preview-answer").textContent()).toBe("the plain answer");
    await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });
});

test.describe("Participant: answering a multiple-choice challenge (v7.19.0)", () => {
  /** Publish a choice task into the live competition and enrol alice. */
  async function seedLive(page, choices) {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const live = (comps.competitions || comps).find((c) => c.name === "Test Live");
    const title = `MCPart ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await sa.post("/api/admin/tasks", {
      headers: GUH(saCsrf),
      data: { title, difficulty: "easy", answer_type: "choice", status: "published",
        description: "<p>Choose</p>", choices },
    });
    expect(r.ok(), `seed: ${r.status()} ${await r.text()}`).toBeTruthy();
    const bankId = (await r.json()).id;
    const ar = await sa.post(`/api/admin/tasks/${bankId}/competitions`, {
      headers: GUH(saCsrf), data: { competitionIds: [live.id] },
    });
    expect(ar.ok(), await ar.text()).toBeTruthy();
    return { sa, saCsrf, taskId: (await ar.json()).copies[0].task_id, title, compId: live.id };   // the event's own copy (lib/event-copies.js): what its participants open and answer
  }

  // NOTE: call this at most ONCE per test. Logging in again while the previous
  // SPA is still running on the page races it: the old app's polls still carry
  // the pre-regeneration CSRF token, the fetch interceptor treats the mismatch
  // as a dead session and POSTs /api/logout — which destroys the session that
  // was just created, and the next goto() lands on the login page. (Diagnosed
  // from /api/me returning "Not authenticated" straight after a successful
  // login.) One fixture per test also keeps each test to a single claim.
  async function participantOnTask(page, compId, taskId) {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, "alice@acme.com", GUH(csrfToken));
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: compId } });
    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    // Reach the challenge the way a participant does, so the tasks page is
    // actually loaded before the task is opened.
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`)
      .waitFor({ state: "visible", timeout: 20000 });
    await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`).click();
    await page.locator(".choice-fieldset").waitFor({ state: "visible", timeout: 15000 });
  }

  test("ONE correct choice renders radios, and radios enforce a single pick", async ({ page }) => {
    const { sa, saCsrf, taskId, compId } = await seedLive(page, [
      { text: "Only right one", correct: true }, { text: "Nope" }, { text: "Also nope" },
    ]);
    await participantOnTask(page, compId, taskId);
    await expect(page.locator(".ans-choice")).toHaveCount(3);
    await expect(page.locator(".ans-choice").first()).toHaveAttribute("type", "radio");
    await expect(page.locator(".choice-fieldset legend")).toContainText(/choose one/i);
    // Radios enforce single selection for free — that is why they are used
    // rather than checkboxes plus a client-side count check.
    await page.locator(".choice-option").nth(0).click();
    await page.locator(".choice-option").nth(1).click();
    await expect(page.locator(".ans-choice:checked")).toHaveCount(1);
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("TWO OR MORE correct choices render checkboxes, and several can be picked", async ({ page }) => {
    const { sa, saCsrf, taskId, compId } = await seedLive(page, [
      { text: "Right A", correct: true }, { text: "Right B", correct: true }, { text: "Wrong" },
    ]);
    await participantOnTask(page, compId, taskId);
    await expect(page.locator(".ans-choice").first()).toHaveAttribute("type", "checkbox");
    await expect(page.locator(".choice-fieldset legend")).toContainText(/choose all that apply/i);
    await page.locator(".choice-option").nth(0).click();
    await page.locator(".choice-option").nth(1).click();
    await expect(page.locator(".ans-choice:checked")).toHaveCount(2);
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("the rendered options never carry which one is correct", async ({ page }) => {
    // Belt and braces alongside the API-level assertion: whatever the server
    // sends, nothing in the DOM may mark the right answer for a reader of the
    // page source.
    const { sa, saCsrf, taskId, compId } = await seedLive(page, [
      { text: "Secret correct", correct: true }, { text: "Decoy one" }, { text: "Decoy two" },
    ]);
    await participantOnTask(page, compId, taskId);
    const html = await page.locator(".choice-fieldset").innerHTML();
    expect(html).toContain("Secret correct");
    expect(html.toLowerCase()).not.toContain("correct=");
    expect(html.toLowerCase()).not.toContain('"correct"');
    expect(html.toLowerCase()).not.toContain("data-correct");
    // And the task payload the client holds must not carry it either.
    const leaked = await page.evaluate(() =>
      JSON.stringify((window.S && window.S.allTasks) || []).toLowerCase().includes('"correct":true'));
    expect(leaked, "the cached task list must not carry the answer").toBe(false);
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("submitting the exact set scores it correct, end to end", async ({ page }) => {
    const { sa, saCsrf, taskId, title, compId } = await seedLive(page, [
      { text: "Pick me", correct: true }, { text: "Pick me too", correct: true }, { text: "Not me" },
    ]);
    await participantOnTask(page, compId, taskId);

    // Tick by TEXT, not position — the options are shuffled per participant, so
    // a positional click would be testing the shuffle rather than the answer.
    // Click by EXACT label text. "Pick me" is a prefix of "Pick me too", so a
    // substring match would tick the wrong row; and the option's text content
    // carries markup whitespace, so an anchored regex over the whole label does
    // not match either. getByText(..., {exact:true}) targets the span, and the
    // wrapping <label> toggles its input.
    for (const label of ["Pick me", "Pick me too"]) {
      await page.getByText(label, { exact: true }).click();
    }
    await expect(page.locator(".ans-choice:checked")).toHaveCount(2);
    await page.locator("[data-action='task-submit-answer'][data-mode='choice']").click();
    // The submit confirmation names the penalty; accept it.
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 8000 });
    await page.locator("#modal-confirm-btn").click();
    // A CORRECT answer takes the congrats path, so nothing lands in
    // #submit-result (that is the wrong-answer surface). Assert the durable
    // outcome instead: a correct submission row exists.
    await expect.poll(async () => {
      const subs = await (await sa.get(`/api/admin/submissions?limit=200`)).json();
      const row = (subs.events || []).find((e) => e.task_title === title);
      return row ? row.is_correct : null;
    }, { timeout: 15000 }).toBeTruthy();

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  /** An ended competition + choice task, optionally revealing and/or solved. */
  async function endedChoiceScenario(page, { reveal, solve }) {
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    const H = GUH(sc);
    const t = Date.now() + Math.floor(Math.random() * 1e5);
    const comp = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `Rev ${t}`, start_time: new Date(t - 30 * 60_000).toISOString(),
      duration_minutes: 120, reveal_answers_on_end: !!reveal } })).json()).competition.id;
    const title = `Rev task ${t}`;
    const bankId = (await (await sa.post("/api/admin/tasks", { headers: H, data: {
      title, difficulty: "easy", answer_type: "choice", status: "published",
      description: "<p>Which repository deserves attention first?</p>",
      choices: [{ text: "CustomerAPI", correct: true }, { text: "ReportingJob" }, { text: "TestHarness" }],
    } })).json()).id;
    const taskId = (await (await sa.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H, data: { competitionIds: [comp] } })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what its participants open and answer
    const ps = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const alice = (ps.participants || ps).find((p) => p.email === "alice@acme.com");
    await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [alice.id], competitionIds: [comp] } });

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, "alice@acme.com", GUH(csrfToken));
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: comp } });

    if (solve) {
      const body = await (await page.request.get(`/api/tasks/${taskId}`)).json();
      const lst = await (await sa.get("/api/admin/tasks")).json();
      const stored = (lst.tasks || lst).find((x) => x.id === taskId);
      const correctId = JSON.parse(stored.correct_answer)[0];
      const sub = await page.request.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": c2 },
        multipart: { answer: JSON.stringify([correctId]), gradingHash: body.grading_hash } });
      expect((await sub.json()).correct, "the fixture must actually solve it").toBe(true);
    }
    // Solving the ONLY challenge fires the all-solved auto-end, so end-now then
    // 400s "already ended" — tolerate that and assert the END STATE instead.
    await sa.post(`/api/admin/competitions/${comp}/end-now`, { headers: H });
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const row = (comps.competitions || comps).find((c) => c.id === comp);
    expect(row && row.status, "the competition must actually be ended").toBe("ended");
    return { sa, saCsrf: sc, comp, taskId, title };
  }

  /** Open the ended challenge in the real participant UI. */
  async function openEnded(page, taskId) {
    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    // The competition just ended, so the SPA raises its "competition has ended"
    // popup — but it is raised by the STATUS POLL, so it appears a moment AFTER
    // load. Sampling isVisible() once loses that race and the modal then
    // intercepts every click on the nav. Wait for it, dismiss it, and only then
    // proceed.
    const ended = page.locator("#modal-overlay.open");
    await ended.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    for (let i = 0; i < 5 && await ended.isVisible().catch(() => false); i++) {
      await page.locator("#modal-confirm-btn").click({ timeout: 3000 }).catch(() => {});
      await ended.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    const card = page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`);
    await card.waitFor({ state: "visible", timeout: 20000 });
    await card.click();
    await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 15000 });
  }

  test("after the competition ends the OPTIONS are still shown", async ({ page }) => {
    // Before v7.20.1 the answer area was emptied once the challenge could no
    // longer be answered, so a participant reviewing an ended challenge saw the
    // question and no sign of what they had been choosing between. The options
    // are part of the QUESTION, not part of the input.
    const { sa, saCsrf, taskId } = await endedChoiceScenario(page, { reveal: false, solve: false });
    await openEnded(page, taskId);
    await expect(page.locator("#choice-review .choice-review-row")).toHaveCount(3);
    await expect(page.locator("#choice-review")).toContainText("CustomerAPI");
    await expect(page.locator("#choice-review")).toContainText("TestHarness");
    // Not revealed, not solved → nothing is marked, and no answer is claimed.
    await expect(page.locator("#choice-review .is-correct")).toHaveCount(0);
    await expect(page.locator(".choice-review-answer")).toHaveCount(0);
    // And the input is genuinely gone — this is a review, not a second attempt.
    await expect(page.locator(".ans-choice")).toHaveCount(0);
    await sa.dispose();
  });

  test("a participant who SOLVED it sees the answer above the options", async ({ page }) => {
    // Safe by construction: grading is all-or-nothing, so a solver's submitted
    // set WAS the correct set — this tells them nothing they did not prove.
    const { sa, taskId } = await endedChoiceScenario(page, { reveal: false, solve: true });
    await openEnded(page, taskId);
    await expect(page.locator("#choice-review .choice-review-row")).toHaveCount(3);
    // v7.20.4 — the answer is marked ON the option and stated nowhere else: a
    // separate banner a few pixels above said the same thing twice.
    await expect(page.locator("#choice-review .is-correct")).toHaveCount(1);
    await expect(page.locator("#choice-review .is-correct")).toContainText("CustomerAPI");
    await expect(page.locator(".choice-review-answer"),
      "no separate banner — that was the duplicate").toHaveCount(0);
    const screenText = await page.locator("#task-detail-card").textContent();
    expect((screenText.match(/CustomerAPI/g) || []).length,
      "the answer appears EXACTLY once on the participant's screen").toBe(1);
    await sa.dispose();
  });

  test("with answer-reveal on, an UNSOLVED participant also sees it", async ({ page }) => {
    const { sa, taskId } = await endedChoiceScenario(page, { reveal: true, solve: false });
    await openEnded(page, taskId);
    await expect(page.locator("#choice-review .is-correct")).toHaveCount(1);
    await expect(page.locator("#choice-review .is-correct")).toContainText("CustomerAPI");
    await expect(page.locator(".choice-review-answer")).toHaveCount(0);
    await sa.dispose();
  });

  test("an unsolved participant is told NOTHING when the competition does not reveal", async ({ page }) => {
    // The load-bearing negative. The two positives above are equally satisfied
    // by a build that always sends the answer, which would leak it for every
    // non-revealing competition.
    const { sa, taskId } = await endedChoiceScenario(page, { reveal: false, solve: false });
    const body = await (await page.request.get(`/api/tasks/${taskId}`)).json();
    expect(body.correct_answer, "the answer must not be on the wire at all").toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("CustomerAPI\",\"correct");
    await openEnded(page, taskId);
    await expect(page.locator("#choice-review .is-correct")).toHaveCount(0);
    await expect(page.locator(".choice-review-answer")).toHaveCount(0);
    await sa.dispose();
  });

  test("the post-competition Solution names the CHOICES, not their ids", async ({ page }) => {
    // Reported from production with a screenshot: after the competition ended
    // with answer-reveal on, the participant's Solution box read
    // `Correct Answer: ["6bc9f335"]`. Same defect as the admin preview, in a
    // THIRD renderer that v7.19.0 missed.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const H = GUH(saCsrf);
    const t = Date.now();
    // Build it the way it actually happens: a LIVE competition that participants
    // are enrolled in, which then ends. Creating it already-ended and assigning
    // afterwards fails — enrolment into an ended competition is refused, and the
    // participant then 403s on select-competition.
    const comp = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `MCReveal ${t}`, start_time: new Date(t - 30 * 60_000).toISOString(),
      duration_minutes: 120, reveal_answers_on_end: true } })).json()).competition.id;
    const title = `MCReveal task ${t}`;
    const bankId = (await (await sa.post("/api/admin/tasks", { headers: H, data: {
      title, difficulty: "easy", answer_type: "choice", status: "published",
      description: "<p>Which repository deserves attention first?</p>",
      explanation: "<p>Public + Production + Exploitable + Fix Available.</p>",
      choices: [
        { text: "CustomerAPI", correct: true },
        { text: "ReportingJob" },
        { text: "TestHarness" },
      ] } })).json()).id;
    const taskId = (await (await sa.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H, data: { competitionIds: [comp] } })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what its participants open and answer
    const ps = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const alice = (ps.participants || ps).find((p) => p.email === "alice@acme.com");
    await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [alice.id], competitionIds: [comp] } });

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, "alice@acme.com", GUH(csrfToken));
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: comp } });
    expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();

    // NOW end it — the reveal only fires once every session has ended.
    const end = await sa.post(`/api/admin/competitions/${comp}/end-now`, { headers: H });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    // Read the payload the client renders from, then the rendered box.
    const body = await (await page.request.get(`/api/tasks/${taskId}`)).json();
    expect(body.correct_answer, "the reveal payload carries the id array — that is the STORED form")
      .toMatch(/^\[/);
    const rendered = await page.goto("/").then(async () => {
      await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
      return page.evaluate((task) => window.buildSolutionHtml(task), body);
    });
    // v7.20.3 — for a CHOICE task the answer is stated above the options and
    // marked on them, so the Solution box no longer repeats it: a third copy,
    // detached from the options it refers to, was the least useful of the three.
    expect(rendered, "the Solution box no longer restates the answer for a choice task")
      .not.toContain("CustomerAPI");
    expect(rendered, "and certainly not the raw id array").not.toMatch(/\["[a-f0-9]{8}"\]/);
    expect(rendered).not.toContain(JSON.parse(body.correct_answer)[0]);
    expect(rendered, "the box survives for the EXPLANATION, which is its remaining job")
      .toContain("Public + Production");

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.delete(`/api/admin/competitions/${comp}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("submitting nothing is refused client-side rather than costing a penalty", async ({ page }) => {
    const { sa, saCsrf, taskId, compId } = await seedLive(page, [
      { text: "A", correct: true }, { text: "B" },
    ]);
    await participantOnTask(page, compId, taskId);
    await page.locator("[data-action='task-submit-answer'][data-mode='choice']").click();
    // No confirm modal, no request — just a nudge. A blank submit that reached
    // the server would be graded wrong and cost 5 points.
    await expect(page.locator(".toast, #toast-container")).toContainText(/select an answer/i, { timeout: 8000 });
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });
});
