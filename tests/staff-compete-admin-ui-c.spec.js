// @ts-check
//
// v8.12.4 — part C of the staff-compete admin-UI tests, split out of
// staff-compete-admin-ui.spec.js (the suite's critical path) by top-level
// describe. The design note — the actors, the controls every positive carries,
// and the fixture — is at the top of staff-compete-admin-ui-a.spec.js; the
// shared fixture itself is tests/staff-compete-admin-ui-fixture.js.
const { test, expect } = require("./isolated-test");
// The tag and group cells are outside the Participants table's default six columns.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { BASE, apiLogin, PARTICIPANT_PASS } = require("./helpers");
const F = require("./staff-compete-admin-ui-fixture");
const {
  iso, attach, makeAdmin, tagStaff, tagComp, compRow, taskRow, participantAdminRow,
  adminPanel, eventRow, openEdit, saveEdit, challengeRow, participantRow, closeKebab, focus,
  expectInactiveRow, toDarkTheme,
  H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin,
  loginViaApi, formLogin, adminLogin, clickTab, openKebab, viewComp, filterComps, findSeededTaskRow, openCompCreateForm,
} = F;

test.use({ baseURL: BASE });

let sa, saCsrf;          // the built-in superadmin — fixture builder ONLY (see header)
let reader;              // { api, csrf } — a user-backed superadmin, never in a browser
let TAG;
let competitor, saComp, author, author2, staffP, staffP2, staffP3, plainP, plainP2, plainP3, mateP,
  pAuth, legacyP, eaP, agP;
let competeLive, plainLive, endedOn, endedOff, endLater, upOn, upOff, privOn, renOn, renOff,
  cUp, cUpSealed, dUp, dUpEmpty, gOn, gOff, hAuthorOn, hUpOn, hUpOff, aUp, agOff;
let sealedHinted, plainHinted, cTask, cSealed, gUnsealed, gSealed, hUnsealed, hSealed, hSealed2,
  aSealed, agTask, endSealed, unsealFree;
let scgrp, scgrpBound;   // { id, name } — a group bound to nothing, and one bound to `competeLive`

test.beforeAll(async () => {
  ({ sa, saCsrf, reader, TAG, competitor, saComp, author, author2, staffP, staffP2, staffP3, plainP, plainP2, plainP3, mateP, pAuth, legacyP, eaP, agP, competeLive, plainLive, endedOn, endedOff, endLater, upOn, upOff, privOn, renOn, renOff, cUp, cUpSealed, dUp, dUpEmpty, gOn, gOff, hAuthorOn, hUpOn, hUpOff, aUp, agOff, sealedHinted, plainHinted, cTask, cSealed, gUnsealed, gSealed, hUnsealed, hSealed, hSealed2, aSealed, agTask, endSealed, unsealFree, scgrp, scgrpBound } = await F.buildFixture());
});

test.afterAll(async () => { await F.disposeFixture(); });


