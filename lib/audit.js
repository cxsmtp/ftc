"use strict";

// Audit trail + task-version snapshots + per-entity event recording, the
// transaction-aware audit-mirror buffer (runTxnWithMirrorBuffer), the deferred
// app.jsonl mirror (setImmediate), actor resolution (LRU), request-context +
// admin-identity helpers, and the admin competition-events response cache.
// (v7.0.0 refactor: extracted verbatim from server.js. Deps: db, log, time, uuid.)

const crypto = require("crypto");
const db = require("../db");
const { v4: uuid } = require("uuid");
const { log, _redactValue } = require("./log");
const { swallowed } = require("./best-effort");
const { now } = require("./time");
// v8.12.1 — dependency direction is safe: lib/impersonation requires only
// ./util and ./time, never this module or db.
const { impersonationActor } = require("./impersonation");
// v8.13.3 — lib/util requires only `net` at module scope (plus a lazy, pure
// registration-fields require), so this adds no cycle.
const { clampPagingIndex } = require("./util");
const { findUserByAddress } = require("./account-lookup");

const _adminCompEventsCache = new Map();
const _ADMIN_COMP_EVENTS_TTL_MS = 5000;
// audit v7.7.36 (C4) — LRU size cap (matches participants-cache). Keys include
// offset/limit/snapshot, so a multi-page history walk of an ENDED comp creates
// one entry per page (each up to ~250 KB), and invalidate only fires when THAT
// comp gets a new event — so an ended comp's pages would live until restart.
const _ADMIN_COMP_EVENTS_MAX = 500;
function _adminCompEventsCacheSet(key, value) {
  if (_adminCompEventsCache.size >= _ADMIN_COMP_EVENTS_MAX && !_adminCompEventsCache.has(key)) {
    const oldest = _adminCompEventsCache.keys().next().value; // Map is insertion-ordered
    if (oldest !== undefined) _adminCompEventsCache.delete(oldest);
  }
  _adminCompEventsCache.set(key, value);
}

function _adminCompEventsCacheKey(competitionId, offset, limit, paginated) {
  return `${competitionId}:${offset}:${limit}:${paginated ? "p" : "np"}`;
}

function invalidateAdminCompEventsCache(competitionId) {
  if (!competitionId) { _adminCompEventsCache.clear(); return; }
  // Surgical clear — only affected comp's keys, not every cached
  // competition's history. Keys are short strings; the linear scan
  // is fine at the typical handful-of-cached-comps cardinality.
  for (const key of _adminCompEventsCache.keys()) {
    if (key.startsWith(`${competitionId}:`)) _adminCompEventsCache.delete(key);
  }
}

// v8.12.1 — THE AUDIT ACTOR IS THE HUMAN AT THE KEYBOARD. Under impersonation
// `req.session.userId` is the TARGET, and until the event-admin view existed
// that did not matter here: the admin surface was unreachable, so no admin
// emit ever ran under the marker. Now an organiser can be impersonated in
// their own panel, and ~100 admin emits pass this value as `changed_by` — every
// challenge edit, assignment, group change, approval and export a superadmin
// makes through that seat would otherwise be recorded as the organiser's own
// act, the fabricated-action problem v7.14.0 solved for `logout_manual`, at
// scale, on the forensic surface the feature exists to preserve.
//
// The email is read LIVE by the impersonator's id (this function's own
// contract, and v7.21.12's no-frozen-snapshot rule) rather than taken from the
// marker: `POST /api/toggle-admin-view` used to drop `userEmail` from the
// session, so an admin who had toggled before impersonating snapshotted a null
// email and every attribution would have degraded to a UUID. The built-in
// account has no row and keeps its `"superadmin"` label.
//
// The participant-surface convention is UNCHANGED by this: those emits name the
// participant themselves and spread `impersonated_by` beside it, and none of
// them call this helper. `reqContext` (below) now carries the same link on every
// emit, so both surfaces record who was really there.
function getAdminIdentity(req) {
  const imp = req.session && req.session.impersonator;
  if (imp) {
    if (imp.builtinId === "superadmin") return "superadmin";
    const a = imp.userId ? db.prepare("SELECT email FROM users WHERE id=?").get(imp.userId) : null;
    if (a && a.email) return a.email;
    return impersonationActor(req.session);
  }
  if (req.session.userId) {
    const u = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId);
    if (u) return u.email;
  }
  return "superadmin";
}

