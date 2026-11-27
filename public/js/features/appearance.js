"use strict";
// THE APPEARANCE PAGE (the account menu's Appearance row opens it).
//
// One place for how the app looks, per browser: the mode (Auto / Light / Dark),
// the two looks with live day and night previews, the six ambient light
// colours, and "Show all tips" (ui/help-tips.js). A role that may change the
// Settings "Platform look" card also sets the ORG-WIDE default look here (PATCH
// /api/admin/settings {default_look}): one gate for both doors. Outside
// an event that sets its own look, every browser without a look of its own
// follows it; a viewer's own pick wins unless the event they are in locks its
// look, the platform look is locked (staff browsers are exempt) or it was
// applied to everyone after the pick (the precedence is ui/theme.js
// _appearanceSources).
//
// Every control applies at once. A re-render replaces the pressed control, so
// focus is put back on its twin (the look picker's rule). Every value written
// into markup goes through esc(), constants included; the look previews and the
// "follows the default" note are built with DOM calls after the render.

import { csrfHeaders } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { overlayDismiss } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { esc } from "../ui/format.js";
import { tipsAllOn, setTipsAll } from "../ui/help-tips.js";
import {
  LOOKS, AMBIENTS, _lookPreference, _themePreference, _effectiveAmbient, _hasOwnLook, _orgDefaultLook,
  _applyLookPreference, _applyAmbientPreference, _applyThemePreference, _lookHasAmbient,
  _clearOwnLook, applyOrgDefaultLook, applyPlatformLook, _lookLockReason, _modeLockReason, HOUSE_LOOK,
  platformLook,
} from "../ui/theme.js";
import { renderPlatformLookCard } from "./look-admin.js";
import { settingsCardOffered } from "../ui/nav.js"; // read inside functions only

const OVERLAY_ID = "appearance-overlay";
const MODES = [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]];

/** Fetch the org default once at boot and adopt it (best effort, never blocks). */
export async function loadOrgDefaultLook() {
  try {
    const r = await fetch("/api/settings/appearance");
    if (!r.ok) return null;
    const d = await r.json();
    // The full platform look (look, mode, light, lock, stamp); the shell already
    // painted it, so this only catches a change made since the page loaded.
    if (d && d.platform_look && typeof d.platform_look === "object") applyPlatformLook(d.platform_look);
    else applyOrgDefaultLook(d && typeof d.default_look === "string" ? d.default_look : "");
    return d && typeof d.default_look === "string" ? d.default_look : "";
  } catch (_) { return null; }
}

/** The sentence a locked viewer reads instead of a control that does nothing. */
export function lookLockNote() {
  const why = _lookLockReason();
  if (why === "event") return "This event has its own look while you are in it. It returns to yours when you leave.";
  if (why === "platform") return "Your organisation has set the look for everyone.";
  return "";
}
const _lockNote = lookLockNote;

/** The same for the mode: a platform look locked WITH a mode keeps it. */
export function modeLockNote() {
  if (!_modeLockReason()) return "";
  const m = _themePreference();
  return m === "system"
    ? "Your organisation has set the mode for everyone: it follows each device's light or dark setting."
    : `Your organisation has set the mode for everyone: ${m === "dark" ? "Dark" : "Light"}.`;
}

function _modeSeg() {
  const note = modeLockNote();
  if (note) return `<p class="ap-note ap-lock-note" role="note">${esc(note)}</p>`;
  const mode = _themePreference();
  const btn = ([v, t]) =>
    `<button type="button" data-action="appearance-mode" data-mode="${esc(v)}" aria-pressed="${v === mode}">${esc(t)}</button>`;
  return `<div class="ha-seg ap-seg" role="group" aria-label="Mode">${MODES.map(btn).join("")}</div>`;
}

function _swatches() {
  const look = _lookPreference();
  if (!_lookHasAmbient(look)) return "";
  const amb = _effectiveAmbient(look);
  const one = (a) => `<button type="button" class="ap-amb" data-action="appearance-ambient" data-ambient-id="${esc(a.id)}" aria-pressed="${a.id === amb}" style="--c:${esc(a.swatch)}"><i aria-hidden="true"></i><span>${esc(a.label)}</span></button>`;
  return `<div class="ap-ambients" role="group" aria-label="Ambient light colour">${AMBIENTS.map(one).join("")}</div>`;
}

