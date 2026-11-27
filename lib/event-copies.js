"use strict";

// A QUESTION ADDED TO AN EVENT LIVES IN THAT EVENT (owner decision, Nov 2026).
//
// `tasks` holds two kinds of row:
//   • a BANK question: `owner_competition_id IS NULL`. The library. Never
//     assigned to an event directly (qualifying questions excepted, below).
//   • an EVENT-OWNED question: `owner_competition_id = <event>`. Assigned to that
//     event only. Made by copying a bank question when it is added to the event
//     (`copied_from_task_id` = the bank question), by copying another event's
//     question when an event is cloned or spawned, or created in the event.
// Editing an event-owned question changes that one event; editing a bank
// question changes no event (later bank edits never reach a copy).
//
// QUALIFYING QUESTIONS (`qualifying:<key>` tag) are already per-event rows with
// their own rules (lib/qualifying.js: an event asks each once, another event's may
// be shared): they are left out of this machinery and assigned as they are.
//
// PURE: every function takes the better-sqlite3 handle. Required by db.js (the
// batch migration at boot), by the assign doors, and by the read-only dry-run
// script (scripts/event-copies-dry-run.js), which opens a database of the
// previous release, where the two columns may not exist yet.

const crypto = require("crypto");

// Columns a copy never takes from its source: its own identity, its owner and
// origin (set from the copy's own facts) and its version token.
const NOT_COPIED = new Set(["id", "owner_competition_id", "copied_from_task_id", "updated_at"]);

// THE MANIFEST: every table holding a `task_id`, and what an event's copy does
// with it. A decision per table, checked both ways against the schema by
// tests/event-copies.spec.js — a new table with a task_id fails until it is
// decided here.
//   moved  — rows naming (competition, task) belong to that event: the batch
//            migration moves the event's rows from the bank question to its copy.
//   copied — a property of the question: a new copy gets its own rows.
//   stays  — stays with the question it names (the bank question, at migration).
const TASK_TABLE_MANIFEST = Object.freeze({
  competition_tasks: { action: "moved", reason: "the assignment of the question to the event; its task_number and assigned_by/at move with it" },
  submissions:       { action: "moved", reason: "answers given in the event (competition_id); scores read them through competition_tasks" },
  hint_reveals:      { action: "moved", reason: "hints bought in the event (competition_id); scores subtract them" },
  challenge_events:  { action: "moved", reason: "the event's analytics stream (competition_id)" },
  attempt_grants:    { action: "moved", reason: "extra attempts granted in the event (competition_id)" },
  task_tags:         { action: "copied", reason: "tags and categories are part of the question; the copy gets its own rows" },
  task_attachments:  { action: "copied", reason: "rows copied with new ids; the FILE is shared (same storage_path), so a delete unlinks a file only when no row names it any more" },
  task_versions:     { action: "stays", reason: "history of the bank question; the copy starts with one fresh version of change_type 'copy' naming its origin" },
  task_feedback:     { action: "stays", reason: "ratings have no competition id, so old ratings cannot be split by event (owner accepted); new ratings land on the copy" },
});
// Tables whose task ids are not a `task_id` column, decided the same way.
const TASK_REFERENCE_MANIFEST = Object.freeze({
  "event_templates.task_ids": { action: "stays", reason: "a template names bank questions (or an event's own); spawning copies them" },
});

const MOVED_TABLES = Object.keys(TASK_TABLE_MANIFEST).filter(t => TASK_TABLE_MANIFEST[t].action === "moved");

function _hasColumns(db) {
  const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  return cols.includes("owner_competition_id") && cols.includes("copied_from_task_id");
}

function _isQualifying(db, taskId) {
  return !!db.prepare("SELECT 1 FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%' LIMIT 1").get(taskId);
}

// Test-only: while set, the assign doors put the bank question itself into the
// event (the model before this change), so a spec can build a database the way
// the previous release did and run the batch migration over it. Only
// `POST /api/test/legacy-shared-assign` (NODE_ENV=test) sets it.
let _legacySharedAssign = false;
function _setLegacySharedAssignForTest(on) { _legacySharedAssign = !!on; }

/**
 * Copy question `srcId` into event `compId`. Inside the caller's transaction.
 * Returns the new id. Origin: a bank source is the origin; an event-owned
 * source passes on its own origin (NULL for one created in its event).
 */
