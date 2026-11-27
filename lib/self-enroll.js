"use strict";

// Self-enrollment engine: token mint, token→joinable-competition resolution,
// the enroll transaction, its post-commit side effects, and the deferred
// pending-enroll consumer fired at login. STRICT LEAF CONSUMER — imports lib
// modules ONLY, never routes/* (routes/auth calls INTO this; the reverse would
// be an instant lib→route cycle). (v7.0.0 refactor: extracted from server.js.)

const crypto = require("crypto");
const db = require("../db");
const { swallowed } = require("./best-effort");
const { _b64url } = require("./util");
const { now } = require("./time");
const { getCompetition, getCompetitionTimeslots, _competitionAcceptsSelfEnroll, closeAbsenceAndRestoreAnchor, competitionAdmission, competitionEffectiveEnd, lateWindowAdmissionDenied, lateEntryStateFor } = require("./competitions");
const { log } = require("./log");
const { recordUserEvent, recordCompetitionEvent, runTxnWithMirrorBuffer, reqContext, capabilityFingerprint } = require("./audit");
const { LOGIN_CODE_TTL_MS } = require("./config");
const { generateHumanCode, normaliseHumanCode } = require("./human-code");
const { enqueueCxOneProvision } = require("./cxone");
const { _invalidateMeCache } = require("./me-cache");
const { invalidateLeaderboardCache, invalidateLeaderboardCacheForEntrant } = require("./leaderboard");
const { invalidateAdminParticipantsCache } = require("./participants-cache");

function _genSelfEnrollToken() {
  return _b64url(crypto.randomBytes(32));
}

// v8.1.0 (PR 32) — the SHORT JOIN CODE.
//
// SIX characters, and it is a DIFFERENT kind of thing from the 256-bit
// `self_enroll_token` beside it. The token is a secret: it is scrubbed from
// access logs, stripped from every competition response, and revealed only by a
// dedicated admin endpoint. The code is the OPPOSITE — it is meant to be printed
// on a sign, read across a stand and shouted at someone holding a phone.
//
// So the security argument is not entropy, it is BLAST RADIUS, and it rests on
// three things that are all already true:
//   * it resolves only while the event is joinable (the same predicate the token
//     uses), so a code is dead the moment the event ends;
//   * the lookup is rate-limited per IP, exactly like the token preview;
//   * joining is not a privilege — it enrols you in an event whose QR code is
//     stuck to a table in a public hall.
// 32^6 is ~1.07e9, which is far beyond what a rate-limited attacker can walk,
// and guessing one buys them a place at a trade-show booth.
const JOIN_CODE_LEN = 6;

/**
 * Mint a code that is not already taken.
 *
 * It CHECKS first and does not retry on a clash (v8.13.3 corrects a comment
 * that said the opposite). That is safe only because every caller writes the
 * code synchronously, with no await between this check and the INSERT/UPDATE,
 * in a single process; the partial unique index on `join_code` is the backstop,
 * and a clash there fails the write closed rather than sharing a code. Bounded,
 * and returns null if it somehow cannot find a free one — the caller must treat
 * a missing code as "this event has no short code", never as a reason to fail
 * the create.
 */
function _genJoinCode() {
  for (let i = 0; i < 8; i++) {
    const code = generateHumanCode(crypto.randomBytes, JOIN_CODE_LEN);
    if (!db.prepare("SELECT 1 FROM competitions WHERE join_code=?").get(code)) return code;
  }
  return null;
}

/**
 * Resolve a TYPED code to a joinable competition.
 *
 * Normalises first, so `o`/`0` and `l`/`1` behave the way the person reading the
 * sign expects. An empty normalisation must never match — that is the contract
 * `normaliseHumanCode` provides and the reason it returns "" rather than null.
 *
 * Answers with the SAME opaque null as the token path for every failure, so a
 * caller cannot tell an unknown code from a disabled or ended event.
 */
