"use strict";

import { S } from "../core/state.js";
import { paginationHtml } from "../ui/list-controls.js";
import { _ttVendorScriptPolicy, setSafeHtml } from "../core/trusted-types.js";
import { compDisplayCategory, COMP_CATEGORY_LABEL } from "./competition-picker.js";
import { esc, DRY_RUN_TAG, compareTaskNumbers } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { downloadCsv } from "../ui/csv.js";
import { showToast } from "../ui/toast.js";
import { applyColumnFilters, hasColumnFilters } from "../ui/table-columns.js";
import { isQualifyingTask } from "../ui/task-search.js";
import { fetchJsonList } from "../core/api.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)
import { crossNavOffered } from "./admin-crossnav.js"; // RBAC — a name links only into a page the role may open

export function loadEchartsOnDemand() {
  if (window.echarts) return Promise.resolve();
  if (S._echartsLoading) return S._echartsLoading;
  S._echartsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const rawUrl = window.__assetUrlWithVersion
      ? window.__assetUrlWithVersion('/vendor/echarts.min.js')
      : '/vendor/echarts.min.js';
    // TT-safe URL assignment: the named policy allowlists this exact
    // path. On browsers without TT the raw string works directly.
    s.src = _ttVendorScriptPolicy ? _ttVendorScriptPolicy.createScriptURL(rawUrl) : rawUrl;
    s.onload = () => resolve();
    s.onerror = () => {
      // Reset so a later retry (e.g. admin switches tabs and opens
      // Analytics again after a transient network blip) can try once more.
      S._echartsLoading = null;
      reject(new Error('echarts load failed'));
    };
    document.head.appendChild(s);
  });
  return S._echartsLoading;
}

export const _analyticsState={
  // v8.1.0 (PR 21) — NULL means "the admin has not said what to aggregate yet".
  //
  // It used to open on 'global' and fire a platform-wide aggregate over every
  // competition ever run, painted before anyone had asked for anything. The
  // v7.22.3 focused-scope adoption IS the scope for the common workflow — focus
  // today's event, open Analytics — so that path is byte-for-byte unchanged and
  // still one click; what changes is that with NO focus the pane asks instead of
  // guessing.
  scope:null,
  competitionId:null,
  timeslotId:null,
  periodPreset:'all',
  from:'', to:'',
  taskIds:[],
  difficulties:['easy','medium','hard'],
  // Tag filters per dimension: mode is 'exclude', 'include', or 'none'.
  // Default: competitions exclude "internal", participants exclude "staff".
  compTagFilter: { mode: 'exclude', tags: [DRY_RUN_TAG] },
  challengeTagFilter: { mode: 'none', tags: [] },
  participantTagFilter: { mode: 'exclude', tags: ['staff'] },
  // v6.20.0 — participant dimension can filter by tags (default) or groups.
  participantMode: 'tags', // 'tags' | 'groups'
  groupFilter: { mode: 'include', groups: [] }, // groups = array of group ids
  // v7.24.0 — `null` means "the admin has not chosen a column", which is what
  // lets the DEFAULT order depend on the scope (see _anEffectiveSort). It is
  // the S.lbSortCol === null convention from the participant leaderboard.
  // A header click pins an explicit key and it then survives a scope change,
  // because that is a choice the admin made.
  sortKey:null,
  sortAsc:false,
  // computed
  lastResponse:null,
  availableTags:[],
};

export const _analyticsRowCharts=new Map(); // task_id -> ECharts instance

export function _renderTagFilter(dimension, filter, availTags) {
  if (!(availTags||[]).length) return '<span style="color:var(--muted);font-size:var(--fs-12)">No tags defined yet</span>';
  const act = `analytics-${dimension}-tag-mode`;
  const seg = (val, label) => {
    const active = filter.mode === val;
    return `<button type="button" class="seg ${active?'seg-active':''}" data-action="${act}" data-value="${val}">${label}</button>`;
  };
  const modeBar = `<div class="seg-control" style="margin-bottom:6px">${seg('none','All')}${seg('exclude','Exclude')}${seg('include','Only')}</div>`;

  if (filter.mode === 'none') return modeBar;

  const pills = (availTags||[]).map(t => {
    const active = filter.tags.includes(t);
    // v7.23.1 (audit Wave 2) — the active states are CLASSES now. They were
    // inline `color:#fff`, and white on --red measures 3.67:1 in the dark theme.
    // The readable foreground differs by theme (dark text fixes dark and would
    // REGRESS light), and an inline literal cannot be themed at all — so the
    // fix has to leave the style attribute. See .tag-pill-* in styles.css.
    const cls = active ? (filter.mode === 'exclude' ? 'tag-pill-exclude' : 'tag-pill-include') : '';
    const st = active ? '' : 'background:var(--bg);color:var(--text);border:1px solid var(--muted);';
    return `<button type="button" class="${cls}" style="${st}border-radius:var(--pill-radius);padding:3px 10px;font-size:var(--fs-12);cursor:pointer;transition:all var(--duration-fast) var(--ease-out)" data-action="analytics-${dimension}-tag-toggle" data-value="${esc(t)}">${esc(t)}</button>`;
  }).join('');
  const clearBtn = filter.tags.length ? ` <button type="button" class="link-btn-inline" style="font-size:var(--fs-12)" data-action="analytics-${dimension}-tag-clear">clear</button>` : '';
  return `${modeBar}<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">${pills}${clearBtn}</div>`;
}

export function _analyticsScheduleRefetch(){
  clearTimeout(S._analyticsDebounce);
  S._analyticsDebounce=setTimeout(()=>fetchAnalytics(),250);
}

