"use strict";

import { setSafeHtml } from "../core/trusted-types.js";
import { _helpMountIcon } from "../features/help-drawer.js";
import { renderReleaseNotesButton } from "../features/release-notes.js";

// THE HOUSE DEFAULT: the look and mode a browser paints when neither the
// platform, the event nor the viewer has chosen. public/theme-boot.js mirrors
// both (HOUSE_LOOK / HOUSE_MODE); change them together.
export const HOUSE_LOOK = "ambient";
export const HOUSE_MODE = "system";

/**
 * The user's mode PREFERENCE ("hck-theme": system | light | dark), which is not
 * the same thing as the theme in force: "system" resolves to light or dark
 * depending on the OS. It is set by the Appearance page's Mode control (and,
 * signed out, the look picker's), each offering all three, so there is always a
 * way back to following the OS. Anything not recognised (including nothing
 * stored) is the house mode, "system" (HOUSE_MODE: follow the device; part of
 * the flat-design plan the operator approved, 13 Nov 2026), unless the platform
 * look sets a mode.
 */
export function _themePreference() {
  const s = _appearanceSources();
  if (s.pLocked && s.P.mode) return s.P.mode;
  return s.ownMode || s.P.mode || HOUSE_MODE;
}

/** What "system" currently means. Falls back to dark, matching theme-boot.js. */
export function _systemTheme() {
  try {
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  } catch (_) { return "dark"; }
}

/** The mode a preference paints: "system" follows the device. */
export function _resolveTheme(pref) {
  return pref === "system" ? _systemTheme() : pref;
}

// ── THE LOOKS ───────────────────────────────────────────────────────────────
// Two flat looks, each with a day and a night mode, and six ambient light
// colours for Ambient's accent (operator ruling, 13 Nov 2026). The
// choice is per browser: localStorage "hck-look" / "hck-ambient", read before
// first paint by public/theme-boot.js, whose LOOKS / AMBIENTS tables mirror
// these ids (a classic script cannot import this module). The palette itself is
// generated into public/styles.css from scripts/theme/looks.js.
export const LOOKS = [
  { id: "signature", label: "Signature", tag: "Original",
    blurb: "Checkmarx violet, ivory and certificate gold. The original look.",
    traits: "Violet and gold · ivory by day" },
  { id: "ambient", label: "Ambient", tag: "House default",
    blurb: "Graphite and soft panels, with one accent colour you choose.",
    traits: "Soft panels · six accent colours" },
];
// `swatch` paints only the decorative colour dot; every text pair the colour
// produces is measured by scripts/build-theme-tokens.js.
export const AMBIENTS = [
  { id: "violet", label: "Violet", swatch: "#8f72ff" },
  { id: "cyan", label: "Glacier", swatch: "#2fc6e6" },
  { id: "amber", label: "Amber", swatch: "#ffab33" },
  { id: "rose", label: "Rose", swatch: "#ff6f9a" },
  { id: "emerald", label: "Emerald", swatch: "#34d08a" },
  { id: "ice", label: "Ice", swatch: "#6cc0ff" },
];
const _LOOK_IDS = new Set(LOOKS.map((l) => l.id));
const _AMBIENT_IDS = new Set(AMBIENTS.map((a) => a.id));
/** The look each ambient-lit look uses when the viewer has not picked a colour. */
export const DEFAULT_AMBIENT = { ambient: "ice" };

// Per-browser storage that may be unavailable (private mode, blocked site
// data). Each helper reports whether it worked; a failure is a normal state —
// the page then simply follows the defaults for this load.
export function _readPref(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
export function _writePref(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return true;
  } catch (_) { return false; }
}

