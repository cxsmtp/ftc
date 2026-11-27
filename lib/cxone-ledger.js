"use strict";
//
// v8.12.7 — THE CHECKMARX ONE REALM-ACCOUNT LEDGER.
//
// Erasing a participant here never reached the customer's Checkmarx One realm:
// `deleteUserCascade` (lib/account-reaper.js) deletes `user_events` and
// `competition_users`, which were the only two local records that a realm
// account had ever been bound, and the only proof that THIS platform created
// one was `_createdHereId`, a function local inside `cxOneProvisionUser`. So a
// deletion after provisioning had finished left nothing that could address the
// account it made.
//
// `cxone_realm_accounts` is that record, written at the moment of creation and
// deliberately OUTSIDE everything the cascade deletes. A row says "this
// platform created realm account X for local user U"; the cascade stamps the
// row pending, and lib/cxone-withdraw.js removes the realm account later.
//
// PURE AT MODULE SCOPE, and that is load-bearing. It requires nothing (the
// lib/staff-compete.js shape) and every function takes `db` as an argument, so:
//   • db.js can require it for the DDL without acquiring a dependency — db.js
//     must stay free of lib/config (v8.8.26), and this module reaches nothing;
//   • lib/account-reaper.js can call `stampDeletionForUser` inside its cascade
//     transaction without a require cycle;
//   • a spec drives every function against an in-memory database at column 0,
//     with no server and no data directory.
//
// WHAT A ROW DOES NOT MEAN. It is never evidence that an account may be
// deleted on its own: the withdrawal runner re-proves provenance against the
// realm's own record before any DELETE, and a row is acted on only once an
// explicit deletion STAMPED it (`pending_since`). A missing `users` row is not
// a stamp — see the runner.
//

// A Keycloak local user's id is a random UUID. Anything else on a Location
// header is not an id this platform can later prove it made, so it never
// enters the ledger.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ONE definition of the table, executed by db.js at boot and by the unit
// spec against an in-memory database, so the two cannot disagree.
//
//   • NO FOREIGN KEY, on purpose. A row must survive `deleteUserCascade`
//     (users) and the event-retention purge (user_events): it is the record
//     that outlives exactly those deletions. A reference would either cascade
//     the row away or refuse the erasure.
//   • Almost none of it is in lib/schema-required.js, deliberately: that
//     manifest decides about columns an ALTER adds and UNIQUE indexes, and the
//     table's key is the PRIMARY KEY inside the CREATE and both indexes are
//     plain. The exceptions are the columns added after the table first shipped
//     — `created_email_sha`, `created_baseline` and `held_signal` — which db.js
//     ALTERs onto an older table; each ALTER is listed as REQUIRED (a write names
//     the column). db.js runs the CREATE and the ALTERs in a FATAL block (no
//     try/catch), so a server whose ledger is missing never starts rather than
//     creating realm accounts it cannot later withdraw.
//   • `created_email_sha` is the sha256 (hex) of the lowercased address the
//     create sent — NEVER the address itself. The runner holds an account whose
//     realm address no longer hashes to it: the tenant changed it, so someone
//     may be using the account outside this platform. NULL (a backfilled row,
//     or one recorded before the column existed) skips that one check.
//   • `created_baseline` is what the account carried when the job that created
//     it finished — role IDS and attribute NAMES only, no value, name or address
//     (lib/cxone-identity.js `buildCreationBaseline`) — so the runner does not
//     read the realm's own creation-time defaults as the tenant's doing. NULL
//     (backfilled, older, or a failed read) judges by the rules alone.
//   • `held_signal` names what made the runner hold an account as adopted by the
//     tenant (a fixed token, never a value), for the superadmin who decides.
//   • NOT exported by the participant export: rows key on local user ids, and
//     an import mints fresh ones, so an exported row would point at nobody —
//     or, worse, at whoever received that id on the target.
//   • THE PRIMARY KEY IS `cxone_user_id` ALONE. Keycloak ids are random UUIDs,
//     so the realm is ordinary columns plus `realm_confirmed`, and a re-run
//     backfill cannot create a second row for the same account.
const CXONE_REALM_ACCOUNTS_DDL = `
  CREATE TABLE IF NOT EXISTS cxone_realm_accounts (
    cxone_user_id    TEXT PRIMARY KEY,
    iam_origin       TEXT,
    tenant           TEXT,
    realm_confirmed  INTEGER NOT NULL DEFAULT 0,
    user_id          TEXT NOT NULL,
    competition_id   TEXT,
    created_username TEXT NOT NULL,
    provenance       TEXT NOT NULL CHECK (provenance IN ('created','history')),
    provenance_at    TEXT NOT NULL,
    instance_origin  TEXT,
    recorded_at      TEXT NOT NULL,
    pending_since    TEXT,
    deletion_source  TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    first_failed_at  TEXT,
    next_attempt_at  TEXT,
    last_error       TEXT,
    held_reason      TEXT,
    attention        INTEGER NOT NULL DEFAULT 0,
    override_reason  TEXT,
    override_by      TEXT,
    override_at      TEXT,
    transferred_at   TEXT,
    claim_token      TEXT,
    claimed_at       TEXT,
    given_up_at      TEXT,
    created_email_sha TEXT,
    created_baseline TEXT,
    held_signal      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cxone_realm_accounts_user ON cxone_realm_accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_cxone_realm_accounts_pending ON cxone_realm_accounts(pending_since) WHERE pending_since IS NOT NULL;
`;

