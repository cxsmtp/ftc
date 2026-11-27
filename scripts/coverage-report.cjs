#!/usr/bin/env node
// v8.12.4 — turn a coverage-mode run (HACKARENA_COVERAGE, see tests/isolated-test.js)
// into the question the suite is maintained against: WHICH code does no test execute?
//
//   npm run test:coverage                  # runs the suite in coverage mode, then this
//   node scripts/coverage-report.cjs [dir] # re-report an existing run (default .coverage)
//
// Server side is V8's own block coverage (NODE_V8_COVERAGE), client side is
// Chromium's (page.coverage). Both are merged by OR over byte maps — see
// tests/coverage-util.js for why that is the correct merge. The output is a
// DIRECTORY OF LEADS, not a score: an unexecuted branch may be dead code, a
// deliberate defence in depth, or a real gap, and only reading it says which.
"use strict";
const fs = require("fs"), path = require("path");
const { paintScript, orInto } = require("../tests/coverage-util");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.resolve(process.argv[2] || path.join(ROOT, ".coverage"));
const maps = new Map(); // repo-relative file -> Uint8Array

// ── server ─────────────────────────────────────────────────────────────────
// `server` = the spawned test servers; `worker` = the Playwright workers
// themselves, which is where a spec that unit-tests a pure lib/ module at column
// 0 runs it. Without the second, those modules read as untested.
let dumps = 0;
const dumpFiles = ["server", "worker"].flatMap((d) => {
  const p = path.join(DIR, d);
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith(".json")).map((f) => path.join(p, f)) : [];
});
for (const file of dumpFiles) {
  let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { continue; }
  dumps++;
  for (const s of j.result || []) {
    if (!s.url.startsWith("file://")) continue;
    const abs = decodeURIComponent(new URL(s.url).pathname);
    const rel = path.relative(ROOT, abs);
    if (rel.startsWith("..") || rel.includes("node_modules") || rel.startsWith("tests")) continue;
    if (!/^(server\.js|db\.js|routes\/|lib\/)/.test(rel)) continue;
    const len = fs.statSync(abs).size; // source is read as bytes; offsets are UTF-16 but these files are ASCII-dominant
    maps.set(rel, orInto(maps.get(rel), paintScript(s.functions, fs.readFileSync(abs, "utf8").length || len)));
  }
}
// ── client ─────────────────────────────────────────────────────────────────
const cdir = path.join(DIR, "client");
let workers = 0;
for (const f of (fs.existsSync(cdir) ? fs.readdirSync(cdir) : []).filter((f) => f.endsWith(".json"))) {
  workers++;
  const j = JSON.parse(fs.readFileSync(path.join(cdir, f), "utf8"));
  for (const [p, b64] of Object.entries(j)) {
    const rel = path.join("public", p.replace(/^\//, ""));
    maps.set(rel, orInto(maps.get(rel), new Uint8Array(Buffer.from(b64, "base64"))));
  }
}
if (!maps.size) { console.error(`no coverage data under ${DIR} — run: npm run test:coverage`); process.exit(2); }

// Every source file we expect to see, so a file NO test ever loaded is reported
// rather than silently absent.
const expected = ["server.js", "db.js",
  ...fs.readdirSync(path.join(ROOT, "routes")).map((f) => "routes/" + f),
  ...fs.readdirSync(path.join(ROOT, "lib")).map((f) => "lib/" + f),
  ...["core", "ui", "features", "data"].flatMap((d) => fs.readdirSync(path.join(ROOT, "public/js", d)).map((f) => `public/js/${d}/${f}`)),
].filter((f) => f.endsWith(".js"));

const rows = []; const lines = [];
for (const rel of expected) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const m = maps.get(rel);
  // Strip comments to a mask so a comment-only line never counts as code.
  const code = new Uint8Array(src.length);
  { let i = 0; const n = src.length; let mode = 0; // 0 code,1 line,2 block,3 str
    let q = "";
    while (i < n) { const c = src[i], d = src[i + 1];
      if (mode === 0) { if (c === "/" && d === "/") { mode = 1; i += 2; continue; } if (c === "/" && d === "*") { mode = 2; i += 2; continue; }
        if (c === '"' || c === "'" || c === "`") { mode = 3; q = c; code[i] = 1; i++; continue; }
        if (!/\s/.test(c)) code[i] = 1; i++; continue; }
      if (mode === 1) { if (c === "\n") mode = 0; i++; continue; }
      if (mode === 2) { if (c === "*" && d === "/") { mode = 0; i += 2; continue; } i++; continue; }
      if (mode === 3) { code[i] = 1; if (c === "\\") { if (i + 1 < n) code[i + 1] = 1; i += 2; continue; } if (c === q) mode = 0; i++; continue; } } }
  let total = 0, hit = 0;
  for (let i = 0; i < src.length; i++) if (code[i]) { total++; if (m && m[i]) hit++; }
  rows.push({ rel, pct: total ? (100 * hit / total) : 100, loaded: !!m, total });
  if (!m) continue;
  // Uncovered line runs.
  const L = src.split("\n"); let off = 0; let run = null;
  const flush = () => { if (run && run.n >= 3) lines.push({ rel, from: run.from, to: run.to, n: run.n, first: run.text }); run = null; };
  for (let ln = 0; ln < L.length; ln++) {
    const s = off, e = off + L[ln].length; off = e + 1;
    let any = false, cov = false;
    for (let i = s; i < e; i++) if (code[i]) { any = true; if (m[i]) { cov = true; break; } }
    if (!any) continue;                 // blank/comment: does not break a run
    if (cov) { flush(); continue; }
    if (!run) run = { from: ln + 1, to: ln + 1, n: 0, text: L[ln].trim().slice(0, 110) };
    run.to = ln + 1; run.n++;
  }
  flush();
}
// Never-called NAMED functions (declarations and `name = (…) =>` / `name(…) {`).
const never = [];
for (const rel of expected) {
  const m = maps.get(rel); if (!m) continue;
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const x of src.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const at = x.index + x[0].length - 1;
    if (!m[at]) never.push({ rel, name: x[1], line: src.slice(0, x.index).split("\n").length });
  }
}
rows.sort((a, b) => a.pct - b.pct);
lines.sort((a, b) => b.n - a.n);
const out = [];
out.push(`# Coverage report\n\n${dumps} V8 dumps (servers + workers), ${workers} client worker files.\n`);
out.push(`## Per file (code bytes executed by at least one test)\n`);
for (const r of rows) out.push(`- ${r.pct.toFixed(1).padStart(5)}%  ${r.rel}${r.loaded ? "" : "  — NEVER LOADED by any test"}`);
out.push(`\n## Named functions no test ever calls (${never.length})\n`);
for (const n of never) out.push(`- ${n.rel}:${n.line}  ${n.name}`);
out.push(`\n## Largest never-executed blocks (>= 3 code lines; top 400)\n`);
for (const l of lines.slice(0, 400)) out.push(`- ${l.rel}:${l.from}-${l.to} (${l.n} lines)  ${l.first}`);
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, "report.md"), out.join("\n") + "\n");
fs.writeFileSync(path.join(DIR, "report.json"), JSON.stringify({ rows, never, blocks: lines }, null, 1));
console.log(`wrote ${path.relative(ROOT, path.join(DIR, "report.md"))} — ${rows.length} files, ${never.length} never-called functions, ${lines.length} uncovered blocks`);
