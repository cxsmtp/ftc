"use strict";
//
// v8.1.0 (PR 34) — NET ACTIVE TIME: how long a participant was actually on the
// platform, as opposed to how long the event ran.
//
// Elapsed time already exists and is the wrong number for a multi-day event. A
// Competition running Friday to Monday reports ~72 hours for everybody, which
// ranks nobody and tells an organiser nothing; a Program running to a deadline a
// year out is worse. Net active time is the honest one — and on a score tie it is
// a far better discriminator than who happened to open the tab first.
//
// ── THE BUCKET IS FIVE MINUTES, AND THAT IS A ONE-WAY DOOR ───────────────────
//
// Every stored counter is a COUNT OF BUCKETS, not a duration, so changing the
// size silently re-scales all history: a row reading `84` would mean seven hours
// before the change and something else after, with nothing to distinguish them.
// It is defined once here and nothing derives its own.
//
// Five minutes is also what makes the write cheap enough to do on ordinary
// traffic: a participant polling every 15 s produces one write per bucket and
// 19 no-ops, and the no-op is a single indexed UPDATE that matches zero rows.
const BUCKET_MS = 5 * 60 * 1000;

const db = require("../db");
const { now } = require("./time");

/** Which bucket an instant falls in. Integer division — the only definition. */
function bucketOf(ms) {
  return Math.floor(ms / BUCKET_MS);
}

/**
 * Record that this participant was active in this event, right now.
 *
 * ── ONE STATEMENT, EXACTLY-ONCE BY CONSTRUCTION ──────────────────────────────
 *
 * `INSERT … SELECT … FROM competition_users … ON CONFLICT DO UPDATE … WHERE
 * last_bucket < excluded.last_bucket`.
 *
 *   * **Membership is enforced by the SELECT**, not by middleware ordering, and
 *     that is deliberate rather than defensive. `requireParticipantInCompetition`
 *     cannot be relied on here: `/api/status` and `/api/dismiss-ended` do not
 *     carry it, and it `return next()`s for STAFF before any membership read —
 *     so a staff member browsing an event they are not enrolled in would
 *     otherwise accrue presence in it. A `SELECT` that finds no membership row
 *     inserts nothing, which is the same answer with no ordering to get wrong.
 *
 *   * **The `WHERE last_bucket < excluded` on the conflict branch is what makes
 *     it idempotent.** A participant's tab polls several times per bucket; only
 *     the first write in a bucket increments, and the rest match zero rows. No
 *     read-then-write, so no race: two concurrent requests in the same bucket
 *     both attempt the UPDATE and SQLite serialises them, with the second seeing
 *     `last_bucket = excluded` and doing nothing.
 *
 * Returns true when this call actually counted a bucket. v8.3.11 — this used to
 * say "used only by /metrics", which was not true of anything: `/metrics` exposes
 * `hack_arena_presence_rows` and nothing else from this module, and no caller
 * reads the return value at all. It is kept because it is the only cheap witness
 * a test has that a specific request banked a bucket, and the comment now says so
 * rather than naming a consumer that does not exist (v7.21.14).
 */
function recordPresence(competitionId, userId, atMs) {
  const b = bucketOf(atMs === undefined ? now().getTime() : atMs);
  const iso = new Date(atMs === undefined ? now().getTime() : atMs).toISOString();
  const r = db.prepare(
    `INSERT INTO competition_presence (competition_id, user_id, buckets, last_bucket, first_seen_at, last_seen_at)
       SELECT cu.competition_id, cu.user_id, 1, ?, ?, ?
         FROM competition_users cu
        WHERE cu.competition_id = ? AND cu.user_id = ?
     ON CONFLICT(competition_id, user_id) DO UPDATE SET
       buckets      = buckets + 1,
       last_bucket  = excluded.last_bucket,
       last_seen_at = excluded.last_seen_at
      WHERE competition_presence.last_bucket < excluded.last_bucket`
  ).run(b, iso, iso, competitionId, userId);
  return r.changes > 0;
}

/** Net active time in ms for one (event, participant). 0 when never seen. */
function presenceMs(competitionId, userId) {
  const r = db.prepare("SELECT buckets FROM competition_presence WHERE competition_id=? AND user_id=?")
    .get(competitionId, userId);
  return r ? r.buckets * BUCKET_MS : 0;
}

/**
 * Net active time for EVERY participant in one event, as a Map.
 *
 * Batched because the leaderboard builder needs all of them at once and this is
 * the difference between one query and one per row — the N+1 shape v7.21.13
 * removed from three other builders.
 */
function presenceMsByUser(competitionId) {
  const out = new Map();
  for (const r of db.prepare("SELECT user_id, buckets FROM competition_presence WHERE competition_id=?").all(competitionId)) {
    out.set(r.user_id, r.buckets * BUCKET_MS);
  }
  return out;
}

/** Total presence rows, for /metrics. */
function presenceRowCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM competition_presence").get().c;
}

module.exports = {
  BUCKET_MS, bucketOf, recordPresence, presenceMs, presenceMsByUser,
  presenceRowCount,
};
