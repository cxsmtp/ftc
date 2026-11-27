"use strict";
//
// v8.12.0 — STAFF CAN COMPETE.
//
// `competitions.staff_compete` is a per-event switch. While it is OFF (the
// default, and every event that existed before this release) the platform keeps
// its standing rule: a user tagged `staff` — which is every admin and superadmin,
// tagged on promotion — and an event admin (excluded by ROLE, never tagged) are
// never on that event's leaderboard, never count toward its all-solved
// denominator, and cannot mint a certificate from it. While it is ON, a staff
// member who HOLDS A ROW in `competition_users` for that event competes exactly
// like anybody else: board, denominator, presence, badges, exports.
//
// ── THREE WORDS, DELIBERATELY DISTINCT ────────────────────────────────────────
//
//  • "staff" (scoring) is the `staff` TAG or the `event_admin` ROLE — the two
//    sources every board and the denominator already exclude by. The switch
//    lifts BOTH together, because lifting one would put a global admin on the
//    board while the event admin beside them stays off it, for no reason anyone
//    could read off a screen.
//  • "competitor" (the edit lock) is ANY actor who holds a `competition_users`
//    row on an event whose switch is on. Not "a staff-tagged actor with a row":
//    an admin created by the maintenance seeder, or one whose tag was hand-
//    edited, holds admin rights without the tag, and a rule keyed on the tag
//    would let exactly that account edit an event it is enrolled in. The row is
//    the fact that cannot be argued with.
//  • "own" (the picker) is simply "holds a row", switch or no switch. For an
//    ordinary participant every row is own; for a staff member it is what
//    separates the events they were put in from the ones they may merely enter.
//
// ── THE INTEGRITY CONTROL IS THE SEAL, AND THE SEAL HAS FOUR DIRECTIONS ──────
//
// A competing admin can open the admin Challenges pane. The answer key of an
// UNSEALED challenge is on that pane for every admin tier, so an event that lets
// staff compete may hold only SEALED challenges (lib/answer-seal.js). That rule
// is a theorem only if it holds from every direction, and there are four:
//
//   1. assignment — every path that writes a `competition_tasks` row;
//   2. the switch itself — turning it ON with unsealed challenges assigned, or
//      with an enrolled row-holder who AUTHORED an assigned challenge
//      (`enrolledAuthors`);
//   3. the unseal — a sealed challenge in a compete event may not be unsealed
//      while it is assigned there, AT ANY STATUS of the event (the reorder door,
//      the shape lib/challenge-fit.js closes for the kind rule — and stricter
//      than that rule's ended skip, because an ended event is revivable and no
//      revive path re-asks the seal question; see `sealedTaskCompeteEvents`);
//   4. the AUTHOR — `sealedAnswerReadable` admits the author by definition, so
//      a challenge whose author competes in the event is a challenge whose key
//      one competitor can read. Refused at assignment of the challenge, at
//      enrolment of the author, and at the switch (direction 2).
//
// `hint` is NOT sealed (a participant pays 30% of the points to read it), so
// the admin projection withholds it from a competitor on its own account — that
// is routes/challenges.js's job: the LIST builds its own per-page competing
// set, while the history read, the tasks export and the challenge import ask
// `competitorEventsForTask` below per challenge.
//
// ── WHY A SEPARATE MODULE ─────────────────────────────────────────────────────
//
// lib/event-admin.js's predicates open with `if (scopedCompetitionIds(req) ===
// null) return null` — global admins and superadmins bypass ownership by their
// first line, which is right for that tier system and the exact opposite of what
// this rule means: it binds EVERY tier, superadmin included. lib/answer-seal.js
// is the precedent and its header says why folding a tier-blind rule beside a
// tier-exempting one is how it gets "simplified" into inertness.
//
// PURE AT MODULE SCOPE: requires nothing, so a spec can `require` it at column 0
// and drive the whole predicate matrix with no server. The helpers that need the
// database take `db` as an ARGUMENT (the lib/challenge-fit.js
// `taskConflictingEvent(db, …)` shape), and every row predicate THROWS on a row
// that lacks the key it reads — an under-selected row must fail loud, never fall
// through to "not set" (the v8.4.0 `_profileMissingFields` posture; a false
// `answerSealed()` here would admit the unsealed challenge the rule exists to
// keep out, with every test green).

