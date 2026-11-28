// @ts-check
//
// THE COUNTING-QUERY DETECTORS shared by the two counting-site scanners:
// tests/qualifying-counting-sites.spec.js (every count of an event's challenges
// leaves the Quick questions out) and tests/session-counting-sites.spec.js
// (every count for a participant reads their own session's question set). One
// copy, so the two scanners cannot disagree about what a counting query is.
// Moved byte for byte from the qualifying scanner, which proved them with its
// planted controls; it still runs those controls against this module.
"use strict";

/** Index just past the bracket-balanced region opened at `open`; string and template aware. */
function matchClose(s, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[s[open]]];
  let i = open + 1;
  while (i < s.length && stack.length) {
    const c = s[i];
    if (c === "'" || c === '"') { i++; while (i < s.length && s[i] !== c && s[i] !== "\n") { if (s[i] === "\\") i++; i++; } i++; continue; }
    if (c === "`") { i = skipTemplate(s, i); continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i++;
  }
  return i;
}
function skipTemplate(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && s[i + 1] === "{") { i = matchClose(s, i + 1); continue; }
    i++;
  }
  return i;
}

/** Every `.prepare(…)` call in comment-free source: its argument text, line and span. */
function prepareCalls(src) {
  const out = [];
  const re = /\.prepare\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open);
    out.push({ at: m.index, close, sql: src.slice(open + 1, close - 1), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** The names the `tasks` table is read under (`FROM tasks t`, `JOIN tasks t`; `tasks` when it has no alias). */
const _SQL_WORD = /^(WHERE|ON|JOIN|LEFT|INNER|CROSS|GROUP|ORDER|LIMIT|SET|AND|OR|USING|UNION)$/i;
const tasksAliases = (sql) => [...sql.matchAll(/\b(?:FROM|JOIN)\s+tasks\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi)]
  .map(m => (!m[1] || _SQL_WORD.test(m[1]) ? "tasks" : m[1]));

/** A column written bare (no `<alias>.` before it), as a `tasks` read with no alias writes it. */
const bare = (re) => new RegExp(`(?<![.\\w])${re}`);
const BARE_ACTIVE = bare("active\\s*=\\s*1\\b"), BARE_PUBLISHED = bare("status\\s*=\\s*'published'"), BARE_ID_PIN = bare("id\\s*=\\s*\\?");
/** Is `<alias>.id` pinned to one value (`t.id=?`)? */
const aliasPinned = (sql, a) => new RegExp(`\\b${a}\\.id\\s*=\\s*\\?`).test(sql);

/**
 * Does this SQL count an event's challenges or a participant's solves?
 * An event's challenges: `active=1` beside `status='published'` on one alias,
 * or both written bare on a query that reads `tasks`. A read PINNED to one
 * challenge by its id (`<that alias>.id=?`; for the bare form, `id=?` bare or
 * on a tasks alias) reads one row, so counts nothing.
 */
function countsChallenges(sql) {
  for (const m of sql.matchAll(/\b([A-Za-z_]\w*)\.status\s*=\s*'published'/g)) {
    if (new RegExp(`\\b${m[1]}\\.active\\s*=\\s*1\\b`).test(sql) && !aliasPinned(sql, m[1])) return true;
  }
  const read = tasksAliases(sql);
  if (read.length && BARE_ACTIVE.test(sql) && BARE_PUBLISHED.test(sql)
    && !BARE_ID_PIN.test(sql) && !read.some(a => aliasPinned(sql, a))) return true;
  // A participant's solves.
  return /\bsubmissions\b/.test(sql) && /\bis_correct\b/.test(sql)
    && /COUNT\(\s*DISTINCT|MAX\(\s*(?:\w+\.)?submitted_at\b/i.test(sql);
}

module.exports = { matchClose, skipTemplate, prepareCalls, tasksAliases, countsChallenges };
