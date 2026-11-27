// v8.9.0 — the ANY answer type ("Any answer (free response)"), browser side.
//
// A fifth answer type: every non-empty answer is accepted verbatim, it carries
// no hint, and it has no wrong-answer penalty. Three surfaces had to learn it —
// the participant's challenge view, the admin's challenge editor and the admin's
// "View as Participant" preview — and each is locked here beside a CONTROL on
// the `text` type, because "the penalty warning did not appear" is equally true
// of a build where the warning is gone for everybody, and "no hint rendered" is
// equally true of a build that renders no hint for anyone.
//
// FIXTURES: every test owns its competition, its two challenges and its TWO
// participants (fixture checklist items 1–3). An `any` challenge is solved by
// the first non-empty answer, so with a single enrolled participant the
// all-solved auto-end would end the event underneath the test the moment the
// reported flow succeeded.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `an${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const TEXT_KEY = "secret";

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Any", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `?search=` is a no-op on this endpoint (it is really "page 1, oldest
  // first"), so ask for the documented cap rather than a page that could
  // silently exclude the account just created.
  const list = await (await api.get(`/api/admin/participants?limit=5000`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify ${label}: ${await v.text()}`).toBeTruthy();
  const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(a.ok(), `approve ${label}: ${await a.text()}`).toBeTruthy();
  return { id: u.id, email };
}

/**
 * A live competition holding one `any` challenge and one `text` challenge (the
 * latter WITH a hint, so it can serve as the hint control), and two enrolled
 * participants of which only the first ever submits.
 */
async function fixture(api, csrf) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
            duration_minutes: 600, timezone: "UTC" },
  });
  expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const mkTask = async (data) => {
    const tr = await api.post("/api/admin/tasks", { headers: H(csrf), data });
    expect(tr.ok(), `create task ${data.title}: ${await tr.text()}`).toBeTruthy();
    const { id } = await tr.json();
    expect(id, "the create returns the new challenge's id").toBeTruthy();
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign ${data.title}: ${await asg.text()}`).toBeTruthy();
    return { id, title: data.title };
  };
  const anyTask = await mkTask({
    title: `${uniq()} Any`, description: "<p>Say anything.</p>", difficulty: "easy",
    answer_type: "any", status: "published",
  });
  const textTask = await mkTask({
    title: `${uniq()} Text`, description: "<p>Name the word.</p>", difficulty: "easy",
    answer_type: "text", correct_answer: TEXT_KEY, hint: "<p>It rhymes with regret.</p>", status: "published",
  });

  const users = [];
  for (let i = 0; i < 2; i++) users.push(await makeParticipant(api, csrf, uniq()));
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [comp.id] },
  });
  expect(asg.ok(), `assign users: ${await asg.text()}`).toBeTruthy();
  expect((await asg.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(2);
  return { comp, anyTask, textTask, users };
}

/** What the participant page is showing — printed on failure, never asserted on. */
async function view(page) {
  return JSON.stringify(await page.evaluate(() => ({
    page: (document.querySelector(".page.active") || {}).id || "none",
    ansMode: (document.getElementById("ans-text") || {}).dataset?.mode || null,
    hasSubmit: !!document.querySelector('[data-action="task-submit-answer"]'),
    modal: (() => { const m = document.getElementById("modal-overlay"); return m && m.classList.contains("open") ? (m.textContent || "").replace(/\s+/g, " ").slice(0, 160) : null; })(),
    result: (document.getElementById("submit-result") || {}).textContent || null,
    toast: [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()).slice(-1)[0] || null,
  })).catch(e => ({ evalError: e.message })));
}

/**
 * Sign the FIRST participant in through the browser, enter the competition and
 * open the given challenge by its card. The session is established BEFORE the
 * navigation (v7.21.26), and the wait is for the challenge's OWN card, which
 * cannot exist before boot has finished routing (v8.1.0).
 */
async function openChallenge(page, f, taskId, mode) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await codeLogin(page.request, f.users[0].email, H(csrfToken));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: f.comp.id } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  const card = page.locator(`#task-grid [data-task-id="${taskId}"]`);
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.click();
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
  await expect(page.locator("#ans-text"), "the answer box is rendered").toBeVisible({ timeout: 15000 });
  await expect(page.locator("#ans-text")).toHaveAttribute("data-mode", mode);
}

/** Switch the open detail view to another challenge, through the app's own entry point. */
async function openAnother(page, taskId, mode) {
  await page.evaluate((id) => window.openTask(id), taskId);
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
  await expect(page.locator(`#ans-text[data-mode="${mode}"]`)).toBeVisible({ timeout: 15000 });
}

/**
 * Record every OPENING of the shared #modal-overlay from now on. A point-in-time
 * count cannot tell "never opened" from "opened and was dismissed"; this can.
 * `#modal-overlay` is one persistent element toggled via `.open` (ui/modal.js),
 * never removed, so an attribute observer sees every transition.
 */
