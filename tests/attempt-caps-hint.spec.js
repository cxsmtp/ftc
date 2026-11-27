// v8.1.0 — an exhausted participant is neither OFFERED nor CHARGED for a hint.
//
// The defect this locks: the priced "Show Hint −N pts" row rendered directly
// ABOVE the "No attempts left" panel, and `POST /api/tasks/:id/hint` gated on
// ended / upcoming / needs-slot / locked / already-solved but never on the
// attempt budget — so one click took a permanent 30% deduction on a challenge
// the same screen said could never be attempted again. The route already refuses
// a SOLVED participant for exactly that reason, so the two terminal states
// disagreed.
//
// THE TWO POSITIVE CONTROLS EARN THEIR PLACE. "The hint was refused" is equally
// satisfied by a build where hints never work at all, and "the button is absent"
// by a build that never renders a hint panel — so each half is paired with the
// same fixture in its non-exhausted state.
//
// Every fixture owns its competition, its challenge and its participants, and
// each enrols a SECOND participant who never submits: exhaustion counts as
// "finished" for the auto-end predicate, so a lone exhausted participant would
// end the competition underneath the test (fixture checklist item 1).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ah${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// An `easy` challenge is 50 pts, so the hint costs round(50 * 0.3) = 15 and a
// wrong answer costs 5. Spelled out because every score assertion below is
// arithmetic over these two numbers — a build that refuses the hint and charges
// anyway is caught by the SCORE, not by the status code.
const HINT_COST = 15;
const WRONG_COST = 5;
const HINT_TEXT = "look at the second paragraph";

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A live competition with ONE capped, HINTED challenge and two enrolled participants. */
async function fixture(api, csrf, cap) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
            duration_minutes: 600, timezone: "UTC" },
  });
  expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const title = `${uniq()} Hinted`;
  const tr = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    // The `hint` is the whole point of the fixture — without it the route
    // 400s "This challenge has no hint" long before the cap is examined, and
    // every assertion here would measure that refusal instead.
    data: { title, description: "answer it", difficulty: "easy", answer_type: "text",
            correct_answer: "correct-one", hint: HINT_TEXT, status: "published", attempt_cap: cap },
  });
  expect(tr.ok(), `create task: ${await tr.text()}`).toBeTruthy();
  const taskId = (await tr.json()).id;
  expect(taskId, "the create returns the new challenge's id").toBeTruthy();
  const asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
  expect(asg.ok(), `assign task: ${await asg.text()}`).toBeTruthy();

  const users = [];
  for (let i = 0; i < 2; i++) {
    const label = uniq();
    const email = `${label}@company.example`;
    const reg = await registerPost(api, "/api/register", {
      headers: H(csrf),
      data: { firstName: "Hint", lastName: "Cap", nickname: label, email,
              company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
              password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" },
    });
    expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
    const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, `${label} is findable`).toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
    users.push({ id: u.id, email });
  }
  const asg2 = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [comp.id] },
  });
  expect(asg2.ok(), `assign users: ${await asg2.text()}`).toBeTruthy();
  // The assign endpoint SILENTLY SKIPS ineligible users, so a broken fixture must
  // fail AS a precondition rather than as a mysterious empty board later.
  expect((await asg2.json()).assigned, "both participants were enrolled").toBe(2);
  return { comp, taskId, title, users };
}

/** Sign a participant in and put them into the competition. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/** One submission through the real path, carrying the grading token. */
async function submit(api, csrf, taskId, answer) {
  // REQUIRED since v7.20.9 F1 — a submit with no grading token is 409
  // `task_changed` before anything else is examined, so a probe that omitted it
  // would spend no attempt and every cap assertion here would be vacuous.
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  const body = await r.json().catch(() => ({}));
  expect(r.status(), `submit "${answer}": ${JSON.stringify(body)}`).toBe(200);
  return body;
}

const hint = (api, csrf, taskId) =>
  api.post(`/api/tasks/${taskId}/hint`, { headers: { "x-csrf-token": csrf } });

const score = async (api) => (await (await api.get("/api/me")).json()).score;
const taskView = async (api, taskId) => (await (await api.get(`/api/tasks/${taskId}`)).json());

