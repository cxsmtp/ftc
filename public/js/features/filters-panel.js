"use strict";

// ── THE FILTERS PATTERN ──────────────────────────────────────────────────────
//
// Every admin list (Events, Participants / People, the Challenge library) shows
// a search box and ONE "Filters" button. The button opens a panel (a sheet on
// phones) holding the list's chip groups — the SAME elements, ids and actions
// as before, so every filter handler, and every spec that drives them, is
// unchanged. While any chip is active the button reads "Filters · N" and the
// active chips sit beside it as removable chips ("Live ×"); Clear all resets.
//
// The panel's open state is a per-browser convenience (localStorage, guarded),
// never a setting. A MutationObserver on each panel's chips keeps the summary
// in step with whatever changed a chip (a click, a poll re-render, a helper).
//
// ON A PHONE THE OPEN PANEL IS A SHEET OVER THE PAGE (styles.css), and a sheet
// is a dialog, so it keeps the shared dialog contract (operator ruling, 14 Nov
// 2026): a scrim behind it, `role="dialog"` + `aria-modal`, Escape closes it
// (the shared Escape stack), Tab stays inside it (the shared focus trap), and
// focus returns to its Filters button. A sheet is opened by a press, never by a
// page load: the remembered open state is restored on a wider screen only,
// where the panel is an inline part of the list and takes none of the contract.

import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { overlayDismiss } from "../ui/modal.js";

// An "all" chip means "no filter"; the attribute names the chip's value.
const VALUE_ATTRS = ["data-status", "data-kind", "data-value", "data-val"];
const PANELS = ["comp-filters-panel", "p-filters-panel", "task-filters-panel"];
const OPEN_KEY = (id) => `ha:filters-open:${id}`;
// The phone breakpoint the sheet's CSS uses (styles.css: the Filters pattern).
const SHEET_MQ = "(max-width:768px)";
const _sheets = new Map();   // panel id → { release, scrim } while it is a sheet

function _sheetWidth() {
  try { return !!(window.matchMedia && window.matchMedia(SHEET_MQ).matches); } catch (_) { return false; }
}

/** Give an open panel the dialog contract (once). Call BEFORE moving focus in,
 *  so the shared contract records the Filters button as the opener. */
function _holdSheet(id, panel) {
  if (_sheets.has(id)) return;
  const scrim = document.createElement("div");
  scrim.className = "filters-scrim";
  scrim.setAttribute("aria-hidden", "true");
  // A sibling, so the scrim and the sheet share one stacking context.
  panel.insertAdjacentElement("beforebegin", scrim);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const release = overlayDismiss(panel, () => toggleFiltersPanel(id, false));
  _sheets.set(id, { release, scrim });
}

/** Drop the contract: the panel is closed, or no longer a sheet. A sheet that
 *  stays open as an inline panel (`stillOpen`) keeps focus where it is; a closed
 *  one hands focus back to its Filters button. */
function _releaseSheet(id, panel, stillOpen) {
  const h = _sheets.get(id);
  if (!h) return;
  _sheets.delete(id);
  try { h.release(stillOpen ? { restoreFocus: false } : undefined); } catch (_) { /* the contract was already released */ }
  h.scrim.remove();
  if (panel) { panel.setAttribute("role", "group"); panel.removeAttribute("aria-modal"); }
}

function _readOpen(id) {
  try { return localStorage.getItem(OPEN_KEY(id)) === "1"; } catch (_) { return false; }
}
function _writeOpen(id, open) {
  try { if (open) localStorage.setItem(OPEN_KEY(id), "1"); else localStorage.removeItem(OPEN_KEY(id)); }
  catch (_) { return; /* no storage: the panel simply starts closed */ }
}

function _valueOf(chip) {
  for (const a of VALUE_ATTRS) if (chip.hasAttribute(a)) return { attr: a, value: chip.getAttribute(a) };
  return null;
}

function _activeChips(panel) {
  return [...panel.querySelectorAll(".filters .filter-btn.active")].filter(c => {
    const v = _valueOf(c);
    return v && v.value !== "all" && !c.hidden;
  });
}

