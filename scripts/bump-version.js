#!/usr/bin/env node
// Single source of truth: version.json. This script bumps the version there
// and mirrors it to package.json, docker-compose.yml's image tag and
// swagger.yaml's info.version so they never drift.
//
// Usage:
//   node scripts/bump-version.js patch   → 5.4.3 → 5.4.4
//   node scripts/bump-version.js minor   → 5.4.3 → 5.5.0
//   node scripts/bump-version.js major   → 5.4.3 → 6.0.0
//   node scripts/bump-version.js 5.9.0   → explicit
//
// Does NOT git-commit — caller is expected to review the diff first.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const versionFile = path.join(root, "version.json");
const packageFile = path.join(root, "package.json");
const composeFile = path.join(root, "docker-compose.yml");
const swaggerFile = path.join(root, "swagger.yaml");

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/bump-version.js <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

const current = JSON.parse(fs.readFileSync(versionFile, "utf8")).version;
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [maj, min, pat] = current.split(".").map(Number);
  if (arg === "major") next = `${maj + 1}.0.0`;
  else if (arg === "minor") next = `${maj}.${min + 1}.0`;
  else if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
  else {
    console.error(`Unknown level "${arg}" — expected patch/minor/major or X.Y.Z`);
    process.exit(1);
  }
}

console.log(`Bumping ${current} → ${next}`);

fs.writeFileSync(versionFile, `{ "version": "${next}" }\n`);

const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
pkg.version = next;
fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");

const compose = fs.readFileSync(composeFile, "utf8");
const re = /^(\s*image:\s*hackarena:)\S+(\s*)$/m;
if (!re.test(compose)) {
  console.error(`docker-compose.yml does not contain the expected "image: hackarena:<version>" line`);
  process.exit(1);
}
fs.writeFileSync(composeFile, compose.replace(re, `$1${next}$2`));

// v6.20.x — keep the OpenAPI spec's info.version in lockstep too. Pre-fix it
// drifted every release (was 7 minors behind) because it wasn't in the rotation.
// Best-effort: only rewrite if the expected `  version: X.Y.Z` line exists.
try {
  const swagger = fs.readFileSync(swaggerFile, "utf8");
  const swRe = /^(\s*version:\s*)\d+\.\d+\.\d+(\s*)$/m;
  if (swRe.test(swagger)) {
    fs.writeFileSync(swaggerFile, swagger.replace(swRe, `$1${next}$2`));
    console.log("Updated: version.json, package.json, docker-compose.yml, swagger.yaml");
  } else {
    console.log("Updated: version.json, package.json, docker-compose.yml (swagger.yaml version line not found — skipped)");
  }
} catch {
  console.log("Updated: version.json, package.json, docker-compose.yml (swagger.yaml unreadable — skipped)");
}
console.log("Review with `git diff`, then commit.");