function _resolveJoinCode(typed) {
  const code = normaliseHumanCode(typed);
  // DEFENCE IN DEPTH, not the protection — stated rather than implied, because a
  // comment claiming a guard the tests do not exercise is the v8.1.0 /credential
  // lesson. No competition carries an empty `join_code`, so an empty
  // normalisation finds nothing regardless; removing this line changes no
  // observable behaviour (measured). It stays because a future caller might
  // reach here with a column that CAN be empty, and the cost is one comparison.
  if (!code) return null;
  const comp = db.prepare("SELECT * FROM competitions WHERE join_code=?").get(code);
  if (!comp || !comp.self_enroll_enabled) return null;
  if (!_competitionAcceptsSelfEnroll(comp)) return null;
  return comp;
}

// The 48h email-verification grace. An unverified account that redeems a DESK
// code (an organiser read it out, so it proves no inbox) is stamped
// users.self_enroll_grace_until = now + SELF_ENROLL_GRACE_MS (routes/auth.js).
// Until then it may use the platform unverified; after that requireParticipant
// and the password door refuse it until an emailed code verifies the address
// (another desk code re-stamps the grace). Cleared (NULL) the moment
// verified=1. Sign-ups prove their address first and desk sign-ups are created
// verified, so an unverified account was created before that, or imported. The
// grace, the verification link, the header's "Verify email" chip and the
// unverified-account reaper are kept for those accounts (operator ruling,
// 14 Nov 2026): the import is the one way left to create one, kept so an
// operator can force re-verification. Matches CODE_EXPIRY_MS (the verify-link
// TTL).
const SELF_ENROLL_GRACE_MS = 48 * 60 * 60 * 1000;

// Classify a user's verification-grace state from (verified, self_enroll_grace_
// until). Pure — no DB. `active` ⇒ may log in / browse while still unverified;
// `expired` ⇒ had a grace window that has lapsed (⇒ must verify before login).
// A verified user (or one that never had a grace window) is neither. Shared by
// the login gate, requireParticipant, and GET /api/me so the three agree.
function verificationGraceState(user) {
  const verified = !!(user && user.verified);
  const until = user && user.self_enroll_grace_until ? user.self_enroll_grace_until : null;
  if (verified || !until) return { verified, graceUntil: verified ? null : until, active: false, expired: false };
  const t = new Date(until).getTime();
  const active = Number.isFinite(t) && now().getTime() < t;
  return { verified, graceUntil: until, active, expired: !active };
}

// Resolve a self-enroll token to a JOINABLE competition (enabled + upcoming/
// live), or null. Used by the public preview and the sign-in and sign-up
// doors (routes/auth.js).
function _resolveJoinableComp(token) {
  if (!token || typeof token !== "string") return null;
  const comp = db.prepare("SELECT * FROM competitions WHERE self_enroll_token=?").get(token);
  if (!comp || !comp.self_enroll_enabled) return null;
  if (!_competitionAcceptsSelfEnroll(comp)) return null;
  return comp;
}

// THE JOIN LINK A CODE WAS ASKED THROUGH, remembered by a fingerprint of its
// token, never the token: the token is a join capability, and this is kept in
// session rows (the code request's note, the sign-up grant; routes/auth.js).
// `liveJoinLinkTag` is the tag of an event's link only while that link is LIVE
// (switched on, the event still taking joins), else null, so a link switched off
// or replaced by Regenerate matches nothing a browser remembers asking through
// (sweep #391). A link switched off and on again is the same link.
function joinLinkTag(token) {
  return typeof token === "string" && token ? capabilityFingerprint(token, "jl_") : null;
}
function liveJoinLinkTag(comp) {
  if (!comp || !comp.self_enroll_enabled || !comp.self_enroll_token) return null;
  if (!_competitionAcceptsSelfEnroll(comp)) return null;
  return joinLinkTag(comp.self_enroll_token);
}

