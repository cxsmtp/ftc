// @ts-check
//
// Split from ui-participant.spec.js in v7.21.37 — it was 118s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Mobile responsive · Version display · History dialog · navigated_away signal · Core Web Vitals · Leaderboard top-20 cap (v6.14.1) · Toast positioning (v6.17.1) · Auth landing UI (v7.3.0) · audit v7.7.35 (T4) — edit-profile dirty-form contract · v7.21.0 — challenge category ribbons
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");
// v8.1.0 — this file inlines its own adminLogin/clickTab/openKebab, but the
// competitions-table narrowing (search box + status-chip fallback) lives in one
// place and is imported rather than becoming a fourth copy. ui-admin-helpers
// requires only `expect`, never ./isolated-test (v7.21.35), so importing it here
// cannot disturb the per-file isolation hook.
const { filterComps, fillBreakGlass, submitLogin } = require("./ui-admin-helpers");

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
  // v7.23.5 — ASSERT the select. It was fire-and-forget, so a refusal (an
  // incomplete profile, a competition that has ended under the test, a 429)
  // left the participant on whatever competition they were already on and every
  // downstream assertion silently described the wrong one. The failure then
  // surfaced far away as a missing row or a stuck nav, naming nothing.
  const sel = await page.request.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: compId },
  });
  expect(sel.ok(), `select-competition for ${email}: ${sel.status()} ${await sel.text()}`).toBeTruthy();
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



// ═══════════════════════════════════════════════════════════════════════════════
// MOBILE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Mobile responsive", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("version visible on mobile", async ({ page }) => {
    await adminLogin(page);
    // The version moved into the account menu (small, above Sign out).
    const ver = (await require("./chrome-helpers").openAccountMenu(page)).locator(".pm-ver");
    await expect(ver).toBeVisible({ timeout: 3000 });
    expect(await ver.textContent()).toMatch(/^v\./);
  });

  test("header visible on mobile", async ({ page }) => {
    await adminLogin(page);
    await expect(page.locator("header").first()).toBeVisible();
  });

  test("kebab menus work", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const kebab = page.locator(".kebab-btn").first();
    if (await kebab.isVisible()) {
      await kebab.click();
      await expect(page.locator("#kebab-portal.open").first()).toBeVisible({ timeout: 3000 }).catch(() => {});
    }
  });
});


