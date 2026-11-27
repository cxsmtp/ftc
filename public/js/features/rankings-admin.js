"use strict";

import { S } from "../core/state.js";
import { html, setSafeHtml } from "../core/trusted-types.js";
import { computeCompStatus } from "./competition-picker.js";
import { setAdminCompetitionScope } from "./competitions-admin.js";
import { avatarHtml, esc, fmtSolveTime, solvedCell, _syncSortAria, DRY_RUN_TAG, policyOrDefault, eventKindPhraseClient, earnsPlacement } from "../ui/format.js";
import { setListCount, renderLoadFailure } from "../ui/list-controls.js";
import { copyText } from "../ui/clipboard.js";
import { showToast } from "../ui/toast.js";
import { downloadCsv } from "../ui/csv.js";
import { ICO } from "../ui/icons.js";
import { renderCertificatePreview, blobToDataUri, fetchIssuedCertificates, downloadIssuedCertificate, cutCodePoints } from "./certificate-wizard.js";
import { applyColumnFilters, hasColumnFilters, dropColumnFilters } from "../ui/table-columns.js";
import { downloadBlob, fileNameSlug } from "../ui/download.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)
import { crossNavOffered } from "./admin-crossnav.js"; // RBAC — a name links only into a page the role may open

// v7.15.0 — sortable header + all-solved column for every admin rankings table.
// There are FOUR of these theads (all-live cards, per-slot cards, the focused
// single-comp table, the group table) plus a static fallback in index.html; they
// are emitted from one helper so a column can never be added to one and missed
// on the others (the empty-state rows' colspan is derived from the same count).
//
// v7.22.0 — there are now TWO column sets, and that is deliberate. The
// individual board carries the admin-only identity columns (first name / last
// name / company / email); the GROUP board ranks group aggregates, which have
// no such fields, so giving it the same header would paint four permanently
// empty cells per row and let an admin sort a board by a column it does not
// have. Both sets still go through this one emitter and both colspans are
// DERIVED from their array, so a column added to either cannot drift out of
// step with its own empty-state rows.
const _RK_COLS = [
  { col: 'place',   label: '#' },
  { col: 'player',  label: 'Player' },
  { col: 'first',   label: 'First Name' },
  { col: 'last',    label: 'Last Name' },
  { col: 'company', label: 'Company' },
  { col: 'email',   label: 'Email' },
  { col: 'score',   label: 'Score' },
  { col: 'time',    label: 'Time to Solve' },
  { col: 'solved',  label: 'All Solved', cls: ' lb-solved-col' },
];
const _RK_GROUP_COLS = [
  { col: 'place',  label: '#' },
  { col: 'player', label: 'Player' },
  { col: 'score',  label: 'Score' },
  { col: 'time',   label: 'Time to Solve' },
  { col: 'solved', label: 'All Solved', cls: ' lb-solved-col' },
];
export const RANKINGS_GROUP_COLSPAN = _RK_GROUP_COLS.length;

// v8.11.0 — THE PRESENTER'S VIEW: the same board with the employer and the
// contact address left out.
//
// An organiser projecting the standings, sharing their screen on a call or
// handing a laptop round the room is showing a table that carries two columns
// nobody in that room needs: the participant's COMPANY and their EMAIL. This is
// a display control over exactly those two.
//
// WHY NOT THE NAMES TOO, which is the obvious next question. The request was
// company and email, and the requested scope is the deliverable: a board with no
// names is not standings any more, and `Player` (the nickname) is on it either
// way. Widening this later is one entry in the list below.
//
// IT IS A DISPLAY CONTROL AND NOT A PERMISSION, which the toggle's own note
// says. The server sends both columns regardless — the board is one cached
// payload and re-fetching it on a checkbox would be a round trip per click — so
// this hides them from the SCREEN, not from the browser. Anyone who can open
// this tab can already read them by turning the toggle off. Saying so in place
// is what stops it being read as a redaction it is not.
const RK_ANON_HIDDEN = ['company', 'email'];
/** Is the presenter's view on? Per TAB, deliberately — see setRankingsHideIdentity. */
function _rkAnon(){ return !!S._rkHideIdentity; }
/** The individual board's columns AS CURRENTLY SHOWN. */
function _rkCols(){ return _rkAnon() ? _RK_COLS.filter(c => !RK_ANON_HIDDEN.includes(c.col)) : _RK_COLS; }
/**
 * The individual board's colspan, DERIVED from the same list the header is.
 *
 * It replaced a `const` because the count is no longer fixed, and every
 * empty-state / divider / "show all" row reads it — a stale literal there is a
 * ragged table, which is the one defect this file's own header warns about.
 */
export function rankingsColspan(){ return _rkCols().length; }
/**
 * `key` namespaces the icon ids so sibling tables on one screen sort independently.
 * `cols` selects the column set — omit for the individual board, which follows
 * the presenter's view.
 *
 * `data-rk-cols` records how many columns this header was emitted with, so the
 * focused-board loader can tell a stale header from a current one. The static
 * fallback in index.html carries it too; without that, entering the tab with the
 * toggle already on paints nine header cells over seven-cell rows.
 */
export function rankingsThead(key, labels, cols){
  // ext-audit v7.20.9 (F9c) — `tabindex="0"` is emitted INLINE, not left to the
  // MutationObserver in `_enableSortableA11y`.
  //
  // That tagger adds tabindex to every `.sortable` in an added subtree, but a
  // MutationObserver callback runs on a LATER microtask, whereas the paint pass
  // that restores keyboard focus (`_rkPaintSortIcons`) runs synchronously right
  // after `setSafeHtml`. So at the moment `th.focus()` was called the header was
  // not yet focusable and the call was a silent no-op: the v7.15.2 focus
  // restoration has never actually worked on these four tables. Emitting the
  // attribute with the markup removes the ordering dependency entirely.
  // `role="columnheader"` + `aria-sort` are the sortable-header contract
  // (and the observer deliberately does NOT set role=button on a <th>, because
  // columnheader is what supports aria-sort).
  const set = cols || _rkCols();
  return `<thead><tr data-rk-cols="${set.length}">${set.map(c => {
    const label = (labels && labels[c.col]) || c.label;
    return `<th scope="col" class="sortable${esc(c.cls || '')}" tabindex="0" role="columnheader" aria-sort="none" data-action="sort-rankings" data-key="${esc(key)}" data-col="${esc(c.col)}">${esc(label)}<span id="rksort-${esc(key)}-${esc(c.col)}-icon"></span></th>`;
  }).join('')}</tr></thead>`;
}

// Per-table sort state, keyed by the same `key` used for the icon ids. Admin
// boards are uncapped, so unlike the participant view there is no fairness
// constraint here — this is a plain view control over the full list.
function _rkState(key){
  S.rkSort = S.rkSort || {};
  return S.rkSort[key] || (S.rkSort[key] = { col: null, asc: true });
}
const _rkText = (v) => String(v ?? '').trim();
const _rkTextCmp = (key) => (a, b) =>
  _rkText(a[key]).localeCompare(_rkText(b[key]), undefined, { sensitivity: 'base' });
