"use strict";

// THE MAIL RELAY SAVED IN THE APP (Settings → Email (SMTP)).
//
// A superadmin may save the relay a running server sends through: host, port,
// security, username, password and sender address. This module owns what is
// STORED (the `settings` row `smtp_config`), how its password is kept
// (encrypted), and what a write may contain. lib/email.js owns the transport and
// decides which configuration is in force (a saved one replaces the server's
// environment entirely; see `effectiveSmtpConfig` there), so the environment is
// read in one place.
//
// THE PASSWORD IS ENCRYPTED AT REST with AES-256-GCM under a 32-byte key in
// `DATA_DIR/.smtp-key` (0600, created with `wx`). The key is deliberately NOT in
// backups (scripts/backup.sh BACKUP_EXEMPT): a backup carrying both the key and
// the database would carry the password in a recoverable form. So after a
// restore (or a migration to another server) the saved password cannot be read;
// lib/email.js then sends through the environment's relay if it names one, the
// Settings card says the password must be entered again, and nothing is lost but
// that one value. The password never leaves the server: no response, log line,
// audit row or export carries it or its ciphertext.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");
const { swallowed } = require("./best-effort");

const SMTP_SETTING_KEY = "smtp_config";
const SMTP_KEY_PATH = path.join(DATA_DIR, ".smtp-key");
const _KEY_BYTES = 32;
const _AAD = Buffer.from("hack-arena smtp password v1");
const SECURITY_MODES = Object.freeze(["starttls", "tls"]);
const SMTP_FIELD_MAX = Object.freeze({ host: 253, username: 254, password: 512, sender: 254 });

// ── The key ──────────────────────────────────────────────────────────────────
/** The key, or null when it is missing or unusable. Never creates one. */
function _readKey() {
  try {
    const buf = fs.readFileSync(SMTP_KEY_PATH);
    return buf.length === _KEY_BYTES ? buf : null;
  } catch (e) {
    if (e.code !== "ENOENT") swallowed("smtp-settings:key-read", e, { level: "warn" });
    return null;
  }
}

/**
 * The key, created if missing (`wx`, 0600). A file of the wrong length is
 * replaced atomically: nothing encrypted under it can be read anyway. A racing
 * creator's key is adopted when it is usable. Throws when no key can be kept on
 * disk: a save must not store a password that the next boot cannot read.
 */
