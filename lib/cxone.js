"use strict";

// CxOne (Checkmarx One) IDP provisioning: API-key decode, per-competition config
// resolution, bearer-token fetch, and the bounded (5-in-flight / 5000-queued)
// provisioning queue that creates/links users in CxOne off the request hot path.
// (v7.0.0 refactor: extracted verbatim from server.js. Deps: db, competitions,
// http, log, audit, cxone-identity, cxone-ledger, config, time; lib/cxone-withdraw
// is required lazily, only to kick the withdrawal runner.)
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS THE PLATFORM'S ONLY EGRESS OF PARTICIPANT PII TO A THIRD PARTY, AND
// THE PARTICIPANT IS TOLD NOTHING ABOUT IT. Parked at v8.8.9 and ACCEPTED by the
// operator on 7 September 2026: the platform ships without a participant-facing
// notice. That is a settled decision about the NOTICE and nothing else — it
// does not cover the facts below it. The full disposition — what is transmitted,
// when, why the remedy would be a NOTICE LINK and never a consent checkbox — is
// in CLAUDE.md under *Accepted audit dispositions*. Read it before changing
// anything here, and in particular:
//
//   * `POST /users` below sends nickname + first name + last name + email
//     UNCONDITIONALLY, before any lookup — so the data leaves on every attempt,
//     not only when an account is created. A 409 then searches by nickname and
//     by up to three addresses. Widening either is a disclosure decision, not a
//     refactor. A set-up DEFERRED because the account it reached was being
//     removed re-sends both on each retry — at most PROVISION_RETRY_MAX times.
//     A job that CREATED an account then reads it back by the realm's own id
//     (its record and its role mappings, the creation baseline) and sends
//     nothing about the participant in doing so.
//   * ERASURE PROPAGATES FOR ACCOUNTS THIS PLATFORM CREATED (v8.12.7), AND FOR
//     NOTHING ELSE. Every realm account whose id came back on OUR OWN 201 — a
//     Location naming a UUID, the only proof we made it — is recorded in
//     `cxone_realm_accounts` (lib/cxone-ledger.js) the moment it exists.
//     `deleteUserCascade` stamps that participant's rows pending in the same
//     transaction as the erasure, and lib/cxone-withdraw.js removes them from
//     the realm, retrying and holding what needs a decision for a superadmin
//     under Settings → Checkmarx One account removals. Rows backfilled from
//     history (bindings from v8.8.15 on) are held for a superadmin's
//     confirmation; bindings older than that cannot be traced to an account id.
//     A MATCHED or pre-existing account is NEVER touched: it belongs to the
//     customer's tenant and may predate us. A job still IN FLIGHT when its
//     participant is deleted withdraws the account it created in that run at
//     once (`_abandon` below), and hands a refusal to the same runner.
//     Do not read the accepted notice decision as covering any of this.
//   * DO NOT "fix" the notice gap with a consent checkbox. It was rejected by
//     the original design (EVENTS_REDESIGN_DETAIL.md §16) and again at v8.8.9:
//     a tick whose only alternative is not attending is not freely given.
// ─────────────────────────────────────────────────────────────────────────────

const db = require("../db");
const { swallowed } = require("./best-effort");
const { getCompetition } = require("./competitions");
const { fetchWithTimeout, EXTERNAL_FETCH_TIMEOUT_MS } = require("./http");
const { sanitiseForLog } = require("./log");
const { recordUserEvent, recordOrphanedAuditEvent, runTxnWithMirrorBuffer } = require("./audit");
const { cxOneMatchQuality, CXONE_ACCEPTABLE_BASES, resolveCxOneGroup, buildCreationBaseline } = require("./cxone-identity");
const { UUID_RE, recordCreated, recordCreationBaseline, releaseClaim, deleteOwned, markInFlightRefusal, markInFlightSkip, transferTo, livingBinder, BINDING_UNREADABLE, forgetGoneAccount } = require("./cxone-ledger");
const { BASE_URL } = require("./config");
const { now } = require("./time");
const nowIso = () => now().toISOString();

const CXONE_HOSTNAME_ALLOWED = /^(?:[a-z0-9-]+\.)*iam\.checkmarx\.(?:net|com)$/i;
function decodeCxOneApiKey(apiKey) {
  if (!apiKey) return null;
  try {
    const payload = JSON.parse(Buffer.from(apiKey.split(".")[1], "base64url").toString());
    const iss = payload.iss;                         // e.g. https://iam.checkmarx.net/auth/realms/my_tenant
    const m = iss.match(/^(https:\/\/[^/]+)\/auth\/realms\/(.+)$/);
    if (!m) return null;                             // only https accepted, regex no longer allows http
    const iamUrl = m[1];                             // https://iam.checkmarx.net
    const tenant = m[2];                             // my_tenant
    let hostname;
    try { hostname = new URL(iamUrl).hostname; } catch { return null; }
    if (!CXONE_HOSTNAME_ALLOWED.test(hostname)) return null;
    // audit v7.7.36 (C3) — derive the AST host by swapping the `iam` LABEL, not
    // the scheme-anchored "://iam." substring. A region-prefixed IAM host
    // (e.g. eu.iam.checkmarx.net, permitted by CXONE_HOSTNAME_ALLOWED) has no
    // "://iam." so the old replace was a no-op, leaving baseUrl on the identity
    // host and misleading the admin CxOne panel (cxone_base_url). Replace the
    // first `iam.` label (optionally after a region prefix) with `ast.`.
    const astHost = hostname.replace(/(^|\.)iam\./, "$1ast.");
    const baseUrl = iamUrl.replace(hostname, astHost);
    return { iamUrl, tenant, baseUrl, apiKey };
  } catch { return null; }
}

function getCxOneConfig(competitionId) {
  // Check competition-specific config first
  if (competitionId) {
    const comp = getCompetition(competitionId);
    if (comp?.cxone_api_key) {
      const decoded = decodeCxOneApiKey(comp.cxone_api_key);
      if (decoded) return decoded;
    }
  }
  // Fall back to global default
  const apiKey = db.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get()?.value || "";
  return decodeCxOneApiKey(apiKey);
}

// The realm's token endpoint for a decoded config. ONE definition, because
// lib/cxone-withdraw.js exchanges the same refresh token when it removes an
// account this platform created — two spellings of one URL is how one of them
// comes to point at a different realm.
function _tokenUrl(cfg) {
  return `${String(cfg.iamUrl)}/auth/realms/${encodeURIComponent(String(cfg.tenant))}/protocol/openid-connect/token`;
}

// v8.13.1 (external audit) — has the realm account a provisioning job created
// passed to a LIVING participant since? Answers the reason (truthy) or null.
// Synchronous and await-free, so a caller can ask it immediately before a
// DELETE with nothing in between:
//   • the ledger row names somebody else — a replacement's provisioning matched
//     the account and `transferTo` re-keyed it to them;
//   • the job recorded the row and no longer holds its claim (a transfer ends
//     every claim; nothing else releases a held row early) — not ours to act on;
//   • a living participant is bound to the id locally (their event binding, or
//     their own provisioning history) — `livingBinder`, the runner's question;
//   • or MAY be: a living participant's provisioning record names the id but
//     cannot be read (`binding_unreadable`) — the runner holds such an account
//     for a superadmin, and this job does not remove it either.
function _withdrawalOwnershipLost(cxoneUserId, erasedUserId, claim) {
  const r = db.prepare("SELECT user_id, claim_token FROM cxone_realm_accounts WHERE cxone_user_id=?").get(cxoneUserId);
  if (r && r.user_id !== erasedUserId) return "transferred_to_living_account";
  if (claim && (!r || r.claim_token !== claim)) return "claim_lost";
  const binder = livingBinder(db, cxoneUserId);
  if (binder === BINDING_UNREADABLE) return "binding_unreadable";
  if (binder) return "bound_to_living_account";
  return null;
}

// v8.12.7 (pre-release review) — the ONE definition of the fingerprint the
// ledger keeps of the address a create sent (`created_email_sha`), shared with
// lib/cxone-withdraw.js, which compares the realm's CURRENT address against it
// and holds an account the tenant has re-addressed. sha256 of the trimmed,
// lowercased address — the realm may fold case, and a fingerprint is compared,
// never read back — and NULL when there is no address to fingerprint, which
// makes the runner skip that one check rather than compare against nothing.
function createdEmailSha(email) {
  if (typeof email !== "string" || !email.trim()) return null;
  return require("crypto").createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

async function cxOneGetBearerToken(cfg) {
  const resp = await fetchWithTimeout(_tokenUrl(cfg), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: "ast-app", refresh_token: cfg.apiKey }),
  });
  if (!resp.ok) throw new Error(`CxOne auth failed (${resp.status})`);
  return (await resp.json()).access_token;
}

