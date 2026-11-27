"use strict";

// Competition CRUD + lifecycle (create/edit/delete/end-now), competition tags,
// and the per-competition CxOne override. allParticipantsSolvedAll stays in
// server.js (test-pinned) and is injected. (v7.0.0 refactor: route split.)

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../lib/config");   // an event DELETE unlinks the attachment files of the questions it owned
const { v4: uuid } = require("uuid");
const db = require("../db");
const { validateBody, allOptional } = require("../lib/validate");
const { destructiveAdminLimit, requireAdmin, requireGlobalAdmin, requireSuperAdmin, csrfProtection } = require("../lib/middleware");
const { EVENT_KINDS, eventPolicy, eventPolicyForWire, eventKindPhrase, autoEndOnAllSolvedApplies, lateEntryDefaultForKind } = require("../lib/event-policy");
// v8.6.0 — the late-entry window. PURE (it requires only lib/event-policy), which
// is what lets lib/competitions.js import it without a cycle; see its header.
const { LATE_ENTRY_MAX_SPAN_MS, lateEntryDeadline, lateEntryWindowOpen, lateEntryForbiddenMessage, lateEntryCloseInstantMs } = require("../lib/late-entry");
// v8.4.0 — the sign-up matrix's vocabulary and its normaliser. `REGISTRATION_FIELD_KEYS`
// / `FIELD_STATES` feed the boundary schema so the closed sets are imported rather
// than retyped; `serialiseRegistrationFieldPolicy` is what turns a caller's partial
// map into the canonical stored string (or NULL when it matches the kind's
// defaults, so "not configured" stays absent rather than pinned to today's values).
const { REGISTRATION_FIELD_KEYS, FIELD_STATES, REGISTRATION_FIELDS, CONFIGURABLE_KINDS,
        registrationFieldStates, registrationFieldDefaultsForKind,
        serialiseRegistrationFieldPolicy } = require("../lib/registration-fields"); // v7.29.0
const { scheduledEnd, getCompetition, _compWire, _invalidateCompetitionCache, getCompetitionTimeslots, timeslotStatus, timeslotEffectiveEnd, _singleSlotStatus, competitionStatus, competitionEffectiveEnd, competitionFullyEnded, competitionAnySlotStarted, publishedTaskCount, scoringParticipantIds, resolveSchedule, eventKindChangeLock, startTimeChangeLock, eventParticipantFootprint, DRY_RUN_TAG, staffCompeteFlags, lateEntrySwitchLock, lateEntryCloseState, lateEntryCloseOffered, isOpenEnded } = require("../lib/competitions");
const { challengeFitError, eventConstrainsChallenges } = require("../lib/challenge-fit"); // v8.3.0 — a kind change is the seventh door into an unfit assignment
const { validateTrustedIps, invalidateCompAllowlist, clearScannerBlocksFor, GRACE_MS: TRUSTED_IP_GRACE_MS } = require("../lib/comp-allowlist");
const { getAdminIdentity, recordCompetitionEvent, recordTimeslotEvent, recordOrphanedAuditEvent, runTxnWithMirrorBuffer, invalidateAdminCompEventsCache, reqContext } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { BUILTIN_TEMPLATES, builtinTemplate, TEMPLATE_RESTORE_DAYS } = require("../lib/event-template-builtins"); // v8.17.0 — template protection
const { _genSelfEnrollToken, _genJoinCode, untieJoinLinkBindings } = require("../lib/self-enroll");
const { _resyncStatusObservationAfterRevive } = require("../lib/scheduler");
const { invalidateLeaderboardCache, invalidateGroupLeaderboardSnapshot, freezeGroupLeaderboardSnapshots } = require("../lib/leaderboard");
const { enqueueCertificateDispatch } = require("../lib/certificate-dispatch"); // v8.15.1
const { reconcileCompetitionMembership } = require("../lib/group-sync");
const { decodeCxOneApiKey } = require("../lib/cxone");
const { _invalidateMeCache, _invalidateMeCacheForComps } = require("../lib/me-cache"); // v8.3.0 — /api/me embeds the derived policy
const { competitorEditDenied, switchLock: staffCompeteSwitchLock, unsealedAssigned: staffCompeteUnsealedAssigned, staffEnrolled: staffCompeteEnrolled, enrolledAuthors: staffCompeteEnrolledAuthors, CODES: STAFF_COMPETE_CODES, refuseCompetitor } = require("../lib/staff-compete"); // v8.12.0
const { recordUserEvent } = require("../lib/audit"); // v8.7.0 — the grant is mirrored onto the participant's own History
const { competitionDenied, scopeFilterSql, invalidateEventAdminScope, actorId, competitorIds, scopedCompetitionIds } = require("../lib/event-admin"); // v8.7.0
const { invalidateAdminParticipantsCache } = require("../lib/participants-cache"); // v8.7.0 — the Role cell renders the grant
const { invalidateOtherSessions, SESSION_END } = require("../lib/sessions"); // v8.7.0 — a promotion re-derives the session flags at next sign-in
const { now, formatEmailDate } = require("../lib/time");
const { sanitiseForLog, log } = require("../lib/log");

// Permanent (un-deletable) competition tags — always merged into the tag list.
const COMPETITION_PERMANENT_TAGS = [DRY_RUN_TAG];   // v7.21.18 — was "internal"
// batch 7 — boundary schema (lib/validate.js). One source of truth for the
// create + edit field-shape validation (type/non-empty/cap/range/date), so they
// CANNOT drift (the parity class) and a non-string can never reach the handler.
// Business rules (concurrency, lifecycle gates, uniqueness, the leaderboard-mode
// lock, self_enroll flags) stay in the handlers below.
const { ATTEMPT_CAP_MIN, ATTEMPT_CAP_MAX } = require("../lib/attempts"); // v8.1.0
const { BUCKET_MS: PRESENCE_BUCKET_MS } = require("../lib/presence"); // v8.1.0 — the Recording pill

// v8.1.0 — "" means UNCAPPED, and it has to be normalised BEFORE validateBody
// sees it: the validator treats `null` as absent (COALESCE-friendly) but hands ""
// to the int rule, which correctly refuses it — so a form whose number input was
// cleared would 400 instead of removing the cap. Normalising to null makes the two
// spellings of "no cap" identical everywhere downstream.
function _normaliseCapInput(body) {
  if (body && typeof body === "object" && !Array.isArray(body) && body.attempt_cap === "") body.attempt_cap = null;
  // v8.1.0 (PR 30) — same treatment for the self-enrolment ceiling: a cleared
  // number input posts "", which must mean "no limit", not "invalid integer".
}

// "ALLOW INSTANT JOIN" IS RETIRED (operator ruling, 14 Nov 2026). Every sign-up
// proves its address with an emailed code before the account exists, and a
// join-link sign-up is approved whatever the setting, so the switch changed
// nothing. The create, the PUT and a template's settings refuse it BY NAME
// rather than ignoring it; the column stays in the table, read and written by
// nothing. A template stored with it is read without it (`_bpStoredSettings`).
const _SELF_ENROLL_INSTANT_REMOVED = Object.freeze({
  error: "“Allow instant join” was retired: every walk-up confirms their email with a code, then joins at once.",
  code: "self_enroll_instant_removed",
});
const _RETIRED_TEMPLATE_SETTINGS = Object.freeze(["self_enroll_allow_instant"]);

const COMPETITION_FIELD_SCHEMA = {
  name: { type: "string", required: true, max: 120, label: "Event name" },
  // v7.29.0 — the kind. Settable at CREATE only; the PUT refuses a change with a
  // named 400 rather than accepting and ignoring it, which would be a control
  // that appears to work. The enum is imported rather than retyped, so the
  // boundary and lib/event-policy cannot disagree about what a kind is.
  event_kind: { type: "enum", values: EVENT_KINDS.map(k => k.value), label: "Event type" },
  start_time: { type: "date", required: true, label: "Start time" },
  // v8.1.0 (PR 16) — `required` is GONE, replaced by a per-kind rule in the
  // handler. validateBody is the handler's FIRST statement and runs before
  // event_kind is read, so a schema-level `required: true` would 400 every
  // Program create with "Duration is required" — naming a field the Program form
  // does not show. The 525600 (365-day) REQUEST cap is unchanged: a Program's
  // duration is derived from its deadline, never submitted.
  duration_minutes: { type: "int", min: 1, max: 525600, label: "Duration" },
  // v8.1.0 (PR 16) — the deadline a `schedule:"deadline"` kind runs to. Nullable
  // in the schema, required by HANDLER CONTRACT for that kind and refused for
  // every other, because for a window-shaped kind it would duplicate
  // start + duration with nothing keeping the two in step.
  deadline_at: { type: "date", label: "Deadline" },
  // ext-audit F2 — security-sensitive flags MUST go through the validator's real
  // bool coercion (not a raw `req.body.X ? 1 : 0`, where the string "false" is
  // truthy and ENABLES the flag). Optional on both create + edit.
  reveal_answers_on_end:     { type: "bool", label: "Reveal answers on end" },
  self_enroll_enabled:       { type: "bool", label: "Self-enroll enabled" },
  // v7.11.7 — per-competition opt-in for the group/team leaderboard (default OFF).
  group_leaderboard_enabled: { type: "bool", label: "Group leaderboard enabled" },
  // v8.1.0 — the EVENT-level attempt ceiling, beaten by a challenge-level one.
  // Optional for every kind including Programs (the operator's decision), and
  // `int` rather than a hand-rolled parse so the strict-whole-number rule is the
  // validator's, not a fourth copy of it. NULL/absent means uncapped; the min of 1
  // is why zero is refused rather than stored — see lib/attempts.js.
  attempt_cap: { type: "int", min: ATTEMPT_CAP_MIN, max: ATTEMPT_CAP_MAX, label: "Attempts per challenge" },
  // v8.1.0 (PR 30) — the SELF-ENROLMENT ceiling: how many people may add
  // themselves through the join link. NULL/absent means unlimited, which is what
  // every event has had until now, so an omitted field cannot change behaviour.
  //
  // It counts SELF-ENROLLED members only, never total membership — an admin
  // assigning a cohort directly is not the thing being bounded. The number an
  // operator has in their head at a stand is "we have 30 laptops", and a limit
  // that also counted the 200 people they pre-assigned to a different session
  // would refuse the 31st visitor for a reason that has nothing to do with the
  // laptops. Min 1 for the same reason attempt_cap has one: an event nobody may
  // join is expressible by turning self-enrolment off.
  // v8.1.0 (PR 34) — record NET ACTIVE TIME (five-minute buckets on the
  // platform). Default OFF for every kind, and REFUSED for a Booth Event whose
  // window is too short for the bucket to mean anything — see lib/event-policy.
  measure_presence: { type: "bool", label: "Record time on platform" },
  // v8.1.0 (PR 35) — which time ranks a score tie. `elapsed` (the default, and
  // every event that predates this) or `presence`. Only meaningful with
  // `measure_presence` on, which the leaderboard checks — setting it alone
  // changes nothing rather than silently ranking on a column full of zeros.
  time_basis: { type: "enum", values: ["elapsed", "presence"], label: "Tie-break basis" },
  // v7.13.0 — per-competition opt-OUT of CxOne account creation (default OFF).
  cxone_disabled:            { type: "bool", label: "CxOne account creation disabled" },
  // v8.4.0 — the Booth Event sign-up matrix. `enumMap` is strict about both keys
  // and values (an unknown field name or state is a named 400), because a request
  // is a caller telling us something now: silently dropping part of it is how a
  // control comes to appear to work. Both closed sets are IMPORTED, never
  // retyped — the same rule `event_kind` follows against EVENT_KINDS.
  //
  // A PARTIAL map is accepted and normal: the admin form sends only the fields it
  // renders, and lib/registration-fields.js fills the rest from the kind's
  // defaults. That is what keeps "the caller said nothing" expressible for a
  // single field rather than only for the whole matrix.
  registration_fields: { type: "enumMap", keys: REGISTRATION_FIELD_KEYS, values: FIELD_STATES, label: "Sign-up fields" },
  // v8.6.0 — LATE ENTRIES. The per-event switch (default ON for the one kind that
  // may run it) and the deadline that closes the window.
  //
  // `allowEmpty` on the deadline is what lets a caller say "go back to following
  // the event's end": the column is NULL-means-derived, so clearing it is a real
  // instruction and not merely the absence of one. The `date` rule stores an
  // ISO-normalised value rather than the raw string, so a numeric `1` — a VALID
  // Date, which an `isNaN(new Date(x))` check passes — cannot reach the column and
  // corrupt every later read (v7.21.1 A-series, the defect that 500'd the
  // competitions list).
  late_entry_enabled:        { type: "bool", label: "Late entries" },
  late_entry_deadline_at:    { type: "date", allowEmpty: true, label: "Late-entry deadline" },
  // v8.12.0 — STAFF CAN COMPETE. Universal across the three kinds (a decision
  // about WHO counts, not about how the kind plays), default OFF, locked once
  // the event has started. The rule it switches on lives in lib/staff-compete.js.
  staff_compete:             { type: "bool", label: "Staff can compete" },
  // v7.16.0 — trusted network IPs (a rate-limit allowlist for the venue's NAT
  // egress address). Validated by validateTrustedIps rather than the generic
  // string rule: it enforces the entry cap and the /16 minimum prefix that stop
  // an admin from switching rate limiting off wholesale. allowEmpty so a blank
  // value clears it.
  trusted_network_ips:       { type: "string", allowEmpty: true, max: 500, label: "Trusted network IPs" },
  // v8.8.25 — THE PRE-FLIGHT PAIR. `validate_only` runs every refusal this
  // handler can raise before the transaction and then returns without writing;
  // `delete_timeslot_ids` names the sessions the caller is ABOUT to delete, so
  // the slot-derived refusals are evaluated against the world the save will
  // produce rather than the one it is leaving.
  //
  // THE SECOND FIELD IS WHAT MAKES THE FIRST CORRECT, and without it a dry run
  // is wrong in BOTH directions for exactly the save that needs it: it refuses
  // `has_sessions` / `trusted_networks_multi_session` for a multi->single switch
  // that becomes legal once the sessions are gone (a false refusal), and it
  // clears a name change on an event those same deletes are about to make ENDED
  // (a false clearance, caught later anyway). The seam exists ONLY when sessions
  // are deleted, so answering about the pre-delete world answers about the wrong
  // one every single time it matters.
  //
  // An EXPLICIT flag, never the absence of a field — the importer's dry run
  // keys on `!resolutions` and that idiom is unsafe here, this body's whole
  // contract being that `undefined` means the caller said nothing.
  validate_only:             { type: "bool", label: "Validate only" },
  delete_timeslot_ids:       { type: "stringArray", itemMax: 64, label: "Sessions being deleted" },
};

// v8.1.0 (PR 18) — one declaration each, because five copies of a sentence is how
// the frozen-remedy defect happened (v7.29.0). Each names the mechanism that DOES
// meet the underlying need, so the refusal is not a dead end.
const _REVEAL_REFUSED =
  "This event type does not reveal answers when it ends — a published answer key would let anyone " +
  "complete it after the deadline is extended. Participants still see the explanation on any challenge " +
  "they have solved.";
const _GROUP_BOARD_REFUSED =
  "This event type has no leaderboard, so there is no team board to enable.";
// v8.1.0 — same discipline for the two PRESENCE settings, which are refused by
// BOTH the create handler and the PUT: an admin who meets the refusal on edit
// must read the same explanation they would have read on create. These take the
// row rather than being plain strings only because the sentence names the kind —
// at create there is no row yet, so the caller passes an `{event_kind}` stand-in.
const _presenceRefused = (row) =>
  `Recording time on platform is not available for ${eventKindPhrase(row)} — its window is too short for the measurement to mean anything.`;
// Checkmarx One accounts on a kind that never creates them (a Booth Event; owner's
// decision, 27 Nov 2026), refused by create, the PUT, the key override and the
// template doors in one sentence.
const _cxoneRefused = (row) =>
  `${eventKindPhrase(row).replace(/^./, (c) => c.toUpperCase())} never creates Checkmarx One accounts: its walk-ups do not use the product. Leave Checkmarx One accounts off.`;
const _timeBasisRefused = (row) =>
  `Ranking a score tie on time spent is not available for ${eventKindPhrase(row)}, because it cannot record time on platform. Leave the tie-break on elapsed time.`;

/**
 * v8.6.0 — the late-entry deadline's two boundary rules, declared ONCE because
 * both the create handler and the PUT enforce them and an admin who meets a
 * refusal on edit must read the sentence they would have read on create.
 *
 * `iso` is the already-normalised value out of `validateBody` — a real ISO string,
 * `null` (the caller cleared it, i.e. go back to following the end) or `undefined`
 * (the caller said nothing). Both of the latter mean "derive", so there is nothing
 * to check.
 *
 * `endDate` is the EFFECTIVE end this save leaves — the moment End Now closed the
 * event, not the rounded scheduled end (v8.12.7). End Now stores
 * `ceil(elapsed / 60 000)` minutes, so the scheduled end lands up to a minute
 * AFTER `ended_at`, and judging the deadline against it refused, for that minute,
 * the one remedy the late-entry switch lock names ("set the late-entry deadline to
 * now") — while `_compWire`, the admin list, `competitionAdmission` and
 * `lateEntryWindowOpen` all open and close the window from the effective end. On a
 * legacy v8.0.0 auto-ended booth the same mismatch lasted hours. The caller
 * resolves it through `competitionEffectiveEnd`, never start + duration. The
 * 30-day cap is measured from the same base, so it is up to 60 s stricter after
 * End Now (hours on that legacy row); the PUT's echo exemption keeps it from
 * refusing an unrelated save.
 *
 * `endedAt` is set when that base is already in the past — the event has ended
 * and this save does not revive it — and switches the refusal to a wording that
 * names the moment and drops "leave it on automatic", which would mean end + 48 h:
 * the opposite of what an admin closing the window early wants. The time is UTC,
 * because the server does not know the dialog's zone.
 *
 * REFUSED, NEVER CLAMPED. A window closing before the event does is incoherent,
 * and silently moving an admin's date to something they did not type is the
 * accept-and-ignore failure with extra steps: they would read back a value they
 * never chose and have no way to tell why.
 *
 * `capExempt` lifts the 30-DAY CAP ONLY — for the PUT's echo of the stored pin,
 * whose cap End Now can have moved under it. It never lifts the must-be-after-
 * the-end check: the first draft of the echo exemption skipped this whole
 * function, so a pin left behind by a save that moved the end WITHOUT sending the
 * deadline (untick Allow late entries, extend the event) was echoed straight back
 * in by the next save that re-ticked it, and stored a window that closes before
 * the event does and can never open — a save this function had refused 400 before
 * the exemption existed.
 */
function _validateLateDeadline(iso, endDate, { endedAt = null, capExempt = false } = {}) {
  if (iso === undefined || iso === null) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "The late-entry deadline must be a valid date.";
  if (!endDate || !Number.isFinite(endDate.getTime())) return null;
  if (d.getTime() <= endDate.getTime()) {
    return endedAt
      ? `This event ended at ${formatEmailDate(endedAt, null)}, so the late-entry deadline must be after that moment. To close late entries as soon as possible, choose the next minute.`
      : "The late-entry deadline must be after the event ends. Leave it on automatic to have it follow the end time.";
  }
  if (!capExempt && d.getTime() - endDate.getTime() > LATE_ENTRY_MAX_SPAN_MS) {
    const days = Math.round(LATE_ENTRY_MAX_SPAN_MS / 86_400_000);
    return `The late-entry deadline can be at most ${days} days after the event ends. An event that stays open longer than that wants a longer event, not a longer late window.`;
  }
  return null;
}

/**
 * v8.12.7 — THE single-slot extend-revive condition, ONE definition read by the
 * late-deadline base and by the PUT's revive block, so the base the deadline is
 * judged against and the revive that actually happens can never disagree: an
 * ended event whose `ended_at` is stamped, with no sessions, revives when this
 * request MOVED the schedule (v8.1.9 — an unchanged echo is not a deliberate
 * extension) and the new scheduled end is still ahead.
 *
 * The revive block's all-solved gate is deliberately NOT here: it can only keep
 * `ended_at` on a kind that auto-ends on all-solved, and a late deadline only
 * reaches validation for a late-entry kind, which never does — so for every row
 * that can reach `_validateLateDeadline` the prediction is exact. Pure: the caller
 * supplies every fact, including the clock.
 */
function _extendRevives({ wasEnded, endedAt, slotCount, scheduleMoved, newScheduledEnd, at }) {
  return !!wasEnded && !!endedAt && slotCount === 0 && !!scheduleMoved && newScheduledEnd > at;
}

/**
 * v8.12.0 — THE ONE RESPONDER for the competitor rule on this file's mutating
 * competition doors. Every write to an event — the PUT, end-now, delete, tags,
 * CxOne, the join-link regenerate, the organiser grant/revoke — asks it first,
 * ABOVE the event-admin scope gate, so every tier hears the same reason.
 * Returns the sent response (truthy) or null.
 */
function _competitorRefused(req, res, competitionId) {
  return refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), competitionId));
}

/**
 * v8.12.8 — EVERYTHING THAT READS A LATE-ENTRY WINDOW, busted by id, POST-COMMIT.
 *
 * One helper, three callers (the late-entry close, the PUT when it moves the
 * deadline / switch / schedule, and both End Now branches), because each of them
 * changes whether an event's window is open, and four caches answer that question
 * for up to their TTL after the write:
 *
 *   competition row (1 s)   — `req.lateEntry` and the submit transaction's
 *                             `freshComp`, i.e. whether a late entrant's answer is
 *                             still accepted;
 *   leaderboard (5 s)       — the late section's reference end, which
 *                             `_mintEligibility` reads to decide participation vs
 *                             placing;
 *   /api/me (2 s, members)  — embeds `late_entry_window_open` and the status the
 *                             participant's countdown renders from;
 *   admin participants (5 s)— `late_entrant` / `late_entry_playing` and the
 *                             per-event window flags, which gate Remove.
 *
 * The standing writer rule (*In-process caches*): a write that changes what a
 * cached read reports busts it BY ID, AFTER the commit. Not busted, each checked:
 * the comp-allowlist (follows the event's END, never the late deadline), the
 * analytics cache (no window input), the frozen team board (late entrants are
 * excluded from it), and the event-admin role/scope caches. The competition-events
 * list cache is busted by `recordCompetitionEvent` itself.
 */
function _bustLateWindowCaches(id) {
  _invalidateCompetitionCache(id);
  invalidateLeaderboardCache(id);
  _invalidateMeCacheForComps([id]);
  invalidateAdminParticipantsCache();
}

module.exports = function register(app, { allParticipantsSolvedAll }) {
// v7.29.0 — the per-event DELIVERY PANEL.
//
// Answers the question a walk-up desk actually has: did the mail go out? Today
// per-send success IS recorded — user_events.email_sent carries `success` — but it
// is readable only in the per-participant History dialog, one person at a time,
// which is useless with a queue in front of you. This aggregates it for the
// enrolled cohort.
//
// Three numbers, each measuring a different thing on purpose:
//   enrolled  — competition_users rows; moves the moment a QR is scanned.
//   verified  — of those, how many have proved an address works AT ALL. The gap
//               between these two is the population that may be stuck.
//   failed    — participants with at least one FAILED send. Counted per PERSON,
//               not per message: three bounces to one attendee is one person to
//               go and help, and a per-message count would overstate the queue.
//
// Scoped to the enrolled cohort rather than the whole platform, because that is
// the room the admin is standing in.
app.get("/api/admin/competitions/:id/delivery", requireAdmin, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — a NAMED entity, so an out-of-scope event is REFUSED rather than
  // answered with zeroes: on an admin surface an empty result is indistinguishable
  // from an event nobody has joined. The 404 stays FIRST, so a mistyped id keeps
  // its accurate answer instead of being reported as somebody else's event.
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  const row = db.prepare(`
    SELECT COUNT(*) AS enrolled,
           SUM(CASE WHEN u.verified = 1 THEN 1 ELSE 0 END) AS verified
      FROM competition_users cu JOIN users u ON u.id = cu.user_id
     WHERE cu.competition_id = ?`).get(comp.id);
  // json_extract rather than a LIKE over the blob: `success` is a real JSON
  // field, and a LIKE would also match the word inside a subject line. Only once
  // `json_valid` holds: json_extract throws on stored text that is not JSON, and
  // one such row failed the whole panel (it counts as no failure it can name).
  const failed = db.prepare(`
    SELECT COUNT(DISTINCT ue.user_id) AS c
      FROM user_events ue
      JOIN competition_users cu ON cu.user_id = ue.user_id
     WHERE cu.competition_id = ?
       AND ue.event_type = 'email_sent'
       AND (CASE WHEN json_valid(ue.details) THEN json_extract(ue.details, '$.success') END) = 0`).get(comp.id);
  res.json({
    enrolled: row?.enrolled || 0,
    verified: row?.verified || 0,
    email_failed: failed?.c || 0,
  });
});

