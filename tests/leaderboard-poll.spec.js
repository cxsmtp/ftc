// @ts-check
//
// THE BOARD POLL, DRIVEN THROUGH THE POLL (public/js/features/leaderboard.js
// `_lbPollTick` / `_lbPollDue` / `loadLeaderboard`, fed by the pulse's
// `lb_version`, participant-tasks.js `_pulseTick`).
//
// The decisions are unit-driven in tests/participant-pulse-ui.spec.js; these hold
// the WIRING, on the open board page, each with a control:
//
//   1. A solve by somebody else moves the version only through the pulse: the
//      poll fetches nothing before the pulse carries it (control) and fetches
//      once after; the load stamps the version, so the next tick fetches nothing;
//      and the real 15 s interval runs the same tick by itself.
//   2. A FAILED load does not count as loaded: the next tick re-fetches (control:
//      after a successful load it does not).
//   3. An end on the clock bumps no version, yet the open board turns final at
//      the first tick after the participant's window ends — not at the
//      one-minute floor (preconditions: the version did not move and the floor
//      is not due; control: before the end the same tick fetches nothing).
//   4. On an event run in sessions, the participant's OWN session can end while
//      later ones run: the board is re-read once at that end, and once more when
//      the waiting poll learns the whole event is over — again not at the floor
//      (control: loaded at a stage, the next tick fetches nothing).
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/** A live event of its own with a viewer and a solver, two challenges (nothing auto-ends: checklist 1). */
async function liveEvent(label, extra = {}) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const viewer = await makeParticipant(sa, csrf, `${label}-v`);
    const solver = await makeParticipant(sa, csrf, `${label}-s`);
    const comp = await makeCompetition(sa, csrf, label, extra);
    const t1 = await makeTask(sa, csrf, `${label}-1`);
    const t2 = await makeTask(sa, csrf, `${label}-2`);
    for (const t of [t1, t2]) await assignTask(sa, csrf, t.id, [comp.id]);
    await enrol(sa, csrf, comp.id, [viewer.id, solver.id]);
    for (const p of [viewer, solver]) {
      const P = await apiLogin(p.email);
      try {
        const sel = await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: comp.id } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      } finally { await P.api.dispose(); }
    }
    return { comp, viewer, solver, t1, t2 };
  } finally { await sa.dispose(); }
}

