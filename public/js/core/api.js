"use strict";

// CSRF + fetch helpers and the session-expiry fetch interceptor (v7.0.0 ESM
// split). installFetchInterceptor() is called once from core/main.js boot() —
// the window.fetch override is a side-effect kept out of the module body. The
// interceptor calls into session-monitor (a function-level cycle, benign in ESM
// since both modules are fully loaded by the time the interceptor fires).

import { S } from "./state.js";
import { showLoading, hideLoading } from "../ui/loading.js";
import { showToast } from "../ui/toast.js";
import { showModal } from "../ui/modal.js";
import { esc } from "../ui/format.js";
import { _stopAllPolls, _classifySignout, _announceSignout, _sessionMon } from "../features/session-monitor.js";
// v8.8.23 — the completion gate, reached from the interceptor. Same benign
// function-level cycle as session-monitor above: auth.js imports this module,
// but the binding is only READ when a request has already 400'd, long after
// both modules are evaluated.
import { openProfileCompletionGate } from "../features/auth.js";

// v8.3.13 — DO NOT STORE A TOKEN WE DID NOT GET.
//
// This used to be `S.csrfToken = d.csrfToken || ''` with no status check at all,
// so ANY response without a token — a 429 from the 120/min per-IP cap, a scanner
// block, the new 503 `session_cookie_blocked`, a proxy's HTML error page — was
// silently recorded as an empty token. Every POST after that failed with
// `csrf_invalid`, a name from the wrong subsystem, and the real condition never
// reached anyone.
//
// A FAILED FETCH NOW LEAVES THE EXISTING TOKEN ALONE. Clobbering a working token
// with '' because one refresh was throttled is strictly worse than keeping it:
// the old one may well still be valid, and if it is not, the caller retries.
// Returns whether a token is now in hand, so a caller can act on it.
// The last token fetch's refusal, for the back-off below: its status and the
// server's Retry-After (seconds), when it sent one.
let _lastTokenStatus = 0, _lastTokenRetryAfter = 0;
export async function loadCsrfToken() {
  const seq = ++_tokenReqSeq;
  try {
    const r = await fetch('/api/csrf-token');
    _lastTokenStatus = r.status;
    _lastTokenRetryAfter = parseInt(r.headers.get('Retry-After') || '0', 10) || 0;
    let d = null;
    try { d = await r.json(); } catch (_) { d = null; }
    if (r.ok && d && d.csrfToken) {
      // A token REQUESTED before a session-replacing door's answer arrived — before
      // its send, or while it was in flight, when the request still carried the
      // old cookie — belongs to the session that door replaced (or to none):
      // adopting it would put a dead token in hand and release the door's hold
      // (see `sendReplacingSession`).
      if (_doorInFlight || seq <= _lastDoorSendSeq) return !!S.csrfToken;
      S.csrfToken = d.csrfToken; _publishCsrfFp(d.csrfToken); _releaseOnToken(); return true;
    }
    // The server telling us the deployment cannot carry a session is the one
    // case worth naming on the way past: it is not transient, and no retry
    // fixes it.
    S._csrfBlocked = (d && d.error === 'session_cookie_blocked') ? (d.message || 'session_cookie_blocked') : null;
    console.error('CSRF token not issued', r.status, d && d.error);
    return !!S.csrfToken;
  } catch (e) { console.error('Failed to load CSRF token', e); return !!S.csrfToken; }
}

/**
 * v8.3.13 — run an anonymous POST, and if it is refused for a stale CSRF token,
 * refresh the token ONCE and run it again.
 *
 * The doors on the login card (Continue's sign-in-method lookup, the password
 * sign-in, the code request and its redeem, and the sign-up form) are the ones
 * that need this, because they are the only
 * places a token can go stale with nobody signed in to notice: the anonymous
 * session carrying it has a hard 60-minute deadline and NOTHING on that page
 * extends it — `generateToken` does not overwrite an existing token, so even a
 * second `/api/csrf-token` re-stamps no cookie. Leave the tab open through
 * lunch and every attempt failed, permanently, with `csrf_invalid`.
 *
 * ONE retry, never a loop: a second failure is a real refusal (or a deployment
 * that cannot set cookies at all), and retrying past that would only turn a
 * clear error into a hang.
 *
 * It weakens nothing. CSRF protection stops a CROSS-SITE page from making an
 * authenticated request; a cross-site attacker cannot read the token response
 * (same-origin policy), so refreshing a token they were never able to obtain
 * gains them exactly nothing. This is the ordinary same-origin retry.
 */
/**
 * NEVER SEND A WRITE WITHOUT A TOKEN. Behind one venue NAT, a thousand walk-ups
 * share the per-IP `/api/csrf-token` limit: a refused (429) token fetch left
 * `S.csrfToken` empty, the door posted anyway, every post answered 403
 * csrf_invalid — and those 403s fed the scanner tracker until the whole venue
 * address was blocked. So a door first makes sure it HOLDS a token: on a 429 it
 * waits (the server's Retry-After, else exponential with jitter, capped at 15 s)
 * and asks again, saying "Busy — retrying…" on the card (`ha:csrf-busy`), for at
 * most ~45 s; then it gives up WITHOUT sending, answering a local 503
 * `csrf_unavailable` the door reports. Never a loop.
 */
