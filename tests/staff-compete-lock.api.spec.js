// @ts-check
//
// v8.12.0 — THE COMPETITOR EDIT LOCK, on the wire.
//
// The promise this file pins: an actor who holds a `competition_users` row on an
// event whose "Staff can compete" switch is ON is a COMPETITOR there, and a
// competitor may not change that event or any challenge it holds — whatever
// their tier. A global admin, a user-backed superadmin and an event admin are
// each refused with ONE shape, `403 {code:'competitor_cannot_edit',
// competitionId, competitionName}`, at every mutating door: the event itself,
// its sessions, its tags, its CxOne override, its join link, its organisers, its
// roster (assign / desk-invite / invite / attempt-grant / remove SOMEBODY ELSE),
// every write to a challenge it holds, every write to a GROUP bound to it (the
// transitive door — membership live-syncs into the event), and the feedback
// purge. The single carve-out is self-removal, which is the escape hatch: after
// it the same actor may edit the event AND its challenges again — while the
// event has not ended; on a finished event the ended-membership rule refuses
// that exit, the lock outlives the event, and the refusal's remedy says so.
//
// ── HOW THIS FILE IS BUILT, AND WHY ──────────────────────────────────────────
//
// EVERY REFUSAL HAS A CONTROL OF THE SAME TIER. "A competing admin is refused" is
// equally satisfied by a build that refuses every admin everywhere, so for each
// enrolled actor (A, SA, EA) there is an UNENROLLED twin (A2, SA2, EA2) driven
// through the same doors, and the twin must either succeed or be refused for a
// DIFFERENT, named reason (the answer seal, the event-admin scope, the ended
// event). The code is what discriminates, never the status alone. On the task
// side the author of the sealed fixture (S2) and the superadmin twin (SA2) drive
// every door to a real success on a throwaway challenge, so a door-local mistake
// (a route asking the lock about the wrong id and refusing everybody) is caught.
//
// THE LOCK IS ABOUT THE ROW **ON A SWITCH-ON EVENT**, AND BOTH HALVES ARE PINNED.
// Every competitor here ALSO holds a row on the switch-OFF twin event F — the
// tagged tiers were enrolled BEFORE their promotion (the sequence that produces
// a staff row on a switch-off event; the assign route refuses to write one
// afterwards, and that refusal is asserted with a fresh admin), the event admin
// is untagged and admitted anywhere. So F is a control in the only sense that
// matters: the SAME actor, holding a row on BOTH events, is refused on E and
// succeeds on F, on the event, on the challenge each holds (T on E, U on F) and
// in the projection. Without those rows the file could not tell "a row on a
// switch-on event" from "a row on any event" — a mutation dropping the
// `staff_compete = 1` term from the task-side predicate or the projection's
// competing set passed the previous draft of this file entirely.
//
// THE PROJECTION IS PINNED WHERE THE SEAL CANNOT BE THE REASON. On the sealed
// fixture T, `can_edit:false`, `can_see_answer:false` and the missing key are
// what the SEAL answers for every non-author too, so those assertions prove
// nothing about the lock; only `competing_in`, the withheld HINT and the global
// tiers' `can_unassign` discriminate there. The one shape in which the seal is
// out of the picture is an UNSEALED, authorless challenge held by a compete
// event — a state every door refuses — so it is PLANTED by direct SQL (the
// answer-seal spec's precedent), and on that row every collapsed flag and every
// withheld value is the lock's alone, beside an unenrolled twin who reads all
// of it on the same row.
//
// REFUSALS WRITE NOTHING, AND THE FILE SAYS SO. A 403 that has already written
// is byte-identical from the status alone (the v8.7.0 rule), so every refusal
// re-reads the thing it protects: the event's name, its tags, the roster, the
// challenge's title and its assignments, the group's members and bindings, the
// feedback row, the temp file an attachment upload would leave behind.
//
// BY VALUE, NEVER BY KEY, where a leak matters. The hint is NOT a sealed field —
// a participant pays 30% of the points to read it — so a competing admin reading
// it off the admin pane would be reading it for free. The projection arms
// serialise the whole payload and require the distinctive hint / key /
// explanation strings to appear nowhere in it, so a leak under a renamed key
// still fails; the unenrolled twin's payload must still CARRY the hint, or "the
// hint is gone" is satisfied by a build that dropped the column.
//
// THE MATRIX IS READ-ONLY OVER ONE SHARED WORLD; EVERY MUTATING FLOW OWNS ITS
// FIXTURE. A refusal changes nothing, so the 403 matrix can share the world the
// `beforeAll` builds. The escape hatch, the assignment doors, the superadmin-only
// doors, the status permutations, the group doors and the planted projection all
// WRITE, so each builds what it needs inside its own test (enrolling the SHARED
// actors into an OWN event is fine — a row on a fresh event changes no answer
// about E, F, T or U). A shared fixture those tests mutated would make the
// matrix depend on order, which is the class `npm run test:independence` exists
// to catch.
//
// STATUS AND KIND ARE PERMUTED, because a competitor is "a row on a switch-on
// event of ANY status". The shared world is a live tournament; one test drives
// an UPCOMING event (where the most doors are open — start time, kind, sessions,
// Start Now), an ENDED one (where the lock must answer ahead of the ended
// refusal, and self-removal is itself refused, so the lock outlives the event —
// the v8.12.0 stated disposition), a Booth Event and a Program.
//
// ── THE STATED ORDERINGS (v8.12.0, CHANGES §3) ───────────────────────────────
//
// The lock is asked FIRST on every competition door and every task door, and on
// the three assignment doors: `DELETE :id/competitions/:cid` above the
// locked-task gate and the assigner rule, `POST :id/competitions` above
// `taskViewDenied` and the locked gate (a pre-pass over every named event), and
// both directions of `PUT :id/competitions` likewise — its REMOVE direction
// is diffed in the pre-pass from the FULL current set (narrowed to the actor's
// scope, so an event admin is never refused over an event they cannot see), so
// a competing regular admin dropping a LOCKED challenge hears the lock rather
// than "locked" with no code (the first draft computed removals inside the
// transaction, below the locked gate). TWO orderings are deliberately
// different, and each is pinned so a change to it is a decision:
//   • the three roster doors that take a competition in the BODY (`assign`,
//     `invitations`, `attempt-grant`) answer the event-admin SCOPE before the
//     lock, so only an event admin competing in an event they do not organise
//     hears the scope reason there — while `desk-invite`, the FOURTH body-scoped
//     roster door, is lock-first (routes/participants.js) and is pinned as such;
//   • EVERY GROUP-SIDE DOOR (routes/groups.js: the two member routes, the group
//     delete, the two participant-chip routes) asks `groupWriteDenied` /
//     `groupDeleteDenied` (behind `participantDenied` on the chip pair) BEFORE
//     `competitorGroupDenied` — scope first, the opposite of the competition
//     doors. The unbind (`DELETE /competitions/:id/groups/:gid`) is a
//     competition door and stays lock-first. CLAUDE.md's "three doors" sentence
//     does not describe the group doors; the shipped ordering is pinned here and
//     the drift is reported, not resolved.
//
// THE REMEDY CLAUSE IS PINNED IN BOTH DIRECTIONS (round-3 fix (d)). Every refusal
// ends with a remedy from `_competitorRemedy`: on a LIVE event it offers
// self-removal ("…or remove yourself from the event first"), on an ENDED event
// it must NOT — the ended-membership rule refuses that exit, so promising it is
// an instruction that is not true. Both clauses say "another organiser", so a
// regex accepting either passes whatever the resolver does; `expectLocked`'s
// `remedy:"self"|"ended"` option is what discriminates, and the live-event doors
// are the CONTROL for the ended arm's negative.
//
// ── FIXTURE TRAPS MET HERE ───────────────────────────────────────────────────
//
//  • A SEALED challenge needs a USER-BACKED author. The built-in superadmin has
//    no `users` row, so `sealAtCreateDenied` refuses it; T is authored by S2, a
//    participant promoted to superadmin, who is deliberately NOT enrolled in E
//    (a compete event refuses the author of an assigned challenge).
//  • PROMOTE BEFORE LOGGING IN. A role change purges the target's sessions, so a
//    context signed in before the promotion is dead by the time it is used —
//    and so does the FIRST organiser grant (it moves the role). Every actor is
//    promoted / granted first and signed in once; a SECOND organiser grant on an
//    existing event admin moves no role and purges nothing.
//  • ENROL BEFORE PROMOTING to put a staff-tagged actor on a switch-OFF event.
//    The assign route skips a staff-tagged user on such an event (`skippedStaff`)
//    and answers 200, so the row has to be written while they are still a
//    participant; the promotion adds the tag and leaves the row alone.
//  • A REGULAR admin cannot enrol an admin or superadmin (`skippedPrivileged`);
//    the built-in superadmin can, so it seats every actor. The COUNT is asserted
//    — the assign endpoint skips silently and answers 200.
//  • `expectedAssignments` on the desired-state PUT is the set the actor was
//    SHOWN, and for an event admin that is narrowed to their scope. Every actor
//    here organises (or is global on) every event named, so the sets agree.
//  • `taskUnassignDenied` refuses an event admin taking OUT an assignment they
//    did not make, so the DELETE control unassigns an assignment the actor made
//    themselves a step earlier — the only shape that passes for all three tiers.
//  • The event-admin tier can only be driven at a challenge it can SEE
//    (`taskViewDenied`): every task the EA tier is driven at is held by an event
//    they organise, and where a test builds an own event the EA is granted on it.
//  • The multipart upload is written by multer BEFORE the handler runs, so a
//    refused upload must reclaim its temp file — asserted by counting the
//    uploads directory either side of the 403 (mutation-verified: deleting the
//    unlink in the lock branch leaves the count one higher).
//  • A group's DELETE is creator-only for an event admin, so every group an EA
//    is driven at is one they CREATED; the built-in superadmin binds it (it can
//    never be a competitor), and a seeded create is bound to nothing, so the
//    seed never reaches the lock.
//  • The feedback purge is superadmin-only, so SA is its only reachable
//    competitor; the rating is left by P, an ordinary participant of E.
//  • AN EVENT ADMIN'S COMPETITIONS LIST IS SCOPED, so `compRow(EA.api, X)` is
//    `undefined` for any event they do not organise — `competing` cannot be
//    read that way for a non-organising competitor. Read the row off the table
//    (`rowsFor`) and the switch off the built-in's view instead.
//  • A loop that RENAMES its own event (the escape hatch) must compare names
//    against the row read at the top of that iteration, never the fixture's
//    creation name.
//  • The session-door controls create REAL sessions on the shared switch-off
//    event F and delete every one afterwards (in a `finally`), so F is
//    single-slot again for the tests that follow; the session's end-now is
//    driven at a phantom id (its own 404), because ending a real slot would end
//    F under those tests.
//  • The `newGroups` invitation arm needs an EXISTING invitee (that is the path
//    that writes membership and live-syncs it) and reads G1's name LIVE — the
//    rename control moves it once per actor.
//
// ── PRODUCT DEFECTS FOUND WHILE WRITING THIS ─────────────────────────────────
//
//  Each was pinned as a `test.fixme` naming its intended behaviour and driven
//  RED against the first draft in a throwaway copy. Two were fixed in the same
//  release and their fixmes lifted (the arms hold); two await the operator.
//  LOCK-5 FIXED — an event admin competing in an event they do NOT organise had
//         no exit: self-removal was refused by `competitionDenied` AFTER the
//         carve-out. The carve-out bypasses the scope gate now, so the exit the
//         refusal names is open to the person it names it to.
//  LOCK-6 FIXED — an invitation's `newGroups` NAME resolving to a group OUTSIDE
//         the event admin's scope was applied (the pre-pass asked the
//         competitor question and never `groupWriteDenied`, a pre-existing
//         scope hole). It asks `groupWriteDenied` first now.
//  LOCK-3 OPEN (`test.fixme`) — a competing user-backed superadmin may
//         impersonate a rival of the same compete event and write as them (no
//         door asks `competitorIn`). An operator decision.
//  LOCK-4 OPEN (`test.fixme`) — block / benchmark-tag / delete of a rival by a
//         competitor reach the board change the roster door refuses — an
//         operator decision: extend the lock (this arm) or record the
//         acceptance and invert the arm.
//
// ── VERIFIED MUTATIONS (each kills the named arm, and only it) ───────────────
//
//  M1 `AND c.staff_compete = 1` dropped from `competitorEventsForTask`
//     (lib/staff-compete.js) → "challenge doors" (c), "switch-off twin" (U tags),
//     "version history" (U) — every row-holder on F is locked out of U.
//  M2 the same term dropped from the projection's `_competingSet` query
//     (routes/challenges.js) → "the projection" (U: competing_in, hint,
//     hint_withheld, can_unassign on F).
//  M3 the same term dropped from `competitorIn` → PRECONDITION (`competing` on
//     F), "switch-off twin" (PUT F), every roster/competition control on F8/F.
//  M4 `_unlinkAttachmentTempSync(req.file?.path)` deleted from the lock branch of
//     the attachment upload → "challenge doors" (temp file left behind).
//  M5 `!_competes` dropped from `canEdit` / `can_see_answer` and the
//     `_competingSet` term from `can_unassign` in the projection → the PLANTED
//     projection test (every collapsed flag), plus the global tiers'
//     `can_unassign` on the sealed fixture — the one flag the seal does not
//     also answer there. Every other flag on T survives M5: seal-satisfied.
//  M6 `competitorGroupDenied` removed from `POST /groups/:id/members` → the
//     group-doors test, at that door.
//  M7 the competitor check removed from `DELETE /tasks/:id/feedback` → the
//     feedback-doors test.
//  M8 the POST `:id/competitions` pre-pass moved back BELOW the locked-task gate
//     → the ordering test (A4 on a locked challenge hears "locked").
//  M9 the PUT `:id/competitions` ADD pre-pass moved back below the locked-task
//     gate → the ordering test (A4's PUT adding E4 hears "locked").
//  M10 `competitorGroupDenied` removed from `DELETE /participants/:id/groups/:gid`
//     → the group-doors test, at that door (and P8 really leaves G1).
//  M11 the invitation-groups loop removed from `POST /api/admin/invitations` →
//     the group-doors test (the invitation with `groupIds:[G1]` lands).
//  M12 `_competitorRemedy`'s `return ended` → `return false` (self-removal
//     always promised) → the ENDED arm of "status and kind", and only it.
//  M13 the same → `return true` (self-removal never promised) → the three LIVE
//     remedy controls: "competition doors" (PUT E), "the escape hatch" (PUT E3)
//     and "challenge doors" (PUT T) — and nothing else.
//  M14 the `newGroups` pre-pass deleted from `POST /api/admin/invitations`
//     (routes/invitations.js) → the group-doors test (the invitation naming G1
//     by name lands, 200).
//  M15 that ask moved INSIDE the create loop, after the INSERT → the group-doors
//     test, at "the earlier NAME was not created before the later name's
//     refusal" — the ordering half of round-3 fix (b), which M14 alone cannot
//     see.
//  M16 `POST /groups/:id/members` asking the lock ABOVE `groupWriteDenied` →
//     the group-doors test's ordering pin (EA hears the lock, not the scope).
//  M17 the PUT session door's predicate replaced by one refusing ANY row-holder
//     regardless of the switch (routes/sessions.js) → "switch-off twin" (A may
//     rename a session on F). Only a row-holder who REACHES the door sees it;
//     the phantom-id arms in "competition doors" cannot.
//  M18 desk-invite asking the SCOPE before the lock (routes/participants.js) →
//     the ordering test (EA4 desk-invite into E6 hears the scope).
//  M19 `competitorEventsForTask` dropping a fully-ended event → the ENDED arm
//     of "status and kind" (PUT Tend is no longer the lock).
//  M20 (round 3) routes/challenges.js: the PUT's remove-direction pre-pass
//     deleted (removals asked only inside the transaction, below the locked
//     gate again) → exactly the ordering arm, on "A4 (locked challenge) PUT
//     T4/competitions dropping E4" — the door the first draft pinned as
//     "locked, no code".
//  M21 (round 4, the RIVAL doors — the operator's ruling of 19 Sep 2026) the
//     `competitorRivalDenied` gate deleted from ONE account door, block
//     (routes/participants.js) → exactly LOCK-4 ("block R (a rival of E12):
//     expected the competitor lock (403), got 200").
//  M22 (round 4) the `competitorEditDenied` gate deleted from the badge revoke
//     (routes/badge.js) → exactly LOCK-4, at "SA12 revoke R's E12 certificate".
//  M24 the write gate dropped from the certificate email Resend
//     (routes/badge.js, `_adminCertificateGate(req, res)`) → exactly LOCK-4, at
//     "SA12 re-send R's E12 certificate email" (404 no_certificate, past the lock).
//  M23 (round 4) the impersonation guard's mid-session rival re-ask neutered
//     (lib/impersonation.js, `if (false && _rival)`) → exactly LOCK-3, at
//     "SA11-as-R1 submits after becoming R1's rival … got 200": entry still
//     refuses, so only the per-write re-ask pins that half.
//
//  NOT mutation-locked, by design — a STATED ordering the file pins so that
//  changing it is a decision: asking the lock before the scope on the three
//  body-scoped roster doors turns its own arm red and says so. (The PUT's
//  remove direction WAS such a stated ordering in the first draft; round 3
//  hoisted it, and the ordering arm now pins the lock there like its siblings.)
//  SURVIVING, declared rather than claimed: none of this file's arms depends
//  on the ORDER of `competition_groups` rows for a group bound to two compete
//  events — `expectLockedOneOf` accepts either, so a mutation that sorts that
//  query is invisible here by design.
const { test, expect, request } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, gradingHashFor } = require("./helpers");
const {
  H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin,
} = require("./event-admin-helpers");
const fs = require("fs");
const path = require("path");

const LOCK = "competitor_cannot_edit";
const SCOPE = "event_admin_out_of_scope";

// better-sqlite3 is opened INSIDE the callback, never at module scope: per-file
// isolation recreates the database in a `beforeAll`, so a handle taken at
// require time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

/**
 * Promote a fresh participant to `role` and sign in as them — promote FIRST.
 * `enrolFirst` seats them, while still a participant, on events whose switch is
 * OFF: the only sequence that puts a staff-tagged row on such an event.
 */
async function makeTier(sa, saCsrf, label, role, { enrolFirst = [] } = {}) {
  const p = await makeParticipant(sa, saCsrf, label);
  for (const cid of enrolFirst) await enrol(sa, saCsrf, cid, [p.id]);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  return { ...p, role, api, csrf, label };
}

/** A fresh participant made an ORGANISER of every event named, then signed in. */
async function makeEventAdmin(sa, saCsrf, label, compIds) {
  const p = await makeParticipant(sa, saCsrf, label);
  for (const cid of compIds) await grantEventAdmin(sa, saCsrf, cid, p.id);
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  const me = await (await api.get("/api/admin/me")).json();
  expect(me.isEventAdmin, `${label} really holds the event-admin tier`).toBe(true);
  return { ...p, role: "event_admin", api, csrf, label };
}

