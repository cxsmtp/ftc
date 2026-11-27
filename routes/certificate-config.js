"use strict";

// THE CERTIFICATE DESIGN: read, set and reset the global design and a per-event
// override, and preview a design as a PNG without minting anything.
//
// The rules live in lib/certificate-config.js (validation, the merge, the
// defaults); this module is the HTTP surface. Design is read LIVE at render
// while every fact on a certificate is frozen at mint (routes/badge.js
// `_badgeArt`), so these routes can re-skin issued certificates but can never
// change what one claims.
//
//   GET            /api/admin/certificate-config                     global admin (certificates.design)
//   PUT|DELETE     /api/admin/certificate-config                     global admin (certificates.design)
//   GET            /api/admin/competitions/:id/certificate-config    any admin, event scope
//   PUT|DELETE     /api/admin/competitions/:id/certificate-config    global admin, event scope, not a
//                                                                    competitor; once the event's effective
//                                                                    end has passed, a superadmin only
//   POST           /api/admin/certificate-config/preview             any admin, event scope
//
// A PUT replaces the whole stored layer, so it takes the `version` the read
// gave (`expectedVersion`) and answers 409 `certificate_config_changed` when
// the stored layer has moved since: a designer opened before another admin's
// save would otherwise put back every field that save changed. The version is
// a digest of the stored layer, so it needs no column of its own; absent is
// unchecked.

const db = require("../db");
const { rateLimit, requireAdmin, requireGlobalAdmin, csrfProtection } = require("../lib/middleware");
const { getAdminIdentity, recordSettingsEvent, recordCompetitionEvent, runTxnWithMirrorBuffer, reqContext } = require("../lib/audit");
const { getCompetition, _invalidateCompetitionCache, competitionStatus, competitionEffectiveEnd } = require("../lib/competitions");
const { competitionDenied, competitorIds } = require("../lib/event-admin");
const { competitorEditDenied, refuseCompetitor } = require("../lib/staff-compete");
const { getPlatformName } = require("../lib/settings");
const { now } = require("../lib/time");
const { BASE_URL } = require("../lib/config");
const CC = require("../lib/certificate-config");
const { buildCertificateSvg, renderBadgePng, BadgeRenderUnavailable, badgeDateLabel } = require("../lib/badge");

// Rendering is CPU work on the event loop's threadpool; a wizard re-renders on
// every edit, so the ceiling is generous for one person and bounded for a loop.
// AFTER requireAdmin, so an anonymous 401 never drains a bucket.
const previewLimiter = rateLimit(60_000, 40, "certificate-preview");

const BODY_KEYS = new Set(["config", "expectedVersion"]);
const PREVIEW_KEYS = new Set(["config", "competition_id", "sample"]);
const SAMPLE_FIELDS = {
  name: 120, event: 120, score: 24, date: 40,
};
const SAMPLE_KEYS = new Set([...Object.keys(SAMPLE_FIELDS), "tier", "late_entrant"]);
// A recognisably fake code: the preview shows where the code and QR sit without
// printing anything that could be mistaken for a real certificate's.
const SAMPLE_CODE = "000000000000";

// One "is this a JSON object" test for the route and the validator it feeds:
// the lib's also refuses a non-plain prototype.
const { _isPlainObject } = CC;

/** Refuse any body key the route does not read: accept-and-ignore is worse than no control. */
function _unknownBodyKey(body, allowed) {
  for (const k of Object.keys(body || {})) if (!allowed.has(k)) return k;
  return null;
}

function _refuseInvalid(res, v) {
  return res.status(400).json({ error: v.error, code: v.code, field: v.field });
}

/** The paths a layer sets, for the audit trail (`text.title`, `labels.gold.sub`). */
function _layerPaths(layer) {
  const out = [];
  for (const s of CC.SECTIONS) {
    const sec = layer[s];
    if (!sec) continue;
    for (const [k, v] of Object.entries(sec)) {
      if (s === "labels") for (const lk of Object.keys(v)) out.push(`labels.${k}.${lk}`);
      else out.push(`${s}.${k}`);
    }
  }
  return out;
}

