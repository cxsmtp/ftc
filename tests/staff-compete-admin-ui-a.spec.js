// @ts-check
//
// v8.12.0 — "STAFF CAN COMPETE", the ADMIN half, in a real browser.
//
// The API specs pin what the SERVER refuses: the switch is locked once the event
// has started, refused on with an unsealed challenge assigned, refused off with
// staff enrolled, and every mutating door on an event the actor competes in
// answers 403 `competitor_cannot_edit`. This file pins what the CLIENT OFFERS —
// the other half of the same rule and the half nothing else can see: "gate the
// affordance and the EXPLANATION together" (v7.14.2). A control the server is
// certain to refuse, left on screen, is reported as a broken feature; one
// silently removed from an actor who should have it is a support ticket nobody
// can diagnose from any screen.
//
// EVERY positive assertion here carries a CONTROL — a switch-off twin, an
// unrelated challenge, a non-staff row, the built-in superadmin who can never
// compete — because "the item is absent" is equally satisfied by a build that
// removed the item from everybody, and "the box is disabled" by a build whose
// box is always disabled.
//
// THE ACTORS, and why each is the shape it is:
//   • THE BUILT-IN SUPERADMIN holds no `users` row, so it can never hold a
//     `competition_users` row and can never be a competitor. It drives every
//     "the switch itself" arm and every picker/dialog arm — the surfaces whose
//     rules are about the EVENT rather than about the actor — and it is the
//     CONTROL for every "a competitor loses this" arm.
//   • `competitor` is a participant PROMOTED to admin (auto-tagged `staff`) and
//     ENROLLED in a switch-on event. That enrolment is what makes them a
//     competitor; the tier is what makes the withholding interesting — a regular
//     admin can ordinarily edit every event and every unsealed challenge.
//   • `saComp` is a USER-BACKED SUPERADMIN enrolled in the same event. DESIGN
//     decision 2 is "cannot edit = every mutating action, ALL tiers including
//     superadmin", and the superadmin tier is the ONLY one where the competitor
//     rule is the SOLE thing withholding a control: a regular admin never sees
//     Delete on an Events row, never Lock / Recalculate / Delete on a challenge
//     row, and cannot edit an ended event — so every absence a regular admin
//     shows is either seal-shared or structurally never rendered. Only this
//     actor makes `!competing` on those three branches a lock.
//   • `author` / `author2` are admins who SEAL challenges. Sealing needs a
//     USER-BACKED author (sealAtCreateDenied refuses the built-in account, which
//     would produce an unowned seal), and the author rule needs them to be
//     somebody an event can enrol. `author` is also the PRIVILEGED target of the
//     peer-admin arms: an admin role a regular admin may not enrol as a
//     competitor.
//   • `staffP` / `staffP2` are plain participants TAGGED `staff` — the toggle-off
//     refusal names staff-TAGGED rows only, and the participants pane keys its
//     checkbox and Invite item on the tag. `staffP3` is tagged AND BLOCKED, so the
//     assign door's ordering (blocked before staff) has a row to answer about.
//   • `pAuth` is an EVENT ADMIN of the switch-off `aUp`, ENROLLED there, and the
//     author of a SEALED challenge assigned there — the only shape that can hold
//     "an enrolled person wrote one of its challenges" BEFORE the switch is on:
//     an event-admin row is admitted to a switch-off event where a staff-tagged
//     one is skipped. It drives the third refusal modal (round-3 a).
//   • `legacyP` was enrolled in `upOff` as a participant and promoted AFTERWARDS
//     (the role route adds the tag and deletes no rows): the legacy staff row an
//     organiser must still be able to Remove.
//   • `eaP` (event-admin ROLE) and `agP` are enrolled together in `agOff`, a
//     switch-OFF capped event holding an unsealed challenge — the Grant Attempts
//     roster's NEGATIVE twin, without which `_agStaffCompete||…` survives `true||…`.
//   • `scgrp` / `scgrpBound` are EMPTY groups, the second bound to `competeLive`
//     by the built-in — the Events dialog arm and the group-controls defect.
//
// SINGLE SESSION PER USER decides where the fixtures live. `adminLogin(page)`
// signs the BROWSER in as the built-in superadmin, which invalidates the request
// context that built the world — so every fixture is built in `beforeAll`, and
// every read-back afterwards goes through `reader`, a USER-BACKED superadmin
// that is never signed into a browser and whose session therefore survives the
// whole file. For the same reason a test never signs TWO actors into one page:
// the old SPA's polls carry the pre-regeneration CSRF token, the interceptor
// reads the mismatch as a dead session and POSTs /api/logout (v7.19.0). A
// competitor arm and its built-in control are therefore two tests.
//
// FIXTURE TRAPS MET WHILE WRITING THIS, each now a line of the fixture or a
// sentence beside the helper that absorbs it:
//   • an ENDED single-slot event is created with a PAST start — the edit form
//     for it is reachable only by a superadmin, which is why the built-in
//     account drives that arm rather than `competitor`;
//   • `#comp-staff-compete-lock-note` renders ONLY when the server sent
//     `staff_compete_locked`, so the upcoming control asserts the note's ABSENCE
//     as well as the box's enabled state;
//   • the lock is about the EVENT having started, never about the switch being
//     on — so a LIVE switch-OFF event is locked too, and that arm is the only
//     thing separating the shipped `switchLock` from a build that computes the
//     lock only for switch-on rows (which would let an admin turn it ON
//     mid-event, the lock's whole purpose);
//   • the History dialog's "Not while competing" replaces the RESTORE button,
//     which renders only on a NON-current version — a challenge with one
//     version has no such row, so the sealed challenge is EDITED once by its
//     author in `beforeAll` (measured: the first draft asserted against a
//     one-row history and failed);
//   • `editTask` hides the challenge TABLE, so a row's View button must be
//     clicked BEFORE the editor is opened, never after (measured: "element is
//     not visible" on a button that had been visible a moment earlier);
//   • re-entering the Participants tab re-runs `loadAdminParticipants`, which
//     CLEARS the selection — a row helper that clicked the tab per row dropped
//     every earlier tick (measured: two rows ticked, one in the selection);
//   • a participants-row kebab is closed with a NEUTRAL CLICK, never Escape,
//     which can leave the click-outside listener armed to close the NEXT menu
//     on the click that opens it (participant-actions-matrix, v7.21.3);
//   • the participants pane renders a staff row's checkbox whenever NO event is
//     focused, which is what makes the bulk-assign arm drivable through the real
//     controls rather than mocked;
//   • the bulk-assign control for the staff skip uses a DEDICATED participant
//     (`plainP2`), because enrolling it in the switch-off event would remove the
//     checkbox and Invite item the focused-pane control asserts on `plainP`;
//   • the `.tag-x` withholding needs a TAGGED event, or "no × is offered" is true
//     of every untagged row on the platform — both `competeLive` and `plainLive`
//     carry a tag from `beforeAll`;
//   • the peer-admin arms (a regular admin may not enrol an admin as a
//     competitor) use their OWN compete event, `privOn`, that `competitor` does
//     NOT compete in — on an event they compete in, Invite is withheld for
//     everybody and the reason under test is unreachable; and `author` must not
//     have written a challenge assigned there, or the skip reason is ambiguous;
//   • the rename-of-a-locked-event arms use their OWN live events (`renOn`,
//     `renOff`): a rename moves the name every later `eventRow` lookup filters
//     on;
//   • `competeLive` carries an ATTEMPT CAP so the Grant Attempts dialog has an
//     event to withhold from a competitor — and one to offer the built-in;
//   • the arms that WRITE an assignment ((h)#2, the competitor Save) target their
//     OWN events (`hUpOn`, `hUpOff`), so `upOn` / `upOff` stay pure fixtures for
//     every arm that reads them;
//   • `#toast-stack` exists only once a toast has been shown, so "no refusal was
//     spoken" is a COUNT over the text, never `not.toContainText` on the stack
//     (measured: the control failed on a locator that could not resolve);
//   • the attachment chip list renders ASYNCHRONOUSLY, so the chip is awaited
//     before its controls are counted — a zero over a list not yet painted
//     proves nothing; Download is ALSO `.tf-attach-chip-action`, so the count is
//     over `button.` and the `<a download>` is asserted separately;
//   • the competitor's OWN participants row carries the PEER-admin note (an
//     admin reading their own admin account), so "no competing note here" is a
//     filtered count, not a bare `.kebab-note` count of zero;
//   • the feedback "Delete All" renders only over TWO or more ratings, so the
//     purge arms assert the per-row Remove alone — the fixture holds one rating,
//     left as a RATING and never a submission (one participant solving the only
//     challenge would auto-end the event);
//   • `showPrompt` renders its own overlay (`#prompt-input` / `#prompt-cancel`),
//     not `#modal-overlay`, so the desk arms key on those ids.
//
// PRODUCT DEFECTS FOUND WHILE WRITING THIS — each was pinned as a `test.fixme`
// with its intended assertion in place, seen RED against the first draft, and
// FIXED in the same release with the fixme lifted (every arm below holds):
//   • the SCOPE BANNER offers a competitor End Now on the live event the kebab
//     withholds it for (competitions-admin.js renderScopeBanner, no `competing`
//     term — two confirmations then a 403);
//   • two CLIENT remedy copies promise self-removal unconditionally where round 3
//     made the SERVER's honest on ENDED events (competitions-admin.js
//     editCompetition's toast; challenges-admin.js `#tf-sealed-note`, whose
//     `competing_in` entries carry no ended flag to branch on);
//   • the organiser-grant item is withheld on an ENDED focused compete event
//     while its explanatory note requires `_compNotEnded` — a silently shrunk menu;
//   • the bulk-select checkbox renders on an admin's row for a REGULAR admin on
//     a compete event while the same row's Invite is withheld by the peer rule;
//   • the Groups pane offers Delete and the Members dialog's Add/Remove on a group
//     bound to the event the actor competes in (the list carries no competitor
//     flag), where the server refuses all three;
//   • the author's editor offers Unseal on a sealed challenge held by a compete
//     event; the save ends in a 409 the client cannot pre-empt (the row's
//     `competitions[]` entries carry `staff_compete` now, and the tick is
//     withheld with its reason).
//
// VERIFIED MUTATIONS (each applied to a throwaway copy of the tree, run on its
// own port base, and restored; the arm named is the one that went red):
//   • competitions-admin.js `if(S.isSuperAdmin&&!competing)` → `!competing`
//     dropped: (e) "a user-backed SUPERADMIN who competes" (Delete reappears);
//   • competitions-admin.js `canEdit=!competing&&…` → `!competing&&` dropped:
//     (e)#1, the Start Now arm's Edit assertion, and the superadmin arm (Edit
//     reappears on both competeLive and the ENDED endLater); the (e) CONTROL stays green;
//   • challenges-admin.js `if(S.isSuperAdmin&&!_competes)` → `!_competes`
//     dropped: (f) "a user-backed SUPERADMIN who competes" (Lock/Recalc/Delete);
//   • competitions-admin.js tag cell — the `competing?'':` ternary around the
//     `×` dropped: (e)#1's `.tag-x` count;
//   • lib/competitions.js `staff_compete_locked: row.staff_compete ? … : null`:
//     the beforeAll wire precondition on `plainLive` fires first; with that
//     precondition removed, (b) "a LIVE switch-OFF event is locked too", the
//     ENDED switch-OFF arm and the rename arm's OFF half all go red on their own;
//   • competitions-admin.js saveCompetition — the
//     `else if(showStaffCompeteRefusalModal(d,_seam))` branch deleted (bare
//     toast): (c)#1 and (d)#1, which drive the real form;
//   • participants-admin.js `canUninvite … (!_actorCompetes||_isSelf)` →
//     `&&_isSelf`: (i) "a NON-competing actor still sees Remove";
//   • participants-admin.js `_peerOk` forced true: (i) "Invite is withheld on a
//     privileged row";
//   • participants-admin.js renderStep1 — the `competing` gate dropped: (j) "the
//     participants-side bulk picker disables the event the actor competes in";
//   • participants-admin.js `_assignSkipNote` — the skippedPrivileged line
//     dropped: (j) "a regular admin's attempt to enrol an admin";
//   • participants-admin.js submitInvitations — the five v8.12.0 ledger lines
//     dropped: (l) "the invite dialog toast names every skip reason".
//   Round-3 arms (each run with `-g` against the named test on port base 6110;
//   the copy's global-setup spawner pre-flight was narrowed to the worker slot,
//   because 6110+190 is another agent's worker — the spec spawns no server):
//   • competitions-admin.js showStaffCompeteRefusalModal — the
//     `staff_compete_enrolled_authors` block deleted: (c) "Remove these authors
//     first" AND the renderer arm's third payload;
//   • participants-admin.js — `&&!(_focusComp&&_focusComp.competing)` dropped
//     from the organiser-grant gate: (i) "no Invite for anybody, Remove only for
//     themselves" (the grant item reappears);
//   • participants-admin.js `competingNoteKm` forced empty: the same (i) arm
//     (the note assertions);
//   • challenges-admin.js — the `!_sealHeld.length` term dropped from the
//     Unseal row's gate: (h) "the AUTHOR's editor withholds Unseal" ("the
//     Unseal tick is withheld where the server refuses the save");
//   • challenges-admin.js — `_leavable` forced true on the held-note: the same
//     (h) arm on "no 'take it out first' on a finished event";
//   • server.js POST /api/login — `id: user.id` dropped from the payload: (i)
//     "after a FORM sign-in (no reload) the competitor's OWN row still offers
//     Remove", on its precondition;
//   • participants-admin.js deskInvite — the competitor guard deleted: (i) "the
//     DESK SHORTCUT refuses a competitor";
//   • challenges-admin.js challengesBulkAssign — `!comp.competing` dropped: (k)
//     "the selection bar reads 'Assign to Events'" (a confirm modal opens instead
//     of the picker); updateChallengeSelectionBar — the same term dropped: the
//     same arm (`#add-tasks-to-comp-btn` reappears, the label names the event);
//   • challenges-admin.js `_renderTaskFormAttachments` `readOnly` forced false:
//     (f) "the kebab names the event and withholds Edit" (Rename/Remove
//     reappear); the `tf-attach-add-btn` display forced shown: the same arm;
//   • challenges-admin.js feedback — `!_fbCompetes` dropped from the per-row
//     Remove: (f) "not offered the feedback purge";
//   • groups-admin.js manageGroupCompetitions — `${competing?'disabled':''}`
//     dropped: (m) "the group's Events dialog disables";
//   • participants-admin.js `canUninvite` given `&&_staffOkHere`: (i) "a LEGACY
//     staff row on a switch-OFF event still offers Remove";
//   • participants-admin.js openInviteDialog — `${competing?'disabled':''}`
//     dropped: (i) "the INVITE DIALOG disables the event the actor competes in";
//   • challenges-admin.js saveTaskCompAssignments —
//     `input[type="checkbox"]:checked` → `:not(:disabled):checked`: (h) "a
//     COMPETING actor's Save keeps the disabled-but-checked row" (the server
//     refuses the phantom removal by name);
//   • challenges-admin.js Grant Attempts roster — `_agStaffCompete||` → `true||`:
//     (k) "the roster lists the participant and NOT the enrolled
//     event-admin-role row";
//   • routes/participants.js assign door — the blocked/unapproved skips moved
//     BELOW the staff skip: (j) "a BLOCKED staff-tagged user … is reported as
//     BLOCKED";
//   • routes/challenges.js versions — `delete red.hint` dropped: (f) "View as
//     Participant says the hint is WITHHELD, and History offers no Restore" (the
//     by-value check that runs once the History dialog has rendered).
//   Round-4 arms (the operator's three rulings of 19 Sep 2026 — the RIVAL
//   account doors, the read-only Join Link — and the out-of-scope Unseal hold;
//   each run with `-g` against the named arm on port base 7400, restored by
//   `cmp` from a snapshot of the FIXED tree):
//   • routes/participants.js — `rival_in: _rivalMap.get(u.id) || null` →
//     `rival_in: null` on BOTH projections: (o) both rival-row arms (the
//     benchmark × and the role menu reappear);
//   • participants-admin.js — `!(_rival&&t==='benchmark')` dropped from the
//     tag-chip `×`: (o) the regular-admin arm ("…without its ×");
//   • self-enroll.js openSelfEnrollOverlay — `_competing` forced false: (n) "a
//     COMPETITOR opens it and sees … the toggle DISABLED" ("the reason is on
//     screen"); its built-in CONTROL stays green;
//   • competitions-admin.js — the Join Link kebab item put back under
//     `!competing`: (e)#1 ("comp-self-enroll is viewing, not editing, so it
//     stays") AND (n)#1 ("Join Link is offered on …");
//   • routes/challenges.js — the `withheld_compete` spread dropped from the task
//     row: (f) "an EVENT-ADMIN author whose sealed challenge sits only in a
//     compete event OUTSIDE their scope" on its PRECONDITION (and the seal API
//     spec's own arm, run separately);
//   • challenges-admin.js — `_sealHeldAway` forced 0: the same (f) arm on "the
//     Unseal tick is withheld — the save would meet the scoped 409", and ONLY it
//     (the in-scope Unseal arm beside it stays green);
//   • participants-admin.js — `_rivalIsFocused` forced false (the roster note
//     and the rival note both render on a fellow competitor's row): (i) "no
//     Invite for anybody, Remove only for themselves" on "ONE note, not a roster
//     note over a rival note".
//   Every one killed the arm named and only that arm was run against it; the
//   whole file was not re-run per mutation.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS } = require("./helpers");
const F = require("./staff-compete-admin-ui-fixture");
const {
  iso, attach, makeAdmin, tagStaff, tagComp, compRow, taskRow, participantAdminRow,
  adminPanel, eventRow, openEdit, saveEdit, challengeRow, participantRow, closeKebab, focus,
  H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin,
  loginViaApi, formLogin, adminLogin, clickTab, openKebab, viewComp, filterComps, findSeededTaskRow, openCompCreateForm, openEventMenu,
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
// (a) THE CREATE FORM
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the switch on the CREATE form", () => {

  test("every kind's create form offers Staff can compete, unticked, with its hint", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    // Universal: no policy key and no per-kind seed, so all three kinds render it
    // and none pre-ticks it (off = today's behaviour for every existing event).
    for (const kind of ["tournament", "booth", "program"]) {
      await openCompCreateForm(page, kind);
      const box = page.locator("#comp-staff-compete");
      await expect(box, `${kind}: the box is offered at CREATE`).toBeVisible();
      await expect(box, `${kind}: …and starts UNTICKED`).not.toBeChecked();
      await expect(box, `${kind}: …and is ENABLED — nothing has started`).toBeEnabled();
      const hint = page.locator("#comp-staff-compete-hint");
      await expect(hint, `${kind}: with its consequences stated before the click`).toBeVisible();
      await expect(hint).toContainText(/sealed/i);
      await expect(hint).toContainText(/leaderboard/i);
      // The hint states the TAG rule, not "every admin tier": who counts as staff
      // (anyone tagged staff, and event admins), and that a staff-tagged user can
      // only be added to an event with the switch on.
      await expect(hint, `${kind}: names who counts as staff`).toContainText(/anyone tagged staff/i);
      await expect(hint).toContainText(/event admins/i);
      await expect(hint, `${kind}: …and the assignment rule`).toContainText(/can only be added to an event with this switch on/i);
      await expect(page.locator("#comp-staff-compete-lock-note"), `${kind}: no lock note on a create`).toHaveCount(0);
      await expect(page.locator("label:has(#comp-staff-compete)")).toContainText("Staff can compete");
      await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
      await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 10000 });
    }
  });

  test("ticking it and saving round-trips staff_compete:true — and leaving it clear round-trips false (CONTROL)", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    /** @type {any[]} */ const bodies = [];
    await page.route("**/api/admin/competitions", async (route, req) => {
      if (req.method() === "POST") { try { bodies.push(JSON.parse(req.postData() || "{}")); } catch (_) { bodies.push({}); } }
      await route.continue();
    });
    const create = async (name, tick) => {
      await openCompCreateForm(page, "tournament");
      await page.locator("#comp-name").fill(name);
      await page.locator("#comp-date").fill(iso(30 * 86400e3).slice(0, 10));
      await page.locator("#comp-time").fill("10:00");
      await page.locator("#comp-dur-h").fill("3");
      if (tick) await page.locator("#comp-staff-compete").check();
      await page.locator('[data-action="comp-save"]').first().click();
      await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 10000 });
      await page.locator("#modal-confirm-btn").click();
      await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 15000 });
    };
    const onName = `${TAG} Created On`, offName = `${TAG} Created Off`;
    await create(onName, true);
    await create(offName, false);

    // ON THE WIRE — the form SENDS the field, as a real boolean, in both states.
    expect(bodies.length, "two creates were posted").toBe(2);
    expect(bodies[0].staff_compete, "the ticked form sends true").toBe(true);
    expect(bodies[1].staff_compete, "CONTROL: the unticked form sends false, never omits the key").toBe(false);

    // AND IN THE ROW, read back through a session the browser cannot invalidate.
    const list = await (await reader.api.get("/api/admin/competitions")).json();
    const on = list.find(c => c.name === onName), off = list.find(c => c.name === offName);
    expect(on, "the ticked event exists").toBeTruthy();
    expect(off, "the unticked event exists").toBeTruthy();
    expect(!!on.staff_compete, "staff_compete round-trips TRUE").toBe(true);
    expect(!!off.staff_compete, "CONTROL: …and FALSE").toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (b) THE LOCK ON THE EDIT FORM
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the switch is withheld, with its reason, once the event has started", () => {

  test("a LIVE switch-on event renders the box DISABLED with a note saying it started", async ({ page }) => {
    await adminLogin(page);          // the built-in account never competes, so Edit is offered
    await openEdit(page, competeLive.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box, "the stored value is still SHOWN — an admin must be able to read what it was set to").toBeChecked();
    await expect(box, "…and cannot be changed").toBeDisabled();
    const note = page.locator("#comp-staff-compete-lock-note");
    await expect(note, "withheld WITH its reason").toBeVisible();
    await expect(note).toContainText(/started/i);
    await expect(note).not.toContainText(/ended/i);
  });

  test("a LIVE switch-OFF event is locked too — the lock is about the event having started, not about the switch being on", async ({ page }) => {
    // Every other locked event here has the switch ON, so a build computing
    // `staff_compete_locked` only for switch-on rows passes them all — and lets
    // an admin turn the switch ON mid-event, which is the lock's whole purpose.
    await adminLogin(page);
    await openEdit(page, plainLive.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box, "the stored value is OFF").not.toBeChecked();
    await expect(box, "…and cannot be turned on").toBeDisabled();
    const note = page.locator("#comp-staff-compete-lock-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/started/i);
  });

  test("an ENDED switch-on event renders the box DISABLED with a note saying it ended", async ({ page }) => {
    await adminLogin(page);
    await openEdit(page, endedOn.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    const note = page.locator("#comp-staff-compete-lock-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/ended/i);
    await expect(note, "the ended reason, not the started one").not.toContainText(/has started/i);
  });

  test("an ENDED switch-OFF event is locked with the ended reason too", async ({ page }) => {
    await adminLogin(page);
    await openEdit(page, endedOff.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box).not.toBeChecked();
    await expect(box).toBeDisabled();
    await expect(page.locator("#comp-staff-compete-lock-note")).toContainText(/ended/i);
  });

  test("CONTROL — an UPCOMING switch-on event renders the box ENABLED and no lock note", async ({ page }) => {
    // Without this, "the box is disabled" is satisfied by a build that never
    // lets anybody change the switch after create.
    await adminLogin(page);
    await openEdit(page, upOn.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box).toBeChecked();
    await expect(box, "nothing has started, so the switch is live").toBeEnabled();
    await expect(page.locator("#comp-staff-compete-lock-note"), "and no reason is rendered, because nothing is withheld").toHaveCount(0);
  });

  test("a RENAME of a locked event still saves — the disabled box echoes its stored value, and an echo is not a change", async ({ page }) => {
    // The v7.7.26 class: a locked field sent on every edit blocks every edit of
    // a live event. The disabled box reports its stored value and the PUT carries
    // it; the server must read that as an echo. A fixer who sends `undefined` for
    // a disabled box, or a server that compares loosely, would brick every rename
    // of every started event with 400 staff_compete_locked — and nothing else in
    // this file would notice.
    await adminLogin(page);
    await clickTab(page, "Events");
    /** @type {any[]} */ const puts = [];
    await page.route("**/api/admin/competitions/*", async (route, req) => {
      if (req.method() === "PUT") { try { puts.push(JSON.parse(req.postData() || "{}")); } catch (_) { puts.push({}); } }
      await route.continue();
    });
    for (const [ev, stored] of [[renOn, true], [renOff, false]]) {
      await openEdit(page, ev.name);
      await expect(page.locator("#comp-staff-compete"), `${ev.name}: the box is locked`).toBeDisabled();
      const newName = `${ev.name} R`;
      await page.locator("#comp-name").fill(newName);
      await saveEdit(page);
      await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 15000 });
      await expect(page.locator("#modal-title"), "no refusal modal").not.toHaveText(/Locked|Seal these|Remove these/);
      const row = await compRow(ev.id);
      expect(row.name, "the rename landed").toBe(newName);
      expect(!!row.staff_compete, `…and the switch is still ${stored ? "ON" : "OFF"}`).toBe(stored);
      ev.name = newName;   // nothing else in the file looks these two up
    }
    expect(puts.length, "two PUTs were issued").toBe(2);
    expect(puts[0].staff_compete, "the locked ON box rides the PUT as an ECHO of its stored value").toBe(true);
    expect(puts[1].staff_compete, "…and the locked OFF box as false — never omitted, never flipped").toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (c) / (d) THE THREE REFUSALS THAT CARRY A LIST
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the refusals that name their rows are rendered as a modal", () => {

  test("turning it ON while an UNSEALED challenge is assigned shows 'Seal these challenges first', naming it — and the box stays clear on reload", async ({ page }) => {
    await adminLogin(page);
    await openEdit(page, cUp.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box, "precondition: the switch is off").not.toBeChecked();
    await box.check();
    await saveEdit(page);

    // The confirm closed, the PUT was refused, and the refusal came back as a
    // MODAL rather than a toast, because the remedy is per challenge. This arm
    // drives the REAL form path, so it also locks the one line that wires the
    // save's failure branch to the renderer.
    await expect(page.locator("#modal-title"), "the refusal names its remedy").toHaveText(/Seal these challenges first/, { timeout: 15000 });
    await expect(page.locator("#modal-body"), "…and the challenge").toContainText(cTask.title);
    await expect(page.locator("#modal-cancel-btn"), "an OK-only modal").toBeHidden();
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    await expect(page.locator("#comp-form-overlay"), "the form stays open so the admin can act on it").toBeVisible();

    // Nothing was written: the row, and the form a reload renders from it.
    expect(!!(await compRow(cUp.id)).staff_compete, "the switch is still OFF on the row").toBe(false);
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await openEdit(page, cUp.name);
    await expect(page.locator("#comp-staff-compete"), "…and the box is unticked when the form is reopened").not.toBeChecked();
  });

  test("CONTROL — turning it ON on an upcoming event holding only a SEALED challenge saves", async ({ page }) => {
    // Or "the save was refused" is satisfied by a build that refuses the switch
    // everywhere.
    await adminLogin(page);
    await openEdit(page, cUpSealed.name);
    await expect(page.locator("#comp-staff-compete")).not.toBeChecked();
    await page.locator("#comp-staff-compete").check();
    await saveEdit(page);
    await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 15000 });
    await expect(page.locator("#modal-title")).not.toHaveText(/Seal these challenges first/);
    await expect.poll(async () => !!(await compRow(cUpSealed.id)).staff_compete,
      { message: "the switch round-trips ON", timeout: 10000 }).toBe(true);
  });

  test("turning it ON while an ENROLLED person wrote one of its challenges shows 'Remove these authors first', naming the person and the challenge — and the box stays clear on reload", async ({ page }) => {
    // Round-3 (a): the author door from the SWITCH's side. `aUp` holds a SEALED
    // challenge (so the unsealed refusal cannot be what fires) written by an
    // event admin who is ENROLLED there — the one shape that can exist before
    // the switch is on, because an event-admin row is admitted to a switch-off
    // event where a staff-tagged one is skipped.
    await adminLogin(page);
    await openEdit(page, aUp.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box, "precondition: the switch is off").not.toBeChecked();
    await box.check();
    await saveEdit(page);

    await expect(page.locator("#modal-title"), "the third refusal has its own modal").toHaveText(/Remove these authors first/, { timeout: 15000 });
    await expect(page.locator("#modal-body"), "the enrolled author is NAMED").toContainText(pAuth.nickname);
    await expect(page.locator("#modal-body"), "…with the challenge they wrote").toContainText(aSealed.title);
    await expect(page.locator("#modal-body"), "…and the remedy names Manage Participants, not the seal").toContainText(/Manage Participants/);
    await expect(page.locator("#modal-title"), "and NOT the unsealed-challenge refusal — the challenge is sealed").not.toHaveText(/Seal these challenges first/);
    await expect(page.locator("#modal-cancel-btn"), "an OK-only modal").toBeHidden();
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    await expect(page.locator("#comp-form-overlay"), "the form stays open so the admin can act on it").toBeVisible();

    expect(!!(await compRow(aUp.id)).staff_compete, "the switch is still OFF on the row").toBe(false);
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await openEdit(page, aUp.name);
    await expect(page.locator("#comp-staff-compete"), "…and the box is unticked when the form is reopened").not.toBeChecked();
  });

  test("turning it OFF while a staff-tagged user is enrolled shows 'Remove these staff members first', naming them", async ({ page }) => {
    await adminLogin(page);
    await openEdit(page, dUp.name);
    const box = page.locator("#comp-staff-compete");
    await expect(box, "precondition: the switch is on").toBeChecked();
    await box.uncheck();
    await saveEdit(page);

    await expect(page.locator("#modal-title")).toHaveText(/Remove these staff members first/, { timeout: 15000 });
    await expect(page.locator("#modal-body"), "the enrolled staff member is NAMED").toContainText(staffP2.nickname);
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#comp-form-overlay"), "the form stays open").toBeVisible();

    expect(!!(await compRow(dUp.id)).staff_compete, "the switch is still ON on the row").toBe(true);
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await openEdit(page, dUp.name);
    await expect(page.locator("#comp-staff-compete"), "…and the box is still ticked when reopened").toBeChecked();
  });

  // The RENDERER on its own, from the server's OWN payloads: the three form-driven
  // arms above prove the wiring, this one proves the copy and the list against
  // the real 400 bodies — and that an unrelated code is declined, which the form
  // path cannot show.
  test("the server's real refusal payloads render as their three modals, naming their rows", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;

    const on = await page.request.put(`/api/admin/competitions/${cUp.id}`, { headers: H(csrf), data: { staff_compete: true } });
    expect(on.status(), "turning it ON with an unsealed challenge assigned is refused").toBe(400);
    const onBody = await on.json();
    expect(onBody.code).toBe("staff_compete_unsealed_challenges");
    expect((onBody.challenges || []).map(c => c.id), "…naming the challenge").toContain(cTask.id);
    expect(await page.evaluate(d => window.showStaffCompeteRefusalModal(d), onBody), "the renderer recognises the code").toBe(true);
    await expect(page.locator("#modal-title")).toHaveText(/Seal these challenges first/);
    await expect(page.locator("#modal-body")).toContainText(cTask.title);
    await expect(page.locator("#modal-cancel-btn"), "an OK-only modal").toBeHidden();
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);

    const off = await page.request.put(`/api/admin/competitions/${dUp.id}`, { headers: H(csrf), data: { staff_compete: false } });
    expect(off.status(), "turning it OFF with a staff member enrolled is refused").toBe(400);
    const offBody = await off.json();
    expect(offBody.code).toBe("staff_compete_enrolled_staff");
    expect((offBody.participants || []).map(u => u.id), "…naming them").toContain(staffP2.id);
    expect(await page.evaluate(d => window.showStaffCompeteRefusalModal(d), offBody)).toBe(true);
    await expect(page.locator("#modal-title")).toHaveText(/Remove these staff members first/);
    await expect(page.locator("#modal-body")).toContainText(staffP2.nickname);
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);

    // THE THIRD CODE (round-3 a): the real 400 with its `participants[].tasks[]`
    // shape, rendered as the author modal naming BOTH the person and the title.
    const au = await page.request.put(`/api/admin/competitions/${aUp.id}`, { headers: H(csrf), data: { staff_compete: true } });
    expect(au.status(), "turning it ON with an enrolled author is refused").toBe(400);
    const auBody = await au.json();
    expect(auBody.code).toBe("staff_compete_enrolled_authors");
    expect((auBody.participants || []).map(u => u.id), "…naming the author").toContain(pAuth.id);
    expect(((auBody.participants || []).find(u => u.id === pAuth.id)?.tasks || []).map(t => t.id), "…with their challenge").toContain(aSealed.id);
    expect(await page.evaluate(d => window.showStaffCompeteRefusalModal(d), auBody), "the renderer recognises the third code").toBe(true);
    await expect(page.locator("#modal-title")).toHaveText(/Remove these authors first/);
    await expect(page.locator("#modal-body")).toContainText(pAuth.nickname);
    await expect(page.locator("#modal-body")).toContainText(aSealed.title);
    await expect(page.locator("#modal-cancel-btn"), "an OK-only modal").toBeHidden();
    await page.locator("#modal-confirm-btn").click();

    // CONTROL: a payload carrying none of the three codes is NOT rendered — the
    // caller falls back to its toast — or every refusal on the platform would
    // become one of these dialogs.
    expect(await page.evaluate(() => window.showStaffCompeteRefusalModal({ error: "x", code: "something_else" })), "an unrelated code is declined").toBe(false);
    expect(!!(await compRow(cUp.id)).staff_compete, "nothing was written by any refusal").toBe(false);
    expect(!!(await compRow(dUp.id)).staff_compete).toBe(true);
    expect(!!(await compRow(aUp.id)).staff_compete).toBe(false);
  });

  test("CONTROL — turning it OFF on an upcoming event with nobody enrolled saves", async ({ page }) => {
    await adminLogin(page);
    await openEdit(page, dUpEmpty.name);
    await expect(page.locator("#comp-staff-compete")).toBeChecked();
    await page.locator("#comp-staff-compete").uncheck();
    await saveEdit(page);
    await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 15000 });
    await expect.poll(async () => !!(await compRow(dUpEmpty.id)).staff_compete,
      { message: "the switch round-trips OFF", timeout: 10000 }).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (e) THE EVENTS ROW OF AN EVENT THE ACTOR COMPETES IN
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — a competing admin's Events row", () => {

  // The event's doors are its WORKSPACE's ⋯ menu (owner's decision, 27 Nov
  // 2026: the Events-row menu keeps only Delete event), so the competitor rule
  // is held there; the row keeps the tag controls and its one menu item.
  test("the workspace menu withholds every mutating item WITH the reason and keeps the read-only ones; the row hides the tag controls and Delete", async ({ page }) => {
    await adminPanel(page, competitor.email);
    const portal = await openEventMenu(page, competeLive.name);

    await expect(portal.locator(".kebab-note"), "withheld WITH its reason").toContainText(/You are competing in this event/);
    // Edit / End Now / Add challenges are the items a REGULAR admin ordinarily
    // sees on a live event, so their absence here is the competitor rule.
    // `comp-delete` and `comp-start-now` are listed for completeness only: a
    // regular admin never sees Delete, and a LIVE event never renders Start Now
    // — the real locks on those two are the superadmin arm and the
    // upcoming-event arm below. JOIN LINK STAYS (the operator's ruling, 19 Sep
    // 2026): the reveal is a read, and the dialog it opens is read-only for a
    // competitor — its own describe below.
    // (No Add from bank in the list: neither event menu offers it to anybody, Stage
    // B, owner ruling, 27 Nov 2026; tests/menu-door-parity.spec.js.)
    for (const action of ["comp-edit", "comp-end-now", "comp-delete", "comp-start-now", "ws-clone"]) {
      await expect(portal.locator(`[data-action="${action}"]`), `${action} reaches a door the server refuses a competitor`).toHaveCount(0);
    }
    for (const action of ["comp-history", "comp-self-enroll"]) {
      await expect(portal.locator(`[data-action="${action}"]`), `${action} is viewing, not editing, so it stays`).toHaveCount(1);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#ws-quick .ws-invite-btn"), "no Invite: adding people is a write").toHaveCount(0);
    const row = await eventRow(page, competeLive.name);
    await openKebab(page, row);
    await expect(portal.locator(".kebab-note"), "the row's menu says why it holds no Delete").toContainText(/You are competing in this event/);
    await expect(portal.locator("[data-action]"), "and offers nothing").toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(row.locator(".tag-add"), "+ tag is a write, so it is withheld too").toHaveCount(0);
    // The tag CHIP still renders — which events are tagged is a fact an admin
    // legitimately reads — and only its × goes.
    await expect(row.locator(".tag"), "the tag chip still renders").toHaveCount(1);
    await expect(row.locator(".tag")).toContainText(`sc-${TAG}`);
    await expect(row.locator(".tag-x"), "…and its × is withheld").toHaveCount(0);

    // Every OTHER way into the editor is guarded as well, and says why.
    await page.evaluate(id => window.editCompetition(id), competeLive.id);
    await expect(page.locator("#toast-stack"), "the editor refuses with the reason").toContainText(/You are competing in/, { timeout: 10000 });
    // CONTROL for the ended-remedy arm below: on a LIVE event the remedy
    // legitimately names self-removal, the competitor's own escape hatch.
    await expect(page.locator("#toast-stack"), "…and, live, names self-removal as the remedy").toContainText(/remove yourself from the event/);
    await expect(page.locator("#comp-form-overlay"), "…and no form opens").toHaveCount(0);
  });

  test("the SCOPE BANNER withholds End Now on the live event the admin competes in, with the reason", async ({ page }) => {
    // The kebab withholds End Now for a competitor (the arm above); the scope
    // banner is the OTHER End Now on the same screen, on the most prominent
    // write control the panel has — and it is keyed on `live` alone. Two
    // confirmations later the server answers 403 competitor_cannot_edit: the
    // v7.14.2 affordance that lies, and two answers for one action on one screen.
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `renderScopeBanner` gates End Now / Start Now / the session End Now on
    // `comp.competing`, rendering the note in the control's place.
    await adminPanel(page, competitor.email);
    await focus(page, competeLive.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toBeVisible();
    await expect(banner, "the live status is still shown").toContainText(/Live/);
    // End now lives in the header's ⋯ menu (#ws-quick), never in the status chip.
    const menu = page.locator("#ws-quick .ws-more-btn + .kebab-menu");
    await expect(menu.locator('[data-action="comp-end-now"]'), "End Now reaches a door the server refuses a competitor").toHaveCount(0);
    await expect(menu, "…withheld WITH its reason").toContainText(/You are competing/);
    await expect(page.locator("#ws-rec-chips"), "…and the header says so").toContainText(/You are competing/);
  });

  test("CONTROL — the built-in superadmin's scope banner offers End Now on the same live event", async ({ page }) => {
    // Or the arm above is satisfied by a banner that lost End Now for everybody.
    await adminLogin(page);
    await focus(page, competeLive.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText(/Live/);
    await expect(page.locator('#ws-quick .ws-more-btn + .kebab-menu [data-action="comp-end-now"]'), "the built-in competes nowhere, so the ⋯ menu offers End Now").toHaveCount(1);
    await expect(page.locator("#ws-quick .ws-more-btn + .kebab-menu")).not.toContainText(/You are competing/);
  });

  test("the editor's refusal on an ENDED event they compete in does not promise self-removal — the door the ended-membership rule shuts", async ({ page }) => {
    // Round-3 (d) made the SERVER's remedy honest (`_competitorRemedy`); the
    // client's own copy of the sentence did not follow. A competitor in a
    // FINISHED compete event cannot remove themselves, so telling them to is an
    // instruction that is not true (FROZEN_REMEDY).
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `editCompetition`'s toast offers self-removal only while the event has
    // not ended; on an ENDED one it names another organiser as the remedy.
    await adminPanel(page, saComp.email);
    await clickTab(page, "Events");
    await page.evaluate(id => window.editCompetition(id), endLater.id);
    const toast = page.locator("#toast-stack");
    await expect(toast, "the refusal still says why").toContainText(/You are competing in/, { timeout: 10000 });
    await expect(toast, "…and names the one remedy that is true of an ended event").toContainText(/Ask another organiser/);
    await expect(toast, "…never the self-removal the server would refuse").not.toContainText(/remove yourself/);
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
  });

  test("CONTROL — a switch-off event the same admin is NOT enrolled in still offers Edit and the tag controls", async ({ page }) => {
    // Without this, every absence above is satisfied by a build that removed
    // the items for every regular admin.
    await adminPanel(page, competitor.email);
    const portal = await openEventMenu(page, plainLive.name);
    await expect(portal.locator('[data-action="comp-edit"]'), "Edit is offered").toHaveCount(1);
    await expect(portal.locator('[data-action="comp-end-now"]'), "End Now is offered on a live event").toHaveCount(1);
    await expect(portal.locator('[data-action="comp-self-enroll"]')).toHaveCount(1);
    await expect(portal.locator(".kebab-note"), "nothing is withheld, so nothing is explained").toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#ws-quick .ws-invite-btn"), "Invite is offered").toHaveCount(1);
    const row = await eventRow(page, plainLive.name);
    await expect(row.locator(".tag-add"), "+ tag is offered").toHaveCount(1);
    await expect(row.locator(".tag"), "the same tag renders here").toHaveCount(1);
    await expect(row.locator(".tag-x"), "…WITH its ×").toHaveCount(1);
  });

  test("an UPCOMING event the admin competes in withholds Start Now — and the switch-off upcoming twin offers it (CONTROL)", async ({ page }) => {
    // Start Now renders on an upcoming single-slot event only, so a live
    // fixture cannot lock its withholding; this one can.
    await adminPanel(page, competitor.email);
    let portal = await openEventMenu(page, upOn.name);
    await expect(portal.locator(".kebab-note")).toContainText(/You are competing in this event/);
    await expect(portal.locator('[data-action="comp-start-now"]'), "Start Now reaches the timeslot/competition PUT the server refuses").toHaveCount(0);
    await expect(portal.locator('[data-action="comp-edit"]')).toHaveCount(0);
    await page.keyboard.press("Escape");

    portal = await openEventMenu(page, upOff.name);
    await expect(portal.locator('[data-action="comp-start-now"]'), "CONTROL: an upcoming event they do not compete in offers Start Now").toHaveCount(1);
    await expect(portal.locator('[data-action="comp-edit"]')).toHaveCount(1);
    await expect(portal.locator(".kebab-note")).toHaveCount(0);
  });

  test("a user-backed SUPERADMIN who competes loses Edit, End Now and Delete on that event — and on the ENDED one they compete in — while keeping them on events they do not compete in (CONTROL)", async ({ page }) => {
    // DESIGN decision 2: every tier. The superadmin tier is the only one where
    // the competitor rule is the SOLE thing withholding Delete (a regular admin
    // never sees it) and Edit on an ENDED event (a regular admin cannot edit one
    // anyway) — so these are the arms that go red when `!competing` is dropped
    // from the Delete branch or from `canEdit`, and nothing else in this file
    // does. Delete is held in BOTH menus (the row keeps it), Edit and End Now in
    // the workspace's.
    await adminPanel(page, saComp.email);
    let portal = await openEventMenu(page, competeLive.name);
    await expect(portal.locator(".kebab-note"), "withheld WITH its reason, whatever the tier").toContainText(/You are competing in this event/);
    await expect(portal.locator('[data-action="comp-edit"]')).toHaveCount(0);
    await expect(portal.locator('[data-action="comp-end-now"]')).toHaveCount(0);
    await expect(portal.locator('[data-action="comp-delete"]'), "Delete is a superadmin item, and the competitor rule takes it").toHaveCount(0);
    await expect(portal.locator('[data-action="comp-history"]'), "viewing stays").toHaveCount(1);
    await page.keyboard.press("Escape");
    let row = await eventRow(page, competeLive.name);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="comp-delete"]'), "the row's Delete is withheld too").toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(row.locator(".tag-x"), "the tag × is withheld from this tier too").toHaveCount(0);

    portal = await openEventMenu(page, plainLive.name);
    await expect(portal.locator('[data-action="comp-edit"]'), "CONTROL: the same superadmin edits an event they do not compete in").toHaveCount(1);
    await expect(portal.locator('[data-action="comp-end-now"]')).toHaveCount(1);
    await expect(portal.locator('[data-action="comp-delete"]'), "…and may delete it").toHaveCount(1);
    await expect(portal.locator(".kebab-note")).toHaveCount(0);
    await page.keyboard.press("Escape");
    row = await eventRow(page, plainLive.name);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="comp-delete"]'), "…from the row too").toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(row.locator(".tag-x"), "…with the tag × offered").toHaveCount(1);

    // THE ENDED PERMUTATION. A superadmin is the one tier that can edit an ended
    // event, so this is where `!competing` in `canEdit` is the only thing
    // withholding Edit — the lock is keyed on the event at ANY status.
    portal = await openEventMenu(page, endLater.name);
    await expect(portal.locator(".kebab-note")).toContainText(/You are competing in this event/);
    await expect(portal.locator('[data-action="comp-edit"]'), "no Edit on the ENDED event they compete in").toHaveCount(0);
    await expect(portal.locator('[data-action="comp-delete"]')).toHaveCount(0);
    await page.keyboard.press("Escape");

    portal = await openEventMenu(page, endedOn.name);
    await expect(portal.locator('[data-action="comp-edit"]'), "CONTROL: the same superadmin edits an ENDED event they do not compete in").toHaveCount(1);
    await expect(portal.locator('[data-action="comp-delete"]')).toHaveCount(1);
    await expect(portal.locator(".kebab-note")).toHaveCount(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (f) THE CHALLENGES ROW OF A CHALLENGE HELD BY THAT EVENT
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — a competing admin's Challenges row", () => {

  test("the kebab names the event and withholds Edit; the editor is read-only, hides the hint, hides Save", async ({ page }) => {
    // WHAT THIS ARM LOCKS, AND WHAT IT DOES NOT. A compete event admits sealed
    // challenges only, never one this actor authored — so for a REGULAR admin the
    // v8.10.0 seal ALONE already withholds Edit, Hide/Show, `+ tag`, disables the
    // fields, hides Save and empties the key. Those assertions are kept because
    // they are true, but they are seal-shared: what only the COMPETITOR rule
    // produces here is the NOTE (competing, not "answer is sealed"), the
    // `#tf-sealed-note` copy, and the HIDDEN hint editor (the seal leaves the
    // hint readable; a competitor pays 30% for it like any participant). The
    // items only the competitor rule withholds — Lock / Recalculate / Delete —
    // exist for a superadmin alone, and are locked by the saComp arm below.
    await adminPanel(page, competitor.email);
    const row = await challengeRow(page, sealedHinted.title);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    const note = portal.locator(".kebab-note");
    await expect(note, "withheld WITH the reason that binds this tier").toContainText(/You are competing in/);
    await expect(note, "…naming the event").toContainText(competeLive.name);
    await expect(note, "…and NOT the seal reason, which does not bind a regular admin any differently").not.toContainText(/answer is sealed/i);
    await expect(portal.locator('[data-action="task-edit"]'), "Edit reaches a door the server refuses").toHaveCount(0);
    await expect(portal.locator('[data-action="task-toggle-visibility"]')).toHaveCount(0);
    await expect(portal.locator('[data-action="task-view"]'), "viewing is not editing").toHaveCount(1);
    await expect(portal.locator('[data-action="task-history"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    // Stage B — no tag control on any question row; the sharing switch is in
    // the editor, read-only here (asserted below).

    // THE EDITOR, reached the only way left — `editTask` is on `window`.
    await page.evaluate(id => window.editTask(id), sealedHinted.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-shared"), "the sharing switch is withheld with the rest of the form").toBeDisabled();
    const tfNote = page.locator("#tf-sealed-note");
    await expect(tfNote, "the form says WHY it is read-only").toBeVisible();
    await expect(tfNote).toContainText(/competing/i);
    await expect(tfNote).toContainText(competeLive.name);
    // CONTROL for the ended-note arm below: on a LIVE event the note may name
    // self-removal, which really is open to them there.
    await expect(tfNote, "…and, live, names self-removal as the way back").toContainText(/Remove yourself from the event/);
    await expect(page.locator("#tf-hint-group"), "the hint editor is HIDDEN, not left empty — an empty box reads as 'no hint'").toBeHidden();
    await expect(page.locator("#save-task-btn"), "no Save is offered").toBeHidden();
    await expect(page.locator("#tf-title"), "…and the fields are disabled, not merely blank").toBeDisabled();
    await expect(page.locator("#tf-answer")).toBeDisabled();
    await expect(page.locator("#tf-answer"), "the sealed key was never sent").toHaveValue("");
    // THE ATTACHMENTS (round 3): the seal leaves them editable — they are not the
    // answer — but the three attachment routes are competitor doors, so the add
    // button and every chip's Rename/Remove go while Download stays. The chip
    // list renders asynchronously, so the chip is awaited before its controls
    // are counted (a count of zero over a list not yet rendered proves nothing).
    const chips = page.locator("#tf-attachments-list .tf-attach-chip");
    await expect(chips, "the attachment still renders — it is a fact about the challenge, not a control").toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#tf-attach-add-btn"), "no + Add attachment").toBeHidden();
    await expect(chips.locator("a.tf-attach-chip-action[download]"), "Download is reading, so it stays").toHaveCount(1);
    await expect(chips.locator("button.tf-attach-chip-action"), "Rename and Remove reach doors the server refuses").toHaveCount(0);

    // BY VALUE, over the whole document: neither the hint nor the key is
    // anywhere in the DOM, whatever the form did with them.
    const html = await page.content();
    expect(html, "the hint is nowhere in the page").not.toContain(`SECRET_HINT_${TAG}`);
    expect(html, "…nor the key").not.toContain(`SECRET_KEY_${TAG}`);
  });

  test("View as Participant says the hint is WITHHELD, and History offers no Restore", async ({ page }) => {
    await adminPanel(page, competitor.email);
    const row = await challengeRow(page, sealedHinted.title);
    await row.locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".task-preview-hint-body"), "the hint block says WHY there is no hint, rather than omitting it")
      .toContainText(/Withheld — you are competing/);
    expect(await page.content(), "and the hint text itself is nowhere").not.toContain(`SECRET_HINT_${TAG}`);
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toBeHidden();

    await openKebab(page, row);
    await page.locator('#kebab-portal [data-action="task-history"]').click();
    const hist = page.locator("#hist-body");
    await expect(hist, "the history dialog opened").toBeVisible({ timeout: 15000 });
    await expect(hist.locator(".history-restore-btn"), "every Restore here was certain to 403").toHaveCount(0);
    await expect(hist, "withheld WITH its reason").toContainText(/Not while competing/);
    // BY VALUE AGAIN, with the versions payload now rendered: every snapshot is
    // redacted for a competitor (`delete red.hint`), and the check before the
    // dialog opened could not see what the dialog would paint.
    await expect(hist.locator("tr").first(), "at least one version row rendered before the by-value check").toBeVisible();
    expect(await page.content(), "the hint is nowhere, the History dialog included").not.toContain(`SECRET_HINT_${TAG}`);
    expect(await page.content(), "…nor the key").not.toContain(`SECRET_KEY_${TAG}`);
  });

  test("CONTROL — an unrelated challenge's kebab offers Edit, its editor is live, and its preview shows the hint", async ({ page }) => {
    await adminPanel(page, competitor.email);
    const row = await challengeRow(page, plainHinted.title);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator('[data-action="task-edit"]'), "a regular admin may edit an unrelated challenge").toHaveCount(1);
    await expect(portal.locator(".kebab-note"), "nothing is withheld, so nothing is explained").toHaveCount(0);
    await page.keyboard.press("Escape");
    // Stage B — the row carries no tag control for anyone; the sharing switch,
    // its successor, is in the editor (asserted below once it is open).

    // The preview FIRST: opening the editor hides the table, and the row's View
    // button with it.
    await row.locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".task-preview-hint-body"), "the hint is rendered for a challenge they do not compete on")
      .toContainText(`PLAIN_HINT_${TAG}`);
    await expect(overlay, "…and not the withheld copy").not.toContainText(/Withheld/);
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toBeHidden();

    await page.evaluate(id => window.editTask(id), plainHinted.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-sealed-note")).toBeHidden();
    await expect(page.locator("#tf-hint-group"), "the hint editor is shown").toBeVisible();
    await expect(page.locator("#save-task-btn"), "Save is offered").toBeVisible();
    await expect(page.locator("#tf-title")).toBeEnabled();
    await page.locator('[aria-controls="tf-org-body"]').click();
    await expect(page.locator("#tf-shared"), "the sharing switch is live").toBeEnabled();
    // "Withheld" is measured against "delivered": the unsealed challenge's key
    // (makeTask's default) reaches the field, so the empty box in the competing
    // arm is a withholding and not a form that never populates `#tf-answer`.
    await expect(page.locator("#tf-answer"), "the unsealed key reaches the editor").toHaveValue("a");
    // CONTROL for the attachment withholding: the same admin's editor on an
    // unrelated challenge keeps the add button and BOTH chip controls.
    const chips = page.locator("#tf-attachments-list .tf-attach-chip");
    await expect(chips).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#tf-attach-add-btn"), "+ Add attachment is offered").toBeVisible();
    await expect(chips.locator("button.tf-attach-chip-action"), "Rename and Remove are offered").toHaveCount(2);
    await expect(chips.locator('[data-action="attach-rename"]')).toHaveCount(1);
    await expect(chips.locator('[data-action="attach-delete"]')).toHaveCount(1);
  });

  test("a user-backed SUPERADMIN who competes loses Lock, Recalculate and Delete on that row — and keeps all three on an unrelated one (CONTROL)", async ({ page }) => {
    // The three superadmin-only items are the only challenge-row controls the
    // seal does NOT already withhold, so this is the one arm that goes red when
    // `!_competes` is dropped from their branch.
    await adminPanel(page, saComp.email);
    const portal = page.locator("#kebab-portal");
    let row = await challengeRow(page, sealedHinted.title);
    await openKebab(page, row);
    await expect(portal.locator(".kebab-note"), "the competitor reason, not the seal reason").toContainText(/You are competing in/);
    await expect(portal.locator(".kebab-note")).toContainText(competeLive.name);
    await expect(portal.locator('[data-action="task-toggle-lock"]'), "Lock is withheld").toHaveCount(0);
    await expect(portal.locator('[data-action="task-recalculate"]'), "Recalculate is withheld").toHaveCount(0);
    await expect(portal.locator('[data-action="task-delete"]'), "Delete is withheld").toHaveCount(0);
    await expect(portal.locator('[data-action="task-edit"]')).toHaveCount(0);
    await expect(portal.locator('[data-action="task-history"]'), "viewing stays").toHaveCount(1);
    await page.keyboard.press("Escape");

    row = await challengeRow(page, plainHinted.title);
    await openKebab(page, row);
    await expect(portal.locator('[data-action="task-toggle-lock"]'), "CONTROL: the same superadmin may lock an unrelated challenge").toHaveCount(1);
    await expect(portal.locator('[data-action="task-recalculate"]'), "…recalculate it").toHaveCount(1);
    await expect(portal.locator('[data-action="task-delete"]'), "…and delete it").toHaveCount(1);
    await expect(portal.locator('[data-action="task-edit"]')).toHaveCount(1);
    await expect(portal.locator(".kebab-note")).toHaveCount(0);
  });

  test("a user-backed SUPERADMIN who competes is not offered the feedback purge over the mate's rating — and the built-in is (CONTROL)", async ({ page }) => {
    // The two purge buttons are superadmin-only, so this tier is the only one
    // where `!_fbCompetes` is the sole thing withholding them. The rating row
    // still renders: WHO rated a challenge is a fact an organiser reads.
    await adminPanel(page, saComp.email);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
    await page.evaluate(id => window.editTask(id), sealedHinted.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    const list = page.locator("#task-feedback-list");
    await expect(list, "the rating row renders").toContainText(mateP.nickname, { timeout: 15000 });
    await expect(list.locator('[data-action="task-feedback-delete"]'), "no per-row Remove for a competitor").toHaveCount(0);
  });

  test("CONTROL — the built-in superadmin is offered the feedback purge over the same rating", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
    await page.evaluate(id => window.editTask(id), sealedHinted.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    const list = page.locator("#task-feedback-list");
    await expect(list).toContainText(mateP.nickname, { timeout: 15000 });
    await expect(list.locator('[data-action="task-feedback-delete"]'), "the built-in competes nowhere, so Remove is offered").toHaveCount(1);
    // (Delete All renders only over TWO or more ratings, so it is not asserted
    // either way here — one rating is what the fixture holds.)
  });

  test("the editor's note on a challenge held by an ENDED event they compete in does not promise self-removal", async ({ page }) => {
    // Round-3 (d), the challenge-side copy. `competing_in` entries carry only
    // {id, name}, so the client cannot even branch on the event having ended.
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `competing_in` entries carry `status`, and `#tf-sealed-note`'s
    // self-removal clause is gated on every holding event not having ended.
    await adminPanel(page, saComp.email);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
    await page.evaluate(id => window.editTask(id), endSealed.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    const note = page.locator("#tf-sealed-note");
    await expect(note).toBeVisible();
    await expect(note, "the reason is still stated").toContainText(/competing/i);
    await expect(note).toContainText(endLater.name);
    await expect(note, "…without a remedy the ended-membership rule refuses").not.toContainText(/remove yourself/i);
  });

  test("the AUTHOR's editor withholds Unseal while the sealed challenge is in a compete event — live or ENDED — with a reason that follows FROZEN_REMEDY, and offers it on one in no event (CONTROL)", async ({ page }) => {
    // Decision 3's unseal door: the server refuses the save while ANY compete
    // event holds the challenge (`answer_seal_in_compete_event`, at any status
    // — see lib/staff-compete.js for the two reverted drafts). v8.12.0 round 3
    // put `staff_compete` on the row's `competitions[]` entries so the editor
    // withholds the tick where the save is certain to be refused (v7.14.2),
    // WITH the reason in `#tf-unseal-held-note` — and the remedy that note
    // names honours FROZEN_REMEDY: "take it out first" only while the holding
    // event can still be left; a finished event's assignments are frozen, so
    // there the note says the seal stays for as long as the assignment does.
    // The first draft offered the tick and let the save end in a 409 toast.
    await adminPanel(page, author.email);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
    // CONTROL FIRST: a sealed challenge in NO event offers its author the Unseal
    // row, and no held-note.
    await page.evaluate(id => window.editTask(id), unsealFree.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-unseal-row"), "CONTROL: the author may unseal a challenge no compete event holds").toBeVisible();
    await expect(page.locator("#tf-unseal-held-note"), "CONTROL: …and is told nothing about a hold").toBeHidden();
    // LIVE compete event: withheld, named, and the leave-first remedy offered.
    await page.evaluate(id => window.editTask(id), sealedHinted.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-unseal-row"), "the Unseal tick is withheld where the server refuses the save").toBeHidden();
    const held = page.locator("#tf-unseal-held-note");
    await expect(held, "…WITH its reason").toBeVisible();
    await expect(held).toContainText(competeLive.name);
    await expect(held, "a live event can still be left, so the remedy is offered").toContainText(/take it out/i);
    // ENDED compete event: still withheld (the seal binds at any status), and
    // the remedy is NOT offered — unassigning from a finished event is refused.
    await page.evaluate(id => window.editTask(id), endSealed.id);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-unseal-row"), "still withheld on a challenge held by an ENDED compete event").toBeHidden();
    await expect(held).toBeVisible();
    await expect(held).toContainText(endLater.name);
    await expect(held, "no 'take it out first' on a finished event — that door is frozen").not.toContainText(/take it out/i);
    await expect(held, "…the note says the seal stays with the assignment instead").toContainText(/stays sealed for as long as it stays assigned/i);
  });

  test("an EVENT-ADMIN author whose sealed challenge sits only in a compete event OUTSIDE their scope is withheld the Unseal tick too — the row carries `withheld_compete` — and offered it once that event lets go (CONTROL)", async ({ page }) => {
    // Round 4: the withhold above reads the row's `competitions[]`, which is
    // NARROWED to the events an event admin organises (v8.8.8) — so for an
    // author whose challenge was put into somebody else's compete event by a
    // global admin, that array carried nothing to withhold on and the tick was
    // OFFERED, the save then meeting the scoped 409 ("1 outside your events").
    // The row now says a withheld event competes, and the editor withholds the
    // tick with the honest remedy: that event's organiser, or the seal.
    const far = await makeCompetition(reader.api, reader.csrf, "unsealfar", { staff_compete: true, start_time: iso(2 * 3600e3) });
    // `aSealed` is pAuth's sealed challenge, in `aUp` (pAuth's own switch-OFF
    // event); a global admin (`reader` — the built-in's session dies the moment
    // a browser signs in as it) puts it into the far compete event pAuth does
    // NOT organise. Removed again in `finally`, so the (d) switch arm's fixture
    // is byte-identical afterwards.
    // The author's LIBRARY row (the Challenges page lists it; each event holds its
    // own copy, lib/event-copies.js): the far event takes a copy of it.
    const farCopy = (await assignTask(reader.api, reader.csrf, aSealed.bankId, [far.id])).copies[0].task_id;
    try {
      await adminPanel(page, pAuth.email);
      await clickTab(page, "Challenges");
      await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
      const row = await page.evaluate(id => (window.adminTasksData || []).find(t => t.id === id), aSealed.bankId);
      expect(row.competitions.map(c => c.id), "PRECONDITION: the far event is withheld from the author's row").toEqual([aUp.id]);
      expect(row.withheld_compete, "PRECONDITION: …and the row says it competes").toBe(true);
      await page.evaluate(id => window.editTask(id), aSealed.bankId);
      await expect(page.locator("#admin-task-form")).toBeVisible();
      await expect(page.locator("#tf-unseal-row"), "the Unseal tick is withheld — the save would meet the scoped 409").toBeHidden();
      const held = page.locator("#tf-unseal-held-note");
      await expect(held, "…WITH the reason").toBeVisible();
      await expect(held).toContainText(/1 event outside your events/);
      await expect(held, "the far event's NAME is not disclosed").not.toContainText(far.name);
      await expect(held, "the remedy is that event's organiser — not 'take it out first', which this actor cannot").toContainText(/that event.s organiser/i);
      await expect(held, "…so the imperative offered on an in-scope event is not offered here").not.toContainText(/Take it out of/);
    } finally {
      const r = await reader.api.delete(`/api/admin/tasks/${farCopy}/competitions/${far.id}`, { headers: H(reader.csrf) });
      expect(r.ok(), `unassign aSealed from the far event: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    // CONTROL — with the far event gone the same author is offered the tick
    // again: the withhold was that event's doing, not the seal's.
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(id => !!(window.adminTasksData || []).find(t => t.id === id && !t.withheld_compete), aSealed.bankId), { timeout: 20000 }).toBe(true);
    await page.evaluate(id => window.editTask(id), aSealed.bankId);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-unseal-row"), "CONTROL: offered once no compete event holds it").toBeVisible();
    await expect(page.locator("#tf-unseal-held-note"), "CONTROL: …and no hold is reported").toBeHidden();
  });
});
