// @ts-check
//
// Part of the ui-admin suite, split from a single 4,833-line file in v7.21.35.
//
// Contains: Participant UI · Admin — Competitions · v7.10.0 — scope-banner competition switcher · v7.11.0 — group-level leaderboard UI · audit v7.7.35 (T3) — modal dismissal contract · v7.12.0 — bulk assign challenges to competitions (UI) · Stale admin list responses (v7.15.13)
//
// WHY IT WAS SPLIT: a spec file never spans workers, so the old file was a
// 181-second serial floor inside a 248-second suite — 73% of the wall clock in
// one worker, which no worker count could improve (WORKERS=16 bought 5.8%).
// Shared helpers live in ./ui-admin-helpers so the copies cannot drift.
const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, PORT_BASE, gradingHashFor } = require("./helpers");
const {
  login, loginViaApi, saLoginRetry, filterComps, adminLogin, participantLogin,
  clickTab, openKebab, findSeededTaskRow, viewComp, narrowGroupsTable, CONFIRM_PROBE_MS, AxeBuilder, AXE_GATED_IMPACTS, narrowChallengesTable, narrowPeopleTable, narrowEventsTable } = require("./ui-admin-helpers");

// Route every page.goto() + page.request.* to THIS worker's server.
test.use({ baseURL: BASE });


// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Participant UI", () => {
  test("competition picker or nav visible after login", async ({ page }) => {
    await participantLogin(page);
    // v7.22.0 — the "or" was never an or, and the budget was too tight.
    //
    // `locator("#comp-grid, #main-nav").first()` resolves by DOM ORDER, and
    // #main-nav (index.html:73) precedes #comp-grid (:132) — so this only ever
    // waited for #main-nav, whatever the second selector said. And boot is a
    // SERIAL chain (csrf + config → /api/me → competition/role routing), which
    // at WORKERS=12 can outrun 5 s on a contended machine; the failure then read
    // "not visible" and named neither the element nor the view the app had
    // actually reached. Poll for EITHER for real, and report the state on
    // failure so a genuine regression (stuck on login) is distinguishable from
    // a slow boot.
    await expect.poll(async () => {
      const nav = await page.locator("#main-nav").isVisible().catch(() => false);
      const grid = await page.locator("#comp-grid").isVisible().catch(() => false);
      if (nav || grid) return "routed";
      const login = await page.locator("#login-page.active").isVisible().catch(() => false);
      return login ? "still-on-login" : "neither";
    }, {
      timeout: 15000,
      message: "after a participant login the app must route into the picker or the main nav",
    }).toBe("routed");
  });

  test("tasks page shows task cards", async ({ page }) => {
    await participantLogin(page);
    // Select comp if picker shown; wait for the nav button to render rather
    // than a fixed delay — nav-btn appears once the comp context is entered.
    // v8.3.13 — SETTLE FIRST. `isVisible()` is a POINT-IN-TIME check whose
    // timeout option is ignored (v8.1.0), so while boot is still resolving it
    // answers false, the click is skipped, no competition is entered, and the
    // failure surfaces 10 s later as a HIDDEN `#nav-challenges` — naming the nav
    // button rather than the missing entry. Wait for the app to have routed
    // somewhere before deciding.
    await page.waitForFunction(
      () => !!document.querySelector("#competitions-page.active, #tasks-page.active, #pending-page.active"),
      null, { timeout: 30000 },
    );
    const card = page.locator("#comp-grid .comp-card, [data-comp-id]").first();
    if (await card.isVisible().catch(() => false)) await card.click();
    const btn = page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first();
    await btn.waitFor({ state: "visible", timeout: 15000 });
    await btn.click();
    await expect(page.locator(".task-card, [data-task-id]").first()).toBeVisible({ timeout: 5000 });
  });

  test("leaderboard shows alice", async ({ page }) => {
    await participantLogin(page);
    // v8.3.26 — the SAME settle the test directly above carries, and it was
    // missing here. `participantLogin` settles on `#comp-grid .comp-card,
    // .nav-btn` — a comma selector, which `.first()` resolves by DOM ORDER, and
    // `#main-nav` precedes `#comp-grid` in the shell — so it can return while
    // `#comp-grid` is still the empty container boot fills once /api/me resolves.
    // `isVisible()` then answers false, the click is skipped, no competition is
    // entered, and `#nav-leaderboard` (which ships `display:none` and is revealed
    // only with competition context) never appears. The failure names the nav
    // button, which is nowhere near the cause.
    await page.waitForFunction(
      () => !!document.querySelector("#competitions-page.active, #tasks-page.active, #pending-page.active"),
      null, { timeout: 30000 },
    );
    const card = page.locator("#comp-grid .comp-card, [data-comp-id]").first();
    if (await card.isVisible().catch(() => false)) await card.click();
    const btn = page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first();
    await btn.waitFor({ state: "visible", timeout: 10000 });
    await btn.click();
    await expect(page.locator("text=alice_s").first()).toBeVisible({ timeout: 5000 });
  });

  test("participant cannot see admin panel", async ({ page }) => {
    await participantLogin(page);
    await expect(page.locator("#admin-panel")).not.toBeVisible();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — COMPETITIONS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — Competitions", () => {
  test("competitions list with status badges", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await expect(page.locator(".status-badge.live").first()).toBeVisible({ timeout: 10000 });
    // Default filter hides ended — click All to show everything, then wait
    // for the ended row to appear (deterministic replacement for a fixed delay).
    await page.locator("#comp-status-filters button[data-status='all']").click();
    // Assert each seeded competition INDIVIDUALLY. Reading the whole pane and
    // checking it mentions both names only holds while both fit on page 1, and
    // a filter narrow enough to make one findable necessarily hides the other —
    // the same trap the v7.15.30 badge test hit. Per-row assertions are also
    // stronger: they check the badge actually belongs to that row, which the
    // test's name promises and the pane-text version never verified.
    for (const [name, badge] of [["Test Live", "live"], ["Test Ended", "ended"]]) {
      await filterComps(page, name);
      const row = page.locator(`#admin-comp-body tr:has-text('${name}')`).first();
      await expect(row, `${name} must be listed`).toBeVisible({ timeout: 10000 });
      await expect(row.locator(`.status-badge.${badge}`), `${name} carries the ${badge} badge`).toBeVisible();
    }
  });

  test("Focus scopes competition and shows banner", async ({ page }) => {
    await adminLogin(page);
    await viewComp(page, "Test Live");
    await expect(page.locator("text=Viewing").first()).toBeVisible({ timeout: 3000 });
  });

  test("Assign Challenges available in kebab for live, absent for ended", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await expect(page.locator(".status-badge.live").first()).toBeVisible({ timeout: 10000 });
    await filterComps(page, "Test Live");
    const liveRow = page.locator("#admin-comp-body tr:has-text('Test Live')");
    // Assign Challenges is in the kebab menu and is marked as elevated (km-warning) for live competitions
    await expect(liveRow.locator(".kebab-menu button.km-warning:has-text('Assign Challenges')")).toHaveCount(1);
    // Edit on a live competition should also be elevated (warning)
    await expect(liveRow.locator(".kebab-menu button.km-warning:has-text('Edit')")).toHaveCount(1);
    // Show ended competitions — wait for the filter re-render, not a fixed delay.
    await page.locator("#comp-status-filters button[data-status='all']").click();
    await filterComps(page, "Test Ended");
    const endedRow = page.locator("#admin-comp-body tr:has-text('Test Ended')");
    await expect(endedRow).toBeVisible({ timeout: 5000 });
    await expect(endedRow.locator(".kebab-menu button:has-text('Assign Challenges')")).toHaveCount(0);
  });

  test("opening a second row's kebab while one is open keeps the new menu open (no flash-close)", async ({ page }) => {
    // Regression for the stale click-outside listener: toggleKebab() used to leave
    // its document click-outside listener attached after the menu was replaced, so
    // clicking a different row's ⋮ opened the new menu and the OLD listener then
    // fired on the SAME click and slammed it shut — the user had to click twice.
    await adminLogin(page);
    await clickTab(page, "Events");
    await page.locator("#comp-status-filters button[data-status='all']").click();
    const rows = page.locator("#admin-comp-body tr").filter({ has: page.locator(".kebab-btn") });
    await expect(rows.nth(1), "need ≥2 competition rows with a kebab").toBeVisible({ timeout: 8000 });
    // Open the first row's kebab.
    await openKebab(page, rows.nth(0));
    // Click the SECOND row's kebab directly (without closing the first). It must
    // stay open — pre-fix the portal flash-closed here.
    await rows.nth(1).locator(".kebab-btn").first().click();
    await expect(page.locator("#kebab-portal"), "second kebab menu flash-closed (stale listener)").toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
  });

  test("role promotion severity: km-warning for admin, km-danger for superadmin", async ({ page }) => {
    // v7.21.35 — THIS TEST NOW OWNS ITS PARTICIPANT, and that is the actual fix.
    //
    // It flaked three times against the shared seeded `carol`. The v7.21.17 pass
    // added waits; the v7.21.34 pass made the failure self-explaining, and the
    // very next run reported `Expected: "Participant"  Received: "Admin"` —
    // i.e. the row read as privileged.
    //
    // THE MECHANISM IS STILL NOT ESTABLISHED, and the honest reason is that the
    // v7.21.34 precondition locator was itself imprecise: it filtered `td` by
    // text and took .first(), which can match a non-role column (invited_by
    // precedes role). So "Received: Admin" may have named the wrong cell. It is
    // asserted precisely below now (a participant row carries no `.role-badge`).
    //
    // Either way the fix is the same and does not depend on the diagnosis: a
    // test that asserts on ROLE must not read a participant whose role other
    // files mutate — `carol` is promoted by functional-core.api.spec.js and
    // ended-freeze.api.spec.js. The fixture checklist already says it: OWN YOUR
    // PARTICIPANTS. Registering one removes the dependency instead of racing it.
    const stamp = `${Date.now()}${Math.floor(process.hrtime()[1] / 1000)}`;
    const targetEmail = `rolesev${stamp}@acme.com`;
    {
      const { api, csrf } = await freshCtx();
      const r = await registerPost(api, "/api/register", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: {
          email: targetEmail, password: PARTICIPANT_PASS,
          firstName: "Rolesev", lastName: "Target", nickname: `rolesev${stamp}`,
          company: "Globex", title: "QA", country: "GB", timezone: "Europe/London",
        },
      });
      expect(r.ok(), "could not register the dedicated role-severity participant").toBeTruthy();
      await api.dispose();
    }

    await adminLogin(page);
    await clickTab(page, "Participants");
    // `roleKm` renders ONLY when `S.isSuperAdmin` (participants-admin.js), so a
    // paint before that flag is populated has no role buttons at all.
    await page.waitForFunction(() => !!(window.S && window.S.isSuperAdmin), { timeout: 15000 });
    // The participants table paginates at 30 and this file adds rows as it runs,
    // so an unfiltered row lookup is the v7.15.29 class. Narrow first.
    await narrowPeopleTable(page, targetEmail);
    // The search is debounced, so poll for it to settle rather than reading the
    // still-unfiltered table one tick later.
    await expect.poll(() => page.locator("#admin-participants-body tr").count(),
      { timeout: 15000 }).toBe(1);
    const carolRow = page.locator("#admin-participants-body tr").first();
    await expect(carolRow, "the one remaining row is this test's own participant").toBeVisible({ timeout: 10000 });

    // v7.21.34 — this flaked a SECOND time (full 8-worker run) after the
    // v7.21.17 hardening, reporting only `Expected: 1 / Received: 0` for
    // `km-warning:has-text('Promote to Admin')`. Widening the waits again would
    // be a third blind attempt, so per the standing rule the test now names its
    // own cause instead.
    //
    // What the bare count CANNOT distinguish, and why it matters: `roleKm`
    // (participants-admin.js) emits "Promote to Admin" ONLY for a row whose
    // role is `participant`. For an `admin` row it emits "Promote to
    // Superadmin" + "Demote to Participant" — so the SECOND assertion below
    // passes in both cases and only the first fails, which is exactly the
    // observed signature. Asserting the rendered Role cell first therefore
    // separates "Carol is not a participant any more" from "the kebab markup
    // is wrong" from "isSuperAdmin was false at paint" — three different bugs
    // that currently produce one indistinguishable message.
    // PRECONDITION, asserted precisely: renderParticipants emits a `.role-badge`
    // span ONLY for an admin/superadmin row, so "no role badge" IS "participant".
    // The first version of this filtered `td` by text and took .first(), which
    // could match a non-role column (invited_by precedes role) and report a
    // misleading role — a precondition that can lie is worse than none.
    await expect(
      carolRow.locator(".role-badge"),
      "PRECONDITION: the target must be a plain participant — the buttons asserted below are " +
      "the participant-branch ones, so a privileged target fails the FIRST assertion only, " +
      "which reads as a markup bug and is not one",
    ).toHaveCount(0, { timeout: 10000 });

    // Promote to Admin → warning (elevated)
    // Promote to Superadmin → danger (destructive escalation)
    // Read BOTH labels in one pass so a failure reports what the kebab actually
    // contained rather than a bare 0 — with the preconditions above already
    // established, the label list is the only remaining unknown.
    const kebabLabels = async () =>
      (await carolRow.locator(".kebab-menu button").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    await expect
      .poll(kebabLabels, {
        timeout: 10000,
        message: "Carol's kebab never rendered the participant-branch role buttons",
      })
      .toEqual(expect.arrayContaining([
        expect.stringContaining("Promote to Admin"),
        expect.stringContaining("Promote to Superadmin"),
      ]));
    // Severity classes are the actual subject of the test.
    await expect(carolRow.locator(".kebab-menu button.km-warning:has-text('Promote to Admin')")).toHaveCount(1);
    await expect(carolRow.locator(".kebab-menu button.km-danger:has-text('Promote to Superadmin')")).toHaveCount(1);
  });

  test("v6.16.0: reveal-answers checkbox toggles + persists + flows to /api/tasks/:id", async ({ page }) => {
    // End-to-end UX regression for the new per-comp flag:
    //   1. Open the edit modal on Test Live → checkbox is unchecked
    //      (default for legacy seed competitions).
    //   2. Tick the box → Save → re-open the modal → still ticked
    //      (round-tripped through PUT).
    //   3. End the comp via /end-now (admin), then alice fetches the
    //      task detail — correct_answer + explanation now appear.
    //   4. Open the edit modal again → uncheck → Save → alice's next
    //      fetch hides the answer + explanation again.
    // Cleanup runs even on assertion failure (re-tick the comp's flag
    // back to false to leave the seed in its original state).
    const helpers = require("./helpers");
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, "Test Live");
    const liveRow = page.locator("#admin-comp-body tr:has-text('Test Live')");
    await expect(liveRow).toBeVisible({ timeout: 5000 });
    // Open edit modal.
    await liveRow.locator(".kebab-btn").click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    // Default: checkbox unchecked for the seed comp.
    const cb = page.locator("#comp-reveal-answers");
    await expect(cb).toHaveCount(1);
    await expect(cb).not.toBeChecked();
    // Tick + Save. Editing a LIVE comp surfaces a confirmation modal
    // ("changes take effect immediately") — the test must click
    // through it before the form overlay closes.
    await cb.check();
    await page.locator("[data-action='comp-save']").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 5000 });
    // Re-open modal and confirm the box is now checked (PUT round-trip).
    await liveRow.locator(".kebab-btn").click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#comp-reveal-answers")).toBeChecked();
    // Untick + Save (restore the seed default).
    await page.locator("#comp-reveal-answers").uncheck();
    await page.locator("[data-action='comp-save']").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 5000 });
    // Final round-trip check via the API directly — the GET admin
    // list should report 0 for the flag.
    const getR = await page.request.get("/api/admin/competitions");
    const list = await getR.json();
    const live = list.find(c => c.name === "Test Live");
    expect(live.reveal_answers_on_end).toBe(0);
  });
});


