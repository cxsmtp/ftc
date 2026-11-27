// @ts-check
//
// v8.12.6 — what a superadmin SEES when a sealed disclosure cannot be recorded.
//
// sealed-reveal-unrecorded.api.spec.js pins that the values are withheld and
// the reason rides the wire. This file pins the half nothing on the wire can
// see: that the card SAYS so, with a sentence true of this reader, and that a
// refused Show Hint is never a button that silently does nothing (v7.14.2).
//
//  1. The GET's panels — "Answer not shown" and the hint panel — carry the
//     `unrecorded` sentence, NOT the ordinary "only a superadmin can reveal it",
//     whose remedy would be the very reader it is addressed to.
//  2. Show Hint → confirm under a failing record: the 503's own sentence is
//     toasted, no hint appears, nothing is charged.
//  3. A paid row that appeared AFTER the card rendered (another tab of the same
//     session): the fresh read says the hint is withheld (`unrecorded`), and the
//     card RE-RENDERS with that reason — before this release that path POSTed,
//     met a 503 and said nothing at all.
//  4. The same paid path when only the RE-FETCH fails: the refusal is toasted,
//     never swallowed.
//  5. A 503 whose body is not JSON (a reverse proxy's own page): the ordinary
//     "Failed to reveal hint." toast, not a crash.
//  6. (review) MID-EVENT, a solved sealed multiple-choice challenge: the correct
//     ids are the answer the record would have named, so they are withheld —
//     and the card says so under the options, with the retry sentence, rather
//     than showing unmarked options and nothing else. The ordinary participant
//     and the competing reader get their own sentence on the same card.
//
// Every arm carries its CONTROL: the same click once the record store works
// shows the hint, or "nothing was shown" is satisfied by a build that shows
// superadmins nothing.
//
// The record store is failed with a BEFORE INSERT … RAISE(ABORT) trigger on
// `task_versions`, scoped to one challenge (and, in arm 4, to the hint route's
// own record), and always dropped in a `finally`.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, assignTask, enrol } = require("./event-admin-helpers");
const { loginViaApi } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}
const dbExec = sql => withDb(db => db.exec(sql), { readonly: false });
const dbGet = (sql, ...a) => withDb(db => db.prepare(sql).get(...a));
const revealRows = id => dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", id).c;
const hintRows = (uid, tid) => dbGet("SELECT COUNT(*) c FROM hint_reveals WHERE user_id=? AND task_id=?", uid, tid).c;

