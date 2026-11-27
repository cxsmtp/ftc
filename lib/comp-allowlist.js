"use strict";
//
// v7.16.0 — per-competition rate-limit allowlist ("trusted network IPs").
//
// WHY THIS EXISTS
// ───────────────
// A hackathon venue puts every participant behind ONE NAT egress address. The
// per-route limiters are IP-keyed, so a synchronised start does not merely slow
// down — measured at 200 logins/60s, /api/csrf-token (120/min per IP) refused
// 80 of them, the resulting 403s pushed the scanner-reputation tracker past its
// 100-4xx threshold, and the WHOLE address was blocked for 15 minutes. The
// existing remedy, RATE_LIMIT_ALLOWLIST_IPS, needs a server restart and an
// operator with shell access — useless to the admin standing in the room while
// it happens.
//
// So the allowlist becomes a property of the competition being run, editable
// from the admin UI. Three deliberate constraints keep that from becoming a
// standing hole in the rate limiter:
//
//   1. SINGLE-SESSION COMPETITIONS ONLY. A multi-session competition spans
//      days and cohorts; "the venue's IP" is not a meaningful property of it.
//      A single session is one room, one afternoon, one network.
//   2. TIME-BOUNDED. It is inert until the competition starts and expires
//      GRACE_MS after it ends. An admin cannot leave a permanent bypass behind
//      by forgetting to remove it — the window closes on its own.
//   3. NARROW PREFIXES ONLY. /16 is the widest CIDR accepted, so nobody can
//      allowlist 0.0.0.0/0 and switch off rate limiting globally.
//
// Read on EVERY request through the rate limiter, so the list is cached in
// process (safe: the app is single-process by hard invariant) and invalidated
// by every competition write. The window is recomputed per lookup from the
// cached rows, which is arithmetic, not I/O.
const net = require("net");
const db = require("../db");
const { parseIpAllowlist, ipAllowlistMatch, canonicaliseIp } = require("./util");
const { log } = require("./log");
const { swallowed } = require("./best-effort");
// v7.29.0 — the ONE definition of "start + duration", so this module and the rest
// of the platform cannot drift on it. Required lazily is unnecessary here:
// lib/competitions already requires ../db, which this module does too.
const { scheduledEnd } = require("./competitions");

// The SQL form of the same concept, named so the JS helper and this cannot drift
// silently. It stays SQL rather than being routed through scheduledEnd(), and the
// reason is PRECISION, not reachability: SQLite's datetime() truncates to whole
// seconds while the JS helper — and validateBody, which preserves milliseconds —
// are millisecond-precise, so routing it would move this boundary by up to 999 ms
// for every caller. One row is fetched with LIMIT 1 and the query already
// full-scans (no index on ended_at/start_time, and datetime() is non-sargable),
// so the cost argument does not decide it either way.
const SQL_SCHEDULED_END_AHEAD = "datetime(c.start_time, '+' || c.duration_minutes || ' minutes') > datetime(?)";

// How long after a competition ends its trusted IPs keep working. Teardown,
// stragglers finishing a write-up, an admin pulling the final leaderboard —
// none of that should suddenly start tripping the limiter.
const GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Guard rails on what an admin may enter.
const MAX_ENTRIES = 10;
// The widest CIDR we accept. /16 is 65 536 addresses — ample for any venue,
// and far short of the /8 or /0 that would disable rate limiting wholesale.
const MIN_CIDR_BITS = 16;
const MAX_LEN = 500;

let _cache = null; // [{ id, name, list, startMs, endMs }]
// v7.21.7 — the cache also gets a short TTL, as a BACKSTOP.
//
// The explicit invalidations (competition create + PUT) are the contract: a save
// must take effect on the very next request, because the ban-alert copy promises
// it. But the cached rows carry a derived WINDOW (startMs/endMs from start_time,
// duration_minutes and ended_at), and those inputs are written by eight sites
// across three files that know nothing about this module — end-now (both
// branches), the competition DELETE, the all-solved auto-end, the assign-driven
// revive, and any PUT that moves the schedule without touching the IP field.
// Enumerating those by hand is the failure mode this codebase keeps
// rediscovering (v7.15.15: prose is not enumerable; v7.21.1 A1: re-deriving a
// rule is what produced four incompatible copies), and a missed one here fails
// in the UNSAFE direction — a deleted competition's addresses keep bypassing the
// limiter. So bound the staleness instead of trusting a list. This mirrors
// _competitionCache (1 s) and _leaderboardCache (5 s), which pair a TTL with
// explicit invalidation for the same reason.
let _cacheAt = 0;
const _CACHE_TTL_MS = 5_000;