test.describe("v8.1.0 — a hint is not sold to a participant who cannot use it", () => {
  test("an EXHAUSTED participant is refused the hint, and is not charged for it", async () => {
    // Catches: the exhaustion check removed from POST /api/tasks/:id/hint, and —
    // via the score — a build that answers with a refusal while still writing the
    // hint_reveals row and taking the deduction.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 2);
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        await submit(p.api, p.csrf, f.taskId, "wrong-1");
        const spent = await submit(p.api, p.csrf, f.taskId, "wrong-2");
        expect(spent.attempts_left, "both attempts really are gone").toBe(0);
        const before = await score(p.api);
        expect(before, "two wrong answers, nothing else").toBe(-2 * WRONG_COST);

        const r = await hint(p.api, p.csrf, f.taskId);
        expect(r.status(), `the hint is refused: ${await r.text()}`).toBe(403);
        const d = await r.json();
        expect(d.code, "the refusal is NAMED so a client can branch on it").toBe("attempts_exhausted");
        // The refusal must name a remedy that actually works — an admin attempt
        // grant makes the challenge answerable again (v7.14.2).
        expect(d.error).toMatch(/organiser/i);
        expect(d.hint, "and it does not hand over the hint it just refused to sell").toBeFalsy();

        // THE ASSERTION THAT MATTERS. "It was refused" is satisfied by a build
        // that refuses and charges anyway; the score is what separates them.
        expect(await score(p.api), "the deduction was NOT taken").toBe(before);
        const view = await taskView(p.api, f.taskId);
        // hint_revealed is read straight off hint_reveals, so this is the row.
        expect(view.hint_revealed, "no hint_reveals row was written").toBe(false);
        expect(view.hint, "and the hint text was not leaked around the refusal").toBeFalsy();
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("POSITIVE CONTROL: with attempts REMAINING the hint is served, and charged", async () => {
    // Without this, "the hint was refused" is equally satisfied by a build in
    // which the hint endpoint never works for anyone.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 3);
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const spent = await submit(p.api, p.csrf, f.taskId, "wrong-1");
        expect(spent.attempts_left, "two of three still to go").toBe(2);
        const before = await score(p.api);

        const r = await hint(p.api, p.csrf, f.taskId);
        expect(r.status(), `the hint is served: ${await r.text()}`).toBe(200);
        const d = await r.json();
        expect(d.hint, "the hint text really is handed over").toBe(HINT_TEXT);
        expect(d.pointsDeducted, "and it really is charged").toBe(HINT_COST);
        expect(await score(p.api), "the deduction landed on the score").toBe(before - HINT_COST);
        expect((await taskView(p.api, f.taskId)).hint_revealed, "the hint_reveals row exists").toBe(true);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("an ALREADY-REVEALED hint is still returned after exhaustion, free", async () => {
    // Catches: an exhaustion check placed BEFORE the hint_reveals lookup, which
    // would take away something the participant had already paid for — and would
    // do it on the ordinary re-open, since the client re-fetches the challenge
    // every time it is opened.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 2);
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        // Buy it while attempts remain…
        const bought = await hint(p.api, p.csrf, f.taskId);
        expect(bought.status(), `first reveal: ${await bought.text()}`).toBe(200);
        expect((await bought.json()).pointsDeducted).toBe(HINT_COST);

        // …then burn the budget.
        await submit(p.api, p.csrf, f.taskId, "wrong-1");
        const spent = await submit(p.api, p.csrf, f.taskId, "wrong-2");
        expect(spent.attempts_left, "exhausted").toBe(0);
        const before = await score(p.api);
        expect(before, "one hint plus two wrong answers").toBe(-(HINT_COST + 2 * WRONG_COST));

        const again = await hint(p.api, p.csrf, f.taskId);
        expect(again.status(), `a paid-for hint survives exhaustion: ${await again.text()}`).toBe(200);
        const d = await again.json();
        expect(d.hint, "the text they paid for is still theirs").toBe(HINT_TEXT);
        expect(d.pointsDeducted, "and is not charged a second time").toBe(0);
        expect(await score(p.api), "the score did not move").toBe(before);
        // The client renders the revealed hint from this flag, so it must survive
        // exhaustion too or the hint would visibly disappear on the next open.
        expect((await taskView(p.api, f.taskId)).hint, "GET still ships the revealed hint").toBe(HINT_TEXT);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });
});

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
  // Wait for the challenge's own CARD, never for the nav: `showMain()` reveals
  // `#main-nav` for ANY main page, so that signal goes true partway through boot
  // and boot's own later routing yanks the detail view back to the list
  // (v8.1.0, attempt-caps-ui). A card carrying THIS challenge's id cannot exist
  // before `loadTasks` has rendered.
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  const card = page.locator(`#task-grid [data-task-id="${f.taskId}"]`);
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.click();
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
  await expect(page.locator("#ans-text, .attempts-exhausted").first()).toBeVisible({ timeout: 15000 });
  return csrf;
}

/** Spend one attempt out-of-band, through the real submit path. */
async function spendAttempt(page, taskId, answer) {
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const gradingHash = (await (await page.request.get(`/api/tasks/${taskId}`)).json()).grading_hash || "";
  const r = await page.request.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash },
  });
  expect(r.ok(), `spend an attempt: ${await r.text()}`).toBeTruthy();
}