// v6.16.14 — concurrency cap on CxOne provisioning. Pre-fix bulk-
// assign / bulk-invite / per-comp txn fanned out one setImmediate per
// (user, comp) pair; with BULK_ADMIN_MAX=1000 users × 50 comps
// that's up to 50,000 HTTP roundtrips queued in a single tick. Each
// `cxOneProvisionUser` performs 4-5 sequential HTTP calls to the
// IDP and starts with a token fetch — a thundering-herd on the
// token endpoint or a saturated connection pool is the realistic
// risk. A small semaphore (5 in-flight) keeps the upstream pressure
// linear without serialising the whole batch.
const CXONE_MAX_INFLIGHT = 5;
// v6.16.16 — cap the queue depth. Pre-fix the queue was unbounded;
// an admin running back-to-back bulk-assigns under a slow IDP could
// retain hundreds of MB of closures (each ~1-2 KB capturing the
// `user` row + competitionId). At 5000 entries × ~2 KB = ~10 MB,
// which is comfortably above any realistic operator workflow but
// caps the worst case. Overflow drops OLDEST (FIFO eviction) so the
// most-recent intent stays intact — admins re-running the bulk-assign
// after recovery is the documented best-effort recovery path.
const CXONE_QUEUE_MAX = 5000;
let _cxOneInflight = 0;
const _cxOneQueue = [];
let _cxOneQueueDropped = 0;  // lifetime counter, surfaced via /metrics
// v8.12.7 — a created account this platform could NOT record for later
// withdrawal, counted by why. A 201 whose Location names no id, a 2xx that is
// not a 201, an id that is not a UUID, a create request that never answered,
// and a ledger write that failed on every retry: each is an account that may
// exist in the realm with nothing here able to remove it when its participant
// is erased. In-process (a lifetime count since boot, like the queue gauges),
// so it is a monitoring signal, not a record — the warn lines are the record.
const _createUnconfirmed = { no_location: 0, non_201: 0, id_not_uuid: 0, post_unanswered: 0, ledger_write_failed: 0 };
function _countUnconfirmed(kind) { if (kind in _createUnconfirmed) _createUnconfirmed[kind]++; }
function cxOneCreateUnconfirmedCounts() { return { ..._createUnconfirmed }; }
function _instanceOrigin() { try { return new URL(BASE_URL).origin; } catch (_) { return null; } }
// Resolved when the queue is empty and nothing is in flight (the provisioning
// harness waits on it between steps).
const _cxOneIdleWaiters = [];
function _drainCxOneQueue() {
  while (_cxOneInflight < CXONE_MAX_INFLIGHT && _cxOneQueue.length) {
    const fn = _cxOneQueue.shift();
    _cxOneInflight++;
    Promise.resolve()
      .then(fn)
      .catch(e => console.error("CxOne queued task:", sanitiseCxOneError ? sanitiseCxOneError(e) : (e && e.message)))
      .finally(() => {
        _cxOneInflight--; _drainCxOneQueue();
        if (_cxOneInflight === 0 && !_cxOneQueue.length) for (const w of _cxOneIdleWaiters.splice(0)) w();
      });
  }
}
function cxOneQueueIdle() {
  if (_cxOneInflight === 0 && !_cxOneQueue.length) return Promise.resolve();
  return new Promise((resolve) => _cxOneIdleWaiters.push(resolve));
}
// One key per (participant, event): deferred retries and queued jobs are keyed on it.
const _retryKey = (userId, competitionId) => `${userId}\u0000${competitionId || ""}`;
// Jobs queued or running, per (participant, event). The re-assign remedy asks it,
// so it never queues a second job beside one a fired retry, the boot's resume or
// an earlier re-assign queued — two creates for one person. Counted when queued
// (before the job can run), released when the job ends or a full queue drops it.
const _provisionJobs = new Map();
function _provisionJobDone(key) {
  const n = (_provisionJobs.get(key) || 0) - 1;
  if (n > 0) _provisionJobs.set(key, n); else _provisionJobs.delete(key);
}
function enqueueCxOneProvision(user, competitionId, label, opts) {
  // v6.16.16 — overflow handling. Drop oldest, log once per overflow
  // event (not per push) so a sustained backlog produces one
  // operator-visible warn line per breach rather than per row.
  if (_cxOneQueue.length >= CXONE_QUEUE_MAX) {
    const dropped = _cxOneQueue.shift();
    if (dropped && dropped._jobKey) _provisionJobDone(dropped._jobKey);
    _cxOneQueueDropped++;
    if (_cxOneQueueDropped === 1 || _cxOneQueueDropped % 100 === 0) {
      console.warn(`[cxone] queue overflow — dropped oldest task (lifetime drops: ${_cxOneQueueDropped}, depth: ${_cxOneQueue.length}/${CXONE_QUEUE_MAX}, in_flight: ${_cxOneInflight}). CxOne IDP may be slow/unreachable; check upstream health.`);
    }
  }
  const jobKey = _retryKey(user && user.id, competitionId);
  _provisionJobs.set(jobKey, (_provisionJobs.get(jobKey) || 0) + 1);
  const job = async () => {
    try { await cxOneProvisionUser(user, competitionId, opts); }
    catch (e) { console.error(`CxOne provision (${label || "queued"}):`, sanitiseCxOneError(e)); }
    finally { _provisionJobDone(jobKey); }
  };
  job._jobKey = jobKey;
  _cxOneQueue.push(job);
  _drainCxOneQueue();
}

// ─── A realm removal in progress, and a match that must wait for it ─────────
//
// TWO CODE PATHS REMOVE A REALM ACCOUNT: the withdrawal runner (lib/cxone-withdraw.js)
// and a provisioning job whose participant was erased mid-flight (`_abandon`
// below). Each decides "is this still ours to delete?" synchronously and then
// AWAITS its DELETE — and a replacement participant's provisioning (someone who
// registered with the erased person's address) could match the same account in
// that window: re-key its ledger row, write its event binding, and be left linked
// to an account the DELETE then removed (external audit; reproduced both ways).
//
// So a removal is ANNOUNCED to the process before its DELETE leaves
// (`beginRealmRemoval`, in the same synchronous block as the remover's last
// ownership check) and SETTLED when the answer is known. A provisioning job asks
// (`realmRemovalBlock`) immediately before it takes an account over, before its
// binding write-back and in its catch, and DEFERS instead of binding: a
// `cxone_provisioned {deferred}` row and a retry through the queue. Process
// memory on purpose: one process per data volume (CLAUDE.md, Architecture), and
// no DELETE survives a restart. Whatever the realm says is gone — a DELETE answered
// 2xx/404, or the runner's read answered 404 — also goes through
// `accountGoneFromRealm`, the repair layer for any link made anyway.
//
// How long a settled removal is remembered, and how long an announced one may
// stay unanswered before it counts as abandoned (a bug guard: every DELETE is
// bounded by the fetch deadline). `EXTERNAL_FETCH_TIMEOUT_MS` is parsed from the
// environment, and NaN would turn every comparison false — a gate that never
// blocks — so anything unusable falls back to the floor.
const _MIN = 60_000;
const _FETCH_MS = Number.isFinite(EXTERNAL_FETCH_TIMEOUT_MS) && EXTERNAL_FETCH_TIMEOUT_MS > 0 ? EXTERNAL_FETCH_TIMEOUT_MS : 10_000;
const REALM_REMOVAL_MEMORY_MS = Math.max(15 * _MIN, 8 * _FETCH_MS);
// The retry series of a deferred job. Its cumulative span must outlast the
// memory window plus one unanswered DELETE, or every retry could land inside it
// and the participant be left with no account — so the last delay is derived
// from the window, here and nowhere else.
const PROVISION_RETRY_DELAYS_MS = Object.freeze((() => {
  const head = [5_000, 30_000, 2 * _MIN, 5 * _MIN];
  const spent = head.reduce((a, b) => a + b, 0);
  return [...head, Math.max(10 * _MIN, REALM_REMOVAL_MEMORY_MS + _FETCH_MS + _MIN - spent)];
})());
const PROVISION_RETRY_MAX = PROVISION_RETRY_DELAYS_MS.length;
const REALM_REMOVALS_MAX = 10_000;

const _realmRemovals = new Map();   // cxone_user_id -> {state, realm, startedAt, settledAt}

// The realm a decoded config addresses: its IAM origin and tenant. ONE definition
// (lib/cxone-withdraw.js keys its group set on it too). null when undecodable.
function cxOneRealmKey(cfg) {
  if (!cfg) return null;
  let o = null;
  try { o = new URL(cfg.iamUrl).origin; } catch (_) { return null; }
  return o + "\u0000" + String(cfg.tenant);
}

// The ONE classification of a DELETE's answer, for both removers. Positive:
// only a 2xx or a 404 says the account is gone, and only a 4xx says the realm
// refused (the account is still there). A 5xx — a gateway, a crash after the
// commit — or no answer at all may or may not have removed it.
function classifyRealmRemoval(status) {
  if (!Number.isInteger(status) || status <= 0) return "unknown";
  if ((status >= 200 && status < 300) || status === 404) return "removed";
  if (status >= 400 && status < 500) return "refused";
  return "unknown";
}

function _removalExpired(e, nowMs) {
  const at = e.state === "in_flight" ? e.startedAt : e.settledAt;
  return !(nowMs - at <= REALM_REMOVAL_MEMORY_MS);
}
// Expired entries first; past the cap, the oldest TOMBSTONES — never an
// announced or unanswered removal, which would fail open.
function _pruneRealmRemovals(nowMs) {
  for (const [id, e] of _realmRemovals) if (_removalExpired(e, nowMs)) _realmRemovals.delete(id);
  if (_realmRemovals.size < REALM_REMOVALS_MAX) return;
  const removed = [..._realmRemovals].filter(([, e]) => e.state === "removed").sort((a, b) => a[1].settledAt - b[1].settledAt);
  for (const [id] of removed) {
    if (_realmRemovals.size < REALM_REMOVALS_MAX) break;
    _realmRemovals.delete(id);
  }
}

// Announce a removal. false when another removal of the same account is
// already in flight — the caller must not send a second DELETE.
function beginRealmRemoval(cxoneUserId, cfg) {
  if (typeof cxoneUserId !== "string" || !cxoneUserId) return false;
  const nowMs = Date.now();
  _pruneRealmRemovals(nowMs);
  const e = _realmRemovals.get(cxoneUserId);
  if (e && e.state === "in_flight" && !_removalExpired(e, nowMs)) return false;
  _realmRemovals.set(cxoneUserId, { state: "in_flight", realm: cxOneRealmKey(cfg), startedAt: nowMs, settledAt: null });
  return true;
}

// Settle it: "removed" keeps a tombstone, "refused" forgets it (the account is
// still there, and a waiting match may take it), anything else is "unknown" and
// holds matches until the runner reads the realm again or the window ends.
// Returns the outcome it recorded.
function settleRealmRemoval(cxoneUserId, outcome) {
  const o = outcome === "removed" || outcome === "refused" ? outcome : "unknown";
  if (typeof cxoneUserId !== "string" || !cxoneUserId) return o;
  const e = _realmRemovals.get(cxoneUserId);
  if (o === "refused") { _realmRemovals.delete(cxoneUserId); return o; }
  const nowMs = Date.now();
  _realmRemovals.set(cxoneUserId, { state: o, realm: e ? e.realm : null, startedAt: e ? e.startedAt : nowMs, settledAt: nowMs });
  // An unanswered removal is re-read by the runner a minute later, so a match
  // waits that long rather than the whole window (lib/cxone-withdraw.js).
  if (o === "unknown") { try { require("./cxone-withdraw").armUnansweredRemovalReread(); } catch (err) { swallowed("cxone:arm-removal-reread", err); } }
  return o;
}

// The realm answered that the account is gone (a read's 404) — a tombstone with
// no announcement before it.
function noteRealmAccountGone(cxoneUserId, cfg) {
  if (typeof cxoneUserId !== "string" || !cxoneUserId) return;
  const e = _realmRemovals.get(cxoneUserId);
  const nowMs = Date.now();
  _realmRemovals.set(cxoneUserId, { state: "removed", realm: cxOneRealmKey(cfg) || (e ? e.realm : null), startedAt: e ? e.startedAt : nowMs, settledAt: nowMs });
}

// The realm answered that the account still exists: an unanswered removal did
// not happen. Only an "unknown" entry is cleared.
function clearUnknownRealmRemoval(cxoneUserId) {
  const e = _realmRemovals.get(cxoneUserId);
  if (e && e.state === "unknown") _realmRemovals.delete(cxoneUserId);
}

// May a provisioning job take this account over now? null, or why not.
function realmRemovalBlock(cxoneUserId) {
  const e = _realmRemovals.get(cxoneUserId);
  if (!e) return null;
  if (_removalExpired(e, Date.now())) { _realmRemovals.delete(cxoneUserId); return null; }
  if (e.state === "in_flight") return "removal_in_flight";
  if (e.state === "removed") return "recently_removed";
  return "removal_outcome_unknown";
}

