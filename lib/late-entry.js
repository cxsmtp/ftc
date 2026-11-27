"use strict";

// LATE ENTRIES — the walk-up who arrives as the stand is closing.
//
// A Booth Event is a stand in a hall for a few hours. Somebody scans the QR at
// 16:55 for an event that closes at 17:00, and by the time they have registered
// and signed in the event is over: they hold an account, an enrolment and no way
// to play. This module is the rule that keeps that door open for a bounded window
// afterwards, and the rule that says whose scores are ranked separately because of
// it.
//
// PURE, AND THAT IS LOAD-BEARING. It requires only ./event-policy (itself a leaf),
// so a spec may require it at module scope — the v7.20.2 rule that no spec may bind
// app code which opens the database at require time — and, more importantly here,
// so lib/competitions.js can import it without a cycle. Every function takes the
// EFFECTIVE END as an argument rather than resolving it: `competitionEffectiveEnd`
// lives in lib/competitions.js, which requires ./db, and importing that here would
// close the loop. It is also the honest signature — the effective end is a fact
// about the event that four different writers can move (see below), and a caller
// that already holds it must not be able to pass a different one by accident.
//
// ── THE THREE DECISIONS, AND WHY EACH IS SHAPED THIS WAY ────────────────────────
//
// 1. THE DEADLINE IS DERIVED FROM ONE COLUMN, NOT STORED-PLUS-A-FLAG.
//
//    The requirement is "48 hours after the event finishes, and it moves when the
//    finishing time moves, unless the admin pinned it". The obvious encoding is a
//    stored timestamp plus an `is_overridden` boolean, and it is the wrong one: two
//    columns for one answer, whose failure mode is a writer moving the end time and
//    forgetting the flag, leaving a deadline that silently stopped following. That
//    is the v8.1.0 (PR 16) `isOpenEnded` argument — "a flag is a second source of
//    truth whose failure mode is a writer moving the deadline without clearing it".
//
//    So NULL means "follow the end", and a value means "the admin chose this". One
//    column carries both the override marker and the override, exactly as
//    `registration_field_policy` does (NULL = the kind's defaults, JSON = an admin's
//    configuration). The auto case is then a DERIVATION rather than a recompute, so
//    there is no list of end-moving writers to keep in step and no migration of
//    derived values — which matters, because that list is long and the codebase has
//    measured a hand-written enumeration of writers rotting from forty-nine to seven
//    (the leaderboard-cache note in CLAUDE.md).
//
// 2. THE WINDOW EXTENDS PLAY; IT DOES NOT EXTEND THE EVENT.
//
//    Nothing here touches `competitionStatus` / `_singleSlotStatus` /
//    `competitionEffectiveEnd`. The event ENDS when it ends: the main leaderboard is
//    final at that instant, ordinary participants stop submitting, certificates
//    become mintable, the team board freezes, the scheduler records the transition,
//    and every status-derived guard (the kind-change lock, the start-time lock, the
//    trusted-network bypass window) behaves exactly as before.
//
//    Widening those two functions instead would have been one line and is the
//    trap: they feed `competitionFullyEnded`, `_mintEligibility`, `revealSolution`,
//    `eventKindChangeLock`, `startTimeChangeLock` and lib/comp-allowlist's
//    rate-limit bypass. An event that read "live" for an extra 48 hours would make
//    certificate minting refuse for EVERYONE, hold the trusted-network bypass open
//    two days past the venue's booking, and keep a settled board mutable.
//
// 3. LATENESS IS DERIVED PER READ, AND FROZEN ONLY ONTO A CERTIFICATE.
//
//    Whether somebody is a late entrant is a function of when they joined, when the
//    event ended, and whether they had finished by then — all three of which can
//    move (an admin extends the duration and the event revives; they press End Now
//    and it ends early; the toggle flips). A stored `late_entrant` column would need
//    a writer at every one of those moments, which is the "three writers agreeing is
//    one writer away from silently false" failure this codebase has paid for. So it
//    is computed, from `isLateEntry` below, wherever it is needed.
//
//    The ONE exception is `achievement_badges.late_entrant`, frozen at mint beside
//    `basis` / `rank` / `score_snapshot` / `date_snapshot` — for that column's own
//    reason: a certificate is an artefact that leaves the building, and re-deriving
//    its wording would let a later schedule edit relabel a document somebody has
//    already downloaded, printed and filed, with the verification page confirming
//    the new version as correct.

