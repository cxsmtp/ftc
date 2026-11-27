"use strict";

// PROGRAM GRADES (owner decision, 27 Nov 2026).
//
// A Program (event kind `program`: unranked, certificate `completion`) is not a
// competition: "every learner gets a certificate based on their performance on
// the challenges: above 90% Excellent, 80–90% Very good, 70–80% Good, 60–70%
// Satisfactory, and anything less: you should try the quiz again. The program
// should tell you where you stand."
//
// THE GRADE is the points the learner holds over the most the Program's
// challenges can give:
//   * points: the learner's score by the boards' own statements
//     (lib/leaderboard.js `scoreTotals` over `_scoreRows`): correct answers, less
//     every wrong-answer penalty and every hint bought, never a second sum;
//     floored at 0 and capped at the maximum (a challenge solved and then hidden
//     still scores, as on every board, but no longer counts in the maximum);
//   * maximum: the face value (lib/scoring.js POINTS) of every published, active
//     SCORING challenge assigned to the Program: a qualifying (Quick) question
//     scores nothing and is left out (`notQualifyingSql`).
// Bands are inclusive at their lower edge (exactly 90% is Excellent) and decided
// on the exact fraction in integers, never a rounded percentage (59.96% is not
// 60%). The percentage shown is the fraction in tenths of a percent, ROUNDED
// DOWN, so it never reads as a band the learner did not reach.
//
// WHEN: the grade counts once the learner has FINISHED, every scoring challenge
// solved or out of attempts (lib/attempts.js `participantsFinishedAll`, the
// auto-end's own predicate, for one person). Programs have no default attempt
// cap, so without one that is "solved everything". Before then the learner is
// shown where they stand so far; nothing is issued.
//
// AT 60% OR MORE the learner's completion certificate is issued (routes/badge.js
// `_mintEligibility`, the one predicate) with the band and percentage FROZEN on
// it (`achievement_badges.grade_band`, `grade_permille`). UNDER 60% nothing is
// issued: the learner is told to try again, and may (`startProgramRetake`) while
// the Program is live. A learner who passed may not retake to improve: their
// certificate is a fact once issued (the decision the owner is asked to confirm).
//
// The pure half (bands, the fraction, the wording) requires nothing; the database
// half requires its modules lazily, so a spec may require this file at module
// scope.

const GRADE_BANDS = Object.freeze([
  Object.freeze({ key: "excellent", min: 90, label: "Excellent" }),
  Object.freeze({ key: "very_good", min: 80, label: "Very good" }),
  Object.freeze({ key: "good", min: 70, label: "Good" }),
  Object.freeze({ key: "satisfactory", min: 60, label: "Satisfactory" }),
]);
const GRADE_BAND_KEYS = Object.freeze(GRADE_BANDS.map(b => b.key));
// Under the lowest band: no certificate, and the learner is told to try again.
const TRY_AGAIN = Object.freeze({ key: "try_again", label: "Try again" });
const PASS_PERCENT = GRADE_BANDS[GRADE_BANDS.length - 1].min;

/**
 * The grade for `points` out of `max`. Null when there is nothing to grade
 * against (no scoring challenge). `{points, max, permille, band, label, passed}`:
 * `points` clamped to [0, max], `permille` the share in tenths of a percent
 * rounded down, `band` a GRADE_BANDS key or `try_again`.
 */
function gradeFromPoints(points, max) {
  const m = Number.isFinite(max) && max > 0 ? Math.round(max) : 0;
  if (!m) return null;
  const p = Math.min(m, Math.max(0, Math.round(Number(points) || 0)));
  const band = GRADE_BANDS.find(b => p * 100 >= b.min * m) || null;
  return {
    points: p,
    max: m,
    permille: Math.floor((p * 1000) / m),
    band: band ? band.key : TRY_AGAIN.key,
    label: band ? band.label : TRY_AGAIN.label,
    passed: !!band,
  };
}