// v8.12.2 — `details` is an optional JSON-able object stored in
// `task_versions.details`, NULL for every ordinary version. Only the
// `sealed_reveal` writer below passes one; see the db.js migration for what it
// may and may not carry.
const _createTaskVersionTxn = db.transaction((taskId, changedBy, changeType, details = null) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  if (!task) return;
  // Include tags in snapshot so restore covers tag-only changes too
  const tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(taskId).map(r => r.tag);
  // Include currently-linked attachments so restore can re-link the right
  // rows by id + restore their display_name + order_idx. Binaries are
  // identified by id only; they live on disk and are never inlined into the
  // snapshot JSON (would balloon the task_versions table).
  const attachments = db.prepare(
    "SELECT id, display_name, original_name, size_bytes, sha256, order_idx FROM task_attachments WHERE task_id=? AND detached_at IS NULL ORDER BY order_idx, created_at"
  ).all(taskId);
  const snapshot = { ...task, tags, attachments };
  const vn = (db.prepare("SELECT MAX(version_num) as m FROM task_versions WHERE task_id=?").get(taskId)?.m || 0) + 1;
  db.prepare("INSERT INTO task_versions (id, task_id, version_num, changed_by, changed_at, snapshot, change_type, details) VALUES (?,?,?,?,?,?,?,?)")
    .run(uuid(), taskId, vn, changedBy, now().toISOString(), JSON.stringify(snapshot), changeType,
         details && typeof details === "object" ? JSON.stringify(details) : null);
});
// v6.2.8: Map the internal change_type (which names the task_versions.change_type
// column, a small closed enum) to a SEMANTIC event_type that reads well in the
// admin log. Pre-v6.2.8 the audit event type was always the generic string
// "version_created" — every task create / edit / visibility flip / lock /
// restore / tag add / tag remove looked identical in the log. Now the log
// shows `audit:task:published`, `audit:task:locked`, `audit:task:edited`, etc.
// so an operator filtering for "locked" only sees lock events. The change_type
// value is still preserved in details.change_type for back-compat and for the
// history dialog.
const _TASK_EVENT_TYPE_MAP = {
  create:             "created",
  update:             "edited",
  publish:            "published",
  visibility:         "visibility_toggled",
  lock:               "locked",
  unlock:             "unlocked",
  restore:            "restored",
  import:             "imported",
  tag_added:          "tag_added",
  tag_removed:        "tag_removed",
  attachment_added:   "attachment_added",
  attachment_renamed: "attachment_renamed",
  attachment_removed: "attachment_removed",
  // v8.12.2 — the recorded disclosure of a sealed answer + hint to a superadmin.
  sealed_reveal:      "sealed_answer_revealed",
};
function createTaskVersion(taskId, changedBy, changeType, storedImageIds, extraDetails) {
  _createTaskVersionTxn(taskId, changedBy, changeType);
  // Task-scope audit row in app.jsonl. task_versions is the history backing
  // store (surfaced in the Challenge History dialog); this is the source:"audit"
  // mirror so task create/edit rows appear in the Logs pane next to every
  // other event. stored_images lists any new /api/images/ rows persisted from
  // embedded data: URIs in this edit — closes an otherwise-silent side effect.
  // extraDetails (v6.2.8) lets callers pass a `changes: {field:{from,to}}`
  // payload for "edited" flows and from/to snapshots for visibility / lock /
  // publish / restore — so the log shows WHAT changed, not just that it did.
  try {
    const details = { change_type: changeType, ...(extraDetails && typeof extraDetails === "object" ? extraDetails : {}) };
    if (Array.isArray(storedImageIds) && storedImageIds.length) details.stored_images = storedImageIds;
    const eventType = _TASK_EVENT_TYPE_MAP[changeType] || changeType || "edited";
    recordOrphanedAuditEvent("task", taskId, eventType, changedBy, details);
  } catch (e) { swallowed("audit:task-version-emit", e); }
}

// v8.12.2 — THE RECORDED REVEAL. A superadmin who is not the author has been
// shown a sealed challenge's answer and hint; this is the one writer of that
// fact, and it writes it TWICE on purpose, to two stores with different jobs:
//
//   • a `task_versions` row (change_type `sealed_reveal`) — the challenge's
//     History, which is what an admin opens to ask "who has seen this key?".
//     It carries a FULL snapshot like every version (restore refuses an
//     incomplete one, and the diff renderer pairs consecutive snapshots), and a
//     `details` blob of exactly `{via, fields, impersonated_by?, acting_as_id?}`
//     (`sealRevealHistoryDetails` below builds it for every writer).
//     The History dialog renders it as a sentence rather than a diff, skips it
//     as a diff baseline and offers no Restore on it (public/js/features/
//     history.js), and the restore route refuses it by change_type.
//   • the orphaned `task` audit event `sealed_answer_revealed`, mirrored into
//     app.jsonl — the event log, where it lands beside every other admin act
//     with the full `reqContext` (ip, agent, request id, and under impersonation
//     `impersonated_by` + `acting_as`).
//
// `changedBy` is `getAdminIdentity(req)` — under impersonation that is the
// ACTING superadmin (live, by the marker's id), which is the person who saw the
// key. `historyDetails` and `logDetails` are separate arguments rather than one
// object because the two stores must NOT hold the same thing: the request
// context's `ip` / `user_agent` belong in the retention-purged log and never in
// the permanent version table (see the db.js migration comment).
//
// THE SEAT IS STORED AS AN ID IN THE HISTORY, NEVER AS AN EMAIL — and that is a
// privacy property, not a tidiness one. Under impersonation the seat is the
// TARGET, often an ordinary participant, and `task_versions` is permanent
// (retention-exempt, untouched by `deleteUserCascade`), so an email here would
// outlive the account it names; and the versions route hands `details` to
// every organiser `taskViewDenied` admits, so an email here would name a
// participant enrolled only in somebody else's event (the v8.8.4 row-scope
// class). The id resolves to a label at READ time, for a reader entitled to
// see that person (routes/challenges.js, the versions route), and to nothing
// once the account is gone. The log line keeps the email — `reqContext`'s
// `acting_as` — because app.jsonl is retention-purged and admin-only.
function sealRevealHistoryDetails(req, via, fields) {
  const s = req && req.session;
  return {
    via, fields,
    ...(s && s.impersonator ? { impersonated_by: getAdminIdentity(req), acting_as_id: s.userId || null } : {}),
  };
}

