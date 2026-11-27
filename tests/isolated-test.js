// @ts-check
//
// v7.20.0 — PER-FILE server + database isolation.
//
// THE PROBLEM THIS SOLVES
// ──────────────────────
// The isolation boundary used to be the WORKER, but the boundary the tests
// need is the FILE.
//
// playwright.config.js spawned one server + one data-test-<i>/ database per
// worker, seeded once by global-setup. `fullyParallel: false` makes the FILE
// the unit of distribution. So a worker ran files A → B → C against one
// shared, never-reset database, and everything A mutated — alice's competition
// selection, the participant pool, the challenges table, group membership, the
// in-process caches — was still there for B and C.
//
// Which files share a worker depends on the worker count and on timing. That is
// why the same suite passed at WORKERS=8 locally and failed at CI's 4: fewer
// workers means more files per worker, so a file lands behind mutators it never
// meets locally. Every one of these came from that single mismatch:
//   • v7.15.29 — a seeded row pushed off page 1 by accumulated rows
//   • v7.16.8  — an operational alert raised in one file blocking 27 later tests
//   • v7.17.3  — the participant nav test, red on main for three releases,
//                because another file had re-pointed alice's competition
//
// THE FIX, AND WHY IT NEEDS NO CHANGES TO ANY TEST
// ───────────────────────────────────────────────
// The PORT is the stable identity. Every helper resolves its server from
// PORT_BASE + TEST_PARALLEL_INDEX, so if the worker's server is REPLACED on the
// same port with a wiped data directory before each file, then:
//   • BASE, TEST_DB_PATH, apiLogin, getSuperadminPass all keep working
//     unchanged — they are pointed at a port, not at a process;
//   • the file gets a brand-new process, so every in-process cache
//     (leaderboard, me-cache, _competitionCache, scanner map, rate-limit
//     buckets, admin alerts, sessions) is gone by construction — no
//     "remember to reset this one" list to get wrong;
//   • the file gets a freshly-seeded database.
//
// Within-file ordering is untouched: `fullyParallel: false` already guarantees
// a file's tests run in order on one worker, which is what the deliberately
// sequential specs (functional-core, mutations-*) rely on.
//
// Cost, measured: boot 985ms + seed 707ms = 1.7s per file. 34 spec files over
// 8 workers is ~7s of added wall-clock on a ~180s suite (~4%).
//
// USAGE: a spec requires `./isolated-test` instead of `@playwright/test`.
// Everything else about the spec is unchanged.
const base = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const { request } = require("@playwright/test");
const { portFor, dataDirFor, serverEnv } = require("./server-env");

function workerSlot() { return parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10); }

// v8.3.29 — state lives on the PROCESS, not on the module.
//
// This module deletes itself from `require.cache` at the bottom of the file so
// that every spec file re-evaluates it and registers its OWN hooks. A
// module-level `let _child` would therefore be a fresh null for each file and
// the handle on the server this worker is actually running would be lost — the
// state that already made `_killCurrent` a silent no-op. A worker-process
// global keeps exactly one handle across every re-evaluation in this worker.
const _G = (globalThis.__hackarenaIsolatedTest ||= { child: null, procHooks: false, log: "" });

function _waitPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const probe = net.createServer();
      probe.once("error", () => {
        probe.close();
        if (Date.now() > deadline) return reject(new Error(`port ${port} never freed`));
        setTimeout(attempt, 50);
      });
      probe.once("listening", () => probe.close(() => resolve()));
      probe.listen(port, "127.0.0.1");
    };
    attempt();
  });
}

/**
 * Kill whatever `node server.js` is LISTENING on `port`, addressed by port
 * rather than by handle.
 *
 * Needed because a worker does not always own the server it is replacing:
 * Playwright will start a fresh worker process for a spec file, and that
 * worker's handle is legitimately null while the PREVIOUS file's server is
 * still alive. Terminating it was left entirely to the exiting worker's
 * `process.on("exit")` handler — a race the incoming worker did not wait on.
 *
 * Deliberately NARROW. `pkill -f "node server.js"` has taken out an operator's
 * dev server in this tree before, so a pid is killed only when BOTH hold: its
 * command line is this repo's `server.js`, and its cwd is this repo. Anything
 * else on the port is left alone and the port-free wait below then fails
 * loudly, which is the right outcome — the alternative is killing a stranger.
 */
