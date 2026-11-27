"use strict";

// Emailed sign-in codes — the code OBJECT. Minting, hashing, verification and
// invalidation. The routes, the audit emits and the email live at the call site.
//
// ELIGIBILITY: every account row that is not blocked or denied. Every account
// row can sign in with an emailed code; an account whose sign-in method is
// `password` and that has set one has the password door too, which never closes
// this one (lib/login-method.js). The
// built-in superadmin (no row) signs in only with its boot-generated password,
// as break-glass. The code goes to the INBOX, so whoever controls the inbox
// controls the account.
//
// THE ALPHABET IS A ONE-WAY DOOR. 8 characters of Crockford base32 ≈ 40 bits,
// rendered XXXX-XXXX. Crockford excludes I, L, O and U and decodes i/l→1 and o→0,
// which absorbs the commonest transcription errors; `_b64url` is unusable here
// because it contains both O/0 and I/l. The arithmetic that picks 8 rather than 6:
// the account lock refuses no guess (lib/lockout.js: it is an alarm), so what
// bounds guessing is the redeem's limits: 10 a minute per (IP, address), and a
// per-IP backstop of 600 a minute across addresses. Over a 6-hour event one
// source gets ~3,600 guesses at one account and ~216,000 in all; and anyone can
// make a victim's code live by asking for one. At 6 digits that finds a live code
// about one time in five; at 8 Crockford (2^40) about one in five million.
// Entropy is free now and expensive once it is in email templates.

const crypto = require("crypto");
const net = require("net");
const { canonicaliseIp } = require("./util");
const { now } = require("./time");
// db is required LAZILY, not at module scope, so that minting or normalising a
// code has no side effect at all — `require("../db")` OPENS the database file.
// The same idiom, for the same reason, as lib/middleware's comp-allowlist.
// (It does NOT make this module safe to require at a spec's top level: the
// v7.20.2 scanner treats any module that CAN reach db.js as db-backed, which is
// the right call. Specs require it inside the test.)
let _db = null;
function db_() { if (!_db) _db = require("../db"); return _db; }
const { LOGIN_CODE_TTL_MS, LOGIN_CODE_MAX_SENDS, SESSION_SECRET } = require("./config");
const { findUserByPrimary } = require("./account-lookup");

// Crockford base32, minus I L O U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;

// ── Provenance (v8.1.x) ──────────────────────────────────────────────────────
//
// HOW a code reached its holder decides what redeeming it PROVES, so the mint
// records it and the redeem path reads it back. Two values, and the vocabulary
// is closed:
//   'email' — delivered to the account's own inbox. Redeeming proves mailbox
//             control, so it verifies the account.
//   'desk'  — an admin read it off their own screen. It proves nothing about the
//             mailbox and must never verify anything.
//
// **THE DISCRIMINATOR IS AN ALLOW-LIST ON 'email', NEVER A CHECK FOR 'desk'.**
// A NULL (a row predating the column, a mint by a caller that did not say) and
// any unrecognised value therefore mean "not proven", which is the safe answer.
// Written the other way round, a forgotten argument would become a silent
// email-verification bypass — the one outcome this whole mechanism exists to
// prevent.
const CODE_VIA_EMAIL = "email";
const CODE_VIA_DESK = "desk";
function _normaliseVia(via) {
  // Tolerant on an unrecognised value rather than throwing, and it degrades
  // toward the safe option: a code with no usable provenance still signs its
  // holder in, it simply verifies nothing.
  return via === CODE_VIA_EMAIL || via === CODE_VIA_DESK ? via : null;
}

// Does the LIVE code on this row prove its holder controls the account's inbox?
// Takes the row rather than the raw string so no caller has to know the value.
function codeProvesEmail(user) {
  return !!user && user.login_code_via === CODE_VIA_EMAIL;
}

