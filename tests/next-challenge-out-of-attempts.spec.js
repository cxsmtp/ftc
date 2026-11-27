// @ts-check
//
// NEXT CHALLENGE PASSES OVER A CHALLENGE WITH NO ATTEMPTS LEFT (sweep #283).
// GET /api/tasks carries `out_of_attempts` (routes/participant.js, derived in
// lib/attempts.js `outOfAttemptsTaskIds`); the Correct panel's Next challenge
// (public/js/features/participant-tasks.js `_nextPlayable`) and the events
// page's progress strip (features/competition-picker.js `_renderProgressStrip`)
// read it. "Finished" is solved or out of attempts, as the board and the
// all-solved end count it.
//
//   1. The list's flag is true exactly where the challenge would open as "No
//      attempts left" — every row is checked against the challenge's own read
//      (unsolved, `attempts_left` 0). A spent cap is flagged; one attempt still
//      left, an uncapped challenge however many wrong answers, and a solved one
//      whose attempts are all used are not. A grant brings a spent one back and
//      spending the grant spends it again. Every row carries the boolean, and
//      none carries a cap or a count (asserted by value: the only number on a
//      row is its active flag).
//   2. The event's cap counts where a challenge has none; a challenge's own cap
//      beats it. A Quick question whose answer can be changed is never spent,
//      even with an older wrong answer on the record (its read carries no cap
//      keys, and the submit takes a pick: the control), while an older Quick
//      question of another type is (the submit refuses it: the control).
//   3. In the browser: Next challenge on a solved challenge's panel skips a spent
//      challenge, also when wrapping round from the last (an uncapped challenge
//      with a wrong answer is NOT skipped: the control), offers Back to
//      challenges once only spent ones are left, and offers a challenge again
//      once a grant brings it back. The progress strip puts the run at the first
//      challenge still to play, not at the first unsolved one, which is spent.
//   4. The events page's progress strip with NOTHING LEFT TO ANSWER (runStanding
//      in participant-tasks.js, stripWords in competition-picker.js): judged by
//      value first, then in the browser. "Finished" is solved or out of attempts
//      over the scoring challenges, as the server counts it; a quick question
//      still to answer keeps the run In progress with Continue. Once every
//      challenge not solved is spent the row says No attempts left (never All
//      solved, never a completion word: a Program's certificate needs every one
//      solved), shows the solved count with no current segment and offers View,
//      the same door into the event; spent segments are hollow on the strip and
//      the play bar alike, and the challenge list's cards say No attempts left
//      instead of "still open". A grant brings the run back to In progress.
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, BASE, TEST_DB_PATH } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

/**
 * A live event of its own with the given challenges, its participant and an
 * idle second participant (nothing auto-ends under the test: checklist item 1).
 * The challenges are numbered by title, so `specs`' keys in alphabetical order
 * are the participant's list order. `olderTags` are written as a row tagged
 * before the tag routes refused them (a Quick question that is not a pick-one
 * question: lib/qualifying.js).
 */