async function solve(who, taskId) {
  const P = await apiLogin(who.email);
  try {
    const r = await P.api.post(`/api/tasks/${taskId}/submit`, { headers: H(P.csrf), data: { answer: "a", gradingHash: await gradingHashFor(P.api, taskId) } });
    expect(r.ok(), `solve: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).correct, "precondition: graded correct").toBe(true);
  } finally { await P.api.dispose(); }
}

async function openBoard(page, email) {
  await loginViaApi(page, email);
  await page.goto("/");
  const nav = page.locator("#nav-leaderboard:not([aria-disabled=true])");
  await expect(nav, "PRECONDITION: the participant is in the event").toBeVisible({ timeout: 20000 });
  await nav.click();
  await expect(page.locator("#leaderboard-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect(page.locator("#lb-page-title")).toHaveText("Live Rankings", { timeout: 10000 });
}

function boardReads(page) {
  const seen = [];
  page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/leaderboard") seen.push(Date.now()); });
  return seen;
}

/**
 * Take the pulse and the board interval off their timers, so every step below is
 * driven by hand: a natural pulse landing between a solve and the next assertion
 * would carry the version early. A stopped pulse's manual ticks reschedule
 * nothing (its handle is null).
 */
async function handDriven(page) {
  await page.evaluate(() => {
    const S = window.S;
    clearTimeout(S.statusPollInterval); S.statusPollInterval = null;
    clearInterval(S.lbInterval); S.lbInterval = null;
  });
}

test("a moved version reaches the board through the pulse and the poll, once; the interval runs the same tick", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await liveEvent("lbv");
  await openBoard(page, f.viewer.email);
  await handDriven(page);
  // A known baseline: the pulse has answered and the board was loaded against it.
  await page.evaluate(async () => { await window._pulseTick(); await window.loadLeaderboard({ silent: true }); });
  const reads = boardReads(page);
  const tick = () => page.evaluate(() => window._lbPollTick());

  await tick();
  expect(reads.length, "CONTROL: an unchanged version fetches nothing").toBe(0);

  await solve(f.solver, f.t1.id);
  await tick();
  expect(reads.length, "the poll does not see a solve the pulse has not carried").toBe(0);

  const before = await page.evaluate(() => window.S._lbVersionLatest);
  await page.evaluate(() => window._pulseTick());
  const after = await page.evaluate(() => window.S._lbVersionLatest);
  expect(after, "the pulse brought the new version").not.toBe(before);
  await tick();
  await expect.poll(() => reads.length, { message: "the moved version is fetched" }).toBe(1);
  await expect(page.locator(`#lb-body tr`, { hasText: f.solver.nickname }).locator(".lb-score")).toHaveText("50", { timeout: 10000 });
  await tick();
  expect(reads.length, "the load stamped the version: the next tick fetches nothing").toBe(1);

  // The interval itself: the poll restarted, another solve, one pulse, and no
  // hand on the tick.
  await page.evaluate(() => window.startLeaderboardPoll());
  await solve(f.solver, f.t2.id);
  await page.evaluate(() => window._pulseTick());
  await expect.poll(() => reads.length, { timeout: 17_000, message: "the 15 s interval ran the tick by itself" }).toBe(2);
});

test("a failed load is not counted as loaded: the next tick fetches again", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await liveEvent("lbf");
  await openBoard(page, f.viewer.email);
  await handDriven(page);
  await page.evaluate(async () => { await window._pulseTick(); await window.loadLeaderboard({ silent: true }); });
  const reads = boardReads(page);
  const tick = () => page.evaluate(() => window._lbPollTick());
  await tick();
  expect(reads.length, "CONTROL: after a successful load the tick fetches nothing").toBe(0);

  // Every attempt of one load answers 503 (fetchTransientRetry tries three times).
  await page.route("**/api/leaderboard", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"busy"}' }));
  await page.evaluate(() => window.loadLeaderboard({ silent: true }));
  const failed = reads.length;
  expect(failed, "precondition: the failing load was really sent").toBeGreaterThanOrEqual(1);
  await page.unroute("**/api/leaderboard");
  expect(await page.evaluate(() => window._lbPollDue(Date.now())), "a failed load leaves the board due").toBe(true);
  await tick();
  await expect.poll(() => reads.length, { message: "the next tick re-fetches" }).toBe(failed + 1);
  await expect(page.locator("#lb-body tr", { hasText: f.viewer.nickname })).toHaveCount(1);
  await tick();
  expect(reads.length, "and once it succeeded, the tick after fetches nothing").toBe(failed + 1);
});

test("an end on the clock turns the open board final at the next tick, not at the one-minute floor", async ({ page }) => {
  test.setTimeout(150_000);
  // Started 20 s ago for one minute: it ends on the clock about 40 s from now,
  // and nothing moves the board's version when it does.
  const f = await liveEvent("lbe", { start_time: new Date(Date.now() - 20_000).toISOString(), duration_minutes: 1 });
  const endsAt = Date.now() + 40_000;
  await openBoard(page, f.viewer.email);
  await handDriven(page);
  const version = await page.evaluate(async () => { await window._pulseTick(); await window.loadLeaderboard({ silent: true }); return window.S._lbVersionLatest; });
  const reads = boardReads(page);
  const tick = () => page.evaluate(() => window._lbPollTick());
  const title = page.locator("#lb-page-title");
  await tick();
  expect(reads.length, "CONTROL: while the event runs, an unchanged version fetches nothing").toBe(0);
  await expect(title).toHaveText("Live Rankings");

  // The clock runs out: the countdown's own 1 s tick ends the window and the notice opens.
  await expect(page.locator("#modal-overlay.open"), "the ended notice").toContainText("has ended", { timeout: Math.max(10_000, endsAt - Date.now() + 15_000) });
  await page.getByRole("button", { name: "Close" }).click();
  // Neither of the poll's other reasons can be what fetches next: a pulse after
  // the end brings the same version, and the board is well inside its one-minute floor.
  await page.evaluate(() => window._pulseTick());
  const state = await page.evaluate(() => ({ ended: window.S.hackathonEnded, v: window.S._lbVersionLatest, age: Date.now() - window.S._lbLoadedAt }));
  expect(state.ended, "precondition: the participant's window has ended").toBe(true);
  expect(state.v, "precondition: the end moved no board version").toBe(version);
  expect(state.age, "precondition: the one-minute floor is not due").toBeLessThan(55_000);
  await tick();
  await expect.poll(() => reads.length, { message: "the next tick fetches the board" }).toBe(1);
  await expect(title, "the open board turns final").toHaveText("Final standings", { timeout: 10_000 });
  await expect(page.locator("#lb-live-badge")).toBeHidden();
  await tick();
  expect(reads.length, "loaded after the end, the tick after fetches nothing").toBe(1);
});

