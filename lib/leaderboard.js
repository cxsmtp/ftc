"use strict";

// Leaderboard aggregation + the 5-second leaderboard cache. (Domain: derived
// from Submission / Participant / Competition.) Reads submissions, hint_reveals,
// competition_users, competition_user_absences, user_tags + tasks; pure
// read-side. Every write path that changes leaderboard-relevant state MUST call
// invalidateLeaderboardCache(compId) after its DB commit (see CLAUDE.md).
// Deps: db + the competition/session status helpers. (v7.0.0 refactor:
// extracted verbatim from server.js.)

const db = require("../db");
const { swallowed } = require("./best-effort");
const { now } = require("./time");
const { presenceMsByUser } = require("./presence");
const { clockStartsAtFirstOpen } = require("./event-policy");   // the first-open solve clock reads scoring activity only
const { notQualifyingSql } = require("./qualifying");   // event team reports: a qualifying answer never moves the finish time
const { certificatePrintedName } = require("./badge");   // the name a certificate prints, for the admin board's preview
const {
  getCompetition, getTimeslot, timeslotStatus, timeslotEffectiveEnd,
  competitionStatus, competitionEffectiveEnd, competitionFullyEnded, ACTIVE_PARTICIPANT_SQL,
  // v8.6.0 — re-exported by lib/competitions from the pure lib/late-entry, so this
  // file has one import site for the whole question.
  lateEntryAllowed, isLateEntry, lateEntryRefEndMs,
} = require("./competitions");

function getParticipantScore(userId, competitionId, timeslotId) {
  const comp = getCompetition(competitionId);
  const effSlot = (comp?.leaderboard_mode === "per_slot") ? (timeslotId || null) : null;
  // v6.16.26 — JOIN competition_tasks to filter out submissions / hint
  // reveals for tasks that have been unassigned from this competition.
  // Pre-fix, unassigning a task left existing submissions counted in
  // scoring even though the task disappeared from /api/tasks (which
  // joins competition_tasks). Result: phantom score the participant
  // couldn't see or reproduce. The submissions row stays in the DB
  // for audit; it just stops contributing to the leaderboard once the
  // assignment is removed.
  const subQuery = effSlot
    ? "SELECT s.is_correct, s.task_id, s.points_delta FROM submissions s JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id WHERE s.user_id=? AND s.competition_id=? AND s.timeslot_id=?"
    : "SELECT s.is_correct, s.task_id, s.points_delta FROM submissions s JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id WHERE s.user_id=? AND s.competition_id=?";
  const subParams = effSlot ? [userId, competitionId, effSlot] : [userId, competitionId];
  const subs = db.prepare(subQuery).all(...subParams);
  let pts = 0;
  const solved = new Set();
  for (const s of subs) {
    if (s.is_correct && !solved.has(s.task_id)) { pts += s.points_delta; solved.add(s.task_id); }
    else if (!s.is_correct) pts += s.points_delta;
  }
  const hintQuery = effSlot
    ? "SELECT COALESCE(SUM(hr.points_deducted),0) as total FROM hint_reveals hr JOIN competition_tasks ct ON ct.task_id=hr.task_id AND ct.competition_id=hr.competition_id WHERE hr.user_id=? AND hr.competition_id=? AND hr.timeslot_id=?"
    : "SELECT COALESCE(SUM(hr.points_deducted),0) as total FROM hint_reveals hr JOIN competition_tasks ct ON ct.task_id=hr.task_id AND ct.competition_id=hr.competition_id WHERE hr.user_id=? AND hr.competition_id=?";
  const hintParams = effSlot ? [userId, competitionId, effSlot] : [userId, competitionId];
  const hints = db.prepare(hintQuery).get(...hintParams);
  pts -= hints.total;
  return pts;
}

// The three statements a score is made of, defined once: wrong answers (every
// wrong row counts), correct answers (one per person and challenge, the
// largest), and hints. Each joins competition_tasks, so a challenge unassigned
// since stops counting (v6.16.26). `buildLeaderboardEntries` reads them for a
// board and `scoreTotals` for anyone a board does not list (the event team's
// lead file), so the two cannot disagree. `scoreSlotId` narrows to one session.
function _scoreRows(idsJson, competitionId, scoreSlotId) {
  const ph = "SELECT value FROM json_each(?)";
  const subSlotFilter = scoreSlotId ? " AND s.timeslot_id=?" : "";
  const subParams = scoreSlotId ? [idsJson, competitionId, scoreSlotId] : [idsJson, competitionId];
  const wrongRows = db.prepare(
    `SELECT s.user_id, COALESCE(SUM(s.points_delta),0) AS pts, COUNT(*) AS n FROM submissions s
     JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id
     WHERE s.user_id IN (${ph}) AND s.competition_id=? AND s.is_correct=0${subSlotFilter}
     GROUP BY s.user_id`
  ).all(...subParams);
  const correctRows = db.prepare(
    `SELECT user_id, COALESCE(SUM(pts),0) AS pts FROM (
       SELECT s.user_id, s.task_id, MAX(s.points_delta) AS pts FROM submissions s
       JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id
       WHERE s.user_id IN (${ph}) AND s.competition_id=? AND s.is_correct=1${subSlotFilter}
       GROUP BY s.user_id, s.task_id
     ) GROUP BY user_id`
  ).all(...subParams);
  const hintSlotFilter = scoreSlotId ? " AND hr.timeslot_id=?" : "";
  const hintParams = scoreSlotId ? [idsJson, competitionId, scoreSlotId] : [idsJson, competitionId];
  const hintRows = db.prepare(
    `SELECT hr.user_id, COALESCE(SUM(hr.points_deducted),0) as total, COUNT(*) AS n FROM hint_reveals hr
     JOIN competition_tasks ct ON ct.task_id=hr.task_id AND ct.competition_id=hr.competition_id
     WHERE hr.user_id IN (${ph}) AND hr.competition_id=?${hintSlotFilter} GROUP BY hr.user_id`
  ).all(...hintParams);
  return { wrongRows, correctRows, hintRows };
}

/** userId -> score in this event, every session together, by the board's own rule. */
function scoreTotals(competitionId, userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const { wrongRows, correctRows, hintRows } = _scoreRows(JSON.stringify(userIds), competitionId, null);
  for (const r of wrongRows)   out.set(r.user_id, (out.get(r.user_id) || 0) + r.pts);
  for (const r of correctRows) out.set(r.user_id, (out.get(r.user_id) || 0) + r.pts);
  for (const r of hintRows)    out.set(r.user_id, (out.get(r.user_id) || 0) - r.total);
  return out;
}

// v7.2.x (audit) — removed the dead `finishTimeForUser` helper: it had zero call
// sites and duplicated the finish-time logic in buildLeaderboardEntries, where it
// could silently drift. The canonical finish-time lives in buildLeaderboardEntries.

/**
 * Build leaderboard entries. If timeslotId is provided (per-slot mode),
 * only includes participants in that timeslot and filters scores by timeslot.
 */
