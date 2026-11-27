"use strict";

import { downloadBlob } from "../ui/download.js";
import { S } from "../core/state.js";
import { csrfHeaders } from "../core/api.js";
import { html, setSafeHtml } from "../core/trusted-types.js";
import { loadAdminTasks } from "./challenges-admin.js";
import { loadAdminParticipants, participantsInView, participantsNarrowing, pStatus } from "./participants-admin.js";
import { esc } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { hideLoading, showLoading } from "../ui/loading.js";
import { overlayDismiss } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { paginationHtml, countHtml, setListCount } from "../ui/list-controls.js";
import { downloadCsv } from "../ui/csv.js";

// v7.21.2 — the participant import silently DROPS two things and returns a count
// for each, but the toasts rendered only imported/overwritten/skipped, so the
// operator never learned. `invalid_timezones_dropped` (v7.21.1 A7) is the sharp
// one: CLAUDE.md claimed it was "REPORTED" while no client read it, and those
// participants are blanked and pushed into the profile-completion gate on next
// sign-in. `group_clashes_dropped` (v7.11.3) is the same class. The challenge
// import's own skips (`images_dropped`, the qualifying-question rules) are read
// here too.
export function _importDropNote(d){
  const bits=[];
  if(d.invalid_timezones_dropped)bits.push(`${d.invalid_timezones_dropped} had an unusable timezone cleared (they'll be asked to set it on next sign-in)`);
  if(d.group_clashes_dropped)bits.push(`${d.group_clashes_dropped} group association${d.group_clashes_dropped===1?'':'s'} skipped to keep one group per event`);
  // v8.12.0 — a group bound to an event the importer competes in live-syncs a
  // row into it, so the association is skipped like the direct enrolment is.
  if(d.group_actor_competes_dropped)bits.push(`${d.group_actor_competes_dropped} group association${d.group_actor_competes_dropped===1?'':'s'} skipped because the group is bound to an event you compete in`);
  // v8.3.39 — an unrecognised `role` is ignored rather than stored. Silence here
  // would be the v7.21.2 defect on the one field that decides who is an admin:
  // a new row lands as a participant and an existing one keeps the role it had,
  // and either way the operator has to be told their file said otherwise.
  if(d.invalid_roles_dropped)bits.push(`${d.invalid_roles_dropped} unrecognised role${d.invalid_roles_dropped===1?' was':'s were'} ignored (new accounts import as participants; existing accounts keep their current role)`);
  // v8.3.17 — the CHALLENGE import now clamps over-long fields to the same caps
  // the edit form enforces, and a silent clamp is the v7.21.2 defect.
  if(d.fields_truncated)bits.push(`${d.fields_truncated} over-long field${d.fields_truncated===1?' was':'s were'} shortened to the platform's limit`);
  // v8.10.0 — a SEALED row is refused outright, and this is the v7.21.2 defect on
  // the one counter whose absence an operator cannot diagnose from any screen:
  // sealed rows are deliberately NOT folded into `skipped`, so without this they
  // vanish from the file with every number on screen unchanged. The note names
  // the remedy, because "it did not import" with no reason is what sends somebody
  // hunting through a 500-row file.
  if(d.sealed_type_skipped)bits.push(`${d.sealed_type_skipped} challenge${d.sealed_type_skipped===1?' with a sealed answer was':'s with sealed answers were'} not overwritten — the file would make ${d.sealed_type_skipped===1?'it':'them'} an Any answer challenge, which has no answer to seal`);
  if(d.sealed_skipped)bits.push(`${d.sealed_skipped} challenge${d.sealed_skipped===1?' with a sealed answer was':'s with sealed answers were'} refused — a sealed answer belongs to the account that created it, which this platform has no record of, so create ${d.sealed_skipped===1?'it':'them'} here instead`);
  // v8.3.20 — an embedded image over the per-image byte cap is STRIPPED, and the
  // row still imports. Same rule as the clamp above it: the operator has to be
  // told the content is not all there, or the drop is the v7.21.2 defect.
  if(d.images_dropped)bits.push(`${d.images_dropped} embedded image${d.images_dropped===1?' was':'s were'} too large and removed from the text`);
  // v8.12.0 — the CHALLENGE import skips an overwrite of a challenge held by an
  // event the importer competes in (the competitor lock's import door).
  if(d.competitor_skipped)bits.push(`${d.competitor_skipped} challenge${d.competitor_skipped===1?' was':'s were'} not overwritten because you compete in an event that holds ${d.competitor_skipped===1?'it':'them'}`);
  // Operator rulings N7 and 84 (14 Nov 2026) — and an overwrite the qualifying-
  // question rules refuse: an event asks each one once, and an answered one's
  // options keep their places. Each names what to change in the file.
  {const n=d.qualifying_key_held_skipped;if(n)bits.push(`${n} challenge${n===1?' was':'s were'} not overwritten because the file would make ${n===1?'it a qualifying question':'them qualifying questions'} on a topic an event holding ${n===1?'it':'them'} already asks (an event asks each one once)`);}
  {const n=d.qualifying_not_pick_one_skipped;if(n)bits.push(`${n} challenge${n===1?' was':'s were'} not imported because ${n===1?'it is a qualifying question that is':'they are qualifying questions that are'} not a pick-one question (Any answer, with two or more options), which every qualifying question must be`);}
  // Sweep #413 — an overwrite that could mean one of several events' own copies
  // of a qualifying question, and a row adding a malformed qualifying tag.
  {const n=d.qualifying_copy_skipped;if(n)bits.push(`${n} challenge${n===1?' was':'s were'} not overwritten because ${n===1?'its row':'their rows'} could mean more than one challenge: several share the title (each event's own copy of a qualifying question) or several rows of the file overwrite it (edit the question in its event, or choose Add New)`);}
  {const n=d.qualifying_tag_invalid_skipped;if(n)bits.push(`${n} challenge${n===1?' was':'s were'} not imported because ${n===1?'its':'their'} qualifying tag is not qualifying:<key> (the key being 1–40 lowercase letters, digits, - or _)`);}
  {const n=d.qualifying_options_fixed_skipped;if(n)bits.push(`${n} qualifying question${n===1?' was':'s were'} not overwritten because people have answered ${n===1?'it':'them'} and the file moves or removes options (reword an option where it stands, or add one at the end)`);}
  // v8.14.4 — and the PARTICIPANT import skips an overwrite of an account the
  // importer competes alongside: the overwrite would block, verify, approve,
  // re-role or re-tag a rival, the account doors the participants screen refuses.
  if(d.rival_skipped)bits.push(`${d.rival_skipped} participant${d.rival_skipped===1?' was':'s were'} not overwritten because you compete alongside them in an event`);
  // …and, for an importer who is not a superadmin, a row that would overwrite an
  // account only a superadmin manages, or give a role beyond the importer's own.
  // …and a row whose names or other single-line profile text hold a control
  // character (a line break, a tab, an escape), which no door stores.
  // …and an avatar given as a link to a picture this platform does not hold
  // (only a hand-edited file carries one: the export inlines every picture).
  {const n=d.avatar_links_dropped;if(n)bits.push(`${n} avatar${n===1?' was':'s were'} not imported because ${n===1?'it links':'they link'} to a picture this platform does not hold, or to another account's (an existing account keeps its current avatar; a new one gets the default)`);}
  {const n=d.control_chars_skipped;if(n)bits.push(`${n} row${n===1?' was':'s were'} not imported because ${n===1?'its':'their'} names or other profile text hold control characters (line breaks, tabs or other invisible codes)`);}
  if(d.privileged_skipped)bits.push(`${d.privileged_skipped} row${d.privileged_skipped===1?' was':'s were'} not imported because only a superadmin may apply ${d.privileged_skipped===1?'it':'them'} (an administrator's account, or a role that can do more than yours)`);
  // v8.12.0 — the PARTICIPANT import's membership ledger has carried a reason per
  // skipped enrolment since v6.16.9 and nothing rendered it (the v7.21.2 class);
  // the staff-compete rule added three reasons, so the ledger is counted by
  // reason here. An unknown reason still counts, so a reason added later cannot
  // vanish from the screen.
  const _sm=Array.isArray(d.skipped_memberships)?d.skipped_memberships:[];
  if(_sm.length){
    const by={};for(const r of _sm)by[r.reason||'other']=(by[r.reason||'other']||0)+1;
    const label={competition_not_found:'named an event that does not exist here',staff_not_competing:'were staff enrolments into an event where staff do not compete',author_competes:'would have put a challenge author into an event where staff compete',actor_competes:'were into an event you compete in'};
    bits.push(`${_sm.length} event enrolment${_sm.length===1?' was':'s were'} skipped (${Object.entries(by).map(([k,n])=>`${n} ${label[k]||k}`).join(', ')})`);
  }
  // v8.12.0 — the ABSENCE ledger is the memberships ledger's sibling (v6.16.9)
  // and was rendered by nothing either. A closed absence is subtracted from the
  // solve clock, so a skipped one changes a placing; the staff-compete rule
  // added `actor_competes` to it, which is what an importer most needs to hear.
  const _sa=Array.isArray(d.skipped_absences)?d.skipped_absences:[];
  if(_sa.length){
    const by={};for(const r of _sa)by[r.reason||'other']=(by[r.reason||'other']||0)+1;
    const label={competition_not_found:'named an event that does not exist here',timeslot_not_found:'named a session that does not exist here',actor_competes:'were into an event you compete in'};
    bits.push(`${_sa.length} absence record${_sa.length===1?' was':'s were'} skipped (${Object.entries(by).map(([k,n])=>`${n} ${label[k]||k}`).join(', ')})`);
  }
  return bits.length?` ${bits.join('; ')}.`:'';
}

