"use strict";

// Unverified-account reaper (v7.6.0). Periodically deletes ABANDONED, never-
// verified self-registrations older than 48 h, so an inbox typo or a walk-away
// sign-up doesn't squat a nickname / email forever.
//
// WHO IT STILL SERVES. Every door that creates an account today (an emailed-code
// sign-up, an invitation, the desk, Users & roles) creates it verified, so the
// reaper — like the verification link, the 48-hour grace and the "Verify email"
// chip — acts only on accounts still unverified from before email-first and on
// accounts a participant import marks unverified (`verified: 0`, kept so an
// operator can force re-verification). Kept for them by operator ruling,
// 14 Nov 2026; retiring it is a release of its own (AUTH_PATHS.md §4b).
//
// Every OTHER account class is preserved by the gate below:
//   • once-verified accounts      → first_verified_at IS NOT NULL (never cleared)
//   • currently-verified accounts → verified=1
//   • a pending join / a desk-code grace → pending_self_enroll_comp_id / self_enroll_grace_until set
//   • invited accounts            → invitation_id set
//   • admin-touched accounts      → approved=1 (admin approval) — also covers import
//   • LinkedIn / operator accounts→ registered_via != 'manual'
//   • blocked / denied accounts   → kept as tombstones
//   • admins / superadmins        → role guard
// A one-release grandfather FLOOR (settings.account_reaper_floor_at, the deploy
// time) means accounts predating the feature are never swept. See AUTH_PATHS.md.
//
// Direction: account-reaper → { db, time, audit, me-cache, user-tags,
// participants-cache, sessions, leaderboard, sanitise, event-admin, cxone-ledger,
// log }.
// Nothing in those may require account-reaper. lib/email does not require it;
// were it to, nothing reachable from here could require lib/email.
// (lib/event-admin requires nothing at module scope — every dependency it has
// is a lazy require inside a function — so it cannot close a cycle; nor does
// lib/cxone-ledger, which is pure.) v8.12.7 adds ONE lazy require, of
// lib/cxone-withdraw, inside deleteUserCascade after the commit: that module
// reaches lib/cxone → lib/http and lib/audit and never lib/email, so the rule
// above still holds — check it again before widening either graph.

const db = require("../db");
const { swallowed } = require("./best-effort");
const { now } = require("./time");
const { recordOrphanedAuditEvent } = require("./audit");
const { _invalidateMeCache } = require("./me-cache");
const { _invalidateUserTagsCache } = require("./user-tags");
const { invalidateAdminParticipantsCache } = require("./participants-cache");
const { invalidateOtherSessions, SESSION_END } = require("./sessions");
const { invalidateLeaderboardCache } = require("./leaderboard");
const { deleteAvatarImage } = require("./sanitise");
const { invalidateEventAdminScope } = require("./event-admin");
const { stampDeletionForUser, accountsOutsideLedger, cxoneDeletionCounts } = require("./cxone-ledger");
const { log } = require("./log");

const UNVERIFIED_TTL_MS = 48 * 60 * 60 * 1000;   // 48 h (matches CODE_EXPIRY_MS)
const REAP_MAX_PER_RUN = 500;                    // bound the blast radius per tick
const REAP_INTERVAL_MS = 60 * 60 * 1000;         // hourly

// Strike one person's avatar from every frozen team board (their solo rows; a
// group row names no member), collecting each uploaded one into `into`. The row
// gets the preset default (`default1`, what every account starts with and what
// the board's `avatar`, always text on the wire, draws as no picture); its
// nickname and userId stay (an open item awaiting the operator's ruling:
// CLAUDE.md *Known open gaps*). Runs
// inside the cascade's transaction (a frozen board is read from its row on every
// request, never cached, so nothing needs busting). A board that is not JSON is left alone (it
// is recomputed, never served: lib/leaderboard.js _getGroupSnapshot), and still
// keeps the image it names, as the reclaim asks every holder.
const _STRUCK_AVATAR = "default1";
function _scrubBoardAvatars(userId, into) {
  const rows = db.prepare("SELECT competition_id, slot_key, board FROM group_leaderboard_snapshots WHERE instr(board, ?) > 0").all(String(userId));
  const upd = db.prepare("UPDATE group_leaderboard_snapshots SET board=? WHERE competition_id=? AND slot_key=?");
  for (const r of rows) {
    let board;
    try { board = JSON.parse(r.board); } catch (e) { swallowed("account-reaper:board-unreadable", e); continue; }
    if (!Array.isArray(board)) continue;
    let changed = false;
    for (const row of board) {
      if (!row || row.type !== "individual" || row.userId !== userId || row.avatar === _STRUCK_AVATAR) continue;
      if (typeof row.avatar === "string" && row.avatar.startsWith("/api/images/")) into.add(row.avatar);
      row.avatar = _STRUCK_AVATAR;
      changed = true;
    }
    if (changed) upd.run(JSON.stringify(board), r.competition_id, r.slot_key);
  }
}

