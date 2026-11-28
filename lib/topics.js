"use strict";

// TOPICS — how the Question bank is organised (owner request, stage B).
//
// A topic is a first-class row (`topics`), and a question names at most one
// (`tasks.topic_id`); a topic holds many questions, bank questions and events'
// own copies alike (a copy takes its bank question's topic: lib/event-copies.js
// copies every column).
//
// TOPICS REPLACE CATEGORY TAGS for participants. The participant wire keeps its
// `categories` array (a list of names, never tags): a question with a topic shows
// exactly its topic's name; one without falls back to its legacy `category:<name>`
// tags (lib/categories.js), so a question nobody has filed yet reads as before.
// The one-shot migration in db.js files every question under its first category
// tag, and keeps the tags (no stored tag is deleted).
//
// Topic names are platform-wide labels: every organiser may file a question under
// any topic. Renaming and deleting are the topic creator's or a global admin's
// (routes/topics.js). A topic is deleted only when no question names it, or after
// moving its questions to another topic (or to none).
//
// PURE: every function takes the better-sqlite3 handle (db.js runs the
// migration before any route module loads).

const crypto = require("crypto");
const { categoriesFromTags } = require("./categories");

const TOPIC_NAME_MAX = 60;

/** null when `name` is a usable topic name, else the 400 sentence. */
function topicNameError(name) {
  if (typeof name !== "string") return "Topic name must be text.";
  const t = name.trim();
  if (!t) return "Topic name must not be empty.";
  if (t.length > TOPIC_NAME_MAX) return `Topic name must be at most ${TOPIC_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return "Topic name must not contain control characters.";
  return null;
}

/** The topic named `name` (case-insensitive), or null. */
function topicByName(db, name) {
  return db.prepare("SELECT id, name FROM topics WHERE name=? COLLATE NOCASE").get(String(name).trim()) || null;
}

/** Make a topic (caller has validated the name and checked it is free). */
function insertTopic(db, name, { createdBy = "system", createdById = null, nowIso = new Date().toISOString() } = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO topics (id, name, created_at, created_by, created_by_id, updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, String(name).trim(), nowIso, createdBy, createdById, nowIso);
  return id;
}

/**
 * THE PARTICIPANT `categories` ARRAY: the topic's name when the question has a
 * topic, else the names its legacy `category:` tags carry. Never a raw tag.
 */
function participantCategories(topicName, tags) {
  if (typeof topicName === "string" && topicName.trim()) return [topicName.trim()];
  return categoriesFromTags(tags);
}

/**
 * Topic names for a list of question ids, in one read: Map id -> name (only
 * questions that have a topic are in it).
 */
function topicNamesFor(db, taskIds) {
  const out = new Map();
  if (!taskIds.length) return out;
  for (const r of db.prepare(
    "SELECT t.id, tp.name FROM tasks t JOIN topics tp ON tp.id=t.topic_id WHERE t.id IN (SELECT value FROM json_each(?))"
  ).all(JSON.stringify(taskIds))) out.set(r.id, r.name);
  return out;
}

/**
 * The one-shot migration (db.js, marker `topics_from_categories_at`): each
 * question with no topic and at least one `category:` tag is filed under the
 * first category name (made into a topic once, matched case-insensitively).
 */
function migrateCategoryTagsToTopics(db, { nowIso = new Date().toISOString() } = {}) {
  const rows = db.prepare(
    "SELECT tt.task_id, tt.tag FROM task_tags tt JOIN tasks t ON t.id=tt.task_id WHERE t.topic_id IS NULL AND lower(trim(tt.tag)) LIKE 'category:%' ORDER BY tt.task_id, tt.tag"
  ).all();
  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push(r.tag);
  }
  let topicsCreated = 0, questions = 0;
  db.transaction(() => {
    const setTopic = db.prepare("UPDATE tasks SET topic_id=? WHERE id=? AND topic_id IS NULL");
    for (const [taskId, tags] of byTask) {
      const first = categoriesFromTags(tags)[0];
      if (!first || topicNameError(first)) continue;
      let topic = topicByName(db, first);
      if (!topic) { topic = { id: insertTopic(db, first, { nowIso }) }; topicsCreated++; }
      questions += setTopic.run(topic.id, taskId).changes;
    }
  })();
  return { topicsCreated, questions };
}

module.exports = {
  TOPIC_NAME_MAX, topicNameError, topicByName, insertTopic,
  participantCategories, topicNamesFor, migrateCategoryTagsToTopics,
};
