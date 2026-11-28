// @ts-check
//
// THE CHALLENGE FOCUS VIEW: ITS KEYS, ITS CORRECT PANEL AND WHAT A SOLVE SAYS
// (public/js/features/participant-tasks.js `_qaKeydown`, `solvedPanelHtml`,
// `_markCorrectInCard`, `submitAnswer`; features/choice-tap.js `_attemptsLine`).
//
//   1. The answer keys: a letter picks an option and Enter submits it (the
//      penalty confirm opens); a letter does nothing while typing in a field or
//      under a dialog; Enter on a link in the challenge does the LINK's job
//      (control: the same Enter from an option opens the confirm).
//   2. A correct answer: the picked option ticked, the rest dashed, the Correct
//      panel with the points; reopened, the same review and Next challenge to the
//      next unsolved one AFTER it (the solved one sits between two unsolved ones,
//      so "the first unsolved in the list" is a different answer), wrapping round
//      from the last — and Back to challenges once nothing is left.
//   3. An Any answer, a pick-one included, is ACCEPTED, never "Correct": the
//      pick marked in the neutral colour at the moment of answering as on a
//      later view (control: item 2's choice challenge says Correct). The
//      pick-one is answered from the keyboard: a letter picks, Enter sends.
//   4. Leaving during the pause between the answer and the dialog neither drags
//      the participant back nor ejects them — for Events (the event left) and
//      for the Leaderboard (still in the event, so only "is this challenge on
//      screen" can tell) (control: staying lands on the list).
//   5. A pick-one quick question, and an Any answer, on a capped event show no
//      attempts line — on the standard card or the booth tap card — while a
//      quick question that CAN be wrong does (control: a scoring challenge that
//      can be wrong shows "Last attempt"); and quick questions leave the
//      participant's "N/M solved", meter, spoken count and the strip's "All
//      solved" alone, as the board's finish count does.
//   6. A Program's play bar draws no ring, so its header countdown stays on a
//      desktop (control: a Competition's ring is its one clock, and its header
//      countdown steps aside).
//   7. The key hint names the card's own keys: "Press A–D to pick" on a
//      four-option single answer, "A–C to toggle" on a three-option multiple
//      answer (control: a typed answer has no hint).
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, BASE, TEST_DB_PATH } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const LINKEDIN = "https://www.linkedin.com/in/ada-byron-cvk-test";

/**
 * A live event of its own with the given challenges, its participant and an idle
 * second participant (nothing auto-ends under the test: checklist item 1). A
 * challenge's `tags` are added before it is assigned. The challenges are numbered
 * by title, so the keys' order is the participant's list order.
 */
