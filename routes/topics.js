"use strict";

// TOPICS — the Question bank's one way of organising questions (lib/topics.js).
//
//   GET    /api/admin/topics        every topic, with how many questions this
//                                   reader can see in it (bank questions only)
//                                   and whether they may rename or delete it
//   POST   /api/admin/topics        { name }       make a topic
//   PUT    /api/admin/topics/:id    { name }       rename it
//   DELETE /api/admin/topics/:id    { move_to? }   delete it
//
// Topic NAMES are platform-wide: every organiser files questions under any
// topic (the question editor's picker lists them all), so making one needs only
// `challenges.edit`. RENAMING and DELETING change what every organiser's
// questions are filed under, so they are a global admin's, or the topic's own
// creator's (an event admin, or a role scoped to its events, who made it).
//
// A topic is deleted only when no question names it, bank or event copy alike;
// a global admin may instead name `move_to` (another topic's id, or null for no
// topic) and the questions move first, in the same transaction. A scoped
// creator may delete only an empty topic: they cannot see every question that
// might be filed under it.
//
// Audited as orphaned `topic` events (created / edited / deleted) with the
// request context. Registered from server.js with absolute, method-specific
// paths.

const db = require("../db");
const { requireAdmin, csrfProtection } = require("../lib/middleware");
const { getAdminIdentity, recordOrphanedAuditEvent, reqContext } = require("../lib/audit");
const { actorId, scopedCompetitionIds, taskVisibilitySql } = require("../lib/event-admin");
const T = require("../lib/topics");
const { now } = require("../lib/time");

/** May this caller rename or delete topic `row`? */
function _mayManage(req, row) {
  if (scopedCompetitionIds(req) === null) return true;
  const me = actorId(req);
  return !!me && row.created_by_id === me;
}

module.exports = function register(app) {
  app.get("/api/admin/topics", requireAdmin, (req, res) => {
    const vis = taskVisibilitySql(req, "t");
    const counts = new Map(db.prepare(
      `SELECT t.topic_id AS id, COUNT(*) AS n FROM tasks t WHERE t.topic_id IS NOT NULL AND t.owner_competition_id IS NULL${vis.clause} GROUP BY t.topic_id`
    ).all(...vis.params).map(r => [r.id, r.n]));
    const rows = db.prepare("SELECT id, name, created_by_id FROM topics ORDER BY name COLLATE NOCASE, id").all();
    res.json(rows.map(r => {
      const may = _mayManage(req, r);
      return {
        id: r.id, name: r.name,
        question_count: counts.get(r.id) || 0,
        can_manage: may,
        ...(may ? {} : { manage_refusal: "Only the person who made this topic, or an administrator, can rename or delete it." }),
      };
    }));
  });

  app.post("/api/admin/topics", requireAdmin, csrfProtection, (req, res) => {
    const name = req.body?.name;
    const err = T.topicNameError(name);
    if (err) return res.status(400).json({ error: err, code: "topic_name_invalid" });
    const clash = T.topicByName(db, name);
    if (clash) return res.status(409).json({ error: `A topic called "${clash.name}" already exists.`, code: "topic_exists", id: clash.id, name: clash.name });
    let id;
    try {
      id = T.insertTopic(db, name, { createdBy: getAdminIdentity(req), createdById: actorId(req), nowIso: now().toISOString() });
    } catch (e) {
      // The NOCASE unique index settles a race between two creates.
      const again = T.topicByName(db, name);
      if (again) return res.status(409).json({ error: `A topic called "${again.name}" already exists.`, code: "topic_exists", id: again.id, name: again.name });
      throw e;
    }
    recordOrphanedAuditEvent("topic", id, "created", getAdminIdentity(req), { name: name.trim(), ...reqContext(req) });
    res.status(201).json({ ok: true, id, name: name.trim() });
  });

  app.put("/api/admin/topics/:id", requireAdmin, csrfProtection, (req, res) => {
    const row = db.prepare("SELECT id, name, created_by_id FROM topics WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Topic not found", code: "topic_not_found" });
    if (!_mayManage(req, row)) return res.status(403).json({ error: "Only the person who made this topic, or an administrator, can rename it.", code: "topic_not_yours" });
    const name = req.body?.name;
    const err = T.topicNameError(name);
    if (err) return res.status(400).json({ error: err, code: "topic_name_invalid" });
    const to = name.trim();
    if (to === row.name) return res.json({ ok: true, id: row.id, name: row.name, changed: false });
    const clash = T.topicByName(db, to);
    if (clash && clash.id !== row.id) return res.status(409).json({ error: `A topic called "${clash.name}" already exists.`, code: "topic_exists", id: clash.id, name: clash.name });
    db.prepare("UPDATE topics SET name=?, updated_at=? WHERE id=?").run(to, now().toISOString(), row.id);
    recordOrphanedAuditEvent("topic", row.id, "edited", getAdminIdentity(req), { changes: { name: { from: row.name, to } }, ...reqContext(req) });
    res.json({ ok: true, id: row.id, name: to, changed: true });
  });

  app.delete("/api/admin/topics/:id", requireAdmin, csrfProtection, (req, res) => {
    const row = db.prepare("SELECT id, name, created_by_id FROM topics WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Topic not found", code: "topic_not_found" });
    if (!_mayManage(req, row)) return res.status(403).json({ error: "Only the person who made this topic, or an administrator, can delete it.", code: "topic_not_yours" });
    const body = req.body || {};
    const hasMove = Object.prototype.hasOwnProperty.call(body, "move_to");
    const moveTo = body.move_to;
    if (hasMove && moveTo !== null && typeof moveTo !== "string") return res.status(400).json({ error: "move_to must be a topic id, or null for no topic.", code: "topic_move_invalid" });
    let target = null;
    if (hasMove && moveTo !== null) {
      if (moveTo === row.id) return res.status(400).json({ error: "Move the questions to a different topic.", code: "topic_move_invalid" });
      target = db.prepare("SELECT id, name FROM topics WHERE id=?").get(moveTo);
      if (!target) return res.status(400).json({ error: "The topic to move the questions to no longer exists.", code: "topic_not_found" });
    }
    const scoped = scopedCompetitionIds(req) !== null;
    // One immediate transaction, no await: the count, the move and the delete see
    // the same rows. A held topic answers its refusal, never an exception.
    const txn = db.transaction(() => {
      const held = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE topic_id=?").get(row.id).n;
      if (held && (!hasMove || scoped)) return { refused: held };
      const n = held ? db.prepare("UPDATE tasks SET topic_id=? WHERE topic_id=?").run(target ? target.id : null, row.id).changes : 0;
      db.prepare("DELETE FROM topics WHERE id=?").run(row.id);
      return { moved: n };
    });
    const out = txn.immediate();
    if (out.refused) {
      const n = out.refused;
      return res.status(409).json({
        error: scoped
          ? `"${row.name}" still holds ${n} question${n === 1 ? "" : "s"}. Move them to another topic first, or ask an administrator to delete it.`
          : `"${row.name}" still holds ${n} question${n === 1 ? "" : "s"}. Choose a topic to move them to (or none), then delete it.`,
        code: "topic_not_empty", questions: n, can_move: !scoped,
      });
    }
    const moved = out.moved;
    recordOrphanedAuditEvent("topic", row.id, "deleted", getAdminIdentity(req), {
      name: row.name, ...(moved ? { questions_moved: moved, moved_to: target ? target.name : null } : {}), ...reqContext(req),
    });
    res.json({ ok: true, moved, ...(moved ? { moved_to: target ? { id: target.id, name: target.name } : null } : {}) });
  });
};
