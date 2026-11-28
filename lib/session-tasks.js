"use strict";

// PER-SESSION QUESTION SETS (owner decision, 27 Nov 2026).
//
// "Competition sessions: each session can hold a different question set." A
// Competition's question is in EVERY session unless `competition_task_sessions`
// holds rows for it, which name the sessions it is in. No rows is the default
// and what every event that predates the table keeps, so an event nobody
// narrows behaves exactly as before: every fragment below is then true.
//
// A participant sees, answers, is scored on and FINISHES only the questions of
// their own session. The participant's session is `competition_users.timeslot_id`
// (locked once they enter a live session); the participant routes read the
// session the request names (`req.session.timeslotId`, which for a member is the
// same slot). With no session (staff looking at the event, a member who has not
// chosen one) every question counts: the union.
//
// THE ONE DEFINITION OF "IS THIS QUESTION IN THIS SESSION" is `inSessionSql`.
// Every SQL that counts an event's questions for a participant (the finish
// denominator and numerator, the board's finish time, the submit's fast path,
// the Overview's "solved every question") carries it;
// tests/session-counting-sites.spec.js holds the named sites and finds any other
// counting query that leaves it out without a recorded reason, on the model of
// the qualifying-question scanner.
//
// Pure apart from the `db` handed in, so lib/competitions.js and lib/attempts.js
// can require it without a cycle.

/**
 * SQL that is true when the question at (`compCol`, `taskCol`) is in the session
 * `slotExpr` (an SQL expression: `?`, `cu.timeslot_id`, `NULL`). The session
 * expression appears ONCE, so a `?` binds one value. NULL means every question.
 */
function inSessionSql(compCol, taskCol, slotExpr) {
  return `(NOT EXISTS (SELECT 1 FROM competition_task_sessions xs WHERE xs.competition_id=${compCol} AND xs.task_id=${taskCol})` +
    ` OR EXISTS (SELECT 1 FROM competition_task_sessions xs2 WHERE xs2.competition_id=${compCol} AND xs2.task_id=${taskCol}` +
    ` AND xs2.timeslot_id=COALESCE(${slotExpr}, xs2.timeslot_id)))`;
}

/** taskId -> [timeslot ids] for every question of the event narrowed to chosen sessions. */
function taskSessionsMap(db, competitionId) {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT task_id, timeslot_id FROM competition_task_sessions WHERE competition_id=? ORDER BY task_id, timeslot_id"
  ).all(competitionId)) {
    if (!out.has(r.task_id)) out.set(r.task_id, []);
    out.get(r.task_id).push(r.timeslot_id);
  }
  return out;
}

/** Is this question in this session? (A null session: every question is.) */
function taskInSession(db, competitionId, taskId, timeslotId) {
  return !!db.prepare(`SELECT 1 FROM competition_tasks ct WHERE ct.competition_id=? AND ct.task_id=? AND ${inSessionSql("ct.competition_id", "ct.task_id", "?")}`)
    .get(competitionId, taskId, timeslotId || null);
}

/**
 * Participant-route middleware, after `_resolveEventTask`: a question outside the
 * session this request plays answers the same 404 an unassigned one does, so it
 * can be neither read, answered, hinted, rated nor downloaded. `param` names the
 * route parameter holding the task id.
 */
function requireTaskInSession(db, param = "id") {
  return function requireTaskInSessionMw(req, res, next) {
    const compId = req.session && req.session.competitionId;
    const taskId = req.params && req.params[param];
    if (!compId || typeof taskId !== "string") return next();
    // Only a task assigned to the event can be narrowed; an unassigned one is the
    // route's own 404, answered after this.
    if (!db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, taskId)) return next();
    const slot = (req.session && req.session.timeslotId) || null;
    if (taskInSession(db, compId, taskId, slot)) return next();
    return res.status(404).json({ error: "Challenge not found" });
  };
}