async function eventWith(label, specs, extra = {}) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const c = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `CVK ${uniq(label)}`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(),
      duration_minutes: 600, ...extra,
    } });
    expect(c.ok(), `create event: ${await c.text()}`).toBeTruthy();
    const comp = (await c.json()).competition;
    const ids = {};
    const tag = uniq(label);
    for (const [key, { tags = [], olderTags = [], ...spec }] of Object.entries(specs)) {
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `CVK ${tag} ${key}`, description: "<p>Read it.</p>", difficulty: "easy", status: "published", ...spec,
      } });
      expect(r.ok(), `create ${key}: ${await r.text()}`).toBeTruthy();
      ids[key] = (await r.json()).id;
      for (const t of tags) {
        const tr = await sa.post(`/api/admin/tasks/${ids[key]}/tags`, { headers: H(csrf), data: { tag: t } });
        expect(tr.ok(), `tag ${key} ${t}: ${await tr.text()}`).toBeTruthy();
      }
      // `olderTags`: written as a row tagged before the tag routes refused it (a
      // qualifying question that is not a pick-one question: lib/qualifying.js).
      if (olderTags.length) {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        try { for (const t of olderTags) db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(ids[key], t); } finally { db.close(); }
      }
      const a = await sa.post(`/api/admin/tasks/${ids[key]}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      const ab = await a.json();
      expect(ab.assigned, `assign ${key}`).toBe(1);
      ids[key] = ab.copies[0].task_id;   // the event's own copy (lib/event-copies.js): what its participants open and answer
    }
    const p = await makeParticipant(sa, csrf, label);
    const idle = await makeParticipant(sa, csrf, `${label}-idle`);
    await enrol(sa, csrf, comp.id, [p.id, idle.id]);
    return { comp, ids, p };
  } finally { await sa.dispose(); }
}

async function enter(page, f) {
  const P = await apiLogin(f.p.email);
  try {
    const sel = await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: f.comp.id } });
    expect(sel.ok(), `pre-select: ${await sel.text()}`).toBeTruthy();
  } finally { await P.api.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect(page.locator("#task-grid .task-card").first(), "PRECONDITION: in the event").toBeVisible({ timeout: 20000 });
}

async function open(page, taskId) {
  await page.evaluate((id) => window.openTask(id), taskId);
  await expect(page.locator("#task-detail-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => document.querySelector("#task-detail-card .qa-title, #task-detail-card .mcf-q-title") ? 1 : 0)).toBe(1);
}

/** The key (a, b, c…) the standard card gives the option with this text, in this participant's order. */
async function keyFor(page, text) {
  const texts = await page.locator("#task-detail-card .choice-option > span").allInnerTexts();
  const i = texts.map((t) => t.trim()).indexOf(text);
  expect(i, `option "${text}" is on the card (${texts.join(" | ")})`).toBeGreaterThanOrEqual(0);
  return String.fromCharCode(97 + i);
}
const checkedText = (page) => page.evaluate(() => {
  const i = document.querySelector("#task-detail-card .ans-choice:checked");
  return i ? i.closest("label").querySelector("span").textContent.trim() : null;
});

/**
 * Answer through the BROWSER's own session (page.request shares its cookies): a
 * second sign-in as the same participant would end the browser's session (one
 * session per principal).
 */
async function solveInPage(page, taskId, answer = "a") {
  const csrf = await page.evaluate(() => window.S.csrfToken);
  const r = await page.request.post(`/api/tasks/${taskId}/submit`, { headers: H(csrf), data: { answer, gradingHash: await gradingHashFor(page.request, taskId) } });
  expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  expect((await r.json()).correct, "precondition: accepted").toBe(true);
}
const choiceIds = async (page, taskId) => ((await (await page.request.get(`/api/tasks/${taskId}`)).json()).choices || []);

const CHOICES = [{ text: "Alpha" }, { text: "Bravo", correct: true }, { text: "Charlie" }, { text: "Delta" }];

test("the key hint names the card's own keys: A–D to pick one, A–C to toggle several, none on a typed answer", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await eventWith("hint", {
    a_one: { answer_type: "choice", choices: CHOICES },
    b_many: { answer_type: "choice", choices: [{ text: "Uno", correct: true }, { text: "Dos", correct: true }, { text: "Tres" }] },
    c_typed: { answer_type: "text", correct_answer: "x" },
  });
  await enter(page, f);
  const hint = page.locator("#task-detail-card .qa-keys-hint");
  await open(page, f.ids.a_one);
  await expect(page.locator("#task-detail-card .choice-option"), "PRECONDITION: four options").toHaveCount(4);
  await expect(hint).toHaveText("Press A–D to pick, Enter to submit");
  await open(page, f.ids.b_many);
  await expect(page.locator("#task-detail-card .choice-option"), "PRECONDITION: three options").toHaveCount(3);
  await expect(page.locator("#task-detail-card .choice-fieldset.is-multi"), "PRECONDITION: several may be chosen").toHaveCount(1);
  await expect(hint).toHaveText("Press A–C to toggle, Enter to submit");
  // CONTROL — a typed answer has no keys, so no hint.
  await open(page, f.ids.c_typed);
  await expect(page.locator("#task-detail-card #ans-text"), "PRECONDITION: the typed answer's card").toHaveCount(1);
  await expect(hint).toHaveCount(0);
});

test("the answer keys pick and submit from an option; off while typing and under a dialog; Enter on a link follows the link", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await eventWith("keys", {
    choice: { answer_type: "choice", choices: CHOICES, author_name: "Ada Byron", author_linkedin: LINKEDIN },
  });
  await page.context().route(`${LINKEDIN}**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>profile</p>" }));
  await enter(page, f);
  await open(page, f.ids.choice);
  const submits = [];
  page.on("request", (q) => { if (/\/api\/tasks\/[^/]+\/submit$/.test(new URL(q.url()).pathname)) submits.push(q.url()); });

  // A letter picks.
  await page.keyboard.press(await keyFor(page, "Charlie"));
  expect(await checkedText(page)).toBe("Charlie");
  // Off while typing in a field: the letter is the field's.
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "__typing"; document.body.appendChild(i); i.focus(); });
  await page.keyboard.press(await keyFor(page, "Alpha"));
  expect(await checkedText(page), "a letter typed into a field picks nothing").toBe("Charlie");
  await expect(page.locator("#__typing")).toHaveValue(await keyFor(page, "Alpha"));
  await page.evaluate(() => document.getElementById("__typing").remove());

  // Enter from the option opens the penalty confirm (the positive control for the link).
  await page.locator("#task-detail-card .ans-choice:checked").focus();
  await page.keyboard.press("Enter");
  const modal = page.locator("#modal-overlay.open");
  await expect(modal).toContainText("Submit Answer");
  // Off under a dialog: the letter does not move the pick behind it.
  await page.keyboard.press(await keyFor(page, "Delta"));
  expect(await checkedText(page), "a letter under the dialog picks nothing").toBe("Charlie");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);

  // Enter on a link in the challenge does the link's job, and no confirm opens.
  const link = page.locator("#task-detail-card .qa-author a");
  await expect(link).toHaveAttribute("href", LINKEDIN);
  await link.focus();
  const popup = page.waitForEvent("popup", { timeout: 10000 });
  await page.keyboard.press("Enter");
  const tab = await popup;
  await tab.close();
  await expect(page.locator("#modal-overlay.open"), "Enter on a link opens no confirm").toHaveCount(0);
  expect(await checkedText(page), "and the pick stands").toBe("Charlie");

  // Focus merely PARKED by script (the route's heading, tabindex -1) has no
  // Enter action of its own, so Enter there still submits the pick — the control
  // that the link's exemption is about links, not about everything but options.
  await page.locator("#task-detail-card .qa-title").evaluate((el) => { el.setAttribute("tabindex", "-1"); el.focus(); });
  expect(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("qa-title")),
    "precondition: focus is on the heading").toBe(true);
  await page.keyboard.press("Enter");
  await expect(modal, "Enter from the parked heading opens the confirm").toContainText("Submit Answer");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);
  expect(submits, "nothing was submitted").toEqual([]);
});

