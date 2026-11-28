// v8.1.0 — attempt caps: the resolver, the per-participant state, and the
// "finished with a challenge" predicate the auto-end and revive paths need.
//
// WHY THE CAP LIVES ON `tasks` AND `competitions`, NEVER ON `competition_tasks`.
// A pair-keyed cap is destroyed by any unassign: `routes/challenges.js` diffs a
// challenge's competition set by DELETE-then-INSERT, so removing a competition
// and putting it back — an ordinary admin correction — would silently discard the
// cap with nothing erroring. It also has no export: `competition_tasks` carries
// the assignment, not the challenge, so the cap would not survive a migration to
// another platform. Two nullable columns survive both.
//
// MOST-SPECIFIC-WINS. A cap on the challenge beats a cap on the event, because
// the reason to cap one challenge (a guessable answer) has nothing to do with the
// reason to cap an event (an exam). `??`, not `||`: a stored 0 must not fall
// through to the event's cap — see the boundary note below.
//
// A HINT DOES NOT CONSUME AN ATTEMPT. A hint already costs 30% of the challenge's
// points, and charging twice for one act of asking for help is a rule nobody
// would predict from the label "3 attempts left".
const db = require("../db");
const { now } = require("./time");
const { notQualifyingSql, qualifyingSql, changeableQuickQuestion } = require("./qualifying");
const { inSessionSql } = require("./session-tasks");   // per-session question sets: each participant finishes their own session's questions   // event team reports: qualifying challenges do not count; a changeable Quick question is never out of attempts

// A cap is a whole number of attempts, at least one. ZERO IS REFUSED AT THE
// BOUNDARY rather than stored: a challenge nobody may attempt is expressible
// already (unpublish it, or do not assign it), and a stored 0 would make the
// most-specific-wins `??` chain answer "capped at nothing" in a way no admin
// typing into a form intends. NULL is the only "no cap" value.
const ATTEMPT_CAP_MIN = 1;
// The ceiling exists so the number stays a number a human can reason about on a
// participant's screen; it is not a storage limit.
const ATTEMPT_CAP_MAX = 1000;

/**
 * The cap in force for one (challenge, event) pair, before grants.
 * `null` means uncapped.
 *
 * Takes ROWS rather than ids so a caller that already holds them — the submit
 * transaction does, inside its write transaction — pays no extra read, and so a caller
 * that under-selects its columns fails loudly here rather than silently
 * resolving to "uncapped". An absent `attempt_cap` KEY is a programming error the
 * same way a missing `event_kind` is (v7.29.0); an absent VALUE is simply no cap.
 */
function resolveAttemptCap(task, comp) {
  if (task && !("attempt_cap" in task)) {
    throw new Error("resolveAttemptCap: task row has no attempt_cap column — the caller under-selected");
  }
  if (comp && !("attempt_cap" in comp)) {
    throw new Error("resolveAttemptCap: competition row has no attempt_cap column — the caller under-selected");
  }
  const t = task && task.attempt_cap;
  const c = comp && comp.attempt_cap;
  const cap = (t ?? c ?? null);
  return Number.isInteger(cap) && cap > 0 ? cap : null;
}

/** Extra attempts an admin has granted this participant on this challenge. */
function grantedAttempts(userId, taskId, competitionId) {
  const r = db.prepare(
    "SELECT extra_attempts AS n FROM attempt_grants WHERE user_id=? AND task_id=? AND competition_id=?"
  ).get(userId, taskId, competitionId);
  return r ? r.n : 0;
}

/**
 * Attempts already spent on this (participant, challenge, event).
 *
 * An ATTEMPT IS A STORED SUBMISSION ROW, which is what makes the number the
 * participant is shown match the number that was actually charged: a de-duplicated
 * re-send (the same answer inside 3 s) and a velocity-throttled 429 both return
 * BEFORE the INSERT, so neither writes a row and neither costs an attempt. A
 * double-click therefore cannot spend two.
 */