// server.js owns the scanner-reputation map, so it registers a clearer here.
// Saving a trusted network must lift an existing block on those addresses at
// once: the alert tells the admin "the block is lifted immediately on save",
// and an instruction that is not true is worse than no instruction.
let _blockClearer = null;
function setScannerBlockClearer(fn) { _blockClearer = fn; }
function clearScannerBlocksFor(csv) {
  if (!_blockClearer || !csv) return 0;
  let n = 0;
  for (const entry of String(csv).split(",").map(x => x.trim()).filter(Boolean)) {
    // A CIDR cannot be cleared by exact key, so clear by match instead — the
    // clearer takes a predicate for that case.
    try { n += _blockClearer(entry) || 0; } catch (e) { swallowed("comp-allowlist:block-clear", e); }
  }
  return n;
}

function invalidateCompAllowlist() { _cache = null; _cacheAt = 0; }

// Effective end for a SINGLE-SESSION competition: an explicit end if one was
// recorded (manual end-now / all-solved auto-end), otherwise the scheduled one.
// Multi-session competitions cannot carry trusted IPs at all, so there is no
// timeslot arithmetic to do here.
// v7.29.0 — the ARITHMETIC is shared, the CLAMPING deliberately is not. This
// returns `ended_at` as-is, where competitionEffectiveEnd takes the MIN of
// `ended_at` and the scheduled end. That difference is real and is not a bug to
// tidy: the bypass window here is meant to close when the operator says the event
// is over, and routing this through the canonical helper would silently change
// which of the two instants wins. The `|| 0` guard is preserved by normalising
// the row rather than trusting the helper to have it.
function _endMs(row) {
  if (row.ended_at) return new Date(row.ended_at).getTime();
  return scheduledEnd({ start_time: row.start_time, duration_minutes: row.duration_minutes || 0 }).getTime();
}

function _build() {
  const rows = db.prepare(
    `SELECT id, name, start_time, duration_minutes, ended_at, trusted_network_ips
       FROM competitions
      WHERE trusted_network_ips IS NOT NULL AND TRIM(trusted_network_ips) <> ''`
  ).all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    list: parseIpAllowlist(r.trusted_network_ips),
    startMs: new Date(r.start_time).getTime(),
    endMs: _endMs(r),
  })).filter(r => Number.isFinite(r.startMs) && Number.isFinite(r.endMs));
}

/**
 * The competition whose trusted-IP window currently covers `ip`, or null.
 * Returning the competition (rather than a boolean) is what lets the audit
 * trail and the admin alert say WHICH event granted the bypass.
 */
function competitionAllowlistMatch(ip, now = Date.now()) {
  if (!ip) return null;
  // Age is tracked against the real clock, NOT the caller's injected `now`:
  // that parameter is a WINDOW value (tests pass synthetic instants to probe the
  // start/end boundaries), and conflating a window with a clock is exactly the
  // v7.21.1 A3 offset bug.
  if (_cache === null || (Date.now() - _cacheAt) > _CACHE_TTL_MS) {
    try {
      _cache = _build();
      _cacheAt = Date.now();   // stamped ONLY on success — see the catch below
    } catch (e) {
      // Do NOT cache the failure. Assigning [] here leaves _cache non-null, so
      // _build() is never retried and a SINGLE transient read error — an
      // SQLITE_BUSY under load is the obvious one — silently disables every
      // trusted network until the next competition write happens to invalidate
      // the cache. During an event that is indistinguishable from "the feature
      // does not work", and nothing would appear in the logs.
      //
      // Fail closed for THIS request (the limiter stays on, which is the safe
      // direction) and leave _cache null so the very next one tries again.
      try { log.warn({ err: e && e.message }, "trusted-network allowlist could not be read; not applying it to this request"); } catch (e2) { swallowed("comp-allowlist:read-failure-log", e2); }
      return null;
    }
  }
  for (const c of _cache) {
    if (now < c.startMs || now > c.endMs + GRACE_MS) continue; // outside the window
    if (ipAllowlistMatch(c.list, ip)) return c;
  }
  return null;
}

