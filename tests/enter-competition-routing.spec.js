// v8.1.0 — PR 14: the routing verdict and the poller start, hoisted out of ten
// sites into ui/nav.js.
//
// THE LOCKS COME FIRST, AND THEY HAD TO. The plan's stated verification for this
// PR is "the full suite passes untouched" — and measured, that claim was worth
// nothing here: with the `ended` arm deleted from routeVerdict, so that a
// participant opening a FINISHED competition lands on the waiting screen instead
// of their challenges, all 2 123 tests still passed. Dropping startLeaderboardPoll
// from enterCompetitionView likewise passed. Eight of PR 7's nineteen sites had
// the same problem and the same answer (v7.29.0): write the lock, see it red, then
// hoist.
//
// What these pin is the DECISION, which is the part Phase 4 changes — a Program
// has no ranking (so the leaderboard poll must not start) and no waiting screen
// (so `pending` becomes a picker bounce). Getting the current answers written down
// is what makes that diff reviewable.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `rt${Date.now().toString(36)}`;

let ST = null;

async function setup() {
  if (ST) return ST;
  const { api, csrf: c0 } = await freshCtx();
  const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(lr.ok(), `superadmin login: ${lr.status()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;

  const mk = async (label, startOffsetMs, durationMinutes) => {
    const r = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `${TAG} ${label}`,
        start_time: new Date(Date.now() + startOffsetMs).toISOString(),
        duration_minutes: durationMinutes, timezone: "UTC",
      },
    });
    expect(r.ok(), `create ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).competition.id;
  };

  const live = await mk("Live", -60 * 60 * 1000, 600);
  const upcoming = await mk("Upcoming", 24 * 60 * 60 * 1000, 60);
  await api.dispose();
  ST = { live, upcoming };
  return ST;
}

// EVERY TEST OWNS ITS PARTICIPANT, and here that is not merely the standing rule
// — it is load-bearing. Entering a competition stamps users.active_competition_id,
// so a shared participant makes boot route the NEXT test straight into the
// previous test's competition and turns the picker click into a
// "Switch Event?" confirm. Sharing one produced exactly that: a pass, then
// three flakes. The three competitions above are read-only and stay shared.
let _n = 0;
async function makeEnrolledParticipant(comps) {
  const n = ++_n;
  const { api, csrf: c0 } = await freshCtx();
  const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(lr.ok(), `superadmin login: ${lr.status()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  try {
    const email = `${TAG}-${n}@company.example`;
    const reg = await registerPost(api, "/api/register", {
      headers: H(csrf),
      data: {
        firstName: "Route", lastName: `Fork${n}`, nickname: `${TAG}_p${n}`, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
      },
    });
    expect(reg.status(), `register ${n}: ${await reg.text()}`).toBe(200);
    const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, `participant ${n} is findable`).toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
    // The ENDED fixture is built PER TEST and in this order for a reason the
    // fixture checklist states outright: an already-ended competition refuses the
    // assign ("Cannot assign participants to ended event" — the wording since the
    // v8.7.5 rename; an event still taking late entries admits it since v8.12.6,
    // which this default-kind competition can never be). Create it live, enrol,
    // THEN end it — the state cannot be reached from outside any other way.
    const endedR = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `${TAG} Ended ${n}`,
        start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        duration_minutes: 600, timezone: "UTC",
      },
    });
    expect(endedR.ok(), `create ended ${n}: ${endedR.status()} ${await endedR.text()}`).toBeTruthy();
    const ended = (await endedR.json()).competition.id;

    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [...comps, ended] },
    });
    expect(asg.ok(), `assign ${n}: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    // The assign endpoint SILENTLY SKIPS ineligible users — assert the
    // precondition rather than meeting it later as an empty picker.
    expect((await asg.json()).assigned, `participant ${n} was enrolled`).toBeGreaterThan(0);

    const en = await api.post(`/api/admin/competitions/${ended}/end-now`, { headers: H(csrf) });
    expect(en.ok(), `end-now ${n}: ${en.status()} ${await en.text()}`).toBeTruthy();
    return { email, ended };
  } finally { await api.dispose(); }
}

// Sign in through the API on the page's own context, then navigate — never the
// other way round. A goto BEFORE the login starts an anonymous SPA whose polls
// 401 the instant the session regenerates, and its interceptor logs that session
// out (the v7.21.26 third door).
async function participantPage(page, email) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, H(csrfToken));
  expect(r.ok(), `participant login: ${r.status()} ${await r.text()}`).toBeTruthy();
  await page.goto("/");
}