app.get("/api/admin/competitions", requireAdmin, (req, res) => {
  // SELECT `cxone_api_key` so `cxone_configured` and `cxone_has_api_key`
  // can be derived, but DO NOT ship the raw key to the client — it's
  // destructured out below before the spread, so the server remains the
  // sole holder of the credential. Pre-v6.9.5 the key was omitted from
  // SELECT entirely, which made `cxone_configured` misreport key-only
  // overrides as unconfigured (c.cxone_api_key was undefined) and hid
  // the Remove CxOne button from the superadmin edit modal in every
  // override case. See also `_REDACT_KEYS` — the key is already on the
  // log-scrub list, this extends the same discipline to the wire.
  // v6.21.0 — self_enroll_enabled ships to the admin UI (kebab + overlay show
  // the toggle state) but self_enroll_token does NOT:
  // it is a credential, selected nowhere here, revealed only via the dedicated
  // GET /api/admin/competitions/:id/self-enroll. Same discipline as cxone_api_key.
  // v8.1.0 (PR 12) — `event_kind` is named EXPLICITLY. This SELECT is a
  // hand-written allow-list, so unlike _compWire's deny-list nothing arrives here
  // for free: the kind chip, the kind filter row and the policy attach below all
  // read it, and omitting it would render every event in the admin list as an
  // unrecognised kind rather than failing loudly.
  // v8.1.0 — `deadline_at`, `auto_end_on_all_solved` and `attempt_cap` are named
  // here because the admin CLIENT reads them off this payload.
  //
  // The deadline one was a LIVE DEFECT found by the attempt-cap fixture, not by a
  // symptom: `openCompetitionEditor` populates the deadline date/time inputs from
  // `comp.deadline_at`, and this SELECT never returned it — so opening ANY Program
  // for edit showed an empty deadline, and a save that did not retype it would
  // have moved the schedule. PR 16 added the column, the create INSERT and the
  // form, and missed the one read in between.
  //
  // The general rule this keeps re-proving: a column-naming SELECT is a list that
  // rots. When a phase adds a column an admin surface renders, grep every
  // `FROM competitions` that names its columns.
  // v8.7.0 — narrowed to the actor's own events. A LIST is FILTERED, never
  // refused: an event admin simply has a shorter Competitions table. `WHERE 1=1`
  // carries the clause because it always opens with " AND " — and an event admin
  // with no grants gets " AND 1=0", so they see nothing rather than everything.
  const _listScope = scopeFilterSql(req, "id");
  const comps = db.prepare("SELECT id,name,event_kind,start_time,duration_minutes,deadline_at,auto_end_on_all_solved,attempt_cap,ended_at,ended_manually,leaderboard_mode,reveal_answers_on_end,self_enroll_enabled,measure_presence,time_basis,join_code,group_leaderboard_enabled,cxone_disabled,cxone_api_key,cxone_group_name,created_at,updated_at,trusted_network_ips,registration_field_policy,late_entry_enabled,late_entry_deadline_at,staff_compete,certificate_config,event_look,event_look_locked FROM competitions WHERE 1=1" + _listScope.clause + " ORDER BY start_time DESC").all(..._listScope.params);
  // Batch counts for all competitions in 2 queries instead of 2*N
  const compIds = comps.map(c => c.id);
  const participantCounts = {};
  const taskCounts = {};
  const presenceActive = {};
  // Live certificates per event: a revive's confirm says issued certificates stay
  // as issued (operator ruling, 17 Nov 2026), so it needs to know there are any.
  const certificatesIssued = {};
  if (compIds.length) {
    // The id list is ONE bound JSON parameter read through json_each, never
    // spliced placeholders: the statement text is constant (one memoised
    // statement, db.js) and nothing read from a row reaches the SQL text.
    const compIdsJson = JSON.stringify(compIds);
    db.prepare("SELECT competition_id, COUNT(*) as c FROM competition_users WHERE competition_id IN (SELECT value FROM json_each(?)) GROUP BY competition_id").all(compIdsJson)
      .forEach(r => { participantCounts[r.competition_id] = r.c; });
    db.prepare("SELECT competition_id, COUNT(*) as c FROM competition_tasks WHERE competition_id IN (SELECT value FROM json_each(?)) GROUP BY competition_id").all(compIdsJson)
      .forEach(r => { taskCounts[r.competition_id] = r.c; });
    db.prepare("SELECT competition_id, COUNT(*) as c FROM achievement_badges WHERE revoked_at IS NULL AND competition_id IN (SELECT value FROM json_each(?)) GROUP BY competition_id").all(compIdsJson)
      .forEach(r => { certificatesIssued[r.competition_id] = r.c; });
    // v8.1.0 — "Recording · N active in the last hour". Batched with the other
    // two counts rather than queried per row, and computed ONLY for the events
    // that record: every other event contributes nothing, so the common case
    // (nobody has turned it on) issues no query at all.
    const recording = comps.filter(c => c.measure_presence).map(c => c.id);
    if (recording.length) {
      const cutoff = Math.floor((Date.now() - 3600_000) / PRESENCE_BUCKET_MS);
      db.prepare(`SELECT competition_id, COUNT(*) as c FROM competition_presence
                   WHERE competition_id IN (SELECT value FROM json_each(?)) AND last_bucket >= ? GROUP BY competition_id`)
        .all(JSON.stringify(recording), cutoff)
        .forEach(r => { presenceActive[r.competition_id] = r.c; });
    }
  }
  // Batch-load competition tags (same pattern as user_tags for participants)
  const compTagMap = {};
  if (compIds.length) {
    db.prepare("SELECT competition_id, tag FROM competition_tags WHERE competition_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(compIds))
      .forEach(r => { (compTagMap[r.competition_id] = compTagMap[r.competition_id] || []).push(r.tag); });
  }
  // D-01: batch-load all timeslots in one query instead of one per competition.
  const timeslotsByComp = {};
  if (compIds.length) {
    db.prepare("SELECT * FROM competition_timeslots WHERE competition_id IN (SELECT value FROM json_each(?)) ORDER BY start_time").all(JSON.stringify(compIds))
      .forEach(ts => { (timeslotsByComp[ts.competition_id] = timeslotsByComp[ts.competition_id] || []).push(ts); });
  }
  // v8.12.8 — ONE CLOCK for the whole page. Every row's late-entry flags (the
  // window, the switch lock's conditional remedy, `can_close_late_entries`) read
  // it, so two rows of one response — or two flags of one row — cannot land on
  // opposite sides of a deadline. It replaces a per-row `Date.now()`.
  const _listNowMs = Date.now();
  const _listActor = competitorIds(req);
  const result = comps.map(c => {
    // Destructure the api_key off the row before the spread below so the
    // raw credential never crosses the wire. Booleans carry the "is it
    // configured?" and "does an override key exist?" signal that the
    // admin UI needs.
    // v8.4.0 — `registration_field_policy` comes off with it. It is not a secret,
    // but it is the RAW stored blob, and the admin form must read the NORMALISED
    // states from `policy.registration_fields` instead: shipping both would be two
    // representations of one answer on one payload, and the raw one is the copy
    // that does not know about the kind's defaults, the required-implies-shown
    // invariant, or a value a newer image wrote. Selected above only so
    // `eventPolicyForWire(c)` can read it.
    // v8.15.0 — the raw certificate design layer comes off too; the row says only
    // WHETHER this event overrides the global design.
    const { cxone_api_key: _cxApiKey, registration_field_policy: _regRaw, certificate_config: _certRaw, ...cSafe } = c;
    const cxoneHasApiKey = !!_cxApiKey;
    const cxoneConfigured = cxoneHasApiKey || !!c.cxone_group_name;
    const slots = timeslotsByComp[c.id] || [];
    const timeslots = slots.map(ts => ({
      ...ts, status: timeslotStatus(ts), effective_end: timeslotEffectiveEnd(ts)?.toISOString() || null,
    }));
    const tags = compTagMap[c.id] || [];
    // v8.12.8 — hoisted, because `can_close_late_entries` reads `competing`: the
    // close route asks the competitor lock above everything else, so the flag must
    // be withheld from a competitor exactly as the route refuses one.
    const _sc = staffCompeteFlags(c, { slots, actorId: _listActor });
    return {
      ...cSafe,
      cxone_configured: cxoneConfigured,
      certificate_config_overridden: !!_certRaw,
      cxone_has_api_key: cxoneHasApiKey,
      status: competitionStatus(c, slots),
      effective_end: competitionEffectiveEnd(c, slots)?.toISOString() || null,
      // OPEN-ENDED: isOpenEnded per read, as the participant rows carry it. The
      // organiser surfaces that print the end or count down to it (the Events
      // list, the workspace's dates line, status chip and time tile) say "No
      // fixed deadline" instead while it holds (operator ruling, 14 Nov 2026);
      // the client never re-derives it. The batched `slots`, for the N+1 reason.
      open_ended: isOpenEnded(c, slots),
      // v8.1.0 (PR 12) — this list does NOT pass through _compWire (it is its own
      // curated SELECT plus a cxone_api_key strip), so the policy is attached here
      // explicitly. Same object, same key, one projection function.
      policy: eventPolicyForWire(c),
      // v8.3.0 — WHY the edit form may not offer the type control: null (it may),
      // "started" or "has_sessions". Same predicate the PUT refuses with, so the
      // control is never offered where the save would be rejected.
      //
      // `slots` is the BATCHED list this handler already loaded (D-01 replaced a
      // per-row query with one `IN (…)`), so this costs nothing. Passing it is
      // required, not merely an optimisation: `eventKindChangeLock` falls back to
      // fetching per competition, which would put the N+1 straight back.
      event_kind_locked: (eventKindChangeLock(c, slots) || {}).reason || null,
      // v8.3.10 — the same treatment for the start-time control, and for the same
      // reason: this list is what the edit form renders from, so a control it
      // offers must be one the PUT would accept. The batched `slots` is passed
      // for the identical N+1 reason. The footprint scan behind this runs ONLY
      // for a slotless LIVE event opened by a superadmin — every other event
      // short-circuits on status before touching the database.
      start_time_locked: (startTimeChangeLock(c, { slots, isSuperAdmin: !!req.session.isSuperAdmin }) || {}).reason || null,
      // v8.6.0 — the RESOLVED late-entry deadline and whether its window is open,
      // attached here for the reason the three above are: this list does not pass
      // through `_compWire`, so a value that rides that helper does NOT reach the
      // surface the edit form actually renders from. The raw column ships in
      // `...cSafe`; NULL there means "follow the event's end", which the form has to
      // resolve to show a date — and resolving it client-side would be a second copy
      // of the rule in a graph that cannot import the module owning it.
      //
      // The batched `slots` is passed for the same N+1 reason.
      late_entry_deadline_effective: lateEntryDeadline(c, competitionEffectiveEnd(c, slots))?.toISOString() || null,
      late_entry_window_open: lateEntryWindowOpen(c, competitionEffectiveEnd(c, slots), _listNowMs),
      // v8.12.6 — WHY the late-entry switch is not offered (`"ended"`), or null:
      // the SAME predicate the PUT refuses with, attached here because this list
      // does not pass through `_compWire`. The batched `slots` again.
      late_entry_locked: (lateEntrySwitchLock(c, slots, _listNowMs) || {}).reason || null,
      // v8.12.0 — `staff_compete_locked` and `competing`, attached here for the
      // reason every flag above is: this list does not pass through `_compWire`.
      // ONE helper computes both at both sites, so they cannot disagree.
      ..._sc,
      // v8.12.8 — may THIS actor close the late-entry window now? The SAME
      // predicate the close route refuses with (`lateEntryCloseState`), attached
      // here because this list does not pass through `_compWire`; one helper at
      // both sites, the `staffCompeteFlags` rule. Scope is implicit: this list is
      // `scopeFilterSql`-narrowed, so every row is one the actor may act on.
      can_close_late_entries: lateEntryCloseOffered(c, { slots, nowMs: _listNowMs, competing: _sc.competing }),
      participant_count: participantCounts[c.id] || 0,
      certificates_issued: certificatesIssued[c.id] || 0,
      // v8.1.0 — only for events that record, so the client can tell "nobody has
      // been active" (0) from "this event does not measure" (absent).
      ...(c.measure_presence ? { presence_active_recent: presenceActive[c.id] || 0 } : {}),
      task_count: taskCounts[c.id] || 0,
      leaderboard_mode: c.leaderboard_mode || "per_slot",
      tags,
      timeslots,
    };
  });
  res.json(result);
});

app.post("/api/admin/competitions", requireAdmin, csrfProtection, (req, res) => {
  // batch 7 — boundary validation replaces the hand-rolled type/non-empty/cap/
  // range/date checks (batches 3-6). `name` is trimmed, `start_time` is a
  // normalized ISO string, `duration_minutes` is an int in [1,525600].
  _normaliseCapInput(req.body);
  const _v = validateBody(req.body, COMPETITION_FIELD_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  // F2/F3 — reveal_* AND the self-enroll flag are REAL booleans (or undefined)
  // from validateBody; create now HONORS the self-enroll flag (it was validated
  // but discarded before — F3).
  const { name, start_time, duration_minutes, deadline_at, reveal_answers_on_end, self_enroll_enabled, measure_presence, time_basis, group_leaderboard_enabled, cxone_disabled, trusted_network_ips, attempt_cap, registration_fields, late_entry_enabled, late_entry_deadline_at, staff_compete } = _v.values;
  const { leaderboard_mode, tags: reqTags } = req.body;
  if (req.body?.self_enroll_allow_instant !== undefined) return res.status(400).json(_SELF_ENROLL_INSTANT_REMOVED);
  // v7.16.0 — trusted networks. A brand-new competition has no sessions yet, so
  // the single-session rule is satisfied trivially here; the PUT enforces it.
  // v8.1.0 (PR 16/20) — the kind is resolved ONCE, before the first policy
  // question. A `const` read above its declaration is a TDZ ReferenceError,
  // which `node --check` cannot see and which surfaces as a 500.
  const _kindForSchedule = _v.values.event_kind || "tournament";
  const _tip = validateTrustedIps(trusted_network_ips);
  if (_tip.error) return res.status(400).json({ error: _tip.error });
  // v8.1.0 (PR 20) — the same one rule at create. A brand-new competition has no
  // sessions, so the "if-single-session" answer is satisfied trivially here (the
  // PUT enforces it thereafter); "never" is not.
  if (_tip.value && eventPolicy({ event_kind: _kindForSchedule }).trustedNetworks === "never") {
    return res.status(400).json({
      error: "This event type cannot carry trusted network IPs. The bypass is time-bounded to a running event, and this kind runs for as long as its deadline allows.",
      code: "trusted_networks_forbidden",
    });
  }
  const trustedIps = _tip.value;
  const startDate = new Date(start_time); // start_time is ISO
  // v8.1.0 (PR 16) — the per-kind SCHEDULE rule. A window-shaped kind submits a
  // duration and must not submit a deadline; a deadline-shaped kind submits a
  // deadline and its duration is DERIVED. The model matters: `duration_minutes`
  // is INTEGER NOT NULL, so an open-ended Program has to put SOME number there,
  // and the only value that both satisfies the schema and looks deliberate — the
  // 525600 cap — is not inert. It would close the Program on its first
  // anniversary, silently. Deriving from a real deadline is the only model that
  // leaves no column holding a value nobody chose.
  const _sched = eventPolicy({ event_kind: _kindForSchedule }).schedule;
  const _sr = resolveSchedule(_sched, startDate, duration_minutes, deadline_at);
  if (_sr.error) return res.status(400).json({ error: _sr.error, code: _sr.code });
  // v8.1.0 (PR 18) — refuse, rather than accept-and-ignore, the two flags an
  // unranked kind cannot honour. Both are asked of the POLICY, never of the value.
  const _pol = eventPolicy({ event_kind: _kindForSchedule });
  if (reveal_answers_on_end && _pol.revealAnswers === "forbidden") {
    return res.status(400).json({ error: _REVEAL_REFUSED, code: "reveal_answers_forbidden" });
  }
  if (group_leaderboard_enabled && _pol.groupLeaderboard === "forbidden") {
    return res.status(400).json({ error: _GROUP_BOARD_REFUSED, code: "group_leaderboard_forbidden" });
  }
  const deadlineIso = _sr.deadlineIso;
  const dur = _sr.durationMinutes;         // submitted, or derived by ceil
  // ext-audit batch 3 (F2) — REJECT an oversized initial tag (400) rather than
  // silently dropping it inside createTxn (the dedicated POST .../tags route
  // already 400s at >50). Silent-drop was data loss with no user feedback.
  if (Array.isArray(reqTags)) {
    for (const t of reqTags) {
      if (t != null && typeof t === "string" && t.trim().length > 50)
        return res.status(400).json({ error: "Tag must be 50 characters or fewer" });
    }
  }
  // v6.16.7 note: born-ended comps (start_time + duration ≤ now())
  // are intentionally allowed at create. Use cases include audit
  // reconstruction (admin recreating a past competition's record
  // post-fact), testing, and the operator who needs to set up a
  // historic placeholder. Recovery is operator-friendly: superadmin
  // can edit start_time on an ended comp (v6.13.x rule), so a typo
  // ("start = 2020 instead of 2026") isn't unrecoverable — it just
  // requires superadmin intervention if the creator was a regular
  // admin. SPA layer should warn before submit if start < now().
  const lbMode = (leaderboard_mode === "global") ? "global" : "per_slot";
  // reveal_answers_on_end is now a validated REAL boolean (or undefined) from
  // validateBody (F2) — undefined/false → 0, true → 1. Default is "do not reveal"
  // so a freshly-created competition behaves safely for repeating events; admins
  // opt in via the edit modal.
  const revealOnEnd = reveal_answers_on_end ? 1 : 0;
  // ext-audit (F3) — honor the self-enrollment flags AT CREATE. They were in the
  // schema (validated for F2) but the create destructure + INSERT dropped them, so
  // a POST with them `true` returned 200 yet stored 0. Both default OFF when absent.
  // v7.29.0 — absent means the default kind, which is what every existing client
  // sends. `event_kind` is validated by the boundary schema against the shared
  // EVENT_KINDS list, so an unknown value is a 400 rather than a silent default.
  const kind = _v.values.event_kind || "tournament";
  // v8.1.0 (PR 16) — from the KIND's policy, never a literal.
  const _autoEndDefault = eventPolicy({ event_kind: kind }).autoEndOnAllSolvedDefault;
  // v8.1.0 (PR 30) — PER-KIND CREATE DEFAULTS, and note the shape: `undefined`
  // means the caller said nothing, so the KIND decides; a supplied value always
  // wins, whichever way it points. `? 1 : 0` cannot express that — it collapses
  // "absent" and "false" into the same answer — which is why these read
  // `=== undefined` rather than staying ternaries.
  //
  // A Booth Event that defaulted the way a Competition does would arrive with
  // self-enrolment OFF and CxOne provisioning ON: no join link (so the QR code
  // the whole kind is built around does nothing) and an external identity minted
  // for every two-minute visitor. Both are the opposite of what the kind is for,
  // and both are silent — the admin sees a saved event and finds out at the stand.
  const _kindPol = eventPolicy({ event_kind: kind });
  // Refused rather than accepted-and-ignored: accept-and-ignore is a control
  // that appears to work, and the admin would find out only by reading a column
  // that never fills.
  if (measure_presence && _kindPol.measurePresence === "forbidden") {
    return res.status(400).json({ error: _presenceRefused({ event_kind: kind }), code: "measure_presence_forbidden" });
  }
  // Same rule for the tie-break basis, for the same reason: a presence tie-break
  // on a kind that may not measure presence would rank every score tie on a
  // column that can only ever hold zeros. Accepting it would be a setting that
  // appears to work.
  if (time_basis === "presence" && _kindPol.measurePresence === "forbidden") {
    return res.status(400).json({ error: _timeBasisRefused({ event_kind: kind }), code: "time_basis_forbidden" });
  }
  const measurePresence = measure_presence ? 1 : 0;
  // v8.12.0 — no per-kind seed and no policy question: the switch is a plain
  // DEFAULT 0 column, so the plain ternary is the right shape (the
  // `measure_presence` precedent one line up, not the `=== undefined` one below).
  const staffCompete = staff_compete ? 1 : 0;
  const selfEnrollEnabled = (self_enroll_enabled === undefined ? _kindPol.selfEnrollDefault : (self_enroll_enabled ? 1 : 0));
  // v7.11.7 — group leaderboard opt-in; default OFF when the create body omits it.
  const groupLbEnabled = group_leaderboard_enabled ? 1 : 0;
  // v7.13.0 — CxOne account-creation opt-out; default OFF (accounts ARE created).
  // v8.1.0 (PR 30) — that default is now the KIND's, per the note above.
  // A kind that never creates accounts (a Booth Event) refuses them ON, by name,
  // and stores them off whatever the default says (the gate asks the kind too).
  if (cxone_disabled === false && _kindPol.cxoneProvisioning !== "allowed") {
    return res.status(400).json({ error: _cxoneRefused({ event_kind: kind }), code: "cxone_provisioning_forbidden" });
  }
  const cxoneDisabled = _kindPol.cxoneProvisioning !== "allowed" ? 1
    : (cxone_disabled === undefined ? _kindPol.cxoneDisabledDefault : (cxone_disabled ? 1 : 0));
  // ── v8.4.0 — the sign-up matrix and the LinkedIn sign-up door ───────────────
  //
  // REFUSED for a kind that does not configure them, rather than stored and
  // ignored. Accept-and-ignore is the control that appears to work: an admin who
  // sent a matrix for a Competition would get a 201 and a sign-up form that
  // ignored every word of it, diagnosable from no screen. The refusal names the
  // kind through `eventKindPhrase`, so it reads as a sentence and cannot pair a
  // renamed label with the wrong article.
  //
  // Asked of CONFIGURABLE_KINDS, never of the value: `event_kind === "booth"` at
  // a consumer is the class lib/event-policy.js exists to prevent, and a second
  // configurable kind later is then a one-line change in one file.
  if (registration_fields !== undefined && !CONFIGURABLE_KINDS.has(kind)) {
    return res.status(400).json({ error: `The sign-up form cannot be customised for ${eventKindPhrase({ event_kind: kind })}.`, code: "registration_fields_forbidden" });
  }
  // LinkedIn sign-up no longer exists; a client still sending the old switch is
  // refused by name rather than silently ignored. ("Allow instant join" is
  // refused the same way, at the top of this handler.)
  if (req.body?.linkedin_signup_enabled !== undefined) {
    return res.status(400).json({ error: "LinkedIn sign-up was removed: accounts sign in with an emailed code or a password.", code: "linkedin_signup_removed" });
  }
  // The stored form is NULL whenever the states equal the kind's defaults, so an
  // admin who opens the form and saves without touching it stores nothing —
  // which keeps the defaults free to move in a later release instead of pinning
  // every event created today to today's values.
  const regFieldPolicy = registration_fields === undefined
    ? null
    : serialiseRegistrationFieldPolicy({ ...registrationFieldDefaultsForKind(kind), ...registration_fields }, registrationFieldDefaultsForKind(kind));
  // The legacy `linkedin_signup_enabled` column is unused; new rows take its
  // DEFAULT 0.
  // ── v8.6.0 — LATE ENTRIES ──────────────────────────────────────────────────
  //
  // REFUSED for a kind whose policy forbids the window, on the same reasoning as
  // the two refusals above: an admin who set a late-entry deadline on a
  // Competition would get a 201 and a window that never opens, which is
  // diagnosable from no screen. Asked of the POLICY, never of the value.
  if ((late_entry_enabled !== undefined || late_entry_deadline_at !== undefined) && _kindPol.lateEntry !== "allowed") {
    return res.status(400).json({ error: lateEntryForbiddenMessage({ event_kind: kind }), code: "late_entry_forbidden" });
  }
  // `=== undefined`, never `? 1 : 0`. The seed is ON for the one kind that may run
  // it, so the ternary would collapse "the caller said nothing" into "the caller
  // said no" and the default could never fire — the defect `cxone_disabled` shipped
  // with before v8.2.0 and `linkedin_signup_enabled` before v8.4.1, both on this
  // very form.
  const lateEntryEnabled = (late_entry_enabled === undefined
    ? (lateEntryDefaultForKind(kind) ? 1 : 0)
    : (late_entry_enabled ? 1 : 0));
  // A deadline BEFORE the event's own end is a window that closes before it opens,
  // and one absurdly far out makes an event that never really finishes. Both are
  // refused HERE rather than clamped, because a stored value an admin did not
  // choose is the thing this codebase keeps paying for. `null` (the caller cleared
  // it) and `undefined` (the caller said nothing) both mean "follow the end".
  // The scheduled end IS the effective end here: a row being created has no
  // stamped `ended_at` and no sessions yet, so `competitionEffectiveEnd` would
  // answer the same instant (the PUT is where the two can differ — v8.12.7).
  const _lateDeadlineErr = _validateLateDeadline(late_entry_deadline_at, scheduledEnd({ start_time: startDate.toISOString(), duration_minutes: dur }));
  if (_lateDeadlineErr) return res.status(400).json({ error: _lateDeadlineErr, code: "late_entry_deadline_invalid" });
  const lateEntryDeadlineIso = late_entry_deadline_at || null;
  // Enforce unique competition name (name is already validated + trimmed)
  const trimmedName = name;
  if (db.prepare("SELECT 1 FROM competitions WHERE LOWER(name)=LOWER(?)").get(trimmedName)) {
    return res.status(409).json({ error: "An event with this name already exists. Please choose a different name." });
  }
  // Event team reports — "Add the qualifying questions" (lib/qualifying.js).
  // Absent: the kind's seed (`qualifyingQuestionsDefault`, ON for booth). A
  // staff-compete event holds sealed challenges only and a qualifying question can
  // never be sealed, so the questions are refused there when asked for explicitly
  // and not seeded by default (lib/qualifying.js QUALIFYING_IN_COMPETE_EVENT_ERROR).
  const _addQRaw = req.body?.add_qualifying;
  if (_addQRaw !== undefined && typeof _addQRaw !== "boolean") return res.status(400).json({ error: "add_qualifying must be true or false.", code: "add_qualifying_invalid" });
  if (_addQRaw === true && staffCompete) return res.status(400).json({ error: require("../lib/qualifying").QUALIFYING_IN_COMPETE_EVENT_ERROR, code: "qualifying_in_compete_event" });
  const _addQualifying = !staffCompete && (_addQRaw === undefined ? !!eventPolicy(kind).qualifyingQuestionsDefault : _addQRaw);
  let _qualifyingIds = [];
  const id = uuid();
  const adminId = getAdminIdentity(req);
  const createTxn = db.transaction(() => {
    // v6.16.27 — stamp updated_at at creation so the PUT handler's
    // optimistic-concurrency check can compare against a populated
    // value on the very first edit.
    const _createdNow = now().toISOString();
    // v6.21.0 — mint the self-enrollment token at creation so the link is
    // immediately revealable (it stays inert unless self_enroll_enabled is on —
    // default 0 when the create body omits it; F3 lets the create body opt in).
    // The DB migration back-fills pre-existing comps; this covers every new comp.
    // v7.29.0 — event_kind is bound EXPLICITLY, and this is the sharpest edge in
    // the whole redesign. The column defaults to 'tournament', so an INSERT that
    // omitted it would answer 201 while the row silently became a Competition:
    // the admin picks a Booth Event, fills the form, gets a success, and has an
    // event with sessions available, a ranked leaderboard and auto-end live.
    // Nothing errors. And because the kind is immutable after create, that state
    // would be uncorrectable without deleting the row.
    // v8.1.0 (PR 16) — `deadline_at` and `auto_end_on_all_solved` are bound
    // EXPLICITLY, for the same reason event_kind is. auto_end defaults to 1 in the
    // column, and for a Program that default is not merely wrong, it is
    // self-destructive: one enrollee who finishes would auto-end an event built
    // for rolling enrolment a decade early, closing it to everyone after them,
    // freezing every challenge it shares — and leaving it STUCK closed, because
    // the extend-the-deadline revive re-checks all-solved and refuses while it
    // still holds. The value comes from the kind's policy, never from a literal.
    // v8.1.0 — `attempt_cap` is bound EXPLICITLY, like `event_kind` before it. The
    // column is nullable with no default, so an omitted bind would answer 201 with
    // the event silently uncapped — an exam whose whole point is the ceiling,
    // shipped without one, with nothing erroring.
    db.prepare("INSERT INTO competitions (id, name, event_kind, start_time, duration_minutes, deadline_at, auto_end_on_all_solved, leaderboard_mode, reveal_answers_on_end, self_enroll_enabled, measure_presence, time_basis, group_leaderboard_enabled, cxone_disabled, attempt_cap, trusted_network_ips, registration_field_policy, late_entry_enabled, late_entry_deadline_at, staff_compete, self_enroll_token, join_code, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, trimmedName, kind, startDate.toISOString(), dur, deadlineIso, _autoEndDefault, lbMode, revealOnEnd, selfEnrollEnabled, measurePresence, (time_basis || "elapsed"), groupLbEnabled, cxoneDisabled, (attempt_cap ?? null), trustedIps, regFieldPolicy, lateEntryEnabled, lateEntryDeadlineIso, staffCompete, _genSelfEnrollToken(), _genJoinCode(), _createdNow, _createdNow);
    // Apply initial tags if provided (e.g. the dry-run tag).
    // v7.7.5 (ext-audit F6) — enforce the same ≤50-char cap as POST .../tags so the
    // create path can't seed oversized tags that the dedicated route would reject.
    if (Array.isArray(reqTags) && reqTags.length) {
      const ins = db.prepare("INSERT OR IGNORE INTO competition_tags (competition_id, tag) VALUES (?,?)");
      for (const t of reqTags) { if (t && typeof t === "string" && t.trim() && t.trim().length <= 50) ins.run(id, t.trim().toLowerCase()); }
    }
    const appliedTags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(id).map(r => r.tag);
    if (_addQualifying) {
      _qualifyingIds = require("../lib/qualifying").seedQualifyingChallenges(db, id, { actorEmail: adminId, actorUserId: actorId(req), nowIso: _createdNow });
    }
    // v7.29.0 — self_enroll_enabled was absent here while it is recorded on the
    // `edited` side, so a competition BORN with a live join link left no trace of
    // where that came from — only a later change was auditable. Found by the
    // export drift guard, which forced every column to be a decision.
    // v8.1.0 (PR 13) — `event_kind` is recorded as the STORED VALUE, never the
    // label. Audit details are retained for EVENT_RETENTION_DAYS (730) and a label
    // is renameable, so writing "Competition" here would freeze a display string
    // into two years of forensic rows. History maps it to the label at render time.
    recordCompetitionEvent(id, "created", adminId, { name: trimmedName, event_kind: kind, start_time: startDate.toISOString(), duration_minutes: dur, deadline_at: deadlineIso, auto_end_on_all_solved: _autoEndDefault, leaderboard_mode: lbMode, reveal_answers_on_end: !!revealOnEnd, group_leaderboard_enabled: !!groupLbEnabled, cxone_disabled: !!cxoneDisabled, self_enroll_enabled: !!selfEnrollEnabled, measure_presence: !!measurePresence, time_basis: (time_basis || "elapsed"), attempt_cap: (attempt_cap ?? null), tags: appliedTags, ...reqContext(req) , trusted_network_ips: trustedIps || null, registration_fields: { ...registrationFieldStates({ event_kind: kind, registration_field_policy: regFieldPolicy }) }, late_entry_enabled: !!lateEntryEnabled, late_entry_deadline_at: lateEntryDeadlineIso, staff_compete: !!staffCompete, ...(_qualifyingIds.length ? { qualifying_questions: _qualifyingIds.length } : {})});
  });
  runTxnWithMirrorBuffer(() => createTxn());
  // The built-in qualifying challenges get their creation version (History,
  // Restore) like any challenge created through the editor.
  for (const _qid of _qualifyingIds) {
    try { require("../lib/audit").createTaskVersion(_qid, adminId, "create", null, { via: "qualifying_default", competition_id: id, ...reqContext(req) }); }
    catch (e) { swallowed("competitions:qualifying-version", e); }
  }
  // v7.21.7 — v7.16.0's invariant ("every write to the column must call
  // invalidateCompAllowlist()") applied to the path it originally missed. The
  // allowlist is read from an in-process cache built by the FIRST http request
  // the process handles, so a competition BORN with trusted IPs was never in it:
  // the venue address an admin typed on the New Competition form was inert, on
  // the path most likely to be used (setting the event up in advance). It failed
  // CLOSED — the limiter stayed on — but the feature simply did not work, and
  // the ban alert then computed `already_trusted` from the same stale cache and
  // sent the admin round the loop the flag exists to prevent. AFTER the commit:
  // releasing a block for a competition whose INSERT rolled back would be wrong.
  if (trustedIps) {
    invalidateCompAllowlist();
    const _released = clearScannerBlocksFor(trustedIps);
    // `created` already records trusted_network_ips (v7.16.4), so a second event
    // for the value would be noise — but a block RELEASE is a distinct fact.
    if (_released > 0) {
      try {
        recordCompetitionEvent(id, "trusted_networks_applied", adminId, {
          to: trustedIps, blocks_released: _released, grace_ms: TRUSTED_IP_GRACE_MS, ...reqContext(req),
        });
      } catch (e) { swallowed("competitions:create-trusted-networks-audit", e); }
    }
  }
  const comp = getCompetition(id);
  const tags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(id).map(r => r.tag);
  res.json({ ok: true, competition: { ..._compWire(comp, { isSuperAdmin: !!req.session.isSuperAdmin, actorId: competitorIds(req) }), tags, status: competitionStatus(comp), effective_end: competitionEffectiveEnd(comp)?.toISOString() || null } });
});

app.put("/api/admin/competitions/:id", requireAdmin, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — A COMPETITOR MAY NOT EDIT THE EVENT THEY COMPETE IN, whatever
  // their tier. Asked ABOVE the event-admin scope gate, as the answer seal is
  // above the tier gates on the task routes: a superadmin must hear THIS reason,
  // not a scope answer that does not bind them. `_competitorRefused` is the one
  // responder every mutating competition door in this file uses.
  const _cmp = _competitorRefused(req, res, comp.id);
  if (_cmp) return _cmp;
  // v8.7.0 — above the concurrency check and every write below it.
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  // v8.1.0 (PR 18/20) — resolved ONCE, here, because several refusals below read
  // it and the first of them (trusted networks) sits well above where this used
  // to be declared. A `const` used before its declaration is a TDZ
  // ReferenceError that `node --check` cannot see. Deliberately not counted in
  // prose: a number here rots the next time a refusal is added.
  //
  // v8.1.1 — and it sits BELOW the 404 guard, not above it. That hoist overshot:
  // getCompetition returns null for an unknown id and eventKind THROWS on null,
  // so a mistyped id — or an admin saving a form after a colleague deleted the
  // row — got a generic 500 and an error-level stack instead of the actionable
  // 404 this route documents. Every refusal that reads _polPut runs after the
  // guard, so there is nothing to gain by resolving it earlier.
  //
  // v8.3.0 — and it is resolved from the TARGET kind, so it moved BELOW the
  // body validation (see `_polPut` there). With the kind mutable while upcoming,
  // every refusal that reads this policy has to be asked about the event the
  // save is about to produce, not the one on disk: validating a Program's
  // reveal-answers flag against the Competition it used to be would let the
  // forbidden state in through the very request that creates it.
  // v6.16.27 — optimistic-concurrency / If-Match check. The client
  // echoes the `updated_at` value from its last GET; if the row has
  // moved since (another admin edit committed), we 409 the second
  // writer instead of letting last-writer-wins silently overwrite.
  // Optional: when the field is omitted (legacy / scripted callers),
  // we fall through with no check — back-compat preserves automated
  // tooling. Modern admin UI should always supply it.
  if (req.body.expectedUpdatedAt && comp.updated_at && req.body.expectedUpdatedAt !== comp.updated_at) {
    return res.status(409).json({
      error: "This event was modified by another admin since you opened it. Reload to see the latest values, then retry.",
      conflict: true,
      currentUpdatedAt: comp.updated_at,
    });
  }
  // batch 7 — boundary validation replaces the hand-rolled type/non-empty/cap/
  // range/date checks (batches 3-6). Edit = the SAME create schema with every
  // field optional (allOptional), so create/edit can't drift (the parity class).
  // `name` is trimmed, `start_time` is normalized ISO, `duration_minutes` is an
  // int [1,525600]; absent fields are omitted (COALESCE leaves the column as-is).
  _normaliseCapInput(req.body);
  // Whether the caller ASKED to clear the cap, as distinct from saying nothing.
  // validateBody folds null into "absent", so the clear signal has to be read off
  // the raw body — the same reason `trusted_network_ips` is written by its own
  // statement below: COALESCE(?,col) cannot express "set to NULL", and removing a
  // cap is a first-class action, not an edge case.
  const _capCleared = Object.prototype.hasOwnProperty.call(req.body || {}, "attempt_cap") && req.body.attempt_cap === null;
  // v8.1.0 (PR 30) — "the admin cleared the box" is a DIFFERENT fact from "the
  // caller said nothing", and only an explicit null can express the first. The
  // COALESCE SET clause below cannot: a NULL there means unchanged, so without
  // this an admin removing the ceiling would silently keep it (a control that
  // appears to work). Mirrors _capCleared exactly.
  const _v = validateBody(req.body, allOptional(COMPETITION_FIELD_SCHEMA));
  if (_v.error) return res.status(400).json({ error: _v.error });
  // ── v8.3.0 — THE KIND IS CHANGEABLE, BUT ONLY BEFORE THE EVENT STARTS. ──
  //
  // v7.29.0 made it immutable and gave three reasons, each of which the
  // "upcoming" precondition answers: a change toward a ranked kind would have to
  // reckon with a board that was never computed (an upcoming event has no board,
  // no submissions and no minted certificates), a change to `program` would have
  // to invent a deadline (the caller supplies one, validated below by the same
  // `resolveSchedule` create uses), and a change away from a session-bearing kind
  // would have to refuse while slots exist — which is exactly what
  // `eventKindChangeLock` does.
  //
  // ONE predicate, in lib/competitions.js, shared with the `event_kind_locked`
  // flag `_compWire` puts on every competition response. The admin form renders
  // the control from that flag, so it is never offered where this would refuse
  // it (the v8.1.0 `can_leave` rule).
  //
  // A caller echoing the SAME kind back is not a change and is allowed, so a
  // client that round-trips the whole row is not broken by this — unchanged
  // behaviour from v7.29.0, and the reason the gate tests `!== comp.event_kind`
  // rather than merely `!== undefined`.
  // v8.8.25 — the PROSPECTIVE slot set. `delete_timeslot_ids` is the client's
  // declaration of the deletes it is about to commit, so every slot-derived
  // predicate below (`eventKindChangeLock`, the multi-session trusted-network
  // refusal, `startTimeChangeLock`, the ended-event refusals, the leaderboard
  // and time-basis locks) is asked about the world this save produces.
  //
  // It is ADVISORY, not authoritative: on a real save the deletes have already
  // committed, so `getCompetitionTimeslots` returns the post-delete set and this
  // filter removes nothing. It changes an answer only on the dry run, which is
  // where the seam is. An id naming a slot that does not exist is ignored
  // rather than refused — the caller is describing an intention, and refusing
  // would turn a colleague's concurrent delete into a save failure.
  const _pendingDeletes = new Set(_v.values.delete_timeslot_ids || []);
  const _slotsPut = getCompetitionTimeslots(comp.id).filter(s => !_pendingDeletes.has(String(s.id)));
  const _kindChanging = _v.values.event_kind !== undefined && _v.values.event_kind !== comp.event_kind;
  if (_kindChanging) {
    const _lock = eventKindChangeLock(comp, _slotsPut);
    if (_lock) return res.status(400).json({ error: _lock.message, code: _lock.code });
  }
  // The kind this request is about to produce. Everything downstream is asked
  // about THIS, never about `comp.event_kind`.
  const _targetKind = _kindChanging ? _v.values.event_kind : comp.event_kind;
  const _targetComp = _kindChanging ? { ...comp, event_kind: _targetKind } : comp;
  const _polPut = eventPolicy(_targetComp);
  // Challenges already assigned must fit the kind the event is BECOMING. This is
  // `lib/challenge-fit.js`'s own doctrine applied to the other side of the pair:
  // it guards six challenge-side mutation paths so that "no Booth Event holds a
  // challenge nobody at it can answer" holds by construction, and the event-side
  // kind change is a seventh door into the same forbidden state. Its comment
  // claims the rule holds "by construction"; without this it would not.
  if (_kindChanging && eventConstrainsChallenges(_targetComp)) {
    const _assigned = db.prepare(
      `SELECT t.id, t.title, t.answer_type FROM competition_tasks ct
         JOIN tasks t ON t.id = ct.task_id
        WHERE ct.competition_id = ?`
    ).all(comp.id);
    for (const _t of _assigned) {
      const _tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(_t.id).map(r => r.tag);
      const _fit = challengeFitError(_t, _targetComp, _tags);
      if (_fit) {
        return res.status(400).json({
          error: `This event cannot become ${eventKindPhrase(_targetComp)} yet — ${_fit.message}`,
          code: "event_kind_challenge_unfit",
        });
      }
    }
  }
  // F2 — the three security-sensitive flags come from _v.values as REAL booleans
  // (or undefined when absent), so the string "false" can no longer enable them.
  const { name, start_time, duration_minutes, deadline_at, reveal_answers_on_end, self_enroll_enabled, measure_presence, time_basis, group_leaderboard_enabled, cxone_disabled, trusted_network_ips, attempt_cap: _capNew, registration_fields, late_entry_enabled, late_entry_deadline_at, staff_compete } = _v.values;
  const { leaderboard_mode } = req.body;
  // v7.16.0 — trusted networks are a SINGLE-SESSION-only setting. A multi-session
  // competition spans days and cohorts, so "the venue's IP" is not a property of
  // it; and the window arithmetic in lib/comp-allowlist deliberately does no
  // timeslot resolution. Refuse rather than silently ignore, so an admin who
  // tries is told why.
  let trustedIpsCol = null;              // null = leave the column unchanged
  let trustedIpsChanged = false;
  // v8.3.0 — set when a KIND CHANGE clears the column rather than the caller.
  // The write and the audit below are both gated on `trusted_network_ips !==
  // undefined`, i.e. on the CALLER having said something, so a forced clear
  // needs its own signal or it would be computed and then silently dropped.
  let trustedIpsForcedClear = false;
  if (trusted_network_ips !== undefined) {
    // v8.1.0 (PR 20) — ONE RULE, asked of the policy. The eligibility test used to
    // be "does it have sessions?", written out here; it is now
    // eventPolicy(row).trustedNetworks, so the three kinds cannot drift apart and
    // a new kind declares its answer in one table rather than being missed here.
    //
    // A Program is "never", explicitly. It has no sessions, so it would SATISFY
    // the old single-session test — and a decade-long rate-limit bypass is exactly
    // what the time-bounding exists to prevent.
    const _tn = _polPut.trustedNetworks;
    if (_tn === "never") {
      return res.status(400).json({
        error: "This event type cannot carry trusted network IPs. The bypass is time-bounded to a running event, and this kind runs for as long as its deadline allows.",
        code: "trusted_networks_forbidden",
      });
    }
    if (_tn === "if-single-session") {
      // v8.8.25 — the PROSPECTIVE count. This read its own COUNT(*) rather than
      // `_slotsPut`, so the pre-flight's declared deletes did not reach it and a
      // multi->single switch was refused for sessions the same save was about to
      // remove. On a real save `_slotsPut` IS the live set (the deletes have
      // already committed and the filter removes nothing), so this changes no
      // committed behaviour — only the dry run's answer, which is the point.
      const slotCount = _slotsPut.length;
      if (slotCount > 0) {
        return res.status(400).json({
          error: "Trusted network IPs can only be set on a single-session event. This event has sessions; remove them first, or run the venue's cohort as a single session.",
          code: "trusted_networks_multi_session",
        });
      }
    }
    const _tip = validateTrustedIps(trusted_network_ips);
    if (_tip.error) return res.status(400).json({ error: _tip.error });
    // Distinguish "clear it" from "leave it": COALESCE cannot express NULL, so
    // an explicit empty value is written with a separate statement below.
    trustedIpsChanged = (_tip.value || null) !== (comp.trusted_network_ips || null);
    trustedIpsCol = _tip.value;          // may be null, meaning cleared
  }
  const oldStatus = competitionStatus(comp);

  // v7.7.26 (audit H1) — an UNCHANGED start_time passes: echoing back the
  // stored value changes nothing, and rejecting it made clients that thread
  // the whole form (or the derived multi-mode aggregate) unable to save ANY
  // field on a live comp. Compare normalized — validateBody already
  // normalized the incoming value to ISO; older stored rows may differ in
  // formatting, so normalize the stored side before comparing.
  const _storedStartIso = (() => {
    const d = new Date(comp.start_time);
    return isNaN(d) ? comp.start_time : d.toISOString();
  })();
  const _startChanged = start_time != null && start_time !== _storedStartIso;
  // v8.3.10 — the start is no longer flatly immutable once started. A SUPERADMIN
  // may correct a LIVE event nobody has touched; `startTimeChangeLock` is the one
  // predicate that decides, and `_compWire` publishes its reason as
  // `start_time_locked`, so the form never offers the control where this refuses.
  //
  // 403 for the tier refusal and 400 for the rest, matching the ended-competition
  // pair immediately below: a tier answer is about WHO is asking, the others are
  // about the request.
  if (_startChanged) {
    const _sLock = startTimeChangeLock(comp, { isSuperAdmin: !!req.session.isSuperAdmin });
    if (_sLock) {
      return res.status(_sLock.reason === "requires_superadmin" ? 403 : 400)
        .json({ error: _sLock.message, code: _sLock.code });
    }
  }
  // Ended competitions: restrict edits based on whether end time is in the past
  if (oldStatus === "ended") {
    const effEnd = competitionEffectiveEnd(comp);
    if (effEnd && effEnd <= now() && !req.session.isSuperAdmin) {
      return res.status(403).json({ error: "Only superadmin can edit ended events whose end time has passed" });
    }
    if (name != null && name !== comp.name)
      return res.status(400).json({ error: "Cannot change the name of an ended event" });
  }
  // Validate leaderboard_mode changes (lock once any slot has started)
  if (leaderboard_mode && leaderboard_mode !== comp.leaderboard_mode) {
    if (!["global", "per_slot"].includes(leaderboard_mode))
      return res.status(400).json({ error: "leaderboard_mode must be 'global' or 'per_slot'" });
    if (competitionAnySlotStarted(comp))
      return res.status(400).json({ error: "Cannot change leaderboard mode after a session has started" });
  }
  // v8.1.0 — THE TWO PRESENCE SETTINGS, and all four of their gates together,
  // because which refusal an admin meets depends on the order they are asked in.
  //
  // BOTH are compared against the STORED value first, and that is load-bearing
  // rather than tidy: the edit form renders both controls for every kind and
  // posts them on every save, so a client that round-trips the whole row has to
  // be able to echo back what is already there. Refusing an unchanged value
  // would make a Booth Event unsaveable — the same argument as the immutable
  // `event_kind` above.
  const _presenceChanged = measure_presence !== undefined
    && (measure_presence ? 1 : 0) !== (comp.measure_presence ? 1 : 0);
  const _timeBasisChanged = time_basis !== undefined
    && time_basis !== (comp.time_basis || "elapsed");
  // THE SAME POLICY REFUSAL AS CREATE, asked of the STORED kind. Guarding only
  // the create side would let an admin reach by EDITING a state the platform
  // refuses at CREATE — the reorder hole the reveal/group refusals below already
  // close, one field over — and nothing downstream re-checks the kind: the
  // presence writer keys on the column alone.
  if (_presenceChanged && measure_presence && _polPut.measurePresence === "forbidden") {
    return res.status(400).json({ error: _presenceRefused(comp), code: "measure_presence_forbidden" });
  }
  // Checkmarx One accounts ON for a kind that never creates them, against the
  // kind this save produces. An explicit `false` only: the form sends nothing
  // for such a kind (it shows no section), and `true` is what is stored.
  if (cxone_disabled === false && _polPut.cxoneProvisioning !== "allowed") {
    return res.status(400).json({ error: _cxoneRefused(_targetComp), code: "cxone_provisioning_forbidden" });
  }
  if (_timeBasisChanged && time_basis === "presence" && _polPut.measurePresence === "forbidden") {
    return res.status(400).json({ error: _timeBasisRefused(comp), code: "time_basis_forbidden" });
  }
  if (_timeBasisChanged) {
    // THE ENDED CASE IS ASKED FIRST, because ended implies started and the
    // started-lock below would otherwise answer for it with the wrong reason.
    //
    // `_usePresenceRanking` is read LIVE on every board build and the individual
    // board has no end snapshot, so flipping the basis after the fact silently
    // re-orders every score-tied FINISHER pair on the participant board, the
    // admin Rankings tab and the rankings CSV — while the placement badges
    // already minted keep asserting the old order. A certificate that has left
    // the building has no remedy, so this is refused rather than warned about.
    if (competitionFullyEnded(comp)) {
      return res.status(400).json({
        error: "The tie-break basis cannot be changed once the event has ended — the standings are final, and any certificates already issued assert that order.",
        code: "time_basis_locked_ended",
      });
    }
    // Parity with the leaderboard_mode lock directly above, and for the same
    // reason: it is the same kind of thing — a ranking-SHAPE setting — so it
    // locks at the same moment, or the board re-orders under participants
    // mid-event. Re-checked inside the write transaction below, because the
    // status is TIME-derived and can cross the start boundary under us.
    if (competitionAnySlotStarted(comp)) {
      return res.status(400).json({
        error: "Cannot change the tie-break basis after the event has started — the ranking would change under participants mid-event.",
        code: "time_basis_locked",
      });
    }
  }
  // measure_presence stays freely editable while the event is upcoming OR LIVE —
  // it governs only whether counting happens from here on, and an organiser who
  // decides mid-event to start (or stop) measuring is making an honest choice
  // about the future. Once the standings are final there is nothing left to
  // count, and flipping it would only change what the recorded buckets appear to
  // mean. No in-transaction re-check: unlike the basis lock this cannot re-order
  // anything, so the sub-millisecond window between the check and the write is
  // not worth a second read.
  if (_presenceChanged && competitionFullyEnded(comp)) {
    return res.status(400).json({
      error: "Recording time on platform cannot be changed once the event has ended — there is nothing left to record, and the buckets already counted stay as they are.",
      code: "measure_presence_locked_ended",
    });
  }
  // ── v8.12.0 — THE STAFF-COMPETE SWITCH ───────────────────────────────────────
  //
  // Compared against the STORED value, so an echo is never a change (the
  // `_presenceChanged` shape above). Four refusals, all ABOVE the `validate_only`
  // return so the client's dry run meets every one of them:
  //
  //  • the LOCK — ended first, then started, with an in-transaction re-check
  //    (`_staffCompeteLockRace`) because the status is time-derived and can cross
  //    the start boundary under us: it is a ranking-SHAPE setting, exactly like
  //    `leaderboard_mode` and `time_basis`, and flipping it mid-event adds people
  //    to or removes them from the board and the all-solved denominator;
  //  • turning it ON while UNSEALED challenges are assigned — the switch is the
  //    second door into the "compete event holding an unsealed challenge" state
  //    (assignment is the first), and the kind-change re-check at the top of this
  //    handler is the precedent: refuse, and NAME them;
  //  • turning it ON while an ENROLLED row-holder AUTHORED an assigned challenge
  //    (`staff_compete_enrolled_authors`) — the moment the switch lands they
  //    compete against their own key, which every other door refuses; refused,
  //    naming each person and the challenges they wrote;
  //  • turning it OFF while staff-TAGGED users are enrolled — rows written while
  //    the switch was on, before this release existed, or by a promotion after
  //    enrolment (the role route adds the tag and deletes no rows); whichever
  //    way, turning it off would leave rows that stop scoring the moment the
  //    save lands. Refused, naming them, so the operator removes the
  //    competitors deliberately first.
  const _staffCompeteChanged = staff_compete !== undefined
    && (staff_compete ? 1 : 0) !== (comp.staff_compete ? 1 : 0);
  if (_staffCompeteChanged) {
    const _lock = staffCompeteSwitchLock({ fullyEnded: competitionFullyEnded(comp), anySlotStarted: competitionAnySlotStarted(comp) });
    if (_lock) return res.status(400).json({ error: _lock.message, code: _lock.code });
    if (staff_compete) {
      const _unsealed = staffCompeteUnsealedAssigned(db, comp.id);
      if (_unsealed.length) {
        return res.status(400).json({
          error: `“${comp.name}” holds ${_unsealed.length === 1 ? "a challenge whose answer is not sealed" : `${_unsealed.length} challenges whose answers are not sealed`}, and an event where staff compete only admits sealed ones. Take ${_unsealed.length === 1 ? "it" : "them"} out of the event first, or leave the switch off.`,
          code: STAFF_COMPETE_CODES.UNSEALED_ASSIGNED,
          challenges: _unsealed,
        });
      }
      // The author door, from the switch's side: an enrolled row-holder who
      // wrote one of the assigned challenges would compete against their own
      // key the moment this lands. Named, with the challenges, so the operator
      // removes the person or the challenge deliberately.
      const _authors = staffCompeteEnrolledAuthors(db, comp.id);
      if (_authors.length) {
        return res.status(400).json({
          error: `${_authors.length === 1 ? `${_authors[0].nickname} is enrolled in “${comp.name}” and wrote` : `${_authors.length} people enrolled in “${comp.name}” wrote`} ${_authors.length === 1 && _authors[0].tasks.length === 1 ? "a challenge it holds" : "challenges it holds"}, so they cannot compete in it — a challenge's answer is known to its author. Remove ${_authors.length === 1 ? "that person" : "them"} from the event or take ${_authors.length === 1 && _authors[0].tasks.length === 1 ? "the challenge" : "their challenges"} out first, or leave the switch off.`,
          code: STAFF_COMPETE_CODES.AUTHOR_ENROLLED,
          participants: _authors,
        });
      }
    } else {
      const _staff = staffCompeteEnrolled(db, comp.id);
      if (_staff.length) {
        return res.status(400).json({
          error: `${_staff.length === 1 ? "A staff member is" : `${_staff.length} staff members are`} enrolled in “${comp.name}” as ${_staff.length === 1 ? "a competitor" : "competitors"}. Remove ${_staff.length === 1 ? "that person" : "them"} from the event first, or leave staff competing.`,
          code: STAFF_COMPETE_CODES.STAFF_ENROLLED,
          participants: _staff,
        });
      }
    }
  }
  // v6.16.0 — reveal_answers_on_end is editable any time (including
  // after the comp ends). Toggling it post-end has the immediate
  // effect of revealing or hiding the correct answers + explanations
  // on /api/tasks/:id, which is intentional — a superadmin can flip
  // it to publish solutions after the run if they decide to.
  // F2 — reveal_answers_on_end is a REAL boolean from validateBody (the string
  // "false" was coerced to false, not left truthy). `undefined` = no change.
  let revealOnEndCol = null;
  if (reveal_answers_on_end !== undefined) {
    revealOnEndCol = reveal_answers_on_end ? 1 : 0;
  }
  // v6.21.0 — the self-enrollment toggle. Editable any time (including after the
  // comp ends, which simply makes a stale link 404 anyway). Same 0/1 coercion
  // as revealOnEndCol; `undefined` = no change. Admin-level (this PUT is
  // requireAdmin) — it does not expose the secret token.
  let selfEnrollEnabledCol = null;
  if (self_enroll_enabled !== undefined) selfEnrollEnabledCol = self_enroll_enabled ? 1 : 0;
  // v7.11.7 — group leaderboard opt-in. Editable any time; `undefined` = no change.
  let groupLbEnabledCol = null;
  if (group_leaderboard_enabled !== undefined) groupLbEnabledCol = group_leaderboard_enabled ? 1 : 0;
  // v8.1.0 (PR 34) — editable any time; `undefined` = no change. Turning it ON
  // starts counting from the next active request; turning it OFF stops counting
  // and leaves what was already recorded, which is the honest behaviour — the
  // buckets happened.
  let measurePresenceCol = null;
  if (measure_presence !== undefined) measurePresenceCol = measure_presence ? 1 : 0;
  let timeBasisCol = (time_basis === undefined) ? null : time_basis;   // v8.3.0 — `let`: a kind change can force it to "elapsed"
  // ── v8.4.0 — the sign-up matrix and the LinkedIn sign-up door ───────────────
  //
  // `null` is the no-change sentinel, exactly as it is for every flag above —
  // but this column is nullable and NULL is also a MEANINGFUL stored value ("not
  // configured, use the kind's defaults"), so it cannot ride the COALESCE
  // statement: `COALESCE(NULL, col)` would make "reset this event to the
  // defaults" unexpressible. It gets its own conditional statement inside the
  // same transaction, the shape `trusted_network_ips` and `deadline_at` already
  // use for the same reason.
  //
  // `_regFieldsChanged` keys the write, so an unchanged save writes nothing; the
  // audit also needs a field whose resolved state moved, so a save that only
  // rewrites the stored shape (the retired `password` key dropped) is written but
  // not recorded (sweep #331).
  let regFieldsCol = null;
  let _regFieldsChanged = false;
  // `let`: a kind change away from booth forces it to NULL.
  let _regFieldsForcedClear = false;
  // v7.13.0 — CxOne account-creation opt-out. Editable any time; `undefined` = no change.
  let cxoneDisabledCol = null;
  if (cxone_disabled !== undefined) cxoneDisabledCol = cxone_disabled ? 1 : 0;
  // v8.12.0 — the staff-compete switch. NOT NULL column, so `null` is unambiguously "no change".
  let staffCompeteCol = null;
  if (staff_compete !== undefined) staffCompeteCol = staff_compete ? 1 : 0;
  // v8.6.0 — late entries. `null` means "no change" for the toggle, as above.
  //
  // The DEADLINE needs a third state that a `null`-means-no-change holder cannot
  // express, because `null` is also its "go back to following the end" value — so
  // the write is driven off `late_entry_deadline_at !== undefined` directly and
  // the column is written by its OWN statement rather than a COALESCE. Same shape
  // and same reason as `deadline_at` and `trusted_network_ips`: COALESCE cannot
  // say "set this to NULL".
  let lateEntryEnabledCol = null;
  if (late_entry_enabled !== undefined) lateEntryEnabledCol = late_entry_enabled ? 1 : 0;
  let lateEntryDeadlineCol = late_entry_deadline_at;   // ISO | null | undefined
  // `let`: a kind change away from a late-entry kind forces the deadline to NULL,
  // and `undefined` (no change) cannot express that on its own.
  let _lateEntryForcedReset = false;

  // Enforce unique name if changing (name is validated + trimmed by validateBody)
  if (name != null && name.toLowerCase() !== comp.name.toLowerCase()) {
    if (db.prepare("SELECT 1 FROM competitions WHERE LOWER(name)=LOWER(?) AND id!=?").get(name, comp.id)) {
      return res.status(409).json({ error: "An event with this name already exists." });
    }
  }

  // Apply the update (name trimmed, start_time normalized ISO, duration int — all
  // from validateBody, so no re-trim/re-parse/re-normalize here).
  const adminId = getAdminIdentity(req);
  // v8.1.0 (PR 16) — the deadline-shaped PUT. Extending is the common operation,
  // and the `duration_minutes ↔ deadline_at` pair has to stay in step through it.
  // v8.1.1 — this used to read "the derived duration MUST come from the STORED
  // start", which held only for a STARTED event and was wrong for the whole
  // upcoming window; the block below derives from the start the request is
  // actually writing, and says why.
  // v8.1.0 (PR 18) — the same two refusals on edit, against the STORED kind. The
  // create-side check alone would let an admin reach the forbidden state by
  // reordering, which is the v7.29.0 sessions lesson one field over.
  if (reveal_answers_on_end && _polPut.revealAnswers === "forbidden") {
    return res.status(400).json({ error: _REVEAL_REFUSED, code: "reveal_answers_forbidden" });
  }
  if (group_leaderboard_enabled && _polPut.groupLeaderboard === "forbidden") {
    return res.status(400).json({ error: _GROUP_BOARD_REFUSED, code: "group_leaderboard_forbidden" });
  }
  // v8.4.0 — the PUT mirror of the create-side refusal, and it is required for
  // the same reason the two above it are: without it an admin reaches the
  // forbidden state by REORDERING — create a Booth Event, configure its sign-up
  // form, change the kind to Competition, and the matrix would still be sitting
  // in the column. (The kind-change reset below closes the other half: a value
  // already stored that the target kind forbids.)
  //
  // `_targetKind` rather than the stored one, so the refusal is about the event
  // this request is trying to create.
  if (registration_fields !== undefined && !CONFIGURABLE_KINDS.has(_targetKind)) {
    return res.status(400).json({ error: `The sign-up form cannot be customised for ${eventKindPhrase({ event_kind: _targetKind })}.`, code: "registration_fields_forbidden" });
  }
  if (req.body?.linkedin_signup_enabled !== undefined) {
    return res.status(400).json({ error: "LinkedIn sign-up was removed: accounts sign in with an emailed code or a password.", code: "linkedin_signup_removed" });
  }
  if (req.body?.self_enroll_allow_instant !== undefined) return res.status(400).json(_SELF_ENROLL_INSTANT_REMOVED);
  // v8.6.0 — the PUT mirror of the create-side late-entry refusal, against
  // `_targetKind` for the reason the two above give: without it an admin reaches
  // the forbidden state by REORDERING (create a Booth Event with a late window,
  // then change the kind), and the kind-change reset below closes the other half.
  if ((late_entry_enabled !== undefined || late_entry_deadline_at !== undefined)
      && eventPolicy({ event_kind: _targetKind }).lateEntry !== "allowed") {
    return res.status(400).json({ error: lateEntryForbiddenMessage({ event_kind: _targetKind }), code: "late_entry_forbidden" });
  }
  // v8.12.6 — THE LATE-ENTRY SWITCH LOCKS ONCE THE EVENT HAS ENDED, in BOTH
  // directions (`lateEntrySwitchLock`, lib/competitions.js, is the one predicate —
  // the list and `_compWire` publish it as `late_entry_locked`). Compared against
  // the STORED value, so an echo from a form that round-trips the whole row is
  // never a change (the `_presenceChanged` shape above). Asked BELOW the kind
  // refusal, so a kind that runs no window hears why it has none rather than
  // this, and ABOVE the `validate_only` return like every other lock, so the
  // dry run meets it. No in-transaction re-check: like `measure_presence`, the
  // "ended" boundary is crossed only by time moving forward, and a change that
  // lands in the sub-millisecond before it is a change made while the event ran.
  if (lateEntryEnabledCol !== null && lateEntryEnabledCol !== (comp.late_entry_enabled ? 1 : 0)) {
    const _leLock = lateEntrySwitchLock(comp);
    if (_leLock) return res.status(400).json({ error: _leLock.message, code: _leLock.code });
  }
  // Resolve the caller's partial map against what this event ALREADY resolves to,
  // never against the kind's bare defaults. A form that renders only some of the
  // controls must be able to leave the rest alone, and merging over the current
  // states is what makes a partial send mean "change these" rather than "reset
  // everything I did not mention".
  //
  // Read from `_targetComp` — the row as this request will leave it — so a save
  // that changes the kind AND the matrix in one go resolves against the right
  // defaults rather than the outgoing kind's.
  if (registration_fields !== undefined) {
    const _regDefaults = registrationFieldDefaultsForKind(_targetKind);
    const _regCurrent = registrationFieldStates(_targetComp);
    regFieldsCol = serialiseRegistrationFieldPolicy({ ..._regCurrent, ...registration_fields }, _regDefaults);
    _regFieldsChanged = regFieldsCol !== (comp.registration_field_policy || null);
  }
  // ── v8.3.0 — A KIND CHANGE RESETS WHAT THE NEW KIND FORBIDS. ──
  //
  // The refusals above cover a request that ASKS for a forbidden value. This
  // covers the other half: a value already STORED that the new kind forbids and
  // the request says nothing about. Every column here is COALESCEd, so silence
  // means "keep it" — and the edit form does not render these controls for a kind
  // that forbids them, so the admin could not clear them even if they wanted to.
  // Refusing would therefore dead-end them on settings they cannot see; leaving
  // them would ship a Program with a group leaderboard.
  //
  // So each is FORCED to the value the target policy permits, and every forced
  // change is recorded in the `edited` audit ladder below exactly like an
  // admin-made one — a stored setting that changes with no record is the class
  // this codebase repeatedly treats as a defect.
  //
  // `cxone_disabled` is forced ON (accounts off) for a kind that never creates
  // Checkmarx One accounts (a Booth Event), as the other prohibitions are.
  //
  // What is deliberately NOT touched: `self_enroll_enabled` and
  // `leaderboard_mode`. No policy FORBIDS either of
  // them for any kind — they only have per-kind CREATE defaults — and a default
  // seeds a create, it does not overwrite a choice an operator has already made.
  // `leaderboard_mode` is additionally inert on a sessionless kind, so resetting
  // it would spend an audit line to change nothing.
  //
  // `auto_end_on_all_solved` IS reset, and it is the one that needs its reason
  // stated because no policy forbids it either. It is the only kind-derived
  // column with NO admin control anywhere (PR 12 withheld its default from the
  // wire precisely because no form sends it), so on a kind change the stored
  // value is unreachable and the new kind's default is the only coherent answer.
  // Left alone, a Competition switched to a Program would keep `1` and close
  // itself the moment its first enrollee finished — the exact failure PR 16
  // describes — with no way for the admin to undo it.
  let autoEndCol = null;
  if (_kindChanging) {
    if (_polPut.revealAnswers === "forbidden" && comp.reveal_answers_on_end && revealOnEndCol === null) revealOnEndCol = 0;
    if (_polPut.groupLeaderboard === "forbidden" && comp.group_leaderboard_enabled && groupLbEnabledCol === null) groupLbEnabledCol = 0;
    if (_polPut.measurePresence === "forbidden") {
      if (comp.measure_presence && measurePresenceCol === null) measurePresenceCol = 0;
      // The tie-break basis goes with it: `presence` on a kind that cannot record
      // presence would rank every score tie on a column that can only hold zeros.
      if ((comp.time_basis || "elapsed") === "presence" && timeBasisCol === null) timeBasisCol = "elapsed";
    }
    // A kind that does not configure the sign-up form has the stored matrix
    // CLEARED. Every kind configures it today (operator ruling, 30 Oct 2026), so
    // a kind change keeps the creator's choice; the guard stays so that a kind
    // ever withdrawn from CONFIGURABLE_KINDS cannot carry a dormant matrix.
    if (!CONFIGURABLE_KINDS.has(_targetKind) && comp.registration_field_policy && !_regFieldsChanged) {
      regFieldsCol = null; _regFieldsChanged = true; _regFieldsForcedClear = true;
    }
    if (_polPut.cxoneProvisioning !== "allowed" && !comp.cxone_disabled && cxoneDisabledCol === null) cxoneDisabledCol = 1;
    if (_polPut.trustedNetworks === "never" && comp.trusted_network_ips && !trustedIpsChanged) {
      trustedIpsCol = null; trustedIpsChanged = true; trustedIpsForcedClear = true;
    }
    // v8.6.0 — a kind that may not run a late window has BOTH columns reset, for
    // the reason the sign-up matrix above gives: clearing is what makes
    // "booth events only" true of the DATA and not merely of the readers, so a
    // dormant deadline cannot spring back to life if the event is ever changed
    // back. The toggle goes to the TARGET's seed rather than to 0, so a change
    // back to Booth arrives with the kind's default rather than an off switch
    // nobody chose.
    if (_polPut.lateEntry !== "allowed") {
      const _lateTo = lateEntryDefaultForKind(_targetKind) ? 1 : 0;
      if ((comp.late_entry_enabled ? 1 : 0) !== _lateTo && lateEntryEnabledCol === null) lateEntryEnabledCol = _lateTo;
      if (comp.late_entry_deadline_at && lateEntryDeadlineCol === undefined) _lateEntryForcedReset = true;
    }
    const _autoEndTo = _polPut.autoEndOnAllSolvedDefault;
    if ((comp.auto_end_on_all_solved ? 1 : 0) !== _autoEndTo) autoEndCol = _autoEndTo;
  }
  let deadlineCol = null;      // null = no change (COALESCE)
  let derivedDurCol = null;
  // v8.3.0 — A KIND CHANGE CHANGES THE SCHEDULE MODEL, AND NEITHER VALUE CAN BE
  // INHERITED ACROSS IT.
  //
  // A Program's stored `duration_minutes` is DERIVED from a deadline that is
  // about to stop existing, so carrying it into a Booth Event would hand the
  // admin a window nobody chose — PR 16's "no column left holding a value nobody
  // picked", in reverse. And a window kind's start+duration says nothing about
  // where a deadline should fall, so one has to be supplied rather than invented:
  // inventing it is the third of the three objections v7.29.0 raised to a mutable
  // kind, and supplying it is the answer.
  //
  // Refused BY NAME rather than defaulted, because both are values with real
  // consequences that only the admin can choose. The edit form renders whichever
  // control the target kind uses, so it sends the right one.
  let _deadlineClear = false;
  if (_kindChanging) {
    const _fromSched = eventPolicy(comp).schedule;
    const _toSched = _polPut.schedule;
    if (_toSched === "deadline" && _fromSched !== "deadline" && deadline_at === undefined) {
      return res.status(400).json({
        error: `${eventKindPhrase(_targetComp).replace(/^./, c => c.toUpperCase())} runs to a deadline, so changing to it needs one.`,
        code: "deadline_required",
      });
    }
    if (_toSched !== "deadline" && _fromSched === "deadline") {
      if (duration_minutes == null) {
        return res.status(400).json({
          error: `${eventKindPhrase(_targetComp).replace(/^./, c => c.toUpperCase())} runs for a fixed duration, so changing to it needs one — its deadline is dropped.`,
          code: "duration_required",
        });
      }
      // COALESCE(?,deadline_at) cannot express "set to NULL", so the clear is its
      // own statement below — the same shape `trusted_network_ips` and
      // `attempt_cap` already use. Without it the row would keep a deadline its
      // kind does not read, which is exactly the stale-column state that made
      // PR 16 derive the pair rather than store both independently.
      _deadlineClear = true;
    }
  }
  if (_polPut.schedule === "deadline") {
    // v8.1.1 — THE START THIS REQUEST IS WRITING, never the one already stored.
    // The stored start was taken as authoritative because start is immutable once
    // started — true once it HAS started, and false for the whole upcoming
    // window, which is exactly when an organiser moves the date.
    //
    // v8.3.10 — THIS COMMENT USED TO SAY `_startMoved` can only be true while the
    // event is upcoming, because a start change on a live event was refused far
    // above. That is no longer so: a superadmin may now correct a LIVE event with
    // no footprint, so this branch is reachable on a live Program. It is already
    // right for that case — the duration is re-derived from the STORED deadline,
    // so the deadline stays put and the end does not drift — and `resolveSchedule`
    // still refuses a start at or past the deadline, which is the one new refusal
    // an admin can meet here. Nothing needed changing; the claim did.
    // The shipped edit form sends start_time AND
    // deadline_at on every save, so a Program created Sep 1 with a Dec 1 deadline
    // and then moved to Oct 1 kept its 131040-minute span and ran to Dec 31: a
    // month of submissions and completion certificates accepted past the deadline
    // every surface was still announcing. Moving the start earlier is the mirror
    // image, refusing a month early.
    // resolveSchedule also validates deadline-after-start against whatever start
    // it is handed, so the stale value made a deadline BEFORE the new start
    // acceptable through the API.
    const _effStart = new Date(start_time ?? comp.start_time);
    const _startMoved = start_time != null && start_time !== _storedStartIso;
    // v8.1.1 — RE-DERIVE ONLY WHEN THE DEADLINE ACTUALLY MOVED, and this is the
    // decision rather than an optimisation. The form round-trips the stored
    // deadline on every save and sends no duration, so re-deriving from any
    // PRESENT deadline meant ANY save of a Close-Now'd Program overwrote the
    // truncated elapsed duration Close Now had written with the full deadline
    // span; the revive block below then saw a future scheduled end, skipped the
    // all-solved gate because ended_manually=1, and silently reopened a settled
    // event — participants regain submit access and the shared-challenge freeze
    // lifts, with no warning, because the client's revival confirmation was gated
    // on a duration change and a deadline kind has no duration control. "Any
    // save" is literal: the CxOne opt-out, a self-enrolment toggle, a change of
    // attempt cap, or pressing Save having changed nothing at all.
    //
    // The tempting alternative — never re-derive once `ended_at` is set, which is
    // how the pair's uncoupling is phrased elsewhere — would make a closed
    // Program impossible to revive AT ALL, because moving the deadline IS this
    // kind's equivalent of extending a duration, and v7.7.x's rule is that a
    // manual end plus a deliberate extend always revives. Comparing against the
    // stored value keeps the deliberate revive working and kills the accidental
    // one. Same shape as the echoed `event_kind` and the unchanged `start_time`
    // above: echoing a value back is not a change.
    //
    // Compared as INSTANTS with the stored side normalised, matching
    // `_storedStartIso`: validateBody hands us a normalised ISO string, and an
    // older row may be formatted differently. A stored deadline that will not
    // parse counts as moved — there is nothing to compare against, and deriving
    // is the only way back to a coherent pair.
    const _storedDeadlineMs = comp.deadline_at ? new Date(comp.deadline_at).getTime() : NaN;
    const _deadlineMoved = deadline_at !== undefined
      && (isNaN(_storedDeadlineMs) || new Date(deadline_at).getTime() !== _storedDeadlineMs);
    if (deadline_at !== undefined) {
      // Validated on EVERY save, adopted only when something moved: an echoing
      // client that also sends a duration disagreeing with the pair must still be
      // refused, or the unchanged path becomes the way to desync it by hand.
      const _pr = resolveSchedule("deadline", _effStart, duration_minutes, deadline_at);
      if (_pr.error) return res.status(400).json({ error: _pr.error, code: _pr.code });
      if (_deadlineMoved || _startMoved) {
        deadlineCol = _pr.deadlineIso;
        derivedDurCol = _pr.durationMinutes;
      }
    } else if (_startMoved) {
      // A start-only edit is the same desync through a different door: the
      // deadline stays put and the span from it has changed, so the duration has
      // to be re-derived from the STORED deadline. Leaving it alone would move
      // the effective end by exactly the amount the start moved.
      const _pr = resolveSchedule("deadline", _effStart, duration_minutes, comp.deadline_at);
      if (_pr.error) return res.status(400).json({ error: _pr.error, code: _pr.code });
      derivedDurCol = _pr.durationMinutes;
    } else if (duration_minutes != null && duration_minutes !== comp.duration_minutes) {
      // A duration is not this kind's authority, and accepting it would leave the
      // pair disagreeing. Named rather than ignored.
      return res.status(400).json({
        error: "This event type takes a deadline, not a duration — move the deadline to extend it.",
        code: "duration_not_accepted",
      });
    }
  } else if (deadline_at !== undefined) {
    return res.status(400).json({
      error: "This event type runs for a fixed duration and does not take a deadline.",
      code: "deadline_not_accepted",
    });
  }
  const durationCol = derivedDurCol !== null ? derivedDurCol : (duration_minutes ?? null);
  // v8.3.10 — A CORRECTION MAY NOT SILENTLY END THE EVENT, and this clause is
  // what keeps the relaxation above small enough to reason about.
  //
  // `start_time` is an input to the status function, so moving a live event's
  // start BACKWARD by more than its duration puts the scheduled end behind us
  // and the event reads `ended`. An end reached that way is the disorderly kind:
  // `ended_at` stays NULL, so the two-kinds-of-ended discriminator calls it
  // time-expired; `freezeGroupLeaderboardSnapshots` never runs; the scheduler
  // records a terminal observation on its next tick. `end-now` exists for ending
  // an event and does all of that properly.
  //
  // Forward — into `upcoming` — is deliberately ALLOWED: that is the un-start the
  // operator asked for, and it is safe precisely because the footprint predicate
  // has already established there is no history for the re-opened guards to
  // protect. Only `ended` is refused, and only for an event that is live now; an
  // UPCOMING event's start has always been free to land anywhere, and narrowing
  // that would be a regression nobody asked for.
  if (oldStatus === "live" && _startChanged) {
    const _prospective = _singleSlotStatus({
      ...comp,
      start_time,
      duration_minutes: durationCol != null ? durationCol : comp.duration_minutes,
    });
    if (_prospective === "ended") {
      return res.status(400).json({
        error: "That start time would put the event's end in the past, ending it. Use End Now to end an event, or choose a start that keeps it running or still to come.",
        code: "start_time_would_end_event",
      });
    }
  }
  const changes = {};
  if (name != null && name !== comp.name) changes.name = { from: comp.name, to: name };
  // v8.3.10 — compare against the NORMALISED stored start, matching the guard
  // above. These two comparisons have always disagreed for a row whose stored
  // start is not byte-identical ISO; it never showed because the guard refused
  // every changed start first, so this branch was only ever reached while the
  // two agreed. Now that a change can pass, an unchanged-but-differently-
  // formatted start would otherwise manufacture a spurious audit entry — and,
  // through `_scheduleMoved` below, a spurious revive.
  if (_startChanged) changes.start_time = { from: comp.start_time, to: start_time };
  if (durationCol != null && durationCol !== comp.duration_minutes) changes.duration_minutes = { from: comp.duration_minutes, to: durationCol };
  if (deadlineCol != null && deadlineCol !== comp.deadline_at) changes.deadline_at = { from: comp.deadline_at, to: deadlineCol };
  if (leaderboard_mode && leaderboard_mode !== comp.leaderboard_mode) changes.leaderboard_mode = { from: comp.leaderboard_mode, to: leaderboard_mode };
  if (revealOnEndCol !== null && revealOnEndCol !== (comp.reveal_answers_on_end ? 1 : 0)) {
    changes.reveal_answers_on_end = { from: !!comp.reveal_answers_on_end, to: !!revealOnEndCol };
  }
  if (selfEnrollEnabledCol !== null && selfEnrollEnabledCol !== (comp.self_enroll_enabled ? 1 : 0)) {
    changes.self_enroll_enabled = { from: !!comp.self_enroll_enabled, to: !!selfEnrollEnabledCol };
  }
  if (groupLbEnabledCol !== null && groupLbEnabledCol !== (comp.group_leaderboard_enabled ? 1 : 0)) {
    changes.group_leaderboard_enabled = { from: !!comp.group_leaderboard_enabled, to: !!groupLbEnabledCol };
  }
  if (cxoneDisabledCol !== null && cxoneDisabledCol !== (comp.cxone_disabled ? 1 : 0)) {
    changes.cxone_disabled = { from: !!comp.cxone_disabled, to: !!cxoneDisabledCol };
  }
  if (staffCompeteCol !== null && staffCompeteCol !== (comp.staff_compete ? 1 : 0)) {
    changes.staff_compete = { from: !!comp.staff_compete, to: !!staffCompeteCol };
  }
  // v8.6.0 — late entries, both columns, in BOTH directions.
  //
  // The DEADLINE's `from`/`to` are the STORED values (null = "follows the event's
  // end"), never the resolved instants: History has to record what the admin
  // chose, and a resolved timestamp would read as a pin the admin never made —
  // and would change every time the schedule moved, which is precisely what the
  // NULL is for. The forced reset on a kind change is recorded too, for the reason
  // its siblings below are: it is a real stored change nobody asked for.
  if (lateEntryEnabledCol !== null && lateEntryEnabledCol !== (comp.late_entry_enabled ? 1 : 0)) {
    changes.late_entry_enabled = { from: !!comp.late_entry_enabled, to: !!lateEntryEnabledCol };
  }
  {
    const _leTo = _lateEntryForcedReset ? null : lateEntryDeadlineCol;
    // v8.12.7 — compared as INSTANTS, not strings: the form echoes the stored pin
    // verbatim, and a stored value that is not byte-identical normalised ISO must
    // not turn that echo into a History entry for a change nobody made.
    const _leToMs = _leTo ? new Date(_leTo).getTime() : null;
    const _leFromMs = comp.late_entry_deadline_at ? new Date(comp.late_entry_deadline_at).getTime() : null;
    if (_leTo !== undefined && _leToMs !== _leFromMs) {
      changes.late_entry_deadline_at = { from: comp.late_entry_deadline_at || null, to: _leTo || null };
    }
  }
  // v8.1.0 — the attempt ceiling. Recorded in BOTH directions, including the
  // clear: removing a cap mid-event silently hands everyone unlimited guesses,
  // which is precisely the change an operator would later need to account for.
  {
    const _capTo = _capCleared ? null : (_capNew !== undefined ? _capNew : undefined);
    const _capFrom = comp.attempt_cap ?? null;
    if (_capTo !== undefined && _capTo !== _capFrom) changes.attempt_cap = { from: _capFrom, to: _capTo };
    if (measurePresenceCol !== null && measurePresenceCol !== (comp.measure_presence ? 1 : 0)) {
      changes.measure_presence = { from: !!comp.measure_presence, to: !!measurePresenceCol };
    }
    if (timeBasisCol !== null && timeBasisCol !== (comp.time_basis || "elapsed")) {
      changes.time_basis = { from: comp.time_basis || "elapsed", to: timeBasisCol };
    }
  }
  // v8.1.0 (PR 13) — CURRENTLY UNREACHABLE, and deliberately present anyway.
  // The kind is immutable, so a change is refused with 400 `event_kind_immutable`
  // far above this line and the ladder entry can never fire today. It is one `if`,
  // and the failure it insures against is the one this codebase keeps paying for:
  // if a later phase permits a kind change under some condition, the audit is
  // already here rather than being silently forgotten by whoever adds it. Stated
  // rather than left for a reader to discover it is dead code.
  if (_v.values.event_kind !== undefined && _v.values.event_kind !== comp.event_kind) {
    changes.event_kind = { from: comp.event_kind, to: _v.values.event_kind };
  }
  // v8.3.0 — the two a kind change writes that the COALESCE-shaped comparisons
  // above structurally cannot see: `deadlineCol` is null for a CLEAR (null means
  // "no change" to every other reader), and `auto_end_on_all_solved` has no
  // request field at all, so it never appears in `_v.values`. Both are real
  // stored changes and both are forced by the platform rather than asked for, so
  // if anything belongs in the record it is these.
  if (_deadlineClear && comp.deadline_at) {
    changes.deadline_at = { from: comp.deadline_at, to: null };
  }
  if (autoEndCol !== null) {
    changes.auto_end_on_all_solved = { from: !!comp.auto_end_on_all_solved, to: !!autoEndCol };
  }
  // v8.6.0 — the late-entry deadline, checked against the schedule THIS REQUEST IS
  // WRITING rather than the stored one.
  //
  // The pair moves together on the edit form (an organiser who pushes the end back
  // an hour often pins the late deadline in the same save), so validating against
  // `comp` would refuse a perfectly coherent save whenever the new end passed the
  // old deadline — the v8.1.2 defect, where deriving from the STORED start while
  // writing a different one ran a Program a month past its own deadline. The
  // ternaries are the same "what will this row hold" resolution the start guard
  // uses.
  //
  // v8.12.7 — AGAINST THE EFFECTIVE END THIS SAVE LEAVES, not the rounded
  // scheduled end. For an event closed with End Now that is `ended_at` (the
  // scheduled end lands up to a minute after it), unless this very save revives
  // the event, in which case it is the new scheduled end — `_extendRevives` is the
  // same predicate the revive block below acts on. Checked HERE, below the start
  // guard and after the ladder has computed `_scheduleMoved`; nothing between the
  // old site and this one refuses, so the refusal order is unchanged, and it still
  // sits above the `validate_only` return.
  const _scheduleMoved = !!(changes.start_time || changes.duration_minutes || changes.deadline_at);
  // Whether late entries are on once this save lands, and whether THIS save
  // switches them back on. A re-tick wakes a pin that sat dormant while an
  // earlier save moved the end (untick, shorten or extend, then tick again), so
  // a re-tick is no echo either: the pin is judged against the cap as well.
  const _leOnAfter = lateEntryEnabledCol !== null ? lateEntryEnabledCol === 1 : !!comp.late_entry_enabled;
  const _leSwitchedOn = _leOnAfter && !comp.late_entry_enabled;
  if (lateEntryDeadlineCol !== undefined && lateEntryDeadlineCol !== null) {
    // AN ECHO IS NOT A CHANGE (the kind / start / switch idiom) — FOR THE CAP
    // ONLY. A form or API client round-tripping the stored pin must not be
    // re-judged against the 30-day cap End Now's earlier base can have moved under
    // it. It IS still required to be after the end this save leaves, whether or
    // not the schedule moves in this save: an END moved by an EARLIER save that
    // did not send the deadline (Allow late entries unticked, the event extended)
    // leaves the stored pin before the end, and exempting the echo wholesale let
    // the next save that re-ticked the box store that dead window — refused 400
    // before the exemption existed. On a save that moves the schedule, or switches
    // late entries back on, the echo is no echo at all, so the cap applies too:
    // the end that moved under the dormant pin was the admin's own earlier save,
    // not End Now.
    const _storedPinMs = comp.late_entry_deadline_at ? new Date(comp.late_entry_deadline_at).getTime() : NaN;
    const _pinEcho = !_scheduleMoved && !_leSwitchedOn && new Date(lateEntryDeadlineCol).getTime() === _storedPinMs;
    const _pros = { ...comp,
      start_time: start_time ?? comp.start_time,
      duration_minutes: durationCol != null ? durationCol : comp.duration_minutes };
    const _revives = _extendRevives({ wasEnded: oldStatus === "ended", endedAt: comp.ended_at, slotCount: _slotsPut.length,
      scheduleMoved: _scheduleMoved, newScheduledEnd: scheduledEnd(_pros), at: now() });
    const _base = competitionEffectiveEnd(_revives ? { ..._pros, ended_at: null } : _pros, _slotsPut);
    const _leErr = _validateLateDeadline(lateEntryDeadlineCol, _base,
      { endedAt: _base && _base.getTime() <= now().getTime() ? _base : null, capExempt: _pinEcho });
    if (_leErr) return res.status(400).json({ error: _leErr, code: "late_entry_deadline_invalid" });
  }
  // THE STORED PIN IS JUDGED TOO when this save leaves it in force and changes
  // what it is measured against: a save that moves the schedule, or switches late
  // entries back on, without sending a deadline. Same rules as a sent one that is
  // no echo (after the end this save leaves, and the 30-day cap: whatever reaches
  // here moved the schedule or wakes a dormant pin); refused, never clamped or
  // cleared, naming the pin and the ways out, in the app and through the API.
  // Skipped while late entries end up off (the pin is dormant, and the re-tick
  // that wakes it is judged here) and when a kind change resets the pin. Start
  // now meets it too: it sends the start and a duration rounded UP to the kept
  // end, so a pin set through the API within that minute ends up before the end.
  if (lateEntryDeadlineCol === undefined && !_lateEntryForcedReset && comp.late_entry_deadline_at
      && eventPolicy({ event_kind: _targetKind }).lateEntry === "allowed") {
    if (_leOnAfter && (_scheduleMoved || _leSwitchedOn)) {
      const _pros = { ...comp,
        start_time: start_time ?? comp.start_time,
        duration_minutes: durationCol != null ? durationCol : comp.duration_minutes };
      const _revives = _extendRevives({ wasEnded: oldStatus === "ended", endedAt: comp.ended_at, slotCount: _slotsPut.length,
        scheduleMoved: _scheduleMoved, newScheduledEnd: scheduledEnd(_pros), at: now() });
      const _base = competitionEffectiveEnd(_revives ? { ..._pros, ended_at: null } : _pros, _slotsPut);
      const _pinErr = _validateLateDeadline(comp.late_entry_deadline_at, _base,
        { endedAt: _base && _base.getTime() <= now().getTime() ? _base : null });
      if (_pinErr) {
        const _pinWhen = formatEmailDate(new Date(comp.late_entry_deadline_at), null);
        return res.status(400).json({
          error: `This event's late-entry deadline is pinned to ${_pinWhen}, and this change would leave it invalid: ${_pinErr} In the event's settings (Edit settings), set a later late-entry deadline or tick Automatic so it follows the end, then try again. Through the API, send a new late-entry deadline with this change, or an empty one for Automatic.`,
          code: "late_entry_deadline_stale",
        });
      }
    }
  }
  // v8.4.0 — THE MATRIX IS RECORDED PER FIELD, NOT AS THE STORED BLOB.
  //
  // The L9 drift guard requires every `competitions` column to be audited at
  // EDIT, and quoting JSON at an operator satisfies the letter of that while
  // failing its point: what a reader of the History dialog needs is "Phone:
  // optional → required", because that is the change that will put a participant
  // behind the completion gate. So the diff is decomposed to the fields that
  // actually moved, resolved on both sides — `from` is what the event asked for
  // before this save and `to` is what it asks for now, which is the comparison an
  // operator is making, rather than "null → {...}" for an event that was on the
  // kind's defaults.
  //
  // `forced_clear` marks the dormant guard above (a target kind outside
  // CONFIGURABLE_KINDS) wiping the configuration, as distinct from an admin
  // resetting it by hand. Every kind is configurable today, so no save reaches it.
  if (_regFieldsChanged) {
    const _fromStates = registrationFieldStates(comp);
    const _toStates = registrationFieldStates({ ...comp, event_kind: _targetKind, registration_field_policy: regFieldsCol });
    const _perField = {};
    for (const f of REGISTRATION_FIELDS) {
      if (_fromStates[f.key] !== _toStates[f.key]) _perField[f.key] = { from: _fromStates[f.key], to: _toStates[f.key] };
    }
    // A rewrite that moves no field (a stored blob in another shape: the retired
    // `password` key, another key order, a blob equal to the kind's defaults) is
    // still WRITTEN, which is what drops the key, but not RECORDED: History must
    // not say the sign-up form was edited when nothing it asks changed (#331).
    if (Object.keys(_perField).length || _regFieldsForcedClear) {
      changes.registration_field_policy = {
        fields: _perField,
        ...(_regFieldsForcedClear ? { forced_clear: true } : {}),
      };
    }
  }
  // v6.16.4 — invalidate the competition cache AFTER the txn commit,
  // not before. Pre-fix the order was invalidate-then-update: a
  // concurrent reader landing in the brief window between cache clear
  // and txn commit would re-populate the cache with the OLD row, then
  // the UPDATE would land — leaving the cache stale for up to 1 s
  // (the _competitionCache TTL). For reveal_answers_on_end toggles
  // post-end, that meant a flip could leak (or hide) answers for the
  // participants who happened to poll inside the window. Same correctness
  // gap on every other field this PUT touches; v6.16.4 closes them all.
  // v8.8.25 — EVERY REFUSAL ABOVE HAS RUN; NOTHING HAS BEEN WRITTEN.
  //
  // There is no `.run(`, INSERT, UPDATE or DELETE anywhere between the handler's
  // first statement and this line — the whole prologue is reads and arithmetic —
  // so returning here is a pure pre-flight. The client calls it BEFORE committing
  // its session deletes, which is the seam: those deletes commit first (v7.21.1
  // A4 ordered them that way deliberately, because a multi->single switch cannot
  // pass the PUT while its sessions still exist), so a PUT refused afterwards on
  // ordinary input left the sessions permanently gone under a bare failure.
  //
  // WHAT IT CANNOT CATCH, stated rather than implied — this NARROWS the seam, it
  // does not close it. Four refusals are raised INSIDE the transaction below
  // (`lb_mode_locked`, `time_basis_locked`, `start_time_locked_in_use`,
  // `staff_compete_locked`) and are
  // unreachable by any pre-flight by construction; the optimistic-concurrency
  // 409 and the participant-footprint gate both re-read live state, so a
  // colleague's edit or a walk-up scanning the join QR can still land between
  // the two calls. The window it opens (validate -> delete -> commit) is one
  // round trip wider than before, and the deletes bump `updated_at`, which the
  // client already compensates for. What it buys is the whole of category (a) —
  // the duplicate name most of all, which the client structurally cannot
  // self-check, holding only a filtered page of the list.
  if (_v.values.validate_only) {
    return res.json({ ok: true, validated: true, currentUpdatedAt: comp.updated_at || null });
  }
  let _lbModeLockRace = false;
  let _timeBasisLockRace = false;
  let _staffCompeteLockRace = false;
  let _startFootprintRace = null;
  const editTxn = db.transaction(() => {
    // v8.3.10 — THE FOOTPRINT IS RE-ASKED INSIDE THE TRANSACTION, and this is
    // what makes the emptiness gate a guarantee rather than an observation.
    //
    // The check far above ran before this handler's own validation work; between
    // the two, a walk-up can scan the /join QR of exactly the kind of live event
    // this permission exists for. better-sqlite3 is synchronous, the process is
    // single-threaded by hard invariant, and this transaction body contains no
    // await — so a probe placed here is genuine mutual exclusion, not an
    // approximation (the v7.15.11 attachment-reserve argument). It therefore
    // covers EVERY writer without naming any of them: self-enrol join, the
    // deferred consume, group reconciliation, bulk assign, invitation consume,
    // the participant import and bulk-seed all land in tables this probes.
    //
    // Scoped to a start change on a LIVE event, so the ordinary edit — and every
    // edit of an upcoming event — pays nothing.
    if (_startChanged && oldStatus === "live") {
      const _fp = eventParticipantFootprint(req.params.id);
      if (_fp) {
        _startFootprintRace = _fp;
        throw new Error("start_footprint_race");
      }
    }
    // v8.1.0 — ONE fresh read serving both locks. Status is TIME-derived, so an
    // event that was upcoming when the checks above ran can be live by the time
    // this commits; both settings shape the ranking, so both have to be re-asked
    // rather than only the older one.
    const _lbModeChanging = !!(leaderboard_mode && leaderboard_mode !== comp.leaderboard_mode);
    if (_lbModeChanging || _timeBasisChanged || _staffCompeteChanged) {
      const _freshComp = db.prepare("SELECT id,start_time,duration_minutes,ended_at,ended_manually FROM competitions WHERE id=?").get(req.params.id);
      if (_freshComp && competitionAnySlotStarted(_freshComp)) {
        // leaderboard_mode first when both are in play, so the refusal is
        // deterministic rather than depending on which field the form happened
        // to send.
        if (_lbModeChanging) {
          _lbModeLockRace = true;
          throw new Error("lb_mode_locked");
        }
        if (_timeBasisChanged) {
          _timeBasisLockRace = true;
          throw new Error("time_basis_locked");
        }
        // v8.12.0 — the third ranking-shape setting, re-asked for the same reason.
        _staffCompeteLockRace = true;
        throw new Error("staff_compete_locked");
      }
    }
    db.prepare(
      `UPDATE competitions SET name=COALESCE(?,name), start_time=COALESCE(?,start_time), duration_minutes=COALESCE(?,duration_minutes), deadline_at=COALESCE(?,deadline_at), leaderboard_mode=COALESCE(?,leaderboard_mode), reveal_answers_on_end=COALESCE(?,reveal_answers_on_end), self_enroll_enabled=COALESCE(?,self_enroll_enabled), group_leaderboard_enabled=COALESCE(?,group_leaderboard_enabled), cxone_disabled=COALESCE(?,cxone_disabled), measure_presence=COALESCE(?,measure_presence), time_basis=COALESCE(?,time_basis), staff_compete=COALESCE(?,staff_compete) WHERE id=?`
    ).run(
      name ?? null,                 // validated + trimmed
      start_time ?? null,           // validated + normalized ISO
      durationCol,                  // validated int, or DERIVED from the deadline
      deadlineCol,                  // null = no change
      leaderboard_mode || null,
      revealOnEndCol,    // null = no change (preserves COALESCE behaviour)
      selfEnrollEnabledCol,    // null = no change
      groupLbEnabledCol,       // null = no change
      cxoneDisabledCol,        // null = no change
      measurePresenceCol,      // null = no change
      timeBasisCol,            // null = no change
      staffCompeteCol,         // v8.12.0 — null = no change
      req.params.id
    );
    // v8.6.0 — the toggle rides the COALESCE (NOT NULL column, so NULL is
    // unambiguously "no change"); the DEADLINE gets its own statement, because
    // NULL is its "follow the event's end" MEANING rather than a no-change
    // sentinel — the `registration_field_policy` / `deadline_at` shape.
    if (lateEntryEnabledCol !== null) {
      db.prepare("UPDATE competitions SET late_entry_enabled=? WHERE id=?").run(lateEntryEnabledCol, req.params.id);
    }
    if (lateEntryDeadlineCol !== undefined || _lateEntryForcedReset) {
      db.prepare("UPDATE competitions SET late_entry_deadline_at=? WHERE id=?")
        .run(_lateEntryForcedReset ? null : lateEntryDeadlineCol, req.params.id);
    }
    // Written separately because COALESCE(?,col) cannot express "set to NULL",
    // and clearing the field is a first-class action (the admin removing the
    // venue's address after the event).
    if (trusted_network_ips !== undefined || trustedIpsForcedClear) {
      db.prepare("UPDATE competitions SET trusted_network_ips=? WHERE id=?").run(trustedIpsCol, req.params.id);
    }
    // v8.4.0 — its own statement, because NULL is a MEANING here rather than a
    // no-change sentinel: `registration_field_policy=COALESCE(NULL, col)` would
    // make "reset this event to the kind's defaults" — and the kind-change forced
    // clear — unexpressible. Gated on `_regFieldsChanged`, so an unchanged save
    // writes nothing; the shape `trusted_network_ips` above already has.
    if (_regFieldsChanged) {
      db.prepare("UPDATE competitions SET registration_field_policy=? WHERE id=?").run(regFieldsCol, req.params.id);
    }
    if (_capNew !== undefined || _capCleared) {
      db.prepare("UPDATE competitions SET attempt_cap=? WHERE id=?").run(_capCleared ? null : _capNew, req.params.id);
    }
    // v8.3.0 — the kind change itself, and the two columns that travel with it.
    // Its own statement for the same reason as the two above: `event_kind` is
    // never a COALESCE candidate (an unchanged kind must not be re-written), and
    // clearing `deadline_at` when a Program becomes a window kind is precisely
    // the "set to NULL" COALESCE cannot say. INSIDE the same transaction, so a
    // failure anywhere leaves the row wholly unchanged rather than half-converted.
    if (_kindChanging) {
      db.prepare("UPDATE competitions SET event_kind=? WHERE id=?").run(_targetKind, req.params.id);
    }
    if (_deadlineClear) {
      db.prepare("UPDATE competitions SET deadline_at=NULL WHERE id=?").run(req.params.id);
    }
    if (autoEndCol !== null) {
      db.prepare("UPDATE competitions SET auto_end_on_all_solved=? WHERE id=?").run(autoEndCol, req.params.id);
    }
    // v6.8.2 — keep email_reminders in sync with the new start_time.
    // Single-slot comps schedule the reminder 1 h before the comp start;
    // multi-slot rows carry a timeslot_id and track the timeslot's start
    // (handled in the timeslot PUT handler). Only pending (sent=0) rows
    // are moved — delivered ones have already fired.
    if (changes.start_time) {
      const newSendAt = new Date(new Date(changes.start_time.to).getTime() - 60 * 60 * 1000).toISOString();
      db.prepare(
        "UPDATE email_reminders SET send_at=? WHERE competition_id=? AND sent=0 AND (timeslot_id IS NULL OR timeslot_id='')"
      ).run(newSendAt, req.params.id);
    }
    // ── v8.3.0 — A KIND THAT FORBIDS START REMINDERS PURGES THE PENDING ONES. ──
    //
    // `startReminder: "forbidden"` says a Program is not an appointment, so a
    // "starts in about an hour" mail is the wrong model for it. The dispatcher
    // never asks: its SELECT (server.js) joins `competitions` for `name` and
    // `start_time` and reads no policy at all — so without this the mail simply
    // goes out for a kind whose policy forbids it.
    //
    // MAXIMALLY REACHABLE, which is why it is not deferred: a participant can
    // only SET a reminder while the event is upcoming, and upcoming is exactly
    // the window in which the type may be changed. Pending rows only — a
    // delivered reminder is a fact about a mail that was already sent.
    if (_kindChanging && _polPut.startReminder === "forbidden") {
      const _purged = db.prepare("DELETE FROM email_reminders WHERE competition_id=? AND sent=0").run(req.params.id).changes;
      if (_purged) changes.start_reminders_purged = { from: _purged, to: 0 };
    }
    // Sweep #391 — switching the join link OFF unties every sign-in code and
    // new-address code already emailed through it (lib/self-enroll.js
    // `untieJoinLinkBindings`): redeemed, they sign in without joining. In this
    // transaction, counted on the edit's record.
    const _joinLinkUntied = (changes.self_enroll_enabled && changes.self_enroll_enabled.to === false)
      ? untieJoinLinkBindings(req.params.id) : null;
    if (Object.keys(changes).length) recordCompetitionEvent(req.params.id, "edited", adminId, { changes, ...(_joinLinkUntied ? { join_link_untied: _joinLinkUntied } : {}), ...reqContext(req) });

    // v6.16.6 — duration-shrink-to-past detector. Pre-fix an admin
    // could shrink `duration_minutes` on a live single-slot comp such
    // that `start_time + duration < now()`. The status flipped to
    // "ended" via time arithmetic but `ended_at IS NULL` and no
    // `auto_ended` / `ended_manually` event ever fired (the periodic
    // walker would eventually catch up, but the operator's intent —
    // "end this comp now" — wasn't captured in the audit chain). The
    // detector runs only for single-slot live comps where the duration
    // change moves end into the past; multi-slot is governed by
    // per-slot end-now and isn't affected by comp-level duration. The
    // close + event are emitted IN THIS TXN so the UPDATE + ended_at
    // + audit row commit atomically.
    if (changes.duration_minutes != null) {
      const _slots = getCompetitionTimeslots(req.params.id);
      if (_slots.length === 0 && oldStatus === "live") {
        const newDur = changes.duration_minutes.to;
        const _newStart = changes.start_time ? changes.start_time.to : comp.start_time;
        const _newEnd = scheduledEnd({ start_time: _newStart, duration_minutes: newDur });
        if (_newEnd <= now()) {
          // Close out the comp in the same txn — ended_at gets the
          // current timestamp (representing "ended due to operator
          // shrink"), ended_manually=1 because this was an operator
          // action, not the auto-end scheduler. Emit ended_manually
          // with a `via:"duration_shrink"` discriminator so the audit
          // distinguishes shrink-to-end from /end-now.
          const endedAt = now().toISOString();
          db.prepare("UPDATE competitions SET ended_at=?, ended_manually=1 WHERE id=? AND ended_at IS NULL").run(endedAt, req.params.id);
          recordCompetitionEvent(req.params.id, "ended_manually", adminId, { via: "duration_shrink", duration_minutes: newDur, ...reqContext(req) });
        }
      }
    }
    // v6.16.27 — bump updated_at after every successful PUT so the
    // optimistic-concurrency check above sees the new value on the
    // next reader / writer. Always set unconditionally inside the
    // txn body so multi-statement PUTs (revive flag, ended_at,
    // duration shrink) all share the same updated_at stamp.
    db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(now().toISOString(), req.params.id);
  });
  // runTxnWithMirrorBuffer (ext-audit F4): editTxn emits recordCompetitionEvent
  // ("edited", and conditionally "ended_manually" on duration-shrink) and is
  // followed by more writes inside the same txn (the unconditional updated_at
  // bump, the reminder resync), so a rollback past the emit would strand a
  // ghost app.jsonl mirror line. Buffer the mirror until commit.
  try { runTxnWithMirrorBuffer(() => editTxn()); }
  catch (e) {
    if (_lbModeLockRace) return res.status(400).json({ error: "Cannot change leaderboard mode after a session has started" });
    if (_timeBasisLockRace) return res.status(400).json({
      error: "Cannot change the tie-break basis after the event has started — the ranking would change under participants mid-event.",
      code: "time_basis_locked",
    });
    if (_staffCompeteLockRace) {
      const _lock = staffCompeteSwitchLock({ fullyEnded: false, anySlotStarted: true });
      return res.status(400).json({ error: _lock.message, code: _lock.code });
    }
    // v8.3.10 — somebody arrived between the check and the commit. Same sentence
    // the pre-flight refusal uses, from the same predicate, so the admin cannot
    // tell (and does not need to tell) which of the two answered.
    if (_startFootprintRace) return res.status(400).json({
      error: `The start time of a running event can only be changed while nothing has happened in it — ${_startFootprintRace.detail}.`,
      code: "start_time_locked_in_use",
    });
    throw e;
  }
  _invalidateCompetitionCache(req.params.id);
  // v8.12.8 — A SAVE THAT MOVES THE LATE-ENTRY WINDOW busts every cache that
  // answers "is it open?" (`_bustLateWindowCaches`). A superadmin re-pinning the
  // deadline, a switch change, the forced reset on a kind change and any schedule
  // move (which moves an Automatic deadline and — through a revive — flips the
  // window for every member) all used to leave /api/me and the admin participants
  // page stale for their TTL; only the leaderboard was busted, and only on revive.
  // Gated on the change, so an ordinary save (a rename) clears nothing extra.
  if (changes.late_entry_deadline_at || changes.late_entry_enabled || _lateEntryForcedReset || _scheduleMoved) {
    _bustLateWindowCaches(req.params.id);
  }
  // v8.12.0 — the switch decides who is ON the board (5 s leaderboard cache) and
  // what /api/me reports per member (`competing`, 2 s me-cache); a plain flag
  // flip busts neither on its own, which is the v6.20.x tag-route defect one
  // column over. The switch is locked once the event has started, so in
  // practice this clears an empty board — but the writer-lock invariant is a
  // rule, not an observation. Rowless staff spectators keep the 2 s TTL.
  if (_staffCompeteChanged) {
    invalidateLeaderboardCache(req.params.id);
    _invalidateMeCacheForComps([req.params.id]);
    // v8.13.3 — and the admin participants page (5 s): its `rival_in` (rivalsOf
    // keeps only `c.staff_compete = 1` events) and its group chips' `competing`
    // both read this column, so for the TTL after a flip an organiser's pane
    // offered block / deny on a rival the guard then refuses, or — after OFF —
    // withheld doors that would work. lib/participants-cache.js's own rule: every
    // writer that changes cache-relevant state invalidates after its commit.
    invalidateAdminParticipantsCache();
    // Turning it ON is an ELIGIBILITY change for every staff-tagged member of a
    // group already bound to this event: the live sync skips them while the
    // switch is off (a spectator holds no row), so without a re-converge here
    // they stayed unenrolled until an unrelated membership change happened to
    // trigger one — the roster depended on request ORDER. Exactly the case the
    // tags route answers with `reconcileUserGroupCompetitions` when the `staff`
    // tag comes off, and the revive answers below. Fire-and-forget, like both.
    // An author of one of its challenges is still skipped by the sync's own
    // `staffRowRefusal` — the switch refuses to turn on with one enrolled, and
    // the sync refuses to enrol one afterwards.
    if (staffCompeteCol === 1) {
      reconcileCompetitionMembership(getCompetition(req.params.id), { actor: getAdminIdentity(req), context: reqContext(req) }).catch((e) => swallowed("competitions:group-reconcile", e, { level: "warn" }));
    }
  }
  // ── v8.4.0 — "IMMEDIATELY REFLECTED" IS THIS LINE ──────────────────────────
  //
  // `GET /api/me` carries `missing_fields`, which is now derived from the
  // registration event's CURRENT configuration — so making a field mandatory
  // changes what /api/me REPORTS for every account that registered through this
  // event, and that response is cached for two seconds per user. Without this
  // bust an admin's save would take up to two seconds per participant to appear,
  // which is the standing rule in *In-process caches*: a COMPETITION-level write
  // that changes what /api/me reports must bust a PER-USER cache.
  //
  // KEYED ON `registration_competition_id`, NOT ON MEMBERSHIP, and the difference
  // is the whole design: the gate asks the event somebody REGISTERED through, not
  // the event they happen to be in. `_invalidateMeCacheForComps` fans out over
  // `competition_users`, which is the wrong set in both directions — it would miss
  // a walk-up who has since left, and needlessly clear every member who
  // registered somewhere else.
  //
  // Gated on something having changed, so an ordinary save (a rename, a duration)
  // does not clear a cache entry per registrant.
  if (_regFieldsChanged) {
    try {
      for (const r of db.prepare("SELECT id FROM users WHERE registration_competition_id=?").all(req.params.id)) {
        _invalidateMeCache(r.id);
      }
    } catch (e) { log.error({ ...reqContext(req), competition_id: req.params.id, err: e.message }, "me-cache bust after registration-fields change failed"); }
  }

  // If was ended and new scheduled end is now in the future, clear ended_at to make it live.
  // v7.2.x (audit) — single-slot ONLY (mirrors the duration-shrink detector above,
  // which scopes itself to `_slots.length === 0`). A multi-slot comp's ended_at is
  // derived from its slots all ending; clearing it via a comp-level duration edit
  // would emit a spurious `revived` event and leave comp.ended_at=NULL while every
  // slot stays ended. Multi-slot revival is governed by per-slot end-now/revive.
  let allSolved = false;
  // v8.1.9 — A REVIVE REQUIRES THAT THIS REQUEST ACTUALLY MOVED THE SCHEDULE.
  //
  // The gate below asks "is the scheduled end in the future?", which is not the
  // same question as "did the admin give this event more time?" — and for about
  // sixty seconds after End Now the two disagree. `end-now` stores
  // `Math.ceil(elapsed / 60_000)` minutes, so the derived scheduled end lands up
  // to a minute AFTER the moment the event actually ended; within that window any
  // save at all — a CxOne opt-out, a tag, renaming it, or pressing Save having
  // changed nothing — found a future scheduled end, skipped the all-solved gate
  // because `ended_manually` is set, and silently reopened a settled event.
  // Participants regained submit access and the shared-challenge freeze lifted.
  //
  // Rounding is NOT the thing to fix. `ceil` is what stops a sub-minute event
  // storing a zero duration, and `competitionEffectiveEnd` already clamps to
  // MIN(ended_at, scheduledEnd), so the overshoot is invisible everywhere except
  // here. What was wrong is the inference: an unchanged schedule cannot be a
  // deliberate extension. This is the same rule PR 16's deadline branch got in
  // v8.1.2, applied to the duration kind — and it leaves the documented v7.7.x
  // behaviour intact, because extending a manually-ended event still moves
  // `duration_minutes` and still revives.
  //
  // v8.12.7 — `_scheduleMoved` is computed with the audit ladder (the late-entry
  // deadline is judged against the end this save LEAVES, which depends on whether
  // it revives), and the condition itself is `_extendRevives`, the one definition
  // that validation reads too — so the base a deadline was judged against and the
  // revive that then happens cannot disagree.
  if (oldStatus === "ended" && comp.ended_at && getCompetitionTimeslots(req.params.id).length === 0) {
    const updated = getCompetition(req.params.id);
    if (_extendRevives({ wasEnded: true, endedAt: comp.ended_at, slotCount: 0,
         scheduleMoved: _scheduleMoved, newScheduledEnd: scheduledEnd(updated), at: now() })) {
      // The all-solved gate only protects against reviving an AUTO-ended
      // (everyone-solved-everything) competition into a pointless "zombie-live"
      // state. A MANUALLY-ended comp the admin is now extending is a deliberate
      // "give it more time" → always revive it, regardless of solve state. This
      // mirrors the timeslot duration-edit revive (routes/sessions.js), which
      // already skips the check for `ended_manually` slots — keeping single-slot
      // and multi-slot revive semantics uniform (v7.7.x).
      // v7.7.18 — ALSO skip the all-solved gate when SELF-ENROLLMENT is open: a
      // self-enroll comp must never be stuck in an all-solved-ended state (new
      // participants can still join via /join), so extending it always revives.
      // v8.3.11 — ALSO skip the gate when this event cannot auto-end on all-solved
      // at all. The gate exists to stop an AUTO-ended competition being reopened
      // into a pointless zombie-live state; where the auto-end is forbidden by the
      // kind (a Booth Event) or switched off for the event, there is no such state
      // to protect, and refusing would be a refusal guarding against something
      // unreachable. It is not merely tidy: a Booth Event created in the v8.0.0
      // window really did auto-end, and once the prohibition landed that row would
      // have been permanently unreopenable for exactly this reason. One rule, three
      // consumers — see autoEndOnAllSolvedApplies (lib/event-policy.js).
      if (!updated.ended_manually && !updated.self_enroll_enabled && autoEndOnAllSolvedApplies(updated)) {
        // v7.21.13 — the "did everyone finish everything?" question is asked in
        // three places (here, the per-slot twin in routes/sessions.js, and the
        // auto-end scan in server.js) and was written out longhand at each. Both
        // halves now come from lib/competitions, so the challenges that count
        // (assigned + active + published) and the participants who count (active
        // per ACTIVE_PARTICIPANT_SQL — players inside the verification grace included, per
        // v7.7.27 M2 — minus staff/benchmark) can no longer drift apart.
        const totalTasks = publishedTaskCount(req.params.id);
        const participants = scoringParticipantIds(req.params.id);
        if (totalTasks > 0 && participants.length > 0) {
          allSolved = allParticipantsSolvedAll(participants, req.params.id, totalTasks);
        }
      }
      if (!allSolved) {
        _invalidateCompetitionCache(req.params.id);
        const reviveTxn = db.transaction(() => {
          db.prepare("UPDATE competitions SET ended_at=NULL, ended_manually=0, updated_at=? WHERE id=?").run(now().toISOString(), req.params.id);
          recordCompetitionEvent(req.params.id, "revived", adminId, { via: "duration_edit", ...reqContext(req) });
          _resyncStatusObservationAfterRevive("competition", req.params.id);
        });
        // The audit emit is NOT the last statement (the resync INSERT follows), so
        // buffer the mirror — a rollback after the emit must not leak a ghost
        // `revived` line into app.jsonl. Mirrors _idempCloseTxn below + the
        // CLAUDE.md runTxnWithMirrorBuffer invariant.
        runTxnWithMirrorBuffer(() => reviveTxn());
        // v6.11.0: drop the leaderboard cache too. buildLeaderboardEntries
        // caches with (compId, timeslotId) keys; `_invalidateCompetitionCache`
        // only touches the competition-lookup cache, not the leaderboard
        // cache. Without this the next /api/leaderboard read after revival
        // serves stale entries for up to 5 s (TTL) — participants' solveTimeMs
        // stays pinned at the OLD `effEnd - login` instead of flipping to
        // the live `nowMs - login` branch. Caught by the v6.11.0 regression
        // test asserting solveTimeMs advances after revival.
          invalidateLeaderboardCache(req.params.id);
        // concurrency-cache audit (#8): reconcileCompetitionMembership early-
        // returns on ended comps, so bound-group membership changes made while
        // this comp was ended were skipped. Now that it's revived, re-converge
        // it to its bound groups. Fire-and-forget — the PUT response doesn't
        // depend on the sync; getCompetition() reads post-txn live state (the
        // comp cache was busted at line ~351).
        reconcileCompetitionMembership(getCompetition(req.params.id), { actor: adminId, context: reqContext(req) }).catch((e) => swallowed("competitions:group-reconcile", e, { level: "warn" }));
        log.info({ ...reqContext(req), competition_id: comp.id, competition_name: sanitiseForLog(comp.name), actor: sanitiseForLog(adminId), via: "duration_edit" }, "Competition revived");
      }
    }
  }
  // audit v7.7.37 (C11) — a TIME-EXPIRED single-slot comp (ended_at NULL) revived
  // by extending its duration skips the block above (gated on ended_at) and flips
  // ended→live purely via time arithmetic, but its scheduler observation stays
  // 'ended' forever → no auto_started for the revived window, no auto_ended when it
  // time-expires again (broken forensic chain). Re-arm the observation to the fresh
  // status. Nothing to clear + no `revived` event — the time-derived status already
  // flipped on its own.
  else if (oldStatus === "ended" && !comp.ended_at && getCompetitionTimeslots(req.params.id).length === 0) {
    const revived = getCompetition(req.params.id);
    const revivedEnd = scheduledEnd(revived);
    if (revivedEnd > now()) { try { _resyncStatusObservationAfterRevive("competition", req.params.id); } catch (e) { swallowed("competitions:revive-status-resync", e); } }
  }

  // v7.16.0 — MUST be top-level in the PUT, not nested in a status branch. The
  // allowlist is read on every rate-limited request from an in-process cache,
  // so any write to the column has to bust it; and a saved entry must LIFT an
  // existing block immediately, because the alert copy promises "the block is
  // lifted immediately on save" and an instruction that is not true is worse
  // than none. (v7.16.0 first landed this inside the ended→live revive branch,
  // where it never ran on an ordinary save — the feature was inert.)
  // v7.21.7 — three separate decisions, previously conflated behind
  // `trustedIpsChanged`:
  //   CACHE  — any write to the column, changed or not. Free, idempotent, and
  //            the only thing that can rescue a cache made stale elsewhere.
  //            Gating it on "changed" is what made the ban alert's own remedy a
  //            silent no-op: the alert says "put <ip> in Trusted network IPs and
  //            save", the admin opens the form, sees the address ALREADY there
  //            (because it was set at create), saves — identical value, so
  //            `trustedIpsChanged` is false and nothing whatsoever happened.
  //   BLOCK  — any save of a non-empty value. The documented promise is
  //            unconditional ("Any block already in force on that address is
  //            lifted immediately"), and re-saving is exactly what an admin does
  //            when the alert says the address is already listed.
  //   AUDIT  — a real value change, OR a no-op save that actually released
  //            something. "X → X" rows are noise nobody reads; a block release
  //            with no record is a bypass event with no trail. `released > 0` is
  //            precise, not a heuristic: _scannerClearMatching skips entries with
  //            no blockedUntil, so non-zero means a real block was deleted — and
  //            it cannot repeat on a second identical save.
  // v8.3.10 — A SCHEDULE MOVE INVALIDATES THE ALLOWLIST TOO, and it is a
  // different write from the one below.
  //
  // The trusted-network bypass window is `start_time` → effective end + 2 h
  // (lib/comp-allowlist.js), computed from CACHED competition rows with no user
  // term at all. So moving a live event's start moves a venue-wide rate-limit
  // bypass — the one consumer of `start_time` that is NOT moot at zero
  // participants. Until now this could not happen (a started event's start was
  // immutable and an upcoming one's window had not opened), so the invalidation
  // below was correctly gated on the IP field alone; now a start change can move
  // the window without touching that field, leaving only the 5-second TTL
  // between the write and the truth. One cheap call closes it.
  if (_startChanged && (comp.trusted_network_ips || trustedIpsCol)) invalidateCompAllowlist();
  if (trusted_network_ips !== undefined || trustedIpsForcedClear) {
    invalidateCompAllowlist();
    const released = trustedIpsCol ? clearScannerBlocksFor(trustedIpsCol) : 0;
    try {
      if (trustedIpsChanged) {
        recordCompetitionEvent(req.params.id, "trusted_networks_changed", getAdminIdentity(req), {
          from: comp.trusted_network_ips || null, to: trustedIpsCol || null,
          blocks_released: released, grace_ms: TRUSTED_IP_GRACE_MS, ...reqContext(req),
        });
      } else if (released > 0) {
        recordCompetitionEvent(req.params.id, "trusted_networks_applied", getAdminIdentity(req), {
          to: trustedIpsCol, blocks_released: released, grace_ms: TRUSTED_IP_GRACE_MS, ...reqContext(req),
        });
      }
    } catch (e) { swallowed("competitions:put-trusted-networks-audit", e); }
  }
  // v8.3.0 — `/api/me` embeds each competition's DERIVED policy
  // (listParticipantCompetitions → eventPolicyForWire) behind a 2-second
  // per-user cache, and this route had never invalidated it — harmless while
  // the kind could not change, and a stale ranking/certificate shape for up to
  // two seconds now that it can. Members only, after the commit, matching the
  // tag route's shape. The standing rule is explicit: any route that changes
  // what /api/me reports must bust it.
  if (_kindChanging) {
    for (const r of db.prepare("SELECT user_id FROM competition_users WHERE competition_id=?").all(req.params.id)) {
      _invalidateMeCache(r.user_id);
    }
  }
  const final = getCompetition(req.params.id);
  const newStatus = competitionStatus(final);
  // v7.12.3 (audit M4) — if this PUT revived the comp (ended→live, either the ended_at
  // block or the time-expired branch above), drop any frozen group-leaderboard snapshot
  // so a re-end recomputes the team board from the fresh end-state.
  if (oldStatus === "ended" && newStatus !== "ended") invalidateGroupLeaderboardSnapshot(req.params.id);
  // ext-audit v7.15.7 — and the MIRROR case: if this PUT ENDED the competition
  // (duration-shrink-to-past, or a start_time/duration edit whose arithmetic
  // puts the end behind us), freeze the team board here. v7.15.6 wired the
  // explicit end-now routes and the scheduler but missed this one, so a
  // shrink-ended comp still had zero snapshots and a group edit before the
  // first read rewrote its final standings.
  if (oldStatus !== "ended" && newStatus === "ended") {
    freezeGroupLeaderboardSnapshots(req.params.id);
    // v8.15.1 — an end is an end: queue the certificates and the congratulations email.
    enqueueCertificateDispatch(req.params.id, { reason: "ended" });
  } else if (oldStatus === "ended" && newStatus === "ended") {
    // AN ENDED EVENT WHOSE END THIS PUT MOVED keeps its wrap-up (operator ruling,
    // 17 Nov 2026): re-queued for the new end, since the pending job, keyed on the
    // old end, is dropped as stale and the event team would never hear.
    const _wasEnd = competitionEffectiveEnd(comp), _newEnd = competitionEffectiveEnd(final);
    if (_wasEnd && _newEnd && _wasEnd.getTime() !== _newEnd.getTime()) require("../lib/team-reports").enqueueTeamReport(final, "ended");
  }
  res.json({
    ok: true,
    competition: { ..._compWire(final, { isSuperAdmin: !!req.session.isSuperAdmin, actorId: competitorIds(req) }), status: newStatus, effective_end: competitionEffectiveEnd(final)?.toISOString() || null },
    statusChanged: oldStatus !== newStatus,
    oldStatus,
    newStatus,
    allSolved,
  });
});

app.delete("/api/admin/competitions/:id", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  // A role scoped to its events reaches this route by holding Delete events, and
  // deletes only its own (lib/rbac.js PLATFORM_WIDE_PERMISSIONS, the comment).
  { const denied = competitionDenied(req, comp.id); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  // v8.3.10 — A LIVE EVENT NOBODY HAS TOUCHED MAY BE DELETED, on the same
  // predicate that now lets its start be corrected.
  //
  // The two guards were inconsistent the moment the edit relaxed: an admin could
  // fix a mistyped start on a pristine live event but not simply remove the event
  // they had just created wrongly — and "delete it and start again" is the more
  // obvious remedy of the two. This route is ALREADY superadmin-only, so the tier
  // half of the predicate is satisfied by the middleware; what it adds is the
  // footprint. `startTimeChangeLock` answers `null` exactly when both hold.
  //
  // Note the deliberate asymmetry with the refusal below it: an event with any
  // mark on it is still refused outright, because this delete CASCADES —
  // submissions, hint reveals, reminders and events all go with it, and that is
  // not something to do to a live event on a superadmin's say-so alone.
  if (competitionStatus(comp) === "live") {
    const _dLock = startTimeChangeLock(comp, { isSuperAdmin: true });
    if (_dLock) {
      return res.status(400).json({
        error: _dLock.reason === "has_participants"
          ? `Cannot delete a live event that is in use — ${eventParticipantFootprint(comp.id)?.detail || "it has activity"}. End it first.`
          : "Cannot delete a live competition. End it first.",
        code: "delete_live_in_use",
      });
    }
  }
  const adminId = getAdminIdentity(req);
  // Gather cascade counts and child-event row ids BEFORE the delete so the log entry is complete.
  const timeslotIds = db.prepare("SELECT id FROM competition_timeslots WHERE competition_id=?").all(req.params.id).map(r => r.id);
  const counts = {
    timeslots: timeslotIds.length,
    users: db.prepare("SELECT COUNT(*) as c FROM competition_users WHERE competition_id=?").get(req.params.id).c,
    tasks: db.prepare("SELECT COUNT(*) as c FROM competition_tasks WHERE competition_id=?").get(req.params.id).c,
    submissions: db.prepare("SELECT COUNT(*) as c FROM submissions WHERE competition_id=?").get(req.params.id).c,
    reminders: db.prepare("SELECT COUNT(*) as c FROM email_reminders WHERE competition_id=?").get(req.params.id).c,
    competition_events: db.prepare("SELECT COUNT(*) as c FROM competition_events WHERE competition_id=?").get(req.params.id).c,
    timeslot_events: timeslotIds.length
      ? db.prepare(`SELECT COUNT(*) as c FROM timeslot_events WHERE timeslot_id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(timeslotIds)).c
      : 0,
  };
  const deleteCompTxn = db.transaction(() => {
    // Tidy the event tables first — nothing reachable from UI points to a deleted competition/timeslot.
    db.prepare("DELETE FROM competition_events WHERE competition_id=?").run(req.params.id);
    if (timeslotIds.length) {
      const ph = "SELECT value FROM json_each(?)";
      db.prepare(`DELETE FROM timeslot_events WHERE timeslot_id IN (${ph})`).run(JSON.stringify(timeslotIds));
    }
    db.prepare("DELETE FROM submissions WHERE competition_id=?").run(req.params.id);
    db.prepare("DELETE FROM hint_reveals WHERE competition_id=?").run(req.params.id);
    db.prepare("DELETE FROM email_reminders WHERE competition_id=?").run(req.params.id);
    db.prepare("DELETE FROM competition_timeslots WHERE competition_id=?").run(req.params.id);
    db.prepare("DELETE FROM competition_tasks WHERE competition_id=?").run(req.params.id);
    db.prepare("DELETE FROM competition_users WHERE competition_id=?").run(req.params.id);
    // v6.16.4 — competition_user_absences (added v6.12.0) was orphaned
    // on competition delete pre-fix. No FK / no ON DELETE CASCADE; the
    // rows survived as ghosts that distort solveTimeMs if the
    // competition.id is ever recycled via import.
    db.prepare("DELETE FROM competition_user_absences WHERE competition_id=?").run(req.params.id);
    // audit v7.7.32 (RM5) — challenge_events has NO FK / ON DELETE CASCADE (its
    // competition_id is a plain column, db.js), so pre-fix these rows survived a
    // competition delete forever. The competition_tags rows DO cascade away, and
    // global analytics excludes internal comps via `competition_id NOT IN (SELECT
    // … competition_tags WHERE tag='internal')` — so once an INTERNAL comp was
    // deleted, its tag rows vanished, its orphan challenge_events were no longer
    // excluded, and every default analytics view was permanently inflated by a
    // dry-run competition that no longer exists and can't be re-filtered. Task
    // delete + user delete already purge challenge_events; comp delete now matches.
    // (The 15s analytics cache self-heals; no cross-module invalidator needed.)
    db.prepare("DELETE FROM challenge_events WHERE competition_id=?").run(req.params.id);
    // v7.2.x (audit) — achievement_badges cascade-delete with the competition (FK),
    // but the snapshot PNGs older certificates still name in `images` have NO FK
    // and would orphan forever. Delete them first (badge images are referenced
    // only by achievement_badges; a newer certificate names none, sweep #43).
    db.prepare("DELETE FROM images WHERE id IN (SELECT image_id FROM achievement_badges WHERE competition_id=?)").run(req.params.id);
    // The questions this event OWNS (lib/event-copies.js) go with it, after its
    // answers, hints and analytics above: nothing else lists them. One a template
    // names (or another event's row still names) is released into the library.
    deleteCompTxn._owned = removeEventOwnedQuestions(db, req.params.id);
    _invalidateCompetitionCache(req.params.id);
    db.prepare("DELETE FROM competitions WHERE id=?").run(req.params.id);
  });
  deleteCompTxn();
  const _owned = deleteCompTxn._owned || { deleted: 0, released: 0, attachmentPaths: [] };
  counts.owned_questions = _owned.deleted;
  if (_owned.released) counts.owned_questions_released = _owned.released;
  // Post-commit: the deleted questions' attachment files, each only once no row
  // names it (a copy shares its bank question's files). Unreferenced files are
  // also reaped by the attachment sweeps.
  for (const rel of [...new Set(_owned.attachmentPaths)]) {
    if (db.prepare("SELECT 1 FROM task_attachments WHERE storage_path=? LIMIT 1").get(rel)) continue;
    // Inline path-containment guard (Checkmarx-recognized sanitizer), as at every
    // attachment sink (lib/attachments.js): unlink only strictly inside DATA_DIR.
    const _base = path.resolve(DATA_DIR);
    const abs = path.resolve(path.join(DATA_DIR, String(rel || "")));
    if (abs.startsWith(_base + path.sep)) fs.unlink(abs, (e) => { if (e && e.code !== "ENOENT") swallowed("competitions:owned-question-unlink", e); });
  }
  // v8.13.3 — the transaction above deleted this event's competition_users rows
  // (and its organiser grants, by cascade), and the admin participants page embeds
  // both as each row's `competitions[]` / `event_admin_for`. Unbusted, the pane kept
  // serving focus badges for a deleted event — each a 404 on click — for the 5 s TTL.
  invalidateAdminParticipantsCache();
  // v6.16.11 — delete also drops submissions + hint_reveals (which the
  // leaderboard derives from), so the leaderboard cache must be busted
  // for hygiene/invariant compliance. Subsequent reads via
  // /api/leaderboard 404 first (gated by requireParticipantInCompetition
  // against a non-existent comp), so no user-visible bug existed —
  // this is the writer-lock invariant from CLAUDE.md ("any writer to
  // leaderboard-relevant tables must invalidate").
  invalidateLeaderboardCache(req.params.id);
  // v6.10.50 — competition delete drops every competition_events row in
  // the transaction above but doesn't go through `recordCompetitionEvent`
  // (which is the centralised invalidation hook). Without this explicit
  // call the cache would keep serving the pre-delete event list for the
  // 5-s TTL. Direct delete-driven invalidation closes that gap.
  invalidateAdminCompEventsCache(comp.id);
  // v8.4.0 — and the per-user /api/me cache for anyone who REGISTERED through this
  // event. Their profile-completion requirement is resolved from this row, so
  // deleting it changes what /api/me reports for them (the pointer dangles and the
  // stamped `profile_policy` takes over) — the standing rule again: a
  // COMPETITION-level write that changes what /api/me reports must bust a PER-USER
  // cache. Keyed on `registration_competition_id`, not on membership, because the
  // gate asks about the event somebody registered THROUGH.
  try {
    for (const r of db.prepare("SELECT id FROM users WHERE registration_competition_id=?").all(comp.id)) {
      _invalidateMeCache(r.id);
    }
  } catch (e) { log.error({ ...reqContext(req), competition_id: comp.id, err: e.message }, "me-cache bust after competition delete failed"); }
  // Orphaned-audit: competition row + its event history were both dropped in the
  // transaction above, so we can't write to competition_events. Emit to app.jsonl
  // with source:"audit" so the deletion is discoverable alongside every other audit row.
  recordOrphanedAuditEvent("competition", comp.id, "deleted", adminId, {
    name: comp.name,
    start_time: comp.start_time,
    duration_minutes: comp.duration_minutes,
    ended_at: comp.ended_at,
    cascaded: counts,
    ...reqContext(req),
  });
  res.json({ ok: true });
});

app.post("/api/admin/competitions/:id/end-now", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  // v8.7.0 — above the idempotent-close branch, which writes.
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  // v6.16.7 — idempotent close. Pre-fix the gate refused with 400 if
  // status was "ended" by ANY mechanism. For a single-slot comp where
  // start_time + duration < now() but ended_at IS NULL (the periodic
  // auto-end scheduler hasn't run yet, or its txn failed), the admin
  // saw "not currently live" while the UI clock claimed it should
  // still be live — confusing UX. Now an "ended-by-time-arithmetic-
  // but-not-yet-flagged" comp is closed out idempotently: write
  // ended_at, ended_manually=1, emit ended_manually(via:"idempotent_close").
  const _initialStatus = competitionStatus(comp);
  if (_initialStatus === "ended" && !comp.ended_at) {
    const _adminId = getAdminIdentity(req);
    const _endedAt = now().toISOString();
    // v6.16.11 — multi-slot idempotent close walks slots. Pre-fix the
    // idempotent branch stamped ended_at on the COMPETITION row only;
    // for multi-slot comps where every slot is time-arithmetic-ended
    // but no slot row had ended_at set, the per-slot audit chain
    // never got its `ended_manually` / `auto_ended` row. Now we walk
    // slots inside the same txn and stamp every time-ended-but-not-
    // flagged slot too, mirroring the manual end-now branch below.
    // r.changes > 0 gates the audit emit so the loser of a concurrent
    // race (e.g. scheduler tick mid-flight) doesn't double-fire.
    const _slots = getCompetitionTimeslots(req.params.id);
    let _slotsClosed = 0;
    const _idempCloseTxn = db.transaction(() => {
      for (const s of _slots) {
        const sStat = timeslotStatus(s);
        if (sStat !== "ended" || s.ended_at) continue;
        const r = db.prepare(
          "UPDATE competition_timeslots SET ended_at=?, ended_manually=1, updated_at=? WHERE id=? AND ended_at IS NULL"
        ).run(_endedAt, _endedAt, s.id);
        if (r.changes > 0) {
          recordTimeslotEvent(s.id, "ended_manually", _adminId, { via: "idempotent_close", cascade: true, ...reqContext(req) });
          _slotsClosed++;
        }
      }
      const r = db.prepare("UPDATE competitions SET ended_at=?, ended_manually=1, updated_at=? WHERE id=? AND ended_at IS NULL").run(_endedAt, _endedAt, req.params.id);
      if (r.changes > 0) {
        recordCompetitionEvent(req.params.id, "ended_manually", _adminId, { via: "idempotent_close", ...reqContext(req) });
      }
    });
    runTxnWithMirrorBuffer(() => _idempCloseTxn());
    // v8.12.8 — End Now changes the status and OPENS the late-entry window that
    // /api/me embeds; it used to bust only the row and the leaderboard.
    _bustLateWindowCaches(req.params.id);
  // ext-audit v7.15.6 — freeze the team board(s) HERE, at the end transition.
  // Lazily freezing on the first post-end READ left everything between the end
  // and that read still live, so a group-membership edit in the gap silently
  // rewrote a finished competition's standings and then froze the wrong figures.
  freezeGroupLeaderboardSnapshots(req.params.id);
  enqueueCertificateDispatch(req.params.id, { reason: "ended" });   // v8.15.1
    const updated = getCompetition(req.params.id);
    return res.json({
      ok: true,
      alreadyEnded: true,
      slotsClosed: _slotsClosed,  // v6.16.11
      competition: { ..._compWire(updated, { isSuperAdmin: !!req.session.isSuperAdmin, actorId: competitorIds(req) }), status: competitionStatus(updated), effective_end: competitionEffectiveEnd(updated)?.toISOString() || null },
    });
  }
  if (_initialStatus !== "live") return res.status(400).json({ error: "Event is not currently live" });
  const endedAt = now().toISOString();
  const endedMs = new Date(endedAt).getTime();
  const adminId = getAdminIdentity(req);
  const slots = getCompetitionTimeslots(comp.id);
  // v6.16.11 — gate every `recordCompetitionEvent("ended_manually")` /
  // `recordTimeslotEvent("ended_manually")` on `r.changes > 0`. Pre-fix
  // two concurrent end-now requests would both pass the
  // `_initialStatus === "live"` gate and run their own txns serially
  // (a better-sqlite3 transaction is synchronous, so two can only run one
  // after the other — NOT because `db.transaction()` opens BEGIN IMMEDIATE;
  // it opens a DEFERRED BEGIN). The first commits ended_at; the
  // second's UPDATE without the `ended_at IS NULL` filter still runs
  // and emits a duplicate audit row. Adding the filter + gating the
  // emit on changes folds the loser into a no-op for both rows AND
  // events. Same shape v6.16.11 added to the idempotent close above.
  // (This handler has no await today, so in one process the second
  // request reads the committed ended_at and is refused at the gate above;
  // the filter is what keeps the audit single if an await ever lands here.)
  const endTxn = db.transaction(() => {
    for (const s of slots) {
      const sStatus = timeslotStatus(s);
      if (sStatus === "live") {
        const actualDur = Math.max(1, Math.ceil((endedMs - new Date(s.start_time).getTime()) / 60_000));
        const r = db.prepare(
          "UPDATE competition_timeslots SET ended_at=?, ended_manually=1, duration_minutes=?, updated_at=? WHERE id=? AND ended_at IS NULL"
        ).run(endedAt, actualDur, endedAt, s.id);
        if (r.changes > 0) recordTimeslotEvent(s.id, "ended_manually", adminId, { duration_minutes: actualDur, cascade: true, ...reqContext(req) });
      } else if (sStatus === "upcoming") {
        const r = db.prepare(
          "UPDATE competition_timeslots SET start_time=?, duration_minutes=0, ended_at=?, ended_manually=1, updated_at=? WHERE id=? AND ended_at IS NULL"
        ).run(endedAt, endedAt, endedAt, s.id);
        if (r.changes > 0) {
          // A session ended before it started will never start: its unsent start
          // reminders go with it (the dispatcher would otherwise skip them later as
          // "already started", which it never was).
          const _cancelled = db.prepare("DELETE FROM email_reminders WHERE competition_id=? AND timeslot_id=? AND sent=0").run(req.params.id, s.id).changes;
          recordTimeslotEvent(s.id, "ended_manually", adminId, { duration_minutes: 0, cascade: true, ...(_cancelled ? { reminders_cancelled: _cancelled } : {}), ...reqContext(req) });
        }
      }
    }
    const compActualDur = Math.max(1, Math.ceil((endedMs - new Date(comp.start_time).getTime()) / 60_000));
    _invalidateCompetitionCache(req.params.id);
    const rComp = db.prepare(
      "UPDATE competitions SET ended_at=?, ended_manually=1, duration_minutes=?, updated_at=? WHERE id=? AND ended_at IS NULL"
    ).run(endedAt, compActualDur, endedAt, req.params.id);
    if (rComp.changes > 0) recordCompetitionEvent(req.params.id, "ended_manually", adminId, { duration_minutes: compActualDur, ...reqContext(req) });
  });
  // runTxnWithMirrorBuffer (ext-audit F4): the per-slot recordTimeslotEvent
  // emits are followed by the comp-level UPDATE + recordCompetitionEvent in the
  // same txn, so a rollback past a slot emit would strand ghost app.jsonl lines.
  runTxnWithMirrorBuffer(() => endTxn());
  // Drop the leaderboard cache so the rankings immediately reflect the
  // ended state (solve time pinned to effective_end instead of ticking up).
  // v8.12.8 — and every other cache that reads the late-entry window: End Now
  // OPENS it for a Booth Event, and /api/me (the participant's status and
  // countdown) and the admin participants page (who is a removable late entrant)
  // both embed it. One helper, `_bustLateWindowCaches`.
  _bustLateWindowCaches(req.params.id);
  // ext-audit v7.15.6 — freeze the team board(s) HERE, at the end transition.
  // Lazily freezing on the first post-end READ left everything between the end
  // and that read still live, so a group-membership edit in the gap silently
  // rewrote a finished competition's standings and then froze the wrong figures.
  freezeGroupLeaderboardSnapshots(req.params.id);
  // v8.15.1 — queue the certificates and the congratulations email (lib/certificate-dispatch.js).
  enqueueCertificateDispatch(req.params.id, { reason: "ended" });
  const updated = getCompetition(req.params.id);
  res.json({ ok: true, competition: { ..._compWire(updated, { isSuperAdmin: !!req.session.isSuperAdmin, actorId: competitorIds(req) }), status: competitionStatus(updated), effective_end: competitionEffectiveEnd(updated)?.toISOString() || null } });
});

// ── v8.12.8 — "CLOSE LATE ENTRIES NOW" ───────────────────────────────────────
//
// Closes a Booth Event's OPEN late-entry window immediately and exactly: the
// deadline is pinned to a SERVER-resolved instant, to the millisecond, with no
// minute rounding. Until this route the only way was a superadmin editing the
// ended event and typing a deadline the form rounds to the minute (v8.12.7 F3),
// because the PUT refuses every edit of an ended event whose effective end has
// passed to anyone but a superadmin — and a window only ever opens after that end.
//
// WHY A NEW ROUTE, NOT A HOLE IN THE PUT'S GATE. The operator's ruling widens the
// tier for ONE act — SHORTENING a window — to every admin and to an event admin on
// the events they organise. Moving the deadline earlier reclassifies nobody
// (`isLateEntry` reads the join cutoff and the finish time, never the deadline), so
// the main board, the late-entrant partition and every issued certificate stay as
// they are. This route cannot REOPEN a window (that stays a superadmin's editor
// save), cannot revive the event (it touches neither `ended_at` nor the schedule)
// and cannot move the team board (frozen at the end; late entrants excluded).
//
// ORDER — the competition-door rule: 404 first (a mistyped id keeps its accurate
// answer); the COMPETITOR lock above the event-admin SCOPE (every tier hears the
// same refusal for the same act, exactly as end-now); scope above every lifecycle
// fact (no answer about an event the actor cannot see); then the event's own
// facts, most permanent first (`lateEntryCloseState`). An event whose window is
// already shut answers an idempotent 200 — two organisers at one stand, a
// double-click, a stale row and the deadline passing while the confirm was open
// all want the same end state (end-now's `alreadyEnded` precedent).
//
// THE HANDLER IS AWAIT-FREE, deliberately, and must stay so. That keeps it outside
// the v8.12.7 F1 class ("an admin write that awaits before it writes re-asks
// `adminAuthzDenied` at commit"): if an await is ever added before the write, that
// re-check becomes mandatory and the source scanner will say so.
//
// It reads NOTHING from the body: no `expectedUpdatedAt` (the stored value is
// server-resolved, so there is no client value that could overwrite anybody's
// work, and the check would only turn an unrelated concurrent write into a
// spurious 409 on a stand-side button — end-now takes none either).
app.post("/api/admin/competitions/:id/late-entry/close", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });

  const _wire = (row) => ({
    ..._compWire(row, { isSuperAdmin: !!req.session.isSuperAdmin, actorId: competitorIds(req) }),
    status: competitionStatus(row),
    effective_end: competitionEffectiveEnd(row)?.toISOString() || null,
  });
  // The one answer for a state that is not "open", from the pre-flight AND from
  // the in-transaction re-ask, so the two cannot word it differently.
  const _answer = (st, row) => {
    if (st.kind === "closed") {
      // Nothing written, no audit row, `updated_at` untouched.
      const w = _wire(row);
      return res.json({ ok: true, closed: false, alreadyClosed: true,
        late_entry_deadline_effective: w.late_entry_deadline_effective, competition: w });
    }
    return res.status(st.status || 400).json(st.code ? { error: st.message, code: st.code } : { error: st.message });
  };

  // PRE-FLIGHT, on the cached row, so a refusal never takes the write lock.
  const pre = lateEntryCloseState(comp);
  if (pre.kind !== "open") return _answer(pre, comp);

  const adminId = getAdminIdentity(req);
  let out = null;
  // ONE `.immediate()` TRANSACTION. It READS then WRITES, and a DEFERRED BEGIN
  // fails SQLITE_BUSY at the read→write upgrade at once under a writer in ANOTHER
  // process (an operator's sqlite3 shell, `scripts/purge.sh --apply`) — measured
  // at 6 ms under a 300 ms lock in v8.12.6 — which would be a spurious 500 on an
  // organiser's button. `.immediate()` takes the write lock at BEGIN and waits
  // out `busy_timeout` like an autocommit write does.
  //
  // The in-transaction re-ask is what DECIDES the write. In this single-process,
  // await-free handler the pre-flight and it cannot disagree (better-sqlite3 is
  // synchronous, so no request of this process runs in between — the v7.15.11
  // mutual-exclusion argument, which is also why there is no compare-and-swap
  // clause); it exists for the external-writer case, and reads the row UNCACHED.
  const closeTxn = db.transaction(() => {
    const fresh = db.prepare("SELECT * FROM competitions WHERE id=?").get(comp.id);
    if (!fresh) { out = { gone: true }; return; }
    const slots = getCompetitionTimeslots(comp.id);
    const nowMs = now().getTime();
    const st = lateEntryCloseState(fresh, { slots, nowMs });
    if (st.kind !== "open") { out = { state: st, row: fresh }; return; }
    const effEnd = competitionEffectiveEnd(fresh, slots);
    const from = lateEntryDeadline(fresh, effEnd);
    // ONE MILLISECOND BEFORE the press, and never at or before the end — see
    // `lateEntryCloseInstantMs` (lib/late-entry.js) for both halves.
    const pinIso = new Date(lateEntryCloseInstantMs(effEnd, nowMs)).toISOString();
    const stamp = new Date(nowMs).toISOString();
    // `updated_at` IS bumped (the lifecycle-mutation invariant): a superadmin's
    // editor opened before the close holds the old deadline, and its save must
    // 409 rather than re-open the window by echoing it back.
    db.prepare("UPDATE competitions SET late_entry_deadline_at=?, updated_at=? WHERE id=?").run(pinIso, stamp, comp.id);
    // A DEDICATED audit type, not an `edited` row: it is an action, its `from` is
    // the RESOLVED deadline (an Automatic column is NULL, which an `edited` diff
    // would render as "∅ → …"), and a dedicated type is what an operator greps.
    // `changed_by` is the acting human (v8.12.1); `reqContext` carries the source
    // IP and, in an impersonated organiser's panel, `impersonated_by`/`acting_as`.
    recordCompetitionEvent(comp.id, "late_entry_closed", adminId, {
      closed_at: stamp,                                   // the press instant — what History shows
      to: pinIso,                                         // what was stored (closed_at − 1 ms)
      from: from ? from.toISOString() : null,             // the deadline it replaced, RESOLVED
      from_pinned: fresh.late_entry_deadline_at || null,  // null = it was following the end
      ...reqContext(req),
    });
    out = { closed: { stamp, pinIso, from, fromPinned: !!fresh.late_entry_deadline_at } };
  });
  runTxnWithMirrorBuffer(() => closeTxn.immediate());

  if (out.gone) return res.status(404).json({ error: "Event not found" });
  if (out.state) { _invalidateCompetitionCache(comp.id); return _answer(out.state, out.row); }

  // POST-COMMIT, by id — every cache that answers "is the window open?". Without
  // the competition-row bust a late entrant's answer sent within the next second
  // is judged against the pre-close row; without the others, /api/me, the admin
  // participants page and the late board keep reporting an open window.
  _bustLateWindowCaches(comp.id);
  // v8.15.1 — the late entrants' placings are final now, so their certificates
  // (deferred while the window was open) are due.
  enqueueCertificateDispatch(comp.id, { reason: "late_entry_closed" });
  log.info({ ...reqContext(req), competition_id: comp.id, competition_name: sanitiseForLog(comp.name),
             actor: sanitiseForLog(adminId), closed_at: out.closed.stamp }, "Late entries closed early");
  const updated = getCompetition(comp.id);
  return res.json({
    ok: true, closed: true, alreadyClosed: false,
    closed_at: out.closed.stamp,
    late_entry_deadline_at: out.closed.pinIso,
    previous_deadline: out.closed.from ? out.closed.from.toISOString() : null,
    previous_deadline_pinned: out.closed.fromPinned,
    competition: _wire(updated),
  });
});
app.get("/api/admin/competition-tags", requireAdmin, (req, res) => {
  // v8.7.0 — the DISTINCT runs over the actor's OWN events. Platform-wide it
  // published every other event's tag vocabulary — customer names, internal
  // programme codes — into an organiser's filter chips, which is a leak even
  // though no event row is returned. The PERMANENT tags stay merged in: they are
  // a constant of the platform, not another event's data, and withholding them
  // would hide the dry-run chip on the actor's own events.
  const _tagScope = scopeFilterSql(req, "competition_id");
  const tags = db.prepare("SELECT DISTINCT tag FROM competition_tags WHERE 1=1" + _tagScope.clause + " ORDER BY tag")
    .all(..._tagScope.params).map(r => r.tag);
  const merged = [...new Set([...COMPETITION_PERMANENT_TAGS, ...tags])].sort();
  res.json(merged);
});

