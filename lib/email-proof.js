"use strict";

// Address proofs — the emailed code for an address that has NO account yet.
//
// The sign-in screen asks only for an email and always answers "we've emailed
// you a code", so it never says whether an address is registered. For an
// address with an account the code is an ordinary sign-in code
// (lib/login-code.js). For an address with none, it is an ADDRESS PROOF:
// bound to that one address, short-lived, single-use, held in `email_proofs`
// (never on a user row — no row exists until the sign-up form is submitted).
// Redeeming it puts a session-bound "verified email" grant in the session
// (routes/auth.js); POST /api/register creates an account only with that grant.
//
// Same budgets as a sign-in code, so the two doors cannot be told apart by how
// they throttle: LOGIN_CODE_MAX_SENDS per address per window (the window is the
// first mint plus LOGIN_CODE_TTL_MS, never moved by a re-issue), two of them per
// origin (/24, /64), and a live proof mailed under LOGIN_CODE_RESEND_MIN_MS ago
// is never re-minted. Wrong guesses are capped at LOCKOUT_MAX, after which the
// code is burned: the row stays until it expires, so the address's budget and
// suppression hold, and the next request inside the window re-issues on it.

const crypto = require("crypto");
const { now } = require("./time");
const { LOGIN_CODE_TTL_MS, LOGIN_CODE_MAX_SENDS } = require("./config");
const { mintCode, hashCode, normaliseCode, LOGIN_CODE_RESEND_MIN_MS, LOGIN_CODE_MAX_SENDS_PER_ORIGIN, _testNoteProof } = require("./login-code");
const { LOCKOUT_MAX } = require("./lockout");

let _db = null;
function db_() { if (!_db) _db = require("../db"); return _db; }

/** The session grant a redeemed proof buys: how long it stays usable. */
const EMAIL_PROOF_GRANT_MS = 15 * 60_000;

const _originSpend = new Map();     // `${email}|${origin}` -> { n, resetAt }
const _ORIGIN_MAX_ENTRIES = 10_000;

function _row(email) {
  return db_().prepare("SELECT * FROM email_proofs WHERE email_norm=?").get(email) || null;
}
function _live(row, ms) {
  if (!row) return false;
  const t = new Date(row.expires_at).getTime();
  return Number.isFinite(t) && t > ms;
}
function _originExhausted(email, origin, ms) {
  if (!origin) return false;
  const e = _originSpend.get(`${email}|${origin}`);
  return !!(e && e.resetAt > ms && e.n >= LOGIN_CODE_MAX_SENDS_PER_ORIGIN);
}
function _originSpendOne(email, origin, ms) {
  if (!origin) return;
  const k = `${email}|${origin}`;
  const e = _originSpend.get(k);
  if (!e || e.resetAt <= ms) _originSpend.set(k, { n: 1, resetAt: ms + LOGIN_CODE_TTL_MS });
  else e.n += 1;
  if (_originSpend.size > _ORIGIN_MAX_ENTRIES) {
    for (const key of _originSpend.keys()) { _originSpend.delete(key); if (_originSpend.size <= _ORIGIN_MAX_ENTRIES) break; }
  }
}
function _forgetOrigin(email) {
  const prefix = email + "|";
  for (const k of _originSpend.keys()) if (k.startsWith(prefix)) _originSpend.delete(k);
}

/**
 * Mint (or re-issue) the proof for `email`. Returns
 * `{ ok:true, code, expiresInMinutes, reissued }` or `{ ok:false, reason }` with
 * reason `recently_sent` | `send_cap_reached` | `origin_cap_reached`.
 * `email` must already be normalised; the caller has decided no account holds it.
 */
function issueProof(email, opts) {
  const o = opts || {};
  const n = (o.at || now());
  const ms = n.getTime();
  const origin = o.originKey || null;
  const row = _row(email);
  const live = _live(row, ms);
  if (live) {
    const last = new Date(row.last_sent_at).getTime();
    if (Number.isFinite(last) && ms - last < LOGIN_CODE_RESEND_MIN_MS) return { ok: false, reason: "recently_sent" };
    if ((row.sends || 0) >= LOGIN_CODE_MAX_SENDS) return { ok: false, reason: "send_cap_reached" };
  }
  if (_originExhausted(email, origin, ms)) return { ok: false, reason: "origin_cap_reached" };
  const code = mintCode();
  const joinCompId = o.joinCompId || null;
  const invitationId = o.invitationId || null;
  const iso = n.toISOString();
  if (live) {
    db_().prepare("UPDATE email_proofs SET code_hash=?, sends=sends+1, attempts=0, join_comp_id=?, invitation_id=?, origin=?, last_sent_at=? WHERE email_norm=?")
      .run(hashCode(code), joinCompId, invitationId, origin, iso, email);
  } else {
    db_().prepare(`INSERT INTO email_proofs (email_norm, code_hash, created_at, expires_at, sends, attempts, join_comp_id, invitation_id, origin, last_sent_at)
      VALUES (?,?,?,?,1,0,?,?,?,?)
      ON CONFLICT(email_norm) DO UPDATE SET code_hash=excluded.code_hash, created_at=excluded.created_at, expires_at=excluded.expires_at,
        sends=1, attempts=0, join_comp_id=excluded.join_comp_id, invitation_id=excluded.invitation_id, origin=excluded.origin, last_sent_at=excluded.last_sent_at`)
      .run(email, hashCode(code), iso, new Date(ms + LOGIN_CODE_TTL_MS).toISOString(), joinCompId, invitationId, origin, iso);
  }
  _originSpendOne(email, origin, ms);
  _testNoteProof(email, code, joinCompId);
  const expiresMs = live ? new Date(row.expires_at).getTime() : ms + LOGIN_CODE_TTL_MS;
  return { ok: true, code, reissued: live, expiresInMinutes: Math.max(1, Math.round((expiresMs - ms) / 60_000)) };
}