function _killServerOnPort(port) {
  const root = require("path").resolve(__dirname, "..");

  // Port -> socket inode, straight out of /proc. NOT `lsof`, and not `ss`: the
  // pinned CI image ships NEITHER (verified against the image the workflow
  // pins), so a version of this that shells out is a silent no-op there — it
  // returns "not found", nothing is killed, and the recycle fails 15 s later
  // with a bare "port N never freed" that names nothing about the cause. That
  // is exactly how this shipped red on main once.
  const hex = ":" + port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let txt = "";
    try { txt = fs.readFileSync(f, "utf-8"); } catch (_) { continue; }
    for (const line of txt.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      if (!c[1] || !c[1].endsWith(hex)) continue;   // local_address
      if (c[3] !== "0A") continue;                  // TCP_LISTEN
      inodes.add(c[9]);                             // inode
    }
  }
  if (!inodes.size) return;

  // Only OUR processes are considered, so the fd scan below stays tiny and a
  // stranger holding the port is never even a candidate.
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch (_) { return; }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ");
      if (!/\bserver\.js\b/.test(cmd)) continue;
      if (fs.readlinkSync(`/proc/${pid}/cwd`) !== root) continue;
      const fds = fs.readdirSync(`/proc/${pid}/fd`);
      const owns = fds.some((fd) => {
        try { return inodes.has((fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/) || [])[1]); }
        catch (_) { return false; }
      });
      if (owns) process.kill(Number(pid), "SIGKILL");
    } catch (_) { /* already gone, or not ours to inspect */ }
  }
}

async function _killCurrent(port, child = _G.child) {
  // NOT `if (!child) return;` — that early return skipped the port-free wait as
  // well as the kill, so `_spawnAndSeed` went on to wipe the data directory and
  // bind the port while the PREVIOUS file's server was still alive and serving
  // from the now-unlinked database. Whether this worker holds a handle decides
  // HOW the old server is terminated, never WHETHER we wait for its port.
  if (child === _G.child) _G.child = null;
  if (!child) {
    _killServerOnPort(port);
    await _waitPortFree(port);
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", finish);
    try { child.kill("SIGKILL"); } catch (_) { finish(); }
    // Never hang the suite on a process that will not die.
    setTimeout(finish, 5000);
  });
  // SIGKILL returns before the kernel releases the socket; binding too early
  // gives "Port N is already in use. Exiting." — which the server logs and then
  // exits on, leaving the next file talking to nothing.
  await _waitPortFree(port);
}