// THE PLATFORM LOOK AND THE EVENT LOOK (lib/platform-look.js). A superadmin sets
// the look, mode and light colour every browser starts from; it rides the SPA
// shell (<html data-platform-look>) and public/theme-boot.js paints it before
// the first frame. An organiser may set a look per event, painted on its join
// landing and while a participant is inside it. Precedence (theme-boot.js
// mirrors it; change both together):
//   1. a LOCKED event look, while inside that event;
//   2. a LOCKED platform look, for anyone this browser does not know as staff;
//   3. this browser's own choice, unless it predates the platform's last
//      "Apply to everyone now" (its "hck-look-v" is older than the stamp);
//   4. an unlocked event look; 5. the platform look; 6. the house default
//      (HOUSE_LOOK / HOUSE_MODE: Ambient, following the device).
const _MODES = new Set(["system", "light", "dark"]);
let _platform = null;
function _parsePlatform(o) {
  const x = o && typeof o === "object" ? o : {};
  return {
    look: _LOOK_IDS.has(x.look) ? x.look : "",
    mode: _MODES.has(x.mode) ? x.mode : "",
    ambient: _AMBIENT_IDS.has(x.ambient) ? x.ambient : "",
    lock: x.lock === true,
    stamp: Number.isSafeInteger(x.stamp) && x.stamp > 0 ? x.stamp : 0,
  };
}
/** The platform look in force for this page (the shell's, or a fresher answer). */
export function platformLook() {
  if (_platform) return _platform;
  let raw = null;
  try { raw = JSON.parse(document.documentElement.getAttribute("data-platform-look") || "null"); } catch (_) { raw = null; }
  _platform = _parsePlatform(raw);
  return _platform;
}
function _readSession(key) {
  try { return sessionStorage.getItem(key); } catch (_) { return null; }
}
/** The event look while inside an event: `{ look, locked }` or null. */
export function eventLook() {
  let e = null;
  try { e = JSON.parse(_readSession("hck-event-look") || "null"); } catch (_) { e = null; }
  return e && _LOOK_IDS.has(e.look) ? { look: e.look, locked: e.locked === true } : null;
}
/** True when this browser's last signed-in account was staff (lock-exempt). */
export function _isStaffBrowser() { return _readPref("hck-staff") === "1"; }
function _ownValid(P) {
  const v = parseInt(_readPref("hck-look-v") || "0", 10) || 0;
  return !(P.stamp && v < P.stamp);
}
export function _appearanceSources() {
  const P = platformLook();
  const E = eventLook();
  const valid = _ownValid(P);
  const own = (k, ok) => { const v = valid ? _readPref(k) : null; return ok(v) ? v : ""; };
  return {
    P, E,
    eLocked: !!(E && E.locked),
    pLocked: P.lock && !_isStaffBrowser(),
    ownLook: own("hck-look", (v) => _LOOK_IDS.has(v)),
    ownMode: own("hck-theme", (v) => _MODES.has(v)),
    ownAmb: own("hck-ambient", (v) => _AMBIENT_IDS.has(v)),
  };
}
/** Why this viewer cannot choose a look here ("" when they can). */
export function _lookLockReason() {
  const s = _appearanceSources();
  if (s.eLocked) return "event";
  if (s.pLocked) return "platform";
  return "";
}
/**
 * Why this viewer cannot choose the MODE ("" when they can): a platform look
 * locked WITH a mode keeps that mode for everyone the lock binds. The one
 * predicate the setter refuses on and every Mode control is gated on.
 */
export function _modeLockReason() {
  const s = _appearanceSources();
  return s.pLocked && s.P.mode ? "platform" : "";
}
/** The org (platform) default look id, "" for none. */
export function _orgDefaultLook() { return platformLook().look; }
/** True when this browser has a look of its own that is still in force. */
export function _hasOwnLook() { return !!_appearanceSources().ownLook; }
export function _lookPreference() {
  const s = _appearanceSources();
  if (s.eLocked) return s.E.look;
  if (s.pLocked) return s.P.look || HOUSE_LOOK;
  return s.ownLook || (s.E && s.E.look) || s.P.look || HOUSE_LOOK;
}
export function _ambientPreference() {
  const s = _appearanceSources();
  if (s.pLocked && s.P.ambient) return s.P.ambient;
  return s.ownAmb || s.P.ambient;
}
/** The colour actually lit: the stored pick, else the look's default (Ice). */
export function _effectiveAmbient(look) {
  return _ambientPreference() || DEFAULT_AMBIENT[look] || "";
}
function _paintAmbient(look) {
  const a = _effectiveAmbient(look);
  if (a) document.documentElement.setAttribute("data-ambient", a);
  else document.documentElement.removeAttribute("data-ambient");
}
function _paintLook(look) {
  document.documentElement.setAttribute("data-look", look);
  document.documentElement.setAttribute("data-theme", _resolveTheme(_themePreference()));
  _paintAmbient(look);
  _syncLookPickerBtn();
}
/** Re-resolve every source and repaint (after a sign-in, an event change, a lock). */
export function repaintAppearance() { _paintLook(_lookPreference()); }
/** A personal choice is made against the platform stamp in force now. */
function _stampOwnChoice() { _writePref("hck-look-v", String(platformLook().stamp || 0)); }
/**
 * Adopt the platform look the server reported (GET /api/settings/appearance or
 * the Settings card's save). A bare id is the older "default look" answer.
 */
export function applyPlatformLook(obj) {
  _platform = _parsePlatform(typeof obj === "string" ? { look: obj } : obj);
  if (_platform.stamp && !_ownValid(_platform)) {
    _writePref("hck-look", null); _writePref("hck-theme", null); _writePref("hck-ambient", null);
    _stampOwnChoice();
  }
  repaintAppearance();
}
/** Back-compat name: the org default look id ("" for none), mode and lock unchanged. */
export function applyOrgDefaultLook(id) { applyPlatformLook({ ...platformLook(), look: _LOOK_IDS.has(id) ? id : "" }); }
/** Mark this browser staff (lock-exempt) or not; the nav builders call it. */
export function setStaffBrowser(on) {
  if (on === _isStaffBrowser()) return;
  _writePref("hck-staff", on ? "1" : null);
  repaintAppearance();
}
/**
 * Enter or leave an event's look: `{ look, locked }`, or null to leave. Kept in
 * sessionStorage so a reload inside the event paints it before first paint.
 */
