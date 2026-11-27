"use strict";

// The per-account login lockout: ten failed guesses (wrong sign-in codes,
// passwords or current passwords) inside a five-minute sliding window lock the
// account for an hour and mail its holder.
//
// A LOCK IS AN ALARM, NOT A BAR. While an account is locked a sign-in guess is
// still checked: a wrong one is refused and not counted again, a correct one
// signs the holder in and clears the lock (routes/auth.js, both doors), so
// nobody can lock a holder out of their own account by guessing. What bounds
// guessing is each door's rate limits, per (IP, address) with a per-IP backstop.
//
// WHY THIS IS A MODULE (v7.29.0). The three constants were declared inline on one
// line inside the POST /api/login handler body, and the three columns they govern
// —`failed_login_count`, `failed_login_first`, `locked_until` — were written by
// seven statements spread across three files, three of which spelled the same
// clear with the columns in a different order. Nothing outside that handler could
// read the threshold, which matters now: the emailed sign-in code reuses this
// failure budget rather than growing a second one. A second threshold for one
// question is how they drift.
//
// WHAT DELIBERATELY STAYS AT THE CALL SITE:
//   - The audit emits. Each carries a different `reason` and a different context
//     shape, and `login_failed` is emitted on paths that never touch this module.
//   - The lockout EMAIL. `trackDetachedSend(sendLockoutEmail(...))` stays literal
//     and single-line in routes/auth.js: the v7.20.9 F8 scanner enumerates
//     lib/*.js and routes/** looking for exactly that wrapper, and it would now
//     read this file.
//     Keeping the send out of here also avoids a lib/lockout → lib/email edge.
//   - The `res` writes. Each caller answers in its own shape (the code redeem
//     and the password door 200 for every outcome, the sign-in method change's
//     wrong current password a 400), and a helper cannot return out of its
//     caller, so this module answers with facts and the caller decides.
//
// AND ONE WRITER THAT IS NOT MIGRATED, ON PURPOSE: the unblock
// (`POST /api/admin/participants/:id/block`, routes/participants.js) clears the
// three columns in the same statement that clears `blocked`. Calling clearLockout()
// there would put two writes where the unblock has one. It keeps its inline SQL,
// and this comment is the record of why.

const db = require("../db");
const { now } = require("./time");

// 10 failures inside 5 minutes ⇒ locked for 1 hour. Account-keyed on purpose:
// keyed by (IP, account), guesses spread over many sources would never raise the
// alarm.
const LOCKOUT_MAX = 10;
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000;

// Pure. `user` is any row carrying `locked_until`; `atMs` defaults to the
// injectable clock so a fake clock moves this too.
function isLockedNow(user, atMs) {
  if (!user || !user.locked_until) return false;
  const at = atMs == null ? now().getTime() : atMs;
  return new Date(user.locked_until).getTime() > at;
}

// Clear all three counters. Returns the driver result so a caller can tell
// whether the row moved — the unlock route reports `cleared_failed_logins` from a
// PRE-update snapshot and needs `changes` to decide whether to emit at all.
function clearLockout(userId) {
  return db.prepare(
    "UPDATE users SET locked_until=NULL, failed_login_count=0, failed_login_first=NULL WHERE id=?"
  ).run(userId);
}

// Record one failed password and return the COMMITTED count.
//
// v6.20.x — the window-reset and the increment are ONE statement. A
// read-modify-write could lose an increment under two concurrent failed logins
// for the same email, letting the threshold be undershot. The CASE resets the
// counter to 1 and stamps a new window-start when the prior window expired (or
// was never set), else increments; `failed_login_first` only advances on a reset.
function recordFailedLogin(userId, at) {
  const n = at || now();
  const nIso = n.toISOString();
  const windowFloor = new Date(n.getTime() - LOCKOUT_WINDOW_MS).toISOString();
  db.prepare(`UPDATE users SET
      failed_login_count = CASE WHEN failed_login_first IS NULL OR failed_login_first <= ? THEN 1 ELSE failed_login_count + 1 END,
      failed_login_first = CASE WHEN failed_login_first IS NULL OR failed_login_first <= ? THEN ? ELSE failed_login_first END
    WHERE id=?`).run(windowFloor, windowFloor, nIso, userId);
  return db.prepare("SELECT failed_login_count FROM users WHERE id=?").get(userId)?.failed_login_count || 1;
}

function shouldLock(count) { return count >= LOCKOUT_MAX; }

// Arm the lock and return the ISO instant it lifts.
//
// The counter is deliberately LEFT STANDING. A sign-in guess while locked is not
// counted (both doors skip recordFailedLogin), but a wrong CURRENT password under
// How you sign in (PUT /api/me/sign-in-method) is: it increments to 11 inside the
// same window and re-arms, which keeps the owner's "someone is guessing" signal
// firing. Do not tidy this into a counter reset.
function armLockout(userId, at) {
  const n = at || now();
  const lockedUntil = new Date(n.getTime() + LOCKOUT_DURATION_MS).toISOString();
  db.prepare("UPDATE users SET locked_until=? WHERE id=?").run(lockedUntil, userId);
  return lockedUntil;
}

// The rows whose lock has lapsed, for the background unlock poller.
function expiredLockouts(at) {
  return db.prepare(
    "SELECT id, email, secondary_email, first_name, nickname, timezone, locked_until FROM users WHERE locked_until IS NOT NULL AND locked_until<=?"
  ).all((at || now()).toISOString());
}

module.exports = {
  LOCKOUT_MAX, LOCKOUT_WINDOW_MS, LOCKOUT_DURATION_MS,
  isLockedNow, clearLockout, recordFailedLogin, shouldLock, armLockout, expiredLockouts,
};
