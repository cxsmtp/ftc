"use strict";
// THE COMMAND PALETTE — the signed-in header's Search button and Ctrl/⌘+K.
//
// One box that reaches every place the signed-in person may go, every action
// they may take, their events and the headings of their help guide, by typing a
// few letters. Four sections, in this order:
//   • Go to   — pages and workspace sections. Organisers: the sidebar items the
//               nav builder left showing (buildAdminNav hides each item whose
//               permission the role lacks, so the palette offers exactly what
//               the sidebar offers), plus the open event's
//               workspace tabs. Participants: Events, and Challenges /
//               Leaderboard while their tab is active (updateParticipantNav's
//               predicate, read off the tab), the certificate card when the
//               page shows one, Profile, Appearance.
//   • Actions — only what the role can do, each the predicate of the control it
//               stands for (the "+ New Event" button's, the workspace ⋯ menu's
//               own wsMenuItemsHtml), dispatched through the SAME delegated
//               data-action the control carries. Irreversible doors (End now,
//               Delete, Close late entries) are left to the ⋯ menu, behind
//               their confirms; the palette never offers them.
//   • Events  — jump to an event by name: the admin events model for an
//               organiser, the participant's own events otherwise, listed from
//               data the page already loaded. A participant's jump leaves for
//               the event list as Events does, then picks the event through the
//               card's own door (pickCompetition) once the leave is answered.
//   • Help    — the headings of the role's guide(s), read through the help
//               drawer's own pipeline (help-drawer.js helpDocHeadings) so a
//               result's anchor is the id the drawer renders; selecting one
//               opens the drawer at that heading.
//
// Every item is rebuilt from the live predicates each time the palette opens
// or the query changes, so a role change between opens cannot leave a stale
// door (recent items are stored by id and re-resolved against that list).
//
// Markup: the input is a SIBLING of the result list it re-renders (the
// CLAUDE.md sibling rule), a combobox with aria-activedescendant over a
// listbox. Overlay: overlayDismiss (Escape, focus trap, focus return) on the
// 3000 rung of the z-index ladder; a full-screen sheet on a phone.

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { overlayDismiss } from "../ui/modal.js";
import { viewSwitchOffered, builtinAccountOffered, adminCan, adminPageOffered, deskApprovalWithheld } from "../ui/nav.js";
import { releaseNotesVisible } from "./release-notes.js";
import { helpDocHeadings, helpDocsForRole, openHelpDrawer } from "./help-drawer.js";
import { computeCompStatus, compDisplayCategory, COMP_CATEGORY_LABEL, handleCompetitionsNav, pickCompetition } from "./competition-picker.js";
import { wsMenuItemsHtml, wsInviteOffered } from "./event-workspace.js";

const OVERLAY_ID = "command-palette-overlay";
const RECENT_KEY = "ha:cp-recent";
const RECENT_MAX = 6;
const SECTION_ORDER = ["Recent", "Go to", "Actions", "Events", "Help"];
const SECTION_CAP = { "Recent": RECENT_MAX, "Go to": 12, "Actions": 10, "Events": 8, "Help": 10 };
const GUIDE_TITLE = {
  "participant.md": "Participant guide",
  "admin.md": "Admin guide",
  "event-admin.md": "Event admin guide",
  "superadmin.md": "Superadmin guide",
};

let _items = [];          // the current, gated item list (rebuilt per render)
let _shown = [];          // the items on screen, in order
let _active = 0;          // index into _shown
let _opener = null;       // the control that opened the palette
let _helpCache = new Map(); // guide path -> [{id,text,level}] | null
let _helpSeq = 0;

// ── Predicates: who is looking ─────────────────────────────────────────────
function _adminView() { return !!S.isAdmin; }
function _globalAdmin() { return _adminView() && !S.isEventAdmin; }
function _userBacked() { return !!(S.currentUser && S.currentUser.id); }

// ── Running an item ────────────────────────────────────────────────────────
/** Press the control that owns `action`, through the delegated dispatcher. A
 *  detached element does not bubble to document, so it is attached (hidden)
 *  for the one synchronous click and removed again. */