// v6.8.10: nested-map cache shape. Each competition gets its own inner
// Map keyed by timeslot id (with a `_global` bucket for queries without
// a timeslot). Pre-v6.8.10 the cache was a flat Map and invalidation
// walked EVERY key with startsWith(compId) — O(N_cached_comps) per
// invalidate. Under a T-0 submission storm with 200 concurrent comps,
// that walk added up. With the nested shape, `invalidateLeaderboardCache(c)`
// is a single `.delete(c)` regardless of how many timeslots or
// concurrent comps are cached.
const _leaderboardCache = new Map(); // compId → Map<tsKey, {data, ts}>
const _LEADERBOARD_TTL = 5000;
// concurrency-cache audit (#9): total cached (comp,ts) entries cap. The TTL only
// gates whether a READ returns the cached value — it never deletes entries, so a
// long-running process that runs many competitions accumulated one board payload
// per (comp,ts) pair ever read, for the life of the process (ended comps fire no
// further writer, so they were never invalidated). Mirrors _meCache /
// _competitionCache, which both carry a 5000 cap + eviction for this reason.
const _LEADERBOARD_CACHE_MAX = 5_000;
const _LEADERBOARD_TS_GLOBAL = "_global"; // sentinel for the no-timeslot query
// v8.13.3 — a real slot's key is PREFIXED, so no caller-supplied id can spell the
// sentinel: `?timeslotId=_global` used to read the competition-wide cached board
// as though it were that slot's (read-only and short-lived, but the same
// sentinel-collision class that let `__global__` freeze an empty Team Rankings).
function _leaderboardTsKey(tsId) { return tsId ? `ts:${tsId}` : _LEADERBOARD_TS_GLOBAL; }
function _leaderboardCacheGet(compId, tsId) {
  const inner = _leaderboardCache.get(compId);
  return inner ? inner.get(_leaderboardTsKey(tsId)) : undefined;
}
function _leaderboardCacheSet(compId, tsId, payload) {
  let inner = _leaderboardCache.get(compId);
  // Re-insert the comp at the tail so the outer Map's iteration order is
  // least-recently-written → most-recently-written (eviction is then proper LRU).
  if (!inner) inner = new Map();
  else _leaderboardCache.delete(compId);
  inner.set(_leaderboardTsKey(tsId), payload);
  _leaderboardCache.set(compId, inner);
  // Bound total entries: evict whole oldest-written comps (they rebuild on the
  // next read) until under the cap. Skips the comp we just wrote.
  while (_leaderboardCacheEntryCount() > _LEADERBOARD_CACHE_MAX) {
    const oldest = _leaderboardCache.keys().next().value;
    if (oldest === undefined || oldest === compId) break;
    _leaderboardCache.delete(oldest);
  }
}
function invalidateLeaderboardCache(compId) {
  if (compId) _leaderboardCache.delete(compId);
  else _leaderboardCache.clear();
  _bumpLeaderboardVersion(compId);
}
// THE BOARD'S VERSION, for the participant pulse (GET /api/participant/pulse).
//
// A tab looking at the leaderboard used to re-fetch the whole board every 15 s
// whether or not anything had moved; at 3000 open tabs that is 200 board
// responses a second, each serialising 20+ rows. The pulse now carries a token of this
// number and the client fetches the board only when it changes (or, as a floor,
// once a minute — the board also moves with time: unfinished solve clocks,
// presence, a slot ending, none of which bump it). It is bumped exactly where the
// cache is busted, so it can never say "unchanged" about a write that busted the
// cache, and it follows the writer rule for free (every caller busts after its
// commit). A global bust (no compId) moves the epoch, which every competition's
// version includes. The entrant invalidation below deliberately does NOT bump it:
// a new zero-score row is not worth 3000 board fetches at an event start, and it
// appears within the client's one-minute floor. Process-resident like the cache
// it shadows (see CLAUDE.md, single-process invariant); a restart resets it,
// which the client reads as a change and re-fetches once.
const _leaderboardVersions = new Map(); // compId → integer
let _leaderboardEpoch = 0;
const _LEADERBOARD_VERSION_MAX = 5000;
function _bumpLeaderboardVersion(compId) {
  if (!compId) { _leaderboardEpoch++; _leaderboardVersions.clear(); return; }
  const n = (_leaderboardVersions.get(compId) || 0) + 1;
  _leaderboardVersions.delete(compId);
  _leaderboardVersions.set(compId, n);
  // Bounded like every other cache. Dropping a counter resets it to 0, so the
  // epoch moves with it: a reset can then never repeat a value a client already
  // saw (which would read as "unchanged"); the cost is one spurious board fetch.
  while (_leaderboardVersions.size > _LEADERBOARD_VERSION_MAX) {
    const oldest = _leaderboardVersions.keys().next().value;
    _leaderboardVersions.delete(oldest);
    _leaderboardEpoch++;
  }
}
// What the wire carries is a keyed token over the counter, never the counter:
// before an event starts the counter roughly counts its joins and edits, and
// no participant count may appear anywhere. Same state, same token; any bump,
// another; nothing about the count or its order is readable. The key is per
// process, so a restart changes every token (one re-fetch, as before).
const _crypto = require("crypto");
const _LEADERBOARD_VERSION_KEY = _crypto.randomBytes(32);
/** Opaque string: changes whenever the competition's board cache was busted. */
function leaderboardVersion(compId) {
  return _crypto.createHmac("sha256", _LEADERBOARD_VERSION_KEY)
    .update(`${compId}|${_leaderboardEpoch}|${_leaderboardVersions.get(compId) || 0}`)
    .digest("base64url").slice(0, 22);
}
// A NEW ENTRANT, NOT A SCORE CHANGE: the first-entry stamp (`login_time` set by
// select-competition, select-timeslot or the lazy stamp in requireCompetitionContext)
// only ADDS a zero-score row to the board. Busting the cache for it rebuilt the
// whole board — O(participants) — on the very next read, so at an event start,
// with entrants arriving every few milliseconds, every leaderboard request rebuilt
// the board for everybody: O(N²) work on the one thread, which is what collapsed
// the sign-in storm (perf/RESULTS.md). This invalidation therefore
// COALESCES: a board built in the last LEADERBOARD_ENTRY_COALESCE_MS is kept until
// that window ends (so a storm costs at most one rebuild per board per window),
// and an older one is dropped as before. An entrant appears on everyone's board
// within the window instead of on the next read. Every writer that changes a
// SCORE, a solve or a finish keeps the immediate invalidateLeaderboardCache().
const LEADERBOARD_ENTRY_COALESCE_MS = 1000;
function invalidateLeaderboardCacheForEntrant(compId) {
  if (!compId) return;
  const inner = _leaderboardCache.get(compId);
  if (!inner) return;
  const nowMs = Date.now();
  for (const [k, e] of inner) {
    if (nowMs - e.ts >= LEADERBOARD_ENTRY_COALESCE_MS) inner.delete(k);
    else if (e.staleAt === undefined) e.staleAt = e.ts + LEADERBOARD_ENTRY_COALESCE_MS;
  }
}
// Size reporter for the /metrics endpoint — sum inner sizes, since the
// operator cares about total cached entries, not just top-level comps.
function _leaderboardCacheEntryCount() {
  let n = 0; for (const inner of _leaderboardCache.values()) n += inner.size; return n;
}

// v7.21.9 — `opts.fresh` SKIPS the 5-second cache read.
//
// The cache is a freshness/perf trade that is correct for a POLL and wrong for a
// PERSIST. Anything that writes a computed board somewhere permanent must not
// read a value that may be up to 5 s old:
//   • freezeGroupLeaderboardSnapshots → group_leaderboard_snapshots (INSERT OR
//     IGNORE, cleared only by a revive, so the first write is the official
//     result for ever);
//   • the lazy freeze inside buildGroupLeaderboard, which persists identically;
//   • the badge mint → achievement_badges.rank / score_snapshot, which a PUBLIC
//     OpenGraph page and the certificate PDF then render for ever.
//
// The previous shape asked every CALLER to invalidate the cache first. Three of
// nine freeze sites did; the rest froze from whatever a concurrent /api/leaderboard
// poll had left behind, which on the submit-path auto-end is guaranteed to predate
// the very submission that ENDED the competition. Putting the bypass here rather
// than at the callers is the point: it cannot be forgotten by the next site, and
// it does not clear a cache other in-flight readers are legitimately using.
// A fresh build still POPULATES the cache, so this costs one rebuild, not a stampede.
// v8.15.1 — how many times the entries were actually COMPUTED (a cache hit is
// not counted), per competition. Read by the certificate dispatcher so a pass
// can report its board cost, which is what the lock that keeps that cost
// independent of the event's size asserts on. Monotonic; never reset.
const _computeCounts = new Map();
function leaderboardComputeCount(competitionId) { return _computeCounts.get(competitionId) || 0; }