export async function loadAdminAnalytics(){
  // v7.21.19 (audit F7) — five INDEPENDENT reads, fetched together and no longer
  // cached across the session.
  //
  // They used to run one after another, so the analytics request itself could
  // not start until all five had returned — measured at a synthetic 150 ms RTT,
  // the data request began at 818 ms and the first paint landed at 1.16 s.
  // Nothing about them is ordered; only the task tags are derived, and that is
  // pure computation over a result.
  //
  // The comp/task lists were also cached with `if(!S._analyticsCompCache)` and
  // never invalidated by anything, so a competition created, renamed, deleted or
  // re-tagged after the first visit to this tab stayed missing from the pickers
  // until a full page reload — a wrong answer, not a slow one. The cache is gone
  // rather than given an invalidator: this function runs on TAB ENTRY only (see
  // ui/nav.js), so it was saving one round trip per visit, and it now costs
  // nothing because the reads are parallel. The state fields remain because the
  // filter-bar renderers and main.js's pickers read them.
  //
  // v8.3.20 (external audit) — CHECK r.ok, AND STOP INVENTING SERVER STATE.
  //
  // Two defects in five lines. `.then(r=>r.json())` never checked `r.ok`, so a
  // 500's error BODY parsed into an object — and the tag union below iterates
  // `S._analyticsTaskCache`, where `(t.tags||[])` cannot save it because an
  // object IS truthy: it threw "not iterable" BEFORE the filter bar or the
  // fetch ran, leaving the pane blank with nothing said.
  //
  // And two of the fallbacks FABRICATED data: `[DRY_RUN_TAG]` and
  // `['staff','benchmark']` are guesses at what the server would have said,
  // rendered as filter chips an admin would then act on. A failed read must
  // present as a failed read, never as a plausible answer.
  //
  // RBAC — each list is read only by a role that may read it (the routes ask
  // `events.view`, `challenges.view`, `participants.view`, `groups.view`); a list
  // the role may not read is EMPTY here — the filter it feeds has nothing to
  // offer — never a request the gate refuses and never a "check your
  // connection" over a pane whose own query (`analytics.view`) the role may run.
  // A failure is a failure only for a list that was asked for.
  const _read=(perm,url)=>adminCan(perm)?fetchJsonList(url):Promise.resolve([]);
  const [comps, tasks, compTags, partTags, groups] = await Promise.all([
    _read('events.view','/api/admin/competitions'),
    _read('challenges.view','/api/admin/tasks'),
    _read('events.view','/api/admin/competition-tags'),
    _read('participants.view','/api/admin/tags'),
    _read('groups.view','/api/admin/groups'),
  ]);
  if(!comps||!tasks||!compTags||!partTags||!groups){
    // Through the file's OWN failure renderer, not a hand-written row. A first
    // draft wrote into `#analytics-table-body`, which lives inside
    // `#analytics-table-card` — and BOTH `_renderAnalyticsPrompt` and
    // `_renderAnalyticsEmpty` hide that card, so on the DEFAULT entry state
    // (no competition focused, v8.1.0) the message rendered into a hidden node
    // and the only surviving signal was a 4-second toast. It also hard-coded
    // `colspan="11"` against a 12-column table, re-introducing ext-audit F12 on
    // the very table that fix was written for; `_renderAnalyticsEmpty` derives
    // the span from the real `<thead>`.
    showToast('Could not load analytics. Check your connection and try again.','error');
    return _renderAnalyticsEmpty('The analytics filters could not be loaded. Check your connection and reopen this tab.',{failed:true});
  }
  S._analyticsCompCache=comps;
  // A QUALIFYING challenge (a `qualifying:<key>` tag, lib/qualifying.js) is left
  // out of every Analytics answer by the server, so neither it (the challenge
  // picker) nor its tag (the tag chips, built from the challenges offered here)
  // is offered: choosing one could only ever return "no activity" for a
  // question everyone answered.
  S._analyticsTaskCache=tasks.filter(t=>!isQualifyingTask(t));
  S._availableCompTags=compTags;
  S._availableParticipantTags=partTags;
  S._availableGroups=groups;
  // Build the union of all tags seen on tasks (admin-assignable tags only).
  const tagSet=new Set();
  for(const t of (S._analyticsTaskCache||[])) (t.tags||[]).forEach(tag=>tagSet.add(tag));
  _analyticsState.availableTags=[...tagSet].sort();
  _analyticsAdoptFocusedScope();
  // A role scoped to its events measures one event or session at a time (the
  // route refuses it platform-wide), so with no events to read it has nothing
  // to measure: say so, in the pane, rather than offering a picker with nothing
  // in it.
  if(S.isEventAdmin&&!adminCan('events.view')){
    return _renderAnalyticsEmpty('Your role can see analytics but not events, so there is no event to measure. Ask an administrator to add “See events” to your role.');
  }
  renderAnalyticsFilterBar();
  fetchAnalytics();
}

// The scope last ADOPTED from an open event workspace ({scope, competitionId,
// timeslotId}), so the sidebar's Analytics can tell a scope the admin chose in
// this pane (kept) from one it only inherited from a workspace (dropped).
let _adoptedScope=null;

/**
 * v7.22.3 — entering Analytics adopts the competition (and session) the admin
 * already has in focus.
 *
 * The scope banner is the admin's answer to "what am I working on", and every
 * other pane honours it. Analytics did not: it opened on Global every time, so
 * an admin focused on today's event had to find that competition again in a
 * picker listing every competition ever run — and, worse, could read a
 * platform-wide chart believing it was scoped, because nothing on the way in
 * said otherwise.
 *
 * NO OPEN EVENT KEEPS ONLY WHAT WAS CHOSEN HERE. Clearing analytics back to
 * Global whenever no event is open would throw away a selection the admin made
 * inside this pane for no reason; the rule is "adopt the open event if there is
 * one", not "mirror the workspace". But a scope this pane merely INHERITED from
 * a workspace, unchanged since, is dropped when the pane opens with no event
 * (the sidebar's door, which leaves the workspace): it would paint one event's
 * figures under a page about every event. This runs on TAB ENTRY only (see
 * ui/nav.js), so re-entering from another event's workspace re-syncs.
 *
 * It is called BEFORE renderAnalyticsFilterBar() and the single fetchAnalytics()
 * below, so there is exactly one request and the v7.21.19 (F3) stale-response
 * guard has nothing to race.
 */
export function _analyticsAdoptFocusedScope(){
  const s=_analyticsState;
  if(!S.adminSelectedCompetitionId){
    // THE SIDEBAR DOOR (ui/nav.js adminTab closes any workspace first): a page
    // about every event. A scope this pane only inherited from a workspace, and
    // that nobody has changed here since, belongs to that workspace — showing it
    // would paint one event's figures under a door that promises none. It goes,
    // and the pane asks; a scope chosen in this pane stays (the rule below).
    if(_adoptedScope&&s.scope===_adoptedScope.scope&&s.competitionId===_adoptedScope.competitionId&&s.timeslotId===_adoptedScope.timeslotId){
      s.scope=null;s.competitionId=null;s.timeslotId=null;
    }
    _adoptedScope=null;
    return false;
  }
  s.competitionId=S.adminSelectedCompetitionId;
  // A focused SESSION narrows it further. Analytics has a real timeslot scope,
  // so this is expressible rather than approximated — but only when a session
  // is actually focused, because scope='timeslot' with no timeslotId renders
  // "Pick a session" instead of the competition's own figures.
  if(S.adminSelectedTimeslotId){
    s.scope='timeslot';
    s.timeslotId=S.adminSelectedTimeslotId;
  }else{
    s.scope='competition';
    s.timeslotId=null;
  }
  _adoptedScope={scope:s.scope,competitionId:s.competitionId,timeslotId:s.timeslotId};
  return true;
}

