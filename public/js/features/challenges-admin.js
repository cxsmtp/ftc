"use strict";

import { S } from "../core/state.js";
import { loadTopics, renderTopicFilter, renderTopicPicker, taskInTopicFilter, topicName, NO_TOPIC } from "./topics-admin.js"; // stage B — the Question bank's topics
import { applyColumnFilters, applyColumnSort, columnSortActive, hasColumnFilters } from "../ui/table-columns.js"; // v8.17.0 — Columns + heading sort/filter
import { colspanFor, countText, paginationHtml, pickerFilterHtml, renderLoadFailure, setListCount, wirePickerFilter } from "../ui/list-controls.js"; // v7.17.1 — shared list chrome; v8.1.4 — the grant dialog's participant search
import { csrfHeaders, readyToWrite, trackInflightWrite, fetchWithLoading, loadCsrfToken, fetchJsonList, announceImpersonationEnded } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { computeCompStatus, compDisplayCategory, COMP_CATEGORY_LABEL } from "./competition-picker.js";
import { loadAdminCompetitions, compareCompsForPicker } from "./competitions-admin.js";
import { closeHistoryDialog } from "./history.js";
import { _fmtBytes, esc, fmtDt, _syncSortAria, formatCorrectAnswer, DRY_RUN_TAG, PUBLIC_DOMAIN_TAG} from "../ui/format.js";
import { markFieldError, clearFieldErrors } from "../ui/profile-form.js";
import { DIFF_PTS, ICO } from "../ui/icons.js";
import { showSkeletonRows, showLoading, hideLoading } from "../ui/loading.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { createRichEditor, highlightCodeElement, renderRich } from "../ui/richtext.js";
import { showToast } from "../ui/toast.js";
import { taskMatchesQuery, isQualifyingTask, bankTasks, workspaceTasks, pickerTasks } from "../ui/task-search.js"; // the one challenge search: title, difficulty, tags; the one qualifying test
import { addTasksToCompetition, runBoundedCollect } from "./task-assign.js"; // the one add-to-event path
import { tipsAllOn } from "../ui/help-tips.js";
import { _stopAllPolls, _announceSignout } from "./session-monitor.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (ESM tolerates the nav cycle: read inside functions only)

// v7.23.0 — one loader for the admin challenge list, because both call sites
// had the same two defects.
//
// `fetch(...).then(r=>r.json()).catch(()=>[])` never checked `r.ok`. On a 500
// the error body either fails to parse (-> []) or parses to `{error:...}`,
// which is NOT an array, so the next `.filter` throws "X is not a function".
// Both outcomes are silent to the operator, and the second is worse than empty:
// openAddTasksToCompetition() then reported "No more published challenges to
// add." — a confident WRONG answer about the data, from a request that failed.
//
// Returns null on failure so callers can distinguish "the fetch failed" from
// "there genuinely are none". Never returns a non-array.
async function _loadAdminTaskList(){
  let r=null;
  try{ r=await fetch('/api/admin/tasks'); }catch(_){ return null; }
  if(!r.ok) return null;
  let body=null;
  try{ body=await r.json(); }catch(_){ return null; }
  return Array.isArray(body)?body:null;
}

/**
 * v8.1.4 — could a grant on this challenge do anything?
 *
 * A cap is most-specific-wins (`lib/attempts.js`): the challenge's own
 * `attempt_cap` beats the event's, and NULL at both levels means uncapped. The
 * challenge row carries its own cap; the EVENT's lives on the competitions
 * model, which the Challenges tab does not load.
 *
 * SO AN ABSENT COMPETITIONS MODEL MEANS "UNKNOWN", NEVER "UNCAPPED". Reading it
 * as uncapped would hide the control for exactly the capped-by-event case —
 * an affordance that silently disappears is worse than one that explains itself
 * (v7.14.2), and it would depend on which tab the admin happened to open first.
 * The dialog fetches the events itself and is authoritative either way; this is
 * only the gate.
 */
export function _taskMayHaveCap(t){
  // v8.3.11 — ENDED EVENTS ARE NOT EXCLUDED, and that exclusion was the defect.
  // The server has always permitted a grant on an ended event, deliberately: once
  // everyone is solved-or-exhausted the event auto-ends and BOTH revive gates
  // refuse while that predicate still holds, so the grant is what un-finishes the
  // exhausted participant and unlocks the reopen. Filtering ended events here (and
  // again in the dialog below) made the one case the route exists to serve
  // reachable only with curl — the exact "a control they cannot reach is no
  // control at all" failure v8.1.5 was written to fix, shipped inside v8.1.5.
  const comps=(t.competitions||[]);
  if(!comps.length)return false;
  if(t.attempt_cap!=null)return true;
  if(!S.adminCompetitionsData.length)return true;          // unknown, not absent
  return comps.some(c=>{
    const full=S.adminCompetitionsData.find(x=>x.id===c.id);
    return full?full.attempt_cap!=null:true;               // ditto, per event
  });
}

// v8.12.6 (sweep) — THE THREE CHALLENGE DIALOGS SHOW WHAT YOU OPENED, the
// Join Link / History rule (self-enroll.js `_seOpenSeq`, history.js
// `_histOpenSeq`) applied to the three openers that await the network before
// building their dialog and had none of it. Two opens in flight (a double-click,
// or event A's picker still loading when event B's is asked for) stacked TWO
// dialogs with the SAME id — and every control was found with
// document.getElementById, which returns the FIRST one: the dialog on top wrote
// its ticks through the other's listeners, and "Assign to Events" read both
// lists' checkboxes and sent them to the challenge on top. Three rules, per
// dialog: the LATEST open wins (a token taken before the await, re-checked after
// it; a superseded open says nothing at all); a dialog already showing is
// removed AFTER the await, never before, so a slow load cannot leave the admin
// looking at nothing; and the controls an opener binds are found through ITS
// overlay, never the document.
let _taskPickerOpenSeq=0;
let _assignOpenSeq=0;
let _grantOpenSeq=0;

export async function openTaskPickerForCompetition(compId){
  // v7.20.10 — this dialog is now a SET operation, not an add-only one.
  //
  // It used to build `assignable = published.filter(t => !alreadyAssigned)`, so
  // the challenges already on the competition were not merely mis-ticked, they
  // were ABSENT — there was no way to see the competition's actual challenge
  // list here, and no way to take one off. The ticks now mirror reality:
  // assigned = ticked, unassigned = unticked, and Save applies the difference in
  // both directions.
  const seq=++_taskPickerOpenSeq;
  const tasks=await _loadAdminTaskList();
  if(seq!==_taskPickerOpenSeq)return;   // v8.12.6 — superseded by a later open (the list is parsed inside the loader)
  if(!tasks){ showToast('Could not load the challenge list. Please try again.','error'); return; }
  // Bank questions (ticked where the event holds its copy) and the event's own
  // questions no bank question stands for (lib/event-copies.js).
  const published=pickerTasks(tasks,compId).filter(t=>t.status==='published');
  const isOn=t=>(t.competitions||[]).some(c=>c.id===compId);
  // Operator ruling N7 (14 Nov 2026) — AN EVENT ASKS EACH QUALIFYING QUESTION
  // ONCE. Another event's qualifying question may be added (the two events then
  // share its wording), but one on a topic this event already asks — any
  // challenge it holds with that key, a draft included, the server's rule — is
  // not listed, and the note says how many were left out. `qualifying_keys` is
  // the server's own parse of the tag.
  const heldKeys=new Set(tasks.filter(isOn).flatMap(t=>t.qualifying_keys||[]));
  const topicHeld=t=>!isOn(t)&&(t.qualifying_keys||[]).some(k=>heldKeys.has(k));
  const hiddenTopics=published.filter(topicHeld).length;
  // THE BASELINE IS `assigned ∩ LISTED`, never `assigned` alone.
  //
  // A challenge can be assigned to a competition and yet be a DRAFT — restoring
  // a task to an earlier version can unpublish it while its competition_tasks
  // rows survive. Drafts are not listed here (they cannot be assigned), so
  // computing removals as `allAssigned \ ticked` would silently unassign every
  // one of them the first time anybody pressed Save. Scoping the baseline to
  // what is actually on screen means this dialog can only ever change what it
  // showed you.
  const listed=published.filter(t=>!topicHeld(t));
  const baseline=new Set(listed.filter(isOn).map(t=>String(t.id)));
  const hiddenAssigned=tasks.filter(t=>t.status!=='published'&&isOn(t)).length;
  S._pickerCheckedIds=new Set(baseline);
  // Locked challenges refuse assignment changes for anyone but a superadmin
  // (routes/challenges.js). Offering a tick that is certain to 403 is the
  // affordance-that-lies failure v7.14.2 names — and 40 of them would be 40
  // sequential 4xx, a third of the scanner tracker's block threshold in one
  // click. Disable them, and say why.
  const lockedIds=new Set(listed.filter(t=>t.locked&&!S.isSuperAdmin).map(t=>String(t.id)));
  // v8.8.5 — AND THE ONES THIS ACTOR MAY NOT TAKE OUT. `can_unassign` is PER
  // COMPETITION — "may I remove this from THAT event" depends on who put it
  // there, and an event admin may remove only assignments they made themselves.
  // The row kebab has honoured it since v8.7.0; this dialog applied a strictly
  // LOOSER rule to the same action on the same challenge, so unticking sent a
  // DELETE the server refuses, after a confirm modal that named it as a removal.
  //
  // TICKED AND DISABLED is the correct state, not unticked: the challenge IS in
  // the event, and what this actor lacks is permission to take it out.
  const noUnassignIds=new Set(listed.filter(t=>{
    const e=(t.competitions||[]).find(c=>c.id===compId);
    return e&&e.can_unassign===false;
  }).map(t=>String(t.id)));
  // v8.12.0 — AN EVENT WHERE STAFF COMPETE ADMITS ONLY SEALED CHALLENGES (a
  // competing admin would otherwise read the answer key off the admin pane), so
  // an unsealed row is disabled with the reason rather than offered and refused.
  // Already-assigned rows stay live whatever their seal — removal is the remedy
  // the server's refusals name, and must never be blocked. The AUTHOR rule (a
  // challenge whose author competes here) is not visible to the client — the
  // author's id is not on the wire — so that refusal arrives from the server
  // and is rendered by showAssignmentRefusalModal.
  const _comp0=S.adminCompetitionsData.find(c=>c.id===compId);
  const _sealOnly=!!(_comp0&&_comp0.staff_compete);
  const unsealedIds=new Set(_sealOnly?listed.filter(t=>!t.answer_sealed&&!isOn(t)).map(t=>String(t.id)):[]);
  S._pickerLocked=lockedIds;
  S._pickerNoUnassign=noUnassignIds;
  S._pickerUnsealed=unsealedIds;
  S._pickerBaseline=baseline;
  // N7 — the qualifying keys of every listed row that has one, and the list's
  // order: at most one question per topic may be ticked to add (_syncPickerTopics).
  S._pickerKeys=new Map(listed.filter(t=>(t.qualifying_keys||[]).length).map(t=>[String(t.id),t.qualifying_keys]));
  S._pickerOrder=listed.map(t=>String(t.id));
  // The confirmation modal names every challenge it is about to add or remove,
  // and it must be able to do that for rows the Challenges TABLE has not loaded
  // — the table paginates, this dialog fetches the full published set. Carry the
  // titles with the dialog rather than reading a table that may not hold them.
  S._pickerNames=new Map(listed.map(t=>[String(t.id),t.title]));
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  // Assignments freeze once ANY session has ended. The server has always
  // refused this (400); the dialog never said so, so every Save simply failed
  // with a toast. Say it up front and disable the controls instead.
  const frozen=!!comp&&((comp.timeslots||[]).some(ts=>computeCompStatus(ts)==='ended')||(!(comp.timeslots||[]).length&&computeCompStatus(comp)==='ended'));
  let _pickerDiff='all';
  document.querySelectorAll('#task-picker-overlay').forEach(o=>o.remove());
  const overlay=document.createElement('div');
  overlay.id='task-picker-overlay';
  overlay.className='picker-overlay';
  setSafeHtml(overlay,`<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="task-picker-title">
    <div class="picker-modal-head">
      <h3 id="task-picker-title">Challenges in ${comp?esc(comp.name):'this event'}</h3>
    </div>
    ${frozen?`<p class="picker-note" id="task-picker-frozen" style="color:var(--red)">A session of this event has already ended, so its challenge list is frozen. Reopening it is a superadmin action — and for a multi-session event every finished session has to be reopened, not just one.</p>`:''}
    ${_sealOnly?`<p class="picker-note" id="task-picker-seal-note">Staff compete in this event, so only challenges with a <strong>sealed</strong> answer can be added — and never one created by somebody who is competing in it.</p>`:''}
    ${listed.length?`<div class="picker-filters">
      <input id="task-picker-search" type="search" class="picker-search" aria-label="Search challenges by title, difficulty or tag" placeholder="Search by title, difficulty or tag…" autocomplete="off">
      <div class="picker-diff-filters" id="task-picker-diff-filters">
        <button class="filter-btn active" data-diff="all">All</button>
        <button class="filter-btn" data-diff="easy">Easy</button>
        <button class="filter-btn" data-diff="medium">Medium</button>
        <button class="filter-btn" data-diff="hard">Hard</button>
      </div>
    </div>
    <p class="picker-note" id="task-picker-note"></p>
    <div class="picker-toolbar">
      <button class="btn sm secondary" data-action="task-picker-select-all" ${frozen?'disabled':''}>Select All Shown</button>
      <button class="btn sm secondary" data-action="task-picker-unselect-all" ${frozen?'disabled':''}>Unselect All Shown</button>
      <span id="task-picker-count" class="picker-toolbar-count"></span>
    </div>
    <div class="picker-rows" id="task-picker-list"></div>`:
    '<p class="picker-note">No published challenges exist yet.</p>'}
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="task-picker-overlay">${listed.length?'Cancel':'Close'}</button>
      <button class="btn" id="task-picker-save" data-action="task-picker-assign" data-comp-id="${esc(compId)}" ${frozen?'disabled':''}>Save Changes</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>{_clearPickerState();overlay.remove();});
  if(!listed.length)return;
  function _visibleTasks(){
    const q=(overlay.querySelector('#task-picker-search')?.value||'').toLowerCase().trim();
    let visible=listed;
    if(q)visible=visible.filter(t=>taskMatchesQuery(t,q));
    if(_pickerDiff!=='all')visible=visible.filter(t=>t.difficulty===_pickerDiff);
    return {visible,q};
  }
  function _renderPickerRows(){
    const {visible,q}=_visibleTasks();
    const list=overlay.querySelector('#task-picker-list');
    if(!list)return;
    setSafeHtml(list,visible.map(t=>{
      const id=String(t.id);
      const checked=S._pickerCheckedIds.has(id)?'checked':'';
      const lock=lockedIds.has(id);
      const noRm=!lock&&noUnassignIds.has(id);
      const unsealed=!lock&&!noRm&&unsealedIds.has(id);
      const tags=(t.tags||[]).map(tg=>`<span class="tag">${esc(tg)}</span>`).join('');
      const wasOn=baseline.has(id);
      return `<label class="picker-row${lock||noRm||unsealed?' is-disabled':''}"${lock?' title="This challenge is locked — only a superadmin can change its events."':(noRm?' title="Added to this event by someone else — only they or an administrator can remove it."':(unsealed?' title="Its answer is not sealed — an event where staff compete only admits sealed challenges."':''))}>
        <input type="checkbox" value="${esc(id)}" ${checked} ${lock||noRm||unsealed||frozen?'disabled data-base-disabled="1"':''} data-change-action="update-task-picker-count" class="picker-row-check"/>
        <span class="picker-row-body"><strong>${esc(t.title)}</strong> <span class="badge ${esc(t.difficulty)}">${esc(t.difficulty)}</span>${tags}${t.active?'':'<span class="picker-row-flag">Hidden</span>'}${wasOn?'<span class="picker-row-flag is-on">In this event</span>':''}${lock?'<span class="picker-row-flag">Locked</span>':''}${noRm?'<span class="picker-row-flag">Added by someone else</span>':''}${unsealed?'<span class="picker-row-flag">Not sealed</span>':''}</span>
      </label>`;
    }).join(''));
    const note=overlay.querySelector('#task-picker-note');
    if(note){
      note.textContent=countText({matched:visible.length,total:listed.length,filtered:!!q||_pickerDiff!=='all',noun:'challenge'})
        +(hiddenAssigned?` — ${hiddenAssigned} assigned draft challenge(s) are not listed and are unaffected.`:'')
        +(hiddenTopics?` — ${hiddenTopics} qualifying question(s) are not listed: this event already asks a question on each one's topic.`:'');
    }
    updateTaskPickerCount();
  }
  overlay.querySelector('#task-picker-list').addEventListener('change',e=>{
    if(e.target.type==='checkbox'){
      if(e.target.checked)S._pickerCheckedIds.add(e.target.value);
      else S._pickerCheckedIds.delete(e.target.value);
    }
  });
  overlay.querySelector('#task-picker-search').addEventListener('input',_renderPickerRows);
  overlay.querySelector('#task-picker-diff-filters').addEventListener('click',e=>{
    const btn=e.target.closest('.filter-btn');
    if(!btn)return;
    _pickerDiff=btn.dataset.diff;
    overlay.querySelectorAll('#task-picker-diff-filters .filter-btn').forEach(b=>b.classList.toggle('active',b===btn));
    _renderPickerRows();
  });
  _renderPickerRows();
}

// Operator ruling N7 — AT MOST ONE QUESTION PER TOPIC TICKED TO ADD. The ticks
// this dialog would add claim their qualifying keys, the first in list order
// winning (so Select All keeps one per topic); a row whose topic another tick
// claimed is disabled, with the reason, and unticked if it was ticked. Rows the
// event already holds claim nothing: their topics' other questions are not listed.
// Toggled in place (never a re-render), so the box just ticked keeps its focus.
function _syncPickerTopics(){
  const keysOf=S._pickerKeys;
  if(!keysOf||!keysOf.size)return;
  const sel=S._pickerCheckedIds||new Set(), base=S._pickerBaseline||new Set();
  const claimed=new Map();
  for(const id of (S._pickerOrder||[])){
    if(!sel.has(id)||base.has(id))continue;
    const ks=keysOf.get(id)||[];
    if(ks.some(k=>claimed.has(k))){sel.delete(id);continue;}
    for(const k of ks)claimed.set(k,id);
  }
  for(const cb of document.querySelectorAll('#task-picker-list input.picker-row-check')){
    const id=cb.value, ks=keysOf.get(id)||[];
    if(!ks.length||base.has(id))continue;
    const taken=ks.some(k=>claimed.has(k)&&claimed.get(k)!==id);
    if(cb.checked&&!sel.has(id))cb.checked=false;
    if(cb.dataset.baseDisabled==='1')continue;
    cb.disabled=taken;
    const row=cb.closest('.picker-row');
    if(!row)continue;
    row.classList.toggle('is-disabled',taken);
    let flag=row.querySelector('.picker-row-flag.is-topic');
    if(taken&&!flag){
      flag=document.createElement('span');flag.className='picker-row-flag is-topic';flag.textContent='Same topic as a ticked question';
      row.querySelector('.picker-row-body')?.appendChild(flag);
      row.title='Another qualifying question on this topic is ticked: an event asks each one once.';
    }else if(!taken&&flag){flag.remove();row.removeAttribute('title');}
  }
}

export function updateTaskPickerCount(){
  const el=document.getElementById('task-picker-count');
  if(!el)return;
  _syncPickerTopics();
  const sel=S._pickerCheckedIds||new Set();
  const base=S._pickerBaseline||new Set();
  const add=[...sel].filter(id=>!base.has(id)).length;
  const rm=[...base].filter(id=>!sel.has(id)).length;
  // v7.20.10 — report the DIFF, not the selection. "18 selected" tells an admin
  // nothing about what Save is going to do now that Save can also remove.
  el.textContent=(!add&&!rm)?`${sel.size} in this event — no changes`
    :`${sel.size} selected — ${add} to add, ${rm} to remove`;
  const save=document.getElementById('task-picker-save');
  if(save&&!save.hasAttribute('data-frozen'))save.disabled=(!add&&!rm);
}

// v8.12.6 (review) — the picker's state lives on `S` (the row renderer and
// updateTaskPickerCount read it), so every reset clears ALL its fields, in one
// place: the dismiss handler forgot `_pickerNoUnassign`, the save forgot it and
// `_pickerUnsealed`.
function _clearPickerState(){
  S._pickerCheckedIds=null;S._pickerBaseline=null;S._pickerLocked=null;
  S._pickerNoUnassign=null;S._pickerUnsealed=null;S._pickerNames=null;
  S._pickerKeys=null;S._pickerOrder=null;
}

export async function assignPickedTasks(compId,overlayIn){
  // v8.12.6 (review) — THE SAVE CLOSES ITS OWN DIALOG, AND RESETS ITS OWN STATE.
  // The sweep gave "Assign to Events" and "Grant Attempts" this shape and left
  // the picker's save behind: after its awaits (the confirm, then two bounded
  // phases of requests) it removed `#task-picker-overlay` BY ID and nulled every
  // `S._picker*` field unconditionally. Only Save is disabled while it runs, so
  // Cancel and Escape still work — and an admin who closed this dialog and
  // opened the picker for ANOTHER event meanwhile had that dialog removed and
  // its unsaved ticks wiped when this save answered (measured). The overlay is
  // resolved at ENTRY (passed from the action; by id only as a fallback, while
  // it is still this dialog), and the state is reset only while it is still the
  // object this save read — a later open replaces it with a new Set.
  const overlay=overlayIn||document.getElementById('task-picker-overlay');
  const _mine=S._pickerCheckedIds;
  const sel=S._pickerCheckedIds||new Set();
  const base=S._pickerBaseline||new Set();
  const locked=S._pickerLocked||new Set();
  // Filtered in BOTH directions for the same reason the locked set is: a disabled
  // row cannot move through the UI, but a hand-edited DOM must not smuggle one past.
  const noRemove=S._pickerNoUnassign||new Set();
  const unsealed=S._pickerUnsealed||new Set();   // v8.12.0 — same posture as the locked set
  // A locked row is rendered disabled, so it cannot move through the UI — but
  // filter both directions anyway so a hand-edited DOM cannot smuggle one past.
  const toAdd=[...sel].filter(id=>!base.has(id)&&!locked.has(id)&&!unsealed.has(id));
  const toRemove=[...base].filter(id=>!sel.has(id)&&!locked.has(id)&&!noRemove.has(id));
  if(!toAdd.length&&!toRemove.length){showToast('No changes to save.');return;}
  const nameOf=id=>(S._pickerNames&&S._pickerNames.get(String(id)))||String(id);
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const isLive=comp&&computeCompStatus(comp)==='live';
  const li=ids=>`<ul style="margin:6px 0 0 18px;max-height:180px;overflow:auto">${ids.slice(0,40).map(id=>`<li>${esc(nameOf(id))}</li>`).join('')}${ids.length>40?`<li><em>…and ${ids.length-40} more</em></li>`:''}</ul>`;
  // v7.20.10 — confirm before applying, naming EVERY challenge on both sides.
  // Removal is destructive and this dialog can now do it in bulk, so the blast
  // radius has to be visible before it happens rather than described afterwards
  // in a toast. Headings render only for a non-empty side — a heading over an
  // empty list is the empty-shell shape v7.20.3 removed.
  const parts=[];
  if(toAdd.length)parts.push(`<strong>Adding ${toAdd.length} challenge(s)</strong>${li(toAdd)}`);
  if(toRemove.length)parts.push(`<strong>Removing ${toRemove.length} challenge(s)</strong>${li(toRemove)}`);
  if(toRemove.length)parts.push(`<p style="margin:10px 0 0">Removing a challenge takes it off this event for everyone. Any points already scored on it are kept, but it stops counting toward the leaderboard and participants can no longer open it.</p>`);
  if(isLive)parts.push(`<p style="margin:10px 0 0"><strong>${esc(comp.name)}</strong> is <strong>live</strong> — this takes effect immediately.</p>`);
  const ok=await showModal({
    title:'Apply challenge changes?',
    message:parts.join(''),
    confirmText:toRemove.length?'Apply Changes':'Add Challenges',
    confirmClass:toRemove.length?'danger':'',
    cancelText:'Cancel',
  });
  if(!ok)return;   // keep the dialog, the filter and the ticks
  // ADDS FIRST, REMOVALS LAST. If the batch dies half way, a competition that
  // is a SUPERSET of the intent is harmless (a challenge lingers a moment
  // longer); a SUBSET means participants lost a live challenge. Do the
  // destructive half last. The two phases stay strictly ordered — the
  // concurrency below is WITHIN a phase, never across them.
  let added=0,already=0,removed=0;
  const failures=[];
  // v8.12.0 — a STRUCTURED refusal (the staff-compete seal rule, `code` +
  // `refused`) is collected apart from the ordinary failures and shown as a
  // modal listing the challenges, because the remedy is per challenge.
  const refused=[];
  //
  // v8.3.20 (external audit) — THREE THINGS THIS LOOP DID NOT DO.
  //
  // 1. A THROWN fetch was completely silent. This function is async with no
  //    try/catch, the fetch interceptor re-throws, and the SPA registers no
  //    `unhandledrejection` handler — so venue wi-fi dropping mid-save left the
  //    dialog open, the Save button live, and NOTHING on screen. That is the
  //    worst failure the picker has, and it is the one nobody reported because
  //    there was nothing to report.
  // 2. No spinner and no disabled Save, so a slow save invited a second click
  //    that would re-apply the whole diff.
  // 3. STRICTLY SERIAL, unbounded. One round trip per ticked challenge: at a
  //    200 ms WAN RTT a forty-challenge save is ~8 s of dead screen.
  //
  // Bounded concurrency over the EXISTING per-task routes, rather than the bulk
  // endpoint. `POST /api/admin/tasks/assign-competitions` looks like the obvious
  // move and is NOT equivalent: it is BEST-EFFORT and reports a skip ledger,
  // where this route THROWS a named refusal per challenge — so migrating would
  // silently turn "Booth Event refuses this file-answer challenge, here is which
  // one" into a number, on the one screen where an admin can act on it. The
  // latency was the complaint; the named refusal is the thing worth keeping.
  //
  // EVERY ITEM IS ATTEMPTED, AND NO REJECTION ESCAPES. `Promise.all` settles on
  // the FIRST rejection but does NOT cancel its siblings — they keep draining
  // the shared index and issuing requests. So a single thrown fetch (one reset
  // connection on venue wi-fi, not an outage) would have run the catch, snapshot
  // counters that were still being mutated, dropped the spinner, torn the
  // overlay down and toasted a count — while up to five more requests were still
  // in flight, including DELETEs the admin had just been told had stopped.
  // Catching per ITEM keeps the phases deterministic: the loop finishes, the
  // counters are final when they are read, and each failure names its own
  // challenge instead of one message standing for the rest.
  const _runBounded = (items, width, fn) => runBoundedCollect(items, width, fn, failures, nameOf);
  const saveBtn=overlay?overlay.querySelector('#task-picker-save'):null;
  if(saveBtn)saveBtn.disabled=true;
  showLoading();   // the shared overlay takes no message
  try{
    const a=await addTasksToCompetition(compId,toAdd,nameOf);
    added+=a.added;already+=a.already;refused.push(...a.refused);failures.push(...a.failures);
    // The phase barrier: every add has landed before the first removal is sent.
    await _runBounded(toRemove, 6, async (tid) => {
      const r=await fetch(`/api/admin/tasks/${tid}/competitions/${encodeURIComponent(compId)}`,{method:'DELETE',headers:csrfHeaders()});
      if(r.ok)removed++;
      else{const d=await r.json().catch(()=>({}));failures.push(`${nameOf(tid)}: ${d.error||r.status}`);}
    });
  }catch(e){
    // Defence in depth. `_runBounded` swallows every per-item rejection, so this
    // is reached only by something outside the loop bodies — and the picker must
    // never end with the dialog open, the Save button live and nothing on screen,
    // which is exactly how a thrown fetch used to behave here.
    failures.push(`the operation stopped unexpectedly — ${added} added, ${removed} removed`);
  }finally{
    hideLoading();
    if(saveBtn)saveBtn.disabled=false;
  }
  if(S._pickerCheckedIds===_mine)_clearPickerState();
  overlay?.remove();   // a no-op when the admin already closed it themselves
  const msg=[];
  if(added)msg.push(`${added} added.`);
  if(removed)msg.push(`${removed} removed.`);
  if(already)msg.push(`${already} were already assigned.`);
  if(refused.length)msg.push(`${refused.length} refused — see the list.`);
  if(failures.length)msg.push(`${failures.length} failed — ${failures[0]}`);
  showToast(msg.join(' ')||'No changes.', (failures.length||refused.length)?'error':(already?'warning':'success'));
  if(refused.length)showAssignmentRefusalModal(refused);
  loadAdminTasks();loadAdminCompetitions();
}

