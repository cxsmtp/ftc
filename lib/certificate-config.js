"use strict";

// The certificate DESIGN configuration: every word and visual choice on the
// printed certificate that is not a fact about the holder.
//
// THREE LAYERS, merged field by field: DEFAULTS <- global <- event.
//   * DEFAULTS (below) reproduce the operator's gold reference design.
//   * The GLOBAL layer is `settings.certificate_config` (an administrator or a
//     superadmin: `certificates.design`, never an event admin).
//   * The EVENT layer is `competitions.certificate_config` (NULL = inherit
//     everything): an administrator or a superadmin changes it, never a
//     competitor in the event, and once the event's effective end has passed a
//     superadmin only; its organisers preview and download it.
// Each stored layer is a PARTIAL object: only the keys someone set. So a global
// change reaches every event that did not override that particular key, and an
// event override survives a later global edit of a different key.
//
// DESIGN IS LIVE, FACTS ARE FROZEN. The holder's score, date, basis, rank, late
// entry and code freeze at mint (see routes/badge.js `_badgeArt`); this config
// is read on every render, like the platform name already is. Re-skinning an
// event therefore restyles its issued certificates, their wording and which
// details they show (the `show` switches) included: designs stay live (operator
// ruling, 17 Nov 2026). The facts themselves stay frozen and /credential keeps
// them: there is no toggle for the late-entrant marker (a certificate must say
// so), and no field that substitutes a holder fact.
//
// v8.15.1 — the `email` section governs the CONGRATULATIONS EMAIL that carries
// the certificate (lib/certificate-dispatch.js): `enabled` (default on, every
// kind), the `subject` after the platform-name prefix every mail keeps, and an
// optional `intro` paragraph. Wording and one switch, never a claim: the tier
// line, rank and score in the mail come from the frozen certificate. Layered
// like everything else, so an administrator can switch the mail off
// platform-wide and back on for one event.
//
// STRICT ON WRITE, TOLERANT ON READ. `validateCertificateConfig` refuses an
// unknown key, a wrong type, an over-long string, a control character, a
// non-hex colour or an unknown `{token}` with a named 400 — accept-and-ignore
// is worse than no control. `sanitiseStoredConfig` (the read path) keeps every
// valid field and drops the rest, so a value written by a newer image, read
// after a rollback, still renders everything this image understands.
//
// Pure: no db.js at require time. The readers take `db` as an argument.

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
// C0, DEL and C1 controls (CR/LF included): text on a printed document.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const TOKEN_RE = /\{([^{}]*)\}/g;
const TOKENS = new Set(["platform"]);

// The text fields. `empty: true` means "" is a legal value and hides the line.
const TEXT_FIELDS = Object.freeze({
  wordmark:            { max: 40,  empty: false, def: "Checkmarx" },
  hub_line:            { max: 80,  empty: true,  def: "{platform}" },
  title:               { max: 48,  empty: false, def: "CERTIFICATE OF ACHIEVEMENT" },
  presented_to:        { max: 40,  empty: true,  def: "PRESENTED TO" },
  lead_in:             { max: 80,  empty: true,  def: "FOR SUCCESSFULLY COMPLETING THE" },
  recognition:         { max: 220, empty: true,  def: "In recognition of your dedication, active participation, and commitment to excellence throughout this experience." },
  footer_tagline:      { max: 80,  empty: true,  def: "APPLICATION SECURITY FOR THE AI ERA" },
  achievement_heading: { max: 40,  empty: false, def: "ACHIEVEMENT UNLOCKED" },
  score_heading:       { max: 24,  empty: false, def: "SCORE" },
  date_heading:        { max: 24,  empty: false, def: "DATE" },
  id_heading:          { max: 32,  empty: false, def: "CERTIFICATE ID" },
});