/**
 * v8.3.17 (external audit) — A PARTIALLY-COMMITTED IMPORT IS NOT A FAILED
 * IMPORT, AND THE OPERATOR HAS TO BE TOLD WHICH ONE HAPPENED.
 *
 * The PARTICIPANT import commits in 100-row chunks (v6.16.4 — one transaction
 * over a real-size file held the SQLite write lock for seconds; see the chunk
 * loop in server.js for what the chunking does and does not buy), so a failure in chunk K leaves
 * chunks 0..K-1 PERSISTED. The server goes to real trouble to make that
 * truthful: v6.16.12 snapshots and rolls back the JS counters on a mid-chunk
 * error precisely so `partial:` cannot overstate what landed.
 *
 * And BOTH client paths threw it away — `showToast(d.error||'Import failed.')`
 * and return — so the operator was told a flat "failed" for an import that had
 * written hundreds of rows, and the table on screen still showed the old state.
 * That is the class CLAUDE.md *Surfaces a human actually meets* names exactly:
 * a counter with no human consumer is itself the defect.
 *
 * The reload is not cosmetic. Rows really are in the database, so leaving the
 * table stale is the difference between an operator who re-runs the corrected
 * file (which is idempotent — already-imported rows come back as conflicts) and
 * one who believes nothing happened.
 */
export function _reportImportFailure(d,type){
  const p=d&&d.partial;
  const landed=p?(p.imported||0)+(p.overwritten||0):0;
  if(!p||!landed){showToast((d&&d.error)||'Import failed.','error');return;}
  showToast(
    `Import STOPPED partway: ${d.error||'failed'} — ${p.imported} imported, ${p.overwritten} overwritten, `+
    `${p.skipped} skipped BEFORE it stopped, and those rows are SAVED.${_importDropNote(p)} Fix the file and re-run; `+
    `rows that already landed will come back as conflicts.`,
    'error');
  if(type==='tasks')loadAdminTasks();else loadAdminParticipants();
}

// v8.9.0 — the free-text column header. Numbered inside the focused event when
// the server has assigned a number (an UPCOMING event has none yet: numbers are
// assigned lazily and the endpoint deliberately has no not-started gate).
function _freeTextHeader(ch){
  const num=ch&&ch.task_number?`${ch.task_number} `:'';
  return `Response: ${num}${(ch&&ch.title)||''}`;
}