test("a session that ends before the event: the open board is re-read at that end and again when the whole event is over", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await liveEvent("lbs");
  await openBoard(page, f.viewer.email);
  await handDriven(page);
  await page.evaluate(async () => { await window._pulseTick(); await window.loadLeaderboard({ silent: true }); });
  // Board reads counted IN THE PAGE as they are asked for: a tick that is due
  // calls the fetch before it returns, so the count after a tick is final.
  await page.evaluate(() => {
    const f0 = window.fetch;
    window.__boardReads = 0;
    window.fetch = function (u) {
      if (new URL(typeof u === "string" ? u : u.url, location.origin).pathname === "/api/leaderboard") window.__boardReads++;
      return f0.apply(this, arguments);
    };
  });
  const tickReads = () => page.evaluate(() => { window._lbPollTick(); return window.__boardReads; });
  expect(await tickReads(), "CONTROL: while the run goes on, an unchanged version fetches nothing").toBe(0);

  // The participant's OWN session ends while a later one still runs: the tab
  // holds two sessions (what handleCompetitionEnded reads), so the end takes the
  // waiting branch — the "Session Ended" notice and the poll for the event's end.
  await page.evaluate(() => {
    const S = window.S;
    clearInterval(S.timerInterval); S.timerInterval = null;
    S._currentTimeslots = [{ id: "own" }, { id: "later" }];
    S._competitionFullyEnded = false;
    window.handleCompetitionEnded();
  });
  await expect(page.locator("#modal-overlay.open"), "precondition: the waiting branch").toContainText("Your session has ended");
  await page.getByRole("button", { name: "Close" }).click();
  await page.evaluate(() => { clearInterval(window.S.statusPollInterval); window.S.statusPollInterval = null; });
  expect(await tickReads(), "the session's end re-reads the board once").toBe(1);
  expect(await tickReads(), "CONTROL: loaded after the session's end, the next tick fetches nothing").toBe(1);

  // The WHOLE event ends: the waiting poll learns it from /api/status (its
  // answer marked fully ended), and the board is due again — neither the version
  // nor the one-minute floor is what fetches it.
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.competition_fully_ended = true;
    await route.fulfill({ response: res, json: d });
  });
  await page.evaluate(() => window._pollWaitingForAllSlots());
  await page.unroute("**/api/status");
  const st = await page.evaluate(() => ({ full: window.S._competitionFullyEnded, same: window.S._lbVersionLatest === window.S._lbVersionLoaded, age: Date.now() - window.S._lbLoadedAt }));
  expect(st.full, "precondition: the tab knows the whole event is over").toBe(true);
  expect(st.same, "precondition: the board's version did not move").toBe(true);
  expect(st.age, "precondition: the one-minute floor is not due").toBeLessThan(55_000);
  expect(await tickReads(), "the event's end re-reads the board").toBe(2);
  expect(await tickReads(), "loaded after the event's end, the tick after fetches nothing").toBe(2);
});
