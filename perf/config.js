// Shared configuration for seed script and k6 tests
const fs = require("fs");
const path = require("path");

function readSuperadminPass() {
  // v8.8.27 — no fallback. This only READS `.superadmin-password`, so it never
  // wrote anywhere it should not have — but a perf run with no DATA_DIR read the
  // LIVE deployment's credential file, which is its own kind of wrong. The perf
  // runner has always passed DATA_DIR to both the server and the seed
  // (`perf/run-local.sh`), so this costs a correct run nothing.
  const { requireDataDir } = require("../lib/data-dir");
  const dataDir = requireDataDir();
  try { return fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim(); } catch (_) { return ""; }
}

module.exports = {
  // Override via CLI args or env vars
  BASE_URL: process.env.BASE_URL || "https://localhost:3000",
  get SUPERADMIN_PASSWORD() { return readSuperadminPass(); },
  PARTICIPANT_EMAIL_DOMAIN: "acme.com",
  PARTICIPANT_PREFIX: "perf-user-",

  // Defaults — override via CLI
  PARTICIPANT_COUNT: 20,
  TASK_COUNT: 10,
  COMPETITION_START_OFFSET_S: 120, // seconds from now
  COMPETITION_DURATION_MIN: 10,

  // Background data — simulates production DB size
  BG_USERS: 5000,
  BG_TASKS: 300,
};