// v8.12.0 — THE REFUSED-ASSIGNMENT MODAL. Every assignment door — the
// competition-side picker, the bulk assign and the per-challenge "Assign to
// Events" dialog — can now refuse a (challenge, event) pair for one of two
// reasons that are properties of the PAIR: the challenge's answer is not sealed
// and the event lets staff compete, or the challenge's author competes in the
// event. A toast cannot hold a list and the remedy is per pair, so the pairs
// are listed, with the reason beside each. `refused_total` (bulk) says when the
// list was capped.
export function showAssignmentRefusalModal(refused,total){
  const rows=Array.isArray(refused)?refused:[];
  if(!rows.length)return;
  const reasonText=r=>r.reason==='author_competes'
    ?'its author is competing in the event'
    :r.reason==='unsealed'?'its answer is not sealed':(r.message||'refused');
  const li=rows.map(r=>`<li><strong>${esc(r.title||r.task_id)}</strong> → ${esc(r.competition_name||r.competition_id)} — ${esc(reasonText(r))}</li>`).join('');
  const capped=(Number(total)||rows.length)>rows.length?`<li><em>…and ${(Number(total)||0)-rows.length} more</em></li>`:'';
  showModal({
    title:'Some challenges were not added',
    message:`An event where staff compete only admits challenges whose answer is <strong>sealed</strong>, and never one created by somebody competing in it — a competing admin could otherwise read the answer.<ul style="margin:8px 0 0 18px;max-height:220px;overflow:auto">${li}${capped}</ul><p style="margin-top:8px;color:var(--muted);font-size:var(--fs-14)">Seal a new copy of the challenge, choose a sealed one by another author, or turn off "Staff can compete" on the event.</p>`,
    confirmText:'OK',cancelText:null,
  });
}

export function toggleTaskDiffFilter(btn){toggleMultiFilter(btn,S.tDiffFilters,'#task-diff-filters',['easy','medium','hard']);S.tPage=1;renderAdminTasks();}

export function toggleTaskStatusFilter(btn){toggleMultiFilter(btn,S.tStatusFilters,'#task-status-filters',['published','draft']);S.tPage=1;renderAdminTasks();}

export function toggleTaskStateFilter(btn){toggleMultiFilter(btn,S.tStateFilters,'#task-state-filters',['visible','hidden']);S.tPage=1;renderAdminTasks();}

export function toggleMultiFilter(btn,filterSet,containerId,allVals){
  const val=btn.dataset.val;
  const btns=document.querySelectorAll(`${containerId} .filter-btn`);
  if(val==='all'){
    filterSet.clear();
    btns.forEach(b=>b.classList.toggle('active',b.dataset.val==='all'));
  }else{
    if(filterSet.has(val))filterSet.delete(val);else filterSet.add(val);
    if(filterSet.size===0||filterSet.size===allVals.length){
      filterSet.clear();
      btns.forEach(b=>b.classList.toggle('active',b.dataset.val==='all'));
    }else{
      btns.forEach(b=>{
        if(b.dataset.val==='all')b.classList.remove('active');
        else b.classList.toggle('active',filterSet.has(b.dataset.val));
      });
    }
  }
}

export function sortAdminTasks(col){
  if(S.tSortCol===col)S.tSortAsc=!S.tSortAsc;else{S.tSortCol=col;S.tSortAsc=true;}
  S.tPage=1;renderAdminTasks();
}

// Stage B — the pane is the QUESTION BANK on its own page and the event's own
// QUESTIONS inside a workspace (the same pane; its title and doors say which).
function _syncBankChrome(){
  const inWs=!!S.adminSelectedCompetitionId;
  const h=document.getElementById('tasks-pane-title');
  if(h)h.textContent=inWs?'Questions':'Question bank';
  // Topics are managed on the bank's own page.
  const tb=document.getElementById('task-topics-btn');
  if(tb)tb.style.display=(!inWs&&adminCan('challenges.view'))?'':'none';
}
export async function loadAdminTasks(){
  // RBAC — a role that may not read the challenge library sends no read (every
  // refusal toasts and counts towards the address's scanner block).
  if(!adminCan('challenges.view'))return 'failed';
  showSkeletonRows('admin-task-body',5);
  const mySeq=++S._taskFetchSeq;                     // ext-audit v7.15.13 — see _subFetchSeq
  // Stage B — the topics are read beside the questions (a failed read leaves the
  // last good list; the filter and picker then offer what they hold).
  const [_tasks]=await Promise.all([_loadAdminTaskList(),loadTopics()]);
  // v8.12.2 (second review) — the OUTCOME is returned ('landed' | 'superseded' |
  // 'failed'), because two callers act on the model right after awaiting this
  // and must not act on a stale one: a superseded load leaves the PREVIOUS rows
  // in place, and a failed one resets them to []. Every other caller ignores it.
  if(mySeq!==S._taskFetchSeq)return 'superseded';    // a newer load already landed
  // v7.23.0 — a failed load must not leave the skeletons shimmering for ever.
  // The old form was `.then(r=>r.json()).catch(()=>[])`: on a 500 the error body
  // parses to `{error:...}`, `S.adminTasksData` became a NON-ARRAY, and the
  // render threw "S.adminTasksData is not iterable" — so the 5 skeleton rows
  // animated indefinitely with no toast, and this tab has no poll to self-heal
  // (Logs does, which is why it looked less broken). Same defect v7.15.14 fixed
  // for the participant grid.
  //
  // The model slot keeps its ARRAY TYPE on failure — a message-only fix would
  // leave every downstream `.filter` / spread throwing. The Retry affordance
  // belongs with the shared renderLoadFailure() helper (audit Wave 5); this
  // keeps the surface honest and non-throwing until then.
  if(!_tasks){
    // v8.11.11 — through the SHARED helper, with a retry. This pane does not
    // poll (measured: 1 request at entry, 1 after 20 s), so the failure was
    // terminal; and it was the only surface in the app that asked for a whole
    // PAGE RELOAD, which throws away every other pane's state to recover one.
    S.selectedChallenges.clear();
    renderLoadFailure('admin-task-body',{colspan:colspanFor('admin-task-body'),
      noun:'challenges',retryAction:'retry-load-admin-tasks',
      resetModel:()=>{S.adminTasksData=[];}});
    showToast('Could not load the challenge list. Please try again.','error');
    return 'failed';
  }
  S.adminTasksData=_tasks;
  // The event workspace's Overview lists the open event's challenges from this model.
  document.dispatchEvent(new CustomEvent('admin:model-loaded',{detail:'tasks'}));
  S.selectedChallenges.clear(); // v7.12.0 — a data reload drops any stale bulk selection
  // RBAC — each control asks the permission its route enforces.
  document.getElementById('new-task-btn-row').style.display=S.isAdmin?'flex':'none';
  { const nb=document.querySelector('#new-task-btn-row [data-action="open-task-form"]'); if(nb)nb.style.display=adminCan('challenges.edit')?'':'none'; }
  document.getElementById('import-tasks-btn').style.display=adminCan('data.import')?'':'none';
  const exportTasksBtn=document.getElementById('export-tasks-btn');
  if(exportTasksBtn){
    exportTasksBtn.textContent=S.adminSelectedCompetitionId?'Export ('+esc(S.adminSelectedCompetitionName)+')':'Export';
    exportTasksBtn.style.display=adminCan('export.data')?'':'none';
  }
  const addTasksBtn=document.getElementById('add-tasks-to-comp-btn');
  const comp=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
  const compStatus=comp?computeCompStatus(comp):null;
  if(comp&&compStatus!=='ended'&&adminCan('challenges.assign')){
    addTasksBtn.style.display='';
    addTasksBtn.textContent='+ Add from bank';
  }else{
    addTasksBtn.style.display='none';
  }
  _syncBankChrome();
  renderTopicFilter();
  renderAdminTasks();
  return 'landed';
}

// v8.12.2 (second review) — load until a load of OURS lands. A caller that acts
// on the model the moment this returns (the reveal re-entering the editor, the
// post-regenerate refresh) must not act on the stale rows a superseded load
// leaves behind — the newer load that superseded it lands later and does not
// touch the editor. Bounded: three tries, then the caller treats it as not landed.
async function _loadAdminTasksSettled(){
  for(let i=0;i<3;i++){
    const r=await loadAdminTasks();
    if(r!=='superseded')return r;
  }
  return 'superseded';
}

// The Question bank stays QUIET (stage B): a row shows its topic, never its
// tags, and at most two of the events holding it (the open event first). The
// rest sit behind a "+N" that expands the cell in place, so nothing becomes
// unreachable. Assignment itself is managed from an event's workspace (its
// Questions section), not by reading chips here.
export const EVENT_CELL_SHOWN=2;
function _moreChipsBtn(n,noun,title){
  if(n<=0)return'';
  return ` <button type="button" class="chip-more" data-action="cell-chips-toggle" aria-expanded="false" aria-label="+${n} more ${noun}${n===1?'':'s'} on ${esc(title)}">+${n}</button>`;
}
export function toggleCellChips(btn){
  const box=btn&&btn.closest('.cell-chips');
  if(!box)return;
  const open=box.classList.toggle('expanded');
  btn.setAttribute('aria-expanded',open?'true':'false');
  const n=box.querySelectorAll('.chip-overflow').length;
  btn.textContent=open?'Less':`+${n}`;
}

