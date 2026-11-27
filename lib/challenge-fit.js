"use strict";
//
// v8.1.0 (PR 30) — WHICH CHALLENGES CAN ACTUALLY BE ANSWERED AT THIS EVENT.
//
// A Booth Event is a walk-up at a conference stand: someone scans a QR with the
// phone in their hand, answers something in a couple of minutes and leaves. Three
// kinds of challenge cannot be answered in that situation, and the platform used
// to let an admin assign all three anyway:
//
//   * one whose answer is a FILE — there is no file to upload on a borrowed
//     phone, and the input renders a picker that resolves to nothing useful;
//   * one that needs a CxOne account — booth events run `cxone_disabled` by
//     default (nobody is provisioning an external identity for a two-minute
//     visit), so the account the challenge assumes does not exist;
//   * one that needs a desktop — an IDE, a terminal, a VPN client.
//
// The failure mode this closes is NOT an error. It is a participant standing at
// a stand looking at a challenge they cannot do, with nothing on screen saying
// why, and an admin who assigned it in good faith because the picker offered it.
//
// THE RULE IS A POLICY, NOT A KIND CHECK. Callers ask
// `eventPolicy(comp).refusesFileAnswers` / `.refusesToolRequiringChallenges` via
// the helpers here; nothing outside `lib/event-policy.js` writes
// `event_kind === "booth"`. Both flags landed inert in PR 11 and go live here —
// the same shape as `auto_end_on_all_solved` in PR 16.
//
// ── THE `needs:` TAG NAMESPACE ────────────────────────────────────────────────
//
// `needs:cxone` and `needs:desktop` are ORDINARY TASK TAGS, following the
// `category:` convention (v7.21.0) for the same reason it did: tag CRUD, the tag
// filter, the tag column, search, export/import and the audit trail all keep
// working untouched, because nothing about the tag is special until it is READ.
// No column, no table, no admin CRUD, no migration.
//
// **THE NAMESPACE IS NEGATIVE, AND THAT IS A ONE-WAY DOOR TAKEN DELIBERATELY.**
// Any `needs:<anything>` tag restricts; none can ever grant. Two consequences,
// both of which are the point:
//
//   * an unrecognised need — `needs:vpn`, invented by an admin next year — is
//     refused at a booth WITH NO CODE CHANGE. The alternative (an allow-list of
//     known needs, tolerant of the rest) fails OPEN, which here means the
//     participant gets the unanswerable challenge the feature exists to prevent.
//     This is the deliberate opposite of `eventKind`'s tolerant-on-unknown-value
//     rule, because the two unknowns mean opposite things: an unknown KIND means
//     a rollback and must keep serving, an unknown NEED means a requirement this
//     build has not heard of and must not be waved through.
//   * the namespace can therefore never be repurposed to mean "this challenge is
//     suitable for X". A future positive rule needs its own prefix.
//
// `KNOWN_NEEDS` exists only to make the refusal READABLE ("needs a CxOne
// account" rather than "needs cxone"); it is not the enforcement set.
//
// **`needs:` IS NOT PARTICIPANT-VISIBLE.** `category:` is still the only task tag
// a participant ever sees (v7.21.0), and that rule is one-directional by design:
// task tags are free-text admin labels carrying ticket ids and author names.
// Nothing here touches the participant wire.
const { eventPolicy, eventKindPhrase } = require("./event-policy");

const NEEDS_PREFIX = "needs:";

// Message text only — see the namespace note above. Adding a key here improves a
// sentence; it does NOT add enforcement, which already covers every `needs:` tag.
const KNOWN_NEEDS = Object.freeze({
  cxone: "a CxOne account",
  desktop: "a desktop computer",
});

/**
 * The tools a challenge declares it needs, from its tag list.
 *
 * Tags are stored lowercased (every write path lowercases), but this is fed by
 * import and export too, so it normalises rather than assuming.
 */
function challengeNeeds(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (!t.startsWith(NEEDS_PREFIX)) continue;
    const need = t.slice(NEEDS_PREFIX.length).trim();
    if (need && !out.includes(need)) out.push(need);
  }
  return out;
}

/** "a CxOne account" / "a desktop computer" / a readable fallback. */
function needLabel(need) {
  return KNOWN_NEEDS[need] || `“${need}”`;
}