// Full per-user cascade. **KEEP IN SYNC** with DELETE /api/admin/participants/:id
// (routes/participants.js) — the no-FK tables (task_feedback, challenge_events,
// competition_user_absences) and the badge PNGs in `images` (no FK) must be
// deleted explicitly; the ON DELETE CASCADE children go with the users row.
// v8.12.7 — and ONE table it deliberately does NOT delete from:
// `cxone_realm_accounts` (lib/cxone-ledger.js). That ledger is the only record
// that this platform created a Checkmarx One account for the person, and the
// `user_events` / `competition_users` rows this cascade removes are the only
// other traces of the binding — so deleting the ledger rows here would erase
// the last proof before anything could act on it. The cascade STAMPS them
// instead (`pending_since`, `deletion_source`), in the same transaction as the
// `DELETE FROM users`, so a deletion that commits is a deletion the withdrawal
// runner will see, and one that rolls back stamps nothing. The runner deletes a
// ledger row only once the realm account is gone (or a superadmin dismisses it).
// Returns { purgedSessions, cxoneWithdrawalsScheduled, cxoneCounts } — the
// second is the number of ledger rows this deletion marked for withdrawal, the
// third what every deletion reports about the person's Checkmarx One accounts
// (lib/cxone-ledger.js `cxoneDeletionCounts`: scheduled, left in place,
// unrecorded, unreadable records; each key only when non-zero), so the admin's
// DELETE and the reaper record the same counts from one reading.
function deleteUserCascade(userId) {
  // audit v7.7.36 — capture, BEFORE the cascade: (C1) the comps this user is
  // enrolled in, so the leaderboard cache is busted after commit (the writer-lock
  // invariant — deleting their submissions/hint_reveals changes every board they
  // were on); and (C2) the user's uploaded-avatar ref, so the orphaned `images`
  // blob (no FK, up to 256 KB) is reclaimed instead of living forever.
  const _lbCompIds = db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(userId).map(r => r.competition_id);
  const _avatarRef = (db.prepare("SELECT avatar FROM users WHERE id=?").get(userId) || {}).avatar || null;
  let _cx = 0;
  let _outside = null;
  // The avatars a frozen team board copied of this person (each solo row carries
  // the member's avatar as it was at the end: lib/leaderboard.js), struck from
  // those boards inside the transaction and reclaimed after it with the current
  // one: for the avatar, erasure wins over a frozen board, which then draws the
  // default avatar (the row keeps the person's nickname and userId).
  const _boardAvatars = new Set();
  const txn = db.transaction(() => {
    _scrubBoardAvatars(userId, _boardAvatars);
    // FIRST, before the history it reads goes: the Checkmarx One accounts the
    // person was bound to that the ledger does NOT hold, which this deletion
    // therefore leaves in the realm (lib/cxone-ledger.js `accountsOutsideLedger`).
    // Inside the transaction, so the counts and the stamp read one snapshot.
    _outside = accountsOutsideLedger(db, userId);
    db.prepare("DELETE FROM user_events WHERE user_id=?").run(userId);
    // The DB copy of user-scoped orphaned events is a row ABOUT the user, like
    // user_events above. Rows naming them only as actor survive, as there.
    db.prepare("DELETE FROM orphan_events WHERE scope='user' AND scope_id=?").run(userId);
    db.prepare("DELETE FROM competition_users WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM hint_reveals WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM submissions WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM user_tags WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM task_feedback WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM challenge_events WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM competition_user_absences WHERE user_id=?").run(userId);
    // The share-image copy an older certificate still names (no FK, so the
    // badges' cascade would orphan it); a newer certificate names none (sweep #43).
    db.prepare("DELETE FROM images WHERE id IN (SELECT image_id FROM achievement_badges WHERE user_id=?)").run(userId);
    // v8.12.7 — immediately before the users row goes: an explicit deletion
    // record is what the runner acts on, never the missing users row (which an
    // integrity failure, a partial restore or a hand-edit can also produce).
    // The ledger rows themselves are KEPT — see the header above.
    _cx = stampDeletionForUser(db, userId, now().toISOString(), "cascade");
    db.prepare("DELETE FROM users WHERE id=?").run(userId);
  });
  txn();
  // After the commit, never inside it: the runner makes network calls, and a
  // kick from inside a transaction that then rolled back would chase rows that
  // were never stamped. Lazy, and failure-tolerant — a runner that cannot start
  // now is started by its sweeper, and the stamp is durable either way.
  if (_cx) {
    try { require("./cxone-withdraw").scheduleRealmWithdrawal(); }
    catch (e) { try { console.warn("[cxone-withdraw] could not schedule after a deletion:", e.message); } catch (e2) { swallowed("account-reaper:console-write", e2); } }
  }
  _invalidateMeCache(userId);
  _invalidateUserTagsCache(userId);
  // v8.12.6 — AND THE EVENT-ADMIN ROLE + SCOPE CACHE (lib/event-admin.js). It is
  // keyed on the user id and carries a 2 s TTL, and the grant, revoke and role
  // routes all bust it — the deletion, which removes both the role row and every
  // `competition_admins` grant, was the one writer that did not. So for up to 2 s
  // an in-flight request from a DELETED event admin still read as `event_admin`,
  // scoped to grants that no longer exist. Measured: the direct-upload arm of
  // admin-inflight-authz had to sleep the TTL out to reach the commit-time
  // re-check it exists to prove. The standing writer rule (every write that
  // changes cache-relevant state invalidates BY ID, after the commit), one
  // writer over. Guarded because the invalidator's no-argument form clears EVERY
  // actor's cache, which is a different operation entirely.
  if (userId) invalidateEventAdminScope(userId);
  invalidateAdminParticipantsCache();
  for (const cid of _lbCompIds) { try { invalidateLeaderboardCache(cid); } catch (e) { swallowed("account-reaper:lb-bust", e); } } // C1 — writer-lock invariant
  // C2 — reclaim the person's uploaded avatar, and any older one a frozen board
  // kept (struck from the boards above). Still kept while another account or a
  // challenge names the same picture (deleteAvatarImage asks every holder).
  for (const ref of new Set([_avatarRef, ..._boardAvatars])) {
    try { deleteAvatarImage(ref, { via: "account_deleted" }); } catch (e) { swallowed("account-reaper:avatar-reclaim", e); }
  }
  let purgedSessions = 0;
  // `ended`: the kicked browser is told it was signed out, never that it was idle.
  try { ({ purgedCount: purgedSessions } = invalidateOtherSessions("userId", userId, null, SESSION_END.ended)); } catch (e) { swallowed("account-reaper:session-purge", e); }
  return { purgedSessions, cxoneWithdrawalsScheduled: _cx, cxoneCounts: cxoneDeletionCounts(_outside, _cx) };
}

