"use strict";

// HOW AN ACCOUNT SIGNS IN: with its password, or with an emailed one-time code.
//
// Every account row has ONE sign-in method (operator ruling, 11 Nov 2026):
//   • `users.login_method` NULL — the ROLE decides: an unscoped admin role
//     (class `all`: the built-in admin and superadmin, and every custom unscoped
//     role) signs in with a password, every other role with a code. A NULL row
//     follows its role, so a promotion moves the default; a stored value is the
//     person's own choice and no role change touches it.
//   • `users.login_method` 'password' | 'code' — chosen in the profile
//     (`PUT /api/me/sign-in-method`, routes/auth.js).
//
// A password is a PREFERENCE, never the only door: every account can still ask
// for an emailed code ("Email me a code instead"), so a forgotten password is
// recovered by signing in with a code and setting a new one. The one account
// with no code door is the built-in superadmin (no row, no address).
//
// A password is USABLE only when it was really set — `password_set_at` stamped
// AND a bcrypt hash stored. Rows created since email-first, imported ones
// included, store the fixed `NO_PASSWORD_HASH` placeholder with `password_set_at`
// NULL; accounts upgraded from v8.14.x keep the password they had there
// (operator ruling: those passwords are honoured).
//
// Pure apart from the lazily required role class, so any module may require it.

const crypto = require("crypto");

const LOGIN_METHODS = Object.freeze(["password", "code"]);
const BCRYPT_COST = 10;

// bcrypt hashes only the first 72 BYTES of its input and ignores the rest, so a
// new password is capped at 72 UTF-8 bytes (byte length: an emoji password can
// pass 72 bytes in 30 characters). An older, longer password keeps working —
// bcrypt still reads its first 72 bytes — until it is next changed.
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_BYTES = 72;
function passwordLengthError(password) {
  if (typeof password !== "string" || !password) return "Enter a password.";
  if (password.length < PASSWORD_MIN_CHARS) return `Use at least ${PASSWORD_MIN_CHARS} characters.`;
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return `Use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} characters; fewer with accents or emoji).`;
  }
  return null;
}

const _BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Does this row hold a password its owner set? Throws on a partial row. */
function hasUsablePassword(user) {
  if (!user || !("password_set_at" in user) || !("password_hash" in user)) {
    throw new Error("hasUsablePassword: the row must carry password_set_at and password_hash");
  }
  return !!user.password_set_at && typeof user.password_hash === "string" && _BCRYPT_RE.test(user.password_hash);
}

/** The method a role gets when its holder has not chosen one. */
function roleDefaultLoginMethod(role) {
  const { roleClass } = require("./rbac");
  return roleClass(role || "participant") === "all" ? "password" : "code";
}

/** The method this account signs in with. Throws on a row missing the keys. */
function effectiveLoginMethod(user) {
  if (!user || !("login_method" in user) || !("role" in user)) {
    throw new Error("effectiveLoginMethod: the row must carry login_method and role");
  }
  return LOGIN_METHODS.includes(user.login_method) ? user.login_method : roleDefaultLoginMethod(user.role);
}

/**
 * What the client is told about its own sign-in: the method in force, whether
 * it is the role's default (nothing chosen), whether a password is set, and
 * whether the account owes one (password method, none set — the sign-in asks
 * for one, or for a switch to codes).
 */
function loginMethodWire(user) {
  const method = effectiveLoginMethod(user);
  const hasPassword = hasUsablePassword(user);
  return {
    login_method: method,
    login_method_is_default: !LOGIN_METHODS.includes(user.login_method),
    has_password: hasPassword,
    password_required: method === "password" && !hasPassword,
  };
}

// A real bcrypt hash of a random secret, compared against whenever there is no
// password to check (unknown address, code account, no password set), so every
// outcome of the password door costs one bcrypt. Made once, on first use.
let _dummyHash = null;
function dummyPasswordHash() {
  if (!_dummyHash) _dummyHash = require("bcrypt").hashSync(crypto.randomBytes(18).toString("base64"), BCRYPT_COST);
  return _dummyHash;
}

module.exports = {
  LOGIN_METHODS, BCRYPT_COST, PASSWORD_MIN_CHARS, PASSWORD_MAX_BYTES,
  passwordLengthError, hasUsablePassword, roleDefaultLoginMethod, effectiveLoginMethod, loginMethodWire,
  dummyPasswordHash,
};
