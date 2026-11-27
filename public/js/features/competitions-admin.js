"use strict";

import { S } from "../core/state.js";
import { wireTagDialog } from "../ui/tag-dialog.js";
import { csrfHeaders, fetchJsonList, fetchTransientRetry, readBody } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { _buildTzInput, _isValidTz, wallClockToUtc, wallClockToUtcChecked, dstGapMessage, utcToWallClock} from "../data/country-tz.js";
import { loadAdminTasks } from "./challenges-admin.js";
import { computeCompStatus, compDisplayCategory, COMP_CATEGORY_LABEL, isLateEntryOpen } from "./competition-picker.js";
import { loadAdminParticipants, resyncParticipantsWithFocus } from "./participants-admin.js";
import { loadAdminRankingsTab } from "./rankings-admin.js";
import { _sessionGetDurMinutes, _sessionGetStartUtc, sessionFormUpdateEnd } from "./sessions-admin.js";
import { loadAdminSubmissions } from "./submissions-admin.js";
import { paginationHtml, setListCount, renderLoadFailure, colspanFor, patchTableRows, setHtmlIfChanged } from "../ui/list-controls.js";
import { esc, fmtDt, formatCountdown, formatDuration, _syncSortAria, DRY_RUN_TAG, eventKindChipHtml, eventKindLabel, eventCollectiveSingular, policyOrDefault, NO_FIXED_DEADLINE, eventEndText } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { applyColumnFilters, hasColumnFilters } from "../ui/table-columns.js"; // v8.17.0 — heading filters
import { hideLoading, showLoading } from "../ui/loading.js";
import { _countdownConfirm, overlayDismiss, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { syncWorkspaceChrome, wsFlushHeldRecord, openEventWorkspace, skippedSummary, refreshOverviewLive, top3Offered } from "./event-workspace.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)

// The whole minutes from `atMs` that reach a kept end, rounded UP (as End Now
// rounds): the end never moves earlier than scheduled, and at most a minute later.
const _minutesToKeptEnd=(endMs,atMs)=>Math.max(1,Math.ceil((endMs-atMs)/60000));

export async function startNow(compId,tsId){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  if(!comp)return;

  // A Start now that keeps its end sends ONE instant, taken at the press: the
  // start is that instant and the duration reaches the end from it. The dialog
  // may stay open a while, so a duration taken when it opened would move the
  // end later by however long it stayed open.
  if(tsId){
    // Start a specific session
    const ts=(comp.timeslots||[]).find(t=>t.id===tsId);
    if(!ts)return;
    const origStart=new Date(ts.start_time);
    const origEnd=new Date(origStart.getTime()+ts.duration_minutes*60000);
    const ok=await showModal({
      title:'Start Session Now?',
      message:`This will start <strong>${esc(comp.name)} → ${esc(ts.name)}</strong> immediately.<br><br>` +
        `Original start: ${fmtDt(origStart,'long')}<br>` +
        `End time (preserved): <strong>${fmtDt(origEnd,'long')}</strong><br>` +
        `Duration adjusted: ${formatDuration(ts.duration_minutes*60000)} → <strong>${formatDuration(_minutesToKeptEnd(origEnd.getTime(),Date.now())*60000)}</strong>`,
      confirmText:'Start Session Now',
      confirmClass:'warning'
    });
    if(!ok)return;
    const at=Date.now();
    const tsBody={start_time:new Date(at).toISOString(),duration_minutes:_minutesToKeptEnd(origEnd.getTime(),at)};
    if(ts.updated_at)tsBody.expectedUpdatedAt=ts.updated_at;
    const r=await fetch(`/api/admin/competitions/${compId}/timeslots/${tsId}`,{
      method:'PUT',
      headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify(tsBody)
    });
    if(r.ok){showToast(`Session "${ts.name}" started!`);await loadAdminCompetitions();renderScopeBanner();}
    else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to start session.','error');}
  }else{
    // Single-slot competition — start the competition itself
    const origStart=new Date(comp.start_time);
    // THE SCHEDULED END IS KEPT (operator ruling, 14 Nov 2026), as a session's
    // own Start now keeps its end. A WINDOW kind (Booth Event, Competition)
    // stretches its duration to reach the end it was scheduled to have: a 2-hour
    // event set for tomorrow, started now, runs until tomorrow's end. A DEADLINE
    // kind keeps its deadline, which is authoritative for it: the PUT then
    // carries the start ALONE and the server derives the duration from the
    // stored deadline at the start it writes (routes/competitions.js). A duration
    // computed here, before the confirm, is refused whenever it disagrees with
    // that derivation (`duration_not_accepted`), and always past the 365-day cap.
    const keepDeadline=policyOrDefault(comp.policy).schedule==='deadline';
    const origEnd=keepDeadline&&comp.deadline_at?new Date(comp.deadline_at):new Date(origStart.getTime()+comp.duration_minutes*60000);
    const ok=await showModal({
      title:'Start Event Now?',
      message:`This will start <strong>${esc(comp.name)}</strong> immediately.<br><br>` +
        `Original start: ${fmtDt(origStart,'long')}<br>` +
        // An open-ended Program's kept deadline is its placeholder ten years out:
        // the server's `open_ended` says "No fixed deadline" (operator ruling,
        // 14 Nov 2026).
        (keepDeadline
          ?`Deadline (preserved): <strong>${esc(eventEndText(comp,origEnd,'long'))}</strong>`
          :`End time (preserved): <strong>${fmtDt(origEnd,'long')}</strong><br>` +
            `Duration adjusted: ${formatDuration(comp.duration_minutes*60000)} → <strong>${formatDuration(_minutesToKeptEnd(origEnd.getTime(),Date.now())*60000)}</strong>`),
      confirmText:'Start Now',
      confirmClass:'warning'
    });
    if(!ok)return;
    const at=Date.now();
    const compBody={start_time:new Date(at).toISOString()};
    if(!keepDeadline)compBody.duration_minutes=_minutesToKeptEnd(origEnd.getTime(),at);
    if(comp.updated_at)compBody.expectedUpdatedAt=comp.updated_at;
    const r=await fetch(`/api/admin/competitions/${compId}`,{
      method:'PUT',
      headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify(compBody)
    });
    if(r.ok){showToast('Event started!','success');await loadAdminCompetitions();renderScopeBanner();}
    else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to start event.','error');}
  }
}

export async function endNow(compId){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  if(!comp)return;
  const name=comp.name;
  const slots=(comp.timeslots||[]);

  // Build detailed session listing for the confirmation
  let sessionDetail='';
  if(slots.length>0){
    const liveSlots=slots.filter(s=>computeCompStatus(s)==='live');
    const upcomingSlots=slots.filter(s=>computeCompStatus(s)==='upcoming');
    const endedSlots=slots.filter(s=>computeCompStatus(s)==='ended');
    let items='';
    if(liveSlots.length) items+=liveSlots.map(s=>`<li><strong>${esc(s.name)}</strong> — <span style="color:var(--green)">Live</span> (started ${fmtDt(s.start_time,'long')})</li>`).join('');
    if(upcomingSlots.length) items+=upcomingSlots.map(s=>`<li><strong>${esc(s.name)}</strong> — <span style="color:var(--yellow)">${ICO.alertTriangle} Not started yet</span> (scheduled ${fmtDt(s.start_time,'long')})</li>`).join('');
    if(endedSlots.length) items+=endedSlots.map(s=>`<li><strong>${esc(s.name)}</strong> — <span style="color:var(--muted)">Already ended</span></li>`).join('');
    sessionDetail=`<br><br><strong>The following sessions will be ended:</strong><ul style="margin:8px 0;text-align:left">${items}</ul>`;
    if(upcomingSlots.length) sessionDetail+=`<p style="color:var(--yellow);font-size:var(--fs-14)">${ICO.alertTriangle} ${upcomingSlots.length} session(s) have not started yet and will be ended without ever going live.</p>`;
  }

  // v8.12.7 — an event that runs a late-entry window does NOT stop accepting
  // submissions when it ends: ending it OPENS the window, and the switch that
  // decides whether there is one locks at that instant. So the dialog says what
  // will actually happen, and names the one moment the choice can still be made.
  // The kind rule is read from the WIRE policy, never from `event_kind` (a stale
  // payload without the key keeps the ordinary sentence — the direction that
  // claims less), and the automatic span reuses the one client mirror of the
  // server's 48 hours so its lock covers this copy too.
  const _lateWindow=comp.policy?.late_entry==='allowed'&&!!comp.late_entry_enabled;
  const _lateUntil=comp.late_entry_deadline_at
    ?esc(fmtDt(comp.late_entry_deadline_at,'long',{withZone:true}))
    :`${LATE_ENTRY_AUTO_SPAN_MS/3600000} hours after it ends`;
  const _endCopy=_lateWindow
    // v8.12.8 — the remedy for closing the window early is the "Close late
    // entries now" control on the event's menu, which every organiser has — not
    // a superadmin editing the deadline. This dialog is shown only to somebody
    // who can End Now, i.e. never a competitor, who is exactly the actor the
    // close control is withheld from; so naming it here is true for its reader.
    ?`Ending it opens its late-entry window: the main leaderboard becomes final, but people can still join as late entrants, and late entrants keep playing until ${_lateUntil}. <strong>Allow late entries</strong> cannot be changed once it has ended — to end it with no late window, cancel and untick that first; to close the window early afterwards, use <strong>Close late entries now</strong> on its menu.`
    :'All participants will see the event as ended and no further submissions will be accepted.';
  const ok=await showModal({
    title:'End Event Now',
    message:`Are you sure you want to end <strong>${esc(name)}</strong> immediately?${sessionDetail}<br>${_endCopy}`,
    confirmText:'End Now',confirmClass:'danger',cancelText:'Cancel'
  });
  if(!ok)return;

  const proceed=await _countdownConfirm(name,slots.length>0?'event (all sessions)':'event');
  if(!proceed)return;

  const r=await fetch(`/api/admin/competitions/${compId}/end-now`,{method:'POST',headers:csrfHeaders()});
  if(r.ok){
    showToast('Event ended.','success');
    await loadAdminCompetitions();
    renderScopeBanner();
    loadAdminTasks();loadAdminParticipants();loadAdminSubmissions();loadAdminRankingsTab();
  }else{const d=await r.json();showToast(d.error||'Failed to end event.','error');}
}

// v8.12.8 — "CLOSE LATE ENTRIES NOW". Shuts a finished Booth Event's OPEN
// late-entry window at a server-resolved instant, to the millisecond, for any
// admin or superadmin and for an event admin on the events they organise
// (POST /api/admin/competitions/:id/late-entry/close). Reached from the Events
// row menu and from the focused event's scope banner, both of which offer it
// ONLY from the server's own `can_close_late_entries` answer.
//
// THE FLAG IS NOT RE-CHECKED HERE, deliberately. The offer can be STALE — the
// kebab portal is a copy taken when it opened, and the 15 s poll replaces the
// model underneath it — and a colleague may have closed the window in the
// meantime. Returning early on a false flag would swallow that click with nothing
// on screen; instead the confirm always shows and the request always goes, and
// the SERVER's answer decides the toast (`alreadyClosed`, or a named refusal).
// Only a row that has vanished from the model stops here, because there is then
// no name to put in the confirm.
//
// ONE confirm, no countdown: End Now's countdown guards an act nobody can undo,
// and this one a superadmin can (by re-pinning the deadline in the editor). One
// sentence set for every tier — "Only a superadmin can reopen it" is true when a
// superadmin reads it too.
export async function closeLateEntriesNow(compId){
  const comp=(S.adminCompetitionsData||[]).find(c=>c.id===compId);
  if(!comp){showToast('That event is no longer in your list — reload the Events tab.','error');return;}
  const dlMs=comp.late_entry_deadline_effective?Date.parse(comp.late_entry_deadline_effective):NaN;
  const dl=Number.isFinite(dlMs)&&dlMs>Date.now()?fmtDt(comp.late_entry_deadline_effective,'long',{withZone:true}):null;
  const ok=await showModal({
    title:'Close late entries now',
    message:`Stop taking late entries for <strong>${esc(comp.name)}</strong> now${dl?`, instead of at <strong>${esc(dl)}</strong>`:''}?<br><br>`
      +`From this moment its join link, QR code and short code stop admitting anyone, organisers can no longer add or remove people, and late entrants can no longer answer challenges or reveal hints. `
      +`The late-entrant leaderboard becomes final, so its top three can collect a placing certificate — unless they already collected a participation certificate during the window. `
      +`Emails already sent still name the old deadline, and invitations or sign-ups not yet completed no longer let anyone take part. `
      +`Only a superadmin can reopen it.`,
    confirmText:'Close late entries',confirmClass:'danger',cancelText:'Cancel'});
  if(!ok)return;
  let r=null,d={};
  try{
    r=await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/late-entry/close`,{method:'POST',headers:csrfHeaders()});
    // Parsed defensively: a proxy's HTML error page is not JSON, and a thrown
    // parse must not turn a refusal into an unhandled rejection with no toast.
    try{d=await r.json();}catch(_){d={};}
  }catch(_){r=null;}
  if(r&&r.ok){
    // The default Events chips hide Ended rows, so the row the admin just acted
    // on disappears from the table — say where it went, or it reads as deleted.
    const hidden=S.compStatusFilters.size>0&&!S.compStatusFilters.has('ended');
    showToast(d&&d.alreadyClosed
      ?`Late entries for “${comp.name}” were already closed.`
      :`Late entries for “${comp.name}” are closed.${hidden?' It is now listed under Ended.':''}`,'success');
    await loadAdminCompetitions({keepPage:true});
    renderScopeBanner();
    // The Challenges tab carries a per-event "Late entry open" badge and has no
    // poll; the Participants rows carry who is a removable late entrant; the
    // Rankings tab the late section. `keepView` keeps the admin's search/page.
    loadAdminTasks();loadAdminParticipants({keepView:true});loadAdminRankingsTab();
  }else showToast((d&&d.error)||'Could not close late entries.','error');
}

export function setAdminCompetitionScope(compId,compName){
  // audit v7.12.3 (#7) — note if this pick came FROM the scope switcher before we
  // remove it: renderScopeBanner() replaces the banner DOM, detaching the opener the
  // overlay captured, so keyboard focus would fall to <body>. Re-focus the freshly-
  // rendered Switch button (also makes overlayDismiss's deferred restore stand down).
  S.adminSelectedCompetitionId=compId;
  S.adminSelectedCompetitionName=compName;
  S.pWsShowEveryone=false;
  // v8.8.3 — focusing an event NARROWS what you are looking at, so it resets the
  // Challenges page the way every other narrowing control does (the three filter
  // chip groups and the search box all set tPage=1). It did not, and that is half
  // the reason a shared-pool challenge reads as missing: focus sorts every
  // out-of-scope challenge BELOW the event own ones, so on an event holding 30 the
  // whole shared pool moves to page 2 — while the pager stays on whatever page you
  // were on, which may now hold nothing you recognise.
  S.tPage=1;
  S.adminSelectedTimeslotId=null;
  S.adminSelectedTimeslotName=null;
  renderScopeBanner();
  renderAdminCompetitions();
  loadAdminTasks();loadAdminParticipants();loadAdminSubmissions();loadAdminRankingsTab();
}

export function setAdminTimeslotScope(compId,compName,tsId,tsName){
  // Opening ANOTHER event from a session chip (People, the Events list) opens it
  // the way setAdminCompetitionScope does: its own people only, Challenges from
  // page 1 (sweep #248). Narrowing to a session of the event already open keeps
  // both, as a session narrows neither list.
  if(S.adminSelectedCompetitionId!==compId){ S.pWsShowEveryone=false; S.tPage=1; }
  S.adminSelectedCompetitionId=compId;
  S.adminSelectedCompetitionName=compName;
  S.adminSelectedTimeslotId=tsId;
  S.adminSelectedTimeslotName=tsName;
  renderScopeBanner();
  renderAdminCompetitions();
  loadAdminTasks();loadAdminParticipants();loadAdminSubmissions();loadAdminRankingsTab();
}

export function clearAdminCompetitionScope(){
  S.adminSelectedCompetitionId=null;
  S.adminSelectedCompetitionName=null;
  S.tPage=1;   // v8.8.3 — clearing the focus re-widens the list; same reason as focusCompetition
  S.adminSelectedTimeslotId=null;
  S.adminSelectedTimeslotName=null;
  renderScopeBanner();
  renderAdminCompetitions();
  loadAdminTasks();loadAdminParticipants();loadAdminSubmissions();loadAdminRankingsTab();
}

export function startAdminCompPoll(){
  if(S.adminCompPollInterval)clearInterval(S.adminCompPollInterval);
  S.adminCompPollInterval=null;
  if(S._pollsHalted)return;
  // RBAC — a role that may not read events runs no events poll at all (each
  // nav build restarts it, so a role later given the permission gets one).
  if(!adminCan('events.view'))return;
  S.adminCompPollInterval=setInterval(async()=>{
    // RBAC — the poll reads events, so a role that may not sends nothing.
    if(!S.isAdmin||!adminCan('events.view'))return;
    // v8.12.6 — the DISPLAY category, not the status: a late-entry window
    // closing leaves the status at "ended" but changes what the focused event
    // admits, so the banner and the Participants rows (whose Invite and Remove
    // items read the focused event's row) must re-render when it happens too.
    //
    // (review) — the Participants rows are NOT re-synced here any more: the
    // scope banner's 1 s tick reloads this list on the live→ended edge before
    // the next poll, so a snapshot taken here usually already read "late entry"
    // and the rows were never refreshed at the moment that mattered most.
    // `loadAdminCompetitions` asks `resyncParticipantsWithFocus` after EVERY
    // load, against what the table was last rendered with.
    const old=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
    const oldCat=old?compDisplayCategory(old):null;
    await loadAdminCompetitions({keepPage:true});
    if(S.adminSelectedCompetitionId){
      const updated=S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId);
      const newCat=updated?compDisplayCategory(updated):null;
      // v8.13.3 — and when the focused event VANISHED from the list (another
      // admin deleted it): renderScopeBanner's detector then clears the focus
      // with a toast. Before, nothing on the Submissions path noticed, so that
      // pane kept sending the dead id — answered 404 "Event not found" since
      // this release, i.e. a load failure whose Retry could never work (the
      // pre-release review).
      if((oldCat&&newCat&&oldCat!==newCat)||(old&&!updated))renderScopeBanner();
      // The workspace Overview's live parts ride THIS poll (no timer of their
      // own); it does nothing unless the Overview is the section on screen.
      refreshOverviewLive().catch(e=>console.warn('Overview refresh failed',e));
    }
  },15000);
}

export function renderScopeBanner(){
  if(S.scopeBannerInterval){clearInterval(S.scopeBannerInterval);S.scopeBannerInterval=null;}
  const banner=document.getElementById('admin-scope-banner');
  const headerTimer=document.getElementById('header-timer');
  // If the scoped competition was deleted by another admin between polls, the
  // banner used to keep showing stale name + broken End Now button. Detect the
  // missing row and reset scope so the rest of the admin UI snaps back to the
  // unscoped state.
  // The model must be a list the server ANSWERED (`S._adminCompsLoaded`), not
  // merely non-empty: a failed load empties it, and must not read as a deletion,
  // while an answered empty list (the open event was an organiser's only one,
  // and it was deleted or their access to it ended) must.
  if(S.adminSelectedCompetitionId&&S._adminCompsLoaded&&!S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId)){
    showToast('The event you were viewing was deleted, or you no longer have access to it.','error');
    clearAdminCompetitionScope();
    return;
  }
  if(S.adminSelectedCompetitionId&&S.adminSelectedCompetitionName){
    banner.style.display='';
    banner.className='scope-banner';
    if(headerTimer)headerTimer.style.display='none';
    S.lastBannerStatus=null;
    S._lastScopeBannerHtml=null;
    // v8.12.8 — `explicit`: an EXPLICIT render (renderScopeBanner() itself — an
    // action, a scope change, a tab return, the poll's category change) versus
    // the 1 s TICK. See the paint guard at the end of this function.
    const renderBannerContent=(explicit)=>{
      // The workspace header holds a render while a dialog is open; the tick
      // carries it out once the dialog has gone.
      if(!explicit)wsFlushHeldRecord();
      const comp=S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId);
      let statusHtml='';
      let currentStatus='';
      const timeslots=comp?.timeslots||[];
      const hasTimeslotSelected=S.adminSelectedTimeslotId&&timeslots.length>0;
      // audit v7.7.37 (C21) — derive the competition-level status for multi-slot
      // comps up-front so BOTH branches can use it. Pre-fix currentStatus was only
      // assigned inside the !hasTimeslotSelected branch, so the timeslot-focused
      // branch's `if(currentStatus==='live')` End Now (cancel a pending session
      // while the comp is live) button was dead code — never rendered.
      if(comp&&timeslots.length>0){
        const tsStatuses=timeslots.map(ts=>computeCompStatus(ts));
        if(tsStatuses.every(s=>s==='ended')){currentStatus='ended';}
        else if(tsStatuses.every(s=>s==='upcoming')){currentStatus='upcoming';}
        else{currentStatus='live';}
      }

      // v8.12.0 — A COMPETITOR IS OFFERED NONE OF THE BANNER'S WRITE CONTROLS.
      // End Now and the per-session Start Now / End Now are refused
      // `competitor_cannot_edit` server-side for an actor who holds a row on a
      // compete event; the row kebab already withholds them with a note, and
      // this banner — the surface a competitor sits on while their event is
      // live, Focus being the one control the feature keeps for them — rendered
      // them from status alone. Three copies of one rule, two of which drifted.
      // THE STATUS CHIP. The compact workspace header shows the lifecycle as
      // one chip with its live text; it carries NO controls. End now, Close late
      // entries now and the session doors live in ONE place each — the header's
      // ⋯ menu and the Overview's Sessions card ("one place per action") — so a
      // competitor, who is offered none of them, sees the same chip as anyone.
      const _sChip=(cat,text,extra='')=>`<span class="scope-status ws-status-chip ws-chip ws-chip-${cat}${extra}"><span class="ws-dot${cat==='live'?' live':''}" aria-hidden="true"></span>${text}</span>`;
      if(comp&&!hasTimeslotSelected){
        // Show competition-level status when no specific session is selected
        if(timeslots.length>0){
          // Multi-slot: currentStatus derived above (mirrors server competitionStatus logic)
          if(currentStatus==='upcoming'){
            const earliest=timeslots.reduce((a,ts)=>{ const t=new Date(ts.start_time).getTime(); return t<a?t:a; },Infinity);
            statusHtml=_sChip('upcoming',`Upcoming · starts in ${formatCountdown(earliest-Date.now())}`);
          }else if(currentStatus==='live'){
            const latest=timeslots.reduce((a,ts)=>{ const tsEnd=ts.ended_at?new Date(ts.ended_at):new Date(new Date(ts.start_time).getTime()+ts.duration_minutes*60000); return tsEnd>a?tsEnd:a; },new Date(0));
            statusHtml=_sChip('live',`Live · ${formatDuration(latest.getTime()-Date.now())} left`);
          }else{
            statusHtml=_sChip('ended','Ended');
          }
        }else{
          // Single-slot: original logic
          const start=new Date(comp.start_time);
          const end=comp.ended_at?new Date(comp.ended_at):new Date(start.getTime()+comp.duration_minutes*60000);
          const n=Date.now();
          if(n<start.getTime()){
            currentStatus='upcoming';
            statusHtml=_sChip('upcoming',`Upcoming · starts in ${formatCountdown(start.getTime()-n)}`);
          }else if(n<end.getTime()&&!comp.ended_at){
            currentStatus='live';
            // An open-ended Program (the server's `open_ended`) says "No fixed
            // deadline", never a ten-year countdown (operator ruling, 14 Nov 2026).
            statusHtml=_sChip('live',comp.open_ended===true?`Live · ${NO_FIXED_DEADLINE}`:`Live · ${formatDuration(end.getTime()-n)} left`);
          }else{
            currentStatus='ended';
            // v8.12.6 — a finished Booth Event still taking LATE ENTRIES says so,
            // and until when: it is the one ended state in which this banner's
            // Participants tab can still add people (as late entrants), and plain
            // "Ended" would say the opposite. `currentStatus` stays "ended" — the
            // window extends play, not the event — and the deadline is the
            // server's resolved value, never re-derived here.
            const _late=isLateEntryOpen(comp);
            const _dl=_late&&comp.late_entry_deadline_effective?fmtDt(comp.late_entry_deadline_effective,'long'):'';
            // "Close late entries now" is the ⋯ menu's (from the SERVER's flag
            // only, `can_close_late_entries`), not the chip's.
            statusHtml=_late
              ?_sChip('late-entry',`Ended · late entry open${_dl?` until ${esc(_dl)}`:''}`,' scope-status-late')
              :_sChip('ended','Ended');
          }
        }
        if(S.lastBannerStatus&&S.lastBannerStatus!==currentStatus){
          loadAdminCompetitions();
        }
        S.lastBannerStatus=currentStatus;
      }

      // Timeslot section
      let tsHtml='';
      if(timeslots.length>0){
        if(hasTimeslotSelected){
          // Specific session selected — show only session countdown
          const ts=timeslots.find(t=>t.id===S.adminSelectedTimeslotId);
          if(ts){
            const tsStart=new Date(ts.start_time);
            const tsEnd=ts.ended_at?new Date(ts.ended_at):new Date(tsStart.getTime()+ts.duration_minutes*60000);
            const tsN=Date.now();
            // The session's own Start now / End now are its row's on the
            // Overview's Sessions card; the chip only says where it stands.
            if(tsN<tsStart.getTime()) tsHtml=_sChip('upcoming',`${esc(ts.name)} · starts in ${formatCountdown(tsStart.getTime()-tsN)}`,' scope-ts-status');
            else if(tsN<tsEnd.getTime()&&!ts.ended_at) tsHtml=_sChip('live',`${esc(ts.name)} · ${formatDuration(tsEnd.getTime()-tsN)} left`,' scope-ts-status');
            else tsHtml=_sChip('ended',`${esc(ts.name)} · Ended`,' scope-ts-status');
          }
          tsHtml+=` <button class="btn sm secondary scope-action-sm" data-action="comp-focus" data-comp-id="${esc(comp.id)}" data-comp-name="${esc(comp.name)}">All sessions</button>`;
        }else{
          // No session selected — show clickable session chips
          const tsChips=timeslots.map(ts=>{
            const tsSt=computeCompStatus(ts);
            const cls=tsSt==='live'?'comp-live':tsSt==='ended'?'comp-ended':'comp-upcoming';
            return`<span class="badge comp-badge ${cls}" data-action="comp-focus-ts" role="button" tabindex="0" aria-label="${esc(ts.name)} — open this session" data-comp-id="${esc(comp.id)}" data-comp-name="${esc(comp.name)}" data-ts-id="${esc(ts.id)}" data-ts-name="${esc(ts.name)}">${esc(ts.name)}</span>`;
          }).join('');
          tsHtml=`<span class="scope-ts-chips">${tsChips}</span>`;
        }
      }

      // Title: "Competition > Session" when session selected, just "Competition" otherwise
      const titleHtml=`<strong>${esc(S.adminSelectedCompetitionName)}</strong>${S.adminSelectedTimeslotName?' → <strong>'+esc(S.adminSelectedTimeslotName)+'</strong>':''}`;

      // audit v7.7.36 (P3) — the 1s tick ran setSafeHtml unconditionally,
      // replacing every child node (End Now / Start Now buttons, the tabindex=0
      // session chips, × Clear) even when nothing changed — dropping keyboard
      // focus within ≤1s (so those controls were effectively keyboard-inoperable)
      // and re-parsing the whole banner 3600×/hour on an ended comp. Skip the
      // rebuild when the generated HTML is unchanged, and defer it while focus is
      // inside the banner (don't detach the control the admin is on — the
      // countdown resumes on the next tick after focus leaves).
      // v8.1.0 — "Recording · N active in the last hour", on the banner the admin
      // is already looking at. Rendered ONLY when the event records: the server
      // sends the key only for those, so an absent key means "does not measure"
      // and 0 honestly means "nobody has been active", which are different facts.
      const _pa=comp&&comp.presence_active_recent;
      const presenceHtml=(comp&&Object.prototype.hasOwnProperty.call(comp,'presence_active_recent'))
        ?`<span class="presence-pill" title="Participants active on the platform in the last hour">${ICO.clock} Recording · ${esc(String(_pa||0))} active in the last hour</span>`
        :'';
      // The workspace's LIVE STATUS STRIP. The event's name, kind and facts are
      // the record header's (#ws-record, rendered on explicit changes only); the
      // strip carries what ticks. The name stays here for assistive technology,
      // so the strip reads whole on its own ("Viewing: <event> → <session>").
      // In the compact header the strip is a `display:contents` box: its leave
      // button opens line 1 ("← Events") and its status chip follows the name
      // and kind chip (CSS `order`). The focused session's chip names it.
      const bannerHtml=`<button type="button" class="scope-clear ws-back" data-action="scope-clear" aria-label="Events — leave this event">${ICO.arrowLeft}<span>Events</span></button>
      <div class="scope-content">
        <span class="sr-only">Viewing: ${titleHtml}</span>
        ${statusHtml} ${tsHtml}${presenceHtml}
      </div>`;
      if(bannerHtml===S._lastScopeBannerHtml)return;
      // v8.12.8 — WHEN THE BANNER MAY REPAINT, AND WHERE FOCUS GOES. Three rules,
      // and each one exists because the simpler rule dropped focus somewhere.
      //
      // 1. The 1 s TICK never repaints while focus is inside the banner — it
      //    never detaches the control you are on (the countdown resumes once
      //    focus leaves), save to carry out a held explicit render (rule 3) —
      //    nor while a dialog that hands focus BACK to its opener is open
      //    (`_bannerDialogOpen` lists them). A live countdown changes every
      //    second, so a tick under End Now's confirm, the open switcher, or an
      //    alert or session warning that popped while focus was on a banner
      //    control replaced the very button the dialog restores focus to, and
      //    focus fell to <body>. Behind the dialog's scrim the countdown is not
      //    visible anyway.
      //
      // 2. An EXPLICIT render (renderScopeBanner(): an action, a scope change, a
      //    tab return, the poll's category change) paints even with focus inside,
      //    because it may carry a change the admin must see. It used to defer
      //    like the tick, and after an action pressed FROM the banner (Close late
      //    entries now, End Now, a session's Start Now / End Now) the dialog had
      //    handed focus back to that button, so the caller's own render declined
      //    to paint and the banner kept a button for an act already done. Focus
      //    then goes back to the SAME control in the new banner
      //    (`_refocusBannerControl`), so a tab return that changed nothing does
      //    not move a keyboard or screen-reader user off the chip or × Clear they
      //    were on; only when that control is gone — the act it performed has
      //    happened — does it go to Switch, present in every banner state (the
      //    v7.12.3 #7 precedent). Never to <body>.
      //
      // 3. An explicit render that arrives while such a dialog is open is HELD,
      //    not dropped: painted then, it would replace the button the dialog is
      //    about to hand focus back to (rule 1's failure, through the other
      //    door — a tab return or the 15 s poll lands while a confirm is up).
      //    `S._bannerExplicitPending` records it, and the first tick after the
      //    dialog closes carries it out as an explicit render. When the dialog
      //    was opened from the banner, focus is by then back on that
      //    still-attached button, so rule 2 moves it to the same control in the
      //    new banner — or to Switch, if the act it confirmed has happened.
      //    Dropping it instead would leave the banner as it was before the tab
      //    return for as long as focus stayed inside it.
      const _dialogOpen=_bannerDialogOpen();
      if(explicit&&_dialogOpen){S._bannerExplicitPending=true;return;}
      const _carryOut=!explicit&&!_dialogOpen&&S._bannerExplicitPending;
      const _focused=banner.contains(document.activeElement)?document.activeElement:null;
      if(!explicit&&!_carryOut&&(_focused||_dialogOpen))return;
      S._bannerExplicitPending=false;
      S._lastScopeBannerHtml=bannerHtml;
      setSafeHtml(banner, bannerHtml);
      if(_focused)_refocusBannerControl(banner,_focused);
    };
    renderBannerContent(true);
    syncWorkspaceChrome();
    if(!S._pollsHalted)S.scopeBannerInterval=setInterval(()=>renderBannerContent(false),1000);
  }else{
    // Torn down: a render held for a dialog (rule 3 above) belongs to the banner
    // that no longer exists, and must not carry into the next event's first tick.
    S._bannerExplicitPending=false;
    banner.style.display='none';
    setSafeHtml(banner, '');
    syncWorkspaceChrome();
    if(headerTimer)headerTimer.style.display='none';
  }
}

// v8.12.8 — a dialog is open that will hand focus back to whatever it captured
// when it opened, which can be a scope-banner control: the shared confirm
// (ui/modal.js — Close late entries now, End Now, a session's Start Now / End Now),
// the scope switcher (overlayDismiss → the Switch button), the IP-ban alert
// (overlayDismiss, raised by the 20 s alerts poll) and the session-expiry warning
// (its own `warnOpenerEl`, raised by the idle timer). The last two open on their
// own while focus may be on a banner control. Every overlay here that restores
// focus belongs in this list; see the paint rules in renderScopeBanner.
function _bannerDialogOpen(){
  return !!document.getElementById('modal-overlay')?.classList.contains('open')
    ||!!document.getElementById('admin-alert-overlay')
    ||!!document.getElementById('session-warn-overlay');
}

// v8.12.8 — after an explicit repaint, put focus on the control in the NEW banner
// that is the same one the admin was on: the same data-action, and the same event
// and session where the control names one. When it is gone — the act it performed
// has happened — Switch, the one control present in every banner state.
function _refocusBannerControl(banner,prev){
  const act=prev.getAttribute('data-action');
  let sel=act?`[data-action="${CSS.escape(act)}"]`:'';
  if(sel)for(const a of ['data-comp-id','data-ts-id']){
    const v=prev.getAttribute(a);
    if(v!==null)sel+=`[${a}="${CSS.escape(v)}"]`;
  }
  // `preventScroll`: only the NODE changed, and the control is where the admin
  // left it. A plain focus() scrolled the page back to the banner on every tab
  // return, yanking an admin who had scrolled down a long table to the top.
  ((sel&&banner.querySelector(sel))||banner.querySelector('.scope-clear'))?.focus({preventScroll:true});
}

// Effective status of an event for the picker order: a multi-session event
// derives it from its sessions (mirrors the server's competitionStatus), a
// sessionless one falls back to computeCompStatus on the row itself.
function _scopeCompStatus(c){
  const slots=c.timeslots||[];
  if(slots.length>0){
    const ss=slots.map(ts=>computeCompStatus(ts));
    if(ss.every(s=>s==='ended'))return'ended';
    if(ss.every(s=>s==='upcoming'))return'upcoming';
    return'live';
  }
  return computeCompStatus(c);
}

/** The picker band: live 0, upcoming 1, ended (or any other value) 2. */
function _pickerBand(c){
  const s=_scopeCompStatus(c);
  return s==='live'?0:s==='upcoming'?1:2;
}

// THE order of every admin event picker, every list that asks "which event?"
// (grep compareCompsForPicker for them): live first, then upcoming by SOONEST
// start, then ended by LATEST start; name, then id, breaks a tie, so the order is
// total and a re-render never reshuffles equal rows.
//
// Ended events go last, newest first (operator ruling, 24 Nov 2026). By start
// ascending alone, the pickers that list ended events (Users & roles' Events
// dialog, the Audit event filter, Grant attempts, Analytics) put the oldest
// finished event above the next upcoming one. An event taking late entries is
// ended (late entry is a display category, never a status), so it sorts with
// the ended ones. Starts are the effective ones (a multi-session event starts
// with its first session). Never "fix" a picker by flipping the server's
// `ORDER BY start_time DESC`, which other readers rely on.
export function compareCompsForPicker(a, b){
  const ba=_pickerBand(a), bb=_pickerBand(b);
  if(ba!==bb)return ba-bb;
  const d=_compEffectiveBounds(a).start-_compEffectiveBounds(b).start;
  if(d!==0)return ba===2?-d:d;   // ended: the latest start first
  return String(a.name||'').localeCompare(String(b.name||''))||String(a.id).localeCompare(String(b.id));
}

export async function loadAdminCompetitions(opts){
  // v8.7.0 — an event admin cannot create a BLANK event: the server refuses
  // `POST /api/admin/competitions` outright, so leaving the button up would open
  // a whole create wizard whose Save is certain to fail (v7.14.2). Set BOTH ways
  // and from the loader rather than once at boot, because the participant-view
  // toggle and a role change both re-enter this pane without a reload.
  //
  // Hidden rather than disabled-with-a-note: their doors are a template (New
  // event in the sidebar) and ⋯ → Clone on one of their events, which the guide
  // names. A disabled control invites the reader to look for a way to enable it.
  // RBAC — the button asks the permission its route enforces (`events.create`,
  // which the built-in event admin does not hold).
  const _newCompBtn=document.getElementById('new-competition-btn');
  if(_newCompBtn)_newCompBtn.style.display=adminCan('events.create')?'':'none';
  // RBAC — a role that may not read events sends no read: the refusal would
  // toast on every 15 s poll and count towards the address's scanner block.
  if(!adminCan('events.view'))return;
  showLoading();
  const mySeq=++S._compFetchSeq;                     // ext-audit v7.15.13 — see _subFetchSeq
  // v7.23.5 (audit Wave 5) — r.ok checked, and the model keeps its TYPE.
  // A 500's JSON body is an OBJECT, and `.catch(()=>[])` only fires when the
  // PARSE fails — so `{error:"Boom"}` was assigned straight into
  // S.adminCompetitionsData. MEASURED: "rows.slice is not a function" and
  // "S.adminCompetitionsData.find is not a function", a blank table and no
  // message of any kind. Reporting the failure without resetting the slot would
  // leave both TypeErrors in place.
  let _comps=null;
  try{ const r=await fetch('/api/admin/competitions'); if(r.ok) _comps=await r.json(); }catch(e){ console.warn('Could not load events',e); }
  if(!Array.isArray(_comps)) _comps=null;
  hideLoading();
  if(mySeq!==S._compFetchSeq)return;                 // a newer load already landed
  if(!_comps){
    renderLoadFailure('admin-comp-body',{colspan:colspanFor('admin-comp-body'),noun:'events',
      resetModel:()=>{S.adminCompetitionsData=[];S._adminCompsLoaded=false;}});
    showToast('Could not load events.','error');
    return;
  }
  S.adminCompetitionsData=_comps;
  S._adminCompsLoaded=true;
  if(!opts||!opts.keepPage)S.cPage=1;
  renderAdminCompetitions();
  resyncParticipantsWithFocus();
}

export function toggleCompFilter(btn){
  const status=btn.dataset.status;
  const btns=document.querySelectorAll('#comp-status-filters .filter-btn');
  if(status==='all'){
    // All: clear specific filters, select All
    S.compStatusFilters.clear();
    btns.forEach(b=>b.classList.toggle('active',b.dataset.status==='all'));
  }else{
    // Toggle specific filter
    if(S.compStatusFilters.has(status))S.compStatusFilters.delete(status);
    else S.compStatusFilters.add(status);
    // If every specific chip is selected, or none is left, switch to All.
    // v8.8.0 — DERIVED from the rendered chips rather than the literal 3 it used
    // to be: a fourth chip landed here and a hard-coded count would have left
    // "all selected" unreachable, so the All chip could never light up again.
    const _specific=Array.from(btns).filter(b=>b.dataset.status!=='all').length;
    if(S.compStatusFilters.size===0||S.compStatusFilters.size===_specific){
      S.compStatusFilters.clear();
      btns.forEach(b=>b.classList.toggle('active',b.dataset.status==='all'));
    }else{
      btns.forEach(b=>{
        if(b.dataset.status==='all')b.classList.remove('active');
        else b.classList.toggle('active',S.compStatusFilters.has(b.dataset.status));
      });
    }
  }
  S.cPage=1;renderAdminCompetitions();
}

// v8.1.0 (PR 13) — the kind filter row, built from the shell-injected table.
//
// It REFUSES to render when the vocabulary is absent, which is the deliberate
// opposite of the chip's behaviour a few lines up. The axis: a surface renders
// nothing when it merely LABELS something (the chip — the row keeps its name and
// dates and loses only the chip), and refuses when it IS the vocabulary. Three
// filter chips reading booth / tournament / program would teach the wrong words to
// the one admin trying to learn them.
export function renderCompKindFilters(){
  const box=document.getElementById('comp-kind-filters');
  if(!box)return;
  const kinds=Array.isArray(S.eventKinds)?S.eventKinds:[];
  if(!kinds.length){ setSafeHtml(box,''); return; }
  // Build ONCE and then only toggle classes, exactly as the status row beside it
  // does. The competitions list re-renders on a 15-second poll, and re-emitting
  // these buttons on every tick would blow away the focus ring of an admin
  // tabbing through them — the same class of defect as a search box living inside
  // the container its own handler re-renders (v7.20.10).
  if(box.childElementCount === kinds.length + 1) { _syncCompKindChips(); return; }
  const chip=(value,label)=>
    `<button class="filter-btn" data-kind="${esc(value)}" data-action="toggle-comp-kind-filter" aria-pressed="false">${esc(label)}</button>`;
  setSafeHtml(box, chip('all','All types')+kinds.map(k=>chip(k.value,k.plural)).join(''));
  _syncCompKindChips();
}

function _syncCompKindChips(){
  const sel=S.compKindFilters;
  document.querySelectorAll('#comp-kind-filters .filter-btn').forEach(b=>{
    const on=b.dataset.kind==='all'?sel.size===0:sel.has(b.dataset.kind);
    b.classList.toggle('active',on);
    b.setAttribute('aria-pressed',on?'true':'false');
  });
}

export function toggleCompKindFilter(btn){
  const kind=btn.dataset.kind;
  const total=(Array.isArray(S.eventKinds)?S.eventKinds:[]).length;
  if(kind==='all'){
    S.compKindFilters.clear();
  }else{
    if(S.compKindFilters.has(kind))S.compKindFilters.delete(kind);
    else S.compKindFilters.add(kind);
    // Every kind selected means the same set as none — collapse to All so the row
    // cannot sit in a state that reads as filtered while filtering nothing.
    if(S.compKindFilters.size===0||S.compKindFilters.size===total)S.compKindFilters.clear();
  }
  _syncCompKindChips();
  S.cPage=1;renderAdminCompetitions();
}

export function sortCompetitions(col){
  if(S.cSortCol===col)S.cSortAsc=!S.cSortAsc;else{S.cSortCol=col;S.cSortAsc=true;}
  S.cPage=1;renderAdminCompetitions();
}

// ── v8.17.0 — the Events list's columns (ui/table-columns.js; defined from boot()) ──
// Every heading already sorts through sort-competitions, so the menus drive that
// sort and the default total order (status band, latest end, name, id) stands
// until one is chosen. The filters read the MODEL: they narrow every loaded event
// before paging, beside the Filters panel's chips (which stay).
const _isoOrEmpty=(ms)=>Number.isFinite(ms)?new Date(ms).toISOString():'';
export const EVENT_TABLE_COLUMNS={
  noun:'event',
  // Duration, Tags, Challenges and Sessions are under Columns: with them the
  // default set does not fit a 1024 px window (measured: 907 px of table in a
  // 674 px card). Start and End say how long an event runs; tags, challenges
  // and sessions are each a click away in the event's workspace.
  defaults:['name','start','end','status','participants','actions'],
  fixed:['name','actions'],
  cols:{name:{grow:true},start:{filter:'date'},end:{filter:'date'},
    // A function, read when the menu opens: competition-picker.js is in an
    // import cycle with this module, so its label table is not initialised yet
    // when this object is built.
    status:{filter:'enum',options:()=>Object.values(COMP_CATEGORY_LABEL)},
    tags:{filter:'tags'},sessions:{filter:'tags'}},
  model:{
    rows:()=>S.adminCompetitionsData||[],
    get:(c,k)=>{switch(k){
      case 'name':return c.name||'';
      case 'start':return _isoOrEmpty(_compEffectiveBounds(c).start);
      case 'end':return _isoOrEmpty(_compEffectiveBounds(c).end);
      case 'duration':return c.open_ended===true?NO_FIXED_DEADLINE:formatDuration((_compEffectiveBounds(c).duration||0)*60000);   // what the cell shows
      case 'status':return COMP_CATEGORY_LABEL[compDisplayCategory(c)]||'';
      case 'tags':return c.tags||[];
      case 'participants':return c.participant_count!=null?Number(c.participant_count):'';
      case 'challenges':return c.task_count!=null?Number(c.task_count):'';
      case 'sessions':return (c.timeslots||[]).map(ts=>ts.name||'');
      default:return '';
    }},
    onChange:()=>{S.cPage=1;renderAdminCompetitions();},
  },
};

export function _compEffectiveBounds(c){
  const slots=c.timeslots||[];
  if(slots.length>0){
    const start=Math.min(...slots.map(ts=>new Date(ts.start_time).getTime()));
    const end=Math.max(...slots.map(ts=>{const st=new Date(ts.start_time).getTime();return ts.ended_at?new Date(ts.ended_at).getTime():(st+ts.duration_minutes*60000);}));
    return{start,end,duration:Math.round((end-start)/60000)};
  }
  const start=new Date(c.start_time).getTime();
  const end=c.ended_at?new Date(c.ended_at).getTime():(start+c.duration_minutes*60000);
  return{start,end,duration:c.duration_minutes};
}

// The event's own menu on the Events list (Edit, History, Organisers, Email
// Delivery, exports, the join link, the lifecycle doors). The workspace
// header's ⋯ menu is a SECOND builder (`wsMenuItemsHtml`, event-workspace.js)
// with a different set of doors by design; every door the two share must answer
// the same for the same event and viewer, which tests/menu-door-parity.spec.js
// locks across a matrix of states. Change a shared predicate in both.
export function compMenuItemsHtml(c){
  const status=computeCompStatus(c);
  let km='';
  // v8.12.7 — in practice always false, and NOT "closed early, still editable
  // until the original end": `competitionEffectiveEnd` clamps an ended event to
  // MIN(ended_at, scheduled end), so the effective end of anything the server
  // calls `ended` has already passed when the list is built (End Now included —
  // its `ended_at` is the moment it ran). It reads true only while this
  // browser's clock lags the server's. The PUT's matching allowance (a regular
  // admin may edit an ended event whose effective end is still ahead) is just as
  // unreachable. Kept so this gate, the Join Link dialog and that 403 agree.
  const endedButFuture=status==='ended'&&c.effective_end&&new Date(c.effective_end)>new Date();
  // v8.12.0 — THE ACTOR COMPETES IN THIS EVENT. Every mutating door on it
  // refuses them (server: `competitorEditDenied`, all tiers), so the controls
  // that reach those doors are withheld WITH THE REASON (v7.14.2) rather than
  // offered and refused. The read-only items — Focus, History, Organisers,
  // Email Delivery, Export Activity — stay; viewing is not editing. The
  // server sends `competing` per row, computed from the same predicate the
  // routes enforce, so the menu and the refusal cannot disagree.
  const competing=!!c.competing;
  if(competing)km+=`<div class="kebab-note" role="presentation">${ICO.lock} You are competing in this event — you can view it, not change it</div>`;
  // RBAC — every door also asks the permission of the route it ends at (ui/nav.js
  // adminCan; the built-in roles answer exactly as before). The workspace's ⋯
  // menu (wsMenuItemsHtml) asks the same, door for door.
  const canEdit=!competing&&(status!=='ended'||S.isSuperAdmin||endedButFuture)&&adminCan('events.edit');
  const isLive=status==='live';
  // Severity: live competitions make Edit/Assign Challenges elevated (warning); normal otherwise
  const editCls=isLive?'km-warning':'';
  const assignChallengesCls=isLive?'km-warning':'';
  // Every button's onclick= has been migrated to data-action + data-comp-id.
  // The dispatcher auto-calls closeKebab() for any click inside .kebab-menu.
  // The compName values go through esc() once (HTML escape only) — no more
  // nested-quote escaping like '${esc(c.name).replace(/'/g,"\\'")}' that
  // used to fight two escape contexts at once.
  if(canEdit){
    km+=`<button class="${editCls}" data-action="comp-edit" data-comp-id="${esc(c.id)}">${ICO.edit} Edit</button>`;
  }
  km+=`<button data-action="comp-history" data-comp-id="${esc(c.id)}">${ICO.clock} History</button>`;
  // v8.7.0 — WHO ELSE ORGANISES THIS EVENT. Offered to every admin tier: an
  // event admin sharing a stand needs to know who their colleagues are, and
  // the route is scope-checked, so on their own event it answers and anywhere
  // else it refuses. Read-only from here — granting is admin-and-above and
  // lives on the participant's row, where the person being granted is.
  km+=`<button data-action="comp-organisers" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">${ICO.users} Organisers</button>`;
  // v8.1.0 — the delivery panel (see showCompetitionDelivery). A read-only
  // diagnostic, so it sits with History and the activity export rather than
  // among the state-changing actions.
  //
  // Deliberately NOT gated on `status`, unlike the export below. The moment an
  // organiser most wants these numbers is the night before, while people are
  // still registering through the join link — a live/ended gate would hide it
  // exactly then, and it would also make the menu's shape depend on lifecycle
  // for a request that has no lifecycle rule behind it.
  km+=`<button data-action="comp-delivery" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">${ICO.mailCheck} Email Delivery</button>`;
  // v7.23.0 — challenge-activity CSV. Live or ended only: nothing has happened
  // in a competition that has not started, so the file would be all-No by
  // construction. Gated on the EXISTING `status` local (line ~622), which
  // prefers the server-computed, timeslot-aware `c.status` — the same value
  // the endpoint re-checks, so the menu and the refusal cannot disagree.
  if((status==='live'||status==='ended')&&adminCan('export.data')){
    km+=`<button data-action="comp-export-activity" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">${ICO.download} Export Activity (CSV)</button>`;
  }
  // v8.12.6 — an ended Booth Event still taking LATE ENTRIES is open to new
  // members at every admin door (the server's `competitionAdmission`), so its
  // Manage Participants entry point stays. Assign Challenges does NOT follow it:
  // a challenge list freezes once the event has ended (FROZEN_REMEDY), whatever
  // the late window says — only the ROSTER is open, which is the whole point.
  const _lateOpen=isLateEntryOpen(c);
  if(status!=='ended'&&!competing&&adminCan('challenges.assign')&&adminCan('challenges.view')){
    km+=`<button class="${assignChallengesCls}" data-action="comp-assign-challenges" data-comp-id="${esc(c.id)}">${ICO.clipboardCheck} Assign Challenges</button>`;
  }
  if((status!=='ended'||_lateOpen)&&!competing&&adminCan('participants.view')){
    km+=`<button data-action="comp-manage-participants" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">${ICO.users} Manage Participants</button>`;
  }
  // v8.12.0 — the Join Link is a READ (the reveal route is `requireAdmin` and
  // changes nothing), so a competitor keeps it: the dialog opens READ-ONLY for
  // them — link, QR and code shown, the toggle and Regenerate withheld
  // with the reason (the operator's ruling, 19 Sep 2026). An organiser
  // competing in their own event still needs the link on the signage.
  // v8.12.6 — and it stays offered through the late-entry window, because the
  // link, QR and code keep WORKING until the late-entry deadline and the
  // organiser needs them for the signage then too. The dialog says which of its
  // settings can still be changed on a finished event (openSelfEnrollOverlay).
  if((status!=='ended'||_lateOpen)&&adminCan('events.join_link')){
    km+=`<button data-action="comp-self-enroll" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">${ICO.link} Join Link</button>`;
  }
  // v8.12.8 — close a finished Booth Event's late-entry window NOW, to the
  // second, without a superadmin. Gated on the SERVER's flag ONLY — the route's
  // own predicate (`lateEntryCloseState`) plus the competitor lock — and never
  // on `_lateOpen && !competing`: a client re-derivation would outlive the next
  // server-side condition and offer a control the route refuses (v7.14.2). A
  // competitor is withheld it with the reason the note at the top already gives.
  // The hourglass, not End Now's stop icon (a different act) and not the lock
  // (which means "cannot change" in every note on this screen).
  if(c.can_close_late_entries&&adminCan('events.run')){
    km+=`<button class="km-danger" data-action="comp-close-late-entries" data-comp-id="${esc(c.id)}">${ICO.hourglass} Close late entries now</button>`;
  }
  const isUpcomingSingle=status==='upcoming'&&(c.timeslots||[]).length===0;
  if(isUpcomingSingle&&!competing&&adminCan('events.edit')){
    // Start Now is elevated (warning) — user explicitly requested
    km+=`<button class="km-warning" data-action="comp-start-now" data-comp-id="${esc(c.id)}">${ICO.play} Start Now</button>`;
  }
  if(isLive&&!competing&&adminCan('events.run')){
    km+=`<button class="km-danger" data-action="comp-end-now" data-comp-id="${esc(c.id)}">${ICO.stop} End Now</button>`;
  }
  if(adminCan('events.delete')&&!competing){
    km+=`<button class="km-danger" data-action="comp-delete" data-comp-id="${esc(c.id)}">${ICO.trash} Delete</button>`;
  }
  return km;
}

export function renderAdminCompetitions(){
  const tbody=document.getElementById('admin-comp-body');
  // v8.1.0 (PR 13) — idempotent: builds the chips on the first render and only
  // syncs their active state thereafter, so the poll cannot steal focus.
  renderCompKindFilters();
  // v7.16.7 — the sort below works on THIS local copy, never on
  // S.adminCompetitionsData itself. See the note at the sort.
  let rows=S.adminCompetitionsData;
  // Clear sort icons
  document.querySelectorAll('[id^="sort-comp-"][id$="-icon"]').forEach(el=>el.textContent='');
  // Sort: if a column is selected, use it; otherwise default to live/upcoming/ended chronological
  if(S.cSortCol){
    const ic=document.getElementById(`sort-comp-${S.cSortCol}-icon`);
    if(ic)ic.textContent=S.cSortAsc?' ▲':' ▼';
    _syncSortAria(ic,S.cSortAsc); // audit v7.7.33 (AL10)
    const statusOrder={live:0,upcoming:1,ended:2};
    // v7.16.7 — sort a COPY. Both branches used to sort S.adminCompetitionsData in
    // place, permanently reordering the canonical array that every other reader
    // shares — the scope banner, the switcher, endTimeslotNow and editTimeslot all
    // look competitions up in it, and anything holding a positional index into it
    // silently pointed at a different row after a header click.
    rows = rows.slice().sort((a,b)=>{
      let va,vb;
      switch(S.cSortCol){
        case 'name':va=(a.name||'').toLowerCase();vb=(b.name||'').toLowerCase();break;
        case 'start':va=_compEffectiveBounds(a).start;vb=_compEffectiveBounds(b).start;break;
        case 'end':va=_compEffectiveBounds(a).end;vb=_compEffectiveBounds(b).end;break;
        case 'duration':va=_compEffectiveBounds(a).duration;vb=_compEffectiveBounds(b).duration;break;
        case 'status':va=statusOrder[computeCompStatus(a)]??2;vb=statusOrder[computeCompStatus(b)]??2;break;
        case 'participants':va=Number(a.participant_count||0);vb=Number(b.participant_count||0);break;
        case 'challenges':va=Number(a.task_count||0);vb=Number(b.task_count||0);break;
        case 'sessions':va=(a.timeslots||[]).length;vb=(b.timeslots||[]).length;break;
        case 'tags':va=(a.tags||[]).join(',').toLowerCase();vb=(b.tags||[]).join(',').toLowerCase();break;
        case 'groups':va=(a.groups||[]).map(g=>g.name).join(',').toLowerCase();vb=(b.groups||[]).map(g=>g.name).join(',').toLowerCase();break;
        default:va='';vb='';
      }
      if(typeof va==='number')return S.cSortAsc?va-vb:vb-va;
      return S.cSortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
    });
  }else{
    // v7.22.0 — DEFAULT: live first, then upcoming, then ended; and within each
    // group by FINISHING TIME, latest first.
    //
    // The status grouping is kept deliberately (the operator's call): an admin
    // running an event wants today's work at the top, and a flat finish-time
    // ordering would put an upcoming competition ending in a month ABOVE a live
    // one ending in two hours. What changes is the order INSIDE each group — it
    // used to be three different rules (live by end soonest, upcoming by start
    // soonest, ended by end most recent), so the same column meant a different
    // thing in each band and neither of the first two put the newest first.
    //
    // It reads the EFFECTIVE end via _compEffectiveBounds, the same helper the
    // "End" column sort uses. The old inline arithmetic derived the end from the
    // competition's OWN start + duration, which is simply wrong for a
    // multi-session competition — the real end is the latest session's — so the
    // default order disagreed with the column the admin could click to sort by
    // it. One definition now serves both.
    const statusOrder={live:0,upcoming:1,ended:2};
    // v7.16.7 — sort a COPY. Both branches used to sort S.adminCompetitionsData in
    // place, permanently reordering the canonical array that every other reader
    // shares — the scope banner, the switcher, endTimeslotNow and editTimeslot all
    // look competitions up in it, and anything holding a positional index into it
    // silently pointed at a different row after a header click.
    rows = rows.slice().sort((a,b)=>{
      const sa=statusOrder[computeCompStatus(a)]??2,sb=statusOrder[computeCompStatus(b)]??2;
      if(sa!==sb)return sa-sb;
      const d=_compEffectiveBounds(b).end-_compEffectiveBounds(a).end;   // latest finish first
      if(d!==0)return d;
      // A TOTAL order, so the 15-second poll cannot reshuffle rows that finish
      // at the same instant — two competitions created from one form share a
      // duration and a start far more often than the general case suggests
      // (v6.10.54: without a total order, equal-key rows swap between fetches).
      return String(a.name||'').localeCompare(String(b.name||''))||String(a.id).localeCompare(String(b.id));
    });
  }
  // Filter by status (multi-select; if none selected show all)
  let filtered=rows;
  // v8.8.0 — filtered on the DISPLAY category, so a late-entry event answers to
  // its own chip and NOT to Ended. That separation is the point: leaving it in
  // Ended too would mean the new chip narrowed nothing an operator could see.
  if(S.compStatusFilters.size>0)filtered=filtered.filter(c=>S.compStatusFilters.has(compDisplayCategory(c)));
  // v8.1.0 (PR 13) — filter by KIND. Keyed on the stored value, never the label:
  // the chip carries data-kind="tournament" and the row carries event_kind, so a
  // rename cannot break the filter.
  if(S.compKindFilters&&S.compKindFilters.size>0)filtered=filtered.filter(c=>S.compKindFilters.has(c.event_kind));
  // Filter by search — matches competition name or any session name
  const q=(document.getElementById('comp-search')?.value||'').toLowerCase().trim();
  if(q)filtered=filtered.filter(c=>{
    if(c.name.toLowerCase().includes(q))return true;
    if((c.tags||[]).some(t=>t.toLowerCase().includes(q)))return true;
    return (c.timeslots||[]).some(ts=>(ts.name||'').toLowerCase().includes(q));
  });
  // v8.17.0 — the heading filters (ui/table-columns.js), over every loaded event,
  // before paging. The ORDER is untouched: every heading sorts through its own
  // sort-competitions handler, so the default total order above still holds
  // until a heading is chosen.
  const _colFiltered=hasColumnFilters('events');
  filtered=applyColumnFilters('events',filtered);
  const totalFiltered=filtered.length;
  const totalPages=Math.max(1,Math.ceil(totalFiltered/S.cPageSize));
  if(S.cPage>totalPages)S.cPage=totalPages;
  const startIdx=(S.cPage-1)*S.cPageSize;
  const pageData=filtered.slice(startIdx,startIdx+S.cPageSize);

  // v7.20.11 — paint the count BEFORE the zero-match early return. v7.20.10 put
  // it after, so the one case an operator most needs a count for — "did my
  // search find nothing, or is the list empty?" — left the PREVIOUS query's
  // number on screen. `filtered` folds in the status chips as well as the text
  // box, because a chip narrows the list just as much and a count that ignored
  // it would report "12 competitions" over three rows.
  // With no events at all nothing is HIDDEN, so the count says "0 events", not
  // that the filter hid every one.
  setListCount('comp-search',{matched:totalFiltered,total:(S.adminCompetitionsData||[]).length,filtered:(S.adminCompetitionsData||[]).length>0&&(!!q||!!(S.compStatusFilters&&S.compStatusFilters.size)||_colFiltered),queried:!!q||_colFiltered});
  if(!filtered.length){
    // The empty row says WHY, and offers the way out when the status chips (not
    // the search box) are what hide every event: the chip row's own count line
    // is a terse summary, this is where an organiser looks.
    const _chipHidden=!q&&S.compStatusFilters&&S.compStatusFilters.size>0&&(S.adminCompetitionsData||[]).length>0;
    const compEmptyMsg=q?'No events match the current search.'
      :_colFiltered?'No event matches the column filters. <button type="button" class="btn sm secondary table-empty-action" data-tcol-clear="events">Clear column filters</button>'
      :_chipHidden?'No event matches the selected statuses. <button type="button" class="btn sm secondary table-empty-action" data-action="toggle-comp-filter" data-status="all">Show all events</button>'
      :'No events found.';
    const freshEmpty=document.createElement('tbody');
    setSafeHtml(freshEmpty, `<tr><td colspan="10" class="table-empty-row">${compEmptyMsg}</td></tr>`);
    patchTableRows(tbody, freshEmpty);
    setHtmlIfChanged(document.getElementById('comp-pagination'), '');
    S._compRenders++;S._compRenderedQuery=q;
    return;
  }
  // v9.2.5 — PATCHED, not repainted: the 15 s poll renders this table whether
  // or not anything changed, and a replaced row loses a press that straddles it
  // (ui/list-controls.js patchTableRows). A row unchanged at its place keeps its node.
  const fresh=document.createElement('tbody');
  setSafeHtml(fresh, pageData.map(c=>{
    const slots=c.timeslots||[];
    const isMulti=slots.length>0;
    let start,end,durMin;
    if(isMulti){
      // Effective start = earliest slot start; effective end = latest slot end
      start=new Date(Math.min(...slots.map(ts=>new Date(ts.start_time).getTime())));
      end=new Date(Math.max(...slots.map(ts=>{
        const tsStart=new Date(ts.start_time).getTime();
        return ts.ended_at?new Date(ts.ended_at).getTime():(tsStart+ts.duration_minutes*60000);
      })));
      durMin=Math.round((end.getTime()-start.getTime())/60000);
    }else{
      start=new Date(String(c.start_time));
      end=c.ended_at?new Date(String(c.ended_at)):new Date(start.getTime()+Number(c.duration_minutes)*60000);
      durMin=c.duration_minutes;
    }
    const status=computeCompStatus(c);
    // v6.10.1: coloured status dots — inline SVG circle (filled via
    // `fill:currentColor`) so rendering is uniform across OSes. Pre-
    // v6.10.1 this used the `●` HTML dingbat (`&#9679;`) which
    // rendered with different baselines on Windows vs macOS.
    const dot=`<svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" style="color:${status==='live'?'var(--green)':status==='upcoming'?'var(--yellow)':'var(--muted)'};vertical-align:middle"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>`;
    // v6.16.46 — LIVE gets the design-system pulsing .live-dot
    // (CSS-only; carries its own glow + animation). Upcoming/ended
    // keep the static SVG dot since they aren't "happening now."
    // v8.8.0 — an ended event whose late-entry window is still open gets its own
    // badge rather than reading "Ended", which is the distinction the operator
    // asked for. `status` above is UNTOUCHED and still three-valued: it gates the
    // edit/freeze rules further down this renderer, and widening it would move
    // those with it.
    const _cat=compDisplayCategory(c);
    const statusBadge=_cat==='live'?`<span class="status-badge live"><span class="live-dot"></span>Live</span>`
      :_cat==='upcoming'?`<span class="status-badge upcoming">${dot} Upcoming</span>`
      :_cat==='late-entry'?`<span class="status-badge late-entry">${dot} ${COMP_CATEGORY_LABEL['late-entry']}</span>`
      :`<span class="status-badge ended">${dot} Ended</span>`;
    const isIntComp=(c.tags||[]).includes(DRY_RUN_TAG);
    const participants=c.participant_count!=null?Number(c.participant_count):'-';
    const tasks=c.task_count!=null?Number(c.task_count):'-';
    const sessionInfo=(c.timeslots||[]).length>0
      ?(c.timeslots||[]).map(ts=>{
        const tsSt=computeCompStatus(ts);
        const cls=tsSt==='live'?'comp-live':tsSt==='ended'?'comp-ended':'comp-upcoming';
        const isSelectedTs=S.adminSelectedTimeslotId===ts.id&&S.adminSelectedCompetitionId===c.id;
        const tsExtra=isSelectedTs?'background:var(--accent-strong);color:var(--on-accent);outline:2px solid var(--focus);outline-offset:1px;font-weight:var(--fw-semibold)':'';
        const tsIntStyle=isIntComp?'border-bottom:2px solid var(--yellow);':'';
        return`<span class="badge comp-badge ${cls}" style="cursor:pointer;font-size:var(--fs-12);${tsExtra}${tsIntStyle}" ${isIntComp?'title="Session of a test / dry run event"':''} data-action="comp-open-ts" role="button" tabindex="0" aria-label="${esc(ts.name)} — open this session" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}" data-ts-id="${esc(ts.id)}" data-ts-name="${esc(ts.name)}">${esc(ts.name)}</span>`;
      }).join(' ')
      :'<span style="color:var(--muted)">—</span>';
    const km=compMenuItemsHtml(c);
    const competing=!!c.competing;
    // Primary action: OPEN the event's workspace. The whole name cell opens it
    // too; every state-dependent door (Edit, End Now, Delete, ...) is in the menu.
    // An ENDED, ranked event offers its top three certificates in one click
    // (event-workspace.js `downloadTop3`; the one predicate, `top3Offered`, which
    // also asks the role for `certificates.view`). Secondary, never gold: one row
    // per ended event, and a screen has ONE gold action (styles.css `.btn.gold`).
    const top3Btn=top3Offered(c)
      ?`<button class="btn sm secondary" data-action="comp-top3" data-comp-id="${esc(c.id)}" aria-label="Top 3 certificates — download the ZIP for ${esc(c.name)}">${ICO.download} Top 3</button>`:'';
    const primaryBtn=`${top3Btn}<button class="btn sm secondary" data-action="comp-open" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}" aria-label="Open ${esc(c.name)}">Open ${ICO.chevronRight}</button>`;
    const intRowStyle=isIntComp?'border-left:3px solid var(--yellow)':'';
    return`<tr class="ev-row" style="${intRowStyle}" ${isIntComp?'title="Test / dry run event"':''}>
      <td class="ev-name-cell" style="cursor:pointer;font-weight:var(--fw-semibold)" data-action="comp-open" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}"> ${esc(c.name)}${eventKindChipHtml(c.event_kind)}</td>
      <td style="font-size:var(--fs-12);color:var(--muted)">${fmtDt(start,'long')}</td>
      <td style="font-size:var(--fs-12);color:var(--muted)">${esc(eventEndText(c,end,'long'))}</td>
      <td>${c.open_ended===true?NO_FIXED_DEADLINE:formatDuration(durMin*60000)}</td>
      <td>${statusBadge}</td>
      <td style="min-width:100px;white-space:normal">${(c.tags||[]).map(t=>`<span class="tag"${t===DRY_RUN_TAG?' title="Test / dry run — excluded from analytics by default"':''}>${esc(t)}${competing?'':`<span class="tag-x" data-action="comp-tag-remove" data-comp-id="${esc(c.id)}" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)} from ${esc(c.name)}">×</span>`}</span>`).join('')}${competing?'':`<span class="tag-add" data-action="comp-tag-add" data-comp-id="${esc(c.id)}">+ tag</span>`}</td>
      <td>${participants}</td>
      <td>${tasks}</td>
      <td>${sessionInfo}</td>
      <td><div class="action-cell comp-actions" style="gap:4px">${primaryBtn}</div>
        <button class="kebab-btn kebab-always" aria-label="More actions" data-action="kebab-toggle">⋮</button>
        <div class="kebab-menu">${km}</div>
      </td>
    </tr>`;
  }).join(''));
  patchTableRows(tbody, fresh);

  setHtmlIfChanged(document.getElementById('comp-pagination'), paginationHtml('comps', {page:S.cPage,totalPages,totalLabel:`${totalFiltered} total`,pageSize:S.cPageSize}));
  S._compRenders++;S._compRenderedQuery=q;
}

// ── NEW EVENT: one place ─────────────────────────────────────────────────────
//
// Every new event starts on the New event page (features/templates-admin.js):
// a blank starter per kind, or a template. Either opens the ONE create form
// below, with the kind pre-selected as a field. The form renders only the
// controls that kind's wire POLICY allows; changing the kind re-renders it (a
// control the platform refuses for a kind is never on screen, and never sent).
// There is no pre-selected kind without a choice: the page has no default
// button, so an admin always picks a starter first.
export function openNewEventPage(){
  // The page is an admin pane, and nav.js imports this module, so the pane is
  // opened through its sidebar item rather than by importing adminTab (cycle).
  const item=document.querySelector('.admin-nav-item[data-tab-id="admin-templates-tab"]');
  if(item){item.click();return;}
  showToast('Cannot open New event: reload the page and try again.','error');
}

// The kind control on the form. On a CREATE it re-renders the form for the new
// kind, carrying what the admin has typed (name, start, timezone) and the
// template it started from. On an EDIT the change is consequential, so it goes
// through `compKindPick`, which confirms and names what the new type turns off.
export async function compKindSelect(el){
  const kind=el&&el.value;
  if(!kind)return;
  const editId=document.getElementById('comp-edit-id')?.value||'';
  // Put the control back until the change is confirmed: the confirmation
  // re-renders the form, a cancel must leave it showing the current type.
  const cur=_compFormKind();
  const putBack=()=>document.querySelectorAll('input[name="comp-kind-seg"]').forEach(r=>{r.checked=r.value===cur;});
  if(editId){
    putBack();
    compKindPick(kind,editId);
    return;
  }
  const ov=document.getElementById('comp-form-overlay');
  // The re-render carries the name, the start, the template and the ticked
  // challenges; every other control goes back to the new type's defaults. When
  // the admin has changed one of those, say so before throwing it away, as the
  // edit's own type change does.
  if(ov&&typeof ov._kindSnap==='string'&&_compFormKindSnap(ov)!==ov._kindSnap){
    putBack();
    const label=eventKindLabel(kind)||eventCollectiveSingular();
    const ok=await showModal({
      title:`Change type to ${label}?`,
      message:`The name, the start, the template and the ticked challenges are kept. <strong>Every other setting you changed</strong> (duration or deadline, sessions, attempts, Advanced settings) goes back to the defaults for ${esc(label)}.`,
      confirmText:'Change type',
    });
    if(!ok||!document.body.contains(ov))return;
  }
  const carry={
    name:document.getElementById('comp-name')?.value||'',
    date:document.getElementById('comp-date')?.value||'',
    time:document.getElementById('comp-time')?.value||'',
    tz:document.getElementById('comp-tz')?.value||'',
    // The event a refused first save already made from the template: the
    // re-rendered form still finishes it (`_markSpawnedForm`), with what this
    // form knows of its token (`saveCompetition`).
    spawned:ov&&ov._spawned||null,
    spawnedLost:ov&&ov._spawnedLost||null,
    spawnedToken:ov&&ov._spawnedToken||null,
  };
  const template=ov?ov._template||null:null;
  ov?.remove();
  openCompetitionForm(null,{kind,carry,template});
  setTimeout(()=>document.querySelector(`input[name="comp-kind-seg"][value="${CSS.escape(kind)}"]`)?.focus(),0);
}

// The type change on an EDIT: confirmed, naming the settings the new type
// turns off, then the form is re-rendered for the target kind.
export async function compKindPick(kind,editId){
  editId=editId||'';
  // v8.3.0 — on an EDIT the pick is consequential, so it is CONFIRMED and the
  // confirmation NAMES the settings the new type will turn off. The server
  // forces those resets (a Program cannot keep a group leaderboard), and a
  // stored setting changing without the admin being told is the class this
  // codebase repeatedly treats as a defect — telling them at the moment they
  // can still say no is the cheap half of not doing that.
  //
  // Nothing here compares the kind to a stored value: the resets are read off
  // the TARGET kind's wire policy, the same projection the form scopes from.
  if(editId){
    const comp=S.adminCompetitionsData.find(c=>c.id===editId);
    if(!comp)return;
    // Picking the stored type is not a change: back to the event as it is.
    if(comp.event_kind===kind){
      if(_compFormKind()!==kind){document.getElementById('comp-form-overlay')?.remove();openCompetitionForm(editId);}
      return;
    }
    const kinds=Array.isArray(S.eventKinds)?S.eventKinds:[];
    const tgt=policyOrDefault((kinds.find(k=>k.value===kind)||{}).policy);
    const label=eventKindLabel(kind)||eventCollectiveSingular();
    const loses=[];
    if(comp.reveal_answers_on_end&&tgt.reveal_answers==='forbidden')loses.push('Reveal answers when the event ends');
    if(comp.group_leaderboard_enabled&&tgt.group_leaderboard==='forbidden')loses.push('Team leaderboard');
    if(comp.measure_presence&&tgt.measure_presence==='forbidden')loses.push('Record time on platform');
    if(comp.trusted_network_ips&&tgt.trusted_networks==='never')loses.push('Trusted network IPs');
    // The PUT also turns late entries off, with any pinned deadline, for a type
    // that takes none (`lateEntry` !== 'allowed', routes/competitions.js).
    if((comp.late_entry_enabled||comp.late_entry_deadline_at)&&tgt.late_entry!=='allowed')loses.push(comp.late_entry_deadline_at?'Late entries, and their deadline':'Late entries');
    const schedNote=policyOrDefault(comp.policy).schedule!==tgt.schedule
      ? (tgt.schedule==='deadline'
          ? '<br><br>It will run to a <strong>deadline</strong> instead of a fixed duration, so you will need to set one.'
          : '<br><br>It will run for a <strong>fixed duration</strong> instead of to a deadline, so you will need to set one — the deadline is dropped.')
      : '';
    const ok=await showModal({
      title:`Change type to ${label}?`,
      message:`Nothing is saved until you press Save on the form.${schedNote}${
        loses.length?`<br><br>These settings are not available for <strong>${esc(label)}</strong> and will be turned <strong>off</strong>:<ul>${loses.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`:''
      }<br>Any unsaved changes in this form are discarded.`,
      confirmText:'Change type',
    });
    if(!ok)return;
    // The OPEN form has to go, or `openCompetitionForm` appends a second
    // overlay and the old one's controls stay in the DOM behind it — a Program
    // form with the Competition's duration box still present and still readable
    // by `_collectCompFormData`. Caught by the re-scope test, which found
    // `#comp-dur-box` alive on a Program.
    document.getElementById('comp-form-overlay')?.remove();
    openCompetitionForm(editId,{kind});
    return;
  }
  document.getElementById('comp-form-overlay')?.remove();
  openCompetitionForm(null,{kind});
}

// v8.3.10 — WHY the start-time control is disabled, one sentence per reason the
// server can give. A silently-shrinking form is a support ticket (v7.14.2): the
// affordance and its explanation are withheld together, never the affordance
// alone. An unrecognised reason falls back to the generic sentence rather than
// rendering nothing, so a reason added server-side later degrades to today's
// copy instead of to silence.
function _startLockNote(reason){
  switch(reason){
    case 'has_participants':
      return 'Start time cannot be changed — this event is running and already has activity in it.';
    case 'requires_superadmin':
      return 'Start time cannot be changed while the event is running. A superadmin can still correct it if nobody has joined yet.';
    case 'has_sessions':
      return 'This event takes its schedule from its sessions — edit the session times below.';
    case 'ended':
      return 'This event has ended. Its start time cannot be changed.';
    default:
      return 'Start time cannot be changed while the event is running.';
  }
}

// The values a template seeds the create form with. Its settings carry the
// same column names an event row does (the server's TEMPLATE_SETTINGS_SCHEMA is
// a pick of the event schema), so they read through the form's `src` as a row's
// would. Nothing here decides which controls exist: that is the kind's policy.
function _templateSeed(t){
  const s=(t&&t.settings&&typeof t.settings==='object')?t.settings:{};
  return {...s,tags:Array.isArray(s.tags)?s.tags:[]};
}

export function openCompetitionForm(editId,opts){
  // A create with no kind chosen yet starts on the New event page, where the
  // admin picks a blank starter or a template; both come back here with a kind.
  if(!editId&&!(opts&&opts.kind))return openNewEventPage();
  const comp=editId?S.adminCompetitionsData.find(c=>c.id===editId):null;
  // The template this create starts from (New event page), and what the admin
  // had typed before a kind change re-rendered the form.
  const tpl=(!comp&&opts&&opts.template)||null;
  const carry=(!comp&&opts&&opts.carry)||null;
  // VALUES the form is seeded from: the row on an edit, the template's settings
  // on a create from a template, nothing on a blank create. Never used to decide
  // edit-versus-create (that is `comp`).
  const src=comp||(tpl?_templateSeed(tpl):null);
  const compStatus=comp?computeCompStatus(comp):null;
  // Ended + end time in the past → superadmin only
  if(comp&&compStatus==='ended'&&!S.isSuperAdmin){
    const effEnd=comp.effective_end?new Date(comp.effective_end):new Date(new Date(comp.start_time).getTime()+comp.duration_minutes*60000);
    if(effEnd<=new Date()){showToast('Only superadmin can edit ended events whose end time has passed.','success');return;}
  }
  // v8.12.0 — the row kebab already withholds Edit from a competitor; this is the
  // guard for every other way into the editor, and it says why rather than
  // opening a form whose Save is certain to be refused.
  if(comp&&comp.competing){
    // The remedy mirrors the server's (`_competitorRemedy`): self-removal is
    // refused once the event has ended, so it is not offered there — an
    // instruction that is not true is worse than none.
    showToast(`You are competing in "${comp.name}", so you cannot edit it. ${compStatus==='ended'?'Ask another organiser to make the change.':'Ask another organiser, or remove yourself from the event first.'}`,'error');
    return;
  }
  // ── v8.2.0 — THE KIND IS ALREADY SETTLED, AND IT DECIDES WHAT EXISTS ────────
  //
  // On a create it was chosen in step 1; on an edit it is the stored, immutable
  // value. Either way this form never chooses it, so it renders as a read-only
  // chip and every control below is gated on that kind's POLICY.
  const _kinds=Array.isArray(S.eventKinds)?S.eventKinds:[];
  // v8.3.0 — an explicitly-passed kind WINS, on an edit as well as a create.
  // That one line is the whole of live re-scoping: picking a type re-opens this
  // form with `{kind}`, every gate below re-reads the policy, and step 2 renders
  // for the type the event is about to become rather than the one on disk.
  const kind=(opts&&opts.kind)||(comp?comp.event_kind:null);
  const _kindChanged=!!(comp&&kind&&kind!==comp.event_kind);
  // THE ONE ORACLE for which controls exist. On an edit it is the row's own wire
  // policy; on a create it is the SAME projection carried by the kind entry —
  // lib/event-policy.js ships both from one function, so they cannot disagree.
  // There is deliberately no kind→fields map in client source: that map would be
  // right the day it was written and silently divergent the first time a policy
  // moved, which is the failure lib/event-policy.js exists to prevent.
  // The row's own policy is only the right oracle while the kind is unchanged;
  // once it is being re-typed the TARGET kind's projection is, and both come
  // from the same server-side function so they cannot disagree.
  const _rawPol=(comp&&!_kindChanged)?comp.policy:((_kinds.find(k=>k.value===kind)||{}).policy);
  // A CREATE with no policy means the vocabulary is gone, and this form would
  // then have to guess which controls a kind it cannot name supports — so it
  // refuses, exactly as step 1 does. An EDIT degrades instead: policyOrDefault
  // fills the permissive shape per field, which is precisely pre-v8.2.0
  // behaviour, and refusing there would block editing an existing event over a
  // stale cached payload.
  if(!comp&&!_rawPol){
    showToast('Cannot open the form: the event-type list did not load. Reload the page and try again.','error');
    return;
  }
  const pol=policyOrDefault(_rawPol);
  // EVERY GATE ASKS THE POLICY, NEVER THE KIND. Each names the server refusal it
  // mirrors, so the surface deciding what to OFFER reads the same rule as the
  // one deciding what to ALLOW and cannot present a control the save rejects.
  const showSessions=pol.sessions==='many';                // sessions_forbidden
  const showDuration=pol.schedule==='window';              // duration_required / deadline_not_accepted
  const showDeadline=pol.schedule==='deadline';            // deadline_required / duration_not_accepted
  const showReveal=pol.reveal_answers==='allowed';         // reveal_answers_forbidden
  const showGroupLb=pol.group_leaderboard==='allowed';     // group_leaderboard_forbidden
  const showPresence=pol.measure_presence==='allowed';     // measure_presence_forbidden
  // The tie-break needs a RANKING as well as a presence measurement, and a
  // Program is the one kind where those two questions differ: it may record time
  // on platform (that is reporting) and can never use it to break a tie (it does
  // not rank). The server accepts `time_basis` there — it is the second of only
  // two settings the platform accepts-and-ignores — so hiding it is what turns a
  // control that appears to work into one that is simply absent.
  const showTieBreak=showPresence&&pol.ranking_enabled!==false;
  // When each participant's solve clock starts (clock_start_forbidden): offered
  // only where the kind may start it at the first open, i.e. never on a Program.
  const showClockStart=pol.clock_start==='allowed';
  // The value shown: the event's own on an edit (or a template's), else the
  // kind's create seed — never a client literal, so the server's
  // `=== undefined` branch stays reachable.
  const _clockStartInit=(src&&(src.clock_start==='first_open'||src.clock_start==='entry'))?src.clock_start
    :(((_kinds.find(k=>k.value===kind)||{}).defaults||{}).clock_start==='entry'?'entry':'first_open');
  // Withheld, with its reason, exactly where the PUT refuses `clock_start_locked`
  // (`clock_start_locked` rides the admin row from the same predicate).
  const _csLocked=comp?(comp.clock_start_locked||null):null;
  const showTrusted=pol.trusted_networks!=='never';        // trusted_networks_forbidden
  // The kind's own CREATE-time default for the CxOne opt-out. Until v8.2.0 the
  // form sent this field unconditionally, so `cxoneDisabledDefault` was dead for
  // every event made in a browser and a Booth Event arrived provisioning an
  // external identity for every two-minute walk-up. Seeding the box rather than
  // omitting the field keeps the default overrulable; the box sits in the
  // Advanced section, folded on a create, so the section's summary line and the
  // Create confirmation say whether accounts will be created
  // (`_cxoneAccountsLine`, operator ruling of 14 Nov 2026).
  const cxDisabledInit=(src&&src.cxone_disabled!==undefined)?!!src.cxone_disabled
    :!!((_kinds.find(k=>k.value===kind)||{}).defaults||{}).cxone_disabled;
  const _kindLabel=eventKindLabel(kind)||eventCollectiveSingular();
  // ── v8.3.0 — the type is CHANGEABLE until the event starts. ──
  //
  // `event_kind_locked` is computed server-side by the same predicate the PUT
  // refuses with (`eventKindChangeLock`), so the control is never offered where
  // the save would reject it — and when it is withheld the reason is stated
  // rather than the control silently vanishing. A shrinking menu with no
  // explanation is the v7.14.2 support ticket; the operator asked for the
  // control to be hidden while sessions exist, not for it to be unexplained.
  //
  // An absent key (a stale cached payload from before this release) reads as
  // LOCKED, which degrades to exactly pre-v8.3.0 behaviour: the chip, no button.
  const _lockReason=comp?(comp.event_kind_locked===undefined?'started':comp.event_kind_locked):null;
  const _lockNote={
    started:'The type can only be changed before the event starts.',
    has_sessions:'The type cannot be changed while the event has sessions. Delete them first.',
  }[_lockReason]||'';
  const _kindNote=comp
    ? (_kindChanged
        ? `Changing to <strong>${esc(_kindLabel)}</strong> — not saved until you press Save.`
        : (_lockReason?_lockNote:'The type can be changed until the event starts.'))
    : 'You can change the type until the event starts.';
  // THE TYPE IS A FIELD: one radio per kind, from the shell's vocabulary (never
  // a client list). Disabled with the reason where the server would refuse a
  // change. The selected kind's blurb says what it means in a sentence.
  const _kindLocked=!!(comp&&_lockReason&&!_kindChanged);
  const _kindEntry=_kinds.find(k=>k.value===kind)||null;
  const kindChooserHtml=`<div class="form-group comp-kind-field">
         <span class="comp-field-label" id="comp-kind-label">Event type</span><span data-help="event.kind" data-help-label="Event type"></span>
         <div class="kind-seg" role="radiogroup" aria-labelledby="comp-kind-label" aria-describedby="comp-kind-note">${
           _kinds.map(k=>`<label class="kind-seg-opt"><input type="radio" name="comp-kind-seg" value="${esc(k.value)}" data-change-action="comp-kind-select" ${k.value===kind?'checked':''} ${_kindLocked?'disabled':''}/><span>${esc(k.label)}</span></label>`).join('')
         }</div>
         <p class="comp-kind-blurb" id="comp-kind-blurb">${_kindEntry&&_kindEntry.blurb?esc(_kindEntry.blurb):''}</p>
         <p class="comp-form-cxone-note" id="comp-kind-note" style="margin:0">${_kindLocked?`${ICO.lock} `:''}${_kindNote}</p>
         <input type="hidden" id="comp-kind" value="${esc(kind||'')}"/>
       </div>`;
  // The title names the KIND on an edit; a create is simply "New event".
  const title=comp?`Edit ${_kindLabel}`:'New event';
  const overlay=document.createElement('div');
  overlay.id='comp-form-overlay';
  // v8.14.5 — the concurrency token of the row this form is filled FROM, kept on
  // the form itself so it ends with it. saveCompetition sends it; never a re-read
  // of adminCompetitionsData, which the 15 s poll reloads under the open form.
  overlay._updatedAt=comp?(comp.updated_at||null):null;
  // The template a create starts from: Save spawns it (challenges, join link,
  // provenance), then applies the form on top.
  overlay._template=tpl;

  const pad=n=>String(n).padStart(2,'0');
  const fmtDate=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtTime=d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const s=comp?new Date(comp.start_time):new Date();
  const nameVal=comp?comp.name:(carry&&carry.name)||(tpl?tpl.name:'');
  const _srcDur=(src&&Number.isInteger(src.duration_minutes)&&src.duration_minutes>0)?src.duration_minutes:180;
  // v8.3.10 — READ THE SERVER'S ANSWER, do not re-derive it. `start_time_locked`
  // is computed by the same `startTimeChangeLock` the PUT refuses with, so the
  // control cannot be offered where the save would reject it, nor withheld where
  // it would be accepted — which is what a local `status==='live'` test now gets
  // wrong, since a superadmin may correct a live event nobody has touched.
  //
  // An older payload with no such key falls back to the pre-v8.3.10 derivation:
  // that is today's behaviour, i.e. the field stays locked, which is the safe
  // direction for a client that cannot know better.
  const _startLockReason=comp?(comp.start_time_locked!==undefined
    ?comp.start_time_locked
    :((compStatus==='live'||compStatus==='ended')?'started':null)):null;
  const lockStart=!!_startLockReason;
  const lockName=comp&&compStatus==='ended';

  // Determine mode: single vs multi
  const existingTimeslots=comp?.timeslots||[];
  const isMulti=existingTimeslots.length>0;
  const hasAnySlotStarted=existingTimeslots.some(ts=>{const st=computeCompStatus(ts);return st==='live'||st==='ended';});
  // The mode the form opens with: the row's on an edit, the template's on a
  // create from one, else the server's create default (per session). Both
  // options test it alone, so a template's "one board across sessions" is the
  // one selected and the PUT after its spawn keeps it.
  const lbMode=src?.leaderboard_mode==='global'?'global':'per_slot';
  const lbLocked=hasAnySlotStarted;
  // Can't switch modes once slots have started or if editing with existing timeslots that have activity
  const modeLocked=comp&&hasAnySlotStarted;

  // CxOne section. v7.13.2 — the WHOLE per-competition CxOne UI (the opt-out checkbox
  // AND the API-key / group-name override + Save/Remove buttons) is shown to EVERY
  // admin: per-competition CxOne settings are admin-level by design (the GLOBAL default
  // CxOne credentials, in Settings, stay superadmin-only). Gate the Remove button on
  // the server-derived `cxone_configured` flag rather than the raw api_key, which the
  // server intentionally never sends (see GET /api/admin/competitions).
  const cxConfigured=!!comp?.cxone_configured;
  const cxGroup=comp?.cxone_group_name||'';
  let cxoneSection=`
      <div class="help-label-row comp-form-head-row"><h3 class="comp-form-cxone-heading">CxOne Integration</h3><span data-help="event.cxone" data-help-label="Checkmarx One"></span></div>
      <div class="form-group">
        <label class="checkbox-row" style="cursor:pointer">
          <input type="checkbox" id="comp-cxone-disabled" data-change-action="toggle-cxone-disabled" ${cxDisabledInit?'checked':''}/>
          <span>Don't create CxOne accounts for this event</span>
        </label>
        <p class="comp-form-cxone-note">${comp?'':`Pre-set for ${esc(_kindLabel)}s &mdash; change it if this event needs the opposite. `}When on, no CxOne (Checkmarx One) accounts are provisioned for this event's participants, and the override fields below are disabled.</p>
      </div>
      <p class="comp-form-cxone-note">Override (leave blank to use global defaults):</p>
      <div class="form-group"><label for="comp-cxone-key">API Key</label><input type="password" id="comp-cxone-key" placeholder="Paste API key to override" autocomplete="off"/></div>
      <div class="form-group"><label for="comp-cxone-group">Group Name</label><input type="text" id="comp-cxone-group" value="${esc(cxGroup)}"/></div>
      ${comp?`<div class="comp-form-cxone-actions">
        <button type="button" class="btn sm" data-action="comp-save-cxone" data-comp-id="${esc(comp.id)}">Save CxOne</button>
        ${cxConfigured?`<button type="button" class="btn sm danger" data-action="comp-remove-cxone" data-comp-id="${esc(comp.id)}">Remove CxOne</button>`:''}
      </div>`:''}`; // for new events, CxOne is saved automatically after creation
  // Event team reports — "Add the qualifying questions", on every CREATE (blank
  // or from a template; an edit adds them through the challenge library), seeded
  // from the kind (`defaults.add_qualifying`, ON for a Booth Event) — off when
  // the template has staff compete on, which refuses them (sealed challenges only).
  if(!comp){
    const _qSeed=!(src&&src.staff_compete)&&!!((_kinds.find(k=>k.value===kind)||{}).defaults||{}).add_qualifying;
    cxoneSection=`
      <div class="help-label-row comp-form-head-row"><h3 class="comp-form-cxone-heading">Qualifying questions</h3><span data-help="event.qualifying" data-help-label="Qualifying questions"></span></div>
      <div class="form-group">
        <label class="checkbox-row" style="cursor:pointer">
          <input type="checkbox" id="comp-add-qualifying" ${_qSeed?'checked':''}/>
          <span>Add the qualifying questions</span>
        </label>
        <p class="comp-form-cxone-note">Four pick-one questions (team size, current scanner, evaluation timeline, follow-up). Every answer is accepted and scores no points; the event team's lead reports read them. You can edit or remove them afterwards.</p>
      </div>`+cxoneSection;
  }

  // ── v8.4.0 — THE SIGN-UP FORM THIS EVENT ASKS FOR ──────────────────────────
  //
  // Rendered only where the server accepts it: `POST`/`PUT` answer 400
  // `registration_fields_forbidden` for any kind that does not configure this, so
  // offering the controls elsewhere would be a form that saves and then refuses.
  // The gate reads the WIRE POLICY (a per-field state map is present for every
  // kind, but only a configurable one can differ from its kind's default), never
  // `event_kind === 'booth'` — the same rule the eight gates above follow.
  //
  // The oracle is `pol.registration_fields`, which on a create is the chosen
  // KIND's defaults and on an edit is this event's own resolved states. So the
  // controls seed from what the form will actually ask for, including for an event
  // whose column is NULL, and the client never applies the defaults itself.
  // A template's own matrix (only the fields it set) over the kind's defaults.
  // On an edit that CHANGES the kind, `pol` is the target kind's projection, so
  // its defaults are laid under the event's OWN resolved states: a kind change
  // keeps the matrix (the PUT merges what is sent over the stored states), and
  // the form sends all five fields, so seeding them from the target's defaults
  // silently reset an organiser's sign-up form.
  const _regStates={...(pol.registration_fields||{}),...((!comp&&src&&src.registration_fields)||{}),
    ...((comp&&_kindChanged&&comp.policy&&comp.policy.registration_fields)||{})};
  // A kind is configurable when the platform will let a matrix be stored for it —
  // a different question from what it currently asks for, since every kind carries
  // a full `registration_fields` map. Read from the WIRE POLICY, never written as
  // `kind==='booth'` here: `public/js` cannot import the module that owns the
  // answer, so a literal would be the re-derived rule this codebase keeps paying
  // for — correct today, silently wrong the first time a second kind becomes
  // configurable, and invisible because the section would simply not render.
  // ABSENT IS NOT FALSE, and conflating the two is what made this section vanish.
  //
  // `policyOrDefault` fills the key in as `false` when a payload does not carry
  // it — the restrictive direction, chosen so a stale client cannot offer
  // controls the server would refuse. That is right for a payload that HAS the
  // key and says no, and wrong for one that has never heard of it: during any
  // half-deployed moment (a server one commit behind a reloaded SPA, a module
  // served from cache) a Booth Event silently lost the WHOLE sign-up section,
  // which reads as a broken feature and was reported as one.
  //
  // So the RAW policy is consulted first: an explicit `false` is obeyed. An ABSENT
  // key falls back to THE KIND ENTRY'S OWN POLICY off the wire — never to
  // `kind==='booth'`, which would be the re-derived literal this comment and the
  // v8.2.0 source scanner both forbid, and which the scanner duly caught. The
  // fallback is still the SERVER's answer: `eventKindsForWire()` computes it from
  // `lib/registration-fields.js`, and the kind vocabulary rides the SPA SHELL, so
  // it is always in lockstep with this module rather than with the competition
  // payload that went stale.
  //
  // With neither answer present — a payload from before the key existed AND a
  // shell with no vocabulary — it stays hidden, which is v8.4.0's restrictive
  // posture and the right one when the client knows nothing at all.
  const _kindPolicy=((_kinds.find(k=>k.value===kind)||{}).policy)||null;
  const _rawConfigurable=(_rawPol&&_rawPol.registration_fields_configurable!==undefined)
    ? _rawPol.registration_fields_configurable
    : (_kindPolicy?_kindPolicy.registration_fields_configurable:undefined);
  const showRegFields=_rawConfigurable===true;
  // ── v8.6.0 — LATE ENTRIES ──────────────────────────────────────────────────
  //
  // The RAW key with a KIND fallback, exactly as the sign-up section above resolves
  // its own: `policyOrDefault` fills a missing key with the RESTRICTIVE value, so
  // gating on the merged answer makes the whole section VANISH during any
  // half-deployed moment (a server one commit behind a reloaded SPA, a module
  // served from cache) — and a control that silently disappears is
  // indistinguishable from a broken feature and gets reported as one (v8.4.1,
  // which earned this rule on this very form). An explicit "never" is obeyed; an
  // ABSENT key falls back to the kind, which the SPA shell always carries.
  const _rawLateEntry=(_rawPol&&_rawPol.late_entry!==undefined)
    ? _rawPol.late_entry
    : (_kindPolicy?_kindPolicy.late_entry:undefined);
  const showLateEntry=_rawLateEntry==='allowed';
  // SEEDED FROM THE WIRE, never a literal. A literal here makes the server's
  // `=== undefined` branch dead code, which is how every browser-created Booth
  // Event arrived with CxOne provisioning on (pre-v8.2.0) and with the LinkedIn
  // door open (pre-v8.4.1).
  const _lateSeed=((_kinds.find(k=>k.value===kind)||{}).defaults||{}).late_entry_enabled;
  const _lateInit=(src&&src.late_entry_enabled!==undefined)?!!src.late_entry_enabled:(_lateSeed===undefined?true:!!_lateSeed);
  // The RESOLVED deadline the server computed, so the form shows a real date
  // without re-deriving the 48-hour rule in a graph that cannot import the module
  // owning it. On a create there is no row, so the pair renders empty and disabled
  // under a ticked Automatic box — which is the state that stores NULL.
  const _lateDeadlinePinned=comp?(comp.late_entry_deadline_at||null):null;
  const _lateDeadlineShown=comp?(comp.late_entry_deadline_effective||null):null;
  // v8.12.6 — THE SWITCH LOCKS ONCE THE EVENT HAS ENDED. The server refuses a
  // change of `late_entry_enabled` on an ended event in either direction (turning
  // it OFF folds every late entrant into the final main board; ON moves anybody
  // whose row was written after the end and who had not finished by it off it),
  // and publishes WHY as
  // `late_entry_locked` on the admin row from the same predicate the PUT refuses
  // with. So the box is rendered DISABLED with the reason rather than offered and
  // refused (v7.14.2) — and not hidden, because an admin reading a finished event
  // must still see what it was set to. A disabled box still reports its stored
  // value to the collector, which the server reads as an echo, not a change, so
  // saving any other field of the event keeps working (the staff_compete shape).
  // The deadline beside it stays editable — for a superadmin's specific time, an
  // extension or a reopen; closing the window EARLY is the organiser's own
  // "Close late entries now" since v8.12.8, which is what the note now names.
  const _lateLocked=comp?(comp.late_entry_locked||null):null;
  // v8.12.8 — the lock note's REMEDY clause names "Close late entries now", and
  // that control exists only while the window is OPEN and the reader does not
  // compete in the event. So it is gated on the server's `can_close_late_entries`
  // — the one predicate the close route refuses with — and not on the switch
  // being ticked (`_lateInit`), which stays true after the window has lapsed,
  // where naming a door that no longer exists is the FROZEN_REMEDY defect.
  // The whole sign-up section governs REGISTRATION, which stops the moment an
  // event stops accepting sign-ups. The controls stay editable — an organiser
  // preparing to run the same stand again should be able to set them up — but
  // saying nothing would leave a live-looking control that changes nothing today,
  // which is the affordance-without-its-explanation failure.
  const _regEnded=!!comp&&compStatus==='ended';   // `compStatus` is already resolved above — one derivation, not two
  const _REG_ROWS=[
    {key:'personal_title',label:'Salutation'},
    {key:'phone',label:'Phone'},
    {key:'city',label:'City'},
    {key:'linkedin_url',label:'LinkedIn Profile URL'},
    {key:'job_function',label:'Job function'},
  ];
  // ONE three-way control per field — Required · Optional · Off — mapped 1:1 onto
  // the stored state (required|optional|hidden). Native radios, so the group is
  // keyboard-operable (arrows move, Tab leaves) with a visible label per row.
  const _regRowHtml=(r)=>{
    const st=(_regStates[r.key]==='required'||_regStates[r.key]==='optional'||_regStates[r.key]==='hidden')?_regStates[r.key]:'optional';
    const opt=(v,label)=>`<label class="reg-seg-opt"><input type="radio" name="reg-state-${esc(r.key)}" value="${v}" data-reg-state="${esc(r.key)}" data-change-action="comp-reg-field-changed" ${st===v?'checked':''}/><span>${label}</span></label>`;
    return `<div class="reg-field-row" data-reg-row="${esc(r.key)}">
      <span class="reg-field-label" id="reg-lbl-${esc(r.key)}">${esc(r.label)}</span>
      <div class="reg-seg" role="radiogroup" aria-labelledby="reg-lbl-${esc(r.key)}">${opt('required','Required')}${opt('optional','Optional')}${opt('hidden','Off')}</div>
    </div>`;
  };
  const _REG_FIXED=['First name','Last name','Company','Job title'];
  // v8.12.0 — "Staff can compete". `staff_compete_locked` rides the admin row
  // (null | 'started' | 'ended'), computed by the same predicate the PUT refuses
  // on, so the control is withheld exactly where the save would be refused —
  // rendered DISABLED with the reason beside it rather than hidden, because an
  // admin reading a finished event must still be able to see what it was set to.
  const _scLocked=comp?(comp.staff_compete_locked||null):null;
  const _scLockCopy=_scLocked==='ended'
    ?'Locked: the event has ended, so whether staff competed in it is now part of its result.'
    :'Locked: the event has started. Changing this now would add people to or remove them from the board mid-event.';
  const staffCompeteSection=`<div class="form-group" style="margin-top:12px">
      <label class="checkbox-row" style="cursor:pointer">
        <input type="checkbox" id="comp-staff-compete" ${src?.staff_compete?'checked':''} ${_scLocked?'disabled':''} aria-describedby="comp-staff-compete-hint"/>
        <span>Staff can compete</span>
      </label><span data-help="event.staff" data-help-label="Staff can compete"></span>
      <p class="comp-form-reveal-hint" id="comp-staff-compete-hint">
        Off by default: staff &mdash; anyone tagged <strong>staff</strong> (every admin and superadmin
        is), and event admins &mdash; are never on an event&rsquo;s leaderboard. When on, a staff member
        <strong>enrolled</strong> in this event competes like any other participant &mdash; on the board,
        in the all-solved rule, eligible for a certificate &mdash; and <strong>cannot edit this event or
        any challenge assigned to it</strong> while enrolled, whatever their admin tier. Only
        <strong>sealed</strong> challenges can be assigned (a competing admin would otherwise read the
        answer key off the admin screen), never one whose author competes here, and anyone tagged
        <strong>staff</strong> can only be added to an event with this switch on.
      </p>
      ${_scLocked?`<p class="comp-form-cxone-note" id="comp-staff-compete-lock-note" style="margin:6px 0 0 24px">${ICO.lock} ${esc(_scLockCopy)}</p>`:''}
    </div>`;
  // The section itself. It sits with the sign-up form because both describe who may
  // get INTO this event and when — an organiser setting up a stand reads them
  // together.
  const lateEntrySection=`
      <div class="help-label-row comp-form-reg-row"><h3 class="comp-form-reg-heading">Late entries</h3><span data-help="event.late" data-help-label="Late entries"></span></div>
      <p class="comp-form-reveal-hint">
        Keeps the join link working for a while after the event ends, for the walk-up who
        arrives as you are packing up. Anyone who joins during this extra window, after the
        event has ended, plays on until the deadline below and is ranked in a separate
        <strong>Late entrants</strong> section of the leaderboard. Their certificates say
        &ldquo;late entrant&rdquo;. Everybody else&rsquo;s event ends on time and the main
        leaderboard is final at that moment.${(comp&&comp.reveal_answers_on_end)?' <strong>You have also turned on revealing answers when the event ends &mdash; late entrants will be able to see them.</strong>':''}
      </p>
      <div class="form-group">
        <label class="checkbox-row" style="cursor:pointer">
          <input type="checkbox" id="comp-late-entry" ${_lateInit?'checked':''} ${_lateLocked?'disabled aria-describedby="comp-late-entry-lock-note"':''} data-change-action="toggle-late-entry"/>
          <span>Allow late entries</span>
        </label>
        ${_lateLocked?`<p class="comp-form-cxone-note" id="comp-late-entry-lock-note" style="margin:6px 0 0 24px">${ICO.lock} Locked: the event has ended, so switching late entries on or off would move people between the main leaderboard and the late-entrant section after its results are final.${comp&&comp.can_close_late_entries?' To close the door early, use <strong>Close late entries now</strong> on the event’s menu.':''}</p>`:''}
      </div>
      <div id="comp-late-entry-box" class="comp-form-late-box" ${_lateInit?'':'hidden'}>
        <div class="comp-form-deadline-col">
          <span id="comp-late-deadline-label" style="font-size:var(--fs-13);font-weight:var(--fw-semibold);display:block;margin-bottom:4px">Late-entry deadline</span>
          <div class="comp-form-deadline-fields" role="group" aria-labelledby="comp-late-deadline-label">
            <input type="date" id="comp-late-deadline-date" aria-label="Late-entry deadline date" data-change-action="comp-form-late-deadline-changed"/>
            <input type="time" id="comp-late-deadline-time" aria-label="Late-entry deadline time" data-change-action="comp-form-late-deadline-changed"/>
          </div>
          <label class="checkbox-row" style="cursor:pointer;margin-top:8px">
            <input type="checkbox" id="comp-late-auto" ${_lateDeadlinePinned?'':'checked'} data-change-action="toggle-late-auto"/>
            <span>Automatic &mdash; 48 hours after the event ends</span>
          </label>
          <p class="comp-form-cxone-note" id="comp-late-note" style="margin:4px 0 0"></p>
        </div>
      </div>`;
  const regFieldsSection=`
      <div class="help-label-row comp-form-reg-row"><h3 class="comp-form-reg-heading">Sign-up form</h3><span data-help="event.signup" data-help-label="Sign-up form"></span></div>
      <p class="comp-form-reveal-hint">Choose what new participants are asked when they sign up for this event.</p>
      <div class="reg-editor">
        <div class="reg-field-list">
          <p class="eyebrow reg-fixed-head">Always asked</p>
          ${_REG_FIXED.map(l=>`<div class="reg-field-row reg-field-fixed"><span class="reg-field-label">${esc(l)}</span><span class="reg-fixed-note">Always</span></div>`).join('')}
          <p class="eyebrow reg-fixed-head">For this event</p>
          ${_REG_ROWS.map(_regRowHtml).join('')}
          <p class="comp-form-cxone-note">Required also asks people who already signed up through this event.</p>
        </div>
        <div class="reg-preview" id="reg-preview" aria-label="Preview of the sign-up card"></div>
      </div>
${_regEnded?'      <p class="comp-form-reveal-hint"><strong>This event has ended, so nobody can register through its link — changing this now takes effect only if it runs again.</strong></p>':''}
`;

  // v7.16.0 — trusted network IPs: a per-competition rate-limit allowlist for the
  // venue's shared/NAT egress address, so a synchronised start doesn't throttle
  // the room and then trip the scanner tracker into blocking the whole address.
  // SINGLE-SESSION ONLY, which the server enforces from both ends (the competition
  // PUT refuses when sessions exist, the timeslot POST refuses when trusted IPs
  // are set). The control therefore carries the PERSISTED session count and
  // disables itself with the reason — see updateTrustedIpsVisibility. It is never
  // silently dropped: a security setting the admin can't see they lost is worse
  // than an error telling them to clear it first.
  const trustedIpsVal=comp?.trusted_network_ips||'';
  // "Use my current address" sits beside the field (useMyAddressForTrustedIps),
  // offered to whoever holds what its route's gate asks: `events.edit`, the event
  // PUT's own permission. A role that may only CREATE events keeps the field and
  // types the address; the button and the help sentence naming it go together.
  const _myAddrOffered=adminCan('events.edit');
  const trustedIpsSection=`
    <div class="form-group comp-form-trusted" id="comp-trusted-ips-group" data-existing-sessions="${existingTimeslots.length}" style="margin-top:12px">
      <label for="comp-trusted-ips">Trusted network IPs</label><span data-help="event.trusted" data-help-label="Trusted network IPs"></span>
      <div class="comp-form-trusted-row">
        <input id="comp-trusted-ips" maxlength="500" value="${esc(trustedIpsVal)}" placeholder="e.g. 203.0.113.7, 198.51.100.0/24" autocomplete="off" spellcheck="false" aria-describedby="comp-trusted-ips-help comp-trusted-ips-note"/>
        ${_myAddrOffered?'<button type="button" class="btn secondary" id="comp-trusted-ips-mine" data-action="comp-trusted-ips-mine">Use my current address</button>':''}
      </div>
      ${_myAddrOffered?'<p class="comp-form-trusted-mine" id="comp-trusted-ips-mine-note" role="status"></p>':''}
      <p class="comp-form-trusted-hint" id="comp-trusted-ips-help">
        Exempts a venue's shared or NAT address from rate limiting, so a whole room signing in at
        once is not throttled or blocked. Comma-separated &mdash; up to 10 IPv4/IPv6 addresses or
        IPv4 CIDR ranges, and /16 is the widest range allowed. Applies only while this event
        is running and for 2 hours after it ends; it is inert beforehand and expires on its own.
        Leave blank for none.${_myAddrOffered?` On the venue's network now? <strong>Use my current address</strong>
        adds the address the platform sees you at.`:''}
      </p>
      <p class="comp-form-trusted-note" id="comp-trusted-ips-note" hidden></p>
    </div>`;

  S._compFormSessionCounter=0;
  S._compFormCompStatus=compStatus;
  S._pendingSlotDeletes=[];

  setSafeHtml(overlay, `<div class="card comp-form-card" role="dialog" aria-modal="true" aria-labelledby="comp-form-title">
    <h3 class="modal-title" id="comp-form-title">${esc(title)}</h3>
    ${tpl?`<p class="comp-form-from" id="comp-form-from">${ICO.copy} Starting from the template <strong>${esc(tpl.name)}</strong>${
      tpl.task_count?` &middot; its ${tpl.task_count} challenge${tpl.task_count===1?'':'s'} and join-link settings come with it`:' &middot; its join-link settings come with it'
    }. Change anything below.</p>`:''}
    <input type="hidden" id="comp-edit-id" value="${esc(editId||'')}"/>
    ${lockName?'<p class="comp-form-lock-note">This event has ended. Name and start time cannot be changed.</p>'
     :lockStart?`<p class="comp-form-lock-note">${_startLockNote(_startLockReason)}</p>`:''}
    ${kindChooserHtml}
    <div class="form-group"><label for="comp-name">Event name <span class="req">*</span></label><span data-help="event.name" data-help-label="Event name"></span><input aria-required="true" id="comp-name" maxlength="120" value="${esc(nameVal)}" placeholder="e.g. AppSec Day booth, Spring CTF" ${lockName?'disabled':''}/></div>

    <div class="help-label-row comp-form-section-row"><h4 class="comp-form-section">When it runs</h4><span data-help="event.schedule" data-help-label="When it runs"></span></div>
    ${showSessions?`<div class="comp-form-mode-row">
      <span class="comp-form-mode-label">Schedule:</span><span data-help="event.sessions" data-help-label="Sessions"></span>
      <div class="comp-mode-toggle${modeLocked?' locked':''}">
        <input type="radio" name="comp-mode" value="single" ${!isMulti?'checked':''} ${modeLocked?'disabled':''} data-change-action="toggle-comp-form-mode" id="comp-mode-single" class="comp-mode-radio"/>
        <label for="comp-mode-single" class="comp-mode-option">Single session</label>
        <input type="radio" name="comp-mode" value="multi" ${isMulti?'checked':''} ${modeLocked?'disabled':''} data-change-action="toggle-comp-form-mode" id="comp-mode-multi" class="comp-mode-radio"/>
        <label for="comp-mode-multi" class="comp-mode-option">Multiple sessions</label>
      </div>
      ${modeLocked?'<span class="comp-form-mode-hint">Locked — a session has started</span>':''}
    </div>`:''}

    <div id="comp-single-section" style="${isMulti?'display:none':''}">
      <div class="comp-form-row">
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:130px"><label for="comp-date">Start Date <span class="req">*</span></label><input aria-required="true" type="date" id="comp-date" value="${fmtDate(s)}" ${lockStart?'disabled':''} data-change-action="comp-form-update-end-time"/></div>
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:100px"><label for="comp-time">Start Time <span class="req">*</span></label><input aria-required="true" type="time" id="comp-time" value="${fmtTime(s)}" ${lockStart?'disabled':''} data-change-action="comp-form-update-end-time"/></div>
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:200px"><label for="comp-tz">Timezone</label><span data-help="event.timezone" data-help-label="Timezone"></span>${_buildTzInput('comp-tz')}</div>
      </div>
      ${showDuration?`<div class="comp-form-dur-box" id="comp-dur-box">
        <div class="comp-form-dur-col">
          <span id="comp-dur-label" class="comp-form-cap" style="font-size:var(--fs-13);font-weight:var(--fw-semibold);margin-bottom:4px">Duration <span class="req">*</span></span><span data-help="event.duration" data-help-label="Duration"></span>
          <div style="display:flex;gap:4px;align-items:center" role="group" aria-labelledby="comp-dur-label">
            <input type="number" id="comp-dur-d" aria-label="Duration, days" value="${Math.floor(_srcDur/1440)}" min="0" max="365" step="1" style="width:60px" data-change-action="comp-form-dur-changed"/><span style="font-size:var(--fs-12);color:var(--muted)" aria-hidden="true">d</span>
            <input type="number" id="comp-dur-h" aria-label="Duration, hours" value="${Math.floor((_srcDur%1440)/60)}" min="0" max="23" step="1" style="width:60px" data-change-action="comp-form-dur-changed"/><span style="font-size:var(--fs-12);color:var(--muted)" aria-hidden="true">h</span>
            <input type="number" id="comp-dur-m" aria-label="Duration, minutes" value="${_srcDur%60}" min="0" max="59" step="1" style="width:60px" data-change-action="comp-form-dur-changed"/><span style="font-size:var(--fs-12);color:var(--muted)" aria-hidden="true">m</span>
          </div>
        </div>
      </div>`:''}
      <!-- The DEADLINE pair, for a schedule:"deadline" kind. A window kind has
           no end inputs: its end is shown, read-only, in #comp-end-preview,
           because the duration is the one control for that fact. -->
      ${showDeadline?`<div id="comp-deadline-box" class="comp-form-dur-box">
        <!-- v8.2.2 — a CLASS, not an inline flex:0 0 auto. That inline style made
             this column max-content-wide, and the "No fixed deadline" note is a
             full sentence — so ticking the box grew the card's scroll width to
             877px inside a 270px phone viewport. An inline style cannot be
             overridden from the stylesheet without !important, so it had to move. -->
        <div class="comp-form-deadline-col">
          <span id="comp-deadline-label" class="comp-form-cap" style="font-size:var(--fs-13);font-weight:var(--fw-semibold);margin-bottom:4px">Deadline <span class="req">*</span></span><span data-help="event.deadline" data-help-label="Deadline"></span>
          <!-- aria-required goes on the INPUTS, not the group: it is not an allowed
               attribute on role="group" and axe rates that critical. (It IS allowed
               on the kind chooser's role="radiogroup", which is why that one passes.) -->
          <div class="comp-form-deadline-fields" role="group" aria-labelledby="comp-deadline-label">
            <input type="date" id="comp-deadline-date" aria-required="true" aria-label="Deadline date" data-change-action="comp-form-deadline-changed"/>
            <input type="time" id="comp-deadline-time" aria-required="true" aria-label="Deadline time" data-change-action="comp-form-deadline-changed"/>
          </div>
          <label class="checkbox-row" style="cursor:pointer;margin-top:8px">
            <input type="checkbox" id="comp-no-deadline" data-change-action="toggle-no-deadline"/>
            <span>No fixed deadline</span>
          </label>
          <p class="comp-form-cxone-note" id="comp-deadline-note" style="margin:4px 0 0"></p>
        </div>
      </div>`:''}
      ${showDuration?'<div id="comp-end-preview" class="comp-form-end-preview"></div>':''}
    </div>

    ${showSessions?`<div id="comp-multi-section" style="${isMulti?'':'display:none'}">
      <div id="comp-sessions-list"></div>
      <button class="btn sm secondary" style="margin-top:8px" data-action="comp-add-form-session">+ Add Session</button>
      <div class="form-group" style="margin-top:12px">
        <label for="comp-lb-mode">Leaderboard Mode</label><span data-help="event.lbmode" data-help-label="Leaderboard mode"></span>
        <select id="comp-lb-mode" ${lbLocked?'disabled':''} style="max-width:200px">
          <option value="per_slot" ${lbMode!=='global'?'selected':''}>Per Session</option>
          <option value="global" ${lbMode==='global'?'selected':''}>Global (all sessions)</option>
        </select>
        ${lbLocked?'<span style="font-size:var(--fs-12);color:var(--muted);margin-left:8px">Locked</span>':''}
      </div>
    </div>`:''}

    <h4 class="comp-form-section">How it plays</h4>
    <!-- v6.16.0 — reveal answers on end. Default unchecked (do not
         reveal). Visible for both single-slot and multi-slot comps —
         the rule applies the same way. The .checkbox-row class is the
         existing pattern used elsewhere for label-aligned checkboxes. -->
    ${showReveal?`<div class="form-group" style="margin-top:12px">
      <label class="checkbox-row" style="cursor:pointer">
        <input type="checkbox" id="comp-reveal-answers" ${src?.reveal_answers_on_end?'checked':''}/>
        <span>Reveal correct answers and explanations to participants once the event ends</span>
      </label><span data-help="event.reveal" data-help-label="Reveal answers"></span>
      <p class="comp-form-reveal-hint">
        Off by default. Recommended off for repeating events that reuse the same question bank;
        recommended on for one-shot events where participants should see the solutions afterwards.
      </p>
    </div>`:''}
    <!-- v8.1.0 — the EVENT-level attempt ceiling. Applies to every challenge in
         the event unless that challenge sets its own, which wins. Blank means no
         limit, and it is a plain number input for the same reason the challenge
         one is: uncapped is the normal answer and must be the easiest to leave. -->
    <div class="form-group" style="margin-top:12px">
      <label for="comp-attempt-cap">Attempt limit per challenge</label><span data-help="event.attempts" data-help-label="Attempt limit"></span>
      <input id="comp-attempt-cap" type="number" min="1" max="1000" step="1" inputmode="numeric"
             placeholder="No limit" value="${(Number.isInteger(src?.attempt_cap)&&src.attempt_cap>0)?src.attempt_cap:''}"
             aria-describedby="comp-attempt-cap-hint"/>
      <p class="comp-form-reveal-hint" id="comp-attempt-cap-hint">
        Submissions each participant may make on each challenge in this event. Leave blank
        for no limit. A challenge with its own limit overrides this one. Once a participant
        runs out, an admin can grant them more.
      </p>
    </div>

    <!-- Stage B (owner ruling, 27 Nov 2026): the form picks no questions. A
         blank event gets them from its Questions section's one door, + Add from
         bank; a template's questions come with its spawn. -->

    <!-- ADVANCED: the rarely changed settings, collapsed on a create (open on an
         edit, where an organiser came to change something specific). Nothing in
         here is hidden from the save: the collector reads every control whether
         the section is open or not. -->
    <details class="comp-form-advanced" id="comp-advanced"${comp?' open':''}>
      <summary class="comp-form-advanced-summary"><span class="comp-form-advanced-title">Advanced settings</span><span class="comp-form-advanced-sub">Team board, staff, time on platform, test runs${showRegFields?', sign-up form':''}${showLateEntry?', late entries':''}${showTrusted?', venue network':''}, <span id="comp-advanced-cxone"></span></span></summary>
      <div class="comp-form-advanced-body">

    <!-- v7.11.7 — enable the group/team leaderboard. Off by default. Even when on,
         the board only appears once at least two non-empty groups are assigned to
         the event. -->
    ${showGroupLb?`<div class="form-group" style="margin-top:12px">
      <label class="checkbox-row" style="cursor:pointer">
        <input type="checkbox" id="comp-group-leaderboard" ${src?.group_leaderboard_enabled?'checked':''}/>
        <span>Enable group (team) leaderboard</span>
      </label><span data-help="event.team" data-help-label="Team leaderboard"></span>
      <p class="comp-form-reveal-hint">
        Off by default. When on, participants and admins see a team ranking alongside the
        individual one &mdash; but only once at least two non-empty groups are assigned to this event.
      </p>
    </div>`:''}
    <!-- v8.12.0 — STAFF CAN COMPETE. Universal (every kind), off by default so
         every existing event keeps its standing rule. Withheld with its reason
         once the event has started (server: staff_compete_locked), because the
         switch adds people to or removes them from the board mid-event. The
         refusals that a save can meet — unsealed challenges assigned, an
         enrolled participant who authored an assigned challenge, staff already
         enrolled — come back as lists and are rendered as a modal by
         showStaffCompeteRefusalModal, not a toast. -->
    ${staffCompeteSection}

    <!-- v8.1.0 (PR 34) — record NET ACTIVE TIME. Off by default for every kind
         and refused outright for a Booth Event, whose window is too short for a
         five-minute bucket to say anything. -->
    ${showPresence?`<div class="form-group" style="margin-top:12px">
      <label class="checkbox-row">
        <input type="checkbox" id="comp-measure-presence" ${src?.measure_presence?'checked':''}/>
        <span>Record time on platform</span>
      </label><span data-help="event.presence" data-help-label="Time on platform"></span>
      <p class="comp-form-reveal-hint">
        Counts five-minute blocks in which each participant was actually doing something.
        Adds a <strong>Time on Platform</strong> column to the rankings CSV beside the
        elapsed time. Participants are told, on the event itself, that this is recorded.
        It is measured from activity in the participant&rsquo;s own browser, so time spent
        working outside it &mdash; in an IDE or a terminal &mdash; is not counted. Read it
        as a signal of engagement rather than a measure of effort.
      </p>
      ${showTieBreak?`<label class="checkbox-row" style="margin-top:8px">
        <input type="checkbox" id="comp-time-basis" ${src?.time_basis==='presence'?'checked':''}/>
        <span>Break score ties on time spent, not elapsed time</span>
      </label>
      <p class="comp-form-reveal-hint">
        Only separates participants who finished everything — for anyone still going,
        less time on the platform means less work done, not more efficiency.
      </p>`:''}
    </div>`:''}

    <!-- WHEN EACH PARTICIPANT'S CLOCK STARTS (owner decision, 27 Nov 2026).
         Rendered only where the kind may start it at the first challenge (never
         a Program, which does not rank). Locked once the event has started
         (server: clock_start_locked), shown disabled with the reason so an
         admin reading a running event still sees what it was set to. -->
    ${showClockStart?`<div class="form-group" style="margin-top:12px">
      <div class="help-label-row"><label for="comp-clock-start">Start each participant&rsquo;s clock</label><span data-help="event.clock" data-help-label="Clock start"></span></div>
      <select id="comp-clock-start" ${_csLocked?'disabled':''} aria-describedby="comp-clock-start-hint">
        <option value="first_open" ${_clockStartInit==='first_open'?'selected':''}>When they open their first challenge</option>
        <option value="entry" ${_clockStartInit==='entry'?'selected':''}>When they enter the event</option>
      </select>
      <p class="comp-form-reveal-hint" id="comp-clock-start-hint">
        Time to solve breaks score ties. With <strong>When they open their first challenge</strong>,
        each participant&rsquo;s time starts when they first open a scoring challenge (or answer or
        ask for a hint, if that comes first), so arriving late or reading the list is not counted.
        Quick questions do not start it. Until it starts, a participant is not on the leaderboard.
      </p>
      ${_csLocked?`<p class="comp-form-cxone-note" id="comp-clock-start-lock-note" style="margin:6px 0 0 0">${ICO.lock} Locked: the event has started, so every participant&rsquo;s time is already being measured this way.</p>`:''}
    </div>`:''}

    <!-- v7.8.1 — mark event as internal (dry run / testing). Backed by
         the permanent internal event tag: create seeds it via
         body.tags; edit syncs it through the tag add/remove endpoints in
         saveCompetition(). Test / dry-run comps are excluded from Analytics by
         default and visually flagged in the admin list.

         v7.21.18 - the checkbox id stays "comp-internal", and the CSS keeps
         ".comp-card.internal" / ".is-internal". Those are internal handles, not
         user-visible text, and regression tests locate the checkbox by id;
         renaming them would churn markup, CSS and tests for no behaviour change
         (v7.17.1). Note the DOUBLE QUOTES: this HTML comment sits inside a
         TEMPLATE LITERAL, so a backtick here terminates the literal and breaks
         the whole SPA - node --check and esbuild both pass it (v7.21.0). -->
    <div class="form-group" style="margin-top:12px">
      <label class="checkbox-row" style="cursor:pointer">
        <input type="checkbox" id="comp-internal" ${(src?.tags||[]).includes(DRY_RUN_TAG)?'checked':''}/>
        <span>Mark as test / dry run</span>
      </label><span data-help="event.dryrun" data-help-label="Test / dry run"></span>
      <p class="comp-form-reveal-hint">
        Events marked as a test / dry run are excluded from Analytics by default and flagged in the admin list. Use for rehearsals and test runs.
      </p>
    </div>

    ${showRegFields?regFieldsSection:''}
    ${showLateEntry?lateEntrySection:''}
    ${showTrusted?trustedIpsSection:''}
    ${cxoneSection}
      </div>
    </details>
    <div class="comp-form-actions">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="comp-form-overlay">Cancel</button>
      <button class="btn" data-action="comp-save">${comp?'Update':'Create event'}</button>
    </div>
   </div>`);
  document.body.appendChild(overlay);
  if(carry&&carry.spawned){
    _markSpawnedForm(carry.spawned);
    overlay._spawnedLost=carry.spawnedLost||null;
    overlay._spawnedToken=carry.spawnedToken||null;
  }
  renderRegPreview();   // the sign-up preview beside the field switches (no-op when not rendered)
  overlayDismiss(overlay,()=>overlay.remove());
  setTimeout(()=>document.getElementById('comp-name')?.focus(),0);
  // v7.13.0 — reflect the initial cxone_disabled state (a pre-checked box on an
  // edit should render the CxOne override fields disabled from the start), and
  // write the Advanced summary line's "Checkmarx One accounts: on|off" (its one
  // writer, here and on every change of the box).
  toggleCxoneDisabled();
  // What the admin had typed before a kind change re-rendered the form.
  if(carry){
    const setV=(id,v)=>{const el=document.getElementById(id);if(el&&v&&!el.disabled)el.value=v;};
    setV('comp-date',carry.date);setV('comp-time',carry.time);
    if(carry.tz){const tzEl=document.getElementById('comp-tz');if(tzEl&&_isValidTz(carry.tz))tzEl.value=carry.tz;}
  }
  // A deadline kind from a template: the deadline sits the template's duration
  // after the start (a duration past the open-ended threshold reads as "no
  // fixed deadline").
  const _tplDeadline=(!comp&&src&&Number.isInteger(src.duration_minutes)&&src.duration_minutes>0&&showDeadline)
    ?(()=>{const st=_compFormGetStartDate();return st?new Date(st.getTime()+src.duration_minutes*60000):null;})()
    :null;
  const _seedDeadline=(comp&&comp.deadline_at)?comp.deadline_at:(_tplDeadline?_tplDeadline.toISOString():null);
  if(_seedDeadline){
    const dl=new Date(_seedDeadline);
    const pad=n=>String(n).padStart(2,'0');
    const dEl=document.getElementById('comp-deadline-date');
    const tEl=document.getElementById('comp-deadline-time');
    if(dEl)dEl.value=`${dl.getFullYear()}-${pad(dl.getMonth()+1)}-${pad(dl.getDate())}`;
    if(tEl)tEl.value=`${pad(dl.getHours())}:${pad(dl.getMinutes())}`;
    // The checkbox is initialised from the DERIVED predicate and read only by
    // the save's confirmations (_noFixedDeadlineTicked) — it is a pure input
    // control, which is why no column stores it.
    const chk=document.getElementById('comp-no-deadline');
    if(chk&&(dl.getTime()-Date.now())>=OPEN_ENDED_THRESHOLD_DAYS*86400000){
      chk.checked=true;
      if(dEl)dEl.disabled=true;
      if(tEl)tEl.disabled=true;
    }
  }
  // v8.2.0 — no live re-evaluation any more: the kind cannot change while this
  // form is open, so the schedule controls were decided at render time and the
  // chooser's change listener is gone with the chooser. What remains is the
  // deadline field's own initialisation.
  applyKindSchedule();
  // v8.6.0 — seed the late-entry pair.
  //
  // `S._compFormLateAutoIso` is the SERVER's resolved deadline for this event
  // (`late_entry_deadline_effective`), so the Automatic case shows the instant the
  // window will actually run to rather than a client re-derivation of the 48-hour
  // rule. Null on a create — there is no row — where `toggleLateAuto` falls back to
  // deriving from the form's own end.
  //
  // A PINNED deadline seeds the pair and leaves Automatic unticked; an unpinned one
  // leaves Automatic ticked, which fills and disables the pair. Either way the
  // admin is SHOWN the date, which is what makes "automatic" reviewable.
  S._compFormLateAutoIso=_lateDeadlineShown;
  // v8.6.3 — the end this form was SEEDED with, so the Automatic fill can tell
  // "the admin moved the schedule" (follow the form) from "they have not"
  // (keep the server's resolved answer, which knows about an early End Now).
  S._compFormLateSeedEndMs=(()=>{const e=_compFormEndInstant();return e?e.getTime():null;})();
  // v8.12.7 — the STORED pin, verbatim, so an untouched pair can echo it rather
  // than its minute-floored rendering (`_collectLateDeadline`). Reset on EVERY
  // open, create included: a value left from the previous dialog would be echoed
  // into an event it never belonged to.
  S._compFormLatePinned=_lateDeadlinePinned||null;
  if(_lateDeadlinePinned){
    // In the dialog's zone, not the browser's. This pair is read back with
    // `wallClockToUtc(..., #comp-tz)`, and while that box happens to seed FROM
    // the browser — so the old browser-local write was correct at this instant —
    // saying so explicitly is what stops it going wrong the moment anything
    // re-renders after a timezone change, which v8.6.3 makes routine.
    const wc=utcToWallClock(new Date(_lateDeadlinePinned),document.getElementById('comp-tz')?.value||'');
    const dEl=document.getElementById('comp-late-deadline-date');
    const tEl=document.getElementById('comp-late-deadline-time');
    if(wc&&dEl)dEl.value=wc.date;
    if(wc&&tEl)tEl.value=wc.time;
  }
  toggleLateEntry();

  // Populate existing sessions for edit mode
  if(isMulti){
    const list=document.getElementById('comp-sessions-list');
    existingTimeslots.forEach(ts=>{
      const tsStatus=computeCompStatus(ts);
      const locked=tsStatus!=='upcoming';
      addCompFormSession(ts.name,new Date(ts.start_time),ts.duration_minutes,ts.id,locked,tsStatus,ts.updated_at||null);
    });
  }
  // Initialise end time preview for single session mode
  compFormUpdateEndTime();
  // v7.16.0 — a single-session form never calls addCompFormSession, so the
  // sessions hook below can't be the only evaluation point.
  updateTrustedIpsVisibility();
  // A create: what the form holds now, so a change of type can tell whether it
  // would throw away anything the admin set (`compKindSelect`).
  if(!comp)overlay._kindSnap=_compFormKindSnap(overlay);
}

// The create form's controls a change of type does NOT carry: everything but
// the name, the start and its timezone, the type itself and the Challenges
// section (its ticks are carried). Compared with the snapshot taken when the
// form opened, so a re-render that would discard a setting asks first. A value
// the form DERIVES from the carried start is no setting of the admin's: the
// late-entry deadline while it is Automatic (refilled whenever the start moves).
const _KIND_CARRIED_IDS=new Set(['comp-name','comp-date','comp-time','comp-tz','comp-kind','comp-edit-id','comp-ch-search']);
const _KIND_DERIVED_LATE=new Set(['comp-late-deadline-date','comp-late-deadline-time']);
function _compFormKindSnap(ov){
  if(!ov)return '';
  const lateAuto=!!ov.querySelector('#comp-late-auto')?.checked;
  return [...ov.querySelectorAll('input,select,textarea')]
    .filter(el=>!_KIND_CARRIED_IDS.has(el.id)&&el.name!=='comp-kind-seg'&&!el.closest('#comp-ch')&&!(lateAuto&&_KIND_DERIVED_LATE.has(el.id)))
    .map(el=>`${el.id||el.name}=${(el.type==='checkbox'||el.type==='radio')?el.checked:el.value}`).join('|');
}

export function _compFormGetDurMinutes(){
  const d=parseInt(document.getElementById('comp-dur-d')?.value)||0;
  const h=parseInt(document.getElementById('comp-dur-h')?.value)||0;
  const m=parseInt(document.getElementById('comp-dur-m')?.value)||0;
  return d*1440+h*60+m;
}

export function _compFormGetStartDate(){
  const dateVal=document.getElementById('comp-date')?.value;
  const timeVal=document.getElementById('comp-time')?.value;
  if(!dateVal||!timeVal)return null;
  const rawTz=document.getElementById('comp-tz')?.value||'';
  const tz=_isValidTz(rawTz)?rawTz:Intl.DateTimeFormat().resolvedOptions().timeZone;
  // ext-audit v7.21.1 (A3) — the wall-clock → UTC arithmetic that used to live
  // here (and in three siblings) sampled the zone's offset one |offset| too
  // early, so every entry near a DST transition was stored an hour out. One
  // shared two-pass helper now, in the timezone leaf: see wallClockToUtc.
  //
  // v7.21.19 (audit F2) — and REFUSE a wall clock that never happens. On a
  // spring-forward day an hour of the clock is skipped, and the conversion
  // returns an adjacent instant for anything inside it: typing 02:30 in
  // America/New_York on 2026-03-08 stored the same instant as 01:30 and rendered
  // back as 01:30. The save succeeded and showed a different time than the one
  // that was typed, with nothing to explain it. `_dstError` is read by the
  // caller, which highlights the field and shows the message.
  const chk=wallClockToUtcChecked(dateVal,timeVal,tz);
  _compFormGetStartDate._dstError=chk.exists?null:dstGapMessage(timeVal,tz);
  return chk.date;
}

export function compFormDurChanged(){
  compFormUpdateEndTime();
}

export function compFormUpdateEndTime(){
  const preview=document.getElementById('comp-end-preview');
  if(!preview)return;
  const start=_compFormGetStartDate();
  const dur=_compFormGetDurMinutes();
  if(!start||!dur){preview.textContent='';return;}
  const end=new Date(start.getTime()+dur*60000);
  const tz=document.getElementById('comp-tz')?.value||Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Display in the user's browser locale (v6.2.6 — was hardcoded en-US so a
  // German operator saw "8/15/2026" instead of "15.8.2026"). The timeZone
  // pin is preserved so the actual moment is correct in the operator's TZ.
  const fmtEnd=fmtDt(end,'long',{timeZone:tz});
  setSafeHtml(preview, `Ends: <strong>${esc(fmtEnd)}</strong> (${esc(tz)})`);
  // v8.6.3 — THE ONE HOOK. This function is already the convergence point for a
  // start change, a duration change, an end change AND a timezone change (the
  // tz input's own `data-change-action` is `comp-form-update-end-time`), so the
  // late-entry block follows all four from here rather than growing four
  // listeners that would have to be kept in step.
  _refreshLateEntry();
}

// v8.6.3 — keep the late-entry deadline honest as the schedule and the timezone
// move under it. Three things move together, which is why they are one function:
// the CONTROL (refilled while Automatic is on), its LABEL (which names the zone)
// and the NOTE beneath.
//
// Silently does nothing when the block is absent — it renders for a Booth Event
// only — so the hook above is safe on every kind.
function _refreshLateEntry(){
  if(!document.getElementById('comp-late-entry-box'))return;
  const auto=!!document.getElementById('comp-late-auto')?.checked;
  if(auto)_fillLateAutoFields();
  _refreshLateDeadlineLabel();
  compFormLateDeadlineChanged();
}

// The zone the deadline pair is READ BACK in, and therefore the only zone it can
// honestly be labelled with. Named on the control as well as in the note, per the
// operator's instruction — an admin typing a wall clock into a bare date/time pair
// has no other way to know which zone it means.
function _refreshLateDeadlineLabel(){
  const el=document.getElementById('comp-late-deadline-label');
  if(!el)return;
  const tz=document.getElementById('comp-tz')?.value||'';
  setSafeHtml(el, `Late-entry deadline${tz?` <span class="comp-late-tz">(${esc(tz)})</span>`:''}`);
}

// v7.13.0 — when "Don't create CxOne accounts" is checked, disable the per-comp
// CxOne override controls (they're moot when no accounts will be provisioned). All
// controls are null-guarded because the whole CxOne section is superadmin-only.
// ── v8.1.0 (PR 16) — the deadline-shaped schedule controls ───────────────────

// The kind currently selected in the form: the chooser on create, the stored
// value on edit (where the kind is immutable).
export function _compFormKind(){
  // v8.2.0 — a hidden field rather than the old chooser's `:checked` radio. The
  // kind is settled before this form renders (step 1 on a create, the immutable
  // stored value on an edit), so it is carried, not chosen.
  const hidden=document.getElementById('comp-kind');
  if(hidden&&hidden.value)return hidden.value;
  const id=document.getElementById('comp-edit-id')?.value;
  const comp=id?(S.adminCompetitionsData||[]).find(c=>c.id===id):null;
  return comp?comp.event_kind:null;
}

// v8.2.0 — the open form's policy, resolved exactly as openCompetitionForm
// resolved it: the row's own on an edit, the kind entry's on a create.
//
// This REPLACES a `k === 'program' ? 'deadline' : 'window'` fallback — a stored
// event-kind value driving behaviour in client source, i.e. the second mapping
// lib/event-policy.js exists to prevent. It survived only because the policy did
// not reach a create; now it does, from the same projection.
export function _compFormPolicy(){
  const id=document.getElementById('comp-edit-id')?.value;
  const comp=id?(S.adminCompetitionsData||[]).find(c=>c.id===id):null;
  // v8.3.0 — THE ROW'S POLICY IS ONLY RIGHT WHILE THE FORM STILL HOLDS THE ROW'S
  // KIND. Once the type is being changed, `#comp-kind` is the truth and the
  // stored policy describes the event it is ceasing to be.
  //
  // Getting this wrong was silent and total: the form re-scoped correctly (that
  // path reads the target policy directly), so a Program's deadline fields
  // rendered — while `_compFormSchedule()` still answered "window", so
  // `applyKindSchedule` seeded no deadline and `_collectCompFormData` took the
  // duration branch and refused with "Duration must be at least 1 minute" for a
  // control the form does not show. Found by the save half of the re-scope lock,
  // which is precisely the half a re-render assertion cannot see.
  if(comp&&comp.policy&&comp.event_kind===_compFormKind())return policyOrDefault(comp.policy);
  const kinds=Array.isArray(S.eventKinds)?S.eventKinds:[];
  return policyOrDefault((kinds.find(e=>e.value===_compFormKind())||{}).policy);
}

function _compFormSchedule(){return _compFormPolicy().schedule;}

// Ten CALENDAR years from max(now, start) — calendar, not 3652 days, so the date
// lands on the same day of the month whatever leap years intervene. Measured from
// now as well as start so ticking the box on a Program that opened two years ago
// cannot produce something closing in eight years while reading as open-ended.
function _tenYearsOut(){
  const startMs=_compFormGetStartDate()?.getTime()||Date.now();
  const base=new Date(Math.max(Date.now(),startMs));
  const d=new Date(base.getTime());
  d.setFullYear(d.getFullYear()+10);
  return d;
}

// 5 years, mirroring OPEN_ENDED_THRESHOLD_DAYS in lib/competitions.js. A
// divergence here cannot corrupt data — it makes one surface read "No fixed
// deadline" while another prints a date — but that is a visible contradiction on
// an admin's screen, so a Docs-hygiene diff lock holds the two together.
export const OPEN_ENDED_THRESHOLD_DAYS = 1826;

export function toggleNoDeadline(){
  const box=document.getElementById('comp-no-deadline');
  const dEl=document.getElementById('comp-deadline-date');
  const tEl=document.getElementById('comp-deadline-time');
  if(!box||!dEl||!tEl)return;
  if(box.checked){
    // FILL the fields and disable them — never blank or hide them. The date is
    // genuinely stored and will surface later: the create audit records every
    // field verbatim and History renders it verbatim, so an admin who reads
    // `deadline_at: 2036-08-14` in six months must have been shown that date when
    // they chose it, or the History entry reads as a bug.
    const d=_tenYearsOut();
    const pad=n=>String(n).padStart(2,'0');
    dEl.value=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    tEl.value=`${pad(d.getHours())}:${pad(d.getMinutes())}`;
    dEl.disabled=true;tEl.disabled=true;
  }else{
    dEl.disabled=false;tEl.disabled=false;
  }
  compFormDeadlineChanged();
}

// THE SAVE'S CONFIRMATIONS WITH "No fixed deadline" TICKED (operator ruling,
// 14 Nov 2026). The platform chose that deadline, so Save asks no two-year typo
// question about it (one typed by hand is still asked), and each confirmation
// names it "No fixed deadline (stored as <date>)": the words every other surface
// says, and the date the form shows because it is the one recorded.
function _noFixedDeadlineTicked(){
  return !!document.getElementById('comp-no-deadline')?.checked;
}
// `inSentence` lower-cases the words' first letter for a mid-sentence use.
function _noFixedDeadlineWords(d,opts,inSentence){
  const w=inSentence?NO_FIXED_DEADLINE.charAt(0).toLowerCase()+NO_FIXED_DEADLINE.slice(1):NO_FIXED_DEADLINE;
  return `${w} (stored as ${fmtDt(d,'long',opts)})`;
}

export function compFormDeadlineChanged(){
  const note=document.getElementById('comp-deadline-note');
  if(!note)return;
  const d=_compFormGetDeadline();
  if(!d){setSafeHtml(note,'');return;}
  const openEnded=(d.getTime()-Date.now())>=OPEN_ENDED_THRESHOLD_DAYS*86400000;
  const when=fmtDt(d,'long');
  setSafeHtml(note, openEnded
    ? `Stored as ${esc(when)}. The program stays open; move the deadline forward at any time to extend it, or untick to set a real one.`
    : `Closes ${esc(when)}.`);
}

// ── v8.6.0 — the LATE-ENTRY controls ────────────────────────────────────────
//
// Two toggles over one date/time pair, with ids of its own; the DST-checked
// conversion is a shared helper.
export function _compFormGetLateDeadline(){
  const dEl=document.getElementById('comp-late-deadline-date');
  const tEl=document.getElementById('comp-late-deadline-time');
  if(!dEl||!tEl||!dEl.value||!tEl.value)return null;
  const tz=document.getElementById('comp-tz')?.value||'';
  // wallClockToUtcChecked, never a hand-rolled `new Date(\`${d}T${t}\`)`: ext-audit
  // v7.21.1 (A3) found four one-pass copies all storing an hour out around every
  // DST transition, because sampling the offset at the NAIVE instant samples it
  // |offset| hours from the answer.
  const r=wallClockToUtcChecked(dEl.value,tEl.value,tz);
  return r&&r.exists?r.date:null;
}

// Show or hide the whole deadline block with the feature toggle. The block is
// HIDDEN rather than disabled when late entries are off, because a deadline for a
// window that will not open is not a setting an organiser needs to reason about —
// and the collector reads the toggle, so a hidden pair sends nothing either way.
export function toggleLateEntry(){
  const on=!!document.getElementById('comp-late-entry')?.checked;
  const box=document.getElementById('comp-late-entry-box');
  if(box)box.hidden=!on;
  if(on)toggleLateAuto();
}

// FILLED AND DISABLED, never blanked — the `toggleNoDeadline` rule, and for the
// same reason: the resolved date is what the window will actually run to, the
// audit records the stored value verbatim, and an admin reading "automatic" has to
// be shown WHICH date that is or the setting is unreviewable.
export function toggleLateAuto(){
  const auto=!!document.getElementById('comp-late-auto')?.checked;
  const dEl=document.getElementById('comp-late-deadline-date');
  const tEl=document.getElementById('comp-late-deadline-time');
  if(!dEl||!tEl)return;
  if(auto){ _fillLateAutoFields(); dEl.disabled=true;tEl.disabled=true; }
  else{ dEl.disabled=false;tEl.disabled=false; }
  _refreshLateDeadlineLabel();
  compFormLateDeadlineChanged();
}

// The Automatic fill: 48 hours after the end, shown in the EVENT's timezone.
//
// WHICH END, and it is not always the form's. On an EDIT the server has already
// resolved the deadline (`late_entry_deadline_effective`), which accounts for
// things the form cannot see — an event ended early by End Now runs its window
// from the ACTUAL end, not the scheduled one. So the server's answer stands until
// the admin actually moves the schedule, and only then does the form's own
// derivation take over. Comparing against the end the form was SEEDED with is
// what distinguishes the two; a bare "prefer the form" would show a wrong date
// for every ended event the moment the dialog opened.
//
// DISPLAY ONLY either way: ticking Automatic sends NULL and the server derives
// the stored answer.
function _fillLateAutoFields(){
  const dEl=document.getElementById('comp-late-deadline-date');
  const tEl=document.getElementById('comp-late-deadline-time');
  if(!dEl||!tEl)return;
  const fromForm=_compFormLateAutoFromForm();
  const endNow=_compFormEndInstant();
  const moved=S._compFormLateSeedEndMs==null||!endNow||endNow.getTime()!==S._compFormLateSeedEndMs;
  const src=(moved&&fromForm)?fromForm
    :(S._compFormLateAutoIso?new Date(S._compFormLateAutoIso):fromForm);
  if(!src||!Number.isFinite(src.getTime()))return;
  const tz=document.getElementById('comp-tz')?.value||'';
  const wc=utcToWallClock(src,tz);
  if(wc){ dEl.value=wc.date; tEl.value=wc.time; }
}

// The end the form currently describes, as an instant. Shared by the seed snapshot
// and the moved-or-not test so the two cannot disagree about what "the end" is.
function _compFormEndInstant(){
  const start=_compFormGetStartDate();
  const dur=_compFormGetDurMinutes();
  if(!start||!dur)return null;
  return new Date(start.getTime()+dur*60000);
}

// The create-form fallback: 48 hours after the end the form currently describes.
// Built from the two accessors the end-time preview already uses, so it moves with
// whatever the admin has typed rather than re-reading the inputs a third way.
function _compFormLateAutoFromForm(){
  const end=_compFormEndInstant();
  return end?new Date(end.getTime()+LATE_ENTRY_AUTO_SPAN_MS):null;
}
// The default span, spelled once. It mirrors LATE_ENTRY_DEFAULT_SPAN_MS in
// lib/late-entry.js — an irreducible copy, because public/js is a browser-only ESM
// graph that cannot import lib/. It is DISPLAY ONLY: ticking Automatic sends NULL
// and the SERVER derives the stored answer, so a drift here would show a wrong
// preview rather than store a wrong deadline. A Docs-hygiene lock diffs the two.
const LATE_ENTRY_AUTO_SPAN_MS=48*60*60*1000;

// v8.6.3 — the note states the deadline that is ACTUALLY SELECTED, in bold, in
// the event's timezone.
//
// It reads the CONTROL rather than a derived value, so it reports the admin's
// final selection whether that came from ticking Automatic or from typing a date
// — and it is wired to the two inputs, which it was not before: a manual deadline
// could be typed and the sentence beneath it went on describing the previous one.
// The date is bold because it is the answer the whole block exists to give, and
// the zone is named because the pair beside it is read back in that zone and a
// bare wall clock cannot say so.
export function compFormLateDeadlineChanged(){
  const note=document.getElementById('comp-late-note');
  if(!note)return;
  const auto=!!document.getElementById('comp-late-auto')?.checked;
  const d=_compFormGetLateDeadline();
  if(!d){setSafeHtml(note,'');return;}
  const tz=document.getElementById('comp-tz')?.value||'';
  const when=`<strong>${esc(fmtDt(d,'long',tz?{timeZone:tz}:undefined))}</strong>${tz?` (${esc(tz)})`:''}`;
  setSafeHtml(note, auto
    ? `Late entries close ${when} — 48 hours after the event ends. Move the end time and this moves with it.`
    : `Late entries close ${when}. This date is fixed and will NOT follow the end time.`);
}

export function _compFormGetDeadline(){
  const dEl=document.getElementById('comp-deadline-date');
  const tEl=document.getElementById('comp-deadline-time');
  if(!dEl||!tEl||!dEl.value||!tEl.value)return null;
  const tz=document.getElementById('comp-tz')?.value||'';
  const r=wallClockToUtcChecked(dEl.value,tEl.value,tz);
  return r&&r.exists?r.date:null;
}

// v8.2.0 — this used to HIDE the schedule controls the kind does not use, because
// the kind could change under an open form. It cannot any more: the wizard settles
// it in step 1 and the form renders only the controls that kind has, so there is
// nothing left to hide. What survives is the deadline field's INITIALISATION,
// which is real work — seeding a visible, editable default rather than leaving the
// one required field of a Program blank.
export function applyKindSchedule(){
  const deadline=_compFormSchedule()==='deadline';
  if(deadline){
    const dEl=document.getElementById('comp-deadline-date');
    if(dEl&&!dEl.value){
      // A sensible default the admin can see and change: 90 days out.
      const d=new Date(Date.now()+90*86400000);
      const pad=n=>String(n).padStart(2,'0');
      dEl.value=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const tEl=document.getElementById('comp-deadline-time');
      if(tEl&&!tEl.value)tEl.value='23:59';
    }
    compFormDeadlineChanged();
  }
}

// What the Checkmarx One opt-out does, in the words the folded Advanced section's
// summary line and the Create confirmation both use (operator ruling, 14 Nov
// 2026: the box is folded away on a create, so its state is said where it is
// seen).
function _cxoneAccountsLine(off){return `Checkmarx One accounts: ${off?'off':'on'}`;}

export function toggleCxoneDisabled(){
  const off=!!document.getElementById('comp-cxone-disabled')?.checked;
  const key=document.getElementById('comp-cxone-key');
  const grp=document.getElementById('comp-cxone-group');
  if(key)key.disabled=off;
  if(grp)grp.disabled=off;
  document.querySelectorAll('.comp-form-cxone-actions button').forEach(b=>{b.disabled=off;});
  // The summary line follows the box, whether ticked by hand or seeded by a type change.
  const line=document.getElementById('comp-advanced-cxone');
  if(line)line.textContent=_cxoneAccountsLine(off);
}

// v7.16.0 — the ONE predicate behind both the trusted-IP control's enabled state
// and whether the save sends the field, so the two can't disagree. Mirrors the
// server rule (routes/competitions.js PUT + routes/sessions.js timeslot create):
// trusted networks are single-session only. Returns '' when they apply, otherwise
// the reason they don't — phrased as the remedy, since that reason is what the
// admin reads in the form.
function _trustedIpsBlockedReason(){
  const group=document.getElementById('comp-trusted-ips-group');
  if(!group)return 'unavailable';                    // form not open / control absent
  // Count PERSISTED sessions, captured when the form opened — not the DOM rows.
  // The server counts competition_timeslots, and a row the admin queued for
  // deletion has already left the DOM while its database row is still there when
  // the PUT lands (single-mode saves never flush _pendingSlotDeletes at all).
  const persisted=parseInt(group.dataset.existingSessions,10)||0;
  if(persisted>0)return `This event has ${persisted} session${persisted===1?'':'s'}. Trusted networks are supported for single-session events only — remove the sessions first.`;
  const mode=document.querySelector('input[name="comp-mode"]:checked')?.value||'single';
  if(mode==='multi'){
    // The stored value stays visible while disabled, so the note can name it: the
    // timeslot POST would otherwise refuse the sessions and the admin would have
    // no idea which setting was in the way.
    return (document.getElementById('comp-trusted-ips')?.value||'').trim()
      ?'Trusted networks are supported for single-session events only. Switch back to "Single session" and clear this field before adding sessions.'
      :'Trusted networks are supported for single-session events only. Switch Schedule to "Single session" to set them.';
  }
  return '';
}

// v7.16.0 — re-evaluate the trusted-IP control. Called on open, on every schedule
// mode change, and from updateSessionRemoveBtns (the shared hook for both adding
// and removing a session row), so the control can never be left enabled on a shape
// the server will refuse.
export function updateTrustedIpsVisibility(){
  const group=document.getElementById('comp-trusted-ips-group');
  if(!group)return;
  const why=_trustedIpsBlockedReason();
  const input=document.getElementById('comp-trusted-ips');
  const help=document.getElementById('comp-trusted-ips-help');
  const note=document.getElementById('comp-trusted-ips-note');
  if(input)input.disabled=!!why;
  if(help)help.hidden=!!why;
  if(note){note.hidden=!why;note.textContent=why;} // textContent: the reason is plain text, no sink needed
  // "Use my current address" follows the field it fills, and its last answer
  // goes with it: the reason above is what the admin reads instead. (Its note is
  // a live region kept in the page, empty and collapsed, so an answer written
  // into it is announced.)
  const mine=document.getElementById('comp-trusted-ips-mine');
  if(mine)mine.disabled=!!why;
  const mineNote=document.getElementById('comp-trusted-ips-mine-note');
  if(mineNote&&why){mineNote.textContent='';mineNote.classList.remove('is-warn');}
}

// "USE MY CURRENT ADDRESS": the address the platform sees this admin at
// (GET /api/admin/my-address), added to Trusted network IPs ONLY when it is a
// public address. An organiser on the venue's network reaches the platform from
// the venue's egress address, which is what the field wants. Any other range
// (loopback, private, link-local, shared) is not what the internet sees of the
// venue, so nothing is added and the note says why: behind a proxy, the platform
// is not reading the address the proxy forwards (TRUST_PROXY), and every
// participant would then share that one address too. The server names the range
// (lib/util.js ipAddressRange); this never re-derives one, and a range it does
// not know is a warning, never an addition. The table below words exactly the
// names lib/util.js `IP_RANGE_NAMES` lists (a mirror, held both ways by
// tests/my-address.api.spec.js). An address already listed is not added twice.
// One request per form at a time; an answer for a form since closed or
// re-opened, or a field since disabled, changes nothing.
const _MY_ADDRESS_RANGE_WORDS={
  loopback:'a loopback address',
  private:'a private network address',
  link_local:'a link-local address',
  shared:'a shared (carrier-grade NAT or VPN) address',
  unspecified:'an unspecified address',
};
export async function useMyAddressForTrustedIps(){
  const input=document.getElementById('comp-trusted-ips');
  const note=document.getElementById('comp-trusted-ips-mine-note');
  if(!input||!note||input.disabled||input._myAddrBusy)return;
  const say=(text,warn)=>{note.textContent=text;note.classList.toggle('is-warn',!!warn);};
  let r=null,d=null;
  input._myAddrBusy=true;
  try{
    r=await fetchTransientRetry('/api/admin/my-address',undefined,{attempts:2,timeoutMs:10000});
    d=r?await readBody(r):null;
  }finally{input._myAddrBusy=false;}
  if(!input.isConnected||input.disabled)return;
  if(!r||!r.ok||!d||typeof d!=='object'){
    // A refusal says why in its own words; anything else gets the plain sentence.
    const refused=r&&r.status<500&&d&&typeof d.error==='string'?d.error:'';
    say(refused||'Could not read your current address. Try again.',true);
    return;
  }
  const ip=typeof d.ip==='string'?d.ip.trim():'';
  if(!ip){say('The platform could not tell which address you are at, so nothing was added.',true);return;}
  if(d.range!=='public'){
    const what=_MY_ADDRESS_RANGE_WORDS[d.range]||'an address it cannot place';
    say(`The platform sees you at ${ip}, ${what}: not a public address, so it is not your venue's and nothing was added. If the platform runs behind a proxy, its TRUST_PROXY setting is probably wrong: tell whoever runs the server.`,true);
    return;
  }
  const cur=input.value.trim().replace(/,\s*$/,'');
  const listed=cur.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if(listed.includes(ip.toLowerCase())){
    say(`${ip}, the address the platform sees you at now, is already in the list.`,false);
    return;
  }
  input.value=cur?`${cur}, ${ip}`:ip;
  say(`Added ${ip}, the address the platform sees you at now: it is your venue's address only while you are on the venue's network. Save to apply it.`,false);
}

// ext-audit v7.21.1 (A4) — switching an existing MULTI-session competition to
// "Single session" was a false save: the toggle only hid the sessions section,
// so no session was ever deleted, the success toast appeared, and reopening the
// form showed the competition still multi-session. Worse, the save also wrote
// the single-session start_time/duration_minutes over the competition row,
// leaving it permanently contradicting its own sessions. There is no other UI
// path to the intended end state — the per-row Remove button lives inside the
// section the switch hides — so the switch has to be REAL, not refused.
//
// Switching to single therefore queues every PERSISTED session for deletion,
// exactly as if the admin had pressed Remove on each row; switching back to
// multi un-queues the rows that are still on screen. A row the admin removed by
// hand is gone from the DOM, so it correctly stays queued through both switches.
// Destructive risk is bounded by the server (routes/sessions.js), which refuses
// to delete a session that has started, has assigned participants, or carries
// submissions or hint reveals — and the mode toggle is disabled outright once
// any session has started.
function _syncPendingSlotDeletesForMode(mode){
  if(!document.getElementById('comp-edit-id')?.value)return;   // create: nothing is persisted yet
  const rendered=[...document.querySelectorAll('#comp-sessions-list .session-form-row')]
    .map(r=>r.dataset.tsId).filter(Boolean);
  if(mode==='single'){
    for(const id of rendered)if(!S._pendingSlotDeletes.includes(id))S._pendingSlotDeletes.push(id);
  }else{
    // Back to multi: the rows are on screen again and will be PUT by the save,
    // so deleting them too would be a contradiction the server resolves by
    // luck of ordering.
    S._pendingSlotDeletes=S._pendingSlotDeletes.filter(id=>!rendered.includes(id));
  }
}

export function toggleCompFormMode(){
  const mode=document.querySelector('input[name="comp-mode"]:checked')?.value||'single';
  document.getElementById('comp-single-section').style.display=mode==='single'?'':'none';
  document.getElementById('comp-multi-section').style.display=mode==='multi'?'':'none';
  _syncPendingSlotDeletesForMode(mode);
  // Label highlight is handled by CSS (.comp-mode-radio:checked + .comp-mode-option).
  if(mode==='multi'){
    const list=document.getElementById('comp-sessions-list');
    if(!list.children.length){
      // Transfer single session values to session #1
      const startDate=_compFormGetStartDate()||new Date();
      const dur=_compFormGetDurMinutes()||180;
      addCompFormSession('',startDate,dur);
      addCompFormSession('',null,dur);
    }
  }
  // v7.16.0 — the mode IS the single-session test, so re-evaluate on every switch.
  // Switching to multi already goes through addCompFormSession on the first pass,
  // but switching back to single touches no session row at all.
  updateTrustedIpsVisibility();
}

export function addCompFormSession(name,startDate,duration,existingId,locked,statusLabel,updatedAt){
  S._compFormSessionCounter++;
  const idx=Number(S._compFormSessionCounter);   // a counter: rendered into ids as a number
  const pad=n=>String(n).padStart(2,'0');
  const d=startDate||new Date();
  const dateVal=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const timeVal=`${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const list=document.getElementById('comp-sessions-list');
  const row=document.createElement('div');
  row.className='session-form-row';
  row.dataset.idx=idx;
  if(existingId)row.dataset.tsId=existingId;
  if(updatedAt)row.dataset.tsUpdatedAt=updatedAt;
  const isEnded=statusLabel==='ended';
  const isLive=statusLabel==='live';
  const isStarted=isLive||isEnded;
  const disName=isEnded?'disabled':'';
  const disStart=isStarted?'disabled':'';
  // Show End Now for live sessions, and for pending sessions when competition is live
  const showEndNow=existingId&&(isLive||(statusLabel==='upcoming'&&S._compFormCompStatus==='live'));
  const statusBadge=statusLabel?`<span class="status-badge ${esc(statusLabel)}" style="font-size:var(--fs-12);margin-left:8px">${esc(statusLabel)}</span>`:'';
  const reviveHint=isEnded?'<span style="font-size:var(--fs-12);color:var(--muted);margin-left:4px">Extend duration or add participants to revive</span>':'';
  const dur=duration||180;
  const durD=Math.floor(dur/1440),durH=Math.floor((dur%1440)/60),durM=dur%60;
  setSafeHtml(row, `<div class="session-form-head">
    <strong style="font-size:var(--fs-14)">Session #${idx}</strong>${statusBadge}${reviveHint}
    <span style="flex:1"></span>
    ${!isStarted?`<button type="button" class="btn sm danger session-remove-btn" style="padding:2px 8px;font-size:var(--fs-12)" data-action="session-form-row-remove">Remove</button>`:''}
    ${showEndNow?`<button type="button" class="btn sm danger" style="padding:2px 8px;font-size:var(--fs-12)" data-action="ts-end-now" data-comp-id="${esc(document.getElementById('comp-edit-id')?.value||'')}" data-ts-id="${esc(existingId)}">End Now</button>`:''}
  </div>
  <div class="form-group" style="margin-bottom:6px"><label style="font-size:var(--fs-13)">Name <span class="req">*</span></label><input aria-required="true" class="ts-name" maxlength="120" value="${esc(name||'')}" placeholder="e.g. APAC Session, EU Morning" aria-label="Session name" ${disName}/></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
    <div class="form-group" style="margin-bottom:0;flex:1;min-width:120px"><label style="font-size:var(--fs-13)">Date</label><input type="date" class="ts-date" value="${dateVal}" aria-label="Session start date" ${disStart} data-change-action="session-form-update-end"/></div>
    <div class="form-group" style="margin-bottom:0;flex:1;min-width:100px"><label style="font-size:var(--fs-13)">Time</label><input type="time" class="ts-time" value="${timeVal}" aria-label="Session start time" ${disStart} data-change-action="session-form-update-end"/></div>
    <div class="form-group" style="margin-bottom:0;flex:1;min-width:200px"><label style="font-size:var(--fs-13)">Timezone</label>${_buildTzInput(null,'ts-tz')}</div>
  </div>
  <div class="session-form-dur-box">
    <div style="flex:0 0 auto">
      <label style="font-size:var(--fs-12);font-weight:var(--fw-semibold);display:block;margin-bottom:3px">Duration <span class="req">*</span></label>
      <div style="display:flex;gap:3px;align-items:center">
        <input type="number" class="ts-dur-d" value="${durD}" min="0" max="365" step="1" style="width:56px" aria-label="Session duration days" data-change-action="session-form-dur-changed"/><span style="font-size:var(--fs-12);color:var(--muted)">d</span>
        <input type="number" class="ts-dur-h" value="${durH}" min="0" max="23" step="1" style="width:56px" aria-label="Session duration hours" data-change-action="session-form-dur-changed"/><span style="font-size:var(--fs-12);color:var(--muted)">h</span>
        <input type="number" class="ts-dur-m" value="${durM}" min="0" max="59" step="1" style="width:56px" aria-label="Session duration minutes" data-change-action="session-form-dur-changed"/><span style="font-size:var(--fs-12);color:var(--muted)">m</span>
      </div>
    </div>
    <div class="session-form-dur-or" aria-hidden="true">or</div>
    <div class="session-form-end-col">
      <label style="font-size:var(--fs-12);font-weight:var(--fw-semibold);display:block;margin-bottom:3px" aria-hidden="true">End Date/Time</label>
      <div class="session-form-end-fields">
        <input type="date" class="ts-end-date" aria-label="Session end date" data-change-action="session-form-end-changed"/>
        <input type="time" class="ts-end-time" aria-label="Session end time" data-change-action="session-form-end-changed"/>
      </div>
    </div>
  </div>
  <div class="ts-end-preview" style="font-size:var(--fs-12);color:var(--muted);margin-top:4px"></div>`);
  list.appendChild(row);
  updateSessionRemoveBtns();
  // Initialise end time preview
  const dateInput=row.querySelector('.ts-date');
  if(dateInput)sessionFormUpdateEnd(dateInput);
}

export function updateSessionRemoveBtns(){
  const rows=document.querySelectorAll('#comp-sessions-list .session-form-row');
  const removeBtns=document.querySelectorAll('#comp-sessions-list .session-remove-btn');
  const showRemove=rows.length>2;
  removeBtns.forEach(btn=>{btn.style.display=showRemove?'':'none';});
  // v7.16.0 — the shared hook for a session row being added OR removed, so the
  // trusted-IP control follows the form's session set from one place.
  updateTrustedIpsVisibility();
}

export function editCompetition(id){openCompetitionForm(id);}

export function _highlightField(el){
  if(!el)return;
  el.style.outline='2px solid var(--red)';
  el.style.outlineOffset='-1px';
  setTimeout(()=>{el.style.outline='';el.style.outlineOffset='';},3000);
}

// v7.16.0 — the trusted-IP value to send, or null when the control does not apply.
// null means OMIT the field: the server reads an absent value as "leave unchanged",
// while an empty string CLEARS it — so sending "" from a multi-session form would
// be a clear the admin never asked for (and a 400, since sessions exist).
function _collectTrustedIps(){
  if(_trustedIpsBlockedReason())return null;
  return (document.getElementById('comp-trusted-ips')?.value||'').trim();
}

// v8.2.0 — A CONTROL THAT IS NOT RENDERED IS NOT SENT.
//
// This is the load-bearing half of scoping the form by kind. Reading an absent
// checkbox as `false` and sending it would turn HIDING a control into a silent
// WRITE: on an edit it would clear whatever the column actually held, which is
// the v7.15.8 "an admin save must never erase a field" defect relocated into the
// render layer — and invisible, because the admin never saw the control that did
// it. `undefined` means "the caller said nothing", which is exactly what every
// one of these columns is built for: the PUT COALESCEs an absent value and the
// POST falls back to the kind's own default (routes/competitions.js).
//
// It also makes the two directions agree. The server refuses these settings for
// a kind that cannot honour them (`reveal_answers_forbidden`,
// `group_leaderboard_forbidden`, `measure_presence_forbidden`); omitting rather
// than sending `false` means the form never argues with a refusal it agrees with.
/**
 * v8.4.0 — MANDATORY FORCES SHOWN, and the control says so rather than being
 * quietly overruled.
 *
 * The stored shape has three states, so "mandatory but not shown" is not
 * representable — which is the point of storing states rather than two booleans.
 * The dialog still offers the two controls the operator asked for, so this is
 * where the impossible corner is closed: choosing Mandatory ticks the checkbox
 * and DISABLES it. Leaving it enabled and ignoring it would be accept-and-ignore;
 * hiding it would be the shrinking-menu failure. Disabled-and-ticked states the
 * rule on screen.
 */
export function compRegFieldChanged(){ renderRegPreview(); }

const _REG_PREVIEW_LABELS={personal_title:'Salutation',phone:'Phone',city:'City',linkedin_url:'LinkedIn profile URL',job_function:'Job function'};
/** The live preview: the sign-up card a walk-up would see with these switches. */
export function renderRegPreview(){
  const box=document.getElementById('reg-preview');
  if(!box)return;
  const states=_collectRegistrationFields()||{};
  const field=(label,note)=>`<div class="reg-preview-field"><span>${esc(label)}${note?` <em>${esc(note)}</em>`:''}</span><i aria-hidden="true"></i></div>`;
  const extras=Object.keys(_REG_PREVIEW_LABELS).filter(k=>states[k]&&states[k]!=='hidden')
    .map(k=>field(_REG_PREVIEW_LABELS[k],states[k]==='optional'?'(optional)':''));
  setSafeHtml(box,`<p class="eyebrow">Preview</p><div class="reg-preview-card">
    <p class="reg-preview-title">Create your account</p>
    <div class="reg-preview-pair">${field('First name')}${field('Last name')}</div>
    ${field('Company')}${field('Job title')}
    <p class="reg-preview-loc">Your local time · your country — change</p>
    ${extras.join('')}
    <span class="reg-preview-btn">Create account and continue</span></div>`);
}

/**
 * v8.4.0 — the two controls collapsed back into one state per field.
 *
 * `undefined` when the section is not rendered, which is the `_optCheck` doctrine
 * one level up: a control that is not on screen must not be SENT, or hiding it
 * becomes a silent write. The server then leaves the column alone.
 */
function _collectRegistrationFields(){
  const rows=document.querySelectorAll('[data-reg-row]');
  if(!rows.length)return undefined;
  const out={};
  for(const row of rows){
    const key=row.getAttribute('data-reg-row');
    const on=row.querySelector('input[data-reg-state]:checked');
    out[key]=on?on.value:'optional';
  }
  return out;
}

function _optCheck(id){
  const el=document.getElementById(id);
  return el?!!el.checked:undefined;
}

// The settings that do not depend on the schedule shape, resolved ONCE. They were
// spelled out verbatim in BOTH the single- and multi-session returns — two copies
// of one list, which is precisely how `measure_presence`, `time_basis` and
// `measure_presence` and `time_basis` came to be collected by both and sent by
// neither.
function _collectSharedCompFields(){
  const tb=document.getElementById('comp-time-basis');
  return {
    reveal_answers_on_end:_optCheck('comp-reveal-answers'),
    group_leaderboard_enabled:_optCheck('comp-group-leaderboard'),
    cxone_disabled:_optCheck('comp-cxone-disabled'),
    // Event team reports — rendered on every CREATE: the create POST reads it,
    // and a template create sends it with the spawn (never the PUT after it).
    add_qualifying:_optCheck('comp-add-qualifying'),
    measure_presence:_optCheck('comp-measure-presence'),
    // v8.12.0 — universal, so always rendered; a DISABLED (locked) box still
    // reports its stored value, which the server treats as an echo, not a change.
    staff_compete:_optCheck('comp-staff-compete'),
    // Not a checkbox pair but the same rule: absent control, absent field.
    time_basis:tb?(tb.checked?'presence':'elapsed'):undefined,
    // Absent control, absent field. A DISABLED (locked) select still reports the
    // stored value, which the server treats as an echo, never a change.
    clock_start:document.getElementById('comp-clock-start')?.value||undefined,
    trusted_network_ips:_collectTrustedIps(),
    // v8.4.0 — both `undefined` when the section is not rendered for this kind.
    registration_fields:_collectRegistrationFields(),
    // v8.6.0 — late entries. `_optCheck` for the toggle, so a kind whose form does
    // not render the section sends nothing and the server's default applies.
    //
    // THE DEADLINE HAS THREE OUTGOING STATES, and collapsing any two of them loses
    // a real instruction:
    //   undefined — the section is not rendered (this kind has no late window)
    //   null      — Automatic is ticked: "follow the event's end", which is a
    //               deliberate clearing, not silence
    //   an ISO    — the admin pinned this instant
    // `_optCheck`'s undefined-when-absent rule handles the first; the other two are
    // what `allowEmpty` on the server's `date` rule exists for.
    late_entry_enabled:_optCheck('comp-late-entry'),
    late_entry_deadline_at:_collectLateDeadline(),
    // Client-side only — it drives the dry-run TAG sync, not a competition column.
    internal:!!document.getElementById('comp-internal')?.checked,
    attempt_cap:(document.getElementById('comp-attempt-cap')?.value.trim()||null),
  };
}

// The three-state deadline. Returns undefined when the section is not rendered,
// "" (which the server's `allowEmpty` date rule normalises to NULL) when Automatic
// is ticked, and an ISO string when the admin pinned one.
function _collectLateDeadline(){
  const box=document.getElementById('comp-late-entry');
  if(!box)return undefined;                       // not rendered for this kind
  if(!box.checked)return undefined;               // feature off — leave the column alone
  if(document.getElementById('comp-late-auto')?.checked)return '';
  const d=_compFormGetLateDeadline();
  const p=S._compFormLatePinned;
  // v8.12.7 — the pair shows a pin rounded DOWN to the minute. An untouched pair
  // echoes the STORED instant, never the rounded one: rounding rewinds the pin,
  // writes a false History entry, and on a pin set in the minute the event ended
  // makes an unrelated save be refused (the rounded value falls before the end).
  //
  // "Untouched" is decided on the pair's TEXT — the pin rendered in the dialog's
  // zone, exactly as the open seeded it — and NOT on the instant the text reads
  // back as. The two differ in one place: the REPEATED hour of a fall-back night,
  // where one wall clock names two instants and `wallClockToUtcChecked` takes the
  // first. A pin in the SECOND 01:30 (America/New_York, 06:30Z on the first
  // Sunday of November) read back as 05:30Z, compared unequal, and an unrelated
  // save sent that and rewound the pin an hour, with a false History entry.
  //
  // Nothing re-renders a PINNED pair after the open (the v8.6.3 timezone re-render
  // fills the Automatic pair only), so the text can drift from the seed only by
  // the admin typing — or by a timezone change re-reading the same text in a new
  // zone, where the text no longer matches the pin rendered in that zone and the
  // re-read instant is sent, as it always was. The server exempts an echo from the
  // 30-day cap only, and judges it against the end like any other value.
  if(p){
    const wc=utcToWallClock(new Date(p),document.getElementById('comp-tz')?.value||'');
    const dv=document.getElementById('comp-late-deadline-date')?.value||'';
    const tv=(document.getElementById('comp-late-deadline-time')?.value||'').slice(0,5);
    if(wc&&wc.date===dv&&wc.time===tv)return p;
  }
  return d?d.toISOString():undefined;
}

export function _collectCompFormData(){
  const nameEl=document.getElementById('comp-name');
  const name=nameEl.value.trim();
  if(!name){showToast('Event name is required.');_highlightField(nameEl);return null;}
  const mode=document.querySelector('input[name="comp-mode"]:checked')?.value||'single';
  const lbSelect=document.getElementById('comp-lb-mode');
  // v8.1.0 (PR 13) / v8.2.0 — the chosen kind, CREATE only. It comes from the ONE
  // resolver rather than a second reading of the DOM: this used to query the
  // chooser's `:checked` radio, and when step 1 replaced that radiogroup with
  // cards the query silently matched nothing — so every event created through the
  // wizard would have been stored as the default kind whatever card was clicked,
  // with nothing erroring. `saveCompetition` still omits it on a PUT (the kind is
  // immutable and the server answers 400 `event_kind_immutable` on a change).
  const eventKind=_compFormKind();
  // v8.1.0 (PR 16) — a deadline-shaped kind has NO duration control, so the
  // duration block below must be skipped entirely. Left in, `_compFormGetDurMinutes()`
  // reads three absent inputs as 0 and the handler returns null BEFORE the request
  // is built: the admin fills a complete Program form, clicks Save, and is told a
  // field the form does not show is invalid.
  const _isDeadlineKind=_compFormSchedule()==='deadline';
  let deadlineIso=null;
  if(_isDeadlineKind){
    const dl=_compFormGetDeadline();
    if(!dl){showToast('A deadline is required for this event type.');_highlightField(document.getElementById('comp-deadline-date'));return null;}
    const st=_compFormGetStartDate();
    if(st&&dl.getTime()<=st.getTime()){showToast('The deadline must be after the start time.');_highlightField(document.getElementById('comp-deadline-date'));return null;}
    deadlineIso=dl.toISOString();
  }

  if(mode==='single'){
    const dateEl=document.getElementById('comp-date');
    const timeEl=document.getElementById('comp-time');
    const startLocked=dateEl.disabled;
    const dateVal=dateEl.value;const timeVal=timeEl.value;
    const duration=_isDeadlineKind?null:_compFormGetDurMinutes();
    if(!startLocked){
      if(!dateVal){showToast('Start date is required.');_highlightField(dateEl);return null;}
      if(!timeVal){showToast('Start time is required.');_highlightField(timeEl);return null;}
    }
    if(!_isDeadlineKind){
      if(!duration||duration<1){showToast('Duration must be at least 1 minute.');return null;}
      if(duration>525600){showToast('Duration cannot exceed 365 days (525600 minutes).');return null;} // batch 4: days max=365 + nonzero h/m could exceed the server cap
    }
    const tzVal=document.getElementById('comp-tz')?.value||'';
    if(!startLocked&&!_isValidTz(tzVal)){showToast('Please select a valid timezone.');_highlightField(document.getElementById('comp-tz'));return null;}
    const start_time=startLocked?null:_compFormGetStartDate()?.toISOString()||null;
    // v7.21.19 (audit F2) — refuse a start time that never happens (a
    // spring-forward gap). Checked AFTER the call, because the helper is what
    // does the conversion and therefore what knows.
    if(!startLocked&&_compFormGetStartDate._dstError){
      showToast(_compFormGetStartDate._dstError,'error');
      _highlightField(document.getElementById('comp-time'));
      return null;
    }
    return {name,start_time,duration_minutes:duration,mode,sessions:[],leaderboard_mode:lbSelect?.disabled?null:lbSelect?.value||null,event_kind:eventKind,deadline_at:deadlineIso,..._collectSharedCompFields()};
  }

  // Multi mode — collect sessions from inline form rows
  const rows=document.querySelectorAll('#comp-sessions-list .session-form-row');
  if(rows.length<2){showToast('Multiple session mode requires at least 2 sessions.');return null;}
  const sessions=[];
  for(const row of rows){
    const nameInput=row.querySelector('.ts-name');
    const dateInput=row.querySelector('.ts-date');
    const timeInput=row.querySelector('.ts-time');
    const sName=nameInput?.value?.trim();
    const sDate=dateInput?.value;
    const sTime=timeInput?.value;
    const sDur=_sessionGetDurMinutes(row);
    const tsId=row.dataset.tsId||null;
    const startLocked=dateInput?.disabled;
    if(!sName){showToast('All session names are required.');_highlightField(nameInput);return null;}
    if(!startLocked){
      if(!sDate){showToast(`Date is required for session "${sName}".`);_highlightField(dateInput);return null;}
      if(!sTime){showToast(`Time is required for session "${sName}".`);_highlightField(timeInput);return null;}
    }
    if(!sDur||sDur<1){showToast(`Duration must be at least 1 minute for session "${sName}".`);return null;}
    if(sDur>525600){showToast(`Duration cannot exceed 365 days for session "${sName}".`);return null;} // batch 4
    const sTz=row.querySelector('.ts-tz')?.value||'';
    if(!startLocked&&!_isValidTz(sTz)){showToast(`Please select a valid timezone for session "${sName}".`);return null;}
    const sStart=startLocked?null:(_sessionGetStartUtc(row)?.toISOString()||new Date(`${sDate}T${sTime}`).toISOString());
    // v7.21.19 (audit F2) — refuse a session start that never happened. Named,
    // because with several rows the admin needs to know WHICH one.
    if(!startLocked&&_sessionGetStartUtc._dstError){
      showToast(`Session "${sName}": ${_sessionGetStartUtc._dstError}`,'error');
      _highlightField(row.querySelector('.ts-time'));
      return null;
    }
    sessions.push({name:sName,start_time:sStart,duration_minutes:sDur,existingId:tsId,updatedAt:row.dataset.tsUpdatedAt||null});
  }
  // Client-side duplicate name check prevents a partial save where the
  // competition body succeeds but a later session POST/PUT 409s silently.
  const _seenNames=new Set();
  for(const s of sessions){
    const k=s.name.toLowerCase();
    if(_seenNames.has(k)){showToast(`Duplicate session name: "${s.name}". Each session must have a unique name.`);return null;}
    _seenNames.add(k);
  }
  // Use only sessions with known start_time for competition-level start/duration
  const withStart=sessions.filter(s=>s.start_time);
  const earliest=withStart.length?withStart.reduce((a,b)=>new Date(a.start_time)<new Date(b.start_time)?a:b):null;
  const latest=withStart.length?withStart.reduce((a,b)=>{
    const aEnd=new Date(a.start_time).getTime()+a.duration_minutes*60000;
    const bEnd=new Date(b.start_time).getTime()+b.duration_minutes*60000;
    return aEnd>bEnd?a:b;
  }):null;
  const compStart=earliest?earliest.start_time:null;
  const totalDur=compStart&&latest?Math.ceil((new Date(latest.start_time).getTime()+latest.duration_minutes*60000-new Date(compStart).getTime())/60000):null;
  return {name,start_time:compStart,duration_minutes:totalDur,mode,sessions,leaderboard_mode:lbSelect?.disabled?null:lbSelect?.value||null,event_kind:eventKind,deadline_at:deadlineIso,..._collectSharedCompFields()};
}

// v8.2.0 — the kind's own label for the save confirmations. A Program admin
// being asked "Create Competition?" is the same wrongness as a Program form
// headed "Competition Name": the platform has three kinds and the copy named
// one of them. Falls back to the collective when the vocabulary is absent,
// which is the rule for every kind label (ui/format.js).
function _saveKindLabel(){return eventKindLabel(_compFormKind())||eventCollectiveSingular();}

// v8.12.0 — THE THREE "STAFF CAN COMPETE" REFUSALS THAT CARRY A LIST. Turning
// the switch ON is refused while an UNSEALED challenge is assigned
// (`challenges`) or while an ENROLLED person wrote one of its challenges
// (`participants`, each with their `tasks`); turning it OFF while a staff
// member is enrolled (`participants`). All name the rows because the remedy is
// per row — seal or unassign each challenge, remove each person — and a toast
// cannot hold a list. Returns true when it rendered one, so the caller falls
// back to its ordinary toast otherwise.
export function showStaffCompeteRefusalModal(d,extra=''){
  if(!d||!d.code)return false;
  if(d.code==='staff_compete_unsealed_challenges'){
    const rows=Array.isArray(d.challenges)?d.challenges:[];
    showModal({
      title:'Seal these challenges first',
      message:`${esc(d.error||'')}${extra?` ${esc(extra)}`:''}<ul style="margin:8px 0 0 18px">${rows.map(t=>`<li>${esc(t.title)}</li>`).join('')}</ul><p style="margin-top:8px;color:var(--muted);font-size:var(--fs-14)">A sealed challenge's answer is hidden from every admin but its author. Seal a new copy of each one, or take it out of the event, then turn the switch on.</p>`,
      confirmText:'OK',cancelText:null,
    });
    return true;
  }
  if(d.code==='staff_compete_enrolled_authors'){
    const rows=Array.isArray(d.participants)?d.participants:[];
    showModal({
      title:'Remove these authors first',
      message:`${esc(d.error||'')}${extra?` ${esc(extra)}`:''}<ul style="margin:8px 0 0 18px">${rows.map(u=>`<li><strong>${esc(u.nickname||u.id)}</strong> — ${(u.tasks||[]).map(t=>`“${esc(t.title)}”`).join(', ')}</li>`).join('')}</ul><p style="margin-top:8px;color:var(--muted);font-size:var(--fs-14)">A challenge's answer is known to whoever wrote it, so its author cannot compete in an event that holds it. Remove them from the event (Manage Participants) or take their challenges out of it, then turn the switch on.</p>`,
      confirmText:'OK',cancelText:null,
    });
    return true;
  }
  if(d.code==='staff_compete_enrolled_staff'){
    const rows=Array.isArray(d.participants)?d.participants:[];
    showModal({
      title:'Remove these staff members first',
      message:`${esc(d.error||'')}${extra?` ${esc(extra)}`:''}<ul style="margin:8px 0 0 18px">${rows.map(u=>`<li>${esc(u.nickname||u.id)}</li>`).join('')}</ul><p style="margin-top:8px;color:var(--muted);font-size:var(--fs-14)">They are on the board because staff compete here. Remove them from the event (Manage Participants), then turn the switch off.</p>`,
      confirmText:'OK',cancelText:null,
    });
    return true;
  }
  return false;
}

// v8.12.7 — DOES AN AUTO-ENDED EVENT STAY ENDED WHEN THIS SAVE EXTENDS IT? The
// server's revive gate (routes/competitions.js, and its per-session twin in
// routes/sessions.js) re-asks "has everybody finished?" — and so may keep the
// event ended — only when the event can auto-end on all-solved at all AND its join
// link is closed (v7.7.18: an open link must never leave an event stuck ended). In
// every other case it revives. The warning read `ended_at` alone, so it told an
// admin extending a legacy v8.0.0 Booth Event (a kind that never auto-ends, its
// column 0) or an event with an open join link that saving "keeps it ended" — and
// the save then revived it. Both columns ride the admin list row. The kind's own
// prohibition needs no third clause here: `auto_end_on_all_solved` is 0 for every
// Booth Event (the create seed, the kind-change reset and the v8.3.11 boot
// normalisation all write 0). What the client still cannot see is the re-check's
// answer; the kept-ended wording predicts the ordinary case — everybody HAS
// finished, which is how the event auto-ended in the first place.
function _autoEndKeepsEnded(comp){
  return !!comp?.auto_end_on_all_solved&&!comp?.self_enroll_enabled;
}

// A REVIVE LEAVES ISSUED CERTIFICATES AS THEY ARE (operator ruling, 17 Nov 2026):
// a placing the new results move is not re-issued by itself. Said wherever a
// revive is confirmed (this form's save, the assign dialogs' revival warning),
// from the admin list's live count. A completion certificate (a Program) attests
// the holder's own finish, which a revive does not move, so it says nothing.
// Plain text: each caller escapes it into its own markup.
export function certificatesKeptOnReviveNote(comp){
  const n=Number(comp?.certificates_issued)||0;
  if(!n||policyOrDefault(comp.policy).certificate==='completion')return '';
  return `${comp.name} has already issued ${n} certificate${n===1?'':'s'}. They stay as issued: if the new results change someone's placing, a superadmin can revoke that certificate and issue it again from the new results.`;
}

// A create that started from a template is made by the template's own door
// (spawn: its challenges, join-link settings, tags and provenance), and the
// form is then applied to that new event as an ordinary edit. Spawning needs a
// start in the future; the real start rides the edit that follows.
// The form a refused first save left behind: its event exists, so the button
// finishes it, and "Add the
// qualifying questions", which rode the spawn, can no longer change.
function _markSpawnedForm(spawned){
  const ov=document.getElementById('comp-form-overlay');
  if(!ov)return;
  ov._spawned=spawned;
  const save=ov.querySelector('[data-action="comp-save"]');if(save)save.textContent='Finish creating';
  const q=ov.querySelector('#comp-add-qualifying');if(q)q.disabled=true;
}

// Whether an admin-list event row already holds every value a settings body
// sends, read the way the server stores them (instants for dates, truthiness for
// flags, an empty late-entry deadline as automatic, the resolved sign-up
// states). It tells a settings save whose ANSWER was lost and that landed from
// one that did not, or that someone else's change followed (`saveCompetition`).
// A field it cannot judge counts as different, so the answer errs toward "not
// this form's write", which leaves the server's own conflict check standing.
const _ROW_FLAG_KEYS=new Set(['reveal_answers_on_end','group_leaderboard_enabled','cxone_disabled','measure_presence','staff_compete','late_entry_enabled']);
const _ROW_DATE_KEYS=new Set(['start_time','deadline_at','late_entry_deadline_at']);
const _ipSet=v=>String(v||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean).sort().join(',');
function _compRowHolds(row,body){
  if(!row||!body)return false;
  const at=v=>v?Date.parse(v):null;
  return Object.entries(body).every(([k,v])=>{
    if(k==='expectedUpdatedAt'||k==='tags'||k==='add_qualifying')return true;
    if(_ROW_DATE_KEYS.has(k))return at(v)===at(row[k]);
    if(_ROW_FLAG_KEYS.has(k))return !!v===!!row[k];
    if(k==='name')return String(v).trim()===row.name;
    if(k==='time_basis')return (v||'elapsed')===(row.time_basis||'elapsed');
    if(k==='clock_start')return (v||'entry')===(row.clock_start||'entry');
    if(k==='trusted_network_ips')return _ipSet(v)===_ipSet(row.trusted_network_ips);
    if(k==='registration_fields'){
      const st=(row.policy&&row.policy.registration_fields)||{};
      return !!v&&typeof v==='object'&&Object.entries(v).every(([f,s])=>st[f]===s);
    }
    // An empty box is sent as null or "" and stored as NULL; a number may be
    // sent as typed text ("3") and is stored as a number.
    if(v===null||v===undefined||v==='')return row[k]===null||row[k]===undefined;
    if(typeof row[k]==='number')return Number(v)===row[k];
    return v===row[k];
  });
}

async function _spawnFromTemplate(tpl,fd){
  const soon=Date.now()+60000;
  const st=fd.start_time?new Date(fd.start_time).getTime():NaN;
  const startIso=new Date(Number.isFinite(st)&&st>soon?st:soon).toISOString();
  let r=null,d={};
  try{
    // "Add the qualifying questions" rides the spawn (the event's own copies are
    // made with it, as the blank create makes them); the PUT after it never sees it.
    const spawnBody={name:fd.name,start_time:startIso};
    if(fd.add_qualifying!==undefined)spawnBody.add_qualifying=fd.add_qualifying;
    r=await fetch(`/api/admin/event-templates/${encodeURIComponent(tpl.id)}/spawn`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(spawnBody)});
    d=await r.json().catch(()=>({}));
  }catch(e){
    // No answer: the spawn may have reached the server and made the event, so
    // nothing here may say it did not.
    showToast(`No answer came back when creating the event (${e&&e.message?e.message:'network error'}), so it may or may not have been made. Check the Events list before you try again.`,'error');
    loadAdminCompetitions({keepPage:true});
    return null;
  }
  if(!r||!r.ok||!d.competition){showToast((d&&d.error)||'Could not create the event from the template.','error');return null;}
  return d;
}