app.post("/api/admin/competitions/:id/tags", requireAdmin, csrfProtection, (req, res) => {
  // batch 7 — boundary validation: `tag` is type-checked + non-empty + ≤50 here,
  // so the handler never touches a raw req.body value (the recurring 500 class).
  const _v = validateBody(req.body, { tag: { type: "string", required: true, max: 50, label: "Tag" } });
  if (_v.error) return res.status(400).json({ error: _v.error });
  const tag = _v.values.tag; // validated + trimmed
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  // Ended competitions: superadmin-only
  if (competitionStatus(comp) === "ended") {
    const effEnd = competitionEffectiveEnd(comp);
    if (effEnd && effEnd <= now() && !req.session.isSuperAdmin) {
      return res.status(403).json({ error: "Only superadmin can change tags on ended events" });
    }
  }
  const cleaned = tag.toLowerCase();
  const adminId = getAdminIdentity(req);
  let inserted = false;
  try { inserted = db.prepare("INSERT INTO competition_tags (competition_id, tag) VALUES (?,?)").run(req.params.id, cleaned).changes > 0; }
  catch (e) {
    // duplicate
    swallowed("competitions:tag-insert", e);
  }
  if (inserted) {
    try { recordCompetitionEvent(req.params.id, "tag_added", adminId, { tag: cleaned, ...reqContext(req) }); } catch (e) { swallowed("competitions:tag-added-audit", e); }
  }
  const tags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, tags });
});