/**
 * One redemption attempt of (email, code). On a match the proof is CONSUMED
 * (deleted) and its row returned; a well-formed wrong code charges an attempt,
 * and the LOCKOUT_MAX-th BURNS the code: its hash is emptied (no guess matches
 * it) but the row stays until it expires, so the address's send budget and
 * re-send suppression survive. Deleting it handed the next request a fresh
 * budget, so guessing could make the platform mail an address past its cap.
 * Returns `{ matched, wellFormed, row, burned }`; `burned` is true only for the
 * guess that burned a live code (the caller audits it once).
 */
function redeemProof(email, rawCode, at) {
  const ms = (at || now()).getTime();
  const code = normaliseCode(rawCode);
  const out = { matched: false, wellFormed: !!code, row: null, burned: false };
  const row = _row(email);
  if (!row || !_live(row, ms) || !code) return out;
  const want = Buffer.from(hashCode(code), "hex");
  const have = Buffer.from(String(row.code_hash || ""), "hex");
  const ok = have.length === want.length && crypto.timingSafeEqual(want, have);
  if (!ok) {
    const attempts = (row.attempts || 0) + 1;
    const burn = attempts >= LOCKOUT_MAX;
    out.burned = burn && String(row.code_hash || "") !== "";
    db_().prepare("UPDATE email_proofs SET attempts=?, code_hash=CASE WHEN ? THEN '' ELSE code_hash END WHERE email_norm=?")
      .run(attempts, burn ? 1 : 0, email);
    return out;
  }
  // Single use: the DELETE is the claim, so two concurrent redeems cannot both win.
  if (db_().prepare("DELETE FROM email_proofs WHERE email_norm=? AND code_hash=?").run(email, row.code_hash).changes !== 1) return out;
  _forgetOrigin(email);
  out.matched = true;
  out.row = row;
  return out;
}

/** Drop an address's proof (an account now holds the address). */
function discardProof(email) {
  _forgetOrigin(email);
  return db_().prepare("DELETE FROM email_proofs WHERE email_norm=?").run(email).changes;
}

/** Delete every expired proof. Returns the number removed. */
function sweepExpiredProofs(at) {
  return db_().prepare("DELETE FROM email_proofs WHERE expires_at <= ?").run((at || now()).toISOString()).changes;
}

/** Test-only: the origin share is process-resident, like the sign-in code's. */
function _resetProofOriginSpend() { const n = _originSpend.size; _originSpend.clear(); return n; }

/**
 * The live grant in `session` for `email`, or null. A grant is written only by
 * a redeemed proof; an expired one is removed as it is read.
 */
/**
 * "Not your event?" for an address no account holds: the live proof THIS
 * browser's request minted (`tag`, lib/login-code.js `codeDropTag` of its stored
 * hash) stops adding the new account to `compId`. The proof itself still works.
 * Compare-and-set on the hash and the event, so a proof re-minted meanwhile is
 * left alone. Returns the rows changed (0 or 1).
 */
function dropProofEvent(email, { compId, tag, tagOf, at } = {}) {
  const ms = (at || now()).getTime();
  const row = _row(email);
  // The tag is computed whatever is asked: the caller's work must not depend on
  // what its browser holds.
  const rowTag = row && row.code_hash && typeof tagOf === "function" ? tagOf(row.code_hash) : null;
  if (!row || !_live(row, ms) || !rowTag || !compId || row.join_comp_id !== compId || rowTag !== tag) return 0;
  return db_().prepare("UPDATE email_proofs SET join_comp_id=NULL WHERE email_norm=? AND code_hash=? AND join_comp_id=? AND expires_at > ?")
    .run(email, row.code_hash, compId, new Date(ms).toISOString()).changes;
}

function liveProofGrant(session, email, at) {
  const g = session && session.emailProof;
  if (!g || typeof g !== "object" || typeof g.email !== "string") return null;
  if (!(Number(g.until) > (at || now()).getTime())) { delete session.emailProof; return null; }
  if (typeof email === "string" && g.email !== email) return null;
  return g;
}

module.exports = {
  EMAIL_PROOF_GRANT_MS,
  issueProof, redeemProof, discardProof, sweepExpiredProofs, liveProofGrant, dropProofEvent, _resetProofOriginSpend,
};