// ═══════════════════════════════════════════════════════════════════════════
// (j) THE BULK ASSIGN PICKER, ITS TOAST AND THE AUTHOR MODAL
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the assign ledger is rendered", () => {

  /**
   * Tick every named row (with NO event focused, so a staff row still renders
   * its checkbox), bulk-assign the selection to one event, and return the
   * request body that actually left the browser — asserted, because "the
   * toast named no skip" is equally true of a selection that never held the
   * staff row.
   */
  async function bulkAssign(page, userIds, emails, compName) {
    await clickTab(page, "Participants");
    /** @type {any[]} */ const bodies = [];
    await page.route("**/api/admin/competitions/assign", async (route, req) => {
      if (req.method() === "POST") { try { bodies.push(JSON.parse(req.postData() || "{}")); } catch (_) { bodies.push({}); } }
      await route.continue();
    });
    for (const email of emails) {
      const row = await participantRow(page, email);
      await row.locator("td.cb-cell input[type=checkbox]").check();
    }
    await expect.poll(() => page.evaluate(() => (window.S?.selectedParticipants || new Set()).size),
      { message: "every ticked row is in the selection model" }).toBe(emails.length);
    const top = page.locator("#selection-bar-assign-btn");
    await expect(top, "the selection bar's button is offered with no event focused").toBeVisible();
    await expect(top).toHaveText(/Assign to Events/);
    await top.click();
    const overlay = page.locator("#bulk-assign-overlay");
    await expect(overlay, "the bulk picker opened").toBeVisible({ timeout: 15000 });
    await overlay.locator(`#bulk-comp-list label.picker-row:has-text("${compName}") input`).check();
    await overlay.locator('[data-action="bulk-assign-next"]').click();
    await expect(overlay, "step 2 names the event").toContainText(compName);
    await overlay.locator('[data-action="bulk-assign-execute"]').click();
    await expect(overlay).toBeHidden({ timeout: 15000 });
    expect(bodies.length, "exactly one assign was posted").toBe(1);
    expect((bodies[0].userIds || []).slice().sort(), "the request carried every ticked user").toEqual(userIds.slice().sort());
    return bodies[0];
  }

  test("a staff member assigned to a switch-off event is reported as skipped, and a plain participant beside them is enrolled (CONTROL)", async ({ page }) => {
    await adminLogin(page);
    await bulkAssign(page, [staffP.id, plainP2.id], [staffP.email, plainP2.email], upOff.name);
    const toast = page.locator("#toast-stack");
    await expect(toast, "the staff skip is NAMED with its rule").toContainText(/1 staff enrolment\(s\) skipped — staff can only be added to events that let staff compete/, { timeout: 15000 });
    await expect(toast, "CONTROL: the plain participant beside them was enrolled").toContainText(/Assigned 1 user\(s\)/);

    const s = await participantAdminRow(staffP.email), p = await participantAdminRow(plainP2.email);
    expect((s.competitions || []).some(c => c.id === upOff.id), "the staff member holds NO row on the switch-off event").toBe(false);
    expect((p.competitions || []).some(c => c.id === upOff.id), "…and the plain participant does").toBe(true);
  });

  test("a BLOCKED staff-tagged user assigned to a switch-off event is reported as BLOCKED, never as a staff skip — the blocked check runs first", async ({ page }) => {
    // Round-3 (c): the blocked and unapproved skips run BEFORE the staff check,
    // so a blocked staff account is reported as blocked rather than as staff —
    // the reason the organiser can act on. Driven for real from this pane, not
    // through the mocked ledger.
    await adminLogin(page);
    await bulkAssign(page, [staffP3.id], [staffP3.email], upOff.name);
    const toast = page.locator("#toast-stack");
    await expect(toast, "the BLOCKED reason is named").toContainText(/1 blocked account\(s\) skipped/, { timeout: 15000 });
    await expect(toast, "…and the staff reason is NOT — one skip, one reason").not.toContainText(/staff enrolment/);
    await expect(toast).toContainText(/Assigned 0 user\(s\)/);
    const s = await participantAdminRow(staffP3.email);
    expect((s.competitions || []).some(c => c.id === upOff.id), "nothing was written").toBe(false);
  });

  test("an AUTHOR assigned to the compete event holding their challenge gets the 'they wrote a challenge' modal, naming both", async ({ page }) => {
    await adminLogin(page);
    await bulkAssign(page, [author.id], [author.email], competeLive.name);
    await expect(page.locator("#toast-stack")).toContainText(/1 skipped because they created a challenge in the event/, { timeout: 15000 });
    await expect(page.locator("#modal-title")).toHaveText(/Not enrolled — they wrote a challenge in this event/, { timeout: 15000 });
    await expect(page.locator("#modal-body"), "the person is named").toContainText(author.nickname);
    await expect(page.locator("#modal-body"), "…and the challenge").toContainText(sealedHinted.title);
    await expect(page.locator("#modal-body"), "…and the event").toContainText(competeLive.name);
    await page.locator("#modal-confirm-btn").click();

    const a = await participantAdminRow(author.email);   // asserted present, so "not enrolled" is not a lookup failure
    expect((a.competitions || []).some(c => c.id === competeLive.id), "the author was NOT enrolled").toBe(false);
  });

  test("a REGULAR admin's attempt to enrol an admin in a compete event is reported as 'only a superadmin can enrol an admin', and nothing is written", async ({ page }) => {
    // `author` is staff-tagged (every admin is) and `privOn` lets staff compete,
    // and no challenge of theirs is assigned there — so the ONLY skip reason the
    // server can answer with is privilege.
    await adminPanel(page, competitor.email);
    await bulkAssign(page, [author.id], [author.email], privOn.name);
    const toast = page.locator("#toast-stack");
    await expect(toast, "the peer-admin skip is NAMED with its rule").toContainText(/1 admin account\(s\) skipped — only a superadmin can enrol an admin/, { timeout: 15000 });
    await expect(toast, "…and it was the whole request").toContainText(/Assigned 0 user\(s\)/);
    await expect(toast, "not the staff reason").not.toContainText(/staff enrolment/);
    const a = await participantAdminRow(author.email);
    expect((a.competitions || []).some(c => c.id === privOn.id), "the admin was NOT enrolled").toBe(false);
  });

  test("the participants-side bulk picker disables the event the actor competes in as 'You compete here' — and offers one they do not (CONTROL)", async ({ page }) => {
    // The server refuses the whole request for ANY named target the actor
    // competes in (403 by name), and with no event focused a competing admin
    // still gets checkboxes on every unenrolled row — so without this gate the
    // picker offered the very event the server was certain to refuse, ending in
    // a bare "Assignment failed." (the v7.14.2 affordance). The challenge-side
    // picker had the gate from the start; this is its twin.
    await adminPanel(page, competitor.email);
    await clickTab(page, "Participants");
    const row = await participantRow(page, plainP.email);
    await row.locator("td.cb-cell input[type=checkbox]").check();
    const top = page.locator("#selection-bar-assign-btn");
    await expect(top).toBeVisible();
    await top.click();
    const overlay = page.locator("#bulk-assign-overlay");
    await expect(overlay, "the bulk picker opened").toBeVisible({ timeout: 15000 });
    const mine = overlay.locator(`#bulk-comp-list label.picker-row:has-text("${competeLive.name}")`);
    await expect(mine, "the event they compete in is listed — disabled, not hidden").toBeVisible();
    await expect(mine).toHaveClass(/is-disabled/);
    await expect(mine.locator("input")).toBeDisabled();
    await expect(mine.locator(".picker-row-flag"), "…WITH its reason").toContainText("You compete here");
    await expect(mine).toHaveAttribute("title", /You are competing in this event/);
    const other = overlay.locator(`#bulk-comp-list label.picker-row:has-text("${plainLive.name}")`);
    await expect(other.locator("input"), "CONTROL: an event they do not compete in is offered").toBeEnabled();
    await expect(other).not.toHaveClass(/is-disabled/);
    await expect(other.locator(".picker-row-flag")).toHaveCount(0);
    // v8.13.7 — the disabled row is MARKED (dashed, muted, full strength), the live one is not.
    await expectInactiveRow(mine, other, { site: "the participants' bulk Assign to Events picker (bulk-comp-list), 'You compete here' row" });
    await overlay.locator('[data-action="overlay-close"]').first().click();
    await expect(overlay).toBeHidden();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (k) THE OTHER CHALLENGE-SIDE SURFACES THE COMPETITOR RULE REACHES
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the challenge-side bulk picker, Remove from Event, and Grant Attempts", () => {

  test("the challenge-side bulk picker disables the event the actor competes in as 'You compete here', flags a compete event as 'Sealed challenges only', and offers a plain one (CONTROL)", async ({ page }) => {
    await adminPanel(page, competitor.email);
    const row = await challengeRow(page, plainHinted.title);
    await row.locator('td.cb-cell input[type="checkbox"]').check();
    const btn = page.locator("#assign-challenges-to-comp-btn");
    await expect(btn, "the bulk button renders once a challenge is ticked").toBeVisible({ timeout: 15000 });
    await btn.click();
    const overlay = page.locator("#challenge-bulk-assign-overlay");
    await expect(overlay, "the bulk picker opened").toBeVisible({ timeout: 15000 });
    const mine = overlay.locator(`#challenge-bulk-comp-list label.picker-row:has-text("${competeLive.name}")`);
    await expect(mine).toHaveClass(/is-disabled/);
    await expect(mine.locator("input")).toBeDisabled();
    await expect(mine.locator(".picker-row-flag"), "the competitor reason").toContainText("You compete here");
    const sealedOnly = overlay.locator(`#challenge-bulk-comp-list label.picker-row:has-text("${gOn.name}")`);
    await expect(sealedOnly.locator("input"), "a compete event they do not compete in is OFFERED…").toBeEnabled();
    await expect(sealedOnly.locator(".picker-row-flag"), "…with a reminder that unsealed challenges will be skipped there").toContainText("Sealed challenges only");
    const plain = overlay.locator(`#challenge-bulk-comp-list label.picker-row:has-text("${plainLive.name}")`);
    await expect(plain.locator("input"), "CONTROL: a plain event is offered with no flag").toBeEnabled();
    await expect(plain.locator(".picker-row-flag")).toHaveCount(0);
    // v8.13.7 — the disabled row is MARKED (dashed, muted, full strength), the live one is not.
    await expectInactiveRow(mine, plain, { site: "Challenges' bulk Assign Challenges to Events picker (challenge-bulk-comp-list), 'You compete here' row" });
    await overlay.locator('[data-action="overlay-close"]').first().click();
    await expect(overlay).toBeHidden();
  });

  test("with the event they compete in FOCUSED, the selection bar reads 'Assign to Events', opens the PICKER rather than posting into it, and the direct-add button is withheld", async ({ page }) => {
    // Round 3: the label and the handler derive from ONE predicate. The label
    // already read "Assign to Events" for a competitor while the handler
    // re-derived direct-add without `competing` and posted straight into the
    // refusal (two copies of one rule, one drifted). And `+ Add Challenges` is
    // the other direct door into the focused event.
    await adminPanel(page, competitor.email);
    await focus(page, competeLive.name);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.locator("#add-tasks-to-comp-btn"), "no direct-add into the event they compete in").toBeHidden();
    /** @type {string[]} */ const posts = [];
    await page.route("**/api/admin/tasks/assign-competitions", async (route, req) => {
      if (req.method() === "POST") posts.push(req.postData() || "");
      await route.continue();
    });
    const row = await challengeRow(page, plainHinted.title);
    await row.locator('td.cb-cell input[type="checkbox"]').check();
    const btn = page.locator("#assign-challenges-to-comp-btn");
    await expect(btn).toBeVisible({ timeout: 15000 });
    await expect(btn, "the label does not name the event they compete in").toHaveText(/Assign to Events/);
    await expect(btn).not.toContainText(competeLive.name);
    await btn.click();
    const overlay = page.locator("#challenge-bulk-assign-overlay");
    await expect(overlay, "the PICKER opens instead of a direct add").toBeVisible({ timeout: 15000 });
    const mine = overlay.locator(`#challenge-bulk-comp-list label.picker-row:has-text("${competeLive.name}")`);
    await expect(mine.locator("input")).toBeDisabled();
    await expect(mine.locator(".picker-row-flag")).toContainText("You compete here");
    expect(posts.length, "nothing was posted on the click").toBe(0);
    await overlay.locator('[data-action="overlay-close"]').first().click();
    await expect(overlay).toBeHidden();
  });

  test("CONTROL — with the same event focused, the built-in's selection bar reads 'Assign to \"<event>\"' and the direct-add button is offered", async ({ page }) => {
    await adminLogin(page);
    await focus(page, competeLive.name);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.locator("#add-tasks-to-comp-btn"), "the direct-add button is offered to an actor who competes nowhere").toBeVisible({ timeout: 15000 });
    const row = await challengeRow(page, plainHinted.title);
    await row.locator('td.cb-cell input[type="checkbox"]').check();
    const btn = page.locator("#assign-challenges-to-comp-btn");
    await expect(btn).toBeVisible({ timeout: 15000 });
    await expect(btn, "the label names the focused event").toHaveText(`Assign to "${competeLive.name}"`);
    await expect(page.locator("#add-tasks-to-comp-btn"), "…and the picker button yields to it while something is ticked").toBeHidden();
  });

  test("with the event they compete in focused, 'Remove from Event' is withheld on its challenge row (can_unassign:false)", async ({ page }) => {
    await adminPanel(page, competitor.email);
    await focus(page, competeLive.name);
    const row = await challengeRow(page, sealedHinted.title);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator(".kebab-note")).toContainText(/You are competing in/);
    await expect(portal.locator('[data-action="task-remove-from-comp"]'), "the unassign door refuses a competitor").toHaveCount(0);
    await expect(portal.locator('[data-action="task-history"]'), "viewing stays").toHaveCount(1);
  });

  test("CONTROL — with the same event focused, the built-in superadmin is offered 'Remove from Event' on the same row", async ({ page }) => {
    await adminLogin(page);
    await focus(page, competeLive.name);
    const row = await challengeRow(page, sealedHinted.title);
    await openKebab(page, row);
    await expect(page.locator('#kebab-portal [data-action="task-remove-from-comp"]'), "the built-in competes nowhere, so the row offers it").toHaveCount(1);
  });

  test("Grant Attempts does not offer a competitor the event they compete in — the dialog explains rather than listing it", async ({ page }) => {
    // The kebab gate is deliberately OPTIMISTIC (an unknown cap is not an absent
    // one), so the item renders; the dialog is what withholds the event, and it
    // says so instead of opening onto an empty list.
    await adminPanel(page, competitor.email);
    const row = await challengeRow(page, sealedHinted.title);
    await openKebab(page, row);
    await page.locator('#kebab-portal [data-action="task-attempt-grant"]').click();
    const overlay = page.locator("#attempt-grant-overlay");
    await expect(overlay, "the dialog opened").toBeVisible({ timeout: 15000 });
    await expect(overlay.locator("#ag-comp"), "no event select — the only capped event is the one they compete in").toHaveCount(0);
    // The empty state NAMES the competing event rather than claiming nothing
    // holds the challenge — the v8.8.5 "asserts a fact it cannot see" lesson in
    // reverse: here the client knows exactly why the list is empty.
    await expect(overlay.locator(".picker-note").first(), "…and it says why").toContainText(/You are competing in/);
    await expect(overlay.locator(".picker-note").first()).toContainText(competeLive.name);
    await expect(overlay.locator(".picker-note").first(), "…and does not claim no event holds it").not.toContainText(/No event you organise holds/);
    await expect(overlay, "the competing event is not named as an option").not.toContainText(`${competeLive.name} —`);
  });

  test("CONTROL — the built-in superadmin is offered that capped event, and its roster includes the enrolled admin", async ({ page }) => {
    // Or "no event is offered" is satisfied by a dialog that offers nothing to
    // anybody. And on a compete event an enrolled admin IS a competitor, so the
    // roster lists them beside the participant.
    await adminLogin(page);
    const row = await challengeRow(page, sealedHinted.title);
    await openKebab(page, row);
    await page.locator('#kebab-portal [data-action="task-attempt-grant"]').click();
    const overlay = page.locator("#attempt-grant-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay.locator("#ag-comp"), "the capped compete event is offered").toContainText(competeLive.name);
    await expect(overlay.locator("#ag-comp option"), "…and is the only one").toHaveCount(1);
    const people = overlay.locator("#ag-people label.picker-row");
    await expect(people.filter({ hasText: mateP.nickname }), "the participant is on the roster").toHaveCount(1, { timeout: 15000 });
    await expect(people.filter({ hasText: competitor.nickname }), "…and so is the enrolled ADMIN — staff compete here").toHaveCount(1);
  });

  test("CONTROL — on a capped switch-OFF event the roster lists the participant and NOT the enrolled event-admin-role row", async ({ page }) => {
    // The arm above proves an enrolled admin IS listed where staff compete;
    // without this negative twin `_agStaffCompete||…` survives being replaced by
    // `true||…`. An event-admin ROLE row on a switch-off event is not a
    // competitor there and the grant endpoint refuses it (privileged target).
    await adminLogin(page);
    const row = await challengeRow(page, agTask.title);
    await openKebab(page, row);
    await page.locator('#kebab-portal [data-action="task-attempt-grant"]').click();
    const overlay = page.locator("#attempt-grant-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay.locator("#ag-comp"), "the capped switch-off event is offered").toContainText(agOff.name);
    const people = overlay.locator("#ag-people label.picker-row");
    await expect(people.filter({ hasText: agP.nickname }), "the participant is on the roster").toHaveCount(1, { timeout: 15000 });
    await expect(people.filter({ hasText: eaP.nickname }), "…and the event-admin-role row is NOT — staff do not compete here").toHaveCount(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (m) THE GROUPS PANE
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the Groups pane and an event the actor competes in", () => {

  /** Groups tab → narrow to ONE named group → its row. */
  async function groupRow(page, name) {
    await clickTab(page, "Groups");
    await require("./ui-admin-helpers").narrowGroupsTable(page, name);   // v9.2.4 — waits out the re-render a press could straddle
    const row = page.locator(`#groups-tbody tr:has-text("${name}")`).first();
    await expect(row, `the groups table narrowed to "${name}"`).toBeVisible({ timeout: 15000 });
    return row;
  }

  test("the group's Events dialog disables the event the actor competes in as 'You compete here' — and offers one they do not (CONTROL)", async ({ page }) => {
    // Round 3: binding reaches the assign door and unbinding its own, both
    // competitor doors, so `competing` rides the group-competitions rows.
    await adminPanel(page, competitor.email);
    const row = await groupRow(page, scgrp.name);
    await row.locator('[data-action="group-bind-comps"]').click();
    const list = page.locator("#gc-list");
    await expect(list, "the Events dialog opened").toBeVisible({ timeout: 15000 });
    const mine = list.locator(`label:has-text("${competeLive.name}")`).first();
    await expect(mine, "the event they compete in is listed — disabled, not hidden").toBeVisible();
    await expect(mine).toHaveClass(/is-disabled/);
    await expect(mine.locator("input.gc-cb")).toBeDisabled();
    await expect(mine.locator("input.gc-cb"), "…and unbound").not.toBeChecked();
    await expect(mine.locator(".picker-row-flag"), "…WITH its reason").toContainText("You compete here");
    const other = list.locator(`label:has-text("${plainLive.name}")`).first();
    await expect(other.locator("input.gc-cb"), "CONTROL: an event they do not compete in is offered").toBeEnabled();
    await expect(other).not.toHaveClass(/is-disabled/);
    await expect(other.locator(".picker-row-flag")).toHaveCount(0);
    // v8.13.7 — the disabled row is MARKED (a dashed top rule, muted, full
    // strength), the live one is not — in BOTH themes.
    const site = "a group's Events dialog (gc-list), 'You compete here' row";
    await expectInactiveRow(mine, other, { site, edge: "top" });
    await toDarkTheme(page);
    await expectInactiveRow(mine, other, { site, edge: "top", theme: "dark" });
    await page.locator("#gc-close").click();
    await expect(list).toHaveCount(0);
  });

  test("CONTROL — the built-in's Events dialog offers the same compete event, enabled", async ({ page }) => {
    await adminLogin(page);
    const row = await groupRow(page, scgrp.name);
    await row.locator('[data-action="group-bind-comps"]').click();
    const list = page.locator("#gc-list");
    await expect(list).toBeVisible({ timeout: 15000 });
    const mine = list.locator(`label:has-text("${competeLive.name}")`).first();
    await expect(mine.locator("input.gc-cb"), "the built-in competes nowhere, so the box is live").toBeEnabled();
    await expect(mine).not.toHaveClass(/is-disabled/);
    await expect(mine.locator(".picker-row-flag")).toHaveCount(0);
    await page.locator("#gc-close").click();
  });

  test("a group BOUND to the event the actor competes in withholds Delete and the Members dialog's Add/Remove, with a reason", async ({ page }) => {
    // Delete, member-add and member-remove all take `competitorGroupDenied`
    // (routes/groups.js:246-258, 270-283, 333-343) — refused by name for a group
    // bound to the event the actor competes in — but only the Events dialog got
    // the client gate: `GET /api/admin/groups` carries `can_write` / `can_delete`
    // for the event-admin scope and nothing for the competitor lock, so the pane
    // offers Delete and the Members dialog offers Add / Remove where the server
    // is certain to refuse, and only the refusal toast speaks.
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `GET /api/admin/groups` folds `competitorGroupDenied` into `can_write` /
    // `can_delete` and carries a `competing` flag; the pane and the Members
    // dialog withhold Delete / Add / Remove with the reason.
    await adminPanel(page, competitor.email);
    const row = await groupRow(page, scgrpBound.name);
    await expect(row.locator('[data-action="group-delete"]'), "Delete reaches a door the server refuses").toBeDisabled();
    await expect(row.locator('[data-action="group-delete"]')).toHaveAttribute("title", /competing/i);
    await row.locator('[data-action="group-manage-members"]').click();
    await expect(page.locator("#gm-member-count"), "the Members dialog opened").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#gm-add"), "no Add — every add reconciles into the event they compete in").toHaveCount(0);
  });

  test("CONTROL — the built-in sees Delete enabled and the Members dialog's Add on that same bound group", async ({ page }) => {
    await adminLogin(page);
    const row = await groupRow(page, scgrpBound.name);
    await expect(row.locator('[data-action="group-delete"]'), "the built-in competes nowhere, so Delete is offered").toBeEnabled();
    await row.locator('[data-action="group-manage-members"]').click();
    await expect(page.locator("#gm-member-count")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#gm-add"), "…and so is Add").toBeVisible();
    await page.locator("#gm-close").click();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (l) THE INVITE DIALOG'S TOAST
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the invite dialog renders the skip ledger", () => {

  /** Open the Invite dialog from the Participants tab, type addresses, tick an event. */
  async function openInvite(page, emails, compId) {
    await clickTab(page, "Participants");
    await page.locator("#invite-participants-btn").click();
    const overlay = page.locator("#invite-overlay");
    await expect(overlay, "the invite dialog opened").toBeVisible({ timeout: 15000 });
    await overlay.locator("#invite-emails").fill(emails.join("\n"));
    const cb = overlay.locator(`.invite-comp-cb[value="${compId}"]`);
    await expect(cb, "the event is offered in the dialog").toHaveCount(1);
    await cb.check();
    return overlay;
  }

  test("every skip reason the route can answer with is spoken in the toast (mocked ledger)", async ({ page }) => {
    // The route has counted every skipped enrolment since v6.16.9 and this dialog
    // rendered none of them — so an organiser was told nothing about why nobody
    // was enrolled. Mocked, because five reasons at once cannot be manufactured
    // from one request; the REAL path is driven in the arm below.
    await adminLogin(page);
    await page.route("**/api/admin/invitations", route => route.request().method() === "POST"
      ? route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            ok: true, invited: 0, assigned: 0, emailsSent: 0, resent: 0, errors: [], existingEmails: [], alreadyInvited: [], alreadyAssigned: [],
            undeliveredInvites: [], unsubscribedInvites: [],
            skippedStaff: 2, skippedPrivileged: 1, skippedAuthors: 3, skippedBlocked: 1, skippedUnapproved: 1,
          }),
        })
      : route.continue());
    const overlay = await openInvite(page, [`ledger-${TAG}@acme.com`], upOn.id);
    await overlay.locator("#invite-submit-btn").click();
    const toast = page.locator("#toast-stack");
    await expect(toast, "the staff skips are named").toContainText(/2 staff enrolment\(s\) skipped — staff can only be added to events that let staff compete/, { timeout: 15000 });
    await expect(toast, "…the peer-admin skips").toContainText(/1 admin account\(s\) skipped — only a superadmin can enrol an admin/);
    await expect(toast, "…the author skips").toContainText(/3 skipped because they created a challenge in the event/);
    await expect(toast, "…the blocked skips").toContainText(/1 blocked account\(s\) not enrolled/);
    await expect(toast, "…and the unapproved skips").toContainText(/1 unapproved account\(s\) not enrolled/);
    await expect(overlay, "nothing was left to fix, so the dialog closed").toBeHidden({ timeout: 10000 });
  });

  test("a REAL invitation of a staff member to a switch-off event reports the staff skip, does not keep them as 'already a member', and enrols the plain participant beside them (CONTROL)", async ({ page }) => {
    // A row the route SKIPS is no longer pushed onto `alreadyAssigned`, so the
    // address is not kept in the textarea with "nothing to do" — the dialog
    // closes, and the toast says why nobody staff was enrolled.
    await adminLogin(page);
    const overlay = await openInvite(page, [staffP.email, plainP3.email], upOff.id);
    await overlay.locator("#invite-submit-btn").click();
    const toast = page.locator("#toast-stack");
    await expect(toast, "the staff skip is named").toContainText(/1 staff enrolment\(s\) skipped — staff can only be added to events that let staff compete/, { timeout: 15000 });
    await expect(toast, "CONTROL: the plain participant was enrolled").toContainText(/1 existing user\(s\) assigned to events/);
    await expect(toast, "the skipped address is NOT reported as already a member").not.toContainText(/already assigned/);
    await expect(overlay, "…so nothing is kept in the textarea and the dialog closes").toBeHidden({ timeout: 10000 });
    const s = await participantAdminRow(staffP.email), p = await participantAdminRow(plainP3.email);
    expect((s.competitions || []).some(c => c.id === upOff.id), "the staff member holds NO row").toBe(false);
    expect((p.competitions || []).some(c => c.id === upOff.id), "…and the plain participant does").toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (n) THE JOIN LINK DIALOG FOR A COMPETITOR — READ-ONLY (operator ruling, 19 Sep 2026)
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the Join Link dialog for a competitor is read-only", () => {

  /** Open the Join Link dialog of a named event through its workspace ⋯ menu
   *  (the event's doors; the Events-row menu keeps only Delete event). */
  async function openJoinLink(page, name) {
    const item = (await require("./ui-admin-helpers").openEventMenu(page, name)).locator('[data-action="comp-self-enroll"]');
    await expect(item, `Join Link is offered on "${name}"`).toHaveCount(1);
    await item.click();
    await page.locator("#self-enroll-overlay").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#self-enroll-input").waitFor({ state: "visible", timeout: 15000 });
  }

  test("a COMPETITOR opens it and sees the link, the QR and the short code — with the toggle DISABLED, the reason beside it, and no Regenerate", async ({ page }) => {
    // The reveal route is `requireAdmin` and writes nothing, so a competitor
    // may READ their own event's link (an organiser competing in their own
    // event still needs it on the signage). The toggle and Regenerate are
    // WRITES the server refuses (`competitor_cannot_edit`), so they are withheld
    // WITH the reason (v7.14.2) rather than offered where the save is certain
    // to fail.
    await adminPanel(page, competitor.email);
    await openJoinLink(page, competeLive.name);
    const ov = page.locator("#self-enroll-overlay");
    // The READ half is intact.
    await expect(ov.locator("#self-enroll-input")).toHaveValue(/\/join\//);
    await expect(ov.locator("#self-enroll-qr img.se-qr-img"), "the QR renders").toHaveCount(1, { timeout: 15000 });
    await expect(ov.locator("#self-enroll-code"), "the short code renders").toBeVisible();
    await expect(ov.locator('[data-action="self-enroll-copy"], [data-action="self-enroll-copy-code"]').first(), "copying is still offered").toBeVisible();
    // The WRITE half is withheld, with its reason.
    const note = ov.locator("#self-enroll-competing-note");
    await expect(note, "the reason is on screen").toBeVisible();
    await expect(note).toContainText(/You are competing in this event/);
    await expect(note).toContainText(/Ask another organiser/);
    await expect(ov.locator("#self-enroll-enabled"), "the enable toggle is disabled").toBeDisabled();
    expect(await ov.locator("#self-enroll-enabled").getAttribute("aria-describedby"), "the toggle points a screen reader at the reason").toBe("self-enroll-competing-note");
    await expect(ov.locator('[data-action="self-enroll-regenerate"]'), "Regenerate is withheld").toHaveCount(0);
    await expect(ov.locator('[data-action="self-enroll-close"]'), "…and Close stays").toHaveCount(1);
  });

  test("CONTROL — the built-in superadmin's dialog on the SAME event has a live toggle, Regenerate, and no note", async ({ page }) => {
    // Without this, "the toggle is disabled" is satisfied by a build whose
    // dialog is always read-only.
    await adminLogin(page);
    await openJoinLink(page, competeLive.name);
    const ov = page.locator("#self-enroll-overlay");
    await expect(ov.locator("#self-enroll-competing-note")).toHaveCount(0);
    await expect(ov.locator("#self-enroll-enabled")).toBeEnabled();
    await expect(ov.locator('[data-action="self-enroll-regenerate"]')).toHaveCount(1);
    await expect(ov.locator("#self-enroll-qr img.se-qr-img")).toHaveCount(1, { timeout: 15000 });
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (o) A RIVAL'S ROW — the account doors (operator ruling, 19 Sep 2026)
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — a RIVAL's row in the Participants pane withholds the account doors", () => {

  test("a REGULAR admin who competes sees no Block / Reset Password / Impersonate on a fellow competitor's row — the benchmark chip loses its ×, an ordinary tag keeps it — and the row says why; a non-rival row keeps all of it (CONTROL)", async ({ page }) => {
    // The server marks each row that shares a compete event with the actor
    // (`rival_in`, one query per page); every ACCOUNT door on such a row is
    // refused `competitor_cannot_edit`, so the pane withholds them WITH the
    // reason. NO event is focused here: the rival rule is about the rows, not
    // about the focus, and focusing would also render the competing note.
    // Through `reader`, never `sa`: the browser sign-ins above killed the
    // built-in's request context (single session per user).
    const plant = async tag => { const r = await reader.api.post(`/api/admin/participants/${mateP.id}/tags`, { headers: H(reader.csrf), data: { tag } }); expect(r.ok(), `tag mateP ${tag}: ${r.status()} ${await r.text()}`).toBeTruthy(); };
    const unplant = async tag => { const r = await reader.api.delete(`/api/admin/participants/${mateP.id}/tags/${encodeURIComponent(tag)}`, { headers: H(reader.csrf) }); expect(r.ok(), `untag mateP ${tag}: ${r.status()} ${await r.text()}`).toBeTruthy(); };
    await plant("benchmark"); await plant(`plain-${TAG}`);
    try {
      await adminPanel(page, competitor.email);
      await clickTab(page, "Participants");
      const portal = page.locator("#kebab-portal");
      let row = await participantRow(page, mateP.email);
      // The chips: the benchmark × is withheld (its title says why), the plain
      // tag's × and the + tag control stay — the tag door is gated for ONE tag.
      const bench = row.locator(".tag").filter({ hasText: "benchmark" });
      await expect(bench, "the benchmark chip still renders").toHaveCount(1);
      await expect(bench.locator(".tag-x"), "…without its ×").toHaveCount(0);
      expect(await bench.getAttribute("title")).toMatch(/cannot be changed from here/);
      const plain = row.locator(".tag").filter({ hasText: `plain-${TAG}` });
      await expect(plain.locator(".tag-x"), "an ordinary tag keeps its ×").toHaveCount(1);
      await expect(row.locator('.tag-add[data-action="participant-tag-add"]'), "+ tag stays").toHaveCount(1);
      await openKebab(page, row);
      for (const action of ["participant-block", "participant-email-code", "participant-impersonate"]) {
        await expect(portal.locator(`[data-action="${action}"]`), `${action} reaches an account door the server refuses on a rival`).toHaveCount(0);
      }
      for (const action of ["participant-edit-profile", "participant-history"]) {
        await expect(portal.locator(`[data-action="${action}"]`), `${action} is viewing, so it stays`).toHaveCount(1);
      }
      const note = portal.locator(".kebab-note").filter({ hasText: /alongside/ });
      await expect(note, "withheld WITH its reason").toHaveCount(1);
      await expect(note).toContainText(competeLive.name);
      await expect(note).toContainText(/their account cannot be changed from here/);
      await closeKebab(page);
      // CONTROL — a row that shares NO compete event with the actor keeps every
      // account door and carries no rival note.
      row = await participantRow(page, plainP.email);
      await openKebab(page, row);
      for (const action of ["participant-block", "participant-email-code", "participant-impersonate"]) {
        await expect(portal.locator(`[data-action="${action}"]`), `CONTROL: ${action} is offered on a non-rival`).toHaveCount(1);
      }
      await expect(portal.locator(".kebab-note").filter({ hasText: /alongside/ }), "CONTROL: no rival note").toHaveCount(0);
    } finally {
      await unplant("benchmark"); await unplant(`plain-${TAG}`);
    }
  });

  test("a user-backed SUPERADMIN who competes loses the role menu and Delete on a fellow competitor's row, and keeps both on a non-rival's (CONTROL)", async ({ page }) => {
    // The superadmin tier is the only one where role / delete render at all, so
    // this is the only actor that makes the rival gate on those two a lock.
    await adminPanel(page, saComp.email);
    await clickTab(page, "Participants");
    const portal = page.locator("#kebab-portal");
    let row = await participantRow(page, mateP.email);
    await openKebab(page, row);
    // The role link (role changes live on Roles & permissions) is a rival door
    // as the role route is, so it is withheld with the rest.
    for (const action of ["participant-open-roles", "participant-delete", "participant-block", "participant-email-code", "participant-impersonate"]) {
      await expect(portal.locator(`[data-action="${action}"]`), `${action} is withheld on a rival`).toHaveCount(0);
    }
    await expect(portal.locator(".kebab-note").filter({ hasText: /alongside/ })).toContainText(competeLive.name);
    await closeKebab(page);
    row = await participantRow(page, plainP.email);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="participant-open-roles"]'), "CONTROL: the role link is offered on a non-rival").toHaveCount(1);
    await expect(portal.locator('[data-action="participant-delete"]'), "CONTROL: Delete is offered on a non-rival").toHaveCount(1);
    await expect(portal.locator(".kebab-note").filter({ hasText: /alongside/ })).toHaveCount(0);
  });

  test("a competing admin's Edit Profile on a rival locks both email addresses and says why; a non-rival's stay editable (CONTROL)", async ({ page }) => {
    // Moving a rival's primary is a takeover (the staged address is confirmed by
    // its own code, then signs in), so the PUT refuses an address change with
    // `competitor_cannot_edit`; the profile itself stays editable.
    await adminPanel(page, competitor.email);
    await clickTab(page, "Participants");
    const portal = page.locator("#kebab-portal");
    const openProfile = async (email) => {
      const row = await participantRow(page, email);
      await openKebab(page, row);
      await portal.locator('[data-action="participant-edit-profile"]').click();
      const ov = page.locator("#admin-profile-overlay");
      await expect(ov).toBeVisible();
      return ov;
    };
    let ov = await openProfile(mateP.email);
    await expect(ov.locator("#adp-email"), "the rival's primary is locked").toBeDisabled();
    await expect(ov.locator("#adp-email2"), "…and the secondary").toBeDisabled();
    await expect(ov.locator(".admin-profile-note")).toContainText(/email addresses cannot be changed from here/);
    await expect(ov.locator(".admin-profile-note")).toContainText(competeLive.name);
    await page.keyboard.press("Escape");
    await expect(ov).toHaveCount(0);
    // CONTROL — a row sharing no compete event keeps both address fields.
    ov = await openProfile(plainP.email);
    await expect(ov.locator("#adp-email")).toBeEnabled();
    await expect(ov.locator("#adp-email2")).toBeEnabled();
    await expect(ov.locator(".admin-profile-note")).not.toContainText(/email addresses cannot be changed/);
    await page.keyboard.press("Escape");
  });
});
