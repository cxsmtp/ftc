"use strict";

// Competition + Session domain helpers, plus the per-competition row cache.
// (Domain: Competition / Session. Code/table terms: `competitions`,
// `competition_timeslots`.) Pure read helpers + status math; deps: db + now.
// Mutators elsewhere read-through then call _invalidateCompetitionCache.

const db = require("../db");
// v8.12.6 — `formatEmailDate` joins `now`: lib/time.js is pure, and the one
// late-entry mail line (`lateEntryMailLine`, below) is rendered here so the
// three mail builders that need it cannot word it three ways.
const { now, formatEmailDate } = require("./time");
// lib/event-policy is dependency-free (it requires nothing at all), so this
// edge cannot form a cycle however many modules reach for it.
const { eventPolicyForWire, eventPolicy, clockStartsAtFirstOpen } = require("./event-policy");
// v8.6.0 — the late-entry window. PURE (only ./event-policy at module scope), so
// this edge runs one way and there is no cycle back into this file; that is why
// every function there takes the effective end as an ARGUMENT rather than
// resolving it. See lib/late-entry.js's header.
const { lateEntryAllowed, lateEntryDeadline, lateEntryWindowOpen, lateEntryJoinCutoff, isLateEntry, lateEntryRefEndMs, lateEntryForbiddenMessage, lateEntryCloseInstantMs } = require("./late-entry");
const { notQualifyingSql, qualifyingKeyOfTag, compareQualifyingKeys, QUALIFYING_NUMBER_LEVEL } = require("./qualifying");   // event team reports (pure module)

// audit v7.7.27 (M2/M8) — SQL predicate: a users row (alias `u`) counts as an
// ACTIVE participant for leaderboard membership AND the all-solved auto-end /
// revive scans. Approved, and EITHER verified OR still inside the 48h
// verification grace (v7.2.0 — such users can log in, select the comp, and
// submit, so they must be ranked and must hold a comp open; a desk-code sign-in
// of an unverified account stamps it, lib/self-enroll.js). Pre-fix all these
// sites used a bare `u.verified=1 AND u.approved=1`, which silently dropped
// grace players from every board and let a comp auto-end while they were mid-
// challenge. The trailing `?` binds now().toISOString(): grace deadlines are
// stored ISO strings, so compare ISO-to-ISO — NOT SQLite datetime('now'), whose
// space separator sorts wrong against the ISO 'T'/'Z' form. Callers append the
// ISO-now to their params (every existing `?` precedes this one in SQL text).
// Centralised here (a leaf both leaderboard.js + self-enroll.js already import)
// so the five consumers can't drift. Mirror of verificationGraceState's
// active-grace test, expressed in SQL.
const ACTIVE_PARTICIPANT_SQL =
  "u.approved=1 AND (u.verified=1 OR (u.self_enroll_grace_until IS NOT NULL AND u.self_enroll_grace_until > ?))";

const _competitionCache = new Map(); // id → { row, fetchedAt }
// 1s TTL: tight enough that a concurrent end-now / auto-end transition can't
// emit a duplicate event from a stale ended_at=NULL read; call volume is still
// dominated by cache hits (leaderboard + /api/status polling).
const _COMPETITION_CACHE_TTL_MS = 1_000;
// LRU size cap so the cache can't grow unbounded over a long-running process.
const _COMPETITION_CACHE_MAX = 5_000;

function getCompetition(id) {
  if (!id) return null;
  const cached = _competitionCache.get(id);
  const nowMs = Date.now();
  if (cached && (nowMs - cached.fetchedAt) < _COMPETITION_CACHE_TTL_MS) {
    // Return the cached row as-is. Mutators never hand out this reference —
    // they read-through the cache for the update and then invalidate.
    return cached.row;
  }
  const row = db.prepare("SELECT * FROM competitions WHERE id=?").get(id) || null;
  // Evict the oldest entry when the cap is hit (Map iteration is insertion-
  // ordered in V8). Skip when refreshing an existing key (no growth).
  if (!_competitionCache.has(id) && _competitionCache.size >= _COMPETITION_CACHE_MAX) {
    const oldest = _competitionCache.keys().next().value;
    if (oldest !== undefined) _competitionCache.delete(oldest);
  }
  _competitionCache.set(id, { row, fetchedAt: nowMs });
  return row;
}

// getCompetition is SELECT *, so any handler that spreads its result into a
// response would ship the per-competition secrets (self_enroll_token + the
// cxone API key). Strip both before they cross the wire; the non-secret
// self_enroll_enabled flag stays on the row (the retired instant-join switch is
// stripped).
function _compWire(comp, opts) {
  if (!comp) return comp;
  // v7.16.0 — trusted_network_ips is stripped here too. It is not a credential,
  // but it names a venue's public address, and _compWire feeds responses that are
  // easy to reuse in a participant-facing context later. GET /api/admin/competitions
  // SELECTs it explicitly; that is the one deliberate exposure.
  // v8.4.0 — `registration_field_policy` joins the named strips, for the reason
  // the admin list gives at its own destructure: the NORMALISED states ride
  // `policy.registration_fields`, and shipping the raw blob beside them would put
  // two representations of one answer on one payload — the raw one being the copy
  // that knows nothing about the kind's defaults or the required-implies-shown
  // invariant. Note the ORDER below: `eventPolicyForWire` is handed `comp`, not
  // `rest`, precisely because it has to READ this column after it has been
  // stripped from the projection.
  // v8.15.0 — `certificate_config` (the raw per-event certificate design layer)
  // joins them: not a secret, but its one reader is the dedicated GET
  // .../certificate-config, which returns it beside the merged design. The admin
  // list carries only the boolean `certificate_config_overridden`.
  // `self_enroll_allow_instant` is a RETIRED switch (operator ruling,
  // 14 Nov 2026): a column nothing reads, so no response names it.
  const { self_enroll_token, cxone_api_key, trusted_network_ips, registration_field_policy, certificate_config,
    self_enroll_allow_instant, ...rest } = comp;
  // v8.1.0 (PR 12) — strip `_`-prefixed keys STRUCTURALLY, which makes the
  // underscore prefix load-bearing here exactly as v7.28.0's `stripInternal` made
  // it load-bearing on the leaderboard. The three named fields above are a
  // DENY-LIST over a `...rest` spread: correct for the three that exist, and it
  // ships the fourth for free. A derived internal hung on a competition row (the
  // callers all pass `SELECT *` rows they are free to annotate) would otherwise
  // reach the wire silently. Nothing is `_`-prefixed today; that is the point —
  // the rule exists before the field that needs it.
  for (const k of Object.keys(rest)) if (k.charCodeAt(0) === 95) delete rest[k];
  // v8.1.0 (PR 12) — the resolved policy is attached HERE rather than at each of
  // the four handlers that spread this helper, so the next competition response
  // cannot forget it (the v7.21.9 `opts.fresh` rule: move the thing that must not
  // be forgotten INSIDE the shared helper). Every caller feeds this a
  // `getCompetition` row, i.e. `SELECT *`, so `event_kind` is always present; a
  // partial row throws from eventKind() by design, which is the guard announcing
  // that the caller under-selected rather than silently serving Competition
  // semantics to a Booth Event.
  // v8.4.0 — `comp`, NOT `rest`. `eventPolicyForWire` reads
  // `registration_field_policy`, which has just been destructured OFF `rest` —
  // so passing `rest` would make
  // the projection throw (the strict-missing-column guard) on every admin
  // response. It is the guard working as designed, and this is the one call site
  // where the strip and the read are the same statement apart.
  rest.policy = eventPolicyForWire(comp);
  // v8.3.0 — WHY the kind control is not offered, computed from the SAME
  // predicate the PUT enforces. `null` means the admin may change it.
  //
  // It rides `_compWire` for the reason the policy above does: so the next
  // competition response cannot forget it. `opts.slots` is passed by the admin
  // LIST, which already batch-loads every competition's timeslots in one query
  // (D-01) — without it this helper would re-fetch per row and reintroduce the
  // N+1 that fix removed. Every other caller holds a single row and can afford
  // the indexed read.
  const _lock = eventKindChangeLock(rest, opts && opts.slots);
  rest.event_kind_locked = _lock ? _lock.reason : null;
  // v8.3.10 — WHY the start-time control is not offered, from the SAME predicate
  // the PUT and the DELETE enforce. `null` means the caller may change it.
  //
  // It rides here for the reason the two above do: so the next competition
  // response cannot forget it. `opts.isSuperAdmin` FAILS CLOSED — a caller that
  // does not pass it gets `requires_superadmin`, which withholds the control
  // rather than offering one the save would refuse.
  const _sLock = startTimeChangeLock(rest, {
    slots: opts && opts.slots,
    isSuperAdmin: !!(opts && opts.isSuperAdmin),
  });
  rest.start_time_locked = _sLock ? _sLock.reason : null;
  // v8.6.0 — the RESOLVED late-entry deadline, and whether its window is open now.
  //
  // Both ride here for the reason the three above do: so the next competition
  // response cannot forget them. `late_entry_deadline_at` (the raw column) already
  // ships in `...rest`, and it is NOT enough on its own — NULL there means "follow
  // the event's end", which the admin form has to RESOLVE to show a date and the
  // participant client has to resolve to show a countdown. Deriving it on the
  // client would be a second copy of the rule, in a graph that cannot import the
  // module that owns it.
  //
  // NULL when this event runs no late window at all, which is every Competition,
  // every Program and any Booth Event with the toggle off — so a client testing the
  // resolved value gets one answer rather than having to re-ask the policy.
  //
  // v8.12.8 — ONE CLOCK for every late-entry derivation on this row. The window
  // flag, the switch lock's conditional remedy and `can_close_late_entries` below
  // all ask "is the window open NOW?", and reading the clock once per question
  // could let one row answer yes and no about the same instant at the deadline.
  const _nowMs = now().getTime();
  const _leEnd = competitionEffectiveEnd(rest, opts && opts.slots);
  const _leDeadline = lateEntryDeadline(rest, _leEnd);
  rest.late_entry_deadline_effective = _leDeadline ? _leDeadline.toISOString() : null;
  rest.late_entry_window_open = lateEntryWindowOpen(rest, _leEnd, _nowMs);
  // v8.12.6 — WHY the late-entry switch is not offered (`"ended"`), or null. The
  // SAME predicate the PUT refuses with (`lateEntrySwitchLock`), riding here for
  // the reason every flag above does.
  rest.late_entry_locked = (lateEntrySwitchLock(rest, opts && opts.slots, _nowMs) || {}).reason || null;
  // v8.12.0 — WHY the staff-compete switch is not offered, from the SAME predicate
  // the PUT enforces (`null` = changeable); and whether THIS actor competes here,
  // which is what withholds every other control on the row. Both ride here for
  // the reason the flags above do. `opts.actorId` absent means "nobody", so a
  // caller that forgets it gets `competing: false` — the safe direction for a
  // flag whose only consumer withholds affordances the server refuses anyway.
  Object.assign(rest, staffCompeteFlags(rest, { slots: opts && opts.slots, actorId: opts && opts.actorId }));
  // v8.12.8 — MAY THIS ACTOR CLOSE THE LATE-ENTRY WINDOW NOW? From the SAME
  // predicate the close route refuses with (`lateEntryCloseState`), plus the
  // competitor lock the route asks ABOVE it — `competing` is the flag just
  // computed, i.e. `competitorIn(db, competitorIds(req), id)`, the question
  // `competitorEditDenied` asks. Rides here for the reason every flag above does,
  // and is attached AFTER `staffCompeteFlags` because it reads `rest.competing`.
  // A caller that passes no `actorId` gets `competing: false`, which can only
  // OFFER the control — and the route still refuses a competitor.
  rest.can_close_late_entries = lateEntryCloseOffered(rest, { slots: opts && opts.slots, nowMs: _nowMs, competing: rest.competing });
  rest.clock_start_locked = clockStartLock(rest, opts && opts.slots);
  return rest;
}

