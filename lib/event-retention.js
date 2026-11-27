"use strict";

// Event-data retention purge (v7.7.17). The structured audit/event tables
// (competition_events, timeslot_events, user_events, settings_events,
// challenge_events, and since the Audit page orphan_events) historically had NO expiry — rows lived for the life of the
// DB. Since v7.7.16 those `details` blobs also carry per-request forensic PII
// (the acting admin's IP + user-agent via reqContext) on every entity edit, so
// the operator defined a RETENTION WINDOW: audit events older than
// EVENT_RETENTION_DAYS (default 730 = 2 years) are purged.
//
// Posture mirrors lib/account-reaper.js: a DAILY background sweep (+ once at
// boot), `unref`'d so it never keeps the process alive, capped per run to bound
// the write-lock hold, and SKIPPED under NODE_ENV=test (tests drive
// sweepExpiredEvents() via POST /api/test/purge-events). Superadmins can also
// trigger a sweep on demand via POST /api/admin/retention/purge.
//
// OUT OF SCOPE (by design):
//   • the app.jsonl audit mirror — log files are rotated/quota-purged separately
//     (scripts/purge.sh), so the DB tables were the only un-expiring copy.
//   • entity_status_observations — scheduler bookkeeping (one row per entity,
//     PK entity_type+entity_id), not a forensic history.
//   • task_versions — backs the task "restore to version" feature, not a log.
//   • the Checkmarx One removal ledger (lib/cxone-ledger.js) — a row there is
//     the only way left to finish an erasure in the tenant, so it is never
//     dropped for its age (lib/cxone-withdraw.js flags it instead).
//
// THREE NON-AUDIT TABLES RIDE THE SAME DAILY PASS, each by a window of its own and
// reported apart from `counts` (which mirrors EVENT_TABLES exactly): soft-deleted
// event templates, TEMPLATE_RESTORE_DAYS after their deletion; the
// congratulations email's one-time LinkedIn share links, 30 days after they
// expired (sweep #347; lib/certificate-share.js purgeExpiredShareLinks); and
// `images` rows nothing references, once past a 7-day grace period
// (lib/image-sweep.js sweepOrphanedImages).
//
// THE IMAGE SWEEP ALONE IS HELD while the instance is out of service: it runs
// only when the caller hands `opts.isHealthy` and it answers true (server.js
// `_instanceInService`: the boot integrity and schema checks passed and
// maintenance is off; the daily reaper, POST /api/admin/retention/purge and
// POST /api/test/purge-events each pass it). A missing predicate holds it too,
// so a new caller that forgets it deletes no picture. A held pass reports
// `images_held: true`; the event, template and share-link purges run regardless
// (their rows age out by timestamp alone, while the image deletion is only as
// safe as its read of every holder).
//
// Direction: event-retention → { db, time, audit } (plus lazy requires of
// event-template-builtins, certificate-share and image-sweep). Nothing there may
// require it.

const db = require("../db");
const { swallowed } = require("./best-effort");
const { now } = require("./time");
const { recordOrphanedAuditEvent } = require("./audit");

// 2-year default; override with EVENT_RETENTION_DAYS (whole days, >= 1).
const _envDays = parseInt(process.env.EVENT_RETENTION_DAYS, 10);
const EVENT_RETENTION_DAYS = (Number.isInteger(_envDays) && _envDays >= 1) ? _envDays : 730;
const EVENT_RETENTION_MS = EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PURGE_MAX_PER_RUN = 20000;                  // per-table blast-radius cap per tick
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;    // daily

// The forensic audit-event tables + their timestamp column. (Single-row
// bookkeeping / feature-backing tables are intentionally absent — see header.)
const EVENT_TABLES = [
  { table: "competition_events", ts: "changed_at" },
  { table: "timeslot_events",    ts: "changed_at" },
  { table: "user_events",        ts: "changed_at" },
  { table: "settings_events",    ts: "changed_at" },
  { table: "challenge_events",   ts: "occurred_at" },
  // The DB copy of the orphaned audit events (lib/audit.js
  // recordOrphanedAuditEvent) — the same forensic detail, the same window.
  { table: "orphan_events",      ts: "changed_at" },
];