// v8.12.6 — THE RECORD TAKES THE WRITE LOCK FIRST (`.immediate`), because every
// caller now refuses the disclosure when this throws (the explicit reveal route
// always did; the two participant-surface sites fail closed since this release),
// so a record that fails for no good reason is a superadmin refused for no good
// reason. The mechanism, stated precisely because older comments in this
// tree stated it wrongly until this release corrected them (they said
// better-sqlite3's transactions "use BEGIN IMMEDIATE", or reasoned as if a
// plain transaction held the write lock from its first read; grep for the
// phrase rather than trusting a count — only `.immediate()` takes the lock at
// BEGIN): a plain `db.transaction(fn)` opens with a DEFERRED
// `BEGIN`, and `_createTaskVersionTxn` READS (the task, its tags, its
// attachments, MAX(version_num)) before it WRITES. Under WAL a transaction that
// holds a read snapshot and then asks for the write lock while ANOTHER PROCESS
// holds it gets SQLITE_BUSY at once — the busy handler is never consulted for
// that upgrade, so `busy_timeout` buys nothing. A brief external writer (an
// operator's sqlite3 session, `scripts/purge.sh --apply`) therefore failed the
// record in milliseconds — measured, 6 ms under a 300 ms lock — while an
// autocommit write beside it simply waited. `.immediate` takes the write lock
// BEFORE the first read, so `busy_timeout` applies and a short lock is waited
// out; only a fault lasting past it (or SQLITE_FULL, an I/O error, a trigger)
// still reaches the callers' fail-closed paths. Nested inside an outer
// transaction it becomes a SAVEPOINT, so a future nested caller stays safe.
// The side effect is stated rather than hidden: under an external lock the
// request now blocks the event loop for up to `busy_timeout` (it is a
// synchronous sleep) instead of failing fast — which is what every other
// write in this process already does.
function recordSealedReveal(taskId, changedBy, historyDetails, logDetails) {
  _createTaskVersionTxn.immediate(taskId, changedBy, "sealed_reveal", historyDetails || null);
  try {
    recordOrphanedAuditEvent("task", taskId, _TASK_EVENT_TYPE_MAP.sealed_reveal, changedBy,
      { change_type: "sealed_reveal", ...(historyDetails || {}), ...(logDetails || {}) });
  } catch (e) { swallowed("audit:sealed-reveal-emit", e); }
}

// v6.13.11 — audit-event-only task log helper. Mirror of
// createTaskVersion's audit side-channel, but WITHOUT the task_versions
// snapshot insert. Used by attachment upload / rename / delete routes:
// those mutations MUST NOT create a new restorable snapshot of the
// whole challenge because a mid-edit admin could accidentally spam the
// History dialog (and later restore cycles) with a snapshot per
// attachment tweak. Only the explicit Save path (PUT /api/admin/tasks/:id
// → createTaskVersion("update", ...)) should capture a restorable
// snapshot, and that snapshot already reflects the current attachment
// set by design (see _createTaskVersionTxn). The audit log still
// records who did what and when so accountability isn't lost.
function recordTaskAuditEvent(taskId, changedBy, eventType, details) {
  try {
    recordOrphanedAuditEvent("task", taskId, eventType, changedBy, details || {});
  } catch (e) { swallowed("audit:task-event-emit", e); }
}

// ── Event-log helpers (entity-scoped admin attribution) ──────────────────────
// These are intentionally synchronous and best called INSIDE an existing transaction
// so the event row and the mutation commit together. Callers pass the admin identity
// via getAdminIdentity(req) so every event is attributed.
function _eventRow() { return [uuid(), now().toISOString()]; }
// Every record*Event call does TWO things:
//   1. Inserts the event row into the corresponding DB table (the structured
//      source of truth consumed by admin "history" dialogs).
//   2. Mirrors a structured line into app.jsonl tagged with source:"audit"
//      so a forensic reader grepping the log file alone has the full picture
//      without needing DB access. The level is "info" uniformly — callers
//      don't use the level dimension for audit events.
// The `source:"audit"` marker separates these rows from generic app logs
// (errors, warnings, console.log output) — filter with `jq 'select(.source=="audit")'`.
//
// Intentional non-auditing (state changes we do NOT record):
//   • `req.session.touch()` and `req.session.save()` keepalive pings — dozens
//     per user per hour, no security signal.
//   • `UPDATE users SET active_competition_id=…` — ephemeral navigation hint.
//     The meaningful event is `select-competition` / session_chosen, both audited.
//   • `UPDATE users SET last_login_time=…` — stats side-effect of login; the
//     `login_success` event already captures the fact of logging in.
//   • `UPDATE competition_users SET ended_popup_seen=1` — purely UI state.
//   • `UPDATE email_reminders SET sent=1` — background dispatcher mark for a
//     DELIVERED reminder; the email itself is logged via sendEmailLogged. A
//     reminder settled unsent because its start had passed records
//     `reminder_skipped` instead, and a restore's mark-sent
//     (scripts/restore-mail.sh) is recorded only as its settings_events
//     `reminders_marked` count.
//   • `DELETE FROM email_reminders WHERE user_id=? AND competition_id=?` when
//     the parent action (reminder set / timeslot selection) is itself audited
//     — logging the reset-before-insert would double-log every reminder op.
//   • `deleteAvatarImage()` / `extractAndStoreImages()` — child effects of a
//     profile / task update whose parent event already fired.
// Each of these is an explicit policy choice, not an accidental omission.
// v6.16.5 — outstanding-deferred-audit-work counter. Pre-fix the
// graceful-shutdown drain at gracefulShutdown() called db.close()
// after _httpServer.close() finished, but the v6.8.2 setImmediate-
// deferred audit-row writes (mirror logs + post-submit event inserts
// + post-select-competition events) could still be queued in the
// libuv micro-task pool when db.close() ran. Closing the DB while
// those callbacks still hold a prepare-stmt reference throws "The
// database connection is not open" and silently loses the audit row;
// the submission/membership row itself is durable but the audit chain
// gets a gap. Tracking the outstanding count lets the shutdown sit on
// _httpServer.close() → drain (up to 5 s) → db.close().
let _deferredAuditPending = 0;
function _deferAudit(fn) {
  _deferredAuditPending++;
  setImmediate(() => {
    try { fn(); } finally { _deferredAuditPending--; }
  });
}