/**
 * WHY the clock-start choice (`competitions.clock_start`) is not offered:
 * `"started"` once any session (or the event) has started, else null — the
 * SAME predicate the PUT refuses `clock_start_locked` with
 * (`competitionAnySlotStarted`). Attached at both sites an admin row reaches the
 * client from (`_compWire` and the admin list), so the form withholds the
 * control, with its reason, exactly where a save would be refused.
 */
function clockStartLock(row, slots) {
  return competitionAnySlotStarted(row, slots) ? "started" : null;
}

/**
 * v8.12.0 — the two staff-compete row flags, computed for BOTH sites a
 * competition row reaches the admin client from (`_compWire` and the admin
 * list, which does not pass through it). One function so they cannot disagree.
 * Returns ONLY the two flags — never the row — so a caller spreading the result
 * cannot re-ship a column the projection had stripped.
 */
function staffCompeteFlags(row, { slots, actorId } = {}) {
  const _sc = require("./staff-compete");
  const _lock = _sc.switchLock({
    fullyEnded: competitionFullyEnded(row, slots),
    anySlotStarted: competitionAnySlotStarted(row, slots),
  });
  return {
    staff_compete_locked: _lock ? _lock.reason : null,
    competing: _sc.competitorIn(db, actorId || null, row.id),
  };
}

// No-op stub: a TTL cache in front of getTimeslot proved error-prone to
// invalidate; single-row PK lookups on the small competition_timeslots table
// are cheap. Signature preserved so call sites don't change.
function _invalidateCompetitionCache(id) {
  if (id) _competitionCache.delete(id);
  else _competitionCache.clear();
}

function getTimeslot(id) {
  return id ? (db.prepare("SELECT * FROM competition_timeslots WHERE id=?").get(id) || null) : null;
}

function getCompetitionTimeslots(competitionId) {
  return db.prepare("SELECT * FROM competition_timeslots WHERE competition_id=? ORDER BY start_time").all(competitionId);
}

function hasTimeslots(competitionId) {
  return db.prepare("SELECT 1 FROM competition_timeslots WHERE competition_id=? LIMIT 1").get(competitionId) != null;
}

/**
 * The SCHEDULED end of a competition or a timeslot: `start_time + duration_minutes`.
 *
 * v7.29.0 — this concept was hand-rolled at 21 server-side sites and had no name,
 * which is the whole reason for the helper. Fourteen of them wanted exactly this
 * (ignore `ended_at`); five wanted the EFFECTIVE end, which is this clamped by
 * `ended_at`, and they are the four expressions immediately below plus the trap in
 * lib/comp-allowlist.
 *
 * ROW-SHAPED ON PURPOSE. The proposal specified `competitionScheduledEnd(comp, slots)`,
 * but exactly one of the fourteen call sites has a (comp, slots) shape — thirteen
 * hold a single row, and seven of those rows are TIMESLOTS, not competitions. A
 * competition-and-slots signature would have forced eleven callers to fabricate an
 * argument they do not have, and would not fit a timeslot at all.
 *
 * Returns a Date, matching every site it replaces. A caller that needs the
 * effective end wants competitionEffectiveEnd / timeslotEffectiveEnd instead —
 * those are this, clamped.
 */
function scheduledEnd(row) {
  if (!row) return null;
  return new Date(new Date(row.start_time).getTime() + row.duration_minutes * 60_000);
}

/** Status of a single timeslot. */
function timeslotStatus(slot) {
  if (!slot) return null;
  const n = now();
  const start = new Date(slot.start_time);
  const schedEnd = scheduledEnd(slot);
  const effEnd = (slot.ended_at && new Date(slot.ended_at) < schedEnd) ? new Date(slot.ended_at) : schedEnd;
  if (n < start) return "upcoming";
  // v8.12.4 — a STAMPED end is exclusive. Every writer stamps `ended_at` with
  // "now" (none writes a future one), so a slot whose `ended_at` is not in the
  // future HAS ended. The inclusive `n <= effEnd` below read it as still LIVE for
  // the millisecond in which it was stamped — and that is exactly when the
  // session end-now route and the per-session all-solved auto-end ask
  // `competitionFullyEnded`, a few synchronous statements after stamping. So
  // ending the LAST session by hand intermittently left the event un-ended, with
  // no `ended_manually` in its History (the v7.21.9 freeze trap, one function
  // down). Only the equality instant changes: any earlier `ended_at` was already
  // past `effEnd`.
  if (slot.ended_at && new Date(slot.ended_at) <= n) return "ended";
  if (n <= effEnd) return "live";
  return "ended";
}

function timeslotEffectiveEnd(slot) {
  if (!slot) return null;
  const schedEnd = scheduledEnd(slot);
  if (slot.ended_at) {
    const ea = new Date(slot.ended_at);
    return ea < schedEnd ? ea : schedEnd;
  }
  return schedEnd;
}

/** Single-slot competition status from its own fields. */
function _singleSlotStatus(comp) {
  const n = now();
  const start = new Date(comp.start_time);
  const schedEnd = scheduledEnd(comp);
  const effEnd = (comp.ended_at && new Date(comp.ended_at) < schedEnd) ? new Date(comp.ended_at) : schedEnd;
  if (n < start) return "upcoming";
  // v8.12.4 — the same exclusive stamped end as timeslotStatus above. This is
  // the single-slot function, so `ended_at` is never set while the event runs
  // (every revive path clears it).
  if (comp.ended_at && new Date(comp.ended_at) <= n) return "ended";
  if (n <= effEnd) return "live";
  return "ended";
}

/**
 * Competition status — multi-slot:
 *   "upcoming" if ALL slots upcoming, "ended" if ALL ended, else "live".
 * Single-slot (no timeslot rows): single-slot logic. Accepts optional
 * pre-fetched slots to avoid redundant DB queries.
 */
function competitionStatus(comp, slots) {
  if (!comp) return null;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (slots.length === 0) return _singleSlotStatus(comp);
  // Multi-slot: only honour comp.ended_at if manually ended (ended_manually=1).
  if (comp.ended_at && comp.ended_manually) return "ended";
  const statuses = slots.map(s => timeslotStatus(s));
  if (statuses.every(s => s === "ended")) return "ended";
  if (statuses.every(s => s === "upcoming")) return "upcoming";
  return "live";
}

function competitionEffectiveEnd(comp, slots) {
  if (!comp) return null;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (slots.length === 0) {
    const schedEnd = scheduledEnd(comp);
    if (comp.ended_at) {
      const ea = new Date(comp.ended_at);
      return ea < schedEnd ? ea : schedEnd;
    }
    return schedEnd;
  }
  if (comp.ended_at && comp.ended_manually) return new Date(comp.ended_at);
  let latest = null;
  for (const s of slots) {
    const e = timeslotEffectiveEnd(s);
    if (!latest || e > latest) latest = e;
  }
  return latest;
}

/** True if ALL timeslots (or the competition itself for single-slot) have ended. */
function competitionFullyEnded(comp, slots) {
  if (!comp) return false;
  if (comp.ended_at && comp.ended_manually) return true;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (slots.length === 0) return _singleSlotStatus(comp) === "ended";
  return slots.every(s => timeslotStatus(s) === "ended");
}

// ---------------------------------------------------------------------------
// Where a sign-in LANDS — "a participant is asked to choose an event ONCE"
// (v8.3.8, made unconditional in v8.3.15)
//
// THE RULE, in one sentence: a participant who entered an event and did not go
// back to the events list is put straight back into that event at their next
// sign-in — whatever its status, whatever its kind, whatever else they are
// enrolled in, and whichever door they came through.
//
// ONE PREDICATE, THREE CALLERS, and that is the whole point of it existing: the
// two sites that WRITE the marker (`POST /api/select-competition` and
// `POST /api/select-timeslot`) and the one that READS it at sign-in
// (`applyAutoResumeToSession`) must agree about what is resumable, or the
// platform remembers a choice it will then refuse to honour — or, worse, honours
// one it never recorded.
//
// v8.3.15 REMOVED THE STATUS CLAUSE, and with it the `participantPinnedStatus`
// resolver that existed only to feed it. v8.3.8 refused an ENDED event on the
// argument that "the next thing that participant wants is almost never the one
// that is over". That is a guess about intent, made against a participant who
// demonstrably chose that event and never left it — and reviewing a finished
// event (the answers, the final board, a certificate) is an ordinary thing to
// want. The operator's instruction is that the marker wins; being wrong costs one
// click on Events, which is also the thing that clears it.
//
// WHAT STILL REFUSES lives at the READER, not here, because none of it is a
// property of the event: a deleted event has nothing to resume into, and a
// participant who was removed from the marked event would 403 on their next
// request. Both clear the marker and fall through to the sole-event landing.

/**
 * May the platform re-enter this event for this participant on their next
 * sign-in, and keep the marker that says so?
 *
 * Takes the competition ALONE. It deliberately asks nothing about status,
 * enrolment or what else the participant is in — those are the reader's
 * business — so a caller cannot get a different answer by resolving a status
 * differently, which is exactly how the two writers and the reader would drift.
 */
function autoResumeAllows(comp) {
  return !!comp && !!eventPolicy(comp).autoResume;
}

/** True if any timeslot has ever started. Locks leaderboard_mode + task assignments. */
function competitionAnySlotStarted(comp, slots) {
  if (!comp) return false;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (slots.length === 0) {
    const s = _singleSlotStatus(comp);
    return s === "live" || s === "ended";
  }
  return slots.some(s => timeslotStatus(s) !== "upcoming");
}

/** True if any timeslot has ended. Blocks task assignment changes. */
function competitionAnySlotEnded(comp) {
  if (!comp) return false;
  const slots = getCompetitionTimeslots(comp.id);
  if (slots.length === 0) return competitionStatus(comp) === "ended";
  return slots.some(s => timeslotStatus(s) === "ended");
}

// ext-audit v7.21.1 — THE ONE definition of "this challenge's scoring is frozen".
//
// A competition whose session has ended has final standings. Five routes write to
// `tasks`, and before this they implemented that rule four different ways: the
// task PUT froze correct_answer/answer_type/difficulty but NOT `active`; restore
// froze all five columns; publish, the visibility toggle and the import overwrite
// froze nothing at all. The gap was not theoretical — flipping `active` or
// `status` on a task in an ENDED competition re-orders its finished leaderboard,
// because `buildLeaderboardEntries` counts `totalTasks` with
// `t.active=1 AND t.status='published'`, so hiding a challenge retroactively
// turns non-finishers into finishers, and time-to-solve is the SOLE tie-breaker
// on a score tie. Scores do not move; ranks do. The platform even documented the
// workaround: the DELETE guard's own error text told operators to "hide it with
// the visibility toggle instead".
//
// Returns the offending competition (so the caller can name it) or null. Callers
// must use THIS rather than re-deriving the rule — that re-derivation is what
// produced four incompatible versions of it.
function taskFrozenByEndedCompetition(taskId) {
  const ids = db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(taskId).map(r => r.competition_id);
  for (const cid of ids) {
    const comp = getCompetition(cid);
    if (comp && competitionAnySlotEnded(comp)) return comp;
  }
  return null;
}

/**
 * v8.12.6 — DOES THIS EVENT TAKE NEW MEMBERS, AND ON WHAT TERMS?
 *
 *   "open" — upcoming or live: an ordinary membership.
 *   "late" — ENDED, and inside its late-entry window: whoever is added now is a
 *            late entrant by construction (their row is written after the end,
 *            so `isLateEntry` classifies it late), ranked in their own section.
 *   null   — takes nobody: finished with no window, or no such event.
 *
 * ONE PREDICATE FOR EVERY DOOR, and that is why it exists. Before it the doors
 * held four different ideas of "still accepting people" — `status !== "ended"`
 * (the desk shortcut and the group bind dialog), `effEnd > now` (the
 * invitation, which silently DROPPED an event taking late entries and sent the
 * invitation attached to nothing), a manual-end check (the assign door) and an
 * ended early-return (group live-sync) — while the join link alone had the
 * right answer in `_competitionAcceptsSelfEnroll`. Every admission door asks
 * this now, and the join link's predicate delegates to it, so no two doors can
 * disagree about the same event.
 *
 * WRITTEN AS A POSITIVE ALLOW-LIST, so a status invented later fails closed.
 * `lateEntryWindowOpen` is itself an allow-list (the kind's policy, the per-event
 * switch, and `now` strictly after the effective end and no later than the
 * deadline), so the kind rule stays in lib/late-entry.js where it lives.
 *
 * THE WINDOW EXTENDS PLAY, NOT THE EVENT (lib/late-entry.js decision 2), and an
 * admission here never changes that: a "late" admission never revives the event,
 * never touches `ended_at` / `ended_manually` / `updated_at`, and never drops the
 * frozen team board. `nowMs` is passed in so every row of one request answers from
 * one clock; `slots` avoids a per-call timeslot query where the caller has them.
 */
