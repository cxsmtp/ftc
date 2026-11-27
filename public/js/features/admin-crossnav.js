"use strict";

// v7.22.0 — cross-pane navigation: "show me THIS thing in the pane that owns it".
//
// Two surfaces need it (the Rankings boards and the Submissions stream) and both
// want the same three steps: switch pane, put a term in that pane's search box,
// make the pane re-render for it.
//
// DEPENDENCY NOTE — this module deliberately imports NO feature module. The
// obvious implementation calls `renderParticipants()` / `renderAdminTasks()` /
// `renderAdminGroups()` directly, and that is a cycle: `participants-admin.js`
// already imports `rankings-admin.js`, so `rankings-admin → participants-admin`
// closes the loop. Instead the search box is filled and a synthetic `input`
// event is dispatched, which the delegated listener in core/main.js resolves
// through the SAME `registerInput` handler a real keystroke uses.
//
// That is not merely a way around the cycle — it is the more correct one. The
// participants handler has a branch a direct call would have had to duplicate:
// when the last picker fetch was TRUNCATED (v6.8.6) a client-side filter cannot
// see the non-matching rows, so it must re-fetch with the term and let the
// server do the LIKE scan. A second copy of that rule is exactly the duplication
// this codebase keeps writing up.

import { S } from "../core/state.js";
import { adminPageOffered } from "../ui/nav.js";   // RBAC — read inside functions only (nav imports feature modules)
import { showToast } from "../ui/toast.js";
import { toggleSearchClear } from "../ui/format.js";
import { _syncTogglePressed } from "../core/dispatcher.js";
import { clearColumnFilters } from "../ui/table-columns.js";

// Reset a `.filter-btn` chip group to "all". The DOM contract is
// toggleMultiFilter's (challenges-admin.js): the backing Set is EMPTY and only
// the "all" chip carries `.active`.
//
// The two groups spell the chip's value with DIFFERENT attributes — the
// Challenges chips use `data-val`, the Participants chips `data-value` — so
// reading only one of them leaves every chip in that group unhighlighted while
// the Set is (correctly) empty: no filtering applied, but the control saying
// otherwise. Read both.
function _resetChipGroup(containerId, ...sets) {
  for (const s of sets) if (s && typeof s.clear === "function") s.clear();
  const btns = document.querySelectorAll(`${containerId} .filter-btn`);
  btns.forEach(b => b.classList.toggle("active", (b.dataset.val ?? b.dataset.value) === "all"));
  if (btns[0]) _syncTogglePressed(btns[0]);
}

// RBAC — WHICH PAGE EACH KIND OF NAME OPENS, and whether the role may open it.
// A name is a link only into a page the role may open (ui/nav.js
// adminPageOffered, the command palette's own answer): the renderers (Rankings,
// Activity, Analytics) ask `crossNavOffered` and draw a plain name otherwise,
// because a link into a page the role may not read shows that page with nothing
// in it, and its empty-state sentence ("No participants match…") is false.
const _PANE = { participant: "admin-participants-tab", challenge: "admin-tasks-tab", group: "admin-groups-tab" };
export function crossNavOffered(kind) {
  return !!_PANE[kind] && adminPageOffered(_PANE[kind]);
}
// The same answer at the press: a link drawn before the role's permissions were
// known (or before they changed) opens nothing, and says why.
function _offeredAtPress(kind) {
  if (crossNavOffered(kind)) return true;
  showToast("Your role cannot open that page.", "info");
  return false;
}

/**
 * Switch to `tabId`'s pane and narrow its list to `value`.
 *
 * Inside an event workspace the pane is the workspace's own SECTION (its tab in
 * `#ws-tabs`, which keeps the event open): a link in the event's Rankings or
 * Activity shows that person or challenge in the same event. Elsewhere it is the
 * sidebar item, found by `data-tab-id` — the documented stable hook. Either is
 * CLICKED rather than driven directly, so the switch routes through `adminTab()`
 * and gets the highlight, the `aria-current`, the canonical pane list, the
 * pane's loader and the mobile drawer close in one place. Hand-rolling the pane
 * swap is the v7.7.37 (C20) defect: the nav then says one thing while the
 * screen shows another.
 *
 * Returns false when the target pane is not in the DOM, so a caller can say so
 * rather than appearing to do nothing.
 */
function _go(tabId, searchId, value, resetChips, widen) {
  const tabBtn = (S.adminSelectedCompetitionId && document.querySelector(`#ws-tabs [data-section="${tabId}"]`))
    || document.querySelector(`[data-action="admin-tab"][data-tab-id="${tabId}"]`);
  if (!tabBtn) return false;
  // Who the list holds is decided by the load the click starts: widen it first.
  if (widen) widen();
  tabBtn.click();                       // routes through adminTab() — nav state + pane list + loader
  // Chips are cleared AFTER the pane is shown but BEFORE the search fires, so
  // the render the search triggers already sees the reset.
  if (resetChips) resetChips();
  const el = document.getElementById(searchId);
  if (!el) return false;
  el.value = value;
  toggleSearchClear(el);
  // Bubbles to the document-level delegator installed in core/main.js boot().
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  return true;
}

/**
 * Show one participant in the Participants pane.
 *
 * Everything that can HIDE the very row we are navigating to is reset: the
 * status chips, the heading filters (ui/table-columns.js), and the population
 * itself — inside a workspace the list narrows to the event's members (an
 * admin's own test answers come from someone who is not one), and the
 * cross-event People list leaves admin accounts out (a competing admin is on
 * the board; admin accounts live on Roles & permissions). An admin filtering on
 * "pending" who clicks an approved participant would otherwise land on an empty
 * table with nothing saying why.
 * A navigation that promises to show someone has to actually show them.
 */
export function adminShowParticipant(nickname) {
  const v = String(nickname || "").trim();
  if (!_offeredAtPress("participant")) return false;
  if (!v) return false;
  return _go("admin-participants-tab", "participants-search", v,
    () => {
      _resetChipGroup("#p-status-filters", S.pStatusFilter);
      clearColumnFilters("participants");
    },
    () => {
      if (S.adminSelectedCompetitionId) S.pWsShowEveryone = true;
      // Outside a workspace People leaves admin accounts out (they live on Roles
      // & permissions): this one entry lists them too, for an event admin as
      // well (their list then holds the admin accounts enrolled in their events
      // — a competing admin on their board), and the list says so above the
      // table until People is next entered.
      else widenPeopleToAdmins();
    });
}

/** The next entry to People lists admin accounts too (and says so). The one
 *  way to show one there: a link to a person who holds an admin role. */
export function widenPeopleToAdmins() {
  S._pWidenOnce = true;
}

/** Show one challenge in the Challenges pane. Three chip groups and the
 *  heading filters, same reason. */
export function adminShowChallenge(title) {
  const v = String(title || "").trim();
  if (!_offeredAtPress("challenge")) return false;
  if (!v) return false;
  return _go("admin-tasks-tab", "task-search", v,
    () => {
      _resetChipGroup("#task-diff-filters", S.tDiffFilters);
      _resetChipGroup("#task-status-filters", S.tStatusFilters);
      _resetChipGroup("#task-state-filters", S.tStateFilters);
      clearColumnFilters("challenges");
    });
}

/** Show one group in the Groups pane. That pane has no chip filters; its
 *  heading filters are cleared. */
export function adminShowGroup(name) {
  const v = String(name || "").trim();
  if (!_offeredAtPress("group")) return false;
  if (!v) return false;
  return _go("admin-groups-tab", "groups-search", v, () => clearColumnFilters("groups"));
}