function _dispatch(action, data) {
  const b = document.createElement("button");
  b.type = "button";
  b.hidden = true;
  b.setAttribute("data-action", action);
  for (const [k, v] of Object.entries(data || {})) if (v != null) b.dataset[k] = String(v);
  document.body.appendChild(b);
  try { b.click(); } finally { b.remove(); }
}
function _press(sel) {
  const el = document.querySelector(sel);
  if (el) el.click();
  return !!el;
}
/** Is this page one the role may open? The one answer every door that opens a
 *  page asks (ui/nav.js adminPageOffered: its sidebar item as the nav builder
 *  left it, or inside an event workspace its section tab). */
function _tabOffered(tabId) { return adminPageOffered(tabId); }
/** Open a page: inside an event workspace its own tab, else the sidebar item —
 *  never one the role may not open. */
function _goAdminTab(tabId) {
  if (!_tabOffered(tabId)) return false;
  if (S.adminSelectedCompetitionId && _press(`#ws-tabs [data-section="${tabId}"]:not([style*="display: none"])`)) return true;
  return _press(`.admin-nav-item[data-tab-id="${tabId}"]`);
}
/** Export people as the People table lists them. The file follows the screen
 *  (operator ruling, 14 Nov 2026: the search box, the status chips and the
 *  heading filters), and those live on the People page and survive leaving it,
 *  so this door opens that page first (inside an event workspace its
 *  Participants section) and exports once the page's own read has drawn the
 *  table: the filters that narrow the file are on screen when it is saved. A
 *  failed read leaves the page's load failure and saves nothing; a move to
 *  another page meanwhile cancels the export. */
function _exportPeopleOnTheirPage() {
  let done = false;
  const stop = () => { done = true; document.removeEventListener("admin:model-loaded", onLoaded); clearTimeout(timer); };
  const onLoaded = (e) => {
    if (done || !e || e.detail !== "participants") return;
    stop();
    // After the loader's own render, which follows its event in the same task.
    setTimeout(() => {
      const pane = document.getElementById("admin-participants-tab");
      if (pane && pane.style.display !== "none" && pane.getClientRects().length) _dispatch("export-participants-csv");
    }, 0);
  };
  const timer = setTimeout(stop, 30000);
  document.addEventListener("admin:model-loaded", onLoaded);
  if (!_goAdminTab("admin-participants-tab")) stop();
}
/** Wait (bounded) for an element a just-started render will produce. */
function _whenPresent(sel, fn, budgetMs) {
  const end = Date.now() + (budgetMs || 3000);
  const tick = () => {
    const el = document.querySelector(sel);
    if (el) { fn(el); return; }
    if (Date.now() < end) setTimeout(tick, 100);
  };
  tick();
}

// ── The item list ──────────────────────────────────────────────────────────
function _goToItems() {
  const out = [];
  const go = (id, label, run, hint) => out.push({ id, section: "Go to", label, hint: hint || "", run });
  if (_adminView()) {
    // The sidebar as the nav builder left it: an item whose <li> is hidden is
    // not this role's page.
    document.querySelectorAll("#admin-sidebar .admin-nav-item[data-tab-id]").forEach((btn) => {
      const li = btn.closest("li");
      if (btn.hidden || (li && (li.hidden || li.style.display === "none"))) return;
      const tabId = btn.dataset.tabId;
      const label = (btn.querySelector(".admin-nav-label")?.textContent || btn.textContent || "").trim();
      if (!label) return;
      go(`go:${tabId}`, label, () => btn.click(), "Page");
    });
    // The open event's workspace sections.
    if (S.adminSelectedCompetitionId) {
      const evName = S.adminSelectedCompetitionName || "this event";
      document.querySelectorAll("#ws-tabs [data-section]").forEach((b) => {
        if (b.hidden || b.style.display === "none") return;
        const label = (b.textContent || "").trim();
        if (!label) return;
        go(`ws:${b.dataset.section}`, `${label}`, () => b.click(), `In ${evName}`);
      });
    }
  } else {
    go("go:events", "Events", () => _press("#nav-competitions"), "Page");
    for (const [id, label] of [["nav-challenges", "Challenges"], ["nav-leaderboard", "Leaderboard"]]) {
      const b = document.getElementById(id);
      if (b && b.getAttribute("aria-disabled") !== "true") go(`go:${id}`, label, () => b.click(), "Page");
    }
    const cta = document.getElementById("cert-cta");
    if (cta && !cta.hidden && cta.textContent.trim()) {
      go("go:certificate", "Your certificate", () => {
        _press("#nav-challenges");
        _whenPresent("#cert-cta:not([hidden])", (el) => el.scrollIntoView({ block: "center" }));
      }, "On the Challenges page");
    }
  }
  if (_userBacked()) go("go:profile", "Profile", () => _dispatch("open-profile-editor"), "Your account");
  if (builtinAccountOffered()) go("go:account", "Account", () => _dispatch("open-builtin-account"), "Break-glass account");
  go("go:appearance", "Appearance", () => _dispatch("open-appearance"), "Look and mode");
  return out;
}