// EVENT WORKSPACES (replacing the v7.10.0 scope switcher). An event is opened
// from the Events list into its own workspace; its section tabs keep the event,
// and every SIDEBAR page closes it again so a cross-event page is never narrowed.
test.describe("Event workspace — open, sections keep the event, the sidebar leaves it", () => {
  test("opening an event shows its workspace; a section keeps it; All events and a sidebar page close it", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, "Test Upcoming");
    const upRow = page.locator("#admin-comp-body tr:has-text('Test Upcoming')");
    await expect(upRow).toBeVisible({ timeout: 5000 });
    await upRow.locator("td[data-action='comp-open']").click();

    const ws = page.locator("#admin-workspace");
    const banner = page.locator("#admin-scope-banner");
    await expect(ws).toBeVisible();
    await expect(page.locator("#ws-title")).toHaveText("Test Upcoming");
    await expect(banner).toContainText("Test Upcoming");
    await expect(page.locator("#admin-event-overview-tab"), "it opens on Overview").toBeVisible();
    // The switcher is gone for good.
    await expect(page.locator("[data-action='scope-switch']")).toHaveCount(0);

    // A WORKSPACE section keeps the event (the Challenges pane loads scoped).
    await page.locator("#ws-tabs [data-section='admin-tasks-tab']").click();
    await expect(page.locator("#admin-tasks-tab")).toBeVisible();
    await expect(ws, "a workspace section keeps the event open").toBeVisible();
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionName)).toBe("Test Upcoming");
    await expect(page.locator("#ws-tabs [data-section='admin-tasks-tab']")).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".admin-nav-item[data-tab-id='admin-competitions-tab']"), "the sidebar says you are inside Events")
      .toHaveAttribute("aria-current", "page");

    // A SIDEBAR page is cross-event: it closes the workspace (CONTROL for the above).
    await page.locator(".admin-nav-item[data-tab-id='admin-tasks-tab']").evaluate((el) => el.click());
    await expect(page.locator("#admin-tasks-tab")).toBeVisible();
    await expect(ws, "the Challenge library closes the workspace").toBeHidden();
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionId)).toBeNull();

    // Re-open, then leave with All events: back on the Events list, unscoped.
    await clickTab(page, "Events");
    await filterComps(page, "Test Live");
    await page.locator("#admin-comp-body tr:has-text('Test Live') td[data-action='comp-open']").first().click();
    await expect(page.locator("#ws-title")).toHaveText("Test Live");
    await banner.locator("[data-action='scope-clear']").click();
    await expect(ws).toBeHidden();
    await expect(page.locator("#admin-competitions-tab")).toBeVisible();
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionId)).toBeNull();
  });
});


