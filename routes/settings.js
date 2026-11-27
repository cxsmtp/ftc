"use strict";

// Platform settings routes (read config, update platform name, settings event
// history). Registered from server.js via register(app) using ABSOLUTE method-
// specific paths. (v7.0.0 refactor: route split extracted from server.js.)

const db = require("../db");
const { requireAdmin, requireSuperAdmin, csrfProtection, rateLimit } = require("../lib/middleware");

// THE PLATFORM LOOK (lib/platform-look.js): the look, mode and light colour every
// browser starts from, set by a superadmin. `default_look` is its look field (the
// Appearance page's older single-look control still saves through it). The ids
// mirror public/js/ui/theme.js and public/theme-boot.js (client/server mirror
// registry in CLAUDE.md): an unknown id is refused, never stored.
const { getPlatformLook, validatePlatformLook, setPlatformLook, LOOK_IDS: _LOOK_LIST } = require("../lib/platform-look");
const { now } = require("../lib/time");
const LOOK_IDS = new Set(_LOOK_LIST);
function getDefaultLook() { return getPlatformLook().look; }
const { RATE_LIMIT_CONFIG_PER_MIN } = require("../lib/config");
const _appearanceLimiter = rateLimit(60_000, RATE_LIMIT_CONFIG_PER_MIN, "appearance");
const { getPlatformName, _invalidatePlatformNameCache, getRequireAccountApproval, getBreakglassUsername, validateBreakglassUsername, BREAKGLASS_DEFAULT_USERNAME } = require("../lib/settings");
const { getAdminIdentity, recordSettingsEvent, _paginationParams, _eventListResponse, runTxnWithMirrorBuffer , reqContext } = require("../lib/audit");
const { decodeCxOneApiKey } = require("../lib/cxone");

// THE BREAK-GLASS ACCOUNT'S USERNAME — readable and changeable ONLY from the
// built-in superadmin's own session (`builtinId`), never by a user-backed
// superadmin: the name is half of the platform's one password credential, and
// only its holder should learn or move it. The current session stays signed in;
// the new name is required from the next sign-in. Rotation, the failure count
// and the lockout cooldown are unchanged (they key on the password, not the name).
function _builtinOnly(req, res) {
  if (req.session?.builtinId === "superadmin" && !req.session?.impersonator) return true;
  res.status(403).json({ error: "Only the break-glass account itself can see or change its username.", code: "breakglass_session_required" });
  return false;
}