const _lower = (s) => (typeof s === "string" ? s.toLowerCase() : "");
// What a `created_email_sha` looks like. Anything else is stored as NULL — a
// value this module cannot vouch for would make the runner hold (or, worse,
// pass) on a comparison against garbage.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Record an account THIS job created (a 201 whose Location carried a UUID).
// The row is born claimed by the job, so the withdrawal runner cannot act on
// it while the job that made it is still running. INSERT OR IGNORE, so the
// answer is OWNERSHIP: true only when THIS call wrote the row. A job that did
// not write it must not later delete or release it.
// `createdEmailSha` is the fingerprint lib/cxone.js computes from the address
// its create sent (`createdEmailSha()` there — one definition, shared with the
// runner that compares against it); this module requires nothing, so it only
// validates the shape.
function recordCreated(db, { cxoneUserId, iamOrigin, tenant, userId, competitionId, username,
                             provenanceAt, instanceOrigin, claim, nowIso, createdEmailSha }) {
  if (typeof cxoneUserId !== "string" || !UUID_RE.test(cxoneUserId)) return false;
  const emailSha = typeof createdEmailSha === "string" && SHA256_HEX_RE.test(createdEmailSha) ? createdEmailSha : null;
  const r = db.prepare(`INSERT OR IGNORE INTO cxone_realm_accounts
      (cxone_user_id, iam_origin, tenant, realm_confirmed, user_id, competition_id, created_username,
       provenance, provenance_at, instance_origin, recorded_at, claim_token, claimed_at, created_email_sha)
      VALUES (?, ?, ?, 1, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`)
    .run(cxoneUserId, iamOrigin || null, tenant || null, userId, competitionId || null, _lower(username),
         provenanceAt || nowIso, instanceOrigin || null, nowIso, claim || null, claim ? nowIso : null, emailSha);
  return r.changes === 1;
}

// The creation baseline (lib/cxone-identity.js) of the account a job created,
// written at the end of that job. Bound to the job's claim AND to its owner, and
// written once: a row `transferTo` re-keyed meanwhile (which ends every claim)
// is never written, and a second write changes nothing. A value this module
// cannot vouch for — not a version-1 JSON object, or oversized — is not written.
const BASELINE_MAX_TEXT = 32768;
function recordCreationBaseline(db, cxoneUserId, claim, { userId, baseline }) {
  _requireOwner(userId);
  if (typeof baseline !== "string" || baseline.length > BASELINE_MAX_TEXT) return 0;
  let o;
  try { o = JSON.parse(baseline); } catch (_) { return 0; }
  if (!o || typeof o !== "object" || Array.isArray(o) || o.v !== 1) return 0;
  return db.prepare(`UPDATE cxone_realm_accounts SET created_baseline=?
      WHERE cxone_user_id=? AND claim_token=? AND user_id=? AND created_baseline IS NULL`)
    .run(baseline, cxoneUserId, claim, userId).changes;
}