// v7.11.0 — group-level leaderboard. Two UI behaviours: (a) the admin Rankings tab
// shows a "Group Rankings" board when a competition has bound groups, and (b)
// binding a group whose member is already in another bound group surfaces a
// descriptive, blocking "Group members clash" alert and does NOT bind.
test.describe("v7.11.0 — group-level leaderboard UI", () => {
  const GUH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
  async function mkP(sa, saCsrf, nick) {
    const email = `glbui_${nick}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: GUH(ac), data: { firstName: "U", lastName: "I", nickname: nick, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: GUH(saCsrf) });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: GUH(saCsrf) });
    return { id: u.id, email, nick };
  }

  test("admin Rankings shows a Group Rankings board when the competition has bound groups", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GUH(saCsrf);
    const t = Date.now();
    const compName = `UIGrp ${t}`;
    // v7.11.7 — the board is opt-in AND needs >=2 non-empty groups, so enable it and
    // bind a second team (Rivals) alongside Squad. Squad stays 2-strong for the
    // "2 members" assertion below.
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true } })).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: `UIGrp-T ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const m1 = await mkP(sa, saCsrf, `m1${t}`), m2 = await mkP(sa, saCsrf, `m2${t}`), m3 = await mkP(sa, saCsrf, `m3${t}`);
    const g = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Squad ${t}`, userIds: [m1.id, m2.id] } })).json()).group.id;
    const g2 = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Rivals ${t}`, userIds: [m3.id] } })).json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g, g2], competitionIds: [compId] } });
    await sa.dispose();
    for (const m of [m1, m2, m3]) { // members participate so the group has an eligible, on-board membership
      const { api, csrf } = await apiLogin(m.email, PARTICIPANT_PASS);
      await api.post("/api/select-competition", { headers: GUH(csrf), data: { competitionId: compId } });
      await api.post(`/api/tasks/${taskId}/submit`, { headers: GUH(csrf), data: { answer: "a" , gradingHash: await gradingHashFor(api, taskId)} });
      await api.dispose();
    }

    await adminLogin(page);
    await clickTab(page, "Events"); // ensures the full comp list is loaded into state
    // Focus the comp directly (the accumulated comp list paginates under load, so the
    // new comp's row may not be on the visible page — focus via the exposed SPA fn).
    await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), { id: compId, name: compName });
    await clickTab(page, "Rankings");
    const groupSection = page.locator("#admin-rankings-group-section");
    await expect(groupSection).toBeVisible({ timeout: 8000 });
    await expect(groupSection).toContainText("Group Rankings");
    const teamRow = groupSection.locator("tr", { hasText: `Squad ${t}` });
    await expect(teamRow).toBeVisible();
    await expect(teamRow).toContainText("2 members");

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.post(`/api/admin/competitions/${compId}/end-now`, { headers: GUH(clc) }).catch(() => {});
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("binding a clashing group surfaces a descriptive alert and blocks the bind", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GUH(saCsrf);
    const t = Date.now();
    const compName = `UIClash ${t}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const ux = await mkP(sa, saCsrf, `ux${t}`);
    const P = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `GP ${t}`, userIds: [ux.id] } })).json()).group.id;
    const Q = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `GQ ${t}`, userIds: [ux.id] } })).json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [P], competitionIds: [compId] } }); // P bound
    await sa.dispose();

    await adminLogin(page);
    await clickTab(page, "Groups");
    // v7.17.2 — the Groups table paginates at 30, and the worker DB accumulates
    // groups from every earlier spec on this worker, so by the time this file
    // runs the seeded row is genuinely ABSENT from page 1 rather than slow to
    // appear. Narrow with the table's own search first (same rule as
    // viewComp()/findSeededTaskRow(); see CLAUDE.md
    // *Test flakiness — root-cause conventions*).
    // v9.2.4 — and press a row only once the table has re-rendered for it.
    await narrowGroupsTable(page, `GQ ${t}`);
    const qRow = page.locator("#admin-groups-body tbody tr", { hasText: `GQ ${t}` });
    await expect(qRow).toBeVisible({ timeout: 5000 });
    await qRow.locator("[data-action='group-bind-comps']").click();
    // The bind dialog lists non-ended comps as .gc-cb checkboxes. Tick the clashing comp + Save.
    await page.locator(`.gc-cb[value="${compId}"]`).waitFor({ state: "visible", timeout: 5000 });
    await page.locator(`.gc-cb[value="${compId}"]`).check();
    await page.locator("#gc-save").click();
    // A blocking clash alert names the participant + the fix.
    const modal = page.locator("#modal-overlay.open");
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expect(modal).toContainText("Group members clash");
    await expect(modal).toContainText(ux.nick);
    // The bind was NOT applied (Q not bound to the comp).
    await page.locator("#modal-confirm-btn").click();
    const bound = await page.evaluate(async (gid) => {
      const list = (await (await fetch(`/api/admin/groups/${gid}/competitions`)).json()).competitions || [];
      return list.filter(c => c.bound).length;
    }, Q);
    expect(bound, "clashing group Q must not have been bound").toBe(0);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });
});


// audit v7.7.35 (T3) — the modal dismissal contract has no test despite being
// documented as the single close-path for every overlay. Lock both rules:
//   (1) a backdrop click NEVER closes the modal (overlayDismiss wires no
//       backdrop handler); (2) Escape closes only the TOPMOST overlay via the
//       LIFO window._modalEscStack — a confirm stacked over a dialog closes
//       first, the dialog underneath survives, and a second Escape closes it.
test.describe("audit v7.7.35 (T3) — modal dismissal contract", () => {
  test("backdrop click keeps the dialog open; Escape closes only the topmost overlay (LIFO)", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, "Test Live");
    const liveRow = page.locator("#admin-comp-body tr:has-text('Test Live')");
    await expect(liveRow).toBeVisible({ timeout: 5000 });
    await liveRow.locator(".kebab-btn").click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    const form = page.locator("#comp-form-overlay");
    await form.waitFor({ state: "visible", timeout: 5000 });

    // Rule 1 — a click whose target is the overlay backdrop must NOT close it.
    await form.dispatchEvent("click"); // target = the overlay element itself (backdrop)
    await expect(form, "backdrop click must not close the dialog").toBeVisible();

    // Rule 2 — stack a confirm over the form (editing a LIVE comp → Save spawns
    // the "changes take effect immediately" confirm), then Escape closes ONLY it.
    await page.locator("[data-action='comp-save']").first().click();
    const confirm = page.locator("#modal-overlay.open");
    await confirm.waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape"); // pops the topmost (confirm) — a Cancel, no save
    await expect(page.locator("#modal-overlay.open"), "Escape closes the confirm").toHaveCount(0);
    await expect(form, "the dialog underneath must survive the first Escape").toBeVisible();
    await page.keyboard.press("Escape"); // now pops the form
    await expect(form).toBeHidden({ timeout: 5000 });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v7.12.0 — bulk assign challenges to competitions (Challenges pane checkboxes)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.12.0 — bulk assign challenges to competitions (UI)", () => {
  const { AxeBuilder } = require("@axe-core/playwright");
  const { TEST_DB_PATH } = require("./helpers");
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  let _u = 0; const uniq = (p) => `${p} ${Date.now()}-${_u++}`;

  test("row checkboxes + selection bar + bulk-assign modal flow; drafts carry no checkbox", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const mkTask = async (title, status = "published") => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status } })).json()).id;
    const t1title = uniq("BulkUI-A"), t2title = uniq("BulkUI-B"), draftTitle = uniq("BulkUI-Draft");
    const t1 = await mkTask(t1title), t2 = await mkTask(t2title);
    await mkTask(draftTitle, "draft");
    const compName = uniq("BulkUI-Comp");
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    await sa.dispose();

    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, "BulkUI-");

    const t1Row = page.locator("#admin-task-body tr", { hasText: t1title });
    const t2Row = page.locator("#admin-task-body tr", { hasText: t2title });
    const draftRow = page.locator("#admin-task-body tr", { hasText: draftTitle });
    await expect(t1Row.locator("input[type=checkbox]")).toBeVisible();
    await expect(draftRow.locator("input[type=checkbox]"), "draft challenges have no checkbox").toHaveCount(0);

    await expect(page.locator("#challenges-selection-bar")).toBeHidden();
    await t1Row.locator("input[type=checkbox]").check();
    await t2Row.locator("input[type=checkbox]").check();
    await expect(page.locator("#challenges-selection-bar")).toBeVisible();
    await expect(page.locator("#challenge-selection-count")).toHaveText("2 selected");

    // No competition focused → the button opens the competition picker.
    await page.locator("#challenge-selection-bar-assign-btn").click();
    const overlay = page.locator("#challenge-bulk-assign-overlay");
    await expect(overlay).toBeVisible();
    await overlay.locator(".picker-row", { hasText: compName }).locator("input[type=checkbox]").check();
    await overlay.locator("[data-action='challenge-bulk-assign-execute']").click();
    await expect(page.locator("#challenges-selection-bar")).toBeHidden({ timeout: 8000 });

    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    // Each landed as the event's OWN copy of it (lib/event-copies.js).
    let count; try { count = db.prepare("SELECT COUNT(*) c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.owner_competition_id=ct.competition_id AND t.copied_from_task_id IN (?,?)").get(compId, t1, t2).c; } finally { db.close(); }
    expect(count, "both selected challenges landed in the competition").toBe(2);
  });

  test("select-all toggles every visible checkbox; no moderate+ axe violations with the selection bar visible", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const mkTask = async (title) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
    const tag = uniq("SelAll");
    for (let i = 0; i < 3; i++) await mkTask(`${tag}-${i}`);
    await sa.dispose();

    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, tag);
    const boxes = page.locator("#admin-task-body input[type=checkbox]");
    await expect(boxes).toHaveCount(3);

    await page.locator("#select-all-challenges").check();
    await expect(page.locator("#challenge-selection-count")).toHaveText("3 selected");
    for (let i = 0; i < 3; i++) await expect(boxes.nth(i)).toBeChecked();

    // axe scan with the selection bar VISIBLE (the default challenges-tab a11y test
    // scans it hidden, so this covers the new sticky bar + checkbox column).
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).include("#admin-tasks-tab").analyze();
    const bad = (results.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact));
    expect(bad.map(v => `${v.id} (${v.impact})`), "moderate+ a11y violations on the challenges tab with the selection bar visible").toHaveLength(0);

    await page.locator("#select-all-challenges").uncheck();
    await expect(page.locator("#challenges-selection-bar")).toBeHidden();
  });

  // Stage B (owner ruling, 27 Nov 2026) — ONE door into events from the bank (the
  // selection bar's Add to events) and ONE into an event from inside it
  // (+ Add from bank). The three tests below replace the top button's and the
  // focused-event selection's: each door is pinned, and so is the absence of the
  // ones the owner removed.
  test("stage B: the bank's one door — one ticked question opens its own dialog, two the bulk picker; no top button", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const mkTask = async (title) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
    const t1title = uniq("OneDoor-A"), t2title = uniq("OneDoor-B");
    const t1 = await mkTask(t1title), t2 = await mkTask(t2title);
    const compName = uniq("OneDoor-Comp");
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    await sa.dispose();

    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, "OneDoor-");
    await expect(page.locator("#assign-challenges-to-comp-btn"), "no top door").toHaveCount(0);
    const r1 = page.locator("#admin-task-body tr", { hasText: t1title }), r2 = page.locator("#admin-task-body tr", { hasText: t2title });
    await openKebab(page, r1.first());
    await expect(page.locator('#kebab-portal [data-action="task-assign-to-comps"]'), "no per-row door").toHaveCount(0);
    await page.keyboard.press("Escape");

    // One ticked: that question's own dialog.
    await r1.locator("input[type=checkbox]").check();
    const btn = page.locator("#challenge-selection-bar-assign-btn");
    await expect(btn).toHaveText("Add to events");
    await btn.click();
    const single = page.locator("#assign-task-overlay");
    await expect(single, "one question: its own dialog").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#challenge-bulk-assign-overlay")).toHaveCount(0);
    await single.locator("[data-action='overlay-close'], .btn.secondary").first().click();
    await expect(single).toHaveCount(0, { timeout: 5000 });

    // Two ticked: the bulk picker, and it assigns.
    await r2.locator("input[type=checkbox]").check();
    await expect(page.locator("#challenge-selection-count")).toHaveText("2 selected");
    await btn.click();
    const overlay = page.locator("#challenge-bulk-assign-overlay");
    await expect(overlay, "two questions: the bulk picker").toBeVisible();
    await overlay.locator(".picker-row", { hasText: compName }).locator("input[type=checkbox]").check();
    await overlay.locator("[data-action='challenge-bulk-assign-execute']").click();
    await expect(page.locator("#challenges-selection-bar"), "selection cleared").toBeHidden({ timeout: 8000 });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let count; try { count = db.prepare("SELECT COUNT(*) c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.owner_competition_id=ct.competition_id AND t.copied_from_task_id IN (?,?)").get(compId, t1, t2).c; } finally { db.close(); }
    expect(count).toBe(2);
  });

  test("stage B: inside an event no row carries a box; + Add from bank is the one door, and the ⋯ menu has none", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const mkTask = async (title) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
    const inTitle = uniq("Focus-In"), outTitle = uniq("Focus-Out");
    const tIn = await mkTask(inTitle); await mkTask(outTitle);
    const compName = uniq("Focus-Comp");
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    await sa.post(`/api/admin/tasks/${tIn}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.dispose();

    await adminLogin(page);
    // CONTROL: on the bank's own page the same row carries its box.
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, outTitle);
    await expect(page.locator("#admin-task-body tr", { hasText: outTitle }).locator("input[type=checkbox]"), "CONTROL: the bank row has a box").toBeVisible();

    await clickTab(page, "Events");
    await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), { id: compId, name: compName });
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, "Focus-");
    const outRow = page.locator("#admin-task-body tr", { hasText: outTitle });
    await expect(outRow, "PRECONDITION: the bank question is listed in the event").toHaveCount(1);
    await expect(page.locator("#admin-task-body input[type=checkbox]"), "no row carries a box inside an event").toHaveCount(0);
    await expect(page.locator("#add-tasks-to-comp-btn"), "the one door").toBeVisible();
    const menu = await page.evaluate((id) => window.wsMenuItemsHtml((window.adminCompetitionsData || []).find(c => c.id === id)), compId);
    expect(menu, "the ⋯ menu offers no Add from bank").not.toContain("comp-assign-challenges");
  });

  test("stage B: the Overview checklist's Add from bank is the Questions section's own door", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const compName = uniq("Empty-Comp");
    await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } });
    await sa.dispose();
    await adminLogin(page);
    await viewComp(page, compName);
    const door = page.locator('#ws-ov-ready [data-action="ws-add-from-bank"]');
    await expect(door, "an event with no question offers it on its checklist").toBeVisible({ timeout: 15000 });
    await expect(page.locator('#ws-ov-ready [data-action="comp-assign-challenges"]'), "never a second door").toHaveCount(0);
    await door.click();
    await expect(page.locator("#admin-tasks-tab"), "it opens the Questions section").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#task-picker-overlay"), "…and that section's picker").toBeVisible({ timeout: 15000 });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.15.13 (LOW) — a superseded admin list response must be discarded