export function renderAnalyticsFilterBar(){
  const el=document.getElementById('analytics-filterbar');
  const s=_analyticsState;
  const comps=S._analyticsCompCache||[];
  const tasks=S._analyticsTaskCache||[];
  // Timeslots for the chosen competition (only when scope=session).
  const selComp=comps.find(c=>c.id===s.competitionId);
  const slots=(selComp?.timeslots)||[];
  const slotOpts=slots.map(t=>`<option value="${esc(t.id)}" ${s.timeslotId===t.id?'selected':''}>${esc(t.name)}</option>`).join('');
  // Difficulty chips (multi-select, default all on)
  const diffChip=(d,label,cls)=>`<button type="button" class="chip ${s.difficulties.includes(d)?'chip-active '+cls:''}" data-action="analytics-toggle-difficulty" data-value="${d}">${label}</button>`;
  // Tag chips

  // Build a "picker button" summary that says e.g. "Test Live  ▾" for the
  // chosen competition, or "Click to choose competition" when nothing is set.
  const compStatusBadge=(c)=>{
    if(!c)return '';
    const cat=compDisplayCategory(c);
    const cls='comp-'+cat;
    const label=COMP_CATEGORY_LABEL[cat]||'Ended';
    return `<span class="badge comp-badge ${cls}" style="font-size:var(--fs-12)">${label}</span>`;
  };
  const isSelCompInt = (selComp?.tags||[]).includes(DRY_RUN_TAG);
  const compIntBadge = isSelCompInt ? `<span class="badge draft" style="font-size:var(--fs-12);margin-left:2px" title="Marked as a test / dry run">${DRY_RUN_TAG}</span>` : '';
  const compPickerBtn=`
    <button type="button" class="picker-btn" data-action="analytics-open-comp-picker" ${isSelCompInt?'style="border-left:3px solid var(--yellow)"':''}>
      ${selComp?`<span class="picker-btn-name">${esc(selComp.name)}</span>${compStatusBadge(selComp)}${compIntBadge}`
              :`<span class="picker-btn-placeholder">Click to choose event…</span>`}
      <span class="picker-btn-chev">${ICO.chevronDown}</span>
    </button>`;
  // Challenges picker shows "All challenges" or "3 selected" + a chevron.
  const tasksLabel=s.taskIds.length
    ? `<span class="picker-btn-name">${s.taskIds.length} challenge${s.taskIds.length===1?'':'s'} selected</span>`
    : `<span class="picker-btn-placeholder">All challenges</span>`;
  const tasksPickerBtn=`
    <button type="button" class="picker-btn" data-action="analytics-open-task-picker">
      ${tasksLabel}<span class="picker-btn-chev">${ICO.chevronDown}</span>
    </button>`;

  // INSIDE AN EVENT'S WORKSPACE, ANALYTICS IS THAT EVENT (owner's decision, 27
  // Nov 2026): no Global/Event switch and no event picker, which would only
  // lead out of the event the workspace is about. The scope card names the
  // event and, where it has sessions, narrows to one. The sidebar's Analytics
  // is the cross-event page and keeps the switch.
  const wsComp=S.adminSelectedCompetitionId?comps.find(c=>c.id===S.adminSelectedCompetitionId):null;
  const wsScopeHtml=S.adminSelectedCompetitionId?`
      <section class="filter-card" id="analytics-ws-scope">
        <div class="help-label-row"><div class="filter-card-title">Scope</div><span data-help="analytics.wsScope" data-help-label="Scope"></span></div>
        <p class="analytics-ws-event"><span class="picker-btn-name">${esc(wsComp?wsComp.name:(S.adminSelectedCompetitionName||'This event'))}</span>${compStatusBadge(wsComp)}${compIntBadge}</p>
        ${slots.length?`
        <div class="filter-card-section">
          <label class="mini-label" for="analytics-ws-slot">Session</label>
          <select id="analytics-ws-slot" class="filter-select" data-change-action="analytics-ws-set-timeslot">
            <option value="" ${s.scope!=='timeslot'?'selected':''}>Whole event</option>${slots.map(t=>`<option value="${esc(t.id)}" ${s.scope==='timeslot'&&s.timeslotId===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>`:''}
      </section>`:'';

  setSafeHtml(el, `
    <div class="analytics-filterbar-grid">
      ${wsScopeHtml||`<section class="filter-card">
        <div class="help-label-row"><div class="filter-card-title">Scope</div><span data-help="analytics.scope" data-help-label="Scope"></span></div>
        <div class="seg-control">
          ${S.isEventAdmin?'':`<button type="button" class="seg ${s.scope==='global'?'seg-active':''}" data-action="analytics-set-scope" data-value="global">Global</button>`}
          <button type="button" class="seg ${s.scope==='competition'?'seg-active':''}" data-action="analytics-set-scope" data-value="competition">Event</button>
          <button type="button" class="seg ${s.scope==='timeslot'?'seg-active':''}" data-action="analytics-set-scope" data-value="timeslot">Session</button>
        </div>
        ${s.scope==='global'?`
        <div class="filter-card-section">
          <label class="mini-label" for="analytics-period">Time window</label>
          <select id="analytics-period" class="filter-select" data-change-action="analytics-set-period">
            <option value="all" ${s.periodPreset==='all'?'selected':''}>All time</option>
            <option value="month" ${s.periodPreset==='month'?'selected':''}>Last month</option>
            <option value="3months" ${s.periodPreset==='3months'?'selected':''}>Last 3 months</option>
            <option value="6months" ${s.periodPreset==='6months'?'selected':''}>Last 6 months</option>
            <option value="year" ${s.periodPreset==='year'?'selected':''}>Last year</option>
            <option value="custom" ${s.periodPreset==='custom'?'selected':''}>Custom range…</option>
          </select>
          ${s.periodPreset==='custom'?`
          <div class="filter-date-range">
            <input type="date" id="analytics-from" value="${esc(s.from?s.from.slice(0,10):'')}" data-change-action="analytics-set-from"/>
            <span style="color:var(--muted)">to</span>
            <input type="date" id="analytics-to" value="${esc(s.to?s.to.slice(0,10):'')}" data-change-action="analytics-set-to"/>
          </div>`:''}
        </div>`:''}
        ${s.scope!=='global'?`
        <div class="filter-card-section">
          <label class="mini-label">Event</label>
          ${compPickerBtn}
        </div>`:''}
        ${s.scope==='timeslot'?`
        <div class="filter-card-section">
          <label class="mini-label" for="analytics-slot">Session</label>
          <select id="analytics-slot" class="filter-select" data-change-action="analytics-set-timeslot" ${slots.length?'':'disabled'} ${isSelCompInt?'style="border-left:3px solid var(--yellow)"':''}>
            <option value="">${slots.length?'Select…':'No sessions on this event'}</option>${slotOpts}
          </select>
        </div>`:''}
        ${s.scope==='global'&&S._availableCompTags.length?`
        <div class="filter-card-section" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <label class="mini-label">Event tags</label>
          ${_renderTagFilter('comp', s.compTagFilter, S._availableCompTags)}
        </div>`:''}
      </section>`}

      <section class="filter-card">
        <div class="filter-card-title">Challenges</div>
        ${tasksPickerBtn}
        ${s.taskIds.length?`<button type="button" class="link-btn" data-action="analytics-clear-tasks">Clear selection</button>`:''}
        <div class="filter-card-section">
          <label class="mini-label">Difficulty</label>
          <div class="chip-row">
            ${diffChip('easy','Easy','chip-easy')}
            ${diffChip('medium','Medium','chip-medium')}
            ${diffChip('hard','Hard','chip-hard')}
          </div>
        </div>
        ${s.availableTags.length?`
        <div class="filter-card-section">
          <label class="mini-label">Challenge tags</label>
          ${_renderTagFilter('challenge', s.challengeTagFilter, s.availableTags)}
        </div>`:''}
      </section>

      <section class="filter-card">
        <div class="filter-card-title">Participants</div>
        <div class="seg-control" style="margin-bottom:8px">
          <button type="button" class="seg ${s.participantMode!=='groups'?'seg-active':''}" data-action="analytics-participant-mode" data-value="tags">Tags</button>
          <button type="button" class="seg ${s.participantMode==='groups'?'seg-active':''}" data-action="analytics-participant-mode" data-value="groups">Groups</button>
        </div>
        <div class="filter-card-section">
          ${s.participantMode==='groups'
            ? `<label class="mini-label">Participant groups</label>${_renderGroupFilter(s.groupFilter, S._availableGroups)}`
            : `<label class="mini-label">Participant tags</label>${_renderTagFilter('participant', s.participantTagFilter, S._availableParticipantTags)}`}
        </div>
      </section>
    </div>`);
}

export function _renderGroupFilter(filter, availGroups) {
  if (!(availGroups||[]).length) return '<span style="color:var(--muted);font-size:var(--fs-12)">No groups defined yet</span>';
  const seg = (val, label) => `<button type="button" class="seg ${filter.mode===val?'seg-active':''}" data-action="analytics-group-mode" data-value="${val}">${label}</button>`;
  const modeBar = `<div class="seg-control" style="margin-bottom:6px">${seg('none','All')}${seg('exclude','Exclude')}${seg('include','Only')}</div>`;
  if (filter.mode === 'none') return modeBar;
  const pills = availGroups.map(g => {
    const active = filter.groups.includes(g.id);
    // v7.23.1 (audit Wave 2) — the active states are CLASSES now. They were
    // inline `color:#fff`, and white on --red measures 3.67:1 in the dark theme.
    // The readable foreground differs by theme (dark text fixes dark and would
    // REGRESS light), and an inline literal cannot be themed at all — so the
    // fix has to leave the style attribute. See .tag-pill-* in styles.css.
    const cls = active ? (filter.mode === 'exclude' ? 'tag-pill-exclude' : 'tag-pill-include') : '';
    const st = active ? '' : 'background:var(--bg);color:var(--text);border:1px solid var(--muted);';
    return `<button type="button" class="${cls}" style="${st}border-radius:var(--pill-radius);padding:3px 10px;font-size:var(--fs-12);cursor:pointer;transition:all var(--duration-fast) var(--ease-out)" data-action="analytics-group-toggle" data-value="${esc(g.id)}">${esc(g.name)}</button>`;
  }).join('');
  const clearBtn = filter.groups.length ? ` <button type="button" class="link-btn-inline" style="font-size:var(--fs-12)" data-action="analytics-group-clear">clear</button>` : '';
  return `${modeBar}<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">${pills}${clearBtn}</div>`;
}