function attemptsUsed(userId, taskId, competitionId) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM submissions WHERE user_id=? AND task_id=? AND competition_id=?"
  ).get(userId, taskId, competitionId).c;
}

/**
 * Everything a caller needs about one participant's standing on one challenge.
 *
 * `cap` is the BASE cap and `effective` is base + grants, because the participant
 * surface says "N attempts left" and an admin's grant has to move that number
 * without the base looking as if it changed.
 *
 * v8.13.2 (external audit) — `used` IS THE REAL COUNT FOR EVERY CHALLENGE, capped
 * or not. It used to read 0 on an uncapped one, because only a cap needed it —
 * but the challenge card prints "N attempt(s)" for every challenge, and the
 * submit response had no count to give an uncapped card after a wrong answer,
 * so the header kept the number from when the challenge was opened. One indexed
 * COUNT, and the card's number and the submit's number are now the same query.
 */
function attemptState(userId, task, comp) {
  const cap = resolveAttemptCap(task, comp);
  const used = (task && comp) ? attemptsUsed(userId, task.id, comp.id) : 0;
  return _standing(cap, cap === null ? 0 : grantedAttempts(userId, task.id, comp.id), used);
}

// THE STANDING FROM ITS THREE FACTS — the cap in force (null: uncapped), the
// attempts granted on top of it and the attempts stored. The one definition of
// `left` and `exhausted`, shared by `attemptState` (one challenge) and
// `outOfAttemptsTaskIds` (a whole list), so the list never calls a challenge
// spent that its own read would not.
function _standing(cap, granted, used) {
  if (cap === null) return { capped: false, cap: null, granted: 0, effective: null, used, left: null, exhausted: false };
  const effective = cap + granted;
  return {
    capped: true, cap, granted, effective, used,
    left: Math.max(0, effective - used),
    exhausted: used >= effective,
  };
}

/**
 * #283 — THE CHALLENGES ONE PARTICIPANT HAS NO ATTEMPTS LEFT ON, for a whole
 * list at once: GET /api/tasks's `out_of_attempts`, which Next challenge reads
 * to pass over a challenge that would open as "No attempts left". Exactly
 * `attemptState(...).exhausted` per challenge (`_standing`: the cap in force,
 * most-specific-wins, plus this participant's grants, all spent), read in three
 * queries for the whole list rather than two per challenge, as the list is read
 * on every visit to it.
 *
 * Never in the set:
 *   • an uncapped challenge;
 *   • a SOLVED one: solving finished it, and running out of attempts is the
 *     other way to finish one (`participantsFinishedAllDetail`); its card is
 *     the solved one;
 *   • a Quick question whose answer can be changed (`changeableQuickQuestion`,
 *     lib/qualifying.js): the submit takes a new pick past the cap.
 *
 * `comp` is the event row (with `attempt_cap`); `taskIds` the challenges to
 * judge. Their rows are read here, so the raw cap never has to ride the
 * caller's SELECT (and from there the participant wire). A Set of task ids.
 */
function outOfAttemptsTaskIds(userId, comp, taskIds) {
  const out = new Set();
  if (!comp || !Array.isArray(taskIds) || !taskIds.length) return out;
  const ph = "SELECT value FROM json_each(?)";
  const caps = new Map();
  for (const r of db.prepare(
    `SELECT t.id, t.attempt_cap, t.answer_type, t.choices, ${qualifyingSql("t")} AS qualifying
       FROM tasks t WHERE t.id IN (${ph})`
  ).all(JSON.stringify(taskIds))) {
    const cap = resolveAttemptCap(r, comp);
    if (cap !== null && !changeableQuickQuestion(r, !!r.qualifying)) caps.set(r.id, cap);
  }
  if (!caps.size) return out;
  const ids = JSON.stringify([...caps.keys()]);
  const grants = new Map(db.prepare(
    `SELECT task_id, extra_attempts FROM attempt_grants WHERE user_id=? AND competition_id=? AND task_id IN (${ph})`
  ).all(userId, comp.id, ids).map(r => [r.task_id, r.extra_attempts]));
  // A challenge with nothing stored has every attempt left (a cap is at least 1),
  // so only the ones with rows can be spent.
  for (const s of db.prepare(
    `SELECT task_id, COUNT(*) AS used, MAX(is_correct) AS solved FROM submissions
      WHERE user_id=? AND competition_id=? AND task_id IN (${ph}) GROUP BY task_id`
  ).all(userId, comp.id, ids)) {
    if (s.solved) continue;
    if (_standing(caps.get(s.task_id), grants.get(s.task_id) || 0, s.used).exhausted) out.add(s.task_id);
  }
  return out;
}