// v7.22.0 — which entry field each identity column reads, for the blanks-last
// rule in _rkApplySort. An empty value is "unknown", not "before A".
const _RK_BLANK_FIELD = { first: 'firstName', last: 'lastName', company: 'company', email: 'email' };
// v8.11.0 — which entry field each identity column RENDERS, and whether it earns
// a copy button. Mirrors _RK_BLANK_FIELD above (same four columns, same fields);
// they are separate because one answers "what does the blanks-last rule read"
// and this one answers "what does the cell draw", and folding them would make
// the copy flag look like a sorting concern.
const _RK_ID_FIELD = {
  first:   { field: 'firstName', label: 'first name', copy: true },
  last:    { field: 'lastName',  label: 'last name',  copy: true },
  company: { field: 'company',   label: 'company',    copy: false },
  email:   { field: 'email',     label: 'email',      copy: true },
};
const _RK_SORTERS = {
  place:   (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  player:  (a, b) => String(a.nickname || a.name || '').localeCompare(String(b.nickname || b.name || ''), undefined, { sensitivity: 'base' }),
  first:   _rkTextCmp('firstName'),
  last:    _rkTextCmp('lastName'),
  company: _rkTextCmp('company'),
  email:   _rkTextCmp('email'),
  score:   (a, b) => (a.score ?? 0) - (b.score ?? 0),
  time:    (a, b) => (a.solveTimeMs ?? Number.MAX_SAFE_INTEGER) - (b.solveTimeMs ?? Number.MAX_SAFE_INTEGER),
  solved:  (a, b) => (a.allSolved ? 1 : 0) - (b.allSolved ? 1 : 0),
};
export function _rkApplySort(rows, key){
  const st = _rkState(key);
  const cmp = _RK_SORTERS[st.col];
  if (!cmp) return rows;
  const blankField = _RK_BLANK_FIELD[st.col];
  return rows.slice().sort((a, b) => {
    // v7.22.0 — blanks last in BOTH directions. This has to sit OUTSIDE the
    // direction flip below, because a comparator cannot express it: whatever it
    // returns is negated on the descending pass, so a blanks-last comparator is
    // a blanks-FIRST one the moment the admin clicks the header twice. Floating
    // a screenful of empty cells to the top is not what someone who clicked
    // "Company" asked for, in either direction.
    if (blankField) {
      const ea = !_rkText(a[blankField]), eb = !_rkText(b[blankField]);
      if (ea !== eb) return ea ? 1 : -1;
    }
    const p = cmp(a, b);
    if (p !== 0) return st.asc ? p : -p;
    return (a.rank ?? 0) - (b.rank ?? 0);
  });
}
// v7.15.2 (audit) — sorting these tables re-renders the whole card, destroying
// the <th> the user is standing on and dropping focus to <body>: a keyboard user
// loses their place on every activation and has to Tab back in from the top.
// sortRankings records the header it was invoked from; the paint pass (which
// runs right after the rebuild) puts focus back. Only set on an explicit sort,
// never on the 15s poll, so a background refresh can't steal focus.
let _rkFocusAfterRender = null;
export function _rkPaintSortIcons(key){
  const st = _rkState(key);
  document.querySelectorAll(`[id^="rksort-${key}-"][id$="-icon"]`).forEach(el => { el.textContent = ''; });
  if (st.col) {
    const ic = document.getElementById(`rksort-${key}-${st.col}-icon`);
    if (ic) { ic.textContent = st.asc ? ' ▲' : ' ▼'; _syncSortAria(ic, st.asc); }
  }
  if (_rkFocusAfterRender && _rkFocusAfterRender.key === key) {
    const th = document.getElementById(`rksort-${key}-${_rkFocusAfterRender.col}-icon`)?.closest('th');
    _rkFocusAfterRender = null;
    if (th) th.focus();
  }
}
/** Header click — re-renders the current rankings view with the new order. */
export function sortRankings(key, col){
  if (!_RK_SORTERS[col]) return;
  const st = _rkState(key);
  if (st.col === col) st.asc = !st.asc;
  else { st.col = col; st.asc = true; }
  _rkFocusAfterRender = { key, col };
  _rkRerenderFromCache();
}
/**
 * The heading menu's sort (ui/table-columns.js `sortTo`): the order is SET, never
 * toggled. The all-live, per-session and group boards rebuild their heading on
 * every sort, so a toggle clicked twice reached the second click on a detached
 * heading (Sort descending gave ascending, later presses did nothing). Focus is
 * left where it is: in the menu that asked, whose Escape and Tab still work.
 */
export function setRankingsSort(key, col, asc){
  if (!key || !_RK_SORTERS[col]) return;
  const st = _rkState(key);
  st.col = col; st.asc = !!asc;
  _rkRerenderFromCache();
}

/**
 * Re-render every board on screen from `S._rkCache` instead of the network.
 *
 * A sort, an expand and a search keystroke are all the same thing — a pure
 * display change over data already in hand — and the all-live view would
 * otherwise re-issue one request per competition per timeslot for each of them
 * (the v7.17.0 lesson). `_rkSortOnly` is what makes the loaders serve from the
 * cache; a genuine refresh (the Refresh buttons, a scope change, entering the
 * tab) does not set it and so misses by construction.
 */
export function _rkRerenderFromCache(){
  _rkSortOnly = true;
  try { loadAdminRankingsTab(); } finally { _rkSortOnly = false; }
}

// v7.17.0 — cache plumbing. `_rkSortOnly` is set ONLY around a sort re-render,
// so a stale cache can never be served to a real refresh: every other caller
// misses by construction rather than by remembering to invalidate.
let _rkSortOnly = false;
function _rkCacheHit(kind, key){
  return _rkSortOnly && S._rkCache && S._rkCache.kind === kind && S._rkCache.key === key;
}
// No explicit invalidator, deliberately: every non-sort caller misses because
// it does not set `_rkSortOnly`, and the cache key is the request URL, so a
// scope or timeslot change misses too. Nothing has to remember to invalidate.
//
// One behaviour change worth stating: sorting no longer implicitly refetches,
// so a submission landing between load and sort is not picked up until the
// next poll-free Refresh. That is the better behaviour — re-ranking the board
// under someone who only asked to sort a column is surprising — and both
// views render a Refresh button.

// v8.11.0 — turn the presenter's view on or off.
//
// PER TAB, NOT PERSISTED, and that is a decision rather than an omission. A
// stored preference means an admin opens Rankings next week to a table with two
// columns missing and no memory of having asked — which reads as a broken
// feature and gets reported as one (v7.14.2). This is a mode for the minutes you
// are sharing a screen, the control is in view the whole time it is on, and
// turning it back is one click.
//
// A BOARD MUST NOT BE LEFT ORDERED BY A COLUMN NOBODY CAN SEE. Sort state is
// per board and survives a re-render, so hiding the column an admin had sorted
// by would leave the rows in an order with no visible explanation and no header
// to click to undo it — the icon span it paints into is gone too. Those boards
// fall back to the default order; boards sorted by anything still on screen are
// untouched.
export function setRankingsHideIdentity(on){
  S._rkHideIdentity = !!on;
  if (S._rkHideIdentity && S.rkSort) {
    for (const st of Object.values(S.rkSort)) {
      if (st && RK_ANON_HIDDEN.includes(st.col)) { st.col = null; st.asc = true; }
    }
  }
  // Nor narrowed by one: a heading filter on a column that left the screen would
  // hide rows for a reason nobody can see.
  if (S._rkHideIdentity) dropColumnFilters('rankings', RK_ANON_HIDDEN);
  _rkSyncSearchLabel();
  _rkRerenderFromCache();
}
/** The box says what it searches, so it has to stop naming two fields it no longer does. */
function _rkSyncSearchLabel(){
  const el = document.getElementById('rankings-search');
  if (el) el.setAttribute('aria-label', _rkAnon()
    ? 'Search rankings by nickname or name'
    : 'Search rankings by nickname, name, company or email');
}

/**
 * Is the header currently on screen the one this mode wants?
 *
 * The focused-board loader only rebuilds its card when `#admin-rankings-body` is
 * ABSENT — and index.html supplies that body, so on a first entry into Rankings
 * the header an admin sees is the STATIC one (v7.28.0 records the same fact for
 * the Export button). With the toggle already on, that is nine header cells over
 * seven-cell rows: a visibly ragged table. Comparing the count the header
 * recorded against the count this mode wants is what makes the rebuild fire.
 */
function _rkHeadStale(container){
  const body = container?.querySelector('#admin-rankings-body');
  if (!body) return false;
  const tr = body.closest('table')?.querySelector('thead tr');
  return !tr || tr.dataset.rkCols !== String(rankingsColspan());
}

// THE SINGLE-BOARD CARD (title, Refresh, Export, the standings table), restored
// whenever another view replaced it (an unranked event's Progress card, the
// per-session boards, the all-live grid a cleared scope shows) or its header
// belongs to the other presenter-view mode. Every writer of
// #admin-rankings-body asks this first: a write into a body another view has
// removed throws, and the throw aborts the workspace open that called the
// loader (setAdminCompetitionScope), leaving the next event's header over no
// section.
function _rkEnsureBoardCard(container){
  if(!container)return;
  if(container.querySelector('#admin-rankings-body')&&!_rkHeadStale(container))return;
  setSafeHtml(container, `<div class="card rankings-table-card">
      <div class="rankings-section-header">
        <h3 id="admin-rankings-title">Rankings</h3>
        <div class="rankings-header-actions">
          <button class="btn sm secondary" data-action="leaderboard-refresh">Refresh</button>
          ${_rkExportBtn('main','')}
        </div>
      </div>
      <table data-tcols="rankings">
        ${rankingsThead('main')}
        <tbody id="admin-rankings-body"></tbody>
      </table>
    </div>
    <div id="admin-rankings-group-section" style="display:none"></div>`);
}

// v7.22.0 — the search only makes sense when a board is on screen. The picker
// branch ("no live competitions") has nothing to search, and leaving the box up
// over it offers a control that can only ever return nothing.
function _rkShowSearch(on){
  const w=document.getElementById('rankings-search-wrap');
  if(w)w.style.display=on?'':'none';
}

// v7.23.5 (audit Wave 5) — one place that guarantees an ARRAY.
//
// All three board fetches used `.then(r=>r.json()).catch(()=>[])`. The catch only
// fires when the PARSE fails, so a 500's `{error:"Boom"}` was returned as-is and
// then iterated: MEASURED "board.filter is not a function", with the rankings
// header rendered over no rows and no message. This loader had FOUR fetch sites
// and no failure branch at all — it was not on the audit's list.
async function _rkBoard(url){
  try{ const r=await fetch(url); if(!r.ok) return null; const b=await r.json(); return Array.isArray(b)?b:null; }
  catch(_){ return null; }
}

export function loadAdminRankingsTab(){
  // RBAC — a role that may not read rankings (`leaderboard.view`) sends no read:
  // every scope change calls this, and a refused read counts towards the
  // address's scanner block.
  if(!adminCan('leaderboard.view'))return;
  const picker=document.getElementById('admin-rankings-picker');
  const content=document.getElementById('admin-rankings-content');
  // v7.28.0 — reset here as well as in each loader, because TWO branches below
  // return without reaching one: the 'upcoming' branch and (in
  // loadAdminLeaderboard) the no-competition branch. Both leave a board's
  // chrome — including the export button — on screen. Without this, Export
  // there would still describe the competition the admin was looking at BEFORE
  // they switched scope.
  _rkResetExports();
  _rkShowSearch(true);
  { const _c=document.getElementById('admin-rankings-certs'); if(_c&&(!S.adminSelectedCompetitionId||_c.dataset.compId!==S.adminSelectedCompetitionId)){_c.hidden=true;setSafeHtml(_c,'');delete _c.dataset.compId;} }
  if(S.adminSelectedCompetitionId){
    // Scoped to a competition
    picker.style.display='none';
    content.style.display='';
    S.adminRankingsCompId=S.adminSelectedCompetitionId;
    const comp=S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId);
    if(comp){
      const st=computeCompStatus(comp);
      if(st==='upcoming'){
        _rkEnsureBoardCard(content);
        document.getElementById('admin-rankings-title').textContent=comp.name+' - Not Started Yet';
        setSafeHtml(document.getElementById('admin-rankings-body'), `<tr><td colspan="${rankingsColspan()}" class="rankings-empty-row">Event has not started yet.</td></tr>`);
        _rkShowSearch(false);
        return;
      }
      document.getElementById('admin-rankings-title').textContent=comp.name+(st==='live'?' - Live Rankings':' - Final Rankings');
      // Per-slot multi-session: show all sessions side by side
      const timeslots=comp.timeslots||[];
      if(timeslots.length>1&&(comp.leaderboard_mode||'per_slot')==='per_slot'&&!S.adminSelectedTimeslotId){
        loadAdminLeaderboardPerSlot(comp,timeslots);
        return;
      }
    }
    loadAdminLeaderboard();
  }else{
    // No competition selected — show all live competitions' rankings side by side
    const liveComps=S.adminCompetitionsData.filter(c=>computeCompStatus(c)==='live');
    if(liveComps.length===0){
      picker.style.display='block';
      content.style.display='none';
      _rkShowSearch(false);
      setSafeHtml(document.getElementById('admin-rankings-comp-grid'), '<p class="rankings-empty">No live events. View historical rankings from the Events tab by clicking an event.</p>');
    }else{
      picker.style.display='none';
      content.style.display='';
      loadAdminLeaderboardAllLive(liveComps);
    }
  }
}