// Any removal in this realm in flight, or settled removed/unknown since
// `sinceMs` — the strongest. A create that answered 409 and then found nothing
// raced one of these (the account it collided with was removed in between).
function realmRemovalSince(realmKey, sinceMs) {
  if (!realmKey) return null;
  const nowMs = Date.now();
  let unknown = false, removed = false;
  for (const e of _realmRemovals.values()) {
    if (e.realm !== realmKey || _removalExpired(e, nowMs)) continue;
    if (e.state === "in_flight") return "removal_in_flight";
    if (!(e.settledAt >= sinceMs)) continue;
    if (e.state === "removed") removed = true; else unknown = true;
  }
  return unknown ? "removal_outcome_unknown" : removed ? "recently_removed" : null;
}

function _testOnly(name) {
  if (process.env.NODE_ENV !== "test") throw new Error(`${name} is a test hook`);
}
function _realmRemovalsSnapshotForTest() {
  _testOnly("_realmRemovalsSnapshotForTest");
  const nowMs = Date.now();
  return [..._realmRemovals].map(([id, e]) => ({ id, state: e.state, ageMs: nowMs - (e.settledAt ?? e.startedAt) }));
}
function _ageRealmRemovalsForTest(ms) {
  _testOnly("_ageRealmRemovalsForTest");
  for (const e of _realmRemovals.values()) {
    e.startedAt -= ms;
    if (e.settledAt != null) e.settledAt -= ms;
  }
  return _realmRemovals.size;
}

// ─── Deferred provisioning, retried through the queue ──────────────────────
//
// Keyed per (participant, event). The entry is written BEFORE its timer is armed
// (CLAUDE.md: count before you schedule), so nothing can see a timer with no
// entry. A retry re-reads the participant's row and goes through the ordinary
// chokepoint, which re-asks existence, the event, the opt-out and the
// membership. Each retry re-sends the participant's name and address to the
// realm (`POST /users`), at most PROVISION_RETRY_MAX times per deferral.
const _provisionRetries = new Map();
let _retriesStopping = false;
const _deferredCounts = { removal_in_flight: 0, removal_outcome_unknown: 0, recently_removed: 0, removal_raced_match: 0 };

function _scheduleProvisionRetry(userId, competitionId, attempt, delayMs, reason) {
  if (_retriesStopping || !userId || !(attempt >= 1 && attempt <= PROVISION_RETRY_MAX)) return false;
  const key = _retryKey(userId, competitionId);
  if (_provisionRetries.has(key)) return true;
  const entry = { userId, competitionId: competitionId || null, attempt, reason, delayMs, timer: null };
  _provisionRetries.set(key, entry);
  entry.timer = setTimeout(() => _fireProvisionRetry(key), delayMs);
  if (typeof entry.timer.unref === "function") entry.timer.unref();
  return true;
}

function _fireProvisionRetry(key) {
  const e = _provisionRetries.get(key);
  if (!e) return;
  _provisionRetries.delete(key);
  clearTimeout(e.timer);
  let fresh = null;
  try { fresh = db.prepare("SELECT id, nickname, first_name, last_name, email FROM users WHERE id=?").get(e.userId); } catch (err) { swallowed("cxone:retry-user-reread", err); }
  if (!fresh) return;
  enqueueCxOneProvision(fresh, e.competitionId, "after_realm_removal", { retryAttempt: e.attempt });
}

// Graceful shutdown: start NO remote work. A retry flushed into a 5 s drain
// would send creates the exit can cut mid-flight — accounts nothing records.
// Each pending retry is cancelled and said, truthfully, in the participant's
// History; the next boot resumes it (`resumeDeferredCxOneProvisioning`). A boot
// resume still waiting for its health gate is cancelled too.
function stopCxOneProvisionRetries() {
  _retriesStopping = true;
  _endResumeWait();
  let n = 0;
  for (const [key, e] of [..._provisionRetries]) {
    clearTimeout(e.timer);
    _provisionRetries.delete(key);
    try {
      if (!_userStillExists(e.userId)) continue;
      recordUserEvent(e.userId, "cxone_provisioned", "system", {
        competition_id: e.competitionId, success: false, deferred: e.reason,
        retry_scheduled: false, retry_attempt: e.attempt, stopped: "shutdown", instance_origin: _instanceOrigin(),
      });
      n++;
    } catch (err) { swallowed("cxone:retry-stop-record", err); }
  }
  return n;
}

function cxOneProvisionRetriesPending() { return _provisionRetries.size; }
function cxOneProvisionDeferredCounts() { return { ..._deferredCounts }; }
function _provisionRetriesSnapshotForTest() {
  _testOnly("_provisionRetriesSnapshotForTest");
  return [..._provisionRetries.values()].map(({ userId, competitionId, attempt, reason, delayMs }) => ({ userId, competitionId, attempt, reason, delayMs }));
}
function _fireCxOneProvisionRetriesNowForTest() {
  _testOnly("_fireCxOneProvisionRetriesNowForTest");
  const keys = [..._provisionRetries.keys()];
  for (const k of keys) _fireProvisionRetry(k);
  return keys.length;
}

// The latest provisioning row for (participant, event), or null.
function _latestProvisioning(userId, competitionId) {
  const rows = db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='cxone_provisioned' ORDER BY changed_at DESC, rowid DESC").all(userId);
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.details || "null"); } catch (_) { continue; }
    if (d && typeof d === "object" && (d.competition_id || null) === (competitionId || null)) return d;
  }
  return null;
}

// THE REMEDY WHEN RETRIES RAN OUT. Re-assigning a participant who is already a
// member provisions nobody (every enqueue site fires on a NEW membership row) —
// except here: a member with no account link whose latest provisioning row for
// this event is a deferral, with no retry pending and no job for them queued or
// running (a fired retry, the boot's resume, an earlier re-assign). Narrow on
// purpose, so a re-assign never re-provisions anyone else, nor anyone twice.
function requeueDeferredCxOneProvision(user, competitionId, label) {
  try {
    const userId = user && user.id;
    if (!userId || !competitionId) return false;
    const key = _retryKey(userId, competitionId);
    if (_provisionRetries.has(key) || _provisionJobs.has(key)) return false;
    const cu = db.prepare("SELECT cxone_user_id FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, competitionId);
    if (!cu || cu.cxone_user_id) return false;
    const d = _latestProvisioning(userId, competitionId);
    if (!d || !d.deferred) return false;
  } catch (_) { return false; }
  enqueueCxOneProvision(user, competitionId, label || "assign_after_deferral");
  return true;
}

// AT BOOT: a deferral whose retry was pending when the process stopped
// (`retry_scheduled:true`, or a shutdown's `stopped:'shutdown'`) and that nothing
// has answered since is queued again — the History row said it would try again.
// Living participants only, still members of an event that still provisions, and
// only rows THIS installation wrote (`instance_origin`): a copied database booted
// elsewhere (a staging restore) must not send anyone's name and address to the
// real tenant, nor create accounts only the copy's ledger records.
function resumeDeferredCxOneProvisioning() {
  const rows = db.prepare(`SELECT user_id, details FROM user_events
      WHERE event_type='cxone_provisioned' AND user_id IN (SELECT id FROM users)
      ORDER BY changed_at, rowid`).all();
  const latest = new Map();
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.details || "null"); } catch (_) { continue; }
    if (!d || typeof d !== "object") continue;
    latest.set(_retryKey(r.user_id, d.competition_id), { userId: r.user_id, d });
  }
  const origin = _instanceOrigin();
  let n = 0, foreign = 0;
  for (const { userId, d } of latest.values()) {
    if (!d.deferred || !(d.retry_scheduled === true || d.stopped === "shutdown")) continue;
    if (!origin || d.instance_origin !== origin) { foreign++; continue; }
    const cid = typeof d.competition_id === "string" && d.competition_id ? d.competition_id : null;
    try {
      if (cid && _provisioningScopeRevoked(userId, cid)) continue;
      if (cid) {
        const cu = db.prepare("SELECT cxone_user_id FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, cid);
        if (cu && cu.cxone_user_id) continue;
      }
      const fresh = db.prepare("SELECT id, nickname, first_name, last_name, email FROM users WHERE id=?").get(userId);
      if (!fresh) continue;
      enqueueCxOneProvision(fresh, cid, "resume_after_restart",
        { retryAttempt: Number.isInteger(d.retry_attempt) && d.retry_attempt > 0 ? d.retry_attempt : 0 });
      n++;
    } catch (err) { swallowed("cxone:resume-deferred", err); }
  }
  if (foreign) console.warn(`CxOne: ${foreign} deferred set-up(s) recorded by another installation (or none) were not resumed here`);
  return n;
}

// …ONCE THIS INSTANCE IS IN SERVICE. The resume runs the first time the health
// gate passes — at once, or at the first check after it clears (a boot in
// maintenance, say), so lifting maintenance resumes them with no restart, as it
// does the withdrawal runner. Once per process; the shutdown's stop cancels a
// check still waiting. Returns how many it queued, or null while it waits.
const RESUME_CHECK_MS = 60_000;
let _resumeStarted = false, _resumeWait = null;
function _endResumeWait() {
  if (_resumeWait) { clearInterval(_resumeWait.timer); _resumeWait = null; }
}
function startCxOneProvisionResume({ isHealthy } = {}) {
  if (_resumeStarted || _retriesStopping) return null;
  _resumeStarted = true;
  const check = () => {
    let ok = false;
    try { ok = typeof isHealthy === "function" && !!isHealthy(); } catch (_) { ok = false; }
    if (!ok) return null;
    _endResumeWait();
    let n = 0;
    try {
      n = resumeDeferredCxOneProvisioning();
      if (n) console.log(`  Checkmarx One set-ups resumed after restart: ${n}`);
    } catch (e) { console.warn(`[cxone] could not resume deferred set-ups (${e && e.name}); they resume at the next start`); }
    return n;
  };
  const n = check();
  if (n !== null) return n;
  const timer = setInterval(check, RESUME_CHECK_MS);
  if (typeof timer.unref === "function") timer.unref();
  _resumeWait = { timer, check };
  return null;
}
// Test hook: run the waiting check now. undefined when nothing is waiting.
function _checkCxOneProvisionResumeNowForTest() {
  _testOnly("_checkCxOneProvisionResumeNowForTest");
  return _resumeWait ? _resumeWait.check() : undefined;
}

// ─── The realm says the account is gone ─────────────────────────────────────
//
// THE REPAIR LAYER. Prevention (the registry) stops a provisioning job linking
// an account being removed; this clears a link made anyway — by any writer that
// does not ask the registry — whenever the realm answers that the account is gone
// (a DELETE's 2xx/404, the runner's read 404). A ledger row re-keyed to somebody
// meanwhile is forgotten (its account is gone), and every living event binding
// to the id is cleared — `cxone_user_id` AND `cxone_username`, which named the
// removed account (the erased participant's realm username): kept, it would be
// sent to the realm again as the new account's name and keep `hasPriorBinding`
// true for a username whose account this platform removed — and the participant
// is queued again unless the event no longer provisions them. Never
// `livingBinder` here: that LIKE scan runs only where the runner's safety needs it.
function accountGoneFromRealm(cxoneUserId, cfg, removedForUserId) {
  const out = { rekeyedTo: null, bindingsCleared: 0 };
  if (typeof cxoneUserId !== "string" || !cxoneUserId) return out;
  noteRealmAccountGone(cxoneUserId, cfg);
  try {
    const r = db.prepare("SELECT user_id FROM cxone_realm_accounts WHERE cxone_user_id=?").get(cxoneUserId);
    if (r && r.user_id !== removedForUserId && forgetGoneAccount(db, cxoneUserId, r.user_id) > 0) out.rekeyedTo = r.user_id;
  } catch (e) { console.warn(`CxOne: could not forget a removed account's record (${e && e.name})`); }
  out.bindingsCleared = repairBindingsToRemovedAccount(cxoneUserId);
  return out;
}