// Release a claim — only the holder's. A compare-and-swap on the token, so a
// stale holder cannot free a row somebody else has since claimed.
function releaseClaim(db, cxoneUserId, claim) {
  return db.prepare("UPDATE cxone_realm_accounts SET claim_token=NULL, claimed_at=NULL WHERE cxone_user_id=? AND claim_token=?")
    .run(cxoneUserId, claim).changes;
}

// v8.13.1 (external audit) — BOTH WRITES BELOW ARE BOUND TO THE OWNER AS WELL AS
// THE CLAIM. A claim says which run may act on the row; it never said on whose
// behalf. An account re-keyed to a living participant mid-run (`transferTo`)
// used to keep the old run's claim, so the run that resumed afterwards deleted
// the row the living participant now owned — and, in the provisioning job, the
// account with it (reproduced with two real provisioning calls). `transferTo`
// now ends every claim, and these two refuse a row whose owner is not the one
// the caller is acting for: either alone would close it; together a future
// writer that forgets one is still caught by the other. `userId` is REQUIRED —
// a caller that does not say whose row it means gets an error, never a match.
function _requireOwner(userId) {
  if (typeof userId !== "string" || !userId) throw new TypeError("cxone-ledger: the owner's user id is required");
}

// Remove the row once its account is gone — only under the caller's own claim,
// and only while the row is still the caller's participant's.
function deleteOwned(db, cxoneUserId, claim, userId) {
  _requireOwner(userId);
  return db.prepare("DELETE FROM cxone_realm_accounts WHERE cxone_user_id=? AND claim_token=? AND user_id=?")
    .run(cxoneUserId, claim, userId).changes;
}

// The realm ANSWERED that this account is gone (a DELETE's 2xx/404, or a read's
// 404) after its row had been re-keyed to a living participant (`transferTo`)
// — a row naming an account that no longer exists. Allowed ONLY on that answer
// (lib/cxone.js `accountGoneFromRealm`), and bound to the owner the caller read,
// like the deletes around it: a row re-keyed again since is left alone.
function forgetGoneAccount(db, cxoneUserId, ownerUserId) {
  _requireOwner(ownerUserId);
  return db.prepare("DELETE FROM cxone_realm_accounts WHERE cxone_user_id=? AND user_id=?")
    .run(cxoneUserId, ownerUserId).changes;
}

// The provisioning job's in-flight withdrawal (its participant was deleted
// mid-flight) was refused. Hand the row to the runner: stamp it pending if the
// cascade has not already, count the attempt, and schedule the retry. Every
// COALESCE keeps the first answer — a cascade stamp that got there first stays
// the recorded source. `lastError` is a status/code pair, never a body.
function markInFlightRefusal(db, cxoneUserId, claim, { nowIso, nextIso, lastError, userId }) {
  _requireOwner(userId);
  return db.prepare(`UPDATE cxone_realm_accounts SET
      pending_since=COALESCE(pending_since, ?), deletion_source=COALESCE(deletion_source, 'in_flight'),
      attempts=attempts+1, first_failed_at=COALESCE(first_failed_at, ?), next_attempt_at=?, last_error=?
      WHERE cxone_user_id=? AND claim_token=? AND user_id=?`)
    .run(nowIso, nowIso, nextIso, lastError || null, cxoneUserId, claim, userId).changes;
}

// v8.13.1 (external audit) — the provisioning job DECLINED to withdraw the account
// it created (its participant was deleted mid-flight, but a living participant may
// now hold the account — `_withdrawalOwnershipLost` in lib/cxone.js). The runner
// owns that decision, and only selects a row that carries a deletion marker. The
// cascade stamps every row its participant owned AT THE DELETION — so a job whose
// create was answered AFTER the erasure records a row the cascade never saw, and
// without this it would be listed "unmarked" for ever, never re-asked. Stamped
// here as pending (COALESCE: a cascade stamp that got there first stays the
// recorded source), with NO attempt charged — nothing was tried — and due at once.
// Bound to the claim and to the erased owner, like its two siblings above, so a
// row re-keyed to a living participant meanwhile is left alone.
function markInFlightSkip(db, cxoneUserId, claim, { nowIso, userId }) {
  _requireOwner(userId);
  return db.prepare(`UPDATE cxone_realm_accounts SET
      pending_since=COALESCE(pending_since, ?), deletion_source=COALESCE(deletion_source, 'in_flight'),
      next_attempt_at=NULL
      WHERE cxone_user_id=? AND claim_token=? AND user_id=?`)
    .run(nowIso, cxoneUserId, claim, userId).changes;
}