// v8.12.8 — `eventKindPhrase` joins it: lib/event-policy is a leaf (it requires only
// ./registration-fields, which requires nothing), so this module stays pure.
const { eventPolicy, eventKindPhrase } = require("./event-policy");

// WHO COUNTS AS HAVING ARRIVED LATE: somebody who JOINED AFTER THE EVENT'S
// EFFECTIVE END, and nobody else.
//
// A ONE-WAY DOOR (CLAUDE.md, *Decisions taken once*), RE-DECIDED BY THE OPERATOR
// on 29 Oct 2026: there was a ten-minute pre-window before the end, which moved
// people who joined while the event was LIVE off the main board and onto the late
// one. It is gone. Anyone who joined while the event was live is an ordinary
// participant (main board, podium, certificate at the end). Certificates already
// issued keep their frozen `late_entrant` fact; nothing re-derives them.

// The default span of the window, measured from the event's EFFECTIVE end.
const LATE_ENTRY_DEFAULT_SPAN_MS = 48 * 60 * 60_000;

// The widest window an admin may pin, as an API boundary rule rather than a typo
// defence — the form's own confirmation is the typo defence, exactly as
// `DEADLINE_MAX_SPAN_MINUTES` splits those two jobs for a Program.
//
// Thirty days, and the reason is what the kind IS: a Booth Event is a stand in a
// hall for an afternoon, and a late window is for the person who arrived at closing
// time, not for a second event running a quarter later. An organiser who wants the
// stand open for longer wants a longer event.
const LATE_ENTRY_MAX_SPAN_MS = 30 * 24 * 60 * 60_000;

/**
 * Does this event run late entries at all?
 *
 * TWO CLAUSES, ANSWERING DIFFERENT QUESTIONS — the `autoEndOnAllSolvedApplies`
 * shape, and for the same reason. The POLICY clause is a PROHIBITION: a Competition
 * and a Program are signed up for in advance, from a desk, so neither has a
 * closing-time walk-up to catch and neither may run this however its column reads.
 * The COLUMN is the per-event switch the operator asked for, which defaults ON.
 *
 * Reading the prohibition at the gate rather than trusting three writers to agree
 * on a stored 0 is what makes "no Competition ever runs a late window" a theorem
 * instead of a convention — the v8.3.11 argument, one feature over.
 */
function lateEntryAllowed(comp) {
  if (!comp) return false;
  if (eventPolicy(comp).lateEntry !== "allowed") return false;
  return !!comp.late_entry_enabled;
}

/**
 * When the late window closes, or null if this event runs none.
 *
 * `effEnd` is the event's EFFECTIVE end (`competitionEffectiveEnd`), never
 * `start_time + duration_minutes`: the two differ whenever an organiser presses End
 * Now, and the operator's answer is that the window follows the actual end however
 * the event finished. A pinned deadline is returned as stored — the admin chose that
 * date, and an End Now does not un-choose it.
 */
function lateEntryDeadline(comp, effEnd) {
  if (!lateEntryAllowed(comp)) return null;
  if (comp.late_entry_deadline_at) {
    const pinned = new Date(comp.late_entry_deadline_at);
    // A row whose column is unparseable falls back to the derived answer rather
    // than poisoning every downstream comparison with NaN. `assigned_at` shows why
    // this is not paranoia: it is operator-controlled through the participant
    // import, which type-guards it and does not date-guard it.
    if (Number.isFinite(pinned.getTime())) return pinned;
  }
  if (!effEnd) return null;
  const end = effEnd instanceof Date ? effEnd : new Date(effEnd);
  if (!Number.isFinite(end.getTime())) return null;
  return new Date(end.getTime() + LATE_ENTRY_DEFAULT_SPAN_MS);
}

/**
 * The instant AFTER which arriving counts as arriving LATE: the event's effective
 * end itself (joining exactly at the end is still joining the live event, the same
 * inclusive end `_singleSlotStatus` uses). Null when this event runs no late window.
 */