function buildLeaderboardEntries(competitionId, timeslotId, opts = {}) {
  if (!opts.fresh) {
    const cached = _leaderboardCacheGet(competitionId, timeslotId);
    const _nowMs = Date.now();
    if (cached && _nowMs - cached.ts < _LEADERBOARD_TTL && !(cached.staleAt !== undefined && _nowMs >= cached.staleAt)) return cached.data;
  }
  const comp = getCompetition(competitionId);
  if (!comp) return [];
  _computeCounts.set(competitionId, (_computeCounts.get(competitionId) || 0) + 1);
  if (_computeCounts.size > 10_000) _computeCounts.delete(_computeCounts.keys().next().value);
  // v6.10.26: fallback to `MIN(submissions.submitted_at)` OR
  // `MIN(hint_reveals.revealed_at)` when `cu.login_time IS NULL`.
  // Pre-v6.10.26 (v6.10.24) covered submissions only; hint-reveal-
  // only users who were removed and re-added disappeared from the
  // leaderboard until they re-selected the competition, even
  // though their negative score history still applied. The COALESCE
  // walks a UNION ALL of both history tables and picks the earliest
  // timestamp. Per-slot mode applies the same predicate with an
  // additional `timeslot_id=cu.timeslot_id` filter so a re-added
  // user only re-appears in the slot they were in.
  let usersQuery, usersParams, effEnd, isEnded;
  // AN EVENT WHOSE CLOCK STARTS AT THE FIRST OPEN (lib/event-policy.js
  // `clockStartsAtFirstOpen`) reads the same two facts — the anchor, and "on the
  // board once it has started" — from SCORING activity only: a Quick
  // (qualifying) answer or hint scores nothing and starts no clock, so it must
  // neither put somebody on the board nor anchor them. An entry-clock event reads
  // exactly what it always did (its ranking basis must not move under a board).
  const _scoringJoinS = clockStartsAtFirstOpen(comp) ? ` JOIN tasks qt ON qt.id=s.task_id AND ${notQualifyingSql("qt")}` : "";
  const _scoringJoinH = clockStartsAtFirstOpen(comp) ? ` JOIN tasks qt ON qt.id=h.task_id AND ${notQualifyingSql("qt")}` : "";
  if (timeslotId) {
    const ts = getTimeslot(timeslotId);
    if (!ts) return [];
    isEnded = timeslotStatus(ts) === "ended";
    effEnd = timeslotEffectiveEnd(ts);
    usersQuery = `SELECT u.id, u.nickname, u.avatar, cu.assigned_at AS assigned_at,
        COALESCE(cu.login_time,
          (SELECT MIN(ts) FROM (
             SELECT MIN(s.submitted_at) AS ts FROM submissions s${_scoringJoinS}
             WHERE s.user_id=u.id AND s.competition_id=cu.competition_id
               AND s.timeslot_id=cu.timeslot_id
             UNION ALL
             SELECT MIN(h.revealed_at) AS ts FROM hint_reveals h${_scoringJoinH}
             WHERE h.user_id=u.id AND h.competition_id=cu.competition_id
               AND h.timeslot_id=cu.timeslot_id
           ) WHERE ts IS NOT NULL)
        ) AS login_time
      FROM competition_users cu JOIN users u ON u.id=cu.user_id
      WHERE cu.competition_id=? AND cu.timeslot_id=? AND ${ACTIVE_PARTICIPANT_SQL}
        AND (cu.login_time IS NOT NULL
          OR EXISTS(SELECT 1 FROM submissions s${_scoringJoinS}
                    WHERE s.user_id=u.id AND s.competition_id=cu.competition_id
                      AND s.timeslot_id=cu.timeslot_id)
          OR EXISTS(SELECT 1 FROM hint_reveals h${_scoringJoinH}
                    WHERE h.user_id=u.id AND h.competition_id=cu.competition_id
                      AND h.timeslot_id=cu.timeslot_id))`;
    usersParams = [competitionId, timeslotId, now().toISOString()];
  } else {
    isEnded = competitionStatus(comp) === "ended";
    effEnd = competitionEffectiveEnd(comp);
    // audit v7.7.32 (RM3) — carry the user's own timeslot so an unfinished
    // participant's solveTimeMs can be clamped to THEIR slot's end, not the
    // whole (multi-slot) competition's latest-slot end. See the result map.
    usersQuery = `SELECT u.id, u.nickname, u.avatar, cu.timeslot_id AS timeslot_id, cu.assigned_at AS assigned_at,
        COALESCE(cu.login_time,
          (SELECT MIN(ts) FROM (
             SELECT MIN(s.submitted_at) AS ts FROM submissions s${_scoringJoinS}
             WHERE s.user_id=u.id AND s.competition_id=cu.competition_id
             UNION ALL
             SELECT MIN(h.revealed_at) AS ts FROM hint_reveals h${_scoringJoinH}
             WHERE h.user_id=u.id AND h.competition_id=cu.competition_id
           ) WHERE ts IS NOT NULL)
        ) AS login_time
      FROM competition_users cu JOIN users u ON u.id=cu.user_id
      WHERE cu.competition_id=? AND ${ACTIVE_PARTICIPANT_SQL}
        AND (cu.login_time IS NOT NULL
          OR EXISTS(SELECT 1 FROM submissions s${_scoringJoinS}
                    WHERE s.user_id=u.id AND s.competition_id=cu.competition_id)
          OR EXISTS(SELECT 1 FROM hint_reveals h${_scoringJoinH}
                    WHERE h.user_id=u.id AND h.competition_id=cu.competition_id))`;
    usersParams = [competitionId, now().toISOString()];
  }
  const users = db.prepare(usersQuery).all(...usersParams);
  if (!users.length) return [];
  const scoreSlotId = (comp.leaderboard_mode === "per_slot") ? timeslotId : undefined;
  const userIds = users.map(u => u.id);
  // The id list travels as ONE JSON parameter (`json_each`), not one placeholder
  // per participant: with thousands on the board, compiling seven statements of
  // 3000 placeholders on every rebuild was a large share of its cost, and the
  // text changed with every new entrant so no statement could be reused
  // (perf/RESULTS.md, sign-in storm). Same rows: membership in the same list.
  const ph = "SELECT value FROM json_each(?)";
  const _idsJson = JSON.stringify(userIds);

  // Batch: tags for all users
  const tagRows = db.prepare(`SELECT user_id, tag FROM user_tags WHERE user_id IN (${ph})`).all(_idsJson);
  const tagMap = new Map();
  for (const r of tagRows) { if (!tagMap.has(r.user_id)) tagMap.set(r.user_id, []); tagMap.get(r.user_id).push(r.tag); }

  // v8.7.0 — an EVENT ADMIN is excluded from every board exactly as staff is,
  // and by ROLE rather than by the `staff` tag: that tag additionally grants a
  // platform-wide competition-entry bypass and an unfiltered participant picker,
  // both of which would break the rule that an event admin's participant view is
  // restricted to their own events (see lib/user-tags.js getStaffOrBenchmarkSet).
  // Read here rather than added to the two hand-written user SELECTs above, so
  // there is one new statement instead of two edited ones.
  const eventAdminIds = new Set(
    // RBAC — every grant-scoped role (class `granted`), built-in or custom, by the
    // one shared list (lib/user-tags.js offBoardRolesJson); one bound JSON list,
    // so the statement text is constant.
    db.prepare(`SELECT id FROM users WHERE id IN (${ph}) AND role IN (SELECT value FROM json_each(?))`)
      .all(_idsJson, require("./user-tags").offBoardRolesJson()).map(r => r.id)
  );
  // v8.12.0 — STAFF CAN COMPETE. On an event whose switch is on, neither the
  // `staff` tag nor the `event_admin` role puts anybody off the board: they hold
  // a row, they compete. `_staff` collapses to false for every entry, so the
  // five readers that filter on it (both boards, the late-entrant board, the
  // admin board, the group board's member set) lift the exclusion together, and
  // `scoringParticipantIds` (the denominator) reads the same column — the board
  // and the all-solved rule cannot disagree about who counts. `comp` is the
  // cached `SELECT *`, so `staffCompeteOn` sees the column and throws if it ever
  // does not, rather than quietly excluding.
  const _staffCompete = require("./staff-compete").staffCompeteOn(comp);

  // Batch: scores via SQL aggregation (v6.7.0). Pre-v6.7.0 this pulled the
  // full submissions cross-product (users × tasks × attempts) into JS and
  // reduced it in a loop — at 200 users × 30 tasks × ~3 attempts that's ~18k
  // rows per cache miss. SQL GROUP BY returns at most one row per user per
  // query. Correct-submission aggregation de-dupes per (user, task) in a
  // subquery so a user who happens to have two correct rows for the same
  // task (e.g. after a deletion + resubmit) only counts once — matches the
  // pre-v6.7.0 in-JS "solved Set" contract. points_delta is stored at submit
  // time from a per-difficulty constant, so MAX over the group is the
  // intended points-for-that-task value.
  // v6.16.26 — JOIN competition_tasks so unassigned tasks stop
  // contributing to wrong-answer penalties, correct-answer points, and
  // hint deductions. The solvedRows query below already joins
  // competition_tasks (line 3702-ish), so unassigning a task already
  // affects the all-solved finish-time signal. Pre-fix the score
  // aggregation queries didn't join, producing the asymmetric bug:
  // "phantom" points from a task the participant can no longer see.
  // The submissions / hint_reveals rows stay in the DB for audit; they
  // just stop contributing once the (task, comp) assignment is gone.
  // v7.28.0 — `COUNT(*) AS n` rides the query that ALREADY computes the score.
  //
  // The admin rankings CSV carries a per-participant penalty breakdown, and the
  // whole value of that breakdown is that it reconciles with the Score column
  // beside it: earned - lostIncorrect - lostHints == score, exactly. A second
  // aggregation written elsewhere could only be *hoped* to agree — it would be a
  // third copy of the `JOIN competition_tasks` filter (v6.16.26) and of the
  // per-slot predicate, and this file's own history is that duplicated rules
  // drift. Adding one column to the existing SELECT makes the identity hold by
  // construction: the same rows that set the score are the rows being counted.
  //
  // The count is deliberately NOT de-duplicated per (user, task) the way
  // correctRows is below: every wrong row is a real -5, so the count and the
  // points move together. Same rule the v7.23.0 activity export states, and it
  // inherits the same caveat — a recalculate rewrites rows, so this means
  // CURRENTLY-incorrect, on exactly the basis the leaderboard scored.
  const { wrongRows, correctRows, hintRows } = _scoreRows(_idsJson, competitionId, scoreSlotId);
  const hintMap = new Map(hintRows.map(r => [r.user_id, r.total]));
  // v7.28.0 — the penalty breakdown, keyed by user. Both halves are POSITIVE
  // magnitudes ("points lost"), which is what an admin reads in a spreadsheet —
  // note the two source columns disagree about sign, and that is the easiest
  // thing to get wrong here. `submissions.points_delta` for a wrong row is
  // stored NEGATIVE (`-PENALTY`, server.js), so it is NEGATED; the sum is used
  // rather than `count * PENALTY` because the STORED value is what scored.
  // `hint_reveals.points_deducted` is already a positive magnitude — the sign is
  // supplied by the consumer, which is why line ~366 SUBTRACTS it while ADDING
  // the wrong-answer points.
  const wrongCountMap = new Map(wrongRows.map(r => [r.user_id, r.n]));
  const hintCountMap = new Map(hintRows.map(r => [r.user_id, r.n]));
  const lostIncorrectMap = new Map(wrongRows.map(r => [r.user_id, -r.pts]));
  const scoreMap = new Map();
  for (const r of wrongRows)   scoreMap.set(r.user_id, (scoreMap.get(r.user_id) || 0) + r.pts);
  for (const r of correctRows) scoreMap.set(r.user_id, (scoreMap.get(r.user_id) || 0) + r.pts);

  // Batch: finish times — total tasks + per-user solved count + last correct submission
  const totalTasks = db.prepare(
    `SELECT COUNT(*) as c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}`
  ).get(competitionId).c;
  const solvedFilter = scoreSlotId ? " AND s.timeslot_id=?" : "";
  const solvedParams = scoreSlotId ? [competitionId, _idsJson, competitionId, scoreSlotId] : [competitionId, _idsJson, competitionId];
  const solvedRows = db.prepare(
    `SELECT s.user_id, COUNT(DISTINCT s.task_id) as solved, MAX(s.submitted_at) as last_correct
     FROM submissions s JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=?
     JOIN tasks t ON t.id=s.task_id
     WHERE s.user_id IN (${ph}) AND s.competition_id=? AND s.is_correct=1 AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}${solvedFilter}
     GROUP BY s.user_id`
  ).all(...solvedParams);
  const finishMap = new Map();
  // v8.12.7 — every participant's LAST correct answer, finished or not. Read only
  // by the late-entrant reference end below, and only as a floor under it.
  const lastCorrectMs = new Map();
  for (const r of solvedRows) {
    if (r.solved >= totalTasks) finishMap.set(r.user_id, r.last_correct);
    const lc = new Date(r.last_correct).getTime();
    if (Number.isFinite(lc)) lastCorrectMs.set(r.user_id, lc);
  }

  // v6.12.0: batch-fetch the total "no-access" gap per user. An absence
  // row (competition_user_absences) opens when an admin removes a user
  // from this competition WHILE their competition_users.login_time was
  // set (i.e. they were actively competing), and closes when a later
  // bulk-assign re-adds them. SUM(returned_at - removed_at) over all
  // closed absences for (user, comp [, timeslot]) is subtracted from
  // solveTimeMs in all three branches, so the interval during which
  // the user had no system access doesn't penalise them. Requirement:
  // "if his session is still live, time to solve should exclude the
  // time he didn't have access to the system." Open absences
  // (returned_at IS NULL) don't count — the user is still absent,
  // hasn't been brought back, and we shouldn't invent a "returned"
  // timestamp; they shouldn't appear on the board anyway because the
  // DELETE removed their competition_users row.
  //
  // ISO-8601 timestamps are lexically orderable; the Julian-day / UTC
  // equivalence in SQLite makes `julianday(returned_at) -
  // julianday(removed_at)` a reliable fractional-day difference that
  // multiplies to ms cleanly. (Doing the subtraction in JS via
  // Date.parse for each row would be correct but unnecessary — one
  // query + SUM is a tight batch regardless of absence count.)
  const gapSlotFilter = scoreSlotId ? " AND (timeslot_id=? OR timeslot_id IS NULL)" : "";
  const gapParams = scoreSlotId ? [_idsJson, competitionId, scoreSlotId] : [_idsJson, competitionId];
  // v7.2.x (audit) — fetch RAW closed-absence intervals (not a pre-SUM) so each
  // is clamped to the user's own solve window [login, finish/effEnd/now] below.
  // Pre-fix the whole gap was subtracted even when part of an absence fell AFTER
  // the user had already finished, wrongly shrinking their time-to-solve (and so
  // their rank). Absences entirely within the window subtract in full as before.
  const gapRows = db.prepare(
    `SELECT user_id, removed_at, returned_at FROM competition_user_absences
     WHERE user_id IN (${ph}) AND competition_id=? AND returned_at IS NOT NULL${gapSlotFilter}`
  ).all(...gapParams);
  const gapIntervals = new Map();
  for (const r of gapRows) {
    const rm = new Date(r.removed_at).getTime(), rt = new Date(r.returned_at).getTime();
    if (!Number.isFinite(rm) || !Number.isFinite(rt) || rt <= rm) continue;
    if (!gapIntervals.has(r.user_id)) gapIntervals.set(r.user_id, []);
    gapIntervals.get(r.user_id).push([rm, rt]);
  }

  // v8.1.0 (PR 35) — ONE query for the whole board, not one per row: the
  // N+1 shape v7.21.13 removed from three other builders.
  const presenceByUser = presenceMsByUser(competitionId);
  // Pin "now" once per leaderboard build so the per-row solveTimeMs values are
  // a coherent snapshot. Otherwise two consecutive requests return numerically
  // different solveTimeMs even when no submission happened — bad for any
  // client-side caching/diffing and confusing in concurrent log analysis.
  // (Relative rank is unaffected because differences between users' login_time
  // are constant, but the displayed value should also be stable per request.)
  const nowMs = Date.now();
  // audit v7.7.32 (RM3) — in GLOBAL mode (no tsId param) an unfinished
  // participant's solve window must end at THEIR OWN timeslot's effective end,
  // not the competition's latest-slot end / now. Pre-fix, in a comp with a
  // 10:00–12:00 and a 16:00–18:00 slot, a morning participant's solveTimeMs
  // kept growing until 18:00 (or the whole comp ended), unfairly losing the
  // finish-time tie-break to an evening participant with an identical 2h window
  // (and their displayed timer ran for hours after they were locked out). Build
  // per-slot effective-end once; per_slot mode already clamps via its own effEnd.
  const slotEndCache = new Map();
  const slotEndMsFor = (tsId) => {
    if (!tsId) return null;
    if (slotEndCache.has(tsId)) return slotEndCache.get(tsId);
    const ts = getTimeslot(tsId);
    const end = ts ? timeslotEffectiveEnd(ts) : null;
    const ms = end ? end.getTime() : null;
    slotEndCache.set(tsId, ms);
    return ms;
  };
  // ── v8.6.0 — LATE ENTRANTS ──────────────────────────────────────────────────
  //
  // Resolved ONCE for the whole board rather than per row: `lateEntryAllowed` is a
  // policy-plus-column test that cannot vary between rows of one event, and the
  // deadline is the same instant for all of them. A per-row call would be the N+1
  // shape v7.21.13 removed from three builders.
  //
  // The CLASSIFICATION costs no extra query at all, which is why it lives here
  // rather than in a second pass: `assigned_at` rides the users SELECT above, and
  // "had they solved everything by the end" is exactly `finishMap` — already
  // computed, because it is the same value the main board's finish time uses —
  // compared against the effective end. Only a late entrant may submit after the
  // end, so a finish time at or before it means they competed on the room's terms.
  const _lateOn = lateEntryAllowed(comp);
  const _lateRefEndMs = _lateOn ? lateEntryRefEndMs(comp, effEnd, nowMs) : null;
  const result = users.map(u => {
    const finishTime = finishMap.get(u.id) || null;
    const loginMs = new Date(u.login_time).getTime();
    const lateEntrant = _lateOn && isLateEntry(comp, effEnd, { assignedAt: u.assigned_at, finishTime });
    // The reference end of the solve window: finish time (finished), else the
    // competition's effective end (ended), else now (live, unfinished).
    //
    // v8.6.0 — A LATE ENTRANT MEASURES AGAINST THEIR OWN END, and without this the
    // feature ships a ranking exploit rather than a ranking. Their `login_time` is
    // after the event's effective end by construction, so the ordinary rule hands
    // them a reference end EARLIER than their own start: `solveTimeMs` goes
    // negative and the unconditional v7.21.3 clamp turns it into ZERO — the best
    // possible value on the sole score-tie tie-break, for every one of them. That
    // clamp's own comment names this class ("a login_time stamped after the
    // participant's finish"). The rule itself is unchanged; only "the end" moves,
    // to the late deadline while it is still ahead and `now` while it is not.
    //
    // v8.12.7 — AND IT NEVER ENDS BEFORE THEIR LAST CORRECT ANSWER. A deadline can
    // move INTO THE PAST after somebody played against it: a pin set to the current
    // minute (which the form rounds down) or to any instant already behind us, and
    // the automatic deadline following an effective end that moved earlier. The
    // window then closes before answers it accepted, so an entrant who joined after
    // the new deadline got a reference end earlier than their own start — clamped
    // to zero, the v8.6.0 exploit by another door — and one who joined before it
    // had the answers after it silently dropped from their time. The floor restores
    // the honest measure for exactly those rows and is a NO-OP for every row whose
    // answers fell inside the window as it now stands: this builder is synchronous,
    // so every row it read was committed before `nowMs` was sampled, and the submit
    // path re-checks the window against the clock inside the write transaction that
    // stamps `submitted_at` — so `last_correct <= min(now, deadline)`, to within the
    // millisecond that transaction can straddle the deadline (where the floor makes
    // the value exact rather than different). A late entrant with no correct answer
    // is unaffected and keeps the accepted v7.21.3 zero-window behaviour.
    let refEndMs = finishTime ? new Date(finishTime).getTime()
      : (lateEntrant && _lateRefEndMs != null ? Math.max(_lateRefEndMs, lastCorrectMs.get(u.id) ?? -Infinity)
        : (isEnded && effEnd ? effEnd.getTime() : nowMs));
    // RM3 clamp: unfinished + global mode + the user has a timeslot → cap at
    // their slot's effective end (they lose submit access when their slot ends).
    if (!finishTime && !timeslotId && u.timeslot_id) {
      const slotEnd = slotEndMsFor(u.timeslot_id);
      if (slotEnd != null) refEndMs = Math.min(refEndMs, slotEnd);
    }
    let solveTimeMs = refEndMs - loginMs;
    // v6.12.0 / v7.2.x: subtract no-access gaps, but only the portion of each
    // closed absence that falls WITHIN [login, refEnd] — a gap after the user
    // finished must not shrink their time-to-solve. Clamp to 0 defensively.
    let gapMs = 0;
    for (const [rm, rt] of (gapIntervals.get(u.id) || [])) {
      gapMs += Math.max(0, Math.min(rt, refEndMs) - Math.max(rm, loginMs));
    }
    if (gapMs > 0) solveTimeMs = Math.max(0, solveTimeMs - gapMs);
    // v7.21.3 — clamp UNCONDITIONALLY. The Math.max above only ran when a gap
    // was subtracted, so a refEndMs EARLIER than loginMs stayed negative — and
    // sortLeaderboard's `(a.solveTimeMs||0) - (b.solveTimeMs||0)` sorts a
    // negative time ahead of every legitimate one, i.e. a tie-break WIN. Two
    // reachable ways in: a login_time stamped after the participant's finish
    // (see the lazy stamp in lib/middleware.js), and a duration shrink that
    // moves effEnd behind a participant's first activity. Time-to-solve is the
    // sole tie-breaker, so an impossible value must never out-rank a real one.
    if (solveTimeMs < 0) solveTimeMs = 0;
    const tags = tagMap.get(u.id) || [];
    const score = (scoreMap.get(u.id) || 0) - (hintMap.get(u.id) || 0);
    return { userId: u.id, nickname: u.nickname, avatar: u.avatar, score, finishTime,
             solveTimeMs, allSolved: !!finishTime, _staff: !_staffCompete && (tags.includes("staff") || eventAdminIds.has(u.id)), _benchmark: tags.includes("benchmark"),
             // v8.6.0 — UNDERSCORE-PREFIXED for the reason every internal here is:
             // this builder feeds the PARTICIPANT board and writes the shared
             // cache, and `stripInternal` drops every `_` key on the way out, so a
             // field added here cannot ship by being forgotten. The boards that
             // need it PARTITION on it and re-publish nothing — a participant sees
             // WHICH SECTION a row is in, which is the whole answer, and never a
             // per-row flag they could sort by.
             _lateEntrant: !!lateEntrant,
             // v7.28.0 — the penalty breakdown behind `score`, for the ADMIN CSV.
             // UNDERSCORE-PREFIXED because this builder also feeds the PARTICIPANT
             // board and writes `_leaderboardCache`: `stripInternal` (below) drops
             // every `_` key on the way to a participant, so a field added here
             // cannot ship by being forgotten. `buildAdminLeaderboard` re-publishes
             // them under public names; nothing else may.
             _incorrectCount: wrongCountMap.get(u.id) || 0,
             _pointsLostIncorrect: lostIncorrectMap.get(u.id) || 0,
             _hintCount: hintCountMap.get(u.id) || 0,
             _pointsLostHints: hintMap.get(u.id) || 0,
             // v8.1.0 (PR 35) — NET ACTIVE TIME, same underscore rule and the
             // same reason: this builder feeds the PARTICIPANT board, and how
             // long each rival spent on the platform is nobody's business but
             // the organiser's. `buildAdminLeaderboard` re-publishes it.
             _presenceMs: presenceByUser.get(u.id) || 0 };
  });
  _leaderboardCacheSet(competitionId, timeslotId, { data: result, ts: Date.now() });
  return result;
}

