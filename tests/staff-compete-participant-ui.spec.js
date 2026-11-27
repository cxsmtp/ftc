// @ts-check
//
// v8.12.0 — STAFF CAN COMPETE: THE PARTICIPANT SIDE, IN A REAL BROWSER.
//
// The server decides who holds a row and who is on the board
// (`staff-compete*.api.spec.js` pin that). What this file pins is what a
// staff-tagged PERSON meets on the participant surfaces, because every one of
// these is a client decision the API specs cannot see:
//
//   1. THE TWO-SECTION PICKER. A staff member's picker splits into "Your Events"
//      (rows they HOLD, `own`) and "All other events" (the rest of the platform,
//      which staff enter as spectators). Each section has its own chips and its
//      own count; the search box is shared. The `Competing` badge marks an own
//      row on an event whose switch is on — and ONLY those, and only for a
//      staff-TAGGED user (`S.isUserStaff&&c.competing`, competition-picker.js
//      `_compCardHtml`; the rule is stated in CLAUDE.md "Staff can compete…",
//      "Three wire facts"): an ADMIN in participant view carries the tag and
//      gets both sections and the badge (decision 4, FIRST half); an event
//      admin in participant view keeps the single enrolment-only section
//      (second half) and their own row on a compete event carries no marker.
//      The badge is also in the card's ACCESSIBLE name (", competing"), and the
//      skeleton reservation is per section, each grid reserving its own cards.
//   2. THE CONFIRMATIONS. Every exemption that used to key on the bare
//      `S.isUserStaff` — the Enter-Live-Event confirm and its Switch-Event
//      sibling, the timeslot picker's live warning and its Join-Live-Session
//      confirm, the Leave-Event confirm, and the "Switch Session" button — now
//      keys on `staffSpectatorIn(comp)`, which is `competing` (own AND the switch
//      on), NOT `own`. A COMPETING staff member gets every confirmation a
//      participant gets; a SPECTATOR keeps every exemption — including a
//      spectator who HOLDS A ROW on an event where staff do not compete (a
//      participant later made staff keeps their rows; it is what the switch's
//      OFF state produces in production). Both directions are asserted, because
//      "the modal appeared" is satisfied by a build that asks everybody and
//      "no modal" by one that asks nobody.
//   3. THE JOIN LINK — THROUGH ALL THREE DOORS. A staff member with a pending
//      join to an event where staff compete is told, BEFORE the row is written,
//      that joining makes them a competitor and locks them out of editing;
//      declining purges the stored join. On an event where staff do not compete
//      the join admits them as a spectator and SAYS so. The confirm is CLIENT-
//      only (`joinViaPendingToken`, features/self-enroll.js) and is reached by
//      three doors that must each be driven: an already-signed-in visit to the
//      link (boot's `_joinFromUrl` branch, core/main.js), the LOGIN CARD (a
//      signed-out phone scanning the QR lands on sign-up, presses Sign In, and
//      `doLogin` in features/auth.js consumes the join — the ordinary QR flow),
//      and the picker's typed EVENT CODE (`joinWithCode`). The AUTHOR of a
//      challenge in the event is asked and then refused by the server's author
//      door with the challenge named, and holds no row.
//   4. THE TOGGLE LANDING. An admin switching down to participant view lands in
//      their sole event rather than on a one-card list. Driven BOTH ways: an
//      admin enrolled AFTER signing in (so the session carries no event and the
//      toggle's OWN landing branch is what routes them — asserted by VALUE on the
//      toggle response), and one enrolled BEFORE signing in (so the pointer the
//      sign-in landed wins across the toggle). The two-event control proves the
//      landing is a decision and not a default.
//   5. THE BOOT PATH. A sign-in that auto-resumes straight into the event never
//      opens the picker, so `S.myCompetitions` is filled by boot's `enter`
//      branch (core/main.js, the `_verdict` block that sets the list on EVERY
//      branch) and `currentCompetitionRow()` falls back to the /api/me rows. Two arms hold the two halves: a competitor is
//      still refused "Switch Session" on a reload, and an own-row SPECTATOR on
//      a dry-run event is still offered it — with the dry-run badge on every
//      session card, which reads the same list.
//
//   6. TWO DECISIONS PINNED AS THEY ARE, not as they might be nicer: a
//      spectator who leaves a live event and then picks one they compete in
//      meets 'Switch Event?' naming the spectated one — exactly what a
//      participant meets, because the spectator branch of `handleCompetitionsNav`
//      still records `S.lastLiveCompetitionId`; reversing it must re-point that
//      arm. And `staff_compete` rides the participant rows as the RAW column.
//
// THREE PRODUCT DEFECTS WERE PINNED AS `test.fixme` ARMS in the first draft,
// each asserting the intended behaviour and each verified RED against the
// product before being marked; all three were fixed in the same release and
// the fixmes lifted (the arms now hold):
//   D1 the count line over an EMPTY own section read "No events shown — every
//      event is hidden by the current filter" directly above "You have not been
//      added to any event." (competition-picker.js `_renderCompSection`'s
//      setListCount call: `filtered` was true with `total: 0`). The line
//      PREDATES v8.12.0 — any participant enrolled in nothing has seen it under
//      the default Active chip — and what this release changed is that it became
//      the DEFAULT state of every admin who toggles down while enrolled nowhere,
//      beneath a sentence it contradicts. Fixed at the picker
//      (`filtered:(mode==='active'||!!q)&&rows.length>0`), not the feature.
//   D2 the typed event code toasts `Joined <name>.` (success) beside the info
//      toast saying the staff member was NOT enrolled (self-enroll.js
//      `joinWithCode`: `joinViaPendingToken` returns the id the spectator answer
//      carries, and the success toast is unconditional).
//   D3 the author-competes 409 on the join link keeps the STORED pending join
//      (`joinViaPendingToken`'s `!r.ok` branch returns before `clearStoredJoin`);
//      a permanent refusal must purge it like a 404 does, or a role-participant
//      staff author is re-asked at every boot.
//
// EVERY POSITIVE ASSERTION HAS A CONTROL: an ordinary participant's one-section
// picker, an event admin's one-section picker, an own-but-non-compete event
// with no badge, the spectator twin of every competitor confirmation (including
// the own-row spectator), a non-staff participant on the same join link at
// EACH door (link, login card, typed code), the two-event admin on the toggle. The MutationObserver recorder's modal branch has
// its own positive controls ((e)-W and (f)-1 assert the titles it recorded), or
// every "no modal was raised" would be vacuous against a broken recorder.
//
// FIXTURE TRAPS MET WHILE WRITING THIS, each of which produced a test that
// reported the wrong thing before it was understood:
//   • THE SOLE-EVENT LANDING NOW APPLIES TO STAFF (decision 7). A staff member
//     enrolled in exactly ONE event is landed straight into it at sign-in, so a
//     test that needs the PICKER would never reach it. Every picker test therefore
//     signs in and then POSTs /api/deselect-competition — which is what pressing
//     **Events** does: it clears the session pointer AND the auto-resume marker,
//     and stamps `left_event_at`, which suppresses the landing. Choosing an event
//     again (which several tests do) re-pins it, which is why the deselect is
//     per-test rather than once in beforeAll. The same landing runs at the
//     PASSWORD DOOR for an ADMIN, which is why the toggle-landing arm must enrol
//     its admin AFTER signing in — enrolled before, the session already carries
//     the event and the toggle merely carries the pointer (the skeptic's finding).
//   • A COMPETITOR'S SESSION CHOICE IS FINAL, so the two-session flow can be
//     driven once per account — and a RETRY is a second drive. Every arm that
//     writes a slot onto a row mints its own staff member INSIDE the test body,
//     so the default `RETRIES=1` re-run starts from an unpinned account rather
//     than dying at the session picker with a message about the wrong thing.
//   • AN OWN ROW ON A NON-COMPETE EVENT CAN ONLY BE WRITTEN BEFORE THE TAG (the
//     assign path skips a staff member on a non-compete event), which is exactly
//     how such a row arises in production.
//   • THE JOIN POST WRITES A ROW, so the "Join and compete" arm owns its actor
//     too, or the two-section picker's "own lists ONLY E" assertion would fail
//     depending on order. The LOGIN-CARD and typed-CODE doors each own their
//     actors as well, minted with NO rows: a declined join then lands on the
//     picker with no deselect (the sole-event landing needs one own row), and a
//     genuine join is the only row that actor ever gets — so "enrolled through
//     the card" cannot be satisfied by an `alreadyMember` answer.
//   • THE ANONYMOUS JOIN LANDING IS THE SIGN-UP FORM, not the login card: the
//     card is reached through its "Already have an account? Sign In" button,
//     and BOTH banners (`#reg-join-banner`, `#join-banner`) name the event.
//   • AN ADMIN VISITS A JOIN LINK IN PARTICIPANT VIEW ONLY. The author arm
//     toggles the session down through `POST /api/toggle-admin-view` first;
//     booted as an admin the panel renders and the join block never runs.
//   • THE JOIN-CODE LOOKUP EXCHANGES THE CODE FOR THE LINK TOKEN (asserted in
//     beforeAll), so a typed code takes the link's path from the preview on;
//     what is the code door's OWN is what `joinWithCode` does with the answer.
//   • A SEALED CHALLENGE NEEDS A USER-BACKED AUTHOR: the built-in superadmin has
//     no `users` row and `sealAtCreateDenied` refuses it. An event whose switch
//     is on admits only sealed challenges, so the compete events here carry a
//     challenge created by a promoted admin who competes in nothing.
//   • AN ENDED COMPETE EVENT IS BUILT LIVE, ENROLLED, THEN ENDED (fixture
//     checklist item 8): the assign path refuses an ended event, and the
//     built-in superadmin can end it because it can never be a competitor.
//   • A TOAST LIVES FOUR SECONDS AND A MODAL CAN CLOSE BEFORE A LOCATOR LOOKS. Both
//     are recorded by a MutationObserver installed BEFORE boot (`__uiLog`), so
//     "no modal was ever raised" and "the info toast fired" are assertions over a
//     log rather than races against a timer.
//   • `staff_compete` RIDES THE PARTICIPANT ROWS AS THE RAW COLUMN (0/1), like
//     every sibling flag on that payload — a recorded decision (CLAUDE.md
//     "Staff can compete…", "Three wire facts"; lib/competitions.js's
//     `own`/`competing` projection), so it is read truthily here and nowhere
//     asserted `toBe(true)`.
//   • THE SKELETON LIVES ONLY BETWEEN THE PICKER RENDER AND /api/my-competitions
//     LANDING, so the skeleton arm holds that response for 1.5 s and RECORDS
//     the maximum per grid with an observer (the v8.6.4 shape) — a sample after
//     the fact reads 0 against a correct build.
//
// VERIFIED MUTATIONS (each applied to a throwaway copy of the tree, this file run
// against it on its own port base; the arm named went red and nothing else did):
//   M1 `staffSpectatorIn` keyed on `comp.own` instead of `comp.competing`
//      (ui/format.js) — kills the own-row spectator arms: (e) W3 entering F3,
//      (f) the two-session own-non-compete arm, and (f) the dry-run reload arm.
//   M2 `setCompOtherFilter` also writing `S.compFilterMode` (competition-picker.js)
//      — kills (b)-1, the other→own chip-leak arm, and only it.
//   M3 the `Switch Event?` branch of `pickCompetition` deleted — kills (g)'s
//      switch arm, and only it.
//   M4 the toggle route's `applyAutoResumeToSession` branch deleted
//      (routes/participant.js) — kills (i)'s landing arm; the carried-pointer arm
//      and the two-event control stay green, which is what says the landing arm
//      is the one holding the server branch.
//   M5 boot's `enter` branch no longer writing `S.myCompetitions` (core/main.js,
//      the boot half of the reload fix, with the `currentCompetitionRow`
//      fallback left in) —
//      kills the dry-run reload arm alone: the Switch Session half survives on
//      the fallback, the badge half reads the list directly.
//   M6 `_pickerSections` keyed on `S.isUserStaff||S.isEventAdmin` — kills the
//      event-admin one-section arm, and only it.
//   M7 the spectator toast emitted as an `error` toast (self-enroll.js) — kills
//      the three spectator-toast arms, one per door (link, login card, typed
//      code), and only them.
//   M8 the recorder's modal branch broken (`attributes: false` in THIS file's
//      `uiLogInit` observer options) — kills the positive-control assertions in
//      (e)-W, (f)-1, (g)'s switch arm (which asserts the four titles it drove,
//      in order), the (g) DECIDED arm and the login-card Not-now arm, which is
//      what makes the file's "no modal" negatives non-vacuous. NOTE: a
//      misspelled `attributeFilter` is NOT this mutation — with `attributes:
//      true` still in force the observer sees every attribute change and the
//      branch keeps recording; measured, the whole file stays green.
//   M9 `_pickerSections`' second section AND the badge gated on
//      `S.userRole==='participant'` (competition-picker.js) — decision 4's admin
//      half deleted: kills the (a) admin two-section arm and the author arm
//      (which reads Ea off the author's OTHER section), and nothing else. The
//      review round measured this mutation SURVIVING the file as it stood.
//   M10 `doLogin` (auth.js) suppressing `S.isUserStaff` around its
//      `joinViaPendingToken` call — the login-card door silently enrolling a
//      staff member as a competitor: kills the login-card Not-now arm alone.
//      Also measured surviving before that arm existed.
//   M11 the skeleton loop iterating `[_pickerSections()[0]]` only — kills the
//      per-section skeleton arm alone.
//   M12 `(competingBadge?', competing':'')` dropped from the card's accessible
//      name — kills (a)-W and the (a) admin arm (both assert `aria-label`).
//   M13 the spectator branch of `handleCompetitionsNav` clearing
//      `S.lastLiveCompetitionId` — kills the (g) DECIDED arm alone (it flips
//      from Switch to Enter).
//   M14 `joinWithCode` forgetting the preview (`S._pendingJoinComp=null`) so the
//      code door never raises the compete confirm — kills the typed-code
//      Not-now arm alone.
//   M15 `joinViaPendingToken`'s refusal toast swallowed — kills the author arm
//      alone.
//   No mutation applied here survived. The three former `test.fixme` arms were
//   each run UN-fixme'd against the first draft and failed on the assertion the
//   report quotes, which is what made them defects rather than opinions; the
//   fixes landed in the same release and the arms hold.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { loginViaApi, fillBreakGlass, submitLogin } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const JOIN_KEY = "hck-pending-join";
// The Participant View item lives in the account menu (tests/chrome-helpers.js).
const SWITCH_SESSION_BTN = "#tasks-comp-label [data-action='show-timeslot-picker']";
const DRY_RUN_TAG = "test/dry run";