// The version of a stored layer: a digest of the stored text ("" when none).
function _version(stored) {
  return stored ? require("crypto").createHash("sha256").update(String(stored)).digest("hex").slice(0, 32) : "";
}
function _globalStored() {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(CC.SETTINGS_KEY);
  return r ? r.value : null;
}
function _eventStored(compId) {
  const r = db.prepare("SELECT certificate_config FROM competitions WHERE id=?").get(compId);
  return r ? r.certificate_config : null;
}

function _globalPayload() {
  const global = CC.readGlobalLayer(db);
  return { defaults: CC.certificateDefaults(), global, effective: CC.mergeCertificateConfig(global), version: _version(_globalStored()) };
}

function _eventPayload(compId) {
  const global = CC.readGlobalLayer(db);
  const override = CC.readEventLayer(db, compId);
  const stored = _eventStored(compId);
  return {
    competition_id: compId,
    overridden: !!stored,
    override,
    inherited: CC.mergeCertificateConfig(global),
    effective: CC.mergeCertificateConfig(global, override),
    version: _version(stored),
  };
}

// `expectedVersion` is optional; when sent it must be the text the read gave.
function _badVersion(body) {
  return body && body.expectedVersion !== undefined && typeof body.expectedVersion !== "string";
}
const _STALE = Symbol("certificate_config_changed");
function _refuseStale(res, payload) {
  return res.status(409).json({
    error: "Another administrator changed this certificate design after you opened it. Load their version, then make your change again.",
    code: "certificate_config_changed", ...payload,
  });
}

/**
 * The shared door checks for a per-event WRITE, in the order every competition
 * door uses: 404, the competitor lock, scope, then the ended-event rule (only a
 * superadmin edits an event whose effective end has passed — re-skinning its
 * issued certificates is an edit to a finished event).
 */
function _eventWriteDenied(req, res) {
  const comp = getCompetition(req.params.id);
  if (!comp) return { sent: res.status(404).json({ error: "Event not found" }) };
  const cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
  if (cmp) return { sent: cmp };
  const denied = competitionDenied(req, comp.id);
  if (denied) return { sent: res.status(403).json({ error: denied.message, code: denied.code }) };
  if (competitionStatus(comp) === "ended") {
    const effEnd = competitionEffectiveEnd(comp);
    if (effEnd && effEnd <= now() && !req.session.isSuperAdmin) {
      return { sent: res.status(403).json({
        error: "Only a superadmin can change the certificate design of an event that has ended: it would change the look of certificates already issued.",
        code: "certificate_config_ended_locked",
      }) };
    }
  }
  return { comp };
}