function lateEntryJoinCutoff(comp, effEnd) {
  if (!lateEntryAllowed(comp) || !effEnd) return null;
  const end = effEnd instanceof Date ? effEnd : new Date(effEnd);
  if (!Number.isFinite(end.getTime())) return null;
  // An event that ENDED before this installation took the current rule keeps the
  // rule it ended under: joining in its last ten minutes counted as late (the
  // instant returned is one millisecond before that pre-window, so the strict
  // "joined after the cutoff" test every caller applies admits its first instant).
  if (_legacyRuleFloorMs !== null && end.getTime() < _legacyRuleFloorMs) {
    return new Date(end.getTime() - LEGACY_JOIN_GRACE_MS - 1);
  }
  return new Date(end.getTime());
}

// THE RULE AN EVENT ENDED UNDER (9.1.5). Lateness is derived on every read, never
// stored, so the 29 Oct 2026 re-decision (above) also moved, on upgrade, everyone
// who had joined a FINISHED event in its last ten minutes from the late entrants
// onto its final main board, with whatever they scored after the end: a 1st Place
// certificate already issued could be pushed down and a second person collect the
// same place. A finished result never changes on an upgrade, so an event whose
// effective end precedes the moment this installation adopted the current rule
// keeps the old ten-minute pre-window. db.js records that moment once
// (`settings.late_entry_rule_floor_at`) and hands it here at boot; unset (a
// process that never opened the database), every event follows the current rule.
const LEGACY_JOIN_GRACE_MS = 10 * 60_000;
let _legacyRuleFloorMs = null;
function setLateEntryRuleFloor(value) {
  const t = value == null ? NaN : Date.parse(value);
  _legacyRuleFloorMs = Number.isFinite(t) ? t : null;
}
function lateEntryRuleFloor() {
  return _legacyRuleFloorMs === null ? null : new Date(_legacyRuleFloorMs);
}

/**
 * Is the late window OPEN right now — i.e. is the event over, and is the deadline
 * still ahead?
 *
 * `nowMs` is passed in rather than read, so every caller in one request answers
 * from one clock and a test can drive the boundary without a clock shim.
 *
 * WRITTEN POSITIVELY, and both halves matter. The window is open strictly AFTER the
 * effective end (before it the event is simply live, and there is nothing to
 * extend) and up to and including the deadline — the same inclusive end
 * `_singleSlotStatus` uses, so the two boundaries cannot disagree by a millisecond.
 */
function lateEntryWindowOpen(comp, effEnd, nowMs) {
  const deadline = lateEntryDeadline(comp, effEnd);
  if (!deadline || !effEnd) return false;
  const end = effEnd instanceof Date ? effEnd : new Date(effEnd);
  if (!Number.isFinite(end.getTime())) return false;
  const n = Number.isFinite(nowMs) ? nowMs : Date.now();
  return n > end.getTime() && n <= deadline.getTime();
}

/**
 * IS THIS PARTICIPANT A LATE ENTRANT?
 *
 * Two facts decide it, and the caller supplies both because they come from
 * different tables:
 *
 *   assignedAt — `competition_users.assigned_at`, the ONE timestamp recording when
 *                a membership row was created. Every enrolment path writes it and
 *                nothing updates it, so it is genuinely "when they joined". Note
 *                that every insert is INSERT OR IGNORE: somebody an admin enrolled
 *                last week who scans the QR at 16:55 keeps LAST WEEK's value and is
 *                correctly NOT a late entrant, because they did not join late — they
 *                joined last week and came back.
 *
 *   finishTime — their last correct submission IF they have solved every published
 *                assigned challenge, else null. This is exactly what the leaderboard
 *                builder's `finishMap` already holds, which is why the carve-out
 *                below costs no extra query on the board path.
 *
 * The finish-time carve-out is now a backstop only: with the join test strictly
 * after the end, a late entrant cannot have finished at or before it unless an
 * admin re-timed the schedule underneath them, and then the ordinary board is
 * where they belong.
 *
 * The comparison is inclusive at the end for the same reason `_singleSlotStatus`
 * is: a submission landing on the closing instant was accepted, so it counts.
 */
function isLateEntry(comp, effEnd, { assignedAt, finishTime } = {}) {
  const cutoff = lateEntryJoinCutoff(comp, effEnd);
  if (!cutoff) return false;
  if (!assignedAt) return false;
  const joined = new Date(assignedAt).getTime();
  // An unparseable `assigned_at` (the participant import type-guards this field and
  // does not date-guard it) must not be read as "joined at the epoch" or as NaN
  // sliding past a comparison — it means we do not know, and not-late is the answer
  // that leaves them exactly where they are today.
  if (!Number.isFinite(joined)) return false;
  // Strictly AFTER the end: a join at or before it was a join of the live event.
  if (joined <= cutoff.getTime()) return false;
  if (finishTime) {
    const end = effEnd instanceof Date ? effEnd : new Date(effEnd);
    const fin = new Date(finishTime).getTime();
    if (Number.isFinite(fin) && Number.isFinite(end.getTime()) && fin <= end.getTime()) return false;
  }
  return true;
}