app.delete("/api/admin/competitions/:id/tags/:tag", requireAdmin, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  if (competitionStatus(comp) === "ended") {
    const effEnd = competitionEffectiveEnd(comp);
    if (effEnd && effEnd <= now() && !req.session.isSuperAdmin) {
      return res.status(403).json({ error: "Only superadmin can change tags on ended events" });
    }
  }
  // v8.3.17 — `req.params` IS ALREADY DECODED BY EXPRESS. Decoding a second time
  // is a second, WRONG transformation, and both of its consequences were measured
  // against the running server:
  //
  //   • a tag containing a literal `%` can NEVER be deleted, and answers 500. The
  //     client correctly sends `encodeURIComponent("50% done")` = `50%25 done`,
  //     Express hands us `50% done`, and `decodeURIComponent("50% done")` throws
  //     `URIError: URI malformed` — straight into the generic error handler.
  //   • the WRONG TAG IS DELETED AND THE RESPONSE REPORTS SUCCESS. Measured: a
  //     competition tagged `["%61", "50% done", "a"]`, asked to delete `%61`,
  //     answered 200 and removed **`a`** — because Express decoded `%2561` to
  //     `%61` and this line then decoded that to `a`.
  //
  // Tags are free text (`validateBody` allows any non-empty string ≤ 50, then
  // lower-cases), so `%`-bearing tags are perfectly creatable, and the tags this
  // reaches are load-bearing: `test/dry run` decides analytics exclusion and badge
  // eligibility, `staff` and `benchmark` decide leaderboard membership.
  //
  // Every client call site already uses `encodeURIComponent`, which is correct and
  // is exactly why the extra decode is wrong. (`test/dry run` survived only by
  // luck: it contains no `%`, so the second decode was a no-op.)
  const tag = req.params.tag;
  const adminId = getAdminIdentity(req);
  const r = db.prepare("DELETE FROM competition_tags WHERE competition_id=? AND tag=?").run(req.params.id, tag);
  if (r.changes > 0) {
    try { recordCompetitionEvent(req.params.id, "tag_removed", adminId, { tag, ...reqContext(req) }); } catch (e) { swallowed("competitions:tag-removed-audit", e); }
  }
  const tags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, tags });
});
// v7.13.2 — the PER-COMPETITION CxOne override (API key + group name) is ADMIN-level
// by design (restores the original intent; an ext-audit had over-tightened it to
// superadmin-only). The GLOBAL default CxOne config (routes/admin-misc.js) stays
// superadmin-only. The API key is still validated + scrubbed identically.
app.put("/api/admin/competitions/:id/cxone", requireAdmin, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  // A kind that never creates accounts has no key to override (its form shows
  // no Checkmarx One section). Removing one (DELETE below) stays open.
  if (eventPolicy(comp).cxoneProvisioning !== "allowed") {
    return res.status(400).json({ error: _cxoneRefused(comp), code: "cxone_provisioning_forbidden" });
  }
  const { cxone_api_key, cxone_group_name } = req.body;
  // batch 5 — typeof guards before the .trim() calls inside the txn (a non-string
  // api key / group name would 500).
  if (cxone_api_key != null && typeof cxone_api_key !== "string")
    return res.status(400).json({ error: "API key must be text" });
  if (cxone_group_name != null && typeof cxone_group_name !== "string")
    return res.status(400).json({ error: "Group name must be text" });
  const adminId = getAdminIdentity(req);
  const cxoneTxn = db.transaction(() => {
    const changes = {};
    if (cxone_api_key && cxone_api_key.trim()) {
      const decoded = decodeCxOneApiKey(cxone_api_key.trim());
      if (!decoded) throw { userError: true, error: "The API key you entered is not a valid CheckmarxOne API key." };
      _invalidateCompetitionCache(req.params.id);
      db.prepare("UPDATE competitions SET cxone_api_key=? WHERE id=?").run(cxone_api_key.trim(), req.params.id);
      changes.api_key = "updated";
    }
    if (cxone_group_name != null) {
      _invalidateCompetitionCache(req.params.id);
      db.prepare("UPDATE competitions SET cxone_group_name=? WHERE id=?").run(cxone_group_name.trim() || null, req.params.id);
      changes.group_name = cxone_group_name.trim() || null;
    }
    if (Object.keys(changes).length) recordCompetitionEvent(req.params.id, "cxone_config_changed", adminId, { ...changes, ...reqContext(req) });
  });
  try { runTxnWithMirrorBuffer(() => cxoneTxn()); } catch (e) { if (e.userError) return res.status(400).json({ error: e.error }); throw e; }
  const updated = getCompetition(req.params.id);
  const cfg = updated.cxone_api_key ? decodeCxOneApiKey(updated.cxone_api_key) : null;
  res.json({
    ok: true,
    cxone_configured: !!cfg,
    cxone_tenant: cfg?.tenant || "",
    cxone_base_url: cfg?.baseUrl || "",
    cxone_group_name: updated.cxone_group_name || "",
  });
});

