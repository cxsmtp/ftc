"use strict";

// ── One matcher for every challenge search an organiser types into ───────────
//
// The Question bank, the workspace "Add from bank" dialog and the event /
// template editor's challenge picker all answer "which challenges did I mean?".
// Each used to carry its own filter, and they disagreed: the editor matched the
// TITLE only, so typing a tag (`public-domain`, `needs:docker`, a category) found
// nothing there while the library found it. One function, imported by all three.
//
// THE RULE: the query is split on whitespace and EVERY word must appear
// (case-insensitively, as a substring) in at least one of the challenge's fields:
// its title, difficulty, topic and every tag. A category is the tag
// `category:<name>`, so typing either `web` or `category:web` finds it. Callers may pass further
// fields (answer type, author, event names) through `extra`. Plain substring
// tests only: the typed text never becomes a regular expression.

// ── One test for "is this a qualifying challenge?" ───────────────────────────
// A qualifying challenge is an ordinary challenge tagged `qualifying:<key>`
// (lib/qualifying.js); an organiser's screen knows one only by that tag (a
// participant gets the boolean `qualifying` instead). The Analytics filters, the
// template editor's picker, the workspace Overview and View as participant
// all ask these two, so no screen can disagree about which challenge is one.

/** A qualifying challenge's tag, `qualifying:<key>` (lib/qualifying.js). */
export function isQualifyingTag(tag) {
  return String(tag == null ? "" : tag).toLowerCase().startsWith("qualifying:");
}

/** A qualifying challenge: one carrying a `qualifying:` tag. The server leaves
 *  it out of everything that counts or scores, Analytics included. */
export function isQualifyingTask(t) {
  return ((t && t.tags) || []).some(isQualifyingTag);
}

// ── The bank and an event's own questions (lib/event-copies.js) ─────────────
// A row of GET /api/admin/tasks is a BANK question (`owner_competition_id`
// null) or an event's OWN question (that event's id). A bank row lists every
// event holding a copy of it in `competitions[]`, its entry naming the copy as
// `copy_id`. Every organiser list picks its rows through these, so no screen
// shows one event's question as part of the library or of another event.

/** A bank (library) question. */
export function isBankTask(t) { return !!t && !t.owner_competition_id; }

/** The library: bank questions only. */
export function bankTasks(tasks) { return (tasks || []).filter(isBankTask); }

/** Event `compId`'s workspace list: its own questions, then the bank questions
 *  it holds no copy of (the rest of the library, to add from). */
export function workspaceTasks(tasks, compId) {
  return (tasks || []).filter(t => t && (t.owner_competition_id
    ? t.owner_competition_id === compId
    : !(t.competitions || []).some(c => c.id === compId && c.copy_id)));
}

/** An assign picker for event `compId`: bank questions (ticked when the event
 *  holds a copy), plus the event's own questions no listed bank question stands for. */
export function pickerTasks(tasks, compId) {
  const all = tasks || [];
  const bankIds = new Set(all.filter(isBankTask).map(t => t.id));
  return all.filter(t => t && (isBankTask(t) || (t.owner_competition_id === compId && !bankIds.has(t.copied_from_task_id))));
}

/** The words of a query, lower-cased. Empty for a blank query. */
export function taskQueryTerms(q) {
  return String(q == null ? "" : q).toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/**
 * Does challenge `t` match query `q`? `extra(t)` may return more values to
 * search (the library adds answer type, status, author and event names).
 */
export function taskMatchesQuery(t, q, extra) {
  const terms = taskQueryTerms(q);
  if (!terms.length) return true;
  const fields = [t && t.title, t && t.difficulty, t && t.topic_name, ...((t && t.tags) || []), ...(extra ? (extra(t) || []) : [])]
    .filter(v => v !== null && v !== undefined && v !== "")
    .map(v => String(v).toLowerCase());
  return terms.every(term => fields.some(f => f.includes(term)));
}

/** True when the query matched this challenge through a tag (not its title). */
export function taskTagHit(tag, q) {
  const terms = taskQueryTerms(q);
  if (!terms.length) return false;
  const low = String(tag || "").toLowerCase();
  return terms.some(term => low.includes(term));
}