const _TOKEN_WAIT_TRIES = 7;
// ONE wait at a time: every caller that finds no token shares it, so the writes
// queued behind a throttled venue do not each ask for tokens of their own.
let _tokenWait = null;
function _ensureToken() {
  if (S.csrfToken) return Promise.resolve(true);
  if (!_tokenWait) _tokenWait = _waitForToken().finally(() => { _tokenWait = null; });
  return _tokenWait;
}
async function _waitForToken() {
  for (let i = 0; i < _TOKEN_WAIT_TRIES; i++) {
    if (await loadCsrfToken() && S.csrfToken) { _busy(false); return true; }
    if (_lastTokenStatus !== 429 && _lastTokenStatus < 500) break;   // not transient: no retry fixes it
    if (i === _TOKEN_WAIT_TRIES - 1) break;   // the last ask: waiting after it would only delay the answer
    _busy(true);
    const base = _lastTokenRetryAfter > 0 ? _lastTokenRetryAfter * 1000 : Math.min(15000, 1000 * 2 ** i);
    await new Promise(res => setTimeout(res, Math.min(15000, base) * (0.75 + Math.random() * 0.5)));
  }
  _busy(false);
  return !!S.csrfToken;
}
function _busy(on) {
  try { window.dispatchEvent(new CustomEvent('ha:csrf-busy', { detail: { on } })); }
  catch (e) { console.warn('[csrf] busy notice not shown:', e && e.message); }
}
function _noTokenResponse() {
  return new Response(JSON.stringify({ error: 'csrf_unavailable', message: 'The site is busy right now. Wait a moment and try again.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A sign-in door (the code redeem, the account password, break-glass,
 * registration, the proof redeem) REGENERATES the session, so the token in
 * hand belongs to the session that just ended. Keeping
 * it when the refresh is throttled (429 behind a venue NAT) sent the next write
 * with a dead token: 403 csrf_invalid ended the brand-new session, its polls
 * answered 401, and those countable 4xx blocked the whole venue address. So a
 * door that replaced the session drops the old token and waits for a real one
 * the same way a write does (lock: tests/csrf-busy-backoff.spec.js).
 */
export async function adoptNewSessionToken() {
  S.csrfToken = '';
  return _ensureToken();
}

export async function postWithCsrfRetry(url, build) {
  if (!(await _ensureToken())) return _noTokenResponse();
  let r = await fetch(url, build(S.csrfToken));
  if (r.status !== 403) return r;
  const clone = r.clone();
  let d = null;
  try { d = await clone.json(); } catch (_) { return r; }
  if (!d || d.error !== 'csrf_invalid') return r;
  // The refused token is dead: drop it, so the retry waits for a REAL one.
  S.csrfToken = '';
  if (!(await _ensureToken())) return r;
  return fetch(url, build(S.csrfToken));
}
export function csrfHeaders(extra = {}) { return { 'X-CSRF-Token': S.csrfToken, ...extra }; }

// ONE BROWSER, ONE SESSION, ONE TOKEN PER TAB. Every tab of this origin shares
// the session cookie, but each holds its own CSRF token, and a token is bound
// to the session that issued it (csrf-sync). When one tab REPLACES the session
// (a sign-in, the view switch, impersonation in or out),
// every other tab still holds the old session's token — and the server ends any
// session carrying an identity on a refused token, so a stale tab's next write
// (its 30 s keepalive at the latest) signed out the session the other tab had
// just made.
//
// So each tab PUBLISHES a fingerprint of every token it is issued — never the
// token — under localStorage `ha:csrf-fp`, the record every tab reads
// synchronously before a write. A tab whose own token no longer matches it
// re-syncs BEFORE the write leaves (`ensureFreshCsrf`): it asks who the live
// session is, and takes a token for it only when that is the account it shows,
// acting as itself, in the view it shows (`_liveSessionIsMine`), or when it
// shows nobody (its only writes are the sign-in doors). Anything else — another
// account, an impersonation, the other view — would have this tab's write
// saved under it, so the tab sends nothing more and says it is out of date; a
// session that is gone gets the ordinary sign-out popup. Without storage (a
// private window, blocked site data) nothing is published or compared.
const _CSRF_FP_KEY = 'ha:csrf-fp';
// Exported for tests/csrf-cross-tab.spec.js, which publishes as another tab would.
export function csrfTokenFp(t) {
  // FNV-1a, 32 bits: tells two tokens apart and reveals nothing usable of one.
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function _publishCsrfFp(token) {
  const fp = csrfTokenFp(String(token));
  S._csrfFp = fp;
  _tokenDead = false;
  try {
    if (localStorage.getItem(_CSRF_FP_KEY) !== fp) localStorage.setItem(_CSRF_FP_KEY, fp);
    // A token issued for a session proves it was not signed out: a sign-out
    // whose request never ended it must not name the session's later end.
    if (localStorage.getItem(_SIGNED_OUT_KEY) === fp) localStorage.removeItem(_SIGNED_OUT_KEY);
  } catch (_) { /* no storage */ }
}
// A SIGN-OUT IN ANOTHER TAB IS NAMED AS ONE (operator ruling, 21 Oct 2026).
// Signing out records no reason on the server, so the browser's other tabs,
// finding their session gone, used to say "inactivity". The tab that signs out
// leaves the fingerprint of the session's token here first; a tab whose own
// token has that fingerprint held exactly the session that was signed out, so
// it says so (`_classifySignout`). Tied to the session itself, not to a time
// window, and naming nobody. A sign-out only ends this browser's session, so
// storage reaches every tab it ends; without storage they say what they did.
const _SIGNED_OUT_KEY = 'ha:signed-out-fp';
export function markSignedOutHere() {
  if (!S._csrfFp) return;
  try { localStorage.setItem(_SIGNED_OUT_KEY, S._csrfFp); } catch (_) { /* no storage */ }
}
/** Withdraw this tab's marker: its sign-out request failed, so the session lives. */
export function clearSignedOutMark() {
  if (!S._csrfFp) return;
  try { if (localStorage.getItem(_SIGNED_OUT_KEY) === S._csrfFp) localStorage.removeItem(_SIGNED_OUT_KEY); } catch (_) { /* no storage */ }
}
export function signedOutInAnotherTab() {
  if (!S._csrfFp) return false;
  try { return localStorage.getItem(_SIGNED_OUT_KEY) === S._csrfFp; } catch (_) { return false; }
}
/** Whether another tab has been issued a token for a session other than the
 *  one this tab's token belongs to. */
export function csrfTokenStale() {
  if (!S._csrfFp) return false;
  let live = null;
  try { live = localStorage.getItem(_CSRF_FP_KEY); } catch (_) { return false; }
  return !!live && live !== S._csrfFp;
}
/** A live session (a `/api/session/status` body) is the one this tab shows:
 *  the same account, acting as itself, in the same view. The built-in
 *  superadmin has no user id and is known by its role. */
export function _liveSessionIsMine(sd) {
  if (!sd || sd.active !== true || sd.impersonating !== false || S.impersonation) return false;
  if (sd.admin_view !== !!S.isAdminView) return false;
  const mine = S.currentUser && S.currentUser.id;
  if (mine) return sd.user_id === mine;
  return !!S.isSuperAdmin && sd.user_id === null && sd.role === 'superadmin';
}
let _resyncing = null;
/**
 * Before a write: if another tab has replaced this browser's session since this
 * tab's token was issued, re-sync first. Resolves true when the token in hand
 * is the live session's (or nothing says otherwise), false when the write must
 * not be sent — the tab is out of date (`S._sessionOutOfDate`, already told),
 * or who the live session is could not be learnt (the next write asks again).
 * Concurrent writes share one re-sync.
 */
export function ensureFreshCsrf() {
  if (S._sessionOutOfDate) return Promise.resolve(false);
  if (!csrfTokenStale()) return Promise.resolve(true);
  if (!_resyncing) _resyncing = _resyncCsrf().finally(() => { _resyncing = null; });
  return _resyncing;
}
async function _resyncCsrf() {
  let sd = null;
  try { const sr = await _origFetch('/api/session/status'); if (sr.ok) sd = await sr.json(); } catch (_) { sd = null; }
  if (!sd) return false;
  const showsNobody = !S.currentUser && !S.isAdmin && !S.isSuperAdmin;
  if (showsNobody || _liveSessionIsMine(sd)) return (await loadCsrfToken()) && !csrfTokenStale();
  _tabOutOfDate(sd);
  return false;
}
// v8.14.4 (external audit R2) — ANOTHER TAB MOVED THE SESSION TO ANOTHER
// EVENT. Every request names the event this tab shows (X-Competition-Id, in
// the interceptor), and the server refuses one naming a different event than
// the session holds (lib/middleware.js `tabEventMismatch`), so a challenge left
// open in this tab can no longer answer, take a hint or pay a penalty on the
// event another tab opened. This tells the person, once, and stops the polls;
// a reload lands on the event the session holds.
function _eventChangedElsewhere(d) {
  if (S._eventOutOfDate) return;
  S._eventOutOfDate = true;
  _stopAllPolls();
  const here = S.currentCompName ? `“${esc(S.currentCompName)}”` : 'the event this tab shows';
  // `competition_id` null: the session holds no event (another tab went back
  // to the Events list), so a reload lands there.
  const now = d && d.competition_id ? `“${esc(d.competition_name || 'another event')}”` : null;
  showModal({
    title: 'This tab is out of date',
    message: now
      ? `This browser now has ${now} open, most likely from another tab, and it can be in one event at a time. So this tab can no longer act on ${here}, and anything you just did in it was not recorded. Reload it to continue in ${now}.`
      : `This browser has left ${here}, most likely from another tab, so this tab can no longer act on it, and anything you just did in it was not recorded. Reload it to choose an event.`,
    confirmText: 'Reload', confirmClass: '', cancelText: null,
  }).then(() => { location.reload(); });
}
function _tabOutOfDate(sd) {
  if (S._sessionOutOfDate) return;
  S._sessionOutOfDate = true;
  if (S._sessionExpiredHandled) return;
  S._sessionExpiredHandled = true;
  _stopAllPolls();
  if (sd.active !== true) { _announceSignout(_classifySignout(sd)); return; }
  showModal({
    title: 'This tab is out of date',
    message: 'Since this page loaded, another tab in this browser has signed in, switched view or started or ended an impersonation, so this tab sends nothing more. Reload it to carry on with the session open now.',
    confirmText: 'Reload', confirmClass: '', cancelText: null,
  }).then(() => { location.reload(); });
}
/** The path of a request to this app's own /api/ (a string, URL or Request), else null. */
function _appApiPath(input) {
  try {
    const raw = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
    const u = new URL(raw, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/api/') ? u.pathname : null;
  } catch (_) { return null; }
}
const _isAppApiRequest = (input) => _appApiPath(input) !== null;

// A ROOM BEHIND ONE ADDRESS. A refused request counts toward the scanner block
// (100 in 10 minutes blocks the address), so a tab must not learn that its
// session ended from a refused poll when it can ask the session check, which
// always answers 200 and is never counted. Two cases ask it first:
//   - past the session's known expiry (`_sessionMon.expiresAt`, from the
//     server's own answer; a client clock running fast costs one check, never a
//     sign-out), or after another tab of this browser found the session ended
//     (`ha:session-ended`, written by _stopAllPolls);
//   - after the address was blocked: while the block's Retry-After runs no
//     /api/ request leaves at all (each gets the block's answer here, which
//     callers treat as a blip), and the block hides whether the session lived.
// Only a tab that shows somebody asks; the check never runs on the sign-in page.
const BLOCK_ANSWER = 'Too many invalid requests from this address. Try again later.';
function _noteAddressBlocked(retryAfter) {
  const s = Number(retryAfter);
  S._addressBlockedUntil = Date.now() + Math.min(Number.isFinite(s) && s > 0 ? s : 60, 3600) * 1000;
}
async function _isAddressBlock(r) {
  if (!r || r.status !== 429) return false;
  try { const d = await r.clone().json(); return !!d && d.code === 'address_blocked'; } catch (_) { return false; }
}
function _blockedAnswer() {
  const s = Math.max(1, Math.ceil(((S._addressBlockedUntil || 0) - Date.now()) / 1000));
  return new Response(JSON.stringify({ error: BLOCK_ANSWER, code: 'address_blocked' }), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(s) },
  });
}
function _showsSomebody() { return !!(S.currentUser || S.isAdmin || S.isSuperAdmin); }
function _sessionCheckDue() {
  if (!_showsSomebody()) return false;
  if (S._addressBlockedUntil || S._sessionCheckDue) return true;
  const at = _sessionMon.expiresAt;
  return !!at && Date.now() >= at.getTime() + 2000;
}
let _liveCheck = null;
/** 'live' (send), 'blocked' (still blocked) or 'ended' (halted and announced). */
function _confirmSessionLive() {
  if (!_liveCheck) _liveCheck = (async () => {
    let r = null; let d = null;
    try { r = await _origFetch('/api/session/status'); d = r.ok ? await r.json() : null; } catch (_) { r = null; }
    if (await _isAddressBlock(r)) { _noteAddressBlocked(r.headers.get('Retry-After')); return 'blocked'; }
    S._addressBlockedUntil = 0;
    if (d && d.active !== true) {
      if (!S._sessionExpiredHandled) {
        S._sessionExpiredHandled = true;
        _stopAllPolls();
        _announceSignout(_classifySignout(d));
      }
      return 'ended';
    }
    // Live, or the check itself failed (claim nothing: send as before).
    if (d) { S._sessionCheckDue = false; _sessionMon.expiresAt = d.expires_at ? new Date(d.expires_at) : null; }
    return 'live';
  })().finally(() => { _liveCheck = null; });
  return _liveCheck;
}
/** `args` (a fetch call's) with the CSRF header, where it carries one, set to
 *  the token now in hand — the write was built with the token it replaced. */
function _restampCsrf(args) {
  const isKey = (k) => String(k).toLowerCase() === 'x-csrf-token';
  const init = args[1];
  if (init && typeof init === 'object' && init.headers) {
    const h = init.headers;
    if (h instanceof Headers) {
      if (h.has('X-CSRF-Token')) { const c = new Headers(h); c.set('X-CSRF-Token', S.csrfToken); args[1] = { ...init, headers: c }; }
    } else if (!Array.isArray(h) && typeof h === 'object' && Object.keys(h).some(isKey)) {
      const c = {};
      for (const k of Object.keys(h)) c[k] = isKey(k) ? S.csrfToken : h[k];
      args[1] = { ...init, headers: c };
    }
  } else if (typeof Request !== 'undefined' && args[0] instanceof Request && args[0].headers.has('X-CSRF-Token')) {
    const c = new Headers(args[0].headers); c.set('X-CSRF-Token', S.csrfToken);
    args[0] = new Request(args[0], { headers: c });
  }
}
// …AND WITHIN ONE TAB. While this tab replaces its own session (the view
// switch, impersonation in or out), a
// write it sends with the old token is refused, and the refusal ends the NEW
// session: the session monitor's keepalive racing a view switch did exactly
// that. So every such door goes through `sendReplacingSession`:
//  - doors run ONE AT A TIME, each after the previous door's new token is in
//    hand (a double-clicked switch sent the second with the token the first
//    replaced);
//  - each door HOLDS this tab's other writes, lets the ones in flight settle
//    (`trackInflightWrite` registers those that bypass the interceptor), checks
//    the token again after that wait, then sends;
//  - the held writes leave, re-stamped, once a token REQUESTED after the door's
//    answer arrived is issued (an answer to an earlier request is never
//    adopted: it carried the old cookie). A door that
//    fails or is not sent releases them at once. If the hold ends any other way
//    once the door is sent (its token never came, its answer was slow or lost),
//    the token in hand is marked dead: the next write asks for one first (one
//    fetch, shared) and is not sent without it. Every wait is bounded.
// A write asks `readyToWrite`, which loops until neither a hold nor a token
// check is pending, and again after the impersonation confirm if it waited on
// one; a door settles the writes in flight again after its own token re-check.
// The doors: the paths below through the interceptor (after
// its impersonation confirm, so a Cancel takes no hold), the view switch and
// impersonation in or out through `_sessionTransitionPost`
// (features/impersonation.js). Every write that bypasses the interceptor asks
// `readyToWrite` first. The sign-in doors are not here: an anonymous tab sends
// no writes of its own.
// EMPTY: the one signed-in credential door, PUT /api/me/sign-in-method, keeps
// its own session, so it is no such door. The machinery stays — a future such
// door joins this list or `_sessionTransitionPost`.
const _HOLDS_WRITES = [];
const _HOLD_MAX_MS = 15_000;
let _hold = null;
let _doorTail = Promise.resolve();
// Token requests are numbered; one issued before the latest door's answer
// arrived is never adopted (`loadCsrfToken`).
let _tokenReqSeq = 0;
let _lastDoorSendSeq = 0;
let _doorInFlight = false;
let _recovering = null;
// The token in hand is known to belong to a session this tab replaced (a
// door's hold ran out before the new token came). Cleared by the next token
// issued: until then no write is sent with it.
let _tokenDead = false;
const _inflightWrites = new Set();
export function trackInflightWrite(p) {
  _inflightWrites.add(p);
  p.then(() => _inflightWrites.delete(p), () => _inflightWrites.delete(p));
  return p;
}
function _endHold(h) {
  if (!h || _hold !== h) return;
  _hold = null;
  if (h.timer) clearTimeout(h.timer);
  h.release();
}
// `dead`: the hold ends by its time limit after its door replaced the session,
// so the token in hand belongs to a session that no longer exists.
function _armHold(h, ms, dead) {
  if (h.timer) clearTimeout(h.timer);
  h.timer = setTimeout(() => { if (dead) _tokenDead = true; _endHold(h); }, ms);
}
function _releaseOnToken() { if (_hold && _hold.awaitingToken) _endHold(_hold); }
/** Wait out this tab's own session change. False when it ended without the new
 *  session's token and one more fetch did not bring it: nothing may be sent. */
async function _waitOutHold() {
  while (_hold) await _hold.p;
  if (!_tokenDead) return true;
  // One recovery fetch, shared by every waiter.
  if (!_recovering) _recovering = loadCsrfToken().finally(() => { _recovering = null; });
  await _recovering;
  return !_tokenDead;
}
async function _settleInflightWrites() {
  const until = Date.now() + _HOLD_MAX_MS;
  while (_inflightWrites.size && Date.now() < until) {
    await Promise.race([Promise.allSettled([..._inflightWrites]), new Promise((r) => setTimeout(r, until - Date.now()))]);
  }
}
/**
 * Send a request that replaces this tab's own session (see above). `send()`
 * builds the request when called, so it carries the token in hand at the send.
 * Resolves the Response, or null when it was not sent: the tab turned out to be
 * out of date (and has said so), who the live session is could not be learnt,
 * or the previous door's session left no usable token.
 */
export function sendReplacingSession(send) {
  const run = _doorTail.then(() => _sendDoor(send));
  _doorTail = run.then(() => {}, () => {});
  return run;
}
async function _sendDoor(send) {
  if (!(await _waitOutHold())) return null;
  let release;
  const h = { p: new Promise((r) => { release = r; }), release: () => release(), timer: null, awaitingToken: false };
  _hold = h;
  // Before the send nothing is replaced yet, so a stall may release the held
  // writes safely; the door then is not sent.
  _armHold(h, 2 * _HOLD_MAX_MS, false);
  try {
    await _settleInflightWrites();
    if (csrfTokenStale() && !(await ensureFreshCsrf())) { _endHold(h); return null; }
    await _settleInflightWrites();
  } catch (e) { _endHold(h); throw e; }
  if (_hold !== h) return null;
  h.awaitingToken = true;
  // From the send the server may replace the session at any moment, so every
  // way this hold ends without the new token marks the token in hand dead —
  // the safe side: the next write asks for a token first. Until the door's
  // answer is in (its cookie set), no token answer is adopted at all.
  _armHold(h, 2 * _HOLD_MAX_MS, true);
  _doorInFlight = true;
  let r;
  try { r = await send(); } catch (e) { _doorInFlight = false; _lastDoorSendSeq = _tokenReqSeq; _tokenDead = true; _endHold(h); throw e; }
  _doorInFlight = false;
  _lastDoorSendSeq = _tokenReqSeq;
  if (!r.ok) { _endHold(h); return r; }
  // It replaced the session: only its new token may release the held writes;
  // past the limit, the token they hold is dead.
  if (_hold === h) _armHold(h, _HOLD_MAX_MS, true);
  return r;
}
/**
 * What a write asks immediately before it is sent: wait out this tab's own
 * session change, then the cross-tab check, until neither is pending. Every
 * write that bypasses the interceptor asks it, and sends synchronously after.
 */
export async function readyToWrite() {
  for (;;) {
    if (!(await _waitOutHold())) return false;
    if (!(await ensureFreshCsrf())) return false;
    // NEVER A WRITE WITHOUT A TOKEN, here too: a sign-in whose token refresh gave
    // up (`adoptNewSessionToken` answers false and leaves none) must not send the
    // next write with an empty token, whose 403 csrf_invalid would end the
    // session that sign-in just made. Wait for one the way a door does.
    if (!S.csrfToken && !(await _ensureToken())) return false;
    if (!_hold) return true;
  }
}
/** Eagerly, for a signed-in tab: re-sync as soon as another tab publishes, so
 *  a tab in the background is told before anyone comes back to it. Called once
 *  from boot(). */
export function installSessionSync() {
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== _CSRF_FP_KEY) return;
      if ((S.currentUser || S.isAdmin || S.isSuperAdmin) && csrfTokenStale()) ensureFreshCsrf().catch((e) => console.warn('CSRF re-sync failed', e));
    });
  } catch (_) { /* no storage events: the check before each write still runs */ }
}