test("a correct answer: ticked, the rest dashed, the Correct panel; reopened, the review and Next challenge, then Back to challenges", async ({ page }) => {
  test.setTimeout(120_000);
  // The choice challenge is the MIDDLE one of three (numbered by title: a, b, c),
  // so the next unsolved one after it (c) and the first unsolved one in the list
  // (a) are different answers.
  const f = await eventWith("panel", {
    a: { answer_type: "text", correct_answer: "a" },
    b: { answer_type: "choice", choices: CHOICES },
    c: { answer_type: "text", correct_answer: "a" },
  });
  await enter(page, f);
  await open(page, f.ids.b);
  await page.keyboard.press(await keyFor(page, "Bravo"));
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Submit", exact: true }).click();

  // The answer lights up first: the pick ticked, the others dashed, the panel.
  const cardEl = page.locator("#task-detail-card");
  await expect(cardEl).toHaveClass(/qa-solved-now/);
  await expect(cardEl.locator(".choice-option.is-correct")).toHaveText(/Bravo/);
  await expect(cardEl.locator(".choice-option.is-correct .qa-tick")).toHaveCount(1);
  await expect(cardEl.locator(".choice-option.is-dim")).toHaveCount(3);
  await expect(page.locator("#submit-result.qa-result-ok")).toContainText("Correct — clean and quick.");
  await expect(page.locator("#submit-result .qa-done-pts")).toHaveText("+50");
  // Then the dialog, which names the challenge.
  const win = page.locator(".ha-win");
  await expect(win.locator(".ha-win-eyebrow")).toHaveText("Correct");
  await expect(win.locator("#ha-win-h")).toHaveText("Challenge Solved!");
  await win.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#tasks-page")).toHaveClass(/active/);

  // Reopened: the review keeps every option, the right one ticked, the rest dashed.
  await open(page, f.ids.b);
  const review = cardEl.locator("#choice-review");
  await expect(review.locator(".choice-review-row.is-correct")).toHaveText(/Bravo/);
  await expect(review.locator(".choice-review-row.is-dim")).toHaveCount(3);
  await expect(cardEl.locator(".qa-done")).toContainText("Correct — clean and quick.");
  await expect(cardEl.locator(".qa-done")).toContainText("You have solved this challenge.");
  // Next challenge: the next unsolved one AFTER this, in the participant's own
  // order — not the first unsolved one in the list, which is a different challenge.
  const order = () => page.evaluate(() => window.S.allTasks.map((t) => [t.id, !!t.solved]));
  expect(await order(), "precondition: the solved challenge sits between two unsolved ones")
    .toEqual([[f.ids.a, false], [f.ids.b, true], [f.ids.c, false]]);
  const next = cardEl.locator(".qa-next");
  await expect(next).toHaveText(/Next challenge/);
  expect(await next.getAttribute("data-next-task-id"), "the next unsolved after this one, not the first in the list").toBe(f.ids.c);
  await next.click();
  await expect.poll(() => page.evaluate(() => window.S._openedTaskId)).toBe(f.ids.c);

  // From the LAST challenge the way on wraps round to the top: the only one left
  // unsolved comes before it.
  await solveInPage(page, f.ids.c);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(order, { message: "precondition: only the first is left" })
    .toEqual([[f.ids.a, false], [f.ids.b, true], [f.ids.c, true]]);
  await open(page, f.ids.c);
  await expect(cardEl.locator(".qa-next")).toHaveText(/Next challenge/);
  expect(await cardEl.locator(".qa-next").getAttribute("data-next-task-id"), "wrapping round to the first").toBe(f.ids.a);

  // Nothing left: the way on is the list.
  await solveInPage(page, f.ids.a);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(() => page.evaluate(() => window.S.allTasks.every((t) => t.solved))).toBe(true);
  await open(page, f.ids.c);
  await expect(cardEl.locator(".qa-next")).toHaveText(/Back to challenges/);
  await expect(cardEl.locator(".qa-next")).toHaveAttribute("data-action", "show-main");
});