/** A compete Program — `makeCompetition` sends a duration, which a deadline kind refuses. */
async function makeProgram(sa, saCsrf, label, extra = {}) {
  const name = `EA ${uniq(label)}`;
  const r = await sa.post("/api/admin/competitions", {
    headers: H(saCsrf),
    data: {
      name, event_kind: "program", timezone: "UTC",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      deadline_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      ...extra,
    },
  });
  expect(r.ok(), `create program ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  return { id: d.competition?.id || d.id, name };
}

/**
 * THE ONE SHAPE every door answers with.
 *
 * `remedy` pins WHICH remedy clause `_competitorRemedy` chose — the two are
 * distinguishable only by the self-removal half, since BOTH say "another
 * organiser". `"self"` is the live-event clause (self-removal is offered);
 * `"ended"` is the honest clause on a finished event, which must NOT offer a
 * self-removal the ended-membership rule then refuses (round-3 fix (d),
 * FROZEN_REMEDY). Left unset, only "some remedy is stated" is checked — the
 * arms that pin the clause pass it explicitly, and the ended arm's negative
 * assertion is what stops a build that always promises self-removal.
 */
async function expectLocked(res, what, comp, { remedy = null } = {}) {
  expect(res.status(), `${what}: expected the competitor lock (403), got ${res.status()} ${await res.text().catch(() => "")}`).toBe(403);
  const b = await res.json();
  expect(b.code, `${what}: the machine code`).toBe(LOCK);
  expect(b.competitionId, `${what}: names the event by id`).toBe(comp.id);
  expect(b.competitionName, `${what}: names the event by name`).toBe(comp.name);
  const msg = String(b.error || "");
  expect(msg, `${what}: states the remedy`).toMatch(/remove yourself|another organiser/i);
  if (remedy === "self") {
    expect(msg, `${what}: on a LIVE event the remedy offers self-removal`).toMatch(/remove yourself from the event first/i);
  } else if (remedy === "ended") {
    expect(msg, `${what}: on an ENDED event the remedy still names another organiser`).toMatch(/another organiser/i);
    expect(msg, `${what}: …and must NOT promise a self-removal the ended rule refuses`).not.toMatch(/remove yourself/i);
  }
  return b;
}

/**
 * The lock, where the door may legitimately name EITHER of two events: a group
 * bound to two compete events is refused on whichever `competition_groups` row
 * the query returns first, and that order is not a contract.
 */
async function expectLockedOneOf(res, what, comps) {
  expect(res.status(), `${what}: expected the competitor lock (403), got ${res.status()} ${await res.text().catch(() => "")}`).toBe(403);
  const b = await res.json();
  expect(b.code, `${what}: the machine code`).toBe(LOCK);
  const named = comps.find(c => c.id === b.competitionId);
  expect(named, `${what}: names one of ${comps.map(c => c.name).join(" / ")}, got ${b.competitionId}`).toBeTruthy();
  expect(b.competitionName, `${what}: names it by name`).toBe(named.name);
  return b;
}

/**
 * A control must NOT be the lock — it may succeed, or be refused for another
 * reason. A dead session (401), a missing route (404) or a crash (500) is
 * neither: the door was never reached, so those fail too.
 */
async function expectNotLocked(res, what, allowed = [200, 400, 403, 409]) {
  const b = await res.json().catch(() => ({}));
  expect(allowed, `${what}: the door must be REACHED, got ${res.status()} ${JSON.stringify(b)}`).toContain(res.status());
  expect(res.status() === 403 && b.code === LOCK, `${what}: the unenrolled twin must not meet the competitor lock, got ${res.status()} ${JSON.stringify(b)}`).toBe(false);
  return { status: res.status(), body: b };
}

async function expectOk(res, what) {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
  return res.json();
}

async function compRow(api, id) {
  const r = await api.get("/api/admin/competitions");
  expect(r.ok(), `admin competitions list: ${r.status()}`).toBeTruthy();
  return (await r.json()).find(c => c.id === id);
}
async function taskRow(api, id) {
  const r = await api.get("/api/admin/tasks");
  expect(r.ok(), `admin tasks list: ${r.status()}`).toBeTruthy();
  return (await r.json()).find(t => t.id === id);
}
/** The admin-list row, and it MUST exist — a missing row would make every negative `enrolledIn` vacuous. */
async function participantRow(api, id) {
  const r = await api.get("/api/admin/participants?limit=5000&kind=all");
  expect(r.ok(), `admin participants list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).participants.find(p => p.id === id);
  expect(row, `${id} is in the admin list`).toBeTruthy();
  return row;
}
async function participantByEmail(api, email) {
  const r = await api.get("/api/admin/participants?limit=5000&kind=all");
  expect(r.ok(), `admin participants list: ${r.status()}`).toBeTruthy();
  return (await r.json()).participants.find(p => p.email === email);
}
function enrolledIn(row, compId) {
  return !!(row.competitions || []).find(c => c.id === compId);
}
/** The competition ids this user holds a row on — read straight off the table. */
function rowsFor(userId) {
  return withDb(db => new Set(db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(userId).map(r => r.competition_id)));
}
// The question is in the event: itself, or (for a bank question) the event's own
// copy of it, which is what every assign door puts in (lib/event-copies.js).
function taskHeldBy(db, taskId, compId) {
  return !!db.prepare("SELECT 1 FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND (t.id=? OR (t.copied_from_task_id=? AND t.owner_competition_id=ct.competition_id))").get(compId, taskId, taskId);
}
const groupMember = (gid, uid) => !!withDb(db => db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, uid));
const groupBound  = (gid, cid) => !!withDb(db => db.prepare("SELECT 1 FROM competition_groups WHERE group_id=? AND competition_id=?").get(gid, cid));
const groupExists = (gid)      => !!withDb(db => db.prepare("SELECT 1 FROM groups WHERE id=?").get(gid));
/** The group row by its stored (trimmed) name — the invitation create loop INSERTs the name as given. */
const groupByName = (name)     => withDb(db => db.prepare("SELECT id FROM groups WHERE name=?").get(name));
const feedbackRow = (uid, tid) => !!withDb(db => db.prepare("SELECT 1 FROM task_feedback WHERE user_id=? AND task_id=?").get(uid, tid));
function uploadsCount() {
  const dir = path.join(TEST_DATA_DIR, "uploads");
  try { return fs.readdirSync(dir).length; } catch (_) { return 0; }
}
const snapshotsOf = (body) => (body.versions || body).map(v => typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : v.snapshot);

// ── the shared, READ-ONLY world ──────────────────────────────────────────────
let sa, saCsrf, S2, TAG;
// T is held by E ALONE and U by F ALONE, and two arms assert that with
// EQUALITY (`competing_in` / `competitions`). The shared actors go on to hold
// rows on six OWN events across this file (E7, E8, E9, Eup, Eend, Ebooth, Eprog)
// — harmless only while no own-event test ASSIGNS T or U to its event. Assign a
// fresh challenge in an own-event test, never T or U, or those equalities
// become order-dependent (LOCK-12).
let E, F, T, U, P;
let A, SA, EA;          // enrolled in E (switch ON) AND in F (switch OFF) — the competitors
let A2, SA2, EA2;       // the same tiers, enrolled nowhere — the controls
let HINT_T, KEY_T, EXPL_T, HINT_U, KEY_U;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  TAG = uniq("sc").replace(/[^a-zA-Z0-9]/g, "");
  HINT_T = `HINTSEALED_${TAG}`; KEY_T = `KEYSEALED_${TAG}`; EXPL_T = `WHYSEALED_${TAG}`;
  HINT_U = `HINTPLAIN_${TAG}`;  KEY_U = `KEYPLAIN_${TAG}`;

  // The author of the sealed challenge: user-backed, never enrolled anywhere.
  S2 = await makeTier(sa, saCsrf, "author", "superadmin");

  E = await makeCompetition(sa, saCsrf, "on",  { staff_compete: true });
  F = await makeCompetition(sa, saCsrf, "off");

  T = await makeTask(S2.api, S2.csrf, "sealed", {
    answer_sealed: true, hint: HINT_T, correct_answer: KEY_T, explanation: `<p>${EXPL_T}</p>`,
    attempt_cap: 3,                        // so an attempt-grant CONTROL can succeed
  });
  // T is E's OWN copy of the sealed question (lib/event-copies.js): the challenge
  // the event holds, its participants answer and rate, and every door below acts on.
  T = { ...T, bankId: T.id, id: (await assignTask(sa, saCsrf, T.id, [E.id])).copies[0].task_id };
  U = await makeTask(sa, saCsrf, "plain", { hint: HINT_U, correct_answer: KEY_U });
  await assignTask(sa, saCsrf, U.id, [F.id]);

  // An ordinary participant on E: the attempt-grant target, the "somebody else"
  // of the removal door, the rater of T, and the second enrollee the fixture
  // checklist wants.
  P = await makeParticipant(sa, saCsrf, "p");
  await enrol(sa, saCsrf, E.id, [P.id]);

  // The tagged tiers are seated on F BEFORE their promotion (the only sequence
  // that writes a staff row on a switch-off event) and on E after it.
  A  = await makeTier(sa, saCsrf, "admin", "admin",      { enrolFirst: [F.id] });
  SA = await makeTier(sa, saCsrf, "super", "superadmin", { enrolFirst: [F.id] });
  EA = await makeEventAdmin(sa, saCsrf, "ea", [E.id, F.id]);
  await enrol(sa, saCsrf, F.id, [EA.id]);            // untagged: admitted anywhere
  await enrol(sa, saCsrf, E.id, [A.id, SA.id, EA.id]);

  A2  = await makeTier(sa, saCsrf, "admin2", "admin");
  SA2 = await makeTier(sa, saCsrf, "super2", "superadmin");
  EA2 = await makeEventAdmin(sa, saCsrf, "ea2", [E.id, F.id]);
});

test.afterAll(async () => {
  for (const c of [S2, A, SA, EA, A2, SA2, EA2]) await c?.api?.dispose();
  await sa?.dispose();
});

const actors   = () => [A, SA, EA];
const controls = () => [A2, SA2, EA2];
const twinOf   = (actor) => ({ admin: A2, superadmin: SA2, event_admin: EA2 })[actor.role];