function mintCode() {
  // rejection-free: 32 is a power of two, so masking 5 bits per character is
  // uniform. randomBytes rather than anything derived — a code is a credential.
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

// Display form only. The wire and the hash always use the canonical 8 characters.
function formatCode(code) { return `${code.slice(0, 4)}-${code.slice(4)}`; }

// Accept what a human can plausibly type off a screen: any case, any separators,
// and Crockford's own confusable mappings. Returns "" when the result is not a
// well-formed code, so a caller can refuse without a query. Text only: a body
// value of any other type (an object whose toString is not callable throws under
// String()) is not a code, so a door answers it as the typo it is (sweep #193).
function normaliseCode(raw) {
  const s = (typeof raw === "string" ? raw : "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1").replace(/O/g, "0").replace(/U/g, "V");
  if (s.length !== CODE_LEN) return "";
  for (const ch of s) if (!ALPHABET.includes(ch)) return "";
  return s;
}

function hashCode(code) { return crypto.createHash("sha256").update(code, "utf8").digest("hex"); }
// What a session remembers of a code (or address proof) its request minted, so
// that only that browser can drop the code's event ("Not your event?", POST
// /api/auth/code/drop-event): keyed with the per-boot session secret, so a
// session row read by anyone cannot be searched over the 40-bit code space.
function codeDropTag(storedHash) {
  return crypto.createHmac("sha256", SESSION_SECRET).update("drop|" + String(storedHash || "")).digest("hex").slice(0, 32);
}

// A row is eligible for a code unless it is blocked or denied. EVERY ROLE
// qualifies — participant, event admin, admin and user-backed superadmin —
// because every account row can sign in with an emailed code (a password, where
// an account has one, never closes that door); the built-in superadmin (no row)
// keeps its boot-generated password as break-glass.
//
// `approved` is NOT a term. An emailed code proves the mailbox, and redeeming
// one approves a pending, not-denied account unless `require_account_approval`
// is on (routes/auth.js redeem). With approval on, the code still verifies the
// address, which is what the approval queue needs before an admin can approve.
//
// A missing `blocked` or `denied_at` reads falsy, so an under-selected row is
// ELIGIBLE here: this check does not fail closed. Callers pass whole rows, and
// any column-naming SELECT that feeds this (or `codeBlockedReason`) must carry
// both columns.
function isCodeEligible(user) {
  if (!user) return false;
  if (user.blocked || user.denied_at) return false;
  return true;
}

function codeIsLive(user, at) {
  if (!user || !user.login_code_hash || !user.login_code_at) return false;
  const t = new Date(user.login_code_at).getTime();
  if (!Number.isFinite(t)) return false;
  return ((at || now()).getTime() - t) < LOGIN_CODE_TTL_MS;
}

// Issue a code. Returns {code, reissued, expiresAt, expiresInMinutes} or null
// when the send budget is spent.
//
// EACH CALL MINTS A FRESH CODE, and that is forced by storing only the hash:
// the plaintext is unrecoverable by construction, so "resend the same one" is
// not available. Hash-only is the right trade for a
// credential this short — a database read, a backup or a log line can never yield
// a working code — and the cost is that a second request supersedes the first.
//
// That cost is a nuisance rather than a lockout: the new code goes to the SAME
// inbox, so a legitimate holder simply uses the newest mail, and an attacker who
// requests one for someone else's address only sends that person another code
// they cannot read.
//
// `login_code_at` is anchored to the FIRST mint in the window and is deliberately
// NOT moved on a reissue — otherwise three requests silently buy a 30-minute
// window instead of the 10-minute one the design costs its entropy against.
//
// v8.8.9 — THE CAP IS AN EMAIL BUDGET, and the residual that used to sit here
// was wrong in three of its four clauses. It said an attacker needed "enough
// addresses" and that "the per-(IP, email) limiter on the route is what makes
// that expensive": the route permits FIVE requests per 15 minutes against a cap
// of THREE, so one address burns it outright, and `_rateLimitAllowlisted`
// bypasses that limiter entirely for a venue IP — which CLAUDE.md calls not
// optional for a NAT'd event. It also deferred the work "to the PR that adds the
// UI", which shipped at v8.1.0 (PR 33) and again at v8.3.1.
//
// And the (account, IP/24) key it proposed is a REGRESSION. The cap returns
// BEFORE mintCode() below, so it also bounds how often a victim's live code can
// be invalidated under them; per-/24 budgets multiply both the mail they receive
// and the invalidations of the code they are typing, and the account is already
// in the key — a /24 term separates nobody who was not already separate.
//
// What was actually broken was the DESK reveal being charged an email budget it
// does not spend; see issueCode. The residual proper, restated honestly: three
// emailed sends per window is a global per-account budget, so anyone who can
// reach the endpoint can spend a named participant's mail for the rest of that
// window (≤10 minutes). They learn nothing — every answer is 200 — the account
// keeps the desk reveal (and its password, if it has one), and the window
// self-clears.
/**
 * `via` is the DELIVERY METHOD — 'email' or 'desk' (see CODE_VIA_EMAIL above).
 *
 * **IT DEFAULTS TO NEITHER, and that default is the safe one**: an omitted or
 * unrecognised value is stored as NULL, which the redeem path treats exactly
 * like 'desk' — the holder is signed in and nothing is verified. Every caller
 * that CAN prove delivery must say so; a caller that forgets can only ever
 * under-claim.
 *
 * `expiresInMinutes` is returned rather than left to the caller to derive,
 * because deriving it is the mistake: `login_code_at` is anchored to the FIRST
 * mint of the window and is deliberately not moved on a re-issue, so a re-issued
 * code dies when the ORIGINAL window ends and "expires in 10 minutes" is a lie
 * on every send after the first. The arithmetic lives with the anchor.
 */
/**
 * v8.1.3 — WHICH condition refuses a sign-in code, or null when none does.
 *
 * v8.7.6 — MOVED here from routes/participants.js, beside `isCodeEligible`,
 * whose inverse it is. `POST /api/auth/code/request` has to record WHY it
 * refused (a request that mints nothing left no trace at all, so an operator
 * could not tell a throttle from an ineligible account from a typo), and a
 * route module exports nothing — so the alternative was a second ladder that
 * agrees with this one on the day it is written.
 *
 * THIS IS THE ONE SPELLING OF THE RULE IN THIS FILE. The reveal route's refusal
 * ladder reads it, the row projection reads it, and the desk-invite duplicate
 * remedy reads it — so the row, the 409 and the sentence an admin is handed can
 * never describe the same account differently. It returns the refusal CODES the
 * reveal already shipped (`account_inactive`), because a
 * parallel vocabulary for the row would be a second thing to keep in step.
 *
 * `isCodeEligible` (lib/login-code) is consulted LAST, as a backstop rather than
 * as the whole answer: it is a boolean, so it cannot name anything, but it can
 * only make this stricter. Any condition the module grows that this ladder has
 * not learnt still refuses — under `not_eligible`, a generic but PRESENT
 * explanation. Returning null there would put us back at a menu item that
 * vanishes with nothing said about it, which is the defect being fixed.
 *
 * Order matters only for which of several true reasons an admin is shown; it
 * mirrors the ladder the reveal has always used.
 *
 * ADDING A CONDITION HERE MEANS GREPPING THE SELECTS THAT FEED IT. Three do:
 * `_PARTICIPANT_ROW_COLUMNS`, the reveal's `SELECT *`, and the duplicate-remedy
 * lookup below — and a column-naming SELECT that misses one answers `undefined`,
 * which reads as "condition not met" and silently un-refuses. That has now rotted
 * three times in this release cycle (attempt_cap, deadline_at, profile_policy).
 */
function codeBlockedReason(u) {
  if (u.blocked || u.denied_at) return "account_inactive";
  if (!isCodeEligible(u)) return "not_eligible";
  return null;
}

/**
 * HAS THIS ACCOUNT EVER SIGNED IN? Every sign-in door stamps `login_time` (the
 * first sign-in, never moved) and `last_login_time` through `stampLoginTimes`
 * (lib/middleware.js); an import carries both from the file. An account with
 * neither has never signed in.
 *
 * A code is SHOWN at the desk only for such an account (operator ruling,
 * 14 Nov 2026): a walk-up just added at the desk, or one whose first emailed
 * code never arrived. After a first sign-in the desk can only email a code to
 * the sign-in address. The reveal (routes/participants.js `_codeBlockedReason`)
 * and the redeem (routes/auth.js, for a desk code minted before a sign-in by
 * another door) both ask this.
 *
 * THROWS on a row without both columns: an under-selected row would read as
 * "never signed in" and quietly reopen the desk reveal.
 */
function hasSignedIn(u) {
  if (!u || !("login_time" in u) || !("last_login_time" in u)) {
    throw new Error("hasSignedIn: the row must carry login_time and last_login_time");
  }
  return !!(u.login_time || u.last_login_time);
}

// ── v8.8.25 — A SUB-BUDGET, NEVER A PARALLEL ONE ────────────────────────────
//
// The residual v8.8.9 restated: three emailed sends per window is a GLOBAL
// per-account budget, spendable by anyone who can reach the endpoint. So an
// attacker who knows an address burns all three from one IP — the route limiter
// permits five per fifteen minutes, and `_rateLimitAllowlisted` bypasses it
// entirely for a venue address — and the account's own owner is refused for the
// rest of the window.
//
// v8.8.9 REFUTED the obvious remedy, and was right about it: keying the budget on
// (account, IP/24) makes it a PARALLEL budget, so total mail becomes three times
// the number of /24s an attacker can reach — unbounded — and each of those sends
// invalidates the live code the owner may be typing. The cap's primary job is
// bounding outbound mail, and that fix destroys it.
//
// A SUB-BUDGET has neither property. The account cap is untouched and still bounds
// mail at three; within it, one origin may spend at most two. So the cheap attack
// — one address, one script — can no longer take the whole budget, and the
// account's owner keeps a send for themselves. A distributed attacker can still
// spend all three, and that is accepted: the alternative multiplies the mail, and
// the mail bound is the thing worth keeping. The desk reveal remains open on
// both paths.
//
// IN-PROCESS, deliberately. The platform is single-process by hard invariant, the
// window is ten minutes, and a restart resetting the sub-budget fails OPEN in the
// safe direction — the account cap still binds, so nothing can exceed three
// whatever happens here. A column would need a per-origin map in a scalar and a
// migration, to bound something the DB already bounds.
const LOGIN_CODE_MAX_SENDS_PER_ORIGIN = 2;
const _originSpend = new Map();          // `${userId}:${origin}` -> { n, resetAt }
const _ORIGIN_MAX_ENTRIES = 10_000;

/**
 * The caller's origin, widened so one attacker cannot simply change address.
 * /24 for IPv4 and /64 for IPv6 — the same shape the scanner tracker reasons
 * about, and wide enough that a single host's dynamic address stays one origin.
 * Also the source a /credential wrong-surname budget counts (routes/badge.js).
 * Returns null when the address is unusable, which SKIPS the sub-budget rather
 * than refusing: a caller we cannot attribute must not be handed somebody else's
 * budget, and the account cap still bounds them.
 *
 * The /64 is read from the address's eight groups, never from its text: an
 * address is written compressed ("2001:db8::1"), and the first four colon-
 * separated pieces of that text are not its first four groups, so every
 * address of one /64 could read as an origin of its own.
 */
function originKeyFor(ip) {
  const c = canonicaliseIp(ip == null ? "" : String(ip).split("%")[0]);
  if (!c) return null;
  if (net.isIPv4(c)) return c.split(".").slice(0, 3).join(".") + ".0/24";
  if (!net.isIPv6(c)) return null;
  const groups = _ipv6Groups(c);
  return groups ? groups.slice(0, 4).join(":") + "::/64" : null;
}

// The eight 16-bit groups of an IPv6 address, lower case without leading zeros,
// or null. `c` is canonicaliseIp's form: one "::" at most, hex groups only (the
// URL parser it uses rewrites a dotted IPv4 tail as two groups).
function _ipv6Groups(c) {
  const halves = c.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(g => g.toLowerCase());
  return groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map(g => g.replace(/^0+(?=.)/, "")) : null;
}

/** Has this origin already spent its share of the account's window? */
function _originExhausted(userId, origin, nowMs) {
  if (!origin) return false;
  const k = `${userId}:${origin}`;
  const e = _originSpend.get(k);
  if (!e || e.resetAt <= nowMs) return false;
  return e.n >= LOGIN_CODE_MAX_SENDS_PER_ORIGIN;
}

function _originSpendOne(userId, origin, nowMs, windowMs) {
  if (!origin) return;
  const k = `${userId}:${origin}`;
  const e = _originSpend.get(k);
  if (!e || e.resetAt <= nowMs) _originSpend.set(k, { n: 1, resetAt: nowMs + windowMs });
  else e.n += 1;
  // Oldest-first, never a wholesale clear: an attacker choosing distinct keys
  // controls the eviction, and clearing would reset every live sub-budget with it
  // — the v8.1.0 `_credFails` defect, which an attacker drove deliberately.
  if (_originSpend.size > _ORIGIN_MAX_ENTRIES) {
    for (const key of _originSpend.keys()) {
      _originSpend.delete(key);
      if (_originSpend.size <= _ORIGIN_MAX_ENTRIES) break;
    }
  }
}

/**
 * Which budget refused — asked by the route AFTER `issueCode` returned null, so
 * the participant's own History names the condition rather than conflating two.
 *
 * SAFE TO ASK AFTERWARDS: a refusal writes nothing, so the state this reads is
 * the state the refusal was taken on. And it must be asked SEPARATELY rather
 * than returned from `issueCode`, whose contract is a truthy code or null —
 * four call sites test `if (!issued)`, and widening that return is how one of
 * them comes to treat a refusal object as a success.
 */
function codeOriginExhausted(userId, originKey, at) {
  return _originExhausted(userId, originKey, (at || new Date()).getTime());
}

/** Test-only: the sub-budget is process-resident, so a spec must be able to clear it. */
function _resetOriginSpend() { const n = _originSpend.size; _originSpend.clear(); return n; }

// ── Re-send suppression ─────────────────────────────────────────────────────
//
// A double-submitted form, a second tab, or someone else typing the address
// must not supersede a code the holder received seconds ago: every mint
// replaces the stored hash, so an unthrottled re-mint is a cheap way to kill
// the code a person is typing. `codeRecentlySent` answers true while the last
// EMAILED mint for this account is younger than `LOGIN_CODE_RESEND_MIN_MS`;
// the email callers then answer their usual uniform 200 and mint nothing (the
// binding and the budget stay as they were, so the live mail still describes
// the live code). The desk reveal never asks: an organiser standing beside the
// walk-up must always get a working code.
//
// In-process like the origin sub-budget, for the same reason: a restart forgets
// it, which fails OPEN to the account cap, and nothing can exceed three sends.
const LOGIN_CODE_RESEND_MIN_MS = 120_000;
const _lastEmailMint = new Map();   // userId -> ms of the last EMAILED mint
const _LAST_MINT_MAX_ENTRIES = 10_000;
function codeRecentlySent(user, at) {
  if (!user || !codeIsLive(user, at)) return false;
  const t = _lastEmailMint.get(user.id);
  if (!t) return false;
  return ((at || now()).getTime() - t) < LOGIN_CODE_RESEND_MIN_MS;
}
function _noteEmailMint(userId, ms) {
  _lastEmailMint.delete(userId);
  _lastEmailMint.set(userId, ms);
  if (_lastEmailMint.size > _LAST_MINT_MAX_ENTRIES) {
    for (const k of _lastEmailMint.keys()) { _lastEmailMint.delete(k); if (_lastEmailMint.size <= _LAST_MINT_MAX_ENTRIES) break; }
  }
}
// A DESK code an organiser read out is kept for its WHOLE LIFE: the walk-up
// presses Continue on the entry screen and types it into the code step, and an
// emailed mint at any moment before it expires would kill the code they are
// holding (the dialog states the time it has left). Decided from
// the stored code itself (provenance + liveness), so a restart forgets nothing.
function deskCodeLive(user, at) {
  return !!user && user.login_code_via === CODE_VIA_DESK && codeIsLive(user, at);
}
/** Test-only: forget the re-send suppression (process-resident, like the origin budget). */
function _resetRecentSends() { const n = _lastEmailMint.size; _lastEmailMint.clear(); return n; }

// ── Test-only plaintext capture ─────────────────────────────────────────────
// Only the hash is stored, so a spec cannot read a minted code back from the
// database. Under NODE_ENV=test ONLY, the last plaintext per address is kept in
// memory (never persisted, never logged) for `GET /api/test/last-login-code`.
// A production process never writes to this map.
const _testLastCode = new Map();     // lower-cased email -> { code, at, via, competitionId }
function _testNoteCode(user, code, via, competitionId, mintedTo) {
  if (process.env.NODE_ENV !== "test" || !user) return;
  const entry = { code, at: Date.now(), via, competitionId: competitionId || null };
  for (const a of [user.email, user.secondary_email, mintedTo]) {
    if (typeof a === "string" && a) _testLastCode.set(a.toLowerCase(), entry);
  }
  if (_testLastCode.size > 20_000) _testLastCode.clear();
}
// Address proofs (lib/email-proof.js) are noted in the same map, `via:"proof"`,
// so GET /api/test/last-login-code returns whichever code was mailed last to an
// address — the spec helpers sign in and sign up through one read.
function _testNoteProof(email, code, competitionId) {
  if (process.env.NODE_ENV !== "test" || typeof email !== "string" || !email) return;
  _testLastCode.set(email.toLowerCase(), { code, at: Date.now(), via: "proof", competitionId: competitionId || null });
  if (_testLastCode.size > 20_000) _testLastCode.clear();
}
function _testLastLoginCode(email) {
  if (process.env.NODE_ENV !== "test") return null;
  return _testLastCode.get(String(email || "").trim().toLowerCase()) || null;
}

function issueCode(user, via, at, opts) {
  const n = at || now();
  const origin = (opts && opts.originKey) || null;
  const live = codeIsLive(user, n);
  const provenance = _normaliseVia(via);
  // v8.8.9 — THE CAP IS AN EMAIL BUDGET, AND ONLY THE EMAIL PATH SPENDS IT.
  //
  // It bounds how much mail one account can be made to send. The DESK reveal
  // sends none — the code is returned in the admin's own response body — so
  // charging it here refused a walk-up standing at the desk with the sentence
  // "this account has already been SENT the maximum number of codes", about a
  // path that sends nothing. It needed no attacker: register (mint 1), press
  // "send another" twice, walk to the desk, refused — in exactly the greylisted-
  // first-contact scenario the reveal exists for.
  //
  // It was also a v7.14.2 affordance that lies: codeBlockedReason has no
  // send-cap term, so the row still answers can_use_code, the kebab still offers
  // "Show sign-in code", and the desk-invite duplicate remedy still POINTS AT
  // the control the server then refused. Do NOT "fix" that by teaching
  // codeBlockedReason about the budget — that would make the three surfaces
  // agree by removing the in-room capability, which is the wrong direction.
  const spendsBudget = provenance === CODE_VIA_EMAIL;
  if (live && spendsBudget && (user.login_code_sends || 0) >= LOGIN_CODE_MAX_SENDS) return null;
  // The per-origin share of that same budget — see the block above. Only the
  // EMAIL path is subject to it, for the same reason the account cap is: a desk
  // reveal sends nothing, and charging it would refuse the walk-up standing in
  // front of the admin.
  if (spendsBudget && _originExhausted(user.id, origin, n.getTime())) return null;
  const code = mintCode();
  // THE EVENT BINDING BELONGS TO THE CODE. An emailed mint records the event the
  // request came from (a join link / QR / join code), or NULL for a plain request;
  // a desk mint always records NULL. Every mint overwrites it, so the binding is
  // always the one the newest mail names (sendLoginCodeEmail prints the event),
  // and only redeeming that code enrols — never the form submit.
  const boundComp = spendsBudget ? ((opts && opts.competitionId) || null) : null;
  _testNoteCode(user, code, provenance, boundComp, opts && opts.mintedTo);
  // A desk mint replaces the emailed code, so the mailbox no longer holds a live
  // one: forget the emailed mint, or the next emailed request would be
  // suppressed as "already sent" while the code it points at is dead.
  if (spendsBudget) _noteEmailMint(user.id, n.getTime());
  else _lastEmailMint.delete(user.id);
  // The window's anchor: unchanged on a re-issue, `now` on a fresh mint.
  const anchorMs = live ? new Date(user.login_code_at).getTime() : n.getTime();
  const expiresAt = new Date(anchorMs + LOGIN_CODE_TTL_MS);
  // Floor of one minute: "expires in 0 minutes" reads as already dead, and the
  // holder is about to type it.
  const expiresInMinutes = Math.max(1, Math.round((expiresAt.getTime() - n.getTime()) / 60_000));
  if (live) {
    // The counter moves only for a send. A desk reveal re-mints inside the
    // window and leaves the participant the emails they have not had.
    db_().prepare(spendsBudget
      ? "UPDATE users SET login_code_hash=?, login_code_via=?, login_code_comp_id=?, login_code_sends = login_code_sends + 1 WHERE id=?"
      : "UPDATE users SET login_code_hash=?, login_code_via=?, login_code_comp_id=? WHERE id=?")
      .run(hashCode(code), provenance, boundComp, user.id);
    if (spendsBudget) _originSpendOne(user.id, origin, n.getTime(), LOGIN_CODE_TTL_MS);
    return { code, reissued: true, expiresAt, expiresInMinutes };
    // (the fresh branch below spends too — see the note there)
  }
  // THE FRESH BRANCH IS AN ASSIGNMENT, WHICH IS THE TRAP. It opens a new window
  // and OVERWRITES the counter, so a desk mint that merely skipped the increment
  // above would stamp a fresh login_code_at over a stale sends=3 and then refuse
  // the participant's next EMAILED request having sent them nothing. It writes 0.
  db_().prepare("UPDATE users SET login_code_hash=?, login_code_via=?, login_code_comp_id=?, login_code_at=?, login_code_sends=? WHERE id=?")
    .run(hashCode(code), provenance, boundComp, n.toISOString(), spendsBudget ? 1 : 0, user.id);
  // …and the origin's share is spent on THIS branch too. The fresh mint is the
  // FIRST of the window's three, so omitting it here would give every origin a
  // free send — an attacker's first request would cost them nothing, which is
  // exactly the request that opens the window they are trying to exhaust.
  if (spendsBudget) _originSpendOne(user.id, origin, n.getTime(), LOGIN_CODE_TTL_MS);
  return { code, reissued: false, expiresAt, expiresInMinutes };
}

/**
 * Resolve one redemption ATTEMPT of an (email, code) pair.
 *
 * KEYED ON THE PAIR, NEVER ON THE CODE ALONE. A global `WHERE code=?` lookup is
 * fine for a 122-bit UUID and catastrophic for a short code: a guess would
 * become a guess against EVERY live code on the platform, and the handler would
 * never learn which account was attacked, so no per-account control would be
 * possible.
 *
 * **IT RETURNS THE ACCOUNT EVEN WHEN THE CODE IS WRONG, and that is the whole
 * reason it is shaped like this rather than answering `row | null`.** The
 * platform documents — in lib/lockout.js, in this file's own header and in the
 * entropy arithmetic that picked 8 characters — that a sign-in code shares the
 * account's ten-failure budget. A resolver that collapses "no such address" and
 * "wrong code" into one null makes that impossible to implement: there is
 * nothing to charge. The caller needs the attempted account to charge it.
 *
 * `wellFormed` separates a GUESS from a TYPO. A string that is not even in the
 * code space cannot be an attempt at the credential, so the caller does not
 * charge the budget for it — which costs an attacker nothing (their guesses are
 * well-formed by construction) and stops someone fumbling eight characters off a
 * screen at a noisy stand from locking their own account out of the one door
 * they have.
 */
function resolveCodeAttempt(email, rawCode) {
  // Indexed (lib/account-lookup.js): the LOWER() form scanned every user per redeem.
  // The PRIMARY address only: a secondary never signs in (lib/account-lookup.js).
  const user = findUserByPrimary(db_(), email);
  const code = normaliseCode(rawCode);
  // Hash UNCONDITIONALLY — with no row, and for a malformed code — so response
  // time does not answer "does this address exist" (v7.15.14: awaiting SMTP made
  // response time exactly that oracle on a code-mailing path).
  const want = hashCode(code);
  const out = { user, wellFormed: !!code, matched: false };
  if (!user || !code) return out;
  // timingSafeEqual throws on a length mismatch, hence the guard; both sides are
  // sha256 hex, so equal length is the norm and a stored value that is not
  // simply fails closed.
  if (typeof user.login_code_hash !== "string" || user.login_code_hash.length !== want.length) return out;
  const ok = crypto.timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(user.login_code_hash, "hex"));
  out.matched = !!ok && codeIsLive(user);
  return out;
}

