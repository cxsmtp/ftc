#!/usr/bin/env node
// Order-dependence detector.
//
// v7.20.0 killed cross-FILE contamination structurally: tests/isolated-test.js
// replaces the worker's server — fresh process, wiped data dir, fresh seed —
// before every spec file. What it cannot address is WITHIN-file order
// dependence: `fullyParallel:false` runs a file's tests serially against one
// database, so test #40 may only pass because tests #1-39 ran first.
//
// That class is invisible in a normal run (the order is always the same) and
// shows up later as a "flake" when timing, pagination or accumulated rows shift
// — the failure names a selector, never the cause.
//
// This script runs EACH test on its own, in a pristine database, and reports
// the ones that only pass with company. A test listed here is either
// order-dependent (fix it: register its own fixtures — see the fixture
// checklist in CLAUDE.md) or genuinely requires a predecessor, in which case it
// should say so in its own body rather than by accident of file order.
//
// Usage:
//   node scripts/test-independence.cjs                      # every spec file
//   node scripts/test-independence.cjs tests/ui-admin-tasks.spec.js [more...]
//   LIMIT=20 node scripts/test-independence.cjs tests/x.spec.js   # first N tests
//
// Concurrency: SHARDS parallel workers, each pinned to its own TEST_PORT_BASE.
// That is safe as of v7.21.35, which made the data directory FOLLOW the port
// base — before it, two concurrent invocations both claimed data-test-0 and
// global-setup rm -rf'd it underneath the other, presenting as
// "Login failed for superadmin: 401". Each shard therefore owns a disjoint
// port range AND a disjoint data directory.
//
// Default is cores/2 because every shard runs a server + a browser; the sweep
// is bounded by that pair, not by the runner.

const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PW = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");

function specFiles(argv) {
  if (argv.length) return argv;
  return fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((f) => f.endsWith(".spec.js") && !f.startsWith("_"))
    .map((f) => `tests/${f}`);
}

// Titles come from playwright's own list output, so a renamed or skipped test
// can never silently drop out of the sweep.
function listTests(file) {
  const out = execFileSync(process.execPath, [PW, "test", file, "--list", "--reporter=json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CROSS_BROWSER: "" },
  });
  const json = JSON.parse(out);
  const titles = [];
  const walk = (suite) => {
    for (const s of suite.suites || []) walk(s);
    for (const spec of suite.specs || []) titles.push(spec.title);
  };
  for (const s of json.suites || []) walk(s);
  return titles;
}

// -g takes a regex matched against the FULL title — describe blocks included,
// joined with " › ". So it can only be anchored at the END: a leading `^`
// matches nothing for any test inside a describe, which silently turns the
// whole sweep into "no tests found" and reports every test as broken. The
// trailing `$` is what stops a title that is a prefix of another from dragging
// its sibling into the same run.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each shard gets a 40-port window: --workers=1 uses one port, but the window
// keeps the namespaced data directories unambiguous and leaves room if the
// per-run worker count ever rises.
// v8.3.26 — STRIDE 200, NOT 40, AND THE SPAWNER OFFSETS ARE WHY.
//
// Each shard pins its own TEST_PORT_BASE, which scopes BOTH its server ports and
// its data directories (v7.21.35). A stride of 40 was sized for worker slots
// alone — but fourteen spec files spawn their own server at `PORT_BASE + <off>`
// with offsets up to 161, so shard N's spawner ports landed inside shard N+3's
// window. Concretely: shard 0's `+120` is 4820, and 4820 is shard 3's worker
// slot 0. Two shards then shared a port AND, through it, a data directory —
// which is the one thing this sweep exists to rule out.
//
// 200 clears the highest registered offset (161) plus a full worker range with
// room to spare; the scanner in functional-core-b keeps the two in step.
//
// From 4700 upwards, a shard's base skips any window holding a port fetch()
// refuses (tests/server-env.js FETCH_BLOCKED_PORTS): 4900's holds 5060 and 5061
// (offsets 160 and 161), so its tests failed alone only because their server
// could not be reached.
const PORT_STRIDE = 200;
const { cleanPortBases } = require("../tests/server-env");
const portBaseFor = (shard) => cleanPortBases(4700, PORT_STRIDE, shard + 1)[shard];

