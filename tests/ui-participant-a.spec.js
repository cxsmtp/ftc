// @ts-check
//
// Split from ui-participant.spec.js in v7.21.37 — it was 118s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Superadmin UI · Verification pages CSP compliance · Participant core flows (v6.20.x) · Participant accessibility — keyboard basics · LinkedIn registration dialog (v6.18.x) · Profile fields UI — personal_title + phone + Work Title (PR-2) · Nickname auto-suggestion (PR-3) · Pending-verification page (PR-5) · v7.11.0 — participant team/group leaderboard · v7.15.4 — sign-out attribution edge cases
const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { registerPost } = require("./helpers");
const { fillBreakGlass, submitLogin, signUpViaUi, narrowEventsTable } = require("./ui-admin-helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");

// v8.7.5 — resolve an admin tab by its `data-tab-id`, never by its visible
// label: the sidebar's Events tab keeps the id `admin-competitions-tab` (ids are
// identifiers) while the label is copy and moves. Mirrors TAB_SLUG in
// tests/ui-admin-helpers.js.
const _TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions" };
const _tabSel = (n) => `button.admin-nav-item[data-tab-id="admin-${_TAB_SLUG[String(n).toLowerCase()] || String(n).toLowerCase()}-tab"]`;


// Route page.goto() + page.request.* to this worker's server. See ui-admin.spec.js.
test.use({ baseURL: BASE });

async function login(page, email, password = "") {
  await page.goto("/");
  await page.waitForSelector("#login-email", { timeout: 5000 });
  await page.fill("#login-email", email);
  await fillBreakGlass(page, password);
  await submitLogin(page);
}

// See ui-admin.spec.js for rationale — one retry with a fresh password read
// absorbs a password rotation landing between getSuperadminPass() and POST.
async function loginViaApi(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  // v7.15.16 — see the twin in ui-admin.spec.js: retry a THROWN transient
  // (ECONNRESET under WORKERS=8) as well as a non-ok response.
  const tryPost = async (pw) => {
    try { return { r: await doPost(pw) }; }
    catch (e) { return { err: e }; }
  };
  let { r, err } = await tryPost(password);
  if (r && r.ok()) return;
  await new Promise(res => setTimeout(res, 300));
  const pw2 = email === "superadmin" ? getSuperadminPass() : password;
  ({ r, err } = await tryPost(pw2));
  if (r && r.ok()) return;
  if (!r) throw new Error(`loginViaApi(${email}) failed: ${err && err.message}`);
  // v7.22.0 — say WHY, using the SAME probe apiLogin uses. `401 {"error":
  // "Invalid email or password"}` is the deliberate anti-enumeration answer for
  // six different account states, so on its own it names none of them — and this
  // path had no diagnostic at all, which is why two v7.22.0 occurrences of the
  // class each cost a fresh investigation.
  throw new Error(`loginViaApi(${email}) failed: ${r.status()} ${await r.text()}`
    + await require("./helpers").describeAccountState(email, password));
}

// Test-robustness helper (v6.3.1): clear `users.active_competition_id` for a
// given email directly in the DB. Prevents the login auto-resume path from
// routing the next `page.goto("/")` into whichever competition a PRIOR test
// may have dropped the user into. Without this, a test that asserts "lands
// on the picker" is flaky under high-worker-count runs — an earlier test's
// successful select-competition on the same participant leaks through
// because active_competition_id is persisted user-level, not per-session.
//
// The server's own DELETE /api/admin/competitions/:id/users/:uid endpoint
// clears active_competition_id ONLY when it matches the comp being removed
// from (server.js ~5102). A test that needs a guaranteed-clean picker entry
// can't rely on that — it would need to discover what comp is "active" and
// remove from that one. Direct DB UPDATE is simpler, local to the test,
// and doesn't require introducing a new admin API surface.
function _resetActiveCompetition(email) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    db.prepare("UPDATE users SET active_competition_id=NULL WHERE email=?").run(email);
  } finally {
    db.close();
  }
}

// v6.20.x — shared E2E factory: create an approved, password-set participant
// and assign them to `compId`. Returns { id, email }. Uses the superadmin API
// (caller supplies a logged-in `sa` context + headers `h`). This is the
// reusable primitive the participant-flow E2E tests are built on — it replaces
// the ad-hoc register+verify+approve+reset blocks that several tests copy-paste.
async function createAssignedParticipant(sa, h, compId, opts = {}) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const email = opts.email || `e2e_${stamp}@acme.com`;
  const { api: anon, csrf: anonCsrf } = await freshCtx();
  await registerPost(anon, "/api/register", {
    headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
    data: {
      firstName: "E2E", lastName: "User", nickname: opts.nickname || `e2e_${stamp}`,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", email,
    },
  });
  await anon.dispose();
  const parts = (await (await sa.get("/api/admin/participants?limit=2000")).json()).participants;
  const me = parts.find(p => p.email === email);
  expect(me, `participant ${email} created`).toBeTruthy();
  await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
  await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
  if (compId) {
    await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [me.id], competitionIds: [compId] } });
  }
  return { id: me.id, email };
}

// v6.20.x — log `page` in AS the given participant, pre-select `compId` via the
// request context (so the SPA skips the picker on load), then land on the
// in-app shell. Waits on the Challenges nav button — the reliable "live comp is
// active" signal (auto-resume may land on the picker OR tasks page, but the nav
// button appears whenever a live/ended comp is selected). This is the exact
// proven sequence from the navigated_away tests; using #tasks-page.active as the
// wait target is what made earlier ad-hoc attempts flaky.
async function enterCompAsParticipant(page, email, compId) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: compId },
  });
  await page.goto("/");
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
}

// Per-tab body selector used by clickTab() / adminLogin() to wait for real
// data to render before the test pokes at the DOM.
const TAB_BODY = {
  competitions: "#admin-comp-body tr",
  tasks: "#admin-task-body tr",
  participants: "#admin-participants-body tr",
  submissions: "#admin-submissions-body tr",
  rankings: "#admin-rankings-body tr",
  logs: "#admin-logs-tab tbody tr",
};

async function adminLogin(page) {
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator(TAB_BODY.competitions).first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
}

async function participantLogin(page) {
  await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#comp-grid .comp-card, .nav-btn").first().waitFor({ state: "visible", timeout: 30000 });
}

/** Click an admin tab by name and wait for the sub-pane + first data row. */
async function clickTab(page, name) {
  // On mobile the sidebar is fixed off-screen. Open it via the hamburger button
  // (which IS in the viewport at narrow widths), wait for the slide-in, then click.
  // Only while the drawer is CLOSED: since v8.12.6 the button sits below the open
  // drawer's scrim, so clicking it then fails actionability instead of re-opening.
  const hamburger = page.locator("#admin-mobile-menu-btn");
  if (await hamburger.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await hamburger.click();
  const btn = page.locator(_tabSel(name)).first();
  // Use locator.evaluate to fire the click inside the page context, bypassing
  // Playwright's "must be in viewport" actionability check (the event delegation
  // at document level handles clicks regardless of position).
  await btn.waitFor({ state: "attached" });
  await btn.evaluate((el) => el.click());
  const slug = _TAB_SLUG[name.toLowerCase()] || name.toLowerCase();
  await page.locator(`#admin-${slug}-tab`).waitFor({ state: "visible", timeout: 5000 });
  const bodySel = TAB_BODY[slug];
  if (bodySel) {
    await page.locator(bodySel).first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
  }
}

/** Scope to a competition by clicking its name cell (same as old "View" button) */
async function viewComp(page, name) {
  await page.locator(`#admin-comp-body tr:has-text('${name}') td`).first().click();
  await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 5000 });
}

/** Open the kebab on a row-like locator and wait for the portal menu to render. */
async function openKebab(page, row) {
  await row.locator(".kebab-btn").first().click();
  await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
}

/**
 * Select the first competition card (if a picker is shown) and click the
 * given nav button. Waits deterministically for the nav button to render
 * before clicking — no fixed delays.
 */
