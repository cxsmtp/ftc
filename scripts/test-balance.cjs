#!/usr/bin/env node
// Suite-balance check — MEASURE the distribution, never assume it.
//
// A spec file never spans workers, so the suite's wall clock is bounded below by
// its LONGEST FILE. That is not a tuning detail: at v7.21.34 `ui-admin.spec.js`
// was 181 s of a 248 s suite — 73 % of the wall clock pinned in one worker — and
// doubling the pool to WORKERS=16 bought 5.8 %, because no worker count can
// shorten a serial file. Splitting it into five ~36 s files took the suite to
// 204 s. The lever is balance, not parallelism.
//
// So this exists to stop that re-accumulating one test at a time. Run it after
// adding tests:
//
//   node scripts/test-balance.cjs                 # runs the suite, reports
//   node scripts/test-balance.cjs /tmp/run.json   # re-use an existing report
//   node scripts/test-balance.cjs --write [report] # also rewrite tests/file-timings.json
//
// v8.12.4 — it also reports the PER-WORKER finish times, which is the number the
// operator actually feels, and it owns `tests/file-timings.json`: the per-file
// wall-time manifest playwright.config.js reads to schedule the longest files
// FIRST (see the LONGEST FILES FIRST note there). `--write` regenerates it from
// the run just measured; without `--write` the script only says whether the
// manifest is stale (files missing from it, or entries for deleted files).
//
// Exit code is 1 when a file exceeds the budget, so it can gate CI later.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PW = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");

// The budget is DERIVED, not a magic number: with W workers, a perfectly packed
// suite finishes in total/W, so any single file longer than that is the binding
// constraint. The 1.5x allowance keeps the check from firing on ordinary
// lumpiness — it is meant to catch a file drifting back toward dominance, not to
// demand a perfect packing nobody can maintain.
const WORKERS = Number(process.env.WORKERS || 24);   // must match playwright.config.js
const SLACK = Number(process.env.BALANCE_SLACK || 1.5);

