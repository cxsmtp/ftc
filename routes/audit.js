"use strict";

// THE AUDIT PAGE — GET /api/admin/audit.
//
// One newest-first stream over every recorded act the platform keeps in its
// database, each row tagged with the TYPE of record it came from:
//
//   event              competition_events
//   session            timeslot_events
//   person             user_events
//   setting            settings_events   (global admins only)
//   challenge_version  task_versions     (metadata only, never the snapshot)
//   submission         submissions       (answer through the seal projection)
//   hint               hint_reveals
//   log_event          orphan_events     (the DB copy of orphaned audit events)
//
// challenge_events stays analytics-only (CLAUDE.md *Audit trail*) and is not a
// source. Orphaned events written before orphan_events existed live only in
// app.jsonl; a global admin reads them through the Raw logs view (the Logs pane).
//
// HOW IT PAGES. Each source is read off its own timestamp index, newest first,
// capped at offset + limit + 1, with the position pushed into its WHERE; the
// branches are merged in JS on (at DESC, source DESC, rowid DESC) and the page is
// cut at [offset, offset + limit). The union of each branch's top N holds the
// global top N, so the merge is exact. The SPA pages it like Raw logs (numbered
// pages): the first page answers `anchor`, its newest row, and a jump is that
// anchor (the rows at or below it) plus `offset`; Next and Prev pass `cursor`
// (the rows strictly below a page's last row, or below the floor of a walk the
// budget cut, so Next searches on past it). Either way a row inserted meanwhile
// lands above the position and never shifts a page. `offset` stops at
// AUDIT_OFFSET_MAX. Positions are opaque base64url of [at, source, rowid].
//
// WHICH KINDS OF RECORD (operator ruling, 14 Nov 2026): `audit.view` opens the
// page, and each kind of row is listed only to a reader holding the permission
// that guards the same rows elsewhere (SOURCE_PERMISSIONS below): events and
// sessions `events.view` (their History), people `participants.view` (a
// person's History), settings `settings.view` (the settings history),
// challenge versions `challenges.view`, submissions and hints `audit.view` (the
// Submissions view); a logged event naming an event follows `events.view`, one
// naming none `audit.raw_logs` (the Raw logs view reads the same lines). Naming
// a kind the reader may not see is 403 `audit_type_forbidden`; the answer's
// `readable_types` lists the kinds this reader may see, for the page's chips.
//
// WHO SEES WHAT within a kind (event admins; global admins see every row):
//   event / submission / hint / log_event — competition_id in scope
//     (scopeFilterSql: [] grants is `1=0`, and a NULL competition_id never
//     matches, so an orphaned event naming no event is withheld);
//   session — the session's event in scope (a deleted session's rows withheld);
//   person — the participant shares an event with the actor, is a participant
//     (participantDenied's privileged-target rule), and the row passes
//     userEventCompetitionScopeSql — the History dialog's own clause;
//   challenge_version — the three-way challenge visibility rule
//     (taskVisibilitySql);
//   setting — never (platform settings are not theirs; naming the type is 403).
// A named competitionId / timeslotId is checked for scope BEFORE existence.
//
// WHAT IS NEVER SHOWN. details pass through lib/log.js _REDACT_KEYS (and any
// `?code=` / `?token=` in a string); task_versions give version, change type and
// author only; a submitted answer is withheld per row by the sealed-answer rule
// (lib/answer-seal.js submissionAnswerProjection), and `q` matches the same
// redacted value. `q` never searches raw `details`: a LIKE over the stored JSON
// would confirm a redacted value (a `secondary_email` field, a join code) by its
// count. Redaction is by key: an account mail's `to` lists every address it went
// to, the secondary included.
//
// COUNTS. Only on the FIRST page (no cursor or anchor, offset 0: the pager reads
// the total there and never after); any other read answers `total: null,
// total_exact: false`. A count stops at AUDIT_COUNT_MAX matches: past it `total`
// is that floor and `total_exact` is false ("10000+"), so no filter, or a broad
// one (an outcome, a date range over two years), walks every table to the end on
// the one thread. Last and Go to page need an exact count.
//
// THE WALK BUDGET. A filter no index serves (free text, an outcome, an
// activity, an event or session held in a row's JSON, an organiser's scope over
// people) walks a source in time order until the page fills, however few rows
// match: on a platform with years of records, the whole table, twice with the
// count. Such a walk examines at most the newest AUDIT_SCAN_BUDGET rows of the
// source below the cursor (inside any From / To range). The read answers what
// it found above the oldest row it examined, says how far back it searched
// (`searched_to`), and Next goes on from there (a `cursor` at that floor); the count covers the rows
// searched and is a floor. A walk another index leads (a person, an event's own
// column, an actor) examines only the rows that index selects, so it is never
// cut: the planner says which (_walksByTime).
//
// COST. Every read runs synchronously on the process that also serves live
// events, so the route has its own limiter (after the identity guard, as every
// admin limiter) beside the 5 s response cache and the walk budget.

const db = require("../db");
const { requireAdmin, rateLimit } = require("../lib/middleware");
const { getCompetition, getTimeslot } = require("../lib/competitions");
const {
  actorId, actingAdminId, scopedCompetitionIds, scopeFilterSql, competitionDenied,
  participantVisibilityScope, userEventCompetitionScopeSql, userEventDetailsSql, taskVisibilitySql,
} = require("../lib/event-admin");
const { submissionAnswerProjection } = require("../lib/answer-seal");
const { actorPermissions, PERMISSIONS } = require("../lib/rbac");
const { _REDACT_KEYS } = require("../lib/log");
const { swallowed } = require("../lib/best-effort");
const { walksByTime } = require("../lib/query-plan");
const { parseStoredDetails } = require("../lib/audit");

