"use strict";
//
// v8.12.0 — STAFF CAN COMPETE: the SCORING side and the PARTICIPANT side.
//
// The switch (`competitions.staff_compete`) lifts the two exclusions every board
// and the all-solved denominator have always applied — the `staff` TAG and the
// `event_admin` ROLE — for one event at a time. This file pins what that lifting
// does for the people it lifts, and what it does NOT do for everybody else:
//
//   1. the BOARDS — participant and admin — list a competing staff member and a
//      competing event admin on a compete event, and neither on a twin whose
//      switch is off; a BENCHMARK row stays off the ranked board either way;
//   2. the all-solved DENOMINATOR counts them — the event does not end while a
//      competing staff member is still playing, and does end once they finish;
//      on the twin the same person is invisible to the rule;
//   3. the ACTIVITY CSV carries their rows only where the switch is on;
//   4. a CERTIFICATE can be minted by a competing staff member and refused on
//      the twin, and `canShareBadge` says so before the click;
//   5. an ATTEMPT GRANT reaches a competing admin-tier target on a compete event
//      — an enrolled ADMIN (superadmin actor only: the peer doctrine still stops
//      a regular admin) and an enrolled EVENT ADMIN (any admin actor: the peer
//      doctrine names admin/superadmin only) — and is refused for either target
//      where the switch is off, and for an admin target who holds NO row even
//      where it is on (the carve-out is keyed on the ROW, not the switch);
//   6. SELECT-TIMESLOT treats a competing staff member as a participant — the
//      live-session confirm, the slot lock — and a spectator as staff; ALL FOUR
//      (row, switch) cells are driven, because the predicate is the CONJUNCTION
//      `row && switch` and a build keyed on either half alone passes the two
//      corner cells;
//   7. `/api/me` and `/api/my-competitions` carry `own` / `competing` /
//      `staff_compete` / `can_leave` per row, over the whole-platform list a
//      staff member has always received — and the `can_leave` affordance is
//      DRIVEN through the leave route, which a staff-tagged user reaches for the
//      first time under this feature;
//   8. the SOLE-EVENT LANDING reads a staff member's OWN rows exactly as it
//      reads a participant's;
//   9. TOGGLE-ADMIN-VIEW (to participant) lands an admin with exactly one own
//      event in it, and reports the verdict;
//  10. the GROUP board averages a competing staff member into their team and
//      gives a direct member a solo row — and the FROZEN snapshot at end-now
//      carries the same answer; on the twin with a planted row, neither;
//  11. the LATE-ENTRANT board lists a staff member who joined a compete Booth
//      Event inside its late window, and they take a PARTICIPATION certificate
//      while the window is open; on a switch-off booth the same join is a
//      spectator join, and a planted LATE row stays off the late board.
//
// Threaded through the sections above rather than given their own:
//   • the DENOMINATOR lifts the staff half ONLY — a benchmark row is still
//     outside a compete event's all-solved rule (§2);
//   • the ADMIN-ROLE competitor (every admin is staff-tagged) is in every board
//     world, competing from PARTICIPANT VIEW — on both boards, in the CSV, and
//     through the mint on a compete event; absent from all of it on the twin;
//   • the OTHER certificate surfaces: `GET /api/me/certificates` offers a
//     staff competitor's compete event as claimable and holds it after the
//     mint (§4, §11), and a staff competitor OUTSIDE the top three takes a
//     PARTICIPATION certificate — the placement short-circuit is not the only
//     door (§4);
//   • PER-SLOT scoring: the session's denominator and board count a staff
//     competitor exactly as the competition-wide ones do (§6 e);
//   • decision 7's OTHER half — the marker resume, the deliberate departure
//     and the spectator's marker — for a staff member (§8 b);
//   • the ANALYTICS DECISION: the default `staff` exclusion is a per-query
//     default that does NOT read the switch, pinned in both directions (§1).
//
// ── HOW THIS FILE IS BUILT ────────────────────────────────────────────────────
//
// EVERY POSITIVE ASSERTION HAS A CONTROL, and most controls are a SWITCH-OFF
// TWIN of the same fixture: "the staff member is on the board" is equally
// satisfied by a build that put everybody on every board, and "the staff member
// is refused" by a build that refuses everybody. So each arm builds the same
// world twice, the only difference being the column, and asserts both ways.
//
// A STAFF ROW ON A SWITCH-OFF EVENT IS PLANTED BY DIRECT DB INSERT. Decision 1
// of the design is that staff are assignable ONLY to compete events, so the
// assign route SKIPS them there (`skippedStaff`) — the row is the state a
// pre-release database holds, and the only way to build it now. A planted row
// is what makes the switch-off control SHARP: the person is enrolled, entered,
// and has submitted, and only the switch keeps them off the board.
//
// EVERY BOARD ARM ENROLS A BYSTANDER WHO NEVER SOLVES. The all-solved auto-end
// fires inside the submit transaction, and on a switch-off twin the bystander is
// the only thing keeping the event live while the staff member enters — a staff
// member selecting an ENDED event is never stamped with a login_time and so is
// absent from the board whether or not the exclusion works (checklist item 1,
// met from the other side).
//
// ── FIXTURE TRAPS MET WHILE WRITING IT ───────────────────────────────────────
//
//  • A challenge assigned to a compete event must be SEALED, and sealing needs a
//    USER-BACKED author (`sealAtCreateDenied`): the built-in superadmin has no
//    users row. So one promoted admin authors every challenge here, and is
//    enrolled nowhere — an author who holds a row on a compete event is refused
//    at both doors.
//  • The event_admin ROLE is granted per event (`POST …/admins`), so an event
//    admin fixture needs a SECOND event to organise; one anchor event serves
//    every grant in the file.
//  • `/api/me` is cached two seconds per user, and a row written straight into
//    SQLite busts nothing — reads that follow a plant or an out-of-band change
//    go to `/api/my-competitions` (uncached) or poll.
//  • The toggle-admin-view landing is only observable when the LOGIN found no
//    event to land in: `/api/login` runs the same landing rule, so an admin
//    enrolled BEFORE signing in arrives already pointed at the event and the
//    toggle merely carries the pointer. The arm enrols AFTER the login.
//  • A submission needs the challenge's `grading_hash` (v7.20.9), read off
//    `GET /api/tasks/:id` after the competition is selected.
//  • The toggle REGENERATES the session, so the CSRF token is re-fetched before
//    the next POST on that context.
//  • A fixture LABEL becomes part of the email, and registration LOWERCASES the
//    address — so `board-W` minted an account `makeParticipant`'s exact-match
//    lookup could never find again, and every test failed at its first fixture
//    with "must be findable in the admin list". Every label goes through
//    `makeP`, which lowercases it.
//  • A grant TARGET never needs a session: `makeAdminRow` promotes without
//    signing in, so there is no context to leak on an assertion failure (the
//    previous draft disposed two target contexts on the success path only).
//  • The activity CSV is PARSED, not grepped: a nickname's presence says the row
//    exists, and only the Solved cell says the competitor's activity joined it.
//    Every cell is quoted (lib/csv.js), so the parser is the quoted-field walk
//    `competition-activity-export.spec.js` uses.
//  • EVERY FIXTURE LOGIN LANDS — and it is asserted, never inherited. Each
//    board-world actor holds exactly one own row, so the sole-event landing
//    points their login at the event under test before `enter()` runs (the
//    event admin's grant on the anchor is not a row). Stated as a precondition
//    in every world builder, so a fixture that later acquires a second row
//    fails there rather than as a wrong-event read further down.
//  • The GROUP board needs its non-solving members to ENTER: a member with no
//    login_time and no submission is not in the entry set, so their group
//    reads as EMPTY and a two-group board collapses to null. P1 and P2 select
//    the event and never solve — they are also the bystanders (checklist 1).
//  • A group-board fixture's `memberCount` is asserted on the ADMIN board only:
//    the participant wire strips it (summing group sizes would leak the field
//    size, v6.14.2).
//  • The FROZEN team board is read straight off `group_leaderboard_snapshots`
//    under the `'__global__'` slot key — a single-slot event has no other.
//  • A late-window join needs `now > ended_at` STRICTLY; End Now stamps `now()`
//    and the join is the next request, so the window is open by construction.
//    The row it writes carries `assigned_at` after the end, which is what makes
//    the joiner a late entrant — asserted, because a row written a millisecond
//    early is an ordinary member and the whole late arm is then vacuous.
//  • A staff member's WRONG answer costs 5 points, which is how W finishes
//    fourth behind three full-score solvers for the participation-certificate
//    arm — no padding participants, no ordering dependence on solve time.
//  • The analytics response is memoised on its FULL URL for 15 s, and its
//    `challenge_events` land on a post-commit `setImmediate` drain: every read
//    carries a cache-buster and polls.
//
// ── VERIFIED MUTATIONS ────────────────────────────────────────────────────────
//
// THE CORE LINES (each run on a throwaway copy of the tree, port base 5910):
//
//  ROUND 3 — lib/competitions.js `anchorLoginTime` returning `nowIso` (the
//    anchor stamped at the clock)         → kills §1's "solve-clock anchor of a
//                                          staff member enrolled AFTER solving"
//                                          arm alone, on "at W's FIRST activity,
//                                          not at the clock" (port base 7400)
//
//  lib/leaderboard.js `_staff` — `!_staffCompete &&` dropped (the switch never
//    lifts the board exclusion)          → kills §1 compete arm, §4 (both), §6 e,
//                                          §10, §11 — every board reader
//  lib/leaderboard.js `_staff` — lifted for every role BUT admin/superadmin
//                                        → kills §1, §4 (both): the admin-ROLE
//                                          competitor vanishes from the board
//  lib/competitions.js `scoringParticipantIds` — `staffCompete` forced FALSE
//                                        → kills §2 compete arms (tag + role), §6 e
//                                     …forced TRUE → kills §2's two twin controls
//                                          only; the benchmark arm stays green,
//                                          which is what says it is about the
//                                          OTHER half of the set
//                                     …computed on the no-timeslot branch only
//                                        → kills §6 e alone (the per-slot arm)
//  lib/user-tags.js `getStaffOrBenchmarkSet` compete branch → `[]` (nobody
//    excluded where staff compete)       → kills §2's BENCHMARK arm alone — the
//                                          arm the skeptic measured as missing;
//                                          every other test stays green
//  lib/leaderboard.js `_computeGroupLeaderboard` — `!u._staff &&` dropped
//                                        → kills §10 alone (the twin's G1 average
//                                          gains W's score and W a solo row)
//  lib/leaderboard.js `buildLateLeaderboard` — `!u._staff &&` dropped
//                                        → kills §11 alone (the twin's planted
//                                          late row reaches the late board)
//  routes/participants.js assign door — `skippedPrivileged` applied even to the
//    superadmin actor                    → kills every arm that enrols an admin
//                                          account by the built-in superadmin:
//                                          §1, §3, §4 (both), §5 admin target and
//                                          all three §9 worlds (`enrol` asserts
//                                          the count). Stated as such: the line
//                                          was already held by §5/§9; the new
//                                          arms add the board and mint reads
//  routes/badge.js `_mintEligibility` — staff refused a PARTICIPATION
//    certificate (placement only)        → kills §4 participation arm and §11
//                                          (a late entrant's certificate is a
//                                          participation one by rule)
//  routes/badge.js `GET /api/me/certificates` — staff rows skipped in the
//    claimable loop                      → kills §4 mint arm (claimable before
//                                          the mint) and §11's offer
//  server.js analytics default — `staff` dropped from the default exclusion
//    when the scoped event's switch is on → kills §1 alone (the decision arm)
//  lib/middleware.js `_soleCompetitionLanding` — `if (left) return null;`
//    deleted                             → kills §8 b (ii) alone
//  lib/middleware.js `applyAutoResumeToSession` — `if (assigned || isStaff)`
//    narrowed to `if (assigned)`         → kills §8 b (iii) alone
//
// THE PERIPHERY (from the first draft; each kills the named arm and no other):
//
//  select-timeslot, routes/participant.js `staffUser`:
//    `_staffTagged && !assigned`            (row alone)    → kills 6(c) row+OFF
//    `_staffTagged && !staffCompeteOn(comp)` (switch alone) → kills 6(d) no-row+ON
//  attempt-grant, routes/challenges.js:
//    peer gate widened to `user.role !== "participant"`     → kills 5(EA) regular-
//                                                              admin → event_admin 200
//    `_competitorTarget` narrowed to admin/superadmin roles → kills 5(EA) compete arm
//    `_competitorTarget = staffCompeteOn(comp)` (row dropped) → kills 5 non-enrolled
//                                                              admin target 403
//  activity CSV, routes/export-import.js: filtering a competitor's submissions
//    by the staff tag while keeping the row                → kills 3 Solved=Yes
//  leave, routes/self-enroll.js: refusing a staff-tagged caller → kills 7 leave arm
//
// STATED RATHER THAN CLAIMED: §3's admin-role assertions (A's row and Solved
// cell in the compete file, A's absence from the twin's) had no mutation of
// their own. The export lifts the TAG and A is tagged, so A rides the same
// product line as W and the CSV mutation above is what holds it; a build that
// excluded admin ROWS from the CSV by ROLE would fail §3 on A's row, which is
// asserted, but no such build was run.

const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

// better-sqlite3 is opened INSIDE the callback, never at module scope: per-file
// isolation recreates the database in a `beforeAll`, so a handle taken at
// require time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

const iso = ms => new Date(Date.now() + ms).toISOString();

/**
 * Every participant here is minted through this one wrapper, and it LOWERCASES
 * the label: registration normalises the address (`normaliseEmail`), so a label
 * such as `board-W` produces an email the exact-match lookup in
 * `makeParticipant` can never find again. Found on the first run — every test
 * failed at its first fixture with "must be findable in the admin list".
 */
const makeP = (label) => makeParticipant(sa, saCsrf, String(label).toLowerCase());