function sortLeaderboard(entries, usePresence = false) {
  // Ranking invariant (v7.8.1): RAW SCORE is ALWAYS the primary factor
  // (descending). Time-to-solve (solveTimeMs, lower = better) is ONLY the
  // tie-breaker when scores are equal. Whether a participant solved every
  // challenge ("allSolved") is NOT a ranking factor of its own — it merely
  // shapes solveTimeMs (a finisher's window ends at their finish time; an
  // unfinished participant's at the competition/slot end), so on a SCORE TIE
  // a finisher naturally sorts ahead of a slower/unfinished participant.
  // Pre-v7.8.1 an `allSolved` PRIMARY key ranked EVERY finisher above EVERY
  // non-finisher regardless of score, so a lower-scoring finisher wrongly
  // outranked a higher-scoring non-finisher. See CLAUDE.md > Scoring.
  return entries.sort((a, b) => compareLeaderboardEntries(a, b, usePresence));
}

/**
 * The pair comparator behind `sortLeaderboard`, extracted so the GROUP board can
 * reuse it for its SOLO rows instead of re-deriving the rule (v8.1.7).
 *
 * v8.1.0 promised the ranking basis is resolved in ONE place "so the participant
 * board and the admin board can never disagree about the order of the same
 * event". The group board was not in that enumeration: its solo rows are the SAME
 * direct-assigned participants, sorted by an inline comparator that never
 * consulted presence — so on an event ranking on presence, two tied finishers
 * could appear in one order on the individual board and the opposite order in the
 * Team Rankings section rendered directly beneath it, from the SAME payload, and
 * a post-end snapshot froze the divergence for good. Sharing the comparator makes
 * that unreachable rather than merely fixed.
 */