/**
 * THE AUTO-END AND REVIVE PREDICATE.
 *
 * A participant is finished with a challenge when they hold a correct submission
 * **or** have no attempts left on it. Without the second clause a permanently
 * exhausted participant makes a capped event NEVER auto-end — every other
 * participant is done, the board cannot change, and the event runs to its
 * deadline with nothing happening.
 *
 * Deliberately computed in JS over three cheap grouped reads rather than as one
 * correlated-subquery join: the cap resolution is a two-level `??` plus a
 * per-participant grant, which SQL can express only as a pile of COALESCEs that
 * would then be a SECOND definition of most-specific-wins. One definition,
 * applied here.
 *
 * Uncapped is the identity case: with no caps anywhere, `finished` is exactly
 * "holds a correct submission", which is what this replaced.
 */
function participantsFinishedAll(participantIds, competitionId, totalTasks) {
  return participantsFinishedAllDetail(participantIds, competitionId, totalTasks).finished;
}

/**
 * v8.3.11 — the same predicate, plus WHY.
 *
 * `{ finished, exhausted }` — `exhausted` is how many of them are finished
 * without having solved everything. The auto-end needs it because since v8.1.0
 * "finished" means solved OR out of attempts, while both `auto_ended` emits still
 * recorded `reason:"all_participants_solved"` and five shipped sentences repeated
 * it. Under an attempt cap that is simply false, and the History dialog is where
 * an admin goes to find out what happened.
 *
 * Derived in the loop that already knows, NOT by a second query at the call site.
 * "Has this participant solved every counted task" would otherwise become the
 * third hand-written copy in the tree, and a numerator computed against a
 * different task set from the denominator would make a NEW false claim in place
 * of the old one — the v7.21.13 duplication class.
 *
 * `participantsFinishedAll` keeps returning a plain boolean because `allSolved`
 * is a documented wire field on both revive responses; changing its type would
 * be a silent contract break for one extra integer.
 */