/**
 * Can this challenge be answered at this event?
 *
 * Returns `null` when it can, or `{code, message}` when it cannot. Takes ROWS,
 * like `resolveAttemptCap`, so a caller inside a write transaction pays no extra
 * read — and `tags` is passed in rather than fetched, because three of the five
 * call sites are loops that would otherwise issue one query per challenge.
 *
 * `comp` must carry `event_kind`; `eventPolicy` throws if it does not, which is
 * the intended behaviour for a caller that under-selected its columns (v7.29.0).
 */
function challengeFitError(task, comp, tags) {
  const pol = eventPolicy(comp);

  if (pol.refusesFileAnswers && task && task.answer_type === "file") {
    return {
      code: "file_answer_unsupported",
      message: `“${task.title}” is answered by uploading a file, which cannot be done at ${eventKindPhrase(comp)}. Change the answer type, or assign it to a different event.`,
    };
  }

  if (pol.refusesToolRequiringChallenges) {
    const needs = challengeNeeds(tags);
    if (needs.length) {
      return {
        code: "needs_tool",
        message: `“${task.title}” needs ${needs.map(needLabel).join(" and ")}, which a walk-up visitor at ${eventKindPhrase(comp)} will not have. Remove the ${needs.map(n => NEEDS_PREFIX + n).join(" / ")} tag, or assign it to a different event.`,
      };
    }
  }

  return null;
}

/** True when this kind constrains challenges at all — lets a caller skip the tag read. */
function eventConstrainsChallenges(comp) {
  const pol = eventPolicy(comp);
  return !!(pol.refusesFileAnswers || pol.refusesToolRequiringChallenges);
}

/**
 * Would this challenge, AS PROPOSED, break an event that already holds it?
 *
 * **THIS IS THE HALF THAT MAKES THE RULE A THEOREM RATHER THAN A CONVENTION**,
 * and it is the v7.29.0 sessionless-kind argument applied to challenges. Guarding
 * only the assign routes would let an admin reach the forbidden state by
 * REORDERING: assign an ordinary text challenge to a Booth Event, then edit it to
 * `answer_type='file'`, or tag it `needs:desktop`. Both ends move together, so
 * "no Booth Event holds a challenge nobody at it can answer" holds by
 * construction — which is what lets the PARTICIPANT surface stay untouched.
 *
 * Not filtering the participant list is a deliberate choice, not an omission. A
 * challenge that silently vanished from a participant's list while the admin's
 * assign screen still showed it assigned would be a fresh wrong answer, on two
 * screens that must agree; refusing the write that would create the state is the
 * honest place to act, and it names the event to the person who can fix it.
 *
 * Shaped after `taskFrozenByEndedCompetition` — takes an id, returns the first
 * blocking event or null, so callers read the same way.
 *
 * @param db          the database handle (passed in: this module stays a leaf)
 * @param taskId      the challenge being edited
 * @param nextTask    its PROPOSED state — `{title, answer_type}`
 * @param nextTags    its PROPOSED tag list
 */
function taskConflictingEvent(db, taskId, nextTask, nextTags) {
  // Lazy, so this module stays a leaf `lib/competitions.js` could import back.
  const { competitionStatus, competitionAnySlotEnded } = require("./competitions");
  const comps = db.prepare(
    `SELECT c.id, c.name, c.event_kind, c.start_time, c.duration_minutes, c.ended_at
       FROM competition_tasks ct JOIN competitions c ON c.id = ct.competition_id
      WHERE ct.task_id = ?`
  ).all(taskId);
  for (const comp of comps) {
    if (!eventConstrainsChallenges(comp)) continue;
    // AN ENDED EVENT IS DELIBERATELY NOT PROTECTED, for two independent reasons
    // that point the same way. Nobody can attempt a challenge at an event that is
    // over, so there is no participant to protect; and the remedy this refusal
    // names — unassign it from that event — is REFUSED once a session has ended
    // (`DELETE /api/admin/tasks/:id/competitions/:cid`). Blocking here would
    // rebuild the v7.29.0 frozen-competition trap: a refusal whose only suggested
    // way out the platform itself will not allow.
    if (competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp)) continue;
    const fit = challengeFitError(nextTask, comp, nextTags);
    // The assign-side message says "assign it to a different event", which is not
    // the action available here — the challenge is already assigned, so the
    // remedy is to unassign it or to leave the challenge as it is.
    if (fit) return { ...fit, competitionId: comp.id, competitionName: comp.name,
      message: `${fit.message.replace(/, or assign it to a different event\.$/, ".")} It is currently assigned to “${comp.name}”, so unassign it from that event first.` };
  }
  return null;
}

module.exports = {
  KNOWN_NEEDS,
  challengeFitError, eventConstrainsChallenges,
  taskConflictingEvent,
};