function _actionItems() {
  const out = [];
  const act = (id, label, run, hint) => out.push({ id, section: "Actions", label, hint: hint || "", run });
  if (_adminView()) {
    // The open event's own doors: the workspace ⋯ menu's predicates, minus the
    // irreversible ones (km-danger), which stay behind their confirms.
    const c = S.adminSelectedCompetitionId ? (S.adminCompetitionsData || []).find((x) => x.id === S.adminSelectedCompetitionId) : null;
    if (c) {
      // The header's own Invite predicate (the role's `participants.enrol`
      // included): an event that takes no new members (ended, its late window
      // shut) is not offered, as the dialog lists none.
      if (wsInviteOffered(c)) act("ws:invite", "Invite people", () => _dispatch("ws-invite"), `To ${c.name}`);
      const doc = document.implementation.createHTMLDocument("");
      const box = doc.createElement("div");
      setSafeHtml(box, wsMenuItemsHtml(c));
      box.querySelectorAll("button[data-action]").forEach((b) => {
        if (b.classList.contains("km-danger")) return;
        const label = (b.textContent || "").trim();
        const data = { ...b.dataset };
        const action = data.action; delete data.action;
        act(`ws:${action}`, label, () => _dispatch(action, data), `In ${c.name}`);
      });
    }
    // Platform doors, each the predicate of its control.
    // RBAC — each door also asks the role's permission for the route it ends at
    // (ui/nav.js adminCan; the built-in tiers answer exactly as before), and a
    // door that opens a page first offers only a page the role may open.
    if (_globalAdmin() && adminCan("events.create") && _tabOffered("admin-competitions-tab")) act("act:new-event", "New event", () => { _goAdminTab("admin-competitions-tab"); _dispatch("open-competition-form"); }, "Create");
    if (adminCan("challenges.edit") && _tabOffered("admin-tasks-tab")) act("act:new-challenge", "New question", () => { _goAdminTab("admin-tasks-tab"); _dispatch("open-task-form"); }, "Create");
    if (!c && adminCan("participants.enrol") && _tabOffered("admin-participants-tab")) {
      act("act:invite", "Invite people", () => { _goAdminTab("admin-participants-tab"); _dispatch("open-invite-dialog"); }, "People");
      // Withheld while it would be refused (sweep #501); the People button says why.
      if (!deskApprovalWithheld()) act("act:desk", "Sign up at the desk", () => { _goAdminTab("admin-participants-tab"); _dispatch("desk-invite"); }, "People");
    }
    if (_globalAdmin()) {
      if (adminCan("templates.manage") && _tabOffered("admin-templates-tab")) act("act:new-template", "New template", () => { _goAdminTab("admin-templates-tab"); _whenPresent("#tpl-new-btn:not([hidden])", () => _dispatch("tpl-new")); }, "Create");
      if (adminCan("export.data")) {
        // The people export writes the People table's rows, which only a role
        // that may read people has (`participants.view`), from the People page
        // it opens first (_exportPeopleOnTheirPage).
        if (adminCan("participants.view") && _tabOffered("admin-participants-tab")) act("act:export-people", "Export people (CSV)", _exportPeopleOnTheirPage, "Export");
        act("act:export-challenges", "Export challenges", () => _dispatch("export-tasks"), "Export");
      }
    }
  }
  if (viewSwitchOffered()) {
    act("act:view", _adminView() ? "Switch to Participant View" : "Switch to Admin View",
      () => _dispatch("toggle-admin-view", { on: _adminView() ? "false" : "true" }), "View");
  }
  act("act:help", "Open help", () => openHelpDrawer(), "Guide for your role");
  if (releaseNotesVisible()) act("act:whats-new", "What's new", () => _dispatch("release-notes-open"), "Release notes");
  act("act:sign-out", "Sign out", () => _dispatch("do-logout"), "Account");
  return out;
}

