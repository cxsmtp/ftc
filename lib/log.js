"use strict";

// Structured logging + access log (rotating JSONL streams), sensitive-key
// redaction, disk-aware retention, and the console.* override that funnels
// legacy call sites into app.jsonl. Side effects (stream open, console
// override, retention interval) run once on require — required early at boot.
// (v7.0.0 refactor: extracted verbatim from server.js.)

const fs   = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const LOG_LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const LOG_LEVEL_NAME = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVEL_NUM = LOG_LEVELS[LOG_LEVEL_NAME] || LOG_LEVELS.info;
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, "logs");
const LOG_MIN_FREE_MB = parseInt(process.env.LOG_MIN_FREE_MB) || 500;
const LOG_MIN_FREE_PCT = parseInt(process.env.LOG_MIN_FREE_PCT) || 5;
// infra audit (#4): accept 1/true/yes (case-insensitive), matching the docs
// ("Set 1 to ...") and the rest of the codebase's boolean env convention. The
// old `=== "true"` exact-match silently ignored the documented LOG_*=1.
const _isTruthyEnv = (v) => ["1", "true", "yes"].includes(String(v || "").trim().toLowerCase());
const LOG_DISABLE_ACCESS = _isTruthyEnv(process.env.LOG_DISABLE_ACCESS);
const LOG_CONSOLE_MIRROR = process.env.LOG_CONSOLE_MIRROR !== undefined
  ? _isTruthyEnv(process.env.LOG_CONSOLE_MIRROR)
  : process.env.NODE_ENV !== "production";
// Best-effort log I/O failures are counted here, never routed through
// lib/best-effort (which writes through this module: recursion).
let _logWriteFailures = 0;
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_e) { _logWriteFailures += 1; }
const _origConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug || console.log };