function runAlone(file, title, shard) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PW, "test", file, "-g", escapeRe(title) + "$", "--reporter=line", "--retries=0", "--workers=1"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, TEST_PORT_BASE: String(portBaseFor(shard)) },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const out = `${stdout || ""}\n${stderr || ""}`;
        // A title that matches nothing is a bug in this script, not a finding —
        // report it as such rather than as an order-dependent test.
        if (/No tests found/i.test(out)) return resolve({ ok: false, reason: "NO-MATCH (detector bug)", out });
        const line = (out.match(/^\s*(?:Error|\d+\) ).*$/m) || [""])[0].trim();
        resolve({ ok: false, reason: line || "failed", out });
      },
    );
  });
}

async function main() {
  const files = specFiles(process.argv.slice(2));
  const LIMIT = Number(process.env.LIMIT || 0);
  const SHARDS = Math.max(1, Number(process.env.SHARDS || Math.max(1, Math.floor(require("os").cpus().length / 2))));
  const failures = [];

  // Build the whole work list first so the shards stay busy across file
  // boundaries — otherwise a file with 12 tests would idle 6 shards.
  const work = [];
  for (const file of files) {
    let titles;
    try {
      titles = listTests(file);
    } catch (e) {
      console.log(`!! could not list ${file}: ${e.message.split("\n")[0]}`);
      continue;
    }
    if (LIMIT) titles = titles.slice(0, LIMIT);
    console.log(`  ${file}: ${titles.length} tests`);
    for (const t of titles) work.push({ file, title: t });
  }

  console.log(`\nrunning ${work.length} test(s) one-at-a-time across ${SHARDS} shard(s)…`);
  const started = Date.now();
  let next = 0;
  let done = 0;

  const shard = async (id) => {
    for (;;) {
      const i = next++;
      if (i >= work.length) return;
      const { file, title } = work[i];
      const r = await runAlone(file, title, id);
      done++;
      if (r.ok) process.stdout.write(".");
      else {
        process.stdout.write("F");
        failures.push({ file, title, reason: r.reason });
      }
      if (done % 80 === 0) process.stdout.write(` ${done}/${work.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: SHARDS }, (_, i) => shard(i)));

  // RE-CHECK EVERY FAILURE SERIALLY BEFORE REPORTING IT. Measured on the first
  // real sweep: 6 shards on 12 cores produced 35 "failures" of which 21 — SIXTY
  // PERCENT — passed the moment they were re-run unloaded. They were timeouts
  // under contention, not order dependence.
  //
  // Reporting those would have been worse than not running the sweep at all: it
  // would have sent someone to "fix" 21 working tests, and the next person to
  // hit a false positive silences the tool. A detector that cries wolf is not a
  // conservative detector, it is a broken one.
  if (failures.length) {
    process.stdout.write(`\n\nre-checking ${failures.length} failure(s) serially to rule out contention…\n`);
    const confirmed = [];
    for (const f of failures) {
      const r = await runAlone(f.file, f.title, 0);
      if (!r.ok) { confirmed.push(f); process.stdout.write("X"); }
      else process.stdout.write("o");
    }
    const spurious = failures.length - confirmed.length;
    failures.length = 0;
    failures.push(...confirmed);
    process.stdout.write(`\n  ${confirmed.length} confirmed, ${spurious} spurious (passed unloaded)\n`);
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n\n================ ORDER-DEPENDENCE REPORT ================`);
  console.log(`checked ${done} test(s) in isolation across ${SHARDS} shard(s) in ${mins} min; ${failures.length} failed alone\n`);
  for (const f of failures) console.log(`  ${f.file}\n    ${f.title}\n    → ${f.reason}\n`);
  if (!failures.length) console.log("  every test passes on its own — no order dependence found.");
  process.exit(failures.length ? 1 : 0);
}

main();