// What each variant's achievement column says. `headline` is the large value,
// `sub` the small caps line under it ("" hides it).
const TIERS = Object.freeze(["gold", "silver", "bronze", "participation", "completion"]);
// The headline takes NO placeholder (sweep #56): the renderer draws it as typed
// (lib/badge.js buildCertificateSvg never fills it), and it is fitted with an
// ellipsis, so a platform name of up to 120 characters filled into a 30-character
// placing would print cut ("Checkmarx Enablem…"). The sub line under it takes
// {platform} and is never cut.
const NO_TOKENS = new Set();
const LABEL_FIELDS = Object.freeze({
  headline: { max: 30, empty: false, tokens: NO_TOKENS },
  sub:      { max: 40, empty: true },
});
const LABEL_DEFAULTS = Object.freeze({
  gold:          { headline: "1st Place",   sub: "TOP-3 FINISHER" },
  silver:        { headline: "2nd Place",   sub: "TOP-3 FINISHER" },
  bronze:        { headline: "3rd Place",   sub: "TOP-3 FINISHER" },
  participation: { headline: "Participant", sub: "PARTICIPATED" },
  completion:    { headline: "Completed",   sub: "ALL CHALLENGES SOLVED" },
});

// Colours. `frame` has NO default on purpose: unset, the frame and rules follow
// the variant's own metal (gold frame on a gold certificate, silver on silver),
// which is what the reference does; set, every variant shares one frame colour.
const COLOUR_FIELDS = Object.freeze([
  "background", "glow", "text", "muted", "accent", "frame",
  "gold", "silver", "bronze", "participation", "completion",
]);
const COLOUR_DEFAULTS = Object.freeze({
  background: "#0B0A1A",   // deep navy-violet
  glow: "#2A1F5C",         // the vignette's lit centre
  text: "#F6F2EA",         // warm ivory, not paper-white
  muted: "#B3ADCB",
  accent: "#8B5CF6",       // the one violet
  gold: "#D9AE4C",
  silver: "#C3CAD6",
  bronze: "#C8834F",
  participation: "#B8B2CC", // pewter seal
  completion: "#A78BFA",    // violet seal
});

const SHOW_FIELDS = Object.freeze(["logo", "score", "date", "qr", "code", "pattern", "shield", "medal"]);
const SHOW_DEFAULTS = Object.freeze({
  logo: true, score: true, date: true, qr: true, code: true, pattern: true, shield: true, medal: true,
});

// v8.15.1 — the congratulations email. `subject` follows the `${platform} — `
// prefix every outbound mail keeps (CLAUDE.md, *Sender and transport*), so it
// names only the thing; `{event}` is the event's name. `intro` is one extra
// paragraph under the tier's own congratulation ("" adds nothing).
//
// Operator ruling, 29 Oct 2026 — the email is WARM AND PER TIER: one thank-you
// paragraph per certificate tier (`message_<tier>`), and the LinkedIn post the
// holder copies from the share page (`linkedin_post` is line one,
// `linkedin_hashtags` line two, then the verification link the server appends).
// Line breaks are refused in every field (the control-character rule), which is
// why the post is two fields rather than one multi-line one.
const EMAIL_TOKENS = new Set(["platform", "event"]);
const POST_TOKENS = new Set(["platform", "event", "achievement", "organisers"]);
const EMAIL_TEXT_FIELDS = Object.freeze({
  subject: { max: 120, empty: false, def: "Your certificate for {event}", tokens: EMAIL_TOKENS },
  intro:   { max: 500, empty: true,  def: "", tokens: EMAIL_TOKENS },
  message_gold: { max: 600, empty: false, tokens: EMAIL_TOKENS,
    def: "Congratulations — you took 1st place in {event}! Out of everyone who competed, you came out on top. That is a terrific achievement, and we are delighted to send you your certificate." },
  message_silver: { max: 600, empty: false, tokens: EMAIL_TOKENS,
    def: "Congratulations on finishing 2nd in {event}! That is a superb result in a strong field, and we are very glad you competed with us. Your certificate is attached." },
  message_bronze: { max: 600, empty: false, tokens: EMAIL_TOKENS,
    def: "Congratulations on your 3rd place in {event}! Reaching the podium takes real skill and persistence. Well done, and thank you for taking part." },
  message_participation: { max: 600, empty: false, tokens: EMAIL_TOKENS,
    def: "Thank you for taking part in {event}! Every challenge you tackled is time invested in your skills, and we were glad to have you with us. Here is your certificate of participation." },
  message_completion: { max: 600, empty: false, tokens: EMAIL_TOKENS,
    def: "Congratulations on completing {event}! You solved every challenge, which takes real dedication. Your certificate of completion is attached." },
  linkedin_post: { max: 300, empty: false, tokens: POST_TOKENS,
    def: "Proud to have earned {achievement} at {event}, hosted by @Checkmarx with {organisers}!" },
  linkedin_hashtags: { max: 200, empty: true, tokens: new Set(["platform"]),
    def: "#Checkmarx #AppSec #ApplicationSecurity #CyberSecurity" },
});
const EMAIL_FIELDS = Object.freeze(["enabled", ...Object.keys(EMAIL_TEXT_FIELDS)]);
const EMAIL_DEFAULTS = Object.freeze({
  enabled: true,
  ...Object.fromEntries(Object.entries(EMAIL_TEXT_FIELDS).map(([k, f]) => [k, f.def])),
});