function reaperFloorIso() {
  return db.prepare("SELECT value FROM settings WHERE key='account_reaper_floor_at'").get()?.value || null;
}

// v8.12.6 — THE GATE IS ONE DEFINITION. The sweep below deletes what it
// matches; any other reader (a date shown to someone about their removal) must
// interpolate this, never a copy: a second copy of the WHERE clause would agree
// with the first on the day it was written and drift afterwards (the v7.21.13
// duplication class), silently.
//
// Everything that decides WHETHER a row is reaped lives here, the grandfather
// floor included, which binds TWICE (`? IS NULL OR created_at >= ?`). The AGE
// cutoff is the reader's own: the sweep asks "is it overdue now?".
//
// A LIVE SIGN-IN CODE IS DELIBERATELY NOT IN THE GATE. Sparing a row that holds
// one would let any anonymous caller keep an unverified, possibly squatted,
// registration alive for ever by asking for a code before every sweep: a code
// request needs nothing but the address.
const REAP_GATE_SQL =
  `first_verified_at IS NULL
       AND verified=0
       AND approved=0
       AND registered_via='manual'
       AND invitation_id IS NULL
       AND pending_self_enroll_comp_id IS NULL
       AND self_enroll_grace_until IS NULL
       AND denied_at IS NULL
       AND blocked=0
       AND (role='participant' OR role IS NULL)
       AND (? IS NULL OR created_at >= ?)`;

// The sweep's SELECT. Binds: floor, floor, age cutoff, limit.
const _REAP_SELECT =
  `SELECT id, email, nickname, created_at FROM users
     WHERE ${REAP_GATE_SQL}
       AND created_at < ?
     ORDER BY created_at ASC
     LIMIT ?`;

