"use strict";

// Per-route Express middleware shared across every route module:
//   - rateLimit (in-memory per-IP buckets) + the test toggle + metrics gauge
//   - CSRF (csrf-sync) — generateToken + csrfProtection (applied per-route)
//   - auth guards: requireParticipant / requireAdmin / requireSuperAdmin
//     (each re-reads the user row to enforce the full lifecycle per request)
//   - requireCompetitionContext / requireParticipantInCompetition
// Deps: db, csrf-sync, the competition/session helpers, recordUserEvent, and
// isStaff. (v7.0.0 refactor: extracted verbatim from server.js.)

const { csrfSync } = require("csrf-sync");
const db = require("../db");
const { swallowed } = require("./best-effort");
const {
  getCompetition, getCompetitionTimeslots, getTimeslot, competitionStatus, timeslotStatus,
  lateEntryStateFor,
  autoResumeAllows, listParticipantCompetitions,
  anchorLoginTime,          // v8.12.0 — the honest first anchor
} = require("./competitions");
const { recordUserEvent, reqContext } = require("./audit");
const { isStaff } = require("./user-tags");
// v8.3.12 — the sole-event landing rule honours the kind's `autoResume` policy,
// so a Program is excluded there for the same reason it is excluded from the
// marker rule. lib/event-policy is a dependency-free table; no cycle.
const { verificationGraceState } = require("./self-enroll");
const { _profileMissingFields, PROFILE_GATE_JOIN, PROFILE_GATE_COLUMNS } = require("./util");
const { IMPERSONATION_ENDED_ERROR, IMPERSONATION_READONLY_ERROR, isImpersonating, destroyImpersonationSession, restoreImpersonationTargetInactive, organiserPanelOpensTo } = require("./impersonation");
// v7.21.3 — the lazy solve-clock anchor below needs the test-controllable clock
// and the leaderboard cache. Aliased: two functions here declare a local
// `const now = Date.now()`, and shadowing the imported one would be a trap.
const { now: clockNow } = require("./time");
// v8.8.6 — lib/event-admin.js has NO module-scope requires of its own (it reaches
// db lazily), so importing it here closes no cycle.
// v8.12.6 — `actingIsSuperAdmin` is the ONE uncached acting-admin read the
// commit-time re-check below reuses for the impersonation HAND, and
// `actingAdminLiveRole` is the same read answering with the role, for the
// participant-tier twin (`impersonatingHandDenied`).
const { impersonationScopeDenied, actingIsSuperAdmin, actingAdminLiveRole } = require("./event-admin");
// RBAC — a role's class (none | granted | all) and, for a CUSTOM role, its live
// permission for the route being guarded. Built-in roles keep every answer below.
const { roleClass, isBuiltinRole, customRoleAllows, permissionDeniedCopy, routePermissionFor } = require("./rbac");
// v8.12.6 — the revocation tombstones. lib/sessions requires db, audit and
// impersonation only, none of which reaches back here, so the edge closes no cycle.
const { wasSessionPurged } = require("./sessions");
const { refuseBeforeBody } = require("./http");
const { invalidateLeaderboardCacheForEntrant } = require("./leaderboard");

// ── Rate limiter ────────────────────────────────────────────────────────────
// Simple in-memory rate limiter for public endpoints. v6.8.5 adds a hard
// cap so a distributed probe (each source IP hitting the threshold once)
// can't grow the map faster than the 5-min janitor runs. When the map
// exceeds _RATE_LIMIT_MAX_BUCKETS we evict the oldest-start entries (Map
// iteration is insertion-ordered in V8). The cap sizes for 500 concurrent
// attackers × 20× slack; tune if the tournament scale ever exceeds that.
const _RATE_LIMIT_MAX_BUCKETS = 10_000;
const _rateLimitBuckets = new Map();
// In test mode the suite intentionally fires dozens of register/login bursts
// from a single IP — real-production-scale defaults would throw false 429s.
// `RATE_LIMIT_DISABLED=1` bypasses the middleware entirely (set by the test
// harness); defaults remain strict in production.
// v6.8.0: the disabled flag is evaluated per-request (not captured at
// module init) so the test harness can flip it on for a single spec via
// /api/test/rate-limit-toggle without spinning up a second server.
let _testRateLimitForceEnabled = false;
// v8.3.34 — park the ADMIN EMAIL CHANGE between its commit and its SMTP send,
// so a test can act inside the window in which the participant reads as
// unverified. Without it the window is not reachable from a test at all: the
// shared test server's relay is DEAD, so `sendEmailLogged` rejects instantly
// (ECONNREFUSED) and nothing can land in a microsecond gap — measured, the
// participant's own request never once fell inside it. Same shape as the
// select-timeslot and admin-commit hooks beside it.
let _testAdminEmailDelayMs = 0;
function setTestAdminEmailDelay(ms) { _testAdminEmailDelayMs = ms | 0; return _testAdminEmailDelayMs; }
function testAdminEmailDelay() { return _testAdminEmailDelayMs; }
// ext-audit v7.15.15 — same idea for POST /api/select-timeslot: park the handler
// between its first status read and its write transaction, so a test can move
// the slot across its start boundary inside that window.
let _testSelectTimeslotDelayMs = 0;
function setTestSelectTimeslotDelay(ms) { _testSelectTimeslotDelayMs = ms | 0; return _testSelectTimeslotDelayMs; }
function testSelectTimeslotDelay() { return _testSelectTimeslotDelayMs; }
// v8.12.6 — park an admin WRITE that awaits before it writes immediately BEFORE
// its commit-time re-check (`adminAuthzDenied` below): the two attachment uploads
// after the move and the two imports after their last await (a file), and —
// since v8.12.7 — the desk shortcut and the maintenance seeder before theirs.
// Grep `testAdminCommitPark(` for the set. Also, since the v8.12.6 review fix,
// the participant write that awaits before it writes (the certificate mint, after
// its render), before its own (`impersonatingHandDenied`,
// `participantSessionDenied`). The in-server window — ZIP walk, hash, move; a
// render — is milliseconds long for a test-sized
// payload, so without this a test can only revoke MID-BODY (where there is a body at all),
// which precedes every handler await and cannot tell a check placed at commit
// from one placed after the FIRST await. `parked` counts the requests that
// actually entered the park, so a test acts on a deterministic signal rather
// than a blind sleep. Only ever set from the NODE_ENV=test endpoint.
// A test may also RELEASE every parked request at once
// (`releaseTestAdminCommitPark`): an arm that warms a 2 s cache while the request
// is parked then lets it go at the instant it chooses, so the re-check reads the
// warm entry without a race against the park's timer.
// `enteredAt` is when the FIRST request since arming entered the park (this
// process's clock, the test's too): the park lets it go `delayMs` later, so a
// test bounds its act from then, not from when it sent a request whose work
// before the park (a render, a ZIP walk) a slow runner stretches.
let _testAdminCommitDelayMs = 0;
let _testAdminCommitParked = 0;
let _testAdminCommitEnteredAt = 0;
const _testAdminCommitWaiters = new Set();
function setTestAdminCommitDelay(ms) { _testAdminCommitDelayMs = ms | 0; _testAdminCommitParked = 0; _testAdminCommitEnteredAt = 0; return _testAdminCommitDelayMs; }
function testAdminCommitDelay() { return { delayMs: _testAdminCommitDelayMs, parked: _testAdminCommitParked, enteredAt: _testAdminCommitEnteredAt }; }
/** Resolves at once in every environment but a test that armed the park. */
async function testAdminCommitPark() {
  if (!_testAdminCommitDelayMs) return;
  _testAdminCommitParked++;
  if (!_testAdminCommitEnteredAt) _testAdminCommitEnteredAt = Date.now();
  await new Promise(r => {
    const go = () => { clearTimeout(t); _testAdminCommitWaiters.delete(go); r(); };
    const t = setTimeout(go, _testAdminCommitDelayMs);
    _testAdminCommitWaiters.add(go);
  });
}
/** Lets every request parked now go on at once; answers how many it released. */
function releaseTestAdminCommitPark() {
  const n = _testAdminCommitWaiters.size;
  for (const go of [..._testAdminCommitWaiters]) go();
  return n;
}
function _rateLimitDisabled() {
  if (_testRateLimitForceEnabled) return false; // test override wins
  return process.env.RATE_LIMIT_DISABLED === "1" || process.env.RATE_LIMIT_DISABLED === "true";
}
// v7.2.x — rate-limit allowlist (CTF-0026, fix C). Per-IP limiting is the wrong
// primitive when N legitimate users share one public IP (venue/office WiFi
// behind NAT/CGNAT): the whole cohort lands in one bucket. RATE_LIMIT_ALLOWLIST_IPS
// (comma-separated exact IPs + IPv4 CIDRs, mirrors LOG_SKIP_IPS parsing) lets an
// operator exempt known event networks so a large single-IP cohort isn't punished.
// Parsed once at module load; the pure matcher lives in lib/util.js so it's
// unit-testable without pulling in db.js.
const { parseIpAllowlist, ipAllowlistMatch, rateBucketKey } = require("./util");
const _rlAllow = parseIpAllowlist(process.env.RATE_LIMIT_ALLOWLIST_IPS || "");
// v7.16.0 — the env allowlist is joined by a PER-COMPETITION one, so an admin
// can trust a venue's NAT address from the UI while the event is running
// instead of needing a server restart. Required lazily: lib/comp-allowlist
// pulls in db.js, and middleware.js is imported by modules that load before
// the database is ready. Any failure falls through to "not allowlisted",
// which is the safe direction — the limiter stays ON.
let _compAllow = null;
function _competitionAllowlisted(ip) {
  try {
    if (_compAllow === null) _compAllow = require("./comp-allowlist");
    return !!_compAllow.competitionAllowlistMatch(ip);
  } catch (_) { return false; }
}
function _rateLimitAllowlisted(ip) {
  return ipAllowlistMatch(_rlAllow, ip) || _competitionAllowlisted(ip);
}