const AUDIT_TYPES = Object.freeze(["event", "session", "person", "setting", "challenge_version", "submission", "hint", "log_event"]);
const AUDIT_OUTCOMES = Object.freeze(["success", "failure", "unknown", "correct", "wrong"]);
const AUDIT_LIMIT_DEFAULT = 50;
const AUDIT_LIMIT_MAX = 500;
const AUDIT_OFFSET_MAX = 10000;     // the deepest `offset` a read pages to
const AUDIT_Q_MAX = 200;
const AUDIT_LIST_MAX = 50;          // entries in one comma-separated list filter
const AUDIT_TOKEN_MAX = 120;        // characters in one list entry / id filter
const AUDIT_CACHE_TTL_MS = 5000;
const AUDIT_CACHE_MAX = 256;
const AUDIT_COUNT_MAX = 10000;      // matches one read counts; past it the total is a floor
const AUDIT_SCAN_BUDGET = 20000;    // rows a time-ordered walk examines per source per read
const REDACT_DEPTH_MAX = 8;
// 60 reads a minute per address: the Logs route's budget (GET /api/admin/logs).
const auditLimiter = rateLimit(60_000, 60, "adminaudit");

// ── details redaction ─────────────────────────────────────────────────────────
const _SECRET_IN_STRING_RE = /([?&](?:code|token)=)[^&"\s]+/gi;
function _redact(v, depth) {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.replace(_SECRET_IN_STRING_RE, "$1[REDACTED]");
  if (typeof v !== "object") return v;
  if (depth > REDACT_DEPTH_MAX) return "[TRUNCATED]";
  if (Array.isArray(v)) return v.map(x => _redact(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = _REDACT_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : _redact(v[k], depth + 1);
  }
  return out;
}
// Read through the one parser (lib/audit.js parseStoredDetails): text that is
// not JSON is `{ details_unreadable: true }`, never "no details recorded".
function _parseDetails(text) {
  return _redact(parseStoredDetails(text), 0);
}

// ── SQL helpers ───────────────────────────────────────────────────────────────
// json_extract on a malformed blob raises and would fail the whole read, so
// every extraction is guarded by json_valid.
const JX = (col, path) => `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END)`;
// An audit row's outcome: 'failure' for a refused / failed / denied act,
// 'unknown' when its details cannot be read (below), else 'success'. Writers
// say "failed" in five ways, and each is read: the type's own words (incl.
// `email_change_conflict`, a refused address change, and
// `cxone_realm_withdrawal_given_up`), an explicit `success: false`
// (`email_sent`, `cxone_provisioned`), `ok: false` (`test_email_sent`),
// `status: "failed"` (`certificate_emailed`), and a count of messages that
// failed or were refused (`team_report_sent`: any one of its messages that did
// not go out makes the report a failure; its details give the counts).
// Details present but not JSON (lib/audit.js parseStoredDetails'
// `details_unreadable`) are 'unknown': whether that act succeeded cannot be
// told. The type's own words come first, so a refusal stays a 'failure' whatever
// its details hold; NULL or empty details are no details, not unreadable ones.
// json_valid agrees with JSON.parse (parseStoredDetails) on every stored text
// except JSON nested over 1000 levels deep, which no writer stores.
const OUT = (et, details) =>
  `(CASE WHEN ${et} LIKE '%fail%' OR ${et} LIKE '%refus%' OR ${et} LIKE '%denied%' OR ${et} LIKE '%reject%' OR ${et} LIKE '%error%'`
  + ` OR ${et} LIKE '%conflict%' OR ${et} LIKE '%given_up%' THEN 'failure'`
  + ` WHEN ${details} IS NOT NULL AND ${details} <> '' AND NOT json_valid(${details}) THEN 'unknown'`
  + ` WHEN ${JX(details, "$.success")} = 0 OR ${JX(details, "$.ok")} = 0 OR ${JX(details, "$.status")} = 'failed'`
  + ` OR CAST(${JX(details, "$.failed")} AS REAL) > 0 OR CAST(${JX(details, "$.refused")} AS REAL) > 0 THEN 'failure' ELSE 'success' END)`;

// ── which kinds of record this reader may see (see the header) ───────────────
// The permission that guards each kind of row where it otherwise lives. A
// logged event (`log_event`) is split by whether it names an event: see its
// `scope` below.
const SOURCE_PERMISSIONS = Object.freeze({
  event: "events.view",                 // GET /api/admin/competitions/:id/events
  session: "events.view",               // GET …/timeslots/:tsId/events
  person: "participants.view",          // GET /api/admin/participants/:id/events
  setting: "settings.view",             // GET /api/admin/settings/events
  challenge_version: "challenges.view", // GET /api/admin/tasks/:id/versions
  submission: "audit.view",             // GET /api/admin/submissions
  hint: "audit.view",                   // its hint rows
  log_event: "events.view",             // a logged event naming an event; one naming none needs RAW_LOGS_PERMISSION
});
const RAW_LOGS_PERMISSION = "audit.raw_logs";
// WHAT A READER WITHOUT THE RAW LOGS SEES OF A LOGGED EVENT (sweep #104). A logged
// event naming an event reaches whoever may view that event (its organisers,
// event admins and scoped roles included), and its details hold what its writer
// recorded, some of it about people who are neither members nor organisers of
// the event. The same lines are in the raw logs, which take RAW_LOGS_PERMISSION,
// so for a reader without it:
//   * every logged event's request context (reqContext's `ip`, `user_agent`,
//     `req_id`, `session_id`) is withheld, and the row names what was withheld
//     (`withheld_fields`): a public visitor checking a certificate
//     (`credential_verified`), a newcomer asking for a sign-up code through the
//     event's join link (`email_proof_requested`, `email_proof_event_dropped`);
//   * the fields LOG_EVENT_RAW_ONLY_FIELDS names for its type are withheld too;
//   * a type in LOG_EVENT_RAW_ONLY_TYPES is not listed at all, in SQL, so the
//     counts, the paging and the subject filter agree.
// Read time, not write time: the rows already stored are covered, and the raw
// logs keep everything for whoever may read them.
const LOG_EVENT_REQUEST_CONTEXT = Object.freeze(["ip", "user_agent", "req_id", "session_id"]);
const LOG_EVENT_RAW_ONLY_FIELDS = Object.freeze({
  // A participant deleted mid-set-up: the Checkmarx One account id of a person
  // whose account is gone, for the superadmin's removal (Settings), not an organiser.
  cxone_provision_abandoned: Object.freeze(["cxone_user_id"]),
  // A mail to a recipient deleted before it went out carries the erased address.
  email_sent: Object.freeze(["to"]),
});
const LOG_EVENT_RAW_ONLY_TYPES = Object.freeze([
  // Its subject is the blocked address, and the event it names is only whichever
  // happened to be live when it was raised: address blocks are the platform's.
  "ip_ban_alert_raised",
]);
/** A logged event's details as a reader without the raw logs sees them. */
function _logEventDetailsForReader(eventType, details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return details;
  const drop = [...LOG_EVENT_REQUEST_CONTEXT, ...(LOG_EVENT_RAW_ONLY_FIELDS[eventType] || [])]
    .filter(k => Object.prototype.hasOwnProperty.call(details, k));
  if (!drop.length) return details;
  const out = {};
  for (const k of Object.keys(details)) if (!drop.includes(k)) out[k] = details[k];
  out.withheld_fields = drop;
  return out;
}
// The reader's permission set, read once per request (the role definition is
// cached 2 s, like every other permission read).
const _readerPerms = new WeakMap();
function _can(req, perm) {
  let perms = _readerPerms.get(req);
  if (!perms) { perms = actorPermissions(req).perms; _readerPerms.set(req, perms); }
  return perms.has(perm);
}
const _permLabel = (perm) => (PERMISSIONS.find(p => p.id === perm) || { label: perm }).label;

// Every source names the expressions the generic builder needs. `scope(req)`
// returns { clause, params } or null when the source is closed to this actor;
// a filter key that is null means the source can never match that filter, so a
// request naming it skips the source. `base` is the source's own table under
// the alias `at` and `rid` use (`alias`), which the walk budget reads alone.
const SOURCES = {
  event: {
    from: "competition_events e LEFT JOIN competitions c ON c.id = e.competition_id", base: "competition_events e", alias: "e",
    at: "e.changed_at", rid: "e.rowid", et: "e.event_type", actor: "e.changed_by", actorIndexed: true,
    kind: "'competition'", subjectId: "e.competition_id", label: "c.name",
    comp: "e.competition_id", compName: "c.name", ts: JX("e.details", "$.timeslot_id"),
    outcome: OUT("e.event_type", "e.details"), details: "e.details", extra: "",
    scope: (req) => (_can(req, SOURCE_PERMISSIONS.event) ? scopeFilterSql(req, "e.competition_id") : null),
    compFilter: "e.competition_id = ?", tsFilter: `${JX("e.details", "$.timeslot_id")} = ?`,
    subjectFilter: "e.competition_id = ?", subjectParams: 1, qExtra: [],
  },
  session: {
    from: "timeslot_events te LEFT JOIN competition_timeslots t ON t.id = te.timeslot_id LEFT JOIN competitions c ON c.id = t.competition_id", base: "timeslot_events te", alias: "te",
    at: "te.changed_at", rid: "te.rowid", et: "te.event_type", actor: "te.changed_by", actorIndexed: true,
    kind: "'session'", subjectId: "te.timeslot_id", label: "t.name",
    comp: "t.competition_id", compName: "c.name", ts: "te.timeslot_id",
    outcome: OUT("te.event_type", "te.details"), details: "te.details", extra: "",
    scope: (req) => (_can(req, SOURCE_PERMISSIONS.session) ? scopeFilterSql(req, "t.competition_id") : null),
    compFilter: "t.competition_id = ?", tsFilter: "te.timeslot_id = ?",
    subjectFilter: "te.timeslot_id = ?", subjectParams: 1, qExtra: ["c.name"],
  },
  person: {
    // userEventCompetitionScopeSql correlates on the bare table name, so
    // user_events is NOT aliased here.
    from: `user_events LEFT JOIN users u ON u.id = user_events.user_id LEFT JOIN competitions c ON c.id = ${JX("user_events.details", "$.competition_id")}`, base: "user_events", alias: "user_events",
    at: "user_events.changed_at", rid: "user_events.rowid", et: "user_events.event_type", actor: "user_events.changed_by", actorIndexed: true,
    kind: "'user'", subjectId: "user_events.user_id", label: "COALESCE(u.nickname, u.email)",
    comp: JX("user_events.details", "$.competition_id"), compName: "c.name", ts: JX("user_events.details", "$.timeslot_id"),
    outcome: OUT("user_events.event_type", "user_events.details"), details: "user_events.details", extra: "",
    detailsFor: (req) => userEventDetailsSql(req), // a scoped reader: an older email row without its subject
    scope: (req) => {
      if (!_can(req, SOURCE_PERMISSIONS.person)) return null;
      if (scopedCompetitionIds(req) === null) return { clause: "", params: [] };
      const vis = participantVisibilityScope(req, "u");
      const hist = userEventCompetitionScopeSql(req);
      return { clause: " AND u.role = 'participant'" + vis.clause + hist.clause, params: [...vis.params, ...hist.params] };
    },
    compFilter: `${JX("user_events.details", "$.competition_id")} = ?`, tsFilter: `${JX("user_events.details", "$.timeslot_id")} = ?`,
    subjectFilter: "user_events.user_id = ?", subjectParams: 1, qExtra: ["c.name"],
  },
  setting: {
    from: "settings_events s", base: "settings_events s", alias: "s",
    at: "s.changed_at", rid: "s.rowid", et: "s.event_type", actor: "s.changed_by", actorIndexed: true,
    kind: "'setting'", subjectId: "s.setting_key", label: "s.setting_key",
    comp: "NULL", compName: "NULL", ts: "NULL",
    outcome: OUT("s.event_type", "s.details"), details: "s.details", extra: "",
    scope: (req) => (scopedCompetitionIds(req) === null && _can(req, SOURCE_PERMISSIONS.setting) ? { clause: "", params: [] } : null),
    compFilter: null, tsFilter: null,
    subjectFilter: "s.setting_key = ?", subjectParams: 1, qExtra: [],
  },
  challenge_version: {
    from: "task_versions v JOIN tasks t ON t.id = v.task_id", base: "task_versions v", alias: "v",
    at: "v.changed_at", rid: "v.rowid", et: "v.change_type", actor: "v.changed_by", actorIndexed: true,
    kind: "'challenge'", subjectId: "v.task_id", label: "t.title",
    comp: "NULL", compName: "NULL", ts: "NULL",
    outcome: "'success'", details: "NULL", extra: ", v.version_num AS _version_num",
    scope: (req) => (_can(req, SOURCE_PERMISSIONS.challenge_version) ? taskVisibilitySql(req, "t") : null),
    // An IN list rather than a correlated EXISTS: the planner then reaches the
    // versions through the event's own challenges instead of walking every
    // version newest first (the walk budget would otherwise cut it).
    compFilter: "v.task_id IN (SELECT _act.task_id FROM competition_tasks _act WHERE _act.competition_id = ?)", tsFilter: null,
    subjectFilter: "v.task_id = ?", subjectParams: 1, qExtra: [],
  },
  submission: {
    from: "submissions sb LEFT JOIN users u ON u.id = sb.user_id LEFT JOIN tasks t ON t.id = sb.task_id LEFT JOIN competitions c ON c.id = sb.competition_id", base: "submissions sb", alias: "sb",
    at: "sb.submitted_at", rid: "sb.rowid", et: "(CASE WHEN sb.is_correct=1 THEN 'submission_correct' ELSE 'submission_wrong' END)",
    actor: "u.email", actorNocase: true,
    kind: "'user'", subjectId: "sb.user_id", label: "COALESCE(u.nickname, u.email)",
    comp: "sb.competition_id", compName: "c.name", ts: "sb.timeslot_id",
    outcome: "(CASE WHEN sb.is_correct=1 THEN 'correct' ELSE 'wrong' END)", details: "NULL",
    extra: ", sb.answer AS _answer, sb.is_correct AS _is_correct, sb.points_delta AS _points_delta, sb.task_id AS _task_id, t.title AS _task_title, t.answer_sealed AS _sealed, t.created_by_id AS _author",
    scope: (req) => (_can(req, SOURCE_PERMISSIONS.submission) ? scopeFilterSql(req, "sb.competition_id") : null),
    compFilter: "sb.competition_id = ?", tsFilter: "sb.timeslot_id = ?",
    subjectFilter: "(sb.user_id = ? OR sb.task_id = ?)", subjectParams: 2, qExtra: ["t.title", "c.name"],
    sealedAnswer: { sealed: "t.answer_sealed", author: "t.created_by_id", taskId: "sb.task_id", answer: "sb.answer" },
  },
  hint: {
    from: "hint_reveals h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN tasks t ON t.id = h.task_id LEFT JOIN competitions c ON c.id = h.competition_id", base: "hint_reveals h", alias: "h",
    at: "h.revealed_at", rid: "h.rowid", et: "'hint_revealed'", actor: "u.email", actorNocase: true,
    kind: "'user'", subjectId: "h.user_id", label: "COALESCE(u.nickname, u.email)",
    comp: "NULLIF(h.competition_id, '')", compName: "c.name", ts: "h.timeslot_id",
    outcome: "'success'", details: "NULL",
    extra: ", h.task_id AS _task_id, t.title AS _task_title, h.points_deducted AS _points_deducted",
    scope: (req) => (_can(req, SOURCE_PERMISSIONS.hint) ? scopeFilterSql(req, "h.competition_id") : null),
    compFilter: "h.competition_id = ?", tsFilter: "h.timeslot_id = ?",
    subjectFilter: "(h.user_id = ? OR h.task_id = ?)", subjectParams: 2, qExtra: ["t.title", "c.name"],
  },
  log_event: {
    from: "orphan_events o LEFT JOIN competitions c ON c.id = o.competition_id", base: "orphan_events o", alias: "o",
    at: "o.changed_at", rid: "o.rowid", et: "o.event_type", actor: "o.changed_by", actorIndexed: true,
    kind: "o.scope", subjectId: "o.scope_id", label: "(CASE WHEN o.scope = 'competition' THEN c.name END)",
    comp: "o.competition_id", compName: "c.name", ts: "o.timeslot_id",
    outcome: OUT("o.event_type", "o.details"), details: "o.details", extra: "",
    // A row naming an event follows `events.view`; one naming none follows the
    // Raw logs permission, which only a role acting on every event holds (a
    // scoped reader's filter already withholds a NULL competition_id).
    scope: (req) => {
      const named = _can(req, SOURCE_PERMISSIONS.log_event);
      const raw = _can(req, RAW_LOGS_PERMISSION);
      const unnamed = scopedCompetitionIds(req) === null && raw;
      if (!named && !unnamed) return null;
      const sc = scopeFilterSql(req, "o.competition_id");
      if (named && unnamed) return sc;
      // Without the raw logs, the types only they may list are not listed.
      const hide = raw ? "" : ` AND o.event_type NOT IN (${LOG_EVENT_RAW_ONLY_TYPES.map(() => "?").join(",")})`;
      return { clause: sc.clause + (named ? " AND o.competition_id IS NOT NULL" : " AND o.competition_id IS NULL") + hide,
        params: raw ? sc.params : [...sc.params, ...LOG_EVENT_RAW_ONLY_TYPES] };
    },
    compFilter: "o.competition_id = ?", tsFilter: "o.timeslot_id = ?",
    subjectFilter: "o.scope_id = ?", subjectParams: 1, qExtra: ["c.name"],
  },
};

// Build one source's WHERE (scope + filters [+ cursor]). Returns null when the
// source cannot contribute (closed to the actor, or a filter it cannot match).
function _branchWhere(src, def, f, req, proj, cursor) {
  const sc = def.scope(req);
  if (!sc) return null;
  let where = "WHERE 1=1" + sc.clause;
  const params = [...sc.params];
  if (f.competitionId) {
    if (!def.compFilter) return null;
    where += ` AND ${def.compFilter}`; params.push(f.competitionId);
  }
  if (f.timeslotId) {
    if (!def.tsFilter) return null;
    where += ` AND ${def.tsFilter}`; params.push(f.timeslotId);
  }
  if (f.subjectId) {
    where += ` AND ${def.subjectFilter}`;
    for (let i = 0; i < def.subjectParams; i++) params.push(f.subjectId);
  }
  if (f.actor) {
    if (def.actorIndexed) { where += ` AND ${def.actor} IN (?, ?)`; params.push(f.actor, f.actor.toLowerCase()); }
    // An account's address: a search of uq_users_email_nocase, then that
    // person's own rows (LOWER(u.email) = ? walked every row by time).
    else if (def.actorNocase) { where += ` AND ${def.actor} = ? COLLATE NOCASE`; params.push(f.actor); }
    else return null;
  }
  if (f.eventTypes) { where += ` AND ${def.et} IN (SELECT value FROM json_each(?))`; params.push(JSON.stringify(f.eventTypes)); }
  if (f.outcomes) { where += ` AND ${def.outcome} IN (SELECT value FROM json_each(?))`; params.push(JSON.stringify(f.outcomes)); }
  if (f.from) { where += ` AND ${def.at} >= ?`; params.push(f.from); }
  if (f.to) { where += ` AND ${def.at} <= ?`; params.push(f.to); }
  if (f.q) {
    const arms = [def.et, def.actor, def.label, ...def.qExtra].map(x => `LOWER(COALESCE(${x}, '')) LIKE ? ESCAPE '\\'`);
    const qp = arms.map(() => f.qLike);
    // The page shows each event_type in plain words (public/js/features/
    // audit-admin.js); the keys whose wording matched the text arrive here and
    // widen the SAME search (never a filter of their own: without `q` they are
    // ignored). They match the type column only, so they disclose nothing `q`
    // could not.
    if (f.qEventTypes) { arms.push(`${def.et} IN (SELECT value FROM json_each(?))`); qp.push(JSON.stringify(f.qEventTypes)); }
    if (def.sealedAnswer) {
      // The search is an oracle: the answer term matches the SAME redacted value
      // the reader is shown, per row (lib/answer-seal.js).
      const sa = proj.sqlAnswer(def.sealedAnswer);
      arms.push(`LOWER(COALESCE(${sa.sql}, '')) LIKE ? ESCAPE '\\'`);
      qp.push(...sa.params, f.qLike);
    }
    where += ` AND (${arms.join(" OR ")})`;
    params.push(...qp);
  }
  const c = _cursorClause(src, def, cursor);
  return { where: where + c.sql, params: [...params, ...c.params] };
}

// Rows strictly after the cursor in the merged order (at DESC, source DESC,
// rowid DESC), as this source's own terms; an `inclusive` position (an anchor)
// keeps its own row too.
function _cursorClause(src, def, cursor) {
  if (!cursor) return { sql: "", params: [] };
  if (src < cursor.src) return { sql: ` AND ${def.at} <= ?`, params: [cursor.at] };
  if (src > cursor.src) return { sql: ` AND ${def.at} < ?`, params: [cursor.at] };
  return { sql: ` AND (${def.at} < ? OR (${def.at} = ? AND ${def.rid} ${cursor.inclusive ? "<=" : "<"} ?))`, params: [cursor.at, cursor.at, cursor.rid] };
}

// ── the walk budget (see the header) ──────────────────────────────────────────
// True when the planner walks the source's own table in time order or whole, or
// reaches it from a loop that enumerates another table whole (an organiser's
// scope over people can drive from every user): that walk visits rows until the
// page fills. False when searches alone reach it (a person, an event's own
// column, an actor). The reading itself is lib/query-plan.js.
function _walksByTime(def, sql, params) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return walksByTime(plan, def.alias, def.at.slice(def.at.indexOf(".") + 1));
}

// The oldest of the newest AUDIT_SCAN_BUDGET rows the source holds below the
// cursor and inside the From / To range, as a cursor-shaped position; null when
// the walk reaches the source's end inside the budget. Read off the time index
// alone: no row is fetched.
function _windowFloor(src, def, f, cursor) {
  const c = _cursorClause(src, def, cursor);
  let where = `WHERE 1=1${c.sql}`;
  const params = [...c.params];
  if (f.from) { where += ` AND ${def.at} >= ?`; params.push(f.from); }
  if (f.to) { where += ` AND ${def.at} <= ?`; params.push(f.to); }
  const two = db.prepare(`SELECT ${def.at} AS at, ${def.rid} AS rid FROM ${def.base} ${where} ORDER BY ${def.at} DESC, ${def.rid} DESC LIMIT 2 OFFSET ?`)
    .all(...params, AUDIT_SCAN_BUDGET - 1);
  return two.length === 2 ? { _at: two[0].at, _src: src, _rid: two[0].rid } : null;
}

// A WHERE bounded to the rows at or above the floor.
function _windowed(def, w, floor) {
  if (!floor) return w;
  return { where: `${w.where} AND ${def.at} >= ? AND (${def.at} > ? OR ${def.rid} >= ?)`, params: [...w.params, floor._at, floor._at, floor._rid] };
}

// The source's newest `limit` matches below the cursor, and the floor its walk
// was cut at (null when it was not).
function _branchList(src, def, f, req, proj, cursor, limit) {
  const w = _branchWhere(src, def, f, req, proj, cursor);
  if (!w) return { rows: [], floor: null };
  const sql = (where) => `SELECT ${def.rid} AS _rid, ${def.at} AS _at, ${def.et} AS _et, ${def.actor} AS _actor,
      ${def.kind} AS _kind, ${def.subjectId} AS _subject_id, ${def.label} AS _label,
      ${def.comp} AS _comp, ${def.compName} AS _comp_name, ${def.ts} AS _ts,
      ${def.outcome} AS _outcome, ${def.detailsFor ? def.detailsFor(req) : def.details} AS _details${def.extra}
    FROM ${def.from} ${where}
    ORDER BY ${def.at} DESC, ${def.rid} DESC LIMIT ?`;
  const floor = _walksByTime(def, sql(w.where), [...w.params, limit]) ? _windowFloor(src, def, f, cursor) : null;
  const win = _windowed(def, w, floor);
  const rows = db.prepare(sql(win.where)).all(...win.params, limit).map(r => ({ ...r, _src: src }));
  return { rows, floor };
}

// Counts at most `cap` matching rows (the walk stops there), at or above
// `floor` when the list's walk was cut.
function _branchCount(src, def, f, req, proj, cap, floor) {
  const w = _branchWhere(src, def, f, req, proj, null);
  if (!w) return 0;
  const win = _windowed(def, w, floor);
  return db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${def.from} ${win.where} LIMIT ?)`).get(...win.params, cap).n;
}

// Newest first; equal timestamps by source name, then rowid, both descending —
// the order the cursor arithmetic in _branchWhere assumes.
function _cmpRows(a, b) {
  if (a._at !== b._at) return a._at < b._at ? 1 : -1;
  if (a._src !== b._src) return a._src < b._src ? 1 : -1;
  return b._rid - a._rid;
}

function _projectRow(r, proj, rawLogs) {
  let details = _parseDetails(r._details);
  if (r._src === "log_event" && !rawLogs) {
    details = _logEventDetailsForReader(r._et, details);
  } else if (r._src === "submission") {
    const visible = proj.visible({ _sealed: r._sealed, _author: r._author, _task_id: r._task_id });
    details = {
      task_id: r._task_id, task_title: r._task_title,
      answer: visible ? r._answer : null,
      is_correct: r._is_correct, points_delta: r._points_delta,
      ...(r._sealed ? { answer_sealed: true, answer_visible: visible } : {}),
    };
  } else if (r._src === "hint") {
    details = { task_id: r._task_id, task_title: r._task_title, points_deducted: r._points_deducted };
  } else if (r._src === "challenge_version") {
    // METADATA ONLY: a snapshot holds the full challenge, the key included.
    details = { version_num: r._version_num, change_type: r._et };
  }
  return {
    id: `${r._src}:${r._rid}`,
    type: r._src,
    event_type: r._et,
    at: r._at,
    actor: r._actor == null ? null : r._actor,
    subject: { kind: r._kind == null ? null : r._kind, id: r._subject_id == null ? null : r._subject_id, label: r._label == null ? null : r._label },
    competition_id: r._comp == null ? null : r._comp,
    competition_name: r._comp_name == null ? null : r._comp_name,
    timeslot_id: r._ts == null ? null : r._ts,
    outcome: r._outcome,
    details,
  };
}

// ── query parsing ─────────────────────────────────────────────────────────────
function _str(v) { return typeof v === "string" ? v.trim() : ""; }
function _list(v, allowed) {
  const raw = _str(v);
  if (!raw) return { list: null };
  const items = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))];
  if (items.length > AUDIT_LIST_MAX || items.some(s => s.length > AUDIT_TOKEN_MAX)) return { error: true };
  if (allowed && items.some(s => !allowed.includes(s))) return { error: true, unknown: items.filter(s => !allowed.includes(s)) };
  return { list: items.length ? items : null };
}
function _date(v) {
  const raw = _str(v);
  if (!raw) return { value: null };
  if (raw.length > 40) return { error: true };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { error: true };
  return { value: d.toISOString() };
}
function _encodeCursor(r) { return Buffer.from(JSON.stringify([r._at, r._src, r._rid]), "utf8").toString("base64url"); }
function _decodeCursor(v) {
  const raw = _str(v);
  if (!raw) return { cursor: null };
  if (raw.length > 400) return { error: true };
  try {
    const arr = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(arr) || arr.length !== 3) return { error: true };
    const [at, src, rid] = arr;
    if (typeof at !== "string" || at.length > 40 || !AUDIT_TYPES.includes(src) || !Number.isSafeInteger(rid)) return { error: true };
    return { cursor: { at, src, rid } };
  } catch (e) { swallowed("audit:cursor-decode", e); return { error: true }; }
}
const _bad = (res, code, error) => res.status(400).json({ error, code });

// ── the response cache ────────────────────────────────────────────────────────
// 5 s, keyed actor | scope | url (the analytics shape), plus the acting human
// and their sealed reveals, because both change what a submission row shows,
// and whether the reader may read the raw logs, which changes what a logged
// event shows (a role edit lands inside the 5 s).
const _auditCache = new Map();
function _auditCacheKey(req, proj, readable) {
  return JSON.stringify([actorId(req) || "", actingAdminId(req) || "", req.session && req.session.builtinId ? "builtin" : "",
    scopedCompetitionIds(req), readable, proj.revealIds, _can(req, RAW_LOGS_PERMISSION), req.originalUrl || req.url]);
}
function _auditCacheSet(key, body) {
  if (_auditCache.size >= AUDIT_CACHE_MAX && !_auditCache.has(key)) {
    const oldest = _auditCache.keys().next().value;
    if (oldest !== undefined) _auditCache.delete(oldest);
  }
  _auditCache.set(key, { at: Date.now(), body });
}

module.exports = function register(app) {
  app.get("/api/admin/audit", requireAdmin, auditLimiter, (req, res) => {
    const q = req.query || {};
    const scoped = scopedCompetitionIds(req) !== null;

    const types = _list(q.types, AUDIT_TYPES);
    if (types.error) return _bad(res, "audit_type_unknown", `Unknown record type. Use any of: ${AUDIT_TYPES.join(", ")}.`);
    if (scoped && types.list && types.list.includes("setting")) {
      return res.status(403).json({ code: "audit_type_forbidden", error: "Platform settings changes apply to every event, so they are not available to event admins." });
    }
    // The kinds this reader may see (each follows its own permission; see the header).
    const readable = AUDIT_TYPES.filter(t => SOURCES[t].scope(req) !== null);
    const unreadable = types.list ? types.list.filter(t => !readable.includes(t)) : [];
    if (unreadable.length) {
      const perm = SOURCE_PERMISSIONS[unreadable[0]];
      return res.status(403).json({ code: "audit_type_forbidden", type: unreadable[0], permission: perm,
        error: `Your role cannot see these records: they need “${_permLabel(perm)}”.` });
    }
    const outcomes = _list(q.outcome, AUDIT_OUTCOMES);
    if (outcomes.error) return _bad(res, "audit_outcome_unknown", `Unknown outcome. Use any of: ${AUDIT_OUTCOMES.join(", ")}.`);
    const eventTypes = _list(q.event_type, null);
    if (eventTypes.error) return _bad(res, "audit_event_type_invalid", `Event types are a comma-separated list of at most ${AUDIT_LIST_MAX} names.`);
    const qEventTypes = _list(q.q_event_types, null);
    if (qEventTypes.error) return _bad(res, "audit_q_event_types_invalid", `q_event_types is a comma-separated list of at most ${AUDIT_LIST_MAX} names.`);
    const from = _date(q.from), to = _date(q.to);
    if (from.error || to.error) return _bad(res, "audit_date_invalid", "`from` and `to` must be dates (ISO 8601).");
    const cur = _decodeCursor(q.cursor);
    if (cur.error) return _bad(res, "audit_cursor_invalid", "That page link is not valid. Start again from the first page.");
    const anc = _decodeCursor(q.anchor);
    if (anc.error) return _bad(res, "audit_anchor_invalid", "That page link is not valid. Start again from the first page.");
    if (cur.cursor && anc.cursor) return _bad(res, "audit_position_conflict", "Send a cursor or an anchor, not both.");
    const offRaw = _str(q.offset);
    const offset = offRaw ? (/^\d{1,6}$/.test(offRaw) ? Number(offRaw) : -1) : 0;
    if (offset < 0 || offset > AUDIT_OFFSET_MAX) return _bad(res, "audit_offset_invalid", `\`offset\` is a whole number from 0 to ${AUDIT_OFFSET_MAX}.`);
    // Where the read starts: strictly below a cursor, or at and below an anchor.
    const pos = cur.cursor || (anc.cursor ? { ...anc.cursor, inclusive: true } : null);
    const competitionId = _str(q.competitionId).slice(0, AUDIT_TOKEN_MAX) || null;
    const timeslotId = _str(q.timeslotId).slice(0, AUDIT_TOKEN_MAX) || null;
    const subjectId = _str(q.subjectId).slice(0, AUDIT_TOKEN_MAX) || null;
    const actor = _str(q.actor).slice(0, AUDIT_TOKEN_MAX) || null;
    const qText = _str(q.q).toLowerCase().slice(0, AUDIT_Q_MAX);
    const limit = Math.min(AUDIT_LIMIT_MAX, Math.max(1, parseInt(_str(q.limit), 10) || AUDIT_LIMIT_DEFAULT));

    // Scope BEFORE existence: an out-of-scope id and an unknown one get the same
    // 403 for an event admin, so the difference is no oracle.
    if (competitionId) {
      const denied = competitionDenied(req, competitionId);
      if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
      if (!getCompetition(competitionId)) return res.status(404).json({ error: "Event not found" });
    }
    if (timeslotId) {
      const ts = getTimeslot(timeslotId);
      const denied = competitionDenied(req, ts ? ts.competition_id : null);
      if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
      if (!ts || (competitionId && ts.competition_id !== competitionId)) return res.status(404).json({ error: "Session not found" });
    }

    const proj = submissionAnswerProjection(req);
    const cacheKey = _auditCacheKey(req, proj, readable);
    const hit = _auditCache.get(cacheKey);
    if (hit && Date.now() - hit.at < AUDIT_CACHE_TTL_MS) return res.json(hit.body);

    const applied = (types.list || AUDIT_TYPES).filter(t => readable.includes(t));
    const f = {
      competitionId, timeslotId, subjectId, actor,
      eventTypes: eventTypes.list, outcomes: outcomes.list,
      from: from.value, to: to.value,
      q: qText || null, qLike: `%${qText.replace(/[%_\\]/g, "\\$&")}%`,
      qEventTypes: qText ? qEventTypes.list : null,
    };
    // One read snapshot for every branch and the count (the Submissions shape).
    const { rows, total, totalExact, frontier } = db.transaction(() => {
      const branches = applied.map(src => [src, _branchList(src, SOURCES[src], f, req, proj, pos, offset + limit + 1)]);
      let merged = [];
      for (const [, b] of branches) merged = merged.concat(b.rows);
      merged.sort(_cmpRows);
      // A source the budget cut short of a full page may hold matches older than
      // the oldest row it examined, which would belong between the rows other
      // sources found further back: nothing below the NEWEST such floor is
      // answered by this read, and Next goes on from that floor.
      let frontier = null;
      for (const [, b] of branches) {
        if (b.floor && b.rows.length <= offset + limit && (!frontier || _cmpRows(b.floor, frontier) < 0)) frontier = b.floor;
      }
      if (frontier) merged = merged.filter(r => _cmpRows(r, frontier) <= 0);
      if (pos || offset) return { rows: merged, total: null, totalExact: false, frontier };
      // Counted once, on the first page, and only up to AUDIT_COUNT_MAX + 1
      // matches across every source: one more than the floor says "more". A
      // source whose list came short of a full page has already been counted by
      // it; a cut walk counts the rows it searched, a floor.
      let totalN = 0, cut = false;
      for (const [src, b] of branches) {
        const left = AUDIT_COUNT_MAX + 1 - totalN;
        if (left <= 0) break;
        if (b.floor) cut = true;
        totalN += b.rows.length <= limit ? b.rows.length : _branchCount(src, SOURCES[src], f, req, proj, left, b.floor);
      }
      return totalN > AUDIT_COUNT_MAX
        ? { rows: merged, total: AUDIT_COUNT_MAX, totalExact: false, frontier }
        : { rows: merged, total: totalN, totalExact: !cut, frontier };
    }).deferred();

    const page = rows.slice(offset, offset + limit);
    const full = rows.length > offset + limit;
    const hasMore = full || !!frontier;
    const body = {
      rows: page.map(r => _projectRow(r, proj, _can(req, RAW_LOGS_PERMISSION))),
      limit,
      offset,
      offset_max: AUDIT_OFFSET_MAX,
      types: applied,
      readable_types: readable,
      has_more: hasMore,
      next_cursor: full ? _encodeCursor(page[page.length - 1]) : (frontier ? _encodeCursor(frontier) : null),
      // The newest row of the list the read started at: a later page is this
      // anchor plus `offset` (echoed on an anchored read; null below a cursor).
      anchor: anc.cursor ? _encodeCursor({ _at: anc.cursor.at, _src: anc.cursor.src, _rid: anc.cursor.rid })
        : (!pos && rows.length ? _encodeCursor(rows[0]) : null),
      total,
      total_exact: totalExact,
      // How far back a budget-cut walk searched (null when nothing was cut short).
      searched_to: !full && frontier ? frontier._at : null,
    };
    _auditCacheSet(cacheKey, body);
    res.json(body);
  });
};

module.exports.AUDIT_TYPES = AUDIT_TYPES;
// Raw logs' Audit log stream pages like this trail with this same count cap
// (server.js GET /api/admin/logs): one number for "page like the trail".
module.exports.AUDIT_COUNT_MAX = AUDIT_COUNT_MAX;