// The account turned out to belong to a LIVING participant (a 409 email match
// during their provisioning, or the runner found the same person holding the
// address). It is theirs now: re-key the row to them and forget every trace of
// the withdrawal, so nothing later removes an account somebody is using.
// A transfer to the user who ALREADY owns the row is a no-op (`user_id IS NOT
// ?`): the provisioning path calls this on every accepted match, including a
// participant's own account on a second event, and stamping `transferred_at`
// there would report a hand-over that never happened.
// Deliberately IGNORES the claim when deciding — a transfer is always safe to
// apply — and ENDS it (v8.13.1): a claim is a run's licence to act on the
// account for the participant who was deleted, and the account is no longer
// theirs. The runner re-checks `user_id` after every await (`_stillMine`), so a
// transfer landing under its claim makes it stand down; the provisioning job
// that created the account has no such re-check after its last await, and it
// used to delete the transferred row (and the account) under the claim it still
// held. See `deleteOwned` for the second half of that fix.
//
// THE NEW OWNER MUST STILL EXIST, IN THE SAME STATEMENT (pre-release review).
// The provisioning path calls this after `await searchResp.json()`, and a
// participant erased DURING that read was still handed the row: its pending
// stamp was cleared and it was re-keyed to a user who no longer exists — an
// erased person's account with no deletion record, listed "unmarked" and never
// acted on. The EXISTS is atomic with the UPDATE, so no caller can re-open the
// window by checking first and writing later.
function transferTo(db, cxoneUserId, livingUserId, nowIso) {
  return db.prepare(`UPDATE cxone_realm_accounts SET
      user_id=?, pending_since=NULL, deletion_source=NULL, attempts=0, first_failed_at=NULL,
      next_attempt_at=NULL, last_error=NULL, held_reason=NULL, held_signal=NULL, given_up_at=NULL,
      override_reason=NULL, override_by=NULL, override_at=NULL, attention=0, transferred_at=?,
      claim_token=NULL, claimed_at=NULL
      WHERE cxone_user_id=? AND user_id IS NOT ? AND EXISTS (SELECT 1 FROM users WHERE id = ?)`)
    .run(livingUserId, nowIso, cxoneUserId, livingUserId, livingUserId).changes;
}

function _likeEscape(s) { return String(s).replace(/[\\%_]/g, (c) => "\\" + c); }

// What `livingBinder` answers when a LIVING participant's provisioning record
// names this account in its text but cannot be read as the record it claims to
// be — not JSON, or JSON that is not an object. Such a record may be the one
// that makes the account theirs, and nothing can say, so it is not "nobody"
// (CLAUDE.md: fail closed on what cannot be read): the runner holds the account
// for a superadmin (`binding_unreadable`) and the provisioning job's in-flight
// withdrawal skips its DELETE. It is not "somebody" either: nobody is handed an
// account on evidence no one can read.
//
// A Symbol, deliberately. It is truthy, so a caller that only asks "is anybody
// bound?" stops rather than removes; and it is never an id — binding it to a
// statement or building a string from it throws — so a caller that took it for
// one (and would hand the account over to it) fails loudly instead. The module
// still requires nothing: the callers, which log and audit, say it.
const BINDING_UNREADABLE = Symbol("binding_unreadable");