test.describe("Version display", () => {
  test("version visible on desktop", async ({ page }) => {
    await adminLogin(page);
    // The version moved into the account menu (small, above Sign out).
    const ver = (await require("./chrome-helpers").openAccountMenu(page)).locator(".pm-ver");
    await expect(ver).toBeVisible({ timeout: 3000 });
    expect(await ver.textContent()).toMatch(/^v\.\d+\.\d+\.\d+$/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY DIALOG
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("History dialog", () => {
  // v7.21.37 — moved INSIDE this describe (its only user) so it travels with
  // the block when the file is split, rather than being left between blocks.
  async function openCompetitionHistory(page, compName) {
    await adminLogin(page);
    await clickTab(page, "Events");
    // v8.1.0 — FILTER FIRST. The competitions table paginates at 30 rows and the
    // grid accumulates a competition per fixture, so an unfiltered lookup finds
    // nothing once the file is deep enough — the v7.15.29 class, in the
    // `tr:has-text()` spelling the v7.17.2 scanner cannot see (it matches only
    // the `{hasText}` OPTION form, and v7.21.17 deliberately did not widen it).
    // `filterComps` also clears the status chips on a miss, so an ENDED fixture
    // is still findable.
    await filterComps(page, compName);
    const row = page.locator(`#admin-comp-body tr:has-text('${compName}')`).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    await expect(page.locator("#hist-overlay")).toBeVisible({ timeout: 5000 });
  }

  test("opens for competitions with sortable, searchable table", async ({ page }) => {
    await openCompetitionHistory(page, "Test Live");
    // Headers exist and are sortable
    await expect(page.locator("#hist-overlay th.sortable:has-text('Type')")).toBeVisible();
    await expect(page.locator("#hist-overlay th.sortable:has-text('When')")).toBeVisible();
    await expect(page.locator("#hist-overlay th.sortable:has-text('By')")).toBeVisible();
    // Default: When column shows DESC arrow
    await expect(page.locator("#sort-hist-when-icon")).toHaveText(" ▼");
    // Search input present
    await expect(page.locator("#hist-search")).toBeVisible();
    // Pagination present with correct options
    const pag = page.locator("#hist-pagination");
    await expect(pag).toBeVisible();
    const sizes = await pag.locator("select option").allTextContents();
    expect(sizes).toEqual(["30 / page", "50 / page", "100 / page", "200 / page"]);
    await page.locator("#hist-overlay button:has-text('Close')").click();
  });

  test("clicking a column header toggles sort direction", async ({ page }) => {
    await openCompetitionHistory(page, "Test Live");
    await page.locator("#hist-overlay th.sortable:has-text('Type')").click();
    await expect(page.locator("#sort-hist-type-icon")).toHaveText(" ▲");
    await page.locator("#hist-overlay th.sortable:has-text('Type')").click();
    await expect(page.locator("#sort-hist-type-icon")).toHaveText(" ▼");
    await page.locator("#hist-overlay button:has-text('Close')").click();
  });

  test("search filters rows", async ({ page }) => {
    await openCompetitionHistory(page, "Test Live");
    const rowsBefore = await page.locator("#hist-body tr").count();
    expect(rowsBefore).toBeGreaterThan(0);
    // Search for a string unlikely to match anything — toContainText auto-retries.
    await page.fill("#hist-search", "zzzzz-no-match");
    await expect(page.locator("#hist-body")).toContainText(/No history entries match/, { timeout: 3000 });
    // Clear restores the full row set — wait for the empty-state message to go away.
    await page.locator("#hist-search-clear").click();
    await expect(page.locator("#hist-body")).not.toContainText(/No history entries match/, { timeout: 3000 });
    const rowsAfter = await page.locator("#hist-body tr").count();
    expect(rowsAfter).toEqual(rowsBefore);
    await page.locator("#hist-overlay button:has-text('Close')").click();
  });

  test("opens for participants from kebab", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    const row = page.locator("#admin-participants-body tr").first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    await expect(page.locator("#hist-overlay")).toBeVisible({ timeout: 5000 });
    // Close
    await page.locator("#hist-overlay button:has-text('Close')").click();
    await expect(page.locator("#hist-overlay")).toHaveCount(0);
  });

  test("challenge history has Restore column and before→after diffs", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const row = page.locator("#admin-task-body tr").first();
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    await expect(page.locator("#hist-overlay")).toBeVisible({ timeout: 5000 });
    // Action column header is present (task history only)
    await expect(page.locator("#hist-overlay th:has-text('Action')")).toBeVisible();
    // Current badge shown on the most recent version
    await expect(page.locator("#hist-body .badge:has-text('current')").first()).toBeVisible();
    await page.locator("#hist-overlay button:has-text('Close')").click();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Challenge navigated_away — client fires on SPA nav
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("navigated_away signal", () => {
  test("opening a task then clicking a different nav section writes a navigated_away row", async ({ page }) => {
    // Create a dedicated task + register a fresh participant so this test is
    // fully isolated from shared seed state. Avoids collisions with Alice's
    // existing challenge_events / hint_reveals.
    const stamp = Date.now();
    const uniqTitle = "NavAway-" + stamp;
    const email = `navaway-${stamp}@test.co`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tr = await sa.post("/api/admin/tasks", { headers: h, data: {
      title: uniqTitle, description: "<p>Open me and leave.</p>",
      difficulty: "easy", answer_type: "text", correct_answer: "x",
      explanation: "—", status: "published",
    }});
    const taskId = (await tr.json()).id;
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [liveComp.id] } });
    // Register + verify + approve + set password for fresh participant
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: {
        firstName: "Nav", lastName: "Away", nickname: `navaway_${stamp}`,
        company: "X", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York", email,
      },
    });
    await anon.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants;
    const me = parts.find(p => p.email === email);
    expect(me).toBeTruthy();
    await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
    await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
    // Asserted: the assign endpoint SILENTLY SKIPS staff / benchmark / blocked /
    // unapproved users, so an unchecked call turns a skipped precondition into a
    // missing challenge card fifty lines later (the fixture-checklist rule).
    const _asg = await sa.post("/api/admin/competitions/assign", { headers: h, data: {
      userIds: [me.id], competitionIds: [liveComp.id],
    }});
    expect(_asg.ok(), `assign: ${await _asg.text()}`).toBeTruthy();
    await sa.dispose();

    // Drive the UI as the new participant. Pre-select the live competition via
    // the API so the SPA skips the comp picker on load (mirrors Alice's seeded
    // active_competition_id state that the helper-login pathway relies on).
    await loginViaApi(page, email, PARTICIPANT_PASS);
    const meCsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": meCsrf, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
    // The nav button becomes visible partway through boot, so this click can land
    // BEFORE boot's own showMain('tasks-page') + loadTasks() — which then
    // re-renders the grid underneath it. Waiting straight on the card gave that
    // whole sequence a 5 s budget and failed under load with "element(s) not
    // found", naming nothing. Settle on the PAGE, then on a populated GRID (which
    // cannot be true before loadTasks has rendered), then on the specific card.
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });
    await expect.poll(() => page.locator("#task-grid [data-task-id]").count(), { timeout: 15000 })
      .toBeGreaterThan(0);
    const taskCard = page.locator(`[data-task-id="${taskId}"]`).first();
    await expect(taskCard).toBeVisible({ timeout: 15000 });
    await taskCard.click();
    // v8.3.1 — 15 s, matching every other wait in this test. (Widening these was
    // NOT the fix: it flaked again afterwards. The cause is the deferred write
    // asserted at the end of this test — see there. They stay widened because a
    // sub-15 s budget on a loaded box is wrong anyway.)
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
    // Navigate away to Leaderboard — should trigger fireNavigatedAway('spa_nav')
    const lbBtn = page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first();
    await lbBtn.click();
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 15000 });

    // v8.3.1 — THIS is what was flaking, and it is a documented class rather than
    // a mystery: `challenge_events` rows on this path are written POST-COMMIT via
    // a `setImmediate` drain, and CLAUDE.md's own rule is "never read them once
    // immediately after the response; POLL". Five seconds is not a poll cap for a
    // deferred write on a box running twelve workers and twelve browsers — the
    // loaded event loop lags that tick. Widening the two page waits above did not
    // help, which is what ruled them out.
    //
    // It also had NO message, so a failure read "Received: 0" and named nothing:
    // equally true of a row that never arrived, a row written against a different
    // task, and a nav that never fired. The message now separates those.
    await expect.poll(async () => {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return db.prepare(
          "SELECT COUNT(*) as c FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='navigated_away'"
        ).get(me.id, taskId).c;
      } finally { db.close(); }
    }, {
      timeout: 15000,
      intervals: [50, 100, 200, 400, 800, 1500],
      message: (() => {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try {
          const anyForUser = db.prepare("SELECT COUNT(*) c FROM challenge_events WHERE user_id=?").get(me.id).c;
          return `no navigated_away row for (user=${me.id}, task=${taskId}) — this user has ${anyForUser} challenge_events rows in total, so 0 there means the nav never fired and >0 means it fired against something else`;
        } finally { db.close(); }
      })(),
    }).toBeGreaterThan(0);
  });

  test("opening a task then clicking Logout writes a navigated_away row with via=logout", async ({ page }) => {
    // Same isolated-user pattern as the test above.
    const stamp = Date.now();
    const uniqTitle = "NavAwayLogout-" + stamp;
    const email = `navaway-logout-${stamp}@test.co`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tr = await sa.post("/api/admin/tasks", { headers: h, data: {
      title: uniqTitle, description: "<p>Open me and logout.</p>",
      difficulty: "easy", answer_type: "text", correct_answer: "x",
      explanation: "—", status: "published",
    }});
    const taskId = (await tr.json()).id;
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [liveComp.id] } });
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: {
        firstName: "Nav", lastName: "Logout", nickname: `navout_${stamp}`,
        company: "X", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York", email,
      },
    });
    await anon.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants;
    const me = parts.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
    await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
    await sa.post("/api/admin/competitions/assign", { headers: h, data: {
      userIds: [me.id], competitionIds: [liveComp.id],
    }});
    await sa.dispose();

    await loginViaApi(page, email, PARTICIPANT_PASS);
    const meCsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": meCsrf, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
    // The nav button becomes visible partway through boot, so this click can land
    // BEFORE boot's own showMain('tasks-page') + loadTasks() — which then
    // re-renders the grid underneath it. Waiting straight on the card gave that
    // whole sequence a 5 s budget and failed under load with "element(s) not
    // found", naming nothing. Settle on the PAGE, then on a populated GRID (which
    // cannot be true before loadTasks has rendered), then on the specific card.
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });
    await expect.poll(() => page.locator("#task-grid [data-task-id]").count(), { timeout: 15000 })
      .toBeGreaterThan(0);
    const taskCard = page.locator(`[data-task-id="${taskId}"]`).first();
    await expect(taskCard).toBeVisible({ timeout: 15000 });
    await taskCard.click();
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 5000 });
    // Sign out while still on task-detail-page, through the account menu (the
    // one Sign out the header offers).
    await page.locator("#profile-menu-btn").click();
    await page.locator("[data-action='do-logout']:visible").first().click();
    // Wait for the post-logout reload to land on the login screen.
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 10000 });

    await expect.poll(async () => {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return db.prepare(
          "SELECT details FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='navigated_away' ORDER BY occurred_at DESC LIMIT 1"
        ).get(me.id, taskId);
      } finally { db.close(); }
    }, { timeout: 5000 }).toBeTruthy();
    // Confirm via=logout was recorded in details.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare(
      "SELECT details FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='navigated_away' ORDER BY occurred_at DESC LIMIT 1"
    ).get(me.id, taskId);
    db.close();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.details).via).toBe("logout");
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Core Web Vitals — CLS regression gate (v6.10.41)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Measures Cumulative Layout Shift on the logged-in participant's first
// render under emulated Slow-3G network. Gates at the Core Web Vitals
// "Good" threshold of 0.1. Background: the v6.10.34 `defer` rewrite
// shipped a CLS 0.97 regression that only surfaced on the next
// full-scale perf run (browser probe over real WAN). This test pins a
// ceiling so any future regression pushing CLS past "Needs improvement"
// (>0.1) territory fails loudly in the default suite.
//
// Why network emulation: on localhost everything loads in <100 ms so
// layout shifts either don't fire (observer attaches after they've
// happened) or fall inside the 500 ms `hadRecentInput` window (excluded
// from CLS by spec). Slow-3G throttling (500 ms latency, 400 kbps)
// matches what WAN participants actually experience and lets the
// observer catch the same shifts the perf probe reports.
//
// Why API-login instead of the UI form: the browser-driven login
// submits with the `csrfToken` module var set by app.js's bootstrap
// IIFE (`Promise.all([loadCsrfToken(), loadPlatformName()])`). Under
// throttle, a fast Playwright click can race ahead of that async chain
// and submit with an empty token → 403, flaky test. API-login via
// `page.request.post` seeds the session cookie before the browser
// navigates, so the flow we measure is the logged-in home render —
// which is where buildMainNav runs from bootstrap and produces the
// exact nav-growth shift the v6.10.34 regression manifested as.
//
// Sensitivity: with the v6.10.40 fix the gate measures ~0.009 locally;
// without it, ~0.019. Both under the 0.1 gate. The gate catches Poor-
// range regressions (what the v6.10.34 bug looked like in production,
// 0.97) reliably — it won't catch sub-0.1 drift. Tighter numerical
// diffing would be too flaky at WORKERS=8 contention.
//
// PER-SHIFT DETAIL IS ONE LINE AWAY, and it lives here rather than in a
// separate file. The PerformanceObserver installed below already receives
// every layout-shift entry; logging `e.sources` inside it names the DOM
// node that moved and by how much. The standalone `_cls-probe` spec that
// used to carry that was removed in v8.3.10 — it had drifted out of use,
// and a failure message pointing at a file that does not exist is worse
// than one that points at nothing (the FROZEN_REMEDY rule).
test.describe("Core Web Vitals", () => {
  // A KNOWN CI-ONLY FLAKE, left alone until it reproduces: when it fails, read
  // the breakdown in the failure message (the node that moved, the page it
  // landed on). Never wrap the measurement in a retry-until-quiet loop and never
  // re-point `alice` at another fixture: both hide the shift this gate exists to
  // catch.
  const CLS_GATE = 0.1; // "Good" per web.dev/cls; "Needs improvement" > 0.1; "Poor" > 0.25.

  test("v6.10.41: CLS under Good threshold on logged-in participant home render", async ({ page, context }) => {
    // Throttled network + logged-in home render cannot always fit in the
    // default 60-s per-test timeout under CPU contention. Bump to 120 s.
    test.setTimeout(120_000);

    // API-login to set the session cookie in the page context before
    // the browser-driven navigation. Bypassing the UI login form dodges
    // a CSRF micro-race under throttle (bootstrap's async loadCsrfToken
    // hasn't finished setting the module-level token when a fast
    // Playwright click submits the form). The regression we want to
    // catch — the v6.10.34 nav-growth shift — fires during the
    // logged-in page's FIRST render anyway, because buildMainNav runs
    // from app.js's bootstrap AFTER first paint even on a direct
    // logged-in navigation. API-login + page.goto reproduces that
    // shift without the UI click race.
    const csrfRes = await page.request.get(`${BASE}/api/csrf-token`);
    const { csrfToken } = await csrfRes.json();
    const loginRes = await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": csrfToken, "content-type": "application/json" }, { base: `${BASE}` });
    expect(loginRes.ok(), `pre-test API login failed: ${loginRes.status()}`).toBeTruthy();

    const client = await context.newCDPSession(page);
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 500,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    });
    // v8.3.14 — THE BREAKDOWN IS CAPTURED ALWAYS, not left as an instruction.
    // This gate went 0.1062 once under WORKERS=12 and the message said only that
    // 0.1062 > 0.1, telling a human to go and add `e.sources` by hand — which is
    // a diagnostic that does not exist at the moment it is needed, on a failure
    // that does not reproduce. MEASURED in isolation afterwards: 0.0098 landing
    // on `tasks-page` and 0.0297 landing on the picker, i.e. 3-10x of headroom
    // in BOTH of the states the shared `alice` can be in — so neither fixture
    // state explains it and re-pointing the fixture would be a blind third
    // widening (v7.21.3). What the next occurrence needs is the NODE, so the
    // failure now names it. Note the four `login-*` entries that show up even on
    // a clean run: `#login-page` carries `active` in the shell and is swapped out
    // once boot resolves, which v7.15.5 examined and deliberately left alone for
    // an authenticated direct navigation — under contention that window is longer,
    // which is the leading hypothesis and is NOT claimed as the mechanism.
    await page.addInitScript(() => {
      window._cls = 0;
      window._clsSrc = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window._cls += e.value;
          const nodes = (e.sources || []).map((s) => {
            const n = s.node;
            if (!n) return "(detached)";
            return n.id ? "#" + n.id : (n.tagName || "?") + "." + String(n.className || "").split(" ")[0];
          });
          window._clsSrc.push({ v: +e.value.toFixed(4), nodes: nodes.length ? nodes : ["(none)"] });
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    // The post-v6.10.34 regression surfaces when buildMainNav populates
    // the empty #main-nav — wait for a nav button so that growth event
    // is guaranteed to have fired before we measure.
    await page.waitForSelector("#main-nav .nav-btn", { timeout: 60000 });
    // Settle beat for any late-arriving shifts (fonts / late asset).
    await page.waitForTimeout(1000);

    const { cls, landed, shifts } = await page.evaluate(() => ({
      cls: window._cls,
      landed: (document.querySelector(".page.active") || {}).id || "(none)",
      shifts: window._clsSrc.slice().sort((a, b) => b.v - a.v).slice(0, 10),
    }));
    // WHICH PAGE was rendered is half the answer: the picker and the challenge
    // list are different DOMs with different shift budgets, and `alice` is shared,
    // so the landing page is not fixed by this test.
    const breakdown = shifts.map((s) => `${s.v} ${s.nodes.join("+")}`).join("; ");
    expect(cls, `CLS ${cls.toFixed(4)} exceeds Core Web Vitals "Good" threshold of ${CLS_GATE}. Landed on "${landed}". Largest shifts: ${breakdown || "(none recorded)"}`).toBeLessThan(CLS_GATE);
  });

  // v8.3.16 — WHAT THE BREAKDOWN ABOVE ACTUALLY FOUND, pinned so it cannot come
  // back. The test above went red at CLS 0.1548 under WORKERS=12 and named the
  // node: `0.1407 #app-footer+#comp-join-code-box`. That is NOT the login-node
  // hypothesis v8.3.14 recorded — it is `#comp-grid` rendering EMPTY and then
  // filling, pushing everything below it down by the full height of the card
  // list. The join-code box is a tall bordered block, so it carried most of the
  // impact fraction.
  //
  // MEASURED on the same 400 kbps / 500 ms link the test above uses, by event
  // count, box BELOW the grid → box ABOVE it:
  //     10 events   0.094 → 0.045
  //     22 events   0.160 → 0.093
  // So it was past the "Good" threshold for any participant with an ordinary
  // number of events, and it presented as an intermittent test failure only
  // because `alice` is shared and accumulates competitions as a run proceeds.
  //
  // This is a STRUCTURAL lock rather than another CLS measurement: the numeric
  // gate above is the behavioural half and is subject to the fixture's event
  // count, whereas the ordering is the property that actually fixes it. Anything
  // tall placed below a container that grows from empty reintroduces this.
  test("v8.3.16: the join-code box sits ABOVE the competition grid (CLS)", async ({ page }) => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const order = await page.evaluate(() => {
      const box = document.getElementById("comp-join-code-box");
      const grid = document.getElementById("comp-grid");
      if (!box || !grid) return { box: !!box, grid: !!grid };
      // DOCUMENT_POSITION_FOLLOWING (4) on box→grid means the grid comes after.
      return { box: true, grid: true, boxBeforeGrid: !!(box.compareDocumentPosition(grid) & 4) };
    });
    expect(order.box, "#comp-join-code-box must exist").toBe(true);
    expect(order.grid, "#comp-grid must exist").toBe(true);
    expect(order.boxBeforeGrid,
      "#comp-join-code-box must precede #comp-grid in the document. The grid renders EMPTY and then " +
      "fills, so anything tall below it is pushed by the whole card list — measured at CLS 0.160 for a " +
      "participant with 22 events, against a Core Web Vitals 'Good' threshold of 0.1"
    ).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.14.1 — leaderboard top-20 cap (UI regression).
// ═══════════════════════════════════════════════════════════════════════════════
// Two cases the participant SPA must handle correctly:
//   • caller is inside the top 20 → table contains them with the `me`
//     CSS class; no separate "your placement" banner is shown.
//   • caller is outside the top 20 → table has 20 rows (none of which
//     are the caller); a banner below the table renders the caller's
//     row with their true rank.
//
// Both tests are part of the always-on regression cycle (this file is
// included by `npm test`), not behind the screenshot capture flag.
test.describe("Leaderboard top-20 cap (v6.14.1)", () => {
  test("caller inside top 20 (seed comp): row in table with .me class, no banner", async ({ page }) => {
    // The seed has 3 ranked participants. Alice is one of them — she's
    // in the top 20 trivially. Verify the table shows her row with the
    // .me class and #lb-me-banner is empty.
    // v7.22.0 — SELECT the competition explicitly instead of relying on alice's
    // ambient active_competition_id.
    //
    // `#nav-leaderboard` ships `display:none` and is revealed by
    // updateParticipantNav() only once a competition context resolves to
    // live/ended (v7.17.3). So when boot routes to the PICKER — which it does
    // whenever a sibling test has moved alice's active competition, and this is
    // a 26-test file sharing one seeded participant — that button never appears
    // and the wait dies at 10 s naming only the locator. That is the v7.21.1
    // rule: a long wait that ends in nothing means the wrong VIEW, not a slow
    // one. Selecting first removes the picker branch entirely, and the test's
    // premise (alice is on the seed board) is unchanged.
    // v7.23.5 — OWN THE PARTICIPANT. The v7.22.0 fix (select explicitly rather
    // than inherit alice's ambient competition) was necessary and not
    // sufficient: it still authenticated as the shared seeded alice in a
    // 26-test file that nulls her active competition, re-passwords fixtures and
    // moves her between competitions. The self-explaining diagnostic added at
    // v7.23.2 is what finally named it —
    //
    //     the board never settled into a frame containing alice's row;
    //     last frame: {"rows":5,"meRows":0,"banner":""}
    //
    // Five rows and alice on NONE of them, with an empty banner too, i.e. she
    // was absent from the payload rather than merely mis-rendered. And the
    // select-competition POST was never checked, so a refused select fell back
    // to whatever competition she was already on and the test asserted against a
    // board it had not asked for. That is the v7.22.7 rule: a test that does not
    // assert its preconditions reports the wrong thing when they break.
    //
    // The premise here is only "the caller is one of ≤20 ranked players", which
    // needs A participant, not alice. A freshly-registered one is on the board
    // as soon as select-competition stamps competition_users.login_time (the
    // solve-clock anchor, v7.21.3 — without it a participant is excluded from
    // the board entirely, fixture-checklist item 5).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // The endpoint answers with a bare array; `.competitions` is the shape other
    // admin lists use, so accept either rather than pin the one that happens to
    // ship today.
    const compsBody = await (await sa.get("/api/admin/competitions")).json();
    const live = (compsBody.competitions || compsBody).find(c => c.name === "Test Live");
    expect(live, "the seed must provide the live competition").toBeTruthy();
    const me = await createAssignedParticipant(sa, h, live.id);
    await sa.dispose();

    // enterCompAsParticipant asserts the select and waits on the Challenges nav,
    // which only appears once a live competition is actually in context — so a
    // refused precondition now fails AS a precondition instead of silently
    // redirecting this assertion at another competition's board.
    await enterCompAsParticipant(page, me.email, live.id);
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 5000 });
    // Wait for #lb-body to render at least one row (board fetch resolved).
    await page.locator("#lb-body tr:not([hidden])").first().waitFor({ state: "visible", timeout: 5000 });

    // v7.23.2 — sample the row set and the banner in ONE frame, and poll for a
    // SELF-CONSISTENT one.
    //
    // These were two separate awaits, and `renderLeaderboard` rewrites #lb-body
    // and #lb-me-banner together on a 15 s poll — so the pair could be read
    // either side of a repaint and the test asserted across a gap that no
    // amount of waiting closes. It surfaced as an intermittent
    // "#lb-me-banner must be empty" with the caller's row demonstrably present.
    // This is the v7.21.1 rule ("reading a count and the thing it counts as two
    // awaits asserts across a re-render") applied to the participant board;
    // re-reading after the poll would reintroduce exactly the gap it closes, so
    // every assertion below runs against the captured snapshot.
    // A frame is only usable once the board has painted rows AND the caller's own
    // row is in it — otherwise "the banner is empty" would be satisfied by a board
    // that simply had not rendered them yet, which is the vacuous reading. The
    // captured frame is what every assertion below runs against; re-reading
    // after the wait would put the gap straight back.
    let snap = null, last = null;
    for (let i = 0; i < 30 && !snap; i++) {
      last = await page.evaluate(() => {
        const body = document.getElementById("lb-body");
        const banner = document.getElementById("lb-me-banner");
        if (!body || !banner) return null;
        return {
          rows: body.querySelectorAll("tr").length,
          meRows: body.querySelectorAll("tr.me").length,
          banner: (banner.innerHTML || "").trim(),
        };
      });
      if (last && last.rows > 0 && last.meRows === 1) snap = last;
      else await page.waitForTimeout(400);
    }
    expect(snap, `the board never settled into a frame containing the caller's own row (${me.email}); last frame: ${JSON.stringify(last)}`).toBeTruthy();
    expect(snap.rows, "the board must have rendered rows").toBeGreaterThan(0);
    expect(snap.meRows, "the caller's row must be marked .me when they are in the top 20").toBe(1);
    expect(snap.banner, "#lb-me-banner must be empty when the caller is in the top 20").toBe("");
  });

  test("caller outside top 20: table has 20 rows, banner shows the caller's true rank", async ({ page }) => {
    // Build a fresh comp with 25 dummy participants (DB-direct) + Alice
    // with an earlier login_time so she ranks LAST. Same shape as the
    // API regression-lock above; the UI assertions piggy-back on the
    // server's truncation contract.
    const Database = require("better-sqlite3");
    const tag = Math.random().toString(36).slice(2, 8);
    const compName = `UI-Top20-${tag}`;
    let compId;
    const dummyIds = [];
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    try {
      // Create the comp.
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: compName,
          start_time: new Date(Date.now() - 60_000).toISOString(),
          duration_minutes: 120,
        },
      });
      compId = (await compR.json()).competition.id;
      // v7.23.11 — OWN THE PARTICIPANT. This borrowed the shared seeded alice,
      // whose password, tags and enrolment other tests in this 30-test file move
      // about. The symptom was a 3 s timeout on the placement banner with no
      // explanation — and a `staff` tag left on her by a sibling is enough to
      // cause exactly it, because staff are excluded from EVERY leaderboard
      // (v7.22.7), so there is no `me` row and therefore no banner. Its sibling
      // "caller inside top 20" was converted for the same reason a release ago;
      // this is the propagation that lesson predicts — the test that failed is
      // rarely the only one exposed.
      const me = await createAssignedParticipant(sa, saJsonH, null);
      const aliceId = me.id;
      // DB-direct: 25 dummy users + 25 cu rows + Alice cu row.
      const dbW = new Database(TEST_DB_PATH);
      const insertUser = dbW.prepare(
        "INSERT INTO users (id, first_name, last_name, nickname, email, avatar, verified, approved, password_hash, created_at) " +
        "VALUES (?,?,?,?,?,?,1,1,?,?)"
      );
      const insertCU = dbW.prepare(
        "INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, login_time) VALUES (?,?,?,?,?)"
      );
      const dummyLT = "2026-04-01T10:00:00.000Z";
      const aliceLT = "2026-03-01T10:00:00.000Z";
      const txn = dbW.transaction(() => {
        for (let i = 0; i < 25; i++) {
          const id = `uitop-${tag}-${String(i).padStart(2, "0")}`;
          dummyIds.push(id);
          insertUser.run(
            id, "Cap", `UI${i}`, `uitop_${tag}_${i}`,
            `uitop-${tag}-${i}@cust.test`, "default1",
            "$2b$10$dummyhashdoesnotneedtoworkforthistest",
            new Date(Date.now() - 90 * 60_000).toISOString()
          );
          insertCU.run(compId, id, "test-system", dummyLT, dummyLT);
        }
        insertCU.run(compId, aliceId, "test-system", aliceLT, aliceLT);
      });
      txn();
      dbW.close();
      // Drive the SPA: log in as Alice, select the new comp, navigate to
      // the Leaderboard, assert the cap + banner.
      await loginViaApi(page, me.email, PARTICIPANT_PASS);
      const aliceCsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const selR = await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
        data: { competitionId: compId },
      });
      expect(selR.ok(), `select-competition: ${selR.status()}`).toBeTruthy();
      await page.goto("/");
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().waitFor({ state: "visible", timeout: 10000 });
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
      await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 5000 });
      // Wait until the table fills up. The page polls /api/leaderboard so
      // the first render should have all 20 rows.
      await page.waitForFunction(() => document.querySelectorAll("#lb-body tr").length === 20, null, { timeout: 8000 });
      // Body has exactly 20 rows.
      const bodyRows = await page.locator("#lb-body tr").count();
      expect(bodyRows, "table must show exactly 20 rows when the comp has > 20 ranked participants").toBe(20);
      // None of those 20 rows is Alice.
      const meInBody = await page.locator("#lb-body tr.me").count();
      expect(meInBody, "the caller must NOT be in the top-20 body when they are rank 26").toBe(0);
      // Banner is non-empty and shows her rank.
      const banner = page.locator("#lb-me-banner .lb-me-card");
      await banner.waitFor({ state: "visible", timeout: 3000 });
      const bannerRank = await banner.locator("tr.me td").first().innerText();
      // The first cell either shows a medal emoji (only for ranks 1–3)
      // or "#26" for ranks ≥ 4. Alice should be #26 here.
      expect(bannerRank.replace(/\s+/g, "")).toContain("#26");
      // Out-of count line should mention 26 ranked.
      // v6.14.2 — no participant-count disclosure. The banner used to
      // render "Out of N ranked participants" as a subtitle; that's
      // been removed because it leaked exactly the count the
      // competition-fairness invariant says participants must NOT see.
      // The banner's body should now contain ONLY the "Your placement"
      // label + the row; no subtle count text.
      const subtleCount = await page.locator("#lb-me-banner .lb-me-subtle").count();
      expect(subtleCount, "the 'Out of N ranked' subtitle must be gone").toBe(0);
      // Defence-in-depth: scan the banner text for any digit-cluster
      // larger than the visible me-rank; "26" appears in the rank cell
      // already, but a second 26 (or any number ≥ board_limit + 1)
      // would imply a count is leaking elsewhere.
      // The time cell ("4 m 05 s") is the caller's own clock, not a count; it
      // is left out so its digits are not read as a leak.
      const bannerText = (await page.locator("#lb-me-banner").evaluate((el) => {
        const c = el.cloneNode(true);
        c.querySelectorAll(".lb-time-cell").forEach((t) => t.remove());
        return c.innerText || c.textContent || "";
      })).trim();
      const digits = bannerText.match(/\b\d+\b/g) || [];
      // Acceptable digits: the rank "#26", and `me.score` (likely 0
      // for a freshly-built scenario). Anything else is a leak.
      expect(digits.length).toBeLessThanOrEqual(2);
    } finally {
      // Cleanup. Reset Alice's session-side competition_id to avoid
      // bleed-through into other tests (login auto-resume) and drop
      // the synthetic users + comp.
      const dbW2 = new Database(TEST_DB_PATH);
      try {
        // v7.23.11 — this used to null alice's active_competition_id, because the
        // test drove her and would otherwise have left her auto-resuming into a
        // deleted competition. It owns its participant now, who has no
        // downstream readers, so the cleanup cannot be forgotten or get it
        // wrong — there is none. (Same simplification the sibling test got.)
        if (compId) {
          dbW2.prepare("DELETE FROM competition_users WHERE competition_id=?").run(compId);
          dbW2.prepare("DELETE FROM competitions WHERE id=?").run(compId);
        }
        for (const id of dummyIds) {
          dbW2.prepare("DELETE FROM users WHERE id=?").run(id);
        }
      } finally { dbW2.close(); }
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Toast positioning (v6.17.1, re-pointed v7.23.5)
// Regression lock: a toast is anchored to the BOTTOM of the viewport, and on a
// narrow (≤600px) phone it keeps its floor off the screen edge.
//
// These asserted `el.style.bottom` until v7.23.5 moved placement off per-toast
// inline arithmetic and onto the #toast-stack flex column — the arithmetic was
// the defect (the 4th toast landed exactly on the 3rd). So the assertion is now
// the RENDERED GEOMETRY, which is the guarantee either implementation owes and
// which no future placement mechanism can satisfy by accident.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Toast positioning (v6.17.1)", () => {
  // Distance from the toast's bottom edge to the bottom of the viewport, plus
  // where the toast's own top sits.
  //
  // BOTH are needed, and a mutation proved it: `clearance >= floor` alone is a
  // ONE-SIDED bound, satisfied by a toast pinned to the TOP of the viewport —
  // top-anchoring the stack passed the first version of this test. The second
  // assertion (the toast is in the lower half) is what makes it about anchoring.
  //
  // It also WAITS FOR THE ENTRY ANIMATION, which is not incidental: `toast-in`
  // is `translateX(20px)` over 250ms on cubic-bezier(0.34,1.56,0.64,1) — a
  // control point above 1 OVERSHOOTS, so mid-flight the toast sits further right
  // than where it lands. Measured 375.98 against a 375px viewport, failing 2 runs
  // in 3. getBoundingClientRect() reports the animated box; the old assertions
  // read an inline style property, which is set synchronously and never raced.
  const geometry = (page) =>
    page.locator(".toast").first().evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished)).catch(() => {});
      const r = el.getBoundingClientRect();
      return {
        clearance: Math.round(window.innerHeight - r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        midline: Math.round(window.innerHeight / 2),
        vw: Math.round(window.innerWidth),
      };
    });

  test("desktop: a toast is anchored to the bottom-right of the viewport", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page", { timeout: 5000 });
    await page.evaluate(() => window.showToast("desktop test", "info"));
    const toast = page.locator(".toast").first();
    await toast.waitFor({ state: "visible", timeout: 3000 });

    const g = await geometry(page);
    expect(g.clearance, "the toast must keep its 24px floor off the viewport bottom")
      .toBeGreaterThanOrEqual(24);
    expect(g.top, `the toast must be BOTTOM-anchored, not top-anchored: ${JSON.stringify(g)}`)
      .toBeGreaterThan(g.midline);
    // ...and on the right, which the vertical geometry alone would not establish.
    expect(g.right, `the toast must stay inside the viewport: ${JSON.stringify(g)}`)
      .toBeLessThanOrEqual(g.vw);
    expect(g.left, `a right-anchored toast starts past the mid-line: ${JSON.stringify(g)}`)
      .toBeGreaterThan(g.vw / 2);
  });

  test.describe("mobile (375×812)", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("mobile: a toast sits clear of the screen edge, with no bottom bar over it", async ({ page }) => {
      await page.goto("/");
      await page.waitForSelector("#login-page", { timeout: 5000 });
      await page.evaluate(() => window.showToast("mobile test", "info"));
      const toast = page.locator(".toast").first();
      await toast.waitFor({ state: "visible", timeout: 3000 });

      // There is no bottom tab bar any more (the participant bar is a row of the
      // sticky header), so the phone toast keeps only its own floor off the
      // screen edge. Asserted with a CONTROL that nothing is fixed at the bottom
      // to cover it: a build that brought the bar back must also lift the toast.
      const g = await geometry(page);
      expect(g.clearance, "the toast keeps its 12px floor off the viewport bottom")
        .toBeGreaterThanOrEqual(12);
      expect(await page.evaluate(() => {
        const n = document.getElementById("main-nav");
        return !!n && n.getClientRects().length > 0 && getComputedStyle(n).position === "fixed";
      }), "CONTROL: no fixed bottom bar is painted that the toast would have to clear").toBe(false);
      expect(g.top, `the toast must be BOTTOM-anchored, not top-anchored: ${JSON.stringify(g)}`)
        .toBeGreaterThan(g.midline);
      expect(g.left, `the phone toast is inset from the left edge: ${JSON.stringify(g)}`)
        .toBeGreaterThanOrEqual(0);
      expect(g.right, `the phone toast stays inside the viewport: ${JSON.stringify(g)}`)
        .toBeLessThanOrEqual(g.vw);
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Auth landing UI (v7.3.0) — login LinkedIn + Sign-Up button; /join → sign-up
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Auth landing UI (v7.3.0)", () => {


  test("anonymous /join/<token> lands on the email entry screen with the event on the card; URL stays at root, token not leaked", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const start = new Date(Date.now() + 3600_000).toISOString(); // upcoming
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: { name: `Join-UI-${Date.now()}`, start_time: start, duration_minutes: 120 } });
    const compId = (await cr.json()).competition.id;
    const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
    await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { self_enroll_enabled: true, expectedUpdatedAt: rv.updated_at } });
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(rv.token)}`);
    // Email first: one entry screen for everyone, the event named on the card
    // (the sign-up form comes only after an address proof is redeemed).
    await page.waitForSelector("#login-page.active", { timeout: 6000 });
    await expect(page.locator("#join-banner")).toBeVisible();
    await expect(page.locator("#join-banner")).toContainText(/joining/i);
    await expect(page.locator("#join-banner-info")).toContainText("Join-UI-");
    await expect(page.locator("#register-page.active"), "no sign-up form before the proof").toHaveCount(0);
    // Token secrecy: URL stripped to root, token gone from the URL.
    expect(new URL(page.url()).pathname).toBe("/");
    expect(page.url()).not.toContain(rv.token);

    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    await sa2.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": c2 } }).catch(() => {});
    await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": c2 } }).catch(() => {});
    await sa2.dispose();
  });

  test("anonymous /join/<token> for a NOT-yet-enabled link still lands on the email entry screen, naming no event", async ({ page }) => {
    // Email first, the /join landing is the one entry screen for everyone. If
    // self-enrollment isn't enabled yet (the link can't be previewed), the visitor
    // still gets that screen — never a scary "invalid" toast — and no event name
    // is shown (there is no competition to show).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: { name: `Join-Disabled-${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } });
    const compId = (await cr.json()).competition.id;
    const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
    // NOTE: deliberately do NOT enable self-enrollment — the link is inert.
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(rv.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 6000 });
    // No previewable competition, so no event name; the URL is stripped to root.
    await expect(page.locator("#join-banner-info")).not.toContainText("Join-Disabled-");
    await expect(page.locator(".toast.toast-error"), "no 'invalid link' toast").toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/");

    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": c2 } }).catch(() => {});
    await sa2.dispose();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The AUTHENTICATED /join arc (the live-event QR path). The two tests above
  // stop at the anonymous landing; these drive the client handoff that actually
  // gets the participant INTO the competition:
  //   joinViaPendingToken() → POST /api/competitions/join → returns competitionId
  //   → enterAfterJoin(id) → re-read /api/me → selectCompetition → tasks page.
  // The handoff IS that return value — `enterAfterJoin` is skipped when it is
  // falsy, so a break there enrolls the participant server-side but dumps them
  // on the picker (or their previous competition) with nothing saying the join
  // worked. Both call sites are covered: boot() (already signed in, e.g. a phone
  // scanning the QR) and doLogin() (signed in from the /join landing page).
  //
  // Both fixtures are single-slot (zero timeslots) on purpose: with timeslots
  // selectCompetition returns 'needsTimeslot' and enterAfterJoin routes to the
  // slot picker, which would sink the test in BOTH the fixed and broken states.
  // ───────────────────────────────────────────────────────────────────────────

  /** Live single-slot comp + one published challenge with a unique title + an enabled /join link. */
  async function _makeJoinableComp(sa, h, label) {
    const t = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const name = `${label} ${t}`;
    const compId = (await (await sa.post("/api/admin/competitions", {
      headers: h,
      data: { name, start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 240 },
    })).json()).competition.id;
    const taskTitle = `${label}-CH ${t}`;
    const taskId = (await (await sa.post("/api/admin/tasks", {
      headers: h,
      data: { title: taskTitle, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
    })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });
    const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
    const put = await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { self_enroll_enabled: true, expectedUpdatedAt: rv.updated_at } });
    expect(put.ok(), "self-enrollment enabled").toBeTruthy();
    return { compId, taskId, taskTitle, token: rv.token, name };
  }

  /** The competition_users row for (user, comp), or undefined. Read-only handle. */
  function _membershipRow(userId, compId) {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return db.prepare("SELECT assigned_by FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, compId);
    } finally { db.close(); }
  }

  async function _cleanupComp(compId) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const hh = { "x-csrf-token": csrf };
    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: hh }).catch(() => {});
    await sa.delete(`/api/admin/competitions/${compId}`, { headers: hh }).catch(() => {});
    await sa.dispose();
  }

  test("a signed-in participant who opens /join/<token> is enrolled AND routed straight into that competition", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await _makeJoinableComp(sa, h, "JoinBoot");
    // Deliberately NOT assigned — the /join link is the ONLY thing that can enroll them.
    const me = await createAssignedParticipant(sa, h, null);
    await sa.dispose();

    // Positive control: the membership genuinely does not exist yet, so the
    // "row present afterwards" assertion below is not vacuous.
    expect(_membershipRow(me.id, fx.compId), "not a member before the /join visit").toBeFalsy();

    // Already signed in (the phone-scans-the-QR case) — boot() must do the handoff.
    await loginViaApi(page, me.email, PARTICIPANT_PASS);
    await page.goto(`/join/${encodeURIComponent(fx.token)}`);

    // Routed straight into THAT competition. The unique challenge title is the
    // discriminator: a broken handoff leaves them on the picker (or on whatever
    // competition they were previously in) with the join silently done.
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator(`.task-card:has-text("${fx.taskTitle}")`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#comp-grid")).toBeHidden();

    // Token secrecy holds on the authenticated branch too.
    expect(new URL(page.url()).pathname).toBe("/");
    expect(page.url()).not.toContain(fx.token);

    // The server-side half. This stays green under a routing break, so a failure
    // isolates to the client handoff rather than to the join endpoint.
    const row = _membershipRow(me.id, fx.compId);
    expect(row, "enrolled via the join link").toBeTruthy();
    expect(row.assigned_by).toBe("self_enroll");

    await _cleanupComp(fx.compId);
  });

  test("signing IN from a /join/<token> landing enrolls AND routes into that competition", async ({ page }) => {
    // The doLogin() twin of the test above — same handoff, different call site.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await _makeJoinableComp(sa, h, "JoinLogin");
    const me = await createAssignedParticipant(sa, h, null);
    await sa.dispose();

    expect(_membershipRow(me.id, fx.compId), "not a member before the /join visit").toBeFalsy();

    // Anonymous arrival → the email entry screen with the event on the card
    // (the pending token survives in module state, which the banner proves).
    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner")).toBeVisible();

    await page.fill("#login-email", me.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);

    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator(`.task-card:has-text("${fx.taskTitle}")`).first()).toBeVisible({ timeout: 15000 });

    const row = _membershipRow(me.id, fx.compId);
    expect(row, "enrolled via the join link").toBeTruthy();
    expect(row.assigned_by).toBe("self_enroll");

    await _cleanupComp(fx.compId);
  });
});


