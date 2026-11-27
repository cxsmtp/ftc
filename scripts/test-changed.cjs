#!/usr/bin/env node
/**
 * v7.16.2 — run ONLY the spec files this branch changed, the way CI runs them.
 *
 * WHY
 * ───
 * v7.16.0 passed 1482 locally and failed six tests in CI. One of those was a
 * genuine new bug that local could never have caught, because it only appears
 * on a RETRY: the trusted-network test used a fixed IP address, and
 * competitionAllowlistMatch returns the FIRST competition whose window covers
 * `now`, so the retry matched the competition the first attempt had left
 * behind. Local runs default to RETRIES=0, CI uses RETRIES=1 — the bug lived
 * exactly in that gap.
 *
 * Running the whole suite with retries would cost minutes and mask real
 * failures. Running only the files you TOUCHED, twice, with retries on, costs
 * seconds and covers precisely the code most likely to carry a fresh isolation
 * bug. That is the trade this script exists to make.
 *
 * It surfaces the whole family of state-leak bugs, not just retries:
 *   • --repeat-each=2  → a second pass over the same worker DB, which catches
 *                        fixtures that assume a clean database
 *   • RETRIES=1        → the CI setting, which catches the retry-collision case
 *
 * Usage:
 *   npm run test:changed              # vs origin/main
 *   npm run test:changed -- --base HEAD~3
 */
const { execSync, spawnSync } = require("child_process");

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (_) { return ""; }
}

const argv = process.argv.slice(2);
const baseIdx = argv.indexOf("--base");
let base = baseIdx >= 0 ? argv[baseIdx + 1] : "";
if (!base) {
  // Prefer the upstream default branch; fall back to local main, then to the
  // previous commit, so this still does something useful on a detached HEAD or
  // a clone with no remote.
  base = sh("git rev-parse --verify --quiet origin/main") ? "origin/main"
       : sh("git rev-parse --verify --quiet main") ? "main"
       : "HEAD~1";
}

const changed = new Set();
for (const line of [
  sh(`git diff --name-only ${base}...HEAD`),
  sh("git diff --name-only"),            // unstaged
  sh("git diff --name-only --cached"),   // staged
  sh("git ls-files --others --exclude-standard"), // brand-new, not yet added
].join("\n").split("\n")) {
  const f = line.trim();
  if (/^tests\/.*\.spec\.js$/.test(f)) changed.add(f);
}

const files = [...changed].filter(f => require("fs").existsSync(f)).sort();
if (!files.length) {
  console.log(`[test:changed] no spec files changed vs ${base} — nothing to do.`);
  process.exit(0);
}

console.log(`[test:changed] base=${base}`);
console.log(`[test:changed] ${files.length} spec file(s), run twice with retries on (the CI setting):`);
for (const f of files) console.log(`               ${f}`);
console.log("");

// A distinct port base so this can run alongside nothing else by accident —
// two Playwright invocations sharing 4567+ fight over the same servers and
// produce a wall of bogus login failures. 4300, below the default run and the
// independence shards; its window holds no port fetch() refuses (4900's held
// 5060 and 5061, so the specs binding +160 and +161 failed here only).
const env = {
  ...process.env,
  RETRIES: process.env.RETRIES || "1",
  TEST_PORT_BASE: process.env.TEST_PORT_BASE || "4300",
};
const r = spawnSync(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...files, "--repeat-each=2", "--reporter=line"],
  { stdio: "inherit", env }
);
if (r.status !== 0) {
  console.error("\n[test:changed] FAILED. A failure here that the plain suite misses is almost always");
  console.error("               a fixture that assumes a clean database, or an assertion that identifies");
  console.error("               a row by a key another attempt also used. Give the fixture a unique key.");
}
process.exit(r.status === null ? 1 : r.status);