async function _spawnAndSeed(slot) {
  const port = portFor(slot);
  const dataDir = dataDirFor(slot);
  fs.rmSync(dataDir, { recursive: true, force: true });

  // Recorded BEFORE the spawn, minus a second of slack: SERVER_STARTED_AT is
  // stamped inside the child, and comparing against a later instant could reject
  // our own server on a coarse clock.
  const spawnedAt = Date.now() - 1000;
  const child = spawn(process.execPath, _COV ? ["--require", require("path").join(__dirname, "_coverage-preload.cjs"), "server.js"] : ["server.js"], {
    cwd: require("path").resolve(__dirname, ".."),
    env: _COV ? { ...serverEnv(slot), NODE_V8_COVERAGE: require("path").join(_COV, "server") } : serverEnv(slot),
    stdio: ["ignore", "pipe", "pipe"],
  });
  _G.child = child;
  // Keep the tail of the server's own output: when a boot fails, that message
  // ("Port N already in use", "FATAL: BASE_URL required") is the answer, and
  // swallowing it is how a five-minute diagnosis becomes a five-hour one.
  let log = "";
  _G.log = "";
  // Mirrored onto the process global so the per-test death check below can
  // quote the tail of a server that died AFTER boot, not only one that failed it.
  const keep = (b) => { log = (log + b.toString()).slice(-4000); if (_G.child === child) _G.log = log; };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.once("exit", (code) => {
    if (_G.child === child && code !== null && code !== 0) {
      console.error(`[isolated-test] worker ${slot} server exited ${code}:\n${log.slice(-1200)}`);
    }
  });

  const ctx = await request.newContext({ baseURL: `http://localhost:${port}` });
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode} during boot:\n${log.slice(-1200)}`);
      // v7.21.10 — /healthz alone is NOT proof the NEW server is up: the PREVIOUS
      // file's server answers it identically. If the old process outlives
      // _killCurrent (SIGKILL returns before the socket is released, and that
      // wait has a 15 s cap) the new child dies of EADDRINUSE while this loop
      // sees a healthy 200 from the OLD one — and every test in the file then
      // runs against the previous file's process AND its database. That is not
      // hypothetical: it put a `CodeBlk …` task from code-blocks.spec.js into
      // list-counts.spec.js's seeded competition, which is exactly the
      // cross-file contamination per-file isolation exists to make impossible.
      //
      // /api/config carries server_started_at, so require a boot stamp NEWER
      // than the moment we spawned. That distinguishes the two processes
      // positively instead of trusting that the port belongs to us.
      try {
        const r = await ctx.get("/api/config");
        if (r.ok()) {
          const startedAt = Date.parse((await r.json()).server_started_at || 0);
          if (Number.isFinite(startedAt) && startedAt >= spawnedAt) break;
        }
      } catch (_) {}
      if (Date.now() > deadline) {
        throw new Error(
          `server did not become healthy on ${port} as a NEW process (a previous file's ` +
          `server may still hold the port — check for EADDRINUSE below):\n${log.slice(-1200)}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  } catch (e) {
    // v8.7.6 — KILL THE CHILD ON EVERY FAILURE PATH OUT OF THIS FUNCTION.
    //
    // Both throws above left it running. `_G.child` is assigned before the wait,
    // so the process-exit handler would eventually reap it — but not before the
    // NEXT spec file has run `_killCurrent` (which finds nothing: a server still
    // BOOTING holds no port yet, so neither the kill nor the port-free wait can
    // see it), wiped the data directory, and spawned a second server against it.
    // TWO PROCESSES THEN MIGRATE ONE DATABASE, and the loser dies on
    // `duplicate column name: login_code_via` — a guarded `PRAGMA table_info`
    // check that was true when it ran and false by the time the ALTER did.
    // Observed once in a full prod-parity run; the failure names a migration and
    // nothing about the cause, and it lands on whichever file is unlucky.
    try { child.kill("SIGKILL"); } catch (_) {}
    if (child === _G.child) _G.child = null;
    throw e;
  } finally { await ctx.dispose(); }

  // Seed with the SAME helper global-setup used, so the baseline every file
  // starts from is identical to the one the suite has always had.
  const { createClient } = require("./helpers");
  const client = createClient({ baseUrl: `http://localhost:${port}`, dataDir });
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await client.seedTestData(); return; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`seed failed on ${port}: ${lastErr && lastErr.message}\n${log.slice(-1200)}`);
}

/**
 * Drop every cached APP module from this (test) process.
 *
 * A few specs call app code in-process — lib/comp-allowlist, for instance, so
 * that an explicit `now` can be injected into window arithmetic that would
 * otherwise need a 26-hour test. Those modules reach the database through
 * db.js, which opens the SQLite file AT REQUIRE TIME.
 *
 * The recycle deletes and recreates that file, so a handle opened before it
 * points at an unlinked inode: the reads succeed and return the PREVIOUS file's
 * data. Whether that happens depends on whether the spec was the first file on
 * its worker — which is exactly the ordering nondeterminism this harness
 * exists to remove, and it is how CI failed on the very commit that introduced
 * per-file isolation.
 *
 * Purging the cache here means a spec that requires app code AFTER this hook
 * (i.e. lazily, inside a test) binds to the fresh database. A spec that
 * requires it at module top-level still cannot be helped — that require runs
 * before any hook — which is why there is a lock forbidding it.
 */
