// @ts-check
//
// v8.12.0 — STAFF CAN COMPETE: THE ROW-WRITERS.
//
// Operator decision 1: "staff assignable ONLY to events with the attribute set".
// A `competition_users` row for a staff-tagged user may be written by SEVEN
// different paths, and the rule has to hold at every one of them or it is a
// convention rather than a rule (the v8.3.9 "a rule implemented at one door of
// several" class). This file drives the first six against real events; the
// seventh, the invitation claim at sign-in, is driven by
// tests/invitation-claim.api.spec.js:
//
//   1. POST /api/admin/competitions/assign — per (user, event) PAIR: a staff-
//      tagged user into a switch-OFF event is `skippedStaff`; into a switch-ON
//      event they get a row, unless they are an admin/superadmin being enrolled
//      by a NON-superadmin who is not themselves (`skippedPrivileged` — the
//      admin/superadmin ROLE, never an event admin), or they AUTHORED a
//      challenge assigned to the event (`skippedAuthors`, one entry per (user,
//      event) pair, naming the challenges THAT event holds). Blocked AND
//      unapproved are decided BEFORE the staff check, and for the one pair both
//      rules claim (a peer admin who authored) privileged answers before author.
//   2. POST /api/competitions/join — the self-enroll link: a staff spectator on a
//      switch-OFF event is admitted with NO row (`staffSpectator:true`) and can
//      still select the event; on a switch-ON event the row is written; an author
//      is refused 409 `staff_compete_author_competes` with the challenges named.
//   3. The deferred consume at first sign-in (`pending_self_enroll_comp_id`) —
//      same rule, marker cleared either way. Only the SPECTATOR and its controls
//      are driven: the marker exists only on an account a join-link registration
//      has just created, which has authored nothing, so the consume has no
//      author fixture (the LinkedIn `joinToken` fold that once put a marker on an
//      EXISTING account, and drove an author arm here, is gone).
//   4. Group sync (`reconcileCompetitionMembership`) — a staff-tagged member of a
//      bound group gets a row only on a switch-ON event, never as an author.
//   5. POST /api/admin/invitations, existing-account path — `skippedStaff` for a
//      spectator, `skippedAuthors` (a NUMBER on this route) for an author,
//      `skippedPrivileged` for a peer admin enrolled by a non-superadmin (never
//      an event admin), blocked/unapproved decided BEFORE the staff check, and
//      a skipped address never rides `alreadyAssigned`. Plus the round-3 GROUP
//      gate: a `newGroups` NAME that resolves to an existing group bound to an
//      event the actor competes in is refused BEFORE the create loop writes
//      anything — the `groupIds` half is staff-compete-lock's; this is the
//      only lock on the `newGroups` half.
//   6. The participant import's `_rehydrateMemberships` — `skipped_memberships`
//      reasons `staff_not_competing` / `author_competes` / `actor_competes`, the
//      tag read straight off `user_tags` so an account that becomes staff IN
//      the same import is skipped too.
//   7. The invitation claim at an existing account's emailed-code sign-in
//      (`lib/invitation-claim.js` `claimInvitationsForAccount`, which replaced
//      the LinkedIn claim in server.js) — same rule, spectator and author arms,
//      in tests/invitation-claim.api.spec.js.
//
// Plus the two superadmin IMPORTS as COMPETITOR doors (skip-and-report): the
// participant import skips a row into an event the acting superadmin competes in
// (`actor_competes`, never their OWN row), and the tasks import skips an overwrite
// of a challenge held by an event the importer competes in (`competitor_skipped`
// — the AUTHOR of a sealed challenge, since the seal already skips a non-author).
//
// ── WHY EVERY POSITIVE HAS A CONTROL ──────────────────────────────────────────
//
// "The staff member got no row" is equally satisfied by a build that writes no
// rows at all, and "skippedStaff is 1" by a build that skips everybody. So every
// arm carries the twin that must still WORK: an ordinary participant through the
// same door, or the same staff member through the same door into a switch-ON
// event. Where a leak matters the assertion is made BY VALUE over the database
// (`competition_users`), not by reading a counter back off the response.
//
// ── FIXTURE TRAPS MET WHILE WRITING THIS ──────────────────────────────────────
//
//  • "staff" for the ROW-WRITERS is the `staff` TAG only (`isStaff`), where
//    "staff" for SCORING is the tag OR the `event_admin` role. An event admin is
//    therefore enrollable into a switch-OFF event (DESIGN: "event admins may
//    legitimately be enrolled on a non-compete event") — pinned below at the
//    inline assign door AND at a `staffRowRefusal` door (the join link), so a
//    reader who "tightens" either writer to the scoring definition meets a red
//    test rather than a silently narrower product.
//  • Promoting a participant to admin/superadmin AUTO-TAGS `staff`, so an admin
//    fixture is a staff fixture without a tag call. The built-in superadmin has
//    no users row and can never be a competitor, author or target — every actor
//    that must be enrollable or must author a sealed challenge is USER-BACKED.
//  • ORDER MATTERS on the assign door: an admin who enrols THEMSELVES into a
//    switch-ON event becomes a COMPETITOR there and is refused every later write
//    to that event (403 competitor_cannot_edit) — so "enrol a colleague" must be
//    driven BEFORE "enrol yourself" on the same event, or use a second event.
//  • A switch-ON event admits only SEALED challenges, and sealing needs a
//    user-backed author (`sealAtCreateDenied` refuses the built-in superadmin).
//  • POST /api/admin/invitations for an EXISTING account never creates an
//    invitation row — it enrols directly. So a live invitation reaches an
//    existing account's sign-in only when it was stored BEFORE the account
//    existed (or, while approval is on, for a held sign-up whose inviter may not
//    approve), and the claim's arms plant that row and sign in with an emailed
//    code (tests/invitation-claim.api.spec.js). The LinkedIn sign-in and its
//    `/api/test/linkedin-simulate` hook, through which this file once drove the
//    claim and its admin-role author, are gone.
//  • The import OVERWRITE path deletes and re-inserts `user_tags` from the
//    payload, so a v2 row for a staff account must carry `tags:["staff"]` or the
//    import itself un-staffs the account and the row is written for the wrong
//    reason. The same statement is why `_rehydrateMemberships` reads the tag off
//    the TABLE rather than through the 2 s `isStaff` cache — and why the arm
//    pinning that warms the cache deliberately (through the assign door, which
//    reads `isStaff(uid)`) immediately before the import: with a cold cache both
//    implementations read the table and agree.
//  • "The AUTHOR of a sealed challenge held by E, who competes in E" is
//    UNREACHABLE through EVERY door, the switch included: the toggle-on door
//    refuses `staff_compete_enrolled_authors` (round 3 closed the gap this
//    fixture used to take — enrol on an upcoming switch-OFF event, promote,
//    author + assign, flip the switch). So the tasks-import arm builds the state
//    by a hand SQL write, asserts the switch's refusal AND its `participants[]`
//    shape as its PRECONDITION, and busts the 1 s competition cache with a
//    no-op rename PUT rather than a sleep. `competitor_skipped` is therefore
//    defence in depth, and the arm says so.
//  • A held row is a MEMBERSHIP whatever the tag says: the join door reads
//    `competition_users` BEFORE `staffRowRefusal` (round 3), so a staff-tagged
//    user who was enrolled before the tag is answered `alreadyMember:true`. The
//    assign, invitation and import doors did NOT read membership first and
//    reported such a row as a staff skip — three arms below pin what they
//    answer now (D2 in the product-defect list; fixed in the same release).
//  • The VNC listener on this box is port 5900, and global-setup pre-flights
//    every spawner offset (100..195) against the base — so NO base from 5710
//    to 5800 is usable while VNC holds 5900 (5710+190, 5740+160, …, 5800+100
//    each collide with one offset). The mutations below ran on 5706 and 8400.
//
// ── PRODUCT DEFECTS FOUND WHILE WRITING THIS (each was a `test.fixme`, seen ──
// ── RED against the first draft, and FIXED in the same release — the arms hold)
//
//  D1  routes/competitions.js — turning the switch ON busted caches but never
//      called `reconcileCompetitionMembership`, so a staff-tagged member of an
//      already-bound group was not enrolled until an unrelated group trigger.
//      The post-commit block reconciles on the ON direction now, fire-and-
//      forget like the revive path.
//  D2  routes/participants.js (assign), routes/invitations.js (existing
//      account), server.js `_rehydrateMemberships` — the staff skip ran before
//      any membership read, so a held row was reported `skippedStaff` /
//      `staff_not_competing` and the idempotent path (direct-assign promotion,
//      `alreadyAssigned`, the INSERT OR IGNORE no-op) was skipped. All three
//      read the held row first now. Three arms.
//  D3  routes/invitations.js — `staffRowRefusal` (author) was asked BEFORE the
//      privileged-peer test, where the assign door asks privileged first, so a
//      regular admin enrolling a peer-admin AUTHOR heard two different reasons
//      on the two doors. The invitation loop is spectator → privileged → author
//      now, and the assign order is pinned live as the reference.
//  DECIDED (19 Sep 2026, operator): the invitation claim at sign-in (then the
//      LinkedIn claim in server.js, now an emailed-code redeem's
//      `lib/invitation-claim.js`) applies no privileged rule, so an invitation
//      minted by a REGULAR admin and claimed by an admin-role account enrols that
//      admin where the direct path refuses the pair as `skippedPrivileged`. The
//      claim is the account enrolling ITSELF — the one case the peer rule exempts
//      at every door — so it is pinned as the intended behaviour, with the direct
//      path as the contrast, in tests/invitation-claim.api.spec.js.
//  • The auto-end trap does not bite here — nobody submits — but every event is
//    a tournament with no challenge solved, so nothing can end underneath.
//
// ── VERIFIED MUTATIONS (each killed by the named arm and only that arm) ───────
//
//  M1  routes/participants.js: `skippedStaff` counted per USER (a Set keyed on
//      uid) → "one user, two OFF events: counted per PAIR" (skippedStaff 1 ≠ 2).
//  M2  (retired with the LinkedIn doors) lib/self-enroll.js
//      `_consumePendingSelfEnroll` + the server.js LinkedIn claim: only
//      `=== "spectator"` treated as a refusal → the two author arms of "the
//      AUTHOR at the two remaining doors", which went with LinkedIn. The claim's
//      author arm is now in tests/invitation-claim.api.spec.js; the consume has
//      none (item 3 above).
//  M3  server.js `_rehydrateMemberships`: `_staffNow` → `isStaff(userId)` →
//      "tagged staff IN THE SAME IMPORT" (the cache says untagged, F row lands).
//  M4a routes/invitations.js: `else if (!_skippedThisRow)` → bare `else` →
//      "…never rides `alreadyAssigned`" (the staff address is listed).
//  M4b routes/invitations.js: the `skippedPrivileged` branch removed → "a peer
//      admin invited by a regular admin" (row written, counter 0).
//  M5  server.js `_rehydrateMemberships`: the `userId !== _actorUid` clause
//      dropped → "the actor's OWN row is not skipped" (actor_competes on self).
//  M6  server.js tasks import: the `_competitorEventsForTask` line removed →
//      "the AUTHOR of a sealed challenge held by an event the importer competes
//      in is skipped" (overwritten 1, competitor_skipped 0).
//  M7  lib/self-enroll.js `staffRowRefusal`: `isStaff(user.id) || role ===
//      "event_admin"` → "an untagged event admin joins a switch-OFF link"
//      (staffSpectator:true, no row).
//  M8  routes/self-enroll.js: the `if (!_hasRow)` guard removed (the spectator
//      branch runs for a member too) → "a staff-tagged user who ALREADY holds a
//      row … scans its link" (`alreadyMember` false).
//  M9  routes/participants.js + routes/invitations.js: the privileged rule
//      widened to `role !== "participant"` → the event-admin CONTROL in each
//      privileged test (skippedPrivileged 1, no row) — exactly those two.
//  M10 routes/participants.js: `skippedAuthors` pushed once per USER (`if
//      (!skippedAuthors.some(a => a.userId === uid))`) → the two-event pair
//      request in "the AUTHOR of a challenge assigned to a switch-ON event…"
//      (one entry where two are owed); every single-event request survives it.
//  M11 routes/invitations.js: the staff check moved ABOVE the blocked/
//      unapproved checks → "a BLOCKED or UNAPPROVED staff-tagged account
//      invited…" (switch-OFF: skippedStaff 1, skippedBlocked 0).
//  M12a routes/invitations.js: the `newGroups` competitor pre-loop deleted →
//      "round 3 (b): … through a newGroups NAME" (200, the invitee enrolled on
//      the actor's own board through the bound group).
//  M12b routes/invitations.js: the check moved INTO the create loop, after
//      `findGroupByName` → the same arm, on "the FIRST name was not created":
//      the refusal still answers 403 but the brand-new group already exists.
//  M13 routes/participants.js: the staff check moved ABOVE the blocked/
//      unapproved checks → "a BLOCKED or UNAPPROVED staff user is reported as a
//      lifecycle skip…" (switch-OFF: skippedStaff 1, skippedBlocked 0).
//  M14 routes/participants.js: the author check hoisted ABOVE the privileged
//      check on the assign door → exactly the LIVE precedence arm ("a peer admin
//      who AUTHORED…: the privileged rule answers before the author rule"); M9
//      and M10 touch the predicate and the push, not the ORDER, which is why
//      this row exists.
//  Each of M8–M14 was run against the whole file and killed only the arm named.
//  ROUND-3 arms (each run with `-g` against the named test on port base 7400,
//  the fixed tree restored from a snapshot and cmp-verified after each):
//  M15 routes/invitations.js: the `_privTargetGrp` gate on the group-apply loop
//      dropped → exactly the skippedPrivilegedGroups arm.
//  M16 server.js `_rehydrateGroups`: the `_competitorGroupDenied` skip dropped
//      → exactly the "OTHER import doors" arm (its group half).
//  M17 server.js `_rehydrateAbsences`: the actor_competes skip dropped → the
//      same arm (its absence half).
//  M18 server.js `_rehydrateMemberships`: `_ownCompete` forced false (the
//      importer's own row takes the file's login_time) → the same arm (its
//      anchor half).
//  M19 routes/export-import.js `_hintHidden` forced false → exactly the export
//      arm ("…with its hint WITHHELD"); …`!!t0.hint &&` dropped (a marker on an
//      empty hint) → the same arm on its hint-less control.
//  M20 server.js tasks import: the `hint_withheld && conflict && overwrite`
//      branch dropped (the marker wipes the hint) → exactly the export arm on
//      "the stored hint SURVIVED an overwrite".
//  M21 (round 4) routes/participants.js assign door: `&& !_held` dropped from
//      the compete-event skips (a held row asked the peer-admin and author
//      rules again) → exactly "a peer admin who ALREADY holds a row on a
//      compete event, re-assigned by a REGULAR admin, is a MEMBER" (its no-row
//      CONTROL and the precedence arm beside it stay green).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, pngDataUri } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, grantEventAdmin, eventCopyOf, withLegacySharedAssign } = require("./event-admin-helpers");

// better-sqlite3 is opened INSIDE the callback, never at module scope: the
// per-file recycle recreates the database in a `beforeAll`, so a handle taken
// at require time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

/** A WRITING handle, for the one state no API door can reach any more (see the tasks-import test). */
function withDbRW(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

/** BY VALUE, off the table itself — a cache cannot lie about this. */
function hasRow(compId, userId) {
  return !!withDb(db => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));
}

/** The deferred-enrolment marker, off the row itself. */
function pendingMarker(userId) {
  return withDb(db => db.prepare("SELECT pending_self_enroll_comp_id AS m FROM users WHERE id=?").get(userId))?.m ?? null;
}

