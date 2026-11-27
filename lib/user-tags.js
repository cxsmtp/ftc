"use strict";

// User-tag reads + the short-TTL per-user tag cache. (Domain: Participant tags.
// Code/table term: `user_tags`.) Backs isStaff / isBenchmark on the hot path
// (requireParticipantInCompetition + leaderboard staff/benchmark filtering).
// Deps: db only. Tag-mutation handlers (in server.js routes) call
// _invalidateUserTagsCache after a write; the 2s TTL is the safety net.
// (v7.0.0 refactor: extracted verbatim from server.js.)

const db = require("../db");

// v6.20.x — short-TTL per-user cache. isStaff(userId) runs FIRST on every
// hot-path request (requireParticipantInCompetition gates submit / hint /
// leaderboard), and getUserTags backs isStaff/isBenchmark —
// each an uncached `SELECT tag FROM user_tags` per call. Tags are near-static
// during a live event, so a 2s TTL collapses the per-request reads while
// bounding staleness to 2s. Mirrors the _meCache design (TTL + size cap). The
// tag-mutation handlers also call _invalidateUserTagsCache for promptness; the
// TTL is the safety net that bounds any missed writer (a missed explicit
// invalidation can't leak beyond 2s, unlike an explicit-only cache).
const _userTagsCache = new Map(); // userId → { ts, tags }
const _USER_TAGS_TTL_MS = 2_000;
const _USER_TAGS_MAX = 5_000;
function _invalidateUserTagsCache(userId) { if (userId) _userTagsCache.delete(userId); else _userTagsCache.clear(); }
function getUserTags(userId) {
  const cached = _userTagsCache.get(userId);
  if (cached && (Date.now() - cached.ts) < _USER_TAGS_TTL_MS) return cached.tags;
  const tags = db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(userId).map(r => r.tag);
  if (_userTagsCache.size >= _USER_TAGS_MAX) {
    const oldest = _userTagsCache.keys().next().value;
    if (oldest !== undefined) _userTagsCache.delete(oldest);
  }
  _userTagsCache.set(userId, { ts: Date.now(), tags });
  return tags;
}
function isStaff(userId) { return getUserTags(userId).includes("staff"); }
function isBenchmark(userId) { return getUserTags(userId).includes("benchmark"); }

/**
 * Batch: the user IDs EXCLUDED FROM SCORING — staff, benchmark, or an event
 * admin.
 *
 * v8.7.0 — `event_admin` is excluded BY ROLE rather than by being auto-tagged
 * `staff` on promotion, and the distinction is load-bearing rather than
 * stylistic. The `staff` TAG carries two further powers that would each break a
 * stated requirement of the role:
 *
 *   - `isStaff(userId)` short-circuits membership entirely
 *     (`requireParticipantInCompetition` → `return next()`), so a tagged event
 *     admin could enter EVERY competition on the platform as a participant; and
 *   - `listParticipantCompetitions(..., {staff:true})` is an UNFILTERED
 *     `SELECT … FROM competitions`, so their participant picker would list the
 *     whole platform.
 *
 * Both directly contradict "an event admin's participant view is restricted to
 * their own events". Excluding by role gives the intended outcome — they never
 * appear on a leaderboard and never count toward the all-solved denominator —
 * with neither side effect, and it cannot be undone by removing a tag.
 */
/**
 * v8.12.0 — `{staffCompete}` LIFTS the staff half. On an event whose "Staff can
 * compete" switch is on, the `staff` tag and the `event_admin` role stop
 * excluding anybody — TOGETHER, because lifting one would put a global admin on
 * the board while the event admin beside them stays off it. `benchmark` is
 * untouched: a reference score is a reference score whoever holds it. The
 * caller passes the fact rather than this module reading the row, so a
 * competition-less caller (the analytics default filter) keeps today's answer.
 */
function getStaffOrBenchmarkSet(userIds, { staffCompete = false } = {}) {
  if (!userIds.length) return new Set();
  const ph = "SELECT value FROM json_each(?)";
  const rows = staffCompete
    ? db.prepare(
        `SELECT DISTINCT u.id AS user_id
           FROM users u
           JOIN user_tags t ON t.user_id = u.id AND t.tag = 'benchmark'
          WHERE u.id IN (${ph})`
      ).all(JSON.stringify(userIds))
    : db.prepare(
        `SELECT DISTINCT u.id AS user_id
           FROM users u
           LEFT JOIN user_tags t ON t.user_id = u.id AND t.tag IN ('staff','benchmark')
          WHERE u.id IN (${ph}) AND (t.user_id IS NOT NULL OR u.role IN (SELECT value FROM json_each(?)))`
      ).all(JSON.stringify(userIds), offBoardRolesJson());
  return new Set(rows.map(r => r.user_id));
}

/**
 * THE ROLE HALF of the exclusion above: every grant-scoped role (RBAC class
 * `granted`: the built-in event admin and any custom role of that class), as ONE
 * JSON list to bind into `json_each(?)`, so no statement's text varies with the
 * roles that exist. The one definition read by getStaffOrBenchmarkSet, the board
 * builder (lib/leaderboard.js) and the workspace Overview's pulse
 * (routes/event-overview.js), and per person by `isOffBoardRole`
 * (lib/competitions.js userScoresOn), so none of them can disagree about which
 * roles are off the board where staff do not compete.
 */
const OFF_BOARD_ROLE_CLASS = "granted";
function offBoardRolesJson() {
  return JSON.stringify(require("./rbac").roleIdsOfClass(OFF_BOARD_ROLE_CLASS));
}
function isOffBoardRole(role) {
  return !!role && require("./rbac").roleClass(role) === OFF_BOARD_ROLE_CLASS;
}

function _userTagsCacheSize() { return _userTagsCache.size; }

module.exports = {
  isStaff, isBenchmark, getStaffOrBenchmarkSet, offBoardRolesJson, isOffBoardRole,
  _invalidateUserTagsCache, _userTagsCacheSize,
};