function participantsFinishedAllDetail(participantIds, competitionId, totalTasks) {
  const NO = { finished: false, exhausted: 0 };
  if (!participantIds.length || totalTasks <= 0) return NO;
  const ph = "SELECT value FROM json_each(?)";

  // The challenges that COUNT, PER PARTICIPANT — the same assigned + active +
  // published set `publishedTaskCount` measures, narrowed to the participant's
  // own session's questions (per-session question sets, lib/session-tasks.js:
  // a participant finishes the questions of their own session, never the
  // others'), so the numerator and the denominator cannot disagree about which
  // challenges are in play (v7.21.13). A participant with no row here (staff
  // admitted without one) has no challenges, so is never finished.
  const userTasks = new Map(participantIds.map(id => [id, []]));
  for (const r of db.prepare(
    `SELECT cu.user_id, t.id, t.attempt_cap
       FROM competition_users cu
       JOIN competition_tasks ct ON ct.competition_id=cu.competition_id
       JOIN tasks t ON t.id=ct.task_id
      WHERE cu.competition_id=? AND cu.user_id IN (${ph}) AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}
        AND ${inSessionSql("ct.competition_id", "ct.task_id", "cu.timeslot_id")}`
  ).all(competitionId, JSON.stringify(participantIds))) {
    if (userTasks.has(r.user_id)) userTasks.get(r.user_id).push(r);
  }

  const comp = db.prepare("SELECT id, attempt_cap FROM competitions WHERE id=?").get(competitionId);
  if (!comp) return NO;

  const per = db.prepare(
    `SELECT s.user_id, s.task_id, MAX(s.is_correct) AS solved, COUNT(*) AS attempts
       FROM submissions s
       JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=?
       JOIN tasks t ON t.id=s.task_id
       JOIN competition_users cu ON cu.competition_id=s.competition_id AND cu.user_id=s.user_id
      WHERE s.user_id IN (${ph}) AND s.competition_id=? AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}
        AND ${inSessionSql("ct.competition_id", "ct.task_id", "cu.timeslot_id")}
      GROUP BY s.user_id, s.task_id`
  ).all(competitionId, JSON.stringify(participantIds), competitionId);

  const grants = db.prepare(
    `SELECT user_id, task_id, extra_attempts FROM attempt_grants
      WHERE competition_id=? AND user_id IN (${ph})`
  ).all(competitionId, JSON.stringify(participantIds));

  // A visible separator, not a control byte. Both halves are UUIDs (hex and
  // dashes), so `|` cannot appear in either and the key is unambiguous — and a
  // literal control character in source is invisible in review, which is why the
  // repo forbids one outright (v7.26.0).
  const key = (u, t) => `${u}|${t}`;
  const act = new Map(per.map(r => [key(r.user_id, r.task_id), r]));
  const grant = new Map(grants.map(r => [key(r.user_id, r.task_id), r.extra_attempts]));

  // v8.3.11 — `exhausted` counts the participants who are finished but did NOT
  // solve everything, so the auto-end can say WHY it fired. It is derived HERE,
  // inside the loop that already knows, rather than by a second query at the call
  // site: "has this participant solved every counted task" would then be the THIRD
  // hand-written copy of that question in the tree (the submit path's fast-path
  // COUNT is the second), and a numerator computed against a different task set
  // from the denominator is the v7.21.13 drift class making a new false claim
  // instead of the old one.
  let exhausted = 0;
  for (const uid of participantIds) {
    const tasks = userTasks.get(uid) || [];
    // Zero challenges is never finished (the `total <= 0` rule, per participant).
    if (!tasks.length) return NO;
    let finished = 0;
    let solved = 0;
    for (const t of tasks) {
      const a = act.get(key(uid, t.id));
      if (a && a.solved) { finished++; solved++; continue; }
      const cap = resolveAttemptCap(t, comp);
      if (cap === null) continue;                       // uncapped and unsolved → not finished
      const used = a ? a.attempts : 0;
      if (used >= cap + (grant.get(key(uid, t.id)) || 0)) finished++;
    }
    if (finished < tasks.length) return NO;
    if (solved < tasks.length) exhausted++;
  }
  return { finished: true, exhausted };
}

/**
 * Record an admin grant. Accumulates, so two admins each granting one attempt
 * gives two — an `INSERT OR REPLACE` would silently discard the first, and the
 * admin who made it would have no way to tell.
 */
function grantAttempts(userId, taskId, competitionId, extra) {
  const iso = now().toISOString();
  db.prepare(
    `INSERT INTO attempt_grants (user_id, task_id, competition_id, extra_attempts, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, task_id, competition_id)
     DO UPDATE SET extra_attempts = extra_attempts + excluded.extra_attempts, updated_at = excluded.updated_at`
  ).run(userId, taskId, competitionId, extra, iso);
  return grantedAttempts(userId, taskId, competitionId);
}

module.exports = {
  ATTEMPT_CAP_MIN, ATTEMPT_CAP_MAX,
  resolveAttemptCap, attemptState, outOfAttemptsTaskIds,
  participantsFinishedAll, participantsFinishedAllDetail, grantAttempts,
};