const SECTIONS = Object.freeze(["text", "labels", "colors", "show", "email"]);

function _defaults() {
  const text = {};
  for (const [k, f] of Object.entries(TEXT_FIELDS)) text[k] = f.def;
  const labels = {};
  for (const t of TIERS) labels[t] = { ...LABEL_DEFAULTS[t] };
  return { text, labels, colors: { ...COLOUR_DEFAULTS }, show: { ...SHOW_DEFAULTS }, email: { ...EMAIL_DEFAULTS } };
}

/** A fresh copy of the built-in design (the gold reference). */
function certificateDefaults() { return _defaults(); }

const _isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;

class CertConfigError extends Error {
  constructor(code, field, message) { super(message); this.code = code; this.field = field; }
}

function _text(path, v, spec) {
  if (typeof v !== "string") throw new CertConfigError("certificate_config_bad_type", path, `${path} must be text.`);
  const s = v.trim();
  if (CONTROL_RE.test(s)) throw new CertConfigError("certificate_config_control_chars", path, `${path} must not contain control characters or line breaks.`);
  if (!s && !spec.empty) throw new CertConfigError("certificate_config_required", path, `${path} cannot be empty.`);
  if ([...s].length > spec.max) throw new CertConfigError("certificate_config_too_long", path, `${path} must be at most ${spec.max} characters.`);
  const tokens = spec.tokens || TOKENS;
  const which = tokens === TOKENS ? "The only placeholder is {platform}."
    : !tokens.size ? "This line takes no placeholder: it prints exactly as typed."
    : `The placeholders are ${[...tokens].map(t => `{${t}}`).join(" and ")}.`;
  for (const m of s.matchAll(TOKEN_RE)) {
    if (!tokens.has(m[1])) {
      throw new CertConfigError("certificate_config_unknown_token", path, tokens.size
        ? `${path} uses {${m[1]}}, which is not a placeholder. ${which}` : `${path} cannot hold {${m[1]}}. ${which}`);
    }
  }
  if (/[{}]/.test(s.replace(TOKEN_RE, ""))) throw new CertConfigError("certificate_config_unknown_token", path, `${path} has an unmatched { or }. ${which}`);
  return s;
}

function _section(path, v, allowed) {
  if (!_isPlainObject(v)) throw new CertConfigError("certificate_config_bad_type", path, `${path} must be an object.`);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new CertConfigError("certificate_config_unknown_key", `${path}.${k}`, `${path}.${k} is not a certificate setting.`);
  }
  return v;
}

// Sweep #56 (operator ruling, 23 Nov 2026: wording the fonts cannot draw is
// refused). The certificate is drawn by resvg with the shipped faces only
// (lib/badge.js `_drawPlan`): a line no single face draws prints empty boxes on
// every certificate, issued ones included. Asked of each line as it is drawn: as
// typed and in capitals, and with {platform} both left out and filled in.
// lib/badge requires this module at load, so it is required lazily here.
// `canRenderText` answers "drawable" when the font metrics cannot be read, so a
// broken font load never blocks a save.
function _assertDrawable(path, s, platformName) {
  const { canRenderText } = require("./badge");
  const own = fillTokens(s, { platformName: "" });
  const filled = fillTokens(s, { platformName });
  for (const [t, withName] of [[own, false], [filled, true]]) {
    if (canRenderText(t) && canRenderText(t.toUpperCase())) continue;
    throw new CertConfigError("certificate_config_undrawable", path, withName
      ? `${path} cannot be printed with the platform name filled in: the certificate cannot draw both scripts on one line.`
      : `${path} has characters the certificate cannot draw (they would print as empty boxes). A line may use Latin, Greek and Cyrillic letters; or Arabic, Hebrew or Thai without Latin letters; or Chinese, Japanese and Korean.`);
  }
}