// v8.9.0 — ASYNC, because the focused view appends one column per any-answer
// challenge from a server read. THE UNFOCUSED PATH MUST STAY SYNCHRONOUS UP TO
// THE DOWNLOAD: three callers stub URL.createObjectURL around a bare
// `window.exportParticipantsCSV()` and restore it synchronously, so any `await`
// ahead of downloadCsv() on that path would make the download land after the
// stub is gone. The `await` sits inside the focused branch only.
export async function exportParticipantsCSV(){
  // THE FILE IS WHAT THE TABLE LISTS (operator ruling, 14 Nov 2026): the rows
  // the People table shows across all its pages, in its order, after the status
  // chips, the search box and the heading filters (and, in an event, its people
  // unless "Search everyone on the platform" is ticked). participantsInView is
  // the table's own pipeline, so the two cannot drift; the Columns chooser only
  // changes what the table draws, never the file's columns.
  const data=participantsInView();
  // An empty result is said, not saved as a file of headings that reads as an
  // answer (the rankings and analytics exports' rule), and for the reason the
  // table's own empty row gives (participantsNarrowing).
  if(!data.length){
    const why=participantsNarrowing();
    showToast(why==='filters'?'Nothing to export — nobody on the list matches the current search and filters.'
      :why==='event'?'Nothing to export — nobody is in this event yet.'
      :'Nothing to export — the list is empty.','error');
    return;
  }
  const _focusedId=S.adminSelectedCompetitionId;
  // v6.15.0 — audit columns added: Approved By, Invited By, Role,
  // Locked Until, Denied Date, Denied By, Denial Reason, Competitions.
  // Maintains the order: identity → profile → lifecycle → activity →
  // tags → memberships. The schema-drift test asserts every
  // user-row column is either in this list or in EXCLUDED.
  // v6.20.x — CSV must export ALL participant-facing user fields, including the
  // ones added after the original column set: Job Function + City (both REQUIRED
  // profile fields, v6.19.x), Avatar, and Groups (live-synced collections). The
  // JSON export already carries these; the CSV had drifted. Order: identity →
  // profile → membership classification → lifecycle → activity → memberships.
  //
  // v7.15.8 — two fixes from the user-field audit. (1) Salutation
  // (personal_title) and Phone were collected by BOTH profile dialogs and
  // carried by the JSON export + import, but the CSV dropped them: the only
  // surface where a profile field silently vanished. (2) Headers use the UI's
  // OWN labels — 'Job Function' (the dialogs' "Job function"; the full event
  // and person exports say the same) and 'Work Title' — because an operator
  // searching a CSV for the label they filled in on screen concluded the field
  // was not exported at all. Header text is the contract with the human reading
  // the file; keep it matching what the dialogs say, not what the DB calls it.
  const headers=[
    'Salutation','First Name','Last Name','Nickname','Email','Secondary Email',
    'Company','Work Title','Job Function','City','Phone','Country','Timezone','Source','LinkedIn URL','Avatar',
    // v8.1.0 (PR 24) — headers use the DIALOG's own labels (v7.15.8): the header
    // is the contract with the human reading the file, not with the schema.
    'Certificate Given Name','Certificate Family Name',
    'Role','Status','Tags','Groups',
    'Registered','Approved','Approved By','Invited','Invited By',
    'Locked Until','Denied Date','Denied By','Denial Reason',
    'First Login','Last Login','Events',
  ];
  const compsCell=(p)=>(p.competitions||[])
    .map(c=>c.timeslot_name?`${c.name||c.competition_name} → ${c.timeslot_name}`:(c.name||c.competition_name||''))
    .filter(Boolean).join('; ');
  const groupsCell=(p)=>(p.groups||[]).map(g=>g.name||'').filter(Boolean).join('; ');
  const rows=data.map(p=>[
    p.personal_title||'',p.first_name||'',p.last_name||'',p.nickname,p.email,p.secondary_email||'',
    p.company||'',p.title||'',p.job_function||'',p.city||'',p.phone||'',p.country||'',p.timezone||'',p.registered_via||'manual',p.linkedin_url||'',p.avatar||'',
    p.certificate_given_name||'',p.certificate_family_name||'',
    p.role||'participant',pStatus(p),(p.tags||[]).join('; '),groupsCell(p),
    p.created_at||'',p.approved_at||'',p.approved_by||'',p.invited_at||'',p.invited_by||'',
    p.locked_until||'',p.denied_at||'',p.denied_by||'',p.denied_reason||'',
    p.login_time||'',p.last_login_time||'',compsCell(p),
  ]);
  // v7.24.0 — the quoting moved to ui/csv.js, which the analytics export also
  // uses. This file's BYTES are deliberately unchanged: formula neutralisation
  // is turned OFF here EXPLICITLY (the helper's default is ON), because turning
  // it on would rewrite every phone number beginning `+` as `'+972…` in a
  // download operators may already parse downstream — the operator's call, not
  // a rider on a new feature. The new analytics export takes the default.
  //
  // One difference exists and is not reachable from here: the old inline
  // expression was `String(v)` unconditionally, so a null cell would have
  // written the literal `null`, where csvCell writes an empty cell. Every field
  // above carries a `|| ''` fallback except `nickname`, `email` and `pStatus()`,
  // which are non-null by schema and by construction — so no cell changes. It is
  // recorded rather than glossed because "byte-identical" is a claim, and the
  // honest version of it is "byte-identical for every value this call can
  // produce".
  // v8.3.17 (external audit) — NEUTRALISE EVERY COLUMN EXCEPT THE ONE THAT WAS
  // THE REASON NOT TO.
  //
  // This was `{neutralise:false}`, i.e. OFF for the whole table, and the reason
  // recorded at v7.24.0 was a real one: turning it on would rewrite every phone
  // number beginning `+` as `'+972…` in a download operators may already parse
  // downstream. But that argument only ever applied to ONE column, and switching
  // the whole file off to protect it left every participant-controlled free-text
  // cell — nickname, company, work title, city, the certificate names, tags,
  // group names, denial reason, competition names — able to open in
  // Excel/LibreOffice as a live formula. Quoting does not help: the quotes are
  // the field delimiter, so the reader strips them and THEN type-infers, which is
  // exactly why lib/csv.js neutralises server-side.
  //
  // So the operator's concern is preserved EXACTLY — `Phone` is byte-identical to
  // what shipped — and nothing else is. Note the trigger set includes `-`, so a
  // negative number in a future column would need adding here too; today there
  // is none.
  //
  // v8.9.0 — with an event FOCUSED, one column per any-answer challenge in that
  // event, holding each participant's latest accepted response (verbatim; the
  // default neutralisation still applies, so a response beginning `=` is
  // apostrophe-prefixed like every other free-text cell). A failed read ABORTS
  // the export with a toast rather than silently shipping a file without the
  // columns — a file that looks complete and is not is the worse outcome. With
  // no such challenge the file is byte-identical to today's.
  if(_focusedId){
    let ft=null;
    try{
      const r=await fetch(`/api/admin/competitions/${encodeURIComponent(_focusedId)}/free-text-responses`);
      if(r.ok)ft=await r.json();
    }catch(_){ft=null;}
    if(!ft||!Array.isArray(ft.challenges)||!Array.isArray(ft.responses)){
      showToast('Could not load the free-text responses for this event — export cancelled. Try again.','error');
      return;
    }
    if(ft.challenges.length){
      const byKey=new Map(ft.responses.map(x=>[`${x.user_id} ${x.task_id}`,x.answer==null?'':String(x.answer)]));
      for(const ch of ft.challenges)headers.push(_freeTextHeader(ch));
      data.forEach((p,i)=>{for(const ch of ft.challenges)rows[i].push(byKey.get(`${p.id} ${ch.id}`)||'');});
    }
  }
  downloadCsv('participants.csv', headers, rows, { exemptColumns: ['Phone'] });
}

