// @ts-check
//
// EVERY SITE THAT COUNTS CHALLENGES LEAVES THE QUALIFYING ("QUICK") QUESTIONS OUT.
//
// A qualifying question is an ordinary challenge tagged `qualifying:<key>`
// (lib/qualifying.js). It is not a challenge that counts toward finishing, so
// every SQL that counts an event's challenges or a participant's solves (the
// all-solved end, a Program's completion, the leaderboard's finish time, the
// took-part test, a completion certificate's date, the Overview's solvers) must
// carry `${notQualifyingSql("<the tasks alias>")}`. One site without it lets a
// marketing question move a tie-break, finish an event or withhold a
// certificate, and nothing else would say so: the behavioural locks
// (tests/qualifying-exclusions.api.spec.js and the specs it names) reach a few
// sites each. This scanner holds them all, two ways:
//
//   * NAMED SITES. Each counting site is listed with how many of its queries
//     read the `tasks` table, and every one of those must exclude the quick
//     questions on that query's own tasks alias. A site that is renamed, loses a
//     query or gains one fails by name, so the list cannot rot silently. A count
//     of any shape discovery cannot see (the Overview's solves, read from
//     `challenge_events`) is held only here, once named.
//   * DISCOVERY. Every `.prepare(` call in server.js, db.js, lib/ and routes/
//     whose SQL counts an event's challenges (`active=1` beside
//     `status='published'` on one tasks alias, or both bare on a query reading
//     `tasks`; a read pinned to one challenge by its id, `t.id=?` or `id=?`,
//     counts nothing) or a participant's solves (`submissions` with `is_correct`
//     and a `COUNT(DISTINCT` / `MAX(submitted_at)`) must exclude them, or select
//     only them (`${qualifyingSql(`: the early end's wait), or be in EXEMPT with
//     its reason. An EXEMPT entry must match exactly one such call, so a stale
//     one fails.
//
// Comments are blanked first by tests/html-sink-scan.js `stripComments` (string,
// template and regex aware, newlines kept), not the regex stripper in
// tests/doc-registry.js: the SQL lives in template literals, which that one does
// not tokenise. A comment quoting `notQualifyingSql` INSIDE a call's argument
// (a `//` line between joined parts, a `/* */` before the SQL) must satisfy
// nothing: the planted control below holds that, read unstripped as well, where
// the same two calls pass (so it is the stripper that flags them), and that a
// wrong alias satisfies nothing.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { stripComments } = require("./html-sink-scan");

const ROOT = path.join(__dirname, "..");

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