test("an Any answer and a pick-one are accepted, never Correct, at the moment and on a later view", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await eventWith("accept", {
    pick: { answer_type: "any", correct_answer: "", choices: [{ text: "Red" }, { text: "Green" }, { text: "Blue" }] },
    free: { answer_type: "any", correct_answer: "" },
    keep: { answer_type: "text", correct_answer: "a" },
  });
  await enter(page, f);
  const cardEl = page.locator("#task-detail-card");
  const win = page.locator(".ha-win");

  // PICK-ONE, from the keyboard: its options are lettered like a multiple-choice
  // card's, so a letter picks and Enter sends — at once, as its Submit does (no
  // penalty confirm: no option can be wrong). Then the pick is marked in the
  // neutral colour, and nothing says Correct.
  await open(page, f.ids.pick);
  const submits = [];
  page.on("request", (q) => { if (/\/api\/tasks\/[^/]+\/submit$/.test(new URL(q.url()).pathname)) submits.push(q.url()); });
  await page.keyboard.press(await keyFor(page, "Green"));
  expect(await checkedText(page), "a letter picks on a pick-one card").toBe("Green");
  await page.keyboard.press("Enter");
  await expect(cardEl.locator(".choice-option.is-picked"), "Enter sent the pick").toHaveText(/Green/);
  await expect.poll(() => submits.length, { message: "one answer sent" }).toBe(1);
  await expect(cardEl.locator(".choice-option.is-correct, .choice-option.is-dim, .qa-tick")).toHaveCount(0);
  await expect(cardEl).not.toHaveClass(/qa-solved-now/);
  await expect(page.locator("#submit-result.qa-result-ok")).toContainText("Answer accepted");
  await expect(page.locator("#submit-result.qa-result-ok")).not.toContainText("Correct");
  await expect(win.locator(".ha-win-eyebrow")).toHaveText("Answer accepted");
  expect(await win.innerText(), "the dialog never says Correct").not.toMatch(/correct/i);
  await expect(win).toContainText("+50");
  await win.getByRole("button", { name: "Continue" }).click();
  await open(page, f.ids.pick);
  await expect(cardEl.locator("#choice-review .choice-review-row.is-picked")).toHaveText(/Green/);
  await expect(cardEl.locator("#choice-review .is-correct")).toHaveCount(0);
  await expect(cardEl.locator(".qa-done")).toContainText("Answer accepted");
  await expect(cardEl.locator(".qa-done")).toContainText("You have answered this challenge.");

  // A FREE Any answer: the same.
  await open(page, f.ids.free);
  await page.locator("#ans-text").fill("anything at all");
  await page.locator("#ans-text").press("Enter");
  await expect(page.locator("#submit-result.qa-result-ok")).toContainText("Answer accepted");
  await expect(page.locator("#ans-text.is-correct")).toHaveCount(0);
  await expect(win.locator(".ha-win-eyebrow")).toHaveText("Answer accepted");
  await win.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#tasks-page")).toHaveClass(/active/);
});

