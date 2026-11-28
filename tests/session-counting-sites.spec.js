// @ts-check
//
// EVERY SITE THAT COUNTS AN EVENT'S QUESTIONS FOR A PARTICIPANT READS THEIR OWN
// SESSION'S SET (per-session question sets, owner decision 27 Nov 2026).
//
// A Competition's question is in every session unless it is narrowed to chosen
// ones (`competition_task_sessions`, lib/session-tasks.js), and a participant
// finishes, and is measured against, the questions of their own session only.
// So every SQL that counts an event's questions or a participant's solves toward
// FINISHING (the all-solved end's denominator and numerator, the board's finish
// time and percentage maximum, the submit's fast path, the Overview's "solved
// every question") must carry `${inSessionSql(...)}`. One site without it lets a
// question of another session hold a participant back from finishing, or end a
// session before its own participants are done. Modelled on the qualifying
// scanner (tests/qualifying-counting-sites.spec.js), whose detectors this shares
// (tests/counting-sites-scan.js), two ways:
//
//   * NAMED SITES, each with how many of its queries read `tasks`; every one of
//     those must narrow to the participant's session. A site renamed, losing a
//     query or gaining one fails by name.
//   * DISCOVERY: every counting-shaped `.prepare(` in server.js, db.js, lib/ and
//     routes/ narrows to the session or is EXEMPT with its reason (most: a kind
//     that never runs sessions). An EXEMPT entry must match exactly one call.
//
// Comments are blanked first (tests/html-sink-scan.js `stripComments`), so a
// comment quoting the helper inside a call satisfies nothing (planted control).
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { stripComments } = require("./html-sink-scan");
const { prepareCalls, tasksAliases, countsChallenges } = require("./counting-sites-scan");

const ROOT = path.join(__dirname, "..");