// Clearing the code clears its PROVENANCE in the same statement. A stale
// 'email' marker outliving the code it described would be read by the next
// redemption of a DIFFERENT code as proof of a mailbox nobody proved.
//
// A clear also CLOSES THE WINDOW for the per-origin sub-budget and the re-send
// suppression: the sub-budget is a share of one window's three sends, and a
// redeemed (or superseded-by-desk) code has ended that window. Without this,
// someone signing in a third time inside ten minutes from one address would be
// refused a code with nothing wrong — and for most accounts codes are the only door.
// Every login_code_* column a spent code leaves, named once for both clears
// (`clearCode`, and the redeem's claim `consumeCode`): the two must never clear
// different sets.
const _CLEAR_CODE_SET = "login_code_hash=NULL, login_code_at=NULL, login_code_via=NULL, login_code_comp_id=NULL, login_code_sends=0";

function clearCode(userId) {
  _forgetCodeWindow(userId);
  return db_().prepare(`UPDATE users SET ${_CLEAR_CODE_SET} WHERE id=?`).run(userId);
}

function _forgetCodeWindow(userId) {
  const prefix = userId + ":";
  for (const k of _originSpend.keys()) if (k.startsWith(prefix)) _originSpend.delete(k);
  _lastEmailMint.delete(userId);
}