export function _analyticsClosePicker(){
  document.getElementById('analytics-picker-overlay')?.remove();
}

export function _analyticsParseLocalDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // local midnight
}

export function _tagModeHandler(filterKey) {
  return (e, el) => { _analyticsState[filterKey].mode = el.dataset.value; renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); };
}

export function _tagToggleHandler(filterKey) {
  return (e, el) => { const t=el.dataset.value,f=_analyticsState[filterKey]; const i=f.tags.indexOf(t); if(i>=0)f.tags.splice(i,1); else f.tags.push(t); renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); };
}

export function _tagClearHandler(filterKey) {
  return () => { _analyticsState[filterKey].tags=[]; renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); };
}

export function _analyticsBuildQuery(){
  const s=_analyticsState;
  const p=new URLSearchParams();
  p.set('scope', s.scope);
  if (s.scope==='competition' || s.scope==='timeslot') {
    if (s.competitionId) p.set('competitionId', s.competitionId);
  }
  if (s.scope==='timeslot' && s.timeslotId) p.set('timeslotId', s.timeslotId);
  if (s.scope==='global') {
    if (s.periodPreset==='custom') {
      if (s.from) p.set('from', s.from);
      if (s.to) p.set('to', s.to);
    } else {
      p.set('periodPreset', s.periodPreset);
    }
  }
  if (s.taskIds.length) p.set('taskIds', s.taskIds.join(','));
  // Don't send difficulties when all three are selected (no-op filter).
  if (s.difficulties.length && s.difficulties.length < 3) p.set('difficulties', s.difficulties.join(','));
  // Challenge tag filter
  const chf = s.challengeTagFilter;
  if (chf.mode === 'exclude' && chf.tags.length) p.set('excludeChallengeTags', chf.tags.join(','));
  else if (chf.mode === 'include' && chf.tags.length) p.set('includeChallengeTags', chf.tags.join(','));
  // Competition tag filter
  const cf = s.compTagFilter;
  if (cf.mode === 'exclude' && cf.tags.length) p.set('excludeCompTags', cf.tags.join(','));
  else if (cf.mode === 'include' && cf.tags.length) { p.set('includeCompTags', cf.tags.join(',')); p.set('excludeCompTags', ''); }
  else p.set('excludeCompTags', ''); // mode=none → no filter
  // Participant dimension — either tags (default) or groups (v6.20.0).
  if (s.participantMode === 'groups') {
    // Group filtering replaces the tag filter; disable the default staff
    // exclusion so the group selection is the sole participant filter.
    p.set('excludeParticipantTags', '');
    const gf = s.groupFilter;
    if (gf.mode === 'include' && gf.groups.length) p.set('includeGroups', gf.groups.join(','));
    else if (gf.mode === 'exclude' && gf.groups.length) p.set('excludeGroups', gf.groups.join(','));
  } else {
    const pf = s.participantTagFilter;
    if (pf.mode === 'exclude' && pf.tags.length) p.set('excludeParticipantTags', pf.tags.join(','));
    else if (pf.mode === 'include' && pf.tags.length) { p.set('includeParticipantTags', pf.tags.join(',')); p.set('excludeParticipantTags', ''); }
    else p.set('excludeParticipantTags', ''); // mode=none → no filter
  }
  return p.toString();
}

export async function fetchAnalytics(){
  // Skip when comp/session scope is incomplete — just show empty state.
  const s=_analyticsState;
  // v8.1.0 (PR 21) — no scope yet means no aggregate. Returns BEFORE the query is
  // built, so nothing is requested and nothing is cached.
  if (!s.scope) return _renderAnalyticsPrompt();
  if ((s.scope==='competition' || s.scope==='timeslot') && !s.competitionId) {
    return _renderAnalyticsEmpty('Pick an event to see its analytics.');
  }
  if (s.scope==='timeslot' && !s.timeslotId) {
    return _renderAnalyticsEmpty('Pick a session to see its analytics.');
  }
  const q=_analyticsBuildQuery();
  // v6.10.36 — fetch the data and kick off the echarts bundle in parallel.
  // First Analytics open used to wait on a 1 MB deferred-but-page-boot
  // bundle; the tab renders without echarts (summary + table + the
  // `if(!window.echarts)` guarded canvas skip), but we want charts for
  // the common case. Running the two fetches concurrently hides the
  // echarts download cost behind the aggregates API round-trip.
  const echartsP = loadEchartsOnDemand().catch((e) => console.warn('Charts library failed to load', e));
  // v7.21.19 (audit F3) — stale-response guard, the same shape v7.15.13 gave the
  // admin tables and v7.21.15 gave Rankings and Logs. Analytics is the surface
  // neither sweep reached, and the 250 ms debounce is not a substitute: it only
  // prevents requests that have NOT BEEN SENT. Every filter chip, scope change
  // and date-range edit fires another, and once two are in flight the network
  // decides which one the admin ends up reading — silently, because one
  // aggregate table looks much like another.
  const mySeq=++S._analyticsFetchSeq;
  let r;
  try { r=await fetch(`/api/admin/analytics/challenges?${q}`); }
  catch(_){ if(mySeq!==S._analyticsFetchSeq)return; return _renderAnalyticsEmpty('The connection to the server failed.',{failed:true}); }
  if(mySeq!==S._analyticsFetchSeq)return;   // superseded while in flight
  if (!r.ok) {
    const d=await r.json().catch(()=>({}));
    if(mySeq!==S._analyticsFetchSeq)return; // …and an error for an abandoned query is its own wrong answer
    return _renderAnalyticsEmpty(d.error||`Server error (${r.status}).`,{failed:true});
  }
  const data=await r.json();
  // Re-check AFTER the body parse: fetch resolves at response HEADERS, so a
  // newer request can land during the parse (v7.15.15).
  if(mySeq!==S._analyticsFetchSeq)return;
  _analyticsState.lastResponse=data;
  // Wait for echarts too so the summary donut + row charts render on the
  // first paint after aggregates arrive. Graceful-degrade via the
  // `if(!window.echarts)` guards inside the renderers if the load failed.
  await echartsP;
  renderAnalyticsSummary(data);
  renderAnalyticsTable(data);
}