// v7.23.0 — per-competition challenge activity CSV (the Competitions row kebab).
// Unlike every other export here, the SERVER renders the bytes: the cross
// product of enrolled participants x assigned challenges cannot be built from
// any admin payload the SPA holds. So this function only fetches and saves.
function _activityFilename(cd,compName){
  // Prefer the filename the SERVER chose — it owns the slug rule
  // (_slugForDownload) and the date stamp, and re-deriving them here would be a
  // second definition that drifts. The client-side fallback exists only for a
  // proxy that strips Content-Disposition.
  const m=/filename="([^"]+)"/.exec(cd||'');
  if(m)return m[1];
  const slug=String(compName||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
  return `${slug||'event'}-activity.csv`;
}

export async function exportCompetitionActivityCsv(compId,compName){
  if(!compId)return;
  showLoading();
  // The dispatcher's try/catch is SYNCHRONOUS-ONLY (it calls fn(ev,el) without
  // await), so an async handler owns its own error path — otherwise a rejection
  // escapes unlogged AND the reference-counted loading overlay is never
  // released, stranding a full-screen spinner with no way out but a reload.
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),60000);
  try{
    const r=await fetch(`/api/admin/export/competition-activity?competitionId=${encodeURIComponent(compId)}`,{signal:ctrl.signal});
    if(!r.ok){
      // SAY WHY (v7.21.20). The refusals are JSON and carry an actionable
      // message — "this competition has not started yet" is a different
      // problem from "you are not an admin", and a bare "Export failed."
      // is indistinguishable from a broken feature.
      const d=await r.json().catch(()=>({}));
      showToast(d.error||'Could not export challenge activity.','error');
      return;
    }
    // v8.8.15 — one revoke strategy for every generated download; the reasoning,
    // including why `pagehide` ALONE was not kept, is in ui/download.js.
    downloadBlob(await r.blob(),_activityFilename(r.headers.get('content-disposition'),compName));
    showToast('Challenge activity exported.','success');
  }catch(e){
    showToast(e&&e.name==='AbortError'?'The export timed out. Try again.':'Could not export challenge activity.','error');
  }finally{
    // After the body read, never at the headers — a deadline cleared when
    // fetch() resolves leaves the body unbounded (v7.15.15).
    clearTimeout(timer);
    hideLoading();
  }
}