export async function saveCompetition(){
  let id=document.getElementById('comp-edit-id').value;
  // A CREATE (from a blank starter or a template). Kept apart from `id`, which a
  // template create takes on once the event exists.
  const creating=!id;
  const _formOv=document.getElementById('comp-form-overlay');
  const tpl=(creating&&_formOv?._template)||null;
  const fd=_collectCompFormData();
  if(!fd)return;
  // "No fixed deadline" ticked: the deadline is the one the platform filled in
  // (_noFixedDeadlineTicked says what the confirmations below do with it).
  const noFixedDeadline=!!fd.deadline_at&&_noFixedDeadlineTicked();
  // Staff compete holds sealed challenges only, and a qualifying question can
  // never be sealed, so the qualifying questions cannot join it: said here,
  // before a template spawn makes the event, rather than by the PUT that follows.
  if(tpl&&!(_formOv&&_formOv._spawned)&&fd.add_qualifying&&fd.staff_compete){
    showToast('An event where staff compete holds sealed challenges only, and a qualifying question can never be sealed, so such an event cannot ask qualifying questions. Untick one of the two.','error');
    return;
  }
  const body={name:fd.name};
  // v7.7.26 (audit H1) — in multi mode the comp-level start/duration are
  // DERIVED AGGREGATES of the session rows: status + effective end come purely
  // from the timeslots (lib/competitions.js), and the real values ride the
  // per-session PUTs below. Sending the derived start_time on an EDIT made the
  // server 400 ("Cannot change the start time of a started competition") the
  // moment ANY session was live — blocking EVERY form edit (rename, reveal
  // toggle, extending an upcoming session) of a live multi-session comp.
  // Omit both aggregates on multi-mode edits; create still sends them.
  const isMultiEdit=!!id&&fd.mode==='multi';
  if(fd.start_time&&!isMultiEdit)body.start_time=fd.start_time;
  // v8.1.0 (PR 16) — for a deadline-shaped event the DEADLINE is the authority and
  // the duration is derived server-side from the STORED start. Sending a duration
  // would be refused (`duration_not_accepted`), which is the point: two controls
  // for one fact is how the pair desyncs.
  if(fd.deadline_at){
    body.deadline_at=fd.deadline_at;
  }else if(fd.duration_minutes&&!isMultiEdit){
    body.duration_minutes=fd.duration_minutes;
  }
  if(fd.leaderboard_mode)body.leaderboard_mode=fd.leaderboard_mode;
  // v6.16.0 / v7.11.7 / v7.13.1 — these three used to be sent UNCONDITIONALLY,
  // on the reasoning that an explicit boolean is what lets unticking reset a flag.
  // That is still true, and it is still what happens whenever the control is on
  // screen. What changed in v8.2.0 is that the control may legitimately not exist:
  // the form now renders only what the kind can use, and a `false` sent for a
  // checkbox the admin never saw is a write nobody asked for. `undefined` is the
  // one value that means "the caller said nothing", and the server is built for
  // it — the PUT COALESCEs, the POST falls back to the kind's default.
  if(fd.reveal_answers_on_end!==undefined)body.reveal_answers_on_end=fd.reveal_answers_on_end;
  if(fd.group_leaderboard_enabled!==undefined)body.group_leaderboard_enabled=fd.group_leaderboard_enabled;
  if(fd.cxone_disabled!==undefined)body.cxone_disabled=fd.cxone_disabled;
  if(fd.add_qualifying!==undefined)body.add_qualifying=fd.add_qualifying;   // event team reports (create only)
  // v8.2.0 — THESE TWO WERE COLLECTED AND NEVER SENT, from the release that added
  // them (PR 34). `_collectCompFormData` read both, `saveCompetition` put neither
  // in the body, so "Record time on platform" and the tie-break checkbox did
  // nothing at all: an admin ticked them, saved, reopened, and found them clear.
  // Dead controls that appear to work, which is the same defect this whole change
  // is about — so they are wired up here rather than left for later.
  if(fd.measure_presence!==undefined)body.measure_presence=fd.measure_presence;
  if(fd.time_basis!==undefined)body.time_basis=fd.time_basis;
  if(fd.clock_start!==undefined)body.clock_start=fd.clock_start;
  // v8.12.0 — the same class, caught by the feature's own browser lock before it
  // shipped: `_collectSharedCompFields` read the box and this block never sent
  // it, so "Staff can compete" was a control that appeared to work. A DISABLED
  // (locked) box still reports its stored value, which the server treats as an
  // echo, never a change — so a rename of a started event keeps saving.
  if(fd.staff_compete!==undefined)body.staff_compete=fd.staff_compete;
  // v8.4.0 — the same `!==undefined` rule as every flag above: a control the kind
  // does not render is not sent, so the server's COALESCE keeps whatever is
  // stored. Sending `{}` or `false` here would be the silent write this shape
  // exists to prevent.
  if(fd.registration_fields!==undefined)body.registration_fields=fd.registration_fields;
  // v8.6.0 — late entries. The toggle takes the `!==undefined` rule above: a kind
  // whose form does not render the section sends nothing and the server's COALESCE
  // keeps what is stored.
  //
  // The DEADLINE takes the `attempt_cap` shape below instead, because it has THREE
  // outgoing states and only two of them are expressible by omission:
  //   undefined — not rendered / the feature is off: leave the column alone
  //   ""        — Automatic is ticked: an explicit "go back to following the end",
  //               which the server's `allowEmpty` date rule normalises to NULL
  //   an ISO    — the admin pinned this instant
  // Collapsing the middle one into the first would make "put it back on automatic"
  // unexpressible, and a setting that can be set and never unset is the failure
  // this shape exists to prevent.
  //
  // AND BOTH MUST BE HERE, not merely in the collector. `_collectCompFormData`
  // reading a control that this function never puts in the body is the exact
  // defect v8.2.0 found on `measure_presence` and `time_basis` a few lines up:
  // the admin ticks it, saves, reopens and finds it clear — a control that appears
  // to work, diagnosable from no screen.
  if(fd.late_entry_enabled!==undefined)body.late_entry_enabled=fd.late_entry_enabled;
  if(fd.late_entry_deadline_at!==undefined)body.late_entry_deadline_at=fd.late_entry_deadline_at;
  // v8.1.0 — ALWAYS SENT, including as an explicit `null`. The PUT distinguishes
  // "the caller said nothing" (leave the cap alone) from "the caller cleared it"
  // (uncap), and only an explicit null expresses the second — omitting the key on
  // a cleared box would silently keep the old cap, which is a control that
  // appears to work. `null` is what the server normalises "" to as well.
  // The attempt cap renders for every kind, so it is not conditional.
  body.attempt_cap=fd.attempt_cap===null?null:fd.attempt_cap;
  // v7.16.0 — trusted networks are sent ONLY when the control applies (single
  // session). Unlike the flags above this one is conditional: null means the
  // field is omitted so the server leaves the column alone, whereas an empty
  // string is an explicit clear. Any 400 the server raises (bad address, too
  // many entries, a CIDR wider than /16, sessions present) is surfaced verbatim
  // by the shared error path below — those messages name the remedy.
  if(fd.trusted_network_ips!==null)body.trusted_network_ips=fd.trusted_network_ips;
  // v7.8.1 — seed the `internal` tag at CREATE when the box is checked (the
  // create route accepts an initial tags array). On EDIT the tag is synced
  // separately after the PUT (below), since the competition PUT schema does
  // not manage tags.
  if(!id&&fd.internal)body.tags=[DRY_RUN_TAG];
  // v8.1.0 (PR 13) — the kind is sent on CREATE ONLY, and the `!id` guard is the
  // load-bearing half. It is immutable server-side, so echoing it on a PUT would
  // be at best a no-op and at worst — if the row's kind ever disagreed with what
  // the stale form held — a 400 `event_kind_immutable` on an unrelated rename.
  // Omitted rather than sent as null: the boundary schema types this as an enum,
  // and null is not one of its values.
  // v8.3.0 — sent on EDIT too. The `!id` guard existed because the server refused
  // any change with 400 `event_kind_immutable`; it now accepts one while the
  // event is upcoming and session-free, and treats an echo of the SAME kind as
  // no change at all — so a form that never touched the type posts its stored
  // value and nothing happens, exactly as before. Omitted rather than sent as
  // null when absent: the boundary schema types this as an enum.
  if(fd.event_kind)body.event_kind=fd.event_kind;
  // v6.16.27 — optimistic concurrency / If-Match. Echo the
  // updated_at the row had when the form was filled, so the server can detect
  // a concurrent edit by another admin and 409. Only on edit (PUT).
  // v8.14.5 — from the form's own token: the list it came from is polled, and a
  // re-read at Save carried another admin's edit past the check.
  const _formEl=document.getElementById('comp-form-overlay');
  if(id&&_formEl&&_formEl._updatedAt)body.expectedUpdatedAt=_formEl._updatedAt;
  // v8.1.0 (PR 16) — THIS is the typo defence, not the 20-year cap: a mistyped
  // 2036 for 2026 is not a range error and only a confirmation spelled in words
  // catches it. Two years is the line because a deliberate 3-year certification
  // cycle is a real thing an admin means to type. Not asked with "No fixed
  // deadline" ticked: the platform chose that date, so there is no typo to catch.
  if(body.deadline_at&&!noFixedDeadline){
    const dl=new Date(body.deadline_at);
    if(dl.getTime()-Date.now()>2*365*86400000){
      const ok=await showModal({
        title:'Confirm the deadline',
        message:`This event's deadline is <strong>${esc(fmtDt(dl,'long'))}</strong> — more than two years from now.<br><br>Is that right?`,
        confirmText:'Yes, save it',
        cancelText:'Go back',
      });
      if(!ok)return;
    }
  }
  let url=id?`/api/admin/competitions/${id}`:'/api/admin/competitions';
  let method=id?'PUT':'POST';

  if(id){
    const comp=S.adminCompetitionsData.find(c=>c.id===id);
    // Check for potential revivals and build confirmation message
    const revivalWarnings=[];
    let _revives=false;   // a branch below says this save brings the event back to life
    if(comp){
      // v8.1.1 — a deadline-shaped event has NO duration control, so the branch
      // below (gated on fd.duration_minutes) was dead for a Program and the admin
      // got no warning at all on the one save that can reopen a settled event.
      // Moving the deadline forward IS this kind's "extend the duration", so it
      // warns in the same three-way shape, keyed on the deadline instead. An
      // UNCHANGED deadline reopens nothing (the server re-derives the duration
      // only when the deadline actually moved), so it must not warn either — a
      // confirmation that fires on every save is one an admin learns to click
      // through.
      if(fd.deadline_at&&computeCompStatus(comp)==='ended'){
        const newEnd=new Date(fd.deadline_at);
        const moved=!comp.deadline_at||new Date(comp.deadline_at).getTime()!==newEnd.getTime();
        if(moved&&newEnd>new Date()){
          // With "No fixed deadline" ticked it reopens with no fixed deadline,
          // the date it records in brackets.
          const reopens=noFixedDeadline
            ?`, with ${esc(_noFixedDeadlineWords(newEnd,undefined,true))}`
            :` — its deadline is being moved to ${esc(fmtDt(newEnd,'long'))}`;
          if(comp.ended_manually){_revives=true;revivalWarnings.push(`<strong>${esc(comp.name)}</strong> was closed early and will become <strong>live</strong> again${reopens}.`);}
          else if(comp.ended_at&&_autoEndKeepsEnded(comp)) revivalWarnings.push(`<strong>${esc(comp.name)}</strong> auto-ended because every participant had already finished every challenge — solved it, or run out of attempts. Saving keeps it <strong>ended</strong> — add new participants, or grant an exhausted participant more attempts, to revive it.`);
          else if(comp.ended_at){_revives=true;revivalWarnings.push(`<strong>${esc(comp.name)}</strong> auto-ended before its deadline and will become <strong>live</strong> again${reopens}.`);}
          else{_revives=true;revivalWarnings.push(`<strong>${esc(comp.name)}</strong> ended when its deadline passed. ${noFixedDeadline?`Saving it with ${esc(_noFixedDeadlineWords(newEnd,undefined,true))}`:`Moving the deadline to ${esc(fmtDt(newEnd,'long'))}`} will make it <strong>live</strong> again.`);}
        }
      }
      // v8.12.7 — WARN ONLY WHEN THIS SAVE MOVES THE SCHEDULE, the server's own
      // v8.1.9 rule (`_extendRevives`): an unchanged start and duration revive
      // nothing. The form round-trips the stored duration, and in the ~60 s after
      // End Now the scheduled end it derives still lies in the future (End Now
      // rounds the elapsed time UP to a minute), so without this gate the confirm
      // said "will become live again" on precisely the save that pins the
      // late-entry deadline to now — a save the server does not revive.
      if(fd.mode==='single'){
        const _durMoved=fd.duration_minutes!==comp.duration_minutes;
        const _startMoved=!!fd.start_time&&new Date(fd.start_time).getTime()!==new Date(comp.start_time).getTime();
        if(computeCompStatus(comp)==='ended'&&fd.duration_minutes&&(_durMoved||_startMoved)){
          // The start THIS save writes (null when the start is locked, which
          // leaves the stored one), so the end judged is the one the server judges.
          const newEnd=new Date(new Date(fd.start_time||comp.start_time).getTime()+fd.duration_minutes*60000);
          if(newEnd>new Date()){
            // The outcome of extending an ENDED single-slot comp depends on WHY it
            // ended, not on ended_manually alone (the old bug). Three cases:
            //  • ended_manually=1            → manual end; extending always revives it
            //                                  (the server skips the all-solved gate for
            //                                  manual ends — routes/competitions.js, v7.7.x).
            //  • ended_at set, !manual       → all-solved auto-end (the ONLY non-manual
            //                                  writer of ended_at, server.js submit path);
            //                                  stays ended unless the solves no longer hold
            //                                  — but ONLY where the server asks that
            //                                  question at all (`_autoEndKeepsEnded`, v8.12.7);
            //                                  otherwise extending revives it.
            //  • ended_at NULL (else)        → scheduled time simply elapsed; status is
            //                                  time-derived, so a later end makes it live again.
            if(comp.ended_manually){_revives=true;revivalWarnings.push(`<strong>${esc(comp.name)}</strong> was manually ended and will become <strong>live</strong> again.`);}
            else if(comp.ended_at&&!_autoEndKeepsEnded(comp)){_revives=true;revivalWarnings.push(`<strong>${esc(comp.name)}</strong> auto-ended before its scheduled time and will become <strong>live</strong> again.`);}
            else if(comp.ended_at) revivalWarnings.push(`<strong>${esc(comp.name)}</strong> auto-ended because every participant had already finished every challenge — solved it, or run out of attempts. Saving keeps it <strong>ended</strong> — add new participants, or grant an exhausted participant more attempts, to revive it.`);
            else{_revives=true;revivalWarnings.push(`<strong>${esc(comp.name)}</strong> ended automatically when its scheduled time elapsed. Saving a later end time will make it <strong>live</strong> again.`);}
          }
        }
      }
      if(fd.mode==='multi'){
        for(const sess of fd.sessions){
          if(!sess.existingId)continue;
          const ts=(comp.timeslots||[]).find(t=>t.id===sess.existingId);
          if(!ts||computeCompStatus(ts)!=='ended')continue;
          // Same v8.1.9 rule, per session: `routes/sessions.js` revives only on a
          // moved start or duration, so an untouched row must not warn.
          const _sStartMoved=!!sess.start_time&&new Date(sess.start_time).getTime()!==new Date(ts.start_time).getTime();
          if(sess.duration_minutes===ts.duration_minutes&&!_sStartMoved)continue;
          const newEnd=new Date(new Date(sess.start_time||ts.start_time).getTime()+sess.duration_minutes*60000);
          if(newEnd>new Date()){
            // Same three-way distinction as the single-slot branch above, keyed on
            // the timeslot's ended_manually / ended_at (time-elapsed slots keep ended_at NULL).
            // The session gate reads its COMPETITION's two columns (routes/sessions.js).
            if(ts.ended_manually){_revives=true;revivalWarnings.push(`Session <strong>${esc(ts.name)}</strong> was manually ended and will become <strong>live</strong> again.`);}
            else if(ts.ended_at&&!_autoEndKeepsEnded(comp)){_revives=true;revivalWarnings.push(`Session <strong>${esc(ts.name)}</strong> auto-ended before its scheduled time and will become <strong>live</strong> again.`);}
            else if(ts.ended_at) revivalWarnings.push(`Session <strong>${esc(ts.name)}</strong> auto-ended because every participant had already finished every challenge — solved it, or run out of attempts. Saving keeps it <strong>ended</strong> — add new participants, or grant an exhausted participant more attempts, to revive it.`);
            else{_revives=true;revivalWarnings.push(`Session <strong>${esc(ts.name)}</strong> ended automatically when its scheduled time elapsed. Saving a later end time will make it <strong>live</strong> again.`);}
          }
        }
      }
    }
    if(_revives){const _certs=certificatesKeptOnReviveNote(comp);if(_certs)revivalWarnings.push(esc(_certs));}
    let confirmMsg=`Save changes to <strong>${esc(comp?.name||fd.name)}</strong>?`;
    if(revivalWarnings.length){
      confirmMsg+=`<br><br><div style="background:var(--surface2);border-left:3px solid var(--yellow);padding:10px 12px;border-radius:var(--radius-sm);margin-top:8px;text-align:left;font-size:var(--fs-14)">` +
        `<strong style="color:var(--yellow)">Revival warning:</strong><ul style="margin:6px 0 0">${revivalWarnings.map(w=>'<li>'+w+'</li>').join('')}</ul></div>`;
    }
    // ext-audit v7.21.1 (A4) — a multi→single switch DELETES the sessions, so
    // say so before it happens. Pre-fix the switch silently did nothing at all,
    // which is the other way to get this wrong.
    const _slotsToDelete=(fd.mode==='single'?S._pendingSlotDeletes.length:0);
    if(_slotsToDelete){
      confirmMsg+=`<br><br><div style="background:var(--surface2);border-left:3px solid var(--red);padding:10px 12px;border-radius:var(--radius-sm);margin-top:8px;text-align:left;font-size:var(--fs-14)">`
        +`<strong style="color:var(--red)">Switching to a single session</strong> will delete ${_slotsToDelete} existing session${_slotsToDelete===1?'':'s'}. `
        +`A session with assigned participants, submissions or hint reveals cannot be deleted — reassign those participants first.</div>`;
    }
    // Severity: danger if revival warnings, warning if editing a live competition, otherwise default
    const compIsLive=comp&&computeCompStatus(comp)==='live';
    const confirmClass=(revivalWarnings.length||_slotsToDelete)?'danger':(compIsLive?'warning':'');
    if(compIsLive&&!revivalWarnings.length){
      confirmMsg+=`<br><br><div style="background:var(--surface2);border-left:3px solid var(--yellow);padding:10px 12px;border-radius:var(--radius-sm);margin-top:8px;text-align:left;font-size:var(--fs-14)"><strong style="color:var(--yellow)">Note:</strong> this event is currently live. Changes take effect immediately.</div>`;
    }
    const ok=await showModal({title:`Update ${_saveKindLabel()}`,message:confirmMsg,confirmText:'Save',confirmClass});
    if(!ok)return;
  }else{
    // New competition — show confirmation with summary
    const tz=document.getElementById('comp-tz')?.value||Intl.DateTimeFormat().resolvedOptions().timeZone;
    let summary=`<strong>${esc(fd.name)}</strong>`;
    if(fd.mode==='single'&&fd.start_time){
      const startD=new Date(fd.start_time);
      // A deadline kind sends a DEADLINE and no duration (the server derives
      // it), so its end and length are read off the deadline; a window kind's
      // off the duration.
      const endD=fd.deadline_at?new Date(fd.deadline_at):new Date(startD.getTime()+fd.duration_minutes*60000);
      const spanMin=fd.deadline_at?Math.max(0,Math.ceil((endD.getTime()-startD.getTime())/60000)):fd.duration_minutes;
      // Browser-locale display (v6.2.6 — see _compFormUpdateEndTime).
      const fmtS=fmtDt(startD,'long',{timeZone:tz});
      const fmtE=fmtDt(endD,'long',{timeZone:tz});
      const durD=Math.floor(spanMin/1440),durH=Math.floor((spanMin%1440)/60),durM=spanMin%60;
      const durStr=[durD?durD+'d':'',durH?durH+'h':'',durM?durM+'m':''].filter(Boolean).join(' ');
      // With "No fixed deadline" ticked the deadline is named as such, the date
      // it records in brackets, and there is no ten-year "Open for" line.
      summary+=`<br><br><table style="font-size:var(--fs-14);text-align:left"><tr><td style="color:var(--muted);padding-right:12px">Start:</td><td>${esc(fmtS)} (${esc(tz)})</td></tr>`
        +`<tr><td style="color:var(--muted);padding-right:12px">${fd.deadline_at?'Deadline':'End'}:</td><td>${esc(noFixedDeadline?_noFixedDeadlineWords(endD,{timeZone:tz}):fmtE)}</td></tr>`
        +(noFixedDeadline?'':`<tr><td style="color:var(--muted);padding-right:12px">${fd.deadline_at?'Open for':'Duration'}:</td><td>${esc(durStr)}</td></tr>`)+'</table>';
    }else if(fd.mode==='multi'){
      summary+=`<br><br><strong>${fd.sessions.length} session(s):</strong><ul style="margin:6px 0 0;font-size:var(--fs-14)">`;
      for(const sess of fd.sessions){
        const sStart=sess.start_time?fmtDt(sess.start_time,'long',{timeZone:tz}):'—';
        summary+=`<li><strong>${esc(sess.name)}</strong> — ${sStart}, ${sess.duration_minutes} min</li>`;
      }
      summary+=`</ul>`;
    }
    if(tpl)summary+=`<br><br>From the template <strong>${esc(tpl.name)}</strong>${tpl.task_count?`, with its ${tpl.task_count} challenge${tpl.task_count===1?'':'s'}`:''}.`;
    // The opt-out sits in the folded Advanced section: the confirmation says
    // what it will do (ON creates an account for everyone who joins).
    if(fd.cxone_disabled!==undefined)summary+=`<br><br><span id="comp-confirm-cxone">${esc(_cxoneAccountsLine(fd.cxone_disabled))}${fd.cxone_disabled?'.':' — one is created for everyone who joins.'}</span>`;
    const _finishing=!!(_formOv&&_formOv._spawned);
    const ok=await showModal({title:_finishing?`Finish creating ${_saveKindLabel()}?`:`Create ${_saveKindLabel()}?`,message:summary,confirmText:_finishing?'Finish creating':'Create',confirmClass:''});
    if(!ok)return;
  }

  // From a template: spawn it, then apply this form to the new event as an edit.
  // A press after a refused first save FINISHES the event that press made: the
  // form is still the create (its ticks, its Checkmarx One override and its
  // messages are a create's), and a second spawn would make a second event.
  let spawned=null;
  // True when the event already holds everything this press would send (a lost
  // save that landed), so the settings are not sent again.
  let _settingsHeld=false;
  if(tpl){
    const _again=!!(_formOv&&_formOv._spawned);
    spawned=_again?_formOv._spawned:await _spawnFromTemplate(tpl,fd);
    if(!spawned)return null;
    if(_formOv)_formOv._spawned=spawned;
    id=spawned.competition.id;
    url=`/api/admin/competitions/${id}`;
    method='PUT';
    delete body.tags;   // the PUT does not manage tags; the dry-run box is synced below
    delete body.add_qualifying;   // rode the spawn; the PUT does not take it
    // The token of the event as this form knows it: the spawn's, or the one a
    // lost save of this form turned out to have written (below). A refused PUT
    // writes nothing, so it still matches unless someone else saved the event
    // meanwhile (409).
    const _tok=(_formOv&&_formOv._spawnedToken)||spawned.competition.updated_at;
    if(_tok)body.expectedUpdatedAt=_tok;
    // A start that has passed is not this press's to set: the event started at
    // the start its spawn gave it, and moving a running event's start is
    // refused to every admin but a superadmin.
    if(_again&&body.start_time&&Date.parse(body.start_time)<=Date.now())delete body.start_time;
    await loadAdminCompetitions();
    // A press after a save whose ANSWER was lost: that save may have landed, and
    // its own write moved the token it was sent with. Re-read the event: when
    // its token moved and it holds every value one of those saves sent, the
    // write was this form's, so its token is this form's to send (and when it
    // holds what this press would send, there is nothing left to send).
    // Otherwise the token stays as it was and the server's own check stands:
    // unmoved, nothing landed; moved by someone else, the save is refused as a
    // conflict, never allowed to overwrite their change.
    const _lost=_again&&_formOv&&_formOv._spawnedLost;
    if(_lost&&_lost.length){
      const _row=S.adminCompetitionsData.find(c=>c.id===id);
      if(_row&&_row.updated_at&&_lost.some(l=>_row.updated_at!==l.token&&_compRowHolds(_row,l.body))){
        _formOv._spawnedToken=_row.updated_at;
        body.expectedUpdatedAt=_row.updated_at;
        _settingsHeld=_compRowHolds(_row,body);
      }
    }
  }

  // Delete the sessions the admin removed (the Remove button, and since v7.21.1
  // the multi→single switch, only QUEUE the id — the DELETE happens here).
  //
  // ext-audit v7.21.1 (A4) — this runs BEFORE the competition PUT and for BOTH
  // modes; it used to sit after the PUT inside the multi-only branch, which is
  // both halves of the bug. Single mode never reached it, so the switch deleted
  // nothing; and even once reached, a REFUSED delete arrived after the PUT had
  // already overwritten start_time/duration_minutes with the single-session
  // values, leaving the row contradicting the sessions that survived. Deleting
  // first means a refusal aborts before anything is written, so the competition
  // is exactly as the admin left it and the server's own message names the
  // remedy. The surviving ids stay queued (v6.20.6), so retrying the Save
  // targets only the failures.
  // v8.3.20 — how many sessions this save has already DESTROYED by the time a
  // later step can fail. See the failure branch below.
  let _slotsDeleted=0;
  if(id&&S._pendingSlotDeletes.length){
    // v8.8.25 — ASK THE SERVER WHETHER THE SAVE WOULD BE ACCEPTED, BEFORE
    // DESTROYING ANYTHING.
    //
    // The deletes commit first and must (v7.21.1 A4: a multi->single switch
    // cannot pass the PUT while its sessions still exist), so a PUT refused
    // afterwards on ordinary input — a duplicate name, a kind-policy violation,
    // a schedule the arithmetic rejects — left the sessions permanently gone.
    // v8.3.20 made that failure NAME the deletion, which is honest and does not
    // undo it.
    //
    // The pre-flight declares the pending deletes, so the server evaluates its
    // slot-derived refusals against the world this save produces rather than the
    // one it is leaving. Without that declaration the dry run is wrong in both
    // directions and worse than none.
    //
    // IT NARROWS THE SEAM; IT DOES NOT CLOSE IT — three refusals are raised
    // inside the server's own transaction and cannot be pre-flighted, and the
    // concurrency and footprint checks re-read live state, so the failure branch
    // below keeps its _seam sentence verbatim.
    const pf=await fetch(`/api/admin/competitions/${id}`,{
      method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({...body,validate_only:true,delete_timeslot_ids:S._pendingSlotDeletes}),
    });
    if(!pf.ok){
      const pd=await pf.json().catch(()=>({}));
      // Nothing has been written and nothing deleted, so the queue is intact and
      // fixing the named problem and pressing Save again targets the same set.
      // v8.12.0 — a staff-compete refusal that carries a LIST (unsealed
      // challenges, enrolled staff, enrolled authors) renders as the same modal
      // the real-save branch uses: the remedy is per row, and a toast cannot
      // hold a list. This branch was the one consumer that lost it.
      if(!showStaffCompeteRefusalModal(pd)){
        showToast(pd.error||'This event could not be saved, so nothing was changed.','error');
      }
      return null;
    }
    // v7.21.19 (audit F1) — ONE transactional request, not a delete-each loop.
    //
    // The loop deleted sessions one at a time and CARRIED ON after a refusal, so
    // a queue of two where the second was protected left the first permanently
    // gone while the save reported failure: the admin was told nothing happened
    // and a session had been destroyed. The endpoint checks every id before
    // deleting any and refuses the whole set on the first problem, so a refusal
    // now destroys nothing.
    //
    // It also carries expectedUpdatedAt, which the loop could not: deleting bumps
    // competitions.updated_at, so the loop had to blindly RE-READ the token
    // afterwards — and that re-read equally swallowed another admin's edit that
    // landed in the window. The response returns the updated_at produced by this
    // transaction, which is provably our own write.
    const dr=await fetch(`/api/admin/competitions/${id}/timeslots/bulk-delete`,{
      method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({timeslotIds:S._pendingSlotDeletes,expectedUpdatedAt:body.expectedUpdatedAt||null}),
    });
    if(!dr.ok){
      const dd=await dr.json().catch(()=>({}));
      // Nothing was deleted, so the queue is untouched and a retry after fixing
      // the named session targets exactly the same set.
      showToast(dd.error||'Failed to delete the removed sessions.','error');
      await loadAdminCompetitions();
      document.getElementById('comp-form-overlay')?.remove();
      return null;
    }
    const dd=await dr.json().catch(()=>({}));
    S._pendingSlotDeletes=[];
    _slotsDeleted=dd.deleted||0;
    if(dd.updated_at){
      body.expectedUpdatedAt=dd.updated_at;
      // v8.3.20 — patch the token into the model TOO. The bulk-delete bumped
      // competitions.updated_at, and if the PUT below is then refused on
      // ordinary input the admin's retry would re-read the STALE token from
      // S.adminCompetitionsData (nothing refreshes it) and 409 with "modified by
      // another admin" — blaming a colleague for our own committed write. This
      // is the token our own transaction produced, so it is provably correct
      // and costs no extra round trip.
      const _row=S.adminCompetitionsData.find(c=>c.id===id);
      if(_row)_row.updated_at=dd.updated_at;
      // v8.14.5 — and into the form's token, which is what the retry sends.
      if(_formEl)_formEl._updatedAt=dd.updated_at;
    }
  }

  let r=null;
  if(!_settingsHeld){
    try{r=await fetch(url,{method,headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});}
    catch(e){
      // No answer: the request may or may not have reached the server, so
      // nothing here may say which. A template create keeps what it sent, so
      // its next press can tell (above).
      const why=e&&e.message?e.message:'network error';
      if(spawned&&_formOv)_formOv._spawnedLost=[...(_formOv._spawnedLost||[]),{body:{...body},token:body.expectedUpdatedAt||null}].slice(-5);
      showToast(spawned
        ?`Created “${spawned.competition.name}” from the template, but no answer came back for its settings (${why}), so they may not have been saved. Press Finish creating to finish it.`
        :`No answer came back from the server (${why}), so this may not have been saved. Check the event in the Events list before you try again.`,'error');
      if(spawned)_markSpawnedForm(spawned);
      else loadAdminCompetitions({keepPage:true});
      return null;
    }
  }
  // v8.3.20 — guarded: a proxy's HTML error page threw here, which took the
  // whole save down with an unhandled rejection and no message at all.
  const d=r?await r.json().catch(()=>({})):{};
  if(r&&!r.ok){
    //
    // v8.3.20 (external audit) — THE SEAM. The session deletes above are
    // COMMITTED by the time this runs (v7.21.1 A4 put them first deliberately,
    // so a refused DELETE cannot arrive after the PUT has overwritten the
    // schedule). So a PUT refused on ordinary input — a duplicate name, a bad
    // deadline — used to leave sessions permanently gone under a bare "Failed
    // to save.", which reads as "nothing happened". That is v7.21.19 F1's own
    // class one layer up: an operation reported as a no-op that destroyed
    // something.
    const _seam=_slotsDeleted>0
      ? ` ${_slotsDeleted} session(s) were already removed and are NOT restored by this failure.`
      : '';
    // From a template, the event EXISTS by now. Say so, and keep this form the
    // create that made it: fixing the named problem and pressing Finish creating
    // sends these settings to that event and then adds the ticked challenges
    // and the Checkmarx One override, never a second event.
    if(spawned){
      _markSpawnedForm(spawned);
      // A conflict is not this form's to fix: someone else changed the event
      // after it was made, and pressing again would only be refused again.
      if(r.status===409&&d.conflict){
        showToast(`Created “${spawned.competition.name}” from the template, but these settings were not saved: the event was changed after it was created, by another admin or in another tab. Open it from the Events list to see what it holds now; the challenges you ticked and the Checkmarx One settings were not added either.`,'error');
        loadAdminCompetitions({keepPage:true});
        return;
      }
      const _made=`“${spawned.competition.name}” was created from the template, but these settings were not saved. Fix them and press Finish creating.`;
      if(!showStaffCompeteRefusalModal(d,_made)){
        showToast(`Created “${spawned.competition.name}” from the template, but these settings were not saved: ${d.error||'the server refused them.'} Fix them and press Finish creating.${skippedSummary(spawned.skipped_challenges)}`,'error');
      }
      return;
    }
    if(r.status===409&&d.conflict){
      showToast((d.error||'This event was modified by another admin. Reload to see the latest values.')+_seam,'error');
      // v8.14.5 — refresh the list, not the open form (it keeps the admin's edits
      // and its own token), so reopening the dialog starts from the latest version.
      loadAdminCompetitions({keepPage:true});
    }else if(showStaffCompeteRefusalModal(d,_seam)){
      // v8.12.0 — a refusal that carries a LIST (the unsealed challenges, or the
      // enrolled staff) is rendered as a modal the admin can act on, not a toast.
    }else{
      showToast((d.error||'Failed to save.')+_seam,'error');
    }
    return;
  }

  const compId=id||d.competition?.id||d.id;

  // v7.8.1 — sync the "test / dry run" checkbox to the dry-run
  // competition tag on EDIT (CREATE already seeded it via body.tags). The tag
  // is the single source of truth for internal status; add/remove it to match
  // the box. Best-effort: the competition body is already saved and the final
  // loadAdminCompetitions() refresh reflects the true state, so a failure only
  // warns (e.g. a non-superadmin toggling the marker on an ended comp → 403).
  if(id&&compId){
    const wasInternal=(S.adminCompetitionsData.find(c=>c.id===compId)?.tags||[]).includes(DRY_RUN_TAG);
    if(fd.internal&&!wasInternal){
      const tr=await fetch(`/api/admin/competitions/${compId}/tags`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({tag:DRY_RUN_TAG})});
      if(!tr.ok)showToast((await tr.json().catch(()=>({}))).error||'Saved, but could not mark the event as a test / dry run.','error');
    }else if(!fd.internal&&wasInternal){
      // v7.21.18 — encodeURIComponent is REQUIRED, not decoration: the tag is a
      // PATH SEGMENT and the value contains a slash, so an unencoded
      // `/tags/test/dry run` does not match the route at all. This URL was a
      // hard-coded `/tags/internal` literal and so was invisible to the sweep
      // that replaced the quoted 'internal' strings — the tick worked and the
      // UNTICK silently did nothing.
      const tr=await fetch(`/api/admin/competitions/${compId}/tags/${encodeURIComponent(DRY_RUN_TAG)}`,{method:'DELETE',headers:csrfHeaders()});
      if(!tr.ok)showToast((await tr.json().catch(()=>({}))).error||'Saved, but could not clear the test / dry run marker.','error');
    }
  }

  // Sync timeslots if multi mode — check every response and abort on any failure
  // Track per-slot revive outcomes (the timeslot PUT returns {revived, allSolved})
  // so the post-save toast can report what ACTUALLY happened, not a guess.
  let _anyTsRevived=false,_anyTsStaysEndedAllSolved=false;
  if(fd.mode==='multi'&&compId){
    let sessionError=null;
    for(const sess of fd.sessions){
      const sessBody={name:sess.name,duration_minutes:sess.duration_minutes};
      if(sess.start_time)sessBody.start_time=sess.start_time;
      let sr;
      if(sess.existingId){
        if(sess.updatedAt)sessBody.expectedUpdatedAt=sess.updatedAt;
        sr=await fetch(`/api/admin/competitions/${compId}/timeslots/${sess.existingId}`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(sessBody)});
      }else{
        // New sessions always need start_time
        if(!sessBody.start_time)sessBody.start_time=sess.start_time||new Date().toISOString();
        sr=await fetch(`/api/admin/competitions/${compId}/timeslots`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(sessBody)});
      }
      if(!sr.ok){
        const sd=await sr.json().catch(()=>({}));
        sessionError=sd.error||(sr.status===409?'Session conflict — another admin may have changed this session. Reload and try again.':'Failed to save one or more sessions.');
        break;
      }
      if(sess.existingId){
        const sd=await sr.json().catch(()=>null);
        if(sd){
          // A TIME-EXPIRED session (ended_at NULL) flips back to live purely by time
          // arithmetic, so the timeslot PUT returns revived:false — detect the
          // ended→live transition via the returned status so the toast still reports it.
          const _preSlot=(S.adminCompetitionsData.find(c=>c.id===compId)?.timeslots||[]).find(t=>t.id===sess.existingId);
          const _wasEnded=_preSlot&&computeCompStatus(_preSlot)==='ended';
          if(sd.revived||(_wasEnded&&sd.timeslot&&sd.timeslot.status==='live'))_anyTsRevived=true;
          else if(sd.allSolved)_anyTsStaysEndedAllSolved=true;
        }
      }
    }
    if(sessionError){
      // Competition body was saved; sessions partially applied. Reload so the
      // admin sees the actual state rather than a stale form.
      showToast(sessionError,'error');
      await loadAdminCompetitions();
      document.getElementById('comp-form-overlay')?.remove();
      return null;
    }
  }

  // Save CxOne config for new competitions (for edit, the separate Save CxOne button handles it).
  //
  // ext-audit v7.21.1 — NOT superadmin-gated. Per-competition CxOne is
  // admin-level by design (v7.13.2 restored that deliberately) and the form
  // renders the key/group fields to EVERY admin — but this call was the only
  // persistence path for a NEW competition (the create POST carries no cxone
  // fields, and the Save/Remove buttons only render for an existing one). So a
  // regular admin filled the fields in, got "Competition created.", and their
  // values were silently dropped — the competition then quietly using the global
  // defaults they had meant to override. EDIT was never affected:
  // saveCompCxOne/removeCompCxOne carry no such gate.
  let cxoneFailed=null;
  if(creating&&compId){
    const cxKey=document.getElementById('comp-cxone-key')?.value?.trim();
    const cxGroup=document.getElementById('comp-cxone-group')?.value?.trim();
    if(cxKey||cxGroup){
      const cxBody={cxone_group_name:cxGroup||''};
      if(cxKey)cxBody.cxone_api_key=cxKey;
      // v6.20.x — surface CxOne save failure. Pre-fix the response was ignored,
      // so a bad key / rejection / network error left the competition created
      // WITHOUT the intended CxOne config and the operator saw only "created".
      try{
        const cxR=await fetch(`/api/admin/competitions/${compId}/cxone`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(cxBody)});
        if(!cxR.ok)cxoneFailed=(await cxR.json().catch(()=>({}))).error||`CxOne save failed (${cxR.status})`;
      }catch(e){cxoneFailed=e&&e.message?`CxOne save failed: ${e.message}`:'CxOne save failed (network error)';}
    }
  }


  document.getElementById('comp-form-overlay')?.remove();
  if(cxoneFailed)showToast(`Event created, but CxOne config was NOT saved: ${cxoneFailed}. Open the event and re-enter it under CxOne settings.`,'error');
  else{
    // Report the ACTUAL revive outcome from the server, not a pre-save guess.
    // Single-slot: the comp PUT returns {allSolved, statusChanged, oldStatus, newStatus}.
    // Multi-slot: aggregated from the per-timeslot PUT responses above.
    let _msg=creating?'Event created.':'Event updated.';
    if(spawned){
      const _sk=Array.isArray(spawned.skipped_challenges)?spawned.skipped_challenges:[];
      const _n=spawned.assigned_challenges||0;
      _msg=`Created “${spawned.competition.name}” from the template with ${_n} challenge${_n===1?'':'s'}.${skippedSummary(_sk)}`;
    }
    if(!creating){
      const _allSolved=(fd.mode==='single')?!!d.allSolved:_anyTsStaysEndedAllSolved;
      const _revived=(fd.mode==='single')?(!!d.statusChanged&&d.oldStatus==='ended'&&d.newStatus==='live'):_anyTsRevived;
      if(_revived)_msg='Event updated and reactivated — it is now live again.';
      // v8.3.11 — the predicate is solved-OR-exhausted, and the remedy list was
      // short by the one that applies to an exhausted participant: Grant Attempts
      // (Challenges tab kebab) un-finishes them, which is what lets this very
      // save revive the event on the next attempt.
      else if(_allSolved)_msg='Saved. The event stays ended — every participant had already finished every challenge (solved it, or run out of attempts). Add new participants, or grant an exhausted participant more attempts, to revive it.';
    }
    showToast(_msg);
  }
  await loadAdminCompetitions();
  renderScopeBanner();
  // A template brought its challenges and join link: the event is ready to
  // share, so it opens in its workspace.
  if(spawned&&compId)openEventWorkspace(compId,spawned.competition.name);
  // A blank create started on the New event page: back to the Events list,
  // where the new event now is.
  else if(creating&&compId&&document.getElementById('admin-templates-tab')?.offsetParent){
    document.querySelector('.admin-nav-item[data-tab-id="admin-competitions-tab"]')?.click();
  }
  return compId;
}