// v6.16.9 — txn-aware audit-mirror buffering. Pre-fix
// `_mirrorAuditToLog` queued a setImmediate immediately on call, even
// when invoked from inside a `db.transaction(fn)()` body. If the txn
// later rolled back (FK violation, SQLITE_BUSY, disk full, any thrown
// statement), the `*_events` INSERT was rolled back atomically — but
// the queued setImmediate still fired, writing an `audit:...` line
// to app.jsonl referencing a row that no longer exists in the DB.
// Forensic readers grepping the log saw events that never actually
// happened.
//
// Fix: when `_activeMirrorBuffer` is non-null (set by
// `runTxnWithMirrorBuffer` while a wrapped txn body executes), push
// the call args onto the buffer instead of scheduling. After the txn
// returns successfully (no throw), the wrapper drains the buffer and
// fires each call through the normal setImmediate path. On txn rollback
// (throw), the wrapper drops the buffer — the rolled-back events leave
// no log trail.
//
// Critical txn sites use `runTxnWithMirrorBuffer(() => txn())` instead
// of bare `txn()`. Non-wrapped sites keep the legacy fire-immediate
// behaviour (which is fine for short txns whose audit row is the last
// statement — those can't roll back after the audit emit).
let _activeMirrorBuffer = null;  // null OR Array<[scope, scopeId, eventType, by, details]>

function runTxnWithMirrorBuffer(txnFn) {
  // v6.16.14 — defensive nested-call handling. If we're already
  // inside a wrapped txn (i.e. better-sqlite3 nested transactions
  // open SAVEPOINTs inside the outer transaction — whose BEGIN is
  // DEFERRED unless the outer one was called as `.immediate()`), inner
  // statements aren't durable until the OUTERMOST commit. Pre-fix
  // a nested call would drain its inner buffer immediately on inner
  // success — but if the OUTER then throws and the whole txn rolls
  // back, the inner-row inserts are also rolled back, leaving ghost
  // app.jsonl mirror lines. Now: if `_activeMirrorBuffer !== null`,
  // the outer wrapper is already collecting events; just delegate
  // to it (run the txnFn under the outer buffer). The outer wrapper
  // owns commit/rollback decisioning. No callsite nests today; this
  // is purely defensive against future refactors.
  if (_activeMirrorBuffer !== null) {
    return txnFn();
  }
  const buf = [];
  const prev = _activeMirrorBuffer;
  _activeMirrorBuffer = buf;
  let committed = false;
  let result;
  try {
    result = txnFn();
    committed = true;
  } finally {
    _activeMirrorBuffer = prev;
  }
  // Drain only on commit. On throw (rollback), drop the buffer silently
  // — no log line for an event the DB never saw.
  if (committed) {
    for (const [scope, scopeId, eventType, changedBy, details] of buf) {
      _scheduleMirrorAuditToLog(scope, scopeId, eventType, changedBy, details);
    }
  }
  return result;
}

function _mirrorAuditToLog(scope, scopeId, eventType, changedBy, details) {
  if (_activeMirrorBuffer !== null) {
    _activeMirrorBuffer.push([scope, scopeId, eventType, changedBy, details]);
    return;
  }
  _scheduleMirrorAuditToLog(scope, scopeId, eventType, changedBy, details);
}

// v6.16.19 — resolve a free-form `changed_by` value into a richer record
// when possible. The DB column is TEXT and can carry: a UUID (admin
// actor), a bare email (user self-action), or a sentinel string
// ("system" / "self" / "import" / "deny_reversal"). Sentinels and
// unrecognised values pass through unchanged so the JSONL "Actor"
// rendering stays meaningful. Returns either:
//   - the original string (sentinels, or no DB match)
//   - { id, email, first_name, last_name } (real user resolved)
//
// v6.16.21 — LRU cache. Pre-cache, every audit-mirror line did one
// indexed point-lookup against `users` inside its setImmediate. During
// a competition burst (~100 submits/s × ~3-5 audit events/submit) that's
// ~300-500 deferred SELECTs per second on the libuv pool. Even with
// better-sqlite3's ~10-50 μs indexed lookup, that's measurable CPU plus
// it inflates `_deferredAuditPending` (the gauge the v6.16.5 graceful-
// shutdown drain watchdog cares about). Cache hit-rate during a burst
// is near 100% because the same handful of users emit nearly all events.
// 60-s TTL keeps stale name displays bounded — a profile rename
// propagates to audit lines on the next minute boundary, which is fine
// for a forensic mirror.
const _ACTOR_CACHE_MAX = 1000;
const _ACTOR_CACHE_TTL_MS = 60_000;
const _actorCache = new Map(); // key (lowercase changedBy) → { actor, expires }

function _resolveActor(changedBy) {
  if (!changedBy || typeof changedBy !== "string") return changedBy;
  // Sentinel filter: shorter than a UUID and lacks "@" → keep as-is.
  // (The literal sentinels we emit today are all under 20 chars.)
  if (!changedBy.includes("@") && changedBy.length < 20) return changedBy;
  const cacheKey = changedBy.toLowerCase();
  const cached = _actorCache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && cached.expires > nowMs) {
    // LRU touch — re-insert at end so the eviction sweep below picks
    // genuinely-cold entries instead of the most recently used.
    _actorCache.delete(cacheKey);
    _actorCache.set(cacheKey, cached);
    return cached.actor;
  }
  let resolved = changedBy;
  try {
    let row = null;
    if (changedBy.includes("@")) {
      // Indexed (lib/account-lookup.js): a sign-in rush misses this cache once
      // per person, and the LOWER() form scanned every user on each miss.
      row = findUserByAddress(db, changedBy, "id, email, first_name, last_name");
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(changedBy)) {
      row = db.prepare(
        "SELECT id, email, first_name, last_name FROM users WHERE id=?"
      ).get(changedBy);
    }
    if (row) {
      resolved = {
        id: row.id,
        email: row.email,
        first_name: row.first_name || null,
        last_name: row.last_name || null,
      };
    }
  } catch (e) { /* fall through; cache the bare string */ swallowed("audit:actor-resolve", e); }
  // Cache both hits and misses. Misses are a smaller win but bounded —
  // an unresolvable string repeated 1000 times still does 1 DB hit, not
  // 1000. The TTL means a user that was missing at write time and is
  // later created will be picked up on the next minute boundary.
  if (_actorCache.size >= _ACTOR_CACHE_MAX) {
    // Map iteration order is insertion order — `keys().next().value`
    // is the coldest entry. With the LRU-touch above, this is correct
    // LRU eviction.
    const oldest = _actorCache.keys().next().value;
    if (oldest !== undefined) _actorCache.delete(oldest);
  }
  _actorCache.set(cacheKey, { actor: resolved, expires: nowMs + _ACTOR_CACHE_TTL_MS });
  return resolved;
}