const CODES = Object.freeze({
  LOCKED:            "staff_compete_locked",
  LOCKED_ENDED:      "staff_compete_locked_ended",
  UNSEALED_ASSIGNED: "staff_compete_unsealed_challenges",
  STAFF_ENROLLED:    "staff_compete_enrolled_staff",
  AUTHOR_ENROLLED:   "staff_compete_enrolled_authors",
  UNSEALED:          "staff_compete_unsealed",
  AUTHOR_COMPETES:   "staff_compete_author_competes",
  COMPETITOR_EDIT:   "competitor_cannot_edit",
  UNSEAL_IN_EVENT:   "answer_seal_in_compete_event",
});

/** The refused-assignment ledger is capped — a modal listing a thousand rows helps nobody. */
const REFUSED_LIST_CAP = 50;

function _requireKey(row, key, what) {
  if (!row || row[key] === undefined) {
    throw new Error(`staff-compete: ${what} row is missing \`${key}\` — the SELECT that produced it must name the column`);
  }
}

/** Does this event let staff compete? THROWS on a row that never selected the column. */
function staffCompeteOn(comp) {
  _requireKey(comp, "staff_compete", "competition");
  return !!comp.staff_compete;
}

/**
 * May this challenge be ASSIGNED to this event?
 *
 * Only the seal question — the fit question (file answers, `needs:` tags) is
 * lib/challenge-fit.js's and is asked beside this one. Both rows must carry the
 * column they are judged on.
 */
function unsealedAssignmentDenied(task, comp) {
  if (!staffCompeteOn(comp)) return null;
  _requireKey(task, "answer_sealed", "task");
  if (task.answer_sealed) return null;
  return {
    code: CODES.UNSEALED,
    reason: "unsealed",
    message: `“${comp.name}” lets staff compete, so it only admits challenges whose answer is sealed — “${task.title}” is not sealed. Seal a new copy of it, or choose a sealed challenge.`,
  };
}

/**
 * Does the challenge's AUTHOR hold a row on this compete event?
 *
 * A sealed challenge's key is readable by its author, so an author who competes
 * in the event would compete against their own answer key. Refused at both doors:
 * assigning the challenge (here) and assigning the author (`authoredAssignedTasks`).
 * A NULL author (imported, pre-v8.7.0, built-in superadmin) competes nowhere.
 */
function authorCompetesDenied(db, task, comp) {
  if (!staffCompeteOn(comp)) return null;
  _requireKey(task, "created_by_id", "task");
  if (!task.created_by_id) return null;
  const row = db.prepare(
    "SELECT u.nickname FROM competition_users cu JOIN users u ON u.id = cu.user_id WHERE cu.competition_id = ? AND cu.user_id = ?"
  ).get(comp.id, task.created_by_id);
  if (!row) return null;
  return {
    code: CODES.AUTHOR_COMPETES,
    reason: "author_competes",
    message: `“${task.title}” was created by ${row.nickname}, who is competing in “${comp.name}”, so its answer would be known to a competitor. Choose a challenge created by somebody else.`,
  };
}

/**
 * The challenges authored by `userId` that are assigned to `compId` — what stops
 * that user being ENROLLED as a competitor there. Same rule as
 * `authorCompetesDenied`, asked from the other side.
 */
function authoredAssignedTasks(db, userId, compId) {
  if (!userId) return [];
  return db.prepare(
    "SELECT t.id, t.title FROM competition_tasks ct JOIN tasks t ON t.id = ct.task_id WHERE ct.competition_id = ? AND t.created_by_id = ? ORDER BY t.title"
  ).all(compId, userId);
}

/**
 * v8.12.1 — EVERY ACTOR ARGUMENT BELOW IS ONE ID OR AN ARRAY OF IDS. Under an
 * impersonated admin view there are TWO humans a competitor row can bind: the
 * SEAT (the organiser whose panel it is — "act exactly as they can") and the
 * HAND (the admin at the keyboard, whose own board must not be moved through
 * somebody else's panel — the v8.12.0 rival ruling binds the person, not the
 * session). `lib/event-admin.js`'s `competitorIds(req)` hands both in; a plain
 * session hands in one; the built-in superadmin hands in none and is refused
 * nothing, as before. Nulls and duplicates are dropped so a caller can pass
 * `[seat, hand]` without checking either. The predicates stay PURE: an array is
 * the same question asked of each id, and the FIRST event by name that binds
 * ANY of them is the one the refusal names.
 */
