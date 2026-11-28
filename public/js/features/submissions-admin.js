"use strict";

import { S } from "../core/state.js";
import { setListCount, renderLoadFailure, colspanFor } from "../ui/list-controls.js"; // v7.20.10 — shared match count
import { setSafeHtml } from "../core/trusted-types.js";
import { showToast } from "../ui/toast.js";
import { esc, fmtDt, _syncSortAria } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)
import { crossNavOffered } from "./admin-crossnav.js"; // RBAC — a name links only into a page the role may open

// v7.22.2 — the participant and the challenge on a submission row are the way
// into their own panes. Reading "dan solved Regex Golf" and then having to go
// and find either of them by hand is the whole friction this removes.
//
// BUTTONS, not clickable <td>s: the row must stay a row for a screen reader
// (v7.7.33 AL11 — role=button on a container demands presentational children
// and silently drops the table semantics), and a button is focusable and
// keyboard-operable for free.
//
// BOTH RENDER BRANCHES USE THESE. The hint row and the submission row are
// separate templates in this file, so a change applied to one works in one view
// only — which is exactly how this would be reported as "it works for some rows".
function _subPersonCell(nickname){
  const v=String(nickname||'');
  if(!v)return '—';
  if(!crossNavOffered('participant'))return esc(v);   // RBAC — no People page for this role: a plain name
  return `<button type="button" class="sub-link" data-action="submissions-open-participant" data-nickname="${esc(v)}"
    title="Show ${esc(v)} in Participants" aria-label="${esc(v)} — show in the Participants tab">${esc(v)}</button>`;
}
function _subChallengeCell(title){
  const v=String(title||'');
  if(!v)return '—';
  if(!crossNavOffered('challenge'))return esc(v);     // RBAC — no Challenges page for this role: a plain name
  return `<button type="button" class="sub-link" data-action="submissions-open-challenge" data-title="${esc(v)}"
    title="Find ${esc(v)} among the questions" aria-label="${esc(v)} — find it among the questions">${esc(v)}</button>`;
}

export function _subKbReset(){
  document.querySelectorAll('#admin-submissions-body tr.kb-active').forEach(r=>r.classList.remove('kb-active'));
  S._subKbActiveRow=-1;
}

export function _subKbSetActive(idx){
  const rows=document.querySelectorAll('#admin-submissions-body tr');
  if(!rows.length)return;
  if(idx<0)idx=0;
  if(idx>=rows.length)idx=rows.length-1;
  _subKbReset();
  rows[idx].classList.add('kb-active');
  S._subKbActiveRow=idx;
  rows[idx].scrollIntoView({block:'nearest',behavior:'smooth'});
}