function _purgeAppModuleCache() {
  const root = require("path").resolve(__dirname, "..");
  const dbPath = require("path").join(root, "db.js");
  const libDir = require("path").join(root, "lib") + require("path").sep;
  for (const key of Object.keys(require.cache)) {
    if (key === dbPath || key.startsWith(libDir)) delete require.cache[key];
  }
}

/** Replace this worker's server with a freshly-seeded one. */
async function recycleServer() {
  const slot = workerSlot();
  await _killCurrent(portFor(slot));
  await _spawnAndSeed(slot);
  _purgeAppModuleCache();
}

// Last-resort cleanup. The worker process exiting should take the child with
// it, but a leaked server holds the port and every later run on that slot dies
// with "already in use" — which I hit while benchmarking this, and it presents
// as an unrelated csrf_invalid because the surviving server has a different
// session secret.
// Registered once per PROCESS, not once per module evaluation: this file is
// re-evaluated for every spec, and an unguarded registration would add a
// listener per file and trip MaxListenersExceededWarning part-way through a run.
if (!_G.procHooks) {
  _G.procHooks = true;
  process.on("exit", () => { try { _G.child && _G.child.kill("SIGKILL"); } catch (_) {} });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { _G.child && _G.child.kill("SIGKILL"); } catch (_) {} process.exit(1); });
  }
}

// v8.12.4 — OPT-IN COVERAGE MODE (`npm run test:coverage`). Off unless
// HACKARENA_COVERAGE names a directory; every ordinary run is byte-identical.
//   • SERVER: each spawned server runs with NODE_V8_COVERAGE and a preload that
//     dumps on SIGUSR2 (the harness SIGKILLs servers, which writes nothing); the
//     afterAll below asks for that dump once per spec file.
//   • CLIENT: on chromium, the `page` fixture records the SPA's JS coverage for
//     every test that uses it, OR-merged per script into one file per worker.
//     Pages a test opens itself with browser.newContext() are not recorded —
//     stated, because an unrecorded page reads as uncovered code.
// scripts/coverage-report.cjs turns the two into "which functions and lines no
// test executes".
const _COV = process.env.HACKARENA_COVERAGE ? require("path").resolve(process.env.HACKARENA_COVERAGE) : null;
if (_COV && !_G.cov) _G.cov = { client: new Map() };

// v8.3.29 — HOOKS ARE REGISTERED ONLY WHILE A SPEC FILE IS BEING LOADED.
//
// Several specs `require("./isolated-test")` from inside a test body (for
// `request`), and since this module now re-evaluates on every require, such a
// call would reach `base.test.beforeAll(...)` at RUN time — which Playwright
// refuses outright: "Playwright Test did not expect test.beforeAll() to be
// called here." Measured: 7 tests across three files failed exactly that way on
// the first run of this change.
//
// `test.info()` throws outside a running test, which is precisely the
// distinction wanted: during a file's LOAD no test is in flight, so the hooks
// are registered; called from inside a test this module simply hands back its
// exports and registers nothing.
const _registerHooks = (() => {
  try { base.test.info(); return false; } catch (_) { return true; }
})();

// beforeAll runs ONCE PER FILE per worker — which is exactly the boundary we
// want, and is true only because this module re-evaluates per spec file (see the
// require.cache note at the bottom). Registered at import time so it is the FIRST
// beforeAll of the file being loaded, and therefore runs before the spec's own.
if (_registerHooks) base.test.beforeAll(async () => {
  await recycleServer();
});