function competitionAdmission(comp, { slots, nowMs } = {}) {
  if (!comp) return null;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  const st = competitionStatus(comp, slots);
  if (st === "upcoming" || st === "live") return "open";
  if (st === "ended"
      && lateEntryWindowOpen(comp, competitionEffectiveEnd(comp, slots), Number.isFinite(nowMs) ? nowMs : now().getTime())) {
    return "late";
  }
  return null;
}

// Self-enrollment is valid while a competition is UPCOMING or LIVE, or — since
// v8.6.0 — ENDED with its late-entry window open: the window is the only way an
// ended event admits anybody. Four callers reach this predicate (the token
// preview, the join code, POST /api/competitions/join and the deferred
// `pending_self_enroll_comp_id` consume at first sign-in).
//
// v8.12.6 — it DELEGATES rather than restating the rule, because every admin door
// now asks the same question (`competitionAdmission`, above) and a second copy of
// the allow-list is how the join link and the assign door came to disagree about
// one event in the first place. The name is kept: four call sites and several
// tests read it.
function _competitionAcceptsSelfEnroll(comp) {
  return competitionAdmission(comp) !== null;
}

function _competitionCacheSize() { return _competitionCache.size; }

// ── Per-competition task numbering ───────────────────────────────────────────
// Assigns stable "<level>.<NN>" numbers (per difficulty bucket) to a comp's
// tasks. Existing numbers are sticky (never renumbered) so additions are stable.
// A QUALIFYING challenge takes the level after the three difficulties, in the
// fixed question order, whatever its stored difficulty: it comes last, and a
// scoring challenge added later still numbers ahead of it (lib/qualifying.js).
const _assignTaskNumbers = db.transaction((compId) => {
  const tasks = db.prepare(
    `SELECT ct.task_id, ct.task_number, t.difficulty, t.title,
            (SELECT MIN(qt.tag) FROM task_tags qt WHERE qt.task_id=t.id AND qt.tag LIKE 'qualifying:%') AS qualifying_tag
     FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
     WHERE ct.competition_id=?
     ORDER BY t.difficulty, t.title`
  ).all(compId);
  const diffLevel = { easy: 1, medium: 2, hard: 3 };
  const _qKey = (t) => qualifyingKeyOfTag(t.qualifying_tag) || "";
  const _qualifying = tasks.filter(t => t.qualifying_tag).sort((a, b) => compareQualifyingKeys(_qKey(a), _qKey(b)));
  // audit v7.7.37 (C12) — counters are keyed by the number's LEVEL PREFIX (1/2/3),
  // not the task's CURRENT difficulty. Numbers are sticky, but difficulty is
  // editable mid-live (the score-edit freeze only kicks in after a slot ends), so a
  // task numbered "1.01" while easy keeps "1.01" after becoming hard. Seeding by the
  // number's own prefix means that "1.01" still reserves the easy/level-1 slot, so a
  // newly-assigned easy task gets "1.02" instead of a duplicate "1.01" (and the hard
  // bucket isn't polluted by the migrated number).
  const counters = { 1: 0, 2: 0, 3: 0 };
  counters[QUALIFYING_NUMBER_LEVEL] = 0;
  for (const t of tasks) {
    if (!t.task_number) continue;
    const m = String(t.task_number).match(/^(\d+)\.(\d+)$/);
    if (!m) continue;
    const level = parseInt(m[1], 10);
    const n = parseInt(m[2], 10);
    if (counters[level] !== undefined && Number.isFinite(n) && n > counters[level]) counters[level] = n;
  }
  const upd = db.prepare("UPDATE competition_tasks SET task_number=? WHERE competition_id=? AND task_id=?");
  for (const t of tasks) {
    if (t.task_number || t.qualifying_tag) continue;
    const level = diffLevel[t.difficulty];
    counters[level]++;
    upd.run(`${level}.${String(counters[level]).padStart(2, '0')}`, compId, t.task_id);
  }
  for (const t of _qualifying) {
    if (t.task_number) continue;
    counters[QUALIFYING_NUMBER_LEVEL]++;
    upd.run(`${QUALIFYING_NUMBER_LEVEL}.${String(counters[QUALIFYING_NUMBER_LEVEL]).padStart(2, '0')}`, compId, t.task_id);
  }
});

// Short-circuit cache: /api/tasks GET calls ensureTaskNumbers on every
// participant poll; without it we took the write lock on every call even when
// there was nothing to update. Once a comp is fully numbered we record it here
// and skip the lock. Busted by _invalidateTaskNumbersCache on task-assignment
// changes. Single process-global Set.
const _taskNumbersAssignedCache = new Set();
function ensureTaskNumbers(compId, comp) {
  if (!comp) return;
  if (_taskNumbersAssignedCache.has(compId)) return;
  const status = competitionStatus(comp);
  if (status !== "live" && status !== "ended") return;
  const unassigned = db.prepare(
    "SELECT 1 FROM competition_tasks WHERE competition_id=? AND (task_number IS NULL OR task_number='') LIMIT 1"
  ).get(compId);
  if (!unassigned) { _taskNumbersAssignedCache.add(compId); return; }
  _assignTaskNumbers(compId);
  _taskNumbersAssignedCache.add(compId);
}
function _invalidateTaskNumbersCache(compId) {
  if (compId) _taskNumbersAssignedCache.delete(compId);
  else _taskNumbersAssignedCache.clear();
}

// v7.24.0 — ordering for a per-competition challenge number.
//
// `task_number` is TEXT of the form "<level>.<NN>" (see _assignTaskNumbers
// above): level is the difficulty bucket 1/2/3 and NN is zero-padded to two
// digits. `ORDER BY ct.task_number` therefore looks right and is wrong twice:
// past 99 challenges in ONE difficulty bucket the padding runs out, so "1.100"
// sorts BEFORE "1.99"; and a BLANK number sorts FIRST, which is reachable
// because ensureTaskNumbers only fills a competition that is live or ended.
// Blanks last, then segment-by-segment numeric comparison.
//
// Mirrored in public/js/ui/format.js (browser-only ESM graph — the DRY_RUN_TAG
// situation), with the two BODIES kept byte-identical so a source diff can
// prove it.
function compareTaskNumbers(a, b) {
  const sa = a === null || a === undefined ? "" : String(a).trim();
  const sb = b === null || b === undefined ? "" : String(b).trim();
  if (!sa || !sb) return sa ? -1 : sb ? 1 : 0;
  const pa = sa.split("."), pb = sb.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] === undefined ? "" : pa[i], xb = pb[i] === undefined ? "" : pb[i];
    const na = Number(xa), nb = Number(xb);
    if (xa !== "" && xb !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}

// Gate for participant-visible challenge content. Returns a truthy descriptor
// when the participant's window has NOT started (upcoming, or a timeslotted
// competition where they haven't picked a slot yet) — callers should withhold
// challenge content / attachments in that case. Returns null once content is
// readable. Depends on requireCompetitionContext having populated req.timeslot
// / req.competitionStatus / req.competition. Shared by the participant task
// routes (server.js) and the attachment-download route (routes/challenges.js).
function participantContentNotStarted(req) {
  const activeStatus = req.timeslot ? timeslotStatus(req.timeslot) : req.competitionStatus;
  if (activeStatus === "upcoming") {
    return { name: req.timeslot ? req.timeslot.name : req.competition.name };
  }
  // v7.2.x (audit, perf) — reuse the slots requireCompetitionContext already
  // loaded onto req.competitionSlots instead of a fresh hasTimeslots() query on
  // these polled task paths.
  if (activeStatus !== "ended" && (req.competitionSlots ? req.competitionSlots.length > 0 : hasTimeslots(req.session.competitionId)) && !req.session.timeslotId) {
    return { name: req.competition.name, needsSlot: true };
  }
  return null;
}

// v7.21.18 — the dry-run marker. ONE definition of the tag STRING, because it
// is not merely a label: it is the stored value in `competition_tags`, the
// default analytics exclusion, the permanent-tag allowlist, and the thing the
// badge route refuses on. It was spelled `internal` in eight server places and
// nine client ones, and renaming it by hand across all seventeen is precisely
// how the copies in v7.21.13 came to disagree.
//
// The value is lowercase because every tag write lowercases (`tag.toLowerCase()`
// in the tag routes), so any other casing would round-trip to this anyway. It
// contains no comma on purpose: the analytics filter ships tags as a
// comma-joined query parameter, and a comma here would split one tag into two.
//
// Renamed from `internal` in v7.21.18; db.js migrates existing rows at boot.
const DRY_RUN_TAG = "test/dry run";

// True if the competition carries the permanent dry-run tag — those are excluded
// from analytics by default and never mint a share badge. Shared by the badge
// mint route + the leaderboard route's badge-eligibility flag.
function isDryRunCompetition(competitionId) {
  return !!db.prepare("SELECT 1 FROM competition_tags WHERE competition_id=? AND tag=?").get(competitionId, DRY_RUN_TAG);
}

// True if the participant actually ENGAGED with THIS competition — made at least
// one submission (any answer, right or wrong) or revealed at least one hint in
// it. (v7.6.x) Gates the generic "participation" share badge so an enrolled
// no-show who never opened a challenge can't claim they took part. Both lookups
// hit a leading-column index (idx_submissions_user_comp / the hint_reveals PK
// prefix) and are scoped by competition_id, so they cannot leak across comps.
//
// ext-audit F2 (v7.7.5): the task_feedback branch was REMOVED. task_feedback
// carries no competition_id (PK is (user_id, task_id)), so the old
// `JOIN competition_tasks ON task_id` counted feedback a user left while
// participating in a DIFFERENT competition that merely SHARES the task — a
// cross-competition false positive that could mint a "participated" badge for a
// comp the user never engaged with. Feedback is also now lifecycle-gated to a
// started comp (PUT /api/tasks/:id/feedback), but only submission/hint are
// genuinely comp-scoped engagement signals, so those alone drive eligibility.
function participantAttempted(userId, competitionId) {
  // Event team reports — an answer to a QUALIFYING question is not taking part,
  // nor is a hint revealed on one (an older one of another type can carry a hint).
  if (db.prepare(`SELECT 1 FROM submissions s JOIN tasks t ON t.id=s.task_id WHERE s.user_id=? AND s.competition_id=? AND ${notQualifyingSql("t")} LIMIT 1`).get(userId, competitionId)) return true;
  if (db.prepare(`SELECT 1 FROM hint_reveals h JOIN tasks t ON t.id=h.task_id WHERE h.competition_id=? AND h.user_id=? AND ${notQualifyingSql("t")} LIMIT 1`).get(competitionId, userId)) return true;
  return false;
}