// The whole event in one file: GET /api/admin/competitions/:id/export/full
// (a ZIP of CSV files — people, challenges, activity, rankings; built by the
// server, scope-checked and refused to a competitor). Same shape as the activity
// export above: fetch, check, save through the one download helper.
export async function exportEventFullZip(compId,compName){
  if(!compId)return;
  showLoading();
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),120000);
  try{
    const r=await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/export/full?format=zip-csv`,{signal:ctrl.signal});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      showToast(d.error||'Could not export the event.','error');
      return;
    }
    const m=/filename="([^"]+)"/.exec(r.headers.get('content-disposition')||'');
    const slug=String(compName||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'event';
    downloadBlob(await r.blob(),m?m[1]:`${slug}-full-export.zip`);
    showToast('Event exported.','success');
  }catch(e){
    showToast(e&&e.name==='AbortError'?'The export timed out. Try again.':'Could not export the event.','error');
  }finally{
    clearTimeout(timer);
    hideLoading();
  }
}

export function downloadJson(data,filename){
  // v8.8.15 — this was the SYNCHRONOUS revoke, the one shape with a real
  // mechanism against it: the click is dispatched synchronously and the browser
  // reads the blob afterwards, so releasing in the same tick can hand over an
  // empty file. It is also the largest payload here (a full challenge or
  // participant export), which is why the shared helper bounds retention by a
  // timer rather than holding every blob until the tab closes.
  downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),filename);
}

export async function exportTasks(){
  showToast('Preparing challenge export...');
  let url='/api/admin/export/tasks';
  if(S.adminSelectedCompetitionId)url+=`?competitionId=${S.adminSelectedCompetitionId}`;
  const r=await fetch(url);
  if(!r.ok){showToast('Export failed.','error');return;}
  const data=await r.json();
  downloadJson(data,`tasks-export-${new Date().toISOString().slice(0,10)}.json`);
  showToast(`Exported ${data.tasks.length} challenge(s).`,'success');
}

export async function exportParticipants(){
  showToast('Preparing participant export...');
  let url='/api/admin/export/participants';
  if(S.adminSelectedCompetitionId)url+=`?competitionId=${S.adminSelectedCompetitionId}`;
  const r=await fetch(url);
  if(!r.ok){showToast('Export failed.','error');return;}
  const data=await r.json();
  downloadJson(data,`participants-export-${new Date().toISOString().slice(0,10)}.json`);
  showToast(`Exported ${data.participants.length} participant(s).`,'success');
}

export function showImportProgress(label,detail){
  let overlay=document.getElementById('import-progress-overlay');
  if(!overlay){
    overlay=document.createElement('div');
    overlay.id='import-progress-overlay';
    overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:9500;display:flex;align-items:center;justify-content:center;padding:24px';
    setSafeHtml(overlay, `<div class="card" style="max-width:min(400px, calc(100vw - 32px));width:100%;text-align:center">
      <h3 id="import-progress-label" style="margin-bottom:12px"></h3>
      <div style="background:var(--surface2);border-radius:var(--r-s);height:8px;overflow:hidden;margin-bottom:12px">
        <div id="import-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width var(--duration-normal) var(--ease-out)"></div>
      </div>
      <p id="import-progress-detail" style="font-size:var(--fs-13);color:var(--muted)"></p>
    </div>`);
    document.body.appendChild(overlay);
  }
  document.getElementById('import-progress-label').textContent=label;
  document.getElementById('import-progress-detail').textContent=detail||'';
}

export function updateImportProgress(pct,detail){
  const bar=document.getElementById('import-progress-bar');
  if(bar)bar.style.width=Math.min(100,pct)+'%';
  if(detail){const el=document.getElementById('import-progress-detail');if(el)el.textContent=detail;}
}

export function hideImportProgress(){
  const overlay=document.getElementById('import-progress-overlay');
  if(overlay)overlay.remove();
}

export async function importTasksFile(input){
  const file=input.files[0];if(!file)return;
  input.value='';
  try{
    showImportProgress('Reading file...',file.name);
    const data=JSON.parse(await file.text());
    if(data.type!=='hackarena-tasks'||!Array.isArray(data.tasks))throw new Error('Invalid format');
    updateImportProgress(20,`${data.tasks.length} challenge(s) found. Checking conflicts...`);
    const r=await fetch('/api/admin/import/tasks',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data})});
    const d=await r.json();
    hideImportProgress();
    if(!r.ok){showToast(d.error||'Import failed.','error');return;}
    if(d.dryRun&&d.conflicts.length>0){
      showConflictModal('tasks',data,d.conflicts);
    }else{
      showImportProgress('Importing tasks...',`${data.tasks.length} task(s)`);
      updateImportProgress(50);
      const r2=await fetch('/api/admin/import/tasks',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data,resolutions:{}})});
      const d2=await r2.json().catch(()=>({}));
      updateImportProgress(100,'Done!');
      setTimeout(hideImportProgress,500);
      // v7.21.19 (audit F5) — CHECK r2.ok. The dry run above is checked and this
      // execution was not, so a JSON error body produced a SUCCESS toast reading
      // "Imported undefined challenge(s), overwritten undefined…" — the import
      // had failed and the admin was told it worked, with the counts as the only
      // hint. (The conflict-resolution path further down already got this right,
      // which is what made the omission easy to miss.)
      if(!r2.ok){showToast(d2.error||'Import failed.','error');return;}
      showToast(`Imported ${d2.imported} challenge(s), overwritten ${d2.overwritten}, skipped ${d2.skipped}.${_importDropNote(d2)}`,'success');
      loadAdminTasks();
    }
  }catch(e){hideImportProgress();showToast('Failed to read file: '+e.message);}
}

export async function importParticipantsFile(input){
  const file=input.files[0];if(!file)return;
  input.value='';
  try{
    showImportProgress('Reading file...',file.name);
    const data=JSON.parse(await file.text());
    if(data.type!=='hackarena-participants'||!Array.isArray(data.participants))throw new Error('Invalid format');
    hideImportProgress();
    S._importParticipantsData=data;
    showParticipantSelectionStep(data);
  }catch(e){hideImportProgress();showToast('Failed to read file: '+e.message);}
}

export function showParticipantSelectionStep(data){
  S._importParticipantsSelected=new Set(data.participants.map((_,i)=>i));
  S._importPPage=1;
  const overlay=document.createElement('div');
  overlay.id='import-select-overlay';
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay, `<div class="card" style="max-width:min(900px, calc(100vw - 32px));width:100%;max-height:90vh;max-height:90dvh;display:flex;flex-direction:column">
    <h3 style="margin-bottom:16px">Select Participants to Import</h3>
    <p style="font-size:var(--fs-13);color:var(--muted);margin-bottom:10px">${data.participants.length} participant(s) in file. Uncheck any you don't want to import.</p>
    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
      <input id="import-p-search" placeholder="Search..." style="flex:1;min-width:150px" data-input-action="render-import-participants-rows"/>
      ${countHtml('import-p-search',{noun:'row'})}
      <span id="import-p-count" style="font-size:var(--fs-13);color:var(--muted)"></span>
    </div>
    <div style="overflow-y:auto;flex:1;min-height:0;border:1px solid var(--border);border-radius:var(--r-s)">
      <table style="width:100%;border-collapse:collapse;font-size:var(--fs-13)">
        <thead><tr style="font-size:var(--fs-12);color:var(--muted);text-transform:uppercase">
          <th scope="col" style="padding:6px 8px;border-bottom:1px solid var(--border);width:36px"><input type="checkbox" checked data-change-action="toggle-all-import-participants" aria-label="Select all participants for import" style="width:16px;height:16px;accent-color:var(--accent)"/></th>
          <th scope="col" style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">First</th>
          <th scope="col" style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Last</th>
          <th scope="col" style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Nickname</th>
          <th scope="col" style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Email</th>
          <th scope="col" style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border);width:60px">Status</th>
          <th scope="col" style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Tags</th>
        </tr></thead>
        <tbody id="import-p-rows"></tbody>
      </table>
    </div>
    <div class="pagination" id="import-p-pagination" style="flex-shrink:0"></div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-shrink:0;justify-content:flex-end">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="import-select-overlay">Cancel</button>
      <button class="btn" data-action="import-conflict-check">Next: Check Conflicts</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  renderImportParticipantRows();
}