async function enterCompAndNav(page, navText) {
  // v7.21.38 — WAIT FOR THE APP TO SETTLE BEFORE DECIDING WHICH VIEW IT IS IN.
  // `card.isVisible()` is a point-in-time check with no wait: while the picker
  // is still loading it answers false, the click is skipped, the participant
  // never enters a competition, and the nav button therefore never appears —
  // surfacing 10 s later as `locator.waitFor: Timeout` on the NAV, which names
  // nothing about the cause. That is the v7.21.1 rule ("a long wait that ends
  // in nothing means the wrong VIEW, not a slow one") applied to a helper.
  const navBtn = page.locator(`.nav-btn:not([aria-disabled=true]):has-text('${navText}')`).first();
  const anyCard = page.locator("#comp-grid .comp-card, [data-comp-id]").first();
  const seen = async (l) => l.isVisible().catch(() => false);
  await expect
    .poll(async () => (await seen(navBtn)) || (await seen(anyCard)),
      { timeout: 20000, message: "neither the competition picker nor the participant nav ever rendered" })
    .toBe(true);
  if (!(await seen(navBtn))) {
    // v7.22.0 — ENTER A COMPETITION THAT HAS THESE TABS.
    //
    // `updateParticipantNav()` reveals #nav-challenges / #nav-leaderboard only
    // when the entered competition is live or ended (ui/nav.js: `showCompTabs =
    // status==='live'||status==='ended'`). The picker's default filter hides
    // ENDED competitions, so the visible cards are live + UPCOMING — and this
    // used to click `.first()`, on a grid that accumulates a competition per
    // fixture from every earlier test in the file. Land on an upcoming one and
    // the nav button never appears at all: the wait then burns its full 15 s and
    // reports "33 x locator resolved to hidden", naming the button rather than
    // the reason. Prefer a card that actually carries the tabs.
    const live = page.locator('#comp-grid .comp-card[data-status="live"]').first();
    const ended = page.locator('#comp-grid .comp-card[data-status="ended"]').first();
    // v8.1.0 — SHOW THE ENDED ONES BEFORE FALLING BACK TO THEM. The picker
    // defaults to "Active & Upcoming", so an ended competition is not in the grid
    // at all — which made the `ended` fallback above unreachable and dropped the
    // choice through to `anyCard`, i.e. an UPCOMING competition, whose pending
    // page carries no Challenges tab. Diagnosed from this helper's own dump:
    // `not-shown (page=pending-page, ..., status=upcoming)`. Exactly the admin
    // status-chip defect (v8.1.0, viewComp) one layer over.
    if (!(await seen(live)) && !(await seen(ended))) {
      const all = page.locator('#comp-filters [data-action="set-comp-filter"][data-value="all"]');
      if (await seen(all)) {
        await all.click();
        await expect.poll(async () => (await seen(live)) || (await seen(ended)) || (await seen(anyCard)),
          { timeout: 10000 }).toBe(true);
      }
    }
    const target = (await seen(live)) ? live : (await seen(ended)) ? ended : anyCard;
    await target.click();
    // Picking a DIFFERENT competition while one is already active raises a
    // "Leave Event?" confirm, which swallows the click — the participant
    // never enters, so the tab never appears and the wait below burns its full
    // budget naming only the button. Whether the modal appears depends on the
    // ambient active_competition_id, i.e. on what ran before.
    //
    // v8.3.22 — WAIT FOR IT, do not sample for it. This was a bare
    // `isVisible()`, which is the very point-in-time check this helper's own
    // header warns about for the CARD: the modal is raised by JS AFTER the
    // click, so the sample lost the race, the confirm was skipped, and the modal
    // then intercepted the nav click below — surfacing as a 60 s timeout whose
    // call log reads `<div id="modal-overlay"> intercepts pointer events` and
    // names nothing about a competition switch. Settle into one of two states
    // instead: the confirm is up, or the nav already is.
    const confirmBtn = page.locator("#modal-confirm-btn");
    await expect
      .poll(async () => (await seen(confirmBtn)) || (await seen(navBtn)),
        { timeout: 10000, message: "after picking a competition, neither the confirm modal nor the nav appeared" })
      .toBe(true);
    if (await seen(confirmBtn)) {
      await confirmBtn.click();
      // And wait for the scrim to actually go: the click resolves the promise,
      // but the overlay is removed a tick later and still eats a nav click.
      await page.locator("#modal-overlay").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
    }
  }
  // Report the VIEW on failure. "33 x locator resolved to hidden" says the tab
  // is not shown; it does not say that the app is sitting on the picker, or on
  // the pending page of an UPCOMING competition (updateParticipantNav only
  // reveals these tabs for live/ended) — which is the actual answer.
  await expect.poll(async () => (await seen(navBtn)) ? "shown" : await page.evaluate(() => {
    const active = document.querySelector(".page.active");
    return `not-shown (page=${active ? active.id : "none"}, comp=${window.S?.currentCompetitionId || "none"}, status=${window.S?.currentCompStatus || "none"})`;
  }), { timeout: 15000, message: `the ${navText} tab never appeared` }).toBe("shown");
  await navBtn.click();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
// v7.21.37 — hoisted here from between two describes so the file can be
// split: a binding declared outside every describe belongs to whichever
// part inherits it, and the others fail with a bare ReferenceError.
const { AxeBuilder } = require("@axe-core/playwright");
// Gate tightened from serious+ to moderate+ in v6.8.4 — moderate violations
// include medium-severity colour-contrast and aria issues worth surfacing.
const AXE_GATED_IMPACTS = new Set(["moderate", "serious", "critical"]);


test.describe("Superadmin UI", () => {
  test("delete available in task kebab menu", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Delete now lives in the task row's kebab menu (not inline)
    await expect(page.locator("#admin-task-body .kebab-btn").first()).toBeVisible({ timeout: 5000 });
    expect(await page.locator("#admin-task-body .kebab-menu button.km-danger:has-text('Delete')").count()).toBeGreaterThan(0);
  });

  test("delete user available in participant kebab menu", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    // Delete now lives in the kebab menu (not inline). Verify the kebab is present and contains Delete.
    const kebab = page.locator("#admin-participants-body .kebab-btn").first();
    await expect(kebab).toBeVisible({ timeout: 5000 });
    expect(await page.locator("#admin-participants-body .kebab-menu button.km-danger:has-text('Delete')").count()).toBeGreaterThan(0);
  });

  test("import buttons visible", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await expect(page.locator("#import-tasks-btn").first()).toBeVisible({ timeout: 3000 });
    await clickTab(page, "Participants");
    // Import lives in the one Export ▾ menu (with CSV and JSON).
    await page.locator("#p-export-menu-btn").click();
    await expect(page.locator('#kebab-portal.open [data-action="click-hidden-input"][data-target-id="import-participants-file"]')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
  });

  test("regular admin does NOT see delete/import", async ({ page }) => {
    // Promote Carol to admin role via API, login as her, then restore
    const { api, csrf } = await apiLogin("superadmin");
    const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
    const carol = parts.find(p => p.email === "carol@acme.com");
    await api.post(`/api/admin/participants/${carol.id}/role`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { role: "admin" },
    });
    await api.dispose();

    // v8.8.19 — the demotion is in a `finally`, and this is the highest-risk of
    // the six: a browser flow with 30-second waits between the promotion and the
    // restore, so a timeout — not merely a failed assertion — used to leak an
    // admin, staff-tagged carol into every later test in this file.
    try {
      await loginViaApi(page, "carol@acme.com", PARTICIPANT_PASS);
      await page.goto("/");
      // Carol has admin role → auto-lands on admin view. Wait for the admin
      // page + default tab rows before poking the Challenges tab.
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
      await page.locator(TAB_BODY.competitions).first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
      await clickTab(page, "Challenges");
      // Wait for rendered rows before counting — an empty-body race would pass
      // the negative assertion falsely. The kebab is always present on admin
      // rows regardless of role, so its presence = data rendered.
      await expect(page.locator("#admin-task-body .kebab-btn").first()).toBeVisible({ timeout: 5000 });
      expect(await page.locator("#admin-task-body .kebab-menu button.km-danger:has-text('Delete')").count()).toBe(0);
      await expect(page.locator("#import-tasks-btn")).not.toBeVisible();
    } finally {
      const { api: api2, csrf: csrf2 } = await apiLogin("superadmin");
      await api2.post(`/api/admin/participants/${carol.id}/role`, {
        headers: { "x-csrf-token": csrf2, "content-type": "application/json" },
        data: { role: "participant" },
      }).catch(() => {});
      await api2.dispose();
    }
  });

  // ── v7.15.17: the waiting poll needs the generation guard too ─────────────
  // _pollWaitingForAllSlots was the one structural sibling with neither a
  // pre-parse capture nor a post-parse re-check — a missing FIX, not just a
  // missing test. Its interval is cleared on a competition switch, but a fetch
  // already in flight still lands afterwards.
  test("the waiting poll discards a status body from the previous competition", async ({ page }) => {
    // v7.21.38 — OWNS ITS PARTICIPANT. This authenticated as the shared seeded
    // `alice` and went flaky at WORKERS=12 with `401 Invalid email or password`
    // — the v7.15.32 class: earlier lifecycle tests in the file block, lock and
    // re-password the seeded fixtures, so whether alice is still usable depends
    // on which tests happen to run before this one. Splitting the file changed
    // that set, which is exactly the "broken by new neighbours" case the
    // independence sweep cannot see (it only catches tests that NEED a
    // predecessor). The test needs *a* signed-in participant and nothing about
    // alice specifically: it stubs /api/status outright and drives the poll
    // in-page.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const liveComp = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.name === "Test Live");
    const me = await createAssignedParticipant(sa, saH, liveComp.id);
    await sa.dispose();
    await loginViaApi(page, me.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForFunction(() => typeof window._pollWaitingForAllSlots === "function", { timeout: 20000 });
    try {
      // A status body that claims every slot has ended. If the poll acts on it
      // after a switch, the participant is shown an end-of-competition state
      // for the competition they just LEFT.
      await page.route("**/api/status", route => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ competition_fully_ended: true, fully_ended: true, status: "ended" }),
      }));
      const acted = await page.evaluate(async () => {
        // Assert the DURABLE side effect, not a toast: showToast is an ES-module
        // import bound at import time, so stubbing window.showToast intercepts
        // nothing and any assertion on it holds vacuously (an earlier draft did
        // exactly that and passed with the guard removed).
        window.S._competitionFullyEnded = false;
        const p = window._pollWaitingForAllSlots();
        window.S._compGen++;            // the switch lands mid-flight
        await p;
        return window.S._competitionFullyEnded === true;
      });
      expect(acted,
        "a status body that arrived after the participant switched competitions must be discarded — " +
        "acting on it announces the end of a competition they are no longer in"
      ).toBe(false);
    } finally { await page.unroute("**/api/status"); }
  });

  // ── v7.15.17: the deadline must survive the BODY, tested BEHAVIOURALLY ────
  // A re-audit showed the source scanner billed as this class's "cure" detects
  // a revert of only three of five sites — missing fetchTransientRetry, the
  // very site the finding was reported against, and lib/http.js, the site the
  // class is named after. It cannot do better in principle: the correct
  // implementations deliberately have NO body read in the same function (they
  // hand the timer onward), so there is nothing local for a scanner to check.
  //
  // The behaviour is checkable, though: a server that commits headers and then
  // never finishes the body. A client whose deadline covers the body settles;
  // one that clears its timer at headers hangs for ever.
  test("a stalled response BODY is bounded by the client deadline", async ({ page }) => {
    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForFunction(() => typeof window.fetchTransientRetry === "function", { timeout: 20000 });

    // v7.22.0 — the deadline is 4 s, not 1.5 s, and the header budget is derived
    // from it rather than written out as an absolute.
    //
    // The guard below exists to stop the test passing VACUOUSLY: if the deadline
    // elapsed before the headers even arrived, what was measured is a header
    // timeout, not the body timeout this test is named for. But it was a
    // hard-coded `afterHeaders < 1200` against a 1500 ms deadline — a 300 ms
    // margin on a box running 12 workers plus 12 browsers, so a contended round
    // trip fails it while the mechanism under test is working perfectly. Widening
    // the deadline and expressing the guard as a FRACTION of it keeps the
    // anti-vacuity property and stops the assertion being a latency benchmark.
    const DEADLINE = 4000;
    const outcome = await page.evaluate(async (deadline) => {
      const t0 = performance.now();
      // One attempt. The endpoint commits headers immediately and then holds the
      // body open for 60 s.
      const r = await window.fetchTransientRetry("/api/test/stall-body", undefined,
        { attempts: 1, timeoutMs: deadline });
      const afterHeaders = performance.now() - t0;
      const body = await window.readBody(r);
      return { afterHeaders, total: performance.now() - t0, body, gotResponse: !!r };
    }, DEADLINE);

    expect(outcome.gotResponse, "headers arrive immediately, so a Response is returned").toBeTruthy();
    expect(outcome.afterHeaders,
      `headers are committed at once — this test is about what happens AFTER them. ` +
      `They took ${Math.round(outcome.afterHeaders)}ms of a ${DEADLINE}ms deadline; if that is ` +
      `most of the budget, the deadline killed the HEADER wait and the body read was never reached.`
    ).toBeLessThan(DEADLINE / 2);
    // POSITIVE control, new in v7.22.0: the read must have run until the deadline
    // and then stopped. Without it, a client that gave up instantly — or an
    // endpoint that closed the body early — would satisfy the upper bound below
    // and the test would report the deadline working when nothing had been
    // bounded at all.
    expect(outcome.total,
      `the body read must be ended BY the deadline, not by something faster. ` +
      `Total ${Math.round(outcome.total)}ms for a ${DEADLINE}ms deadline.`
    ).toBeGreaterThan(DEADLINE * 0.5);
    expect(outcome.total,
      `reading a body that never completes must be bounded by the deadline. Took ${Math.round(outcome.total)}ms ` +
      `for a ${DEADLINE}ms deadline — an unbounded read hangs until the Playwright timeout instead.`
    ).toBeLessThan(DEADLINE + 6000);
    expect(outcome.body,
      "an aborted body yields null, which callers already treat as \"retry on the next poll\""
    ).toBeNull();
  });

  // ── v7.15.16: stored XSS, tested at the SINK ──────────────────────────────
  // The previous lock (functional-security.api.spec.js:1429) asserted the API
  // returns a nickname UNESCAPED — an API-contract test wearing an XSS test's
  // name. Proven inadequate by mutation: replacing all seven esc() calls in
  // leaderboard.js with an identity function passed 517 tests, including the
  // whole security suite. Escaping is a RENDER concern, so it has to be tested
  // where the string reaches the DOM.
  test("a hostile nickname cannot inject nodes into the leaderboard", async ({ page }) => {
    const stamp = Date.now();
    // Printable ASCII only (the nickname charset rule), and every character of
    // an injection: a tag-breaking quote, an element, and an event handler.
    // Must fit the 40-char nickname cap while still carrying every character of
    // an injection: a tag-breaking quote, an element, and an event handler.
    const NICK = `x"><img src=x onerror=window.__xss=1>`;
    expect(NICK.length, "payload fits the nickname cap").toBeLessThanOrEqual(40);

    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    const email = `xss${stamp}@company.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" },
      data: {
        firstName: "Xss", lastName: "Probe", nickname: NICK, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
      },
    });
    // If the charset rule rejects this payload the test is pointless — say so
    // loudly rather than passing vacuously.
    expect(reg.status(), `hostile nickname must be REGISTERABLE for this test to mean anything: ${await reg.text()}`).toBe(200);
    await anon.dispose();

    const u = (await (await saPre.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await saPre.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saPreCsrf } });
    await saPre.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saPreCsrf } });
    await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [u.id], competitionIds: [liveComp.id] },
    });
    await saPre.dispose();

    try {
      await loginViaApi(page, email, PARTICIPANT_PASS);
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { competitionId: liveComp.id },
      });
      await page.goto("/");
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
      await page.locator("#leaderboard-page").waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll("#lb-body tr").length > 0, { timeout: 15000 });

      // The payload must be present as TEXT and absent as STRUCTURE.
      const probe = await page.evaluate(() => ({
        fired: !!window.__xss,
        injectedImgs: document.querySelectorAll('#leaderboard-page img[src="x"]').length,
        onerrorAttrs: [...document.querySelectorAll("#leaderboard-page *")].filter(e => e.hasAttribute("onerror")).length,
        text: document.getElementById("leaderboard-page").textContent,
      }));
      expect(probe.fired, "the injected handler must never execute").toBeFalsy();
      expect(probe.injectedImgs, "the payload must not become an <img> element").toBe(0);
      expect(probe.onerrorAttrs, "the payload must not become an event-handler attribute").toBe(0);
      expect(probe.text,
        "and it must still RENDER, as inert text — a test that passes because the name vanished proves nothing"
      ).toContain("onerror=");
    } finally {
      const { api: cl, csrf: cc } = await apiLogin("superadmin");
      await cl.delete(`/api/admin/participants/${u.id}`, { headers: { "x-csrf-token": cc } });
      await cl.dispose();
    }
  });

  // ── ext-audit v7.15.15 (MEDIUM): guards must survive the BODY read ────────
  // `fetch` resolves at response HEADERS. The v7.15.14 generation checks ran
  // there, but parsing the body is another await — so a competition switch
  // landing during the parse still let the old competition's tasks overwrite
  // S.allTasks. (Same shape as the server-side deadline bug fixed in v7.15.12:
  // header-time is not settle-time.)
  test("a task body that arrives after a switch is discarded post-parse", async ({ page }) => {
    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    const parts = (await (await saPre.get("/api/admin/participants?limit=200")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [alice.id], competitionIds: [liveComp.id] },
    });
    await saPre.dispose();
    const { api: alicePre, csrf: apc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alicePre.post("/api/select-competition", {
      headers: { "x-csrf-token": apc, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    await alicePre.dispose();

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await enterCompAndNav(page, "Challenges");
    await expect(page.locator(".task-card, [data-task-id]").first()).toBeVisible({ timeout: 15000 });

    try {
      // Headers arrive immediately; the generation bump lands while the CLIENT
      // is parsing. Driven from the page so the ordering is deterministic: the
      // fetch resolves, then we bump, then the parse completes.
      await page.route("**/api/tasks", route => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify([{ id: "late", title: "LATE BODY TASK", difficulty: "easy", solved: false, hackathon_ended: false }]),
      }));
      const painted = await page.evaluate(async () => {
        const realJson = Response.prototype.json;
        // Bump the generation at the moment the body is being read — i.e.
        // strictly after the headers-time guard has already passed.
        Response.prototype.json = function (...a) { window.S._compGen++; return realJson.apply(this, a); };
        try { await window.loadTasks(); } finally { Response.prototype.json = realJson; }
        return document.getElementById("task-grid").textContent;
      });
      expect(painted,
        "the generation must be re-checked AFTER the body parse — a switch during " +
        "parsing otherwise lets the old competition's tasks land"
      ).not.toContain("LATE BODY TASK");
    } finally { await page.unroute("**/api/tasks"); }
  });

  // ── ext-audit v7.15.15 (MEDIUM): latest selection intent wins ─────────────
  // _compGen invalidated in-flight READS but the selection WRITE had no
  // ordering: pick A then B, let B resolve first, and A's late response still
  // committed — the UI showing a competition the server session was not on.
  test("a slow earlier competition pick cannot overwrite a newer one", async ({ page }) => {
    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const parts = (await (await saPre.get("/api/admin/participants?limit=200")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    const two = comps.filter(c => c.name === "Test Live" || c.name === "Test Upcoming").slice(0, 2);
    expect(two.length, "two competitions to switch between").toBe(2);
    await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [alice.id], competitionIds: two.map(c => c.id) },
    });
    await saPre.dispose();

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForFunction(() => typeof window.selectCompetition === "function", { timeout: 20000 });

    const [A, B] = two;
    // A's response is held; B's is immediate. A resolves LAST.
    await page.route("**/api/select-competition", async route => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.competitionId === A.id) await new Promise(r => setTimeout(r, 1200));
      await route.continue();
    });
    try {
      const finalId = await page.evaluate(async ([aId, bId]) => {
        const pA = window.selectCompetition(aId);     // slow
        await new Promise(r => setTimeout(r, 100));
        const pB = window.selectCompetition(bId);     // fast — the latest intent
        await Promise.allSettled([pA, pB]);
        return window.S.currentCompetitionId;
      }, [A.id, B.id]);
      expect(finalId,
        "the LAST competition the participant picked must win — a slow earlier " +
        "pick committing afterwards leaves the UI on a competition the server session is not on"
      ).toBe(B.id);
    } finally { await page.unroute("**/api/select-competition"); }
  });

  // ── ext-audit v7.15.14 (MEDIUM): stale competition responses ──────────────
  // The participant loaders had no competition generation guard, so under
  // reordered WAN responses competition A's tasks could land after the
  // participant had already switched to B — showing A's challenges under B's
  // heading, with nothing on screen saying so.
  test("a task response for the PREVIOUS competition is discarded after a switch", async ({ page }) => {
    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    const parts = (await (await saPre.get("/api/admin/participants?limit=200")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [alice.id], competitionIds: [liveComp.id] },
    });
    await saPre.dispose();
    const { api: alicePre, csrf: apc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alicePre.post("/api/select-competition", {
      headers: { "x-csrf-token": apc, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    await alicePre.dispose();

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await enterCompAndNav(page, "Challenges");
    await expect(page.locator("#tasks-page")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".task-card, [data-task-id]").first()).toBeVisible({ timeout: 15000 });

    try {
      // Hold a /api/tasks response open, then bump the generation underneath it
      // exactly as a competition switch does. The late response must be dropped.
      await page.route("**/api/tasks", async route => {
        await new Promise(r => setTimeout(r, 1200));
        route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify([{ id: "stale-task", title: "STALE COMPETITION TASK", difficulty: "easy", solved: false, hackathon_ended: false }]),
        });
      });
      await page.evaluate(() => {
        const p = window.loadTasks();
        window.S._compGen++;          // the switch lands while the read is in flight
        return p;
      });
      const after = await page.evaluate(() => document.getElementById("task-grid").textContent);
      expect(after,
        "a response that arrived after the competition changed must NOT be rendered — " +
        "it describes the competition the participant just left"
      ).not.toContain("STALE COMPETITION TASK");
      // NOTE: the grid is NOT byte-identical to before — loadTasks paints its
      // skeletons before fetching, and the discarded response leaves them up.
      // That is correct: in the real flow the switch's own loadTasks renders
      // into them immediately. What matters is that no stale DATA was painted,
      // and that the subtitle was not rewritten with the wrong solved count.
      const sub = await page.evaluate(() => document.getElementById("tasks-subtitle").textContent);
      expect(sub, "the discarded response must not update the solved counter either").not.toMatch(/^0\/1 solved$/);
    } finally { await page.unroute("**/api/tasks"); }
  });

  // ── ext-audit v7.15.14 (MEDIUM): a failed first load must offer a way out ──
  // The copy promised a retry, but /api/tasks has no poll of its own: a failed
  // FIRST load left the grid skeletonised for ever with no path but a reload.
  test("a failed task load shows an actionable retry, not skeletons for ever", async ({ page }) => {
    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    const parts = (await (await saPre.get("/api/admin/participants?limit=200")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [alice.id], competitionIds: [liveComp.id] },
    });
    await saPre.dispose();
    const { api: alicePre, csrf: apc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alicePre.post("/api/select-competition", {
      headers: { "x-csrf-token": apc, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    await alicePre.dispose();

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await enterCompAndNav(page, "Challenges");
    await expect(page.locator("#tasks-page")).toBeVisible({ timeout: 15000 });

    try {
      await page.route("**/api/tasks", route => route.abort("failed"));
      await page.evaluate(() => window.loadTasks());
      // Skeletons mean "loading" — leaving them up after a terminal failure
      // tells the participant something is still coming when nothing is.
      await expect(page.locator("#task-grid .skeleton-card")).toHaveCount(0);
      const retry = page.locator('[data-action="retry-load-tasks"]');
      await expect(retry, "a real, clickable way to try again").toBeVisible();
      await expect(page.locator("#loading-overlay")).toBeHidden();

      // And it actually recovers when the network comes back.
      await page.unroute("**/api/tasks");
      await retry.click();
      await expect(page.locator(".task-card, [data-task-id]").first()).toBeVisible({ timeout: 15000 });
    } finally { await page.unroute("**/api/tasks").catch(() => {}); }
  });

  // ── ext-audit v7.15.13 (MEDIUM): a transient failure is not lost access ────
  // Every non-ok response used to eject the participant to the picker with
  // "You are no longer in this event." A 429 or a load-balancer 5xx says
  // nothing about membership — it is a blip — so a participant mid-competition
  // was being thrown out, and told the wrong reason, by a momentary network
  // problem. They must stay put and recover on the next poll.
  test("a transient 503 on /api/tasks does NOT eject the participant", async ({ page }) => {
    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    const parts = (await (await saPre.get("/api/admin/participants?limit=200")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [alice.id], competitionIds: [liveComp.id] },
    });
    await saPre.dispose();
    // Pre-select the competition on Alice's own session BEFORE the browser
    // loads. Earlier tests in this file leave her membership/active-competition
    // in varying states, and without this `enterCompAndNav` can land on an
    // "Enter Live Event?" confirm modal instead of the tasks page — the
    // same trap the removal test below documents. (This was a real flake: the
    // test passed in isolation and under --repeat-each, and failed only in a
    // full-suite run where the preceding tests had run first.)
    const { api: alicePre, csrf: alicePreCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alicePre.post("/api/select-competition", {
      headers: { "x-csrf-token": alicePreCsrf, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    await alicePre.dispose();

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await enterCompAndNav(page, "Challenges");
    await expect(page.locator("#tasks-page")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".task-card, [data-task-id]").first()).toBeVisible({ timeout: 15000 });

    try {
      // Now make /api/tasks fail the way a proxy does. Every attempt including
      // the retries gets the 503, so this is the worst case: still no eject.
      let hits = 0;
      await page.route("**/api/tasks", route => {
        hits++;
        route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "upstream" }) });
      });
      await page.evaluate(() => window.loadTasks());
      expect(hits, "the client retried the transient failure rather than giving up on the first").toBeGreaterThan(1);

      // Still in the competition: no picker, no false "no longer in this
      // competition" message, and the loading overlay is not stuck up.
      await expect(page.locator("#tasks-page")).toBeVisible();
      await expect(page.locator("#comp-picker-page.active")).toHaveCount(0);
      await expect(page.locator("#loading-overlay")).toBeHidden();
    } finally {
      // Unroute in a finally: leaving the 503 route installed would poison any
      // later navigation in this page context if an assertion above throws.
      await page.unroute("**/api/tasks");
    }
  });

  test("participant ejected to competition picker when admin removes them from the live competition", async ({ page }) => {
    // v6.10.27: fetch liveComp + alice up front and use try/finally
    // so cleanup (re-assign + re-select) runs even if an assertion
    // in the body throws. Pre-fix an early failure left alice
    // removed from Test Live; every subsequent test in the same
    // worker that called aliceInLive/apiLogin(alice…)+select-
    // competition got 403'd because alice wasn't a member anymore.
    const { api: saPre, csrf: saPreCsrf } = await apiLogin("superadmin");
    const comps = await (await saPre.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    // v7.22.7 — OWNS ITS PARTICIPANT, and that is the fix for a flake that has
    // now been chased four times.
    //
    // It used the seeded alice, and the failure-time diagnostic finally named
    // the cause: `isStaff: true`. A STAFF user sees EVERY competition regardless
    // of membership — `listParticipantCompetitions`' staff branch selects from
    // `competitions` with no join at all, because staff may join anything
    // without assignment. So for a staff user "removed from the competition"
    // correctly does NOT remove it from the picker, and this test was asserting
    // something the product deliberately does not do. The removal itself always
    // worked: the audit trail showed `removed_from_competition` every time, with
    // no re-add after it.
    //
    // Whichever neighbour leaves alice staff-tagged (the tag is also 2-second
    // CACHED, which is why it was intermittent) stops mattering once the test
    // stops borrowing her. Registering our own participant also removes the
    // dependency on her password, her role and her ambient active competition —
    // three other things that have bitten tests in this file.
    const stamp = Date.now();
    const email = `eject-${stamp}@company.co`;
    const nickname = `eject_${stamp}`;
    const { api: reg, csrf: regCsrf } = await freshCtx();
    const rr = await registerPost(reg, "/api/register", {
      headers: { "x-csrf-token": regCsrf, "content-type": "application/json" },
      data: {
        firstName: "Eject", lastName: "Probe", nickname, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      },
    });
    expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    await reg.dispose();
    const partsList = (await (await saPre.get("/api/admin/participants?limit=5000")).json()).participants;
    const alice = partsList.find(p => p.email === email);
    expect(alice, "the test's own participant must exist").toBeTruthy();
    await saPre.post(`/api/admin/participants/${alice.id}/verify`, { headers: { "x-csrf-token": saPreCsrf } });
    await saPre.post(`/api/admin/participants/${alice.id}/approve`, { headers: { "x-csrf-token": saPreCsrf } });
    const asg = await saPre.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saPreCsrf, "content-type": "application/json" },
      data: { userIds: [alice.id], competitionIds: [liveComp.id] },
    });
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    await saPre.dispose();
    const { api: alicePre, csrf: alicePreCsrf } = await apiLogin(email, PARTICIPANT_PASS);
    const sel = await alicePre.post("/api/select-competition", {
      headers: { "x-csrf-token": alicePreCsrf, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    await alicePre.dispose();
    try {
    // Seed: the participant logs in and enters the live competition → tasks page.
    await loginViaApi(page, email, PARTICIPANT_PASS);
    await page.goto("/");
    await enterCompAndNav(page, "Challenges");
    // Confirm she's on the tasks page with real task cards rendered.
    await expect(page.locator("#tasks-page")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".task-card, [data-task-id]").first()).toBeVisible({ timeout: 5000 });

    // Out-of-band: superadmin removes Alice from the live comp.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const rem = await sa.delete(`/api/admin/competitions/${liveComp.id}/users/${alice.id}`, {
      headers: { "x-csrf-token": saCsrf },
    });
    // v7.22.7 — assert the removal REMOVED SOMETHING, not merely that it 200'd.
    // The route answers `{ok:true, removed:false}` when no membership row
    // matched (`didRemove`), so `rem.ok()` alone passes for a DELETE that did
    // nothing at all — and the test would then go on to assert that a
    // competition she is still legitimately in has vanished from her picker.
    // That is a precondition, so it must fail as a precondition rather than
    // as the assertion five lines later.
    const remBody = await rem.json().catch(() => ({}));
    expect(rem.ok(), `remove failed: ${rem.status()} ${JSON.stringify(remBody)}`).toBeTruthy();
    expect(remBody.removed,
      `the DELETE matched no membership row — alice was not in ${liveComp.id} when it ran, ` +
      `so the eject under test has nothing to eject from. Response: ${JSON.stringify(remBody)}`
    ).toBe(true);
    await sa.dispose();

    // Seed stale content into #lb-body directly so we can prove the eject
    // helper clears it. Previously the helper targeted #leaderboard-body,
    // an element that doesn't exist, so old rows stayed mounted after a
    // logical ejection. Using direct injection (rather than navigating to
    // the leaderboard page and waiting for the fetch) keeps this assertion
    // focused on the DOM-clear contract — it's the helper that's under test.
    await page.evaluate(() => {
      const lb = document.getElementById("lb-body");
      if (lb) {
        // Node-level construction (not innerHTML) so we don't fight Trusted Types.
        const tr = document.createElement("tr");
        tr.setAttribute("data-test-stale", "1");
        const td = document.createElement("td");
        td.textContent = "stale-row";
        tr.appendChild(td);
        lb.appendChild(tr);
      }
    });
    expect(await page.locator("#lb-body tr").count()).toBeGreaterThan(0);

    // Force the client-side refresh path that was previously silently failing.
    // loadTasks() / loadLeaderboard() / startHackathonTimer() all now eject
    // to the picker on a non-OK response. Call loadTasks directly — it's the
    // fastest of the three and exercises the same helper.
    await page.evaluate(() => window.loadTasks && window.loadTasks());

    // The participant must land on the competition picker, not stuck on
    // tasks-page with a skeleton. comp-grid is the picker root.
    await expect(page.locator("#competitions-page")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#comp-grid")).toBeVisible({ timeout: 5000 });
    // The removed competition must not appear in the picker — /api/me was
    // refetched during eject and the list is re-derived from it.
    //
    // v7.22.0 — assert on the CARD's identity, not on the container's text.
    // `not.toContainText("Test Live")` is a substring match over the whole
    // grid, and this grid is shared, polled and accumulates a competition per
    // fixture from every earlier test in the file — so the assertion could be
    // broken or satisfied by an unrelated competition that merely shares a
    // substring, and its failure message named none of that (observed once at
    // WORKERS=12, reporting a grid holding only OTHER fixtures' competitions).
    // `data-comp-id` is an exact identity, so no other competition can affect
    // it whatever it is called; and on failure the poll prints what the picker
    // actually held, which is the part the old message could not tell us. No
    // mechanism is claimed for the original observation — this removes the
    // ambiguity that made it undiagnosable.
    await expect.poll(
      async () => page.locator(`#comp-grid .comp-card[data-comp-id="${liveComp.id}"]`).count(),
      {
        timeout: 5000,
        // v7.22.6 — report the SOURCE as well as the symptom. The grid dump
        // says the competition is still on screen; it does not say whether the
        // server still lists it (a membership/caching answer) or whether the
        // client failed to re-render one that /api/me had already dropped (a
        // stale-response or ordering answer). Those are completely different
        // searches, and the previous message could not tell them apart — which
        // is why this has now been investigated three times. It reproduces
        // 0/12 in isolation, so the next FULL-SUITE occurrence has to be the
        // one that answers it.
        message: `the removed competition ${liveComp.id} must be gone from the picker`,
      },
    ).toBe(0).catch(async (err) => {
      // v7.22.7 — THE DIAGNOSTIC RUNS AT FAILURE TIME, NOT WHEN THE POLL IS SET UP.
      //
      // It was passed as `expect.poll`'s `message` option, and an options object
      // is evaluated when the CALL IS CONSTRUCTED — so the snapshot was taken
      // before a single poll attempt had run, and read as though it described
      // the failure. That is the same class of mistake as measuring the wrong
      // predicate: the numbers were real, they just described the wrong moment.
      // Gathering it in the catch is the only way to describe the end state.
      const grid = await page.locator("#comp-grid .comp-card").evaluateAll(
        els => els.map(e => `${e.querySelector(".comp-name")?.textContent?.trim()}[${e.dataset.compId}]`).join(", ")
      ).catch(() => "<unreadable>");
      // Capture the WHOLE payload: `isStaff` is the fact that separates the two
      // remaining explanations, and it costs nothing extra because /api/me is
      // already being fetched. A STAFF user sees EVERY competition regardless of
      // membership (listParticipantCompetitions' staff branch selects from
      // `competitions` with no join), so for them "removed from the competition"
      // legitimately does not remove it from the picker — the test's premise,
      // not the product, would be wrong. isStaff=false instead means she really
      // is still a member and something re-added her without an event.
      const mePayload = await page.request.get("/api/me").then(r => r.json()).catch(() => null);
      const server = mePayload
        ? (mePayload.competitions || []).map(c => `${c.name}[${c.id}]`).join(", ")
        : "<unreadable>";
      const staffFlag = mePayload ? String(mePayload.isStaff) : "<unreadable>";
      const model = await page.evaluate(() => (window.S?.myCompetitions || []).map(c => `${c.name}[${c.id}]`).join(", "))
        .catch(() => "<unreadable>");
      // If the SERVER still lists it, say WHO put her back — the membership
      // events carry an actor, which is what turns "still a member" into a name
      // (the method that cracked the alice-401).
      let history = "<not fetched: the server had already dropped it>";
      if (server.includes(liveComp.id)) {
        history = await (async () => {
          const { api: hi } = await apiLogin("superadmin");
          try {
            const d = await (await hi.get(`/api/admin/participants/${alice.id}/events?limit=20`)).json();
            return ((d.events || d.entries || []).slice(0, 14).map(e =>
              `${e.changed_at || e.event_time} ${e.event_type} by:${e.changed_by} ${JSON.stringify(e.details || {}).slice(0, 160)}`
            ).join("\n    ")) || "<no events>";
          } finally { await hi.dispose(); }
        })().catch(e => `<unreadable: ${e.message}>`);
      }
      throw new Error(
        `${err.message}\n` +
        `  MEMBERSHIP HISTORY (fetched only when the SERVER still lists it):\n    ${history}\n` +
        `  GRID (rendered): ${grid}\n` +
        `  MODEL (S.myCompetitions): ${model}\n` +
        `  SERVER (/api/me): ${server}\n` +
        `  isStaff: ${staffFlag}  <- TRUE means staff see every competition, so the test premise is wrong\n` +
        `  SERVER still lists it -> membership (who re-added her?). SERVER clean but MODEL stale -> ` +
        `a stale response won. MODEL clean but GRID stale -> the render.`
      );
    });
    // The live / tasks / leaderboard pages must all be hidden once ejected.
    // We check via visibility rather than reading currentCompetitionId — that
    // is a `let` binding and is NOT on window, so a naive read returns
    // undefined whether or not eject cleared anything.
    await expect(page.locator("#tasks-page")).toBeHidden();
    await expect(page.locator("#pending-page")).toBeHidden();
    await expect(page.locator("#leaderboard-page")).toBeHidden();
    // #lb-body must be empty — this was populated before the eject and the
    // helper now targets the correct element id.
    const lbBodyHtml = await page.locator("#lb-body").innerHTML();
    expect(lbBodyHtml.trim()).toBe("");

    } finally {
      // v7.22.7 — the elaborate restore this used to carry is GONE with the
      // shared fixture it existed for. It re-assigned alice AND re-selected her
      // competition, because our own removal route clears
      // active_competition_id and downstream tests would otherwise meet an
      // "Enter Live Event?" modal they do not know how to dismiss. A
      // participant this test registered has no downstream readers, so there is
      // nothing to put back — which is the second reason owning the fixture is
      // better than borrowing one: the cleanup cannot fail, because there is
      // none. The account is deleted so the pool does not grow every run.
      try {
        const { api: saDel, csrf: saDelCsrf } = await apiLogin("superadmin");
        await saDel.delete(`/api/admin/participants/${alice.id}`, { headers: { "x-csrf-token": saDelCsrf } });
        await saDel.dispose();
      } catch (_) { /* best-effort; a leftover test account breaks nothing */ }
    }
  });

  test("participant ejected from pending page when admin removes them before the event starts", async ({ page }) => {
    // Use Bob because seedTestData never runs select-competition for him —
    // so his active_competition_id starts NULL and page.goto("/") lands on
    // the picker without auto-resuming into the live comp (which would
    // put a "Leave Event?" modal in front of every picker-bound
    // click). v6.3.1 adds an explicit defensive reset before the test
    // body: under high-worker-count runs this field was occasionally
    // non-NULL, producing a race-flake that timed out waiting for
    // #competitions-page to be visible.
    _resetActiveCompetition("bob@acme.com");
    await loginViaApi(page, "bob@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 10000 });
    const upcomingCard = page.locator("#comp-grid .comp-card:has-text('Test Upcoming')").first();
    await upcomingCard.waitFor({ state: "visible", timeout: 5000 });
    await upcomingCard.click();
    // Upcoming comp → pending page; no "Enter Live Event?" modal.
    await page.locator("#pending-page").waitFor({ state: "visible", timeout: 5000 });

    // Out-of-band: superadmin removes Bob from the upcoming competition.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const upcomingComp = comps.find(c => c.name === "Test Upcoming");
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const bob = parts.find(p => p.email === "bob@acme.com");
    const rem = await sa.delete(`/api/admin/competitions/${upcomingComp.id}/users/${bob.id}`, {
      headers: { "x-csrf-token": saCsrf },
    });
    expect(rem.ok()).toBeTruthy();
    await sa.dispose();

    // Mimic the 15s pending-page poll tick. The real poll runs an interval
    // we don't want to wait for; calling the same two lines by hand
    // exercises the new recovery path (selectCompetition → false → eject).
    await page.evaluate(async () => {
      const result = await window.selectCompetition(window.currentCompetitionId);
      if (result === false) await window.ejectToCompetitionPicker();
    });

    // Ejected back to the picker; Test Upcoming is no longer in the list.
    await expect(page.locator("#competitions-page")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#comp-grid")).not.toContainText("Test Upcoming", { timeout: 5000 });
    const leftoverCompId = await page.evaluate(() => window.currentCompetitionId);
    expect(leftoverCompId == null).toBe(true);

    // Cleanup — re-add Bob so later tests see their expected membership.
    const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
    await sa2.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
      data: { userIds: [bob.id], competitionIds: [upcomingComp.id] },
    });
    await sa2.dispose();
  });

  test("waiting-for-all-slots poll ejects to picker when /api/status starts returning 4xx", async ({ page }) => {
    // Put Bob into an upcoming comp so his session has competitionId set
    // and /api/status resolves normally (200). We will then revoke his
    // membership out-of-band and invoke _pollWaitingForAllSlots() directly
    // — mimicking the 15s poll that handleCompetitionEnded() installs for
    // the "your session ended, waiting for all sessions to complete" state
    // without needing multi-slot scaffolding. The fix is the r.ok check +
    // ejectToCompetitionPicker() call; this test pins that branch.
    // v6.3.1: reset active_competition_id first to avoid auto-resume flake
    // (see _resetActiveCompetition comment at the top of the file).
    _resetActiveCompetition("bob@acme.com");
    await loginViaApi(page, "bob@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#comp-grid .comp-card:has-text('Test Upcoming')").first().click();
    await page.locator("#pending-page").waitFor({ state: "visible", timeout: 5000 });

    // Baseline — poll against a live session membership returns 200 and
    // does not eject (the /api/status response is just not "fully ended").
    // We infer the session has competitionId set from #pending-page being
    // the active page — getting here required a successful selectCompetition.
    await page.evaluate(() => window._pollWaitingForAllSlots && window._pollWaitingForAllSlots());
    await expect(page.locator("#pending-page")).toBeVisible({ timeout: 2000 });

    // Now revoke Bob's membership → /api/status returns 403.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const upcomingComp = comps.find(c => c.name === "Test Upcoming");
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const bob = parts.find(p => p.email === "bob@acme.com");
    await sa.delete(`/api/admin/competitions/${upcomingComp.id}/users/${bob.id}`, {
      headers: { "x-csrf-token": saCsrf },
    });
    await sa.dispose();

    // One invocation of the poll function now sees the 4xx and ejects.
    await page.evaluate(() => window._pollWaitingForAllSlots());
    await expect(page.locator("#competitions-page")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#comp-grid")).not.toContainText("Test Upcoming", { timeout: 5000 });

    // Cleanup — re-add Bob.
    const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
    await sa2.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
      data: { userIds: [bob.id], competitionIds: [upcomingComp.id] },
    });
    await sa2.dispose();
  });

  test("Open primary button visible for ended events, edit accessible in kebab", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await expect(page.locator(".status-badge.live").first()).toBeVisible({ timeout: 10000 });
    await page.locator("#comp-status-filters button[data-status='all']").click();
    // FILTER FIRST. The competitions table paginates at 30 rows and every spec
    // on this worker shares one DB, so by the time this runs the seeded
    // "Test Ended" competition has been pushed off page 1 by rows other files
    // created — the lookup then fails because the row is genuinely ABSENT, not
    // slow. Same class as the v7.15.29 ui-admin fix; ui-participant never got it.
    if (await page.locator("#comp-search").count()) {
      await narrowEventsTable(page, "Test Ended");
      await page.locator("tr:has-text('Test Ended')").first()
        .waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    }
    const endedRow = page.locator("tr:has-text('Test Ended')");
    await expect(endedRow.first()).toBeVisible({ timeout: 10000 });
    // Open is the universal primary action for events (opens the event's workspace)
    await expect(endedRow.locator(".comp-actions button.btn[data-action='comp-open']").first()).toBeVisible({ timeout: 5000 });
    await expect(endedRow.locator(".comp-actions button.btn[data-action='comp-open']").first()).toContainText("Open");
    // Edit still accessible via the kebab menu (superadmin override allows editing ended comps)
    await expect(endedRow.locator(".kebab-menu button:has-text('Edit')")).toHaveCount(1);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Verify / set-password pages — CSP compliance on inline styles
// ═══════════════════════════════════════════════════════════════════════════════
// /verified.html, /verify-failed.html, /verify-expired.html, and the
// server-rendered /verify confirm form all used to ship inline
// <style> blocks. The CSP's style-src-elem has no 'unsafe-inline', so
// modern browsers blocked the styles and rendered the pages unstyled.
// The fix extracts each into an external CSS file. Since v7.23.11 there is
// ONE — verify-pages.css — and the three result pages are server-rendered
// from _emailResultPage rather than being static files.
test.describe("Verification pages CSP compliance", () => {
  for (const url of ["/verified.html", "/verify-failed.html", "/verify-expired.html"]) {
    test(`${url}: no inline <style> blocks, external stylesheet loads, no CSP violations`, async ({ page }) => {
      const cspReports = [];
      page.on("request", req => {
        if (req.url().endsWith("/api/csp-report")) cspReports.push(req.postData() || "");
      });
      await page.goto(url);
      // No inline <style> blocks survive in the served HTML.
      const inlineStyles = await page.evaluate(() =>
        Array.from(document.querySelectorAll("style")).filter(s => (s.textContent || "").trim()).length);
      expect(inlineStyles).toBe(0);
      // The shared external stylesheet is requested. v6.8.1 appends a
      // content-hash ?v=<sha> query, so match by prefix.
      const verifyCss = page.locator('link[rel="stylesheet"][href^="/verify-pages.css"]');
      expect(await verifyCss.count()).toBe(1);
      // The card actually got its computed background from verify-pages.css —
      // if the link 404'd or was blocked we'd see the user-agent default.
      const bg = await page.locator(".card").first().evaluate(
        el => getComputedStyle(el).backgroundColor,
      );
      expect(bg).not.toBe("rgba(0, 0, 0, 0)"); // transparent → unstyled
      expect(cspReports).toEqual([]);
    });
  }

  test("/confirm-email (server-rendered result): no inline <style>, external stylesheet loads, no CSP violations", async ({ page }) => {
    // RE-POINTED at v7.23.10. This used to drive GET /verify, whose confirmation
    // interstitial was deleted when verification became one-click. Every
    // guarantee it makes still matters and still has a subject: _emailResultPage
    // is the surviving server-rendered page on the same shell, and it renders
    // for a bad code without any fixture at all.
    //
    // The guarantee: the layout CSS must arrive via an EXTERNAL stylesheet. An
    // inline <style> block is dropped by `style-src-elem 'self'` — the page then
    // renders unstyled AND every load files a CSP violation into the access log.
    // That is not hypothetical here: the unsubscribe shell shipped exactly that
    // way for eight releases (v7.23.6).
    const cspReports = [];
    page.on("request", req => {
      if (req.url().endsWith("/api/csp-report")) cspReports.push(req.postData() || "");
    });

    await page.goto("/confirm-email?code=not-a-real-code");
    const inlineStyles = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style")).filter(s => (s.textContent || "").trim()).length);
    expect(inlineStyles, "an inline <style> block would be dropped by the CSP").toBe(0);
    // v7.23.11 — verify-pages.css. The forked verify-page.css was deleted when
    // the two sheets converged; note `^=` rather than `=`, because the
    // content-hash pipeline appends ?v=<hash>.
    const verifyCss = page.locator('link[rel="stylesheet"][href^="/verify-pages.css"]');
    expect(await verifyCss.count()).toBe(1);
    // The card got its computed background from the external stylesheet — if the
    // link 404'd or was blocked we would see transparent.
    const bg = await page.locator(".card").first().evaluate(
      el => getComputedStyle(el).backgroundColor,
    );
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(cspReports).toEqual([]);
  });

  test("v7.23.10: the server-rendered result page is a11y-clean, in both themes", async ({ page }) => {
    // THE HALF OF THE FORK NOBODY WAS WATCHING. The three STATIC verify pages
    // have carried axe scans for releases; their server-rendered twin had NONE,
    // anywhere — and that is the mechanism, not a coincidence, behind the gaps
    // this audit found on that side (no designed focus ring, no color-scheme
    // meta, an ungated hover). A fork is dangerous when one side is unobserved.
    // Nothing stored is already the house mode, which follows the device (HOUSE_MODE
    // "system", public/theme-boot.js); "system" is stored here so each scheme below
    // reaches the page whatever that default becomes.
    await page.addInitScript(() => { try { localStorage.setItem("hck-theme", "system"); } catch (_) { /* no storage */ } });
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/confirm-email?code=not-a-real-code");
      expect(await page.evaluate(() => document.documentElement.dataset.theme), `PRECONDITION: the page resolved ${scheme}`).toBe(scheme);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const bad = r.violations.filter(v => ["moderate", "serious", "critical"].includes(v.impact));
      expect(bad, `moderate+ a11y violations on the server-rendered result page (${scheme}) `
        + `[${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]`).toHaveLength(0);
    }
  });

});