function _actorIds(actor) {
  const list = Array.isArray(actor) ? actor : [actor];
  return [...new Set(list.filter(Boolean))];
}
// An id list is ONE bound JSON array, so the statement text is constant (the
// prepare memo, db.js): bind `JSON.stringify(ids)` where `${_IDS}` stands.
const _IDS = "SELECT value FROM json_each(?)";

/** Is `actorId` a competitor in `compId` — a row on an event whose switch is on? */
function competitorIn(db, actorId, compId) {
  const ids = _actorIds(actorId);
  if (!ids.length || !compId) return false;
  return !!db.prepare(
    `SELECT 1 FROM competition_users cu JOIN competitions c ON c.id = cu.competition_id WHERE cu.user_id IN (${_IDS}) AND c.id = ? AND c.staff_compete = 1`
  ).get(JSON.stringify(ids), compId);
}

/**
 * The refusal for any mutating admin action on an event the actor competes in.
 *
 * Every tier. The built-in superadmin has no `users` row and can never hold a
 * `competition_users` row, so it is structurally exempt — stated rather than
 * discovered. Self-removal from the event is the one carve-out, made at the
 * route: it is the competitor's own escape hatch, and refusing it would leave a
 * sole superadmin no way back but hand-written SQL.
 */
function competitorEditDenied(db, actorId, compId) {
  if (!competitorIn(db, actorId, compId)) return null;
  const c = db.prepare("SELECT * FROM competitions WHERE id = ?").get(compId);
  return {
    code: CODES.COMPETITOR_EDIT,
    competitionId: compId,
    competitionName: c ? c.name : null,
    message: `You are competing in “${c ? c.name : "this event"}”, so you cannot change the event or its challenges. ${_competitorRemedy(c)}`,
  };
}

/**
 * The remedy clause of a competitor refusal. Self-removal is the competitor's
 * own escape hatch — but only while the event has not ended: the ended-event
 * membership rule refuses it afterwards, so naming it there is an instruction
 * that is not true (FROZEN_REMEDY). A missing row cannot be judged and keeps
 * the fuller clause. Lazy require, so the module stays pure at module scope.
 */
function _competitorRemedy(compRow) {
  let ended = false;
  if (compRow) {
    const { competitionFullyEnded } = require("./competitions");
    ended = competitionFullyEnded(compRow);
  }
  return ended
    ? "Ask another organiser to make the change."
    : "Ask another organiser to make the change, or remove yourself from the event first.";
}

/**
 * v8.12.0 — THE RIVAL. A user who holds a row on a compete event the ACTOR
 * holds a row on: somebody on the board the actor competes on. The ACCOUNT
 * doors — impersonate, block / unblock, deny, approve, verify, the benchmark
 * tag, delete, a role change, a sign-in code (emailed or shown at the desk) —
 * reach that board through the account rather than through the event: a
 * blocked or denied rival drops out
 * of `ACTIVE_PARTICIPANT_SQL` and the all-solved denominator, a benchmark tag
 * takes them off the ranked board, a delete cascades their submissions, an
 * impersonation submits AS them, a desk code shown to the actor hands the actor
 * their session, and an emailed one, though it goes to the rival's own inbox,
 * replaces the code they may be typing and spends their capped sends. The
 * operator's decision 2 ("every mutating admin action, every tier") keys on
 * the event; the operator then ruled (19 Sep 2026) that these doors are
 * gated too, because each is a board change wearing the account's clothes.
 *
 * Never SELF (an admin acting on their own account has its own rules at every
 * door), never the built-in superadmin (no `users` row, so never a competitor),
 * and the FIRST shared event by name is the one the refusal names — the
 * competitor's remedy (self-removal while the event has not ended) is per
 * event, and one is enough to say why.
 */