export async function loadAdminSubmissions(){
  // RBAC — a role that may not read the activity stream (`audit.view`) sends no
  // read: every scope change calls this, and a refused read counts towards the
  // address's scanner block.
  if(!adminCan('audit.view'))return;
  // v6.10.72 — first-page fetches start a fresh snapshot anchor.
  if(S.subPage===1){S._subSnapshotBefore=null;S._subSnapshotTie=null;S._subExpectedTotal=null;S._subExpectedMaxMutation=null;S._subSnapshotStale=false;}
  const params=[`limit=${S.subPageSize}`,`offset=${(S.subPage-1)*S.subPageSize}`];
  if(S.adminSelectedCompetitionId)params.push(`competitionId=${S.adminSelectedCompetitionId}`);
  if(S.adminSelectedTimeslotId)params.push(`timeslotId=${S.adminSelectedTimeslotId}`);
  const q=(document.getElementById('submissions-search')?.value||'').trim();
  if(q)params.push(`q=${encodeURIComponent(q)}`);
  if(S._subSnapshotBefore)params.push(`snapshot_before=${encodeURIComponent(S._subSnapshotBefore)}`);
  // v7.21.19 (audit F4) — echo the TIE token as well.
  //
  // The server returns `snapshot_tie` for one reason: `snapshot_before` alone is
  // a millisecond timestamp, so rows sharing that millisecond cannot be ordered
  // against the anchor and can cross a page boundary between two fetches —
  // duplicating or dropping a row as the admin pages. The server documents the
  // pair as a client contract (lib/audit.js, server.js) and applies the strict
  // `(event_time < snap) OR (event_time = snap AND tie_key <= snap_tie)` filter
  // only when BOTH arrive; sending just the timestamp silently selects the
  // weaker ms-only fallback. The client had never sent it.
  if(S._subSnapshotTie)params.push(`snapshot_tie=${encodeURIComponent(S._subSnapshotTie)}`);
  // v7.21.16 (long-list phase 5) — the sort goes to the SERVER now, so it
  // covers the whole filtered event stream instead of the page in hand.
  if(S.subSortCol){params.push(`sort=${encodeURIComponent(S.subSortCol)}`);params.push(`dir=${S.subSortAsc?'asc':'desc'}`);}
  S.adminSubmissionsLastQ=q;
  // Request sequence guards against a slow earlier fetch arriving after a
  // later one (typical when the search box debounce fires a request while
  // the previous one is still in flight).
  const mySeq=++S._subFetchSeq;
  // v7.23.5 (Wave 5) — a failed request must not be reported as "no data".
  // MEASURED: a 500 rendered "No submissions yet." — a confident, false claim
  // about the data, which is worse than showing nothing. `.catch(()=>({events:[]}))`
  // produced exactly that, and it only fires on a PARSE error anyway.
  let body=null;
  try{ const r=await fetch('/api/admin/submissions?'+params.join('&')); if(r.ok) body=await r.json(); }catch(e){ console.warn('Could not load submissions',e); }
  if(body===null){
    if(mySeq!==S._subFetchSeq)return;
    renderLoadFailure('admin-submissions-body',{colspan:colspanFor('admin-submissions-body'),
      noun:'submissions',retryAction:'retry-load-admin-submissions',
      resetModel:()=>{S.adminSubmissionsData=[];}});
    showToast('Could not load submissions.','error');
    return;
  }
  if(mySeq!==S._subFetchSeq)return;
  S.adminSubmissionsData=Array.isArray(body)?body:(body.events||[]);
  // Did the SERVER order these? The note below ("Sorted within this page") must
  // only appear when the client did the sorting — claiming a page-scoped sort
  // while the server sorted globally is the same class of wrong answer v7.16.7
  // added the note to fix, with the sides swapped.
  S._subSortedGlobally=!Array.isArray(body)&&body.sorted_globally===true;
  S.adminSubmissionsTotal=Array.isArray(body)?body.length:(body.total||S.adminSubmissionsData.length);
  // Capture snapshot + fingerprints on the first page so subsequent pages
  // pin against them and detect drift. (v6.10.82: total; v6.10.83: max_mutation_at.)
  if(S.subPage===1&&typeof body.snapshot_before==='string')S._subSnapshotBefore=body.snapshot_before;
  if(S.subPage===1&&typeof body.snapshot_tie==='string')S._subSnapshotTie=body.snapshot_tie;
  if(S.subPage===1){
    if(typeof body.total==='number')S._subExpectedTotal=body.total;
    if(typeof body.max_mutation_at==='string'||body.max_mutation_at===null)S._subExpectedMaxMutation=body.max_mutation_at||null;
  }else{
    if(S._subExpectedTotal!==null&&typeof body.total==='number'&&body.total!==S._subExpectedTotal){
      S._subSnapshotStale=true;
    }
    if(S._subExpectedMaxMutation!==null&&typeof body.max_mutation_at!=='undefined'&&body.max_mutation_at!==S._subExpectedMaxMutation){
      S._subSnapshotStale=true;
    }
  }
  renderAdminSubmissions();
}

export function resetSubmissionsSnapshot(){
  S.subPage=1;
  S._subSnapshotBefore=null;S._subSnapshotTie=null;
  S._subExpectedTotal=null;
  S._subExpectedMaxMutation=null;
  S._subSnapshotStale=false;
  loadAdminSubmissions();
}

/**
 * v8.8.12 — IS THE ORDERING ON SCREEN THE SERVER'S OWN?
 *
 * `S.subSortCol` is initialised to 'time' / descending because that IS the
 * server's default ordering — so unlike the leaderboard's `S.lbSortCol === null`
 * convention, this pane cannot ask "has the admin chosen a sort?" from the
 * column alone. It can ask the question that actually matters, which is whether
 * the rows were ordered by the server or re-ordered locally by us.
 *
 * MIRRORS `sortIsDefault` in the /api/admin/submissions handler
 * (`!sortKey || (sortKey === "time" && sortDir === "DESC")`), and it is the same
 * shape `_logsSortIsDefault()` has carried for its own pane since v7.25.0. An
 * irreducible copy — `public/js` is a browser-only graph — so it is diffed by a
 * Docs-hygiene scanner rather than left to drift.
 */