/**
 * v7.17.2 — the indices the current search matches, in file order.
 *
 * Shared by the renderer and by select-all. That sharing is the point: before
 * this, "select all" ignored the search box entirely, so an operator who
 * searched "acme" and ticked the header box selected the WHOLE file while only
 * the Acme rows were on screen. The checkbox sits directly above the filtered
 * rows, so it reads as applying to them.
 */
export function _importMatchingIndices(){
  const data=S._importParticipantsData;
  if(!data)return [];
  const q=(document.getElementById('import-p-search')?.value||'').toLowerCase().trim();
  const out=[];
  for(let i=0;i<data.participants.length;i++){
    const p=data.participants[i];
    if(q){
      const hay=[p.first_name,p.last_name,p.nickname,p.email,p.secondary_email,...(p.tags||[])].join(' ').toLowerCase();
      if(!hay.includes(q))continue;
    }
    out.push(i);
  }
  return out;
}

export function renderImportParticipantRows(){
  const data=S._importParticipantsData;if(!data)return;
  const tbody=document.getElementById('import-p-rows');if(!tbody)return;
  const matching=_importMatchingIndices();
  // A real import file runs to thousands of rows; rendering every one of them
  // built thousands of <tr>s on every keystroke and every checkbox tick.
  const PAGE=100;
  const totalPages=Math.max(1,Math.ceil(matching.length/PAGE));
  const page=Math.min(Math.max(1,S._importPPage||1),totalPages);
  S._importPPage=page;
  const visible=matching.slice((page-1)*PAGE,page*PAGE);
  let html='';
  for(const i of visible){
    const p=data.participants[i];
    const chk=S._importParticipantsSelected.has(i)?'checked':'';
    const statusIcon=p.verified?`<span style="color:var(--green);display:inline-flex" title="Confirmed">${ICO.check}</span>`:`<span style="color:var(--muted);display:inline-flex" title="Unconfirmed">${ICO.circle}</span>`;
    const tags=(p.tags||[]).map(t=>`<span class="tag" style="font-size:var(--fs-12);padding:1px 5px">${esc(t)}</span>`).join(' ');
    // v7.23.1 (Wave 3) — the operator must READ an unchecked row to decide whether
    // to include it, so it cannot be dimmed into illegibility.
    html+=`<tr class="${chk?'':'row-deemphasised'}" style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 8px;text-align:center"><input type="checkbox" data-idx="${Number(i)}" ${chk} data-change-action="toggle-import-participant" data-index="${Number(i)}" aria-label="Import ${esc(p.nickname||p.email||('row '+(i+1)))}" style="width:16px;height:16px;accent-color:var(--accent)"/></td>
      <td style="padding:6px 8px">${esc(p.first_name||'')}</td>
      <td style="padding:6px 8px">${esc(p.last_name||'')}</td>
      <td style="padding:6px 8px;font-weight:var(--fw-semibold)">${esc(p.nickname||'')}</td>
      <td style="padding:6px 8px;font-size:var(--fs-12)">${esc(p.email||'')}</td>
      <td style="padding:6px 8px;text-align:center">${statusIcon}</td>
      <td style="padding:6px 8px">${tags}</td>
    </tr>`;
  }
  setSafeHtml(tbody, html||'<tr><td colspan="7" class="table-empty-row">No matches</td></tr>');
  const el=document.getElementById('import-p-count');
  if(el)el.textContent=`${S._importParticipantsSelected.size} of ${data.participants.length} selected`;
  // v7.20.11 — the span above is a SELECTION count and reads like a match count,
  // which is the worst of both: with one page of results and a filter active
  // there was nothing at all saying how many rows the search had found. The
  // pagination bar carries it only when totalPages > 1.
  setListCount('import-p-search',{matched:matching.length,total:data.participants.length,filtered:!!(document.getElementById('import-p-search')?.value||'').trim()});
  const pag=document.getElementById('import-p-pagination');
  if(pag){
    setSafeHtml(pag, totalPages>1 ? paginationHtml('import-p',{
      page,totalPages,
      totalLabel:matching.length===data.participants.length?`${matching.length} rows`:`${matching.length} of ${data.participants.length}`,
      pageSize:PAGE,sizes:[PAGE],
    }) : '');
  }
  // The header box reflects the FILTERED set, so it cannot claim "all" while a
  // search is hiding unselected rows.
  const allBox=document.querySelector('[data-change-action="toggle-all-import-participants"]');
  if(allBox){
    const on=matching.filter(i=>S._importParticipantsSelected.has(i)).length;
    allBox.checked=matching.length>0&&on===matching.length;
    allBox.indeterminate=on>0&&on<matching.length;
  }
}

export function toggleImportParticipant(idx,checked){
  if(checked)S._importParticipantsSelected.add(idx);else S._importParticipantsSelected.delete(idx);
  renderImportParticipantRows();
}

export function toggleAllImportParticipants(checked){
  const data=S._importParticipantsData;if(!data)return;
  // Scoped to what the search is showing (v7.17.2). Selecting or clearing rows
  // the operator cannot see is a silent data decision on their behalf — and on
  // this dialog it decides who gets written to the user table.
  const matching=_importMatchingIndices();
  if(checked)for(const i of matching)S._importParticipantsSelected.add(i);
  else for(const i of matching)S._importParticipantsSelected.delete(i);
  renderImportParticipantRows();
}