// A set-up record's stored details as the object they must be, or null when
// they cannot be read: NULL, empty, not JSON, or JSON that is not a plain object
// (null, a number, a string, an array). The one definition the ledger's two
// fail-closed readers share, `livingBinder` and `accountsOutsideLedger`. It is
// the ledger's own, not lib/audit.js `parseStoredDetails` (the reader for every
// surface that SHOWS details): this module is pure, and lib/audit.js opens the
// database at require time.
function _recordObject(text) {
  if (typeof text !== "string" || text === "") return null;
  let d;
  try { d = JSON.parse(text); } catch (_) { return null; }
  return d && typeof d === "object" && !Array.isArray(d) ? d : null;
}

// A LIVING participant bound to this realm account locally — by an event
// binding (`competition_users.cxone_user_id`), or by their own provisioning
// history naming the id. Either makes the account theirs to keep, and nothing
// may remove it from the realm. The ONE definition (v8.13.1), read by the
// withdrawal runner AND by the provisioning job's own in-flight withdrawal,
// which had no such question at all — so a job whose participant was erased
// deleted an account a replacement participant had just been bound to.
// The second half is a LIKE scan over `user_events` (measured ~146 ms on a
// million rows), so callers ask it only where the safety argument needs it.
//
// Answers the binder's user id, `BINDING_UNREADABLE`, or null. A readable
// record naming the account wins over an unreadable one, whatever the order:
// it is positive evidence, and a hand-over removes nothing. Only the binding's
// own top-level `cxone_user_id` binds; a readable record that names the id
// elsewhere (nested) binds nobody.
function livingBinder(db, cxoneUserId) {
  if (typeof cxoneUserId !== "string" || !cxoneUserId) return null;
  const cu = db.prepare(`SELECT cu.user_id FROM competition_users cu JOIN users u ON u.id = cu.user_id
    WHERE cu.cxone_user_id = ? LIMIT 1`).get(cxoneUserId);
  if (cu) return cu.user_id;
  const pat = "%" + _likeEscape('"cxone_user_id":' + JSON.stringify(cxoneUserId)) + "%";
  const rows = db.prepare(`SELECT user_id, details FROM user_events
    WHERE event_type = 'cxone_provisioned' AND user_id IN (SELECT id FROM users) AND details LIKE ? ESCAPE '\\'`).all(pat);
  let unreadable = false;
  for (const r of rows) {
    const d = _recordObject(r.details);
    if (!d) { unreadable = true; continue; }
    if (d.cxone_user_id === cxoneUserId) return r.user_id;
  }
  return unreadable ? BINDING_UNREADABLE : null;
}

// The explicit deletion record. Called INSIDE `deleteUserCascade`'s
// transaction, so the erasure and the stamp commit together or not at all — a
// best-effort stamp after commit would lose an erasure on a crash, silently.
// COALESCE, so a second deletion path (the in-flight refusal) never rewrites
// the first answer. Returns how many accounts were scheduled for withdrawal.
function stampDeletionForUser(db, userId, nowIso, source) {
  return db.prepare(`UPDATE cxone_realm_accounts SET
      pending_since=COALESCE(pending_since, ?), deletion_source=COALESCE(deletion_source, ?)
      WHERE user_id=?`)
    .run(nowIso, source, userId).changes;
}