export function selectAdminRankingsComp(compId,name){
  // A board card on Live rankings opens that event's workspace, on its Rankings
  // section (the workspace tab keeps the event; adminTab loads the board).
  setAdminCompetitionScope(compId,name);
  document.querySelector('#ws-tabs [data-section="admin-rankings-tab"]')?.click();
}

// v7.20.8 — how many ranking rows a board shows before asking.
//
// A board is bounded by participants-per-competition, so this is not the
// unbounded-list problem the admin TABLES had — but a 300-person event still
// renders 300 rows per board, and the Rankings tab can show several boards at
// once (one per competition, or one per session). Capping is a "show me the
// standings" default; the expander is there because reading the full order IS
// sometimes the job, and paging a RANKING would be worse than expanding it —
// you would lose the continuity that makes it readable.
export const RANKINGS_PAGE = 50;
const _rkExpanded = new Set();   // board keys the admin has expanded

export function _rkToggleExpanded(key){
  if(_rkExpanded.has(key))_rkExpanded.delete(key); else _rkExpanded.add(key);
  _rkRerenderFromCache();   // expanding is a display change, exactly like a sort
}
export function _rkIsExpanded(key){ return _rkExpanded.has(key); }

// v7.22.0 — one identity cell. `copy` adds the copy affordance (first name,
// last name and email get it; company deliberately does not — you copy a person's
// details to write to them, not a company label).
//
// The button carries the value in `data-copy` rather than reading the cell's
// text back out of the DOM: the cell is truncated with CSS, but more to the
// point a value read back from rendered markup is a different thing from the
// value the server sent, and copying "Ana Sofía…" with an ellipsis in it is a
// silent wrong answer.
function _rkIdentityCell(value, label, nickname, copy){
  const v=_rkText(value);
  if(!v)return '<td class="rk-id-cell"><span class="rk-id-blank" aria-label="not set">—</span></td>';
  const btn=copy
    ? `<button type="button" class="rk-copy" data-action="rankings-copy" data-copy="${esc(v)}"
        aria-label="Copy ${esc(label)} of ${esc(nickname)}" title="Copy ${esc(label)}">${ICO.copy}</button>`
    : '';
  return `<td class="rk-id-cell"><span class="rk-id-text" title="${esc(v)}">${esc(v)}</span>${btn}</td>`;
}

// v7.22.0 — the player cell becomes the way into that person's record. It is a
// BUTTON, not a clickable <td>: the row must stay a row for a screen reader
// (the v7.7.33 AL11 lesson — role=button on a container demands presentational
// children and silently drops the table semantics), and a button is keyboard-
// operable and focusable for free.
function _rkPlayerCell(u){
  return `<div class="rankings-player-cell">${avatarHtml(u.avatar,28)}
    ${_rkPersonLink(u.nickname)}</div>`;
}
// The ONE player link of every board (main, late entrants, benchmark, the group
// board's individuals) and the group link. RBAC — a link only into a page the
// role may open (admin-crossnav.js `crossNavOffered`); otherwise the plain name.
function _rkPersonLink(nickname){
  const nick=String(nickname||'');
  if(!crossNavOffered('participant'))return `<span class="rk-player-name">${esc(nick)}</span>`;
  return `<button type="button" class="rk-player-link" data-action="rankings-open-participant" data-nickname="${esc(nick)}"
      title="Show ${esc(nick)} in Participants" aria-label="${esc(nick)} — show in the Participants tab">${esc(nick)}</button>`;
}
function _rkGroupLink(name){
  const g=String(name||'');
  if(!crossNavOffered('group'))return `<span class="rk-player-name"><strong>${esc(g)}</strong></span>`;
  return `<button type="button" class="rk-player-link" data-action="rankings-open-group" data-group-name="${esc(g)}"
           title="Show ${esc(g)} in Groups" aria-label="${esc(g)} — show in the Groups page"><strong>${esc(g)}</strong></button>`;
}

// v7.22.0 — the rankings search. It is deliberately a plain substring match over
// the SAME fields the board renders, so what the admin can read they can type:
// nickname, first name, last name, company and email. Anything not on screen
// (user id, tags) is not searchable, because a control that matches on invisible
// data reads as a bug when it "finds" a row for no visible reason.
export function _rkSearchTerm(){
  return (document.getElementById('rankings-search')?.value||'').toLowerCase().trim();
}
// The count is summed across EVERY board on screen, because that is the scope
// the search itself has. `total` is the unfiltered size of the same set, so the
// reading is "N of M participants match" and never invents a denominator.
function _rkSetSearchCount(matched,total,q){
  setListCount('rankings-search',{matched,total,filtered:!!q||hasColumnFilters('rankings'),queried:!!q});
}
// What a board shows for the search box AND the heading filters: the count's
// numerator, from the one filter path the renderer and the export use.
function _rkShownCount(board,q){ return applyColumnFilters('rankings',board.filter(u=>_rkMatches(u,q))).length; }
// The empty row's words: what narrowed the board to nothing (null: nothing did).
function _rkNoMatch(q,key,noun){
  const cf=hasColumnFilters(key);
  if(q)return `No ${noun} match ${esc(q)}${cf?' and the column filters':''}.`;
  return cf?`No ${noun} match the column filters.`:null;
}
export function _rkMatches(e,q){
  if(!q)return true;
  // v8.11.0 — and it follows the presenter's view, which is the whole reason
  // that toggle cannot be CSS. With the employer and the address off screen, a
  // search that still matched them would return rows for a reason the admin
  // cannot see — the defect this function's own comment above exists to prevent,
  // one toggle later. The count beside the box narrows with it for free.
  const fields=[e.nickname,e.name,e.firstName,e.lastName];
  if(!_rkAnon())fields.push(e.company,e.email);
  return fields.some(v=>String(v||'').toLowerCase().includes(q));
}

// v7.28.0 — ONE definition of "the rows this board is currently showing", used
// by the renderer AND by the CSV export. The `_anRowsInView` precedent: two
// copies of "filter then sort" is how a download comes to disagree with the
// screen it was taken from.
//
// It returns the FULL filtered set, not the 50-row page. Search and sort are
// narrowings the admin performed and the file honours them; the 50-row cap is a
// rendering bound (v7.20.8) and the file does not, exactly as the analytics
// export ignores its own pagination.
export function _rkRowsInView(board,sortKey){
  const q=_rkSearchTerm();
  // The heading filters (ui/table-columns.js) narrow the WHOLE board, before the
  // 50-row cap, exactly as the search does: so the file follows them too.
  const keep=rows=>applyColumnFilters('rankings',rows);
  // v8.6.0 — three sections. Late entrants are sorted like the regular rows (the
  // admin may re-sort either), and pinned into their own block below the divider
  // the way benchmark rows are: their `rank` is a rank WITHIN the late section, so
  // interleaving them would put two "#1" rows in one table.
  const all=_rkApplySort(keep(board.filter(u=>!u.isBenchmark&&!u.isLateEntrant&&_rkMatches(u,q))),sortKey);
  const late=_rkApplySort(keep(board.filter(u=>!u.isBenchmark&&u.isLateEntrant&&_rkMatches(u,q))),sortKey);
  const benchmarks=keep(board.filter(u=>u.isBenchmark&&_rkMatches(u,q)));
  return {all,late,benchmarks,q};
}

// v7.28.0 — EXPORT REGISTRY: what each board on screen would write to a file.
//
// The export reads what the RENDERER actually computed rather than re-deriving
// it from `S._rkCache`, and that is the whole safety argument. The cache is a
// SINGLE slot shared by every view, and two render branches paint a board's
// chrome while leaving the previous competition's rows in it — the "upcoming"
// branch and the no-competition branch both write a message into the tbody and
// return without touching the cache. An exporter reading the cache there would
// hand the admin the PREVIOUS competition's participants, names and emails
// included, under a heading naming this one. Registering at render time makes
// that unreachable: a board that was not rendered has no entry, and the button
// answers "the rankings have not loaded" instead of answering wrongly.
//
// Cleared at the top of every loader, so an entry can only ever describe the
// paint that is currently on screen.
const _RK_EXPORTS = new Map();
function _rkResetExports(){ _RK_EXPORTS.clear(); }
function _rkRegisterExport(key,entry){ _RK_EXPORTS.set(key,entry); }
// Every row of the boards of one kind on screen, before any narrowing (each
// entry keeps the board it was built from): the values a heading menu lists.
function _rkBoardsShown(kind){
  const out=[];
  for(const e of _RK_EXPORTS.values())if(e.kind===kind&&Array.isArray(e.source))out.push(...e.source);
  return out;
}

