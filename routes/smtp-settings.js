"use strict";

// SETTINGS → EMAIL (SMTP): the mail relay the platform sends through.
//
//   GET    /api/admin/smtp-settings       the relay in force and where it comes
//                                         from (settings.view: every reader of
//                                         Settings sees the server in use)
//   PUT    /api/admin/smtp-settings       save a relay (ops.smtp: superadmin only,
//                                         not grantable)
//   DELETE /api/admin/smtp-settings       remove the saved relay, back to the
//                                         environment (ops.smtp)
//   POST   /api/admin/smtp-settings/test  send one test through UNSAVED values
//                                         (ops.smtp)
//
// THE PASSWORD NEVER LEAVES THE SERVER. Reads say only whether one is set; it is
// encrypted at rest (lib/smtp-settings.js); the audit records which fields
// changed and the old and new values of the host, port, security and sender only
// (the username is half a credential, the password all of one).
//
// A SAVED PASSWORD IS SENT ONLY TO THE RELAY IT WAS SAVED FOR. A save or a test
// that leaves the password box empty keeps the password in force only when the
// host and username are unchanged; otherwise the password must be typed. Without
// this rule a superadmin's typo, or anyone holding the session for a minute,
// could send the relay's password to a host of their choosing.
//
// The relay in force is decided in lib/email.js (`effectiveSmtpConfig`): a saved
// relay replaces the environment's as a whole; a save or removal swaps the pool
// live (`reloadSmtpTransport`), with no restart and no mail in flight lost.

const db = require("../db");
const { requireAdmin, requirePermission, destructiveAdminLimit, csrfProtection } = require("../lib/middleware");
const { getAdminIdentity, recordSettingsEvent, recordOrphanedAuditEvent, runTxnWithMirrorBuffer, reqContext } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { now } = require("../lib/time");
const { getPlatformName } = require("../lib/settings");
const { PLATFORM_VERSION } = require("../lib/config");
const store = require("../lib/smtp-settings");
const email = require("../lib/email");

const _NON_SECRET = ["host", "port", "security", "sender"];

/** What every reader of the Email section is shown. Never a password. */
function _view(req) {
  const cfg = email.effectiveSmtpConfig();
  const saved = cfg ? cfg.saved : store.readStoredSmtp(db);
  const last = email.smtpLastCheck();
  const health = email.smtpHealthy();
  let canEdit = false;
  try { canEdit = require("../lib/rbac").actorPermissions(req).perms.has("ops.smtp") && !req.session?.impersonator; }
  catch (e) { swallowed("smtp-settings:can-edit", e); }
  return {
    in_use: cfg ? {
      source: cfg.source,
      host: cfg.host, port: cfg.port, security: cfg.security, username: cfg.username,
      sender: cfg.sender, sender_source: cfg.sender_source,
      password_set: !!cfg.password,
    } : null,
    saved: saved ? {
      host: saved.host, port: saved.port, security: saved.security, username: saved.username,
      sender: saved.sender, password_set: !!saved.password_enc, saved_at: saved.saved_at,
    } : null,
    password_unreadable: !!(cfg && cfg.password_unreadable),
    environment_relay: !!(cfg && cfg.environment_relay),
    plaintext_allowed: email.smtpPlaintextAllowed(),
    health: { state: health === true ? true : health === false ? false : null, checked_at: last ? last.at : null },
    version: store.storedSmtpVersion(db),
    can_edit: canEdit,
  };
}

function _refuse(res, status, code, error, field) {
  return res.status(status).json({ error, code, ...(field ? { field } : {}) });
}

/** The expectedVersion check: absent is unchecked; null means "nothing saved". */
function _staleVersion(req) {
  const ev = req.body?.expectedVersion;
  if (ev === undefined) return false;
  if (ev !== null && typeof ev !== "string") return "invalid";
  return (ev || null) !== store.storedSmtpVersion(db);
}

/**
 * The password a save or test will use: the typed one; none when there is no
 * username; else the one in force, only for the same host and username (the
 * saved ciphertext is kept as it is when it is that one). Returns
 * `{password, keepEnc}` or `{refuse}`.
 */
function _resolvePassword(v) {
  if (!v.username) return { password: "" };
  if (v.password) return { password: v.password };
  const cur = email.effectiveSmtpConfig();
  const saved = cur && cur.saved;
  if (saved && saved.password_enc && !cur.password_unreadable && cur.source === "app"
      && saved.host.toLowerCase() === v.host.toLowerCase() && saved.username === v.username) {
    return { password: cur.password, keepEnc: saved.password_enc };
  }
  if (cur && cur.password && cur.host.toLowerCase() === v.host.toLowerCase() && cur.username === v.username) {
    return { password: cur.password };
  }
  return { refuse: true };
}
const _PASSWORD_REQUIRED = "Enter the password. A saved password is used again only for the same host and username, and only when this server can read it.";