// v7.23.5 (audit Wave 5) — a FAILURE and an EMPTY RESULT are different answers.
//
// MEASURED on a 500: #analytics-summary rendered the bare string "Boom" (the raw
// `d.error` token straight from the server) while #analytics-empty was ALSO made
// visible, reading "No challenge activity in the selected window." So the screen
// showed an unexplained token next to a confident, contradictory false claim
// about the data — at the same time.
//
// `failed` keeps the empty-state line hidden and frames the message, so the two
// cases can no longer be shown together. Callers that mean "there genuinely is
// no activity" pass nothing and are unchanged.
// v8.1.0 (PR 21) — ONE RULE: the per-challenge table card exists if and only if a
// successful query's rows are in hand.
//
// That single boolean replaces a per-element suppression list, because the search
// box, its clear button, Export CSV, the table header, the pagination bar AND the
// "no activity" line all live inside #analytics-table-card, while the summary
// panel sits outside it. Six affordances in one move, and it cannot drift the way
// a hand-maintained list does.
function _analyticsShowTableCard(show){
  const card=document.getElementById('analytics-table-card');
  if(card)card.style.display=show?'':'none';
}

// The unscoped entry state: a prompt, two actions, and a line saying what
// platform-wide would actually cover. NO request is issued.
export function _renderAnalyticsPrompt(){
  _analyticsState.lastResponse=null;
  _analyticsShowTableCard(false);
  setSafeHtml(document.getElementById('analytics-summary'), `
    <div class="card analytics-prompt">
      <p class="analytics-prompt-lead">Choose what to measure.</p>
      <div class="analytics-prompt-actions">
        <button type="button" class="btn sm" data-action="analytics-set-scope" data-value="competition">Pick an event</button>
        ${S.isEventAdmin?'':`<button type="button" class="btn sm secondary" data-action="analytics-set-scope" data-value="global">Show platform-wide</button>`}
      </div>
      ${S.isEventAdmin?`
      <p class="analytics-prompt-note">
        Analytics covers the events you organise. There is no platform-wide view for
        an event admin — it would aggregate events that are not yours — so pick one
        of yours, or a session inside it.
      </p>`:`
      <p class="analytics-prompt-note">
        Platform-wide covers every event ever run except those marked
        <strong>${esc(DRY_RUN_TAG)}</strong>, and excludes participants tagged
        <strong>staff</strong>. On a long-lived platform that is a lot of history, which is
        why it is not the default.
      </p>`}
    </div>`);
  const meta=document.getElementById('analytics-table-meta');
  if(meta)meta.textContent='';
}

export function _renderAnalyticsEmpty(msg,{failed=false}={}){
  // v7.24.0 — DROP the cached payload. It belongs to the scope we have just
  // left, or to a request that failed, and three things read it: the search
  // re-render, the pager, and (new) Export CSV. Leaving it in place means an
  // admin who switches to a competition with no activity — or whose fetch
  // errors — sees an empty table and downloads the PREVIOUS scope's rows under
  // a filename naming the new one. That is a wrong answer, not a stale one, and
  // it is the failure this whole release is about. With it cleared the export
  // says "the analytics data has not loaded" instead.
  _analyticsState.lastResponse=null;
  const body=failed
    ? `Could not load analytics. ${esc(String(msg||'').trim()||'The server did not respond correctly.')}`
    : esc(msg);
  setSafeHtml(document.getElementById('analytics-summary'),
    `<div class="card" style="text-align:center;color:var(--muted);padding:32px 16px">${body}</div>`);
  setSafeHtml(document.getElementById('analytics-table-body'), '');
  // v8.1.0 (PR 21) — HIDE THE CARD, which also fixes a defect that predates this
  // release: this function set #analytics-empty to display:block, and that element
  // is the static string "No challenge activity in the selected window." So a
  // PROMPT ("Pick a competition to see its analytics.") and a contradicting claim
  // about the data were on screen together — what v7.23.5 fixed for the FAILURE
  // case and did not fix for the prompt case.
  document.getElementById('analytics-empty').style.display=failed?'none':'block';
  _analyticsShowTableCard(false);
  document.getElementById('analytics-table-meta').textContent='';
}

export function _analyticsEventColours(){
  const cs = getComputedStyle(document.documentElement);
  return {
    solved:         cs.getPropertyValue('--green').trim()  || '#00e5a0',
    incorrect:      cs.getPropertyValue('--red').trim()    || '#ff4d6a',
    hint_revealed:  cs.getPropertyValue('--yellow').trim() || '#ffd166',
    navigated_away: cs.getPropertyValue('--muted').trim()  || '#888',
  };
}

export const ANALYTICS_EVENT_LABELS = {
  solved: 'Solved', incorrect: 'Incorrect',
  hint_revealed: 'Hints revealed', navigated_away: 'Navigated away',
};