// ── The boards as admin tables (ui/table-columns.js; defined from boot()) ────
//
// A heading filter narrows the WHOLE board, before the 50-row cap (a match at
// rank 120 is found without Show all), and the board's export is written from
// the same filtered rows, so the file matches the screen. The filters are shared
// by every board of a kind on screen, as the one bar above them is. A heading's
// menu sorts through the board's own sort, set outright (`sortTo`).
const _rkSolvedText=e=>e.allSolved?'Yes':'No';
const _rkSortTo=(col,asc,th)=>setRankingsSort(th&&th.dataset?th.dataset.key:null,col,asc);
export const RANKINGS_TABLE_COLUMNS={
  noun:'row',
  // First and last name are under Columns (Player names the row); with them the
  // default set does not fit a 1024 px window.
  hidden:['first','last'],
  cols:{player:{grow:true},solved:{filter:'enum',options:['Yes','No']}},
  sortTo:_rkSortTo,
  model:{
    rows:()=>_rkBoardsShown('individual'),
    get:(u,k)=>{switch(k){
      case 'place':return u.rank??'';
      case 'player':return u.nickname||'';
      case 'first':return u.firstName||'';
      case 'last':return u.lastName||'';
      case 'company':return u.company||'';
      case 'email':return u.email||'';
      case 'score':return u.score??'';
      case 'time':return fmtSolveTime(u.solveTimeMs);
      case 'solved':return _rkSolvedText(u);
      default:return '';
    }},
    onChange:()=>_rkRerenderFromCache(),
  },
};
export const RANKINGS_GROUP_TABLE_COLUMNS={
  noun:'row',
  cols:{player:{grow:true},solved:{filter:'enum',options:['Yes','No']}},
  sortTo:_rkSortTo,
  model:{
    rows:()=>_rkBoardsShown('group'),
    get:(e,k)=>{switch(k){
      case 'place':return e.rank??'';
      case 'player':return e.type==='group'?(e.name||''):(e.nickname||'');
      case 'score':return e.type==='group'&&Number.isFinite(e.score)?e.score.toFixed(1):(e.score??'');
      case 'time':return fmtSolveTime(e.solveTimeMs);
      case 'solved':return _rkSolvedText(e);
      default:return '';
    }},
    onChange:()=>_rkRerenderFromCache(),
  },
};

// The button lives in each board's own heading, because "per leaderboard" is
// the unit an admin thinks in — the all-live view shows one card per
// competition and each is a separate file.
function _rkExportBtn(key,label){
  // The static header in index.html and the `main` board's dynamic header are
  // both emitted BEFORE any data has loaded, so they pass no label and get the
  // generic accessible name. The FILENAME never comes from here — it comes from
  // the registry entry the renderer wrote, which always knows the competition.
  // The name STARTS with the visible "Export CSV" (WCAG 2.5.3 Label in Name): a
  // speech-input user says what they read, and axe's label-content-name-mismatch
  // refused the old "Export <label> to CSV", which split the visible words.
  const name=label?`Export CSV of ${esc(label)}`:'Export CSV of this leaderboard';
  return `<button type="button" class="btn sm secondary rk-export-btn" data-action="rankings-export-csv"
    data-board-key="${esc(key)}" title="Download this leaderboard as a CSV file"
    aria-label="${name}">Export CSV</button>`;
}

/**
 * The copy affordance's click handler.
 *
 * It reports BOTH ways: the icon becomes a tick under the pointer (where the eye
 * already is) AND a polite toast fires, because the icon swap is invisible to a
 * screen reader — and a copy that silently did nothing is the failure mode this
 * button exists to avoid. A refusal is an error toast naming the cause, not a
 * shrug: on a plain-http deployment `navigator.clipboard` is absent and the user
 * needs to know it was the browser, not the data.
 */
export async function rankingsCopy(btn){
  const value=btn?.dataset?.copy||'';
  if(!value)return;
  const ok=await copyText(value);
  if(!ok){showToast('Could not copy — the browser blocked clipboard access.','error');return;}
  showToast('Copied to clipboard.','success');
  // Restore on a timer keyed to the button, so rapid clicks on different cells
  // do not leave a stray tick behind on one of them.
  clearTimeout(btn._rkCopyTimer);
  setSafeHtml(btn, ICO.check);
  btn.classList.add('is-copied');
  btn._rkCopyTimer=setTimeout(()=>{ setSafeHtml(btn, ICO.copy); btn.classList.remove('is-copied'); }, 1400);
}

// v7.28.0 — THE RANKINGS BOARD, AS A SPREADSHEET.
//
// WHAT IT EXPORTS: every row the board is currently showing — the whole set the
// search box and the heading filters narrowed to, in the column order the admin
// sorted into, NOT the 50 rows the card happens to render (that cap is a display
// default, v7.20.8).
// Benchmark participants are included and appear last, exactly as on screen,
// with an explicit `Benchmark` column: their rank is legitimately empty, and
// without the column a blank rank in a re-sorted spreadsheet is
// indistinguishable from missing data. Staff are absent, because they are
// absent from the board.
//
// WHY CLIENT-SIDE, with no endpoint: the search term and the sort are
// client-only state, so a server route could not reproduce "what is on screen"
// without being handed both back. It is also why there is no `data_exported`
// audit event — nothing leaves the server that the admin was not already
// holding; the read was `GET /api/admin/leaderboard`. This matches the two
// sibling client-side downloads (participants, analytics); the four
// server-rendered exports audit because the SERVER is doing the reading.
//
// THE FIVE PENALTY COLUMNS ARE THE POINT. The board shows a net score; these
// say how it was reached, and they reconcile exactly on an individual row:
//   Score + Total Points Lost  ==  points earned from solves.
// On a GROUP row they do not, and that is stated in the headers rather than
// left for a reader to discover — see the note in lib/leaderboard.js.
// v8.11.0 — THE PRESENTER'S VIEW DOES NOT CHANGE THIS FILE, and that is the
// deliberate half. v8.1.7 settled the rule one column over: the header is the
// contract with the human reading the file, and a header whose SHAPE varies by
// circumstance breaks any downstream reader indexing by column and makes two
// exports of two events incomparable. The toggle narrows what is on SCREEN; the
// rows it exports are still the rows in view (search and sort are honoured, as
// ever, through _rkRowsInView), and every column is still written. The toggle's
// own note says so, because a file that quietly dropped two columns would be the
// worse surprise of the two.
const RANKINGS_CSV_HEADERS = [
  'Rank', 'Nickname', 'First Name', 'Last Name', 'Company', 'Email',
  'Score', 'Time to Solve', 'Time to Solve (ms)', 'All Solved', 'Benchmark', 'Late Entrant',
  'Incorrect Submissions', 'Points Lost to Incorrect',
  'Hints Revealed', 'Points Lost to Hints', 'Total Points Lost',
  // v8.1.0 (PR 35) — the pair, and the pair is the point. "Time to Solve" is
  // ELAPSED: on a multi-day event it reads ~72 h for everybody and ranks nobody.
  // "Time on Platform" is what they actually spent. A row reading 40 h against
  // 35 min is one glance from an organiser's eye; either number alone misleads.
  //
  // The label says PLATFORM, not "active" or "engaged" — it measures five-minute
  // buckets in which a request carried a user-intent header, which is exactly
  // "time on the platform" and is not a claim about attention.
  //
  // v8.1.7 — BOTH COLUMNS ARE UNCONDITIONAL AND THE CELLS GO BLANK when the event
  // did not measure (`presenceMs: null` from the server). Dropping the columns
  // instead was considered and rejected: the header is the contract with the
  // human reading the file (v7.15.8), and a header whose SHAPE varies by event
  // breaks any downstream reader indexing by column and makes two exports of two
  // events incomparable. A blank cell is this file's own idiom for "not known" —
  // the same one a benchmark row's rank uses — and it is the whole point of the
  // fix: a rendered `0s` here used to be indistinguishable from a measured zero.
  'Time on Platform', 'Time on Platform (ms)',
];
// The group board ranks TEAMS, so it has no identity columns (a team has no
// surname — the v7.22.0 reasoning) and its score column is a MEAN. The penalty
// columns are totals over the team's members, and each says so in its own
// heading: a reader must never have to guess which of two numbers on one row is
// an average and which is a sum.
const RANKINGS_GROUP_CSV_HEADERS = [
  'Rank', 'Name', 'Type', 'Members', 'Avg Score', 'Avg Time to Solve',
  'Avg Time to Solve (ms)', 'All Solved',
  'Incorrect Submissions (team total)', 'Points Lost to Incorrect (team total)',
  'Hints Revealed (team total)', 'Points Lost to Hints (team total)',
  'Total Points Lost (team total)',
];

// Slug a board label for the filename. Mirrors the analytics export, including
// its lesson: a competition named entirely in Hebrew, CJK or Cyrillic slugs to
// the empty string, so the fallback must be a word that does not assert
// something false about the contents.
function _rkSlug(label){
  return String(label||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40).replace(/^-+|-+$/g,'') || 'board';
}

