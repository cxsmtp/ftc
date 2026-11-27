"use strict";

// 5-second cache for GET /api/admin/participants pages. SINGLE process-global
// Map (single-process invariant). Every write path that changes participant /
// membership / tag / group state MUST call invalidateAdminParticipantsCache()
// after its DB commit so the very-next GET reflects the change (the
// mutations-admin.api.spec.js suite verifies this on every writer). The
// aggregate invalidate clears ALL keys rather than tracking dirty (comp,page,
// limit) tuples — most writes touch multiple pages' users and the small-map
// clear is cheaper than tracking dirty keys. Consumers import the operations,
// never the raw Map. (v7.0.0 refactor: extracted from server.js.) Deps: none.

const _adminParticipantsCache = new Map();
const _ADMIN_PARTICIPANTS_TTL_MS = 5000;
// v7.2.x (audit) — bound the map. Without a cap, distinct (comp,page,limit) keys
// accumulate with only a 5s TTL on READ (no eviction on write), so a busy admin
// session could grow it between the rare full clears. Mirror the me-cache cap.
const _ADMIN_PARTICIPANTS_MAX = 500;

// v8.7.0 — THE KEY CARRIES THE ACTOR, and it must.
//
// Before this the key was `<competition-or-_all>:<page>:<limit>` with no
// actor in it, which was correct only while every admin saw the same rows. An
// EVENT ADMIN sees a narrowed page for the identical (competition, page, limit)
// tuple, so without the actor a superadmin's platform-wide body would be served
// to an event admin — or an event admin's narrowed body to a superadmin, which
// reads as participants having vanished.
//
// `actorKey` names EVERY identity the body is computed from (v8.13.3: the seat AND,
// under impersonation, the hand — see the caller in routes/participants.js), plus
// the tier. It defaults to "_any" so a caller that has not been updated keeps a
// single shared bucket — the pre-v8.7.0 behaviour — rather than silently sharing
// across tiers under a NEW key. Every caller in this repo passes it.
//
// v8.13.3 — THE COMPETITION SEGMENT CANNOT SPELL THE UNFILTERED MARKER. It used
// to be `${competitionId || "_all"}`, so a caller-supplied `?competitionId=_all`
// shared a key with the SPA's own unfiltered read: an unscoped admin's crafted (or
// cross-site, under sameSite=lax) request cached an EMPTY page that their
// Participants pane was then served for the 5 s TTL — and the reverse served the
// whole platform to the `_all` request. A real id is always `c=<id>`; the
// unfiltered list is the bare `all`, which no prefixed segment can equal. page and
// limit are integers parsed by the route, so the key still reads unambiguously
// from the right.
function _adminParticipantsCacheKey(competitionId, page, limit, actorKey) {
  return `${actorKey || "_any"}|${competitionId ? `c=${competitionId}` : "all"}:${page}:${limit}`;
}

// Return the cached response body if fresh, else undefined.
function getCachedParticipantsPage(competitionId, page, limit, actorKey) {
  const cached = _adminParticipantsCache.get(_adminParticipantsCacheKey(competitionId, page, limit, actorKey));
  if (cached && Date.now() - cached.at < _ADMIN_PARTICIPANTS_TTL_MS) return cached.body;
  return undefined;
}

function setCachedParticipantsPage(competitionId, page, limit, body, actorKey) {
  const k = _adminParticipantsCacheKey(competitionId, page, limit, actorKey);
  _adminParticipantsCache.delete(k); // LRU touch — move to tail of insertion order
  _adminParticipantsCache.set(k, { at: Date.now(), body });
  if (_adminParticipantsCache.size > _ADMIN_PARTICIPANTS_MAX) {
    const oldest = _adminParticipantsCache.keys().next().value; // oldest insertion
    if (oldest !== undefined) _adminParticipantsCache.delete(oldest);
  }
}

function invalidateAdminParticipantsCache() {
  _adminParticipantsCache.clear();
}

module.exports = {
  invalidateAdminParticipantsCache,
  getCachedParticipantsPage,
  setCachedParticipantsPage,
};