/**
 * v8.3.17 (external audit) — FETCH A JSON ARRAY, OR SAY IT FAILED.
 *
 * `fetch(u).then(r=>r.json()).catch(()=>[])` was written at a dozen admin call
 * sites and is wrong in two ways at once, both silent:
 *
 *   • it never checks `r.ok`, so a 500's error BODY parses fine — `{error:"…"}`
 *     is valid JSON — and the caller gets an OBJECT where it expected an array.
 *     The next `.filter`/`.map` throws "X is not a function", the dialog never
 *     opens, and nothing is reported.
 *   • where the parse does fail, `[]` is returned — which the caller renders as
 *     "there are none". That is a confident WRONG ANSWER produced by a request
 *     that failed, which is the v7.23.5 rule ("a failure renders as a failure")
 *     in the one shape that looks like success.
 *
 * Returns `null` on ANY failure so a caller can tell "the fetch failed" from
 * "there genuinely are none", and NEVER returns a non-array. Same contract as
 * `_loadAdminTaskList` in challenges-admin.js, which is where this pattern was
 * first fixed; this is that fix made reusable.
 */
export async function fetchJsonList(url) {
  let r = null;
  try { r = await fetch(url); } catch (_) { return null; }
  if (!r.ok) return null;
  let d = null;
  try { d = await r.json(); } catch (_) { return null; }
  return Array.isArray(d) ? d : null;
}

