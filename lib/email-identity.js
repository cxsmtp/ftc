"use strict";

// Email-uniqueness check against the users table. Kept out of lib/util (which
// stays a pure, db-free leaf imported very widely, incl. by lib/email) so the
// one helper that needs a SELECT lives in its own tiny leaf module.
// (Domain: Participant identity. Code/table term: `users`.) Deps: db + util.
// (v7.0.0 refactor: extracted from server.js.)

const db = require("../db");
const { normaliseEmail } = require("./util");

// v7.5.0 — a pending-email confirmation code lives this long; an abandoned
// pending change past this age no longer reserves its target address. Matches
// CODE_EXPIRY_MS (the verify-code TTL) so all email codes age identically.
const PENDING_EMAIL_TTL_MS = 48 * 60 * 60 * 1000;

// Symmetric, system-wide email-uniqueness check: an address can never collide
// with *any* other user's email OR secondary_email — regardless of which slot
// the caller is checking — NOR with another user's in-flight `pending_email`
// (the new primary they're confirming). Previously primary-vs-primary and
// secondary-vs-both checks were asymmetric, which let the same address be
// stored as A.email and B.secondary_email; a lookup matching either column
// would then resolve to whichever row SQLite returned first.
// Keeping the check symmetric + including non-expired pendings closes both the
// committed-slot ambiguity and the two-accounts-pend-the-same-address race.
function emailIsTaken(addr, excludeUserId = null) {
  if (!addr) return false;
  // v6.16.22 — normalise both sides so encoding variants (NFC / NFD) of
  // the same visual address resolve as duplicates. The stored column is
  // populated by the same normaliser at write time, so SQLite's LOWER
  // on the stored side is a no-op for our purposes (already lowercase
  // after JS toLowerCase) and we just have to ensure the input is in
  // the same canonical form.
  const norm = normaliseEmail(addr);
  // A pending_email is an in-flight reservation. Count it so two accounts can't
  // both pend the same address and a pending change can't target a live slot —
  // but ONLY while its code is unexpired, so an abandoned pending never locks an
  // address out permanently (the confirm step re-checks committed slots anyway).
  const cutoff = new Date(Date.now() - PENDING_EMAIL_TTL_MS).toISOString();
  // THREE POINT LOOKUPS, each answered by its own NOCASE index
  // (`uq_users_email_nocase`, `uq_users_secondary_email_nocase`,
  // `idx_users_pending_email_nocase`). The one-statement form
  // `LOWER(email)=? OR LOWER(secondary_email)=? OR …` could use none of them,
  // so every sign-up (which asks this at the request, the redeem and the form)
  // scanned every account: O(N) per walk-up, O(N²) for a booth rush. Same
  // answer: SQLite's LOWER and NOCASE both fold ASCII only, and addresses are
  // ASCII by rule (normaliseEmail, the NOCASE unique indexes).
  const ex = excludeUserId ? " AND id!=?" : "";
  const args = (...a) => (excludeUserId ? [...a, excludeUserId] : a);
  return !!(
    db.prepare(`SELECT id FROM users WHERE email=? COLLATE NOCASE${ex} LIMIT 1`).get(...args(norm))
    || db.prepare(`SELECT id FROM users WHERE secondary_email=? COLLATE NOCASE${ex} LIMIT 1`).get(...args(norm))
    || db.prepare(`SELECT id FROM users WHERE pending_email=? COLLATE NOCASE AND pending_email_code_at > ?${ex} LIMIT 1`).get(...args(norm, cutoff))
  );
}

module.exports = { emailIsTaken };
