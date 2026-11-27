"use strict";

// A TRANSIENT external write lock on the worker server's database, for locks
// that a request waits out a brief `BEGIN IMMEDIATE` from another process (an
// operator's sqlite3 session, `scripts/purge.sh --apply`) instead of failing
// SQLITE_BUSY: shared by tests/sealed-reveal-unrecorded.api.spec.js and
// tests/event-team-write-lock.api.spec.js. Moved here unchanged from the first.
//
// `expect` comes from @playwright/test (as tests/ui-admin-helpers.js takes it):
// this module registers no hooks.

const http = require("http");
const path = require("path");
const { expect } = require("@playwright/test");
const { TEST_DB_PATH, TEST_DATA_DIR, BASE, findLogLine } = require("./helpers");

// A TRANSIENT external write lock, released only once the server is SEEN
// waiting on it — never on a timer.
//
// The first draft released it at a fixed 300 ms and checked afterwards that the
// response took at least ~240 ms. That proves the lock was on the server's
// database and nothing more: a request that reached the handler only AFTER the
// release (a loaded box, a descheduled server) ran uncontended, still settled
// past 240 ms, and passed every assertion against a build that fails the
// record on SQLITE_BUSY — measured, by holding the request back 350 ms. These
// arms are the only lock on `.immediate`, so they have to prove contention.
//
// THE EVIDENCE IS THE SERVER'S OWN EVENT LOOP. better-sqlite3 is synchronous
// and SQLite's busy handler is a synchronous sleep, so while a request waits
// on this lock the per-file server can answer NOTHING — not even `/healthz`.
// So the lock is held while a probe loop runs: an answered probe means the
// server is not parked (keep holding, probe again), a probe outstanding for
// PARK_MS means it is (release now), and a response that settles while the
// lock is still held means the request did NOT wait (release, and let the
// arm's own assertions say what it got instead). A fixed-time probe is not
// used on purpose: a request arriving between that probe and the release would
// fail spuriously, where polling until parked removes the race in both
// directions. PARK_MS is far above a probe's round trip (single-digit ms) and
// far below busy_timeout (5000 ms), so a parked request is released long before
// it could give up.
//
// A stall proves SOMETHING in the server was parked on the lock, not that it
// was THIS request — so `expectContended` also checks, from the server's own
// access-log line, that the request had entered the server before the release.
// That second check is load-bearing, not decoration: with another writer made
// to park first and the request sent after the release, the stall check alone
// passed against the SQLITE_BUSY-failing build (measured).
// The lock's own connection keeps better-sqlite3's default timeout, so taking
// it cannot fail just because the server happens to be mid-write.
const PARK_MS = 400;
const PARK_BOUND_MS = 10_000;
const _sleep = ms => new Promise(rs => setTimeout(rs, ms));

/**
 * One `/healthz` probe over its own connection. `settledAt` stays null while
 * the server has not answered. A transport error is NOT an answer — it means
 * the probe cannot see the server at all, which would make every stall
 * invisible — so it is recorded and the caller fails on it.
 */
function healthProbe() {
  const { port } = new URL(BASE);
  const pr = { sentAt: Date.now(), settledAt: null, error: null };
  pr.done = new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", agent: false }, res => {
      res.resume();
      res.on("end", () => { pr.settledAt = Date.now(); resolve(); });
    });
    req.on("error", e => { pr.error = e; pr.settledAt = Date.now(); resolve(); });
    req.setTimeout(PARK_BOUND_MS + 15_000, () => req.destroy(new Error("healthz probe timed out")));
  });
  return pr;
}

async function withTransientLock(fn) {
  // DRAIN FIRST: a /healthz round trip before the lock is taken runs every
  // setImmediate the previous request queued (deferred audit writes among
  // them), so none of those can be the thing that parks under this lock.
  const drain = healthProbe(); await drain.done;
  if (drain.error) throw new Error(`precondition: /healthz is unreachable at ${BASE} (${drain.error.message})`);
  const Database = require("better-sqlite3");
  const lock = new Database(TEST_DB_PATH);
  let released = false;
  try {
    lock.exec("BEGIN IMMEDIATE");
    const t0 = Date.now();
    let settledAt = null;
    const p = fn().then(r => { settledAt = Date.now(); return r; }, e => { settledAt = Date.now(); throw e; });
    p.catch(() => {});
    let outcome = null, parkedProbe = null, probe = null, answered = 0;
    while (!outcome) {
      if (settledAt !== null) { outcome = "settled_under_lock"; break; }
      if (!probe) probe = healthProbe();
      if (probe.error) throw new Error(`precondition: a /healthz probe failed while the lock was held (${probe.error.message}) — a stall could not be seen`);
      if (probe.settledAt !== null) { answered++; probe = null; }
      else if (Date.now() - probe.sentAt >= PARK_MS) { outcome = "parked"; parkedProbe = probe; break; }
      if (Date.now() - t0 >= PARK_BOUND_MS) { outcome = "never_parked"; break; }
      await _sleep(10);
    }
    lock.exec("ROLLBACK"); released = true;
    const releasedAt = Date.now();
    if (outcome === "never_parked") {
      throw new Error(`precondition: the request neither parked on the write lock nor settled within ${PARK_BOUND_MS} ms `
        + `(${answered} /healthz probes were answered while it was held) — contention was never exercised, so the arm proves nothing`);
    }
    const r = await p;
    // Let the parked probe finish so no socket outlives the arm.
    if (parkedProbe) await parkedProbe.done;
    return { r, outcome, releasedAt, settledAt, answered };
  } finally {
    if (!released) { try { lock.exec("ROLLBACK"); } catch (_) {} }
    lock.close();
  }
}

/**
 * Assert the request CONTENDED — it was inside the server, waiting on the
 * write lock, when the lock was released. Called AFTER the arm's own
 * assertions, so a build that fails fast is reported by what it answered (a
 * refusal, a 500, a withheld field), not by this bookkeeping.
 */
async function expectContended(h) {
  expect(h.outcome, "the response came back while the external lock was still held — the request did not wait for it").toBe("parked");
  const rid = h.r.headers()["x-request-id"];
  expect(rid, "precondition: the response carries its request id").toBeTruthy();
  // `ts` is stamped as the line is written at `finish` and `ms` is measured from
  // the access middleware's own entry, so `ts - ms` is when the SERVER started
  // the request (both clocks are this host's).
  const al = await findLogLine(path.join(TEST_DATA_DIR, "logs"), j => j.req_id === rid && typeof j.ms === "number",
    { prefix: "access-", what: `the access line for the contended request ${rid}` });
  const enteredAt = Date.parse(al.ts) - al.ms;
  expect(enteredAt, "precondition: the request was inside the server BEFORE the lock was released — one that arrived after it would have run uncontended").toBeLessThan(h.releasedAt);
}

module.exports = { withTransientLock, expectContended, PARK_MS, PARK_BOUND_MS };