let sa, saCsrf;
/** Every fixture, built once. Nothing here is a seeded participant. */
const F = {};

// ── helpers ──────────────────────────────────────────────────────────────────

function dbRow(sql, ...args) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

function membership(userId, compId) {
  return dbRow("SELECT assigned_by, timeslot_id FROM competition_users WHERE user_id=? AND competition_id=?", userId, compId) || null;
}

async function tagStaff(p) {
  const r = await sa.post(`/api/admin/participants/${p.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
  expect(r.ok(), `tag ${p.email} staff: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.tags, "the staff tag really landed").toContain("staff");
}

async function promote(p, role) {
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${p.email} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
}

async function addSession(compId, name, startOffsetMs) {
  const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
    headers: H(saCsrf),
    data: { name, start_time: new Date(Date.now() + startOffsetMs).toISOString(), duration_minutes: 240 },
  });
  expect(r.ok(), `session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).timeslot?.id;
  expect(id, `session ${name} has an id`).toBeTruthy();
  return id;
}

async function endNow(compId) {
  const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(saCsrf) });
  expect(r.ok(), `end-now ${compId}: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** The join LINK token and the printed six-character CODE, off one reveal. */
async function joinReveal(compId) {
  const r = await sa.get(`/api/admin/competitions/${compId}/self-enroll`);
  expect(r.ok(), `self-enroll reveal: ${r.status()}`).toBeTruthy();
  const d = await r.json();
  expect(d.token, "the reveal carries a token").toBeTruthy();
  expect(d.join_code, "…and the printed join code").toBeTruthy();
  return { token: d.token, code: d.join_code };
}

/**
 * Switch a signed-in ADMIN's session down to participant view through the API
 * (the `Participant View` button's own request), so a later `page.goto` boots
 * the participant app for an admin-tier account. The toggle regenerates the
 * session; `page.request` shares the context's cookie jar, so the page picks
 * the new one up on its next navigation.
 */
async function toParticipantView(page) {
  const r = await page.request.post("/api/toggle-admin-view", { headers: H(await csrfOf(page)), data: { mode: "participant" } });
  expect(r.ok(), `toggle to participant view: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/**
 * The LOGIN-CARD door of a join link: an anonymous visit to `/join/<token>`
 * lands on the email entry screen with the event on the card (email first:
 * there is no sign-up form until an address proof is redeemed); the person
 * signs in from the card, and the sign-in consumes the pending join. Nothing
 * here goes through the API — that is the point of the arm.
 */
async function signInAtCard(page, email, joinName) {
  await waitPage(page, "login-page", "the anonymous join landing");
  await expect(page.locator("#join-banner"), "the login card names the event being joined").toContainText(joinName);
  await page.locator("#login-email").fill(email);
  await fillBreakGlass(page, PARTICIPANT_PASS);
  await submitLogin(page);
}

/** The picker's typed EVENT CODE — the third way in. */
async function typeJoinCode(page, code) {
  await page.locator("#comp-join-code").fill(code);
  await page.locator("[data-action='join-with-code']").click();
}

/** A staff member minted for ONE arm: tagged, then enrolled where told. */
async function mintStaff(label, compIds = []) {
  const p = await makeParticipant(sa, saCsrf, label);
  await tagStaff(p);
  for (const id of compIds) await enrol(sa, saCsrf, id, [p.id]);
  return p;
}

/**
 * A participant enrolled BEFORE being tagged staff — the only order that
 * writes a row on a NON-compete event, and the production shape the switch's
 * OFF state produces (a participant later made staff keeps their rows).
 */
async function mintRowThenStaff(label, compIds) {
  const p = await makeParticipant(sa, saCsrf, label);
  for (const id of compIds) await enrol(sa, saCsrf, id, [p.id]);
  await tagStaff(p);
  return p;
}

async function csrfOf(page) {
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

/**
 * Press **Events** through the API: clears the session pointer and the
 * auto-resume marker and stamps `left_event_at`, so the next boot lands on the
 * picker whatever the sole-event landing would otherwise have decided.
 */
async function deselect(page) {
  const r = await page.request.post("/api/deselect-competition", { headers: H(await csrfOf(page)) });
  expect(r.ok(), `deselect: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** Where the app ended up, for a failure message that names the node. */
async function whereAmI(page) {
  return page.evaluate(() => ({
    shown: [...document.querySelectorAll(".page")].filter(el => getComputedStyle(el).display !== "none").map(el => el.id),
    modal: document.getElementById("modal-overlay")?.classList.contains("open") ? document.getElementById("modal-title")?.textContent : null,
    toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent),
  })).catch(() => null);
}

async function waitPage(page, id, what) {
  await page.locator(`#${id}.active`).waitFor({ state: "visible", timeout: 30_000 }).catch(async (e) => {
    throw new Error(`${e.message}\n  ${what}: #${id} never became the active page. State: ${JSON.stringify(await whereAmI(page))}`);
  });
}

/**
 * Whichever comes first: the page `id` becoming active, or a modal opening.
 * A spectator arm asserting "no modal" must not wait 30 s on a page that a
 * modal is blocking — it must SAY the modal appeared.
 */
async function settleOn(page, id) {
  await expect.poll(() => page.evaluate((pid) => {
    const open = document.getElementById("modal-overlay")?.classList.contains("open");
    if (open) return "modal:" + (document.getElementById("modal-title")?.textContent || "");
    return document.getElementById(pid)?.classList.contains("active") ? "page" : null;
  }, id), { timeout: 30_000, message: `waiting for #${id} or a modal` }).not.toBeNull();
  const modalTitle = await page.evaluate(() => document.getElementById("modal-overlay")?.classList.contains("open") ? document.getElementById("modal-title")?.textContent : null);
  return modalTitle ? `modal:${modalTitle}` : "page";
}

/** Sign in, press Events (API), boot, and wait for the picker to have rendered. */
async function bootPicker(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await deselect(page);
  await page.goto("/");
  await waitPage(page, "competitions-page", `picker for ${email}`);
  // A card OR an empty-state paragraph — either proves the render ran; the
  // bare page being active does not (the grid is filled once /api/me lands).
  await page.locator("#comp-grid .comp-card, #comp-grid .grid-empty").first().waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * The admin-tier shape of `bootPicker`: an admin account boots into the admin
 * panel, so the picker is reached through the participant-view toggle. The
 * deselect first suppresses the sole-event landing the toggle now applies.
 */
async function bootPickerViaToggle(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await deselect(page);
  await page.goto("/");
  await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30_000 });
  await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
  await waitPage(page, "competitions-page", `picker (via toggle) for ${email}`);
  await page.locator("#comp-grid .comp-card, #comp-grid .grid-empty").first().waitFor({ state: "visible", timeout: 30_000 });
}

const card = (page, gridId, compId) => page.locator(`#${gridId} .comp-card[data-comp-id="${compId}"]`);
// The card's CONTROL — the event-name button that carries its accessible name
// (the card itself stopped being role=button: a name must open with the text its
// control shows, WCAG 2.5.3). Negative assertions on it are paired with a count,
// so a card that lost the button cannot pass them by having no name at all.
const cardControl = (page, gridId, compId) => card(page, gridId, compId).locator(".card-open");
const stored = (page) => page.evaluate((k) => localStorage.getItem(k), JOIN_KEY);

/**
 * Installed BEFORE boot on every page: records every toast appended and every
 * modal title raised, so a negative ("no modal was raised") and a transient
 * (an info toast that lives four seconds) are both assertions over a log.
 */
function uiLogInit() {
  // @ts-ignore
  window.__uiLog = { toasts: [], modals: [] };
  let wasOpen = false;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") {
        m.addedNodes.forEach((n) => {
          // @ts-ignore
          if (n.nodeType === 1 && n.classList && n.classList.contains("toast")) window.__uiLog.toasts.push({ text: n.textContent || "", cls: n.className });
        });
      } else if (m.type === "attributes") {
        const t = /** @type {Element} */ (m.target);
        if (t.id === "modal-overlay") {
          const open = t.classList.contains("open");
          // @ts-ignore
          if (open && !wasOpen) window.__uiLog.modals.push(document.getElementById("modal-title")?.textContent || "");
          wasOpen = open;
        }
      }
    }
  });
  // `document`, not `documentElement`: an init script can beat the parser to the
  // root element, and observe(null) throws and kills the rest of the script
  // silently (the v8.6.4 lesson).
  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}
const uiLog = (page) => page.evaluate(() => /** @type {any} */ (window).__uiLog);

test.beforeEach(async ({ page }) => { await page.addInitScript(uiLogInit); });

