"use strict";

// Single-session-per-user enforcement + the "logged in elsewhere" kick-context
// cache. The _kickedSessions Map is a SINGLE process-global instance: the
// writer (invalidateOtherSessions) and the reader (GET
// /api/session/status via lookupKickedSession) must share it. Consumers import
// the operations, never the raw Map. (v7.0.0 refactor: extracted from
// server.js.) Deps: db only.

const db = require("../db");
const { swallowed } = require("./best-effort");
// v7.14.1 — closing an impersonation window that ends by session PURGE needs an
// audit emit. lib/audit only requires db/uuid/log/time (never sessions), so this
// is cycle-free; lib/impersonation is dependency-light by design.
const { recordUserEvent } = require("./audit");
const { impersonationActor, impersonationEndedDetails } = require("./impersonation");
const { SESSION_ROWS_BY_USER_SQL } = require("./session-index");

// v7.15.2 (audit) — tombstones for sessions we have just DELETED, so an
// in-flight request holding the same session object cannot re-create the row.
//
// Why this is needed only since v7.14.4: the session slide writes
// `req.session.slidAt`, which flips express-session's isModified() true, so at
// res.end it calls store.set(oldSessionId, data) — and the store's set is an
// unconditional INSERT ... ON CONFLICT DO UPDATE, which RESURRECTS a deleted
// row. Before the slide an ordinary write mutated no session data and therefore
// never saved, so this could not happen. Concrete case: an admin is inside a
// slow POST (the assign path awaits an SMTP fan-out for seconds) while the same
// admin logs in from another device; invalidateOtherSessions deletes the old
// row, then the slow request finishes and puts it straight back — the "single
// session per user" guarantee silently fails open.
//
// RETENTION (ext-audit v7.15.7): a tombstone must outlive the longest window in
// which the in-flight request could still write a VALID row — NOT merely "the
// longest request", which is what v7.15.6 assumed (10 minutes, in a capped
// in-process Map). That assumption was wrong twice over: the bulk-invitation
// path awaits an SMTP fan-out (up to BULK cap recipients, 8-way concurrency,
// 30 s per-send timeouts) and can exceed 10 minutes, after which the guard had
// forgotten the id and the resurrected row authenticated again; and the 5000
// entry cap could evict an id early under a purge storm.
//
// The bound is arithmetic, not a guess. A resurrected row is only usable until
// its own cookie.expires, which was last stamped at or BEFORE the revocation
// (the slide runs at request entry) and is at most SESSION_MAX_AGE beyond that.
// So retaining for SESSION_MAX_AGE after the revocation strictly covers it; we
// keep double that as margin. Rows are three short strings, swept by expires_at.
const SESSION_MAX_AGE_MS = 60 * 60_000;                 // mirrors the cookie maxAge in server.js
const REVOCATION_RETENTION_MS = 2 * SESSION_MAX_AGE_MS;

/** Tombstone a session id we just deleted, durably (see revoked_sessions). */
function markSessionPurged(id) {
  if (!id) return;
  const nowMs = Date.now();
  try {
    db.prepare("INSERT INTO revoked_sessions (id, revoked_at, expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revoked_at=excluded.revoked_at, expires_at=excluded.expires_at")
      .run(id, new Date(nowMs).toISOString(), new Date(nowMs + REVOCATION_RETENTION_MS).toISOString());
  } catch (e) { /* never let tombstone bookkeeping break session invalidation */ swallowed("sessions:tombstone-write", e); }
}

/**
 * True if `id` was revoked and could still be resurrected — do not persist it.
 *
 * A read error answers `failClosed`. The persistence wrapper, the slide and the
 * cookie filter keep the default (false): refusing to save, or dropping the
 * cookie of, a session that may well be live would sign people out on a DB
 * hiccup. The three commit-time re-checks (`adminAuthzDenied`,
 * `impersonatingHandDenied`, `participantSessionDenied`) pass `failClosed:true`:
 * for a sign-in elsewhere, a reset or a logout the tombstone is the ONLY thing
 * that says the session ended, so an unreadable table must refuse the write.
 */
function wasSessionPurged(id, { failClosed = false } = {}) {
  if (!id) return false;
  try {
    const row = db.prepare("SELECT expires_at FROM revoked_sessions WHERE id=?").get(id);
    if (!row) return false;
    // Past its retention window the id cannot produce a valid row any more, so
    // treat it as clean (the sweep will remove the row).
    return new Date(row.expires_at).getTime() > Date.now();
  } catch (_) { return failClosed; }
}

