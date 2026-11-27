"use strict";

// Platform-settings accessors backed by the `settings` table. Currently the
// memoized platform-name lookup; the home for future cached settings reads.
// (Domain: Settings. Code/table term: `settings`.) Deps: db only.
// (v7.0.0 refactor: extracted from server.js.)

const db = require("../db");
const { findUserByAddress } = require("./account-lookup");

// Memoized. getPlatformName is called on every /api/config (pre-login hot path)
// AND on every outbound email build (~28 call sites), each otherwise running a
// settings-table SELECT. The value changes only via PATCH /api/admin/settings,
// which calls _invalidatePlatformNameCache after writing. `null` = not-yet-
// resolved (distinct from a cached empty result, though the COALESCE chain
// never yields empty).
let _platformNameCache = null;
function _invalidatePlatformNameCache() { _platformNameCache = null; }
function getPlatformName() {
  if (_platformNameCache !== null) return _platformNameCache;
  _platformNameCache = db.prepare("SELECT value FROM settings WHERE key='platform_name'").get()?.value
    // v7.29.0 - the default is the product's own name. "Tournament" was a
    // placeholder that leaked into the header wordmark, the <title>, the login
    // card and every email subject on any deployment that never set one.
    || process.env.COMPETITION_NAME || "Checkmarx Enablement Platform";
  return _platformNameCache;
}

// `require_account_approval` — when "1", a self-registered account waits for an
// admin's approval even after it proves its inbox with an emailed code (the
// approval queue). Default OFF: redeeming an emailed code approves a pending,
// not-denied account (routes/auth.js). Read uncached: it is consulted once per
// redemption, and an uncached read can never serve a stale answer after a
// superadmin flips it.
function getRequireAccountApproval() {
  try {
    return db.prepare("SELECT value FROM settings WHERE key='require_account_approval'").get()?.value === "1";
  } catch (_) { return false; }
}

// `breakglass_username` — the USERNAME of the one break-glass account (the
// built-in superadmin; its password is boot-generated in
// DATA_DIR/.superadmin-password). Default `superadmin`. Stored lower-cased and
// compared case-insensitively. Read uncached: POST /api/login asks once per
// attempt, and only the built-in session can change it. It is NEVER sent to an
// anonymous client: it is typed into the sign-in card's email box (anything that
// is not an address shows the password box, so the card never confirms a name),
// and every wrong pair gets the one generic answer.
const BREAKGLASS_DEFAULT_USERNAME = "superadmin";
function getBreakglassUsername() {
  try {
    const v = db.prepare("SELECT value FROM settings WHERE key='breakglass_username'").get()?.value;
    return (typeof v === "string" && v) ? v : BREAKGLASS_DEFAULT_USERNAME;
  } catch (_) { return BREAKGLASS_DEFAULT_USERNAME; }
}
/**
 * True when some account holds `name` as its primary or secondary address. Every
 * attempt naming the current username asks it, so it is the two indexed point
 * lookups of lib/account-lookup.js, never a LOWER() comparison that scans every
 * account: the cost of that attempt must not grow with the platform.
 */
function breakglassNameHeldByAccount(name) {
  return !!findUserByAddress(db, name, "id");
}
/**
 * Validate a proposed username. Returns `{ ok:true, value }` (lower-cased) or
 * `{ ok:false, code, error }`. 3–64 printable non-space ASCII characters, no
 * `@` (so it can never be read as an address at the sign-in screen), and never
 * an account's primary or secondary address.
 */
function validateBreakglassUsername(raw) {
  if (typeof raw !== "string") return { ok: false, code: "username_invalid", error: "The username must be text." };
  const v = raw.trim().toLowerCase();
  if (v.length < 3 || v.length > 64) return { ok: false, code: "username_length", error: "The username must be 3 to 64 characters." };
  if (!/^[\x21-\x7E]+$/.test(v)) return { ok: false, code: "username_charset", error: "The username may use letters, digits and symbols only — no spaces or control characters." };
  if (v.includes("@")) return { ok: false, code: "username_at_sign", error: "The username may not contain @, so it can never be mistaken for an email address." };
  if (breakglassNameHeldByAccount(v)) return { ok: false, code: "username_taken", error: "An account uses that as its email address. Choose another username." };
  return { ok: true, value: v };
}

module.exports = {
  getPlatformName, _invalidatePlatformNameCache, getRequireAccountApproval,
  BREAKGLASS_DEFAULT_USERNAME, getBreakglassUsername, validateBreakglassUsername, breakglassNameHeldByAccount,
};