/**
 * v8.3.20 (external audit) — the OBJECT sibling, and it is necessary rather
 * than symmetric.
 *
 * `fetchJsonList` structurally cannot serve the payloads that are not arrays —
 * the history reader's `{events, total, snapshot_before, snapshot_tie}`, the
 * group→competitions picker's `{competitions:[…]}`, the settings and
 * unsubscribed readers. Those sites were written
 * `fetch(u).then(r=>r.json()).catch(()=>null)` and then tested for TRUTHINESS,
 * which is precisely the bug: a 500's error body is `{error:"…"}` — truthy, and
 * a perfectly good object — so the failure branch never runs and the caller
 * renders an error payload as data.
 *
 * Returns `null` on any failure AND on a non-object, so a truthiness test on the
 * result is finally the right test.
 */
export async function fetchJsonObject(url) {
  let r = null;
  try { r = await fetch(url); } catch (_) { return null; }
  if (!r.ok) return null;
  let d = null;
  try { d = await r.json(); } catch (_) { return null; }
  return (d && typeof d === "object" && !Array.isArray(d)) ? d : null;
}

export async function fetchWithLoading(url, opts, loadingMsg) {
  showLoading();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    // ext-audit v7.15.15 — the deadline must survive the BODY read.
    //
    // `fetch` resolves at response HEADERS, so clearing the timer here left the
    // body unbounded: a server that sends headers and then stalls held this
    // await open for ever, spinner and all. This is the identical defect
    // v7.15.12 fixed in the server's own fetchWithTimeout — the abort signal
    // covers the body too, so the timer has to live until the body settles.
    const d = await r.json().catch(() => ({}));
    clearTimeout(timeout);
    hideLoading();
    return { r, d };
  } catch (e) {
    clearTimeout(timeout); hideLoading();
    showToast(e.name === 'AbortError' ? 'Request timed out. Please try again.' : 'Network error. Please try again.');
    return null;
  }
}

// ext-audit v7.15.13 — retry a TRANSIENT failure instead of ejecting on it.
//
// A participant's polling GETs (status, tasks, leaderboard) treated ANY
// non-ok response as "you are no longer in this competition" and threw them
// back to the picker. But a venue WiFi drop, a load-balancer 502/503/504, or a
// rate-limit 429 are all momentary and say nothing about membership — a
// participant working through a live competition was being ejected, with a
// message that misdescribed what had happened, by a blip.
//
// Makes up to three attempts, sleeping 400 ms then 800 ms between them (the
// last attempt is not followed by a sleep). Transient means: the fetch
// itself threw (offline / DNS / connection reset), 429, or any 5xx. A 4xx other
// than 429 is a real, considered answer from the server and is returned to the
// caller unchanged, so genuine "removed from the competition" handling is
// untouched. Returns the Response, or null when every attempt failed — callers
// treat null as "leave the current view alone and try again on the next poll",
// which is the correct response to a network that is merely down.
// Deadline timers handed over to the caller with the response, so the abort
// still covers the body read. WeakMap: an unread response is collectable and
// its timer is unref'd by the browser anyway once fired.
const _deadlines = new WeakMap();