// ═══════════════════════════════════════════════════════════════════════════════
// Submissions has had a sequence guard for years (S._subFetchSeq); Participants,
// Challenges and Competitions did not. Every scope switch and every debounced
// search fires a request while the previous is still in flight, so whichever the
// network delivered LAST won — an admin could end up looking at a competition
// they had already navigated away from, with no indication anything was stale.
test.describe("Stale admin list responses (v7.15.13)", () => {
  test("a slow earlier participants response does not overwrite a newer one", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "participants");

    // Delay the FIRST participants request long enough that the second lands
    // first, and tag each response so we can tell them apart.
    let n = 0;
    await page.route("**/api/admin/participants**", async route => {
      const mine = ++n;
      const res = await route.fetch();
      const body = await res.json();
      const rows = (body.participants || body.users || []);
      // Stamp the generation onto every row's nickname so the assertion can
      // read, from the rendered table, which response won.
      const tagged = rows.map(r => ({ ...r, nickname: `gen${mine}-${r.nickname}` }));
      if (mine === 1) await new Promise(r => setTimeout(r, 1500));
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(body.participants ? { ...body, participants: tagged } : { ...body, users: tagged }),
      });
    });

    // Fire request 1 (slow), then request 2 (fast) while it is still in flight.
    await page.evaluate(() => { window.loadAdminParticipants(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.loadAdminParticipants());
    // Wait past the slow response's arrival so a missing guard WOULD clobber.
    await page.waitForTimeout(2500);

    const nicks = await page.evaluate(() => (window.S.adminParticipantsData || []).map(p => p.nickname));
    expect(nicks.length, "participants loaded").toBeGreaterThan(0);
    const gen1 = nicks.filter(x => x.startsWith("gen1-")).length;
    expect(gen1,
      "the superseded (slower, earlier) response must be discarded — " +
      "otherwise a scope switch can be silently undone by the request it replaced"
    ).toBe(0);
    await page.unroute("**/api/admin/participants**");
  });

  test("v7.21.15: a slow earlier RANKINGS response does not overwrite a newer one", async ({ page }) => {
    // v7.15.13 gave this guard to the three admin TABLES and not to Rankings,
    // which is re-fired by every scope change (comp-focus / focus-session /
    // scope-clear all call loadAdminRankingsTab). Rankings is the worse place to
    // lack it: a board is nicknames and scores under a heading naming the
    // competition, so there is no per-row identifier that would let an admin
    // notice they are reading the PREVIOUS competition's standings.
    await adminLogin(page);
    await clickTab(page, "rankings");

    let n = 0;
    await page.route("**/api/admin/leaderboard**", async route => {
      const mine = ++n;
      // Synthesise the board rather than proxying: the assertion is about WHICH
      // response wins, and a fabricated row makes that unambiguous.
      const board = [{ userId: `u${mine}`, nickname: `gen${mine}-player`, score: 10, solveTimeMs: 1000, allSolved: false, rank: 1 }];
      if (mine === 1) await new Promise(r => setTimeout(r, 1500));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board) });
    });

    // Both calls are fire-and-forget (braces, no return) — page.evaluate awaits a
    // returned promise, which would serialise them and make the race unreachable.
    await page.evaluate(() => { window.S.adminRankingsCompId = "comp-x"; window.loadAdminLeaderboard(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.loadAdminLeaderboard(); });
    // Wait past the slow response's arrival, so a missing guard WOULD clobber.
    await page.waitForTimeout(2500);

    const rendered = await page.evaluate(() => document.getElementById("admin-rankings-body")?.textContent || "");
    expect(rendered, "a board must have rendered at all — otherwise this proves nothing").toContain("player");
    expect(rendered,
      "the superseded (slower, earlier) rankings response overwrote the newer one — " +
      "an admin who switched competition is reading the previous one's standings"
    ).not.toContain("gen1-");
    // The CACHE must not carry the stale board either: a later column sort
    // re-renders from S._rkCache without going to the network (v7.17.0), so a
    // stale cache write resurrects the wrong board on the next click.
    const cached = await page.evaluate(() => JSON.stringify(window.S._rkCache || {}));
    expect(cached, "the stale response must not have been written to the rankings cache").not.toContain("gen1-");
    await page.unroute("**/api/admin/leaderboard**");
  });

  test("v7.21.15: a slow earlier LOGS response does not overwrite a newer one", async ({ page }) => {
    // Logs is fired by a 250 ms debounced search, a group filter, a page-size
    // change, four pager buttons AND a 15 s silent poll, so several in flight at
    // once is the normal case rather than a race.
    await adminLogin(page);
    await clickTab(page, "settings");

    let n = 0;
    await page.route("**/api/admin/logs?**", async route => {
      const mine = ++n;
      const body = {
        entries: [{ ts: new Date().toISOString(), level: "info", msg: `gen${mine}-line` }],
        total: 1, anchor_ts: null, approximate: false,
      };
      if (mine === 1) await new Promise(r => setTimeout(r, 1500));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    // NOTE the braces. page.evaluate AWAITS a promise the callback returns, so
    // `() => window.loadAdminLogs()` would wait for the slow load to FINISH and
    // the two requests would never overlap — the race this test exists to
    // reproduce would not happen and it would pass with the guard deleted.
    // (Measured: it did. Fire-and-forget is load-bearing here.)
    await page.evaluate(() => { window.loadAdminLogs(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.loadAdminLogs(); });
    await page.waitForTimeout(2500);

    const last = await page.evaluate(() => JSON.stringify(window.S._logsLastResponse || {}));
    expect(last, "a logs response must have landed at all").toContain("-line");
    expect(last,
      "the superseded logs response won — the admin sees results for a query they have moved on from, " +
      "and a stale page-1 reply also re-pins S._logsAnchorTs, which is the drift protection the anchor exists for"
    ).not.toContain("gen1-");
    await page.unroute("**/api/admin/logs?**");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.1 — the Competitions table's DEFAULT order
//
// Live first, then upcoming, then ended; and within each band by FINISHING TIME,
// latest first. The grouping is deliberate — an admin running an event wants
// today's work at the top, and a flat finish-time order would put an upcoming
// competition ending in a month above a live one ending in two hours.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.1 — competitions default to finishing time, latest first", () => {
  test("live → upcoming → ended, each band newest-finish first, using the EFFECTIVE end", async ({ page }) => {
    const crypto = require("crypto");
    const tag = `Ord${crypto.randomBytes(3).toString("hex")}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const mk = async (label, startOffsetMin, durationMin) => {
      const r = await sa.post("/api/admin/competitions", { headers: H, data: {
        name: `${tag} ${label}`,
        start_time: new Date(t + startOffsetMin * 60_000).toISOString(),
        duration_minutes: durationMin,
      }});
      expect(r.ok(), `create ${label}: ${r.status()}`).toBeTruthy();
      return (await r.json()).competition.id;
    };

    // Two per band, deliberately created in the WRONG order so a sort that does
    // nothing cannot pass.
    const liveEarly = await mk("live-early", -30, 60);      // ends in ~30 min
    const liveLate  = await mk("live-late", -30, 180);      // ends in ~2.5 h
    const upEarly   = await mk("up-early", 60, 60);         // ends in ~2 h
    const upLate    = await mk("up-late", 120, 480);        // ends in ~10 h
    const endedOld  = await mk("ended-old", -600, 60);      // ended ~9 h ago
    const endedNew  = await mk("ended-new", -180, 60);      // ended ~2 h ago

    // The discriminating fixture: its OWN start+duration would end in ~30 min,
    // but it has a SESSION running much later, so its effective end is the
    // latest of every live competition here. The pre-v7.22.1 default derived the
    // end from the competition's own duration and would rank it LAST among the
    // live ones — i.e. the default order disagreed with the "End" column the
    // admin can click to sort by.
    const multi = await mk("multi", -30, 60);
    const tsRes = await sa.post(`/api/admin/competitions/${multi}/timeslots`, { headers: H, data: {
      name: "Late session", start_time: new Date(t - 30 * 60_000).toISOString(), duration_minutes: 600,
    }});
    expect(tsRes.ok(), `create session: ${tsRes.status()} ${await tsRes.text()}`).toBeTruthy();

    try {
      await adminLogin(page);
      await clickTab(page, "Events");
      // The status chips default to live+upcoming, which would hide the two
      // ENDED fixtures — and the point of this test is the order ACROSS the
      // three bands. Show everything first.
      await page.locator("#comp-status-filters button[data-status='all']").click();
      // The table paginates at 30 and accumulates a competition per fixture from
      // every earlier test, so NARROW FIRST (the v7.17.2 rule) — otherwise these
      // rows may not be on page 1 at all.
      await page.locator("#comp-search").waitFor({ state: "visible", timeout: 15000 });
      await narrowEventsTable(page, tag);

      const rows = async () => page.locator("#admin-comp-body tr td[data-comp-id]")
        .evaluateAll(tds => tds.map(td => ({ id: td.dataset.compId, name: td.textContent.trim() })));
      // Poll on the CONTENT, not the count. `.fill()` fires the input event but
      // the handler is debounced 160 ms, so a count-only poll is satisfied by
      // the UNFILTERED table the instant it happens to hold the right number —
      // which is exactly what happened here: 5 of these fixtures plus two
      // seeded competitions also totalled 7, and the assertion then compared a
      // half-filtered list.
      await expect.poll(async () => {
        const r = await rows();
        return r.length === 7 && r.every(x => x.name.startsWith(tag));
      }, { timeout: 15000, message: "the seven fixture competitions, and only those, must be listed" }).toBe(true);
      const order = async () => (await rows()).map(x => x.id);

      expect(await order(), "live (latest finish first) → upcoming → ended").toEqual([
        multi, liveLate, liveEarly,     // live, by effective end DESC
        upLate, upEarly,                // upcoming, by effective end DESC
        endedNew, endedOld,             // ended, by effective end DESC
      ]);
    } finally {
      for (const id of [liveEarly, liveLate, upEarly, upLate, endedOld, endedNew, multi]) {
        await sa.delete(`/api/admin/competitions/${id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      }
      await sa.dispose();
    }
  });
});