// SWITCHING A JOIN LINK OFF, OR REPLACING IT, UNTIES EVERY CODE ALREADY ASKED FOR
// THROUGH IT (sweep #391, operator ruling, 24 Nov 2026). Every live emailed
// sign-in code bound to the event (`users.login_code_comp_id`) and every live
// address proof (`email_proofs.join_comp_id`) loses it: redeemed, the code signs
// in, and the proof makes an account, without joining, as a sign-up through the
// closed link already did. The code or proof itself keeps working, with its
// window and budget. Run inside the caller's transaction (the event PUT that
// switches the link off, the regenerate), after its first write, so the untie
// commits with the change and its record; returns how many it untied, for that
// record. Only live ones: a dead code's or proof's binding is never read (a redeem
// needs a live one, and the next mint overwrites it). A sign-up grant a session
// already holds is beyond a database write: the register asks that the link it
// was asked through is still the live one (routes/auth.js). The pending join
// marker of a join-link registration is left as it is (`_consumePendingSelfEnroll`).
function untieJoinLinkBindings(compId, at) {
  const n = at || now();
  const codes = db.prepare("UPDATE users SET login_code_comp_id=NULL WHERE login_code_comp_id=? AND login_code_at > ?")
    .run(compId, new Date(n.getTime() - LOGIN_CODE_TTL_MS).toISOString()).changes;
  const proofs = db.prepare("UPDATE email_proofs SET join_comp_id=NULL WHERE join_comp_id=? AND expires_at > ?")
    .run(compId, n.toISOString()).changes;
  return { codes, proofs };
}

// Enroll one user into one competition via the self-enrollment link. Mirrors
// the per-(user,comp) txn in POST /api/admin/competitions/assign — INSERT OR
// IGNORE, promote to direct_assigned=1 (sticky, never group-desynced), clear
// any group-removal tombstone, close the absence row, restore a pinned slot
// from history, and emit the audit pair — but stamps assigned_by/'via' as the
// "self_enroll" sentinel. Returns true iff a NEW membership row was created
// (false = already a member → no new-row side effects; note that an
// already-member call can still emit `membership_promoted`, see below — the
// return value means "a row was inserted", not "nothing happened"). Post-commit
// side effects (CxOne provision + cache busts) are the caller's job via
// _selfEnrollSideEffects, and a promotion deliberately does not need them: it
// moves `direct_assigned` only, which no cache keys on, and the membership the
// caches DO carry was already there.
// `extra` (v7.15.2, audit) is spread into both audit emits. It exists so the
// /api/competitions/join route can tag an enrolment performed by a superadmin
// inside an impersonation session with impersonated_by — this module stays
// request-agnostic, so the caller supplies the context. Empty on every other
// path (registration consume, LinkedIn consume), which is the normal case.
/**
 * v7.21.32 — `actor` is a real parameter, not something `extra` can carry.
 *
 * `extra` is spread into the event DETAILS; the actor is the third positional
 * argument (`changed_by`), so a participant's own deliberate join was recorded
 * against the literal sentinel "self_enroll" — the MECHANISM rather than the
 * person. An operator filtering the log by somebody's email to reconstruct what
 * they did would not see their own join at all. The default keeps the sentinel,
 * because the request-less consume path below genuinely has no user acting.
 */
/**
 * v8.12.0 — MAY THIS USER HOLD A ROW ON THIS EVENT? The staff row-writer rule,
 * asked by every path that writes a `competition_users` row for somebody who
 * did not come through the admin assign route (which asks it inline):
 *
 *   • `"spectator"` — a staff-tagged user on an event whose "Staff can compete"
 *     switch is OFF. They may still ENTER it (`requireParticipantInCompetition`
 *     admits staff without a row), so the join succeeds and simply writes
 *     nothing; a row there would put them on the assign route's `skippedStaff`
 *     list through a side door.
 *   • `{ authored: [...] }` — the switch is ON but the user authored a challenge
 *     assigned to the event; a sealed key is readable by its author, so they
 *     cannot compete against it. Refused, naming the challenges.
 *   • `null` — write the row.
 *
 * `comp` must carry `staff_compete` (`getCompetition` and the join route's
 * `SELECT *` both do); `staffCompeteOn` throws otherwise.
 */
function staffRowRefusal(user, comp) {
  const { staffCompeteOn, authoredAssignedTasks } = require("./staff-compete");
  const { isStaff } = require("./user-tags");
  if (!staffCompeteOn(comp)) return isStaff(user.id) ? "spectator" : null;
  const authored = authoredAssignedTasks(db, user.id, comp.id);
  return authored.length ? { authored } : null;
}