function _ensureKey() {
  const have = _readKey();
  if (have) return have;
  const exists = fs.existsSync(SMTP_KEY_PATH);
  const fresh = crypto.randomBytes(_KEY_BYTES);
  try {
    if (exists) {
      const tmp = `${SMTP_KEY_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, SMTP_KEY_PATH);
    } else {
      fs.writeFileSync(SMTP_KEY_PATH, fresh, { mode: 0o600, flag: "wx" });
    }
  } catch (e) {
    if (e.code === "EEXIST" && !exists) {
      const peer = _readKey();
      if (peer) return peer;
    }
    throw e;
  }
  try { fs.chmodSync(SMTP_KEY_PATH, 0o600); } catch (e) { swallowed("smtp-settings:key-chmod", e); }
  return fresh;
}

const _b64 = (b) => b.toString("base64url");

/** `v1.<iv>.<tag>.<ciphertext>`, base64url. Creates the key when needed. */
function encryptPassword(plain) {
  const key = _ensureKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(_AAD);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1.${_b64(iv)}.${_b64(c.getAuthTag())}.${_b64(ct)}`;
}

/** The password, or null when the key is missing or does not open it. */
function decryptPassword(blob) {
  if (typeof blob !== "string") return null;
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const key = _readKey();
  if (!key) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    d.setAAD(_AAD);
    d.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([d.update(Buffer.from(parts[3], "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    // A different key (a restore, a replaced key file) or a damaged value:
    // unreadable, which the caller reports. Never the error text.
    swallowed("smtp-settings:decrypt", e);
    return null;
  }
}

// ── What a write may contain ─────────────────────────────────────────────────
const _CTRL = /[\u0000-\u001F\u007F-\u009F]/;
const _HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const _IPV6_RE = /^[0-9A-Fa-f:]{2,39}$/;
// A bare addr-spec: the display name always comes from the platform name
// (lib/email.js resolveSender), so a mailbox with a name is refused here rather
// than half-read.
const _SENDER_RE = /^[^<>\s,@"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function _bad(code, field, error) { return { ok: false, code, field, error }; }

/**
 * Validate a relay sent from the form. `password` is optional: absent means
 * "keep the saved one" (the route decides whether that is allowed). Returns
 * `{ok:true, value}` or `{ok:false, code, field, error}`.
 */
function validateSmtpInput(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  for (const f of ["host", "security", "username", "sender"]) {
    if (typeof b[f] !== "string") return _bad("smtp_field_invalid", f, `The ${_LABEL[f]} must be text.`);
  }
  if (b.password !== undefined && typeof b.password !== "string") return _bad("smtp_field_invalid", "password", "The password must be text.");
  const host = b.host.trim();
  if (!host) return _bad("smtp_field_invalid", "host", "Enter the mail server's host name.");
  if (host.length > SMTP_FIELD_MAX.host || !(_HOST_RE.test(host) || _IPV6_RE.test(host))) {
    return _bad("smtp_field_invalid", "host", "The host must be a host name (smtp.example.com) or an IP address, with no spaces, port or scheme.");
  }
  const port = typeof b.port === "number" ? b.port : (typeof b.port === "string" && /^\d{1,5}$/.test(b.port.trim()) ? Number(b.port.trim()) : NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return _bad("smtp_field_invalid", "port", "The port must be a whole number from 1 to 65535.");
  if (!SECURITY_MODES.includes(b.security)) return _bad("smtp_field_invalid", "security", "Choose STARTTLS or TLS for the connection's security.");
  const username = b.username.trim();
  if (username.length > SMTP_FIELD_MAX.username || _CTRL.test(username)) {
    return _bad("smtp_field_invalid", "username", `The username must be at most ${SMTP_FIELD_MAX.username} characters, with no control characters.`);
  }
  let password;
  if (b.password !== undefined && b.password !== "") {
    if (b.password.length > SMTP_FIELD_MAX.password || _CTRL.test(b.password)) {
      return _bad("smtp_field_invalid", "password", `The password must be at most ${SMTP_FIELD_MAX.password} characters, with no control characters.`);
    }
    password = b.password;
  }
  const sender = b.sender.trim();
  if (sender.length > SMTP_FIELD_MAX.sender || !_SENDER_RE.test(sender)) {
    return _bad("smtp_field_invalid", "sender", "The sender must be one email address, such as no-reply@example.com (the name shown is the platform name).");
  }
  return { ok: true, value: { host, port, security: b.security, username, password, sender } };
}
const _LABEL = { host: "host", security: "security", username: "username", sender: "sender address" };

// ── The stored row ───────────────────────────────────────────────────────────
function _row(db) {
  return db.prepare("SELECT value FROM settings WHERE key=?").get(SMTP_SETTING_KEY)?.value ?? null;
}

/**
 * The saved relay, or null when none is saved (or the row is unusable, which is
 * logged and read as none, so the environment's relay keeps the mail going).
 * The password stays encrypted here: `password_enc` (or null for no password).
 */
function readStoredSmtp(db) {
  const raw = _row(db);
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.host === "string" && v.host && Number.isInteger(v.port) && SECURITY_MODES.includes(v.security)
        && typeof v.username === "string" && typeof v.sender === "string"
        && (v.password_enc === null || typeof v.password_enc === "string")) {
      return { host: v.host, port: v.port, security: v.security, username: v.username, sender: v.sender,
        password_enc: v.password_enc, saved_at: typeof v.saved_at === "string" ? v.saved_at : null };
    }
  } catch (e) { swallowed("smtp-settings:row-parse", e, { level: "warn" }); }
  return null;
}

/** The saved row's version (a digest of the stored text), or null when none is saved. */
function storedSmtpVersion(db) {
  const raw = _row(db);
  return raw == null ? null : crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Store a relay. `passwordEnc` is the ciphertext to keep, or null for none. */
function writeStoredSmtp(db, cfg, passwordEnc, savedAt) {
  const value = JSON.stringify({
    host: cfg.host, port: cfg.port, security: cfg.security, username: cfg.username, sender: cfg.sender,
    password_enc: passwordEnc, saved_at: savedAt,
  });
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SMTP_SETTING_KEY, value);
}

function clearStoredSmtp(db) {
  db.prepare("DELETE FROM settings WHERE key=?").run(SMTP_SETTING_KEY);
}

module.exports = {
  SMTP_SETTING_KEY, SMTP_KEY_PATH, SECURITY_MODES, SMTP_FIELD_MAX,
  encryptPassword, decryptPassword, validateSmtpInput,
  readStoredSmtp, storedSmtpVersion, writeStoredSmtp, clearStoredSmtp,
};