export function exportRankingsCsv(key){
  const entry=_RK_EXPORTS.get(key);
  // Two DIFFERENT messages, because they call for different actions: one means
  // refresh, the other means clear the search. (The analytics export's rule.)
  if(!entry){ showToast('Nothing to export yet — the rankings have not loaded.','error'); return; }
  if(!entry.rows.length){ showToast('Nothing to export — no one on this board matches the current search and column filters.','error'); return; }
  const date=new Date().toISOString().slice(0,10);
  if(entry.kind==='group'){
    const rows=entry.rows.map(e=>[
      e.rank,
      e.type==='group'?e.name:e.nickname,
      e.type==='group'?'Group':'Individual',
      // A solo row is one person, not a team of one member with a blank cell.
      e.type==='group'?e.memberCount:1,
      // Rendered exactly as the board renders it — a mean to one decimal for a
      // team, the whole number for a person.
      e.type==='group'?Number(e.score).toFixed(1):e.score,
      fmtSolveTime(e.solveTimeMs),
      e.solveTimeMs,
      e.allSolved?'Yes':'No',
      e.incorrectCount,e.pointsLostIncorrect,e.hintCount,e.pointsLostHints,e.pointsLostTotal,
    ]);
    downloadCsv(`team-rankings-${_rkSlug(entry.label)}-${date}.csv`, RANKINGS_GROUP_CSV_HEADERS, rows);
    return;
  }
  const rows=entry.rows.map(u=>[
    // Passed through RAW. `csvCell` maps null/undefined to an empty cell, which
    // is what a benchmark row's rank must be — never 0, never the literal
    // "null", and never the screen's "#4" (a spreadsheet cannot sort that).
    u.rank,
    u.nickname,u.firstName,u.lastName,u.company,u.email,
    u.score,
    fmtSolveTime(u.solveTimeMs),
    u.solveTimeMs,
    u.allSolved?'Yes':'No',
    u.isBenchmark?'Yes':'',
    // v8.6.0 — WHICH SECTION this row came from, because the file flattens three
    // sections into one sheet and a `Rank` of 1 appears twice in it: once for the
    // winner and once for the first late entrant. Without this column the two are
    // indistinguishable in a spreadsheet, which is the surface an organiser
    // actually reconciles results in. Blank rather than "No", matching `Benchmark`
    // beside it — the affirmative is the exception worth reading.
    u.isLateEntrant?'Yes':'',
    u.incorrectCount,u.pointsLostIncorrect,u.hintCount,u.pointsLostHints,u.pointsLostTotal,
    // v8.1.7 — `presenceMs` is null on an event that does not record time on
    // platform, and BOTH cells must stay empty rather than render `0s` / `0`.
    // The ms column is passed through RAW, because `csvCell` maps null to a blank
    // exactly as it does for a benchmark row's rank. The formatted column needs
    // its own `== null` guard and it is NOT cosmetic: `fmtSolveTime(null)` returns
    // the literal `-`, which is a third rendering of the same fact and reads as a
    // value rather than an absence. The old `|| 0` is what made "unmeasured" and
    // "measured zero" the same bytes; do not restore it as a defensive default.
    u.presenceMs==null?null:fmtSolveTime(u.presenceMs),
    u.presenceMs==null?null:u.presenceMs,
  ]);
  downloadCsv(`rankings-${_rkSlug(entry.label)}-${date}.csv`, RANKINGS_CSV_HEADERS, rows);
}

export function renderLeaderboardTable(board,sortKey,boardKey,label){
  // Sort only the regular entries; benchmark rows stay pinned in their own
  // section below the divider regardless of the chosen column.
  const {all,late,benchmarks,q}=_rkRowsInView(board,sortKey);
  // The 2nd arg is already a per-board namespace (comp id / slot id / 'main'),
  // so it doubles as the identity for the expand state.
  const key=boardKey||sortKey||'default';
  // Benchmarks LAST, matching both the screen (they sit below the divider
  // whatever column is sorted) and the wire order buildAdminLeaderboard emits.
  _rkRegisterExport(key,{kind:'individual',label:label||'',rows:[...all,...late,...benchmarks],source:board});
  const expanded=_rkIsExpanded(key);
  const regular=expanded?all:all.slice(0,RANKINGS_PAGE);
  // v7.15.0 — time and the all-solved mark are now separate columns; the mark
  // uses the shared solvedCell() so admin + participant views cannot drift.
  const timeCell=u=>`<td class="rankings-time-cell">${fmtSolveTime(u.solveTimeMs)}</td>${solvedCell(u.allSolved)}`;
  // v8.11.0 — built from the SAME list the header is, so a cell can never be
  // rendered under a column that is not there. All three row shapes below (the
  // regular rows, the late-entrant block and the benchmark block) call this one
  // builder, which is what keeps them from drifting apart under the toggle.
  const idCells=u=>_rkCols().filter(c=>_RK_ID_FIELD[c.col])
    .map(c=>{const f=_RK_ID_FIELD[c.col];return _rkIdentityCell(u[f.field],f.label,u.nickname,f.copy);})
    .join('');
  let html=regular.map(u=>`
    <tr>
      <td><strong>#${u.rank}</strong></td>
      <td>${_rkPlayerCell(u)}</td>
      ${idCells(u)}
      <td><strong>${u.score}</strong> pts</td>
      ${timeCell(u)}
    </tr>`).join('');
  if(all.length>RANKINGS_PAGE){
    html+=`<tr class="rankings-more-row"><td colspan="${rankingsColspan()}">
      <button type="button" class="btn sm secondary" data-action="rankings-toggle-more" data-board-key="${esc(key)}">
        ${expanded?`Show top ${RANKINGS_PAGE}`:`Show all ${all.length}`}
      </button>
      <span class="settings-help" style="margin-left:8px">${expanded?`Showing all ${all.length}`:`Showing the top ${RANKINGS_PAGE} of ${all.length}`}</span>
    </td></tr>`;
  }
  // v7.22.0 — a board emptied BY THE SEARCH must say so. An empty <tbody> under
  // a populated header is the v7.16.7 wrong answer: indistinguishable from a
  // competition nobody has scored in.
  if(!regular.length&&!late.length&&!benchmarks.length){
    return `<tr><td colspan="${rankingsColspan()}" class="rankings-empty-row compact">${
      _rkNoMatch(q,'rankings','participants')||'No participants yet.'}</td></tr>`;
  }
  // v8.6.0 — the LATE-ENTRANT block, above the benchmark divider so the order on
  // screen matches the order the wire emits and the order the file is written in.
  // Their ranks are their own, which the divider's label says out loud.
  if(late.length){
    html+=`<tr class="rankings-benchmark-divider"><td colspan="${rankingsColspan()}"><strong class="rankings-benchmark-label">Late entrants</strong> <span class="settings-help">joined after the event ended, during its late-entry window — ranked among themselves</span></td></tr>`;
    html+=late.map(u=>`
    <tr class="rankings-row-late">
      <td><strong>#${u.rank}</strong></td>
      <td><div class="rankings-player-cell">${avatarHtml(u.avatar,28)}
        ${_rkPersonLink(u.nickname)}
        <span class="badge draft badge-xs late-entrant-tag">late entrant</span></div></td>
      ${idCells(u)}
      <td><strong>${u.score}</strong> pts</td>
      ${timeCell(u)}
    </tr>`).join('');
  }
  if(benchmarks.length){
    html+=`<tr class="rankings-benchmark-divider"><td colspan="${rankingsColspan()}"><strong class="rankings-benchmark-label">Benchmark Participants</strong></td></tr>`;
    html+=benchmarks.map(u=>`
    <tr class="rankings-row-benchmark">
      <td></td>
      <td><div class="rankings-player-cell">${avatarHtml(u.avatar,28)}
        ${_rkPersonLink(u.nickname)}
        <span class="badge draft badge-xs benchmark-tag">benchmark</span></div></td>
      ${idCells(u)}
      <td><strong>${u.score}</strong> pts</td>
      ${timeCell(u)}
    </tr>`).join('');
  }
  return html;
}

// v7.11.0 — the group-level board rows: GROUP aggregates (avg score + avg
// time-to-solve, member count) mixed with SOLO individuals (people added on their
// own). Group scores render with one decimal (they're averages); individuals as
// their whole-number score.
export function renderGroupBoardTable(board,sortKey,boardKey,label){
  const timeCell=e=>`<td class="rankings-time-cell">${fmtSolveTime(e.solveTimeMs)}</td>${solvedCell(e.allSolved)}`;
  // ext-audit v7.20.9 (F9b) — the group board takes the SAME 50-row cap +
  // expander as the individual boards. v7.20.8 bounded the individual boards and
  // missed this one, and the reasoning that made the cap worth having applies
  // here MORE, not less: this board mixes group aggregates with every SOLO
  // individual (anyone assigned on their own), so on a 300-person competition
  // with two teams it is a ~300-row table rendered directly beneath a board that
  // was just capped at 50 — the two disagreeing on the same screen.
  const q=_rkSearchTerm();
  // A GROUP row matches on its name; an individual on the same fields as the
  // individual board (it carries no identity columns here, so nickname is what
  // there is).
  const all=_rkApplySort(applyColumnFilters('rankings-group',board.filter(e=>!q||(e.type==='group'
    ? String(e.name||'').toLowerCase().includes(q)
    : _rkMatches(e,q)))),sortKey);
  const key=boardKey||sortKey||'group';
  _rkRegisterExport(key,{kind:'group',label:label||'',rows:all,source:board});
  const expanded=_rkIsExpanded(key);
  const visible=expanded?all:all.slice(0,RANKINGS_PAGE);
  let html=visible.map(e=>{
    const isGroup=e.type==='group';
    // v7.22.0 — the same click-through as the individual board, pointed at the
    // pane that owns each kind of row: a group opens Groups filtered by its
    // name, a solo individual opens Participants filtered by their nickname.
    const label=isGroup
      ?`<div class="rankings-player-cell"><span class="group-board-icon">${ICO.users}</span>
         ${_rkGroupLink(e.name)}
         <span class="group-board-meta">${e.memberCount} member${e.memberCount===1?'':'s'}</span></div>`
      :`<div class="rankings-player-cell">${avatarHtml(e.avatar,28)}
         ${_rkPersonLink(e.nickname)}
         <span class="group-board-meta">individual</span></div>`;
    return `<tr class="${isGroup?'group-board-row-group':''}">
      <td><strong>#${e.rank}</strong></td>
      <td>${label}</td>
      <td><strong>${isGroup?e.score.toFixed(1):e.score}</strong> pts</td>
      ${timeCell(e)}
    </tr>`;
  }).join('');
  // A short board renders NO expander — the control must not appear when
  // nothing is hidden (the v7.20.8 rule, locked for the individual boards).
  if(all.length>RANKINGS_PAGE){
    html+=`<tr class="rankings-more-row"><td colspan="${RANKINGS_GROUP_COLSPAN}">
      <button type="button" class="btn sm secondary" data-action="rankings-toggle-more" data-board-key="${esc(key)}">
        ${expanded?`Show top ${RANKINGS_PAGE}`:`Show all ${all.length}`}
      </button>
      <span class="settings-help" style="margin-left:8px">${expanded?`Showing all ${all.length}`:`Showing the top ${RANKINGS_PAGE} of ${all.length}`}</span>
    </td></tr>`;
  }
  // The group board can now be emptied by the search, and an empty <tbody> under
  // a header reads as a broken board rather than as "nothing matched".
  if(!visible.length){
    html=`<tr><td colspan="${RANKINGS_GROUP_COLSPAN}" class="rankings-empty-row compact">${
      _rkNoMatch(q,'rankings-group','groups or players')||'No groups on the board yet.'}</td></tr>`;
  }
  return html;
}