/** The admin Participants row for one user, read off the wire. */
async function adminRow(sa, userId) {
  const r = await sa.get("/api/admin/participants?limit=5000&kind=all");
  expect(r.ok(), `admin list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).participants.find(p => p.id === userId);
  expect(row, `user ${userId} must be in the admin list`).toBeTruthy();
  return row;
}

/** Tag a user `staff` and PROVE the tag took — a silently-untagged fixture makes every negative vacuous. */
async function tagStaff(sa, saCsrf, userId) {
  const r = await sa.post(`/api/admin/participants/${userId}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
  expect(r.ok(), `tag staff: ${r.status()} ${await r.text()}`).toBeTruthy();
  expect((await r.json()).tags, "the staff tag really landed").toContain("staff");
}

async function makeStaffParticipant(sa, saCsrf, label) {
  const p = await makeParticipant(sa, saCsrf, label);
  await tagStaff(sa, saCsrf, p.id);
  return p;
}

/**
 * Register ONLY — neither verified nor approved — the state the UNAPPROVED
 * lifecycle skip is about. It must stay UNVERIFIED too: the invitation door
 * auto-approves a verified-but-unapproved invitee (`invitation_auto_approval`),
 * so a verified fixture would be enrolled rather than skipped there.
 */
async function registerOnly(label) {
  const tag = uniq(label);
  const email = `ea-${tag}@acme.com`;
  const anon = await freshCtx();
  try {
    const reg = await registerPost(anon.api, "/api/register", {
      headers: H(anon.csrf),
      data: {
        email, password: PARTICIPANT_PASS,
        nickname: `ea_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
        firstName: "Pending", lastName: String(label), company: "Acme", title: "Engineer",
        country: "GB", timezone: "Europe/London",
      },
    });
    expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  } finally { await anon.api.dispose(); }
  const row = (await (await sa.get("/api/admin/participants?limit=5000&kind=all")).json()).participants.find(p => p.email === email);
  expect(row, `registrant ${label} must be findable`).toBeTruthy();
  expect(row.approved, "PRECONDITION: an ordinary registration waits in the approval queue").toBeFalsy();
  expect(row.verified, "PRECONDITION: …and has not verified").toBeFalsy();
  return { id: row.id, email };
}

/** Promote a fresh participant to `role` (auto-tags staff) and sign in as them. */
async function makeTier(sa, saCsrf, label, role) {
  const p = await makeParticipant(sa, saCsrf, label);
  await promote(sa, saCsrf, p, role);
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  return { ...p, api, csrf };
}
const makeAdmin = (sa, saCsrf, label) => makeTier(sa, saCsrf, label, "admin");

/** Promote an EXISTING account (purges its sessions — log in afterwards) and prove the role + tag took. */
async function promote(sa, saCsrf, p, role) {
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${p.email} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const row = await adminRow(sa, p.id);
  expect(row.role, `${p.email} really holds the ${role} role`).toBe(role);
  if (role === "admin" || role === "superadmin") expect(row.tags, `${p.email} was auto-tagged staff on promotion`).toContain("staff");
}

/** A live tournament with the switch set as asked, and the join link enabled. */
async function makeEvent(sa, saCsrf, label, on, extra = {}) {
  return makeCompetition(sa, saCsrf, `${label}-${on ? "ON" : "OFF"}`, { staff_compete: !!on, self_enroll_enabled: true, ...extra });
}

/** The self-enroll token, revealed as the superadmin. */
async function joinTokenFor(sa, compId) {
  const r = await sa.get(`/api/admin/competitions/${compId}/self-enroll`);
  expect(r.ok(), `reveal join link: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.token, "the reveal carries the token").toBeTruthy();
  expect(d.enabled, "the link is really enabled — a disabled link 404s on join").toBe(true);
  return d.token;
}

/** POST the assign route and hand back the accounting, asserting only that it answered. */
async function assign(api, csrf, userIds, competitionIds) {
  const r = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds, competitionIds } });
  expect(r.ok(), `assign: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

/** POST /api/admin/invitations and hand back the accounting. */
async function invite(api, csrf, emails, competitionIds) {
  const r = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails, competitionIds } });
  expect(r.ok(), `invite: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

/** A sealed challenge by `author` (a user-backed admin), assigned to `compIds`. */
async function sealedTaskAssigned(author, label, compIds) {
  const t = await makeTask(author.api, author.csrf, label, { answer_sealed: true });
  await assignTask(author.api, author.csrf, t.id, compIds);
  return t;
}

let sa, saCsrf;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
});

test.afterAll(async () => { await sa?.dispose(); });

// ─────────────────────────────────────────────────────────────────────────────
test.describe("POST /api/admin/competitions/assign — staff rows land only on compete events", () => {

  test("a staff-tagged user is skipped on a switch-OFF event and enrolled on a switch-ON one; an ordinary participant is enrolled on both", async () => {
    const F = await makeEvent(sa, saCsrf, "assign", false);
    const E = await makeEvent(sa, saCsrf, "assign", true);
    const staff = await makeStaffParticipant(sa, saCsrf, "asgstaff");
    const plain = await makeParticipant(sa, saCsrf, "asgplain");

    // OFF: counted per pair, nothing written.
    const off = await assign(sa, saCsrf, [staff.id], [F.id]);
    expect(off.assigned, "nothing enrolled on the switch-OFF event").toBe(0);
    expect(off.skippedStaff, "and the skip is REPORTED").toBe(1);
    expect(off.skippedPrivileged, "the response carries the new counter even at zero").toBe(0);
    expect(Array.isArray(off.skippedAuthors), "…and the new array even when empty").toBe(true);
    expect(hasRow(F.id, staff.id), "no competition_users row on the switch-OFF event").toBe(false);
    // The admin list is served through a 5 s cache that a skip need not bust, so
    // this proves only that the list does not CONTRADICT the table.
    expect((await adminRow(sa, staff.id)).competitions.some(c => c.id === F.id), "and the admin list does not contradict the table").toBe(false);

    // ON: the row is written like anybody's, and the admin list shows it.
    const on = await assign(sa, saCsrf, [staff.id], [E.id]);
    expect(on.assigned, "enrolled on the switch-ON event").toBe(1);
    expect(on.skippedStaff).toBe(0);
    expect(hasRow(E.id, staff.id), "a row on the switch-ON event").toBe(true);
    const wire = await adminRow(sa, staff.id);
    expect(wire.tags, "PRECONDITION: the fixture is still staff-tagged").toContain("staff");
    expect(wire.competitions.some(c => c.id === E.id), "GET /api/admin/participants shows the event on their row").toBe(true);

    // CONTROL: an ordinary participant is unaffected by the switch in either direction.
    const ctl = await assign(sa, saCsrf, [plain.id], [F.id, E.id]);
    expect(ctl.assigned, "CONTROL: a non-staff participant lands on both").toBe(2);
    expect(ctl.skippedStaff).toBe(0);
    expect(hasRow(F.id, plain.id)).toBe(true);
    expect(hasRow(E.id, plain.id)).toBe(true);
  });

  test("skippedStaff counts per (user, event) PAIR: one user named against TWO switch-OFF events is skipped twice", async () => {
    const F = await makeEvent(sa, saCsrf, "pair", false);
    const F2 = await makeEvent(sa, saCsrf, "pair2", false);
    const E = await makeEvent(sa, saCsrf, "pair", true);
    const s1 = await makeStaffParticipant(sa, saCsrf, "pair1");
    const s2 = await makeStaffParticipant(sa, saCsrf, "pair2");

    // THE DISCRIMINATING REQUEST: one staff member × two OFF events (+ one ON).
    // A per-USER counter (a Set of skipped uids, the pre-v8.12.0 shape) reads 1
    // here; per PAIR reads 2. Every other request in this file is satisfied by
    // both. Mutation M1.
    const one = await assign(sa, saCsrf, [s1.id], [F.id, F2.id, E.id]);
    expect(one.skippedStaff, "one user, two OFF events: counted per PAIR").toBe(2);
    expect(one.assigned, "the ON pair is written").toBe(1);
    expect(hasRow(E.id, s1.id)).toBe(true);
    expect(hasRow(F.id, s1.id)).toBe(false);
    expect(hasRow(F2.id, s1.id)).toBe(false);

    // Two staff members, both events: two OFF pairs skipped; only s2's ON pair
    // is new (INSERT OR IGNORE counts only new rows).
    const two = await assign(sa, saCsrf, [s1.id, s2.id], [F.id, E.id]);
    expect(two.skippedStaff, "two OFF pairs, counted per pair").toBe(2);
    expect(two.assigned, "s2's ON pair is new; s1's is already a member").toBe(1);
    expect(hasRow(E.id, s2.id)).toBe(true);
    expect(hasRow(F.id, s2.id)).toBe(false);
  });

  test("the row-writer rule is the staff TAG, not the event_admin ROLE: an untagged event admin is enrollable on a switch-OFF event", async () => {
    // DESIGN.md: "event admins may legitimately be enrolled on a non-compete
    // event" — they are excluded from the BOARD by role, not from the roster.
    // Pinned so a reader who widens `isStaff` to the scoring definition meets a
    // red test rather than a silently narrower roster.
    const F = await makeEvent(sa, saCsrf, "earole", false);
    const organised = await makeCompetition(sa, saCsrf, "earole-mine");
    const ea = await makeParticipant(sa, saCsrf, "earole");
    await grantEventAdmin(sa, saCsrf, organised.id, ea.id);
    const row = await adminRow(sa, ea.id);
    expect(row.role, "PRECONDITION: the tier really is event_admin").toBe("event_admin");
    expect(row.tags, "PRECONDITION: and NOT tagged staff").not.toContain("staff");

    const d = await assign(sa, saCsrf, [ea.id], [F.id]);
    expect(d.assigned, "an untagged event admin is enrolled on a switch-OFF event").toBe(1);
    expect(d.skippedStaff).toBe(0);
    expect(hasRow(F.id, ea.id)).toBe(true);

    // CONTROL in the same test: tag them, and the same request is now skipped —
    // the discriminator is the tag and nothing else.
    const F2 = await makeEvent(sa, saCsrf, "earole2", false);
    await tagStaff(sa, saCsrf, ea.id);
    const d2 = await assign(sa, saCsrf, [ea.id], [F2.id]);
    expect(d2.skippedStaff, "once tagged, the same tier is skipped").toBe(1);
    expect(d2.assigned).toBe(0);
    expect(hasRow(F2.id, ea.id)).toBe(false);
  });

  test("privileged targets on a switch-ON event: a regular admin cannot enrol a fellow admin but may enrol THEMSELVES; a superadmin may enrol anybody", async () => {
    const E = await makeEvent(sa, saCsrf, "priv", true);
    const F = await makeEvent(sa, saCsrf, "priv", false);
    const actor = await makeAdmin(sa, saCsrf, "privactor");
    const peer = await makeAdmin(sa, saCsrf, "privpeer");
    const peer2 = await makeAdmin(sa, saCsrf, "privpeer2");
    const plain = await makeParticipant(sa, saCsrf, "privplain");
    const userSa = await makeTier(sa, saCsrf, "privusersa", "superadmin");

    // A regular admin enrolling a fellow admin: managing a privileged account.
    const a = await assign(actor.api, actor.csrf, [peer.id], [E.id]);
    expect(a.skippedPrivileged, "a fellow admin is a privileged target for a regular admin").toBe(1);
    expect(a.assigned).toBe(0);
    expect(a.skippedStaff, "and it is NOT reported as a staff skip — the event lets staff compete").toBe(0);
    expect(hasRow(E.id, peer.id)).toBe(false);

    // On a switch-OFF event the staff check comes FIRST, so the same pair is a
    // staff skip, not a privileged one.
    const offPair = await assign(actor.api, actor.csrf, [peer.id], [F.id]);
    expect(offPair.skippedStaff, "switch OFF: the staff rule answers before the privilege rule").toBe(1);
    expect(offPair.skippedPrivileged).toBe(0);
    expect(hasRow(F.id, peer.id)).toBe(false);

    // CONTROL: the same actor enrolling an ORDINARY participant is unaffected.
    const ctl = await assign(actor.api, actor.csrf, [plain.id], [E.id]);
    expect(ctl.assigned, "CONTROL: a regular admin still enrols an ordinary participant").toBe(1);
    expect(ctl.skippedPrivileged).toBe(0);

    // CONTROL (b): an UNTAGGED event admin is NOT a privileged target. The rule
    // is the admin/superadmin ROLE ("never an event admin"), and without this
    // arm it could be widened to every non-participant role with nothing going
    // red — the two event-admin arms elsewhere in this file drive switch-OFF
    // events with the built-in superadmin, where a widened predicate never
    // fires. Mutation M9.
    const ea = await makeParticipant(sa, saCsrf, "priveventadmin");
    await grantEventAdmin(sa, saCsrf, (await makeCompetition(sa, saCsrf, "priv-organised")).id, ea.id);
    const eaRow = await adminRow(sa, ea.id);
    expect(eaRow.role, "PRECONDITION: the target really is event_admin").toBe("event_admin");
    expect(eaRow.tags, "PRECONDITION: and NOT tagged staff").not.toContain("staff");
    const eaAssign = await assign(actor.api, actor.csrf, [ea.id], [E.id]);
    expect(eaAssign.assigned, "CONTROL: a regular admin enrols an untagged event admin on a compete event").toBe(1);
    expect(eaAssign.skippedPrivileged, "an event admin is not a privileged target for a regular admin").toBe(0);
    expect(hasRow(E.id, ea.id)).toBe(true);

    // The built-in superadmin may enrol the admin the regular admin could not.
    const bySa = await assign(sa, saCsrf, [peer.id], [E.id]);
    expect(bySa.assigned, "the built-in superadmin enrols an admin").toBe(1);
    expect(bySa.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, peer.id)).toBe(true);

    // A USER-BACKED superadmin may too (`req.session.isSuperAdmin`, not the built-in identity).
    const byUserSa = await assign(userSa.api, userSa.csrf, [peer2.id], [E.id]);
    expect(byUserSa.assigned, "a user-backed superadmin enrols an admin").toBe(1);
    expect(byUserSa.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, peer2.id)).toBe(true);

    // Self-assign is ALWAYS allowed — the ordinary way an organiser joins the
    // event they will compete in. Driven LAST: it makes the actor a competitor.
    const self = await assign(actor.api, actor.csrf, [actor.id], [E.id]);
    expect(self.assigned, "a regular admin enrols THEMSELVES").toBe(1);
    expect(self.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, actor.id)).toBe(true);

    // …and having done so they are a competitor there: the next assign into
    // that event is refused at the door, before any accounting. Stated here
    // because it is the ordering trap every fixture on this route meets.
    const locked = await actor.api.post("/api/admin/competitions/assign", { headers: H(actor.csrf), data: { userIds: [plain.id], competitionIds: [E.id] } });
    expect(locked.status(), "a competitor may not enrol anybody into the event they compete in").toBe(403);
    expect((await locked.json()).code).toBe("competitor_cannot_edit");

    await actor.api.dispose(); await peer.api.dispose(); await peer2.api.dispose(); await userSa.api.dispose();
  });

  test("the AUTHOR of a challenge assigned to a switch-ON event is skipped, naming the challenges; a non-author is enrolled; the author is enrollable elsewhere", async () => {
    const E = await makeEvent(sa, saCsrf, "author", true);
    const E2 = await makeEvent(sa, saCsrf, "author-other", true);
    const E3 = await makeEvent(sa, saCsrf, "author-third", true);
    const F = await makeEvent(sa, saCsrf, "author", false);
    const author = await makeAdmin(sa, saCsrf, "author");
    const other = await makeAdmin(sa, saCsrf, "notauthor");
    const t1 = await sealedTaskAssigned(author, "authored1", [E.id, F.id, E3.id]);
    const t2 = await sealedTaskAssigned(author, "authored2", [E.id]);

    const d = await assign(sa, saCsrf, [author.id], [E.id]);
    expect(d.assigned, "the author is not seated").toBe(0);
    expect(d.skippedStaff, "not a staff skip — the event lets staff compete").toBe(0);
    expect(d.skippedPrivileged, "not a privilege skip — the actor is the superadmin").toBe(0);
    expect(d.skippedAuthors, "exactly one (user, event) entry").toHaveLength(1);
    const entry = d.skippedAuthors[0];
    expect(entry.userId).toBe(author.id);
    expect(entry.nickname).toBe(author.nickname);
    expect(entry.competitionId).toBe(E.id);
    expect(entry.competitionName).toBe(E.name);
    // Named as the event holds them: its own copies (lib/event-copies.js).
    const own = [t1, t2].map(x => ({ ...x, id: eventCopyOf(x.id, E.id) }));
    expect(entry.tasks.map(t => t.id).sort(), "every authored challenge assigned to the event is named").toEqual(own.map(x => x.id).sort());
    for (const t of entry.tasks) expect(t.title, "each with its title").toBe(own.find(x => x.id === t.id).title);
    expect(hasRow(E.id, author.id), "and no row was written").toBe(false);

    // CONTROL (a): a non-author admin is seated on the same event.
    const ctl = await assign(sa, saCsrf, [other.id], [E.id]);
    expect(ctl.assigned, "CONTROL: an admin who authored nothing here is enrolled").toBe(1);
    expect(ctl.skippedAuthors).toHaveLength(0);
    expect(hasRow(E.id, other.id)).toBe(true);

    // CONTROL (b): the author is seated on a switch-ON event that does NOT hold
    // their challenge — the rule is about THIS event's challenges.
    const elsewhere = await assign(sa, saCsrf, [author.id], [E2.id]);
    expect(elsewhere.assigned, "CONTROL: the author competes elsewhere").toBe(1);
    expect(elsewhere.skippedAuthors).toHaveLength(0);
    expect(hasRow(E2.id, author.id)).toBe(true);

    // On a switch-OFF event holding the same challenge the STAFF rule answers
    // first — authorship is only a question where staff compete.
    const off = await assign(sa, saCsrf, [author.id], [F.id]);
    expect(off.skippedStaff, "switch OFF: staff skip, not an author skip").toBe(1);
    expect(off.skippedAuthors).toHaveLength(0);
    expect(hasRow(F.id, author.id)).toBe(false);

    // PER (user, event) PAIR, not per user: t1 is held by E AND E3, so ONE
    // request naming both must answer TWO entries with distinct events, each
    // naming only the challenges THAT event holds. Every single-event request
    // above is satisfied by a per-USER collapse (one entry however many events
    // refused the author). Mutation M10.
    const pair = await assign(sa, saCsrf, [author.id], [E.id, E3.id]);
    expect(pair.assigned, "no pair is written").toBe(0);
    expect(pair.skippedAuthors.map(a => a.competitionId).sort(), "one entry per refused (user, event) pair").toEqual([E.id, E3.id].sort());
    const forE = pair.skippedAuthors.find(a => a.competitionId === E.id);
    const forE3 = pair.skippedAuthors.find(a => a.competitionId === E3.id);
    // Named as each event holds them: its own copies (lib/event-copies.js).
    expect(forE.tasks.map(t => t.id).sort(), "the E entry names both challenges E holds").toEqual([eventCopyOf(t1.id, E.id), eventCopyOf(t2.id, E.id)].sort());
    expect(forE3.tasks.map(t => t.id), "the E3 entry names only the challenge E3 holds").toEqual([eventCopyOf(t1.id, E3.id)]);
    expect(forE3.competitionName).toBe(E3.name);
    expect(hasRow(E3.id, author.id), "no row on the third event either").toBe(false);
    // CONTROL: the non-author through the same two-event request lands on E3
    // (E is already held from CONTROL (a), so INSERT OR IGNORE counts one).
    const pairCtl = await assign(sa, saCsrf, [other.id], [E.id, E3.id]);
    expect(pairCtl.assigned, "CONTROL: the non-author lands on the event they did not yet hold").toBe(1);
    expect(pairCtl.skippedAuthors).toHaveLength(0);
    expect(hasRow(E3.id, other.id)).toBe(true);

    await author.api.dispose(); await other.api.dispose();
  });

  test("a BLOCKED or UNAPPROVED staff user is reported as a lifecycle skip, never as a staff skip — on either kind of event; once the lifecycle passes, the staff rule answers", async () => {
    // Round-3 change (c): the blocked and unapproved skips run BEFORE the staff
    // check, so a blocked staff account on a switch-OFF event is "blocked",
    // not "staff" — the remedy differs. Mutation M13.
    const F = await makeEvent(sa, saCsrf, "blocked", false);
    const E = await makeEvent(sa, saCsrf, "blocked", true);
    const staff = await makeStaffParticipant(sa, saCsrf, "blockedstaff");
    const b = await sa.post(`/api/admin/participants/${staff.id}/block`, { headers: H(saCsrf) });
    expect(b.ok(), `block: ${b.status()} ${await b.text()}`).toBeTruthy();
    const row = await adminRow(sa, staff.id);
    expect(row.blocked, "PRECONDITION: the block took (the route is a TOGGLE)").toBeTruthy();
    expect(row.tags, "PRECONDITION: still staff-tagged").toContain("staff");

    for (const [comp, label] of [[F, "switch-OFF"], [E, "switch-ON"]]) {
      const d = await assign(sa, saCsrf, [staff.id], [comp.id]);
      expect(d.skippedBlocked, `${label}: the lifecycle answers first`).toBe(1);
      expect(d.skippedStaff, `${label}: and it is NOT double-counted as a staff skip`).toBe(0);
      expect(d.skippedUnapproved).toBe(0);
      expect(d.assigned).toBe(0);
      expect(hasRow(comp.id, staff.id)).toBe(false);
    }

    // The UNAPPROVED branch — registered, never verified or approved, then
    // tagged staff (the tags route has no lifecycle gate).
    const pending = await registerOnly("pendingstaff");
    await tagStaff(sa, saCsrf, pending.id);
    expect((await adminRow(sa, pending.id)).approved, "PRECONDITION: still unapproved after tagging").toBeFalsy();
    for (const [comp, label] of [[F, "switch-OFF"], [E, "switch-ON"]]) {
      const d = await assign(sa, saCsrf, [pending.id], [comp.id]);
      expect(d.skippedUnapproved, `${label}: the approval queue answers first`).toBe(1);
      expect(d.skippedStaff, `${label}: not a staff skip`).toBe(0);
      expect(d.skippedBlocked).toBe(0);
      expect(d.assigned).toBe(0);
      expect(hasRow(comp.id, pending.id)).toBe(false);
    }

    // CONTROLS: lift the lifecycle and the SAME accounts meet the staff rule —
    // enrolled on the compete event, a staff skip on the other. "The lifecycle
    // answers first" is otherwise satisfied by a build that skips these
    // accounts for ever.
    const ub = await sa.post(`/api/admin/participants/${staff.id}/block`, { headers: H(saCsrf) });   // TOGGLE: unblock
    expect(ub.ok(), `unblock: ${ub.status()} ${await ub.text()}`).toBeTruthy();
    expect((await adminRow(sa, staff.id)).blocked, "PRECONDITION: the toggle really unblocked").toBeFalsy();
    const v = await sa.post(`/api/admin/participants/${pending.id}/verify`, { headers: H(saCsrf) });
    expect(v.ok(), `verify: ${v.status()} ${await v.text()}`).toBeTruthy();
    const ap = await sa.post(`/api/admin/participants/${pending.id}/approve`, { headers: H(saCsrf) });
    expect(ap.ok(), `approve: ${ap.status()} ${await ap.text()}`).toBeTruthy();
    expect((await adminRow(sa, pending.id)).approved, "PRECONDITION: approved now").toBeTruthy();
    for (const u of [staff, pending]) {
      const on = await assign(sa, saCsrf, [u.id], [E.id]);
      expect(on.assigned, `CONTROL: ${u.email} is enrolled on the compete event once the lifecycle passes`).toBe(1);
      expect(on.skippedBlocked + on.skippedUnapproved).toBe(0);
      expect(hasRow(E.id, u.id)).toBe(true);
      const off = await assign(sa, saCsrf, [u.id], [F.id]);
      expect(off.skippedStaff, `CONTROL: …and is a staff skip on the switch-OFF event`).toBe(1);
      expect(hasRow(F.id, u.id)).toBe(false);
    }
  });

  test("a peer admin who ALREADY holds a row on a compete event, re-assigned by a REGULAR admin, is a MEMBER (the idempotent path) — not `skippedPrivileged`; the same pair with NO row still is (CONTROL)", async () => {
    // Round 4: "a held row is a membership, at every writer" — the invitation
    // door wraps all three skips in `if (!_heldInv)`, while the assign door
    // honoured the held row for the SPECTATOR skip alone, so this pair was
    // `skippedPrivileged` here and `alreadyAssigned` there: two dialogs, two
    // reasons, one no-op. The row is GROUP-ORIGIN, written by live sync (an
    // admin is staff-tagged, and a compete event admits staff), so the
    // re-assign has one real effect — the promotion to direct.
    const E = await makeEvent(sa, saCsrf, "heldpeer", true);
    const actor = await makeAdmin(sa, saCsrf, "heldpeeractor");
    const peer = await makeAdmin(sa, saCsrf, "heldpeer");
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq("SC heldpeer"), userIds: [peer.id] } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const group = (await g.json()).group;
    const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [group.id], competitionIds: [E.id] } });
    expect(bind.ok(), `bind: ${bind.status()} ${await bind.text()}`).toBeTruthy();
    const directOf = () => withDb(db => db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(E.id, peer.id))?.direct_assigned;
    expect(hasRow(E.id, peer.id), "PRECONDITION: the sync enrolled the admin on the compete event").toBe(true);
    expect(directOf(), "PRECONDITION: a group-origin row").toBe(0);

    const d = await assign(actor.api, actor.csrf, [peer.id], [E.id]);
    expect(d.skippedPrivileged, "a member is not a privileged skip — the membership answers first").toBe(0);
    expect(d.assigned, "INSERT OR IGNORE: no new row").toBe(0);
    expect(directOf(), "the ordinary already-member path promoted the row").toBe(1);

    // CONTROL: the same actor and peer on a compete event holding NO row is
    // still the privileged skip — the rule moved for a held row, not for the pair.
    const E2 = await makeEvent(sa, saCsrf, "heldpeer2", true);
    const d2 = await assign(actor.api, actor.csrf, [peer.id], [E2.id]);
    expect(d2.skippedPrivileged, "CONTROL: no row, so the peer rule answers").toBe(1);
    expect(hasRow(E2.id, peer.id)).toBe(false);
    await actor.api.dispose(); await peer.api.dispose();
  });

  test("a peer admin who AUTHORED one of the event's challenges, enrolled by a REGULAR admin: the privileged rule answers before the author rule; the superadmin hears the author", async () => {
    // The assign door's precedence for the one pair both rules claim. It is the
    // REFERENCE the invitation door is held to (the alignment arm below, which
    // is fixme'd while the two doors disagree), so it is pinned on its own.
    const E = await makeEvent(sa, saCsrf, "prec", true);
    const actor = await makeAdmin(sa, saCsrf, "precactor");
    const peerAuthor = await makeAdmin(sa, saCsrf, "precpeerauthor");
    const t = await sealedTaskAssigned(peerAuthor, "precauthored", [E.id]);

    const byActor = await assign(actor.api, actor.csrf, [peerAuthor.id], [E.id]);
    expect(byActor.skippedPrivileged, "a regular admin: the privileged rule answers").toBe(1);
    expect(byActor.skippedAuthors, "…and the author rule is never reached").toHaveLength(0);
    expect(byActor.assigned).toBe(0);
    expect(hasRow(E.id, peerAuthor.id)).toBe(false);

    // CONTROL: the superadmin, for whom no privileged rule exists, hears the author.
    const bySa = await assign(sa, saCsrf, [peerAuthor.id], [E.id]);
    expect(bySa.skippedPrivileged).toBe(0);
    expect(bySa.skippedAuthors.map(a => a.competitionId), "CONTROL: the superadmin caller is refused for authorship").toEqual([E.id]);
    expect(bySa.skippedAuthors[0].tasks.map(x => x.id)).toEqual([eventCopyOf(t.id, E.id)]);   // the event's own copy
    expect(hasRow(E.id, peerAuthor.id)).toBe(false);
    await actor.api.dispose(); await peerAuthor.api.dispose();
  });

  test("a staff-tagged user who ALREADY holds a row on a switch-OFF event is re-assigned as a MEMBER (the idempotent path, promoting a group-origin row), not skipped as staff", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the assign loop's staff skip is gated on `!_held` — a staff member who
    // already holds a row on the non-compete event takes the idempotent path
    // rather than being reported as a skip.
    // The row is GROUP-ORIGIN (direct_assigned=0), written by group sync while
    // the account was untagged; the tag removes no rows. A direct assign is the
    // documented way to PROMOTE such a row so group sync can never auto-remove
    // it — the act this door skips today.
    const F = await makeEvent(sa, saCsrf, "heldassign", false);
    const p = await makeParticipant(sa, saCsrf, "heldassign");
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq("SC held"), userIds: [p.id] } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const group = (await g.json()).group;
    const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [group.id], competitionIds: [F.id] } });
    expect(bind.ok(), `bind: ${bind.status()} ${await bind.text()}`).toBeTruthy();
    const directOf = () => withDb(db => db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(F.id, p.id))?.direct_assigned;
    expect(directOf(), "PRECONDITION: a group-origin row").toBe(0);
    await tagStaff(sa, saCsrf, p.id);
    expect(hasRow(F.id, p.id), "PRECONDITION: the tag removed no row").toBe(true);

    const d = await assign(sa, saCsrf, [p.id], [F.id]);
    expect(d.skippedStaff, "a member is not a staff skip — the membership answers first").toBe(0);
    expect(d.assigned, "INSERT OR IGNORE: no new row").toBe(0);
    expect(hasRow(F.id, p.id)).toBe(true);
    expect(directOf(), "the ordinary already-member path promoted the row").toBe(1);

    // CONTROL: the same account with NO row on another switch-OFF event is still a staff skip.
    const F2 = await makeEvent(sa, saCsrf, "heldassign2", false);
    const d2 = await assign(sa, saCsrf, [p.id], [F2.id]);
    expect(d2.skippedStaff, "CONTROL: a non-member staff account is still skipped").toBe(1);
    expect(hasRow(F2.id, p.id)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("POST /api/competitions/join — the self-enroll link", () => {

  test("a staff-tagged participant is a SPECTATOR on a switch-OFF event (200, no row, can still enter) and a COMPETITOR on a switch-ON one", async () => {
    const F = await makeEvent(sa, saCsrf, "join", false);
    const E = await makeEvent(sa, saCsrf, "join", true);
    const tokF = await joinTokenFor(sa, F.id);
    const tokE = await joinTokenFor(sa, E.id);
    const staff = await makeStaffParticipant(sa, saCsrf, "joinstaff");
    const plain = await makeParticipant(sa, saCsrf, "joinplain");
    const me = await apiLogin(staff.email, PARTICIPANT_PASS);
    const them = await apiLogin(plain.email, PARTICIPANT_PASS);

    // OFF → spectator: the join "succeeds" (entering is what they wanted) and
    // says why nothing was recorded.
    const spec = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokF } });
    expect(spec.status(), `spectator join: ${await spec.text()}`).toBe(200);
    const sb = await spec.json();
    expect(sb).toMatchObject({ ok: true, competitionId: F.id, alreadyMember: false, staffSpectator: true });
    expect(hasRow(F.id, staff.id), "NO competition_users row for a spectator").toBe(false);
    // The spectator branch busts no cache, so the admin list can be 5 s stale
    // here: this proves it does not CONTRADICT the table, no more.
    expect((await adminRow(sa, staff.id)).competitions.some(c => c.id === F.id), "and the admin list does not contradict the table").toBe(false);
    // Idempotent: a second scan writes nothing either and does not claim membership.
    const again = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokF } });
    expect(await again.json()).toMatchObject({ ok: true, alreadyMember: false, staffSpectator: true });
    expect(hasRow(F.id, staff.id)).toBe(false);
    // …yet they can ENTER it — staff are admitted without a row, as always —
    // and ENTERING is the act that could write one, so the table is re-read
    // AFTER the select, not only before it.
    const sel = await me.api.post("/api/select-competition", { headers: H(me.csrf), data: { competitionId: F.id } });
    expect(sel.ok(), `a spectator selects the event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    expect(hasRow(F.id, staff.id), "entering as a spectator still writes no row").toBe(false);

    // ON → a row like anybody's, and no spectator flag.
    const comp = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokE } });
    expect(comp.status(), `competitor join: ${await comp.text()}`).toBe(200);
    const cb = await comp.json();
    expect(cb).toMatchObject({ ok: true, competitionId: E.id, alreadyMember: false });
    expect(cb.staffSpectator, "no spectator flag on a compete event").toBeUndefined();
    expect(hasRow(E.id, staff.id), "a row on the switch-ON event").toBe(true);
    expect((await adminRow(sa, staff.id)).competitions.some(c => c.id === E.id), "the ON join busts the admin list, which shows the row").toBe(true);
    const rejoin = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokE } });
    expect((await rejoin.json()).alreadyMember, "a second scan reports the membership it already has").toBe(true);

    // CONTROL: an ordinary participant gets a row on BOTH, with no spectator flag.
    for (const [comp2, tok] of [[F, tokF], [E, tokE]]) {
      const r = await them.api.post("/api/competitions/join", { headers: H(them.csrf), data: { token: tok } });
      expect(r.status(), `plain join ${comp2.name}: ${await r.text()}`).toBe(200);
      const b = await r.json();
      expect(b).toMatchObject({ ok: true, competitionId: comp2.id, alreadyMember: false });
      expect(b.staffSpectator).toBeUndefined();
      expect(hasRow(comp2.id, plain.id), `CONTROL: an ordinary participant holds a row on ${comp2.name}`).toBe(true);
    }
    await me.api.dispose(); await them.api.dispose();
  });

  test("the AUTHOR of a challenge assigned to a switch-ON event is refused 409 with the challenges named; a non-author joins; the author joins an event without their challenge", async () => {
    const E = await makeEvent(sa, saCsrf, "joinauthor", true);
    const E2 = await makeEvent(sa, saCsrf, "joinauthor-other", true);
    const tokE = await joinTokenFor(sa, E.id);
    const tokE2 = await joinTokenFor(sa, E2.id);
    const author = await makeAdmin(sa, saCsrf, "joinauthor");
    const other = await makeAdmin(sa, saCsrf, "joinother");
    const t = await sealedTaskAssigned(author, "joinauthored", [E.id]);

    const r = await author.api.post("/api/competitions/join", { headers: H(author.csrf), data: { token: tokE } });
    expect(r.status(), `author join: ${await r.text()}`).toBe(409);
    const b = await r.json();
    expect(b.code).toBe("staff_compete_author_competes");
    expect(b.tasks, "the refusal names the challenge (the event's own copy)").toEqual([{ id: eventCopyOf(t.id, E.id), title: t.title }]);
    expect(String(b.error)).toContain(t.title);
    expect(hasRow(E.id, author.id), "nothing written").toBe(false);

    // CONTROL (a): a non-author admin joins the same event.
    const ok = await other.api.post("/api/competitions/join", { headers: H(other.csrf), data: { token: tokE } });
    expect(ok.status(), `non-author join: ${await ok.text()}`).toBe(200);
    expect((await ok.json()).staffSpectator).toBeUndefined();
    expect(hasRow(E.id, other.id)).toBe(true);

    // CONTROL (b): the author joins a switch-ON event that does not hold their challenge.
    const ok2 = await author.api.post("/api/competitions/join", { headers: H(author.csrf), data: { token: tokE2 } });
    expect(ok2.status(), `author joins elsewhere: ${await ok2.text()}`).toBe(200);
    expect(hasRow(E2.id, author.id)).toBe(true);

    await author.api.dispose(); await other.api.dispose();
  });

  test("the shared predicate keys on the TAG too: an untagged event admin joins a switch-OFF link and gets a row; tagged, the same tier is a spectator", async () => {
    // `staffRowRefusal` (lib/self-enroll.js) is the ONE predicate behind the
    // join link, the deferred consume, group sync, invitations, the import and
    // the invitation claim at sign-in — and until this arm every control through those doors
    // was a plain participant, so a reader who "tightened" it to the SCORING
    // definition (tag OR event_admin role) was caught by nothing. Mutation M7.
    const F = await makeEvent(sa, saCsrf, "eajoin", false);
    const F2 = await makeEvent(sa, saCsrf, "eajoin2", false);
    const tokF = await joinTokenFor(sa, F.id);
    const tokF2 = await joinTokenFor(sa, F2.id);
    const organised = await makeCompetition(sa, saCsrf, "eajoin-mine");
    const ea = await makeParticipant(sa, saCsrf, "eajoin");
    await grantEventAdmin(sa, saCsrf, organised.id, ea.id);   // BEFORE the login: a grant purges sessions
    const row = await adminRow(sa, ea.id);
    expect(row.role, "PRECONDITION: the tier really is event_admin").toBe("event_admin");
    expect(row.tags, "PRECONDITION: and NOT tagged staff").not.toContain("staff");
    const me = await apiLogin(ea.email, PARTICIPANT_PASS);

    const r = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokF } });
    expect(r.status(), `event admin joins a switch-OFF link: ${await r.text()}`).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, competitionId: F.id, alreadyMember: false });
    expect(b.staffSpectator, "an untagged event admin is not a spectator — the role is not the tag").toBeUndefined();
    expect(hasRow(F.id, ea.id), "a row is written for an untagged event admin").toBe(true);

    // CONTROL: tag the SAME account and the same door answers spectator.
    await tagStaff(sa, saCsrf, ea.id);
    const r2 = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokF2 } });
    expect(r2.status(), `tagged event admin joins a switch-OFF link: ${await r2.text()}`).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, competitionId: F2.id, alreadyMember: false, staffSpectator: true });
    expect(hasRow(F2.id, ea.id), "once tagged, no row").toBe(false);
    await me.api.dispose();
  });

  test("a staff-tagged user who ALREADY holds a row on a switch-OFF event scans its link: the answer must not claim they are not a member", async () => {
    // THE SPECTATOR BRANCH RUNS ONLY FOR A NON-MEMBER (routes/self-enroll.js,
    // the `_hasRow` read before `staffRowRefusal`). A staff-tagged user who
    // holds a real row on a switch-OFF event — assigned as an ordinary
    // participant and tagged afterwards (the tags route removes no rows), or
    // enrolled before the upgrade — is a member whatever the switch says, so the
    // ordinary idempotent path answers `alreadyMember:true` for them as it does
    // for anybody. Without the guard the join answered `{alreadyMember:false,
    // staffSpectator:true}` and the client toast said "you have not been
    // enrolled" about somebody who is. Reachable in two API calls. Mutation M8.
    const F = await makeEvent(sa, saCsrf, "heldrow", false);
    const tokF = await joinTokenFor(sa, F.id);
    const p = await makeParticipant(sa, saCsrf, "heldrow");
    const d = await assign(sa, saCsrf, [p.id], [F.id]);
    expect(d.assigned, "PRECONDITION: enrolled as an ordinary participant first").toBe(1);
    await tagStaff(sa, saCsrf, p.id);
    expect(hasRow(F.id, p.id), "PRECONDITION: the tag removed no row").toBe(true);
    const me = await apiLogin(p.email, PARTICIPANT_PASS);
    const r = await me.api.post("/api/competitions/join", { headers: H(me.csrf), data: { token: tokF } });
    expect(r.status(), `join with a held row: ${await r.text()}`).toBe(200);
    const b = await r.json();
    expect(hasRow(F.id, p.id), "the join must not remove the row").toBe(true);
    expect(b.alreadyMember, "a join by a staff-tagged user who already holds a row must not claim they are not a member").toBe(true);
    await me.api.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("the deferred consume — registering through the join link, enrolled at first sign-in", () => {

  /** Register a NEW account through a join link. Returns the admin-list row (unverified, approved, marker set). */
  async function registerViaJoin(label, token) {
    const tag = uniq(label);
    const email = `ea-${tag}@acme.com`;
    const anon = await freshCtx();
    try {
      const reg = await registerPost(anon.api, "/api/register", {
        headers: H(anon.csrf),
        data: {
          email, password: PARTICIPANT_PASS, joinToken: token,
          nickname: `ea_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
          firstName: "Join", lastName: String(label), company: "Acme", title: "Engineer",
          country: "GB", timezone: "Europe/London",
        },
        // Email first, the registration IS the first sign-in and enrols at once;
        // this describe is about the deferred consume, so put the enrolment back
        // to "deferred to the first sign-in" (marker set, no row).
        deferJoin: true,
      });
      expect(reg.ok(), `register via join ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    } finally { await anon.api.dispose(); }
    const list = await sa.get("/api/admin/participants?limit=5000&kind=all");
    const row = (await list.json()).participants.find(p => p.email === email);
    expect(row, `join registrant ${label} must be findable`).toBeTruthy();
    expect(row.approved, "PRECONDITION: a join-link registration skips the approval queue").toBeTruthy();
    expect(row.verified, "PRECONDITION: …but still has to verify").toBeFalsy();
    return { id: row.id, email };
  }

  async function verifyAndSignIn(u) {
    const v = await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
    expect(v.ok(), `verify: ${v.status()} ${await v.text()}`).toBeTruthy();
    return apiLogin(u.email, PARTICIPANT_PASS);
  }

  test("tagged staff BEFORE first sign-in: a switch-OFF event writes no row and clears the marker; a switch-ON one writes the row; an ordinary registrant is enrolled either way", async () => {
    const F = await makeEvent(sa, saCsrf, "consume", false);
    const E = await makeEvent(sa, saCsrf, "consume", true);
    const tokF = await joinTokenFor(sa, F.id);
    const tokE = await joinTokenFor(sa, E.id);

    // The spectator: registered through F's link, tagged staff before ever
    // signing in — the state an organiser produces by tagging a colleague's
    // fresh account from the Participants pane.
    const staffOff = await registerViaJoin("consumestaffoff", tokF);
    await tagStaff(sa, saCsrf, staffOff.id);
    expect(pendingMarker(staffOff.id), "PRECONDITION: the marker points at the event").toBe(F.id);
    expect(hasRow(F.id, staffOff.id), "PRECONDITION: registration wrote no row — enrolment is DEFERRED").toBe(false);
    const s1 = await verifyAndSignIn(staffOff);
    expect(hasRow(F.id, staffOff.id), "first sign-in wrote NO row for a staff spectator").toBe(false);
    expect(pendingMarker(staffOff.id), "and the marker is CLEARED — it will not retry on every login").toBeNull();
    // A second sign-in proves the marker was CLEARED rather than left to retry:
    // with the marker gone there is nothing for the consume to act on.
    await s1.api.dispose();
    const s1b = await apiLogin(staffOff.email, PARTICIPANT_PASS);
    expect(hasRow(F.id, staffOff.id), "still no row after a second sign-in").toBe(false);
    await s1b.api.dispose();

    // CONTROL (a): the same staff registrant through a switch-ON link is enrolled.
    // The marker is asserted BEFORE the sign-in, or "the consume wrote the row"
    // is indistinguishable from "registration wrote it" (which an instant-join
    // kind would do).
    const staffOn = await registerViaJoin("consumestaffon", tokE);
    await tagStaff(sa, saCsrf, staffOn.id);
    expect(pendingMarker(staffOn.id), "PRECONDITION: enrolment is deferred to first sign-in").toBe(E.id);
    expect(hasRow(E.id, staffOn.id), "PRECONDITION: no row before the first sign-in").toBe(false);
    const s2 = await verifyAndSignIn(staffOn);
    expect(hasRow(E.id, staffOn.id), "CONTROL: staff registering through a compete event's link get a row").toBe(true);
    expect(pendingMarker(staffOn.id), "marker consumed").toBeNull();
    await s2.api.dispose();

    // CONTROL (b): an ordinary registrant through the switch-OFF link is enrolled —
    // the consume path itself works, so the spectator's missing row is the rule.
    const plain = await registerViaJoin("consumeplain", tokF);
    expect(pendingMarker(plain.id), "PRECONDITION: enrolment is deferred to first sign-in").toBe(F.id);
    expect(hasRow(F.id, plain.id), "PRECONDITION: no row before the first sign-in").toBe(false);
    const s3 = await verifyAndSignIn(plain);
    expect(hasRow(F.id, plain.id), "CONTROL: an ordinary registrant is enrolled at first sign-in").toBe(true);
    expect(pendingMarker(plain.id)).toBeNull();
    await s3.api.dispose();
  });

  test("the join made at first sign-in is recorded as the person's own, with the sign-in request's context", async () => {
    const F = await makeEvent(sa, saCsrf, "joinctx", false);
    const u = await registerViaJoin("joinctx", await joinTokenFor(sa, F.id));
    expect(pendingMarker(u.id), "PRECONDITION: enrolment is deferred to first sign-in").toBe(F.id);
    const s = await verifyAndSignIn(u);
    try {
      expect(hasRow(F.id, u.id), "PRECONDITION: the sign-in enrolled them").toBe(true);
      const joins = withDb(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='user_added'").all(F.id))
        .map(r => ({ by: r.changed_by, d: JSON.parse(r.details || "{}") })).filter(r => r.d.user_id === u.id);
      // The registration's own join (re-deferred by the fixture) and the sign-in's:
      // both go through the sign-in door's consume, so each names the person.
      expect(joins.length, "PRECONDITION: the sign-in's join is on the event's History").toBeGreaterThanOrEqual(1);
      for (const j of joins) {
        expect(String(j.by).toLowerCase(), "the person joined, not the mechanism").toBe(u.email.toLowerCase());
        expect(j.d.via).toBe("self_enroll");
        expect(j.d.ip, "the request's source address rides it").toBeTruthy();
        expect(j.d.req_id, "and its request id").toBeTruthy();
      }
      const mine = withDb(db => db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='self_enrolled'").all(u.id));
      expect(mine.length, "PRECONDITION: the person's own History has the join").toBeGreaterThanOrEqual(1);
      for (const m of mine) {
        expect(String(m.changed_by).toLowerCase(), "the person's own History says the same").toBe(u.email.toLowerCase());
        expect(JSON.parse(m.details || "{}").ip).toBeTruthy();
      }
    } finally { await s.api.dispose(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("group sync — a bound group's staff member follows the same rule", () => {

  test("binding a group: on a switch-OFF event only the ordinary member is enrolled; on a switch-ON event both are, except an author of one of its challenges", async () => {
    const F = await makeEvent(sa, saCsrf, "group", false);
    const E = await makeEvent(sa, saCsrf, "group", true);
    const staff = await makeStaffParticipant(sa, saCsrf, "grpstaff");
    const plain = await makeParticipant(sa, saCsrf, "grpplain");
    const author = await makeAdmin(sa, saCsrf, "grpauthor");
    await sealedTaskAssigned(author, "grpauthored", [E.id]);

    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq("SC group"), userIds: [staff.id, plain.id, author.id] } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const group = (await g.json()).group;
    expect(group.member_count, "PRECONDITION: all three are members").toBe(3);

    // Bind to the switch-OFF event: the reconcile pass enrols the ordinary member only.
    const bindF = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [group.id], competitionIds: [F.id] } });
    expect(bindF.ok(), `bind F: ${bindF.status()} ${await bindF.text()}`).toBeTruthy();
    expect((await bindF.json()).groupsBound, "the bind landed").toBe(1);
    expect(hasRow(F.id, plain.id), "the ordinary member is enrolled by group sync").toBe(true);
    expect(hasRow(F.id, staff.id), "the staff-tagged member is NOT enrolled on a switch-OFF event").toBe(false);
    expect(hasRow(F.id, author.id), "nor is the (staff-tagged) admin — the switch is off").toBe(false);

    // Bind to the switch-ON event: staff and ordinary both land; the author does not.
    const bindE = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [group.id], competitionIds: [E.id] } });
    expect(bindE.ok(), `bind E: ${bindE.status()} ${await bindE.text()}`).toBeTruthy();
    expect((await bindE.json()).groupsBound).toBe(1);
    expect(hasRow(E.id, plain.id), "CONTROL: the ordinary member lands").toBe(true);
    expect(hasRow(E.id, staff.id), "the staff-tagged member lands on a switch-ON event").toBe(true);
    expect(hasRow(E.id, author.id), "the author of one of its challenges never does").toBe(false);
    await author.api.dispose();
  });

  test("turning the switch ON re-runs group sync for the event's bound groups: a staff-tagged member skipped while the switch was off is enrolled; an author of one of its challenges still is not", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the `_staffCompeteChanged` post-commit block calls
    // `reconcileCompetitionMembership` when the switch went ON, so a bound
    // group's staff members are enrolled at once rather than at the next
    // unrelated trigger.
    // UPCOMING, so the switch is changeable (it locks once the event starts) —
    // exactly when an organiser binds their cohort groups.
    const F = await makeEvent(sa, saCsrf, "flip", false, { start_time: new Date(Date.now() + 3_600_000).toISOString() });
    const P = await makeStaffParticipant(sa, saCsrf, "flipstaff");
    const Q = await makeParticipant(sa, saCsrf, "flipplain");
    const A = await makeAdmin(sa, saCsrf, "flipauthor");
    await sealedTaskAssigned(A, "flipauthored", [F.id]);   // switch OFF: the seal gate does not apply
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq("SC flip"), userIds: [P.id, Q.id, A.id] } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const group = (await g.json()).group;
    const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [group.id], competitionIds: [F.id] } });
    expect(bind.ok(), `bind: ${bind.status()} ${await bind.text()}`).toBeTruthy();
    expect(hasRow(F.id, Q.id), "PRECONDITION: the ordinary member is enrolled by the bind").toBe(true);
    expect(hasRow(F.id, P.id), "PRECONDITION: the staff member is not — the switch is off").toBe(false);
    expect(hasRow(F.id, A.id), "PRECONDITION: nor the author").toBe(false);

    const on = await sa.put(`/api/admin/competitions/${F.id}`, { headers: H(saCsrf), data: { staff_compete: true } });
    expect(on.ok(), `the switch turns on — no enrolled author, only sealed challenges: ${on.status()} ${await on.text()}`).toBeTruthy();
    // The reconcile is fire-and-forget (the revive path's shape), so the row is
    // eventually consistent.
    await expect.poll(() => hasRow(F.id, P.id), { timeout: 10_000, message: "the flip re-ran group sync and enrolled the staff member" }).toBe(true);
    // CONTROL: the same pass must REFUSE the author — the poll above proves the
    // pass ran to the point of writing P's row, and A is judged in the same loop.
    expect(hasRow(F.id, A.id), "CONTROL: the author of one of its challenges still holds no row").toBe(false);
    expect(hasRow(F.id, Q.id), "CONTROL: the ordinary member's row survives").toBe(true);
    await A.api.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("POST /api/admin/invitations — the existing-account path", () => {

  test("inviting existing accounts: a staff-tagged one is skipped (and counted) on a switch-OFF event, enrolled on a switch-ON one; an author is skippedAuthors; a skipped address never rides alreadyAssigned", async () => {
    const F = await makeEvent(sa, saCsrf, "invite", false);
    const E = await makeEvent(sa, saCsrf, "invite", true);
    const staff = await makeStaffParticipant(sa, saCsrf, "invstaff");
    const plain = await makeParticipant(sa, saCsrf, "invplain");
    const author = await makeAdmin(sa, saCsrf, "invauthor");
    await sealedTaskAssigned(author, "invauthored", [E.id]);

    const ob = await invite(sa, saCsrf, [staff.email, plain.email], [F.id]);
    expect(ob.skippedStaff, "the staff enrolment is withheld and REPORTED").toBe(1);
    expect(ob.skippedAuthors, "…as a spectator, not an author").toBe(0);
    expect(ob.skippedPrivileged).toBe(0);
    expect(ob.assigned, "only the ordinary account was enrolled").toBe(1);
    expect(ob.invited, "no invitation rows — both accounts already exist").toBe(0);
    // A SKIPPED address is not "already a member": the pre-fix response said
    // `skippedStaff:1` AND listed the address under `alreadyAssigned`, and the
    // dialog told the organiser there was nothing to do. Mutation M4a.
    expect(ob.alreadyAssigned || [], "a staff skip must not be reported as already-a-member").not.toContain(staff.email);
    expect(ob.alreadyAssigned || [], "nobody in this request was already a member").toHaveLength(0);
    expect(hasRow(F.id, plain.id), "the ordinary account holds a row").toBe(true);
    expect(hasRow(F.id, staff.id), "the staff account does NOT").toBe(false);

    const nb = await invite(sa, saCsrf, [staff.email, plain.email], [E.id]);
    expect(nb.skippedStaff, "nothing withheld on a switch-ON event").toBe(0);
    expect(nb.skippedAuthors).toBe(0);
    expect(nb.assigned, "both enrolled").toBe(2);
    expect(nb.alreadyAssigned || []).toHaveLength(0);
    expect(hasRow(E.id, plain.id)).toBe(true);
    expect(hasRow(E.id, staff.id), "CONTROL: the same staff account IS enrolled where staff compete").toBe(true);

    // The author of one of E's challenges is withheld too — counted as an
    // AUTHOR, not as a staff skip, so the dialog names the right reason; the
    // assign route is where the challenges are listed by title.
    const ab = await invite(sa, saCsrf, [author.email], [E.id]);
    expect(ab.skippedAuthors, "the author is withheld, and counted as an author").toBe(1);
    expect(ab.skippedStaff, "…not as a staff skip — the event lets staff compete").toBe(0);
    expect(ab.skippedPrivileged, "…nor as a privileged peer — the caller is the superadmin").toBe(0);
    expect(ab.assigned).toBe(0);
    expect(ab.alreadyAssigned || [], "an author skip must not be reported as already-a-member").not.toContain(author.email);
    expect(hasRow(E.id, author.id)).toBe(false);

    // CONTROL for the accounting: a GENUINE re-invite of an existing member IS
    // reported as already-a-member, so `alreadyAssigned` did not simply go empty.
    const re = await invite(sa, saCsrf, [plain.email], [E.id]);
    expect(re.assigned).toBe(0);
    expect(re.alreadyAssigned, "CONTROL: an account already enrolled everywhere named is reported as such").toContain(plain.email);
    await author.api.dispose();
  });

  test("a peer admin invited to a switch-ON event by a REGULAR admin is skippedPrivileged (no row); a superadmin caller enrols them; the caller may invite THEMSELVES", async () => {
    // The assign door's peer-admin rule, one door over (CHANGES §5): enrolling
    // an admin or superadmin as a COMPETITOR is managing that account, which a
    // regular admin may not do — but anybody may enrol themselves, and a
    // superadmin may enrol anybody. Mutation M4b.
    const E = await makeEvent(sa, saCsrf, "invpriv", true);
    const F = await makeEvent(sa, saCsrf, "invpriv", false);
    const actor = await makeAdmin(sa, saCsrf, "invprivactor");
    const peer = await makeAdmin(sa, saCsrf, "invprivpeer");
    const plain = await makeParticipant(sa, saCsrf, "invprivplain");

    const a = await invite(actor.api, actor.csrf, [peer.email], [E.id]);
    expect(a.skippedPrivileged, "a fellow admin is a privileged target for a regular admin").toBe(1);
    expect(a.skippedStaff, "not a staff skip — the event lets staff compete").toBe(0);
    expect(a.skippedAuthors).toBe(0);
    expect(a.assigned).toBe(0);
    expect(a.alreadyAssigned || [], "a privileged skip is not already-a-member either").not.toContain(peer.email);
    expect(hasRow(E.id, peer.id), "no row written").toBe(false);

    // On a switch-OFF event the STAFF rule answers first, as on the assign door.
    const off = await invite(actor.api, actor.csrf, [peer.email], [F.id]);
    expect(off.skippedStaff, "switch OFF: the staff rule answers before the privilege rule").toBe(1);
    expect(off.skippedPrivileged).toBe(0);
    expect(hasRow(F.id, peer.id)).toBe(false);

    // CONTROL: the same caller enrolling an ORDINARY participant is unaffected.
    const ctl = await invite(actor.api, actor.csrf, [plain.email], [E.id]);
    expect(ctl.assigned, "CONTROL: a regular admin still enrols an ordinary participant by invitation").toBe(1);
    expect(ctl.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, plain.id)).toBe(true);

    // CONTROL (b): an UNTAGGED event admin is NOT a privileged target on this
    // door either — the rule is the admin/superadmin ROLE, never "every
    // non-participant role". Mutation M9.
    const ea = await makeParticipant(sa, saCsrf, "invpriveventadmin");
    await grantEventAdmin(sa, saCsrf, (await makeCompetition(sa, saCsrf, "invpriv-organised")).id, ea.id);
    const eaRow = await adminRow(sa, ea.id);
    expect(eaRow.role, "PRECONDITION: the target really is event_admin").toBe("event_admin");
    expect(eaRow.tags, "PRECONDITION: and NOT tagged staff").not.toContain("staff");
    const eaInv = await invite(actor.api, actor.csrf, [ea.email], [E.id]);
    expect(eaInv.assigned, "CONTROL: a regular admin enrols an untagged event admin by invitation").toBe(1);
    expect(eaInv.skippedPrivileged, "an event admin is not a privileged target").toBe(0);
    expect(hasRow(E.id, ea.id)).toBe(true);

    // The superadmin enrols the admin the regular admin could not.
    const bySa = await invite(sa, saCsrf, [peer.email], [E.id]);
    expect(bySa.assigned, "the superadmin enrols an admin by invitation").toBe(1);
    expect(bySa.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, peer.id)).toBe(true);

    // Self LAST — it makes the caller a competitor in E.
    const self = await invite(actor.api, actor.csrf, [actor.email], [E.id]);
    expect(self.assigned, "a regular admin invites THEMSELVES into the event they will compete in").toBe(1);
    expect(self.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, actor.id)).toBe(true);
    await actor.api.dispose(); await peer.api.dispose();
  });

  test("the invitation's GROUP door keeps the peer-admin rule: a REGULAR admin's invitation cannot put an admin into a group (skippedPrivilegedGroups); a superadmin's can; themselves and a plain participant are unaffected", async () => {
    // Round 3 (S13): only a superadmin may put an admin/superadmin account into
    // a group (`_privilegedGroupTargets` on the Groups-tab routes), because a
    // group live-syncs into every event it is bound to — compete events
    // included, where the sync asks no tier question. Inviting the address
    // with a group ticked was the one door a regular admin could reach it
    // through. Skipped and COUNTED, never silent (the v7.21.2 class).
    const F = await makeEvent(sa, saCsrf, "invgrp", false);
    const actor = await makeAdmin(sa, saCsrf, "invgrpactor");
    const peer = await makeAdmin(sa, saCsrf, "invgrppeer");
    const plain = await makeParticipant(sa, saCsrf, "invgrpplain");
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq("SC invgrp"), userIds: [] } });
    expect(g.ok(), `group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const gid = (await g.json()).group.id;
    expect(gid, "PRECONDITION: the group has an id").toBeTruthy();
    const inGroup = uid => !!withDb(db => db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, uid));
    const inviteG = (api, csrf, emails) => api.post("/api/admin/invitations", { headers: H(csrf), data: { emails, competitionIds: [F.id], groupIds: [gid] } });
    try {
      // A regular admin naming a fellow admin with the group ticked: the group
      // add is withheld and counted; the (switch-OFF) event skip is the staff
      // rule's, as before.
      const r1 = await inviteG(actor.api, actor.csrf, [peer.email]);
      expect(r1.ok(), `actor invites peer: ${r1.status()} ${await r1.text()}`).toBeTruthy();
      const b1 = await r1.json();
      expect(b1.skippedPrivilegedGroups, "the group add on an admin target is withheld from a regular admin, and counted").toBe(1);
      expect(inGroup(peer.id), "no group_members row").toBe(false);
      expect(hasRow(F.id, peer.id), "(and no event row either — the staff rule on a switch-OFF event)").toBe(false);
      // CONTROL 1 — the same caller, a PLAIN participant: the group add lands.
      const r2 = await inviteG(actor.api, actor.csrf, [plain.email]);
      const b2 = await r2.json();
      expect(b2.skippedPrivilegedGroups, "CONTROL: an ordinary participant is not a privileged target").toBe(0);
      expect(inGroup(plain.id), "CONTROL: …and joins the group").toBe(true);
      // CONTROL 2 — the same caller, THEMSELVES: not a privileged target.
      const r3 = await inviteG(actor.api, actor.csrf, [actor.email]);
      const b3 = await r3.json();
      expect(b3.skippedPrivilegedGroups, "CONTROL: anybody may put THEMSELVES in a group by invitation").toBe(0);
      expect(inGroup(actor.id)).toBe(true);
      // CONTROL 3 — a SUPERADMIN caller puts the admin in the group.
      const r4 = await inviteG(sa, saCsrf, [peer.email]);
      const b4 = await r4.json();
      expect(b4.skippedPrivilegedGroups, "CONTROL: a superadmin may").toBe(0);
      expect(inGroup(peer.id), "CONTROL: …and the row lands").toBe(true);
    } finally {
      await actor.api.dispose(); await peer.api.dispose();
    }
  });

  test("a BLOCKED or UNAPPROVED staff-tagged account invited to either kind of event is a lifecycle skip, never a staff skip, and rides neither alreadyAssigned; once the lifecycle passes, the staff rule answers", async () => {
    // Round-3 change (c) at THIS door: the blocked/unapproved checks sit
    // OUTSIDE the per-event loop, above `staffRowRefusal`, so a blocked staff
    // invitee on a switch-OFF event is "blocked", not "staff". The one
    // lifecycle arm the suite had here (functional-security-c) drives an
    // UNTAGGED account and so cannot see the ordering. Mutation M11.
    const F = await makeEvent(sa, saCsrf, "invlife", false);
    const E = await makeEvent(sa, saCsrf, "invlife", true);
    const blocked = await makeStaffParticipant(sa, saCsrf, "invblocked");
    const b = await sa.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(saCsrf) });
    expect(b.ok(), `block: ${b.status()} ${await b.text()}`).toBeTruthy();
    expect((await adminRow(sa, blocked.id)).blocked, "PRECONDITION: the block took").toBeTruthy();
    const pending = await registerOnly("invpending");
    await tagStaff(sa, saCsrf, pending.id);
    expect((await adminRow(sa, pending.id)).approved, "PRECONDITION: still unapproved after tagging").toBeFalsy();

    for (const [comp, label] of [[F, "switch-OFF"], [E, "switch-ON"]]) {
      const d = await invite(sa, saCsrf, [blocked.email], [comp.id]);
      expect(d.skippedBlocked, `${label}: the lifecycle answers first`).toBe(1);
      expect(d.skippedStaff, `${label}: not a staff skip`).toBe(0);
      expect(d.skippedAuthors).toBe(0);
      expect(d.skippedPrivileged).toBe(0);
      expect(d.assigned).toBe(0);
      expect(d.alreadyAssigned || [], `${label}: a blocked skip is not already-a-member`).not.toContain(blocked.email);
      expect(hasRow(comp.id, blocked.id)).toBe(false);

      const u = await invite(sa, saCsrf, [pending.email], [comp.id]);
      expect(u.skippedUnapproved, `${label}: the approval queue answers first`).toBe(1);
      expect(u.skippedStaff, `${label}: not a staff skip`).toBe(0);
      expect(u.assigned).toBe(0);
      expect(u.alreadyAssigned || [], `${label}: an unapproved skip is not already-a-member`).not.toContain(pending.email);
      expect(hasRow(comp.id, pending.id)).toBe(false);
    }

    // CONTROLS: lift the lifecycle (the block route is a TOGGLE; approve needs
    // a verified account) and the SAME accounts meet the staff rule — enrolled
    // on the compete event, a staff skip on the other.
    const ub = await sa.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(saCsrf) });
    expect(ub.ok(), `unblock: ${ub.status()} ${await ub.text()}`).toBeTruthy();
    expect((await adminRow(sa, blocked.id)).blocked, "PRECONDITION: the toggle really unblocked").toBeFalsy();
    const v = await sa.post(`/api/admin/participants/${pending.id}/verify`, { headers: H(saCsrf) });
    expect(v.ok(), `verify: ${v.status()} ${await v.text()}`).toBeTruthy();
    const ap = await sa.post(`/api/admin/participants/${pending.id}/approve`, { headers: H(saCsrf) });
    expect(ap.ok(), `approve: ${ap.status()} ${await ap.text()}`).toBeTruthy();
    for (const u of [blocked, pending]) {
      const on = await invite(sa, saCsrf, [u.email], [E.id]);
      expect(on.assigned, `CONTROL: ${u.email} is enrolled on the compete event once the lifecycle passes`).toBe(1);
      expect(on.skippedBlocked + on.skippedUnapproved).toBe(0);
      expect(hasRow(E.id, u.id)).toBe(true);
      const off = await invite(sa, saCsrf, [u.email], [F.id]);
      expect(off.skippedStaff, "CONTROL: …and is a staff skip on the switch-OFF event").toBe(1);
      expect(off.alreadyAssigned || []).not.toContain(u.email);
      expect(hasRow(F.id, u.id)).toBe(false);
    }
  });

  test("round 3 (b): a competitor may not put people into a group bound to the event they compete in through a newGroups NAME either — refused BEFORE any group is created; a non-competitor's identical invitation lands; a name bound nowhere is created", async () => {
    // The `groupIds` half of this gate is locked by staff-compete-lock (its
    // M11); the `newGroups` half — a NAME that resolves to an EXISTING group
    // bound to an event the actor competes in — had no arm anywhere: deleting
    // the pre-loop left every staff-compete spec green while a competing admin
    // enrolled a participant into their own compete event through a group name
    // (the reconcile after an invitation is AWAITED, so the row lands before
    // the response). The create loop itself carries no competitor check, so
    // the pre-loop is the ONLY guard on that door. Mutations M12a / M12b.
    const E = await makeEvent(sa, saCsrf, "invgrp", true);
    const F = await makeEvent(sa, saCsrf, "invgrp", false);
    const actor = await makeAdmin(sa, saCsrf, "invgrpactor");
    const other = await makeAdmin(sa, saCsrf, "invgrpother");
    const invitee = await makeParticipant(sa, saCsrf, "invgrpinvitee");
    const invitee2 = await makeParticipant(sa, saCsrf, "invgrpinvitee2");
    const invitee3 = await makeParticipant(sa, saCsrf, "invgrpinvitee3");
    expect((await assign(actor.api, actor.csrf, [actor.id], [E.id])).assigned, "PRECONDITION: the actor competes in E (the ordinary self-enrol)").toBe(1);
    // G, bound to E by the built-in superadmin, which is never a competitor.
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq("SC bound"), userIds: [] } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const G = (await g.json()).group;
    const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [G.id], competitionIds: [E.id] } });
    expect(bind.ok(), `bind: ${bind.status()} ${await bind.text()}`).toBeTruthy();
    expect((await bind.json()).groupsBound, "PRECONDITION: G is bound to E").toBe(1);
    const groupNamed = name => withDb(db => db.prepare("SELECT id FROM groups WHERE name=?").get(name)) || null;
    const inGroup = (gid, uid) => !!withDb(db => db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, uid));
    const invRows = email => withDb(db => db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE LOWER(email)=LOWER(?)").get(email)).n;

    // THE REFUSAL. Names in THAT order — the brand-new one FIRST — so a check
    // moved into the create loop (after `findGroupByName`) would have created
    // it before the second name's refusal. F is switch-OFF, so no other refusal
    // can answer for this one.
    const brandNew = uniq("brand-new");
    const r = await actor.api.post("/api/admin/invitations", { headers: H(actor.csrf), data: { emails: [invitee.email], competitionIds: [F.id], newGroups: [brandNew, G.name] } });
    expect(r.status(), `a competitor names a bound group through newGroups: ${await r.text()}`).toBe(403);
    const body = await r.json();
    expect(body.code).toBe("competitor_cannot_edit");
    expect(body.competitionId, "the refusal names the event the actor competes in").toBe(E.id);
    expect(groupNamed(brandNew), "the FIRST name was not created — the refusal precedes the create loop").toBeNull();
    expect(inGroup(G.id, invitee.id), "the invitee was not put into the bound group").toBe(false);
    expect(hasRow(E.id, invitee.id), "…and holds no row on the actor's own board").toBe(false);
    expect(hasRow(F.id, invitee.id), "nor on the event the request named — nothing was written at all").toBe(false);
    expect(invRows(invitee.email), "no invitation row").toBe(0);

    // CONTROL (1): a NON-competing admin of the same tier, the identical body.
    const brandNew2 = uniq("brand-new");
    const ok = await other.api.post("/api/admin/invitations", { headers: H(other.csrf), data: { emails: [invitee2.email], competitionIds: [F.id], newGroups: [brandNew2, G.name] } });
    expect(ok.status(), `a non-competitor's identical invitation: ${await ok.text()}`).toBe(200);
    expect((await ok.json()).assigned, "CONTROL: the invitee was enrolled").toBe(1);
    expect(groupNamed(brandNew2), "CONTROL: the brand-new group was created").not.toBeNull();
    expect(inGroup(G.id, invitee2.id), "CONTROL: the invitee is in the bound group").toBe(true);
    expect(hasRow(E.id, invitee2.id), "CONTROL: …and group sync enrolled them on E (awaited before the response)").toBe(true);
    expect(hasRow(F.id, invitee2.id), "CONTROL: and on the event the request named").toBe(true);

    // CONTROL (2): the competitor with a name bound NOWHERE — a group created
    // here is bound to nothing and must not be refused.
    const loose = uniq("loose");
    const r2 = await actor.api.post("/api/admin/invitations", { headers: H(actor.csrf), data: { emails: [invitee3.email], competitionIds: [F.id], newGroups: [loose] } });
    expect(r2.status(), `a competitor creates an unbound group by invitation: ${await r2.text()}`).toBe(200);
    expect((await r2.json()).assigned).toBe(1);
    const looseRow = groupNamed(loose);
    expect(looseRow, "CONTROL: the unbound group was created").not.toBeNull();
    expect(inGroup(looseRow.id, invitee3.id), "CONTROL: …with the invitee in it").toBe(true);
    expect(hasRow(F.id, invitee3.id)).toBe(true);
    expect(hasRow(E.id, invitee3.id), "and nothing reached the actor's board").toBe(false);
    await actor.api.dispose(); await other.api.dispose();
  });

  test("the invitation door must AGREE with the assign door about a peer-admin AUTHOR invited by a REGULAR admin: the privileged rule answers first", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the existing-account loop asks the privileged rule BEFORE the author
    // rule (spectator → privileged → author), matching the assign door.
    const E = await makeEvent(sa, saCsrf, "invprec", true);
    const actor = await makeAdmin(sa, saCsrf, "invprecactor");
    const peerAuthor = await makeAdmin(sa, saCsrf, "invprecpeerauthor");
    await sealedTaskAssigned(peerAuthor, "invprecauthored", [E.id]);

    // The reference: the assign door, same actor, same target, same event.
    const ref = await assign(actor.api, actor.csrf, [peerAuthor.id], [E.id]);
    expect(ref.skippedPrivileged, "REFERENCE: the assign door answers privileged").toBe(1);
    expect(ref.skippedAuthors).toHaveLength(0);

    const byActor = await invite(actor.api, actor.csrf, [peerAuthor.email], [E.id]);
    expect(byActor.skippedPrivileged, "the invitation door must answer the same reason as the assign door").toBe(1);
    expect(byActor.skippedAuthors, "…and not the author rule").toBe(0);
    expect(byActor.assigned).toBe(0);
    expect(hasRow(E.id, peerAuthor.id)).toBe(false);

    // CONTROL: the superadmin hears the author on BOTH doors.
    const saAssign = await assign(sa, saCsrf, [peerAuthor.id], [E.id]);
    expect(saAssign.skippedAuthors.map(a => a.competitionId)).toEqual([E.id]);
    const saInv = await invite(sa, saCsrf, [peerAuthor.email], [E.id]);
    expect(saInv.skippedAuthors, "CONTROL: the superadmin caller is refused for authorship by invitation").toBe(1);
    expect(saInv.skippedPrivileged).toBe(0);
    expect(hasRow(E.id, peerAuthor.id)).toBe(false);
    await actor.api.dispose(); await peerAuthor.api.dispose();
  });

  test("a staff-tagged account that ALREADY holds a row on a switch-OFF event is re-invited as already-a-member, not skipped as staff", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the existing-account loop reads the held row (`_heldInv`) first, so a
    // staff member who already holds a row takes the idempotent path.
    const F = await makeEvent(sa, saCsrf, "heldinv", false);
    const p = await makeParticipant(sa, saCsrf, "heldinv");
    expect((await assign(sa, saCsrf, [p.id], [F.id])).assigned, "PRECONDITION: enrolled as an ordinary participant first").toBe(1);
    await tagStaff(sa, saCsrf, p.id);
    expect(hasRow(F.id, p.id), "PRECONDITION: the tag removed no row").toBe(true);

    const d = await invite(sa, saCsrf, [p.email], [F.id]);
    expect(d.skippedStaff, "a member is not a staff skip").toBe(0);
    expect(d.assigned).toBe(0);
    expect(d.alreadyAssigned || [], "the ordinary already-a-member answer").toContain(p.email);
    expect(hasRow(F.id, p.id)).toBe(true);

    // CONTROL: with NO row on another switch-OFF event the same account is still a staff skip.
    const F2 = await makeEvent(sa, saCsrf, "heldinv2", false);
    const d2 = await invite(sa, saCsrf, [p.email], [F2.id]);
    expect(d2.skippedStaff, "CONTROL: a non-member staff account is still skipped").toBe(1);
    expect(d2.alreadyAssigned || []).not.toContain(p.email);
    expect(hasRow(F2.id, p.id)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("POST /api/admin/import/participants — rehydrated memberships", () => {

  const v2 = (participants, resolutions) => ({ data: { type: "hackarena-participants", version: 2, participants }, resolutions });

  /** A v2 payload row for an EXISTING account, built off its admin row. */
  async function rowFor(u, tags, competitions) {
    const r = await adminRow(sa, u.id);
    return {
      nickname: r.nickname, email: r.email, first_name: r.first_name, last_name: r.last_name,
      company: r.company, title: r.title, country: r.country, timezone: r.timezone,
      // The OVERWRITE path deletes and re-inserts user_tags from the payload —
      // omit this and the import itself un-staffs the account.
      tags,
      competitions: competitions.map(c => ({ competition_name: c.name })),
    };
  }

  /** A v2 payload row for a BRAND-NEW account (the create branch rehydrates too). */
  function newRow(label, tags, competitions) {
    const tag = uniq(label);
    return {
      nickname: `imp_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40), email: `ea-${tag}@acme.com`,
      first_name: "Import", last_name: String(label), company: "Acme", title: "Engineer",
      country: "GB", timezone: "Europe/London", tags,
      competitions: competitions.map(c => ({ competition_name: c.name })),
    };
  }

  /** Dry-run, then execute with every conflict resolved as `overwrite`. */
  async function importOverwriting(api, csrf, participants) {
    const dry = await api.post("/api/admin/import/participants", { headers: H(csrf), data: { data: v2(participants).data } });
    expect(dry.ok(), `dry run: ${dry.status()} ${await dry.text()}`).toBeTruthy();
    const d1 = await dry.json();
    expect(d1.dryRun).toBe(true);
    const resolutions = {};
    for (const c of d1.conflicts) resolutions[String(c.index)] = "overwrite";
    const run = await api.post("/api/admin/import/participants", { headers: H(csrf), data: v2(participants, resolutions) });
    expect(run.ok(), `import: ${run.status()} ${await run.text()}`).toBeTruthy();
    return { dry: d1, result: await run.json() };
  }

  const userIdByEmail = email => withDb(db => db.prepare("SELECT id FROM users WHERE email=?").get(email))?.id ?? null;

  test("a v2 row for a staff-tagged account: the switch-OFF membership is skipped as staff_not_competing, the switch-ON one lands; an author is author_competes; an ordinary account gets both", async () => {
    const F = await makeEvent(sa, saCsrf, "import", false);
    const E = await makeEvent(sa, saCsrf, "import", true);
    const staff = await makeStaffParticipant(sa, saCsrf, "impstaff");
    const plain = await makeParticipant(sa, saCsrf, "impplain");
    const author = await makeAdmin(sa, saCsrf, "impauthor");
    await sealedTaskAssigned(author, "impauthored", [E.id]);
    const participants = [await rowFor(staff, ["staff"], [F, E]), await rowFor(plain, [], [F, E]), await rowFor(author, ["staff"], [F, E])];

    const { dry, result: d } = await importOverwriting(sa, saCsrf, participants);
    expect(dry.conflicts.map(c => c.index).sort(), "PRECONDITION: all three rows are existing accounts").toEqual([0, 1, 2]);
    expect(d.overwritten, "all three rows overwritten").toBe(3);
    const skips = d.skipped_memberships || [];
    expect(skips, "the staff account's switch-OFF membership is skipped, with its reason").toContainEqual(
      { email: staff.email, competition_name: F.name, reason: "staff_not_competing" });
    expect(skips, "the author's compete-event membership is skipped, with its reason").toContainEqual(
      { email: author.email, competition_name: E.name, reason: "author_competes" });
    expect(skips, "…and the author's switch-OFF membership is a staff skip, not an author one").toContainEqual(
      { email: author.email, competition_name: F.name, reason: "staff_not_competing" });
    expect(skips.filter(s => s.email === plain.email), "CONTROL: nothing of the ordinary account's is skipped").toHaveLength(0);
    expect(skips.filter(s => s.email === staff.email), "the staff account loses exactly one of two").toHaveLength(1);
    expect(skips.filter(s => s.reason === "actor_competes"), "the BUILT-IN superadmin has no row and competes nowhere — never an actor skip").toHaveLength(0);
    // memberships_imported: plain F + plain E + staff E = 3.
    expect(d.memberships_imported, "three memberships landed").toBe(3);

    expect(hasRow(F.id, staff.id), "staff: no row on the switch-OFF event").toBe(false);
    expect(hasRow(E.id, staff.id), "staff: a row on the switch-ON event").toBe(true);
    expect(hasRow(F.id, plain.id), "CONTROL: ordinary, switch-OFF").toBe(true);
    expect(hasRow(E.id, plain.id), "CONTROL: ordinary, switch-ON").toBe(true);
    expect(hasRow(E.id, author.id), "the author holds no row on the event with their challenge").toBe(false);
    expect((await adminRow(sa, staff.id)).tags, "the import kept the staff tag — the skip was for the right reason").toContain("staff");
    await author.api.dispose();
  });

  test("an account that becomes staff IN THE SAME IMPORT is skipped on the switch-OFF event — the tag is read off the table, not the 2 s cache; a brand-new staff row is too", async () => {
    // server.js `_rehydrateMemberships` reads `user_tags` directly (`_staffNow`)
    // because the overwrite rewrote the tags a few statements earlier and the
    // `isStaff` cache is busted only at the END of the pass. The v1 arm above
    // tags its fixture BEFORE the import, so cache and table agree and a
    // mutation back to `isStaff(userId)` passes it. Here the account is UNTAGGED
    // going in and the payload row carries the tag. Mutation M3.
    const F = await makeEvent(sa, saCsrf, "lateimp", false);
    const E = await makeEvent(sa, saCsrf, "lateimp", true);
    const W = await makeEvent(sa, saCsrf, "lateimp-warm", false);
    const late = await makeParticipant(sa, saCsrf, "implate");
    expect((await adminRow(sa, late.id)).tags, "PRECONDITION: untagged before the import").not.toContain("staff");
    const participants = [await rowFor(late, ["staff"], [F, E]), newRow("impnew", ["staff"], [F, E])];

    // WARM THE CACHE with the pre-import answer, through a door that reads
    // `isStaff(uid)` (the assign route), immediately before the import. Without
    // this the mutation reads the table fresh and agrees; with it, `isStaff`
    // answers "untagged" for 2 s and the F row lands. The row on W is
    // incidental — W exists only to be assigned to.
    const warm = await assign(sa, saCsrf, [late.id], [W.id]);
    expect(warm.assigned, "PRECONDITION: the cache-warming assign really ran the staff check").toBe(1);

    const { dry, result: d } = await importOverwriting(sa, saCsrf, participants);
    expect(dry.conflicts.map(c => c.index), "PRECONDITION: only the existing account conflicts; the second row is new").toEqual([0]);
    expect(d.overwritten).toBe(1);
    expect(d.imported, "the brand-new row was created").toBe(1);
    const skips = d.skipped_memberships || [];
    expect(skips, "tagged staff by this very import: the switch-OFF membership is skipped").toContainEqual(
      { email: late.email, competition_name: F.name, reason: "staff_not_competing" });
    expect(skips.filter(s => s.email === late.email), "…and only that one").toHaveLength(1);
    expect(hasRow(F.id, late.id), "no row on the switch-OFF event").toBe(false);
    expect(hasRow(E.id, late.id), "a row on the switch-ON event").toBe(true);
    expect((await adminRow(sa, late.id)).tags, "the import really tagged them").toContain("staff");

    // The CREATE branch rehydrates through the same helper: a new staff row is
    // skipped on F and lands on E. (Not a discriminator for M3 — a brand-new id
    // has no cache entry — but the branch had never been driven with a tag.)
    const newId = userIdByEmail(participants[1].email);
    expect(newId, "the new account exists").toBeTruthy();
    expect(skips, "the new staff account's switch-OFF membership is skipped too").toContainEqual(
      { email: participants[1].email, competition_name: F.name, reason: "staff_not_competing" });
    expect(hasRow(F.id, newId)).toBe(false);
    expect(hasRow(E.id, newId), "and its switch-ON membership lands").toBe(true);
    expect((await adminRow(sa, newId)).tags).toContain("staff");
  });

  test("a USER-BACKED superadmin who competes in an event may not import anybody INTO it (actor_competes) — except their own row; elsewhere the file lands", async () => {
    // CHANGES §8: the competitor lock's import door, in this handler's
    // skip-and-report posture. The built-in superadmin has no row and can never
    // trip it (asserted in the arm above), so the importer here is user-backed
    // and enrolled — by the built-in — into a compete event. Mutation M5.
    const E = await makeEvent(sa, saCsrf, "actorimp", true);
    const E2 = await makeEvent(sa, saCsrf, "actorimp-other", true);
    const F = await makeEvent(sa, saCsrf, "actorimp", false);
    const impP = await makeParticipant(sa, saCsrf, "impactor");
    await promote(sa, saCsrf, impP, "superadmin");
    const seat = await assign(sa, saCsrf, [impP.id], [E.id]);
    expect(seat.assigned, "PRECONDITION: the importer competes in E").toBe(1);
    expect(hasRow(E.id, impP.id)).toBe(true);
    const imp = await apiLogin(impP.email, PARTICIPANT_PASS);
    const plain = await makeParticipant(sa, saCsrf, "impactorplain");
    const fresh = newRow("impactornew", [], [E, F]);
    const participants = [
      await rowFor(plain, [], [E, F]),
      fresh,
      // The importer's OWN row: E (already held — INSERT OR IGNORE) and E2 (a
      // compete event they do not compete in). Neither may be an actor skip.
      await rowFor(impP, ["staff"], [E, E2]),
    ];

    const { dry, result: d } = await importOverwriting(imp.api, imp.csrf, participants);
    expect(dry.conflicts.map(c => c.index).sort(), "PRECONDITION: the existing account and the importer conflict; the new row does not").toEqual([0, 2]);
    expect(d.overwritten).toBe(2);
    expect(d.imported).toBe(1);
    const skips = d.skipped_memberships || [];
    expect(skips, "an existing account's row into the importer's event is skipped as actor_competes").toContainEqual(
      { email: plain.email, competition_name: E.name, reason: "actor_competes" });
    expect(skips, "a brand-new account's row into it is skipped the same way").toContainEqual(
      { email: fresh.email, competition_name: E.name, reason: "actor_competes" });
    expect(skips.filter(s => s.email === impP.email), "the importer's OWN row is never an actor skip").toHaveLength(0);
    expect(skips.filter(s => s.competition_name === F.name), "CONTROL: nothing is skipped on an event the importer does not compete in").toHaveLength(0);
    const freshId = userIdByEmail(fresh.email);
    expect(freshId).toBeTruthy();
    expect(hasRow(E.id, plain.id), "no row into the importer's event").toBe(false);
    expect(hasRow(E.id, freshId), "no row into the importer's event for the new account either").toBe(false);
    expect(hasRow(F.id, plain.id), "CONTROL: the same file enrols them elsewhere").toBe(true);
    expect(hasRow(F.id, freshId), "CONTROL: …the new account too").toBe(true);
    expect(hasRow(E.id, impP.id), "the importer's own held row survives").toBe(true);
    expect(hasRow(E2.id, impP.id), "and their own row into another compete event lands").toBe(true);
    expect(d.memberships_imported, "plain F + fresh F + importer E2").toBe(3);
    await imp.api.dispose();
  });

  test("the competitor lock's OTHER import doors: a group bound to the importer's event is dropped (group_actor_competes_dropped), an absence into it is skipped (actor_competes), and the importer's OWN row never takes a file-supplied login_time", async () => {
    // Round 3 (S15). The membership door above is one of THREE board inputs a
    // participant file carries: `groups` live-sync a row into every event the
    // group is bound to (the transitive door every group route refuses for a
    // competitor), and a closed `absence` is SUBTRACTED from solveTimeMs, the
    // placing tie-break. And the importer's own row into a compete event is
    // written — they may enrol themselves at every door — but with `login_time`
    // NULL: that column is the solve-clock anchor, and a chosen anchor is a
    // chosen placing. Each door has its switch-OFF control in the same file.
    const E = await makeEvent(sa, saCsrf, "impdoors", true);
    const E2 = await makeEvent(sa, saCsrf, "impdoors-other", true);   // compete, NOT held by the importer
    const F = await makeEvent(sa, saCsrf, "impdoors", false);
    const impP = await makeParticipant(sa, saCsrf, "impdoors-actor");
    await promote(sa, saCsrf, impP, "superadmin");
    expect((await assign(sa, saCsrf, [impP.id], [E.id])).assigned, "PRECONDITION: the importer competes in E").toBe(1);
    const imp = await apiLogin(impP.email, PARTICIPANT_PASS);
    const rival = await makeParticipant(sa, saCsrf, "impdoors-rival");
    // Two groups: one bound to E (the importer's event), one to F.
    const mkGroup = async (label, comp) => {
      const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq(label), userIds: [] } });
      expect(g.ok(), `group ${label}: ${g.status()} ${await g.text()}`).toBeTruthy();
      const row = (await g.json()).group;
      expect(row && row.id, `PRECONDITION: group ${label} has an id`).toBeTruthy();
      const b = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [row.id], competitionIds: [comp.id] } });
      expect(b.ok(), `bind ${label}: ${b.status()} ${await b.text()}`).toBeTruthy();
      return row;
    };
    const gE = await mkGroup("SC impdoors-E", E);
    const gF = await mkGroup("SC impdoors-F", F);
    const inGroup = (gid, uid) => !!withDb(db => db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, uid));
    const absencesOf = (uid, cid) => withDb(db => db.prepare("SELECT removed_at, login_time FROM competition_user_absences WHERE user_id=? AND competition_id=?").all(uid, cid));
    const loginTimeOf = (uid, cid) => withDb(db => db.prepare("SELECT login_time FROM competition_users WHERE user_id=? AND competition_id=?").get(uid, cid))?.login_time;
    const past = new Date(Date.now() - 3600_000).toISOString();
    const chosen = new Date(Date.now() - 7 * 86400_000).toISOString();   // a week ago — the "chosen anchor"
    try {
      // The rival's membership into F carries a file-supplied `login_time` —
      // the CONTROL for (c): the bind honours the file for everybody else.
      const rivalRow = { ...(await rowFor(rival, [], [])),
        competitions: [{ competition_name: F.name, login_time: chosen }],
        groups: [gE.name, gF.name],
        absences: [
          { competition_name: E.name, removed_at: past, returned_at: null, login_time: past },
          { competition_name: F.name, removed_at: past, returned_at: null, login_time: past },
        ],
      };
      // The importer's OWN rows: into E2, a compete event they do NOT yet hold
      // — the INSERT really runs there, so the bind is what decides the anchor
      // — with a file-supplied `login_time`. The held E row is listed too, so
      // its survival is asserted. (No switch-OFF event for them: a staff-tagged
      // account is not enrollable on one by any door, the import included.)
      const ownRow = { ...(await rowFor(impP, ["staff"], [])), competitions: [
        { competition_name: E.name,  login_time: chosen },
        { competition_name: E2.name, login_time: chosen },
      ] };
      expect(hasRow(E2.id, impP.id), "PRECONDITION: the importer holds no E2 row yet — the INSERT will run").toBe(false);
      const { result: d } = await importOverwriting(imp.api, imp.csrf, [rivalRow, ownRow]);
      expect(d.overwritten).toBe(2);
      // (a) THE GROUP DOOR: the E-bound group is dropped and counted; the
      // F-bound one lands (CONTROL).
      expect(d.group_actor_competes_dropped, "the group bound to the importer's event is dropped, and counted").toBe(1);
      expect(inGroup(gE.id, rival.id), "no group_members row for it").toBe(false);
      expect(inGroup(gF.id, rival.id), "CONTROL: the F-bound group lands").toBe(true);
      expect(hasRow(E.id, rival.id), "…so the rival reached E through neither the groups field nor the sync it drives").toBe(false);
      // (b) THE ABSENCE DOOR: the E absence is skipped as actor_competes — on
      // the ABSENCE ledger, the memberships ledger's sibling (v6.16.9) — and
      // the F absence lands (CONTROL).
      const absSkips = d.skipped_absences || [];
      expect(absSkips, "the absence into the importer's event is an actor skip").toContainEqual(
        { email: rival.email, competition_name: E.name, reason: "actor_competes" });
      expect(absencesOf(rival.id, E.id), "no absence row on E").toEqual([]);
      expect(absencesOf(rival.id, F.id).length, "CONTROL: the F absence lands").toBe(1);
      expect(absSkips.filter(x => x.competition_name === F.name), "CONTROL: …and is not on the ledger").toHaveLength(0);
      // (c) THE OWN ROW: written into E2 (a compete event) WITHOUT the file's
      // anchor; the rival's row into F (CONTROL) WITH it. The held E row
      // survives untouched.
      expect(hasRow(E2.id, impP.id), "the importer's own row into a compete event lands — they may enrol themselves").toBe(true);
      expect(loginTimeOf(impP.id, E2.id), "…but took NO file-supplied login_time: a chosen anchor is a chosen placing").toBeNull();
      expect(hasRow(F.id, rival.id), "CONTROL: the rival's F row lands").toBe(true);
      expect(loginTimeOf(rival.id, F.id), "CONTROL: …with the file's anchor — the bind honours the file for everybody else").toBe(chosen);
      expect(hasRow(E.id, impP.id), "the importer's held E row survives").toBe(true);
      const memSkips = d.skipped_memberships || [];
      expect(memSkips.filter(x => x.email === impP.email), "the importer's own rows are never actor skips").toHaveLength(0);
    } finally {
      await imp.api.dispose();
    }
  });

  test("a v2 row for a staff-tagged account that ALREADY holds the switch-OFF membership: the INSERT OR IGNORE no-op, not a staff_not_competing entry about a member", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `_rehydrateMemberships` applies its staff skip only to a row NOT already
    // held (`!_heldRow`), and binds `login_time` NULL for the acting
    // superadmin's own row into a compete event.
    const F = await makeEvent(sa, saCsrf, "heldimp", false);
    const F2 = await makeEvent(sa, saCsrf, "heldimp2", false);
    const p = await makeParticipant(sa, saCsrf, "heldimp");
    expect((await assign(sa, saCsrf, [p.id], [F.id])).assigned, "PRECONDITION: enrolled as an ordinary participant first").toBe(1);
    await tagStaff(sa, saCsrf, p.id);
    expect(hasRow(F.id, p.id), "PRECONDITION: the tag removed no row").toBe(true);

    const { result: d } = await importOverwriting(sa, saCsrf, [await rowFor(p, ["staff"], [F, F2])]);
    expect(d.overwritten).toBe(1);
    const skips = (d.skipped_memberships || []).filter(x => x.email === p.email);
    expect(skips, "the HELD membership is not reported as a skip about a non-member").not.toContainEqual(
      { email: p.email, competition_name: F.name, reason: "staff_not_competing" });
    // CONTROL: the membership the account does NOT hold is still a staff skip.
    expect(skips, "CONTROL: the switch-OFF membership they do not hold is skipped").toContainEqual(
      { email: p.email, competition_name: F2.name, reason: "staff_not_competing" });
    expect(hasRow(F.id, p.id), "the held row survives the import").toBe(true);
    expect(hasRow(F2.id, p.id)).toBe(false);
    expect((await adminRow(sa, p.id)).tags, "the import kept the tag").toContain("staff");
  });

  test("v8.14.4 (R1): an importer may not OVERWRITE the account of somebody they compete alongside — the Block they are refused is not done through a file; CONTROL: a non-rival is, and the built-in superadmin may", async () => {
    // External audit R1, reproduced as reported: the Block button answered 403
    // and the same importer blocked the same account with an import overwrite.
    // An overwrite writes `blocked`, `verified`, `approved`, the denial, the
    // role and the whole tag set — every account door `competitorRivalDenied`
    // shuts — so the whole row is skipped and counted (`rival_skipped`).
    const E = await makeEvent(sa, saCsrf, "rivalimp", true);
    const impP = await makeParticipant(sa, saCsrf, "rivalimp-actor");
    await promote(sa, saCsrf, impP, "superadmin");
    const rival = await makeParticipant(sa, saCsrf, "rivalimp-rival");
    const other = await makeParticipant(sa, saCsrf, "rivalimp-other");
    expect((await assign(sa, saCsrf, [impP.id, rival.id], [E.id])).assigned, "PRECONDITION: the importer and the rival both compete in E").toBe(2);
    const imp = await apiLogin(impP.email, PARTICIPANT_PASS);
    const account = (u) => withDb(db => ({
      blocked: db.prepare("SELECT blocked FROM users WHERE id=?").get(u.id).blocked,
      benchmark: !!db.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag='benchmark'").get(u.id),
    }));
    try {
      const b = await imp.api.post(`/api/admin/participants/${rival.id}/block`, { headers: H(imp.csrf), data: {} });
      expect(b.status(), `PRECONDITION: the Block door refuses the importer: ${await b.text()}`).toBe(403);
      expect((await b.json()).code).toBe("competitor_cannot_edit");
      // Blocked, and tagged benchmark (off the ranked board): two rival doors in one row.
      const blocking = async (u) => ({ ...(await rowFor(u, ["benchmark"], [])), blocked: 1 });
      // The rival's row also carries what the import counts or stores BEFORE it
      // writes a row (a role grant, a denial to normalise, an uploaded avatar,
      // which lands in `images` with nothing to sweep it): a skipped row must
      // leave none of them behind.
      // The denial carries no `blocked`, so a row that is NOT skipped is
      // normalised to blocked (counted in `denied_normalised`): the other
      // account's row is the CONTROL that it is.
      const denied = new Date().toISOString();
      const rivalRow = { ...(await rowFor(rival, ["benchmark"], [])), role: "admin", denied_at: denied, avatar: pngDataUri(48, "rival-avatar") };
      const otherRow = { ...(await rowFor(other, ["benchmark"], [])), denied_at: denied };
      const images = () => withDb(db => db.prepare("SELECT COUNT(*) c FROM images").get().c);
      const imagesBefore = images();
      const { result: d } = await importOverwriting(imp.api, imp.csrf, [rivalRow, otherRow]);
      expect(d.rival_skipped, "the rival's row is skipped, and counted").toBe(1);
      expect(d.overwritten, "CONTROL: the other account in the same file is overwritten").toBe(1);
      expect(account(rival), "the rival is neither blocked nor taken off the board").toEqual({ blocked: 0, benchmark: false });
      expect(account(other), "CONTROL: the same row blocks and tags a non-rival").toEqual({ blocked: 1, benchmark: true });
      expect({ role_grants: d.role_grants, denied_normalised: d.denied_normalised }, "the skipped row is counted as neither a grant nor a normalised denial; the other row's denial is (CONTROL)").toEqual({ role_grants: 0, denied_normalised: 1 });
      expect(images(), "and its avatar was never stored").toBe(imagesBefore);
      expect((await adminRow(sa, rival.id)).role, "the rival keeps their role").toBe("participant");
      // CONTROL: the built-in superadmin competes nowhere, so nobody is its rival.
      const { result: d2 } = await importOverwriting(sa, saCsrf, [await blocking(rival)]);
      expect(d2.rival_skipped).toBe(0);
      expect(d2.overwritten).toBe(1);
      expect(account(rival), "CONTROL: a non-competitor's identical import lands").toEqual({ blocked: 1, benchmark: true });
    } finally { await imp.api.dispose(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("POST /api/admin/import/tasks — the competitor lock's overwrite door", () => {

  const taskRow = (title, extra = {}) => ({ title, description: "overwritten by import", difficulty: "easy", answer_type: "text", correct_answer: "z", status: "published", ...extra });
  const descriptionOf = id => withDb(db => db.prepare("SELECT description FROM tasks WHERE id=?").get(id))?.description ?? null;

  /** Dry-run, then execute with every conflict resolved as `overwrite`. */
  async function importTasksOverwriting(api, csrf, tasks) {
    const body = { type: "hackarena-tasks", version: 1, tasks };
    const dry = await api.post("/api/admin/import/tasks", { headers: H(csrf), data: { data: body } });
    expect(dry.ok(), `tasks dry run: ${dry.status()} ${await dry.text()}`).toBeTruthy();
    const d1 = await dry.json();
    expect(d1.dryRun).toBe(true);
    const resolutions = {};
    for (const c of d1.conflicts) resolutions[String(c.index)] = "overwrite";
    const run = await api.post("/api/admin/import/tasks", { headers: H(csrf), data: { data: body, resolutions } });
    expect(run.ok(), `tasks import: ${run.status()} ${await run.text()}`).toBeTruthy();
    return { dry: d1, result: await run.json() };
  }

  test("the AUTHOR of a sealed challenge held by an event the importer competes in cannot overwrite it (competitor_skipped); a non-author competitor is the seal's skip; the author's other challenge and a new row land", async () => {
    // THE STATE IS UNREACHABLE THROUGH EVERY API DOOR, and this test says so
    // before building it by hand. The seal invariant is closed from all sides:
    // assigning the author to a compete event, assigning their challenge to
    // one, and — the door this fixture used to take — turning the switch ON
    // while an enrolled author's challenge is held (`staff_compete_enrolled_
    // authors`) are all refused. So `competitor_skipped` is DEFENCE IN DEPTH,
    // reachable only by a row written straight into SQLite (the v8.10.1
    // restore-test shape: "neither live door can reach it any more"). The
    // refusal is asserted as a PRECONDITION, or a future door that re-admits
    // the state would pass here in silence. Mutation M6.
    const E = await makeEvent(sa, saCsrf, "taskimp", false, { start_time: new Date(Date.now() + 3_600_000).toISOString() });
    const authorP = await makeParticipant(sa, saCsrf, "taskimpauthor");
    const seat = await assign(sa, saCsrf, [authorP.id], [E.id]);
    expect(seat.assigned, "PRECONDITION: enrolled as a participant before promotion").toBe(1);
    await promote(sa, saCsrf, authorP, "superadmin");
    expect(hasRow(E.id, authorP.id), "PRECONDITION: promotion keeps the row").toBe(true);
    const author = { ...authorP, ...(await apiLogin(authorP.email, PARTICIPANT_PASS)) };
    const held = await makeTask(author.api, author.csrf, "taskimp-held", { answer_sealed: true });
    const loose = await makeTask(author.api, author.csrf, "taskimp-loose", { answer_sealed: true });
    // switch OFF: no seal/author gate applies. The LIBRARY row itself is put in
    // the event (the previous model's mode): an import overwrites library rows
    // only, so the lock at that door is about a library row an event holds — a
    // database from before event-owned copies (lib/event-copies.js).
    await withLegacySharedAssign(sa, saCsrf, () => assignTask(author.api, author.csrf, held.id, [E.id]));
    const on = await sa.put(`/api/admin/competitions/${E.id}`, { headers: H(saCsrf), data: { staff_compete: true } });
    expect(on.status(), "PRECONDITION: the switch REFUSES to turn on while an enrolled author's challenge is held — the API cannot build this state").toBe(400);
    const onBody = await on.json();
    expect(onBody.code).toBe("staff_compete_enrolled_authors");
    // Round-3 fix (a)'s `participants[]` shape, pinned HERE because this is the
    // one arm in the file that reaches the refusal: one entry per enrolled
    // author, naming the challenges the event holds that they wrote.
    expect(onBody.participants, "one enrolled author").toHaveLength(1);
    expect(onBody.participants[0].id).toBe(authorP.id);
    expect(onBody.participants[0].nickname).toBe(authorP.nickname);
    expect(onBody.participants[0].tasks, "…naming the held challenge, and only it — `loose` is assigned nowhere").toEqual([{ id: held.id, title: held.title }]);
    withDbRW(db => db.prepare("UPDATE competitions SET staff_compete=1 WHERE id=?").run(E.id));
    // A hand write busts nothing, and the doors below read the row through
    // `getCompetition`'s 1 s cache. A no-op rename PUT busts it DETERMINISTICALLY
    // (every successful PUT invalidates; COALESCE leaves the hand-written column
    // alone), where a sleep past the TTL would race a slow box.
    const bust = await sa.put(`/api/admin/competitions/${E.id}`, { headers: H(saCsrf), data: { name: `${E.name} x` } });
    expect(bust.ok(), `cache-busting rename: ${bust.status()} ${await bust.text()}`).toBeTruthy();
    const eRow = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === E.id);
    expect(eRow && eRow.staff_compete, "PRECONDITION: the switch is really on (written by hand) and the rename left it alone").toBeTruthy();
    expect(hasRow(E.id, authorP.id), "PRECONDITION: the author still holds a row — they COMPETE in an event holding their sealed challenge").toBe(true);
    // A non-author user-backed superadmin competing in the same event, enrolled
    // by the built-in (a superadmin caller may enrol an admin tier).
    const otherP = await makeParticipant(sa, saCsrf, "taskimpother");
    await promote(sa, saCsrf, otherP, "superadmin");
    expect((await assign(sa, saCsrf, [otherP.id], [E.id])).assigned, "PRECONDITION: the non-author competes in E").toBe(1);
    const other = await apiLogin(otherP.email, PARTICIPANT_PASS);
    const heldBefore = descriptionOf(held.id);
    const looseBefore = descriptionOf(loose.id);

    // The author imports: `held` (competes → skipped by the LOCK, the seal
    // admits its author), `loose` (sealed, authored, held by no compete event →
    // overwritten), and a brand-new row (imported).
    const fresh = taskRow(`EA Task ${uniq("taskimp-fresh")}`);
    const { dry, result: d } = await importTasksOverwriting(author.api, author.csrf, [taskRow(held.title), taskRow(loose.title), fresh]);
    expect(dry.conflicts.map(c => c.index).sort(), "PRECONDITION: the two authored challenges conflict by title; the third is new").toEqual([0, 1]);
    expect(d.competitor_skipped, "the challenge held by the event the importer competes in is skipped by the competitor lock").toBe(1);
    expect(d.sealed_skipped, "…not by the seal, which admits its author").toBe(0);
    expect(d.overwritten, "CONTROL: the author's other sealed challenge, held by no compete event, is overwritten").toBe(1);
    expect(d.imported, "CONTROL: the new row is imported").toBe(1);
    expect(descriptionOf(held.id), "the held challenge is byte-identical").toBe(heldBefore);
    expect(descriptionOf(loose.id), "the loose one really changed").not.toBe(looseBefore);
    expect(descriptionOf(loose.id)).toBe("overwritten by import");

    // CONTROL: a NON-author competitor overwriting the same challenge is the
    // seal's skip — which is what says `competitor_skipped` counts the lock and
    // not merely "the importer competes in an event holding this".
    const { result: d2 } = await importTasksOverwriting(other.api, other.csrf, [taskRow(held.title)]);
    expect(d2.sealed_skipped, "a non-author is refused by the seal first").toBe(1);
    expect(d2.competitor_skipped).toBe(0);
    expect(d2.overwritten).toBe(0);
    expect(descriptionOf(held.id), "still untouched").toBe(heldBefore);
    await author.api.dispose(); await other.api.dispose();
  });

  test("the tasks EXPORT withholds the hint from a competitor (hint: null + hint_withheld: 1), marks nothing on a hint-less challenge, and an overwrite from such a file keeps the stored hint rather than wiping it", async () => {
    // Round 3 (S1/S4). The hint is not a SEALED field — a participant pays 30%
    // of the points to read it — so the seal redaction never touches it; the
    // admin list and the version history withhold it per competitor for that
    // reason, and the export ("the cheapest bypass of every other redaction")
    // was the one admin projection that did not. The row's shape is the list's:
    // `hint: null` plus `hint_withheld: 1`, so the importer can tell "no hint"
    // from "withheld" — and `hint_withheld` is `!!t0.hint`, so a challenge
    // with NO hint carries no marker (S4: a marker on an empty hint would tell
    // the importer to preserve something that is not there).
    const E = await makeEvent(sa, saCsrf, "hintexp", true);
    const F = await makeEvent(sa, saCsrf, "hintexp", false);
    const compP = await makeParticipant(sa, saCsrf, "hintexp-comp");
    await promote(sa, saCsrf, compP, "admin");
    expect((await assign(sa, saCsrf, [compP.id], [E.id])).assigned, "PRECONDITION: the exporter competes in E").toBe(1);
    const comp = await apiLogin(compP.email, PARTICIPANT_PASS);
    const HINT_E = `<p>HINT_E_${uniq("h")}</p>`;   // the withheld one — must appear NOWHERE in the competitor's file
    const HINT_F = `<p>HINT_F_${uniq("h")}</p>`;   // the control's — carried as ever
    // Three challenges by the built-in — UNSEALED, so the seal cannot be the
    // reason anything is withheld (the seal never touches the hint anyway, and
    // the import REFUSES a sealed row outright, which would leave the way-back-
    // in half nothing to overwrite). A compete event admits only sealed
    // challenges at every door, so the two held by E are PLANTED — the shape
    // the lock spec uses for exactly this reason ("the projection collapses a
    // competitor's row where the SEAL cannot be the reason"). Hinted in E,
    // hint-less in E, hinted in F (assigned through the door).
    const hintedE   = await makeTask(sa, saCsrf, "hintexp-hinted-E",   { answer_sealed: false, hint: HINT_E });
    const hintlessE = await makeTask(sa, saCsrf, "hintexp-hintless-E", { answer_sealed: false });
    const hintedF   = await makeTask(sa, saCsrf, "hintexp-hinted-F",   { answer_sealed: false, hint: HINT_F });
    const plant = (comp, task) => withDbRW(db => db.prepare(
      "INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at) VALUES (?,?,?,?)"
    ).run(comp.id, task.id, "test-plant", new Date().toISOString()));
    plant(E, hintedE);
    plant(E, hintlessE);
    await assignTask(sa, saCsrf, hintedF.id, [F.id]);
    const heldBy = id => withDb(db => db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(id)).map(r => r.competition_id);
    expect(heldBy(hintedE.id), "PRECONDITION: the planted row is in E").toEqual([E.id]);
    expect(heldBy(hintlessE.id), "PRECONDITION: …and the hint-less one").toEqual([E.id]);
    const exportRows = async (api) => {
      const r = await api.get("/api/admin/export/tasks");
      expect(r.ok(), `export: ${r.status()} ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      const rows = body.tasks || body.data?.tasks || [];
      const by = title => rows.find(t => t.title === title);
      return { rows, by };
    };
    const hintOf = id => withDb(db => db.prepare("SELECT hint FROM tasks WHERE id=?").get(id))?.hint ?? null;
    try {
      // THE COMPETITOR'S EXPORT.
      const mine = await exportRows(comp.api);
      const rE = mine.by(hintedE.title), rN = mine.by(hintlessE.title), rF = mine.by(hintedF.title);
      expect(rE, "the held challenge is on the export").toBeTruthy();
      expect(rE.hint, "…with its hint WITHHELD").toBeNull();
      expect(rE.hint_withheld, "…and marked as withheld").toBe(1);
      expect(JSON.stringify(mine.rows), "the withheld hint's text appears NOWHERE in the competitor's file").not.toContain(HINT_E.replace(/<\/?p>/g, ""));
      expect(rN.hint_withheld, "a hint-less challenge on the same event carries NO marker (nothing to preserve)").toBeUndefined();
      expect(rF.hint, "CONTROL: the challenge on the switch-OFF event carries its hint").toContain("HINT_F_");
      expect(rF.hint_withheld, "CONTROL: …and no marker").toBeUndefined();
      // CONTROL — the built-in (competes nowhere) exports every hint.
      const theirs = await exportRows(sa);
      expect(theirs.by(hintedE.title).hint, "CONTROL: a non-competitor's export carries the hint").toContain("HINT_E_");
      expect(theirs.by(hintedE.title).hint_withheld).toBeUndefined();

      // THE WAY BACK IN. A row carrying `hint: null, hint_withheld: 1` — the
      // competitor's own file — overwritten by somebody who MAY overwrite it
      // (the built-in, competing nowhere) must keep the stored hint: the export
      // withheld it, it did not say the challenge has none.
      const before = hintOf(hintedE.id);
      expect(before, "PRECONDITION: the stored hint is there").toContain("HINT_E_");
      const file = { ...rE, description: "overwritten by import" };
      const { dry, result: d } = await importTasksOverwriting(sa, saCsrf, [file]);
      expect(dry.conflicts.map(c => c.index), "PRECONDITION: it conflicts by title").toEqual([0]);
      expect(d.overwritten, "the overwrite lands").toBe(1);
      expect(descriptionOf(hintedE.id), "…and really changed the row").toBe("overwritten by import");
      expect(hintOf(hintedE.id), "the stored hint SURVIVED an overwrite from a withheld-hint row").toBe(before);
      // CONTROL — a row that genuinely carries an EMPTY hint (no marker) does
      // clear it on overwrite: the marker is what decides, not the emptiness.
      const cleared = { ...theirs.by(hintedF.title), hint: "", description: "overwritten by import" };
      delete cleared.hint_withheld;
      const { result: d2 } = await importTasksOverwriting(sa, saCsrf, [cleared]);
      expect(d2.overwritten).toBe(1);
      expect(hintOf(hintedF.id) || "", "CONTROL: an unmarked empty hint clears the stored one").toBe("");
      // …and a CREATE from a withheld row has nothing to keep: a fresh row
      // lands with no hint rather than failing.
      const fresh = { ...rE, title: `EA Task ${uniq("hintexp-fresh")}` };
      const { result: d3 } = await importTasksOverwriting(sa, saCsrf, [fresh]);
      expect(d3.imported, "a withheld row creates a new challenge").toBe(1);
      const freshId = withDb(db => db.prepare("SELECT id FROM tasks WHERE title=?").get(fresh.title))?.id;
      expect(freshId).toBeTruthy();
      expect(hintOf(freshId) || "", "…with no hint — there was nothing to keep").toBe("");
    } finally {
      await comp.api.dispose();
    }
  });
});