// Open the picker showing EVERY competition — its default filter hides ended
// ones, which is exactly the fixture this file cares most about.
async function openPickerAll(page) {
  await page.evaluate(() => { window.showMain("competitions-page"); });
  await page.locator("#comp-grid").waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-action="set-comp-filter"][data-value="all"]').click();
  await expect.poll(async () => page.locator("#comp-grid .comp-card").count(),
    { timeout: 10000 }).toBeGreaterThan(0);
}

async function pick(page, compId) {
  await page.locator(`#comp-grid .comp-card[data-comp-id="${compId}"]`).click();
  // Entering a LIVE competition raises an "Enter Live Event" confirm before
  // the fork is reached ("you will be taken directly to this competition each time
  // you log in"). An ended or upcoming one does not — which is exactly why the
  // first draft of this file failed on live and passed on ended, and why the
  // confirm is accepted here rather than waited for unconditionally.
  //
  // SCOPED TO THE ENTRY CONFIRM BY TITLE, and that is not fussiness. Entering an
  // ENDED competition raises a DIFFERENT modal — "Event Ended", whose
  // confirm button is *View Leaderboard* — so a blunt "click any confirm" helper
  // sometimes navigated to leaderboard-page instead of tasks-page, depending on
  // whether the status poll had raised it yet. That produced a flake in exactly
  // the test that cares which page the verdict chose.
  const overlay = page.locator("#modal-overlay.open");
  // v8.3.26 — SETTLE INTO EITHER STATE, THEN DECIDE. `isVisible()` IGNORES its
  // `timeout` option, so the written 2000 was a no-op and this was the
  // point-in-time sample v8.3.22 fixed in all three `enterCompAndNav` copies —
  // this file's copy was not one of them. The confirm is raised by JS AFTER the
  // click, so the sample loses the race, the confirm is skipped, and the scrim
  // then eats the next click.
  await Promise.race([
    overlay.waitFor({ state: "visible", timeout: 2000 }),
    page.locator("#competitions-page.active, #tasks-page.active, #pending-page.active")
      .first().waitFor({ state: "visible", timeout: 2000 }),
  ]).catch(() => {});
  if (await overlay.isVisible().catch(() => false)) {
    const title = (await overlay.locator("#modal-title").textContent().catch(() => "")) || "";
    if (/Enter Live Event|Switch Competition/i.test(title)) {
      await overlay.locator("#modal-confirm-btn").click();
    }
  }
}

const activePage = (page) => page.evaluate(() =>
  (document.querySelector(".page.active") || {}).id || null);
// The two pollers are the thing enterCompetitionView owns. S is mirrored onto
// window at boot, so their handles are readable.
const pollers = (page) => page.evaluate(() => ({
  status: window.S.statusPollInterval !== null && window.S.statusPollInterval !== undefined,
  leaderboard: window.S.lbInterval !== null && window.S.lbInterval !== undefined,
}));