function _selfEnrollEnrollTxn(user, comp, extra = {}, actor = "self_enroll") {
  const assignedAt = now().toISOString();
  let didInsert = false;
  // v8.12.6 — an event still taking LATE ENTRIES admits here too (the callers ask
  // `competitionAdmission` first). Two things change when this write goes through
  // the window: a HELD row of somebody who was in the event before it ended is a
  // true no-op — not promoted to direct, because the promotion is a durable change
  // to that person and the late window exists to admit NEW people, not to re-shape
  // the final roster — and a new row's emits carry `late_entry`, so History can
  // tell a late arrival from an ordinary join.
  //
  // (review) — a held row that is itself a LATE ENTRANT's is promoted as it would
  // be live (the assign route's rule, and its reason): they were never on the final
  // roster, and a group-added walk-up who then scans the join QR has asked to be in
  // the event whatever becomes of the group.
  const _late = competitionAdmission(comp) === "late";
  if (_late) extra = { ...extra, late_entry: true };
  const txn = db.transaction(() => {
    // v8.1.7 — read the pre-state, for exactly the reason the admin assign path
    // reads it (routes/participants.js, v7.21.32): the `direct_assigned=1`
    // UPDATE below is a DURABLE change that lands on an ALREADY-MEMBER row, and
    // this function used to `return` on that branch before either emit. So a
    // participant enrolled through a bound GROUP who then joins via the
    // self-enroll link — a live QR scan, the v7.22.8 stored-token boot recovery,
    // or the deferred login consume — was silently promoted to a direct member
    // with no event of any kind.
    //
    // That is consequential, not bookkeeping: `reconcileCompetitionMembership`
    // never auto-removes a `direct_assigned=1` row, so a later removal from the
    // bound group quietly fails to drop them from the competition and nothing in
    // any History explains why. It is also invisible to the v7.21.32 scanner,
    // which checks reqContext on emits that EXIST rather than noticing absent
    // ones — which is why this needs a behavioural lock.
    const prevDirect = db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?")
      .get(comp.id, user.id);
    const result = db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)")
      .run(comp.id, user.id, "self_enroll", assignedAt);
    // v8.12.6 — a held row through the window is left exactly as it is, unless it
    // is a late entrant's (review; see above).
    if (result.changes === 0 && _late && !lateEntryStateFor(comp, user.id, getCompetitionTimeslots(comp.id)).isLate) return;
    db.prepare("UPDATE competition_users SET direct_assigned=1 WHERE competition_id=? AND user_id=?").run(comp.id, user.id);
    db.prepare("DELETE FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").run(comp.id, user.id);
    if (result.changes === 0) {
      // Already a member — no new-row side effects, but the promotion above may
      // still have changed something durable. Emit ONLY when it actually did:
      // v7.22.8's stored-token recovery re-joins on EVERY boot, so an
      // unconditional emit would put one line per page load on the History.
      //
      // Same event NAME and shape as the admin path, deliberately — it is the
      // same transition, and an operator reading a History should meet one
      // concept rather than two spellings of it. `via` distinguishes the path,
      // matching the `user_added` emit further down this same function.
      if (prevDirect && !prevDirect.direct_assigned) {
        recordCompetitionEvent(comp.id, "membership_promoted", actor, {
          user_id: user.id, nickname: user.nickname, from_direct_assigned: 0, to_direct_assigned: 1,
          via: "self_enroll", ...extra,
        });
        recordUserEvent(user.id, "membership_promoted", actor, {
          competition_id: comp.id, competition_name: comp.name, via: "self_enroll", ...extra,
        });
      }
      return;
    }
    didInsert = true;
    // v8.1.0 (PR 30) — THE SELF-ENROLMENT CEILING, enforced AFTER the INSERT and
    // INSIDE the transaction, which is the only placement that is actually a
    // limit rather than an approximation of one.
    //
    // Counting first and inserting second is check-then-act: two visitors scanning
    // the QR in the same second both read `n = cap - 1`, both pass, and the event
    // ends up one over — the exact shape v7.15.11 fixed for the attachment quota.
    // Inserting first makes the count include US, so the comparison is `> cap` and
    // the loser's whole transaction rolls back. This is genuine mutual exclusion,
    // not an approximation: the server is single-process by hard invariant and
    // better-sqlite3 is synchronous, so nothing can interleave between the INSERT
    // and this read.
    //
    // v8.1.0 — closes the absence AND restores the solve-clock anchor recorded
    // on it at removal. THIS is the path the self-service exploit runs through:
    // "Leave this event" then re-join is two calls, and without the restore the
    // lazy stamp re-anchors the clock to the rejoin, clamping a finisher's
    // solveTimeMs to 0 and winning the sole score tie-break. Shared with the
    // bulk-assign and group-sync re-adds so the rule has one definition.
    closeAbsenceAndRestoreAnchor(user.id, comp.id, assignedAt);
    // 7 placeholders: subquery × 2 (user, comp) + slot-existence comp + outer (user, comp).
    db.prepare(
      `UPDATE competition_users SET timeslot_id=(
         SELECT timeslot_id FROM (
           SELECT timeslot_id FROM submissions WHERE user_id=? AND competition_id=? AND timeslot_id IS NOT NULL
           UNION ALL
           SELECT timeslot_id FROM hint_reveals WHERE user_id=? AND competition_id=? AND timeslot_id IS NOT NULL
         )
         WHERE timeslot_id IN (SELECT id FROM competition_timeslots WHERE competition_id=?)
         LIMIT 1
       ) WHERE user_id=? AND competition_id=? AND timeslot_id IS NULL`
    ).run(user.id, comp.id, user.id, comp.id, comp.id, user.id, comp.id);
    recordUserEvent(user.id, "self_enrolled", actor, { competition_id: comp.id, competition_name: comp.name, ...extra });
    recordCompetitionEvent(comp.id, "user_added", actor, { user_id: user.id, nickname: user.nickname, via: "self_enroll", ...extra });
  });
  runTxnWithMirrorBuffer(() => txn());
  return didInsert;
}