async function eventWith(label, specs, extra = {}) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const c = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `NCO ${uniq(label)}`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(),
      duration_minutes: 600, ...extra,
    } });
    expect(c.ok(), `create event: ${await c.text()}`).toBeTruthy();
    const comp = (await c.json()).competition;
    const ids = {};
    const tag = uniq(label);
    for (const [key, { olderTags = [], tags = [], ...spec }] of Object.entries(specs)) {
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `NCO ${tag} ${key}`, description: "<p>Read it.</p>", difficulty: "easy", status: "published", ...spec,
      } });
      expect(r.ok(), `create ${key}: ${await r.text()}`).toBeTruthy();
      ids[key] = (await r.json()).id;
      if (olderTags.length) {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        try { for (const t of olderTags) db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(ids[key], t); } finally { db.close(); }
      }
      const a = await sa.post(`/api/admin/tasks/${ids[key]}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      expect((await a.json()).assigned, `assign ${key}`).toBe(1);
      for (const t of tags) {
        const tg = await sa.post(`/api/admin/tasks/${ids[key]}/tags`, { headers: H(csrf), data: { tag: t } });
        expect(tg.ok(), `tag ${key} ${t}: ${await tg.text()}`).toBeTruthy();
      }
    }
    const p = await makeParticipant(sa, csrf, label);
    const idle = await makeParticipant(sa, csrf, `${label}-idle`);
    await enrol(sa, csrf, comp.id, [p.id, idle.id]);
    return { comp, ids, p };
  } finally { await sa.dispose(); }
}

/** The participant's own API session, in the event. */
async function participant(f) {
  const P = await apiLogin(f.p.email);
  const sel = await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: f.comp.id } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return P;
}

/** One answer through the real submit, carrying the grading token. */
async function answer(P, taskId, ans) {
  const r = await P.api.post(`/api/tasks/${taskId}/submit`, { headers: H(P.csrf), data: { answer: ans, gradingHash: await gradingHashFor(P.api, taskId) } });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** An organiser's grant of `extra` attempts on one challenge. */
async function grant(f, taskId, extra) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const g = await sa.post(`/api/admin/tasks/${taskId}/attempt-grant`, { headers: H(csrf), data: { userId: f.p.id, competitionId: f.comp.id, extra } });
    expect(g.ok(), `grant: ${g.status()} ${await g.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
}

const view = async (P, id) => {
  const r = await P.api.get(`/api/tasks/${id}`);
  expect(r.ok(), `read ${id}: ${await r.text()}`).toBeTruthy();
  return r.json();
};

/**
 * The list, each row's flag checked against the challenge's OWN read: it opens
 * as "No attempts left" exactly when it is unsolved with `attempts_left` 0. A
 * map of id → flag.
 */
async function flagsAgainstReads(P) {
  const r = await P.api.get("/api/tasks");
  expect(r.ok(), `list: ${await r.text()}`).toBeTruthy();
  const rows = await r.json();
  expect(rows.length, "PRECONDITION: the list has challenges").toBeGreaterThan(0);
  const out = {};
  for (const t of rows) {
    const v = await view(P, t.id);
    expect(t.out_of_attempts, `the list agrees with ${t.title}'s own read (solved ${v.solved}, ${v.attempts_left} left)`)
      .toBe(!v.solved && v.attempts_left === 0);
    out[t.id] = t.out_of_attempts;
  }
  return { rows, out };
}

/** Every row carries the boolean, and no cap and no count: the only number on a row is its active flag. */
function expectNoCapOnTheList(rows) {
  for (const t of rows) {
    expect(typeof t.out_of_attempts, `${t.title}: out_of_attempts on every row`).toBe("boolean");
    const named = Object.keys(t).filter((k) => k !== "out_of_attempts" && /attempt|(^|_)cap(_|$)|grant|(^|_)left(_|$)|(^|_)used(_|$)|spent|extra/i.test(k));
    expect(named, `${t.title}: no cap or count by name`).toEqual([]);
    const numbers = Object.entries(t).filter(([, v]) => typeof v === "number").map(([k]) => k);
    expect(numbers, `${t.title}: the only number on a row is its active flag`).toEqual(["active"]);
  }
}

test("the list's out_of_attempts is set exactly where a challenge would open as No attempts left; a grant clears it; no cap or count on the list", async () => {
  test.setTimeout(120_000);
  // An event with no cap of its own: each cap here is the challenge's.
  const f = await eventWith("list", {
    spent: { answer_type: "text", correct_answer: "right", attempt_cap: 2 },
    open: { answer_type: "text", correct_answer: "right", attempt_cap: 3 },
    free: { answer_type: "text", correct_answer: "right" },
    done: { answer_type: "text", correct_answer: "right", attempt_cap: 2 },
    fresh: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
  });
  const P = await participant(f);
  try {
    let { rows, out } = await flagsAgainstReads(P);
    expectNoCapOnTheList(rows);
    expect(Object.values(out).filter(Boolean), "nothing is spent before an answer").toEqual([]);

    for (const a of ["w1", "w2"]) expect((await answer(P, f.ids.spent, a)).body.correct).toBe(false);
    expect((await answer(P, f.ids.open, "w1")).body.correct).toBe(false);
    for (const a of ["w1", "w2", "w3"]) expect((await answer(P, f.ids.free, a)).body.correct).toBe(false);
    expect((await answer(P, f.ids.done, "w1")).body.correct).toBe(false);
    expect((await answer(P, f.ids.done, "right")).body.correct).toBe(true);
    // PRECONDITIONS: the spent one is refused; the solved one used its last attempt.
    expect((await answer(P, f.ids.spent, "w3")).body.refused, "PRECONDITION: no attempts left").toBe("attempts_exhausted");
    expect((await view(P, f.ids.done)).attempts_left, "PRECONDITION: the solved one has no attempts left either").toBe(0);

    ({ rows, out } = await flagsAgainstReads(P));
    expectNoCapOnTheList(rows);
    expect(out, "only the spent one: not one with an attempt left, an uncapped one with three wrong answers, a solved one or an untouched one").toEqual({
      [f.ids.spent]: true, [f.ids.open]: false, [f.ids.free]: false, [f.ids.done]: false, [f.ids.fresh]: false,
    });

    // A grant brings it back…
    await grant(f, f.ids.spent, 1);
    ({ rows, out } = await flagsAgainstReads(P));
    expect(out[f.ids.spent], "a grant gives it an attempt back").toBe(false);
    // …and spending the granted attempt spends it again.
    expect((await answer(P, f.ids.spent, "w4")).body.correct).toBe(false);
    ({ rows, out } = await flagsAgainstReads(P));
    expect(out[f.ids.spent], "the granted attempt is spent too").toBe(true);
    expectNoCapOnTheList(rows);
  } finally { await P.api.dispose(); }
});

test("the event's cap counts where a challenge has none, a challenge's own cap beats it, and a Quick question whose answer can be changed is never spent", async () => {
  test.setTimeout(120_000);
  // A Booth Event (it seeds four Quick questions, each a pick-one question)
  // with a cap of one attempt on every challenge.
  const f = await eventWith("quick", {
    conv: { answer_type: "text", correct_answer: "right" },
    fallback: { answer_type: "text", correct_answer: "right" },
    older: { answer_type: "text", correct_answer: "right", olderTags: ["qualifying:older"] },
    own: { answer_type: "text", correct_answer: "right", attempt_cap: 3 },
  }, { event_kind: "booth", attempt_cap: 1 });
  const P = await participant(f);
  try {
    for (const k of ["conv", "fallback", "older", "own"]) expect((await answer(P, f.ids[k], "w1")).body.correct, k).toBe(false);
    // `conv` becomes a Quick question whose answer can be changed — a pick-one
    // question, tagged qualifying — through the organiser's own doors, keeping
    // the wrong answer it already had (the re-price moves points, never the grade).
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const put = await sa.put(`/api/admin/tasks/${f.ids.conv}`, { headers: H(csrf), data: { answer_type: "any", choices: [{ text: "Yes" }, { text: "No" }] } });
      expect(put.ok(), `make it a pick-one question: ${await put.text()}`).toBeTruthy();
      const tg = await sa.post(`/api/admin/tasks/${f.ids.conv}/tags`, { headers: H(csrf), data: { tag: "qualifying:conv" } });
      expect(tg.ok(), `make it a Quick question: ${await tg.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
    {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT is_correct FROM submissions WHERE user_id=? AND task_id=?").all(f.p.id, f.ids.conv).map((r) => r.is_correct),
          "PRECONDITION: its one answer is a wrong one, which the event's cap would call spent").toEqual([0]);
      } finally { db.close(); }
    }

    const { rows, out } = await flagsAgainstReads(P);
    expectNoCapOnTheList(rows);
    const seeded = rows.filter((t) => t.qualifying && t.id !== f.ids.older && t.id !== f.ids.conv);
    expect(seeded.length, "PRECONDITION: the booth's own four Quick questions").toBe(4);
    expect(out[f.ids.fallback], "no cap of its own: the event's one attempt, spent").toBe(true);
    expect(out[f.ids.own], "its own cap of three beats the event's").toBe(false);
    expect(out[f.ids.older], "an older Quick question that is not a pick spends attempts").toBe(true);
    expect(out[f.ids.conv], "a Quick question whose answer can be changed is never spent").toBe(false);
    for (const q of seeded) expect(out[q.id], `${q.title}: unanswered`).toBe(false);
    // Its own read carries no cap keys, as for an uncapped challenge (the
    // control: the event's cap on the challenge beside it).
    const convView = await view(P, f.ids.conv);
    expect(convView.pick_one, "PRECONDITION: a pick-one question").toBe(true);
    expect(convView.qualifying, "PRECONDITION: a Quick question").toBe(true);
    expect(convView).not.toHaveProperty("attempts_left");
    expect(convView).not.toHaveProperty("attempts_cap");
    expect((await view(P, f.ids.fallback)).attempts_left, "CONTROL: a scoring challenge under the same cap").toBe(0);

    // The submit agrees: it takes a pick on the changeable one and refuses the older one.
    const taken = await answer(P, f.ids.conv, JSON.stringify([convView.choices[0].id]));
    expect([taken.status, taken.body.correct, taken.body.refused], `the pick is taken: ${JSON.stringify(taken.body)}`).toEqual([200, true, undefined]);
    expect((await answer(P, f.ids.older, "w2")).body.refused, "CONTROL: the older Quick question is spent").toBe("attempts_exhausted");
  } finally { await P.api.dispose(); }
});

async function open(page, taskId) {
  await page.evaluate((id) => window.openTask(id), taskId);
  await expect(page.locator("#task-detail-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.evaluate((id) => window.S._openedTaskId === id && !!document.querySelector("#task-detail-card .qa-title"), taskId)).toBe(true);
}

/** Answer through the BROWSER's own session: a second sign-in would end it (one session per principal). */
async function solveInPage(page, taskId) {
  const csrf = await page.evaluate(() => window.S.csrfToken);
  const r = await page.request.post(`/api/tasks/${taskId}/submit`, { headers: H(csrf), data: { answer: "right", gradingHash: await gradingHashFor(page.request, taskId) } });
  expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  expect((await r.json()).correct, "precondition: accepted").toBe(true);
}

test("Next challenge passes over a challenge with no attempts left, wrapping round; Back to challenges once only spent ones are left; a grant brings one back; the progress strip skips it too", async ({ page }) => {
  test.setTimeout(150_000);
  // Five challenges a…e in the participant's order. a and c allow one attempt
  // and are spent; b and e are solved; d has no cap and one wrong answer, so it
  // is not spent (the control: a wrong answer alone is no reason to skip).
  const f = await eventWith("next", {
    a: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
    b: { answer_type: "text", correct_answer: "right" },
    c: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
    d: { answer_type: "text", correct_answer: "right" },
    e: { answer_type: "text", correct_answer: "right" },
  });
  // Answered in the participant's own API session, which the browser's sign-in
  // then ends (one session per principal); it also puts them in the event.
  const P = await participant(f);
  try {
    expect((await answer(P, f.ids.a, "w")).body.attempts_left).toBe(0);
    expect((await answer(P, f.ids.b, "right")).body.correct).toBe(true);
    expect((await answer(P, f.ids.c, "w")).body.attempts_left).toBe(0);
    expect((await answer(P, f.ids.d, "w")).body.correct).toBe(false);
    expect((await answer(P, f.ids.e, "right")).body.correct).toBe(true);
  } finally { await P.api.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect(page.locator("#task-grid .task-card").first(), "PRECONDITION: in the event").toBeVisible({ timeout: 20000 });
  const { a, b, c, d, e } = f.ids;
  const state = () => page.evaluate(() => window.S.allTasks.map((t) => [t.id, !!t.solved, t.out_of_attempts]));
  await expect.poll(state, { message: "PRECONDITION: a and c spent, b and e solved, d still open" }).toEqual([
    [a, false, true], [b, true, false], [c, false, true], [d, false, false], [e, true, false],
  ]);
  const next = page.locator("#task-detail-card .qa-next");

  // From b: the next one after it, c, is spent, so the way on is d.
  await open(page, b);
  await expect(next).toHaveText(/Next challenge/);
  expect(await next.getAttribute("data-next-task-id"), "c, spent, is passed over").toBe(d);
  // From e, the last: wrapping round, a is spent and passed over too.
  await open(page, e);
  await expect(next).toHaveText(/Next challenge/);
  expect(await next.getAttribute("data-next-task-id"), "wrapping round, a is passed over").toBe(d);
  await next.click();
  await expect.poll(() => page.evaluate(() => window.S._openedTaskId), { message: "Next challenge opens d" }).toBe(d);

  // d solved: only spent ones are left, so the way on is the list.
  await solveInPage(page, d);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state, { message: "PRECONDITION: d solved" }).toEqual([
    [a, false, true], [b, true, false], [c, false, true], [d, true, false], [e, true, false],
  ]);
  await open(page, b);
  await expect(next).toHaveText(/Back to challenges/);
  await expect(next).toHaveAttribute("data-action", "show-main");

  // An organiser's grant brings c back.
  await grant(f, c, 1);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state, { message: "PRECONDITION: c has an attempt again" }).toEqual([
    [a, false, true], [b, true, false], [c, false, false], [d, true, false], [e, true, false],
  ]);
  await open(page, b);
  await expect(next).toHaveText(/Next challenge/);
  expect(await next.getAttribute("data-next-task-id"), "the granted challenge is offered again").toBe(c);

  // The events page's progress strip: the run is at c, the first challenge
  // still to play, not at a, the first unsolved one, which is spent.
  await page.locator("#qa-playbar .qa-close").click();
  await page.locator("#nav-competitions").click();
  const row = page.locator(`#ev-progress .ev-prog[data-comp-id="${f.comp.id}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("In progress");
  await expect(row.locator(".qa-prog-n"), "the run is at the third of five").toHaveText(/^3\s*\/\s*5/);
});

// ── 4. the progress strip with nothing left to answer ───────────────────────

test("runStanding and stripWords judge a run as the server does (finished = solved or out of attempts, quick questions left out), and playStatsHtml draws it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-booted", "1", { timeout: 20000 });
  const judged = await page.evaluate(() => {
    const rec = {
      playing: { done: [1, 0, 0], out: [0, 1, 0] },
      spent: { done: [1, 0, 0], out: [0, 1, 1] },
      noneSolved: { done: [0, 0], out: [1, 1] },
      solved: { done: [1, 1], out: [0, 0] },
      spentQuickPending: { done: [1, 0, 0], out: [0, 1, 0], quick: [0, 0, 1] },
      spentQuickAnswered: { done: [1, 0, 1], out: [0, 1, 0], quick: [0, 0, 1] },
      solvedQuickPending: { done: [1, 1, 0], out: [0, 0, 0], quick: [0, 0, 1] },
      quickOnly: { done: [0], quick: [1] },
      quickOnlyAnswered: { done: [1, 1], out: [0, 0], quick: [1, 1] },
      stale: { done: [1, 0, 0] },
    };
    const o = {};
    for (const [k, p] of Object.entries(rec)) { const st = window.runStanding(p); o[k] = { st, w: window.stripWords(st) }; }
    return o;
  });
  const W = (eyebrow, button) => ({ eyebrow, button });
  expect(judged).toEqual({
    // CONTROL: one challenge still to play.
    playing: { st: { idx: 2, solved: 1, total: 3, state: "playing" }, w: W("In progress", "Continue") },
    spent: { st: { idx: -1, solved: 1, total: 3, state: "spent" }, w: W("No attempts left", "View") },
    noneSolved: { st: { idx: -1, solved: 0, total: 2, state: "spent" }, w: W("No attempts left", "View") },
    solved: { st: { idx: -1, solved: 2, total: 2, state: "solved" }, w: W("All solved", "View") },
    // Every scoring challenge spent, a quick question still to answer: finished
    // as the server counts it, but something is left, so In progress and Continue.
    spentQuickPending: { st: { idx: 2, solved: 1, total: 2, state: "spent" }, w: W("In progress", "Continue") },
    spentQuickAnswered: { st: { idx: -1, solved: 1, total: 2, state: "spent" }, w: W("No attempts left", "View") },
    solvedQuickPending: { st: { idx: 2, solved: 2, total: 2, state: "solved" }, w: W("All solved", "Continue") },
    quickOnly: { st: { idx: 0, solved: 0, total: 0, state: "playing" }, w: W("In progress", "Continue") },
    // Quick questions only, every one answered: nothing to solve, all answered.
    quickOnlyAnswered: { st: { idx: -1, solved: 0, total: 0, state: "answered" }, w: W("All answered", "View") },
    // A record written before `out` was reads as not out: it claims nothing new.
    stale: { st: { idx: 1, solved: 1, total: 3, state: "playing" }, w: W("In progress", "Continue") },
  });

  const drawn = await page.evaluate(() => {
    const read = (m) => {
      const html = window.playStatsHtml(m);
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
      const prog = doc.querySelector(".qa-prog");
      return {
        html,
        hidden: prog.hasAttribute("hidden"),
        eyebrow: prog.querySelector(".eyebrow")?.textContent ?? null,
        n: prog.querySelector(".qa-prog-n")?.textContent ?? null,
        segs: [...prog.querySelectorAll(".qa-track i")].map((i) => i.className),
      };
    };
    return {
      over: read({ over: true, done: [1, 0, 0], quick: [0, 0, 0], out: [0, 1, 1], idx: -1 }),
      overQuick: read({ over: true, done: [1, 0, 1], quick: [0, 0, 1], out: [0, 1, 0], idx: -1 }),
      overIdxIgnored: read({ over: true, done: [1, 0, 0], out: [0, 1, 1], idx: 2 }),
      overOne: read({ over: true, done: [0], out: [1], idx: -1 }),
      overQuickOnly: read({ over: true, done: [1, 1], quick: [1, 1], out: [0, 0], idx: -1 }),
      notOverOut: read({ done: [0, 0, 0], out: [1, 0, 1], idx: 1 }),
      ctlNoOut: read({ done: [1, 0, 0], idx: 2 }),
      ctlFalseOut: read({ done: [1, 0, 0], out: [0, 0, 0], idx: 2 }),
      oneNotOver: read({ done: [0], out: [1], idx: 0 }),
    };
  });
  expect(drawn.over, "nothing left: no current segment, the spent ones hollow, the solved count").toMatchObject({
    hidden: false, eyebrow: "Challenges", n: "1 / 3 solved", segs: ["done", "out", "out"] });
  expect(drawn.over.html, "no segment is current").not.toContain('class="now"');
  expect(drawn.overQuick, "the count leaves a quick question out").toMatchObject({ n: "1 / 2 solved", segs: ["done", "out", "done"] });
  expect(drawn.overIdxIgnored.segs, "over wins over a stray idx").toEqual(["done", "out", "out"]);
  expect(drawn.overOne, "a one-challenge run still says how it ended").toMatchObject({ hidden: false, n: "0 / 1 solved", segs: ["out"] });
  expect(drawn.overQuickOnly, "quick questions only: the answers counted, never '0 / 0 solved'").toMatchObject({
    hidden: false, eyebrow: "Questions", n: "2 / 2 answered", segs: ["done", "done"] });
  expect(drawn.notOverOut, "the play bar's case: the open challenge stays current, spent ones hollow").toMatchObject({
    eyebrow: "Challenge", n: "2 / 3, 0 solved", segs: ["out", "now", "out"] });
  // CONTROL: today's output, byte for byte, when `out` is absent or all false.
  const today = '<div class="qa-prog"><div class="qa-prog-top"><span class="eyebrow">Challenge</span><b class="qa-prog-n">3<span class="qa-prog-of"> / 3</span><span class="sr-only">, 1 solved</span></b></div><div class="qa-track" aria-hidden="true" style="--cols:3"><i class="done"></i><i class=""></i><i class="now"></i></div></div>';
  expect(drawn.ctlNoOut.html.startsWith(today), `unchanged without out: ${drawn.ctlNoOut.html}`).toBe(true);
  expect(drawn.ctlFalseOut.html, "all-false out draws what no out draws").toBe(drawn.ctlNoOut.html);
  expect(drawn.oneNotOver.hidden, "CONTROL: one challenge, not over: no position to show, as before").toBe(true);
});

/** One answer through the BROWSER's own session; returns the submit's body. */
async function answerInPage(page, taskId, ans) {
  const csrf = await page.evaluate(() => window.S.csrfToken);
  const r = await page.request.post(`/api/tasks/${taskId}/submit`, { headers: H(csrf), data: { answer: ans, gradingHash: await gradingHashFor(page.request, taskId) } });
  expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  return r.json();
}

const segClasses = (loc) => loc.locator(".qa-track i").evaluateAll((els) => els.map((e) => e.className));

/** To the events page, and the event's row on the strip. */
async function stripRow(page, f) {
  if (await page.locator("#task-detail-page.active").count()) await page.locator("#qa-playbar .qa-close").click();
  await page.locator("#nav-competitions").click();
  await expect(page.locator("#competitions-page")).toHaveClass(/active/);
  const row = page.locator(`#ev-progress .ev-prog[data-comp-id="${f.comp.id}"]`);
  await expect(row, "the run is on the strip").toBeVisible({ timeout: 10000 });
  return row;
}

/** Press the row's button, landing in the event's challenge list. */
async function pressRow(page, f, row, name) {
  await row.getByRole("button", { name: `${name} — ${f.comp.name}`, exact: true }).click();
  await expect(page.locator("#tasks-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId)).toBe(f.comp.id);
  await expect(page.locator("#modal-overlay.open"), "same event: nothing to confirm").toHaveCount(0);
}

test("the progress strip says No attempts left once nothing is left to answer, offers View and draws spent segments hollow; a quick question still to answer keeps it In progress; a grant brings it back; the list's cards agree", async ({ page }) => {
  test.setTimeout(180_000);
  // a, b and c allow one attempt each; q is a Quick question (a pick-one
  // question, so never out of attempts), numbered last. An idle participant keeps
  // the event live (checklist item 1).
  const f = await eventWith("strip", {
    a: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
    b: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
    c: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
    q: { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }], tags: ["qualifying:strip"] },
  });
  const P = await participant(f);
  try {
    expect((await answer(P, f.ids.a, "w")).body.attempts_left).toBe(0);
    expect((await answer(P, f.ids.b, "right")).body.correct).toBe(true);
  } finally { await P.api.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect(page.locator("#task-grid .task-card").first(), "PRECONDITION: in the event").toBeVisible({ timeout: 20000 });
  const { a, b, c, q } = f.ids;
  const state = () => page.evaluate(() => window.S.allTasks.map((t) => [t.id, !!t.solved, t.out_of_attempts]));
  await expect.poll(state, { message: "PRECONDITION: a spent, b solved, c and q open, q last" }).toEqual([
    [a, false, true], [b, true, false], [c, false, false], [q, false, false]]);

  // 1. CONTROL: c still to play.
  let row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("In progress");
  await expect(row.getByRole("button", { name: `Continue — ${f.comp.name}`, exact: true })).toBeVisible();
  expect(await segClasses(row), "at c, a hollow").toEqual(["out", "done", "now", ""]);

  // 2. c spent too: every scoring challenge is solved or out, the quick question is left.
  await pressRow(page, f, row, "Continue");
  expect((await answerInPage(page, c, "w")).attempts_left).toBe(0);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state, { message: "PRECONDITION: a and c spent, b solved, q open" }).toEqual([
    [a, false, true], [b, true, false], [c, false, true], [q, false, false]]);
  await open(page, b);
  expect(await segClasses(page.locator("#qa-stats")), "the play bar: b current, a and c hollow").toEqual(["out", "now", "out", ""]);
  row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow"), "a quick question is still to answer").toHaveText("In progress");
  await expect(row.getByRole("button", { name: `Continue — ${f.comp.name}`, exact: true })).toBeVisible();
  expect(await segClasses(row), "at q").toEqual(["out", "done", "out", "now"]);

  // 3. q answered: nothing is left.
  await pressRow(page, f, row, "Continue");
  const qv = await (await page.request.get(`/api/tasks/${q}`)).json();
  expect((await answerInPage(page, q, JSON.stringify([qv.choices[0].id]))).correct, "the pick is taken").toBe(true);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state, { message: "PRECONDITION: q answered" }).toEqual([
    [a, false, true], [b, true, false], [c, false, true], [q, true, false]]);
  row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("No attempts left");
  await expect(row.locator(".qa-prog .eyebrow")).toHaveText("Challenges");
  await expect(row.locator(".qa-prog-n"), "how many are solved, quick question left out").toHaveText(/^1\s*\/\s*3 solved$/);
  expect(await segClasses(row), "no current segment, a and c hollow").toEqual(["out", "done", "out", "done"]);
  // Hollow as drawn: an edge and no fill, never a faded segment.
  const hollow = await row.locator(".qa-track i.out").first().evaluate((el) => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, ring: cs.boxShadow, opacity: cs.opacity }; });
  expect(hollow.bg, "no fill").toBe("rgba(0, 0, 0, 0)");
  expect(hollow.ring, "an inset edge").toMatch(/inset/);
  expect(hollow.opacity).toBe("1");
  const go = row.locator(".ev-prog-go");
  await expect(go).toHaveText("View");
  await expect(go).toHaveAccessibleName(`View — ${f.comp.name}`);
  await expect(row.getByRole("button", { name: /Continue/ })).toHaveCount(0);

  // View is the same door: it enters the event, whose list says the same.
  await pressRow(page, f, row, "View");
  await page.locator('#solve-filters [data-filter="all"]').click();
  const card = (id) => page.locator(`#task-grid .task-card[data-task-id="${id}"]`);
  await expect(card(b), "PRECONDITION: every card shown").toBeVisible();
  for (const id of [a, c]) {
    await expect(card(id)).toHaveClass(/\bspent\b/);
    await expect(card(id).locator(".tc-spent")).toHaveText("No attempts left");
    expect(await card(id).evaluate((el) => getComputedStyle(el).borderLeftStyle), "a dashed edge").toBe("dashed");
    const name = await card(id).locator(".card-open").getAttribute("aria-label");
    expect(name, "named spent, not still open").toContain("no attempts left");
    expect(name).not.toContain("still open");
  }
  await expect(card(b), "CONTROL: a solved card").not.toHaveClass(/\bspent\b/);
  await expect(card(b).locator(".tc-spent")).toHaveCount(0);
  expect(await card(b).evaluate((el) => getComputedStyle(el).borderLeftStyle), "CONTROL: a solid edge").toBe("solid");
  expect(await card(b).locator(".card-open").getAttribute("aria-label")).not.toContain("no attempts left");

  // 4. An organiser's grant on c: In progress again, and c's card is open again.
  await grant(f, c, 1);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state, { message: "PRECONDITION: c has an attempt again" }).toEqual([
    [a, false, true], [b, true, false], [c, false, false], [q, true, false]]);
  await page.locator('#solve-filters [data-filter="all"]').click();
  await expect(card(c), "CONTROL: an open card").not.toHaveClass(/\bspent\b/);
  await expect(card(c).locator(".tc-spent")).toHaveCount(0);
  expect(await card(c).locator(".card-open").getAttribute("aria-label")).toContain("unsolved, still open");
  row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("In progress");
  await expect(row.getByRole("button", { name: `Continue — ${f.comp.name}`, exact: true })).toBeVisible();
  expect(await segClasses(row)).toEqual(["out", "done", "now", "done"]);

  // 5. Everything solved: All solved, the full count, View.
  await pressRow(page, f, row, "Continue");
  expect((await answerInPage(page, c, "right")).correct).toBe(true);
  await grant(f, a, 1);
  expect((await answerInPage(page, a, "right")).correct).toBe(true);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state, { message: "PRECONDITION: all solved" }).toEqual([
    [a, true, false], [b, true, false], [c, true, false], [q, true, false]]);
  row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("All solved");
  await expect(row.locator(".qa-prog-n")).toHaveText(/^3\s*\/\s*3 solved$/);
  expect(await segClasses(row)).toEqual(["done", "done", "done", "done"]);
  await expect(row.locator(".ev-prog-go")).toHaveAccessibleName(`View — ${f.comp.name}`);
});