function repairBindingsToRemovedAccount(cxoneUserId) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT cu.user_id, cu.competition_id FROM competition_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.cxone_user_id = ? ORDER BY cu.rowid`).all(cxoneUserId);
  } catch (e) { console.warn(`CxOne: could not read the links to a removed account (${e && e.name})`); return 0; }
  let n = 0;
  for (const r of rows) {
    try {
      const skip = _provisioningScopeRevoked(r.user_id, r.competition_id);
      let changed = 0;
      const txn = db.transaction(() => {
        changed = db.prepare(`UPDATE competition_users SET cxone_user_id=NULL, cxone_username=NULL
          WHERE user_id=? AND competition_id=? AND cxone_user_id=?`).run(r.user_id, r.competition_id, cxoneUserId).changes;
        if (changed) {
          recordUserEvent(r.user_id, "cxone_binding_cleared", "system", {
            competition_id: r.competition_id, cleared_cxone_user_id: cxoneUserId, reason: "realm_account_removed",
            reprovision: !skip, ...(skip ? { reprovision_skipped: skip } : {}),
          });
        }
      });
      runTxnWithMirrorBuffer(() => txn.immediate());
      if (!changed) continue;
      n++;
      if (skip) continue;
      const fresh = db.prepare("SELECT id, nickname, first_name, last_name, email FROM users WHERE id=?").get(r.user_id);
      if (fresh) enqueueCxOneProvision(fresh, r.competition_id, "binding_repair");
    } catch (e) { console.warn(`CxOne: could not clear a link to a removed account (${e && e.name})`); }
  }
  return n;
}

/**
 * v8.11.1 (external audit F6) — is the local account this job was queued for
 * still there? One indexed point lookup. v8.12.6 asks it after EVERY await in
 * the provisioning chokepoint below (directly at the two silent checks before
 * anything exists in the realm, through `_erasedMidFlight` everywhere after),
 * not at the three points F6 shipped with.
 */
function _userStillExists(userId) {
  return !!db.prepare("SELECT 1 FROM users WHERE id=?").get(userId);
}

/**
 * v8.12.6 (operator ruling, the sibling of F6) — may this job still provision
 * into the EVENT it was queued for? Returns why not, or null:
 *   "event_deleted"      — the competition row is gone (v7.21.15, re-asked);
 *   "cxone_disabled"     — an admin ticked the per-event opt-out (v7.13.0,
 *                          re-asked);
 *   "membership_removed" — the participant was taken out of the event.
 *
 * All three are premises the job was QUEUED on and nothing re-read: the queue
 * holds up to 5000 jobs behind 5 in flight, so minutes can separate the enqueue
 * from the drain, and each job is 2-6 upstream round trips on top. Every one
 * of the six enqueue sites writes the `competition_users` row BEFORE it
 * enqueues, so the membership read cannot refuse a legitimate caller.
 *
 * Only a SUPPLIED competition is asked about — no competition id is the
 * global-default caller, the `competitionId &&` scoping v7.21.15 uses. The
 * order matters: deleting an event deletes its `competition_users` rows too,
 * so the event is asked about first or a deletion would read as a removal.
 *
 * Unlike an ERASURE this never withdraws a realm account: removing somebody
 * from an event has never de-provisioned them, and this re-check only stops
 * the job making the NEXT remote call (see `_abandon`).
 */
function _provisioningScopeRevoked(userId, competitionId) {
  if (!competitionId) return null;
  const comp = getCompetition(competitionId);
  if (!comp) return "event_deleted";
  if (comp.cxone_disabled) return "cxone_disabled";
  if (userId && !db.prepare("SELECT 1 FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, competitionId)) {
    return "membership_removed";
  }
  return null;
}

async function cxOneProvisionUser(user, competitionId, opts = {}) {
  // v7.13.0 — per-competition opt-out. When the competition has cxone_disabled=1
  // (default 0), skip account creation entirely. This is the single provisioning
  // chokepoint (every trigger reaches it through `enqueueCxOneProvision` since
  // v8.3.20 — no route awaits it directly any more), so this one gate
  // neutralises all of them. getCompetition is a cached SELECT * (the same row
  // getCxOneConfig fetches microseconds later), so this adds no real cost.
  const _comp = getCompetition(competitionId);
  if (_comp?.cxone_disabled) return;
  // v7.21.15 — and it must FAIL CLOSED when the competition cannot be read.
  //
  // `_comp?.cxone_disabled` on a MISSING row yields undefined, which is falsy,
  // so a competition deleted between the enqueue and the drain sailed straight
  // past its own opt-out — and getCxOneConfig then falls back to the GLOBAL
  // default credentials, so an external identity was created for a competition
  // that no longer exists. Provisioning is queued work with a bounded pool and
  // a 10 s upstream timeout, so that window is not theoretical.
  //
  // Scoped to `competitionId` being SUPPLIED: passing none is a legitimate
  // caller (the global-default path), and refusing that would break it.
  if (competitionId && !_comp) return;
  // v8.11.1 (external audit F6) — AND THE SAME RULE FOR THE USER.
  //
  // v7.21.15 above closed this window for the COMPETITION and left the identical
  // one open for the PERSON. The queue captures the `users` ROW OBJECT
  // (`enqueueCxOneProvision` below), and nothing here re-reads it — so a job
  // draining after `deleteUserCascade` built its `POST /users` body entirely
  // from the captured object and created an ENABLED realm account, granted it
  // the configured group, and wrote a `cxone_provisioned` row keyed on a user id
  // that no longer exists. MEASURED with the transport stubbed: local users 0 at
  // the moment of the create.
  //
  // `user.id &&` mirrors the `competitionId &&` scoping one line up: a caller
  // passing a synthesised row is not refused. All six enqueue sites pass a real
  // row.
  if (user?.id && !_userStillExists(user.id)) return;
  // v8.12.6 (operator ruling) — AND THE MEMBERSHIP, asked where the two checks
  // above are asked: after the queue wait, before anything leaves. A participant
  // removed from the event while their job sat in the queue was still created in
  // the realm and granted the event's group (measured). SILENT, like the three
  // returns above it, and for their reason: nothing has been attempted, so there
  // is no remote state to describe. (It re-reads the event and the opt-out too —
  // one predicate at every site, so the sites cannot come to disagree about
  // what "still in scope" means.)
  if (_provisioningScopeRevoked(user?.id, competitionId)) return;
  const cfg = getCxOneConfig(competitionId);
  if (!cfg) return;

  // Use the previously persisted CxOne username for stability — if the user
  // renames their Hack Arena nickname after first provisioning, we still look
  // them up (and create them) under the original username so their CxOne
  // account isn't orphaned.
  const _cuRow = competitionId
    ? db.prepare("SELECT cxone_username, cxone_user_id FROM competition_users WHERE user_id=? AND competition_id=?").get(user.id, competitionId)
    : null;
  const preferredUsername = _cuRow?.cxone_username || user.nickname;

  const adminBase = `${cfg.iamUrl}/auth/admin/realms/${encodeURIComponent(cfg.tenant)}`;
  // v8.12.6 (external audit F2) — EVERY AWAIT, NOT THREE, AND THE ONE ACCOUNT WE
  // MADE GOES BACK.
  //
  // v8.11.1 (F6) asked `_userStillExists` at three points. The group LOOKUP,
  // its body read, the grant and the 409 searches are awaits of their own, so a
  // deletion landing inside any of them still reached the grant — the very harm
  // F6 is named for — and then wrote a `cxone_provisioned` row back into the
  // user_events history `deleteUserCascade` had just emptied for that id (on
  // the failure path with the erased person's EMAIL in `error`), and a search
  // kept sending their nickname and address to the realm. Measured with the
  // transport stubbed (tests/cxone-grant-after-delete.spec.js). The rule is this
  // file's own (v7.15.13): a decision taken before an await is re-made after it,
  // so every ask below sits directly after the await it guards.
  //
  // THE WINDOW, stated honestly because it decides the severity: the queue wait
  // and the token fetch were already covered by F6's first two checks, so what
  // was unprotected is 1-5 upstream round trips — sub-second with a healthy IDP.
  //
  // `_createdHereId` is set ONLY from the Location header of OUR OWN 201 in THIS
  // run: an account this job created seconds ago, carrying the erased person's
  // name and email. It is the ONLY realm account this job may ever withdraw
  // (operator decision). A 409-MATCHED account belongs to the customer's tenant —
  // often an employee's real Checkmarx One identity — and may predate us, so it
  // is NEVER deleted here; nor is an account found by search after a 201 that
  // carried no Location (conservative: we cannot prove we made it).
  let cxUserId;                                   // hoisted so an on_error abandon can name it
  let _createdHereId = null, _authHdr = null;
  const _erasedMidFlight = () => !!(user?.id && !_userStillExists(user.id));
  // v8.12.7 (external audit F2) — THE ACCOUNT WE MADE IS WRITTEN DOWN, so an
  // erasure long after this job finished can still take it back. `_jobClaim`
  // marks the ledger row as held by THIS run while it is in flight, so the
  // withdrawal runner leaves it alone until the job has decided (it may be
  // withdrawing the account itself, in `_abandon`). Released in the finally.
  const _jobClaim = require("crypto").randomUUID();
  let _ledgerRecorded = false, _ledgerSettled = false, _ledgerFailed = false;
  let _postSent = false, _postAnswered = false, _createStatus = null;
  // When THIS attempt's create left — a removal settled before it cannot explain
  // what its search finds (`realmRemovalSince` below).
  let _postSentAtMs = null;
  // Record `_createdHereId` — and ONLY that id: a 201's own Location, naming a
  // UUID. A 2xx that is not a 201, or an id that is not a UUID, is not proof
  // enough to delete anything later, so it is counted instead of recorded.
  // Synchronous and await-free, and retried (write-back, catch, `_abandon`) so a
  // transient write failure at the 201 does not lose the record; the attempt is
  // settled once it has an answer, so a retry never double-counts.
  const _ensureLedger = () => {
    if (_ledgerSettled || !_createdHereId) return;
    if (_createStatus !== 201 || !UUID_RE.test(_createdHereId)) {
      _ledgerSettled = true;
      _countUnconfirmed(_createStatus !== 201 ? "non_201" : "id_not_uuid");
      return;
    }
    try {
      let _iamOrigin = null;
      try { _iamOrigin = new URL(cfg.iamUrl).origin; } catch (err) { swallowed("cxone:iam-origin-parse", err); }
      const _at = nowIso();
      _ledgerRecorded = recordCreated(db, {
        cxoneUserId: _createdHereId, iamOrigin: _iamOrigin, tenant: cfg.tenant,
        userId: user.id, competitionId: competitionId || null, username: preferredUsername,
        provenanceAt: _at, instanceOrigin: _instanceOrigin(), claim: _jobClaim, nowIso: _at,
        // The address the create below SENT (`email: user.email`) — its
        // fingerprint only; the address itself is never written to the ledger.
        createdEmailSha: createdEmailSha(user.email),
      });
      // `false` means the row already existed — not ours to hold. Settled either
      // way: an INSERT OR IGNORE that lost says the same thing every time.
      _ledgerSettled = true; _ledgerFailed = false;
    } catch (e) {
      _ledgerFailed = true;
      console.error(`CxOne: could not record created account ${sanitiseForLog(_createdHereId)} for later withdrawal: ${e.message}`);
    }
  };
  // Stop mid-flight and SAY so. Written ORPHANED (app.jsonl and its orphan_events copy), never into
  // user_events: for an erasure the history it would land in is the one the
  // cascade just deleted, and writing into it would resurrect it; the event and
  // membership reasons use the same line so one search finds every abandoned job.
  // Only an ERASURE withdraws, and only `_createdHereId` — a participant removed
  // from an event, or an event deleted or opted out, has never de-provisioned
  // anybody, and this does not start doing so mid-flight.
  const _abandon = async (stage, reason, extra) => {
    _ensureLedger();
    let withdrawn = null, retryScheduled = false, skipped = null, takenOverMidDelete = false, bindingsCleared = 0;
    if (reason === "user_deleted" && _createdHereId && _authHdr) {
      // v8.13.1 (external audit) — THE ACCOUNT MAY NO LONGER BE OURS TO REMOVE.
      // A replacement participant's own provisioning can match this account (a
      // 409 on the same address, then an email match) and take it over while
      // THIS job is suspended on an upstream call: the ledger row is re-keyed to
      // them and their event binding names the id. This withdrawal used to
      // DELETE it anyway, and then its ledger row with it (reproduced with two
      // real provisioning calls). Asked here, synchronously, with NO await
      // between the answer and the DELETE below — the runner's own pre-DELETE
      // gate, applied to the one other place that removes a realm account.
      // A read that fails is not an answer: it skips the DELETE (fail closed),
      // and the row is left pending for the runner, which asks again. Nor is a
      // record that cannot be read (`binding_unreadable`): skipped the same way,
      // and the runner holds it for a superadmin.
      try { skipped = _withdrawalOwnershipLost(_createdHereId, user.id, _ledgerRecorded ? _jobClaim : null); }
      catch (_) { skipped = "ownership_unreadable"; }
      // …and ANNOUNCED in the same synchronous block, so a match that reaches the
      // account while the DELETE is out waits instead of linking it. Another
      // removal of it already in flight (the runner's) means this one is not sent.
      if (!skipped && !beginRealmRemoval(_createdHereId, cfg)) skipped = "removal_in_flight";
    }
    if (skipped) {
      // A row still the erased participant's is the RUNNER's to decide — it hands
      // the account to a living binder with no remote call, or asks the realm
      // again — and the runner only selects a row marked for deletion. The cascade
      // marks every row the participant owned when it ran, which misses the row
      // THIS job wrote at a 201 answered after the erasure; marking it here (under
      // our claim, for the erased owner only) is what keeps it from being listed
      // "unmarked" and never re-asked. A row already re-keyed to somebody living
      // is theirs, and the owner binding leaves it alone. A record that names
      // the account but cannot be read goes the same way: the runner holds the
      // row for a superadmin (`binding_unreadable`).
      if (_ledgerRecorded && (skipped === "bound_to_living_account" || skipped === "ownership_unreadable" || skipped === "binding_unreadable")) {
        try { markInFlightSkip(db, _createdHereId, _jobClaim, { nowIso: nowIso(), userId: user.id }); } catch (err) { swallowed("cxone:mark-inflight-skip", err); }
      }
      if (skipped === "removal_in_flight") console.warn(`CxOne: the local account was deleted mid-provisioning; another removal of the realm account this job created (${sanitiseForLog(_createdHereId)}) is already under way, so this job did not send a second one`);
      else if (skipped === "binding_unreadable") console.warn(`CxOne: the local account was deleted mid-provisioning, but a set-up record of a participant still on the platform names the realm account this job created (${sanitiseForLog(_createdHereId)}) and cannot be read — it was NOT withdrawn; a superadmin decides under Settings → Checkmarx One account removals`);
      else console.warn(`CxOne: the local account was deleted mid-provisioning, but the realm account this job created (${sanitiseForLog(_createdHereId)}) may now belong to a living participant (${skipped}) — it was NOT withdrawn`);
    } else if (reason === "user_deleted" && _createdHereId && _authHdr) {
      let status = 0, outcome = "unknown";
      try {
        const r = await fetchWithTimeout(`${adminBase}/users/${encodeURIComponent(_createdHereId)}`, { method: "DELETE", headers: _authHdr });
        status = r.status;
      } catch (_) { status = 0; }
      finally { outcome = settleRealmRemoval(_createdHereId, classifyRealmRemoval(status)); }
      withdrawn = outcome === "removed";   // a 404 is already gone, which is the state we wanted
      if (withdrawn) {
        // THE REALM SAYS IT IS GONE: a link anything made to it meanwhile (a match
        // the registry did not stop) is cleared and that participant queued again.
        try {
          const g = accountGoneFromRealm(_createdHereId, cfg, user.id);
          takenOverMidDelete = !!g.rekeyedTo;
          bindingsCleared = g.bindingsCleared;
        } catch (err) { swallowed("cxone:abandon-account-gone", err); }
        if (takenOverMidDelete || bindingsCleared) console.warn(`CxOne: removed realm account ${sanitiseForLog(_createdHereId)} that a living participant had been linked to meanwhile — the link was cleared and their set-up queued again`);
        // Gone from the realm, so its ledger row goes too — under our claim, and
        // only while it is still the erased participant's.
        if (_ledgerRecorded) { try { deleteOwned(db, _createdHereId, _jobClaim, user.id); } catch (err) { swallowed("cxone:abandon-ledger-delete", err); } }
      } else if (_ledgerRecorded) {
        // v8.12.7 — a refusal is no longer the end of it: the row is handed to
        // the withdrawal runner, which retries and, if the realm keeps refusing,
        // holds it for a superadmin's decision. An answer that did not say
        // (no answer, a 5xx) is re-read a minute later; a refusal in an hour.
        try {
          const _at = nowIso();
          const _unknown = outcome === "unknown";
          retryScheduled = markInFlightRefusal(db, _createdHereId, _jobClaim, {
            nowIso: _at, nextIso: new Date(Date.parse(_at) + (_unknown ? 60_000 : 3600_000)).toISOString(),
            lastError: !status ? "0/delete_unanswered" : `${status}/${_unknown ? "delete_failed" : "delete_refused"}`, userId: user.id,
          }) > 0;
        } catch (err) { swallowed("cxone:abandon-mark-refusal", err); }
      }
      if (!withdrawn) {
        // A row re-keyed to a living participant meanwhile (by a writer the
        // registry does not stop) is theirs: nothing to retry, nothing to remove
        // by hand — saying either would send an operator to delete their account.
        let _rekeyed = false;
        try {
          const _now = db.prepare("SELECT user_id FROM cxone_realm_accounts WHERE cxone_user_id=?").get(_createdHereId);
          _rekeyed = !!(_now && _now.user_id !== user.id);
        } catch (err) { swallowed("cxone:abandon-rekey-read", err); }
        if (_rekeyed) console.warn(`CxOne: the realm did not remove account ${sanitiseForLog(_createdHereId)}, and it passed to a living participant meanwhile — it is theirs now, and nothing needs removing`);
        else if (retryScheduled) console.warn(`CxOne: the local account was deleted mid-provisioning and the realm account this job created (${sanitiseForLog(_createdHereId)}) could NOT be withdrawn yet — the platform will retry; follow it under Settings → Checkmarx One account removals`);
        else console.warn(`CxOne: the local account was deleted mid-provisioning and the realm account this job created (${sanitiseForLog(_createdHereId)}) could NOT be withdrawn — remove it in the realm by hand`);
      }
    }
    try {
      recordOrphanedAuditEvent("user", user.id, "cxone_provision_abandoned", "system", {
        competition_id: competitionId, stage, reason,
        ...(cxUserId ? { cxone_user_id: cxUserId } : {}),
        ...(_createdHereId ? { created_by_this_job: true } : {}),
        // Only when a withdrawal was ATTEMPTED — an absent key means "not ours
        // to withdraw", a `false` means "we tried and the realm refused".
        ...(withdrawn !== null ? { realm_account_withdrawn: withdrawn } : {}),
        // v8.13.1 — present only when the account had passed (or may have, by a
        // record that cannot be read) to a living participant, or another removal
        // was under way, so the withdrawal was deliberately not attempted.
        ...(skipped ? { realm_account_withdrawal_skipped: skipped } : {}),
        // v8.12.7 — present only when a refusal was handed to the runner, so
        // every other abandon line keeps its shape.
        ...(retryScheduled ? { withdrawal_retry_scheduled: true } : {}),
        // Present only when the removed account's record had passed to a living
        // participant meanwhile (forgotten with it); `bindings_cleared` counts the
        // links to it that were cleared and set up again.
        ...(takenOverMidDelete ? { taken_over_during_withdrawal: true } : {}),
        ...(bindingsCleared ? { bindings_cleared: bindingsCleared } : {}),
        ...(extra || {}),
      });
    } catch (err) { swallowed("cxone:abandon-audit-emit", err); }
  };
  // NOT LINKED: the account this job reached is being removed by the platform,
  // was removed moments ago, or its removal went unanswered. Recorded as a
  // DEFERRAL — `matched_account_id`, NEVER `cxone_user_id`: `livingBinder` reads
  // any `cxone_provisioned` row naming `cxone_user_id` as a binding — and retried
  // through the queue. An erasure or a scope change meanwhile still abandons.
  const _defer = async ({ reason, accountId, since, stage }) => {
    if (_erasedMidFlight()) { await _abandon(stage, "user_deleted"); return; }
    const _scope = _provisioningScopeRevoked(user?.id, competitionId);
    if (_scope) { await _abandon(stage, _scope); return; }
    const next = (Number.isInteger(opts.retryAttempt) && opts.retryAttempt > 0 ? opts.retryAttempt : 0) + 1;
    // An account already gone cannot be matched again: retry at once.
    const now0 = reason === "recently_removed" || (reason === "removal_raced_match" && since === "recently_removed");
    const inCap = next <= PROVISION_RETRY_MAX;
    const scheduled = inCap
      && _scheduleProvisionRetry(user?.id, competitionId, next, now0 ? 0 : PROVISION_RETRY_DELAYS_MS[next - 1], reason);
    // Not scheduled only because shutdown has begun (a queued job still runs in
    // the drain): said as the stop says a cancelled retry, so the next boot resumes it.
    const stopped = inCap && !scheduled && _retriesStopping;
    if (reason in _deferredCounts) _deferredCounts[reason]++;
    try {
      recordUserEvent(user.id, "cxone_provisioned", "system", {
        competition_id: competitionId, success: false, deferred: reason,
        ...(accountId ? { matched_account_id: accountId } : {}),
        retry_scheduled: !!scheduled, ...(scheduled || stopped ? { retry_attempt: next, instance_origin: _instanceOrigin() } : {}),
        ...(stopped ? { stopped: "shutdown" } : {}),
      });
    } catch (ae) { console.error("CxOne audit event write failed:", ae.message); }
    // The runner re-reads an unanswered removal; make sure it is asked to.
    if (reason === "removal_outcome_unknown") { try { require("./cxone-withdraw").scheduleRealmWithdrawal(); } catch (err) { swallowed("cxone:schedule-withdrawal-unknown", err); } }
    console.warn(`CxOne: not linking a participant to realm account ${sanitiseForLog(accountId || "-")} — the platform is removing it (${reason}); ${scheduled ? "their set-up will be retried" : stopped ? "their set-up resumes when the server next starts" : "not retried automatically"}`);
  };
  let _deferral = null;
  try {
    const token = await cxOneGetBearerToken(cfg);
    // v8.11.1 (F6) — RE-ASSERT AFTER THE AWAIT. The token fetch carries a 10 s
    // deadline, so the deletion lands inside it in the reproduction; the check
    // above alone only narrows the window. This file's own v7.15.13 rule: a
    // decision taken before an await must be re-made after it.
    if (user?.id && !_userStillExists(user.id)) return;
    // v8.12.6 — and the event, re-asked after the same await: v7.21.15 asked it
    // only at the top, so an event deleted DURING the token fetch still had
    // `POST /users` sent — the participant's name and email — under the deleted
    // event's own key (measured). Likewise a membership removed, or the opt-out
    // ticked, while the token was in flight. Nothing exists in the realm yet, so
    // there is nothing to withdraw — only the next call to not make.
    const _scopeAfterToken = _provisioningScopeRevoked(user?.id, competitionId);
    if (_scopeAfterToken) { await _abandon("before_create", _scopeAfterToken); return; }
    const auth = { Authorization: `Bearer ${token}` };
    _authHdr = auth;
    const jsonAuth = { ...auth, "Content-Type": "application/json" };

    // 1. Create the user via Keycloak Admin API
    _postSent = true; _postSentAtMs = Date.now();
    const createResp = await fetchWithTimeout(`${adminBase}/users`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        username: preferredUsername,
        firstName: user.first_name || "",
        lastName: user.last_name || "",
        email: user.email,
        enabled: true,
      }),
    });
    _postAnswered = true; _createStatus = createResp.status;
    const safeNick = sanitiseForLog(user.nickname), safeEmail = sanitiseForLog(user.email);
    let cxUsername = sanitiseForLog(preferredUsername), cxUserExisted = false;
    // v8.3.17 — what the audit row has to be able to say: HOW we identified the
    // account, WHOSE address it carries, and whether the configured group was
    // actually granted.
    let matchedBy = null, matchedEmail = null, groupRequested = null, groupAssigned = null;
    if (createResp.status === 409) {
      cxUserExisted = true;
    } else if (!createResp.ok) {
      const errBody = await createResp.text();
      throw new Error(`CxOne create user failed (${createResp.status}): ${errBody}`);
    } else {
      // Extract user ID from the Location header (e.g. ".../users/<id>")
      const location = createResp.headers.get("Location") || "";
      const locMatch = location.match(/\/users\/([^/]+)$/);
      // v8.12.6 — the ONE place `_createdHereId` is set: an id we can prove we
      // made, because it came back on our own 201. v8.12.7 — and the moment it
      // exists it is written down (`_ensureLedger`), so a later erasure can take
      // it back. A success with no Location is an account we made and cannot
      // name: counted, never guessed at by search.
      if (locMatch) { cxUserId = locMatch[1]; _createdHereId = cxUserId; _ensureLedger(); }
      else _countUnconfirmed("no_location");
    }

    // 2. Fall back to search if we couldn't get the ID from the Location header
    //
    // v8.3.17 (external audit) — THE PREDICATE HERE DECIDES WHOSE CxOne ACCOUNT
    // GETS THE GROUP. It used to be `usernameMatch || emailMatch`, which accepted
    // a realm account on a NICKNAME collision alone. See lib/cxone-identity.js for
    // the full mechanism and why it is participant-triggerable; the short version
    // is that the realm is the customer's live tenant and a Hack Arena nickname is
    // not an identity in it.
    if (!cxUserId) {
      // Every address this participant owns, resolved HERE from the id rather
      // than taken off the caller's row. All six call sites pass a
      // column-naming SELECT and not one of them selects `secondary_email` — and
      // a column-naming SELECT is a list that rots (v8.3.9; v8.1.0 paid for it
      // three times in one release).
      //
      // v8.3.34 — the sentence that used to close this paragraph said a CxOne
      // account carrying the participant's SECONDARY address is "the ordinary
      // same-human case, so missing it would turn a legitimate match into a
      // refusal". That is now the deliberate outcome, not an accident: the
      // shape is indistinguishable from an attacker claiming an address they do
      // not hold, so it IS refused — by name, with the remedy.
      //
      // v8.3.34 (external audit) — SPLIT BY PROOF, not by ownership.
      //
      // v8.3.35 SCOPE CORRECTION, because the original wording overstated it:
      // `verified=1` attests that SOME address on the row was proved, not
      // specifically the primary — `sendVerificationEmail` goes to primary AND
      // secondary, and `_completeVerification` resolves on the code alone. So a
      // "proven" primary here means "this account has proved an address it
      // holds", which is a materially weaker claim than the phrase "confirmed
      // the holder controls" suggests. It is still strictly stronger than
      // v8.3.17's "any address they typed", which is what the split is for;
      // closing the gap properly needs a per-address proof column and is not
      // this module's to invent.
      //
      // v8.3.17 put primary and secondary into one bucket and called all of it
      // proof. `secondary_email` is written straight from `PUT /api/me` and is
      // confirmed by nothing, so that handed F1's own nickname-collision attack
      // back at the cost of one extra input (see lib/cxone-identity.js). Only a
      // VERIFIED primary is proof; everything else is a claim.
      //
      // `verified` is the whole test and no grace clause is needed: an account
      // inside its 48h verification grace has `verified = 0` by construction,
      // so it lands in `asserted` already. (`verificationGraceState` is not
      // imported — lib/self-enroll.js requires THIS module, so the edge would
      // be a cycle; the one column it would read is read directly instead.)
      const _emailRow = user.id
        ? db.prepare("SELECT email, secondary_email, verified FROM users WHERE id=?").get(user.id)
        : null;
      // No resolvable row means no proof — fail closed rather than trusting the
      // caller's own column-naming SELECT.
      const _primaryProven = !!(_emailRow && _emailRow.verified);
      const _primaries = [user.email, _emailRow?.email].filter(Boolean);
      const provenEmails = _primaryProven ? _primaries : [];
      const assertedEmails = [
        ...(_primaryProven ? [] : _primaries),
        ...(_emailRow?.secondary_email ? [_emailRow.secondary_email] : []),
      ];

      // Has THIS platform previously bound THIS participant to THAT username?
      // Deliberately ACROSS competitions (covered by idx_competition_users_user):
      // a returning participant in a NEW competition has no row for it yet, and
      // refusing them for that would break the very stability feature the
      // preferred username exists to provide.
      const hasPriorBinding = !!(user.id && preferredUsername && db
        .prepare("SELECT 1 FROM competition_users WHERE user_id=? AND LOWER(cxone_username)=LOWER(?) LIMIT 1")
        .get(user.id, preferredUsername));

      // `exact=true` on both searches. Keycloak documents `username`/`email` as
      // CONTAINS filters capped at 100 results unless exact is set, so a genuine
      // match could be paginated out of a wide contains-result. It cannot change
      // a verdict — the classifier re-filters to exact equality either way — it
      // only stops us doing (and mis-reading) unnecessary upstream work on a
      // 5-worker pool with a 10 s timeout. An older Keycloak ignores the unknown
      // param and degrades to exactly today's behaviour.
      // v8.3.34 — the SECONDARY address is queried too. The auditor's literal
      // finding: the classifier was prepared to recognise it while no query ever
      // asked about it, so an account keyed to that address was invisible unless
      // its username ALSO collided. Widening the search would have been actively
      // dangerous BEFORE the proof split above — it would have removed the need
      // for a username collision entirely — and is safe after it, because a
      // secondary-only match now classifies `unverified_email` and cannot bind.
      // What it buys is the diagnostic: an opaque "not found in search" becomes
      // a refusal naming the account that was found and why it was refused.
      const _searchAddrs = [];
      for (const a of [user.email, _emailRow?.email, _emailRow?.secondary_email]) {
        if (a && !_searchAddrs.some(x => x.toLowerCase() === a.toLowerCase())) _searchAddrs.push(a);
      }
      let refusal = null; // remembered so the throw can say WHAT we found
      for (const query of [
        `username=${encodeURIComponent(preferredUsername)}&exact=true`,
        ..._searchAddrs.map(a => `email=${encodeURIComponent(a)}&exact=true`),
      ]) {
        // v8.12.6 (F2) — every query sends this person's nickname or address to
        // the realm, and the previous iteration was an await; after an erasure,
        // stop sending them (measured: the email query went out after it).
        if (_erasedMidFlight()) { await _abandon("during_search", "user_deleted"); return; }
        const searchResp = await fetchWithTimeout(`${adminBase}/users?${query}`, { headers: auth });
        if (!searchResp.ok) continue;
        const users = await searchResp.json();
        let accepted = null, basis = null;
        for (const u of Array.isArray(users) ? users : []) {
          const q = cxOneMatchQuality(u, { preferredUsername, emails: provenEmails, assertedEmails, hasPriorBinding });
          if (q && CXONE_ACCEPTABLE_BASES.has(q)) { accepted = u; basis = q; break; }
          if (q && !refusal) refusal = { quality: q, username: u.username || null, email: u.email || null };
        }
        // A REFUSAL DOES NOT ABORT THE SCAN, and that is load-bearing: a Keycloak
        // 409 fires on a duplicate username OR a duplicate email and does not say
        // which, so when the username collided the EMAIL query may still find the
        // right human. Aborting at the username arm would break exactly that.
        if (accepted) {
          // NOT WHILE THE PLATFORM IS REMOVING IT. Asked with no await before
          // `transferTo`: a removal announced, settled or unanswered since the
          // search left would otherwise hand this participant an account the
          // DELETE removes (or already removed).
          const _blk = realmRemovalBlock(accepted.id);
          if (_blk) { _deferral = { reason: _blk, accountId: accepted.id, stage: "during_search" }; break; }
          cxUserId = accepted.id;
          // v8.12.7 — a MATCHED account a living participant holds is theirs.
          // If the ledger has it (made for somebody since deleted, waiting to be
          // withdrawn), it is re-keyed to this participant and its withdrawal
          // forgotten, so nothing later removes an account somebody is using.
          // Synchronous, and a no-op for an account the ledger never held — and
          // for a participant erased during the search read above: `transferTo`
          // requires the new owner to exist IN THE SAME STATEMENT, or the pending
          // row of the person whose deletion stamped it would be re-keyed to
          // somebody who no longer exists and lose its stamp (pre-release review).
          try { transferTo(db, accepted.id, user.id, nowIso()); } catch (err) { swallowed("cxone:ledger-transfer", err); }
          cxUsername = accepted.username || cxUsername;
          matchedBy = basis;
          matchedEmail = accepted.email || null;
          // Log the BASIS, always. The shipped line was exactly backwards — it
          // fired only when the matched username DIFFERED, i.e. it announced the
          // SAFE email-matched case and was silent in the dangerous one.
          console.log(`CxOne: matched existing user "${sanitiseForLog(accepted.username)}" by ${basis} (attempted username: "${sanitiseForLog(preferredUsername)}")`);
          break;
        }
      }
      if (_deferral) { await _defer(_deferral); return; }
      if (!cxUserId) {
        // Name what actually happened. "not found in search" misdescribes a
        // collision, and an error that misdescribes itself is the FROZEN_REMEDY
        // class — the operator needs to know a DIFFERENT account holds this
        // username, not that nothing was found.
        if (refusal) {
          throw new Error(
            `CxOne: refusing to bind "${safeNick}" (${safeEmail}) to existing account ` +
            `"${sanitiseForLog(refusal.username)}" <${sanitiseForLog(refusal.email || "no email")}> — ` +
            `${refusal.quality === "conflict"
              ? "that username belongs to a different identity"
              : refusal.quality === "unverified_email"
                ? "it carries an address this participant has only CLAIMED — a secondary address, or a primary they have not verified — which is not proof of identity"
                : "the account carries no email, so the match cannot be corroborated"}. ` +
            (refusal.quality === "unverified_email"
              ? "Have the participant verify that address as their primary, or pre-create their CxOne user with their verified address."
              : "Give this participant a distinct nickname, or pre-create their CxOne user with their own address.")
          );
        }
        // A 409 whose searches then found nothing collided with an account that
        // was removed in between — the platform's own removal racing this one.
        // Every attempt asks, against its own create: a removal settled before
        // that create left cannot explain it, so a stale one never loops.
        if (cxUserExisted) {
          const _since = realmRemovalSince(cxOneRealmKey(cfg), _postSentAtMs);
          if (_since) { await _defer({ reason: "removal_raced_match", since: _since, stage: "during_search" }); return; }
        }
        throw new Error(`CxOne: user "${safeNick}" (${safeEmail}) not found in search`);
      }
    }

    // 3. Find the configured group and assign user
    // Competition-specific group, then global default
    let groupName = "";
    if (competitionId) {
      const comp = getCompetition(competitionId);
      // v8.12.6 (F2 sibling) — v7.21.15's fail-closed rule, asked where it
      // decides something. That release refused a MISSING competition at the top
      // only; one deleted during the create or the searches read as "no event
      // group" here and fell through to the GLOBAL default below — handing the
      // participant a group the event never configured, under the deleted
      // event's own credentials (measured: PUT …/groups/<global> after the
      // DELETE). A THROW, not a silent return: the participant still exists, so
      // their History records why they have an account and no access. The realm
      // account is deliberately left alone — deleting an event has never
      // withdrawn anybody's account.
      //
      // `!comp` ONLY. An event that EXISTS with no group of its own still falls
      // through to the global default, which is the documented configuration;
      // widening this to `!comp.cxone_group_name` would refuse every such event.
      if (!comp) throw new Error("CxOne: the event was deleted during provisioning — no group granted");
      if (comp.cxone_group_name) groupName = comp.cxone_group_name;
    }
    if (!groupName) {
      groupName = db.prepare("SELECT value FROM settings WHERE key='default_cxone_group_name'").get()?.value || "";
    }
    let groupMatchedInsensitively = false, groupActualName = null;
    // v8.11.1 (F6) — the third ask, after the create (or the last search) and
    // before the group lookup. Creating the account is a round trip of its own,
    // so a deletion landing inside THAT used to reach the group grant.
    //
    // v8.12.6 — SUPERSEDES what this comment used to say ("the realm ACCOUNT
    // created before the delete landed is not withdrawn"): an account THIS run
    // created is withdrawn now, by `_abandon`. v8.12.7 closes the general case
    // for accounts this platform created: one provisioned by an EARLIER,
    // completed job is in the `cxone_realm_accounts` ledger, and deleting its
    // participant schedules its removal (lib/cxone-withdraw.js). A MATCHED
    // account is still never touched. And this is no longer the LAST ask: the
    // lookup below is an await too.
    if (_erasedMidFlight()) { await _abandon("before_group_lookup", "user_deleted"); return; }
    if (groupName) {
      groupRequested = groupName;
      const groupsResp = await fetchWithTimeout(`${adminBase}/groups?search=${encodeURIComponent(groupName)}`, { headers: auth });
      if (!groupsResp.ok) throw new Error(`CxOne GET groups failed (${groupsResp.status})`);
      const groups = await groupsResp.json();
      // v8.12.6 (F2) — THE ASK THE FINDING IS ABOUT, and it sits AFTER the body
      // read, not after the fetch: `fetch` resolves at the headers and `.json()`
      // is an await of its own (v7.15.15), so an ask between the two cannot see
      // a deletion landing during the read. Nothing below may grant an erased
      // person access — nor a participant removed from the event, nor one whose
      // event was deleted or opted out while the lookup was in flight (operator
      // ruling). The erasure is asked FIRST: `deleteUserCascade` removes the
      // membership row too, and an erasure is the one reason that withdraws.
      if (_erasedMidFlight()) { await _abandon("before_group_grant", "user_deleted"); return; }
      const _scopeBeforeGrant = _provisioningScopeRevoked(user?.id, competitionId);
      if (_scopeBeforeGrant) { await _abandon("before_group_grant", _scopeBeforeGrant); return; }
      // v8.8.15 — EXACT FIRST, THEN A UNIQUE CASE-INSENSITIVE MATCH, NEVER A GUESS.
      //
      // The realm search above is Keycloak's case-INSENSITIVE contains; this
      // filter was case-SENSITIVE, so an operator who typed `hackathon-2026`
      // where the realm holds `Hackathon-2026` got no group, no error and a
      // participant with an account and NO ACCESS. A case typo in an admin form
      // is an ordinary event, which is what made it worth closing.
      //
      // The RULE lives in lib/cxone-identity.js — pure, so its whole matrix is
      // unit-tested. (No behavioural test reaches this function THROUGH THE
      // SERVER — the outbound host allowlist refuses a localhost IDP. Since
      // v8.12.6 a spawned child with a stubbed transport does reach it,
      // tests/cxone-provision-harness.cjs, for the erasure race.) Its header
      // carries why exact still wins and why an ambiguous fold is refused
      // rather than resolved.
      const _g = resolveCxOneGroup(groups, groupName);
      const target = _g.group;
      if (_g.matchedIgnoringCase) {
        groupMatchedInsensitively = true;
        groupActualName = target.name;
        console.warn(`CxOne: group "${sanitiseForLog(groupName)}" matched "${sanitiseForLog(target.name)}" ignoring case \u2014 correct the spelling in the event's CxOne settings to make this exact`);
      } else if (_g.ambiguousCount > 1) {
        console.warn(`CxOne: group "${sanitiseForLog(groupName)}" matches ${_g.ambiguousCount} groups that differ only in case \u2014 refusing to guess; type one of them exactly`);
      }
      if (target) {
        const assignResp = await fetchWithTimeout(`${adminBase}/users/${cxUserId}/groups/${target.id}`, { method: "PUT", headers: jsonAuth, body: "{}" });
        if (!assignResp.ok) throw new Error(`CxOne group assign failed (${assignResp.status})`);
        groupAssigned = true;
      } else {
        // v8.3.17 — A CONFIGURED GROUP THAT WAS NOT FOUND IS NOT A SUCCESS, and
        // the audit row said it was: the event below recorded `success:true`
        // unconditionally, which the History dialog renders as a green
        // "✓ provisioned" for a participant who has an account and NO ACCESS.
        //
        // It is NOT thrown, deliberately: the user genuinely was provisioned, and
        // throwing would discard that fact and record a bare failure instead. A
        // discriminator rides alongside `success` (the v8.3.11
        // `exhausted_participants` shape), so historical rows and every
        // no-group deployment render byte-identically.
        //
        // v8.8.15 — THE CASE-TYPO HALF OF THIS IS FIXED ABOVE, so reaching here
        // now means something the platform genuinely cannot resolve: the realm
        // holds no such group at all, or it holds SEVERAL differing only in case
        // and none typed exactly. Both are still recorded as a non-success
        // rather than thrown, for the reason above — the user really was
        // provisioned, and discarding that to report a bare failure is worse.
        groupAssigned = false;
        console.warn(`CxOne: group "${sanitiseForLog(groupName)}" not found — user provisioned WITHOUT group assignment (the realm holds no group of that name, or several that differ only in case)`);
      }
    }

    // v8.3.17 — print the MATCHED account's address, not the participant's. The
    // shipped line printed `safeEmail` beside the matched username, so on the
    // collision it positively asserted that the participant's address had been
    // provisioned when it had not.
    //
    // v8.12.6 (F2) — and once more after the grant. A grant that already reached
    // an account WE created goes back with the account; one that reached a
    // MATCHED account is recorded (`group_granted`), never undone — it may
    // predate us, and we cannot know what membership that account held before.
    // The only awaits after this ask are the two creation-baseline reads below,
    // each followed by its own ask; everything after them to the end of the try
    // is SYNCHRONOUS, so the last ask covers the log line, the binding
    // write-back and the audit row.
    if (_erasedMidFlight()) { await _abandon("before_record", "user_deleted", groupRequested ? { group_granted: !!groupAssigned } : null); return; }
    // THE CREATION BASELINE — what an account THIS job created carries as the job
    // finishes (lib/cxone-identity.js `buildCreationBaseline`): its attribute
    // names and role ids, read back so the withdrawal runner can tell the realm's
    // own creation-time defaults from the tenant's later doing. Two reads by the
    // realm's own id — nothing about the participant is sent — only for an
    // account the ledger holds, each followed by the erasure ask (stage
    // `during_baseline`). A read that fails leaves its part unknown and never
    // fails the provisioning: the runner then judges that part by the rules
    // alone, which can only hold more. Nothing read here is logged.
    let _baselineJson = null;
    if (_createdHereId && _ledgerRecorded) {
      let _bUser, _bRoles;
      try { const _r = await fetchWithTimeout(`${adminBase}/users/${encodeURIComponent(_createdHereId)}`, { headers: auth }); _bUser = _r.ok ? await _r.json() : undefined; } catch (_) { _bUser = undefined; }
      if (_erasedMidFlight()) { await _abandon("during_baseline", "user_deleted", groupRequested ? { group_granted: !!groupAssigned } : null); return; }
      try { const _r = await fetchWithTimeout(`${adminBase}/users/${encodeURIComponent(_createdHereId)}/role-mappings`, { headers: auth }); _bRoles = _r.ok ? await _r.json() : undefined; } catch (_) { _bRoles = undefined; }
      if (_erasedMidFlight()) { await _abandon("during_baseline", "user_deleted", groupRequested ? { group_granted: !!groupAssigned } : null); return; }
      try { _baselineJson = buildCreationBaseline({ userRep: _bUser, roleMappings: _bRoles, tenant: cfg.tenant }); } catch (_) { _baselineJson = null; }
    }
    // …and the removal question once more before the link is written: the group
    // lookup and grant were awaits, and a matched account the ledger never held
    // (one whose maker recorded nothing) can have its removal begin meanwhile.
    if (cxUserId && cxUserId !== _createdHereId) {
      const _blkRecord = realmRemovalBlock(cxUserId);
      if (_blkRecord) { await _defer({ reason: _blkRecord, accountId: cxUserId, stage: "before_record" }); return; }
    }
    const _acctEmail = sanitiseForLog(matchedEmail || user.email);
    if (cxUserExisted) console.log(`CxOne: user "${cxUsername}" (${_acctEmail}) already exists — group assignment updated`);
    else console.log(`CxOne: provisioned new user "${cxUsername}" (${_acctEmail})`);
    // Persist the CxOne username so it stays stable even if the user changes their Hack Arena nickname.
    //
    // v8.8.15 — AND THE ACCOUNT'S OWN ID, which is what makes a mis-binding
    // detectable at all. Every prior binding for this participant is consulted,
    // ACROSS competitions and for the same reason `hasPriorBinding` is: a
    // returning participant has no row for a new event yet, so a per-competition
    // check would see nothing on exactly the path worth watching.
    //
    // A CHANGE IS REPORTED, NEVER REFUSED. Re-pointing a participant at a
    // different realm account is a legitimate administrative act — an account
    // deleted and recreated, a correction after v8.3.17's own unbind remedy —
    // and there is no way here to tell that from the accident. Throwing would
    // turn a diagnostic into an outage for the legitimate case; the value the
    // column was asked for is that the change stops being INVISIBLE.
    let cxIdChangedFrom = null;
    if (user.id && cxUserId) {
      try {
        const prior = db.prepare(
          "SELECT cxone_user_id FROM competition_users WHERE user_id=? AND cxone_user_id IS NOT NULL AND cxone_user_id<>? LIMIT 1"
        ).get(user.id, cxUserId);
        if (prior) {
          cxIdChangedFrom = prior.cxone_user_id;
          console.warn(`CxOne: participant "${safeNick}" was previously bound to account ${sanitiseForLog(cxIdChangedFrom)} and is now bound to ${sanitiseForLog(cxUserId)} — if that was not intended, the earlier binding sent this person's group access to a different account`);
        }
      } catch (e2) { swallowed("cxone:prior-binding-read", e2); }
    }
    _ensureLedger();   // v8.12.7 — last chance on the success path
    // Owner- and claim-bound and written once (lib/cxone-ledger.js): a row a
    // replacement took over meanwhile has lost our claim and is never written.
    if (_baselineJson && _ledgerRecorded) {
      try { recordCreationBaseline(db, _createdHereId, _jobClaim, { userId: user.id, baseline: _baselineJson }); } catch (e2) { swallowed("cxone:creation-baseline", e2); }
    }
    if (competitionId && user.id) {
      try { db.prepare("UPDATE competition_users SET cxone_username=?, cxone_user_id=? WHERE user_id=? AND competition_id=?").run(cxUsername, cxUserId || null, user.id, competitionId); } catch (e2) { swallowed("cxone:binding-writeback", e2); }
    }
    try {
      recordUserEvent(user.id, "cxone_provisioned", "system", {
        competition_id: competitionId, username: cxUsername,
        already_existed: cxUserExisted, success: true,
        // v8.8.15 — the realm account's own id, so History can answer WHICH
        // account this participant was bound to rather than only under what
        // name. `cxone_user_id_changed_from` appears only when a prior binding
        // named a DIFFERENT account, so every ordinary row keeps its shape.
        ...(cxUserId ? { cxone_user_id: cxUserId } : {}),
        ...(cxIdChangedFrom ? { cxone_user_id_changed_from: cxIdChangedFrom } : {}),
        // Emitted ONLY when there is something to say, so every historical row
        // and every no-group / new-user deployment keeps its exact shape —
        // absence is the existing shape, not a new one.
        ...(matchedBy ? { matched_by: matchedBy } : {}),
        ...(groupRequested ? {
          group_name: groupRequested, group_assigned: !!groupAssigned,
          // v8.8.15 — say so when the group was reached only by ignoring case:
          // the assignment is correct but the operator's spelling is not, and a
          // silent success gives them nothing to correct. Emitted only when it
          // actually happened, so every exact-match row keeps its shape.
          ...(groupMatchedInsensitively ? { group_matched_ignoring_case: true, group_actual_name: groupActualName } : {}),
        } : {}),
      });
    } catch (ae) { console.error("CxOne audit event write failed:", ae.message); }
  } catch (err) {
    const errMsg = sanitiseCxOneError(err);
    // v8.12.7 — the create request left and no answer came back (a timeout, a
    // dropped connection). The realm may hold an account this platform can
    // neither name nor withdraw. Said without the participant's details, so it
    // is safe to log for an erased one too.
    if (_postSent && !_postAnswered) {
      _countUnconfirmed("post_unanswered");
      console.warn(`CxOne: the create request got no answer — an account may exist in the realm that this platform cannot withdraw (competition ${sanitiseForLog(String(competitionId || "global"))})`);
    }
    // v8.12.6 (F2) — ASKED BEFORE EITHER WRITE BELOW. The refusal and
    // not-found messages carry the participant's nickname and EMAIL, so for an
    // erased participant the console line would re-log them after the erasure
    // and the failure row would resurrect them in the history the cascade just
    // deleted (measured: `error` held the erased address). Guarded, because a
    // database error re-thrown from a catch escapes the function and loses the
    // failure row for a participant who still exists.
    let _gone = false;
    try { _gone = _erasedMidFlight(); } catch (e2) { swallowed("cxone:erased-check-on-error", e2); }
    if (_gone) { await _abandon("on_error", "user_deleted"); return; }
    // A grant refused (404) because the matched account was removed under it is
    // the same race, not a failure: deferred and retried like the others.
    if (cxUserId && cxUserId !== _createdHereId) {
      let _blkError = null;
      try { _blkError = realmRemovalBlock(cxUserId); } catch (e2) { swallowed("cxone:removal-block-on-error", e2); }
      if (_blkError) { await _defer({ reason: _blkError, accountId: cxUserId, stage: "on_error" }); return; }
    }
    _ensureLedger();   // v8.12.7 — an account created before the failure is still recorded
    console.error("CxOne provisioning error:", errMsg);
    try { recordUserEvent(user.id, "cxone_provisioned", "system", { competition_id: competitionId, success: false, error: errMsg }); } catch (ae) { console.error("CxOne audit event write failed:", ae.message); }
  } finally {
    // v8.12.7 — the job has decided; the row is the runner's now. A write that
    // failed on every retry is counted once, here. The kick is unconditional on
    // a recorded row: `scheduleRealmWithdrawal` itself checks whether anything
    // is pending, so an ordinary successful provisioning costs one cheap read.
    if (_ledgerFailed && !_ledgerSettled) _countUnconfirmed("ledger_write_failed");
    if (_ledgerRecorded) {
      try { releaseClaim(db, _createdHereId, _jobClaim); } catch (e2) { swallowed("cxone:release-claim", e2); }
      try { require("./cxone-withdraw").scheduleRealmWithdrawal(); } catch (e2) { swallowed("cxone:schedule-withdrawal", e2); }
    }
  }
}