// ── fixtures ─────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  const past = (h) => new Date(Date.now() - h * 3600_000).toISOString();

  // A user-backed admin who competes in nothing: the author of every sealed
  // challenge this file assigns to a compete event.
  const author = await makeParticipant(sa, saCsrf, "spc-author");
  await promote(author, "admin");
  const au = await apiLogin(author.email, PARTICIPANT_PASS);

  // E — switch ON, live. G — switch OFF, live. Hend — switch OFF, ended by time.
  F.E = await makeCompetition(sa, saCsrf, "spc-own", { staff_compete: true });
  F.G = await makeCompetition(sa, saCsrf, "spc-other");
  F.Hend = await makeCompetition(sa, saCsrf, "spc-ended", { start_time: past(3), duration_minutes: 60 });
  const sealed = await makeTask(au.api, au.csrf, "spc-sealed", { answer_sealed: true });
  await assignTask(au.api, au.csrf, sealed.id, [F.E.id]);
  F.sealedTitle = sealed.title;
  F.author = author;
  // Ea — switch ON, live join link, holding the AUTHOR's sealed challenge: the
  // one event its author can be told "Compete in this event?" on and then be
  // refused by the server (author door, routes/self-enroll.js).
  F.Ea = await makeCompetition(sa, saCsrf, "spc-join-author", { staff_compete: true, self_enroll_enabled: true });
  await assignTask(au.api, au.csrf, sealed.id, [F.Ea.id]);
  F.Ea.token = (await joinReveal(F.Ea.id)).token;
  const plain = await makeTask(sa, saCsrf, "spc-plain");
  await assignTask(sa, saCsrf, plain.id, [F.G.id]);

  // W — the staff member under test: tagged, then put in E (a compete event
  // admits staff) and nowhere else. P — the ordinary participant control, in
  // E and G (two events, so P reaches the picker without a deselect).
  F.W = await mintStaff("spc-w", [F.E.id]);
  F.P = await makeParticipant(sa, saCsrf, "spc-p");
  await enrol(sa, saCsrf, F.E.id, [F.P.id]);
  await enrol(sa, saCsrf, F.G.id, [F.P.id]);
  // X — staff, put in nothing.
  F.X = await mintStaff("spc-x");

  // W3 — holds a row on a compete event AND on a non-compete event (the badge
  // control, and the own-row SPECTATOR: the second row can only be written
  // before the tag, which is exactly how such a row arises in production).
  F.E3 = await makeCompetition(sa, saCsrf, "spc-w3-on", { staff_compete: true });
  F.F3 = await makeCompetition(sa, saCsrf, "spc-w3-off");
  F.W3 = await mintRowThenStaff("spc-w3", [F.E3.id, F.F3.id]);

  // Wb — the chip-state actor: competes in E (live) AND in Wend, a compete
  // event that has ENDED — built live, enrolled, then ended by the built-in
  // superadmin, who can never be a competitor and so is not locked out of it.
  // W is deliberately NOT given this second row: (a)-W asserts "exactly one".
  F.Wend = await makeCompetition(sa, saCsrf, "spc-wb-ended", { staff_compete: true });
  F.Wb = await mintStaff("spc-wb", [F.E.id, F.Wend.id]);
  await endNow(F.Wend.id);

  // Wsw — competes in TWO live compete events (E and E3): the Switch-Event arm.
  F.Wsw = await mintStaff("spc-wsw", [F.E.id, F.E3.id]);

  // M — switch ON, two LIVE sessions; N — switch OFF, two LIVE sessions.
  // Nd — switch OFF, two LIVE sessions, tagged test/dry run.
  F.M = await makeCompetition(sa, saCsrf, "spc-multi-on", { staff_compete: true });
  F.M.slotA = await addSession(F.M.id, "Slot A", -2 * 60_000);
  F.M.slotB = await addSession(F.M.id, "Slot B", -60_000);
  F.N = await makeCompetition(sa, saCsrf, "spc-multi-off");
  F.N.slotA = await addSession(F.N.id, "Slot A", -2 * 60_000);
  F.N.slotB = await addSession(F.N.id, "Slot B", -60_000);
  F.Nd = await makeCompetition(sa, saCsrf, "spc-dry-off", { tags: [DRY_RUN_TAG] });
  F.Nd.slotA = await addSession(F.Nd.id, "Slot A", -2 * 60_000);
  F.Nd.slotB = await addSession(F.Nd.id, "Slot B", -60_000);
  // Wm spectates N and holds NO rows at all — the (f) CONTROL treats them as a
  // pure spectator, and a row on M would make them a competitor there, subject
  // to the sole-event landing and the final session choice (masked only by
  // bootPicker's deselect; a future arm reusing Wm on M would meet both).
  // Wr competes in M and has ALREADY chosen a session (the reload arm); the arm
  // that CHOOSES a session in the browser mints its own actor inside the test,
  // because the choice is final and a retry re-drives it.
  F.Wm = await mintStaff("spc-wm");
  F.Wr = await mintStaff("spc-wr", [F.M.id]);
  {
    const wr = await apiLogin(F.Wr.email, PARTICIPANT_PASS);
    const s1 = await wr.api.post("/api/select-competition", { headers: H(wr.csrf), data: { competitionId: F.M.id } });
    expect(s1.ok(), `Wr selects M: ${s1.status()} ${await s1.text()}`).toBeTruthy();
    const s2 = await wr.api.post("/api/select-timeslot", { headers: H(wr.csrf), data: { timeslotId: F.M.slotA, confirmLive: true } });
    expect(s2.ok(), `Wr joins slot A: ${s2.status()} ${await s2.text()}`).toBeTruthy();
    expect((await s2.json()).ok, "Wr's session choice committed").toBe(true);
    await wr.api.dispose();
  }

  // E2 — switch ON with a live join link; G2 — switch OFF with a live join link.
  F.E2 = await makeCompetition(sa, saCsrf, "spc-join-on", { staff_compete: true, self_enroll_enabled: true });
  ({ token: F.E2.token, code: F.E2.code } = await joinReveal(F.E2.id));
  F.G2 = await makeCompetition(sa, saCsrf, "spc-join-off", { self_enroll_enabled: true });
  ({ token: F.G2.token, code: F.G2.code } = await joinReveal(F.G2.id));
  // Wj — staff, joins E2 for real. Pj — an ordinary participant on the same link.
  F.Wj = await mintStaff("spc-wj");
  F.Pj = await makeParticipant(sa, saCsrf, "spc-pj");
  // The LOGIN-CARD door (the ordinary QR flow: a signed-out phone) has its own
  // actors, each holding NO rows, so the sole-event landing cannot decide where
  // a declined join lands them and a genuine join is the only row they get.
  // Wl declines E2 at the card; Wl2 is admitted to G2 as a spectator at the
  // card; Wc types E2's code and declines. The two participant CONTROLS at
  // those doors (enrolled at the card / by the code) mint their actor INSIDE
  // the test: a join writes a row, so a retry or `--repeat-each` on a shared
  // actor would be answered `alreadyMember` and the row assertion would hold
  // for the wrong reason.
  F.Wl = await mintStaff("spc-wl");
  F.Wl2 = await mintStaff("spc-wl2");
  F.Wc = await mintStaff("spc-wc");

  // A1 — a user-backed admin enrolled in exactly ONE compete event BEFORE
  // signing in (the carried-pointer arm); A2 — in two (the control). The arm
  // that drives the toggle's OWN landing mints its admin inside the test and
  // enrols them after the sign-in.
  F.EI1 = await makeCompetition(sa, saCsrf, "spc-adm-one", { staff_compete: true });
  F.EI2 = await makeCompetition(sa, saCsrf, "spc-adm-two", { staff_compete: true });
  F.A1 = await makeParticipant(sa, saCsrf, "spc-a1");
  await promote(F.A1, "admin");
  await enrol(sa, saCsrf, F.EI1.id, [F.A1.id]);
  F.A2 = await makeParticipant(sa, saCsrf, "spc-a2");
  await promote(F.A2, "admin");
  await enrol(sa, saCsrf, F.EI1.id, [F.A2.id]);
  await enrol(sa, saCsrf, F.EI2.id, [F.A2.id]);

  // EA — an EVENT ADMIN (organiser of G, not staff-tagged) enrolled in E, the
  // compete event: decision 4's second half says their picker stays one section.
  F.EA = await makeParticipant(sa, saCsrf, "spc-ea");
  await grantEventAdmin(sa, saCsrf, F.G.id, F.EA.id);
  await enrol(sa, saCsrf, F.E.id, [F.EA.id]);

  // PRECONDITIONS ASSERTED, NOT ASSUMED. Every picker assertion below reads
  // `own` / `competing` off the wire; if the wire is wrong the browser is
  // faithfully rendering a wrong answer and the failure would point at the DOM.
  {
    const w = await apiLogin(F.W.email, PARTICIPANT_PASS);
    const me = await (await w.api.get("/api/me")).json();
    expect(me.isStaff, "W really is staff on the wire").toBe(true);
    const rows = await (await w.api.get("/api/my-competitions")).json();
    const byId = Object.fromEntries(rows.map(c => [c.id, c]));
    expect(byId[F.E.id] && byId[F.E.id].own, "W holds a row on E").toBe(true);
    expect(byId[F.E.id].competing, "…and competes there").toBe(true);
    // Truthiness, not `toBe(true)`: the participant wire spreads the RAW column
    // (`1`) beside the boolean `own`/`competing` — a recorded decision (CLAUDE.md
    // "Three wire facts"), and every client read of it is a truthiness test.
    expect(byId[F.E.id].staff_compete, "E's switch is on").toBeTruthy();
    expect(byId[F.G.id] && byId[F.G.id].own, "W holds NO row on G").toBe(false);
    expect(byId[F.Hend.id] && byId[F.Hend.id].status, "Hend really is ended").toBe("ended");
    expect(byId[F.Nd.id] && byId[F.Nd.id].tags, "Nd really carries the dry-run tag").toContain(DRY_RUN_TAG);
    await w.api.dispose();
    const wb = await apiLogin(F.Wb.email, PARTICIPANT_PASS);
    const wbRows = Object.fromEntries((await (await wb.api.get("/api/my-competitions")).json()).map(c => [c.id, c]));
    expect(wbRows[F.Wend.id] && wbRows[F.Wend.id].own, "Wb holds a row on Wend").toBe(true);
    expect(wbRows[F.Wend.id].status, "Wend really is ended").toBe("ended");
    expect(wbRows[F.E.id] && wbRows[F.E.id].status, "…and E is live").toBe("live");
    await wb.api.dispose();
    const w3 = await apiLogin(F.W3.email, PARTICIPANT_PASS);
    const w3Rows = Object.fromEntries((await (await w3.api.get("/api/my-competitions")).json()).map(c => [c.id, c]));
    expect(w3Rows[F.F3.id] && w3Rows[F.F3.id].own, "W3 holds a row on F3").toBe(true);
    expect(w3Rows[F.F3.id].competing, "…but does not compete there: the switch is off").toBe(false);
    expect(w3Rows[F.E3.id] && w3Rows[F.E3.id].competing, "…and competes in E3").toBe(true);
    await w3.api.dispose();
    const p = await apiLogin(F.P.email, PARTICIPANT_PASS);
    const pme = await (await p.api.get("/api/me")).json();
    expect(pme.isStaff, "P really is not staff").toBe(false);
    await p.api.dispose();
    const ea = await apiLogin(F.EA.email, PARTICIPANT_PASS);
    const eame = await (await ea.api.get("/api/me")).json();
    expect(eame.isStaff, "the event admin is NOT staff-tagged on the wire").toBe(false);
    expect(eame.isEventAdmin, "…but holds the tier").toBe(true);
    const eaRows = Object.fromEntries((await (await ea.api.get("/api/my-competitions")).json()).map(c => [c.id, c]));
    expect(eaRows[F.E.id] && eaRows[F.E.id].own && eaRows[F.E.id].competing, "the wire says the event admin competes in E — the missing badge is the CLIENT's decision").toBe(true);
    await ea.api.dispose();
    const pv = await (await sa.get(`/api/competitions/self-enroll/${encodeURIComponent(F.E2.token)}`)).json();
    expect(pv.staff_compete, "the E2 join preview says staff compete").toBe(true);
    const pv2 = await (await sa.get(`/api/competitions/self-enroll/${encodeURIComponent(F.G2.token)}`)).json();
    expect(pv2.staff_compete, "the G2 join preview says staff do not").toBe(false);
    const pva = await (await sa.get(`/api/competitions/self-enroll/${encodeURIComponent(F.Ea.token)}`)).json();
    expect(pva.staff_compete, "the Ea join preview says staff compete").toBe(true);
    // The typed-code lookup exchanges the printed code for the SAME token the
    // link carries — one join mechanism, three ways in.
    const jc = await (await sa.get(`/api/competitions/join-code/${encodeURIComponent(F.E2.code)}`)).json();
    expect(jc.ok && jc.token, "E2's printed code resolves to its link token").toBe(F.E2.token);
    // A2 is an ADMIN and therefore staff-TAGGED (the role route writes the tag),
    // which is what decision 4's FIRST half rests on: the wire says two sections.
    const a2 = await apiLogin(F.A2.email, PARTICIPANT_PASS);
    const a2me = await (await a2.api.get("/api/me")).json();
    expect(a2me.isStaff, "the promoted admin A2 is staff-tagged on the wire").toBe(true);
    await a2.api.dispose();
    const aume = await apiLogin(F.author.email, PARTICIPANT_PASS);
    expect((await (await aume.api.get("/api/me")).json()).isStaff, "the author (an admin) is staff-tagged on the wire").toBe(true);
    await aume.api.dispose();
  }
  await au.api.dispose();
});