// v7.21.13 — ONE builder for "which competitions may this participant see, and
// what is each one's status".
//
// There were three, and they had drifted in the way that matters. /api/me got
// the v6.9.17 fix — batch-load every competition's timeslots in ONE `IN (…)`
// query and pass them to competitionStatus / competitionEffectiveEnd, instead
// of letting each of those issue its own getCompetitionTimeslots and turn the
// list into 2N indexed SELECTs. /api/my-competitions batches them too.
// POST /api/login — written from the same shape, and the one that runs when
// three hundred people sign in inside a minute — batched the TAGS and left the
// slot lookups per-competition, so it kept paying the exact cost v6.9.17
// removed, on the burst path where it is worst.
//
// The slots are therefore batched UNCONDITIONALLY here rather than behind a
// flag: status and effective_end always need them, so a caller cannot opt out
// of the fix or forget to pass them through. `withTags` / `withTimeslots` only
// control what is ADDED to the wire shape, which is the one thing the three
// callers genuinely differ on.
// v8.1.0 (PR 12) — `event_kind` joins the ALLOW-list, and omitting it is the
// v7.21.19 F8 defect exactly. This one constant feeds /api/me, /api/my-competitions
// and POST /api/login; the kind chip paints from the first two and the third, so a
// missing column here would let the chip paint on login and VANISH when the 15 s
// poll landed — the same "the badge appeared and then disappeared" report that
// closed F8. It also feeds `policy` below, which throws without it.
// v8.1.0 (PR 34) — `measure_presence` is on the PARTICIPANT wire because the
// participant has to be TOLD. The writes are gated per event, so the disclosure
// is rendered per event too: a blanket privacy notice would be false on every
// event that does not record.
// v8.4.0 — `registration_field_policy` joins the ALLOW-list for the reason the
// PR 12 note above gives, and the guard that caught the omission is the
// strict-missing-column throw in lib/registration-fields.js: `policy` below
// reaches `registrationFieldStates`, which refuses a row that cannot supply the
// column rather than silently serving a Booth Event the kind's defaults.
// Without it EVERY participant sign-in with at least one booth membership
// answered 500 — the "a column-naming SELECT is a list that rots" class, on the
// one constant whose own comment says so.
//
// It is read for `policy` and STRIPPED from the wire by `_compWire`'s named
// destructure; nothing downstream of that projection sees the raw blob.
// v8.12.0 — `staff_compete` joins the allow-list: the picker splits a staff
// member's events into OWN and OTHER, and marks the own ones they COMPETE in.
const _PARTICIPANT_COMP_COLUMNS = "id, name, start_time, duration_minutes, ended_at, reveal_answers_on_end, event_kind, measure_presence, registration_field_policy, late_entry_enabled, late_entry_deadline_at, staff_compete, event_look, event_look_locked, clock_start";
function listParticipantCompetitions(userId, { staff = false, withTags = false, withTimeslots = false, restrictToIds = null } = {}) {
  const _rows0 = staff
    // Staff see every competition — they can join one without an assignment row.
    ? db.prepare(`SELECT ${_PARTICIPANT_COMP_COLUMNS} FROM competitions ORDER BY start_time`).all()
    : db.prepare(
        `SELECT ${_PARTICIPANT_COMP_COLUMNS.split(", ").map(c => `c.${c}`).join(", ")}
         FROM competitions c JOIN competition_users cu ON cu.competition_id=c.id
         WHERE cu.user_id=? ORDER BY c.start_time`
      ).all(userId);

  // v8.8.6 — AN EVENT-ADMIN IMPERSONATION SESSION SEES ONLY THAT ORGANISER'S OWN
  // EVENTS. Applied to the RESULT, deliberately, and not as a clause on the
  // membership query: the STAFF branch above has no `competition_users` join to
  // filter on, and it is the worst case rather than a corner — a staff-tagged
  // target returned EVERY competition on the platform, measured at nine including
  // one nobody was enrolled in. A fix that narrowed only the member branch would
  // leave that fully open.
  //
  // `null` means unscoped and must stay byte-identical to the old behaviour, so
  // every caller that does not impersonate is unchanged. `[]` narrows to nothing
  // — the empty-grant organiser must see no events, not all of them.
  const rows = restrictToIds === null ? _rows0 : _rows0.filter(c => restrictToIds.includes(c.id));

  const ids = rows.map(c => c.id);
  const tagsByComp = {};
  const slotsByComp = new Map();
  // v8.1.0 — WHICH MEMBERSHIPS THE PARTICIPANT PUT THERE THEMSELVES.
  //
  // Self-service leaving is scoped to `assigned_by='self_enroll'`, so the wire
  // needs to say which those are — an affordance offered on an event the server
  // will refuse to leave is the v7.14.2 defect (gate the affordance and the
  // explanation together). A staff row has no `competition_users` row at all, so
  // the map is simply empty for them and nothing is offered, which is correct:
  // staff see every competition without being enrolled in any.
  //
  // v8.12.0 — THAT LAST SENTENCE STOPPED BEING TRUE. A staff member may now hold
  // a row (on an event where staff compete), so the map is read for the staff
  // branch too, and `own` below says which of the platform-wide list they hold
  // a row on — the fact the picker's two sections are split on. For an ordinary
  // participant every row is own, so `own` is true throughout and the client
  // renders one section as it always has.
  const selfEnrolled = new Set();
  const ownSet = new Set();
  // The session this participant chose on a multi-session event (`my_session`
  // below), read in the same pass.
  const mySlotByComp = new Map();
  if (ids.length) {
    const ph0 = "SELECT value FROM json_each(?)";
    db.prepare(`SELECT competition_id, assigned_by, timeslot_id FROM competition_users WHERE user_id=? AND competition_id IN (${ph0})`)
      .all(userId, JSON.stringify(ids)).forEach(r => {
        ownSet.add(r.competition_id);
        if (r.assigned_by === "self_enroll") selfEnrolled.add(r.competition_id);
        if (r.timeslot_id) mySlotByComp.set(r.competition_id, r.timeslot_id);
      });
  }
  if (ids.length) {
    const ph = "SELECT value FROM json_each(?)";
    if (withTags) {
      db.prepare(`SELECT competition_id, tag FROM competition_tags WHERE competition_id IN (${ph})`).all(JSON.stringify(ids))
        .forEach(r => { (tagsByComp[r.competition_id] = tagsByComp[r.competition_id] || []).push(r.tag); });
    }
    db.prepare(`SELECT * FROM competition_timeslots WHERE competition_id IN (${ph}) ORDER BY competition_id, start_time`).all(JSON.stringify(ids))
      .forEach(s => {
        if (!slotsByComp.has(s.competition_id)) slotsByComp.set(s.competition_id, []);
        slotsByComp.get(s.competition_id).push(s);
      });
  }

  return rows.map(c => {
    const slots = slotsByComp.get(c.id) || [];
    const mySlot = mySlotByComp.has(c.id) ? slots.find(s => s.id === mySlotByComp.get(c.id)) || null : null;
    // v8.4.0 — the raw sign-up matrix is SELECTed (the policy projection below
    // needs it) and stripped here, exactly as `_compWire` strips it: the
    // NORMALISED states ride `policy.registration_fields`, and shipping the blob
    // beside them would put two representations of one answer on one payload —
    // the raw one being the copy that knows nothing about the kind's defaults or
    // the required-implies-shown invariant.
    // The raw `clock_start` likewise: the participant is told the one answer the
    // server acts on (`clock_starts_at_first_open`, the kind's policy applied),
    // never the column a Program ignores.
    const { registration_field_policy: _regRaw, clock_start: _clockRaw, ...cWire } = c;
    const out = {
      ...cWire,
      // Does this event start each participant's solve clock at their first open
      // of a scoring challenge? The challenge list says so to the participant.
      clock_starts_at_first_open: clockStartsAtFirstOpen(c),
      status: competitionStatus(c, slots),
      effective_end: competitionEffectiveEnd(c, slots)?.toISOString() || null,
      // OPEN-ENDED: isOpenEnded, per read, never stored. Every participant surface
      // that shows a Program's time left says "No fixed deadline" instead while
      // it holds (operator ruling, 14 Nov 2026), and the client never re-derives
      // it. This row carries no `deadline_at`, so eventDeadline reads the window
      // end, which for a deadline kind is the duration derived from the deadline
      // (rounded up to the minute): the same answer GET /api/status gives.
      open_ended: isOpenEnded(c, slots),
      // v8.1.0 (PR 12) — the participant-side policy attach point. `event_kind`
      // is on the wire raw (History, Logs and the export all report stored bytes)
      // and the DOM renders the label; `policy` is what the client's suppression
      // layer reads, so it must travel with every payload the picker builds from.
      policy: eventPolicyForWire(c),
      // Computed server-side, never derived by the client from status + kind: the
      // route re-checks the identical predicate, so the button and the outcome
      // cannot disagree. `ended` is excluded because leaving a finished event
      // would mutate a settled result set for no benefit to anyone.
      can_leave: selfEnrolled.has(c.id) && competitionStatus(c, slots) !== "ended",
      // v8.12.0 — `own`: this participant holds a row. `competing`: they hold a
      // row on an event where staff compete — for a staff member, the events on
      // which they are on the board and the confirmations a spectator skips do
      // NOT apply (the four confirmation exemptions keyed on `S.isUserStaff`
      // read this flag). For an ordinary participant `own` is always true and
      // `competing` is merely "this event lets staff compete", which the client
      // never consults for them.
      own: ownSet.has(c.id),
      competing: ownSet.has(c.id) && !!c.staff_compete,
      // v8.6.0 — is this event's LATE-ENTRY window open? Server-computed, for the
      // reason `can_leave` above is: the picker must not derive it from status plus
      // kind, and the client cannot import the module that owns the rule.
      //
      // It is the EVENT's answer, not this participant's — the picker renders a
      // card, and whether THEY may play is decided by /api/status once they are in
      // it. Without it a card in an open window is filed under "Ended" and hidden
      // by the picker's default filter, which is indistinguishable from a broken
      // feature and gets reported as one (v7.14.2).
      late_entry_window_open: lateEntryWindowOpen(c, competitionEffectiveEnd(c, slots), now().getTime()),
      // THIS participant's own session on a multi-session event: its window and
      // status, computed exactly as GET /api/status computes the caller's
      // (timeslotEffectiveEnd / timeslotStatus). `status` and `effective_end`
      // above describe the EVENT — live while any session is, ending with the
      // last — so the events page's progress strip counts this one down instead,
      // as the play bar does. Null with no session chosen, or none to choose.
      my_session: mySlot ? {
        id: mySlot.id,
        start: new Date(mySlot.start_time).toISOString(),
        end: timeslotEffectiveEnd(mySlot).toISOString(),
        status: timeslotStatus(mySlot),
      } : null,
    };
    if (withTags) out.tags = tagsByComp[c.id] || [];
    if (withTimeslots) {
      out.timeslots = slots.map(s => ({ id: s.id, name: s.name, start_time: s.start_time, duration_minutes: s.duration_minutes, ended_at: s.ended_at }));
    }
    return out;
  });
}

// v8.1.0 (PR 16) — the ONE place a submitted schedule becomes stored columns.
//
// Shared by create and the PUT so the two cannot disagree about which field is
// authoritative for which kind — the parity class `allOptional()` exists to
// prevent, applied to a rule the schema cannot express.
//
//   window   — `duration_minutes` is authoritative; a deadline is REFUSED, because
//              for a window-shaped kind it would duplicate start + duration with
//              nothing keeping the two in step, and every duration writer would
//              desync it from day one.
//   deadline — `deadline_at` is authoritative and `duration_minutes` is DERIVED
//              by ceil, so the derived end is never EARLIER than the stated
//              deadline and never more than 60 s later.
//
// A submitted duration on a deadline-shaped event is refused only when it
// DISAGREES with the derived value, exactly as an echoed `event_kind` is not a
// change — a client that round-trips the whole row must keep working.
//
// v8.1.1 — `startDate` MUST be the start the caller is about to WRITE, not the
// one currently stored, and both outputs depend on it: the derived duration is
// the span from it, and the deadline-after-start refusal is measured against it.
// The PUT handed over the stored start while writing a new one, which desynced
// the pair by exactly the amount the start moved and made a deadline BEFORE the
// new start acceptable. This function cannot tell the two apart — it is pure and
// takes what it is given — so the contract lives here for the next caller.
function resolveSchedule(schedule, startDate, durationMinutes, deadlineIso) {
  const hasDur = durationMinutes !== undefined && durationMinutes !== null;
  if (schedule !== "deadline") {
    if (deadlineIso) {
      return { error: "This event type runs for a fixed duration and does not take a deadline.", code: "deadline_not_accepted" };
    }
    if (!hasDur) return { error: "Duration is required.", code: "duration_required" };
    return { durationMinutes, deadlineIso: null };
  }
  if (!deadlineIso) return { error: "A deadline is required for this event type.", code: "deadline_required" };
  const d = new Date(deadlineIso);
  if (isNaN(d.getTime())) return { error: "Deadline must be a valid date.", code: "deadline_invalid" };
  const spanMs = d.getTime() - startDate.getTime();
  if (spanMs <= 0) return { error: "The deadline must be after the start time.", code: "deadline_before_start" };
  const derived = Math.ceil(spanMs / 60_000);
  if (derived > DEADLINE_MAX_SPAN_MINUTES) {
    return { error: "The deadline cannot be more than 20 years after the start time.", code: "deadline_too_far" };
  }
  if (hasDur && durationMinutes !== derived) {
    return {
      error: "This event type takes a deadline, not a duration — its duration is derived from the deadline.",
      code: "duration_not_accepted",
    };
  }
  return { durationMinutes: derived, deadlineIso: d.toISOString() };
}