// v8.12.4 — A SERVER THAT DIES MID-FILE FAILS ONE TEST, BY NAME, WITH ITS REASON.
//
// If the worker's server process exits during a file (an uncaught crash, an OOM
// kill, a fatal migration), every request after that point is ECONNREFUSED. The
// first test to notice failed with a connection error that named nothing about
// the cause — often a test that had nothing to do with it — while the server's
// own last words (the stack, "FATAL: …", "Port N is already in use") were in a
// buffer nobody printed.
//
// Recovery itself needs no code here: any test failure makes Playwright restart
// the worker for the rest of the file, and the beforeAll above then gives that
// worker a freshly-seeded server. What was missing is ATTRIBUTION, so the check
// runs on both sides of every test:
//   • afterEach  — the server died DURING this test: fail THIS test (the likely
//                  culprit), quoting the exit status and the server's log tail;
//   • beforeEach — it died between tests (a hook, a detached timer): fail the
//                  next test with the same evidence rather than a bare refusal.
// A test that deliberately stops the worker's server does not exist — the specs
// that kill a server kill their OWN spawned children — so the check cannot fire
// on working code. Cost: two property reads per test.
function _serverDeathError(when) {
  const c = _G.child;
  if (!c || (c.exitCode === null && c.signalCode === null)) return null;
  const how = c.signalCode ? `was killed by ${c.signalCode}` : `exited with code ${c.exitCode}`;
  return new Error(
    `The worker's test server (port ${portFor(workerSlot())}) ${how} ${when}. Every later request in this ` +
    `file would fail with ECONNREFUSED; Playwright restarts the worker for the remaining tests and the ` +
    `per-file recycle gives them a fresh server. The server's last output:\n${(_G.log || "(none captured)").slice(-1500)}`);
}
if (_registerHooks && _COV) base.test.afterAll(async () => {
  const fs = require("fs"), path = require("path");
  // Client: persist this worker's OR-merged maps (overwritten each file, so the
  // last write wins and nothing is lost if the worker is later restarted).
  if (_G.cov.client.size) {
    fs.mkdirSync(path.join(_COV, "client"), { recursive: true });
    const out = {};
    for (const [k, v] of _G.cov.client) out[k] = Buffer.from(v).toString("base64");
    fs.writeFileSync(path.join(_COV, "client", `w${workerSlot()}-${process.pid}.json`), JSON.stringify(out));
  }
  // Server: ask for a dump and wait until it has been written.
  const c = _G.child; if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const dir = path.join(_COV, "server");
  const count = () => { try { return fs.readdirSync(dir).length; } catch (_) { return 0; } };
  const before = count();
  try { c.kill("SIGUSR2"); } catch (_) { return; }
  for (let i = 0; i < 100 && count() <= before; i++) await new Promise((r) => setTimeout(r, 100));
});

if (_registerHooks) base.test.beforeEach(async () => {
  const e = _serverDeathError("before this test started (between tests, or in a hook)");
  if (e) throw e;
});
if (_registerHooks) base.test.afterEach(async () => {
  const e = _serverDeathError("while this test was running");
  if (e) throw e;
});