module.exports = function register(app) {
  app.get("/api/admin/smtp-settings", requireAdmin, requirePermission("settings.view"), (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(_view(req));
  });

  app.put("/api/admin/smtp-settings", requireAdmin, requirePermission("ops.smtp"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const stale = _staleVersion(req);
    if (stale === "invalid") return _refuse(res, 400, "smtp_field_invalid", "expectedVersion must be text or null.", "expectedVersion");
    const v = store.validateSmtpInput(req.body);
    if (!v.ok) return _refuse(res, 400, v.code, v.error, v.field);
    if (stale) return _refuse(res, 409, "smtp_settings_changed", "Someone changed the mail server settings since you opened them. Reload the page to see them, then make your change again.");
    const pw = _resolvePassword(v.value);
    if (pw.refuse) return _refuse(res, 400, "smtp_password_required", _PASSWORD_REQUIRED, "password");
    let enc = null;
    if (pw.keepEnc) enc = pw.keepEnc;
    else if (pw.password) {
      try { enc = store.encryptPassword(pw.password); }
      catch (e) {
        swallowed("smtp-settings:encrypt", e, { level: "warn" });
        return _refuse(res, 500, "smtp_key_unavailable", "The password could not be stored: the server could not write its key file. Nothing was changed.");
      }
    }
    const before = email.effectiveSmtpConfig();
    const value = v.value;
    const changed = [];
    for (const f of ["host", "port", "security", "username", "sender"]) {
      if (!before || before.source !== "app" || String(before[f]) !== String(value[f])) changed.push(f);
    }
    const passwordChanged = !pw.keepEnc && (!before || before.source !== "app" || (before.password || "") !== (pw.password || ""));
    if (passwordChanged) changed.push("password");
    const details = { changed, from_source: before ? before.source : null, password_set: !!enc, password_changed: passwordChanged };
    for (const f of _NON_SECRET) {
      if (changed.includes(f)) details[f] = { from: before ? before[f] : null, to: value[f] };
    }
    const txn = db.transaction(() => {
      store.writeStoredSmtp(db, value, enc, now().toISOString());
      recordSettingsEvent("smtp", "updated", getAdminIdentity(req), { ...details, ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => txn());
    email.reloadSmtpTransport("settings_saved");
    res.json({ ok: true, ...(_view(req)) });
  });

  app.delete("/api/admin/smtp-settings", requireAdmin, requirePermission("ops.smtp"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const stale = _staleVersion(req);
    if (stale === "invalid") return _refuse(res, 400, "smtp_field_invalid", "expectedVersion must be text or null.", "expectedVersion");
    if (stale) return _refuse(res, 409, "smtp_settings_changed", "Someone changed the mail server settings since you opened them. Reload the page to see them.");
    const saved = store.readStoredSmtp(db);
    if (!saved && store.storedSmtpVersion(db) === null) return res.json({ ok: true, changed: false, ...(_view(req)) });
    const cur = email.effectiveSmtpConfig();
    if (!cur || !cur.environment_relay) {
      return _refuse(res, 409, "smtp_environment_missing", "The server's environment names no mail server (SMTP_HOST), so removing these settings would stop all email. Change them instead.");
    }
    const txn = db.transaction(() => {
      store.clearStoredSmtp(db);
      recordSettingsEvent("smtp", "cleared", getAdminIdentity(req), { ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => txn());
    email.reloadSmtpTransport("settings_cleared");
    res.json({ ok: true, changed: true, ...(_view(req)) });
  });

  app.post("/api/admin/smtp-settings/test", requireAdmin, requirePermission("ops.smtp"), destructiveAdminLimit, csrfProtection, async (req, res) => {
    const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    if (!to || to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return _refuse(res, 400, "smtp_test_recipient_invalid", "Enter the address to send the test to.", "to");
    }
    const v = store.validateSmtpInput(req.body);
    if (!v.ok) return _refuse(res, 400, v.code, v.error, v.field);
    const pw = _resolvePassword(v.value);
    if (pw.refuse) return _refuse(res, 400, "smtp_password_required", _PASSWORD_REQUIRED, "password");
    const cfg = { ...v.value, password: pw.password || "" };
    const platform = getPlatformName();
    const out = await email.sendSmtpTest(cfg, {
      to,
      subject: `${platform} — SMTP test`,
      text: `This is a test message from ${platform} v${PLATFORM_VERSION}, sent at ${new Date().toISOString()} through ${cfg.host}:${cfg.port} with settings that are not saved yet. If you received this, these settings deliver mail.`,
    });
    try {
      recordOrphanedAuditEvent("email", to, "test_email_sent", getAdminIdentity(req), {
        ok: out.ok, via: "unsaved_settings", host: cfg.host, port: cfg.port, security: cfg.security,
        ...(out.ok ? {} : { error: out.error }), ...reqContext(req),
      });
    } catch (e) { swallowed("smtp-settings:test-audit", e); }
    if (out.ok) return res.json({ ok: true });
    res.status(502).json({ ok: false, error: out.error, code: "smtp_test_failed" });
  });
};