export function _subSortIsDefault(){
  return (!S.subSortCol||S.subSortCol==='time')&&!S.subSortAsc;
}

/**
 * v8.8.12 — THE PAGE-SCOPE NOTE, WHICH USED TO FIRE ON A PANE NOBODY HAD
 * TOUCHED.
 *
 * The old gate was `subSortCol && totalPages>1 && !_subSortedGlobally`. Every
 * one of those holds on a virgin Submissions tab with more than one page:
 * `subSortCol` is 'time' from boot, and `sorted_globally` is `false` on the
 * default read BY DESIGN — it means "the server did not take the sorting path",
 * a PERFORMANCE contract pinned by longlist-456.spec.js, not a statement that
 * the rows are only page-locally ordered. Under the default ordering the
 * branch-capped index walk returns the true global newest-N (the handler says
 * so at SUB_SORTS), so the note was a false claim about correct data — the
 * v7.16.7 defect the note was added to fix, with the sides swapped.
 *
 * THE POSITIVE NOTE IS NOT AN EXTRA: without it, "no note" would now mean both
 * "nothing was clicked" and "your sort was ranked across every match", two
 * different answers rendered identically. That ambiguity is what the note
 * exists to remove, and it is why the Logs pane has carried both halves since
 * v7.25.0.
 *
 * SUPPRESSED ON A SINGLE PAGE, both ways: "within this page" is a false alarm
 * when there is only one, and the positive half is noise.
 */
export function _subSortNote(totalPages){
  if(_subSortIsDefault())return '';
  if(totalPages<=1)return '';
  if(S._subSortedGlobally){
    return `<span class="page-scope-ok" title="The server ranked every submission matching the current filter, not just this page.">Sorted across all matches</span>`;
  }
  // Reachable when the server did not recognise the column (a stale client
  // asking for a retired one) or answered in the pre-v6.3.0 array shape: the
  // rows came back newest-first and this pane re-ordered them itself.
  return `<span class="page-scope-note" title="This column was reordered here, on the rows of this page only. The server pages by submission time, so other pages are not re-ranked.">Sorted within this page</span>`;
}

export function sortSubmissions(col){
  if(S.subSortCol===col)S.subSortAsc=!S.subSortAsc;else{S.subSortCol=col;S.subSortAsc=true;}
  _subRefetchSorted();
}

/** Set the server order outright (a heading menu's Sort ascending/descending). */
export function setSubmissionsSort(col,asc){
  if(S.subSortCol===col&&S.subSortAsc===!!asc)return;
  S.subSortCol=col;S.subSortAsc=!!asc;
  _subRefetchSorted();
}

function _subRefetchSorted(){
  // v7.21.16 — REFETCH. The sort is applied by the server across the whole
  // filtered stream, so a sort is a new query, not a client-side reorder.
  //
  // Back to page 1, deliberately: "page 4 of the old ordering" names no rows in
  // the new one, so keeping the page number would land the admin somewhere
  // arbitrary and look like data loss. Clearing the snapshot anchor with it,
  // because that anchor pins a WINDOW of the previous ordering.
  S.subPage=1;
  S._subSnapshotBefore=null;S._subSnapshotTie=null;S._subExpectedTotal=null;S._subExpectedMaxMutation=null;S._subSnapshotStale=false;
  loadAdminSubmissions();
}

// ── v8.17.0 — the Submissions table's columns (ui/table-columns.js; defined from
// boot()). Every heading but Detail sorts on the SERVER (SUB_SORTS), so the
// heading menus drive that sort through `sortTo`: page 1, anchor dropped, as a
// heading click does. There is no server filter per column, so a heading
// filter narrows the rows of THIS page and says so ("on this page") — no model,
// so the component never claims a total it does not have.
export const SUBMISSIONS_TABLE_COLUMNS={
  noun:'submission',
  // Session is under Columns: with it the default set does not fit a 1024 px
  // window (measured: 766 px of table in a 674 px card).
  hidden:['session'],
  cols:{participant:{grow:true},competition:{filter:'enum'},session:{filter:'enum'},task:{filter:'enum'},event:{filter:'enum'},
    // The answer column is withheld for sealed challenges; it sorts nowhere.
    detail:{sort:false}},
  sortTo:(col,asc)=>setSubmissionsSort(col,asc),
};

