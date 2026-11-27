"use strict";

// THE PLATFORM LOOK — the app-wide default appearance a superadmin sets in
// Settings, and the per-event look an organiser sets on an event.
//
// Platform look (`settings.platform_look`, JSON): `{ look, mode, ambient, lock,
// stamp }`.
//   look     a look id, or "" for the house default (Ambient).
//   mode     "system" | "light" | "dark", or "" for the viewer's own choice,
//            else the house mode (system: the device's own mode).
// The house default (Ambient, following the device) lives in the client copies of the
// precedence rule (public/theme-boot.js, ui/theme.js HOUSE_LOOK / HOUSE_MODE);
// an empty field here, and on the shell, means "the house default".
//   ambient  an ambient colour id, or "" for the look's own default.
//   lock     true: participants (and signed-out visitors) always get it; their
//            own choice in the Appearance controls is not offered. Staff keep
//            their own.
//   stamp    ms of the last "Apply to everyone now"; 0 for never. A browser
//            whose own choice was made against an OLDER stamp drops that choice
//            and adopts the default (public/theme-boot.js, ui/theme.js).
// It rides every page that runs public/theme-boot.js, on `<html
// data-platform-look>`: the SPA shell and the help page (server.js fills their
// {{platformLook}}) and the pages opened from email links (platformLookAttr
// below). So the very first paint of each, the anonymous sign-in page included,
// already has it (operator ruling, 14 Nov 2026, for the help and email pages).
//
// The legacy `settings.default_look` (a bare look id) is read as the look when
// no platform look is stored, and dropped by the first write.
//
// Event look (`competitions.event_look`, `competitions.event_look_locked`): a
// look id painted on the event's join landing and for its participants while
// they are inside it. Locked, it overrides a participant's own choice too.
//
// The id tables mirror public/js/ui/theme.js LOOKS / AMBIENTS and
// public/theme-boot.js (client/server mirror registry in CLAUDE.md).

const db = require("../db");
const { swallowed } = require("./best-effort");

const LOOK_IDS = Object.freeze(["signature", "ambient"]);
const AMBIENT_IDS = Object.freeze(["violet", "cyan", "amber", "rose", "emerald", "ice"]);
const MODES = Object.freeze(["system", "light", "dark"]);
const BODY_KEYS = Object.freeze(["look", "mode", "ambient", "lock", "apply_now"]);

const EMPTY = Object.freeze({ look: "", mode: "", ambient: "", lock: false, stamp: 0 });

function _clean(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    look: LOOK_IDS.includes(o.look) ? o.look : "",
    mode: MODES.includes(o.mode) ? o.mode : "",
    ambient: AMBIENT_IDS.includes(o.ambient) ? o.ambient : "",
    lock: o.lock === true,
    stamp: Number.isSafeInteger(o.stamp) && o.stamp > 0 ? o.stamp : 0,
  };
}

// Memoised: the SPA shell reads it on every page load. Written only through
// setPlatformLook (one process per data volume), which drops the memo.
let _cache = null;
function _invalidatePlatformLookCache() { _cache = null; }

function getPlatformLook() {
  if (_cache) return _cache;
  let v = { ...EMPTY };
  const raw = db.prepare("SELECT value FROM settings WHERE key='platform_look'").get()?.value;
  if (raw) {
    // A damaged row reads as no default rather than failing every page load.
    try { v = _clean(JSON.parse(raw)); } catch (e) { swallowed("platform-look:parse", e); v = { ...EMPTY }; }
  } else {
    const legacy = db.prepare("SELECT value FROM settings WHERE key='default_look'").get()?.value;
    if (LOOK_IDS.includes(legacy)) v.look = legacy;
  }
  _cache = Object.freeze(v);
  return _cache;
}

/**
 * Validate a PUT body. Strict: an unknown key, a wrong type or an unknown id is
 * a named 400, never ignored. Returns `{ ok:true, value, applyNow }` or
 * `{ ok:false, code, error }`. `value.stamp` is left to the caller.
 */
function validatePlatformLook(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "platform_look_invalid", error: "Send the look as an object." };
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.includes(k)) return { ok: false, code: "platform_look_unknown_key", error: `Unknown setting "${String(k).slice(0, 40)}".` };
  }
  const str = (k, list, code, what) => {
    const x = body[k];
    if (x === undefined || x === null || x === "") return { ok: true, v: "" };
    if (typeof x !== "string" || !list.includes(x)) return { ok: false, code, error: `Unknown ${what}.` };
    return { ok: true, v: x };
  };
  const look = str("look", LOOK_IDS, "platform_look_unknown", "look");
  if (!look.ok) return look;
  const mode = str("mode", MODES, "platform_mode_unknown", "mode");
  if (!mode.ok) return mode;
  const ambient = str("ambient", AMBIENT_IDS, "platform_ambient_unknown", "light colour");
  if (!ambient.ok) return ambient;
  if (body.lock !== undefined && typeof body.lock !== "boolean") return { ok: false, code: "platform_look_invalid", error: "lock must be true or false." };
  if (body.apply_now !== undefined && typeof body.apply_now !== "boolean") return { ok: false, code: "platform_look_invalid", error: "apply_now must be true or false." };
  return { ok: true, value: { look: look.v, mode: mode.v, ambient: ambient.v, lock: body.lock === true }, applyNow: body.apply_now === true };
}

/** Store a validated platform look (the caller owns the transaction and audit). */
function setPlatformLook(value) {
  const v = _clean(value);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('platform_look', ?)").run(JSON.stringify(v));
  db.prepare("DELETE FROM settings WHERE key='default_look'").run();
  _invalidatePlatformLookCache();
  return v;
}

/**
 * The platform look as the attribute a server-rendered page puts on its <html>
 * (` data-platform-look="…"`): every page that runs theme-boot.js carries it, so
 * the look, mode, light colour and lock reach the verification results, the
 * email-change pages and the LinkedIn share page as they reach the app. Those
 * pages have one palette of their own, so they follow its light or dark and its
 * lock; the help page (styles.css) follows all of it.
 */
function platformLookAttr() {
  const { escapeHtml } = require("./sanitise");
  return ` data-platform-look="${escapeHtml(JSON.stringify(getPlatformLook()))}"`;
}

/** Validate an event look: a look id or ""/null (none). */
function validateEventLook(look, locked) {
  if (look !== undefined && look !== null && look !== "" && (typeof look !== "string" || !LOOK_IDS.includes(look)))
    return { ok: false, code: "event_look_unknown", error: "Unknown look." };
  if (locked !== undefined && typeof locked !== "boolean")
    return { ok: false, code: "event_look_invalid", error: "locked must be true or false." };
  return { ok: true, look: look || null, locked: !!look && locked === true };
}

module.exports = {
  LOOK_IDS, AMBIENT_IDS, MODES,
  getPlatformLook, validatePlatformLook, setPlatformLook, _invalidatePlatformLookCache,
  validateEventLook, platformLookAttr,
};