function _scheduleMirrorAuditToLog(scope, scopeId, eventType, changedBy, details) {
  // Deferred to next tick (v6.8.0): enrichment queries and the JSONL write
  // previously ran synchronously inside the caller's transaction, so every
  // record*Event call paid for them there, on the one event loop and while
  // that transaction held the write lock. At ~100 submits/s during a
  // competition burst that was ~500 enrichment queries/s on the request
  // path. The audit row itself is already in *_events
  // before this runs; the mirror is best-effort forensic context.
  _deferredAuditPending++;
  setImmediate(() => {
    try {
      // Enrich the log line with human-readable names (v6.2.7).
      let enriched = details || null;
      if (scope === "timeslot" && scopeId) {
        try {
          const row = db.prepare(
            "SELECT t.name AS timeslot_name, c.id AS competition_id, c.name AS competition_name "
            + "FROM competition_timeslots t LEFT JOIN competitions c ON c.id = t.competition_id WHERE t.id = ?"
          ).get(scopeId);
          if (row) {
            enriched = {
              timeslot_name: row.timeslot_name,
              competition_id: row.competition_id,
              competition_name: row.competition_name,
              ...(details || {}),
            };
          }
        } catch (e) { /* fall through to unenriched log */ swallowed("audit:mirror-enrich-user", e); }
      } else if (scope === "competition" && scopeId) {
        try {
          const row = db.prepare("SELECT name FROM competitions WHERE id=?").get(scopeId);
          if (row) enriched = { competition_name: row.name, ...(details || {}) };
        } catch (e) { /* fall through */ swallowed("audit:mirror-enrich-competition", e); }
      } else if (scope === "task" && scopeId) {
        try {
          const row = db.prepare("SELECT title AS task_title, difficulty FROM tasks WHERE id=?").get(scopeId);
          if (row) enriched = { task_title: row.task_title, difficulty: row.difficulty, ...(details || {}) };
        } catch (e) { /* fall through */ swallowed("audit:mirror-enrich-task", e); }
      }
      // v6.16.19 — resolve actor identity for forensic context. The bare
      // changed_by stays in the DB column for back-compat; the JSONL line
      // gets the richer object so the admin Logs UI can render
      // "First Last (email)" instead of just an email. Sentinels (system,
      // self, import) pass through unchanged.
      const actor = _resolveActor(changedBy);
      // v6.16.23 — promote forensic top-level fields (ip / user_agent /
      // req_id / session_id) from `details` so the admin Logs UI's IP
      // column and any cross-stream grep query can read them at the
      // root of the JSONL line. Pre-fix, an `audit:user:login_success`
      // line carried the IP buried under details.ip — invisible to the
      // UI's column renderer (which reads r.ip), and inconsistent with
      // the access-log shape that already puts ip / req_id at the top.
      // Nested copy stays in `details` for back-compat with any reader
      // that already drills in.
      const top = {
        source: "audit",
        scope,
        scope_id: scopeId,
        event_type: eventType,
        changed_by: changedBy,
        actor,
        details: enriched,
      };
      if (enriched && typeof enriched === "object") {
        if (enriched.ip != null) top.ip = enriched.ip;
        if (enriched.user_agent != null) top.user_agent = enriched.user_agent;
        if (enriched.req_id != null) top.req_id = enriched.req_id;
        if (enriched.session_id != null) top.session_id = enriched.session_id;
        // v8.12.1 — promoted like the four above, matching the access log's
        // top-level `impersonated_by` (server.js `_requestActor`), so a grep
        // over either stream finds an impersonated request the same way.
        if (enriched.impersonated_by != null) top.impersonated_by = enriched.impersonated_by;
        if (enriched.acting_as != null) top.acting_as = enriched.acting_as;
      }
      log.info(top, `audit:${scope}:${eventType}`);
    } catch (e) { /* never let logging failure break anything */ swallowed("audit:mirror-write", e); }
    finally { _deferredAuditPending--; }
  });
}
// All four functions accept an optional 5th `opts` argument. Pass
// `{mirror: false}` when another record*Event call in the same logical action
// already mirrored the event — this avoids the per-scope fan-out producing
// 3 near-identical rows in app.jsonl for one user action (a submission fires
// user+competition+timeslot; the user-scope mirror is forensically complete
// because the details object already includes competition_id/task_id/timeslot_id).
// DB inserts into the per-scope *_events tables still happen unconditionally —
// those back the admin per-entity history dialogs.
function recordCompetitionEvent(competitionId, eventType, changedBy, details, opts) {
  const [id, ts] = _eventRow();
  db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
    .run(id, competitionId, eventType, changedBy, ts, details ? JSON.stringify(details) : null);
  // v6.10.50 — centralised invalidation for the competition-events
  // response cache. Every competition_events INSERT in the codebase
  // funnels through this function, so a single call here covers every
  // writer site (compare with the admin_participants cache which had
  // to thread invalidation through 14 separate routes). Keep this
  // hook here whenever new event types are added.
  invalidateAdminCompEventsCache(competitionId);
  if (!opts || opts.mirror !== false) _mirrorAuditToLog("competition", competitionId, eventType, changedBy, details);
}
function recordTimeslotEvent(timeslotId, eventType, changedBy, details, opts) {
  const [id, ts] = _eventRow();
  db.prepare("INSERT INTO timeslot_events (id, timeslot_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
    .run(id, timeslotId, eventType, changedBy, ts, details ? JSON.stringify(details) : null);
  if (!opts || opts.mirror !== false) _mirrorAuditToLog("timeslot", timeslotId, eventType, changedBy, details);
}
function recordUserEvent(userId, eventType, changedBy, details, opts) {
  const [id, ts] = _eventRow();
  db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
    .run(id, userId, eventType, changedBy, ts, details ? JSON.stringify(details) : null);
  if (!opts || opts.mirror !== false) _mirrorAuditToLog("user", userId, eventType, changedBy, details);
}
function recordSettingsEvent(settingKey, eventType, changedBy, details, opts) {
  const [id, ts] = _eventRow();
  db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
    .run(id, settingKey, eventType, changedBy, ts, details ? JSON.stringify(details) : null);
  if (!opts || opts.mirror !== false) _mirrorAuditToLog("settings", settingKey, eventType, changedBy, details);
}
// Entity-deletion audit: when the row being described is about to be deleted
// (or is its own event-table), we can't write a sibling event row — the
// cascade would wipe it, or there's no place to put it. This helper emits
// ONLY to app.jsonl with the same source:"audit" shape as the four record*
// functions above, so forensic tooling that filters `source=="audit"` sees
// deletions alongside every other audit row.
// The DB copy (orphan_events) is what the Audit page lists; app.jsonl stays the
// forensic mirror it always was. The INSERT is NON-FATAL, unlike the four
// record*Event writers above: an orphaned emit sits after a delete or beside an
// export, and a failure to keep the DB copy must not undo the act it describes.
// Inside a caller's transaction it rolls back with it, as the mirror line does.
// competition_id / timeslot_id are lifted from `details` (or from the scope id
// itself for a competition / timeslot scope) so the page can apply an event
// admin's scope in SQL.
function _orphanCompetitionId(scope, scopeId, details) {
  const v = details && typeof details === "object" ? details.competition_id : null;
  if (typeof v === "string" && v) return v;
  return scope === "competition" && typeof scopeId === "string" && scopeId ? scopeId : null;
}
function _orphanTimeslotId(scope, scopeId, details) {
  const v = details && typeof details === "object" ? details.timeslot_id : null;
  if (typeof v === "string" && v) return v;
  return scope === "timeslot" && typeof scopeId === "string" && scopeId ? scopeId : null;
}
function recordOrphanedAuditEvent(scope, scopeId, eventType, changedBy, details) {
  try {
    const [id, ts] = _eventRow();
    db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, String(scope), scopeId == null ? null : String(scopeId), String(eventType),
        changedBy == null ? null : String(changedBy), ts,
        _orphanCompetitionId(scope, scopeId, details), _orphanTimeslotId(scope, scopeId, details),
        details ? JSON.stringify(_redactValue(details)) : null);
  } catch (e) { swallowed("audit:orphan-event-insert", e); }
  _mirrorAuditToLog(scope, scopeId, eventType, changedBy, details);
}