// The realm accounts this participant was bound to that the ledger does NOT
// hold — i.e. that deleting them will leave in the realm — split by WHO MADE
// THEM, because the two call for different people (pre-release review: one
// number, reported as "already existed in the tenant", told a superadmin that
// the tenant's administrator decides about accounts THIS platform created).
// Read from their own `cxone_provisioned` history BEFORE the cascade deletes it.
//
//   • leftInPlace — MATCHED accounts: the create answered 409
//     (`already_existed: true`). They predate us, so the tenant's
//     administrator decides about them (the operator's ruling).
//   • unrecorded — accounts the platform CREATED (`already_existed: false`,
//     our own POST answered 2xx) that the ledger does not hold: made before
//     v8.8.15 recorded any id, made by a pre-v8.12.7 job, or made by a 201 whose
//     Location named nothing (found again by search, hence a `matched_by` key —
//     which is why `already_existed` and not `matched_by` decides). Nothing
//     proves which realm account they are, so they cannot be removed
//     automatically, and they are NOT the tenant's.
//   • A row with no `already_existed` at all (never written since v4.0.0) is
//     classified by `matched_by`, and without it counted as unrecorded — the
//     answer that sends a human to look rather than tells them not to.
//
// One account, counted once: keyed on the id, or on the username where no id
// was recorded — and an id-less row folds into an id-bearing row of the same
// username (a pre-v8.8.15 create met again, by id, on a later event). An
// account ANY row says we created is counted as created. An id the ledger
// holds is not counted at all: it is scheduled, not left. Nor is one a LATER
// `cxone_binding_cleared` names: the platform removed it from the realm, so it
// is not left there (the history row that bound it is never edited).
//
//   • unreadable — `cxone_provisioned` RECORDS `_recordObject` cannot read, or
//     whose `success` is not a boolean (every record the code writes carries
//     one). Such a record may name a failed set-up, a matched account, one the
//     ledger is already removing, or one created and never recorded, and nothing
//     can say which, so it is counted apart (never folded into `unrecorded`,
//     whose copy says the platform made the account) and per record, as it
//     cannot be keyed to an account. Fail closed: someone checks the tenant.
//   • An unreadable `cxone_binding_cleared` is ignored: it subtracts nothing and
//     is not counted. It can only name an account the platform removed, so
//     ignoring it can only leave counted one already gone: a damaged record
//     makes the counts over-state rather than under-state.
function accountsOutsideLedger(db, userId) {
  const rows = db.prepare(`SELECT event_type, details FROM user_events
      WHERE user_id=? AND event_type IN ('cxone_provisioned','cxone_binding_cleared') ORDER BY changed_at, rowid`).all(userId);
  const inLedger = db.prepare("SELECT 1 FROM cxone_realm_accounts WHERE cxone_user_id=?");
  let recs = [];
  let unreadable = 0;
  for (const r of rows) {
    const d = _recordObject(r.details);
    if (r.event_type === "cxone_binding_cleared") {
      if (d && typeof d.cleared_cxone_user_id === "string" && d.cleared_cxone_user_id) recs = recs.filter((x) => x.id !== d.cleared_cxone_user_id);
      continue;
    }
    if (!d || typeof d.success !== "boolean") { unreadable++; continue; }
    if (d.success !== true) continue;
    const id = typeof d.cxone_user_id === "string" && d.cxone_user_id ? d.cxone_user_id : null;
    const created = d.already_existed === false ? true
      : d.already_existed === true ? false
      : !("matched_by" in d);
    recs.push({ id, name: _lower(d.username), created });
  }
  // username -> the id an id-bearing row gave it, for the fold.
  const idByName = new Map();
  for (const x of recs) if (x.id && x.name && !idByName.has(x.name)) idByName.set(x.name, x.id);
  const createdByKey = new Map();
  for (const x of recs) {
    const key = x.id || (x.name && idByName.get(x.name)) || `name:${x.name}`;
    createdByKey.set(key, (createdByKey.get(key) || false) || x.created);
  }
  let leftInPlace = 0, unrecorded = 0;
  for (const [key, created] of createdByKey) {
    if (!key.startsWith("name:") && inLedger.get(key)) continue;
    if (created) unrecorded++; else leftInPlace++;
  }
  return { leftInPlace, unrecorded, unreadable };
}

// WHAT A PERSON'S DELETION REPORTS ABOUT THEIR CHECKMARX ONE ACCOUNTS — the one
// definition, built by `deleteUserCascade` (lib/account-reaper.js) for every
// deletion, so the admin's DELETE (its `deleted` record and toast) and the
// unverified-account reaper (its `account_reaped` record) cannot report
// differently. `outside` is `accountsOutsideLedger`, read BEFORE the cascade
// deletes the history it reads; `scheduled` is the stamp's count. Each key only
// when non-zero, and COUNTS ONLY: an id would be a realm handle for an erased
// person, and a damaged record's text may hold their username.
function cxoneDeletionCounts(outside, scheduled) {
  const o = outside || {};
  return {
    ...(scheduled ? { cxone_withdrawals_scheduled: scheduled } : {}),
    ...(o.leftInPlace ? { cxone_accounts_left_in_place: o.leftInPlace } : {}),
    ...(o.unrecorded ? { cxone_accounts_unrecorded: o.unrecorded } : {}),
    ...(o.unreadable ? { cxone_records_unreadable: o.unreadable } : {}),
  };
}

