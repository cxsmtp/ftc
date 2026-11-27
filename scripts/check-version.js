#!/usr/bin/env node
// Fails if version.json, package.json, docker-compose.yml, and swagger.yaml disagree.
// Intended for pre-commit hooks / CI — cheap insurance against version drift
// if someone hand-edits one file instead of running scripts/bump-version.js.
//
// ─────────────────────────────────────────────────────────────────────────────
// package-lock.json IS DELIBERATELY NOT IN THIS SET, AND THIS IS THE ONLY PLACE
// A READER WILL LOOK. (v8.3.20, after an external audit re-filed it.)
//
// The lockfile carries the package's own version in two places
// (`.version` and `.packages[""].version`), and nothing here keeps them current:
// they move only when a command that rewrites the lockfile (`npm install`,
// `npm update`) resyncs both to package.json as a side effect. So they lag
// between dependency changes — as of
// v8.3.19 they read 8.3.11, 62 releases stale; v8.13.4's dependency bump resynced
// them to 8.13.4, and they will fall behind again from the next release. The lag
// is REAL and it is COSMETIC, proven rather than argued: `npm ci` succeeds against
// the mismatch (measured directly), nothing at runtime reads the field, and the
// shipped image never consults it.
//
// Syncing it is NOT free. ci/Dockerfile.cross-browser bakes a sha256 of the
// WHOLE package-lock.json into the pre-built CI image, and every workflow job that
// uses it (three since v8.8.19 — count the `image:` lines, not this sentence)
// fails closed when the checked-out file does not match. So adding the lockfile
// to the bump set would force a CI image rebuild and a digest re-pin on every line
// EVERY RELEASE — measured: rewriting only those two version strings changes the
// file hash. Trading a real per-release operational cost for a field nothing
// reads is the wrong way round.
//
// THE DURABLE FIX, if this is ever worth doing: bake and compare a hash of the
// lockfile's DEPENDENCY-BEARING content only (strip the two version fields), so
// version churn stops invalidating the image. That is one image rebuild once,
// after which the lockfile can join the bump set for free. It is its own change
// — it touches ci/Dockerfile.cross-browser AND the three workflow drift guards
// (one per job that pins the image; count the `image:` lines, not this
// sentence), all four of which must move together or CI fails on a correct tree.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const v = JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8")).version;
const p = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const composeMatch = fs
  .readFileSync(path.join(root, "docker-compose.yml"), "utf8")
  .match(/^\s*image:\s*hackarena:(\S+)\s*$/m);
const c = composeMatch ? composeMatch[1] : null;
// v6.20.x — swagger.yaml info.version joined the bump rotation; verify it too.
const swSrc = fs.readFileSync(path.join(root, "swagger.yaml"), "utf8");
// v7.21.32 — match ALL of them, not the first. swagger.yaml carried a SECOND
// `version:` line under info for 24 releases; a YAML parser takes the last
// duplicate key, so the published spec reported 7.21.8 while the bump script
// dutifully updated the line above it and this check — anchored on the first
// match — agreed every time. A duplicate is now a hard failure.
const swAll = [...swSrc.matchAll(/^\s{2}version:\s*(\d+\.\d+\.\d+)\s*$/gm)].map(m => m[1]);
if (swAll.length > 1) {
  console.error(`swagger.yaml has ${swAll.length} info.version lines (${swAll.join(", ")}).`);
  console.error("A YAML parser keeps the LAST duplicate key, so the published spec would report the wrong version.");
  process.exit(1);
}
const s = swAll.length ? swAll[0] : null;

if (v === p && v === c && v === s) {
  console.log(`Versions agree: ${v}`);
  process.exit(0);
}

console.error("Version drift detected:");
console.error(`  version.json       : ${v}`);
console.error(`  package.json       : ${p}`);
console.error(`  docker-compose.yml : ${c}`);
console.error(`  swagger.yaml       : ${s}`);
console.error("\nRun `node scripts/bump-version.js <level>` to resync.");
process.exit(1);