// ── v8.1.0 (PR 16) — the deadline every event has, and whether it reads as open ─
//
// Both are DERIVED. Neither introduces a second writer for a fact the row already
// holds, which is why there is no `open_ended` column: a flag would be a second
// source of truth for one fact on a table that already lists
// `duration_minutes ↔ deadline_at` as a drift pair, and its failure mode is the
// v7.21.14 class at its worst — a writer moves the deadline to next Tuesday
// without clearing the flag and the platform announces "No fixed deadline" over
// something closing in six days.
//
// A CLOSED event is never open-ended, which is why this is defined over
// eventDeadline rather than over the column: three reachable paths stamp
// `ended_at` on a slotless competition (Close Now, the idempotent close, and the
// deadline simply passing) and _singleSlotStatus clamps to it. Keyed on
// `deadline_at` alone, a closed Program would print "No fixed deadline" while
// refusing certificates and freezing its challenges.
function eventDeadline(comp, slots) {
  if (!comp) return null;
  if (comp.ended_at) return competitionEffectiveEnd(comp, slots);   // a closure is the truth
  if (comp.deadline_at) return new Date(comp.deadline_at);          // the stated deadline
  return competitionEffectiveEnd(comp, slots);                      // window-shaped kinds
}

// 5 years. An INTEGER DAY COUNT rather than a float-derived millisecond value, so
// the client mirror can be exact.
//
// The threshold (5y) and the affordance's fill (10y) are deliberately far apart:
// measured, 2026-01-14 → 2036-01-14 is 3652 days and 2026-08-14 → 2036-08-14 is
// 3653, so the leap-year mismatch is irrelevant against a 1826-day line. Had the
// two been equal, a Program created in January would have failed its own checkbox
// on the day it was made.
const OPEN_ENDED_THRESHOLD_DAYS = 1826;

// 20 years — DERIVED, not chosen: twice the largest span the "No fixed deadline"
// affordance can emit.
//
// Stated honestly, because it is easy to overclaim: this is NOT the typo defence.
// A mistyped 2036 for 2026 is not a range error, and only the form's
// >2-years-out confirmation catches that. It is the API BOUNDARY rule — POST/PUT
// accept `deadline_at` directly, and this codebase validates at the boundary
// regardless of what the UI can produce. The 525600 (365-day) request cap on
// `duration_minutes` is UNCHANGED; a Program's duration is derived rather than
// submitted, which is why it may exceed it.
const DEADLINE_MAX_SPAN_MINUTES = 10_519_200;

// MEASURED FROM NOW, not from start_time, and that is the property that makes it
// honest. `start_time` is immutable once started, so a span-from-start predicate
// would be constant for the row's whole life — the Program would still read "No
// fixed deadline" the day before it closed, i.e. with LESS warning than a
// one-year horizon gives. Now-relative it decays truthfully: a decade out reads
// open-ended, four years out renders its date, and inside a week a countdown
// appears. It also fixes the already-started case, where ticking the box fills
// now + 10 years rather than start + 10 years.
function isOpenEnded(comp, slots) {
  if (!comp) return false;
  if (eventPolicy(comp).schedule !== "deadline") return false;
  const d = eventDeadline(comp, slots);
  if (!d) return false;
  return (d.getTime() - now().getTime()) >= OPEN_ENDED_THRESHOLD_DAYS * 86_400_000;
}

// v7.21.13 — the two halves of the "did everyone finish everything?" question,
// shared by the auto-end scan (server.js) and BOTH revive gates
// (routes/competitions.js single-slot, routes/sessions.js per-slot).
//
// The count query existed verbatim in four files and the participant query in
// three. Nothing had drifted yet — but this is the shape v7.21.1 (A1) was:
// five writers, four different ideas of one rule, because each was re-derived
// rather than shared. The definition of "a challenge that counts" (assigned,
// active, published) and of "a participant who counts" (active per
// ACTIVE_PARTICIPANT_SQL, minus staff/benchmark) must move together or the
// denominator and the numerator disagree, and a competition either ends while
// someone is mid-challenge or never ends at all.
// Event team reports — a QUALIFYING challenge (task tag `qualifying:<key>`,
// lib/qualifying.js) is not a challenge that counts: it is left out of this
// denominator and of every numerator paired with it (participantSolvedAll,
// participantsFinishedAllDetail, the leaderboard's finish time, the submit
// fast path), so answering — or declining — a marketing question never finishes
// an event, completes a Program or moves the tie-break.
function publishedTaskCount(competitionId) {
  return db.prepare(
    `SELECT COUNT(*) as c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}`
  ).get(competitionId).c;
}
/**
 * v8.1.0 (PR 25) — HAS THIS PARTICIPANT COMPLETED THIS EVENT?
 *
 * Completion is holding a CORRECT submission for every assigned, active,
 * published challenge. Deliberately NOT `participantsFinishedAll` (v8.1.0 PR 22),
 * which also counts a challenge you have run out of attempts on: being finished
 * is what ends an event, but running out of attempts is not completing it, and a
 * certificate says you completed it.
 *
 * Zero challenges is NOT completion. An event with nothing assigned would
 * otherwise mint a certificate to everyone enrolled the moment it existed —
 * `>= 0` is trivially true, and that is the shape of the bug.
 */
function participantSolvedAll(userId, competitionId) {
  const total = publishedTaskCount(competitionId);
  if (total <= 0) return false;
  const solved = db.prepare(
    `SELECT COUNT(DISTINCT s.task_id) AS c
       FROM submissions s
       JOIN competition_tasks ct ON ct.task_id = s.task_id AND ct.competition_id = ?
       JOIN tasks t ON t.id = s.task_id
      WHERE s.user_id = ? AND s.competition_id = ? AND s.is_correct = 1
        AND t.active = 1 AND t.status = 'published' AND ${notQualifyingSql("t")}`
  ).get(competitionId, userId, competitionId).c;
  return solved >= total;
}

/**
 * v8.6.0 — IS THIS PARTICIPANT A LATE ENTRANT OF THIS EVENT, and is their window
 * still open?
 *
 * The DB-touching half of lib/late-entry.js, which is pure and takes the two facts
 * as arguments. This resolves them for ONE participant, which is what the submit
 * gate, the hint gate, `/api/status` and the solve-clock anchor need — the
 * leaderboard resolves them for a whole board in the queries it already runs, so it
 * deliberately does NOT call this (an N+1 over a board is the shape v7.21.13
 * removed from three builders).
 *
 * Returns a stable object rather than a bare boolean because three callers want
 * different halves of it and re-deriving one from the other is how two answers to
 * one question appear:
 *
 *   allowed  — this event runs late entries at all (policy + column)
 *   open     — the window is open right now
 *   deadline — when it closes (a Date), or null
 *   isLate   — THIS participant is a late entrant
 *   canPlay  — they may still act: the window is open AND they are a late entrant
 *
 * `canPlay` is the one every gate actually asks, and it is computed HERE so a gate
 * cannot check one half and forget the other. An ordinary participant of the same
 * event gets `canPlay:false` while the window is open, which is the point: the
 * window extends play for the people who arrived late, not for the room.
 *
 * The `finishTime` half is a bounded query rather than `participantSolvedAll`,
 * because the question is "had they finished BY THE END", not "have they finished".
 * Only a late entrant may submit after the end, so the two differ exactly for the
 * person this predicate is about.
 */
function lateEntryStateFor(comp, userId, slots) {
  const allowed = lateEntryAllowed(comp);
  if (!allowed || !userId) return { allowed, open: false, deadline: null, isLate: false, canPlay: false };
  const effEnd = competitionEffectiveEnd(comp, slots);
  const deadline = lateEntryDeadline(comp, effEnd);
  const open = lateEntryWindowOpen(comp, effEnd, now().getTime());
  const cu = db.prepare("SELECT assigned_at FROM competition_users WHERE competition_id=? AND user_id=?")
    .get(comp.id, userId);
  if (!cu) return { allowed, open, deadline, isLate: false, canPlay: false };
  // Their last correct submission, but ONLY if they had solved everything by the
  // event's end — the same "solved >= total" shape `participantSolvedAll` uses,
  // bounded to submissions at or before the end so a late entrant who finishes
  // DURING the window is not retroactively reclassified as an ordinary one.
  let finishTime = null;
  if (effEnd) {
    const total = publishedTaskCount(comp.id);
    if (total > 0) {
      const r = db.prepare(
        `SELECT COUNT(DISTINCT s.task_id) AS c, MAX(s.submitted_at) AS last_correct
           FROM submissions s
           JOIN competition_tasks ct ON ct.task_id = s.task_id AND ct.competition_id = ?
           JOIN tasks t ON t.id = s.task_id
          WHERE s.user_id = ? AND s.competition_id = ? AND s.is_correct = 1
            AND t.active = 1 AND t.status = 'published' AND ${notQualifyingSql("t")} AND s.submitted_at <= ?`
      ).get(comp.id, userId, comp.id, effEnd.toISOString());
      if (r && r.c >= total) finishTime = r.last_correct;
    }
  }
  const isLate = isLateEntry(comp, effEnd, { assignedAt: cu.assigned_at, finishTime });
  return { allowed, open, deadline, isLate, canPlay: open && isLate };
}

// ─── v8.12.6 — who the late-entry window may admit, and who it may remove ─────
//
// THE RULE BOTH DIRECTIONS SHARE: the window is for people who did NOT play the
// event itself. "Took part" is a stored FACT about this person and this event,
// never the current classification (which moves when the end or the toggle
// moves):
//
//   • a submission at or before the effective end, or
//   • a hint revealed at or before it, or
//   • an absence row whose recorded anchor (`login_time`) is at or before it —
//     somebody who entered the event and was then removed, or left, while it
//     ran. That clause is the fairness review's: without it a participant who
//     entered, played nothing on record, left, and rescanned the QR after the
//     end came back as a late entrant with the whole window ahead of them.
//
// WHY IT EXISTS AT ALL — measured before this release, through the join link:
// a finisher removed while the event ran rescanned after the end, got a NEW
// `assigned_at`, and because `isLateEntry` exempts anyone who had finished by
// the end, landed straight back on the FINAL main board at rank 1 — two holders
// of a 1st-place certificate for one event. Opening the admin doors would have
// made that reachable by anybody with an organiser's dialog, so the check is
// asked at EVERY door that writes a NEW row through the window.
//
// One indexed probe per table, `LIMIT 1` on the union. The ISO comparison is
// safe because every writer stamps these columns with `toISOString()`.
function _tookPartBeforeEnd(compId, userId, endIso) {
  return !!db.prepare(
    `SELECT 1 FROM submissions WHERE user_id=? AND competition_id=? AND submitted_at <= ?
     UNION ALL
     SELECT 1 FROM hint_reveals WHERE user_id=? AND competition_id=? AND revealed_at <= ?
     UNION ALL
     SELECT 1 FROM competition_user_absences
      WHERE user_id=? AND competition_id=? AND login_time IS NOT NULL AND login_time <= ?
     LIMIT 1`
  ).get(userId, compId, endIso, userId, compId, endIso, userId, compId, endIso);
}