// One sweep pass. opts: { ttlMs, limit, floorIso, now } (all optional — used by
// tests). Returns { scanned, deleted, ids, cappedAtLimit }.
function sweepUnverifiedAccounts(opts = {}) {
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : UNVERIFIED_TTL_MS;
  const limit = opts.limit != null ? opts.limit : REAP_MAX_PER_RUN;
  const nowMs = (opts.now || now()).getTime();
  const cutoffIso = new Date(nowMs - ttlMs).toISOString();
  const floorIso = opts.floorIso !== undefined ? opts.floorIso : reaperFloorIso();
  const rows = db.prepare(_REAP_SELECT).all(floorIso, floorIso, cutoffIso, limit);
  const ids = [];
  for (const r of rows) {
    try {
      // The same Checkmarx One counts the admin's DELETE records: the cascade
      // removes the accounts the platform created and recorded exactly as a
      // manual deletion does, and the counts say what it could not remove.
      const { cxoneCounts } = deleteUserCascade(r.id);
      try { recordOrphanedAuditEvent("user", r.id, "account_reaped", "system", { reason: "unverified_48h", email: r.email, nickname: r.nickname, created_at: r.created_at, ...cxoneCounts }); } catch (e) { swallowed("account-reaper:audit-emit", e); }
      // No human is in the loop here, so an account someone must check in the
      // tenant by hand also reaches the operator's log at the default level.
      // Counts and the account id only, never an address.
      if (cxoneCounts.cxone_accounts_unrecorded || cxoneCounts.cxone_records_unreadable) {
        try { log.warn({ tag: "account-reaper", user_id: r.id, ...cxoneCounts }, "Unconfirmed account removed; some of its Checkmarx One accounts could not be removed automatically: check the tenant"); }
        catch (e) { swallowed("account-reaper:cxone-warn", e); }
      }
      ids.push(r.id);
    } catch (e) {
      try { console.error("account reaper: failed to delete", r.id, e.message); } catch (e2) { swallowed("account-reaper:console-write", e2); }
    }
  }
  return { scanned: rows.length, deleted: ids.length, ids, cappedAtLimit: rows.length === limit };
}

let _handle = null;
function startAccountReaper() {
  // Tests drive sweepUnverifiedAccounts() directly (via the test-only endpoint),
  // so the interval is production-only — same posture as the status scheduler.
  if (process.env.NODE_ENV === "test") return;
  if (_handle) return;
  try { sweepUnverifiedAccounts(); } catch (e) { try { console.error("account reaper boot sweep failed:", e.message); } catch (e2) { swallowed("account-reaper:console-write", e2); } }
  try { sweepStaleVerifyCodes(); } catch (e) { try { console.error("stale verify-code boot sweep failed:", e.message); } catch (e2) { swallowed("account-reaper:console-write", e2); } }
  _handle = setInterval(() => {
    try { sweepUnverifiedAccounts(); } catch (e) { try { console.error("account reaper tick failed:", e.message); } catch (e2) { swallowed("account-reaper:console-write", e2); } }
    // Same tick: a spent receipt only has to go before the index grows, not promptly.
    try { sweepStaleVerifyCodes(); } catch (e) { try { console.error("stale verify-code tick failed:", e.message); } catch (e2) { swallowed("account-reaper:console-write", e2); } }
  }, REAP_INTERVAL_MS);
  if (_handle.unref) _handle.unref(); // never keep the process alive for the reaper
}

// v7.23.10 — clear SPENT verification codes.
//
// One-click verification (routes/auth.js _completeVerification) stopped nulling
// verify_code on success: the retained code is what lets a second request — a
// human clicking after a mail scanner already spent the link — be told the
// truth instead of "Verification Failed". But the code is only a receipt for
// its 48h window, and without a sweep the partial index idx_users_verify_code
// would grow to one row per verified user and never shrink, because most people
// click exactly once.
//
// Bounded by the same window as the code itself, so a receipt is dropped only
// once it can no longer do anything. Verified users only: an UNVERIFIED user's
// expired code is cleared by the verify handler's own expiry branch, and
// clearing it here would rob that branch of the row it needs to answer with
// "Link Expired" rather than "Link not valid".
function sweepStaleVerifyCodes(opts = {}) {
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : UNVERIFIED_TTL_MS;
  const nowMs = (opts.now || now()).getTime();
  const cutoffIso = new Date(nowMs - ttlMs).toISOString();
  const r = db.prepare(
    "UPDATE users SET verify_code=NULL, verify_code_at=NULL " +
    "WHERE verify_code IS NOT NULL AND verified=1 AND (verify_code_at IS NULL OR verify_code_at < ?)"
  ).run(cutoffIso);
  return { cleared: r.changes };
}

module.exports = { deleteUserCascade, sweepUnverifiedAccounts, sweepStaleVerifyCodes, startAccountReaper, REAP_GATE_SQL };