function copyTaskIntoEvent(db, srcId, compId, { changedBy = "system", via = "assign", nowIso = new Date().toISOString() } = {}) {
  const src = db.prepare("SELECT * FROM tasks WHERE id=?").get(srcId);
  if (!src) throw new Error("copyTaskIntoEvent: no such task");
  const id = crypto.randomUUID();
  const origin = src.owner_competition_id ? (src.copied_from_task_id || null) : src.id;
  const cols = Object.keys(src).filter(c => !NOT_COPIED.has(c));
  const all = ["id", ...cols, "owner_competition_id", "copied_from_task_id", "updated_at"];
  db.prepare(`INSERT INTO tasks (${all.join(",")}) VALUES (${all.map(() => "?").join(",")})`)
    .run(id, ...cols.map(c => src[c]), compId, origin, nowIso);
  db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) SELECT ?, tag FROM task_tags WHERE task_id=?").run(id, srcId);
  const atts = db.prepare("SELECT * FROM task_attachments WHERE task_id=? AND detached_at IS NULL ORDER BY order_idx, created_at").all(srcId);
  const insAtt = db.prepare("INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const a of atts) insAtt.run(crypto.randomUUID(), id, a.display_name, a.original_name, a.size_bytes, a.sha256, a.storage_path, a.created_at, a.created_by, a.order_idx);
  // The copy's first version: a full snapshot (restore reads one), naming where
  // it came from. Written here rather than through lib/audit (db.js runs this
  // before that module can load).
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  const tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(id).map(r => r.tag);
  const attachments = db.prepare("SELECT id, display_name, original_name, size_bytes, sha256, order_idx FROM task_attachments WHERE task_id=? AND detached_at IS NULL ORDER BY order_idx, created_at").all(id);
  db.prepare("INSERT INTO task_versions (id, task_id, version_num, changed_by, changed_at, snapshot, change_type, details) VALUES (?,?,1,?,?,?,'copy',?)")
    .run(crypto.randomUUID(), id, changedBy, nowIso, JSON.stringify({ ...row, tags, attachments }),
      JSON.stringify({ copied_from: srcId, origin_task_id: origin, competition_id: compId, via }));
  return id;
}

/**
 * THE ONE ANSWER the assign doors ask: which question goes into event `compId`
 * when `taskId` is named? `{ id, copied }`, or `{ refused: {code, message} }`
 * for a question another event owns (copying is the only way to share it), or
 * null for no such question.
 *   • owned by this event → itself;
 *   • qualifying → itself (lib/qualifying.js keeps its own sharing rule);
 *   • a bank question → this event's existing copy of it, else a new copy.
 */
function eventTaskFor(db, taskId, compId, opts = {}) {
  const row = db.prepare("SELECT id, owner_competition_id FROM tasks WHERE id=?").get(taskId);
  if (!row) return null;
  if (row.owner_competition_id === compId) return { id: row.id, copied: false };
  if (row.owner_competition_id) return { refused: ownedElsewhereRefusal(db, row.owner_competition_id) };
  if (_legacySharedAssign || _isQualifying(db, row.id)) return { id: row.id, copied: false };
  const existing = existingCopyIn(db, row.id, compId);
  if (existing) return { id: existing, copied: false };
  return { id: copyTaskIntoEvent(db, row.id, compId, opts), copied: true };
}

/**
 * A clone or a template spawn (routes/competitions.js `_materialiseEvent`): the
 * new event gets a FRESH copy of each source question, whether the source is a
 * bank question or another event's own (the source event's copy, as edited
 * there). Returns the new event's question id.
 */
function copyForNewEvent(db, srcId, compId, opts = {}) {
  const row = db.prepare("SELECT id, owner_competition_id FROM tasks WHERE id=?").get(srcId);
  if (!row) return null;
  if (_isQualifying(db, row.id) || (_legacySharedAssign && !row.owner_competition_id)) return row.id;
  return copyTaskIntoEvent(db, row.id, compId, opts);
}

/** This event's copy of bank question `bankId`, assigned first, newest next. */
function existingCopyIn(db, bankId, compId) {
  const r = db.prepare(
    `SELECT t.id FROM tasks t LEFT JOIN competition_tasks ct ON ct.task_id = t.id AND ct.competition_id = t.owner_competition_id
      WHERE t.owner_competition_id = ? AND t.copied_from_task_id = ?
      ORDER BY (ct.task_id IS NULL), t.rowid DESC LIMIT 1`
  ).get(compId, bankId);
  return r ? r.id : null;
}

function ownedElsewhereRefusal(db, ownerId) {
  const nm = db.prepare("SELECT name FROM competitions WHERE id=?").get(ownerId);
  return {
    code: "task_owned_by_other_event",
    message: nm
      ? `This question belongs to the event “${nm.name}”. Add the bank question it was copied from instead, or copy it into the library first.`
      : "This question belongs to another event. Add the bank question it was copied from instead.",
  };
}

/**
 * The id actually assigned in event `compId` for a named question: itself, or
 * the event's copy of it when a bank id is named. null when neither is assigned.
 */
function assignedEventTaskId(db, taskId, compId) {
  if (db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, taskId)) return taskId;
  const r = db.prepare(
    `SELECT ct.task_id FROM competition_tasks ct JOIN tasks t ON t.id = ct.task_id
      WHERE ct.competition_id = ? AND t.copied_from_task_id = ? AND t.owner_competition_id = ct.competition_id LIMIT 1`
  ).get(compId, taskId);
  return r ? r.task_id : null;
}

/**
 * Route middleware for the participant's challenge routes, after
 * requireCompetitionContext: a BANK question id named in the session's event
 * means that event's copy of it. A tab opened before the batch migration (or a
 * link naming the bank question) keeps working on the event's own question; an
 * id the event holds itself, or nothing for, passes unchanged.
 */
