"use strict";

// ── One matcher for every challenge search an organiser types into ───────────
//
// The Challenge library, the workspace "Add challenges" dialog and the event /
// template editor's challenge picker all answer "which challenges did I mean?".
// Each used to carry its own filter, and they disagreed: the editor matched the
// TITLE only, so typing a tag (`public-domain`, `needs:docker`, a category) found
// nothing there while the library found it. One function, imported by all three.
//
// THE RULE: the query is split on whitespace and EVERY word must appear
// (case-insensitively, as a substring) in at least one of the challenge's fields:
// its title, difficulty and every tag. A category is the tag `category:<name>`,
// so typing either `web` or `category:web` finds it. Callers may pass further
// fields (answer type, author, event names) through `extra`. Plain substring
// tests only: the typed text never becomes a regular expression.

// ── One test for "is this a qualifying challenge?" ───────────────────────────
// A qualifying challenge is an ordinary challenge tagged `qualifying:<key>`
// (lib/qualifying.js); an organiser's screen knows one only by that tag (a
// participant gets the boolean `qualifying` instead). The Analytics filters, the
// create form's Challenges section and its tag chips, and View as participant
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
  const fields = [t && t.title, t && t.difficulty, ...((t && t.tags) || []), ...(extra ? (extra(t) || []) : [])]
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