export async function deleteCompetition(id){
  const comp=S.adminCompetitionsData.find(c=>c.id===id);
  const ok=await showModal({title:'Delete Event',message:`Permanently delete <strong>${esc(comp?.name||'')}</strong>?<br><br>All associated submissions, assignments, and challenge links will be removed. This cannot be undone.`,confirmText:'Delete',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/competitions/${id}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){
    showToast('Event deleted.','success');
    if(S.adminSelectedCompetitionId===id)clearAdminCompetitionScope();
    loadAdminCompetitions();
  }else{const d=await r.json();showToast(d.error||'Failed.','error');}
}

export async function saveCompCxOne(compId){
  const key=document.getElementById('comp-cxone-key').value.trim();
  const group=document.getElementById('comp-cxone-group').value.trim();
  const body={cxone_group_name:group};
  if(key)body.cxone_api_key=key;
  const r=await fetch(`/api/admin/competitions/${compId}/cxone`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
  if(r.ok){showToast('CxOne config saved for event.','success');}
  else{const d=await r.json();showToast(d.error||'Failed.','error');}
}

export async function removeCompCxOne(compId){
  const ok=await showModal({title:'Remove Event CxOne',message:'Remove CxOne override for this event? It will fall back to global defaults.',confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/competitions/${compId}/cxone`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('CxOne override removed.','success');}
  else{const d=await r.json();showToast(d.error||'Failed.','error');}
}

export async function addCompTag(compId){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const compTags=(comp?.tags)||[];
  const compStatus=comp?computeCompStatus(comp):null;
  if(compStatus==='live'){
    const ok=await showModal({title:'Modify Live Event',message:`This event is <strong>currently live</strong>. Tag changes take effect immediately and will be visible to participants.`,confirmText:'Continue',confirmClass:'danger',cancelText:'Cancel'});
    if(!ok)return;
  }
  // v8.3.17 — see core/api.js fetchJsonList.
  const allTags=await fetchJsonList('/api/admin/competition-tags');
  if(allTags===null){showToast('Could not load the tag list. Try again.','error');return;}
  const available=allTags.filter(t=>!compTags.includes(t));
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay, `<div class="card" style="max-width:min(400px, calc(100vw - 32px));width:100%;border-top-color:var(--accent)">
    <h3 style="margin-bottom:16px">Add Tag</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="comp-tag-input" maxlength="50" placeholder="Enter new tag..." style="flex:1" data-enter-click-id="comp-tag-save-btn"/>
      <button class="btn sm" id="comp-tag-save-btn">Add</button>
    </div>
    ${available.length?`<div style="margin-bottom:8px;font-size:var(--fs-12);color:var(--muted)">Or choose existing:</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${available.map(t=>`<span class="tag" style="cursor:pointer" role="button" tabindex="0" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>`:''}
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn sm secondary" id="comp-tag-cancel-btn">Cancel</button></div>
  </div>`);
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  document.getElementById('comp-tag-cancel-btn').onclick=close;
  overlayDismiss(overlay,close);
  // A tag change writes the events model in place. A read of the model already
  // on its way left before the change landed and would put the old tags back:
  // the write claims the model's sequence, so `loadAdminCompetitions` drops
  // that answer (the next poll reads afresh). Both tag writers do.
  wireTagDialog({overlay,inputId:'comp-tag-input',saveBtnId:'comp-tag-save-btn',url:`/api/admin/competitions/${compId}/tags`,close,
    onSaved:(tags)=>{const c=S.adminCompetitionsData.find(x=>x.id===compId);if(c)c.tags=tags;S._compFetchSeq++;renderAdminCompetitions();}});
}

export async function removeCompTag(compId,tag){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const compStatus=comp?computeCompStatus(comp):null;
  if(compStatus==='live'){
    const ok=await showModal({title:'Modify Live Event',message:`Remove tag <strong>${esc(tag)}</strong> from a <strong>live</strong> event? This takes effect immediately.`,confirmText:'Remove',confirmClass:'danger',cancelText:'Cancel'});
    if(!ok)return;
  }
  const r=await fetch(`/api/admin/competitions/${compId}/tags/${encodeURIComponent(tag)}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){const d=await r.json();const c=S.adminCompetitionsData.find(x=>x.id===compId);if(c)c.tags=d.tags;S._compFetchSeq++;renderAdminCompetitions();}   // the sequence claim: see addCompTag
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to remove tag.','error');}
}

// ── The per-event delivery panel (v8.1.0) ───────────────────────────────────
//
// GET /api/admin/competitions/:id/delivery has existed since v7.29.0 with NO
// operator surface — swagger and one API test were its only consumers — so the
// release note's unqualified "the delivery panel ships with it" was half true:
// an organiser at a stand was still opening History dialogs one participant at a
// time, which is precisely the pre-feature state the endpoint was built to end.
//
// THE EXPLANATION IS THE LOAD-BEARING HALF, not decoration. The three numbers
// measure three different things, and two of them are useless without the
// sentence: `verified` is only interesting as a GAP from `enrolled`, and
// `email_failed` counts PEOPLE rather than messages, so an operator reading it as
// a message count over-estimates the queue in front of them. If this panel is
// ever restyled, the copy travels with the numbers.

// v7.23.5 — A FAILURE MUST NOT RENDER AS DATA. Three zeros are a perfectly
// plausible answer here ("nobody has joined yet"), so a panel that fell back to
// them on an error would tell an organiser the room is empty when the truth is
// that we do not know. There are no numbers on this branch at all.
function _deliveryFailureHtml(reason){
  return `<p style="margin:0">Could not load the delivery status for this event.</p>
    <p style="margin:8px 0 0">${reason?esc(reason)+' ':''}The numbers are not shown rather than guessed — try again in a moment.</p>`;
}

// The String() is NOT redundant and must not be "simplified" away: esc() is
// `String(str||'')`, so esc(0) is the EMPTY STRING — a genuine zero would render
// as a blank cell, which reads as a broken panel rather than as "none yet".
function _deliveryStat(value,label,tone){
  return `<div style="flex:1;min-width:0;padding:12px 6px;border:1px solid var(--border);border-radius:var(--r-s)">
      <div style="font-size:var(--fs-22);font-weight:var(--fw-semibold);line-height:1.2;color:${tone||'var(--text)'}">${esc(String(value))}</div>
      <div style="font-size:var(--fs-12);letter-spacing:.04em;text-transform:uppercase">${esc(label)}</div>
    </div>`;
}

function _deliveryPanelHtml(d){
  const gap=Math.max(0,d.enrolled-d.verified);
  return `<div style="display:flex;gap:8px;text-align:center;margin-bottom:14px">
      ${_deliveryStat(d.enrolled,'Enrolled')}
      ${_deliveryStat(d.verified,'Verified')}
      ${_deliveryStat(d.email_failed,'Email failed',d.email_failed>0?'var(--red)':null)}
    </div>
    <p style="margin:0 0 8px"><strong>Enrolled</strong> is everyone in this event — it moves the moment
      someone scans the QR. <strong>Verified</strong> is how many of those have proved an email address
      works at all, so the gap — <strong>${esc(String(gap))}</strong> right now — is the population that
      may be stuck.</p>
    <p style="margin:0"><strong>Email failed</strong> counts PEOPLE with at least one failed send, not
      messages: three bounces to one attendee is still one person to go and help. The row of every approved
      participant who has never signed in carries a <strong>Show sign-in code</strong> action that hands them a code at the desk
      with no email at all.</p>`;
}

// The event's organiser list (the Events-row menu's Organisers). Read-only:
// organisers are added and removed in the event workspace's Overview, on its
// Organisers card (and from a participant's row), both behind the route's
// requireGlobalAdmin.
export async function showCompetitionOrganisers(compId,compName){
  if(!compId)return;
  let body;
  showLoading();
  // The showCompetitionDelivery shape below, for its reasons: own the error path
  // (the dispatcher's try/catch is synchronous-only, so a rejection would escape
  // unlogged AND strand the reference-counted overlay), and let the deadline
  // cover the BODY read, not just the headers (v7.15.15).
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),20000);
  try{
    const r=await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/admins`,{signal:ctrl.signal});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      body=`<p class="muted">${esc(d.error||'Could not load the organisers for this event.')}</p>`;
    }else{
      const d=await r.json();
      const admins=Array.isArray(d.admins)?d.admins:null;
      if(!admins){
        // A 200 whose shape we do not recognise is a FAILURE, not an empty list
        // — rendering "none" would be the same lie as the error branch.
        body=`<p class="muted">Could not read the organiser list for this event.</p>`;
      }else if(!admins.length){
        body=`<p class="muted">No event admins organise this event. Administrators and superadmins can always manage it.${S.isEventAdmin?'':' Add one from the Organisers card on the Overview of this event.'}</p>`;
      }else{
        body=`<ul style="margin:0;padding-left:18px">`+admins.map(a=>{
          const who=[a.first_name,a.last_name].filter(Boolean).join(' ')||a.nickname||a.email||a.id;
          return `<li style="margin-bottom:6px"><strong>${esc(who)}</strong>`
            +(a.email?`<br><span class="sub">${esc(a.email)}</span>`:'')
            +(a.granted_at?`<br><span class="sub">added ${esc(fmtDt(a.granted_at))}${a.granted_by?` by ${esc(a.granted_by)}`:''}</span>`:'')
            +`</li>`;
        }).join('')+`</ul>`
        +`<p class="muted" style="margin-top:10px">${S.isEventAdmin?'Only an administrator can add or remove an organiser.':'To add or remove an organiser, open this event and use the Organisers card on its Overview.'}</p>`;
      }
    }
  }catch(e){
    body=`<p class="muted">${e&&e.name==='AbortError'?'The request timed out.':'Could not load the organisers for this event.'}</p>`;
  }finally{
    clearTimeout(timer);
    hideLoading();
  }
  await showModal({
    title:compName?`Organisers: ${compName}`:'Organisers',
    message:body,
    confirmText:'Close',
    confirmClass:'',
    cancelText:'',
  });
}

export async function showCompetitionDelivery(compId,compName){
  if(!compId)return;
  let body;
  showLoading();
  // Own the error path. The dispatcher's try/catch is SYNCHRONOUS-ONLY (it calls
  // fn(ev,el) without awaiting), so a rejection here would escape unlogged AND
  // leave the reference-counted loading overlay up with no way out but a reload.
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),20000);
  try{
    const r=await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/delivery`,{signal:ctrl.signal});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      body=_deliveryFailureHtml(d.error);
    }else{
      const d=await r.json();
      // A 200 whose shape we do not recognise is a FAILURE, not a zero. Reading
      // a missing key would print "undefined", and defaulting it to 0 would be
      // the same lie as the error branch above.
      body=[d?.enrolled,d?.verified,d?.email_failed].every(n=>Number.isFinite(n))
        ?_deliveryPanelHtml(d)
        :_deliveryFailureHtml(null);
    }
  }catch(e){
    body=_deliveryFailureHtml(e&&e.name==='AbortError'?'The request timed out.':null);
  }finally{
    // After the body read, never at the headers — a deadline cleared when
    // fetch() resolves leaves the body unbounded (v7.15.15).
    clearTimeout(timer);
    // Released BEFORE the modal, which is awaited for as long as it is open.
    hideLoading();
  }
  await showModal({
    // Ternary rather than a trimmed template: `.trim()` would leave a dangling
    // colon with nothing after it, which reads as a half-rendered title.
    title:compName?`Email delivery: ${compName}`:'Email delivery',
    message:body,
    confirmText:'Close',
    confirmClass:'',
    cancelText:'',
  });
}