test.describe("audit v7.7.35 (T4) — edit-profile dirty-form contract", () => {
  test("clean close fires no PUT; a dirty Escape raises the Discard-changes confirm", async ({ page }) => {
    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    let putMe = 0;
    page.on("request", r => { if (r.method() === "PUT" && /\/api\/me(\?|$)/.test(r.url())) putMe++; });

    // (a) Open the editor and close it CLEAN (Escape) — no confirm, no PUT.
    // Profile lives in the account menu (tests/chrome-helpers.js).
    const { pressAccountMenuItem } = require("./chrome-helpers");
    await pressAccountMenuItem(page, "open-profile-editor");
    await page.locator("#profile-overlay").waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator("#modal-overlay.open"), "clean close must not raise a confirm").toHaveCount(0);
    expect(putMe, "a clean close must not call PUT /api/me").toBe(0);

    // (b) Reopen, edit a field, press Escape → the Discard-changes confirm appears;
    //     Keep-editing keeps the dialog open (no data loss).
    await pressAccountMenuItem(page, "open-profile-editor");
    await page.locator("#profile-overlay").waitFor({ state: "visible", timeout: 5000 });
    await page.fill("#prof-company", "Dirty Co " + Date.now());
    await page.keyboard.press("Escape");
    const confirm = page.locator("#modal-overlay.open");
    await confirm.waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#modal-title")).toHaveText(/Discard changes\?/);
    await page.locator("#modal-cancel-btn").click(); // "Keep editing"
    await expect(page.locator("#profile-overlay"), "Keep-editing must leave the editor open").toBeVisible();
    expect(putMe, "the discard flow must not have saved").toBe(0);
    // Clean up: discard so the editor doesn't leak into later tests.
    await page.keyboard.press("Escape");
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click(); // "Discard"
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 5000 });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v7.21.0 — CHALLENGE CATEGORY RIBBONS
// ═══════════════════════════════════════════════════════════════════════════════
// A category is an ordinary task tag spelled `category:<name>`. The participant
// payload carries only the parsed NAMES (lib/categories.js), so the raw admin
// labels on the same challenge never reach the browser — which is why the
// "a non-category tag is nowhere on the page" assertion below is part of the
// feature and not decoration.
//
// The renderer is ONE function (renderCategories) used by both the card grid and
// the challenge detail, so both surfaces are asserted every time: a regression
// that reaches only one of them is exactly what a single renderer exists to
// prevent, and asserting only the card would not see it.
test.describe("v7.21.0 — challenge category ribbons", () => {
  // Unique per run so a re-run against a recycled DB cannot match a leftover.
  const U = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const T = {
    duo:  `CatDuo ${U}`,
    solo: `CatSolo ${U}`,
    none: `CatNone ${U}`,
    long: `CatLong ${U}`,
  };
  // The raw admin label planted on the DUO challenge. It is a real task tag and
  // it must never be rendered to a participant — that one-directional filter is
  // the security property of this feature.
  const RAW_TAG = `needs-review-${U}`;
  // Tag length is capped at 50 including the `category:` prefix, so these are as
  // long as the feature allows. The last one is deliberately UNBROKEN: a name
  // with spaces can always wrap, so it cannot tell whether the ribbon's own
  // max-width/overflow clamp is doing anything — an unwrappable token can.
  const LONG_CATS = [
    "server side request forgery",
    "cryptographic protocol analysis",
    "binary reverse engineering",
    "cloud misconfiguration review",
    "unbrokenlongcategorynamethatcannotwrapall",
  ];

  // This block owns its OWN live competition rather than borrowing the seeded
  // "Test Live". Earlier files/tests in this spec re-point alice's competition,
  // add timeslots and eject her, so which screen `page.goto("/")` lands on is a
  // function of what ran before — the v7.20.0 accumulation class. Its own
  // competition plus an explicit API select removes that dependency entirely,
  // and has the bonus that the grid contains exactly this block's challenges.
  let COMP_ID = null;

  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const cr = await api.post("/api/admin/competitions", {
      headers: h,
      data: {
        name: `CatComp ${U}`,
        start_time: new Date(Date.now() - 30 * 60_000).toISOString(),
        duration_minutes: 180,
      },
    });
    expect(cr.ok(), `create competition: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    COMP_ID = (await cr.json()).competition.id;

    const people = await (await api.get("/api/admin/participants?limit=200")).json();
    const alice = (people.participants || []).find(p => p.email === "alice@acme.com");
    expect(alice, "seed must provide alice").toBeTruthy();
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: h, data: { userIds: [alice.id], competitionIds: [COMP_ID] },
    });
    expect(asg.ok(), `assign alice: ${asg.status()}`).toBeTruthy();

    const mk = async (title, tags) => {
      const r = await api.post("/api/admin/tasks", {
        headers: h,
        data: {
          title, description: `<p>Body of ${title}</p>`,
          difficulty: "easy", answer_type: "text", correct_answer: "x",
          explanation: "—", hint: "—", status: "published",
        },
      });
      expect(r.ok(), `create ${title}: ${r.status()}`).toBeTruthy();
      const id = (await r.json()).id;
      for (const tag of tags) {
        const tr = await api.post(`/api/admin/tasks/${id}/tags`, { headers: h, data: { tag } });
        expect(tr.ok(), `tag ${tag}: ${tr.status()} ${await tr.text()}`).toBeTruthy();
      }
      const ar = await api.post(`/api/admin/tasks/${id}/competitions`, {
        headers: h, data: { competitionIds: [COMP_ID] },
      });
      expect(ar.ok(), `assign ${title}: ${ar.status()}`).toBeTruthy();
      return id;
    };

    // Two categories PLUS a free-text admin label on the same challenge.
    await mk(T.duo, ["category:web", "category:crypto", RAW_TAG]);
    await mk(T.solo, ["category:forensics"]);
    // The control: tagged, but with nothing that parses as a category. `category:`
    // with an empty name is deliberately NOT a category (lib/categories.js), so
    // this challenge must render no ribbon container at all.
    await mk(T.none, [RAW_TAG, "category:"]);
    await mk(T.long, LONG_CATS.map(c => `category:${c}`));
    await api.dispose();
  });

  /** Alice, inside THIS block's competition, on the Challenges grid. */
  async function openGrid(page) {
    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    // Select through the API rather than by clicking whichever card happens to
    // be first in the picker — there are several competitions by now and the
    // one we need is not reliably at the front.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const sel = await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { competitionId: COMP_ID },
    });
    expect(sel.ok(), `select competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click({ timeout: 20000 });
    // The grid holds exactly this block's four challenges — a useful control in
    // itself: it proves we are looking at OUR competition and not another one.
    await expect(page.locator("#task-grid .task-card")).toHaveCount(4, { timeout: 15000 });
  }
  const cardFor = (page, title) => page.locator(`#task-grid .task-card`, { hasText: title }).first();

  async function openChallenge(page, title) {
    await cardFor(page, title).click();
    await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#task-detail-card .qa-title")).toHaveText(title, { timeout: 10000 });
  }

  // ── 1. the ribbons render on BOTH surfaces, and only where there is something
  //       to show ────────────────────────────────────────────────────────────
  test("category ribbons render on the card AND inside the challenge", async ({ page }) => {
    await openGrid(page);

    // Card. The tag read is `ORDER BY tag`, so `category:crypto` precedes
    // `category:web` — the order is stable by construction, and asserting it
    // (rather than a set) is what pins that.
    const card = cardFor(page, T.duo);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator(".cat-ribbon")).toHaveText(["crypto", "web"]);
    await expect(card.locator(".cat-ribbons")).toHaveClass(/on-card/);

    // The security property, on screen: the free-text admin label that sits on
    // the SAME challenge is nowhere in the participant's document.
    const gridHtml = await page.locator("#task-grid").innerHTML();
    expect(gridHtml, "a non-category task tag must never reach a participant").not.toContain(RAW_TAG);

    // The control from v7.20.8 — a control must not appear when it has nothing
    // to show. `category:` with an empty name is not a category either.
    const bare = cardFor(page, T.none);
    await expect(bare).toBeVisible();
    expect(await bare.locator(".cat-ribbons").count(), "no categories ⇒ no ribbon container").toBe(0);
    expect(await bare.locator(".cat-ribbon").count()).toBe(0);

    // Detail view — the same names again, from the same renderer.
    await openChallenge(page, T.duo);
    await expect(page.locator("#task-detail-card .cat-ribbon")).toHaveText(["crypto", "web"]);
    // …and the raw label is absent here too (this is a different endpoint,
    // GET /api/tasks/:id, so the grid assertion above does not cover it).
    expect(await page.locator("#task-detail-card").innerHTML()).not.toContain(RAW_TAG);

    // A challenge with no categories renders no container in the detail view either.
    await page.locator("#task-detail-page .back-btn").click();
    await openChallenge(page, T.none);
    expect(await page.locator("#task-detail-card .cat-ribbons").count()).toBe(0);
  });

  // ── 2. accessibility ────────────────────────────────────────────────────────
  test("the ribbons are an accessible, labelled list — and axe is clean", async ({ page }) => {
    await openGrid(page);
    const card = cardFor(page, T.duo);
    const group = card.locator(".cat-ribbons");
    await expect(group).toHaveAttribute("role", "list");
    const items = card.locator(".cat-ribbon");
    await expect(items).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expect(items.nth(i)).toHaveAttribute("role", "listitem");

    // The visible chrome does not say "category" anywhere, so a screen reader
    // must be told. Plural for two.
    const srPlural = group.locator(".sr-only");
    await expect(srPlural).toHaveCount(1);
    expect((await srPlural.textContent()).trim()).toBe("Categories:");

    // The glyph is decoration; the name is the content.
    const glyphs = items.locator(".cat-ribbon-ico");
    await expect(glyphs).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expect(glyphs.nth(i)).toHaveAttribute("aria-hidden", "true");
    // Icon convention: inline SVG, never an emoji or a webfont glyph.
    expect(await glyphs.first().innerHTML()).toContain("<svg");

    // Singular for one — the plural would read wrong, and a hard-coded string
    // would not be caught by the plural assertion above.
    const soloSr = cardFor(page, T.solo).locator(".cat-ribbons .sr-only");
    expect((await soloSr.textContent()).trim()).toBe("Category:");

    // The card's CONTROL — its title button — carries the categories in its
    // accessible name: a screen-reader user scanning the grid gets the grouping
    // without entering every card. The name OPENS with the title it shows
    // (WCAG 2.5.3 Label in Name), which axe's label-content-name-mismatch below
    // also holds.
    const label = await cardFor(page, T.duo).locator(".card-open").getAttribute("aria-label");
    expect(label.startsWith(T.duo), `the name opens with the visible title: ${label}`).toBe(true);
    expect(label).toContain(T.duo);
    expect(label, "the card's accessible name must carry the categories").toMatch(/categories crypto, web/i);
    const soloLabel = await cardFor(page, T.solo).locator(".card-open").getAttribute("aria-label");
    expect(soloLabel).toMatch(/category forensics/i);
    // Positive control for the two assertions above: the card with NO
    // categories must not gain a category clause. Without this a renderer that
    // always appended "categories …" would satisfy both of them.
    const noneLabel = await cardFor(page, T.none).locator(".card-open").getAttribute("aria-label");
    expect(noneLabel).not.toMatch(/categor/i);

    // Detail view carries the same group semantics.
    await openChallenge(page, T.duo);
    await expect(page.locator("#task-detail-card .cat-ribbons")).toHaveAttribute("role", "list");
    expect((await page.locator("#task-detail-card .cat-ribbons .sr-only").textContent()).trim()).toBe("Categories:");

    // axe over the grid itself.
    //
    // v7.22.0 — `#task-grid` is the other applyReveal() target, so it carries the
    // same mid-fade sampling hazard as the competitions picker (see the note on
    // "competitions picker: no moderate+ axe violations" in ui-participant-c):
    // `waitFor({state:"visible"})` is satisfied at opacity 0, and axe then
    // computes a BLENDED foreground colour. Reduced motion removes the fade via
    // the product's own `@media(prefers-reduced-motion:reduce){.reveal{opacity:1}}`
    // rule, so what is scanned is the settled page. Applied here as a fix for the
    // shape rather than after a failure — this scan has not been seen to flake,
    // but it is the same construction and the failure mode is a contrast result
    // that depends on timing.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#task-detail-page .back-btn").click();
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 10000 });
    const results = await new AxeBuilder({ page }).include("#task-grid").analyze();
    const bad = results.violations.filter(v => ["moderate", "serious", "critical"].includes(v.impact));
    expect(bad.map(v => `${v.id} (${v.impact}) ${v.nodes.length}`).join("; ")).toBe("");
  });

  // ── 3. MEASURED contrast, in both themes, on both surfaces ──────────────────
  //
  // This is asserted by MEASUREMENT, never by reading the stylesheet: the point
  // of the --accent2 token choice is the ratio it produces once --accent-soft
  // has been composited over the card surface, and a text assertion on the CSS
  // would pass just as happily with --accent (2.89:1 on the dark surface).
  test("ribbon text meets AA contrast in BOTH themes, on the card and in the challenge", async ({ page }) => {
    // Composite alpha the way the browser does, then WCAG 2.x relative luminance.
    const MEASURE = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `no element for ${sel}` };
      const parse = (c) => {
        const m = String(c).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
      });
      // Walk up collecting background layers until an opaque one is hit; the
      // ribbon's OWN background (--accent-soft) is part of the backdrop its text
      // sits on, so the walk deliberately starts at the element itself.
      const backdrop = (start) => {
        const layers = [];
        for (let n = start; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) layers.push(c);
          if (c && c.a >= 1) break;
        }
        let base = { r: 255, g: 255, b: 255, a: 1 };
        if (layers.length && layers[layers.length - 1].a >= 1) base = layers.pop();
        for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
        return base;
      };
      const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const bg = backdrop(el);
      let fg = parse(getComputedStyle(el).color);
      if (!fg) return { error: "unparsable color" };
      if (fg.a < 1) fg = over(fg, bg);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = (c) => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;
      return { ratio, fg: px(fg), bg: px(bg), text: el.textContent.trim() };
    };

    // The app's own control (v7.20.6: a three-state preference, so "click once
    // to flip" is no longer true — cycle until the painted theme is the one
    // we want).
    async function setTheme(want) {
      // Signed in, the mode lives on the Appearance page (the account menu's
      // "Appearance" row opens it).
      const ap = await require("./chrome-helpers").openAppearance(page);
      await ap.locator(`[data-action="appearance-mode"][data-mode="${want}"]`).click();
      await page.keyboard.press("Escape");
      await expect(page.locator("#appearance-overlay")).toHaveCount(0);
      expect(await page.getAttribute("html", "data-theme"), `could not reach the ${want} theme`).toBe(want);
    }

    await openGrid(page);
    const cardSel = `#task-grid .task-card:has(.card-open[aria-label*="${T.duo}"]) .cat-ribbon`;
    // Sanity: the selector resolves to a real, visible ribbon before anything is
    // measured — a measurement of nothing would otherwise "pass" as an error we
    // then have to notice.
    await expect(page.locator(cardSel).first()).toBeVisible({ timeout: 10000 });

    const seen = {};
    for (const theme of ["dark", "light"]) {
      await setTheme(theme);
      const card = await page.evaluate(MEASURE, cardSel);
      expect(card.error, `card measurement failed in ${theme}`).toBeUndefined();
      expect(card.text).toBe("crypto");
      expect(card.ratio, `card ribbon contrast in ${theme} theme (fg ${card.fg} on ${card.bg})`)
        .toBeGreaterThanOrEqual(4.5);
      seen[`card-${theme}`] = card;
    }
    // Positive control: the two themes must actually have painted differently.
    // Without it a broken theme control would let one theme be measured twice
    // and the AA assertion would hold vacuously for the theme never tested.
    expect(seen["card-dark"].bg, "the two themes must paint different surfaces")
      .not.toBe(seen["card-light"].bg);
    expect(seen["card-dark"].fg, "…and --accent2 is theme-flipped, so the text colour moves too")
      .not.toBe(seen["card-light"].fg);

    // The detail view sits on a different surface, so it is measured separately
    // rather than assumed to inherit the card's result.
    await openChallenge(page, T.duo);
    const detailSel = "#task-detail-card .cat-ribbon";
    await expect(page.locator(detailSel).first()).toBeVisible({ timeout: 10000 });
    for (const theme of ["dark", "light"]) {
      await setTheme(theme);
      const d = await page.evaluate(MEASURE, detailSel);
      expect(d.error, `detail measurement failed in ${theme}`).toBeUndefined();
      expect(d.text).toBe("crypto");
      expect(d.ratio, `detail ribbon contrast in ${theme} theme (fg ${d.fg} on ${d.bg})`)
        .toBeGreaterThanOrEqual(4.5);
      seen[`detail-${theme}`] = d;
    }
    expect(seen["detail-dark"].bg).not.toBe(seen["detail-light"].bg);
  });

  // ── 4. long / many categories do not push the layout sideways ───────────────
  test("many long category names never widen the card past the grid", async ({ page }) => {
    await openGrid(page);
    const card = cardFor(page, T.long);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator(".cat-ribbon")).toHaveCount(LONG_CATS.length);

    // Positive control: the long names really are long enough to be a test —
    // otherwise this passes on a card whose content was never near the edge.
    const widest = await card.locator(".cat-ribbon").evaluateAll(
      els => Math.max(...els.map(e => e.getBoundingClientRect().width)));
    expect(widest, "the fixture must actually stress the width").toBeGreaterThan(100);

    // 320px is the narrowest viewport this codebase treats as supported (it is
    // where the v7.15.0 leaderboard column pushed the page sideways), and it is
    // the width at which an unwrappable name is genuinely wider than its card —
    // i.e. the only one of the three that can see the clamp working.
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(120);
      const m = await card.evaluate((el) => {
        const grid = document.getElementById("task-grid");
        const box = el.querySelector(".cat-ribbons");
        return {
          cardScroll: el.scrollWidth, cardClient: el.clientWidth,
          gridClient: grid.clientWidth,
          boxScroll: box ? box.scrollWidth : 0, boxClient: box ? box.clientWidth : 0,
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
        };
      });
      // 1px of tolerance for sub-pixel rounding; anything real is far larger.
      expect(m.cardScroll, `card overflows the grid at ${width}px`).toBeLessThanOrEqual(m.gridClient + 1);
      expect(m.boxScroll, `the ribbon row overflows its card at ${width}px`).toBeLessThanOrEqual(m.cardClient + 1);
      expect(m.docScroll, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(m.docClient + 1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v7.23.7 — a route change moves focus to the destination (WCAG 2.4.3).
//
// Before: showPage/showMain/adminTab swapped .page visibility and nothing else,
// so focus stayed on the clicked control or fell to <body> when that control was
// inside the page being hidden. A keyboard or screen-reader user was never told
// they had arrived.
//
// The SECOND test is the one that makes this safe rather than merely present:
// polls genuinely reach showMain (a 15s poll routes to tasks-page when a
// competition goes live; four polls can reach ejectToCompetitionPicker), so the
// fix is only acceptable because re-entering the SAME page is a no-op.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.23.7 — route-change focus", () => {
  test("navigating to another page focuses that page's heading", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const compsBody = await (await sa.get("/api/admin/competitions")).json();
    const live = (compsBody.competitions || compsBody).find(c => c.name === "Test Live");
    expect(live, "the seed must provide the live competition").toBeTruthy();
    const me = await createAssignedParticipant(sa, h, live.id);
    await sa.dispose();
    await enterCompAsParticipant(page, me.email, live.id);

    const lb = page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first();
    await lb.waitFor({ state: "visible", timeout: 15000 });
    await lb.click();
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 10000 });

    // Focus must land INSIDE the destination page, not on the button that was
    // clicked. Asserting containment rather than a specific element keeps the
    // lock alive if a page's heading markup changes.
    const where = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return { tag: "NONE" };
      const page_ = a.closest(".page");
      return { tag: a.tagName, id: a.id || "", inPage: page_ ? page_.id : "(none)",
               isNavBtn: a.classList.contains("nav-btn") };
    });
    expect(where.isNavBtn, `focus stayed on the clicked nav button: ${JSON.stringify(where)}`).toBe(false);
    expect(where.inPage, `focus must move into the destination page: ${JSON.stringify(where)}`)
      .toBe("leaderboard-page");
  });

  test("re-entering the SAME page does not move focus — the poll-safety guarantee", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const compsBody = await (await sa.get("/api/admin/competitions")).json();
    const live = (compsBody.competitions || compsBody).find(c => c.name === "Test Live");
    const me = await createAssignedParticipant(sa, h, live.id);
    await sa.dispose();
    await enterCompAsParticipant(page, me.email, live.id);
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });

    // WHAT THIS CAN AND CANNOT ASSERT, established by measurement rather than
    // assumed: showMain display:none's EVERY page before re-showing the target,
    // so a same-page re-entry drops focus to <body> all by itself. Verified by
    // reverting the _focusRoute calls and re-running this test — focus is lost
    // identically without them. So "focus is preserved" is not a guarantee this
    // fix could offer and asserting it would just fail against correct code.
    //
    // The guarantee that IS this fix's to keep — and the one that makes it safe
    // to call from paths a poll can reach — is that a same-page re-entry does
    // not RELOCATE focus into the destination heading. Anything else would mean
    // a 15s poll yanking a screen-reader user back to the top of the page they
    // were already reading.
    await page.evaluate(() => {
      const el = document.querySelector("#task-search") || document.querySelector("#main-nav .nav-btn");
      el.focus();
    });
    await page.evaluate(() => { window.showMain("tasks-page"); });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return "BODY";
      return `${a.tagName}#${a.id || ""}`;
    });
    expect(["H1", "H2"].some(t => after.startsWith(t)) || after === "DIV#tasks-page",
      `a same-page re-entry relocated focus to the destination heading (${after}) — `
      + "a poll would do this to a reader every 15 seconds").toBe(false);
  });

  test("switching admin tabs twice focuses each pane", async ({ page }) => {
    // TWICE is load-bearing: adminTab keeps its own last-value, and a single
    // switch would pass even if that state were shared with showMain (which
    // sets it to 'admin-page' on entry and would then swallow every tab change).
    await adminLogin(page);
    const focusIn = () => page.evaluate(() => {
      const a = document.activeElement;
      const pane = a && a.closest(".admin-tab-pane, [id^='admin-'][id$='-tab']");
      return pane ? pane.id : (a ? a.tagName + "#" + (a.id || "") : "NONE");
    });
    for (const [label, paneId] of [["Challenges", "admin-tasks-tab"], ["Participants", "admin-participants-tab"]]) {
      await page.locator(_tabSel(label)).first().click();
      await page.locator(`#${paneId}`).waitFor({ state: "visible", timeout: 20000 });
      await expect.poll(focusIn, {
        message: `switching to ${label} must move focus into #${paneId}`,
        timeout: 5000,
      }).toBe(paneId);
    }
  });

  test("the admin page has no heading of its own, and focus still lands somewhere real", async ({ page }) => {
    // #admin-page carries no h1/h2 outside its panes, and the only h2 in its
    // subtree sits inside #admin-groups-tab (display:none unless Groups is
    // open). .focus() on a non-rendered element is a SILENT no-op that leaves
    // focus on <body> — the bug wearing the fix's clothes — so the fall back to
    // the page container is what this pins.
    await adminLogin(page);
    // Dismiss anything modal first: a dialog traps focus, and the first draft of
    // this test passed against a BROKEN build because #modal-confirm-btn held
    // focus and satisfied "is rendered" without any route target being involved.
    await page.evaluate(() => {
      document.querySelectorAll(".modal-overlay, #modal-overlay").forEach(o => { o.style.display = "none"; });
      document.body.focus();
    });
    await page.evaluate(() => { window.showMain("competitions-page"); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.showMain("admin-page"); });
    // BOTH properties, together. "rendered" alone is satisfied by whatever
    // happened to hold focus; "inside #admin-page" alone is satisfied by the
    // hidden Groups heading, which is exactly the silent no-op guard 3 exists to
    // prevent. Only the pair pins the fall back to the page container.
    await expect.poll(async () => page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return "BODY";
      const inAdmin = !!a.closest("#admin-page");
      const rendered = a.getClientRects().length > 0;
      return `${a.id || a.tagName}|inAdmin=${inAdmin}|rendered=${rendered}`;
    }), {
      message: "focus must land on a RENDERED element inside #admin-page, never on a "
        + "display:none heading (a silent .focus() no-op) and never on <body>",
      timeout: 5000,
    }).toMatch(/\|inAdmin=true\|rendered=true$/);
  });
});
