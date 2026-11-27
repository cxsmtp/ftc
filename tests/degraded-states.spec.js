// @ts-check
//
// v8.11.11 — A DEGRADED READ MUST NOT RENDER AS A CONFIDENT ANSWER.
//
// Six surfaces answered a failed request with a sentence that was true only if
// the request had SUCCEEDED: an empty leaderboard, "No attachments yet.", a red
// "incorrect" panel over a submission nothing graded, and three admin panes that
// went blank with no way back. Every one is the same defect — a `catch(()=>[])`
// or a shared error class collapsing "we could not find out" into "there is
// none" — and every one is invisible to the existing load-failure suite, which
// covers seven admin panes and no participant surface at all.
//
// EVERY ARM CARRIES A CONTROL, because "the failure message appeared" is equally
// satisfied by a build that shows it unconditionally, which would be a worse
// product than the bug: the genuinely-empty and genuinely-wrong cases must still
// say what they always said, in different words.
const { test, expect } = require("./isolated-test");
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");
const fs = require("fs");

const CSS = fs.readFileSync(require("path").join(__dirname, "..", "public", "styles.css"), "utf8");

// The session is established through the API and the SPA then BOOTS into it —
// the shape every admin UI spec uses. Driving the login FORM would make each arm
// depend on the login card's own markup, which is not what any of them is about.
async function loginViaApi(page, email, password) {
  const post = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  let r = await post(password).catch(() => null);
  if (!r || !r.ok()) {
    // v7.22.5 — the built-in superadmin password rotates globally, so one
    // re-read is the difference between a real failure and a stale credential.
    await new Promise((res) => setTimeout(res, 300));
    r = await post(email === "superadmin" ? await getSuperadminPass() : password);
  }
  if (!r.ok()) throw new Error(`login(${email}) failed: ${r.status()} ${await r.text()}`);
}