// The redeem's CLAIM: clears the code exactly as `clearCode` does, but only while
// the stored hash is still the one the caller matched (compare-and-swap), and
// returns how many rows it changed. Exactly one redeem of a code gets 1, however
// the requests interleave; any other answers as a wrong code. Single use does not
// rest on the redeem having no await between its match and its write (the
// address proof's DELETE is the same claim, lib/email-proof.js).
function consumeCode(userId, hash) {
  if (!hash) return 0;
  const r = db_().prepare(`UPDATE users SET ${_CLEAR_CODE_SET} WHERE id=? AND login_code_hash=?`).run(userId, hash);
  if (r.changes === 1) _forgetCodeWindow(userId);
  return r.changes;
}

// An EMAILED code whose mail was refused or failed is held by nobody, so its
// re-send suppression protects nothing. Lift it — only while that code is still
// the stored one (a desk reveal or another mint meanwhile is somebody's live
// code) — so the next request mints a fresh code at once instead of answering
// that one is already on its way. The send budget it spent stays spent.
function liftResendSuppression(userId, code) {
  const row = db_().prepare("SELECT login_code_hash FROM users WHERE id=?").get(userId);
  if (!row || row.login_code_hash !== hashCode(code)) return false;
  _lastEmailMint.delete(userId);
  return true;
}