// The seeded-participant contract guard. (It reads no password column: the
// seeded participants sign in with an emailed code.)
if (_registerHooks) base.test.afterAll(async () => {
  const path = require("path");
  const { dataDirFor } = require("./server-env");
  const dir = dataDirFor(workerSlot());
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (_) { return; }          // never let the guard itself break a run

  // v8.3.28 — THE SEEDED PARTICIPANTS ARE A CONTRACT, AND ONLY ONE FACT ABOUT
  // ONE OF THEM WAS GUARDED.
  //
  // Every fact about the three seeded fixtures was unguarded before this: a file
  // could leave bob an
  // `admin`, carol tagged `staff`, alice with a free-mail secondary or removed
  // from the live competition, and nothing would say so. The failures then land
  // in a LATER test — often several at once, in a different describe — for
  // reasons that name none of it:
  //
  //   • role/`staff` — promoting a seeded participant AUTO-ADDS the `staff` tag,
  //     and `POST /api/admin/competitions/assign` SILENTLY SKIPS a staff or
  //     benchmark user. So the later test builds an empty cohort and fails on an
  //     empty leaderboard, an assign that "worked", or a count that is one short.
  //   • blocked / denied / unverified / unapproved — every later `apiLogin` for
  //     that fixture 401s with the deliberately anti-enumerating "Invalid email or
  //     password", which names none of the six states it can mean.
  //   • secondary_email — the dual-email rule reads it, so it changes the OUTCOME
  //     of every later admin profile edit on that row rather than failing loudly.
  //   • membership — a removal destroys `competition_users.login_time`, the solve
  //     clock, so a later leaderboard or time-to-solve assertion measures a row
  //     the seed never produced.
  //
  // EVERY violation is reported in ONE error, deliberately: a guard that stops at
  // the first one makes a leaking file take N runs to converge, and these leaks
  // come in clusters (one site commonly leaves a role AND a tag AND a secondary).
  //
  // A DELETED fixture is not this guard's business — a file may legitimately
  // delete a seeded user — so a missing row is skipped.
  let db3;
  try {
    db3 = new Database(path.join(dir, "hackathon.db"), { readonly: true, fileMustExist: true, timeout: 500 });
    const bad = [];
    for (const email of ["alice@acme.com", "bob@acme.com", "carol@acme.com"]) {
      const u = db3.prepare(
        // v8.8.19 — widened. The eight columns this read for covered the leaks
        // that had actually been SEEN; `locked_until` and `failed_login_count`
        // produce the same unattributable symptom (every later login for that
        // account refused, with the anti-enumeration message that names none of
        // the six states it can mean) and were guarded by nothing.
        "SELECT id, role, blocked, denied_at, verified, approved, secondary_email, locked_until, failed_login_count FROM users WHERE email=? COLLATE NOCASE"
      ).get(email);
      if (!u) continue;                              // deliberately deleted
      if (u.role !== "participant") {
        bad.push(`${email}: ROLE is '${u.role}', not 'participant' — promotion auto-adds the staff tag, and the assign endpoint SILENTLY SKIPS staff users`);
      }
      if (u.blocked) bad.push(`${email}: left BLOCKED`);
      if (u.denied_at) bad.push(`${email}: left DENIED`);
      if (!u.verified) bad.push(`${email}: left UNVERIFIED`);
      if (!u.approved) bad.push(`${email}: left UNAPPROVED`);
      // v8.8.19 — `locked_until` ONLY, deliberately NOT `failed_login_count`.
      // The first draft guarded the counter too and turned two files red on its
      // first full run — correctly, in that they really do leave it at 1, and
      // WRONGLY in every sense that matters: a single failed attempt is the
      // ordinary by-product of any test asserting a wrong-password refusal,
      // which is a whole legitimate class, and the counter self-heals on the
      // lockout's own 5-minute sliding window. The state with teeth is the LOCK,
      // which makes every later login for that account fail with the
      // anti-enumeration message that names none of the six states it can mean.
      // A guard that flags working code is one the next person deletes.
      if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
        bad.push(`${email}: left LOCKED OUT until ${u.locked_until} — every later login for this account is refused with the generic message, which names none of the six states it can mean`);
      }
      if (u.secondary_email) {
        bad.push(`${email}: SECONDARY EMAIL left as ${JSON.stringify(u.secondary_email)} — the dual-email rule reads it, so it changes the outcome of every later profile edit on this row`);
      }
      const tags = db3.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(u.id).map(t => t.tag);
      for (const t of ["staff", "benchmark"]) {
        if (tags.includes(t)) {
          bad.push(`${email}: left tagged '${t}' — that removes them from every leaderboard AND makes the assign endpoint skip them`);
        }
      }
      // v8.8.19 — BOTH seeded competitions. `seedTestData` assigns alice and bob
      // to 'Test Upcoming' as well (tests/helpers.js), and that membership was
      // guarded by nothing — a file that removed it left every later test
      // asserting on the upcoming-event path silently measuring an empty cohort.
      for (const compName of ["Test Live", "Test Upcoming"]) {
        const comp = db3.prepare("SELECT id FROM competitions WHERE name=?").get(compName);
        if (!comp) continue;
        const wasSeeded = db3.prepare(
          "SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?"
        ).get(comp.id, u.id);
        // Only alice and bob are seeded into 'Test Upcoming'; carol is not, so a
        // missing row there is the seed's own shape rather than a leak.
        if (!wasSeeded && (compName === "Test Live" || email !== "carol@acme.com")) {
          bad.push(`${email}: no longer a member of the seeded '${compName}' competition`);
        }
      }
    }
    if (bad.length) {
      throw new Error(
        "This spec file left the SEEDED PARTICIPANTS changed:\n  " + bad.join("\n  ") +
        "\n\nThe seed gives alice/bob/carol a fixed shape and later tests in this file depend on it. " +
        "Prefer registering your own participant (the v7.15.32 rule — a fixture you own cannot be " +
        "contaminated by a sibling); if you must mutate a seeded one, restore it in a `finally` so an " +
        "assertion failure mid-test cannot leak it, and restore to the HARD-CODED seed value rather " +
        "than to whatever you happened to read."
      );
    }
  } catch (e) {
    if (e && /left the SEEDED PARTICIPANTS/.test(e.message)) throw e;
  } finally { try { db3 && db3.close(); } catch (_) {} }

  // v8.1.0 — the same guard for the PLATFORM NAME, and for the same reason.
  //
  // It is a global setting that renders into the header wordmark, the login card,
  // the <title> and all 19 email subjects, so a file that changes it and does not
  // put it back is a contaminator of every surface that reads it. That is not
  // hypothetical: a login-screen visual-regression baseline failed with 48 348
  // pixels different — the whole card shifted because a fixture name wrapped the
  // heading onto a second line — and the natural first suspicion was the CSS
  // changed in that release, which had nothing to do with it.
  //
  // Like the alice guard above, this NAMES THE FILE THAT BROKE IT rather than the
  // innocent one that trips over it later, and it costs one indexed read per file.
  let db2;
  try {
    db2 = new Database(path.join(dir, "hackathon.db"), { readonly: true, fileMustExist: true, timeout: 500 });
    const row = db2.prepare("SELECT value FROM settings WHERE key='platform_name'").get();
    const name = row && row.value;
    // Absent is the seeded state (the default is a code constant, not a row), and
    // a file that legitimately sets one must simply set it back to what it found.
    if (name && !/^Checkmarx Enablement Platform$/.test(name)) {
      throw new Error(
        `This spec file left settings.platform_name as ${JSON.stringify(name)}. It is a GLOBAL setting rendered ` +
        "into the header wordmark, the login card, the <title> and every email subject, so leaving it changed " +
        "silently alters what later files see — including the visual-regression baselines. Read it first and " +
        "restore it in a finally, as functional-core-a's snapshot_tie test now does."
      );
    }
  } catch (e) {
    if (e && /left settings\.platform_name/.test(e.message)) throw e;
  } finally { try { db2 && db2.close(); } catch (_) {} }
});