/**
 * Strip potential auth tokens/keys from CxOne error messages before logging.
 *
 * v8.3.35 (self-review of v8.3.34) — THE CAP WAS EATING THE REMEDY.
 *
 * This is the ONLY sink: the catch feeds its output to both `console.error` and
 * the `cxone_provisioned {success:false, error}` audit event, which the History
 * dialog renders verbatim. At 200 the three deliberately-written refusals in
 * this module (measured 339-405 characters) were all cut mid-sentence, so the
 * operator read WHY provisioning was refused and never WHAT TO DO — which is
 * the FROZEN_REMEDY class, and v8.3.34 made it sharper by adding a fourth,
 * longer refusal whose whole value is the remedy it names.
 *
 * 500 is set by the longest refusal above plus headroom, not chosen freely. The
 * cap's real job is bounding an UPSTREAM error body, and 500 still does that;
 * the redaction is untouched and runs first.
 */
function sanitiseCxOneError(err) {
  const msg = String(err?.message || err || "Unknown error");
  return msg.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/refresh_token=[^\s&]+/gi, "refresh_token=[REDACTED]").substring(0, 500);
}

// Queue gauges read by /metrics + the graceful-shutdown drain.
function cxOneInflight() { return _cxOneInflight; }
function cxOneQueueDepth() { return _cxOneQueue.length; }
function cxOneQueueDropped() { return _cxOneQueueDropped; }