function _selfEnrollSideEffects(user, comp) {
  try { enqueueCxOneProvision(user, comp.id, "self_enroll"); } catch (e) { swallowed("self-enroll:cxone-enqueue", e); }
  _invalidateMeCache(user.id);
  // A NEWCOMER'S JOIN adds no score, solve or finish (they reach the board only
  // once their clock is anchored), so it takes the coalesced entrant bust, as the
  // first-entry stamp does: a hard bust per join rebuilt the whole board and
  // moved its version for every open board tab at each arrival, O(N²) over a
  // booth rush (CLAUDE.md, *Deliberate exceptions*). Somebody REJOINING with
  // answers or hints already in this event comes back onto the board with their
  // points, which is a score change, so that join still busts it outright. Both
  // lookups are index searches.
  const _scored = db.prepare("SELECT 1 FROM submissions WHERE user_id=? AND competition_id=? LIMIT 1").get(user.id, comp.id)
    || db.prepare("SELECT 1 FROM hint_reveals WHERE user_id=? AND competition_id=? LIMIT 1").get(user.id, comp.id);
  if (_scored) invalidateLeaderboardCache(comp.id);
  else invalidateLeaderboardCacheForEntrant(comp.id);
  invalidateAdminParticipantsCache();
}

// Consume a user's pending self-enroll marker at sign-in. A user who registers
// through a /join link is created with this marker set, and POST /api/register
// consumes it in the same request, just before it signs the new account in (the
// grant proved the address, so the join is the person's own); every sign-in door
// consumes a marker still pending. We honour the
// enrollment as long as the competition still exists and is
// still upcoming/live (the user already passed the link gate at registration),
// even if the admin has since toggled the link off. If the comp is gone or has
// ended, the marker is cleared silently. Idempotent + safe on every login.
// v8.12.6 — "still upcoming/live" is `competitionAdmission` now, so an event still
// taking late entries is honoured too, and the took-part refusal the live join
// door answers is applied here as well (a settled answer, so the marker is
// cleared and the refusal logged: there is nobody to tell at this moment).
// `req` is the sign-in request: the join is the person's own act, so its emits
// name them and carry the request's context (the standing event rule), exactly
// as the live join door's do.
function _consumePendingSelfEnroll(userId, req) {
  const u = db.prepare("SELECT pending_self_enroll_comp_id FROM users WHERE id=?").get(userId);
  if (!u || !u.pending_self_enroll_comp_id) return;
  _enrolAtSignIn(userId, u.pending_self_enroll_comp_id,
    () => db.prepare("UPDATE users SET pending_self_enroll_comp_id=NULL WHERE id=?").run(userId), req);
}