export function renderAnalyticsSummary(data){
  const sum=data.summary||{};
  const total=(sum.solved||0)+(sum.incorrect||0)+(sum.hint_revealed||0)+(sum.navigated_away||0);
  const palette=_analyticsEventColours();
  const card=(label,val,colour)=>`<div class="analytics-stat" style="border-left:3px solid ${esc(colour)}">
    <div class="analytics-stat-label">${esc(label)}</div>
    <div class="analytics-stat-value">${Number(val).toLocaleString()}</div>
  </div>`;
  setSafeHtml(document.getElementById('analytics-summary'), `
    <div class="card analytics-summary-grid">
      <div class="analytics-donut-wrap">
        <div id="analytics-donut" style="width:100%;height:280px"></div>
      </div>
      <div class="analytics-stats">
        ${card('Solved', sum.solved||0, palette.solved)}
        ${card('Incorrect', sum.incorrect||0, palette.incorrect)}
        ${card('Hints revealed', sum.hint_revealed||0, palette.hint_revealed)}
        ${card('Navigated away', sum.navigated_away||0, palette.navigated_away)}
        <div class="analytics-stat" style="border-left:3px solid var(--accent)">
          <div class="analytics-stat-label">Unique participants</div>
          <div class="analytics-stat-value">${(sum.unique_participants||0).toLocaleString()}</div>
        </div>
        <div class="analytics-stat" style="border-left:3px solid var(--accent2)">
          <div class="analytics-stat-label">Challenges with activity</div>
          <div class="analytics-stat-value">${(sum.unique_challenges||0).toLocaleString()}</div>
        </div>
      </div>
    </div>`);
  // Build / re-build the donut. No bottom legend — the four event-type stat
  // cards on the right already serve as the colour key, so the legend
  // would just duplicate that and steal vertical space from the chart.
  const el=document.getElementById('analytics-donut');
  if(!el || !window.echarts) return;
  if(S._analyticsDonut) S._analyticsDonut.dispose();
  S._analyticsDonut=window.echarts.init(el, null, { renderer:'canvas' });
  const textColour=getComputedStyle(document.documentElement).getPropertyValue('--text').trim()||'#fff';
  const mutedColour=getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()||'#888';
  S._analyticsDonut.setOption({
    // appendToBody escapes the summary card's overflow clipping so the tooltip
    // isn't cut off on the left/edges when hovering the donut (v7.11.6).
    tooltip:{trigger:'item',appendToBody:true,formatter:'{b}: <b>{c}</b> ({d}%)'},
    series:[{
      name:'Activity', type:'pie', radius:['62%','85%'], avoidLabelOverlap:true,
      center:['50%','50%'],
      label:{show:true,position:'center',formatter:total?`{a|${total.toLocaleString()}}\n{b|events}`:`{b|no events}`,
        rich:{a:{fontSize:28,fontWeight:700,color:textColour},
              b:{fontSize:12,color:mutedColour,padding:[4,0,0,0]}}},
      labelLine:{show:false},
      data:[
        {name:ANALYTICS_EVENT_LABELS.solved,         value:sum.solved||0,         itemStyle:{color:palette.solved}},
        {name:ANALYTICS_EVENT_LABELS.incorrect,      value:sum.incorrect||0,      itemStyle:{color:palette.incorrect}},
        {name:ANALYTICS_EVENT_LABELS.hint_revealed,  value:sum.hint_revealed||0,  itemStyle:{color:palette.hint_revealed}},
        {name:ANALYTICS_EVENT_LABELS.navigated_away, value:sum.navigated_away||0, itemStyle:{color:palette.navigated_away}},
      ],
    }],
  });
}

// v7.22.6 — the challenge name in the analytics table opens the Challenges tab
// filtered to it, completing the set begun on the rankings board (v7.22.0) and
// the submissions stream (v7.22.2). Analytics is where you find out WHICH
// challenge is going wrong; having then to go and find it by hand is the
// friction the other two already removed.
//
// The title is the handle rather than `task_id`, because that is what the
// Challenges pane's search matches — and it is what the admin can read on the
// row, so the navigation lands on the thing they clicked. Same `.sub-link`
// treatment and same <button> reasoning as the submissions cells: the row stays
// a row for a screen reader (v7.7.33 AL11) and the button inherits the global
// focus-visible ring.
function _anChallengeCell(title){
  const v=String(title||'');
  if(!v)return '—';
  if(!crossNavOffered('challenge'))return esc(v);   // RBAC — no Challenges page for this role: a plain name
  return `<button type="button" class="sub-link" data-action="analytics-open-challenge" data-title="${esc(v)}"
    title="Show ${esc(v)} in Challenges" aria-label="${esc(v)} — show in the Challenges tab">${esc(v)}</button>`;
}

const _anTotalOf=r=>(r.solved||0)+(r.incorrect||0)+(r.hint_revealed||0)+(r.navigated_away||0);
const _anSolveRate=r=>r.unique_attempters?(r.solved/r.unique_attempters):0;

// v7.24.0 — the DEFAULT row order, derived from the SCOPE.
//
// It used to be "total events, descending" for every scope, which reads as an
// arbitrary order to anyone looking at a competition: the row an admin wants is
// the one whose NUMBER they can see on the participant's screen, and hunting
// for it in activity order is the friction. So:
//
//   • competition / session scope → the competition's own challenge numbering,
//     ascending. This is the same order the participant sees.
//   • global scope → challenge NAME, ascending. `task_number` belongs to a
//     (challenge, competition) PAIR and the server sends it as null outside a
//     competition scope (swagger: "Set only when scope is competition or
//     timeslot"), so numbering is not merely unhelpful there, it does not exist.
//
// A header click pins `sortKey` and this stops applying — the admin's choice
// outranks the default, and it deliberately survives a scope change.
export function _anEffectiveSort(){
  const s=_analyticsState;
  if(s.sortKey) return {key:s.sortKey, asc:s.sortAsc, auto:false};
  return s.scope==='global'
    ? {key:'title',       asc:true, auto:true}
    : {key:'task_number', asc:true, auto:true};
}

// Sort a COPY of the rows by the effective sort. Blank challenge numbers are
// held out of the direction flip and always land last (the v7.22.0
// _RK_BLANK_FIELD rule): a challenge unassigned from the competition keeps its
// challenge_events but loses its competition_tasks row, so a null number is
// reachable — and a screenful of numberless rows at the top is not what someone
// who sorted by number asked for, in either direction.
export function _anSortRows(rows){
  const {key,asc}=_anEffectiveSort();
  const valueOf=r=>{
    if(key==='total') return _anTotalOf(r);
    if(key==='solve_rate') return _anSolveRate(r);
    if(key==='title') return (r.title||'').toLowerCase();
    if(key==='difficulty') return ['easy','medium','hard'].indexOf(r.difficulty||'');
    return r[key]||0;
  };
  const cmp=key==='task_number'
    ? (a,b)=>compareTaskNumbers(a.task_number,b.task_number)
    : (a,b)=>{const va=valueOf(a),vb=valueOf(b); return va<vb?-1:va>vb?1:0;};
  if(key==='task_number'){
    // Blanks are held OUT of the direction flip. compareTaskNumbers already
    // sorts them last on an ascending pass, but negating it for descending
    // would float them to the top — so the partition, not the comparator, is
    // what makes "blanks last" true in BOTH directions (the v7.22.0
    // _RK_BLANK_FIELD rule).
    const has=rows.filter(r=>r.task_number!=null&&String(r.task_number).trim()!=='');
    const blank=rows.filter(r=>!(r.task_number!=null&&String(r.task_number).trim()!==''));
    has.sort((a,b)=>asc?cmp(a,b):-cmp(a,b));
    return has.concat(blank);
  }
  return rows.slice().sort((a,b)=>asc?cmp(a,b):-cmp(a,b));
}

// The search box lives in static chrome, so it is readable from anywhere.
function _anSearchQuery(){
  return (document.getElementById('analytics-search')?.value||'').toLowerCase().trim();
}

// v7.24.0 — ONE definition of "the rows currently in view", used by the table
// renderer AND by the CSV export. Two copies of this filter is how a download
// comes to disagree with the screen it was taken from. It holds the search box
// AND the heading filters (ui/table-columns.js), over every row before paging,
// so a heading filter narrows the file exactly as it narrows the table.
export function _anRowsInView(data){
  const all=_anSortRows((data&&data.per_challenge)||[]);
  const q=_anSearchQuery();
  // v7.20.11 — DIFFICULTY joins the searchable fields. The table renders it in
  // its own sortable column, and both sibling surfaces (#task-search and the
  // Assign-Challenges picker) already match on it, so typing "hard" narrowing
  // the Challenges table but doing nothing here was a straight inconsistency.
  const searched=q
    ? all.filter(r=>[r.task_number,r.title,r.difficulty,...(r.tags||[])]
        .some(v=>v!=null&&String(v).toLowerCase().includes(q)))
    : all;
  const matched=applyColumnFilters('analytics',searched);
  return {all, matched, q, narrowed:!!q||hasColumnFilters('analytics')};
}