test("leaving during the pause after a solve neither drags the participant back nor ejects them", async ({ page }) => {
  test.setTimeout(120_000);
  // A Competition (ranked), so the Leaderboard is a way out of the challenge too.
  const f = await eventWith("pause", {
    stay: { answer_type: "any", correct_answer: "" },
    board: { answer_type: "any", correct_answer: "" },
    leave: { answer_type: "any", correct_answer: "" },
    keep: { answer_type: "text", correct_answer: "a" },
  });
  await page.clock.install();
  await enter(page, f);
  const win = page.locator(".ha-win");
  // What follows Continue is WATCHED in the page, not sampled: it runs in the
  // press's own task (the dialog resolves on the click), so a move to the list
  // shows as a class change, and the eject would follow a reload of the list,
  // recorded here as it is ASKED for. One task after the press, all of it has run.
  const watch = () => page.evaluate(() => {
    const seen = (window.__seen = { tasksShown: false, asked: [] });
    if (!window.__watching) {
      window.__watching = true;
      const tp = document.getElementById("tasks-page");
      new MutationObserver(() => { if (tp.classList.contains("active")) window.__seen.tasksShown = true; })
        .observe(tp, { attributes: true, attributeFilter: ["class"] });
      const f0 = window.fetch;
      window.fetch = function (u) {
        try { window.__seen.asked.push(new URL(typeof u === "string" ? u : u.url, location.origin).pathname); } catch (_) { /* best-effort */ }
        return f0.apply(this, arguments);
      };
    }
    return seen.asked.length;
  });
  const afterPress = () => page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__seen), 0)));

  // CONTROL: staying on the challenge lands on the list after the dialog — the
  // watcher sees exactly that move and that reload.
  await open(page, f.ids.stay);
  await page.locator("#ans-text").fill("here");
  await page.locator("#ans-text").press("Enter");
  await expect(win.locator("#ha-win-h")).toHaveText("Challenge Solved!");
  await watch();
  await win.getByRole("button", { name: "Continue" }).click();
  const stayed = await afterPress();
  expect(stayed.tasksShown, "CONTROL: from the challenge, to the list (the watcher sees the move)").toBe(true);
  expect(stayed.asked, "CONTROL: and the list is reloaded (the watcher sees the read)").toContain("/api/tasks");
  await expect(page.locator("#tasks-page")).toHaveClass(/active/);

  // TO THE LEADERBOARD in the pause (frozen, so the move lands inside it): the
  // participant is still in the event — its generation does not move — so only
  // "is this challenge still on screen" can tell that they left it.
  await open(page, f.ids.board);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 200);
  await page.locator("#ans-text").fill("over there");
  await page.locator("#ans-text").press("Enter");
  await expect(page.locator("#submit-result.qa-result-ok"), "precondition: the answer is in and the pause has begun").toBeVisible();
  await expect(win).toHaveCount(0);
  const gen = await page.evaluate(() => window.S._compGen);
  await page.locator("#nav-leaderboard").click();
  await expect(page.locator("#leaderboard-page")).toHaveClass(/active/);
  await page.clock.runFor(600);
  await page.clock.resume();
  await expect(win.locator("#ha-win-h")).toHaveText("Challenge Solved!");
  expect(await page.evaluate(() => window.S._compGen), "precondition: still in the event (its generation did not move)").toBe(gen);
  await watch();
  await win.getByRole("button", { name: "Continue" }).click();
  const boarded = await afterPress();
  expect(boarded.tasksShown, "the participant is not taken off the board to the list").toBe(false);
  await expect(page.locator("#leaderboard-page"), "they stay on the board").toHaveClass(/active/);

  // TO EVENTS in the pause, the event left.
  await open(page, f.ids.leave);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 200);
  await page.locator("#ans-text").fill("there");
  await page.locator("#ans-text").press("Enter");
  await expect(page.locator("#submit-result.qa-result-ok"), "precondition: the answer is in and the pause has begun").toBeVisible();
  await expect(win).toHaveCount(0);
  await page.locator("#nav-competitions").click();
  await expect(page.locator("#competitions-page")).toHaveClass(/active/);
  await page.clock.runFor(600);
  await page.clock.resume();
  // The solve is still announced, by name…
  await expect(win.locator("#ha-win-h")).toHaveText("Challenge Solved!");
  await watch();
  await win.getByRole("button", { name: "Continue" }).click();
  // …and nobody is taken back to the list or thrown out of an event they left.
  const left = await afterPress();
  expect(left.tasksShown, "the participant is not dragged back to the challenge list").toBe(false);
  expect(left.asked.filter((p) => p === "/api/tasks"),
    `the left event's list is not reloaded, so nothing ejects them (asked: ${left.asked.join(", ")})`).toEqual([]);
  await expect(page.locator("#competitions-page"), "they stay where they went").toHaveClass(/active/);
});

