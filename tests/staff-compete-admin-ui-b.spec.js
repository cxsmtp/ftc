// @ts-check
//
// v8.12.4 — part B of the staff-compete admin-UI tests, split out of
// staff-compete-admin-ui.spec.js (the suite's critical path) by top-level
// describe. The design note — the actors, the controls every positive carries,
// and the fixture — is at the top of staff-compete-admin-ui-a.spec.js; the
// shared fixture itself is tests/staff-compete-admin-ui-fixture.js.
const { test, expect } = require("./isolated-test");
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
// (g) THE COMPETITION-SIDE PICKER ("Assign Challenges")
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the Assign Challenges picker on a switch-on event", () => {

  /** Focus a named event and open its challenge picker. */
  async function openPicker(page, compName) {
    await focus(page, compName);
    await clickTab(page, "Challenges");
    const btn = page.locator("#add-tasks-to-comp-btn");
    await expect(btn, "the direct-add button renders for a focused, non-ended event the actor does not compete in").toBeVisible({ timeout: 15000 });
    await btn.click();
    await expect(page.locator("#task-picker-list"), "the picker opened").toBeVisible({ timeout: 15000 });
  }

  const pickerRow = (page, title) => page.locator(`#task-picker-list label.picker-row:has-text("${title}")`).first();

  test("the picker explains the seal rule, disables an unsealed row as 'Not sealed', and a sealed one saves", async ({ page }) => {
    await adminLogin(page);     // the built-in account never competes
    await openPicker(page, gOn.name);
    await expect(page.locator("#task-picker-seal-note"), "the rule is stated up front").toBeVisible();
    await expect(page.locator("#task-picker-seal-note")).toContainText(/sealed/i);

    // The picker lists EVERY published challenge, so narrow with its own box.
    await page.locator("#task-picker-search").fill(gUnsealed.title);
    const uRow = pickerRow(page, gUnsealed.title);
    await expect(uRow).toBeVisible();
    await expect(uRow, "an unsealed row is disabled").toHaveClass(/is-disabled/);
    await expect(uRow.locator("input")).toBeDisabled();
    await expect(uRow.locator(".picker-row-flag"), "…WITH its reason").toContainText("Not sealed");

    await page.locator("#task-picker-search").fill(gSealed.title);
    const sRow = pickerRow(page, gSealed.title);
    await expect(sRow).toBeVisible();
    await expect(sRow, "a sealed row is live").not.toHaveClass(/is-disabled/);
    await expect(sRow.locator("input")).toBeEnabled();
    await expect(sRow.locator(".picker-row-flag").filter({ hasText: "Not sealed" })).toHaveCount(0);
    // v8.13.7 — how the disabled row is MARKED, beside the live one. The search
    // narrows to one row at a time, so it is cleared: the full list renders
    // both, and the sealed row stays the one ticked below.
    await page.locator("#task-picker-search").fill("");
    await expectInactiveRow(pickerRow(page, gUnsealed.title), pickerRow(page, gSealed.title),
      { site: "the Add Challenges picker (task-picker-list), 'Not sealed' row" });

    await sRow.locator("input").check();
    await page.locator("#task-picker-save").click();
    await expect(page.locator("#modal-title"), "the picker confirms what it is about to add").toHaveText(/Apply challenge changes/, { timeout: 10000 });
    await expect(page.locator("#modal-body")).toContainText(gSealed.title);
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack"), "the add is reported").toContainText(/1 added/, { timeout: 15000 });
    await expect(page.locator("#modal-title"), "and nothing was refused").not.toHaveText(/Some challenges were not added/);

    await expect.poll(async () => ((await taskRow(gSealed.id)).competitions || []).map(c => c.id),
      { message: "the sealed challenge really is in the event", timeout: 10000 }).toContain(gOn.id);
    expect(((await taskRow(gUnsealed.id)).competitions || []).map(c => c.id), "…and the unsealed one is not").not.toContain(gOn.id);
  });

  test("CONTROL — on a switch-off event there is no seal note and the unsealed row is live", async ({ page }) => {
    // Otherwise "the row is disabled" is satisfied by a picker that disables
    // every unsealed challenge everywhere.
    await adminLogin(page);
    await openPicker(page, gOff.name);
    await expect(page.locator("#task-picker-seal-note"), "no rule to state").toHaveCount(0);
    await page.locator("#task-picker-search").fill(gUnsealed.title);
    const uRow = pickerRow(page, gUnsealed.title);
    await expect(uRow).toBeVisible();
    await expect(uRow).not.toHaveClass(/is-disabled/);
    await expect(uRow.locator("input")).toBeEnabled();
    await expect(uRow.locator(".picker-row-flag").filter({ hasText: "Not sealed" })).toHaveCount(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (h) THE PER-CHALLENGE "Assign to Events" DIALOG
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the per-challenge Assign to Events dialog", () => {

  async function openAssignDialog(page, title, id) {
    const row = await challengeRow(page, title, id);
    await openKebab(page, row);
    await page.locator('#kebab-portal [data-action="task-assign-to-comps"]').click();
    await expect(page.locator("#assign-task-overlay"), "the dialog opened").toBeVisible({ timeout: 15000 });
  }
  const dialogRow = (page, compName) => page.locator(`#assign-task-comp-list label:has-text("${compName}")`).first();

  test("for an UNSEALED challenge the switch-on event is disabled as 'Sealed only' and the switch-off one is live", async ({ page }) => {
    await adminLogin(page);
    await openAssignDialog(page, hUnsealed.title);
    const onRow = dialogRow(page, upOn.name), offRow = dialogRow(page, upOff.name);
    await expect(onRow, "the switch-on event is listed — disabled, not hidden").toBeVisible();
    await expect(onRow.locator("input")).toBeDisabled();
    await expect(onRow.locator(".picker-row-flag"), "…WITH its reason").toContainText("Sealed only");
    await expect(onRow).toHaveAttribute("title", /sealed/i);
    await expect(offRow.locator("input"), "CONTROL: the switch-off event takes an unsealed challenge").toBeEnabled();
    await expect(offRow.locator(".picker-row-flag")).toHaveCount(0);
    // v8.13.7 — the blocked row is MARKED (dashed, muted, full strength), the live one is not.
    await expectInactiveRow(onRow, offRow,
      { site: "a challenge's Assign to Events dialog (assign-task-comp-list), 'Sealed only' row", name: ":scope > span" });
  });

  test("for a SEALED challenge both events are live — and ticking the switch-on one SAVES", async ({ page }) => {
    // "Sealed only" is a property of the PAIR — a sealed challenge is admitted.
    // And the admission is driven through to the row: without the save, "the
    // refusal fired" in the author arm below is equally satisfied by a desired-
    // state PUT that refuses EVERY addition into a compete event, or a dialog
    // that renders the modal on every non-2xx.
    // The target is `hUpOn`, this arm's OWN switch-on event, so the write leaves
    // `upOn` — the competitor's upcoming fixture — holding exactly what beforeAll
    // gave it (a later arm that counts its challenges would otherwise inherit an
    // order dependence on this one having run).
    await adminLogin(page);
    await openAssignDialog(page, hSealed.title);
    await expect(dialogRow(page, hUpOn.name).locator("input")).toBeEnabled();
    await expect(dialogRow(page, hUpOn.name).locator(".picker-row-flag")).toHaveCount(0);
    await expect(dialogRow(page, hUpOff.name).locator("input")).toBeEnabled();

    await dialogRow(page, hUpOn.name).locator("input").check();
    const save = page.locator("#assign-task-save-btn");
    await expect(save, "a changed tick enables Save").toBeEnabled();
    await save.click();
    await expect(page.locator("#assign-task-overlay"), "the dialog closed on success").toBeHidden({ timeout: 15000 });
    await expect(page.locator("#toast-stack")).toContainText(/Challenge assignments updated/, { timeout: 15000 });
    await expect(page.locator("#modal-title")).not.toHaveText(/Some challenges were not added/);
    await expect.poll(async () => ((await taskRow(hSealed.id)).competitions || []).map(c => c.id),
      { message: "the sealed challenge really is in the switch-on event", timeout: 10000 }).toContain(hUpOn.id);
  });

  test("a sealed challenge whose AUTHOR competes is refused on Save with a modal naming the pair — and the dialog stays open", async ({ page }) => {
    // The author rule is decided server-side (the author's id is not on the
    // wire), so the dialog OFFERS the tick and the refusal arrives on Save.
    await adminLogin(page);
    await openAssignDialog(page, hSealed2.title);
    const r = dialogRow(page, hAuthorOn.name);
    await expect(r.locator("input"), "the row is offered — the client cannot see who wrote it").toBeEnabled();
    await r.locator("input").check();
    await page.locator("#assign-task-save-btn").click();
    await expect(page.locator("#modal-title")).toHaveText(/Some challenges were not added/, { timeout: 15000 });
    await expect(page.locator("#modal-body")).toContainText(hSealed2.title);
    await expect(page.locator("#modal-body")).toContainText(hAuthorOn.name);
    await expect(page.locator("#modal-body")).toContainText(/its author is competing in the event/);
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#assign-task-overlay"), "the dialog stays open so the admin can untick it and save the rest").toBeVisible();
    expect(((await taskRow(hSealed2.id)).competitions || []).map(c => c.id), "nothing was assigned").not.toContain(hAuthorOn.id);
  });

  test("for a COMPETING actor the event they compete in is disabled as 'You compete here' — a different reason from 'Sealed only' — and an event they do not compete in is live (CONTROL)", async ({ page }) => {
    // The two axes on one dialog: the competitor rule (this ACTOR may not change
    // that event's challenges) and the seal rule (that EVENT admits sealed
    // challenges only). An unsealed challenge shows both, with different words.
    await adminPanel(page, competitor.email);
    await openAssignDialog(page, plainHinted.title);
    const mine = dialogRow(page, competeLive.name);
    await expect(mine, "the event they compete in is listed — disabled, not hidden").toBeVisible();
    await expect(mine.locator("input")).toBeDisabled();
    await expect(mine.locator(".picker-row-flag"), "…WITH the competitor reason").toContainText("You compete here");
    await expect(mine).toHaveAttribute("title", /You are competing in this event/);
    const sealed = dialogRow(page, gOn.name);
    await expect(sealed.locator("input"), "a compete event they do NOT compete in is disabled for an UNSEALED challenge too…").toBeDisabled();
    await expect(sealed.locator(".picker-row-flag"), "…but for the seal reason").toContainText("Sealed only");
    await expect(sealed.locator(".picker-row-flag")).not.toContainText("You compete here");
    const off = dialogRow(page, upOff.name);
    await expect(off.locator("input"), "CONTROL: a switch-off event is live for the same actor").toBeEnabled();
    await expect(off.locator(".picker-row-flag")).toHaveCount(0);
    // v8.13.7 — BOTH reasons mark their row the same way; the live row is not marked.
    await expectInactiveRow(mine, off,
      { site: "a challenge's Assign to Events dialog (assign-task-comp-list), 'You compete here' row", name: ":scope > span" });
    await expectInactiveRow(sealed, off,
      { site: "a challenge's Assign to Events dialog (assign-task-comp-list), 'Sealed only' row beside a competing one", name: ":scope > span" });
  });

  test("a COMPETING actor's Save keeps the disabled-but-checked row of the event they compete in — the challenge stays there while ANOTHER event is added", async ({ page }) => {
    // The dialog posts a DESIRED STATE. A checked+disabled row must ride the
    // request, or the server computes the compete event as a REMOVAL — refused by
    // name, and a save that changed only an unrelated event would fail. The
    // realistic wrong implementation is `:not(:disabled):checked`.
    await adminPanel(page, competitor.email);
    // The LIBRARY question: its Assign to Events dialog lists every event using it.
    await openAssignDialog(page, sealedHinted.title, sealedHinted.bankId);
    const mine = dialogRow(page, competeLive.name);
    await expect(mine.locator("input"), "the event they compete in is CHECKED — the challenge is in it").toBeChecked();
    await expect(mine.locator("input"), "…and DISABLED — not theirs to take it out of").toBeDisabled();
    await expect(mine.locator(".picker-row-flag")).toContainText("You compete here");
    const target = dialogRow(page, hUpOff.name);
    await expect(target.locator("input"), "a switch-off event is live for the same actor").toBeEnabled();
    await target.locator("input").check();
    const save = page.locator("#assign-task-save-btn");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator("#assign-task-overlay"), "the dialog closed on success").toBeHidden({ timeout: 15000 });
    await expect(page.locator("#toast-stack")).toContainText(/Challenge assignments updated/, { timeout: 15000 });
    await expect(page.locator("#modal-title")).not.toHaveText(/Some challenges were not added/);
    await expect.poll(async () => ((await taskRow(sealedHinted.bankId)).competitions || []).map(c => c.id).sort(),
      { message: "the challenge is in BOTH the compete event and the added one", timeout: 10000 })
      .toEqual(expect.arrayContaining([competeLive.id, hUpOff.id]));
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (i) THE PARTICIPANTS PANE WITH AN EVENT FOCUSED
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the Participants pane and a staff-tagged row", () => {

  test("with a switch-ON event focused a staff row offers Invite and a checkbox; with a switch-OFF one it offers neither", async ({ page }) => {
    await adminLogin(page);
    await focus(page, upOn.name);
    await clickTab(page, "Participants");
    let row = await participantRow(page, staffP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "a staff row can be selected for a compete event").toHaveCount(1);
    await openKebab(page, row);
    const invite = page.locator('#kebab-portal [data-action="participant-invite"]');
    await expect(invite, "…and invited to it").toHaveCount(1);
    await expect(invite).toContainText(`Invite to ${upOn.name}`);
    await closeKebab(page);

    await focus(page, upOff.name);
    await clickTab(page, "Participants");
    row = await participantRow(page, staffP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "the server would skip a staff enrolment here, so no checkbox").toHaveCount(0);
    await openKebab(page, row);
    await expect(page.locator('#kebab-portal [data-action="participant-invite"]'), "…and no Invite").toHaveCount(0);
    // …but the row is not merely inert: what an admin CAN do with it stays.
    await expect(page.locator('#kebab-portal [data-action="participant-history"]'), "History is still offered").toHaveCount(1);
    await closeKebab(page);

    // CONTROL: a NON-staff row on the same switch-off event keeps both, so the
    // withholding above is about the tag rather than about the event.
    row = await participantRow(page, plainP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]")).toHaveCount(1);
    await openKebab(page, row);
    await expect(page.locator('#kebab-portal [data-action="participant-invite"]')).toHaveCount(1);
  });

  test("when the ACTOR competes in the focused event: no Invite for anybody, Remove only for themselves", async ({ page }) => {
    await adminPanel(page, competitor.email);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    // Somebody NOT enrolled: no checkbox and no Invite — the assign door refuses
    // a competitor for every target.
    const portal = page.locator("#kebab-portal");
    let row = await participantRow(page, plainP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]")).toHaveCount(0);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="participant-invite"]')).toHaveCount(0);
    // WITH THE REASON (v7.14.2): the absence is explained on the row, naming the
    // event — or a menu two items shorter reads as a broken feature.
    await expect(portal.locator(".kebab-note"), "withheld WITH its reason").toContainText(/You are competing in/);
    await expect(portal.locator(".kebab-note")).toContainText(competeLive.name);
    await expect(portal.locator(".kebab-note")).toContainText(/its participants cannot be changed from here/);
    // Round 3: the organiser grant is a competitor door too, so "Make event
    // admin of …" — offered to a global admin on any focused event — goes.
    await expect(portal.locator('[data-action="participant-event-admin-grant"]'), "the organiser grant reaches a door the server refuses").toHaveCount(0);
    await expect(portal.locator('[data-action="participant-event-admin-revoke"]')).toHaveCount(0);
    await closeKebab(page);
    // Somebody ELSE who is enrolled: no Remove — the removal door refuses a
    // competitor for every uid but their own.
    row = await participantRow(page, mateP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "an enrolled row never carries a checkbox").toHaveCount(0);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="participant-uninvite"]'), "removing a fellow competitor is withheld").toHaveCount(0);
    await expect(portal.locator('[data-action="participant-event-admin-grant"]')).toHaveCount(0);
    // A fellow competitor in the focused event is also a RIVAL through it, so
    // the roster note and the rival note fold into ONE sentence — two notes
    // saying two halves of one thing under each other is noise (round 4).
    await expect(portal.locator(".kebab-note"), "ONE note, not a roster note over a rival note").toHaveCount(1);
    await expect(portal.locator(".kebab-note")).toContainText(/You are competing in/);
    await expect(portal.locator(".kebab-note")).toContainText(/alongside/);
    await expect(portal.locator(".kebab-note")).toContainText(/neither its participants nor their account can be changed from here/);
    await expect(portal.locator('[data-action="participant-history"]'), "…while viewing stays").toHaveCount(1);
    await closeKebab(page);
    // THEMSELVES: the one door the server keeps open is self-removal — and on
    // their OWN row nothing is withheld, so nothing is explained.
    row = await participantRow(page, competitor.email);
    await openKebab(page, row);
    const rm = portal.locator('[data-action="participant-uninvite"]');
    await expect(rm, "the escape hatch is offered").toHaveCount(1);
    await expect(rm).toContainText(`Remove from ${competeLive.name}`);
    // (The peer-admin note renders on this row — an admin reading their OWN
    // admin account — so the filter is on the COMPETING note specifically.)
    await expect(portal.locator(".kebab-note").filter({ hasText: /You are competing/ }), "no competing note on the row where Remove is still offered").toHaveCount(0);
  });

  test("after a FORM sign-in (no reload) the competitor's OWN row still offers Remove — the login payload carries `id`", async ({ page }) => {
    // Round 3 (C14): every arm above signs in through the API and then loads
    // the app, so `S.currentUser` comes from `/api/me`, which carries `id`.
    // The FORM login sets `S.currentUser` from `POST /api/login`'s own body and
    // never re-reads `/api/me` until a reload — and that body carried no `id`,
    // so "is this MY row" was false for every row and the escape hatch (the
    // competitor's own Remove) was withheld until a reload put the id back.
    // The login payload carries `id` now; this drives the door the API-login
    // arms structurally cannot.
    await formLogin(page, competitor.email, PARTICIPANT_PASS);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().waitFor({ state: "visible", timeout: 30000 });
    expect(await page.evaluate(() => window.currentUser && window.currentUser.id), "PRECONDITION: the form login populated S.currentUser.id (mirrored on window)").toBe(competitor.id);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    const portal = page.locator("#kebab-portal");
    const row = await participantRow(page, competitor.email);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="participant-uninvite"]'), "the escape hatch is offered on their OWN row straight after a form sign-in").toHaveCount(1);
    await expect(portal.locator(".kebab-note").filter({ hasText: /You are competing/ }), "…and no competing note on it").toHaveCount(0);
    await closeKebab(page);
    // CONTROL in the same session: somebody ELSE's row is still withheld, so the
    // id did not merely make every row read as "mine".
    const other = await participantRow(page, mateP.email);
    await openKebab(page, other);
    await expect(portal.locator('[data-action="participant-uninvite"]'), "CONTROL: a fellow competitor's Remove is still withheld").toHaveCount(0);
    await expect(portal.locator(".kebab-note")).toContainText(/You are competing in/);
  });

  test("CONTROL — a NON-competing actor still sees Remove on somebody ELSE's row, and Invite on an unenrolled one, with the same event focused", async ({ page }) => {
    // Without this, "Remove only for themselves" is satisfied by a build whose
    // `canUninvite` ends in `&& _isSelf` for EVERYBODY — Remove only ever
    // offered for yourself, stripping every admin of the ordinary Remove on
    // every enrolled row.
    await adminLogin(page);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    const portal = page.locator("#kebab-portal");
    let row = await participantRow(page, mateP.email);
    await openKebab(page, row);
    const rm = portal.locator('[data-action="participant-uninvite"]');
    await expect(rm, "the built-in superadmin, who competes nowhere, may remove a competitor").toHaveCount(1);
    await expect(rm).toContainText(`Remove from ${competeLive.name}`);
    // (A participant who has signed in carries the desk-code note — a code is
    // shown at the desk only before a first sign-in — which no lock withholds.)
    await expect(portal.locator(".kebab-note").filter({ hasNotText: /signed in before/ }), "nothing is withheld, so nothing is explained").toHaveCount(0);
    await closeKebab(page);
    row = await participantRow(page, plainP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "…and select an unenrolled row").toHaveCount(1);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="participant-invite"]'), "…and invite them").toHaveCount(1);
    // CONTROL for the organiser-grant withholding: the same row, the same
    // focused event, an actor who competes nowhere — the item is offered.
    const grant = portal.locator('[data-action="participant-event-admin-grant"]');
    await expect(grant, "…and make them an organiser of it").toHaveCount(1);
    await expect(grant).toContainText(`Make event admin of "${competeLive.name}"`);
  });

  test("a LEGACY staff row on a switch-OFF event still offers Remove — the row an organiser most needs to take off", async ({ page }) => {
    // Round 3: `canUninvite` deliberately takes no `_staffOkHere`. A staff row on
    // a non-compete event can exist (written before this release, or by a
    // promotion AFTER enrolment, which adds the tag and deletes no rows), and it
    // is exactly the row the organiser needs to remove — withholding Remove there
    // is v7.14.2 with the sides swapped.
    await adminLogin(page);
    await focus(page, upOff.name);
    await clickTab(page, "Participants");
    const row = await participantRow(page, legacyP.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "an enrolled row carries no checkbox").toHaveCount(0);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator('[data-action="participant-invite"]'), "no Invite — they are already in").toHaveCount(0);
    const rm = portal.locator('[data-action="participant-uninvite"]');
    await expect(rm, "Remove survives the tag").toHaveCount(1);
    await expect(rm).toContainText(`Remove from ${upOff.name}`);
    // (A participant who has signed in carries the desk-code note — a code is
    // shown at the desk only before a first sign-in — which no lock withholds.)
    await expect(portal.locator(".kebab-note").filter({ hasNotText: /signed in before/ }), "nothing is withheld, so nothing is explained").toHaveCount(0);
  });

  test("on an ENDED compete event they compete in, the organiser-grant item is withheld WITH its reason", async ({ page }) => {
    // The grant item is gated on `_focusComp.competing` with no status term, so
    // it goes on an ended focused event too — while the note that explains the
    // absence requires `_compNotEnded`. A non-competitor still sees the item on
    // an ended focused event (the control below), so the shrink is real.
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `competingNoteKm` renders on an ENDED focused compete event too, with
    // copy that names no self-removal there.
    await adminPanel(page, saComp.email);
    await focus(page, endLater.name);
    await clickTab(page, "Participants");
    const row = await participantRow(page, plainP.email);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator('[data-action="participant-event-admin-grant"]'), "the grant reaches a door the server refuses").toHaveCount(0);
    await expect(portal.locator(".kebab-note"), "…and the absence is explained").toContainText(/You are competing in/);
  });

  test("CONTROL — the built-in superadmin is offered the organiser grant on that same ENDED event", async ({ page }) => {
    await adminLogin(page);
    await focus(page, endLater.name);
    await clickTab(page, "Participants");
    const row = await participantRow(page, plainP.email);
    await openKebab(page, row);
    const grant = page.locator('#kebab-portal [data-action="participant-event-admin-grant"]');
    await expect(grant, "the grant is not status-gated for an actor who competes nowhere").toHaveCount(1);
    await expect(grant).toContainText(`Make event admin of "${endLater.name}"`);
  });

  test("on a compete event a REGULAR admin's Invite is withheld on an admin's row — and offered on a participant's row and on their OWN (CONTROLS)", async ({ page }) => {
    // The assign door skips an admin/superadmin target for a non-superadmin
    // actor (`skippedPrivileged`) unless the target is the actor — enrolling a
    // peer as a competitor is managing their account. The Invite item follows
    // the same predicate. `privOn` is an event `competitor` does NOT compete in:
    // on one they compete in, Invite is withheld for everybody and this reason
    // is unreachable.
    await adminPanel(page, competitor.email);
    await focus(page, privOn.name);
    await clickTab(page, "Participants");
    let row = await participantRow(page, author.email);
    await openKebab(page, row);
    await expect(page.locator('#kebab-portal [data-action="participant-invite"]'), "no Invite for a fellow admin on a compete event").toHaveCount(0);
    await expect(page.locator('#kebab-portal [data-action="participant-history"]'), "viewing stays").toHaveCount(1);
    await closeKebab(page);
    row = await participantRow(page, plainP.email);
    await openKebab(page, row);
    await expect(page.locator('#kebab-portal [data-action="participant-invite"]'), "CONTROL: a participant row is invitable to the same event").toHaveCount(1);
    await closeKebab(page);
    row = await participantRow(page, competitor.email);
    await openKebab(page, row);
    const self = page.locator('#kebab-portal [data-action="participant-invite"]');
    await expect(self, "CONTROL: their OWN row is invitable — the ordinary way an organiser joins the event they will compete in").toHaveCount(1);
    await expect(self).toContainText(`Invite to ${privOn.name}`);
  });

  test("CONTROL — a SUPERADMIN sees Invite on that same admin's row on that same event", async ({ page }) => {
    // The other half of the peer rule: a superadmin may enrol an admin.
    await adminLogin(page);
    await focus(page, privOn.name);
    await clickTab(page, "Participants");
    const row = await participantRow(page, author.email);
    // CONTROL for the checkbox arm below: the built-in may bulk-select that
    // admin's row for the compete event.
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "a superadmin may select the admin's row").toHaveCount(1);
    await openKebab(page, row);
    const invite = page.locator('#kebab-portal [data-action="participant-invite"]');
    await expect(invite).toHaveCount(1);
    await expect(invite).toContainText(`Invite to ${privOn.name}`);
  });

  test("on a compete event a REGULAR admin's row-select checkbox is withheld on an admin's row, like its Invite item", async ({ page }) => {
    // One row, two answers: the kebab withholds Invite by the peer rule while
    // the checkbox still offers "Assign to <event>" for a target the server is
    // certain to skip (`skippedPrivileged`) — the cb-cell condition tests the
    // staff and competing terms but never `_peerOk`.
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the row-select checkbox is gated on `_peerOk` like the row's Invite item.
    await adminPanel(page, competitor.email);
    await focus(page, privOn.name);
    await clickTab(page, "Participants");
    const row = await participantRow(page, author.email);
    await expect(row.locator("td.cb-cell input[type=checkbox]"), "no checkbox for a target the assign door will skip").toHaveCount(0);
  });

  test("the INVITE DIALOG disables the event the actor competes in as 'You compete here' and does NOT pre-tick it though it is the focused event — an event they do not compete in is live (CONTROL)", async ({ page }) => {
    // Round 3: the invitation route refuses the whole request for any named
    // event the actor competes in (403 by name), and the dialog PRE-TICKS the
    // focused event — so without the gate it opened with the one box the server
    // was certain to refuse already ticked.
    await adminPanel(page, competitor.email);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    await page.locator("#invite-participants-btn").click();
    const overlay = page.locator("#invite-overlay");
    await expect(overlay, "the invite dialog opened").toBeVisible({ timeout: 15000 });
    const mine = overlay.locator(`label.picker-row:has-text("${competeLive.name}")`).first();
    await expect(mine, "the event they compete in is listed — disabled, not hidden").toBeVisible();
    await expect(mine).toHaveClass(/is-disabled/);
    await expect(mine.locator("input.invite-comp-cb")).toBeDisabled();
    await expect(mine.locator("input.invite-comp-cb"), "…and NOT pre-ticked, focused or not").not.toBeChecked();
    await expect(mine.locator(".picker-row-flag"), "…WITH its reason").toContainText("You compete here");
    await expect(mine).toHaveAttribute("title", /You are competing in this event/);
    const other = overlay.locator(`label.picker-row:has-text("${plainLive.name}")`).first();
    await expect(other.locator("input.invite-comp-cb"), "CONTROL: an event they do not compete in is offered").toBeEnabled();
    await expect(other).not.toHaveClass(/is-disabled/);
    await expect(other.locator(".picker-row-flag")).toHaveCount(0);
    // v8.13.7 — how the disabled row is MARKED, in BOTH themes: the old 50% fade
    // composited the name and the flag below AA, measured worst in dark. The
    // enabled control is NOT muted here either: the rows sit inside a
    // `.form-group`, whose `label` rule used to mute (and stack) every row.
    const site = "the Invite Participants dialog (invite-comp-list), 'You compete here' row";
    await expectInactiveRow(mine, other, { site });
    await toDarkTheme(page);
    await expectInactiveRow(mine, other, { site, theme: "dark" });
  });

  test("CONTROL — the built-in's invite dialog PRE-TICKS the focused compete event, enabled", async ({ page }) => {
    // Or "not pre-ticked" is satisfied by a dialog that stopped pre-ticking the
    // focused event for everybody.
    await adminLogin(page);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    await page.locator("#invite-participants-btn").click();
    const overlay = page.locator("#invite-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    const mine = overlay.locator(`label.picker-row:has-text("${competeLive.name}")`).first();
    await expect(mine.locator("input.invite-comp-cb"), "the focused event is pre-ticked for an actor who competes nowhere").toBeChecked();
    await expect(mine.locator("input.invite-comp-cb")).toBeEnabled();
    await expect(mine).not.toHaveClass(/is-disabled/);
  });

  test("the DESK SHORTCUT refuses a competitor with the focused event named, before any address is asked for — and nothing leaves the browser", async ({ page }) => {
    // Round 3: the desk shortcut enrols into the FOCUSED event, a competitor
    // door. The button is static markup, so the reason is spoken on the click.
    await adminPanel(page, competitor.email);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    /** @type {string[]} */ const posts = [];
    await page.route("**/api/admin/participants/desk-invite", async (route, req) => {
      if (req.method() === "POST") posts.push(req.postData() || "");
      await route.continue();
    });
    await page.locator("#desk-invite-btn").click();
    const toast = page.locator("#toast-stack");
    await expect(toast, "refused WITH the reason").toContainText(/You are competing in/, { timeout: 10000 });
    await expect(toast).toContainText(competeLive.name);
    await expect(page.locator("#prompt-input"), "no address prompt opens").toHaveCount(0);
    expect(posts.length, "no desk-invite request left the browser").toBe(0);
  });

  test("CONTROL — the built-in's desk shortcut opens the address prompt on the same focused event", async ({ page }) => {
    await adminLogin(page);
    await focus(page, competeLive.name);
    await clickTab(page, "Participants");
    await page.locator("#desk-invite-btn").click();
    await expect(page.locator("#prompt-input"), "the prompt opens for an actor who competes nowhere").toBeVisible({ timeout: 10000 });
    await expect(page.locator("h3", { hasText: /Add someone at the desk/ })).toBeVisible();
    // `#toast-stack` exists only once a toast has been shown, so the absence is
    // asserted as a COUNT rather than through a locator that may not resolve.
    await expect(page.getByText(/You are competing in/), "no refusal was spoken").toHaveCount(0);
    await page.locator("#prompt-cancel").click();
    await expect(page.locator("#prompt-input")).toHaveCount(0);
  });
});
