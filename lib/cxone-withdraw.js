"use strict";
// Withdraws, from the customer's Checkmarx One realm, the accounts THIS
// platform created for participants who have since been deleted (v8.12.7).
//
// THE LEDGER IS THE ONLY INPUT, AND AN EXPLICIT DELETION RECORD THE ONLY
// TRIGGER. `cxone_realm_accounts` (lib/cxone-ledger.js) holds one row per
// account a provisioning job created off our own 201; a row becomes a
// candidate only once something stamped `pending_since` — the deletion
// cascade, inside its own transaction, or an in-flight withdrawal the realm
// refused. A MISSING `users` row alone never makes one: the server keeps
// serving on a failed integrity check, and a partial restore or a hand edit
// removes rows too, so an irreversible remote delete rests on the record, not
// on an absence. Such rows are listed to a superadmin as "unmarked" and are
// never acted on until one of them says so.
//
// THE RUNNER IS BACKED BY THE DATABASE AND SINGLE-FLIGHT, not the shared
// provisioning queue. A row is selected only by a compare-and-swap on its
// claim (with `next_attempt_at`), so nothing is held in memory, a double
// kick makes one attempt, provisioning is never evicted to make room, and a
// job still holding its own claim (lib/cxone.js) is skipped until that claim
// is released or goes stale.
//
// EVERY DELETE IS PRECEDED BY THE REALM'S OWN ANSWER, and each check fails
// towards a HOLD, never towards a delete — a false hold is recoverable, a false
// delete is not:
//   1. the creating instance is this one (a copied database must not delete
//      real users' accounts);
//   2. no living participant is bound to the account locally — and none MAY be:
//      a living participant's provisioning record that names the account but
//      cannot be read holds it (`binding_unreadable`) rather than read as nobody;
//   3. a key we hold for that realm (origin AND tenant) can read it;
//   4. its `createdTimestamp` and username match what we recorded — never
//      overridable, since that is the proof the account is ours;
//   5. a living participant who is visibly the same person — the address is
//      their VERIFIED PRIMARY and the names match — is TRANSFERRED the account
//      before anything below is judged: a hand-over removes nothing, and their
//      own deletion asks every question here again;
//   6. the tenant has not taken it into use outside this platform (adopted):
//      linked it to its sign-in provider, changed the address the create sent,
//      put it in a group this platform could never have granted, given it a
//      role directly (or taken away the realm's default role), set a detail on
//      it only its administrator can set, or added a credential to it since the
//      deletion. The rules for roles, details and credentials are
//      lib/cxone-identity.js's;
//   7. no other living account holds its address (the holder is asked again, so
//      one who became the same person meanwhile takes it over); then, on the
//      way to a DELETE only, the key must PROVE it sees every role an account
//      can carry (`roles_unreadable` otherwise), and the holder is asked again;
//   8. a synchronous re-check, with no await between it and the DELETE, which
//      also announces the removal to the process (`beginRealmRemoval`, lib/cxone.js),
//      so a provisioning job that reaches the account meanwhile waits rather than
//      links it; the answer settles it, and an account the realm says is gone
//      goes through `accountGoneFromRealm`, which clears any link made anyway.
// After every await the runner re-asks whether the row is still its own
// (`_stillMine`) and the user still absent, and stands down otherwise.
//
// NOTHING THE REALM RETURNS IS LOGGED. Audit lines carry the account id, the
// realm, the provenance, the attempt count and a fingerprint of the key that
// answered — never a name, an address, a username, a response body or an
// exception message (a JSON parse error quotes the body it failed on).
//
// NOTHING IS FORGOTTEN FOR ITS AGE. A row ends only when the account is gone
// from the realm (`_gone`), passes to a living participant (`transferTo`), or a
// superadmin marks it removed (`dismissCxOneWithdrawal`). A row still pending
// longer than EVENT_RETENTION_DAYS after the deletion is FLAGGED — listed as
// `past_retention` (derived from `pending_since`, never stored), counted on
// /metrics, noted in the app log — and kept, because it is the only means left
// of finishing the erasure in the tenant: dropping it erases nothing there.
// What a row keeps is the realm's own identifiers (account id, tenant,
// username), local links (the erased participant's id, the event) and an
// UNSALTED sha256 of the address the account was created with — reversible
// with a dictionary, and, once the tenant has changed the account's address, a
// copy the realm no longer holds. Each guards an irreversible DELETE (the
// provenance check, the adoption email check, the owner guards, the one event
// key an unconfirmed row may try), so none is stripped at that age either.
//
// NO TIMER AT MODULE SCOPE. The hourly sweep is started from server.js's
// listen callback and returns early under NODE_ENV=test; `scheduleRealmWithdrawal`
// is gated on `_autorunAllowed()`, so the shared test server never reaches a
// realm, while the spawned provisioning harness opts in for its own process.
//
// Direction: requires db, ./cxone (decode + token URL), ./http as a MODULE
// OBJECT (fetchWithTimeout is read at call time, so the harness's transport
// stub reaches it), ./log, ./audit, ./config, ./cxone-ledger and
// ./event-retention. lib/cxone.js requires THIS module lazily, inside a
// finally, so there is no load-time cycle; nothing here reaches lib/email.

const crypto = require("crypto");
const db = require("../db");
const { decodeCxOneApiKey, _tokenUrl, createdEmailSha, cxOneRealmKey, classifyRealmRemoval, beginRealmRemoval,
  settleRealmRemoval, realmRemovalBlock, clearUnknownRealmRemoval, accountGoneFromRealm } = require("./cxone");
const http = require("./http");
const { swallowed } = require("./best-effort");
const { log } = require("./log");
const { recordOrphanedAuditEvent } = require("./audit");
const { BASE_URL } = require("./config");
const { releaseClaim, deleteOwned, transferTo, backfillFromHistory, livingBinder, BINDING_UNREADABLE } = require("./cxone-ledger");
const { classifyRoleMappings, realmManagementVisible, unexplainedAttributeKeys, adminOnlyAttributeKeys,
  credentialsCreatedAfter, parseCreationBaseline } = require("./cxone-identity");
const { EVENT_RETENTION_MS, EVENT_RETENTION_DAYS } = require("./event-retention");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A claim older than this is a leftover (a crash, a drain cut short) and may be
// taken over. Comfortably longer than JOB_DEADLINE_MS plus one fetch timeout.
const STALE_CLAIM_MS = 15 * MINUTE;
const JOB_DEADLINE_MS = 2 * MINUTE;
const RUN_LIMIT = 50;
const SWEEP_INTERVAL_MS = HOUR;
// Never selected again until a superadmin acts on the row.
const PARKED = "9999-12-31T00:00:00.000Z";
const ADDRESS_RECHECK_MS = 7 * DAY;
const STRUCTURAL_RETRY_MS = DAY;
const GIVE_UP_AFTER_MS = 30 * DAY;
const GIVE_UP_MIN_ATTEMPTS = 5;
// The realm's `createdTimestamp` must fall within this window of the moment we
// recorded the account (a 201 arrives after the realm stamps its own record).
const PROVENANCE_WINDOW = Object.freeze([-15 * MINUTE, 5 * MINUTE]);
// A credential the realm dates up to this long BEFORE the deletion was
// scheduled still counts as added after it (`credential_after_deletion`). Two
// clocks are compared, and a realm running behind ours would date a credential
// added just after the deletion before it; this is the lag the provenance
// window already accepts. It leans to a hold, which is recoverable: the cost is
// that the participant's own credential from those last minutes holds too.
const CREDENTIAL_CLOCK_MARGIN_MS = -PROVENANCE_WINDOW[0];
const MAX_CANDIDATES = 5;
// One page of the account's group memberships. An account in this many groups
// is not one a provisioning job left behind, and a page we could not see the
// end of cannot be proven free of a foreign group — so a full page HOLDS.
const USER_GROUPS_PAGE = 100;

// The holds a superadmin may override. `provenance_unconfirmed` is deliberately
// absent: it is the only evidence the account is ours to remove at all.
const OVERRIDABLE_HOLDS = Object.freeze([
  "adopted_by_tenant", "address_held_by_living_account", "instance_unconfirmed", "instance_mismatch", "roles_unreadable",
  "binding_unreadable",
]);