function competitorRivalDenied(db, actorId, targetUserId) {
  // Never SELF: an id equal to the target is dropped rather than refused, so a
  // seat acting on its own account keeps its own rules at that door.
  const ids = _actorIds(actorId).filter(id => id !== targetUserId);
  if (!ids.length || !targetUserId) return null;
  const shared = db.prepare(
    `SELECT c.id FROM competition_users a
       JOIN competition_users t ON t.competition_id = a.competition_id AND t.user_id = ?
       JOIN competitions c ON c.id = a.competition_id
      WHERE a.user_id IN (SELECT value FROM json_each(?)) AND c.staff_compete = 1
      ORDER BY c.name LIMIT 1`
  ).get(targetUserId, JSON.stringify(ids));   // one bind: constant statement text (the prepare memo)
  if (!shared) return null;
  const c = db.prepare("SELECT * FROM competitions WHERE id = ?").get(shared.id);
  return {
    code: CODES.COMPETITOR_EDIT,
    competitionId: shared.id,
    competitionName: c ? c.name : null,
    message: `You are competing in “${c ? c.name : "this event"}” alongside this person, so you cannot change their account from here. ${_competitorRemedy(c)}`,
  };
}

/**
 * The rival marker for a PAGE of participant rows — one query, so the
 * Participants pane can withhold the account doors with their reason (v7.14.2)
 * without one lookup per row. Returns a Map of target user id → the first
 * shared compete event `{ id, name }`.
 */
function rivalsOf(db, actorId, userIds) {
  const out = new Map();
  const ids = _actorIds(actorId);
  if (!ids.length || !userIds.length) return out;
  const rows = db.prepare(
    `SELECT t.user_id, c.id, c.name FROM competition_users a
       JOIN competition_users t ON t.competition_id = a.competition_id
       JOIN competitions c ON c.id = a.competition_id
      WHERE a.user_id IN (${_IDS}) AND c.staff_compete = 1 AND t.user_id NOT IN (${_IDS})
        AND t.user_id IN (${_IDS})
      ORDER BY c.name`
  ).all(JSON.stringify(ids), JSON.stringify(ids), JSON.stringify(userIds));
  for (const r of rows) if (!out.has(r.user_id)) out.set(r.user_id, { id: r.id, name: r.name });
  return out;
}

/** The compete events the actor competes in that hold this challenge — `[]` for a non-competitor. */
function competitorEventsForTask(db, actorId, taskId) {
  const ids = _actorIds(actorId);
  if (!ids.length || !taskId) return [];
  // BY LINEAGE (lib/event-copies.js): a bank question and every event's copy of
  // it carry the key the copies were made from, so a question is "held" by every
  // event holding itself, its bank question or another copy of that bank
  // question, and a competitor is kept from all of them alike.
  return db.prepare(
    `SELECT DISTINCT c.id, c.name FROM competition_tasks ct
       JOIN competitions c ON c.id = ct.competition_id
       JOIN competition_users cu ON cu.competition_id = c.id AND cu.user_id IN (${_IDS})
       JOIN tasks et ON et.id = ct.task_id
      WHERE (ct.task_id = ?
             OR COALESCE(et.copied_from_task_id, et.id) = (SELECT COALESCE(s.copied_from_task_id, s.id) FROM tasks s WHERE s.id = ?))
        AND c.staff_compete = 1 ORDER BY c.name`
  ).all(JSON.stringify(ids), taskId, taskId);
}

/** The refusal for any mutating admin action on a challenge held by an event the actor competes in. */
function competitorTaskEditDenied(db, actorId, taskId) {
  const events = competitorEventsForTask(db, actorId, taskId);
  if (!events.length) return null;
  const c = db.prepare("SELECT * FROM competitions WHERE id = ?").get(events[0].id);
  return {
    code: CODES.COMPETITOR_EDIT,
    competitionId: events[0].id,
    competitionName: events[0].name,
    message: `You are competing in “${events[0].name}”, which holds this challenge, so you cannot change it. ${_competitorRemedy(c)}`,
  };
}

/**
 * The refusal for a write to a GROUP that is bound to an event the actor competes
 * in — group membership live-syncs into every bound event (`lib/group-sync.js`
 * reconciles on every add, remove and delete), so adding somebody to such a
 * group enrols them on the board the actor competes on, and removing a
 * group-only member drops them. v8.7.0's `groupWriteDenied` treats the group
 * as a transitive event writer for the event-admin SCOPE; this is the same
 * shape for the competitor lock. `[]` bound events → null.
 */