test.describe("v8.1.0 — the hint affordance follows the attempt budget", () => {
  test("with NO attempts left the priced Show-Hint button is gone and the reason is shown", async ({ page }) => {
    // Catches: the `attempts_left === 0` branch removed from buildHintHtml — the
    // reported defect, where the yellow "−15 pts" row sat directly above the
    // "No attempts left" panel and clicking it took the deduction.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 1);
      // Log in first so page.request shares the participant's cookie jar, then
      // spend the single attempt BEFORE opening the view, so the very first
      // render is the exhausted one.
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      const li = await codeLogin(page.request, f.users[0].email, H(csrfToken));
      expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
      const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await page.request.post("/api/select-competition", { headers: H(c2), data: { competitionId: f.comp.id } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      await spendAttempt(page, f.taskId, "spent-it");

      await page.goto("/");
      await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
      const card = page.locator(`#task-grid [data-task-id="${f.taskId}"]`);
      await card.waitFor({ state: "visible", timeout: 20000 });
      await card.click();
      await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });

      // Precondition: this really is the exhausted view, not merely a card that
      // failed to render a hint panel for some unrelated reason.
      await expect(page.locator(".attempts-exhausted"), "the challenge is locked out").toBeVisible({ timeout: 15000 });
      await expect(page.locator('[data-action="task-reveal-hint"]'),
        "a priced hint button over a challenge that can never be attempted again")
        .toHaveCount(0);
      // Gate the affordance and the EXPLANATION together — a hint panel that
      // simply vanished reads as a broken feature (v7.14.2).
      await expect(page.locator("#hint-area")).toContainText(/Hint unavailable/i);
      await expect(page.locator("#hint-area")).toContainText(/no attempts left/i);
      // …and it names the remedy that actually works.
      await expect(page.locator("#hint-area")).toContainText(/organiser/i);
      // The hint TEXT itself is not quietly handed over in the explanation.
      await expect(page.locator("#task-detail-card")).not.toContainText(HINT_TEXT);
    } finally { await api.dispose(); }
  });

  test("POSITIVE CONTROL: with attempts remaining the priced Show-Hint button IS rendered", async ({ page }) => {
    // Without this, "the button is absent" is equally satisfied by a build that
    // never renders a hint panel at all — or by a fixture whose challenge simply
    // has no hint.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, 2);
      await openChallenge(page, f);
      const btn = page.locator('[data-action="task-reveal-hint"]');
      await expect(btn, "the hint is on offer while the challenge is answerable").toHaveCount(1);
      await expect(page.locator("#hint-area")).toContainText(/30% deduction/i);
      await expect(page.locator("#hint-area"), "…and the exhausted copy is NOT shown")
        .not.toContainText(/Hint unavailable/i);
    } finally { await api.dispose(); }
  });
});