/**
 * v8.8.19 — REFUSE THE ONE CONFIGURATION THAT SILENTLY LIES.
 *
 * A spec that spawns its own server binds a FIXED port from `SPAWNER_OFFSETS`
 * (tests/global-setup.js), not one derived from the worker. Playwright treats
 * each (file, repeatEachIndex) pair as a SEPARATE JOB, schedulable to a
 * different worker CONCURRENTLY — so under `--repeat-each` with more than one
 * worker, two copies of the same file race to bind the same port.
 *
 * WHAT MAKES IT WORTH AN EXPLICIT REFUSAL IS THE SHAPE OF THE FAILURE, not the
 * failure itself. The loser exits with "Port N is already in use", and its
 * readiness probe is then answered by the WINNER — v7.21.10's hazard verbatim,
 * *a health probe answers for whoever holds the port*. So the spec sails past
 * its own `child.exitCode` guard (which only runs on the not-ready branch) and
 * fails later as `ENOENT` on `.superadmin-password` or a bare `ECONNRESET`.
 * MEASURED: at WORKERS=2 that is exactly what you get; only at WORKERS=8 does
 * the winner sometimes not be up yet, so the honest error appears. The developer
 * is chasing a flake and the tool invents a new one that names nothing.
 *
 * THE GATE IS NARROW ON PURPOSE. `--repeat-each` at WORKERS=1 is SEQUENTIAL and
 * works — measured, 20/20 on email-sender-name, 8/8 on schema-readiness, and
 * 274 tests across mutations-core and badge — so a blanket refusal would take
 * away a de-flake tool that does its job. Only repeat + concurrency is refused,
 * and the message says what to run instead.
 */
