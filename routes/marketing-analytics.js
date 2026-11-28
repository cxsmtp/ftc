"use strict";

// MARKETING ANALYTICS — GET /api/admin/analytics/marketing.
//
// The platform's own success figures across events (lib/marketing-analytics.js
// holds every definition). Platform-wide by nature, so it is held by its own
// permission, `analytics.marketing` (lib/rbac.js PLATFORM_WIDE_PERMISSIONS: a
// role scoped to its events can never hold it, and an event admin never does);
// the built-in admin and superadmin hold it.
//
// Query (every field optional, each ONE string; anything else is 400):
//   from    ISO date or instant: the earliest event START counted (inclusive)
//   to      ISO date or instant: the end of the range (exclusive); default now
//   kinds   comma-separated event kinds (booth, tournament, program)
//   events  comma-separated event ids (at most BULK_ADMIN_MAX)
//
// Guards, in order: requireAdmin, requirePermission (read live), the limiter
// (after the guards: an anonymous 401 drains nothing). The body depends on what
// was asked, never on who asked (every holder sees the whole platform), so the
// short cache is keyed by the request URL alone.
// Registered from server.js using an absolute, method-specific path.

const { requireAdmin, requirePermission, rateLimit } = require("../lib/middleware");
const { buildMarketingReport, KIND_VALUES } = require("../lib/marketing-analytics");
const { BULK_ADMIN_MAX, PERF_SPAN_SLOW_MS } = require("../lib/config");
const { now } = require("../lib/time");
const { log } = require("../lib/log");

const marketingLimiter = rateLimit(60_000, 30, "marketing-analytics");
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 64;
const _cache = new Map();   // req.url -> { ts, body }

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** A query field: absent, or one string. `{ok, value}`. */
function _field(q, name) {
  const v = q[name];
  if (v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  return { ok: true, value: v };
}

function _bad(res, code, error) { return res.status(400).json({ error, code }); }

function _instant(s) {
  if (!DATE_RE.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

module.exports = function register(app) {
  app.get("/api/admin/analytics/marketing", requireAdmin, requirePermission("analytics.marketing"), marketingLimiter, (req, res) => {
    const t0 = process.hrtime.bigint();
    const q = req.query || {};
    const f = {}, names = ["from", "to", "kinds", "events"];
    for (const n of names) {
      const r = _field(q, n);
      if (!r.ok) return _bad(res, "marketing_query_invalid", `"${n}" must be given once, as text.`);
      f[n] = r.value;
    }
    const nowIso = now().toISOString();
    const from = f.from === null ? null : _instant(f.from);
    if (f.from !== null && !from) return _bad(res, "marketing_range_invalid", "\"from\" must be a date such as 2026-01-31.");
    const to = f.to === null ? nowIso : _instant(f.to);
    if (!to) return _bad(res, "marketing_range_invalid", "\"to\" must be a date such as 2026-01-31.");
    if (from && Date.parse(from) >= Date.parse(to)) return _bad(res, "marketing_range_invalid", "The start of the range must come before its end.");

    let kinds = null;
    if (f.kinds !== null) {
      kinds = [...new Set(f.kinds.split(",").map(s => s.trim()).filter(Boolean))];
      const unknown = kinds.find(k => !KIND_VALUES.includes(k));
      if (unknown !== undefined) return _bad(res, "marketing_kind_unknown", `Unknown event type "${unknown.slice(0, 40)}". Use ${KIND_VALUES.join(", ")}.`);
    }
    let eventIds = null;
    if (f.events !== null) {
      eventIds = [...new Set(f.events.split(",").map(s => s.trim()).filter(Boolean))];
      if (eventIds.length > BULK_ADMIN_MAX) return _bad(res, "marketing_too_many_events", `Choose at most ${BULK_ADMIN_MAX} events.`);
      if (eventIds.some(id => !ID_RE.test(id))) return _bad(res, "marketing_event_invalid", "An event id is not valid.");
    }

    const key = req.url || "";
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return res.json(hit.body);

    const body = buildMarketingReport({ from, to, nowIso, kinds, eventIds });
    if (_cache.size >= CACHE_MAX) { const k = _cache.keys().next().value; if (k !== undefined) _cache.delete(k); }
    _cache.delete(key);
    _cache.set(key, { ts: Date.now(), body });
    res.json(body);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > PERF_SPAN_SLOW_MS) {
      log.warn({ req_id: req.id, endpoint: "/api/admin/analytics/marketing", total_ms: ms.toFixed(1), events: body.events.length },
        "[perf-span] slow /api/admin/analytics/marketing");
    }
  });
};