/**
 * Read a fetchTransientRetry() response body under the SAME deadline that
 * covered its headers. Returns null if the body is unparseable or the deadline
 * fired mid-body — callers already treat null as "try again next poll".
 *
 * Always use this rather than `r.json()` on a fetchTransientRetry response: a
 * bare .json() leaves the timer armed (harmless) but, more importantly, leaves
 * a stalled body unbounded, which is the whole point of the deadline.
 */
export async function readBody(r) {
  if (!r) return null;
  try { return await r.json(); }
  catch (_) { return null; }
  finally { const t = _deadlines.get(r); if (t) { clearTimeout(t); _deadlines.delete(r); } }
}

export async function fetchTransientRetry(url, opts, { attempts = 3, baseDelayMs = 400, timeoutMs = 15000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    let r = null;
    // ext-audit v7.15.14 — EVERY attempt is deadline-bounded. Without this a
    // connection that opens and then stalls (the classic captive-portal / dead
    // WAN case) never settles, so the retry loop never advances, the caller's
    // await never returns, and the UI waits forever — the one failure mode the
    // retry was added to prevent.
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { console.warn('Request deadline: abort failed', e); } }, timeoutMs) : null;
    try { r = await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts); }
    catch (_) { r = null; }
    // ext-audit v7.15.15 — do NOT clear the timer here. `fetch` resolves at
    // response HEADERS, so a body that then stalls was unbounded and the whole
    // retry loop hung — the failure this helper exists to prevent. The caller
    // reads the body, so the deadline is handed over with the response: the
    // returned object carries `_deadline`, and readBody() below clears it.
    if (r && !(r.status === 429 || r.status >= 500)) {
      if (r && timer) _deadlines.set(r, timer);
      return r;                                                   // definitive answer
    }
    if (timer) clearTimeout(timer);
    if (i < attempts - 1) await new Promise(res => setTimeout(res, baseDelayMs * Math.pow(2, i)));
    else return r;   // last attempt: hand back whatever we got (possibly null)
  }
  return null;
}

// ── v8.8.23 — `profile_incomplete` is answered in ONE place ─────────────────
//
// 18 endpoints can answer `400 {error:"profile_incomplete", missing:[…]}` and,
// until now, exactly TWO client sites knew what it meant. The other 22 rendered
// the machine token — in a toast, or, on the submit path, inside the RED
// `.result-msg wrong` panel that otherwise means "your answer was incorrect",
// directly after the participant had accepted a permanent five-point penalty.
// The three polled reads were worse: the 400 fell past their transient guards
// into "You are no longer in this event.", which is false about membership.
//
// The structural answer, and the one `lib/middleware.js` had wrongly claimed was
// already here: the interceptor recognises the shape, opens the gate, and RETRIES
// the request the participant actually made. So a submit interrupted by a newly
// mandatory field completes once the field is filled, rather than being reported
// as a wrong answer and silently dropped. Retrying is safe because the check is
// the FIRST thing `requireCompetitionContext` does — the refusal happens before
// any handler work, so there is no partial state to duplicate.
//
// SKIPPED, and each for a reason: `/api/me` is the gate's OWN call, so
// intercepting it would recurse; the rest are anonymous
// doors that cannot produce this shape and must never be fronted by a gate.
const _PROFILE_GATE_SKIP = ['/api/me', '/api/login', '/api/register',
  '/api/logout', '/api/csrf-token', '/api/session/',
  // Telemetry nothing waits on — and the sign-out awaits it: the gate (which
  // cannot be dismissed) must never open for it.
  '/navigated-away'];

/**
 * Is this response the profile gate's 400? Reads a CLONE, so the caller's own
 * `readBody(r)` still works afterwards.
 */
export async function isProfileIncomplete(r) {
  if (!r || r.status !== 400) return false;
  try { const d = await r.clone().json(); return !!(d && d.error === 'profile_incomplete'); }
  catch (_) { return false; }
}

// Capture the native fetch BEFORE the interceptor is installed, so logout /
// session-status probes inside the interceptor (and the poll-stop / logout
// paths in session-monitor + auth) never recurse through it. Exported so those
// modules share the one captured reference.
export const _origFetch = window.fetch;

// How recently a human must have DONE something for a request to count as
// active. 60 s matches the keepalive's own DOM-activity gate, so the platform
// has one idea of "someone is here" rather than two that can disagree.
const INTENT_WINDOW_MS = 60_000;

// v7.14.0 — impersonation write tier, client side. The server's
// impersonationGuard (lib/impersonation.js) is the authority; this list decides
// only whether a SUPERADMIN impersonation session is fronted with the
// are-you-sure confirm.
//
// v8.3.27 — IT MIRRORS ONE OF THE SERVER'S THREE PREDICATES, NOT ALL OF THEM,
// and the missing entry is what made that worth writing down.
//
//   • `impersonationWriteAllowed` — "nothing durable changes": the navigation,
//     telemetry and escape-hatch paths. EVERY one of those belongs here, because
//     asking "are you sure? this will change real data" about a request that
//     changes none is noise that trains an operator to click through the confirms
//     that matter. `/api/deselect-competition` joined that list in v8.3.8 and was
//     never added here, so a superadmin impersonating met that modal for pressing
//     the **Events** nav item — pure navigation, whose one durable half is
//     suppressed under impersonation in the handler anyway. v8.12.1 —
//     `/api/toggle-admin-view` joined that list the day it stopped being
//     refused: under impersonation it is the in-session view switch (an event
//     admin's panel ⇄ their participant view), which changes no data at all.
//   • `impersonationReadOnlyWriteAllowed` — the read-only tier's certificate-mint
//     carve-out (v8.3.25). It must NOT be here, and the asymmetry is deliberate:
//     it writes an achievement_badges row and, for a placement badge, publishes a
//     permanent public page. A superadmin doing that should still be asked. A
//     reader "syncing the two lists" would delete exactly that confirm.
//   • `_IMPERSONATION_BLOCKED` — refused for every tier, so it never reaches the
//     confirm at all.
//
// `/api/csrf-token` is the one entry with no server counterpart: it is a GET, so
// the confirm could not fire for it regardless. A source scanner holds the
// server→client direction (*The mechanical locks*).
function _impersonationWriteExempt(url) {
  return url.includes('/api/impersonation/exit')
    || url.includes('/api/session/keepalive')
    || url.includes('/api/select-competition')
    || url.includes('/api/deselect-competition')
    || url.includes('/api/toggle-admin-view')
    || url.includes('/api/csrf-token')
    || url.includes('/api/login')
    || url.includes('/api/logout')
    || url.includes('/api/admin/certificate-config/preview')
    || url.includes('/api/admin/join-qr')
    || /\/api\/tasks\/[^/]+\/navigated-away/.test(url);
}
// Single in-flight confirm — concurrent state-changing requests (e.g. a save
// firing two calls) share one modal + one answer instead of stacking dialogs.
let _impConfirmInFlight = null;