// Redaction of sensitive keys in log context. Keys are matched case-insensitively.
// secondary_email is redacted (defence-in-depth) even though admins can see it
// through /api/admin/participants — log files have a wider audience surface
// (operator backups, cold storage, third-party log shippers) than the live
// admin-authenticated endpoints, and a leak there enumerates personal-mailbox
// addresses across the whole user base in one shot.
// v6.16.53 — `default_cxone_api_key` is the platform-wide CxOne secret
// stored under that exact key in the settings table (per the
// /api/admin/default-cxone PUT handler). Pre-fix the redact list only
// covered the per-competition `cxone_api_key` column; the global key
// fell through the export's exact-match check and leaked verbatim.
// v8.13.3 — `invitation_id` / `invitationId` (compared lower-cased) joined the set
// as defence in depth: an invitation id is a capability (it redeems the
// invitation), every current log and audit sink records `invitation_fp` instead,
// and tests/request-log-context.spec.js arm (e) refuses a sink that names the
// raw key. This catches the one that arrives through a context object that scan
// cannot see.
// `breakglass_username` is half the built-in account's credential: only the
// break-glass session may read it, so it never reaches a log line, an audit
// copy or the settings export (which reads this set).
const _REDACT_KEYS = new Set(["password","password_hash","breakglass_username","reset_code","verify_code","cxone_api_key","default_cxone_api_key","self_enroll_token","join_code","join_code_display","_csrf","csrf_token","secondary_email","secondaryemail","invitation_id","invitationid"]);
const _REDACT_HEADER_KEYS = new Set(["authorization","cookie","x-csrf-token","set-cookie"]);
function _redactValue(v, depth=0) {
  if (depth > 8 || v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(x => _redactValue(x, depth+1));
  const out = {};
  for (const k of Object.keys(v)) {
    const lk = k.toLowerCase();
    if (_REDACT_KEYS.has(lk)) { out[k] = "[REDACTED]"; continue; }
    if (lk === "headers" && v[k] && typeof v[k] === "object") {
      out[k] = {};
      for (const hk of Object.keys(v[k])) out[k][hk] = _REDACT_HEADER_KEYS.has(hk.toLowerCase()) ? "[REDACTED]" : v[k][hk];
      continue;
    }
    out[k] = _redactValue(v[k], depth+1);
  }
  return out;
}

// Rotating write stream: opens a new file when the date (UTC) changes, or when the
// current file exceeds MAX_SIZE_BYTES (safety valve against single-day bloat).
const LOG_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
class _RotatingStream {
  constructor(name) { this.name = name; this.currentKey = null; this.writer = null; this._droppedWarned = false; this._sizeCheckedAt = 0; }
  _ensure() {
    const d = new Date();
    const dateKey = d.toISOString().slice(0, 10); // UTC day
    // Size-check the current file — at most once a second. It was a statSync on
    // EVERY line, i.e. a synchronous filesystem call per request on the one
    // thread that serves everyone (perf/RESULTS.md, sign-in storm). The cap is a
    // 500 MB safety valve, so a second's lag in noticing it costs nothing.
    const nowMs = d.getTime();
    // Not while the file is still opening: it may not exist yet, and a stat
    // that fails there is no failed write (the counter below would report one
    // at every new day's file).
    if (this.writer && !this.writer.pending && this.currentKey === dateKey && nowMs - this._sizeCheckedAt >= 1000) {
      this._sizeCheckedAt = nowMs;
      try {
        const st = fs.statSync(this._currentPath());
        if (st.size > LOG_MAX_FILE_SIZE) {
          const rotated = this._currentPath().replace(/\.jsonl$/, `-${d.toISOString().replace(/[:.]/g,"-")}.jsonl`);
          try { fs.renameSync(this._currentPath(), rotated); } catch (_e) { _logWriteFailures += 1; }
          try { this.writer.end(); } catch (_e) { _logWriteFailures += 1; }
          this.writer = null; this.currentKey = null;
        }
      } catch (_e) { _logWriteFailures += 1; }
    }
    if (this.currentKey !== dateKey || !this.writer) {
      if (this.writer) try { this.writer.end(); } catch (_e) { _logWriteFailures += 1; }
      this.currentKey = dateKey;
      this.writer = fs.createWriteStream(this._currentPath(), { flags: "a" });
      this.writer.on("error", (err) => {
        if (!this._droppedWarned) {
          _origConsole.error(`Log write failed (${this.name}), dropping subsequent messages for 60s:`, err.message);
          this._droppedWarned = true;
          setTimeout(() => { this._droppedWarned = false; }, 60_000);
        }
      });
    }
    return this.writer;
  }
  _currentPath() { return path.join(LOG_DIR, `${this.name}-${this.currentKey}.jsonl`); }
  write(line) {
    try {
      const w = this._ensure();
      if (!w) return;
      if (w.pending) {
        // The file is still being opened (asynchronously), so the line waits in
        // the stream. Kept until written: see the exit hook below.
        const rec = { path: this._currentPath(), line };
        _queuedBeforeOpen.add(rec);
        w.write(line, (err) => { _queuedBeforeOpen.delete(rec); if (err) _logWriteFailures += 1; });
      } else {
        // The write itself is asynchronous: a file that cannot be opened or
        // written (a full disk, a path that is a directory) fails the stream,
        // and every line it drops is counted here, the only witness it has.
        w.write(line, (err) => { if (err) _logWriteFailures += 1; });
      }
    } catch (_e) { /* silent drop on any I/O failure */ _logWriteFailures += 1; }
  }
}
// A FATAL at boot logs and calls process.exit(1) in the same tick. The streams
// write asynchronously and open their files asynchronously, so that line was
// still waiting when the process ended and was lost; and in production, where
// nothing is mirrored to the console, the process then stopped without a word
// anywhere, `docker logs` included. On exit, a line still waiting for its file
// is appended synchronously, and a non-zero exit with the mirror off replays
// the last minute's error lines (at most 20) to stderr, which is where an
// operator looks first when a process stops.
const _queuedBeforeOpen = new Set();
const _recentErrors = [];
const RECENT_ERRORS_MAX = 20;
const RECENT_ERRORS_WINDOW_MS = 60_000;
process.on("exit", (code) => {
  for (const rec of _queuedBeforeOpen) {
    try { fs.appendFileSync(rec.path, rec.line); } catch (_e) { _logWriteFailures += 1; }
  }
  _queuedBeforeOpen.clear();
  if (code !== 0 && !LOG_CONSOLE_MIRROR) {
    const since = Date.now() - RECENT_ERRORS_WINDOW_MS;
    for (const e of _recentErrors) {
      if (e.at < since) continue;
      try { fs.writeSync(2, e.line); } catch (_e) { _logWriteFailures += 1; }
    }
  }
});
const _accessStream = new _RotatingStream("access");
const _appStream = new _RotatingStream("app");

function _writeLog(stream, level, ctx, msg) {
  const levelNum = LOG_LEVELS[level] || 0;
  if (levelNum < LOG_LEVEL_NUM) return;
  const entry = { ts: new Date().toISOString(), level, msg: typeof msg === "string" ? msg : String(msg) };
  if (ctx && typeof ctx === "object") Object.assign(entry, _redactValue(ctx));
  let line;
  try { line = JSON.stringify(entry) + "\n"; } catch { line = JSON.stringify({ ts: entry.ts, level, msg: "[unserialisable log entry]" }) + "\n"; }
  stream.write(line);
  if (level === "error") {
    _recentErrors.push({ at: Date.now(), line });
    if (_recentErrors.length > RECENT_ERRORS_MAX) _recentErrors.shift();
  }
  if (LOG_CONSOLE_MIRROR) {
    const c = level === "error" ? _origConsole.error : level === "warn" ? _origConsole.warn : _origConsole.log;
    c(line.trimEnd());
  }
}
function _mkLogger(stream) {
  const log = (lvl) => (ctxOrMsg, msg) => {
    if (typeof ctxOrMsg === "string") _writeLog(stream, lvl, null, ctxOrMsg);
    else _writeLog(stream, lvl, ctxOrMsg, msg);
  };
  return { error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") };
}
const log = _mkLogger(_appStream);
const logAccess = _mkLogger(_accessStream);

// Override console.* so legacy call sites end up in app.jsonl alongside new `log.*` calls.
// Preserves stdout mirroring when LOG_CONSOLE_MIRROR is on (which is the default in dev).
//
// An Error argument is written as its stack. JSON.stringify keeps only an Error's
// ENUMERABLE own properties, which loses the message and the stack (Express's
// final handler hands console.error the Error itself, so a double fault logged as
// `{"code":"ERR_HTTP_HEADERS_SENT"}`) and can carry what a parser attached, such
// as body-parser's `body`. An argument that cannot be serialised (a cycle deeper
// than _redactValue's cut-off) is named, so the console call never throws.
function _consoleArg(x) {
  try {
    if (x instanceof Error) return (typeof x.stack === "string" && x.stack) || String(x);
    return typeof x === "object" ? JSON.stringify(_redactValue(x)) : String(x);
  } catch (_) { return "[unserialisable console argument]"; }
}
const _consoleLine = (a) => a.map(_consoleArg).join(" ");
console.log   = (...a) => _writeLog(_appStream, "info",  { legacy: true }, _consoleLine(a));
console.info  = console.log;
console.warn  = (...a) => _writeLog(_appStream, "warn",  { legacy: true }, _consoleLine(a));
console.error = (...a) => _writeLog(_appStream, "error", { legacy: true }, _consoleLine(a));
console.debug = (...a) => _writeLog(_appStream, "debug", { legacy: true }, _consoleLine(a));

// Disk-aware retention: deletes the oldest .jsonl files when free space drops
// below max(LOG_MIN_FREE_MB, LOG_MIN_FREE_PCT of volume). Never deletes today's
// active file. Runs every 5 minutes.
function _freeSpaceBytes(dir) {
  try {
    if (!fs.statfsSync) return null;
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}
function _retentionThresholdBytes(totalBytes) {
  const minMB = LOG_MIN_FREE_MB * 1024 * 1024;
  const pctBytes = Math.round(totalBytes * LOG_MIN_FREE_PCT / 100);
  return Math.max(minMB, pctBytes);
}
function runLogRetentionCleanup() {
  try {
    const info = _freeSpaceBytes(LOG_DIR);
    if (!info) return;
    const threshold = _retentionThresholdBytes(info.total);
    if (info.free >= threshold) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => /^(access|app)-.*\.jsonl$/.test(f) && !f.includes(todayKey))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      const curr = _freeSpaceBytes(LOG_DIR);
      if (curr && curr.free >= threshold) break;
      try {
        fs.unlinkSync(path.join(LOG_DIR, f.name));
        log.warn({ file: f.name, free_bytes: curr?.free }, "Deleted old log file due to disk pressure");
      } catch (e) {
        log.error({ file: f.name, error: e.message }, "Failed to delete old log file");
      }
    }
    const final = _freeSpaceBytes(LOG_DIR);
    if (final && final.free < threshold * 2) {
      log.warn({ free_bytes: final.free, threshold_bytes: threshold }, "Disk space critical — below 2× retention threshold even after cleanup");
    }
  } catch (e) {
    _origConsole.error("Log retention cleanup failed:", e.message);
  }
}
setInterval(runLogRetentionCleanup, 5 * 60_000).unref(); // infra audit (#1): .unref() so the cleanup timer never keeps the event loop alive

// Strip CR/LF/tab so untrusted values can't forge or split log lines (log
// injection). Used wherever user-supplied text reaches a log message.
function sanitiseForLog(val) { return String(val || "").replace(/[\r\n\t]/g, " "); }

module.exports = {
  log, logAccess, _REDACT_KEYS, _redactValue,
  LOG_DIR, LOG_DISABLE_ACCESS, LOG_CONSOLE_MIRROR, runLogRetentionCleanup, sanitiseForLog,
  // Also consumed by server.js: the admin-logs level filter (LOG_LEVELS) and
  // the disk-space guard on uploads/imports (_freeSpaceBytes + thresholds).
  LOG_LEVELS, _freeSpaceBytes, LOG_MIN_FREE_MB, LOG_MIN_FREE_PCT,
  // Read by /metrics (`hack_arena_log_write_failures_total`): a write this
  // module could not make cannot be logged, only counted.
  logWriteFailureCount: () => _logWriteFailures,
};