// The ONE server-side table of what each reason means and what to do about it.
// The list route returns it beside every row, so the client copies nothing.
const WITHDRAWAL_REMEDY = Object.freeze({
  no_credentials_for_realm: "No Checkmarx One key this platform holds belongs to the tenant this account was created in. Add that tenant's key to an event or as the global default, then Retry — or remove the account in the tenant by hand, then Mark removed.",
  realm_unknown: "The platform cannot tell which Checkmarx One tenant this account was created in, and neither the event's key nor the global default reaches it. Add the right key, then Retry — or remove the account in the tenant by hand, then Mark removed.",
  token_refused: "The tenant refused the Checkmarx One key the platform holds for it — it may have been revoked or expired. Replace the key, then Retry — or remove the account in the tenant by hand, then Mark removed.",
  read_refused: "The Checkmarx One key the platform holds for this tenant is not allowed to read its users. Give the key's client the user-management role, then Retry — or remove the account in the tenant by hand, then Mark removed.",
  account_details_refused: "The tenant let the Checkmarx One key the platform holds read this account, but refused to show its roles or its sign-in credentials, so the platform cannot tell whether someone has taken it into use. Check what the key's client may see in the tenant, then Retry — or remove the account in the tenant by hand, then Mark removed.",
  delete_refused: "The tenant refused to delete the account — the key the platform holds is not allowed to remove users. Give the key's client the user-management role, then Retry — or remove the account in the tenant by hand, then Mark removed.",
  not_found_in_reachable_realms: "None of the tenants the platform can reach has this account — it may already have been removed, or it lives in a tenant whose key the platform no longer holds. Check the tenant, then Mark removed.",
  provenance_unconfirmed: "The tenant's own record of this account does not match the one this platform created (its creation time or username differs), so the platform will not remove it. Check it in the tenant and remove it by hand if it is ours, then Mark removed.",
  adopted_by_tenant: `The tenant has taken this account into use outside this platform — linked it to its own sign-in provider, added it to a group this platform does not grant in that tenant now, given it a role directly or taken away the role every new account gets, set a detail on it that only the tenant's administrator can set, added a password or sign-in method to it since the participant was deleted (or in the ${CREDENTIAL_CLOCK_MARGIN_MS / MINUTE} minutes before), or changed its email address — so someone may be using it. Remove anyway only if you are sure it belongs to the deleted participant alone.`,
  roles_unreadable: "The Checkmarx One key the platform holds for this tenant cannot prove it sees every role the tenant can give an account, so the platform cannot tell whether someone has taken this one into use. Let the key's client view the tenant's clients (the view-clients role), then Retry — or Remove anyway if you are sure it belongs to the deleted participant alone.",
  address_held_by_living_account: "A participant still on this platform holds this account's email address, so it may be theirs. The platform re-checks weekly. Remove anyway only if you are sure it belongs to the deleted participant alone.",
  binding_unreadable: "A participant still on this platform has a Checkmarx One set-up record that names this account, but the record cannot be read, so the platform cannot tell whether the account is theirs. It neither removes the account nor gives it to them. Remove anyway only if you are sure it belongs to the deleted participant alone.",
  instance_unconfirmed: "The platform cannot confirm this account was created by this installation — it was found in the history rather than recorded when it was made. Remove anyway once you are sure this installation made it.",
  instance_mismatch: "This account was recorded by a different installation of the platform (a copied or restored database). Remove anyway only if this installation should now look after it.",
  unmarked: "The participant this account was created for is no longer on the platform, but nothing recorded their deletion. The platform will not act on an absence; use Schedule removal to have it removed from the tenant, or Mark removed to stop tracking it.",
  transient_stalled: "The tenant could not be reached, or answered with an error, several times in a row. The platform keeps retrying; if this persists, check the tenant's availability.",
  given_up: "The platform stopped retrying after 30 days. Remove the account in the tenant by hand, then Mark removed — or Retry to start again.",
});

// What made the runner hold an account as `adopted_by_tenant` (`held_signal`),
// in plain words for the superadmin deciding on Remove anyway — the remedy lists
// every possibility; this says which one it was. A fixed token, never a value
// the realm returned.
const ADOPTION_SIGNAL_TEXT = Object.freeze({
  federation_link: "It is linked to the tenant's own user directory.",
  email_changed: "Its email address is no longer the one the platform created it with.",
  federated_identity: "It is linked to one of the tenant's sign-in providers.",
  groups_full_page: "It belongs to more groups than the platform can check.",
  foreign_group: "It belongs to a group this platform does not grant in that tenant.",
  role_mapping: "It has been given a role directly, beyond the one every new account gets and any it had when the platform created it.",
  default_role_removed: "The role every new account in the tenant gets has been taken away from it.",
  attribute: "It carries a detail that only the tenant's administrator can set.",
  attribute_unverified: "It carries a detail the platform could not check, because the tenant would not say which details only its administrator can set.",
  credential_after_deletion: `A password or sign-in method was added to it after the participant was deleted, or in the ${CREDENTIAL_CLOCK_MARGIN_MS / MINUTE} minutes before (the tenant's clock and this platform's cannot be told apart that closely).`,
});

// ─── Configuration and gates ──────────────────────────────────────────────────

// `null` FAILS CLOSED: the runner refuses until server.js hands it a health
// predicate, so nothing is withdrawn from a database that failed its checks.
let _health = null;
function configureCxOneWithdrawals({ isHealthy } = {}) {
  _health = typeof isHealthy === "function" ? isHealthy : null;
}
function _healthy() {
  try { return !!(_health && _health()); } catch (_) { return false; }
}
// Read on every call: the shared test server never sets the opt-in, so no
// request there can ever reach a realm; the spawned harness sets it in its own
// process to drive the automatic path.
function _autorunAllowed() {
  return process.env.NODE_ENV !== "test" || process.env.CXONE_WITHDRAWAL_AUTORUN_IN_TEST === "1";
}

let _running = null;   // the in-flight run, if any
let _rerun = false;    // a kick arrived while running — run once more
let _deferred = null;  // a kick scheduled for the next turn of the event loop
let _stopping = false;
let _sweepTimer = null;

// In-process lifetime counters, for /metrics. The rows themselves are durable.
const _totals = { withdrawn: 0, already_gone: 0, transferred: 0, held: 0, failed: 0, given_up: 0 };

// Single-flight. The loop and the `_running = null` sit in ONE async function
// with no await between the final `_rerun` test and the clear, so a kick can
// never land in a gap and be lost.
function _kick(now) {
  if (_running) { _rerun = true; return _running; }
  _running = (async () => {
    try {
      do { _rerun = false; await runWithdrawals(now ? { now } : {}); now = null; } while (_rerun && !_stopping);
    } catch (e) {
      try { log.warn({ err: e && e.name }, "CxOne withdrawal run failed"); } catch (e2) { swallowed("cxone-withdraw:run-failure-log", e2); }
    } finally {
      _running = null;
    }
  })();
  return _running;
}

// The kick every other module calls. Cheap: a pending-row probe on the partial
// index, and nothing at all while autorun is off.
//
// THE RUN STARTS ON THE NEXT TURN OF THE EVENT LOOP, never inside the caller
// (pre-release review). A run is synchronous up to its first await, and that
// stretch includes the living-binder scan over `user_events` — so a kick made
// from `deleteUserCascade` ran that scan inside the admin's DELETE request.
// `setImmediate` hands it to the loop instead; the promise returned resolves
// to the run, so a caller that waits (the harness) still waits for it. A
// second kick before the first has started joins it.
function scheduleRealmWithdrawal({ now } = {}) {
  if (!_autorunAllowed()) return null;
  if (_running) { _rerun = true; return _running; }
  if (_deferred) return _deferred;
  let pending;
  try {
    pending = db.prepare("SELECT 1 FROM cxone_realm_accounts WHERE pending_since IS NOT NULL AND given_up_at IS NULL LIMIT 1").get();
  } catch (_) { return null; }
  if (!pending) return null;
  _deferred = new Promise((resolve) => {
    setImmediate(() => {
      _deferred = null;
      resolve(_stopping ? null : _kick(now));
    });
  });
  return _deferred;
}

// AN UNANSWERED REMOVAL IS READ AGAIN A MINUTE LATER. A DELETE that got no
// answer, or a 5xx, may or may not have removed the account, and until the realm
// says which, a provisioning job that reaches it waits (lib/cxone.js). Its row is
// due a minute later (`_fail` `{soon}`), and this one-shot kick is what makes the
// runner come back then: on its own it runs only on kicks and the hourly sweep.
// The realm's answer settles it: 404 is gone, 2xx is still there. One timer per
// unanswered removal (a DELETE takes up to the fetch deadline, so they are few),
// unref'd, cleared when the sweeper stops.
const UNANSWERED_REREAD_MS = 61 * 1000;
const _rereads = new Set();
function armUnansweredRemovalReread() {
  if (!_autorunAllowed() || _stopping) return false;
  const entry = { delayMs: UNANSWERED_REREAD_MS, timer: null };
  entry.fire = (now) => { _rereads.delete(entry); clearTimeout(entry.timer); if (!_stopping) scheduleRealmWithdrawal(now ? { now } : {}); };
  _rereads.add(entry);
  entry.timer = setTimeout(() => entry.fire(), UNANSWERED_REREAD_MS);
  if (typeof entry.timer.unref === "function") entry.timer.unref();
  return true;
}
// Test hooks: what is armed, and firing each one now with the clock it would
// fire at (so the row it is for is due) — never a run the code did not arm.
function _armedRereadsForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("_armedRereadsForTest is a test hook");
  return [..._rereads].map((e) => ({ delayMs: e.delayMs }));
}
function _fireArmedRereadsForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("_fireArmedRereadsForTest is a test hook");
  const armed = [..._rereads];
  for (const e of armed) e.fire(() => new Date(Date.now() + e.delayMs));
  return armed.length;
}