/** Does the SQL narrow to a session? (the helper interpolated, not quoted in a comment) */
const narrowsToSession = (sql) => /\$\{\s*inSessionSql\(/.test(sql);

const SITES = [
  { file: "lib/competitions.js", anchor: "function publishedTaskCount(", queries: 1, what: "the denominator of \"finished every question\", per session" },
  { file: "lib/attempts.js", anchor: "function participantsFinishedAllDetail(", queries: 2, what: "finished (solved or out of attempts): each participant's own set" },
  { file: "lib/leaderboard.js", anchor: "const totalRows = db.prepare(", queries: 1, what: "the board's finish denominator and percentage maximum, per participant" },
  { file: "lib/leaderboard.js", anchor: "const solvedRows = db.prepare(", queries: 1, what: "the board's finish time" },
  { file: "server.js", anchor: "const mineSolved = db.prepare(", queries: 1, what: "the submit's fast path ahead of the all-solved scan" },
  { file: "routes/event-overview.js", anchor: "const finished = visible ? (db.prepare(", queries: 1, what: "the Overview pulse's \"solved every question\"" },
  { file: "lib/marketing-analytics.js", anchor: "const finished = visible ? db.prepare(", queries: 1, what: "the platform's \"solved every question\" per event" },
  { file: "routes/participant.js", anchor: "  const tasks = db.prepare(\n    `SELECT t.id, t.title, t.description", queries: 1, what: "the participant's question list (GET /api/tasks)" },
];

// Counting-shaped SQL that is right WITHOUT the session narrowing, each with its reason.
const EXEMPT = [
  { file: "lib/competitions.js", marker: "SELECT COUNT(DISTINCT s.task_id) AS c\n       FROM submissions s\n       JOIN competition_tasks ct ON ct.task_id = s.task_id AND ct.competition_id = ?\n       JOIN tasks t ON t.id = s.task_id\n      WHERE s.user_id = ? AND s.competition_id = ? AND s.is_correct = 1\n        AND t.active = 1 AND t.status = 'published' AND ${notQualifyingSql(\"t\")}`",
    why: "participantSolvedAll: a Program's completion, and a Program never runs sessions (POLICY sessions: forbidden)" },
  { file: "lib/competitions.js", marker: "s.submitted_at <= ?",
    why: "lateEntryStateFor: late entry is for a Booth Event only, which never runs sessions" },
  { file: "lib/program-grade.js", marker: "SELECT t.difficulty FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id",
    why: "a Program's maximum points (its grade), and a Program never runs sessions" },
  { file: "server.js", marker: "t.attempt_cap IS NOT NULL LIMIT 1",
    why: "an existence gate for the capped path, not a count; the predicate it calls (participantsFinishedAll) narrows to each participant's session itself" },
  { file: "lib/qualifying.js", marker: "SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id\n      WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${qualifyingSql(\"t\")}",
    why: "qualifyingAnsweredAll's count of the Quick questions asked: a Quick question is in every session (it cannot be narrowed: task_sessions_qualifying)" },
  { file: "lib/qualifying.js", marker: "GROUP BY s.user_id HAVING COUNT(DISTINCT s.task_id) >= ?",
    why: "qualifyingAnsweredAll's count of those answered: the Quick questions, which every session asks, so every participant is measured against the same set" },
  { file: "lib/marketing-analytics.js", marker: "SELECT COUNT(*) AS n FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id",
    why: "the platform figures' guard that the event shows any scoring question at all (the union of every session's set); each person's \"finished\" beside it narrows to their session" },
  { file: "lib/event-team.js", marker: "tt.tag LIKE 'qualifying:%'",
    why: "selects ONLY the qualifying questions for the lead reports; a Quick question is in every session (it cannot be narrowed: task_sessions_qualifying)" },
  { file: "lib/event-team.js", marker: "ORDER BY ct.task_number, t.title",
    why: "the lead report's per-question figures across the whole event (who played what), counted per person from their answers; nothing is measured against a set" },
];

const SCANNED = () => ["server.js", "db.js",
  ...fs.readdirSync(path.join(ROOT, "lib")).filter(f => f.endsWith(".js")).sort().map(f => `lib/${f}`),
  ...fs.readdirSync(path.join(ROOT, "routes")).filter(f => f.endsWith(".js")).sort().map(f => `routes/${f}`)];

const _src = new Map();
const source = (file) => {
  if (!_src.has(file)) _src.set(file, stripComments(fs.readFileSync(path.join(ROOT, file), "utf8")));
  return _src.get(file);
};

function siteQueries(site) {
  const src = source(site.file);
  const at = src.indexOf(site.anchor);
  if (at < 0) return `${site.file}: "${site.anchor}" is gone (renamed or moved?)`;
  if (src.indexOf(site.anchor, at + 1) >= 0) return `${site.file}: "${site.anchor}" occurs more than once`;
  let calls;
  if (site.anchor.startsWith("function ")) {
    const end = src.indexOf("\n}", at);
    calls = prepareCalls(src).filter(c => c.at > at && c.at < end);
  } else {
    calls = prepareCalls(src).filter(c => c.at >= at).slice(0, 1);
    if (!calls.length || calls[0].at > at + site.anchor.length) return `${site.file}: "${site.anchor.split("\n")[0]}" opens no .prepare( call`;
  }
  return calls.filter(c => tasksAliases(c.sql).length);
}

function judge(file, src, exempt) {
  const findings = [], candidates = [];
  const hits = new Map(exempt.map(e => [e, 0]));
  for (const c of prepareCalls(src)) {
    if (!countsChallenges(c.sql)) continue;
    candidates.push(c);
    if (narrowsToSession(c.sql)) continue;
    const e = exempt.find(x => x.file === file && c.sql.includes(x.marker));
    if (e) { hits.set(e, hits.get(e) + 1); continue; }
    findings.push(`${file}:${c.line}  counts questions without \${inSessionSql(...)}: ${c.sql.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  return { findings, candidates, hits };
}

test.describe("Per-session question sets: every counting site reads the participant's session", () => {
  test("the detector catches a planted count without the narrowing, and one quoting the helper only in a comment (anti-vacuity)", () => {
    const planted = stripComments([
      "function plantedNone(db, id) {",
      "  return db.prepare(`SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.active=1 AND t.status='published'`).get(id).c;",
      "}",
      "function plantedComment(db, id) {",
      "  return db.prepare(/* ${inSessionSql(\"ct.competition_id\", \"ct.task_id\", \"?\")} */ `SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.active=1 AND t.status='published'`).get(id).c;",
      "}",
      "function plantedRight(db, id, ts) {",
      "  return db.prepare(`SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${inSessionSql(\"ct.competition_id\", \"ct.task_id\", \"?\")}`).get(id, ts).c;",
      "}",
    ].join("\n"));
    const r = judge("planted.js", planted, []);
    expect(r.candidates.length, "three counting queries").toBe(3);
    expect(r.findings.map(f => f.split(" ")[0]), "the bare count and the comment-only one are flagged, the narrowed one is not").toEqual(["planted.js:2", "planted.js:5"]);
  });

  test("every named site still exists and narrows each of its counting queries to the participant's session", () => {
    const bad = [];
    let queries = 0;
    for (const site of SITES) {
      const q = siteQueries(site);
      if (typeof q === "string") { bad.push(q); continue; }
      if (q.length !== site.queries) bad.push(`${site.file} "${site.anchor.split("\n")[0]}": ${q.length} queries read tasks, expected ${site.queries} (${site.what})`);
      for (const c of q) {
        queries++;
        if (!narrowsToSession(c.sql)) bad.push(`${site.file}:${c.line} (${site.what}) does not narrow to the session`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(queries, "every named site's queries were found").toBe(SITES.reduce((n, s) => n + s.queries, 0));
  });

  test("discovery: every other counting query in the tree narrows to the session or is exempt with its reason; no exemption is stale", () => {
    const findings = [];
    const hits = new Map(EXEMPT.map(e => [e, 0]));
    let candidates = 0, narrowed = 0;
    for (const file of SCANNED()) {
      const r = judge(file, source(file), EXEMPT);
      findings.push(...r.findings);
      candidates += r.candidates.length;
      narrowed += r.candidates.filter(c => narrowsToSession(c.sql)).length;
      for (const [e, n] of r.hits) hits.set(e, hits.get(e) + n);
    }
    expect(findings, findings.join("\n")).toEqual([]);
    const stale = EXEMPT.filter(e => hits.get(e) !== 1).map(e => `${e.file} "${e.marker.split("\n")[0]}" matches ${hits.get(e)} counting queries, not 1`);
    expect(stale, stale.join("\n")).toEqual([]);
    for (const e of EXEMPT) expect(e.why.length, "each exemption states its reason").toBeGreaterThanOrEqual(40);
    expect(candidates, "counting queries found").toBeGreaterThanOrEqual(12);
    expect(narrowed, "counting queries narrowed to the session").toBeGreaterThanOrEqual(6);
  });
});