function compareLeaderboardEntries(a, b, usePresence = false) {
  if (b.score !== a.score) return b.score - a.score;
  // ── v8.1.0 (PR 35) — NET ACTIVE TIME AS THE TIE-BREAK, FINISHERS ONLY ──
  //
  // Opt-in per competition (`time_basis='presence'`), and restricted to rows
  // where BOTH participants finished. That restriction is a one-way door and
  // it is the difference between a refinement and an inversion:
  //
  //   * for a FINISHER, both numbers are honest — `solveTimeMs` ends at their
  //     finish, and presence says how much of that window they actually
  //     worked. On a score tie, the one who got there on less platform time
  //     did it more efficiently, which is what the tie-break should reward.
  //   * for a NON-FINISHER, `solveTimeMs` runs to the event's end for
  //     everybody, so presence is the only thing separating them — and LOWER
  //     presence would win. That ranks the participant who barely turned up
  //     ABOVE the one who worked for hours and still did not finish, which is
  //     the opposite of the truth.
  //
  // So a mixed pair, or any pair in an event that did not opt in, falls
  // through to the elapsed-time tie-break exactly as before.
  // ── v8.3.11 — THE FINISHER BLOCK, AND WHY THE COMPARATOR NEEDS ONE ──────────
  //
  // The finishers-only restriction below is what made this comparator
  // NON-TRANSITIVE, and the caveat this file used to carry about it was wrong
  // about the precondition: no millisecond collision is required. Under a score
  // tie a finisher pair is ordered by PRESENCE while every pair touching a
  // non-finisher is ordered by ELAPSED — two different quantities — so a
  // non-finisher whose elapsed lands strictly BETWEEN two finishers' elapsed
  // values closes a three-row cycle with every value distinct.
  //
  // Measured, with score 150 throughout: A(finished, elapsed 5m30s, presence 10m),
  // B(finished, elapsed 19m, presence 5m), C(unfinished, elapsed 10m). A beats B
  // on presence, B beats C on elapsed, C beats A on elapsed. The six input
  // permutations produced THREE different orders — and `buildLeaderboardEntries`'
  // users query carries no ORDER BY, so the input order is SQLite's and the
  // resolved order of a cycle is arbitrary. It is persisted: `rank` is written
  // into `achievement_badges.rank`, which decides who is issued a "3rd Place"
  // certificate, and the group board's rows are frozen into
  // `group_leaderboard_snapshots` at end-of-event.
  //
  // The inversion the cycle needs is ordinary rather than exotic: presence accrues
  // in five-minute buckets only while a human is acting, so a participant who
  // anchors early with the tab backgrounded elapses 19 minutes on one bucket while
  // a late, attentive finisher elapses 6 minutes on two.
  //
  // THE FIX IS A BLOCK, and a block is what a strict weak ordering requires here.
  // Membership ("did they finish?") is a per-row property, so cross-block order is
  // CONSTANT and each block then compares a fixed lexicographic key. The
  // alternatives were all worse and are recorded so nobody re-derives them:
  // comparing presence only when elapsed also ties guts the feature; using
  // presence for everyone is the fairness inversion v8.1.0 forbade (it would rank
  // the participant who barely turned up above the one who worked for hours and
  // did not finish); and moving presence AFTER elapsed still cycles.
  //
  // THE BEHAVIOUR CHANGE, stated rather than buried: on a presence-ranked event a
  // score-tied FINISHER now always outranks a score-tied non-finisher, even one
  // with a smaller elapsed. That is defensible on its own terms — solving
  // everything should not lose a tie to joining late and not finishing — and it
  // makes the feature coherent, since today whether presence or elapsed decides a
  // finisher's placing depends on who else happens to be tied with them. It
  // affects ONLY events that opted into presence ranking.
  if (usePresence && !!a.allSolved !== !!b.allSolved) return a.allSolved ? -1 : 1;
  if (usePresence && a.allSolved && b.allSolved) {
    const dp = (a._presenceMs || 0) - (b._presenceMs || 0);
    if (dp !== 0) return dp;
  }
  const dt = (a.solveTimeMs || 0) - (b.solveTimeMs || 0);
  if (dt !== 0) return dt;
  // Deterministic tie-break (v6.2.6): when score AND solveTimeMs collide
  // (two participants finishing in the same millisecond, or both unfinished
  // at the same nowMs snapshot), Array#sort would otherwise fall back to
  // insertion order — which varies across requests when subRows arrives in
  // a different order from SQLite. Pinning userId lex-ascending makes the
  // ranking byte-for-byte stable across calls so a "rank 5 / rank 6 swap
  // every refresh" can't happen.
  return String(a.userId).localeCompare(String(b.userId));
}

/**
 * v8.3.11 — the GROUP board's pair comparator, extracted and exported.
 *
 * It was an inline closure over `_soloPres`, which made it unreachable from a
 * spec — and the group board has its OWN cycle, independent of the individual
 * one, so fixing `compareLeaderboardEntries` alone does not save it. Extraction
 * is the same v8.1.7 argument that exported the individual comparator: the rule
 * cannot be driven through the API without clock control the suite lacks, so it
 * is asserted directly.
 *
 * THE GROUP CYCLE NEEDS NO NON-FINISHER AT ALL. A group row can be `allSolved`
 * too, so under the individual fix it lands in the same block as the solo
 * finishers — and is still compared on ELAPSED against solos compared on
 * PRESENCE. A group whose average elapsed sits between two solo finishers closes
 * the loop: measured, six permutations gave three different orders.
 *
 * So the partition here is by TYPE, and it makes true the relation the old
 * comment already claimed ("always orders a group ahead of a tied individual") —
 * which held only for a set that also tied on elapsed, while the mixed branch is
 * reached for every score-tied set. Under a score tie on a presence event the
 * blocks are: groups (elapsed, id), then individuals (finishers by presence, then
 * non-finishers, each by elapsed then id).
 *
 * Gated on `usePresence`, so an event that did not opt in keeps byte-identical
 * ordering: the mixed branch was already transitive there, because every pair —
 * group/group, solo/solo and mixed — compared the same (elapsed, composite-id)
 * key.
 */
function compareGroupBoardRows(a, b, usePresence = false) {
  if (a.type === "individual" && b.type === "individual") {
    return compareLeaderboardEntries(a, b, usePresence);
  }
  if (b.score !== a.score) return b.score - a.score;        // req 3 — score primary
  if (usePresence && (a.type === "group") !== (b.type === "group")) {
    return a.type === "group" ? -1 : 1;
  }
  const dt = (a.solveTimeMs || 0) - (b.solveTimeMs || 0);   // then time-to-solve
  if (dt !== 0) return dt;
  // deterministic composite tie-break (groups before individuals, then id).
  const ka = a.type === "group" ? `0:${a.groupId}` : `1:${a.userId}`;
  const kb = b.type === "group" ? `0:${b.groupId}` : `1:${b.userId}`;
  return ka.localeCompare(kb);
}

// v7.28.0 — drop every INTERNAL (`_`-prefixed) field from a row builder's entry.
//
// This replaces a `const { _staff, _benchmark, ...rest } = u` destructure that
// named its two internals by hand. Naming them is a deny-list: it was correct
// while there were exactly two, and it silently ships the third. That is not
// hypothetical — the penalty breakdown added in v7.28.0 rides the same entry,
// and `buildLeaderboard` is the PARTICIPANT board, so a forgotten name is a
// per-row data leak past the v7.22.0 allow-list lock. The underscore prefix is
// the convention already in use (`_staff`, `_benchmark`); this makes it load-
// bearing rather than decorative. Keep new internals underscore-prefixed.
/**
 * v8.1.0 (PR 35) — what this event does with NET ACTIVE TIME.
 *
 * Read here rather than passed in, so the participant board and the admin board
 * cannot disagree about the ranking of the same event — which would be the worst
 * possible outcome for a tie-break.
 *
 * TWO ANSWERS, NOT ONE, and conflating them is a wrong number rather than a
 * missing feature (v8.1.7). `measured` says the counter was RUNNING; `rankOnPresence`
 * says the tie-break reads it. An event can measure without ranking on it — that is
 * the default the form offers, one checkbox for each — and in that state the figure
 * is real and belongs in the export even though it decides no placings.
 */
function _presenceBasis(competitionId) {
  try {
    const c = getCompetition(competitionId);
    const measured = !!(c && c.measure_presence);
    return { measured, rankOnPresence: measured && c.time_basis === "presence" };
  } catch (_) { return { measured: false, rankOnPresence: false }; }
}
function _usePresenceRanking(competitionId) {
  return _presenceBasis(competitionId).rankOnPresence;
}

function stripInternal(entry) {
  const out = {};
  for (const k of Object.keys(entry)) if (k[0] !== "_") out[k] = entry[k];
  return out;
}

// Participant-facing leaderboard: excludes staff and benchmark
//
// v8.6.0 — AND EXCLUDES LATE ENTRANTS, which is what makes the main board FINAL at
// the moment the event ends. They are ranked separately by `buildLateLeaderboard`
// below.
//
// Excluding rather than interleaving is the load-bearing half. `rank` here is
// persisted into `achievement_badges.rank` and decides who is issued a "3rd Place"
// certificate: a late entrant left in this array could take rank 1 during the
// window and mint a genuine gold certificate while displacing the person who
// actually won on the day. It also keeps the two comparators STRICT WEAK ORDERINGS
// (v8.3.11) — a separate array sorted by the same comparator is transitive by
// construction, where a fourth tie-break partition bolted onto one array is exactly
// how the measured three-row cycle happened.
// THE RANKED BOARD IS BUILT ONCE PER CACHED ENTRY SET, not once per
// request. `buildLeaderboardEntries` serves the same array object for the life of
// its 5 s cache entry, yet every GET /api/leaderboard then filtered, sorted and
// copied the whole field again (the largest self-time in the 1000-user storm
// profile after socket writes: perf/RESULTS.md). The memo is keyed on that array's
// IDENTITY in a WeakMap, so it lives and dies with the cache entry it derives
// from — every invalidation that drops the entry drops the memo, and a
// `{fresh:true}` build (the persists: freezes, the mint) gets a new array and so
// never reads it. The presence basis is part of the key because it is read live.
// Rows are frozen: a caller that mutated a shared row would corrupt every other
// participant's board, so it now throws instead.
const _rankedBoardMemo = new WeakMap(); // entries array → { usePresence, board }
function buildLeaderboard(competitionId, timeslotId, opts = {}) {
  const all = buildLeaderboardEntries(competitionId, timeslotId, opts);
  const usePresence = _usePresenceRanking(competitionId);
  const memo = opts.fresh ? null : _rankedBoardMemo.get(all);
  if (memo && memo.usePresence === usePresence) return memo.board;
  const entries = all.filter(u => !u._staff && !u._benchmark && !u._lateEntrant);
  const board = sortLeaderboard(entries, usePresence).map((u, i) => Object.freeze({ ...stripInternal(u), rank: i + 1 }));
  Object.freeze(board);
  if (!opts.fresh && Array.isArray(all)) _rankedBoardMemo.set(all, { usePresence, board });
  return board;
}