function _eventItems() {
  const out = [];
  if (_adminView()) {
    for (const c of (S.adminCompetitionsData || [])) {
      if (!c || !c.id) continue;
      // The one status table, by the bucket a human is shown (an ended event
      // still taking late entries reads "Late entry open", as on the Events list).
      const st = COMP_CATEGORY_LABEL[compDisplayCategory(c)] || "";
      out.push({ id: `ev:${c.id}`, section: "Events", label: c.name || "Untitled event", hint: st,
        run: () => _dispatch("comp-open", { compId: c.id, compName: c.name || "" }) });
    }
  } else {
    for (const c of (S.myCompetitions || [])) {
      if (!c || !c.id) continue;
      out.push({ id: `ev:${c.id}`, section: "Events", label: c.name || "Untitled event", hint: c.id === S.currentCompetitionId ? "You are here" : "Your event",
        run: async () => {
          if (c.id === S.currentCompetitionId && _press("#nav-challenges:not([aria-disabled=true])")) return;
          // Leave for the event list exactly as the Events item does (its
          // deselect, the generation bump), then pick through the card's own
          // door. No card is needed, so an event the list's filter hides (an
          // ended one) opens too, and no card left over from an earlier visit
          // can fire before the leave is done.
          await handleCompetitionsNav();
          // The participant moved on while the leave waited: theirs is the
          // later ask.
          const movedOn = () => !!S.currentCompetitionId || !document.getElementById("competitions-page")?.classList.contains("active");
          if (movedOn()) return;
          // The deselect is answered before the select is sent, so the server
          // cannot apply them in the wrong order and forget the new event.
          const pick = S._compSelectSeq;
          await S._leaveInFlight;
          // Asked again after that wait: a card picked meanwhile (its select
          // sent, or its confirm still open) is the later ask, and the jump
          // must not supersede it.
          if (movedOn() || S._compSelectSeq !== pick || _dialogOpen()) return;
          await pickCompetition(c.id, computeCompStatus(c));
        } });
    }
  }
  return out;
}

function _helpItems() {
  const out = [];
  for (const path of helpDocsForRole()) {
    const heads = _helpCache.get(path);
    if (!heads) continue;
    const guide = GUIDE_TITLE[path.split("/").pop()] || "Help";
    for (const h of heads) {
      out.push({ id: `help:${path}#${h.id}`, section: "Help", label: h.text, hint: guide,
        run: () => openHelpDrawer(path, { frag: h.id }) });
    }
  }
  return out;
}

/** Every item this person may use right now, rebuilt from the live predicates. */
export function paletteItems() {
  return [..._goToItems(), ..._actionItems(), ..._eventItems(), ..._helpItems()];
}

// ── Matching ───────────────────────────────────────────────────────────────
/** 0 = no match. Word-start beats substring beats an in-order subsequence. */
export function paletteScore(text, query) {
  const t = String(text || "").toLowerCase();
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 600 - t.length;
  const i = t.indexOf(q);
  if (i > 0 && /[\s\-—·(/]/.test(t[i - 1])) return 700 - t.length;
  if (i > 0) return 500 - t.length;
  // In-order subsequence ("nwev" finds "New event"), rewarded for tight runs.
  let ti = 0, gaps = 0, last = -1;
  for (const ch of q.replace(/\s+/g, "")) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    if (last >= 0) gaps += at - last - 1;
    last = at; ti = at + 1;
  }
  return Math.max(1, 200 - gaps * 4 - t.length);
}

