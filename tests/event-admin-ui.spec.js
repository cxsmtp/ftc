"use strict";

// v8.7.0 — THE EVENT-ADMIN TIER, IN A REAL BROWSER.
//
// `event-admin-scope.api.spec.js` locks what the SERVER refuses. This file locks
// what the CLIENT OFFERS, which is the other half of the same rule and the half
// nothing else can see: "gate the affordance and the EXPLANATION together"
// (v7.14.2). A control the server is certain to refuse, left on screen, is
// reported as a broken feature; a control silently removed from a tier that
// should have it is a support ticket nobody can diagnose from any screen.
//
// EVERY gate here is asserted in BOTH directions, and the choice of control is
// deliberate rather than decorative:
//
//   • the LOGS item is hidden for an event admin only, so its control is a
//     REGULAR ADMIN — who must still see it. A superadmin control would be
//     satisfied by a build that hid Logs from everyone below superadmin, which
//     is a different (and wrong) rule.
//   • the SETTINGS item is superadmin-only and predates this release
//     (v7.26.0), so an event admin losing it proves nothing on its own; the
//     regular-admin row is what keeps this file honest about which rule is which.
//   • the EVENTS list carries a DECOY (`world.theirs`) — with one competition a
//     build that dropped the scope filter renders exactly the same table — and
//     the ZERO-GRANT actor, who is the fail-open catcher: `scopedCompetitionIds`
//     answers `[]` for them, and the naive `ids.length ? clause : ""` therefore
//     leaves the query UNFILTERED for precisely the actor who must see nothing.
//
//     DO NOT repeat the claim that `IN ()` is a SQLite syntax error — three
//     comments in this tree say so and it is FALSE. Measured against the shipped
//     better-sqlite3 (SQLite 3.53.4): `WHERE id IN ()` is ACCEPTED and evaluates
//     FALSE, so it is behaviourally identical to ` AND 1=0`. The `1=0` branch is
//     still right (it is explicit, and portable to engines that do reject the
//     empty list) — but the hazard it guards is the UNFILTERED `""`, and only
//     that. A test written against the syntax-error story locks nothing.
//
// Fixtures: `buildWorld()` from ./event-admin-helpers, never a hand-rolled one,
// and never the seeded alice/bob/carol — tests/isolated-test.js asserts in an
// afterAll that those three still hold `role: 'participant'`, so a promotion
// left behind fails the whole FILE and names it. There is no seedTestData()
// call: the harness re-seeds before every spec FILE and the seed is not
// idempotent.
//
// SINGLE SESSION PER USER is why every fixture write lives in `beforeAll`.
// `adminLogin(page)` signs the BROWSER in as the built-in superadmin, which
// invalidates the `world.sa` request context that built the fixtures — so the
// tests below read the DOM and never write as the superadmin afterwards.
const { test, expect } = require("./isolated-test");
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const {
  clickTab, openKebab, findSeededTaskRow, adminLogin, loginViaApi, filterComps,
  AxeBuilder, AXE_GATED_IMPACTS, narrowPeopleTable } = require("./ui-admin-helpers");
const {
  H, uniq, buildWorld, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin, withLegacySharedAssign,
} = require("./event-admin-helpers");

// Route page.goto() and page.request.* at THIS worker's server rather than a
// config-level default, which would collapse every worker onto one port.
test.use({ baseURL: BASE });

const navItem = (page, tabId) =>
  page.locator(`li:has(> [data-action='admin-tab'][data-tab-id='${tabId}'])`);

/**
 * The request log's door: the Audit page's "Raw logs" switch (Logs has no
 * sidebar item of its own). Opens Audit and returns the switch once the pane's
 * own "Audit trail" switch shows, so a hidden Raw logs is a decision of the
 * pane's role gate, never a pane that did not open.
 */
async function rawLogsSwitch(page) {
  await page.locator("button.admin-nav-item[data-tab-id='admin-audit-tab']").click();
  await expect(page.locator("#admin-audit-tab #audit-view-trail"), "PRECONDITION: the Audit page opened").toBeVisible({ timeout: 15000 });
  return page.locator("#admin-audit-tab #audit-view-raw");
}

/**
 * Sign the BROWSER in and land on a SETTLED admin panel.
 *
 * The readiness signal is a nav BUTTON being VISIBLE, never `#main-nav` being
 * attached: the shell ships `<nav id="main-nav">` statically, so an attachment
 * wait is satisfied at first paint — before boot has resolved who we are, which
 * is the whole subject of this file (v8.3.33). The admin sidebar's buttons are
 * static markup too, but they live INSIDE `#admin-page`, which is display:none
 * until boot shows it, so `visible` there cannot be true too early.
 *
 * Competitions is the settle signal because BOTH tiers have it. Never Logs or
 * Settings — those are the things under test.
 */
async function adminPanelLogin(page, email, password) {
  await loginViaApi(page, email, password);
  // Asserted rather than assumed: loginViaApi can succeed on a retry, and a
  // session that did not survive otherwise surfaces 30 s later as a locator
  // timeout naming nothing (the v7.23.5 lesson).
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `${email} had no live admin session before goto("/"): `
    + `${meR.status()} ${await meR.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']")
    .first().waitFor({ state: "visible", timeout: 30000 });
  return meR;
}

/** The event admin, with its tier asserted as a precondition. */
async function eventAdminLogin(page, world) {
  const meR = await adminPanelLogin(page, world.ea.email, PARTICIPANT_PASS);
  const me = await meR.json();
  expect(me.isEventAdmin, "the fixture really holds the event-admin tier").toBe(true);
  expect(me.isSuperAdmin, "…and is NOT a superadmin").toBeFalsy();
  expect(me.eventAdminCompetitionCount, "…and organises exactly one event").toBe(1);
}

/**
 * Enter Analytics and stop at the UNSCOPED prompt.
 *
 * `openAnalyticsTab()` deliberately CONSUMES the prompt's "Show platform-wide"
 * action when it is there, which is right for every caller that wants rows and
 * wrong for the only test whose subject is whether that action EXISTS. The poll
 * below is that helper's own settle shape, minus the click: the pane must land
 * in a real state before anything is asserted, and the signal cannot be
 * `#analytics-table-card` (static markup, visible on first paint) or a stale
 * `#analytics-summary` (may hold the previous visit's panel), so the summary is
 * cleared first and any content in it afterwards is from this entry.
 */
async function openAnalyticsUnscoped(page) {
  const btn = page.locator("button[data-tab-id='admin-analytics-tab']").first();
  await btn.waitFor({ state: "attached" });
  await page.evaluate(() => { const el = document.getElementById("analytics-summary"); if (el) el.textContent = ""; });
  await btn.evaluate(el => el.click());
  await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 10000 });
  await expect
    .poll(async () => (await page.locator("#analytics-summary").innerText().catch(() => "")).trim(),
      { timeout: 20000, message: "the analytics pane never settled into any state" })
    .not.toBe("");
}