// BACKFILL — accounts created BEFORE this ledger existed, recovered from the
// `cxone_provisioned` history of participants who are still alive.
//
// THE PROOF THAT A QUALIFYING ROW NAMES AN ACCOUNT THIS PLATFORM CREATED.
//   • From v8.8.15 (269d687d, when `cxone_user_id` first rode the event) to
//     this release, `cxOneProvisionUser` sets `cxUserId` in exactly two places:
//     from the Location header of its OWN create response (`cxUserId =
//     locMatch[1]`), which emits no `matched_by`, and from the search fallback
//     (`cxUserId = accepted.id`), which ALWAYS emits `matched_by`. Checked
//     against every revision of lib/cxone.js in that range.
//   • A 409 sets `already_existed: true`; a failure writes `success: false`.
//   • So `success === true && already_existed === false && no matched_by && a
//     UUID id` is precisely "the id came off our own 201". A row from before
//     v8.8.15 carries no id and cannot qualify — the honest answer.
//   • `competition_users.cxone_user_id` is deliberately NOT a source: it does
//     not record HOW the account was reached, so it may be a matched account
//     that belongs to somebody in the customer's tenant.
//
// A backfilled row is weaker than a recorded one, and says so: `provenance =
// 'history'`, `realm_confirmed = 0` (the event never recorded which realm) and
// `instance_origin = NULL` (nor which deployment — a copied database would
// otherwise act for the instance it was copied from). The runner therefore
// needs a superadmin's confirmation before it withdraws one.
//
// Idempotent through the primary key, so it runs at every boot; earliest event
// first, so `provenance_at` is the creation. Living users only: a deleted
// user's history is gone with the cascade, and an orphaned event proves no
// deletion record — acting on it is the inference the runner refuses.
function backfillFromHistory(db, { nowIso }) {
  const sel = db.prepare(`SELECT user_id, changed_at, details FROM user_events
      WHERE event_type='cxone_provisioned' AND user_id IN (SELECT id FROM users)
      ORDER BY changed_at, rowid`);
  const ins = db.prepare(`INSERT OR IGNORE INTO cxone_realm_accounts
      (cxone_user_id, iam_origin, tenant, realm_confirmed, user_id, competition_id, created_username,
       provenance, provenance_at, instance_origin, recorded_at)
      VALUES (?, NULL, NULL, 0, ?, ?, ?, 'history', ?, NULL, ?)`);
  let scanned = 0, inserted = 0;
  // `.immediate()`: a read-then-write transaction takes the write lock at BEGIN,
  // so an operator's sqlite3 session holding it makes the boot WAIT out
  // busy_timeout rather than fail SQLITE_BUSY at the upgrade (CLAUDE.md, The
  // driver). The read is inside, so the living-user set and the inserts are one
  // snapshot.
  db.transaction(() => {
    const rows = sel.all();
    scanned = rows.length;
    for (const r of rows) {
      let d;
      try { d = JSON.parse(r.details || "null"); } catch (_) { continue; }
      if (!d || typeof d !== "object") continue;
      if (d.success !== true || d.already_existed !== false || ("matched_by" in d)) continue;
      if (typeof d.cxone_user_id !== "string" || !UUID_RE.test(d.cxone_user_id)) continue;
      const competitionId = typeof d.competition_id === "string" && d.competition_id ? d.competition_id : null;
      inserted += ins.run(d.cxone_user_id, r.user_id, competitionId, _lower(d.username), r.changed_at, nowIso).changes;
    }
  }).immediate();
  return { scanned, inserted };
}

module.exports = {
  UUID_RE,
  CXONE_REALM_ACCOUNTS_DDL,
  recordCreated,
  recordCreationBaseline,
  releaseClaim,
  deleteOwned,
  markInFlightRefusal,
  markInFlightSkip,
  forgetGoneAccount,
  transferTo,
  livingBinder,
  BINDING_UNREADABLE,
  stampDeletionForUser,
  accountsOutsideLedger,
  cxoneDeletionCounts,
  backfillFromHistory,
};