export async function loadAdminLeaderboardAllLive(comps){
  // v7.21.15 — stale-response guard, the same shape v7.15.13 gave the three
  // admin TABLES. Capture BEFORE any await; a newer load bumps the counter and
  // this one must then write neither the DOM nor the cache. See core/state.js.
  const mySeq=++S._rkFetchSeq;
  _rkResetExports();   // v7.28.0 — nothing on screen yet, so nothing exportable
  const container=document.getElementById('admin-rankings-content');
  // Build fetch list: per-slot comps get one fetch per live/upcoming timeslot, others get one global fetch
  const fetches=[];
  for(const c of comps){
    const ts=c.timeslots||[];
    if(ts.length>1&&(c.leaderboard_mode||'per_slot')==='per_slot'){
      for(const t of ts){
        fetches.push({comp:c,ts:t,url:`/api/admin/leaderboard?competitionId=${c.id}&timeslotId=${t.id}`});
      }
    }else{
      fetches.push({comp:c,ts:null,url:`/api/admin/leaderboard?competitionId=${c.id}`});
    }
  }
  // v7.17.0 — the fetched boards are CACHED so a header click can re-render
  // without going back to the network. Sorting is a pure operation over data
  // already in hand, yet this path used to re-issue one request per competition
  // per timeslot on every click.
  let results;
  if (_rkCacheHit("all-live", fetches.map(f => f.url).join("|"))) {
    results = S._rkCache.data;
  } else {
    results = await Promise.all(fetches.map(async f=>{
      const board=await _rkBoard(f.url);
      return{...f,board:board||[],failed:board===null};
    }));
    if(mySeq!==S._rkFetchSeq)return;   // superseded mid-flight
    // v7.23.5 (audit Wave 5) — same rule as the scoped loader below: a FAILED
    // board must not render as an empty one. This is the path the Rankings tab
    // takes with no competition focused, and it is what MEASURED as the full
    // header over "No participants yet." on a 500. If every board failed the
    // server is down and the whole surface says so; a partial failure leaves the
    // cards that DID load and is reported by toast, because silently dropping
    // one competition's standings from a multi-card view is the wrong answer too.
    const _failed=results.filter(x=>x&&x.failed).length;
    if(_failed&&_failed===results.length){
      S._rkCache=null;   // never cache a failure — Refresh must retry
      renderLoadFailure('admin-rankings-content',{noun:'the rankings',retryAction:'retry-load-admin-rankings'});
      showToast('Could not load the rankings.','error');
      return;
    }
    if(_failed)showToast(`Could not load ${_failed} of ${results.length} boards.`,'error');
    S._rkCache = { kind: "all-live", key: fetches.map(f => f.url).join("|"), data: results };
  }
  const statusLabel=o=>{const s=computeCompStatus(o);return s==='live'?'Live':s==='ended'?'Ended':'Upcoming';};
  const statusClass=o=>`is-${computeCompStatus(o)}`;
  // v7.22.0 — with a search term, a card whose board holds no match is HIDDEN
  // rather than rendered empty: on the all-live view the point of searching is
  // to find which competition someone is on, and a screen of empty cards is the
  // answer buried rather than given.
  const _q=_rkSearchTerm();
  let _matched=0,_total=0,_hiddenCards=0;
  let html=`<div class="rankings-section-header">
    <h3 id="admin-rankings-title">Live Rankings</h3>
    <button class="btn sm secondary" data-action="rankings-refresh">Refresh</button>
  </div>
  <div class="rankings-card-grid">`;
  for(const{comp,ts,board}of results){
    _total+=board.length;
    // The count follows the heading filters too; a card is hidden for the SEARCH
    // alone, so a heading filter never takes away the bar that clears it.
    _matched+=_rkShownCount(board,_q);
    if(_q&&!board.some(u=>_rkMatches(u,_q))){_hiddenCards++;continue;}
    const label=ts?`${esc(comp.name)} → ${esc(ts.name)}`:esc(comp.name);
    // The UNESCAPED label, for the download filename — `label` above is markup.
    const rawLabel=ts?`${comp.name} ${ts.name}`:comp.name;
    const statusObj=ts||comp;
    const _rkKey=`live-${comp.id}${ts?'-'+ts.id:''}`;
    const rows=board.length?renderLeaderboardTable(board,_rkKey,_rkKey,rawLabel)
      :`<tr><td colspan="${rankingsColspan()}" class="rankings-empty-row compact">No participants yet.</td></tr>`;
    const _rkInt=(comp.tags||[]).includes(DRY_RUN_TAG);
    // audit v7.7.33 (AL11) — the interactive affordance is the TITLE BUTTON, not
    // the whole card. Pre-fix the card was role=button wrapping the <table>:
    // role=button demands presentational children, so screen readers dropped the
    // table/row/cell semantics and the whole board was one ambiguous tab stop.
    // Now the button carries the action + accessible name; the table sits outside it.
    html+=`<div class="card rankings-picker-card${_rkInt?' is-internal':''}" ${_rkInt?'title="Test / dry run event"':''}>
      <h4 class="rankings-card-title"><button type="button" class="rankings-card-view" data-action="rankings-select-comp" data-comp-id="${esc(comp.id)}" data-comp-name="${esc(comp.name)}" aria-label="${label} — view these rankings" style="background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;text-align:left">${label}</button>${_rkInt?` <span class="badge draft badge-xs">${DRY_RUN_TAG}</span>`:''} <span class="rankings-status-pill ${statusClass(statusObj)}">(${statusLabel(statusObj)})</span>${board.length?_rkExportBtn(_rkKey,rawLabel):''}</h4>
      <table data-tcols="rankings">
        ${rankingsThead(_rkKey)}
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }
  if(_q&&_hiddenCards&&!_matched){
    html+=`<p class="rankings-empty">No participants match <strong>${esc(_q)}</strong> on any of the ${_hiddenCards} live board${_hiddenCards===1?'':'s'}.</p>`;
  }
  html+=`</div>`;
  setSafeHtml(container, html);
  _rkSetSearchCount(_matched,_total,_q);
  for(const{comp,ts,board}of results){
    if(_q&&!board.some(u=>_rkMatches(u,_q)))continue;   // its card was skipped
    _rkPaintSortIcons(`live-${comp.id}${ts?'-'+ts.id:''}`);
  }
}

export async function loadAdminLeaderboardPerSlot(comp,timeslots){
  const mySeq=++S._rkFetchSeq;        // v7.21.15 — see loadAdminLeaderboardAllLive
  _rkResetExports();                  // v7.28.0 — see loadAdminLeaderboardAllLive
  const container=document.getElementById('admin-rankings-content');
  // ext-audit v7.20.9 (F9a) — serve a sort / expand re-render from the CACHE.
  //
  // v7.17.0 added `S._rkCache` to the all-live and focused-single-comp loaders
  // but not to this one, so a column sort or a "Show all" click on the per-
  // SESSION view still re-issued one `/api/admin/leaderboard` request per
  // timeslot — a network round trip per session for a pure client-side
  // reordering of data already in hand. Same shape as the other two: the key is
  // the request set, and every non-sort caller misses because it does not set
  // `_rkSortOnly`. The check must stay ABOVE the first `await` — `_rkSortOnly`
  // is cleared synchronously by the caller's `finally`.
  const _urls=timeslots.map(ts=>`/api/admin/leaderboard?competitionId=${comp.id}&timeslotId=${ts.id}`);
  const _key=_urls.join("|");
  let results;
  if(_rkCacheHit("per-slot",_key)){
    results=S._rkCache.data;
  }else{
    // Fetch all timeslot leaderboards in parallel.
    // v7.28.0 — via `_rkBoard`, which this loader never adopted. `.catch(()=>[])`
    // only fires when the PARSE fails, so a 500's `{error:"…"}` was returned
    // as-is and then `.filter`ed — the exact v7.23.5 defect `_rkBoard` was
    // written to fix and which the other two loaders already use. It mattered
    // more once the export reads what the renderer computed.
    results=await Promise.all(timeslots.map(async (ts,i)=>{
      const board=await _rkBoard(_urls[i]);
      return{ts,board:board||[],failed:board===null};
    }));
    if(mySeq!==S._rkFetchSeq)return;   // superseded mid-flight
    S._rkCache={kind:"per-slot",key:_key,data:results};
  }
  const tsSt=ts=>computeCompStatus(ts);
  const statusLabel=ts=>{const s=tsSt(ts);return s==='live'?'Live':s==='ended'?'Ended':'Upcoming';};
  const statusClass=ts=>`is-${tsSt(ts)}`;
  const _q=_rkSearchTerm();               // v7.22.0 — see loadAdminLeaderboardAllLive
  let _matched=0,_total=0,_hiddenCards=0;
  let html=`<div class="rankings-section-header">
    <h3 id="admin-rankings-title">${esc(comp.name)} - Per Session Rankings</h3>
    <button class="btn sm secondary" data-action="rankings-refresh">Refresh</button>
  </div>
  <div class="rankings-card-grid">`;
  for(const{ts,board}of results){
    _total+=board.length;
    _matched+=_rkShownCount(board,_q);   // see loadAdminLeaderboardAllLive
    if(_q&&!board.some(u=>_rkMatches(u,_q))){_hiddenCards++;continue;}
    const _rkKey=`slot-${ts.id}`;
    const rawLabel=`${comp.name} ${ts.name}`;
    const rows=board.length?renderLeaderboardTable(board,_rkKey,_rkKey,rawLabel)
      :`<tr><td colspan="${rankingsColspan()}" class="rankings-empty-row compact">No participants yet.</td></tr>`;
    html+=`<div class="card rankings-slot-card">
      <h4 class="rankings-card-title">${esc(ts.name)} <span class="rankings-status-pill ${statusClass(ts)}">(${statusLabel(ts)})</span>${board.length?_rkExportBtn(_rkKey,rawLabel):''}</h4>
      <table data-tcols="rankings">
        ${rankingsThead(_rkKey)}
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }
  if(_q&&_hiddenCards&&!_matched){
    html+=`<p class="rankings-empty">No participants match <strong>${esc(_q)}</strong> in any of the ${_hiddenCards} session${_hiddenCards===1?'':'s'}.</p>`;
  }
  html+=`</div>`;
  setSafeHtml(container, html);
  _rkSetSearchCount(_matched,_total,_q);
  for(const{ts,board}of results){
    if(_q&&!board.some(u=>_rkMatches(u,_q)))continue;   // its card was skipped
    _rkPaintSortIcons(`slot-${ts.id}`);
  }
}