export function onSubmissionsSearchInput(){
  clearTimeout(S._subSearchTimer);
  S._subSearchTimer=setTimeout(()=>{S.subPage=1;loadAdminSubmissions();},200);
}

// v8.10.0 — the sealed answer, in the Submissions stream.
//
// A submitted answer to a sealed challenge is the KEY by construction for
// `text` / `json` / `file` / `choice` — grading is exact, so a CORRECT submission
// IS the accepted value — and for `any` the response is the only secret there is.
// So the server withholds it (`answer: null` plus `answer_sealed`), and this cell
// exists only to say WHICH situation an empty cell is: sealed, or a hint row (the
// server has always sent `NULL as answer` for those), or a genuinely empty answer.
//
// The TITLE attribute matters as much as the text. It is the full untruncated
// value on an ordinary row, so leaving it unguarded would put the sealed answer in
// a tooltip — visible on hover and in the DOM — which is precisely the shape of
// leak a cell-level redaction is supposed to close.
function _subIsSealed(s){ return s && s.answer_sealed && s.answer_visible === false; }
function _subAnswerCell(s){
  if(_subIsSealed(s))return `<span class="sub-answer-sealed" title="Sealed answer — only the person who created this question, or a superadmin who has revealed it on the record, can see what was submitted.">${ICO.lock} sealed</span>`;
  return esc(s.answer||'');
}
function _subAnswerTitle(s){ return _subIsSealed(s) ? 'Sealed answer' : esc(s.answer||''); }