// Per-challenge participant event: solved / incorrect / hint_revealed / navigated_away.
// Intentionally separate from the admin-audit *_events tables — these rows are
// participant-generated analytics signal, not admin state changes, so they don't
// flow through _mirrorAuditToLog.
// v7.14.0 — `impersonated` (truthy → 1) marks rows produced by an admin
// impersonating the participant; analytics excludes them (WHERE impersonated=0).
// Writers pass the flag captured from req.session at CALL/QUEUE time — the
// submit path executes this on a deferred tick, so the value must ride the
// bound args, never be re-read from a session that may have ended meanwhile.
function recordChallengeEvent(userId, taskId, competitionId, timeslotId, eventType, details, impersonated) {
  db.prepare(
    "INSERT INTO challenge_events (id, user_id, task_id, competition_id, timeslot_id, event_type, details, occurred_at, impersonated) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(
    uuid(), userId, taskId, competitionId, timeslotId || null, eventType,
    details ? JSON.stringify(details) : null, now().toISOString(), impersonated ? 1 : 0
  );
}

// Request context for login/registration event attribution (IP + User-Agent).
// IP/UA are PII — retention policy should be defined per compliance needs.
// v6.16.19 — also captures req_id (the per-request UUID emitted by the
// access-log middleware) so an audit-mirror line can be correlated to the
// HTTP request that produced it. session_id ties together multiple events
// inside a single login session for forensic timeline reconstruction.
// v8.12.1 — THE IMPERSONATION LINK RIDES EVERY EMIT. `reqContext` is the one
// spread every request-driven emit carries (the v7.21.32 and v8.8.9 scanners
// hold that), so one edit here reaches the ~100 admin emits the event-admin
// view makes reachable under impersonation — where the participant surface had
// to be retrofitted by hand twice (v7.15.2, v8.1.0). CONDITIONAL, never a null
// key: the History dialog's `created`/`updated` branches render every details
// key raw, so an unconditional `impersonated_by: null` would print a muted
// empty line on every competition-created row for every admin. The thirteen
// participant-surface sites that already spread `impersonated_by` explicitly
// now carry it twice with the same value, which object spread collapses.
// `acting_as` names the SEAT — on a competition- or task-scoped row the target
// is not the row's subject, so `impersonated_by` alone (which under
// `getAdminIdentity` equals `changed_by`) could not say whose panel the act was
// made from. The access log has carried `impersonated_by` at top level since
// v7.14.0 (`_requestActor`, server.js); the mirror below promotes it the same
// way so the two streams agree on where the field sits.
function reqContext(req) {
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 300);
  const s = req.session;
  return {
    ip: req.ip || null,
    user_agent: ua || null,
    req_id: req?.id || null,
    session_id: req?.sessionID || null,
    // v8.12.1 — `impersonated_by` is resolved the way `changed_by` is
    // (`getAdminIdentity`: live, by the marker's id, the snapshot as fallback),
    // so the two fields on one row can never name the same person two ways —
    // the first draft read the frozen snapshot here and the live row there, and
    // the History dialog's "(impersonated by …)" branch keys on the two
    // DIFFERING (found by the pre-release review).
    ...(s && s.impersonator
      ? { impersonated_by: getAdminIdentity(req), acting_as: s.userEmail || s.userId || null }
      : {}),
  };
}