/** The words for a band key ("Very good"); null for an unknown one. */
function gradeLabel(key) {
  if (key === TRY_AGAIN.key) return TRY_AGAIN.label;
  const b = GRADE_BANDS.find(x => x.key === key);
  return b ? b.label : null;
}

/** "94%" or "59.9%" from tenths of a percent; null for a missing value. */
function formatGradePercent(permille) {
  if (!Number.isFinite(permille)) return null;
  const p = Math.max(0, Math.min(1000, Math.floor(permille)));
  return p % 10 === 0 ? `${p / 10}%` : `${(p / 10).toFixed(1)}%`;
}

/** Is this event graded (a completion-certificate kind: a Program)? */
function programGraded(comp) {
  if (!comp) return false;
  return require("./event-policy").eventPolicy(comp).certificate === "completion";
}

/** The most this Program's scoring challenges can give. */
function programMaxPoints(competitionId) {
  const db = require("../db");
  const { POINTS } = require("./scoring");
  const { notQualifyingSql } = require("./qualifying");
  const rows = db.prepare(
    `SELECT t.difficulty FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
      WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}`
  ).all(competitionId);
  let max = 0;
  for (const r of rows) max += POINTS[r.difficulty] || 0;
  return max;
}

/** How many attempts this learner has closed (Try again) on this Program. */
function closedAttempts(competitionId, userId) {
  const db = require("../db");
  return db.prepare("SELECT COUNT(*) AS c FROM program_attempts WHERE competition_id=? AND user_id=?")
    .get(competitionId, userId).c;
}

/**
 * Where this learner stands on this Program, now: `{finished, grade, attempt}`
 * (grade: `gradeFromPoints`, null with no scoring challenge; attempt: the
 * current attempt's number, 1 until they try again). Only for a graded event.
 */
function programStanding(userId, comp) {
  const { publishedTaskCount } = require("./competitions");
  const { participantsFinishedAll } = require("./attempts");
  const { scoreTotals } = require("./leaderboard");
  const total = publishedTaskCount(comp.id);
  const finished = total > 0 && participantsFinishedAll([userId], comp.id, total);
  const points = scoreTotals(comp.id, [userId]).get(userId) || 0;
  const grade = gradeFromPoints(points, programMaxPoints(comp.id));
  return { finished, grade, attempt: closedAttempts(comp.id, userId) + 1 };
}

/**
 * Why this learner may not try this Program again now, or null when they may.
 * `{status, code, error}`. Asked by the route before its write and again inside
 * it, and by the learner's standing (so Try again is offered exactly where the
 * route accepts it).
 */
function retakeRefusal(userId, comp, standing = null) {
  const db = require("../db");
  const { competitionStatus } = require("./competitions");
  if (!programGraded(comp)) {
    return { status: 400, code: "not_a_program", error: "Only a Program can be taken again." };
  }
  if (competitionStatus(comp) !== "live") {
    return { status: 409, code: "program_not_live", error: "This program is not running, so it cannot be taken again." };
  }
  if (!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId)) {
    return { status: 403, code: "not_member", error: "You are not in this program." };
  }
  const st = standing || programStanding(userId, comp);
  if (!st.grade || !st.finished) {
    return { status: 409, code: "program_not_finished", error: "Finish every challenge first: your grade counts once you have." };
  }
  if (st.grade.passed) {
    return { status: 409, code: "program_passed", error: "You passed this program, so there is nothing to take again." };
  }
  if (db.prepare("SELECT 1 FROM achievement_badges WHERE user_id=? AND competition_id=? AND revoked_at IS NULL").get(userId, comp.id)) {
    return { status: 409, code: "certificate_held", error: "You hold a certificate for this program already." };
  }
  return null;
}

