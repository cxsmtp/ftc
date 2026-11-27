"use strict";
// The one place a deliberately ignored error goes.
//
// Many steps are best-effort on purpose: unlinking a temp file, a non-fatal
// audit mirror, a log line, a cache bust after the commit has landed. Their
// failure must not change the request's outcome, so the caller carries on, and
// the error is handed to the log here instead of vanishing in an empty catch: at
// debug level (written only under LOG_LEVEL=debug), or at warn with
// `{level:"warn"}` for a failure an operator must see at the default level. One
// the log cannot take is counted (`hack_arena_swallow_unrecorded_total`).
//
// Rules this module keeps (see CLAUDE.md, *Recurring rules*):
// - It requires nothing at load time, so any module — lib/http.js, db.js and
//   everything below it — can use it without changing the require graph. It
//   never LOADS lib/log.js (which loads lib/config.js, which exits the process
//   without BASE_URL); it writes through it only when the process has already
//   loaded it, and otherwise counts.
// - It never throws, so a caller's control flow is exactly what an empty catch
//   gave it.
// - It records a fixed `where` label plus the error's name and code, never its
//   message: a message can quote a request body, an address or a path.

let _unrecorded = 0;
let _logPath = null;

function _loadedLog() {
  if (_logPath === null) _logPath = require.resolve("./log");
  const mod = require.cache[_logPath];
  return mod && mod.loaded && mod.exports && mod.exports.log ? mod.exports.log : null;
}

/**
 * Record an error a best-effort step chose to ignore. Never throws. At debug
 * level, unless `opts.level` is "warn": a step whose failure an operator must
 * see at the default log level (a request that told an admin a mail was not
 * delivered when the send never reached the relay).
 */
function swallowed(where, err, opts) {
  try {
    const log = _loadedLog();
    if (!log) { _unrecorded += 1; return false; }
    log[opts && opts.level === "warn" ? "warn" : "debug"]({
      where: String(where),
      err_name: (err && err.name) || null,
      err_code: (err && err.code) || null,
    }, "best-effort step failed; carried on");
    return true;
  } catch (_logFailure) {
    _unrecorded += 1;
    return false;
  }
}

/** How many ignored errors could not be written to the log (no logger loaded, or it failed). */
function unrecordedSwallowCount() { return _unrecorded; }

module.exports = { swallowed, unrecordedSwallowCount };