// *Competition-fixture checklist* item 10: a participant with exactly ONE event
// is taken STRAIGHT INTO it — the sole-event landing — so the picker is never
// rendered and a test that clicks a card waits out its whole budget on a grid
// that does not exist. Settle into whichever view the app chose.
async function enterEvent(page, compId) {
  const card = page.locator(`#comp-grid [data-comp-id="${compId}"]`).first();
  const inside = page.locator("#nav-challenges:not([aria-disabled=true]), #nav-leaderboard:not([aria-disabled=true])").first();
  const seen = (l) => l.isVisible().catch(() => false);
  await expect
    .poll(async () => (await seen(inside)) || (await seen(card)),
      { timeout: 20000, message: "neither the picker nor the in-event nav ever rendered" })
    .toBe(true);
  if (!(await seen(inside))) {
    await card.click();
    const confirm = page.locator("#modal-confirm-btn");
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect(inside).toBeVisible({ timeout: 20000 });
}

async function loginParticipant(page, email, pass) {
  await loginViaApi(page, email, pass);
  await page.goto(BASE + "/");
  await expect(page.locator("#main-nav .nav-btn").first()).toBeVisible({ timeout: 20000 });
}

async function loginAdmin(page) {
  await loginViaApi(page, "superadmin", await getSuperadminPass());
  await page.goto(BASE + "/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
}

// Every submit on a graded type raises the permanent-penalty confirm first
// (participant-tasks.js), so a test that clicks Submit and waits for a result
// waits on a dialog nobody answered.
async function submitOnce(page) {
  await page.locator('[data-action="task-submit-answer"]').first().click();
  const ok = page.locator("#modal-confirm-btn");
  await expect(ok).toBeVisible({ timeout: 10000 });
  await ok.click();
}

test.describe("v8.11.11 — a failed read never claims the thing is empty", () => {
  // ─── 1. THE LEADERBOARD ────────────────────────────────────────────────────
  //
  // `loadLeaderboard` returns without touching `#lb-body` on a 429, a 5xx, an
  // abort after retries and an unreadable body — correct about KEEPING a
  // populated board, and on a FIRST load there is nothing to keep, so the
  // participant got an empty table, no message and no toast. Indistinguishable
  // from "nobody has scored yet", on the screen they watch for the whole event.
  test("a failed FIRST load says so and offers a retry; an empty board says something else", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const { api: anon, csrf: ac } = await freshCtx();
      const email = `deg-lb-${Date.now()}@acme.com`;
      const reg = await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac },
        data: { email, nickname: `deglb${Date.now()}`.slice(0, 20), password: PARTICIPANT_PASS,
          firstName: "Deg", lastName: "Lb", company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London" },
      });
      expect(reg.ok(), "the fixture participant must register").toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      const me = (list.participants || list.users || []).find((p) => p.email === email);
      expect(me, "the fixture participant must be findable").toBeTruthy();
      for (const ep of ["verify", "approve"]) await sa.post(`/api/admin/participants/${me.id}/${ep}`, { headers: { "x-csrf-token": csrf } });

      const comps = await (await sa.get("/api/admin/competitions")).json();
      const live = (comps.competitions || comps).find((c) => c.status === "live");
      expect(live, "a live competition must exist in the seed").toBeTruthy();
      const asg = await sa.post("/api/admin/competitions/assign",
        { headers: { "x-csrf-token": csrf }, data: { competitionIds: [live.id], userIds: [me.id] } });
      expect((await asg.json()).assigned, "the assign must actually enrol them").toBe(1);

      // FAIL the very first board read, so there is genuinely nothing to keep.
      await page.route("**/api/leaderboard*", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"nope"}' }));
      await loginParticipant(page, email, PARTICIPANT_PASS);
      await enterEvent(page, live.id);
      await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();

      const body = page.locator("#lb-body");
      await expect(body, "a failed board must SAY it failed").toContainText(/could not load/i, { timeout: 20000 });
      await expect(page.locator('#lb-body [data-action="retry-load-leaderboard"]'),
        "and must offer the way back").toBeVisible();

      // CONTROL — an EMPTY board is a real answer and must read differently.
      // Without this, "it says could not load" is satisfied by a build that
      // prints that sentence over every board, empty or not.
      await page.unroute("**/api/leaderboard*");
      await page.route("**/api/leaderboard*", (r) => r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ top3: [], board: [], me: null, board_limit: 20, ended: false }) }));
      await page.locator('#lb-body [data-action="retry-load-leaderboard"]').click();
      await expect(body, "an empty board must not borrow the failure copy").toContainText(/no scores yet/i, { timeout: 15000 });
      await expect(body).not.toContainText(/could not load/i);
    } finally { await ctx.close(); }
  });

  // ─── 2. THE SUBMIT PANEL ───────────────────────────────────────────────────
  //
  // `.result-msg wrong` is the platform's ONE way of saying "you answered
  // incorrectly" — red, and the only other thing that paints it says "−5 pts
  // penalty". Every non-2xx wore it, so a throttle and a mid-flight edit read as
  // a graded wrong answer with a penalty, on the screen where a participant is
  // counting their remaining attempts. Neither was graded; neither cost a point.
  test("a refusal is a NOTICE, not a wrong answer — and a real wrong answer still is one", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const { api: anon, csrf: ac } = await freshCtx();
      const email = `deg-sub-${Date.now()}@acme.com`;
      await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac },
        data: { email, nickname: `degsub${Date.now()}`.slice(0, 20), password: PARTICIPANT_PASS,
          firstName: "Deg", lastName: "Sub", company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London" },
      });
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      const me = (list.participants || list.users || []).find((p) => p.email === email);
      for (const ep of ["verify", "approve"]) await sa.post(`/api/admin/participants/${me.id}/${ep}`, { headers: { "x-csrf-token": csrf } });

      // Own the competition and TWO challenges (fixture checklist item 1: one
      // participant solving the only challenge ENDS the competition).
      const cc = await sa.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf }, data: {
        name: `DegSub ${Date.now()}`, event_kind: "tournament",
        start_time: new Date(Date.now() - 60000).toISOString(), duration_minutes: 600, timezone: "UTC" } });
      const comp = (await cc.json()).competition;
      const tids = [];
      for (const n of [1, 2]) {
        const tr = await sa.post("/api/admin/tasks", { headers: { "x-csrf-token": csrf }, data: {
          title: `DegSub T${n} ${Date.now()}`, description: "d", difficulty: "easy",
          answer_type: "text", correct_answer: "right", status: "published" } });
        const tid = (await tr.json()).id;
        tids.push(tid);
        await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: { "x-csrf-token": csrf }, data: { competitionIds: [comp.id] } });
      }
      const asg = await sa.post("/api/admin/competitions/assign",
        { headers: { "x-csrf-token": csrf }, data: { competitionIds: [comp.id], userIds: [me.id] } });
      expect((await asg.json()).assigned).toBe(1);

      await loginParticipant(page, email, PARTICIPANT_PASS);
      await enterEvent(page, comp.id);
      await page.locator("#nav-challenges:not([aria-disabled=true])").click();
      await page.locator(`[data-task-id="${tids[0]}"]`).first().click();
      await expect(page.locator("#ans-text")).toBeVisible({ timeout: 15000 });

      // (a) a 429 — throttled, NOT graded.
      await page.route("**/api/tasks/*/submit", (r) => r.fulfill({ status: 429, contentType: "application/json", body: "{}" }));
      await page.fill("#ans-text", "anything");
      await submitOnce(page);
      const res = page.locator("#submit-result .result-msg");
      await expect(res).toBeVisible({ timeout: 15000 });
      await expect(res, "a throttle must not wear the wrong-answer class").not.toHaveClass(/\bwrong\b/);
      await expect(res).toHaveClass(/\bnotice\b/);
      // and it must SAY something — the empty-red-panel bug.
      expect((await res.innerText()).trim().length,
        "a refusal with no `error` key rendered an EMPTY red panel").toBeGreaterThan(10);

      // (b) a 500 carrying no `error` key at all — the exact shape that rendered blank.
      await page.unroute("**/api/tasks/*/submit");
      await page.route("**/api/tasks/*/submit", (r) => r.fulfill({ status: 500, contentType: "text/html", body: "<html>502</html>" }));
      await submitOnce(page);
      await expect(res).toBeVisible({ timeout: 15000 });
      expect((await res.innerText()).trim().length,
        "a non-JSON 500 must still produce a sentence").toBeGreaterThan(10);
      await expect(res).not.toHaveClass(/\bwrong\b/);

      // CONTROL — a genuinely WRONG answer must still be red and still say penalty.
      // Without this the fix is satisfied by a build that retired `.wrong`.
      await page.unroute("**/api/tasks/*/submit");
      await page.fill("#ans-text", "definitely-not-right");
      await submitOnce(page);
      await expect(res, "a real wrong answer is still a wrong answer").toHaveClass(/\bwrong\b/, { timeout: 15000 });
      await expect(res).toContainText(/incorrect/i);
    } finally { await ctx.close(); }
  });

  // ─── 3. THE ATTACHMENT READ ────────────────────────────────────────────────
  //
  // `r.ok?r.json():[]` degraded a failed read to an empty array, and the empty
  // branch then rendered "No attachments yet." — a positive claim about the
  // challenge, made from a request that failed. An admin saving that form
  // believes the challenge has none.
  test("a failed attachment read does not claim the challenge has none", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const tr = await sa.post("/api/admin/tasks", { headers: { "x-csrf-token": csrf }, data: {
        title: `DegAtt ${Date.now()}`, description: "d", difficulty: "easy",
        answer_type: "text", correct_answer: "x", status: "published" } });
      const tid = (await tr.json()).id;

      await loginAdmin(page);
      await page.route(`**/api/admin/tasks/${tid}/attachments`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
      await page.click('button.admin-nav-item[data-tab-id="admin-tasks-tab"]');
      // `editTask` renders ENTIRELY from `S.adminTasksData` and opens with
      // `if (!t) return;` — against a model that has not loaded it is a SILENT
      // no-op, surfacing as a missing overlay that names nothing (the v8.1.0
      // class). Wait for the row to be IN the model, not for the pane to appear.
      await expect
        .poll(() => page.evaluate((id) => (window.S?.adminTasksData || []).some((t) => t.id === id), tid),
          { timeout: 20000, message: "the challenge never reached S.adminTasksData" })
        .toBe(true);
      await page.evaluate((id) => window.editTask(id), tid);
      const list = page.locator("#tf-attachments-list");
      await expect(list).toBeVisible({ timeout: 20000 });
      await expect(list, "a failed read must not claim there are none").not.toContainText(/no attachments yet/i);
      await expect(list).toContainText(/could not load/i);
      await expect(list.locator('[data-action="retry-load-attachments"]')).toBeVisible();

      // CONTROL — a challenge that really has none must still say so.
      await page.unroute(`**/api/admin/tasks/${tid}/attachments`);
      await page.locator('#tf-attachments-list [data-action="retry-load-attachments"]').click();
      await expect(list, "an empty list is still an empty list").toContainText(/no attachments yet/i, { timeout: 15000 });
    } finally { await ctx.close(); }
  });

  // ─── 4. THE ADMIN PANES WITH NO POLL ───────────────────────────────────────
  //
  // Measured: exactly ONE admin poll exists (`startAdminCompPoll`), and its body
  // calls `loadAdminCompetitions` alone. Challenges / participants / groups /
  // submissions / rankings do NOT re-request, so a failed load there was
  // TERMINAL — and Challenges asked for a whole PAGE RELOAD to recover, throwing
  // away every other pane's state.
  test("a pane that does not poll offers a retry, and the retry works", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      await loginAdmin(page);
      let fail = true;
      await page.route("**/api/admin/tasks", (r) =>
        fail ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : r.continue());
      await page.click('button.admin-nav-item[data-tab-id="admin-tasks-tab"]');
      const body = page.locator("#admin-task-body");
      await expect(body).toContainText(/could not load/i, { timeout: 20000 });
      const retry = page.locator('#admin-task-body [data-action="retry-load-admin-tasks"]');
      await expect(retry, "this pane never re-requests, so the failure is terminal without it").toBeVisible();
      // It must not ask for a page reload — that discards every other pane.
      await expect(body).not.toContainText(/reload the page/i);

      fail = false;
      await retry.click();
      await expect(body, "the retry must actually recover the pane").not.toContainText(/could not load/i, { timeout: 20000 });
    } finally { await ctx.close(); }
  });

  // ─── 5. SOURCE — the reservation is measured, not guessed ──────────────────
  //
  // A geometry arm cannot discriminate: the header only grows its second row
  // when the verify chip AND the timer AND the nav overrun the width, a state
  // that needs a live competition, an unverified account and a narrow viewport
  // at once. What must not come back is the CONSTANT.
  test("the admin table reserves the MEASURED header height", () => {
    // `max-height:none` reserves nothing (the phone card layout lets the page
    // scroll), so it is not a constant guess and is not held to the rule. On
    // phones the card layout is the only table-card height rule left, so the
    // desktop base rule is the one that reserves (and must measure) the header.
    const all = [...CSS.matchAll(/#admin-page \.table-card\{[^}]*max-height:[^;}]+/g)].map((m) => m[0]);
    expect(all.some((r) => /max-height:none$/.test(r)), "the phone card layout releases the height").toBe(true);
    const rules = all.filter((r) => !/max-height:none$/.test(r));
    expect(rules.length, "the base rule reserving the table's height must be present").toBeGreaterThanOrEqual(1);
    for (const r of rules) {
      expect(r, "the header is flex-wrapped and min-height:56px — a constant is a guess")
        .toMatch(/var\(--header-bottom\)/);
      expect(r, "and a constant must not be the whole subtrahend")
        .not.toMatch(/max-height:calc\(100dvh - \d+px\)/);
    }
  });

  // ─── 6. THE 24px FLOOR (SC 2.5.8) ──────────────────────────────────────────
  //
  // Measured, not asserted from the stylesheet: a `min-height` can be defeated
  // by a competing rule, and what the standard is about is the rendered box.
  test("every link-button in a dense table clears the 24px AA floor", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    // Its own context, so the file's beforeEach did not reach it: the Tags
    // column (which holds .tag-add) is not among the default six.
    await require("./ui-admin-helpers").showAllParticipantColumns(page);
    try {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const tr = await sa.post("/api/admin/tasks", { headers: { "x-csrf-token": csrf }, data: {
        title: `DegTgt ${Date.now()}`, description: "d", difficulty: "easy",
        answer_type: "text", correct_answer: "x", status: "published" } });
      const tid = (await tr.json()).id;
      await sa.post(`/api/admin/tasks/${tid}/tags`, { headers: { "x-csrf-token": csrf }, data: { tag: "degtgt" } });

      await loginAdmin(page);
      await page.click('button.admin-nav-item[data-tab-id="admin-participants-tab"]');
      await expect(page.locator("#admin-participants-body tr").first()).toBeVisible({ timeout: 20000 });
      // Measure whichever .tag-add is actually laid out: the Tags column is column
      // 11 of 13 on a table forced to min-width:1372px, so `.first()` can resolve
      // to one in a cell the viewport has not reached.
      const box = await page.evaluate(() => {
        for (const el of document.querySelectorAll(".tag-add")) {
          const r = el.getBoundingClientRect();
          if (r.height > 0) return { height: r.height, width: r.width };
        }
        return null;
      });
      expect(box, "the fixture must put a laid-out .tag-add on screen").toBeTruthy();
      expect(box.height, ".tag-add measured 18px — under the SC 2.5.8 24px minimum").toBeGreaterThanOrEqual(24);

      // The stylesheet half, for the four that need a populated board or stream
      // to render. Both halves are needed: this one covers reach, the measured
      // one above covers "the rule actually applies".
      const floor = CSS.match(/#admin-rankings-tab \.rk-player-link,[\s\S]{0,400}?\{min-height:24px[^}]*\}/);
      expect(floor, "the shared 24px floor rule must exist").toBeTruthy();
      for (const sel of ["\\.sub-link", "\\.rankings-card-view", "\\.log-details-btn"])
        expect(floor[0], `${sel} must be in the floor`).toMatch(new RegExp(sel));
    } finally { await ctx.close(); }
  });
});