let _lastPurge = null; // { at, cutoff, retention_days, counts:{table:n}, total, cappedTables:[...] }

// One purge pass. opts: { ttlMs, limit, now, actor, isHealthy } (all optional —
// tests pass ttlMs/limit/now; the manual route passes actor; without isHealthy
// the image sweep is held, see the header). Returns the summary object.
function sweepExpiredEvents(opts = {}) {
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : EVENT_RETENTION_MS;
  const limit = opts.limit != null ? opts.limit : PURGE_MAX_PER_RUN;
  const nowMs = (opts.now || now()).getTime();
  const cutoffIso = new Date(nowMs - ttlMs).toISOString();
  const counts = {};
  const cappedTables = [];
  let total = 0;
  for (const { table, ts } of EVENT_TABLES) {
    // Capped delete via a rowid subquery — better-sqlite3 isn't built with
    // SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so DELETE ... LIMIT isn't available;
    // bounding the rowid set keeps the write-lock hold short on a big backlog
    // (the remainder drains on the next daily tick).
    const stmt = db.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${ts} < ? ORDER BY ${ts} ASC LIMIT ?)`
    );
    let n = 0;
    try { n = stmt.run(cutoffIso, limit).changes; }
    catch (e) { try { console.error("event retention: purge failed for", table, e.message); } catch (e2) { swallowed("event-retention:purge-failure-log", e2); } }
    counts[table] = n;
    total += n;
    if (n >= limit) cappedTables.push(table); // hit the per-run cap — more remain for next tick
  }
  // v8.17.0 — soft-deleted event templates are purged TEMPLATE_RESTORE_DAYS after
  // their deletion (until then "Recently deleted" restores them). A built-in or
  // protected row is never soft-deleted, so the predicate needs only deleted_at.
  // Reported apart from `counts` (which mirrors EVENT_TABLES exactly).
  let templatesPurged = 0;
  {
    const { TEMPLATE_RESTORE_DAYS } = require("./event-template-builtins");
    const tplTtl = opts.templateTtlMs != null ? opts.templateTtlMs : TEMPLATE_RESTORE_DAYS * 86400000;
    const tplCutoff = new Date(nowMs - tplTtl).toISOString();
    try {
      const gone = db.prepare("SELECT id, name FROM event_templates WHERE deleted_at IS NOT NULL AND deleted_at < ?").all(tplCutoff);
      if (gone.length) {
        templatesPurged = db.prepare("DELETE FROM event_templates WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(tplCutoff).changes;
        for (const g of gone) {
          try { recordOrphanedAuditEvent("event_template", g.id, "purged", opts.actor || "system", { name: g.name, ...(opts.reqContext || {}) }); }
          catch (e) { swallowed("event-retention:template-purged-emit", e); }
        }
      }
    } catch (e) { try { console.error("event retention: template purge failed:", e.message); } catch (e2) { swallowed("event-retention:purge-failure-log", e2); } }
  }
  // Sweep #347 — the congratulations email's one-time LinkedIn share links, 30
  // days after they expired (used or not), oldest first and capped per run like
  // the tables above. Until then an old link says it has expired; after, it is the
  // uniform not-found page. They are capabilities, not history, so they are
  // counted apart from `total`, and `share_links_capped` says more remain.
  let shareLinksPurged = 0;
  try {
    shareLinksPurged = require("./certificate-share").purgeExpiredShareLinks(db, { nowMs, limit });
  } catch (e) { try { console.error("event retention: share-link purge failed:", e.message); } catch (e2) { swallowed("event-retention:purge-failure-log", e2); } }
  const shareLinksCapped = shareLinksPurged >= limit;
  // Images nothing references, past their grace period (lib/image-sweep.js: one
  // synchronous pass, its own per-run cap), only while the instance is in service
  // (see the header). A failure deletes nothing and is logged; the next daily pass
  // tries again.
  let imagesPurged = 0, imagesPurgedIds = [], imagesCapped = false, imagesHeld = false, imagesRefsMs = 0, imagesRefsRows = 0;
  let healthy = false;
  try { healthy = typeof opts.isHealthy === "function" && opts.isHealthy() === true; }
  catch (e) { swallowed("event-retention:health-read", e, { level: "warn" }); }
  if (!healthy) imagesHeld = true;
  else {
    try {
      const r = require("./image-sweep").sweepOrphanedImages({ nowMs, graceMs: opts.imageGraceMs, limit: opts.imageLimit, refsWarnMs: opts.imageRefsWarnMs });
      imagesPurged = r.images_purged; imagesPurgedIds = r.images_purged_ids || []; imagesCapped = r.images_capped; imagesRefsMs = r.images_refs_ms; imagesRefsRows = r.images_refs_rows;
    } catch (e) { try { console.error("event retention: image sweep failed:", e.message); } catch (e2) { swallowed("event-retention:purge-failure-log", e2); } }
  }
  _lastPurge = { at: new Date(nowMs).toISOString(), cutoff: cutoffIso, retention_days: Math.round(ttlMs / 86400000), counts, total, cappedTables, templates_purged: templatesPurged,
    share_links_purged: shareLinksPurged, share_links_capped: shareLinksCapped,
    images_purged: imagesPurged, images_capped: imagesCapped, images_held: imagesHeld, images_refs_ms: imagesRefsMs, images_refs_rows: imagesRefsRows };
  if (total > 0 || shareLinksPurged > 0 || imagesPurged > 0) {
    // Forensic record of the purge itself, as an orphaned event. Its DB copy
    // lands in orphan_events, which this purge also covers — written after the
    // DELETEs and stamped now, so it is never inside the window it reports.
    try {
      recordOrphanedAuditEvent("retention", "events", "events_purged", opts.actor || "system", {
        // v7.21.32 — a MANUAL purge is an admin action and carries their request
        // context; the daily background sweep supplies none and stays "system".
        ...(opts.reqContext || {}),
        cutoff: cutoffIso, retention_days: _lastPurge.retention_days, counts, total, capped: cappedTables,
        // Only when some went, so a pass that removed audit rows alone records
        // exactly what it always did.
        ...(shareLinksPurged > 0 ? { share_links_purged: shareLinksPurged } : {}),
        // …and which pictures went, by id (at most the sweep's cap), so one can
        // be found and restored from a backup taken before the pass.
        ...(imagesPurged > 0 ? { images_purged: imagesPurged, images_purged_ids: imagesPurgedIds } : {}),
      });
    } catch (e) { swallowed("event-retention:purged-emit", e); }
  }
  return { ..._lastPurge };
}

function lastPurge() { return _lastPurge ? { ..._lastPurge } : null; }

let _handle = null;
// opts.isHealthy: the instance-health gate (server.js `_instanceInService`),
// read LIVE on every pass, so lifting maintenance resumes the image sweep with no
// restart; without it every pass holds the image sweep.
function startEventRetentionReaper(opts = {}) {
  // Tests drive sweepExpiredEvents() via the test-only endpoint, so the interval
  // is production-only — same posture as the status scheduler + account reaper.
  if (process.env.NODE_ENV === "test") return;
  if (_handle) return;
  const isHealthy = opts.isHealthy;
  try { sweepExpiredEvents({ isHealthy }); } catch (e) { try { console.error("event retention boot sweep failed:", e.message); } catch (e2) { swallowed("event-retention:console-write", e2); } }
  _handle = setInterval(() => {
    try { sweepExpiredEvents({ isHealthy }); } catch (e) { try { console.error("event retention tick failed:", e.message); } catch (e2) { swallowed("event-retention:console-write", e2); } }
  }, PURGE_INTERVAL_MS);
  if (_handle.unref) _handle.unref(); // never keep the process alive for the purge
}

module.exports = {
  sweepExpiredEvents, startEventRetentionReaper, lastPurge,
  EVENT_RETENTION_DAYS, EVENT_RETENTION_MS, PURGE_MAX_PER_RUN, EVENT_TABLES,
};