test.describe("v8.12.0 — the competitor edit lock", () => {

  test("PRECONDITION: the world is what the lock is about — every competitor holds a row on BOTH events and competes on the switch-on one alone", async () => {
    for (const a of actors()) {
      const rows = rowsFor(a.id);
      expect(rows.has(E.id), `${a.label} holds a row on E (the table says so)`).toBe(true);
      expect(rows.has(F.id), `${a.label} holds a row on F too (the table says so)`).toBe(true);
      const e = await compRow(a.api, E.id);
      expect(e?.staff_compete, `${a.label}: E lets staff compete`).toBeTruthy();
      expect(e?.competing, `${a.label} really competes in E`).toBe(true);
      const f = await compRow(a.api, F.id);
      expect(f?.staff_compete, `${a.label}: F does not`).toBeFalsy();
      expect(f?.competing, `${a.label} does NOT compete in F — a row on a switch-off event is not a competitor's`).toBe(false);
      // …and the roster agrees with the table: the row on F is a real enrolment.
      expect(enrolledIn(await participantRow(sa, a.id), F.id), `${a.label} is on F's roster`).toBe(true);
      expect(enrolledIn(await participantRow(sa, a.id), E.id), `${a.label} is on E's roster`).toBe(true);
    }
    for (const c of controls()) {
      const rows = rowsFor(c.id);
      expect(rows.has(E.id), `${c.label} (the twin) holds no row on E`).toBe(false);
      expect(rows.has(F.id), `${c.label} (the twin) holds no row on F`).toBe(false);
      expect((await compRow(c.api, E.id))?.competing, `${c.label} does not compete in E`).toBe(false);
    }
    // The tagged rows on F could only be written BEFORE the promotion: the assign
    // route refuses to seat a staff-tagged user on a switch-off event, and says
    // so. Driven with the FRESH admin twin, whose "no row anywhere" the file
    // relies on — the refusal writes nothing.
    const r = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [A2.id], competitionIds: [F.id] } });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.assigned, "a staff-tagged admin cannot be seated on a switch-off event").toBe(0);
    expect(d.skippedStaff, "…and the skip is counted, not silent").toBe(1);
    expect(rowsFor(A2.id).has(F.id), "…and no row was written").toBe(false);
    // The challenges are what the projection arms assume.
    const t = await taskRow(S2.api, T.id);
    expect(t.answer_sealed, "T is sealed").toBeTruthy();
    expect(t.competitions.map(c => c.id), "T is held by E alone").toEqual([E.id]);
    const u = await taskRow(sa, U.id);
    expect(u.answer_sealed, "U is not sealed").toBeFalsy();
    expect(u.competitions.map(c => c.id), "U is held by F alone").toEqual([F.id]);
  });

  test("competition doors: PUT, end-now, tags, CxOne, join-link rotate, sessions, group unbind — 403 for every enrolled tier, naming the event", async () => {
    const before = await compRow(sa, E.id);
    const tokBefore = (await (await sa.get(`/api/admin/competitions/${E.id}/self-enroll`)).json()).token;
    expect(tokBefore, "the join link exists before anybody tries to rotate it").toBeTruthy();
    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      // The lock sits ABOVE the dry run: even a validate-only save is refused.
      // `remedy:"self"` is the LIVE-event CONTROL for the ended arm's negative:
      // without it a build that dropped the self-removal clause everywhere
      // passes "the ended remedy omits self-removal" for the wrong reason.
      await expectLocked(await a.api.put(`/api/admin/competitions/${E.id}`, { headers: H(a.csrf), data: { name: `hijack ${TAG} ${a.label}` } }), `${w} PUT E`, E, { remedy: "self" });
      await expectLocked(await a.api.put(`/api/admin/competitions/${E.id}`, { headers: H(a.csrf), data: { validate_only: true } }), `${w} PUT E (validate_only)`, E);
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/end-now`, { headers: H(a.csrf) }), `${w} end-now E`, E);
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/tags`, { headers: H(a.csrf), data: { tag: `lock-${a.label}` } }), `${w} POST E/tags`, E);
      await expectLocked(await a.api.delete(`/api/admin/competitions/${E.id}/tags/whatever`, { headers: H(a.csrf) }), `${w} DELETE E/tags`, E);
      await expectLocked(await a.api.put(`/api/admin/competitions/${E.id}/cxone`, { headers: H(a.csrf), data: { cxone_group_name: "g" } }), `${w} PUT E/cxone`, E);
      await expectLocked(await a.api.delete(`/api/admin/competitions/${E.id}/cxone`, { headers: H(a.csrf) }), `${w} DELETE E/cxone`, E);
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/self-enroll/regenerate`, { headers: H(a.csrf), data: {} }), `${w} regenerate E join link`, E);
      // Every session write, before the slot lookup — so no slot need exist.
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/timeslots`, { headers: H(a.csrf), data: {} }), `${w} POST E/timeslots`, E);
      await expectLocked(await a.api.put(`/api/admin/competitions/${E.id}/timeslots/no-such-slot`, { headers: H(a.csrf), data: { name: "x" } }), `${w} PUT E/timeslots/:ts`, E);
      await expectLocked(await a.api.delete(`/api/admin/competitions/${E.id}/timeslots/no-such-slot`, { headers: H(a.csrf) }), `${w} DELETE E/timeslots/:ts`, E);
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/timeslots/no-such-slot/end-now`, { headers: H(a.csrf) }), `${w} end-now E/timeslots/:ts`, E);
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/timeslots/bulk-delete`, { headers: H(a.csrf), data: { timeslotIds: ["no-such-slot"] } }), `${w} bulk-delete E/timeslots`, E);
      await expectLocked(await a.api.delete(`/api/admin/competitions/${E.id}/groups/no-such-group`, { headers: H(a.csrf) }), `${w} unbind E/groups/:g`, E);
    }
    // NOTHING WAS WRITTEN: name, status, tags and the join link are as they were.
    const after = await compRow(sa, E.id);
    expect(after.name, "the name did not move").toBe(before.name);
    expect(after.status, "the event was not ended").toBe("live");
    expect(after.tags, "no tag landed").toEqual(before.tags);
    expect(after.updated_at, "no write bumped the row").toBe(before.updated_at);
    const tokAfter = (await (await sa.get(`/api/admin/competitions/${E.id}/self-enroll`)).json()).token;
    expect(tokAfter, "the join link was not rotated").toBe(tokBefore);

    // CONTROLS — the same tier, not enrolled: the door itself works, and each
    // control asserts its REAL outcome, so a dead session cannot pass as "not
    // the lock".
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const dry = await c.api.put(`/api/admin/competitions/${E.id}`, { headers: H(c.csrf), data: { validate_only: true } });
      expect(dry.ok(), `${w} may dry-run a save on E: ${dry.status()} ${await dry.text()}`).toBeTruthy();
      const tag = `twin-${TAG}-${c.label}`.toLowerCase();
      const add = await c.api.post(`/api/admin/competitions/${E.id}/tags`, { headers: H(c.csrf), data: { tag } });
      expect(add.ok(), `${w} may tag E: ${add.status()} ${await add.text()}`).toBeTruthy();
      expect((await add.json()).tags).toContain(tag);
      const del = await c.api.delete(`/api/admin/competitions/${E.id}/tags/${encodeURIComponent(tag)}`, { headers: H(c.csrf) });
      expect(del.ok(), `${w} may untag E: ${del.status()} ${await del.text()}`).toBeTruthy();
      const unbind = await c.api.delete(`/api/admin/competitions/${E.id}/groups/no-such-group`, { headers: H(c.csrf) });
      if (c.role === "event_admin") {
        // An event admin is asked about the GROUP's scope next, and a group that
        // does not exist is out of it — a different, named reason.
        const nl = await expectNotLocked(unbind, `${w} unbind E/groups/:g`);
        expect(nl.body.code).toBe(SCOPE);
      } else {
        expect(unbind.ok(), `${w} reaches the unbind handler: ${unbind.status()} ${await unbind.text()}`).toBeTruthy();
        expect((await unbind.json()).unbound).toBe(false);
      }
      // A session write with an empty body reaches VALIDATION — the door's own
      // 400 naming the missing field, which a session that died before the
      // handler could never produce.
      const ts = await c.api.post(`/api/admin/competitions/${E.id}/timeslots`, { headers: H(c.csrf), data: {} });
      expect(ts.status(), `${w} POST E/timeslots reaches validation: ${await ts.text()}`).toBe(400);
      expect((await ts.json()).error, `${w}: the 400 names the session field`).toMatch(/session name/i);
      // The CxOne override round-trips: set, then removed, both real writes.
      const cx = await c.api.put(`/api/admin/competitions/${E.id}/cxone`, { headers: H(c.csrf), data: { cxone_group_name: `g-${c.label}` } });
      expect(cx.ok(), `${w} may set E's CxOne override: ${cx.status()} ${await cx.text()}`).toBeTruthy();
      const cxd = await c.api.delete(`/api/admin/competitions/${E.id}/cxone`, { headers: H(c.csrf) });
      expect(cxd.ok(), `${w} may remove E's CxOne override: ${cxd.status()} ${await cxd.text()}`).toBeTruthy();
    }
    // And the round trips really left E as it found it.
    expect((await compRow(sa, E.id)).tags).toEqual(before.tags);
  });

  test("roster doors: assign, desk-invite, invitation, attempt-grant, removing SOMEBODY ELSE — 403 for every enrolled tier, nothing written; the unenrolled twin succeeds and its writes land", async () => {
    const P2 = await makeParticipant(sa, saCsrf, "p2");     // never enrolled by a competitor
    const deskEmail = (who) => `desk-${TAG}-${who}@acme.com`;
    const invEmail  = (who) => `inv-${TAG}-${who}@acme.com`;
    const grantExtra = () => withDb(db => db.prepare("SELECT extra_attempts FROM attempt_grants WHERE user_id=? AND task_id=? AND competition_id=?").get(P.id, T.id, E.id)?.extra_attempts ?? 0);

    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      await expectLocked(await a.api.post("/api/admin/competitions/assign", { headers: H(a.csrf), data: { userIds: [P2.id], competitionIds: [E.id] } }), `${w} assign P2 -> E`, E);
      expect(enrolledIn(await participantRow(sa, P2.id), E.id), `${w}: P2 was not enrolled`).toBe(false);

      await expectLocked(await a.api.post("/api/admin/participants/desk-invite", { headers: H(a.csrf), data: { email: deskEmail(a.label), firstName: "Desk", lastName: "Walkup", competitionId: E.id } }), `${w} desk-invite into E`, E);
      expect(await participantByEmail(sa, deskEmail(a.label)), `${w}: the refused desk invite created no account`).toBeUndefined();

      await expectLocked(await a.api.post("/api/admin/invitations", { headers: H(a.csrf), data: { emails: [invEmail(a.label)], competitionIds: [E.id] } }), `${w} invite into E`, E);
      expect(withDb(db => db.prepare("SELECT 1 FROM invitations WHERE email=?").get(invEmail(a.label))), `${w}: the refused invitation wrote no row`).toBeUndefined();

      await expectLocked(await a.api.post(`/api/admin/tasks/${T.id}/attempt-grant`, { headers: H(a.csrf), data: { userId: P.id, competitionId: E.id, extra: 1 } }), `${w} attempt-grant on E`, E);

      await expectLocked(await a.api.delete(`/api/admin/competitions/${E.id}/users/${P.id}`, { headers: H(a.csrf) }), `${w} remove P from E`, E);
      expect(enrolledIn(await participantRow(sa, P.id), E.id), `${w}: P is still enrolled`).toBe(true);
    }
    expect(grantExtra(), "no grant was recorded by any refused actor").toBe(0);

    // CONTROLS — the same doors, the same three tiers, not enrolled. Each write
    // is read back from where the refusal arms above looked, so those reads are
    // shown to be looking in the right place.
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const P3 = await makeParticipant(sa, saCsrf, `p3-${c.label}`);
      const asg = await c.api.post("/api/admin/competitions/assign", { headers: H(c.csrf), data: { userIds: [P3.id], competitionIds: [E.id] } });
      expect(asg.ok(), `${w} may enrol into E: ${asg.status()} ${await asg.text()}`).toBeTruthy();
      expect((await asg.json()).assigned, `${w}: the enrolment happened`).toBe(1);
      expect(enrolledIn(await participantRow(sa, P3.id), E.id), `${w}: …and the roster shows it`).toBe(true);

      const desk = await c.api.post("/api/admin/participants/desk-invite", { headers: H(c.csrf), data: { email: deskEmail(c.label), firstName: "Desk", lastName: "Walkup", competitionId: E.id } });
      expect(desk.ok(), `${w} may desk-invite into E: ${desk.status()} ${await desk.text()}`).toBeTruthy();
      const walkup = await participantByEmail(sa, deskEmail(c.label));
      expect(walkup, `${w}: the desk-invited account exists`).toBeTruthy();
      expect(enrolledIn(walkup, E.id), `${w}: …and is enrolled in E`).toBe(true);

      const inv = await c.api.post("/api/admin/invitations", { headers: H(c.csrf), data: { emails: [invEmail(c.label)], competitionIds: [E.id] } });
      expect(inv.ok(), `${w} may invite into E: ${inv.status()} ${await inv.text()}`).toBeTruthy();
      expect(withDb(db => db.prepare("SELECT 1 FROM invitations WHERE email=?").get(invEmail(c.label))), `${w}: the invitation row exists`).toBeTruthy();

      const grant = await c.api.post(`/api/admin/tasks/${T.id}/attempt-grant`, { headers: H(c.csrf), data: { userId: P.id, competitionId: E.id, extra: 1 } });
      expect(grant.ok(), `${w} may grant attempts on E: ${grant.status()} ${await grant.text()}`).toBeTruthy();

      const rm = await c.api.delete(`/api/admin/competitions/${E.id}/users/${P3.id}`, { headers: H(c.csrf) });
      expect(rm.ok(), `${w} may remove somebody else from E: ${rm.status()} ${await rm.text()}`).toBeTruthy();
      expect((await rm.json()).removed).toBe(true);
      expect(enrolledIn(await participantRow(sa, P3.id), E.id), `${w}: …and P3 really left`).toBe(false);
    }
    // Grants UPSERT (`extra_attempts + excluded`), so three controls of one each
    // read back as exactly three — the refusal arm's zero above was a real zero.
    expect(grantExtra(), "the three control grants landed in the row the refusal arm reads").toBe(3);
  });

  test("the escape hatch: a competitor may remove THEMSELVES, and the lock lifts with the row", async () => {
    // Own world: the flow writes, so nothing here touches E.
    const E3 = await makeCompetition(sa, saCsrf, "hatch", { staff_compete: true });
    const T3 = await makeTask(S2.api, S2.csrf, "hatch-sealed", { answer_sealed: true, hint: "h", correct_answer: "k" });
    await assignTask(sa, saCsrf, T3.id, [E3.id]);
    const P3 = await makeParticipant(sa, saCsrf, "hatch-p");
    const A3  = await makeTier(sa, saCsrf, "hatch-admin", "admin");
    const SA3 = await makeTier(sa, saCsrf, "hatch-super", "superadmin");
    const EA3 = await makeEventAdmin(sa, saCsrf, "hatch-ea", [E3.id]);
    await enrol(sa, saCsrf, E3.id, [P3.id, A3.id, SA3.id, EA3.id]);
    try {
      for (const a of [A3, SA3, EA3]) {
        const w = `${a.label} (${a.role})`;
        const live = await compRow(sa, E3.id);
        await expectLocked(await a.api.put(`/api/admin/competitions/${E3.id}`, { headers: H(a.csrf), data: { name: `hijack ${uniq(a.label)}` } }), `${w} PUT E3 while competing`, live, { remedy: "self" });
        // The TASK side is locked by the same row, and says so.
        await expectLocked(await a.api.put(`/api/admin/tasks/${T3.id}`, { headers: H(a.csrf), data: { title: `hijack ${uniq(a.label)}` } }), `${w} PUT T3 while competing`, live, { remedy: "self" });
        expect((await taskRow(a.api, T3.id)).competing_in, `${w}: T3's row names E3 while they compete`).toEqual([{ id: E3.id, name: live.name, status: "live" }]);   // `live`: the loop renames E3
        // SOMEBODY ELSE is still refused — the carve-out is self-removal only.
        await expectLocked(await a.api.delete(`/api/admin/competitions/${E3.id}/users/${P3.id}`, { headers: H(a.csrf) }), `${w} remove P3`, live);
        expect(enrolledIn(await participantRow(sa, P3.id), E3.id)).toBe(true);
        // The escape hatch.
        const self = await a.api.delete(`/api/admin/competitions/${E3.id}/users/${a.id}`, { headers: H(a.csrf) });
        expect(self.ok(), `${w} may remove themselves: ${self.status()} ${await self.text()}`).toBeTruthy();
        expect((await self.json()).removed, `${w}: the row really went`).toBe(true);
        expect(enrolledIn(await participantRow(sa, a.id), E3.id)).toBe(false);
        expect((await compRow(a.api, E3.id)).competing, `${w} no longer competes`).toBe(false);
        // …and the lock lifted: a REAL write now lands.
        const newName = `Hatch ${uniq(a.label)}`;
        const put = await a.api.put(`/api/admin/competitions/${E3.id}`, { headers: H(a.csrf), data: { name: newName } });
        expect(put.ok(), `${w} may edit E3 after leaving it: ${put.status()} ${await put.text()}`).toBeTruthy();
        expect((await compRow(sa, E3.id)).name, `${w}: the rename took`).toBe(newName);
        // …on the TASK side too (`competitorEventsForTask` reads the same row):
        // the refusal that remains is the SEAL's (a global tier) or OWNERSHIP's
        // (the event-admin tier) — a rule of its own, and never the lock.
        const tput = await a.api.put(`/api/admin/tasks/${T3.id}`, { headers: H(a.csrf), data: { title: `after ${uniq(a.label)}` } });
        const tnl = await expectNotLocked(tput, `${w} PUT T3 after leaving E3`, [403]);
        expect(["answer_sealed_not_author", "event_admin_not_owner"], `${w}: refused by a rule of its own after leaving, got ${tnl.body.code}`).toContain(tnl.body.code);
        expect((await taskRow(a.api, T3.id)).competing_in, `${w}: T3's row no longer names any event`).toEqual([]);
      }
    } finally {
      for (const c of [A3, SA3, EA3]) await c.api.dispose();
    }
  });

  test("superadmin-only doors: deleting the event and granting or revoking an organiser — 403 for a competing superadmin, nothing moved", async () => {
    const fresh = await makeParticipant(sa, saCsrf, "org-candidate");
    // DELETE the event: superadmin-only, so SA is the reachable competitor.
    await expectLocked(await SA.api.delete(`/api/admin/competitions/${E.id}`, { headers: H(SA.csrf) }), "SA DELETE E", E);
    expect(await compRow(sa, E.id), "E still exists").toBeTruthy();
    // The organiser routes admit any GLOBAL admin, so both global competitors are refused.
    for (const a of [A, SA]) {
      const w = `${a.label} (${a.role})`;
      await expectLocked(await a.api.post(`/api/admin/competitions/${E.id}/admins`, { headers: H(a.csrf), data: { userId: fresh.id } }), `${w} grant an organiser on E`, E);
      await expectLocked(await a.api.delete(`/api/admin/competitions/${E.id}/admins/${EA.id}`, { headers: H(a.csrf) }), `${w} revoke EA on E`, E);
    }
    const organisers = await (await sa.get(`/api/admin/competitions/${E.id}/admins`)).json();
    const ids = organisers.admins.map(o => o.id);
    expect(ids, "EA is still an organiser").toContain(EA.id);
    expect(ids, "the candidate was not granted").not.toContain(fresh.id);
    expect((await participantRow(sa, fresh.id)).role || "participant", "the candidate's role did not move").toBe("participant");

    // CONTROLS: the unenrolled superadmin grants and revokes, and deletes a throwaway.
    const grant = await SA2.api.post(`/api/admin/competitions/${E.id}/admins`, { headers: H(SA2.csrf), data: { userId: fresh.id } });
    expect(grant.ok(), `SA2 may grant: ${grant.status()} ${await grant.text()}`).toBeTruthy();
    const revoke = await SA2.api.delete(`/api/admin/competitions/${E.id}/admins/${fresh.id}`, { headers: H(SA2.csrf) });
    expect(revoke.ok(), `SA2 may revoke: ${revoke.status()} ${await revoke.text()}`).toBeTruthy();
    const gone = await makeCompetition(sa, saCsrf, "throwaway", { staff_compete: true, start_time: new Date(Date.now() + 3600_000).toISOString() });
    const del = await SA2.api.delete(`/api/admin/competitions/${gone.id}`, { headers: H(SA2.csrf) });
    expect(del.ok(), `SA2 may delete an event they do not compete in: ${del.status()} ${await del.text()}`).toBeTruthy();
  });

  test("challenge doors on a HELD challenge: PUT, publish, visibility, restore, tags, attachments, lock, recalculate, delete — 403 for every enrolled tier, above the seal and the tier; every door succeeds for somebody it does not bind", async () => {
    const before = await taskRow(S2.api, T.id);
    const vs = await (await S2.api.get(`/api/admin/tasks/${T.id}/versions`)).json();
    const versionId = (vs.versions || vs)[0]?.id;
    expect(versionId, "the fixture has a version to restore").toBeTruthy();
    const zipish = { file: { name: "lock.zip", mimeType: "application/zip", buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not-really-a-zip")]) } };

    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      // The task-side refusal reads the same remedy resolver (`competitorTaskEditDenied`
      // → `_competitorRemedy`): on a live event it offers self-removal too.
      await expectLocked(await a.api.put(`/api/admin/tasks/${T.id}`, { headers: H(a.csrf), data: { title: `hijack ${TAG}` } }), `${w} PUT T`, E, { remedy: "self" });
      await expectLocked(await a.api.post(`/api/admin/tasks/${T.id}/publish`, { headers: H(a.csrf) }), `${w} publish T`, E);
      await expectLocked(await a.api.patch(`/api/admin/tasks/${T.id}/visibility`, { headers: H(a.csrf), data: { active: false } }), `${w} visibility T`, E);
      await expectLocked(await a.api.post(`/api/admin/tasks/${T.id}/restore`, { headers: H(a.csrf), data: { versionId } }), `${w} restore T`, E);
      await expectLocked(await a.api.post(`/api/admin/tasks/${T.id}/tags`, { headers: H(a.csrf), data: { tag: `lock-${a.label}` } }), `${w} POST T/tags`, E);
      await expectLocked(await a.api.delete(`/api/admin/tasks/${T.id}/tags/x`, { headers: H(a.csrf) }), `${w} DELETE T/tags`, E);
      // The upload: multer has already written the body, so the 403 must reclaim it.
      const filesBefore = uploadsCount();
      const up = await a.api.post(`/api/admin/tasks/${T.id}/attachments`, { headers: { "x-csrf-token": a.csrf }, multipart: { ...zipish, display_name: "lock" } });
      await expectLocked(up, `${w} POST T/attachments`, E);
      expect(uploadsCount(), `${w}: the refused upload left no temp file`).toBe(filesBefore);
      // Before the attachment lookup: no attachment need exist.
      await expectLocked(await a.api.patch(`/api/admin/tasks/${T.id}/attachments/no-such-attachment`, { headers: H(a.csrf), data: { display_name: "x" } }), `${w} PATCH T/attachments/:aid`, E);
      await expectLocked(await a.api.delete(`/api/admin/tasks/${T.id}/attachments/no-such-attachment`, { headers: H(a.csrf) }), `${w} DELETE T/attachments/:aid`, E);
    }
    // The superadmin-only doors, for the competing superadmin.
    await expectLocked(await SA.api.post(`/api/admin/tasks/${T.id}/lock`, { headers: H(SA.csrf) }), "SA lock T", E);
    await expectLocked(await SA.api.post(`/api/admin/tasks/${T.id}/recalculate`, { headers: H(SA.csrf), data: { confirm_live: true } }), "SA recalculate T", E);
    await expectLocked(await SA.api.delete(`/api/admin/tasks/${T.id}`, { headers: H(SA.csrf) }), "SA DELETE T", E);

    // NOTHING WAS WRITTEN.
    const after = await taskRow(S2.api, T.id);
    expect(after, "T still exists").toBeTruthy();
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);
    expect(!!after.active).toBe(!!before.active);
    expect(!!after.locked).toBe(!!before.locked);
    expect(after.tags).toEqual(before.tags);
    expect(after.attachment_count).toBe(before.attachment_count);
    expect(after.updated_at, "no write bumped the row").toBe(before.updated_at);

    // CONTROLS. (a) The AUTHOR, not enrolled, may still edit: the doors work.
    const rename = `Sealed ${TAG} by author`;
    const mine = await S2.api.put(`/api/admin/tasks/${T.id}`, { headers: H(S2.csrf), data: { title: rename } });
    expect(mine.ok(), `the author may edit T: ${mine.status()} ${await mine.text()}`).toBeTruthy();
    expect((await taskRow(S2.api, T.id)).title).toBe(rename);
    const tag = `author-${TAG}`.toLowerCase();
    const tg = await S2.api.post(`/api/admin/tasks/${T.id}/tags`, { headers: H(S2.csrf), data: { tag } });
    expect(tg.ok(), `the author may tag T: ${tg.status()} ${await tg.text()}`).toBeTruthy();
    const untg = await S2.api.delete(`/api/admin/tasks/${T.id}/tags/${encodeURIComponent(tag)}`, { headers: H(S2.csrf) });
    expect(untg.ok(), `the author may untag T: ${untg.status()} ${await untg.text()}`).toBeTruthy();
    // (b) The unenrolled twins meet the SEAL, not the lock — a different code,
    // which is what says the competitors above were refused for competing.
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const put = await c.api.put(`/api/admin/tasks/${T.id}`, { headers: H(c.csrf), data: { title: `twin ${TAG}` } });
      expect(put.status(), `${w} PUT T is refused, but not by the lock`).toBe(403);
      const code = (await put.json()).code;
      // A global twin meets the SEAL; the event-admin twin meets OWNERSHIP first
      // (the PUT asks it ahead of the seal for that tier). Either is a rule that
      // binds them — what matters is that it is not the competitor lock.
      expect(["answer_sealed_not_author", "event_admin_not_owner"], `${w}: refused by a rule of its own, got ${code}`).toContain(code);
      expect(code).not.toBe(LOCK);
    }
    // (c) THE SWITCH HALF OF THE TASK-SIDE PREDICATE. A and SA HOLD A ROW on F
    // (switch off), which holds U — so "U stays editable" is only true if the
    // lock reads the switch and not merely the row. A mutation dropping the
    // `staff_compete = 1` term from `competitorEventsForTask` fails here.
    for (const a of [A, SA]) {
      expect(rowsFor(a.id).has(F.id), `${a.label} really holds a row on F`).toBe(true);
      const put = await a.api.put(`/api/admin/tasks/${U.id}`, { headers: H(a.csrf), data: { title: `Plain ${TAG} touched by ${a.label}` } });
      expect(put.ok(), `${a.label} may edit U (held by F, where they hold a row but do not compete): ${put.status()} ${await put.text()}`).toBeTruthy();
      expect((await taskRow(sa, U.id)).title, `${a.label}: the edit of U took`).toBe(`Plain ${TAG} touched by ${a.label}`);
    }
    // (d) EVERY OTHER DOOR SUCCEEDS FOR SOMEBODY IT DOES NOT BIND, on a throwaway
    // sealed challenge: the author drives publish / visibility / restore /
    // attachments / recalculate / delete, the unenrolled superadmin twin the
    // lock. Without these a door-local mistake (a route asking the lock about
    // the wrong id and refusing everybody) is invisible.
    const T9 = await makeTask(S2.api, S2.csrf, "door-ctl", { answer_sealed: true, hint: "h", correct_answer: "k", status: "draft" });
    await expectOk(await S2.api.post(`/api/admin/tasks/${T9.id}/publish`, { headers: H(S2.csrf) }), "the author may publish T9");
    expect((await taskRow(S2.api, T9.id)).status, "T9 is published").toBe("published");
    await expectOk(await S2.api.patch(`/api/admin/tasks/${T9.id}/visibility`, { headers: H(S2.csrf), data: { active: false } }), "the author may hide T9");
    expect(!!(await taskRow(S2.api, T9.id)).active, "T9 is hidden").toBe(false);
    await expectOk(await S2.api.patch(`/api/admin/tasks/${T9.id}/visibility`, { headers: H(S2.csrf), data: { active: true } }), "the author may show T9");
    const v9 = (await (await S2.api.get(`/api/admin/tasks/${T9.id}/versions`)).json());
    const v9id = (v9.versions || v9)[0]?.id;
    expect(v9id, "T9 has a version").toBeTruthy();
    await expectOk(await S2.api.post(`/api/admin/tasks/${T9.id}/restore`, { headers: H(S2.csrf), data: { versionId: v9id } }), "the author may restore T9");
    // The attachment doors are REACHED: a nonsense zip is refused by the zip
    // validator (400), a missing attachment by the lookup (404) — never by 403.
    const upAuthor = await S2.api.post(`/api/admin/tasks/${T9.id}/attachments`, { headers: { "x-csrf-token": S2.csrf }, multipart: { ...zipish, display_name: "ctl" } });
    expect(upAuthor.status(), `the author's upload reaches the zip validator: ${await upAuthor.text()}`).toBe(400);
    expect((await S2.api.patch(`/api/admin/tasks/${T9.id}/attachments/no-such`, { headers: H(S2.csrf), data: { display_name: "x" } })).status(), "the author's PATCH reaches the lookup").toBe(404);
    expect((await S2.api.delete(`/api/admin/tasks/${T9.id}/attachments/no-such`, { headers: H(S2.csrf) })).status(), "the author's DELETE reaches the lookup").toBe(404);
    await expectOk(await SA2.api.post(`/api/admin/tasks/${T9.id}/lock`, { headers: H(SA2.csrf) }), "SA2 may lock T9");
    expect(!!(await taskRow(SA2.api, T9.id)).locked, "T9 is locked").toBe(true);
    await expectOk(await SA2.api.post(`/api/admin/tasks/${T9.id}/lock`, { headers: H(SA2.csrf) }), "SA2 may unlock T9 (the route toggles)");
    expect(!!(await taskRow(SA2.api, T9.id)).locked, "T9 is unlocked").toBe(false);
    await expectOk(await S2.api.post(`/api/admin/tasks/${T9.id}/recalculate`, { headers: H(S2.csrf), data: {} }), "the author may recalculate T9");
    await expectOk(await S2.api.delete(`/api/admin/tasks/${T9.id}`, { headers: H(S2.csrf) }), "the author (a superadmin) may delete T9");
    expect(await taskRow(S2.api, T9.id), "T9 is gone").toBeUndefined();
  });

  for (const tier of ["admin", "superadmin", "event_admin"]) {
    test(`assignment doors (${tier}): adding to or taking out of the event you compete in is refused; another event stays yours`, async () => {
      const a = actors().find(x => x.role === tier);
      const c = twinOf(a);
      const w = `${a.label} (${a.role})`;
      // OWN FIXTURES — this flow writes assignments. E2 is a second compete
      // event the actor ASSIGNS INTO FIRST and is enrolled in AFTERWARDS, so the
      // assignment on E2 is one they made themselves: the shape in which the
      // event-admin tier would otherwise be allowed to take it back
      // (`taskUnassignDenied` admits the assigner), which is what makes the
      // refusal below the LOCK's and nobody else's. F2 holds both challenges
      // first, so the event-admin tier can SEE them for the CONTROL arms
      // (`taskViewDenied` still gates a real assignment; the lock is asked
      // ahead of it); F3 is the fresh event the "another event stays yours"
      // arms write into.
      const E2 = await makeCompetition(sa, saCsrf, `e2-${tier}`, { staff_compete: true });
      const F2 = await makeCompetition(sa, saCsrf, `f2-${tier}`);
      const F3 = await makeCompetition(sa, saCsrf, `f3-${tier}`);
      if (tier === "event_admin") {
        for (const cid of [E2.id, F2.id, F3.id]) { await grantEventAdmin(sa, saCsrf, cid, a.id); await grantEventAdmin(sa, saCsrf, cid, c.id); }
      }
      const T2 = await makeTask(S2.api, S2.csrf, `t2-${tier}`, { answer_sealed: true, hint: "h", correct_answer: "k" });
      const T3 = await makeTask(S2.api, S2.csrf, `t3-${tier}`, { answer_sealed: true, hint: "h", correct_answer: "k" });
      await assignTask(sa, saCsrf, T2.id, [F2.id]);
      await assignTask(sa, saCsrf, T3.id, [F2.id]);
      await assignTask(a.api, a.csrf, T2.id, [E2.id]);          // THE ACTOR's own assignment, before enrolment
      await enrol(sa, saCsrf, E2.id, [a.id]);
      expect((await compRow(a.api, E2.id)).competing, `${w} now competes in E2`).toBe(true);
      const held = (t, cmp) => withDb(db => taskHeldBy(db, t.id, cmp.id));

      // 1. Bulk: refused BEFORE any write — T3 lands nowhere, not even on F3.
      const bulk = await a.api.post("/api/admin/tasks/assign-competitions", { headers: H(a.csrf), data: { taskIds: [T3.id], competitionIds: [F3.id, E2.id] } });
      await expectLocked(bulk, `${w} bulk-assign naming E2`, E2);
      expect(held(T3, F3), `${w}: the bulk refusal assigned nothing, not even to the event that is not theirs`).toBe(false);
      expect(held(T3, E2), `${w}: …and nothing to E2`).toBe(false);

      // 2. Adding a HELD challenge to ANOTHER event is allowed — F3 is not theirs to be locked on.
      const toF3 = await a.api.post(`/api/admin/tasks/${T2.id}/competitions`, { headers: H(a.csrf), data: { competitionIds: [F3.id] } });
      expect(toF3.ok(), `${w} may add T2 to F3: ${toF3.status()} ${await toF3.text()}`).toBeTruthy();
      expect((await toF3.json()).assigned, `${w}: T2 -> F3 really happened`).toBe(1);

      // 3. Adding ANY challenge to E2 is refused — the sealed one E2 would
      //    otherwise admit (sharp), and the unsealed one BEFORE the seal rule can
      //    answer (the lock is the first door).
      await expectLocked(await a.api.post(`/api/admin/tasks/${T3.id}/competitions`, { headers: H(a.csrf), data: { competitionIds: [E2.id] } }), `${w} add T3 to E2`, E2);
      expect(held(T3, E2), `${w}: T3 was not added to E2`).toBe(false);
      const unsealed = await a.api.post(`/api/admin/tasks/${U.id}/competitions`, { headers: H(a.csrf), data: { competitionIds: [E2.id] } });
      await expectLocked(unsealed, `${w} add U to E2 (the lock answers before the seal rule)`, E2);
      expect(held(U, E2), `${w}: U was not added to E2`).toBe(false);

      // 4. Desired state that REMOVES E2 → refused; nothing moved.
      await expectLocked(await a.api.put(`/api/admin/tasks/${T2.id}/competitions`, { headers: H(a.csrf), data: { competitionIds: [F2.id, F3.id], expectedAssignments: [E2.id, F2.id, F3.id] } }), `${w} PUT T2/competitions dropping E2`, E2);
      expect(held(T2, E2), `${w}: T2 is still in E2`).toBe(true);
      expect(held(T2, F3), `${w}: …and still in F3`).toBe(true);
      // 5. Desired state that ADDS E2 → refused; nothing moved.
      await expectLocked(await a.api.put(`/api/admin/tasks/${T3.id}/competitions`, { headers: H(a.csrf), data: { competitionIds: [F2.id, E2.id], expectedAssignments: [F2.id] } }), `${w} PUT T3/competitions adding E2`, E2);
      expect(held(T3, E2), `${w}: T3 is still not in E2`).toBe(false);

      // 6. DELETE the assignment on E2 — THEIR OWN — → refused; the one they made on F3 → allowed.
      await expectLocked(await a.api.delete(`/api/admin/tasks/${T2.id}/competitions/${E2.id}`, { headers: H(a.csrf) }), `${w} DELETE T2/competitions/E2`, E2);
      expect(held(T2, E2), `${w}: T2 is still in E2`).toBe(true);
      const un = await a.api.delete(`/api/admin/tasks/${T2.id}/competitions/${F3.id}`, { headers: H(a.csrf) });
      expect(un.ok(), `${w} may take T2 out of F3: ${un.status()} ${await un.text()}`).toBeTruthy();
      expect(held(T2, F3), `${w}: T2 left F3`).toBe(false);

      // 7. A desired state that ROUND-TRIPS E2 untouched and changes only F3 → allowed.
      const rt = await a.api.put(`/api/admin/tasks/${T2.id}/competitions`, { headers: H(a.csrf), data: { competitionIds: [E2.id, F2.id, F3.id], expectedAssignments: [E2.id, F2.id] } });
      expect(rt.ok(), `${w} may change T2's OTHER assignments while E2 rides along unchanged: ${rt.status()} ${await rt.text()}`).toBeTruthy();
      const rtBody = await rt.json();
      expect(rtBody.added, `${w}: F3 was added`).toBe(1);
      expect(rtBody.removed, `${w}: E2 was left alone`).toBe(0);
      expect(held(T2, E2)).toBe(true);
      expect(held(T2, F3)).toBe(true);

      // CONTROL: the unenrolled twin's bulk assign naming E2 lands.
      const twinBulk = await c.api.post("/api/admin/tasks/assign-competitions", { headers: H(c.csrf), data: { taskIds: [T3.id], competitionIds: [E2.id] } });
      expect(twinBulk.ok(), `${c.label} (unenrolled) may bulk-assign into E2: ${twinBulk.status()} ${await twinBulk.text()}`).toBeTruthy();
      const tb = await twinBulk.json();
      expect(tb.assigned, `${c.label}: T3 -> E2 happened (skipped: ${JSON.stringify(tb.skipped)})`).toBe(1);
      expect(held(T3, E2)).toBe(true);
    });
  }

  test("the three assignment doors ask the lock ahead of the assigner and locked-challenge gates — the PUT's remove direction included; the three body-scoped roster doors keep their stated orderings", async () => {
    // Own world. E4 is organised by EA4; E6 is a compete event EA4 competes in
    // but does NOT organise (the assign route admits an untagged event admin
    // anywhere), which is the only shape that separates the scope answer from
    // the lock on the body-scoped roster doors.
    const E4 = await makeCompetition(sa, saCsrf, "order", { staff_compete: true });
    const E6 = await makeCompetition(sa, saCsrf, "order-far", { staff_compete: true });
    const T4 = await makeTask(S2.api, S2.csrf, "order-sealed", { answer_sealed: true, hint: "h", correct_answer: "k" });
    const T5 = await makeTask(S2.api, S2.csrf, "order-sealed-2", { answer_sealed: true, hint: "h", correct_answer: "k" });
    await assignTask(sa, saCsrf, T4.id, [E4.id]);                 // assigned by the built-in, not by the actor
    const A4  = await makeTier(sa, saCsrf, "order-admin", "admin");
    const EA4 = await makeEventAdmin(sa, saCsrf, "order-ea", [E4.id]);
    const Px  = await makeParticipant(sa, saCsrf, "order-p");
    await enrol(sa, saCsrf, E4.id, [EA4.id, A4.id]);
    await enrol(sa, saCsrf, E6.id, [EA4.id]);
    const held = (t, cmp) => withDb(db => taskHeldBy(db, t.id, cmp.id));
    const setLock = async (t, on) => {
      const cur = !!(await taskRow(sa, t.id)).locked;
      if (cur !== on) expect((await sa.post(`/api/admin/tasks/${t.id}/lock`, { headers: H(saCsrf) })).ok(), `lock ${t.title} → ${on}`).toBeTruthy();
      expect(!!(await taskRow(sa, t.id)).locked, `${t.title} locked=${on}`).toBe(on);
    };
    try {
      // (a) the event admin, competing, who did NOT make the assignment — the
      // lock, not "not the assigner", on the DELETE and on the PUT's remove
      // direction (asked in the pre-pass over the PROSPECTIVE removals, right
      // after the 404 — v8.12.0 round 3 hoisted it out of the transaction).
      await expectLocked(await EA4.api.delete(`/api/admin/tasks/${T4.id}/competitions/${E4.id}`, { headers: H(EA4.csrf) }), "EA4 (not the assigner) DELETE T4/competitions/E4", E4);
      await expectLocked(await EA4.api.put(`/api/admin/tasks/${T4.id}/competitions`, { headers: H(EA4.csrf), data: { competitionIds: [], expectedAssignments: [E4.id] } }), "EA4 (not the assigner) PUT T4/competitions dropping E4", E4);
      expect(held(T4, E4), "T4 is still in E4").toBe(true);
      // (b) the admin, competing, on a LOCKED challenge — the lock, not "locked",
      // on all three doors.
      await setLock(T4, true); await setLock(T5, true);
      try {
        await expectLocked(await A4.api.delete(`/api/admin/tasks/${T4.id}/competitions/${E4.id}`, { headers: H(A4.csrf) }), "A4 (locked challenge) DELETE T4/competitions/E4", E4);
        await expectLocked(await A4.api.post(`/api/admin/tasks/${T5.id}/competitions`, { headers: H(A4.csrf), data: { competitionIds: [E4.id] } }), "A4 (locked challenge) POST T5/competitions [E4]", E4);
        expect(held(T5, E4), "T5 was not added to E4").toBe(false);
        await expectLocked(await A4.api.put(`/api/admin/tasks/${T5.id}/competitions`, { headers: H(A4.csrf), data: { competitionIds: [E4.id], expectedAssignments: [] } }), "A4 (locked challenge) PUT T5/competitions adding E4", E4);
        expect(held(T5, E4), "T5 is still not in E4").toBe(false);
        // THE REMOVE DIRECTION TOO. The first draft computed removals inside
        // the transaction, BELOW the locked-task gate, so a competing regular
        // admin dropping a LOCKED challenge heard "locked" (no code) where every
        // sibling door answered the lock — the one door where the tier decided
        // the reason. The pre-pass now diffs the FULL current set against the
        // desired one (narrowed to the actor's scope, so an event admin is not
        // refused over an event they cannot see) and asks the lock there, so
        // the answer is `competitor_cannot_edit` on every door.
        await expectLocked(await A4.api.put(`/api/admin/tasks/${T4.id}/competitions`, { headers: H(A4.csrf), data: { competitionIds: [], expectedAssignments: [E4.id] } }), "A4 (locked challenge) PUT T4/competitions dropping E4", E4);
        expect(held(T4, E4), "T4 is still in E4").toBe(true);
      } finally {
        await setLock(T4, false); await setLock(T5, false);
      }
      // (c) THE STATED ORDERING on the three roster doors that take the event in
      // the BODY: the event-admin SCOPE is answered before the lock. EA4 competes
      // in E6 but does not organise it, so naming E6 hears the scope; naming E4
      // alone hears the lock — the same actor, two doors apart.
      const asgFar = await EA4.api.post("/api/admin/competitions/assign", { headers: H(EA4.csrf), data: { userIds: [Px.id], competitionIds: [E4.id, E6.id] } });
      expect(asgFar.status(), `EA4 assign naming E6 (out of scope): ${await asgFar.text()}`).toBe(403);
      expect((await asgFar.json()).code, "the scope answers first on assign").toBe(SCOPE);
      expect(rowsFor(Px.id).size, "the scope refusal enrolled nobody").toBe(0);
      await expectLocked(await EA4.api.post("/api/admin/competitions/assign", { headers: H(EA4.csrf), data: { userIds: [Px.id], competitionIds: [E4.id] } }), "EA4 assign naming E4 alone", E4);
      expect(rowsFor(Px.id).size, "the lock enrolled nobody either").toBe(0);
      const invFar = await EA4.api.post("/api/admin/invitations", { headers: H(EA4.csrf), data: { emails: [`far-${TAG}@acme.com`], competitionIds: [E4.id, E6.id] } });
      expect(invFar.status(), `EA4 invite naming E6: ${await invFar.text()}`).toBe(403);
      expect((await invFar.json()).code, "the scope answers first on invitations").toBe(SCOPE);
      expect(withDb(db => db.prepare("SELECT 1 FROM invitations WHERE email=?").get(`far-${TAG}@acme.com`)), "no invitation row").toBeUndefined();
      const grantFar = await EA4.api.post(`/api/admin/tasks/${T4.id}/attempt-grant`, { headers: H(EA4.csrf), data: { userId: Px.id, competitionId: E6.id, extra: 1 } });
      expect(grantFar.status(), `EA4 attempt-grant on E6: ${await grantFar.text()}`).toBe(403);
      expect((await grantFar.json()).code, "the scope answers first on attempt-grant").toBe(SCOPE);
      await expectLocked(await EA4.api.post(`/api/admin/tasks/${T4.id}/attempt-grant`, { headers: H(EA4.csrf), data: { userId: Px.id, competitionId: E4.id, extra: 1 } }), "EA4 attempt-grant on E4", E4);
      // DESK-INVITE is the fourth roster door taking the event in the BODY, and
      // it is NOT one of the three: the lock is asked before the scope there
      // (routes/participants.js, the `competitionId` branch), so the same actor
      // naming E6 hears the LOCK on this door and the SCOPE on the three above.
      // Pinned so that moving either is a decision (LOCK-10).
      const deskFarEmail = `desk-far-${TAG}@acme.com`;
      await expectLocked(await EA4.api.post("/api/admin/participants/desk-invite", { headers: H(EA4.csrf), data: { email: deskFarEmail, firstName: "Desk", lastName: "Far", competitionId: E6.id } }), "EA4 desk-invite into E6 (lock before scope)", E6);
      expect(await participantByEmail(sa, deskFarEmail), "the refused desk invite created no account").toBeUndefined();
      // …and on the competition doors the lock precedes the scope: a competing
      // event admin hears the lock on an event they do not organise.
      await expectLocked(await EA4.api.put(`/api/admin/competitions/${E6.id}`, { headers: H(EA4.csrf), data: { name: `hijack ${TAG} far` } }), "EA4 PUT E6 (competing, not organising)", E6);
    } finally {
      await A4.api.dispose(); await EA4.api.dispose();
    }
  });

  test("the projection: a competitor's challenge row is read-only and withholds the hint — by value, over the whole payload; the row on the switch-off event is ordinary", async () => {
    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      const r = await a.api.get("/api/admin/tasks");
      expect(r.ok(), `${w} list: ${r.status()}`).toBeTruthy();
      const all = await r.json();
      const raw = JSON.stringify(all);
      const t = all.find(x => x.id === T.id);
      expect(t, `${w} can still SEE the held challenge`).toBeTruthy();
      expect(t.competing_in, `${w}: the row says which event locks it, and its status`).toEqual([{ id: E.id, name: E.name, status: "live" }]);
      // On the SEALED fixture the collapsed flags and the missing key are what
      // the seal answers for every non-author too — they are asserted, and they
      // are satisfied by the seal alone — and since v8.12.2 sealed the hint with
      // the key, so is the withheld hint. The lock's own witnesses on T are
      // `competing_in` and (global tiers) `can_unassign`; the PLANTED test below
      // pins the flags and the hint where the seal cannot be the reason.
      expect(t.can_edit, `${w}: not editable (seal-satisfied)`).toBe(false);
      expect(t.can_edit_scoring, `${w}: not scoring-editable (seal-satisfied)`).toBe(false);
      expect(t.can_see_answer, `${w}: the answer is not theirs to read (seal-satisfied)`).toBe(false);
      const onE = t.competitions.find(x => x.id === E.id);
      expect(onE, `${w}: the assignment on E is listed`).toBeTruthy();
      expect(onE.can_unassign, `${w}: …and cannot be taken out`).toBe(false);
      expect(t.correct_answer, `${w}: no key (seal-satisfied)`).toBeUndefined();
      expect(t.explanation, `${w}: no explanation (seal-satisfied)`).toBeUndefined();
      expect(t.hint, `${w}: no hint`).toBeUndefined();
      expect(t.hint_withheld, `${w}: and the row SAYS the hint is withheld`).toBe(true);
      // BY VALUE, over the whole payload — a leak under a renamed key still fails.
      expect(raw, `${w} must not receive the hint under ANY field name`).not.toContain(HINT_T);
      expect(raw, `${w} must not receive the key under ANY field name`).not.toContain(KEY_T);
      expect(raw, `${w} must not receive the explanation under ANY field name`).not.toContain(EXPL_T);
      // In the SAME payload the challenge held by F — where they HOLD A ROW but
      // the switch is off — is an ordinary row: the withholding is per compete
      // event, not per actor and not per row. A mutation dropping the
      // `staff_compete = 1` term from the projection's competing set fails here.
      expect(rowsFor(a.id).has(F.id), `${a.label} really holds a row on F`).toBe(true);
      const u = all.find(x => x.id === U.id);
      expect(u, `${w} sees U`).toBeTruthy();
      expect(u.competing_in, `${w}: U locks nothing`).toEqual([]);
      expect(u.hint, `${w}: U's hint is on the wire`).toBe(HINT_U);
      expect(u.hint_withheld, `${w}: U's hint is not marked withheld`).toBeFalsy();
      expect(u.correct_answer, `${w}: U's key is on the wire`).toBe(KEY_U);
      expect(raw, `${w}: the hint of U is in the payload by value`).toContain(HINT_U);
      // `can_edit` and `can_unassign` on U are OWNERSHIP / ASSIGNER answers for an
      // event admin (U was created and assigned by the built-in superadmin, so
      // nobody owns it) — only the global tiers prove the flags are not
      // collapsed by the lock.
      if (a.role !== "event_admin") {
        expect(u.can_edit, `${w}: U is editable`).toBe(true);
        expect(u.can_see_answer, `${w}: U's answer is theirs to read`).toBe(true);
        expect(u.competitions.find(x => x.id === F.id)?.can_unassign, `${w}: U may be taken out of F — the lock is per event`).toBe(true);
      }
    }
    // CONTROLS: the unenrolled twin is NOT locked (nothing in `competing_in`),
    // and what it is refused on T it is refused by the SEAL, somebody else's
    // rule — v8.12.2 sealed the hint with the key, so an unenrolled non-author
    // reads neither, and `hint_withheld` now rides the seal path too. The
    // discriminator between the two rules is `competing_in`, asserted empty.
    // The author reads everything.
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const all = await (await c.api.get("/api/admin/tasks")).json();
      const t = all.find(x => x.id === T.id);
      expect(t.competing_in, `${w}: nothing locks the row`).toEqual([]);
      expect(t.hint, `${w}: the hint is sealed with the key (v8.12.2), so an unenrolled non-author does not read it`).toBeUndefined();
      expect(t.hint_withheld, `${w}: marked withheld — by the seal, not the lock`).toBe(true);
      expect(t.correct_answer, `${w}: the KEY is still sealed — that is the seal's job, not the lock's`).toBeUndefined();
      // `can_unassign` is an ASSIGNER answer for an event admin (the built-in
      // superadmin made this assignment), so only the global twins prove the
      // per-event flag is not collapsed by the lock.
      if (c.role !== "event_admin") expect(t.competitions.find(x => x.id === E.id).can_unassign, `${w}: may take it out of E`).toBe(true);
    }
    const mine = (await (await S2.api.get("/api/admin/tasks")).json()).find(x => x.id === T.id);
    expect(mine.correct_answer, "the author reads the key").toBe(KEY_T);
    expect(mine.hint, "the author reads the hint").toBe(HINT_T);
    expect(mine.can_edit, "the author may edit").toBe(true);
    expect(mine.competing_in).toEqual([]);
  });

  test("the projection collapses a competitor's row where the SEAL cannot be the reason: an unsealed, authorless challenge PLANTED into a compete event", async () => {
    // The doors refuse this state (an event where staff compete admits sealed
    // challenges only), so it is written straight into SQLite — the answer-seal
    // spec's precedent. Own event, own challenge; the SHARED actors are enrolled
    // into it, which changes no answer about E, F, T or U.
    const E7 = await makeCompetition(sa, saCsrf, "planted", { staff_compete: true });
    const HINT7 = `HINTPLANTED_${TAG}`, KEY7 = `KEYPLANTED_${TAG}`, EXPL7 = `WHYPLANTED_${TAG}`;
    const U7 = await makeTask(sa, saCsrf, "planted-plain", { hint: HINT7, correct_answer: KEY7, explanation: `<p>${EXPL7}</p>` });
    for (const ea of [EA, EA2]) await grantEventAdmin(sa, saCsrf, E7.id, ea.id);
    await enrol(sa, saCsrf, E7.id, [A.id, SA.id, EA.id]);
    // The doors really do refuse it first — or the plant proves nothing.
    const door = await sa.post(`/api/admin/tasks/${U7.id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [E7.id] } });
    expect(door.status(), `the assignment door refuses an unsealed challenge into a compete event: ${await door.text()}`).toBe(400);
    expect((await door.json()).code).toBe("staff_compete_unsealed");
    withDb(db => db.prepare("INSERT INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at) VALUES (?,?,?,?)")
      .run(E7.id, U7.id, "planted-by-test", new Date().toISOString()), { readonly: false });
    const t7 = await taskRow(sa, U7.id);
    expect(t7.answer_sealed, "U7 is unsealed").toBeFalsy();
    expect(t7.competitions.map(c => c.id), "U7 is (now) held by E7").toEqual([E7.id]);
    expect(t7.correct_answer, "the built-in reads U7's key — it is not sealed").toBe(KEY7);

    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      expect((await compRow(a.api, E7.id)).competing, `${w} competes in E7`).toBe(true);
      const all = await (await a.api.get("/api/admin/tasks")).json();
      const raw = JSON.stringify(all);
      const u = all.find(x => x.id === U7.id);
      expect(u, `${w} can see U7`).toBeTruthy();
      expect(u.competing_in, `${w}: the row names E7`).toEqual([{ id: E7.id, name: E7.name, status: "live" }]);
      // Every collapsed flag is the LOCK's here — nothing else in the projection
      // refuses an unsealed, authorless challenge to a global admin.
      expect(u.can_edit, `${w}: not editable — the lock alone`).toBe(false);
      expect(u.can_edit_scoring, `${w}: not scoring-editable — the lock alone`).toBe(false);
      expect(u.can_see_answer, `${w}: the answer is not theirs — the lock alone`).toBe(false);
      expect(u.competitions.find(x => x.id === E7.id)?.can_unassign, `${w}: cannot take it out of E7 — the lock alone`).toBe(false);
      expect(u.correct_answer, `${w}: no key`).toBeUndefined();
      expect(u.explanation, `${w}: no explanation`).toBeUndefined();
      expect(u.hint, `${w}: no hint`).toBeUndefined();
      expect(u.hint_withheld, `${w}: the row says the hint is withheld`).toBe(true);
      expect(raw, `${w}: the key of U7 appears nowhere`).not.toContain(KEY7);
      expect(raw, `${w}: the hint of U7 appears nowhere`).not.toContain(HINT7);
      expect(raw, `${w}: the explanation of U7 appears nowhere`).not.toContain(EXPL7);
      // And the write door agrees with the projection.
      await expectLocked(await a.api.put(`/api/admin/tasks/${U7.id}`, { headers: H(a.csrf), data: { title: `hijack ${TAG} planted` } }), `${w} PUT U7`, E7);
    }
    // CONTROLS on the SAME row: the unenrolled twins read every value the
    // competitors were refused, and the global ones may edit it.
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const all = await (await c.api.get("/api/admin/tasks")).json();
      const u = all.find(x => x.id === U7.id);
      expect(u, `${w} can see U7`).toBeTruthy();
      expect(u.competing_in, `${w}: nothing locks U7`).toEqual([]);
      expect(u.can_see_answer, `${w}: the answer is theirs to read`).toBe(true);
      expect(u.correct_answer, `${w}: reads the key`).toBe(KEY7);
      expect(u.hint, `${w}: reads the hint`).toBe(HINT7);
      expect(u.hint_withheld, `${w}: not withheld`).toBeFalsy();
      expect(JSON.stringify(u), `${w}: the explanation rides the row`).toContain(EXPL7);
      if (c.role !== "event_admin") {
        expect(u.can_edit, `${w}: may edit U7`).toBe(true);
        expect(u.can_edit_scoring, `${w}: may edit U7's scoring`).toBe(true);
        expect(u.competitions.find(x => x.id === E7.id)?.can_unassign, `${w}: may take U7 out of E7`).toBe(true);
      }
    }
    const put = await A2.api.put(`/api/admin/tasks/${U7.id}`, { headers: H(A2.csrf), data: { title: `Planted ${TAG} by A2` } });
    expect(put.ok(), `A2 may edit U7: ${put.status()} ${await put.text()}`).toBeTruthy();
    expect((await taskRow(sa, U7.id)).title).toBe(`Planted ${TAG} by A2`);
  });

  test("the version history withholds the hint, the key and the explanation from a competitor — every snapshot, by value; the switch-off event's challenge keeps its hint", async () => {
    // A SECOND version of its own, so "every snapshot" is a plural claim.
    const cur = await taskRow(S2.api, T.id);
    const bump = await S2.api.put(`/api/admin/tasks/${T.id}`, { headers: H(S2.csrf), data: { title: cur.title, description: `<p>v2 ${TAG}</p>`, expectedUpdatedAt: cur.updated_at } });
    expect(bump.ok(), `the author makes a second version: ${bump.status()} ${await bump.text()}`).toBeTruthy();

    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      const r = await a.api.get(`/api/admin/tasks/${T.id}/versions`);
      expect(r.ok(), `${w} may read the history: ${r.status()}`).toBeTruthy();
      const raw = await r.text();
      const snaps = snapshotsOf(JSON.parse(raw));
      expect(snaps.length, `${w}: the history has several versions`).toBeGreaterThanOrEqual(2);
      for (const s of snaps) {
        expect(s.hint, `${w}: a snapshot carries no hint`).toBeUndefined();
        expect(s.correct_answer, `${w}: a snapshot carries no key`).toBeUndefined();
        expect(s.explanation, `${w}: a snapshot carries no explanation`).toBeUndefined();
        expect(s.title, `${w}: the snapshot is otherwise intact`).toBeTruthy();
      }
      expect(raw, `${w}: the hint appears nowhere in the history`).not.toContain(HINT_T);
      expect(raw, `${w}: the key appears nowhere in the history`).not.toContain(KEY_T);
      expect(raw, `${w}: the explanation appears nowhere in the history`).not.toContain(EXPL_T);
      // U, held by F where the same actor HOLDS A ROW with the switch off: the
      // history is not a competitor's, so every snapshot carries the hint.
      expect(rowsFor(a.id).has(F.id), `${a.label} really holds a row on F`).toBe(true);
      const ru = await a.api.get(`/api/admin/tasks/${U.id}/versions`);
      expect(ru.ok(), `${w} may read U's history: ${ru.status()}`).toBeTruthy();
      const rawU = await ru.text();
      const snapsU = snapshotsOf(JSON.parse(rawU));
      expect(snapsU.length, `${w}: U has a history`).toBeGreaterThanOrEqual(1);
      for (const s of snapsU) expect(s.hint, `${w}: U's snapshot carries the hint`).toBe(HINT_U);
      expect(rawU, `${w}: U's hint is in the history by value`).toContain(HINT_U);
    }
    // CONTROLS: the unenrolled twin is refused T's hint in EVERY snapshot by the
    // SEAL (v8.12.2 sealed the hint with the key), never by the lock. So on this
    // SEALED fixture every assertion above is satisfied by the seal alone, and
    // this test no longer witnesses the lock's history branch — the PLANTED test
    // below does, on an unsealed challenge where the seal cannot be the reason.
    // The author reads the key and the hint.
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const raw = await (await c.api.get(`/api/admin/tasks/${T.id}/versions`)).text();
      const snaps = snapshotsOf(JSON.parse(raw));
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      for (const s of snaps) expect(s.hint, `${w}: the sealed hint is withheld from every snapshot (v8.12.2)`).toBeUndefined();
      expect(raw, `${w}: the sealed hint is withheld by value`).not.toContain(HINT_T);
      expect(raw, `${w}: the sealed key is still withheld — by the seal`).not.toContain(KEY_T);
    }
    const mineRaw = await (await S2.api.get(`/api/admin/tasks/${T.id}/versions`)).text();
    expect(mineRaw, "the author's history carries the key").toContain(KEY_T);
    expect(mineRaw, "…and the hint").toContain(HINT_T);
  });

  test("the version history withholds an UNSEALED challenge's hint, key and explanation from a competitor — PLANTED into a compete event, so the seal cannot be the reason; the unenrolled controls read all three in every snapshot", async () => {
    // v8.12.2 put `hint` in SEALED_FIELDS, which made the sealed-fixture test
    // above satisfiable by the seal alone. The lock's history branch
    // (`_competesH` in the versions route) is also the ONLY guard for a
    // superadmin who revealed a challenge and then enrolled in an event holding
    // it, so it needs a witness of its own: the planted-projection shape, one
    // route over. Own event, own challenge, own second version.
    const E8 = await makeCompetition(sa, saCsrf, "planted-hist", { staff_compete: true });
    const HINT8 = `HINTPHIST_${TAG}`, KEY8 = `KEYPHIST_${TAG}`, EXPL8 = `WHYPHIST_${TAG}`;
    const U8 = await makeTask(sa, saCsrf, "planted-hist", { hint: HINT8, correct_answer: KEY8, explanation: `<p>${EXPL8}</p>` });
    const cur = await taskRow(sa, U8.id);
    const bump = await sa.put(`/api/admin/tasks/${U8.id}`, { headers: H(saCsrf), data: { title: cur.title, description: `<p>v2 planted ${TAG}</p>`, expectedUpdatedAt: cur.updated_at } });
    expect(bump.ok(), `a second version: ${bump.status()} ${await bump.text()}`).toBeTruthy();
    for (const ea of [EA, EA2]) await grantEventAdmin(sa, saCsrf, E8.id, ea.id);
    await enrol(sa, saCsrf, E8.id, [A.id, SA.id, EA.id]);
    withDb(db => db.prepare("INSERT INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at) VALUES (?,?,?,?)")
      .run(E8.id, U8.id, "planted-by-test", new Date().toISOString()), { readonly: false });
    const t8 = await taskRow(sa, U8.id);
    expect(t8.answer_sealed, "PRECONDITION: U8 is unsealed").toBeFalsy();
    expect(t8.competitions.map(c => c.id), "PRECONDITION: U8 is held by E8").toEqual([E8.id]);

    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      expect((await compRow(a.api, E8.id)).competing, `${w} competes in E8`).toBe(true);
      const r = await a.api.get(`/api/admin/tasks/${U8.id}/versions`);
      expect(r.ok(), `${w} may read the history: ${r.status()}`).toBeTruthy();
      const raw = await r.text();
      const snaps = snapshotsOf(JSON.parse(raw));
      expect(snaps.length, `${w}: several versions`).toBeGreaterThanOrEqual(2);
      for (const s of snaps) {
        expect(s.hint, `${w}: no hint in a snapshot — the lock alone`).toBeUndefined();
        expect(s.correct_answer, `${w}: no key in a snapshot — the lock alone`).toBeUndefined();
        expect(s.explanation, `${w}: no explanation in a snapshot — the lock alone`).toBeUndefined();
        expect(s.title, `${w}: the snapshot is otherwise intact`).toBeTruthy();
      }
      expect(raw, `${w}: the hint appears nowhere`).not.toContain(HINT8);
      expect(raw, `${w}: the key appears nowhere`).not.toContain(KEY8);
      expect(raw, `${w}: the explanation appears nowhere`).not.toContain(EXPL8);
    }
    // CONTROLS on the SAME history: the unenrolled twins read all three by
    // value, or "withheld" is satisfied by a history that carries none.
    for (const c of controls()) {
      const w = `${c.label} (${c.role}, unenrolled)`;
      const r = await c.api.get(`/api/admin/tasks/${U8.id}/versions`);
      expect(r.ok(), `${w} may read the history: ${r.status()}`).toBeTruthy();
      const raw = await r.text();
      const snaps = snapshotsOf(JSON.parse(raw));
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      for (const s of snaps) {
        expect(s.hint, `${w}: every snapshot carries the hint`).toBe(HINT8);
        expect(s.correct_answer, `${w}: every snapshot carries the key`).toBe(KEY8);
      }
      expect(raw, `${w}: the explanation rides the history`).toContain(EXPL8);
    }
  });

  test("the switch-off twin event is not locked for the SAME actors who hold a row on it, and the built-in superadmin is never a competitor", async () => {
    // F: the actors hold a row there and the switch is off. A real write lands
    // for each tier — the event, and the challenge it holds — while E, in the
    // same breath and from the same session, is still refused: the difference
    // is the switch, not the actor and not the row. A mutation dropping the
    // `staff_compete = 1` term from `competitorIn` fails here.
    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      expect(rowsFor(a.id).has(F.id), `${a.label} really holds a row on F`).toBe(true);
      const name = `Off ${uniq(a.label)}`;
      const put = await a.api.put(`/api/admin/competitions/${F.id}`, { headers: H(a.csrf), data: { name } });
      expect(put.ok(), `${w} may edit F: ${put.status()} ${await put.text()}`).toBeTruthy();
      expect((await compRow(sa, F.id)).name, `${w}: the rename of F took`).toBe(name);
      const tag = `off-${TAG}-${a.label}`.toLowerCase();
      const tg = await a.api.post(`/api/admin/competitions/${F.id}/tags`, { headers: H(a.csrf), data: { tag } });
      expect(tg.ok(), `${w} may tag F: ${tg.status()} ${await tg.text()}`).toBeTruthy();
      expect((await a.api.delete(`/api/admin/competitions/${F.id}/tags/${encodeURIComponent(tag)}`, { headers: H(a.csrf) })).ok(), `${w} may untag F`).toBeTruthy();
      await expectLocked(await a.api.put(`/api/admin/competitions/${E.id}`, { headers: H(a.csrf), data: { validate_only: true } }), `${w} PUT E`, E);
      // The challenge F holds: a tag round-trips for the global tiers (U is
      // owned by nobody, so the event-admin tier meets ownership there).
      if (a.role !== "event_admin") {
        const ut = `u-${TAG}-${a.label}`.toLowerCase();
        const utg = await a.api.post(`/api/admin/tasks/${U.id}/tags`, { headers: H(a.csrf), data: { tag: ut } });
        expect(utg.ok(), `${w} may tag U (held by F): ${utg.status()} ${await utg.text()}`).toBeTruthy();
        expect((await taskRow(sa, U.id)).tags, `${w}: the tag on U landed`).toContain(ut);
        expect((await a.api.delete(`/api/admin/tasks/${U.id}/tags/${encodeURIComponent(ut)}`, { headers: H(a.csrf) })).ok(), `${w} may untag U`).toBeTruthy();
        await expectLocked(await a.api.post(`/api/admin/tasks/${T.id}/tags`, { headers: H(a.csrf), data: { tag: ut } }), `${w} POST T/tags (same session)`, E);
      }
    }
    // THE SESSION DOORS, REACHED (LOCK-8). The competition-doors test proves the
    // lock precedes the slot lookup on PUT / DELETE / end-now / bulk-delete, but
    // nothing there ever REACHES those four as a row-holder — so a door-local
    // predicate that refused any row-holder regardless of the switch would fail
    // nothing. Real sessions are created on F by the built-in and each actor,
    // who HOLDS A ROW on F, drives a real write through every door; the sessions
    // are deleted afterwards so F is single-slot again for the tests below.
    const slotOnF = async (label) => {
      const d = await expectOk(await sa.post(`/api/admin/competitions/${F.id}/timeslots`, { headers: H(saCsrf), data: { name: `S ${uniq(label)}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } }), `built-in creates session ${label} on F`);
      return d.timeslot;
    };
    const slotsOnF = async () => (await (await sa.get(`/api/admin/competitions/${F.id}/timeslots`)).json());
    try {
      for (const a of actors()) {
        const w = `${a.label} (${a.role})`;
        expect(rowsFor(a.id).has(F.id), `${a.label} really holds a row on F`).toBe(true);
        const s1 = await slotOnF(`put-${a.label}`);
        const renamed = `S ${uniq(`ren-${a.label}`)}`;
        await expectOk(await a.api.put(`/api/admin/competitions/${F.id}/timeslots/${s1.id}`, { headers: H(a.csrf), data: { name: renamed } }), `${w} may rename a session on F`);
        expect((await slotsOnF()).find(s => s.id === s1.id)?.name, `${w}: the session rename took`).toBe(renamed);
        // end-now on a session that does not exist reaches the LOOKUP — its own
        // 404, past the lock and past the scope gate. (Ending a real slot would
        // end F under the tests below; the door being reached is the claim.)
        const en = await a.api.post(`/api/admin/competitions/${F.id}/timeslots/no-such-slot/end-now`, { headers: H(a.csrf) });
        expect(en.status(), `${w} end-now reaches the slot lookup on F: ${await en.text()}`).toBe(404);
        expect((await en.json()).error, `${w}: the 404 is the slot's`).toMatch(/session not found/i);
        await expectOk(await a.api.delete(`/api/admin/competitions/${F.id}/timeslots/${s1.id}`, { headers: H(a.csrf) }), `${w} may delete a session on F`);
        expect((await slotsOnF()).find(s => s.id === s1.id), `${w}: the session is gone`).toBeUndefined();
        const s2 = await slotOnF(`bulk-${a.label}`);
        const bd = await expectOk(await a.api.post(`/api/admin/competitions/${F.id}/timeslots/bulk-delete`, { headers: H(a.csrf), data: { timeslotIds: [s2.id] } }), `${w} may bulk-delete a session on F`);
        expect(bd.deleted, `${w}: the bulk delete reports exactly one deletion`).toBe(1);
        expect((await slotsOnF()).find(s => s.id === s2.id), `${w}: the bulk-deleted session is gone`).toBeUndefined();
        // …while E, from the same session, is still refused at the same doors.
        await expectLocked(await a.api.put(`/api/admin/competitions/${E.id}/timeslots/no-such-slot`, { headers: H(a.csrf), data: { name: "x" } }), `${w} PUT E/timeslots/:ts (same session)`, E);
      }
      // The unenrolled twins on E: bulk-delete of a phantom id reaches the
      // slot lookup (its own 404, carrying the id), never the lock.
      for (const c of controls()) {
        const w = `${c.label} (${c.role}, unenrolled)`;
        const bd = await c.api.post(`/api/admin/competitions/${E.id}/timeslots/bulk-delete`, { headers: H(c.csrf), data: { timeslotIds: ["no-such-slot"] } });
        const nl = await expectNotLocked(bd, `${w} bulk-delete E/timeslots`, [404]);
        expect(nl.body.timeslotId, `${w}: the 404 names the phantom slot`).toBe("no-such-slot");
      }
    } finally {
      for (const s of await slotsOnF()) await sa.delete(`/api/admin/competitions/${F.id}/timeslots/${s.id}`, { headers: H(saCsrf) }).catch(() => {});
    }
    expect((await slotsOnF()).length, "F is single-slot again").toBe(0);
    // The BUILT-IN superadmin has no users row, so it can hold no competition_users
    // row, so it can never be locked — stated, and driven.
    const e = await compRow(sa, E.id);
    expect(e.competing, "the built-in superadmin does not compete in E").toBe(false);
    const dry = await sa.put(`/api/admin/competitions/${E.id}`, { headers: H(saCsrf), data: { validate_only: true } });
    expect(dry.ok(), `the built-in superadmin may save E: ${dry.status()} ${await dry.text()}`).toBeTruthy();
    const tag = `builtin-${TAG}`.toLowerCase();
    const add = await sa.post(`/api/admin/competitions/${E.id}/tags`, { headers: H(saCsrf), data: { tag } });
    expect(add.ok(), `the built-in superadmin may tag E: ${add.status()} ${await add.text()}`).toBeTruthy();
    const del = await sa.delete(`/api/admin/competitions/${E.id}/tags/${encodeURIComponent(tag)}`, { headers: H(saCsrf) });
    expect(del.ok(), `…and untag it: ${del.status()} ${await del.text()}`).toBeTruthy();
    const put = await sa.put(`/api/admin/tasks/${U.id}`, { headers: H(saCsrf), data: { title: `Plain ${TAG} by builtin` } });
    expect(put.ok(), `the built-in superadmin may edit U: ${put.status()} ${await put.text()}`).toBeTruthy();
  });

  test("status and kind: the lock binds an UPCOMING compete event on every open door, outlives an ENDED one (ahead of the ended refusal — and self-removal is refused there), and a Booth Event and a Program alike", async () => {
    const Pu = await makeParticipant(sa, saCsrf, "status-p");
    // ── UPCOMING ── the doors that are only open before the start.
    const Eup = await makeCompetition(sa, saCsrf, "upcoming", { staff_compete: true, start_time: new Date(Date.now() + 3600_000).toISOString() });
    await grantEventAdmin(sa, saCsrf, Eup.id, EA.id);         // the assign door answers the SCOPE first (stated), so EA organises it
    await enrol(sa, saCsrf, Eup.id, [A.id, SA.id, EA.id]);
    const upBefore = await compRow(sa, Eup.id);
    expect(upBefore.status, "the fixture is upcoming").toBe("upcoming");
    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      expect(rowsFor(a.id).has(Eup.id), `${w} holds a row on the upcoming event`).toBe(true);
      expect((await compRow(a.api, Eup.id))?.competing, `${w} competes in the upcoming event`).toBe(true);
      await expectLocked(await a.api.put(`/api/admin/competitions/${Eup.id}`, { headers: H(a.csrf), data: { name: `hijack ${TAG} up` } }), `${w} PUT Eup (name)`, Eup);
      await expectLocked(await a.api.put(`/api/admin/competitions/${Eup.id}`, { headers: H(a.csrf), data: { start_time: new Date(Date.now() + 7200_000).toISOString() } }), `${w} PUT Eup (start time)`, Eup);
      await expectLocked(await a.api.put(`/api/admin/competitions/${Eup.id}`, { headers: H(a.csrf), data: { event_kind: "booth" } }), `${w} PUT Eup (kind change)`, Eup);
      await expectLocked(await a.api.post(`/api/admin/competitions/${Eup.id}/timeslots`, { headers: H(a.csrf), data: { name: "s1", start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } }), `${w} POST Eup/timeslots`, Eup);
      await expectLocked(await a.api.post("/api/admin/competitions/assign", { headers: H(a.csrf), data: { userIds: [Pu.id], competitionIds: [Eup.id] } }), `${w} assign into Eup`, Eup);
    }
    await expectLocked(await SA.api.delete(`/api/admin/competitions/${Eup.id}`, { headers: H(SA.csrf) }), "SA DELETE Eup", Eup);
    const upAfter = await compRow(sa, Eup.id);
    expect(upAfter, "Eup still exists").toBeTruthy();
    expect(upAfter.name).toBe(upBefore.name);
    expect(upAfter.start_time).toBe(upBefore.start_time);
    expect(upAfter.event_kind, "the kind did not move").toBe(upBefore.event_kind);
    expect(upAfter.updated_at, "no write bumped Eup").toBe(upBefore.updated_at);
    expect(rowsFor(Pu.id).has(Eup.id), "Pu was not enrolled").toBe(false);
    expect((await (await sa.get(`/api/admin/competitions/${Eup.id}/timeslots`)).json()).length, "no session was created").toBe(0);
    // CONTROL: the unenrolled twin renames the upcoming event.
    const upName = `Up ${uniq("twin")}`;
    const upPut = await A2.api.put(`/api/admin/competitions/${Eup.id}`, { headers: H(A2.csrf), data: { name: upName } });
    expect(upPut.ok(), `A2 may edit Eup: ${upPut.status()} ${await upPut.text()}`).toBeTruthy();
    expect((await compRow(sa, Eup.id)).name).toBe(upName);

    // ── ENDED ── built live, enrolled, then ended (an ended event refuses the
    // assign, so the order is forced).
    const Eend = await makeCompetition(sa, saCsrf, "ended", { staff_compete: true });
    await grantEventAdmin(sa, saCsrf, Eend.id, EA.id);
    await enrol(sa, saCsrf, Eend.id, [A.id, SA.id, EA.id]);
    // A sealed challenge held by the ended event: the lock on a CHALLENGE
    // outlives the event too ("locked out of it and of its challenges for
    // good"), and its refusal reads the same remedy resolver. Assigned BEFORE
    // the end — an ended event refuses the assignment.
    const Tend = await makeTask(S2.api, S2.csrf, "ended-sealed", { answer_sealed: true, hint: "h", correct_answer: "k" });
    await assignTask(sa, saCsrf, Tend.id, [Eend.id]);
    await expectOk(await sa.post(`/api/admin/competitions/${Eend.id}/end-now`, { headers: H(saCsrf) }), "end Eend");
    const endBefore = await compRow(sa, Eend.id);
    expect(endBefore.status, "the fixture has ended").toBe("ended");
    const tendBefore = await taskRow(S2.api, Tend.id);
    for (const a of actors()) {
      const w = `${a.label} (${a.role})`;
      expect(rowsFor(a.id).has(Eend.id), `${w} still holds a row on the ended event`).toBe(true);
      expect((await compRow(a.api, Eend.id))?.competing, `${w} still competes in the ended event — the lock is keyed on the row at any status`).toBe(true);
      // The LOCK, not "Cannot change the name of an ended event" and not "Only
      // superadmin can change tags on ended events" — and THE HONEST REMEDY
      // (round-3 fix (d)): self-removal is refused below, so the refusal must
      // not offer it. `remedy:"ended"` asserts the clause in BOTH directions;
      // the live-event doors above carry `remedy:"self"` as its control.
      await expectLocked(await a.api.put(`/api/admin/competitions/${Eend.id}`, { headers: H(a.csrf), data: { name: `hijack ${TAG} ended` } }), `${w} PUT Eend`, Eend, { remedy: "ended" });
      await expectLocked(await a.api.post(`/api/admin/competitions/${Eend.id}/tags`, { headers: H(a.csrf), data: { tag: `ended-${a.label}` } }), `${w} POST Eend/tags`, Eend, { remedy: "ended" });
      // The challenge the ended event holds: locked for good, with the same
      // honest clause (the task-side resolver has no status term — stated).
      await expectLocked(await a.api.put(`/api/admin/tasks/${Tend.id}`, { headers: H(a.csrf), data: { title: `hijack ${TAG} ended-task` } }), `${w} PUT Tend (held by the ended event)`, Eend, { remedy: "ended" });
      expect((await taskRow(a.api, Tend.id)).competing_in, `${w}: Tend's row still names the ended event — WITH its status, which is what lets the editor's note drop the self-removal clause there`).toEqual([{ id: Eend.id, name: Eend.name, status: "ended" }]);
      // THE STATED DISPOSITION (v8.12.0): the escape hatch is the ended-event
      // membership rule's to refuse — a competitor in a finished compete event
      // stays locked out of it, and another organiser edits it.
      const self = await a.api.delete(`/api/admin/competitions/${Eend.id}/users/${a.id}`, { headers: H(a.csrf) });
      expect(self.status(), `${w}: self-removal from an ended event is refused by the ended rule: ${await self.text()}`).toBe(400);
      expect((await self.json()).error).toMatch(/ended/i);
      expect(rowsFor(a.id).has(Eend.id), `${w}: the row survives`).toBe(true);
    }
    expect((await compRow(sa, Eend.id)).name).toBe(endBefore.name);
    expect((await compRow(sa, Eend.id)).tags).toEqual(endBefore.tags);
    expect((await taskRow(S2.api, Tend.id)).title, "Tend's title did not move").toBe(tendBefore.title);
    // CONTROL on the task: the unenrolled superadmin twin meets the SEAL, not the lock.
    const sa2Tend = await SA2.api.put(`/api/admin/tasks/${Tend.id}`, { headers: H(SA2.csrf), data: { title: `twin ${TAG} ended-task` } });
    const sa2t = await expectNotLocked(sa2Tend, "SA2 PUT Tend", [403]);
    expect(sa2t.body.code, "the twin is refused by the seal, a rule of its own").toBe("answer_sealed_not_author");
    // CONTROLS: the unenrolled twins meet the ENDED rules — a different reason
    // each, and the superadmin twin's tag lands.
    const a2End = await A2.api.put(`/api/admin/competitions/${Eend.id}`, { headers: H(A2.csrf), data: { name: `twin ${TAG} ended` } });
    const a2b = await expectNotLocked(a2End, "A2 PUT Eend");
    expect(a2b.status, "an admin twin is refused by the ended rule").toBe(403);
    expect(a2b.body.error).toMatch(/ended/i);
    const sa2End = await SA2.api.put(`/api/admin/competitions/${Eend.id}`, { headers: H(SA2.csrf), data: { name: `twin ${TAG} ended` } });
    const sa2b = await expectNotLocked(sa2End, "SA2 PUT Eend");
    expect(sa2b.status, "a superadmin twin is refused the rename by the ended rule").toBe(400);
    expect(sa2b.body.error).toMatch(/ended/i);
    const endTag = `ended-twin-${TAG}`.toLowerCase();
    await expectOk(await SA2.api.post(`/api/admin/competitions/${Eend.id}/tags`, { headers: H(SA2.csrf), data: { tag: endTag } }), "SA2 may tag the ended event");
    expect((await compRow(sa, Eend.id)).tags).toContain(endTag);
    await expectOk(await SA2.api.delete(`/api/admin/competitions/${Eend.id}/tags/${encodeURIComponent(endTag)}`, { headers: H(SA2.csrf) }), "SA2 may untag it");

    // ── KINDS ── the switch is universal: a Booth Event and a Program lock alike.
    const Ebooth = await makeCompetition(sa, saCsrf, "booth", { event_kind: "booth", staff_compete: true });
    const Eprog  = await makeProgram(sa, saCsrf, "program", { staff_compete: true });
    for (const k of [Ebooth, Eprog]) {
      await enrol(sa, saCsrf, k.id, [A.id]);
      const row = await compRow(A.api, k.id);
      expect(row?.staff_compete, `${k.name}: the switch is on`).toBeTruthy();
      expect(row?.competing, `A competes in ${k.name}`).toBe(true);
      await expectLocked(await A.api.put(`/api/admin/competitions/${k.id}`, { headers: H(A.csrf), data: { name: `hijack ${TAG} kind` } }), `A PUT ${k.name}`, k);
      const kName = `Kind ${uniq("twin")}`;
      const kPut = await A2.api.put(`/api/admin/competitions/${k.id}`, { headers: H(A2.csrf), data: { name: kName } });
      expect(kPut.ok(), `A2 may edit ${k.name}: ${kPut.status()} ${await kPut.text()}`).toBeTruthy();
      expect((await compRow(sa, k.id)).name).toBe(kName);
    }
  });

  test("the group doors — the lock's TRANSITIVE door: five membership doors, the bind, the unbind and invitation groups — 403 for every tier, nothing moved; a group bound only to a switch-off event, a rename and a seeded create still work", async () => {
    // Own world. E8 (switch on) and F8 (switch off); the SHARED actors compete in
    // E8 and hold no row on F8. G1 is bound to E8 and holds P8; G2 is bound to F8.
    // Both groups are CREATED by the event admin (a group's delete is
    // creator-only for that tier) and bound by the built-in superadmin, which
    // can never be a competitor.
    const E8 = await makeCompetition(sa, saCsrf, "grp-on", { staff_compete: true });
    const F8 = await makeCompetition(sa, saCsrf, "grp-off");
    for (const ea of [EA]) { await grantEventAdmin(sa, saCsrf, E8.id, ea.id); await grantEventAdmin(sa, saCsrf, F8.id, ea.id); }
    const P8 = await makeParticipant(sa, saCsrf, "grp-member");   // in E8 and in G1 — the removal target
    const P6 = await makeParticipant(sa, saCsrf, "grp-add");      // in F8 (so the event admin can SEE it) — the add target
    await enrol(sa, saCsrf, E8.id, [P8.id, A.id, SA.id, EA.id]);
    await enrol(sa, saCsrf, F8.id, [P6.id]);
    const mkGroup = async (who, label, userIds = []) => {
      const d = await expectOk(await who.api.post("/api/admin/groups", { headers: H(who.csrf), data: { name: `LG ${uniq(label)}`, userIds } }), `${who.label} creates group ${label}`);
      return d.group;
    };
    const bind = async (who, gid, cid) => {
      const d = await expectOk(await who.api.post("/api/admin/competitions/assign", { headers: H(who.csrf), data: { groupIds: [gid], competitionIds: [cid] } }), `${who.label} binds ${gid} → ${cid}`);
      expect(d.groupsBound, `${who.label}: the bind happened`).toBe(1);
    };
    const G1 = await mkGroup(EA, "g1", [P8.id]);
    const G2 = await mkGroup(EA, "g2");
    await bind({ api: sa, csrf: saCsrf, label: "built-in" }, G1.id, E8.id);
    await bind({ api: sa, csrf: saCsrf, label: "built-in" }, G2.id, F8.id);
    const g1Before = await (await sa.get(`/api/admin/groups/${G1.id}/members`)).json();
    // PRECONDITIONS, asserted rather than assumed.
    expect(groupMember(G1.id, P8.id), "P8 is in G1").toBe(true);
    expect(groupBound(G1.id, E8.id), "G1 is bound to E8").toBe(true);
    expect(groupBound(G2.id, F8.id), "G2 is bound to F8").toBe(true);
    expect(groupBound(G2.id, E8.id), "G2 is NOT bound to E8").toBe(false);
    for (const a of actors()) expect((await compRow(a.api, E8.id))?.competing, `${a.label} competes in E8`).toBe(true);
    const invEmail = (who, n) => `grp-${TAG}-${who}-${n}@acme.com`;
    try {
      for (const a of actors()) {
        const w = `${a.label} (${a.role})`;
        // An event admin must name an event on an invitation; F8 is theirs and
        // not a compete event, so the only refusal left to hear is the GROUP's.
        const invComps = a.role === "event_admin" ? [F8.id] : [];
        // The five membership doors.
        await expectLocked(await a.api.post(`/api/admin/groups/${G1.id}/members`, { headers: H(a.csrf), data: { userIds: [P6.id] } }), `${w} POST G1/members`, E8);
        expect(groupMember(G1.id, P6.id), `${w}: P6 was not added to G1`).toBe(false);
        expect(rowsFor(P6.id).has(E8.id), `${w}: …and was not synced into E8`).toBe(false);
        await expectLocked(await a.api.delete(`/api/admin/groups/${G1.id}/members/${P8.id}`, { headers: H(a.csrf) }), `${w} DELETE G1/members/P8`, E8);
        expect(groupMember(G1.id, P8.id), `${w}: P8 is still in G1`).toBe(true);
        await expectLocked(await a.api.delete(`/api/admin/groups/${G1.id}`, { headers: H(a.csrf) }), `${w} DELETE G1`, E8);
        expect(groupExists(G1.id), `${w}: G1 still exists`).toBe(true);
        expect(groupBound(G1.id, E8.id), `${w}: …and is still bound to E8`).toBe(true);
        await expectLocked(await a.api.post(`/api/admin/participants/${P6.id}/groups`, { headers: H(a.csrf), data: { groupId: G1.id } }), `${w} POST participants/P6/groups {G1}`, E8);
        expect(groupMember(G1.id, P6.id), `${w}: P6 was not chipped into G1`).toBe(false);
        await expectLocked(await a.api.delete(`/api/admin/participants/${P8.id}/groups/${G1.id}`, { headers: H(a.csrf) }), `${w} DELETE participants/P8/groups/G1`, E8);
        expect(groupMember(G1.id, P8.id), `${w}: P8 is still in G1 (chip)`).toBe(true);
        // Invitation groups: a group the invitation would apply.
        await expectLocked(await a.api.post("/api/admin/invitations", { headers: H(a.csrf), data: { emails: [invEmail(a.label, 1)], competitionIds: invComps, groupIds: [G1.id] } }), `${w} invite with groupIds [G1]`, E8);
        expect(withDb(db => db.prepare("SELECT 1 FROM invitations WHERE email=?").get(invEmail(a.label, 1))), `${w}: the refused invitation wrote no row`).toBeUndefined();
        // ROUND-3 FIX (b): a `newGroups` NAME that resolves to an EXISTING group
        // bound to the event the actor competes in is asked about BEFORE the
        // create loop runs. The invitee is an EXISTING user (that is the path
        // that WRITES — membership, then a live-sync into E8), and the brand-new
        // name comes FIRST in the array, so the ordering is the whole claim: an
        // ask inside the create loop would have created it before refusing G1.
        // G1's name is read live — the rename control below moves it per actor.
        const g1Name = (await (await sa.get(`/api/admin/groups/${G1.id}/members`)).json()).name;
        const brandNew = `LG ${uniq(`new-${a.label}`)}`;
        await expectLocked(await a.api.post("/api/admin/invitations", { headers: H(a.csrf), data: { emails: [P6.email], competitionIds: invComps, newGroups: [brandNew, g1Name] } }), `${w} invite EXISTING P6 with newGroups [brand-new, G1's name]`, E8);
        expect(groupByName(brandNew), `${w}: the earlier NAME was not created before the later name's refusal`).toBeUndefined();
        expect(groupMember(G1.id, P6.id), `${w}: P6 was not applied into G1 by name`).toBe(false);
        expect(rowsFor(P6.id).has(E8.id), `${w}: …and was not synced into E8`).toBe(false);
        // The bind and the unbind — competition doors, with a real group.
        await expectLocked(await a.api.post("/api/admin/competitions/assign", { headers: H(a.csrf), data: { groupIds: [G2.id], competitionIds: [E8.id] } }), `${w} bind G2 → E8`, E8);
        expect(groupBound(G2.id, E8.id), `${w}: G2 was not bound to E8`).toBe(false);
        await expectLocked(await a.api.delete(`/api/admin/competitions/${E8.id}/groups/${G1.id}`, { headers: H(a.csrf) }), `${w} unbind G1 from E8`, E8);
        expect(groupBound(G1.id, E8.id), `${w}: G1 is still bound to E8`).toBe(true);
        expect((await (await sa.get(`/api/admin/groups/${G1.id}/members`)).json()).members.map(m => m.id).sort(), `${w}: G1's membership is as it was`).toEqual(g1Before.members.map(m => m.id).sort());

        // CONTROLS, the same actor. (a) A rename changes no membership and is
        // deliberately NOT gated.
        const renamed = `LG ${uniq(`ren-${a.label}`)}`;
        await expectOk(await a.api.put(`/api/admin/groups/${G1.id}`, { headers: H(a.csrf), data: { name: renamed } }), `${w} may rename G1`);
        expect((await (await sa.get(`/api/admin/groups/${G1.id}/members`)).json()).name, `${w}: the rename took`).toBe(renamed);
        // (b) G2, bound only to the switch-off event: every door works.
        await expectOk(await a.api.post(`/api/admin/groups/${G2.id}/members`, { headers: H(a.csrf), data: { userIds: [P6.id] } }), `${w} may add P6 to G2`);
        expect(groupMember(G2.id, P6.id), `${w}: P6 is in G2`).toBe(true);
        await expectOk(await a.api.delete(`/api/admin/groups/${G2.id}/members/${P6.id}`, { headers: H(a.csrf) }), `${w} may remove P6 from G2`);
        expect(groupMember(G2.id, P6.id), `${w}: P6 left G2`).toBe(false);
        await expectOk(await a.api.post(`/api/admin/participants/${P6.id}/groups`, { headers: H(a.csrf), data: { groupId: G2.id } }), `${w} may chip P6 into G2`);
        expect(groupMember(G2.id, P6.id), `${w}: P6 is in G2 (chip)`).toBe(true);
        await expectOk(await a.api.delete(`/api/admin/participants/${P6.id}/groups/${G2.id}`, { headers: H(a.csrf) }), `${w} may un-chip P6 from G2`);
        expect(groupMember(G2.id, P6.id), `${w}: P6 left G2 (chip)`).toBe(false);
        await expectOk(await a.api.post("/api/admin/invitations", { headers: H(a.csrf), data: { emails: [invEmail(a.label, 2)], competitionIds: [F8.id], groupIds: [G2.id] } }), `${w} may invite with groupIds [G2]`);
        expect(withDb(db => db.prepare("SELECT 1 FROM invitations WHERE email=?").get(invEmail(a.label, 2))), `${w}: the invitation row exists`).toBeTruthy();
        // …and the `newGroups` path, naming G2 (bound only to F8) beside a
        // brand-new name: both apply to the existing invitee — the group is
        // created, the invitee lands in both, and the membership is put back.
        const brandNew2 = `LG ${uniq(`new2-${a.label}`)}`;
        await expectOk(await a.api.post("/api/admin/invitations", { headers: H(a.csrf), data: { emails: [P6.email], competitionIds: invComps, newGroups: [brandNew2, G2.name] } }), `${w} may invite P6 with newGroups [brand-new, G2's name]`);
        const gNew = groupByName(brandNew2);
        expect(gNew, `${w}: the brand-new group was created`).toBeTruthy();
        expect(groupMember(gNew.id, P6.id), `${w}: P6 is in the brand-new group`).toBe(true);
        expect(groupMember(G2.id, P6.id), `${w}: P6 was applied into G2 by name`).toBe(true);
        await expectOk(await a.api.delete(`/api/admin/participants/${P6.id}/groups/${G2.id}`, { headers: H(a.csrf) }), `${w} puts G2's membership back`);
        expect(groupMember(G2.id, P6.id), `${w}: P6 left G2 again`).toBe(false);
        await expectOk(await sa.delete(`/api/admin/groups/${gNew.id}`, { headers: H(saCsrf) }), "the built-in removes the brand-new group");
        // (c) A seeded create is bound to nothing, so it never reaches the lock;
        // the same actor then binds it to the switch-off event and deletes it.
        const Gd = await mkGroup(a, `own-${a.label}`, [P6.id]);
        expect(groupMember(Gd.id, P6.id), `${w}: the seed landed`).toBe(true);
        await bind(a, Gd.id, F8.id);
        expect(groupBound(Gd.id, F8.id), `${w}: their group is bound to F8`).toBe(true);
        await expectOk(await a.api.delete(`/api/admin/groups/${Gd.id}`, { headers: H(a.csrf) }), `${w} may delete their own group`);
        expect(groupExists(Gd.id), `${w}: their group is gone`).toBe(false);
      }

      // THE SHIPPED ORDERING ON THE GROUP DOORS, PINNED (LOCK-7). Every
      // group-side door asks the event-admin SCOPE (`groupWriteDenied` /
      // `groupDeleteDenied`, behind `participantDenied` on the chip pair)
      // BEFORE `competitorGroupDenied` — the opposite of the competition doors,
      // and NOT one of the three body-scoped roster doors the header names. So
      // an event admin competing in a compete event they do NOT organise, whose
      // group is also bound to that event, hears the scope reason on all five
      // doors, while a global competitor on the same group hears the lock.
      // Pinned so that moving the ask is a decision, not a drift; the map
      // (CLAUDE.md, "three doors") does not describe this and is reported.
      const E9 = await makeCompetition(sa, saCsrf, "grp-far", { staff_compete: true });
      await enrol(sa, saCsrf, E9.id, [A.id, SA.id, EA.id]);          // EA competes in E9 but does not organise it
      // An event admin's competitions list is SCOPED, so E9 is not in EA's list
      // at all — the row is read off the table and the switch off the built-in's view.
      expect(rowsFor(EA.id).has(E9.id), "EA holds a row on E9").toBe(true);
      expect((await compRow(sa, E9.id))?.staff_compete, "E9 lets staff compete").toBeTruthy();
      expect((await compRow(A.api, E9.id))?.competing, "A (global) competes in E9").toBe(true);
      const org9 = await expectOk(await sa.get(`/api/admin/competitions/${E9.id}/admins`), "E9's organiser list");
      expect(org9.admins.map(o => o.id), "EA does not organise E9 (the precondition of the scope answer)").not.toContain(EA.id);
      await bind({ api: sa, csrf: saCsrf, label: "built-in" }, G1.id, E9.id);
      expect(groupBound(G1.id, E9.id), "G1 is now also bound to E9").toBe(true);
      const SHARED = "event_admin_group_shared";
      const scopeFirst = async (res, what) => {
        const nl = await expectNotLocked(res, what, [403]);
        expect(nl.body.code, `${what}: the SCOPE answers ahead of the lock on the group doors`).toBe(SHARED);
      };
      await scopeFirst(await EA.api.post(`/api/admin/groups/${G1.id}/members`, { headers: H(EA.csrf), data: { userIds: [P6.id] } }), "EA POST G1/members (G1 also bound to E9)");
      expect(groupMember(G1.id, P6.id), "P6 was not added").toBe(false);
      await scopeFirst(await EA.api.delete(`/api/admin/groups/${G1.id}/members/${P8.id}`, { headers: H(EA.csrf) }), "EA DELETE G1/members/P8");
      expect(groupMember(G1.id, P8.id), "P8 is still in G1").toBe(true);
      await scopeFirst(await EA.api.delete(`/api/admin/groups/${G1.id}`, { headers: H(EA.csrf) }), "EA DELETE G1 (creator, shared)");
      expect(groupExists(G1.id), "G1 still exists").toBe(true);
      await scopeFirst(await EA.api.post(`/api/admin/participants/${P6.id}/groups`, { headers: H(EA.csrf), data: { groupId: G1.id } }), "EA POST participants/P6/groups {G1}");
      expect(groupMember(G1.id, P6.id), "P6 was not chipped in").toBe(false);
      await scopeFirst(await EA.api.delete(`/api/admin/participants/${P8.id}/groups/${G1.id}`, { headers: H(EA.csrf) }), "EA DELETE participants/P8/groups/G1");
      expect(groupMember(G1.id, P8.id), "P8 is still in G1 (chip)").toBe(true);
      // The global competitor on the SAME group hears the lock — on E8 or E9,
      // whichever binding the query yields first.
      await expectLockedOneOf(await A.api.post(`/api/admin/groups/${G1.id}/members`, { headers: H(A.csrf), data: { userIds: [P6.id] } }), "A POST G1/members (bound to two compete events)", [E8, E9]);
      expect(groupMember(G1.id, P6.id), "P6 was not added by A either").toBe(false);
    } finally {
      for (const g of [G1, G2]) await sa.delete(`/api/admin/groups/${g.id}`, { headers: H(saCsrf) }).catch(() => {});
    }
  });

  test("the feedback purge is a competitor door: a competing superadmin may purge neither one rating nor all of them; the unenrolled superadmin may, and does", async () => {
    // P (an ordinary participant of E) rates T; the purge is superadmin-only, so
    // SA is the only reachable competitor and SA2 the control.
    const { api: pApi, csrf: pCsrf } = await apiLogin(P.email, PARTICIPANT_PASS);
    try {
      const rate = async () => {
        await expectOk(await pApi.post("/api/select-competition", { headers: H(pCsrf), data: { competitionId: E.id } }), "P enters E");
        await expectOk(await pApi.put(`/api/tasks/${T.id}/feedback`, { headers: H(pCsrf), data: { rating: 4 } }), "P rates T");
        expect(feedbackRow(P.id, T.id), "the rating is stored").toBe(true);
      };
      await rate();
      await expectLocked(await SA.api.delete(`/api/admin/tasks/${T.id}/feedback`, { headers: H(SA.csrf) }), "SA purge T's feedback", E);
      expect(feedbackRow(P.id, T.id), "the rating survives the refused purge").toBe(true);
      await expectLocked(await SA.api.delete(`/api/admin/tasks/${T.id}/feedback/${P.id}`, { headers: H(SA.csrf) }), "SA delete P's rating on T", E);
      expect(feedbackRow(P.id, T.id), "the rating survives the refused delete").toBe(true);
      // CONTROLS: the unenrolled superadmin, both doors.
      await expectOk(await SA2.api.delete(`/api/admin/tasks/${T.id}/feedback/${P.id}`, { headers: H(SA2.csrf) }), "SA2 may delete P's rating");
      expect(feedbackRow(P.id, T.id), "the rating is gone").toBe(false);
      await rate();
      const purged = await expectOk(await SA2.api.delete(`/api/admin/tasks/${T.id}/feedback`, { headers: H(SA2.csrf) }), "SA2 may purge T's feedback");
      expect(purged.deleted, "the purge removed the one rating").toBe(1);
      expect(feedbackRow(P.id, T.id), "the rating is gone again").toBe(false);
    } finally {
      await pApi.dispose();
    }
  });

  // ── PRODUCT DEFECTS FOUND WHILE WRITING THIS ────────────────────────────────
  // Every arm below was driven RED against the first draft with its `fixme`
  // lifted (in a throwaway copy), so it is aimed. LOCK-5 and LOCK-6 were fixed
  // in the same release and hold; LOCK-3 and LOCK-4 keep their `fixme` pending
  // the operator's decision (the header names both).

  test("(LOCK-5, fixed): an event admin competing in an event they do NOT organise can take the exit the refusal names — self-removal — and the task-side lock lifts with it", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // `DELETE …/users/:uid` with `uid === actorId` is the self-removal
    // carve-out, and it now bypasses `competitionDenied` as well as the lock —
    // the exit the refusal names must be open to the person it names it to.
    // Ex: organised by EAx. Ey: a compete event EAx COMPETES in but does not
    // organise. Tx is sealed (author S2, enrolled nowhere) and held by BOTH.
    const Ex = await makeCompetition(sa, saCsrf, "escape-mine", { staff_compete: true });
    const Ey = await makeCompetition(sa, saCsrf, "escape-far",  { staff_compete: true });
    const Tx = await makeTask(S2.api, S2.csrf, "escape-sealed", { answer_sealed: true, hint: "h", correct_answer: "k" });
    await assignTask(sa, saCsrf, Tx.id, [Ex.id, Ey.id]);
    const EAx = await makeEventAdmin(sa, saCsrf, "escape-ea", [Ex.id]);
    const Py  = await makeParticipant(sa, saCsrf, "escape-p");
    await enrol(sa, saCsrf, Ey.id, [EAx.id, Py.id]);
    try {
      // EAx's competitions list is scoped to Ex, so Ey is read off the table
      // and the built-in's view.
      expect(rowsFor(EAx.id).has(Ey.id), "EAx holds a row on Ey").toBe(true);
      expect((await compRow(sa, Ey.id))?.staff_compete, "Ey lets staff compete").toBeTruthy();
      const org = await expectOk(await sa.get(`/api/admin/competitions/${Ey.id}/admins`), "Ey's organisers");
      expect(org.admins.map(o => o.id), "EAx does not organise Ey").not.toContain(EAx.id);
      // The refusal names the exit: on a live event the remedy offers self-removal.
      await expectLocked(await EAx.api.put(`/api/admin/tasks/${Tx.id}`, { headers: H(EAx.csrf), data: { title: `hijack ${TAG} escape` } }), "EAx PUT Tx (held by Ey, where they compete)", Ey, { remedy: "self" });
      // CONTROL (holds today): removing SOMEBODY ELSE from Ey is the lock — the
      // lock precedes the scope on this door.
      await expectLocked(await EAx.api.delete(`/api/admin/competitions/${Ey.id}/users/${Py.id}`, { headers: H(EAx.csrf) }), "EAx remove Py from Ey", Ey);
      expect(rowsFor(Py.id).has(Ey.id), "Py is still in Ey").toBe(true);
      // THE EXIT THE REMEDY NAMES. Today: 403 event_admin_out_of_scope.
      const self = await EAx.api.delete(`/api/admin/competitions/${Ey.id}/users/${EAx.id}`, { headers: H(EAx.csrf) });
      expect(self.status(), `EAx may take the exit the refusal named — remove themselves from Ey: ${await self.text()}`).toBe(200);
      expect((await self.json()).removed, "the row really went").toBe(true);
      expect(rowsFor(EAx.id).has(Ey.id), "EAx holds no row on Ey").toBe(false);
      // (No `compRow(EAx.api, Ey.id)` read here: EAx does not organise Ey, so their
      // scoped list omits it and `?.competing` is `undefined`, not `false` — the
      // header's rule. The table read above IS the competitor test.)
      // …and the challenge held by their OWN event is no longer locked by Ey:
      // what remains is ownership (S2 authored Tx), a rule of its own.
      const after = await EAx.api.put(`/api/admin/tasks/${Tx.id}`, { headers: H(EAx.csrf), data: { title: `after ${TAG} escape` } });
      const nl = await expectNotLocked(after, "EAx PUT Tx after leaving Ey", [403]);
      expect(nl.body.code, "refused by ownership, not by the lock").toBe("event_admin_not_owner");
      expect((await taskRow(EAx.api, Tx.id)).competing_in, "Tx's row names no event for EAx").toEqual([]);
    } finally {
      await EAx.api.dispose();
    }
  });

  test("(LOCK-6, fixed): an invitation's `newGroups` NAME resolving to a group OUTSIDE the event admin's scope is refused like `groupIds` is — not applied", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first;
    // a pre-existing scope hole at the exact site round-3 fix (b) touched):
    // the `newGroups` pre-pass asks `groupWriteDenied` before
    // `competitorGroupDenied`, so a name resolving to an out-of-scope group
    // is refused like a `groupIds` entry is.
    const Mine  = await makeCompetition(sa, saCsrf, "scope-mine");
    const Other = await makeCompetition(sa, saCsrf, "scope-other");
    const EAs = await makeEventAdmin(sa, saCsrf, "scope-ea", [Mine.id]);
    const V = await makeParticipant(sa, saCsrf, "scope-victim");
    await enrol(sa, saCsrf, Mine.id, [V.id]);
    const mk = async (label) => (await expectOk(await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `LG ${uniq(label)}` } }), `built-in creates ${label}`)).group;
    const Gout = await mk("scope-out");   // bound to Other only — outside EAs's scope
    const Gin  = await mk("scope-in");    // bound to Mine — inside it
    await expectOk(await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [Gout.id], competitionIds: [Other.id] } }), "bind Gout → Other");
    await expectOk(await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [Gin.id],  competitionIds: [Mine.id] } }), "bind Gin → Mine");
    const SCOPE_CODES = ["event_admin_out_of_scope", "event_admin_group_shared"];
    try {
      // CONTROL (holds today): the same group by ID is refused by the scope gate.
      const byId = await EAs.api.post("/api/admin/invitations", { headers: H(EAs.csrf), data: { emails: [V.email], competitionIds: [Mine.id], groupIds: [Gout.id] } });
      expect(byId.status(), `groupIds naming an out-of-scope group is refused: ${await byId.text()}`).toBe(403);
      expect(SCOPE_CODES).toContain((await byId.json()).code);
      expect(groupMember(Gout.id, V.id), "V is not in Gout (by id)").toBe(false);
      // THE HOLE: the same group by NAME. Today: 200, membership written, V synced into Other.
      const byName = await EAs.api.post("/api/admin/invitations", { headers: H(EAs.csrf), data: { emails: [V.email], competitionIds: [Mine.id], newGroups: [(await (await sa.get(`/api/admin/groups/${Gout.id}/members`)).json()).name] } });
      expect(byName.status(), `newGroups naming the same out-of-scope group must be refused too: ${await byName.text()}`).toBe(403);
      expect(SCOPE_CODES, "…by the scope gate").toContain((await byName.json()).code);
      expect(groupMember(Gout.id, V.id), "V is not in Gout (by name)").toBe(false);
      expect(rowsFor(V.id).has(Other.id), "V was not synced into the event outside the actor's scope").toBe(false);
      // NARROWNESS CONTROL: an in-scope group by name still applies.
      const inName = (await (await sa.get(`/api/admin/groups/${Gin.id}/members`)).json()).name;
      await expectOk(await EAs.api.post("/api/admin/invitations", { headers: H(EAs.csrf), data: { emails: [V.email], competitionIds: [Mine.id], newGroups: [inName] } }), "an in-scope group by name applies");
      expect(groupMember(Gin.id, V.id), "V is in Gin").toBe(true);
    } finally {
      await EAs.api.dispose();
      for (const g of [Gout, Gin]) await sa.delete(`/api/admin/groups/${g.id}`, { headers: H(saCsrf) }).catch(() => {});
    }
  });

  test("(LOCK-3, fixed): a competing user-backed superadmin may not IMPERSONATE a rival of the event they compete in — at entry, and at every write once the pair BECOME rivals mid-session", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first; the
    // operator ruled on 19 Sep 2026 that the ACCOUNT doors are gated too): the
    // impersonate route asks `competitorRivalDenied` right after its 404, and
    // `impersonationGuard` re-asks it on every non-GET off the allowlist, so a
    // pair that become rivals mid-session — the acting admin enrolled into the
    // target's compete event by a colleague — cannot move the board as the
    // target either. The exit stays reachable (it is allowlisted).
    // E10: SA10 competes; rivals R1 (the target) and R2 (does nothing — the
    // auto-end trap). E11: Pq competes, SA10 holds no row — the narrowness control.
    const E10 = await makeCompetition(sa, saCsrf, "imp-on",  { staff_compete: true });
    const E11 = await makeCompetition(sa, saCsrf, "imp-far", { staff_compete: true });
    const T10bank = await makeTask(S2.api, S2.csrf, "imp-sealed", { answer_sealed: true, hint: "h", correct_answer: "k" });
    const T10 = { ...T10bank, id: (await assignTask(sa, saCsrf, T10bank.id, [E10.id])).copies[0].task_id };   // E10's own copy
    const R1 = await makeParticipant(sa, saCsrf, "imp-rival");
    const R2 = await makeParticipant(sa, saCsrf, "imp-rival2");
    const Pq = await makeParticipant(sa, saCsrf, "imp-far-p");
    const SA10 = await makeTier(sa, saCsrf, "imp-super", "superadmin");
    const SA11 = await makeTier(sa, saCsrf, "imp-super2", "superadmin");
    await enrol(sa, saCsrf, E10.id, [R1.id, R2.id, SA10.id]);
    await enrol(sa, saCsrf, E11.id, [Pq.id]);
    const refreshCsrf = async (api) => (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const exit = async (who) => { const c = await refreshCsrf(who.api); await expectOk(await who.api.post("/api/impersonation/exit", { headers: H(c) }), `${who.label} exits impersonation`); who.csrf = await refreshCsrf(who.api); };
    try {
      expect((await compRow(SA10.api, E10.id))?.competing, "SA10 competes in E10").toBe(true);
      expect(rowsFor(SA10.id).has(E11.id), "SA10 holds no row on E11").toBe(false);
      // THE DOOR.
      const imp = await SA10.api.post(`/api/admin/participants/${R1.id}/impersonate`, { headers: H(SA10.csrf) });
      if (imp.ok()) await exit(SA10);           // leave the session as it was found before the assertion fails
      await expectLocked(imp, "SA10 impersonate R1 (a rival of E10)", E10, { remedy: "self" });
      expect(rowsFor(SA10.id).has(E10.id), "SA10 still competes in E10 — a refusal writes nothing").toBe(true);
      // NARROWNESS CONTROL: a participant of an event SA10 does NOT compete in.
      const far = await SA10.api.post(`/api/admin/participants/${Pq.id}/impersonate`, { headers: H(SA10.csrf) });
      expect(far.ok(), `SA10 may impersonate Pq (no shared compete event): ${far.status()} ${await far.text()}`).toBeTruthy();
      await exit(SA10);
      // CONTROL (holds today): the unenrolled superadmin twin impersonates R1
      // and its submission AS R1 lands — the door works, and the write it
      // guards is real.
      const twin = await SA11.api.post(`/api/admin/participants/${R1.id}/impersonate`, { headers: H(SA11.csrf) });
      expect(twin.ok(), `SA11 may impersonate R1: ${twin.status()} ${await twin.text()}`).toBeTruthy();
      expect((await twin.json()).readOnly, "a superadmin impersonation is full-write").toBe(false);
      const c1 = await refreshCsrf(SA11.api);
      await expectOk(await SA11.api.post("/api/select-competition", { headers: H(c1), data: { competitionId: E10.id } }), "SA11-as-R1 enters E10");
      const gh = await gradingHashFor(SA11.api, T10.id);
      const sub = await expectOk(await SA11.api.post(`/api/tasks/${T10.id}/submit`, { headers: H(c1), data: { answer: `wrong-${TAG}`, gradingHash: gh } }), "SA11-as-R1 submits a wrong answer");
      expect(sub.correct, "…which is graded, as R1").toBe(false);
      expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id=? AND task_id=? AND competition_id=?").get(R1.id, T10.id, E10.id).n), "the submission is R1's row").toBe(1);
      // THE PAIR BECOME RIVALS MID-SESSION: the built-in enrols SA11 into E10
      // while SA11 is still R1. The next write AS R1 is refused by the guard's
      // re-ask (naming E10), a read still answers, and the exit still works.
      await enrol(sa, saCsrf, E10.id, [SA11.id]);
      expect(rowsFor(SA11.id).has(E10.id), "PRECONDITION: SA11 now competes in E10").toBe(true);
      const c2 = await refreshCsrf(SA11.api);
      const gh2 = await gradingHashFor(SA11.api, T10.id);
      await expectLocked(await SA11.api.post(`/api/tasks/${T10.id}/submit`, { headers: H(c2), data: { answer: `wrong2-${TAG}`, gradingHash: gh2 } }), "SA11-as-R1 submits after becoming R1's rival", E10);
      expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id=? AND task_id=? AND competition_id=?").get(R1.id, T10.id, E10.id).n), "the refused write stored nothing — still the one row").toBe(1);
      const rd = await SA11.api.get("/api/status");
      expect(rd.ok(), `a READ as R1 still answers: ${rd.status()} ${await rd.text()}`).toBeTruthy();
      await exit(SA11);
      // …and at ENTRY the pair is now refused too.
      const again = await SA11.api.post(`/api/admin/participants/${R1.id}/impersonate`, { headers: H(SA11.csrf) });
      if (again.ok()) await exit(SA11);
      await expectLocked(again, "SA11 impersonate R1 once they compete in E10", E10);
    } finally {
      for (const s of [SA10, SA11]) await s.api.dispose();
    }
  });

  test("(LOCK-4, fixed): every ACCOUNT door on a RIVAL — block, deny, approve, verify, the benchmark tag, email a sign-in code, role, delete, and the certificate's revoke, Issue again and Resend — answers the lock; unlock and the other tags stay open; an unenrolled twin is refused nowhere (CONTROL)", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`; the operator ruled
    // on 19 Sep 2026): a RIVAL is anybody holding a row on a compete event the
    // actor holds a row on, and every door that reaches that board through the
    // ACCOUNT asks `competitorRivalDenied` right after its 404 — above the scope
    // and peer-admin gates, so every tier hears the same reason. The benchmark
    // tag is the ONE tag gated (it takes a rival off the ranked board); the
    // staff tag is inert where staff compete and stays open, as does unlock (a
    // login-lockout release moves no board). The badge revoke is a competition
    // door (`competitorEditDenied` on the badge's event), asked in the same way.
    const E12 = await makeCompetition(sa, saCsrf, "life-on", { staff_compete: true });
    const F12 = await makeCompetition(sa, saCsrf, "life-far", { staff_compete: true });   // the narrowness control's event
    const R  = await makeParticipant(sa, saCsrf, "life-rival");
    const R2 = await makeParticipant(sa, saCsrf, "life-rival2");   // the delete control's throwaway
    const Rq = await makeParticipant(sa, saCsrf, "life-far-p");    // competes only in F12 — no shared event with A12/SA12
    const A12  = await makeTier(sa, saCsrf, "life-admin", "admin");
    const SA12 = await makeTier(sa, saCsrf, "life-super", "superadmin");
    const A13  = await makeTier(sa, saCsrf, "life-admin2", "admin");
    const SA13 = await makeTier(sa, saCsrf, "life-super2", "superadmin");
    await enrol(sa, saCsrf, E12.id, [R.id, R2.id, A12.id, SA12.id]);
    await enrol(sa, saCsrf, F12.id, [Rq.id]);
    const blocked = () => !!withDb(db => db.prepare("SELECT blocked FROM users WHERE id=?").get(R.id)?.blocked);
    const tagged = (tag) => !!withDb(db => db.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag=?").get(R.id, tag));
    const col = (uid, c) => withDb(db => db.prepare(`SELECT ${c} AS v FROM users WHERE id=?`).get(uid))?.v;
    const setCol = (uid, sql) => withDb(db => db.prepare(`UPDATE users SET ${sql} WHERE id=?`).run(uid), { readonly: false });
    // A planted badge of E12 for R — minting needs an ended event, and the
    // revoke door reads only the row's competition (the v8.10.1 restore-test
    // shape: a state no live door can reach, written straight into SQLite).
    const badgeToken = `plant-${TAG}-${uniq("b")}`;
    withDb(db => db.prepare("INSERT INTO achievement_badges (token, user_id, competition_id, rank, image_id, nickname_snapshot, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(badgeToken, R.id, E12.id, 1, "planted", "life-rival", new Date().toISOString()), { readonly: false });
    const badgeRevoked = () => !!withDb(db => db.prepare("SELECT revoked_at FROM achievement_badges WHERE token=?").get(badgeToken)?.revoked_at);
    try {
      for (const a of [A12, SA12]) {
        const w = `${a.label} (${a.role})`;
        expect((await compRow(a.api, E12.id))?.competing, `${w} competes in E12`).toBe(true);
        // BLOCK.
        const blk = await a.api.post(`/api/admin/participants/${R.id}/block`, { headers: H(a.csrf) });
        if (blk.ok() && (await blk.json().catch(() => ({}))).blocked) await sa.post(`/api/admin/participants/${R.id}/block`, { headers: H(saCsrf) }); // put it back before failing
        await expectLocked(blk, `${w} block R (a rival of E12)`, E12, { remedy: "self" });
        expect(blocked(), `${w}: R is not blocked`).toBe(false);
        // THE BENCHMARK TAG, both directions — and the STAFF tag stays open,
        // being inert where staff compete.
        const tg = await a.api.post(`/api/admin/participants/${R.id}/tags`, { headers: H(a.csrf), data: { tag: "benchmark" } });
        if (tg.ok()) await sa.delete(`/api/admin/participants/${R.id}/tags/benchmark`, { headers: H(saCsrf) });
        await expectLocked(tg, `${w} tag R benchmark`, E12);
        expect(tagged("benchmark"), `${w}: R carries no benchmark tag`).toBe(false);
        await expectOk(await sa.post(`/api/admin/participants/${R.id}/tags`, { headers: H(saCsrf), data: { tag: "benchmark" } }), "the built-in plants the benchmark tag");
        await expectLocked(await a.api.delete(`/api/admin/participants/${R.id}/tags/benchmark`, { headers: H(a.csrf) }), `${w} untag R benchmark`, E12);
        expect(tagged("benchmark"), `${w}: the tag is still there`).toBe(true);
        await expectOk(await sa.delete(`/api/admin/participants/${R.id}/tags/benchmark`, { headers: H(saCsrf) }), "the built-in removes it again");
        await expectOk(await a.api.post(`/api/admin/participants/${R.id}/tags`, { headers: H(a.csrf), data: { tag: `plain-${TAG}` } }), `${w} may still add an ORDINARY tag to R`);
        await expectOk(await a.api.delete(`/api/admin/participants/${R.id}/tags/${encodeURIComponent(`plain-${TAG}`)}`, { headers: H(a.csrf) }), `${w} …and remove it`);
        // EMAIL A SIGN-IN CODE.
        expect(col(R.id, "login_code_hash"), `PRECONDITION: R holds no sign-in code`).toBeNull();
        await expectLocked(await a.api.post(`/api/admin/participants/${R.id}/login-code/email`, { headers: H(a.csrf) }), `${w} email R a sign-in code`, E12);
        expect(col(R.id, "login_code_hash"), `${w}: no sign-in code was minted`).toBeNull();
        // DENY / APPROVE / VERIFY need the pre-approval states, written by hand
        // (the assign door skips an unapproved account, so a rival cannot be
        // MADE unapproved through any door): each is put back afterwards.
        setCol(R.id, "approved=0");
        await expectLocked(await a.api.post(`/api/admin/participants/${R.id}/deny`, { headers: H(a.csrf) }), `${w} deny R`, E12);
        expect(col(R.id, "denied_at"), `${w}: R was not denied`).toBeNull();
        await expectLocked(await a.api.post(`/api/admin/participants/${R.id}/approve`, { headers: H(a.csrf) }), `${w} approve R`, E12);
        expect(col(R.id, "approved"), `${w}: R is still unapproved`).toBe(0);
        setCol(R.id, "approved=1");
        setCol(R.id, "verified=0");
        const vf = await a.api.post(`/api/admin/participants/${R.id}/verify`, { headers: H(a.csrf) });
        if (a.role === "superadmin") { await expectLocked(vf, `${w} verify R`, E12); expect(col(R.id, "verified"), `${w}: R is still unverified`).toBe(0); }
        else expect(vf.status(), `${w} verify R: a regular admin hears the tier refusal (verify is superadmin-only) — the lock is not what stops them`).toBe(403);
        setCol(R.id, "verified=1");
        // UNLOCK is NOT a board input and stays open (the route clears a login
        // lockout; the rival keeps every row they hold).
        setCol(R.id, "failed_login_count=10, locked_until=datetime('now','+1 hour')");
        await expectOk(await a.api.post(`/api/admin/participants/${R.id}/unlock`, { headers: H(a.csrf) }), `${w} may still UNLOCK R`);
        expect(col(R.id, "locked_until"), `${w}: the lock is cleared`).toBeNull();
      }
      // ROLE and DELETE are superadmin doors; the badge REVOKE too.
      await expectLocked(await SA12.api.post(`/api/admin/participants/${R.id}/role`, { headers: H(SA12.csrf), data: { role: "admin" } }), "SA12 promote R (a rival of E12)", E12);
      expect(col(R.id, "role"), "R is still a participant").toBe("participant");
      await expectLocked(await SA12.api.post(`/api/admin/badges/${badgeToken}/revoke`, { headers: H(SA12.csrf), data: { reason: "rival" } }), "SA12 revoke R's E12 certificate", E12);
      expect(badgeRevoked(), "the certificate is not revoked").toBe(false);
      await expectLocked(await SA12.api.delete(`/api/admin/participants/${R.id}`, { headers: H(SA12.csrf) }), "SA12 DELETE R (a rival of E12)", E12);
      expect(await participantRow(sa, R.id), "R still exists").toBeTruthy();
      // NARROWNESS: the same actors act freely on Rq, who shares NO compete
      // event with them — the lock is about the shared board, not about being
      // a competitor anywhere.
      for (const a of [A12, SA12]) {
        const w = `${a.label} (${a.role})`;
        await expectOk(await a.api.post(`/api/admin/participants/${Rq.id}/block`, { headers: H(a.csrf) }), `${w} may block Rq (no shared compete event)`);
        await expectOk(await a.api.post(`/api/admin/participants/${Rq.id}/block`, { headers: H(a.csrf) }), `${w} may unblock Rq`);
      }
      // CONTROLS (hold today): the unenrolled twins, the same doors, real writes read back.
      for (const c of [A13, SA13]) {
        const w = `${c.label} (${c.role}, unenrolled)`;
        await expectOk(await c.api.post(`/api/admin/participants/${R.id}/block`, { headers: H(c.csrf) }), `${w} may block R`);
        expect(blocked(), `${w}: R is blocked`).toBe(true);
        await expectOk(await c.api.post(`/api/admin/participants/${R.id}/block`, { headers: H(c.csrf) }), `${w} may unblock R (the route toggles)`);
        expect(blocked(), `${w}: R is unblocked`).toBe(false);
        await expectOk(await c.api.post(`/api/admin/participants/${R.id}/tags`, { headers: H(c.csrf), data: { tag: "benchmark" } }), `${w} may tag R benchmark`);
        expect(tagged("benchmark"), `${w}: the tag landed`).toBe(true);
        await expectOk(await c.api.delete(`/api/admin/participants/${R.id}/tags/benchmark`, { headers: H(c.csrf) }), `${w} may untag R`);
        expect(tagged("benchmark"), `${w}: the tag is gone`).toBe(false);
        // Each twin's press must really mint: forget the previous press's
        // two-minute re-send hold, then compare the stored code before and after.
        await sa.post("/api/test/reset-recent-code-sends", { headers: H(saCsrf) });
        const codeBefore = col(R.id, "login_code_hash");
        await expectOk(await c.api.post(`/api/admin/participants/${R.id}/login-code/email`, { headers: H(c.csrf) }), `${w} may email R a sign-in code`);
        const codeAfter = col(R.id, "login_code_hash");
        expect(codeAfter, `${w}: the code was minted`).toBeTruthy();
        expect(codeAfter, `${w}: a NEW code was minted by this press`).not.toBe(codeBefore);
      }
      await expectOk(await SA13.api.post(`/api/admin/badges/${badgeToken}/revoke`, { headers: H(SA13.csrf), data: { reason: "control" } }), "SA13 (unenrolled) may revoke the E12 certificate");
      expect(badgeRevoked(), "CONTROL: the certificate really is revoked").toBe(true);
      // ISSUE AGAIN is the same competition door (the revoked certificate's event):
      // refused to the competitor; the unenrolled twin is answered on the merits.
      await expectLocked(await SA12.api.post(`/api/admin/competitions/${E12.id}/certificates/reissue`, { headers: H(SA12.csrf), data: { userId: R.id } }), "SA12 issue R's E12 certificate again", E12);
      const _ri = await SA13.api.post(`/api/admin/competitions/${E12.id}/certificates/reissue`, { headers: H(SA13.csrf), data: { userId: R.id } });
      expect(_ri.status(), await _ri.text()).toBe(409);
      expect((await _ri.json()).code, "CONTROL: past the lock, refused only because E12 has not ended").toBe("not_ended");
      // RESEND (the certificate's email) is the same competition door: refused
      // to the competitor; the unenrolled twin is answered on the merits.
      await expectLocked(await SA12.api.post(`/api/admin/competitions/${E12.id}/certificates/resend`, { headers: H(SA12.csrf), data: { userId: R.id } }), "SA12 re-send R's E12 certificate email", E12);
      const _rs = await SA13.api.post(`/api/admin/competitions/${E12.id}/certificates/resend`, { headers: H(SA13.csrf), data: { userId: R.id } });
      expect(_rs.status(), await _rs.text()).toBe(404);
      expect((await _rs.json()).code, "CONTROL: past the lock, refused only because R holds no live certificate (revoked above)").toBe("no_certificate");
      await expectOk(await SA13.api.delete(`/api/admin/participants/${R2.id}`, { headers: H(SA13.csrf) }), "SA13 may delete R2");
      expect(withDb(db => db.prepare("SELECT 1 FROM users WHERE id=?").get(R2.id)), "R2 is gone").toBeUndefined();
    } finally {
      for (const s of [A12, SA12, A13, SA13]) await s.api.dispose();
    }
  });
});
