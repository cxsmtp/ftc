// @ts-check
//
// v8.9.0 — MULTIPLE ACCEPTED ANSWERS on a text challenge, browser side.
//
// `text-alternatives.api.spec.js` locks the grading rule and the canonical
// stored form. This file locks the four SURFACES that turn one newline-joined
// column into something a human meets, none of which the API spec can see:
//
//   1. the admin editor — #tf-answer is accepted answer #1, the rows under it
//      are the alternatives, rendered from S._tfExtraAnswers (a keystroke must
//      NOT re-render, a removal must NOT lose the neighbours), joined with "\n"
//      on save, and offered for `text` ONLY;
//   2. re-opening a saved challenge SPLITS the key back into the box + rows;
//   3. the admin "View as Participant" preview joins the lines with ' | ';
//   4. the participant's Solution box, once the event has ended with reveal on,
//      joins them the same way — ' | ' means ALTERNATIVES, where a raw "\n"
//      renders as one run-on string and a choice SET uses ' + '.
//
// Every test owns its fixtures (the standing checklist): the participant arm
// enrols TWO people and only one submits, so the all-solved auto-end cannot end
// the event under the test, and the challenge ids come from the create
// responses rather than a title lookup that could match an earlier test's row.
const { test, expect } = require("./isolated-test");
const { narrowChallengesTable } = require("./ui-admin-helpers"); // v9.2.5 — the one way to type into the admin search boxes
const { registerPost } = require("./helpers");
const { apiLogin, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const GUH = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `tau${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

/** Sign the browser in as the built-in superadmin and land on the admin panel. */
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

/**
 * Narrow the paginated challenges table to ONE title and return its row.
 * The table paginates at 30 and the worker DB accumulates (v7.15.29), so the
 * search box comes first, always.
 */
async function taskRow(page, title) {
  await page.locator("button[data-tab-id='admin-tasks-tab']").click();
  await narrowChallengesTable(page, title);
  const row = page.locator("#admin-task-body tr", { hasText: title }).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  return row;
}

/** The stored row, read back over the API as the signed-in superadmin. */
async function storedTask(page, id) {
  const l = await (await page.request.get("/api/admin/tasks")).json();
  return (l.tasks || l).find((t) => t.id === id) || null;
}

test.describe("Admin: additional accepted answers on a text challenge (v8.9.0)", () => {
  test("rows render from a model, a removal keeps its neighbour, and the save is newline-joined", async ({ page }) => {
    const csrf = await adminPage(page);
    await openTaskForm(page);

    const extraInputs = page.locator("#tf-answers-extra input");
    const removeBtns = page.locator("#tf-answers-extra button[data-action='task-extra-answer-remove']");

    // A fresh TEXT form: the box, the Add button, and no rows yet.
    await expect(page.locator("#tf-answer-group")).toBeVisible();
    await expect(page.locator("#tf-add-answer"), "Add is offered for a text challenge").toBeVisible();
    await expect(extraInputs).toHaveCount(0);

    await page.locator("#tf-answer").fill("first");
    await page.locator("#tf-add-answer").click();
    await page.locator("#tf-add-answer").click();
    await expect(extraInputs).toHaveCount(2);
    // Numbered as ONE list with the box above: the first row is answer #2.
    await expect(extraInputs.nth(0)).toHaveAttribute("aria-label", "Accepted answer 2");
    await expect(extraInputs.nth(1)).toHaveAttribute("aria-label", "Accepted answer 3");

    // `fill` is fine here: a keystroke updates the model and deliberately does
    // NOT re-render (the caret rule), so there is no mid-type re-render to race.
    await extraInputs.nth(0).fill("second");
    await extraInputs.nth(1).fill("third");

    // Remove the MIDDLE answer (row 0 of the extras — "second"). The rows are
    // re-rendered from the model, so "third" must survive the re-render and
    // step up into row 0 — a DOM-authoritative editor would either lose it or
    // leave a stale "second" behind.
    await removeBtns.nth(0).click();
    await expect(extraInputs).toHaveCount(1);
    await expect(extraInputs.nth(0), "the surviving row kept what was typed into it").toHaveValue("third");
    await expect(extraInputs.nth(0), "…and is renumbered as answer #2").toHaveAttribute("aria-label", "Accepted answer 2");
    await expect(page.locator("#tf-answer"), "answer #1 is untouched by the removal").toHaveValue("first");

    const title = `${uniq()} Multi`;
    await page.locator("#tf-title").fill(title);
    await page.locator("#save-publish-btn").click();

    let row = null;
    await expect.poll(async () => {
      const l = await (await page.request.get("/api/admin/tasks")).json();
      row = (l.tasks || l).find((t) => t.title === title) || null;
      return row ? "saved" : "not yet";
    }, { timeout: 15000, message: "the challenge never reached the list" }).toBe("saved");

    expect(row.answer_type).toBe("text");
    // THE CLAIM: the box plus every remaining row, trimmed, joined with "\n" —
    // and "second" is GONE from the stored key, not merely from the screen.
    expect(row.correct_answer, "the stored key is the box + the surviving row").toBe("first\nthird");

    await page.request.delete(`/api/admin/tasks/${row.id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("the rows and the Add button exist for TEXT only, and survive a round trip through the other types", async ({ page }) => {
    await adminPage(page);
    await openTaskForm(page);
    const extras = page.locator("#tf-answers-extra");
    const addBtn = page.locator("#tf-add-answer");
    const extraInputs = page.locator("#tf-answers-extra input");

    await page.locator("#tf-answer").fill("first");
    await addBtn.click();
    await extraInputs.nth(0).fill("alt");
    await expect(extras).toBeVisible();

    // `file` and `json` keep the single Correct Answer box and hide the list —
    // neither grades a multi-line key as alternatives, so offering rows would be
    // a control that appears to work.
    for (const type of ["file", "json"]) {
      await page.locator("#tf-atype").selectOption(type);
      await expect(page.locator("#tf-answer-group"), `${type}: the single box stays`).toBeVisible();
      await expect(extras, `${type}: no alternative rows`).toBeHidden();
      await expect(addBtn, `${type}: no Add button`).toBeHidden();
    }
    // `choice` and `any` have no Correct Answer box at all, so nothing under it
    // may show either.
    for (const type of ["choice", "any"]) {
      await page.locator("#tf-atype").selectOption(type);
      await expect(page.locator("#tf-answer-group"), `${type}: no answer box`).toBeHidden();
      await expect(extras, `${type}: no alternative rows`).toBeHidden();
      await expect(addBtn, `${type}: no Add button`).toBeHidden();
    }

    // Back to text: the model was never cleared by the detour, so the row and
    // its value are still there and the Add button is back.
    await page.locator("#tf-atype").selectOption("text");
    await expect(extras).toBeVisible();
    await expect(addBtn).toBeVisible();
    await expect(extraInputs).toHaveCount(1);
    await expect(extraInputs.nth(0), "the alternative survived the type round trip").toHaveValue("alt");
  });

  test("re-opening a multi-answer challenge splits the key into the box and one row per remaining line", async ({ page }) => {
    const csrf = await adminPage(page);
    const title = `${uniq()} Split`;
    const r = await page.request.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: { title, difficulty: "easy", answer_type: "text", status: "published",
        correct_answer: "first\nsecond\nthird" },
    });
    expect(r.ok(), `seed: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;
    // PRECONDITION: the server stored all three lines, or the split below is
    // being asserted against a one-line key and passes for the wrong reason.
    expect((await storedTask(page, id))?.correct_answer).toBe("first\nsecond\nthird");

    const row = await taskRow(page, title);
    // Row actions live behind the ⋮ kebab, which portals its menu to
    // #kebab-portal on document.body — the item is NOT inside the row.
    await row.locator(".kebab-btn").first().click();
    await page.locator("#kebab-portal [data-action='task-edit']").click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 15000 });

    await expect(page.locator("#tf-atype")).toHaveValue("text");
    await expect(page.locator("#tf-answer"), "the FIRST line is accepted answer #1").toHaveValue("first");
    const extraInputs = page.locator("#tf-answers-extra input");
    await expect(extraInputs, "one row per REMAINING line").toHaveCount(2);
    await expect(extraInputs.nth(0)).toHaveValue("second");
    await expect(extraInputs.nth(1)).toHaveValue("third");
    await expect(page.locator("#tf-answers-extra")).toBeVisible();
    await expect(page.locator("#tf-add-answer")).toBeVisible();

    await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("View as Participant renders the alternatives joined with ' | '", async ({ page }) => {
    const csrf = await adminPage(page);
    const title = `${uniq()} Preview`;
    const r = await page.request.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: { title, difficulty: "easy", answer_type: "text", status: "published",
        description: "<p>Count to three.</p>", correct_answer: "one\ntwo\nthree" },
    });
    expect(r.ok(), `seed: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;
    expect((await storedTask(page, id))?.correct_answer, "precondition: three lines stored").toBe("one\ntwo\nthree");

    const row = await taskRow(page, title);
    await row.locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 10000 });

    // ' | ' — alternatives. Not the raw newline (which the browser collapses
    // into "onetwothree"-with-spaces and reads as one answer), and not the
    // ' + ' a choice SET uses, which means "all of these".
    expect(await page.locator(".task-preview-answer").textContent()).toBe("one | two | three");

    await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });
});

