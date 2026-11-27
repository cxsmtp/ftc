"use strict";

// Read-only admin event-history routes (competition / timeslot / participant
// audit events). Row-stable pagination via lib/audit's _eventListResponse.
// (v7.0.0 refactor: route split extracted from server.js.)

const { requireAdmin } = require("../lib/middleware");
const { getCompetition, getTimeslot } = require("../lib/competitions");
const { competitionDenied, participantDenied, userEventCompetitionScopeSql, userEventDetailsSql } = require("../lib/event-admin"); // v8.7.0, v8.8.4
const { log } = require("../lib/log");
const {
  _paginationParams, _eventListResponse,
  _adminCompEventsCache, _ADMIN_COMP_EVENTS_TTL_MS, _adminCompEventsCacheKey, _adminCompEventsCacheSet,
} = require("../lib/audit");

// Same env threshold as the access-log perf-span in server.js (env-deterministic).
const { PERF_SPAN_SLOW_MS } = require("../lib/config");

module.exports = function register(app) {
  app.get("/api/admin/competitions/:id/events", requireAdmin, (req, res) => {
    // perf-span instrumentation: a count + max + list query (cached at sub-ms
    // on a hit). Logs the prelude / cache_hit / db_ms breakdown when total
    // wall-clock > PERF_SPAN_SLOW_MS so a regression in this hot history poll
    // is attributable to the DB queries vs. prelude/serialisation.
    const tHandler = process.hrtime.bigint();
    // v8.7.0 — this route bound `:id` straight into the query with NO existence
    // check, so any admin-tier actor could read ANY event's history simply by
    // knowing its id. Resolve it (1s-cached), 404 an unknown one, then refuse an
    // out-of-scope one. It runs before the cache read as well as before the
    // response — the cache key is per-competition, so nothing bleeds across
    // events, but a refusal must not be served from a warm entry either.
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const { offset, limit, paginated, snapshotBefore, snapshotTie } = _paginationParams(req);
    // Cache key includes snapshot + tie so clients with different anchors don't
    // collide; snapshot-less first-page requests still collapse onto one key.
    // JSON-encoded, not `?? "_"`-joined (v8.13.3): with a sentinel, an anchor sent
    // with the literal tie "_" and the same anchor sent with no tie built ONE key
    // for two different filters (the strict tie filter vs the millisecond-only
    // fallback), so either could be served the other's page.
    const cacheKey = _adminCompEventsCacheKey(req.params.id, offset, limit, paginated)
      + ":" + JSON.stringify([snapshotBefore ?? null, snapshotTie ?? null]);
    const cached = _adminCompEventsCache.get(cacheKey);
    let cacheHit = false;
    let body;
    if (cached && Date.now() - cached.at < _ADMIN_COMP_EVENTS_TTL_MS) {
      body = cached.body;
      cacheHit = true;
    } else {
      const countSql = "SELECT COUNT(*) as c FROM competition_events WHERE competition_id=?";
      const listSql = "SELECT id, event_type, changed_by, changed_at, details FROM competition_events WHERE competition_id=? ORDER BY changed_at DESC, rowid DESC LIMIT ? OFFSET ?";
      // anchor query returns BOTH changed_at AND id of the top-ordered row so
      // the tie-key pair can pin pagination under same-ms insert bursts.
      const maxSql = "SELECT changed_at as m, rowid as tie FROM competition_events WHERE competition_id=? ORDER BY changed_at DESC, rowid DESC LIMIT 1";
      body = _eventListResponse(countSql, listSql, maxSql, [req.params.id], paginated, offset, limit, snapshotBefore, snapshotTie);
      _adminCompEventsCacheSet(cacheKey, { at: Date.now(), body }); // audit v7.7.36 (C4) — LRU-capped set
    }
    const tDb = process.hrtime.bigint();
    res.json(body);
    const tRespond = process.hrtime.bigint();
    const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
    const dbMs      = Number(tDb - tHandler) / 1e6;
    const respMs    = Number(tRespond - tDb) / 1e6;
    const totalMs   = preludeMs + dbMs + respMs;
    if (totalMs > PERF_SPAN_SLOW_MS) {
      log.warn({
        req_id: req.id,
        endpoint: "/api/admin/competitions/:id/events",
        competition_id: req.params.id,
        cache_hit: cacheHit,
        total_ms: totalMs.toFixed(1),
        prelude_ms: preludeMs.toFixed(1),
        db_ms: dbMs.toFixed(2),
        respond_ms: respMs.toFixed(2),
        paginated,
        limit,
        offset,
      }, "[perf-span] slow /api/admin/competitions/:id/events");
    }
  });

  app.get("/api/admin/competitions/:id/timeslots/:tsId/events", requireAdmin, (req, res) => {
    // v8.7.0 — `:id` was NEVER READ here: the query keyed on `:tsId` alone, so the
    // parent in the path was decorative and a session id was the whole capability.
    // The parent is now resolved and scope-checked, and the session must belong to
    // it — otherwise an organiser could read any other event's session history by
    // pairing their own competition id with somebody else's session id.
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // The belongs-to assertion is gated on the session EXISTING. An unknown tsId
    // keeps its documented answer — 200 with an empty list (locked since v6.9.21)
    // — which reveals nothing; only a REAL session under a different parent is the
    // cross-event read this closes.
    const ts = getTimeslot(req.params.tsId);
    if (ts && ts.competition_id !== comp.id) return res.status(404).json({ error: "Session not found" });
    const { offset, limit, paginated, snapshotBefore, snapshotTie } = _paginationParams(req);
    const countSql = "SELECT COUNT(*) as c FROM timeslot_events WHERE timeslot_id=?";
    const listSql = "SELECT id, event_type, changed_by, changed_at, details FROM timeslot_events WHERE timeslot_id=? ORDER BY changed_at DESC, rowid DESC LIMIT ? OFFSET ?";
    const maxSql = "SELECT changed_at as m, rowid as tie FROM timeslot_events WHERE timeslot_id=? ORDER BY changed_at DESC, rowid DESC LIMIT 1";
    res.json(_eventListResponse(countSql, listSql, maxSql, [req.params.tsId], paginated, offset, limit, snapshotBefore, snapshotTie));
  });

  app.get("/api/admin/participants/:id/events", requireAdmin, (req, res) => {
    // v8.7.0 — a participant's history is readable only by an organiser of an event
    // they are enrolled in. No 404 is added for an unknown user: this route has
    // always answered an empty list for one, and an event admin is refused by the
    // predicate before that distinction is reachable.
    const denied = participantDenied(req, req.params.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const { offset, limit, paginated, snapshotBefore, snapshotTie } = _paginationParams(req);
    // v8.8.4 — AND THE ROWS, which participantDenied does not cover. That gate
    // answers "may you see this participant"; once it passes, their ENTIRE
    // cross-event history was returned — hint_revealed / feedback_submitted /
    // attempt_grant carry task_title and task_id, first_joined and
    // added_to_competition carry competition_name — for events the actor does not
    // organise. Measured with a control in the same run: the same actor is refused
    // that challenge at /versions with the three-arm message and gets its title
    // from this dialog, which is the DEFAULT primary button on every participant
    // row. It also contradicted ROLES §6, whose sibling column IS narrowed.
    const _hvis = userEventCompetitionScopeSql(req);
    const countSql = `SELECT COUNT(*) as c FROM user_events WHERE user_id=?${_hvis.clause}`;
    const listSql = `SELECT id, event_type, changed_by, changed_at, ${userEventDetailsSql(req)} AS details FROM user_events WHERE user_id=?${_hvis.clause} ORDER BY changed_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    const maxSql = `SELECT changed_at as m, rowid as tie FROM user_events WHERE user_id=?${_hvis.clause} ORDER BY changed_at DESC, rowid DESC LIMIT 1`;
    res.json(_eventListResponse(countSql, listSql, maxSql, [req.params.id, ..._hvis.params], paginated, offset, limit, snapshotBefore, snapshotTie));
  });
};