test("a Program whose challenges are all out of attempts says No attempts left with nothing solved, never All solved, and still shows no ring or score", async ({ page }) => {
  test.setTimeout(150_000);
  const f = await eventWith("prog", {
    x: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
    y: { answer_type: "text", correct_answer: "right", attempt_cap: 1 },
  }, { event_kind: "program", duration_minutes: undefined, deadline_at: new Date(Date.now() + 3 * 3600e3).toISOString() });
  const P = await participant(f);
  try {
    expect((await answer(P, f.ids.x, "w")).body.attempts_left).toBe(0);
  } finally { await P.api.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect(page.locator("#task-grid .task-card").first(), "PRECONDITION: in the event").toBeVisible({ timeout: 20000 });
  const { x, y } = f.ids;
  const state = () => page.evaluate(() => window.S.allTasks.map((t) => [t.id, !!t.solved, t.out_of_attempts]));
  await expect.poll(state).toEqual([[x, false, true], [y, false, false]]);

  // CONTROL: y still to play.
  let row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("In progress");
  await expect(row.getByRole("button", { name: `Continue — ${f.comp.name}`, exact: true })).toBeVisible();
  expect(await segClasses(row)).toEqual(["out", "now"]);

  await pressRow(page, f, row, "Continue");
  expect((await answerInPage(page, y, "w")).attempts_left).toBe(0);
  await page.evaluate(() => window.loadTasks());
  await expect.poll(state).toEqual([[x, false, true], [y, false, true]]);
  row = await stripRow(page, f);
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("No attempts left");
  await expect(row.locator(".qa-prog-n")).toHaveText(/^0\s*\/\s*2 solved$/);
  expect(await segClasses(row)).toEqual(["out", "out"]);
  await expect(row.locator(".ev-prog-go")).toHaveText("View");
  await expect(row.locator(".qa-gauge"), "a Program draws no ring").toHaveCount(0);
  await expect(row.locator(".qa-score"), "nor a score").toBeHidden();
  expect(await row.innerText(), "no word claims completion").not.toMatch(/All solved|In progress|Finished/);
});