app.delete("/api/admin/competitions/:id/cxone", requireAdmin, csrfProtection, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  const adminId = getAdminIdentity(req);
  const clearTxn = db.transaction(() => {
    _invalidateCompetitionCache(req.params.id);
    db.prepare("UPDATE competitions SET cxone_api_key=NULL, cxone_group_name=NULL WHERE id=?").run(req.params.id);
    recordCompetitionEvent(req.params.id, "cxone_config_changed", adminId, { cleared: true, ...reqContext(req) });
  });
  runTxnWithMirrorBuffer(() => clearTxn());
  res.json({ ok: true, cxone_configured: false, cxone_group_name: "" });
});


// ─────────────────────────────────────────────────────────────────────────────
// v8.7.0 — EVENT ORGANISERS (the `event_admin` grant surface).
//
// `users.role='event_admin'` is the TIER; `competition_admins` is the SCOPE. The
// two are written here together, and only here — see ROLES_AND_PERMISSIONS.md §8.
//
// GRANTING IS `requireGlobalAdmin`, i.e. admin or superadmin but never an event
// admin. That is what stops the role self-propagating, and the operator asked for
// it explicitly. Reading the list is ordinary `requireAdmin` + a scope check, so
// an event admin can see who else organises their own event.
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/admin/competitions/:id/admins", requireAdmin, (req, res) => {
  const comp = db.prepare("SELECT id, name FROM competitions WHERE id=?").get(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  const rows = db.prepare(
    `SELECT ca.user_id AS id, ca.granted_by, ca.granted_at,
            u.first_name, u.last_name, u.nickname, u.email, u.role
       FROM competition_admins ca JOIN users u ON u.id = ca.user_id
      WHERE ca.competition_id = ?
      ORDER BY u.nickname COLLATE NOCASE`
  ).all(comp.id);
  res.json({ ok: true, competition: { id: comp.id, name: comp.name }, admins: rows });
});

