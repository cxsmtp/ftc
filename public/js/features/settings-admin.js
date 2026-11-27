"use strict";

import { S } from "../core/state.js";
import { setListCount, countText, renderLoadFailure, colspanFor, paginationHtml, newSegmentPager, segmentParams, segmentExact, segmentAbsorb, segmentStepTarget, segmentLastTarget, segmentGoTo, segmentBarOptions, syncPageJump } from "../ui/list-controls.js"; // v7.20.10 — shared match count; v7.25.0 — Logs joins the shared pager; the segment pager, shared with the Audit page and the CxOne API audit
import { csrfHeaders, loadCsrfToken, fetchJsonList, fetchJsonObject } from "../core/api.js";
import { html, setSafeHtml } from "../core/trusted-types.js";
import { _sessionMon } from "./session-monitor.js";
import { esc, fmtDt, toggleSearchClear } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { showSkeletonRows } from "../ui/loading.js";
import { showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { clearColumnFilters, hasColumnFilters, syncTable } from "../ui/table-columns.js"; // v8.17.0 — the Logs heading filters
import { loadPlatformCertificateCard } from "./certificate-wizard.js"; // the platform certificate design (certificates.design: administrators and superadmins)
import { refreshAdminBanners, _showIpBanAlert } from "./admin-alerts.js"; // v8.12.7 — repaint the removals banner after an action; the Alerts section re-opens an open alert
import { registerHelpTips } from "../ui/help-tips.js"; // the Settings rows' "?" texts
import { renderPlatformLookCard } from "./look-admin.js"; // the platform look card (superadmin)
import { adminCan, settingsCardOffered } from "../ui/nav.js"; // RBAC — the one permission predicate; each Settings card's own (read inside functions only)
import { renderDocMarkdown } from "./help-drawer.js"; // About & health: the newest release notes, through the drawer's own pipeline
import { releaseNotesVisible, RELEASE_NOTES_DOC } from "./release-notes.js"; // About & health: the release notes, where they are offered
import { AUDIT_ACTIVITY_LABELS, auditActivityLabel } from "./audit-admin.js"; // CxOne API audit: the Audit page's own wording and keys

export function applyPlatformName(name){
  S.currentPlatformName=name;
  document.querySelectorAll('.platform-name').forEach(el=>el.textContent=name);
  document.querySelectorAll('.join-subtitle').forEach(el=>el.textContent='Join '+name);
  document.title=`${name} | Checkmarx`;
}

/** The admin sidebar's foot: "Version 9.2.18", and "v9.2" while it is collapsed. */
export function showSidebarVersion(v){
  const el=document.getElementById('admin-sidebar-version');
  if(!el||!v)return;
  const long=el.querySelector('.asv-long'), short=el.querySelector('.asv-short');
  if(long)long.textContent=`Version ${v}`;
  if(short)short.textContent=`v${v.split('.').slice(0,2).join('.')}`;
  el.hidden=false;
}

export async function loadPlatformName(){
  const d=await fetch('/api/config').then(r=>r.json()).catch(()=>null);
  if(d?.platform_name)applyPlatformName(d.platform_name);
  else if(d?.competition_name)applyPlatformName(d.competition_name);
  if(d?.version){const ve=document.getElementById('platform-version');if(ve)ve.textContent='v.'+d.version; showSidebarVersion(String(d.version));}
  if(d?.server_started_at)_sessionMon.serverStartedAt=d.server_started_at;
  // The emailed sign-in code's lifetime (features/auth.js reads it): unknown
  // until this answer arrives, never a copy of the server's default.
  if(Number.isFinite(d?.login_code_ttl_ms)&&d.login_code_ttl_ms>0)S.loginCodeTtlMs=d.login_code_ttl_ms;
}

export function setAdminLogsStream(stream){
  if(stream!=='app'&&stream!=='access')return;
  if(S._logsStream===stream)return;
  S._logsStream=stream;
  S._logsSortCol='ts';S._logsSortDir='desc';
  S._logsSortedGlobally=false;S._logsSortableGlobally=false;
  // The two streams have different columns, so a heading filter set on one
  // (Message, Path) names nothing on the other: start the new stream clean.
  if(hasColumnFilters('logs'))clearColumnFilters('logs');
  document.querySelectorAll('#admin-logs-tab [data-action="logs-set-stream"]').forEach(b=>b.classList.toggle('active',b.dataset.stream===stream));
  _logsFirstPage();
}

export function sortAdminLogs(col){
  if(S._logsSortCol===col)S._logsSortDir=S._logsSortDir==='asc'?'desc':'asc';
  else{S._logsSortCol=col;S._logsSortDir='desc';}
  // v7.25.0 — when the server can rank the whole filtered set, a header click
  // has to REFETCH; re-rendering from cache would reorder the fifty rows in
  // hand and claim to have ranked everything.
  //
  // Page 1 and a cleared anchor, for the v7.21.16 reason: "page 4 of the old
  // ordering names no rows in the new one". The anchor is dropped for a
  // narrower reason than submissions' — it is a pure timestamp ceiling applied
  // before any ordering, so a sort does not invalidate it; but page 1 sends no
  // anchor and re-pins from the response, so keeping it would set a value that
  // is neither sent nor honoured and is then overwritten. State that looks
  // meaningful and is not.
  _logsApplySort();
}

/** Set the order outright (a heading menu's Sort ascending/descending). */
export function setAdminLogsSort(col,asc){
  const dir=asc?'asc':'desc';
  if(S._logsSortCol===col&&S._logsSortDir===dir)return;
  S._logsSortCol=col;S._logsSortDir=dir;
  _logsApplySort();
}

function _logsApplySort(){
  if(S._logsSortableGlobally)_logsFirstPage();
  else renderAdminLogs();
}

// ── THE PAGER: ui/list-controls.js's segment pager (one definition, shared with
// the Audit page). The Audit log (`stream=app`) pages like the audit trail: its
// first read is counted (up to 10,000 entries), Next goes by the server's cursor
// (cheap at any depth, and on past a walk the scan budget cut), and the other
// moves read the page by anchor and offset. The Request log answers a count on
// every read and no cursor, so it pages by anchor and offset; the client has no
// stream branch, only the answers. ─────────────────────────────────────────────
const _LOGS_JUMP={jump:'logs-page-jump',input:'logs-page-input',note:'logs-page-jump-note'};

/** The ONE way back to page 1: the list starts over (its anchor and positions are dropped). */
export function _logsFirstPage(){
  const st=S._logsPager;
  st.page=1;st.segments=[];st.anchor=null;st.nextCursor=null;st.searchedTo=null;st.cutAt=null;
  return loadAdminLogs();
}

/** Prev, Next, -10 and +10. */
export function logsPageStep(delta){
  const to=segmentStepTarget(S._logsPager,delta);
  if(to!=null)return loadAdminLogs({page:to});
}

/** Last: the counted last page, with an exact count only. */
export function logsPageLast(){
  const to=segmentLastTarget(S._logsPager);
  if(to!=null)return loadAdminLogs({page:to});
}

export function logsPageSize(el){
  const n=parseInt(el&&el.value,10);
  if(![50,100,200,500].includes(n))return;
  S._logsPager.pageSize=n;
  return _logsFirstPage();
}

// ── v8.17.0 — the Logs table's columns (ui/table-columns.js; defined from boot()).
// Its <thead> is rebuilt every render (the columns follow the stream), which the
// component handles from the header row alone. The heading menus drive the
// pane's own sort through `sortTo`, so the server still decides whether it can
// rank every match (`sorted_globally`) and the pager's note stays the truth. The
// log is walked from disk with no per-column filter, so a heading filter narrows
// the entries of THIS page and says so ("on this page"): no model, no total.
export const LOGS_TABLE_COLUMNS={
  noun:'entry',nounPlural:'entries',
  // First, Last and Groups are under Columns: with them the default set does
  // not fit a 1024 px window (Email and Actor already name the person).
  hidden:['user_first_name','user_last_name','user_groups'],
  fixed:['ts'],
  cols:{msg:{grow:true},path:{grow:true},level:{filter:'enum'},method:{filter:'enum'},status:{filter:'enum'}},
  sortTo:(col,asc)=>setAdminLogsSort(col,asc),
};

/** The default ordering — the one the walk already produces. */
export function _logsSortIsDefault(){
  return S._logsSortCol==='ts'&&S._logsSortDir==='desc';
}

/**
 * Jump straight to a page.
 *
 * Registered against BOTH the Go button and the input's `change`, so Enter and
 * blur work without a new primitive. An EMPTY box is a silent no-op, and that
 * is not tidiness: clicking Go blurs the input first, which fires `change`,
 * which jumps and clears the value — and then the button's own click arrives at
 * an empty box. Without the no-op the operator would type 47, land on page 47,
 * and be told they had not entered a page number.
 */
export function _logsGoToPage(){
  const input=document.getElementById('logs-page-input');
  const note=document.getElementById('logs-page-jump-note');
  if(!input)return;
  // The shared rules (strict parse, an exact count, an over-range page clamped
  // and said), bounded by the pager's state, never by a DOM attribute: a silent
  // poll can land a newer body without re-rendering the bar.
  const r=segmentGoTo(S._logsPager,input.value);
  if(note)note.textContent=r.note;
  if(r.clear)input.value='';
  if(r.to!=null)loadAdminLogs({page:r.to});
}

/**
 * Keep the page-jump group in step with the newest response.
 *
 * Called from loadAdminLogs the moment the body lands — BEFORE the silent-poll
 * short-circuit, which returns early when the rows are byte-identical and would
 * otherwise leave the controls describing a response two ticks old. If a poll
 * flipped the total from exact to a floor, an enabled Go button would clamp
 * against a number the server has withdrawn.
 *
 * It never writes `input.value`. The render owns the bounds and the note; the
 * OPERATOR owns the value. Writing it here would reintroduce the whole
 * swallowed-keystroke defect through the property path instead of the markup
 * path — which is exactly the mutation the regression lock fails on.
 */
export function _logsSyncPaging(res){
  // The reason must be VISIBLE text, not only a title: a disabled input is not
  // focusable, so aria-describedby is never announced and a tooltip is
  // unreachable by keyboard. Gate the affordance and the explanation together.
  // The count the pager holds is page 1's (a later Audit-log read answers none),
  // so the reason is the one that read gave.
  const why=S._logsPager.countReason||(res&&res.truncated_reason);
  syncPageJump(_LOGS_JUMP,segmentExact(S._logsPager),
    why==='scan_budget'?'Too many matches to count exactly — narrow the search.'
      :why==='count_cap'?'Only the first 10,000 entries are counted — search or pick a group for an exact count.'
        :'Search or pick a group to get an exact count.');
}

/** Both failure paths land here: the pager must stop describing a table that failed to load. */
export function _logsDisablePaging(){
  const jump=document.getElementById('logs-page-jump');
  const input=document.getElementById('logs-page-input');
  const note=document.getElementById('logs-page-jump-note');
  if(jump)jump.hidden=false;   // the explanation must not be written into a hidden subtree
  if(input)input.disabled=true;
  const btn=jump&&jump.querySelector('button[data-action="logs-page-goto"]');
  if(btn)btn.disabled=true;
  if(note)note.textContent='Paging unavailable — the last load failed.';
}

export function openAdminLogs(){
  const srch=document.getElementById('logs-search');if(srch){srch.value=S._logsQuery;toggleSearchClear(srch);}
  document.querySelectorAll('#admin-logs-tab [data-action="logs-set-stream"]').forEach(b=>b.classList.toggle('active',b.dataset.stream===S._logsStream));
  // Populate the group filter dropdown (preserves the current selection).
  // v8.3.20 — through the helper, which already guarantees an array or null.
  // A failed load leaves the dropdown at its previous contents rather than
  // rendering an error payload; the log itself still loads below.
  // RBAC — the group list is a `groups.view` read: a role reading the logs
  // without it gets no Group filter and sends no read the gate refuses.
  { const gsel=document.getElementById('logs-group-filter'); const glab=gsel&&gsel.closest('label');
    if(glab)glab.style.display=adminCan('groups.view')?'inline-flex':'none'; }   // its inline display beats [hidden]
  if(adminCan('groups.view'))fetchJsonList('/api/admin/groups').then(groups=>{
    const sel=document.getElementById('logs-group-filter');
    if(!sel||!Array.isArray(groups))return;
    setSafeHtml(sel,`<option value="">All</option>`+groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join(''));
    sel.value=S._logsGroupFilter;
  }).catch(e=>console.warn('Logs: group filter failed to load',e));
  _logsFirstPage();   // page 1 reads live; its anchor is pinned from the answer
  startAdminLogsAutoRefresh();
}

export function startAdminLogsAutoRefresh(){
  stopAdminLogsAutoRefresh();
  S._logsAutoRefreshHandle=setInterval(()=>{
    // Four guards keep the poll from firing in the wrong context:
    //   • only page 1 (deeper pages are ts-anchored and intentionally frozen;
    //     new rows surface when the admin returns to page 1),
    //   • sub-pane is visible,
    //   • outer admin page is visible (the sub-pane keeps display:block when
    //     the admin toggles to participant view; without this we'd POST
    //     /api/admin/logs under a non-admin session and log 403s),
    //   • session still holds admin privileges.
    if(S._logsPager.page!==1)return;
    // …nor while a load the operator asked for is still on its way.
    if(S._logsMove)return;
    // v7.25.0 — a fifth guard: a RANKED view is not a live feed. Under a
    // non-default sort "fresh" has no position (a new info line can appear
    // anywhere in a severity ranking, or nowhere), so re-ranking under a reader
    // who is scanning is disorienting for no benefit — and when the server is
    // ranking the whole filtered set it is also a walk to exhaustion every 15
    // seconds, per admin, in a single-process server. The pause is announced on
    // screen rather than being silent.
    if(!_logsSortIsDefault())return;
    if(!S.isAdmin)return;
    if(document.getElementById('admin-page')?.style.display==='none')return;
    if(document.getElementById('admin-logs-tab')?.style.display!=='block')return;
    loadAdminLogs({silent:true});
  },15000);
}

export function stopAdminLogsAutoRefresh(){
  if(S._logsAutoRefreshHandle){clearInterval(S._logsAutoRefreshHandle);S._logsAutoRefreshHandle=null;}
}

// A load the operator asked for (a page move, a search, a sort) is in flight:
// the live refresh holds off until it lands, or a refresh fired meanwhile would
// supersede it (the pager moves only when an answer lands) and the move would
// appear to do nothing.
export async function loadAdminLogs(opts={}){
  if(opts.silent)return _loadAdminLogs(opts);
  const token={};
  S._logsMove=token;
  try{return await _loadAdminLogs(opts);}
  finally{if(S._logsMove===token)S._logsMove=null;}
}

async function _loadAdminLogs(opts){
  // v7.21.15 — stale-response guard. This loader is fired by a 250 ms debounced
  // search, a group filter, a page-size change, four pager buttons AND a 15 s
  // silent poll, so several requests in flight at once is the normal case, not a
  // race condition. Without a sequence the network decides which one renders —
  // and a stale PAGE-1 reply also re-pins the pager's anchor, which is the very
  // drift protection the anchor exists to provide.
  // The page to load (`opts.page`, else the one on screen), at the position the
  // shared pager names for it: nothing (page 1, read live), the anchor pinned
  // from page 1 plus an offset, or a cursor Next was answered with.
  const st=S._logsPager;
  const pageN=Number.isInteger(opts.page)&&opts.page>0?opts.page:st.page;
  const at=segmentParams(st,pageN);
  if(!at)return;
  const mySeq=++S._logsFetchSeq;
  const url=new URL('/api/admin/logs',location.origin);
  url.searchParams.set('stream',S._logsStream);
  url.searchParams.set('limit',String(st.pageSize));
  if(S._logsQuery)url.searchParams.set('q',S._logsQuery);
  if(S._logsGroupFilter)url.searchParams.set('groupId',S._logsGroupFilter);
  // v7.25.0 — send the ordering UNCONDITIONALLY and let the server decide what
  // it can honour. Sending it only when the client believes a filter is applied
  // would make the client mirror the server's filter predicate, and a drifted
  // mirror here produces a plausible NOTE rather than an error — the worst way
  // for it to be wrong. The server echoes back what it actually did.
  if(!_logsSortIsDefault()){
    url.searchParams.set('sort',S._logsSortCol);
    url.searchParams.set('dir',S._logsSortDir);
  }
  // v7.0.2: timestamp-anchored pagination. Page 1 sends no anchor and reads
  // the live newest-first window, so new events stay visible there (and via
  // the 15s page-1 auto-refresh). Later pages are read from page 1's head ts
  // (or a cursor below an earlier page), so the window can't shift as the log
  // keeps growing.
  url.searchParams.set('offset','0');
  for(const [k,v] of Object.entries(at))url.searchParams.set(k,v);
  if(!opts.silent)showSkeletonRows('logs-body',5);
  // audit v7.7.36 (P7) — snapshot the currently-rendered rows so a silent poll
  // tick can skip the rebuild when nothing changed (see below).
  const prevEntriesJson=opts.silent?JSON.stringify((S._logsLastResponse&&S._logsLastResponse.entries)||[]):null;
  try{
    const r=await fetch(url.toString());
    // v7.23.5 (audit Wave 5) — whoever writes skeletons owns clearing them.
    // Both failure paths toasted and returned, which left the 5 skeleton rows
    // written above shimmering for ever: MEASURED 5 still animating after a 500.
    // The toast is transient and the table is what the admin is looking at, so
    // the table has to carry the answer. Logs DOES poll every 15 s, so no Retry
    // button — it self-heals; the message just has to stop lying in the meantime.
    if(!r.ok){
      if(mySeq!==S._logsFetchSeq)return;
      const d=await r.json().catch(()=>({}));
      // A position the server no longer honours (its file rotated away or was
      // pruned): say so and start again from the first page.
      if(r.status===400&&d.code==='logs_cursor_invalid'){showToast(d.error||'That page is no longer available. Showing the first page.','error');_logsFirstPage();return;}
      renderLoadFailure('logs-body',{colspan:colspanFor('logs-body'),noun:'logs'});
      _logsDisablePaging();
      showToast(d.error||'Failed to load logs.','error');
      return;
    }
    const body=await r.json();
    if(mySeq!==S._logsFetchSeq)return;   // a newer load already landed
    S._logsLastResponse=body;
    S._logsSortedGlobally=body.sorted_globally===true;
    // Absent means false, so an older server can never make the client claim a
    // ranking that did not happen.
    S._logsSortableGlobally=body.sortable_globally===true;
    // The answer moves the pager (page 1 pins the anchor and starts the list
    // over; a later read keeps it — re-pinning on every page would re-introduce
    // the drift the anchor exists to prevent), BEFORE the identical-entries
    // short-circuit below — see _logsSyncPaging.
    segmentAbsorb(st,pageN,{
      total:body.total==null?null:body.total,
      totalExact:body.total_exact!==undefined?!!body.total_exact:!body.truncated,
      anchor:body.anchor_ts||null,
      nextCursor:body.next_cursor,
      // An older server sends no has_more: more may exist while the count is
      // not exact, or while this page is short of the counted last.
      hasMore:typeof body.has_more==='boolean'?body.has_more:(body.total_exact===false||pageN<Math.ceil((body.total||0)/st.pageSize)),
      searchedTo:body.searched_to,
      offsetMax:body.offset_max,
    });
    if(body.total!=null)st.countReason=body.truncated_reason||null;
    _logsSyncPaging(body);
    // On a silent 15s poll, skip the thead/colgroup/tbody rebuild when the fetched
    // window is identical to what's already on screen. Pre-fix the tick replaced
    // the tbody even with zero new rows, wiping an admin's in-progress text
    // selection (e.g. drag-selecting an IP/error to copy). User-initiated loads
    // always render.
    if(opts.silent&&prevEntriesJson!==null&&JSON.stringify(body.entries||[])===prevEntriesJson)return;
  }catch(e){
    if(mySeq===S._logsFetchSeq){renderLoadFailure('logs-body',{colspan:colspanFor('logs-body'),noun:'logs'});_logsDisablePaging();}
    showToast('Network error loading logs.','error');
    return;
  }
  renderAdminLogs();
}

export function _logsColumns(){
  if(S._logsStream==='access'){
    return [
      {col:'ts', label:'Date & Time', width:'170px'},
      {col:'method', label:'Method', width:'80px'},
      {col:'path', label:'Path'},
      {col:'status', label:'Status', width:'80px'},
      {col:'ms', label:'ms', width:'70px'},
      {col:'user_first_name', label:'First', width:'120px'},
      {col:'user_last_name', label:'Last', width:'120px'},
      {col:'user_email', label:'Email', width:'240px'},
      {col:'user_groups', label:'Groups', width:'160px'},
      {col:'ip', label:'IP', width:'130px'},
    ];
  }
  return [
    {col:'ts', label:'Date & Time', width:'170px'},
    {col:'level', label:'Level', width:'80px'},
    {col:'msg', label:'Message'},
    {col:'user_first_name', label:'First', width:'120px'},
    {col:'user_last_name', label:'Last', width:'120px'},
    {col:'user_email', label:'Email', width:'240px'},
    {col:'user_groups', label:'Groups', width:'160px'},
    // "Actor" surfaces `changed_by` for admin-audit rows (scope=timeslot /
    // competition / settings) — pre-v6.2.7 the First/Last/Email columns only
    // populated for scope=user rows, leaving timeslot/competition edits with
    // no visible attribution even though the server always captured it.
    // v6.16.19 — when the server-side enrichment resolved the actor to a
    // real user row, render "First Last" with the email as the title /
    // hover; falls back to bare changed_by for sentinels (system, self,
    // import) and unmatched strings.
    {col:'changed_by', label:'Actor', width:'180px'},
    // v6.16.19 — `ip` surfaces top-level scanner-block / CSP-violation
    // / rate-limit warnings whose IP previously hid in the JSONL details.
    // Cell renders empty when the row is a generic admin-audit event.
    {col:'ip', label:'IP', width:'130px'},
  ];
}

export function _logUserIdForRow(r){
  if(!r)return null;
  if(r.user_id&&r.user_id!=='superadmin')return r.user_id;
  if(r.source==='audit'&&r.scope==='user'&&r.scope_id)return r.scope_id;
  return null;
}

// v7.16.7 — two real defects fixed here.
//
// (1) MIXED TYPES FELL BACK TO STRING COMPARE. The numeric branch required BOTH
//     values to be numbers, so a single row with a missing `status` or `ms`
//     (they are absent on plenty of log lines) sent the whole column down the
//     localeCompare path — where "9" sorts after "100". A column of durations
//     then reads as sorted while being nonsense.
// (2) `level` SORTED ALPHABETICALLY: debug, error, info, warn. That ordering is
//     meaningless for the one column an operator sorts to triage — they want
//     the errors, and alphabetical buries them between debug and info.
const _LOG_NUMERIC_COLS = new Set(["status", "ms", "bytes"]);
// Severity, worst first when descending.
const _LOG_LEVEL_RANK = { error: 4, warn: 3, info: 2, debug: 1 };

export function _sortLogRows(rows){
  const dir=S._logsSortDir==='asc'?1:-1;
  const col=S._logsSortCol;
  return rows.slice().sort((a,b)=>{
    if(col==='level'){
      const ra=_LOG_LEVEL_RANK[String(a?.level||'').toLowerCase()]??0;
      const rb=_LOG_LEVEL_RANK[String(b?.level||'').toLowerCase()]??0;
      if(ra!==rb)return (ra-rb)*dir;
      return 0;
    }
    if(_LOG_NUMERIC_COLS.has(col)){
      // Coerce BOTH sides. A missing value sorts last in either direction
      // rather than silently switching the whole column to text ordering.
      //
      // Test null/undefined/"" BEFORE Number(), because Number(null) is 0 and
      // Number("") is 0 — a row with no duration would otherwise sort as a
      // genuine zero and sit at the top of an ascending sort, which is a
      // different wrong answer from the one being fixed.
      const rawA=a?.[col], rawB=b?.[col];
      const naMissing=(rawA===null||rawA===undefined||rawA==="");
      const nbMissing=(rawB===null||rawB===undefined||rawB==="");
      const na=naMissing?NaN:Number(rawA), nb=nbMissing?NaN:Number(rawB);
      const aOk=Number.isFinite(na), bOk=Number.isFinite(nb);
      if(aOk&&bOk)return (na-nb)*dir;
      if(aOk!==bOk)return aOk?-1:1;
      return 0;
    }
    return String(a?.[col]??'').localeCompare(String(b?.[col]??''))*dir;
  });
}

export function renderAdminLogs(){
  const res=S._logsLastResponse||{entries:[],total:0,offset:0,limit:S._logsPager.pageSize,redacted:false};
  const cols=_logsColumns();
  setSafeHtml(document.getElementById('logs-colgroup'),cols.map(c=>`<col${c.width?` style="width:${esc(c.width)}"`:''}/>`).join(''));
  // The header row is rebuilt below (its arrows and columns follow the sort and
  // the stream), which would drop keyboard focus on a heading or its menu
  // button to the page: note which one held it, and focus its twin after.
  const thead=document.getElementById('logs-thead');
  const ae=document.activeElement;
  const focusTh=thead&&ae&&thead.contains(ae)?ae.closest('th[data-col]'):null;
  const focusCol=focusTh?focusTh.dataset.col:null;
  const focusMenu=!!(focusTh&&ae.closest('.tcol-hbtn'));
  // Sort arrows match every other admin sortable header: trailing ▲ / ▼ inside
  // a span#sort-logs-<col>-icon (id convention shared with sort-sub-*, sort-*).
  // tabindex inline: the sortable-heading tagger runs a microtask too late for
  // the focus restore below.
  setSafeHtml(thead,`<tr>${cols.map(c=>{
    const active=S._logsSortCol===c.col;
    const arrow=active?(S._logsSortDir==='asc'?' ▲':' ▼'):'';
    // audit v7.7.33 (AL10) — aria-sort inline (the logs thead is rebuilt each render).
    const ariaSort=active?(S._logsSortDir==='asc'?'ascending':'descending'):'none';
    return `<th scope="col" class="sortable" tabindex="0" aria-sort="${ariaSort}" data-action="logs-sort" data-col="${esc(c.col)}">${esc(c.label)}<span id="sort-logs-${esc(c.col)}-icon">${arrow}</span></th>`;
  }).join('')}</tr>`);

  // v7.25.0 — when the server ranked the whole filtered set, re-sorting the
  // page here would at best be a no-op and at worst visibly reshuffle rows that
  // were SELECTED by the server's ordering against a comparator that can only
  // see fifty of them.
  const rows=S._logsSortedGlobally?(res.entries||[]):_sortLogRows(res.entries||[]);
  if(!rows.length){
    const hasFilter=!!S._logsQuery;
    // A walk the scan budget cut says how far back it searched; Next goes on.
    const emptyMsg=S._logsPager.searchedTo
      ? `No log entries match back to ${esc(fmtDt(S._logsPager.searchedTo,'long'))}. Next searches further back.`
      : hasFilter?'No log entries match the current search.':'No log entries yet.';
    setSafeHtml(document.getElementById('logs-body'),`<tr><td colspan="${cols.length}" class="log-cell-empty-center">${emptyMsg}</td></tr>`);
  }else{
    setSafeHtml(document.getElementById('logs-body'),rows.map(r=>{
      // v6.2.8 / v6.16.19: build a tooltip carrying every structured field
      // on the row (audit details + raw warn/error structured props like
      // `ip`, `count4xx`, `block_ms`). Pre-v6.16.19 only audit-mirror rows
      // got a tooltip — top-level warn lines like "Scanner detected — IP
      // blocked" left the IP in the JSONL but invisible in the UI.
      // Render-time exclusion list: fields the table already columns,
      // plus pino metadata (`ts`, `level`, `msg`).
      const _excluded = new Set([
        'ts','level','msg','source','scope','scope_id','event_type',
        'user_id','user_email','user_first_name','user_last_name',
        'changed_by','actor','actor_email','actor_first_name','actor_last_name',
        'method','path','status','ms','ip','user_agent','bytes',
        'session_id','req_id','first_name','last_name','email','details',
      ]);
      const tipObj = {};
      // Audit details (the v6.2.8 case — competition_name, task_title etc.)
      if (r.source==='audit' && r.details && typeof r.details==='object') {
        Object.assign(tipObj, r.details);
      }
      // Top-level structured fields not already in a column.
      for (const k in r) {
        if (_excluded.has(k)) continue;
        const v = r[k];
        if (v == null) continue;
        if (typeof v === 'object') tipObj[k] = v;
        else tipObj[k] = v;
      }
      const detailsTip = Object.keys(tipObj).length
        ? JSON.stringify(tipObj, null, 2)
        : null;
      return '<tr>'+cols.map(c=>{
        if(c.col==='user_email'){
          let v=r.user_email;
          if(!v&&r.user_id==='superadmin')v='superadmin';
          if(!v)return '<td class="log-cell-empty">—</td>';
          const gid=_logUserIdForRow(r);
          return `<td class="log-cell-text"${gid?` title="user_id: ${esc(gid)}"`:''}>${esc(v)}</td>`;
        }
        if(c.col==='changed_by'){
          // v6.16.19 — Actor column reads the server-side-resolved
          // actor_first_name / actor_last_name when the row was a real
          // user; falls back to bare changed_by for sentinels and
          // unresolvable values. Email goes into the cell title so
          // hovering shows the address without bloating the column.
          const cb = r.changed_by;
          if (!cb) return '<td class="log-cell-empty">—</td>';
          const fn = r.actor_first_name, ln = r.actor_last_name, em = r.actor_email;
          if (fn || ln) {
            const name = [fn, ln].filter(Boolean).join(' ').trim() || em || cb;
            const tip = em ? `${em}` : '';
            return `<td class="log-cell-text"${tip?` title="${esc(tip)}"`:''}>${esc(name)}</td>`;
          }
          // Sentinel or unresolved: render bare value, lightly muted so
          // the eye distinguishes "system" / "self" from a real human.
          const isSentinel = !cb.includes('@') && cb.length < 20;
          return `<td class="log-cell-text${isSentinel?' log-cell-empty':''}">${esc(cb)}</td>`;
        }
        let v=r[c.col];
        if(c.col==='ts'&&v){try{v=fmtDt(v,'full');}catch(e){console.warn('Unreadable log timestamp',e);}}
        if(c.col==='ts')return `<td class="log-cell-ts">${esc(v||'')}</td>`;
        if(c.col==='level'&&v){
          // log-level-{error,warn,debug,info} — see styles.css for the
          // token map. Keeps the WCAG-passing light-theme palette
          // centralised; a single stylesheet tweak retints everywhere.
          // The inner .log-pill span renders the level as a soft-tint
          // pill chip (same pattern as `.sub-event-pill` in
          // admin-submissions); the outer cell class is preserved so
          // sort / filter selectors still resolve.
          const variant=v==='error'?'error':v==='warn'?'warn':v==='debug'?'debug':'info';
          return `<td class="log-level log-level-${variant}"><span class="log-pill">${esc(v)}</span></td>`;
        }
        if(c.col==='status'&&typeof v==='number'){
          const bucket=v>=500?'5xx':v>=400?'4xx':v>=300?'3xx':'2xx';
          return `<td class="log-status-code log-status-code-${bucket}"><span class="log-pill">${esc(String(v))}</span></td>`;
        }
        if(c.col==='ip'){
          // v6.16.19 — surface the IP for any row that carries one.
          // Security-audit rows (scanner_blocked) put the IP in scope_id
          // because the row pre-dates the structured field convention;
          // fall back to that when the top-level `ip` is absent.
          let ipVal = r.ip;
          if (!ipVal && r.source==='audit' && r.scope==='security' && r.scope_id) ipVal = r.scope_id;
          if (!ipVal) return '<td class="log-cell-empty">—</td>';
          return `<td class="log-cell-text">${esc(String(ipVal))}</td>`;
        }
        if(c.col==='user_groups'){
          const gs=Array.isArray(r.user_groups)?r.user_groups:[];
          if(!gs.length)return '<td class="log-cell-empty">—</td>';
          return `<td class="log-cell-text">${gs.map(n=>`<span class="group-tag">${esc(n)}</span>`).join(' ')}</td>`;
        }
        if(c.col==='msg'&&detailsTip){
          // audit v7.7.33 (AL14) — the structured detail payload was reachable
          // ONLY via the title-tooltip (mouse/long-press): a non-focusable <td>
          // title is invisible to keyboard + screen-reader users. Add a focusable
          // "details" button that opens the payload in the shared modal; keep the
          // title as a mouse shortcut.
          return `<td class="log-cell-msg-tip" title="${esc(detailsTip)}">${esc(String(v||''))} <button type="button" class="log-details-btn" data-action="log-details" data-details="${esc(detailsTip)}" aria-label="Details — show this log entry in full" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:0 6px;cursor:pointer;color:var(--muted);font-size:var(--fs-12);line-height:1.6;vertical-align:middle">details</button></td>`;
        }
        if(v==null||v==='')return '<td class="log-cell-empty">—</td>';
        return `<td class="log-cell-text">${esc(String(v))}</td>`;
      }).join('')+'</tr>';
    }).join(''));
  }
  if(focusCol){
    // Decorate the new header row now (its menu buttons arrive on a microtask
    // otherwise), then return focus to the same heading or menu button.
    syncTable(thead.closest('table'));
    const th=thead.querySelector(`th[data-col="${CSS.escape(focusCol)}"]`);
    const target=focusMenu?th&&th.querySelector('.tcol-hbtn'):th;
    if(target)target.focus({preventScroll:true});
  }

  // Multi-file hint: since v6.2.2 the server walks every rotated log file
  // newest-first when no explicit `date` is specified, so a scrolling
  // admin can page seamlessly backwards across days. Extract the date
  // range from the `files_scanned` filenames (`{stream}-{YYYY-MM-DD}.jsonl`
  // or overflow-rotated `{stream}-{YYYY-MM-DD}-HH-MM-SS.jsonl`) so the
  // operator sees which days contributed to the current page.
  const hint=document.getElementById('logs-range-hint');
  if(hint){
    const fs=res.files_scanned||[];
    if(fs.length){
      const dates=new Set();
      for(const fn of fs){
        const m=fn.match(/^(?:app|access)-(\d{4}-\d{2}-\d{2})/);
        if(m)dates.add(m[1]);
      }
      const sorted=[...dates].sort();
      if(sorted.length===1)hint.textContent=`Showing entries from ${sorted[0]}`;
      else if(sorted.length>1)hint.textContent=`Showing entries from ${sorted[0]} to ${sorted[sorted.length-1]} (${sorted.length} day${sorted.length===1?'':'s'})`;
      else hint.textContent='';
    }else{
      // Only show "no matches" when a search is active. Without a search,
      // an empty result set means there are simply no entries on disk yet
      // — the blank table + "No log entries yet." row is the right signal.
      hint.textContent=S._logsQuery?'No entries match the current search.':'';
    }
    // A walk the scan budget cut: say how far back it searched (Next goes on).
    if(S._logsPager.searchedTo){
      hint.textContent=(hint.textContent?hint.textContent+' — ':'')+`searched back to ${fmtDt(S._logsPager.searchedTo,'long')}`;
    }
    // v7.25.0 — the 15-second refresh is suspended while a non-default sort is
    // active (see startAdminLogsAutoRefresh). A pane that silently stops
    // updating is its own wrong answer, so say so where the operator is already
    // reading about what is in view.
    if(!_logsSortIsDefault()){
      hint.textContent=(hint.textContent?hint.textContent+' — ':'')+'Live updates paused while sorted.';
    }
  }
  // Pagination: the shared segment pager's bar (Last needs a real total, not
  // merely "more may exist"). The count is the pager's, page 1's on the Audit
  // log (a later read answers none). Exactness is `total_exact`, NOT
  // `!truncated`: `since` reaching a row older than the bound is a CLEAN stop
  // over an exact count.
  const st=S._logsPager;
  // v7.20.10 — the count beside the search box. It must be driven by the SAME
  // signal as the pager, or the two elements answer the same question
  // differently on one screen.
  setListCount('logs-search',{matched:st.total??0,total:null,filtered:!!(S._logsQuery||'').trim(),approximate:!segmentExact(st)});
  const o=segmentBarOptions(st);
  setSafeHtml(document.getElementById('logs-pagination-bar'),paginationHtml('logs',{
    page:o.page,totalPages:o.totalPages,pagesLabel:o.pagesLabel,totalLabel:o.totalLabel,
    hasPrev:o.hasPrev,hasNext:o.hasNext,lastEnabled:o.lastEnabled,
    pageSize:st.pageSize,
    sizes:[50,100,200,500],
    jump10:true,
    extra:_logsSortNote(res),
  }));
  _logsSyncPaging(res);
}

/**
 * What the pager says about the ordering — one sentence per state, and each one
 * has to be true.
 *
 * The old condition was `S._logsSortCol !== "ts"`, which is direction-blind: an
 * ASCENDING click on Date & Time is page-scoped too, and said nothing at all —
 * on precisely the gesture the operator makes to reach the oldest rows.
 */
export function _logsSortNote(res){
  if(_logsSortIsDefault())return '';
  const st=S._logsPager;
  const totalPages=Math.max(1,Math.ceil((st.total||0)/st.pageSize));
  const exact=segmentExact(st);
  // On a single page "within this page" is a false alarm and the positive note
  // is noise.
  if(totalPages<=1&&exact)return '';
  if(S._logsSortedGlobally){
    return `<span class="page-scope-ok" title="The server ranked every entry matching the current filter, not just this page.">Sorted across all matches</span>`;
  }
  if(res.sort_unavailable==='scan_budget'){
    return `<span class="page-scope-warn" title="The search matched more entries than the server can read in one pass, so only the entries on this page were reordered. Narrow the search to rank every match.">Sorted within this page — too many matches to rank</span>`;
  }
  if(res.sort_unavailable==='window_too_deep'){
    return `<span class="page-scope-warn" title="Ranking every match is only offered for the first pages of a result set. Narrow the search, or use a smaller page size, to rank every match.">Sorted within this page — too deep to rank</span>`;
  }
  if(res.sort_unavailable==='cursor'){
    return `<span class="page-scope-warn" title="Pages after the first are read by their place in the log, so only the entries on this page were reordered. Go back to the first page to rank every match.">Sorted within this page — go to the first page to rank every match</span>`;
  }
  if(res.sort_unavailable==='busy'){
    return `<span class="page-scope-warn" title="Another ranked search is running. Try again in a moment to rank every match.">Sorted within this page — try again shortly</span>`;
  }
  // Either unfiltered, or a column the server cannot rank without building a
  // whole-directory lookup (the name / email / groups columns). Name the
  // remedy that exists rather than only the mechanism.
  return `<span class="page-scope-note" title="The log is walked newest-first from disk, so other pages are not re-ranked. Search or pick a group to rank every match.">Sorted within this page</span>`;
}

export async function loadAdminSettings(){
  // v8.12.7 (review) — EVERY entry to the Settings tab passes through here, and
  // this line runs synchronously inside the click that entered it. So the
  // removals card's focus request is armed for exactly the load a "Review
  // removals" click dispatched, and cleared by any other entry: before, a
  // request left armed by a load that FAILED fired on the admin's next ordinary
  // visit, dragging them down to a card they had not asked for.
  _wdFocusPending=_wdReviewEntry;
  // The certificate design card loads on its own (it has its own route and
  // failure state), so a Settings read failure does not hide it.
  loadPlatformCertificateCard();
  // EACH CARD FOLLOWS ITS ROUTES' PERMISSIONS (ui/nav.js
  // SETTINGS_CARD_PERMISSIONS; operator ruling, 14 Nov 2026). A role that may
  // not read the platform settings (a custom role holding only
  // certificates.design, or only an operations permission) never asks for them
  // — the read would 403 and paint a load failure over the cards it may use —
  // so its cards with routes of their own load at once.
  if(!adminCan('settings.view')){
    for(const id of _SETTINGS_READ_CARDS){ const el=document.getElementById(id); if(el)el.style.display='none'; }
    renderPlatformLookCard(null);
    _loadOwnRouteCards();
    document.dispatchEvent(new CustomEvent('admin:settings-loaded'));
    syncSettingsNav();
    return;
  }
  // v8.3.20 — a 500's error body is `{error:"…"}`, i.e. TRUTHY, so the `!d`
  // guard below never fired on the failure it was written for and the pane was
  // populated from an error payload. fetchJsonObject returns null on any
  // non-ok, so the truthiness test is finally the right test.
  const d=await fetchJsonObject('/api/admin/settings');
  if(!d){
    // v8.3.33 — A LOADER THAT FAILS SAYS SO, IN ITS OWN PANE. This was the only
    // pane loader in the SPA whose failure signal was a toast alone (every
    // sibling renders into its container — analytics-admin.js:154 was fixed for
    // exactly this in v8.3.20, and loadUnsubscribeList does it twelve lines
    // below). Worse than blank: leaving the cards standing renders the CxOne
    // card's "Not configured" shape over a config we failed to READ, and
    // saveCxOneSettings posts cxone_group_name unconditionally into a handler
    // that writes any non-null value — so a superadmin who pastes a key and
    // saves would silently clear the configured group. Hide the stale forms,
    // then say what happened and offer the retry (one caller, no poll, which is
    // renderLoadFailure's own criterion for offering one).
    for(const id of [..._SETTINGS_READ_CARDS,..._OWN_ROUTE_CARDS,'platform-look-card']){
      const el=document.getElementById(id); if(el)el.style.display='none';
    }
    // The card the Review asked for is hidden with the rest, so the request has
    // nothing to land on; the Retry below is an ordinary load, not a Review.
    _wdFocusPending=false;
    const fail=document.getElementById('settings-load-failure');
    if(fail)fail.style.display='';
    renderLoadFailure('settings-load-failure',{noun:'settings',retryAction:'retry-load-settings'});
    showToast('Could not load settings. Check your connection and try again.','error');
    return;
  }
  const _fail=document.getElementById('settings-load-failure');
  if(_fail){_fail.style.display='none';setSafeHtml(_fail,'');}
  document.getElementById('settings-platform-name').value=d.platform_name||d.competition_name||'';
  { const ra=document.getElementById('settings-require-approval'); if(ra)ra.checked=d.require_account_approval===true; }
  renderPlatformLookCard(d.platform_look);   // gated inside (settingsCardOffered)
  // Each card that shows a value from this read carries its own gate, none
  // relying on a sibling or on the nav item (the platform name is the outbound
  // sender name; the Checkmarx One key is a tenant credential).
  for(const id of _SETTINGS_READ_CARDS){ const el=document.getElementById(id); if(el)el.style.display=settingsCardOffered(id)?'':'none'; }
  if(settingsCardOffered('cxone-card'))loadCxOneSettings(d);
  // The cards with routes of their own load after this read, as every card
  // does for a role holding settings.view, so a failed read (above) hides them
  // all behind the one failure and its Retry.
  _loadOwnRouteCards();
  loadBreakglassCard();
  // Cards owned by other modules (event-team.js: the allowed team-report domains)
  // load on this signal, so this module imports none of them.
  document.dispatchEvent(new CustomEvent('admin:settings-loaded'));
  syncSettingsNav();
}

// ─── The two-pane shell ───────────────────────────────────────────────────────
//
// The section list is DERIVED FROM THE MARKUP (`.settings-section` elements, in
// order, each with `data-settings-section` + `data-settings-label`): a section
// is listed while it holds a `.settings-card` that is not display:none, so the
// card loaders' own show/hide decides what is offered and a card another module
// adds to a section needs no list edit. A card dropped straight into
// `.settings-bento` is adopted into the section its `data-settings-section`
// names, else General. The CHOSEN section is a preference (remembered per
// browser): while it has nothing to show the first listed one is shown, and it
// comes back the moment its card appears (the break-glass card loads late).

// The cards that show values from GET /api/admin/settings (the look card is
// filled by features/look-admin.js), and the cards with routes of their own,
// each loaded by its own loader. Every one is gated by SETTINGS_CARD_PERMISSIONS
// (ui/nav.js). Hoisted: function bodies read them at call time.
const _SETTINGS_READ_CARDS=['platform-name-card','account-approval-card','cxone-card'];
const _OWN_ROUTE_CARDS=['smtp-settings-card','email-test-card','unsubscribe-card','cxone-withdrawals-card','retention-card','alerts-card','system-health-card','cxone-audit-card','release-notes-card'];
function _loadOwnRouteCards(){
  for(const id of _OWN_ROUTE_CARDS){
    const el=document.getElementById(id);
    if(el&&!settingsCardOffered(id))el.style.display='none';
  }
  if(!settingsCardOffered('cxone-withdrawals-card'))_wdFocusPending=false;
  if(settingsCardOffered('smtp-settings-card')){ document.getElementById('smtp-settings-card').style.display=''; loadSmtpCard(); }
  // Outbound email (its relay status and test send) only for a role that cannot
  // read the Mail server card, which carries both for everyone else: one test
  // send and one relay status on the page (owner decision, 27 Nov 2026).
  if(settingsCardOffered('email-test-card')&&!settingsCardOffered('smtp-settings-card')){ document.getElementById('email-test-card').style.display=''; loadEmailCard(); }
  else { const c=document.getElementById('email-test-card'); if(c)c.style.display='none'; }
  if(settingsCardOffered('unsubscribe-card')){ document.getElementById('unsubscribe-card').style.display=''; loadUnsubscribeList(); }
  if(settingsCardOffered('retention-card')){ document.getElementById('retention-card').style.display=''; loadRetentionCard(); }
  if(settingsCardOffered('alerts-card')){ document.getElementById('alerts-card').style.display=''; loadAlertsCard(); }
  if(settingsCardOffered('system-health-card')){ document.getElementById('system-health-card').style.display=''; loadSystemHealthCard(); }
  if(settingsCardOffered('cxone-audit-card')){ document.getElementById('cxone-audit-card').style.display=''; loadCxoneAuditCard(1); }
  loadReleaseNotesCard();   // admins only (releaseNotesVisible), as the document is
  loadCxoneWithdrawals();   // shows itself only while Checkmarx One is in use or a removal is listed
}

// ─── About & health ──────────────────────────────────────────────────────────
//
// "This server": every figure from GET /api/admin/system-health (settings.view):
// what is running (version, build commit and time, release channel), how long
// it has run, whether its database passed its checks, the mail relay's last
// check, free disk, the backups the app can see, and how long history is kept.
// A superadmin also gets the database size, the Node.js version, when the server
// started and the newest backup's size. Nothing here is typed in the client.
let _healthSeq=0;
// The mail relay is null until its first probe (never under test); the boot's
// database checks run before the server listens, so they are always booleans.
const _yesNo=(ok,yes,no)=>ok===true?yes:ok===false?no:'Not checked yet';
function _uptimeText(sec){
  const up=Number(sec)||0;
  return up>=86400?`${Math.floor(up/86400)} d ${Math.floor(up%86400/3600)} h`:up>=3600?`${Math.floor(up/3600)} h ${Math.floor(up%3600/60)} min`:`${Math.floor(up/60)} min`;
}
function _backupRows(b,su){
  if(!b||b.visible!==true){
    return [['Backups',b&&b.reason==='unreadable'
      ?'The backups folder is mounted but cannot be read by the app.'
      :'Not visible to the app. The server’s operator mounts the backups folder read-only and names it in BACKUP_DIR (the Podman installer does).']];
  }
  if(!b.count)return [['Backups','None yet in the backups folder']];
  const rows=[['Backups',`${b.count} in the backups folder`],
    ['Newest backup',`${b.newest_at?fmtDt(b.newest_at,'long'):'Unknown time'}${b.newest_complete===true?'':b.newest_complete===false?' — not finished (no BACKUP_COMPLETE)':' — cannot be looked into'}`]];
  if(su&&'newest_size_mib' in b)rows.push(['Newest backup size',typeof b.newest_size_mib==='number'?`${b.newest_size_exact===false?'At least ':''}${b.newest_size_mib} MiB`:'Could not be read']);
  return rows;
}
/** This server: GET /api/admin/system-health (settings.view). */
export async function loadSystemHealthCard(){
  const body=document.getElementById('system-health-body');
  if(!body)return;
  const seq=++_healthSeq;
  const d=await fetchJsonObject('/api/admin/system-health');
  if(seq!==_healthSeq)return;
  if(!d){ renderLoadFailure('system-health-body',{noun:'the server’s details',retryAction:'settings-health-retry'}); return; }
  const gib=(n)=>typeof n==='number'?`${n} GiB free`:'Could not be read';
  const b=d.build||{};
  const su='database_size_mib' in d;
  const groups=[
    ['Running',[
      ['Version',String(d.version||'unknown')],
      ['Build',b.commit?`${String(b.commit).slice(0,12)}${b.built_at?`, built ${fmtDt(b.built_at,'long')}`:''}`:'Unknown (not a release image)'],
      ['Release channel',b.channel?String(b.channel):'Unknown (not a release image)'],
      ...(d.started_at?[['Server started',fmtDt(d.started_at,'long')]]:[]),
      ['Running for',_uptimeText(d.uptime_seconds)],
      ...(d.node_version?[['Node.js',String(d.node_version)]]:[]),
    ]],
    ['Health',[
      ['Database check',d.database_integrity_ok===true?'Passed at start-up':'Failed at start-up — restore from a backup'],
      ['Database tables',d.database_schema_ok===true?'Complete':'Incomplete — see the server log'],
      ...(su?[['Database size',typeof d.database_size_mib==='number'?`${d.database_size_mib} MiB (with its write-ahead log)`:'Could not be read']]:[]),
      ['Maintenance mode',d.maintenance===true?'On':'Off'],
      ['Mail relay',`${_yesNo(d.smtp_healthy,'Answering','Not answering')}${d.smtp_checked_at?` (checked ${fmtDt(d.smtp_checked_at,'long')})`:''}`],
    ]],
    ['Storage and backups',[
      ['Data volume',gib(d.data_free_gib)],
      ['Uploads volume',gib(d.uploads_free_gib)],
      ..._backupRows(d.backups,su),
      ['Event history kept',`${Number(d.event_retention_days)||0} days`],
    ]],
  ];
  setSafeHtml(body,groups.map(([title,rows])=>`<h4 class="settings-facts-title">${esc(title)}</h4><dl class="settings-facts-list">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`).join('')
    +'<p class="settings-hint">A server set up with the Podman installer checks daily for a new signed release on its channel and restarts on it, after backing up its database. Certificates are set in the open-source Inter and Noto typefaces (SIL Open Font License 1.1).</p>');
}

// Release notes: the newest version of docs/release-notes.md, rendered by
// the help drawer's own pipeline (the document is admins' only, as the drawer's
// door is: releaseNotesVisible); All release notes opens the drawer.
let _notesSeq=0;
const _NOTES_SHOWN=1;
export async function loadReleaseNotesCard(){
  const card=document.getElementById('release-notes-card');
  const body=document.getElementById('release-notes-body');
  if(!card||!body)return;
  if(!releaseNotesVisible()){ card.style.display='none'; return; }
  card.style.display='';
  const seq=++_notesSeq;
  let md=null;
  try{ const r=await fetch(RELEASE_NOTES_DOC); if(r.ok)md=await r.text(); }
  catch(e){ md=null; }
  if(seq!==_notesSeq)return;
  if(md===null){ renderLoadFailure('release-notes-body',{noun:'the release notes',retryAction:'settings-notes-retry'}); return; }
  // The newest versions only: each starts at a "## " heading.
  // Their headings move under the card's own (h3): a version is h4, its parts h5.
  const parts=md.split(/^(?=## )/m).filter(p=>/^## /.test(p)).slice(0,_NOTES_SHOWN)
    .map(p=>p.replace(/^### /gm,'##### ').replace(/^## /gm,'#### '));
  setSafeHtml(body,parts.length?renderDocMarkdown(parts.join('\n'),RELEASE_NOTES_DOC):'<p class="settings-help">No release notes yet.</p>');
}

// ─── CxOne API audit: every Checkmarx One call the platform made ─────────────
//
// The audit trail's own read (GET /api/admin/audit, audit.view), narrowed to the
// Checkmarx One activity by `event_type`, so each row is scoped exactly as the
// Audit page scopes it (a person's set-up as their History, a removal of a
// deleted participant as a logged event) and nothing is re-derived here. Paged
// by the shared segment pager (ui/list-controls.js), filtered and sorted on the
// page by the table component (PLAIN_TABLES['cxone-audit']). The activity keys
// are the Audit page's own Checkmarx One wording, less the settings change
// (`cxone_config_changed`, not a call to Checkmarx One).
export const CXONE_AUDIT_EVENT_TYPES=Object.freeze(Object.keys(AUDIT_ACTIVITY_LABELS).filter(k=>k.startsWith('cxone_')&&k!=='cxone_config_changed').sort());
const _cx={pager:newSegmentPager(30),seq:0};
function _cxResult(r){
  const d=r.details&&typeof r.details==='object'?r.details:{};
  if(r.event_type==='cxone_provisioned'){
    if(d.deferred)return 'Deferred';
    if(d.success===true){
      let t=d.already_existed===true?'Linked to an existing account':'Account created';
      if(typeof d.group_name==='string'&&d.group_name)t+=d.group_assigned===true?`, added to group ${d.group_name}`:`, not added to group ${d.group_name}`;
      return t;
    }
    return 'Failed';
  }
  return r.outcome==='success'?'Done':r.outcome==='failure'?'Failed':'Recorded';
}
function _cxDetail(r){
  const d=r.details&&typeof r.details==='object'?r.details:{};
  const bits=[];
  for(const k of ['error','deferred','held_reason','reason','code','matched_by','stopped']){
    if(typeof d[k]==='string'&&d[k])bits.push(k==='matched_by'?`matched by ${d[k]}`:d[k]);
  }
  if(d.retry_scheduled===true)bits.push(Number.isInteger(d.retry_attempt)?`retry ${d.retry_attempt} scheduled`:'retry scheduled');
  if(d.details_unreadable===true)bits.push('details could not be read');
  return bits.join('; ')||'—';
}
export async function loadCxoneAuditCard(pageN=1){
  const body=document.getElementById('cxone-audit-body');
  if(!body)return;
  const st=_cx.pager;
  const pos=segmentParams(st,pageN);
  if(pageN>1&&!pos)return;
  const seq=++_cx.seq;
  const qs=new URLSearchParams({event_type:CXONE_AUDIT_EVENT_TYPES.join(','),limit:String(st.pageSize),...(pos||{})});
  const d=await fetchJsonObject(`/api/admin/audit?${qs}`);
  if(seq!==_cx.seq)return;
  const bar=document.getElementById('cxone-audit-pagination-bar');
  if(!d||!Array.isArray(d.rows)){
    renderLoadFailure('cxone-audit-body',{noun:'the Checkmarx One activity',retryAction:'cxone-audit-retry',colspan:colspanFor('cxone-audit-body')});
    if(bar)setSafeHtml(bar,'');
    return;
  }
  segmentAbsorb(st,pageN,{total:d.total,totalExact:d.total_exact,anchor:d.anchor,nextCursor:d.next_cursor,hasMore:d.has_more,searchedTo:d.searched_to,offsetMax:d.offset_max});
  setSafeHtml(body,d.rows.length?d.rows.map(r=>{
    const who=r.subject&&r.subject.label?String(r.subject.label):r.subject&&r.subject.id?'Deleted participant':'—';
    return `<tr><td data-sort-value="${esc(String(r.at||''))}">${esc(r.at?fmtDt(r.at,'full'):'')}</td><td>${esc(auditActivityLabel(r.event_type,r.details))}</td><td>${esc(r.competition_name?String(r.competition_name):'—')}</td><td>${esc(who)}</td><td>${esc(_cxResult(r))}</td><td>${esc(_cxDetail(r))}</td></tr>`;
  }).join(''):`<tr><td colspan="${colspanFor('cxone-audit-body')}" class="table-empty-row">No Checkmarx One activity is recorded${pageN>1?' on this page.':' yet.'}</td></tr>`);
  const o=segmentBarOptions(st);
  if(bar)setSafeHtml(bar,paginationHtml('cxone-audit',{page:o.page,totalPages:o.totalPages,pagesLabel:o.pagesLabel,totalLabel:o.totalLabel,
    hasPrev:o.hasPrev,hasNext:o.hasNext,lastEnabled:o.lastEnabled,pageSize:st.pageSize}));
}
export function cxoneAuditPage(how){
  const st=_cx.pager;
  const to=how==='first'?1:how==='last'?segmentLastTarget(st):segmentStepTarget(st,how==='next'?1:-1);
  if(to)loadCxoneAuditCard(to);
}
export function cxoneAuditPageSize(v){
  const n=parseInt(v,10);
  if(!Number.isInteger(n)||n<1)return;
  _cx.pager=newSegmentPager(n);
  loadCxoneAuditCard(1);
}

const _SECTION_KEY='ha:settings-section';
const _DEFAULT_SECTION='general';
let _settingsPref=null;
let _settingsObserver=null;

function _readSectionPref(){
  if(_settingsPref)return _settingsPref;
  try{ _settingsPref=localStorage.getItem(_SECTION_KEY)||_DEFAULT_SECTION; }
  catch(_){ _settingsPref=_DEFAULT_SECTION; }
  return _settingsPref;
}

function _cardShown(card){ return card.style.display!=='none'; }

/** Move any card sitting outside a section into its named section (else General). */
function _adoptOrphanCards(){
  const bento=document.querySelector('#admin-settings-tab .settings-bento');
  if(!bento)return;
  for(const card of [...bento.children]){
    if(!card.classList||!card.classList.contains('settings-card')||card.id==='settings-load-failure')continue;
    const want=card.getAttribute('data-settings-section')||_DEFAULT_SECTION;
    const sec=bento.querySelector(`.settings-section[data-settings-section="${CSS.escape(want)}"]`)
      ||bento.querySelector(`.settings-section[data-settings-section="${_DEFAULT_SECTION}"]`);
    if(sec)sec.appendChild(card);
  }
}

/** The sections that currently have something to show, in markup order. */
export function settingsSections(){
  return [...document.querySelectorAll('#admin-settings-tab .settings-section[data-settings-section]')].map(sec=>({
    key:sec.getAttribute('data-settings-section'),
    label:sec.getAttribute('data-settings-label')||sec.getAttribute('data-settings-section'),
    group:sec.getAttribute('data-settings-group')||'system',
    el:sec,
    available:[...sec.querySelectorAll('.settings-card')].some(_cardShown),
  }));
}

// The list's group captions (each section's `data-settings-group`), in the
// order the markup first names them. The pages the sidebar opens (People,
// Teams, Roles & permissions, Audit, the guides) are the sidebar's, never
// repeated here (owner decision, 27 Nov 2026).
const _GROUP_LABELS={people:'People',records:'Records',system:'System'};

/** Every list item (a section), in markup order. */
function _navItems(){
  return settingsSections().map(s=>({kind:'section',...s}));
}

function _itemHtml(it){
  return `<li data-settings-item="${esc(it.key)}"><button type="button" class="settings-nav-item" data-action="settings-section" data-section="${esc(it.key)}">${esc(it.label)}</button></li>`;
}

/** Repaint the list, the phone picker and which section shows. Idempotent. */
export function syncSettingsNav(){
  const list=document.getElementById('settings-section-list');
  const pick=document.getElementById('settings-section-pick');
  if(!list||!pick)return;
  _adoptOrphanCards();
  const items=_navItems();
  const all=items.filter(i=>i.kind==='section');
  const avail=all.filter(s=>s.available);
  const pref=_readSectionPref();
  const shown=(avail.find(s=>s.key===pref)||avail[0]||null);
  const shownKey=shown?shown.key:null;
  for(const s of all){
    const hide=s.key!==shownKey;
    if(s.el.hidden!==hide)s.el.hidden=hide;
  }
  // The list holds one item per section in the MARKUP, grouped under
  // its caption, built only when that set changes; availability only toggles
  // each item's `hidden` (and a group's, when none of its items is listed).
  // Rebuilding on every card show/hide replaced the buttons while the loaders
  // were still landing, so a press arriving in that window hit a detached
  // button and did nothing.
  const groups=[];
  for(const it of items){
    let g=groups.find(x=>x.key===it.group);
    if(!g){ g={key:it.group,label:_GROUP_LABELS[it.group]||it.group,items:[]}; groups.push(g); }
    g.items.push(it);
  }
  const allSig=items.map(i=>`${i.kind}:${i.group}:${i.key}:${i.label}`).join('|');
  if(list.dataset.sig!==allSig){
    list.dataset.sig=allSig;
    setSafeHtml(list,groups.map(g=>{
      const cid=`settings-group-${g.key}`;
      return `<div class="settings-nav-group" data-settings-group="${esc(g.key)}"><h3 class="settings-nav-caption" id="${esc(cid)}">${esc(g.label)}</h3><ul class="settings-nav-items" aria-labelledby="${esc(cid)}">${g.items.map(_itemHtml).join('')}</ul></div>`;
    }).join(''));
  }
  for(const li of list.querySelectorAll('li[data-settings-item]')){
    const k=li.dataset.settingsItem;
    const it=items.find(i=>i.key===k);
    const hide=!(it&&it.available);
    if(li.hidden!==hide)li.hidden=hide;
  }
  for(const grp of list.querySelectorAll('.settings-nav-group')){
    const hide=!grp.querySelector('li[data-settings-item]:not([hidden])');
    if(grp.hidden!==hide)grp.hidden=hide;
  }
  // The phone picker: the same groups as <optgroup>s.
  const availItems=items.filter(i=>i.available);
  const availSig=availItems.map(i=>`${i.kind}:${i.group}:${i.key}`).join('|');
  if(pick.dataset.sig!==availSig){
    pick.dataset.sig=availSig;
    setSafeHtml(pick,groups.map(g=>{
      const opts=g.items.filter(i=>i.available).map(i=>`<option value="${esc(i.key)}">${esc(i.label)}</option>`).join('');
      return opts?`<optgroup label="${esc(g.label)}">${opts}</optgroup>`:'';
    }).join(''));
  }
  for(const b of list.querySelectorAll('.settings-nav-item[data-section]')){
    const cur=b.dataset.section===shownKey;
    if(cur){ if(b.getAttribute('aria-current')!=='true')b.setAttribute('aria-current','true'); }
    else if(b.hasAttribute('aria-current'))b.removeAttribute('aria-current');
  }
  if(shownKey&&pick.value!==shownKey)pick.value=shownKey;
}

/** The phone picker's change: a section. */
export function settingsPick(value){
  if(typeof value!=='string')return;
  selectSettingsSection(value);
}

/** Choose a section (a list press, the phone picker, or a deep link). */
export function selectSettingsSection(key,{focus=false}={}){
  if(typeof key!=='string'||!key)return;
  _settingsPref=key;
  try{ localStorage.setItem(_SECTION_KEY,key); }catch(_){ /* per-browser convenience only */ }
  syncSettingsNav();
  if(focus){
    const sec=document.querySelector(`#admin-settings-tab .settings-section[data-settings-section="${CSS.escape(key)}"]`);
    const h=sec&&!sec.hidden?sec.querySelector('.settings-heading'):null;
    if(h){ if(!h.hasAttribute('tabindex'))h.setAttribute('tabindex','-1'); h.focus(); }
  }
}

/** Open Settings on one section (the account menu's Account item, banners). */
export function openSettingsSection(key){
  selectSettingsSection(key);
  const btn=document.querySelector('[data-action="admin-tab"][data-tab-id="admin-settings-tab"]');
  if(btn)btn.click();
}

let _alertsListening=false;
/** Boot: the "?" texts, a watcher so card show/hide re-derives the list, and the Alerts card's refresh. */
export function installSettingsShell(){
  registerHelpTips(SETTINGS_HELP_TIPS);
  const bento=document.querySelector('#admin-settings-tab .settings-bento');
  if(bento&&!_settingsObserver&&typeof MutationObserver==='function'){
    // Card loaders show and hide cards through style.display; a card another
    // module renders arrives as a child. Both re-derive the list (idempotent, so
    // the section `hidden` writes it makes cannot loop: they are not watched).
    _settingsObserver=new MutationObserver(()=>syncSettingsNav());
    _settingsObserver.observe(bento,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
  }
  // An alert dismissed anywhere (its Review dialog here, or the notice the poll
  // raised) leaves the Alerts card's list: the card reads it again while shown,
  // so neither its row nor its count outlives the dismissal.
  if(!_alertsListening){
    _alertsListening=true;
    document.addEventListener('admin:alerts-changed',()=>{
      const card=document.getElementById('alerts-card');
      if(settingsCardOffered('alerts-card')&&card&&card.style.display!=='none')loadAlertsCard();
    });
  }
  syncSettingsNav();
}

export const SETTINGS_HELP_TIPS={
  'settings.platform-name':'Appears in the header and help, in every email subject, and as the sender name on all email. The sender address is set with the mail server, under Email (SMTP). Takes effect at once.',
  'settings.smtp':'Every email the platform sends goes through this server. Each value says whether it was set here in the app or comes from the server’s environment; settings saved here replace the environment’s as a whole. Send test email tries the server in use; Test with these values, in the form, tries values before they are saved. Only a superadmin can change the server, and the password is never shown.',
  'settings.approval':'A new account is created only after its first emailed code confirms the address. With this on, a new account waits for an administrator, except one made through the join link, QR code or event code of an open event. Invited people are always approved.',
  'settings.test-email':'Sends one plain message through the mail relay so you can see that email arrives and what the sender looks like. The relay status comes from the platform’s own check, run every few minutes.',
  'settings.unsubscribe':'Opt-outs cover invitations, reminders and assignment notices. Remove an address when its owner agrees to receive these again.',
  'settings.certificates':'Events use this design unless their organisers change it for one event. Saved changes apply the next time a certificate is downloaded.',
  'settings.cxone':'Events without their own Checkmarx One settings provision accounts with this key. Per-event overrides are set in the event’s settings.',
  'settings.cxone-key':'Paste the tenant API key. The tenant and its URLs are read from the key; the saved key is never shown again.',
  'settings.cxone-group':'Every account the platform provisions is added to this Checkmarx One group.',
  'settings.cxone-removals':'When a participant is deleted, the platform removes the Checkmarx One accounts it created for them. Anything it could not remove, or will not remove without your say-so, is listed with what to do.',
  'settings.retention':'Audit and activity history older than this is deleted by a daily sweep. Submissions, scores and certificates are not affected.',
  'settings.alerts':'When a blocked address could be a busy shared network such as a venue, every superadmin is emailed and an alert opens here until the block lapses or someone dismisses it. An unmistakable scanner is blocked without an alert; every block is recorded in Audit.',
  'settings.cxone-audit':'Every call the platform made to Checkmarx One, newest first: an account set up or linked to an existing one, a set-up refused, deferred or given up, a group grant, and each removal of a deleted participant’s account with its outcome. A row shows only where your role may see that person’s or event’s history.',
  'settings.health':'What is running (the version, and the commit, build time and release channel a release image was built with) and how the server is: its start-up database checks, the mail relay’s last check, free disk and the backups it can see. Superadmins also see the database and backup sizes, the Node.js version and when the server started.',
  'settings.release-notes':'What changed in the newest versions, for the people who run events. All release notes opens every version.',
  'settings.breakglass':'The boot-generated password is in the data folder. Changing the username keeps you signed in; the new one is needed from the next sign-in, and the old one then signs nobody in.',
};

// ─── Email (SMTP): the mail server in use ─────────────────────────────────────
//
// GET /api/admin/smtp-settings (settings.view) shows every reader the relay in
// force and where each value comes from; a superadmin (ops.smtp, never
// grantable) also gets the form: Test with these values sends through the
// UNSAVED values, Save swaps the relay live, Remove saved settings returns to
// the server's environment. The password is never sent to the browser: the form
// says only whether one is set, and an empty box keeps it (for the same host and
// username; the server refuses otherwise and says why).
let _smtpSeq=0;
let _smtpView=null;
const _SMTP_SOURCE={app:'Set in the app',environment:'From the server’s environment',default:'Built-in default'};
const _SMTP_SECURITY={starttls:'STARTTLS (upgrade required)',tls:'TLS from the start (implicit TLS)'};
function _smtpSourceTag(src){ return `<span class="settings-source">${esc(_SMTP_SOURCE[src]||'')}</span>`; }
function _smtpHealthText(h){
  if(!h||h.state===null||h.state===undefined)return 'Not checked yet since the server started or the settings changed.';
  const at=h.checked_at?` (${fmtDt(h.checked_at,'long')})`:'';
  return h.state===true?`Answered its last check${at}.`:`Did not answer its last check${at} — sign-in codes and invitations may not arrive.`;
}
export async function loadSmtpCard(){
  const body=document.getElementById('smtp-settings-body');
  if(!body)return;
  const seq=++_smtpSeq;
  const d=await fetchJsonObject('/api/admin/smtp-settings');
  if(seq!==_smtpSeq)return;
  if(!d){ _smtpView=null; renderLoadFailure('smtp-settings-body',{noun:'the mail server settings',retryAction:'smtp-reload'}); return; }
  _renderSmtpCard(d);
}
function _renderSmtpCard(d){
  const body=document.getElementById('smtp-settings-body');
  if(!body)return;
  _smtpView=d;
  const u=d.in_use;
  const rows=[];
  if(u){
    const src=u.source;
    // Plain text, escaped once where the list is drawn.
    rows.push(['Server',`${u.host}:${u.port}`,src]);
    rows.push(['Security',(_SMTP_SECURITY[u.security]||String(u.security))+(u.security==='starttls'&&d.plaintext_allowed?' — not required on this server (SMTP_ALLOW_PLAINTEXT)':''),src]);
    rows.push(['Username',u.username?String(u.username):'None (no sign-in to the server)',src]);
    rows.push(['Password',u.password_set?'Set (never shown)':'Not set',src]);
    rows.push(['Sender address',String(u.sender),u.sender_source]);
  }
  const health=d.health&&d.health.state===false?'settings-relay-bad':d.health&&d.health.state===true?'settings-relay-ok':'';
  let h='';
  if(d.password_unreadable){
    h+=`<p class="settings-warning" role="alert">The password saved in the app cannot be read on this server (its key file is not part of backups, so a restore or a move to another server loses it). ${d.in_use&&d.in_use.source==='environment'?'Email is going through the server’s environment settings meanwhile.':'Email is being sent without it and will likely fail.'} ${d.can_edit?'Enter the password again below and save.':'Ask a superadmin to enter it again.'}</p>`;
  }
  h+=u?`<dl class="settings-facts-list smtp-facts">${rows.map(([k,v,s])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)} ${_smtpSourceTag(s)}</dd></div>`).join('')}<div><dt>Last check</dt><dd class="${health}">${esc(_smtpHealthText(d.health))}</dd></div></dl>`
       :'<p class="settings-warning">No mail server is configured.</p>';
  // ONE test send for the server in use (POST /api/admin/test-email, ops.email),
  // under its facts and its one relay status (Last check above). The form below
  // keeps "Test with these values" for values not saved yet. The address typed
  // here survives the card's own re-renders.
  const typed=document.getElementById('smtp-current-test-to')?.value||'';
  if(u&&adminCan('ops.email')){
    h+=`<div class="settings-row smtp-current-test"><label for="smtp-current-test-to">Send a test to</label><input type="email" id="smtp-current-test-to" placeholder="you@company.com" autocomplete="off" maxlength="254" aria-describedby="smtp-current-test-hint"/><button class="btn secondary" data-action="send-test-email" data-input="smtp-current-test-to">Send test email</button><p class="settings-hint" id="smtp-current-test-hint">One plain message through the mail server in use, with the sender above.</p></div>`;
  }
  if(!d.can_edit){
    h+='<p class="settings-hint">Only a superadmin can change this.</p>';
    setSafeHtml(body,h);
    _restoreTyped(typed);
    return;
  }
  // The form starts from the SAVED relay when there is one (so re-entering a
  // lost password is one field), else from the one in force.
  const f=d.saved||u||{host:'',port:587,security:'starttls',username:'',sender:''};
  const savedPw=d.saved?d.saved.password_set&&!d.password_unreadable:(u&&u.password_set);
  const pwHint=savedPw?'Leave empty to keep the current password (same host and username only).':'Needed when the server asks for a username.';
  // The form sits behind a disclosure (the facts above are what most visits
  // need), open while a saved password must be entered again.
  h+=`<details class="comp-form-advanced smtp-change" id="smtp-change"${d.password_unreadable?' open':''}>
  <summary class="comp-form-advanced-summary"><span class="comp-form-advanced-title">Change the mail server</span><span class="comp-form-advanced-sub">Test new values, then save them</span></summary>
  <div class="comp-form-advanced-body">
  <p class="settings-help">Saved settings replace the server’s environment settings for all email, at once and without a restart. ${d.saved?'Remove them to go back to the environment.':''}</p>
  <div class="settings-row"><label for="smtp-host">Host</label><input type="text" id="smtp-host" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="253" value="${esc(f.host)}" placeholder="smtp.example.com"/></div>
  <div class="settings-row"><label for="smtp-port">Port</label><input type="text" id="smtp-port" inputmode="numeric" autocomplete="off" maxlength="5" value="${esc(String(f.port||''))}"/></div>
  <div class="settings-row"><label for="smtp-security">Security</label><select id="smtp-security" autocomplete="off">${Object.entries(_SMTP_SECURITY).map(([k,l])=>`<option value="${esc(k)}"${f.security===k?' selected':''}>${esc(l)}</option>`).join('')}</select><p class="settings-hint">Port 587 normally uses STARTTLS, port 465 TLS from the start.</p></div>
  <div class="settings-row"><label for="smtp-username">Username</label><input type="text" id="smtp-username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(f.username||'')}"/><p class="settings-hint">Leave empty for a server that takes mail without signing in.</p></div>
  <div class="settings-row"><label for="smtp-password">Password</label><input type="password" id="smtp-password" autocomplete="new-password" maxlength="512" aria-describedby="smtp-password-hint"/><p class="settings-hint" id="smtp-password-hint">${esc(pwHint)} Stored encrypted; never shown again.</p></div>
  <div class="settings-row"><label for="smtp-sender">Sender address</label><input type="email" id="smtp-sender" autocomplete="off" maxlength="254" value="${esc(f.sender||'')}" placeholder="no-reply@example.com"/><p class="settings-hint">The address mail comes from. The name shown is the platform name.</p></div>
  <div class="settings-row"><label for="smtp-test-to">Send a test to</label><input type="email" id="smtp-test-to" autocomplete="off" maxlength="254" placeholder="you@company.com"/><button class="btn secondary" data-action="smtp-test">Test with these values</button></div>
  <div class="settings-actions"><button class="btn" data-action="smtp-save">Save</button>${d.saved&&d.environment_relay?'<button class="btn danger sm" data-action="smtp-remove">Remove saved settings</button>':''}</div>
  </div></details>`;
  setSafeHtml(body,h);
  _restoreTyped(typed);
}
function _restoreTyped(v){ const el=document.getElementById('smtp-current-test-to'); if(el&&v)el.value=v; }
function _smtpFormValues(){
  const g=(id)=>document.getElementById(id)?.value??'';
  const out={host:g('smtp-host').trim(),port:g('smtp-port').trim(),security:g('smtp-security'),username:g('smtp-username').trim(),sender:g('smtp-sender').trim()};
  const pw=g('smtp-password');
  if(pw)out.password=pw;
  return out;
}
function _smtpRefused(d,status,what){
  const msg=d&&d.error?d.error:`${what} (${status}).`;
  showToast(msg,'error');
  if(d&&d.field){ const el=document.getElementById(d.field==='to'?'smtp-test-to':`smtp-${d.field}`); el?.focus(); }
}
async function _smtpSend(method,url,payload){
  let r=null;
  try{ r=await fetch(url,{method,headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload)}); }
  catch(e){ showToast('Could not reach the server — check your connection.','error'); return null; }
  const d=await r.json().catch(()=>null);
  return {r,d};
}
export async function smtpTest(){
  const to=(document.getElementById('smtp-test-to')?.value||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)){ showToast('Enter the address to send the test to.','error'); document.getElementById('smtp-test-to')?.focus(); return; }
  const out=await _smtpSend('POST','/api/admin/smtp-settings/test',{..._smtpFormValues(),to});
  if(!out)return;
  if(out.r.ok&&out.d&&out.d.ok){ showToast(`Test email sent to ${to} with these settings. They are not saved yet.`,'success'); return; }
  if(out.r.status===502&&out.d&&out.d.error){ showToast(`The server did not take the test email: ${out.d.error}`,'error'); return; }
  _smtpRefused(out.d,out.r.status,'The test email was not sent');
}
export async function smtpSave(){
  const v=_smtpFormValues();
  const ok=await showModal({title:'Save the mail server?',message:`All email the platform sends will go through <strong>${esc(v.host)}:${esc(v.port)}</strong> from now on. Test these values first if you have not.`,confirmText:'Save',confirmClass:''});
  if(!ok)return;
  const out=await _smtpSend('PUT','/api/admin/smtp-settings',{...v,expectedVersion:_smtpView?_smtpView.version:null});
  if(!out)return;
  if(out.r.ok&&out.d&&out.d.ok){ showToast('Mail server saved. Email now goes through it.','success'); _renderSmtpCard(out.d); return; }
  _smtpRefused(out.d,out.r.status,'The mail server was not saved');
}
export async function smtpRemove(){
  const ok=await showModal({title:'Remove the saved mail server?',message:'Email will go through the mail server set in the server’s environment again, at once. The saved password is deleted.',confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  const out=await _smtpSend('DELETE','/api/admin/smtp-settings',{expectedVersion:_smtpView?_smtpView.version:null});
  if(!out)return;
  if(out.r.ok&&out.d&&out.d.ok){ showToast('Saved mail server removed. Email goes through the environment’s settings.','success'); _renderSmtpCard(out.d); return; }
  _smtpRefused(out.d,out.r.status,'The saved mail server was not removed');
}

// ─── Email: relay status + test send ──────────────────────────────────────────
let _emailSeq=0;
export async function loadEmailCard(){
  const status=document.getElementById('email-relay-status');
  if(!status)return;
  const mySeq=++_emailSeq;
  // The relay's health rides the alerts read (ops.alerts): a role without it
  // sends no request the gate refuses, and finds out by sending a test.
  if(!adminCan('ops.alerts')){ setSafeHtml(status,'Send a test to check that email arrives.'); status.className='settings-help'; return; }
  const d=await fetchJsonObject('/api/admin/alerts');
  if(mySeq!==_emailSeq)return;
  if(!d){ setSafeHtml(status,'Could not check the mail relay. Send a test to find out.'); status.className='settings-help'; return; }
  if(d.smtp_healthy===true){ setSafeHtml(status,'The mail relay answered its last check.'); status.className='settings-help settings-relay-ok'; }
  else if(d.smtp_healthy===false){ setSafeHtml(status,'The mail relay failed its last check — sign-in codes and invitations may not arrive.'); status.className='settings-help settings-relay-bad'; }
  else { setSafeHtml(status,'The mail relay has not been checked since the last restart.'); status.className='settings-help'; }
}

// The test send of the server in use: the Mail server card's row (its input
// named by the button's data-input), or, for a role that may send a test but
// not read the mail server (ops.email without settings.view), the Outbound
// email card. A send re-reads that door's relay status.
export async function sendTestEmail(btn){
  const fromCard=!!(btn&&btn.dataset&&btn.dataset.input==='smtp-current-test-to');
  const input=document.getElementById(fromCard?'smtp-current-test-to':'settings-test-email-to');
  const to=(input?.value||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)){ showToast('Enter the address to send the test to.','error'); input?.focus(); return; }
  let r=null;
  try{ r=await fetch('/api/admin/test-email',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({to})}); }
  catch(e){ showToast('Could not reach the server — check your connection.','error'); return; }
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.ok){ showToast(`Test email sent to ${to}.`,'success'); if(fromCard)loadSmtpCard(); else loadEmailCard(); return; }
  showToast(d.error?`The test email was not sent: ${d.error}`:`The test email was not sent (${r.status}).`,'error');
}

// ─── Event history retention (read-only) ─────────────────────────────────────────────
let _retSeq=0;
export async function loadRetentionCard(){
  const body=document.getElementById('retention-body');
  if(!body)return;
  const mySeq=++_retSeq;
  const d=await fetchJsonObject('/api/admin/retention');
  if(mySeq!==_retSeq)return;
  if(!d||!Number.isFinite(d.retention_days)){
    renderLoadFailure('retention-body',{noun:'the retention settings',retryAction:'settings-retention-reload'});
    return;
  }
  const lp=d.last_purge&&typeof d.last_purge==='object'?d.last_purge:null;
  const lpAt=lp&&typeof lp.at==='string'?lp.at:null;
  const lpTotal=lp&&Number.isFinite(lp.total)?lp.total:null;
  const tables=Array.isArray(d.tables)?d.tables:[];
  // The same pass deletes stored pictures nothing uses any more, unless the
  // instance is out of service (the boot integrity or schema check failed, or
  // maintenance is on), when it holds them (`images_held`) and says so here: a
  // hold can last until the database is fixed and the server restarted.
  const lpPics=!lpAt?'Not since the last restart'
    :lp.images_held===true?'Clean-up held: the database failed a start-up check, or maintenance is on'
    :Number.isFinite(lp.images_purged)?`${lp.images_purged} removed${lp.images_capped===true?', more on the next sweep':''}`:'—';
  setSafeHtml(body,`<dl class="settings-facts">
    <dt>Kept for</dt><dd>${esc(String(d.retention_days))} days</dd>
    <dt>Last sweep</dt><dd>${lpAt?`${esc(fmtDt(lpAt,'long'))}${lpTotal!=null?` · ${esc(String(lpTotal))} removed`:''}`:'Not since the last restart'}</dd>
    <dt>Unused pictures</dt><dd>${esc(lpPics)}</dd>
    <dt>Covers</dt><dd>${tables.length?esc(tables.join(', ')):'—'}</dd>
  </dl><p class="settings-hint">Set by the operator (<code>EVENT_RETENTION_DAYS</code>); a restart applies a change.</p>`);
}

// ─── Alerts: the open blocked-address alerts ──────────────────────────────────
let _alertsSeq=0;
let _alertsRows=[];
let _alertsSa=false;
export async function loadAlertsCard(){
  const body=document.getElementById('alerts-body');
  if(!body)return;
  const mySeq=++_alertsSeq;
  const d=await fetchJsonObject('/api/admin/alerts');
  if(mySeq!==_alertsSeq)return;
  if(!d||!Array.isArray(d.alerts)){
    _alertsRows=[];
    renderLoadFailure('alerts-body',{noun:'the open alerts',retryAction:'settings-alerts-reload'});
    return;
  }
  _alertsRows=d.alerts; _alertsSa=!!d.isSuperAdmin;
  if(!d.alerts.length){
    setSafeHtml(body,'<p class="settings-help list-count" role="status">No open alerts. A blocked address that could be a venue raises one here and by email; an unmistakable scanner is blocked without one.</p>');
    return;
  }
  setSafeHtml(body,`<p class="settings-help list-count" role="status">${esc(d.alerts.length===1?'1 open alert':`${d.alerts.length} open alerts`)}</p>`
    +d.alerts.map(a=>`<div class="settings-alert-row"><span><strong>${esc(a.ip||'An address')}</strong>${a.competition_name?` · ${esc(a.competition_name)}`:''}${a.blocked_until?` · blocked until ${esc(fmtDt(a.blocked_until,'long'))}`:''}</span>`
      +`<button type="button" class="btn sm secondary" data-action="settings-alert-open" data-id="${esc(a.id)}" aria-label="Review alert for ${esc(a.ip||'this address')}">Review</button></div>`).join(''));
}

export function openSettingsAlert(id){
  const a=_alertsRows.find(x=>x&&x.id===id);
  if(!a){ showToast('That alert has already closed.'); loadAlertsCard(); return; }
  _showIpBanAlert(a,_alertsSa);
}

// The break-glass account's username: asked only from its own session (the
// route refuses every other), so the card stays hidden unless the read worked.
export async function loadBreakglassCard(){
  const card=document.getElementById('breakglass-account-card');
  if(!card)return;
  if(!S.isBreakglass){card.style.display='none';return;}
  const d=await fetchJsonObject('/api/admin/breakglass-username');
  if(!d||typeof d.username!=='string'){card.style.display='none';return;}
  const input=document.getElementById('settings-breakglass-username');
  if(input)input.value=d.username;
  card.style.display='';
}

export async function saveBreakglassUsername(){
  const input=document.getElementById('settings-breakglass-username');
  const username=(input?.value||'').trim();
  if(!username){showToast('Enter a username.','error');input?.focus();return;}
  let r=null;
  try{
    r=await fetch('/api/admin/breakglass-username',{method:'PATCH',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({username})});
  }catch(e){
    console.warn('[saveBreakglassUsername] request failed:',e&&e.message||e);
    showToast('Could not reach the server — check your connection.','error');
    return;
  }
  const d=await _bodyObject(r);
  if(!r.ok){showToast(d.error||'The username was not saved.','error');input?.focus();return;}
  if(input)input.value=d.username;
  showToast(d.changed?'Username saved. Use it from your next sign-in.':'That is already the username.','success');
}

async function _bodyObject(r){
  try{ return await r.json(); }
  catch(e){ console.warn('[saveBreakglassUsername] unreadable answer:',e&&e.message||e); return {}; }
}

export async function loadUnsubscribeList(){
  const body=document.getElementById('unsubscribe-list-body');
  if(!body)return;
  // v8.3.20 — same truthiness trap as loadAdminSettings, and here it also threw:
  // `d.entries.length` on an error object is `undefined.length`.
  const d=await fetchJsonObject('/api/admin/unsubscribed');
  if(!d||!Array.isArray(d.entries)){setSafeHtml(body,'<p class="settings-help">Failed to load list.</p>');return;}
  if(!d.entries.length){setSafeHtml(body,'<p class="settings-help" style="margin:0">No unsubscribed addresses.</p>');return;}
  // v7.20.7 — client-side search. The endpoint returns at most 1000 rows (and
  // says so via `truncated`), so this narrows what was FETCHED, not the whole
  // table — which is why the truncation notice below still has to be shown even
  // when a search is active. An admin checking whether one address opted out was
  // otherwise scanning a list of up to a thousand by eye.
  const q=(document.getElementById('unsub-search')?.value||'').toLowerCase().trim();
  const entries=q
    ? d.entries.filter(e=>[e.email,e.reason].some(v=>v&&String(v).toLowerCase().includes(q)))
    : d.entries;
  const clr=document.getElementById('unsub-search-clear');
  if(clr)clr.classList.toggle('hidden',!q);
  // v7.16.7 — say so when the list is cut short. Silence here is what let an
  // admin read "not in the list" as "not unsubscribed".
  let html='';
  if(d.truncated){
    html+=`<p class="settings-help" role="status" style="margin:8px 0 0;color:var(--yellow)">Showing the ${esc(String(d.shown))} most recent of <strong>${esc(String(d.total))}</strong> unsubscribed addresses. An address missing from this list may still be unsubscribed.</p>`;
  }
  // v7.20.11 — the count is UNCONDITIONAL now. It used to render only when a
  // query was typed, which is precisely the case countText names: a control that
  // materialises only once you type reads as something having gone wrong, and
  // "400 addresses" is useful on its own. When the server truncated, `loadedOf`
  // keeps v7.16.7's promise that the figure describes only what was loaded — the
  // whole point of that fix was that a silent subset is a wrong answer.
  html+=`<p class="settings-help list-count" role="status" aria-live="polite" style="margin:8px 0 0">${esc(countText({
    matched:entries.length,
    total:d.truncated?null:d.entries.length,
    filtered:!!q,
    noun:'address',
    ...(d.truncated?{loadedOf:d.entries.length}:{}),
  }))}${d.truncated&&q?' The search covers only the addresses loaded above, not the full list.':''}</p>`;
  html+='<div style="margin-top:8px">';
  if(!entries.length){
    html+=`<p class="settings-help" style="margin:8px 0">No loaded address matches "${esc(q)}".</p>`;
  }
  for(const e of entries){
    html+=`<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
      <div style="min-width:0">
        <div style="font-size:var(--fs-14);word-break:break-all">${esc(e.email)}</div>
        <div style="font-size:var(--fs-12);color:var(--muted);margin-top:2px">${fmtDt(e.unsubscribed_at,'short')} · ${esc(e.reason||'—')}</div>
      </div>
      <button class="btn sm danger" style="flex-shrink:0" data-action="unsub-remove" data-email="${esc(e.email)}">Remove</button>
    </div>`;
  }
  html+='</div>';
  setSafeHtml(body,html);
}

export async function removeUnsubscribedEmail(email){
  const ok=await showModal({title:'Remove from unsubscribe list',message:`Remove <strong>${esc(email)}</strong>? The next bulk send will reach their inbox again.`,confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  await loadCsrfToken();
  const r=await fetch(`/api/admin/unsubscribed/${encodeURIComponent(email)}`,{method:'DELETE',headers:csrfHeaders()});
  const d=await r.json().catch(()=>({}));
  if(r.ok){showToast('Removed from unsubscribe list.','success');loadUnsubscribeList();}
  else showToast(d.error||'Failed to remove.','error');
}

// audit v7.7.33 (AL14) — open a log row's structured details in the shared
// modal (keyboard/SR-reachable), triggered by the per-row "details" button.
export function showLogDetails(_ev, el){
  const d = (el && el.dataset && el.dataset.details) || '';
  if(!d)return;
  showModal({ title:'Log entry details', message:`<pre style="white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-variant-ligatures:none;font-size:var(--fs-13);max-height:60vh;max-height:60dvh;overflow:auto;text-align:left;margin:0">${esc(d)}</pre>`, confirmText:'Close', cancelText:'' });
}

export async function savePlatformName(){
  const name=document.getElementById('settings-platform-name').value.trim();
  if(!name){showToast('Please enter a platform name.');return;}
  const r=await fetch('/api/admin/settings',{method:'PATCH',headers:csrfHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({platform_name:name})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Failed to save name.','error');return;}
  applyPlatformName(d.platform_name||d.competition_name||name);
  showToast('Platform name updated.','success');
}

// The `require_account_approval` switch saves on change (superadmin only, like
// the rest of this card). A failure puts the box back, so it never shows a
// state the server does not hold.
export async function saveRequireApproval(){
  const box=document.getElementById('settings-require-approval');
  if(!box)return;
  const want=!!box.checked;
  let r,d;
  try{
    r=await fetch('/api/admin/settings',{method:'PATCH',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({require_account_approval:want})});
    d=await r.json().catch(()=>({}));
  }catch(_){box.checked=!want;showToast('Could not save — check your connection.','error');return;}
  if(!r.ok){box.checked=!want;showToast(d.error||'Failed to save.','error');return;}
  S.requireAccountApproval=want;   // the approval controls follow the switch at once
  showToast(want?'New accounts now wait for admin approval.':'New accounts are approved when they enter their first emailed code.','success');
}

export function loadCxOneSettings(d){
  if(!d)return;
  const status=document.getElementById('cxone-status');
  const keyInput=document.getElementById('cxone-api-key');
  const removeBtn=document.getElementById('cxone-remove-btn');
  const groupInput=document.getElementById('cxone-group-name');
  keyInput.value='';
  groupInput.value=d.cxone_group_name||'';
  if(d.cxone_configured){
    setSafeHtml(status, `<div class="cxone-status-banner is-connected">
      <span class="cxone-status-banner-state">${ICO.check}Connected</span>
      <span class="cxone-status-banner-meta">Tenant: <strong>${esc(d.cxone_tenant)}</strong></span>
      <span class="cxone-status-banner-meta">URL: <strong>${esc(d.cxone_base_url)}</strong></span></div>`);
    keyInput.placeholder='paste new key to replace';
    removeBtn.style.display='';
  }else{
    setSafeHtml(status, '<div class="cxone-status-banner"><span class="cxone-status-banner-state">Not configured</span></div>');
    keyInput.placeholder='Paste API key';
    removeBtn.style.display='none';
  }
}

export async function saveCxOneSettings(){
  const keyVal=document.getElementById('cxone-api-key').value.trim();
  const groupVal=document.getElementById('cxone-group-name').value.trim();
  const body={cxone_group_name:groupVal};
  if(keyVal)body.cxone_api_key=keyVal;
  const r=await fetch('/api/admin/default-cxone',{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
  if(!r.ok){
    // v8.3.17 (external audit) — REPORT THE REAL REFUSAL. This retried
    // `PUT /api/admin/cxone-settings` on EVERY primary failure, and that route
    // does not exist anywhere in the tree — not in routes/, not in server.js,
    // not in swagger. So the 404 from the retry replaced the primary response,
    // and a superadmin whose API key was rejected for a real, actionable reason
    // ("the key's host is not a Checkmarx domain") was shown a bare
    // "Failed to save." instead. A fallback to a removed endpoint is not
    // compatibility, it is an error-message eraser.
    const d=await r.json().catch(()=>({}));
    showToast(d.error||`Failed to save (${r.status}).`,'error');
    return;
  }
  const d=await r.json();
  loadCxOneSettings(d);
  showToast('Global default CxOne integration saved.','success');
}

export async function removeCxOneSettings(){
  const ok=await showModal({title:'Remove CxOne Integration',message:'This will remove the global default API key, group assignment, and disable automatic user provisioning in CheckmarxOne (unless per-competition overrides exist).',confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch('/api/admin/default-cxone',{method:'DELETE',headers:csrfHeaders()});
  if(!r.ok){
    // v8.3.17 — same dead fallback as the save path above; `/api/admin/cxone-settings`
    // exists nowhere in the tree, so its 404 replaced the real refusal.
    const d=await r.json().catch(()=>({}));
    showToast(d.error||`Failed to remove (${r.status}).`,'error');
    return;
  }
  const d=await r.json();
  loadCxOneSettings(d);
  showToast('Global default CxOne integration removed.','success');
}

// ─── v8.12.7 — Checkmarx One account removals (superadmin) ────────────────────
//
// When a participant is deleted the platform removes the Checkmarx One accounts
// it CREATED for them from the customer's tenant (lib/cxone-withdraw.js). Most
// removals need nobody; this card lists the ones that do — held for a decision,
// stalled, given up, or never scheduled — each with the server's own remedy text,
// so the card never re-derives WHY a row is here. `overridable` and `in_progress`
// are the server's answers too: Remove anyway is offered only where the route
// would accept it, and a row the runner is working on offers nothing, with the
// reason, rather than buttons the route is certain to refuse (v7.14.2).
// `past_retention` (and the count of such rows) is the server's answer too: the
// card never compares dates itself, and names the window the server reports.
// So is `held_signal_text`: WHICH sign held an account the tenant took into use,
// shown beside the remedy and quoted by Remove anyway's confirm, so the decision
// is made on what was found rather than on the list of what might have been.
const _WD_STATE = {
  retrying:        ['Retrying',                'refresh'],
  held:            ['Held for your decision',  'lock'],
  needs_attention: ['Needs attention',         'alertTriangle'],
  given_up:        ['Given up',                'ban'],
  unmarked:        ['Not scheduled',           'info'],
};
let _wdSeq = 0;          // stale-response guard (the v7.15.13 list-loader rule)
let _wdRows = [];        // the rows on screen, so an action's confirm can quote them
let _wdFocusPending = false; // the banner asked to land on this card — armed by loadAdminSettings
let _wdReviewEntry = false;  // true ONLY during the synchronous dispatch of a Review click

function _wdRealm(r){
  if(!r.iam_origin&&!r.tenant)return 'Unknown';
  let host=r.iam_origin||'';
  // An origin that does not parse is shown as stored, so the row still names it.
  try{ if(host)host=new URL(host).host; }catch(_){ host=String(host); }
  return `${host||'unknown host'} / ${r.tenant||'unknown tenant'}`;
}

function _wdAccountLabel(r){ return r?(r.created_username||r.cxone_user_id):''; }

function _wdFocusIfPending(){
  if(!_wdFocusPending)return;
  _wdFocusPending=false;
  const h=document.getElementById('cxone-withdrawals-heading');
  const card=document.getElementById('cxone-withdrawals-card');
  // The card's section must be the one on screen before its heading can take
  // focus (focus on a hidden element is a silent no-op).
  if(h&&card&&card.style.display!=='none'){ selectSettingsSection('cxone-audit'); h.focus(); }
}

// The header banner's "Review removals". It routes through the Settings nav item
// (the admin-crossnav rule: the nav highlight, the pane list and the loader in
// one place) and asks the card's loader to take focus once it has rendered —
// focusing before the rows land would put the admin on an empty card.
export function openCxoneWithdrawalsReview(){
  const btn=document.querySelector('[data-action="admin-tab"][data-tab-id="admin-settings-tab"]');
  if(!btn)return;
  // The click dispatches synchronously (dispatcher → adminTab → the synchronous
  // prefix of loadAdminSettings, which reads this), so the flag is scoped to
  // this one entry and cannot survive it — not even if the handler throws.
  selectSettingsSection('cxone-audit');   // the removals card's section, before the pane opens
  _wdReviewEntry=true;
  try{ btn.click(); }finally{ _wdReviewEntry=false; }
}

export async function loadCxoneWithdrawals(){
  const card=document.getElementById('cxone-withdrawals-card');
  const body=document.getElementById('cxone-withdrawals-body');
  if(!card||!body)return;
  if(!settingsCardOffered('cxone-withdrawals-card')){card.style.display='none';setSafeHtml(body,'');_wdRows=[];return;}
  const mySeq=++_wdSeq;
  const d=await fetchJsonObject('/api/admin/cxone/withdrawals');
  if(mySeq!==_wdSeq)return;
  if(!d||!Array.isArray(d.rows)){
    // A failed read is SAID, in the card (v8.3.33): hiding the card here would
    // tell a superadmin nothing is waiting, which we do not know.
    _wdRows=[];
    card.style.display='';
    renderLoadFailure('cxone-withdrawals-body',{noun:'Checkmarx One account removals',retryAction:'cxone-withdrawals-reload'});
    _wdFocusIfPending();
    return;
  }
  _wdRows=d.rows;
  if(!d.cxone_in_use&&!d.rows.length){
    card.style.display='none';setSafeHtml(body,'');_wdFocusPending=false;return;
  }
  card.style.display='';
  if(!d.rows.length){
    setSafeHtml(body,'<p class="settings-help list-count" role="status">No Checkmarx One accounts are waiting to be removed.</p>');
    _wdFocusIfPending();
    return;
  }
  const c=d.counts||{};
  const decide=(c.held||0)+(c.needs_attention||0)+(c.given_up||0)+(c.unmarked||0);
  const n=d.rows.length;
  // No entry ever leaves the card for its age; one kept past the retention
  // window says so, in the window the server names (or generically, if absent).
  const period=Number.isInteger(d.retention_days)&&d.retention_days>0?`${d.retention_days}-day retention period`:'retention period';
  const kept=Number.isInteger(d.past_retention_count)?d.past_retention_count:0;
  let h=`<p class="settings-help list-count" role="status">${esc(n===1?'1 account listed':`${n} accounts listed`)}${decide?esc(` · ${decide} waiting for your decision`):''}${kept?esc(` · ${kept} kept past the ${period}`):''}.</p>`;
  h+=`<div class="cxone-wd-scroll"><table class="cxone-wd-table" data-tcols="cxone-withdrawals"><thead><tr>
    <th scope="col">State</th><th scope="col">Tenant</th><th scope="col">Account</th><th scope="col">Event</th>
    <th scope="col">Since</th><th scope="col">Attempts</th><th scope="col">Last error</th></tr></thead>`;
  for(const r of d.rows){
    const st=_WD_STATE[r.state]||[String(r.state||'Unknown'),'info'];
    const label=r.in_progress?'In progress':st[0];
    const icon=ICO[r.in_progress?'hourglass':st[1]]||'';
    const acct=_wdAccountLabel(r);
    const event=r.competition_name||(r.competition_id?'A deleted event':'Global default key');
    const next=(r.state==='retrying'&&r.next_attempt_at)?`<span class="cxone-wd-sub">next try ${esc(fmtDt(r.next_attempt_at,'long'))}</span>`:'';
    const remedy=r.remedy||(r.state==='retrying'?'Nothing yet — the platform keeps retrying on its own.':'—');
    let actions;
    if(r.in_progress){
      actions='<span class="cxone-wd-sub">The platform is working on this account right now. Check back in a minute.</span>';
    }else{
      const id=esc(r.cxone_user_id);
      // (review) — on an UNMARKED row this button is not a retry: nothing has been
      // scheduled, so pressing it is the FIRST go-ahead to delete an account from
      // the customer's tenant. It says so, and retryCxoneWithdrawal confirms first.
      actions=(r.state==='unmarked'
        ?`<button type="button" class="btn sm secondary" data-action="cxone-withdrawal-retry" data-id="${id}" aria-label="Schedule removal of Checkmarx One account ${esc(acct)}">Schedule removal</button>`
        :`<button type="button" class="btn sm secondary" data-action="cxone-withdrawal-retry" data-id="${id}" aria-label="Retry removing Checkmarx One account ${esc(acct)}">Retry</button>`)
        +(r.overridable?`<button type="button" class="btn sm danger" data-action="cxone-withdrawal-override" data-id="${id}" aria-label="Remove anyway — Checkmarx One account ${esc(acct)}">Remove anyway</button>`:'')
        +`<button type="button" class="btn sm secondary" data-action="cxone-withdrawal-dismiss" data-id="${id}" aria-label="Mark removed — Checkmarx One account ${esc(acct)}">Mark removed</button>`;
    }
    // Each account is its own <tbody>: the facts on one row, then what to do
    // and the buttons on a full-width row beneath them. As two more columns
    // they sat past the right edge of a 1280px screen, so the one part a
    // superadmin has to act on was the part they had to scroll sideways to find.
    h+=`<tbody class="cxone-wd-entry" data-cxone-user-id="${esc(r.cxone_user_id)}"><tr>
      <td><span class="cxone-wd-state">${icon}${esc(label)}</span></td>
      <td>${esc(_wdRealm(r))}${r.realm_confirmed?'':'<span class="cxone-wd-sub">not confirmed</span>'}</td>
      <td><span class="cxone-wd-id">${esc(r.cxone_user_id)}</span>${r.created_username?`<span class="cxone-wd-sub">${esc(r.created_username)}</span>`:''}</td>
      <td>${esc(event)}</td>
      <td data-sort-value="${esc(String(r.pending_since||r.recorded_at||''))}">${esc(fmtDt(r.pending_since||r.recorded_at,'long'))}${r.past_retention===true?`<span class="cxone-wd-sub">kept past the ${esc(period)}</span>`:''}</td>
      <td>${esc(String(r.attempts||0))}${next}</td>
      <td>${r.last_error?esc(r.last_error):'—'}</td>
    </tr><tr class="cxone-wd-detail"><td colspan="7">
      ${typeof r.held_signal_text==='string'&&r.held_signal_text?`<div class="cxone-wd-remedy cxone-wd-found"><span class="cxone-wd-label">What the platform found:</span> ${esc(r.held_signal_text)}</div>`:''}
      <div class="cxone-wd-remedy"><span class="cxone-wd-label">What to do:</span> ${esc(remedy)}</div>
      <div class="cxone-wd-actions">${actions}</div>
    </td></tr></tbody>`;
  }
  h+='</table></div>';
  setSafeHtml(body,h);
  _wdFocusIfPending();
}

async function _wdPost(path, body){
  await loadCsrfToken();
  let r;
  try{
    r=await fetch(path,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
  }catch(_){ return {ok:false,error:'Could not reach the server. Check your connection and try again.'}; }
  // A 429 or a proxy's error page is not JSON; parse defensively.
  const d=await r.json().catch(()=>({}));
  if(r.ok)return {ok:true,d};
  return {ok:false,error:(d&&d.error)||`The request failed (${r.status}).`};
}

async function _wdAfterAction(){
  await loadCxoneWithdrawals();
  refreshAdminBanners();
}

// Both confirms that start a removal say what else it can end in: the runner
// hands the account to a participant still here who owns it (bound to it, or
// holding its address as their confirmed primary under the same names) instead
// of removing it, whatever hold was overridden — so "cannot be undone" is
// claimed only of the removal.
const _WD_HANDOVER_NOTE='If a participant still on the platform turns out to own it — linked to it, or with its email address as their confirmed primary address and the same first and last names — it passes to them instead and nothing is removed.';

export async function retryCxoneWithdrawal(id, override){
  const row=_wdRows.find(x=>x.cxone_user_id===id);
  const acct=_wdAccountLabel(row)||id;
  // (review) — an UNMARKED row has never been scheduled: nothing recorded the
  // participant's deletion, and the platform will not act on an absence. So this
  // press is the first decision to delete an account in someone else's tenant,
  // not a nudge to a removal already under way, and it gets the confirm and the
  // words that says so. `override` never reaches here for it (not overridable).
  const first=!override&&!!row&&row.state==='unmarked';
  if(first){
    const ok=await showModal({
      title:'Schedule this removal?',
      message:`<p>Nothing recorded the deletion of the participant this account was created for, so the platform has not scheduled its removal.</p><p>The platform will remove Checkmarx One account <strong>${esc(acct)}</strong> from the customer's tenant. ${_WD_HANDOVER_NOTE} A removal cannot be undone once it runs.</p>`,
      confirmText:'Schedule removal',confirmClass:'danger'});
    if(!ok)return;
  }
  if(override){
    // The confirm QUOTES the remedy: Remove anyway is an admin overruling the
    // platform's own reason for holding, so the reason is what they must read.
    const ok=await showModal({
      title:'Remove this account anyway?',
      message:`${row&&typeof row.held_signal_text==='string'&&row.held_signal_text?`<p><strong>What the platform found:</strong> ${esc(row.held_signal_text)}</p>`:''}<p>${esc(row&&row.remedy?row.remedy:'The platform is holding this account for your decision.')}</p><p>Remove Checkmarx One account <strong>${esc(acct)}</strong> from the customer's tenant anyway? ${_WD_HANDOVER_NOTE} A removal cannot be undone.</p>`,
      confirmText:'Remove anyway',confirmClass:'danger'});
    if(!ok)return;
  }
  // v8.13.1 — an override names the hold (and the sign) its confirm quoted, so a
  // colleague's approval that moved the row on to a DIFFERENT hold refuses this one (409
  // `cxone_withdrawal_hold_changed`) instead of silently overriding a reason
  // nobody read. The failure path below reloads the list, which shows the new one.
  const res=await _wdPost('/api/admin/cxone/withdrawals/retry',override
    ?{cxone_user_id:id,override:true,expected_hold:row&&row.held_reason,...(row&&row.held_signal?{expected_signal:row.held_signal}:{})}
    :{cxone_user_id:id,override:false});
  if(!res.ok){showToast(res.error,'error');await _wdAfterAction();return;}
  showToast(override
    ? `Removal of ${acct} approved — the platform will remove it shortly, unless its owner is still on the platform.`
    : first
      ? `Removal of ${acct} scheduled — the platform will remove it from the customer's tenant shortly, unless its owner is still on the platform.`
      : `Removal of ${acct} scheduled — the platform will try again shortly.`,'success');
  await _wdAfterAction();
}

export async function dismissCxoneWithdrawal(id){
  const row=_wdRows.find(x=>x.cxone_user_id===id);
  const acct=_wdAccountLabel(row)||id;
  const ok=await showModal({
    title:'Mark this account as removed?',
    message:`<p>The platform stops tracking Checkmarx One account <strong>${esc(acct)}</strong> and will not try to remove it again. Make sure it has been removed in the customer's tenant first.</p>`,
    confirmText:'Mark removed',confirmClass:'danger'});
  if(!ok)return;
  const res=await _wdPost('/api/admin/cxone/withdrawals/dismiss',{cxone_user_id:id});
  if(!res.ok){showToast(res.error,'error');await _wdAfterAction();return;}
  showToast(`${acct} is no longer tracked.`,'success');
  await _wdAfterAction();
}