test.afterAll(async () => { await sa?.dispose(); });

// ── (a) the two-section picker ───────────────────────────────────────────────

test.describe("v8.12.0 — a staff member's picker has two sections", () => {

  test("W: 'Your Events' lists ONLY the event they hold a row on, marked Competing; every other non-ended event is listed below", async ({ page }) => {
    await bootPicker(page, F.W.email);

    const other = page.locator("#comp-other-section");
    await expect(other, "the second section renders for a staff member").toBeVisible();
    await expect(page.locator("#comp-other-grid .comp-card").first()).toBeVisible();

    // OWN: exactly E, and nothing else.
    await expect(card(page, "comp-grid", F.E.id)).toBeVisible();
    await expect(page.locator("#comp-grid .comp-card"), "own holds exactly the one row").toHaveCount(1);
    await expect(card(page, "comp-grid", F.G.id)).toHaveCount(0);

    // The badge, on the own+compete row only.
    const badge = card(page, "comp-grid", F.E.id).locator(".status-badge.competing");
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveText("Competing");
    // The ACCESSIBLE name says what the badge says (v7.21.19 F8): a screen-reader
    // user must hear "competing" where a sighted one reads it. The P control
    // below asserts the clause is absent for a participant on the same event.
    await expect(cardControl(page, "comp-grid", F.E.id), "the card's accessible name carries the badge").toHaveAttribute("aria-label", /, competing/);
    await expect(page.locator("#comp-other-grid .status-badge.competing"), "nothing in the other section is 'Competing'").toHaveCount(0);
    await expect(cardControl(page, "comp-other-grid", F.G.id)).toHaveCount(1);
    await expect(cardControl(page, "comp-other-grid", F.G.id)).not.toHaveAttribute("aria-label", /competing/);

    // OTHER: G, the seeded live and upcoming events — NOT E, and not the ended
    // ones under the default chip.
    await expect(card(page, "comp-other-grid", F.G.id)).toBeVisible();
    await expect(page.locator("#comp-other-grid .comp-card", { hasText: "Test Live" })).toHaveCount(1);
    await expect(page.locator("#comp-other-grid .comp-card", { hasText: "Test Upcoming" })).toHaveCount(1);
    await expect(card(page, "comp-other-grid", F.E.id), "an own row is never repeated below").toHaveCount(0);
    await expect(card(page, "comp-other-grid", F.Hend.id), "ended stays hidden under Active & Upcoming").toHaveCount(0);
    await expect(card(page, "comp-other-grid", F.Wend.id), "…and so does the ended compete event").toHaveCount(0);

    // The two counts describe their OWN section — pinned to the grid each one
    // sits over. `/events shown/` alone is satisfied by the EMPTY-state sentence
    // ("No events shown — every event is hidden…"), so the other count is read
    // against the number of cards actually rendered, and its total must exceed
    // them: Hend, Wend and the seeded ended event are hidden under Active.
    await expect(page.locator("#comp-grid-count")).toHaveText(/^1 of 1 event shown$/);
    const n = await page.locator("#comp-other-grid .comp-card").count();
    expect(n, "the other grid rendered something to count").toBeGreaterThan(1);
    await expect(page.locator("#comp-other-grid-count")).toHaveText(new RegExp(`^${n} of (\\d+) events shown$`));
    const total = Number((await page.locator("#comp-other-grid-count").textContent()).match(/of (\d+) events/)[1]);
    expect(total, "the other section's total counts the ended events its chip hides").toBeGreaterThan(n);
  });

  test("CONTROL: an ordinary participant gets one section and no Competing badge — even on an event whose switch is on", async ({ page }) => {
    // Without this, "two sections" is satisfied by a build that renders the
    // second section for everybody, and "Competing" by one that paints it on
    // every compete event. P holds rows on E (switch on) and G (switch off).
    await loginViaApi(page, F.P.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitPage(page, "competitions-page", "P's picker");
    await expect(card(page, "comp-grid", F.E.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.G.id)).toBeVisible();
    await expect(page.locator("#comp-other-section"), "the second section stays hidden for a non-staff participant").toBeHidden();
    await expect(page.locator("#comp-other-grid .comp-card")).toHaveCount(0);
    await expect(page.locator(".status-badge.competing"), "no Competing badge for a participant, whatever the switch says").toHaveCount(0);
    await expect(cardControl(page, "comp-grid", F.E.id)).toHaveCount(1);
    await expect(cardControl(page, "comp-grid", F.E.id), "…and no 'competing' in the accessible name either").not.toHaveAttribute("aria-label", /competing/);
  });

  test("(a) decision 4, FIRST half: an ADMIN in participant view gets the two sections and the Competing badge on their own compete rows", async ({ page }) => {
    // The split and the badge key on the staff TAG, and every admin carries it
    // (the role route writes it — asserted on the wire in beforeAll). Every other
    // two-section assertion in this file is made on a NON-admin staff member, so
    // a build that gated `_pickerSections`' second section and the badge on
    // `S.userRole==='participant'` — deleting decision 4's admin half — kept the
    // whole file green (measured by the review round; mutation M9). A2 is the
    // (i) control's two-event admin, reached through the same toggle.
    await bootPickerViaToggle(page, F.A2.email);
    await expect(page.locator("#comp-other-section"), "the second section renders for an admin in participant view").toBeVisible();
    await expect(card(page, "comp-grid", F.EI1.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.EI2.id)).toBeVisible();
    await expect(page.locator("#comp-grid .comp-card"), "own holds exactly the two rows they were put in").toHaveCount(2);
    await expect(page.locator("#comp-grid .status-badge.competing"), "both own rows are on compete events, so both are marked").toHaveCount(2);
    await expect(cardControl(page, "comp-grid", F.EI1.id)).toHaveAttribute("aria-label", /, competing/);
    await expect(page.locator("#comp-grid-count")).toHaveText(/^2 of 2 events shown$/);
    // The other section is the rest of the platform, minus their own rows.
    await expect(card(page, "comp-other-grid", F.G.id)).toBeVisible();
    await expect(page.locator("#comp-other-grid .comp-card", { hasText: "Test Live" })).toHaveCount(1);
    await expect(card(page, "comp-other-grid", F.EI1.id), "an own row is never repeated below").toHaveCount(0);
    await expect(card(page, "comp-other-grid", F.EI2.id)).toHaveCount(0);
    await expect(page.locator("#comp-other-grid .status-badge.competing"), "nothing in the other section is 'Competing'").toHaveCount(0);
  });

  test("CONTROL (decision 4, second half): an EVENT ADMIN in participant view keeps ONE section — their own row, and no Competing marker on it", async ({ page }) => {
    // The split keys on the staff TAG, not on any admin tier. A future
    // `S.isUserStaff||S.isEventAdmin` would hand every organiser a two-section
    // picker with the whole platform in it; nothing else in the suite would say
    // so. The wire says EA competes in E (asserted in beforeAll), so the absent
    // badge is the client's documented decision (competition-picker.js
    // `_compCardHtml`: `S.isUserStaff&&c.competing` — staff-TAGGED only),
    // with (a)-W as the control that a TAGGED user does get the badge on E.
    await bootPickerViaToggle(page, F.EA.email);
    await expect(page.locator("#comp-other-section"), "no second section for an event admin").toBeHidden();
    await expect(page.locator("#comp-other-grid .comp-card")).toHaveCount(0);
    await expect(card(page, "comp-grid", F.E.id), "their own row is listed").toBeVisible();
    await expect(page.locator("#comp-grid .comp-card"), "…and only that row — not the whole platform").toHaveCount(1);
    await expect(card(page, "comp-grid", F.G.id), "the event they ORGANISE is not a row they hold").toHaveCount(0);
    await expect(page.locator(".status-badge.competing"), "an event admin's card carries no Competing marker").toHaveCount(0);
    await expect(page.locator("#comp-grid-count")).toHaveText(/^1 of 1 event shown$/);
  });

  test("CONTROL: an own row on an event where staff do NOT compete is listed under Your Events WITHOUT the badge", async ({ page }) => {
    // W3 holds a row on E3 (switch on) and on F3 (switch off, enrolled before
    // being tagged). Both are OWN — the section is about holding a row — and
    // only E3 is Competing: the badge is `own && staff_compete`, not `own`.
    await bootPicker(page, F.W3.email);
    await expect(card(page, "comp-grid", F.E3.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.F3.id)).toBeVisible();
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(2);
    await expect(card(page, "comp-grid", F.E3.id).locator(".status-badge.competing")).toHaveCount(1);
    await expect(card(page, "comp-grid", F.F3.id).locator(".status-badge.competing"), "an own row on a non-compete event is not 'Competing'").toHaveCount(0);
    await expect(card(page, "comp-other-grid", F.F3.id), "…and it is not repeated in the other section either").toHaveCount(0);
  });

  test("(d) a staff member put in nothing sees the empty-state sentence above a full second section", async ({ page }) => {
    await bootPicker(page, F.X.email);
    await expect(page.locator("#comp-grid .grid-empty")).toContainText("You have not been added to any event");
    await expect(page.locator("#comp-grid .grid-empty")).toContainText("Every event you can enter as staff is listed below");
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(0);
    await expect(page.locator("#comp-other-section")).toBeVisible();
    await expect(page.locator("#comp-other-grid .comp-card", { hasText: "Test Live" })).toHaveCount(1);
    await expect(card(page, "comp-other-grid", F.E.id), "E is somebody else's event to X, so it is listed below").toBeVisible();
    await expect(card(page, "comp-other-grid", F.G.id)).toBeVisible();
    // The OTHER section's count still describes its own grid.
    const n = await page.locator("#comp-other-grid .comp-card").count();
    expect(n).toBeGreaterThan(1);
    await expect(page.locator("#comp-other-grid-count")).toHaveText(new RegExp(`^${n} of \\d+ events shown$`));
  });

  test("(d) the count line over an EMPTY own section must not blame a filter above a sentence saying there is nothing to show", async ({ page }) => {
    // The DEFAULT state of every admin who toggles down while enrolled nowhere:
    // `_renderCompSection` passes `filtered: mode==='active'||!!q` with
    // `total: 0`, so `countText`'s `!matched` branch renders "No events shown —
    // every event is hidden by the current filter" in an aria-live region
    // directly above "You have not been added to any event." Nothing is hidden
    // by a filter; there is nothing to show. An empty section is not a filtered
    // one: `filtered:(mode==='active'||!!q)&&rows.length>0` would make the line
    // read "0 events" (competition-picker.js `_renderCompSection`, the
    // setListCount call; ui/list-controls.js countText's `!matched` branch).
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // an empty section is not a filtered one, so `filtered` is false at total 0.
    await bootPicker(page, F.X.email);
    await expect(page.locator("#comp-grid .grid-empty")).toContainText("You have not been added to any event");
    await expect(page.locator("#comp-grid-count")).not.toHaveText(/hidden by the current filter/);
    await expect(page.locator("#comp-grid-count")).toHaveText(/^0 events$/);
  });

  test("(a) the skeleton reservation is PER SECTION: the other grid reserves its own cards before the list arrives, and a re-load over a populated grid paints none", async ({ page }) => {
    // `loadMyCompetitions` reserves one skeleton per coming card, PER SECTION
    // (`for(const sec of _pickerSections())`). cls-picker-skeleton.spec.js
    // reserves the OWN grid only, so a regression that iterates the first
    // section alone — the second grid then grows from zero and shifts the
    // footer — is invisible everywhere but here. Recorded by an observer, never
    // sampled: the skeleton lives only between the picker render and the
    // /api/my-competitions response, so that response is held for a moment.
    await page.addInitScript(() => {
      // @ts-ignore
      window.__maxSk = { own: 0, other: 0 };
      const tick = () => {
        for (const [k, id] of [["own", "comp-grid"], ["other", "comp-other-grid"]]) {
          const g = document.getElementById(id);
          // @ts-ignore
          if (g) window.__maxSk[k] = Math.max(window.__maxSk[k], g.querySelectorAll(".skeleton-comp-card").length);
        }
      };
      new MutationObserver(tick).observe(document, { childList: true, subtree: true });
      tick();
    });
    await loginViaApi(page, F.W.email, PARTICIPANT_PASS);
    await deselect(page);
    await page.route("**/api/my-competitions", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/");
    await waitPage(page, "competitions-page", "W's picker (skeleton arm)");
    await page.locator("#comp-other-grid .comp-card").first().waitFor({ state: "visible", timeout: 30_000 });
    await expect(card(page, "comp-grid", F.E.id)).toBeVisible();
    await page.unroute("**/api/my-competitions");
    const sk = await page.evaluate(() => /** @type {any} */ (window).__maxSk);
    const otherCards = await page.locator("#comp-other-grid .comp-card").count();
    expect(otherCards, "the other grid rendered something to reserve for").toBeGreaterThan(1);
    expect(sk.own, "the own grid reserved its one card").toBe(1);
    expect(sk.other, `the other grid reserved ${sk.other} cards for the ${otherCards} that rendered`).toBe(otherCards);
    // Only an EMPTY grid gets them: the same function is the 15 s poll's body.
    await page.evaluate(() => { /** @type {any} */ (window).loadMyCompetitions(); });
    expect(await page.locator("#comp-grid .skeleton-comp-card").count(), "no skeletons over the populated own grid").toBe(0);
    expect(await page.locator("#comp-other-grid .skeleton-comp-card").count(), "…nor over the populated other grid").toBe(0);
    await expect(page.locator("#comp-other-grid .comp-card")).toHaveCount(otherCards);
  });
});

// ── (b) per-section chips, (c) the shared search ─────────────────────────────

test.describe("v8.12.0 — per-section chips and the shared search", () => {

  const activeChip = (page, filtersId) => page.locator(`#${filtersId} .filter-btn.active`);

  // Wb holds an ENDED own row (Wend) beside a live one (E), which is what makes
  // BOTH directions of "per-section state" observable: W's only own row is live,
  // so for W own-under-All is identical to own-under-Active and a leak from the
  // other section's chip into the own section's state would render nothing.

  test("(b) 'All' in the OTHER section reveals ended events there and leaves Your Events, its chip AND its count alone", async ({ page }) => {
    await bootPicker(page, F.Wb.email);
    await expect(activeChip(page, "comp-other-filters")).toHaveAttribute("data-value", "active");
    await expect(card(page, "comp-other-grid", F.Hend.id)).toHaveCount(0);
    // Own, before: E shown, the ended own row hidden, and the count says so.
    await expect(card(page, "comp-grid", F.E.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.Wend.id), "the ended own row is hidden under Active").toHaveCount(0);
    await expect(page.locator("#comp-grid-count")).toHaveText(/^1 of 2 events shown$/);

    await page.locator("#comp-other-filters .filter-btn[data-value='all']").click();
    await expect(activeChip(page, "comp-other-filters")).toHaveAttribute("data-value", "all");
    await expect(card(page, "comp-other-grid", F.Hend.id), "the ended event appears under All").toBeVisible();
    await expect(page.locator("#comp-other-grid .comp-card", { hasText: "Test Ended" })).toHaveCount(1);
    await expect(card(page, "comp-other-grid", F.Wend.id), "an own row is never repeated below, ended or not").toHaveCount(0);

    // The OWN section did not move: its chip is still Active & Upcoming, its
    // grid still holds exactly E, its ended row is still hidden, and its count
    // still says one of two. A chip handler that wrote the OTHER section's mode
    // into the own section's state would reveal Wend here.
    await expect(activeChip(page, "comp-filters")).toHaveAttribute("data-value", "active");
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(1);
    await expect(card(page, "comp-grid", F.E.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.Wend.id), "the own section's ended row stays hidden").toHaveCount(0);
    await expect(page.locator("#comp-grid-count")).toHaveText(/^1 of 2 events shown$/);
  });

  test("(b) 'All' in Your Events reveals the ended OWN row and does not change the other section's chip or grid", async ({ page }) => {
    await bootPicker(page, F.Wb.email);
    await page.locator("#comp-filters .filter-btn[data-value='all']").click();
    await expect(activeChip(page, "comp-filters")).toHaveAttribute("data-value", "all");
    // Own: the ended compete event appears, still marked Competing, and the
    // count is the unfiltered total.
    await expect(card(page, "comp-grid", F.Wend.id), "the ended own row appears under All").toBeVisible();
    await expect(card(page, "comp-grid", F.Wend.id).locator(".status-badge.competing")).toHaveCount(1);
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(2);
    await expect(page.locator("#comp-grid-count")).toHaveText(/^2 events$/);
    // Other: still on its default, still hiding the ended events.
    await expect(activeChip(page, "comp-other-filters")).toHaveAttribute("data-value", "active");
    await expect(card(page, "comp-other-grid", F.Hend.id), "the other grid still hides ended events").toHaveCount(0);
    await expect(page.locator("#comp-other-grid .comp-card", { hasText: "Test Ended" })).toHaveCount(0);
    await expect(card(page, "comp-other-grid", F.G.id), "…and still lists the live ones").toBeVisible();
  });

  test("(c) the shared search narrows BOTH grids, and both counts follow", async ({ page }) => {
    await bootPicker(page, F.W.email);
    const otherBefore = await page.locator("#comp-other-grid .comp-card").count();
    expect(otherBefore, "the other grid has several events to narrow").toBeGreaterThan(1);

    // `pressSequentially`, never `fill()`: the input's handler re-renders the
    // grids on every keystroke and a fill sets the value atomically, so it
    // cannot reproduce a re-render mid-type (Recurring rules).
    const term = "spc-other-"; // G's name, and nobody else's
    await page.locator("#participant-comp-search").pressSequentially(term, { delay: 30 });

    await expect(page.locator("#comp-other-grid .comp-card")).toHaveCount(1);
    await expect(card(page, "comp-other-grid", F.G.id)).toBeVisible();
    await expect(page.locator("#comp-other-grid-count")).toContainText(/^1 of \d+ events? match/);
    // Own has nothing named that, and says so — the search reached it too.
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(0);
    await expect(page.locator("#comp-grid .grid-empty")).toContainText(term);
    await expect(page.locator("#comp-grid-count")).toContainText(/No events match/);

    // Clearing restores both.
    await page.locator("#participant-comp-search-clear").click();
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(1);
    await expect(page.locator("#comp-other-grid .comp-card")).toHaveCount(otherBefore);
    await expect(page.locator("#comp-grid-count")).toContainText(/1 of 1 event/);
  });
});

// ── (e) entering: competitor vs spectator ────────────────────────────────────

test.describe("v8.12.0 — entering a live event: a competitor is asked, a spectator is not", () => {

  test("(e) W clicking the LIVE event they compete in meets 'Enter Live Event' and lands after confirming", async ({ page }) => {
    await bootPicker(page, F.W.email);
    await card(page, "comp-grid", F.E.id).click();
    await expect(page.locator("#modal-overlay")).toHaveClass(/open/);
    await expect(page.locator("#modal-title")).toHaveText("Enter Live Event");
    await expect(page.locator("#modal-confirm-btn")).toHaveText("Enter Event");
    await page.locator("#modal-confirm-btn").click();
    await waitPage(page, "tasks-page", "W entering E");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.E.name);
    await expect(page.locator(`.task-card:has-text("${F.sealedTitle}")`).first(), "E's sealed challenge is on the grid").toBeVisible({ timeout: 15_000 });
    // THE RECORDER'S POSITIVE CONTROL: the modal the locators just drove must be
    // in the log, or every `modals toEqual([])` below is satisfied by a recorder
    // whose modal branch records nothing.
    expect((await uiLog(page)).modals, "the recorder saw the modal the locators saw").toContain("Enter Live Event");
  });

  test("(e) W clicking a LIVE event they merely spectate gets NO modal and lands straight in it", async ({ page }) => {
    await bootPicker(page, F.W.email);
    await card(page, "comp-other-grid", F.G.id).click();
    await waitPage(page, "tasks-page", "W spectating G");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.G.name);
    const log = await uiLog(page);
    expect(log.modals, "no confirmation was raised for a spectator").toEqual([]);
    expect(membership(F.W.id, F.G.id), "spectating writes no row").toBeNull();
  });

  test("(e) W3 clicking an event they HOLD A ROW ON but do not compete in is a spectator there: no confirm in, no confirm out, and the row survives", async ({ page }) => {
    // The predicate is `competing`, not `own`. W3's row on F3 was written
    // before the tag — the production shape a switch left OFF produces — so a
    // build that keyed the exemptions on holding a row would ask W3 here, and
    // nothing else in this file could tell the two predicates apart: W's only
    // own row is competing, and every other spectator case holds no row.
    await bootPicker(page, F.W3.email);
    await card(page, "comp-grid", F.F3.id).click();
    expect(await settleOn(page, "tasks-page"), "an own-row spectator is not asked on the way in").toBe("page");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.F3.name);
    await page.locator("#nav-competitions").click();
    expect(await settleOn(page, "competitions-page"), "…nor on the way out").toBe("page");
    expect((await uiLog(page)).modals, "no modal at any point").toEqual([]);
    expect(membership(F.W3.id, F.F3.id), "leaving the view does not un-enrol an own-row spectator").toBeTruthy();
    await expect(card(page, "comp-grid", F.F3.id), "the row is still listed under Your Events").toBeVisible();
  });

  test("CONTROL: an ordinary participant is still asked on the same compete event", async ({ page }) => {
    // Without this, "the competitor is asked" is indistinguishable from "staff
    // are asked" — the confirm must be the participant's confirm, not a new one.
    await loginViaApi(page, F.P.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitPage(page, "competitions-page", "P's picker");
    await card(page, "comp-grid", F.E.id).click();
    await expect(page.locator("#modal-title")).toHaveText("Enter Live Event");
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    await expect(page.locator("#competitions-page")).toHaveClass(/active/);
  });
});

