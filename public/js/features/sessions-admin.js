"use strict";

import { S } from "../core/state.js";
import { csrfHeaders } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { wallClockToUtc, wallClockToUtcChecked, dstGapMessage, utcToWallClock} from "../data/country-tz.js";
import { loadAdminTasks } from "./challenges-admin.js";
import { computeCompStatus } from "./competition-picker.js";
import { loadAdminCompetitions, openCompetitionForm, renderScopeBanner } from "./competitions-admin.js";
import { loadAdminParticipants } from "./participants-admin.js";
import { loadAdminRankingsTab } from "./rankings-admin.js";
import { loadAdminSubmissions } from "./submissions-admin.js";
import { esc, fmtDt } from "../ui/format.js";
import { _countdownConfirm, overlayDismiss, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";

export function _sessionGetRow(el){return el.closest('.session-form-row');}

export function _sessionGetDurMinutes(row){
  const d=parseInt(row.querySelector('.ts-dur-d')?.value)||0;
  const h=parseInt(row.querySelector('.ts-dur-h')?.value)||0;
  const m=parseInt(row.querySelector('.ts-dur-m')?.value)||0;
  return d*1440+h*60+m;
}

export function _sessionSetDur(row,totalMin){
  row.querySelector('.ts-dur-d').value=Math.floor(totalMin/1440);
  row.querySelector('.ts-dur-h').value=Math.floor((totalMin%1440)/60);
  row.querySelector('.ts-dur-m').value=totalMin%60;
}

export function sessionFormDurChanged(el){sessionFormUpdateEnd(el);}

export function _sessionGetStartUtc(row){
  const dateVal=row.querySelector('.ts-date')?.value;
  const timeVal=row.querySelector('.ts-time')?.value;
  if(!dateVal||!timeVal)return null;
  const tz=row.querySelector('.ts-tz')?.value||Intl.DateTimeFormat().resolvedOptions().timeZone;
  // ext-audit v7.21.1 (A3) — was a one-pass conversion that sampled the zone's
  // offset at the naive instant, so a session starting within |offset| hours of
  // a DST transition was stored an hour out. Shared two-pass helper now — see
  // wallClockToUtc in data/country-tz.js for the failure it is named after.
  //
  // v7.21.19 (audit F2) — a wall clock inside a spring-forward GAP never
  // happened, and converting it silently yields an adjacent instant, so the
  // session would save and then render an hour away from what was typed. The
  // caller reads `_dstError` and refuses. Same treatment as the competition
  // form; sessions need it independently because they carry their own timezone
  // per row, so one competition can have a session in a zone that is mid-
  // transition while the others are not.
  const chk=wallClockToUtcChecked(dateVal,timeVal,tz);
  _sessionGetStartUtc._dstError=chk.exists?null:dstGapMessage(timeVal,tz);
  return chk.date;
}

export function sessionFormUpdateEnd(el){
  const row=_sessionGetRow(el);if(!row)return;
  const start=_sessionGetStartUtc(row);
  const dur=_sessionGetDurMinutes(row);
  const preview=row.querySelector('.ts-end-preview');
  if(!start||!dur){if(preview)preview.textContent='';return;}
  const end=new Date(start.getTime()+dur*60000);
  const tz=row.querySelector('.ts-tz')?.value||Intl.DateTimeFormat().resolvedOptions().timeZone;
  // v7.15.31 — the timezone box is a free-text `<input list=…>` (_buildTzInput),
  // so a typo or a half-typed zone reaches here on every change event. BOTH
  // Intl uses below throw on one, and only the second was guarded — so the
  // first (fmtDt) threw straight out of the change handler and left the
  // preview showing a STALE end time still labelled with the previous zone.
  // The catch's own comment ("likely invalid timezone") shows this was the
  // intent all along; the guard was just in the wrong place. Clear rather than
  // mislead: the save path refuses an invalid zone with a named error, so the
  // admin is told what is wrong there.
  try{
    // Browser-locale display (v6.2.6 — see _compFormUpdateEndTime).
    const fmtEnd=fmtDt(end,'long',{timeZone:tz});
    if(preview)setSafeHtml(preview, `Ends: <strong>${esc(fmtEnd)}</strong> (${esc(tz)})`);
    // Update end date/time fields in the session's timezone, via the inverse of
    // the conversion they are read back with (v8.6.3 — one definition, three
    // former copies).
    const wc=utcToWallClock(end,tz);
    if(!wc)throw new Error('unusable timezone');
    row.querySelector('.ts-end-date').value=wc.date;
    row.querySelector('.ts-end-time').value=wc.time;
  }catch(e){
    if(preview)preview.textContent='';
    console.warn('[sessionForm] end-time format failed (likely invalid timezone):',e&&e.message||e);
  }
}

export function sessionFormEndChanged(el){
  const row=_sessionGetRow(el);if(!row)return;
  const start=_sessionGetStartUtc(row);
  const endDate=row.querySelector('.ts-end-date')?.value;
  const endTime=row.querySelector('.ts-end-time')?.value;
  if(!start||!endDate||!endTime)return;
  const tz=row.querySelector('.ts-tz')?.value||Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Same conversion as the start field (A3) — a duration typed as an end time
  // across a DST boundary must come out the same length as one typed in d/h/m.
  const endUtc=wallClockToUtc(endDate,endTime,tz);
  if(!endUtc)return;
  const diffMs=endUtc.getTime()-start.getTime();
  if(diffMs<=0){showToast('End time must be after start time.');return;}
  _sessionSetDur(row,Math.round(diffMs/60000));
  sessionFormUpdateEnd(el);
}

// After a session change: inside the event's workspace, repaint it in place
// (status strip, header, Overview); from the event FORM, reopen the form so its
// session list shows the change.
function _afterSessionChange(compId){
  if(S.adminSelectedCompetitionId===compId){
    renderScopeBanner();
    document.dispatchEvent(new CustomEvent('admin:model-loaded',{detail:'competitions'}));
  }else openCompetitionForm(compId);
}

export async function addTimeslotForm(compId){
  const overlay=document.createElement('div');
  overlay.id='ts-form-overlay';
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3100;display:flex;align-items:center;justify-content:center;padding:24px';
  const n=new Date();const pad=x=>String(x).padStart(2,'0');
  setSafeHtml(overlay, `<div class="card" role="dialog" aria-modal="true" aria-labelledby="ts-form-title" style="max-width:min(400px, calc(100vw - 32px));width:100%;max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);overflow-y:auto">
    <h3 id="ts-form-title" style="margin-bottom:16px">Add Session</h3>
    <div class="form-group"><label for="ts-name">Session Name <span class="req">*</span></label><input aria-required="true" id="ts-name" maxlength="120" placeholder="e.g. Morning Session, APAC Session"/></div>
    <div class="form-row">
      <div class="form-group"><label for="ts-date">Date <span class="req">*</span></label><input aria-required="true" type="date" id="ts-date" value="${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}"/></div>
      <div class="form-group"><label for="ts-time">Time <span class="req">*</span></label><input aria-required="true" type="time" id="ts-time" value="${pad(n.getHours())}:${pad(n.getMinutes())}"/></div>
    </div>
    <div class="form-group"><label for="ts-duration">Duration (minutes) <span class="req">*</span></label><input aria-required="true" type="number" id="ts-duration" value="180" min="1" max="525600" style="max-width:160px"/></div>
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="ts-form-overlay">Cancel</button>
      <button class="btn" data-action="ts-save" data-comp-id="${esc(compId)}">Add</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // v6.20.x — route through the modal dismissal contract (Escape + focus-trap).
  overlayDismiss(overlay,()=>document.getElementById('ts-form-overlay')?.remove());
}

export async function saveTimeslot(compId,editTsId){
  const name=document.getElementById('ts-name').value.trim();
  const dateVal=document.getElementById('ts-date').value;
  const timeVal=document.getElementById('ts-time').value;
  const duration=parseInt(document.getElementById('ts-duration').value);
  if(!name||!dateVal||!timeVal||!duration){showToast('Please fill all fields.');return;}
  const start_time=new Date(`${dateVal}T${timeVal}`).toISOString();
  const url=editTsId?`/api/admin/competitions/${compId}/timeslots/${editTsId}`:`/api/admin/competitions/${compId}/timeslots`;
  const method=editTsId?'PUT':'POST';
  const r=await fetch(url,{method,headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({name,start_time,duration_minutes:duration})});
  if(r.ok){
    document.getElementById('ts-form-overlay')?.remove();
    showToast(editTsId?'Session updated.':'Session added.');
    await loadAdminCompetitions();
    _afterSessionChange(compId);
  }else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed.','error');}
}

export async function editTimeslot(compId,tsId){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const ts=(comp?.timeslots||[]).find(t=>t.id===tsId);
  if(!ts)return;
  const overlay=document.createElement('div');
  overlay.id='ts-form-overlay';
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3100;display:flex;align-items:center;justify-content:center;padding:24px';
  const s=new Date(ts.start_time);const pad=x=>String(x).padStart(2,'0');
  setSafeHtml(overlay, `<div class="card" role="dialog" aria-modal="true" aria-labelledby="ts-form-title" style="max-width:min(400px, calc(100vw - 32px));width:100%;max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);overflow-y:auto">
    <h3 id="ts-form-title" style="margin-bottom:16px">Edit Session</h3>
    <div class="form-group"><label for="ts-name">Session Name <span class="req">*</span></label><input aria-required="true" id="ts-name" maxlength="120" value="${esc(ts.name)}"/></div>
    <div class="form-row">
      <div class="form-group"><label for="ts-date">Date <span class="req">*</span></label><input aria-required="true" type="date" id="ts-date" value="${s.getFullYear()}-${pad(s.getMonth()+1)}-${pad(s.getDate())}"/></div>
      <div class="form-group"><label for="ts-time">Time <span class="req">*</span></label><input aria-required="true" type="time" id="ts-time" value="${pad(s.getHours())}:${pad(s.getMinutes())}"/></div>
    </div>
    <div class="form-group"><label for="ts-duration">Duration (minutes) <span class="req">*</span></label><input aria-required="true" type="number" id="ts-duration" value="${ts.duration_minutes}" min="1" max="525600" style="max-width:160px"/></div>
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="ts-form-overlay">Cancel</button>
      <button class="btn" data-action="ts-save" data-comp-id="${esc(compId)}" data-ts-id="${esc(tsId)}">Update</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // v6.20.x — modal dismissal contract (Escape + focus-trap), as above.
  overlayDismiss(overlay,()=>document.getElementById('ts-form-overlay')?.remove());
}

export async function deleteTimeslot(compId,tsId){
  const ok=await showModal({title:'Delete Session',message:'Delete this session? This cannot be undone.',confirmText:'Delete',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/competitions/${compId}/timeslots/${tsId}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('Session deleted.','success');await loadAdminCompetitions();_afterSessionChange(compId);}
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed.','error');}
}

export async function endTimeslotNow(compId,tsId){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const ts=(comp?.timeslots||[]).find(t=>t.id===tsId);
  if(!ts)return;
  const compName=comp?comp.name:'';
  const tsStatus=computeCompStatus(ts);
  const isPending=tsStatus==='upcoming';
  const statusLine=tsStatus==='live'?`Started: ${fmtDt(ts.start_time,'long')}`:'Not started yet';
  const warning=isPending
    ?'This session has not started yet. It will be cancelled without ever going live (start time set to now, duration set to 0).'
    :'Participants in this session will no longer be able to submit answers.';

  const ok=await showModal({
    title:isPending?'Cancel Session':'End Session Now',
    message:`Are you sure you want to ${isPending?'cancel':'end'} this session?<br><br>` +
      `<strong>Event:</strong> ${esc(compName)}<br>` +
      `<strong>Session:</strong> ${esc(ts.name)}<br>` +
      `<strong>Status:</strong> ${statusLine}<br><br>` +
      warning,
    confirmText:isPending?'Cancel Session':'End Now',confirmClass:'danger',cancelText:'Back'
  });
  if(!ok)return;

  const proceed=await _countdownConfirm(`${compName} → ${ts.name}`,'session');
  if(!proceed)return;

  const r=await fetch(`/api/admin/competitions/${compId}/timeslots/${tsId}/end-now`,{method:'POST',headers:csrfHeaders()});
  if(r.ok){
    showToast(`Session "${ts.name}" ended.`);
    await loadAdminCompetitions();
    renderScopeBanner();
    loadAdminTasks();loadAdminParticipants();loadAdminSubmissions();loadAdminRankingsTab();
  }else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed.','error');}
}