/** Repaint one panel's button label and removable chips from its live chips. */
export function syncFiltersPanel(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const btn = document.querySelector(`.filters-btn[data-panel="${id}"]`);
  const box = document.getElementById(`${id}-active`);
  const active = _activeChips(panel);
  if (btn) {
    const label = active.length ? `Filters · ${active.length}` : "Filters";
    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle("has-filters", active.length > 0);
    btn.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  }
  if (box) {
    const html = active.map(c => {
      const v = _valueOf(c);
      const group = c.closest(".filters");
      const label = c.textContent.replace(/\s+/g, " ").trim();
      return `<button type="button" class="filter-chip" data-action="filters-chip-remove" data-group="${esc(group ? group.id : "")}" data-attr="${esc(v.attr)}" data-value="${esc(v.value)}" aria-label="${esc(label)} — remove this filter">${esc(label)} <span aria-hidden="true">×</span></button>`;
    }).join("");
    if (box._html !== html) { box._html = html; setSafeHtml(box, html); }
  }
}

/** Open or close a panel; remembered per browser. */
export function toggleFiltersPanel(id, force) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const open = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !open;
  _writeOpen(id, open);
  syncFiltersPanel(id);
  if (open && _sheetWidth()) _holdSheet(id, panel);
  if (!open) _releaseSheet(id, panel);
  if (open) panel.querySelector(".filter-btn")?.focus({ preventScroll: true });
  else document.querySelector(`.filters-btn[data-panel="${id}"]`)?.focus({ preventScroll: true });
}

// Crossing the breakpoint with a panel open: an inline panel becoming a sheet
// is closed (a sheet opens by a press, and this panel may sit in a pane nobody
// is looking at), without forgetting the remembered state; focus inside it goes
// to its Filters button rather than falling to the page. A sheet becoming an
// inline panel stays open and drops the contract, with focus left where it is.
function _onSheetWidthChange(e) {
  for (const id of PANELS) {
    const panel = document.getElementById(id);
    if (!panel || panel.hidden) continue;
    if (e.matches) {
      const hadFocus = panel.contains(document.activeElement);
      panel.hidden = true;
      syncFiltersPanel(id);
      if (hadFocus) document.querySelector(`.filters-btn[data-panel="${id}"]`)?.focus({ preventScroll: true });
    }
    else _releaseSheet(id, panel, true);
  }
}

/** A removable chip: press the chip it names, through its own handler. The
 *  removable chips are then drawn again without it, so keyboard focus moves to
 *  the chip now in its place, else the one before it, else the Filters button:
 *  never to the page. */
export function removeFilterChip(el) {
  const group = document.getElementById(el.dataset.group || "");
  if (!group) return;
  const chip = [...group.querySelectorAll(".filter-btn")].find(c => c.getAttribute(el.dataset.attr) === el.dataset.value);
  if (!chip || !chip.classList.contains("active")) return;
  const box = el.closest(".filters-active");
  const id = box && box.id.endsWith("-active") ? box.id.slice(0, -"-active".length) : "";
  const at = box ? [...box.querySelectorAll(".filter-chip")].indexOf(el) : -1;
  chip.click();
  if (!id) return;
  syncFiltersPanel(id);
  const left = [...box.querySelectorAll(".filter-chip")];
  const next = left[Math.min(Math.max(at, 0), left.length - 1)] || document.querySelector(`.filters-btn[data-panel="${id}"]`);
  next?.focus({ preventScroll: true });
}

/** Clear all: each group back to "no filter" (its All chip, else every chip off). */
export function clearFiltersPanel(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  for (const group of panel.querySelectorAll(".filters")) {
    const all = [...group.querySelectorAll(".filter-btn")].find(c => (_valueOf(c) || {}).value === "all");
    if (all) { if (!all.classList.contains("active")) all.click(); }
    else for (const c of [...group.querySelectorAll(".filter-btn.active")]) c.click();
  }
  syncFiltersPanel(id);
}

/** Once, from boot(): restore open state and watch every panel's chips. */
export function initFiltersPanels() {
  registerHelpTips({
    "lists.filters": "Filters narrows this list. The active filters show beside the button; press one to remove it, or Clear all in the panel.",
    "templates.list": "Templates your organisers saved. A template keeps an event's type, settings and questions, never people or dates. Start an event from one in a minute, or change it from its ⋮ menu.",
  });
  const phone = _sheetWidth();
  for (const id of PANELS) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    panel.hidden = phone || !_readOpen(id);
    const mo = new MutationObserver(() => syncFiltersPanel(id));
    mo.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"] });
    syncFiltersPanel(id);
  }
  try { window.matchMedia(SHEET_MQ).addEventListener("change", _onSheetWidthChange); }
  catch (_) { return; /* no matchMedia: the panel is never a sheet */ }
}