// v8.12.6 — WHAT THE CLIENT DOES WHEN THE SERVER ANSWERS `impersonation_ended`
// (the impersonated account stopped qualifying mid-session; the server has
// restored, or will restore on the next request, the acting admin's own session).
// ONE definition because there are TWO callers: the fetch interceptor below, and
// the attachment editor's XHR upload, which `installFetchInterceptor` never sees —
// so without this the editor rendered the machine token "impersonation_ended" as
// its error message. Same toast, same reload into the admin's own view.
//
// v8.12.6 (review fix) — THE TOAST SAYS WHICH PERSON STOPPED QUALIFYING. The
// server's `reason` was ignored and every refusal read "the impersonated account
// is no longer active" — true of `target_inactive` alone. A participant write
// re-asks the ADMIN at commit now (`impersonatingHandDenied`), and telling an
// admin whose own access was revoked, or whose session was signed out
// elsewhere, that the participant's account had gone would send them looking
// at the wrong account. An absent or unknown reason keeps the old sentence,
// which is what every pre-existing `target_inactive` refusal still gets.
const _IMP_ENDED_COPY = {
  actor_inactive: 'Impersonation ended — your administrator access has ended, so nothing was saved.',
  session_ended: 'Impersonation ended — this session was signed out or changed elsewhere, so nothing was saved.',
};
export function announceImpersonationEnded(reason) {
  showToast(_IMP_ENDED_COPY[reason] || 'Impersonation ended — the impersonated account is no longer active.');
  setTimeout(() => { location.href = '/'; }, 900);
}