// ── DOM builders (no markup strings) ─────────────────────────────────────────
function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** One live mini preview: the real token set under its own data-look/data-theme. */
function _miniNode(look, theme, ambient) {
  const m = _el("div", "lp-mini");
  m.setAttribute("data-look", look);
  m.setAttribute("data-theme", theme);
  if (ambient) m.setAttribute("data-ambient", ambient);
  const bar = _el("div", "lp-mini-bar");
  bar.append(_el("i"), _el("b"), _el("span", null, "1,240"));
  const card = _el("div", "lp-mini-card");
  card.append(_el("span", "lp-mini-title", "Who can read it?"), _el("span", "lp-mini-tile on"), _el("span", "lp-mini-tile"), _el("span", "lp-mini-btn"));
  m.append(bar, card, _el("span", "lp-mini-gauge"));
  return m;
}

/** Fill every [data-pair-look] slot with its day/night previews. */
function _fillPreviews(root) {
  const current = _lookPreference();
  root.querySelectorAll("[data-pair-look]").forEach((slot) => {
    const l = LOOKS.find((x) => x.id === slot.getAttribute("data-pair-look"));
    if (!l) return;
    const ambient = l.id === current && _lookHasAmbient(l.id) ? _effectiveAmbient(l.id) : "";
    slot.replaceChildren(_miniNode(l.id, "light", ambient), _miniNode(l.id, "dark", ambient));
  });
}

/** The note under "Look": does this browser follow the default, or keep its own? */
function _fillFollowNote(root) {
  const slot = root.querySelector("#ap-follow-note");
  if (!slot) return;
  const whose = _orgDefaultLook() ? "organisation" : "house";
  if (_hasOwnLook()) {
    const b = _el("button", "link-btn-inline", `Use the ${whose} default instead`);
    b.type = "button";
    b.setAttribute("data-action", "appearance-clear-look");
    slot.replaceChildren(document.createTextNode("This browser keeps its own look. "), b);
  } else {
    slot.textContent = `This browser follows the ${whose} default until you pick a look.`;
  }
}

function _orgOptions(cur) {
  const opt = (l) => `<option value="${esc(l.id)}"${cur === l.id ? " selected" : ""}>${esc(l.label)}</option>`;
  return `<option value=""${cur ? "" : " selected"}>Default (Ambient, following the device)</option>`
    + LOOKS.filter((l) => l.id !== HOUSE_LOOK).map(opt).join("");
}

/** A section title with its "?" tip BESIDE it (a sibling, never inside the
 *  heading), so the heading's own text stays its name. */
function _head(id, text, tip, tipLabel) {
  const h = `<h4 id="${esc(id)}" class="ap-h">${esc(text)}</h4>`;
  return tip ? `<div class="help-label-row">${h}<span data-help="${esc(tip)}" data-help-label="${esc(tipLabel)}"></span></div>` : h;
}

function _orgSection() {
  if (!settingsCardOffered("platform-look-card")) return "";
  // The look in force now: the Settings card's Platform look writes the same
  // setting, so a value remembered from this page's last save would go stale
  // (and a save would put the old look back).
  const cur = _orgDefaultLook();
  return `<section class="ap-section ap-org" aria-labelledby="ap-org-title">
    ${_head("ap-org-title", "Organisation default", "appearance.org", "Organisation default")}
    <p class="ap-note">Every browser that has not picked a look gets this one, outside events that set their own. With none set, the house default applies: Ambient, following each device's light or dark setting.</p>
    <div class="ap-org-row"><label for="ap-org-look" class="ap-label">Default look</label>
      <select id="ap-org-look">${_orgOptions(cur)}</select>
      <button type="button" class="btn" data-action="appearance-org-save">Save default</button></div>
  </section>`;
}

function _lookCard(l, look) {
  const on = l.id === look;
  const id = esc(l.id);
  return `<div class="lp-card${on ? " is-on" : ""}" data-action="appearance-look" data-look-id="${id}">`
    + `<div class="lp-pair" data-pair-look="${id}" aria-hidden="true"></div>`
    + `<div class="lp-card-text"><h4 class="lp-card-title"><button type="button" class="card-open" data-action="appearance-look" data-look-id="${id}" aria-pressed="${on}">${esc(l.label)}</button>`
    + `<span class="lp-tag">${esc(l.tag)}</span></h4>`
    + `<p class="lp-blurb">${esc(l.blurb)}</p><p class="lp-traits">${esc(l.traits || "")}${l.traits ? " · " : ""}day and night</p></div></div>`;
}

function _lookCards() {
  const look = _lookPreference();
  return LOOKS.map((l) => _lookCard(l, look)).join("");
}