async function armModalRecorder(page) {
  await page.evaluate(() => {
    const m = document.getElementById("modal-overlay");
    window.__modalOpens = 0;
    let wasOpen = m.classList.contains("open");
    new MutationObserver(() => {
      const isOpen = m.classList.contains("open");
      if (isOpen && !wasOpen) window.__modalOpens++;
      wasOpen = isOpen;
    }).observe(m, { attributes: true, attributeFilter: ["class"] });
  });
}
const modalOpens = (page) => page.evaluate(() => window.__modalOpens);

/** A submit-response wait whose failure names the view rather than a bare timeout. */
function awaitSubmit(page, taskId, timeout = 10000) {
  return page.waitForResponse(
    r => r.request().method() === "POST" && r.url().endsWith(`/api/tasks/${taskId}/submit`),
    { timeout },
  ).catch(e => e);
}

test.describe("v8.9.0 — the any-answer type on the participant's screen", () => {
  test("THE REPORTED FLOW: an any-answer submit skips the penalty warning and is accepted verbatim", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf);
      await openChallenge(page, f, f.anyTask.id, "any");
      const submitBtn = page.locator('[data-action="task-submit-answer"][data-mode="any"]');
      await expect(submitBtn, "a plain Submit Answer button, in the any mode").toBeVisible();
      await expect(submitBtn).toHaveText(/Submit Answer/);
      await expect(page.locator('[data-action="task-submit-answer"][data-mode="text"]'),
        "…and not the text-mode one beside it").toHaveCount(0);
      await expect(page.locator("#task-detail-card")).toContainText(/any non-empty answer is accepted/i);

      await armModalRecorder(page);
      // Registered BEFORE the click, or a fast server answers before the wait exists.
      const respP = awaitSubmit(page, f.anyTask.id);
      await page.locator("#ans-text").fill(" hello world ");
      await submitBtn.click();
      // The warning, where it exists, opens SYNCHRONOUSLY inside the click's
      // dispatch (the `await showModal` is the first suspension), so this cannot
      // be a race — and it is asserted FIRST so a regression fails here, fast,
      // rather than as a 10-second wait for a response the open modal is blocking.
      await expect(page.locator("#modal-overlay.open"),
        "no penalty warning for a challenge that cannot be answered wrongly").toHaveCount(0);
      const resp = await respP;
      if (resp instanceof Error) throw new Error(`the submit never reached the server. View: ${await view(page)}\n${resp.message}`);
      expect(resp.status(), "the submit is a plain 200").toBe(200);
      const body = await resp.json();
      expect(body.correct, "every non-empty answer is correct").toBe(true);
      expect(body.pointsDelta, "and it scores").toBeGreaterThan(0);
      // VERBATIM: the client sends the raw value, leading and trailing spaces
      // included — the multipart part is exactly what was typed.
      const post = resp.request().postDataBuffer();
      expect(post, "the request body is readable").toBeTruthy();
      expect(post.toString("utf8"), "the answer left the browser untrimmed").toMatch(/\r?\n hello world \r?\n/);

      await expect(page.locator("h2:has-text('Challenge Solved!')"), "the congrats panel").toBeVisible({ timeout: 15000 });
      expect(await modalOpens(page), "the shared modal never opened at any point of the flow").toBe(0);
      await expect(page.locator("#submit-result"), "and nothing claimed a penalty").not.toContainText(/pts penalty/i);
    } finally { await api.dispose(); }
  });

  test("CONTROL: a text-answer submit still raises the 5-point warning, and proceeds once accepted", async ({ page }) => {
    // Without this, "no modal opened" is satisfied by a build that lost the
    // warning for every answer type.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf);
      await openChallenge(page, f, f.textTask.id, "text");
      await armModalRecorder(page);
      const submits = [];
      page.on("request", r => { if (r.method() === "POST" && r.url().endsWith(`/api/tasks/${f.textTask.id}/submit`)) submits.push(r.url()); });
      const respP = awaitSubmit(page, f.textTask.id, 20000);
      await page.locator("#ans-text").fill(TEXT_KEY);
      await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
      const modal = page.locator("#modal-overlay.open");
      await expect(modal, "the penalty warning stands for a text answer").toBeVisible({ timeout: 10000 });
      await expect(modal).toContainText(/5 points/);
      expect(await modalOpens(page)).toBe(1);
      expect(submits.length, "nothing left the browser while the warning stood").toBe(0);

      await modal.locator("button:has-text('Submit')").first().click();
      const resp = await respP;
      if (resp instanceof Error) throw new Error(`the submit never reached the server after the confirm. View: ${await view(page)}\n${resp.message}`);
      expect(resp.status()).toBe(200);
      expect((await resp.json()).correct, "the key was accepted").toBe(true);
      expect(submits.length, "exactly one request, after the confirm").toBe(1);
      await expect(page.locator("h2:has-text('Challenge Solved!')")).toBeVisible({ timeout: 15000 });
    } finally { await api.dispose(); }
  });

  test("an any-answer challenge renders no hint control; a hinted text challenge does", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf);
      await openChallenge(page, f, f.anyTask.id, "any");
      await expect(page.locator("#hint-area"), "no hint panel of any kind").toHaveCount(0);
      await expect(page.locator('[data-action="task-reveal-hint"]'), "no Show Hint button").toHaveCount(0);
      await expect(page.locator("#task-detail-card")).not.toContainText(/Show Hint/i);
      // The payload itself carries no hint for this type, which is what makes
      // the renderer's own `any` short-circuit defence in depth rather than the
      // only thing standing between the participant and a hint control…
      const wire = await (await page.request.get(`/api/tasks/${f.anyTask.id}`)).json();
      expect(wire.answer_type).toBe("any");
      expect(!!wire.hint_available, "the server never ships a hint for an any-answer challenge").toBe(false);
      // …so the short-circuit is driven DIRECTLY, against a payload that lies:
      // even a row claiming a hint must render nothing for this type. Without
      // this arm the client rule has no witness, because no real payload can
      // reach it.
      const lying = { id: f.anyTask.id, answer_type: "any", hint_available: true, difficulty: "easy", attempts_left: 3, solved: false };
      expect(await page.evaluate((t) => window.buildHintHtml(t), lying),
        "the client renders no hint for `any` whatever the payload says").toBe("");
      expect(await page.evaluate((t) => window.buildHintHtml(t), { ...lying, answer_type: "text" }),
        "control: the same payload as a text challenge DOES render the Show Hint control").toContain('data-action="task-reveal-hint"');
      // The Solution box, likewise: no "Correct Answer" line for a type with no key.
      const sol = await page.evaluate((t) => window.buildSolutionHtml(t),
        { answer_type: "any", correct_answer: "", explanation: "<p>Why</p>" });
      expect(sol).not.toContain("Correct Answer");
      expect(sol, "the box survives for the explanation, which is its remaining job").toContain("Explanation");
      expect(await page.evaluate((t) => window.buildSolutionHtml(t), { answer_type: "any", correct_answer: "", explanation: "" }),
        "and with nothing to say it renders no empty shell").toBe("");

      // The real text challenge WITH a hint — the control on the live surface.
      await openAnother(page, f.textTask.id, "text");
      await expect(page.locator("#hint-area"), "the hint panel renders for a hinted text challenge").toBeVisible();
      const reveal = page.locator('[data-action="task-reveal-hint"]');
      await expect(reveal).toBeVisible();
      await expect(reveal).toContainText(/Show Hint/);
    } finally { await api.dispose(); }
  });

  test("a whitespace-only any answer is refused client-side: a toast, no request, no modal", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf);
      await openChallenge(page, f, f.anyTask.id, "any");
      await armModalRecorder(page);
      const submits = [];
      page.on("request", r => { if (r.method() === "POST" && /\/api\/tasks\/[^/]+\/submit$/.test(r.url())) submits.push(r.url()); });
      await page.locator("#ans-text").fill("   ");
      await page.locator('[data-action="task-submit-answer"][data-mode="any"]').click();
      await expect(page.locator(".toast").last()).toContainText(/enter an answer/i, { timeout: 8000 });
      // The toast is the handler's early RETURN, issued before any fetch could
      // be built — so once it is on screen a request that was going to fire has
      // fired. A short settle lets the request event reach the test side.
      await page.waitForTimeout(500);
      expect(submits, "no submit request was made for a blank answer").toEqual([]);
      expect(await modalOpens(page), "and no modal opened").toBe(0);
      await expect(page.locator("#ans-text"), "the box is still there, holding what was typed").toHaveValue("   ");
      await expect(page.locator("#submit-result")).toBeEmpty();
      // And the score did not move: a blank that reached the server as a wrong
      // answer would have cost 5 points.
      const me = await (await page.request.get("/api/me")).json();
      expect(me.score, "no penalty").toBe(0);
    } finally { await api.dispose(); }
  });
});