function _recentIds() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (_) { return []; }
}
function _remember(id) {
  try {
    const ids = [id, ..._recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch (_) { /* no storage: no recents */ }
}

function _results(query) {
  const q = String(query || "").trim();
  const groups = new Map(SECTION_ORDER.map((s) => [s, []]));
  if (!q) {
    // Empty: recent items first (re-resolved, so only doors still offered),
    // then Go to and Actions. Events and Help wait for a query.
    const byId = new Map(_items.map((it) => [it.id, it]));
    for (const id of _recentIds()) { const it = byId.get(id); if (it) groups.get("Recent").push({ ...it, section: "Recent" }); }
    const recent = new Set(groups.get("Recent").map((it) => it.id));
    for (const it of _items) if ((it.section === "Go to" || it.section === "Actions") && !recent.has(it.id)) groups.get(it.section).push(it);
  } else {
    const scored = _items.map((it) => ({ it, s: Math.max(paletteScore(it.label, q), Math.floor(paletteScore(it.hint, q) / 3)) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    for (const { it } of scored) groups.get(it.section).push(it);
  }
  for (const [s, list] of groups) groups.set(s, list.slice(0, SECTION_CAP[s]));
  return groups;
}

// ── Rendering ──────────────────────────────────────────────────────────────
const _SECTION_ICON = { "Recent": ICO.clock, "Go to": ICO.chevronRight, "Actions": ICO.zap, "Events": ICO.calendar, "Help": ICO.helpCircle };

function _render() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const input = overlay.querySelector("#cp-input");
  const list = overlay.querySelector("#cp-list");
  _items = paletteItems();
  const groups = _results(input.value);
  _shown = [];
  let html = "";
  let gi = 0;
  for (const [section, items] of groups) {
    if (!items.length) continue;
    const hid = `cp-g-${gi++}`;
    html += `<div class="cp-group" role="group" aria-labelledby="${hid}"><p class="cp-group-h" id="${hid}" role="presentation">${esc(section)}</p>`;
    for (const it of items) {
      const idx = _shown.length;
      _shown.push(it);
      html += `<div class="cp-opt" role="option" id="cp-opt-${idx}" data-cp-index="${idx}" aria-selected="false"><span class="cp-ico" aria-hidden="true">${_SECTION_ICON[section] || ""}</span><span class="cp-label">${esc(it.label)}</span>${it.hint ? ` <span class="cp-hint">${esc(it.hint)}</span>` : ""}</div>`;
    }
    html += `</div>`;
  }
  const q = input.value.trim();
  if (!_shown.length) {
    html = `<p class="cp-empty" role="presentation">Nothing matches “${esc(q)}”. Try fewer letters, or open Help for the whole guide.</p>`;
  }
  setSafeHtml(list, html);
  const status = overlay.querySelector("#cp-status");
  if (status) status.textContent = _shown.length ? `${_shown.length} result${_shown.length === 1 ? "" : "s"}` : "No results";
  _setActive(Math.min(_active, Math.max(0, _shown.length - 1)));
}

function _setActive(i) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const input = overlay.querySelector("#cp-input");
  overlay.querySelectorAll(".cp-opt[aria-selected=true]").forEach((o) => o.setAttribute("aria-selected", "false"));
  if (!_shown.length) { _active = 0; input.removeAttribute("aria-activedescendant"); return; }
  _active = (i + _shown.length) % _shown.length;
  const el = overlay.querySelector(`#cp-opt-${_active}`);
  if (el) {
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    el.scrollIntoView({ block: "nearest" });
  }
}

/** Load the role's guide headings once per palette open, then re-render. */
function _loadHelp() {
  const seq = ++_helpSeq;
  for (const path of helpDocsForRole()) {
    if (_helpCache.has(path)) continue;
    helpDocHeadings(path).then((heads) => {
      _helpCache.set(path, heads);
      if (seq === _helpSeq && document.getElementById(OVERLAY_ID)) _render();
    });
  }
}

function _run(it) {
  if (!it) return;
  _remember(it.id);
  closeCommandPalette();
  // Focus goes back to the opener NOW, before the item opens its own dialog,
  // so that dialog captures a live opener (overlayDismiss) for its own return.
  try { _opener && _opener.isConnected ? _opener.focus() : document.getElementById("app-search-btn")?.focus(); } catch (_) { /* no-op */ }
  const p = it.run();
  if (p && typeof p.catch === "function") p.catch((e) => console.warn("The search result could not be opened", e));
}

/** Another dialog is up: one on the Escape stack, or a modal dialog that is
 *  deliberately not on it (the profile-completion gate, which cannot be
 *  dismissed). The palette never opens underneath either. */
function _dialogOpen() {
  if (window._modalEscStack && window._modalEscStack.length) return true;
  return [...document.querySelectorAll('[aria-modal="true"]')].some((d) => !d.closest(`#${OVERLAY_ID}`) && d.getClientRects().length > 0);
}

// ── Open / close ───────────────────────────────────────────────────────────
export function openCommandPalette() {
  if (document.getElementById(OVERLAY_ID)) return;
  // Signed in only: the palette's every section is per role.
  if (!document.querySelector("#app-header.is-app")) return;
  _opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.getElementById("app-search-btn");
  // The guides are re-read on each open, so a role change (view switch,
  // impersonation) never searches the previous role's guide.
  _helpCache = new Map();
  _active = 0;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "cp-overlay";
  document.body.appendChild(overlay);
  overlayDismiss(overlay, () => closeCommandPalette());
  const ph = _adminView() ? "Search pages, actions, events and help" : "Search pages, your events and help";
  setSafeHtml(overlay, `<div class="cp-panel" role="dialog" aria-modal="true" aria-labelledby="cp-title">
    <h2 id="cp-title" class="sr-only">Search</h2>
    <div class="cp-search">
      <span class="cp-search-ico" aria-hidden="true">${ICO.search}</span>
      <label for="cp-input" class="sr-only">${esc(ph)}</label>
      <input id="cp-input" type="text" role="combobox" aria-expanded="true" aria-controls="cp-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(ph)}…">
      <button type="button" class="cp-close" data-cp-close aria-label="Close search">${ICO.x}</button>
    </div>
    <div id="cp-list" class="cp-list" role="listbox" aria-label="Results"></div>
    <div class="cp-foot"><span class="cp-keys" aria-hidden="true"><span class="cp-key" data-glyph="↑↓"></span> move <span class="cp-key" data-glyph="Enter"></span> open <span class="cp-key" data-glyph="Esc"></span> close</span><span id="cp-status" class="sr-only" role="status" aria-live="polite"></span><span data-help="palette.search" data-help-label="Search"></span></div>
  </div>`);
  const input = overlay.querySelector("#cp-input");
  input.addEventListener("input", () => { _active = 0; _render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); _setActive(_active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _setActive(_active - 1); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); _setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); _setActive(_shown.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); _run(_shown[_active]); }
  });
  overlay.addEventListener("click", (e) => {
    // A search, not a form: the scrim closes it, a named exception to the
    // dialogs' "a backdrop click never closes" (ui/modal.js overlayDismiss;
    // operator ruling, 14 Nov 2026), as the account menu's is.
    if (e.target === overlay) { closeCommandPalette(); return; }
    if (e.target.closest("[data-cp-close]")) { closeCommandPalette(); return; }
    const opt = e.target.closest(".cp-opt");
    if (opt) _run(_shown[Number(opt.dataset.cpIndex)]);
  });
  overlay.addEventListener("mousemove", (e) => {
    const opt = e.target.closest && e.target.closest(".cp-opt");
    if (opt && Number(opt.dataset.cpIndex) !== _active) _setActive(Number(opt.dataset.cpIndex));
  });
  document.getElementById("app-search-btn")?.setAttribute("aria-expanded", "true");
  _render();
  _loadHelp();
  input.focus();
}

export function closeCommandPalette() {
  document.getElementById(OVERLAY_ID)?.remove();
  _helpSeq++;
  document.getElementById("app-search-btn")?.setAttribute("aria-expanded", "false");
}

/** Ctrl+K / ⌘+K anywhere signed in: open (or close) the palette. Not from a
 *  rich-text editor, and not over another dialog (the palette sits on the
 *  ordinary-dialog rung, under a confirm). Run once from boot(). */
export function installCommandPaletteKeys() {
  document.addEventListener("keydown", (e) => {
    if (!(e.key === "k" || e.key === "K") || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (document.getElementById(OVERLAY_ID)) { e.preventDefault(); closeCommandPalette(); return; }
    if (!document.querySelector("#app-header.is-app")) return;
    const ae = document.activeElement;
    if (ae && ae.isContentEditable) return;
    if (_dialogOpen()) return;
    e.preventDefault();
    openCommandPalette();
  });
}