// ── (f) sessions: the live warning, the join confirm, the Switch button ──────

test.describe("v8.12.0 — a competing staff member's session choice is as final as anybody's", () => {

  test("(f) a competitor in the timeslot picker of a compete event sees the live warning, is asked to join, and gets no 'Switch Session' afterwards", async ({ page }) => {
    // Minted here, not in beforeAll: this arm PINS the actor to a session, so a
    // retry sharing the actor would skip the picker and die at
    // `waitPage(timeslot-picker-page)` — a second failure naming the wrong thing.
    const wf = await mintStaff("spc-wf", [F.M.id]);
    await bootPicker(page, wf.email);
    await card(page, "comp-grid", F.M.id).click();
    // The event is live (its sessions are), so the Enter confirm comes first —
    // this actor competes here.
    await expect(page.locator("#modal-title")).toHaveText("Enter Live Event");
    await page.locator("#modal-confirm-btn").click();

    await waitPage(page, "timeslot-picker-page", "M's session picker");
    const slotA = page.locator(`#timeslot-picker-content .comp-card[data-ts-id="${F.M.slotA}"]`);
    await expect(slotA).toBeVisible();
    await expect(slotA.locator(".ts-live-warning"), "a competitor is warned the choice is final").toBeVisible();
    await expect(page.locator("#timeslot-picker-content .ts-live-warning")).toHaveCount(2);

    await slotA.click();
    await expect(page.locator("#modal-title")).toHaveText("Join Live Session");
    await expect(page.locator("#modal-confirm-btn")).toHaveText("Join Now");
    await page.locator("#modal-confirm-btn").click();

    await waitPage(page, "tasks-page", "the competitor inside M after joining");
    await expect(page.locator("#tasks-comp-label")).toContainText("Slot A");
    await expect(page.locator(SWITCH_SESSION_BTN), "a competitor is pinned to the session they chose").toHaveCount(0);
    const row = membership(wf.id, F.M.id);
    expect(row && row.timeslot_id, "the choice was committed to the row").toBe(F.M.slotA);
    // The recorder's positive control for BOTH confirms this arm drove.
    const log = await uiLog(page);
    expect(log.modals, "the recorder saw the Enter confirm").toContain("Enter Live Event");
    expect(log.modals, "…and the Join confirm").toContain("Join Live Session");
  });

  test("CONTROL: the same staff member on a two-session event where staff do NOT compete sees no warning, no confirm, and a Switch Session button", async ({ page }) => {
    await bootPicker(page, F.Wm.email);
    await card(page, "comp-other-grid", F.N.id).click();
    await waitPage(page, "timeslot-picker-page", "N's session picker");
    const slotA = page.locator(`#timeslot-picker-content .comp-card[data-ts-id="${F.N.slotA}"]`);
    await expect(slotA).toBeVisible();
    // 8.17.0 page re-check: the session picker kept the SIGNED-OUT header (the
    // nav drawn inside it, the active tab's label unreadable, the loose theme
    // buttons back). It has the signed-in one, as every other signed-in page.
    await expect(page.locator("#app-header"), "the signed-in header").toHaveClass(/\bis-app\b/);
    await expect(page.locator("#app-header #profile-menu-btn"), "the account button").toBeVisible();
    await expect(page.locator("#app-header #look-picker-btn"), "CONTROL: the signed-out look picker is still mounted").toBeAttached();
    await expect(page.locator("#app-header #look-picker-btn"), "…and not loose in the signed-in header").toBeHidden();
    await expect(page.locator("#timeslot-picker-content .ts-live-warning"), "a spectator's choice is not final, so no warning").toHaveCount(0);
    await slotA.click();
    await waitPage(page, "tasks-page", "Wm inside N");
    await expect(page.locator("#tasks-comp-label")).toContainText("Slot A");
    await expect(page.locator(SWITCH_SESSION_BTN), "a spectator may switch sessions").toHaveCount(1);
    const log = await uiLog(page);
    expect(log.modals, "no confirmation of any kind for a spectator").toEqual([]);
    expect(membership(F.Wm.id, F.N.id), "spectating writes no row").toBeNull();
  });

  test("(f) a staff member who HOLDS A ROW on a two-session event where staff do NOT compete is a spectator there: no warning, no confirm, Switch Session offered — and it works", async ({ page }) => {
    // The own-row spectator on the session surfaces (participant-tasks.js's
    // Switch button, the picker's live warning, chooseTimeslot's confirm), each
    // keyed on `competing`. The button is not merely counted: it is pressed and
    // the switch lands, because a button offered and then refused would be the
    // v7.14.2 defect wearing this arm's assertion. Minted here: the arm writes a
    // slot onto the row, so a retry needs a fresh actor.
    const wn = await mintRowThenStaff("spc-wn", [F.N.id]);
    await bootPicker(page, wn.email);
    await expect(card(page, "comp-grid", F.N.id), "N is an OWN row for this actor").toBeVisible();
    await card(page, "comp-grid", F.N.id).click();
    expect(await settleOn(page, "timeslot-picker-page"), "no Enter confirm for an own-row spectator").toBe("page");
    await expect(page.locator("#timeslot-picker-content .ts-live-warning"), "no live warning either").toHaveCount(0);
    await page.locator(`#timeslot-picker-content .comp-card[data-ts-id="${F.N.slotA}"]`).click();
    expect(await settleOn(page, "tasks-page"), "no Join confirm").toBe("page");
    await expect(page.locator("#tasks-comp-label")).toContainText("Slot A");
    await expect(page.locator(SWITCH_SESSION_BTN), "Switch Session is offered to an own-row spectator").toHaveCount(1);
    let row = membership(wn.id, F.N.id);
    expect(row && row.timeslot_id, "the choice was written to the row they hold").toBe(F.N.slotA);

    // And it is a real control: switching lands, with no confirm, on the server too.
    await page.locator(SWITCH_SESSION_BTN).click();
    await waitPage(page, "timeslot-picker-page", "the session picker, reopened");
    await page.locator(`#timeslot-picker-content .comp-card[data-ts-id="${F.N.slotB}"]`).click();
    expect(await settleOn(page, "tasks-page"), "no confirm on the switch either").toBe("page");
    await expect(page.locator("#tasks-comp-label")).toContainText("Slot B");
    row = membership(wn.id, F.N.id);
    expect(row && row.timeslot_id, "the server let the spectator switch").toBe(F.N.slotB);
    expect((await uiLog(page)).modals, "no modal at any point").toEqual([]);
  });

  test("(f) a RELOAD inside the compete event still offers no 'Switch Session' to a competitor", async ({ page }) => {
    // Wr already chose Slot A through the API, so a sign-in auto-resumes them
    // straight into M's tasks page WITHOUT the picker ever rendering — the boot
    // path. The button must still be withheld: the server refuses the switch, so
    // offering it is a control that appears to work (v7.14.2).
    //
    // This arm was `test.fixme` at the first review round: `currentCompetitionRow()`
    // read `S.myCompetitions` only and boot's `enter` branch never filled it, so
    // `staffSpectatorIn(null)` read every staff member as a spectator and the
    // button rendered — pressed, it opened a picker with no warning and the
    // server answered 400. The fix has BOTH halves (boot's `enter` branch in
    // core/main.js sets `S.myCompetitions` on every branch; the resolver falls
    // back to the /api/me rows), and
    // this arm went green on that fix. Either half alone keeps it green, which
    // is why the dry-run arm below pins the boot write on its own.
    await loginViaApi(page, F.Wr.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitPage(page, "tasks-page", "Wr resumed into M");
    await expect(page.locator("#tasks-comp-label")).toContainText("Slot A");
    await expect(page.locator(SWITCH_SESSION_BTN), "no Switch Session on the boot path either").toHaveCount(0);
  });

  test("(f) a RELOAD inside a dry-run two-session event still offers Switch Session to an own-row spectator, and the session picker carries the dry-run badge", async ({ page }) => {
    // The other half of the boot path. `_isCurrentCompInternal` reads
    // `S.myCompetitions` DIRECTLY (no fallback), so the dry-run session badge is
    // what pins boot's `enter` branch writing the list — the Switch button alone
    // survives on `currentCompetitionRow`'s fallback. Minted here: the arm needs
    // a row with a chosen slot, written through the API before the sign-in.
    const wd = await mintRowThenStaff("spc-wd", [F.Nd.id]);
    {
      const c = await apiLogin(wd.email, PARTICIPANT_PASS);
      const s1 = await c.api.post("/api/select-competition", { headers: H(c.csrf), data: { competitionId: F.Nd.id } });
      expect(s1.ok(), `wd selects Nd: ${s1.status()} ${await s1.text()}`).toBeTruthy();
      const s2 = await c.api.post("/api/select-timeslot", { headers: H(c.csrf), data: { timeslotId: F.Nd.slotA } });
      expect(s2.ok(), `wd chooses slot A: ${s2.status()} ${await s2.text()}`).toBeTruthy();
      expect((await s2.json()).ok, "a spectator's choice needs no confirmation and commits").toBe(true);
      await c.api.dispose();
    }
    await loginViaApi(page, wd.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitPage(page, "tasks-page", "wd resumed into Nd");
    await expect(page.locator("#tasks-comp-label")).toContainText("Slot A");
    await expect(page.locator(SWITCH_SESSION_BTN), "an own-row spectator keeps Switch Session on the boot path").toHaveCount(1);
    await page.locator(SWITCH_SESSION_BTN).click();
    await waitPage(page, "timeslot-picker-page", "the session picker from the boot path");
    await expect(page.locator("#timeslot-picker-content .comp-card")).toHaveCount(2);
    await expect(page.locator("#timeslot-picker-content .ts-internal-badge"), "every session card carries the dry-run badge").toHaveCount(2);
    await expect(page.locator("#timeslot-picker-content .comp-card.internal-ts")).toHaveCount(2);
    await expect(page.locator("#timeslot-picker-content .ts-live-warning"), "…and no live warning for a spectator").toHaveCount(0);
    expect((await uiLog(page)).modals, "no modal at any point").toEqual([]);
  });
});

// ── (g) leaving via Events, and switching between two live events ───────────

test.describe("v8.12.0 — leaving a live event via Events", () => {

  test("(g) a competitor pressing Events inside a live event goes straight to the picker (plain navigation)", async ({ page }) => {
    await bootPicker(page, F.W.email);
    await card(page, "comp-grid", F.E.id).click();
    await expect(page.locator("#modal-title")).toHaveText("Enter Live Event");
    await page.locator("#modal-confirm-btn").click();
    await waitPage(page, "tasks-page", "W inside E");

    await page.locator("#nav-competitions").click();
    await waitPage(page, "competitions-page", "W back on the picker");
    expect((await uiLog(page)).modals, "Events asks nothing").toEqual(["Enter Live Event"]);
    expect(membership(F.W.id, F.E.id), "leaving the VIEW does not un-enrol").toBeTruthy();
  });

  test("(g) a competitor who left one live event and picks another they compete in meets 'Switch Event?'; a spectated event from the same state asks nothing", async ({ page }) => {
    // The sibling branch of `pickCompetition`: with `lastLiveCompetitionId` set
    // by the Leave, entering ANOTHER still-live event is a switch, and it is
    // governed by the same `staffSpectatorIn` read. Both halves in one page-life:
    // Wsw competes in E and E3, and spectates G.
    await bootPicker(page, F.Wsw.email);
    await card(page, "comp-grid", F.E.id).click();
    await expect(page.locator("#modal-title")).toHaveText("Enter Live Event");
    await page.locator("#modal-confirm-btn").click();
    await waitPage(page, "tasks-page", "Wsw inside E");
    await page.locator("#nav-competitions").click();
    await waitPage(page, "competitions-page", "Wsw back on the picker");

    await card(page, "comp-grid", F.E3.id).click();
    await expect(page.locator("#modal-title"), "entering a second live compete event after leaving one is a SWITCH").toHaveText("Switch Event?");
    await expect(page.locator("#modal-body")).toContainText(F.E.name);
    await expect(page.locator("#modal-body")).toContainText(F.E3.name);
    await expect(page.locator("#modal-confirm-btn")).toHaveText("Switch");
    await expect(page.locator("#modal-cancel-btn")).toHaveText("Go Back");
    await page.locator("#modal-confirm-btn").click();
    await waitPage(page, "tasks-page", "Wsw inside E3 after switching");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.E3.name);

    // Back out (a Leave again), then the CONTROL: from the same state a
    // spectated event raises neither Switch nor Enter.
    await page.locator("#nav-competitions").click();
    await waitPage(page, "competitions-page", "Wsw back on the picker again");
    const before = (await uiLog(page)).modals.slice();
    expect(before, "the two modals so far, in order (Events asks nothing)").toEqual(["Enter Live Event", "Switch Event?"]);
    await card(page, "comp-other-grid", F.G.id).click();
    expect(await settleOn(page, "tasks-page"), "a spectator is not asked to switch").toBe("page");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.G.name);
    expect((await uiLog(page)).modals, "no fifth modal for the spectated event").toEqual(before);
    expect(membership(F.Wsw.id, F.G.id), "spectating writes no row").toBeNull();
  });

  test("CONTROL: a spectator pressing Events inside a live event is not asked", async ({ page }) => {
    await bootPicker(page, F.W.email);
    await card(page, "comp-other-grid", F.G.id).click();
    await waitPage(page, "tasks-page", "W spectating G");
    await page.locator("#nav-competitions").click();
    await waitPage(page, "competitions-page", "W back on the picker");
    const log = await uiLog(page);
    expect(log.modals, "no modal on the way in or out for a spectator").toEqual([]);
  });

  test("(g) DECIDED: a staff member who leaves a SPECTATED live event and then picks one they COMPETE in meets 'Switch Event?' naming the spectated one", async ({ page }) => {
    // `handleCompetitionsNav`'s spectator branch skips the Leave confirm but
    // still records `S.lastLiveCompetitionId`, so the NEXT live event they hold
    // a competitor's row on is a SWITCH ("You were in G (still live)") rather
    // than a fresh entry — exactly what a participant meets, and the message's
    // auto-resume clause is true for a spectator too (select-competition writes
    // the marker for them). Pinned as the behaviour that IS, not the nicer one:
    // reversing it (clear the id on the spectator branch, so the pick reads
    // 'Enter Live Event') is a product decision that must re-point this arm.
    await bootPicker(page, F.Wsw.email);
    await card(page, "comp-other-grid", F.G.id).click();
    expect(await settleOn(page, "tasks-page"), "no confirm on the way into a spectated event").toBe("page");
    await page.locator("#nav-competitions").click();
    expect(await settleOn(page, "competitions-page"), "…nor on the way out").toBe("page");
    expect((await uiLog(page)).modals, "nothing asked so far").toEqual([]);

    await card(page, "comp-grid", F.E.id).click();
    await expect(page.locator("#modal-title"), "the competitor's next live event is a SWITCH from the spectated one").toHaveText("Switch Event?");
    await expect(page.locator("#modal-body")).toContainText(F.G.name);
    await expect(page.locator("#modal-body")).toContainText(F.E.name);
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    await expect(page.locator("#competitions-page"), "Go Back keeps them on the picker").toHaveClass(/active/);
    expect((await uiLog(page)).modals).toEqual(["Switch Event?"]);
  });
});

