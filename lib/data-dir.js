// THE REQUIRED DIRECTORY VARIABLES — NO FALLBACKS. (v8.8.26; UPLOADS_DIR v8.8.27)
//
// Named for the first variable it owned. It owns both now, and the filename is
// left alone deliberately: renaming it would churn two requires, a spec, two
// documented module inventories and this file's own release record, to say
// something a reader learns from the exports in one line.
//
// `DATA_DIR` used to default to `<repo>/data`, written twice: `db.js:8` and
// `lib/config.js:26`. That default was the PRODUCTION mechanism — nothing in the
// Dockerfile, docker-compose or `npm start` ever set the variable — and it was
// also a loaded gun pointed at whoever ran the platform's own code by hand.
//
// `db.js` OPENS THE DATABASE AT REQUIRE TIME (`new Database(...)` at module
// scope), so any process that so much as `require`s it without `DATA_DIR` set
// attaches to the live deployment's SQLite file. Silently: no error, no warning,
// nothing on any screen. `lib/log.js` is the same shape one layer over — it
// `mkdirSync`es `LOG_DIR` and replaces `console.*` at require time, which is
// exactly how v8.8.24's test worker came to write its own output into a running
// deployment's application log.
//
// THE FIX IS TO DELETE THE FALLBACK, NOT TO GUARD IT. A guard keyed on
// `NODE_ENV`, or on "does this look like a test", is a guess about the CALLER —
// and the caller that matters is the one nobody predicted: a `node -e` typed at
// a prompt, a script written next year, an agent probing the tree. There is no
// value of `NODE_ENV` that makes attaching to the operator's database by
// accident the right answer, so there is no condition to put on the refusal.
//
// A DELIBERATE use is still possible and is now VISIBLE: `npm start`, `npm run
// dev` and the image all set the variable explicitly, so the path a process
// writes to is stated at the place it is launched rather than inferred from
// where the code happens to live.
//
// ONE DEFINITION, AND DELIBERATELY NOT IN `lib/config.js`. `db.js` requires
// nothing that reaches `lib/config` — that is a property worth keeping, because
// `lib/config` exits without `BASE_URL`, and giving `require("./db")` a
// `BASE_URL` dependency would break every harness that boots the schema alone.
// So this module requires `path` and nothing else, and both callers read it.
const path = require("path");

/**
 * Resolve the data volume, or refuse.
 *
 * A FUNCTION, NOT A CACHED CONSTANT — and that is not style. A spec that
 * re-points `DATA_DIR` at runtime purges `../db` from the require cache and
 * re-requires it (`trusted-networks-kind.spec.js` does exactly this, and its own
 * comment explains why: the Playwright worker does not inherit the server's
 * directory, so a bare require reads a DIFFERENT database and answers `null`
 * about rows that are visibly present). Exporting a cached `DATA_DIR` would make
 * this module a THIRD link in that chain, invisible to the two purges — so
 * `db.js` would re-require and get the stale value, with no error.
 *
 * Called at each consumer's module scope, the resolution happens exactly when it
 * used to: at `db.js` / `lib/config.js` require time. Purging those two is
 * therefore sufficient again, and no future caller has to know this module
 * exists. It was caught by that spec on its first run against the change.
 */
function requireDataDir() {
  if (!process.env.DATA_DIR) {
    // Written straight to stderr: `lib/log` may not have replaced console.* yet
    // (this module is reached before it in every entry point), and a process
    // about to exit cannot rely on an async log stream having flushed.
    console.error(
      "FATAL: DATA_DIR environment variable is required.\n" +
      "  It names the volume holding hackathon.db, the attachments and the logs.\n" +
      "  There is deliberately no default: a process that guessed one would attach\n" +
      "  to whichever data directory happened to sit beside the code — in practice,\n" +
      "  a live deployment's.\n" +
      "  Production/dev:  set it in the image, docker-compose or your .env\n" +
      "                   (`npm start` and `npm run dev` already do).\n" +
      "  A one-off script: DATA_DIR=/tmp/scratch node -e \"require('./db')\"\n" +
      "  Tests:            playwright.config.js pins it for the worker; a spawned\n" +
      "                    child must pass its own (a scanner enforces this)."
    );
    process.exit(1);
  }
  // Resolved, so a relative value cannot mean two different directories to two
  // processes started from different working directories. `UPLOADS_DIR` has been
  // resolved this way since it was introduced.
  return path.resolve(process.env.DATA_DIR);
}

/**
 * The same rule for `UPLOADS_DIR` (v8.8.27).
 *
 * A SEPARATE VOLUME from `DATA_DIR`, which is why it gets its own variable
 * rather than being derived — `docker-compose.yml` mounts the two from different
 * host paths, and the upload capacity check measures free space on BOTH
 * filesystems for that reason (v7.15.12).
 *
 * IT IS THE SAME HAZARD, not a tidier-up. The old default was `<repo>/uploads`,
 * which on a developer's machine was a symlink to the live deployment's upload
 * volume — and `server.js` both `mkdir`s that directory and runs an unlink sweep
 * over it AT EVERY BOOT. So a process that guessed the path did not merely write
 * there: it deleted from there. v8.8.15 records exactly that happening to the
 * test suite, found by watching the directory's mtime rather than by a failure.
 *
 * Deferred at v8.8.26 only because it had not been asked for, and widening a
 * refusal that can stop a deploy is not something to do unasked.
 */
function requireUploadsDir() {
  if (!process.env.UPLOADS_DIR) {
    console.error(
      "FATAL: UPLOADS_DIR environment variable is required.\n" +
      "  It names the volume holding in-flight submission uploads — a SEPARATE\n" +
      "  filesystem from DATA_DIR, which is why it is its own variable.\n" +
      "  There is deliberately no default: the server sweeps this directory at\n" +
      "  every boot, so a guessed path is one it DELETES from.\n" +
      "  Production/dev:  set it in the image, docker-compose or your .env\n" +
      "                   (`npm start` and `npm run dev` already do).\n" +
      "  Tests:            playwright.config.js pins it for the worker; a spawned\n" +
      "                    child must pass its own (a scanner enforces this)."
    );
    process.exit(1);
  }
  return path.resolve(process.env.UPLOADS_DIR);
}

module.exports = { requireDataDir, requireUploadsDir };