function deferredAuditPending() { return _deferredAuditPending; }

// ── Row-stable event-history pagination ──────────────────────────────────────
// Shared by every audit-event list endpoint (competition/timeslot/participant/
// settings events). Pagination is drift-free: a (changed_at, rowid) snapshot
// anchor is derived on the first page and echoed by the client so
// same-millisecond inserts can't shift OFFSET positions.
// (v8.13.3 correction — this used to say the submissions and logs lists share
// it too. They never did: each parses its own offset in server.js. What all six
// list routes share is lib/util's clampPagingIndex.)
// v8.13.3 — A CAPABILITY IS RECORDED BY ITS FINGERPRINT, NEVER BY ITSELF. An audit
// row is read back by every organiser the History route admits and mirrored into
// app.jsonl, which any regular admin reads through Logs; a live bearer value there
// is handed to all of them. `prefix` + 12 hex of sha256 still lets two rows (or a
// row and a database lookup) be correlated, and cannot be replayed. The shape is
// routes/badge.js's credential-code fingerprint (`cf_`), one prefix per capability:
// `if_` is an invitation id.
function capabilityFingerprint(value, prefix) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}
// (`tm_`, an event team member's address, is lib/team-recipient.js
// `teamMemberFingerprint`: this shape, defined there so that db.js can name a
// removed member's report ledger rows the way the mail's own record does.)
// v8.13.3 — and rows written BEFORE that are masked on the way out. Until this
// release `invitation_competition_added` stored the LIVE invitation id — a bearer
// capability (GET /api/invitations/:id answers for it, and redeeming it creates a
// verified account at the invitee's address, enrolled in every invited event) —
// and the History route returns it to an event admin of ANY one of those events.
// Masking at read time covers every historical row still held (the table is
// retention-bounded — lib/event-retention.js purges it after EVENT_RETENTION_DAYS)
// with no rewrite and nothing to re-run at boot. Only a STRING value
// is a capability; anything else is left as written. THIS COVERS THE HISTORY READ
// ONLY: app-*.jsonl lines written before v8.13.3 (this event's mirror line, and
// the operational log lines that named an invitation) keep the raw id until
// scripts/purge.sh rotates them out. Accepted, not masked at read: Logs is
// forbidden to event admins (lib/event-admin.js), so the only readers are global
// admins and superadmins, a tier that can already create an account at any
// address through the desk shortcut.
function _maskEventDetails(d) {
  if (!d || typeof d !== "object" || typeof d.invitation_id !== "string") return d;
  const { invitation_id, ...rest } = d;
  return { ...rest, invitation_fp: capabilityFingerprint(invitation_id, "if_") };
}
// THE ONE READER OF A STORED `details` TEXT (an audit row's JSON) for every
// surface that shows one: the History lists (`_parseEventRows`), the Audit page
// (routes/audit.js), the person export (lib/full-export.js) and a challenge's
// version history (routes/challenges.js). No details (NULL or "") reads as null.
// Text that is not JSON (a hand edit, a write cut short) reads as
// `{ details_unreadable: true }`: parsed unguarded, one such row answered 500
// for every page of every list holding it. The row keeps its type, time and
// actor, so a list counts and pages it like any other, and its stored text is
// never shown, since it may hold what a read projection strips (an older
// revocation's certificate token).
function parseStoredDetails(text) {
  if (text == null || text === "") return null;
  try { return JSON.parse(text); }
  catch (e) { swallowed("audit:details-parse", e); return { details_unreadable: true }; }
}
function _parseEventRows(rows) {
  return rows.map(r => ({ ...r, details: _maskEventDetails(parseStoredDetails(r.details)) }));
}
function _paginationParams(req) {
  const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : null;
  // v8.13.3 — clampPagingIndex bounds the offset ABOVE as well as below. The old
  // `Number.isFinite` guard let a value past int64 (a 20-digit
  // `?offset=100000000000000000000`) through to `LIMIT ? OFFSET ?` (SQLITE_MISMATCH
  // → a generic 500 on all four history routes, even for an unknown entity, since
  // the list query always runs) and read a ~309-digit Infinity as page ONE; both
  // are now the empty past-the-end page. (`?offset=1e20` was never one of them:
  // parseInt stops at the "e" and reads it as 1.)
  const offset = clampPagingIndex(req.query.offset);
  // DEFAULT 500, explicit-opt-in CAP 5000. The snapshot_before token makes
  // multi-page walks drift-free, so single-fetch isn't needed; 500/page keeps
  // the first-page payload ~250 KB on the admin history polls.
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 500;
  // `snapshot_before` is a drift-free-pagination token: first page returns the
  // current MAX(changed_at); the client echoes it on subsequent pages so events
  // inserted during the walk never appear and OFFSET positions stay stable.
  // changed_at (ISO-8601) sorts lexically in insertion order, so `<= ?` is
  // meaningful (the id column is a non-monotonic UUID).
  //
  // v8.13.3 — AN ANCHOR THAT IS NOT A TIMESTAMP IS NO ANCHOR. The value is echoed
  // from `MAX(changed_at)`, always an ISO string, but it was taken verbatim. Until
  // this release the competition-history cache key spelled an absent anchor as `_`
  // (routes/events.js, `:s${snapshotBefore ?? "_"}:t${snapshotTie ?? "_"}`), so
  // `?snapshot_before=_&snapshot_tie=_` landed on the SPA's own anchorless
  // first-page key — across actors, the key carrying none — and cached a body that
  // ECHOED `_` back: for the TTL every admin opening that History was handed `_`
  // as their anchor, and `changed_at <= '_'` admits every ISO row, so the drift
  // protection was silently off. The key is JSON-encoded now, so no anchor value
  // can collide with another key; this rule is what remains necessary on its own:
  // a string Date.parse rejects is read as absent (the anchor is re-derived and
  // echoed honestly, and never reaches the `changed_at <= ?` filter), and so is
  // its tie, which means nothing without one.
  const snapshotBeforeRaw = typeof req.query.snapshot_before === "string"
    ? req.query.snapshot_before.trim() : "";
  const snapshotBefore = snapshotBeforeRaw && Number.isFinite(Date.parse(snapshotBeforeRaw))
    ? snapshotBeforeRaw : null;
  // v6.13.9 — row-stable tie-key: a bare `changed_at <= snapshot` admits
  // same-ms inserts and can shift OFFSET; pinning (changed_at, id) as the
  // anchor pair makes pagination stable even under bursty same-ms writes.
  const snapshotTieRaw = typeof req.query.snapshot_tie === "string"
    ? req.query.snapshot_tie.trim() : "";
  const snapshotTie = (snapshotBefore && snapshotTieRaw) || null;
  // Presence semantics unchanged: `?offset=` (empty) still opts into the paginated
  // envelope, exactly as the old `offsetRaw !== null` did.
  const paginated = req.query.offset !== undefined || limitRaw !== null;
  return { offset, limit, paginated, snapshotBefore, snapshotTie };
}