test.describe("v8.1.0 — routeVerdict + enterCompetitionView", () => {
  test("a LIVE competition routes to the challenges page and starts BOTH pollers", async ({ page }) => {
    const s = await setup();
    const { email, ended } = await makeEnrolledParticipant([s.live, s.upcoming]);
    await participantPage(page, email);
    await openPickerAll(page);
    await pick(page, s.live);
    await expect.poll(() => activePage(page), { timeout: 15000 }).toBe("tasks-page");
    // Mutation that this catches: enterCompetitionView starting only the status
    // poll. Without it the leaderboard never refreshes and, in Phase 4 terms,
    // there is nothing to gate.
    await expect.poll(() => pollers(page).then(p => p.leaderboard), { timeout: 10000 }).toBe(true);
    // v8.3.13 — POLLED, not sampled once. `enterCompetitionView` starts the two
    // pollers, and there is no guarantee the leaderboard one is installed LAST —
    // so a single read the instant the first appears can catch the other
    // mid-install under load, and the failure ("the status poll is running too:
    // false") reads as a missing poller rather than as a race.
    await expect.poll(() => pollers(page).then(p => p.status),
      { timeout: 10000, message: "the status poll is running too" }).toBe(true);
  });

  test("an ENDED competition ALSO routes to the challenges page, not the waiting screen", async ({ page }) => {
    // THE ARM NOTHING WAS ASSERTING. Deleting `||navStatus==='ended'` from the
    // verdict sends a participant opening a finished event to the pending page —
    // a countdown to a start time that has long passed, instead of the challenges
    // and answers they came back to read — and the entire 2 123-test suite passed.
    const s = await setup();
    const { email, ended } = await makeEnrolledParticipant([s.live, s.upcoming]);
    await participantPage(page, email);
    await openPickerAll(page);
    await pick(page, ended);
    await expect.poll(() => activePage(page), { timeout: 15000 }).toBe("tasks-page");
  });

  test("an UPCOMING competition routes to the waiting screen — the positive control", async ({ page }) => {
    // Without this, "ended lands on tasks-page" is equally satisfied by a verdict
    // that returns 'enter' for everything.
    const s = await setup();
    const { email, ended } = await makeEnrolledParticipant([s.live, s.upcoming]);
    await participantPage(page, email);
    await openPickerAll(page);
    await pick(page, s.upcoming);
    await expect.poll(() => activePage(page), { timeout: 15000 }).toBe("pending-page");
  });

  test("the verdict itself answers all four cases from one place", async ({ page }) => {
    const s = await setup();
    const { email, ended } = await makeEnrolledParticipant([s.live, s.upcoming]);
    await participantPage(page, email);
    await openPickerAll(page);
    // Unit-level, against the real exported helper: the two non-status arms have
    // no UI path that isolates them, and they are what the five call sites used to
    // re-derive individually.
    const v = await page.evaluate(() => ({
      timeslot: window.routeVerdict("needsTimeslot"),
      unavailable: window.routeVerdict(false),
      live: window.routeVerdict(true, "live"),
      ended: window.routeVerdict(true, "ended"),
      upcoming: window.routeVerdict(true, "upcoming"),
    }));
    expect(v).toEqual({
      timeslot: "timeslot", unavailable: "unavailable",
      live: "enter", ended: "enter", upcoming: "pending",
    });
  });

  test("returning to the tab restarts both pollers — the site a routing-only hoist cannot reach", async ({ page }) => {
    // core/main.js's visibilitychange resume is not a routing fork at all: it names
    // the starters against a page id. It is in the ten precisely because a
    // routing-only hoist would leave it behind, and in Phase 4 that means a Program
    // participant who switches to their editor and comes back gets a year-long
    // countdown and a 15-second score poll for the life of the event.
    const s = await setup();
    const { email, ended } = await makeEnrolledParticipant([s.live, s.upcoming]);
    await participantPage(page, email);
    await openPickerAll(page);
    await pick(page, s.live);
    await expect.poll(() => activePage(page), { timeout: 15000 }).toBe("tasks-page");
    await expect.poll(() => pollers(page).then(p => p.leaderboard), { timeout: 10000 }).toBe(true);

    // THE OBSERVABLE IS A FRESH /api/status REQUEST, and two weaker choices were
    // tried and rejected first:
    //
    //   • "is there a poller?" cannot tell a live interval from a cancelled one —
    //     the hide handler calls clearInterval(id) but does NOT null S.lbInterval,
    //     so the handle is non-null both before and after.
    //   • "did the interval ID change?" is FLAKY, and it flaked: timer IDs are
    //     reusable after clearInterval, so a restart can legitimately be handed
    //     back the same number.
    //
    // enterCompetitionView calls startHackathonTimer, which fetches /api/status
    // IMMEDIATELY. A new request at the resume is therefore direct evidence that
    // the resume site called the shared helper — which is precisely what this
    // site, not being a routing fork, would otherwise be left out of.
    let statusCalls = 0;
    page.on("request", (r) => { if (r.url().includes("/api/status")) statusCalls++; });
    expect(await page.evaluate(() => window.S.lbInterval), "a live poll to begin with").toBeTruthy();

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The pause is recorded so the resume knows what to bring back.
    await expect.poll(() => page.evaluate(() => (window.S._pausedIntervals || []).slice()),
      { timeout: 5000 }).toContain("lbInterval");

    const beforeResume = statusCalls;
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => statusCalls, { timeout: 15000 }).toBeGreaterThan(beforeResume);
    // POLL for the handles, do not read them once. startHackathonTimer AWAITS
    // /api/status and installs its interval only after the response, so the
    // request the assertion above waits for necessarily lands BEFORE
    // statusPollInterval is set — reading immediately caught the gap.
    await expect.poll(() => page.evaluate(() => window.S.lbInterval != null), { timeout: 10000 })
      .toBe(true);
    await expect.poll(() => page.evaluate(() => window.S.statusPollInterval != null), { timeout: 10000 })
      .toBe(true);
  });
});