// Bump one bucket (with the v6.16.22 LRU-touch + v6.8.5 eviction) and report
// whether it is now OVER `max`. Shared by every rateLimit() instance and by
// ipBudgetExceeded() below: one store, one janitor.
function _bumpRateBucket(key, max, windowMs) {
    const now = Date.now();
    let bucket = _rateLimitBuckets.get(key);
    // v7.29.0 — the bucket carries its OWN windowMs. The store is shared by every
    // call site and the janitor lives outside this closure, so without it the
    // sweep cannot know how long a given bucket is entitled to live and has to
    // guess with a literal. See _sweepRateLimitBuckets.
    if (!bucket || now - bucket.start > windowMs) bucket = { start: now, count: 0, windowMs };
    bucket.count++;
    // v6.16.22 — LRU touch: delete-then-set so the bucket moves to the tail of
    // insertion order on every hit; the eviction sweep then removes the
    // least-recently-used buckets rather than the longest-running legitimate one.
    _rateLimitBuckets.delete(key);
    _rateLimitBuckets.set(key, bucket);
    // v6.8.5 hard cap: evict oldest ~10% when we cross the ceiling. Fires only
    // under active probe pressure; steady state never hits the branch.
    if (_rateLimitBuckets.size > _RATE_LIMIT_MAX_BUCKETS) {
      const evict = Math.floor(_RATE_LIMIT_MAX_BUCKETS * 0.1);
      let i = 0;
      for (const k of _rateLimitBuckets.keys()) { if (i++ >= evict) break; _rateLimitBuckets.delete(k); }
    }
    return bucket.count > max;
}
// rateLimit(windowMs, maxReqs, keyPrefix[, opts])
//   opts.keyExtra(req) — v7.2.x (CTF-0026, fix B): an extra per-request
//     discriminator folded into the bucket key. For /api/login this is the
//     submitted email, so a NAT cohort of N distinct accounts gets N independent
//     (ip,email) buckets instead of ONE shared per-IP bucket — the actual cause
//     of legit-users-tripping-the-limit behind shared WiFi. Returns falsy → the
//     limiter degrades to plain per-IP keying (back-compat); a throw does the
//     same, and a value that is neither text nor a number shares one fixed
//     per-IP bucket (rateBucketKey, lib/util.js), so building the key never throws.
//   opts.ipBackstopMax — a COARSE per-IP ceiling (much higher than maxReqs)
//     enforced ALONGSIDE the identity bucket, so identity-keying can't be abused
//     to fan password guesses across unlimited emails from one source IP.
function rateLimit(windowMs, maxReqs, keyPrefix, opts = {}) {
  const { keyExtra = null, ipBackstopMax = null } = opts;
  const over = (key, max) => _bumpRateBucket(key, max, windowMs);
  return (req, res, next) => {
    if (_rateLimitDisabled()) return next();
    if (_rateLimitAllowlisted(req.ip)) return next(); // fix C: venue/CGNAT bypass
    const tooMany = () => res.status(429).json({ error: "Too many requests. Please try again later." });
    // fix B: coarse per-IP backstop (when configured) — always enforced, even
    // with identity keying, so distributed-across-emails guessing from one IP
    // still hits a (high) ceiling.
    if (ipBackstopMax != null && over(`${keyPrefix}:ipbk:${req.ip}`, ipBackstopMax)) return tooMany();
    // Primary bucket: per-IP, optionally narrowed by an identity discriminator
    // (lib/util.js rateBucketKey: never throws; a non-text identity shares one
    // fixed per-IP bucket).
    const key = rateBucketKey(keyPrefix, req.ip, keyExtra, req);
    if (over(key, maxReqs)) return tooMany();
    next();
  };
}
/**
 * Charge one unit to a per-IP budget from INSIDE a handler, sending nothing:
 * true when this request goes over `max` in `windowMs`. The same store, the same
 * switch (off in tests unless forced) and the same allow-list (trusted networks,
 * RATE_LIMIT_ALLOWLIST_IPS) as rateLimit(). For a door that must refuse SILENTLY
 * to keep its answer uniform — the address proof (routes/auth.js), where a 429
 * for new addresses only would say which addresses have no account.
 */
function ipBudgetExceeded(windowMs, max, keyPrefix, req) {
  if (_rateLimitDisabled()) return false;
  if (_rateLimitAllowlisted(req.ip)) return false;
  return _bumpRateBucket(`${keyPrefix}:${req.ip}`, max, windowMs);
}
// The two shared admin buckets, built ONCE here and imported by every route
// module that names them. The bucket key is `<prefix>:<ip>` in the one
// process-global map, so a second `rateLimit(…, "destructive-admin")` in a
// route file would share the counter anyway; one definition keeps the window
// and the cap from drifting between files.
//   destructiveAdminLimit — 30/min/IP for destructive or sensitive admin acts
//     (delete user / event / challenge, end-now, recalculate, lock, role,
//     block, deny, reveal, retention purge, …): generous for hand-driven
//     operator work, but it bounds a compromised admin session's blast radius.
//   bulkAdminLimit — 5/min/IP for the bulk fan-outs (assign, invitations,
//     bulk-approve), which can drive SMTP and the SQLite writer lock.
const destructiveAdminLimit = rateLimit(60_000, 30, "destructive-admin");
const bulkAdminLimit = rateLimit(60_000, 5, "bulkadmin");

// Cleanup rate limit buckets. Extracted from an inline setInterval into a named
// function so a test can drive one pass on demand (POST /api/test/rate-limit-sweep),
// matching the _sweepExpiredSessions / account-reaper / event-retention pattern —
// a lock cannot be written against a live setInterval. Returns the per-pass count.
//
// v7.29.0 — A BUCKET IS SWEPT ON ITS OWN WINDOW, NEVER ON THE SWEEP CADENCE.
// This used to be `now - v.start > 300_000`, a literal unrelated to the window the
// bucket was created with, and the failure is silent and PERMISSIVE. The one call
// site with a window longer than the cadence is `resend-verify`
// (rateLimit(15 * 60_000, 5, …), routes/auth.js) — whose own comment promises
// "5 / 15 min / IP so it can't be used to spray verification mail". Traced: five
// posts land in one bucket, the janitor deletes that bucket ~5 minutes in with ten
// minutes of its window still to run, and the sixth post mints a fresh bucket and
// is ALLOWED. The real budget was therefore 2-3x the documented one, drifting with
// where the bucket's start fell relative to the tick phase.
//
// It matters beyond that one route because it is a prerequisite: any limiter with
// a window longer than the cadence is quietly under-enforced, so a budget cannot be
// expressed in anything coarser than five minutes until this is true.
//
// The fallback is kept for a bucket written by an older process image mid-deploy;
// it can only apply to a bucket whose window was never recorded.
function _sweepRateLimitBuckets() {
  const now = Date.now();
  let swept = 0;
  for (const [k, v] of _rateLimitBuckets) {
    if (now - v.start > (v.windowMs || 300_000)) { _rateLimitBuckets.delete(k); swept++; }
  }
  return { swept, remaining: _rateLimitBuckets.size };
}
setInterval(_sweepRateLimitBuckets, 5 * 60_000).unref(); // infra audit (#1): .unref() so the janitor never keeps the loop alive

// Test-only: rewind every bucket's start so a spec can cross a long window without
// waiting it out. The precedent is POST /api/test/scanner-age-window, which exists
// for exactly this reason. Returns how many buckets were aged.
function _ageRateLimitBuckets(ms) {
  const by = ms | 0;
  for (const v of _rateLimitBuckets.values()) v.start -= by;
  return _rateLimitBuckets.size;
}

// Test-only toggle backing /api/test/rate-limit-toggle: flips the per-process
// force-enable flag and clears the accumulated buckets so a previous test's
// counts don't spill into the next. Returns the new enabled state.
function _setTestRateLimitForceEnabled(enable) {
  _testRateLimitForceEnabled = !!enable;
  _rateLimitBuckets.clear();
  return _testRateLimitForceEnabled;
}
// Size reporter for the /metrics rate_limit cache gauge.
function _rateLimitBucketCount() { return _rateLimitBuckets.size; }

// ── CSRF (csrf-sync) ──────────────────────────────────────────────────────────
// csrfProtection is applied per-route (not globally). On the file-upload route,
// CSRF runs before multer (token sent via x-csrf-token header) to prevent temp
// file writes from unauthenticated/forged requests.
const { generateToken, csrfSynchronisedProtection: _csrfSyncProtection } = csrfSync({
  getTokenFromRequest: (req) => req.headers["x-csrf-token"] || req.body?._csrf,
});

// v8.13.3 — THE BODY-SHAPE REFUSAL, composed INTO csrfProtection.
//
// server.js presets `req.body = {}` for a body-LESS mutating request (it was
// undefined, and 37 handlers destructured it into a 500). That preset must not
// also swallow a NON-EMPTY body nothing parsed — a text/plain or octet-stream
// payload, a body with no Content-Type, or multipart sent to a route with no
// multer — or every one of those becomes `{}` and the handler answers as if the
// caller had sent nothing: PUT /api/me a 200 no-op that cancels a staged email
// change, toggle-admin-view `mode=admin` silently read as participant view,
// self-enroll regenerate rotating the join link with its concurrency check
// skipped. That is accept-and-ignore, a control that appears to work. So a
// non-empty payload in a type this ROUTE cannot parse is a 415, and a top-level
// JSON array — which the global parser accepts and every CSRF handler reads as an
// object — is a 400.
//
// WHY HERE, and nowhere else:
//   - ONLY ON MATCHED ROUTES. Every CSRF route reaches this; a global app.use
//     would turn an unrouted text/xml POST to /xmlrpc.php from the router's 404
//     into a 415, which lib/scanner-classify.js counts as 'other' rather than
//     'probe' — quietly weakening the scanner silence and early-block evidence.
//   - ONLY AFTER the CSRF check passes. An HTML form CAN post enctype=text/plain
//     cross-site; that must still reach the EBADCSRFTOKEN handler, which destroys
//     every session carrying an identity (the built-in superadmin's too, v8.13.4).
//   - multipart IS ROUTE-AWARE. It is accepted only where this route's own stack
//     carries multer (the three upload routes), so `curl -F mode=admin` to a
//     non-upload route is refused rather than silently read as `{}`. The route's
//     full stack is visible here although multer runs AFTER this layer. multer is
//     recognised by its middleware's function name, `multerMiddleware` (multer
//     2.x make-middleware.js); a spec pins that name against the installed multer
//     so an upgrade that renames it fails loudly — and an unrecognised multer
//     fails CLOSED (a 415 on the upload route), never open.
//   - It reads HEADERS only and is synchronous, so it opens no window between a
//     guard and a body parse (the v8.12.6 F1 class), and it adds no middleware
//     to any route chain, so the chain scanners see nothing new.
//
// Raised as an http-error rather than answered here, so it reaches server.js's
// generic handler and gets the req_id-joined warn line every other refused body
// gets; `code_public` is the machine-readable code that handler adds to the JSON.
// STATED CONSEQUENCE: an empty CHUNKED request with no Content-Type is a 415 (it
// declares a payload it does not type). 415 is deliberately COUNTED toward the
// scanner-reputation counter, like any 400 — it is a malformed-client answer, not
// a limiter (413 and 429 are the excluded pair).
const _NO_BODY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const _PARSED_BODY_TYPES = ["application/json", "application/x-www-form-urlencoded"];
// `"multipart"` is type-is's own shorthand for every multipart subtype — spelled
// that way on purpose, never as the subtype wildcard: a slash-star pair inside a
// string literal opens a block comment for every regex comment stripper in the
// suite, which then blanked this file down to the next star-slash and hid a
// reqContext-bearing emit from the v7.21.32 scanner (the pre-release review).
const _MULTIPART_BODY_TYPES = [..._PARSED_BODY_TYPES, "multipart"];
const _UNSUPPORTED_BODY_MESSAGE = "Send JSON or a form-encoded body (Content-Type: application/json or application/x-www-form-urlencoded).";
const _NOT_OBJECT_BODY_MESSAGE = "The request body must be a JSON object, not an array.";
function _routeTakesMultipart(req) {
  const stack = req.route && Array.isArray(req.route.stack) ? req.route.stack : null;
  if (!stack) return false;
  return stack.some(l => l && (l.name === "multerMiddleware" || (l.handle && l.handle.name === "multerMiddleware")));
}
function _bodyShapeError(status, message, type, codePublic) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  err.type = type;
  err.code_public = codePublic;
  return err;
}
function _requestBodyRefusal(req) {
  if (_NO_BODY_METHODS.has(req.method)) return null;
  const len = req.headers["content-length"];
  const hasPayload = req.headers["transfer-encoding"] !== undefined || (len !== undefined && Number(len) > 0);
  if (!hasPayload) return null;
  if (!req.is(_routeTakesMultipart(req) ? _MULTIPART_BODY_TYPES : _PARSED_BODY_TYPES)) {
    return _bodyShapeError(415, _UNSUPPORTED_BODY_MESSAGE, "content-type.unsupported", "unsupported_media_type");
  }
  if (Array.isArray(req.body)) {
    return _bodyShapeError(400, _NOT_OBJECT_BODY_MESSAGE, "body.not.object", "body_not_object");
  }
  return null;
}
function csrfProtection(req, res, next) {
  _csrfSyncProtection(req, res, (err) => {
    if (err) return next(err);
    const refusal = _requestBodyRefusal(req);
    if (refusal) return next(refusal);
    next();
  });
}