/**
 * v8.6.0 — the LATE-ENTRANT board: the people who arrived as the event was closing,
 * ranked among themselves by exactly the rules the main board uses.
 *
 * Same source entries, same filters, same comparator, same presence basis, ranks
 * from 1 — "the same way of ranking" the operator asked for, expressed by sharing
 * the comparator rather than by restating it. Returns [] when the event runs no
 * late window or nobody arrived late, which both clients read as "render nothing":
 * an empty section headed "Late entrants" is a question an organiser has to answer.
 */
function buildLateLeaderboard(competitionId, timeslotId, opts = {}) {
  const entries = buildLeaderboardEntries(competitionId, timeslotId, opts).filter(u => !u._staff && !u._benchmark && u._lateEntrant);
  if (!entries.length) return [];
  return sortLeaderboard(entries, _usePresenceRanking(competitionId)).map((u, i) => ({ ...stripInternal(u), rank: i + 1 }));
}

// v7.22.0 — ADMIN-ONLY identity columns (first name / last name / company /
// primary email), so an organiser can find a real person on the board, sort by
// company, and copy an address without leaving the tab.
//
// It is a SEPARATE keyed lookup, and that is the whole design. The obvious
// place to add four columns is `buildLeaderboardEntries`' users SELECT — and
// that is exactly wrong: that builder is shared with the PARTICIPANT board AND
// writes its result into `_leaderboardCache`, so identity added there would
// ship PII to `/api/leaderboard` and poison a cache the participant board then
// reads. Both halves matter: even a route that stripped the fields afterwards
// would still be serving a cache entry that had them. Allow-list by
// construction, matching the `category:` doctrine (v7.21.0) — a
// participant-visible field is an explicit opt-in, never a widening. The lookup
// is `_adminIdentityMap`, read only by `buildAdminLeaderboard`.

// v7.28.0 — the ADMIN-ONLY penalty columns, named ONCE.
//
// Two consumers that must not disagree: `_adminPenalties` mints them on the
// individual board, and `_participantGroupBoard` (routes/leaderboard.js) strips
// them from the GROUP board on its way to a participant. The group rows carry
// them under these same public names — they have to, because they are frozen
// into `group_leaderboard_snapshots` alongside the score — so the participant
// route is the single place they are withheld. A name added here and not there
// would ship every team's mistake count to every competitor, so the strip reads
// this list rather than repeating it.
const ADMIN_PENALTY_FIELDS = ["incorrectCount", "pointsLostIncorrect", "hintCount", "pointsLostHints", "pointsLostTotal"];
function _adminIdentityMap(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const ph = "SELECT value FROM json_each(?)";
  for (const r of db.prepare(
    `SELECT id, first_name, last_name, company, email, nickname, personal_title, certificate_given_name, certificate_family_name FROM users WHERE id IN (${ph})`
  ).all(JSON.stringify(userIds))) {
    out.set(r.id, { firstName: r.first_name || "", lastName: r.last_name || "", company: r.company || "", email: r.email || "",
      // The name a certificate issued now would print, by the certificate's own
      // rule (lib/badge.js `certificatePrintedName`): what the Rankings top
      // three previews, so the preview cannot name someone differently.
      certificatePrintedName: certificatePrintedName(r, r.nickname || "").displayName || "" });
  }
  return out;
}
// A row whose user has since been deleted still renders; it gets empty strings
// rather than `undefined`, so the client never prints "undefined" in a cell.
const _NO_IDENTITY = { firstName: "", lastName: "", company: "", email: "", certificatePrintedName: "" };

// v7.28.0 — ADMIN-ONLY penalty breakdown: how the net `score` was arrived at.
//
// The board shows one number. "Why is this participant on 45?" is the question
// an organiser asks next, and answering it meant reading the submissions table.
// These five fields are the answer, and they are ADMIN-ONLY for the same reason
// the identity columns are: how many wrong answers somebody made is not
// something to hand every other competitor.
//
// They are a re-publication of the internals the row builder already computed —
// NOT a fresh query. That is the point: `score` and this breakdown come from the
// same rows in the same statement, so `earned - lostIncorrect - lostHints`
// equals `score` exactly, and it cannot drift from a second aggregation whose
// JOIN or slot filter was typed slightly differently. It also cannot disagree
// with the 5-second leaderboard cache, because it IS what the cache holds.
//
// There is deliberately no `pointsEarned` column: it is `score + pointsLostTotal`
// by the identity above, and a fourth number a reader can derive is a fourth
// number that can be wrong.
function _adminPenalties(u, presenceMeasured) {
  const lostIncorrect = u._pointsLostIncorrect || 0;
  const lostHints = u._pointsLostHints || 0;
  return {
    incorrectCount: u._incorrectCount || 0,
    pointsLostIncorrect: lostIncorrect,
    hintCount: u._hintCount || 0,
    pointsLostHints: lostHints,
    pointsLostTotal: lostIncorrect + lostHints,
    // v8.1.0 (PR 35) — net active time, re-published under a public name for the
    // ADMIN board only. `elapsedMs` rides alongside it deliberately: the pair is
    // the point. A row reading "elapsed 40 h / on platform 35 min" is one glance
    // from an organiser's eye, and either number alone is misleading.
    //
    // v8.1.7 — NULL, NOT ZERO, WHEN THE EVENT DOES NOT MEASURE. `measure_presence`
    // is off by default and off on every event that predates v8.1.0, so
    // `_presenceMs || 0` published a measured-looking `0` for the majority of
    // events: an organiser read "Time on Platform 0s" beside "Time to Solve
    // 3h 45m 00s" for people who visibly worked for hours, and anyone averaging the
    // ms column across events silently folded in zeros that were never
    // measurements. Unmeasured and measured-zero are different facts and the wire
    // now says which — the same absent-vs-0 rule `presence_active_recent` follows
    // one release earlier. `null` rather than an omitted key because this object
    // is spread into every row and the CSV column is unconditional: a stable row
    // shape is what lets the export pass the value through raw and let `csvCell`
    // render the blank, with no per-event branch on which keys exist.
    presenceMs: presenceMeasured ? (u._presenceMs || 0) : null,
    // Elapsed is always real, whatever the event measures — it needs no such gate.
    elapsedMs: u.solveTimeMs || 0,
  };
}

// Admin leaderboard: excludes staff; benchmark shown at the bottom
function buildAdminLeaderboard(competitionId, timeslotId, opts = {}) {
  const entries = buildLeaderboardEntries(competitionId, timeslotId, opts).filter(u => !u._staff);
  // v8.6.0 — three sections now, and the wire stays a BARE ARRAY. Every existing
  // consumer indexes it and `_rkBoard` treats a non-array as a load failure, so the
  // late rows are appended with their own ranks and an `isLateEntrant` marker, the
  // way benchmark rows have always ridden along with `rank: null` + `isBenchmark`.
  // The client partitions on the marker; nothing about the envelope changes.
  const regular = entries.filter(u => !u._benchmark && !u._lateEntrant);
  const late = entries.filter(u => !u._benchmark && u._lateEntrant);
  const benchmark = entries.filter(u => u._benchmark);
  // ONE batched lookup for the whole board (both sections), not one per row.
  const idMap = _adminIdentityMap(entries.map(u => u.userId));
  const ident = u => idMap.get(u.userId) || _NO_IDENTITY;
  // ONE read of the event's presence configuration for the whole board: whether
  // it RANKS on presence, and (v8.1.7) whether it measured at all.
  const { measured: _presMeasured, rankOnPresence: _pres } = _presenceBasis(competitionId);
  const ranked = sortLeaderboard(regular, _pres).map((u, i) => ({ ...stripInternal(u), ...ident(u), ..._adminPenalties(u, _presMeasured), rank: i + 1 }));
  // Ranked from 1 WITHIN the late section, which is the rank a late entrant's
  // certificate is issued against — so the number an organiser reads here is the
  // number `_mintEligibility` will use.
  const lateRanked = sortLeaderboard(late, _pres).map((u, i) => ({ ...stripInternal(u), ...ident(u), ..._adminPenalties(u, _presMeasured), rank: i + 1, isLateEntrant: true }));
  const benchRanked = sortLeaderboard(benchmark, _pres).map((u) => ({ ...stripInternal(u), ...ident(u), ..._adminPenalties(u, _presMeasured), rank: null, isBenchmark: true }));
  return [...ranked, ...lateRanked, ...benchRanked];
}

// v7.11.0 — GROUP-LEVEL leaderboard. Present when ≥1 group is bound to the comp
// (competition_groups). Ranks GROUP AGGREGATES — the AVERAGE score + AVERAGE
// time-to-solve over each group's ENROLLED, non-staff/benchmark members — together
// with SOLO individuals (participants with direct_assigned=1, i.e. added as
// individuals; these ALSO appear on their own, per spec req 6). A group-origin-only
// member (direct_assigned=0) appears ONLY inside its group (req 1). Staff +
// benchmark are excluded throughout (req 5). Ranking uses the SAME invariant as the
// individual board (v7.8.1): average score DESC, then average time-to-solve ASC.
// v7.11.7 — the group board is OPT-IN per competition (group_leaderboard_enabled,
// default OFF) AND only renders when there are >=2 NON-EMPTY bound groups — a
// "non-empty" group being one with >=1 eligible enrolled member (i.e. one that
// contributes a row; a group whose only members are staff/benchmark/not-enrolled
// doesn't count). Any gate not met → null, so both UIs hide the board (avoids a
// lone-team or empty "Team Rankings"). Returns the ranked rows only when shown.
// v7.12.3 (audit M4) — snapshot-at-end freeze. The individual board of an ended comp
// is frozen (submissions + competition_users stop changing), but groups are REUSABLE
// across competitions, so post-end group-membership edits would silently recompute a
// finished comp's Team Rankings (a removed member drops their group's average; adding
// an already-enrolled participant to a bound group pulls their frozen score in). To
// freeze the team board we persist a snapshot of the computed rows per (competition,
// timeslot) the FIRST time the board is read after the comp is fully ended, and serve
// that snapshot on every subsequent post-end read. The snapshot is invalidated when a
// comp is revived (extended back to live) so a re-end recomputes fresh — see
// invalidateGroupLeaderboardSnapshot().
const _GROUP_SNAP_SENTINEL = "__global__"; // slot_key for the null (global-mode) timeslot
function _groupSnapKey(timeslotId) { return timeslotId == null ? _GROUP_SNAP_SENTINEL : String(timeslotId); }
function _getGroupSnapshot(competitionId, timeslotId) {
  const row = db.prepare("SELECT board FROM group_leaderboard_snapshots WHERE competition_id=? AND slot_key=?")
    .get(competitionId, _groupSnapKey(timeslotId));
  if (!row) return undefined;            // no snapshot yet
  try { return JSON.parse(row.board); }  // null (board was empty at freeze) or the frozen rows array
  catch { return undefined; }            // corrupt row → recompute
}
function _saveGroupSnapshot(competitionId, timeslotId, board) {
  // First write wins: if a concurrent read already froze it, keep that one.
  db.prepare("INSERT OR IGNORE INTO group_leaderboard_snapshots (competition_id, slot_key, board, created_at) VALUES (?,?,?,?)")
    .run(competitionId, _groupSnapKey(timeslotId), JSON.stringify(board == null ? null : board), now().toISOString());
}
// Called on comp revive (ended→live) so a stale end-state snapshot can't be served if
// the comp ends again. Safe to call unconditionally (no-op when nothing is frozen).
function invalidateGroupLeaderboardSnapshot(competitionId) {
  db.prepare("DELETE FROM group_leaderboard_snapshots WHERE competition_id=?").run(competitionId);
}