function competitorGroupDenied(db, actorId, groupId) {
  if (!_actorIds(actorId).length || !groupId) return null;
  const bound = db.prepare("SELECT competition_id FROM competition_groups WHERE group_id = ?").all(groupId);
  for (const b of bound) {
    const d = competitorEditDenied(db, actorId, b.competition_id);
    if (d) return d;
  }
  return null;
}

/** Unsealed challenges assigned to `compId` — what stops the switch being turned ON. */
function unsealedAssigned(db, compId) {
  return db.prepare(
    "SELECT t.id, t.title FROM competition_tasks ct JOIN tasks t ON t.id = ct.task_id WHERE ct.competition_id = ? AND t.answer_sealed = 0 ORDER BY t.title"
  ).all(compId);
}

/**
 * Staff-TAGGED users enrolled in `compId` — what stops the switch being turned OFF.
 *
 * The TAG, deliberately, not the role: an event admin may legitimately be enrolled
 * in an event whose switch is off (they are excluded by role and the assign route
 * has always admitted them), so their row is not evidence of anything. A
 * staff-tagged row was written while the switch was on, or before this release
 * existed, or belongs to a participant PROMOTED after enrolment (the role route
 * adds the tag and deletes no rows); whichever way, it is the row that would
 * stop scoring the moment the switch went off.
 */
function staffEnrolled(db, compId) {
  return db.prepare(
    `SELECT u.id, u.nickname FROM competition_users cu
       JOIN users u ON u.id = cu.user_id
       JOIN user_tags t ON t.user_id = u.id AND t.tag = 'staff'
      WHERE cu.competition_id = ? ORDER BY u.nickname`
  ).all(compId);
}

/**
 * Enrolled row-holders who AUTHORED a challenge assigned to `compId` — what
 * stops the switch being turned ON: the moment it lands they compete against
 * their own key, which every other door (assignment, every row-writer) refuses.
 * The switch was the one door that did not ask (found by the v8.12.0 writers
 * lock, whose import fixture reached the state through it). Any row counts —
 * a participant promoted after enrolment, an event admin admitted to a
 * switch-off event — because the row is what will compete.
 */
function enrolledAuthors(db, compId) {
  return db.prepare(
    `SELECT u.id, u.nickname, t.id AS task_id, t.title
       FROM competition_users cu
       JOIN users u ON u.id = cu.user_id
       JOIN competition_tasks ct ON ct.competition_id = cu.competition_id
       JOIN tasks t ON t.id = ct.task_id AND t.created_by_id = u.id
      WHERE cu.competition_id = ? ORDER BY u.nickname, t.title`
  ).all(compId).reduce((acc, r) => {
    let row = acc.find(a => a.id === r.id);
    if (!row) { row = { id: r.id, nickname: r.nickname, tasks: [] }; acc.push(row); }
    row.tasks.push({ id: r.task_id, title: r.title });
    return acc;
  }, []);
}

/**
 * The compete events holding this challenge — what stops it being UNSEALED —
 * AT ANY STATUS of the event, deliberately. Two drafts skipped ended events and
 * both reopened the seal by REORDERING:
 *
 *   • skipping on `anySlotEnded` (the lib/challenge-fit.js rule) let the author
 *     unseal after ONE session of a multi-session event while a later session
 *     was still live — measured by the v8.12.0 seal lock;
 *   • skipping on `competitionFullyEnded` let the author unseal after the event
 *     ended and then have it REVIVED — a manual end plus a deliberate extend
 *     always revives (v7.7.x), a time-expired event revives by pure arithmetic
 *     with no handler at all, and an assign or a new session revives too. No
 *     revive path re-asks the seal question, and the arithmetic one cannot, so
 *     a live compete event then held an unsealed challenge whose key was on the
 *     tasks export and whose rivals' answers were on the Submissions stream.
 *
 * So the question is "is it assigned to a compete event", full stop. The cost
 * is stated rather than hidden: a challenge assigned to an ENDED compete event
 * cannot be unsealed (unassigning it is refused by the ended-session freeze),
 * so it stays sealed for as long as it stays assigned. That costs the author
 * nothing they hold — the author reads and edits a sealed challenge — and the
 * refusal's second remedy, leave the answer sealed, is always available.
 *
 * `scope` (v8.12.0) — an event-admin author is NAMED only the events in their
 * own scope; the rest are a COUNT, the v8.8.8 rule (a count is a far smaller
 * disclosure than another organiser's event name). `null` means unscoped.
 */