// ── (h) the join link ────────────────────────────────────────────────────────

test.describe("v8.12.0 — the join link tells a staff member what joining means", () => {

  test("(h) a pending join to a compete event asks 'Compete in this event?'; 'Not now' leaves W un-enrolled and clears the pending join", async ({ page }) => {
    const joinPosts = [];
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/competitions/join" && r.method() === "POST") joinPosts.push(r.url()); });
    await loginViaApi(page, F.W.email, PARTICIPANT_PASS);
    await deselect(page);
    await page.goto(`/join/${encodeURIComponent(F.E2.token)}`);

    await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 30_000 });
    await expect(page.locator("#modal-title")).toHaveText("Compete in this event?");
    await expect(page.locator("#modal-body")).toContainText(F.E2.name);
    await expect(page.locator("#modal-body")).toContainText("competitor");
    await expect(page.locator("#modal-confirm-btn")).toHaveText("Join and compete");
    await expect(page.locator("#modal-cancel-btn")).toHaveText("Not now");
    // The pending join was persisted on arrival — it must be GONE after Not now.
    expect(await stored(page), "the link visit stored the pending join").toBeTruthy();

    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    await expect.poll(() => stored(page), { message: "Not now purges the stored join" }).toBeNull();
    await expect(page.locator("#join-banner")).toBeHidden();
    await expect(page.locator("#reg-join-banner")).toBeHidden();
    expect(joinPosts, "no join request was ever sent").toEqual([]);
    expect(membership(F.W.id, F.E2.id), "W is not enrolled in E2").toBeNull();

    // And the boot carried on to the picker, where E2 is somebody else's event.
    await waitPage(page, "competitions-page", "W after declining");
    await expect(card(page, "comp-other-grid", F.E2.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.E2.id)).toHaveCount(0);
  });

  test("(h) 'Join and compete' enrols the staff member and lands them in the event", async ({ page }) => {
    const joinResponses = [];
    page.on("response", r => { if (new URL(r.url()).pathname === "/api/competitions/join") joinResponses.push(r.status()); });
    await loginViaApi(page, F.Wj.email, PARTICIPANT_PASS);
    await page.goto(`/join/${encodeURIComponent(F.E2.token)}`);
    await expect(page.locator("#modal-title")).toHaveText("Compete in this event?", { timeout: 30_000 });
    await page.locator("#modal-confirm-btn").click();

    await waitPage(page, "tasks-page", "Wj inside E2");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.E2.name);
    expect(joinResponses, "exactly one join, accepted").toEqual([200]);
    const row = membership(F.Wj.id, F.E2.id);
    expect(row, "the row was written").toBeTruthy();
    expect(row.assigned_by).toBe("self_enroll");
    await expect.poll(() => stored(page), { message: "a successful join spends the stored token" }).toBeNull();
    // And on the wire they now compete there.
    const rows = await (await page.request.get("/api/my-competitions")).json();
    const e2 = rows.find(c => c.id === F.E2.id);
    expect(e2 && e2.own && e2.competing, "E2 is now an own, competing row").toBe(true);
  });

  test("(h) a join link to an event where staff do NOT compete admits the staff member as a spectator, says so, and asks nothing", async ({ page }) => {
    await loginViaApi(page, F.W.email, PARTICIPANT_PASS);
    await deselect(page);
    await page.goto(`/join/${encodeURIComponent(F.G2.token)}`);
    await waitPage(page, "tasks-page", "W spectating G2 via its link");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.G2.name);
    const log = await uiLog(page);
    expect(log.modals, "no 'Compete in this event?' on a non-compete event").toEqual([]);
    // ONE toast, both properties on IT: the sentence and the class must belong
    // to the same element, or an error toast carrying the sentence beside some
    // unrelated info toast would pass.
    const t = log.toasts.find(x => x.text.includes("You can enter this event as staff"));
    expect(t, `the spectator toast fired (toasts seen: ${JSON.stringify(log.toasts)})`).toBeTruthy();
    expect(t.text, "…and says they were not enrolled").toContain("you have not been enrolled");
    expect(t.cls, "…as an INFO toast, not an error").toMatch(/\btoast-info\b/);
    expect(t.cls).not.toMatch(/toast-error/);
    expect(membership(F.W.id, F.G2.id), "no row for a spectator").toBeNull();
  });

  test("CONTROL: an ordinary participant on the compete event's link is asked nothing and is enrolled", async ({ page }) => {
    // The competitor confirm is for STAFF, whose usual reading of a QR is a
    // spectator's shortcut; a participant scanning it is doing the ordinary thing
    // and must not be asked a question about a distinction that does not apply.
    await loginViaApi(page, F.Pj.email, PARTICIPANT_PASS);
    await page.goto(`/join/${encodeURIComponent(F.E2.token)}`);
    await waitPage(page, "tasks-page", "Pj inside E2");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.E2.name);
    const log = await uiLog(page);
    expect(log.modals, "no modal for a participant").toEqual([]);
    const row = membership(F.Pj.id, F.E2.id);
    expect(row && row.assigned_by, "enrolled through the link").toBe("self_enroll");
  });

  // ── the LOGIN-CARD door: the ordinary QR flow on a signed-out phone ────────
  //
  // The arms above sign in through the API and then visit the link, which is
  // boot's `_joinFromUrl` branch (core/main.js). A staff member scanning the QR
  // on a phone that is signed OUT lands on the sign-up form, presses Sign In,
  // and the pending join is consumed by `doLogin` (features/auth.js) — a second
  // door into `joinViaPendingToken`, and the one a real QR scan takes. A build
  // that suppressed the staff confirm on THAT door alone (M10) kept every arm
  // above green.

  test("(h) at the LOGIN CARD a staff member joining a compete event is asked 'Compete in this event?'; 'Not now' writes nothing and purges the stored join", async ({ page }) => {
    const joinPosts = [];
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/competitions/join" && r.method() === "POST") joinPosts.push(r.url()); });
    await page.goto(`/join/${encodeURIComponent(F.E2.token)}`);
    await signInAtCard(page, F.Wl.email, F.E2.name);

    await expect(page.locator("#modal-title")).toHaveText("Compete in this event?", { timeout: 30_000 });
    await expect(page.locator("#modal-body")).toContainText(F.E2.name);
    await expect(page.locator("#modal-confirm-btn")).toHaveText("Join and compete");
    expect(await stored(page), "the link visit stored the pending join").toBeTruthy();
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    await expect.poll(() => stored(page), { message: "Not now purges the stored join" }).toBeNull();
    expect(joinPosts, "no join request was ever sent").toEqual([]);
    expect(membership(F.Wl.id, F.E2.id), "Wl is not enrolled in E2").toBeNull();
    // Wl holds no rows, so the sign-in lands on the picker with E2 below.
    await waitPage(page, "competitions-page", "Wl after declining at the card");
    await expect(card(page, "comp-other-grid", F.E2.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.E2.id)).toHaveCount(0);
    expect((await uiLog(page)).modals, "exactly the one confirm").toEqual(["Compete in this event?"]);
  });

  test("(h) at the LOGIN CARD a non-compete event's link admits a staff member as a spectator, says so, and asks nothing", async ({ page }) => {
    await page.goto(`/join/${encodeURIComponent(F.G2.token)}`);
    await signInAtCard(page, F.Wl2.email, F.G2.name);
    await waitPage(page, "tasks-page", "Wl2 spectating G2 from the card");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.G2.name);
    const log = await uiLog(page);
    expect(log.modals, "no 'Compete in this event?' on a non-compete event").toEqual([]);
    const t = log.toasts.find(x => x.text.includes("You can enter this event as staff"));
    expect(t, `the spectator toast fired (toasts seen: ${JSON.stringify(log.toasts)})`).toBeTruthy();
    expect(t.cls).toMatch(/\btoast-info\b/);
    expect(membership(F.Wl2.id, F.G2.id), "no row for a spectator").toBeNull();
  });

  test("CONTROL: at the LOGIN CARD an ordinary participant on the compete event's link is asked nothing and is enrolled", async ({ page }) => {
    const pl = await makeParticipant(sa, saCsrf, "spc-pl");
    await page.goto(`/join/${encodeURIComponent(F.E2.token)}`);
    await signInAtCard(page, pl.email, F.E2.name);
    await waitPage(page, "tasks-page", "Pl inside E2 from the card");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.E2.name);
    expect((await uiLog(page)).modals, "no modal for a participant").toEqual([]);
    const row = membership(pl.id, F.E2.id);
    expect(row && row.assigned_by, "enrolled through the link").toBe("self_enroll");
    await expect.poll(() => stored(page), { message: "a successful join spends the stored token" }).toBeNull();
  });

  // ── the typed EVENT CODE: the picker's third way in ─────────────────────────
  //
  // `joinWithCode` (features/self-enroll.js) exchanges the printed code for the
  // link token, previews it, and hands the SAME `joinViaPendingToken` the link
  // uses — so the compete confirm and the spectator answer both reach this door.
  // What is this door's own is what it does with the answer afterwards.

  test("(h) a staff member typing a COMPETE event's code on the picker is asked 'Compete in this event?'; 'Not now' writes nothing", async ({ page }) => {
    const joinPosts = [];
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/competitions/join" && r.method() === "POST") joinPosts.push(r.url()); });
    await bootPicker(page, F.Wc.email);
    await typeJoinCode(page, F.E2.code);
    await expect(page.locator("#modal-title")).toHaveText("Compete in this event?", { timeout: 30_000 });
    await expect(page.locator("#modal-body")).toContainText(F.E2.name);
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/);
    expect(joinPosts, "no join request was ever sent").toEqual([]);
    expect(membership(F.Wc.id, F.E2.id), "Wc is not enrolled in E2").toBeNull();
    await expect(page.locator("#competitions-page"), "still on the picker").toHaveClass(/active/);
    expect(await stored(page), "a typed code stores no pending join to purge").toBeNull();
  });

  test("(h) a staff member typing a NON-compete event's code is admitted as a spectator with the info toast, no modal, and no row", async ({ page }) => {
    await bootPicker(page, F.W.email);
    await typeJoinCode(page, F.G2.code);
    await waitPage(page, "tasks-page", "W spectating G2 via its code");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.G2.name);
    const log = await uiLog(page);
    expect(log.modals, "no 'Compete in this event?' on a non-compete event").toEqual([]);
    const t = log.toasts.find(x => x.text.includes("You can enter this event as staff"));
    expect(t, `the spectator toast fired (toasts seen: ${JSON.stringify(log.toasts)})`).toBeTruthy();
    expect(t.cls).toMatch(/\btoast-info\b/);
    expect(membership(F.W.id, F.G2.id), "no row for a spectator").toBeNull();
  });

  test("(h) the typed code must not ALSO toast 'Joined …' for a staff member the same answer says was not enrolled", async ({ page }) => {
    // `joinViaPendingToken` toasts "…you have not been enrolled" (info) for a
    // spectator answer and then RETURNS the competition id (the server's
    // spectator branch carries it), so `joinWithCode` unconditionally toasts
    // `Joined <name>.` (success) beside it — two toasts contradicting each other
    // (features/self-enroll.js joinWithCode's success toast; joinViaPendingToken's
    // `return d.competitionId||null`; routes/self-enroll.js's spectator answer).
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `joinWithCode` reads `S._lastJoinSpectator` and toasts no 'Joined' for a
    // spectator.
    await bootPicker(page, F.W.email);
    await typeJoinCode(page, F.G2.code);
    await waitPage(page, "tasks-page", "W spectating G2 via its code");
    const log = await uiLog(page);
    expect(log.toasts.find(x => x.text.includes("You can enter this event as staff")), "the spectator toast fired").toBeTruthy();
    expect(log.toasts.filter(x => /^Joined /.test(x.text)), "no 'Joined' toast for somebody who was not enrolled").toEqual([]);
  });

  test("CONTROL: an ordinary participant typing the compete event's code gets 'Joined', a row, and no modal", async ({ page }) => {
    const pc = await makeParticipant(sa, saCsrf, "spc-pc");
    await loginViaApi(page, pc.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitPage(page, "competitions-page", "Pc's (empty) picker");
    await page.locator("#comp-grid .comp-card, #comp-grid .grid-empty").first().waitFor({ state: "visible", timeout: 30_000 });
    await typeJoinCode(page, F.E2.code);
    await waitPage(page, "tasks-page", "Pc inside E2 via its code");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.E2.name);
    const log = await uiLog(page);
    expect(log.modals, "no modal for a participant").toEqual([]);
    expect(log.toasts.find(x => x.text === `Joined ${F.E2.name}.`), `the 'Joined' toast (toasts seen: ${JSON.stringify(log.toasts)})`).toBeTruthy();
    const row = membership(pc.id, F.E2.id);
    expect(row && row.assigned_by, "enrolled through the code").toBe("self_enroll");
  });

  // ── the AUTHOR on the join link ─────────────────────────────────────────────

  /** The author, in participant view, visits Ea's link and accepts the confirm. */
  async function authorAcceptsJoin(page) {
    await loginViaApi(page, F.author.email, PARTICIPANT_PASS);
    await toParticipantView(page);
    await page.goto(`/join/${encodeURIComponent(F.Ea.token)}`);
    await expect(page.locator("#modal-title")).toHaveText("Compete in this event?", { timeout: 30_000 });
    await expect(page.locator("#modal-body")).toContainText(F.Ea.name);
    expect(await stored(page), "the link visit stored the pending join").toBeTruthy();
    await page.locator("#modal-confirm-btn").click();
  }

  test("(h) the AUTHOR of a challenge in a compete event is asked to compete, accepts, and is REFUSED by the server naming the challenge — no row", async ({ page }) => {
    // The confirm is CLIENT-only and runs before the server's author door
    // (routes/self-enroll.js: 409 author_competes), so an author is asked a
    // question whose answer the server is certain to refuse. Reachable only by
    // an admin-tier account (authors are admins), which is why it is recorded
    // here rather than escalated; what IS pinned is that the refusal is spoken,
    // names the challenge, and writes nothing.
    await authorAcceptsJoin(page);
    await expect.poll(async () => (await uiLog(page)).toasts.some(t => t.cls.includes("toast-error") && t.text.includes(F.sealedTitle)),
      { timeout: 15_000, message: "the refusal toast names the sealed challenge" }).toBe(true);
    expect(membership(F.author.id, F.Ea.id), "the author holds no row on Ea").toBeNull();
    await waitPage(page, "competitions-page", "the author after the refusal");
    await expect(card(page, "comp-grid", F.Ea.id)).toHaveCount(0);
    await expect(card(page, "comp-other-grid", F.Ea.id), "Ea is listed as an event they may only spectate").toBeVisible();
  });

  test("(h) the author-competes refusal is PERMANENT while the challenge is assigned, so it must purge the stored join like a 404 does", async ({ page }) => {
    // `joinViaPendingToken`'s `!r.ok` branch returns before `clearStoredJoin`,
    // which runs only on success — right for a 429 or a 5xx (v7.22.8: a
    // transient must not cost the recovery), wrong for `author_competes`, which
    // is as final as a 404 while the challenge is assigned. The token lingers:
    // for a role-participant staff author boot's rehydration re-raises the
    // confirm on every page load until they press Not now; for an admin-tier
    // author it lingers until the preview 404s (features/self-enroll.js
    // joinViaPendingToken's `!r.ok` branch vs its `clearStoredJoin(tok)`).
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the `!r.ok` branch purges the stored join on `staff_compete_author_competes`.
    await authorAcceptsJoin(page);
    await expect.poll(async () => (await uiLog(page)).toasts.some(t => t.cls.includes("toast-error") && t.text.includes(F.sealedTitle)),
      { timeout: 15_000, message: "the refusal toast names the sealed challenge" }).toBe(true);
    await expect.poll(() => stored(page), { message: "a permanent refusal purges the stored join" }).toBeNull();
  });
});