/** Drop tombstones whose retention window has passed. Called by the session GC. */
function sweepRevokedSessions() {
  try {
    return db.prepare("DELETE FROM revoked_sessions WHERE expires_at <= ?").run(new Date().toISOString()).changes;
  } catch (_) { return 0; }
}

// Pull session rows by a JSON field. When the value is a constrained alphabet
// (UUID / literal "superadmin") an exact `"key":"value"` substring is an
// effective LIKE prefilter — the scan is still O(N) but SQLite does it in C over
// tight byte buffers, ~10× faster than dragging every row through JSON.parse in
// JS. Falls back to a full scan for unconstrained values (avoids LIKE-wildcard
// injection).
//
// `userId` (the sign-in door's single-session purge, once per sign-in) is an
// indexed lookup instead (lib/session-index.js): the session's own userId or an
// impersonation session's impersonator.userId, the two positions the callers'
// ownership checks read. The LIKE scan made a sign-in rush O(N^2).
const _SESSION_KEY_SAFE_VALUE = /^[A-Za-z0-9:_-]+$/;
function _sessionRowsByField(key, value) {
  if (key === "userId" && typeof value === "string" && value) {
    return db.prepare(SESSION_ROWS_BY_USER_SQL).all(value, value);
  }
  if (_SESSION_KEY_SAFE_VALUE.test(String(value))) {
    return db.prepare("SELECT id, data FROM express_session WHERE data LIKE ?")
      .all(`%"${key}":"${value}"%`);
  }
  return db.prepare("SELECT id, data FROM express_session").all();
}

function clearCompetitionSessionForUser(userId, competitionId) {
  const rows = _sessionRowsByField("userId", userId);
  const updates = [];
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    if (parsed.userId !== userId) continue;
    if (parsed.competitionId !== competitionId) continue;
    delete parsed.competitionId;
    delete parsed.timeslotId;
    updates.push({ id: row.id, data: JSON.stringify(parsed) });
  }
  if (updates.length) {
    const upd = db.prepare("UPDATE express_session SET data=? WHERE id=?");
    const tx = db.transaction(() => { for (const u of updates) upd.run(u.data, u.id); });
    tx();
  }
  return { clearedCount: updates.length };
}

// v6.16.24 — when a login destroys other sessions of the same user (the
// "logged in elsewhere" flow), the kicked browser sees its very next request
// return a 401 / `active:false`. The popup it shows needs to distinguish
// "kicked from another browser" (forensically interesting: show the new login's
// IP) from "idled out" (boring inactivity timeout). We can't read the kick
// context off the dead session row (it's been DELETEd). Instead we cache
// (oldSessionId → kickContext) here. The kicked browser's cookie still carries
// the old sessionId, so a /api/session/status poll can match it against this
// map and surface the richer reason. Capped + TTL'd so
// a sustained-attack / login-storm can't grow the map without bound.
const _KICKED_SESSIONS_MAX = 1000;
const _KICKED_SESSIONS_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for the kicked browser's next poll to land.
const _kickedSessions = new Map();
function _recordKickedSession(oldSessionId, byContext) {
  if (!oldSessionId || !byContext) return;
  if (_kickedSessions.size >= _KICKED_SESSIONS_MAX) {
    // FIFO eviction — Map iteration order is insertion order. Kept simple
    // because the cap is generous and the TTL janitor keeps steady-state
    // size low.
    const oldest = _kickedSessions.keys().next().value;
    if (oldest !== undefined) _kickedSessions.delete(oldest);
  }
  _kickedSessions.set(oldSessionId, { ...byContext, at: Date.now() });
}
// Janitor: drop entries past TTL every minute. Bounded work. .unref'd so it
// never blocks process shutdown.
setInterval(() => {
  const cutoff = Date.now() - _KICKED_SESSIONS_TTL_MS;
  for (const [k, v] of _kickedSessions) {
    if (v.at < cutoff) _kickedSessions.delete(k);
  }
}, 60_000).unref();

// Look up (and not remove) the kick context for an old session id, or null.
function lookupKickedSession(oldSessionId) {
  if (!oldSessionId) return null;
  return _kickedSessions.get(oldSessionId) || null;
}