// The rows this list shows (ui/task-search.js): the library outside an event;
// inside one, the event's own questions and the bank questions it holds no copy of.
function _listedTasks(){
  const all=Array.isArray(S.adminTasksData)?S.adminTasksData:[];
  return S.adminSelectedCompetitionId?workspaceTasks(all,S.adminSelectedCompetitionId):bankTasks(all);
}
export function renderAdminTasks(){
  let tasks=_listedTasks();
  // RBAC — a row is selected only to assign it (`challenges.assign`): a role
  // that may not gets no checkboxes and no Select all.
  const _canSelect=adminCan('challenges.assign');
  { const sa=document.getElementById('select-all-challenges'); const lb=sa&&sa.closest('label'); if(lb)lb.style.display=_canSelect?'':'none'; }
  // Search
  const q=(document.getElementById('task-search')?.value||'').toLowerCase().trim();
  if(q)tasks=tasks.filter(t=>taskMatchesQuery(t,q,x=>[x.answer_type,x.status,x.changed_by,x.author_name,...(x.competitions||[]).map(c=>c.name)]));
  // Difficulty filter
  if(S.tDiffFilters.size>0)tasks=tasks.filter(t=>S.tDiffFilters.has(t.difficulty));
  // Status filter (published/draft)
  if(S.tStatusFilters.size>0)tasks=tasks.filter(t=>S.tStatusFilters.has(t.status));
  // State filter (visible/hidden)
  if(S.tStateFilters.size>0)tasks=tasks.filter(t=>{const s=t.active?'visible':'hidden';return S.tStateFilters.has(s);});
  // Stage B — the Topic filter (features/topics-admin.js).
  if(S.tTopicFilter)tasks=tasks.filter(taskInTopicFilter);
  // v8.17.0 — the heading filters (ui/table-columns.js), over the whole library, before paging.
  tasks=applyColumnFilters('challenges',tasks);
  // Sort
  const diffOrder={easy:0,medium:1,hard:2};
  const colSort=(a,b)=>{
    let va,vb;
    switch(S.tSortCol){
      case 'title':va=a.title.toLowerCase();vb=b.title.toLowerCase();break;
      case 'difficulty':va=diffOrder[a.difficulty]??1;vb=diffOrder[b.difficulty]??1;return S.tSortAsc?va-vb:vb-va;
      case 'type':va=a.answer_type;vb=b.answer_type;break;
      case 'status':va=(a.status==='draft'?0:a.active?2:1);vb=(b.status==='draft'?0:b.active?2:1);return S.tSortAsc?va-vb:vb-va;
      // v6.13.10 — Attachments column sorts by count ascending/descending;
      // title as natural secondary tiebreak via the outer localeCompare.
      case 'attachments':va=a.attachment_count||0;vb=b.attachment_count||0;return S.tSortAsc?va-vb:vb-va;
      case 'feedback':va=a.avg_rating??-1;vb=b.avg_rating??-1;return S.tSortAsc?va-vb:vb-va;
      case 'last_changed':va=a.last_changed||'';vb=b.last_changed||'';break;
      case 'changed_by':va=(a.changed_by||'').toLowerCase();vb=(b.changed_by||'').toLowerCase();break;
      case 'author':va=(a.author_name||'').toLowerCase();vb=(b.author_name||'').toLowerCase();break;
      default:va=a.title.toLowerCase();vb=b.title.toLowerCase();
    }
    return S.tSortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
  };
  // v6.10.12: when a competition is focused, assigned challenges
  // float to the top of the list — matches the participants-members-
  // first grouping at renderParticipants(). The column sort becomes
  // the tiebreaker within each group.
  if(S.adminSelectedCompetitionId){
    const inScope=t=>(t.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId)?0:1;
    tasks.sort((a,b)=>{const g=inScope(a)-inScope(b);return g!==0?g:colSort(a,b);});
  }else{
    tasks.sort(colSort);
  }
  // A heading with no sort of its own (Tags, Events) sorts through the column
  // component; the focused event's own challenges still come first.
  if(columnSortActive('challenges')){
    tasks=applyColumnSort('challenges',tasks);
    if(S.adminSelectedCompetitionId){const inScope=t=>(t.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId)?0:1;tasks.sort((a,b)=>inScope(a)-inScope(b));}
  }
  // Sort icons
  document.querySelectorAll('[id^="tsort-"][id$="-icon"]').forEach(el=>el.textContent='');
  if(S.tSortCol){const ic=document.getElementById(`tsort-${S.tSortCol}-icon`);if(ic)ic.textContent=S.tSortAsc?' ▲':' ▼';_syncSortAria(ic,S.tSortAsc);/* audit v7.7.33 (AL10) */}

  // Pagination
  const totalFiltered=tasks.length;
  const totalPages=Math.max(1,Math.ceil(totalFiltered/S.tPageSize));
  if(S.tPage>totalPages)S.tPage=totalPages;
  const startIdx=(S.tPage-1)*S.tPageSize;
  const pageData=tasks.slice(startIdx,startIdx+S.tPageSize);

  if(!pageData.length){
    // v8.8.4 — A FOCUSED EVENT IS NOT A FILTER, and counting it as one sent the
    // operator hunting for a control that is not set. Focusing SORTS the list and
    // dims what the event does not hold (:441, :579); it removes no rows, so an
    // empty page under a focus is an empty visible set, which "No challenges yet."
    // says truthfully. The render already disagreed with itself about this — the
    // list-count call below deliberately does not treat a focus as narrowing.
    // Reachable whenever the actor's whole visible set is empty, which for a
    // zero-grant event admin is the ordinary state.
    const hasFilter=q||S.tDiffFilters.size>0||S.tStatusFilters.size>0||S.tStateFilters.size>0||!!S.tTopicFilter||hasColumnFilters('challenges');
    const taskEmptyMsg=hasFilter
      ?(S.tTopicFilter&&!q&&!S.tDiffFilters.size&&!S.tStatusFilters.size&&!S.tStateFilters.size&&!hasColumnFilters('challenges')
        ?(S.tTopicFilter===NO_TOPIC?'Every question here has a topic.':`No questions in the topic “${esc(topicName(S.tTopicFilter))}” yet.`)
        :'No challenges match the current filters.')
      :'No challenges yet.';
    setSafeHtml(document.getElementById('admin-task-body'),`<tr><td colspan="13" class="table-empty-row">${taskEmptyMsg}</td></tr>`);
  }else setSafeHtml(document.getElementById('admin-task-body'), pageData.map(t=>{
    const hidden=!t.active;
    const isDraft=t.status==='draft';
    // v7.12.1 — a challenge already in the FOCUSED competition carries no checkbox
    // (nothing to add), mirroring the participants pane hiding it for enrolled members.
    const isInSelectedComp=S.adminSelectedCompetitionId&&(t.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId);
    const statusBadge=isDraft
      ?'<span class="badge draft">Draft</span>'
      :(hidden?'<span class="badge hidden">Hidden</span>'
      :'<span class="badge published">Published</span>');
    // v8.8.4 — THE SHARED-POOL ARM GETS A SIGNAL THAT DOES NOT NEED HORIZONTAL
    // SCROLLING. Nothing on the row said a challenge was visible through the
    // public-domain arm rather than through an event the actor runs, and the one
    // available cue — the literal tag chip — is column 11 of 13 on a table forced
    // to min-width:1372px, so at every ordinary admin viewport it sits behind
    // hundreds of pixels of scroll INSIDE the table card. An event admin therefore
    // could not tell "not shown" from "shown, and I did not recognise it", which is
    // the exact ambiguity the v8.8.2/v8.8.3 report turned on.
    //
    // Status is column 5 and is already the badge column, so it costs no width and
    // needs no new decision about where a reader looks. Tokens are v8.8.0's
    // MEASURED purple pair (--accent2 on --accent-soft dark; --badge-purple-fg on
    // --purple-pill light, 7.47:1 / 6.57:1) rather than a fresh colour.
    const sharedBadge=(t.tags||[]).includes(PUBLIC_DOMAIN_TAG)
      ?'<span class="badge shared-pool" title="In the shared pool — every event organiser on the platform can use this challenge in their own events.">Shared</span>'
      :'';
    // v8.10.0 — the SEALED badge, in the same column and for the same reason
    // v8.8.4 put "Shared" there: an operator deciding whether it is safe to touch
    // a challenge must be able to see the answer is not theirs to read, and the
    // Tags column (11 of 13, behind hundreds of pixels of in-card scroll at every
    // ordinary admin viewport) is not a place anyone would find it.
    //
    // The badge renders for EVERYONE who can see the row, the author included —
    // its job is to say "this challenge has a sealed answer", which is a fact
    // about the challenge, not about the reader. The two states are told apart by
    // the tooltip, which is the only place the difference is actionable.
    // v8.12.2 — three states, not two: withheld (a non-author, or a superadmin
    // who has not revealed it), revealed (a superadmin who has — the key is
    // theirs by that recorded act, not by authorship, so the copy must not tell
    // them they wrote it), and the author's own. `answer_revealed` is the
    // server's answer; the client never re-derives who is who.
    const sealedBadge=t.answer_sealed
      ?`<span class="badge sealed-answer" title="${t.can_see_answer===false
          ?(t.can_reveal_answer?'Sealed answer and hint — only the person who created this challenge can see them. As a superadmin you can reveal them; the reveal is recorded in the challenge\'s history.':'Sealed answer and hint — only the person who created this challenge, or a superadmin who reveals them on the record, can see them or edit this challenge.')
          :(t.answer_revealed?'Sealed answer and hint — revealed to you as a superadmin; the reveal is recorded in the challenge\'s history.':'Sealed answer and hint — you created this challenge, so only you (or a superadmin who reveals them on the record) can see them or edit it.')}">${ICO.lock} Sealed</span>`
      :'';

    // Competition badges — highlight the selected competition, show task_number if assigned.
    // Test / dry-run competitions get a yellow underline + hover text.
    // v7.8.0 — show only live/upcoming comps (hide ENDED/past ones) so the column
    // stays focused on what's actionable, mirroring the Participants view (v6.20.5).
    // The currently-scoped competition is kept even if ended, so its badge (with the
    // selected-comp highlight) still renders when an admin views an ended comp.
    // v8.8.0 — an event in its LATE-ENTRY window is kept too. It has ended, so the
    // pre-v8.8.0 filter dropped it — but it is still joinable and still accepting
    // submissions from late entrants, which is exactly the "what's actionable"
    // test this filter was written for.
    const _evShown=(t.competitions||[]).filter(c=>{
      const cat=compDisplayCategory(c);
      return cat==='live'||cat==='upcoming'||cat==='late-entry'||c.id===S.adminSelectedCompetitionId;
    }).sort((a,b)=>(b.id===S.adminSelectedCompetitionId)-(a.id===S.adminSelectedCompetitionId));
    const compBadges=_evShown.map((c,_i)=>{
      const cat=compDisplayCategory(c);
      const cls='comp-'+cat;
      const fullComp=S.adminCompetitionsData.find(x=>x.id===c.id);
      const cIsInt=fullComp&&(fullComp.tags||[]).includes(DRY_RUN_TAG);
      const tip=COMP_CATEGORY_LABEL[cat]||'Ended';
      const intTip=cIsInt?` (${DRY_RUN_TAG})`:'';
      const isCurrent=S.adminSelectedCompetitionId&&c.id===S.adminSelectedCompetitionId;
      const extra=isCurrent?'outline:2px solid var(--focus);outline-offset:1px;font-weight:var(--fw-semibold)':'';
      const intStyle=cIsInt?'border-bottom:2px solid var(--yellow);':'';
      const numLabel=c.task_number?` #${esc(c.task_number)}`:'';
      return`<span class="badge comp-badge ${cls}${_i>=EVENT_CELL_SHOWN?' chip-overflow':''}" title="${tip}${intTip}" style="cursor:pointer;${extra}${intStyle}" data-action="comp-focus" role="button" tabindex="0" aria-label="${esc(c.name)}${numLabel} — open this event" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">${esc(c.name)}${numLabel}</span>`;
    }).join(' ')+_moreChipsBtn(_evShown.length-EVENT_CELL_SHOWN,'event',t.title);
    // v8.8.8 — SAY THAT SOMETHING WAS WITHHELD, without naming it. The projection
    // is scoped now, so a challenge an event admin created and a colleague uses
    // renders no badges at all — and "None" would be a wrong answer about a
    // challenge that is in use, on the column an operator reads to decide whether
    // it is safe to touch. The chip carries no id and no focus affordance,
    // because there is nothing here this actor may open (the v7.14.2 rule: never
    // offer a control the server is certain to refuse).
    const withheldChip=t.withheld_competition_count
      ?`<span class="badge comp-badge comp-withheld" title="In ${t.withheld_competition_count} event(s) you do not organise${t.withheld_live?', one of them live':''}">+${t.withheld_competition_count} elsewhere</span>`
      :'';
    const compBadgesHtml=[compBadges,withheldChip].filter(Boolean).join(' ')
      ||'<span class="cell-empty" style="font-size:var(--fs-12)">None</span>';

    // Kebab menu items — all actions available here
    const _selComp=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
    const _selStatus=_selComp?computeCompStatus(_selComp):null;
    const _compActive=_selStatus==='live'||_selStatus==='upcoming';
    let kebabActions='';
    // Is this task assigned to any LIVE competition? Determines elevated/danger tier for Edit, Hide, Remove
    // v8.8.8 — `withheld_live` counts too: the danger tier is about what an edit
    // LANDS ON, and a live event this actor cannot see is still live.
    const taskInLive=(t.competitions||[]).some(c=>c.status==='live')||!!t.withheld_live;
    const scopedIsLive=_selStatus==='live';
    // Edit task: elevated (warning) normally, danger if in live comp
    const editCls=taskInLive?'km-danger':'km-warning';
    const hideCls=taskInLive?'km-danger':'km-warning';
    const removeCls=scopedIsLive?'km-danger':'km-warning';
    // View as Participant — benign, always available, shown first
    kebabActions+=`<button data-action="task-view" data-task-id="${esc(t.id)}">${ICO.eye} View as Participant</button>`;
    // v8.7.0 — OWNERSHIP, from the server's own answer. `can_edit` is absent on
    // every payload predating this release and for every unscoped actor, so
    // `!== false` keeps admin / superadmin exactly as they were rather than
    // hiding everything on a stale response. Editing, publishing and hiding are
    // owner-only for an event admin; the server refuses each independently.
    const _mayEdit=t.can_edit!==false;
    // v8.12.0 — THE ACTOR COMPETES IN AN EVENT HOLDING THIS CHALLENGE. The
    // server collapses every edit flag for the row (`competing_in` names the
    // events) and refuses every write door on it, whatever the tier — so the
    // menu withholds every mutating item with THIS reason, ahead of the seal and
    // the ownership notes below, which would otherwise explain a superadmin's
    // refusal with a rule that does not bind them (the v8.10.1 lesson).
    const _competingIn=Array.isArray(t.competing_in)?t.competing_in:[];
    const _competes=_competingIn.length>0;
    // Withheld WITH its reason (v7.14.2): a menu that silently loses three items
    // is indistinguishable from a broken feature, and was reported as one.
    // v8.10.1 — A SEALED CHALLENGE NEEDS ITS OWN REASON, not this one. The seal
    // collapses `can_edit` for every tier, so without the branch a SUPERADMIN —
    // who can ordinarily edit anybody's challenge — is told "created by someone
    // else", which is true of the row and false as an explanation: it names a
    // rule that does not bind them and hides the one that does. The v8.8.5
    // scoring-note precedent, one flag over.
    //
    // v8.12.2 — THE SEAL IS THE REASON ONLY WHILE IT STILL BINDS THIS READER
    // (`can_see_answer === false`). After a reveal the seal no longer binds, yet
    // `can_edit` may stay false — inside an organiser's seat the SEAT's
    // owner-only rule applies — and the first draft kept blaming the seal there:
    // a rule that no longer binds, standing in for the one that does (the v8.10.1
    // wrong-reason class, found by the pre-release review). And the pre-reveal
    // note promises "and to change this challenge" only outside a seat: in an
    // organiser's panel the reveal lifts the seal, not the ownership rule.
    const _sealBinds=!!t.answer_sealed&&t.can_see_answer===false;
    const _notMineNote=_mayEdit
      ? ''
      : (_competes
          ? `<div class="kebab-note">${ICO.lock} You are competing in ${esc(_competingIn.map(c=>`“${c.name}”`).join(', '))}, which holds this challenge — you can view it, not change it</div>`
          : _sealBinds
          ? (t.can_reveal_answer
              ? `<div class="kebab-note">Its answer is sealed — reveal it below to see the answer and hint${S.isEventAdmin?'':' and to change this challenge'}; the reveal is recorded</div>`
              : `<div class="kebab-note">Its answer is sealed — only the person who created it, or a superadmin who reveals it on the record, can change this challenge</div>`)
          : `<div class="kebab-note">Created by someone else — you can use it, not change it</div>`);
    // v8.8.5 — THE STRICT GATE HAD NO CLIENT CONSUMER. v8.7.0 computes
    // `can_edit_scoring` expressly so the client never offers a scoring control
    // the server will refuse, with a comment saying "THE ANSWER, NOT THE RULE" —
    // and nothing in public/js read it, so Publish and Hide/Show were gated on
    // the WEAKER `can_edit` while the server applies the strict gate to those
    // exact doors. The reachable shape: an event admin OWNS a challenge and a
    // global admin has also put it in an event they do not run, which is the case
    // `taskScoringEditDenied` exists for. `status` and `active` are scoring
    // fields because they move the all-solved denominator for every event holding
    // the challenge — so hiding it is somebody else's scoring change.
    const _mayEditScoring=t.can_edit_scoring!==false;
    // RBAC — and only for a role holding the permission each door's route asks
    // (`challenges.edit`, `challenges.assign`); a role without one never sees it.
    const _permEdit=adminCan('challenges.edit');
    const _permAssign=adminCan('challenges.assign');
    // Its own reason, not _notMineNote's: this actor may well OWN the challenge.
    const _scoringNote=(_mayEdit&&!_mayEditScoring)
      ? `<div class="kebab-note">Another organiser's event is scoring on this challenge — only an administrator can publish or hide it</div>`
      : '';
    if(isDraft){
      // v6.16.17 — Publish kebab gated on lock state. v6.16.14 added
      // the server-side lock guard (regular admin gets 403 on a locked
      // draft). Sibling kebab entries (Lock/Unlock, Recalculate Scores,
      // Delete) are also superadmin-only — Publish was the residual
      // asymmetry. Hide the entry for regular admins on locked drafts
      // so the operator UX matches what the server allows.
      if((!t.locked||S.isSuperAdmin)&&_mayEdit&&_mayEditScoring&&_permEdit){
        kebabActions+=`<button data-action="task-publish" data-task-id="${esc(t.id)}">${ICO.send} Publish</button>`;
      }
    }else{
      if(_mayEdit&&_mayEditScoring&&_permEdit){
        if(hidden){
          kebabActions+=`<button data-action="task-toggle-visibility" data-task-id="${esc(t.id)}">${ICO.eye} Show</button>`;
        }else{
          kebabActions+=`<button class="${hideCls}" data-action="task-toggle-visibility" data-task-id="${esc(t.id)}">${ICO.eyeOff} Hide</button>`;
        }
      }
      // Its dialog lists the events to assign to (`events.view`).
      if(_permAssign&&adminCan('events.view'))kebabActions+=`<button data-action="task-assign-to-comps" data-task-id="${esc(t.id)}">${ICO.target} Assign to Events</button>`;
    }
    // v8.7.0 — `can_unassign` is PER COMPETITION, because "may I take this out of
    // THAT event" depends on who put it there: an event admin may remove only
    // assignments they made themselves. Absent (an older payload, or an unscoped
    // actor) means yes, so nothing changes for admin / superadmin.
    const _selEntry=(t.competitions||[]).find(c=>c.id===S.adminSelectedCompetitionId);
    const assignedToSelectedComp=!!(S.adminSelectedCompetitionId&&_selEntry);
    const _mayUnassign=!_selEntry||_selEntry.can_unassign!==false;
    if(S.adminSelectedCompetitionId&&_selStatus!=='ended'&&assignedToSelectedComp&&_mayUnassign&&_permAssign){
      kebabActions+=`<button class="${removeCls}" data-action="task-remove-from-comp" data-task-id="${esc(t.id)}" data-comp-id="${esc(S.adminSelectedCompetitionId)}">${ICO.userMinus} Remove from Event</button>`;
    }
    // v8.1.4 — GRANT ATTEMPTS. Three copies of shipped copy — the exhausted
    // panel's "Ask an organiser if you need another try", the exhausted-refusal
    // toast, and the competition form's own hint — promised a remedy that existed
    // ONLY as a raw endpoint: `POST /api/admin/tasks/:id/attempt-grant` had no
    // client caller anywhere. An organiser at a desk, sent there by the
    // participant's own screen, had no screen to help from — and the endpoint's
    // own comment says "a control they cannot reach is no control at all".
    //
    // Offered only where the server can honour it: the challenge must be assigned
    // to at least one non-ended event that carries a cap, resolved with the same
    // most-specific-wins chain `lib/attempts.js` uses. An UNKNOWN event cap is NOT
    // treated as absent — see `_taskMayHaveCap`.
    // RBAC — the grant is a `challenges.edit` route, and its dialog first reads
    // the events (`events.view`) and then each event's participants
    // (`participants.view`): a role missing either list is not offered the door.
    if(_taskMayHaveCap(t)&&_permEdit&&adminCan('events.view')&&adminCan('participants.view')){
      kebabActions+=`<button data-action="task-attempt-grant" data-task-id="${esc(t.id)}">${ICO.key} Grant Attempts</button>`;
    }
    kebabActions+=`<button data-action="task-history" data-task-id="${esc(t.id)}">${ICO.clock} History</button>`;
    if(!t.locked&&_mayEdit&&_permEdit)kebabActions+=`<button class="${editCls}" data-action="task-edit" data-task-id="${esc(t.id)}">${ICO.edit} Edit</button>`;
    // Stage B — SAVE TO BANK, on this event's own question: a NEW bank question
    // copied from it (routes/challenges.js). Offered where the route accepts it:
    // not a quick question, not while competing, and only with the key readable.
    if(t.owner_competition_id&&t.owner_competition_id===S.adminSelectedCompetitionId&&_permEdit&&!_competes&&!isQualifyingTask(t)&&t.can_see_answer!==false){
      kebabActions+=`<button data-action="task-save-to-bank" data-task-id="${esc(t.id)}">${ICO.save} Save to bank</button>`;
    }
    kebabActions+=_notMineNote;
    kebabActions+=_scoringNote;
    // v8.12.2 — THE REVEAL, offered exactly where the server would accept it:
    // `can_reveal_answer` is computed there from the ACTING human's live tier
    // (a superadmin in an organiser's impersonated panel gets it; `S.isSuperAdmin`
    // is false in that shape by construction, which is why this item does not
    // key on it like the three below).
    if(t.can_reveal_answer)kebabActions+=`<button class="km-warning" data-action="task-reveal-sealed" data-task-id="${esc(t.id)}">${ICO.unlock} Reveal sealed answer</button>`;
    // RBAC — Lock and Recalculate need `challenges.lock`, Delete
    // `challenges.delete`: superadmin-only permissions a custom role may hold.
    if(adminCan('challenges.lock')&&!_competes){
      kebabActions+=`<button data-action="task-toggle-lock" data-task-id="${esc(t.id)}">${t.locked?ICO.unlock+' Unlock':ICO.lock+' Lock'}</button>`;
      // v8.12.2 — gated on the server's `can_edit` too: the recalculate route
      // takes `sealedEditDenied`, so on a sealed challenge the item is offered
      // only to the author or to a superadmin who has revealed it (a
      // pre-existing affordance-that-lies, found by the v8.12.2 read phase).
      if(!t.locked&&_mayEdit)kebabActions+=`<button class="km-warning" data-action="task-recalculate" data-task-id="${esc(t.id)}">${ICO.refresh} Recalculate Scores</button>`;
    }
    if(adminCan('challenges.delete')&&!_competes){
      kebabActions+=`<button class="km-danger" data-action="task-delete" data-task-id="${esc(t.id)}">${ICO.trash} Delete</button>`;
    }
    // Primary action: always "View as Participant" regardless of task state.
    // All state-dependent actions (Publish, Assign, Show, Hide, Edit, Delete, ...) live in the kebab menu.
    const primaryBtn=`<button class="btn sm secondary" data-action="task-view" data-task-id="${esc(t.id)}">${ICO.eye} View</button>`;

    const assignedToSelected=S.adminSelectedCompetitionId&&(t.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId);
    const dimRow=S.adminSelectedCompetitionId?(!assignedToSelected||isDraft||hidden):false;
    // v6.8.4: removed `opacity:.55` / `opacity:.6` for hidden / draft rows —
    // axe flagged them as colour-contrast failures (parent opacity flattens
    // onto the cell contrast). The state is already signalled by the "Draft"
    // / "Hidden" badges in the status column and — for drafts — the italic
    // font-style on the row. The stronger `opacity:.35` dim for "not assigned
    // to the selected competition" is kept because that cue has no badge
    // equivalent and only fires when an admin explicitly filters by comp.
    // v7.23.1 (audit Wave 3) — a CLASS, not opacity. v6.8.4 already removed the
    // .55/.6 dims here for exactly this reason ("parent opacity flattens onto the
    // cell contrast") and kept .35 for the not-assigned-to-the-focused-comp cue —
    // but .35 is the STRONGEST dim in the file, so it fails hardest. The cue is
    // preserved by muting the foreground, which cannot composite below the token.
    const contentOpacity=dimRow?'row-deemphasised':'';
    // When row is dimmed but competition is active, keep action buttons at full opacity
    const dimContentOnly=dimRow&&_compActive;
    const rowOpacity=dimContentOnly?'':contentOpacity;
    const cellDim=dimContentOnly?'row-deemphasised':'';
    return `<tr class="${rowOpacity}" style="${isDraft?'font-style:italic':''}">
      <td class="cb-cell">${(isDraft||isInSelectedComp||!_canSelect)?'':`<input type="checkbox" value="${esc(t.id)}" ${S.selectedChallenges.has(t.id)?'checked':''} data-change-action="challenge-select-toggle" aria-label="Select challenge ${esc(t.title)}"/>`}</td>
      <td class="${cellDim}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.locked?`<span class="task-lock-icon" title="Locked">${ICO.lock}</span>`:''}${esc(t.title)}</td>
      <td class="${cellDim}"><span class="badge ${esc(t.difficulty)}">${esc(t.difficulty)}</span></td>
      <td class="${cellDim}">${esc(t.answer_type)}</td>
      <td class="${cellDim}">${statusBadge}${sharedBadge}${sealedBadge}</td>
      <td class="cell-ts ${cellDim}" data-col="attachments">${(t.attachment_count||0)>0?`<span class="task-attach-count" title="${t.attachment_count} attachment${t.attachment_count===1?'':'s'}">${ICO.paperclip}<span>${t.attachment_count}</span></span>`:'<span class="cell-empty">&mdash;</span>'}</td>
      <td class="cell-ts ${cellDim}">${t.avg_rating!=null?`${Number(t.avg_rating).toFixed(1)} <span style="color:var(--yellow)">&#9733;</span> <span style="color:var(--muted);font-size:var(--fs-12)">(${t.feedback_count})</span>`:'<span class="cell-empty">&mdash;</span>'}</td>
      <td class="cell-ts ${cellDim}">${fmtDt(t.last_changed)}</td>
      <td class="cell-ts ${cellDim}">${esc(t.changed_by||'—')}</td>
      <td class="cell-ts ${cellDim}">${esc(t.author_name||'—')}</td>
      <td class="${cellDim}" data-col="topic">${t.topic_name?`<span class="topic-chip">${esc(t.topic_name)}</span>`:'<span class="cell-empty">&mdash;</span>'}</td>
      <td class="${cellDim}" style="white-space:normal;min-width:160px"><div class="cell-chips">${compBadgesHtml}</div></td>
      <td><div class="action-cell task-actions" style="gap:4px">${primaryBtn}</div>
        <button class="kebab-btn kebab-always" aria-label="More actions" data-action="kebab-toggle">⋮</button>
        <div class="kebab-menu">${kebabActions}</div>
      </td>
    </tr>`;
  }).join(''));

  // Pagination controls
  const pagDiv=document.getElementById('tasks-pagination');
  // v7.20.11 — the three chip groups narrow the list too, so they count as
  // "filtered"; otherwise the count reports the whole table over a chip-narrowed
  // handful of rows.
  setListCount('task-search',{matched:totalFiltered,total:_listedTasks().length,filtered:!!q||!!(S.tDiffFilters&&S.tDiffFilters.size)||!!(S.tStatusFilters&&S.tStatusFilters.size)||!!(S.tStateFilters&&S.tStateFilters.size)||!!S.tTopicFilter||hasColumnFilters('challenges'),queried:!!q||hasColumnFilters('challenges')});
  if(pagDiv)setSafeHtml(pagDiv, paginationHtml('tasks', {page:S.tPage,totalPages,totalLabel:`${totalFiltered} total`,pageSize:S.tPageSize}));

  // v7.12.0 — keep the bulk-assign selection bar + the select-all checkbox in sync
  // with the freshly-rendered page (the selection Set survives re-sort/filter/paging).
  updateChallengeSelectionBar();
}

// ── v7.12.0 — bulk assign challenges to competitions (mirrors the participants pane) ──

export function toggleAllChallenges(checked){
  // Only PUBLISHED challenges carry a checkbox (drafts can't be assigned), so
  // select-all only touches the boxes actually present on the current page.
  document.querySelectorAll('#admin-task-body input[type="checkbox"]').forEach(cb=>{
    cb.checked=checked;
    if(checked)S.selectedChallenges.add(cb.value);
    else S.selectedChallenges.delete(cb.value);
  });
  updateChallengeSelectionBar();
}

export function toggleChallengeSelection(id,checked){
  if(checked)S.selectedChallenges.add(id);
  else S.selectedChallenges.delete(id);
  updateChallengeSelectionBar();
}

export function updateChallengeSelectionBar(){
  const bar=document.getElementById('challenges-selection-bar');
  if(!bar)return;
  const count=S.selectedChallenges.size;
  const comp=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
  // v8.12.0 — a competitor may not add challenges to the event they compete in.
  const directAdd=comp&&computeCompStatus(comp)!=='ended'&&!comp.competing;
  const label=directAdd?`Assign to "${comp.name}"`:'Assign to Events'; // v7.12.1 — match the participants wording
  const barBtn=document.getElementById('challenge-selection-bar-assign-btn');
  const topBtn=document.getElementById('assign-challenges-to-comp-btn'); // v7.12.1 — top button (mirrors participants)
  const countEl=document.getElementById('challenge-selection-count');
  if(count>0){
    bar.style.display='flex';
    // audit v7.12.3 (#12) — pad the page while the FIXED mobile bar is shown so
    // bottom-of-page focusables aren't trapped under it (see styles.css).
    document.body.classList.add('selection-bar-open');
    if(countEl)countEl.textContent=count+' selected';
    // RBAC — assigning is `challenges.assign`; outside an event its dialog also
    // reads the event list (`events.view`).
    const canAssign=adminCan('challenges.assign')&&(!!directAdd||adminCan('events.view'));
    if(barBtn){barBtn.textContent=label;barBtn.style.display=canAssign?'':'none';}
    if(topBtn){topBtn.style.display=canAssign?'':'none';topBtn.textContent=label;}
  }else{
    bar.style.display='none';
    document.body.classList.remove('selection-bar-open');
    if(topBtn)topBtn.style.display='none';
  }
  // v7.12.2 — the "+ Add Challenges" picker button and the bulk "Assign to <comp>"
  // button both add to the focused competition; never show BOTH (the participants
  // pane shows only one). So the picker button appears ONLY when a comp is focused
  // AND nothing is selected — the moment you tick a challenge it yields to the bulk
  // button, and returns when you clear the selection.
  const addBtn=document.getElementById('add-tasks-to-comp-btn');
  if(addBtn)addBtn.style.display=(directAdd&&count===0&&adminCan('challenges.assign'))?'':'none';   // RBAC — `challenges.assign`
  // Reflect the current page's selection state on the select-all checkbox
  // (checked when every visible box is selected; indeterminate when partial).
  const boxes=[...document.querySelectorAll('#admin-task-body input[type="checkbox"]')];
  const selectAll=document.getElementById('select-all-challenges');
  if(selectAll){
    const checkedCount=boxes.filter(b=>b.checked).length;
    selectAll.checked=boxes.length>0&&checkedCount===boxes.length;
    selectAll.indeterminate=checkedCount>0&&checkedCount<boxes.length;
  }
}

// Entry point for the selection-bar button: direct-add when a competition is
// focused, otherwise open the competition picker.
export function challengesBulkAssign(){
  if(!S.selectedChallenges.size){showToast('Select challenges first.');return;}
  // v8.12.0 — ONE predicate for the label and the handler. The label already
  // read "Assign to Events" for a competitor (the focused event refuses them),
  // while this branch re-derived the direct-add decision without `competing`
  // and posted straight into the refusal — two copies of one rule, one drifted
  // (the v7.21.13 class; the participants twin derives both from one value).
  const comp=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
  const directAdd=!!(comp&&computeCompStatus(comp)!=='ended'&&!comp.competing);
  if(directAdd){
    quickAssignSelectedChallengesToCompetition();
  }else{
    openBulkAssignChallengesModal();
  }
}

async function _postBulkAssignChallenges(competitionIds){
  const res=await fetchWithLoading('/api/admin/tasks/assign-competitions',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({taskIds:Array.from(S.selectedChallenges),competitionIds})});
  if(!res)return;
  if(res.r.ok){
    const d=res.d;const sk=d.skipped||{};
    let msg=`${d.assigned||0} challenge-to-competition assignment(s) added.`;
    const skipBits=[];
    if(sk.draft)skipBits.push(`${sk.draft} draft`);
    if(sk.locked)skipBits.push(`${sk.locked} locked`);
    if(sk.endedComp)skipBits.push(`${sk.endedComp} ended event(s)`);
    if(sk.notFound)skipBits.push(`${sk.notFound} not found`);
    if(sk.missingComp)skipBits.push(`${sk.missingComp} missing event(s)`);
    // v8.8.5 — the server returns EIGHT skip reasons and this rendered five, so
    // three kinds of skip were reported as nothing at all. `outOfScope` is the
    // one that matters: a grant revoked (or the scope cache turning over) between
    // the picker loading its events and the POST landing puts EVERY target there,
    // and the toast then read "0 assigned" with no reason — the v7.21.2
    // counter-with-no-consumer defect, on the surface that has to explain itself.
    if(sk.outOfScope)skipBits.push(`${sk.outOfScope} event(s) you do not organise`);
    if(sk.notOwned)skipBits.push(`${sk.notOwned} challenge(s) you cannot use`);
    if(sk.unfit)skipBits.push(`${sk.unfit} unfit for the event`);
    // v8.12.0 — the two staff-compete seal skips, per (challenge, event) like
    // `unfit`; the refused PAIRS ride `refused` and are listed in a modal below.
    if(sk.unsealed)skipBits.push(`${sk.unsealed} not sealed (the event lets staff compete)`);
    if(sk.authorCompetes)skipBits.push(`${sk.authorCompetes} whose author competes in the event`);
    // Operator ruling N7 — an event asks each qualifying question once.
    if(sk.qualifyingHeld)skipBits.push(`${sk.qualifyingHeld} qualifying question(s) on a topic the event already asks`);
    // A question another event owns is never shared (lib/event-copies.js).
    if(sk.ownedElsewhere)skipBits.push(`${sk.ownedElsewhere} question(s) belonging to another event (add the bank question instead)`);
    if(skipBits.length)msg+=` Skipped: ${skipBits.join(', ')}.`;
    // The REASONS ride the response precisely so a refusal can be read rather
    // than counted (the server caps them at five). The single-assign path already
    // surfaces its named refusal; this one dropped them on the floor.
    if(Array.isArray(d.unfitReasons)&&d.unfitReasons.length)msg+=` ${d.unfitReasons.join(' ')}`;
    showToast(msg,(d.assigned||0)>0?'success':'');
    if(Array.isArray(d.refused)&&d.refused.length)showAssignmentRefusalModal(d.refused,d.refused_total);
    S.selectedChallenges.clear();
    loadAdminTasks();loadAdminCompetitions();
  }else{showToast(res.d.error||'Failed to assign challenges.','error');}
}

export async function quickAssignSelectedChallengesToCompetition(){
  if(!S.adminSelectedCompetitionId||!S.selectedChallenges.size)return;
  const comp=S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId);
  const count=S.selectedChallenges.size;
  const ok=await showModal({title:`Assign to ${comp?.name||'Event'}`,message:`Assign <strong>${count}</strong> selected challenge(s) to <strong>${esc(comp?.name||'')}</strong>?<br><br>Draft challenges, and challenges already assigned, are skipped.`,confirmText:'Assign'});
  if(!ok)return;
  await _postBulkAssignChallenges([S.adminSelectedCompetitionId]);
}

export async function openBulkAssignChallengesModal(){
  if(!S.selectedChallenges.size){showToast('Select challenges first.');return;}
  // v8.3.20 — REFUSE rather than open an empty picker. The old form never
  // checked `r.ok`, so a 500's error BODY parsed into an object and the
  // `.filter` below threw "comps.filter is not a function": the dialog never
  // opened and nothing was said. Where the parse DID fail it rendered `[]`,
  // i.e. "there are no competitions" — a confident wrong answer produced by a
  // request that failed.
  const comps=await fetchJsonList('/api/admin/competitions');
  if(!comps){showToast('Could not load events. Check your connection and try again.','error');return;}
  const nonEnded=comps.filter(c=>computeCompStatus(c)!=='ended').sort(compareCompsForPicker);
  const overlay=document.createElement('div');
  overlay.id='challenge-bulk-assign-overlay';
  overlay.className='picker-overlay';
  setSafeHtml(overlay, `<div class="picker-modal" role="dialog" aria-modal="true" aria-labelledby="challenge-bulk-assign-title">
    <div class="picker-modal-head"><h3 id="challenge-bulk-assign-title">Assign Challenges to Events</h3></div>
    <p class="picker-note">${S.selectedChallenges.size} challenge(s) selected. Choose the event(s) to assign them to (ended events are excluded):</p>
    ${nonEnded.length?`<div class="picker-rows" id="challenge-bulk-comp-list">
      ${nonEnded.map(c=>{
        const status=computeCompStatus(c);
        // v8.12.0 — an event the actor competes in refuses the whole batch (403 by
        // name), so it is not offered; an event where staff compete is offered
        // with a reminder that unsealed challenges will be skipped there.
        const competing=!!c.competing;
        return`<label class="picker-row${competing?' is-disabled':''}"${competing?' title="You are competing in this event — you cannot change its challenges."':''}>
          <input type="checkbox" value="${esc(c.id)}" class="picker-row-check" ${competing?'disabled':''}/>
          <span class="picker-row-body"><strong>${esc(c.name)}</strong> <span class="status-badge ${status}">${status}</span>${(c.tags||[]).includes(DRY_RUN_TAG)?` <span class="badge draft" title="Test / dry run event">${DRY_RUN_TAG}</span>`:''}${competing?'<span class="picker-row-flag">You compete here</span>':(c.staff_compete?'<span class="picker-row-flag" style="color:var(--muted)">Sealed challenges only</span>':'')}
          <span class="bulk-assign-row-meta">${fmtDt(c.start_time,'long')}</span></span>
        </label>`;
      }).join('')}
    </div>`:'<p class="picker-note">No active or upcoming events.</p>'}
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="challenge-bulk-assign-overlay">Cancel</button>
      <button class="btn" data-action="challenge-bulk-assign-execute" ${nonEnded.length?'':'disabled'}>Assign to Selected</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
}

export async function challengeBulkAssignExecute(){
  const ids=[...document.querySelectorAll('#challenge-bulk-comp-list input[type="checkbox"]:checked')].map(cb=>cb.value);
  if(!ids.length){showToast('Select at least one event.');return;}
  document.getElementById('challenge-bulk-assign-overlay')?.remove();
  await _postBulkAssignChallenges(ids);
}

export async function publishTask(id){
  const t=S.adminTasksData.find(x=>x.id===id);
  const ok=await showModal({title:'Publish Challenge',message:`Publishing <strong>${esc(t?.title||'')}</strong> is irreversible. The challenge will become available for assignment to events.<br><br>Continue?`,confirmText:'Publish',confirmClass:''});
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${id}/publish`,{method:'POST',headers:csrfHeaders()});
  if(r.ok){showToast('Challenge published.','success');loadAdminTasks();}
  else{const d=await r.json();showToast(d.error||'Failed.','error');}
}


// ── v7.19.0 — multiple-choice editor ────────────────────────────────────────
//
// The correct answer for a choice task is DERIVED from which rows are ticked,
// so the single "Correct Answer" input is swapped out entirely rather than left
// on screen holding a value nothing reads. S._tfChoices is the model; the DOM
// is a rendering of it, because a re-render (add/remove a row) must not lose
// what the author has typed into the other rows.
export function tfChoicesRender(){
  const list=document.getElementById('tf-choices-list');
  if(!list)return;
  const rows=S._tfChoices||[];
  setSafeHtml(list, rows.map((c,i)=>`
    <div class="choice-row" data-idx="${i}">
      <label class="choice-correct" title="Tick if this choice is correct">
        <input type="checkbox" data-change-action="task-choice-correct" data-idx="${i}" ${c.correct?'checked':''}
               aria-label="Choice ${i+1} is correct"/>
      </label>
      <input class="choice-text" type="text" value="${esc(c.text||'')}" maxlength="300"
             data-input-action="task-choice-text" data-idx="${i}"
             placeholder="Choice ${i+1}" aria-label="Choice ${i+1} text"/>
      <button type="button" class="btn sm danger choice-remove" data-action="task-choice-remove" data-idx="${i}"
              aria-label="Remove choice ${i+1}"${rows.length<=2?' disabled title="A multiple-choice challenge needs at least two choices"':''}>Remove</button>
    </div>`).join(''));
  const err=document.getElementById('tf-choices-err');
  if(err)err.textContent=tfChoicesError()||'';
  _tfSyncAddChoiceCap(rows.length);
}

// v8.13.0 — THE SERVER REFUSES A 21ST CHOICE (lib/choices.js MAX_CHOICES), and
// the editor let an author add as many rows as they liked and then said nothing
// until Save came back refused. The add button now stops at the limit WITH its
// reason (v7.14.2: never offer what the server is certain to refuse). An
// irreducible copy of the server's number: public/js cannot import lib/, and a
// spec diffs the two.
export const TF_MAX_CHOICES=20;
function _tfSyncAddChoiceCap(n){
  const btn=document.getElementById('tf-add-choice');
  const note=document.getElementById('tf-choices-cap-note');
  const full=n>=TF_MAX_CHOICES;
  if(btn){
    // `capDisabled` records that THIS rule disabled it, so dropping below the
    // limit never re-enables a button a read-only form disabled for its own reason.
    if(full){btn.disabled=true;btn.dataset.capDisabled='1';}
    else if(btn.dataset.capDisabled){btn.disabled=false;delete btn.dataset.capDisabled;}
  }
  if(note)note.hidden=!full;
}

/** The same rules the server enforces, surfaced while the author is typing. */
export function tfChoicesError(){
  const rows=(S._tfChoices||[]).map(c=>({...c,text:(c.text||'').trim()}));
  if(rows.length<2)return 'Add at least two choices.';
  if(rows.length>TF_MAX_CHOICES)return `A multiple-choice challenge can have at most ${TF_MAX_CHOICES} choices.`;
  if(rows.some(c=>!c.text))return 'Every choice needs some text.';
  const seen=new Set();
  for(const c of rows){
    const k=c.text.toLowerCase();
    if(seen.has(k))return `Two choices have the same text: "${c.text}".`;
    seen.add(k);
  }
  const n=rows.filter(c=>c.correct).length;
  if(!n)return 'Tick at least one choice as correct.';
  if(n===rows.length)return 'At least one choice must be incorrect.';
  return '';
}

export function tfAddChoice(){
  if((S._tfChoices||[]).length>=TF_MAX_CHOICES)return;   // the button is disabled, but never trust that alone
  S._tfChoices=[...(S._tfChoices||[]),{text:'',correct:false}];
  tfChoicesRender();
  // Focus the row just added so an author can keep typing without reaching for
  // the mouse between choices.
  const inputs=document.querySelectorAll('#tf-choices-list .choice-text');
  inputs[inputs.length-1]?.focus();
}
export function tfRemoveChoice(idx){
  const rows=[...(S._tfChoices||[])];
  if(rows.length<=2)return;                 // the button is disabled, but never trust that alone
  rows.splice(idx,1);
  S._tfChoices=rows;
  tfChoicesRender();
}
export function tfSetChoiceText(idx,val){
  const rows=[...(S._tfChoices||[])];
  if(!rows[idx])return;
  rows[idx]={...rows[idx],text:val};
  S._tfChoices=rows;
  // Deliberately does NOT re-render: that would destroy the input the author is
  // typing into and lose the caret. Only the validation line is refreshed.
  const err=document.getElementById('tf-choices-err');
  if(err)err.textContent=tfChoicesError()||'';
}
export function tfSetChoiceCorrect(idx,checked){
  const rows=[...(S._tfChoices||[])];
  if(!rows[idx])return;
  rows[idx]={...rows[idx],correct:!!checked};
  S._tfChoices=rows;
  const err=document.getElementById('tf-choices-err');
  if(err)err.textContent=tfChoicesError()||'';
}

// v8.9.0 — the additional-accepted-answers editor for a TEXT challenge.
//
// #tf-answer stays accepted answer #1 (every author and every test expects a
// Correct Answer box on the default form); these rows are the alternatives,
// each graded by the same rule. Same model-is-authoritative shape as the choice
// editor above: S._tfExtraAnswers is the truth, the DOM is a rendering of it,
// and a keystroke must NOT re-render (it would destroy the input being typed
// into and lose the caret). Row numbering starts at 2 so it reads as one list
// with the box above.
export function tfExtraAnswersRender(){
  const list=document.getElementById('tf-answers-extra');
  if(!list)return;
  const rows=S._tfExtraAnswers||[];
  setSafeHtml(list, rows.map((v,i)=>`
    <div class="choice-row" data-idx="${i}">
      <input class="choice-text" type="text" value="${esc(v||'')}"
             data-input-action="task-extra-answer-text" data-idx="${i}"
             placeholder="Accepted answer ${i+2}" aria-label="Accepted answer ${i+2}"/>
      <button type="button" class="btn sm danger choice-remove" data-action="task-extra-answer-remove" data-idx="${i}"
              aria-label="Remove accepted answer ${i+2}">Remove</button>
    </div>`).join(''));
  list.style.display=rows.length?'':'none';
}
export function tfAddExtraAnswer(){
  S._tfExtraAnswers=[...(S._tfExtraAnswers||[]),''];
  tfExtraAnswersRender();
  const inputs=document.querySelectorAll('#tf-answers-extra .choice-text');
  inputs[inputs.length-1]?.focus();
}
export function tfRemoveExtraAnswer(idx){
  const rows=[...(S._tfExtraAnswers||[])];
  if(!(idx>=0&&idx<rows.length))return;
  rows.splice(idx,1);
  S._tfExtraAnswers=rows;
  tfExtraAnswersRender();
}
export function tfSetExtraAnswer(idx,val){
  const rows=[...(S._tfExtraAnswers||[])];
  if(!(idx>=0&&idx<rows.length))return;
  rows[idx]=val;
  S._tfExtraAnswers=rows;
  // Deliberately no re-render — the caret rule, as for tfSetChoiceText.
}

/**
 * Show the controls the chosen answer type can use, and nothing else.
 *   text   → the Correct Answer box + the additional-answers list and its Add button
 *   file / json → the Correct Answer box alone
 *   choice → the choices editor (the answer is DERIVED from the ticked rows)
 *   any    → no answer box (there is no key), no HINT (the server refuses one),
 *            and a note explaining the rule where the box would have been
 * (v8.9.0 — was a two-way choice/not-choice switch before.)
 */
export function tfSyncAnswerType(){
  const type=document.getElementById('tf-atype')?.value;
  const isChoice=type==='choice';
  const isAny=type==='any';
  const isText=!type||type==='text';
  const ansGroup=document.getElementById('tf-answer-group');
  const chGroup=document.getElementById('tf-choices-group');
  const anyNote=document.getElementById('tf-any-note-group');
  const hintGroup=document.getElementById('tf-hint-group');
  const more=document.getElementById('tf-answers-more');
  if(ansGroup)ansGroup.style.display=(isChoice||isAny)?'none':'';
  if(chGroup)chGroup.style.display=isChoice?'':'none';
  if(anyNote)anyNote.style.display=isAny?'':'none';
  // The hint editor is HIDDEN for `any`, never removed (hintEditor is a
  // module-level instance bound to #tf-hint) and its content is left alone:
  // saveTask omits `hint` for this type and the server writes NULL, so a value
  // parked in the hidden editor cannot reach the row — and it is still there if
  // the author switches back before saving.
  if(hintGroup)hintGroup.style.display=isAny?'none':'';
  // The additional-answers row (list + Add button) is a TEXT affordance only.
  if(more)more.style.display=isText?'':'none';
  if(isText)tfExtraAnswersRender();
  // The plain Correct Answer input is `required`-ish in the save path; make
  // sure a stale value from another type cannot block a choice save.
  if(isChoice&&!(S._tfChoices||[]).length){
    S._tfChoices=[{text:'',correct:true},{text:'',correct:false}];
  }
  if(isChoice)tfChoicesRender();
  _tfSealSyncWithType();
}

/**
 * v8.10.1 — SEALED AND "ANY ANSWER (FREE RESPONSE)" ARE MUTUALLY EXCLUSIVE, and
 * the form says so from BOTH ends rather than waiting for a 400.
 *
 * A seal protects a KEY, and this type has none — v8.9.0 stores an empty
 * `correct_answer` for it by construction. Sealing one would also hide the free
 * responses from everyone but the author, which is the opposite of what the type
 * is for, so the server refuses the combination outright.
 *
 * Both directions are gated, because an author reaches the pair from either:
 *   • pick the free-response type -> the seal checkbox is unticked and DISABLED;
 *   • tick the seal              -> the free-response OPTION is disabled.
 *
 * Each carries its reason in the control's own place (v7.14.2 — withhold the
 * affordance and the explanation TOGETHER). A disabled <option> cannot be
 * chosen, so the "warning on trying to select it" is the note standing where the
 * choice would have been, which is the form telling the author before the fact
 * rather than after a refused save.
 *
 * ON THE EDIT FORM the checkbox is gone (sealing is create-only), but the OPTION
 * gate still applies and is the one that matters there: switching a sealed
 * challenge to free response is the reachable way into the forbidden pair, and
 * the PUT refuses it.
 */
function _tfSealSyncWithType(){
  const sel=document.getElementById('tf-atype');
  const cb=document.getElementById('tf-answer-seal');
  const note=document.getElementById('tf-seal-type-note');
  const anyOpt=sel?sel.querySelector('option[value="any"]'):null;
  const isAny=sel&&sel.value==='any';
  // The stored flag on an EDIT (create mode leaves S._tfAnswerSealed false), so
  // a sealed challenge keeps the option disabled even though the checkbox that
  // set it is no longer rendered.
  const sealed=!!(cb&&!cb.disabled&&cb.checked)||!!S._tfAnswerSealed;

  if(cb){
    // Clearing a standing tick is DEFENCE IN DEPTH and is declared as such:
    // with the option gate below in place an author cannot select the
    // free-response type while the box is ticked, so this line is unreachable
    // through the form today. It stays because the two gates are independent —
    // a future path that sets the type programmatically (a duplicate-challenge
    // action, say) would otherwise leave a tick standing on a combination the
    // server refuses, and what the form SHOWS must be what a save would send.
    if(isAny&&cb.checked)cb.checked=false;
    // v8.12.1 — the proxy lock (`_tfSealSetCreateMode`) survives a type change.
    cb.disabled=!!isAny||!!S.impersonation;
  }
  if(anyOpt)anyOpt.disabled=!!sealed;
  if(note){
    note.hidden=!(isAny||sealed);
    if(isAny)note.textContent='An "Any answer (free response)" challenge has no answer to seal — every response is accepted — so sealing is unavailable for it. Sealing would also hide the responses from everyone but you.';
    else if(sealed)note.textContent='This answer is sealed, so "Any answer (free response)" is unavailable: that type has no answer to seal, and the responses would be hidden from everyone but you.';
  }
}

export const TASK_FIELDS=['title','difficulty','answer_type','correct_answer','choices','description','explanation','hint','attachment_url','active','status','author_name','author_linkedin','locked','tags','attachments'];

export async function restoreTaskVersion(taskId,versionId,versionNum){
  // v8.12.6 (sweep) — THE HISTORY DIALOG THIS RESTORE CLOSES IS THE ONE IT WAS
  // STARTED FROM. It closes the dialog after two awaits (the CSRF refresh and the
  // POST), and `closeHistoryDialog()` closes whatever `#hist-overlay` is on screen
  // by then: close this one, open another challenge's or an event's History while
  // the restore is in flight, and the answer closed THAT one. The identity is the
  // dialog's own state object — a fresh one per openHistoryDialog, nulled by its
  // close — the question `loadMoreHistory` already asks (history.js). A bump of
  // the open-sequence token in closeHistoryDialog would NOT have been the fix:
  // re-opening already bumps it, and the restore does not read it.
  const _histDialog=S._histState;
  const ok=await showModal({title:'Restore Version',message:`Restore challenge to version #${versionNum}? This creates a new version with the restored data.`,confirmText:'Restore',confirmClass:''});
  if(!ok)return;
  // Keep the CSRF token fresh right before the POST. A long-lived history
  // dialog may have been open past a client-side refresh that invalidated
  // the in-memory token; re-fetching on demand is cheaper than debugging
  // the "Restore logged me out" surprise that a stale token produces.
  await loadCsrfToken();
  const r=await fetch(`/api/admin/tasks/${taskId}/restore`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({versionId})});
  if(r.ok){
    // Close the history dialog so the admin sees the refreshed task list
    // + edit-form state immediately. Previously the dialog stayed open with
    // the pre-restore version highlighted, which read as "nothing happened"
    // — a UX quirk that got reported as "restore didn't work".
    if(S._histState===_histDialog)closeHistoryDialog();
    // If the task is currently open in the edit form, re-render it from
    // the restored state so fields + attachments list reflect the change
    // without the admin having to close + reopen.
    if(document.getElementById('admin-task-form')?.style.display!=='none'&&document.getElementById('edit-task-id').value===taskId){
      await loadAdminTasks();
      await editTask(taskId);
    }else{
      await loadAdminTasks();
    }
    showToast('Challenge restored.','success');
  }
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Restore failed.','error');}
}

export async function openAssignTaskToComps(taskId){
  // v8.12.6 (sweep) — the LATEST open wins, and any dialog already showing is
  // replaced AFTER the await, not before it (see `_assignOpenSeq` above). The old
  // "close any existing dialog to prevent state conflicts" line ran BEFORE the
  // await, so it could only ever close a dialog that was already settled — two
  // opens in flight both got past it and both appended.
  const seq=++_assignOpenSeq;
  // v8.3.20 — see openBulkAssignChallengesModal: an unchecked r.ok made a 500
  // crash the `.filter` below with nothing on screen.
  const allComps=await fetchJsonList('/api/admin/competitions');
  if(seq!==_assignOpenSeq)return;   // superseded by a later open (fetchJsonList parses inside)
  if(!allComps){showToast('Could not load events. Check your connection and try again.','error');return;}
  const endedIds=new Set(allComps.filter(c=>computeCompStatus(c)==='ended').map(c=>c.id));
  const comps=allComps.filter(c=>!endedIds.has(c.id)).sort(compareCompsForPicker);   // the one admin event-picker order
  const task=S.adminTasksData.find(t=>t.id===taskId);
  const assignedIds=new Set((task?.competitions||[]).map(c=>c.id));
  // Scope state to this dialog instance via data attributes on the overlay
  //
  // v8.7.7 — THE DIALOG MAY ONLY CHANGE WHAT IT RENDERED. The submit sends a
  // DESIRED STATE and the server diffs it against the challenge's current
  // assignment set, so any assignment this dialog drew no checkbox for is read as
  // a removal the admin never asked for. A row goes unrendered when the event has
  // ENDED — filtered out of `comps` just above — so the preserved set is derived
  // from what was RENDERED rather than from why a row was dropped: it cannot miss
  // a second reason invented later. This is v7.20.10's rule for the sibling bulk
  // picker — THE BASELINE IS `assigned INTERSECT LISTED`, never `assigned` —
  // which this dialog never learned.
  //
  // v8.8.8 — AND THE OTHER REASON A ROW WENT UNRENDERED IS GONE FROM HERE, which
  // is why this comment is shorter than it was. It used to name a second case:
  // the event is outside the actor's scope, so `/api/admin/competitions` (narrowed
  // since v8.7.0) never lists it while `task.competitions` named it anyway. That
  // asymmetry was the leak, and closing it moved the preservation to the SERVER,
  // which now diffs against the set it SHOWED. `assignedIds` is therefore already
  // in scope and `preservedForTask` covers only ended events again.
  const renderedIds=new Set(comps.map(c=>c.id));
  const preservedForTask=[...assignedIds].filter(id=>!renderedIds.has(id));
  // Operator ruling N7 (14 Nov 2026) — an event asks each qualifying question
  // once: an event that already holds another challenge on one of this one's
  // topics (`qualifying_keys`, the server's parse) refuses it, so it is offered
  // disabled with the reason. Read off the library this dialog opens from.
  const _myKeys=(task&&task.qualifying_keys)||[];
  const topicHeldIn=new Set();
  if(_myKeys.length)for(const u of (S.adminTasksData||[])){
    if(u.id===taskId||!(u.qualifying_keys||[]).some(k=>_myKeys.includes(k)))continue;
    for(const c of (u.competitions||[]))topicHeldIn.add(c.id);
  }
  // `expectedAssignments` is the set the SERVER showed us, which for an event
  // admin is narrowed and for everybody else is the full one — the server compares
  // it against the same narrowing, so the two cannot disagree. Sending anything
  // else would turn every save on a shared challenge into a spurious 409 blaming a
  // colleague for a conflict that does not exist.
  const expectedForTask=[...assignedIds];

  document.querySelectorAll('#assign-task-overlay').forEach(o=>o.remove());
  const overlay=document.createElement('div');
  overlay.id='assign-task-overlay';
  overlay.dataset.expectedAssignments=JSON.stringify(expectedForTask);
  overlay.dataset.preservedAssignments=JSON.stringify(preservedForTask);
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay, `<div class="card" style="max-width:min(500px, calc(100vw - 32px));width:100%;max-height:80vh;max-height:80dvh;overflow-y:auto">
    <h3 style="margin-bottom:16px">Assign "${esc(task?.title||'')}" to Events</h3>
    <div id="assign-task-comp-list" style="display:flex;flex-direction:column;gap:8px">
      ${comps.length?comps.map(c=>{
        const isAssigned=assignedIds.has(c.id);
        const checked=isAssigned?'checked':'';
        const status=computeCompStatus(c);
        const assignedTag=isAssigned?'<span class="assign-task-assigned">Assigned</span>':'';
        // v8.12.0 — TWO ROWS THIS DIALOG MUST NOT OFFER. An event the ACTOR
        // competes in refuses every change (`competing`, from the predicate the
        // route enforces); an event where staff compete refuses an UNSEALED
        // challenge (adding only — an existing assignment stays removable, that
        // being the remedy every refusal names). Both disabled with the reason;
        // the author rule is decided server-side and rendered by the refusal
        // modal on Save.
        const competing=!!c.competing;
        const sealBlocked=!!c.staff_compete&&!task?.answer_sealed&&!isAssigned;
        const topicBlocked=!isAssigned&&topicHeldIn.has(c.id);
        const blocked=competing||sealBlocked||topicBlocked;
        const why=competing?'You are competing in this event — you cannot change its challenges.':(sealBlocked?'Staff compete in this event, so it only admits challenges whose answer is sealed.':(topicBlocked?'This event already has a qualifying question on this topic, and an event asks each one once.':''));
        const flag=competing?'<span class="picker-row-flag">You compete here</span>':(sealBlocked?'<span class="picker-row-flag">Sealed only</span>':(topicBlocked?'<span class="picker-row-flag">Topic already asked</span>':''));
        // v8.13.7 — marked inactive like every picker row (dashed edge, muted
        // text, at full strength — styles.css #assign-task-comp-list).
        return`<label${blocked?' class="is-disabled"':''} style="display:flex;align-items:center;gap:10px;cursor:${blocked?'not-allowed':'pointer'};padding:6px 8px;border-radius:6px;background:var(--surface2)"${why?` title="${esc(why)}"`:''}>
          <input type="checkbox" value="${esc(c.id)}" ${checked} ${blocked?'disabled':''} data-change-action="update-assign-save-btn" data-was-assigned="${isAssigned?'1':'0'}" data-comp-name="${esc(c.name)}" data-comp-status="${esc(status)}" style="width:16px;height:16px;accent-color:var(--accent)"/>
          <span style="flex:1">${esc(c.name)} <span class="status-badge ${esc(status)}" style="margin-left:6px">${esc(status)}</span>${flag}</span>
          ${assignedTag}
        </label>`;
      }).join(''):'<p style="color:var(--muted)">No active events available.</p>'}
    </div>
    <div style="display:flex;gap:10px;margin-top:20px">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="assign-task-overlay">Cancel</button>
      <button class="btn" id="assign-task-save-btn" data-action="task-assign-save" data-task-id="${esc(taskId)}" disabled>Save</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  updateAssignSaveBtn();
}

export function updateAssignSaveBtn(){
  const btn=document.getElementById('assign-task-save-btn');
  if(!btn)return;
  const boxes=document.querySelectorAll('#assign-task-comp-list input[type="checkbox"]');
  let changed=false;
  for(const cb of boxes){
    const was=cb.dataset.wasAssigned==='1';
    if(cb.checked!==was){changed=true;break;}
  }
  // The disabled state alone: `.btn:disabled` draws it (a --surface-3 well, --muted
  // text at full strength). An inline opacity would fade the label below AA and
  // out-rank that rule (DESIGN_SYSTEM §7, "Disabled controls never fade").
  btn.disabled=!changed;
}

export async function saveTaskCompAssignments(taskId){
  const overlay=document.getElementById('assign-task-overlay');
  if(!overlay)return;
  const expectedAssignments=JSON.parse(overlay.dataset.expectedAssignments||'[]');
  // Every currently-assigned event the dialog did not render — ended, or outside
  // this actor's scope. Carried through verbatim so the server sees a complete
  // desired state and computes no phantom removal (v8.7.7).
  const preserved=JSON.parse(overlay.dataset.preservedAssignments||'[]');
  const allBoxes=overlay.querySelectorAll('#assign-task-comp-list input[type="checkbox"]');
  const checks=overlay.querySelectorAll('#assign-task-comp-list input[type="checkbox"]:checked');
  const competitionIds=[...new Set([...Array.from(checks).map(c=>c.value),...preserved])];
  // Detect removals from live competitions and confirm
  const liveRemovals=Array.from(allBoxes).filter(cb=>!cb.checked&&cb.dataset.wasAssigned==='1'&&cb.dataset.compStatus==='live');
  if(liveRemovals.length>0){
    const names=liveRemovals.map(cb=>cb.dataset.compName).join(', ');
    const ok=await showModal({title:'Remove from Live Event',message:`You are about to remove this challenge from <strong>${esc(names)}</strong>, which ${liveRemovals.length>1?'are':'is'} currently <strong>live</strong>. Participants may already be working on it.<br><br>Are you sure?`,confirmText:'Yes, Remove',confirmClass:'danger'});
    if(!ok)return;
  }
  const r=await fetch(`/api/admin/tasks/${taskId}/competitions`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({competitionIds,expectedAssignments})});
  // v8.12.6 (sweep) — the dialog this save CLOSES is the one it READ, captured
  // above, never whatever `#assign-task-overlay` is on screen when the PUT
  // answers: the dialog stays open (and dismissable) during the round trip, so an
  // admin can close it and open "Assign to Events" for another challenge, and a
  // by-id removal then closed THAT one. Removing an already-detached element is a
  // no-op, which is the right answer when the admin closed it themselves.
  if(r.ok){showToast('Challenge assignments updated.','success');overlay.remove();loadAdminTasks();}
  else{
    const d=await r.json().catch(()=>({}));
    if(d.conflict){showToast(d.error||'Conflict detected. Please reopen the dialog.','error');overlay.remove();loadAdminTasks();}
    // v8.12.0 — a structured seal refusal names the pair; the dialog stays open so
    // the admin can untick it and save the rest.
    else if(d.code&&Array.isArray(d.refused)&&d.refused.length){showAssignmentRefusalModal(d.refused,d.refused_total);}
    else{showToast(d.error||'Failed.','error');}
  }
}

export async function removeTaskFromComp(taskId,compId){
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const status=comp?computeCompStatus(comp):null;
  if(status==='ended'){showToast('Cannot modify challenge assignments for ended events.','success');return;}
  const isLive=status==='live';
  const msg=isLive
    ?`This event is <strong>currently live</strong>. Removing this task may affect participants who are working on it.<br><br>Are you sure you want to remove it?`
    :'Remove this task from the current event?';
  const ok=await showModal({title:isLive?'Remove from Live Event':'Remove Task',message:msg,confirmText:isLive?'Yes, Remove':'Remove',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${taskId}/competitions/${compId}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('Challenge removed from event.','success');loadAdminTasks();}
  else{const d=await r.json();showToast(d.error||'Failed.','error');}
}

/**
 * v8.1.4 — GRANT A PARTICIPANT MORE ATTEMPTS.
 *
 * The control the whole attempt-cap feature was missing. Three shipped strings
 * told a participant and an admin that an organiser could hand out another try;
 * the endpoint that does it had zero client callers, so the remedy named on the
 * participant's own screen could not be performed from any screen.
 *
 * THE EVENTS ARE FETCHED, NOT READ OFF THE MODEL. A cap can live on the EVENT
 * (`lib/attempts.js`, most-specific-wins) and `S.adminCompetitionsData` is
 * populated by the Competitions tab, which an admin opening Challenges first has
 * never visited. Fetching makes this dialog authoritative regardless of the gate
 * that opened it, in the idiom `openAssignTaskToComps` already uses.
 *
 * GRANTS ACCUMULATE server-side (`ON CONFLICT DO UPDATE SET extra = extra +
 * excluded.extra`, so two admins each granting one gives two). The copy therefore
 * says ADD rather than implying it sets a total — a control whose number means
 * something other than what it says is how a desk hands out five attempts
 * believing it handed out one.
 */
export async function openAttemptGrant(taskId){
  // v8.12.6 (sweep) — the LATEST open wins and an existing dialog is replaced
  // AFTER the await (see `_grantOpenSeq` above); the removal that used to sit here
  // ran before the await, so two opens in flight both appended.
  const seq=++_grantOpenSeq;
  const task=S.adminTasksData.find(t=>t.id===taskId);
  if(!task){showToast('That challenge is no longer in the list. Refresh and try again.','error');return;}
  let allComps=null;
  try{const r=await fetch('/api/admin/competitions');if(r.ok&&seq===_grantOpenSeq)allComps=await r.json();}catch(e){console.warn('Grant attempts: could not load events',e);}
  if(seq!==_grantOpenSeq)return;   // superseded while in flight — re-checked after the parse too
  if(!Array.isArray(allComps)){showToast('Could not load this challenge’s events. Please try again.','error');return;}
  const byId=new Map(allComps.map(c=>[c.id,c]));
  // Mirror of the server's `??` chain. A mirror can only ever be OPTIMISTIC —
  // the POST re-resolves the cap and its 409 is surfaced below, which is what
  // keeps a stale model from becoming a silent wrong answer.
  const capped=(task.competitions||[])
    .map(c=>byId.get(c.id))
    .filter(Boolean)
    .map(c=>({comp:c,cap:task.attempt_cap??c.attempt_cap??null,status:computeCompStatus(c)}))
    // v8.3.11 — ended events are OFFERED, labelled. See _taskMayHaveCap above for
    // why: the server honours the grant, and on an auto-ended capped event it is
    // the only thing that lets the event be reopened at all. compareCompsForPicker
    // lists the live ones first and the ended ones last, the latest start first.
    .filter(x=>x.cap!=null);
  // v8.12.0 — an event the actor competes in refuses the grant (a scoring write
  // on the board they are on), so it is not offered — and when that is the ONLY
  // reason the list is empty, the empty state says so rather than claiming no
  // event holds the challenge with a limit (withholding with the reason).
  const competingHeld=capped.filter(x=>x.comp.competing).map(x=>x.comp.name);
  const offered=capped.filter(x=>!x.comp.competing).sort((a,b)=>compareCompsForPicker(a.comp,b.comp));

  document.querySelectorAll('#attempt-grant-overlay').forEach(o=>o.remove());
  const overlay=document.createElement('div');
  overlay.id='attempt-grant-overlay';
  overlay.className='picker-overlay';

  // NOTHING TO GRANT IS AN EXPLANATION, NOT AN EMPTY DIALOG. The kebab gate is
  // optimistic on an unloaded events model, so this branch is reachable — and a
  // dialog that opened onto a blank list would read as a broken feature, which is
  // exactly the report v7.14.2 is named for. Say why, and name what to change.
  if(!offered.length){
    setSafeHtml(overlay,`<div class="picker-modal" role="dialog" aria-modal="true" aria-labelledby="ag-title">
      <div class="picker-modal-head"><h3 id="ag-title">Grant Attempts</h3></div>
      ${competingHeld.length
        ?`<p class="picker-note">You are competing in ${competingHeld.map(n=>`<strong>${esc(n)}</strong>`).join(' and ')}, which ${competingHeld.length===1?'holds':'hold'} <strong>${esc(task.title)}</strong> with an attempt limit, so you cannot grant attempts on it — ask another organiser.</p>`
        :`<p class="picker-note">No event <em>you organise</em> holds <strong>${esc(task.title)}</strong> with an attempt limit, so there is nothing to grant here.</p>`}
      <p class="picker-note">A limit is set by <em>Attempt limit</em> in the challenge editor, or by <em>Attempt limit per challenge</em> on the event. Both name the controls exactly as they appear. The limit itself can no longer be changed on an ended event, but attempts can still be granted on one.</p>
      <div class="picker-modal-foot">
        <button class="btn secondary" data-action="overlay-close" data-overlay-id="attempt-grant-overlay">Close</button>
      </div>
    </div>`);
    document.body.appendChild(overlay);
    overlayDismiss(overlay,()=>overlay.remove());
    return;
  }

  setSafeHtml(overlay,`<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="ag-title">
    <div class="picker-modal-head"><h3 id="ag-title">Grant attempts on “${esc(task.title)}”</h3></div>
    <div class="form-group">
      <label for="ag-comp">Event</label>
      <select id="ag-comp">${offered.map(x=>`<option value="${esc(x.comp.id)}">${esc(x.comp.name)} — ${x.cap} attempt(s) per participant${x.status==='ended'?' — ended':''}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label for="ag-participant-filter">Participant</label>
      ${pickerFilterHtml('ag-participant-filter',{placeholder:'Search by nickname, name or email…',label:'Search participants in this event'})}
      <div class="picker-rows" id="ag-people"><p class="picker-note">Loading participants…</p></div>
    </div>
    <div class="form-group">
      <label for="ag-extra">Extra attempts to add</label>
      <input id="ag-extra" type="number" min="1" max="1000" step="1" value="1" inputmode="numeric" aria-describedby="ag-extra-hint"/>
      <p class="picker-note" id="ag-extra-hint">This <strong>adds to</strong> any attempts already granted — it does not set a total.</p>
    </div>
    <p class="picker-note" id="ag-selected"></p>
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="attempt-grant-overlay">Cancel</button>
      <button class="btn" id="ag-save" disabled>Grant</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());

  // Selection is held in a MODEL, not read back out of the DOM at submit time.
  // The filter HIDES non-matching rows, so a DOM-authoritative read could send a
  // grant to somebody the admin can no longer see (the v7.21.16 lesson). The
  // chosen participant is echoed in `#ag-selected` and named again in the confirm.
  let people=[],sel=null,fetchSeq=0;
  const selectedName=()=>{const p=people.find(x=>x.id===sel);return p?(p.nickname||p.email||p.id):null;};
  // Resolved BEFORE anything that reads it. `_loadPeople` calls `reapplyFilter`,
  // and a `const` read above its own declaration is a TDZ ReferenceError that
  // `node --check` cannot see — this repo has paid for that twice (v7.21.20).
  const reapplyFilter=wirePickerFilter(overlay,'ag-participant-filter','#ag-people .picker-row',
    {emptyText:'No participant in this event matches that search.',noun:'participant'});
  // Bound ONCE, on the container, which survives every re-render of its contents.
  // Re-binding inside `_loadPeople` would stack a listener per event switch.
  overlay.querySelector('#ag-people').addEventListener('change',e=>{
    if(e.target&&e.target.name==='ag-participant'){sel=e.target.value;_paintSelection();}
  });
  function _paintSelection(){
    const line=overlay.querySelector('#ag-selected');
    const btn=overlay.querySelector('#ag-save');
    const name=selectedName();
    if(line)line.textContent=name?`Granting to ${name}.`:'Choose a participant to grant attempts to.';
    if(btn)btn.disabled=!name;
  }
  async function _loadPeople(){
    const compId=overlay.querySelector('#ag-comp')?.value;
    const mine=++fetchSeq;
    sel=null;_paintSelection();
    const box=overlay.querySelector('#ag-people');
    if(box)setSafeHtml(box,'<p class="picker-note">Loading participants…</p>');
    let data=null;
    try{const r=await fetch(`/api/admin/participants/picker?competitionId=${encodeURIComponent(compId)}`);if(r.ok)data=await r.json();}catch(e){console.warn('Grant attempts: could not load participants',e);}
    // A superseded response must not paint over a newer one (v7.15.13); the
    // event select can be changed twice before the first roster lands.
    if(mine!==fetchSeq)return;
    if(!box)return;
    if(!data||!Array.isArray(data.users)){
      people=[];
      setSafeHtml(box,'<p class="picker-note">Could not load the participants for this event. Please try again.</p>');
    }else{
      // Enrolled PARTICIPANTS only — the picker also returns non-members (so an
      // admin can add somebody) and the grant endpoint refuses both a non-member
      // (409) and a privileged target (403). Offering either would be an
      // affordance that is certain to be refused.
      // v8.8.11 — THE `in_competition` CLAUSE IS WHAT KEEPS THIS ROSTER CORRECT,
      // and it is a near miss rather than a design. The picker's NON-MEMBER half
      // is capped at 500 and ordered by created_at — exactly the defect v8.8.11
      // removed from the participants tab, where a focused pane rendered the
      // oldest 500 accounts under its own pager and count and looked complete.
      // This dialog survived it only because it reads the MEMBERS bucket, which
      // the endpoint returns in full whatever the limit. Widen this to
      // non-members and the roster silently offers the oldest 500 accounts as
      // though they were the platform.
      // v8.12.0 — on an event where STAFF COMPETE an enrolled admin or event
      // admin is a competitor and may be granted attempts like anybody else (the
      // route admits them there). A regular admin is still refused an admin or
      // superadmin target by the peer-admin rule, so those rows are WITHHELD
      // from a non-superadmin's roster rather than offered and refused on Save
      // (the picker payload carries `role`; v7.14.2).
      const _agComp=(offered.find(x=>x.comp.id===compId)||{}).comp;
      const _agStaffCompete=!!(_agComp&&_agComp.staff_compete);
      const _agPeerOk=u=>S.isSuperAdmin||!((u.role||'participant')==='admin'||(u.role||'participant')==='superadmin');
      people=data.users.filter(u=>u.in_competition&&(_agStaffCompete?_agPeerOk(u):(u.role||'participant')==='participant'));
      setSafeHtml(box,people.length?people.map(u=>{
        const label=u.nickname||u.email||u.id;
        const full=[u.first_name,u.last_name].filter(Boolean).join(' ');
        return `<label class="picker-row" data-search="${esc([u.nickname,u.email,full,u.company].filter(Boolean).join(' '))}">
          <input type="radio" name="ag-participant" value="${esc(u.id)}" class="picker-row-check"/>
          <span class="picker-row-body"><strong>${esc(label)}</strong>${full?` <span style="color:var(--muted)">${esc(full)}</span>`:''}${u.email?` <span style="color:var(--muted)">${esc(u.email)}</span>`:''}</span>
        </label>`;
      }).join(''):'<p class="picker-note">Nobody is enrolled in this event yet.</p>');
    }
    // Re-applied on EVERY exit, including the empty and failed ones: the match
    // count lives outside `#ag-people` and therefore survives the re-render, so
    // skipping this would leave the previous event's number over a new roster.
    reapplyFilter();
  }
  overlay.querySelector('#ag-comp').addEventListener('change',_loadPeople);
  overlay.querySelector('#ag-save').addEventListener('click',()=>_submitAttemptGrant(overlay,taskId,task.title,offered,()=>({sel,name:selectedName()})));
  _paintSelection();
  await _loadPeople();
}

// v8.12.6 (sweep) — reads and closes ITS OWN dialog (`overlay`), never whatever
// `#attempt-grant-overlay` is on screen when the grant answers: the confirm and
// the POST are awaits, and a by-id removal closed a dialog opened meanwhile for
// another challenge.
async function _submitAttemptGrant(overlay,taskId,taskTitle,capped,read){
  const {sel,name}=read();
  const compId=overlay.querySelector('#ag-comp')?.value;
  const raw=(overlay.querySelector('#ag-extra')?.value||'').trim();
  const extra=/^\d+$/.test(raw)?Number(raw):NaN;
  if(!sel||!name){showToast('Choose a participant first.','error');return;}
  if(!Number.isInteger(extra)||extra<1||extra>1000){showToast('Enter a whole number of extra attempts between 1 and 1000.','error');return;}
  const ev=capped.find(x=>x.comp.id===compId);
  // Named in full before it happens: a grant ACCUMULATES and there is no revoke,
  // so the one number that cannot be taken back is worth reading twice.
  const ok=await showModal({
    title:'Grant Attempts',
    message:`Give <strong>${esc(name)}</strong> <strong>${extra}</strong> extra attempt(s) on “${esc(taskTitle)}” in <strong>${esc(ev?ev.comp.name:'this event')}</strong>?<br><br>This <strong>adds to</strong> anything already granted and cannot be taken back.`,
    confirmText:'Grant',confirmClass:'',cancelText:'Cancel',
  });
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${taskId}/attempt-grant`,{
    method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({userId:sel,competitionId:compId,extra}),
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok){
    // SURFACE THE REFUSAL. The server names each one — an uncapped challenge
    // (409 `not_capped`), a privileged target, a participant who is not enrolled
    // — and swallowing it leaves the admin watching a dialog close with nothing
    // having happened, which is indistinguishable from a broken feature
    // (v7.21.14).
    showToast(d.error||'Failed to grant attempts.','error');
    return;
  }
  const a=d.attempts||{};
  const left=Number.isInteger(a.left)?` They now have ${a.left} of ${a.effective} left.`:'';
  // v8.3.11 — A GRANT INTO AN ENDED EVENT LEAVES THE PARTICIPANT UNABLE TO ACT,
  // and saying only "granted" would be the v7.14.2 failure with the sides swapped:
  // the affordance works and the outcome silently does not. The grant IS the
  // necessary first step — the revive gate refuses while everyone is still
  // finished, so it cannot be done the other way round — and the second step is a
  // superadmin one, because reopening an event past its end always has been
  // (FROZEN_REMEDY). Name both, in order, or the admin walks away believing it is
  // done. Read from the SERVER's flag, never a client status: this dialog can hold
  // a model that is up to a poll old.
  const next=d.competition_ended
    ? ' The event has ended, so they cannot use it yet — a superadmin must reopen the event by extending its duration, which is now possible because this grant un-finished them.'
    : '';
  showToast(`Granted ${extra} extra attempt(s) to ${name} on “${taskTitle}”.${left}${next}`,'success');
  overlay.remove();
}

export async function openAddTasksToCompetition(){
  if(!S.adminSelectedCompetitionId)return;
  const allTasks=await _loadAdminTaskList();
  if(!allTasks){ showToast('Could not load the challenge list. Please try again.','error'); return; }
  // Find tasks already assigned to the selected competition
  const assignedIds=new Set(allTasks.filter(t=>(t.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId)).map(t=>t.id));
  const available=allTasks.filter(t=>t.status==='published'&&t.active&&!assignedIds.has(t.id));
  if(!available.length){showToast('No more published challenges to add.','success');return;}
  openTaskPickerForCompetition(S.adminSelectedCompetitionId);
}

export function clearTaskFormErrors(){clearFieldErrors(document.getElementById('admin-task-form'));}

export function _isZipMagic(file){
  return new Promise(resolve=>{
    const fr=new FileReader();
    fr.onload=()=>{
      const b=new Uint8Array(fr.result);
      if(b.length<4)return resolve(false);
      const [a,b1,c,d]=b;
      resolve((a===0x50&&b1===0x4B&&c===0x03&&d===0x04)||(a===0x50&&b1===0x4B&&c===0x05&&d===0x06));
    };
    fr.onerror=()=>resolve(false);
    fr.readAsArrayBuffer(file.slice(0,4));
  });
}

// Whether this reader's editor offers no attachment writes for challenge `t` (a
// row of the admin list), exactly where the attachment routes refuse: a
// competitor's, a locked one, and an organiser's on a challenge that is not
// theirs (`can_edit` false for an organiser: the routes' taskEditDenied). A seal
// alone never refuses them (it leaves attachments editable, v8.12.0), and a
// global admin's `can_edit` is false only for a seal or a competitor. One answer
// for the add button and the chips' Rename/Remove.
function _tfAttachReadOnly(t){
  if(!t)return false;
  return (Array.isArray(t.competing_in)&&t.competing_in.length>0)||!!t.locked||(t.can_edit===false&&!!S.isEventAdmin);
}
export function _renderAttachmentChip(a,{mode,taskId,readOnly}){
  const size=esc(_fmtBytes(a.size_bytes));
  const name=esc(a.display_name||'attachment');
  const idAttr=mode==='staging'?`data-staging-id="${esc(a.staging_id)}"`:`data-task-id="${esc(taskId)}" data-aid="${esc(a.id)}"`;
  const download=mode==='saved'?`<a class="tf-attach-chip-action" title="Download" href="/api/admin/tasks/${esc(taskId)}/attachments/${esc(a.id)}" download="${name}.zip" aria-label="Download ${name}">${ICO.download}</a>`:'';
  // v8.12.0 — a read-only editor (`_tfAttachReadOnly`: a competitor's, a challenge
  // the reader may not edit, a locked one) keeps Download and loses Rename/Remove:
  // the three attachment routes refuse each of them.
  const rename=readOnly?'':`<button type="button" class="tf-attach-chip-action" title="Rename" aria-label="Rename ${name}" data-action="${mode==='staging'?'staging-attach-rename':'attach-rename'}" ${idAttr} data-current="${name}">${ICO.edit}</button>`;
  const remove=readOnly?'':`<button type="button" class="tf-attach-chip-action tf-attach-chip-del" title="Remove" aria-label="Remove ${name}" data-action="${mode==='staging'?'staging-attach-delete':'attach-delete'}" ${idAttr} data-name="${name}">${ICO.trash}</button>`;
  return `<div class="tf-attach-chip" role="listitem">
    <span class="tf-attach-chip-icon" aria-hidden="true">${ICO.paperclip}</span>
    <span class="tf-attach-chip-name">${name}</span>
    <span class="tf-attach-chip-size">${size}</span>
    ${rename}
    ${download}
    ${remove}
  </div>`;
}

export async function _renderTaskFormAttachments(){
  const list=document.getElementById('tf-attachments-list');
  if(!list)return;
  const taskId=document.getElementById('edit-task-id').value;
  // v6.13.15 — both modes render the same mixed list: server-persisted
  // (mode: 'saved') chips for attachments already attached to the task,
  // plus pending staging (mode: 'staging') chips for in-session uploads
  // that will be promoted on Save. Create mode has no taskId so the
  // fetch is skipped and only staging rows show up.
  let savedChips='';
  let savedFailed=false;
  // v8.12.0 — read from the row the editor opened, which is what carries the
  // server's answer (`competing_in`); the list renders asynchronously, so the
  // decision has to be made here rather than by a pass over the chips.
  const readOnly=!!(taskId&&_tfAttachReadOnly((S.adminTasksData||[]).find(x=>x.id===taskId)));
  if(taskId){
    // v8.11.11 — `r.ok?r.json():[]` degraded a FAILED read to an empty array, and
    // the empty branch below then rendered "No attachments yet." — a positive
    // claim about the challenge, made from a request that failed. An admin saving
    // that form believes the challenge has none. `null` is the third state, and
    // it is why this is a let: absent is not the same as none.
    const rows=await fetch(`/api/admin/tasks/${taskId}/attachments`).then(r=>r.ok?r.json():null).catch(()=>null);
    if(rows===null)savedFailed=true;
    else savedChips=rows.map(a=>_renderAttachmentChip(a,{mode:'saved',taskId,readOnly})).join('');
  }
  const stagingChips=S._pendingStagingAttachments.map(a=>_renderAttachmentChip(a,{mode:'staging',readOnly})).join('');
  // v8.11.5 — A LIST THAT HOLDS ONLY ITS EMPTY-STATE MESSAGE IS NOT A LIST.
  // The container is `role="list"` in the shell markup and every chip is a
  // `role="listitem"`, so the POPULATED state is correct — but "No attachments
  // yet." is a sentence, not an item, and axe rates the mismatch
  // `aria-required-children` CRITICAL (WCAG 2.0-A). It fires in the default
  // empty state of every New Challenge form, which is the first thing an admin
  // opens. The role is dropped WHILE EMPTY and restored with the first chip,
  // rather than dressing the message up as a listitem — announcing a
  // one-item list whose item says there are no items is worse than either.
  if(savedFailed&&!stagingChips){
    // Say what happened, and offer the retry — the read is the only way to learn
    // what this challenge already has, so leaving it terminal is what makes the
    // wrong claim durable.
    list.removeAttribute('role');
    setSafeHtml(list,'<div class="tf-attach-empty">Could not load this challenge\'s attachments. '
      +'<button class="btn sm secondary" data-action="retry-load-attachments">Try again</button></div>');
    _tfAttachCountSync(null);
    return;
  }
  if(!savedChips&&!stagingChips){
    list.removeAttribute('role');
    setSafeHtml(list,'<div class="tf-attach-empty">No attachments yet.</div>');
    _tfAttachCountSync(0);
    return;
  }
  list.setAttribute('role','list');
  setSafeHtml(list,savedChips+stagingChips);
  _tfAttachCountSync(list.querySelectorAll('[role="listitem"]').length);
}

export function _openAttachPicker(){
  document.getElementById('tf-attach-error').style.display='none';
  document.getElementById('tf-attach-file').value='';
  document.getElementById('tf-attach-dname').value='';
  document.getElementById('tf-attach-progress').style.display='none';
  document.getElementById('tf-attachments-picker').style.display='';
}

// v8.8.8 — THE WARNING SURVIVES NARROWING, and saying how is the point.
//
// `task.competitions` is scoped for an event admin, so a challenge live in
// ANOTHER organiser's event now contributes no named entry here — and an event
// admin may still legally edit its cosmetic fields (v8.8.5 froze the scoring
// ones and deliberately left the rest). Dropping the confirmation for exactly
// that case would delete the warning at the moment it matters most: a change
// landing on participants who are answering right now.
//
// So the server counts what it withheld and says whether any of it is LIVE, and
// the sentence names what it can and states the rest. The withheld clause is a
// far smaller disclosure than the event's name, and unlike the name it is
// operationally necessary — the v8.8.6 shape for the same tension, where an
// empty array could not tell a real absence from a narrowed one.
function _liveMutationParts(task){
  const named=(task?.competitions||[]).filter(c=>c.status==='live').map(c=>String(c.name||''));
  const withheld=task?.withheld_live?(task.withheld_competition_count||1):0;
  return {named,withheld,any:named.length>0||withheld>0};
}

function _liveMutationPhrase({named,withheld}){
  const parts=[];
  // Event names are organiser-written text: escaped HERE, where they become HTML.
  if(named.length)parts.push(`<strong>${named.map(esc).join(', ')}</strong>`);
  if(withheld)parts.push(`<strong>${Number(withheld)} event${withheld===1?'':'s'} you do not organise</strong>`);
  return parts.join(' and ');
}

export async function _confirmLiveChallengeMutation(taskId,title,body){
  if(!taskId)return true;
  const task=S.adminTasksData.find(x=>x.id===taskId);
  const parts=_liveMutationParts(task);
  if(!parts.any)return true;
  return showModal({
    title,
    message:`This challenge is currently in live event(s): ${_liveMutationPhrase(parts)}.<br><br>${body}<br><br>Continue?`,
    confirmText:'Continue',confirmClass:'danger',
  });
}

export function _closeAttachPicker(){
  document.getElementById('tf-attachments-picker').style.display='none';
}

export async function _uploadAttachmentNow(){
  const fileEl=document.getElementById('tf-attach-file');
  const dnameEl=document.getElementById('tf-attach-dname');
  const errEl=document.getElementById('tf-attach-error');
  const progWrap=document.getElementById('tf-attach-progress');
  const progBar=document.getElementById('tf-attach-progress-bar');
  const showErr=(m)=>{errEl.textContent=m;errEl.style.display='';};
  errEl.style.display='none';
  const file=fileEl.files[0];
  if(!file){showErr('Select a ZIP file.');return;}
  if(!/\.zip$/i.test(file.name)){showErr('Only .zip files are allowed.');return;}
  if(file.size>64*1024*1024){showErr('File exceeds 64 MB.');return;}
  if(!(await _isZipMagic(file))){showErr('Not a valid ZIP file.');return;}
  const displayName=(dnameEl.value.trim()||file.name.replace(/\.zip$/i,'')).slice(0,200)||'attachment';
  const taskId=document.getElementById('edit-task-id').value;
  // v6.13.15 — uploads always go to the staging endpoint now, not
  // directly to /api/admin/tasks/:id/attachments. Staging rows are
  // invisible to participants; promotion into task_attachments happens
  // atomically inside saveTask's PUT (edit) or POST (create). Cancel
  // fires DELETE /api/admin/attachment-staging/:id to discard cleanly.
  const url='/api/admin/attachment-staging';
  const fd=new FormData();
  fd.append('file',file);
  fd.append('display_name',displayName);
  // v8.13.4 — a token the page KNOWS it cannot use is refreshed before the send
  // (the _sessionTransitionPost pre-flight): an empty token is refused, and a
  // refused token ENDS the session that sent it — a user account's since v8.3.13,
  // the built-in superadmin's since v8.13.4.
  if(!S.csrfToken){try{await loadCsrfToken();}catch(e){console.warn('Attachment upload: CSRF token refresh failed',e);}}
  // …and one this tab's own session change, or another tab's session, replaced
  // (core/api.js `readyToWrite`): an XHR never passes the interceptor that asks
  // for every fetch.
  if(!(await readyToWrite())){if(!S._sessionOutOfDate)showErr('Could not check this tab\'s session with the server, so nothing was uploaded. Please try again.');return;}
  progWrap.style.display='';progBar.style.width='0%';
  // Registered as in flight, so a session change this tab starts meanwhile waits
  // for it (core/api.js `trackInflightWrite`); sent synchronously below.
  await trackInflightWrite(new Promise(resolve=>{
    const xhr=new XMLHttpRequest();
    xhr.upload.onprogress=e=>{if(e.lengthComputable)progBar.style.width=`${Math.round((e.loaded/e.total)*100)}%`;};
    xhr.onload=async()=>{
      progWrap.style.display='none';
      if(xhr.status>=200&&xhr.status<300){
        let body={};try{body=JSON.parse(xhr.responseText||'{}');}catch{body={};}
        // v6.13.15 — all uploads go through staging regardless of
        // mode, so the tracker is unified: one array, one cleanup
        // path, one promotion path on Save.
        S._pendingStagingAttachments.push({staging_id:body.staging_id,display_name:body.display_name,original_name:body.original_name,size_bytes:body.size_bytes});
        _closeAttachPicker();
        await _renderTaskFormAttachments();
        showToast('Attachment uploaded.','success');
      }else{
        let body={};try{body=JSON.parse(xhr.responseText||'{}')||{};}catch{body={};}
        // v8.12.6 — an XHR never passes through installFetchInterceptor, so the
        // one refusal that is a machine token rather than a sentence — the
        // impersonated organiser stopped qualifying mid-upload — is handled here
        // exactly as the interceptor handles it. Every other refusal is the
        // server's own sentence (including "your administrator access has ended,
        // so nothing was saved").
        if(xhr.status===403&&body.error==='impersonation_ended'){announceImpersonationEnded(body.reason);}
        // v8.13.4 (pre-release review) — the other refusal an XHR must handle
        // itself: a refused CSRF token has ALREADY ENDED the session (every
        // session carrying an identity, the built-in superadmin's included), so
        // the raw token over a form that still looks live was a sign-out nobody
        // announced. Announced exactly as the interceptor announces one.
        //   A 401 is a sign-out too, with ONE exception, and the exception is the
        // case v8.12.6 wrote its sentence for: the commit-time refusal
        // (`code:"admin_session_ended"`, "Your session ended before this
        // finished… if you are asked to sign in, do that first") is worded so it
        // stays TRUE when the browser still holds a live session — a view toggle
        // or an impersonation exit in another tab ends the uploading session
        // while leaving the cookie signed in — so it is the server's own sentence,
        // on the form, like every other refusal. Only its no-identity twin, which
        // carries the bare "Not authenticated", is a sign-out.
        else if(body.error==='csrf_invalid'||(xhr.status===401&&!(body.code==='admin_session_ended'&&body.error&&body.error!=='Not authenticated'))){
          if(!S._sessionExpiredHandled){S._sessionExpiredHandled=true;_stopAllPolls();await _announceSignout({kind:'unknown'},body.error||'Not authenticated');}
        }
        else showErr(body.error||'Upload failed.');
      }
      resolve();
    };
    xhr.onerror=()=>{progWrap.style.display='none';showErr('Network error.');resolve();};
    xhr.open('POST',url);
    xhr.setRequestHeader('X-CSRF-Token',S.csrfToken);
    xhr.send(fd);
  }));
}

export async function _renameSavedAttachment(taskId,aid,currentName){
  const newName=prompt('New display name:',currentName);
  if(newName==null)return;
  const trimmed=newName.trim();
  if(!trimmed||trimmed===currentName)return;
  if(!(await _confirmLiveChallengeMutation(taskId,'Rename Attachment on Live Challenge','Renaming changes what participants see on the download link immediately.')))return;
  const r=await fetch(`/api/admin/tasks/${taskId}/attachments/${aid}`,{method:'PATCH',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({display_name:trimmed})});
  if(!r.ok){const d=await r.json().catch(()=>({}));showToast(d.error||'Rename failed.','error');return;}
  await _renderTaskFormAttachments();
  showToast('Attachment renamed.','success');
}

export async function _renameStagingAttachment(stagingId,currentName){
  const newName=prompt('New display name:',currentName);
  if(newName==null)return;
  const trimmed=newName.trim();
  if(!trimmed||trimmed===currentName)return;
  const r=await fetch(`/api/admin/attachment-staging/${stagingId}`,{method:'PATCH',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({display_name:trimmed})});
  if(!r.ok){const d=await r.json().catch(()=>({}));showToast(d.error||'Rename failed.','error');return;}
  const entry=S._pendingStagingAttachments.find(x=>x.staging_id===stagingId);
  if(entry)entry.display_name=trimmed;
  await _renderTaskFormAttachments();
}

export async function _deleteSavedAttachment(taskId,aid,name){
  // v6.13.15 — modal text updated. Pre-fix it promised "preserved in
  // history and can be restored via the version timeline", which is
  // only true if a prior Save snapshot includes this attachment.
  // Post-v6.13.11 attachment mutations don't create snapshots on
  // their own, so the restore path is: revert the challenge to a
  // prior SAVED version that included the file. Docs updated to match.
  const ok=await showModal({title:'Remove attachment',message:`Remove <strong>${esc(name)}</strong> from this challenge?<br><br>The file is kept on disk. To put it back, open <strong>History</strong> and restore a saved version that included it.`,confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  if(!(await _confirmLiveChallengeMutation(taskId,'Remove Attachment from Live Challenge','Removing takes effect immediately. Participants currently on this challenge will no longer see the download link.')))return;
  const r=await fetch(`/api/admin/tasks/${taskId}/attachments/${aid}`,{method:'DELETE',headers:csrfHeaders()});
  if(!r.ok){const d=await r.json().catch(()=>({}));showToast(d.error||'Remove failed.','error');return;}
  await _renderTaskFormAttachments();
  showToast('Attachment removed.','success');
}

export async function _deleteStagingAttachment(stagingId,name){
  const ok=await showModal({title:'Discard upload',message:`Discard uploaded <strong>${esc(name)}</strong>?`,confirmText:'Discard',confirmClass:'danger'});
  if(!ok)return;
  await fetch(`/api/admin/attachment-staging/${stagingId}`,{method:'DELETE',headers:csrfHeaders()}).catch(e=>console.warn('Staged attachment not discarded',e));
  S._pendingStagingAttachments=S._pendingStagingAttachments.filter(x=>x.staging_id!==stagingId);
  await _renderTaskFormAttachments();
}

export function _discardPendingStagingAttachments(){
  if(!S._pendingStagingAttachments.length)return;
  const snapshot=S._pendingStagingAttachments.slice();
  S._pendingStagingAttachments=[];
  for(const a of snapshot){
    fetch(`/api/admin/attachment-staging/${a.staging_id}`,{method:'DELETE',headers:csrfHeaders()}).catch(e=>console.warn('Staged attachment not discarded',e));
  }
}

// The table's Columns bar (ui/table-columns.js puts it just before the table
// card) goes and comes back with the card: a Columns button under the open
// form would offer columns of a table that is not on screen.
function _taskColumnsBar(){return document.querySelector('.tcol-bar[data-tcols-for="challenges"]');}

export function showTaskFormArea(){
  document.getElementById('admin-task-form').style.display='block';
  document.getElementById('admin-task-table-card').style.display='none';
  document.getElementById('tasks-pagination').style.display='none';
  document.getElementById('task-controls-row').style.display='none';
  document.getElementById('task-filters-row').style.display='none';
  const bar=_taskColumnsBar();if(bar)bar.hidden=true;
}

export function closeTaskForm(){
  // v6.13.15 — single staging-discard path for both create and edit
  // modes. If the admin is abandoning the form with uploaded-but-not-
  // yet-promoted attachments, DELETE every staging row.
  _discardPendingStagingAttachments();
  _closeAttachPicker();
  document.getElementById('admin-task-form').style.display='none';
  document.getElementById('admin-task-table-card').style.display='';
  document.getElementById('tasks-pagination').style.display='';
  document.getElementById('task-controls-row').style.display='flex';
  document.getElementById('task-filters-row').style.display='flex';
  const bar=_taskColumnsBar();if(bar)bar.hidden=false;
}

export async function viewTaskAsParticipant(taskId){
  const t=S.adminTasksData.find(x=>x.id===taskId);
  if(!t){showToast('Challenge not found.');return;}
  // adminTasksData from /api/admin/tasks doesn't carry attachments — fetch
  // them here so the preview mirrors what a participant would see. Admin
  // session authorises both the listing and the download links, so we use
  // the admin-scoped download route to avoid requiring a competition scope.
  // v8.11.11 — the twin of the editor's read. A failure here silently omitted
  // the whole Downloads block, which is indistinguishable from a challenge that
  // has none — so the preview lied about what a participant would see.
  const attachments=await fetch(`/api/admin/tasks/${taskId}/attachments`).then(r=>r.ok?r.json():null).catch(()=>null);
  const attachmentsFailed=attachments===null;
  const attachmentsHtml=(Array.isArray(attachments)&&attachments.length)?`<div class="task-preview-attachments">
      <div class="task-preview-attachments-label">${ICO.download}Downloads</div>
      <div class="task-preview-attachments-list">
        ${attachments.map(a=>`<a href="/api/admin/tasks/${esc(taskId)}/attachments/${esc(a.id)}" class="btn secondary sm task-preview-attachment-link" download="${esc(a.display_name)}.zip" rel="noopener">${ICO.paperclip}<span class="task-preview-attach-name">${esc(a.display_name)}</span><span class="task-preview-attach-size">(${esc(_fmtBytes(a.size_bytes))})</span></a>`).join('')}
      </div>
    </div>`:(attachmentsFailed?`<div class="task-preview-attachments">
      <div class="task-preview-attachments-label">${ICO.download}Downloads</div>
      <div class="task-preview-attachments-list"><span style="color:var(--muted);font-size:var(--fs-13)">Could not load this challenge's attachments, so this preview may be missing some.</span></div>
    </div>`:'');
  // v8.12.0 — a competitor's preview says the hint is WITHHELD rather than
  // rendering nothing: an absent hint block on a challenge that has one reads as
  // "no hint", which is a wrong answer about the challenge they are competing on.
  // v8.12.2 — and a SEALED challenge's hint is withheld from a non-author
  // (`hint_withheld` rides the seal path too). The competitor reason is asked
  // FIRST: a superadmin previewing a sealed challenge they do not compete on
  // must not be told they are competing.
  const _competesPrev=Array.isArray(t.competing_in)&&t.competing_in.length>0;
  const hintHtml=t.hint_withheld?`<div class="task-preview-hint">
      <div class="task-preview-hint-label">${ICO.lightbulb} Hint</div>
      <div class="task-preview-hint-body" style="color:var(--muted)">${_competesPrev
        ?'Withheld — you are competing in an event that holds this challenge. Participants pay 30% of the points to reveal a hint, and so would you.'
        :(t.can_reveal_answer
          ?'Withheld — this challenge\'s answer is sealed, and its hint is sealed with it. Reveal the sealed answer from the row menu to see both; the reveal is recorded.'
          :'Withheld — this challenge\'s answer is sealed, and its hint is sealed with it: only the person who created it, or a superadmin who reveals it on the record, can see them.')}</div>
    </div>`:t.hint?`<div class="task-preview-hint">
      <div class="task-preview-hint-label">${ICO.lightbulb} Hint</div>
      <div class="task-preview-hint-body">${renderRich(t.hint)}</div>
    </div>`:'';
  // v7.19.0 — a multiple-choice challenge has to render its OPTIONS here, or the
  // preview shows a question with nothing to answer. And `correct_answer` holds
  // a JSON array of choice IDs for this type, so printing it raw put
  // `["4c94ea2a","b2c74eba"]` under "Correct Answer" — technically the stored
  // value, useless to the admin reading it.
  // v8.10.0 — THE SEAL, on the widest control the platform has. "View as
  // Participant" is this row's DEFAULT primary button and an unconditional kebab
  // item, emitted above every _mayEdit gate, and its own overlay advertises "hint
  // & solution revealed". One click, any admin tier, any challenge they can see.
  //
  // Nothing here is a security boundary: the server already omits `correct_answer`
  // and `explanation` from the payload for this reader. What the preview owes is
  // that the omission reads as SEALED — options with no ticks and a missing
  // Solution box would otherwise look like an unfinished challenge.
  const _sealHidden=t.can_see_answer===false;
  let _mcChoices=[],_mcCorrect=new Set(),_isChoice=t.answer_type==='choice';
  if(_isChoice){
    try{_mcChoices=JSON.parse(t.choices||'[]')||[];}catch(_){_mcChoices=[];}
    try{_mcCorrect=new Set(_sealHidden?[]:(JSON.parse(t.correct_answer||'[]')||[]));}catch(_){_mcCorrect=new Set();}
    if(!Array.isArray(_mcChoices))_mcChoices=[];
  }
  // For a sealed challenge the correct SET is unknown here, so the
  // "Select one" / "Select all that apply" line cannot be derived and is not
  // guessed — the label says the answer is sealed instead. Guessing "select one"
  // would state a fact about the key (its cardinality) that this reader was
  // refused, which is the shape of leak a preview is most likely to ship.
  const _mcMulti=_mcCorrect.size>1;
  // Author order, not the participant shuffle: this is the author checking their
  // own question, and a preview that reorders on every open would be confusing.
  const choicesHtml=_isChoice?`<div class="choice-review">
    <div class="choice-review-label">${_sealHidden?'Sealed answer — which choices are correct is shown only to the person who created it, or a superadmin who reveals it on the record:':(_mcMulti?'Select all that apply:':'Select one answer:')}</div>
    ${_mcChoices.map(c=>`<div class="choice-review-row${_mcCorrect.has(c.id)?' is-correct':''}">
      <span class="tpc-marker" aria-hidden="true">${_mcMulti?(_mcCorrect.has(c.id)?ICO.checkSquare:ICO.square):(_mcCorrect.has(c.id)?ICO.radioChecked:ICO.circle)}</span>
      <span class="tpc-text">${esc(c.text)}</span>
      ${_mcCorrect.has(c.id)?'<span class="tpc-badge">correct</span>':''}
    </div>`).join('')}
    ${_mcChoices.length?'':'<div class="settings-help" style="margin:0">This challenge has no choices — participants would see nothing to answer.</div>'}
  </div>`:_pickOneHtml(t);

  // v7.20.3 — for a choice task the options above already carry the answer
  // (marked, in context), so the Solution box's "Correct Answer" line repeated
  // it in the least useful form. Keep the box for the EXPLANATION only.
  // v8.9.0 — an any-answer challenge has no key to show; its solution box (if
  // any) is the explanation alone, as for a choice task.
  const _showsAnswer=!_sealHidden&&!!t.correct_answer&&!_isChoice&&t.answer_type!=='any';
  // The box must not become an empty shell (v7.20.4), and an admin who clicked
  // "View as Participant" expecting the solution needs to be told why there is
  // none — the affordance and its explanation together (v7.14.2).
  const sealedHtml=_sealHidden?`<div class="task-preview-solution"><h3>${ICO.solution} Solution</h3><p class="settings-help" style="margin:0">This challenge's answer is sealed. Only the person who created it — or a superadmin who reveals it, which is recorded in the challenge's history — can see the answer, the explanation or the hint. That is true here, in the challenge editor, in Submissions, in the version history and in the answers shown to participants after the event.${t.can_reveal_answer?' You can reveal it from the row menu.':''}</p></div>`:'';
  const anyHtml=t.answer_type==='any'?`<div class="settings-help" style="margin:12px 0 0">Any non-empty answer is accepted exactly as typed. This challenge has no hint and no wrong-answer penalty.</div>`:'';
  let solutionHtml='';
  if(!_sealHidden&&(_showsAnswer||t.explanation)){
    solutionHtml='<div class="task-preview-solution">';
    solutionHtml+=`<h3>${ICO.solution} Solution</h3>`;
    if(_showsAnswer){
      solutionHtml+='<div class="task-preview-solution-group"><div class="task-preview-solution-label">Correct Answer</div>';
      solutionHtml+=`<div class="task-preview-answer">${esc(formatCorrectAnswer(t))}</div></div>`;
    }
    if(t.explanation){
      solutionHtml+='<div class="task-preview-solution-group"><div class="task-preview-solution-label">Explanation</div>';
      solutionHtml+=`<div class="task-preview-explanation">${renderRich(t.explanation)}</div></div>`;
    }
    solutionHtml+='</div>';
  }
  const overlay=document.createElement('div');
  overlay.id='task-preview-overlay';
  setSafeHtml(overlay, `<div class="card" style="max-width:min(820px, calc(100vw - 32px));width:100%;max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px)" role="dialog" aria-modal="true" aria-labelledby="task-preview-title">
    <div class="task-preview-head">
      <div class="task-preview-kicker"><span style="display:inline-flex;align-items:center;gap:6px;vertical-align:-2px">${ICO.eye} ${_sealHidden?'Participant preview · answer sealed':(t.answer_type==='any'?'Participant preview · any answer is accepted':'Participant preview · hint &amp; solution revealed')}</span></div>
      <button class="btn sm secondary" data-action="task-preview-close">Dismiss</button>
    </div>
    <div class="task-preview-body">
      <div class="task-preview-meta">
        ${isQualifyingTask(t)?'<span class="pts">Quick question</span>':`<span class="badge ${esc(t.difficulty)}">${esc(t.difficulty)}</span>
        <span class="pts">+${DIFF_PTS[t.difficulty]} pts</span>`}
      </div>
      <h2 id="task-preview-title" style="margin-bottom:8px">${esc(t.title)}</h2>
      ${t.author_name?`<div class="task-preview-author">By <strong>${esc(t.author_name)}</strong>${t.author_linkedin?` &middot; <a href="${esc(t.author_linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`:''}</div>`:''}
      <div class="task-preview-desc">${renderRich(t.description||'')}</div>
      ${choicesHtml}
      ${anyHtml}
      ${attachmentsHtml}
      ${t.attachment_url&&/^https?:\/\//i.test(t.attachment_url)?`<div class="task-preview-attach"><a href="${esc(t.attachment_url)}" target="_blank" rel="noopener noreferrer" class="btn secondary sm">${ICO.paperclip} Download Attachment</a></div>`:''}
      ${hintHtml}
      ${solutionHtml}
      ${sealedHtml}
    </div>
    <div class="task-preview-foot">
      <button class="btn secondary" data-action="task-preview-close">Dismiss</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // v6.8.10: `overlayDismiss` now binds Escape itself via the module-level
  // `_modalEscStack` — the per-overlay keydown handler that used to live
  // here is redundant and was double-firing after the v6.8.10 refactor.
  overlayDismiss(overlay,()=>closeTaskPreview());
  setTimeout(()=>overlay.querySelector('[data-action="task-preview-close"]')?.focus(),0);
  // Syntax-highlight code blocks in the preview
  setTimeout(()=>{
    overlay.querySelectorAll('pre code').forEach(el=>{
      setSafeHtml(el, el.innerHTML.replace(/<br\s*\/?>/gi,'\n').replace(/<div>/gi,'\n').replace(/<\/div>/gi,''));
      el.removeAttribute('data-highlighted');
      highlightCodeElement(el);
    });
  },0);
}

export function closeTaskPreview(){
  const overlay=document.getElementById('task-preview-overlay');
  if(overlay)overlay.remove();
}

// v8.10.0 — THE SEAL, CLIENT SIDE. Three jobs, and only the third is a gate.
//
// (1) CREATE offers the checkbox. (2) EDIT hides it and, for the AUTHOR, offers
// Unseal instead — the one transition the server permits. (3) For a reader who may
// NOT see the answer the form says so rather than showing an empty box.
//
// (3) IS NOT THE SECURITY BOUNDARY AND MUST NOT BE MISTAKEN FOR ONE. The server
// omits `correct_answer` and `explanation` from the payload entirely
// (routes/challenges.js), so there is nothing here to hide — `S` is mirrored onto
// `window`, so a renderer-level blank would be readable from the console anyway.
// What this code owes is that the ABSENCE reads as "sealed" rather than as "empty",
// and — the part with teeth — that a save never posts a value it never received.
// v8.12.1 — the sentence the server answers a seal-by-proxy with (lib/answer-seal.js
// `answer_seal_not_by_proxy`), rendered BESIDE the control rather than after a
// failed save: inside an impersonated panel the seat would become the author of
// a key somebody else typed, so the server is certain to refuse the tick, and a
// control the server is certain to refuse is withheld WITH its reason (v7.14.2).
// A READ-ONLY FORM'S RICH TEXT BOXES SAY WHY, under their (switched-off) toolbars
// (`setReadOnly`, ui/richtext.js). Each reason follows the predicate of the door it
// names: the lock's, the row menu's Unlock (`adminCan('challenges.lock')`, not
// competing); the seal's, the reveal `#tf-sealed-note` offers (`can_reveal_answer`,
// and inside an organiser's panel what the reveal does not grant); otherwise the
// server's own refusal.
const _TF_RO_LOCKED_UNLOCK="Read-only: this challenge is locked. Unlock it from its row's ⋯ menu to edit it.";
const _TF_RO_LOCKED="Read-only: this challenge is locked, and only a superadmin can unlock it.";
const _TF_RO_SEALED="Read-only: its answer is sealed, so only the person who created it can edit it.";
const _TF_RO_SEALED_REVEAL="Read-only: its answer is sealed. Reveal it (recorded) to see and edit it.";
const _TF_RO_SEALED_REVEAL_PANEL="Read-only: its answer is sealed. Revealing it shows it to you; editing still follows this organiser's rules.";
const _TF_RO_COMPETING="Read-only: you are competing in an event that holds this challenge.";
const _TF_RO_NOT_MINE="Read-only: you can only edit challenges you created.";
const _TF_RO_LOCKED_NOT_MINE="Read-only: this challenge is locked, and you can only edit challenges you created.";
const _tfCompetes=t=>Array.isArray(t.competing_in)&&t.competing_in.length>0;
function _tfSealedReason(t){
  if(_tfCompetes(t))return _TF_RO_COMPETING;
  if(t.can_reveal_answer)return S.isEventAdmin?_TF_RO_SEALED_REVEAL_PANEL:_TF_RO_SEALED_REVEAL;
  return _TF_RO_SEALED;
}
export function _tfLockedReason(t){
  // Unlocking helps only a reader who could then edit it: never promise it to one
  // who may not edit this challenge anyway (not theirs), whose reason is both.
  if(t.can_edit===false&&S._tfAnswerVisible!==false)return _TF_RO_LOCKED_NOT_MINE;
  const base=(adminCan('challenges.lock')&&!_tfCompetes(t))?_TF_RO_LOCKED_UNLOCK:_TF_RO_LOCKED;
  if(S._tfAnswerVisible!==false)return base;
  return `${base} ${_tfCompetes(t)?'You are also competing in an event that holds it.':'Its answer is also sealed by the person who created it.'}`;
}
/** The three rich bodies go read-only (with `reason`) or editable (null) together. */
function _tfRichReadOnly(reason,also){for(const ed of [descEditor,explanationEditor,hintEditor])ed.setReadOnly(reason,{also});}
const _TF_SEAL_PROXY_NOTE="A sealed answer belongs to the person who typed it, and you are creating this challenge through another organiser's panel — so it cannot be sealed from here. Exit impersonation and create it from your own account, or leave the answer unsealed.";
function _tfSealSetCreateMode(){
  const g=document.getElementById('tf-seal-group'); if(g)g.style.display='';
  const proxy=!!S.impersonation;
  const cb=document.getElementById('tf-answer-seal'); if(cb){cb.checked=false;cb.disabled=proxy;}
  const sn=document.getElementById('tf-seal-note');
  if(sn){
    if(!sn.dataset.defaultText)sn.dataset.defaultText=sn.textContent;
    sn.textContent=proxy?_TF_SEAL_PROXY_NOTE:sn.dataset.defaultText;
    // v8.17.0 — the note sits behind the "?" beside the switch. A withheld
    // switch shows its reason at once (the affordance and its explanation
    // together); otherwise it opens on the "?" (or with "Show all tips").
    const open=proxy||tipsAllOn();
    sn.hidden=!open;
    document.getElementById('tf-seal-tip')?.setAttribute('aria-expanded',open?'true':'false');
  }
  const un=document.getElementById('tf-unseal-row'); if(un)un.hidden=true;
  const note=document.getElementById('tf-sealed-note'); if(note)note.hidden=true;
  const rv=document.getElementById('tf-reveal-row'); if(rv)rv.hidden=true; // v8.12.2
  S._tfAnswerVisible=true;
  S._tfAnswerSealed=false;
  S._tfHintWithheld=false; // v8.12.2 — a create form never withholds; saveTask reads this
  // v8.10.1 — the form may open on a remembered answer type, so decide the
  // seal/type pair now rather than waiting for the first change event.
  _tfSealSyncWithType();
}

/** Edit mode: the checkbox goes, and what replaces it depends on who is asking. */
function _tfSealSetEditMode(t){
  const g=document.getElementById('tf-seal-group'); if(g)g.style.display='none';
  const sealed=!!t.answer_sealed;
  // `can_see_answer` is the SERVER's answer to "may this caller read the key" —
  // never re-derived here, for the v8.7.0 reason: the client cannot see
  // `created_by_id`, and a second copy of the rule is one edit away from posting a
  // blank over a value it was refused. Absent (an older payload) reads as visible,
  // so a stale client behaves exactly as it did before this release.
  S._tfAnswerVisible=t.can_see_answer!==false;
  S._tfAnswerSealed=sealed;
  const note=document.getElementById('tf-sealed-note');
  // v8.12.0 — a COMPETITOR's reason comes first: the seal note would tell a
  // superadmin the author rule binds them when it is their own enrolment that
  // does (the v8.10.1 wrong-reason lesson).
  const _competingIn=Array.isArray(t.competing_in)?t.competing_in:[];
  if(note){
    note.hidden=!(sealed||_competingIn.length);
    // The remedy mirrors the server's (`_competitorRemedy`): self-removal is
    // refused once an event has ended, so it is offered only while EVERY event
    // named here can still be left (each entry carries the event's status).
    const _leavable=_competingIn.length&&_competingIn.every(c=>c.status!=='ended');
    note.textContent=_competingIn.length
      ? `You are competing in ${_competingIn.map(c=>`“${c.name}”`).join(', ')}, which holds this challenge, so it is read-only for you: its answer, explanation and hint are withheld, and only another organiser can change it.${_leavable?' Remove yourself from the event to edit it again.':''}`
      : S._tfAnswerVisible
      ? (t.answer_revealed
          ? 'The answer to this challenge is sealed. You can see and change it — the answer, the explanation and the hint — because you revealed it as a superadmin, and that reveal is recorded in the challenge\'s history. Participants are never shown it, even when the event reveals answers.'
          : 'The answer to this challenge is sealed: you can see and change it because you created it. Nobody else can — not other organisers, not administrators — except a superadmin who reveals it, which is recorded in the challenge\'s history. Participants are never shown it, even when the event reveals answers.')
      : (t.can_reveal_answer
          ? "This challenge's answer is sealed by the person who created it. The answer, the explanation and the hint are not shown to anyone else. As a superadmin you can reveal them and then edit this challenge; the reveal is recorded in the challenge's history, naming you."
          : "This challenge's answer is sealed by the person who created it. The answer, the explanation and the hint are not shown to anyone else, and only they — or a superadmin who reveals them on the record — can edit this challenge.");
  }
  // v8.12.2 — THE REVEAL CONTROL, inside the editor beside the note. A real
  // `<button>` OUTSIDE the read-only sweep's selectors (`_tfSealApplyReadOnly`
  // disables every input/select/textarea and the choice/answer buttons, and
  // would otherwise disable this too); toggled with `hidden`, never `disabled`,
  // for the same reason. Offered exactly where the row says the server would
  // accept it — `can_reveal_answer` is the acting human's live tier, so a
  // superadmin in an organiser's impersonated panel gets it while
  // `S.isSuperAdmin` reads false there. Hidden again by `_tfSealSetCreateMode`.
  const rv=document.getElementById('tf-reveal-row');
  if(rv){rv.hidden=!(sealed&&t.can_reveal_answer);const rb=rv.querySelector('button');if(rb)rb.dataset.taskId=t.id||'';}
  // Unseal is offered only to the author, and only while it is sealed — the one
  // direction the server accepts (lib/answer-seal.js, sealChangeDenied).
  // v8.12.0 — and NOT while the challenge sits in an event where staff compete,
  // at any status of that event: the server refuses that save
  // (`answer_seal_in_compete_event`), so the control is withheld with the reason
  // rather than offered where the save is certain to be refused. The row's
  // `competitions[]` carries `staff_compete` for exactly this — and, for an
  // event admin, that array is narrowed to the events they organise, so the
  // row ALSO says whether a withheld event competes (`withheld_compete`): an
  // author whose sealed challenge sits only in somebody else's compete event
  // is withheld the tick too, rather than offered a save the scoped 409
  // refuses with "(N outside your events)".
  const _sealHeld=(Array.isArray(t.competitions)?t.competitions:[]).filter(c=>c&&c.staff_compete);
  const _sealHeldAway=t.withheld_compete?(t.withheld_competition_count||1):0;
  const _sealHeldAny=_sealHeld.length>0||_sealHeldAway>0;
  const un=document.getElementById('tf-unseal-row');
  if(un)un.hidden=!(sealed&&S._tfAnswerVisible&&!_sealHeldAny);
  const unNote=document.getElementById('tf-unseal-held-note');
  if(unNote){
    unNote.hidden=!(sealed&&S._tfAnswerVisible&&_sealHeldAny);
    // The remedy follows FROZEN_REMEDY: unassigning from an ENDED event is refused
    // by the ended-session freeze, so "take it out first" is offered only while
    // every holding event can still be left; otherwise the note says the seal
    // stays for as long as the assignment does (the stated v8.12.0 cost). An
    // event outside the actor's scope is never theirs to take it out of, so
    // with any of those the remedy is that event's organiser, or the seal.
    if(_sealHeldAny){
      const _parts=_sealHeld.map(c=>`“${c.name}”`);
      if(_sealHeldAway)_parts.push(`${_sealHeldAway} event${_sealHeldAway>1?'s':''} outside your events`);
      const _names=_parts.join(', ');
      const _plural=(_sealHeld.length+_sealHeldAway)>1;
      const _leavable=!_sealHeldAway&&_sealHeld.every(c=>c.status!=='ended');
      const _allEnded=!_sealHeldAway&&_sealHeld.every(c=>c.status==='ended');
      unNote.textContent=`The answer stays sealed while this challenge is in ${_names}, where staff compete — such an event only admits sealed challenges. `+(_leavable
        ?`Take it out of ${_plural?'those events':'that event'} first, or leave the answer sealed.`
        :_allEnded
        ?`${_plural?'A finished event\u2019s':'The finished event\u2019s'} challenge list cannot be changed, so it stays sealed for as long as it stays assigned.`
        :`Only ${_sealHeldAway?'that event\u2019s organiser':'another organiser'} can take it out, so it stays sealed for as long as it stays assigned.`);
    }
  }
  const uc=document.getElementById('tf-unseal');
  if(uc){uc.checked=false;uc.disabled=false;}
  // v8.10.1 — S._tfAnswerSealed is set above, so the free-response option is
  // disabled for a sealed challenge from the moment the editor opens rather
  // than on the first type change (which, for a form nobody touches, never
  // comes). `tfSyncAnswerType` calls this too, so the two stay in step.
  _tfSealSyncWithType();
}

/**
 * A READER WHO MAY NOT SEE THE ANSWER MAY NOT SAVE EITHER, and the form says so
 * rather than letting them type into it and meet a 403.
 *
 * SEPARATE FROM `_tfSealSetEditMode` BECAUSE OF ORDERING, not tidiness. That
 * helper runs EARLY — the three answer-prefill branches read `S._tfAnswerVisible`
 * — while `editTask` afterwards re-enables every input and re-shows the Save
 * button (it has to: the previous open may have left a LOCKED challenge's form
 * disabled). So the read-only pass has to run at the END, beside the `t.locked`
 * branch it mirrors.
 *
 * The server refuses the whole PUT for such a caller (it is the author or
 * nobody), so this is the affordance following the rule rather than a second
 * gate. It is reachable only through `window.editTask`: `can_edit` is false, so
 * the kebab renders no Edit item at all. The rich bodies go read-only through
 * their editors' `setReadOnly`, which also switches their toolbars off with the
 * reason (`_tfSealedReason`, beside `#tf-sealed-note` as its description).
 */
function _tfSealApplyReadOnly(t){
  if(S._tfAnswerVisible!==false)return;
  _tfFormReadOnly(_tfSealedReason(t),'tf-sealed-note');
}
// The read-only form: every field and button disabled, Save hidden, and the rich
// bodies read-only through their editors' `setReadOnly`, which also switches their
// toolbars off with the reason.
function _tfFormReadOnly(reason,also){
  document.querySelectorAll('#admin-task-form input,#admin-task-form select,#admin-task-form textarea,#tf-choices-list button,#tf-add-choice,#tf-answers-extra button,#tf-add-answer,#tf-topic-new')
    .forEach(el=>{el.disabled=true;});
  _tfRichReadOnly(reason,also);
  const sb=document.getElementById('save-task-btn'); if(sb)sb.style.display='none';
}

// v8.17.0 — THE COMPACT EDITOR'S OWN PARTS. Presentation only: every value the
// save path reads still lives in the same element it always did (#tf-diff, the
// three rich editors, #tf-attach, the author inputs), so none of the rules in
// saveTask / editTask moved.

/** The long explanations behind the editor's "?" tips (registered at boot). */
export const CHALLENGE_EDITOR_TIPS={
  "challenge.attempts":"Optional. Leave it blank for no limit. A number from 1 to 1000 caps how many answers each participant may submit on this challenge, and it overrides the event's own limit. Organisers can grant more attempts later.",
  "challenge.choices":"Tick every choice that is correct. One correct choice shows participants radio buttons; two or more show checkboxes. The order is shuffled per participant. At a Booth Event on a phone, participants tap large lettered tiles instead: a short question with a few short choices fits one screen; with more than 6 choices, or any longer than 90 characters, the screen always scrolls.",
  "challenge.attachments":"ZIP files only, at most 64 MB each and up to 10 per challenge. Uploads stay invisible to participants until you save; Cancel discards them. A link points participants at a download hosted elsewhere.",
  "challenge.topic":"The topic this question is filed under in the Question bank. Participants see it on the question as its category. A question has one topic; manage the list with Topics on the Question bank page.",
  "challenge.shared":"On: every event organiser on the platform can find this bank question and use it in their own events, even though they did not create it. Off: only you, administrators and the events using it.",
};

// ── Stage B — TOPIC AND SHARING (the controls that replace the tag box) ──────
// The topic is a field of the question (`topic_id`, sent with the save). The
// shared switch and the needs choices write the stored markers the tag routes
// write (`public-domain`, `needs:<what>`), after the save, so every rule those
// routes ask (owner, seal, fit, near miss) still decides. Free-form tags are
// neither shown nor changed.
//
// KNOWN_NEEDS mirrors lib/challenge-fit.js KNOWN_NEEDS (keys and wording;
// held by tests/topics-ui.spec.js). A `needs:` marker the question carries that
// is not in it is listed by its own name, so it can be cleared.
export const KNOWN_NEEDS=Object.freeze({cxone:"a CxOne account",desktop:"a desktop computer"});
function _tfOwnedByEvent(t){return t?!!t.owner_competition_id:!!S.adminSelectedCompetitionId;}
function _tfOrgFill(t){
  renderTopicPicker(t?(t.topic_id||null):null);
  const tags=(t&&Array.isArray(t.tags))?t.tags.slice():[];
  S._tfOrgTags=tags;
  const ev=_tfOwnedByEvent(t);
  const sg=document.getElementById('tf-shared-group');if(sg)sg.hidden=ev;
  const sn=document.getElementById('tf-shared-note');if(sn)sn.hidden=!ev;
  const sh=document.getElementById('tf-shared');if(sh)sh.checked=tags.includes(PUBLIC_DOMAIN_TAG);
  const needs=Object.entries(KNOWN_NEEDS);
  for(const tg of tags){if(String(tg).startsWith('needs:')){const k=String(tg).slice(6);if(k&&!needs.some(n=>n[0]===k))needs.push([k,k]);}}
  const list=document.getElementById('tf-needs-list');
  if(list)setSafeHtml(list,needs.map(([k,label])=>`<label class="checkbox-row"><input type="checkbox" data-need="${esc(k)}" data-change-action="task-org-sync"${tags.includes('needs:'+k)?' checked':''}/><span>${esc(label)}</span></label>`).join(''));
  tfOrgSync();
}
/** The collapsed row's one-line summary of what it holds. */
export function tfOrgSync(){
  const sel=document.getElementById('tf-topic');
  const name=sel&&sel.value?(sel.options[sel.selectedIndex]?.textContent||''):'';
  const parts=[name||'No topic'];
  const sg=document.getElementById('tf-shared-group');
  if(sg&&!sg.hidden&&document.getElementById('tf-shared')?.checked)parts.push('Shared');
  const n=document.querySelectorAll('#tf-needs-list input[data-need]:checked').length;
  if(n)parts.push(n===1?'1 need':`${n} needs`);
  const el=document.getElementById('tf-org-sum');if(el)el.textContent=parts.join(' · ');
}
/** The marker changes the form asks for, applied through the tag routes. */
async function _tfApplyOrgTags(taskId){
  const before=new Set(S._tfOrgTags||[]);
  const ops=[];
  const sg=document.getElementById('tf-shared-group'),sh=document.getElementById('tf-shared');
  if(sg&&!sg.hidden&&sh&&!sh.disabled){
    if(sh.checked&&!before.has(PUBLIC_DOMAIN_TAG))ops.push(['add',PUBLIC_DOMAIN_TAG]);
    if(!sh.checked&&before.has(PUBLIC_DOMAIN_TAG))ops.push(['del',PUBLIC_DOMAIN_TAG]);
  }
  document.querySelectorAll('#tf-needs-list input[data-need]').forEach(cb=>{
    if(cb.disabled)return;
    const tag='needs:'+cb.dataset.need;
    if(cb.checked&&!before.has(tag))ops.push(['add',tag]);
    if(!cb.checked&&before.has(tag))ops.push(['del',tag]);
  });
  const failed=[];
  for(const [op,tag] of ops){
    const r=op==='add'
      ?await fetch(`/api/admin/tasks/${encodeURIComponent(taskId)}/tags`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({tag})})
      :await fetch(`/api/admin/tasks/${encodeURIComponent(taskId)}/tags/${encodeURIComponent(tag)}`,{method:'DELETE',headers:csrfHeaders()});
    if(!r.ok){const d=await r.json().catch(()=>({}));failed.push(d.error||'A sharing or needs change was refused.');}
  }
  return failed;
}

/** Difficulty: the segmented radios mirror the hidden #tf-diff select. */
function _tfDiffSync(){
  const sel=document.getElementById('tf-diff');
  if(!sel)return;
  document.querySelectorAll('input[name="tf-diff-seg"]').forEach(r=>{r.checked=r.value===sel.value;r.disabled=sel.disabled;});
}
export function tfSetDifficulty(v){
  const sel=document.getElementById('tf-diff');
  if(!sel||sel.disabled||!['easy','medium','hard'].includes(v))return;
  sel.value=v;
  _tfDiffSync();
}

const _TF_SECS=[
  {toggle:'[aria-controls="tf-hint-body"]',body:'tf-hint-body'},
  {toggle:'[aria-controls="tf-explanation-body"]',body:'tf-explanation-body'},
  {toggle:'[aria-controls="tf-author-body"]',body:'tf-author-body'},
  {toggle:'#tf-attach-url-toggle',body:'tf-attach-url-body'},
  {toggle:'[aria-controls="tf-org-body"]',body:'tf-org-body'},
];
function _tfRichText(id){return (document.querySelector(`#${id} .rich-body`)?.textContent||'').replace(/\s+/g,' ').trim();}
/** One-line summaries on the collapsed rows, so a filled row says what it holds. */
function _tfSecSync(){
  const set=(id,txt)=>{const el=document.getElementById(id);if(el)el.textContent=txt;};
  const hint=_tfRichText('tf-hint');
  set('tf-hint-sum',hint||'+ Add hint');
  const expl=_tfRichText('tf-explanation');
  set('tf-explanation-sum',S._tfAnswerVisible===false?'Sealed — not shown to you':(expl||'+ Add explanation'));
  const an=(document.getElementById('tf-author-name')?.value||'').trim();
  const al=(document.getElementById('tf-author-linkedin')?.value||'').trim();
  set('tf-author-sum',an||(al?'LinkedIn only':'+ Add author'));
  const url=(document.getElementById('tf-attach')?.value||'').trim();
  const ub=document.getElementById('tf-attach-url-toggle');
  if(ub)ub.textContent=url?'Link: '+url:'+ Link';
}
function _tfSecSetOpen(btn,body,open){
  btn.setAttribute('aria-expanded',open?'true':'false');
  body.hidden=!open;
  btn.closest('.ce-sec')?.classList.toggle('is-open',open);
}
/** Toggle a collapsible row in place (the `task-sec-toggle` action). */
export function tfToggleSection(btn){
  const body=btn&&document.getElementById(btn.getAttribute('aria-controls')||'');
  if(!body)return;
  const open=btn.getAttribute('aria-expanded')!=='true';
  _tfSecSetOpen(btn,body,open);
  _tfSecSync();
  if(open)setTimeout(()=>{const f=body.querySelector('.rich-body[contenteditable="true"],input:not([disabled])');f?.focus();},0);
}
/** Every row closed, except the link field when it holds a value (it is one line). */
function _tfSecReset(){
  const form=document.getElementById('admin-task-form');
  for(const s of _TF_SECS){
    const btn=form?.querySelector(s.toggle);const body=document.getElementById(s.body);
    if(btn&&body)_tfSecSetOpen(btn,body,false);
  }
  _tfSecSync();
}
function _tfAttachCountSync(n){
  const el=document.getElementById('tf-attach-count');
  if(el)el.textContent=n===null?'':`(${n})`;
}

// Event team reports — the pick-one options typed one per line. Answers are
// stored by option id, so an option keeps its id when edited (operator ruling
// 84, 14 Nov 2026): `_anyOptionsFromForm` gives a line the id of the stored
// option with the same text (case-folded), wherever it now stands, and a line
// whose text is new the id of the stored option that stood on that line — a
// reword in place is the same option — when every stored option is accounted
// for that way (none was removed). Every other line is new.
// The preview of a pick-one question: its options in author order, none marked
// (every option is accepted).
function _pickOneHtml(t){
  if(t.answer_type!=='any')return '';
  let opts=[];try{opts=JSON.parse(t.choices||'[]')||[];}catch(_){opts=[];}
  if(!Array.isArray(opts)||opts.length<2)return '';
  return `<div class="choice-review">
    <div class="choice-review-label">Choose one — every answer is accepted:</div>
    ${opts.map(c=>`<div class="choice-review-row"><span class="tpc-marker" aria-hidden="true">${ICO.circle}</span><span class="tpc-text">${esc(c.text)}</span></div>`).join('')}
  </div>`;
}

function _anyOptionsFromForm(){
  const stored=S._tfAnyChoices||[];
  const byText=new Map(stored.map(c=>[String(c.text).trim().toLowerCase(),c.id]));
  const lines=String(document.getElementById('tf-any-options')?.value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const used=new Set();
  // An unchanged option keeps its id wherever it now stands…
  const out=lines.map(text=>{const id=byText.get(text.toLowerCase());if(id&&!used.has(id)){used.add(id);return {id,text};}return {text};});
  // …and a reworded line keeps the id of the option that stood on that line,
  // but only when that accounts for EVERY stored option no line names: each
  // stood where a line with new text now is. Otherwise one was removed, and
  // which line rewords which is a guess (removing Alpha and rewording Bravo
  // would hand "Bravo two" Alpha's identity, and Alpha's answers with it), so
  // every line with new text is a new option.
  const unnamed=stored.map((s,i)=>i).filter(i=>!used.has(stored[i].id));
  if(unnamed.every(i=>out[i]&&!out[i].id))for(const i of unnamed)out[i].id=stored[i].id;
  return out;
}

// Operator ruling 84 — once anyone has answered a qualifying question
// (`options_fixed`, the server's answer), every stored option keeps its place:
// the editor says so beside the box, and checks before saving what the server
// refuses (a move, a removal, an option added anywhere but the end).
const _TF_OPTIONS_FIXED_NOTE='People have answered this qualifying question, so its options keep their places: you can reword an option or add one at the end, but not move or remove one.';
function _tfOptionsFixedSync(fixed){
  S._tfOptionsFixed=!!fixed;
  const n=document.getElementById('tf-any-options-note');
  if(n){n.hidden=!fixed;n.textContent=fixed?_TF_OPTIONS_FIXED_NOTE:'';}
}
function _tfOptionsFixedBroken(){
  if(!S._tfOptionsFixed)return false;
  const next=_anyOptionsFromForm();
  return (S._tfAnyChoices||[]).some((c,i)=>!next[i]||next[i].id!==c.id);
}

export function openTaskForm(){
  ['tf-title','tf-answer','tf-attach','tf-author-name','tf-author-linkedin','tf-any-options'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  S._tfAnyChoices=[];_tfOptionsFixedSync(false);
  descEditor.setHtml('');explanationEditor.setHtml('');hintEditor.setHtml('');
  document.getElementById('tf-diff').value='easy';document.getElementById('tf-atype').value='text';
  document.getElementById('tf-attempt-cap').value='';
  S._tfChoices=[];S._tfExtraAnswers=[];S._tfEditUpdatedAt=null;tfSyncAnswerType();
  // v8.10.0 — the seal is a CREATE-time choice, so the block is shown here and
  // hidden by editTask. Unticked on every open: a form that remembered the last
  // answer would seal a challenge nobody meant to seal, and the decision is
  // irreversible in the sealing direction.
  _tfSealSetCreateMode();
  document.getElementById('edit-task-id').value='';document.getElementById('task-form-title').textContent='New question';
  clearTaskFormErrors();
  document.getElementById('task-feedback-section').style.display='none';
  // Show draft/publish buttons for new tasks
  document.getElementById('save-draft-btn').style.display='';
  document.getElementById('save-publish-btn').style.display='';
  document.getElementById('save-task-btn').style.display='none';
  // Re-enable form inputs (may have been disabled by a locked task)
  document.querySelectorAll('#admin-task-form input,#admin-task-form select,#admin-task-form textarea').forEach(el=>{el.disabled=false;});
  {const _tn=document.getElementById('tf-topic-new');if(_tn)_tn.disabled=false;}
  _tfOrgFill(null);
  _tfRichReadOnly(null);
  // v8.9.0 — the two static ADD buttons are disabled by the scoring-locked path
  // below and are neither inputs nor re-rendered, so without this a read-only
  // edit left them dead for every later open until a reload.
  ['tf-add-choice','tf-add-answer'].forEach(id=>{const b=document.getElementById(id);if(b){b.disabled=false;delete b.dataset.capDisabled;}});
  // A new challenge offers its attachments again (a read-only open hid the add button).
  {const _ab=document.getElementById('tf-attach-add-btn');if(_ab)_ab.style.display='';}
  // v8.12.1 — the blanket re-enable above runs AFTER `_tfSealSetCreateMode`
  // and would undo the seal tick's proxy lock (the v8.10.0 ordering trap, one
  // function over: `editTask` had the same shape), so the seal/type pair is
  // re-decided here, last, where nothing can re-enable it again.
  _tfSealSyncWithType();
  // Reset the attachments section — nothing staged yet for the new draft.
  S._pendingStagingAttachments=[];
  _closeAttachPicker();
  _renderTaskFormAttachments();
  _tfDiffSync();_tfSecReset();   // v8.17.0 — the compact editor's segmented control and rows
  showTaskFormArea();
  setTimeout(()=>document.getElementById('tf-title')?.focus(),0);
}

export async function editTask(id){
  const t=S.adminTasksData.find(x=>x.id===id);
  if(!t){
    // Task not in cached list (just deleted, race with another admin, etc.).
    // Don't leave the editor open with stale data + re-enabled inputs from the
    // previous edit — close the form and surface the gap.
    closeTaskForm?.();
    showToast('That challenge is no longer available. The list has been refreshed.','error');
    loadAdminTasks?.();
    return;
  }
  // v8.14.5 — the concurrency token belongs to the row the form is filled FROM,
  // taken here, in the same step (see S._tfEditUpdatedAt).
  S._tfEditUpdatedAt=t.updated_at||null;
  // Re-enable form inputs first (may have been disabled by a previous locked task)
  document.querySelectorAll('#admin-task-form input,#admin-task-form select,#admin-task-form textarea').forEach(el=>{el.disabled=false;});
  _tfRichReadOnly(null);
  ['tf-add-choice','tf-add-answer'].forEach(id=>{const b=document.getElementById(id);if(b){b.disabled=false;delete b.dataset.capDisabled;}});   // v8.9.0 — see openTaskForm
  {const _tn=document.getElementById('tf-topic-new');if(_tn)_tn.disabled=false;}
  _tfOrgFill(t);
  document.getElementById('edit-task-id').value=t.id;document.getElementById('tf-title').value=t.title;
  descEditor.setHtml(t.description||'');document.getElementById('tf-diff').value=t.difficulty;
  document.getElementById('tf-attempt-cap').value=(Number.isInteger(t.attempt_cap)&&t.attempt_cap>0)?String(t.attempt_cap):'';
  document.getElementById('tf-atype').value=t.answer_type;
  // v7.19.0 — for a choice task, correct_answer holds a JSON array of the
  // correct choice IDs, not a human answer; rehydrate the editor from it rather
  // than dumping the raw JSON into the plain Correct Answer input.
  // v8.10.0 — resolve the seal FIRST: the three prefill branches below all read
  // `S._tfAnswerVisible`, and the choice branch in particular must not mark any
  // option correct for a reader the server withheld the key from.
  _tfSealSetEditMode(t);
  if(t.answer_type==='choice'){
    let parsed=[];try{parsed=JSON.parse(t.choices||'[]');}catch(_){parsed=[];}
    // A sealed challenge arrives with NO `correct_answer` (the server omits it),
    // so `cset` is empty and no option is ticked — which is the true rendering,
    // not a blanked one. `choices` itself still ships: the option TEXT is what a
    // participant is shown and carries no correctness.
    let correctIds=[];try{correctIds=JSON.parse(t.correct_answer||'[]');}catch(_){correctIds=[];}
    const cset=new Set(S._tfAnswerVisible&&Array.isArray(correctIds)?correctIds:[]);
    S._tfChoices=(Array.isArray(parsed)?parsed:[]).map(c=>({id:c.id,text:c.text,correct:cset.has(c.id)}));
    S._tfExtraAnswers=[];
    document.getElementById('tf-answer').value='';
  }else if(t.answer_type==='text'){
    // v8.9.0 — a text key is a newline-separated LIST: the first line is the
    // Correct Answer box, the rest are the additional-answer rows.
    const lines=String(t.correct_answer||'').split(/\r?\n/);
    S._tfChoices=[];
    document.getElementById('tf-answer').value=lines[0]||'';
    S._tfExtraAnswers=lines.slice(1).filter(l=>l.trim());
  }else{
    S._tfChoices=[];S._tfExtraAnswers=[];
    // `any` stores "" (no key); file/json store the one string.
    document.getElementById('tf-answer').value=t.answer_type==='any'?'':(t.correct_answer||'');
  }
  // Event team reports — a pick-one question's options, one per line; the ids
  // are kept by matching text on save, so an untouched option keeps its identity.
  {
    let _anyOpts=[];
    if(t.answer_type==='any'){try{_anyOpts=JSON.parse(t.choices||'[]')||[];}catch(_){_anyOpts=[];}}
    S._tfAnyChoices=Array.isArray(_anyOpts)?_anyOpts:[];
    const _ta=document.getElementById('tf-any-options');
    if(_ta)_ta.value=S._tfAnyChoices.map(c=>c.text).join('\n');
    _tfOptionsFixedSync(t.answer_type==='any'&&t.options_fixed===true);
  }
  tfSyncAnswerType();
  explanationEditor.setHtml(t.explanation||'');
  hintEditor.setHtml(t.hint||'');document.getElementById('tf-attach').value=t.attachment_url||'';
  // v8.12.0 — the HINT is withheld from a competitor (`hint_withheld`, see
  // routes/challenges.js: it is not a sealed field and a participant pays for
  // it). The editor is HIDDEN rather than left empty — an empty box reads as
  // "no hint", which is a wrong answer about a challenge this reader cannot
  // edit anyway — and tfSyncAnswerType re-shows it, so this runs after it.
  // v8.12.2 — and from a NON-AUTHOR of a sealed challenge (the hint is sealed
  // with the answer; the same marker rides both paths). `S._tfHintWithheld`
  // is what stops saveTask posting the empty editor as `hint:''` — the PUT
  // writes `hint` whenever the key is PRESENT, so an empty box would wipe a
  // hint this reader was never shown (the v8.10.0 hazard, one field over).
  S._tfHintWithheld=!!t.hint_withheld;
  { const hg=document.getElementById('tf-hint-group'); if(hg&&t.hint_withheld)hg.style.display='none'; }
  document.getElementById('tf-author-name').value=t.author_name||'';
  document.getElementById('tf-author-linkedin').value=t.author_linkedin||'';
  // Edit mode (v6.13.15) — same staging pipeline as create mode.
  // Fresh session starts with no pending uploads so Cancel correctly
  // discards only uploads made DURING this session.
  S._pendingStagingAttachments=[];
  _closeAttachPicker();
  _renderTaskFormAttachments();
  document.getElementById('task-form-title').textContent='Edit question';clearTaskFormErrors();
  // For editing existing, show generic save
  document.getElementById('save-draft-btn').style.display='none';
  document.getElementById('save-publish-btn').style.display='none';
  document.getElementById('save-task-btn').style.display='';
  // v8.8.5 — the SCORING fields follow the strict gate too. Edit stays offered
  // (the PUT is keyed on what CHANGED, so a title fix is legal on a shared
  // challenge) but the fields the server would refuse are disabled WITH their
  // reason, rather than accepted and then 409'd on save.
  if(t.can_edit_scoring===false){
    // The pick-one Options box too: the PUT counts an options change as a
    // scoring edit (`_scoringTouched`), so offering it here would be refused.
    for(const id of ['tf-diff','tf-attempt-cap','tf-atype','tf-answer','tf-add-choice','tf-add-answer','tf-any-options']){
      const el=document.getElementById(id); if(el)el.disabled=true;
    }
    document.querySelectorAll('#tf-choices-list input,#tf-choices-list button,#tf-choices-list select,#tf-answers-extra input,#tf-answers-extra button')
      .forEach(el=>{el.disabled=true;});
  }
  const _scNote=document.getElementById('tf-scoring-locked-note');
  if(_scNote){
    // Not on a form that is read-only as a whole (not theirs, sealed, a competitor's,
    // locked): it would say the rest can still be edited.
    _scNote.hidden=t.can_edit_scoring!==false||t.can_edit===false||!!t.locked;
    _scNote.textContent="Another organiser's event is scoring on this challenge, so its difficulty, answer, options and attempt limit are fixed. You can still edit the title, description, explanation, hint and attachments.";
  }
  // v8.10.0 — after the re-enable pass above, and before the lock branch below,
  // which layers on top for a challenge that is both sealed and locked.
  _tfSealApplyReadOnly(t);
  // A challenge this reader may not edit for any other reason (`can_edit` false:
  // "You can only edit challenges you created", an organiser's own-challenge rule)
  // is read-only too, rather than offering a Save the PUT refuses. The seal pass
  // above already answered a withheld one, and the lock below layers on top.
  if(t.can_edit===false&&S._tfAnswerVisible!==false)_tfFormReadOnly(_TF_RO_NOT_MINE);
  // v8.12.0 — a COMPETITOR's editor also loses the attachment writes: the seal
  // deliberately leaves attachments editable (they are not the answer), but the
  // three attachment routes are competitor doors, so the add button and every
  // chip's Rename/Remove go — Download stays. So does the editor of a challenge
  // this reader may not edit (`can_edit` false) or that is locked: the same routes
  // refuse both (`_tfAttachReadOnly`, shared with the chip list). Re-shown for
  // everybody else, since the previous open may have been one of those.
  {
    const _addBtn=document.getElementById('tf-attach-add-btn');
    if(_addBtn)_addBtn.style.display=_tfAttachReadOnly(t)?'none':'';
  }
  // Lock handling
  if(t.locked){
    _tfFormReadOnly(_tfLockedReason(t),S._tfAnswerVisible===false?'tf-sealed-note':undefined);
    setSafeHtml(document.getElementById('task-form-title'), `Edit question (<span style="display:inline-flex;align-items:center;gap:4px;vertical-align:-2px">${ICO.lock} Locked</span>)`);
  }
  // v8.17.0 — last, after every enable/disable pass above, so the segmented
  // difficulty follows #tf-diff's final disabled state.
  _tfDiffSync();_tfSecReset();
  showTaskFormArea();
  // Load feedback
  const fbSection=document.getElementById('task-feedback-section');
  const fbList=document.getElementById('task-feedback-list');
  // v8.3.20 — a FAILED feedback load must not render as "no feedback". This is
  // an in-place section rather than a dialog, so it says so where the list would
  // have gone rather than refusing the whole editor (v7.23.5).
  const fb=await fetchJsonList(`/api/admin/tasks/${id}/feedback`);
  // v8.12.0 — the two feedback purges are competitor doors, so a superadmin who
  // competes in an event holding this challenge is not offered them.
  const _fbCompetes=Array.isArray(t.competing_in)&&t.competing_in.length>0;
  if(fb===null){
    fbSection.style.display='';
    setSafeHtml(fbList, `<div style="color:var(--muted);font-size:var(--fs-14)">Could not load feedback for this challenge.</div>`);
  } else if(fb.length){
    fbSection.style.display='';
    setSafeHtml(fbList, fb.map(f=>`<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:var(--fs-14)">${esc(f.first_name||'')} ${esc(f.last_name||'')} <span style="color:var(--muted)">(${esc(f.nickname||f.email)})</span></span>
      <span style="color:var(--yellow);font-size:var(--fs-14)">${'★'.repeat(f.rating)}${'☆'.repeat(5-f.rating)}</span>
      ${(adminCan('challenges.delete')&&!_fbCompetes)?`<button class="btn sm danger" style="font-size:var(--fs-12);padding:2px 8px" data-action="task-feedback-delete" data-task-id="${esc(id)}" data-user-id="${esc(f.user_id)}">Remove</button>`:''}
    </div>`).join(''));
    // Appended, not re-serialised: re-parsing the list's own innerHTML would put
    // every rendered name through the HTML parser a second time.
    if(adminCan('challenges.delete')&&!_fbCompetes&&fb.length>1){
      const more=document.createElement('div');
      setSafeHtml(more, `<button class="btn sm danger" style="margin-top:8px;font-size:var(--fs-12)" data-action="task-feedback-delete-all" data-task-id="${esc(id)}">Delete All Feedback</button>`);
      fbList.appendChild(more.firstElementChild);
    }
  }else{
    fbSection.style.display='none';
    setSafeHtml(fbList, '');
  }
}

export async function saveTask(status){
  const id=document.getElementById('edit-task-id').value;
  const _atype=document.getElementById('tf-atype').value;
  const _isChoice=_atype==='choice';
  const _isAny=_atype==='any';
  const _isText=_atype==='text';
  // A choice task derives its correct answer from the ticked rows, and an
  // any-answer task has no key at all, so the plain Correct Answer input is not
  // a required field for either — validating it anyway would make the form
  // unsavable with no visible cause.
  // v8.10.0 — and a WITHHELD answer is not a required field either, for exactly
  // the reason the comment above gives. A reader the server sealed the key from
  // holds an empty box that is deliberately empty and is not being sent; demanding
  // they fill it makes the form unsavable behind "Please fill in all required
  // fields", which names a box they cannot legitimately fill.
  const _answerWithheldNow=S._tfAnswerVisible===false;
  const required=[{id:'tf-title',label:'Title'},{id:'tf-diff',label:'Difficulty'},
    ...((_isChoice||_isAny||_answerWithheldNow)?[]:[{id:'tf-answer',label:'Correct Answer'}])];
  let valid=true;
  clearFieldErrors(document.getElementById('admin-task-form'));
  for(const f of required){
    const el=document.getElementById(f.id);
    if(!el.value.trim()){markFieldError(el,true);valid=false;}
  }
  if(!valid){showToast('Please fill in all required fields.');return;}
  if(_isChoice){
    const chErr=tfChoicesError();
    if(chErr){
      markFieldError(document.getElementById('tf-choices-list'),true);
      const el=document.getElementById('tf-choices-err');if(el)el.textContent=chErr;
      showToast(chErr,'error');return;
    }
  }
  // Operator ruling 84 — an answered qualifying question's options keep their
  // places (the server refuses it too, 409 qualifying_options_fixed).
  if(id&&S._tfOptionsFixed&&(!_isAny||_tfOptionsFixedBroken())){
    markFieldError(document.getElementById('tf-any-options'),true);
    showToast(_TF_OPTIONS_FIXED_NOTE,'error');return;
  }
  // If editing an existing challenge that's in any live competition, require explicit confirmation
  if(id){
    const existing=S.adminTasksData.find(x=>x.id===id);
    // v8.8.8 — through the SAME two helpers the kebab confirmation uses, so the
    // two copies of this sentence cannot disagree about a live event the actor
    // cannot see. Its own withheld clause is what stops the narrowing deleting
    // the warning on a shared challenge.
    const parts=_liveMutationParts(existing);
    if(parts.any){
      const ok=await showModal({title:'Edit Live Challenge',message:`This challenge is currently in live event(s): ${_liveMutationPhrase(parts)}.<br><br>Changes take effect immediately and may affect participants already working on it.<br><br>Continue?`,confirmText:'Save Anyway',confirmClass:'danger'});
      if(!ok)return;
    }
  }
  // v8.9.0 — a text key is the Correct Answer box plus every additional row,
  // newline-joined (the server canonicalises: trims, drops blanks and
  // duplicates). `any` has no key and sends "" — the server refuses a hint on
  // it, so `hint` is omitted for that type rather than posted and refused.
  const _correctAnswer=_isAny?'':_isText
    ?[document.getElementById('tf-answer').value,...(S._tfExtraAnswers||[])].map(s=>String(s||'').trim()).filter(Boolean).join('\n')
    :document.getElementById('tf-answer').value;
  // v8.10.0 — THE DESTRUCTIVE HAZARD, and the reason the sealed fields are
  // OMITTED rather than sent blank.
  //
  // This body posts `correct_answer` and `explanation` UNCONDITIONALLY on every
  // save, and the PUT binds them with COALESCE / a direct write. A reader who was
  // withheld the key holds an empty box — so posting what the box contains would
  // WIPE the answer of a challenge they were never allowed to read, from a save
  // whose visible subject was the title. The server refuses such a caller outright
  // (it is the author or nobody), so this can only bite the AUTHOR of a challenge
  // whose payload predates their session — but "the server would refuse it anyway"
  // is exactly the reasoning that ships the bug the day the gate is narrowed.
  //
  // Omission is the shape the `any` branch below already uses (`...(_isAny?{}:...)`)
  // and the one the PUT is built for: absent means "the caller said nothing", so
  // the stored value is kept.
  const _answerWithheld=S._tfAnswerVisible===false;
  // The UNSEAL, which is the one flag transition the PUT accepts. Sent only when
  // the author actually ticked it — an unticked box must not echo `false`, or the
  // v8.9.0 "absent is not false" trap reappears one field over.
  const _unsealTicked=!!document.getElementById('tf-unseal')?.checked
    && !document.getElementById('tf-unseal-row')?.hidden;
  const body={title:document.getElementById('tf-title').value,description:descEditor.getHtml(),
    difficulty:document.getElementById('tf-diff').value,answer_type:document.getElementById('tf-atype').value,
    // v8.1.0 — sent as `null` when blank, never omitted. Omitting it would mean
    // "leave unchanged" to the PUT's CASE-keyed bind, so clearing the box would
    // silently keep the old cap — a control that appears to work.
    attempt_cap:(document.getElementById('tf-attempt-cap')?.value.trim()||null),
    ...(_answerWithheld?{}:{correct_answer:_correctAnswer,explanation:explanationEditor.getHtml()}),
    // v7.19.0 — the server derives correct_answer from these when the type is
    // `choice`, so send them only for that type (the PUT keys on the effective
    // type and would reject stray choices on a text task).
    ...(_isChoice?{choices:(S._tfChoices||[]).map(c=>({id:c.id,text:(c.text||'').trim(),correct:!!c.correct}))}:{}),
    // Event team reports — a pick-one question's options (none = a free answer).
    ...(_isAny?{choices:_anyOptionsFromForm()}:{}),
    // v8.12.2 — a WITHHELD hint is omitted, never posted empty: absent means
    // "the caller said nothing" to the PUT's CASE-keyed bind, so the stored hint
    // this reader could not see is kept (the same rule as the two fields above).
    ...((_isAny||S._tfHintWithheld)?{}:{hint:hintEditor.getHtml()}),attachment_url:document.getElementById('tf-attach').value,
    author_name:document.getElementById('tf-author-name').value||null,
    author_linkedin:document.getElementById('tf-author-linkedin').value||null,
    // CREATE sends the seal when ticked; EDIT sends `false` only for a real
    // unseal. Absent in every other case, so nothing echoes a value the server
    // would have to read as a change.
    ...(document.getElementById('edit-task-id').value
      ? (_unsealTicked?{answer_sealed:false}:{})
      : (document.getElementById('tf-answer-seal')?.checked?{answer_sealed:true}:{}))};
  if(status)body.status=status;
  // Stage B — the topic, sent only once the picker holds the topic list (a
  // failed read must not file the question under no topic).
  {const _ts=document.getElementById('tf-topic');if(_ts&&_ts.dataset.loaded==='1')body.topic_id=_ts.value||null;}
  // Stage B — a NEW question made inside an event's workspace is that event's
  // own from birth (POST /api/admin/tasks with competitionId), never a bank question.
  if(!id&&S.adminSelectedCompetitionId)body.competitionId=S.adminSelectedCompetitionId;
  // v6.13.15 — both create AND edit flows send staging_attachments.
  // Server promotes them atomically inside the create/update
  // transaction and deletes the staging rows.
  if(S._pendingStagingAttachments.length){
    body.staging_attachments=S._pendingStagingAttachments.map((a,i)=>({staging_id:a.staging_id,display_name:a.display_name,order_idx:i}));
  }
  // v6.16.27 — optimistic concurrency / If-Match. Echo the
  // updated_at the row had when the editor was filled, so the server can detect
  // a concurrent edit and return 409 instead of last-writer-wins.
  // v8.14.5 — from S._tfEditUpdatedAt, never adminTasksData: the list reloads
  // under an open editor, and its token would pass a change the form never showed.
  if(id&&S._tfEditUpdatedAt)body.expectedUpdatedAt=S._tfEditUpdatedAt;
  const r=await fetch(id?`/api/admin/tasks/${id}`:'/api/admin/tasks',{method:id?'PUT':'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    if(r.status===409&&d.conflict){
      showToast(d.error||'This challenge was modified by another admin. Reload to see the latest values.','error');
      // v8.14.5 — refresh the LIST (not the open form, which keeps the admin's
      // edits and its own token) so closing and reopening the editor starts from
      // the latest version, as the guide says.
      loadAdminTasks();
    }else{
      showToast(d.error||'Failed to save challenge.','error');
    }
    return;
  }
  // Clear staging state AFTER a successful promotion so closeTaskForm() doesn't
  // fire a DELETE for rows the server already consumed.
  S._pendingStagingAttachments=[];
  const _saved=await r.json().catch(()=>({}));
  const _savedId=id||_saved.id;
  const _orgFailed=_savedId?await _tfApplyOrgTags(_savedId):[];
  closeTaskForm();loadAdminTasks();
  if(_orgFailed.length)showToast(`Challenge saved, but: ${_orgFailed[0]}`,'error');
  else showToast('Challenge saved!','success');
}

export async function deleteTask(id){
  const t=S.adminTasksData.find(x=>x.id===id);if(!t)return;
  const ok1=await showModal({title:'Delete Challenge',message:`Are you sure you want to permanently delete <strong>${esc(t.title)}</strong>?<br><br>This action cannot be undone. Existing submissions and participant scores will be preserved.`,confirmText:'Delete',confirmClass:'danger'});
  if(!ok1)return;
  const ok2=await showModal({title:'Are You Absolutely Sure?',message:`<strong>${esc(t.title)}</strong> will be permanently removed from the system.<br><br>This cannot be reversed.`,confirmText:'Yes, Delete Permanently',confirmClass:'danger'});
  if(!ok2)return;
  const r=await fetch(`/api/admin/tasks/${id}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('Challenge permanently deleted.','success');loadAdminTasks();}
  else{const d=await r.json();showToast(d.error||'Failed to delete challenge.','error');}
}

// Stage B — SAVE TO BANK: copy this event's own question into the Question bank
// as a NEW bank question (never linked: later edits reach neither).
export async function saveTaskToBank(id){
  const t=S.adminTasksData.find(x=>x.id===id);if(!t)return;
  const ok=await showModal({title:'Save to bank',message:`Save a copy of <strong>${esc(t.title)}</strong> to the Question bank?<br><br>The copy is a new bank question, with this event's wording and answer. Later changes to either one do not reach the other.`,confirmText:'Save to bank',confirmClass:''});
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${encodeURIComponent(id)}/save-to-bank`,{method:'POST',headers:csrfHeaders()});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){showToast(d.error||'Could not save the question to the bank.','error');return;}
  showToast(`“${t.title}” saved to the Question bank.`,'success');
  loadAdminTasks();
}

export async function deleteFeedback(taskId,userId){
  const ok=await showModal({title:'Remove Feedback',message:'Remove this user\'s feedback?',confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${taskId}/feedback/${userId}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('Feedback removed.','success');editTask(taskId);}
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to remove feedback.','error');}
}

export async function deleteAllFeedback(taskId){
  const ok=await showModal({title:'Delete All Feedback',message:'Delete all feedback for this challenge? This cannot be undone.',confirmText:'Delete All',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${taskId}/feedback`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('All feedback deleted.','success');editTask(taskId);}
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to delete feedback.','error');}
}

export async function toggleTaskLock(id){
  const r=await fetch(`/api/admin/tasks/${id}/lock`,{method:'POST',headers:csrfHeaders()});
  if(r.ok){const d=await r.json();showToast(d.locked?'Challenge locked.':'Challenge unlocked.');loadAdminTasks();}
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to toggle lock.','error');}
}

// v8.12.2 — THE REVEAL, from the row menu or the editor. One confirm that says
// what it is — a recorded act, naming the superadmin in the challenge's
// History and the event log, and under impersonation the seat too — then the
// POST, then a reload of the list (the row's `answer_revealed`, key and hint
// all come from the server), and if the editor was open on this challenge it
// is re-entered so the fields fill and the form becomes editable. The list is
// AWAITED before the re-entry: `editTask` renders from `S.adminTasksData`, so
// without it the form would re-open read-only on the stale row.
export async function revealSealedAnswer(id){
  const t=(S.adminTasksData||[]).find(x=>x.id===id);
  // The seat is the person being IMPERSONATED — `S.currentUser`, the name the
  // banner shows — never `S.impersonation.admin_label`, which is the ACTING
  // admin's own label: the first draft named the superadmin as the seat in the
  // one dialog whose job is to say what will be recorded (pre-release review).
  const _seatName=S.impersonation?(S.currentUser?.nickname||S.currentUser?.email||''):'';
  const seat=_seatName?` through <strong>${esc(_seatName)}</strong>'s view`:'';
  const ok=await showModal({
    title:'Reveal sealed answer',
    // Two promises are qualified, both found by the second review. Inside an
    // organiser's panel (`S.isEventAdmin` is the seat's tier) the reveal lifts the
    // seal and nothing else: editing still follows the SEAT's own-challenges rule,
    // so "and be able to edit it" was false for a co-organiser's challenge — the
    // kebab note beside this item already says so. And the seat is named in the
    // history to administrators and the seat themselves, but to another organiser
    // only when they share an event with that organiser (`_revealSeatFor`); the
    // event log always carries it.
    message:`Show yourself the sealed answer, explanation and hint of <strong>${esc(t?.title||'this challenge')}</strong>${seat}${S.isEventAdmin?'':', and be able to edit it'}, for the rest of this session.${S.isEventAdmin?' Editing it still follows this organiser\'s own rules: only a challenge they created can be edited from their view.':''}<br><br>This is <strong>recorded</strong>: the challenge's history and the event log will show that you revealed it, naming you${seat?' and whose view you were in — which administrators see, and other organisers only if they share an event with this organiser':''}. The person who created it can see that record.`,
    confirmText:'Reveal and record',
    confirmClass:'warning',
    cancelText:'Cancel',
  });
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${id}/sealed-reveal`,{method:'POST',headers:csrfHeaders()});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){showToast(d.error||'Could not reveal the sealed answer.','error');return;}
  if(d.author)showToast('You created this challenge — its answer was already yours to see.');
  else showToast(d.already?'Already revealed in this session.':'Sealed answer and hint revealed — recorded in the challenge\'s history.');
  // Only a load that LANDED may re-enter the editor: a failed one reset the model
  // to [] (editTask would close the form with a false "no longer available"), and
  // a superseded one left the pre-reveal row (the form would re-open read-only
  // and nothing would ever refresh it). On either, the form keeps the pre-reveal
  // state it already had — the safe direction — and the loader has spoken.
  const landed=await _loadAdminTasksSettled();
  if(landed!=='landed')return;
  const form=document.getElementById('admin-task-form');
  const editing=document.getElementById('edit-task-id')?.value;
  if(form&&form.style.display!=='none'&&editing===id)editTask(id);
}

// v8.12.2 — A SESSION REGENERATE DROPS EVERY REVEAL, and the list does not know.
// The reveal marker lives on the server session, which is regenerated in place
// (no page reload) by the view toggle (a password change or set keeps it) —
// so rows loaded before still say `answer_revealed`, the editor still holds the
// key, and Edit / Unseal / Recalculate / Restore are offered for a row the server
// now refuses, with no Reveal item to recover (the pre-release review). Every
// in-place regenerate calls this; a full reload needs nothing. Only re-reads when
// a revealed row is actually cached, so the common path is a no-op, and an open
// editor on such a row is re-rendered from the fresh (sealed) row, the shape
// `revealSealedAnswer` uses above in the other direction.
//
// THE EDITOR IS TOUCHED ONLY WHEN IT IS OPEN ON A ROW THAT WAS REVEALED (second
// review). The first draft re-rendered whatever challenge the editor held, so an
// admin typing into an UNSEALED challenge who toggled Participant View and back
// lost every unsaved edit, and its staged uploads were dropped from the form
// while their staging rows stayed on the server — the restore path at the top of
// this file has always asked the same question (is the editor on THIS row?).
// On a revealed row nothing unsaved can survive anyway: the server now refuses
// the save of a sealed challenge this admin does not own. Its staged uploads are
// discarded properly, and if the fresh list did not land the form is CLOSED with
// the true reason rather than left holding a key the session no longer allows.
export async function refreshAfterSessionRegenerate(){
  if(!S.isAdminView)return;
  const revealed=new Set((Array.isArray(S.adminTasksData)?S.adminTasksData:[]).filter(t=>t&&t.answer_revealed).map(t=>t.id));
  if(!revealed.size)return;
  const form=document.getElementById('admin-task-form');
  const editing=document.getElementById('edit-task-id')?.value;
  const onRevealed=!!(form&&form.style.display!=='none'&&editing&&revealed.has(editing));
  const landed=await _loadAdminTasksSettled();
  if(!onRevealed)return;
  // The operator may have closed the form or opened another row during the load.
  if(form.style.display==='none'||document.getElementById('edit-task-id')?.value!==editing)return;
  if(landed==='landed'){
    _discardPendingStagingAttachments();
    editTask(editing);
    showToast('Your reveal of this sealed answer ended when your session changed, so it is sealed again here. Reveal it again to see or edit it.');
    return;
  }
  closeTaskForm();
  showToast('Your reveal of this sealed answer ended when your session changed, so the editor was closed. Reveal it again to see or edit it.','error');
}

export async function recalculateTaskScores(id){
  const ok=await showModal({
    title:'Recalculate Scores',
    message:'Re-grade this challenge\'s historical submissions against its current grading rule — the accepted answer(s), or for an Any answer challenge every non-empty answer — <strong>in events that are still open</strong>. Submissions in events whose session has ended are <strong>frozen and will not change</strong> (their final standings are locked). This can flip open submissions from <strong>correct → wrong</strong> (or vice versa), which may change the leaderboard rank of affected participants and their auto-end status.<br><br>Use this after fixing a typo in an accepted answer, adding one, or changing the answer type — while the event is still live. Cannot be undone (re-issue the same edit + recalculate to revert).',
    confirmText:'Recalculate',
    confirmClass:'warning',
    cancelText:'Cancel',
  });
  if(!ok)return;
  let r=await fetch(`/api/admin/tasks/${id}/recalculate`,{method:'POST',headers:csrfHeaders()});
  // v8.1.5 — THE LIVE-EVENT OVERRIDE IS REACHABLE FROM A BROWSER. The route
  // refuses a challenge whose event has a live session unless the caller sends
  // `confirm_live`, and nothing here ever sent it — so recalculate was refused
  // for exactly the case it exists to serve (a typo fixed WHILE the event runs),
  // and the admin was handed the API's own wording to act on. The second
  // confirmation is the point of the server's gate, not a formality: it is the
  // only warning that scores are about to move under people who are still
  // playing. Declining leaves everything untouched.
  if(r.status===409){
    const d=await r.json().catch(()=>({}));
    if(d.code==='live_session_confirm'){
      const go=await showModal({
        title:'A session is LIVE right now',
        message:`${esc(d.error||'')}<br><br>Participants in that session may see their score change mid-event, and a re-grade can leave somebody with no attempts left on this challenge — you would then need <strong>Grant Attempts</strong> to give them another try.`,
        confirmText:'Recalculate anyway',
        confirmClass:'danger',
        cancelText:'Cancel',
      });
      if(!go)return;
      r=await fetch(`/api/admin/tasks/${id}/recalculate`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({confirm_live:true})});
    }else{
      showToast(d.error||'Could not recalculate.','error');
      return;
    }
  }
  if(r.ok){
    const d=await r.json();
    // v7.20.9 (ext-audit F2) — surface `unresolved`. Recalculate deliberately
    // LEAVES ALONE any pre-v7.20.9 multiple-choice submission whose selection it
    // cannot recover (the options have since been renamed, so the stored human
    // rendering no longer maps back to ids). Reporting the count is the honest
    // half of not guessing — a silent skip reads as "nothing needed changing".
    const _unres=d.unresolved?` ${d.unresolved} older multiple-choice submission${d.unresolved===1?' was':'s were'} left unchanged — the option text has changed since, so what was picked can no longer be identified.`:'';
    // v7.21.2 — surface `frozen_skipped`. v7.21.1 SCOPED recalculate to skip
    // competitions whose session has ended (their final scores are frozen), and
    // added this count to the response — but the toast never read it. The
    // load-bearing case is a FULLY-finished challenge: every row is frozen, so a
    // bare "Recalculated 0 submission(s); 0 scores changed." reads as "nothing
    // needed changing" when the truth is "nothing COULD change". Say why.
    const _frozen=d.frozen_skipped?` ${d.frozen_skipped} submission${d.frozen_skipped===1?'':'s'} in finished events ${d.frozen_skipped===1?'was':'were'} left frozen — their final scores are locked.`:'';
    // v8.1.4 — SAY WHO THIS RECALCULATE STRANDED. The server has returned
    // `attempts_exhausted_after` / `attempts_exhausted_who` since v8.1.0 and
    // NOTHING read them: the admin saw "Recalculated N; M scores changed" while
    // participants sat behind a locked panel needing a grant — the third counter
    // added to this same response with no human consumer (v7.21.2).
    //
    // NAMES, not a bare count, because the remedy is per-participant: the Grant
    // Attempts item on this challenge's kebab, which the copy points at. Capped
    // at four so a large flip does not produce an unreadable toast.
    const _who=(d.attempts_exhausted_who||[]).map(x=>x&&(x.nickname||x.user_id)).filter(Boolean);
    const _strandN=d.attempts_exhausted_after||0;
    const _shown=_who.slice(0,4).join(', ');
    const _strand=_strandN
      ?` ${_strandN} participant${_strandN===1?'':'s'} now ${_strandN===1?'has':'have'} no attempts left and no correct answer${_shown?`: ${_shown}${_who.length>4?`, and ${_who.length-4} more`:''}`:''} — use “Grant Attempts” on this challenge to give them another try.`
      :'';
    if(d.total_submissions===0 && d.frozen_skipped){
      showToast(`Nothing re-graded: all ${d.frozen_skipped} submission${d.frozen_skipped===1?'':'s'} belong to events that have finished, whose final scores are frozen. Revive an event (extend its duration) to re-grade it.`,'info');
    } else {
      showToast(`Recalculated ${d.total_submissions} submission(s); ${d.flipped} score${d.flipped===1?'':'s'} changed.${_frozen}${_unres}${_strand}`,
        _strandN?'error':((_frozen||_unres)?'info':'success'));
    }
    loadAdminTasks();
  } else {
    const d=await r.json().catch(()=>({}));
    showToast(d.error||'Failed to recalculate scores.','error');
  }
}

export async function toggleTaskVisibility(id){
  const t=S.adminTasksData.find(x=>x.id===id);if(!t)return;
  const hiding=!!t.active;
  const ok=await showModal(hiding
    ?{title:'Hide Challenge',message:'This challenge will be hidden from participants. Existing submissions are preserved.<br><br>Hidden challenges do not count toward the total required for leaderboard "all solved" status.',confirmText:'Hide Challenge',confirmClass:'warning',cancelText:'Cancel'}
    :{title:'Show Challenge',message:'This challenge will become visible to participants and will count toward the completion total.',confirmText:'Show Challenge',confirmClass:'',cancelText:'Cancel'});
  if(!ok)return;
  const r=await fetch(`/api/admin/tasks/${id}/visibility`,{method:'PATCH',headers:csrfHeaders()});
  if(r.ok){showToast(hiding?'Challenge hidden from participants.':'Challenge is now visible to participants.');loadAdminTasks();}
  else{const d=await r.json();showToast(d.error||'Failed to update visibility.','error');}
}

export const descEditor=createRichEditor(document.getElementById('tf-desc'),'Challenge description...',100);

export const explanationEditor=createRichEditor(document.getElementById('tf-explanation'),'Explain how to arrive at the correct answer...',80);

export const hintEditor=createRichEditor(document.getElementById('tf-hint'),'Optional hint...',50);

// ── v8.17.0 — the library's columns (ui/table-columns.js; defined from boot()) ──
// The default set fits any desktop card; the rest are under Columns. The
// filters read the MODEL, so they narrow the whole library before paging.
function _taskStatusLabel(t){return t.status==='draft'?'Draft':(t.active?'Published':'Hidden');}
export const CHALLENGE_TABLE_COLUMNS={
  noun:'challenge',
  // Type is under Columns: with it the default set does not fit a 1024 px window.
  defaults:['title','difficulty','status','topic','events','actions'],
  fixed:['title','actions'],
  cols:{title:{grow:true},difficulty:{filter:'enum',options:['easy','medium','hard']},type:{filter:'enum'},status:{filter:'enum',options:['Draft','Hidden','Published']},
    topic:{filter:'enum'},events:{filter:'tags'},last_changed:{filter:'date'},changed_by:{filter:'enum'},author:{filter:'enum'}},
  model:{
    rows:()=>_listedTasks(),
    get:(t,k)=>{switch(k){
      case 'title':return t.title||'';
      case 'difficulty':return t.difficulty||'';
      case 'type':return t.answer_type||'';
      case 'status':return _taskStatusLabel(t);
      case 'attachments':return t.attachment_count||0;
      case 'feedback':return t.avg_rating??'';
      case 'last_changed':return t.last_changed||'';
      case 'changed_by':return t.changed_by||'';
      case 'author':return t.author_name||'';
      case 'topic':return t.topic_name||'';
      case 'events':return (t.competitions||[]).map(c=>c.name);
      default:return '';
    }},
    onChange:()=>{S.tPage=1;renderAdminTasks();},
  },
};