// ── Auth guards ───────────────────────────────────────────────────────────────
function requireParticipant(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  // v6.16.6 — re-check the full lifecycle, not just `blocked`. Pre-fix
  // an out-of-band write that separated the deny invariant
  // (`denied_at IS NOT NULL` with `blocked=0`), or an admin manually
  // flipping `verified=0` / `approved=0` mid-session, left an
  // authenticated participant with full access until cookie expiry —
  // asymmetric with `requireAdmin` / `requireSuperAdmin` which already
  // do their own DB re-check. The lifecycle model is documented in
  // CLAUDE.md ("Lifecycle (mutually exclusive, derived)") and the
  // login path enforces all four predicates; per-request enforcement
  // closes the gap for already-authenticated sessions.
  const user = db.prepare("SELECT blocked, verified, approved, denied_at, self_enroll_grace_until FROM users WHERE id=?").get(req.session.userId);
  // v7.14.0 — impersonation forced-exit. If the IMPERSONATED target's lifecycle
  // fails mid-impersonation (blocked / denied / deleted / unapproved /
  // unverified-past-grace), the session must NOT be destroyed — it is the
  // ADMIN's session. Restore the admin identity in place and reject this one
  // request with a recoverable marker the SPA turns into an "impersonation
  // ended" toast + a reload back into the admin view. The in-place flag restore
  // grants nothing a stale admin session couldn't already claim: requireAdmin /
  // requireSuperAdmin re-read the admin's own row on their very next request.
  if (req.session.impersonator) {
    // v7.15.8 — mirrors the entry gate: an unverified target no longer ends the
    // impersonation. Entering was pointless otherwise — the very next request
    // force-exited, so the admin never saw anything. Verification is a gate on
    // the participant signing in, not on an admin inspecting their view.
    const targetInactive = !user || user.blocked || user.denied_at || !user.approved;
    if (targetInactive) return restoreImpersonationTargetInactive(req, res);
  }
  if (!user) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Account not found" });
  }
  if (user.blocked) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Account is blocked" });
  }
  if (user.denied_at) {
    // Defence in depth: the deny path always sets blocked=1 in the
    // same txn (server.js v6.14.0), so this branch is only reachable
    // if an out-of-band write split the invariant. Treat denied as
    // terminal and destroy the session.
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Account has been denied" });
  }
  if (!user.verified) {
    // v7.2.0 — an unverified account inside its 48h verification grace (a
    // desk-code sign-in stamps it, lib/self-enroll.js) may keep using the app
    // while still unverified (the header shows a verify-by countdown). Once the
    // grace lapses — or for an unverified account that has none — fall through
    // to the existing rejection, which also covers a grace that expires
    // mid-session.
    //
    // v7.15.8 — EXCEPT under impersonation. An admin may now impersonate an
    // unverified participant precisely to see why that account is stuck, and
    // this branch calls req.session.destroy() — which would destroy the ADMIN's
    // session, the one thing every impersonation path is careful never to do.
    // The genuinely terminal states (blocked / denied / unapproved) already
    // returned above via the targetInactive check, which restores the admin
    // rather than destroying anything.
    if (!verificationGraceState(user).active && !req.session.impersonator) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Account is not verified" });
    }
  }
  if (!user.approved) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Account is not approved" });
  }
  next();
}

// v7.6.x — server-side profile-completion gate. The non-dismissible client
// overlay forces completion on login, but a scripted client (or one that removed
// the overlay) must ALSO be unable to take any participant action with an
// incomplete profile. Apply this AFTER requireParticipant on every participant
// ACTION endpoint — but NEVER on the endpoints an incomplete user needs to FIX
// their profile or manage their account: GET/PUT /api/me, PUT
// /api/me/sign-in-method, logout, resend-verification, csrf/config/status/
// keepalive. THAT LIST IS INDICATIVE, NOT A REGISTER — grep the middleware name
// for the live set (`competitions/:id/leave` and `me/certificates` are exempt
// too). Returns the same
// `400 {error:'profile_incomplete', missing:[...]}` shape as POST
// /api/select-competition.
//
// v8.8.23 — THE INTERCEPTOR DOES THIS NOW, and the two paragraphs below are kept
// because they are the record of how long it did not. `installFetchInterceptor`
// (`public/js/core/api.js`) recognises this exact shape on a 400, opens the
// completion gate, and RE-SENDS the request — so the 22 sites that used to render
// the raw token or eject with a false message never see it. It is deliberately
// PARTICIPANTS ONLY (the gate hides the Admin View button that is an admin's only
// way out of participant view) and carries a skip list, so the five eject sites
// keep their own `profile_incomplete` guards as defence in depth.
//
// v8.8.21 — THIS COMMENT USED TO SAY THE SPA's FETCH INTERCEPTOR TURNS THAT SHAPE
// INTO THE GATE. IT DID NOT, AND HAD NOT EVER DONE — until v8.8.23 above made it
// true, which is a different thing from the comment having been right. `installFetchInterceptor`
// (`public/js/core/api.js`) parses a body only on 401/403, so a 400 never reaches
// it: exactly TWO client sites branch on this error (`loadMyCompetitions` and
// `selectCompetition`, both hand-written), and the other 22 render the literal
// string `profile_incomplete` — in a toast, or, on the submit path, inside the RED
// `.result-msg wrong` panel that otherwise means "your answer was incorrect",
// directly after the participant accepted a modal warning of a permanent 5-point
// penalty. The comment was describing the fix somebody intended rather than the
// code, which is precisely how a reader comes to believe the class is handled. It
// is not; the deferred class is recorded in the old CLAUDE.md
// (git show e5f01929:CLAUDE.md), v8.7.3 entry.
//
// v8.8.22 — AND THE CORRECTION ABOVE WAS ITSELF WRONG IN ITS LAST CLAUSE, which
// is the same defect one release later and is why this now cites a measurement.
// It said the polled reads fall into "You are no longer in this event." as "a
// false claim about membership RE-FIRED EVERY FIFTEEN SECONDS". The claim is
// false, and it fires exactly ONCE: `ejectToCompetitionPicker`
// (`public/js/features/participant-tasks.js`) clears `statusPollInterval`,
// `lbInterval` and `stopCompDataPoll()` in its first four statements, so every
// producer of that message is torn down by the message itself. Driven in a real
// browser: one toast at t+15.0 s, nothing at t+30 s.
//
// The same run measured the half that matters more, and it is milder than the
// paragraph above implies: that eject calls `showMain('competitions-page')`,
// which calls `loadMyCompetitions` (`public/js/ui/nav.js`), which IS one of the
// two handling sites — so the completion gate opens **26 ms** behind the false
// toast, unprompted. A participant on a POLLED surface is misinformed for a
// moment and then correctly gated. A participant who CLICKS (open a challenge,
// submit, reveal a hint) gets no gate at all: the token is rendered and nothing
// else happens.
function requireCompleteProfile(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  // v8.4.0 — the shared fragment, because `_profileMissingFields` now throws on a
  // row that does not carry the registration-event join. One definition beats five
  // hand-written copies of it.
  const u = db.prepare(`SELECT ${PROFILE_GATE_COLUMNS} FROM users u ${PROFILE_GATE_JOIN} WHERE u.id=?`).get(req.session.userId);
  if (!u) { req.session.destroy(() => {}); return res.status(403).json({ error: "Account not found" }); }
  const missing = _profileMissingFields(u);
  if (missing.length) return res.status(400).json({ error: "profile_incomplete", missing });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    // v6.16.24 — distinguish "session is gone" (401) from "session is
    // valid but lacks admin role" (403). Pre-fix both returned 403, so
    // the SPA's session-expired interceptor (which gates on 401 + "Not
    // authenticated") couldn't recognise the expiry on admin-route
    // polls. The 15-s loadAdminLogs / scope-banner polls would then
    // continue forever, piling up 403s in the access log.
    if (!req.session.userId && req.session.builtinId !== "superadmin") {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.status(403).json({ error: "Forbidden" });
  }
  // Re-check DB role for user-admins — handles live demotion.
  // v6.13.19 — also re-check `blocked`. The normal block flow calls
  // invalidateOtherSessions, but if an admin session survives because
  // of stale/malformed session storage OR an out-of-band DB block (an
  // operator running an UPDATE directly), the role-only re-check that
  // existed pre-v6.13.19 left every admin route reachable until session
  // expiry. requireParticipant + requireSuperAdmin already do this
  // check; requireAdmin now matches.
  if (req.session.userId) {
    // v6.16.10 — re-check `denied_at` alongside role + blocked.
    // requireParticipant (v6.16.6) re-checks the full lifecycle —
    // requireAdmin / requireSuperAdmin should match for symmetry.
    // The deny path itself sets blocked=1 atomically, so this branch
    // is only reachable on a hypothetical out-of-band-split row
    // (denied_at set, blocked=0). Treat denied as terminal regardless.
    // v6.20.x — also re-check verified + approved, matching POST /api/login
    // (which rejects unverified/unapproved) and requireParticipant. Pre-fix a
    // user-backed admin whose verified/approved was cleared out-of-band (e.g. a
    // participant import overwrite, or a manual DB edit) kept admin access until
    // session expiry even though login would no longer grant it. (The built-in
    // superadmin has no userId, so this block is skipped for it.)
    // v8.7.0 — `event_admin` is an ADMIN TIER and passes here. What it may
    // actually reach is decided by two further things, neither of which belongs
    // in this guard: `eventAdminGuard` (a default-deny classification of every
    // /api/admin route) and the per-route row predicates in lib/event-admin.js.
    // requireSuperAdmin below deliberately does NOT admit it.
    const u = db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(req.session.userId);
    // v8.12.1 — THE EVENT-ADMIN VIEW'S FORCED EXIT, the requireParticipant
    // shape (above) for the admin-shaped impersonation session. Here
    // `req.session.userId` is the TARGET organiser, and the row read is about
    // them. Two things must not happen when that row stops qualifying
    // mid-session, and the plain branch below did both: it DOWNGRADED the
    // acting admin's session (flags cleared, marker intact, every admin-shell
    // poll answering a bare 403 the client does not recognise) and it never
    // closed the window in the target's History. So the acting admin is
    // RESTORED, not stranded, and the client meets the marker it already turns
    // into a toast and a reload.
    //
    // The ROLE is part of the test, in both directions, and `verified` is not
    // (the v7.15.8 rule): a target DEMOTED to participant has no admin view to
    // show, and a target PROMOTED to admin/superadmin would otherwise keep
    // serving — `isEventAdmin` turns false and the impersonated panel silently
    // widens to a GLOBAL admin's, past what entry would ever have granted.
    // Blocked / denied / unapproved are the same deliberate stops entry refuses.
    const _impAdm = req.session.impersonator;
    if (_impAdm) {
      const targetInactive = !u || u.blocked || u.denied_at || !u.approved || u.role !== "event_admin";
      if (targetInactive) return restoreImpersonationTargetInactive(req, res);
      // AND THE ACTING ADMIN IS RE-READ ON EVERY ADMIN REQUEST, GETs included.
      // `impersonationGuard` re-reads them on WRITES only (v7.21.12), which was
      // the whole exposure while the admin surface was unreachable; in the
      // organiser's panel every READ — participant lists carrying PII, the
      // exports — is now on the table, and the row that gates them is the
      // TARGET's. A blocked or demoted ex-admin must not keep an organiser's
      // read surface for the life of a cookie. Same predicate and disposition as
      // the guard and the exit route: no admin identity left to hand back, so
      // destroy rather than restore. The built-in account has no row to read.
      if (_impAdm.builtinId !== "superadmin") {
        const a = _impAdm.userId ? db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(_impAdm.userId) : null;
        if (!a || !organiserPanelOpensTo(a.role) || a.blocked || a.denied_at || !a.verified || !a.approved) {
          return destroyImpersonationSession(req, res); // closes the target's window first (v8.12.1)
        }
      }
    }
    // v8.12.1 — an impersonation session was fully decided above (the target's
    // `verified` is deliberately not part of that decision, per v7.15.8), so
    // the plain lifecycle branch must not re-ask it and strand the session.
    // RBAC — any role whose class is not `none` is an admin tier (the built-in
    // admin, superadmin and event admin, and every custom admin role); an
    // unknown role key is `none` and refused.
    if (!_impAdm && (!u || u.blocked || u.denied_at || !u.verified || !u.approved || roleClass(u.role, { live: true }) === "none")) {
      req.session.isAdmin = false;
      req.session.isSuperAdmin = false;
      return res.status(403).json({ error: "Forbidden" });
    }
    // Also sync superadmin flag in case role was downgraded from superadmin to admin
    if (!u || u.role !== "superadmin") req.session.isSuperAdmin = false;
  }
  next();
}