/** Does it leave the quick questions out, on the alias its `tasks` table is read under? */
function excludesQualifying(sql) {
  const aliases = new Set(tasksAliases(sql));
  return [...sql.matchAll(/\$\{\s*notQualifyingSql\(\s*(["'])(\w+)\1\s*\)\s*\}/g)].some(m => aliases.has(m[2]));
}
/** Does it select only the quick questions (the early end's wait, `qualifyingAnsweredAll`)? */
const selectsQualifying = (sql) => /\$\{\s*qualifyingSql\(\s*(["'])\w+\1\s*\)\s*\}/.test(sql);

// THE COUNTING SITES, each with the number of its queries that read `tasks`.
// A function site runs from `function name(` to its closing brace at column 0;
// a statement site is the one `.prepare(` call its anchor opens.
const SITES = [
  { file: "lib/competitions.js", anchor: "function publishedTaskCount(", queries: 1, what: "the denominator of every \"finished every challenge\" test" },
  { file: "lib/competitions.js", anchor: "function participantSolvedAll(", queries: 1, what: "a Program's completion, and its certificate" },
  { file: "lib/competitions.js", anchor: "function lateEntryStateFor(", queries: 1, what: "whether a late entrant had finished by the end" },
  { file: "lib/competitions.js", anchor: "function participantAttempted(", queries: 2, what: "took part (an answer or a hint): the participation certificate and its offer" },
  { file: "lib/attempts.js", anchor: "function participantsFinishedAllDetail(", queries: 2, what: "finished (solved or out of attempts): the all-solved end and both revive gates" },
  { file: "lib/leaderboard.js", anchor: "const totalTasks = db.prepare(", queries: 1, what: "the board's finish-time denominator" },
  { file: "lib/leaderboard.js", anchor: "const solvedRows = db.prepare(", queries: 1, what: "the board's finish time, the tie-break" },
  { file: "server.js", anchor: "const mineSolved = db.prepare(", queries: 1, what: "the submit's fast path ahead of the all-solved scan" },
  { file: "routes/badge.js", anchor: "function _badgeEndDate(", queries: 1, what: "a completion certificate's date" },
  { file: "routes/event-overview.js", anchor: "const tot = db.prepare(", queries: 1, what: "the Overview pulse's solvers" },
  { file: "routes/event-overview.js", anchor: "const finished = visible ? (db.prepare(", queries: 1, what: "the Overview pulse's \"solved every challenge\"" },
  { file: "routes/event-overview.js", anchor: "const recentSolves = db.prepare(", queries: 1, what: "the Overview feed's solves" },
];

// Counting-shaped SQL that is right WITHOUT the exclusion. Each entry names one
// call by a marker in its SQL and must match exactly one; `follows`, when set,
// must match the code right after the call (the idiom that does the excluding).
const EXEMPT = [
  { file: "server.js", marker: "t.attempt_cap IS NOT NULL LIMIT 1",
    why: "an existence gate for the capped path, not a count: a capped quick question only costs one participantsFinishedAll call, which leaves quick questions out itself" },
  { file: "lib/event-team.js", marker: "tt.tag LIKE 'qualifying:%'",
    why: "selects ONLY the qualifying questions (the task_tags JOIN), for the lead reports' answers; it counts nothing toward finishing" },
  { file: "lib/event-team.js", marker: "ORDER BY ct.task_number, t.title",
    follows: /^\s*\.all\([^)]*\)\s*\.filter\(\s*(\w+)\s*=>\s*!qTaskIds\.has\(\s*\1\.id\s*\)\s*\)/,
    why: "the lead report's challenge figures leave the quick questions out in JS (qTaskIds, the report's own qualifying rows), never in SQL" },
  { file: "routes/participant.js", marker: "ORDER BY ct.task_number, t.difficulty, t.title",
    why: "the participant's challenge list shows every challenge, the quick questions included (they are answered there, marked qualifying); the server counts nothing from it" },
];

const SCANNED = () => ["server.js", "db.js",
  ...fs.readdirSync(path.join(ROOT, "lib")).filter(f => f.endsWith(".js")).sort().map(f => `lib/${f}`),
  ...fs.readdirSync(path.join(ROOT, "routes")).filter(f => f.endsWith(".js")).sort().map(f => `routes/${f}`)];

const _src = new Map();
const source = (file) => {
  if (!_src.has(file)) _src.set(file, stripComments(fs.readFileSync(path.join(ROOT, file), "utf8")));
  return _src.get(file);
};

/** The `.prepare(` calls of one named site, or an error string. */
function siteQueries(site) {
  const src = source(site.file);
  const at = src.indexOf(site.anchor);
  if (at < 0) return `${site.file}: "${site.anchor}" is gone (renamed or moved?)`;
  if (src.indexOf(site.anchor, at + 1) >= 0) return `${site.file}: "${site.anchor}" occurs more than once`;
  let calls;
  if (site.anchor.startsWith("function ")) {
    const end = src.indexOf("\n}", at);
    if (end < 0) return `${site.file}: no closing brace at column 0 after "${site.anchor}"`;
    calls = prepareCalls(src).filter(c => c.at > at && c.at < end);
  } else {
    calls = prepareCalls(src).filter(c => c.at >= at).slice(0, 1);
    if (!calls.length || calls[0].at > at + site.anchor.length) return `${site.file}: "${site.anchor}" opens no .prepare( call`;
  }
  return calls.filter(c => tasksAliases(c.sql).length);
}

/** Every counting-shaped call in `src` and what is wrong with it. */
function judge(file, src, exempt) {
  const findings = [], candidates = [];
  const hits = new Map(exempt.map(e => [e, 0]));
  for (const c of prepareCalls(src)) {
    if (!countsChallenges(c.sql)) continue;
    candidates.push(c);
    if (excludesQualifying(c.sql) || selectsQualifying(c.sql)) continue;
    const e = exempt.find(x => x.file === file && c.sql.includes(x.marker));
    if (e) {
      hits.set(e, hits.get(e) + 1);
      if (!e.follows || e.follows.test(src.slice(c.close))) continue;
      findings.push(`${file}:${c.line}  exempt as "${e.marker}", but the code after it no longer leaves the quick questions out`);
      continue;
    }
    findings.push(`${file}:${c.line}  counts challenges without \${notQualifyingSql(<its tasks alias>)}: ${c.sql.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  return { findings, candidates, hits };
}

test.describe("Qualifying questions: every counting site leaves them out", () => {
  test("the detectors catch a planted counting query without the exclusion (aliased or bare), a comment inside the call quoting it and a wrong alias (anti-vacuity)", () => {
    // Each line is a JS string here, so `${…}` inside it is text, as in the
    // scanned source. The two comments sit INSIDE their call's argument, where
    // a stripper that missed them would let them pass as the exclusion.
    const plantedSrc = [
      "function plantedLineComment(db, id) {",
      "  return db.prepare(`SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id` +",
      "    // ${notQualifyingSql(\"t\")} quoted in a comment inside the call excludes nothing",
      "    ` WHERE ct.competition_id=? AND t.active=1 AND t.status='published'`).get(id).c;",
      "}",
      "function plantedBlockComment(db, id) {",
      "  return db.prepare(/* AND ${notQualifyingSql(\"t\")} */ `SELECT MAX(s.submitted_at) AS m FROM submissions s JOIN tasks t ON t.id=s.task_id",
      "    WHERE s.user_id=? AND s.is_correct=1`).get(id);",
      "}",
      "function plantedRight(db, id) {",
      "  return db.prepare(`SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id",
      "    WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${notQualifyingSql(\"t\")}`).get(id).c;",
      "}",
      "function plantedWrongAlias(db, id) {",
      "  return db.prepare(`SELECT MAX(s.submitted_at) AS m FROM submissions s JOIN tasks q ON q.id=s.task_id",
      "    WHERE s.user_id=? AND s.is_correct=1 AND ${notQualifyingSql(\"t\")}`).get(id);",
      "}",
      "function plantedBareCount(db, id) {",
      "  return db.prepare(\"SELECT COUNT(*) AS c FROM tasks WHERE active=1 AND status='published' AND id IN (SELECT task_id FROM competition_tasks WHERE competition_id=?)\").get(id).c;",
      "}",
      "function plantedBareRight(db, id) {",
      "  return db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE active=1 AND status='published' AND ${notQualifyingSql(\"tasks\")}",
      "    AND id IN (SELECT task_id FROM competition_tasks WHERE competition_id=?)`).get(id).c;",
      "}",
      "function plantedOneBare(db, id) {",
      "  return db.prepare(\"SELECT id FROM tasks WHERE id=? AND active=1 AND status='published'\").get(id);",
      "}",
      "function plantedOneAliased(db, id) {",
      "  return db.prepare(\"SELECT t.id FROM tasks t WHERE t.id=? AND t.active=1 AND t.status='published'\").get(id);",
      "}",
    ].join("\n");
    const planted = stripComments(plantedSrc);
    const lines = (found) => found.map(f => f.split(" ")[0]);
    const r = judge("planted.js", planted, []);
    expect(r.candidates.map(c => c.line), "six counting queries (an event's challenges, aliased or bare, and a participant's solves); a read pinned to one challenge by its id, bare or aliased, is not one")
      .toEqual([2, 7, 11, 15, 19, 22]);
    expect(lines(r.findings), "flagged: the two quoting the exclusion only in a comment, the wrong alias and the bare count; not the two that exclude")
      .toEqual(["planted.js:2", "planted.js:7", "planted.js:15", "planted.js:19"]);
    // The stripper is what flags the two comments: read unstripped, the same
    // calls are found and each comment passes as the exclusion.
    const raw = judge("planted.js", plantedSrc, []);
    expect(raw.candidates.map(c => c.line), "PRECONDITION: unstripped, the same calls are read").toEqual([2, 7, 11, 15, 19, 22]);
    expect(lines(raw.findings), "unstripped, both comments would satisfy the check").toEqual(["planted.js:15", "planted.js:19"]);
    // The exemption idiom: met, and broken.
    const ex = [{ file: "planted.js", marker: "t.status='published'`", follows: /^\.get\(id\)\.c;/ }];
    expect(lines(judge("planted.js", planted, ex).findings), "an exempt call whose idiom follows it passes").toEqual(["planted.js:7", "planted.js:15", "planted.js:19"]);
    const ex2 = [{ file: "planted.js", marker: "t.status='published'`", follows: /^\.all\(/ }];
    expect(judge("planted.js", planted, ex2).findings.length, "an exempt call whose idiom is gone is flagged").toBe(4);
  });

  test("every named counting site still exists and excludes the quick questions on each of its queries", () => {
    const bad = [];
    let queries = 0;
    for (const site of SITES) {
      const q = siteQueries(site);
      if (typeof q === "string") { bad.push(q); continue; }
      queries += q.length;
      if (q.length !== site.queries) bad.push(`${site.file} ${site.anchor}: ${q.length} queries read tasks, ${site.queries} expected (${site.what})`);
      for (const c of q) {
        if (!excludesQualifying(c.sql)) bad.push(`${site.file}:${c.line} (${site.what}) counts the quick questions: no \${notQualifyingSql(<its tasks alias>)}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    // Anti-vacuity: the list is the list, and each site was really read.
    expect(SITES.length).toBe(12);
    expect(queries, "every named site's queries were found").toBe(SITES.reduce((n, s) => n + s.queries, 0));
  });

  test("no other SQL counts challenges with the quick questions in, unless it records why (both directions)", () => {
    const findings = [];
    const hits = new Map(EXEMPT.map(e => [e, 0]));
    let calls = 0, candidates = 0, excluded = 0;
    for (const file of SCANNED()) {
      const src = source(file);
      calls += prepareCalls(src).length;
      const r = judge(file, src, EXEMPT);
      findings.push(...r.findings);
      candidates += r.candidates.length;
      excluded += r.candidates.filter(c => excludesQualifying(c.sql)).length;
      for (const [e, n] of r.hits) hits.set(e, hits.get(e) + n);
    }
    expect(findings, findings.join("\n")).toEqual([]);
    const stale = EXEMPT.filter(e => hits.get(e) !== 1).map(e => `${e.file} "${e.marker}" matches ${hits.get(e)} counting queries, not 1`);
    expect(stale, stale.join("\n")).toEqual([]);
    for (const e of EXEMPT) expect(e.why.length, `${e.file} "${e.marker}": the exemption states its reason`).toBeGreaterThanOrEqual(40);
    // Anti-vacuity: the tree was read, counting SQL was found, and most of it
    // excludes the quick questions (a lexer derailed by a regex or a renamed
    // helper would find a handful, or none).
    expect(SCANNED().length).toBeGreaterThan(60);
    expect(calls, "every .prepare( call in the scanned files").toBeGreaterThan(1000);
    expect(candidates, "counting queries found (16 when this was written)").toBeGreaterThanOrEqual(14);
    expect(excluded, "counting queries that exclude the quick questions (10 when this was written)").toBeGreaterThanOrEqual(9);
  });
});