app.post("/api/admin/competitions/:id/admins", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const comp = db.prepare("SELECT id, name FROM competitions WHERE id=?").get(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  if (!userId) return res.status(400).json({ error: "userId is required" });
  const target = db.prepare("SELECT id, role, nickname, email, first_name, last_name FROM users WHERE id=?").get(userId);
  if (!target) return res.status(404).json({ error: "User not found" });

  // The peer-admin doctrine. Turning a full admin INTO an event admin is a
  // DEMOTION — it narrows what they can reach — and demotions belong on the
  // superadmin-only role route, where the staff tag, the group reconcile and the
  // session purge are all handled together.
  // RBAC — every unscoped (class `all`) role, built-in or custom.
  if (require("../lib/rbac").isGlobalClassRole(target.role)) {
    return res.status(403).json({
      error: "That account is already an administrator. Change its role from the participant's row instead.",
      code: "event_admin_target_privileged",
    });
  }

  const adminId = getAdminIdentity(req);
  const grantedAt = now().toISOString();
  let roleChanged = false;
  let alreadyGranted = false;

  const grantTxn = db.transaction(() => {
    // RBAC — a role already scoped by grants (the built-in event admin, or a
    // custom `granted` role) keeps its role and only gains the row.
    if (require("../lib/rbac").roleClass(target.role) !== "granted") {
      // Compare-and-swap on the role we READ, so a concurrent role change cannot
      // be clobbered by this scoped action.
      const upd = db.prepare("UPDATE users SET role='event_admin' WHERE id=? AND role='participant'").run(userId);
      if (upd.changes === 0) throw new Error("role_race");
      roleChanged = true;
    }
    const ins = db.prepare(
      "INSERT OR IGNORE INTO competition_admins (competition_id, user_id, granted_by, granted_at) VALUES (?,?,?,?)"
    ).run(comp.id, userId, adminId, grantedAt);
    alreadyGranted = ins.changes === 0;
    const details = {
      competition_id: comp.id, competition_name: comp.name,
      user_id: userId, nickname: target.nickname || null,
      role_changed: roleChanged, ...reqContext(req),
    };
    // BOTH histories. An organiser reading the event's History and an admin
    // reading the participant's must each see this; one emit would leave a
    // state change invisible on the surface somebody actually opens.
    recordUserEvent(userId, "event_admin_granted", adminId, details);
    recordCompetitionEvent(comp.id, "event_admin_granted", adminId, details);
  });
  try { runTxnWithMirrorBuffer(() => grantTxn()); }
  catch (e) {
    if (e && e.message === "role_race") {
      return res.status(409).json({ error: "That account's role changed while you were working. Reload and try again." });
    }
    throw e;
  }

  invalidateEventAdminScope(userId);
  _invalidateMeCache(userId);
  invalidateAdminParticipantsCache();
  invalidateAdminCompEventsCache(comp.id);
  // Match POST /api/admin/participants/:id/role: purge the target's other
  // sessions so the admin flags are re-derived at their next sign-in rather than
  // a stale participant session carrying isAdmin:false for its full idle life.
  if (roleChanged) { try { invalidateOtherSessions("userId", userId, req.sessionID, SESSION_END.ended); } catch (e) { /* best-effort */ swallowed("competitions:organiser-role-session-purge", e); } }
  res.json({ ok: true, granted: !alreadyGranted, role_changed: roleChanged });
});

app.delete("/api/admin/competitions/:id/admins/:uid", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const comp = db.prepare("SELECT id, name FROM competitions WHERE id=?").get(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.12.0 — a competitor may not touch the event they compete in (see the PUT).
  { const _cmp = _competitorRefused(req, res, comp.id); if (_cmp) return _cmp; }
  const userId = req.params.uid;
  const target = db.prepare("SELECT id, role, nickname FROM users WHERE id=?").get(userId);
  const adminId = getAdminIdentity(req);
  let removed = 0;
  const revokeTxn = db.transaction(() => {
    removed = db.prepare("DELETE FROM competition_admins WHERE competition_id=? AND user_id=?").run(comp.id, userId).changes;
    if (!removed) return;
    const details = {
      competition_id: comp.id, competition_name: comp.name,
      user_id: userId, nickname: target?.nickname || null, ...reqContext(req),
    };
    recordUserEvent(userId, "event_admin_revoked", adminId, details);
    recordCompetitionEvent(comp.id, "event_admin_revoked", adminId, details);
  });
  runTxnWithMirrorBuffer(() => revokeTxn());
  if (!removed) return res.status(404).json({ error: "That account is not an organiser of this event." });

  invalidateEventAdminScope(userId);
  _invalidateMeCache(userId);
  invalidateAdminParticipantsCache();
  invalidateAdminCompEventsCache(comp.id);

  // THE ROLE IS DELIBERATELY NOT CHANGED, even when this was their last event.
  //
  // `role='event_admin'` with zero grants is a coherent, FAIL-CLOSED state: every
  // list comes back empty and every predicate refuses. Auto-demoting would let a
  // REGULAR admin perform a superadmin action (a role change, with its staff-tag
  // write, group reconcile and session purge) as a side effect of a scoped one.
  // "Demote altogether" is the superadmin role route, which cascades this table.
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM competition_admins WHERE user_id=?").get(userId).n;
  res.json({ ok: true, removed: true, remaining_events: remaining });
});

// ── Self-enrollment link admin management (v6.21.0) ──────────────────────────
// Reveal + regenerate are ANY-admin (participation is already admin-level via
// invitations + bulk-assign). The token is the only secret; it ships only from
// the reveal GET. Enable/disable + allow-instant toggles flow through the
// competition PUT (also admin-level), reusing its concurrency + audit.
// (The admin self-enroll reveal + regenerate routes are registered by
// routes/self-enroll.js, above.)

// v8.15.0 — Clone event and event templates. Registered from one function at
// the END of this file, so the block reads as one unit and the existing routes
// above are untouched.
_registerBlueprintRoutes(app);
};