/**
 * TRY AGAIN: close the learner's current attempt and start a fresh one.
 *
 * In ONE immediate transaction, re-asking `retakeRefusal` inside it: the
 * attempt's grade is written to `program_attempts` with its answers and hints
 * to the Program's SCORING challenges (each row as stored, as JSON), and those
 * rows leave `submissions` and `hint_reveals`, so every reader of a score, a
 * solve, an attempt count or a hint sees the new attempt alone. Quick
 * (qualifying) answers stay. Recorded on the learner's History as
 * `program_retake_started` with `context` (the request's, reqContext).
 *
 * Returns `{ok:true, attempt, closed}` or the refusal.
 */
function startProgramRetake(userId, comp, { changedBy, context = {} } = {}) {
  const db = require("../db");
  const crypto = require("crypto");
  const { notQualifyingSql } = require("./qualifying");
  const { recordUserEvent, runTxnWithMirrorBuffer } = require("./audit");
  const { now } = require("./time");
  let out = null;
  const txn = db.transaction(() => {
    const standing = programStanding(userId, comp);
    const refused = retakeRefusal(userId, comp, standing);
    if (refused) { out = refused; return; }
    const subs = db.prepare(
      `SELECT s.* FROM submissions s JOIN tasks t ON t.id=s.task_id
        WHERE s.user_id=? AND s.competition_id=? AND ${notQualifyingSql("t")} ORDER BY s.submitted_at, s.rowid`
    ).all(userId, comp.id);
    const hints = db.prepare(
      `SELECT h.* FROM hint_reveals h JOIN tasks t ON t.id=h.task_id
        WHERE h.user_id=? AND h.competition_id=? AND ${notQualifyingSql("t")} ORDER BY h.revealed_at`
    ).all(userId, comp.id);
    const closedNo = standing.attempt;
    const g = standing.grade;
    db.prepare(
      `INSERT INTO program_attempts (id, competition_id, user_id, attempt_no, points, max_points, grade_permille,
         grade_band, submissions_json, hints_json, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(crypto.randomUUID(), comp.id, userId, closedNo, g.points, g.max, g.permille, g.band,
      JSON.stringify(subs), JSON.stringify(hints), now().toISOString());
    const delSub = db.prepare("DELETE FROM submissions WHERE id=?");
    for (const s of subs) delSub.run(s.id);
    const delHint = db.prepare("DELETE FROM hint_reveals WHERE competition_id=? AND user_id=? AND task_id=?");
    for (const h of hints) delHint.run(h.competition_id, h.user_id, h.task_id);
    recordUserEvent(userId, "program_retake_started", changedBy || "system", {
      competition_id: comp.id,
      attempt: closedNo + 1,
      closed_attempt: closedNo,
      points: g.points,
      max_points: g.max,
      grade_permille: g.permille,
      grade_band: g.band,
      answers_kept: subs.length,
      hints_kept: hints.length,
      ...context,
    });
    out = { ok: true, attempt: closedNo + 1, closed: { attempt: closedNo, ...g } };
  });
  runTxnWithMirrorBuffer(() => txn.immediate());
  if (out && out.ok) {
    try { require("./leaderboard").invalidateLeaderboardCache(comp.id); } catch (e) { require("./best-effort").swallowed("program-grade:lb-bust", e); }
    try { require("./me-cache")._invalidateMeCache(userId); } catch (e) { require("./best-effort").swallowed("program-grade:me-bust", e); }
  }
  return out;
}

/** The learner's closed attempts, oldest first (no answers: the grade only). */
function closedAttemptGrades(competitionId, userId) {
  const db = require("../db");
  return db.prepare(
    `SELECT attempt_no, points, max_points, grade_permille, grade_band, closed_at FROM program_attempts
      WHERE competition_id=? AND user_id=? ORDER BY attempt_no`
  ).all(competitionId, userId);
}

module.exports = {
  GRADE_BANDS, GRADE_BAND_KEYS, TRY_AGAIN, PASS_PERCENT,
  gradeFromPoints, gradeLabel, formatGradePercent,
  programGraded, programMaxPoints, programStanding, closedAttempts, closedAttemptGrades,
  retakeRefusal, startProgramRetake,
};