/** Fail the History write for `taskId` (optionally only one route's record); ALWAYS dropped. */
async function withRecordFailing(taskId, fn, { onlyVia } = {}) {
  const trig = `zz_f3ui_${taskId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const via = onlyVia ? ` AND NEW.details LIKE '%"via":"${onlyVia}"%'` : "";
  dbExec(`CREATE TRIGGER ${trig} BEFORE INSERT ON task_versions WHEN NEW.change_type='sealed_reveal' AND NEW.task_id='${taskId}'${via} BEGIN SELECT RAISE(ABORT,'injected'); END;`);
  try {
    expect(dbGet("SELECT 1 x FROM sqlite_master WHERE type='trigger' AND name=?", trig), "precondition: the failure is really armed").toBeTruthy();
    return await fn();
  } finally { dbExec(`DROP TRIGGER IF EXISTS ${trig}`); }
}

let sa, saCsrf, author, boss, stander;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  const mk = async (label, role) => {
    const p = await makeParticipant(sa, saCsrf, label);
    const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
    expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return p;
  };
  author = await mk("f3uiauthor", "admin");
  // A USER-BACKED superadmin: its participant view is an ordinary one.
  boss = await mk("f3uiboss", "superadmin");
  stander = await makeParticipant(sa, saCsrf, "f3uistander");
});
test.afterAll(async () => { try { await sa?.dispose(); } catch (_) {} });

/** A sealed challenge (key, explanation, hint) by the author, in a fresh event. */
async function world(label, { ended = false } = {}) {
  const T = uniq(label).replace(/[^a-zA-Z0-9]/g, "");
  const { api: aApi, csrf: aCsrf } = await freshCtx();
  try {
    const li = await codeLogin(aApi, author.email, H(aCsrf));
    expect(li.ok(), await li.text()).toBeTruthy();
    const ac = (await (await aApi.get("/api/csrf-token")).json()).csrfToken;
    const cr = await aApi.post("/api/admin/tasks", { headers: H(ac), data: {
      title: uniq(`F3UI ${T}`), description: "<p>d</p>", difficulty: "easy", answer_type: "text",
      correct_answer: `SEALKEY_${T}`, explanation: `<p>SEALWHY_${T}</p>`, hint: `<p>SEALHINT_${T}</p>`,
      status: "published", answer_sealed: true } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const id = (await cr.json()).id;
    const comp = await makeCompetition(sa, saCsrf, label, ended ? { reveal_answers_on_end: true } : {});
    await assignTask(aApi, ac, id, [comp.id]);
    // A second enrollee who never solves keeps the all-solved auto-end away.
    await enrol(sa, saCsrf, comp.id, [stander.id]);
    if (ended) {
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), await end.text()).toBeTruthy();
    }
    return { T, id, comp };
  } finally { await aApi.dispose(); }
}

/** The superadmin in their own participant view, inside the event, with the card open. */
async function enter(page, W) {
  await loginViaApi(page, boss.email, PARTICIPANT_PASS);
  let pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const tg = await page.request.post("/api/toggle-admin-view", { headers: H(pc), data: { mode: "participant" } });
  expect(tg.ok(), await tg.text()).toBeTruthy();
  pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: W.comp.id } });
  expect(sel.ok(), await sel.text()).toBeTruthy();
  await page.goto("/");
  await page.waitForSelector("#nav-challenges:not([aria-disabled=true])", { state: "visible", timeout: 20_000 });
  await open(page, W);
  return pc;
}
async function open(page, W) {
  await page.evaluate(i => window.openTask(i), W.id);
  await page.waitForSelector("#task-detail-page.active", { timeout: 15_000 });
  await expect(page.locator("#task-detail-card")).toContainText("F3UI");
}
/** Every toast the page raises, recorded as it appears (they auto-dismiss). */
async function recordToasts(page) {
  await page.evaluate(() => {
    window.__f3Toasts = [];
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1 && (n.id === "toast-stack" || (n.closest && n.closest("#toast-stack")))) {
        window.__f3Toasts.push(n.textContent || "");
      }
    }))).observe(document.body, { childList: true, subtree: true });
  });
}
const toasts = page => page.evaluate(() => (window.__f3Toasts || []).join(" | "));
function countHintPosts(page, id) {
  const posts = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith(`/api/tasks/${id}/hint`)) posts.push(r.url()); });
  return posts;
}

test("the end-of-event card: a sealed answer and hint that cannot be recorded are replaced by panels saying so — and shown in the Solution box once the record works (CONTROL)", async ({ page }) => {
  const W = await world("f3uig", { ended: true });
  // NB: no dismiss-ended — it records nothing for a superadmin who is not
  // enrolled, and nothing below clicks through the ended-event dialog.
  await loginViaApi(page, boss.email, PARTICIPANT_PASS);
  let pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/toggle-admin-view", { headers: H(pc), data: { mode: "participant" } })).ok()).toBeTruthy();
  pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: W.comp.id } })).ok()).toBeTruthy();
  await page.goto("/");
  await page.waitForSelector("#nav-challenges:not([aria-disabled=true])", { state: "visible", timeout: 20_000 });
  const card = page.locator("#task-detail-card");

  await withRecordFailing(W.id, async () => {
    await open(page, W);
    await expect(card).toContainText("Answer not shown");
    await expect(card, "the reason this reader can act on").toContainText("could not be done just now");
    await expect(card, "…and not the tier sentence, whose remedy is the reader").not.toContainText("only a superadmin can reveal it");
    const hintArea = page.locator('#hint-area[data-hint-withheld-reason="unrecorded"]');
    await expect(hintArea).toBeVisible();
    await expect(hintArea, "the hint panel names the same reason").toContainText("could not be done just now");
    const html = await page.content();
    for (const s of [`SEALKEY_${W.T}`, `SEALWHY_${W.T}`, `SEALHINT_${W.T}`]) expect(html, `${s} is nowhere on the page`).not.toContain(s);
    expect(revealRows(W.id)).toBe(0);
  });

  await open(page, W);
  await expect(card, "CONTROL: shown, on the record").toContainText(`SEALKEY_${W.T}`);
  await expect(card).not.toContainText("Answer not shown");
  expect(revealRows(W.id)).toBe(1);
});

test("Show Hint → confirm under a failing record: the refusal is toasted, no hint appears and nothing is charged — and the same click shows the hint once the record works (CONTROL)", async ({ page }) => {
  const W = await world("f3uia");
  await enter(page, W);
  await recordToasts(page);
  const btn = page.locator("[data-action='task-reveal-hint']");
  await expect(btn, "PRECONDITION: the superadmin is offered the hint").toHaveCount(1);

  await withRecordFailing(W.id, async () => {
    await btn.click();
    await expect(page.locator("#modal-title")).toHaveText("Reveal Hint");
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => toasts(page), { message: "the 503's own sentence is toasted", timeout: 10_000 })
      .toContain("could not be written just now");
    expect(await toasts(page), "…including that nothing was charged").toContain("no points were deducted");
    expect(await page.content(), "no hint anywhere").not.toContain(`SEALHINT_${W.T}`);
    expect(hintRows(boss.id, W.id), "nothing charged").toBe(0);
    expect(revealRows(W.id)).toBe(0);
    await expect(btn, "the control stays, the toast having said why").toBeVisible();
  });

  await btn.click();
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator("#hint-area"), "CONTROL: revealed, on the record").toContainText(`SEALHINT_${W.T}`, { timeout: 10_000 });
  expect(hintRows(boss.id, W.id)).toBe(1);
  expect(revealRows(W.id)).toBe(1);
});

test("a paid row that appeared after the card rendered: Show Hint re-renders the card with the `unrecorded` reason — never a button that silently does nothing — and shows the paid hint once the record works (CONTROL)", async ({ page }) => {
  const W = await world("f3uib");
  const pc = await enter(page, W);
  const btn = page.locator("[data-action='task-reveal-hint']");
  await expect(btn, "PRECONDITION: rendered unpaid").toHaveCount(1);
  // "Another tab" of the same session pays while the record store works.
  const pay = await page.request.post(`/api/tasks/${W.id}/hint`, { headers: H(pc) });
  expect(pay.ok(), await pay.text()).toBeTruthy();
  expect(hintRows(boss.id, W.id), "PRECONDITION: the row is paid").toBe(1);
  const posts = countHintPosts(page, W.id);

  await withRecordFailing(W.id, async () => {
    await btn.click();
    const area = page.locator('#hint-area[data-hint-withheld-reason="unrecorded"]');
    await expect(area, "the card re-rendered with the reason").toBeVisible({ timeout: 10_000 });
    await expect(area).toContainText("could not be done just now");
    await expect(page.locator("#modal-overlay.open"), "no priced confirm for a hint already paid").toHaveCount(0);
    expect(posts.length, "nothing POSTed into a refusal the fresh read already announced").toBe(0);
    expect(await page.content()).not.toContain(`SEALHINT_${W.T}`);
    expect(hintRows(boss.id, W.id), "no second row").toBe(1);
  });

  await open(page, W);
  await expect(page.locator("#hint-area"), "CONTROL: the paid hint, on the record").toContainText(`SEALHINT_${W.T}`);
});

test("a paid row that appeared after render, when only the hint route's own record fails: the re-fetch's refusal is toasted, never swallowed — and the re-fetch shows the hint once it works (CONTROL)", async ({ page }) => {
  const W = await world("f3uic");
  const pc = await enter(page, W);
  await recordToasts(page);
  const btn = page.locator("[data-action='task-reveal-hint']");
  await expect(btn, "PRECONDITION: rendered unpaid").toHaveCount(1);
  const pay = await page.request.post(`/api/tasks/${W.id}/hint`, { headers: H(pc) });
  expect(pay.ok(), await pay.text()).toBeTruthy();
  const posts = countHintPosts(page, W.id);

  // Only the hint ROUTE's record fails; the fresh GET's own record lands, so the
  // client takes its re-fetch branch — the path whose failure used to be silent.
  await withRecordFailing(W.id, async () => {
    await btn.click();
    await expect.poll(() => toasts(page), { message: "the re-fetch's 503 is spoken", timeout: 10_000 })
      .toContain("could not be written just now");
    expect(posts.length, "PRECONDITION: the re-fetch really ran").toBe(1);
    await expect(page.locator("#modal-overlay.open"), "no priced confirm for a hint already paid").toHaveCount(0);
    await expect(page.locator("#hint-area")).not.toContainText(`SEALHINT_${W.T}`);
    expect(hintRows(boss.id, W.id)).toBe(1);
  }, { onlyVia: "participant_hint" });

  await btn.click();
  await expect(page.locator("#hint-area"), "CONTROL: the re-fetch fills the panel").toContainText(`SEALHINT_${W.T}`, { timeout: 10_000 });
});

test("a 503 whose body is not JSON — a reverse proxy's own page — is reported as the ordinary failure, not a crash", async ({ page }) => {
  const W = await world("f3uid");
  await enter(page, W);
  await recordToasts(page);
  await page.route(`**/api/tasks/${W.id}/hint`, route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, contentType: "text/html", body: "<html><body>Service Unavailable</body></html>" })
    : route.continue());
  await page.locator("[data-action='task-reveal-hint']").click();
  await page.locator("#modal-confirm-btn").click();
  await expect.poll(() => toasts(page), { message: "the route's own failure sentence", timeout: 10_000 })
    .toContain("Failed to reveal hint.");
  expect(await toasts(page), "…not the dispatcher's catch-all for an exception").not.toContain("Something went wrong");
});

// ---------------------------------------------------------------------------
// v8.12.6 (review) — THE MID-EVENT CHOICE SOLVER. The server has withheld the
// correct ids from a solver of a SEALED multiple-choice challenge since v8.10.0
// (`answer_sealed_withheld`), and since this release also from a superadmin whose
// reveal could not be recorded (`unrecorded`) — but the client rendered the
// "Answer not shown" panel only at the END of the event. Mid-event the solved
// card showed unmarked options and nothing else: indistinguishable from the
// platform having lost the answer, with no "open it again to retry".
// ---------------------------------------------------------------------------

/** A sealed multiple-choice challenge by the author and an unsealed twin, both with a hint, in a fresh LIVE event. */
async function choiceWorld(label) {
  const T = uniq(label).replace(/[^a-zA-Z0-9]/g, "");
  const { api: aApi, csrf: aCsrf } = await freshCtx();
  try {
    const li = await codeLogin(aApi, author.email, H(aCsrf));
    expect(li.ok(), await li.text()).toBeTruthy();
    const ac = (await (await aApi.get("/api/csrf-token")).json()).csrfToken;
    const mk = async (sealed) => {
      const cr = await aApi.post("/api/admin/tasks", { headers: H(ac), data: {
        title: uniq(`F3UI ${sealed ? "sealed" : "open"} ${T}`), description: "<p>d</p>", difficulty: "easy",
        answer_type: "choice", choices: [{ text: `RIGHT_${T}`, correct: true }, { text: `WRONG_${T}`, correct: false }],
        hint: `<p>${sealed ? "SEALHINT" : "OPENHINT"}_${T}</p>`, status: "published", ...(sealed ? { answer_sealed: true } : {}) } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      return (await cr.json()).id;
    };
    const sealedId = await mk(true), openId = await mk(false);
    const comp = await makeCompetition(sa, saCsrf, label);
    await assignTask(aApi, ac, sealedId, [comp.id]);
    await assignTask(aApi, ac, openId, [comp.id]);
    // A second enrollee who never solves keeps the all-solved auto-end away.
    await enrol(sa, saCsrf, comp.id, [stander.id]);
    return { T, sealedId, openId, comp };
  } finally { await aApi.dispose(); }
}

/** Solve a choice challenge through the page's own session (the RIGHT option). */
async function solveChoice(page, pc, W, id) {
  const d = await (await page.request.get(`/api/tasks/${id}`)).json();
  const right = (d.choices || []).find(c => c.text === `RIGHT_${W.T}`);
  expect(right, "PRECONDITION: the options are on the wire").toBeTruthy();
  const r = await page.request.post(`/api/tasks/${id}/submit`, { headers: H(pc), data: { answer: JSON.stringify([right.id]), gradingHash: d.grading_hash } });
  expect((await r.json()).correct, `PRECONDITION: ${id} solved`).toBe(true);
}
async function openCard(page, id) {
  await page.evaluate(i => window.openTask(i), id);
  await page.waitForSelector("#task-detail-page.active", { timeout: 15_000 });
  await expect(page.locator("#task-detail-card .qa-title")).toContainText("F3UI");
  await expect.poll(() => page.evaluate(i => window._openedTaskId === i, id), { timeout: 15_000 }).toBe(true);
}
/** Is the Answer-not-shown panel BELOW the option list (inside the same card)? */
const panelUnderOptions = page => page.evaluate(() => {
  const o = document.querySelector("#task-detail-card #choice-review");
  const p = document.querySelector("#task-detail-card [data-answer-withheld]");
  return !!(o && p && (o.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING));
});

test("mid-event: a superadmin who SOLVED a sealed multiple-choice challenge is told, under the unmarked options, that the answer could not be shown and to retry — and once the record works the options are marked (CONTROL); an unsealed solved twin never shows the panel (CONTROL)", async ({ page }) => {
  const W = await choiceWorld("f3uimc");
  await loginViaApi(page, boss.email, PARTICIPANT_PASS);
  let pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/toggle-admin-view", { headers: H(pc), data: { mode: "participant" } })).ok()).toBeTruthy();
  pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: W.comp.id } })).ok()).toBeTruthy();
  await solveChoice(page, pc, W, W.sealedId);
  await solveChoice(page, pc, W, W.openId);
  expect(revealRows(W.sealedId), "PRECONDITION: solving disclosed nothing yet").toBe(0);
  await page.goto("/");
  await page.waitForSelector("#nav-challenges:not([aria-disabled=true])", { state: "visible", timeout: 20_000 });
  const card = page.locator("#task-detail-card");

  await withRecordFailing(W.sealedId, async () => {
    await openCard(page, W.sealedId);
    await expect(card, "PRECONDITION: the solved card").toContainText("You have solved this challenge.");
    await expect(card, "PRECONDITION: the event is still running").not.toContainText("has ended");
    await expect(card.locator(".choice-review-row"), "PRECONDITION: the options are on the card").toHaveCount(2);
    await expect(card.locator(".choice-review-row.is-correct"), "the correct ids were withheld, so nothing is marked").toHaveCount(0);
    const panel = card.locator("[data-answer-withheld]");
    await expect(panel, "…and the card says WHY").toBeVisible();
    await expect(panel).toContainText("Answer not shown");
    await expect(panel, "the reason this reader can act on").toContainText("Open the challenge again to retry");
    await expect(panel, "…not the tier sentence, whose remedy is the reader").not.toContainText("only a superadmin can reveal it");
    expect(await panelUnderOptions(page), "the panel sits under the option list").toBe(true);
    // Mid-event the unpaid sealed hint is still offered for points, so the panel
    // must not claim the hint is sealed away too.
    await expect(card.locator("[data-action='task-reveal-hint']"), "PRECONDITION: the hint is still offered mid-event").toHaveCount(1);
    await expect(panel, "no claim that the hint is sealed away beside its own Show Hint button").not.toContainText("sealed with it");
    expect(revealRows(W.sealedId)).toBe(0);
  });

  await openCard(page, W.sealedId);
  await expect(card.locator(".choice-review-row.is-correct"), "CONTROL: marked, on the record").toHaveCount(1);
  await expect(card.locator(".choice-review-row.is-correct")).toContainText(`RIGHT_${W.T}`);
  await expect(card.locator("[data-answer-withheld]")).toHaveCount(0);
  expect(revealRows(W.sealedId)).toBe(1);

  await openCard(page, W.openId);
  await expect(card.locator(".choice-review-row.is-correct"), "CONTROL: the unsealed twin is marked").toHaveCount(1);
  await expect(card.locator("[data-answer-withheld]"), "…and carries no withheld panel").toHaveCount(0);
});

test("mid-event: an ORDINARY participant who solved a sealed multiple-choice challenge is told why its options are unmarked — and the competing reader gets their own sentence on the same card", async ({ browser }) => {
  const W = await choiceWorld("f3uimo");
  const solver = await makeParticipant(sa, saCsrf, "f3uimosolver");
  await enrol(sa, saCsrf, W.comp.id, [solver.id]);
  const ctx = await browser.newContext({ baseURL: BASE });
  try {
    const page = await ctx.newPage();
    await loginViaApi(page, solver.email, PARTICIPANT_PASS);
    const pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    expect((await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: W.comp.id } })).ok()).toBeTruthy();
    // Only the SEALED one: the open twin stays unsolved (and the stander never
    // solves), so the all-solved auto-end cannot end the event under the test.
    await solveChoice(page, pc, W, W.sealedId);
    await page.goto("/");
    await page.waitForSelector("#nav-challenges:not([aria-disabled=true])", { state: "visible", timeout: 20_000 });
    const card = page.locator("#task-detail-card");
    await openCard(page, W.sealedId);
    await expect(card, "PRECONDITION: the solved card").toContainText("You have solved this challenge.");
    await expect(card.locator(".choice-review-row.is-correct")).toHaveCount(0);
    const panel = card.locator("[data-answer-withheld]");
    await expect(panel).toContainText("Answer not shown");
    await expect(panel, "the ordinary reason").toContainText("only a superadmin can reveal it");
    expect(await panelUnderOptions(page)).toBe(true);
    expect(await page.content(), "the author's hint is nowhere").not.toContain(`SEALHINT_${W.T}`);
    // The competing reader: the same card from a payload whose answer is withheld
    // because the reader competes names THAT reason.
    await page.route(u => new URL(u).pathname === `/api/tasks/${W.sealedId}`, async route => {
      const r = await route.fetch();
      const body = await r.json();
      await route.fulfill({ response: r, json: { ...body, answer_withheld_reason: "competing_elsewhere" } });
    });
    await openCard(page, W.sealedId);
    await expect(panel, "the competing reason").toContainText("you are competing in an event that also holds this challenge");
    await expect(panel).not.toContainText("only a superadmin can reveal it");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    // CONTROL: the unsealed twin, unsolved, is an ordinary answerable card.
    await openCard(page, W.openId);
    await expect(card.locator("[data-answer-withheld]")).toHaveCount(0);
  } finally { await ctx.close(); }
});
