"use strict";
//
// v7.21.0 — challenge CATEGORIES.
//
// A category is not a new column, a new table or a new admin surface: it is an
// ordinary task tag following the convention `category:<name>`. That was the
// explicit requirement ("as tags, these should behave exactly like any other
// tag"), and it is also the cheapest correct design — tag CRUD, the tag filter,
// the tag column, export/import, the audit trail and the search all keep working
// with no changes, because nothing about the tag is special until it is READ.
//
// WHAT IS SPECIAL is where it is read: a `category:` tag is the ONLY task tag a
// PARTICIPANT ever sees.
//
// That distinction is the security-relevant part of this feature and it is
// deliberately one-directional. Task tags are free-text admin labels — real
// instances carry things like `needs-review`, `reuse-2024`, `too-easy`, author
// names and ticket ids. Shipping the whole tag list to participants would leak
// all of it, so the participant payload carries ONLY the parsed category NAMES
// and never the raw tags. Add a new participant-visible tag convention here and
// it must be an explicit opt-in of the same shape, never a widening of what is
// returned.
//
// THE PARSE LIVES ONLY ON THE SERVER, on purpose. The client is handed a plain
// array of names and does not know the prefix exists. A prefix constant mirrored
// into public/js would be one more client/server pair that can drift silently —
// the class this codebase has been bitten by with the email regex and the
// rich-text table allowlist — and there is no reason to accept it here.

// Tags are lowercased at insert (routes/challenges.js), so the prefix only ever
// needs matching in lower case.
const CATEGORY_PREFIX = "category:";

/**
 * The category names carried by a list of task tags, in a stable order.
 *
 * Rules, each of which has a reason:
 *   • `category:` with nothing after it is NOT a category. A tag can be created
 *     by hand, by import, or by a typo, and rendering an empty ribbon is worse
 *     than rendering none.
 *   • the name is trimmed, so `category: web` and `category:web` are one thing.
 *   • duplicates collapse — two spellings that trim to the same name must not
 *     produce two identical ribbons side by side.
 *   • the ORDER is the caller's tag order (which is `ORDER BY tag` at every read
 *     site), so the same challenge always renders its categories the same way
 *     rather than shuffling between requests.
 */
function categoriesFromTags(tags) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (!t.startsWith(CATEGORY_PREFIX)) continue;
    const name = t.slice(CATEGORY_PREFIX.length).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Is this tag a category tag that names something? Used by the admin surface. */
function isCategoryTag(tag) {
  return categoriesFromTags([tag]).length === 1;
}

module.exports = { CATEGORY_PREFIX, categoriesFromTags, isCategoryTag };