function guardFixedPortSpec() {
  const i = base.test.info();
  if (i.repeatEachIndex > 0 && i.config.workers > 1) {
    throw new Error(
      "This spec binds a FIXED port from tests/global-setup.js SPAWNER_OFFSETS, so two " +
      "--repeat-each copies scheduled to different workers race to bind it. The loser exits " +
      "with 'Port N is already in use' while its readiness probe is answered by the WINNER " +
      "(v7.21.10), and the spec then fails as ENOENT on .superadmin-password or ECONNRESET — " +
      "neither of which names the cause. Re-run with WORKERS=1: repeats are sequential there " +
      "and this spec passes."
    );
  }
}

const _covTest = _COV ? base.test.extend({
  page: async ({ page, browserName }, use) => {
    if (browserName !== "chromium") return use(page);
    // Raw CDP rather than page.coverage, because of NAVIGATION: a full page
    // load discards the old document's scripts and V8 then reports nothing for
    // them — measured, logout and impersonation-exit (both clicked by existing
    // specs) read as never-called under page.coverage. So coverage is taken
    // repeatedly and OR-merged (takePreciseCoverage resets its counters, so each
    // take is "what ran since the last one").
    const fs = require("fs"), path = require("path");
    const { paintScript, orInto } = require("./coverage-util");
    const root = path.resolve(__dirname, "..", "public");
    const lens = _G.cov.lens || (_G.cov.lens = new Map());
    const absorb = (result) => {
      for (const sc of result || []) {
        let p; try { p = new URL(sc.url).pathname; } catch (_) { continue; }
        if (!p.startsWith("/js/")) continue;
        let len = lens.get(p);
        if (len === undefined) { try { len = fs.readFileSync(path.join(root, p), "utf8").length; } catch (_) { len = 0; } lens.set(p, len); }
        if (len) _G.cov.client.set(p, orInto(_G.cov.client.get(p), paintScript(sc.functions, len)));
      }
    };
    let cdp = null;
    try {
      cdp = await page.context().newCDPSession(page);
      cdp.on("Profiler.preciseCoverageDeltaUpdate", (e) => absorb(e.result));
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true, allowTriggeredUpdates: true });
    } catch (_) { cdp = null; }
    let inFlight = false;
    const snap = async () => {
      if (!cdp || inFlight) return; inFlight = true;
      try { absorb((await cdp.send("Profiler.takePreciseCoverage")).result); } catch (_) {} finally { inFlight = false; }
    };
    // NOT a page.route on navigations: a CDP command issued while a navigation
    // is paused is queued until it commits, so the handler deadlocks the load
    // (measured). Chromium's own triggered updates fire at DOMContentLoaded, and
    // a 200 ms poll covers the rest; only work done in the last <200 ms before a
    // full reload can still be lost, which is why the report calls its output
    // leads rather than a verdict.
    const poll = cdp ? setInterval(snap, 200) : null;
    await use(page);
    if (poll) clearInterval(poll);
    while (inFlight) await new Promise((r) => setTimeout(r, 20));
    await snap();
    if (cdp) { try { await cdp.detach(); } catch (_) {} }
  },
}) : base.test;

module.exports = { ...base, test: _covTest, recycleServer, _killCurrent, _killServerOnPort, _waitPortFree, guardFixedPortSpec, _serverDeathError };

// ─────────────────────────────────────────────────────────────────────────────
// v8.3.29 — THE HOOKS ABOVE ARE REGISTERED AT IMPORT TIME, SO THIS MODULE MUST
// BE EVALUATED ONCE PER SPEC FILE.
//
// `base.test.beforeAll(...)` attaches to the suite being constructed while it
// runs — i.e. to the ONE spec file whose load triggered it. Node caches this
// module by path, so a worker that runs several files evaluated it only for the
// FIRST of them, and every later file in that worker registered no recycle and
// no afterAll guard at all. Measured before this line existed: 8 spec files
// across 2 workers gave 3 module evaluations and **2** recycles — isolation was
// per WORKER, which is exactly the pre-v7.20.0 model v7.20.0 set out to replace.
//
// Deleting the cache entry makes the next `require("./isolated-test")` re-run
// this file and register hooks for THAT spec. Safe because only spec files
// require this module and each is loaded once; helpers deliberately do not
// (a helper importing it would register a stray recycle).
delete require.cache[__filename];