/**
 * Validate a PARTIAL design layer. Returns `{ ok: true, value }` with the
 * canonical value to store (trimmed text, upper-case hex, only the keys given)
 * or `{ ok: false, code, field, error }`. Never throws.
 *
 * `drawable` (on by default: every write door) also refuses certificate wording
 * the shipped fonts cannot draw, judged with `platformName` filled in; the
 * email's fields are drawn by mail clients and are not asked. A READ
 * (`sanitiseStoredConfig`) passes `drawable: false`: tolerant on read.
 */
function validateCertificateConfig(input, { drawable = true, platformName = "" } = {}) {
  try {
    if (!_isPlainObject(input)) throw new CertConfigError("certificate_config_not_object", "", "The certificate design must be a JSON object.");
    _section("config", input, SECTIONS);
    const out = {};
    if (input.text !== undefined) {
      _section("text", input.text, Object.keys(TEXT_FIELDS));
      out.text = {};
      for (const [k, v] of Object.entries(input.text)) {
        out.text[k] = _text(`text.${k}`, v, TEXT_FIELDS[k]);
        if (drawable && out.text[k]) _assertDrawable(`text.${k}`, out.text[k], platformName);
      }
    }
    if (input.labels !== undefined) {
      _section("labels", input.labels, TIERS);
      out.labels = {};
      for (const [tier, lv] of Object.entries(input.labels)) {
        _section(`labels.${tier}`, lv, Object.keys(LABEL_FIELDS));
        out.labels[tier] = {};
        for (const [k, v] of Object.entries(lv)) {
          out.labels[tier][k] = _text(`labels.${tier}.${k}`, v, LABEL_FIELDS[k]);
          if (drawable && out.labels[tier][k]) _assertDrawable(`labels.${tier}.${k}`, out.labels[tier][k], platformName);
        }
      }
    }
    if (input.colors !== undefined) {
      _section("colors", input.colors, COLOUR_FIELDS);
      out.colors = {};
      for (const [k, v] of Object.entries(input.colors)) {
        if (typeof v !== "string" || !HEX_RE.test(v)) {
          throw new CertConfigError("certificate_config_bad_colour", `colors.${k}`, `colors.${k} must be a six-digit hex colour such as #D9AE4C.`);
        }
        out.colors[k] = v.toUpperCase();
      }
    }
    if (input.show !== undefined) {
      _section("show", input.show, SHOW_FIELDS);
      out.show = {};
      for (const [k, v] of Object.entries(input.show)) {
        if (typeof v !== "boolean") throw new CertConfigError("certificate_config_bad_type", `show.${k}`, `show.${k} must be true or false.`);
        out.show[k] = v;
      }
    }
    if (input.email !== undefined) {
      _section("email", input.email, EMAIL_FIELDS);
      out.email = {};
      for (const [k, v] of Object.entries(input.email)) {
        if (k === "enabled") {
          if (typeof v !== "boolean") throw new CertConfigError("certificate_config_bad_type", "email.enabled", "email.enabled must be true or false.");
          out.email.enabled = v;
        } else out.email[k] = _text(`email.${k}`, v, EMAIL_TEXT_FIELDS[k]);
      }
    }
    // A stored layer never carries an empty section: `{text:{}}` is `{}`.
    for (const s of SECTIONS) if (out[s] && !Object.keys(out[s]).length) delete out[s];
    if (out.labels) for (const t of Object.keys(out.labels)) if (!Object.keys(out.labels[t]).length) delete out.labels[t];
    if (out.labels && !Object.keys(out.labels).length) delete out.labels;
    return { ok: true, value: out };
  } catch (e) {
    if (e instanceof CertConfigError) return { ok: false, code: e.code, field: e.field, error: e.message };
    throw e;
  }
}