module.exports = function register(app) {
  // ── global ────────────────────────────────────────────────────────────────
  app.get("/api/admin/certificate-config", requireAdmin, requireGlobalAdmin, (req, res) => {
    res.set("Cache-Control", "no-store").json(_globalPayload());
  });

  app.put("/api/admin/certificate-config", requireAdmin, requireGlobalAdmin, csrfProtection, (req, res) => {
    const extra = _unknownBodyKey(req.body, BODY_KEYS);
    if (extra) return res.status(400).json({ error: `"${extra}" is not a field of this request. Send { config }.`, code: "certificate_config_unknown_key", field: extra });
    if (!_isPlainObject(req.body.config)) return res.status(400).json({ error: "Send the design as { config: { … } }.", code: "certificate_config_not_object", field: "config" });
    if (_badVersion(req.body)) return res.status(400).json({ error: "expectedVersion must be the version text the design was read with.", code: "certificate_config_bad_type", field: "expectedVersion" });
    const v = CC.validateCertificateConfig(req.body.config, { platformName: getPlatformName() });
    if (!v.ok) return _refuseInvalid(res, v);
    const adminId = getAdminIdentity(req);
    const empty = !Object.keys(v.value).length;
    const txn = db.transaction(() => {
      if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== _version(_globalStored())) throw _STALE;
      if (empty) db.prepare("DELETE FROM settings WHERE key=?").run(CC.SETTINGS_KEY);
      else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(CC.SETTINGS_KEY, JSON.stringify(v.value));
      recordSettingsEvent(CC.SETTINGS_KEY, empty ? "reset" : "updated", adminId, { fields: _layerPaths(v.value), ...reqContext(req) });
    });
    try { runTxnWithMirrorBuffer(() => txn()); }
    catch (e) { if (e === _STALE) return _refuseStale(res, _globalPayload()); throw e; }
    res.json({ ok: true, ..._globalPayload() });
  });

  app.delete("/api/admin/certificate-config", requireAdmin, requireGlobalAdmin, csrfProtection, (req, res) => {
    const adminId = getAdminIdentity(req);
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM settings WHERE key=?").run(CC.SETTINGS_KEY);
      recordSettingsEvent(CC.SETTINGS_KEY, "reset", adminId, { ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => txn());
    res.json({ ok: true, ..._globalPayload() });
  });

  // ── per event ─────────────────────────────────────────────────────────────
  app.get("/api/admin/competitions/:id/certificate-config", requireAdmin, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    res.set("Cache-Control", "no-store").json(_eventPayload(comp.id));
  });

  app.put("/api/admin/competitions/:id/certificate-config", requireAdmin, requireGlobalAdmin, csrfProtection, (req, res) => {
    const gate = _eventWriteDenied(req, res);
    if (gate.sent) return gate.sent;
    const extra = _unknownBodyKey(req.body, BODY_KEYS);
    if (extra) return res.status(400).json({ error: `"${extra}" is not a field of this request. Send { config }.`, code: "certificate_config_unknown_key", field: extra });
    if (!_isPlainObject(req.body.config)) return res.status(400).json({ error: "Send the design as { config: { … } }.", code: "certificate_config_not_object", field: "config" });
    if (_badVersion(req.body)) return res.status(400).json({ error: "expectedVersion must be the version text the design was read with.", code: "certificate_config_bad_type", field: "expectedVersion" });
    const v = CC.validateCertificateConfig(req.body.config, { platformName: getPlatformName() });
    if (!v.ok) return _refuseInvalid(res, v);
    const adminId = getAdminIdentity(req);
    const empty = !Object.keys(v.value).length;
    const txn = db.transaction(() => {
      if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== _version(_eventStored(gate.comp.id))) throw _STALE;
      // `updated_at` is deliberately NOT bumped: it is the event FORM's concurrency
      // token, and the design is not on that form — a bump would 409 an organiser
      // saving the event in another tab for a change their save cannot clobber.
      db.prepare("UPDATE competitions SET certificate_config=? WHERE id=?")
        .run(empty ? null : JSON.stringify(v.value), gate.comp.id);
      recordCompetitionEvent(gate.comp.id, "certificate_config_changed", adminId,
        empty ? { cleared: true, ...reqContext(req) } : { fields: _layerPaths(v.value), ...reqContext(req) });
    });
    try { runTxnWithMirrorBuffer(() => txn()); }
    catch (e) { if (e === _STALE) return _refuseStale(res, _eventPayload(gate.comp.id)); throw e; }
    _invalidateCompetitionCache(gate.comp.id);   // post-commit
    res.json({ ok: true, ..._eventPayload(gate.comp.id) });
  });

  app.delete("/api/admin/competitions/:id/certificate-config", requireAdmin, requireGlobalAdmin, csrfProtection, (req, res) => {
    const gate = _eventWriteDenied(req, res);
    if (gate.sent) return gate.sent;
    const adminId = getAdminIdentity(req);
    const txn = db.transaction(() => {
      db.prepare("UPDATE competitions SET certificate_config=NULL WHERE id=?").run(gate.comp.id);
      recordCompetitionEvent(gate.comp.id, "certificate_config_changed", adminId, { cleared: true, ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => txn());
    _invalidateCompetitionCache(gate.comp.id);
    res.json({ ok: true, ..._eventPayload(gate.comp.id) });
  });

  // ── preview ───────────────────────────────────────────────────────────────
  // A PNG of a design applied to SAMPLE data. Writes nothing and mints nothing:
  // no badge row, no image row, no audit event (a read-only act; the design it
  // renders is not stored). `config` is an unsaved layer on top of the event's
  // (when `competition_id` is given) or the global design, so a wizard can show
  // an edit before it is saved.
  app.post("/api/admin/certificate-config/preview", requireAdmin, previewLimiter, csrfProtection, async (req, res) => {
    const extra = _unknownBodyKey(req.body, PREVIEW_KEYS);
    if (extra) return res.status(400).json({ error: `"${extra}" is not a field of this request.`, code: "certificate_config_unknown_key", field: extra });
    const { config, competition_id, sample } = req.body;
    if (config !== undefined && !_isPlainObject(config)) return res.status(400).json({ error: "config must be an object.", code: "certificate_config_not_object", field: "config" });
    if (competition_id !== undefined && typeof competition_id !== "string") return res.status(400).json({ error: "competition_id must be text.", code: "certificate_config_bad_type", field: "competition_id" });
    if (sample !== undefined && !_isPlainObject(sample)) return res.status(400).json({ error: "sample must be an object.", code: "certificate_config_bad_type", field: "sample" });
    const s = sample || {};
    for (const k of Object.keys(s)) {
      if (!SAMPLE_KEYS.has(k)) return res.status(400).json({ error: `sample.${k} is not a sample field.`, code: "certificate_config_unknown_key", field: `sample.${k}` });
    }
    for (const [k, max] of Object.entries(SAMPLE_FIELDS)) {
      if (s[k] === undefined) continue;
      if (typeof s[k] !== "string" || [...s[k]].length > max || /[\u0000-\u001f\u007f]/.test(s[k])) {
        return res.status(400).json({ error: `sample.${k} must be text of at most ${max} characters.`, code: "certificate_config_bad_type", field: `sample.${k}` });
      }
    }
    if (s.tier !== undefined && !CC.TIERS.includes(s.tier)) {
      return res.status(400).json({ error: `sample.tier must be one of ${CC.TIERS.join(", ")}.`, code: "certificate_config_bad_type", field: "sample.tier" });
    }
    if (s.late_entrant !== undefined && typeof s.late_entrant !== "boolean") {
      return res.status(400).json({ error: "sample.late_entrant must be true or false.", code: "certificate_config_bad_type", field: "sample.late_entrant" });
    }
    let comp = null;
    if (competition_id) {
      comp = getCompetition(competition_id);
      if (!comp) return res.status(404).json({ error: "Event not found" });
      const denied = competitionDenied(req, comp.id);
      if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    }
    let layer = {};
    if (config !== undefined) {
      const v = CC.validateCertificateConfig(config, { platformName: getPlatformName() });
      if (!v.ok) return _refuseInvalid(res, v);
      layer = v.value;
    }
    const design = CC.mergeCertificateConfig(CC.readGlobalLayer(db), comp ? CC.readEventLayer(db, comp.id) : {}, layer);
    const tier = s.tier || "gold";
    const rank = { gold: 1, silver: 2, bronze: 3 }[tier] || null;
    const basis = rank ? "placement" : tier;
    const art = {
      platformName: getPlatformName(),
      rank, basis,
      competitionName: s.event !== undefined ? s.event : (comp ? comp.name : "Sample Event"),
      displayName: s.name !== undefined ? s.name : "Jane Doe",
      dateLabel: s.date !== undefined ? s.date : badgeDateLabel(now()),
      scoreLabel: rank ? (s.score !== undefined ? s.score : "400 pts") : null,
      lateEntrant: !!s.late_entrant,
      publicCode: SAMPLE_CODE,
      verifyUrl: String(BASE_URL || "").replace(/^https?:\/\//i, "") + "/credential",
      verifyLink: `${BASE_URL}/credential?code=${SAMPLE_CODE}`,
      design,
    };
    try {
      const png = await renderBadgePng(buildCertificateSvg(art));
      res.set("Cache-Control", "no-store").type("image/png").send(png);
    } catch (e) {
      if (e instanceof BadgeRenderUnavailable) return res.status(503).json({ error: "Certificate rendering is unavailable on this server." });
      throw e;
    }
  });
};