export function setEventLook(e) {
  const v = e && _LOOK_IDS.has(e.look) ? JSON.stringify({ look: e.look, locked: e.locked === true }) : null;
  if (v === _readSession("hck-event-look")) return;
  try { if (v) sessionStorage.setItem("hck-event-look", v); else sessionStorage.removeItem("hck-event-look"); }
  catch (_) { /* no session storage: the look still paints for this view below */ }
  repaintAppearance();
}
/** Forget this browser's own look, so the event, org or house default applies again. */
export function _clearOwnLook() {
  _writePref("hck-look", null);
  _paintLook(_lookPreference());
}
export function _lookHasAmbient(id) { return Object.prototype.hasOwnProperty.call(DEFAULT_AMBIENT, id); }

/** Paint and persist a look; the mode re-resolves (a night-only look forces dark). */
export function _applyLookPreference(id) {
  if (!_LOOK_IDS.has(id) || _lookLockReason()) return;
  _writePref("hck-look", id);
  _stampOwnChoice();
  _paintLook(_lookPreference());
}
/** Paint and persist an ambient light colour (it shows on the Ambient look). */
export function _applyAmbientPreference(id) {
  if (!_AMBIENT_IDS.has(id) || _lookLockReason()) return;
  _writePref("hck-ambient", id);
  _stampOwnChoice();
  _paintAmbient(_lookPreference());
}

/** Apply a mode preference (Appearance's Mode control, the look picker's): paint it and persist it. */
export function _applyThemePreference(pref) {
  if (!_MODES.has(pref)) return;
  // A platform look locked WITH a mode keeps that mode for this viewer.
  if (_modeLockReason()) return;
  _stampOwnChoice();
  document.documentElement.setAttribute("data-theme", _resolveTheme(pref));
  // "system" is stored as an explicit value rather than by REMOVING the key,
  // so a deliberate "follow the system" is distinguishable from "never
  // chose" (the house mode is "system" too, but a platform mode would
  // override an unstored one).
  _writePref("hck-theme", pref);
}

// The one appearance control loose in the header exists only while SIGNED OUT
// (there is no account menu yet): the look picker, whose dialog also holds the
// mode. Signed in, Appearance lives in the account menu (ui/nav.js
// openProfileMenu) and the app-chrome CSS hides #theme-slot.
const _LOOK_PICKER_BTN = () => `<button type="button" id="look-picker-btn" class="help-icon-btn" data-action="open-look-picker" title="Look and theme" aria-label="Look and theme" aria-haspopup="dialog">${_PALETTE_SVG}</button>`;
// It is the signed-out visitor's only mode control, so a locked LOOK keeps it:
// the dialog then offers the mode and says the look is set
// (features/look-picker.js). Only when the mode is locked too is there nothing
// to choose, and nothing is offered: no control at all, not a disabled one
// saying the organisation set it (operator ruling, 14 Nov 2026).
function _lookPickerOffered() { return !(_lookLockReason() && _modeLockReason()); }
export function _mountLookPicker(){
  const slot = document.getElementById("theme-slot");
  if (!slot) return;
  slot.dataset.mounted = "1";
  setSafeHtml(slot, _lookPickerOffered() ? _LOOK_PICKER_BTN() : "");
}
/**
 * Keep the header's look picker in step with the locks on EVERY repaint, not
 * only at mount: a join landing mounts the header before the event preview
 * answers, so a lock can arrive after the picker was offered (or lift after it
 * was withheld). Nothing happens before boot mounted the slot.
 */
function _syncLookPickerBtn() {
  const slot = document.getElementById("theme-slot");
  if (!slot || !slot.dataset.mounted) return;
  const btn = document.getElementById("look-picker-btn");
  const offered = _lookPickerOffered();
  if (!offered && btn) {
    if (document.activeElement === btn) document.getElementById("help-icon-btn")?.focus();
    btn.remove();
  } else if (offered && !btn) {
    const tmp = document.createElement("span");
    setSafeHtml(tmp, _LOOK_PICKER_BTN());
    slot.insertBefore(tmp.firstElementChild, slot.firstChild);
  }
}

export const _PALETTE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/></svg>';

// v8.5.0 — renderReleaseNotesButton() joins the boot mount so the resting state
// is decided once, at DOM-ready, for the case neither nav builder covers: an
// ANONYMOUS first paint. It renders nothing there, which is the point — the two
// nav builders take over the moment a role is known.
export function _mountHeaderIcons() { _helpMountIcon(); _mountLookPicker(); renderReleaseNotesButton(); }