/**
 * The READ path: parse a stored JSON layer and keep every field that is valid
 * on its own, dropping the rest (a value from a newer image after a rollback, or
 * a hand edit). Returns `{}` for NULL, unparseable or non-object input.
 */
function sanitiseStoredConfig(raw) {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return {}; } }
  if (!_isPlainObject(obj)) return {};
  const out = {};
  const keep = (section, key, value) => {
    const probe = section === "labels"
      ? { labels: { [key]: value } }
      : { [section]: { [key]: value } };
    const r = validateCertificateConfig(probe, { drawable: false });
    if (!r.ok) return;
    if (section === "labels") {
      for (const [lk, lv] of Object.entries(r.value.labels?.[key] || {})) {
        ((out.labels = out.labels || {})[key] = out.labels[key] || {})[lk] = lv;
      }
    } else if (r.value[section]) {
      (out[section] = out[section] || {})[key] = r.value[section][key];
    }
  };
  for (const s of SECTIONS) {
    if (!_isPlainObject(obj[s])) continue;
    for (const [k, v] of Object.entries(obj[s])) {
      if (s === "labels") {
        if (!_isPlainObject(v)) continue;
        for (const [lk, lv] of Object.entries(v)) keep("labels", k, { [lk]: lv });
      } else keep(s, k, v);
    }
  }
  return out;
}

/** Deep-merge partial layers over the defaults. Later layers win, per field. */
function mergeCertificateConfig(...layers) {
  const out = _defaults();
  for (const layer of layers) {
    if (!_isPlainObject(layer)) continue;
    for (const s of SECTIONS) {
      const src = layer[s];
      if (!_isPlainObject(src)) continue;
      if (s === "labels") {
        for (const [t, lv] of Object.entries(src)) {
          if (!out.labels[t] || !_isPlainObject(lv)) continue;
          Object.assign(out.labels[t], lv);
        }
      } else {
        Object.assign(out[s], src);
      }
    }
  }
  return out;
}

/**
 * Replace `{platform}` (and, in the email fields, `{event}`; in the LinkedIn post
 * also `{achievement}` and `{organisers}`) in a configured string. A token whose
 * value is not supplied is left as written.
 */
function fillTokens(s, { platformName, eventName, achievement, organisers } = {}) {
  return String(s == null ? "" : s).replace(TOKEN_RE, (m, name) => (
    name === "platform" ? String(platformName || "")
      : (name === "event" && eventName !== undefined) ? String(eventName || "")
      : (name === "achievement" && achievement !== undefined) ? String(achievement || "")
      : (name === "organisers" && organisers !== undefined) ? String(organisers || "") : m));
}

const SETTINGS_KEY = "certificate_config";

function readGlobalLayer(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(SETTINGS_KEY);
  return row ? sanitiseStoredConfig(row.value) : {};
}

function readEventLayer(db, competitionId) {
  if (!competitionId) return {};
  const row = db.prepare("SELECT certificate_config FROM competitions WHERE id=?").get(competitionId);
  return row && row.certificate_config ? sanitiseStoredConfig(row.certificate_config) : {};
}

/** The design a certificate for `competitionId` renders with: defaults <- global <- event. */
function resolveCertificateConfig(db, competitionId) {
  return mergeCertificateConfig(readGlobalLayer(db), readEventLayer(db, competitionId));
}

/** Which tier a certificate renders as, from its frozen basis and rank. */
function certificateTier({ basis, rank } = {}) {
  if (basis === "completion") return "completion";
  if (basis === "participation") return "participation";
  if (rank === 1) return "gold";
  if (rank === 2) return "silver";
  if (rank === 3) return "bronze";
  return "participation";
}

module.exports = {
  certificateDefaults,
  TEXT_FIELDS, LABEL_DEFAULTS, TIERS, COLOUR_FIELDS, SHOW_FIELDS, SECTIONS,
  EMAIL_DEFAULTS,
  validateCertificateConfig, sanitiseStoredConfig, mergeCertificateConfig, fillTokens,
  SETTINGS_KEY, readGlobalLayer, readEventLayer, resolveCertificateConfig, certificateTier,
  _isPlainObject,
};