// ═════════════════════════════════════════════════════════════════════════════
// v8.15.0 — CLONE EVENT AND EVENT TEMPLATES ("quick spin")
//
// Two ways to make an event without filling the create form, and ONE path that
// writes it (`_materialiseEvent`), so a clone and a spawned template can never
// disagree about what a new event is:
//
//   POST /api/admin/competitions/:id/clone             — copy an event's setup
//   POST /api/admin/event-templates/:id/spawn          — instantiate a template
//
// WHAT A NEW EVENT TAKES. Every event SETTING (the columns the create form and
// the PUT write), its tags, its challenge ASSIGNMENTS (same challenges; the
// per-event numbers are assigned afresh, lazily, when it goes live, exactly as
// for a hand-built event), and — clone only — its sessions re-based so the first
// starts at the new start, and a pinned late-entry deadline re-based relative to
// the new end. The schedule copied is the PLAN: for a row End Now cut short, the
// start and length it had before (`_plannedSchedule`). Qualifying questions are
// per-event copies, so they are never shared: the new event gets its own
// ("Add the qualifying questions"). NEVER: participants, group bindings, submissions, hints, presence,
// certificates, history, the join link / QR / short code (a fresh token and
// code are minted, as the create route mints them for every event, so the
// source's printed QR never admits anyone to the copy), trusted network IPs (a
// venue address and a rate-limit bypass), the event's own CxOne API key, and
// the lifecycle columns (`ended_at`, `ended_manually`, `created_at`,
// `updated_at`). A CxOne group name is copied only when the source uses the
// platform's DEFAULT key — with its own key gone, the group would otherwise be
// looked up in a different tenant. For the same reason a source that CREATES
// accounts with its own key gives a copy (a clone, or a template saved from
// it) account creation OFF, named `cxone_disabled` in `forced_settings`
// (`_bpOwnKeyTurnsAccountsOff`): with the key gone, every joiner would get an
// account in the platform's default tenant, one the source never sent anybody
// to (operator ruling, 14 Nov 2026).
//
// THE NEW EVENT IS UPCOMING. A start at or before now is refused
// (`start_time_not_future`), and an omitted start means 24 hours from now. That
// is what keeps every "locked once started" rule (kind, sessions, presence,
// staff-compete) from binding a copy nobody has looked at yet.
//
// WHO. Clone is 'scoped': an event admin may clone an event they organise, and
// the copy grants them a `competition_admins` row on it — the one door through
// which this tier creates an event, admitted because the copy is of an event
// they already run. Spawn is 'scoped' too (a template is a blueprint a global
// admin vetted); template create / edit / delete / save-as-template are
// global-admin only, held twice (EVENT_ADMIN_FORBIDDEN and requireGlobalAdmin).
// A competitor may not clone the event they compete in (competitor_cannot_edit).
//
// CHALLENGES that cannot be assigned are SKIPPED, never failing the copy, and
// each is reported with a named reason in `skipped_challenges`: `missing`
// (deleted since), `not_visible` (an event admin's three-way visibility rule,
// asked first and reported with no id or title), `competing` (held by an event
// the actor competes in, the seat or the hand: operator ruling, 23 Nov 2026; a
// template save refuses it instead, 403 `template_task_competing`), `qualifying` (another event's
// own qualifying question; not reported when the copy got a fresh one with the
// same key), `not_published`, `locked` (a non-superadmin, the assign doors'
// rule), `unfit` (lib/challenge-fit.js against the NEW kind) and `unsealed` (a
// staff-compete event holds sealed challenges only). A session that would be
// shorter than a minute is skipped the same way (`skipped_sessions`).
//
// SETTINGS the target kind forbids are REFUSED on a template (a template is
// input, and accept-and-ignore is worse than no control) and FORCED OFF on a
// clone that changes kind, as the PUT's kind change does, each named in
// `forced_settings`.
// ═════════════════════════════════════════════════════════════════════════════

const { eventKind } = require("../lib/event-policy");
const { DEADLINE_MAX_SPAN_MINUTES } = require("../lib/competitions");
const { taskViewDenied, isEventAdmin } = require("../lib/event-admin");
const { unsealedAssignmentDenied, competitorEventsForTask } = require("../lib/staff-compete");
const { QUALIFYING_PREFIX, DEFAULT_QUALIFYING, qualifyingKeyFromTags } = require("../lib/qualifying");
const { copyForNewEvent, removeEventOwnedQuestions } = require("../lib/event-copies");   // a clone or spawn gets fresh copies; an event DELETE takes its own questions

// The template settings are the create form's own fields, so the SAME rules
// validate them (`COMPETITION_FIELD_SCHEMA`, picked rather than retyped). Two
// differences, both stated: the duration may run to the 20-year deadline span
// (a Program's duration is derived from its deadline and an open-ended one is
// ten years long; the 365-day window cap is applied per kind in
// `_blueprintSchedule`), and `leaderboard_mode` / `tags` join, which the create
// route reads outside the schema.
const BLUEPRINT_SETTING_KEYS = Object.freeze([
  "duration_minutes", "reveal_answers_on_end", "self_enroll_enabled",
  "group_leaderboard_enabled", "attempt_cap", "measure_presence", "time_basis", "cxone_disabled",
  "registration_fields", "late_entry_enabled", "staff_compete",
]);
const TEMPLATE_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(BLUEPRINT_SETTING_KEYS.map(k => [k, COMPETITION_FIELD_SCHEMA[k]])),
  duration_minutes: { ...COMPETITION_FIELD_SCHEMA.duration_minutes, max: DEADLINE_MAX_SPAN_MINUTES },
  leaderboard_mode: { type: "enum", values: ["per_slot", "global"], label: "Leaderboard mode" },
  tags: { type: "stringArray", itemMax: 50, label: "Tags" },
});
const TEMPLATE_MAX_TAGS = 20;
const TEMPLATE_MAX_TASKS = 500;
const TEMPLATE_DESCRIPTION_MAX = 1000;
const _TEMPLATE_BODY_SCHEMA = Object.freeze({
  name: { type: "string", required: true, max: 120, label: "Template name" },
  description: { type: "string", allowEmpty: true, max: TEMPLATE_DESCRIPTION_MAX, label: "Description" },
  event_kind: { type: "enum", required: true, values: EVENT_KINDS.map(k => k.value), label: "Event type" },
});
const _TEMPLATE_CREATE_KEYS = new Set(["name", "description", "event_kind", "settings", "task_ids"]);
const _TEMPLATE_BODY_KEYS = new Set([..._TEMPLATE_CREATE_KEYS, "expectedUpdatedAt"]);
const _CLONE_SCHEMA = Object.freeze({
  name: COMPETITION_FIELD_SCHEMA.name,
  start_time: { type: "date", label: "Start time" },
  event_kind: COMPETITION_FIELD_SCHEMA.event_kind,
  kind: { ...COMPETITION_FIELD_SCHEMA.event_kind, label: "Event type" },
  duration_minutes: { type: "int", min: 1, max: DEADLINE_MAX_SPAN_MINUTES, label: "Duration" },
});
const _SPAWN_SCHEMA = Object.freeze({
  name: COMPETITION_FIELD_SCHEMA.name,
  start_time: { type: "date", label: "Start time" },
});
const _SAVE_AS_TEMPLATE_SCHEMA = Object.freeze({
  name: _TEMPLATE_BODY_SCHEMA.name,
  description: _TEMPLATE_BODY_SCHEMA.description,
});

// ONE refusal for a field a body may not carry. Unknown fields are refused, not
// ignored: a caller who sent `trusted_network_ips` to a clone must learn it is
// never copied rather than believe it was.
function _bpUnknownField(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const bad = Object.keys(body).find(k => !allowed.has(k));
  return bad === undefined ? null : bad;
}

function _bpParse(text, fallback) {
  try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; }
  catch (_) { return fallback; }
}

// A template's STORED settings, read without the retired switches
// (`_RETIRED_TEMPLATE_SETTINGS`): tolerant on read, so a template saved before
// "Allow instant join" was retired still spawns, and its next save drops the key.
// A template's INCOMING settings naming one are refused by name
// (`_bpValidateTemplateSettings`).
function _bpStoredSettings(row) {
  const v = _bpParse(row && row.settings, {});
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const out = { ...v };
  for (const k of _RETIRED_TEMPLATE_SETTINGS) delete out[k];
  return out;
}

// The two sign-up sentences, worded as the create route words them.
const _regFieldsRefused = (kind) => `The sign-up form cannot be customised for ${eventKindPhrase({ event_kind: kind })}.`;

// END NOW REWRITES THE SCHEDULE IT CUTS SHORT: a live event's or session's
// duration becomes the time it ran, and a session that had not started is moved
// to the moment of the end with no length at all (the end-now routes here and in
// routes/sessions.js). A clone and a template want the PLAN, never that record,
// so for a row ended by hand the start and duration it had just before its
// latest manual end are replayed from its own history: `created` sets both,
// `edited` changes either, and each `ended_manually` takes a snapshot. A field
// the history does not hold (retention purged it) is left out, and the caller
// keeps the stored value for it.
const _PLAN_HISTORY = Object.freeze({
  competition: { table: "competition_events", col: "competition_id" },
  timeslot: { table: "timeslot_events", col: "timeslot_id" },
});
function _scheduleBeforeManualEnd(scope, id) {
  const h = _PLAN_HISTORY[scope];
  const rows = db.prepare(`SELECT event_type, details FROM ${h.table} WHERE ${h.col}=? AND event_type IN ('created','edited','ended_manually') ORDER BY rowid`).all(id);
  let start, dur, plan = null;
  for (const r of rows) {
    const d = _bpParse(r.details, {});
    if (!d || typeof d !== "object") continue;
    if (r.event_type === "ended_manually") { plan = { start_time: start, duration_minutes: dur }; continue; }
    const src = r.event_type === "created" ? { start_time: d.start_time, duration_minutes: d.duration_minutes }
      : { start_time: d.changes && d.changes.start_time && d.changes.start_time.to, duration_minutes: d.changes && d.changes.duration_minutes && d.changes.duration_minutes.to };
    if (typeof src.start_time === "string" && !isNaN(Date.parse(src.start_time))) start = src.start_time;
    if (Number.isInteger(src.duration_minutes) && src.duration_minutes >= 1) dur = src.duration_minutes;
  }
  return plan;
}
/** The planned schedule of an event or session row: its own values unless it was ended by hand. */
function _plannedSchedule(scope, row) {
  const stored = { start_time: row.start_time, duration_minutes: row.duration_minutes };
  if (!row.ended_manually || !row.ended_at) return stored;
  const plan = _scheduleBeforeManualEnd(scope, row.id) || {};
  return {
    start_time: plan.start_time !== undefined ? plan.start_time : stored.start_time,
    duration_minutes: plan.duration_minutes !== undefined ? plan.duration_minutes : stored.duration_minutes,
  };
}

/**
 * Does copying this event (a clone, a template saved from it) turn its
 * Checkmarx One accounts OFF? Yes when it creates them with its OWN key: a key is
 * never copied, so the copy would otherwise create them in the platform's default
 * tenant (operator ruling, 14 Nov 2026). The one predicate the settings, the
 * clone's `forced_settings` and save-as-template's answer read.
 */
function _bpOwnKeyTurnsAccountsOff(row) {
  return !!row.cxone_api_key && !row.cxone_disabled;
}

/** The SETTINGS of an existing event, in the template-settings shape. */
function _bpSettingsFromRow(row) {
  const kind = eventKind(row);
  const pol = eventPolicy(row);
  const out = {
    // The PLANNED length, never the record End Now leaves (`_plannedSchedule`).
    duration_minutes: _plannedSchedule("competition", row).duration_minutes,
    leaderboard_mode: row.leaderboard_mode === "global" ? "global" : "per_slot",
    reveal_answers_on_end: !!row.reveal_answers_on_end,
    self_enroll_enabled: !!row.self_enroll_enabled,
    group_leaderboard_enabled: !!row.group_leaderboard_enabled,
    cxone_disabled: !!row.cxone_disabled || _bpOwnKeyTurnsAccountsOff(row),
    measure_presence: !!row.measure_presence,
    time_basis: row.time_basis === "presence" ? "presence" : "elapsed",
    staff_compete: !!row.staff_compete,
  };
  if (row.attempt_cap !== null && row.attempt_cap !== undefined) out.attempt_cap = row.attempt_cap;
  if (CONFIGURABLE_KINDS.has(kind)) {
    out.registration_fields = { ...registrationFieldStates(row) };
  }
  if (pol.lateEntry === "allowed") out.late_entry_enabled = !!row.late_entry_enabled;
  return out;
}

/**
 * Resolve blueprint SETTINGS against a target kind into column values.
 *
 * mode "refuse" — a setting the kind forbids is a named 400 (the create
 *                 route's codes and sentences), for a template.
 * mode "force"  — it is turned off and named in `forced`, for a clone whose
 *                 kind changed (the PUT's kind-change posture).
 *
 * An absent setting takes the KIND's create seed, in the `=== undefined` shape
 * the create route uses, so a blueprint that says nothing behaves like the
 * create form saved untouched.
 */
function _bpResolve(settings, kind, mode, { autoEnd } = {}) {
  const pol = eventPolicy(kind);
  const s = { ...settings };
  const forced = [];
  const deny = (key, code, error, fallback) => {
    if (mode === "refuse") return { error, code };
    forced.push(key);
    if (fallback === undefined) delete s[key]; else s[key] = fallback;
    return null;
  };
  let r = null;
  if (s.reveal_answers_on_end && pol.revealAnswers === "forbidden") r = deny("reveal_answers_on_end", "reveal_answers_forbidden", _REVEAL_REFUSED, false);
  if (!r && s.group_leaderboard_enabled && pol.groupLeaderboard === "forbidden") r = deny("group_leaderboard_enabled", "group_leaderboard_forbidden", _GROUP_BOARD_REFUSED, false);
  if (!r && s.measure_presence && pol.measurePresence === "forbidden") r = deny("measure_presence", "measure_presence_forbidden", _presenceRefused({ event_kind: kind }), false);
  if (!r && s.time_basis === "presence" && pol.measurePresence === "forbidden") r = deny("time_basis", "time_basis_forbidden", _timeBasisRefused({ event_kind: kind }), "elapsed");
  if (!r && s.registration_fields !== undefined && !CONFIGURABLE_KINDS.has(kind)) r = deny("registration_fields", "registration_fields_forbidden", _regFieldsRefused(kind));
  if (!r && s.late_entry_enabled !== undefined && pol.lateEntry !== "allowed") r = deny("late_entry_enabled", "late_entry_forbidden", lateEntryForbiddenMessage({ event_kind: kind }));
  // Accounts ON for a kind that never creates them: refused for a template; for
  // a clone changing kind, turned off and named `cxone_provisioning` (apart
  // from the own-key reason, which names `cxone_disabled`).
  if (!r && s.cxone_disabled === false && pol.cxoneProvisioning !== "allowed") {
    if (mode === "refuse") r = { error: _cxoneRefused({ event_kind: kind }), code: "cxone_provisioning_forbidden" };
    else { s.cxone_disabled = true; forced.push("cxone_provisioning"); }
  }
  if (r) return r;
  const b = (v, seed) => (v === undefined ? (seed ? 1 : 0) : (v ? 1 : 0));
  const defaults = registrationFieldDefaultsForKind(kind);
  // The all-solved auto-end has no form control: a clone of the same kind keeps
  // the source's value, anything else takes the kind's seed, and a kind that
  // PROHIBITS the rule stores 0 whatever was carried (the gate reads the
  // prohibition anyway; the column agrees with it).
  let autoEndCol = autoEnd === undefined || autoEnd === null ? pol.autoEndOnAllSolvedDefault : (autoEnd ? 1 : 0);
  if (pol.autoEndOnAllSolved === "never") autoEndCol = 0;
  return {
    forced,
    values: {
      duration_minutes: s.duration_minutes,
      leaderboard_mode: s.leaderboard_mode === "global" ? "global" : "per_slot",
      reveal_answers_on_end: b(s.reveal_answers_on_end, 0),
      self_enroll_enabled: b(s.self_enroll_enabled, pol.selfEnrollDefault),
      group_leaderboard_enabled: b(s.group_leaderboard_enabled, 0),
      cxone_disabled: pol.cxoneProvisioning !== "allowed" ? 1 : b(s.cxone_disabled, pol.cxoneDisabledDefault),
      measure_presence: b(s.measure_presence, 0),
      time_basis: s.time_basis === "presence" ? "presence" : "elapsed",
      attempt_cap: s.attempt_cap === undefined ? null : s.attempt_cap,
      registration_field_policy: s.registration_fields === undefined
        ? null
        : serialiseRegistrationFieldPolicy({ ...defaults, ...s.registration_fields }, defaults),
      late_entry_enabled: b(s.late_entry_enabled, lateEntryDefaultForKind(kind)),
      staff_compete: b(s.staff_compete, 0),
      auto_end_on_all_solved: autoEndCol,
    },
  };
}

/**
 * The schedule of a blueprint at a new start. A window kind takes the duration
 * (365-day request cap); a deadline kind's deadline is the start plus the
 * duration, through `scheduledEnd` (the one start + duration), and its stored
 * duration is then derived from that deadline by `resolveSchedule`, exactly as
 * the create route derives it.
 */
function _bpSchedule(kind, startDate, durationMinutes) {
  const sched = eventPolicy(kind).schedule;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    return { error: "A duration is required.", code: "duration_required" };
  }
  if (sched === "deadline") {
    const dl = scheduledEnd({ start_time: startDate.toISOString(), duration_minutes: durationMinutes });
    return resolveSchedule(sched, startDate, undefined, dl.toISOString());
  }
  if (durationMinutes > COMPETITION_FIELD_SCHEMA.duration_minutes.max) {
    return {
      error: `${eventKindPhrase({ event_kind: kind })} runs for at most ${COMPETITION_FIELD_SCHEMA.duration_minutes.max} minutes. Send duration_minutes for the copy.`,
      code: "duration_too_long",
    };
  }
  return resolveSchedule(sched, startDate, durationMinutes, null);
}

/** Validate a template's settings object for a kind. `{ values }` or `{ error, code }`. */
function _bpValidateTemplateSettings(raw, kind) {
  const settingsIn = raw === undefined || raw === null ? {} : raw;
  if (typeof settingsIn !== "object" || Array.isArray(settingsIn)) {
    return { error: "Template settings must be an object.", code: "template_settings_invalid" };
  }
  if (Object.prototype.hasOwnProperty.call(settingsIn, "self_enroll_allow_instant")) {
    return { ..._SELF_ENROLL_INSTANT_REMOVED, setting: "self_enroll_allow_instant" };
  }
  const unknown = Object.keys(settingsIn).find(k => !Object.prototype.hasOwnProperty.call(TEMPLATE_SETTINGS_SCHEMA, k));
  if (unknown !== undefined) {
    return {
      error: `Template settings has an unknown entry: ${String(unknown).slice(0, 60)}. A template carries event settings only — never a name, a start time, a deadline, trusted network IPs or a join link.`,
      code: "template_setting_unknown", setting: String(unknown).slice(0, 60),
    };
  }
  const copy = { ...settingsIn };
  _normaliseCapInput(copy);
  const v = validateBody(copy, TEMPLATE_SETTINGS_SCHEMA);
  if (v.error) return { error: v.error, code: "template_settings_invalid", setting: v.field };
  if (v.values.duration_minutes === undefined) {
    return { error: "Template settings must include duration_minutes.", code: "duration_required", setting: "duration_minutes" };
  }
  if ((v.values.tags || []).length > TEMPLATE_MAX_TAGS) {
    return { error: `A template carries at most ${TEMPLATE_MAX_TAGS} tags.`, code: "template_settings_invalid", setting: "tags" };
  }
  const r = _bpResolve(v.values, kind, "refuse");
  if (r.error) return { ...r, setting: undefined };
  const sch = _bpSchedule(kind, new Date(now().getTime() + 86_400_000), v.values.duration_minutes);
  if (sch.error) return sch;
  if (v.values.tags) v.values.tags = [...new Set(v.values.tags.map(t => t.toLowerCase()))];
  return { values: v.values };
}

/** Is this a qualifying challenge? Any `qualifying:` tag, the test `qualifyingSql` makes. */
function _bpIsQualifying(tags) {
  return (tags || []).some(t => typeof t === "string" && t.trim().toLowerCase().startsWith(QUALIFYING_PREFIX));
}

/**
 * Why a challenge cannot join a new event, or null. One reason per challenge.
 * VISIBILITY IS ASKED FIRST: a challenge the actor may not view is reported as
 * that and nothing else (not whether it is a draft or locked), and callers send
 * no id or title with it — the template read withholds both.
 */
function _bpTaskSkip(req, task, compStub, tags) {
  if (!task) return { reason: "missing" };
  if (taskViewDenied(req, task, tags)) return { reason: "not_visible" };
  // Operator ruling, 23 Nov 2026 (sweep #63), extending 14 Nov's: a competitor
  // may neither clone the event they compete in nor save it as a template, nor
  // carry its challenges into a template or into an event they make. A challenge
  // held by any event the actor (the seat AND the hand) competes in is refused
  // when a template is saved and left out of a spawn or a clone, by name. The
  // event is named only to an actor who may see it. Asked after `not_visible`,
  // so a challenge the actor cannot see is still reported with no title. The
  // assign doors are unchanged (a deliberate position the ruling leaves alone).
  {
    const _cev = competitorEventsForTask(db, competitorIds(req), task.id);
    if (_cev.length) {
      const named = _cev.find(e => !competitionDenied(req, e.id));
      // `message` is the template save's refusal; `note` the words a spawn's or a
      // clone's skipped entry carries, read inside the toast's brackets.
      return { reason: "competing", message: named
        ? `You are competing in “${named.name}”, which holds “${task.title}”, so it cannot be carried into a template or an event you make.`
        : `You are competing in an event that holds “${task.title}”, so it cannot be carried into a template or an event you make.`,
        note: named ? `you compete in “${named.name}”, which holds it` : "you compete in an event that holds it" };
    }
  }
  // A qualifying question is a PER-EVENT copy (lib/qualifying.js): one row
  // shared by two events ties both lead reports to one set of options, and a
  // spawn seeding its own beside it doubled them. A new event gets its own
  // through "Add the qualifying questions" (`addQualifying` below).
  if (_bpIsQualifying(tags)) return { reason: "qualifying" };
  if (task.status !== "published") return { reason: "not_published" };
  if (task.locked && !req.session.isSuperAdmin) return { reason: "locked" };
  const fit = challengeFitError(task, compStub, tags);
  if (fit) return { reason: "unfit", message: fit.message };
  const seal = unsealedAssignmentDenied(task, compStub);
  if (seal) return { reason: "unsealed", message: seal.message };
  return null;
}

/** Validate a template's challenge list for a kind and settings at save time. */
function _bpValidateTemplateTasks(req, raw, kind, settings) {
  if (raw === undefined || raw === null) return { ids: [] };
  if (!Array.isArray(raw) || raw.some(x => typeof x !== "string")) {
    return { error: "task_ids must be an array of challenge ids.", code: "template_tasks_invalid" };
  }
  const ids = [...new Set(raw.map(x => x.trim()).filter(Boolean))];
  if (ids.length > TEMPLATE_MAX_TASKS) return { error: `A template holds at most ${TEMPLATE_MAX_TASKS} challenges.`, code: "template_tasks_invalid" };
  if (!ids.length) return { ids };
  const rows = db.prepare(`SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed FROM tasks WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  const byId = new Map(rows.map(t => [t.id, t]));
  const stub = { id: "", name: "this template", event_kind: kind, staff_compete: settings.staff_compete ? 1 : 0 };
  for (const id of ids) {
    const t = byId.get(id);
    const tags = t ? db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(id).map(x => x.tag) : [];
    const skip = _bpTaskSkip(req, t, stub, tags);
    if (skip && skip.reason !== "locked") {
      return {
        error: skip.reason === "qualifying"
          ? `“${t.title}” is a qualifying question, which belongs to its own event. Remove it: an event made from this template gets its own through Add the qualifying questions.`
          : skip.message || (skip.reason === "missing" ? `No challenge has the id ${id.slice(0, 64)}.` : `“${t.title}” cannot be part of this template (${skip.reason}).`),
        code: "template_task_" + skip.reason, task_id: id.slice(0, 64),
        // A competitor's refusal is a 403, as every competitor refusal is.
        ...(skip.reason === "competing" ? { status: 403 } : {}),
      };
    }
  }
  return { ids };
}

function _bpDefaultStart() {
  const d = new Date(now().getTime() + 86_400_000);
  d.setUTCSeconds(0, 0);
  return d;
}

/**
 * THE ONE WRITER of a cloned or spawned event. Synchronous from the first read
 * to the commit (no await), so every check below is read in the tick that
 * writes. Returns `{ status, body }`.
 */
function _materialiseEvent(req, spec) {
  const { name, startDate, kind, settings, mode, autoEnd, tags, taskIds, slots, latePinOffsetMs, cxoneGroupName, provenance, forcedIn, addQualifying } = spec;
  if (startDate.getTime() <= now().getTime()) {
    return { status: 400, body: { error: "A new event must start in the future, so it opens upcoming.", code: "start_time_not_future" } };
  }
  const res0 = _bpResolve(settings, kind, mode, { autoEnd });
  if (res0.error) return { status: 400, body: { error: res0.error, code: res0.code } };
  const forced = [...(forcedIn || []), ...res0.forced];
  const cols = res0.values;
  // "Add the qualifying questions": the spawn passes the form's tick, a clone
  // passes true when its source had qualifying questions. The create route's
  // rule: an event where staff compete holds sealed challenges only, and a
  // qualifying question can never be sealed, so the questions are refused there.
  if (addQualifying === true && cols.staff_compete) {
    return { status: 400, body: { error: require("../lib/qualifying").QUALIFYING_IN_COMPETE_EVENT_ERROR, code: "qualifying_in_compete_event" } };
  }
  let qualifyingIds = [];
  const sch = _bpSchedule(kind, startDate, cols.duration_minutes);
  if (sch.error) return { status: 400, body: { error: sch.error, code: sch.code } };
  const startIso = startDate.toISOString();
  const newEnd = scheduledEnd({ start_time: startIso, duration_minutes: sch.durationMinutes });
  // A pinned late-entry deadline keeps its distance from the end. If that
  // distance no longer fits the window rules at the new end, the copy follows
  // the end instead and says so.
  let lateDeadlineIso = null;
  if (latePinOffsetMs !== null && latePinOffsetMs !== undefined && eventPolicy(kind).lateEntry === "allowed") {
    const pin = new Date(newEnd.getTime() + latePinOffsetMs);
    if (_validateLateDeadline(pin.toISOString(), newEnd)) forced.push("late_entry_deadline_at");
    else lateDeadlineIso = pin.toISOString();
  }
  // Sessions only where the kind has them, and only ones the session routes
  // would accept: at least a minute long (routes/sessions.js `min: 1`) and
  // starting no earlier than the new event. A session End Now cut before it
  // began has no length, and when its history no longer holds the plan
  // (`_plannedSchedule`) it is left out and named rather than created ended.
  const slotList = Array.isArray(slots) ? slots : [];
  const kindSlots = eventPolicy(kind).sessions === "many" ? slotList : [];
  if (slotList.length && !kindSlots.length) forced.push("sessions");
  const skippedSessions = [];
  const keepSlots = kindSlots.filter(s => {
    if (!Number.isInteger(s.duration_minutes) || s.duration_minutes < 1) { skippedSessions.push({ name: s.name, reason: "ended_before_start" }); return false; }
    if (!Number.isFinite(s.offsetMs) || s.offsetMs < 0) { skippedSessions.push({ name: s.name, reason: "starts_before_event" }); return false; }
    return true;
  });
  if (db.prepare("SELECT 1 FROM competitions WHERE LOWER(name)=LOWER(?)").get(name)) {
    return { status: 409, body: { error: "An event with this name already exists. Please choose a different name.", code: "name_taken" } };
  }

  const id = uuid();
  const actor = getAdminIdentity(req);
  const actingId = actorId(req);
  const grantOrganiser = isEventAdmin(req) && !!actingId;
  const assigned = [];
  const skipped = [];
  let appliedTags = [];
  const createdAt = now().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      "INSERT INTO competitions (id, name, event_kind, start_time, duration_minutes, deadline_at, auto_end_on_all_solved, leaderboard_mode, " +
      "reveal_answers_on_end, self_enroll_enabled, measure_presence, time_basis, group_leaderboard_enabled, " +
      "cxone_disabled, cxone_group_name, attempt_cap, trusted_network_ips, registration_field_policy, " +
      "late_entry_enabled, late_entry_deadline_at, staff_compete, self_enroll_token, join_code, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)"
    ).run(id, name, kind, startIso, sch.durationMinutes, sch.deadlineIso, cols.auto_end_on_all_solved, cols.leaderboard_mode,
      cols.reveal_answers_on_end, cols.self_enroll_enabled, cols.measure_presence, cols.time_basis,
      cols.group_leaderboard_enabled, cols.cxone_disabled, cxoneGroupName || null, cols.attempt_cap, cols.registration_field_policy,
      cols.late_entry_enabled, lateDeadlineIso, cols.staff_compete,
      _genSelfEnrollToken(), _genJoinCode(), createdAt, createdAt);
    if (addQualifying === true) {
      qualifyingIds = require("../lib/qualifying").seedQualifyingChallenges(db, id, { actorEmail: actor, actorUserId: actingId, nowIso: createdAt });
    }
    const insTag = db.prepare("INSERT OR IGNORE INTO competition_tags (competition_id, tag) VALUES (?,?)");
    for (const t of tags || []) {
      if (typeof t === "string" && t.trim() && t.trim().length <= 50) insTag.run(id, t.trim().toLowerCase());
    }
    appliedTags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=? ORDER BY tag").all(id).map(r => r.tag);
    recordCompetitionEvent(id, "created", actor, {
      via: provenance.via, ...provenance.details,
      name, event_kind: kind, start_time: startIso, duration_minutes: sch.durationMinutes, deadline_at: sch.deadlineIso,
      auto_end_on_all_solved: cols.auto_end_on_all_solved, leaderboard_mode: cols.leaderboard_mode,
      reveal_answers_on_end: !!cols.reveal_answers_on_end, group_leaderboard_enabled: !!cols.group_leaderboard_enabled,
      cxone_disabled: !!cols.cxone_disabled, self_enroll_enabled: !!cols.self_enroll_enabled,
      measure_presence: !!cols.measure_presence,
      time_basis: cols.time_basis, attempt_cap: cols.attempt_cap, tags: appliedTags,
      registration_fields: { ...registrationFieldStates({ event_kind: kind, registration_field_policy: cols.registration_field_policy }) },
      late_entry_enabled: !!cols.late_entry_enabled,
      late_entry_deadline_at: lateDeadlineIso, staff_compete: !!cols.staff_compete,
      ...(forced.length ? { forced_settings: forced } : {}),
      ...(skippedSessions.length ? { skipped_sessions: skippedSessions } : {}),
      ...(qualifyingIds.length ? { qualifying_questions: qualifyingIds.length } : {}),
      ...reqContext(req),
    });
    // Sessions, re-based: the same offset from the start, the same length.
    for (const s of keepSlots) {
      const tsId = uuid();
      const tsStart = new Date(startDate.getTime() + s.offsetMs).toISOString();
      db.prepare("INSERT INTO competition_timeslots (id, competition_id, name, start_time, duration_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(tsId, id, s.name, tsStart, s.duration_minutes, createdAt, createdAt);
      recordTimeslotEvent(tsId, "created", actor, { name: s.name, start_time: tsStart, duration_minutes: s.duration_minutes, via: provenance.via, ...reqContext(req) });
      recordCompetitionEvent(id, "timeslot_added", actor, { timeslot_id: tsId, name: s.name, via: provenance.via, ...reqContext(req) });
    }
    // Challenges. Read INSIDE the transaction, so a challenge unpublished or
    // locked a moment ago is judged as it is now.
    const ids = [...new Set((taskIds || []).filter(x => typeof x === "string" && x))];
    if (ids.length) {
      const rows = db.prepare(`SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed FROM tasks WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
      const byId = new Map(rows.map(t => [t.id, t]));
      const stub = { id, name, event_kind: kind, staff_compete: cols.staff_compete };
      const ins = db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at, assigned_by_id) VALUES (?,?,?,?,?)");
      // The built-in keys this event just got fresh copies of: another event's
      // copy of one of those is replaced, not missing, so it is not reported.
      const seededKeys = new Set(qualifyingIds.length ? DEFAULT_QUALIFYING.map(q => q.key) : []);
      for (const tid of ids) {
        const t = byId.get(tid);
        const tags = t ? db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(tid).map(x => x.tag) : [];
        const skip = _bpTaskSkip(req, t, stub, tags);
        if (skip && skip.reason === "qualifying" && seededKeys.has(qualifyingKeyFromTags(tags))) continue;
        // A challenge the actor may not view is counted, never named: no id, no
        // title (the template read withholds both from them).
        if (skip && skip.reason === "not_visible") { skipped.push({ reason: skip.reason }); continue; }
        if (skip) { const _why = skip.note || skip.message; skipped.push({ task_id: tid, title: t ? t.title : null, reason: skip.reason, ...(_why ? { message: _why } : {}) }); continue; }
        // The new event's OWN question: a fresh copy of the source's (a bank
        // question, or the source event's own as edited there), never shared.
        const eid = copyForNewEvent(db, tid, id, { changedBy: actor, via: provenance.via, nowIso: createdAt });
        if (ins.run(id, eid, actor, createdAt, actingId).changes > 0) {
          assigned.push(eid);
          recordCompetitionEvent(id, "task_added", actor, { task_id: eid, task_title: t.title, via: provenance.via, ...(eid !== tid ? { copied_from: tid } : {}), ...reqContext(req) });
        }
      }
    }
    if (grantOrganiser) {
      db.prepare("INSERT OR IGNORE INTO competition_admins (competition_id, user_id, granted_by, granted_at) VALUES (?,?,?,?)")
        .run(id, actingId, actor, createdAt);
      const g = { competition_id: id, competition_name: name, user_id: actingId, via: provenance.via, role_changed: false, ...reqContext(req) };
      recordUserEvent(actingId, "event_admin_granted", actor, g);
      recordCompetitionEvent(id, "event_admin_granted", actor, g);
    }
  });
  runTxnWithMirrorBuffer(() => txn());
  // The built-in qualifying challenges get their creation version (History,
  // Restore), as on the create route.
  for (const _qid of qualifyingIds) {
    try { require("../lib/audit").createTaskVersion(_qid, actor, "create", null, { via: "qualifying_default", competition_id: id, ...reqContext(req) }); }
    catch (e) { swallowed("competitions:spawn-qualifying-version", e); }
  }
  // POST-COMMIT, by id. The new event has no members, board or cached row yet;
  // only the organiser grant changes what a cache reports (the actor's scope,
  // their /api/me, the participants Role cell).
  if (grantOrganiser) {
    invalidateEventAdminScope(actingId);
    _invalidateMeCache(actingId);
    invalidateAdminParticipantsCache();
  }
  const comp = getCompetition(id);
  return {
    status: 200,
    body: {
      ok: true,
      competition: { ..._compWire(comp, { isSuperAdmin: !!req.session.isSuperAdmin, actorId: competitorIds(req) }), tags: appliedTags, status: competitionStatus(comp), effective_end: competitionEffectiveEnd(comp)?.toISOString() || null },
      assigned_challenges: assigned.length,
      skipped_challenges: skipped,
      sessions_copied: keepSlots.length,
      skipped_sessions: skippedSessions,
      forced_settings: forced,
      granted_organiser: grantOrganiser,
      qualifying_questions: qualifyingIds.length,
    },
  };
}