// v8.7.0 — the tier that may GRANT the event-admin role, i.e. admin or
// superadmin but NOT an event admin. Stated as its own guard rather than folded
// into the deny-list, so a route declares its own tier and reads correctly on its
// own: the global guard decides whether an endpoint is theirs at all, this
// decides whether an endpoint that IS reachable may be used to self-propagate.
function requireGlobalAdmin(req, res, next) {
  if (req.session.builtinId === "superadmin") return next();
  const role = req.session.userId
    ? db.prepare("SELECT role FROM users WHERE id=?").get(req.session.userId)?.role
    : null;
  if (role === "admin" || role === "superadmin") return next();
  // RBAC — a CUSTOM role passes when it holds, live, this route's permission.
  // Not under an impersonation seat: the seat is a built-in event admin.
  if (!req.session.impersonator && role && !isBuiltinRole(role)) {
    if (customRoleAllows(req, role)) return next();
    const perm = routePermissionFor(req.method, require("./util").normaliseRoutePath(req.path || ""));
    return res.status(403).json({ error: permissionDeniedCopy(perm), code: "permission_denied", permission: perm });
  }
  return res.status(403).json({
    error: "Only an administrator can make this change.",
    code: "event_admin_forbidden",
  });
}

/**
 * RBAC — the route guard for routes added with roles (Users & roles): the
 * actor's role must hold `perm`, read LIVE and uncached, with the account's
 * lifecycle re-read as `requireAdmin` does. The built-in break-glass account
 * holds every permission. Never through an impersonation seat (no role or user
 * management in somebody else's panel). Refusals: 401 with no identity, 403
 * `permission_denied` otherwise.
 */
function requirePermission(perm) {
  if (!require("./rbac").PERMISSION_IDS.has(perm)) throw new Error(`requirePermission: unknown permission ${JSON.stringify(perm)}`);
  return function requirePermissionMw(req, res, next) {
    const s = req.session;
    if (!s || (!s.userId && s.builtinId !== "superadmin")) return res.status(401).json({ error: "Not authenticated" });
    const refuse = () => res.status(403).json({ error: permissionDeniedCopy(perm), code: "permission_denied", permission: perm });
    if (!s.isAdmin || s.impersonator) return refuse();
    if (s.builtinId === "superadmin") return next();
    const u = db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(s.userId);
    if (!u || u.blocked || u.denied_at || !u.verified || !u.approved) return refuse();
    const def = require("./rbac").roleDefinition(u.role, { live: true });
    if (!def || def.scope_mode === "none" || !def.perms.has(perm)) return refuse();
    return next();
  };
}