// The event an emailed sign-in code was bound to (users.login_code_comp_id, read
// by the redeem route BEFORE its claim, consumeCode, wipes it). Same admission ladder as the
// pending marker above. For an existing account the code is the only thing a
// code request can enrol through, never the request itself: anyone may type any
// address. And the redeem passes the binding only when the redeeming browser
// itself asked for that event (routes/auth.js `_sessionNamedEvent`, sweep #198):
// anyone holding the join link may ask for a code for any address. It asked
// through the event's join link as it is now, too (sweep #391): a link switched
// off or replaced since passes nothing, and switching it off or replacing it has
// already untied the code (`untieJoinLinkBindings`). Nothing to clear: the
// binding went with the code.
function _consumeCodeBoundEnroll(userId, compId, req) {
  if (!compId) return;
  // STAFF ON A STAFF-COMPETE EVENT ARE ASKED FIRST. Joining such an event makes a
  // staff member (the `staff` tag or any admin tier) a competitor, locked out of
  // editing it — which is why the SPA asks "Compete in this event?" before it
  // sends the explicit join. A code bound to the event by the link the sign-in
  // came from must not answer that question for them, so it enrols nobody here;
  // the client's confirm then joins (or declines) through the ordinary join door.
  try {
    const comp = getCompetition(compId);
    if (comp) {
      const { staffCompeteOn } = require("./staff-compete");
      const { isStaff } = require("./user-tags");
      const row = db.prepare("SELECT role FROM users WHERE id=?").get(userId);
      // RBAC — every admin-class role (built-in or custom) is a staff tier.
      const staffTier = !!row && require("./rbac").roleClass(row.role) !== "none";
      if (staffCompeteOn(comp) && (staffTier || isStaff(userId))) return;
    }
  } catch (_) { return; }   // unreadable: enrol nobody rather than answer for them
  _enrolAtSignIn(userId, compId, () => {}, req);
}

// WOULD REDEEMING A CODE BOUND TO `comp` ENROL THIS ACCOUNT IN IT? The sign-in
// code mail promises "Signing in with it in the browser where you asked for it
// also joins you to <event>" (lib/email.js `sendLoginCodeEmail`), and the promise
// must be what the redeem's code-bound enrolment does there (in any other browser
// the redeem ignores the binding: routes/auth.js `_sessionNamedEvent`). This is a HAND-KEPT COPY of that ladder, in its
// order: the redeem's condition that the event's join link is live
// (`liveJoinLinkTag`: switched on, the event still taking joins), the
// staff-on-a-compete-event skip in `_consumeCodeBoundEnroll` above, then
// `_enrolAtSignIn`'s refusals (any admin-class role; a staff spectator or
// challenge author, `staffRowRefusal`; somebody who already played an event now
// taking late entries). It also says no for somebody already in the event, whom
// the redeem adds to nothing. At the request the link is the one just asked
// through, so it is live; switching it off or replacing it before the redeem
// unties the code (sweep #391), which is why the mail says the join holds only
// while the link is open. A change to either ladder must be made here too:
// tests/email-scenarios.spec.js checks the mail against the redeem's outcome for
// a participant, an organiser, a member and staff where staff compete, and
// tests/sign-in-code-delivered.spec.js for somebody who took part, through a late
// window, and a challenge author; a link no longer live and a staff spectator are
// unchecked. Read-only. Other enrolments at sign-in (a pending join marker, a
// claimed invitation) are not the bound event's and are not promised.
function codeBoundJoinWillEnrol(userId, comp) {
  try {
    if (!liveJoinLinkTag(comp)) return false;
    const u = db.prepare("SELECT id, nickname, first_name, last_name, email, role FROM users WHERE id=?").get(userId);
    if (!u) return false;
    if (db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, u.id)) return false;
    if (require("./rbac").roleClass(u.role) !== "none") return false;
    const { staffCompeteOn } = require("./staff-compete");
    if (staffCompeteOn(comp) && require("./user-tags").isStaff(userId)) return false;
    if (staffRowRefusal(u, comp)) return false;
    if (competitionAdmission(comp) === "late" && lateWindowAdmissionDenied(comp, u.id, competitionEffectiveEnd(comp))) return false;
    return true;
  } catch (_) { return false; }   // unreadable: promise nothing
}