/** A template row for the wire. Challenge ids the actor may not view are withheld and counted. */
/**
 * v8.17.0 — why a template may not be deleted, or null when it may. The ONE
 * predicate: the DELETE route refuses with it and the wire's `can_delete` reads
 * it. A built-in can never be deleted (it has Reset to default instead); a
 * protected template cannot be deleted by anyone until a global admin
 * unprotects it.
 */
function _tplProtection(row) {
  if (row.is_builtin) return { code: "template_protected", error: "A built-in template cannot be deleted. Use Reset to default to undo changes to it." };
  if (row.protected) return { code: "template_protected", error: "This template is protected. A global admin must unprotect it before it can be deleted." };
  return null;
}

/** The 409 body when `name` is taken by another template (deleted ones included), else null. */
function _tplNameClash(name, exceptId) {
  const hit = db.prepare("SELECT id, deleted_at FROM event_templates WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, exceptId || "");
  if (!hit) return null;
  return hit.deleted_at
    ? { error: "A recently deleted template has this name. Restore it from Recently deleted, or choose a different name.", code: "name_taken" }
    : { error: "A template with this name already exists. Please choose a different name.", code: "name_taken" };
}

/** A live (not deleted) template row, or undefined. */
function _liveTemplate(id) {
  return db.prepare("SELECT * FROM event_templates WHERE id=? AND deleted_at IS NULL").get(id);
}

function _templateWire(req, row, { withTasks = false } = {}) {
  const ids = _bpParse(row.task_ids, []);
  const list = Array.isArray(ids) ? ids.filter(x => typeof x === "string") : [];
  const rows = list.length
    ? db.prepare(`SELECT id, title, difficulty, answer_type, status, created_by_id FROM tasks WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list))
    : [];
  const byId = new Map(rows.map(t => [t.id, t]));
  const visible = [];
  let withheld = 0, missing = 0;
  for (const tid of list) {
    const t = byId.get(tid);
    if (!t) { missing++; continue; }
    if (taskViewDenied(req, t)) { withheld++; continue; }
    visible.push(t);
  }
  const settings = _bpStoredSettings(row);
  const prot = _tplProtection(row);
  return {
    id: row.id, name: row.name, description: row.description || "", event_kind: row.event_kind,
    settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {},
    task_ids: visible.map(t => t.id), task_count: visible.length,
    withheld_task_count: withheld, missing_task_count: missing,
    is_builtin: !!row.is_builtin, created_at: row.created_at, updated_at: row.updated_at,
    // v8.17.0 — protection. `can_delete` and `delete_refused` come from the SAME
    // predicate the DELETE route refuses with, so the menu never offers a delete
    // the server would answer 409.
    builtin_key: row.builtin_key || null, protected: !!row.protected,
    can_delete: !prot, delete_refused: prot ? prot.error : null,
    deleted_at: row.deleted_at || null,
    ...(row.deleted_at ? { purge_at: new Date(Date.parse(row.deleted_at) + TEMPLATE_RESTORE_DAYS * 86400e3).toISOString() } : {}),
    ...(withTasks ? { tasks: visible.map(t => ({ id: t.id, title: t.title, difficulty: t.difficulty, answer_type: t.answer_type, status: t.status })) } : {}),
  };
}

function _registerBlueprintRoutes(app) {

// ── Clone event ──────────────────────────────────────────────────────────────
app.post("/api/admin/competitions/:id/clone", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const src = getCompetition(req.params.id);
  if (!src) return res.status(404).json({ error: "Event not found" });
  // A competitor may not copy the event they compete in — the copy carries its
  // challenge set into an event they would organise.
  { const _cmp = _competitorRefused(req, res, src.id); if (_cmp) return _cmp; }
  const denied = competitionDenied(req, src.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  const unknown = _bpUnknownField(req.body, new Set(Object.keys(_CLONE_SCHEMA)));
  if (unknown !== null) return res.status(400).json({ error: `A clone takes a name, a start time, an event type and a duration only; “${String(unknown).slice(0, 60)}” is not one of them.`, code: "unknown_field", field: String(unknown).slice(0, 60) });
  const _v = validateBody(req.body, _CLONE_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  if (_v.values.event_kind && _v.values.kind && _v.values.event_kind !== _v.values.kind) {
    return res.status(400).json({ error: "Send the event type once, as event_kind.", code: "kind_conflict" });
  }
  const srcKind = eventKind(src);
  const kind = _v.values.event_kind || _v.values.kind || srcKind;
  const settings = _bpSettingsFromRow(src);
  if (_v.values.duration_minutes !== undefined) settings.duration_minutes = _v.values.duration_minutes;
  // Sessions as PLANNED (`_plannedSchedule`), spaced as they were, the first one
  // at the new start. The offsets are measured from the earliest session, never
  // from the event row's own start: no session route writes that column, so on a
  // multi-session event it is the create-time value and can lie before or after
  // every session (a negative offset made a copy that was already live or ended).
  const planned = getCompetitionTimeslots(src.id).map(ts => ({ name: ts.name, ..._plannedSchedule("timeslot", ts) }));
  const firstStart = planned.length ? Math.min(...planned.map(s => Date.parse(s.start_time))) : Date.parse(src.start_time);
  const slots = planned.map(s => ({
    name: s.name, duration_minutes: s.duration_minutes,
    offsetMs: Date.parse(s.start_time) - firstStart,
  }));
  // A pinned late-entry deadline keeps its distance from the PLANNED end, the
  // end the copied length gives: End Now leaves the pin where it was and cuts
  // the stored end short, so measured from that end the copy's window would
  // run long by whatever End Now cut off.
  const srcEnd = scheduledEnd({ ...src, ..._plannedSchedule("competition", src) });
  // A pin "Close late entries now" wrote is when the window was CLOSED, not the
  // window anyone planned: carried as a distance from the end, it would give the
  // copy a window as short as the gap between that end and the press. The copy
  // follows its own end instead, and the clone names what it left behind.
  const _pinFromClose = !!src.late_entry_deadline_at && (() => {
    const ev = db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='late_entry_closed' ORDER BY changed_at DESC, rowid DESC LIMIT 1").get(src.id);
    try { return !!ev && JSON.parse(ev.details || "{}").to === src.late_entry_deadline_at; } catch (_) { return false; }
  })();
  const latePinOffsetMs = src.late_entry_deadline_at && !_pinFromClose ? Date.parse(src.late_entry_deadline_at) - srcEnd.getTime() : null;
  const forcedIn = [];
  // Named only where the copy takes late entries at all (the kind allows them and
  // the source had them on), or the note would promise a window the copy lacks.
  if (_pinFromClose && eventPolicy(kind).lateEntry === "allowed" && settings.late_entry_enabled) forcedIn.push("late_entry_closed");
  // The settings already carry it (`_bpSettingsFromRow`); this names it.
  if (_bpOwnKeyTurnsAccountsOff(src)) forcedIn.push("cxone_disabled");
  if (src.cxone_api_key && src.cxone_group_name) forcedIn.push("cxone_group_name");
  if (src.trusted_network_ips) forcedIn.push("trusted_network_ips");
  const taskIds = db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=? ORDER BY assigned_at, rowid").all(src.id).map(r => r.task_id);
  const tags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(src.id).map(r => r.tag);
  // The source's qualifying questions are its own (`_bpTaskSkip`); the copy gets
  // fresh built-in ones of its own when the source held a BUILT-IN one, as "Add
  // the qualifying questions" gives a new event: every built-in one
  // (DEFAULT_QUALIFYING), in its default wording, however many the source held
  // and however it reworded them. A question an organiser wrote (any other key)
  // is not one of those: a source holding only such questions gets no built-in
  // ones, which it never had, and its own are named as left out. Not where staff
  // compete: that event holds sealed challenges only, so the built-in ones are
  // refused there. This rule is the operator's ruling of 14 Nov 2026 (copying
  // only the built-in keys the source held, or every question as new rows, was
  // declined). A key is read by lib/qualifying.js's parser, the one
  // `_materialiseEvent` and the team report use, never by matching the tag text.
  const _builtinKeys = new Set(DEFAULT_QUALIFYING.map(q => q.key));
  const srcHasBuiltinQualifying = db.prepare("SELECT qtg.tag FROM competition_tasks ct JOIN task_tags qtg ON qtg.task_id=ct.task_id WHERE ct.competition_id=? AND qtg.tag LIKE ?")
    .all(src.id, `${QUALIFYING_PREFIX}%`).some(r => _builtinKeys.has(qualifyingKeyFromTags([r.tag])));
  const out = _materialiseEvent(req, {
    name: _v.values.name,
    startDate: _v.values.start_time ? new Date(_v.values.start_time) : _bpDefaultStart(),
    kind, settings, mode: "force",
    autoEnd: kind === srcKind ? src.auto_end_on_all_solved : undefined,
    tags, taskIds, slots, latePinOffsetMs,
    cxoneGroupName: src.cxone_api_key ? null : src.cxone_group_name,
    forcedIn,
    addQualifying: srcHasBuiltinQualifying && !settings.staff_compete ? true : undefined,
    provenance: { via: "clone", details: { cloned_from: src.id, cloned_from_name: src.name } },
  });
  res.status(out.status).json(out.body);
});

// ── Save an event as a template ──────────────────────────────────────────────
app.post("/api/admin/competitions/:id/save-as-template", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const src = getCompetition(req.params.id);
  if (!src) return res.status(404).json({ error: "Event not found" });
  // Refused to a competitor exactly as a clone is (operator ruling, 14 Nov
  // 2026): an event spawned from the template carries this event's challenge
  // set into an event they would organise, the end a clone reaches.
  { const _cmp = _competitorRefused(req, res, src.id); if (_cmp) return _cmp; }
  const unknown = _bpUnknownField(req.body, new Set(Object.keys(_SAVE_AS_TEMPLATE_SCHEMA)));
  if (unknown !== null) return res.status(400).json({ error: `Saving as a template takes a name and a description only; “${String(unknown).slice(0, 60)}” is not one of them.`, code: "unknown_field", field: String(unknown).slice(0, 60) });
  const _v = validateBody(req.body, _SAVE_AS_TEMPLATE_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  const kind = eventKind(src);
  const settings = _bpSettingsFromRow(src);
  settings.tags = db.prepare("SELECT tag FROM competition_tags WHERE competition_id=? ORDER BY tag").all(src.id).map(r => r.tag).slice(0, TEMPLATE_MAX_TAGS);
  // The source's settings went through the same rules; re-validating catches a
  // row an older release or a hand edit left out of step.
  const sv = _bpValidateTemplateSettings(settings, kind);
  if (sv.error) return res.status(409).json({ error: `This event's settings cannot be saved as a template: ${sv.error}`, code: "template_source_invalid" });
  // Every assigned challenge that could be assigned again (published, fits).
  const taskIds = db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=? ORDER BY assigned_at, rowid").all(src.id).map(r => r.task_id);
  const keep = [];
  const stub = { id: "", name: _v.values.name, event_kind: kind, staff_compete: settings.staff_compete ? 1 : 0 };
  const left = [];
  for (const eid of taskIds.slice(0, TEMPLATE_MAX_TASKS)) {
    // The event's own question is judged; the template names the BANK question it
    // was copied from where that is still in the bank (a template names library
    // questions, lib/event-copies.js), else the event's question itself.
    const t = db.prepare("SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed, owner_competition_id, copied_from_task_id FROM tasks WHERE id=?").get(eid);
    const tid = (t && t.copied_from_task_id && db.prepare("SELECT 1 FROM tasks WHERE id=? AND owner_competition_id IS NULL").get(t.copied_from_task_id)) ? t.copied_from_task_id : eid;
    const tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(eid).map(x => x.tag);
    const skip = _bpTaskSkip(req, t, stub, tags);
    // A challenge of an event the saver competes in is refused, not left out:
    // the template would carry what the 23 Nov ruling keeps away from them.
    if (skip && skip.reason === "competing") return res.status(403).json({ error: skip.message, code: "template_task_competing", task_id: tid });
    if (skip && skip.reason !== "locked") { left.push({ task_id: tid, title: t ? t.title : null, reason: skip.reason }); continue; }
    if (!keep.includes(tid)) keep.push(tid);
  }
  { const clash = _tplNameClash(_v.values.name); if (clash) return res.status(409).json(clash); }
  // What the template does differently from its source, as a clone names it: a
  // source creating accounts with its own key gives a template with accounts off.
  const forced = _bpOwnKeyTurnsAccountsOff(src) ? ["cxone_disabled"] : [];
  const id = uuid();
  const at = now().toISOString();
  db.prepare("INSERT INTO event_templates (id, name, description, event_kind, settings, task_ids, created_by_id, created_at, updated_at, is_builtin) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(id, _v.values.name, _v.values.description || "", kind, JSON.stringify(sv.values), JSON.stringify(keep), actorId(req), at, at);
  recordOrphanedAuditEvent("event_template", id, "created", getAdminIdentity(req), {
    name: _v.values.name, event_kind: kind, from_competition_id: src.id, from_competition_name: src.name,
    task_count: keep.length, challenges_left_out: left.length,
    ...(forced.length ? { forced_settings: forced } : {}), ...reqContext(req),
  });
  const row = db.prepare("SELECT * FROM event_templates WHERE id=?").get(id);
  res.json({ ok: true, template: _templateWire(req, row), skipped_challenges: left, forced_settings: forced });
});

// ── Templates: list / read ───────────────────────────────────────────────────
app.get("/api/admin/event-templates", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM event_templates WHERE deleted_at IS NULL ORDER BY is_builtin DESC, name COLLATE NOCASE, id").all();
  res.json({ templates: rows.map(r => _templateWire(req, r)) });
});

// v8.17.0 — "Recently deleted": soft-deleted templates still restorable. Global
// admins only (held twice). Registered ABOVE `/:id` so "deleted" is never read
// as a template id.
app.get("/api/admin/event-templates/deleted", requireAdmin, requireGlobalAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM event_templates WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id").all();
  const missing = BUILTIN_TEMPLATES.filter(b => !db.prepare("SELECT 1 FROM event_templates WHERE builtin_key=?").get(b.key)).map(b => b.name);
  res.json({ templates: rows.map(r => _templateWire(req, r)), missing_builtins: missing, restore_days: TEMPLATE_RESTORE_DAYS });
});

// v8.17.0 — recreate every built-in template that no longer exists (one deleted
// before built-ins were protected). A name an administrator's template took
// meanwhile gets " (built-in)" appended rather than failing.
app.post("/api/admin/event-templates/restore-builtins", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const restored = [];
  const at = now().toISOString();
  db.transaction(() => {
    for (const b of BUILTIN_TEMPLATES) {
      if (db.prepare("SELECT 1 FROM event_templates WHERE builtin_key=?").get(b.key)) continue;
      let name = b.name;
      if (db.prepare("SELECT 1 FROM event_templates WHERE name = ? COLLATE NOCASE").get(name)) name = `${b.name} (built-in)`.slice(0, 120);
      if (db.prepare("SELECT 1 FROM event_templates WHERE name = ? COLLATE NOCASE").get(name)) continue;
      const id = uuid();
      db.prepare("INSERT INTO event_templates (id, name, description, event_kind, settings, task_ids, created_by_id, created_at, updated_at, is_builtin, builtin_key) VALUES (?,?,?,?,?,'[]',NULL,?,?,1,?)")
        .run(id, name, b.description, b.kind, JSON.stringify(b.settings), at, at, b.key);
      restored.push({ id, name, builtin_key: b.key });
    }
  }).immediate();
  // Audited after the commit, one orphaned event per row created.
  for (const r of restored) {
    recordOrphanedAuditEvent("event_template", r.id, "builtin_restored", getAdminIdentity(req), { name: r.name, builtin_key: r.builtin_key, ...reqContext(req) });
  }
  res.json({ ok: true, restored });
});

app.get("/api/admin/event-templates/:id", requireAdmin, (req, res) => {
  const row = _liveTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found" });
  res.json({ template: _templateWire(req, row, { withTasks: true }) });
});

// ── Templates: create / edit / delete (global admins) ────────────────────────
app.post("/api/admin/event-templates", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const unknown = _bpUnknownField(req.body, _TEMPLATE_CREATE_KEYS);
  if (unknown !== null) {
    const f = String(unknown).slice(0, 60);
    return res.status(400).json({ error: `A template takes a name, a description, an event type, settings and task_ids; “${f}” is not one of them.`, code: "unknown_field", field: f });
  }
  const _v = validateBody(req.body, _TEMPLATE_BODY_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  const body = req.body;
  const sv = _bpValidateTemplateSettings(body.settings, _v.values.event_kind);
  if (sv.error) return res.status(400).json({ error: sv.error, code: sv.code, ...(sv.setting ? { setting: sv.setting } : {}) });
  const tv = _bpValidateTemplateTasks(req, body.task_ids, _v.values.event_kind, sv.values);
  if (tv.error) return res.status(tv.status || 400).json({ error: tv.error, code: tv.code, ...(tv.task_id ? { task_id: tv.task_id } : {}) });
  { const clash = _tplNameClash(_v.values.name); if (clash) return res.status(409).json(clash); }
  const id = uuid();
  const at = now().toISOString();
  db.prepare("INSERT INTO event_templates (id, name, description, event_kind, settings, task_ids, created_by_id, created_at, updated_at, is_builtin) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(id, _v.values.name, _v.values.description || "", _v.values.event_kind, JSON.stringify(sv.values), JSON.stringify(tv.ids), actorId(req), at, at);
  recordOrphanedAuditEvent("event_template", id, "created", getAdminIdentity(req), {
    name: _v.values.name, event_kind: _v.values.event_kind, settings: sv.values, task_count: tv.ids.length, ...reqContext(req),
  });
  res.json({ ok: true, template: _templateWire(req, db.prepare("SELECT * FROM event_templates WHERE id=?").get(id)) });
});

app.put("/api/admin/event-templates/:id", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const row = _liveTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found" });
  const unknown = _bpUnknownField(req.body, _TEMPLATE_BODY_KEYS);
  if (unknown !== null) {
    const f = String(unknown).slice(0, 60);
    return res.status(400).json({ error: `A template takes a name, a description, an event type, settings and task_ids; “${f}” is not one of them.`, code: "unknown_field", field: f });
  }
  const _v = validateBody(req.body, allOptional(_TEMPLATE_BODY_SCHEMA));
  if (_v.error) return res.status(400).json({ error: _v.error });
  const body = req.body;
  if (body.expectedUpdatedAt !== undefined && typeof body.expectedUpdatedAt !== "string") {
    return res.status(400).json({ error: "expectedUpdatedAt must be a string" });
  }
  // The prospective state is validated WHOLE: a kind change re-judges the
  // stored settings and challenges against the new kind.
  const kind = _v.values.event_kind || row.event_kind;
  const settingsIn = body.settings !== undefined ? body.settings : _bpStoredSettings(row);
  const tasksIn = body.task_ids !== undefined ? body.task_ids : _bpParse(row.task_ids, []);
  const sv = _bpValidateTemplateSettings(settingsIn, kind);
  if (sv.error) return res.status(400).json({ error: sv.error, code: sv.code, ...(sv.setting ? { setting: sv.setting } : {}) });
  const tv = _bpValidateTemplateTasks(req, tasksIn, kind, sv.values);
  if (tv.error) return res.status(tv.status || 400).json({ error: tv.error, code: tv.code, ...(tv.task_id ? { task_id: tv.task_id } : {}) });
  const name = _v.values.name || row.name;
  { const clash = _tplNameClash(name, row.id); if (clash) return res.status(409).json(clash); }
  const at = now().toISOString();
  // The compare-and-swap is the UPDATE's own WHERE, so two saves of one stale
  // copy cannot both land.
  const r = db.prepare(
    "UPDATE event_templates SET name=?, description=?, event_kind=?, settings=?, task_ids=?, updated_at=? WHERE id=? AND deleted_at IS NULL" +
    (body.expectedUpdatedAt !== undefined ? " AND updated_at IS ?" : "")
  ).run(name, _v.values.description !== undefined ? _v.values.description : row.description, kind,
    JSON.stringify(sv.values), JSON.stringify(tv.ids), at, row.id, ...(body.expectedUpdatedAt !== undefined ? [body.expectedUpdatedAt] : []));
  if (r.changes === 0) return res.status(409).json({ error: "This template was changed by someone else. Reload it and try again.", code: "stale" });
  recordOrphanedAuditEvent("event_template", row.id, "edited", getAdminIdentity(req), {
    name, event_kind: kind, ...(kind !== row.event_kind ? { event_kind_from: row.event_kind } : {}),
    settings: sv.values, task_count: tv.ids.length, ...reqContext(req),
  });
  res.json({ ok: true, template: _templateWire(req, db.prepare("SELECT * FROM event_templates WHERE id=?").get(row.id)) });
});

// v8.17.0 — DELETE IS A SOFT DELETE, and two kinds of template refuse it (409
// `template_protected`, `_tplProtection`): a built-in, and one a global admin
// marked Protected. The guard is repeated in the UPDATE's own WHERE, so a
// protect landing between the read and the write cannot be bypassed. A deleted
// template is restorable from "Recently deleted" for TEMPLATE_RESTORE_DAYS.
app.delete("/api/admin/event-templates/:id", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const row = _liveTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found" });
  const prot = _tplProtection(row);
  if (prot) return res.status(409).json(prot);
  const at = now().toISOString();
  const r = db.prepare("UPDATE event_templates SET deleted_at=? WHERE id=? AND deleted_at IS NULL AND is_builtin=0 AND protected=0").run(at, row.id);
  if (r.changes === 0) {
    const again = db.prepare("SELECT * FROM event_templates WHERE id=?").get(row.id);
    const p2 = again && _tplProtection(again);
    return p2 ? res.status(409).json(p2) : res.status(404).json({ error: "Template not found" });
  }
  recordOrphanedAuditEvent("event_template", row.id, "deleted", getAdminIdentity(req), { name: row.name, soft: true, ...reqContext(req) });
  res.json({ ok: true, deleted_at: at, purge_at: new Date(Date.parse(at) + TEMPLATE_RESTORE_DAYS * 86400e3).toISOString() });
});

// v8.17.0 — Protect / unprotect. A protected template cannot be deleted by
// anyone until a global admin unprotects it. A built-in is always protected
// (it cannot be deleted at all), so the switch is refused on one.
app.post("/api/admin/event-templates/:id/protect", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const row = _liveTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found" });
  if (typeof req.body?.protected !== "boolean") return res.status(400).json({ error: "Send protected: true or false.", code: "protected_required" });
  if (row.is_builtin) return res.status(409).json({ error: "A built-in template is always protected.", code: "template_builtin" });
  const to = req.body.protected ? 1 : 0;
  if ((row.protected ? 1 : 0) === to) return res.json({ ok: true, unchanged: true, template: _templateWire(req, row) });
  db.prepare("UPDATE event_templates SET protected=? WHERE id=? AND deleted_at IS NULL").run(to, row.id);
  recordOrphanedAuditEvent("event_template", row.id, to ? "protected" : "unprotected", getAdminIdentity(req), { name: row.name, ...reqContext(req) });
  res.json({ ok: true, template: _templateWire(req, _liveTemplate(row.id)) });
});

// v8.17.0 — Restore a soft-deleted template (one click from Recently deleted).
app.post("/api/admin/event-templates/:id/restore", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const row = db.prepare("SELECT * FROM event_templates WHERE id=? AND deleted_at IS NOT NULL").get(req.params.id);
  if (!row) return res.status(404).json({ error: "No deleted template with that id. It may have been restored already or purged." });
  const r = db.prepare("UPDATE event_templates SET deleted_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NOT NULL").run(now().toISOString(), row.id);
  if (r.changes === 0) return res.status(404).json({ error: "No deleted template with that id. It may have been restored already or purged." });
  recordOrphanedAuditEvent("event_template", row.id, "restored", getAdminIdentity(req), { name: row.name, ...reqContext(req) });
  res.json({ ok: true, template: _templateWire(req, _liveTemplate(row.id)) });
});

// v8.17.0 — Reset a built-in to its shipped definition (name, description,
// kind, settings; no challenges). Refused on an administrator's template.
app.post("/api/admin/event-templates/:id/reset", requireAdmin, requireGlobalAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const row = _liveTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found" });
  const def = row.is_builtin ? builtinTemplate(row.builtin_key) : null;
  if (!def) return res.status(409).json({ error: "Only a built-in template can be reset to its default.", code: "template_not_builtin" });
  { const clash = _tplNameClash(def.name, row.id); if (clash) return res.status(409).json({ ...clash, error: `Another template is called “${def.name}”. Rename it first, then reset this one.` }); }
  db.prepare("UPDATE event_templates SET name=?, description=?, event_kind=?, settings=?, task_ids='[]', updated_at=? WHERE id=?")
    .run(def.name, def.description, def.kind, JSON.stringify(def.settings), now().toISOString(), row.id);
  recordOrphanedAuditEvent("event_template", row.id, "reset", getAdminIdentity(req), { name: def.name, builtin_key: def.key, name_from: row.name, ...reqContext(req) });
  res.json({ ok: true, template: _templateWire(req, _liveTemplate(row.id)) });
});

// ── Spawn a template ─────────────────────────────────────────────────────────
app.post("/api/admin/event-templates/:id/spawn", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  // A scoped organiser (an event admin, or a role limited to its events) whose
  // every grant has been revoked is shut out, as each of their other doors
  // fails closed: a spawn would hand them a new event and its organiser row, so
  // revoking their grants would not end their access. Asked before the template
  // is looked up, so the answer says nothing about it.
  if (isEventAdmin(req)) {
    const _scope = scopedCompetitionIds(req);
    if (Array.isArray(_scope) && _scope.length === 0) {
      return res.status(403).json({ error: "You organise no events at the moment, so you cannot start one. Ask an administrator to make you an organiser of an event.", code: "event_admin_no_events" });
    }
  }
  const row = _liveTemplate(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found" });
  const unknown = _bpUnknownField(req.body, new Set([...Object.keys(_SPAWN_SCHEMA), "add_qualifying"]));
  if (unknown !== null) return res.status(400).json({ error: `Spawning a template takes a name, a start time and add_qualifying only; “${String(unknown).slice(0, 60)}” is not one of them.`, code: "unknown_field", field: String(unknown).slice(0, 60) });
  // "Add the qualifying questions": strictly a boolean, as on the create route.
  // ABSENT means none (a template carries no qualifying questions, and a spawn
  // made without the form keeps doing what it always did); the form sends it.
  const _addQRaw = req.body?.add_qualifying;
  if (_addQRaw !== undefined && typeof _addQRaw !== "boolean") return res.status(400).json({ error: "add_qualifying must be true or false.", code: "add_qualifying_invalid" });
  const _v = validateBody(req.body, _SPAWN_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  // Re-validated at every spawn: the row is data, and a kind's rules can have
  // moved since it was saved.
  const sv = _bpValidateTemplateSettings(_bpStoredSettings(row), row.event_kind);
  if (sv.error) return res.status(409).json({ error: `This template's settings are no longer valid: ${sv.error} Ask an administrator to edit the template.`, code: "template_invalid" });
  const ids = _bpParse(row.task_ids, []);
  const out = _materialiseEvent(req, {
    name: _v.values.name,
    startDate: _v.values.start_time ? new Date(_v.values.start_time) : _bpDefaultStart(),
    kind: row.event_kind, settings: sv.values, mode: "refuse", autoEnd: undefined,
    tags: sv.values.tags || [], taskIds: Array.isArray(ids) ? ids : [], slots: [], latePinOffsetMs: null,
    cxoneGroupName: null, forcedIn: [], addQualifying: _addQRaw === true,
    provenance: { via: "template", details: { template_id: row.id, template_name: row.name, organiser_granted: isEventAdmin(req) } },
  });
  if (out.status === 200) {
    recordOrphanedAuditEvent("event_template", row.id, "spawned", getAdminIdentity(req), {
      competition_id: out.body.competition.id, competition_name: _v.values.name, ...reqContext(req),
    });
  }
  res.status(out.status).json(out.body);
});
}