// The refusals of a session-set change, by code. One table, so the route and
// the dialog say the same thing.
const TASK_SESSIONS_REFUSALS = Object.freeze({
  task_sessions_forbidden: "Only a Competition runs sessions, so only a Competition's questions can be in chosen sessions.",
  task_sessions_need_two: "Choosing sessions needs an event with two or more sessions.",
  task_sessions_unknown: "One of the sessions named is not a session of this event.",
  task_sessions_empty: "A question must be in at least one session. To take it out of the event, remove it from the event instead.",
  task_sessions_qualifying: "Quick (qualifying) questions are asked of everyone, so they stay in every session.",
  task_sessions_locked: "A session this change adds the question to or takes it from has started. A session's questions are fixed once it starts, so the people in it all answer the same set.",
});

/**
 * Decide a change of one question's sessions. `requested` is an array of
 * timeslot ids, or null for every session. Answers `{refusal:{status,code,error}}`
 * or `{next: [ids]|null, before: [ids]|null, changed: [ids]}` where `next` is
 * the normalised set (null when it names every session) and `changed` the
 * sessions whose questions the change moves.
 */
function decideTaskSessions({ comp, slots, isQualifying, current, requested, slotStatus }) {
  const refuse = (code, status = 400) => ({ refusal: { status, code, error: TASK_SESSIONS_REFUSALS[code] } });
  const { eventPolicy } = require("./event-policy");
  if (eventPolicy(comp).sessions !== "many") return refuse("task_sessions_forbidden");
  if (slots.length < 2) return refuse("task_sessions_need_two");
  const all = slots.map(s => s.id);
  let next = null;
  if (requested !== null) {
    const known = new Set(all);
    const asked = [...new Set(requested)];
    if (asked.some(id => !known.has(id))) return refuse("task_sessions_unknown");
    if (!asked.length) return refuse("task_sessions_empty");
    next = asked.length === all.length ? null : all.filter(id => asked.includes(id));
  }
  if (next !== null && isQualifying) return refuse("task_sessions_qualifying");
  const before = current && current.length ? all.filter(id => current.includes(id)) : null;
  const inBefore = new Set(before || all), inNext = new Set(next || all);
  const changed = all.filter(id => inBefore.has(id) !== inNext.has(id));
  const byId = new Map(slots.map(s => [s.id, s]));
  if (changed.some(id => slotStatus(byId.get(id)) !== "upcoming")) return refuse("task_sessions_locked", 409);
  return { next, before, changed };
}

/** Replace one question's sessions (inside the caller's transaction). `next` null: every session. */
function writeTaskSessions(db, competitionId, taskId, next) {
  db.prepare("DELETE FROM competition_task_sessions WHERE competition_id=? AND task_id=?").run(competitionId, taskId);
  if (next === null) return;
  const ins = db.prepare("INSERT INTO competition_task_sessions (competition_id, task_id, timeslot_id) VALUES (?,?,?)");
  for (const id of next) ins.run(competitionId, taskId, id);
}

/**
 * CLONE: carry a source event's session choices onto a copy, BY SESSION ORDER.
 * `slotMap` maps a source timeslot id to the copy's (the clone creates sessions
 * in the source's order, by start time); `taskMap` a source question id to its
 * copy in the new event. A choice naming a session the copy did not get (one
 * left out as too short) keeps the others; a question left with none, or
 * naming every session the copy has, is in every session (`sessionCount`: how
 * many sessions the copy has). Inside the caller's transaction. Returns how many questions
 * were narrowed.
 */
function carryTaskSessions(db, srcCompId, newCompId, { slotMap, taskMap, sessionCount }) {
  let n = 0;
  for (const [taskId, ids] of taskSessionsMap(db, srcCompId)) {
    const newTask = taskMap.get(taskId);
    if (!newTask) continue;
    const mapped = [...new Set(ids.map(id => slotMap.get(id)).filter(Boolean))];
    // None left, or every session the copy has: in every session (no rows).
    if (!mapped.length || mapped.length >= sessionCount) continue;
    writeTaskSessions(db, newCompId, newTask, mapped);
    n++;
  }
  return n;
}

module.exports = {
  inSessionSql, taskSessionsMap, taskInSession, requireTaskInSession,
  TASK_SESSIONS_REFUSALS, decideTaskSessions, writeTaskSessions, carryTaskSessions,
};