function requireSuperAdmin(req, res, next) {
  // RBAC — a CUSTOM role reaches a superadmin-tier route only by holding, read
  // live and uncached, that route's permission (only a superadmin can grant
  // one). Its own lifecycle is re-read here, as below. Built-in roles take the
  // unchanged path that follows.
  if (!req.session.isSuperAdmin && req.session.isAdmin && req.session.userId && !req.session.impersonator) {
    const c = db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(req.session.userId);
    if (c && c.role && !isBuiltinRole(c.role) && roleClass(c.role, { live: true }) !== "none") {
      if (!c.blocked && !c.denied_at && c.verified && c.approved && customRoleAllows(req, c.role)) return next();
      const perm = routePermissionFor(req.method, require("./util").normaliseRoutePath(req.path || ""));
      return res.status(403).json({ error: permissionDeniedCopy(perm), code: "permission_denied", permission: perm });
    }
  }
  if (!req.session.isSuperAdmin) {
    // v6.16.24 — same 401-vs-403 split as requireAdmin (see comment there).
    if (!req.session.userId && req.session.builtinId !== "superadmin") {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.status(403).json({ error: "Forbidden — superadmin only" });
  }
  // v6.13.18 — same DB re-check as requireAdmin (server.js:2523). Pre-fix,
  // a superadmin who got demoted could still hit a route guarded only by
  // requireSuperAdmin (e.g. /api/admin/test-email) for the rest of their
  // session lifetime, because the session flag was the sole authority.
  // Block check is symmetric with requireParticipant — a blocked user must
  // not retain elevated routes either, even if their session somehow
  // outlived `invalidateOtherSessions`.
  // Built-in superadmin (no userId) skips this branch — same as requireAdmin.
  if (req.session.userId) {
    // v6.16.10 — re-check `denied_at` alongside role + blocked.
    // v6.20.x — + verified/approved, matching login + requireAdmin.
    const u = db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(req.session.userId);
    if (!u || u.role !== "superadmin" || u.blocked || u.denied_at || !u.verified || !u.approved) {
      req.session.isSuperAdmin = false;
      if (!u || roleClass(u.role, { live: true }) === "none") req.session.isAdmin = false;
      return res.status(403).json({ error: "Forbidden — superadmin only" });
    }
  }
  next();
}

// ── Competition + timeslot context (attached from session) ──────────────────

// v8.14.4 (external audit R2) — THE EVENT THIS TAB IS SHOWING. Tabs share one
// session and a session holds one event, so selecting another event in a
// second tab moved the first tab's answers, hints and penalties onto it
// without a word: the first tab still showed its challenge, and the submit
// was graded against the event the session held now. Each tab names its event
// in this header (public/js/core/api.js); a request naming a different one
// than the session holds is refused before anything is read or written, and
// the tab is told. Absent means unchecked: only the SPA has tabs, and it
// always sends it.
const TAB_EVENT_HEADER = "x-competition-id";
const EVENT_CHANGED_CODE = "competition_changed";
/** `comp` is the event the session holds, or null when it holds none: another
 *  tab left it (the Events list). That case is answered only for an event that
 *  still exists, this session may see and its account is still in (a row, or
 *  staff, who need none): a deletion, a narrowed scope and an organiser's
 *  REMOVAL (which also clears the session's event) keep their own answers, the
 *  last being the one that says "You are no longer in this event". The
 *  sentences claim no cause: the tab that sent the request may have moved
 *  itself, and its caller then shows this one. */
function tabEventMismatch(req, comp) {
  const shown = req.get(TAB_EVENT_HEADER);
  if (typeof shown !== "string" || !shown) return null;
  if (!comp) {
    if (impersonationScopeDenied(req, shown) || !getCompetition(shown)) return null;
    const uid = req.session.userId;
    if (!uid || (!isStaff(uid) && !db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(shown, uid))) return null;
    return {
      error: "This request was for an event this browser has since left, so nothing was recorded.",
      code: EVENT_CHANGED_CODE, competition_id: null, competition_name: null,
    };
  }
  if (shown === comp.id) return null;
  return {
    error: `This request was for a different event from the one this browser has open now (“${comp.name}”), so nothing was recorded.`,
    code: EVENT_CHANGED_CODE, competition_id: comp.id, competition_name: comp.name,
  };
}
/** Answer a tab-event mismatch. A file submission reaches this before multer
 *  has read its body, so the refusal drains it rather than cutting it. */
function refuseTabEventMismatch(req, res, body) {
  refuseBeforeBody(req, res, 409, body);
}

function requireCompetitionContext(req, res, next) {
  // v7.6.x — every competition-scoped endpoint funnels through here (status,
  // tasks read/submit/hint/feedback, leaderboard, dismiss-ended). A complete
  // profile is required to SELECT a competition in the first place, so this only
  // bites the admin-cleared-a-field-mid-session edge — but it closes it: an
  // incomplete profile can take NO competition action, even with a live session.
  if (req.session.userId) {
    const _pu = db.prepare(`SELECT ${PROFILE_GATE_COLUMNS} FROM users u ${PROFILE_GATE_JOIN} WHERE u.id=?`).get(req.session.userId);
    if (_pu) {
      const _missing = _profileMissingFields(_pu);
      if (_missing.length) return res.status(400).json({ error: "profile_incomplete", missing: _missing });
    }
  }
  const compId = req.session.competitionId;
  if (!compId) {
    const _left = tabEventMismatch(req, null);
    if (_left) return refuseTabEventMismatch(req, res, _left);
    return res.status(400).json({ error: "No event selected" });
  }

  // v8.8.6 — RE-ASSERTED HERE, because select-competition is not the only way a
  // session can hold a competition id: a grant revoked mid-session leaves one
  // already selected, and this is what stops it continuing to serve. Closing it
  // here is also what closes /api/tasks, /api/tasks/:id (which on an ended event
  // with reveal-answers-on returns another organiser's ANSWER KEY) and
  // /api/leaderboard (which names a third participant's nickname and score) —
  // none of which is filtered itself, deliberately: a partially redacted
  // leaderboard is a wrong answer, and the right outcome is that the event does
  // not open at all.
  //
  // IT HAS ITS OWN BRANCH, AND MUST. The not-found branch below durably NULLs the
  // TARGET's active_competition_id and emits an audit event against them — so a
  // GET by an admin who is merely looking would silently clear a real
  // participant's auto-resume marker. Only the acting admin's throwaway session
  // fields are cleared here; nothing is written to the users table.
  {
    const _scopeDenied = impersonationScopeDenied(req, compId);
    if (_scopeDenied) {
      req.session.competitionId = null;
      req.session.timeslotId = null;
      return res.status(403).json({ error: _scopeDenied.message, code: _scopeDenied.code });
    }
  }

  const comp = getCompetition(compId);
  if (!comp) {
    // Competition was deleted — clean up stale session state
    req.session.competitionId = null;
    req.session.timeslotId = null;
    if (req.session.userId) {
      const r = db.prepare("UPDATE users SET active_competition_id=NULL WHERE id=? AND active_competition_id=?").run(req.session.userId, compId);
      if (r.changes) try { recordUserEvent(req.session.userId, "active_competition_changed", "system", { from: compId, to: null, reason: "parent_deleted", ...reqContext(req) }); } catch (e) { swallowed("middleware:marker-cleared-emit", e); }
    }
    return res.status(404).json({ error: "Event not found. It may have been deleted. Please select a new event." });
  }
  req.competition = comp;
  // After the scope and existence branches, so a deleted event still answers
  // 404 and clears the session, and no event's name is told to a session that
  // may no longer see it.
  {
    const _moved = tabEventMismatch(req, comp);
    if (_moved) return refuseTabEventMismatch(req, res, _moved);
  }
  // v6.20.x — fetch this competition's timeslots ONCE and attach them so the
  // status/end/fully-ended helpers downstream can be passed `slots` instead of
  // each re-issuing `getCompetitionTimeslots(comp.id)`. /api/status (polled
  // every 15 s by every participant) previously caused 4 identical timeslot
  // SELECTs per request; reusing req.competitionSlots collapses them to this
  // single read. Mirrors the slots-batching already done in /api/me.
  req.competitionSlots = getCompetitionTimeslots(comp.id);
  req.competitionStatus = competitionStatus(comp, req.competitionSlots);
  // Attach timeslot if selected
  const tsId = req.session.timeslotId;
  if (tsId) {
    const ts = getTimeslot(tsId);
    if (ts && ts.competition_id === compId) {
      req.timeslot = ts;
      req.timeslotStatus = timeslotStatus(ts);
    } else {
      // Invalid/deleted timeslot — clear from session and DB
      req.session.timeslotId = null;
      req.timeslot = null;
      req.timeslotStatus = null;
      if (req.session.userId) {
        const _tsClear = db.prepare("UPDATE competition_users SET timeslot_id=NULL WHERE competition_id=? AND user_id=? AND timeslot_id=?")
          .run(compId, req.session.userId, tsId);
        // audit-event-logging audit (v7.7.15) — parity with active_competition_changed
        // above: a deleted/invalid slot being cleared is a system-driven membership
        // state change worth a forensic row.
        if (_tsClear.changes) try { recordUserEvent(req.session.userId, "timeslot_cleared", "system", { competition_id: compId, timeslot_id: tsId, reason: "invalid_or_deleted", ...reqContext(req) }); } catch (e) { swallowed("middleware:timeslot-cleared-emit", e); }
      }
    }
  } else {
    req.timeslot = null;
    req.timeslotStatus = null;
  }
  // v8.6.0 — THE LATE-ENTRY STATE, resolved ONCE per request and attached, so the
  // four gates that read it (submit x2, hint, /api/status) cannot each re-derive it
  // and cannot disagree about the same request's clock. It rides here for the
  // reason `req.competitionSlots` does: this middleware is the funnel every
  // competition-scoped endpoint passes through, and resolving it per gate would be
  // the same query three times on the submit path alone.
  //
  // Costs nothing on the ordinary path: `lateEntryStateFor` returns immediately
  // when the event runs no late window, which is every Competition, every Program
  // and any Booth Event with the toggle off.
  req.lateEntry = lateEntryStateFor(comp, req.session.userId, req.competitionSlots);
  _stampLoginTimeIfLive(req);
  next();
}

// v7.21.3 — the LAZY solve-clock anchor.
//
// `competition_users.login_time` is what `solveTimeMs` measures from, and
// time-to-solve is the SOLE tie-breaker on a score tie. It was written by only
// three statements, all in select-competition / select-timeslot and all gated on
// the entity being live AT THE MOMENT OF THAT CALL. Selecting an UPCOMING
// competition stamps nothing, and status is TIME-DERIVED — nothing requests
// anything when it flips — so the lobby path left it NULL: the pending page's
// 1-second tick navigates straight to the tasks page and clears the 15 s poll
// that would have re-selected, so in ~14 of 15 starts no re-select ever happens.
// `buildLeaderboardEntries` then falls back to COALESCE(login_time, first
// submission/hint), i.e. the clock starts at their first ATTEMPT — rewarding the
// time spent reading. Two participants with identical scores and identical
// finish times got different times purely from how they navigated in.
//
// Stamping here rather than in the client is deliberate: this runs on EVERY
// competition-scoped endpoint (notably /api/status, polled every 15 s), so it
// cannot be bypassed by navigation, and it needs no upcoming→live hook that the
// time-derived status model cannot provide.
function _stampLoginTimeIfLive(req) {
  const userId = req.session.userId;
  const comp = req.competition;
  if (!userId || !comp) return;
  // v7.14.0 — peeking must NEVER start the target's clock. Same suppression the
  // select-competition path applies, and for the same reason.
  if (isImpersonating(req)) return;
  // Only a LIVE entity anchors the clock — mirrors the existing rule exactly.
  // For a multi-slot competition the participant's own slot is what governs.
  const live = req.timeslot ? req.timeslotStatus === "live" : req.competitionStatus === "live";
  // v8.6.0 — a LATE ENTRANT anchors here too, and it is not a nicety.
  //
  // Their window is open while the event's is not, so the live-only rule left them
  // with `login_time` NULL — and the leaderboard's fallback then anchors them at
  // their first SUBMISSION, which is the "the clock starts at their first attempt,
  // rewarding the time spent reading" unfairness v7.21.3 fixed for the lobby path,
  // reappearing through a different door. Worse, the board's own membership test is
  // `login_time IS NOT NULL OR EXISTS(submission) OR EXISTS(hint)`, so until they
  // acted they were invisible on every board and `_mintEligibility` answered "You
  // did not participate in this competition."
  //
  // `canPlay` rather than `open`, so an ORDINARY participant of the same event is
  // not re-anchored during the window — their event is over and their clock is
  // settled.
  if (!live && !(req.lateEntry && req.lateEntry.canPlay)) return;
  let stamped = false;
  try {
    const row = db.prepare("SELECT login_time FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId);
    if (!row || row.login_time) return;          // not a member, or already anchored
    const loginNow = clockNow().toISOString();
    // v8.12.0 — the HONEST anchor: never later than activity already recorded
    // (a staff spectator's solves precede their row — lib/competitions.js
    // `anchorLoginTime` says why that is the tie-break's sharpest door).
    const anchor = anchorLoginTime(userId, comp.id, loginNow);
    // `AND login_time IS NULL` makes this idempotent under any concurrent write.
    stamped = db.prepare("UPDATE competition_users SET login_time=?, last_login_time=? WHERE competition_id=? AND user_id=? AND login_time IS NULL")
      .run(anchor, loginNow, comp.id, userId).changes > 0;
    if (stamped) invalidateLeaderboardCacheForEntrant(comp.id);   // a new zero-score row: coalesced (lib/leaderboard.js)
  } catch (_) { return; }
  if (!stamped) return;
  // Parity with the select-competition path, which emits first_joined when it
  // stamps. Best-effort: an audit failure must never break the request.
  try {
    const email = db.prepare("SELECT email FROM users WHERE id=?").get(userId)?.email || "system";
    recordUserEvent(userId, "first_joined", email, {
      ...reqContext(req),
      competition_id: comp.id, competition_name: comp.name,
      ...(req.timeslot ? { timeslot_id: req.timeslot.id, timeslot_name: req.timeslot.name } : {}),
      via: "first_live_access",
    });
  } catch (e) { swallowed("middleware:login-time-stamp", e); }
}

// v8.3.9 — "a participant is asked to choose an event ONCE", applied at EVERY
// door rather than at one of them.
//
// v8.3.8 built the rule and wired it into `POST /api/login` alone, so the promise
// held for a password sign-in and silently did not for the other two ways an
// existing account gets a session: **LinkedIn** and the **emailed sign-in code**.
// Both establish a session and redirect/reload into the SPA, whose boot routes
// off `req.session.competitionId` — which neither of them set — so the
// participant met the event picker again, exactly as before the feature.
//
// IT READS THE MARKER COLUMN ITSELF rather than taking it off a row the caller
// happened to SELECT. Three of the four call sites hold a partial `users` row,
// and a column-naming SELECT is a list that rots (v8.1.0 paid for this three
// times in one release: `attempt_cap`, `deadline_at`, `profile_policy`). Reading
// it here means a caller CANNOT under-select its way into silently losing the
// resume — the whole failure class is removed rather than documented.
//
// It lives beside `_stampLoginTimeIfLive` because it encodes the same rule about
// the same thing: in a multi-session event the participant is pinned to their own
// session, so that session's status is the question, not the competition's.
//
// Returns the competition id it resumed into, or null. Callers that report the
// verdict to a client use the return value; the rest simply need the session
// pointed at it. Best-effort by construction — a sign-in must never fail because
// a navigation convenience could not be applied.
function applyAutoResumeToSession(req, userId) {
  if (!userId) return null;
  let marker = null;
  try {
    marker = db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(userId)?.active_competition_id || null;
  } catch (_) { return null; }
  // v8.3.12 — NO MARKER IS THE COMMON CASE, and it is where the reported defect
  // lives: a participant who has never chosen anything still has a sole event to
  // be landed in. Falling through here rather than returning is what makes the
  // two rules one answer.
  if (!marker) return _soleCompetitionLanding(req, userId);

  let resume = null;
  let assignedTs = null;
  try {
    const comp = getCompetition(marker);
    if (comp) {
      const assigned = db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(marker, userId);
      // Staff enter any event WITHOUT an assignment row — select-competition
      // admits them and writes the marker — so demanding one here would make a
      // staff member's marker unreadable the moment it was written.
      if (assigned || isStaff(userId)) {
        assignedTs = assigned?.timeslot_id || null;
        // v8.3.15 — NO STATUS TEST. The marker wins whatever the event is doing:
        // live, not yet started, or finished. What survives here is the pair of
        // conditions that are not about the event at all — it still EXISTS, and
        // this participant is still IN it — because resuming past either would
        // put them somewhere the very next request refuses.
        //
        // THE MEMBERSHIP ARM IS DEFENCE IN DEPTH, and saying so beats claiming a
        // guard the tests do not exercise (v8.1.5). Every removal path — the admin
        // DELETE and the group-sync reconciler — clears `active_competition_id` in
        // the same breath, so by the time a removed participant signs in there is
        // no marker left to read: mutating this to `if (true)` leaves the suite
        // green, measured. It stays because the two facts are stored separately
        // and a future writer that forgets the clear would otherwise resume
        // someone into an event they are not in. The `isStaff` arm IS exercised —
        // staff hold no assignment row at all.
        if (autoResumeAllows(comp)) resume = marker;
      }
    }
  } catch (_) { return null; }

  if (!resume) {
    // The marker no longer names an event worth returning to: deleted, or the
    // participant has been removed from it. Drop it, so the decision is made
    // once rather than re-litigated on every sign-in.
    try {
      db.prepare("UPDATE users SET active_competition_id=NULL WHERE id=?").run(userId);
      recordUserEvent(userId, "active_competition_changed", "system", { ...reqContext(req), from: marker, to: null, reason: "login_cleanup" });
    } catch (e) { swallowed("middleware:login-marker-cleanup", e); }
    return _soleCompetitionLanding(req, userId);
  }

  req.session.competitionId = resume;
  if (assignedTs) req.session.timeslotId = assignedTs;
  return resume;
}

/**
 * v8.3.12 — THE SECOND SIGN-IN LANDING RULE: with exactly ONE event, there is no
 * choice to make, so make it.
 *
 * This has shipped since long before the marker existed — but only in
 * `doLogin()`, the PASSWORD door's client handler. So the same participant signing
 * in through LinkedIn landed on the event list while the password door took them
 * straight in, and the difference was invisible from the server. That is v8.3.9's
 * finding for the second time: a rule implemented once and applied at a fraction
 * of its sites. It moves HERE, beside the marker rule, because these two are the
 * same question — *where should this sign-in land?* — and the four doors already
 * ask it in one place.
 *
 * IT RUNS AT A SIGN-IN AND NOWHERE ELSE, and that is what keeps v8.3.8 intact.
 * `boot()` routes off `req.session.competitionId` on EVERY authenticated page
 * load, so putting this rule there instead would have re-broken the refresh
 * v8.3.8 fixed: `POST /api/deselect-competition` clears the session pointer AND
 * the marker precisely so that reloading while looking at the event list stays on
 * the event list. A door is a door; a page load is not.
 *
 * A REFUSED MARKER FALLS THROUGH TO IT, deliberately. An ENDED event is exactly
 * the case the operator reported, and once the marker is cleared for being ended
 * the participant is in the "no marker" state — where, with one event, the answer
 * is the same as it always was on the password door.
 *
 * `withTimeslots` is off: the only thing read is the COUNT and the id, and the
 * per-slot batch is real work at every sign-in for a list that is usually one row
 * or hundreds. The timeslot pointer is deliberately NOT set either — that is a
 * CHOICE the participant makes in the picker, and `requireCompetitionContext`
 * routes them to it when a multi-session event has none.
 */
function _soleCompetitionLanding(req, userId) {
  try {
    // A DELIBERATE DEPARTURE OUTLIVES THE SESSION. `active_competition_id` being
    // NULL says "nothing is pinned" and cannot say "they unpinned it", so without
    // `left_event_at` this rule would put a single-event participant straight back
    // in at the next sign-in and v8.3.8's opt-out would be real for everyone
    // except the people it matters most to. Cleared the moment they choose again.
    const left = db.prepare("SELECT left_event_at FROM users WHERE id=?").get(userId)?.left_event_at;
    if (left) return null;

    // v8.12.0 — OWN rows for everybody, `staff:false` deliberately. The staff
    // branch of `listParticipantCompetitions` is the whole platform, so for a
    // staff member "exactly one" was never true and this rule never fired; now
    // that a staff member can HOLD a row, the operator's decision is that the
    // rule reads their own rows exactly as it reads a participant's — one event
    // they were put in, of any status, and they land in it.
    const comps = listParticipantCompetitions(userId, { staff: false });
    if (!Array.isArray(comps) || comps.length !== 1) return null;
    const comp = getCompetition(comps[0].id);
    if (!comp) return null;

    // THE KIND'S POLICY STILL DECIDES, through the same predicate the marker rule
    // uses — so the two landing rules cannot disagree about what a kind allows.
    // As of v8.3.15 every kind allows it; the check remains because the policy
    // table is where a future exclusion would be written.
    if (!autoResumeAllows(comp)) return null;

    // AN ENDED EVENT IS ALLOWED HERE TOO. Since v8.3.15 that is no longer a place
    // this rule parts company with the marker rule — both land in a finished
    // event — but it is worth stating, because it was the reported case: one
    // event, over, and the password door went straight in while every other door
    // showed a list holding a single card.
    req.session.competitionId = comp.id;
    return comp.id;
  } catch (_) { return null; }
}

/**
 * v8.3.12 — STAMP THE LOGIN CLOCKS. `users.last_login_time` is what the admin
 * Participants table renders as **Last Login**, and `users.login_time` is the
 * first-ever one.
 *
 * NEITHER LinkedIn door wrote them. So a participant who signs in with LinkedIn
 * every day showed a Last Login of whenever they last used a password — or blank
 * for an account that has never had one, which is every LinkedIn account, since
 * neither LinkedIn INSERT stamps `password_set_at`. An organiser reading that
 * column to see who has turned up was reading a column that only two of the four
 * doors maintained.
 *
 * Same shape as `applyAutoResumeToSession` and for the same reason: one
 * definition, called at every door, with the scanner in
 * `tests/event-auto-resume.spec.js` enumerating the doors structurally off
 * `login_success` rather than off a list of names that goes stale.
 *
 * `login_time` is guarded on being unset because it means FIRST login and is read
 * that way; `last_login_time` is written unconditionally.
 *
 * NOT BEST-EFFORT: A FAILED STAMP FAILS THE SIGN-IN. The two columns are more
 * than the Participants table's statistics: they are the only record that an
 * account has ever signed in (`hasSignedIn`, lib/login-code.js), and the desk's
 * Show sign-in code is offered only to an account that never has (operator
 * ruling, 14 Nov 2026). A swallowed failure would let a signed-in account read
 * as never signed in and reopen that reveal, so the error propagates to the
 * caller's error handler (a 500, logged at error level) before `_signInAs` grants
 * a session. Every door calls this just after another write to the same row
 * (the lockout clear or the account's creation), so it adds no failure a busy
 * database would not already cause there.
 */
function stampLoginTimes(userId, atIso) {
  if (!userId) return;
  const iso = atIso || clockNow().toISOString();
  db.prepare("UPDATE users SET login_time=COALESCE(login_time, ?), last_login_time=? WHERE id=?").run(iso, iso, userId);
}

/**
 * v8.11.1 (external audit F3) — MAY THIS PARTICIPANT STILL ACT IN THIS EVENT?
 *
 * Both participant guards run BEFORE the request body is parsed — multer is
 * mounted inside the submit route's own chain — so on a file submission the
 * account's lifecycle and its membership are read once, at request entry, and a
 * 64 MB upload on venue wi-fi then runs for as long as it takes. An admin who
 * blocks somebody for cheating, or removes them from the event, gets a 200 back
 * and the suspended submission commits afterwards anyway: MEASURED at 30 s with
 * no test hook, the answer graded, 50 points awarded, and the event auto-ended
 * by a participant who had been blocked half a minute earlier.
 *
 * WHY A PURE PREDICATE RATHER THAN ANOTHER INLINE COPY. `requireParticipant`
 * spells this out already (the `targetInactive` line and the four branches under
 * it); another spelling inside a write transaction is exactly the class *Six
 * re-invented copies* (v7.21.13) forbids. The guards cannot simply
 * call this one wholesale — they destroy sessions and they handle impersonation,
 * neither of which belongs in a transaction — so the shared part is the QUESTION
 * and each caller keeps its own answer.
 *
 * `verified` is deliberately NOT asked. The guard's own branch exempts an
 * impersonated target (v7.15.8) and an unverified account inside its 48 h
 * verification grace (v7.2.0); re-asking it here would refuse a submission the request-entry
 * guard had just admitted, which is a new defect rather than a fix.
 *
 * `isStaff` is kept for the same reason `requireParticipantInCompetition` has
 * it: staff hold no `competition_users` row by design.
 *
 * Returns `{status, error, lifecycle?}` or null. `lifecycle` marks an ACCOUNT
 * refusal (never sent to a client): under impersonation the account is the
 * seat's, and `sendParticipantSessionDenial` answers it with requireParticipant's
 * own forced exit. Every read is an indexed point lookup (`users` PK, the
 * `competition_users` covering index, the cached user tags), so it is cheap
 * enough to ask inside a write transaction.
 */
function participantAccountDenied(userId) {
  if (!userId) return { status: 401, error: "Not authenticated" };
  const u = db.prepare("SELECT blocked, approved, denied_at FROM users WHERE id=?").get(userId);
  if (!u) return { status: 403, error: "Account not found", lifecycle: true };
  if (u.blocked) return { status: 403, error: "Account is blocked", lifecycle: true };
  if (u.denied_at) return { status: 403, error: "Account has been denied", lifecycle: true };
  if (!u.approved) return { status: 403, error: "Account is not approved", lifecycle: true };
  return null;
}
function participantAuthzDenied(userId, compId) {
  const a = participantAccountDenied(userId);
  if (a) return a;
  if (!compId) return { status: 400, error: "No event selected" };
  if (isStaff(userId)) return null;
  const row = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId);
  if (!row) return { status: 403, error: "You are not assigned to this event" };
  return null;
}

/**
 * v8.12.6 (external audit F1) — MAY THIS ADMIN SESSION STILL COMMIT THE WRITE IT
 * STARTED?
 *
 * The admin twin of `participantAuthzDenied` above, for the same reason one tier
 * up. `requireAdmin` / `requireSuperAdmin` run when the request HEADERS arrive,
 * and every admin write that AWAITS before it writes decided its authorisation
 * that long ago: the uploads and the imports (a file — multer is mounted AFTER
 * the guard, then the handler walks the ZIP, hashes it and moves it; the 128 MB
 * parser is mounted after `requireSuperAdmin`) and, since v8.12.7, the desk shortcut and the
 * maintenance seeder (which await only the test park, and keep the re-check
 * at commit). Grep `adminAuthzDenied(` for the set,
 * and a source scanner (functional-core-b, the v8.12.7 admin-tier twin) fails a
 * new route of the class that does not call it. MEASURED before this existed,
 * every upload and import answered 200 after a colleague
 * had blocked, demoted or deleted the admin mid-request: a blocked superadmin's
 * participant import minted a new verified SUPERADMIN account, and an event admin
 * demoted or deleted mid-body uploaded to a challenge they did NOT own — the scope
 * predicates read any non-event-admin role (or a missing row) as UNSCOPED,
 * trusting `requireAdmin` to have vouched for the tier, which it had, a body ago.
 *
 * ASKED AFTER THE LAST AWAIT, SYNCHRONOUSLY WITH THE WRITE — never at the guard
 * alone, which the imports' 128 MB body parse (mounted after `requireSuperAdmin`)
 * outlives, nor at handler entry alone, which the upload's validate/hash/move
 * tail and the task import's attachment validation outlive. Two source
 * scanners (functional-core-b) hold the placement: the v8.12.6 one for a route
 * that parses its body after its guard, the v8.12.7 twin for every admin write
 * that awaits before it writes. (Measured, 3 of 3: with nothing re-asked, the
 * desk shortcut awaiting between its guard and its commit created a new,
 * verified, approved account and handed over a live sign-in code after its
 * admin had been blocked mid-await; a demoted superadmin's seeder could mint
 * `role:"superadmin"` rows.)
 *
 * WHAT IS RE-ASKED, and why each:
 *   • a plain session's OWN row — lifecycle AND role, UNCACHED (`_cachedRole`'s
 *     2 s window is the window a demotion lands in). `verified` IS asked, unlike
 *     the participant predicate: `requireAdmin` asks it of an admin. `tier`
 *     narrows the role set to the guard the route sits behind — "superadmin"
 *     for the imports and the seeder, "global" (v8.12.7) behind
 *     `requireGlobalAdmin` — see `ADMIN_TIER_ROLES` below.
 *   • under impersonation, BOTH people (v8.12.1). The HAND through
 *     `actingIsSuperAdmin` — the existing uncached acting-admin read, not a new
 *     copy — because only a superadmin's write goes through a seat (a regular
 *     admin's is read-only, `impersonationGuard`). The SEAT with `requireAdmin`'s
 *     own forced-exit predicate, deliberately WITHOUT `verified` (v7.15.8), and
 *     answered with that predicate's own shape (`impersonation_ended` +
 *     `target_inactive`) so every client that already turns it into a toast and
 *     a reload recognises it. The restore itself is left to the NEXT request's
 *     `requireAdmin`: it mutates the session and has no place inside a
 *     transaction. Only an ADMIN-shaped impersonation (an organiser's panel)
 *     reaches an admin write — `requireAdmin` refuses a participant-shaped one by
 *     its first line. A tier above "admin" REFUSES here (v8.12.7): the seat is
 *     an event admin, which neither `requireGlobalAdmin` nor `requireSuperAdmin`
 *     admits — both refuse such a session at the headers, so the arm is
 *     unreachable today and fails closed rather than letting the hand's tier
 *     stand in for the seat's.
 *   • the session itself: a route-driven revocation TOMBSTONES the session id
 *     before deleting it (lib/sessions.js), and so does every `regenerate()` and
 *     `destroy()` (the v8.11.1 F1 store wrapper). COMPLEMENTARY, not a
 *     substitute: an out-of-band block (a participant-import overwrite, direct
 *     SQL) writes no tombstone, and a sign-in elsewhere, a password change made
 *     in another browser, a logout or the same user's view toggle in another tab
 *     write one without
 *     touching the row — and so does a COLLEAGUE: a role change inside the admin
 *     tiers (admin ⇄ superadmin, either → event admin) purges every session the
 *     account holds while the row still qualifies, and so does the idle sweep
 *     reaching a session whose request outlived its 60 minutes. It is the ONLY
 *     signal the built-in superadmin has (no `users` row). So the copy names NO
 *     cause — the session ended, which is all that is known, and it may have been
 *     the admin's own doing or a colleague's — and its remedy is conditional:
 *     after a view toggle the browser already holds a live session and is not
 *     asked to sign in, after a purge it is (v8.12.6 review, which found the
 *     first copy listing only the admin's own actions).
 *
 * WHAT IS NOT RE-ASKED HERE: ownership, scope and the competitor lock, which are
 * questions about an ENTITY, not about the actor — the direct upload re-asks the
 * owner gate and the lock itself, beside its lock re-check (v7.21.1 A5), and the
 * desk shortcut re-asks the lock and its event scope itself, in its write
 * transaction, on a FRESH role and grant set (it drops the actor's 2 s
 * event-admin caches first, because a grant revoke writes no tombstone). Note
 * what that leaves: admin/superadmin → event_admin NARROWS scope and is ADMITTED
 * by this predicate. A route-driven narrowing is caught by the tombstone arm; an
 * out-of-band one is caught on the direct upload by that route's own owner
 * re-ask and at the desk by its scope re-ask, and on staging it does not matter
 * (a staged row is the actor's own, promoted only through a fresh
 * `requireAdmin`).
 *
 * This is the sixth spelling of the admin lifecycle SELECT, deliberately not
 * unified with the guards': they destroy or restore sessions and give different
 * answers, so — as for the participant twin — the shared part is the QUESTION
 * and each caller keeps its own answer.
 *
 * Returns null, or `{status, error, code, reason?}` for the caller to send as
 * `{error, code, reason?}`. Indexed point reads only — cheap enough to ask inside
 * a write transaction.
 */
const ADMIN_ACCESS_ENDED_ERROR = "Your administrator access has ended, so nothing was saved.";
// v8.12.7 — ACTION-NEUTRAL. It said "before your upload finished" while the two
// imports and, since this release, the desk shortcut and the seeder answer it
// too — an admin adding a walk-up at the desk has uploaded nothing.
const SESSION_ENDED_ERROR = "Your session ended before this finished, so nothing was saved. Try again — if you are asked to sign in, do that first.";
// v8.12.7 — THE TIERS, one per admin guard, stated POSITIVELY (the role sets a
// tier ADMITS), so a tier spelled wrong fails closed instead of silently taking
// the widest set — the pre-v8.12.7 ternary read every non-"superadmin" value as
// the admin tier. Each mirrors its guard's question exactly:
//   • "admin"      — `requireAdmin`: admin, superadmin, event admin.
//   • "global"     — `requireGlobalAdmin`: admin or superadmin, NEVER an event
//                    admin. A route behind that guard that awaits before it writes
//                    must re-ask at this tier, or an admin narrowed to event admin
//                    mid-await commits an act the tier exists to keep from them
//                    (granting the event-admin role — the self-propagation bar).
//   • "superadmin" — `requireSuperAdmin`: superadmin only (the imports, the seeder).
// The built-in superadmin passes every tier (it has no row; each guard admits it
// by `builtinId`) and is answered by the tombstone arm alone, as before.
const ADMIN_TIER_ROLES = Object.freeze({
  admin: Object.freeze(["admin", "superadmin", "event_admin"]),
  global: Object.freeze(["admin", "superadmin"]),
  superadmin: Object.freeze(["superadmin"]),
});
// What each STRICTER tier's own guard answers an admin-shaped impersonation
// session — the refusal the next arm gives, in the guard's own words.
const ADMIN_TIER_SEAT_REFUSAL = Object.freeze({
  global: "Only an administrator can make this change.",
  superadmin: "Forbidden — superadmin only",
});
function adminAuthzDenied(req, { tier = "admin", perm = null, read = false } = {}) {
  // RBAC — `{perm}` names the permission the write needs. A built-in role is
  // answered by the tier its permission set implies (the tiers below are that
  // mapping, kept as the alias); a CUSTOM role by its live permission set. With
  // neither given, the route's own permission is the question for a custom role.
  if (perm) {
    const rb = require("./rbac");
    tier = rb.BUILTIN_ROLE_PERMISSIONS.event_admin.has(perm) ? "admin"
      : rb.BUILTIN_ROLE_PERMISSIONS.admin.has(perm) ? "global" : "superadmin";
  }
  const roles = ADMIN_TIER_ROLES[tier];
  // A programming error, not a request outcome: an unknown tier must never be
  // answered as though it were the widest one.
  if (!roles) throw new Error(`adminAuthzDenied: unknown tier ${JSON.stringify(tier)}`);
  const s = req && req.session;
  if (!s || (!s.userId && s.builtinId !== "superadmin")) {
    return { status: 401, error: "Not authenticated", code: "admin_session_ended" };
  }
  const ROW = "SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?";
  if (s.impersonator) {
    // A WRITE through an organiser's panel is a superadmin's alone (the regular
    // admin's view is read-only: impersonationGuard). A READ that discloses after
    // an await (`{read:true}`: the top-three certificates ZIP) admits any hand the
    // panel opens to, read live, so the read-only view is not refused what its
    // GET was given, while a hand blocked, demoted or deleted meanwhile is.
    const handOk = read ? organiserPanelOpensTo(actingAdminLiveRole(req)) : actingIsSuperAdmin(req);
    if (!handOk) {
      return { status: 403, error: ADMIN_ACCESS_ENDED_ERROR, code: "admin_access_revoked" };
    }
    const seat = db.prepare(ROW).get(s.userId);
    if (!seat || seat.blocked || seat.denied_at || !seat.approved || seat.role !== "event_admin") {
      return { status: 403, error: IMPERSONATION_ENDED_ERROR, reason: "target_inactive", code: "admin_access_revoked" };
    }
    // v8.12.7 — A TIER ABOVE "admin" FAILS CLOSED THROUGH A SEAT. The seat of an
    // admin-shaped impersonation is an event admin (asserted just above), and
    // neither stricter guard admits one: `requireGlobalAdmin` reads the SEAT's
    // role, and `requireSuperAdmin` reads a flag an impersonation session never
    // carries. So both refuse it at the headers and this arm is unreachable
    // today — which is exactly why it must not answer yes: until v8.12.7 the
    // superadmin tier let the hand's tier stand in for the seat's here, and a
    // route that lost its header guard would have committed a superadmin-only
    // act through an organiser's panel ("act exactly as they can", v8.12.1).
    if (tier !== "admin") {
      return { status: 403, error: ADMIN_TIER_SEAT_REFUSAL[tier], code: "event_admin_forbidden" };
    }
  } else if (s.userId) {
    const u = db.prepare(ROW).get(s.userId);
    const custom = !!(u && u.role && !isBuiltinRole(u.role));
    const roleOk = !u ? false
      : !custom ? roles.includes(u.role)
      : customRoleAllows(req, u.role, perm);   // live; the route's own permission when none is named
    if (!u || u.blocked || u.denied_at || !u.verified || !u.approved || !roleOk) {
      return { status: 403, error: ADMIN_ACCESS_ENDED_ERROR, code: "admin_access_revoked" };
    }
  }
  if (wasSessionPurged(req.sessionID, { failClosed: true })) {
    return { status: 401, error: SESSION_ENDED_ERROR, code: "admin_session_ended" };
  }
  return null;
}

/**
 * v8.12.6 (review fix) — MAY THE ADMIN AT THE KEYBOARD OF AN IMPERSONATION
 * SESSION STILL COMMIT THE PARTICIPANT WRITE THEY STARTED?
 *
 * The participant-tier twin of `adminAuthzDenied`'s impersonation arm, and the
 * half `participantAuthzDenied` cannot answer. Under impersonation
 * `req.session.userId` is the TARGET, so every participant guard and the
 * v8.11.1 F3 commit re-check ask about the SEAT; the HAND — the acting admin — is
 * re-read once, by `impersonationGuard`, when the request HEADERS arrive. A
 * participant write that then awaits before it writes committed after that
 * admin had been blocked, demoted or deleted: MEASURED before this existed, a
 * superadmin impersonating a participant and revoked while a file answer was
 * uploading was answered 200 `{correct:true, pointsDelta:50}` — a graded, scored
 * submission for the participant from an account the platform had revoked,
 * audited `impersonated_by` that account.
 *
 * ASKED AT COMMIT, beside `participantAuthzDenied`, with nothing awaited between
 * it and the write (the F1 scanner in functional-core-b holds the placement on
 * the routes that parse their body after their guard). Applies ONLY to an
 * impersonation session; a session acting as its own account is asked the same
 * question by `participantSessionDenied` below.
 *
 * WHAT IS RE-ASKED, in this order, and why the order matters:
 *   1. the session TOMBSTONE (`wasSessionPurged`). A route-driven revocation of
 *      the hand (block, role change, delete), a sign-in elsewhere, an exit in
 *      another tab, the idle sweep and — v8.13.4 — a refused CSRF token on the
 *      same session in another tab all end the session; every one of those
 *      paths has ALREADY closed the impersonation window in the target's History,
 *      so this answer does nothing but refuse. Asked FIRST because the hand arm
 *      below closes the window itself, and asking it first for a purged session
 *      would record a SECOND `impersonation_ended` for one window.
 *   2. the HAND, through `actingAdminLiveRole` — the uncached read
 *      `actingIsSuperAdmin` makes, answering with the role — and answered exactly
 *      as `impersonationGuard` answers the same facts at the headers: a hand that
 *      is no longer a live admin at all (blocked, denied, deleted, demoted out of
 *      the admin tiers — out of band, since a route would have tombstoned it) has
 *      no identity to hand back, so the session is ENDED and the window closed
 *      (`endSession`, `reason:"actor_inactive"`); a hand that is still a live
 *      admin but no longer a superadmin is the READ-ONLY tier and gets the
 *      guard's own `impersonation_readonly`, the session kept. `readOnlyTier`
 *      admits that tier for the one write it may make (the certificate mint,
 *      v8.3.25). The built-in superadmin passes the hand arm by construction.
 *
 * THE SHAPE IS THE ONE EVERY CLIENT ALREADY HANDLES: `impersonation_ended` at
 * 403, which the fetch interceptor turns into a toast and a reload (and whose
 * promise never settles, so a participant screen can never paint a red "wrong
 * answer" for it); `reason` picks the toast's words. `code` mirrors the admin
 * twin's (`admin_access_revoked` / `admin_session_ended`) for a machine reader.
 *
 * Returns null or `{status, error, reason?, code, endSession?}`. Point reads only
 * (a tombstone PK and a `users` PK) — safe inside the write lock. Send it with
 * `sendImpersonationCommitDenial`, which applies `endSession` OUTSIDE the
 * transaction.
 */
const ADMIN_HAND_ROLES = ["admin", "superadmin", "event_admin"];
function impersonatingHandDenied(req, { readOnlyTier = false } = {}) {
  const s = req && req.session;
  if (!s || !s.impersonator) return null;
  if (wasSessionPurged(req.sessionID, { failClosed: true })) {
    return { status: 403, error: IMPERSONATION_ENDED_ERROR, reason: "session_ended", code: "admin_session_ended" };
  }
  const role = actingAdminLiveRole(req);
  // RBAC — a custom admin-class role is an admin hand too.
  if (!role || (!ADMIN_HAND_ROLES.includes(role) && roleClass(role, { live: true }) === "none")) {
    return { status: 403, error: IMPERSONATION_ENDED_ERROR, reason: "actor_inactive", code: "admin_access_revoked", endSession: true };
  }
  if (role !== "superadmin" && !readOnlyTier) {
    return { status: 403, error: IMPERSONATION_READONLY_ERROR, code: "impersonation_readonly" };
  }
  return null;
}
/**
 * Send an `impersonatingHandDenied` answer. `endSession` is the guard's own
 * disposition for an acting admin with no admin access left — close the
 * target's window (`actor_inactive`) and destroy the session — applied here,
 * after the transaction, because it mutates the session.
 */
function sendImpersonationCommitDenial(req, res, d) {
  const body = { error: d.error, ...(d.reason ? { reason: d.reason } : {}), code: d.code };
  if (d.endSession) return destroyImpersonationSession(req, res, d.status, body);
  return res.status(d.status).json(body);
}

/**
 * MAY THIS SESSION STILL COMMIT THE PARTICIPANT WRITE IT STARTED? The
 * participant-tier twin of `adminAuthzDenied`, asked at commit by every
 * `requireParticipant` write that awaits before it writes (the submit, the
 * sign-in method change, the certificate mint; a functional-core-b
 * scanner holds the set and the placement). `requireParticipant` has no role
 * test, so this is "a session acting as its own account", admins included.
 *
 * Two arms, and each catches what the other cannot:
 *   1. the ACCOUNT's lifecycle (`participantAccountDenied`, the guard's own
 *      question and sentence). An out-of-band block writes no tombstone. Asked
 *      FIRST, so a route-driven block — which writes both — still reads "Account
 *      is blocked". Under impersonation the account is the SEAT's, and a refusal
 *      gets requireParticipant's forced exit (`sendParticipantSessionDenial`).
 *   2. the session TOMBSTONE, for a session acting as its own account only (under
 *      impersonation `impersonatingHandDenied` asks it first, then the hand). A
 *      sign-in elsewhere, a logout in another tab, a password change made in
 *      another browser (it keeps its own session, which every tab of that
 *      browser shares), a CSRF refusal, a role change and the idle sweep all end
 *      the session and leave the row qualifying. Without this arm the write committed for a session
 *      that had already ended. A tombstone read
 *      error refuses (`failClosed`). 401 with a SENTENCE, never a bare "Not
 *      authenticated": the fetch interceptor would turn that into an immediate
 *      sign-out with a promise that never settles, while a sentence reaches every
 *      caller's own error branch, and the next poll announces the sign-out
 *      through the shared classifier.
 *
 * Point reads only — safe inside the write lock.
 */
function participantSessionDenied(req) {
  const s = req && req.session;
  if (!s || !s.userId) return { status: 401, error: "Not authenticated" };
  const a = participantAccountDenied(s.userId);
  if (a) return a;
  if (s.impersonator) return null;
  if (wasSessionPurged(req.sessionID, { failClosed: true })) {
    return { status: 401, error: SESSION_ENDED_ERROR, code: "session_ended" };
  }
  return null;
}
/**
 * Send a `participantSessionDenied` (or `participantAuthzDenied`) answer. An
 * ACCOUNT refusal under impersonation is the seat stopping qualifying, and gets
 * the forced exit requireParticipant gives at the headers — the admin restored,
 * the window closed — applied here, after the transaction, because it mutates
 * the session. Everything else is sent as `{error, code?}`.
 */
function sendParticipantSessionDenial(req, res, d) {
  if (d.lifecycle && isImpersonating(req)) return restoreImpersonationTargetInactive(req, res);
  return res.status(d.status).json({ error: d.error, ...(d.code ? { code: d.code } : {}) });
}

function requireParticipantInCompetition(req, res, next) {
  const compId = req.session.competitionId;
  const userId = req.session.userId;
  if (!compId || !userId) return res.status(400).json({ error: "No event selected" });
  if (isStaff(userId)) return next(); // staff can join any competition without assignment
  const row = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId);
  if (!row) return res.status(403).json({ error: "You are not assigned to this event" });
  next();
}