export async function loadAdminLeaderboard(){
  if(!adminCan('leaderboard.view'))return;   // RBAC — as loadAdminRankingsTab
  const mySeq=++S._rkFetchSeq;        // v7.21.15 — see loadAdminLeaderboardAllLive
  _rkResetExports();                  // v7.28.0 — see loadAdminLeaderboardAllLive
  const compId=S.adminRankingsCompId||S.adminSelectedCompetitionId;
  const container=document.getElementById('admin-rankings-content');
  // v8.1.0 (PR 18) — Rankings → PROGRESS for an unranked kind.
  //
  // The server now answers [] for one, so without this the pane would render an
  // empty standings table under the heading "Rankings" — indistinguishable from a
  // load failure, which is exactly how it gets reported (v7.14.2: gate the
  // affordance and the EXPLANATION together). It says what the event is, why
  // there is no board, and where the equivalent information does live.
  const _rkComp=(S.adminCompetitionsData||[]).find(c=>c.id===compId);
  if(_rkComp&&!policyOrDefault(_rkComp.policy).ranking_enabled){
    setSafeHtml(container, `<div class="card rankings-table-card">
      <div class="rankings-section-header"><h3 id="admin-rankings-title">Progress</h3></div>
      <p class="rk-unranked-note">
        <strong>${esc(_rkComp.name)}</strong> is ${esc(eventKindPhraseClient(_rkComp.event_kind)||'an event')},
        which has no rank or placing — so there is no leaderboard to show.
      </p>
      <p class="rk-unranked-note">
        Per-participant progress is on the <strong>Analytics</strong> tab, and the
        <strong>Export Activity (CSV)</strong> item on this event's row gives one line per
        participant per challenge.
      </p>
    </div>`);
    return;
  }
  // Restore standard single-table layout if it was replaced by per-slot view —
  // or if the header on screen belongs to the other presenter-view mode.
  _rkEnsureBoardCard(container);
  if(!compId){
    setSafeHtml(document.getElementById('admin-rankings-body'), `<tr><td colspan="${rankingsColspan()}" class="rankings-empty-row">Select an event to view rankings.</td></tr>`);
    return;
  }
  let lbUrl=`/api/admin/leaderboard?competitionId=${compId}`;
  if(S.adminSelectedTimeslotId)lbUrl+=`&timeslotId=${S.adminSelectedTimeslotId}`;
  // v7.11.0 — fetch the individual board + the group-level board in parallel.
  let board, groupBoard;
  if (_rkCacheHit("scoped", lbUrl)) {
    ({ board, groupBoard } = S._rkCache.data);
  } else {
    // v7.11.0 — fetch the individual board + the group-level board in parallel.
    // v7.23.5 (audit Wave 5) — a FAILED board must not render as an empty one.
    // MEASURED: a 500 produced the full header over "No participants yet." — a
    // confident, false claim about a competition's standings, which is the worst
    // thing this screen can say. _rkBoard returns null only on a real failure
    // (non-ok or a non-array body), which is distinguishable from a genuinely
    // empty board; the renderer cannot tell them apart, so the loader answers.
    let _bFail=false;
    [board,groupBoard]=await Promise.all([
      _rkBoard(lbUrl).then(b=>{ if(b===null)_bFail=true; return b||[]; }),
      _rkBoard(lbUrl+'&groups=1').then(b=>b||[]),
    ]);
    if(mySeq!==S._rkFetchSeq)return;   // superseded mid-flight
    S._rkCache = { kind: "scoped", key: lbUrl, data: { board, groupBoard } };
    if(_bFail){
      if(mySeq!==S._rkFetchSeq)return;
      // Do NOT cache a failure — the next Refresh must retry (v7.21.9's rule
      // about never persisting a computed-but-wrong board, applied to the cache).
      S._rkCache=null;
      renderLoadFailure('admin-rankings-content',{noun:'the rankings',retryAction:'retry-load-admin-rankings'});
      showToast('Could not load the rankings.','error');
      return;
    }
  }
  _rkRenderTopCerts(compId,board);
  const tbody=document.getElementById('admin-rankings-body');
  // The competition name is what the download is called; it comes from the
  // admin list rather than the heading, whose text also carries a status suffix.
  const _compName=(S.adminCompetitionsData.find(c=>c.id===compId)||{}).name||'';
  setSafeHtml(tbody, board.length?renderLeaderboardTable(board,'main','main',_compName)
    :`<tr><td colspan="${rankingsColspan()}" class="rankings-empty-row">No participants on the board yet.</td></tr>`);
  // v7.22.0 — the count covers the individual board only; the group board below
  // ranks a different kind of thing, so folding the two into one number would
  // make "12 of 30 participants match" a claim about groups as well.
  const _q=_rkSearchTerm();
  _rkSetSearchCount(_rkShownCount(board,_q),board.length,_q);
  // v7.11.0 — group-level board below the individual one, shown ONLY when ≥1 group
  // is bound to the competition (empty array otherwise → section hidden). The
  // container may be absent (index.html's initial markup + the all-live/per-slot
  // views don't include it, so the `!body` recreate block above was skipped) —
  // create it on demand so the board renders on every path.
  let groupSection=document.getElementById('admin-rankings-group-section');
  if(!groupSection){
    groupSection=document.createElement('div');
    groupSection.id='admin-rankings-group-section';
    container.appendChild(groupSection);
  }
  _rkPaintSortIcons('main');
  if(Array.isArray(groupBoard)&&groupBoard.length){
    setSafeHtml(groupSection, `<div class="card rankings-table-card rankings-group-card">
      <div class="rankings-section-header"><h3>Group Rankings</h3>
        <div class="rankings-header-actions">${_rkExportBtn('group',_compName?_compName+' team rankings':'')}</div>
      </div>
      <p class="rankings-group-hint">Groups are ranked by their members' average score, then average time-to-solve. Participants added individually also appear on their own.</p>
      <table data-tcols="rankings-group">
        ${rankingsThead('group',{player:'Group / Player',score:'Avg Score',time:'Avg Time to Solve'},_RK_GROUP_COLS)}
        <tbody>${renderGroupBoardTable(groupBoard,'group','group',_compName)}</tbody>
      </table>
    </div>`);
    groupSection.style.display='';
    _rkPaintSortIcons('group');
  }else{
    setSafeHtml(groupSection, '');
    groupSection.style.display='none';
  }
}

// ── The top three's certificates (event workspace → Rankings) ───────────────
//
// Shown for a RANKED event's own board: the 1st, 2nd and 3rd place rows that
// earn a Gold, Silver or Bronze certificate — points above zero (`earnsPlacement`,
// the mint's rule; operator ruling, 14 Nov 2026) — with a preview of the
// certificate the design gives them (the server renders it from the event's
// design and the row's name and score — POST /api/admin/certificate-config/preview)
// and a PNG download. A top-three place on zero or less is named in a note
// instead, with no medal to preview: its holder gets participation if they
// attempted a challenge (the panel cannot tell, so the note says "if").
//
// A row that holds an ISSUED certificate (GET /api/admin/competitions/:id/
// certificates, matched by user id, not revoked) downloads that PDF — its
// holder's frozen facts and credential code — and is named as that certificate
// prints the name. A Gold, Silver or Bronze already issued to a place on zero
// or less keeps its medal (operator ruling, 14 Nov 2026), so that place is a
// medal place too, not one the note names. Before the event ends nobody holds
// one, and the buttons render the design with the row's live name and score
// instead, labelled as a preview.
const _RK_TIERS = { 1: ['gold', '1st place'], 2: ['silver', '2nd place'], 3: ['bronze', '3rd place'] };
const _RK_MEDAL_TIERS = new Set(['gold', 'silver', 'bronze']);
let _rkTop = { compId: null, places: [], rows: [], issued: new Map() };