function _endIso(effEnd) {
  if (!effEnd) return null;
  const end = effEnd instanceof Date ? effEnd : new Date(effEnd);
  return Number.isFinite(end.getTime()) ? end.toISOString() : null;
}

/**
 * v8.12.6 — MAY THIS PERSON BE GIVEN A NEW ROW THROUGH THE LATE-ENTRY WINDOW?
 *
 * Returns `null` (yes) or `{ code: "late_entry_took_part", message }`. A door
 * asks it ONLY when `competitionAdmission(...) === "late"` AND the person holds
 * no `competition_users` row: a held row is a membership, and it takes the
 * idempotent path — re-adding somebody already in the event changes nothing.
 *
 * `opts.self` words the refusal to the person themselves (the join link), where
 * every admin door names them in the third person.
 *
 * A late entrant removed DURING the window can be re-admitted, and that is by
 * construction rather than an exception: nothing they did is at or before the
 * end, and their absence row's anchor is after it.
 */
function lateWindowAdmissionDenied(comp, userId, effEnd, opts = {}) {
  if (!comp || !userId) return null;
  const endIso = _endIso(effEnd);
  if (!endIso) return null;
  if (!_tookPartBeforeEnd(comp.id, userId, endIso)) return null;
  if (opts.self) {
    return { code: "late_entry_took_part", message: `You took part in “${comp.name}” before it ended, so you cannot rejoin it as a late entrant — its results are final.` };
  }
  const who = db.prepare("SELECT nickname FROM users WHERE id=?").get(userId)?.nickname || "This participant";
  return { code: "late_entry_took_part", message: `${who} took part in “${comp.name}” before it ended, so they cannot rejoin it as a late entrant — its results are final.` };
}

/**
 * v8.12.6 — MAY THIS MEMBER BE REMOVED FROM AN EVENT THAT HAS ENDED?
 *
 * Only a LATE ENTRANT, and only while the window is open (operator decision):
 * everybody who was in the event before it ended stays, so its final results
 * cannot change. "Late entrant" here is `lateEntryStateFor(...).canPlay` (the
 * window is open AND they classify late) AND no took-part footprint — neither the
 * facts above nor an anchor on their CURRENT row at or before the end. So
 * removable ⇔ re-admittable: the people this refuses to take out are exactly the
 * people the window would refuse to let back in, and a removal can never be a
 * one-way door for somebody who played the event (a member who classifies late
 * but has a footprint at or before the end, as an imported membership can, is
 * not removable).
 *
 * Returns null when the removal may proceed — including when the person holds no
 * row at all, which the caller's ordinary no-op path answers — or a refusal:
 *
 *   event_ended                  — no window, or it has closed (400)
 *   not_late_entrant             — in the event before it ended (400)
 *   late_entrant_has_certificate — holds an unrevoked PLACING certificate (409).
 *       Reachable only after a superadmin re-pins a closed deadline and play
 *       resumes; removing them would let a second person mint the same placing.
 *       A participation certificate does not block removal and is not revoked.
 *
 * `opts.codeOnly` skips building the message (the participants list asks this
 * per row and needs only the verdict). `opts.state` hands in a
 * `lateEntryStateFor(comp, userId, slots)` the caller already computed — the
 * participants list publishes that answer too (`late_entry_playing`), and asking
 * it twice per row would be the N+1 this list is built to avoid.
 */
function lateWindowRemovalDenied(comp, userId, slots, opts = {}) {
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  const le = opts.state || lateEntryStateFor(comp, userId, slots);
  if (!le.open) {
    return { code: "event_ended", status: 400, message: `Cannot remove participants from ended event "${comp.name}".` };
  }
  const cu = db.prepare("SELECT login_time FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId);
  if (!cu) return null;
  const endIso = _endIso(competitionEffectiveEnd(comp, slots));
  const who = () => db.prepare("SELECT nickname FROM users WHERE id=?").get(userId)?.nickname || userId;
  const enteredBeforeEnd = !!(cu.login_time && endIso && cu.login_time <= endIso);
  if (!le.canPlay || enteredBeforeEnd || (endIso && _tookPartBeforeEnd(comp.id, userId, endIso))) {
    return {
      code: "not_late_entrant", status: 400,
      // v8.12.6 (review) — the sentence names the rule this check applies, who
      // had started before the end, not who joined after it: a member who
      // classifies late but has a footprint at or before the end (an imported
      // membership can) plays on through the window and is still refused here.
      message: opts.codeOnly ? null : `“${who()}” was in “${comp.name}” before it ended, so they cannot be removed — while late entries are open only late entrants who had not started playing before the end can be, which keeps its final results as they were.`,
    };
  }
  const placing = db.prepare(
    `SELECT 1 FROM achievement_badges
      WHERE user_id=? AND competition_id=? AND revoked_at IS NULL
        AND (basis='placement' OR (basis IS NULL AND rank BETWEEN 1 AND 3))
      LIMIT 1`
  ).get(userId, comp.id);
  if (placing) {
    return {
      code: "late_entrant_has_certificate", status: 409,
      message: opts.codeOnly ? null : `“${who()}” holds a placing certificate for “${comp.name}”. Revoke the certificate first, then remove them — otherwise a second person could be issued the same placing.`,
    };
  }
  return null;
}

/**
 * v8.12.6 — THE ONE LATE-ENTRY MAIL LINE, or null when the event is not being
 * joined through its window.
 *
 * Every assignment, group-sync and invitation mail for an event admitted through
 * the window uses this INSTEAD of the Starts/Ends pair: both of those are in the
 * past by then, and "You have been invited to participate" above two past times
 * is the misleading-email class. One helper for all three builders, so their copy
 * cannot drift. The caller escapes the event name; this returns trusted HTML with
 * no user-controlled content. `tz` is the recipient's zone where a user row is
 * known — formatEmailDate falls back to UTC, and says so, where it is not.
 */
function lateEntryMailLine(comp, { slots, tz, nowMs } = {}) {
  if (!comp) return null;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (competitionAdmission(comp, { slots, nowMs }) !== "late") return null;
  const deadline = lateEntryDeadline(comp, competitionEffectiveEnd(comp, slots));
  if (!deadline) return null;
  return `This event has finished, but you can still take part as a late entrant until ${formatEmailDate(deadline, tz)}. Late entrants are ranked in their own section of the leaderboard.`;
}

/**
 * v8.12.6 (review) — THE SAME LINE, BUT ONLY WHERE IT IS TRUE FOR THIS RECIPIENT.
 *
 * `lateEntryMailLine` answers about the EVENT, and "you can still take part as a
 * late entrant" is a claim about the PERSON. The two agree for a brand-new row
 * written through the window (a late entrant by construction), and for nobody
 * else: an ordinary member who held a row before the end cannot play in the
 * window, and somebody the request SKIPPED (took part before the end, staff,
 * author, peer admin) holds no row at all. A multi-event assign mails everybody
 * who got a new row ANYWHERE in the request, so the event-level line reached both
 * — measured: "(already enrolled) … you can still take part as a late entrant" to
 * a member the play gate refuses, and to a user the late door had just turned
 * away. Every builder that knows its recipient asks this; the invitation, whose
 * recipient has no account yet (and so is admitted late by construction when they
 * register), keeps the event-level line.
 *
 * Null when the event is not being joined through its window OR this person
 * cannot play in it (`lateEntryStateFor(...).canPlay`, the play gate's own answer).
 */
function lateEntryMailLineFor(comp, userId, { slots, tz, nowMs } = {}) {
  if (!comp || !userId) return null;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (!lateEntryStateFor(comp, userId, slots).canPlay) return null;
  return lateEntryMailLine(comp, { slots, tz, nowMs });
}

/**
 * WHAT A MAIL'S "Ends:" LINE SAYS (operator ruling, 14 Nov 2026): "No fixed
 * deadline" for an open-ended Program, whose stored deadline is a placeholder
 * ten years out, else the scheduled end in the recipient's zone (formatEmailDate
 * falls back to UTC, and says so, where no zone is known). Decided by isOpenEnded
 * when the mail is built — the participant and admin wires' own verdict, never a
 * stored copy — so a deadline moved in prints its date in the next mail. Every
 * builder that prints an event's end asks this, never
 * formatEmailDate(scheduledEnd(…)) itself (lock: tests/schedule-arithmetic-email.spec.js).
 * The screens' copy of the words is public/js/ui/format.js NO_FIXED_DEADLINE.
 */
const NO_FIXED_DEADLINE = "No fixed deadline";
function eventEndMailText(comp, { slots, tz } = {}) {
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  return isOpenEnded(comp, slots) ? NO_FIXED_DEADLINE : formatEmailDate(scheduledEnd(comp), tz);
}

/**
 * v8.12.6 — MAY THE LATE-ENTRY SWITCH STILL BE CHANGED, and if not, WHY?
 *
 * Not once the event has ENDED, in either direction, because both directions
 * reclassify a board that is final. `isLateEntry` answers false the moment the
 * switch is off, so turning it OFF folds every late entrant into the FINAL main
 * board (measured: a window-only scorer took rank 1); turning it ON moves
 * anybody whose row was written after the end and who had not finished by it
 * OFF it. The deadline does not reclassify anybody, which
 * is why CLOSING THE WINDOW is the remedy the refusal names (v8.12.8 — "Close late
 * entries now", every organiser's; until then a superadmin pinning the deadline
 * to now) — named only while there is a window to close.
 *
 * The `time_basis` / `measure_presence` "locked once fully ended" shape, and ONE
 * predicate for the PUT and the wire flag (`late_entry_locked`), so the form is
 * never offered a switch the save would refuse. `null` = changeable.
 */
function lateEntrySwitchLock(comp, slots, nowMs) {
  if (!comp) return null;
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  if (!competitionFullyEnded(comp, slots)) return null;
  // v8.12.8 — THE REMEDY CLAUSE IS CONDITIONAL, because the control it names
  // exists only while the window is OPEN. "Close late entries now" is offered on a
  // window-open event and nowhere else (`lateEntryCloseState`), so naming it after
  // the window has lapsed — or on an event that never had one — would point at a
  // button the reader cannot find: FROZEN_REMEDY (v7.29.0), an instruction that
  // is not true. After the window there is no door left to close, so no remedy is
  // named at all. The `reason` and `code` never change; only the sentence does.
  const n = Number.isFinite(nowMs) ? nowMs : now().getTime();
  const open = lateEntryWindowOpen(comp, competitionEffectiveEnd(comp, slots), n);
  return {
    reason: "ended", code: "late_entry_locked_ended",
    message: "Late entries cannot be switched on or off once the event has ended — that would move people between the main leaderboard and the late-entrant section after its results are final, and certificates already issued assert that order."
      + (open ? " To close the door early, use Close late entries now on the event's menu instead." : ""),
  };
}

/**
 * v8.12.8 — CAN AN ORGANISER CLOSE THIS EVENT'S LATE-ENTRY WINDOW NOW?
 *
 * A TAGGED answer, never a "*Denied" that returns a success:
 *   { kind: "open" }                           — the window is open; closing is allowed
 *   { kind: "closed" }                         — ended, window already shut (an idempotent 200)
 *   { kind: "refused", status, code, message } — never offered; the route refuses
 *
 * ONE PREDICATE for the close route AND for the `can_close_late_entries` wire flag
 * (`lateEntryCloseOffered`, below), so the control is never offered where the
 * route refuses (v7.14.2). Tier, scope and the competitor lock are the ROUTE's —
 * they are about the ACTOR, not the event — and are asked above this.
 *
 * FAIL CLOSED: a caller tests `kind === "open"`, so a shape it does not know reads
 * as not-open. Order is most-permanent fact first — the kind (never changes once
 * started), then the per-event switch (locked once ended), then "has it ended",
 * then the window — so the refusal names the deepest reason there is no window.
 *
 * WHY every organiser may close it, while only a superadmin may move the deadline
 * through the editor: moving the deadline EARLIER reclassifies nobody. `isLateEntry`
 * reads the join cutoff (the effective end) and the finish time, never the
 * deadline, so the main board, the late-entrant partition and every issued
 * certificate's wording are untouched. This predicate answers "open" only for a
 * window that can be SHORTENED; reopening stays a superadmin's editor save.
 */
function lateEntryCloseState(comp, { slots, nowMs } = {}) {
  if (!comp) return { kind: "refused", status: 404, code: null, message: "Event not found" };
  if (slots === undefined) slots = getCompetitionTimeslots(comp.id);
  const n = Number.isFinite(nowMs) ? nowMs : now().getTime();
  const name = comp.name || "This event";
  if (eventPolicy(comp).lateEntry !== "allowed") {
    return { kind: "refused", status: 400, code: "late_entry_forbidden", message: lateEntryForbiddenMessage(comp) };
  }
  if (!comp.late_entry_enabled) {
    return { kind: "refused", status: 400, code: "late_entry_not_enabled",
      message: `“${name}” does not take late entries, so it has no late-entry window to close.` };
  }
  // POSITIVE: only an ENDED event has a window. A status invented later refuses.
  if (competitionStatus(comp, slots) !== "ended") {
    return { kind: "refused", status: 400, code: "late_entry_not_ended",
      message: `“${name}” has not ended yet, so its late-entry window has not opened. To end it with no late window, untick Allow late entries in its editor before you press End Now — that switch locks once it ends.` };
  }
  return lateEntryWindowOpen(comp, competitionEffectiveEnd(comp, slots), n) ? { kind: "open" } : { kind: "closed" };
}

/**
 * v8.12.8 — THE WIRE FLAG `can_close_late_entries`: the route would close it AND
 * this actor is not a competitor in the event. Attached at BOTH sites a
 * competition row reaches the admin client from (`_compWire` and the admin list),
 * the `staffCompeteFlags` rule, so the two cannot disagree.
 */
function lateEntryCloseOffered(comp, { slots, nowMs, competing } = {}) {
  return !competing && lateEntryCloseState(comp, { slots, nowMs }).kind === "open";
}

// Active, non-staff, non-benchmark participant ids. `timeslotId` scopes to one
// session (the per-slot auto-end / revive); null spans the whole competition.
// getStaffOrBenchmarkSet lives in lib/user-tags.js, required lazily so this
// module stays importable by anything that does not need tag lookups.
function scoringParticipantIds(competitionId, timeslotId = null) {
  const rows = timeslotId
    ? db.prepare(`SELECT cu.user_id FROM competition_users cu JOIN users u ON u.id=cu.user_id WHERE cu.competition_id=? AND cu.timeslot_id=? AND ${ACTIVE_PARTICIPANT_SQL}`)
        .all(competitionId, timeslotId, now().toISOString())
    : db.prepare(`SELECT cu.user_id FROM competition_users cu JOIN users u ON u.id=cu.user_id WHERE cu.competition_id=? AND ${ACTIVE_PARTICIPANT_SQL}`)
        .all(competitionId, now().toISOString());
  const ids = rows.map(r => r.user_id);
  // v8.12.0 — on an event where staff compete, staff COUNT toward the all-solved
  // denominator exactly as they count on the board. `getCompetition` is the
  // cached `SELECT *`, so the column is present; `staffCompeteOn` throws on a
  // row that lacks it rather than silently excluding.
  const _comp = getCompetition(competitionId);
  const staffCompete = _comp ? require("./staff-compete").staffCompeteOn(_comp) : false;
  const excluded = require("./user-tags").getStaffOrBenchmarkSet(ids, { staffCompete });
  return ids.filter(id => !excluded.has(id));
}

/**
 * v8.12.2 — does THIS user's score land on `comp`'s board? The per-user form of
 * `scoringParticipantIds` above: a `competition_users` row, minus the staff
 * exclusion the event's "Staff can compete" switch lifts (the `staff` tag or
 * the `event_admin` role — the same pair `getStaffOrBenchmarkSet` excludes,
 * lifted together). `benchmark` is deliberately NOT excluded: a reference score
 * is a real score on a displayed board. A staff member admitted WITHOUT a row
 * (`requireParticipantInCompetition` lets staff in) answers false, which is the
 * point — it is what the sealed-hint paid exemption asks, because a hint
 * deduction that lands on no board bought nothing. `comp` must carry
 * `staff_compete` (`req.competition` is the cached `SELECT *`); `staffCompeteOn`
 * throws otherwise rather than silently answering "not competing".
 */
function userScoresOn(userId, comp) {
  if (!userId || !comp || !comp.id) return false;
  const row = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId);
  if (!row) return false;
  if (require("./staff-compete").staffCompeteOn(comp)) return true;
  if (require("./user-tags").isStaff(userId)) return false;
  const u = db.prepare("SELECT role FROM users WHERE id=?").get(userId);
  // RBAC — every grant-scoped role (class `granted`) is off the board, as the
  // event admin is: the boards' own definition (lib/user-tags.js).
  return !(u && require("./user-tags").isOffBoardRole(u.role));
}