const WRITE = process.argv.includes("--write");
const TIMINGS = path.join(ROOT, "tests", "file-timings.json");
let reportPath = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!reportPath) {
  // v8.3.26 — under the repo, not /tmp. The run below crashed with a bare ENOENT
  // stack because the report was not where this expected it, and a diagnostic
  // that cannot report is not a diagnostic. `test-results/` is already
  // gitignored and is wiped per run by Playwright itself.
  reportPath = path.join(ROOT, "test-results", "test-balance-run.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  console.log(`running the suite at WORKERS=${WORKERS} to measure it…`);
  try {
    execFileSync(process.execPath, [PW, "test", `--workers=${WORKERS}`, "--reporter=json"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (_) {
    // A failing suite still produces a usable timing report; balance is a
    // separate question from correctness and should still be answerable.
    console.log("(suite reported failures — measuring the timings anyway)");
  }
}

if (!fs.existsSync(reportPath)) {
  console.error(
    `no timing report at ${reportPath}.\n` +
    "The suite ran but its JSON reporter wrote nothing — usually because the run was killed, " +
    "or because a SECOND Playwright run was in progress and global-setup refused. Re-run when " +
    "the box is quiet, or pass an existing report: node scripts/test-balance.cjs <report.json>"
  );
  process.exit(2);
}
const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const byFile = {};
const walk = (s, f) => {
  const ff = s.file || f;
  for (const spec of s.specs || []) {
    let d = 0;
    for (const t of spec.tests || []) for (const r of t.results || []) d += r.duration || 0;
    byFile[spec.file || ff] = (byFile[spec.file || ff] || 0) + d;
  }
  for (const sub of s.suites || []) walk(sub, ff);
};
for (const s of rep.suites || []) walk(s, s.file);

const rows = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
if (!rows.length) { console.error("no per-file timings in the report — wrong file?"); process.exit(2); }
const total = rows.reduce((a, [, ms]) => a + ms, 0);
const floor = total / WORKERS;
const budget = floor * SLACK;

console.log(`\ntotal test-time ${(total / 1000 / 60).toFixed(1)} min across ${rows.length} files`);
console.log(`perfect-split floor at WORKERS=${WORKERS}: ${(floor / 1000).toFixed(0)}s`);
console.log(`per-file budget (${SLACK}x floor): ${(budget / 1000).toFixed(0)}s\n`);

// Per-file WALL time (first test start -> last test end) and per-worker finish
// times. Wall, not the sum of durations: it is what the scheduler actually has
// to pack, recycle included.
const t0 = new Date(rep.stats && rep.stats.startTime || 0).getTime();
const wall = {}; const workerEnd = {};
const walk2 = (s, f) => {
  const ff = s.file || f;
  for (const spec of s.specs || []) {
    const key = spec.file || ff;
    for (const t of spec.tests || []) for (const r of t.results || []) {
      const st = new Date(r.startTime).getTime() - t0; const en = st + (r.duration || 0);
      const w = (wall[key] ||= { s: Infinity, e: 0 }); w.s = Math.min(w.s, st); w.e = Math.max(w.e, en);
      workerEnd[r.parallelIndex] = Math.max(workerEnd[r.parallelIndex] || 0, en);
    }
  }
  for (const sub of s.suites || []) walk2(sub, ff);
};
for (const s of rep.suites || []) walk2(s, s.file);
const ends = Object.values(workerEnd);
if (ends.length) {
  const lo = Math.min(...ends) / 1000, hi = Math.max(...ends) / 1000;
  console.log(`\nworker finish times: first ${lo.toFixed(0)}s, last ${hi.toFixed(0)}s — spread ${(hi - lo).toFixed(0)}s across ${ends.length} workers`);
}

const specFiles = fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".spec.js") && !f.startsWith("_"));
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(TIMINGS, "utf8")).files || {}; } catch (_e) { /* no timings file yet, or unreadable: start from an empty manifest */ manifest = {}; }
const missing = specFiles.filter((f) => !(f in manifest));
const stale = Object.keys(manifest).filter((f) => !specFiles.includes(f));
if (WRITE) {
  const files = {};
  for (const f of Object.keys(wall).sort()) files[f] = Math.round((wall[f].e - wall[f].s) / 100) / 10;
  fs.writeFileSync(TIMINGS, JSON.stringify({
    note: "Per-file wall seconds, read by playwright.config.js to schedule the longest spec files first. Regenerate with `npm run test:balance -- --write` after adding, removing or substantially changing tests.",
    measured_at_workers: WORKERS,
    files,
  }, null, 1) + "\n");
  console.log(`\nwrote ${Object.keys(files).length} per-file timings to tests/file-timings.json`);
} else if (missing.length || stale.length) {
  console.log(`\ntests/file-timings.json is STALE — ${missing.length} spec file(s) missing from it${missing.length ? " (" + missing.slice(0, 8).join(", ") + (missing.length > 8 ? ", …" : "") + ")" : ""}, ${stale.length} entr${stale.length === 1 ? "y" : "ies"} for deleted files.`);
  console.log(`Unknown files are scheduled FIRST, so nothing breaks — but regenerate it: npm run test:balance -- --write`);
}

const over = rows.filter(([, ms]) => ms > budget);
for (const [f, ms] of rows.slice(0, 10)) {
  console.log(`  ${(ms / 1000).toFixed(0).padStart(4)}s  ${ms > budget ? "OVER  " : "      "}${f}`);
}

if (over.length) {
  console.log(`\n${over.length} file(s) exceed the budget and now bound the suite's wall clock:`);
  for (const [f, ms] of over) console.log(`  ${f} — ${(ms / 1000).toFixed(0)}s`);
  console.log(`\nSplit by top-level describe block, keeping shared helpers in ONE module`);
  console.log(`(see tests/ui-admin-helpers.js and CLAUDE.md *Workers, retries, scheduling*).`);
  process.exit(1);
}
console.log("\nbalanced — no file exceeds the budget.");