// ── (i) the participant-view toggle lands in the sole event ──────────────────

test.describe("v8.12.0 — switching to participant view lands an admin in their sole event", () => {

  const toggleResponse = (page) => page.waitForResponse(r => new URL(r.url()).pathname === "/api/toggle-admin-view" && r.request().method() === "POST");

  test("(i) an admin enrolled AFTER signing in lands on their sole event's tasks page — the toggle's OWN landing, asserted on the wire", async ({ page }) => {
    // Enrolled BEFORE the sign-in, the password door's own sole-event landing
    // already puts the event on the session and the toggle merely carries the
    // pointer — a build with the toggle's landing branch deleted stays green.
    // Enrolled AFTER, the session carries nothing, and the toggle is the only
    // thing that can have decided `competitionId`. Minted here: a retry must
    // start from an un-enrolled admin. The organiser who enrols themselves
    // mid-session and then toggles is the feature's primary use case.
    const ax = await makeParticipant(sa, saCsrf, "spc-ax");
    await promote(ax, "admin");
    await loginViaApi(page, ax.email, PARTICIPANT_PASS);
    const meBefore = await (await page.request.get("/api/me")).json();
    expect(meBefore.competitionId || null, "the sign-in landed nowhere: no rows yet").toBeNull();
    await enrol(sa, saCsrf, F.EI1.id, [ax.id]);

    await page.goto("/");
    await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30_000 });
    const resp = toggleResponse(page);
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    const body = await (await resp).json();
    expect(body.competitionId, "the toggle's response names the event it landed on").toBe(F.EI1.id);
    await waitPage(page, "tasks-page", "the admin after toggling down");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.EI1.name);
    await expect(page.locator("#competitions-page")).not.toHaveClass(/active/);
  });

  test("(i) a pointer carried from sign-in wins across the toggle: an admin enrolled BEFORE signing in lands in that event", async ({ page }) => {
    // What this arm proves is the CLIENT routing off the toggle's `competitionId`
    // plus the password door's landing for an admin tier; the server's toggle
    // landing branch is the arm above (and staff-compete-scoring.api.spec.js).
    await loginViaApi(page, F.A1.email, PARTICIPANT_PASS);
    const meBefore = await (await page.request.get("/api/me")).json();
    expect(meBefore.competitionId, "the sign-in already landed A1 in EI1").toBe(F.EI1.id);
    await page.goto("/");
    await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30_000 });
    const resp = toggleResponse(page);
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    expect((await (await resp).json()).competitionId, "the carried pointer rides the response").toBe(F.EI1.id);
    await waitPage(page, "tasks-page", "A1 after toggling down");
    await expect(page.locator("#tasks-comp-label")).toContainText(F.EI1.name);
    await expect(page.locator("#competitions-page")).not.toHaveClass(/active/);
  });

  test("CONTROL: an admin enrolled in two events lands on the picker with both", async ({ page }) => {
    // Without this, "lands in the event" is satisfied by a build that always
    // routes into the first row it finds.
    await loginViaApi(page, F.A2.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30_000 });
    const resp = toggleResponse(page);
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    expect((await (await resp).json()).competitionId || null, "two events: the toggle lands nowhere").toBeNull();
    await waitPage(page, "competitions-page", "A2 after toggling down");
    await expect(card(page, "comp-grid", F.EI1.id)).toBeVisible();
    await expect(card(page, "comp-grid", F.EI2.id)).toBeVisible();
    await expect(page.locator("#tasks-page")).not.toHaveClass(/active/);
  });
});