// ─── Small readers ───────────────────────────────────────────────────────────

function _currentOrigin() { try { return new URL(BASE_URL).origin; } catch (_) { return null; } }
function _keyFp(apiKey) { return crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 12); }
function _realmOf(row) { return row.iam_origin && row.tenant ? { origin: row.iam_origin, tenant: row.tenant } : null; }
function _overridden(row, reason) {
  return typeof row.override_reason === "string" && row.override_reason.split(",").includes(reason);
}
function _userExists(userId) { return !!db.prepare("SELECT 1 FROM users WHERE id=?").get(userId); }

// Is the row still the one this run claimed? Present, same claim, same owner,
// still pending. A transfer, a dismissal, a colleague's retry or a stolen stale
// claim all make it false, and the runner stands down.
function _stillMine(row, claim) {
  const r = db.prepare("SELECT user_id, claim_token, pending_since FROM cxone_realm_accounts WHERE cxone_user_id=?").get(row.cxone_user_id);
  return !!r && r.claim_token === claim && r.user_id === row.user_id && r.pending_since != null;
}

// A LIVING participant bound to this account locally — by their event binding,
// or by their own provisioning history naming the id. Either makes the account
// theirs to keep, with no remote call at all. v8.13.1 — the definition moved to
// lib/cxone-ledger.js (`livingBinder`) so the provisioning job's in-flight
// withdrawal asks the same question; this name stays, being what S4 pins.
// Answers the binder's id, `BINDING_UNREADABLE` (a living participant's record
// names the account but cannot be read — held, never handed over), or null.
function _livingBinder(cxoneUserId) { return livingBinder(db, cxoneUserId); }