module.exports = {
  decodeCxOneApiKey, getCxOneConfig, cxOneGetBearerToken, enqueueCxOneProvision,
  cxOneProvisionUser, sanitiseCxOneError,
  cxOneInflight, cxOneQueueDepth, cxOneQueueDropped, cxOneQueueIdle,
  cxOneCreateUnconfirmedCounts, _tokenUrl, createdEmailSha,
  // a realm removal in progress (both removers announce and settle; the job asks)
  REALM_REMOVAL_MEMORY_MS, REALM_REMOVALS_MAX, cxOneRealmKey, classifyRealmRemoval, beginRealmRemoval, settleRealmRemoval,
  clearUnknownRealmRemoval, realmRemovalBlock, realmRemovalSince, accountGoneFromRealm,
  // deferred provisioning
  PROVISION_RETRY_DELAYS_MS, PROVISION_RETRY_MAX, stopCxOneProvisionRetries, cxOneProvisionRetriesPending,
  cxOneProvisionDeferredCounts, requeueDeferredCxOneProvision, resumeDeferredCxOneProvisioning, startCxOneProvisionResume,
  // test hooks (each throws unless NODE_ENV=test)
  _realmRemovalsSnapshotForTest, _ageRealmRemovalsForTest, _provisionRetriesSnapshotForTest, _fireCxOneProvisionRetriesNowForTest,
  _checkCxOneProvisionResumeNowForTest,
};