function sealedTaskCompeteEvents(db, taskId) {
  return db.prepare(
    `SELECT c.id, c.name FROM competition_tasks ct JOIN competitions c ON c.id = ct.competition_id WHERE ct.task_id = ? AND c.staff_compete = 1 ORDER BY c.name`
  ).all(taskId);
}

function unsealDenied(db, taskId, scope) {
  const all = sealedTaskCompeteEvents(db, taskId);
  if (!all.length) return null;
  const events = scope === null || scope === undefined ? all : all.filter(e => scope.includes(e.id));
  const withheld = all.length - events.length;
  const named = events.length
    ? ` (${events.map(e => `“${e.name}”`).join(", ")}${withheld ? `, and ${withheld} more outside your events` : ""})`
    : ` (${withheld} outside your events)`;
  const plural = all.length !== 1;
  return {
    code: CODES.UNSEAL_IN_EVENT,
    competitions: events,
    ...(withheld ? { withheld_competition_count: withheld } : {}),
    message: `This challenge is in ${plural ? "events" : "an event"} where staff compete${named}, and such an event only admits sealed challenges. Take it out of ${plural ? "those events" : "that event"} first, or leave the answer sealed.`,
  };
}

/**
 * The lock on the SWITCH. Ended is asked first because ended implies started
 * and the started reason would otherwise answer for it with the wrong words.
 * `anySlotStarted` / `fullyEnded` are passed in so this module stays pure.
 */
function switchLock({ fullyEnded, anySlotStarted }) {
  if (fullyEnded) {
    return { code: CODES.LOCKED_ENDED, reason: "ended",
      message: "Whether staff compete cannot be changed once the event has ended — the standings are final, and any certificates already issued assert them." };
  }
  if (anySlotStarted) {
    return { code: CODES.LOCKED, reason: "started",
      message: "Whether staff compete cannot be changed once the event has started — it would add people to or remove them from the board mid-event." };
  }
  return null;
}

/**
 * v8.12.7 — the 403 BODY of a competitor refusal, without a `res`: `{error,
 * code, competitionId, competitionName}`. Exists for the one kind of caller
 * `refuseCompetitor` cannot serve — a refusal decided INSIDE a write
 * transaction, which must throw out of the transaction and answer afterwards
 * (the desk shortcut's commit-time re-check). A second hand-built copy of this
 * shape is how the two answers for one refusal would drift, so both go through
 * here.
 */
function competitorRefusalBody(denial) {
  return {
    error: denial.message, code: denial.code,
    competitionId: denial.competitionId || null, competitionName: denial.competitionName || null,
  };
}

/**
 * Write a competitor refusal to `res`, or return null when there is none — so
 * every door answers 403 with ONE shape: `{error, code, competitionId,
 * competitionName}`. Takes `res` rather than requiring express, so the module
 * stays pure at module scope.
 */
function refuseCompetitor(res, denial) {
  if (!denial) return null;
  return res.status(403).json(competitorRefusalBody(denial));
}

/** Trim a refusal ledger for the wire, keeping the total count honest. */
function capRefused(list) {
  return { refused: list.slice(0, REFUSED_LIST_CAP), refused_total: list.length };
}

module.exports = {
  CODES, REFUSED_LIST_CAP,
  staffCompeteOn, unsealedAssignmentDenied, authorCompetesDenied, authoredAssignedTasks,
  competitorIn, competitorEditDenied, competitorEventsForTask, competitorTaskEditDenied, competitorGroupDenied,
  unsealedAssigned, staffEnrolled, enrolledAuthors, sealedTaskCompeteEvents, unsealDenied, switchLock, capRefused, refuseCompetitor, competitorRefusalBody,
  competitorRivalDenied, rivalsOf,
};