function _enrolAtSignIn(userId, compId, clearMarker, req) {
  try {
    const u = db.prepare("SELECT id, nickname, first_name, last_name, email, role FROM users WHERE id=?").get(userId);
    if (!u) return;
    // AN ADMIN-TIER SIGN-IN THROUGH A JOIN LINK ENROLS NOBODY (operator ruling,
    // 17 Nov 2026): an organiser opening the link to check it is not a
    // participant, and the enrolment would also create a Checkmarx One account.
    // Every admin-class role, built-in or custom; the marker goes with it. One
    // who wants to play joins on purpose through the event's join door.
    if (require("./rbac").roleClass(u.role) !== "none") { clearMarker(); return; }
    const comp = getCompetition(compId);
    if (!_competitionAcceptsSelfEnroll(comp)) {
      // gone / ended → clear the marker (nothing to enroll into).
      clearMarker();
      return;
    }
    // concurrency-cache audit (#7): enroll FIRST, then clear the marker. The old
    // order cleared the marker as its own committed statement BEFORE the enroll
    // txn — so a transient enroll failure (SQLITE_BUSY etc.) was swallowed AFTER
    // the marker was gone, permanently dropping the deferred self-enrollment with
    // no retry. _selfEnrollEnrollTxn is INSERT-OR-IGNORE idempotent, so a process
    // death between the enroll commit and this marker-clear is safe: the next
    // login re-runs the (no-op) enroll and clears the marker.
    // v8.12.0 — the staff row-writer rule. A spectator gets no row and the
    // marker is cleared (they can enter the event regardless); an AUTHOR of one
    // of its challenges cannot compete there, and the marker is cleared too —
    // retrying on every login would fail identically for ever, the reasoning
    // the full-event branch below already gives. Logged, since there is nobody
    // to tell at the moment it happens.
    const _refusal = staffRowRefusal(u, comp);
    if (_refusal) {
      clearMarker();
      if (_refusal !== "spectator") {
        console.warn(`consume pending self-enroll skipped: ${u.email} authored ${_refusal.authored.length} challenge(s) assigned to "${comp.name}" and cannot compete there`);
      }
      return;
    }
    // v8.12.6 — through the late-entry window, somebody who played the event before
    // it ended is not given a new row (the one door-independent rule). A HELD row
    // is not a new row, so it is not asked about.
    if (competitionAdmission(comp) === "late") {
      const _held = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, u.id);
      if (!_held && lateWindowAdmissionDenied(comp, u.id, competitionEffectiveEnd(comp))) {
        clearMarker();
        log.warn({ tag: "self_enroll", user_id: u.id, competition_id: comp.id, code: "late_entry_took_part" },
          "consume pending self-enroll skipped: the participant took part in the event before it ended and cannot rejoin it as a late entrant");
        return;
      }
    }
    let didInsert;
    try {
      didInsert = _selfEnrollEnrollTxn(u, comp, req ? reqContext(req) : {}, u.email || "self_enroll");
    } catch (e) {
      // v8.1.0 (PR 30) — a FULL event is a settled answer, not a transient
      // failure, so the marker is cleared exactly as the gone/ended branch above
      // clears it. Leaving it would retry on every single login for ever, failing
      // identically each time — and the enclosing catch below would swallow it,
      // so the participant would never learn and neither would the operator.
      //
      // This is the one case where the deferred path and the live join path give
      // different-looking outcomes for the same condition, and that is right: the
      // live path can tell the visitor to their face, whereas here there is nobody
      // to tell at the moment it happens.
      throw e;
    }
    clearMarker();
    if (didInsert) _selfEnrollSideEffects(u, comp);
  } catch (e) {
    console.error("consume pending self-enroll failed:", (e.message || "").replace(/[\r\n]/g, ""));
  }
}

module.exports = {
  _genSelfEnrollToken, _genJoinCode, _resolveJoinCode,
  _resolveJoinableComp, _selfEnrollEnrollTxn, staffRowRefusal,
  _selfEnrollSideEffects, _consumePendingSelfEnroll, _consumeCodeBoundEnroll, codeBoundJoinWillEnrol,
  joinLinkTag, liveJoinLinkTag, untieJoinLinkBindings,
  SELF_ENROLL_GRACE_MS, verificationGraceState,
};