/** Promote a fresh participant to `admin` (auto-tagged `staff`) and sign in as them. */
async function makeAdmin(sa, saCsrf, label) {
  const p = await makeP(label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  return { ...p, api, csrf };
}

/**
 * Promote a fresh participant to `role` WITHOUT signing in as them — for a
 * TARGET (a grant recipient, an enrollee) that never acts. No context, nothing
 * to dispose, nothing to leak when an assertion fails half way.
 */
async function makeAdminRow(sa, saCsrf, label, role = "admin") {
  const p = await makeP(label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  expect(withDb(db => db.prepare("SELECT role FROM users WHERE id=?").get(p.id)).role, `${label} really holds the ${role} role`).toBe(role);
  return p;
}

/**
 * Parse a CSV whose EVERY field is quoted — which is what `lib/csv.js` emits —
 * into `[{<header>: value}]`. The BOM is stripped first. Same walk as
 * `competition-activity-export.spec.js`; a spec cannot require another spec.
 */
function parseCsvObjects(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = "", inQ = false, started = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQ) {
      if (ch === '"') { if (body[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') { inQ = true; started = true; }
    else if (ch === ",") { row.push(field); field = ""; started = false; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; started = false; }
    else field += ch;
  }
  if (field.length || started || row.length) { row.push(field); rows.push(row); }
  const header = rows[0] || [];
  for (const name of ["Nickname", "Challenge", "Solved"]) {
    expect(header.indexOf(name), `the CSV carries a "${name}" column — header was ${JSON.stringify(header)}`).toBeGreaterThanOrEqual(0);
  }
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** Tag a user and ASSERT the tag took — a silently-missing tag makes every staff assertion vacuous. */
async function tagUser(sa, saCsrf, userId, tag) {
  const r = await sa.post(`/api/admin/participants/${userId}/tags`, { headers: H(saCsrf), data: { tag } });
  expect(r.ok(), `tag ${tag}: ${r.status()} ${await r.text()}`).toBeTruthy();
  expect((await r.json()).tags, `the ${tag} tag really is on the row`).toContain(tag);
}

/** A staff-TAGGED participant (role participant). */
async function makeStaff(sa, saCsrf, label) {
  const p = await makeP(label);
  await tagUser(sa, saCsrf, p.id, "staff");
  return p;
}

/**
 * Make `userId` an event admin by granting them an event to organise. The role
 * is what excludes them from a board — they are NOT tagged staff — so the grant
 * must be on some OTHER event than the one under test.
 */
async function makeEventAdmin(sa, saCsrf, anchorCompId, label) {
  const p = await makeP(label);
  await grantEventAdmin(sa, saCsrf, anchorCompId, p.id);
  const row = withDb(db => db.prepare("SELECT role FROM users WHERE id=?").get(p.id));
  expect(row.role, "the grant really promoted them to the event_admin role").toBe("event_admin");
  const tags = withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(p.id).map(r => r.tag));
  expect(tags, "an event admin is excluded by ROLE, never by the tag").not.toContain("staff");
  return p;
}

/**
 * PLANT a membership row — the only way to put a staff-tagged user on a
 * switch-off event now that the assign route skips them there (decision 1).
 * Asserted after the write so a fixture built on it cannot be vacuous.
 */
function plantRow(compId, userId, { directAssigned = 1, assignedAt = new Date().toISOString() } = {}) {
  withDb(db => {
    db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,?)")
      .run(compId, userId, "test-plant", assignedAt, directAssigned);
  }, { readonly: false });
  const row = withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));
  expect(row, "the planted row really exists").toBeTruthy();
}

/** A sealed, published text challenge by `author`, with a distinctive key. */
async function sealedTask(author, label, extra = {}) {
  const key = `KEY_${uniq(label).replace(/[^a-zA-Z0-9]/g, "")}`;
  const t = await makeTask(author.api, author.csrf, label, { answer_sealed: true, correct_answer: key, ...extra });
  return { ...t, key };
}

/** Sign in and hand back a live context. */
async function signIn(email) {
  const { api, csrf, body } = await apiLogin(email, PARTICIPANT_PASS);
  return { api, csrf, body };
}

/** Select a competition, asserting it took. */
async function enter(ctx, compId, label = "select") {
  const r = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
  expect(r.ok(), `${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

/** Submit the correct answer, asserting it was GRADED correct — a refusal is not a solve. */
async function solve(ctx, task, label = "solve") {
  const hash = await gradingHashFor(ctx.api, task.id);
  expect(hash, `${label}: the grading hash must be readable`).toBeTruthy();
  const r = await ctx.api.post(`/api/tasks/${task.id}/submit`, { headers: H(ctx.csrf), data: { answer: task.key, gradingHash: hash } });
  expect(r.ok(), `${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.correct, `${label}: the fixture's answer really is correct`).toBe(true);
  return d;
}

/** Submit a WRONG answer, asserting it was GRADED incorrect — a refusal is not a wrong answer. */
async function submitWrong(ctx, task, label = "wrong answer") {
  const hash = await gradingHashFor(ctx.api, task.id);
  expect(hash, `${label}: the grading hash must be readable`).toBeTruthy();
  const r = await ctx.api.post(`/api/tasks/${task.id}/submit`, { headers: H(ctx.csrf), data: { answer: `${task.key}-NOT`, gradingHash: hash } });
  expect(r.ok(), `${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.refused, `${label}: graded, not refused by an attempt cap`).toBeFalsy();
  expect(d.correct, `${label}: the fixture's wrong answer really grades as wrong`).toBe(false);
  return d;
}

/**
 * Toggle an admin session's view. The toggle REGENERATES the session, so the
 * context's CSRF token is refreshed in place — every later POST on `ctx`
 * would otherwise carry the pre-regeneration token and 403.
 */
async function toggleView(ctx, mode) {
  const csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  const r = await ctx.api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode } });
  expect(r.ok(), `toggle ${mode}: ${r.status()} ${await r.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  return r.json();
}

/** Reveal a competition's LIVE join token (asserting the link is enabled). */
async function joinTokenFor(compId) {
  const r = await sa.get(`/api/admin/competitions/${compId}/self-enroll`);
  expect(r.ok(), `reveal token: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.enabled, "the join link is live").toBe(true);
  return d.token;
}

/** Create a group seeded with members, asserting the member count took. */
async function createGroup(label, userIds) {
  const r = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq(label), userIds } });
  expect(r.ok(), `create group ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const g = (await r.json()).group;
  expect(g.member_count, `group ${label} really holds its ${userIds.length} members`).toBe(userIds.length);
  return g;
}

/**
 * Bind groups to a competition through the assign door. The route AWAITS the
 * reconcile before answering, so membership rows exist when this returns —
 * `membersDeferred` is asserted absent, or a fixture could read a half-synced
 * roster.
 */
async function bindGroups(compId, groupIds) {
  const r = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds, competitionIds: [compId] } });
  expect(r.ok(), `bind groups: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.groupsBound, `bound ${d.groupsBound} of ${groupIds.length} groups`).toBe(groupIds.length);
  expect(d.membersDeferred, "the reconcile completed inside the request").toBeFalsy();
  return d;
}