function _ambSection() {
  return _lookHasAmbient(_lookPreference())
    ? `<section class="ap-section" aria-labelledby="ap-amb-title">${_head("ap-amb-title", "Ambient light", "appearance.ambient", "Ambient light")}${_swatches()}</section>`
    : `<section class="ap-section" aria-labelledby="ap-amb-title">${_head("ap-amb-title", "Ambient light")}<p class="ap-note">Ambient lights its accent in a colour you choose; pick Ambient to set it.</p></section>`;
}

function _body() {
  // A locked mode is said, not offered, and its "?" (which explains the three
  // choices) goes with the choices.
  const modeLocked = !!_modeLockReason();
  return `<div class="picker-modal picker-modal-wide look-picker ap-page" role="dialog" aria-modal="true" aria-labelledby="ap-title">
    <div class="picker-modal-head">
      <div><p class="eyebrow ink">Your browser</p><h3 id="ap-title" class="display lp-title">Appearance</h3></div>
    </div>
    <section class="ap-section" aria-labelledby="ap-mode-title">${modeLocked ? _head("ap-mode-title", "Mode") : _head("ap-mode-title", "Mode", "appearance.mode", "Mode")}${_modeSeg()}</section>
    ${_lockNote()
      ? `<section class="ap-section" aria-labelledby="ap-look-title">${_head("ap-look-title", "Look")}<p class="ap-note ap-lock-note" role="note">${esc(_lockNote())}</p></section>`
      : `<section class="ap-section" aria-labelledby="ap-look-title">${_head("ap-look-title", "Look", "appearance.look", "Look")}<p class="ap-note" id="ap-follow-note"></p><div class="lp-grid">${_lookCards()}</div></section>
    ${_ambSection()}`}
    <section class="ap-section" aria-labelledby="ap-tips-title">${_head("ap-tips-title", "Help tips", "appearance.tips", "Show all tips")}
      <label class="checkbox-row"><input type="checkbox" id="ap-tips-all" data-change-action="appearance-tips"${tipsAllOn() ? " checked" : ""}/> Show all tips</label></section>
    ${_orgSection()}
    <div class="picker-modal-foot"><button type="button" class="btn" data-action="overlay-close" data-overlay-id="${OVERLAY_ID}">Done</button></div>
  </div>`;
}

function _renderPage(focusSel) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  setSafeHtml(overlay, _body());
  _fillPreviews(overlay);
  _fillFollowNote(overlay);
  if (focusSel) overlay.querySelector(focusSel)?.focus();
}

export function openAppearancePage() {
  if (document.getElementById(OVERLAY_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "picker-overlay";
  document.body.appendChild(overlay);
  // Before focus moves in, so the opener is captured and restored on close.
  overlayDismiss(overlay, () => overlay.remove());
  _renderPage();
  // Focus goes INTO the dialog: the look in force, else the mode in force,
  // else (a lock offers neither) Done, without scrolling the page to its foot.
  const choice = overlay.querySelector(`.card-open[aria-pressed="true"]`) || overlay.querySelector(`[data-action="appearance-mode"][aria-pressed="true"]`);
  if (choice) choice.focus();
  else overlay.querySelector('[data-action="overlay-close"]')?.focus({ preventScroll: true });
}

export function appearanceMode(mode) {
  _applyThemePreference(mode);
  _renderPage(`[data-action="appearance-mode"][data-mode="${mode}"]`);
}
export function appearanceLook(id) {
  _applyLookPreference(id);
  _renderPage(`.card-open[data-look-id="${id}"]`);
}
export function appearanceAmbient(id) {
  _applyAmbientPreference(id);
  _renderPage(`[data-action="appearance-ambient"][data-ambient-id="${id}"]`);
}
export function appearanceClearLook() {
  _clearOwnLook();
  _renderPage(`.card-open[aria-pressed="true"]`);
}
export function appearanceTips(on) { setTipsAll(!!on); }

export async function appearanceOrgSave() {
  const sel = document.getElementById("ap-org-look");
  if (!sel) return;
  let r = null, d = {};
  try {
    r = await fetch("/api/admin/settings", { method: "PATCH", headers: csrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ default_look: sel.value }) });
    d = await r.json().catch(() => ({}));
  } catch (_) { r = null; }
  if (!r || !r.ok || !d.ok) { showToast((d && d.error) || "Could not save the default look.", "error"); return; }
  applyOrgDefaultLook(d.default_look || "");
  // The Settings card edits the same platform look (and saves every field of
  // it), so it is redrawn from what this save left, or its next save would put
  // the old look back.
  renderPlatformLookCard(platformLook());
  showToast("Default look saved.", "success");
  _renderPage("#ap-org-look");
}