// ═══════════════════════════════════════════════════════════════════════════════
// Participant core flows — answer submit + timeslot chooser (v6.20.x)
// ═══════════════════════════════════════════════════════════════════════════════
// Built on the createAssignedParticipant + enterCompAsParticipant helpers so the
// throwaway-user → live-comp entry is reliable (no #tasks-page.active flake).
test.describe("Participant core flows (v6.20.x)", () => {
  test("answer submit: wrong shows penalty, correct shows solved", async ({ page }) => {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let me, taskId;
    try {
      const liveComp = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.name === "Test Live");
      // Dedicated task so we never collide with another test's solve state.
      taskId = (await (await sa.post("/api/admin/tasks", { headers: h, data: {
        title: `SubmitFlow ${stamp}`, description: "<p>Answer me.</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "the-right-answer", explanation: "—", status: "published",
      }})).json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [liveComp.id] } });
      me = await createAssignedParticipant(sa, h, liveComp.id);

      await enterCompAsParticipant(page, me.email, liveComp.id);
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
      const card = page.locator(`[data-task-id="${taskId}"]`).first();
      await card.waitFor({ state: "visible", timeout: 10000 });
      await card.click();
      await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 5000 });

      // Wrong answer → submit opens a "Submit Answer" confirm modal first; accept
      // it, then assert the penalty message.
      await page.locator("#ans-text").fill("nope-" + stamp);
      await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#modal-confirm-btn").click();
      await expect(page.locator("#submit-result .result-msg.wrong")).toBeVisible({ timeout: 5000 });
      await expect(page.locator("#submit-result")).toContainText(/Incorrect/i);

      // Correct answer → same confirm modal, then the congrats flow fires and the
      // task list re-renders; assert the participant's score reached +50 server-side.
      await page.locator("#ans-text").fill("the-right-answer");
      await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#modal-confirm-btn").click();
      await expect.poll(async () => {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return db.prepare("SELECT 1 FROM submissions WHERE user_id=? AND task_id=? AND is_correct=1").get(me.id, taskId) ? 1 : 0; }
        finally { db.close(); }
      }, { timeout: 6000 }).toBe(1);
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: h }).catch(() => {});
      if (me) await sa.delete(`/api/admin/participants/${me.id}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  test("timeslot chooser: pick upcoming slot locks it; live slot prompts a confirm", async ({ page }) => {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const now = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let me, compId;
    try {
      // Multi-slot comp: one LIVE slot (started 1m ago) + one UPCOMING slot (+2h).
      compId = (await (await sa.post("/api/admin/competitions", { headers: h, data: {
        name: `SlotPick ${stamp}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 180,
      }})).json()).competition.id;
      const liveSlot = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
        name: "Live Slot", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 180,
      }})).json()).timeslot.id;
      const upcomingSlot = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
        name: "Upcoming Slot", start_time: new Date(now + 2 * 3600_000).toISOString(), duration_minutes: 180,
      }})).json()).timeslot.id;
      me = await createAssignedParticipant(sa, h, compId);

      // Log in + select the comp (multi-slot → SPA shows the timeslot picker).
      await loginViaApi(page, me.email, PARTICIPANT_PASS);
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { competitionId: compId } });
      await page.goto("/");
      await page.locator(`#timeslot-picker-content [data-ts-id="${upcomingSlot}"]`).waitFor({ state: "visible", timeout: 15000 });

      // Pick the UPCOMING slot — no live-confirm modal; the SPA records the
      // choice and navigates to the pending page (so the picker unmounts — the
      // server-side choice is the reliable signal, not a picker class).
      await page.locator(`[data-action="choose-timeslot"][data-ts-id="${upcomingSlot}"]`).click();
      await expect.poll(async () => {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, me.id)?.timeslot_id; }
        finally { db.close(); }
      }, { timeout: 5000 }).toBe(upcomingSlot);

      // After choosing an upcoming slot the SPA lands on the pending page; use
      // its "Change Session" affordance to re-open the picker, then click LIVE.
      await page.locator('[data-action="show-timeslot-picker"]').first().waitFor({ state: "visible", timeout: 10000 });
      await page.locator('[data-action="show-timeslot-picker"]').first().click();
      await page.locator(`[data-action="choose-timeslot"][data-ts-id="${liveSlot}"]`).waitFor({ state: "visible", timeout: 5000 });
      await page.locator(`[data-action="choose-timeslot"][data-ts-id="${liveSlot}"]`).click();
      const modal = page.locator("#modal-overlay.open");
      await expect(modal).toBeVisible({ timeout: 5000 });
      await expect(modal).toContainText(/live/i);
      // Cancel — the upcoming choice stays intact (no switch to the live slot).
      await page.locator("#modal-cancel-btn").click();
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, me.id)?.timeslot_id)
          .toBe(upcomingSlot);
      } finally { db.close(); }
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (me) await sa.delete(`/api/admin/participants/${me.id}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Participant accessibility — keyboard basics (v6.8.1)
// ═══════════════════════════════════════════════════════════════════════════════
// Not a full a11y audit, but enough to regression-lock the two smoke
// guarantees: every modal closes on Escape, and the help drawer's close
// button is reachable via keyboard after open. If those break, the rest
// of the keyboard path is probably broken too.
test.describe("Participant accessibility — keyboard basics", () => {
  test("Escape key closes the Help drawer", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#help-icon-btn", { timeout: 5000 });
    await page.click("#help-icon-btn");
    await page.waitForSelector("#help-drawer-overlay:not([hidden])", { timeout: 5000 });
    await page.keyboard.press("Escape");
    // Overlay should be hidden (either removed or [hidden])
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const overlay = document.getElementById("help-drawer-overlay");
        return !overlay || overlay.hidden || overlay.style.display === "none";
      });
    }, { timeout: 3000 }).toBe(true);
  });

  // The signed-out header's one appearance control (the day/night toggle is
  // gone; the mode is chosen in this dialog, or on the Appearance page once
  // signed in — tests/theme-cycle.spec.js).
  test("the signed-out look picker is a real button with a meaningful name, and Escape closes its dialog", async ({ page }) => {
    await page.goto("/");
    const btn = page.locator("#look-picker-btn");
    await expect(btn).toBeVisible({ timeout: 10000 });
    await expect(btn).toHaveAccessibleName(/look and theme/i);
    expect(await btn.evaluate(el => el.tagName), "a real <button>").toBe("BUTTON");
    await btn.click();
    const dlg = page.locator("#look-picker-overlay [role=dialog]");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('[role=group][aria-label="Mode"] [data-action="look-picker-mode"]'), "the mode lives in the dialog").toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(page.locator("#look-picker-overlay")).toHaveCount(0);
    await expect(btn, "focus returns to the opener").toBeFocused();
  });
});





test.describe("Profile fields UI — the short sign-up form (email first)", () => {
  async function openRegister(page) {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 5000 });
    await signUpViaUi(page, `short-${Date.now()}-${Math.floor(Math.random() * 1e5)}@company.example`, {}, { submit: false });
    await page.waitForSelector("#reg-first", { state: "visible", timeout: 5000 });
  }

  test("register form: name, company, job title and the detected location; the extras are off by default", async ({ page }) => {
    await openRegister(page);
    await expect(page.locator("label[for='reg-title']")).toContainText(/job title/i);
    for (const id of ["#reg-first", "#reg-last", "#reg-company", "#reg-title"]) await expect(page.locator(id)).toBeVisible();
    await expect(page.locator("#reg-location"), "the location is ONE line").toBeVisible();
    // Off by default: salutation, phone and LinkedIn are not on the form at all.
    for (const id of ["#reg-personal-title", "#reg-phone", "#reg-linkedin"]) await expect(page.locator(id)).toBeHidden();
    // Shown but optional by default: job function and city.
    await expect(page.locator("label[for='reg-job-function']")).toContainText(/optional/i);
    await expect(page.locator("label[for='reg-city']")).toContainText(/optional/i);
    // No nickname, avatar or second address at sign-up (the profile has them).
    for (const id of ["#reg-nick", "#reg-email2", "#avatar-grid"]) expect(await page.locator(id).count(), id).toBe(0);
  });

  test("register form: first and last name sit side by side on a desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRegister(page);
    const [a, b] = await Promise.all([page.locator("#reg-first").boundingBox(), page.locator("#reg-last").boundingBox()]);
    expect(Math.abs(a.y - b.y), "same row").toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
  });

  test("register form: 'change' opens the country and timezone pickers", async ({ page }) => {
    await page.context().clearCookies();
    await openRegister(page);
    const pick = page.locator("#reg-location-pick");
    const wasHidden = await pick.isHidden();
    if (wasHidden) {
      await page.click("[data-action='reg-location-change']");
      await expect(pick).toBeVisible();
    }
    await page.selectOption("#reg-country", "GB");
    await expect(page.locator("#reg-location-text")).toContainText(/United Kingdom/i);
  });

  test("profile editor shows Work Title + optional Salutation + Phone, prefilled from the account", async ({ page }) => {
    // Seed values via a SEPARATE API context (single-session eviction is fine —
    // the page login below establishes the live session; the DB values persist).
    const { api: seedApi, csrf: seedCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await seedApi.put("/api/me", { headers: { "x-csrf-token": seedCsrf, "content-type": "application/json" }, data: { personalTitle: "Dr.", phone: "+1 555 7777" } });
    await seedApi.dispose();
    // Page login + open editor — exact flow of the proven profile-edit axe test.
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": csrf, "content-type": "application/json" });
    await page.goto("/");
    // Profile lives in the account menu (tests/chrome-helpers.js).
    await require("./chrome-helpers").pressAccountMenuItem(page, "open-profile-editor");
    await page.waitForSelector("#profile-overlay", { state: "visible", timeout: 5000 });
    await expect(page.locator("label[for='prof-title']")).toContainText(/work title/i);
    await expect(page.locator("label[for='prof-personal-title']")).toContainText(/salutation/i);
    await expect(page.locator("#prof-personal-title")).toBeVisible();
    expect(await page.locator("#prof-personal-title").inputValue()).toBe("Dr.");
    expect(await page.locator("#prof-phone").inputValue()).toBe("+1 555 7777");
    // Email group is first; identity (salutation) sits above the location/professional groups.
    const order = await page.evaluate(() => {
      const t = id => { const e = document.getElementById(id); return e ? e.getBoundingClientRect().top : null; };
      return { email: t("prof-email"), salutation: t("prof-personal-title"), country: t("prof-country"), company: t("prof-company") };
    });
    expect(order.email).toBeLessThan(order.salutation);
    expect(order.salutation).toBeLessThan(order.country);
    expect(order.country).toBeLessThan(order.company);
    // Close without changes (clean form closes immediately).
    await page.click("[data-action='overlay-close'][data-overlay-id='profile-overlay']");
  });

  test("profile editor preserves a non-preset personal_title (no silent blank/data-loss)", async ({ page }) => {
    // A non-preset honorific can exist via the free-text import path. The editor's
    // <select> must render it as its own option, not fall back to the blank entry
    // (which would null it out on save). Seed via superadmin admin-edit (can set
    // any value), then open Bob's own profile editor and assert it renders.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const list = (await (await sa.get("/api/admin/participants?limit=500&search=bob@acme.com")).json()).participants;
    const bob = list.find(p => p.email === "bob@acme.com");
    expect(bob).toBeTruthy();
    await sa.put(`/api/admin/participants/${bob.id}`, { headers: { "x-csrf-token": saCsrf, "content-type": "application/json" }, data: { personalTitle: "Sr." } });
    await sa.dispose();

    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await codeLogin(page.request, "bob@acme.com", { "x-csrf-token": csrf, "content-type": "application/json" });
    await page.goto("/");
    // Profile lives in the account menu (tests/chrome-helpers.js).
    await require("./chrome-helpers").pressAccountMenuItem(page, "open-profile-editor");
    await page.waitForSelector("#profile-overlay", { state: "visible", timeout: 5000 });
    // The non-preset value renders as the selected option (not the blank fallback).
    expect(await page.locator("#prof-personal-title").inputValue()).toBe("Sr.");
    await page.click("[data-action='overlay-close'][data-overlay-id='profile-overlay']");
  });
});


test.describe("Short sign-up, end to end (email first)", () => {
  test("a new address: Continue, the code, the short form — and the new account is signed in with a suggested nickname", async ({ page }) => {
    const sfx = Date.now();
    const addr = `pendver-${sfx}@company.co`;
    await page.goto("/");
    const resp = await signUpViaUi(page, addr, { firstName: "José", lastName: "Müller" });
    expect(resp.status(), await resp.text()).toBe(200);
    const body = await resp.json();
    expect(body.ok, "signed in at once").toBe(true);
    expect(body.nickname, "a nickname suggested from the name, transliterated").toMatch(/^jos_mul\d{3}$/);
    await expect(page.locator("#login-page.active"), "the app left the entry screen").toHaveCount(0, { timeout: 15000 });
  });
});


// audit v7.7.35 (T4) — the edit-profile dirty-form contract has no test.
// Lock two cells: a CLEAN close fires no PUT /api/me and raises no confirm; a
// DIRTY Escape raises the "Discard changes?" confirm and Keep-editing keeps the
// dialog open (so a participant can't silently lose edits, nor get nagged on a
// clean close).
// v7.11.0 — the participant leaderboard page shows a "Team Rankings" board when the
// competition has bound groups, with the viewer's own team highlighted.
test.describe("v7.11.0 — participant team/group leaderboard", () => {
  const PUH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
  test("leaderboard page shows a Team Rankings board (viewer's team present) when groups are bound", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = PUH(saCsrf);
    const t = Date.now();
    // v7.11.7 — the board is opt-in AND needs >=2 non-empty teams, so enable it and
    // bind the viewer's Squad + a Rivals team.
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `PTeam ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true } })).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: `PTeam-T ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    // Fresh verified+approved participants with a known password.
    const mkParticipant = async (nick) => {
      const em = `pteam_${nick}_${t}@acme.com`;
      const { api: anon, csrf: ac } = await freshCtx();
      await registerPost(anon, "/api/register", { headers: PUH(ac), data: { firstName: "P", lastName: "T", nickname: nick, email: em, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
      await anon.dispose();
      const uu = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === em);
      await sa.post(`/api/admin/participants/${uu.id}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${uu.id}/approve`, { headers: saH });
      return { id: uu.id, email: em };
    };
    const u = await mkParticipant(`pt${t}`);
    const v = await mkParticipant(`pv${t}`);
    const g = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Squad ${t}`, userIds: [u.id] } })).json()).group.id;
    const g2 = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Rivals ${t}`, userIds: [v.id] } })).json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g, g2], competitionIds: [compId] } });
    await sa.dispose();

    // v7.11.7 — v must be on the board too so Rivals is a non-empty (active) group,
    // giving the 2 non-empty groups the board requires.
    { const { api: pv, csrf: pvc } = await apiLogin(v.email, PARTICIPANT_PASS);
      await pv.post("/api/select-competition", { headers: PUH(pvc), data: { competitionId: compId } });
      await pv.dispose(); }

    await loginViaApi(page, u.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/select-competition", { headers: PUH(csrfToken), data: { competitionId: compId } }); // sets login_time → on the board
    await page.goto("/");
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await page.locator("#leaderboard-page").waitFor({ state: "visible", timeout: 8000 });
    const section = page.locator("#lb-group-section");
    await expect(section).toBeVisible({ timeout: 8000 });
    await expect(section).toContainText("Team Rankings");
    const teamRow = section.locator("tr", { hasText: `Squad ${t}` });
    await expect(teamRow, "the viewer's team is on the board").toBeVisible();
    await expect(teamRow).toHaveClass(/\bme\b/); // highlighted as the viewer's own team

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.post(`/api/admin/competitions/${compId}/end-now`, { headers: PUH(clc) }).catch(() => {});
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });
});


// ── v7.15.4 follow-ups from the adversarial review of the fix itself ─────────
// Each of these is a way the FIX could have re-created the reported bug (or a
// new one) under a slightly different sequence.
test.describe("v7.15.4 — sign-out attribution edge cases", () => {
  async function stubStatus(page, body) {
    await page.route("**/api/session/status", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(body),
    }));
  }
  async function fake401(page, urlGlob, error = "Not authenticated") {
    await page.route(urlGlob, (route) => route.fulfill({
      status: 401, contentType: "application/json", body: JSON.stringify({ error }),
    }));
  }
  const modalUp = (page) => page.waitForFunction(() => {
    const el = document.getElementById("modal-overlay");
    return el && getComputedStyle(el).display !== "none";
  }, null, { timeout: 10_000 });

  // A tab left on the login page keeps its PRE-restart snapshot. Signing in
  // afterwards produces active:true with a NEW server_started_at — which the
  // drift check alone reads as "restart" and would throw the user out of the
  // session they just created, announcing it as no longer valid.
  test("signing in AFTER a restart is not mistaken for a restart-signout", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    const verdict = await page.evaluate(() => window._classifySignout({
      active: true,                                   // the session is ALIVE
      server_started_at: new Date(Date.now() + 60_000).toISOString(), // but the server did restart
      reason: null, kicked_by: null,
    }));
    expect(verdict.kind, "an alive session is never a restart-signout").not.toBe("restart");
  });

  // Mid-deploy the app can be up enough to 401 a poll while /api/session/status
  // still hits a warming upstream. Guessing "inactivity" there re-creates the
  // reported bug through the new code path.
  test("a failed status probe yields neutral copy, never an inactivity claim", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    await page.evaluate(() => window.stopSessionMonitor());
    // Status probe fails the way a bouncing reverse proxy fails it.
    await page.route("**/api/session/status", (route) => route.fulfill({ status: 502, body: "bad gateway" }));
    await fake401(page, "**/api/me");
    await page.evaluate(() => { fetch("/api/me").catch(() => {}); });
    await modalUp(page);
    const body = await page.locator("#modal-body").textContent();
    expect(body, "must not assert the user was idle when we could not find out").not.toMatch(/inactivity/i);
    expect(body).toMatch(/signed out/i);
  });

  // csrf_invalid maps to `unknown`, never `inactivity`: a stale token is not
  // idleness. Since v8.13.4 the refusal itself ENDS every identity-bearing
  // session, so the status probe that follows answers `active:false` — and that
  // is the shape asserted here (the fix-delta review): with `active:true` the
  // `d.active===true` arm answers `unknown` on its own and the csrf clause is
  // never reached, so the test passed with that clause deleted. The live shape
  // is kept as a second case, because it is how a pre-v8.13.4 server answered.
  test("a csrf_invalid is not reported as inactivity, on a session it ended or a live one", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    const snap = await page.evaluate(() => window._sessionMon.serverStartedAt);
    for (const active of [false, true]) {
      const verdict = await page.evaluate(([s, a]) => window._classifySignout(
        { active: a, server_started_at: s, reason: null, kicked_by: null }, "csrf_invalid",
      ), [snap, active]);
      expect(verdict.kind, `active:${active}`).toBe("unknown");
    }
    // CONTROL: the same dead-session shape WITHOUT the csrf refusal is what
    // "inactivity" is for — or `unknown` above is satisfied by a classifier
    // that never says inactivity at all.
    const idle = await page.evaluate((s) => window._classifySignout(
      { active: false, server_started_at: s, reason: null, kicked_by: null }, "Not authenticated",
    ), snap);
    expect(idle.kind, "an ordinary expiry is still reported as inactivity").toBe("inactivity");
  });

  // The 48h instant-join grace lapsing is not idleness, and "sign in again"
  // would fail with email_verification_required — the copy must say so.
  test("a lapsed verification grace is reported as a verification problem", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    const snap = await page.evaluate(() => window._sessionMon.serverStartedAt);
    const verdict = await page.evaluate((s) => window._classifySignout(
      { active: false, server_started_at: s, reason: null, kicked_by: null }, "Account is not verified",
    ), snap);
    expect(verdict.kind).toBe("unverified");
  });

  // With no baseline snapshot a restart is indistinguishable from an expiry, so
  // asserting idleness would reproduce the reported bug whenever /api/config
  // failed or was rate-limited at boot.
  test("with no snapshot, nothing is asserted about why", async ({ page }) => {
    await participantLogin(page);
    const verdict = await page.evaluate(() => {
      const saved = window._sessionMon.serverStartedAt;
      window._sessionMon.serverStartedAt = null;
      const v = window._classifySignout({ active: false, server_started_at: new Date().toISOString(), reason: null, kicked_by: null });
      window._sessionMon.serverStartedAt = saved;
      return v;
    });
    expect(verdict.kind).toBe("unknown");
  });

  // Two 401s in the same batch both clear the interceptor's guard (it is set
  // after an await). A second modal settles the first as Cancel, resolving its
  // await and firing location.href on the spot — the message would flash past.
  test("concurrent 401s announce the sign-out exactly once", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    await page.evaluate(() => window.stopSessionMonitor());
    // Stubbing window.showModal would prove nothing — the module holds its own
    // import binding. Assert the observable outcome instead: the SECOND
    // announcement must not repaint the dialog the first one put up.
    const shown = await page.evaluate(async () => {
      window.S._signoutAnnounced = false;
      window._announceSignout({ kind: 'restart' });          // opens + awaits the modal
      await new Promise(r => setTimeout(r, 150));
      const first = document.getElementById('modal-title')?.textContent || '';
      await window._announceSignout({ kind: 'inactivity' }); // must be a no-op
      await new Promise(r => setTimeout(r, 150));
      return { first, after: document.getElementById('modal-title')?.textContent || '' };
    });
    expect(shown.first, "the first verdict is the one displayed").toMatch(/Server restarted/i);
    expect(shown.after, "a racing second announcement must not repaint the dialog").toBe(shown.first);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.1 — the participant competition list has a stale-response guard
//
// `loadMyCompetitions()` assigned S.myCompetitions unconditionally, so an older
// in-flight /api/my-competitions response could land after a newer write and
// win. The reachable case: an admin removes a participant mid-competition,
// ejectToCompetitionPicker() rebuilds the list from /api/me without that
// competition, and a poll issued BEFORE the removal lands after and puts it
// back — the participant is told they were removed and still offered the
// competition they were removed from. Clicking it 403s.
//
// Driven by DELAYING the poll's response rather than hoping for the race: a
// route interception holds the first /api/my-competitions open, the eject runs
// underneath it, and only then is the stale body released.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.1 — participant competition list stale-response guard", () => {
  test("a poll that lands AFTER the eject cannot re-offer the removed competition", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    // v7.22.7 — OWNS ITS PARTICIPANT, for the same reason as the ejection test
    // above: a STAFF user sees EVERY competition regardless of membership
    // (listParticipantCompetitions' staff branch has no join), so borrowing the
    // seeded alice makes "the removed competition is gone from the picker"
    // untrue through no fault of the guard under test. This test was written in
    // v7.22.1 with the same borrowed fixture and inherited the same flake — it
    // fired once in the six-run verification of the ejection fix, which is
    // exactly how the shared-fixture class propagates.
    const stamp = Date.now();
    const email = `staleguard-${stamp}@company.co`;
    const { api: reg, csrf: regCsrf } = await freshCtx();
    const rr = await registerPost(reg, "/api/register", {
      headers: { "x-csrf-token": regCsrf, "content-type": "application/json" },
      data: {
        firstName: "Stale", lastName: "Guard", nickname: `staleguard_${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      },
    });
    expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    await reg.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants;
    const alice = parts.find(p => p.email === email);
    expect(alice, "the test's own participant must exist").toBeTruthy();
    await sa.post(`/api/admin/participants/${alice.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${alice.id}/approve`, { headers: { "x-csrf-token": csrf } });
    await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [alice.id], competitionIds: [liveComp.id] } });

    try {
      await loginViaApi(page, email, PARTICIPANT_PASS);
      const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": c, "content-type": "application/json" },
        data: { competitionId: liveComp.id },
      });
      await page.goto("/");
      await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });

      // The PRE-REMOVAL body — what a poll issued before the removal would have
      // received. Captured as alice, from the real endpoint, so the response we
      // replay is genuine rather than hand-built.
      const staleBody = await (await page.request.get("/api/my-competitions")).text();
      expect(JSON.parse(staleBody).some(x => x.id === liveComp.id),
        "the pre-removal snapshot must contain the competition").toBe(true);

      // Hold the NEXT /api/my-competitions open and answer it with that stale
      // body. Everything after it is aborted, so the stale response is the only
      // thing that could put the competition back — without that, a later poll
      // re-fetches fresh data and the list self-corrects within a second,
      // which made the first version of this test pass against BOTH mutations.
      let release, calls = 0, servedStale = false;
      const held = new Promise(res => { release = res; });
      await page.route("**/api/my-competitions", async (route) => {
        if (++calls > 1) return route.abort();
        await held;
        servedStale = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: staleBody });
      });

      // Start the poll BEFORE the removal — fire-and-forget, because
      // page.evaluate AWAITS a returned promise and would otherwise block here
      // until the request completes, which is the one thing that cannot happen
      // (v7.21.15). The braces are the whole point.
      await page.evaluate(() => { window.loadMyCompetitions && window.loadMyCompetitions(); });
      await expect.poll(async () => calls, { timeout: 10000, message: "the poll must reach the route" }).toBeGreaterThan(0);

      // …now remove her and eject, all while that request is still in flight.
      const rem = await sa.delete(`/api/admin/competitions/${liveComp.id}/users/${alice.id}`, { headers: { "x-csrf-token": csrf } });
      expect(rem.ok(), `remove failed: ${rem.status()}`).toBeTruthy();
      await page.evaluate(() => window.ejectToCompetitionPicker && window.ejectToCompetitionPicker("removed"));
      await expect(page.locator("#comp-grid")).toBeVisible({ timeout: 10000 });
      expect(await page.evaluate(() => (window.S?.myCompetitions || []).map(x => x.id)),
        "the eject must have rebuilt the list without the removed competition").not.toContain(liveComp.id);

      // Release the stale response. It predates the eject, so it must be
      // discarded — by the sequence the eject claimed.
      release();
      await expect.poll(async () => servedStale, { timeout: 10000 }).toBe(true);
      await page.waitForTimeout(300);   // let the (discarded) handler run to completion

      expect(await page.evaluate(() => (window.S?.myCompetitions || []).map(x => x.id)),
        "a stale in-flight poll must not resurrect the removed competition in the model"
      ).not.toContain(liveComp.id);
      expect(await page.locator(`#comp-grid .comp-card[data-comp-id="${liveComp.id}"]`).count(),
        "…nor re-render its card in the picker").toBe(0);
      // SCOPE, stated rather than implied: this covers the GUARD in
      // loadMyCompetitions (mutation-verified — deleting it fails here). It does
      // NOT isolate the eject's own `S._myCompsFetchSeq++`, because the eject
      // path itself starts another /api/my-competitions, and that call claims a
      // new sequence on its way to being aborted — so the held response is
      // invalidated either way in this arrangement. The bump is kept because it
      // makes the eject's write self-protecting instead of depending on an
      // incidental sibling request that a future refactor could remove.
    } finally {
      // Nothing to restore — the participant is ours. Delete it so the pool
      // does not grow on every run.
      await sa.delete(`/api/admin/participants/${alice.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await sa.dispose();
    }
  });
});
