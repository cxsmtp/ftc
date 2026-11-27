"use strict";
// THE LOOK & THEME PICKER. Two looks as cards with live day and night mini
// previews (each preview is the real token set: it carries its own data-look and
// data-theme, so it renders from the same generated block as the page), the
// mode (Auto / Day / Night, the same "hck-theme" preference as the Appearance
// page's Mode control) and the ambient light colour. Every choice applies at once and persists per
// browser (ui/theme.js).
//
// A card is not the button: its title holds the one control, named by the look,
// and the card keeps the data-action so a press anywhere on it still works.

import { setSafeHtml } from "../core/trusted-types.js";
import { overlayDismiss } from "../ui/modal.js";
import { esc } from "../ui/format.js";
import {
  LOOKS, AMBIENTS, _lookPreference, _ambientPreference, _themePreference,
  _applyLookPreference, _applyAmbientPreference, _applyThemePreference,
  _lookLockReason, _modeLockReason,
} from "../ui/theme.js";
import { lookLockNote, modeLockNote } from "./appearance.js";

const OVERLAY_ID = "look-picker-overlay";

// Every value is escaped: the ambient preference is read back from this
// browser's storage and the org default, so it is data, not a constant.
function _mini(look, theme, ambient) {
  return `<div class="lp-mini" data-look="${esc(look)}" data-theme="${esc(theme)}"${ambient ? ` data-ambient="${esc(ambient)}"` : ""}>`
    + `<div class="lp-mini-bar"><i></i><b></b><span>1,240</span></div>`
    + `<div class="lp-mini-card"><span class="lp-mini-title">Who can read it?</span><span class="lp-mini-tile on"></span><span class="lp-mini-tile"></span><span class="lp-mini-btn"></span></div>`
    + `<span class="lp-mini-gauge"></span></div>`;
}

function _body() {
  const look = _lookPreference(), amb = _ambientPreference(), mode = _themePreference();
  const modes = [["system", "Auto"], ["light", "Day"], ["dark", "Night"]];
  const cards = LOOKS.map((l) => {
    const on = l.id === look;
    const pair = _mini(l.id, "light", amb) + _mini(l.id, "dark", amb);
    return `<div class="lp-card${on ? " is-on" : ""}" data-action="look-picker-look" data-look-id="${esc(l.id)}">`
      + `<div class="lp-pair" aria-hidden="true">${pair}</div>`
      + `<div class="lp-card-text"><h4 class="lp-card-title"><button type="button" class="card-open" data-action="look-picker-look" data-look-id="${esc(l.id)}" aria-pressed="${on}">${esc(l.label)}</button>`
      + `<span class="lp-tag">${esc(l.tag)}</span></h4>`
      + `<p class="lp-blurb">${esc(l.blurb)}</p><p class="lp-traits">${esc(l.traits)} · day and night</p></div></div>`;
  }).join("");
  const swatches = AMBIENTS.map((a) =>
    `<button type="button" class="lp-swatch" data-action="look-picker-ambient" data-ambient-id="${esc(a.id)}" aria-pressed="${a.id === amb}" style="--c:${esc(a.swatch)}"><i aria-hidden="true"></i>${esc(a.label)}</button>`).join("");
  // A locked look (the event's, or the organisation's) or a locked mode is
  // said, not offered: a choice that cannot apply is not a control. With only
  // the look locked the dialog keeps the mode (it is a signed-out visitor's
  // only mode control). A lock can arrive after the picker opened (a join
  // landing's preview), so every render asks.
  const lookNote = _lookLockReason() ? lookLockNote() : "";
  const modeNote = _modeLockReason() ? modeLockNote() : "";
  const modeCtl = modeNote ? `<p class="ap-note ap-lock-note" role="note">${esc(modeNote)}</p>`
    : `<div class="ha-seg" role="group" aria-label="Mode">${modes.map(([v, t]) =>
        `<button type="button" data-action="look-picker-mode" data-mode="${v}" aria-pressed="${v === mode}">${t}</button>`).join("")}</div>`;
  const looksHtml = lookNote ? `<p class="ap-note ap-lock-note" role="note">${esc(lookNote)}</p>`
    : `<p class="lp-lede">Two looks, each in day and night. Your choice is kept in this browser.</p>
    <div class="lp-grid">${cards}</div>
    <section class="lp-ambient" aria-labelledby="lp-amb-title">
      <div><p class="eyebrow">Ambient light</p><h4 id="lp-amb-title" class="lp-amb-title">Pick the colour of the light lines</h4>
        <p class="lp-note">Applies to Ambient. Every colour keeps text at WCAG AA.</p></div>
      <div class="lp-swatches" role="group" aria-labelledby="lp-amb-title">${swatches}</div>
    </section>`;
  return `<div class="picker-modal picker-modal-wide look-picker" role="dialog" aria-modal="true" aria-labelledby="lp-title">
    <div class="picker-modal-head">
      <div><p class="eyebrow ink">Appearance</p><h3 id="lp-title" class="display lp-title">Look &amp; theme</h3></div>
      ${modeCtl}
    </div>
    ${looksHtml}
    <div class="picker-modal-foot"><button type="button" class="btn" data-action="overlay-close" data-overlay-id="${OVERLAY_ID}">Done</button></div>
  </div>`;
}

function _render(focusSel) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  setSafeHtml(overlay, _body());
  // A lock that arrived meanwhile replaces the pressed control with its note:
  // focus then goes to Done, never out of the dialog.
  if (focusSel) (overlay.querySelector(focusSel) || overlay.querySelector('[data-action="overlay-close"]'))?.focus();
}

export function openLookPicker() {
  if (document.getElementById(OVERLAY_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "picker-overlay";
  document.body.appendChild(overlay);
  // Before focus moves in, so the opener is captured and restored on close.
  overlayDismiss(overlay, () => overlay.remove());
  _render();
  // The chosen look, else (a locked look) the chosen mode, else Done.
  (overlay.querySelector(`.card-open[aria-pressed="true"]`)
    || overlay.querySelector('[data-action="look-picker-mode"][aria-pressed="true"]')
    || overlay.querySelector('[data-action="overlay-close"]'))?.focus();
}

// A re-render replaces the pressed control, so focus is put back on its twin.
export function lookPickerLook(id) {
  _applyLookPreference(id);
  _render(`.card-open[data-look-id="${id}"]`);
}
export function lookPickerMode(mode) {
  _applyThemePreference(mode);
  _render(`[data-action="look-picker-mode"][data-mode="${mode}"]`);
}
export function lookPickerAmbient(id) {
  _applyAmbientPreference(id);
  _render(`[data-action="look-picker-ambient"][data-ambient-id="${id}"]`);
}