/** Is there any competition running right now? Used to decide alert urgency. */
// v8.1.0 (PR 20) — TWO EDITS, and both are v7.21.14 resurfacing through a new door.
//
// A Program EXCLUDED: it has no sessions, so `accepts_trusted_ips` would compute
// TRUE and the alert would tell a superadmin to "put <ip> in Trusted network IPs
// and save" — which the route now refuses for that kind. Naming a control the
// platform will refuse is the exact defect v7.21.14 fixed for multi-session
// competitions. Excluding it is correct in BOTH venue cases: a lab-day room
// working through a Program falls to the no-event branch, whose remedy (wait out
// the block, or RATE_LIMIT_ALLOWLIST_IPS) is the true one.
//
// An ORDER BY, because `LIMIT 1` over an unordered set is not a choice: with a
// Booth Event and a Competition both live, which one the alert names was
// whatever SQLite happened to return. Most-recently-started first, with the id as
// a total order so two events sharing a start cannot swap between polls.
// v7.21.14 — the row now carries `accepts_trusted_ips`, because the IP-ban
// alert built on it TELLS AN ADMIN WHAT TO DO and must not name a control the
// platform will refuse. `trusted_network_ips` is single-session-only by an
// explicit v7.16.0 decision (a multi-session competition spans days and cohorts,
// so "the venue's IP" is not a property of it), and the competition PUT enforces
// that with a 400. So for a multi-session competition the alert's step 2 — "put
// <ip> in Trusted network IPs and save" — is a dead end, and the admin reading
// it is standing in the room with the venue blocked. See alertCopy().
function anyCompetitionLive(now = Date.now()) {
  try {
    const row = db.prepare(
      `SELECT c.id, c.name,
              NOT EXISTS (SELECT 1 FROM competition_timeslots ts WHERE ts.competition_id=c.id) AS accepts_trusted_ips
         FROM competitions c
        WHERE c.ended_at IS NULL
          AND c.event_kind <> 'program'
          AND datetime(c.start_time) <= datetime(?)
          AND ${SQL_SCHEDULED_END_AHEAD}
        ORDER BY c.start_time DESC, c.id
        LIMIT 1`
    ).get(new Date(now).toISOString(), new Date(now).toISOString());
    if (!row) return null;
    return { ...row, accepts_trusted_ips: !!row.accepts_trusted_ips };
  } catch (_) { return null; }
}

/**
 * Validate + normalise an operator-entered allowlist.
 * Returns { value } (a canonical comma-separated string, or null when cleared)
 * or { error } with a message the admin can act on.
 */
function validateTrustedIps(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== "string") return { error: "Trusted network IPs must be text." };
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };            // empty clears it
  if (trimmed.length > MAX_LEN) return { error: `Trusted network IPs must be ${MAX_LEN} characters or fewer.` };

  const entries = trimmed.split(",").map(s => s.trim()).filter(Boolean);
  if (!entries.length) return { value: null };
  if (entries.length > MAX_ENTRIES) {
    return { error: `At most ${MAX_ENTRIES} trusted network entries are allowed (got ${entries.length}).` };
  }
  const seen = new Set(); const out = [];
  for (const e of entries) {
    const cidr = e.match(/^(.+?)\/(\d{1,3})$/);
    if (cidr) {
      const bits = parseInt(cidr[2], 10);
      // ext-audit v7.20.9 (F11) — name the real constraint. An operator typing
      // an IPv6 range used to get "not a valid IPv4 CIDR range", which reads as
      // "you mistyped it" rather than "ranges are IPv4-only here".
      if (net.isIPv6(cidr[1])) {
        return { error: `"${e}" is an IPv6 range — only IPv4 ranges are supported. Enter the exact IPv6 addresses instead.` };
      }
      if (!_isIpv4(cidr[1])) return { error: `"${e}" is not a valid IPv4 CIDR range.` };
      if (!(bits >= 0 && bits <= 32)) return { error: `"${e}" has an invalid prefix length.` };
      // The load-bearing guard: without it, /0 would allowlist the internet.
      if (bits < MIN_CIDR_BITS) {
        return { error: `"${e}" is too broad — /${MIN_CIDR_BITS} is the widest range allowed, so rate limiting cannot be disabled wholesale.` };
      }
    } else if (!_isIpv4(e) && !net.isIPv6(e)) {
      return { error: `"${e}" is not a valid IP address or CIDR range.` };
    }
    // ext-audit v7.20.9 (F11) — store the CANONICAL form. Two renderings of one
    // IPv6 address (case, zero-compression, an IPv4-mapped form) used to be two
    // distinct entries, so the de-dup below could not see them as the same host
    // and the matcher compared raw strings. Canonicalising here means the ten-
    // entry cap counts real addresses and the stored value is what the matcher
    // will actually compare against.
    const canon = canonicaliseIp(e);
    if (!seen.has(canon)) { seen.add(canon); out.push(canon); }
  }
  return { value: out.join(",") };
}

function _isIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return false;
  return [1, 2, 3, 4].every(i => {
    const n = Number(m[i]);
    return String(n) === m[i].replace(/^0+(?=\d)/, "") && n >= 0 && n <= 255;
  });
}
// ext-audit v7.20.9 (F11) — IPv6 validation is now `net.isIPv6`, a real parser.
// The predicate this replaced (`/^[0-9a-fA-F:]+$/` plus "contains a colon")
// accepted `::::` and `dead:beef:::`. Neither can ever match a real address, so
// nothing was let THROUGH the limiter — the harm was the opposite direction and
// just as bad operationally: the form accepted the entry, the admin believed
// the venue was allowlisted, and the bypass silently never applied. Validation
// that accepts input it cannot honour is a wrong answer, not a lenient one.

module.exports = {
  GRACE_MS, MAX_ENTRIES, MIN_CIDR_BITS,
  competitionAllowlistMatch, invalidateCompAllowlist, anyCompetitionLive, validateTrustedIps,
  setScannerBlockClearer, clearScannerBlocksFor,
};