// ── Metrics ──────────────────────────────────────────────────────────────────
// Because BOTH endpoints answer 200 always (see the routes for why — a non-429
// 4xx feeds the scanner-reputation counter, which blocks a whole NAT at 100 in
// ten minutes, and a code is read off one screen and typed into another far more
// often than a password is mistyped), they are the only unauthenticated surfaces
// contributing nothing to that counter. Metrics are therefore their ONLY
// monitoring — v7.25.0's "the notification WAS the monitoring", applied before
// the fact rather than after.
//
// `outcome="ineligible"` counts what was refused for the account or the address
// rather than throttled. On a request: an empty or malformed address, a blocked
// or denied account, and a new address refused an address proof (free-mail with
// no invitation, or a reserved address), so ordinary free-mail visitors raise it
// too; the audited reasons (`login_code_refused`, `email_proof_refused`) say
// which, except for an empty or malformed address, which is counted and never
// recorded. On a redeem: a correct code refused, for a blocked or denied account or
// a desk code whose account is no longer a participant or has signed in since.
// `unrecorded`: an address-proof refusal past its source's record budget
// (routes/auth.js `_sendEmailProof`), counted by reason instead of written.
const _counters = { request: Object.create(null), redeem: Object.create(null), drop: Object.create(null), unrecorded: Object.create(null) };
function countCodeOutcome(kind, outcome) {
  const bucket = _counters[kind];
  if (!bucket) return;
  bucket[outcome] = (bucket[outcome] || 0) + 1;
}
function loginCodeCounters() {
  return { request: { ..._counters.request }, redeem: { ..._counters.redeem }, drop: { ..._counters.drop }, unrecorded: { ..._counters.unrecorded } };
}

module.exports = {
  codeBlockedReason, hasSignedIn,
  ALPHABET, CODE_LEN,
  CODE_VIA_EMAIL, CODE_VIA_DESK, codeProvesEmail,
  mintCode, formatCode, normaliseCode, hashCode, codeDropTag, codeIsLive,
  isCodeEligible, issueCode, resolveCodeAttempt, clearCode, consumeCode, liftResendSuppression,
  codeRecentlySent, deskCodeLive, LOGIN_CODE_RESEND_MIN_MS, _resetRecentSends, _testLastLoginCode, _testNoteProof,
  LOGIN_CODE_MAX_SENDS_PER_ORIGIN, originKeyFor, codeOriginExhausted, _resetOriginSpend,
  countCodeOutcome, loginCodeCounters,
};