// WHY A PURGE THAT IS NOT A SIGN-IN ELSEWHERE ENDED THE SESSION. Without a
// context the kicked browser's next poll is classified "inactivity", which
// tells somebody who was working that they were idle. A writer passes one of
// these as `byContext`; a login passes its own kicker context, which carries no
// `reason` and reads as "kicked". `ended` names no cause, deliberately: a
// blocked, denied or deleted account must learn no more from the popup than the
// login door tells it ("Invalid email or password").
const SESSION_END_REASONS = Object.freeze(["ended"]);
const SESSION_END = Object.freeze({
  ended: Object.freeze({ reason: "ended" }),
});
/**
 * The context a SIGN-IN door passes as `byContext`: who signed in, and from
 * where, for the kicked browser's "Signed in elsewhere" popup. `who` is the
 * user row, or { email: "superadmin", builtin: true } for the built-in account:
 * `builtin` tells the popup that account has no password to change.
 *
 * `passwordless` follows the account's sign-in method (lib/login-method.js): a
 * code account is told to guard its inbox and tell an organiser; a password
 * account to change its password too. `builtin` keeps its own advice (a server
 * restart rotates its break-glass password). A row that cannot answer (a partial
 * row) reads as passwordless: the advice that needs nothing it might not have.
 */
function kickerContext(req, who) {
  const builtin = who.builtin === true;
  let passwordless = !builtin;
  if (!builtin) {
    try { passwordless = require("./login-method").effectiveLoginMethod(who) !== "password"; }
    catch (e) { swallowed("sessions:kicker-login-method", e); }
  }
  return {
    ip: req.ip || null,
    user_agent: (req.headers["user-agent"] || "").toString().slice(0, 300) || null,
    first_name: who.first_name || null,
    last_name: who.last_name || null,
    email: who.email || null,
    builtin,
    passwordless,
  };
}
// v8.13.4 — ONE definition of "this session carries an identity": a user account
// (`userId` — which an impersonation session carries too, as the TARGET's id)
// or the built-in superadmin (`builtinId`, no user row). Read by the scanner
// tracker's identity-probe carve-out (`_isIdentityProbe401`, server.js) and by
// the EBADCSRFTOKEN handler, which keyed "authenticated" on `userId` alone from
// v8.3.13 and so let the built-in superadmin's session survive a refused token —
// the drift a second hand-written copy of this test is one edit away from.
function _sessionHasIdentity(s) {
  return !!(s && (s.userId || s.builtinId));
}
/** The `reason` GET /api/session/status reports for a kick context; an unknown one fails closed to "ended". */
function kickReasonOf(ctx) {
  if (!ctx) return null;
  if (!ctx.reason) return "kicked";
  return SESSION_END_REASONS.includes(ctx.reason) ? ctx.reason : "ended";
}

function invalidateOtherSessions(key, value, currentSessionId, byContext) {
  const rows = _sessionRowsByField(key, value);
  const nowMs = Date.now();
  const toRemove = [];
  const endedWindows = [];
  let liveCount = 0;
  for (const row of rows) {
    if (row.id === currentSessionId) continue;
    try {
      const parsed = JSON.parse(row.data);
      // v7.14.0 — impersonation-aware ownership. A session whose admin is
      // impersonating somebody carries the TARGET's id in `userId` (a
      // participant's, or — v8.12.1 — an event admin's) but BELONGS to the
      // admin (identity snapshotted in `impersonator`). For single-session
      // enforcement:
      //   • it is NOT one of the target's sessions — the target logging in
      //     (or being blocked/reset) must not kick the admin; the
      //     lifecycle forced-exits in requireParticipant / requireAdmin
      //     handle those cases gracefully instead.
      //   • it IS one of the admin's sessions — the admin logging in again,
      //     or being blocked/demoted/deleted, kills it like any other.
      // The LIKE prefilter still matches both shapes: the impersonator
      // snapshot serialises as `"impersonator":{"userId":"<admin-id>",...}`,
      // so the `"userId":"<value>"` substring hits either position.
      const imp = parsed.impersonator || null;
      let owned;
      if (imp && (key === "userId" || key === "builtinId")) {
        owned = imp[key] === value;
      } else {
        owned = parsed[key] === value;
      }
      if (!owned) continue;
      const expStr = parsed?.cookie?.expires || parsed?.cookie?._expires || null;
      const expiresAt = expStr ? new Date(expStr).getTime() : null;
      const isExpired = expiresAt !== null && expiresAt < nowMs;
      if (!isExpired) liveCount++;
      toRemove.push(row.id);
      // v7.14.1 — purging an IMPERSONATION session closes that window just as
      // surely as the explicit exit does (the admin re-logged in elsewhere, or
      // was blocked / demoted / deleted). Without an emit here the target's
      // history kept an unclosed `impersonation_started` with no duration.
      // Collected during the scan, emitted after the delete commits.
      if (imp) endedWindows.push({ targetId: parsed.userId || null, imp });
      // Record kick context for the kicked browser's next /api/session/status
      // poll. Only attach for live (non-expired) sessions — an already-
      // expired row's "kicker IP" is meaningless to the user (they were
      // never going to see the popup).
      if (!isExpired && byContext) _recordKickedSession(row.id, byContext);
    } catch (e) { /* skip malformed rows */ swallowed("sessions:malformed-row", e); }
  }
  if (toRemove.length) {
    // v7.15.6 (ext-audit HIGH) — tombstone BEFORE the delete, not after. The
    // store's set() consults these tombstones, so marking first means there is
    // no window at all in which an in-flight request's save can re-create the
    // row; marking afterwards left a small one between commit and mark. If the
    // delete were to throw, the surviving session is merely un-writable for the
    // tombstone TTL — the safe direction for a session we intended to destroy.
    for (const id of toRemove) markSessionPurged(id);
    const del = db.prepare("DELETE FROM express_session WHERE id=?");
    const tx = db.transaction(() => { for (const id of toRemove) del.run(id); });
    tx();
  }
  // Post-commit, best-effort: a failed audit write must never break session
  // invalidation (the security-critical part already succeeded). No reqContext
  // — this runs from the session layer with no request in hand, matching the
  // convention for system/background emits.
  for (const w of endedWindows) {
    if (!w.targetId) continue;
    try {
      recordUserEvent(w.targetId, "impersonation_ended", impersonationActor({ impersonator: w.imp }),
        impersonationEndedDetails(w.imp, "session_purged"));
    } catch (e) { /* best-effort */ swallowed("sessions:impersonation-ended-emit", e); }
  }
  return { liveCount, purgedCount: toRemove.length };
}