test("a pick-one quick question or an Any answer shows no attempts line on a capped event, a quick question that can be wrong does, and quick questions leave the solved counts alone", async ({ page }) => {
  test.setTimeout(150_000);
  // A Booth Event (it seeds the four quick questions, each a pick-one), every
  // challenge capped at one attempt, plus an organiser's OWN quick question that
  // has a right answer: graded like any challenge, it can be wrong. (Only an
  // older one can be of another type: the tag routes now refuse it.)
  const f = await eventWith("quick", {
    text: { answer_type: "text", correct_answer: "a" },
    pick: { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] },
    choice: { answer_type: "choice", choices: CHOICES },
    own: { answer_type: "text", correct_answer: "a", olderTags: ["qualifying:own"] },
  }, { event_kind: "booth", attempt_cap: 1 });
  await enter(page, f);
  const all = await page.evaluate(() => window.S.allTasks.map((t) => ({ id: t.id, title: t.title, qualifying: !!t.qualifying })));
  const quick = all.filter((t) => t.qualifying && t.id !== f.ids.own);
  expect(quick.length, `precondition: the booth seeded its quick questions (${JSON.stringify(all)})`).toBe(4);
  expect(all.find((t) => t.id === f.ids.own), "precondition: the organiser's own one is a quick question").toMatchObject({ qualifying: true });
  const line = page.locator("#task-detail-card .attempts-left");

  // CONTROL: a challenge that can be wrong warns of its last attempt.
  await open(page, f.ids.text);
  await expect(line).toContainText("Last attempt");
  // A pick-one quick question and an Any answer cannot be wrong: no line.
  await open(page, quick[0].id);
  await expect(page.locator("#task-detail-card .qa-title")).toHaveText(quick[0].title);
  await expect(line).toHaveCount(0);
  await open(page, f.ids.pick);
  await expect(line).toHaveCount(0);
  // A quick question with a right answer CAN be wrong, and a wrong answer spends
  // its one attempt: being a quick question does not take the warning away.
  await open(page, f.ids.own);
  await expect(page.locator("#task-detail-card .qa-title")).toHaveText(all.find((t) => t.id === f.ids.own).title);
  await expect(line, "a quick question that can be wrong warns of its last attempt").toContainText("Last attempt");
  // The booth's tap card on a phone: the same rule.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, f.ids.choice);
  await expect(page.locator("#task-detail-card .mcf-last"), "CONTROL: the tap card warns on a challenge that can be wrong").toHaveText(/Last attempt/);
  await open(page, quick[0].id);
  await expect(page.locator("#task-detail-card .mcf-q-title")).toHaveText(quick[0].title);
  await expect(page.locator("#task-detail-card .mcf-meta-2")).toHaveCount(0);
  await page.locator("#task-detail-card .mcf-back").click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // Every scoring challenge solved, and one quick question answered.
  await solveInPage(page, f.ids.text, "a");
  await solveInPage(page, f.ids.pick, JSON.stringify([(await choiceIds(page, f.ids.pick))[0].id]));
  await solveInPage(page, f.ids.choice, JSON.stringify([(await choiceIds(page, f.ids.choice)).find((c) => c.text === "Bravo").id]));
  await solveInPage(page, quick[0].id, JSON.stringify([(await choiceIds(page, quick[0].id))[0].id]));
  await page.evaluate(() => window.loadTasks());
  await expect(page.locator("#tasks-subtitle"), "N/M solved counts what finishes the event").toHaveText("3/3 solved");
  expect(await page.locator("#tasks-meter > i").evaluate((el) => el.style.width)).toBe("100%");
  // The play bar's track still shows every challenge (a position), but its
  // spoken solved count is the same three.
  await open(page, quick[1].id);
  await expect(page.locator("#qa-stats .qa-prog-n")).toContainText(`/ ${all.length}`);
  await expect(page.locator("#qa-stats .qa-prog-n .sr-only")).toHaveText(", 3 solved");
  // The events page's strip says All solved, as the board would.
  await page.locator("#qa-playbar .qa-close").click();
  await page.locator("#nav-competitions").click();
  const row = page.locator(`#ev-progress .ev-prog[data-comp-id="${f.comp.id}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("All solved");
  // …while three quick questions are still to answer: something is left, so the
  // row still offers Continue (not View) and still has a current segment.
  await expect(row.getByRole("button", { name: /^Continue — / })).toBeVisible();
  await expect(row.locator(".qa-track i.now")).toHaveCount(1);
});

test("a Program's challenge view keeps the header countdown on a desktop, since its play bar draws no ring", async ({ page }) => {
  test.setTimeout(120_000);
  // A Program running to a deadline three hours away, and a Competition for the
  // same participant: the control, whose play bar's ring is the one clock.
  const f = await eventWith("prog", {
    one: { answer_type: "text", correct_answer: "a" },
    two: { answer_type: "text", correct_answer: "a" },
  }, { event_kind: "program", duration_minutes: undefined, deadline_at: new Date(Date.now() + 3 * 3600e3).toISOString() });
  let ring, ringTask;
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    ring = await makeCompetition(sa, csrf, "cvk-ring");
    ringTask = await makeTask(sa, csrf, "cvk-ring-1");
    Object.assign(ringTask, { bankId: ringTask.id, id: (await assignTask(sa, csrf, ringTask.id, [ring.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
    await enrol(sa, csrf, ring.id, [f.p.id]);
  } finally { await sa.dispose(); }
  await enter(page, f);
  const clock = page.locator("#header-timer");

  await open(page, f.ids.one);
  await expect(page.locator("#qa-stats .qa-prog"), "precondition: the play bar is drawn").toBeVisible();
  await expect(page.locator("#qa-stats .qa-gauge"), "precondition: a Program's play bar draws no ring").toHaveCount(0);
  await expect(clock, "the header countdown stays: it is the only clock on screen").toBeVisible();
  await expect(clock).toHaveText(/\d/);

  // CONTROL: a Competition's play bar draws the ring, and the header countdown —
  // on screen over its challenge list — steps aside in its challenge view.
  await page.locator("#nav-competitions").click();
  await expect(page.locator("#competitions-page")).toHaveClass(/active/);
  await page.locator(`#comp-grid .comp-card[data-comp-id="${ring.id}"] .card-open`).click();
  // Leaving one live event for another asks first.
  await expect(page.locator("#modal-overlay.open")).toContainText("Switch Event?");
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { timeout: 10000 }).toBe(ring.id);
  await expect(page.locator(`#task-grid .task-card[data-task-id="${ringTask.id}"]`)).toBeVisible({ timeout: 20000 });
  await expect(clock, "precondition: the countdown is up over the list").toHaveText(/\d/, { timeout: 10000 });
  await expect(clock).toBeVisible();
  await open(page, ringTask.id);
  await expect(page.locator("#qa-stats .qa-gauge:not([hidden])"), "precondition: the ring is drawn").toBeVisible({ timeout: 10000 });
  await expect(clock, "with a ring on screen, the header countdown steps aside").toBeHidden();
});