function resolveEventTaskParam(db, name = "id") {
  return function resolveEventTask(req, _res, next) {
    const cid = req.session && req.session.competitionId;
    const tid = req.params && req.params[name];
    if (typeof cid === "string" && cid && typeof tid === "string" && tid) {
      const eid = assignedEventTaskId(db, tid, cid);
      if (eid && eid !== tid) req.params[name] = eid;
    }
    next();
  };
}

/** Events holding question `taskId`, or (for a bank question) a copy of it: [{competition_id, task_id}]. */
function eventsHolding(db, taskId) {
  return db.prepare(
    `SELECT competition_id, task_id FROM competition_tasks WHERE task_id = ?
     UNION
     SELECT ct.competition_id, ct.task_id FROM competition_tasks ct JOIN tasks t ON t.id = ct.task_id
      WHERE t.copied_from_task_id = ? AND t.owner_competition_id = ct.competition_id`
  ).all(taskId, taskId);
}

// ── The batch migration ──────────────────────────────────────────────────────

/**
 * Every (event, bank question) pair the previous model shared: the question is
 * assigned to the event, or the event holds answers, hints, grants or analytics
 * for it (an unassigned question keeps them, and re-adding it brought them back,
 * so its copy takes them and is what a re-add finds). Qualifying questions and
 * pairs naming a deleted event are left alone.
 */
function _sharedPairs(db, haveCols) {
  const bank = haveCols ? "t.owner_competition_id IS NULL AND" : "";
  const union = MOVED_TABLES.map(tb => `SELECT competition_id, task_id FROM ${tb} WHERE competition_id IS NOT NULL AND competition_id <> ''`).join(" UNION ");
  return db.prepare(
    `SELECT p.competition_id, p.task_id, c.name AS competition_name FROM (${union}) p
       JOIN tasks t ON t.id = p.task_id
       JOIN competitions c ON c.id = p.competition_id
      WHERE ${bank} NOT EXISTS (SELECT 1 FROM task_tags q WHERE q.task_id = t.id AND q.tag LIKE 'qualifying:%')
      ORDER BY c.created_at, c.id, t.rowid`
  ).all();
}

/**
 * Give every event its own copy of every bank question it holds, and move the
 * event's rows (MOVED_TABLES) from the bank question to the copy. One
 * transaction per event, so an interrupted run leaves each event either done or
 * untouched, and a re-run finds nothing left to do for a finished one.
 * `dryRun`: write nothing; report what would be copied and moved.
 * Returns { events: [{competition_id, name, questions, rows:{table:n}}], questions, rows }.
 */
function migrateSharedTasksToEventCopies(db, { dryRun = false, nowIso = new Date().toISOString() } = {}) {
  const haveCols = _hasColumns(db);
  if (!dryRun && !haveCols) throw new Error("migrateSharedTasksToEventCopies: the tasks owner columns are missing");
  const byEvent = new Map();
  for (const p of _sharedPairs(db, haveCols)) {
    if (!byEvent.has(p.competition_id)) byEvent.set(p.competition_id, { name: p.competition_name, tasks: [] });
    byEvent.get(p.competition_id).tasks.push(p.task_id);
  }
  const report = { events: [], questions: 0, rows: Object.fromEntries(MOVED_TABLES.map(t => [t, 0])) };
  const counters = MOVED_TABLES.map(tb => [tb, db.prepare(`SELECT COUNT(*) AS n FROM ${tb} WHERE competition_id=? AND task_id=?`)]);
  for (const [compId, ev] of byEvent) {
    const evRep = { competition_id: compId, name: ev.name, questions: ev.tasks.length, rows: Object.fromEntries(MOVED_TABLES.map(t => [t, 0])) };
    const work = () => {
      for (const bankId of ev.tasks) {
        for (const [tb, stmt] of counters) evRep.rows[tb] += stmt.get(compId, bankId).n;
        if (dryRun) continue;
        const copyId = copyTaskIntoEvent(db, bankId, compId, { changedBy: "system", via: "migration", nowIso });
        for (const tb of MOVED_TABLES) {
          db.prepare(`UPDATE ${tb} SET task_id=? WHERE competition_id=? AND task_id=?`).run(copyId, compId, bankId);
        }
      }
    };
    if (dryRun) work(); else db.transaction(work)();
    report.events.push(evRep);
    report.questions += evRep.questions;
    for (const t of MOVED_TABLES) report.rows[t] += evRep.rows[t];
  }
  return report;
}

module.exports = {
  TASK_TABLE_MANIFEST, TASK_REFERENCE_MANIFEST, MOVED_TABLES,
  copyTaskIntoEvent, copyForNewEvent, eventTaskFor, existingCopyIn, assignedEventTaskId, eventsHolding, ownedElsewhereRefusal, resolveEventTaskParam,
  migrateSharedTasksToEventCopies,
  _setLegacySharedAssignForTest,
};