// A REPORTED BUG (17 Nov 2026): an admin in Participant View who opened a
// multi-session event that had already ENDED could not switch between its
// sessions to see their challenges and boards: the picker drew every session as
// an inert "Ended" card and select-timeslot refused an ended session for
// everyone. Staff looking at an event they do not compete in may now open any
// session, ended ones included; a participant's ended picker stays read-only.
test.describe("an ended multi-session event in Participant View", () => {
  /** @type {any} */ let E;
  test.beforeAll(async () => {
    E = await makeCompetition(sa, saCsrf, "spc-ended-multi");
    E.slotA = await addSession(E.id, "Slot A", -2 * 60_000);
    E.slotB = await addSession(E.id, "Slot B", -60_000);
    await enrol(sa, saCsrf, E.id, [F.P.id]);
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
      db.prepare("UPDATE competition_timeslots SET start_time=?, duration_minutes=30 WHERE id=?").run(at(3), E.slotA);
      db.prepare("UPDATE competition_timeslots SET start_time=?, duration_minutes=30 WHERE id=?").run(at(2), E.slotB);
    } finally { db.close(); }
  });

  // Ended events are listed under the "All" filter only.
  const showAll = async (page) => {
    const all = page.locator('[data-action="set-comp-filter"][data-value="all"], [data-action="set-comp-other-filter"][data-value="all"]');
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) await all.nth(i).click();
  };

  test("an admin opens one ended session, then switches to the other", async ({ page }) => {
    await bootPickerViaToggle(page, F.A2.email);
    await showAll(page);
    await card(page, "comp-other-grid", E.id).click();
    await waitPage(page, "timeslot-picker-page", "the ended event's session picker");
    for (const [slot, name] of [[E.slotA, "Slot A"], [E.slotB, "Slot B"]]) {
      if (slot === E.slotB) {
        await page.locator(SWITCH_SESSION_BTN).click();
        await waitPage(page, "timeslot-picker-page", "back to the session picker");
      }
      const c = page.locator(`#timeslot-picker-content .comp-card[data-ts-id="${slot}"][data-action="choose-timeslot"]`);
      await expect(c, `${name}, ended, can be opened`).toBeVisible();
      await c.locator(".card-open").click();
      await waitPage(page, "tasks-page", `inside ${name}`);
      await expect(page.locator("#tasks-comp-label")).toContainText(name);
      // The event's own "Event Ended" note comes up on entry; it is closed as a person would.
      // (It comes up a moment after the page, and once per event per tab.)
      // Its button opens the session's board; the Challenges tab comes back from there.
      if (await page.locator("#modal-overlay").waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
        await page.locator("#modal-confirm-btn").click();
        await waitPage(page, "leaderboard-page", `${name}'s board`);
        await page.locator("#nav-challenges").click();
        await waitPage(page, "tasks-page", `back in ${name}`);
      }
    }
    expect(membership(F.A2.id, E.id), "looking writes no row").toBeNull();
  });

  test("CONTROL: a participant's picker for the ended event stays read-only", async ({ page }) => {
    await bootPicker(page, F.P.email);
    await showAll(page);
    await card(page, "comp-grid", E.id).click();
    await waitPage(page, "timeslot-picker-page", "P's ended session picker");
    await expect(page.locator("#timeslot-picker-content .ts-all-ended-note")).toBeVisible();
    await expect(page.locator('#timeslot-picker-content [data-action="choose-timeslot"]')).toHaveCount(0);
  });
});