// Does this place hold a medal certificate: by the rule (points above zero), or
// by an issued Gold, Silver or Bronze, which keeps its medal whatever the score?
function _rkHoldsMedal(r, issued) {
  if (earnsPlacement(r)) return true;
  const c = issued instanceof Map ? issued.get(r.userId) : null;
  return !!(c && _RK_MEDAL_TIERS.has(c.tier));
}

function _rkRenderTopCerts(compId, board, { reread = true } = {}) {
  const box = document.getElementById('admin-rankings-certs');
  if (!box) return;
  const comp = (S.adminCompetitionsData || []).find(c => c.id === compId);
  const ranked = comp && policyOrDefault(comp.policy).ranking_enabled !== false;
  const places = (board || []).filter(r => !r.isBenchmark && !r.isLateEntrant && r.rank >= 1 && r.rank <= 3).slice(0, 3);
  // RBAC — its reads and previews are `certificates.view` routes.
  if (!comp || !ranked || !places.length || S.adminSelectedCompetitionId !== compId || !adminCan('certificates.view')) { box.hidden = true; setSafeHtml(box, ''); delete box.dataset.compId; return; }
  const ended = computeCompStatus(comp) === 'ended';
  // Keep what the issued-certificate read already learnt for this event: an
  // unchanged board returns early below, and wiping the map there turned an
  // "Issued PDF" button back into a design preview.
  const keepIssued = _rkTop.compId === compId && _rkTop.issued instanceof Map ? _rkTop.issued : new Map();
  const top = places.filter(r => _rkHoldsMedal(r, keepIssued));
  const unearned = places.filter(r => !_rkHoldsMedal(r, keepIssued)).map(r => _RK_TIERS[r.rank][1]);
  _rkTop = { compId, places, rows: top, issued: keepIssued };
  const key = places.map(r => `${r.userId}:${r.rank}:${r.score}:${_rkHoldsMedal(r, keepIssued) ? 'm' : '-'}`).join('|') + (ended ? ':e' : ':l');
  if (box.dataset.key === key && box.dataset.compId === compId && !box.hidden) return;
  box.dataset.key = key; box.dataset.compId = compId;
  const name = _rkCertName;
  // "3rd place", "2nd and 3rd place", "1st, 2nd and 3rd place".
  const placesWord = unearned.length > 1 ? `${unearned.slice(0, -1).map(l => l.replace(' place', '')).join(', ')} and ${unearned[unearned.length - 1]}` : (unearned[0] || '');
  setSafeHtml(box, `<div class="rk-certs-head"><div><p class="eyebrow gold">Certificates</p><h3 id="rk-certs-title">Top three</h3></div>
      <p class="rk-certs-note">${ended ? 'Final placings.' : 'Provisional: the event is still running, so these can change.'} Previews use this event's certificate design; each finisher collects their own issued certificate, with its credential code, from their account.</p></div>
    ${unearned.length ? `<p class="rk-certs-note rk-certs-zero">No medal certificate for ${esc(placesWord)}: a top-three place earns Gold, Silver or Bronze only with points above zero; ${unearned.length > 1 ? 'those finishers get' : 'that finisher gets'} a participation certificate if they attempted a challenge.</p>` : ''}
    ${top.length ? `<ol class="rk-certs-list">${top.map(r => {
      const [tier, label] = _RK_TIERS[r.rank];
      return `<li class="rk-cert" data-rank="${r.rank}">
        <figure class="rk-cert-fig"><img alt="" hidden data-rk-cert-img="${r.rank}"/><span class="rk-cert-medal rk-cert-${esc(tier)}" aria-hidden="true">${r.rank}</span></figure>
        <div class="rk-cert-txt"><span class="eyebrow">${esc(label)}</span><b>${esc(name(r))}</b><small>${esc(r.nickname || '')} · ${esc(String(r.score ?? 0))} pts</small></div>
        <div class="rk-cert-actions"><button type="button" class="btn sm secondary" data-action="rk-cert-preview" data-rank="${r.rank}">Preview</button><button type="button" class="btn sm${r.rank === 1 ? ' gold' : ''}" data-action="rk-cert-download" data-rank="${r.rank}">${ICO.download} PNG</button></div>
      </li>`;
    }).join('')}</ol>` : ''}`);
  box.hidden = false;
  if (reread) _rkRefreshIssued(compId);
}

// The name the place's certificate prints, by the server's own rule, never
// composed here (the certificate puts a Chinese, Japanese or Korean family name
// first, and leaves off a salutation the fonts cannot draw with the name): an
// issued certificate's own (the organisers' list `name`: one frozen with the
// nickname keeps printing it), else the one a certificate issued now would
// print (buildAdminLeaderboard `certificatePrintedName`, lib/badge.js).
function _rkCertName(r) {
  const held = _rkTop.issued instanceof Map ? _rkTop.issued.get(r.userId) : null;
  return (held && held.name) || r.certificatePrintedName || r.nickname || 'Participant';
}

/** Re-read which of the top three hold an issued certificate and relabel. */
async function _rkRefreshIssued(compId) {
  const d = await fetchIssuedCertificates(compId);
  if (!d || !Array.isArray(d.certificates) || _rkTop.compId !== compId) return false;
  const issued = new Map();
  for (const c of d.certificates) if (!c.revoked) issued.set(c.userId, c);
  const places = _rkTop.places || [];
  const medals = (m) => places.map(r => _rkHoldsMedal(r, m)).join();
  const before = medals(_rkTop.issued);
  _rkTop.issued = issued;
  // An issued medal the read found (or lost) changes which places the card
  // lists: draw it again from the same places, without another read.
  if (medals(issued) !== before) _rkRenderTopCerts(compId, places, { reread: false });
  const box = document.getElementById('admin-rankings-certs');
  for (const r of (_rkTop.rows || [])) {
    const li = box && box.querySelector(`.rk-cert[data-rank="${r.rank}"]`);
    if (!li) continue;
    const nm = li.querySelector('.rk-cert-txt b');
    if (nm) nm.textContent = _rkCertName(r);
    const dl = li.querySelector('[data-action="rk-cert-download"]');
    // Both ways: a certificate revoked since the card drew leaves a place that
    // still earns its medal by points, so the card is not redrawn and only
    // this puts the button back to the design preview it now downloads.
    if (dl) {
      const has = issued.has(r.userId);
      setSafeHtml(dl, `${ICO.download} ${has ? 'Issued PDF' : 'PNG'}`);
      li.classList.toggle('is-issued', has);
    }
  }
  return true;
}

async function _rkCertPng(rank) {
  const r = (_rkTop.rows || []).find(x => x.rank === rank);
  const comp = (S.adminCompetitionsData || []).find(c => c.id === _rkTop.compId);
  if (!r || !comp) return null;
  const [tier] = _RK_TIERS[rank];
  const nm = cutCodePoints(_rkCertName(r), 120);
  const out = await renderCertificatePreview({ compId: comp.id, sample: { tier, name: nm, event: cutCodePoints(comp.name, 120), score: `${r.score ?? 0} pts` } });
  if (out.error) { showToast(out.error, 'error'); return null; }
  return { blob: out.blob, nm, comp };
}

export async function rkCertPreview(rank) {
  const out = await _rkCertPng(Number(rank));
  if (!out) return;
  const img = document.querySelector(`[data-rk-cert-img="${Number(rank)}"]`);
  if (!img) return;
  img.src = await blobToDataUri(out.blob);
  img.alt = `Certificate preview for ${out.nm}`;
  img.hidden = false;
  img.closest('.rk-cert')?.classList.add('has-img');
}

export async function rkCertDownload(rank) {
  const row = (_rkTop.rows || []).find(x => x.rank === Number(rank));
  // Ask again at the click: the dispatcher may have issued it since the board
  // painted, and a stale "preview" answer would hand out a PNG for a PDF.
  const known = row ? await _rkRefreshIssued(_rkTop.compId) : false;
  if (row && _rkTop.issued && _rkTop.issued.has(row.userId)) {
    downloadIssuedCertificate(_rkTop.compId, row.userId, 'pdf', _rkCertName(row));
    return;
  }
  // Once the event has ended a certificate may have been issued, so a failed
  // read is not "none issued": a design preview (no credential code) must not
  // go out in place of the real certificate.
  const comp = (S.adminCompetitionsData || []).find(c => c.id === _rkTop.compId);
  if (row && !known && comp && computeCompStatus(comp) === 'ended') {
    showToast(`Could not check whether ${_rkCertName(row)} holds an issued certificate. Try again.`, 'error');
    return;
  }
  const out = await _rkCertPng(Number(rank));
  if (!out) return;
  // The holder part names the place as the issued downloads name their holder,
  // in any script (ui/download.js fileNameSlug: <event>-1-张伟-certificate.png);
  // the event part is the event name's ASCII slug, as other generated files name
  // an event. Each part keeps its 30-character cut and its fallback word.
  const eventSlug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  downloadBlob(out.blob, `${eventSlug(out.comp.name) || 'event'}-${Number(rank)}-${fileNameSlug(out.nm, { max: 30, fallback: 'finisher' })}-certificate.png`);
}