// The keys to try, decoded. A CONFIRMED row takes only keys whose origin AND
// tenant are the row's own (the event's, the global default, then every other
// event's, most recent first). An UNCONFIRMED row takes only the event's
// current key and the global default — never every key the platform holds.
function _candidates(row) {
  const keys = [];
  if (row.competition_id) {
    const k = db.prepare("SELECT cxone_api_key FROM competitions WHERE id=?").get(row.competition_id);
    if (k && k.cxone_api_key) keys.push(k.cxone_api_key);
  }
  const g = db.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get();
  if (g && g.value) keys.push(g.value);
  if (row.realm_confirmed) {
    const all = db.prepare(`SELECT cxone_api_key AS k FROM competitions
      WHERE cxone_api_key IS NOT NULL AND cxone_api_key <> ''
      GROUP BY cxone_api_key ORDER BY MAX(start_time) DESC`).all();
    for (const r of all) keys.push(r.k);
  }
  const out = [], seen = new Set();
  for (const k of keys) {
    if (typeof k !== "string" || seen.has(k)) continue;
    seen.add(k);
    const c = decodeCxOneApiKey(k);
    if (!c) continue;
    if (row.realm_confirmed) {
      let o = null;
      try { o = new URL(c.iamUrl).origin; } catch (_) { continue; }
      if (o !== row.iam_origin || c.tenant !== row.tenant) continue;
    }
    out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// Every group name this platform could have granted an account IN THIS
// ACCOUNT'S REALM: for every event, the group it grants (its own, or the global
// default) under the key it provisions with (its own, or the global default —
// the precedence lib/cxone.js `getCxOneConfig` uses, including its fallback
// when an event's own key does not decode), plus the global default group under
// the global default key. Compared the way the grant resolves names
// (lib/cxone-identity.js resolveCxOneGroup: exact, or equal ignoring case).
//
// v8.13.1 (external audit) — SCOPED TO THE REALM, AND THAT IS THE WHOLE FIX.
// The set used to be every group name configured ANYWHERE, so an event
// provisioning a DIFFERENT customer's tenant made its group name look like one
// this platform grants here: an account the tenant had put into its own group of
// that name lost the adoption hold and was deleted (reproduced — the control
// held; adding the unrelated event's configuration deleted it). A group name
// means nothing outside the realm that holds it.
//
// An event deleted since, a name or key changed since, or a realm this row does
// not name (no origin or tenant) drops its group out of the set — which makes a
// membership granted under it look foreign and HOLD: the safe direction for a
// set this platform can only reconstruct.
function _realmOfCfg(cfg) { return cxOneRealmKey(cfg); }

function _platformGroupNames(row) {
  const out = new Set();
  const want = row && typeof row.iam_origin === "string" && row.iam_origin && typeof row.tenant === "string" && row.tenant
    ? row.iam_origin + "\u0000" + row.tenant : null;
  if (!want) return out;
  const gk = db.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get();
  const gn = db.prepare("SELECT value FROM settings WHERE key='default_cxone_group_name'").get();
  const defaultRealm = gk && typeof gk.value === "string" && gk.value ? _realmOfCfg(decodeCxOneApiKey(gk.value)) : null;
  const defaultGroup = gn && typeof gn.value === "string" && gn.value ? gn.value : null;
  if (defaultGroup && defaultRealm === want) out.add(defaultGroup.toLowerCase());
  const realmOfKey = new Map();
  for (const r of db.prepare(`SELECT DISTINCT cxone_api_key AS k, cxone_group_name AS n FROM competitions`).all()) {
    let realm = defaultRealm;
    if (typeof r.k === "string" && r.k) {
      if (!realmOfKey.has(r.k)) realmOfKey.set(r.k, _realmOfCfg(decodeCxOneApiKey(r.k)));
      // An event key that does not decode falls back to the global default,
      // exactly as provisioning does.
      realm = realmOfKey.get(r.k) || defaultRealm;
    }
    if (realm !== want) continue;
    const name = typeof r.n === "string" && r.n ? r.n : defaultGroup;
    if (name) out.add(name.toLowerCase());
  }
  return out;
}

// Has the tenant changed the address our create sent? Compared by fingerprint
// only (`created_email_sha`, recorded at the 201). A row with none — backfilled,
// or recorded before the column existed — skips this one check. A realm record
// with NO address where we sent one is a change too.
function _emailChangedSince(row, rep) {
  if (typeof row.created_email_sha !== "string" || !row.created_email_sha) return false;
  return createdEmailSha(rep.email) !== row.created_email_sha;
}

// A realm read that answered but refused: 401/403 is the key itself not being
// allowed to read (structural, the `read_refused` remedy); anything else is the
// realm being unwell and is retried. Never "no data" — an unread answer is not
// an empty one.
function _failRead(row, claim, status, code, now, ctx) {
  if (status === 401 || status === 403) _fail(row, claim, "structural", "read_refused", status, now, ctx);
  else _fail(row, claim, "transient", code, status, now, ctx);
}

function _adminBase(c) { return `${c.iamUrl}/auth/admin/realms/${encodeURIComponent(c.tenant)}`; }
function _userUrl(c, id) { return `${_adminBase(c)}/users/${encodeURIComponent(id)}`; }

// ─── Outcomes ────────────────────────────────────────────────────────────────

// Orphaned (app.jsonl and its orphan_events copy), never a `user_events` row for an erased participant.
function _emit(row, eventType, ctx, extra) {
  try {
    recordOrphanedAuditEvent("user", row.user_id, eventType, "system", {
      cxone_user_id: row.cxone_user_id,
      realm: _realmOf(row),
      provenance: row.provenance,
      attempts: extra && Number.isInteger(extra.attempts) ? extra.attempts : row.attempts,
      ...(ctx && ctx.keyFp ? { key_fp: ctx.keyFp } : {}),
      ...(extra || {}),
    });
  } catch (e) { /* an audit failure never stops a withdrawal decision */ swallowed("cxone-withdraw:audit-emit", e); }
}

const _GUARD = "cxone_user_id=? AND claim_token=? AND user_id=?";

// The DELETE answers that do not say whether the account went (lib/cxone.js
// `classifyRealmRemoval` "unknown"). The FIRST of them in a row is read again a
// minute later rather than after the back-off (`{soon}`), because matches wait on
// it; a second in a row backs off like any failure.
const _UNANSWERED_DELETE_CODES = new Set(["delete_unanswered", "delete_failed"]);

function _fail(row, claim, kind, code, status, now, ctx, { soon = false } = {}) {
  const id = row.cxone_user_id;
  const cur = db.prepare(`SELECT attempts, first_failed_at, attention, last_error FROM cxone_realm_accounts WHERE ${_GUARD}`)
    .get(id, claim, row.user_id);
  if (!cur) return;
  const t = now(), nowMs = t.getTime(), nowIso = t.toISOString();
  const attempts = (cur.attempts || 0) + 1;
  const firstIso = cur.first_failed_at || nowIso;
  const firstMs = Date.parse(firstIso);
  let attention = cur.attention ? 1 : 0;
  let nextIso;
  if (kind === "structural") {
    attention = 1;
    nextIso = new Date(nowMs + STRUCTURAL_RETRY_MS).toISOString();
  } else {
    nextIso = new Date(nowMs + Math.min(2 ** Math.min(attempts - 1, 5), 24) * HOUR).toISOString();
    const prevCode = typeof cur.last_error === "string" ? cur.last_error.split("/")[1] : null;
    if (soon && !_UNANSWERED_DELETE_CODES.has(prevCode)) nextIso = new Date(nowMs + MINUTE).toISOString();
    if (nowMs - firstMs >= DAY || attempts >= 3) attention = 1;
  }
  let givenUp = false;
  if (nowMs - firstMs > GIVE_UP_AFTER_MS && attempts >= GIVE_UP_MIN_ATTEMPTS) {
    givenUp = true; attention = 1; nextIso = PARKED;
  }
  // Status and a fixed code only — never a response body or an exception
  // message, which can quote what the realm returned about a person.
  const lastError = `${Number.isInteger(status) ? status : 0}/${code}`;
  db.prepare(`UPDATE cxone_realm_accounts SET attempts=?, first_failed_at=?, last_error=?, attention=?,
      next_attempt_at=?, given_up_at=CASE WHEN ? THEN ? ELSE given_up_at END, held_reason=NULL, held_signal=NULL
      WHERE ${_GUARD}`)
    .run(attempts, firstIso, lastError, attention, nextIso, givenUp ? 1 : 0, nowIso, id, claim, row.user_id);
  _totals.failed++;
  try {
    log.warn({ cxone_user_id: id, realm: _realmOf(row), status: status || 0, code, attempt: attempts, kind },
      "CxOne: could not withdraw a realm account created for a deleted participant; the platform will retry");
  } catch (e) { swallowed("cxone-withdraw:fail-log", e); }
  if (givenUp) {
    _totals.given_up++;
    _emit(row, "cxone_realm_withdrawal_given_up", ctx, { attempts, code,
      note: "Retries stopped after 30 days — remove it in the tenant by hand, then Mark removed" });
  }
  if (!cur.attention && attention) _emit(row, "cxone_realm_withdrawal_needs_attention", ctx, { attempts, code });
}

// A hold waits for a human (or, for an address held by a living account, a
// weekly re-check). It never touches `attempts` or `first_failed_at`, so a
// long hold can never age a row into being given up. `signal` (an
// ADOPTION_SIGNAL_TEXT key) says what held an adopted account; any other hold
// clears it.
function _hold(row, claim, reason, now, ctx, signal = null) {
  const id = row.cxone_user_id;
  const cur = db.prepare(`SELECT held_reason, held_signal FROM cxone_realm_accounts WHERE ${_GUARD}`).get(id, claim, row.user_id);
  if (!cur) return;
  const t = now();
  const nextIso = reason === "address_held_by_living_account"
    ? new Date(t.getTime() + ADDRESS_RECHECK_MS).toISOString() : PARKED;
  db.prepare(`UPDATE cxone_realm_accounts SET held_reason=?, held_signal=?, attention=1, next_attempt_at=? WHERE ${_GUARD}`)
    .run(reason, signal, nextIso, id, claim, row.user_id);
  _totals.held++;
  if (cur.held_reason !== reason || (cur.held_signal || null) !== signal) {
    _emit(row, "cxone_realm_withdrawal_held", ctx, { reason, ...(signal ? { signal } : {}) });
  }
}

// A living participant's provisioning record names the account but cannot be
// read (`livingBinder` answered BINDING_UNREADABLE). The account may be theirs,
// so it is never removed past it, and nobody is handed it on evidence no one can
// read: it waits for a superadmin. Said at warn level too, because the cause is
// a damaged row in this platform's own database, which an operator may want to
// look at — the account id and realm only, never anything the record holds.
function _holdBindingUnreadable(row, claim, now, ctx) {
  try {
    log.warn({ cxone_user_id: row.cxone_user_id, realm: _realmOf(row) },
      "CxOne: a set-up record of a participant still on the platform names this account but cannot be read — not removed; held for a superadmin");
  } catch (e) { swallowed("cxone-withdraw:binding-unreadable-log", e); }
  _hold(row, claim, "binding_unreadable", now, ctx);
}

// A hand-over never gives a living participant an account the platform has
// just removed, or is removing: a tombstone means the account is gone (said so,
// and any link to it cleared); a removal in flight or unanswered stands down
// until the realm has answered.
function _transfer(row, claim, livingUserId, reason, now, ctx) {
  const blk = realmRemovalBlock(row.cxone_user_id);
  if (blk === "recently_removed") {
    const g = accountGoneFromRealm(row.cxone_user_id, null, row.user_id);
    _gone(row, claim, "already_gone", ctx, g);
    return;
  }
  if (blk) return;
  const n = transferTo(db, row.cxone_user_id, livingUserId, now().toISOString());
  if (!n) return;
  _totals.transferred++;
  _emit(row, "cxone_realm_withdrawal_transferred", ctx, { transferred_to_user_id: livingUserId, reason });
}

// `g` is what `accountGoneFromRealm` found: links to the account cleared, and
// whether its row had passed to somebody living meanwhile (then forgotten).
function _gone(row, claim, result, ctx, g) {
  deleteOwned(db, row.cxone_user_id, claim, row.user_id);
  if (result === "already_gone") _totals.already_gone++; else _totals.withdrawn++;
  _emit(row, "cxone_realm_account_withdrawn", ctx, { result,
    ...(g && g.bindingsCleared ? { bindings_cleared: g.bindingsCleared } : {}),
    ...(g && g.rekeyedTo ? { taken_over_during_withdrawal: true } : {}) });
}

// Three index searches (uq_users_email_nocase, uq_users_secondary_email_nocase,
// idx_users_pending_email_nocase): the planner reads the three slots OR-ed as a
// scan of every account. UNION, not UNION ALL: an account holding the address in
// two slots is still ONE holder, which the hand-over's `length === 1` needs.
const ADDRESS_HOLDERS_SQL =
  "SELECT id, email, verified, first_name, last_name FROM users WHERE email = ? COLLATE NOCASE "
  + "UNION SELECT id, email, verified, first_name, last_name FROM users WHERE secondary_email = ? COLLATE NOCASE "
  + "UNION SELECT id, email, verified, first_name, last_name FROM users WHERE pending_email = ? COLLATE NOCASE";

// (9) Every living holder of its address — primary, secondary or pending,
// verified or not — HOLDS it. Only a holder whose VERIFIED PRIMARY is that
// address, and whose names match the realm's record, may TAKE it over
// (pre-release review): a secondary address or a pending change is written
// straight from a profile form and confirmed by nothing, and names are free
// text, so anyone could otherwise divert a removal onto themselves. The address
// itself is never logged. Synchronous; true when it handed the account over or
// held it, so the run stops. Asked first with `handOverOnly`, after (7) and
// before the adoption signs, when it only ever hands over: any other holder is
// weighed at (9), after them.
function _addressHolder(row, claim, rep, now, ctx, { handOverOnly = false } = {}) {
  if (!(typeof rep.email === "string" && rep.email.trim())) return false;
  const addr = rep.email.trim();
  const holders = db.prepare(ADDRESS_HOLDERS_SQL).all(addr, addr, addr);
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
  if (holders.length === 1) {
    const h = holders[0];
    const provenPrimary = Number(h.verified) === 1 && norm(h.email) === norm(addr);
    const same = provenPrimary && norm(h.first_name) && norm(h.last_name)
      && norm(h.first_name) === norm(rep.firstName) && norm(h.last_name) === norm(rep.lastName);
    if (same) { _transfer(row, claim, h.id, "address_held_by_same_person", now, ctx); return true; }
  }
  if (handOverOnly) return false;
  if (holders.length && !_overridden(row, "address_held_by_living_account")) {
    _hold(row, claim, "address_held_by_living_account", now, ctx);
    return true;
  }
  return false;
}

// ─── One account ─────────────────────────────────────────────────────────────

async function _withdrawOne(row, claim, now) {
  const id = row.cxone_user_id;
  const started = Date.now();
  const late = () => Date.now() - started > JOB_DEADLINE_MS;
  const ours = () => _stillMine(row, claim) && !_userExists(row.user_id);
  const ctx = { keyFp: null };
  let begun = false;   // a removal announced and not yet settled
  try {
    // (1) The creating instance, with no remote call.
    if (row.instance_origin !== _currentOrigin()) {
      const reason = row.instance_origin ? "instance_mismatch" : "instance_unconfirmed";
      if (!_overridden(row, reason)) { _hold(row, claim, reason, now, ctx); return; }
    }
    // (2) A living participant bound to it locally, with no remote call — unless
    // a removal of it went unanswered: then the realm is asked first (4), which is
    // what resolves it; the hand-over is asked again at (10). A living
    // participant's record that names it but cannot be read holds it for a
    // superadmin, with no remote call either — unless a superadmin has already
    // decided (a `binding_unreadable` override): then only a READABLE binder
    // stops the removal, and is still handed the account.
    const binder = realmRemovalBlock(id) === "removal_outcome_unknown" ? null : _livingBinder(id);
    if (binder) {
      if (binder !== BINDING_UNREADABLE) { _transfer(row, claim, binder, "bound_to_living_account", now, ctx); return; }
      if (!_overridden(row, "binding_unreadable")) { _holdBindingUnreadable(row, claim, now, ctx); return; }
    }

    // (3) The keys that can reach its realm.
    const cands = _candidates(row);
    if (!cands.length) {
      _fail(row, claim, "structural", row.realm_confirmed ? "no_credentials_for_realm" : "realm_unknown", 0, now, ctx);
      return;
    }

    // (4) Read the realm's own record with each candidate in turn.
    const notes = [];
    let rep = null, chosen = null, token = null;
    for (const c of cands) {
      if (late()) { notes.push({ kind: "transient", code: "deadline", status: 0 }); break; }
      let tResp;
      try {
        tResp = await http.fetchWithTimeout(_tokenUrl(c), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: "ast-app", refresh_token: c.apiKey }),
        });
      } catch (_) {
        if (!ours()) return;
        notes.push({ kind: "transient", code: "network", status: 0 });
        continue;
      }
      if (!ours()) return;
      if (!tResp.ok) {
        // A 4xx is the key itself refused (revoked, expired, wrong tenant); a
        // 5xx or a 429 is the realm being unwell and is retried like any other.
        const st = tResp.status;
        notes.push(st >= 500 || st === 429
          ? { kind: "transient", code: "token_unavailable", status: st }
          : { kind: "structural", code: "token_refused", status: st });
        continue;
      }
      let tok = null;
      try { tok = (await tResp.json()).access_token; } catch (_) { tok = null; }
      if (!ours()) return;
      if (typeof tok !== "string" || !tok) { notes.push({ kind: "transient", code: "token_unreadable", status: tResp.status }); continue; }

      if (late()) { notes.push({ kind: "transient", code: "deadline", status: 0 }); break; }
      let gResp;
      try {
        gResp = await http.fetchWithTimeout(_userUrl(c, id), { headers: { Authorization: `Bearer ${tok}` } });
      } catch (_) {
        if (!ours()) return;
        notes.push({ kind: "transient", code: "network", status: 0 });
        continue;
      }
      if (!ours()) return;
      const gs = gResp.status;
      if (gs >= 200 && gs < 300) {
        let body = null;
        try { body = await gResp.json(); } catch (_) { body = null; }
        if (!ours()) return;
        if (!body || typeof body !== "object") { notes.push({ kind: "transient", code: "unreadable", status: gs }); continue; }
        rep = body; chosen = c; token = tok; ctx.keyFp = _keyFp(c.apiKey);
        // The realm says it still exists: an unanswered removal did not happen.
        clearUnknownRealmRemoval(id);
        break;
      }
      if (gs === 404) {
        if (row.realm_confirmed) {
          // The realm we KNOW it was created in says it is gone — and any link a
          // living participant was given to it meanwhile goes with it.
          ctx.keyFp = _keyFp(c.apiKey);
          _gone(row, claim, "already_gone", ctx, accountGoneFromRealm(id, c, row.user_id));
          return;
        }
        notes.push({ kind: "notfound", code: "not_found", status: 404 });
        continue;
      }
      if (gs === 401 || gs === 403) { notes.push({ kind: "structural", code: "read_refused", status: gs }); continue; }
      notes.push({ kind: "transient", code: "upstream_error", status: gs });
    }

    // (5) No realm answered with the account.
    if (!rep) {
      if (!row.realm_confirmed && notes.length && notes.every((n) => n.kind === "notfound")) {
        _fail(row, claim, "structural", "not_found_in_reachable_realms", 404, now, ctx);
      } else {
        const s = notes.find((n) => n.kind === "structural");
        const n = s || notes.find((x) => x.kind === "transient") || { kind: "transient", code: "unreachable", status: 0 };
        _fail(row, claim, n.kind === "structural" ? "structural" : "transient", n.code, n.status, now, ctx);
      }
      return;
    }

    // (6) Provenance against the realm's own record — never overridable.
    const pAt = Date.parse(row.provenance_at);
    const ct = rep.createdTimestamp;
    const timeOk = Number.isFinite(ct) && Number.isFinite(pAt)
      && ct >= pAt + PROVENANCE_WINDOW[0] && ct <= pAt + PROVENANCE_WINDOW[1];
    const nameOk = typeof rep.username === "string" && !!row.created_username
      && rep.username.toLowerCase() === row.created_username;
    if (!timeOk || !nameOk) { _hold(row, claim, "provenance_unconfirmed", now, ctx); return; }

    // (7) The realm is now known for certain.
    if (!row.realm_confirmed) {
      let origin = null;
      try { origin = new URL(chosen.iamUrl).origin; } catch (e) { swallowed("cxone-withdraw:iam-origin-parse", e); }
      if (origin) {
        db.prepare(`UPDATE cxone_realm_accounts SET iam_origin=?, tenant=?, realm_confirmed=1 WHERE ${_GUARD}`)
          .run(origin, chosen.tenant, id, claim, row.user_id);
        row.iam_origin = origin; row.tenant = chosen.tenant; row.realm_confirmed = 1;
      }
    }
    // The same person takes the account over BEFORE any sign of the tenant's
    // use is weighed (the header's step 5): a hand-over removes nothing, and
    // when that participant is deleted in turn, every check below runs again —
    // so whatever the tenant did with the account cannot stop the person it was
    // made for from keeping it. Any other holder waits for (9).
    if (_addressHolder(row, claim, rep, now, ctx, { handOverOnly: true })) return;

    const auth = { Authorization: `Bearer ${token}` };
    // One realm read for step (8): the fetch and its body, each followed by
    // `ours()`. Answers {status, ok, body} — `body` undefined when the answer was
    // not ok or not JSON — or null once it has stood down, or recorded a fetch
    // that got no answer (or ran out of time) as a transient `code`.
    const get = async (url, code) => {
      if (late()) { _fail(row, claim, "transient", "deadline", 0, now, ctx); return null; }
      let resp;
      try { resp = await http.fetchWithTimeout(url, { headers: auth }); }
      catch (_) { if (ours()) _fail(row, claim, "transient", code, 0, now, ctx); return null; }
      if (!ours()) return null;
      if (!resp.ok) return { status: resp.status, ok: false, body: undefined };
      let body;
      try { body = await resp.json(); } catch (_) { body = undefined; }
      if (!ours()) return null;
      return { status: resp.status, ok: true, body };
    };
    // A refused read of the account's own roles or credentials, after the same
    // key has just read the account: 403 is the key not being shown them (its
    // own remedy — `read_refused`'s "may not read its users" would be false); a
    // 401 is the token, retried; anything else is the realm being unwell.
    const refusedDetails = (r, code) => _fail(row, claim, r.status === 403 ? "structural" : "transient",
      r.status === 403 ? "account_details_refused" : code, r.status, now, ctx);
    // (8) Taken into use by the tenant outside this platform? Every signal is
    // the same hold (`adopted_by_tenant`), recorded with WHICH signal it was
    // (`held_signal`), so an override answers all of them and none is re-read
    // once a superadmin has decided — an override made before a signal existed
    // waives it too. Visible evidence is weighed first and short-circuits the
    // rest; only once all of it is clean, and no one takes the account over at
    // (9), does the key have to PROVE it sees every role (`roles_unreadable`,
    // overridable on its own).
    let proveRoles = false;
    if (!_overridden(row, "adopted_by_tenant")) {
      // Synchronous first: a sign-in link on the record itself, an address that
      // no longer hashes to the one the create sent, and the attribute keys the
      // record carries that nothing explains (keys only — values are never read).
      let adopted = rep.federationLink ? "federation_link" : (_emailChangedSince(row, rep) ? "email_changed" : null);
      const baseline = parseCreationBaseline(row.created_baseline);
      let attrs = null;
      if (!adopted) {
        attrs = unexplainedAttributeKeys(rep.attributes, baseline);
        if (attrs.malformed) { _fail(row, claim, "transient", "attributes_unreadable", 200, now, ctx); return; }
      }
      if (!adopted) {
        if (late()) { _fail(row, claim, "transient", "deadline", 0, now, ctx); return; }
        let fResp;
        try {
          fResp = await http.fetchWithTimeout(`${_userUrl(chosen, id)}/federated-identity`, { headers: auth });
        } catch (_) {
          if (!ours()) return;
          _fail(row, claim, "transient", "adoption_unreadable", 0, now, ctx);
          return;
        }
        if (!ours()) return;
        if (!fResp.ok) { _fail(row, claim, "transient", "adoption_unreadable", fResp.status, now, ctx); return; }
        let links = null;
        try { links = await fResp.json(); } catch (_) { links = null; }
        if (!ours()) return;
        if (!Array.isArray(links)) { _fail(row, claim, "transient", "adoption_unreadable", fResp.status, now, ctx); return; }
        if (links.length > 0) adopted = "federated_identity";
      }
      if (!adopted) {
        // Its group memberships. Any group whose name this platform could not
        // have granted is a sign the tenant took it into use. A failed read is
        // classified like every other realm read — never treated as "none".
        if (late()) { _fail(row, claim, "transient", "deadline", 0, now, ctx); return; }
        let grResp;
        try {
          grResp = await http.fetchWithTimeout(`${_userUrl(chosen, id)}/groups?first=0&max=${USER_GROUPS_PAGE}`, { headers: auth });
        } catch (_) {
          if (!ours()) return;
          _fail(row, claim, "transient", "groups_unreadable", 0, now, ctx);
          return;
        }
        if (!ours()) return;
        if (!grResp.ok) { _failRead(row, claim, grResp.status, "groups_unreadable", now, ctx); return; }
        let groups = null;
        try { groups = await grResp.json(); } catch (_) { groups = null; }
        if (!ours()) return;
        if (!Array.isArray(groups)) { _fail(row, claim, "transient", "groups_unreadable", grResp.status, now, ctx); return; }
        if (groups.length >= USER_GROUPS_PAGE) {
          adopted = "groups_full_page";   // a page we cannot see the end of cannot be proven free of a foreign group
        } else {
          const platform = _platformGroupNames(row);
          let foreign = groups.filter((g) => !(g && typeof g.name === "string" && platform.has(g.name.toLowerCase())));
          if (foreign.length) {
            // The realm's DEFAULT groups are assigned at creation, to every
            // account — ours included — so membership of one is not adoption.
            // Asked only when a foreign group was found. A refusal leaves the
            // defaults unknown and the foreign group stands (a hold, never a
            // delete); only a realm that is unwell is retried.
            if (late()) { _fail(row, claim, "transient", "deadline", 0, now, ctx); return; }
            let defResp;
            try {
              defResp = await http.fetchWithTimeout(`${_adminBase(chosen)}/default-groups`, { headers: auth });
            } catch (_) {
              if (!ours()) return;
              _fail(row, claim, "transient", "groups_unreadable", 0, now, ctx);
              return;
            }
            if (!ours()) return;
            if (defResp.ok) {
              let defs = null;
              try { defs = await defResp.json(); } catch (_) { defs = null; }
              if (!ours()) return;
              if (!Array.isArray(defs)) { _fail(row, claim, "transient", "groups_unreadable", defResp.status, now, ctx); return; }
              const defIds = new Set(defs.filter((d) => d && typeof d.id === "string").map((d) => d.id));
              foreign = foreign.filter((g) => !(g && typeof g.id === "string" && defIds.has(g.id)));
            } else if (defResp.status >= 500 || defResp.status === 429) {
              _fail(row, claim, "transient", "groups_unreadable", defResp.status, now, ctx);
              return;
            }
          }
          if (foreign.length > 0) adopted = "foreign_group";
        }
      }
      if (!adopted) {
        // Its DIRECT role mappings, against the realm's default role and what it
        // carried at creation (lib/cxone-identity.js `classifyRoleMappings`).
        const r = await get(`${_userUrl(chosen, id)}/role-mappings`, "role_mappings_unreadable");
        if (!r) return;
        if (!r.ok) { refusedDetails(r, "role_mappings_unreadable"); return; }
        const v = classifyRoleMappings(r.body, { tenant: row.tenant, baseline }).verdict;
        if (v === "malformed") { _fail(row, claim, "transient", "role_mappings_unreadable", r.status, now, ctx); return; }
        if (v !== "clean") adopted = v;
      }
      if (!adopted && attrs && attrs.keys.length) {
        // Attribute keys nothing explains: asked of the realm's user profile,
        // only when there are any. A profile the key may not read (400/403/404 —
        // older Keycloak) leaves every key standing, and says so (a sign of its
        // own: nothing showed the detail is the administrator's); one it cannot
        // vouch for, a 401 or a realm that is unwell is retried.
        const r = await get(`${_adminBase(chosen)}/users/profile`, "attributes_unreadable");
        if (!r) return;
        if (!r.ok && (r.status === 401 || r.status === 429 || r.status >= 500)) {
          _fail(row, claim, "transient", "attributes_unreadable", r.status, now, ctx); return;
        }
        const a = !r.ok ? adminOnlyAttributeKeys(attrs.keys, null)
          : (r.body === undefined || r.body === null ? { malformed: true } : adminOnlyAttributeKeys(attrs.keys, r.body));
        if (a.malformed) { _fail(row, claim, "transient", "attributes_unreadable", r.status, now, ctx); return; }
        if (a.keys.length) { if (r.ok) adopted = "attribute"; else adopted = "attribute_unverified"; }
      }
      if (!adopted) {
        // A credential created since the deletion was scheduled — someone signed
        // the account up for something after the participant was gone. One it
        // already had is ordinary self-use (operator ruling). Dated by the
        // realm's clock against ours, so with CREDENTIAL_CLOCK_MARGIN_MS of lag.
        const r = await get(`${_userUrl(chosen, id)}/credentials`, "credentials_unreadable");
        if (!r) return;
        if (!r.ok) { refusedDetails(r, "credentials_unreadable"); return; }
        const c = credentialsCreatedAfter(r.body, Date.parse(row.pending_since) - CREDENTIAL_CLOCK_MARGIN_MS);
        if (c.malformed) { _fail(row, claim, "transient", "credentials_unreadable", r.status, now, ctx); return; }
        if (c.count > 0) adopted = "credential_after_deletion";
      }
      if (adopted) { _hold(row, claim, "adopted_by_tenant", now, ctx, adopted); return; }
      proveRoles = !_overridden(row, "roles_unreadable");
    }

    // (9) The address holder (`_addressHolder`), asked again after the reads
    // above: handed over to one who became the same person meanwhile, or held.
    if (_addressHolder(row, claim, rep, now, ctx)) return;

    // Everything visible is clean — but Keycloak builds that hide role mappings
    // a key may not view answer 200 without them, and what such a key misses is
    // the realm-management admin roles. The key proves it would see them by
    // seeing that client (POSITIVELY: `access.view === true`). Asked only on the
    // way to a DELETE — after the hand-over above, which removes nothing — and
    // then ALWAYS, never inferred from a role it could see; waived only by a
    // superadmin's `roles_unreadable` override (or an `adopted_by_tenant` one,
    // which answers step 8 whole). A 401 is the token (retried); a refusal, or an
    // answer without the client, cannot prove it: held. The address holder is
    // asked again after it, so a holder who arrived during the probe is seen.
    if (proveRoles) {
      const r = await get(`${_adminBase(chosen)}/clients?clientId=realm-management&first=0&max=1`, "role_visibility_unreadable");
      if (!r) return;
      if (!r.ok && (r.status === 401 || r.status === 429 || r.status >= 500)) {
        _fail(row, claim, "transient", "role_visibility_unreadable", r.status, now, ctx); return;
      }
      const vis = r.ok ? realmManagementVisible(r.body) : false;
      if (vis === null) { _fail(row, claim, "transient", "role_visibility_unreadable", r.status, now, ctx); return; }
      if (!vis) { _hold(row, claim, "roles_unreadable", now, ctx); return; }
      if (_addressHolder(row, claim, rep, now, ctx)) return;
    }

    if (late()) { _fail(row, claim, "transient", "deadline", 0, now, ctx); return; }
    // (10) The synchronous gate. NO await between these checks and the DELETE:
    // a deletion undone, a transfer, a dismissal or a binding that landed during
    // any await above stops it here (a binding record that cannot be read holds
    // it, as at (2)) — and the removal is ANNOUNCED in the same
    // block, so a provisioning job that reaches the account while the DELETE is
    // out waits for the answer instead of linking it. Another removal of it
    // already in flight (a provisioning job's own) means this one is not sent.
    if (!_stillMine(row, claim) || _userExists(row.user_id)) return;
    const lateBinder = _livingBinder(id);
    if (lateBinder) {
      if (lateBinder !== BINDING_UNREADABLE) { _transfer(row, claim, lateBinder, "bound_to_living_account", now, ctx); return; }
      if (!_overridden(row, "binding_unreadable")) { _holdBindingUnreadable(row, claim, now, ctx); return; }
    }
    if (!beginRealmRemoval(id, chosen)) return;
    begun = true;
    let dResp;
    try {
      dResp = await http.fetchWithTimeout(_userUrl(chosen, id), { method: "DELETE", headers: auth });
    } catch (_) {
      settleRealmRemoval(id, "unknown"); begun = false;
      _fail(row, claim, "transient", "delete_unanswered", 0, now, ctx, { soon: true });
      return;
    }
    // (11) The outcome, settled before anything else.
    const ds = dResp.status;
    const outcome = settleRealmRemoval(id, classifyRealmRemoval(ds)); begun = false;
    if (outcome === "removed") {
      // Any link a living participant was given to it meanwhile (a writer the
      // announcement does not stop) is cleared and their set-up queued again.
      const g = accountGoneFromRealm(id, chosen, row.user_id);
      if (g.rekeyedTo || g.bindingsCleared) {
        try {
          log.warn({ cxone_user_id: id, realm: _realmOf(row), bindings_cleared: g.bindingsCleared },
            "CxOne: removed an account a living participant had been linked to meanwhile — the link was cleared and their set-up queued again");
        } catch (e) { swallowed("cxone-withdraw:binding-cleared-log", e); }
      }
      _gone(row, claim, "deleted", ctx, g);
      return;
    }
    if (ds === 403) { _fail(row, claim, "structural", "delete_refused", ds, now, ctx); return; }
    _fail(row, claim, "transient", "delete_failed", ds, now, ctx, { soon: outcome === "unknown" });
  } catch (e) {
    // The exception's name only: its message can quote a response body.
    try { log.warn({ cxone_user_id: id, err: e && e.name }, "CxOne: withdrawal attempt failed unexpectedly"); } catch (e2) { swallowed("cxone-withdraw:attempt-failure-log", e2); }
    try { _fail(row, claim, "transient", "internal", 0, now, ctx); } catch (e2) { swallowed("cxone-withdraw:record-failure", e2); }
  } finally {
    if (begun) { try { settleRealmRemoval(id, "unknown"); } catch (e2) { swallowed("cxone-withdraw:settle-unknown", e2); } }
    try { releaseClaim(db, id, claim); } catch (e2) { swallowed("cxone-withdraw:release-claim", e2); }
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

// The ONE selection predicate. The claim CAS repeats it, so a row the SELECT
// found and the UPDATE no longer matches is simply skipped.
const _SELECTABLE = `pending_since IS NOT NULL AND given_up_at IS NULL
  AND (claim_token IS NULL OR claimed_at < @stale)
  AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cxone_realm_accounts.user_id)`;

// A removal still unresolved past the retention window is SAID, never acted on:
// nothing here writes, deletes or strips a row (the header). It runs AFTER the
// selection loop, inside its own try, so it can never stop a removal. Per row,
// a line is written only for a removal that crossed the window since the
// previous pass's cutoff — a high-water mark, so a clock stepping back
// re-reports nothing. A process's FIRST pass writes ONE line with the count
// instead, so a restart does not read as N new findings. No username, address
// or address fingerprint rides either line.
let _retentionNotedTo = null;
function _notePastRetention(now) {
  try {
    const nowIso = now().toISOString();
    const cutoff = _retentionCutoffIso(nowIso);
    if (cutoff == null) return 0;
    const past = listCxOneWithdrawals({ nowIso }).filter((r) => r.past_retention);
    const prev = _retentionNotedTo;
    _retentionNotedTo = prev != null && Date.parse(prev) > Date.parse(cutoff) ? prev : cutoff;
    if (prev == null) {
      if (past.length) {
        recordOrphanedAuditEvent("cxone", "withdrawals", "cxone_realm_withdrawals_past_retention", "system",
          { count: past.length, retention_days: EVENT_RETENTION_DAYS });
      }
      return past.length;
    }
    const from = Date.parse(prev);
    let n = 0;
    for (const r of past) {
      if (!(Date.parse(r.pending_since) >= from)) continue;
      n++;
      _emit(r, "cxone_realm_withdrawal_past_retention", null, {
        state: r.state, reason: r.reason, pending_since: r.pending_since, retention_days: EVENT_RETENTION_DAYS });
    }
    return n;
  } catch (_) { return 0; }
}

async function runWithdrawals({ now = () => new Date(), limit = RUN_LIMIT } = {}) {
  if (!_healthy()) return { skipped: "unhealthy" };
  const result = { attempted: 0, past_retention: 0 };
  const seen = [];
  while (result.attempted < limit && !_stopping) {
    if (!_healthy()) { result.skipped = "unhealthy"; break; }
    const t = now();
    const params = { now: t.toISOString(), stale: new Date(t.getTime() - STALE_CLAIM_MS).toISOString() };
    const cand = db.prepare(`SELECT cxone_user_id FROM cxone_realm_accounts WHERE ${_SELECTABLE}
      AND cxone_user_id NOT IN (SELECT value FROM json_each(@seen))
      ORDER BY COALESCE(next_attempt_at, pending_since) LIMIT 1`).get({ ...params, seen: JSON.stringify(seen) });
    if (!cand) break;
    seen.push(cand.cxone_user_id);
    const claim = crypto.randomUUID();
    const got = db.prepare(`UPDATE cxone_realm_accounts SET claim_token = @claim, claimed_at = @now
      WHERE cxone_user_id = @id AND ${_SELECTABLE}`).run({ ...params, claim, id: cand.cxone_user_id });
    if (got.changes !== 1) continue;
    const row = db.prepare("SELECT * FROM cxone_realm_accounts WHERE cxone_user_id = ?").get(cand.cxone_user_id);
    if (!row) continue;
    result.attempted++;
    await _withdrawOne(row, claim, now);
  }
  if (_healthy()) result.past_retention = _notePastRetention(now);
  return result;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

// Every claim at boot is a leftover: no job and no run survives a restart.
function clearCxOneWithdrawalClaims() {
  return db.prepare("UPDATE cxone_realm_accounts SET claim_token = NULL, claimed_at = NULL WHERE claim_token IS NOT NULL").run().changes;
}

function startCxOneWithdrawalSweeper({ isHealthy } = {}) {
  if (process.env.NODE_ENV === "test") return;
  _stopping = false;
  configureCxOneWithdrawals({ isHealthy });
  if (_healthy()) {
    // Every boot, idempotent through the primary key, living users only.
    try {
      const r = backfillFromHistory(db, { nowIso: new Date().toISOString() });
      if (r.inserted) log.info({ scanned: r.scanned, inserted: r.inserted }, "CxOne: recorded realm accounts found in the provisioning history");
    } catch (e) {
      try { log.warn({ err: e && e.name }, "CxOne: the realm-account history backfill failed; it will run again at the next boot"); } catch (e2) { swallowed("cxone-withdraw:backfill-failure-log", e2); }
    }
  }
  try { clearCxOneWithdrawalClaims(); } catch (e) { swallowed("cxone-withdraw:clear-claims", e); }
  _kick();
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = setInterval(() => { _kick(); }, SWEEP_INTERVAL_MS);
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}

function stopCxOneWithdrawalSweeper() {
  _stopping = true;
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
  for (const e of _rereads) clearTimeout(e.timer);
  _rereads.clear();
}

// A kick waiting for its turn counts as busy: the graceful-shutdown drain must
// not report "drained" one tick before a run starts.
function cxOneWithdrawalsBusy() { return !!(_running || _deferred); }
async function cxOneWithdrawalsIdle() {
  while (_running || _deferred) { try { await (_running || _deferred); } catch (e) { swallowed("cxone-withdraw:idle-wait", e); } }
}
function cxOneWithdrawalTotals() { return { ..._totals }; }

// ─── The superadmin's list and actions ───────────────────────────────────────

function _stateOf(r) {
  if (r.pending_since == null) return "unmarked";
  if (r.given_up_at) return "given_up";
  if (r.held_reason) return "held";
  if (r.attention) return "needs_attention";
  return "retrying";
}
function _reasonOf(r, state) {
  if (state === "unmarked" || state === "given_up") return state;
  if (state === "held") return r.held_reason;
  if (state === "needs_attention") {
    const code = typeof r.last_error === "string" ? r.last_error.split("/")[1] : null;
    return code && Object.prototype.hasOwnProperty.call(WITHDRAWAL_REMEDY, code) ? code : "transient_stalled";
  }
  return null;
}

// Listed = pending (whatever its state), or unmarked: the user is missing, no
// deletion was recorded, and nothing holds a live claim on it.
const _LISTED = `(r.pending_since IS NOT NULL
  OR (NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)
      AND (r.claim_token IS NULL OR r.claimed_at < @stale)))`;

// "Past retention" has ONE definition, read through this projection by the
// list, the counts, /metrics, the card and the noting pass: the DELETION
// (`pending_since`) is older than EVENT_RETENTION_DAYS — never the record's age
// or the first failure, so an unmarked row never is. A window reaching past
// what a Date can hold gives no cutoff, and then nothing is past it.
function _retentionCutoffIso(nowIso) {
  const ms = Date.parse(nowIso || "");
  const at = new Date((Number.isFinite(ms) ? ms : Date.now()) - EVENT_RETENTION_MS);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}
function _pastRetention(r, cutoffIso) {
  if (r.pending_since == null || cutoffIso == null) return false;
  const p = Date.parse(r.pending_since), c = Date.parse(cutoffIso);
  return Number.isFinite(p) && Number.isFinite(c) && p < c;
}

function _project(r, staleIso, cutoffIso) {
  const state = _stateOf(r);
  const reason = _reasonOf(r, state);
  return {
    cxone_user_id: r.cxone_user_id, user_id: r.user_id,
    iam_origin: r.iam_origin, tenant: r.tenant, realm_confirmed: !!r.realm_confirmed,
    created_username: r.created_username, competition_id: r.competition_id,
    competition_name: r.competition_name == null ? null : r.competition_name,
    provenance: r.provenance, provenance_at: r.provenance_at, recorded_at: r.recorded_at,
    pending_since: r.pending_since, deletion_source: r.deletion_source,
    attempts: r.attempts, first_failed_at: r.first_failed_at, next_attempt_at: r.next_attempt_at,
    last_error: r.last_error, held_reason: r.held_reason, given_up_at: r.given_up_at,
    // What held an adopted account, and those words — only while it is held.
    held_signal: state === "held" && r.held_signal ? r.held_signal : null,
    held_signal_text: state === "held" && r.held_signal ? ADOPTION_SIGNAL_TEXT[r.held_signal] || null : null,
    override_reason: r.override_reason, override_at: r.override_at, transferred_at: r.transferred_at,
    state, reason, remedy: reason ? WITHDRAWAL_REMEDY[reason] || null : null,
    overridable: state === "held" && OVERRIDABLE_HOLDS.includes(r.held_reason),
    in_progress: !!(r.claim_token && r.claimed_at >= staleIso),
    past_retention: _pastRetention(r, cutoffIso),
  };
}

function _staleIso(nowIso) {
  const ms = Date.parse(nowIso || "");
  return new Date((Number.isFinite(ms) ? ms : Date.now()) - STALE_CLAIM_MS).toISOString();
}

function listCxOneWithdrawals({ nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const stale = _staleIso(at), cutoff = _retentionCutoffIso(at);
  return db.prepare(`SELECT r.*, c.name AS competition_name FROM cxone_realm_accounts r
      LEFT JOIN competitions c ON c.id = r.competition_id
      WHERE ${_LISTED}
      ORDER BY COALESCE(r.pending_since, r.recorded_at) DESC, r.cxone_user_id`)
    .all({ stale }).map((r) => _project(r, stale, cutoff));
}

function _listedRow(cxoneUserId, stale) {
  return db.prepare(`SELECT r.*, c.name AS competition_name FROM cxone_realm_accounts r
      LEFT JOIN competitions c ON c.id = r.competition_id
      WHERE r.cxone_user_id = @id AND ${_LISTED}`).get({ id: cxoneUserId, stale }) || null;
}

// Pass the `rows` a response already listed, so one response reads one snapshot.
function cxOneWithdrawalCounts({ nowIso, rows } = {}) {
  const out = { retrying: 0, held: 0, needs_attention: 0, given_up: 0, unmarked: 0, total: 0 };
  for (const r of rows || listCxOneWithdrawals({ nowIso })) { out[r.state]++; out.total++; }
  return out;
}

// Orthogonal to state, so it is never one of the per-state counts above.
function cxOneWithdrawalPastRetentionCount({ nowIso, rows } = {}) {
  return (rows || listCxOneWithdrawals({ nowIso })).filter((r) => r.past_retention).length;
}

// What the header banner counts: every row a human needs to look at.
function cxOneWithdrawalAttentionCount({ nowIso } = {}) {
  const c = cxOneWithdrawalCounts({ nowIso });
  return c.held + c.needs_attention + c.given_up + c.unmarked;
}

const _NOT_FOUND = { status: 404, code: "cxone_withdrawal_not_found", error: "That Checkmarx One account is not waiting to be removed." };
const _IN_PROGRESS = { status: 409, code: "cxone_withdrawal_in_progress", error: "The platform is working on that account right now. Try again in a minute." };

// v8.13.1 (external audit) — A "REMOVE ANYWAY" OVERRULES ONE NAMED HOLD, never
// whatever the row happens to be held for when the request lands. Two
// superadmins can open the list together: the first approval sends the row back
// to the runner, which can stop at a DIFFERENT hold (the adoption check passes,
// then the address check holds it) — and the second, stale confirmation used to
// override that new hold too, though its confirm quoted the old reason and
// nobody had read the new one (reproduced through this helper). The caller says
// which hold its human read (`expectedHold`); anything else is refused, and the
// row as it stands now goes back so the list can show the new reason. Required,
// not optional: an override that does not say what it overrides is refused
// rather than guessed at (an old page left open across this release reloads).
// The sign it read too (`expectedSignal`, `held_signal` or none): the confirm
// quotes it, so an account held again for another sign is a different decision.
const _EXPECTED_HOLD_REQUIRED = { status: 400, code: "cxone_withdrawal_expected_hold_required",
  error: "Reload the page, read the reason the platform is holding this account, then decide again." };

function retryCxOneWithdrawal(cxoneUserId, { override = false, expectedHold, expectedSignal, actorId = null, nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const stale = _staleIso(at), cutoff = _retentionCutoffIso(at);
  const r = _listedRow(cxoneUserId, stale);
  if (!r) return { ..._NOT_FOUND };
  if (r.claim_token && r.claimed_at >= stale) return { ..._IN_PROGRESS };
  const held = r.held_reason;
  if (override) {
    if (typeof expectedHold !== "string" || !expectedHold) return { ..._EXPECTED_HOLD_REQUIRED };
    if (expectedHold !== held || (expectedSignal || null) !== (r.held_signal || null)) {
      return { status: 409, code: "cxone_withdrawal_hold_changed",
        error: !held
          ? "This account changed after you read it: the platform is no longer holding it for that reason. Check the list, then decide again."
          : expectedHold === held
            ? "This account changed after you read it: the platform now holds it for something else it found. Read what it found, then decide again."
            : "This account changed after you read it: the platform now holds it for a different reason. Read the new reason, then decide again.",
        row: _project(r, stale, cutoff) };
    }
  }
  if (override && !(held && OVERRIDABLE_HOLDS.includes(held))) {
    return { status: 409, code: "cxone_withdrawal_not_overridable",
      error: held === "provenance_unconfirmed"
        ? "The platform cannot confirm it created this account, so it will not remove it. Remove it in the tenant by hand, then Mark removed."
        : "This account is not held for a reason that can be overridden." };
  }
  const unmarked = r.pending_since == null;
  // An override is REMEMBERED alongside earlier ones, so overriding a second
  // hold does not bring the first back on the next run.
  let overrideReason = r.override_reason;
  if (override) {
    const set = typeof overrideReason === "string" && overrideReason ? overrideReason.split(",") : [];
    if (!set.includes(held)) set.push(held);
    overrideReason = set.join(",");
  }
  const instanceOverride = override && (held === "instance_mismatch" || held === "instance_unconfirmed");
  const upd = db.prepare(`UPDATE cxone_realm_accounts SET
      pending_since = CASE WHEN @unmarked THEN @at ELSE pending_since END,
      deletion_source = CASE WHEN @unmarked THEN 'superadmin' ELSE deletion_source END,
      instance_origin = CASE WHEN @instance THEN @origin ELSE instance_origin END,
      next_attempt_at = @at, given_up_at = NULL, attempts = 0, first_failed_at = NULL,
      held_reason = NULL, held_signal = NULL, attention = 0,
      override_reason = CASE WHEN @override THEN @overrideReason ELSE override_reason END,
      override_by = CASE WHEN @override THEN @actor ELSE override_by END,
      override_at = CASE WHEN @override THEN @at ELSE override_at END
    WHERE cxone_user_id = @id AND (claim_token IS NULL OR claimed_at < @stale)`).run({
    unmarked: unmarked ? 1 : 0, at, instance: instanceOverride ? 1 : 0, origin: _currentOrigin(),
    override: override ? 1 : 0, overrideReason, actor: actorId == null ? null : String(actorId),
    id: cxoneUserId, stale,
  });
  if (upd.changes !== 1) return { ..._IN_PROGRESS };
  scheduleRealmWithdrawal();
  const fresh = _listedRow(cxoneUserId, stale);
  return { ok: true, row: fresh ? _project(fresh, stale, cutoff) : null, overridden: override ? held : null };
}

function dismissCxOneWithdrawal(cxoneUserId, { nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const stale = _staleIso(at), cutoff = _retentionCutoffIso(at);
  const r = _listedRow(cxoneUserId, stale);
  if (!r) return { ..._NOT_FOUND };
  if (r.claim_token && r.claimed_at >= stale) return { ..._IN_PROGRESS };
  const del = db.prepare(`DELETE FROM cxone_realm_accounts WHERE cxone_user_id = ?
    AND (claim_token IS NULL OR claimed_at < ?)`).run(cxoneUserId, stale);
  if (del.changes !== 1) return { ..._IN_PROGRESS };
  return { ok: true, row: _project(r, stale, cutoff) };
}

module.exports = {
  // constants
  PARKED, PROVENANCE_WINDOW, CREDENTIAL_CLOCK_MARGIN_MS, OVERRIDABLE_HOLDS, WITHDRAWAL_REMEDY, ADOPTION_SIGNAL_TEXT, ADDRESS_HOLDERS_SQL,
  // configuration and the run
  configureCxOneWithdrawals, _autorunAllowed, scheduleRealmWithdrawal, runWithdrawals,
  armUnansweredRemovalReread, _armedRereadsForTest, _fireArmedRereadsForTest,
  startCxOneWithdrawalSweeper, stopCxOneWithdrawalSweeper,
  cxOneWithdrawalsBusy, cxOneWithdrawalsIdle, cxOneWithdrawalTotals,
  // the superadmin's list and actions
  listCxOneWithdrawals, cxOneWithdrawalCounts, cxOneWithdrawalPastRetentionCount, cxOneWithdrawalAttentionCount,
  retryCxOneWithdrawal, dismissCxOneWithdrawal,
};
