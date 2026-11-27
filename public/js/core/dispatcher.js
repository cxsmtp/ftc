"use strict";

// Delegated event-dispatch registry (v7.0.0 ESM split). Feature modules register
// their data-action handlers (via core/main.js boot wiring); the delegated
// click/change/input/keydown listeners that resolve from these registries are
// installed in core/main.js boot() (they reference closeKebab, a feature fn).
// This module is a side-effect-free registry + the sortable-a11y tagger.

export const _actionHandlers = Object.create(null);
export const _changeHandlers = Object.create(null);
export const _inputHandlers  = Object.create(null);
export function registerAction(name, fn) { _actionHandlers[name] = fn; }
export function registerChange(name, fn) { _changeHandlers[name] = fn; }
export function registerInput(name, fn)  { _inputHandlers[name]  = fn; }

// Tag .sortable / tag-remove / tag-add affordances as focusable role=button so
// the keydown delegator (in boot) can turn Enter/Space into a synthetic click.
export function _enableSortableA11y(root) {
  if (!root || !root.querySelectorAll) return;
  for (const el of root.querySelectorAll('.sortable, .tag-x[data-action], .tag-add[data-action]')) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    // audit v7.7.30 (M23) — do NOT override a <th>'s native `columnheader` role
    // with role=button: columnheader supports aria-sort (which the analytics
    // headers set) while button does not (aria-allowed-attr, critical). The th
    // stays keyboard-activatable via the '.sortable' branch of the keydown
    // delegator, so Enter/Space still sorts. Non-th sortables keep role=button.
    if (!el.hasAttribute('role') && el.tagName !== 'TH') el.setAttribute('role', 'button');
  }
  // audit v7.7.30 (M24) — initialise aria-pressed on multi-select toggle
  // controls from their visual active class, so assistive tech reads which
  // filters are on. Runs at boot (over document) + on every added subtree via
  // the MutationObserver; in-place class toggles are re-synced by the click
  // dispatcher (_syncTogglePressed). Excludes single-select nav (handled via
  // aria-current elsewhere).
  for (const el of root.querySelectorAll('.filter-btn, .seg, .chip')) {
    const on = el.classList.contains('active') || el.classList.contains('seg-active') || el.classList.contains('chip-active');
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// Mirror a toggle control's visual active state to aria-pressed for its whole
// sibling group, AFTER a click handler has flipped the classes in place. Called
// from the click dispatcher (core/main.js boot). (audit v7.7.30 M24)
export function _syncTogglePressed(el) {
  const grp = el && el.parentElement;
  if (!grp || !grp.querySelectorAll) return;
  for (const b of grp.querySelectorAll('.filter-btn, .seg, .chip')) {
    const on = b.classList.contains('active') || b.classList.contains('seg-active') || b.classList.contains('chip-active');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