/**
 * The reference end of a LATE entrant's solve window.
 *
 * The main board's rule is "your finish time if you finished, else the event's end
 * if it is over, else now". A late entrant's event is over by construction, so that
 * rule hands them a reference end EARLIER than their own start — `solveTimeMs` goes
 * negative and the unconditional v7.21.3 clamp turns it into ZERO, which is the best
 * possible value on the sole score-tie tie-break. Every late entrant would win every
 * tie, and the clamp's own comment names this class ("a login_time stamped after the
 * participant's finish").
 *
 * So the same rule is applied with THEIR end: the late deadline while it is still
 * ahead of them, i.e. `now` while the window is open and the deadline once it has
 * closed. Returns null when there is no late window to measure against, which leaves
 * the caller on the ordinary rule.
 *
 * v8.12.7 — the leaderboard builder floors this at the entrant's last correct
 * answer, because a deadline can move into the past after answers were accepted
 * against it. That floor needs the submissions, so it lives with the caller and this
 * function stays pure; see the reference-end comment in lib/leaderboard.js.
 */
function lateEntryRefEndMs(comp, effEnd, nowMs) {
  const deadline = lateEntryDeadline(comp, effEnd);
  if (!deadline) return null;
  const n = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.min(n, deadline.getTime());
}

/**
 * v8.12.8 — THE one sentence for a kind that runs no late-entry window.
 *
 * Three callers: the create refusal, the PUT refusal, and the close refusal
 * (`POST /api/admin/competitions/:id/late-entry/close`). Two hand-written copies
 * of this sentence already existed, byte-identical on the day they were written,
 * and five copies of one sentence is how FROZEN_REMEDY happened (v7.29.0); one
 * definition is how it cannot. A Docs-hygiene scanner holds it at one site.
 *
 * `row` needs only `event_kind` — the phrase comes from the kind table, with its
 * own article, so a kind added later reads as a sentence.
 */
function lateEntryForbiddenMessage(row) {
  return `Late entries are not available for ${eventKindPhrase(row)} — only a Booth Event stays open for a walk-up who arrives as it closes.`;
}

/**
 * v8.12.8 — the late-entry deadline to STORE when an organiser closes the window
 * at `nowMs` ("Close late entries now").
 *
 * ONE MILLISECOND BEFORE `nowMs`, because the window's end is INCLUSIVE
 * (`n <= deadline` in `lateEntryWindowOpen`): storing `nowMs` itself would leave
 * the window open for every request handled in the same millisecond after the
 * close commits — the close route's own response flag included.
 *
 * NEVER AT OR BEFORE THE EFFECTIVE END. `_validateLateDeadline` (routes/
 * competitions.js) refuses a deadline `<= end` on EVERY save that sends it, and
 * the superadmin's editor echoes the stored pin verbatim (v8.12.7) — so a close
 * stored AT the end would make every later save of that event 400. The close is
 * reached only with the window open (`nowMs > end`), so the result lies in
 * `(end, nowMs]`; the floor is what keeps a same-millisecond close valid.
 *
 * The 30-day cap is NOT applied: a close only ever SHORTENS a window, and the
 * cap bounds how long one may stay open.
 */
function lateEntryCloseInstantMs(effEnd, nowMs) {
  const end = effEnd instanceof Date ? effEnd.getTime() : new Date(effEnd).getTime();
  return Math.max(end + 1, nowMs - 1);
}

module.exports = {
  LATE_ENTRY_DEFAULT_SPAN_MS,
  LATE_ENTRY_MAX_SPAN_MS,
  lateEntryAllowed,
  lateEntryDeadline,
  lateEntryJoinCutoff,
  setLateEntryRuleFloor,       // 9.1.5 — db.js, at boot
  lateEntryRuleFloor,
  lateEntryWindowOpen,
  isLateEntry,
  lateEntryRefEndMs,
  lateEntryForbiddenMessage,   // v8.12.8
  lateEntryCloseInstantMs,     // v8.12.8
};
