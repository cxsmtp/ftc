// A process that stops on a failure says why, in production too.
//
// A FATAL at boot (no SMTP_HOST, an https BASE_URL with trust proxy off, a
// failed guarded migration) logs and calls process.exit(1) in the same tick.
// lib/log.js writes its files asynchronously and opens them asynchronously, so
// that line was still waiting when the process ended and was lost; and in
// production nothing is mirrored to the console, so the process stopped with an
// empty stdout, an empty stderr and an empty app log. Found while diagnosing
// the graceful-shutdown test's CI failure, whose child printed nothing.
//
// The exit hook in lib/log.js now (1) appends a line still waiting for its file
// synchronously, and (2) on a NON-ZERO exit with the mirror off, replays the
// last minute's error lines to stderr, which is what `docker logs` shows. A
// clean exit stays quiet, and with the mirror on nothing is printed twice.
//
// Each arm runs a CHILD node process with its own scratch DATA_DIR and
// UPLOADS_DIR; nothing here is required into the Playwright worker.
const { test, expect } = require("./isolated-test");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG_MODULE = path.join(ROOT, "lib", "log.js");
const EMAIL_MODULE = path.join(ROOT, "lib", "email.js");
const MARKER = `fatal-exit-probe-${Date.now().toString(36)}`;

/** Run `script` in a child with a production environment built from scratch. */
function runChild(script, args, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fatal-exit-"));
  try {
    const r = spawnSync(process.execPath, ["-e", script, ...args], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || dataDir,
        NODE_ENV: "production",
        NODE_OPTIONS: "",
        BASE_URL: "http://localhost:9",
        DATA_DIR: dataDir,
        UPLOADS_DIR: path.join(dataDir, "uploads"),
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    let appLog = "";
    const logDir = path.join(dataDir, "logs");
    if (fs.existsSync(logDir)) {
      for (const f of fs.readdirSync(logDir).filter(n => n.startsWith("app-"))) appLog += fs.readFileSync(path.join(logDir, f), "utf8");
    }
    return { status: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "", appLog, logDirExists: fs.existsSync(logDir) };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const ctx = (r) => `status=${r.status} signal=${r.signal}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}\nAPP LOG:\n${r.appLog}`;

test("a FATAL at boot reaches stderr and the app log in production (no SMTP_HOST)", () => {
  // The real FATAL site: lib/email.js refuses to load without SMTP_HOST.
  const r = runChild("require(process.argv[1]);", [EMAIL_MODULE]);
  expect(r.status, `the module must refuse to load: ${ctx(r)}`).toBe(1);
  expect(r.logDirExists, `anti-vacuity: the logger opened its directory: ${ctx(r)}`).toBe(true);
  expect(r.stderr, `stderr says why the process stopped: ${ctx(r)}`).toMatch(/FATAL: SMTP_HOST environment variable is required/);
  expect(r.appLog, `the app log has the line too: ${ctx(r)}`).toMatch(/FATAL: SMTP_HOST environment variable is required/);
});

test("a crash after the log file opened replays its error to stderr on a non-zero exit", () => {
  const r = runChild(
    "require(process.argv[1]); setTimeout(() => { console.error(process.argv[2]); setTimeout(() => process.exit(1), 300); }, 300);",
    [LOG_MODULE, MARKER]);
  expect(r.status, ctx(r)).toBe(1);
  expect(r.appLog, `CONTROL: the line was written to the file before the exit: ${ctx(r)}`).toContain(MARKER);
  expect(r.stderr, `…and the exit replayed it to stderr: ${ctx(r)}`).toContain(MARKER);
});

test("a clean exit stays quiet, and with the mirror on nothing is printed twice", () => {
  const clean = runChild(
    "require(process.argv[1]); console.error(process.argv[2]); setTimeout(() => process.exit(0), 300);",
    [LOG_MODULE, MARKER]);
  expect(clean.status, ctx(clean)).toBe(0);
  expect(clean.appLog, `anti-vacuity: the error was logged: ${ctx(clean)}`).toContain(MARKER);
  expect(clean.stderr, `production prints nothing on a clean exit: ${ctx(clean)}`).toBe("");

  const mirrored = runChild(
    "require(process.argv[1]); console.error(process.argv[2]); setTimeout(() => process.exit(1), 300);",
    [LOG_MODULE, MARKER], { LOG_CONSOLE_MIRROR: "1" });
  expect(mirrored.status, ctx(mirrored)).toBe(1);
  expect(mirrored.stderr.split(MARKER).length - 1, `printed once by the mirror, never replayed again: ${ctx(mirrored)}`).toBe(1);
});