export function renderAdminSubmissions(){
  let events=[...S.adminSubmissionsData];

  // v7.21.16 — the SERVER sorts now. The local comparator survives as the
  // fallback for the one case the server cannot cover: a response that came
  // back without `sorted_globally` (an older/cached reply, or the array-shaped
  // pre-v6.3.0 body). Re-sorting a globally-sorted page would be a no-op at
  // best and, on a page whose rows were selected by a different key, actively
  // wrong — so it is skipped when the server says it did the work.
  document.querySelectorAll('[id^="sort-sub-"][id$="-icon"]').forEach(el=>el.textContent='');
  if(S.subSortCol){
    const ic=document.getElementById(`sort-sub-${S.subSortCol}-icon`);
    if(ic)ic.textContent=S.subSortAsc?' ▲':' ▼';
    _syncSortAria(ic,S.subSortAsc); // audit v7.7.33 (AL10)
    if(!S._subSortedGlobally)events.sort((a,b)=>{
      let va,vb;
      switch(S.subSortCol){
        case 'time':va=a.event_time||'';vb=b.event_time||'';break;
        case 'participant':va=(a.nickname||'').toLowerCase();vb=(b.nickname||'').toLowerCase();break;
        case 'competition':va=(a.competition_name||'').toLowerCase();vb=(b.competition_name||'').toLowerCase();break;
        case 'session':va=(a.timeslot_name||'').toLowerCase();vb=(b.timeslot_name||'').toLowerCase();break;
        case 'task':va=(a.task_title||'').toLowerCase();vb=(b.task_title||'').toLowerCase();break;
        case 'event':va=a.event_type==='hint'?'hint':a.is_correct?'correct':'wrong';vb=b.event_type==='hint'?'hint':b.is_correct?'correct':'wrong';break;
        case 'points':va=a.points_delta||0;vb=b.points_delta||0;break;
        default:va='';vb='';
      }
      if(typeof va==='number')return S.subSortAsc?va-vb:vb-va;
      return S.subSortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
    });
  }

  // Server already sliced to [subPage-1)*subPageSize, +subPageSize). Render
  // the returned rows directly without re-slicing.
  const totalPages=Math.max(1,Math.ceil(S.adminSubmissionsTotal/S.subPageSize));
  if(S.subPage>totalPages)S.subPage=totalPages;
  const pageData=events;

  // v6.16.46 — reset the J/K active-row index since the upcoming
  // setSafeHtml wipes the .kb-active class along with all rows.
  // The user can press J again to grab a fresh first row.
  _subKbReset();
  if(!pageData.length){
    const emptyMsg=S.adminSubmissionsLastQ?'No submissions match the current search.':'No submissions yet.';
    setSafeHtml(document.getElementById('admin-submissions-body'),`<tr><td colspan="8" class="sub-cell-empty">${emptyMsg}</td></tr>`);
  }else setSafeHtml(document.getElementById('admin-submissions-body'), pageData.map(s=>{
    const dt=new Date(s.event_time);
    const time=fmtDt(dt,'full');
    const compName=esc(s.competition_name||'—');
    const sessName=esc(s.timeslot_name||'—');
    if(s.event_type==='hint'){
      return`<tr>
        <td class="sub-cell-ts">${time}</td>
        <td>${_subPersonCell(s.nickname)}</td>
        <td>${compName}</td>
        <td>${sessName}</td>
        <td>${_subChallengeCell(s.task_title)}</td>
        <td><span class="sub-event-pill is-hint">${ICO.lightbulb}Hint</span></td>
        <td class="sub-cell-detail">Hint revealed</td>
        <td class="num-cell sub-cell-points is-negative">${Number(s.points_delta)}</td>
      </tr>`;
    }
    return`<tr>
      <td class="sub-cell-ts">${time}</td>
      <td>${_subPersonCell(s.nickname)}</td>
      <td>${compName}</td>
      <td>${sessName}</td>
      <td>${_subChallengeCell(s.task_title)}</td>
      <td>${s.is_correct?`<span class="sub-event-pill is-correct">${ICO.check}Correct</span>`:`<span class="sub-event-pill is-wrong">${ICO.x}Wrong</span>`}</td>
      <td class="cell-truncate sub-cell-detail" title="${_subAnswerTitle(s)}">${_subAnswerCell(s)}</td>
      <td class="num-cell sub-cell-points ${s.points_delta>0?'is-positive':'is-negative'}">${s.points_delta>0?'+':''}${Number(s.points_delta)}</td>
    </tr>`;
  }).join(''));

  // Pagination controls — driven by server-provided total (v6.3.3 — was
  // clamped at 500 rows pre-fix). The search term feeds into `total` via
  // the server filter, so "Page N of M" stays accurate even when the
  // admin is searching across the full stream.
  const totalLabel = S.adminSubmissionsLastQ
    ? `${S.adminSubmissionsTotal} match(es) for "${esc(S.adminSubmissionsLastQ)}"`
    : `${S.adminSubmissionsTotal} total`;
  // v7.20.10 — and beside the search box, where the operator is looking. The
  // pagination bar carries the same number but sits below a table you have just
  // scrolled past. Filtering happens SERVER-side here, so the unfiltered size is
  // not knowable client-side — total:null makes it say "N submissions match"
  // rather than invent a denominator.
  setListCount('submissions-search',{matched:S.adminSubmissionsTotal||0,total:null,filtered:!!S.adminSubmissionsLastQ});
  // v6.10.82 + v6.10.83 — staleness banner. Surfaces when page 2+ came
  // back with either a different `total` (deletion — competition or
  // participant delete removed rows under the snapshot anchor) or a
  // different `max_mutation_at` (recalculation — is_correct / points
  // rewritten). Prompt the operator to refresh so the view reflects
  // the current state consistently across every page.
  const staleBanner = S._subSnapshotStale
    ? `<div class="snapshot-stale-banner" role="status" aria-live="polite" style="margin-bottom:10px;padding:10px 12px;background:var(--yellow-soft);color:var(--yellow);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--fs-14);display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap">
         <span>Rows changed since page 1 (deletion or recalculation detected). Refresh for a consistent view.</span>
         <button class="btn sm secondary" data-action="submissions-reset-snapshot">Refresh</button>
       </div>`
    : '';
  setSafeHtml(document.getElementById('submissions-pagination'), `
    ${staleBanner}
    <button data-action="subs-page-first" ${S.subPage<=1?'disabled':''}>First</button>
    <button data-action="subs-page-prev" ${S.subPage<=1?'disabled':''}>Prev</button>
    <span class="page-info">Page ${Number(S.subPage)} of ${totalPages} (${totalLabel})</span>
    ${_subSortNote(totalPages)}
    <button data-action="subs-page-next" ${S.subPage>=totalPages?'disabled':''}>Next</button>
    <button data-action="subs-page-last" data-total-pages="${totalPages}" ${S.subPage>=totalPages?'disabled':''}>Last</button>
    <select data-change-action="subs-page-size" aria-label="Results per page">
      ${[30,50,100,200,500].map(n=>`<option value="${n}" ${S.subPageSize===n?'selected':''}>${n} / page</option>`).join('')}
    </select>`);
}