module.exports = function register(app) {
  app.get("/api/admin/breakglass-username", requireSuperAdmin, (req, res) => {
    if (!_builtinOnly(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ username: getBreakglassUsername(), is_default: getBreakglassUsername() === BREAKGLASS_DEFAULT_USERNAME });
  });

  app.patch("/api/admin/breakglass-username", requireSuperAdmin, csrfProtection, (req, res) => {
    if (!_builtinOnly(req, res)) return;
    if (typeof req.body?.username !== "string") return res.status(400).json({ error: "The username must be text.", code: "username_invalid" });
    const v = validateBreakglassUsername(req.body.username);
    if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });
    const was = getBreakglassUsername();
    if (v.value === was) return res.json({ ok: true, username: was, changed: false });
    const txn = db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('breakglass_username', ?)").run(v.value);
      // The names themselves stay out of the audit: they are half a credential
      // and app.jsonl is readable by every regular admin.
      recordSettingsEvent("breakglass_username", "updated", getAdminIdentity(req), { ...reqContext(req), reset_to_default: v.value === BREAKGLASS_DEFAULT_USERNAME });
    });
    runTxnWithMirrorBuffer(() => txn());
    res.json({ ok: true, username: v.value, changed: true });
  });

  app.get("/api/admin/settings", requireAdmin, (req, res) => {
    const platformName = getPlatformName();
    const apiKey = db.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get()?.value || "";
    const cx = decodeCxOneApiKey(apiKey);
    const groupName = db.prepare("SELECT value FROM settings WHERE key='default_cxone_group_name'").get()?.value || "";
    res.json({
      platform_name: platformName,
      cxone_configured: !!cx,
      cxone_tenant: cx?.tenant || "",
      cxone_base_url: cx?.baseUrl || "",
      cxone_group_name: groupName,
      require_account_approval: getRequireAccountApproval(),
      default_look: getDefaultLook(),
      platform_look: getPlatformLook(),
    });
  });

  // Public on purpose: every visitor (signed out included) paints the org
  // default before choosing. It discloses the platform look (ids, the lock and
  // the apply stamp) and nothing else; the shell carries the same object.
  app.get("/api/settings/appearance", _appearanceLimiter, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ default_look: getDefaultLook(), platform_look: getPlatformLook() });
  });

  // THE PLATFORM LOOK — superadmin. `apply_now:true` stamps the time, so every
  // browser whose own choice predates it adopts the default on its next load;
  // `lock:true` keeps participants and signed-out visitors on it. Audited as
  // the `platform_look` settings event (from / to without the stamp).
  app.put("/api/admin/platform-look", requireSuperAdmin, csrfProtection, (req, res) => {
    const v = validatePlatformLook(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });
    const was = getPlatformLook();
    const next = { ...v.value, stamp: v.applyNow ? now().getTime() : was.stamp };
    const adminId = getAdminIdentity(req);
    let stored = null;
    const txn = db.transaction(() => {
      stored = setPlatformLook(next);
      const strip = (o) => ({ look: o.look || null, mode: o.mode || null, ambient: o.ambient || null, lock: !!o.lock });
      recordSettingsEvent("platform_look", "updated", adminId, { from: strip(was), to: strip(stored), applied_to_everyone: v.applyNow, ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => txn());
    res.json({ ok: true, platform_look: stored });
  });

  // v7.26.0 — SUPERADMIN, tightened from requireAdmin. The platform name is no
  // longer only a label: it is the SENDER DISPLAY NAME on every outbound email
  // (lib/email.js `resolveSender`), so it decides what a recipient sees in the
  // From line of their verification, sign-in-code and lockout mail. That is a
  // platform-identity decision, and it now sits at the same tier as the other
  // two things on this tab (the global CxOne credential and the unsubscribe
  // list), both of which have always been superadmin-only.
  //
  // GET stays `requireAdmin` deliberately — it discloses nothing a regular admin
  // could not already read, and narrowing it would break the admin-endpoint
  // reachability checks for no gain.
  app.patch("/api/admin/settings", requireSuperAdmin, csrfProtection, (req, res) => {
    const { platform_name, require_account_approval, default_look } = req.body;
    // ONE setting per PATCH: each control saves its own (the name field, the
    // approval switch, the Appearance page's default look), and each branch
    // below writes only its own field. A body naming two of them would have
    // answered 200 and silently dropped the others, so it is refused by name.
    const named = [["platform_name", platform_name], ["require_account_approval", require_account_approval], ["default_look", default_look]]
      .filter(([, v]) => v !== undefined).map(([k]) => k);
    if (named.length > 1)
      return res.status(400).json({ error: `Save one setting at a time: this request named ${named.join(", ")}.`, code: "settings_one_at_a_time", fields: named });
    // `default_look` alone is its own PATCH (the Appearance page saves it on its
    // own). "" or null clears it back to the house look (Ambient).
    if (default_look !== undefined) {
      if (default_look !== null && typeof default_look !== "string")
        return res.status(400).json({ error: "default_look must be a look id or empty" });
      const next = default_look || "";
      if (next && !LOOK_IDS.has(next))
        return res.status(400).json({ error: "Unknown look", code: "default_look_unknown" });
      const adminId = getAdminIdentity(req);
      const was = getDefaultLook();
      const txn = db.transaction(() => {
        // The look field of the platform look; mode, light, lock and stamp stay.
        setPlatformLook({ ...getPlatformLook(), look: next });
        if (was !== next) recordSettingsEvent("default_look", "updated", adminId, { from: was || null, to: next || null, ...reqContext(req) });
      });
      runTxnWithMirrorBuffer(() => txn());
      return res.json({ ok: true, default_look: next });
    }
    // `require_account_approval` alone is a valid PATCH (the Settings switch
    // saves on its own); with no platform_name the name is left as it is.
    if (require_account_approval !== undefined && typeof require_account_approval !== "boolean")
      return res.status(400).json({ error: "require_account_approval must be true or false" });
    if (require_account_approval !== undefined && platform_name === undefined) {
      const adminId = getAdminIdentity(req);
      const was = getRequireAccountApproval();
      const txn = db.transaction(() => {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('require_account_approval', ?)").run(require_account_approval ? "1" : "0");
        if (was !== require_account_approval) recordSettingsEvent("require_account_approval", "updated", adminId, { from: was, to: require_account_approval, ...reqContext(req) });
      });
      runTxnWithMirrorBuffer(() => txn());
      return res.json({ ok: true, require_account_approval });
    }
    // ext-audit batch 4 — typeof guard before .trim() (non-string → 500).
    if (typeof platform_name !== "string" || !platform_name.trim())
      return res.status(400).json({ error: "Platform name is required" });
    if (platform_name.length > 120)
      return res.status(400).json({ error: "Platform name must be at most 120 characters." });
    // v7.26.0 — refuse control characters, INCLUDING CR/LF. Not injection
    // defence: nodemailer cannot be made to emit a raw line break from either
    // the subject or the From display name (measured — every branch either
    // excludes them by character class or Q-encodes them). It is that the value
    // reaches ~19 mail SUBJECT lines and the From header, where a pasted line
    // break silently mangles every one of them into a run-on string or a
    // literal `=0D=0A`, with nothing telling the operator why. Refusing at the
    // write is the actionable half; `_safeDisplayName` in lib/email.js is
    // defence in depth for a legacy row and the uncapped COMPETITION_NAME env
    // fallback.
    //
    // Deliberately NOT rejected: `<`, `>`, quotes, commas. Those are legitimate
    // in a brand name, and treating them as dangerous would be treating the
    // symptom — the address hijack they used to enable was a defect in HOW the
    // header was composed, and it is fixed there.
    if (/[\u0000-\u001F\u007F-\u009F]/.test(platform_name))
      return res.status(400).json({ error: "Platform name cannot contain line breaks or control characters." });
    const adminId = getAdminIdentity(req);
    const oldName = getPlatformName();
    const newName = platform_name.trim();
    const settingsTxn = db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("platform_name", newName);
      if (oldName !== newName) recordSettingsEvent("platform_name", "updated", adminId, { from: oldName, to: newName, ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => settingsTxn());
    _invalidatePlatformNameCache(); // v6.20.x — drop the memo so the new name is served immediately
    res.json({ ok: true, platform_name: newName });
  });

  app.get("/api/admin/settings/events", requireAdmin, (req, res) => {
    const { offset, limit, paginated, snapshotBefore, snapshotTie } = _paginationParams(req);
    const countSql = "SELECT COUNT(*) as c FROM settings_events";
    const listSql = "SELECT id, setting_key, event_type, changed_by, changed_at, details FROM settings_events ORDER BY changed_at DESC, rowid DESC LIMIT ? OFFSET ?";
    const maxSql = "SELECT changed_at as m, rowid as tie FROM settings_events ORDER BY changed_at DESC, rowid DESC LIMIT 1";
    res.json(_eventListResponse(countSql, listSql, maxSql, [], paginated, offset, limit, snapshotBefore, snapshotTie));
  });
};