/**
 * Close the open absence row(s) for (user, competition) and RESTORE the
 * solve-clock anchor the removal preserved on them. Call this from every re-add
 * path, immediately after the `competition_users` INSERT.
 *
 * ONE definition, for the reason this file keeps recording: there are three
 * re-add sites (bulk assign, group sync, self-enroll join) and each used to
 * carry its own copy of the `UPDATE … SET returned_at=?`. Three copies of a rule
 * is how the fourth one arrives subtly different — and here a site that closed
 * the absence without restoring the anchor would silently reopen the tie-break
 * inversion below.
 *
 * WHY THE ANCHOR HAS TO COME BACK. Every removal DELETEs the
 * `competition_users` row, so the re-insert has `login_time IS NULL` and the
 * lazy stamp (`_stampLoginTimeIfLive`) re-anchors the clock to the REJOIN
 * moment on the participant's next request. `buildLeaderboardEntries` clamps
 * each absence to [loginMs, refEndMs], so a forward-moved anchor excludes the
 * whole pre-removal period rather than just the no-access gap — and for a
 * FINISHER, `refEndMs` is their last correct submission, which now PRECEDES the
 * anchor, so `solveTimeMs` goes negative and is clamped to 0: the best possible
 * value on the sole score tie-break. Self-service leave+join (v8.1.0) makes
 * that two API calls, so this is the difference between a lossless rejoin and a
 * one-click way to take first place.
 *
 * The EARLIEST open row wins if more than one is somehow open (a removal that
 * crashed between the INSERT and the DELETE, or hand-edited data): the earliest
 * carries the oldest anchor, which is the honest one — taking the latest would
 * reward whatever produced the extra row.
 *
 * `login_time IS NULL` on the target row is the guard, so this can never
 * overwrite an anchor a concurrent stamp has already written, and re-running it
 * is a no-op. A NULL stored anchor (a pre-v8.1.0 absence, or one rehydrated by
 * the participant import, which does not carry the column) restores nothing and
 * leaves today's behaviour exactly as it was.
 *
 * A HAPPY CONSEQUENCE WORTH KNOWING, because it looks like a hole and is not:
 * `POST /api/select-timeslot` writes `login_time` UNCONDITIONALLY, so a re-added
 * participant re-selecting their session would appear to undo this. They cannot
 * reach it — that route's FIRST lock refuses anyone with `login_time` AND
 * `timeslot_id` set on a live-or-ended slot, and the re-add sets both (this
 * function and `restoreSlot`). v6.12.0 had to add a SECOND, history-based lock
 * precisely because the row used to come back blank; restoring the anchor is
 * what finally arms the original one.
 *
 * v8.12.6 — AND IT RESTORES `assigned_at`, which is what decides whether somebody
 * is a LATE ENTRANT (`isLateEntry`: joined after its effective end). The re-insert
 * stamps the re-add's own time, and left there the classification would read
 * that instead of when they joined: a member who joined while the event ran would
 * be classed late whenever the effective end falls between the two (a duration
 * edit can move it back there). Restoring the original join time means a
 * remove-and-re-add cannot change the classification of anybody whose absence
 * row recorded their join time, whichever door the re-add comes through. Only a
 * member who had ENTERED has one (the removal writes it beside a `login_time`):
 * a member removed before entering comes back with a fresh join time, and
 * through the late-entry window that is a late entrant, as it is for anyone who
 * did not play the event
 * (`lateWindowAdmissionDenied`). A NULL stored value (a pre-v8.12.6 absence, or
 * one the import rehydrated without the column) restores nothing —
 * today's behaviour, for rows that cannot know better. Unlike `login_time` there
 * is no IS NULL guard to lean on (the re-insert always stamps a value), so an
 * unparseable stored value is refused here rather than copied onto the row.
 *
 * Synchronous and self-contained — safe to call inside an existing
 * db.transaction, which every caller does.
 */
function closeAbsenceAndRestoreAnchor(userId, competitionId, atIso) {
  const open = db.prepare(
    `SELECT removed_at, login_time, assigned_at FROM competition_user_absences
      WHERE user_id=? AND competition_id=? AND returned_at IS NULL
      ORDER BY removed_at ASC LIMIT 1`
  ).get(userId, competitionId);
  db.prepare("UPDATE competition_user_absences SET returned_at=? WHERE user_id=? AND competition_id=? AND returned_at IS NULL")
    .run(atIso, userId, competitionId);
  if (open && typeof open.assigned_at === "string" && Number.isFinite(new Date(open.assigned_at).getTime())) {
    db.prepare("UPDATE competition_users SET assigned_at=? WHERE user_id=? AND competition_id=?")
      .run(open.assigned_at, userId, competitionId);
  }
  if (!open || !open.login_time) return false;
  return db.prepare(
    "UPDATE competition_users SET login_time=? WHERE user_id=? AND competition_id=? AND login_time IS NULL"
  ).run(open.login_time, userId, competitionId).changes > 0;
}

/**
 * v8.12.0 — THE HONEST ANCHOR for a first `login_time`: the moment being
 * stamped, or the participant's EARLIEST activity in this event if that came
 * first. Everything the board measures runs from `login_time`, and the board's
 * own fallback when it is NULL is the first submission or hint — so a stamp that
 * lands AFTER activity already recorded would move the anchor forward past it,
 * and for a finisher whose window closes at their last correct submission that
 * makes `finish - login` NEGATIVE, clamped to 0: the best possible value on the
 * score-tie tie-break (the v8.6.0 late-entry exploit shape, through a new door).
 *
 * The door is a STAFF member: they may submit and reveal hints in a compete
 * event with no row at all (`requireParticipantInCompetition` admits staff
 * without one), and every row-writer — the join link, an assign, group sync,
 * an invitation, the import — will then write them a row AFTER those solves,
 * whose first live request stamps the anchor. An ordinary participant cannot
 * reach it: they have no submissions before they have a row, and the request
 * that stamps their anchor precedes the handler that would record one.
 *
 * Every writer of a NEW anchor calls this rather than the clock, so the rule
 * lives once. Synchronous, safe inside a transaction.
 */
function anchorLoginTime(userId, competitionId, nowIso, opts = {}) {
  // `scoringOnly` — an event whose clock starts at the FIRST OPEN
  // (`clockStartsAtFirstOpen`) counts only activity on SCORING challenges: a
  // Quick (qualifying) answer or hint scores nothing and never starts the clock,
  // so it must not pull the anchor back either.
  const first = opts.scoringOnly
    ? db.prepare(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(s.submitted_at) AS t FROM submissions s JOIN tasks t ON t.id=s.task_id
            WHERE s.user_id=? AND s.competition_id=? AND ${notQualifyingSql("t")}
           UNION ALL
           SELECT MIN(h.revealed_at)  AS t FROM hint_reveals h JOIN tasks t ON t.id=h.task_id
            WHERE h.user_id=? AND h.competition_id=? AND ${notQualifyingSql("t")}
         )`
      ).get(userId, competitionId, userId, competitionId)?.t
    : db.prepare(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(submitted_at) AS t FROM submissions  WHERE user_id=? AND competition_id=?
           UNION ALL
           SELECT MIN(revealed_at)  AS t FROM hint_reveals WHERE user_id=? AND competition_id=?
         )`
      ).get(userId, competitionId, userId, competitionId)?.t;
  return (first && first < nowIso) ? first : nowIso;
}