test.describe("Participant: a text challenge with several accepted answers (v8.9.0)", () => {
  async function makeParticipant(api, csrf, label) {
    const email = `${label}@company.example`;
    const reg = await registerPost(api, "/api/register", {
      headers: GUH(csrf),
      data: {
        firstName: "Alt", lastName: label, nickname: label, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
      },
    });
    expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
    const list = await (await api.get("/api/admin/participants?limit=5000")).json();
    const u = (list.participants || []).find((p) => p.email === email);
    expect(u, `${label} is findable`).toBeTruthy();
    const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: GUH(csrf) });
    expect(v.ok(), `verify ${label}: ${v.status()}`).toBeTruthy();
    const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: GUH(csrf) });
    expect(a.ok(), `approve ${label}: ${a.status()}`).toBeTruthy();
    return { id: u.id, email };
  }

  /**
   * Dismiss the "competition has ended" popup the STATUS POLL raises a moment
   * after load — sampling isVisible() once loses that race and the modal then
   * intercepts every click on the nav (the multiple-choice spec's lesson).
   */
  async function dismissEndedPopup(page) {
    const ended = page.locator("#modal-overlay.open");
    await ended.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    for (let i = 0; i < 5 && await ended.isVisible().catch(() => false); i++) {
      await page.locator("#modal-confirm-btn").click({ timeout: 3000 }).catch(() => {});
      await ended.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
  }

  test("an alternative is accepted in the browser, and the Solution box lists every answer with ' | '", async ({ page }) => {
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    const H = GUH(sc);
    const t = uniq();

    // A LIVE event with reveal ON — the Solution box renders only once the event
    // has FULLY ended (routes/participant.js ships `correct_answer` for a text
    // task solely under `revealSolution`), so the arm ends it after the submit.
    const cr = await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `${t} Reveal`, start_time: new Date(Date.now() - 30 * 60_000).toISOString(),
      duration_minutes: 120, timezone: "UTC", reveal_answers_on_end: true } });
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const comp = (await cr.json()).competition;

    const title = `${t} Colours`;
    const tr = await sa.post("/api/admin/tasks", { headers: H, data: {
      title, difficulty: "easy", answer_type: "text", status: "published",
      description: "<p>Name a colour on the flag.</p>",
      explanation: "<p>Either colour is on it.</p>",
      correct_answer: "red\nblue" } });
    expect(tr.ok(), `create task: ${tr.status()} ${await tr.text()}`).toBeTruthy();
    let taskId = (await tr.json()).id;
    expect(taskId, "the create returns the new challenge's id").toBeTruthy();
    const asg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign task: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    taskId = (await asg.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is opened and answered there

    // TWO participants, ONE of whom submits — so the all-solved auto-end cannot
    // fire under the test and the end below is the test's own deliberate act.
    const p1 = await makeParticipant(sa, sc, `${t}a`);
    const p2 = await makeParticipant(sa, sc, `${t}b`);
    const enrol = await sa.post("/api/admin/competitions/assign", {
      headers: H, data: { userIds: [p1.id, p2.id], competitionIds: [comp.id] } });
    expect(enrol.ok(), `enrol: ${enrol.status()} ${await enrol.text()}`).toBeTruthy();
    expect((await enrol.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(2);

    // ── the participant, in the browser ────────────────────────────────────
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const lr = await codeLogin(page.request, p1.email, GUH(csrfToken));
    expect(lr.ok(), `participant login: ${lr.status()} ${await lr.text()}`).toBeTruthy();
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: comp.id } });
    expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();

    await page.goto("/");
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    const card = page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`);
    await card.waitFor({ state: "visible", timeout: 20000 });
    await card.click();
    await page.locator("#ans-text").waitFor({ state: "visible", timeout: 15000 });

    // The SECOND alternative, in a different case — accepted through the real
    // submit path, penalty modal included.
    await page.locator("#ans-text").fill("BLUE");
    await page.locator("[data-action='task-submit-answer'][data-mode='text']").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 8000 });
    await page.locator("#modal-confirm-btn").click();

    // A correct answer takes the congrats path (nothing lands in #submit-result).
    const congrats = page.locator("div.card", { hasText: "Challenge Solved!" });
    await congrats.waitFor({ state: "visible", timeout: 15000 });
    // …and the durable outcome agrees: a correct submission row exists.
    await expect.poll(async () => {
      const subs = await (await sa.get("/api/admin/submissions?limit=200")).json();
      const row = (subs.events || []).find((e) => e.task_title === title);
      return row ? row.is_correct : null;
    }, { timeout: 15000, message: "no correct submission row for the participant's BLUE" }).toBeTruthy();
    await congrats.getByRole("button", { name: "Continue" }).click();
    await congrats.waitFor({ state: "hidden", timeout: 5000 });

    // ── end the event, so the reveal fires ─────────────────────────────────
    const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    const comps = await (await sa.get("/api/admin/competitions")).json();
    expect((comps.competitions || comps).find((c) => c.id === comp.id)?.status,
      "the competition must actually be ended").toBe("ended");

    // PRECONDITION on the wire: the payload the client renders from carries the
    // whole newline-joined key, and says the event is fully ended.
    const body = await (await page.request.get(`/api/tasks/${taskId}`)).json();
    expect(body.competition_fully_ended, "reveal is gated on the event having fully ended").toBe(true);
    expect(body.solved, "the participant really solved it").toBe(true);
    expect(body.correct_answer, "the STORED form rides the wire").toBe("red\nblue");

    await page.goto("/");
    await dismissEndedPopup(page);
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    const card2 = page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`);
    await card2.waitFor({ state: "visible", timeout: 20000 });
    await card2.click();
    await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 15000 });

    const detail = page.locator("#task-detail-card");
    await expect(detail, "the Solution box is on screen").toContainText("Correct Answer");
    await expect(detail, "every accepted answer, joined as ALTERNATIVES").toContainText("red | blue");
    await expect(detail, "the explanation survives beside it").toContainText("Either colour is on it.");
    const text = await detail.textContent();
    expect(text, "the raw newline form is not what renders").not.toMatch(/red\s*\n\s*blue/);

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": sc } });
    await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": sc } });
    await sa.dispose();
  });
});