export function installFetchInterceptor() {
  // Another tab of this browser found the session ended (_stopAllPolls writes
  // the key): this tab's next request asks the session check first, rather
  // than learning it from a refused request of its own.
  window.addEventListener('storage', (e) => { if (e.key === 'ha:session-ended') S._sessionCheckDue = true; });
  window.fetch = async function (...args) {
    // Once this tab's session has ended (_stopAllPolls, features/session-monitor.js,
    // sets the flag) it sends no /api/ request at all: each would be refused,
    // and a room of signed-out browsers behind one address would get it blocked
    // as a scanner. Like a sign-out answer, the request never settles; the
    // sign-out's own requests (its status probe, the logout) use _origFetch.
    const _apiPath = _appApiPath(args[0]);
    if (S._pollsHalted && _apiPath) return new Promise(() => {});
    if (_apiPath && _apiPath !== '/api/session/status') {
      if (S._addressBlockedUntil > Date.now()) return _blockedAnswer();
      if (_sessionCheckDue()) {
        const live = await _confirmSessionLive();
        if (live === 'blocked') return _blockedAnswer();
        if (live === 'ended') return new Promise(() => {});
      }
    }
    // A write never leaves carrying a token another tab's session replaced
    // (`ensureFreshCsrf`). Out of date: the tab has been told, so the write
    // never settles, like any sign-out answer here. Unknown: nothing is sent,
    // and the caller is told so.
    // Nor one this tab's own session change is replacing (`_HOLDS_WRITES`).
    const _method = ((args[1] && args[1].method) || (typeof args[0] === 'object' && args[0]?.method) || 'GET').toUpperCase();
    const _isWrite = _method !== 'GET' && _method !== 'HEAD';
    const _replacing = _isWrite && _HOLDS_WRITES.some((p) => (typeof args[0] === 'string' ? args[0] : (args[0]?.url || '')).includes(p));
    const _notSent = () => (S._sessionOutOfDate ? new Promise(() => {})
      : new Response(JSON.stringify({ error: 'Could not check this tab\'s session with the server, so nothing was sent. Please try again.' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      }));
    if (_isWrite && !_replacing) {
      if (!(await readyToWrite())) return _notSent();
      _restampCsrf(args);
    }
    // v7.14.0 — superadmin impersonation: front EVERY state-changing /api
    // request with an explicit confirm. Regular-admin impersonation needs no
    // pre-flight — the server rejects the write and the 403 branch below
    // shows the "not allowed" modal.
    if (S.impersonation && S.impersonation.superadmin && !S._sessionExpiredHandled) {
      const url0 = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const method0 = ((args[1] && args[1].method) || (typeof args[0] === 'object' && args[0]?.method) || 'GET').toUpperCase();
      if (method0 !== 'GET' && method0 !== 'HEAD' && url0.includes('/api/') && !_impersonationWriteExempt(url0)) {
        if (!_impConfirmInFlight) {
          // v8.12.1 — the copy names the seat: inside an event admin's panel the
          // write lands on THEIR events, challenges and participants, attributed
          // to the acting superadmin in the audit trail; on the participant
          // surface it lands on the target's own record, as it always has.
          const _inOrganiserPanel = S.impersonation.view === 'admin' && S.impersonation.target_role === 'event_admin';
          _impConfirmInFlight = showModal({
            title: 'Impersonation mode',
            message: _inOrganiserPanel
              ? "You're in impersonation mode, inside this organiser's Event Admin Panel — are you sure? This will change real data on the events they run, recorded against your name."
              : "You're in impersonation mode — are you sure? This will change real data for the impersonated participant.",
            confirmText: 'Yes, proceed', confirmClass: 'danger',
          }).finally(() => { _impConfirmInFlight = null; });
        }
        const ok = await _impConfirmInFlight;
        if (!ok) {
          return new Response(JSON.stringify({ error: 'Cancelled — impersonation mode' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        // The confirm can stay open while a door that does not share it (Exit,
        // reachable by keyboard) replaces the session: ask again before sending.
        if (_isWrite && !_replacing) {
          if (!(await readyToWrite())) return _notSent();
          _restampCsrf(args);
        }
      }
    }
    // v8.14.4 — THE EVENT THIS TAB SHOWS rides every request, so the server can
    // refuse one the session would apply to a different event (see
    // _eventChangedElsewhere). Not while this tab is itself selecting an event:
    // the session is moving to that one, and the old name would read as a move
    // made elsewhere. Read here, after every await above, so it is the event the
    // tab shows as the request leaves. Same narrowness as the header below.
    let _tabEvent = null;
    const _tabGen = S._compGen;
    try {
      const u0 = args[0];
      const ev = S.currentCompetitionId;
      if (typeof u0 === "string" && u0.startsWith("/api/") && ev && !S._compSelecting) {
        const init = args[1];
        if (init === undefined) { args[1] = { headers: { "X-Competition-Id": ev } }; _tabEvent = ev; }
        else if (init && typeof init === "object" && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
          args[1] = { ...init, headers: { ...(init.headers || {}), "X-Competition-Id": ev } }; _tabEvent = ev;
        }
      }
    } catch (_) { /* the header must never break a request */ }
    // v8.1.0 (PR 34) — NET ACTIVE TIME rides the request the app was making
    // anyway. No beacon, no timer, no extra round trip: the server counts a
    // five-minute bucket when it sees this header, and a tab nobody is looking at
    // sends ordinary polls WITHOUT it, so it counts nothing.
    //
    // Deliberately narrow about when it will touch `args`: a string URL under
    // `/api/` with an absent or plain-object init. A Request object or a Headers
    // instance is left alone — a missed header costs one bucket, whereas
    // rewriting a request shape the caller built costs the request.
    try {
      const u0 = args[0];
      if (typeof u0 === "string" && u0.startsWith("/api/")
          && S._lastIntentAt && (Date.now() - S._lastIntentAt) < INTENT_WINDOW_MS) {
        const init = args[1];
        if (init === undefined) args[1] = { headers: { "X-Client-Active": "1" } };
        else if (init && typeof init === "object" && !(init.headers instanceof Headers)) {
          args[1] = { ...init, headers: { ...(init.headers || {}), "X-Client-Active": "1" } };
        }
      }
    } catch (_) { /* presence must never break a request */ }
    let r;
    if (_replacing) {
      r = await sendReplacingSession(() => { const a = [...args]; _restampCsrf(a); return _origFetch.apply(this, a); });
      if (r === null) return _notSent();
    } else {
      const sent = _origFetch.apply(this, args);
      if (_isWrite) trackInflightWrite(sent);
      r = await sent;
    }
    if (_apiPath && await _isAddressBlock(r)) _noteAddressBlocked(r.headers.get('Retry-After'));
    if (!S._sessionExpiredHandled) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      // v8.8.23 — THE PROFILE GATE. See the block above _origFetch for why this
      // is here rather than at 22 call sites.
      //
      // PARTICIPANTS ONLY. An admin can hold an incomplete profile for ever (the
      // gate is admin-exempt at both proactive triggers) and meets this shape in
      // participant view — where the gate is exactly the wrong instrument,
      // because it covers the header and hides the Admin View button that is
      // their only way out. That case is v8.7.3's, handled at the picker; leaving
      // it alone here is what keeps it handled.
      //
      // STRING URLS ONLY. A `Request` object's body is single-use, so retrying
      // one would throw. Nothing in this codebase passes one — the header
      // injection above says so too — and the gate still opens for it; only the
      // retry is withheld.
      // v8.14.4 — the server refused this request because the session now holds
      // another event than the one it named, or none. If THIS tab moved
      // meanwhile (every writer of S.currentCompetitionId bumps the generation,
      // and a pick may still be in flight), the answer goes back to its caller:
      // a read drops it on its own generation guard, an answer or a hint reports
      // the server's sentence (nothing was recorded). Otherwise another tab
      // moved the session: say so once, and hand back the never-settling
      // promise, so no caller paints an error under the notice. The
      // navigated-away beacon outlives its page and is never the messenger.
      if (r.status === 409 && _tabEvent && !url.includes('/navigated-away')) {
        let ed = null;
        try { ed = await r.clone().json(); } catch (_) { /* not JSON — not ours */ }
        if (ed && ed.code === 'competition_changed') {
          if (S._compGen === _tabGen && !S._compSelecting) {
            _eventChangedElsewhere(ed);
            return new Promise(() => {});
          }
          return r;
        }
      }
      if (r.status === 400 && S.userRole === 'participant' && !_PROFILE_GATE_SKIP.some(p => url.includes(p))) {
        let gd = null;
        try { gd = await r.clone().json(); } catch (_) { /* not JSON — not ours */ }
        if (gd && gd.error === 'profile_incomplete') {
          await openProfileCompletionGate(Array.isArray(gd.missing) ? gd.missing : []);
          if (typeof args[0] === 'string') {
            // THE SIGNAL MUST GO. `fetchTransientRetry` arms a 15-second abort
            // timer per attempt and deliberately does NOT clear it on a definitive
            // answer (it hands the deadline to `readBody`) — so by the time a human
            // has typed a phone number that controller has fired, and a retry
            // carrying its signal would abort instantly. Every signal in this
            // codebase is a network deadline rather than a user cancellation, so
            // dropping it on the retry is correct as well as necessary.
            let retryInit = args[1];
            if (retryInit && typeof retryInit === 'object') { retryInit = { ...retryInit }; delete retryInit.signal; }
            // ONE retry, never a loop: if the gate failed open (its re-verify GET
            // can fail — see auth.js) the second 400 is handed to the caller,
            // whose own branch then applies. RE-STAMPED: the gate can stay open
            // for minutes, so another tab's session may have replaced this one
            // meanwhile, and the request was built with the token the replaced
            // session had — sent as it was, it is refused, and the refusal ends
            // the session that replaced it.
            if (!(await readyToWrite())) return _notSent();
            const retryArgs = [args[0], retryInit];
            _restampCsrf(retryArgs);
            return await trackInflightWrite(_origFetch.apply(this, retryArgs));
          }
          return r;
        }
      }
      // ANONYMOUS DOORS BELONG HERE, and the sign-in-code pair was missing.
      // The `csrf_invalid` clause below fires with NO signed-in check, so a
      // login tab left open past the anonymous session's ~60-minute expiry
      // turned the code door into the full forced-signout machinery: polls
      // stopped, an unattributed POST /api/logout, a "Signed out — you were
      // signed out" modal shown to somebody who was never signed in, then a
      // reload — while the form's own await never resolved, because the
      // interceptor hands back a promise that never settles. /api/login has
      // always been on this list and handles the identical condition inline,
      // so two doors on one login card behaved differently.
      //
      // v8.10.2 — AND SO DOES FIRE-AND-FORGET TELEMETRY, for the same reason one
      // door over: a request nobody is waiting on must never be able to sign
      // somebody out.
      //
      // `/api/tasks/:id/navigated-away` is sent from the `pagehide` handler with
      // `keepalive:true` — deliberately, so it OUTLIVES the page (v7.27.0). That
      // makes it the one request in the SPA guaranteed to land AFTER a session
      // transition rather than before it. Exiting impersonation from inside a
      // challenge is the reachable case: the exit regenerates the session, the
      // page starts unloading, and the keepalive POST then arrives at the freshly
      // restored ADMIN session carrying the participant's context and the old
      // page's CSRF token. Whichever guard answers first, the interceptor took it
      // as proof the session had died:
      //   • `requireParticipant` -> 401 "Not authenticated" (built-in superadmin)
      //     -> _stopAllPolls, a "you were signed out" modal, and a fetch that
      //     NEVER SETTLES (`new Promise(() => {})` below) — the hang;
      //   • or, for a user-backed superadmin who had a competition selected,
      //     `staff` short-circuits membership and it reaches `csrfProtection`
      //     -> 403 `csrf_invalid` -> the one branch that POSTs /api/logout,
      //     which DESTROYS the admin session the exit had just restored. That is
      //     why the next refresh lands on the login page.
      // MEASURED end to end, and against v8.9.0 too: the mechanism predates the
      // seal work entirely and only ever surfaced as a race — whether the
      // keepalive response beat the navigation.
      //
      // Skipping it costs nothing: a genuine expiry is caught by the 15-second
      // status poll and the keepalive, both of which a human is actually waiting
      // on. Telemetry is the wrong messenger for it.
      //
      // v8.10.3 — AND SO DOES A DELIBERATE SESSION TRANSITION, which is the half
      // v8.10.2 missed by patching one request that can trip this instead of the
      // door that hangs.
      //
      // `POST /api/impersonation/exit` exists to REPLACE the session. Reading its
      // refusal as proof the session died is a category error, and an expensive
      // one: the branch below both destroys the session (the `csrf_invalid` arm
      // POSTs /api/logout) and hands the caller a promise that never settles — and
      // `exitImpersonation` AWAITS that fetch before `location.href = '/'`, so the
      // escape hatch is disabled by the very machinery that exists to handle a
      // dead session. MEASURED against a real server: exit -> 403 csrf_invalid ->
      // POST /api/logout -> "Signed out" with the page still on the impersonated
      // view and the restored admin session gone, so the next refresh lands on
      // login. Both halves of the reported symptom, one cause.
      //
      // The stale token is not contrived. An impersonation session idles out after
      // 60 minutes, and inside an ENDED competition the keepalive's
      // `_inLiveCompetition` arm is off — so only DOM activity keeps it alive, and
      // reading a challenge produces none. The sweep takes the row, the cookie
      // lives on, and the next request builds a fresh session whose `csrfToken` the
      // page's token cannot match.
      //
      // The entry POST is here for the same reason: it regenerates too, so its
      // refusal says nothing about the session the client is holding.
      //
      // THESE TWO ENTRIES AND `_sessionTransitionPost`'s `_origFetch` ARE
      // INDEPENDENTLY SUFFICIENT, AND NEITHER IS HELD BY A BEHAVIOURAL TEST.
      // Measured: reverting both turns the two v8.10.3 arms red; reverting either
      // one leaves the whole file green, because the raw fetch never reaches this
      // code and this list never lets this code act. A source arm in
      // `impersonation-exit-navaway.spec.js` pins both, for the v8.7.0 reason —
      // otherwise a reader deletes one on the evidence of a passing suite and is
      // right about the suite and wrong about the platform.
      // v8.12.1 — `/api/toggle-admin-view` joins the two impersonation doors for
      // the same reason: it regenerates the session, and under impersonation it
      // is the view switch — its refusal must never be read as an expiry.
      const skipPaths = ['/api/login', '/api/register', '/api/csrf-token', '/api/check-nickname',
        '/api/auth/code/request', '/api/auth/code/redeem', '/api/auth/code/drop-event', '/navigated-away',
        '/api/impersonation/exit', '/impersonate', '/api/toggle-admin-view'];
      if (!skipPaths.some(p => url.includes(p))) {
        if (r.status === 403 || r.status === 401) {
          const clone = r.clone();
          try {
            const d = await clone.json();
            // v7.14.0 — impersonation-mode responses. Both are RECOVERABLE (the
            // session is alive), so they must never fall through to the
            // forced-signout predicate below.
            //   • impersonation_readonly — a regular admin attempted a state-
            //     changing action; show the required "not allowed" modal once
            //     (parallel 403s share it) and hand the 403 back to the caller.
            //   • impersonation_ended — the target's account went inactive mid-
            //     impersonation; the server already restored the admin session,
            //     so reload back into the admin view.
            //   • impersonation_nested (v8.12.1, the guard's own 403 for a second
            //     entry from inside a seat) deliberately falls THROUGH to the
            //     caller: the Impersonate item is withheld inside a seat, so only
            //     a stale page reaches it, and the caller's toast renders the
            //     server's own sentence, which names the remedy (exit first).
            if (r.status === 403 && d.code === 'impersonation_readonly') {
              if (!S._impReadonlyModalOpen) {
                S._impReadonlyModalOpen = true;
                showModal({ title: 'Impersonation mode', message: 'This action is not allowed in impersonation mode.', confirmText: 'OK', confirmClass: '', cancelText: null })
                  .finally(() => { S._impReadonlyModalOpen = false; });
              }
              return r;
            }
            if (r.status === 403 && d.error === 'impersonation_ended') {
              announceImpersonationEnded(d.reason);
              return new Promise(() => {});
            }
            // A participant write refused at commit because its session ended
            // while it was in flight (`participantSessionDenied`). The sentence
            // is the caller's to render, and it says "try again" — which is true
            // only if this tab can send the retry. When the session ended because
            // ANOTHER tab replaced it (a sign-in or a view switch there), the jar
            // already holds the live replacement but this tab's CSRF token is the
            // dead session's, and the retry would be refused `csrf_invalid` —
            // which destroys the live session too. So ask the server: a live
            // session gets this tab a token for it ONLY when it is this tab's
            // own account acting as itself, in the view this tab shows
            // (`_liveSessionIsMine`). If another tab signed in as somebody
            // else, or entered impersonation, a fresh token would commit this
            // tab's retry as THAT account, so the token is left alone and the
            // retry is refused as before. A dead session is left exactly as it
            // is (refreshing would mint an anonymous session and lose the kick
            // context the next poll reports).
            if (r.status === 401 && d.code === 'session_ended') {
              try {
                const sr = await _origFetch('/api/session/status');
                const sd = sr.ok ? await sr.json() : null;
                if (S.currentUser && S.currentUser.id && _liveSessionIsMine(sd)) await loadCsrfToken();
              } catch (_) { /* leave the token alone */ }
              return r;
            }
            // v7.2.0 — the 403 "Account is not verified" clause: when an
            // verification grace window lapses mid-session, requireParticipant
            // destroys the session and returns this. Treat it as a forced
            // sign-out (the session is already gone) so the user is bounced to
            // login on the first expired request — including the verify-chip
            // ticker's own /api/me poll — rather than the next one.
            // v9.2.5 — a request that left on a session another tab of this
            // browser has since REPLACED (it signed in again: the session
            // regenerates, and tabs share the cookie) comes back 401 "Not
            // authenticated" while the browser is signed in, as the same
            // account, in the same view. Ask before signing out: when the live
            // session is this tab's own, the refusal goes back to the caller,
            // the token re-synced, as for session_ended above. Seen signing a
            // tab out while another signed in (csrf-cross-tab, the full suite).
            if (r.status === 401 && d.error === 'Not authenticated' && (S.currentUser || S.isAdmin || S.isSuperAdmin)) {
              let sd = null;
              try { const sr = await _origFetch('/api/session/status'); if (sr.ok) sd = await sr.json(); } catch (_) { sd = null; }
              if (_liveSessionIsMine(sd)) { await loadCsrfToken(); return r; }
            }
            if (d.error === 'csrf_invalid' || d.error === 'session_expired' || (r.status === 401 && d.error === 'Not authenticated' && (S.currentUser || S.isAdmin || S.isSuperAdmin)) || (r.status === 403 && d.error === 'Account is not verified' && (S.currentUser || S.isAdmin || S.isSuperAdmin))) {
              S._sessionExpiredHandled = true;
              _stopAllPolls();
              // v7.2.x (CTF-0026, fix D) — only POST /api/logout for csrf_invalid.
              // It was written as the one trigger that could fire while the
              // server session was still alive. CORRECTED v8.13.4: it never
              // reliably did that job. The server's EBADCSRFTOKEN handler has
              // destroyed a user account's session on the refusal itself since
              // v8.3.13 — an impersonation session among them, since it carries
              // the TARGET's userId (v8.13.4 adds closing its window first) —
              // and since v8.13.4 it destroys the built-in superadmin's too:
              // every session carrying an identity. And when S.csrfToken is itself the stale token, this
              // POST carries it and is refused as well: that is how the built-in
              // superadmin used to see "Signed out" and then reload straight
              // back into the admin panel. The POST is now redundant for every
              // session that carries an identity — the refusal has already ended
              // it, so this lands on a fresh anonymous session and is refused —
              // and it is kept only because a source lock pins it
              // (functional-core-a, CTF-0026 D); removing it is a decision for
              // the operator, not a cleanup. The other triggers — 401 'Not authenticated' / 'session_expired',
              // and the grace-lapse 403 where requireParticipant has already
              // destroyed the session — mean the session is already GONE, so a
              // logout POST is a redundant no-op that only adds a confusing,
              // un-attributed POST /api/logout line to the access log. Skip it there.
              if (d.error === 'csrf_invalid') {
                _origFetch('/api/logout', { method: 'POST', headers: csrfHeaders() }).catch((e) => console.warn('Sign-out request failed', e));
              }
              (async () => {
                // v7.15.4 — classify WHY the session ended before announcing it.
                // This same status fetch already carried `server_started_at`, but
                // only `kicked_by` was read, so a server restart was reported as
                // "signed out due to inactivity". Because a restart 401s every
                // request, and the SPA's other polls (15 s) beat the session
                // monitor's own 30 s tick, this path is the one users actually
                // hit — the monitor's correct check almost never got to run.
                // Share its classifier so the two can't diverge again.
                // Probe the server for WHY. A failed probe must NOT fall back to
                // "inactivity": mid-deploy the app can be back up enough to 401
                // this request while /api/session/status still hits a warming
                // upstream (502/503), which is exactly when claiming the user was
                // idle is both wrong and most annoying. `null` → 'unknown' →
                // neutral copy. `d.error` is threaded through so a csrf_invalid
                // (a stale token, not idleness — the refusal itself ended the
                // session, v8.13.4) and the verification-grace 403 are not
                // misreported as an idle timeout either.
                let statusBody = null;
                try {
                  const sr = await _origFetch('/api/session/status');
                  if (sr.ok) statusBody = await sr.json();
                } catch (_) { /* leave null — classified as 'unknown' */ }
                const verdict = _classifySignout(statusBody, d.error);
                try {
                  if (typeof _announceSignout === 'function') {
                    await _announceSignout(verdict, d.error);
                    return; // already navigates to /
                  } else if (typeof showModal === 'function') {
                    await showModal({ title: 'Signed out', message: 'You were signed out. Please sign in again to continue.', confirmText: 'OK', confirmClass: '', cancelText: null });
                  }
                } catch (_) { /* still navigate */ }
                S.currentUser = null; S.isAdmin = false; S.isSuperAdmin = false; S.isEventAdmin = false; S.isAdminView = false;
                if (typeof S._helpLastDoc !== 'undefined') S._helpLastDoc = null;
                location.href = '/';
              })();
              return new Promise(() => {});
            }
          } catch (e) { console.warn('Session interceptor: failed to parse response', e); }
        }
      }
    }
    return r;
  };
}