/**
 * v8.3.0 — MAY this event's kind still be changed, and if not, WHY?
 *
 * v7.29.0 made `event_kind` immutable outright, and the reasoning it gave was
 * precise about the cost: "every guard would have to hold in both directions at
 * once — a change away from a session-bearing kind must refuse while slots
 * exist, a change toward a ranked kind must reckon with a board that was never
 * computed, and a change to `program` must invent a deadline." The operator
 * asked for the change to be possible **before the event goes live**, and that
 * one word is what makes it tractable: an UPCOMING event has no submissions, no
 * computed board, no presence buckets and no minted certificates, so two of
 * those three problems simply do not arise. Only the schedule has to be
 * re-derived, and the caller supplies it.
 *
 * The remaining guard is SESSIONS, and it is not a policy question but a flat
 * "are there any?". Today only `tournament` allows them, so the two are
 * equivalent — but stated flatly this fails SAFE if a future kind ever allows
 * sessions too, where a target-policy test would quietly start permitting a
 * change this rule has never been reasoned about for.
 *
 * **The session-side refusal in `routes/sessions.js` STAYS.** v7.29.0's theorem —
 * a sessionless kind has zero sessions — was enforced from both ends precisely
 * so it could not be reached by reordering, and it still is: you cannot add a
 * slot to a sessionless kind, and you cannot change kind while slots exist. Both
 * ends still move together; only the second end's wording changed from "never"
 * to "not while there are sessions".
 *
 * Returns `null` when the kind is changeable, else `{reason, code, message}`.
 * ONE predicate, because the wire flag the admin form reads and the refusal the
 * route enforces must never disagree — the v8.1.0 `can_leave` rule: a control is
 * never offered for something the server would refuse.
 */
function eventKindChangeLock(comp, slots) {
  if (!comp) return null;
  const _slots = slots === undefined ? getCompetitionTimeslots(comp.id) : slots;
  if (competitionStatus(comp, _slots) !== "upcoming") {
    return {
      reason: "started",
      code: "event_kind_locked_started",
      message: "An event's type can only be changed before it starts.",
    };
  }
  if (_slots.length > 0) {
    const n = _slots.length;
    return {
      reason: "has_sessions",
      code: "event_kind_locked_sessions",
      message: `An event's type cannot be changed while it has sessions. Delete its ${n} session${n === 1 ? "" : "s"} first, then change the type.`,
    };
  }
  return null;
}

/**
 * v8.3.10 — HAS ANYBODY LEFT A MARK ON THIS EVENT?
 *
 * The operator's rule is that a superadmin may edit a LIVE event "which has no
 * users associated with it". The obvious reading — zero `competition_users`
 * rows — is NOT sufficient, and the reason is a rule this codebase already
 * relies on elsewhere: **staff bypass membership entirely.**
 * `requireParticipantInCompetition` (`lib/middleware.js`) `return next()`s for a
 * staff member before any membership read, and EVERY admin is auto-tagged
 * `staff`. So an admin can select a competition, open a challenge and submit an
 * answer without ever acquiring a `competition_users` row — and a membership
 * count would call that event empty while a graded submission sits in it.
 *
 * A removal is the mirror image: `removeUserFromCompetition` DELETEs the
 * membership row and deliberately preserves `submissions` and `hint_reveals`
 * (the v8.1.0 leave-event rule — a re-join is lossless), writing an absence
 * row. So a competition somebody was thrown out of reads as zero-users too.
 *
 * The predicate is therefore a FOOTPRINT scan, not a head-count: has anything
 * at all been recorded against this competition by anyone? It answers with the
 * FIRST mark it finds so the caller can say which, and short-circuits — the
 * common case (a live event with members) is settled by the first probe.
 *
 * **THE LIST IS A DECISION PER TABLE, NOT A JOIN.** Every table that carries a
 * `competition_id` is named here explicitly, so adding one later is a choice
 * somebody makes rather than a gap nobody notices — the same posture as the
 * export drift guards. `competition_groups` is deliberately ABSENT: a bound
 * group with no members yet has left no mark, and the reconciler's inserts land
 * in `competition_users`, which IS probed. `competition_timeslots` is absent
 * because a slotted event is refused earlier on different grounds.
 *
 * Returns `null` when pristine, else `{ mark, detail }`.
 */
const _FOOTPRINT_PROBES = [
  // Members first: it settles the ordinary case in one indexed lookup.
  { mark: "members", sql: "SELECT 1 FROM competition_users WHERE competition_id=? LIMIT 1", detail: "participants are enrolled in it" },
  // Then the marks a membership count cannot see (staff, and removed members).
  { mark: "submissions", sql: "SELECT 1 FROM submissions WHERE competition_id=? LIMIT 1", detail: "answers have been submitted in it" },
  { mark: "hints", sql: "SELECT 1 FROM hint_reveals WHERE competition_id=? LIMIT 1", detail: "hints have been revealed in it" },
  { mark: "absences", sql: "SELECT 1 FROM competition_user_absences WHERE competition_id=? LIMIT 1", detail: "somebody has been removed from it" },
  { mark: "activity", sql: "SELECT 1 FROM challenge_events WHERE competition_id=? LIMIT 1", detail: "participants have opened challenges in it" },
  { mark: "badges", sql: "SELECT 1 FROM achievement_badges WHERE competition_id=? LIMIT 1", detail: "certificates have been issued for it" },
  { mark: "presence", sql: "SELECT 1 FROM competition_presence WHERE competition_id=? LIMIT 1", detail: "time on platform has been recorded for it" },
  { mark: "reminders", sql: "SELECT 1 FROM email_reminders WHERE competition_id=? LIMIT 1", detail: "start reminders are pending for it" },
  // Two pointers on `users` that no competition-keyed table would reveal: a
  // participant sitting in it right now, and a walk-up whose /join sign-up is
  // half-finished (v6.21.0's deferred consume, which accepts a LIVE event).
  { mark: "selected", sql: "SELECT 1 FROM users WHERE active_competition_id=? LIMIT 1", detail: "a participant has it selected" },
  { mark: "pending_join", sql: "SELECT 1 FROM users WHERE pending_self_enroll_comp_id=? LIMIT 1", detail: "a sign-up through its join link is in flight" },
];

function eventParticipantFootprint(competitionId) {
  if (!competitionId) return null;
  for (const p of _FOOTPRINT_PROBES) {
    if (db.prepare(p.sql).get(competitionId)) return { mark: p.mark, detail: p.detail };
  }
  return null;
}

/**
 * v8.3.10 — MAY THIS EVENT'S START TIME BE CHANGED, AND IF NOT, WHY?
 *
 * Until now the answer was flatly "not once it has started", for everyone. The
 * operator's instruction is that a SUPERADMIN may correct a LIVE event that
 * nobody has touched — the ordinary case being an event that went live on a
 * mistyped date with nobody in it.
 *
 * **THE CONSEQUENCE THAT MAKES THIS MORE THAN A RELAXED GUARD:** `start_time`
 * is an INPUT to the status function, not a label. `_singleSlotStatus` is
 * `now < start → upcoming`, so moving the start into the future flips the event
 * live → upcoming — the only such transition on the platform. Every
 * "locked once started" guard (`eventKindChangeLock`, the `leaderboard_mode`
 * lock, the `time_basis` lock, the client's Start Now) keys on that
 * time-derived status, so they all unlock again.
 *
 * That is CORRECT here, and it is the footprint predicate that makes it
 * correct: an event with no marks on it has no history those guards protect, so
 * once un-started it is indistinguishable from one that was never started, and
 * editing it freely is exactly right. Weaken `eventParticipantFootprint` and
 * that argument collapses — it is load-bearing, not belt-and-braces.
 *
 * `slots.length > 0` is refused for a reason unrelated to safety: for a
 * multi-session event `competitionStatus` never reads `comp.start_time` at all
 * (the slots decide), so the column is inert and writing it would be a control
 * that appears to work.
 *
 * **`isSuperAdmin` FAILS CLOSED.** `_compWire` publishes this reason to the
 * admin form, and a caller that forgets to pass the flag gets `locked`, which
 * withholds the control — the safe direction, and one this repo insists is
 * accompanied by its reason rather than a silently missing field.
 *
 * Returns `null` when the start may be changed, else `{reason, code, message}`.
 * ONE predicate, four consumers: the PUT's refusal, the DELETE's refusal, the
 * `start_time_locked` wire flag, and the admin list.
 */
function startTimeChangeLock(comp, opts) {
  if (!comp) return null;
  const o = opts || {};
  const _slots = o.slots === undefined ? getCompetitionTimeslots(comp.id) : o.slots;
  const status = competitionStatus(comp, _slots);
  // Upcoming has always been freely editable; nothing here narrows that.
  if (status === "upcoming") return null;
  if (_slots.length > 0) {
    return {
      reason: "has_sessions",
      code: "start_time_locked_sessions",
      message: "Cannot change the start time of a multi-session event — its schedule comes from its sessions. Edit the session times instead.",
    };
  }
  if (status !== "live") {
    return {
      reason: "ended",
      code: "start_time_locked_ended",
      message: "The start time of an event that has ended cannot be changed.",
    };
  }
  if (!o.isSuperAdmin) {
    return {
      reason: "requires_superadmin",
      code: "start_time_locked_tier",
      message: "Only a superadmin can change the start time of an event that is already running.",
    };
  }
  const fp = eventParticipantFootprint(comp.id);
  if (fp) {
    return {
      reason: "has_participants",
      code: "start_time_locked_in_use",
      message: `The start time of a running event can only be changed while nothing has happened in it — ${fp.detail}.`,
    };
  }
  return null;
}

module.exports = {
  eventKindChangeLock, startTimeChangeLock, eventParticipantFootprint,
  listParticipantCompetitions, publishedTaskCount, scoringParticipantIds, userScoresOn, participantSolvedAll,
  eventDeadline, isOpenEnded, resolveSchedule, OPEN_ENDED_THRESHOLD_DAYS, DEADLINE_MAX_SPAN_MINUTES,
  getCompetition, _compWire, staffCompeteFlags, clockStartLock, _invalidateCompetitionCache,
  getTimeslot, getCompetitionTimeslots, hasTimeslots,
  scheduledEnd, timeslotStatus, timeslotEffectiveEnd, _singleSlotStatus, taskFrozenByEndedCompetition,
  competitionStatus, competitionEffectiveEnd, competitionFullyEnded,
  competitionAnySlotStarted, competitionAnySlotEnded, _competitionAcceptsSelfEnroll,
  // v8.12.6 — who the late-entry window admits and removes, and what it mails
  competitionAdmission, lateWindowAdmissionDenied, lateWindowRemovalDenied,
  lateEntryMailLine, lateEntryMailLineFor, eventEndMailText, NO_FIXED_DEADLINE, lateEntrySwitchLock,
  // v8.12.8 — "Close late entries now": the one predicate and its wire flag
  lateEntryCloseState, lateEntryCloseOffered,
  autoResumeAllows,
  _competitionCacheSize, participantContentNotStarted,
  ensureTaskNumbers, _invalidateTaskNumbersCache, compareTaskNumbers,
  isDryRunCompetition, participantAttempted, ACTIVE_PARTICIPANT_SQL, DRY_RUN_TAG,
  closeAbsenceAndRestoreAnchor,
  anchorLoginTime,          // v8.12.0 — the honest first anchor
  // v8.6.0 — late entries. The pure predicates are re-exported so a consumer that
  // already imports from here has one import site for the whole question, matching
  // what lib/event-policy.js does for the registration matrix.
  lateEntryStateFor,
  lateEntryAllowed, lateEntryDeadline, lateEntryWindowOpen, lateEntryJoinCutoff,
  isLateEntry, lateEntryRefEndMs, lateEntryForbiddenMessage, lateEntryCloseInstantMs,
};