module.exports = { setTestSelectTimeslotDelay, testSelectTimeslotDelay, 
  setTestAdminEmailDelay, testAdminEmailDelay,
  setTestAdminCommitDelay, testAdminCommitDelay, testAdminCommitPark, releaseTestAdminCommitPark,
  rateLimit, ipBudgetExceeded, destructiveAdminLimit, bulkAdminLimit, _setTestRateLimitForceEnabled, _rateLimitBucketCount,
  _sweepRateLimitBuckets, _ageRateLimitBuckets,
  generateToken, csrfProtection,
  requireParticipant, requireCompleteProfile, requireAdmin, requireGlobalAdmin, requireSuperAdmin, requirePermission,
  participantAuthzDenied, adminAuthzDenied, impersonatingHandDenied, sendImpersonationCommitDenial,
  participantSessionDenied, sendParticipantSessionDenial,
  requireCompetitionContext, requireParticipantInCompetition,
  tabEventMismatch,
  applyAutoResumeToSession,
  stampLoginTimes,
  // audit v7.7.28 (M1) — the scanner-reputation tracker in server.js reuses the
  // SAME parsed RATE_LIMIT_ALLOWLIST_IPS bypass as rateLimit(), so a venue/CGNAT
  // egress IP the operator allowlisted can't be scanner-blocked either.
  _rateLimitAllowlisted,
};