/** One membership row, or undefined. */
const rowOf = (compId, userId) =>
  withDb(db => db.prepare("SELECT direct_assigned, timeslot_id, login_time, assigned_at FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));

/** The admin list row for one competition (reads `ended_at` straight off the table). */
async function adminRow(sa, compId) {
  const r = await sa.get("/api/admin/competitions");
  expect(r.ok(), `admin list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(c => c.id === compId);
  expect(row, `competition ${compId} is on the admin list`).toBeTruthy();
  return row;
}

async function endNow(sa, saCsrf, compId) {
  const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(saCsrf) });
  expect(r.ok(), `end-now: ${r.status()} ${await r.text()}`).toBeTruthy();
}

let sa, saCsrf, author, anchor;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  // ONE author for every sealed challenge in the file. Never enrolled anywhere:
  // an author who holds a row on a compete event is refused at both doors, so a
  // shared author is safe precisely because nothing here ever assigns them.
  author = await makeAdmin(sa, saCsrf, "scauthor");
  // ONE anchor event for every event_admin grant (the role is per event).
  anchor = await makeCompetition(sa, saCsrf, "scanchor", { start_time: iso(3600_000), duration_minutes: 60 });
});

test.afterAll(async () => {
  await author?.api?.dispose();
  await sa?.dispose();
});

/**
 * THE BOARD WORLD, built twice per arm — once with the switch on, once off.
 *
 *   comp — a live tournament; `staffCompete` decides the column
 *   task — a sealed challenge by `author`, assigned to it
 *   P    — an ordinary participant, enrolled
 *   W    — a staff-TAGGED participant: enrolled by assign (switch on) or by a
 *          PLANTED row (switch off — the assign route skips them there)
 *   EA   — an event admin (ROLE), enrolled by assign either way: the route has
 *          always admitted an untagged event admin
 *   B    — a bystander who never solves, so the all-solved auto-end cannot fire
 *          while the others are entering (checklist item 1)
 *   A    — a role-ADMIN account (auto-tagged staff at promotion): enrolled by
 *          the BUILT-IN superadmin (the peer doctrine lets a superadmin enrol
 *          an admin) with the switch on, by a PLANTED row with it off. They
 *          compete from PARTICIPANT VIEW, which is the real flow — the toggle
 *          regenerates the session, so their context's CSRF token is refreshed
 *   BM   — a benchmark-tagged participant (switch on only): a reference score
 *          is a reference score whatever the switch says
 *
 * Every actor SELECTS the competition while it is live (the login_time stamp
 * is what puts a row on the board) and SOLVES the challenge. `wWrongFirst`
 * has W submit a WRONG answer before the right one, so W's score is 5 below
 * every other solver's and they land OUTSIDE the top three — the shape the
 * participation-certificate arm needs.
 *
 * EVERY SIGN-IN'S LANDING IS ASSERTED AS A PRECONDITION. Each actor holds
 * exactly one own row (the EA's grant on the anchor is not a row), so the
 * sole-event landing points every login at this event before `enter()` runs.
 * Stated rather than inherited, so a fixture change that gives one of them a
 * second row is reported here and not as a mysterious wrong-event read later.
 */
async function buildBoardWorld({ staffCompete, withBenchmark = false, wWrongFirst = false, label }) {
  const comp = await makeCompetition(sa, saCsrf, `${label}-${staffCompete ? "on" : "off"}`, { staff_compete: staffCompete });
  const task = await sealedTask(author, `${label}-task`);
  await assignTask(author.api, author.csrf, task.id, [comp.id]);

  const P = await makeP(`${label}-P`);
  const B = await makeP(`${label}-B`);
  const W = await makeStaff(sa, saCsrf, `${label}-W`);
  const EA = await makeEventAdmin(sa, saCsrf, anchor.id, `${label}-EA`);
  const A = await makeAdminRow(sa, saCsrf, `${label}-A`);
  // The promotion auto-tags `staff`; asserted, because A's whole role in this
  // fixture is to be the tagged ADMIN-ROLE competitor the feature was built for.
  expect(withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(A.id).map(r => r.tag)),
    "a promoted admin carries the staff tag").toContain("staff");
  await enrol(sa, saCsrf, comp.id, [P.id, B.id, EA.id]);
  if (staffCompete) {
    // The BUILT-IN superadmin enrols both — a staff-tagged participant and an
    // admin account. `enrol` asserts the count, so `skippedPrivileged` (which
    // a REGULAR admin actor would trip on A) cannot silently drop A here.
    await enrol(sa, saCsrf, comp.id, [W.id, A.id]);
  } else {
    // PRECONDITION of the control: the assign route really does skip a staff
    // member on a switch-off event, so the planted rows below are the ONLY way
    // they can hold one. Asserted rather than assumed — if the route ever admits
    // them here, the whole control has changed meaning.
    const r = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [W.id, A.id], competitionIds: [comp.id] } });
    expect(r.ok(), `assign W and A to the switch-off twin: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    expect(d.assigned, "a staff-tagged user is NOT assignable to a switch-off event").toBe(0);
    expect(d.skippedStaff, "…and both skips are reported, per (user, event) pair").toBe(2);
    plantRow(comp.id, W.id);
    plantRow(comp.id, A.id);
  }
  let BM = null;
  if (withBenchmark) {
    BM = await makeP(`${label}-BM`);
    await tagUser(sa, saCsrf, BM.id, "benchmark");
    await enrol(sa, saCsrf, comp.id, [BM.id]);
  }

  const ctx = {};
  for (const [k, u] of [["P", P], ["W", W], ["EA", EA], ["A", A], ...(BM ? [["BM", BM]] : [])]) {
    ctx[k] = await signIn(u.email);
    // THE LANDING PRECONDITION (see the doc block): one own row, so the login
    // already points at this event. The event admin is the one worth stating —
    // a grant is not a row, so their login sees exactly one.
    expect(ctx[k].body.autoResumeCompetitionId, `${k}'s login lands in their one own event`).toBe(comp.id);
    // An ADMIN competes from participant view. The real flow, and the toggle's
    // own landing carries the pointer the login set.
    if (k === "A") {
      const t = await toggleView(ctx[k], "participant");
      expect(t.isAdmin, "A is in participant view").toBe(false);
      expect(t.competitionId, "the toggle carries the login's landing").toBe(comp.id);
    }
    await enter(ctx[k], comp.id, `${k} selects the ${staffCompete ? "compete" : "switch-off"} event`);
    if (k === "W" && wWrongFirst) await submitWrong(ctx[k], task, "W answers wrong first");
    await solve(ctx[k], task, `${k} solves`);
  }
  // STILL LIVE — the bystander holds it open. Asserted, or every later read is
  // about an ended event without the test saying so.
  expect((await adminRow(sa, comp.id)).ended_at, "the bystander keeps the event live").toBeNull();
  return { comp, task, P, W, EA, A, B, BM, ctx, dispose: async () => { for (const c of Object.values(ctx)) await c.api.dispose(); } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE BOARDS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the boards list a competing staff member, and only on a compete event", () => {

  test("a staff-tagged user and an event admin are on BOTH boards where staff compete, and on NEITHER where they do not", async () => {
    const on = await buildBoardWorld({ staffCompete: true, withBenchmark: true, label: "board" });
    const off = await buildBoardWorld({ staffCompete: false, label: "boardctl" });
    try {
      // ── THE COMPETE EVENT ──────────────────────────────────────────────────
      const pBoard = await (await on.ctx.P.api.get("/api/leaderboard")).json();
      expect(pBoard.ranking_enabled, "a tournament ranks").toBe(true);
      const ids = pBoard.board.map(e => e.userId);
      expect(ids, "the ordinary participant is on the board (the board works)").toContain(on.P.id);
      expect(ids, "the staff-TAGGED competitor is on the participant board").toContain(on.W.id);
      expect(ids, "the event-admin (ROLE) competitor is on the participant board").toContain(on.EA.id);
      expect(ids, "the ADMIN-ROLE competitor (competing from participant view) is on the participant board").toContain(on.A.id);
      expect(ids, "a BENCHMARK row is still off the ranked board with the switch on").not.toContain(on.BM.id);
      expect(pBoard.me?.userId, "the participant resolves their own row").toBe(on.P.id);
      // The competitors see THEMSELVES as a row, too — `me` is what the score
      // pill and the certificate CTA read.
      const wBoard = await (await on.ctx.W.api.get("/api/leaderboard")).json();
      expect(wBoard.me?.userId, "the staff competitor resolves their own row").toBe(on.W.id);
      const eaBoard = await (await on.ctx.EA.api.get("/api/leaderboard")).json();
      expect(eaBoard.me?.userId, "the event-admin competitor resolves their own row").toBe(on.EA.id);
      const aBoard = await (await on.ctx.A.api.get("/api/leaderboard")).json();
      expect(aBoard.me?.userId, "the admin competitor resolves their own row from participant view").toBe(on.A.id);

      const adminOn = await (await sa.get(`/api/admin/leaderboard?competitionId=${on.comp.id}`)).json();
      expect(Array.isArray(adminOn), "the admin board is a bare array").toBe(true);
      const rankedOn = adminOn.filter(e => !e.isBenchmark && !e.isLateEntrant);
      expect(rankedOn.map(e => e.userId), "the staff competitor is RANKED on the admin board").toContain(on.W.id);
      expect(rankedOn.map(e => e.userId), "the event-admin competitor is RANKED on the admin board").toContain(on.EA.id);
      expect(rankedOn.map(e => e.userId), "the admin-role competitor is RANKED on the admin board").toContain(on.A.id);
      expect(rankedOn.map(e => e.userId), "the participant is ranked (control)").toContain(on.P.id);
      expect(rankedOn.every(e => Number.isInteger(e.rank) && e.rank >= 1), "every ranked row carries a real rank").toBe(true);
      // The benchmark row keeps the shape it has always had: present, un-ranked,
      // marked — the switch lifts the STAFF exclusion and nothing else.
      const bmRow = adminOn.find(e => e.userId === on.BM.id);
      expect(bmRow, "the benchmark row still rides the admin array").toBeTruthy();
      expect(bmRow.isBenchmark, "…marked as a benchmark").toBe(true);
      expect(bmRow.rank, "…and un-ranked").toBeNull();

      // ── THE SWITCH-OFF TWIN ────────────────────────────────────────────────
      // Same people, same actions, same challenge; only the column differs.
      const pOff = await (await off.ctx.P.api.get("/api/leaderboard")).json();
      const offIds = pOff.board.map(e => e.userId);
      expect(offIds, "CONTROL: the participant is on the twin's board (the board works)").toContain(off.P.id);
      expect(offIds, "a staff-tagged user with a row is NOT on a switch-off board").not.toContain(off.W.id);
      expect(offIds, "an event admin with a row is NOT on a switch-off board").not.toContain(off.EA.id);
      expect(offIds, "an admin-role account with a planted row is NOT on a switch-off board").not.toContain(off.A.id);
      // BY VALUE over the whole payload: a leak arriving under a renamed key or
      // in `top3` still fails.
      const rawOff = JSON.stringify(pOff);
      expect(rawOff, "the staff nickname appears nowhere on the twin's participant payload").not.toContain(off.W.nickname);
      expect(rawOff, "the event-admin nickname appears nowhere on the twin's participant payload").not.toContain(off.EA.nickname);
      expect(rawOff, "the admin's nickname appears nowhere on the twin's participant payload").not.toContain(off.A.nickname);
      const wOff = await (await off.ctx.W.api.get("/api/leaderboard")).json();
      expect(wOff.me, "the spectator with a planted row resolves NO row of their own").toBeNull();
      const eaOff = await (await off.ctx.EA.api.get("/api/leaderboard")).json();
      expect(eaOff.me, "the event admin resolves NO row of their own on the twin").toBeNull();
      const aOff = await (await off.ctx.A.api.get("/api/leaderboard")).json();
      expect(aOff.me, "the admin resolves NO row of their own on the twin").toBeNull();

      const adminOff = await (await sa.get(`/api/admin/leaderboard?competitionId=${off.comp.id}`)).json();
      expect(adminOff.map(e => e.userId), "the staff row is absent from the twin's admin board entirely").not.toContain(off.W.id);
      expect(adminOff.map(e => e.userId), "the event-admin row is absent from the twin's admin board entirely").not.toContain(off.EA.id);
      expect(adminOff.map(e => e.userId), "the admin-role row is absent from the twin's admin board entirely").not.toContain(off.A.id);
      expect(adminOff.map(e => e.userId), "CONTROL: the participant is on the twin's admin board").toContain(off.P.id);

      // ── THE ANALYTICS DECISION, pinned in BOTH directions ──────────────────
      // DECIDED and deliberately unchanged: analytics keeps its platform-wide
      // default `staff` exclusion even on a compete event — the switch is about
      // one event's BOARD, and the analytics filter is a per-query default the
      // operator toggles. So the default count excludes the two staff-TAGGED
      // solvers (W and A) and keeps the untagged event admin and the benchmark
      // row (analytics has never excluded either), and `includeStaff` admits
      // them — a later "fix" that made analytics read the switch fails here.
      // `challenge_events` are written post-commit on a `setImmediate` drain,
      // so both reads poll; each carries a cache-buster because the response is
      // memoised on its full URL for 15 s.
      const analytics = async (extra = "") => {
        const r = await sa.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${encodeURIComponent(on.comp.id)}${extra}&_=${Date.now()}-${Math.random()}`);
        expect(r.ok(), `analytics: ${r.status()} ${await r.text()}`).toBeTruthy();
        return r.json();
      };
      await expect.poll(async () => (await analytics()).summary.solved, { timeout: 5000 })
        .toBe(3); // P + EA + BM — the two staff-TAGGED solvers stay excluded by default
      await expect.poll(async () => (await analytics("&includeStaff=true")).summary.solved, { timeout: 5000 })
        .toBe(5); // + W + A
      // The exclusion is the TAG, never the switch: the twin answers the same
      // shape (its staff solvers are excluded by default too), so the compete
      // event's default cannot be read as "the switch lifted analytics".
      const analyticsOff = async (extra = "") => {
        const r = await sa.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${encodeURIComponent(off.comp.id)}${extra}&_=${Date.now()}-${Math.random()}`);
        expect(r.ok()).toBeTruthy();
        return r.json();
      };
      await expect.poll(async () => (await analyticsOff()).summary.solved, { timeout: 5000 }).toBe(2);   // P + EA
      await expect.poll(async () => (await analyticsOff("&includeStaff=true")).summary.solved, { timeout: 5000 }).toBe(4); // + W + A
    } finally { await on.dispose(); await off.dispose(); }
  });

  test("the solve-clock anchor of a staff member enrolled AFTER solving is their FIRST activity, not the enrolment — so their window is real rather than clamped to zero", async () => {
    // Round 3 (S16), the tie-break's sharpest door. A staff member may submit in
    // a compete event with NO row at all (`requireParticipantInCompetition`
    // admits staff without one); every row-writer then writes them a row AFTER
    // those solves, and the first live request stamps `login_time`. Stamped at
    // the clock, that anchor lands AFTER every solve, so for a finisher whose
    // window closes at their LAST correct submission `finish - login` is
    // negative — clamped to 0, the best possible value on the score-tie
    // tie-break (the v8.6.0 late-entry exploit shape through a new door).
    // `anchorLoginTime` stamps MIN(now, first submission/hint) instead, at
    // every writer of a new anchor. The discriminating fixture is TWO solves
    // before the row: with the fix the window is `t2 - t1 > 0`; without it, 0.
    const comp = await makeCompetition(sa, saCsrf, "anchor-on", { staff_compete: true });
    const t1 = await sealedTask(author, "anchor-1");
    const t2 = await sealedTask(author, "anchor-2");
    await assignTask(author.api, author.csrf, t1.id, [comp.id]);
    await assignTask(author.api, author.csrf, t2.id, [comp.id]);
    const P = await makeP("anchor-P");          // the bystander that keeps the event live
    const W = await makeStaff(sa, saCsrf, "anchor-W");
    await enrol(sa, saCsrf, comp.id, [P.id]);
    const w = await signIn(W.email);
    const p = await signIn(P.email);
    try {
      await enter(p, comp.id, "P enters");
      // W enters WITHOUT a row and solves both — the staff door.
      expect(rowOf(comp.id, W.id), "PRECONDITION: W holds no row").toBeUndefined();
      await enter(w, comp.id, "the un-enrolled staff member enters the compete event");
      await solve(w, t1, "W solves the first with no row");
      await new Promise(r => setTimeout(r, 120));   // a measurable window between the two solves
      await solve(w, t2, "W solves the second with no row");
      expect(rowOf(comp.id, W.id), "PRECONDITION: two solves later, still no row — nothing manufactured one").toBeUndefined();
      const subs = withDb(db => db.prepare("SELECT submitted_at FROM submissions WHERE user_id=? AND competition_id=? AND is_correct=1 ORDER BY submitted_at").all(W.id, comp.id)).map(r => r.submitted_at);
      expect(subs, "PRECONDITION: two correct submissions, in order").toHaveLength(2);
      expect(subs[1] > subs[0], "PRECONDITION: …at distinct instants").toBe(true);

      // NOW the built-in enrols W (the row-writer), and W's next competition-
      // scoped request stamps the anchor.
      const enrolledAt = new Date().toISOString();
      expect(enrolledAt > subs[1], "PRECONDITION: the enrolment is AFTER both solves").toBe(true);
      await enrol(sa, saCsrf, comp.id, [W.id]);
      expect(rowOf(comp.id, W.id)?.login_time, "PRECONDITION: the assign wrote the row with no anchor yet").toBeNull();
      const st = await w.api.get("/api/status");
      expect(st.ok(), `W's first live request after the row: ${st.status()} ${await st.text()}`).toBeTruthy();
      const anchor = rowOf(comp.id, W.id)?.login_time;
      expect(anchor, "the anchor is stamped by the first live request").toBeTruthy();
      expect(anchor, "…at W's FIRST activity, not at the clock").toBe(subs[0]);
      expect(anchor < enrolledAt, "…which precedes the enrolment").toBe(true);

      // THE BOARD: W's window is the real span between the two solves — not 0.
      const board = await (await sa.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
      const rows = Array.isArray(board) ? board : board.board;
      const wRow = rows.find(e => e.userId === W.id);
      expect(wRow, "W is on the compete event's board").toBeTruthy();
      expect(wRow.allSolved, "…as a finisher").toBe(true);
      const span = new Date(subs[1]) - new Date(subs[0]);
      expect(wRow.solveTimeMs, "W's time-to-solve is the span between the two solves, not a clamped zero").toBe(span);
      expect(wRow.solveTimeMs).toBeGreaterThan(0);

      // CONTROL — P, an ordinary participant who ENTERED before solving, is
      // anchored at the clock of that entry (no earlier activity to prefer),
      // and that anchor precedes every one of their solves.
      const pAnchor = rowOf(comp.id, P.id)?.login_time;
      expect(pAnchor, "CONTROL: P's anchor was stamped at entry").toBeTruthy();
      await solve(p, t1, "P solves after entering");
      const pSubs = withDb(db => db.prepare("SELECT MIN(submitted_at) AS t FROM submissions WHERE user_id=? AND competition_id=?").get(P.id, comp.id)).t;
      expect(pAnchor <= pSubs, "CONTROL: an ordinary participant's anchor precedes their first solve — the MIN never moves it").toBe(true);
      expect(rowOf(comp.id, P.id)?.login_time, "CONTROL: …and a later solve does not move the anchor").toBe(pAnchor);
    } finally { await w.api.dispose(); await p.api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE DENOMINATOR
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the all-solved denominator counts a competing staff member", () => {

  test("a compete event does NOT end while the staff member is still playing, and DOES end once they finish", async () => {
    const comp = await makeCompetition(sa, saCsrf, "denom-on", { staff_compete: true });
    const task = await sealedTask(author, "denom-task");
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const P = await makeP("denom-P");
    const W = await makeStaff(sa, saCsrf, "denom-W");
    await enrol(sa, saCsrf, comp.id, [P.id, W.id]);
    // PRECONDITION: the tournament default really is auto-end ON; without it
    // "the event did not end" is true of every event.
    expect((await adminRow(sa, comp.id)).auto_end_on_all_solved, "auto-end is on for this fixture").toBeTruthy();

    const p = await signIn(P.email), w = await signIn(W.email);
    try {
      await enter(p, comp.id, "P enters");
      await enter(w, comp.id, "W enters");
      await solve(p, task, "P solves the only challenge");
      // The auto-end writes `ended_at` INSIDE the submit transaction, so this
      // read is deterministic — no poll, no sleep.
      let row = await adminRow(sa, comp.id);
      expect(row.ended_at, "P finishing does NOT end the event: the staff member counts and has not finished").toBeNull();
      expect(row.status, "…and it is still live").toBe("live");

      await solve(w, task, "W solves the only challenge");
      row = await adminRow(sa, comp.id);
      expect(row.ended_at, "the staff member finishing completes the denominator: the event auto-ends").toBeTruthy();
      expect(row.status).toBe("ended");
      expect(row.ended_manually, "…by the RULE, not by an admin").toBeFalsy();
    } finally { await p.api.dispose(); await w.api.dispose(); }
  });

  // "Staff" for scoring is the tag OR the event_admin ROLE, and the switch lifts
  // both TOGETHER. An event admin is admitted by the assign route on EITHER
  // event (they were never tagged), so both halves use the ordinary route and
  // only the column differs. Two TESTS rather than one loop, so a red compete
  // half cannot mask the switch-off half and the report names which broke.
  async function eventAdminDenominatorWorld(staffCompete) {
    const comp = await makeCompetition(sa, saCsrf, `denom-ea-${staffCompete ? "on" : "off"}`, { staff_compete: staffCompete });
    const task = await sealedTask(author, "denom-ea-task");
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const P = await makeP("denomea-p");
    const EA = await makeEventAdmin(sa, saCsrf, anchor.id, "denomea-ea");
    await enrol(sa, saCsrf, comp.id, [P.id, EA.id]);
    const p = await signIn(P.email), ea = await signIn(EA.email);
    // The sole-event landing points BOTH logins at this event before `enter()`
    // runs — one own row each; the event admin's grant on the anchor is not a
    // row. Stated as a precondition so a second row given to either fixture is
    // reported here rather than as a wrong-event read further down.
    expect(p.body.autoResumeCompetitionId, "P's login lands in the event under test").toBe(comp.id);
    expect(ea.body.autoResumeCompetitionId, "the event admin's login lands in the event under test (a grant is not a row)").toBe(comp.id);
    await enter(ea, comp.id, "EA enters");
    await enter(p, comp.id, "P enters");
    return { comp, task, p, ea, dispose: async () => { await p.api.dispose(); await ea.api.dispose(); } };
  }

  test("the ROLE half: an event admin counts in a compete event's denominator — P finishing does not end it, the event admin finishing does", async () => {
    const w = await eventAdminDenominatorWorld(true);
    try {
      await solve(w.p, w.task, "P solves");
      const row = await adminRow(sa, w.comp.id);
      expect(row.ended_at, "compete event: the event admin still has to finish, so P finishing does not end it").toBeNull();
      expect(row.status, "…and it is still live").toBe("live");
      await solve(w.ea, w.task, "EA solves");
      const after = await adminRow(sa, w.comp.id);
      expect(after.ended_at, "…and once the event admin finishes it auto-ends").toBeTruthy();
      expect(after.ended_manually, "…by the RULE, not by an admin").toBeFalsy();
    } finally { await w.dispose(); }
  });

  test("CONTROL, the ROLE half: on a switch-off twin the event admin is not in the denominator — P alone ends it", async () => {
    const w = await eventAdminDenominatorWorld(false);
    try {
      expect((await adminRow(sa, w.comp.id)).ended_at, "live before anybody solves").toBeNull();
      await solve(w.p, w.task, "P solves");
      const row = await adminRow(sa, w.comp.id);
      expect(row.ended_at, "switch-off twin: the event admin is not in the denominator, so P alone ends it").toBeTruthy();
      expect(row.status).toBe("ended");
    } finally { await w.dispose(); }
  });

  test("a BENCHMARK row is NOT in a compete event's denominator — the switch lifts the staff half only, so the participant alone ends it", async () => {
    // `getStaffOrBenchmarkSet({staffCompete:true})` returns the benchmark-only
    // set: the switch lifts the `staff` tag and the `event_admin` role and
    // NOTHING else. Without this arm a build that lifted the benchmark exclusion
    // too on a compete event passes every test in the file (measured by the
    // skeptic: the compete branch replaced with `[]` left all 23 green), because
    // §1's benchmark row SOLVES and its event is held open by a bystander. Here
    // the benchmark row enters and never solves, so it is the ONLY thing that
    // could keep the event open — and it must not. The first test of this
    // describe is the control: the same shape with a STAFF row keeps it open.
    const comp = await makeCompetition(sa, saCsrf, "denom-bm", { staff_compete: true });
    const task = await sealedTask(author, "denom-bm-task");
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const P = await makeP("denombm-P");
    const BM = await makeP("denombm-BM");
    await tagUser(sa, saCsrf, BM.id, "benchmark");
    await enrol(sa, saCsrf, comp.id, [P.id, BM.id]);
    expect((await adminRow(sa, comp.id)).auto_end_on_all_solved, "auto-end is on for this fixture").toBeTruthy();
    const p = await signIn(P.email), bm = await signIn(BM.email);
    try {
      // The benchmark row ENTERS and is stamped like a member — so if the
      // compete branch wrongly admitted it, it would count, and P finishing
      // alone would leave the event live.
      await enter(bm, comp.id, "the benchmark row enters the compete event");
      await enter(p, comp.id, "P enters");
      expect(rowOf(comp.id, BM.id)?.login_time, "the benchmark row is anchored like a member").toBeTruthy();
      expect((await adminRow(sa, comp.id)).ended_at, "live before anybody solves").toBeNull();
      await solve(p, task, "P solves the only challenge");
      const row = await adminRow(sa, comp.id);
      expect(row.ended_at, "P finishing ENDS a compete event: the benchmark row is not in its denominator").toBeTruthy();
      expect(row.status).toBe("ended");
      expect(row.ended_manually, "…by the RULE, not by an admin").toBeFalsy();
    } finally { await p.api.dispose(); await bm.api.dispose(); }
  });

  test("CONTROL: on a switch-off twin the same staff member with a planted row does not count — the participant alone ends it", async () => {
    const comp = await makeCompetition(sa, saCsrf, "denom-off", { staff_compete: false });
    const task = await sealedTask(author, "denomctl-task");
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const P = await makeP("denomctl-P");
    const W = await makeStaff(sa, saCsrf, "denomctl-W");
    await enrol(sa, saCsrf, comp.id, [P.id]);
    plantRow(comp.id, W.id);

    const p = await signIn(P.email), w = await signIn(W.email);
    try {
      // W ENTERS and is stamped like a member — so if the exclusion were broken
      // they would count, and P finishing alone would leave the event live.
      await enter(w, comp.id, "W enters the twin");
      await enter(p, comp.id, "P enters the twin");
      expect((await adminRow(sa, comp.id)).ended_at, "live before anybody solves").toBeNull();
      await solve(p, task, "P solves the only challenge");
      const row = await adminRow(sa, comp.id);
      expect(row.ended_at, "P finishing ENDS a switch-off event: the planted staff row is not in the denominator").toBeTruthy();
      expect(row.status).toBe("ended");
    } finally { await p.api.dispose(); await w.api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE ACTIVITY CSV
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the activity export carries a competing staff member's rows", () => {

  test("the staff member's rows are in the file where staff compete, and absent from the switch-off twin's", async () => {
    const on = await buildBoardWorld({ staffCompete: true, label: "csv" });
    const off = await buildBoardWorld({ staffCompete: false, label: "csvctl" });
    try {
      const fetchCsv = async (compId, what) => {
        const r = await sa.get(`/api/admin/export/competition-activity?competitionId=${encodeURIComponent(compId)}`);
        expect(r.ok(), `${what}: ${r.status()} ${await r.text()}`).toBeTruthy();
        expect(r.headers()["content-type"] || "", "it is a CSV").toMatch(/text\/csv/);
        return r.text();
      };
      const csvOn = await fetchCsv(on.comp.id, "compete export");
      expect(csvOn, "CONTROL: the participant's row is in the compete file").toContain(on.P.nickname);
      expect(csvOn, "the staff competitor's row is in the compete file").toContain(on.W.nickname);
      expect(csvOn, "the event-admin competitor's row is in the compete file").toContain(on.EA.nickname);
      // PRESENCE IS NOT CORRECTNESS. A row can be there with every signal "No"
      // if a later change lifted the participant-set exclusion and left the
      // ACTIVITY joins filtered by tag — so the file is parsed and the Solved
      // cell of each competitor's row for the fixture challenge is asserted
      // against the participant's, which is the control for the column itself.
      const rowsOn = parseCsvObjects(csvOn);
      const solvedCell = (nick, what) => {
        const r = rowsOn.find(o => o.Nickname === nick && o.Challenge === on.task.title);
        expect(r, `${what}: exactly this (participant, challenge) row is in the file`).toBeTruthy();
        return r.Solved;
      };
      expect(solvedCell(on.P.nickname, "CONTROL: the participant"), "the participant's solve is in the file").toBe("Yes");
      expect(solvedCell(on.W.nickname, "the staff competitor"), "the staff competitor's SOLVE is in the file, not merely their row").toBe("Yes");
      expect(solvedCell(on.EA.nickname, "the event-admin competitor"), "the event-admin competitor's solve is in the file").toBe("Yes");
      expect(solvedCell(on.A.nickname, "the admin-role competitor"), "the admin-role competitor's solve is in the file").toBe("Yes");
      // And the bystander who never solved reads "No" — or "Yes" is what every
      // cell says and the three assertions above are vacuous.
      expect(solvedCell(on.B.nickname, "the bystander"), "the bystander's cell is No").toBe("No");

      const csvOff = await fetchCsv(off.comp.id, "switch-off export");
      expect(csvOff, "CONTROL: the participant's row is in the twin's file").toContain(off.P.nickname);
      expect(csvOff, "a staff-tagged user with a planted row is NOT in a switch-off file").not.toContain(off.W.nickname);
      expect(csvOff, "an admin (staff-tagged) with a planted row is NOT in a switch-off file either").not.toContain(off.A.nickname);
      // Documented as unchanged: the event-admin ROLE was never excluded from
      // this file (only the tag), so their row is there either way.
      expect(csvOff, "an event admin's row was never excluded from this file").toContain(off.EA.nickname);
      // Each file is its own event's: the twin's people are not in the compete
      // file and vice versa, so the two assertions above cannot be reading one
      // shared export.
      expect(csvOn).not.toContain(off.P.nickname);
      expect(csvOff).not.toContain(on.P.nickname);
    } finally { await on.dispose(); await off.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. THE CERTIFICATE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — a competing staff member can mint a certificate, and a spectator cannot", () => {

  test("after end-now the staff member mints (200) and canShareBadge says so; on the switch-off twin the mint is refused and the CTA withheld", async () => {
    const on = await buildBoardWorld({ staffCompete: true, label: "cert" });
    const off = await buildBoardWorld({ staffCompete: false, label: "certctl" });
    try {
      await endNow(sa, saCsrf, on.comp.id);
      await endNow(sa, saCsrf, off.comp.id);

      // ── COMPETE EVENT ──────────────────────────────────────────────────────
      const wBoard = await (await on.ctx.W.api.get("/api/leaderboard")).json();
      expect(wBoard.ended, "the event really has ended").toBe(true);
      expect(wBoard.canShareBadge, "the CTA is offered to the staff competitor").toBe(true);
      // THE OTHER OFFER SURFACE. `GET /api/me/certificates` walks the caller's
      // own rows through the SAME `_mintEligibility` the mint enforces — and a
      // staff competitor now HOLDS a row for it to walk. Claimable before the
      // mint, held after it; a build that skipped staff rows in that loop would
      // withhold the offer while the mint beside it still succeeds.
      const certs = async (ctx) => {
        const r = await ctx.api.get("/api/me/certificates");
        expect(r.ok(), `certificates: ${r.status()} ${await r.text()}`).toBeTruthy();
        return r.json();
      };
      const before = await certs(on.ctx.W);
      expect(before.claimable.map(c => c.competitionId), "the compete event is CLAIMABLE for the staff competitor before the mint").toContain(on.comp.id);
      expect(before.certificates.map(c => c.competitionId), "…and not yet held").not.toContain(on.comp.id);
      const mint = await on.ctx.W.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(on.ctx.W.csrf) });
      expect(mint.status(), `the staff competitor mints: ${await mint.text()}`).toBe(200);
      const badge = await mint.json();
      expect(badge.token || badge.badgeUrl, "a real badge came back").toBeTruthy();
      const after = await certs(on.ctx.W);
      expect(after.certificates.map(c => c.competitionId), "held after the mint").toContain(on.comp.id);
      expect(after.claimable.map(c => c.competitionId), "…and no longer offered").not.toContain(on.comp.id);
      // And the event admin competitor, from the same event.
      const eaBoard = await (await on.ctx.EA.api.get("/api/leaderboard")).json();
      expect(eaBoard.canShareBadge, "the CTA is offered to the event-admin competitor").toBe(true);
      const eaMint = await on.ctx.EA.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(on.ctx.EA.csrf) });
      expect(eaMint.status(), `the event-admin competitor mints: ${await eaMint.text()}`).toBe(200);
      // And the ADMIN-ROLE competitor, from participant view.
      expect((await (await on.ctx.A.api.get("/api/leaderboard")).json()).canShareBadge, "the CTA is offered to the admin competitor").toBe(true);
      const aMint = await on.ctx.A.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(on.ctx.A.csrf) });
      expect(aMint.status(), `the admin competitor mints: ${await aMint.text()}`).toBe(200);
      // CONTROL that the mint is not simply open to everybody with a row: the
      // ordinary participant still mints too, which is the shape a correct
      // build shares with a broken one — so the twin below is the real control.
      const pMint = await on.ctx.P.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(on.ctx.P.csrf) });
      expect(pMint.status(), "the participant mints").toBe(200);

      // ── SWITCH-OFF TWIN ────────────────────────────────────────────────────
      const wOff = await (await off.ctx.W.api.get("/api/leaderboard")).json();
      expect(wOff.ended, "the twin really has ended").toBe(true);
      expect(wOff.canShareBadge, "the CTA is withheld from a spectator with a planted row").toBe(false);
      const certsOff = await certs(off.ctx.W);
      expect(certsOff.claimable.map(c => c.competitionId), "a spectator with a planted row is offered nothing").not.toContain(off.comp.id);
      expect(certsOff.certificates.map(c => c.competitionId), "…and holds nothing").not.toContain(off.comp.id);
      const mintOff = await off.ctx.W.api.post(`/api/competitions/${off.comp.id}/badge`, { headers: H(off.ctx.W.csrf) });
      expect(mintOff.status(), "the mint is refused on a switch-off event").toBe(403);
      expect((await mintOff.json()).error, "…because they are not on the board").toMatch(/did not participate/i);
      expect((await (await off.ctx.A.api.get("/api/leaderboard")).json()).canShareBadge, "the CTA is withheld from an admin with a planted row on the twin").toBe(false);
      const aMintOff = await off.ctx.A.api.post(`/api/competitions/${off.comp.id}/badge`, { headers: H(off.ctx.A.csrf) });
      expect(aMintOff.status(), "the admin is refused on a switch-off event").toBe(403);
      expect((await (await off.ctx.EA.api.get("/api/leaderboard")).json()).canShareBadge, "the CTA is withheld from an event admin on the twin").toBe(false);
      const eaOff = await off.ctx.EA.api.post(`/api/competitions/${off.comp.id}/badge`, { headers: H(off.ctx.EA.csrf) });
      expect(eaOff.status(), "the event admin is refused on a switch-off event").toBe(403);
      // CONTROL: the twin's participant mints, so the twin's refusals are about
      // the switch and not about a broken end-now.
      const pOff = await off.ctx.P.api.post(`/api/competitions/${off.comp.id}/badge`, { headers: H(off.ctx.P.csrf) });
      expect(pOff.status(), `the twin's participant mints: ${await pOff.text()}`).toBe(200);
      // No badge row exists for the refused pair — a 403 that had already
      // written is worse than none.
      const rows = withDb(db => db.prepare("SELECT user_id FROM achievement_badges WHERE competition_id=?").all(off.comp.id).map(r => r.user_id));
      expect(rows, "no certificate row for the spectator").not.toContain(off.W.id);
      expect(rows, "no certificate row for the event admin on the twin").not.toContain(off.EA.id);
      expect(rows, "no certificate row for the admin on the twin").not.toContain(off.A.id);
      expect(rows, "the participant's certificate row exists").toContain(off.P.id);
    } finally { await on.dispose(); await off.dispose(); }
  });

  test("a staff competitor OUTSIDE the top three takes a PARTICIPATION certificate — the placement short-circuit is not the only door", async () => {
    // Every mint in the test above is a PLACEMENT: the compete world has few
    // enough solvers that W lands in the top three, and `canShareBadge` then
    // short-circuits on `isPlacementRank` before `participantAttempted` is ever
    // asked about a staff competitor. A build that let staff take a placement
    // but not a participation certificate would survive it. Here W answers WRONG
    // first, so their score is 5 below every other solver's and they finish
    // fourth — behind P, EA and A, who all hold the full score.
    const on = await buildBoardWorld({ staffCompete: true, wWrongFirst: true, label: "part" });
    try {
      await endNow(sa, saCsrf, on.comp.id);
      const wBoard = await (await on.ctx.W.api.get("/api/leaderboard")).json();
      expect(wBoard.ended, "the event really has ended").toBe(true);
      // PRECONDITION of the whole arm: W is really outside the top three, or the
      // mint below takes the placement branch and this test repeats the one above.
      expect(wBoard.me?.userId, "W resolves their own row").toBe(on.W.id);
      expect(wBoard.me.rank, "W is fourth: three full-score solvers ahead of a wrong-first one").toBe(4);
      expect(wBoard.canShareBadge, "the CTA is offered on the ATTEMPTED branch").toBe(true);
      const mint = await on.ctx.W.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(on.ctx.W.csrf) });
      expect(mint.status(), `the staff competitor mints a participation certificate: ${await mint.text()}`).toBe(200);
      const badge = await mint.json();
      expect(badge.placement, "not a placement").toBe(false);
      expect(badge.basis, "…a PARTICIPATION certificate").toBe("participation");
      expect(badge.rank, "…frozen at the rank the board gave").toBe(4);
      // CONTROL: the participant, who finished in the top three, takes a
      // placement — so the branch above is W's rank and not a build that stopped
      // issuing placements altogether.
      const pMint = await on.ctx.P.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(on.ctx.P.csrf) });
      expect(pMint.status(), `the participant mints: ${await pMint.text()}`).toBe(200);
      const pBadge = await pMint.json();
      expect(pBadge.placement, "the participant's is a placement").toBe(true);
      expect(pBadge.basis).toBe("placement");
    } finally { await on.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ATTEMPT GRANTS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — an attempt grant reaches a competing admin-tier target on a compete event", () => {

  /** A compete (or not) event holding a sealed challenge capped at one attempt. */
  async function cappedWorld(staffCompete, label) {
    const comp = await makeCompetition(sa, saCsrf, label, { staff_compete: staffCompete });
    const task = await sealedTask(author, `${label}-task`, { attempt_cap: 1 });
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    return { comp, task };
  }
  const grant = (api, csrf, taskId, userId, competitionId) =>
    api.post(`/api/admin/tasks/${taskId}/attempt-grant`, { headers: H(csrf), data: { userId, competitionId, extra: 1 } });

  test("CONTROL: the TAG never mattered on this route, the ROW does — a staff-tagged participant enrolled in a compete event is granted, an un-enrolled one is 409", async () => {
    // Stated honestly: this route has never consulted user tags, so a
    // staff-TAGGED role-participant target takes the ordinary participant path
    // before and after v8.12.0. What is feature-specific is only that the
    // ENROLMENT exists at all (the assign route admits them here since
    // v8.12.0), which `enrol` asserts. The discriminating attempt-grant coverage
    // — the role-ADMIN and role-EVENT_ADMIN targets — is in the two tests below;
    // this one is the participant-shaped baseline they are read against.
    const { comp, task } = await cappedWorld(true, "grant-w");
    const W = await makeStaff(sa, saCsrf, "grant-W");
    await enrol(sa, saCsrf, comp.id, [W.id]);
    const r = await grant(sa, saCsrf, task.id, W.id, comp.id);
    expect(r.status(), `grant to a staff-tagged competitor: ${await r.text()}`).toBe(200);
    const d = await r.json();
    expect(d.granted_total, "one extra attempt is recorded").toBe(1);
    expect(d.attempts.effective, "the effective cap moved from 1 to 2").toBe(2);
    // A staff member NOT enrolled is refused as not enrolled — the grant is not
    // open to everybody with the tag, and for a role-PARTICIPANT target the
    // row test is the one that answers.
    const W2 = await makeStaff(sa, saCsrf, "grant-W2");
    const r2 = await grant(sa, saCsrf, task.id, W2.id, comp.id);
    expect(r2.status(), "a non-enrolled staff member is refused").toBe(409);
    expect((await r2.json()).error).toMatch(/not enrolled/i);
  });

  const grantsFor = (userId, compId) =>
    withDb(db => db.prepare("SELECT COUNT(*) AS n FROM attempt_grants WHERE user_id=? AND competition_id=?").get(userId, compId)).n;

  test("a role-ADMIN competitor is granted by the superadmin, refused to a regular admin (peer doctrine), refused where the switch is off — and refused where they hold NO row even with the switch on", async () => {
    const { comp, task } = await cappedWorld(true, "grant-adm");
    // The TARGET: a promoted admin (auto-tagged staff), enrolled by the
    // superadmin — a regular admin may not enrol a peer, the superadmin may.
    // Promoted WITHOUT a login: a target never acts, so there is no context to
    // leak on an assertion failure.
    const target = await makeAdminRow(sa, saCsrf, "grant-target");
    await enrol(sa, saCsrf, comp.id, [target.id]);

    // As the BUILT-IN superadmin → 200, and the cap really moved.
    const ok = await grant(sa, saCsrf, task.id, target.id, comp.id);
    expect(ok.status(), `superadmin grants to an enrolled admin on a compete event: ${await ok.text()}`).toBe(200);
    const okBody = await ok.json();
    expect(okBody.granted_total, "one extra attempt is recorded for the admin competitor").toBe(1);
    expect(okBody.attempts.effective, "the admin competitor's effective cap moved from 1 to 2").toBe(2);

    // As a USER-BACKED REGULAR admin actor (not enrolled anywhere) → 403.
    const actor = await makeAdmin(sa, saCsrf, "grant-actor");
    try {
      const no = await grant(actor.api, actor.csrf, task.id, target.id, comp.id);
      expect(no.status(), "a regular admin may not grant to an admin account").toBe(403);
      expect((await no.json()).error, "…and the refusal names the tier").toMatch(/Only a superadmin/i);
      // CONTROL for the actor: the same regular admin CAN grant to an ordinary
      // participant on the same event, so the 403 is the peer doctrine and not
      // a broken actor.
      const P = await makeP("grant-P");
      await enrol(sa, saCsrf, comp.id, [P.id]);
      const yes = await grant(actor.api, actor.csrf, task.id, P.id, comp.id);
      expect(yes.status(), `a regular admin grants to a participant: ${await yes.text()}`).toBe(200);
    } finally { await actor.api.dispose(); }

    // THE ROW HALF OF THE CARVE-OUT. `_competitorTarget` is `enrolled AND switch`;
    // the switch-off twin below pins the switch half, and this pins the row
    // half: an admin who holds NO row on a COMPETE event is refused as an admin
    // account (403), NOT told they are "not enrolled" (409) — a build that keyed
    // the carve-out on the switch alone would fall through to the 409.
    const stranger = await makeAdminRow(sa, saCsrf, "grant-stranger");
    const noRow = await grant(sa, saCsrf, task.id, stranger.id, comp.id);
    expect(noRow.status(), `an admin with no row on a compete event is refused as an admin, not as un-enrolled: ${await noRow.text()}`).toBe(403);
    expect((await noRow.json()).error).toMatch(/participant accounts only/i);
    expect(grantsFor(stranger.id, comp.id), "nothing was written for the stranger").toBe(0);

    // SWITCH OFF: an admin target with a planted row is refused as an admin
    // account, whoever asks — the competitor carve-out exists only where the
    // switch is on.
    const off = await cappedWorld(false, "grant-off");
    const target2 = await makeAdminRow(sa, saCsrf, "grant-target2");
    plantRow(off.comp.id, target2.id);
    const refused = await grant(sa, saCsrf, off.task.id, target2.id, off.comp.id);
    expect(refused.status(), "an admin target on a switch-off event is refused even to the superadmin").toBe(403);
    expect((await refused.json()).error).toMatch(/participant accounts only/i);
    expect(grantsFor(target2.id, off.comp.id), "nothing was written").toBe(0);
  });

  test("a role-EVENT_ADMIN competitor is granted by a REGULAR admin too (the peer doctrine names admin/superadmin only), grants accumulate, and the switch-off twin refuses them as an admin account", async () => {
    // The event_admin ROLE is the other exclusion the switch lifts, and on this
    // route it is the discriminating target: the peer gate is written over
    // admin/superadmin, so a REGULAR admin may grant to an enrolled event admin
    // where they may not to an enrolled admin. A build that widened the gate
    // to "every non-participant role", or narrowed the carve-out to
    // admin/superadmin targets, refuses this cell and passes every other.
    const { comp, task } = await cappedWorld(true, "grant-ea");
    const EA = await makeEventAdmin(sa, saCsrf, anchor.id, "grant-ea-target");
    await enrol(sa, saCsrf, comp.id, [EA.id]);
    const actor = await makeAdmin(sa, saCsrf, "grant-ea-actor");
    try {
      const first = await grant(actor.api, actor.csrf, task.id, EA.id, comp.id);
      expect(first.status(), `a regular admin grants to an enrolled event admin on a compete event: ${await first.text()}`).toBe(200);
      const b1 = await first.json();
      expect(b1.granted_total, "one extra attempt recorded").toBe(1);
      expect(b1.attempts.effective, "the event admin's effective cap moved from 1 to 2").toBe(2);

      // The superadmin grants again: the ledger ACCUMULATES rather than resets.
      const second = await grant(sa, saCsrf, task.id, EA.id, comp.id);
      expect(second.status(), `the superadmin grants to the same event admin: ${await second.text()}`).toBe(200);
      const b2 = await second.json();
      expect(b2.granted_total, "two grants accumulate on one ledger row").toBe(2);
      expect(b2.attempts.effective, "…and the effective cap is now 3").toBe(3);
    } finally { await actor.api.dispose(); }

    // SWITCH OFF: the same event admin is enrolled by the ordinary route (the
    // assign route has always admitted an untagged event admin) and is then an
    // admin-tier target with no carve-out — refused as an admin account, even
    // to the superadmin, with nothing written.
    const off = await cappedWorld(false, "grant-ea-off");
    await enrol(sa, saCsrf, off.comp.id, [EA.id]);
    const refused = await grant(sa, saCsrf, off.task.id, EA.id, off.comp.id);
    expect(refused.status(), `an enrolled event admin on a switch-off event is refused: ${await refused.text()}`).toBe(403);
    expect((await refused.json()).error).toMatch(/participant accounts only/i);
    expect(grantsFor(EA.id, off.comp.id), "nothing was written on the twin").toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SELECT-TIMESLOT
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — a competing staff member takes the participant path through select-timeslot", () => {

  /** A two-session event: one slot LIVE now, one two hours out. */
  async function twoSessions(staffCompete, label) {
    const comp = await makeCompetition(sa, saCsrf, label, { staff_compete: staffCompete });
    const mk = async (name, startMs, dur) => {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(saCsrf), data: { name, start_time: iso(startMs), duration_minutes: dur },
      });
      expect(r.ok(), `session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot;
    };
    const live = await mk("Live now", -60_000, 600);
    const later = await mk("Later today", 2 * 3600_000, 60);
    expect(live.status, "the first session really is live").toBe("live");
    expect(later.status, "the second really is upcoming").toBe("upcoming");
    return { comp, live, later };
  }
  const pick = (ctx, timeslotId, confirmLive) =>
    ctx.api.post("/api/select-timeslot", { headers: H(ctx.csrf), data: { timeslotId, ...(confirmLive ? { confirmLive: true } : {}) } });

  test("(a) on a compete event the staff member WITH a row meets the live-session confirm and is then locked to their session, exactly like a participant", async () => {
    const { comp, live, later } = await twoSessions(true, "slot-on");
    const W = await makeStaff(sa, saCsrf, "slot-W");
    const P = await makeP("slot-P");
    await enrol(sa, saCsrf, comp.id, [W.id, P.id]);
    const w = await signIn(W.email), p = await signIn(P.email);
    try {
      for (const [ctx, uid, who] of [[w, W.id, "the staff competitor"], [p, P.id, "the participant"]]) {
        await enter(ctx, comp.id, `${who} enters`);
        // No confirm → the participant path answers 200 {ok:false, requireConfirmation:true}.
        const ask = await pick(ctx, live.id, false);
        expect(ask.status(), `${who}: the confirm is a 200`).toBe(200);
        const askBody = await ask.json();
        expect(askBody.ok, `${who}: not joined yet`).toBe(false);
        expect(askBody.requireConfirmation, `${who}: the live-session confirm is REQUIRED`).toBe(true);
        // Nothing was written by the ask.
        const before = withDb(db => db.prepare("SELECT timeslot_id, login_time FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, uid));
        expect(before, `${who}: holds a row`).toBeTruthy();
        expect(before.timeslot_id, `${who}: the ask pinned no session`).toBeNull();

        const yes = await pick(ctx, live.id, true);
        expect(yes.ok(), `${who}: confirmed join: ${yes.status()} ${await yes.text()}`).toBeTruthy();
        expect((await yes.json()).ok, `${who}: joined the live session`).toBe(true);

        const locked = await pick(ctx, later.id, true);
        expect(locked.status(), `${who}: switching session after entering a live one is refused`).toBe(400);
        expect((await locked.json()).error, `${who}: with the participant's own message`).toMatch(/already entered a live session and cannot change/i);
      }
      // The lock is real on the row: W's session is the live one and stays so.
      const wRow = withDb(db => db.prepare("SELECT timeslot_id, login_time FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id));
      expect(wRow.timeslot_id, "the staff competitor's row is pinned to the live session").toBe(live.id);
      expect(wRow.login_time, "…with the solve-clock anchor stamped").toBeTruthy();
    } finally { await w.api.dispose(); await p.api.dispose(); }
  });

  // THE PREDICATE IS A CONJUNCTION — `staffUser = tagged && !(row && switch)` —
  // so it has FOUR cells, and the two above drive only the diagonal:
  //
  //                   switch ON            switch OFF
  //     row        (a) participant      (c) spectator   ← pre-release row
  //     no row     (d) spectator        (b) spectator
  //
  // A build keyed on the ROW alone (`tagged && !row`) passes (a) and (b) and
  // fails (c); one keyed on the SWITCH alone (`tagged && !switch`) passes (a)
  // and (b) and fails (d). Both corners are real: (c) is every participant who
  // was promoted to admin before the release and kept their rows, (d) is any
  // staff member who opens a compete event they are not enrolled in — the
  // select-competition door admits staff with no row on any event.

  test("(e) PER-SLOT scoring: the staff competitor counts in their SESSION's denominator and is on the session's board", async () => {
    // Both per-slot branches — `scoringParticipantIds(compId, tsId)` and the
    // timeslot-scoped users query in `buildLeaderboardEntries` — read the same
    // switch as the competition-wide ones, so they cannot diverge TODAY; this
    // arm is what notices a per-slot edit tomorrow (a `staffCompete` computed on
    // the no-timeslot branch only ends the session the moment P finishes).
    const { comp, live } = await twoSessions(true, "slot-score");
    expect(withDb(db => db.prepare("SELECT leaderboard_mode FROM competitions WHERE id=?").get(comp.id)).leaderboard_mode,
      "per_slot is the mode under test").toBe("per_slot");
    const task = await sealedTask(author, "slot-score-task");
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const W = await makeStaff(sa, saCsrf, "slotscore-W");
    const P = await makeP("slotscore-P");
    await enrol(sa, saCsrf, comp.id, [W.id, P.id]);
    const w = await signIn(W.email), p = await signIn(P.email);
    try {
      for (const [ctx, who] of [[w, "W"], [p, "P"]]) {
        await enter(ctx, comp.id, `${who} enters`);
        const yes = await pick(ctx, live.id, true);
        expect(yes.ok(), `${who} joins the live session: ${yes.status()} ${await yes.text()}`).toBeTruthy();
        expect((await yes.json()).ok, `${who} joined`).toBe(true);
      }
      const slotEndedAt = () => withDb(db => db.prepare("SELECT ended_at FROM competition_timeslots WHERE id=?").get(live.id)).ended_at;
      expect(slotEndedAt(), "the session is live before anybody solves").toBeNull();
      await solve(p, task, "P solves the only challenge");
      expect(slotEndedAt(), "P finishing does NOT end the session: the staff competitor is in the SLOT's denominator").toBeNull();
      // The session-scoped board (per_slot mode reads the caller's own slot).
      const pBoard = await (await p.api.get("/api/leaderboard")).json();
      expect(pBoard.board.map(e => e.userId), "the staff competitor is on the session's board").toContain(W.id);
      expect(pBoard.board.map(e => e.userId), "…beside the participant (control)").toContain(P.id);
      const adminSlot = await (await sa.get(`/api/admin/leaderboard?competitionId=${comp.id}&timeslotId=${encodeURIComponent(live.id)}`)).json();
      expect(adminSlot.filter(e => !e.isBenchmark).map(e => e.userId), "…and on the admin board scoped to that session").toContain(W.id);
      await solve(w, task, "W solves the only challenge");
      expect(slotEndedAt(), "the staff competitor finishing completes the slot's denominator: the session auto-ends").toBeTruthy();
    } finally { await w.api.dispose(); await p.api.dispose(); }
  });

  test("CONTROL (b): on a switch-off twin the same staff member is a spectator — no confirm, and free to switch sessions", async () => {
    const { comp, live, later } = await twoSessions(false, "slot-off");
    const W = await makeStaff(sa, saCsrf, "slotctl-W");
    const w = await signIn(W.email);
    try {
      await enter(w, comp.id, "the spectator enters the twin");
      const first = await pick(w, live.id, false);
      expect(first.ok(), `a spectator joins the live session without a confirm: ${first.status()} ${await first.text()}`).toBeTruthy();
      const firstBody = await first.json();
      expect(firstBody.ok, "joined outright").toBe(true);
      expect(firstBody.requireConfirmation, "no confirmation was asked of a spectator").toBeFalsy();
      const second = await pick(w, later.id, false);
      expect(second.ok(), `a spectator may switch to the other session freely: ${second.status()} ${await second.text()}`).toBeTruthy();
      expect((await second.json()).ok).toBe(true);
      // No row was ever written for them.
      const row = withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id));
      expect(row, "a spectator holds no row").toBeFalsy();
    } finally { await w.api.dispose(); }
  });

  test("CONTROL (c): a staff member WITH a pre-release row on a switch-off event is still a spectator — the row alone does not make a competitor", async () => {
    const { comp, live, later } = await twoSessions(false, "slot-rowoff");
    const W = await makeStaff(sa, saCsrf, "slotrow-W");
    plantRow(comp.id, W.id);
    const w = await signIn(W.email);
    try {
      await enter(w, comp.id, "the row-holding spectator enters the switch-off event");
      // PRECONDITION of the cell: the row is there and unpinned.
      const before = withDb(db => db.prepare("SELECT timeslot_id, login_time FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id));
      expect(before, "the planted row exists").toBeTruthy();
      expect(before.timeslot_id, "…and pins no session yet").toBeNull();

      const first = await pick(w, live.id, false);
      expect(first.ok(), `no live-session confirm is asked of a spectator, row or no row: ${first.status()} ${await first.text()}`).toBeTruthy();
      const firstBody = await first.json();
      expect(firstBody.ok, "joined the live session outright").toBe(true);
      expect(firstBody.requireConfirmation, "the confirm belongs to competitors, and the switch is off").toBeFalsy();
      const mid = withDb(db => db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id));
      expect(mid.timeslot_id, "the pick landed on the row (the row is still a row)").toBe(live.id);

      // A COMPETITOR would be locked to the live session here (arm (a)); a
      // spectator switches freely, and the switch really lands on the row.
      const second = await pick(w, later.id, false);
      expect(second.ok(), `a spectator with a row switches sessions freely: ${second.status()} ${await second.text()}`).toBeTruthy();
      expect((await second.json()).ok, "switched").toBe(true);
      const after = withDb(db => db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id));
      expect(after.timeslot_id, "the free switch actually moved the row to the SECOND session").toBe(later.id);
    } finally { await w.api.dispose(); }
  });

  test("CONTROL (d): a staff member with NO row on a COMPETE event is a spectator — the switch alone does not make a competitor", async () => {
    const { comp, live, later } = await twoSessions(true, "slot-norow-on");
    const W = await makeStaff(sa, saCsrf, "slotnorow-W");
    // PRECONDITION: never enrolled here — the select-competition door admits a
    // staff member with no row on ANY event, which is what makes this cell
    // reachable at all.
    expect(withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id)),
      "not enrolled in the compete event").toBeFalsy();
    const w = await signIn(W.email);
    try {
      await enter(w, comp.id, "the un-enrolled staff member enters the compete event");
      const first = await pick(w, live.id, false);
      expect(first.ok(), `no confirm is asked of a staff member who holds no row, whatever the switch says: ${first.status()} ${await first.text()}`).toBeTruthy();
      const firstBody = await first.json();
      expect(firstBody.ok, "joined the live session outright").toBe(true);
      expect(firstBody.requireConfirmation, "no confirmation — they are not competing here").toBeFalsy();
      const second = await pick(w, later.id, false);
      expect(second.ok(), `…and switches freely: ${second.status()} ${await second.text()}`).toBeTruthy();
      expect((await second.json()).ok).toBe(true);
      // Still no row: a session pick must never manufacture a membership.
      expect(withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, W.id)),
        "no row was written by either pick").toBeFalsy();
    } finally { await w.api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. THE PARTICIPANT WIRE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — /api/me and /api/my-competitions say which events a staff member OWNS and COMPETES in", () => {

  test("own / competing / staff_compete / can_leave per row, over the whole-platform list", async () => {
    // Four events, four shapes:
    //   joined  — compete event, self-enrolled through its join link (can_leave)
    //   placed  — compete event, enrolled by an admin (own, no can_leave)
    //   other   — switch-off event W is not in (listed, own:false)
    //   spect   — switch-off event with a live join link: joining makes W a
    //             SPECTATOR, no row
    const joined = await makeCompetition(sa, saCsrf, "wire-joined", { staff_compete: true, self_enroll_enabled: true });
    const placed = await makeCompetition(sa, saCsrf, "wire-placed", { staff_compete: true });
    const other  = await makeCompetition(sa, saCsrf, "wire-other",  { staff_compete: false });
    const spect  = await makeCompetition(sa, saCsrf, "wire-spect",  { staff_compete: false, self_enroll_enabled: true });
    const W = await makeStaff(sa, saCsrf, "wire-W");
    await enrol(sa, saCsrf, placed.id, [W.id]);

    const tokenFor = joinTokenFor;

    const w = await signIn(W.email);
    try {
      // THE LOGIN PAYLOAD is the same builder, read BEFORE the joins below: the
      // admin-placed event is already own + competing, the link events are not
      // yet — so a build that computed `own` from anything but the row fails here.
      const atLogin = Object.fromEntries((w.body.competitions || []).map(c => [c.id, c]));
      expect(atLogin[placed.id]?.own, "login: placed → own").toBe(true);
      expect(atLogin[placed.id]?.competing, "login: placed → competing").toBe(true);
      expect(atLogin[joined.id]?.own, "login: not yet joined → not own").toBe(false);
      expect(atLogin[joined.id]?.competing, "login: not yet joined → not competing").toBe(false);
      expect(!!atLogin[joined.id]?.staff_compete, "login: the compete flag is the EVENT's, row or no row").toBe(true);

      // The PUBLIC preview a staff member reads before scanning in says whether
      // the join will make them a competitor.
      for (const [c, want] of [[joined, true], [spect, false]]) {
        const pv = await (await w.api.get(`/api/competitions/self-enroll/${await tokenFor(c.id)}`)).json();
        expect(pv.id, "the preview resolves the event").toBe(c.id);
        expect(pv.staff_compete, `the preview carries staff_compete=${want}`).toBe(want);
      }

      // Join the compete event through its link → a real row, self_enroll.
      const j = await w.api.post("/api/competitions/join", { headers: H(w.csrf), data: { token: await tokenFor(joined.id) } });
      expect(j.ok(), `join the compete event: ${j.status()} ${await j.text()}`).toBeTruthy();
      const jb = await j.json();
      expect(jb.alreadyMember, "a fresh join").toBe(false);
      expect(jb.staffSpectator, "on a compete event the join is a REAL enrolment").toBeFalsy();
      // Join the switch-off event through its link → spectator, no row.
      const s = await w.api.post("/api/competitions/join", { headers: H(w.csrf), data: { token: await tokenFor(spect.id) } });
      expect(s.ok(), `join the switch-off event: ${s.status()} ${await s.text()}`).toBeTruthy();
      expect((await s.json()).staffSpectator, "on a switch-off event a staff member is admitted as a spectator").toBe(true);
      expect(withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(spect.id, W.id)),
        "…and no row was written").toBeFalsy();

      const expectRows = (list, where) => {
        const byId = Object.fromEntries(list.map(c => [c.id, c]));
        for (const c of [joined, placed, other, spect]) {
          expect(byId[c.id], `${where}: a staff member's list is the whole platform — ${c.name} is listed`).toBeTruthy();
        }
        const J = byId[joined.id], Pl = byId[placed.id], O = byId[other.id], S = byId[spect.id];
        // joined
        expect(J.own, `${where}: joined → own`).toBe(true);
        expect(J.competing, `${where}: joined → competing`).toBe(true);
        expect(!!J.staff_compete, `${where}: joined → staff_compete`).toBe(true);
        expect(J.can_leave, `${where}: joined via the link and not ended → can_leave`).toBe(true);
        // placed
        expect(Pl.own, `${where}: placed → own`).toBe(true);
        expect(Pl.competing, `${where}: placed → competing`).toBe(true);
        expect(!!Pl.staff_compete, `${where}: placed → staff_compete`).toBe(true);
        expect(Pl.can_leave, `${where}: placed by an admin → cannot leave`).toBe(false);
        // other
        expect(O.own, `${where}: other → not own`).toBe(false);
        expect(O.competing, `${where}: other → not competing`).toBe(false);
        expect(!!O.staff_compete, `${where}: other → switch off`).toBe(false);
        expect(O.can_leave, `${where}: other → cannot leave`).toBe(false);
        // spectator
        expect(S.own, `${where}: spectator → not own`).toBe(false);
        expect(S.competing, `${where}: spectator → not competing`).toBe(false);
        expect(S.can_leave, `${where}: spectator → cannot leave`).toBe(false);
      };

      const mine = await (await w.api.get("/api/my-competitions")).json();
      expect(Array.isArray(mine)).toBe(true);
      expectRows(mine, "/api/my-competitions");
      // `/api/me` is cached two seconds per user; the join busts it, but poll
      // rather than trust the timing.
      await expect.poll(async () => {
        const me = await (await w.api.get("/api/me")).json();
        const j2 = (me.competitions || []).find(c => c.id === joined.id);
        return !!(j2 && j2.own && j2.can_leave);
      }, { timeout: 5000 }).toBe(true);
      const me = await (await w.api.get("/api/me")).json();
      expect(me.isStaff, "the account really is staff-tagged").toBe(true);
      expectRows(me.competitions, "/api/me");

      // THE AFFORDANCE IS DRIVEN, not merely read. `can_leave:true` above is a
      // promise about a route a staff-tagged user reaches for the FIRST TIME
      // under this feature (staff never held a self_enroll row before), so the
      // leave is performed: 200, the row gone, the wire flipping to
      // own:false / competing:false / can_leave:false — then a RE-JOIN through
      // the same token (a fresh enrolment, not "already a member") restores
      // the fixture for the end-now assertions below.
      const leave = await w.api.post(`/api/competitions/${joined.id}/leave`, { headers: H(w.csrf) });
      expect(leave.status(), `a competing staff member leaves the event they joined by link: ${await leave.text()}`).toBe(200);
      expect((await leave.json()).ok, "left").toBe(true);
      expect(withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(joined.id, W.id)),
        "the row is gone").toBeFalsy();
      const gone = (await (await w.api.get("/api/my-competitions")).json()).find(c => c.id === joined.id);
      expect(gone, "the event is still LISTED for a staff member (the platform-wide list)").toBeTruthy();
      expect(gone.own, "…but no longer own").toBe(false);
      expect(gone.competing, "…no longer competing").toBe(false);
      expect(gone.can_leave, "…and nothing left to leave").toBe(false);
      // CONTROL on the affordance's other half: the admin-PLACED row reads
      // `can_leave:false`, and the route agrees — a staff competitor an
      // organiser placed cannot walk out, exactly like a participant.
      const placedLeave = await w.api.post(`/api/competitions/${placed.id}/leave`, { headers: H(w.csrf) });
      expect(placedLeave.status(), "an admin-placed row cannot be left by its holder").toBe(403);
      expect((await placedLeave.json()).code).toBe("not_self_enrolled");
      expect(withDb(db => db.prepare("SELECT 1 AS ok FROM competition_users WHERE competition_id=? AND user_id=?").get(placed.id, W.id)),
        "the placed row survives the refusal").toBeTruthy();
      // Re-join: a fresh enrolment (the leave really removed the row).
      const rejoin = await w.api.post("/api/competitions/join", { headers: H(w.csrf), data: { token: await tokenFor(joined.id) } });
      expect(rejoin.ok(), `re-join after leaving: ${rejoin.status()} ${await rejoin.text()}`).toBeTruthy();
      const rb = await rejoin.json();
      expect(rb.alreadyMember, "the re-join is a NEW enrolment, so the leave really removed the row").toBe(false);
      expect(rb.staffSpectator, "…and on a compete event it is a real row again").toBeFalsy();
      const back = (await (await w.api.get("/api/my-competitions")).json()).find(c => c.id === joined.id);
      expect(back.own && back.competing && back.can_leave, "own / competing / can_leave are back after the re-join").toBe(true);

      // can_leave follows the STATUS: once the joined event ends, leaving is
      // withheld — the row is still own, still competing.
      await endNow(sa, saCsrf, joined.id);
      const after = (await (await w.api.get("/api/my-competitions")).json()).find(c => c.id === joined.id);
      expect(after.status, "the joined event has ended").toBe("ended");
      expect(after.own, "still own").toBe(true);
      expect(after.competing, "still competing").toBe(true);
      expect(after.can_leave, "but a finished event cannot be left").toBe(false);
      // …and the route agrees with the wire once more (the v7.14.2 rule, both
      // directions): a self-enrolled row on an ENDED event is refused `ended`.
      const endedLeave = await w.api.post(`/api/competitions/${joined.id}/leave`, { headers: H(w.csrf) });
      expect(endedLeave.status(), "leaving a finished event is refused").toBe(409);
      expect((await endedLeave.json()).code).toBe("ended");
    } finally { await w.api.dispose(); }
  });

  test("CONTROL: an ordinary participant's rows are all own, and `competing` merely mirrors the switch", async () => {
    const on = await makeCompetition(sa, saCsrf, "wirectl-on", { staff_compete: true });
    const off = await makeCompetition(sa, saCsrf, "wirectl-off", { staff_compete: false });
    const P = await makeP("wirectl-P");
    await enrol(sa, saCsrf, on.id, [P.id]);
    await enrol(sa, saCsrf, off.id, [P.id]);
    const p = await signIn(P.email);
    try {
      const mine = await (await p.api.get("/api/my-competitions")).json();
      expect(mine.map(c => c.id).sort(), "a participant's list is exactly their own rows").toEqual([on.id, off.id].sort());
      const On = mine.find(c => c.id === on.id), Off = mine.find(c => c.id === off.id);
      expect(On.own).toBe(true); expect(Off.own).toBe(true);
      // `competing` is `own && staff_compete` — the EVENT's property on a row the
      // holder has, with NO staff/role term (CHANGES-AFTER-REVIEW §12: DESIGN.md's
      // extra `(isStaff || event_admin)` conjunct is NOT what shipped, and the
      // client consults the flag only for staff-tagged users through
      // `staffSpectatorIn`). So for an ordinary participant it merely mirrors
      // the switch; do not "fix" either side to make it mean "is a staff
      // competitor" without moving the client with it.
      expect(On.competing).toBe(true); expect(Off.competing).toBe(false);
      expect(!!On.staff_compete).toBe(true); expect(!!Off.staff_compete).toBe(false);
      expect(On.can_leave, "admin-assigned → cannot leave").toBe(false);
    } finally { await p.api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. THE SOLE-EVENT LANDING
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the sole-event landing reads a staff member's OWN rows", () => {

  const landingOf = async (email) => {
    const s = await signIn(email);
    try {
      const me = await (await s.api.get("/api/me")).json();
      return { login: s.body.autoResumeCompetitionId || null, me: me.competitionId || null };
    } finally { await s.api.dispose(); }
  };

  test("a staff member enrolled in exactly ONE event lands in it at sign-in", async () => {
    const comp = await makeCompetition(sa, saCsrf, "land-one", { staff_compete: true });
    const W = await makeStaff(sa, saCsrf, "land-W1");
    await enrol(sa, saCsrf, comp.id, [W.id]);
    const got = await landingOf(W.email);
    expect(got.login, "the login payload reports the landing").toBe(comp.id);
    expect(got.me, "and the session points at it — boot() routes off exactly this").toBe(comp.id);
  });

  test("…of ANY status: one own event that has already ENDED still lands", async () => {
    const comp = await makeCompetition(sa, saCsrf, "land-ended", { staff_compete: true });
    const W = await makeStaff(sa, saCsrf, "land-W4");
    await enrol(sa, saCsrf, comp.id, [W.id]);
    await endNow(sa, saCsrf, comp.id);
    expect((await adminRow(sa, comp.id)).status, "the fixture really has ended").toBe("ended");
    const got = await landingOf(W.email);
    expect(got.me, "an ended sole event is landed in, as it is for a participant").toBe(comp.id);
  });

  test("…and a row is a row: a staff member whose ONE row is a pre-release row on a switch-off event lands there too", async () => {
    const comp = await makeCompetition(sa, saCsrf, "land-planted", { staff_compete: false });
    const W = await makeStaff(sa, saCsrf, "land-W5");
    plantRow(comp.id, W.id);
    const got = await landingOf(W.email);
    expect(got.me, "OWN means holds a row, switch or no switch").toBe(comp.id);
  });

  test("CONTROL: two own events land on none, and NO own events land on none even though the platform is full of events", async () => {
    const a = await makeCompetition(sa, saCsrf, "land-two-a", { staff_compete: true });
    const b = await makeCompetition(sa, saCsrf, "land-two-b", { staff_compete: true });
    const W2 = await makeStaff(sa, saCsrf, "land-W2");
    await enrol(sa, saCsrf, a.id, [W2.id]);
    await enrol(sa, saCsrf, b.id, [W2.id]);
    const two = await landingOf(W2.email);
    expect(two.login, "two own events: the login reports no landing").toBeNull();
    expect(two.me, "…and the session points nowhere — there is a choice to make").toBeNull();

    // A staff member's LIST is the whole platform (many events by now). The
    // landing must not read that list: with no OWN row there is nothing to
    // land in, however many events they may enter as a spectator.
    const W3 = await makeStaff(sa, saCsrf, "land-W3");
    const s = await signIn(W3.email);
    try {
      const me = await (await s.api.get("/api/me")).json();
      expect(me.competitions.length, "the staff list really is platform-wide").toBeGreaterThan(1);
      expect(me.competitions.every(c => c.own === false), "…and none of it is theirs").toBe(true);
      expect(s.body.autoResumeCompetitionId || null, "no own row: no landing").toBeNull();
      expect(me.competitionId || null, "…and no session pointer").toBeNull();
    } finally { await s.api.dispose(); }
  });
});

// ── THE OTHER HALF OF DECISION 7: "auto-resume as participants" ──────────────
// The landing above is the no-marker case. Three more sign-in paths exist for a
// staff member who now HOLDS a row, and each reads a different line of
// `applyAutoResumeToSession` / `_soleCompetitionLanding`:
//   (i)   the MARKER beats "two events → none": having chosen one of two own
//         events, the next sign-in resumes it;
//   (ii)  a deliberate DEPARTURE (`POST /api/deselect-competition`, which stamps
//         `left_event_at`) suppresses the sole-event landing at the next
//         sign-in — and choosing again SPENDS it;
//   (iii) a staff member with NO row who opened a switch-off event as a
//         spectator is resumed into it — the `isStaff` arm of the marker rule,
//         which is what keeps a spectator's marker readable at all.
test.describe("v8.12.0 — a staff member is auto-resumed exactly as a participant is", () => {

  const relogin = async (email) => {
    const s = await signIn(email);
    try {
      const me = await (await s.api.get("/api/me")).json();
      return { login: s.body.autoResumeCompetitionId || null, me: me.competitionId || null };
    } finally { await s.api.dispose(); }
  };

  test("(i) with TWO own compete events, the one they entered is resumed at the next sign-in — the marker beats the two-events rule", async () => {
    const a = await makeCompetition(sa, saCsrf, "resume-a", { staff_compete: true });
    const b = await makeCompetition(sa, saCsrf, "resume-b", { staff_compete: true });
    const W = await makeStaff(sa, saCsrf, "resume-W1");
    await enrol(sa, saCsrf, a.id, [W.id]);
    await enrol(sa, saCsrf, b.id, [W.id]);
    const first = await signIn(W.email);
    try {
      expect(first.body.autoResumeCompetitionId || null, "PRECONDITION: two own events, nothing landed").toBeNull();
      await enter(first, a.id, "W enters one of their two events");
      expect(withDb(db => db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(W.id)).active_competition_id,
        "entering pinned the marker").toBe(a.id);
    } finally { await first.api.dispose(); }
    const again = await relogin(W.email);
    expect(again.login, "the next sign-in resumes the MARKED event, two own events notwithstanding").toBe(a.id);
    expect(again.me, "…and the session points at it").toBe(a.id);
  });

  test("(ii) pressing Events is remembered across a sign-out: a sole own event is NOT landed in afterwards — until they choose again", async () => {
    const comp = await makeCompetition(sa, saCsrf, "resume-leave", { staff_compete: true });
    const W = await makeStaff(sa, saCsrf, "resume-W2");
    await enrol(sa, saCsrf, comp.id, [W.id]);
    const first = await signIn(W.email);
    try {
      expect(first.body.autoResumeCompetitionId, "PRECONDITION: the sole own event is landed in").toBe(comp.id);
      const d = await first.api.post("/api/deselect-competition", { headers: H(first.csrf) });
      expect(d.ok(), `deselect: ${d.status()} ${await d.text()}`).toBeTruthy();
      const u = withDb(db => db.prepare("SELECT active_competition_id, left_event_at FROM users WHERE id=?").get(W.id));
      expect(u.left_event_at, "the departure is stamped").toBeTruthy();
      expect(u.active_competition_id, "…and the marker cleared").toBeNull();
    } finally { await first.api.dispose(); }
    const after = await relogin(W.email);
    expect(after.login, "one own event, but they LEFT it: no landing").toBeNull();
    expect(after.me, "…and no session pointer").toBeNull();
    // CONTROL, the other direction: choosing again SPENDS the departure, and the
    // sign-in after that lands them once more — or "no landing" is satisfied by
    // a build that never lands a staff member at all.
    const back = await signIn(W.email);
    try {
      await enter(back, comp.id, "W chooses the event again");
      expect(withDb(db => db.prepare("SELECT left_event_at FROM users WHERE id=?").get(W.id)).left_event_at, "the departure is spent").toBeNull();
    } finally { await back.api.dispose(); }
    const resumed = await relogin(W.email);
    expect(resumed.login, "…and the next sign-in lands in it again").toBe(comp.id);
  });

  test("(iii) a staff member with NO row who opened a switch-off event as a spectator is resumed into it — the isStaff arm of the marker rule", async () => {
    const off = await makeCompetition(sa, saCsrf, "resume-spect", { staff_compete: false });
    const W = await makeStaff(sa, saCsrf, "resume-W3");
    const first = await signIn(W.email);
    try {
      expect(first.body.autoResumeCompetitionId || null, "PRECONDITION: no own rows, nothing landed").toBeNull();
      await enter(first, off.id, "the spectator opens a switch-off event");
      expect(rowOf(off.id, W.id), "no row was written by the select").toBeFalsy();
      expect(withDb(db => db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(W.id)).active_competition_id,
        "the marker is written for a spectator too").toBe(off.id);
    } finally { await first.api.dispose(); }
    const again = await relogin(W.email);
    expect(again.login, "resumed into the event they opened, with no row to their name").toBe(off.id);
    expect(again.me, "…and the session points at it").toBe(off.id);
    expect(rowOf(off.id, W.id), "still no row: the resume manufactured no membership").toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. TOGGLE-ADMIN-VIEW
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — switching to participant view lands an admin with exactly one own event in it", () => {

  const toggle = toggleView;

  test("an admin enrolled in ONE compete event AFTER signing in is landed in it by the toggle, and /api/me agrees", async () => {
    const comp = await makeCompetition(sa, saCsrf, "toggle-one", { staff_compete: true });
    // LOGIN FIRST, ENROL SECOND: the login runs the same landing rule, so an
    // admin enrolled before signing in arrives already pointed at the event and
    // the toggle would merely carry the pointer — asserting nothing about the
    // toggle's own landing.
    const adm = await makeAdmin(sa, saCsrf, "toggle-A1");
    try {
      const me0 = await (await adm.api.get("/api/me")).json();
      expect(me0.isAdminView, "signed in as an admin, in admin view").toBe(true);
      expect(me0.competitionId || null, "PRECONDITION: nothing to land in at sign-in").toBeNull();
      await enrol(sa, saCsrf, comp.id, [adm.id]);

      const d = await toggle(adm, "participant");
      expect(d.isAdmin, "now in participant view").toBe(false);
      expect(d.competitionId, "the toggle's own landing: exactly one own event, so land in it").toBe(comp.id);
      // The toggle busts the me-cache (v8.7.3); poll anyway rather than trust it.
      await expect.poll(async () => (await (await adm.api.get("/api/me")).json()).competitionId || null, { timeout: 5000 }).toBe(comp.id);
      const me1 = await (await adm.api.get("/api/me")).json();
      expect(me1.isAdminView).toBe(false);
      expect(me1.competitionId).toBe(comp.id);

      // Back to admin view: the pointer is CARRIED, not re-decided.
      const back = await toggle(adm, "admin");
      expect(back.isAdmin, "back in admin view").toBe(true);
      expect(back.competitionId, "the session pointer survives the switch back").toBe(comp.id);
    } finally { await adm.api.dispose(); }
  });

  test("CONTROL: an admin enrolled in TWO events lands on none — the toggle reports null and /api/me agrees", async () => {
    const a = await makeCompetition(sa, saCsrf, "toggle-two-a", { staff_compete: true });
    const b = await makeCompetition(sa, saCsrf, "toggle-two-b", { staff_compete: true });
    const adm = await makeAdmin(sa, saCsrf, "toggle-A2");
    try {
      await enrol(sa, saCsrf, a.id, [adm.id]);
      await enrol(sa, saCsrf, b.id, [adm.id]);
      const d = await toggle(adm, "participant");
      expect(d.isAdmin).toBe(false);
      expect(d.competitionId, "two own events: no landing").toBeNull();
      const me = await (await adm.api.get("/api/me")).json();
      expect(me.competitionId || null, "…and no session pointer").toBeNull();
      expect(me.competitions.map(c => c.id).sort(), "both events are theirs to choose from").toEqual(
        expect.arrayContaining([a.id, b.id]));
      // And back, with nothing to carry.
      const back = await toggle(adm, "admin");
      expect(back.competitionId, "nothing to carry").toBeNull();
    } finally { await adm.api.dispose(); }
  });

  test("CONTROL: an admin ALREADY pointed at an event keeps that pointer across the toggle — the landing never overwrites a choice", async () => {
    const chosen = await makeCompetition(sa, saCsrf, "toggle-keep-a", { staff_compete: true });
    const other = await makeCompetition(sa, saCsrf, "toggle-keep-b", { staff_compete: true });
    const adm = await makeAdmin(sa, saCsrf, "toggle-A3");
    try {
      await enrol(sa, saCsrf, chosen.id, [adm.id]);
      await enrol(sa, saCsrf, other.id, [adm.id]);
      // Two events, so the landing rule has nothing to say; the admin CHOOSES.
      await enter(adm, chosen.id, "the admin selects one of their two events");
      const d = await toggle(adm, "participant");
      expect(d.competitionId, "the toggle carries the chosen pointer rather than re-deciding").toBe(chosen.id);
      const me = await (await adm.api.get("/api/me")).json();
      expect(me.competitionId).toBe(chosen.id);
    } finally { await adm.api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. THE GROUP BOARD
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the GROUP board averages a competing staff member into their team", () => {

  /**
   * A compete (or not) event with the team board on and TWO bound groups:
   *   G1 = { W (staff-tagged), P1 }      G2 = { P2 }
   * W holds a DIRECT row before the bind — enrolled by the assign door with the
   * switch on, PLANTED with it off (direct_assigned=1 either way, so a solo row
   * is theirs iff the board admits them at all). P1 and P2 arrive through the
   * bind's own reconcile as GROUP-ORIGIN rows (direct_assigned=0), which is what
   * makes P1 the control for the solo predicate: a member of a bound group with
   * no direct row must never have a solo row. W solves; P1 and P2 enter and
   * never solve — they are the bystanders that keep the event live, and they
   * must ENTER, because a member with no login_time and no submission is not
   * in the entry set and their group would read as empty.
   */
  async function groupWorld(staffCompete, label) {
    const comp = await makeCompetition(sa, saCsrf, `${label}-${staffCompete ? "on" : "off"}`, { staff_compete: staffCompete, group_leaderboard_enabled: true });
    const task = await sealedTask(author, `${label}-task`);
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const W = await makeStaff(sa, saCsrf, `${label}-W`);
    const P1 = await makeP(`${label}-P1`);
    const P2 = await makeP(`${label}-P2`);
    if (staffCompete) await enrol(sa, saCsrf, comp.id, [W.id]);
    else plantRow(comp.id, W.id);
    const G1 = await createGroup(`${label}-g1`, [W.id, P1.id]);
    const G2 = await createGroup(`${label}-g2`, [P2.id]);
    await bindGroups(comp.id, [G1.id, G2.id]);
    // The bind's reconcile wrote the two group-origin rows and left W's direct
    // row alone (a direct member is sticky). Asserted, or every board read
    // below is about a roster the fixture only believed it built.
    expect(rowOf(comp.id, P1.id)?.direct_assigned, "P1 holds a GROUP-ORIGIN row").toBe(0);
    expect(rowOf(comp.id, P2.id)?.direct_assigned, "P2 holds a GROUP-ORIGIN row").toBe(0);
    expect(rowOf(comp.id, W.id)?.direct_assigned, "W keeps the DIRECT row").toBe(1);
    const ctx = {};
    for (const [k, u] of [["W", W], ["P1", P1], ["P2", P2]]) {
      ctx[k] = await signIn(u.email);
      expect(ctx[k].body.autoResumeCompetitionId, `${k}'s login lands in their one own event`).toBe(comp.id);
      await enter(ctx[k], comp.id, `${k} enters the ${staffCompete ? "compete" : "switch-off"} event`);
    }
    await solve(ctx.W, task, "W solves");
    expect((await adminRow(sa, comp.id)).ended_at, "the two non-solvers keep the event live").toBeNull();
    return { comp, task, W, P1, P2, G1, G2, ctx, dispose: async () => { for (const c of Object.values(ctx)) await c.api.dispose(); } };
  }

  const groupRowOf = (board, groupId) => board.find(r => r.type === "group" && r.groupId === groupId);
  const soloRowOf = (board, userId) => board.find(r => r.type === "individual" && r.userId === userId);

  test("on a compete event the staff member's score is in their team's average and they hold a SOLO row; on the twin with a planted row, neither — and the frozen snapshot agrees", async () => {
    const on = await groupWorld(true, "grp");
    const off = await groupWorld(false, "grpctl");
    try {
      // ── COMPETE EVENT ──────────────────────────────────────────────────────
      const lb = await (await on.ctx.P1.api.get("/api/leaderboard")).json();
      const wScore = lb.board.find(e => e.userId === on.W.id)?.score;
      expect(wScore, "PRECONDITION: W scored on the individual board").toBeGreaterThan(0);
      expect(lb.groupBoard, "the team board renders (two non-empty groups)").toBeTruthy();
      const g1 = groupRowOf(lb.groupBoard.board, on.G1.id), g2 = groupRowOf(lb.groupBoard.board, on.G2.id);
      expect(g1, "G1 is on the participant team board").toBeTruthy();
      expect(g2, "G2 is on the participant team board").toBeTruthy();
      expect(g1.score, "G1's average is (W's score + P1's 0) / 2 — the staff competitor is IN the team").toBeCloseTo(wScore / 2, 6);
      expect(g2.score, "G2's average is P2's 0 (control for the arithmetic)").toBe(0);
      expect(lb.groupBoard.me?.groupId, "P1 resolves their own team").toBe(on.G1.id);
      const wSolo = soloRowOf(lb.groupBoard.board, on.W.id);
      expect(wSolo, "W (a DIRECT member) holds a solo row too").toBeTruthy();
      expect(wSolo.score, "…carrying their own score").toBe(wScore);
      expect(soloRowOf(lb.groupBoard.board, on.P1.id), "P1 (group-origin only) has NO solo row — the solo predicate is direct_assigned").toBeFalsy();
      // memberCount is stripped from the participant wire (fairness); the ADMIN
      // board keeps it, and it is where the membership is asserted as a number.
      const adminOn = await (await sa.get(`/api/admin/leaderboard?competitionId=${on.comp.id}&groups=1`)).json();
      expect(Array.isArray(adminOn), "the admin team board is an array").toBe(true);
      const ag1 = groupRowOf(adminOn, on.G1.id);
      expect(ag1.memberCount, "G1 counts TWO eligible members: the staff competitor and P1").toBe(2);
      expect(ag1.score).toBeCloseTo(wScore / 2, 6);
      expect(soloRowOf(adminOn, on.W.id), "…and the admin board carries W's solo row").toBeTruthy();

      // ── SWITCH-OFF TWIN ────────────────────────────────────────────────────
      // Same groups, same rows, same solve; only the column differs. W is
      // excluded from the entry set, so the team is P1 alone and W is solo
      // nowhere — a build that dropped `!u._staff` from the group filter puts
      // W's score into G1's average and W's name on the board.
      const lbOff = await (await off.ctx.P1.api.get("/api/leaderboard")).json();
      expect(lbOff.groupBoard, "CONTROL: the twin's team board renders too").toBeTruthy();
      const g1Off = groupRowOf(lbOff.groupBoard.board, off.G1.id);
      expect(g1Off, "G1 is on the twin's team board (P1 keeps it non-empty)").toBeTruthy();
      expect(g1Off.score, "G1's average is P1's 0: the staff row is NOT in the team on a switch-off event").toBe(0);
      expect(soloRowOf(lbOff.groupBoard.board, off.W.id), "no solo row for the staff row on the twin").toBeFalsy();
      expect(JSON.stringify(lbOff), "the staff nickname appears nowhere on the twin's payload, team board included").not.toContain(off.W.nickname);
      const adminOff = await (await sa.get(`/api/admin/leaderboard?competitionId=${off.comp.id}&groups=1`)).json();
      expect(groupRowOf(adminOff, off.G1.id).memberCount, "G1 counts ONE eligible member on the twin").toBe(1);
      expect(soloRowOf(adminOff, off.W.id), "no solo row on the twin's admin board either").toBeFalsy();

      // ── THE FREEZE ─────────────────────────────────────────────────────────
      // End-now freezes the official result into `group_leaderboard_snapshots`,
      // and what is frozen is what the filter above admitted: W's contribution
      // is in the compete event's snapshot, absent from the twin's.
      await endNow(sa, saCsrf, on.comp.id);
      await endNow(sa, saCsrf, off.comp.id);
      const snapOf = (compId) => {
        const row = withDb(db => db.prepare("SELECT board FROM group_leaderboard_snapshots WHERE competition_id=? AND slot_key='__global__'").get(compId));
        expect(row, `a snapshot row was frozen for ${compId}`).toBeTruthy();
        return JSON.parse(row.board);
      };
      const snapOn = snapOf(on.comp.id);
      expect(Array.isArray(snapOn), "the compete event froze a real board").toBe(true);
      expect(groupRowOf(snapOn, on.G1.id).score, "the FROZEN G1 average carries the staff competitor's score").toBeCloseTo(wScore / 2, 6);
      expect(soloRowOf(snapOn, on.W.id), "…and the frozen board carries W's solo row").toBeTruthy();
      const snapOff = snapOf(off.comp.id);
      expect(groupRowOf(snapOff, off.G1.id).score, "the twin's frozen G1 average is P1's 0").toBe(0);
      expect(soloRowOf(snapOff, off.W.id), "…with no solo row for the staff row").toBeFalsy();
      // And the served board after the end IS the snapshot.
      const servedOn = await (await sa.get(`/api/admin/leaderboard?competitionId=${on.comp.id}&groups=1`)).json();
      expect(groupRowOf(servedOn, on.G1.id).score).toBeCloseTo(wScore / 2, 6);
    } finally { await on.dispose(); await off.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. THE LATE-ENTRANT BOARD
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.12.0 — the LATE-ENTRANT board lists a staff member who joined a compete Booth Event in its window", () => {

  /**
   * A Booth Event (the one kind that runs a late window), ended by End Now
   * with an ordinary participant already scored. Its join link stays live for
   * 48 h after the end: a staff member scanning it INSIDE the window is written
   * a row on a compete booth (`staffRowRefusal` → null) and admitted as a
   * spectator on a switch-off one. The challenge is a sealed TEXT one — a booth
   * refuses file answers and `needs:` tags, and a compete event admits sealed
   * challenges only.
   */
  async function boothWorld(staffCompete, label) {
    const comp = await makeCompetition(sa, saCsrf, `${label}-${staffCompete ? "on" : "off"}`, {
      event_kind: "booth", staff_compete: staffCompete, self_enroll_enabled: true,
    });
    const row = await adminRow(sa, comp.id);
    expect(row.late_entry_enabled, "late entries default ON for a Booth Event").toBeTruthy();
    expect(!!row.staff_compete, "the switch is as requested").toBe(staffCompete);
    const task = await sealedTask(author, `${label}-task`);
    await assignTask(author.api, author.csrf, task.id, [comp.id]);
    const P = await makeP(`${label}-P`);
    await enrol(sa, saCsrf, comp.id, [P.id]);
    const p = await signIn(P.email);
    await enter(p, comp.id, "P enters while live");
    await solve(p, task, "P solves before the end");
    const W = await makeStaff(sa, saCsrf, `${label}-W`);
    await endNow(sa, saCsrf, comp.id);
    const ended = await adminRow(sa, comp.id);
    expect(ended.status, "the booth has ended").toBe("ended");
    expect(ended.ended_at, "…by End Now").toBeTruthy();
    const token = await joinTokenFor(comp.id);
    return { comp, task, P, W, p, token, endedAt: ended.ended_at };
  }

  test("a staff member joining a compete booth in its late window is on the LATE board and takes a participation certificate; on the switch-off twin the same join is a spectator join", async () => {
    const on = await boothWorld(true, "late");
    const off = await boothWorld(false, "latectl");
    const w = await signIn(on.W.email), wOff = await signIn(off.W.email);
    try {
      // ── COMPETE BOOTH ──────────────────────────────────────────────────────
      const join = await w.api.post("/api/competitions/join", { headers: H(w.csrf), data: { token: on.token } });
      expect(join.ok(), `a staff member joins the ended compete booth inside its window: ${join.status()} ${await join.text()}`).toBeTruthy();
      const jb = await join.json();
      expect(jb.alreadyMember, "a fresh enrolment").toBe(false);
      expect(jb.staffSpectator, "…and a REAL row, not a spectator answer").toBeFalsy();
      const wRow = rowOf(on.comp.id, on.W.id);
      expect(wRow, "the row was written").toBeTruthy();
      expect(new Date(wRow.assigned_at).getTime(), "…AFTER the end, which is what makes them a late entrant").toBeGreaterThan(new Date(on.endedAt).getTime());
      await enter(w, on.comp.id, "the late staff entrant enters the ended booth");
      await solve(w, on.task, "…and solves inside the window");
      const lb = await (await w.api.get("/api/leaderboard")).json();
      expect(lb.ended, "the booth reads as ended").toBe(true);
      expect(lb.lateEntrantMe, "the wire says they are a late entrant").toBe(true);
      expect(lb.lateWindowOpen, "…inside an open window").toBe(true);
      expect(lb.lateBoard, "a late board exists").toBeTruthy();
      expect(lb.lateBoard.me?.userId, "the staff competitor resolves their own row on the LATE board").toBe(on.W.id);
      expect(lb.lateBoard.board.map(e => e.userId), "…and is listed on it").toContain(on.W.id);
      expect(lb.board.map(e => e.userId), "the MAIN board does not list them (it is final at the end)").not.toContain(on.W.id);
      expect(lb.board.map(e => e.userId), "…while the early scorer is on it (control)").toContain(on.P.id);
      expect(lb.me, "no row of their own on the main board").toBeNull();
      expect(lb.canShareBadge, "the CTA is offered: a late entrant may take a participation certificate while the window is open").toBe(true);
      const certs = await (await w.api.get("/api/me/certificates")).json();
      const offer = certs.claimable.find(c => c.competitionId === on.comp.id);
      expect(offer, "the certificates surface offers it too").toBeTruthy();
      expect(offer.lateEntrant, "…as a late entrant").toBe(true);
      const mint = await w.api.post(`/api/competitions/${on.comp.id}/badge`, { headers: H(w.csrf) });
      expect(mint.status(), `the late staff entrant mints: ${await mint.text()}`).toBe(200);
      const badge = await mint.json();
      expect(badge.basis, "a PARTICIPATION certificate while their board is still moving").toBe("participation");
      expect(badge.lateEntrant, "…frozen as earned late").toBe(true);
      const adminOn = await (await sa.get(`/api/admin/leaderboard?competitionId=${on.comp.id}`)).json();
      const aw = adminOn.find(e => e.userId === on.W.id);
      expect(aw, "the admin board carries the late staff entrant").toBeTruthy();
      expect(aw.isLateEntrant, "…in its late section").toBe(true);

      // ── SWITCH-OFF TWIN ────────────────────────────────────────────────────
      const joinOff = await wOff.api.post("/api/competitions/join", { headers: H(wOff.csrf), data: { token: off.token } });
      expect(joinOff.ok(), `the join answers 200 on the twin too: ${joinOff.status()} ${await joinOff.text()}`).toBeTruthy();
      expect((await joinOff.json()).staffSpectator, "…as a SPECTATOR join").toBe(true);
      expect(rowOf(off.comp.id, off.W.id), "no row was written by the spectator join").toBeFalsy();
      // Now the SHARP half: a planted row stamped AFTER the end, so the twin's
      // W is a late-entrant row-holder in every respect but the switch. The
      // late gate admits them (they solve — asserted), so only the board's
      // staff filter keeps them off the late section.
      plantRow(off.comp.id, off.W.id);
      expect(new Date(rowOf(off.comp.id, off.W.id).assigned_at).getTime(), "PRECONDITION: the planted row is a LATE one").toBeGreaterThan(new Date(off.endedAt).getTime());
      await enter(wOff, off.comp.id, "the row-holding spectator enters the ended twin");
      await solve(wOff, off.task, "…and the late gate lets them solve (the row is late)");
      const lbOff = await (await wOff.api.get("/api/leaderboard")).json();
      expect(lbOff.ended).toBe(true);
      expect(lbOff.lateBoard, "no late entrant is RANKED on the twin, so there is no late section at all").toBeNull();
      expect(lbOff.board.map(e => e.userId), "the twin's main board keeps the early scorer (control)").toContain(off.P.id);
      expect(JSON.stringify(lbOff), "the staff nickname appears nowhere on the twin's payload").not.toContain(off.W.nickname);
      expect(lbOff.canShareBadge, "the CTA is withheld").toBe(false);
      const mintOff = await wOff.api.post(`/api/competitions/${off.comp.id}/badge`, { headers: H(wOff.csrf) });
      expect(mintOff.status(), "the mint is refused on the twin").toBe(403);
      expect((await mintOff.json()).error).toMatch(/did not participate/i);
      const adminOff = await (await sa.get(`/api/admin/leaderboard?competitionId=${off.comp.id}`)).json();
      expect(adminOff.map(e => e.userId), "the staff row is absent from the twin's admin board entirely").not.toContain(off.W.id);
    } finally { await w.api.dispose(); await wOff.api.dispose(); await on.p.api.dispose(); await off.p.api.dispose(); }
  });
});