export async function proceedToConflictCheck(){
  const data=S._importParticipantsData;if(!data)return;
  if(!S._importParticipantsSelected.size){showToast('No participants selected.');return;}
  // Build filtered data with only selected participants, preserving original indices
  const selectedData={...data,participants:data.participants.filter((_,i)=>S._importParticipantsSelected.has(i))};
  document.getElementById('import-select-overlay')?.remove();
  showImportProgress('Checking conflicts...',`${selectedData.participants.length} participant(s)`);
  updateImportProgress(30);
  // v7.21.19 (audit F5) — the progress overlay is BLOCKING, so every exit from
  // here has to take it down. A thrown fetch (a dropped connection mid-import is
  // the obvious one) used to leave it up with no way out but a page reload, on
  // top of a screen the admin can no longer interact with. `showConflictModal`
  // is the one path that must survive the finally, so it sets `handedOff`.
  let handedOff=false;
  try{
    const r=await fetch('/api/admin/import/participants',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:selectedData})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){showToast(d.error||'Import failed.','error');return;}
    if(d.dryRun&&d.conflicts.length>0){
      hideImportProgress();
      handedOff=true;
      showConflictModal('participants',selectedData,d.conflicts);
      return;
    }
    updateImportProgress(50,'Importing participants...');
    const r2=await fetch('/api/admin/import/participants',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:selectedData,resolutions:{}})});
    const d2=await r2.json().catch(()=>({}));
    // Same missing check as the tasks path: an error body used to render as
    // "Imported undefined participant(s)" with a success tone.
    if(!r2.ok){_reportImportFailure(d2,'participants');return;}
    updateImportProgress(100,'Done!');
    showToast(`Imported ${d2.imported} participant(s), overwritten ${d2.overwritten}, skipped ${d2.skipped}.${_importDropNote(d2)}`,'success');
    loadAdminParticipants();
  }catch(e){
    showToast('Network error during import: '+(e&&e.message||e),'error');
  }finally{
    if(!handedOff)hideImportProgress();
  }
}