test.describe("v8.9.0 — the any-answer type on the admin's screen", () => {
  test("the challenge editor swaps the answer + hint boxes for a note, and saves with only a title", async ({ page }) => {
    const { adminLogin, clickTab } = require("./ui-admin-helpers");
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Through the app's own entry point rather than a guessed button selector.
    await page.evaluate(() => window.openTaskForm());
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#tf-atype")).toHaveValue("text");
    await expect(page.locator("#tf-atype option[value='any']")).toHaveText(/Any answer \(free response\)/);

    // `any`: no key to type, no hint to write, a note where the key box stood.
    await page.locator("#tf-atype").selectOption("any");
    await expect(page.locator("#tf-answer-group"), "the Correct Answer cell is hidden").toBeHidden();
    await expect(page.locator("#tf-hint-group"), "the hint editor is hidden — the server refuses a hint on this type").toBeHidden();
    await expect(page.locator("#tf-any-note-group"), "and the rule is stated where the key box stood").toBeVisible();
    await expect(page.locator("#tf-any-note-group")).toContainText(/any non-empty answer is accepted/i);
    await expect(page.locator("#tf-add-answer")).toBeHidden();

    // `text`: the reverse, additional-answers control included.
    await page.locator("#tf-atype").selectOption("text");
    await expect(page.locator("#tf-answer-group")).toBeVisible();
    await expect(page.locator("#tf-hint-group")).toBeVisible();
    await expect(page.locator("#tf-any-note-group")).toBeHidden();
    await expect(page.locator("#tf-add-answer"), "the additional-answers control is back for text").toBeVisible();

    // Save an `any` challenge with nothing but a title.
    await page.locator("#tf-atype").selectOption("any");
    const title = `${uniq()} FormAny`;
    await page.locator("#tf-title").fill(title);
    const saveP = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/admin/tasks"), { timeout: 15000 }).catch(e => e);
    await page.locator("#save-publish-btn").click();
    const save = await saveP;
    if (save instanceof Error) {
      const toast = await page.locator(".toast").last().textContent().catch(() => null);
      throw new Error(`the save never reached the server (last toast: ${JSON.stringify(toast)})\n${save.message}`);
    }
    expect(save.status(), `save: ${await save.text()}`).toBe(200);
    const tasks = async () => { const l = await (await page.request.get("/api/admin/tasks")).json(); return l.tasks || l; };
    await expect.poll(async () => ((await tasks()).find(t => t.title === title) || {}).answer_type ?? null,
      { timeout: 15000, message: "the row exists with the any type" }).toBe("any");
    const row = (await tasks()).find(t => t.title === title);
    expect(row.correct_answer, "an any challenge stores an EMPTY key, not a null or a placeholder").toBe("");
    expect(row.hint || null, "and no hint").toBeNull();
    expect(row.status).toBe("published");
  });

  test("View as Participant shows no answer and no hint for an any challenge, and says why", async ({ page }) => {
    const { adminLogin, clickTab, narrowChallengesTable } = require("./ui-admin-helpers");
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const mk = async (data) => {
      const r = await page.request.post("/api/admin/tasks", { headers: H(csrf), data });
      expect(r.ok(), `seed ${data.title}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).id;
    };
    const anyTitle = `${uniq()} PrevAny`;
    await mk({ title: anyTitle, description: "<p>Say anything.</p>", difficulty: "easy", answer_type: "any",
               explanation: "<p>Any reflection counts.</p>", status: "published" });
    const textTitle = `${uniq()} PrevText`;
    await mk({ title: textTitle, description: "<p>Name the word.</p>", difficulty: "easy", answer_type: "text",
               correct_answer: "the plain answer", hint: "<p>Look under the mat.</p>", status: "published" });

    await clickTab(page, "Challenges");
    // Narrow first: the challenges table paginates at 30 (the v7.15.29 rule).
    await narrowChallengesTable(page, anyTitle);
    await page.locator("#admin-task-body tr", { hasText: anyTitle }).first()
      .locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(overlay.locator(".task-preview-answer"), "no Correct Answer block").toHaveCount(0);
    await expect(overlay.locator(".task-preview-hint"), "no Hint block").toHaveCount(0);
    await expect(overlay).not.toContainText(/Correct Answer/);
    await expect(overlay.locator(".task-preview-kicker"), "the kicker says any answer is accepted").toContainText(/any answer is accepted/i);
    await expect(overlay, "and the rule is spelled out in the body").toContainText(/no hint and no wrong-answer penalty/i);
    await expect(overlay, "the explanation still shows — it is the solution box's remaining job").toContainText("Any reflection counts.");
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toHaveCount(0);

    // CONTROL: a text challenge with a key and a hint renders both blocks.
    await narrowChallengesTable(page, textTitle);
    await page.locator("#admin-task-body tr", { hasText: textTitle }).first()
      .locator("[data-action='task-view']").first().click();
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(overlay.locator(".task-preview-answer")).toHaveText("the plain answer");
    await expect(overlay.locator(".task-preview-hint")).toBeVisible();
    await expect(overlay.locator(".task-preview-hint")).toContainText("Look under the mat.");
    await expect(overlay.locator(".task-preview-kicker")).toContainText(/hint & solution revealed/i);
  });
});
