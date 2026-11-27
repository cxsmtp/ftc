"use strict";
// SWEEP #91 — WHAT A CHALLENGE'S ANSWERS ARE WORTH FOLLOWS WHETHER IT IS A
// QUALIFYING QUESTION.
//
// Making a challenge a qualifying question, or a qualifying question a scoring
// challenge again, changes what its answers are worth: a qualifying question
// scores nothing, right or wrong, and its hint costs nothing (lib/qualifying.js);
// a scoring challenge earns its difficulty's points, loses the wrong-answer
// penalty and charges the hint cost. The answers ALREADY given kept their old
// points while new ones got the new value, and the board summed both. So the
// stored answers and hint costs are priced as Recalculate would price them now,
// in every event holding the challenge. Points only: whether an answer was right
// does not change.
//
// THE WRITERS: the tag doors and a version restore (routes/challenges.js) and the
// challenge import's overwrite (server.js), each calling this INSIDE its own
// transaction, so the `scores_recalculated` rows it records roll back with the
// change. Each of them refuses (or skips) a challenge in an event with an ended
// session, and a locked one, first, so nothing frozen is re-priced here. The
// caller busts, after its commit, the boards and the members' /api/me of the
// events this answers.
const db = require("../db");
const { POINTS, PENALTY, HINT_DEDUCTION_RATE } = require("./scoring");
const { isQualifyingTask } = require("./qualifying");
const { now } = require("./time");
const { recordCompetitionEvent } = require("./audit");

/**
 * Re-price the stored answers and hint costs of `taskId` in every event holding
 * it, at what it is worth now. `reason` names the change on each event's History
 * (`qualifying_tag_added`, `qualifying_tag_removed`, `restore`, `import`);
 * `actor` and `context` are the request's (`getAdminIdentity(req)`,
 * `reqContext(req)`). Records `scores_recalculated` on each event whose stored
 * rows moved. Answers the ids of the events holding the challenge.
 */
function rescoreAfterQualifyingFlip(taskId, reason, actor, context = {}) {
  const held = db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(taskId).map(r => r.competition_id);
  const t = db.prepare("SELECT title, difficulty FROM tasks WHERE id=?").get(taskId);
  if (!t || POINTS[t.difficulty] == null) return held;
  const q = isQualifyingTask(db, taskId);
  const correctPts = q ? 0 : POINTS[t.difficulty];
  const wrongPts = q ? 0 : -PENALTY;
  const hintCost = Math.round(correctPts * HINT_DEDUCTION_RATE);
  const at = now().toISOString();
  const subs = db.prepare(
    `UPDATE submissions SET points_delta = CASE WHEN is_correct=1 THEN ? ELSE ? END, updated_at=?
      WHERE task_id=? AND competition_id=? AND points_delta IS NOT (CASE WHEN is_correct=1 THEN ? ELSE ? END)`);
  const hints = db.prepare("UPDATE hint_reveals SET points_deducted=?, updated_at=? WHERE task_id=? AND competition_id=? AND points_deducted IS NOT ?");
  for (const cid of held) {
    const s = subs.run(correctPts, wrongPts, at, taskId, cid, correctPts, wrongPts).changes;
    const h = hints.run(hintCost, at, taskId, cid, hintCost).changes;
    if (s || h) {
      recordCompetitionEvent(cid, "scores_recalculated", actor, {
        task_id: taskId, task_title: t.title, reason, submissions_rescored: s, hints_rescaled: h, ...context,
      });
    }
  }
  return held;
}

module.exports = { rescoreAfterQualifyingFlip };