// ── The per-challenge table's columns (ui/table-columns.js; defined from boot()) ──
// A MODEL table: its heading filters narrow every row before paging, through
// _anRowsInView, which the export shares. The Columns chooser is a display
// choice: the file always carries every column (its header is a contract).
// The table writes its own aria-sort (_anSyncSortHeaders), the effective sort.
export const ANALYTICS_TABLE_COLUMNS={
  noun:'challenge',
  hidden:['difficulty','tags','total','incorrect','hint_revealed','navigated_away'],
  ariaSortOwner:true,
  cols:{title:{grow:true},difficulty:{filter:'enum'},tags:{sort:false},breakdown:{sort:false,filter:null}},
  model:{
    rows:()=>(_analyticsState.lastResponse&&_analyticsState.lastResponse.per_challenge)||[],
    get:(r,k)=>{switch(k){
      case 'task_number':return r.task_number!=null?String(r.task_number):'';
      case 'title':return r.title||'';
      case 'difficulty':return r.difficulty||'';
      case 'tags':return r.tags||[];
      case 'total':return _anTotalOf(r);
      case 'solve_rate':return r.unique_attempters?`${Math.round(_anSolveRate(r)*100)}%`:'';
      case 'solved':case 'incorrect':case 'hint_revealed':case 'navigated_away':case 'unique_attempters':return r[k]||0;
      default:return '';
    }},
    onChange:()=>{ S._anPage=1; if(_analyticsState.lastResponse)renderAnalyticsTable(_analyticsState.lastResponse); },
  },
};

// v7.24.0 — reflect the EFFECTIVE sort in aria-sort, including the default one.
//
// This lived only in the header-click handler, so before the scope-derived
// default existed a freshly-opened table announced `aria-sort="none"` on all
// eleven columns while being sorted by total-events. Now that the default IS a
// visible order it must be announced, which is the same requirement audit M23
// added the attribute for — a sort a screen-reader user cannot perceive is
// conveyed by row order alone, i.e. not at all.
export function _anSyncSortHeaders(){
  const {key,asc}=_anEffectiveSort();
  for(const h of document.querySelectorAll('#analytics-table thead th[data-sort]')){
    h.setAttribute('aria-sort', h.dataset.sort===key ? (asc?'ascending':'descending') : 'none');
  }
}

export function renderAnalyticsTable(data){
  // v8.1.0 (PR 21) — the one rule in the affirmative direction: rows from a
  // successful query are in hand, so the card exists.
  _analyticsShowTableCard(true);
  // Re-resolve palette per render (v6.2.6 — see _analyticsEventColours comment).
  const palette=_analyticsEventColours();
  const totalOf=_anTotalOf, solveRate=_anSolveRate;
  const {all:rows, matched, q, narrowed}=_anRowsInView(data);
  _anSyncSortHeaders();

  const body=document.getElementById('analytics-table-body');
  if (!rows.length) {
    // v7.20.9 (ext-audit F12) — the zero-data early return used to leave the
    // PAGINATION BAR and the search-clear button behind, so a filter change
    // that emptied the result set showed "Page 2 of 5" and a Clear button over
    // an explicit "no activity" message. Reset the whole list chrome here, and
    // reset the page index too — leaving S._anPage at 3 means the next
    // non-empty render silently starts on page 3 of a list the operator has
    // not seen page 1 of.
    setSafeHtml(body, '');
    document.getElementById('analytics-empty').style.display='block';
    document.getElementById('analytics-table-meta').textContent='';
    const _pag0=document.getElementById('analytics-pagination');
    if(_pag0)setSafeHtml(_pag0,'');
    const _clr0=document.getElementById('analytics-search-clear');
    if(_clr0)_clr0.classList.add('hidden');
    S._anPage=1;
    _analyticsDisposeRowCharts();
    return;
  }
  document.getElementById('analytics-empty').style.display='none';

  // v7.20.7 — search + pagination. This is the largest unbounded admin list and
  // the only one with a rendering COST attached: every row carries its own
  // ECharts mini-chart, so 200 challenges meant 200 chart instances on one
  // screen. Paginating bounds the charts as a side effect, because the chart
  // pass queries the DOM for `.analytics-row-chart` and only the page's rows
  // are in it. `matched` / `q` come from _anRowsInView above, which the CSV
  // export shares so the file and the screen cannot disagree.
  const PAGE=Math.max(10,S._anPageSize||25);
  const totalPages=Math.max(1,Math.ceil(matched.length/PAGE));
  const page=Math.min(Math.max(1,S._anPage||1),totalPages);
  S._anPage=page;
  const visible=matched.slice((page-1)*PAGE,page*PAGE);

  document.getElementById('analytics-table-meta').textContent = narrowed
    ? `${matched.length} of ${rows.length} challenges match`
    : `${rows.length} challenge${rows.length===1?'':'s'} with activity`;
  const _pag=document.getElementById('analytics-pagination');
  if(_pag){
    setSafeHtml(_pag, matched.length>PAGE||page>1
      ? paginationHtml('analytics',{page,totalPages,
          totalLabel:narrowed?`${matched.length} of ${rows.length}`:`${matched.length} total`,
          pageSize:PAGE,sizes:[25,50,100,200]})
      : '');
  }
  const _clr=document.getElementById('analytics-search-clear');
  if(_clr)_clr.classList.toggle('hidden',!q);
  if(!visible.length){
    // v7.20.9 (ext-audit F12) — the colspan is DERIVED from the real header
    // rather than hand-written. It shipped as 10 against an 11-column table
    // (the Solve-rate column was added later), which renders the empty-state
    // row one cell short of the table's width. Reading the thead means the
    // next column added cannot reintroduce the mismatch.
    const _cols=document.querySelectorAll('#analytics-table thead th').length||11;
    setSafeHtml(document.getElementById('analytics-table-body'),
      `<tr><td colspan="${_cols}" class="table-empty-row">${q?`No challenges match "${esc(q)}"${hasColumnFilters('analytics')?' and the column filters':''}.`:'No challenges match the column filters.'}</td></tr>`);
    _analyticsDisposeRowCharts();
    return;
  }

  // Render rows. The mini stacked-bar chart is drawn into a per-row div by
  // ECharts after the DOM is in place — we tag each div with the task id.
  setSafeHtml(body, visible.map(r=>{
    const tot=totalOf(r);
    const rate=solveRate(r);
    const tagsHtml=(r.tags||[]).slice(0,4).map(t=>`<span class="tag">${esc(t)}</span>`).join('');
    const moreTags=(r.tags||[]).length>4?`<span class="tag">+${(r.tags||[]).length-4}</span>`:'';
    return `<tr>
      <td>${r.task_number?esc(r.task_number):'—'}</td>
      <td>${_anChallengeCell(r.title)}</td>
      <td>${r.difficulty?`<span class="badge ${esc(r.difficulty)}">${esc(r.difficulty)}</span>`:'—'}</td>
      <td style="white-space:normal">${tagsHtml}${moreTags}</td>
      <td><div class="analytics-row-chart" data-task-id="${esc(r.task_id)}" style="width:160px;height:24px"></div></td>
      <td style="text-align:right;font-weight:var(--fw-semibold)">${Number(tot).toLocaleString()}</td>
      <td style="text-align:right;color:${esc(palette.solved)}">${(r.solved||0).toLocaleString()}</td>
      <td style="text-align:right;color:${esc(palette.incorrect)}">${(r.incorrect||0).toLocaleString()}</td>
      <td style="text-align:right;color:${esc(palette.hint_revealed)}">${(r.hint_revealed||0).toLocaleString()}</td>
      <td style="text-align:right;color:${esc(palette.navigated_away)}">${(r.navigated_away||0).toLocaleString()}</td>
      <!-- v7.27.0 — the solve rate's DENOMINATOR, immediately before the rate it
           divides by. "43%" of 7 attempters is a different claim from 43% of 70,
           and the table showed only the ratio. It is a COUNT OF PEOPLE, not of
           events: COUNT(DISTINCT user_id) over the challenge's events, so unlike
           the four event columns it never sums with them (Total deliberately
           excludes it). -->
      <td style="text-align:right">${(r.unique_attempters||0).toLocaleString()}</td>
      <td style="text-align:right">${r.unique_attempters?(rate*100).toFixed(0)+'%':'—'}</td>
    </tr>`;
  }).join(''));

  // Mount mini stacked-bar charts.
  _analyticsDisposeRowCharts();
  // Only the rows actually on the page have a chart container in the DOM, so
  // iterating the full set would build instances for elements that do not exist.
  for (const r of visible) {
    const el=body.querySelector(`.analytics-row-chart[data-task-id="${CSS.escape(r.task_id)}"]`);
    if (!el || !window.echarts) continue;
    const chart=window.echarts.init(el, null, { renderer:'canvas' });
    chart.setOption({
      grid:{left:0,right:0,top:0,bottom:0,containLabel:false},
      xAxis:{type:'value',show:false,splitLine:{show:false},max:totalOf(r)||1},
      yAxis:{type:'category',data:[''],show:false},
      // appendToBody escapes the .table-card's overflow-y:auto clipping so the
      // multi-line tooltip isn't cut off at the top on the first table row (the
      // 24px row chart sits inside a scroll-clipped table cell) (v7.11.6).
      tooltip:{trigger:'axis',appendToBody:true,axisPointer:{type:'shadow'},
        formatter:p=>p.map(x=>`${x.marker} ${x.seriesName}: <b>${x.value}</b>`).join('<br>')},
      series:['solved','incorrect','hint_revealed','navigated_away'].map(t=>({
        name:ANALYTICS_EVENT_LABELS[t], type:'bar', stack:'a',
        data:[r[t]||0],
        itemStyle:{color:palette[t]},
        barWidth:'80%', emphasis:{focus:'series'},
      })),
    });
    _analyticsRowCharts.set(r.task_id, chart);
  }
}