export function showConflictModal(type,data,conflicts){
  const isTask=type==='tasks';
  const overlay=document.createElement('div');
  overlay.id='conflict-overlay';
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';

  const header=`<tr style="font-size:var(--fs-12);color:var(--muted);text-transform:uppercase;letter-spacing:.03em">
    <th scope="col" style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)">${isTask?'Task':'Participant'}</th>
    ${!isTask?'<th scope="col" style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)">Conflict</th>':''}
    <th scope="col" style="text-align:center;padding:6px 10px;border-bottom:1px solid var(--border);width:70px">Keep</th>
    <th scope="col" style="text-align:center;padding:6px 10px;border-bottom:1px solid var(--border);width:70px">Overwrite</th>
    <th scope="col" style="text-align:center;padding:6px 10px;border-bottom:1px solid var(--border);width:70px">Add New</th>
  </tr>`;
  const rows=conflicts.map(c=>{
    const label=isTask
      ?`<strong>${esc(c.title)}</strong>`
      :`<strong>${esc(c.nickname)}</strong>`;
    const conflictCol=!isTask?`<td style="padding:6px 10px;vertical-align:middle;font-size:var(--fs-12);color:var(--muted)">${esc(c.conflictType)}</td>`:'';
    const renameFields=!isTask?`<div id="rename-fields-${c.index}" style="display:none;margin-top:6px;padding:8px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">
      <div style="font-size:var(--fs-12);color:var(--muted);margin-bottom:4px">New values for conflicting fields:</div>
      ${c.conflictType==='nickname'||c.conflictType==='both'?`<div style="margin-bottom:4px"><label style="font-size:var(--fs-12);color:var(--muted)">Nickname</label><input id="rename-nick-${c.index}" value="${esc(c.nickname)}" style="padding:4px 8px;font-size:var(--fs-13)"/></div>`:''}
      ${c.conflictType==='email'||c.conflictType==='both'?`<div><label style="font-size:var(--fs-12);color:var(--muted)">Email</label><input id="rename-email-${c.index}" value="${esc(c.email)}" style="padding:4px 8px;font-size:var(--fs-13)"/></div>`:''}
    </div>`:'';
    return`<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 10px;vertical-align:top">${label}<br/><span style="font-size:var(--fs-12);color:var(--muted)">${esc(c.email||'')}</span>${renameFields}</td>
      ${conflictCol}
      <td style="text-align:center;padding:6px 4px;vertical-align:top;padding-top:10px"><input type="radio" name="res-${c.index}" value="keep" checked data-change-action="on-conflict-res-change" data-index="${c.index}" aria-label="Keep existing ${esc(c.nickname||c.email||'item')}" style="width:16px;height:16px;accent-color:var(--accent)"/></td>
      <td style="text-align:center;padding:6px 4px;vertical-align:top;padding-top:10px"><input type="radio" name="res-${c.index}" value="overwrite" data-change-action="on-conflict-res-change" data-index="${c.index}" aria-label="Overwrite existing ${esc(c.nickname||c.email||'item')}" style="width:16px;height:16px;accent-color:var(--accent)"/></td>
      <td style="text-align:center;padding:6px 4px;vertical-align:top;padding-top:10px"><input type="radio" name="res-${c.index}" value="rename" data-change-action="on-conflict-res-change" data-index="${c.index}" aria-label="Add ${esc(c.nickname||c.email||'item')} as a new record" style="width:16px;height:16px;accent-color:var(--accent)"/></td>
    </tr>`;
  }).join('');

  // v7.17.0 — the resolutions live in a MODEL on the overlay, not in the DOM.
  //
  // executeConflictImport used to read each choice with
  // `querySelector('input[name="res-N"]:checked')` and fall back to 'keep' when
  // the element was absent. Every row is in the DOM today so that default never
  // fires — but it makes the modal impossible to paginate or virtualise safely:
  // any row not currently rendered would import as 'keep' silently, with no
  // error and no way for the operator to know. Since paginating this modal is
  // exactly what the long-list work wants to do, the state has to come out of
  // the DOM first.
  overlay._res = new Map(conflicts.map(c => [String(c.index), { choice: "keep", rename: {} }]));
  setSafeHtml(overlay, `<div class="card" style="max-width:${isTask?'700':'800'}px;width:100%;max-height:85vh;max-height:85dvh;display:flex;flex-direction:column">
    <h3 style="margin-bottom:16px">Resolve ${conflicts.length} Conflict${conflicts.length>1?'s':''}</h3>
    <p style="font-size:var(--fs-13);color:var(--muted);margin-bottom:12px">${data[type].length} ${type} to import. Items below already exist — choose how to handle each.</p>
    <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn sm secondary" data-action="import-conflict-set-all" data-resolution="keep">All: Keep</button>
      <button class="btn sm secondary" data-action="import-conflict-set-all" data-resolution="overwrite">All: Overwrite</button>
      <button class="btn sm secondary" data-action="import-conflict-set-all" data-resolution="rename">All: Add New</button>
    </div>
    <div id="conflict-error" style="color:var(--red);font-size:var(--fs-13);margin-bottom:8px;display:none"></div>
    <div style="overflow-y:auto;flex:1;min-height:0;border:1px solid var(--border);border-radius:var(--r-s)" id="conflict-list">
      <table style="width:100%;border-collapse:collapse;font-size:var(--fs-14)"><thead>${header}</thead><tbody>${rows}</tbody></table>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-shrink:0;justify-content:flex-end">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="conflict-overlay">Cancel</button>
      <button class="btn" data-action="import-conflict-execute" data-import-type="${esc(type)}">Import</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  // Store data for later use
  overlay._importData=data;
  overlay._conflicts=conflicts;
  overlay._type=type;
}

export function onConflictResChange(idx){
  const checked=document.querySelector(`input[name="res-${idx}"]:checked`);
  // Model first: it is the source of truth, and it must be updated even if the
  // rename panel below is missing for this row.
  const ov=document.getElementById('conflict-overlay');
  const rec=ov&&ov._res&&ov._res.get(String(idx));
  if(rec&&checked)rec.choice=checked.value;
  const el=document.getElementById(`rename-fields-${idx}`);
  if(!el)return;
  el.style.display=checked&&checked.value==='rename'?'':'none';
  // Clear error highlights
  const nickEl=document.getElementById(`rename-nick-${idx}`);
  const emailEl=document.getElementById(`rename-email-${idx}`);
  if(nickEl)nickEl.style.outline='';
  if(emailEl)emailEl.style.outline='';
}

export function setAllConflictResolutions(value){
  // The MODEL is authoritative, so set it for every conflict — including any
  // row not currently rendered. Ticking only the visible radios would leave
  // those rows on their previous choice while the button claims "All".
  const ov=document.getElementById('conflict-overlay');
  if(ov&&ov._res)for(const rec of ov._res.values())rec.choice=value;
  document.querySelectorAll('#conflict-list input[type="radio"]').forEach(r=>{
    if(r.value===value)r.checked=true;
  });
  // Show/hide rename fields for all
  document.querySelectorAll('[id^="rename-fields-"]').forEach(el=>{
    el.style.display=value==='rename'?'':'none';
  });
}

export async function executeConflictImport(type){
  const overlay=document.getElementById('conflict-overlay');
  if(!overlay)return;
  const data=overlay._importData;
  const conflicts=overlay._conflicts;
  const errEl=document.getElementById('conflict-error');
  if(errEl){errEl.style.display='none';errEl.textContent='';}
  const resolutions={};
  let hasError=false;

  for(const c of conflicts){
    // Read the MODEL, not the DOM. A row that is not currently rendered still
    // carries its choice; previously it silently became 'keep'.
    const rec=(overlay._res&&overlay._res.get(String(c.index)))||{choice:'keep',rename:{}};
    // Where the row IS rendered the radio is authoritative, because the user
    // may have clicked it without the change event having been processed.
    const checked=document.querySelector(`input[name="res-${c.index}"]:checked`);
    if(checked)rec.choice=checked.value;
    const res=rec.choice||'keep';
    resolutions[String(c.index)]=res;

    // For "rename" on participants, collect user-edited fields and validate
    if(res==='rename'&&type==='participants'){
      const nickEl=document.getElementById(`rename-nick-${c.index}`);
      const emailEl=document.getElementById(`rename-email-${c.index}`);
      const renameData={};
      // Same rule for the typed values: live input wins, model is the fallback
      // for a row that is not on screen.
      if(!nickEl&&rec.rename&&rec.rename.nickname!==undefined)renameData.nickname=rec.rename.nickname;
      if(!emailEl&&rec.rename&&rec.rename.email!==undefined)renameData.email=rec.rename.email;
      if(nickEl){
        renameData.nickname=nickEl.value.trim();
        nickEl.style.outline='';
        if(!renameData.nickname){nickEl.style.outline='2px solid var(--red)';hasError=true;}
      }
      if(emailEl){
        renameData.email=emailEl.value.trim();
        emailEl.style.outline='';
        if(!renameData.email){emailEl.style.outline='2px solid var(--red)';hasError=true;}
      }
      // Check if values still conflict with existing DB entries (check against other rename values too)
      if(nickEl&&renameData.nickname===c.nickname){nickEl.style.outline='2px solid var(--red)';hasError=true;}
      if(emailEl&&renameData.email.toLowerCase()===c.email.toLowerCase()){emailEl.style.outline='2px solid var(--red)';hasError=true;}
      rec.rename=renameData;                 // keep the model in step
      resolutions[`${c.index}_rename`]=renameData;
    }
  }

  if(hasError){
    if(errEl){errEl.textContent='Please change the highlighted fields to resolve conflicts.';errEl.style.display='';}
    return;
  }

  overlay.remove();
  const count=type==='tasks'?data.tasks.length:data.participants.length;
  showImportProgress(`Importing ${type}...`,`${count} item(s) with ${conflicts.length} conflict(s) resolved`);
  updateImportProgress(50);
  const url=type==='tasks'?'/api/admin/import/tasks':'/api/admin/import/participants';
  // v7.21.19 (audit F5) — try/finally for the same reason as
  // proceedToConflictCheck: a thrown fetch here left the blocking overlay up.
  try{
    const r=await fetch(url,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data,resolutions})});
    const d=await r.json().catch(()=>({}));
    updateImportProgress(100,'Done!');
    if(!r.ok){_reportImportFailure(d,type);return;}
    showToast(`Imported ${d.imported}, overwritten ${d.overwritten}, skipped ${d.skipped}.${_importDropNote(d)}`,'success');
    if(type==='tasks')loadAdminTasks();else loadAdminParticipants();
  }catch(e){
    showToast('Network error during import: '+(e&&e.message||e),'error');
  }finally{
    hideImportProgress();
  }
}