// Inject "AND changed_at <= ?" (or "WHERE changed_at <= ?" when the base SQL
// has no WHERE) into the count + list SQLs. With a snapshot_tie, emits the
// `(changed_at < ? OR (changed_at = ? AND rowid <= ?))` form. When snapshotBefore
// is null, passes through unchanged.
// audit v7.7.36 (C5) — the tie is the row's ROWID (insertion-ordered, monotonic),
// NOT the random-UUID `id`. Pre-fix, a new same-millisecond insert got a random
// UUID and ~half sorted `<= tie`, so it slipped INTO the snapshot mid-walk — the
// exact OFFSET drift (duplicate last row / total mismatch) the tie is meant to
// prevent. rowid always increases per insert, so a post-anchor row is never
// admitted. snapshotTie arrives as a numeric string (from the response echo);
// parse to an int for the integer comparison — a legacy/non-numeric tie (an
// in-flight UUID from before this change) falls back to a strict changed_at<snap
// rather than a NaN bind that would match nothing.
function _applySnapshotFilter(countSql, listSql, params, snapshotBefore, snapshotTie = null) {
  if (!snapshotBefore) return { countSql, listSql, params };
  const hasWhere = /\sWHERE\s/i.test(countSql);
  const keyword  = hasWhere ? " AND " : " WHERE ";
  let fragment, extraParams;
  const tieNum = snapshotTie != null ? Number(snapshotTie) : null;
  if (tieNum != null && Number.isFinite(tieNum)) {
    fragment    = `${keyword}(changed_at < ? OR (changed_at = ? AND rowid <= ?))`;
    extraParams = [snapshotBefore, snapshotBefore, tieNum];
  } else if (snapshotTie != null) {
    fragment    = `${keyword}changed_at < ?`;   // legacy/non-numeric tie — strict, excludes the anchor ms
    extraParams = [snapshotBefore];
  } else {
    fragment    = `${keyword}changed_at <= ?`;
    extraParams = [snapshotBefore];
  }
  const snapCountSql = countSql + fragment;
  // listSql always has ORDER BY (pagination requires deterministic order);
  // inject before it so the filter lands inside the WHERE scope.
  const snapListSql = listSql.replace(/\s+ORDER\s+BY/i, `${fragment} ORDER BY`);
  return { countSql: snapCountSql, listSql: snapListSql, params: [...params, ...extraParams] };
}

function _eventListResponse(countSql, listSql, maxSql, params, paginated, offset, limit, snapshotBefore = null, snapshotTie = null) {
  // On the first page (no snapshot echo yet) derive the anchor FIRST via a
  // dedicated MAX(changed_at)+top-id query, then apply that snapshot filter to
  // BOTH the count and the list so `total` and the page share one scope.
  let effectiveSnapshot = snapshotBefore;
  let effectiveTie      = snapshotTie;
  if (!effectiveSnapshot) {
    const maxRow = db.prepare(maxSql).get(...params);
    effectiveSnapshot = (maxRow && maxRow.m) ? maxRow.m : null;
    // audit v7.7.36 (C5) — tie is now the integer rowid; stringify for the
    // response (client contract: snapshot_tie is an opaque string it echoes back).
    effectiveTie      = (maxRow && maxRow.tie != null) ? String(maxRow.tie) : null;
  }
  const filtered = _applySnapshotFilter(countSql, listSql, params, effectiveSnapshot, effectiveTie);
  const total = db.prepare(filtered.countSql).get(...filtered.params).c;
  const rows = db.prepare(filtered.listSql).all(...filtered.params, limit, offset);
  const events = _parseEventRows(rows);
  return paginated
    ? { events, total, offset, limit, snapshot_before: effectiveSnapshot, snapshot_tie: effectiveTie }
    : events;
}

module.exports = {
  getAdminIdentity, createTaskVersion, recordTaskAuditEvent, recordSealedReveal, sealRevealHistoryDetails,
  recordCompetitionEvent, recordTimeslotEvent, recordUserEvent, recordSettingsEvent,
  recordOrphanedAuditEvent, recordChallengeEvent,
  runTxnWithMirrorBuffer, _deferAudit, reqContext, _resolveActor,
  deferredAuditPending,
  _adminCompEventsCache, _ADMIN_COMP_EVENTS_TTL_MS, _adminCompEventsCacheKey, _adminCompEventsCacheSet, invalidateAdminCompEventsCache,
  _paginationParams, _eventListResponse, parseStoredDetails,
  capabilityFingerprint,
};
