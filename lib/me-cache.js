"use strict";

// Per-user 2-second cache for GET /api/me (profile / membership / role / score).
// SINGLE process-global Map — the single-process invariant requires exactly one
// instance so every invalidation hits the same map GET /api/me reads. Consumers
// import the OPERATIONS (get/set/invalidate), never the raw Map; re-instantiating
// the Map anywhere would silently serve stale profile/score/role.
// (v7.0.0 refactor: extracted from server.js.) Deps: db (for the comp→users fan-out).

const db = require("../db");

// /api/me is polled on every navigation + periodically; the response is stable
// across a 2-second window (profile updates go through PUT /api/me which
// invalidates the entry). At 500 VUs on a 15-s poll cadence this saves ~200 DB
// stmts/s on the hot path.
const _meCache = new Map(); // userId → { ts, payload }
const _ME_CACHE_TTL_MS = 2_000;
const _ME_CACHE_MAX = 5_000;

// Return the cached payload if fresh, else undefined.
function getMeCached(userId) {
  const cached = _meCache.get(userId);
  if (cached && (Date.now() - cached.ts) < _ME_CACHE_TTL_MS) return cached.payload;
  return undefined;
}

// Store a payload, evicting the oldest entry when the cap is hit (LRU shape;
// Map iteration is insertion-ordered in V8).
function setMeCached(userId, payload) {
  if (_meCache.size >= _ME_CACHE_MAX) {
    const oldest = _meCache.keys().next().value;
    if (oldest !== undefined) _meCache.delete(oldest);
  }
  _meCache.set(userId, { ts: Date.now(), payload });
}

function _invalidateMeCache(userId) { if (userId) _meCache.delete(userId); else _meCache.clear(); }

// Bust the per-user /api/me cache for every participant enrolled in the given
// competitions. Used by score-changing writers (task assign/unassign) whose
// effect on a participant's embedded /api/me score would otherwise be masked
// for up to the 2s cache TTL.
function _invalidateMeCacheForComps(compIds) {
  if (!compIds || !compIds.length) return;
  const ph = "SELECT value FROM json_each(?)";
  for (const { user_id } of db.prepare(`SELECT DISTINCT user_id FROM competition_users WHERE competition_id IN (${ph})`).all(JSON.stringify(compIds))) {
    _invalidateMeCache(user_id);
  }
}

function _meCacheSize() { return _meCache.size; }

module.exports = { getMeCached, setMeCached, _invalidateMeCache, _invalidateMeCacheForComps, _meCacheSize };