test.describe("v8.7.0 — the event-admin tier in the browser", () => {
  let world;
  let regular;                 // a REGULAR admin — the control for the Logs rule
  let ownTask, othersTask, publicDraft, ownDraft, decoyTask;
  let sharedOwnTask, saAssigned, eaAssigned;   // v8.8.5
  let peerOrganiser;   // v8.7.4 — a FELLOW event admin, enrolled in the shared event
  let ownGroup, boundGroup, decoyGroup;

  test.beforeAll(async () => {
    world = await buildWorld();
    const { sa, saCsrf } = world;

    // A REGULAR admin. `makeParticipant` registers WITH a password, so this
    // needs no reset-link dance — the role route alone is enough, and the
    // account is one this file minted, never a seeded fixture.
    regular = await makeParticipant(sa, saCsrf, "regularadmin");
    const rr = await sa.post(`/api/admin/participants/${regular.id}/role`, {
      headers: H(saCsrf), data: { role: "admin" },
    });
    expect(rr.ok(), `promote to admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();

    // v8.7.4 — A FELLOW ORGANISER the event admin can actually SEE.
    //
    // `participantDenied` refuses any target who is not enrolled in one of the
    // actor's events, so the peer must be BOTH enrolled in `mine` and hold the
    // event-admin tier — otherwise the read-only assertion below would pass for
    // the wrong reason (an out-of-scope row is simply absent from the list).
    // Two organisers sharing one event is the ordinary case this role exists for.
    peerOrganiser = await makeParticipant(sa, saCsrf, "peerorg");
    await enrol(sa, saCsrf, world.mine.id, [peerOrganiser.id]);
    await grantEventAdmin(sa, saCsrf, world.mine.id, peerOrganiser.id);

    // ── challenges ────────────────────────────────────────────────────────
    // OWNED by the event admin → editable, publishable, hideable.
    // v8.9.0 — TWO accepted answers, so the edit form renders an extra-answer
    // row for it: this is the CONTROL for the scoring-lock arm below, and with a
    // one-line key "every extra row is enabled" would be vacuous.
    ownTask = await makeTask(world.eaApi, world.eaCsrf, "owned", { correct_answer: "a\nb" });
    // Created by the superadmin and ASSIGNED to the event admin's own event, so
    // it is VISIBLE (taskViewDenied rule b) and NOT editable. Visible-but-not-
    // editable is the only shape that can tell "the kebab is gated by ownership"
    // apart from "the row is not there at all".
    othersTask = await makeTask(sa, saCsrf, "others");
    await assignTask(sa, saCsrf, othersTask.id, [world.mine.id]);
    // A DRAFT they can see but did not create — the only way to reach the
    // Publish item at all, since a draft cannot be assigned to an event. It is
    // visible through the `public-domain` tag (rule c).
    publicDraft = await makeTask(sa, saCsrf, "pubdraft", { status: "draft" });
    const tagR = await sa.post(`/api/admin/tasks/${publicDraft.id}/tags`, {
      headers: H(saCsrf), data: { tag: "public-domain" },
    });
    expect(tagR.ok(), `tag public-domain: ${tagR.status()} ${await tagR.text()}`).toBeTruthy();
    // OWNED and still a DRAFT — the CONTROL for the Publish gate. Publish renders
    // ONLY on a draft, so their own PUBLISHED challenge can never carry it and the
    // foreign-draft test below has no control without this row: nothing else in
    // this file asserts that `task-publish` renders for anybody, so a build that
    // removed the item or renamed its action would pass.
    ownDraft = await makeTask(world.eaApi, world.eaCsrf, "owndraft", { status: "draft" });

    // THE CHALLENGES DECOY — created by the superadmin, used ONLY by the event
    // they do not manage, and NOT public-domain, so it fails all three arms of
    // `taskViewDenied`. Without it every "this row is visible" assertion below is
    // equally true of a build with no challenge scoping at all, which is exactly
    // the decoy discipline this file already applies to the Events tab.
    decoyTask = await makeTask(sa, saCsrf, "decoy");
    await assignTask(sa, saCsrf, decoyTask.id, [world.theirs.id]);

    // ── v8.8.5 fixtures ───────────────────────────────────────────────────
    // OWNED by the event admin AND held by an event they do not run. This is the
    // one shape that separates `can_edit` from `can_edit_scoring`: they may edit
    // the challenge, and they may not move what somebody else is scoring on.
    // Nothing else in this file produces it, which is why nothing caught that the
    // strict flag had no client consumer at all.
    // v8.9.0 — TWO accepted answers, so the strict gate has an extra-answer row
    // and an Add button to disable, not only #tf-answer.
    sharedOwnTask = await makeTask(world.eaApi, world.eaCsrf, "sharedown", { correct_answer: "a\nb" });
    // A LIBRARY row another organiser's event holds: since event-owned questions
    // (lib/event-copies.js) an event holds its own copy, so this is the shape a
    // shared qualifying question and a database from before them keep. Built
    // through the previous release's assign doors.
    await withLegacySharedAssign(sa, saCsrf, () => assignTask(sa, saCsrf, sharedOwnTask.id, [world.theirs.id]));

    // For the assign picker: one row put on THEIR event by the superadmin (they
    // may not take it out) and one they put there themselves (they may).
    saAssigned = await makeTask(sa, saCsrf, "saput");
    await assignTask(sa, saCsrf, saAssigned.id, [world.mine.id]);
    eaAssigned = await makeTask(world.eaApi, world.eaCsrf, "eaput");
    await assignTask(world.eaApi, world.eaCsrf, eaAssigned.id, [world.mine.id]);

    // ── groups ────────────────────────────────────────────────────────────
    // Created BY the event admin → deletable by them.
    const gOwn = await world.eaApi.post("/api/admin/groups", {
      headers: H(world.eaCsrf), data: { name: `EA Own Group ${uniq("own")}` },
    });
    expect(gOwn.ok(), `ea creates a group: ${gOwn.status()} ${await gOwn.text()}`).toBeTruthy();
    ownGroup = await gOwn.json();
    ownGroup.name = ownGroup.name || ownGroup.group?.name;
    ownGroup.id = ownGroup.id || ownGroup.group?.id;

    // Created by the superadmin and BOUND to the event admin's event: visible
    // to them (groupViewDenied rule b) and NOT deletable (creator-only). Bound
    // to `mine` ONLY, so `can_write` stays true — which is what isolates Delete
    // from the separate cross-scope write rule (§9.2).
    const gBound = await sa.post("/api/admin/groups", {
      headers: H(saCsrf), data: { name: `EA Bound Group ${uniq("bound")}` },
    });
    expect(gBound.ok(), `sa creates a group: ${gBound.status()} ${await gBound.text()}`).toBeTruthy();
    const gb = await gBound.json();
    boundGroup = { id: gb.id || gb.group?.id, name: gb.name || gb.group?.name };
    const bind = await sa.post("/api/admin/competitions/assign", {
      headers: H(saCsrf), data: { groupIds: [boundGroup.id], competitionIds: [world.mine.id] },
    });
    expect(bind.ok(), `bind group to mine: ${bind.status()} ${await bind.text()}`).toBeTruthy();

    // THE GROUPS DECOY, the same shape one surface over: created by the
    // superadmin and bound ONLY to the event they do not manage, so neither arm
    // of `groupViewDenied` holds and it must not reach them at all.
    const gDecoy = await sa.post("/api/admin/groups", {
      headers: H(saCsrf), data: { name: `EA Decoy Group ${uniq("decoy")}` },
    });
    expect(gDecoy.ok(), `sa creates the decoy group: ${gDecoy.status()} ${await gDecoy.text()}`).toBeTruthy();
    const gd = await gDecoy.json();
    decoyGroup = { id: gd.id || gd.group?.id, name: gd.name || gd.group?.name };
    const bindDecoy = await sa.post("/api/admin/competitions/assign", {
      headers: H(saCsrf), data: { groupIds: [decoyGroup.id], competitionIds: [world.theirs.id] },
    });
    expect(bindDecoy.ok(), `bind decoy group to theirs: ${bindDecoy.status()} ${await bindDecoy.text()}`).toBeTruthy();

    // PRECONDITIONS on the wire, asserted before any browser test reads a DOM
    // rendered from them — otherwise a fixture that silently failed reports
    // itself as a client regression.
    const tasks = await (await world.eaApi.get("/api/admin/tasks")).json();
    const byId = id => (Array.isArray(tasks) ? tasks : []).find(t => t.id === id);
    expect(byId(ownTask.id)?.can_edit, "the ea's own challenge is editable").toBe(true);
    // v8.9.0 — both two-answer keys really are stored as two lines, or the
    // extra-answer assertions below are about a row that does not exist.
    expect(byId(ownTask.id)?.correct_answer, "the control holds two accepted answers").toBe("a\nb");
    expect(byId(sharedOwnTask.id)?.correct_answer, "the shared challenge holds two accepted answers").toBe("a\nb");
    expect(byId(sharedOwnTask.id)?.can_edit_scoring, "…and is the OWNED-but-shared shape").toBe(false);
    expect(byId(othersTask.id), "the assigned foreign challenge is VISIBLE").toBeTruthy();
    expect(byId(othersTask.id)?.can_edit, "…and not editable").toBe(false);
    expect(byId(publicDraft.id), "the public-domain draft is VISIBLE").toBeTruthy();
    expect(byId(publicDraft.id)?.can_edit, "…and not editable").toBe(false);
    // …and it is REALLY a draft. Publish never renders on a published row, so a
    // fixture that had silently been published would make "no Publish is offered"
    // pass for a reason that has nothing to do with ownership.
    expect(byId(publicDraft.id)?.status, "…and is really a DRAFT").toBe("draft");
    expect(byId(ownDraft.id)?.can_edit, "the ea's OWN draft is editable").toBe(true);
    expect(byId(ownDraft.id)?.status, "…and is really a DRAFT, or Publish could never render").toBe("draft");

    // The decoy must be ABSENT — and must EXIST, or its absence is evidence about
    // nothing. Both halves, in both directions.
    expect(byId(decoyTask.id), "the decoy challenge never reaches the event admin").toBeFalsy();
    const saTasks = await (await sa.get("/api/admin/tasks")).json();
    expect((Array.isArray(saTasks) ? saTasks : []).some(t => t.id === decoyTask.id),
      "…and it EXISTS, so the absence above is about SCOPE").toBe(true);

    const groups = await (await world.eaApi.get("/api/admin/groups")).json();
    const g = id => (Array.isArray(groups) ? groups : []).find(x => x.id === id);
    expect(g(ownGroup.id)?.can_delete, "the ea's own group is deletable").toBe(true);
    expect(g(boundGroup.id), "the bound group is VISIBLE").toBeTruthy();
    expect(g(boundGroup.id)?.can_delete, "…and not deletable").toBe(false);
    // Both rows are located in the DOM BY NAME below, so an undefined name would
    // silently look for `tr:has-text('undefined')` and fail naming the wrong thing.
    expect(ownGroup.id && ownGroup.name, "the ea's group has an id and a name").toBeTruthy();
    expect(boundGroup.id && boundGroup.name, "the bound group has an id and a name").toBeTruthy();
    expect(g(decoyGroup.id), "the decoy group never reaches the event admin").toBeFalsy();
    const saGroups = await (await sa.get("/api/admin/groups")).json();
    expect((Array.isArray(saGroups) ? saGroups : []).some(x => x.id === decoyGroup.id),
      "…and it EXISTS, so the absence above is about SCOPE").toBe(true);
  });

  // ── 1. the nav items ───────────────────────────────────────────────────────

  test("an event admin has no Raw logs switch, no Users & roles and no Settings item", async ({ page }) => {
    await eventAdminLogin(page, world);

    // The sidebar really rendered — without this, "no Logs item" is equally
    // satisfied by an admin panel that never built its nav.
    await expect(navItem(page, "admin-competitions-tab"),
      "the admin sidebar really rendered").toBeVisible();
    await expect(navItem(page, "admin-tasks-tab")).toBeVisible();

    // The <li>, not the <button>. The gate hides the list item so the control
    // leaves the TAB ORDER as well as the layout — a translated-but-present
    // control is still a tab stop (v7.23.7) — and asserting the button alone
    // would be a different, weaker claim.
    await expect(navItem(page, "admin-users-tab"),
      "Users & roles is hidden for an event admin (users.view is not theirs)").toBeHidden();
    await expect(navItem(page, "admin-settings-tab"),
      "Settings is hidden for an event admin").toBeHidden();
    // The request log's door is the Audit page's Raw logs switch.
    await expect(await rawLogsSwitch(page),
      "Raw logs is hidden for an event admin — the request log covers the platform").toBeHidden();
  });

  test("CONTROL — a REGULAR admin has Raw logs, Users & roles and Settings (for the certificate designer)", async ({ page }) => {
    // THE SHARPER OF THE TWO CONTROLS. Raw logs is hidden for the event-admin
    // tier ALONE, so a superadmin control cannot tell the shipped rule from a
    // build that hid it from everyone below superadmin. A regular admin can.
    await adminPanelLogin(page, regular.email, PARTICIPANT_PASS);
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isAdmin, "the control IS an admin").toBe(true);
    expect(me.isSuperAdmin, "…and is NOT a superadmin").toBeFalsy();
    expect(me.isEventAdmin, "…and is NOT an event admin").toBeFalsy();

    await expect(navItem(page, "admin-users-tab"),
      "Users & roles IS shown to a regular admin (users.view)").toBeVisible();
    // Settings opens for settings.view / certificates.design, which an admin
    // holds and an event admin does not (the test above): the item is shown,
    // its superadmin-only cards hide themselves (tests/settings-admin-certificates.spec.js).
    await expect(navItem(page, "admin-settings-tab"),
      "Settings is shown to a regular admin").toBeVisible();
    await expect(await rawLogsSwitch(page),
      "Raw logs IS shown to a regular admin — the hide is about the event-admin tier").toBeVisible();
  });

  test("CONTROL — a superadmin sees Raw logs AND Settings", async ({ page }) => {
    await adminLogin(page);
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isSuperAdmin, "the control really is a superadmin").toBe(true);

    await expect(navItem(page, "admin-users-tab")).toBeVisible();
    await expect(navItem(page, "admin-settings-tab")).toBeVisible();
    await expect(await rawLogsSwitch(page)).toBeVisible();
  });

  // ── 2. the header label ────────────────────────────────────────────────────

  test('the header says "Event Admin", not "Admin"', async ({ page }) => {
    await eventAdminLogin(page, world);
    await expect(page.locator("#profile-menu-btn"), "the account button names the tier (the role chip of its menu)").toHaveAttribute("data-role", "Event Admin");
    await expect(page.locator("#admin-panel-title")).toHaveText("Event Admin Panel");
    const { openAccountMenu } = require("./chrome-helpers");
    const menu = await openAccountMenu(page);
    await expect(menu.locator(".pm-role"), "the menu's role chip says it in words").toHaveText("Event Admin");
  });

  test('CONTROL — a regular admin says "Admin" and a superadmin says "Superadmin"', async ({ page }) => {
    // Without this pair, "the header says Event Admin" is satisfied by a build
    // that hard-codes that label for every non-superadmin.
    await adminPanelLogin(page, regular.email, PARTICIPANT_PASS);
    await expect(page.locator("#profile-menu-btn")).toHaveAttribute("data-role", "Admin");
    await expect(page.locator("#admin-panel-title")).toHaveText("Admin Panel");

    // Tear the first SPA down before signing in again. Two logins in one page is
    // the v7.19.0 trap: the booted app keeps polling with the PRE-regeneration
    // CSRF token, and the fetch interceptor reads that mismatch as a dead session
    // and POSTs /api/logout — destroying the session just established, which
    // surfaces as a header-text timeout naming nothing.
    await page.goto("about:blank");
    await adminLogin(page);
    await expect(page.locator("#profile-menu-btn")).toHaveAttribute("data-role", "Superadmin");
    await expect(page.locator("#admin-panel-title")).toHaveText("Superadmin Panel");
  });

  // ── 3. + New Event ───────────────────────────────────────────────────

  test("+ New Event is hidden for an event admin", async ({ page }) => {
    // The server refuses POST /api/admin/competitions outright, so leaving the
    // button up would open a whole create wizard whose Save is certain to fail.
    await eventAdminLogin(page, world);
    await clickTab(page, "Events");   // the loader is what sets the display
    await expect(page.locator("#new-competition-btn")).toBeHidden();
  });

  test("CONTROL — a regular admin CAN see + New Event", async ({ page }) => {
    await adminPanelLogin(page, regular.email, PARTICIPANT_PASS);
    await clickTab(page, "Events");
    await expect(page.locator("#new-competition-btn"),
      "a globally-scoped admin keeps the create control").toBeVisible();
  });

  // ── 4. the Events tab ──────────────────────────────────────────────────────

  test("the Events tab lists only the granted event — and not the decoy", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Events");

    const body = page.locator("#admin-comp-body");
    await expect(body).toContainText(world.mine.name);
    await expect(body,
      "the decoy event must not be listed — with one competition an unfiltered "
      + "list is indistinguishable from a correctly scoped one").not.toContainText(world.theirs.name);

    // …and the MODEL, not only the paint. The competitions table defaults its
    // status chips to live+upcoming, so a DOM-only absence assertion could be
    // satisfied by a browsing filter rather than by the server's scope. Both
    // fixtures are live, so the model is the honest witness.
    const ids = await page.evaluate(() => (window.S?.adminCompetitionsData || []).map(c => c.id));
    expect(ids, "the granted event reached the client").toContain(world.mine.id);
    expect(ids, "the decoy never reached the client at all").not.toContain(world.theirs.id);
  });

  test("CONTROL — the decoy event is REAL, and a superadmin sees both", async ({ page }) => {
    // Without this, "the decoy is absent" is equally satisfied by a decoy that
    // was never created, or one that no admin tier can render — neither of which
    // is the rule under test. Seeing BOTH here is what makes the event admin's
    // one-row table evidence about SCOPE rather than about existence.
    await adminLogin(page);
    await clickTab(page, "Events");
    const ids = await page.evaluate(() => (window.S?.adminCompetitionsData || []).map(c => c.id));
    expect(ids, "an unscoped actor sees the granted event").toContain(world.mine.id);
    expect(ids, "…and the decoy, which therefore exists and is renderable").toContain(world.theirs.id);
    await filterComps(page, world.theirs.name);
    await expect(page.locator(`#admin-comp-body tr:has-text('${world.theirs.name}')`).first()).toBeVisible();
  });

  test("ZERO GRANTS SEES NO EVENTS — the empty-scope fail-open catcher", async ({ page }) => {
    // `scopedCompetitionIds` answers `[]` here, so the naive
    // `ids.length ? clause : ""` leaves the query UNFILTERED for exactly the
    // actor who must see nothing. This is the assertion that catches it, in the
    // surface an operator would actually meet.
    await adminPanelLogin(page, world.zero.email, PARTICIPANT_PASS);
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isEventAdmin, "precondition: the actor really holds the tier").toBe(true);
    expect(me.eventAdminCompetitionCount, "…and has no events").toBe(0);

    // THE LIST MUST HAVE ANSWERED, NOT THROWN — and this is the half that was
    // missing. `renderLoadFailure` resets `S.adminCompetitionsData` to `[]`
    // (ui/list-controls.js) and paints a `.load-failed` row, so "the model is
    // empty and neither name is on screen" is ALSO exactly what a 500 leaves
    // behind. Without these lines this test — the one named "fail-open catcher"
    // — reports green against a pane that is completely broken for precisely the
    // actor it is about. Mutation-verified: a scope clause whose placeholders do
    // not match its params throws at `.all()`, the route 500s, and only these
    // assertions notice.
    const listR = await page.request.get("/api/admin/competitions");
    expect(listR.ok(), `the scoped list must ANSWER, not throw: ${listR.status()} ${await listR.text()}`).toBeTruthy();
    const listBody = await listR.json();
    expect(Array.isArray(listBody), "…with a real array, not an error object").toBe(true);
    expect(listBody, "…and it is EMPTY for an actor with no grants").toHaveLength(0);

    await clickTab(page, "Events");
    const ids = await page.evaluate(() => (window.S?.adminCompetitionsData || []).map(c => c.id));
    expect(ids, `an event admin with no grants must see NO events, saw ${ids.length}`).toHaveLength(0);
    await expect(page.locator("#admin-comp-body .load-failed"),
      "…and the pane rendered its EMPTY state, not its failure state").toHaveCount(0);
    await expect(page.locator("#admin-comp-body")).not.toContainText(world.mine.name);
    await expect(page.locator("#admin-comp-body")).not.toContainText(world.theirs.name);
  });

  // ── 5. the Challenges tab ──────────────────────────────────────────────────

  test("a challenge they do not own has no Edit / Hide, and SAYS WHY", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    // THE DECOY, read from the MODEL rather than the DOM: the challenges table
    // paginates and this pane is entered unfiltered, so a row's absence from the
    // page says nothing about whether the server sent it. The positive arm is
    // load-bearing too — it is what stops an unexposed `window.S` (which would
    // make the fallback `[]` and the negative arm trivially true) reading as a
    // correctly scoped list.
    //
    // POLLED, because the model lands only when the list's read answers, and
    // clickTab's settle (a row in #admin-task-body) is met earlier by the
    // loader's skeleton rows: a read straight after it saw the empty model on a
    // loaded CI runner. The negative arm reads one snapshot after the positive
    // matched, so it judges the list the server actually sent.
    const modelIds = () => page.evaluate(() => (window.S?.adminTasksData || []).map(t => t.id));
    await expect.poll(modelIds, { message: "the challenge used by their own event reached the client", timeout: 15000 })
      .toContain(othersTask.id);
    expect(await modelIds(), "…and the decoy, used only by an event they do not manage, did not")
      .not.toContain(decoyTask.id);

    const row = await findSeededTaskRow(page, othersTask.title);
    await expect(row.first(), "the foreign challenge IS visible — it is used by their event").toBeVisible();
    await openKebab(page, row.first());
    const portal = page.locator("#kebab-portal");

    await expect(portal.locator('[data-action="task-edit"]'),
      "Edit is owner-only for an event admin").toHaveCount(0);
    await expect(portal.locator('[data-action="task-toggle-visibility"]'),
      "Hide/Show is owner-only for an event admin").toHaveCount(0);
    // v7.14.2 — withheld WITH its reason. A menu that silently loses three items
    // is indistinguishable from a broken feature, and was reported as one.
    await expect(portal.locator(".kebab-note"),
      "the missing items are EXPLAINED, not merely absent").toContainText(/created by someone else/i);
    // The row is not merely inert: what they CAN do with it is still offered.
    // Stage B — the bank's one door into events is the selection bar, so using it
    // in their own events means the row carries its selection box.
    await page.keyboard.press("Escape");
    await expect(row.first().locator('input[data-change-action="challenge-select-toggle"]'),
      "they may still use it in their own events").toHaveCount(1);
  });

  test("a DRAFT they do not own has no Publish", async ({ page }) => {
    // Publish only ever renders on a draft, and a draft cannot be assigned to an
    // event — so the `public-domain` tag is the only route to a draft an event
    // admin can see but did not create. Without this case the Publish half of
    // the ownership gate has no coverage at all.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, publicDraft.title);
    await expect(row.first(), "the public-domain draft IS visible").toBeVisible();
    await openKebab(page, row.first());
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator('[data-action="task-publish"]'),
      "publishing somebody else's draft is refused, so it is not offered").toHaveCount(0);
    await expect(portal.locator(".kebab-note")).toBeVisible();
  });

  test("CONTROL — their OWN challenge keeps Edit and Hide, and their own DRAFT keeps Publish", async ({ page }) => {
    // Without this, every assertion above is satisfied by a build that removed
    // the kebab items from the Challenges tab entirely.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, ownTask.title);
    await expect(row.first()).toBeVisible();
    await openKebab(page, row.first());
    const portal = page.locator("#kebab-portal");

    await expect(portal.locator('[data-action="task-edit"]'), "the owner may edit").toHaveCount(1);
    await expect(portal.locator('[data-action="task-toggle-visibility"]'), "…and hide").toHaveCount(1);
    await expect(portal.locator(".kebab-note"),
      "nothing is withheld, so nothing is explained").toHaveCount(0);

    // THE PUBLISH CONTROL, which the foreign-draft test cannot supply for itself.
    // `task-publish` renders ONLY on a draft (challenges-admin.js), so the row
    // above — published — never carries it whatever the ownership rule says.
    // Without this row "somebody else's draft offers no Publish" is satisfied by
    // a build that dropped the item, or renamed its action, and reads as coverage
    // of a gate nothing exercises.
    const draftRow = await findSeededTaskRow(page, ownDraft.title);
    await expect(draftRow.first(), "their own draft is visible").toBeVisible();
    await openKebab(page, draftRow.first());
    await expect(portal.locator('[data-action="task-publish"]'),
      "the OWNER of a draft is offered Publish").toHaveCount(1);
    await expect(portal.locator(".kebab-note"),
      "…and nothing is withheld on it either").toHaveCount(0);
  });

  // ── v8.8.4 — the challenge ROW's own affordances ───────────────────────────
  //
  // Both tag routes are owner-only, and until now the row offered the controls
  // anyway on every challenge an event admin could merely SEE — the v7.14.2
  // affordance-that-lies defect, sitting on exactly the shared-pool row the
  // v8.8.2/v8.8.3 reports were about: an operator confirming the tag clicks the
  // × or + tag and meets a 403.
  // Stage B — free tags are not shown any more; the shared-pool switch and the
  // needs choices live in the editor's Topic and sharing row, which only the
  // owner reaches (both tag routes stay owner-only). So the door that is
  // withheld, WITH its reason, is the editor itself.
  test("the sharing controls are withheld on a challenge they do not own, WITH the reason", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, publicDraft.title);
    await expect(row.first(), "the public-domain draft IS visible — rule (c)").toBeVisible();
    // PRECONDITION: it really is the shared one (its badge), so "no editor" is
    // about ownership and not about an ordinary row.
    await expect(row.first().locator(".badge.shared-pool"), "the shared badge is on the row").toHaveCount(1);
    await expect(row.first().locator(".tag-x"), "no tag chip is rendered at all").toHaveCount(0);
    await expect(row.first().locator('[data-action="task-edit"]'),
      "the editor (and with it the sharing switch) is owner-only — the routes refuse it").toHaveCount(0);
    await expect(row.first().locator(".kebab-note"),
      "the door is withheld WITH its reason, not silently").toContainText(/created by someone else/i);
  });

  test("CONTROL — on their OWN challenge the sharing controls are offered", async ({ page }) => {
    // Without this, "the controls are absent" is satisfied by a build that removed
    // sharing from the Question bank for everybody.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, ownTask.title);
    await expect(row.first(), "their own challenge is visible").toBeVisible();
    await expect(row.first().locator('[data-action="task-edit"]'), "the owner may edit their own challenge").toHaveCount(1);
    await page.evaluate((tid) => window.editTask(tid), ownTask.id);
    await page.locator('[aria-controls="tf-org-body"]').click();
    await expect(page.locator("#tf-shared"), "the Shared with all organisers switch is offered").toBeVisible();
    await expect(page.locator("#tf-shared")).toBeEnabled();
    await page.locator("[data-action='close-task-form']").first().click();
  });

  // The shared-pool arm had NO on-row signal that did not require horizontal
  // scrolling: the only cue was the literal tag chip in column 11 of 13, on a
  // table forced to min-width:1372px. So an event admin could not tell "not
  // shown" from "shown, and I did not recognise it" — the exact ambiguity of the
  // original report. The badge lives in Status, column 5.
  test("a shared-pool challenge is badged in the Status column, without scrolling", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, publicDraft.title);
    const badge = row.first().locator(".badge.shared-pool");
    await expect(badge, "the shared-pool challenge is badged").toHaveCount(1);
    await expect(badge).toHaveText(/shared/i);

    // THE POINT OF THE FIX, asserted as geometry rather than as markup: the badge
    // must be inside the table card's VISIBLE box with the card unscrolled. A
    // presence assertion alone would pass with the badge in column 11 behind
    // hundreds of pixels of horizontal scroll, which is the state being fixed.
    const scroller = page.locator("#admin-tasks-tab .table-wrap, #admin-tasks-tab .card").first();
    const geom = await badge.evaluate((el, sel) => {
      const sc = el.closest(sel) || document.scrollingElement;
      const b = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
      return { scrollLeft: sc.scrollLeft, badgeRight: b.right, containerRight: s.right, badgeLeft: b.left, containerLeft: s.left };
    }, ".table-wrap, .card");
    expect(geom.scrollLeft, "the table is not pre-scrolled").toBe(0);
    expect(geom.badgeLeft, "the badge starts inside the visible box").toBeGreaterThanOrEqual(geom.containerLeft - 1);
    expect(geom.badgeRight, "…and ends inside it, with no horizontal scrolling")
      .toBeLessThanOrEqual(geom.containerRight + 1);
    await expect(scroller, "sanity: the scroller resolved").toHaveCount(1);
  });

  test("CONTROL — a challenge that is NOT in the shared pool carries no badge", async ({ page }) => {
    // Otherwise "the badge is present" is satisfied by a build that badges every row.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, ownTask.title);
    await expect(row.first().locator(".badge.shared-pool"),
      "an ordinary challenge is not in the shared pool").toHaveCount(0);
  });

  // ── v8.8.5 — the STRICT scoring gate finally has client consumers ──────────
  //
  // v8.7.0 computed `can_edit_scoring` expressly so the client would never offer
  // a scoring control the server refuses, with a comment reading "THE ANSWER, NOT
  // THE RULE". Nothing in public/js read it, so Publish, Hide/Show, the edit
  // form's scoring inputs and History → Restore were all gated on the weaker
  // `can_edit` while the server applied the strict gate to those exact doors.
  test("Publish and Hide are withheld — with their reason — on a challenge another event is scoring on", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, sharedOwnTask.title);
    await expect(row.first(), "the challenge they created is visible").toBeVisible();
    await openKebab(page, row.first());
    const portal = page.locator("#kebab-portal");

    // PRECONDITION: this is the OWNED-but-shared shape, not the not-mine shape.
    // Without asserting it, "Hide is absent" is equally satisfied by the ordinary
    // foreign-challenge case the file already covers, and the strict gate would
    // be untested.
    await expect(portal.locator('[data-action="task-edit"]'),
      "they DO own it — Edit is still offered").toHaveCount(1);
    await expect(portal.locator(".kebab-note"),
      "…so the note is the SCORING one, not the not-yours one")
      .toContainText(/another organiser's event is scoring/i);

    await expect(portal.locator('[data-action="task-toggle-visibility"]'),
      "Hide moves the all-solved denominator of an event they do not run").toHaveCount(0);
  });

  test("CONTROL — on a challenge they own that nobody else holds, Hide is offered", async ({ page }) => {
    // Without this, "Hide is absent" is satisfied by a build that removed Hide.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, ownTask.title);
    await openKebab(page, row.first());
    await expect(page.locator("#kebab-portal").locator('[data-action="task-toggle-visibility"]'),
      "their own unshared challenge is theirs to hide").toHaveCount(1);
    await expect(page.locator("#kebab-portal").locator(".kebab-note"),
      "…and nothing is withheld on it").toHaveCount(0);
  });

  test("the edit form disables the scoring fields, and says why", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, sharedOwnTask.title);
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-edit"]').click();

    await expect(page.locator("#tf-title"), "the form opened").toBeVisible({ timeout: 15000 });
    // Edit STAYS offered and the cosmetic fields stay editable: the PUT is keyed
    // on what changed, so a title fix on a shared challenge is legal and useful.
    await expect(page.locator("#tf-title"), "the title is still editable").toBeEnabled();
    await expect(page.locator("#tf-diff"), "difficulty is a scoring field").toBeDisabled();
    await expect(page.locator("#tf-answer"), "the correct answer is a scoring field").toBeDisabled();
    await expect(page.locator("#tf-attempt-cap"), "the attempt cap is a scoring field").toBeDisabled();
    // A pick-one question's Options box too: the PUT counts an options change
    // as a scoring edit, so an enabled box would offer a refused save.
    await expect(page.locator("#tf-any-options"), "the pick-one options are a scoring field").toBeDisabled();
    await expect(page.locator("#tf-scoring-locked-note"), "the reason is on screen, not implied")
      .toContainText(/another organiser's event is scoring/i);
    await expect(page.locator("#tf-scoring-locked-note"), "and it names the options among what is fixed")
      .toContainText("difficulty, answer, options and attempt limit are fixed");

    // v8.9.0 — the ADDITIONAL accepted answers are the same scoring field in
    // more boxes: every row's input and Remove button, and the Add button,
    // follow #tf-answer. PRECONDITION first — a row must exist, or "every row is
    // disabled" is satisfied by a form that rendered none.
    const extraInputs = page.locator("#tf-answers-extra input");
    const extraBtns = page.locator("#tf-answers-extra button");
    await expect(extraInputs, "the second accepted answer rendered as a row").toHaveCount(1);
    await expect(extraInputs.nth(0)).toHaveValue("b");
    await expect(extraBtns, "…with its Remove button").toHaveCount(1);
    for (let i = 0; i < await extraInputs.count(); i++) {
      await expect(extraInputs.nth(i), `extra answer input ${i} is a scoring field`).toBeDisabled();
    }
    for (let i = 0; i < await extraBtns.count(); i++) {
      await expect(extraBtns.nth(i), `extra answer Remove ${i} would move the key`).toBeDisabled();
    }
    await expect(page.locator("#tf-add-answer"), "adding an accepted answer would move the key").toBeDisabled();
  });

  test("CONTROL — the same form on an unshared challenge leaves the scoring fields alone", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, ownTask.title);
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-edit"]').click();
    await expect(page.locator("#tf-title")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#tf-diff"), "nothing is scoring on it but their own events").toBeEnabled();
    await expect(page.locator("#tf-any-options"), "…and the options box is theirs to change").toBeEnabled();
    await expect(page.locator("#tf-scoring-locked-note"), "…so no note").toBeHidden();

    // v8.9.0 — and the extra-answer controls are left alone too. Without this
    // half, "the rows are disabled" is satisfied by a build that disables them
    // on every edit.
    const extraInputs = page.locator("#tf-answers-extra input");
    const extraBtns = page.locator("#tf-answers-extra button");
    await expect(extraInputs, "the control's second answer rendered as a row").toHaveCount(1);
    await expect(extraInputs.nth(0)).toHaveValue("b");
    await expect(extraBtns).toHaveCount(1);
    for (let i = 0; i < await extraInputs.count(); i++) {
      await expect(extraInputs.nth(i), `extra answer input ${i} is theirs to edit`).toBeEnabled();
    }
    for (let i = 0; i < await extraBtns.count(); i++) {
      await expect(extraBtns.nth(i), `extra answer Remove ${i} is theirs to use`).toBeEnabled();
    }
    await expect(page.locator("#tf-add-answer"), "Add is offered…").toBeVisible();
    await expect(page.locator("#tf-add-answer"), "…and usable").toBeEnabled();
  });

  test("History offers no Restore on a challenge another event is scoring on", async ({ page }) => {
    // POST /tasks/:id/restore takes taskScoringEditDenied UNCONDITIONALLY — a
    // restore rewrites the whole row from a snapshot, so it can move the answer,
    // the difficulty and the published flag of a challenge somebody else scores on.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");

    // Give it a second version, or there is nothing but the current row and the
    // Action column can be empty for a reason that has nothing to do with the fix.
    const r = await page.request.put(`/api/admin/tasks/${sharedOwnTask.id}`, {
      headers: { "content-type": "application/json", "x-csrf-token": await page.evaluate(async () => (await (await fetch("/api/csrf-token")).json()).csrfToken) },
      data: { title: `${sharedOwnTask.title} v2` },
    });
    expect(r.ok(), `title edit (a cosmetic field is legal here): ${r.status()} ${await r.text()}`).toBeTruthy();

    await page.reload();
    await page.waitForSelector("#admin-page", { state: "visible" });
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, `${sharedOwnTask.title} v2`);
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-history"]').click();

    const dialog = page.locator("#hist-body");
    await expect(dialog, "the history dialog opened").toBeVisible({ timeout: 15000 });
    await expect(dialog.locator(".history-restore-btn"),
      "every Restore button here was certain to 403").toHaveCount(0);
    await expect(dialog, "withheld WITH its reason").toContainText(/not yours to restore/i);
  });

  test("the assign picker will not let them untick a row somebody else added", async ({ page }) => {
    // can_unassign is PER COMPETITION — an event admin may remove only the
    // assignments they made. The row kebab has honoured it since v8.7.0; this
    // dialog applied a strictly looser rule to the same action.
    await eventAdminLogin(page, world);
    await clickTab(page, "Events");
    await filterComps(page, world.mine.name);
    await page.locator(`tr:has-text("${world.mine.name}") [data-action="comp-open"]`).first().click();
    await clickTab(page, "Challenges");
    await page.locator("#add-tasks-to-comp-btn").click();

    const list = page.locator("#task-picker-list");
    await expect(list, "the picker opened").toBeVisible({ timeout: 15000 });

    const theirs = list.locator(`label.picker-row:has-text("${saAssigned.title}") input`);
    const mine = list.locator(`label.picker-row:has-text("${eaAssigned.title}") input`);

    // Both are IN the event — ticked. That is the precondition: the difference
    // under test is whether this actor may take them OUT.
    await expect(theirs, "the superadmin's assignment is ticked").toBeChecked();
    await expect(mine, "their own assignment is ticked").toBeChecked();

    await expect(theirs, "…and they may not remove it, so it is disabled").toBeDisabled();
    await expect(mine, "CONTROL — their own assignment stays theirs to remove").toBeEnabled();
    await expect(list.locator(`label.picker-row:has-text("${saAssigned.title}")`),
      "withheld WITH its reason").toHaveAttribute("title", /added to this event by someone else/i);
  });

  test("the bulk-assign toast names every skip reason the server sent", async ({ page }) => {
    // The server returns eight skip reasons; the client rendered five, so
    // outOfScope — the one a revoked grant produces for EVERY target — was
    // reported as nothing at all, leaving "0 assigned" with no explanation.
    // Mocked, because manufacturing a mid-request scope change is a race.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    await page.route("**/api/admin/tasks/assign-competitions", route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        ok: true, assigned: 0,
        skipped: { draft: 0, locked: 0, endedComp: 0, notFound: 0, missingComp: 0, outOfScope: 2, notOwned: 1, unfit: 1, unsealed: 3, authorCompetes: 1 },
        unfitReasons: ["A Booth Event cannot hold a file-answer challenge."],
      }),
    }));
    // Driven through the real controls: tick a challenge, open the bulk picker,
    // choose an event, execute. The private poster is not reachable from the page
    // and reaching for it would test a function rather than the flow.
    // Stage B — the bank's one door into events: the selection bar's Add to
    // events, which opens the BULK picker for two or more ticked questions.
    for (const t of [ownTask, othersTask]) {
      const row = await findSeededTaskRow(page, t.title);
      await row.first().locator('input[type="checkbox"]').check();
    }
    await expect(page.locator("#challenge-selection-count")).toHaveText("2 selected");
    await page.locator("#challenge-selection-bar-assign-btn").click();
    const overlay = page.locator("#challenge-bulk-assign-overlay");
    await expect(overlay, "the bulk picker opened").toBeVisible({ timeout: 15000 });
    await overlay.locator("#challenge-bulk-comp-list input[type=\"checkbox\"]").first().check();
    await overlay.locator('[data-action="challenge-bulk-assign-execute"]').click();

    const toast = page.locator("#toast-stack");
    await expect(toast, "the out-of-scope skips are named").toContainText(/2 event\(s\) you do not organise/i, { timeout: 15000 });
    await expect(toast, "…and the ones they cannot use").toContainText(/1 question\(s\) you cannot use/i);
    await expect(toast, "…and the server's own reason, which rode the response for exactly this")
      .toContainText(/booth event cannot hold a file-answer challenge/i);
    // v8.12.0 — the two staff-compete seal skips joined the ledger.
    await expect(toast, "the unsealed skips are named").toContainText(/3 not sealed/i);
    await expect(toast, "…and the author-competes skips").toContainText(/1 whose author competes/i);
  });

  test("Grant Attempts stops asserting what this actor cannot know", async ({ page }) => {
    // The kebab reads an event missing from the scoped model as "unknown,
    // therefore possibly capped" — deliberately, so the control is not hidden for
    // the capped-by-event case. The dialog then intersects with the scoped list,
    // finds nothing, and used to say no event limits attempts on the challenge,
    // which is not true — only unknowable to them.
    await eventAdminLogin(page, world);
    await clickTab(page, "Challenges");
    await page.evaluate(id => window.openAttemptGrant(id), sharedOwnTask.id);
    // The empty state renders TWO notes — the answer, then a standing paragraph
    // naming where a limit is set — so scope to the first rather than matching
    // both and failing strict mode for a reason unrelated to the subject.
    const note = page.locator("#attempt-grant-overlay .picker-note").first();
    await expect(note, "the dialog opened on its empty state").toBeVisible({ timeout: 15000 });
    await expect(note, "it speaks only for the events this actor organises")
      .toContainText(/no event you organise/i);
    await expect(note, "…and no longer asserts a platform-wide fact it cannot see")
      .not.toContainText(/every participant can keep trying/i);
  });

  // ── 6. the Groups tab ──────────────────────────────────────────────────────

  test("Delete is disabled — with a reason — on a group they did not create", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Groups");
    await page.locator("#groups-tbody tr").first().waitFor({ state: "visible", timeout: 15000 });

    // The groups decoy, in the MODEL — this table paginates too, so DOM absence
    // is not evidence. Paired with its positive arm for the same reason as the
    // challenges one above.
    const groupIds = await page.evaluate(() => (window.S?.adminGroupsData || []).map(g => g.id));
    expect(groupIds, "the group bound to their own event reached the client").toContain(boundGroup.id);
    expect(groupIds, "…and the one bound only to an event they do not manage did not")
      .not.toContain(decoyGroup.id);

    const foreign = page.locator(`#groups-tbody tr:has-text('${boundGroup.name}')`).first();
    await expect(foreign, "a group bound to their event IS visible to them").toBeVisible();
    const del = foreign.locator('[data-action="group-delete"]');
    await expect(del).toBeDisabled();
    // Gate the affordance and the EXPLANATION together: a disabled button with
    // no reason is a dead end, and the remedy ("ask an administrator") is the
    // only thing that makes it actionable.
    await expect(del).toHaveAttribute("title", /only delete groups you created/i);

    // …while what they MAY do with it is untouched. `can_write` is a separate
    // rule (§9.2, every bound event in scope) and this group is bound to their
    // event only, so Members/Rename must stay live — which is what proves the
    // Delete assertion is about the CREATOR rule and not a blanket lockout.
    await expect(foreign.locator('[data-action="group-manage-members"]')).toBeEnabled();
    await expect(foreign.locator('[data-action="group-rename"]')).toBeEnabled();
  });

  test("CONTROL — Delete is ENABLED on a group they created", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Groups");
    await page.locator("#groups-tbody tr").first().waitFor({ state: "visible", timeout: 15000 });

    const own = page.locator(`#groups-tbody tr:has-text('${ownGroup.name}')`).first();
    await expect(own).toBeVisible();
    const del = own.locator('[data-action="group-delete"]');
    await expect(del, "a build that disabled Delete for everybody would pass the test above").toBeEnabled();
    await expect(del).not.toHaveAttribute("title", /.+/);
  });

  // ── 7. Analytics ───────────────────────────────────────────────────────────

  test("Analytics offers no platform-wide scope to an event admin", async ({ page }) => {
    await eventAdminLogin(page, world);
    await openAnalyticsUnscoped(page);

    await expect(page.locator('#analytics-filterbar [data-action="analytics-set-scope"][data-value="global"]'),
      "the Global segment is absent — an event admin has no platform-wide view").toHaveCount(0);
    await expect(page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="global"]'),
      'the prompt offers no "Show platform-wide" action either').toHaveCount(0);

    // The two scopes they DO have are still offered — otherwise "no Global" is
    // satisfied by a pane that offers nothing at all.
    await expect(page.locator('#analytics-filterbar [data-action="analytics-set-scope"][data-value="competition"]')).toHaveCount(1);
    await expect(page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="competition"]'),
      "the prompt still names the one thing they can pick").toHaveCount(1);
    // …and the withholding is EXPLAINED rather than silent.
    await expect(page.locator("#analytics-summary")).toContainText(/no platform-wide view/i);
  });

  test("CONTROL — a superadmin gets both the Global segment and the platform-wide action", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsUnscoped(page);

    await expect(page.locator('#analytics-filterbar [data-action="analytics-set-scope"][data-value="global"]'),
      "the Global segment exists for an unscoped actor").toHaveCount(1);
    await expect(page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="global"]'),
      'the prompt\'s "Show platform-wide" action exists for an unscoped actor').toHaveCount(1);
  });

  // ── 8. the Participants tab ────────────────────────────────────────────────

  test("the Participants tab badges an event admin WITH the event they run", async ({ page }) => {
    // Read as the SUPERADMIN, whose list is unrestricted: the event admin's own
    // list holds only people enrolled in their events, and being an organiser
    // grants no membership anywhere, so they would never see their own row.
    //
    // The badge names the EVENT because the role is granted once and the events
    // change constantly — "Event admin" alone is the half an admin cannot act on.
    await adminLogin(page);
    await clickTab(page, "Participants");

    await narrowPeopleTable(page, world.ea.email);
    const row = page.locator(`#admin-participants-body tr:has-text('${world.ea.email}')`).first();
    await row.waitFor({ state: "visible", timeout: 15000 });

    // Scoped to the ROLE CELL, never the whole row. The row also carries an
    // events column, so a row-wide text match would be satisfied by the event
    // admin being ENROLLED in that event rather than by the badge naming it —
    // and being an organiser grants no membership, which is the very distinction
    // this assertion exists to show.
    const roleCell = row.locator("td:has(> .role-badge)");
    await expect(roleCell.locator(".role-badge"), "the tier is badged").toHaveText("Event admin");
    await expect(roleCell, "…and the badge says WHICH event, not merely that there is one")
      .toContainText(world.mine.name);

    // CONTROL: a zero-grant event admin still holds the TIER — removing somebody's
    // last event deliberately leaves the role in place — so the role badge is
    // there and the events are not. v8.8.10 dropped the "no events" label on the
    // operator's call: it is not actionable and it reads as noise beside a badge
    // row, so the cell carries the badge alone. The assertion is what remains
    // true either way: the tier is stated, and no event is named.
    await narrowPeopleTable(page, world.zero.email);
    const zrow = page.locator(`#admin-participants-body tr:has-text('${world.zero.email}')`).first();
    await zrow.waitFor({ state: "visible", timeout: 15000 });
    const zRoleCell = zrow.locator("td:has(> .role-badge)");
    await expect(zRoleCell.locator(".role-badge")).toHaveText("Event admin");
    await expect(zRoleCell.locator(".comp-badge"), "and no event is badged").toHaveCount(0);
  });

  // ── 9. accessibility ───────────────────────────────────────────────────────

  test("no moderate+ axe violations on the event admin's panel, groups pane or kebab note", async ({ page }) => {
    // The new surfaces in this release are chrome an admin meets constantly: a
    // sidebar with an item removed, a table of disabled-with-title buttons, and
    // a kebab carrying a non-interactive note. The note is the one worth a scan
    // — it sits inside a `role=menu` portal and carries no `data-action`, so the
    // portal's `role=menuitem` pass must skip it rather than announce an
    // unfocusable item.
    const summarise = bad => bad.map(v => `${v.id} (${v.impact}): ${v.help}`).join("\n");
    const scan = async (label, scope) => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"]).include(scope).analyze();
      const bad = (results.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact));
      // NAME THE RULES (v7.21.40): a failure that does not say which rule fired
      // costs a fresh investigation every time.
      const ids = [...new Set(bad.map(v => v.id))].join(", ");
      expect(bad, `moderate+ a11y violations on ${label} [rules: ${ids || "none"}]:\n${summarise(bad)}`)
        .toEqual([]);
    };

    await eventAdminLogin(page, world);
    await clickTab(page, "Events");
    await scan("the event admin's admin panel", "#admin-page");

    await clickTab(page, "Groups");
    await page.locator("#groups-tbody tr").first().waitFor({ state: "visible", timeout: 15000 });
    await scan("the groups pane", "#admin-groups-tab");

    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, othersTask.title);
    await openKebab(page, row.first());
    // Precondition: scanning an EMPTY container finds nothing and passes, which
    // is the vacuity this repo has already paid for on two axe scans (v8.3.26).
    await expect(page.locator("#kebab-portal .kebab-note")).toBeVisible();
    await scan("the ownership-note kebab", "#kebab-portal");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8.7.4 — the profile DIALOG agrees with the kebab that opened it.
  //
  // `targetPrivileged` was written out TWICE in participants-admin.js and only
  // the row renderer learned about this tier in v8.7.0. So for an event admin
  // looking at a fellow organiser the kebab correctly said "View Profile" and
  // showed the lock note, and the dialog then opened fully EDITABLE against a
  // target the server refuses (`event_admin_target_privileged`) — the one
  // prominent item lying, which is the exact v7.14.2 defect the row renderer's
  // own comment describes. Both sites read one shared predicate now.
  // ───────────────────────────────────────────────────────────────────────────
  test("a fellow ORGANISER's profile opens READ-ONLY for an event admin", async ({ page }) => {
    await eventAdminLogin(page, world);
    await clickTab(page, "Participants");

    // Wait for the ROW to be in the MODEL, not merely for the page: the dialog
    // renders entirely from `S.adminParticipantsData` and opens `if(!p) return;`,
    // so against an unloaded list it is a SILENT no-op and the failure surfaces
    // later naming the overlay rather than the empty list (v8.3.39).
    await page.waitForFunction(() => typeof window.adminEditProfile === "function", null, { timeout: 30000 });
    await page.waitForFunction(
      (uid) => (window.S?.adminParticipantsData || []).some(u => u.id === uid),
      peerOrganiser.id, { timeout: 30000 });
    await page.evaluate((uid) => window.adminEditProfile(uid), peerOrganiser.id);
    await page.locator("#admin-profile-overlay").waitFor({ state: "visible", timeout: 10000 });

    await expect(page.locator("#admin-profile-overlay .admin-profile-note"),
      "the dialog says what it is").toContainText("Read-only view");
    await expect(page.locator("#admin-profile-overlay [data-action='admin-profile-save']"),
      "…and offers no Save, because the server would refuse it").toHaveCount(0);
    // A field the SERVER refuses must not be typeable. `#adp-company` is the
    // one the fill-a-blank rule would otherwise leave open to a regular admin,
    // so it discriminates read-only from merely fill-blank.
    await expect(page.locator("#adp-company")).toBeDisabled();
  });

  test("CONTROL: the SAME row opens EDITABLE for a superadmin", async ({ page }) => {
    // Without this, "the dialog is read-only" is satisfied by a build that made
    // every profile dialog read-only for everybody — which would remove a
    // superadmin capability rather than restore an event admin's honesty.
    await adminLogin(page);
    await clickTab(page, "Participants");
    await page.waitForFunction(() => typeof window.adminEditProfile === "function", null, { timeout: 30000 });
    await page.waitForFunction(
      (uid) => (window.S?.adminParticipantsData || []).some(u => u.id === uid),
      peerOrganiser.id, { timeout: 30000 });
    await page.evaluate((uid) => window.adminEditProfile(uid), peerOrganiser.id);
    await page.locator("#admin-profile-overlay").waitFor({ state: "visible", timeout: 10000 });

    await expect(page.locator("#admin-profile-overlay .admin-profile-note"))
      .toContainText("All fields are editable");
    await expect(page.locator("#admin-profile-overlay [data-action='admin-profile-save']")).toHaveCount(1);
    await expect(page.locator("#adp-company")).toBeEnabled();
  });
});