/**
 * Freeze the team board(s) NOW, at the moment a competition becomes fully ended.
 *
 * ext-audit v7.15.6 (MEDIUM) — the snapshot used to be written lazily, on the
 * first post-end READ. Everything between the end and that first read was still
 * live, so an admin removing a group member in that window silently rewrote the
 * finished competition's official standings and then froze the WRONG figures
 * permanently. The auditor moved a team from 22.5 pts / rank 2 to 45 pts / rank 1
 * that way. The window is not small in the case this feature exists for: a comp
 * that ends overnight and is never opened stays mutable indefinitely, which is
 * exactly the "a winner could flip a month later" scenario it was built to stop.
 *
 * Freezes EVERY key the readers can ask for — the global sentinel plus one per
 * timeslot — because in per_slot mode a participant read only freezes their own
 * slot, leaving unviewed slots mutable. `_saveGroupSnapshot` is INSERT OR IGNORE
 * (first write wins), so this is idempotent and the lazy path below remains a
 * harmless backstop. A `null` board is itself a legitimate frozen value.
 *
 * Best-effort and post-commit at every call site: freezing is bookkeeping, and it
 * must never be able to fail the end transition that triggered it.
 */
function freezeGroupLeaderboardSnapshots(competitionId) {
  try {
    const comp = getCompetition(competitionId);
    if (!comp) return;
    const _slotIds = db.prepare("SELECT id FROM competition_timeslots WHERE competition_id=?")
      .all(competitionId).map(r => r.id);
    // v7.21.9 — the inclusive-millisecond boundary made this gate refuse the very
    // transition that called it. `_singleSlotStatus` treats the effective end as
    // INCLUSIVE (`if (n <= effEnd) return "live"`), and the all-solved auto-end
    // stamps `ended_at = now()` and then calls this a few synchronous statements
    // later — so in the common case `now === ended_at` to the millisecond, the
    // competition still reads "live", and the eager freeze silently did nothing.
    // The work then fell to the LAZY freeze on first read, which is exactly the
    // mutable window v7.15.6 introduced the eager freeze to close. A stamped
    // `ended_at` that is not in the future IS an end; only single-slot
    // competitions get the shortcut, because for a multi-slot competition
    // `ended_at` can be set while individual slots are still running.
    // v8.12.4 — the status functions themselves now treat a stamped end as
    // exclusive, so this shortcut is REDUNDANT; it is kept as defence in depth
    // for the one transition that must never silently skip the freeze.
    const _endedAtMs = comp.ended_at ? Date.parse(comp.ended_at) : NaN;
    const _hardEnded = _slotIds.length === 0 && Number.isFinite(_endedAtMs) && _endedAtMs <= Date.now();
    if (!competitionFullyEnded(comp) && !_hardEnded) return;
    // v7.21.9 — do NOT freeze a `null` that exists only because the feature was
    // OFF at the end. `_computeGroupLeaderboard` returns null for two different
    // reasons, and a stored null is served for ever by buildGroupLeaderboard
    // (`snap !== undefined`). So a competition that ended with the team board
    // disabled froze an empty board, and an admin who later enabled the flag —
    // with two non-empty bound groups sitting right there — could NEVER see Team
    // Rankings, with no error and no route back except reviving the competition.
    // Freezing a null when the flag was ON is correct and kept: "there genuinely
    // were fewer than two non-empty groups" is a real answer worth protecting.
    const flagOn = !!db.prepare("SELECT group_leaderboard_enabled FROM competitions WHERE id=?")
      .get(competitionId)?.group_leaderboard_enabled;
    for (const tsId of [null, ..._slotIds]) {
      if (_getGroupSnapshot(competitionId, tsId) !== undefined) continue;   // already frozen
      // `fresh` is load-bearing: this writes the OFFICIAL result, and the cache
      // it would otherwise read can predate the submission that ended the comp.
      const board = _computeGroupLeaderboard(competitionId, tsId, { fresh: true });
      if (board == null && !flagOn) continue;   // nothing to protect; freeze lazily if enabled later
      _saveGroupSnapshot(competitionId, tsId, board);
    }
  } catch (e) { /* never break an end transition on snapshot bookkeeping */ swallowed("leaderboard:group-snapshot-freeze", e); }
}
function buildGroupLeaderboard(competitionId, timeslotId, opts = {}) {
  // Read the opt-in flag fresh (cheap PK lookup) so a toggle takes effect on the
  // next poll without any leaderboard-cache invalidation (the group board is not
  // cached — it is recomputed per request). The flag gates VISIBILITY even for a
  // frozen board (an admin who turns it off post-end still hides Team Rankings).
  const flag = db.prepare("SELECT group_leaderboard_enabled FROM competitions WHERE id=?").get(competitionId);
  if (!flag || !flag.group_leaderboard_enabled) return null;
  // v8.13.3 — A SLOT THAT IS NOT THIS COMPETITION'S IS NOT A KEY THE OFFICIAL BOARD
  // MAY BE FROZEN UNDER. `_groupSnapKey` maps null to "__global__", so a caller-
  // supplied "__global__" (GET /api/admin/leaderboard?groups=1&timeslotId=__global__
  // on a per_slot event — the create default) computed the board for a slot that
  // does not exist (empty → null) and the lazy path below PERSISTED that null under
  // the competition's GLOBAL key: Team Rankings hidden for everyone until a revive.
  // Any other unknown or foreign string inserted a junk snapshot row per spelling.
  // The persisting function validates its own key, so every caller is covered and
  // the stored key format is untouched (changing the sentinel would orphan rows
  // already frozen under real slot ids). The admin route now 404s such a slot
  // first, which makes this defence in depth for that door — source-pinned.
  if (timeslotId != null) {
    const _ts = getTimeslot(String(timeslotId));
    if (!_ts || _ts.competition_id !== competitionId) return null;
  }
  // Frozen once fully ended: serve the snapshot, lazily creating it on first read.
  const fullComp = getCompetition(competitionId);
  if (fullComp && competitionFullyEnded(fullComp)) {
    const snap = _getGroupSnapshot(competitionId, timeslotId);
    if (snap !== undefined) return snap;                 // frozen (null or rows)
    // v7.21.9 — the lazy path PERSISTS too (this is the backstop for a comp that
    // ended with no eager freeze), so it must also bypass the cache. The flag is
    // known ON here — buildGroupLeaderboard returned early otherwise — so a null
    // computed at this point is the genuine "fewer than two non-empty groups"
    // answer and is correct to freeze.
    const live = _computeGroupLeaderboard(competitionId, timeslotId, { fresh: true });
    _saveGroupSnapshot(competitionId, timeslotId, live);
    return live;
  }
  return _computeGroupLeaderboard(competitionId, timeslotId, opts);
}
function _computeGroupLeaderboard(competitionId, timeslotId, opts = {}) {
  const comp = db.prepare("SELECT group_leaderboard_enabled FROM competitions WHERE id=?").get(competitionId);
  if (!comp || !comp.group_leaderboard_enabled) return null;
  // v8.12.6 — a FULLY-ENDED event's team board is the teams that were bound when
  // it ENDED. An event still taking late entries can have a group bound to it
  // afterwards (that is how a cohort is admitted late), and without this filter a
  // board computed after the end — the lazy freeze on first read, a scheduler tick
  // that had not yet run, or an organiser turning Team Rankings on afterwards —
  // would rank a team that did not exist at the end, averaging members who played
  // before the end under a name they only acquired afterwards. `assigned_at` is
  // stamped by the only bind statement (the assign route); a NULL (a row from
  // before that column was written) is kept, the tolerant reading.
  const _cRow = getCompetition(competitionId);
  const _boundCutoff = _cRow && competitionFullyEnded(_cRow) ? competitionEffectiveEnd(_cRow) : null;
  const boundGroupIds = (_boundCutoff
    ? db.prepare("SELECT group_id FROM competition_groups WHERE competition_id=? AND (assigned_at IS NULL OR assigned_at <= ?)")
        .all(competitionId, _boundCutoff.toISOString())
    : db.prepare("SELECT group_id FROM competition_groups WHERE competition_id=?").all(competitionId)
  ).map(r => r.group_id);
  if (boundGroupIds.length < 2) return null;               // <2 bound → can't have >=2 non-empty
  // v8.6.0 — late entrants are excluded here too, and it follows rather than being
  // a separate decision: this board is FROZEN at the moment the event fully ends
  // (v7.15.6), and every late entrant's score is written after that instant. Their
  // rows would be absent from the snapshot whatever this filter said, so including
  // them would make a team's average depend on whether the board happened to be
  // read before or after the freeze. A team's official standing is settled when the
  // event is.
  const entries = buildLeaderboardEntries(competitionId, timeslotId, opts).filter(u => !u._staff && !u._benchmark && !u._lateEntrant);
  if (!entries.length) return null;
  const byId = new Map(entries.map(e => [e.userId, e]));
  const userIds = entries.map(e => e.userId);
  const uph = "SELECT value FROM json_each(?)";
  // direct_assigned=1 → participant was added as an individual → gets a SOLO row.
  const soloIds = new Set(
    db.prepare(`SELECT user_id FROM competition_users WHERE competition_id=? AND direct_assigned=1 AND user_id IN (${uph})`)
      .all(competitionId, JSON.stringify(userIds)).map(r => r.user_id)
  );
  // Bound-group memberships, restricted to enrolled + eligible members (byId).
  const gph = "SELECT value FROM json_each(?)";
  const groups = new Map(); // groupId → { groupId, name, memberIds:[] }
  for (const r of db.prepare(
    `SELECT gm.group_id, gm.user_id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.group_id IN (${gph})`
  ).all(JSON.stringify(boundGroupIds))) {
    if (!byId.has(r.user_id)) continue; // not enrolled, or staff/benchmark → excluded
    if (!groups.has(r.group_id)) groups.set(r.group_id, { groupId: r.group_id, name: r.name, memberIds: [] });
    groups.get(r.group_id).memberIds.push(r.user_id);
  }
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  // v7.28.0 — the penalty breakdown for a TEAM, as a TOTAL over its members.
  //
  // READ THIS BEFORE ASSUMING THE ROW SUBTRACTS. `score` on a group row is a
  // MEAN (`avg(ms.map(m => m.score))` below) while these are SUMS, so
  // `score - pointsLostTotal` is meaningless on a group row — it is out by a
  // factor of memberCount. That is deliberate, not an oversight: "how many
  // wrong answers did this team make" is the question an organiser actually
  // asks, and averaging a mistake count answers nothing. The two bases are
  // never presented unlabelled — the CSV heads this group as "Avg Score"
  // (matching the on-screen board) and every penalty column as "(team total)".
  // A SOLO row is a one-member team, so there the sum IS the member's own
  // figure and the row does reconcile exactly.
  //
  // Computed HERE, from the member entries already resolved one line below,
  // rather than from a member-id list carried on the row. Two reasons, both
  // load-bearing: a row on the participant wire must never carry a team roster
  // (`memberIds.length` is the `memberCount` that routes/leaderboard.js strips
  // for a stated fairness reason), and these values are FROZEN into
  // `group_leaderboard_snapshots` with the score they sit beside — recomputing
  // them live against a frozen row is exactly the contradiction the v7.15.7
  // legacy-badge rule forbids, and it is reachable, because deleting a
  // participant removes their submissions and hint_reveals outright.
  const teamPenalties = (ms) => ({
    incorrectCount: sum(ms.map(m => m._incorrectCount || 0)),
    pointsLostIncorrect: sum(ms.map(m => m._pointsLostIncorrect || 0)),
    hintCount: sum(ms.map(m => m._hintCount || 0)),
    pointsLostHints: sum(ms.map(m => m._pointsLostHints || 0)),
    pointsLostTotal: sum(ms.map(m => (m._pointsLostIncorrect || 0) + (m._pointsLostHints || 0))),
  });
  const groupRows = [];
  for (const g of groups.values()) {
    if (!g.memberIds.length) continue; // empty group (no eligible enrolled member) → doesn't count
    const ms = g.memberIds.map(id => byId.get(id));
    groupRows.push({
      type: "group", groupId: g.groupId, name: g.name, memberCount: g.memberIds.length,
      score: avg(ms.map(m => m.score)),                       // req 2 — mean of member scores
      solveTimeMs: Math.round(avg(ms.map(m => m.solveTimeMs || 0))), // req 2 — mean time-to-solve
      allSolved: ms.every(m => m.allSolved),
      ...teamPenalties(ms),
    });
  }
  // v7.11.7 — the defining gate: fewer than 2 NON-EMPTY groups → no team board.
  if (groupRows.length < 2) return null;
  const rows = [...groupRows];
  for (const e of entries) {
    if (!soloIds.has(e.userId)) continue;                     // req 1/4/6 — only direct individuals appear solo
    rows.push({
      type: "individual", userId: e.userId, nickname: e.nickname, avatar: e.avatar,
      score: e.score, solveTimeMs: e.solveTimeMs, allSolved: e.allSolved,
      // v8.1.7 — carried so a solo pair can be ordered by the SHARED comparator
      // below. Underscore-prefixed, and the final map runs `stripInternal`, so it
      // reaches neither the wire nor `group_leaderboard_snapshots` — the group
      // rows are the one builder output a participant sees under public names, so
      // an internal that leaked here would trip the structural allow-list lock.
      _presenceMs: e._presenceMs || 0,
      // A solo row is a one-member team, so the "team total" IS this person's
      // own figure and `score - pointsLostTotal` reconciles exactly here.
      ...teamPenalties([e]),
    });
  }
  // v8.1.7 — SOLO ROWS HONOUR THE EVENT'S RANKING BASIS; GROUP ROWS CANNOT.
  //
  // A solo row is the same participant the individual board just ranked, so the
  // two must order a tied pair identically — they are rendered one above the
  // other in the SAME payload, and a post-end snapshot freezes whichever order
  // this produced. That is the whole of finding #30, and delegating to
  // `compareLeaderboardEntries` is what makes them agree by construction.
  //
  // The scope is SOLO-vs-SOLO and nothing wider, deliberately:
  //
  //   * a GROUP row is an aggregate of several people with no single presence
  //     value — summing or averaging one would invent a number, and ranking a
  //     team against a person on it would compare two different quantities;
  //   * so a mixed group/solo pair keeps the existing composite key, which
  //     always orders a group ahead of a tied individual. That is a CONSTANT
  //     relation rather than a data-dependent one, which is what keeps the sort
  //     transitive: for any set tied on score and elapsed time the order is
  //     "every group (by group id), then every solo", and the presence rule only
  //     ever reorders within that second block.
  //
  // v8.3.11 — the caveat that used to sit here said the intransitivity needed a
  // millisecond collision and was therefore unreachable. Both halves were wrong;
  // see the block comment in `compareLeaderboardEntries`. Being written down as
  // unreachable is exactly what kept it from being fixed.
  const _soloPres = _usePresenceRanking(competitionId);
  rows.sort((a, b) => compareGroupBoardRows(a, b, _soloPres));
  // `stripInternal` rather than a spread: the solo rows carry `_presenceMs` for
  // the sort above and it must not survive into the snapshot or the wire.
  return rows.map((r, i) => ({ ...stripInternal(r), rank: i + 1 }));
}