// The session cookie's name: ONE definition, passed to `session({ name })` in
// server.js and read by the two parsers of its value below. Renaming it in one
// place only would turn the kick-context lookup and the revoked-cookie filter
// into silent no-ops.
const SESSION_COOKIE_NAME = "connect.sid";
const _COOKIE_NAME_RE = SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const _OLD_SID_RES = [new RegExp(`${_COOKIE_NAME_RE}=s%3A([^.;\\s]+)\\.`, "i"), new RegExp(`${_COOKIE_NAME_RE}=s:([^.;\\s]+)\\.`, "i")];

// Parse the OLD session id out of the request's Cookie header.
// express-session signs the cookie as `s:<sid>.<sig>`; URL-encoding makes it
// `s%3A<sid>.<sig>` over the wire. We only need <sid> — the kicked-session map
// is keyed by the raw session id.
function _extractOldSessionId(req) {
  const h = req.headers?.cookie || "";
  if (!h) return null;
  const m = h.match(_OLD_SID_RES[0]) || h.match(_OLD_SID_RES[1]);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
}

/**
 * Does this one `Set-Cookie` entry (re)set the session cookie to session `sid`?
 * express-session serialises `s:<sid>.<signature>` with the cookie module's
 * default encoder, so the entry starts `<name>=s%3A<sid>.` — matched exactly,
 * so a clear, or a cookie for another id, never matches.
 */
function setCookieCarriesSession(entry, sid) {
  if (typeof entry !== "string" || typeof sid !== "string" || !sid) return false;
  return entry.startsWith(`${SESSION_COOKIE_NAME}=${encodeURIComponent("s:" + sid)}.`);
}

/**
 * The signed-in header's LAYOUT hint (public/js/features/session-monitor.js
 * setAppShellHint): `ha_shell=1`, readable by theme-boot.js before first paint so
 * a signed-in load reserves the header's second row (the participant bar) instead
 * of pushing the page down when boot swaps the signed-in header in. Set by the
 * code sign-in (and the sign-up it completes, routes/auth.js `_signInAs`) so a
 * sign-in the SPA did not route (an API sign-in, then a navigation) reserves
 * too; the SPA sets it itself whenever it shows the signed-in shell. It carries no identity and grants nothing; no
 * Expires, so it lasts the browser session and never looks like a slide.
 */
const APP_SHELL_HINT_COOKIE = "ha_shell";
function setAppShellHintCookie(req, res) {
  res.cookie(APP_SHELL_HINT_COOKIE, "1", { path: "/", sameSite: "lax", secure: !!req.secure, httpOnly: false });
}

module.exports = {
  setAppShellHintCookie,
  clearCompetitionSessionForUser, invalidateOtherSessions,
  _extractOldSessionId, lookupKickedSession,
  markSessionPurged, wasSessionPurged, sweepRevokedSessions,
  SESSION_COOKIE_NAME, setCookieCarriesSession,
  SESSION_END, kickReasonOf, kickerContext, _sessionHasIdentity,
};