export function _analyticsDisposeRowCharts(){
  for (const c of _analyticsRowCharts.values()) try { c.dispose(); } catch(e){ console.warn('Chart dispose failed', e); }
  _analyticsRowCharts.clear();
}

// v7.24.0 — the per-challenge breakdown, as a spreadsheet.
//
// WHAT IT EXPORTS: every row matching the current scope, tag, difficulty,
// SEARCH and heading filters — the whole filtered set, NOT the page on screen,
// and every column, whichever the Columns chooser shows. Pagination
// here exists to bound the ECharts instances (v7.20.7), not to scope the data,
// so exporting 25 of 200 would be answering a question nobody asked. It shares
// `_anRowsInView` with the table renderer, so the file holds exactly the rows
// the admin is looking at, in the order they are looking at them (and every
// column, the hidden ones included).
//
// WHY CLIENT-SIDE, with no endpoint: the SPA already holds the whole filtered
// set on `_analyticsState.lastResponse`, and the search box is client-only — a
// server route could not reproduce "what is currently in view" without being
// told the query string twice. It also inherits the v7.21.19 stale-response
// guard for free, because `lastResponse` is only ever written by a fetch that
// was not superseded.
//
// Formula neutralisation is ON — the `ui/csv.js` default. Titles and tags are
// admin-authored, so the exposure is smaller than the participant file's, but
// this download has no shipped bytes to preserve and there is no reason to
// start out unguarded. (The participants download is the one caller that opts
// OUT, and says why at its call site.)
export const ANALYTICS_CSV_HEADERS = [
  'Challenge ID', 'Title', 'Difficulty', 'Tags', 'Total Activity',
  'Solved', 'Incorrect', 'Hints Revealed', 'Navigated Away',
  'Unique Attempters', 'Solve Rate (%)',
];

export function exportAnalyticsCsv(){
  const data=_analyticsState.lastResponse;
  // No response yet (the tab is still loading, or the last fetch failed) — say
  // so rather than saving an empty file the admin would take as an answer.
  if(!data){ showToast('Nothing to export yet — the analytics data has not loaded.','error'); return; }
  const {matched}=_anRowsInView(data);
  if(!matched.length){ showToast('Nothing to export — no challenges match the current filters.','error'); return; }

  const rows=matched.map(r=>[
    // The number is empty in global scope by design (it belongs to a
    // (challenge, competition) pair), which is exactly what the empty cell says.
    r.task_number||'',
    r.title||'',
    r.difficulty||'',
    // The TABLE truncates to four tags + "+N"; the CSV carries them all. A
    // spreadsheet column has no width problem, and "+3" is not data.
    (r.tags||[]).join('; '),
    _anTotalOf(r),
    r.solved||0,
    r.incorrect||0,
    r.hint_revealed||0,
    r.navigated_away||0,
    // The solve rate's DENOMINATOR — a table column since v7.27.0, in this same
    // position (second to last, immediately before the rate it divides by), so
    // the file keeps the table's column order.
    r.unique_attempters||0,
    // Emitted as a NUMBER, not the table's "43%" string, so the column
    // aggregates in a spreadsheet. Blank (not 0) when nobody attempted, matching
    // the table's "—": zero attempts is not a zero solve rate.
    r.unique_attempters?Math.round(_anSolveRate(r)*100):'',
  ]);

  // The filename names the scope, so two exports taken minutes apart from
  // different competitions do not land in Downloads as "analytics (1).csv".
  const sc=data.scope||{};
  const label=[sc.competition_name,sc.timeslot_name].filter(Boolean).join(' ');
  // The two fallbacks are DIFFERENT words on purpose. A competition named
  // entirely in Hebrew, CJK or Cyrillic slugs to the empty string, and reusing
  // 'global' there would hand the admin a file called analytics-global-… for a
  // competition-scoped export — a filename that states the opposite of what the
  // file contains. Slice BEFORE trimming the hyphens, so a cut landing on a
  // separator does not leave a trailing one.
  const slug=label
    ? (String(label).toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40).replace(/^-+|-+$/g,'') || 'event')
    : 'global';
  const date=new Date().toISOString().slice(0,10);
  downloadCsv(`analytics-${slug}-${date}.csv`, ANALYTICS_CSV_HEADERS, rows);
}