// THE BOARD A MEMBER IS RANKED ON. We read competition_users.timeslot_id
// (the user's LOCKED, competed-in slot) rather than req.session.timeslotId —
// the slot is immutable once locked, and the DB value is
// self-contained (no need for the comp to be the currently-selected one) AND
// strictly correct: buildLeaderboard(comp, thisSlot) ranks the user among
// their actual slot-mates. A session slot could point at a slot the user never
// joined → me=undefined → a spurious 403. Global mode → null.
function boardSlotOf(comp, userId) {
  if (comp.leaderboard_mode !== "per_slot") return null;
  const row = db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId);
  return row && row.timeslot_id ? row.timeslot_id : null;
}

/**
 * THE BOARDS AN EVENT RANKS ON: one definition, read by the certificates'
 * podium (routes/badge.js `_placementPodium`, the top-three download) and the
 * event team's report (lib/event-team.js `buildReportData`), so the report can
 * never place someone where their certificate does not (operator ruling, 17 Nov
 * 2026). In per_slot mode each session a member holds is a board of its own, and
 * a member holding none is ranked on the event-wide board, as the mint ranks
 * them (`boardSlotOf`); otherwise there is the one event-wide board. The
 * event-wide board has the late entrants' board beside it (late entry is for
 * sessionless events only, so a session has none). Order: the event-wide board
 * first, then sessions by start time and name, each main board before its late
 * board. `slotOf` maps each member to the slot `boardSlotOf` answers for them.
 */
function rankedBoards(comp) {
  const perSlot = comp.leaderboard_mode === "per_slot";
  const rows = db.prepare(
    `SELECT cu.user_id, cu.timeslot_id, t.name AS ts_name, t.start_time AS ts_start
       FROM competition_users cu LEFT JOIN competition_timeslots t ON t.id = cu.timeslot_id
      WHERE cu.competition_id=?`
  ).all(comp.id);
  const slotOf = new Map();
  const slots = new Map();   // timeslot id -> { name, start }
  for (const r of rows) {
    const ts = perSlot && r.timeslot_id ? r.timeslot_id : null;
    slotOf.set(r.user_id, ts);
    if (ts && !slots.has(ts)) slots.set(ts, { name: r.ts_name || null, start: r.ts_start || "" });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const boards = [];
  if (!slots.size || rows.some(r => slotOf.get(r.user_id) === null)) {
    boards.push({ timeslotId: null, timeslotName: null, late: false }, { timeslotId: null, timeslotName: null, late: true });
  }
  const sessions = [...slots.entries()].sort((a, b) => cmp(String(a[1].start), String(b[1].start)) || cmp(String(a[1].name || ""), String(b[1].name || "")) || cmp(a[0], b[0]));
  for (const [id, s] of sessions) boards.push({ timeslotId: id, timeslotName: s.name, late: false });
  return { boards, slotOf };
}

module.exports = {
  getParticipantScore, scoreTotals, ADMIN_PENALTY_FIELDS,
  boardSlotOf, rankedBoards,
  buildLeaderboard, buildAdminLeaderboard, buildGroupLeaderboard, buildLateLeaderboard,
  invalidateLeaderboardCache, invalidateLeaderboardCacheForEntrant, LEADERBOARD_ENTRY_COALESCE_MS, leaderboardVersion, invalidateGroupLeaderboardSnapshot, freezeGroupLeaderboardSnapshots, _leaderboardCacheEntryCount,
  leaderboardComputeCount,
  // v8.1.0 (PR 35) — exported for the ranking lock. The presence tie-break is a
  // one-way door and its rule (finishers only, opt-in only) cannot be driven
  // through the API without clock control the suite does not have, so the
  // comparator is asserted directly — it IS the rule.
  sortLeaderboard,
  // v8.1.7 — the pair comparator both boards share, exported for the same reason
  // and asserted the same way: the lock has to show the individual board and the
  // group board's solo rows ordering one tied pair identically, which needs the
  // comparator itself.
  compareLeaderboardEntries,
  // v8.3.11 — the group board's own comparator. Exported for the same reason and
  // asserted the same way: it carries a cycle the individual fix does not reach,
  // and as an inline closure no spec could see it.
  compareGroupBoardRows,
};
