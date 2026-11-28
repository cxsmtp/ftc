"use strict";

import { S } from "../core/state.js";
import { wireTagDialog } from "../ui/tag-dialog.js";
import { paginationHtml, pickerFilterHtml, wirePickerFilter, setListCount, chipMultiselectHtml, wireChipMultiselect, renderLoadFailure, colspanFor } from "../ui/list-controls.js"; // v7.17.1 — shared list chrome; v7.21.16 — shared chip multiselect
import { csrfHeaders, fetchWithLoading, fetchJsonList } from "../core/api.js";
import { raw, setSafeHtml } from "../core/trusted-types.js";
import { COUNTRY_TZ, autoDetectCountryTz, _preserveUnlistedOption } from "../data/country-tz.js";
import { isValidEmailFormat, isValidHttpUrl } from "./auth.js";
import { avatarPickerHtml, wireAvatarPicker, profileFieldsHtml, profileFieldIds, profileChangedFields } from "../ui/profile-form.js";
import { computeCompStatus, compDisplayCategory, COMP_CATEGORY_LABEL, isLateEntryOpen, compAcceptsNewMembers } from "./competition-picker.js"; // v8.12.6 — the late-entry window counts as open at every admin door
import { loadAdminCompetitions, setAdminCompetitionScope, compareCompsForPicker, certificatesKeptOnReviveNote } from "./competitions-admin.js";
import { loadAdminLeaderboard } from "./rankings-admin.js";
import { avatarHtml, esc, fmtDt, _syncSortAria, DRY_RUN_TAG } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { applyColumnFilters, applyColumnSort, columnSortActive, hasColumnFilters, openColumnsMenu, syncTable } from "../ui/table-columns.js"; // v8.17.0 — Columns + heading sort/filter
import { hideLoading, showLoading } from "../ui/loading.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { showPrompt, showToast } from "../ui/toast.js";
import { adminCan, adminPageOffered, deskApprovalWithheld, DESK_APPROVAL_REASON } from "../ui/nav.js";
import { showUserInRoles } from "./users-admin.js"; // RBAC — the one permission predicate (read inside functions only)

/**
 * v8.7.4 — ONE definition of "the acting admin may not manage this account".
 *
 * It was written out twice in this file and only ONE copy learned about the
 * event-admin tier in v8.7.0: the row renderer gained the clause, and
 * `adminEditProfile` 800 lines below did not. So for an event admin looking at a
 * FELLOW ORGANISER — two organisers sharing an event being the ordinary case
 * this role exists for — the kebab correctly said "View Profile" and showed the
 * lock note, and then the dialog opened fully EDITABLE against a target the
 * server refuses (`event_admin_target_privileged`). The one prominent item lied,
 * which is the exact v7.14.2 defect the row renderer's own comment describes.
 *
 * A GLOBAL admin is deliberately unaffected — they must be able to manage and
 * demote an event admin — so the tier is privileged only in ANOTHER event
 * admin's eyes, which is what the server's `participantDenied` decides.
 *
 * A CUSTOM role is decided by the row's server facts: `role_class` (an unscoped
 * one is always privileged) and `privileged_target`, the answer of the predicate
 * every account door enforces for THIS viewer (lib/rbac.js privilegedTargetFor:
 * also a role holding a permission the viewer lacks). A non-built-in role with
 * no facts fails closed.
 */
export function targetPrivilegedFor(role,row){
  const r=role||'participant';
  if(r==='admin'||r==='superadmin')return true;
  if(S.isEventAdmin&&r!=='participant')return true;
  if(row&&(row.role_class==='all'||row.privileged_target===true))return true;
  return r!=='participant'&&r!=='event_admin'&&!(row&&row.role_class);
}

/** Is this row an unscoped (class `all`) admin account? The built-in admin and
 *  superadmin by name, a custom role by the `role_class` its row carries (the
 *  server's). Wording only: who may manage the row is `targetPrivilegedFor`. */
export function isUnscopedAdminRow(role,row){
  const r=role||'participant';
  return r==='admin'||r==='superadmin'||!!(row&&row.role_class==='all');
}

const _BUILTIN_ROLE_IDS=new Set(['participant','event_admin','admin','superadmin']);

/**
 * Does this viewer get Impersonate on this row? The ONE predicate, read by the
 * row kebab and the profile card (features/profile-card.js), so the two can never
 * disagree: a participant-tier target that is not the viewer, approved, not
 * blocked or denied, not a rival (the competitor lock), and no impersonation
 * already open (nested entry is refused). Never an account holding a custom
 * role (`impersonation_target_custom_role`), and only for a role that may
 * impersonate (`participants.impersonate`).
 */
export function impersonateOfferedFor(p){
  if(!p)return false;
  const isSelf=!!(S.currentUser&&S.currentUser.id===p.id);
  const rival=!!(p.rival_in&&p.rival_in.id&&!isSelf);
  // A custom role is never impersonable (the route refuses impersonation_target_custom_role).
  const builtinTier=(p.role||'participant')==='participant'||p.role==='event_admin';
  return builtinTier&&adminCan('participants.impersonate')
    &&!targetPrivilegedFor(p.role||'participant',p)&&!isSelf&&!!p.approved&&!p.blocked&&!p.denied_at&&!rival&&!S.impersonation;
}

/** Is the viewer's profile access to this row read-only (a privileged peer, or
 *  a role that may not edit profiles)? */
export function profileReadOnlyFor(p){
  return !!p&&((targetPrivilegedFor(p.role||'participant',p)&&!S.isSuperAdmin)||!adminCan('participants.edit'));
}

export function pStatus(p){
  return p.denied_at ? 'denied'
    : p.blocked ? 'blocked'
    : (p.locked_until && new Date(p.locked_until) > new Date()) ? 'locked'
    : !p.verified ? 'unconfirmed'
    : !p.approved ? 'pending'
    : 'confirmed';
}

export function setPStatusFilter(btn, val) {
  if (val === 'all') {
    S.pStatusFilter.clear();
  } else {
    if (S.pStatusFilter.has(val)) S.pStatusFilter.delete(val);
    else                        S.pStatusFilter.add(val);
  }
  S.pPage = 1;
  // Re-paint the chip-active states. "All" is active iff the set is
  // empty; every other chip is active iff its value is in the set.
  document.querySelectorAll('#p-status-filters .filter-btn').forEach(b => {
    const v = b.dataset.value;
    if (v === 'all') b.classList.toggle('active', S.pStatusFilter.size === 0);
    else             b.classList.toggle('active', S.pStatusFilter.has(v));
  });
  renderParticipants();
}

export function pVal(p,col){
  switch(col){
    case 'name':return(p.first_name+' '+p.last_name).toLowerCase();
    case 'nickname':return p.nickname.toLowerCase();
    case 'email':return p.email.toLowerCase();
    case 'company':return(p.company||'').toLowerCase();
    case 'title':return(p.title||'').toLowerCase();
    case 'country':return(p.country||'').toLowerCase();
    case 'timezone':return(p.timezone||'').toLowerCase();
    case 'source':return(p.registered_via||'manual').toLowerCase();
    case 'status':return pStatus(p);
    case 'registered':return p.created_at||'';
    case 'approved_at':return p.approved_at||'';
    case 'approved_by':return(p.approved_by||'').toLowerCase();
    case 'invited_at':return p.invited_at||'';
    case 'invited_by':return(p.invited_by||'').toLowerCase();
    case 'role':return p.role_label||p.role||'participant';
    case 'first_login':return p.login_time||'';
    case 'last_login':return p.last_login_time||'';
    case 'competitions':return(p.competitions||[]).map(c=>c.name).join(', ').toLowerCase();
    default:return '';
  }
}

export function sortParticipants(col){
  if(S.pSortCol===col)S.pSortAsc=!S.pSortAsc; else{S.pSortCol=col;S.pSortAsc=true;}
  renderParticipants();
}

export function toggleAllParticipants(checked){
  // Toggle all visible (filtered+paginated) non-disabled participants
  const checkboxes=document.querySelectorAll('#admin-participants-body input[type="checkbox"]');
  checkboxes.forEach(cb=>{
    if(cb.disabled)return;
    cb.checked=checked;
    if(checked)S.selectedParticipants.add(cb.value);
    else S.selectedParticipants.delete(cb.value);
  });
  updateSelectionBar();
}

export function toggleParticipantSelection(id,checked){
  if(checked)S.selectedParticipants.add(id);
  else S.selectedParticipants.delete(id);
  updateSelectionBar();
}

// Whether the selection bar may offer a DIRECT assign into the focused event
// (`Assign to "<event>"`) rather than the Assign-to-Events picker. It mirrors the
// assign route's own validation (the route asks the revive path BEFORE the
// late-entry window; both admit, so the order does not change this yes/no):
//
//   * v8.12.6 — an event that takes new members at all (`compAcceptsNewMembers`:
//     upcoming, live, or an ended Booth Event still taking late entries — the
//     route admits that one as a late entrant);
//   * otherwise an AUTO-ended event whose scheduled end is still ahead, which the
//     route REVIVES — and never one ended with End Now. The `!ended_manually`
//     clause is v8.12.6 too: End Now stores a duration rounded UP to the minute,
//     so for up to ~60 s afterwards the scheduled end is still in the future and
//     the bar offered `Assign to "X"` on an event the server then refused as
//     "ended manually" (measured on a Competition 298 ms after End Now). The
//     route refuses a manual end whatever the schedule says; so does this.
export function isCompEffectivelyActive(comp){
  if(!comp)return false;
  if(compAcceptsNewMembers(comp))return true;
  if(computeCompStatus(comp)==='ended'&&!comp.ended_manually){
    const scheduledEnd=new Date(comp.start_time).getTime()+comp.duration_minutes*60000;
    return scheduledEnd>Date.now();
  }
  return false;
}

// The selection bar is the ONE door for acting on ticked people: assigning them
// to events was also a toolbar button, the same action on the same selection
// (owner's decision, 27 Nov 2026: removed).
export function updateSelectionBar(){
  const bar=document.getElementById('participants-selection-bar');
  const barBtn=document.getElementById('selection-bar-assign-btn');
  const count=S.selectedParticipants.size;
  const comp=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
  // v8.12.0 — a competitor may not assign into the event they compete in.
  const directAssign=comp&&isCompEffectivelyActive(comp)&&!comp.competing;
  const label=directAssign?`Assign to "${comp.name}"`:'Assign to Events';
  const handler=directAssign?quickAssignSelectedToCompetition:openBulkAssignModal;
  const approveBtn=document.getElementById('selection-bar-approve-btn');
  // RBAC — each bulk door asks what its route and its dialog's reads need:
  // assign (`participants.enrol`; outside an event the Assign to Events dialog
  // also reads the event and group lists, `events.view` and `groups.view`), Add
  // to Group (the group list and the group's member write: `groups.view`,
  // `groups.manage`), approve (`participants.approve`).
  const canAssign=adminCan('participants.enrol')&&(!!directAssign||(adminCan('events.view')&&adminCan('groups.view')));
  const groupBtn=document.getElementById('selection-bar-group-btn');
  if(groupBtn)groupBtn.style.display=adminCan('groups.view')&&adminCan('groups.manage')?'':'none';
  if(barBtn)barBtn.style.display=canAssign?'':'none';
  if(count>0){
    bar.style.display='flex';
    // audit v7.12.3 (#12) — pad the page while the FIXED mobile bar is shown so
    // bottom-of-page focusables aren't trapped under it (see styles.css).
    document.body.classList.add('selection-bar-open');
    document.getElementById('selection-count').textContent=count+' selected';
    barBtn.textContent=label;
    barBtn.onclick=handler;
    // Only show approve button if selected participants include pending users
    // that are in the selected competition (or no competition is selected).
    // v6.10.22: key on pStatus(p)==='pending' rather than the explicit
    // `verified && !approved && !blocked` triad — pStatus priorities
    // 'locked' above 'pending', so a temporarily-locked user no
    // longer counts as approvable (server-side /approve + /bulk-approve
    // return 400 / skipped for them as of v6.10.19).
    const selectedIds=[...S.selectedParticipants];
    const hasPendingInScope=S.adminParticipantsData.some(p=>{
      if(!selectedIds.includes(p.id))return false;
      if(pStatus(p)!=='pending')return false;
      if(_waitingOnly(p))return false;
      if(S.adminSelectedCompetitionId)return(p.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId);
      return true;
    });
    if(approveBtn)approveBtn.style.display=hasPendingInScope&&adminCan('participants.approve')?'':'none';
  }else{
    bar.style.display='none';
    document.body.classList.remove('selection-bar-open');
  }
}

// v8.7.0 — THE ROLE CELL MUST SAY *WHICH* EVENTS.
//
// "Event admin" alone is the half an admin cannot act on: the role is granted
// once and the events change constantly, so the operator's question at this row
// is always "which of my events is she running?". `event_admin_for` rides the
// participants payload for exactly that (and is itself narrowed to the viewer's
// own scope when the viewer is an event admin).
//
// v8.8.7 — AND IT SAYS SO IN BADGES, filtered to what is actionable. It used to
// render one name, or the bare count "3 events" with the names hidden in a
// title — so the common case told the operator a number and made them hover to
// learn anything. It now mirrors the participant events column beside it:
// `compDisplayCategory` for the class and the label, live / upcoming /
// late-entry only, each badge focusing its event. Every badge here is in the
// viewer's own scope by construction (the server narrows the field), so the
// focus affordance cannot dead-end the way v8.7.7 recorded for a projection
// that was not narrowed.
//
// v8.8.10 — AND NOTHING IS RENDERED WHEN NOTHING IS CURRENT. Operator decision,
// reversing the half of v8.8.7 that gave the two empty states their own copy.
//
// That version argued they must not be CONFLATED — an organiser of three
// finished events must not read as one who organises nothing — and answered it
// with "no current events (3 finished)" beside "no events". The argument was
// about telling them apart; the operator's point is that NEITHER is worth
// telling. Nothing here is actionable: the role badge already says what the
// person is, and a grey sentence where the badges go is noise on a dense table.
//
// So the distinction is dropped rather than re-drawn, and this comment records
// that it was DROPPED rather than forgotten — the states still differ in the
// payload (`event_admin_for` is empty vs non-empty), and a future reader who
// wants that difference on screen should reach for the History dialog or the
// Organisers list, not for a label in this cell.
/**
 * The People row's Role cell. The built-in roles by name; a CUSTOM role by the
 * label its row carries (`role_label`), never as "Participant" — with, like an
 * event admin, the live events it organises.
 */
export function roleCellHtml(p){
  const r=p.role||'participant';
  if(r==='superadmin')return '<span class="role-badge superadmin">Superadmin</span>';
  if(r==='admin')return '<span class="role-badge admin">Admin</span>';
  if(r==='event_admin')return eventAdminCellHtml(p);
  if(r==='participant')return '<span class="t-cap t-muted">Participant</span>';
  return eventAdminCellHtml(p,{label:p.role_label||'Custom role',cls:'custom'});
}

function eventAdminCellHtml(p,{label='Event admin',cls='admin'}={}){
  const evs=Array.isArray(p.event_admin_for)?p.event_admin_for:[];
  const current=evs.filter(e=>{
    const cat=compDisplayCategory(e);
    return cat==='live'||cat==='upcoming'||cat==='late-entry';
  });
  const badges=current.length
    ? `<span class="ea-events">${current.map(e=>{
        const cat=compDisplayCategory(e);
        const tip=COMP_CATEGORY_LABEL[cat]||'Ended';
        return `<span class="badge comp-badge comp-${esc(cat)}" title="${esc(tip)}" style="cursor:pointer"`
          +` data-action="comp-focus" role="button" tabindex="0" aria-label="${esc(e.name)} — open this event"`
          +` data-comp-id="${esc(e.id)}" data-comp-name="${esc(e.name)}">${esc(e.name)}</span>`;
      }).join(' ')}</span>`
    : '';
  return `<span class="role-badge ${esc(cls)}">${esc(label)}</span>${badges}`;
}

/**
 * v8.8.11 — WHICH SESSION OF THE FOCUSED EVENT THIS PERSON CHOSE, derived.
 *
 * The focused pane used to read `p.chosen_timeslot_id`, a field only the picker
 * emitted — which is why the pane fetched the picker at all, and therefore why
 * it was truncated to the oldest 500 non-members. `p.competitions` carries the
 * same value: BOTH endpoints build that array from a byte-identical query
 * selecting `cu.timeslot_id`, so nothing is lost by deriving it here.
 *
 * Returns null when the person is not in the focused event, or is in it with no
 * session chosen — which are different facts that both callers deliberately
 * treat alike (`x === tsId || !x` reads "matches, or has not chosen yet").
 *
 * NOT synthesised onto the row at load time: that would make the model's shape
 * depend on which fetch path produced it, which is the drift this release
 * removes rather than relocates.
 */
function _focusedSlot(p){
  if(!S.adminSelectedCompetitionId)return null;
  const c=(p.competitions||[]).find(x=>x.id===S.adminSelectedCompetitionId);
  return c?(c.timeslot_id||null):null;
}

// ── Columns: six by default, a chooser for the rest (kept per browser) ───────
//
// Every cell and heading carries `data-pcol`; a hidden column is hidden by the
// table's `data-hide` list (CSS in the ADMIN section). The default six are
// what an organiser scans: who, where from, state, score, last seen, actions.
export const P_COLUMNS = [
  ['participant', 'Participant'], ['email', 'Email'], ['company', 'Company'], ['title', 'Title'], ['location', 'Location'],
  ['source', 'Source'], ['status', 'Status'], ['score', 'Score'], ['registered', 'Registered'], ['approved', 'Approved'],
  ['approver', 'Approver'], ['invited', 'Invited'], ['inviter', 'Inviter'], ['role', 'Role'], ['first_login', '1st login'],
  ['last_active', 'Last active'], ['events', 'Events'], ['tags', 'Tags'], ['groups', 'Groups'], ['actions', 'Actions'],
];
const P_DEFAULT_COLS = ['participant', 'company', 'status', 'score', 'last_active', 'actions'];
const P_FIXED_COLS = new Set(['participant', 'actions']);
const P_COLS_KEY = 'ha:p-cols';

// v8.17.0 — the chooser is the shared component (ui/table-columns.js); this is
// its configuration, defined from boot(). Same storage key (`ha:p-cols`, the
// list of SHOWN keys) and same `data-hide` list on the table, so the email
// fallback under the name and every spec seeding the key keep working.
export const PARTICIPANT_TABLE_COLUMNS = {
  noun: 'participant',
  storageKey: P_COLS_KEY,
  button: '#p-columns-btn',
  popId: 'p-columns-pop',
  defaults: P_DEFAULT_COLS,
  fixed: [...P_FIXED_COLS],
  labels: Object.fromEntries(P_COLUMNS),
  // Outside an event there is no score to show, and a role that may not read the
  // board (`leaderboard.view`) has none to show anywhere; the Columns menu says
  // which of the two it is.
  forceHidden: () => (S.adminSelectedCompetitionId && adminCan('leaderboard.view') ? [] : ['score']),
  forceHiddenNote: () => (adminCan('leaderboard.view') ? '(in an event)' : '(your role cannot see scores)'),
  cols: {
    participant: { grow: true }, status: { filter: 'enum' }, source: { filter: 'enum' }, role: { filter: 'enum' },
    location: { filter: 'enum' }, approver: { filter: 'enum' }, inviter: { filter: 'enum' },
    registered: { filter: 'date' }, approved: { filter: 'date' }, invited: { filter: 'date' }, first_login: { filter: 'date' }, last_active: { filter: 'date' },
    events: { filter: 'tags' }, tags: { filter: 'tags' }, groups: { filter: 'tags' },
  },
  model: {
    rows: () => S.adminParticipantsData || [],
    get: (p, k) => {
      switch (k) {
        case 'participant': return `${p.first_name || ''} ${p.last_name || ''} ${p.nickname || ''}`.trim();
        case 'email': return [p.email, p.secondary_email].filter(Boolean).join(' ');
        case 'company': return p.company || '';
        case 'title': return p.title || '';
        case 'location': return p.country || '';
        case 'source': return p.registered_via || 'manual';
        case 'status': return pStatus(p);
        case 'score': { const m = _pScores.compId === S.adminSelectedCompetitionId ? _pScores.map : null; const v = m ? m.get(p.id) : null; return v == null ? '' : v; }
        case 'registered': return p.created_at || '';
        case 'approved': return p.approved_at || '';
        case 'approver': return p.approved_by || '';
        case 'invited': return p.invited_at || '';
        case 'inviter': return p.invited_by || '';
        case 'role': return p.role_label || p.role || 'participant';   // a custom role by its label
        case 'first_login': return p.login_time || '';
        case 'last_active': return p.last_login_time || '';
        case 'events': return (p.competitions || []).map(c => c.name);
        case 'tags': return p.tags || [];
        case 'groups': return (p.groups || []).map(g => g.name);
        default: return '';
      }
    },
    onChange: () => { S.pPage = 1; renderParticipants(); },
  },
};

function _syncParticipantColumns() {
  syncTable(document.getElementById('p-table'));
}

/** The Columns button: a small checklist, applied at once and remembered. */
export function openParticipantColumns(btn) {
  openColumnsMenu('participants', btn);
}

// ── "Search everyone" inside an event ────────────────────────────────────────
// What the box beside the search widens the list to. A role scoped to its
// events (an event admin) is listed only the people of its own events, so for
// it the box says exactly that rather than promise every account on the
// platform; its "?" tip and the empty list's advice use the same words.
export function wsEveryoneLabel(){
  return S.isEventAdmin?'Show people from your other events':'Search everyone on the platform';
}
function _syncWsEveryoneLabel(){
  const box=document.getElementById('p-ws-scope');
  if(!box)return;
  const label=wsEveryoneLabel();
  const txt=[...box.childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
  if(txt&&txt.textContent.trim()!==label)txt.textContent=` ${label}`;
  // The tip's button is named after the words it explains (label-in-name).
  const tip=document.getElementById('p-ws-scope-help');
  if(tip){
    tip.setAttribute('data-help-label',label);
    const b=tip.querySelector('.help-tip-btn');
    if(b&&b.getAttribute('aria-label')!==`About ${label}`)b.setAttribute('aria-label',`About ${label}`);
  }
}

// ── Score column (inside an event) ───────────────────────────────────────────
// From the admin board the Rankings section already reads; one read per event,
// refreshed at most every 15 s, so a re-render never fetches.
let _pScores = { compId: null, at: 0, map: null, inflight: false };
function _pScoreCell(p) {
  if (!S.adminSelectedCompetitionId || _pScores.compId !== S.adminSelectedCompetitionId || !_pScores.map) return '<span class="t-muted">—</span>';
  const v = _pScores.map.get(p.id);
  return v == null ? '<span class="t-muted">—</span>' : esc(String(v));
}
/** The open event's score for one user, when the table has it (else null). */
export function pScoreFor(userId) {
  if (!S.adminSelectedCompetitionId || _pScores.compId !== S.adminSelectedCompetitionId || !_pScores.map) return null;
  const v = _pScores.map.get(userId);
  return v == null ? null : { compId: _pScores.compId, score: v };
}
async function _ensureScores(compId) {
  // RBAC — the board is a `leaderboard.view` read: a role without it sends none
  // (its Score column is hidden, PARTICIPANT_TABLE_COLUMNS.forceHidden).
  if (!adminCan('leaderboard.view')) return;
  if (_pScores.inflight) return;
  if (_pScores.compId === compId && Date.now() - _pScores.at < 15000) return;
  _pScores.inflight = true;
  try {
    const rows = await fetchJsonList(`/api/admin/leaderboard?competitionId=${encodeURIComponent(compId)}`);
    if (S.adminSelectedCompetitionId !== compId) return;
    const map = new Map();
    for (const r of (rows || [])) if (r && r.userId) map.set(r.userId, Number(r.score) || 0);
    const changed = _pScores.compId !== compId || !_pScores.map || [...map].some(([k, v]) => _pScores.map.get(k) !== v) || map.size !== _pScores.map.size;
    _pScores = { compId, at: Date.now(), map: rows ? map : null, inflight: false };
    if (changed && rows) {
      for (const cell of document.querySelectorAll('#admin-participants-body td[data-pcol="score"]')) {
        const id = cell.closest('tr')?.querySelector('input[type="checkbox"][value]')?.value || cell.closest('tr')?.querySelector('[data-user-id]')?.dataset.userId;
        if (!id) continue;
        const v = map.get(id);
        cell.textContent = v == null ? '—' : String(v);
      }
    }
  } finally { _pScores.inflight = false; }
}

function _participantsQuery(){ return (document.getElementById('participants-search')?.value||'').toLowerCase().trim(); }

/**
 * WHAT NARROWS THE PEOPLE TABLE NOW: 'filters' (the search box, a status chip
 * or a heading filter), else 'event' (an event workspace listing its own people,
 * "Search everyone on the platform" unticked), else null. The table's empty row
 * and Export CSV's empty answer both say why nobody is listed from this, so the
 * two never disagree.
 */
export function participantsNarrowing(){
  if(_participantsQuery()||S.pStatusFilter.size>0||hasColumnFilters('participants'))return 'filters';
  if(S.adminSelectedCompetitionId&&!S.pWsShowEveryone)return 'event';
  return null;
}

/** Export CSV's label: it names the open event only while the file is that
 *  event's people (with "Search everyone on the platform" ticked the file is
 *  everyone the table lists, so no event is named). */
function _syncCsvExportLabel(){
  const csvBtn=document.getElementById('export-csv-btn');
  if(!csvBtn)return;
  const label='Export CSV'+(S.adminSelectedCompetitionId&&!S.pWsShowEveryone?` (${S.adminSelectedCompetitionName||'this event'})`:'');
  if(csvBtn.textContent!==label)csvBtn.textContent=label;
}

/**
 * THE PEOPLE THE TABLE LISTS: every page of them, in the table's order — the
 * status chips, inside an event workspace the event's people (or everyone, with
 * "Search everyone on the platform" ticked), the search box and the heading
 * filters, then the table's sort. Export CSV writes exactly these (operator
 * ruling, 14 Nov 2026), so the file is what the screen shows; never give the
 * export a filter of its own.
 */
// Sweep #501 (operator ruling, 23 Nov 2026): someone who signed up through an
// invitation from a role that cannot approve accounts waits for approval, in no
// event yet. The server lists them, with the events their invitation names
// (`waiting_for`: for an organiser, only their own), to the organisers of those
// events; an event's roster holds them beside its members, and the row says
// why they are listed and who approves them.
export function inOpenEventRoster(p){
  const id=S.adminSelectedCompetitionId;
  return (p.competitions||[]).some(c=>c.id===id)||(p.waiting_for||[]).some(c=>c.id===id);
}
function _waitingNote(p){
  const w=Array.isArray(p.waiting_for)?p.waiting_for:[];
  if(!w.length)return '';
  return `<span class="p-waiting-for">Invited to ${w.map(c=>`“${esc(c.name)}”`).join(', ')}: waiting for an administrator's approval</span>`;
}
// A row an organiser sees only because it waits on an invitation to one of their
// events: not in any of their events, so none of their row actions applies.
function _waitingOnly(p){ return !!S.isEventAdmin&&(p.waiting_for||[]).length>0&&!(p.competitions||[]).length; }

export function participantsInView(){
  let ps=[...S.adminParticipantsData];
  // v6.14.0 — multi-select union semantics. Empty set means "all".
  if (S.pStatusFilter.size > 0) ps = ps.filter(p => S.pStatusFilter.has(pStatus(p)));
  // Inside an event workspace the table is the EVENT's people; "Everyone (to
  // add)" widens it to every account, members first, so an organiser can add
  // someone without leaving the event.
  if (S.adminSelectedCompetitionId && !S.pWsShowEveryone) ps = ps.filter(inOpenEventRoster);
  const q=_participantsQuery();
  if(q) ps=ps.filter(p=>[p.first_name,p.last_name,p.nickname,p.email,p.secondary_email,p.company,p.title,p.country,p.timezone,pStatus(p),p.registered_via||'manual',p.approved_by,p.invited_by,p.role,p.role_label,...(p.tags||[]),...(p.groups||[]).map(g=>g.name),...(p.competitions||[]).map(c=>c.name)].some(v=>(v||'').toLowerCase().includes(q)));
  // v8.17.0 — the heading filters (ui/table-columns.js), over every loaded row, before paging.
  ps=applyColumnFilters('participants',ps);
  const _tcSort=columnSortActive('participants');
  const colSort=(a,b)=>{
    if(_tcSort)return 0;
    if(!S.pSortCol)return 0;
    let va=pVal(a,S.pSortCol),vb=pVal(b,S.pSortCol);
    if(typeof va==='number')return S.pSortAsc?va-vb:vb-va;
    return S.pSortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
  };
  // Pending participants first (when no competition selected), then competition grouping
  const pendingPriority=p=>pStatus(p)==='pending'?0:1;
  if(_tcSort)ps=applyColumnSort('participants',ps);
  if(S.adminSelectedCompetitionId){
    const inScope=p=>{
      if(!(p.competitions||[]).some(c=>c.id===S.adminSelectedCompetitionId))return 2; // not in comp
      if(S.adminSelectedTimeslotId){
        // In comp: prioritize matching timeslot or no choice yet
        { const _ts=_focusedSlot(p); if(_ts===S.adminSelectedTimeslotId||!_ts)return 0; }
        return 1; // different timeslot
      }
      return 0; // comp selected, no timeslot filter
    };
    ps.sort((a,b)=>{const g=inScope(a)-inScope(b);return g!==0?g:colSort(a,b);});
  }else{
    ps.sort((a,b)=>{const g=pendingPriority(a)-pendingPriority(b);return g!==0?g:colSort(a,b);});
  }
  return ps;
}

/**
 * THE ACCOUNT DOORS a row offers — Edit/View profile, Block or Unblock, Unlock,
 * Email sign-in code, and the note naming who manages a privileged account —
 * ONE definition for People's row menu and the user rows of Roles & permissions
 * (owner decision, 27 Nov 2026: admin accounts are no longer on People, so their
 * own row there offers the doors People offered them). `p` is a People row (GET
 * /api/admin/participants: `role`, `role_class`, `privileged_target`, `rival_in`,
 * the status columns, `competitions`). Every door asks the predicate its route
 * enforces; the server refuses regardless.
 */
export function accountDoors(p){
  const st=pStatus(p);
  const pRoleForPerm=p.role||'participant';
  const targetPrivileged=targetPrivilegedFor(pRoleForPerm,p);
  const _rival=(p.rival_in&&p.rival_in.id&&!(S.currentUser&&S.currentUser.id===p.id))?p.rival_in:null;
  const isLocked=st==='locked';
  // Regular admins can only block / unblock / unlock / reset non-privileged targets.
  // Server enforces a 403 for admin/superadmin targets on each of those routes;
  // hiding the buttons in the UI prevents the admin from even issuing the action.
  // v8.7.0 — for an EVENT ADMIN, a fellow ORGANISER is a privileged target too.
  // Two organisers sharing an event is the ordinary case this role was built
  // for, so without this clause the menu would offer block / deny / reset /
  // impersonate against a colleague the server then refuses
  // (`event_admin_target_privileged`) — offering a control that is certain to
  // fail is the v7.14.2 defect, and the note below is what makes the absence
  // legible rather than looking like a broken feature.
  //
  // A GLOBAL admin is deliberately unaffected: they must be able to manage and
  // demote an event admin, so `event_admin` is privileged only in this actor's
  // eyes, which is exactly what the server's `participantDenied` decides.
  const _canBlockBase=S.isSuperAdmin||!targetPrivileged;
  // RBAC — each door asks the permission its route enforces: block and deny
  // (`participants.block` / `participants.approve`), the emailed sign-in code
  // (`participants.signin_codes`), unlock (`participants.edit`).
  const canBlock=_canBlockBase&&!_rival&&adminCan('participants.block');
  const canReset=_canBlockBase&&!_rival&&adminCan('participants.signin_codes');
  const canUnlock=_canBlockBase&&adminCan('participants.edit');
  // v7.14.2 — a regular admin acting on a PRIVILEGED peer is refused server-side
  // (peer-admin doctrine: block/reset/role/delete/edit are all superadmin-only on
  // admin+superadmin targets). The client correctly hid those items, but silently:
  // the menu collapsed to Edit Profile + History with no reason given, which is
  // indistinguishable from the feature being broken — and "Edit Profile" then
  // opened a read-only dialog, so the one prominent item lied. Name the reason
  // in the menu and relabel the item to match what it actually does.
  const restrictedPeer=targetPrivileged&&!S.isSuperAdmin;
  // v8.7.0 — the note must name the RIGHT tier and the RIGHT remedy. For an
  // event admin looking at a fellow organiser the answer is "an administrator",
  // not "a superadmin" — a note that sends them to the wrong person is the
  // FROZEN_REMEDY failure (an instruction that is not true is worse than none).
  // A custom role is named by its label. A regular admin's privileged row is
  // a superadmin's to manage; an organiser's is an administrator's, unless it
  // is unscoped (admin, superadmin, a custom role of class `all`).
  const _peerName=pRoleForPerm==='superadmin'?'Superadmin':pRoleForPerm==='admin'?'Admin':pRoleForPerm==='event_admin'?'Event admin':(p.role_label||'Admin');
  return {pRoleForPerm,targetPrivileged,_rival,isLocked,_canBlockBase,canBlock,canReset,canUnlock,restrictedPeer,_peerName};
}

/** The note naming who manages a privileged account (`accountDoors`), or ''. */
export function accountPeerNoteHtml(p){
  const d=accountDoors(p);
  return d.restrictedPeer
    ?((!S.isEventAdmin||isUnscopedAdminRow(d.pRoleForPerm,p))
      ?`<div class="kebab-note" role="presentation">${ICO.lock} ${esc(d._peerName)} account — only superadmins can manage it</div>`
      :`<div class="kebab-note" role="presentation">${ICO.lock} ${esc(d._peerName)} account — only an administrator can manage it</div>`)
    :'';
}
/** "Edit Profile", or "View Profile" where the editor opens read-only. */
export function accountProfileLabel(p){
  return (accountDoors(p).restrictedPeer||!adminCan('participants.edit'))?'View Profile':'Edit Profile';
}
/** Block, Unblock or Unlock, as the row's state and the actor allow (`accountDoors`), or ''. */
export function accountBlockDoorHtml(p){
  const {_rival,canUnlock,canBlock,isLocked}=accountDoors(p);
  // Is this user in any LIVE competition? Elevates Block from warning to danger
  const userInLive=(p.competitions||[]).some(c=>c.status==='live');
  const blockCls=userInLive?'km-danger':'km-warning';
  // v6.14.0 — hide Unblock on denied rows. Unblocking a denied user
  // without clearing denied_at would leave the row in a stale state
  // (login passes the blocked gate, then shows pending_approval, but
  // the operator can't actually approve them via /approve unless the
  // row goes through the deny-reversal branch which requires
  // denied_at to still be set). Approve (above) is the only correct
  // path back from Denied; Unblock simply doesn't apply.
  return (_rival&&canUnlock&&isLocked&&!p.blocked&&!p.denied_at)
    ?`<button data-action="participant-unlock" data-user-id="${esc(p.id)}">${ICO.unlock} Unlock</button>`   // v8.12.0 — unlock is not a board input, so a rival keeps it
    :!canBlock?'':p.denied_at
    ?''
    :p.blocked
    ?`<button data-action="participant-block" data-user-id="${esc(p.id)}" data-blocked="true">${ICO.shieldOff} Unblock</button>`
    :isLocked?(canUnlock?`<button data-action="participant-unlock" data-user-id="${esc(p.id)}">${ICO.unlock} Unlock</button>`:'')
    :`<button class="${blockCls}" data-action="participant-block" data-user-id="${esc(p.id)}" data-blocked="false">${ICO.ban} Block</button>`;
}

export function renderParticipants(){
  // v8.12.6 (review) — WHICH STATE OF THE FOCUSED EVENT THESE ROWS WERE BUILT FOR.
  // Each row's Invite and Remove items, and its notes, read the focused event's
  // display category at render time, so when that category moves (the event
  // ends and its late-entry window opens, or the window closes) the rows are
  // stale until they are rendered again. `resyncParticipantsWithFocus` compares
  // against THIS — the category the table was last rendered with — never against
  // a snapshot of the competitions list taken before a reload, which the scope
  // banner's own reload had usually refreshed first, hiding the change.
  { const _f=S.adminSelectedCompetitionId?(S.adminCompetitionsData||[]).find(c=>c.id===S.adminSelectedCompetitionId):null;
    S._pRenderedFocus=S.adminSelectedCompetitionId?{id:S.adminSelectedCompetitionId,cat:_f?compDisplayCategory(_f):null}:null; }
  // Approval noise only when there is approval work: the Pending chip shows while
  // the platform holds sign-ups for approval or somebody is waiting (or the chip
  // is the active filter, so it can be turned off again).
  { const _pc=document.querySelector('#p-status-filters [data-value="pending"]');
    if(_pc)_pc.hidden=!(S.requireAccountApproval||S.pStatusFilter.has('pending')||(S.adminParticipantsData||[]).some(p=>pStatus(p)==='pending')); }
  const ps=participantsInView();
  const q=_participantsQuery();
  _syncCsvExportLabel();
  // RBAC — a row is selected only for a bulk door (assign, Add to Group,
  // approve; updateSelectionBar): a role holding none gets no checkboxes and no
  // Select all.
  const _canSelectP=adminCan('participants.enrol')||(adminCan('groups.view')&&adminCan('groups.manage'))||adminCan('participants.approve');
  { const sa=document.getElementById('select-all-participants'); const lb=sa&&sa.closest('label'); if(lb)lb.style.display=_canSelectP?'':'none'; }
  // Update sort icons
  document.querySelectorAll('[id^="sort-"][id$="-icon"]').forEach(el=>el.textContent='');
  if(S.pSortCol){const ic=document.getElementById(`sort-${S.pSortCol}-icon`);if(ic)ic.textContent=S.pSortAsc?' ▲':' ▼';_syncSortAria(ic,S.pSortAsc);/* audit v7.7.33 (AL10) */}

  // Pagination
  const totalFiltered=ps.length;
  const totalPages=Math.max(1,Math.ceil(totalFiltered/S.pPageSize));
  if(S.pPage>totalPages)S.pPage=totalPages;
  const startIdx=(S.pPage-1)*S.pPageSize;
  const pageData=ps.slice(startIdx,startIdx+S.pPageSize);

  if(!pageData.length){
    // A heading filter (ui/table-columns.js) narrows the list as surely as the
    // search box: an empty list it caused says so and offers the way out, never
    // "nobody yet", which would be a false fact about the data.
    const _colFiltered=hasColumnFilters('participants');
    const hasFilter=q||S.pStatusFilter.size>0||_colFiltered||S.adminSelectedCompetitionId;
    const _wsOnly=participantsNarrowing()==='event';
    // The advice names only the doors this role is offered (Invite and Add to
    // event are `participants.enrol`, the join link `events.join_link`).
    const _enrol=adminCan('participants.enrol'), _link=adminCan('events.join_link');
    const _advice=_enrol&&_link?` Use <strong>Invite</strong>, the join link, or <strong>${esc(wsEveryoneLabel())}</strong> to add people.`
      :_enrol?` Use <strong>Invite</strong> or <strong>${esc(wsEveryoneLabel())}</strong> to add people.`
      :_link?' Use the join link to add people.':'';
    const partEmptyMsg=_wsOnly?`Nobody is in this event yet.${_advice}`
      :(_colFiltered&&!q)?'No participant matches the column filters. <button type="button" class="btn sm secondary table-empty-action" data-tcol-clear="participants">Clear column filters</button>'
      :hasFilter?'No participants match the current filters.':'No participants yet.';
    setSafeHtml(document.getElementById('admin-participants-body'),`<tr><td colspan="22" class="table-empty-row">${partEmptyMsg}</td></tr>`);
  }else setSafeHtml(document.getElementById('admin-participants-body'), pageData.map(p=>{
    const st=pStatus(p);
    const statusHtml=st==='denied'?`<span class="status-badge denied" title="${esc(p.denied_reason||'')}">Denied</span>`
      :st==='blocked'?'<span class="status-badge blocked">Blocked</span>'
      :st==='locked'?'<span class="status-badge locked">Locked</span>'
      :st==='unconfirmed'?'<span class="status-badge unconfirmed">Unconfirmed</span>'
      :st==='pending'?`<span class="status-badge pending">Pending</span>${_waitingNote(p)}`
      :'<span class="status-badge confirmed">Confirmed</span>';
    const sourceCombined=(p.registered_via||'manual')==='linkedin'
      ?(p.linkedin_url?`<a href="${esc(p.linkedin_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--linkedin-brand);text-decoration:none;display:inline-flex;align-items:center;gap:4px" title="View LinkedIn profile">LinkedIn ${ICO.link}</a>`:'<span style="color:var(--muted)">LinkedIn</span>')
      :`<span style="color:var(--muted)">Manual</span>${p.linkedin_url?` <a href="${esc(p.linkedin_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--linkedin-brand);display:inline-flex;vertical-align:middle" title="View LinkedIn profile">${ICO.link}</a>`:''}`;
    // audit v7.7.33 (AL13) — the remove-× spans get role=button+tabindex from the
    // a11y tagger but read only as "×"; add an aria-label naming the tag/group +
    // user so screen readers announce what will be removed. (24px hit target via CSS.)
    const {pRoleForPerm,targetPrivileged,_rival,isLocked,_canBlockBase,canBlock,canReset,canUnlock,restrictedPeer}=accountDoors(p);
    const peerNoteKm=accountPeerNoteHtml(p), profileLabel=accountProfileLabel(p), blockKm=accountBlockDoorHtml(p);
    // v8.11.4 — HOISTED above the tag/group cells, which need the same answer.
    // It used to be computed thirty lines below them, which is why those two
    // cells were the only controls on this row with no tier gate at all.
    const _pn=esc(p.nickname||p.email||'user');
    // v8.11.4 — WITHHOLD THE CHIP CONTROLS WITH THEIR REASON on a privileged
    // target. Both routes refuse a non-superadmin here with a named 403
    // ("Only a superadmin can modify tags / group membership on an admin or
    // superadmin account."), and these two cells were the last controls on this
    // row still offered where the server is certain to refuse — the v7.14.2
    // defect, and the v8.8.4 challenge-tags fix one table over.
    //
    // The chips themselves STILL RENDER: which groups a colleague is in is a
    // fact this admin legitimately needs. Only the `×` and the `+` go, and the
    // reason goes with them — a cell that silently loses its controls reads as a
    // broken feature and is reported as one. It is a VISIBLE line rather than a
    // `title` alone, because a tooltip is unreachable by touch and by keyboard,
    // which is most of how this table is read.
    // v8.12.0 — THE RIVAL. The server says which rows share a compete event with
    // the actor (`rival_in`, lib/staff-compete.js rivalsOf — the ANSWER, not the
    // rule, the v8.7.0 shape), and every ACCOUNT door on such a row — block /
    // unblock, deny, approve, verify, impersonate, reset, a role change, delete,
    // the benchmark tag — is refused `competitor_cannot_edit` (the operator's
    // ruling: a board change wearing the account's clothes is still a board
    // change). Withheld WITH the reason, per v7.14.2; viewing (the profile
    // dialog, History) and every door that is not a board input stay. Never on
    // the actor's OWN row, which the server exempts too.
    // RBAC — the chip routes are `participants.edit` routes.
    // A waiting invitee in none of an organiser's events (sweep #501): nothing on
    // the row is theirs to change, and its menu says who approves.
    const canManageChips=(S.isSuperAdmin||!targetPrivileged)&&adminCan('participants.edit')&&!_waitingOnly(p);
    const _chipNote=(canManageChips||_waitingOnly(p))?'':`<div class="chip-note">Admin account — only a superadmin can change these</div>`;
    const tagsHtml=(p.tags||[]).map(t=>`<span class="tag"${(_rival&&t==='benchmark')?' title="You compete alongside this person — the benchmark tag cannot be changed from here"':''}>${esc(t)}${(canManageChips&&!(_rival&&t==='benchmark'))?`<span class="tag-x" data-action="participant-tag-remove" data-user-id="${esc(p.id)}" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)} from ${_pn}">×</span>`:''}</span>`).join('')
      +(canManageChips?`<span class="tag-add" data-action="participant-tag-add" data-user-id="${esc(p.id)}">+ tag</span>`:'')+_chipNote;
    // v8.12.0 — a group bound to an event the actor competes in cannot have its
    // membership changed by them (`competitorGroupDenied`), so that chip keeps its
    // name and loses its `×`, with the reason on the chip's title (the visible
    // reason for the `+` lives in the picker it opens).
    const groupsHtml=(p.groups||[]).map(g=>`<span class="group-tag"${g.competing?' title="Bound to an event you compete in — its membership cannot be changed from here"':''}>${esc(g.name)}${(canManageChips&&!g.competing)?`<span class="tag-x" data-action="participant-group-remove" data-user-id="${esc(p.id)}" data-group-id="${esc(g.id)}" aria-label="Remove ${_pn} from group ${esc(g.name)}">×</span>`:''}</span>`).join('')
      // "+ group" first reads the group list (`groups.view`).
      +((canManageChips&&adminCan('groups.view'))?`<span class="tag-add" data-action="participant-group-add" data-user-id="${esc(p.id)}">+ group</span>`:'')+_chipNote;
    // Verify action is superadmin-only (server enforces with 403). It's a
    // recovery tool for users who can't receive the verification email —
    // pair it with Show sign-in code, a one-time code the operator hands over
    // in person. `participants.verify` (a superadmin-only permission) gates it.
    const verifyKm=(!p.verified&&adminCan('participants.verify')&&!_rival)?`<button class="km-warning" data-action="participant-verify" data-user-id="${esc(p.id)}">${ICO.mailCheck} Verify</button>`:'';
    // v6.10.19: matches server-side /approve gate exactly — verified,
    // not blocked, not locked. Kebab was already checking verified +
    // blocked; adding isLocked keeps the action list in lockstep with
    // what the server would actually accept.
    // v6.14.0 — Approve gate is unchanged (verified+!approved+!blocked+!locked)
    // EXCEPT one branch: clicking Approve on a denied user is the "reverse
    // denial" path and clears denied_at + blocked=1 + sets approved=1 in
    // one txn. The button still renders for that case so a single click
    // works.
    const isDenied = st === 'denied';
    const approveKm = (p.verified && !p.approved && (!p.blocked || isDenied) && !isLocked && !_rival && adminCan('participants.approve'))
      ? `<button class="km-warning" data-action="participant-approve" data-user-id="${esc(p.id)}">${ICO.userCheck} Approve${isDenied ? ' (reverse denial)' : ''}</button>`
      : '';
    // Deny: only on the pre-approval lifecycle (unconfirmed / pending) and
    // never on already-denied / blocked / approved / locked rows. The
    // peer-admin guard mirrors block (canBlock) — regular admins cannot
    // deny admin/superadmin targets.
    const canDeny = _canBlockBase && !_rival && adminCan('participants.approve') && !p.approved && !p.denied_at && !p.blocked && !isLocked;
    const denyKm = canDeny
      ? `<button class="km-danger" data-action="participant-deny" data-user-id="${esc(p.id)}">${ICO.ban} Deny Approval</button>`
      : '';
    const pRole=p.role||'participant';
    const isSelf=S.currentUser&&S.currentUser.id===p.id;
    // ROLE CHANGES LIVE ON ROLES & PERMISSIONS ONLY (owner's decision, 27 Nov
    // 2026): the row's Promote/Demote items are gone, and the row links there
    // instead, for the viewer who could make the change (a superadmin, not on
    // their own row, not on a rival's: the role route is a rival door). That page
    // lists the admin accounts with Change role, and Add user gives an existing
    // participant an admin role; it opens searched to this person.
    let roleKm='';
    if(S.isSuperAdmin&&!isSelf&&!_rival&&adminPageOffered('admin-users-tab')){
      roleKm=`<button data-action="participant-open-roles" data-user-id="${esc(p.id)}" data-email="${esc(p.email||'')}">${ICO.key} Change role on Roles &amp; permissions</button>`;
    }
    // v8.7.0 — MAKE / REMOVE EVENT ADMIN, for the focused event.
    //
    // Offered only where the server will honour it, which is four conditions and
    // not three: a GLOBAL admin (an event admin may never grant — that is what
    // stops the role self-propagating), a non-privileged target (promoting a full
    // admin is a demotion and belongs on the role control), not yourself, and a
    // FOCUSED event — the grant is per event, so without one there is nothing to
    // grant. The last is why this is a kebab item rather than a role option: the
    // role controls are global, this one names an event.
    const _eaEvents=Array.isArray(p.event_admin_for)?p.event_admin_for:[];
    const _focusComp=S.adminSelectedCompetitionId
      ?(S.adminCompetitionsData||[]).find(c=>c.id===S.adminSelectedCompetitionId):null;
    const _eaAlready=!!(_focusComp&&_eaEvents.some(e=>e.id===_focusComp.id));
    let eventAdminKm='';
    // v8.12.0 — the organiser grant/revoke routes are competitor doors, so while
    // the actor competes in the focused event the two items are withheld (the
    // row carries the competing note beside the invite/remove gating below).
    if(S.isAdmin&&!S.isEventAdmin&&adminCan('events.organisers')&&!targetPrivileged&&!isSelf&&!(_focusComp&&_focusComp.competing)){
      if(_focusComp){
        eventAdminKm=_eaAlready
          ?`<button class="km-warning" data-action="participant-event-admin-revoke" data-user-id="${esc(p.id)}" data-comp-id="${esc(_focusComp.id)}" data-comp-name="${esc(_focusComp.name)}" data-nickname="${esc(p.nickname||'')}">${ICO.arrowDown} Remove as event admin of "${esc(_focusComp.name)}"</button>`
          :`<button class="km-warning" data-action="participant-event-admin-grant" data-user-id="${esc(p.id)}" data-comp-id="${esc(_focusComp.id)}" data-comp-name="${esc(_focusComp.name)}" data-nickname="${esc(p.nickname||'')}">${ICO.arrowUp} Make event admin of "${esc(_focusComp.name)}"</button>`;
      }
      // With NO event focused there is nothing to grant, and NO note either.
      //
      // The v7.14.2 rule is about a control that DISAPPEARS — a menu that
      // silently shrank, which reads as a broken feature. Nothing shrinks here:
      // this item is per EVENT and simply has no subject yet. A permanent
      // "focus an event first" line on every participant row, for every admin,
      // would be noise on the densest menu in the panel — and it measurably
      // collides with the notes that ARE explaining an absence (it broke the
      // v8.1.3 unapproved-row assertions, which expect exactly one).
      // Discovery is the focused-event workflow itself, the event's own
      // Organisers list, and the admin guide.
    }
    // v7.14.0 — Impersonate: any admin, PARTICIPANT-role targets only (server
    // 403s privileged targets), and only accounts that could pass the
    // participant guards (approved + not blocked/denied + verified — the
    // server additionally admits verification-grace accounts and 409s the
    // rest with a reason toast).
    // v7.15.8 — `p.verified` dropped: an UNVERIFIED participant is exactly the one
    // an admin needs to look at (the account is stuck), and the server no longer
    // refuses it. approved / blocked / denied stay — those are deliberate
    // administrative stops rather than a state worth inspecting.
    // v8.12.1 — `data-role` rides the button so the dialog can offer an event
    // admin's TWO views; and the item is withheld WITH its reason while already
    // impersonating (the server refuses a nested entry with a named 409 —
    // through an organiser's panel the seat may not open a third seat), which
    // is the v7.14.2 rule: gate the affordance and the explanation together.
    const impersonateKm=impersonateOfferedFor(p)
      ?`<button data-action="participant-impersonate" data-user-id="${esc(p.id)}" data-nickname="${esc(p.nickname||'')}" data-role="${esc(pRoleForPerm)}">${ICO.eye} Impersonate</button>`
      :'';
    const nestedImpNoteKm=(S.impersonation&&!targetPrivileged&&!isSelf&&p.approved&&!p.blocked&&!p.denied_at&&!_rival)
      ?`<div class="kebab-note" role="presentation">${ICO.eye} Impersonation cannot be nested — exit the current one first</div>`
      :'';
    // A CUSTOM role is never impersonable (the route refuses
    // impersonation_target_custom_role), so a viewer who manages the row and
    // would otherwise be offered the item is told why it is missing. A privileged
    // peer's note already explains the shorter menu.
    const customImpNoteKm=(!['participant','event_admin','admin','superadmin'].includes(pRoleForPerm)&&!restrictedPeer&&!isSelf&&p.approved&&!p.blocked&&!p.denied_at&&!_rival&&!S.impersonation)
      ?`<div class="kebab-note" role="presentation">${ICO.eye} Accounts with a custom role cannot be impersonated</div>`
      :'';
    // v8.1.0 — SHOW SIGN-IN CODE. The desk fallback, reachable from the row.
    //
    // v8.1.3 — `can_use_code` is now the WHOLE answer, so this gate OBEYS it and
    // recombines nothing. It used to AND in `!blocked && !denied_at` and stop
    // there, which left approval out on both sides: an unapproved passwordless
    // account (every LinkedIn self-signup still in the queue) was offered the
    // item, handed a working-looking code, and refused at every redemption with
    // copy that blamed expiry. The server re-checks the identical predicate, so
    // the affordance can never be offered where it would be refused (v7.14.2).
    // A rival's code is a working credential for their account: withheld like
    // every other rival door (the server refuses `competitor_cannot_edit`).
    const codeKm=(!targetPrivileged&&p.can_use_code&&!_rival&&adminCan('participants.signin_codes'))
      ?`<button data-action="participant-show-code" data-user-id="${esc(p.id)}" data-nickname="${esc(p.nickname||'')}">${ICO.key||ICO.lock} Show sign-in code</button>`
      :'';
    // …and the item's ABSENCE gets an explanation where one is actionable — a
    // silently shrinking menu is a support ticket (v7.14.2, and it was reported
    // as one). For `not_approved` the remedy is one item up the same menu. For
    // `signed_in_before` (a code is shown only for an account that has never
    // signed in: operator ruling, 14 Nov 2026) the organiser at the desk is
    // hunting for the item they used on this person's first visit, and the door
    // left is Email sign-in code, further down.
    //
    // The reason is computed SERVER-side from the same predicate as the gate
    // (`code_blocked_reason`), never re-derived here from the row's columns.
    const codeNoteKm=(!targetPrivileged&&p.code_blocked_reason==='not_approved')
      ?`<div class="kebab-note" role="presentation">${ICO.key||ICO.lock} A sign-in code needs an approved account${(p.verified&&!p.blocked&&!p.denied_at&&!isLocked)?' — use Approve above':''}</div>`
      :(!targetPrivileged&&!_rival&&p.code_blocked_reason==='signed_in_before'&&adminCan('participants.signin_codes'))
      ?`<div class="kebab-note" role="presentation">${ICO.key||ICO.lock} Has signed in before, so a code can no longer be shown here${canReset?' — use Email sign-in code below':''}</div>`
      :'';
    const locationParts=[p.country,p.timezone].filter(Boolean);
    const locationHtml=locationParts.length?esc(locationParts.join(' · ')):'';
    const isChecked=S.selectedParticipants.has(p.id)?'checked':'';
    // Competition scoping: dim uninvited, highlight selected comp badge, show invite button
    const pComps=p.competitions||[];
    const isInSelectedComp=S.adminSelectedCompetitionId&&pComps.some(c=>c.id===S.adminSelectedCompetitionId);
    // When a timeslot is selected: dim participants in a different timeslot (but not those with no choice)
    const _pSlot=_focusedSlot(p);
    const isInSelectedSlot=!S.adminSelectedTimeslotId||!isInSelectedComp||_pSlot===S.adminSelectedTimeslotId||!_pSlot;
    const dimRow=S.adminSelectedCompetitionId&&(!isInSelectedComp||!isInSelectedSlot);
    // Show competition badges with session name if the participant chose one.
    // Only live/upcoming competitions are shown — ended ones are hidden to keep
    // the list focused on what's actionable. Exception: the currently-scoped
    // competition is always shown (so scoping to an ended comp doesn't leave its
    // members with an empty badge cell). Filtering is display-only; pComps stays
    // complete so scope/search logic above still sees ended memberships.
    // v8.8.0 — a LATE-ENTRY window is kept, for the reason the twin in
    // challenges-admin.js gives: the event has ended and is still joinable.
    const compBadgesHtml=pComps.filter(c=>{
      const cat=compDisplayCategory(c);
      return cat==='live'||cat==='upcoming'||cat==='late-entry'||c.id===S.adminSelectedCompetitionId;
    }).map(c=>{
      const cat=compDisplayCategory(c);
      const cls='comp-'+cat;
      const fullComp2=S.adminCompetitionsData.find(x=>x.id===c.id);
      const cIsInt2=fullComp2&&(fullComp2.tags||[]).includes(DRY_RUN_TAG);
      // v8.12.6 — WHO IS A LATE ENTRANT, on the row itself: the server marks an
      // entry `late_entry_playing: true` exactly when this member is a late
      // entrant playing through the open window (the play gate's own answer), and
      // leaves the key ABSENT otherwise. `=== true`, so an absent key reads as not.
      //
      // (review) — NOT `late_entrant`, which marks the REMOVABLE ones and is
      // narrower: a member who classifies late but has a footprint at or before
      // the end (an imported membership can) is a late entrant (the board ranks
      // them in the Late entrants section) whom the window's removal rule keeps.
      // Keyed on removability, the badge called them an ordinary member.
      const _latePlaying=c.late_entry_playing===true;
      const tip=(_latePlaying?`${COMP_CATEGORY_LABEL['late-entry']} — joined as a late entrant`:(COMP_CATEGORY_LABEL[cat]||'Ended'))+(cIsInt2?` (${DRY_RUN_TAG})`:'');
      const isCurrent=S.adminSelectedCompetitionId&&c.id===S.adminSelectedCompetitionId;
      const tsName=c.timeslot_name||null;
      const tsId=c.timeslot_id||null;
      const isSelectedTs=isCurrent&&S.adminSelectedTimeslotId&&tsId===S.adminSelectedTimeslotId;
      const extra=isSelectedTs?'background:var(--accent-strong);color:var(--on-accent);outline:2px solid var(--focus);outline-offset:1px;font-weight:var(--fw-semibold)'
        :isCurrent?'outline:2px solid var(--focus);outline-offset:1px;font-weight:var(--fw-semibold)':'';
      const intStyle=cIsInt2?'border-bottom:2px solid var(--yellow);':'';
      const label=(tsName?`${c.name} → ${tsName}`:c.name)+(_latePlaying?' · late entrant':'');
      // a11y audit (#4, completion): the 4th comp-focus scope badge — keyboard-
      // operable like the 3 in competitions-admin/challenges-admin. role=button
      // engages the Enter/Space delegator + the .badge[role=button]:focus-visible
      // ring. The aria-label opens with the chip's visible text and then says what
      // it does (WCAG 2.5.3 Label in Name — see *Surfaces a human actually meets*).
      const clickAttrs=tsName&&tsId
        ?`data-action="comp-focus-ts" role="button" tabindex="0" aria-label="${esc(label)} — open this session" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}" data-ts-id="${esc(tsId)}" data-ts-name="${esc(tsName)}"`
        :`data-action="comp-focus" role="button" tabindex="0" aria-label="${esc(label)} — open this event" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}"`;
      return`<span class="badge comp-badge ${cls}" title="${tip}" style="cursor:pointer;${extra}${intStyle}" ${clickAttrs}>${esc(label)}</span>`;
    }).join(' ')||'<span style="color:var(--muted);font-size:var(--fs-12)">—</span>';
    // Invite/uninvite buttons: show when a non-ended competition is selected (never for staff/benchmark)
    const _selCompP=S.adminSelectedCompetitionId?S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId):null;
    // v8.12.6 — "not ended" became "takes new members": an ended Booth Event still
    // taking late entries admits an invite (as a late entrant), which the server's
    // assign route now does too. `_compOpen` is ONE answer for the Invite item and
    // for the wording of the notes below, via the shared client mirror.
    const _compOpen=compAcceptsNewMembers(_selCompP);
    const _compNotEnded=_selCompP&&computeCompStatus(_selCompP)!=='ended';
    const _focusLate=isLateEntryOpen(_selCompP);
    // This member's own entry for the FOCUSED event, which carries the server's
    // `late_entrant` verdict (absent unless the window is open and they are a
    // REMOVABLE late entrant) and `late_entry_playing` (a late entrant playing
    // through the window, removable or not).
    const _focusEntry=isInSelectedComp?pComps.find(c=>c.id===S.adminSelectedCompetitionId):null;
    const _focusLateEntrant=!!(_focusEntry&&_focusEntry.late_entrant===true);
    const _focusLatePlaying=!!(_focusEntry&&_focusEntry.late_entry_playing===true);
    const _pIsStaff=(p.tags||[]).includes('staff');
    // v8.12.0 — STAFF CAN COMPETE. A staff row is invitable to the focused event
    // when that event lets staff compete (`staff_compete` on the admin row), and
    // never otherwise — the server skips it, so offering it would be the v7.14.2
    // defect. And when the ACTOR competes in the focused event (`competing` on
    // the row, from the predicate every write door enforces), inviting and
    // removing are withheld — except removing THEMSELVES, which is the one door
    // the server keeps open as their escape hatch.
    const _staffOkHere=!_pIsStaff||!!(_selCompP&&_selCompP.staff_compete);
    const _actorCompetes=!!(_selCompP&&_selCompP.competing);
    const _isSelf=!!(S.currentUser&&S.currentUser.id===p.id);
    // Enrolling an admin or superadmin as a COMPETITOR is a superadmin's act (the
    // assign door skips it for anyone else, `skippedPrivileged`), so on a compete
    // event the Invite item is withheld from a non-superadmin for a privileged
    // row — except their own, which the server always admits.
    // The server's rule names admin and superadmin ROLES (never event_admin), so
    // this reads the role rather than `targetPrivileged`, which an event-admin
    // actor also answers for a fellow organiser.
    const _peerOk=S.isSuperAdmin||_isSelf||!isUnscopedAdminRow(pRoleForPerm,p)||!(_selCompP&&_selCompP.staff_compete);
    // The assign route skips a blocked, denied or unapproved account (counted,
    // never enrolled), so neither the kebab item nor the row's Add to event is
    // offered on one: such a row keeps its own next step (Approve, Unblock).
    const _enrollable=!!p.approved&&!p.blocked&&!p.denied_at;
    const canInvite=_compOpen&&!isInSelectedComp&&_staffOkHere&&!_actorCompetes&&_peerOk&&_enrollable&&adminCan('participants.enrol');
    // REMOVAL takes no `_staffOkHere`: the server accepts taking any row off an
    // event, and a legacy staff row on a non-compete event (written before this
    // release, or by a promotion after enrolment) is exactly the one an
    // organiser needs to remove — withholding it is v7.14.2 with the sides swapped.
    //
    // v8.12.6 — AND ON A FINISHED EVENT STILL TAKING LATE ENTRIES, ONLY A LATE
    // ENTRANT. The server removes exactly the members it marks `late_entrant`
    // (the same predicate on both sides), because everyone who was in the event
    // before it ended stays: taking them out would change results that are final.
    // `=== true`, so a payload without the key fails CLOSED — no Remove the
    // server would refuse. `_compNotEnded` stays the rule for every other event,
    // where an ended event's roster is frozen for everybody.
    const canUninvite=isInSelectedComp&&(!_actorCompetes||_isSelf)&&(_compNotEnded||(_focusLate&&_focusLateEntrant))&&adminCan('participants.enrol');
    // Remove from competition: warning normally; danger while people are PLAYING
    // in it — live, or (v8.12.6) a late entrant inside the late-entry window.
    const _selCatP=_selCompP?compDisplayCategory(_selCompP):null;
    const removeFromCompCls=(_selCatP==='live'||_selCatP==='late-entry')?'km-danger':'km-warning';
    // v8.12.6 — WITHHELD WITH THE REASON (v7.14.2): on a late-entry focus, a
    // member who is not a late entrant has no Remove, and says why — a menu that
    // offers Remove on some rows of one event and silently not on others reads as
    // a broken feature. Not where the competing note below already explains an
    // absent Remove.
    //
    // (review) — TWO reasons, and the note names the one that is true of THIS
    // row. The rule is "only late entrants who had not started playing before the
    // end", so a late entrant who HAD started (a footprint at or before the end,
    // which only a row that did not come through a door can carry, such as an
    // imported membership) is withheld too — and telling them "only people who
    // joined late can be removed" was false of somebody who did.
    const _lateKeepName=esc(S.adminSelectedCompetitionName||'this event');
    const lateKeepNoteKm=(isInSelectedComp&&_focusLate&&!_focusLateEntrant&&!(_actorCompetes&&!_isSelf))
      ?(_focusLatePlaying
        ?`<div class="kebab-note" role="presentation">${ICO.lock} Joined “${_lateKeepName}” as a late entrant but started playing before it ended — while late entries are open, only late entrants who had not started playing before the end can be removed</div>`
        :`<div class="kebab-note" role="presentation">${ICO.lock} In “${_lateKeepName}” since before it ended — while late entries are open, only late entrants who had not started playing before the end can be removed</div>`)
      :'';
    // v8.12.0 — WITHHELD WITH THE REASON (v7.14.2): when the actor competes in
    // the focused event the invite / remove / organiser items above and below
    // are gone from this row, and the note says why rather than leaving a
    // shorter menu that reads as a broken feature. Not on the actor's own row,
    // where Remove — the escape hatch — is still offered.
    // On an ENDED event the roster is frozen for everybody, but the organiser
    // grant/revoke items above are still withheld for a competitor alone, so the
    // note still has a job there — worded for what is actually withheld.
    // v8.12.0 — the rival note: the row's account doors are withheld above.
    // A fellow competitor in the FOCUSED event is a rival through that very
    // event, so the roster note and the rival note would say two halves of one
    // thing under each other; they fold into ONE sentence there. Two notes stay
    // only when the rival event is a DIFFERENT one from the focus — two facts.
    const _rivalIsFocused=!!(_rival&&_selCompP&&_rival.id===_selCompP.id);
    const _rosterNote=_actorCompetes&&!_isSelf;
    const rivalNoteKm=_rival
      ?`<div class="kebab-note" role="presentation">${ICO.lock} You are competing in “${esc(_rival.name)}” alongside ${_pn} — ${(_rosterNote&&_rivalIsFocused)
          ?`neither ${_compOpen?'its participants':'it'} nor their account can be changed from here`
          :'their account cannot be changed from here'}</div>`
      :'';
    const competingNoteKm=(_rosterNote&&!_rivalIsFocused)
      ?`<div class="kebab-note" role="presentation">${ICO.lock} You are competing in “${esc(S.adminSelectedCompetitionName||'this event')}” — ${_compOpen?'its participants cannot be changed from here':'it cannot be changed from here'}</div>`:'';
    const inviteKm=canInvite
      ?`<button data-action="participant-invite" data-user-id="${esc(p.id)}">${ICO.userPlus} Invite to ${esc(S.adminSelectedCompetitionName||'event')}</button>`:'';
    const uninviteKm=canUninvite
      ?`<button class="${removeFromCompCls}" data-action="participant-uninvite" data-user-id="${esc(p.id)}">${ICO.userMinus} Remove from ${esc(S.adminSelectedCompetitionName||'event')}</button>`:'';

    // Primary action: "History" by default, overridden only by a pending admin action intrinsic to the user.
    // Priority order MUST match both `pStatus()` + the server-side approval
    // gates (v6.10.19): blocked / locked / unverified / unapproved. Every
    // branch's condition is the full set of preconditions the action's
    // server handler enforces — clicking the primary button never produces
    // a 400 from a "this action isn't applicable" gate.
    //   Verify   — email not yet verified (user can't log in until verified)
    //   Unlock   — locked out from too many failed logins (dominates Approve —
    //              approval on a locked user is a no-op until unlock)
    //   Unblock  — explicitly blocked by admin
    //   Approve  — verified, not blocked, not locked, awaiting admin approval
    // Context-dependent actions (Invite/Remove from competition, Edit, Role changes, Delete, ...) live in the kebab menu.
    let primaryBtn='';
    if(_waitingOnly(p)){
      // Not in any of this organiser's events: nothing here is theirs to do (the note says who approves).
    }else if(!p.verified&&adminCan('participants.verify')&&!_rival){
      primaryBtn=`<button class="btn sm warning" data-action="participant-verify" data-user-id="${esc(p.id)}">${ICO.mailCheck} Verify</button>`;
    }else if(canUnlock&&isLocked){   // v8.12.0 — unlock is not a board input, so a rival keeps it
      primaryBtn=`<button class="btn sm warning" data-action="participant-unlock" data-user-id="${esc(p.id)}">${ICO.unlock} Unlock</button>`;
    }else if(_rival){
      // v8.12.0 — every other primary (reverse-denial, Unblock, Approve, Verify)
      // is an account door the server refuses on a rival, so the row's primary
      // is the read that is always open.
      primaryBtn=`<button class="btn sm secondary" data-action="participant-history" data-user-id="${esc(p.id)}">${ICO.clock} History</button>`;
    }else if(p.denied_at){
      // v6.14.0 — denied users skip the Unblock primary even though
      // blocked=1 by construction. Unblock alone would clear blocked
      // without clearing denied_at, leaving the row in a stale
      // half-recovered state that login would silently let through
      // (denied_at stays as audit but blocked=0 stops being a gate).
      // The right primary is Approve, which reverses the denial in
      // one transaction (clears denied_at + blocked + sets approved=1).
      primaryBtn=adminCan('participants.approve')
        ?`<button class="btn sm warning" data-action="participant-approve" data-user-id="${esc(p.id)}">${ICO.userCheck} Approve (reverse denial)</button>`
        :`<button class="btn sm secondary" data-action="participant-history" data-user-id="${esc(p.id)}">${ICO.clock} History</button>`;
    }else if(canBlock&&p.blocked){
      primaryBtn=`<button class="btn sm warning" data-action="participant-block" data-user-id="${esc(p.id)}" data-blocked="true">${ICO.shieldOff} Unblock</button>`;
    }else if(p.verified&&!p.approved&&!p.blocked&&!isLocked&&adminCan('participants.approve')){
      primaryBtn=`<button class="btn sm warning" data-action="participant-approve" data-user-id="${esc(p.id)}">${ICO.userCheck} Approve</button>`;
    }else{
      primaryBtn=`<button class="btn sm secondary" data-action="participant-history" data-user-id="${esc(p.id)}">${ICO.clock} History</button>`;
    }
    // Dim content cells but keep action cells (checkbox, buttons) fully visible
    // v7.23.1 (audit Wave 3) — a class, not opacity: these cells carry the
    // participant's name, nickname and email, which the admin still has to read.
    const cd=dimRow?'row-deemphasised':'';
    // Searching everyone from inside an event: a row that is not a member gets
    // ONE action, Add to event (the same `participant-invite` door as the
    // kebab's item, under the same `canInvite` predicate).
    const _wsAddBtn=(S.adminSelectedCompetitionId&&S.pWsShowEveryone&&canInvite)
      ?`<button class="btn sm" data-action="participant-invite" data-user-id="${esc(p.id)}">${ICO.userPlus} Add to event</button>`:'';
    return `<tr>
      <td class="cb-cell">${((_pIsStaff&&_selCompP&&!_selCompP.staff_compete)||isInSelectedComp||(_actorCompetes&&!isInSelectedComp)||!_peerOk||!_canSelectP||_waitingOnly(p))?'':'<input type="checkbox" value="'+esc(p.id)+'" '+isChecked+' data-change-action="participant-select-toggle" aria-label="Select participant '+esc(p.name||p.email||'')+'"/>'}</td>
      <td data-pcol="participant" style="width:36px" class="${cd}">${avatarHtml(p.avatar,28)}</td>
      <td data-pcol="participant" class="cell-stack ${cd}"><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><span class="sub p-sub" data-email="${esc(p.email||'')}">${esc(p.nickname)}</span></td>
      <td data-pcol="email" class="cell-truncate ${cd}" title="${esc(p.email)}">${esc(p.email)}</td>
      <td data-pcol="company" class="cell-truncate ${cd}" title="${esc(p.company||'')}">${esc(p.company||'')}</td>
      <td data-pcol="title" class="cell-truncate ${cd}" title="${esc(p.title||'')}">${esc(p.title||'')}</td>
      <td data-pcol="location" class="${cd}">${locationHtml}</td>
      <td data-pcol="source" class="${cd}">${sourceCombined}</td>
      <td data-pcol="status" class="${cd}">${statusHtml}</td>
      <td data-pcol="score" class="t-num ${cd}">${_pScoreCell(p)}</td>
      <td data-pcol="registered" class="cell-ts ${cd}">${fmtDt(p.created_at)}</td>
      <td data-pcol="approved" class="cell-ts ${cd}">${p.approved_at?fmtDt(p.approved_at):'—'}</td>
      <td data-pcol="approver" class="cell-truncate t-cap ${cd}" title="${esc(p.approved_by||'')}">${esc(p.approved_by||'—')}</td>
      <td data-pcol="invited" class="cell-ts ${cd}">${p.invited_at?fmtDt(p.invited_at):'—'}</td>
      <td data-pcol="inviter" class="cell-truncate t-cap ${cd}" title="${esc(p.invited_by||'')}">${esc(p.invited_by||'—')}</td>
      <td data-pcol="role" class="${cd}">${roleCellHtml(p)}</td>
      <td data-pcol="first_login" class="cell-ts ${cd}">${fmtDt(p.login_time)}</td>
      <td data-pcol="last_active" class="cell-ts ${cd}">${fmtDt(p.last_login_time)}</td>
      <td data-pcol="events" class="p-chips-cell ${cd}">${compBadgesHtml}</td>
      <td data-pcol="tags" class="p-chips-cell ${cd}">${tagsHtml}</td>
      <td data-pcol="groups" class="p-chips-cell ${cd}">${groupsHtml}</td>
      <td data-pcol="actions"><div class="action-cell task-actions" style="gap:4px"><button class="btn sm secondary" data-action="participant-view-profile" data-id="${esc(p.id)}" aria-label="View — open the profile card of ${esc(`${p.first_name||''} ${p.last_name||''}`.trim()||p.nickname||p.email||'this participant')}">View</button>${_wsAddBtn||primaryBtn}</div>
      <button class="kebab-btn kebab-always" title="More actions" aria-label="More actions" data-action="kebab-toggle">⋮</button>
      <div class="kebab-menu">
        <button data-action="participant-view-profile" data-id="${esc(p.id)}">${ICO.eye} View profile</button>
        ${_waitingOnly(p)?`<div class="kebab-note" role="presentation">${ICO.lock} Waiting for an administrator's approval: once approved, they join at their first sign-in</div>`:`
        ${peerNoteKm}
        ${rivalNoteKm}
        ${competingNoteKm}
        ${lateKeepNoteKm}
        ${inviteKm}
        ${uninviteKm}
        <button data-action="participant-edit-profile" data-user-id="${esc(p.id)}">${ICO.edit} ${profileLabel}</button>
        <button data-action="participant-history" data-user-id="${esc(p.id)}">${ICO.clock} History</button>
        ${impersonateKm}${nestedImpNoteKm}${customImpNoteKm}${codeKm}
        ${verifyKm}
        ${approveKm}
        ${codeNoteKm}
        ${denyKm}
        ${blockKm}
        ${canReset?`<button data-action="participant-email-code" data-user-id="${esc(p.id)}">${ICO.key} Email sign-in code</button>`:''}
        ${eventAdminKm}
        ${roleKm}
        ${(adminCan('participants.delete')&&!_rival&&!restrictedPeer)?`<button class="km-danger" data-action="participant-delete" data-user-id="${esc(p.id)}">${ICO.trash} Delete</button>`:''}`}
      </div></td>
    </tr>`;
  }).join(''));

  // Render pagination controls
  const pagDiv=document.getElementById('participants-pagination');
  // v7.20.11 — the status chips narrow the list too; see the sibling note in
  // challenges-admin.js.
  // Counts are scoped to what is SHOWN: inside an event (not searching
  // everyone) the total is the event's people, never the platform's.
  const _countBase=(S.adminSelectedCompetitionId&&!S.pWsShowEveryone)
    ?(S.adminParticipantsData||[]).filter(inOpenEventRoster).length
    :(S.adminParticipantsData||[]).length;
  setListCount('participants-search',{matched:totalFiltered,total:_countBase,filtered:!!q||!!(S.pStatusFilter&&S.pStatusFilter.size)||hasColumnFilters('participants'),queried:!!q||hasColumnFilters('participants')});
  _syncParticipantColumns();
  { const cb=document.getElementById('p-ws-everyone'); if(cb)cb.checked=!!S.pWsShowEveryone; }
  _syncWsEveryoneLabel();
  if(S.adminSelectedCompetitionId)_ensureScores(S.adminSelectedCompetitionId);
  setSafeHtml(pagDiv, paginationHtml('participants', {page:S.pPage,totalPages,totalLabel:`${totalFiltered} total`,pageSize:S.pPageSize}));

  updateSelectionBar();
}

// v8.8.11 — NO `searchTerm` PARAMETER. It existed to carry the term into the
// picker's server-side LIKE across a reload; with the picker branch gone this
// function makes no filtered request, so a parameter it accepted and ignored
// would be a control that appears to work. Callers that used to pass it drop
// it: the search input is never cleared by a reload, and the `renderParticipants()`
// at the end of this function re-applies it from the DOM.
export async function loadAdminParticipants(opts){
  // v8.12.6 (review) — `keepView`: a re-fetch the admin did not ask for (the
  // focused event changed state under an open table) keeps their page and their
  // ticked rows; every other caller is a navigation or an action and resets both.
  const _keepView=!!(opts&&opts.keepView===true);
  // ADMIN ACCOUNTS ARE NOT PEOPLE (owner's decision, 27 Nov 2026: "Show admin
  // accounts" is gone; admins live on Roles & permissions). Only a cross-page
  // link to one (admin-crossnav.js `widenPeopleToAdmins`: a competing admin on a
  // board) lists them, until People is next entered; the list says so.
  if(opts&&opts.tabEntry){ S.pIncludeAdmins=!!S._pWidenOnce; S._pWidenOnce=false; }
  // RBAC — a role that may not read people sends no read (every refusal toasts
  // and counts towards the address's scanner block).
  if(!adminCan('participants.view'))return;
  showLoading();
  // ext-audit v7.15.13 — discard a response that a newer request has superseded
  // (scope switch / debounced search). Captured BEFORE the fetches so every
  // branch below is covered by the same token.
  const mySeq=++S._partFetchSeq;
  let allParticipants=[],pendingApproval=0;
  // v8.8.11 — ONE PATH, FOCUSED OR NOT, and the branch that is gone is the bug.
  //
  // Focusing an event used to swap this pane onto `/api/admin/participants/picker`,
  // whose contract is members-in-full plus non-members `ORDER BY u.created_at
  // LIMIT 500` — built for the ASSIGN DIALOG, where "type to narrow the
  // candidates" is the right shape. On a TAB with its own pager, its own count
  // and its own search over the fetched array, it is the wrong shape twice: the
  // list looked complete, and the 500 it kept were the OLDEST accounts on the
  // platform, so every newer participant was invisible.
  //
  // It did not merely fail to disclose that — it asserted the opposite. The
  // count line below reads the FETCHED array's length as its denominator, so at
  // the cap it rendered "500 of 500", while the server's real `total`,
  // `matchingNonMembers` and `truncated` all rode the wire and were discarded.
  //
  // THE MAIN LIST ALREADY CARRIES EVERYTHING THIS PANE NEEDS. The picker's only
  // extra fields were `in_competition`, `chosen_timeslot_id` and
  // `chosen_timeslot_name`; the last has no reader anywhere, and the other two
  // are derivable from `p.competitions`, which BOTH endpoints build from a
  // byte-identical query carrying `timeslot_id` (see `_focusedSlot` above).
  //
  // AND THE EVENT-ADMIN SCOPE IS UNCHANGED BY CONSTRUCTION, which is the half
  // worth stating: the main list narrows with `_userInScopeSql` — "enrolled in
  // at least one of MY events" — which is exactly the set the picker returned to
  // that tier (its members bucket plus its `_nmVis`-narrowed non-members). For a
  // global admin it is a strict superset, which is the fix. Nothing about
  // visibility moved to the client; the client derives DIMMING, not access.
  let page=1;
  while(true){
    // v6.10.54 — single-fetch where possible (was: multi-page walk with
    // limit=200 per page). Multi-page had a snapshot-consistency gap: writes
    // between page fetches could drop or duplicate rows, even after v6.10.51's
    // `, id` tiebreaker. The server caps at 5000 per request; past that this
    // walks, and v6.10.64 costs the residual — INSERT drift is structurally
    // impossible because ORDER BY created_at ASC appends at the end, DELETE
    // drift is a theoretical edge at >5000 scale, accepted as docs.
    //
    // v7.23.5 (Wave 5) — a failed request must not be reported as "no data".
    // MEASURED: a 500 rendered "No participants yet." — a confident, FALSE claim
    // about the data. `.catch(()=>({users:[]}))` produced exactly that, and it
    // only fires on a PARSE failure, so an error BODY sailed through as an empty
    // list.
    let raw=null;
    // RBAC — People is participants; an event workspace asks for every role so
    // the event's roster keeps the staff who compete in it.
    const _kind=(S.adminSelectedCompetitionId||S.pIncludeAdmins)?'&kind=all':'';
    { const note=document.getElementById('p-admins-note'); if(note)note.hidden=!!S.adminSelectedCompetitionId||!S.pIncludeAdmins;
      const roles=document.getElementById('p-admins-note-roles'); if(roles)roles.hidden=!adminPageOffered('admin-users-tab'); }
    try{ const _r=await fetch(`/api/admin/participants?limit=5000&page=${page}${_kind}`); if(_r.ok) raw=await _r.json(); }catch(e){ console.warn('Could not load participants page',page,e); }
    if(raw===null){
      // v8.12.6 (review) — BOTH exits release the loading count this call took.
      // They did not, so a failed load left the spinner up for the rest of the
      // session; that mattered little while only a navigation or an action could
      // get here, and matters more now that `resyncParticipantsWithFocus` re-fetches
      // in the background when the focused event crosses its end.
      hideLoading();
      if(mySeq!==S._partFetchSeq)return;
      renderLoadFailure('admin-participants-body',{colspan:colspanFor('admin-participants-body'),
        noun:'participants',retryAction:'retry-load-admin-participants',
        resetModel:()=>{S.adminParticipantsData=[];}});
      showToast('Could not load participants.','error');
      return;
    }
    const batch=raw.participants||[];
    allParticipants=allParticipants.concat(batch);
    // The badge counts people waiting for approval, which is a platform-wide
    // job rather than an event one — suppressed while an event is focused, as
    // it has been since the pane first gained a scope.
    pendingApproval=S.adminSelectedCompetitionId?0:(raw.pendingApproval||0);
    if(mySeq!==S._partFetchSeq)break;               // superseded mid-walk — stop fetching
    if(allParticipants.length>=raw.total||batch.length===0)break;
    page++;
  }
  if(mySeq!==S._partFetchSeq){hideLoading();return;}   // a newer load already landed
  S.adminParticipantsData=allParticipants;
  // The event workspace counts the open event's pending approvals from this model.
  document.dispatchEvent(new CustomEvent('admin:model-loaded',{detail:'participants'}));
  hideLoading();
  if(!_keepView){
    S.selectedParticipants.clear();
    S.pPage=1;
  }
  document.getElementById('import-participants-btn').style.display=adminCan('data.import')?'':'none';
  // RBAC — the header's doors, each by what its route and its dialog's reads
  // need: Invite (`participants.enrol`; a role scoped to its events also reads
  // them, `events.view`), At the desk (`participants.enrol`), the file exports
  // (`export.data`); the Export menu goes when it holds nothing, and a hidden
  // door's "?" tip goes with it.
  // Inside an event's workspace neither people door is here: the workspace
  // header's Invite holds both (an email invitation, a sign-up at the desk;
  // owner's decision, 27 Nov 2026). The People page keeps its toolbar.
  { const inWs=!!S.adminSelectedCompetitionId;
    const enrol=adminCan('participants.enrol')&&!inWs, exp=adminCan('export.data');
    const show=(el,on)=>{ if(el)el.style.display=on?'':'none'; };
    show(document.getElementById('invite-participants-btn'),enrol&&(!S.isEventAdmin||adminCan('events.view')));
    show(document.getElementById('desk-invite-btn'),enrol);
    // The markup's own tooltip is kept aside the first time, and comes back
    // whenever the reason no longer applies.
    { const db=document.getElementById('desk-invite-btn'); if(db){ if(db.dataset.deskTitle===undefined)db.dataset.deskTitle=db.getAttribute('title')||''; db.title=deskApprovalWithheld()?DESK_APPROVAL_REASON:db.dataset.deskTitle; } }
    const deskTip=document.querySelector('#admin-participants-tab [data-help="people.desk"]'); if(deskTip)deskTip.hidden=!enrol;
    show(document.getElementById('export-csv-btn'),exp);
    show(document.getElementById('export-json-btn'),exp);
    show(document.querySelector('#admin-participants-tab .p-export-wrap'),exp||adminCan('data.import')); }
  // The JSON names the open event whatever the list shows: the server writes
  // that event's people (?competitionId). The CSV's label follows the table
  // (renderParticipants keeps it in step with "Search everyone").
  const jsonBtn=document.getElementById('export-json-btn');if(jsonBtn)jsonBtn.textContent='Export JSON'+(S.adminSelectedCompetitionId?` (${S.adminSelectedCompetitionName||'this event'})`:'');
  // Update pending approval badge
  const pendingCount=pendingApproval;
  const badge=document.getElementById('pending-badge');
  if(badge){badge.textContent=pendingCount;badge.style.display=pendingCount>0?'inline':'none';}
  renderParticipants();
}

/**
 * v8.12.6 (review) — KEEP THE PARTICIPANTS ROWS IN STEP WITH THE FOCUSED EVENT'S
 * STATE. Called by `loadAdminCompetitions` after every competitions load — the
 * 15 s poll, the scope banner's reload on a status change, and every action that
 * reloads the list — so no single caller has to remember it.
 *
 * TWO questions, because two things go stale and only one of them can be fixed by
 * rendering again:
 *   * the DATA — each member's entry for the focused event carries the server's
 *     `status`, `late_entry_window_open`, `late_entrant` and `late_entry_playing`
 *     AS OF THE FETCH, and the last three exist only while the window is open.
 *     Rows fetched while the event was live carry none of them, so re-rendering
 *     them after the end would withhold Remove from a genuine late entrant and
 *     tell them they were "in it since before it ended". When the entries'
 *     category disagrees with the list's, the data is RE-FETCHED. (The server
 *     caches this page for 5 s, so a fetch landing inside that window can still
 *     be stale; the next competitions load asks again, which is what makes this
 *     self-correcting rather than a one-shot.)
 *   * the RENDER — for rows whose data is current, a category change since the
 *     table was last rendered (`S._pRenderedFocus`) re-renders them.
 */
export function resyncParticipantsWithFocus(){
  const id=S.adminSelectedCompetitionId;
  if(!id||!(S.adminParticipantsData||[]).length)return;
  const f=(S.adminCompetitionsData||[]).find(c=>c.id===id);
  if(!f)return;
  const cat=compDisplayCategory(f);
  let dataCat=null;
  for(const p of S.adminParticipantsData){
    const e=(p.competitions||[]).find(c=>c.id===id);
    if(e){dataCat=compDisplayCategory(e);break;}
  }
  if(dataCat&&dataCat!==cat){loadAdminParticipants({keepView:true});return;}
  if(S._pRenderedFocus&&S._pRenderedFocus.id===id&&S._pRenderedFocus.cat!==cat)renderParticipants();
}

export function closeKebab(){
  const m=document.getElementById('kebab-portal');
  if(m){
    // v6.20.x — reset the trigger's aria-expanded so SR state matches.
    if(m._srcBtn){m._srcBtn.setAttribute('aria-expanded','false');m._srcBtn=null;}
    if(m._escHandler){document.removeEventListener('keydown',m._escHandler,true);m._escHandler=null;}
    // Own the click-outside listener's lifecycle here (mirrors _escHandler) so it
    // can't outlive its menu — otherwise opening an adjacent kebab leaves the old
    // listener attached, and it fires on the SAME click that opened the new menu
    // and slams it shut (the user then has to click twice). v8.12.6 — that
    // includes a listener whose setTimeout has NOT armed it yet: the remove below
    // is then a no-op, and it is the null written here that stops toggleKebab's
    // timer arming it at all (its identity check).
    if(m._docCloseHandler){document.removeEventListener('click',m._docCloseHandler);m._docCloseHandler=null;}
    setSafeHtml(m, '');m.classList.remove('open');m.style.display='none';
  }
}

export function toggleKebab(e){
  e.stopPropagation();
  const btn=e.currentTarget,srcMenu=btn.nextElementSibling;
  let portal=document.getElementById('kebab-portal');
  const wasOpen=portal&&portal.classList.contains('open')&&portal._srcBtn===btn;
  closeKebab();
  if(!wasOpen){
    if(!portal){portal=document.createElement('div');portal.id='kebab-portal';portal.className='kebab-menu';document.body.appendChild(portal);}
    setSafeHtml(portal, srcMenu.innerHTML);
    portal._srcBtn=btn;
    // v6.20.x — menu semantics + keyboard. Mark the portal as a menu and its
    // entries as menuitems, reflect open state on the trigger, move focus into
    // the menu, and close on Escape (returning focus to the trigger).
    portal.setAttribute('role','menu');
    // v8.11.7 — NAME THE MENU. It had none, so it was announced as an unnamed
    // menu of eight items with no indication of which row it belongs to — and
    // rows in this table are near-identical by design. The trigger's own
    // aria-label already names the participant, so the menu borrows it.
    const _trigLabel=btn.getAttribute('aria-label')||'';
    if(_trigLabel)portal.setAttribute('aria-label',_trigLabel);
    else portal.setAttribute('aria-label','Row actions');
    btn.setAttribute('aria-haspopup','true');
    btn.setAttribute('aria-expanded','true');
    portal.querySelectorAll('button, a, [data-action]').forEach(it=>{
      if(!it.getAttribute('role'))it.setAttribute('role','menuitem');
    });
    const r=btn.getBoundingClientRect();
    // Render the menu off-screen FIRST so its real width/height can be measured.
    // The portal is display:none until `.open`, so before this the old code read
    // scrollHeight=0/offsetWidth=0 and fell back to hard-coded 160×200 — which
    // under-measured the ≥180px-wide, ~280px-tall menu and let it hang off the
    // viewport's bottom/right edge on short mobile screens (the kebab actions
    // then became untappable). Measuring the real box keeps the clamp accurate.
    portal.style.top='0';portal.style.left='-9999px';
    portal.style.display='block';
    portal.classList.add('open');
    const menuW=portal.offsetWidth||180,menuH=portal.offsetHeight||200;
    let top=r.bottom+4,left=Math.max(4,r.right-menuW);
    // Prevent overflow off the bottom/right of the viewport: flip the menu above
    // the trigger if it would spill past the bottom, then clamp to the top/right
    // edges. With the real measured menuH/menuW + the CSS max-height cap on
    // .kebab-menu, the result is always fully within the viewport.
    if(top+menuH>window.innerHeight)top=Math.max(4,r.top-menuH-4);
    if(left+menuW>window.innerWidth)left=Math.max(4,window.innerWidth-menuW-4);
    portal.style.top=top+'px';
    portal.style.left=left+'px';
    // Move focus to the first menuitem so keyboard users land inside the menu.
    setTimeout(()=>{const first=portal.querySelector('[role="menuitem"], button, a');if(first)first.focus();},0);
    // Escape closes the menu + returns focus to the trigger (capture phase so it
    // beats other handlers; only acts while this menu is open).
    portal._escHandler=ev=>{
      if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();const b=portal._srcBtn;closeKebab();if(b)b.focus();return;}
      if(!portal.classList.contains('open'))return;
      const items=Array.from(portal.querySelectorAll('[role="menuitem"]')).filter(el=>!el.disabled);
      if(!items.length)return;
      const at=items.indexOf(document.activeElement);
      const go=i=>{ev.preventDefault();ev.stopPropagation();items[(i+items.length)%items.length].focus();};
      if(ev.key==='ArrowDown')return go(at+1);
      if(ev.key==='ArrowUp')return go(at-1);
      if(ev.key==='Home')return go(0);
      if(ev.key==='End')return go(items.length-1);
      // TAB IS CONTAINED. The portal is the LAST child of <body>, so tabbing off
      // the final item wrapped to the top of the document and left a destructive
      // menu open and overlaying the table with focus nowhere near it.
      if(ev.key==='Tab'){
        if(ev.shiftKey&&(at<=0))return go(items.length-1);
        if(!ev.shiftKey&&at===items.length-1)return go(0);
      }
    };
    document.addEventListener('keydown',portal._escHandler,true);
    const close=ev=>{if(!portal.contains(ev.target)&&ev.target!==btn){closeKebab();}};
    portal._docCloseHandler=close; // closeKebab() removes it — see lifecycle note there
    // v8.12.6 — ARM IT ONLY IF THIS MENU IS STILL THE OPEN ONE. The listener is
    // added a task later (so the click that opened the menu cannot close it), and
    // closeKebab can run BEFORE that task: input is scheduled ahead of timers, so
    // an Escape — or any close — landing first found nothing to remove, and the
    // timer then added a listener nothing would ever remove. That listener holds
    // THIS trigger, so once the table re-rendered every later menu's own click
    // failed `ev.target!==btn` and closed it the moment it opened — and each such
    // open leaked one more. Measured: nine stale listeners, every row menu on the
    // page dead, in a suite run under load. closeKebab nulls _docCloseHandler and
    // a newer open replaces it, so this identity test is the whole fix.
    setTimeout(()=>{if(portal._docCloseHandler===close)document.addEventListener('click',close);},0);
  }
}

export async function addTag(userId){
  const userTags=(S.adminParticipantsData.find(u=>u.id===userId)?.tags)||[];
  // v8.3.17 — on a 500 the error body PARSES (`{error:…}` is valid JSON), so
  // `allTags` was an object and `.filter` threw "is not a function": the dialog
  // never opened and nothing said why. Failure is now distinguishable from
  // "there are no tags yet", which is a legitimate state.
  const allTags=await fetchJsonList('/api/admin/tags');
  if(allTags===null){showToast('Could not load the tag list. Try again.','error');return;}
  const available=allTags.filter(t=>!userTags.includes(t));
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay, `<div class="card" style="max-width:min(400px, calc(100vw - 32px));width:100%;border-top-color:var(--accent)">
    <h3 style="margin-bottom:16px">Add Tag</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="tag-input" placeholder="Enter new tag..." style="flex:1" data-enter-click-id="tag-save-btn"/>
      <button class="btn sm" id="tag-save-btn">Add</button>
    </div>
    ${available.length?`<div style="margin-bottom:8px;font-size:var(--fs-12);color:var(--muted)">Or choose existing:</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${available.map(t=>`<span class="tag" style="cursor:pointer" role="button" tabindex="0" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>`:''}
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn sm secondary" id="tag-cancel-btn">Cancel</button></div>
  </div>`);
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  document.getElementById('tag-cancel-btn').onclick=close;
  overlayDismiss(overlay,close);
  wireTagDialog({overlay,inputId:'tag-input',saveBtnId:'tag-save-btn',url:`/api/admin/participants/${userId}/tags`,close,
    onSaved:(tags)=>{const p=S.adminParticipantsData.find(u=>u.id===userId);if(p)p.tags=tags;renderParticipants();}});
}

export async function removeTag(userId,tag){
  const r=await fetch(`/api/admin/participants/${userId}/tags/${encodeURIComponent(tag)}`,{method:'DELETE',headers:csrfHeaders()});
  // The remove path has a refusal the ADD path does not: "Cannot remove staff
  // tag from admin/superadmin users. Demote to participant first." Silently
  // doing nothing there is the worst case of the four — the admin is being told
  // a real, actionable rule and hears nothing.
  if(r.ok){const d=await r.json();const p=S.adminParticipantsData.find(u=>u.id===userId);if(p)p.tags=d.tags;renderParticipants();}
  else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to remove tag.','error');}
}

export async function addGroup(userId){
  const userGroupIds=new Set(((S.adminParticipantsData.find(u=>u.id===userId)?.groups)||[]).map(g=>g.id));
  // v8.3.20 — REFUSE rather than open a dialog listing no groups. Unchecked
  // `r.ok` meant a 500's error object reached `.filter` and threw with nothing
  // on screen; a failed parse rendered "no groups available", which is a
  // confident wrong answer from a request that failed.
  const allGroups=await fetchJsonList('/api/admin/groups');
  if(!allGroups){showToast('Could not load groups. Check your connection and try again.','error');return;}
  const available=allGroups.filter(g=>!userGroupIds.has(g.id));
  // v8.12.0 — a group bound to an event the actor competes in is refused
  // server-side (`competitorGroupDenied`); listed disabled with the reason
  // rather than offered and refused.
  const _grpLocked=g=>!!g.competing;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay, `<div class="card" style="max-width:min(400px, calc(100vw - 32px));width:100%;border-top-color:var(--accent)">
    <h3 style="margin-bottom:16px">Add to Group</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="group-input" placeholder="Create new group..." style="flex:1" data-enter-click-id="group-save-btn"/>
      <button class="btn sm" id="group-save-btn">Add</button>
    </div>
    ${available.length?`<div style="margin-bottom:8px;font-size:var(--fs-12);color:var(--muted)">Or choose existing:</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${available.map(g=>_grpLocked(g)
      ?`<span class="group-tag tag-inert" aria-disabled="true" title="Bound to “${esc(g.competing.competition_name||'an event')}”, which you compete in — its membership cannot be changed from here">${esc(g.name)}</span>`
      :`<span class="group-tag" style="cursor:pointer" role="button" tabindex="0" data-group-id="${esc(g.id)}">${esc(g.name)}</span>`).join('')}</div>`:''}
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn sm secondary" id="group-cancel-btn">Cancel</button></div>
  </div>`);
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  document.getElementById('group-cancel-btn').onclick=close;
  overlayDismiss(overlay,close);
  async function save(body){
    const r=await fetch(`/api/admin/participants/${userId}/groups`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
    if(r.ok){const d=await r.json();const p=S.adminParticipantsData.find(u=>u.id===userId);if(p)p.groups=d.groups;renderParticipants();showToast('Added to group.','success');await loadAdminParticipants();close();return;}
    const d=await r.json().catch(()=>({}));
    close();
    // v7.11.1 — descriptive clash alert when this add would put the participant in ≥2
    // groups bound to the same competition (spec req 7 back-door guard).
    if(r.status===409&&d.clash){
      const rows=(d.clash.conflicts||[]).map(c=>{const where=(c.conflicts||[]).map(x=>`${x.groups.map(esc).join(' + ')} on <strong>${esc(x.competitionName)}</strong>`).join('; ');return `<li><strong>${esc(c.nickname)}</strong> — already in ${where}</li>`;}).join('');
      await showModal({title:'Group members clash',confirmText:'OK',cancelText:'',confirmClass:'',message:`This participant can't join <strong>${esc(d.clash.groupName)}</strong> — a participant can only be in one group per event:<ul style="margin:8px 0;padding-left:20px">${rows}</ul>Remove them from the other group, or unbind a group from the event, first.`});
      return;
    }
    showToast(d.error||'Failed to add to group.','error');
  }
  document.getElementById('group-save-btn').onclick=()=>{const v=document.getElementById('group-input').value.trim();if(v)save({newName:v});};
  overlay.querySelectorAll('[data-group-id]').forEach(el=>{el.onclick=()=>save({groupId:el.dataset.groupId});el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();save({groupId:el.dataset.groupId});}};});
  document.getElementById('group-input').focus();
}

export async function removeGroup(userId,groupId){
  // v8.11.4 — THIS IS A CASCADE, NOT A LABEL EDIT, AND IT USED TO BE SILENT BOTH
  // WAYS. Dropping a group membership runs `reconcileCompetitionMembership` over
  // every competition that group is bound to, so for a GROUP-ORIGIN-ONLY member
  // (`direct_assigned=0` — the ordinary shape when an organiser binds a group) it
  // writes an absence row, evicts their session and EMAILS them that their access
  // was removed. A participant also assigned directly is sticky and keeps their
  // enrolment (`lib/group-sync.js`: "direct members are sticky"), which is why the
  // copy says access "may" end rather than asserting it — the client cannot see
  // `direct_assigned`, and a confirm that overstates trains admins to click past it.
  //
  // It fires from a 24x24 `×` in a dense chip list on a table that re-renders every
  // 15 seconds, and every other destructive action on this row has confirmed and
  // named its target since v7.7.33 (AL12). This one neither confirmed NOR reported.
  const p0=S.adminParticipantsData.find(u=>u.id===userId);
  const gName=(p0?.groups||[]).find(g=>g.id===groupId)?.name||'this group';
  const ok=await showModal({
    title:'Remove from group?',
    message:`Remove ${_pLabel(userId)} from <strong>${esc(gName)}</strong>?`
      +`<div style="margin-top:8px">If this group is bound to any event, they may lose access to it and be emailed to say so.</div>`,
    confirmText:'Remove',confirmClass:'danger',
  });
  if(!ok)return;
  const r=await fetch(`/api/admin/participants/${userId}/groups/${encodeURIComponent(groupId)}`,{method:'DELETE',headers:csrfHeaders()});
  // The refusal is SPOKEN. Three distinct 403s reach here — the peer-privilege
  // rule, the event-admin scope and group-write-denied — and swallowing them is
  // the failure `removeTag`'s own comment fifty lines above describes: "the admin
  // is being told a real, actionable rule and hears nothing."
  if(!r.ok){const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to remove from group.','error');return;}
  const d=await r.json();
  const p=S.adminParticipantsData.find(u=>u.id===userId);if(p)p.groups=d.groups;
  renderParticipants();
  showToast(`Removed from ${gName}.`,'success');
  await loadAdminParticipants();
}

// audit v7.7.33 (AL12) — name the target participant in destructive/action
// confirms (nickname + email), matching denyUser + the entity-delete confirms.
// These fire from a dense per-row kebab menu where a wrong-row misclick is easy.
/** The row an account door acts on: People's list, else the admin accounts
 *  Roles & permissions read for its own account doors (S.adminUserRows). */
export function personRow(id){
  return (S.adminParticipantsData||[]).find(u=>u.id===id)||(S.adminUserRows||[]).find(u=>u.id===id)||null;
}
/** After an account door changed an account: People reloads, and so does Roles
 *  & permissions while it is on screen (users-admin.js listens). */
function _accountChanged(){
  loadAdminParticipants();
  try{document.dispatchEvent(new CustomEvent('admin:account-changed'));}catch(_){/* no CustomEvent: the list reloads on its next open */}
}
function _pLabel(id){
  const p=personRow(id);
  if(!p)return 'this user';
  const nm=p.nickname||[p.first_name,p.last_name].filter(Boolean).join(' ')||p.email||'this user';
  return `<strong>${esc(nm)}</strong>${p.email?` (${esc(p.email)})`:''}`;
}

export async function verifyUser(id){
  const ok=await showModal({
    title:'Verify User',
    message:`Marks ${_pLabel(id)} as verified. This is a recovery action for people who cannot receive the verification email.<br><br>To sign in someone who has never signed in, without email, use <strong>Show sign-in code</strong> from the same menu once the account is approved, and give them the one-time code it shows.`,
    confirmText:'Verify',confirmClass:'warning',
  });
  if(!ok)return;
  const r=await fetch(`/api/admin/participants/${id}/verify`,{method:'POST',headers:csrfHeaders()});
  if(!r.ok){const d=await r.json().catch(()=>({}));showToast(d.error||'Verify failed.','error');return;}
  loadAdminParticipants();showToast('User verified!','success');
}

// The row's link to Roles & permissions, where a role is changed (the page
// opens searched to this person's address).
export function openRolesFor(email){
  const item=document.querySelector('.admin-nav-item[data-tab-id="admin-users-tab"]');
  if(!item){showToast('Your role cannot open Roles & permissions.','info');return;}
  showUserInRoles(email);
  item.click();
}

// v8.7.0 — GRANT / REVOKE the event-admin role for ONE event.
//
// Two functions rather than one with a flag, because they are not symmetric and
// the asymmetry is what an operator must be told BEFORE clicking:
//   - granting may also change the account's ROLE (participant → event admin),
//     which signs them out everywhere;
//   - revoking never changes the role, so removing somebody's last event leaves
//     them an event admin with nothing in scope. Saying so here is what stops
//     "I removed their event, why are they still an event admin?".
//
// Both re-render the list afterwards: the Role cell and this very kebab item are
// computed from `event_admin_for`, so a stale row would offer Make again on an
// account that now has it.
export async function grantEventAdmin(userId,compId,compName,nickname){
  const ok=await showModal({
    title:'Make event admin',
    message:`<strong>${esc(nickname||_pLabel(userId))}</strong> will be able to organise `
      +`<strong>${esc(compName)}</strong> — its questions, its participants, its rankings — `
      +`with the same powers you have on that event.<br><br>`
      +`They will see nothing outside the events they are given. They cannot create a blank event `
      +`(only from a template, or by cloning one of their own), change roles, or reach Logs and Settings.<br><br>`
      +`If they are currently a participant this also changes their role and signs them out everywhere.`,
    confirmText:'Make event admin',confirmClass:'warning'});
  if(!ok)return;
  const r=await fetch(`/api/admin/competitions/${compId}/admins`,
    {method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({userId})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){showToast(d.error||'Could not make them an event admin.','error');return;}
  showToast(d.granted===false
    ?`They already organise "${compName}".`
    :`Now an event admin of "${compName}".`,'success');
  loadAdminParticipants();
}

export async function revokeEventAdmin(userId,compId,compName,nickname){
  const ok=await showModal({
    title:'Remove as event admin',
    message:`<strong>${esc(nickname||_pLabel(userId))}</strong> will no longer organise `
      +`<strong>${esc(compName)}</strong>.<br><br>`
      +`Their role stays <strong>Event admin</strong> — if this was their only event they will `
      +`simply see nothing. To remove the role itself, a superadmin sets it back to Participant.`,
    confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/competitions/${compId}/admins/${userId}`,
    {method:'DELETE',headers:csrfHeaders()});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){showToast(d.error||'Could not remove them.','error');return;}
  showToast(d.remaining_events===0
    ?`Removed. They now organise no events.`
    :`Removed from "${compName}".`,'success');
  loadAdminParticipants();
}

export async function approveUser(id){
  const ok=await showModal({title:'Approve User',message:`This will approve ${_pLabel(id)} and send them an approval notification email. CxOne account will be provisioned when assigned to an event.`,confirmText:'Approve',confirmClass:'warning'});
  if(!ok)return;
  const res=await fetchWithLoading(`/api/admin/participants/${id}/approve`,{method:'POST',headers:csrfHeaders()});
  if(!res)return;
  // Approval itself always succeeds server-side; the email is best-effort.
  // Surface the delivery truth so the operator knows whether to tell the user
  // about it another way (vs. silently claim "User approved!" when SMTP failed).
  if(res.r.ok){
    if(res.d.emailDelivered===false)showToast('User approved, but the notification email could NOT be delivered. Check SMTP.','error');
    else if(res.d.emailDeferred)showToast('User approved. The notification email is still being sent.','warning');
    else showToast('User approved!','success');
  }else showToast(res.d.error||'Approval failed.');
  loadAdminParticipants();
}

export async function denyUser(id){
  const p=S.adminParticipantsData.find(x=>x.id===id);
  const nick=p?(p.nickname||p.email||id):id;
  const message =
    `<p>Deny <strong>${esc(nick)}</strong>'s account application?</p>` +
    `<p>They will receive an email explaining the decision and will no longer be able to log in. ` +
    `If you change your mind later, click <em>Approve</em> on the row — that reverses the denial in one step.</p>` +
    `<label for="deny-reason" style="display:block;margin-top:8px;font-weight:var(--fw-semibold);font-size:var(--fs-14)">Reason (optional, max 500 chars)</label>` +
    `<textarea id="deny-reason" maxlength="500" rows="3" style="width:100%;margin-top:4px" placeholder="Shown to the user in the denial email. Leave blank for a generic message."></textarea>`;
  const ok=await showModal({title:'Deny Approval',message,confirmText:'Deny',confirmClass:'danger'});
  if(!ok)return;
  // Read the reason out of the rendered modal BEFORE the overlay closes.
  // showModal closes the overlay synchronously on resolve, so the
  // textarea still lives in the DOM at the point we read it (the
  // resolve callback fires before the next tick where the textarea
  // would be removed). The selector is scoped to the live modal.
  const ta=document.getElementById('deny-reason');
  const reason=(ta&&ta.value||'').trim();
  const res=await fetchWithLoading(
    `/api/admin/participants/${id}/deny`,
    {method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({reason})}
  );
  if(!res)return;
  if(res.r.ok){
    if(res.d.already)showToast('User was already denied.','info');
    else if(res.d.emailDelivered===false)showToast('User denied, but the notification email could NOT be delivered. Check SMTP.','error');
    else if(res.d.emailDeferred)showToast('User denied. The notification email is still being sent.','warning');
    else showToast('User denied. Email queued.','success');
  }else{
    showToast(res.d.error||'Denial failed.');
  }
  loadAdminParticipants();
}

export async function bulkApproveUsers(){
  const ids=[...S.selectedParticipants];
  if(!ids.length){showToast('No participants selected.');return;}
  // v6.10.22: align with server-side /bulk-approve gate. Previously the
  // filter was `verified && !approved && !blocked`, which passed locked
  // users through to a 400 "skipped" on the server. `pStatus(p)==='pending'`
  // folds in the locked check (pStatus returns 'locked' with higher
  // priority) so the selection count, the confirm-dialog number, and
  // the server's `approved` response all agree.
  const pending=S.adminParticipantsData.filter(p=>ids.includes(p.id)&&pStatus(p)==='pending');
  if(!pending.length){showToast('No pending users in selection.');return;}
  const ok=await showModal({title:`Approve ${pending.length} User(s)`,message:`This will approve ${pending.length} user(s) and send notification emails. CxOne accounts will be provisioned when assigned to events.`,confirmText:'Approve All',confirmClass:'warning'});
  if(!ok)return;
  const res=await fetchWithLoading('/api/admin/participants/bulk-approve',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({userIds:pending.map(p=>p.id)})});
  if(!res)return;
  if(res.r.ok){
    const failures=res.d.emailFailures||0;
    const skipped=res.d.skipped||0;
    const parts=[`Approved ${res.d.approved} user(s).`];
    if(skipped>0)parts.push(`${skipped} skipped (unverified or blocked).`);
    // Each skip the route counts is spoken, with its own reason: a number the
    // organiser never sees would read as "approved N" with no word on the rest.
    const notYours=(Number(res.d.skippedPrivileged)||0)+(Number(res.d.skippedOutOfScope)||0)+(Number(res.d.skippedRival)||0);
    if(res.d.skippedPrivileged)parts.push(`${res.d.skippedPrivileged} skipped — an organiser's or an administrator's account, which is not yours to approve.`);
    if(res.d.skippedOutOfScope)parts.push(`${res.d.skippedOutOfScope} skipped — not in any of your events.`);
    if(res.d.skippedRival)parts.push(`${res.d.skippedRival} skipped — you compete against them in an event.`);
    if(failures>0)parts.push(`${failures} notification email(s) failed — check SMTP.`);
    // ext-audit v7.15.15 — `emailsDeferred` means some sends were still running
    // when the server replied, so `failures` is a FLOOR, not a total. Presenting
    // it as final told the admin "0 failed" for a batch still in flight.
    if(res.d.emailsDeferred)parts.push('Some notification emails are still sending — the count above is not final.');
    const type=(failures>0||skipped>0||notYours>0)?'error':(res.d.emailsDeferred?'info':'success');
    showToast(parts.join(' '),type);
  }else showToast(res.d.error||'Bulk approve failed.');
  S.selectedParticipants.clear();loadAdminParticipants();
}

export async function blockUser(id,currentlyBlocked){
  // Elevate severity to danger when the target user is in any live competition
  const target=personRow(id);
  const userInLive=!!target&&(target.competitions||[]).some(c=>c.status==='live');
  const liveNote=userInLive?'<br><br><strong>Warning:</strong> this user is currently in a live event. Blocking them will immediately cut off their access.':'';
  const ok=await showModal(currentlyBlocked
    ?{title:'Unblock User',message:`${_pLabel(id)} will be able to log in again.`,confirmText:'Unblock',confirmClass:''}
    :{title:'Block User',message:`${_pLabel(id)} will be immediately logged out and unable to log in until unblocked.${liveNote}`,confirmText:'Block',confirmClass:userInLive?'danger':'warning'});
  if(!ok)return;
  const r=await fetch(`/api/admin/participants/${id}/block`,{method:'POST',headers:csrfHeaders()});
  if(r.ok){showToast(currentlyBlocked?'User unblocked.':'User blocked.');_accountChanged();}
  else showToast('Action failed.','error');
}

export async function unlockUser(id){
  const ok=await showModal({title:'Unlock User',message:`The account lockout for ${_pLabel(id)} will be removed and they will receive an email notification.`,confirmText:'Unlock',confirmClass:''});
  if(!ok)return;
  const res=await fetchWithLoading(`/api/admin/participants/${id}/unlock`,{method:'POST',headers:csrfHeaders()});
  if(!res)return;
  if(res.r.ok){
    // emailDelivered is only present when the target was actually locked.
    if(res.d.emailDelivered===false)showToast('User unlocked, but the notification email could NOT be delivered. Check SMTP.','error');
    else if(res.d.emailDeferred)showToast('User unlocked. The notification email is still being sent.','warning');
    else showToast('User unlocked.','success');
    _accountChanged();
  }else showToast('Action failed.','error');
}

// "Email sign-in code" — replaces Reset Password. Emails a code to the
// account's primary address on its behalf; the admin sees nothing of it (the
// desk reveal, "Show sign-in code", is the in-person alternative).
export async function emailSignInCodeForUser(id){
  const ok=await showModal({title:'Email a sign-in code',message:`A one-time sign-in code will be emailed to ${_pLabel(id)}. Nothing on the account changes; their current sessions stay signed in. To evict a compromised account immediately, use Block.`,confirmText:'Send Code',confirmClass:''});
  if(!ok)return;
  const res=await fetchWithLoading(`/api/admin/participants/${id}/login-code/email`,{method:'POST',headers:csrfHeaders()});
  if(!res)return;
  if(!res.r.ok){showToast(res.d.error||'Failed.','error');return;}
  if(res.d.sent===false){showToast(res.d.message||'No code was sent.','error');return;}
  // Still queued at the server's deadline: not a failure, not yet a delivery.
  if(res.d.deferred){showToast(res.d.message||'The sign-in code email is still being sent.','warning');return;}
  showToast(res.d.message||'Sign-in code sent.','success');
}

export function adminEditProfile(userId){
  const p=personRow(userId);
  if(!p)return;
  // Privileged targets: non-superadmins see a read-only view — no fields
  // editable. Normal users: non-superadmins can fill in blank fields only.
  // v8.7.4 — the SHARED predicate, so this can never again disagree with the
  // kebab that opened it about who counts as privileged.
  const targetPrivileged=targetPrivilegedFor(p.role,p);
  // RBAC — read-only too for a role that may not edit profiles (`participants.edit`).
  const viewOnly=(targetPrivileged&&!S.isSuperAdmin)||!adminCan('participants.edit');
  // v7.21.26 — ONE predicate, passed to the shared form. `default1` is the
  // avatar's UNSET state, so fill-a-blank-field applies to it exactly as it does
  // to every text field: a regular admin may set an avatar where the participant
  // never chose one, and only a superadmin may replace a chosen one.
  const _has={
    email:!!p.email, secondaryEmail:!!p.secondary_email, firstName:!!p.first_name,
    lastName:!!p.last_name, nickname:!!p.nickname, company:!!p.company, title:!!p.title,
    personalTitle:!!p.personal_title, phone:!!p.phone, country:!!p.country,
    timezone:!!p.timezone, city:!!p.city, jobFunction:!!p.job_function,
    linkedinUrl:!!p.linkedin_url, avatar:!!(p.avatar&&p.avatar!=='default1'),
  };
  // A RIVAL's addresses are an account door (the server refuses
  // competitor_cannot_edit for every tier): both slots lock, with the reason.
  const _rivalRow=!!(p.rival_in&&p.rival_in.id&&!(S.currentUser&&S.currentUser.id===p.id));
  const adpLocked=(f)=>{
    if(viewOnly)return true;
    // Emails are the documented exception: a regular admin may change BOTH slots
    // on a non-privileged target (support handles "please change my address").
    if(f==='email'||f==='secondaryEmail')return _rivalRow;
    return !S.isSuperAdmin && _has[f];
  };
  const overlay=document.createElement('div');
  overlay.id='admin-profile-overlay';
  // v8.3.37 — the diff baseline. The row this dialog was rendered from, not the
  // dialog-open DOM: see profileChangedFields.
  overlay._row=p;
  setSafeHtml(overlay, `<div class="card admin-profile-card" role="dialog" aria-modal="true" aria-labelledby="admin-profile-title">
    <h3 class="modal-title" id="admin-profile-title">Edit Profile — ${esc(p.first_name)} ${esc(p.last_name)}</h3>
    <p class="admin-profile-note">${S.isSuperAdmin?(_rivalRow?'All fields except the email addresses are editable.':'All fields are editable.'):viewOnly?'Read-only view.':'Only blank fields can be filled in.'}${(_rivalRow&&!viewOnly)?` You compete alongside this person in “${esc(p.rival_in.name||'an event')}”, so their email addresses cannot be changed from here.`:''}</p>
    ${profileFieldsHtml({
      prefix: 'adp',
      user: p,
      // The admin policy, in ONE place. A privileged target is wholly read-only
      // to a non-superadmin; on an ordinary target a regular admin may FILL a
      // blank field but never overwrite a populated one; a superadmin may change
      // anything.
      locked: adpLocked,
      tzChangeAction: 'update-adp-timezones',
      // v8.3.36 — SHOW A STAGED CORRECTION. An admin primary-email change is now
      // staged in `pending_email` and committed only when the participant opens
      // the confirmation link, so without this the dialog re-opens showing the
      // OLD address and an operator cannot tell a save that worked from one that
      // did not — they would re-type it, or conclude the control is broken.
      // Withhold the control WITH its reason, never silently (v7.14.2).
      emailsExtraHtml: (p.pending_email
          ? `<p class="profile-pending-email" role="status">Change to <strong>${esc(p.pending_email)}</strong> is waiting for the participant to open the confirmation link we emailed there. Their current address stays active until then. Saving a different address here replaces it.</p>`
          : '')
        + (viewOnly
          ? '<p class="admin-profile-warning">This is an admin or superadmin account. Contact a superadmin to make changes.</p>'
          : (S.isSuperAdmin ? '' : '<p class="admin-profile-hint">At least one email must be a company email (not a free provider like gmail/outlook/yahoo).</p>')),
    })}
    ${avatarPickerHtml({
      prefix: 'adp',
      current: p.avatar,
      disabled: adpLocked('avatar'),
      // A regular admin sees WHY it is read-only rather than a dead control —
      // v7.14.2: gate the affordance and the explanation together.
      note: adpLocked('avatar')
        ? (viewOnly
            ? 'Read-only — only a superadmin can change this account.'
            : 'This participant has already chosen an avatar. Only a superadmin can replace it.')
        : '',
    })}
    <div id="adp-error" class="admin-profile-error"></div>
    <div class="admin-profile-actions">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="admin-profile-overlay">Cancel</button>
      ${viewOnly?'':`<button class="btn" data-action="admin-profile-save" data-user-id="${esc(userId)}">Save</button>`}
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // Populate country/timezone
  const cs=document.getElementById('adp-country');
  Object.keys(COUNTRY_TZ).sort((a,b)=>COUNTRY_TZ[a].n.localeCompare(COUNTRY_TZ[b].n)).forEach(code=>{
    const o=document.createElement('option');o.value=code;o.textContent=COUNTRY_TZ[code].n;
    if(code===p.country)o.selected=true;
    cs.appendChild(o);
  });
  if(p.country&&COUNTRY_TZ[p.country]){
    const ts=document.getElementById('adp-tz');
    setSafeHtml(ts, '');
    COUNTRY_TZ[p.country].tz.forEach(([val,label])=>{
      const o=document.createElement('option');o.value=val;o.textContent=label;
      if(val===p.timezone)o.selected=true;
      ts.appendChild(o);
    });
  }
  // v7.21.11 — preserve a stored country/timezone the COUNTRY_TZ vocabulary does
  // not contain (import and invited-LinkedIn capture are not constrained to it).
  // On this surface the consequence was the sharper one: a SUPERADMIN opening a
  // profile saw the field blank and, because `fillRequired` keeps the current
  // value only when the incoming one is blank, a save submitted the listed
  // country they picked — silently replacing the participant's real one.
  _preserveUnlistedOption(cs, p.country, 'not in the list');
  _preserveUnlistedOption(document.getElementById('adp-tz'), p.timezone, 'not in the list');
  if(!p.country)autoDetectCountryTz('adp-country','adp-tz',updateAdpTimezones);
  // v6.9.2 — mirror the participant editor's dirty-check contract:
  // unchanged form Cancel closes immediately; any edit prompts "Discard
  // changes?" before destroying the data. Snapshot runs AFTER selects are
  // populated so an untouched form doesn't read as dirty.
  // v7.21.26 — the avatar picker, from the same module the participant editor
  // uses. Disabled state comes from the same predicate as every other field.
  const _adpAvatar=wireAvatarPicker({
    prefix:'adp', current:p.avatar, disabled:adpLocked('avatar'),
    errorEl:document.getElementById('adp-error'),
    onChange:v=>{ overlay._avatar=v; },
  });
  overlay._avatar=_adpAvatar.get();
  const _adpFieldIds=profileFieldIds('adp');
  // The avatar is part of the snapshot, or an avatar-only edit reads as a CLEAN
  // form and Cancel skips the discard prompt (see the participant editor).
  const snapshotAdminProfile=()=>_adpFieldIds.map(id=>document.getElementById(id)?.value??'').join('\u0001')+'\u0001'+(overlay._avatar??'');
  const initialAdpSnap=snapshotAdminProfile();
  overlay._isDirty=()=>snapshotAdminProfile()!==initialAdpSnap;
  const closeAdpWithGuard=async()=>{
    if(overlay._isDirty()){
      const ok=await showModal({title:'Discard changes?',message:'You have unsaved changes. Close the editor anyway?',confirmText:'Discard',confirmClass:'danger',cancelText:'Keep editing'});
      if(!ok)return;
    }
    overlay.remove();
  };
  overlayDismiss(overlay,closeAdpWithGuard);
  document.getElementById('adp-job-function')?.addEventListener('change',()=>{
    const jfs=document.getElementById('adp-job-function');
    const jfo=document.getElementById('adp-job-function-other');
    if(!jfs||!jfo)return;
    const show=jfs.value==='other';
    jfo.style.display=show?'block':'none';
    if(!show)jfo.value='';
  });
  // Fall back to the Cancel button when all inputs/selects are disabled (e.g.
  // a non-superadmin admin editing a privileged target) so focus always lands
  // inside the dialog on open.
  setTimeout(()=>{const f=overlay.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')||overlay.querySelector('button:not([disabled])');if(f)f.focus();},0);
  overlay.querySelector('[data-action="overlay-close"][data-overlay-id="admin-profile-overlay"]')?.addEventListener('click',(e)=>{
    e.preventDefault();e.stopImmediatePropagation();closeAdpWithGuard();
  },true);
}

export function updateAdpTimezones(){
  const cc=document.getElementById('adp-country').value;
  const ts=document.getElementById('adp-tz');
  if(!cc||!COUNTRY_TZ[cc]){
    setSafeHtml(ts, '<option value="">Select timezone...</option>');
    return;
  }
  setSafeHtml(ts, '');
  const c=COUNTRY_TZ[cc];
  c.tz.forEach(([val,label])=>{const o=document.createElement('option');o.value=val;o.textContent=label;if(val===c.d)o.selected=true;ts.appendChild(o);});
}

export async function saveAdminProfile(userId){
  const err=document.getElementById('adp-error');err.style.display='none';
  const _jfSel=document.getElementById('adp-job-function');
  const _jfOther=document.getElementById('adp-job-function-other');
  const _jfRaw=_jfSel?.value||'';
  const fields={
    firstName:document.getElementById('adp-first').value.trim(),
    lastName:document.getElementById('adp-last').value.trim(),
    nickname:document.getElementById('adp-nick').value.trim(),
    email:document.getElementById('adp-email').value.trim(),
    secondaryEmail:document.getElementById('adp-email2').value.trim(),
    company:document.getElementById('adp-company').value.trim(),
    title:document.getElementById('adp-title').value.trim(),
    personalTitle:document.getElementById('adp-personal-title')?.value||'',
    phone:document.getElementById('adp-phone')?.value.trim()||'',
    linkedinUrl:document.getElementById('adp-linkedin').value.trim(),
    country:document.getElementById('adp-country').value,
    timezone:document.getElementById('adp-tz').value,
    jobFunction:_jfRaw==='other'?(_jfOther?.value.trim()||''):_jfRaw,
    city:document.getElementById('adp-city')?.value.trim()||'',
    // v8.1.0 (PR 24) — the certificate name. Always sent, including as an empty
    // string: clearing them has to mean "use my profile name again", and omitting
    // the key would mean "leave unchanged" instead.
    certificateGivenName:document.getElementById('adp-cert-given')?.value.trim()||'',
    certificateFamilyName:document.getElementById('adp-cert-family')?.value.trim()||'',
    // v7.21.26 — a preset name, an existing /api/images/<id> ref, or a freshly
    // downscaled data: URI. The server applies the same fill-a-blank-field rule
    // it applies to every other field, so a value sent by a regular admin for an
    // already-chosen avatar is kept, not applied.
    avatar:document.getElementById('admin-profile-overlay')?._avatar||undefined,
  };
  // v6.9.2: client-side LinkedIn URL validation — same contract as the
  // participant editor so the field can't silently vanish on save.
  if(fields.linkedinUrl&&!isValidHttpUrl(fields.linkedinUrl)){
    err.textContent='LinkedIn URL must be a valid http:// or https:// URL.';err.style.display='block';
    document.getElementById('adp-linkedin').focus();return;
  }
  // v6.9.2: short-circuit when nothing changed — close silently so Save
  // on an untouched form doesn't fire a no-op API call + toast.
  //
  // v8.3.37 — the DIFF is the test now. Sending only what the admin actually
  // edited is what stops this dialog re-writing sixteen fields it merely read:
  // an organiser correcting a record while the participant has their own editor
  // open is the ordinary collision, and neither route has a version column to
  // arbitrate it.
  const overlay=document.getElementById('admin-profile-overlay');
  const _changed=profileChangedFields(fields, overlay?._row||{});
  if(!Object.keys(_changed).length){overlay?.remove();return;}
  // Optimistic concurrency: echo the fingerprint of the row this dialog was
  // rendered from — the same `_row` the diff is taken against. Guarded, so an
  // older payload that carries no `updated_at` sends nothing and falls through
  // to the server's unchecked path rather than claiming a read it cannot name.
  if(overlay?._row?.updated_at)_changed.expectedUpdatedAt=overlay._row.updated_at;
  // v6.9.2: confirm save when dirty — mirrors the Cancel guard so both
  // exit paths require an explicit decision once the form has changes.
  const saveOk=await showModal({
    title:'Save changes?',
    message:'Update this participant profile with the changes you made?',
    confirmText:'Save',
    cancelText:'Keep editing'
  });
  if(!saveOk)return;
  const r=await fetch(`/api/admin/participants/${userId}`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(_changed)});
  const d=await r.json();
  if(!r.ok){err.textContent=d.error||'Failed to save.';err.style.display='block';return;}
  document.getElementById('admin-profile-overlay')?.remove();
  // v8.3.36 — a staged email change is a DIFFERENT outcome from a saved profile,
  // and "Profile updated." would hide it. The server answers `emailChangePending`
  // with the address and whether the mail actually went; an undelivered stage is
  // still staged (nothing was committed, so nothing rolls back), and the operator
  // has to know which of the two happened.
  if (d.emailChangePending) {
    showToast(d.message || `Saved. The email change to ${d.pendingEmail} is waiting for the participant to confirm.`,
      d.emailDelivered === false ? 'error' : d.emailDeferred ? 'warning' : 'success');
  } else {
    showToast('Profile updated.','success');
  }
  _accountChanged();
}

/**
 * The LIVE competitions this participant is in, from the list already on screen.
 *
 * v7.21.21 — so the FIRST confirmation can say it. The server is still the
 * authority (it refuses, and the second dialog below reports that refusal), but
 * an admin should not have to confirm a destructive action and be told only
 * afterwards that the person is mid-competition. This list is up to 15 s stale —
 * it is the polled admin payload — which is exactly why it warns rather than
 * decides: if it is wrong in either direction the server still has the last word.
 */
function _liveCompsOf(id){
  const p=(S.adminParticipantsData||[]).find(u=>u.id===id);
  // v8.12.6 — a late entrant inside an open late-entry window is playing too, and
  // the server's speed bump now fires for them (`lateEntrant` on its 400, from
  // `lateEntryStateFor(...).canPlay`). The server marks exactly those entries
  // `late_entry_playing`, so the first dialog can say so before the admin
  // confirms, rather than only after.
  //
  // (review) — NOT `late_entrant`, which marks only the REMOVABLE late entrants:
  // one who had started playing before the end is playing and not removable, so
  // keyed on that flag the first dialog said nothing about them.
  return ((p&&p.competitions)||[]).filter(c=>c.status==='live'||c.late_entry_playing===true);
}

export async function deleteParticipant(id,{force=false}={}){
  if(!force){
    const live=_liveCompsOf(id);
    // Name them. "is in a live competition" sends the admin looking; naming it
    // is the difference between a warning and a puzzle — and with more than one
    // it also tells them how much they are interrupting.
    // (review) — "removing them from the event instead" is a remedy only where the
    // removal would be accepted: a late entrant who had started playing before the
    // end is playing and CANNOT be removed (`late_entry_playing` without
    // `late_entrant`), so for them the sentence says that instead of offering it.
    const _stuck=live.filter(c=>c.status!=='live'&&c.late_entrant!==true);
    const liveWarning=live.length?`<p class="modal-warn"><strong>${_pLabel(id)} is competing right now</strong> — `
      +`${live.length===1?'in':'in these events:'} `
      +live.map(c=>`<strong>${esc(c.name)}</strong>${c.late_entry_playing===true?' (as a late entrant)':''}`).join(', ')
      +`.<br>Deleting them ends their session and removes their submissions, hints and score from `
      +`${live.length===1?'it':'them'}. `
      +(_stuck.length
        ?`They had started playing ${_stuck.map(c=>`<strong>${esc(c.name)}</strong>`).join(', ')} before it ended, so they cannot be removed from ${_stuck.length===1?'it':'those'} instead.</p>`
        :`Removing them from the event instead leaves the account intact.</p>`):'';
    // v8.12.7 — say BEFORE the confirm that deleting reaches outside the platform.
    // `has_cxone_realm_account` is sent only to a session that may delete accounts
    // (a superadmin, or a role holding `participants.delete`) and only on a row the
    // ledger holds an account for, so an absent key means "nothing to say" — never
    // "no account", which the client cannot know.
    const _p=(S.adminParticipantsData||[]).find(u=>u.id===id);
    const cxoneNote=(_p&&_p.has_cxone_realm_account===true)
      ?`<p class="modal-note">The platform created a Checkmarx One account for them; it will try to remove it from the customer's tenant too.</p>`:'';
    const ok=await showModal({
      title:'Delete User',
      message:`${liveWarning}This will permanently delete ${_pLabel(id)} and all their submissions. This cannot be undone.${cxoneNote}`,
      confirmText:'Delete',confirmClass:'danger'});
    if(!ok)return;
  }
  const r=await fetch(`/api/admin/participants/${id}${force?'?force=1':''}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){
    // v8.12.7 — the toast reports what the SERVER did, from its own counts: the
    // removals it scheduled, the accounts it deliberately left in the tenant,
    // and the accounts it made but holds no record of. Each is absent
    // when zero, so an ordinary delete still says just that.
    //
    // (review) — THREE counts, three sentences, never two. An account the
    // platform CREATED but never recorded (made before v8.12.7 kept its ledger,
    // or by a create that did not say which account it made) is not one that
    // "already existed in the tenant": telling a superadmin the tenant's
    // administrator decides about it hands the decision to the wrong person for
    // an account we made, and one we cannot remove because nothing says which
    // realm account it is. The server counts those apart
    // (`cxone_accounts_unrecorded`), so the client says the true thing for each
    // rather than folding one into the other — and words it to cover BOTH ways
    // an account goes unrecorded, not only the older one.
    //
    // A fourth count, `cxone_records_unreadable`: set-up records of theirs that
    // cannot be read, so nothing says which account, if any, each names. Its own
    // sentence says "check", never "remove": the account may be a matched one
    // (the tenant administrator's) or one already being removed.
    const d=await r.json().catch(()=>({}));
    const n=Number(d.cxone_withdrawals_scheduled)||0, m=Number(d.cxone_accounts_left_in_place)||0,
      u=Number(d.cxone_accounts_unrecorded)||0, k=Number(d.cxone_records_unreadable)||0;
    let msg='User deleted.';
    // The removals page needs `ops.cxone` (superadmin only): a deleter without it
    // is told who follows the removal up, not sent to a page it cannot open.
    if(n>0)msg+=` Removal of ${n} Checkmarx One account${n===1?'':'s'} the platform created has been scheduled — `
      +(adminCan('ops.cxone')?`follow it under Settings → Checkmarx One account removals.`:`a superadmin follows it up under Settings → Checkmarx One account removals.`);
    if(m>0)msg+=` ${m} other Checkmarx One account${m===1?'':'s'} linked to them already existed in the tenant and ${m===1?'is':'are'} left in place; the tenant's administrator decides about ${m===1?'it':'those'}.`;
    // The same split for an account nothing records: whoever runs the
    // platform's Checkmarx One key removes it in the tenant by hand.
    if(u>0)msg+=` ${u} Checkmarx One account${u===1?'':'s'} the platform created for them ${u===1?'is':'are'} not in its records, so ${u===1?'it':'they'} cannot be removed automatically; `
      +(adminCan('ops.cxone')?`remove ${u===1?'it':'them'} in the tenant by hand.`:`a superadmin removes ${u===1?'it':'them'} in the tenant by hand.`);
    if(k>0)msg+=` ${k} Checkmarx One set-up record${k===1?'':'s'} of theirs could not be read, so the platform cannot tell which account, if any, ${k===1?'it names':'they name'}; `
      +(adminCan('ops.cxone')?`check the tenant for an account of theirs (their address is in the Audit page's record of the deletion).`:`a superadmin checks the tenant for an account of theirs.`);
    // A long sentence needs reading time; a plain delete keeps the 4 s default.
    showToast(msg,'success',(n||m||u||k)?{life:msg.length*70}:undefined);loadAdminParticipants();loadAdminLeaderboard();return;
  }
  // v7.21.20 — SAY WHY.
  //
  // This discarded the response and showed a bare "Failed to delete user.", so a
  // superadmin who hit the live-competition guard was told only that it had not
  // worked — no reason, no remedy — which reads as "the platform will not let me
  // delete this user". That is how it was reported. The server's message names
  // both the competition and the way out; showing it is most of the fix.
  const d=await r.json().catch(()=>({}));
  if(d.code==='participant_in_live_competition'&&!force){
    // …and the way out is offered here rather than left as a hunt: the admin
    // would otherwise have to find the competition, find this participant inside
    // it, remove them, come back, and delete. One confirmation instead, naming
    // what it will do. The server still requires the explicit override.
    const go=await showModal({
      title:'Participant is competing right now',
      // v8.12.6 — the same refusal now covers a late entrant playing through an
      // event's late-entry window (`lateEntrant`), which is not a "live event".
      message:(d.lateEntrant
        ?`${_pLabel(id)} is playing <strong>${esc(d.competitionName||'')}</strong> as a late entrant.`
        :`${_pLabel(id)} is in the live event <strong>${esc(d.competitionName||'')}</strong>.`)
        +`<br><br>Deleting them now ends their session and permanently removes their submissions, hints and score from it.`
        // (review) — the server says when the gentler option does not exist as
        // things stand, and WHICH rule says so (`removalRefused`, the removal
        // door's own code): each reason in its own words, never one for both.
        +(d.removable===false
          ?(d.removalRefused==='late_entrant_has_certificate'
            ?`<br><br>They hold a placing certificate for it, so they can be removed from it only once that certificate is revoked.`
            :d.removalRefused==='not_late_entrant'
              ?`<br><br>They had started playing it before it ended, so they cannot be removed from it instead.`
              :`<br><br>They cannot be removed from it instead.`)
          :`<br><br>If the event is still running for other people, removing them from it is the gentler option.`),
      confirmText:'Delete anyway',confirmClass:'danger',cancelText:'Cancel',
    });
    if(!go)return;
    return deleteParticipant(id,{force:true});
  }
  showToast(d.error||'Failed to delete user.','error');
}

// v8.13.7 — an event admin's opener awaits the network (below), so it takes the
// per-dialog open token every such opener takes (`_assignOpenSeq` in
// challenges-admin.js): a slow load from an earlier click must not open a second
// dialog over the one that replaced it.
let _inviteOpenSeq=0;

/**
 * v8.13.7 — what the Invite dialog offers, built from ONE set of rows.
 *
 * LISTED: every event that takes new members (`compAcceptsNewMembers`: live,
 * upcoming, or ended inside its late-entry window — the client half of the
 * route's `competitionAdmission`). TICKABLE: listed and not one the actor
 * competes in, which the route refuses by name (`competitor_cannot_edit`). Scope
 * is the server's: `GET /api/admin/competitions` returns an event admin only
 * their own events, so nothing here re-derives it.
 *
 * `requireEvent` (an event admin) carries the route's own rule into the dialog:
 * an event admin's invitation must name at least one event that can take people
 * (400 `event_admin_competition_required`). So the ONE tickable event is ticked
 * and LOCKED — there is no choice to make — and with none tickable nothing can
 * be sent, and the reason is said where the choice would be. The empty pick
 * among several is refused in `submitInvitations`. An admin or superadmin keeps
 * optional events: an invitation naming none is legitimate for them.
 */
function _inviteCompListHtml(comps,{requireEvent,seesEvents=true}){
  // RBAC — a role that may not read events is told so, never "no events".
  if(!seesEvents)return{sendable:true,html:'<p class="invite-comp-empty" id="invite-comp-unseen">Your role cannot see events, so nobody you invite is added to one.</p>'};
  const listed=comps.filter(compAcceptsNewMembers)
    .sort(compareCompsForPicker);   // v7.16.7 — one shared order for every event picker
  const tickable=listed.filter(c=>!c.competing);
  const lockedId=requireEvent&&tickable.length===1?tickable[0].id:null;

  // v6.10.25: render the same row shape the bulk-assign dialog uses —
  // bold name + status pill + Internal tag (when tagged) + long-format
  // meta under. Pre-v6.10.25 the invite dialog used a plain name +
  // right-aligned short date, which didn't communicate live-vs-upcoming
  // status or internal-flag at all. One visual language across both
  // competition-picker surfaces.
  const rows=listed.map(c=>{
    // v8.12.6 — the BUCKET a human is shown (Live / Upcoming / Late entry open),
    // from the one label table, rather than the raw lowercase status — which could
    // only ever have read "ended" for a late-entry event.
    const cat=compDisplayCategory(c);
    const isInternal=(c.tags||[]).includes(DRY_RUN_TAG);
    const internalTag=isInternal?` <span class="badge draft" title="Test / dry run event">${DRY_RUN_TAG}</span>`:'';
    // v8.12.0 — an event the actor competes in refuses the whole invitation
    // (403 by name), so it is not offered — and never PRE-TICKED: a dialog that
    // ticks the one event the server will refuse is worse than the bulk
    // picker was before it got the same gate.
    const competing=!!c.competing;
    // v8.13.7 — LOCKED: ticked and disabled. `disabled` does not drop it from
    // the request (`:checked` matches a disabled box; see submitInvitations).
    // Not `.is-disabled`, which dims the whole row's text with opacity.
    const locked=c.id===lockedId;
    const checked=locked||(!competing&&S.adminSelectedCompetitionId===c.id);
    return`<label class="picker-row${competing?' is-disabled':''}${locked?' is-locked':''}"${competing?' title="You are competing in this event — you cannot change its participants."':''}>
      <input type="checkbox" value="${esc(c.id)}" class="invite-comp-cb picker-row-check" data-late-entry="${cat==='late-entry'?'1':''}"
        ${checked?'checked':''} ${competing||locked?'disabled':''}${locked?' aria-describedby="invite-comp-locked-note"':''}/>
      <span class="picker-row-body"><strong>${esc(c.name)}</strong> <span class="status-badge ${esc(cat)}">${esc(COMP_CATEGORY_LABEL[cat]||cat)}</span>${internalTag}${competing?'<span class="picker-row-flag">You compete here</span>':''}${locked?'<span class="picker-row-flag is-on">Always included</span>':''}
      <span class="bulk-assign-row-meta">${cat==='late-entry'&&c.late_entry_deadline_effective?`Late entry open until ${fmtDt(c.late_entry_deadline_effective,'long')}`:fmtDt(c.start_time,'long')}</span></span>
    </label>`;
  }).join('');

  // The list is a 200px scroller. A tab stop of its own only when it holds no
  // box a keyboard can reach (every row locked or competing): otherwise
  // overflowing rows could be scrolled to by no keyboard at all.
  const anyEnabled=listed.some(c=>!c.competing&&c.id!==lockedId);
  const list=inner=>`<div class="invite-comp-list" role="group" aria-labelledby="invite-comp-label"${anyEnabled?'':' tabindex="0"'}>${inner}</div>`;
  if(!requireEvent){
    return{sendable:true,html:list(rows||'<p class="invite-comp-empty">No live, upcoming or late-entry events.</p>')};
  }
  if(!tickable.length){
    // Send is disabled and points here (aria-describedby, the dialog's too). In
    // the list's place when no event is listed; otherwise UNDER the rows it
    // explains, outside the scroller, so no number of rows can push it out of
    // sight.
    const why=listed.length
      ?'You compete in every one of your events that can take new participants, so you cannot invite anybody into them. Ask another organiser to send the invitations.'
      :'None of your events is live, upcoming or taking late entries, so you cannot invite anybody right now: everyone you invite has to join one of your events.';
    return{sendable:false,html:rows
      ?`${list(rows)}<p class="invite-comp-empty invite-comp-note" id="invite-comp-none">${why}</p>`
      :list(`<p class="invite-comp-empty" id="invite-comp-none">${why}</p>`)};
  }
  const note=lockedId
    ?'<p class="picker-note invite-comp-note" id="invite-comp-locked-note">This is the only one of your events you can invite people into right now, so everyone you invite is added to it.</p>'
    :'<p class="picker-note invite-comp-note" id="invite-comp-required-note">Tick at least one of your events: everyone you invite is added to the events you tick.</p>';
  return{sendable:true,html:`${list(rows)}${note}`};
}

export async function openInviteDialog(){
  const seq=++_inviteOpenSeq;
  // v8.13.7 — an EVENT ADMIN's list is read fresh, never from the cached model:
  // `S.adminCompetitionsData` is `[]` until its first load lands and again after
  // a failed one, and under the rule below an empty list means "you cannot
  // invite anybody" — a false refusal the organiser could not diagnose. An admin
  // or superadmin keeps the cached model (no await: the dialog opens at once),
  // since an empty list costs them nothing — their events are optional.
  const requireEvent=!!S.isEventAdmin;
  // RBAC — each list this dialog offers is a read of its own: the events
  // (`events.view`; a role scoped to its events is offered Invite only with it)
  // and the groups (`groups.view`). A role without one is told so in the list's
  // place, and that list is not requested (a refused read would also count
  // towards the address's scanner block).
  const seesEvents=requireEvent||adminCan('events.view');
  const seesGroups=adminCan('groups.view');
  let comps=S.adminCompetitionsData;
  if(requireEvent){
    comps=await fetchJsonList('/api/admin/competitions');
    if(seq!==_inviteOpenSeq)return;   // superseded by a later open (fetchJsonList parses inside)
    if(!comps){showToast('Could not load your events. Check your connection and try again.','error');return;}
  }
  document.querySelectorAll('#invite-overlay').forEach(o=>o.remove());
  // The group picks of THIS dialog; the fill below replaces it once groups load.
  S._inviteSelectedGroups=new Set();
  const compList=_inviteCompListHtml(comps,{requireEvent,seesEvents});

  const overlay=document.createElement('div');
  overlay.id='invite-overlay';
  // With nothing tickable the reason is also the dialog's description, so a
  // screen reader hears it on open (initial focus lands in the address box,
  // and the disabled Send that points at it is never focused).
  setSafeHtml(overlay, `<div class="card invite-card" role="dialog" aria-modal="true" aria-labelledby="invite-title"${compList.sendable?'':' aria-describedby="invite-comp-none"'}>
    <h3 id="invite-title" class="modal-title">Invite Participants</h3>
    <p class="invite-note">Enter email addresses (one per line). Existing users will be auto-assigned. New emails will receive a registration invitation.</p>
    ${deskApprovalWithheld()?`<p class="picker-note invite-approval-note">New accounts wait for approval on this platform, and your role cannot approve them: someone new who signs up through this invitation waits for an administrator to approve them, and joins the events you invited them to when they first sign in after that. Until then People lists them as waiting.</p>`:''}
    <div class="form-group">
      <label for="invite-emails">Email Addresses *</label>
      <textarea id="invite-emails" class="invite-emails-field" rows="6" placeholder="alice@company.com&#10;bob@company.com&#10;carol@company.com"></textarea>
    </div>
    <div class="form-group">
      <div class="help-label-row"><label id="invite-comp-label">Assign to Events${requireEvent?' *':''}</label><span data-help="invite.events" data-help-label="Assign to Events"></span></div>
      ${compList.html}
      <p class="picker-note invite-late-note" id="invite-late-note" style="margin-top:6px" hidden>An event that has ended but is still taking late entries is ticked: existing accounts are added to it as <strong>late entrants</strong>, and someone new joins it as one if they register before its late-entry deadline.</p>
    </div>
    <div class="form-group">
      <div class="help-label-row"><label>Add to Groups</label><span data-help="invite.groups" data-help-label="Add to Groups"></span></div>
      <div id="invite-group-list" style="display:flex;flex-wrap:wrap;gap:4px">${seesGroups?'<span class="settings-help" style="margin:0">Loading groups…</span>':'<span class="settings-help" style="margin:0" id="invite-group-unseen">Your role cannot see groups, so nobody you invite is added to one.</span>'}</div>
    </div>
    <div id="invite-error" class="invite-error" role="alert"></div>
    <div id="invite-result" class="invite-result"></div>
    <div class="invite-actions">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="invite-overlay">Cancel</button>
      <button class="btn" id="invite-submit-btn" data-action="invite-submit"${compList.sendable?'':' disabled aria-describedby="invite-comp-none"'}>Send Invitations</button>
    </div>
  </div>`);
  // Read back by submitInvitations, so the refusal there and what this dialog
  // rendered come from the same decision.
  if(requireEvent)overlay.dataset.requireEvent='1';
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  // v8.12.6 — the late-entry note follows the ticks, so it is on screen exactly
  // while a late-entry event is chosen (including a focused one pre-ticked above).
  const _syncLateNote=()=>{
    const note=overlay.querySelector('#invite-late-note');
    if(note)note.hidden=!overlay.querySelector('.invite-comp-cb[data-late-entry="1"]:checked');
  };
  overlay.querySelectorAll('.invite-comp-cb').forEach(cb=>cb.addEventListener('change',_syncLateNote));
  _syncLateNote();
  setTimeout(()=>document.getElementById('invite-emails')?.focus(),0);
  // Populate the groups multiselect asynchronously (chips toggle via aria-pressed).
  // v8.3.20 — through the helper: unchecked, a 500's error object reached the
  // chip render and the multiselect silently offered nothing to pick.
  if(seesGroups)fetchJsonList('/api/admin/groups').then(groups=>{
    // v8.13.7 — THIS dialog's box: a slow load from a dialog already replaced
    // must not fill (or reset the picks of) the one now showing.
    const box=overlay.querySelector('#invite-group-list');
    if(!box||!overlay.isConnected)return;
    if(!groups){setSafeHtml(box,`<span class="settings-help">Could not load groups.</span>`);return;}
    if(!Array.isArray(groups)||!groups.length){setSafeHtml(box,'<span class="settings-help" style="margin:0">No groups yet.</span>');return;}
    // v7.20.8 — a filter, once the list is long enough to need one. It HIDES
    // non-matching chips rather than re-rendering: this is a multiselect, and a
    // re-render would drop the picks already made.
    const _filter=groups.length>8?pickerFilterHtml('invite-group-filter',{placeholder:'Filter groups…',label:'Filter groups'}):'';
    // v7.21.16 (phase 4) — the selection lives in a MODEL, not in the markup.
    // submitInvitations() used to read it back with
    // querySelectorAll('[aria-pressed="true"]'), so the picks existed only as
    // long as this box did — and anything that re-rendered it (a filter that
    // rebuilds rather than hides, pagination, a refetch) would have dropped
    // every tick silently. Same class as the v7.17.0 import-conflict fix.
    S._inviteSelectedGroups=new Set();
    // v8.12.0 — only groups the actor may WRITE are offered: `can_write` folds
    // the event-admin scope and the competitor lock (a group bound to an event
    // the actor competes in), and the server refuses an invitation naming any
    // other. The withheld count is stated, or the list shrinks in silence.
    const _offered=groups.filter(g=>g.can_write!==false);
    const _withheld=groups.length-_offered.length;
    const _withheldNote=_withheld?`<span class="settings-help chip-note" style="margin:0 0 6px;display:block">${_withheld} group${_withheld===1?' is':'s are'} not offered — bound to an event you compete in or do not manage.</span>`:'';
    setSafeHtml(box,_withheldNote+_filter+chipMultiselectHtml(_offered,{cls:'invite-group-pick',countKey:'member_count',selected:S._inviteSelectedGroups,idAttr:'group-id'}));
    if(_filter)wirePickerFilter(box,'invite-group-filter','.invite-group-pick',{emptyText:'No group matches that filter.',noun:'group'});
    wireChipMultiselect(box,'invite-group-pick',S._inviteSelectedGroups,{idProp:'groupId'});
  }).catch(e=>console.warn('Invite dialog: group list failed to render',e));
}

export async function submitInvitations(){
  const err=document.getElementById('invite-error');err.style.display='none';
  const result=document.getElementById('invite-result');result.style.display='none';
  const raw=document.getElementById('invite-emails').value;
  // De-duplicate (case-insensitive) before sending. Without this, pasting
  // "alice@x.com\nalice@x.com" creates two invitation rows server-side and
  // sends two emails. The server also de-duplicates as a defence-in-depth
  // measure, but trimming here keeps the visible "N invitations sent"
  // count honest from the client's perspective too.
  const seen=new Set();
  const malformed=[];
  const emails=raw.split(/[\n,;]+/).map(e=>e.trim()).filter(e=>{
    if(!e)return false;
    // v6.10.26: align client-side with the server's isValidEmailFormat
    // (local@domain.tld, no whitespace, no second @, max 254 chars).
    // Pre-v6.10.26 the client accepted anything containing '@', which
    // meant "a@b" and " alice@x.com" reached the network + spinner
    // path only to come back as server-side 400s. Now we reject them
    // up front and surface the list inline.
    if(!isValidEmailFormat(e)){malformed.push(e);return false;}
    const k=e.toLowerCase();
    if(seen.has(k))return false;
    seen.add(k);
    return true;
  });
  if(malformed.length){
    err.textContent=`Invalid email address${malformed.length>1?'es':''}: ${malformed.slice(0,3).join(', ')}${malformed.length>3?` (+${malformed.length-3} more)`:''}`;
    err.style.display='block';
    return;
  }
  if(!emails.length){err.textContent='Please enter at least one email address.';err.style.display='block';return;}
  // `:checked` includes a LOCKED (disabled) tick, so the sole event an event
  // admin cannot untick is still sent (see _inviteCompListHtml).
  const competitionIds=[...document.querySelectorAll('.invite-comp-cb:checked')].map(cb=>cb.value);
  // v7.21.16 — read the MODEL, not the DOM (see openInviteDialog).
  const groupIds=[...(S._inviteSelectedGroups||new Set())];
  const overlay=document.getElementById('invite-overlay');
  // v8.13.7 — events are optional for an admin or superadmin and REQUIRED for an
  // event admin: the route refuses an event admin's invitation naming none (400
  // event_admin_competition_required), so it is refused here, before the request.
  // Groups do not count — the route asks for an event whatever groups are named.
  // When nothing can be ticked Send is disabled with the reason on screen
  // (#invite-comp-none); this arm also holds for a dispatch that bypasses it.
  if(overlay?.dataset.requireEvent==='1'&&!competitionIds.length){
    err.textContent=overlay.querySelector('#invite-comp-none')?.textContent
      ||'Tick at least one of your events. As an event admin you can only invite people into an event you manage.';
    err.style.display='block';
    return;
  }

  // Block UI with overlay spinner
  const blocker=document.createElement('div');
  blocker.id='invite-blocker';
  blocker.className='invite-blocker';
  setSafeHtml(blocker, '<div class="invite-blocker-inner"><div class="spinner"></div><div class="invite-blocker-label">Sending invitations...</div><div class="invite-blocker-sub">Please wait</div></div>');
  const dialog=overlay?.querySelector('.invite-card');
  if(dialog){dialog.appendChild(blocker);}
  document.getElementById('invite-submit-btn').disabled=true;

  let r,d;
  try{
    const ctrl=new AbortController();
    const timeout=setTimeout(()=>ctrl.abort(),30000);
    r=await fetch('/api/admin/invitations',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({emails,competitionIds,groupIds}),signal:ctrl.signal});
    // ext-audit v7.15.15 — the deadline must survive the BODY read. `fetch`
    // resolves at response HEADERS, so clearing here left a stalled body
    // unbounded and this await open for ever. Same defect the auditor reported
    // in core/api.js; fixed at every site that arms a deadline, not just the
    // one that was reported.
    d=await r.json();
    clearTimeout(timeout);
  }catch(e){
    blocker.remove();
    document.getElementById('invite-submit-btn').disabled=false;
    err.textContent=e.name==='AbortError'?'Request timed out. Please try again.':'Network error. Please try again.';
    err.style.display='block';return;
  }
  blocker.remove();
  document.getElementById('invite-submit-btn').disabled=false;
  if(!r.ok){
    // v7.11.2 — group-clash (409): a participant can only be in one group per competition.
    // Present a blocking alert listing the offending participant(s) + groups.
    if(r.status===409&&d.clash){
      const rows=(d.clash.conflicts||[]).map(c=>{
        const where=(c.conflicts||[]).map(x=>`${x.groups.map(esc).join(' + ')} on <strong>${esc(x.competitionName)}</strong>`).join('; ');
        return c.nickname
          ?`<li><strong>${esc(c.nickname)}</strong> — would be in ${where}</li>`
          :`<li>The selected groups overlap on ${where}</li>`;
      }).join('');
      await showModal({title:'Group members clash',confirmText:'OK',cancelText:'',confirmClass:'',message:`These invitations can't be sent — a participant can only be in one group per event:<ul style="margin:8px 0;padding-left:20px">${rows}</ul>Pick different group(s), or remove the affected people from the other group, then try again.`});
      return;
    }
    err.textContent=d.error||'Failed to send invitations.';err.style.display='block';return;
  }

  // Remove successfully processed emails from textarea, keep failed/existing/already-invited/already-assigned/undelivered ones
  const existingSet=new Set((d.existingEmails||[]).map(e=>e.toLowerCase()));
  const alreadyInvitedSet=new Set((d.alreadyInvited||[]).map(e=>e.toLowerCase()));
  // v6.3.2: already_assigned — existing user who was a member of every
  // selected competition. Keep in the textarea so the admin sees the
  // address (highlighted red) with a clear reason instead of having it
  // silently disappear.
  const alreadyAssignedSet=new Set((d.alreadyAssigned||[]).map(e=>e.toLowerCase()));
  const undeliveredSet=new Set((d.undeliveredInvites||[]).map(u=>(typeof u==='object'?u.email:u).toLowerCase()));
  // v8.3.7 — an opted-out invitee is its own outcome, not a delivery failure.
  const unsubscribedSet=new Set((d.unsubscribedInvites||[]).map(u=>(typeof u==='object'?u.email:u).toLowerCase()));
  // audit v7.7.37 (C19) — server errors are "email: reason" (email BEFORE the first
  // colon, e.g. "bob@corp.com: account has been denied — …"). Pre-fix the regex
  // captured everything AFTER the colon (the REASON), so the failed address was
  // never kept in the textarea and the details dialog closed on the `!keepEmails`
  // branch, hiding the actionable reason. Take the prefix; fall back to the suffix
  // for the legacy "Invalid email: x" shape.
  const errorSet=new Set((d.errors||[]).map(e=>{
    const s=String(e);const ci=s.indexOf(':');
    if(ci<0)return s.trim().toLowerCase();
    const prefix=s.slice(0,ci).trim();
    if(prefix.includes('@'))return prefix.toLowerCase();
    const suffix=s.slice(ci+1).trim();
    return (suffix.includes('@')?suffix:prefix).toLowerCase();
  }));
  // v8.3.7 — an unsubscribed invitee is KEPT in the textarea like every other
  // non-success outcome, so the address stays on screen beside its reason
  // instead of silently disappearing (the v6.3.2 rule for already-assigned).
  // An account an organiser's invitation left waiting for approval (none of
  // their events took it) is kept too, beside its reason.
  const leftPendingSet=new Set((Array.isArray(d.leftPending)?d.leftPending:[]).map(e=>String(e).toLowerCase()));
  const keepEmails=emails.filter(e=>{const lc=e.toLowerCase();return existingSet.has(lc)||alreadyInvitedSet.has(lc)||alreadyAssignedSet.has(lc)||undeliveredSet.has(lc)||unsubscribedSet.has(lc)||errorSet.has(lc)||leftPendingSet.has(lc);});
  const textarea=document.getElementById('invite-emails');
  textarea.value=keepEmails.join('\n');
  // Highlight textarea if there are remaining emails
  textarea.classList.toggle('has-remaining',keepEmails.length>0);

  let msg=[];
  // `invited` is the count of NEW invitation rows created. `resent` counts
  // retries of previously-undelivered invitations whose send succeeded this
  // request. `emailsSent` is the union — surface both so the admin can see
  // a recovery send as a positive outcome (not a misleading "0 invitations
  // sent") and see the new/retry gap when relevant.
  const invitedCount=Number(d.invited)||0;
  const resentCount=Number(d.resent)||0;
  if(invitedCount){
    if(typeof d.emailsSent==='number'&&d.emailsSent<(invitedCount+resentCount)){
      msg.push(`${invitedCount} invitation(s) created (${Number(d.emailsSent)} of ${invitedCount+resentCount} email(s) actually delivered)`);
    }else{
      msg.push(`${invitedCount} invitation(s) sent`);
    }
  }
  if(resentCount)msg.push(`${resentCount} prior invitation(s) successfully re-sent`);
  if(d.assigned)msg.push(`${Number(d.assigned)} existing user(s) assigned to events${(Array.isArray(d.lateEntryCompetitionIds)&&d.lateEntryCompetitionIds.length)?' (as late entrants where the event has ended)':''}`);
  if(d.existingEmails&&d.existingEmails.length)msg.push(`${d.existingEmails.length} already registered`);
  if(d.alreadyInvited&&d.alreadyInvited.length)msg.push(`${d.alreadyInvited.length} already invited`);
  if(d.alreadyAssigned&&d.alreadyAssigned.length)msg.push(`${d.alreadyAssigned.length} already assigned to the selected event(s)`);
  // v8.12.0 — the route has counted every skipped enrolment since v6.16.9 and
  // this dialog rendered none of them (the v7.21.2 counter-with-no-consumer
  // defect); the staff and peer-admin skips arrived with the same gap, and an
  // organiser was told "0 assigned" with no reason. Every reason is spoken now.
  if(d.skippedStaff)msg.push(`${d.skippedStaff} staff enrolment(s) skipped — staff can only be added to events that let staff compete`);
  if(d.skippedPrivileged)msg.push(`${d.skippedPrivileged} admin account(s) skipped — only a superadmin can enrol an admin`);
  if(d.skippedPrivilegedGroups)msg.push(`${d.skippedPrivilegedGroups} admin account(s) not added to the selected group(s) — only a superadmin can put an admin into a group`);
  if(d.skippedAuthors)msg.push(`${d.skippedAuthors} skipped because they created a question in the event`);
  if(d.skippedBlocked)msg.push(`${d.skippedBlocked} blocked account(s) not enrolled`);
  if(d.skippedUnapproved)msg.push(`${d.skippedUnapproved} unapproved account(s) not enrolled`);
  // v8.12.6 — the late-entry window refuses a NEW row for anybody who took part
  // before the event ended; the route counts it, so it is spoken.
  if(d.skippedTookPart)msg.push(`${d.skippedTookPart} not enrolled — they took part before the event ended, so they cannot rejoin it as late entrants`);
  if(leftPendingSet.size)msg.push(`${leftPendingSet.size} account(s) left waiting for approval — none of your events took them, so an administrator approves them`);
  if(d.undeliveredInvites&&d.undeliveredInvites.length)msg.push(`${d.undeliveredInvites.length} email(s) failed to deliver`);
  if(d.unsubscribedInvites&&d.unsubscribedInvites.length)msg.push(`${d.unsubscribedInvites.length} unsubscribed (not emailed)`);
  if(d.errors&&d.errors.length)msg.push(`${d.errors.length} invalid`);
  // Defensive: if every input was deduped against an existing invitation
  // OR was malformed, msg could otherwise be empty and showToast would
  // render an empty bar. Always tell the operator something happened.
  if(!msg.length)msg.push('No new invitations sent — all addresses were already invited or invalid.');
  showToast(msg.join(', '));
  loadAdminParticipants();loadAdminCompetitions();
  // Close dialog if all emails processed successfully; keep open if errors remain
  if(!keepEmails.length){
    document.getElementById('invite-overlay')?.remove();return;
  }
  let details=[];
  if(d.existingEmails&&d.existingEmails.length)details.push(...d.existingEmails.map(e=>esc(e)+' — already registered'));
  if(d.alreadyInvited&&d.alreadyInvited.length)details.push(...d.alreadyInvited.map(e=>esc(e)+' — already invited (any new events were merged into the existing invitation)'));
  if(d.alreadyAssigned&&d.alreadyAssigned.length)details.push(...d.alreadyAssigned.map(e=>esc(e)+' — already a member of every selected event; nothing to do'));
  if(d.undeliveredInvites&&d.undeliveredInvites.length){
    // undeliveredInvites is an array of {email, link} objects — expose the
    // link so the admin can share it manually if SMTP stays down. The
    // invitation row is already created and subsequent admin retries will
    // re-send automatically (server-side retry logic), but giving the
    // operator the link now avoids the "stranded invite" state.
    details.push(...d.undeliveredInvites.map(u=>{
      const link=typeof u==='object'?u.link:null;
      const em=typeof u==='object'?u.email:u;
      const base=esc(em)+' — invitation row created, but the email could not be delivered';
      // v8.13.3 — an event admin is not handed the link of an invitation that also
      // covers events or groups they do not manage (`linkWithheld`). Say so, rather
      // than the SMTP copy below, which would read as "there is no link" and send
      // them to a relay they cannot fix. It names neither the other events nor
      // their organisers: the server deliberately discloses neither.
      if(typeof u==='object'&&u.linkWithheld===true)return `${base}. Its registration link is not shown to you because this invitation also covers events or groups you do not manage — retry the invite, or ask an administrator to share the link.`;
      return link?`${base}. <a href="${esc(link)}" target="_blank" rel="noopener">Registration link</a> (share manually or retry).`:`${base} (retry or check SMTP).`;
    }));
  }
  if(d.unsubscribedInvites&&d.unsubscribedInvites.length){
    // v8.3.7 — DELIBERATELY NO LINK. The undelivered branch above hands over a
    // registration link "share manually", which is right when a relay is down and
    // exactly wrong here: this address is in the unsubscribe list, so the mail was
    // withheld on the recipient's own instruction. Offering the link would be the
    // platform showing an operator how to route around that, while telling them
    // SMTP had failed. The remedy named is the one that respects the choice.
    details.push(...d.unsubscribedInvites.map(u=>{
      const em=typeof u==='object'?u.email:u;
      return esc(em)+' — invitation row created, but this address has unsubscribed, so no email was sent. '
        +'A superadmin can re-subscribe it under Settings → Unsubscribed; otherwise reach them another way.';
    }));
  }
  if(leftPendingSet.size)details.push(...[...leftPendingSet].map(e=>esc(e)+' — left waiting for approval: none of your events took it, so an administrator approves it'));
  if(d.errors&&d.errors.length)details.push(...d.errors.map(e=>esc(e)));
  setSafeHtml(result, `<strong>${msg.join(', ')}</strong>`
    +(details.length?'<br/><span class="invite-result-detail">'+details.join('<br/>')+'</span>':''));
  result.style.display='block';
}

export function inviteParticipantsForCompetition(compId,compName){
  setAdminCompetitionScope(compId,compName);
  // audit v7.7.37 (C20) — switch tabs via the canonical nav item instead of the
  // stale pre-sidebar `.tab` selectors. The admin nav is now a sidebar of
  // `.admin-nav-item`s, so `querySelectorAll('.tab')` matched NOTHING — the
  // Competitions item kept `.active` + aria-current="page" while the Participants
  // pane showed (nav state contradicting the visible pane), and the hand-rolled
  // pane list even omitted admin-analytics-tab. Clicking the nav item routes through
  // adminTab() → correct highlight, aria-current, the canonical pane list, and
  // _closeAdminSidebarMobile, all in one place.
  // Inside the event's workspace, on its Participants section with EVERYONE
  // listed (members first): "Manage participants" is how people are added. The
  // workspace tab keeps the event; the sidebar's People item would close it.
  S.pWsShowEveryone=true;
  document.querySelector('#ws-tabs [data-section="admin-participants-tab"]')?.click();
}


// v8.12.0 — THE ASSIGN ROUTE'S SKIP LEDGER, RENDERED. `skippedStaff` has ridden
// the response since v6.x with NO client consumer (the v7.21.2 counter-with-no-
// consumer defect), so an admin ticking a staff colleague got "0 newly invited"
// and no reason. It is per (user, event) now and it has company:
//   • skippedStaff      — staff may only be enrolled in an event where staff
//                         compete ("Staff can compete" on the event form)
//   • skippedPrivileged — a regular admin may not enrol an admin or superadmin
//                         account (the peer-admin doctrine); a superadmin may,
//                         and anybody may enrol themselves
//   • skippedAuthors    — a challenge's answer is known to its author, so the
//                         author of a challenge assigned to the event cannot
//                         compete in it; NAMED, in a modal, because the remedy
//                         is per person and per challenge
// The blocked/unapproved skips were already named at one of the three callers
// and not the other two; one helper serves all three.
function _assignSkipNote(d){
  const parts=[];
  if(d.skippedStaff)parts.push(`${d.skippedStaff} staff enrolment(s) skipped — staff can only be added to events that let staff compete`);
  if(d.skippedPrivileged)parts.push(`${d.skippedPrivileged} admin account(s) skipped — only a superadmin can enrol an admin`);
  if(d.skippedBlocked)parts.push(`${d.skippedBlocked} blocked account(s) skipped`);
  if(d.skippedUnapproved)parts.push(`${d.skippedUnapproved} unapproved account(s) skipped`);
  if(Array.isArray(d.skippedAuthors)&&d.skippedAuthors.length)parts.push(`${d.skippedAuthors.length} skipped because they created a question in the event`);
  // v8.12.6 — through a late-entry window the route skips anybody who took part
  // in the event before it ended (a new row would move them onto the late-entrant
  // list and let them play on past the end of an event whose results are final).
  if(d.skippedTookPart)parts.push(`${d.skippedTookPart} skipped — they took part before the event ended, so they cannot rejoin it as late entrants`);
  return parts.length?` ${parts.join('. ')}.`:'';
}

// v8.12.6 — ADDING PEOPLE TO A FINISHED EVENT THAT IS STILL TAKING LATE ENTRIES.
//
// The assign route admits them (as late entrants: their join time is after the
// end, so they are ranked in the separate Late entrants section and can play until
// the late-entry deadline), and the admin is told so BEFORE they confirm — it is
// not the same thing as adding somebody to a running event, and "Invite" alone
// would say it was. The deadline is the server's own resolved value
// (`late_entry_deadline_effective` on the admin row), never re-derived here.
//
// The reveal clause is v8.6.0's decision seen from a new door: with "reveal
// answers when the event ends" on, the answers are already published to everyone
// in the event, so somebody the admin adds now can read them. The competition form
// warns about it; the door that newly makes it an admin's act says it too.
function _lateEntryAddNote(comp){
  if(!isLateEntryOpen(comp))return '';
  const dl=comp.late_entry_deadline_effective?fmtDt(comp.late_entry_deadline_effective,'long'):'';
  return `<p class="modal-late-note"><strong>“${esc(comp.name||'')}” has ended.</strong> Anyone you add now joins as a <strong>late entrant</strong> — ranked in the separate Late entrants section${dl?`, and able to play until <strong>${esc(dl)}</strong>`:''}. A late entrant's placing certificate is available only once late entry closes.`
    +(comp.reveal_answers_on_end?' <strong>The answers to this event are already published to everyone in it, so they will be able to read them.</strong>':'')
    +`</p>`;
}
function _showSkippedAuthorsModal(d){
  const rows=Array.isArray(d.skippedAuthors)?d.skippedAuthors:[];
  if(!rows.length)return;
  const list=rows.map(r=>`<li><strong>${esc(r.nickname||r.userId)}</strong> — ${esc(r.competitionName||'')}: ${(r.tasks||[]).map(t=>`“${esc(t.title)}”`).join(', ')}</li>`).join('');
  showModal({
    title:'Not enrolled — they wrote a question in this event',
    message:`A question's answer is known to the person who created it, so its author cannot compete in an event it is assigned to. These were skipped:<ul style="margin:8px 0 0 18px">${list}</ul>Take the question out of the event, or leave them off the board.`,
    confirmText:'OK',cancelText:null
  });
}

export async function quickAssignSelectedToCompetition(){
  if(!S.adminSelectedCompetitionId||!S.selectedParticipants.size)return;
  const comp=S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId);
  const count=S.selectedParticipants.size;
  let confirmMsg=`Invite <strong>${count}</strong> selected participant(s) to <strong>${esc(comp?.name||'')}</strong>?<br><br>Already-enrolled participants will be skipped. Invitation emails will only be sent to newly added participants.`;
  // Warn about potential revival of auto-ended sessions
  const revivalHints=_getAssignRevivalHints(comp);
  if(revivalHints)confirmMsg+=revivalHints;
  // v8.12.6 — never both: a revivable event is revived, not joined late (the
  // route asks the revive question first), so the late note is for the other case.
  else confirmMsg+=_lateEntryAddNote(comp);
  const ok=await showModal({title:`Invite to ${comp?.name||'Event'}`,message:confirmMsg,confirmText:'Invite',confirmClass:revivalHints?'danger':''});
  if(!ok)return;
  const res=await fetchWithLoading('/api/admin/competitions/assign',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({userIds:Array.from(S.selectedParticipants),competitionIds:[S.adminSelectedCompetitionId]})});
  if(!res)return;
  if(res.r.ok){
    const d=res.d;
    const skipped=count-(d.assigned||0);
    const emailFailed=(d.assigned||0)-(d.emailsSent||0);
    // v8.12.6 — the route names every event it admitted through a late-entry
    // window, so the toast can say what the admin just did.
    const _lateAdd=Array.isArray(d.lateEntryCompetitionIds)&&d.lateEntryCompetitionIds.includes(S.adminSelectedCompetitionId);
    let msg=`${d.assigned||0} participant(s) newly invited${_lateAdd?' as late entrants':''}. ${d.emailsSent||0} email(s) sent.`;
    if(emailFailed>0)msg+=` ${emailFailed} email(s) failed to deliver.`;
    // v8.12.6 — `skippedTookPart` is a REASONED skip like the others, so it must
    // be in this sum: "already enrolled" is derived by subtraction, and leaving it
    // out reported one took-part skip twice — once as "already enrolled".
    const _reasoned=(d.skippedStaff||0)+(d.skippedPrivileged||0)+(d.skippedBlocked||0)+(d.skippedUnapproved||0)+((d.skippedAuthors||[]).length)+(d.skippedTookPart||0);
    if(skipped-_reasoned>0)msg+=` ${skipped-_reasoned} already enrolled — skipped.`;
    msg+=_assignSkipNote(d);
    if(d.revived&&d.revived.length)msg+=` Revived: ${d.revived.join(', ')}.`;
    // ext-audit v7.15.15 — see the bulk-approve note: still-sending means the
    // sent/failed split is provisional. The INVITATIONS themselves are durable.
    if(d.emailsDeferred)msg+=' Some emails are still sending — those counts are not final.';
    showToast(msg,d.emailsDeferred?'info':undefined);
    _showSkippedAuthorsModal(d);
    S.selectedParticipants.clear();loadAdminParticipants();loadAdminCompetitions();
  }else{showToast(res.d.error||'Failed to invite.');}
}

export function _getAssignRevivalHints(comp){
  if(!comp||computeCompStatus(comp)!=='ended'||comp.ended_manually)return null;
  const n=new Date();
  const slots=comp.timeslots||[];
  const revivable=[];
  if(slots.length===0){
    const schedEnd=new Date(new Date(comp.start_time).getTime()+comp.duration_minutes*60000);
    if(schedEnd>n)revivable.push(comp.name);
  }else{
    for(const ts of slots){
      if(computeCompStatus(ts)!=='ended'||ts.ended_manually)continue;
      const tsEnd=new Date(new Date(ts.start_time).getTime()+ts.duration_minutes*60000);
      if(tsEnd>n)revivable.push(`${comp.name} → ${ts.name}`);
    }
  }
  if(!revivable.length)return null;
  // Issued certificates stay as issued (operator ruling, 17 Nov 2026).
  const certNote=certificatesKeptOnReviveNote(comp);
  return `<br><div style="background:var(--surface2);border-left:3px solid var(--yellow);padding:10px 12px;border-radius:var(--radius-sm);margin-top:8px;text-align:left;font-size:var(--fs-14)">` +
    // v8.3.11 — "solved all tasks" is false whenever an attempt cap is in play:
    // the auto-end predicate is solved-OR-exhausted. This is the WORST-placed of
    // the five copies of that claim, because it is shown at the exact moment an
    // admin is following the remedy the other four name.
    `<strong style="color:var(--yellow)">Revival warning:</strong> This event was auto-ended (every participant had finished every question — solved it, or run out of attempts). Adding new participants will make the following <strong>live</strong> again:` +
    `<ul style="margin:6px 0 0">${revivable.map(n=>'<li>'+esc(n)+'</li>').join('')}</ul>` +
    (certNote?`<p style="margin:8px 0 0">${esc(certNote)}</p>`:'') +
    `</div>`;
}

export async function quickInviteToCompetition(userId){
  if(!S.adminSelectedCompetitionId)return;
  const comp=S.adminCompetitionsData.find(c=>c.id===S.adminSelectedCompetitionId);
  const revivalHints=_getAssignRevivalHints(comp);
  if(revivalHints){
    const ok=await showModal({title:'Revival Warning',message:`Inviting participant to <strong>${esc(comp?.name||'')}</strong>.${revivalHints}`,confirmText:'Invite Anyway',confirmClass:'danger'});
    if(!ok)return;
  }else if(isLateEntryOpen(comp)){
    // v8.12.6 — this path asks nothing for an ordinary invite, and must here: the
    // person joins a FINISHED event as a late entrant, which the row item's
    // "Invite to …" label alone does not say.
    const ok=await showModal({title:`Add a late entrant to ${comp?.name||'the event'}`,message:_lateEntryAddNote(comp),confirmText:'Add as late entrant'});
    if(!ok)return;
  }
  const res=await fetchWithLoading('/api/admin/competitions/assign',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({userIds:[userId],competitionIds:[S.adminSelectedCompetitionId]})});
  if(!res)return;
  if(res.r.ok){
    const d=res.d;
    let msg;
    if((d.assigned||0)>0){
      const _late=Array.isArray(d.lateEntryCompetitionIds)&&d.lateEntryCompetitionIds.includes(S.adminSelectedCompetitionId);
      const _who=`Participant invited${_late?' as a late entrant':''}`;
      msg=(d.emailsSent||0)>0?`${_who}. Email sent.`:`${_who}, but email delivery failed.`;
      if(d.revived&&d.revived.length)msg+=` Revived: ${d.revived.join(', ')}.`;
    }else{
      // v8.12.0 — "no changes" has five reasons now, and the ledger says which.
      const note=_assignSkipNote(d);
      msg=note?`Not invited.${note}`:'Participant already enrolled — no changes made.';
    }
    showToast(msg,(d.assigned||0)>0?undefined:'error');
    _showSkippedAuthorsModal(d);
    loadAdminParticipants();loadAdminCompetitions();
  }else{showToast(res.d.error||'Failed to invite.');}
}

export async function uninviteFromCompetition(userId){
  if(!S.adminSelectedCompetitionId)return;
  const compName=S.adminSelectedCompetitionName||'this event';
  const user=S.adminParticipantsData.find(u=>u.id===userId);
  const userName=user?`${user.first_name} ${user.last_name}`:'this participant';
  const ok=await showModal({title:'Remove from Event',message:`Remove <strong>${esc(userName)}</strong> from <strong>${esc(compName)}</strong>?<br><br>They will lose access and receive a notification email.`,confirmText:'Remove',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/competitions/${S.adminSelectedCompetitionId}/users/${userId}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){
    const d=await r.json().catch(()=>({}));
    if(d.emailDelivered===false)showToast('Participant removed, but the notification email could NOT be delivered. Check SMTP.','error');
    else if(d.emailDeferred)showToast('Participant removed from event. The notification email is still being sent.','warning');
    else showToast('Participant removed from event.','success');
    loadAdminParticipants();loadAdminCompetitions();
  }else{const d=await r.json().catch(()=>({}));showToast(d.error||'Failed to remove.','error');}
}

export async function openBulkAssignModal(){
  if(!S.selectedParticipants.size){showToast('Select participants first.');return;}
  S.bulkAssignStep=1;
  S.bulkSelectedComps=[];
  S.bulkSelectedGroups=[];
  // v8.3.20 — both loads are REQUIRED for this dialog to mean anything: an
  // empty competition list here reads as "there is nothing to assign to", which
  // is the one wrong answer an admin cannot diagnose from the screen.
  const comps=await fetchJsonList('/api/admin/competitions');
  const allGroupsRaw=await fetchJsonList('/api/admin/groups');
  if(!comps||!allGroupsRaw){showToast('Could not load events or groups. Check your connection and try again.','error');return;}
  // v8.12.0 — only groups the actor may BIND (`can_bind`: the event-admin scope
  // alone — binding changes the target event's roster, not the group's, so the
  // competitor lock on the group does not apply here and must not withhold it);
  // the count withheld is stated in the step that lists them.
  const allGroups=allGroupsRaw.filter(g=>g.can_bind!==false);
  const _groupsWithheld=allGroupsRaw.length-allGroups.length;
  // v8.12.6 — every event that takes new members, including an ended Booth Event
  // still taking late entries (the assign route admits it, as late entrants; a
  // group bound here is live-synced into it the same way).
  const nonEnded=comps.filter(compAcceptsNewMembers).sort(compareCompsForPicker);

  const overlay=document.createElement('div');
  overlay.id='bulk-assign-overlay';
  overlay.className='picker-overlay';
  // Step 2 → Back re-renders Step 1: the group filter's text is kept here (the
  // event and group ticks live in S.bulkSelectedComps / S.bulkSelectedGroups),
  // so Back returns to the list as it was left, narrowed and ticked.
  let _bulkGroupFilter='';

  function renderStep1(){
    setSafeHtml(overlay, `<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="bulk-assign-title">
      <div class="picker-modal-head">
        <h3 id="bulk-assign-title">Step 1: Select Events</h3>
      </div>
      <p class="picker-note">${S.selectedParticipants.size} participant(s) selected. Choose events to assign them to:</p>
      ${nonEnded.length?`<div class="picker-rows" id="bulk-comp-list">
        ${nonEnded.map(c=>{
          // v8.12.6 — the bucket a human is shown, from the one label table.
          const cat=compDisplayCategory(c);
          // v8.12.0 — an event the actor competes in refuses the whole request
          // (403 by name), so it is not offered — the challenge-side picker's
          // rule, applied to its twin.
          const competing=!!c.competing;
          return`<label class="picker-row${competing?' is-disabled':''}"${competing?' title="You are competing in this event — you cannot change its participants."':''}>
            <input type="checkbox" value="${c.id}" class="picker-row-check" ${competing?'disabled':(S.bulkSelectedComps.includes(c.id)?'checked':'')}/>
            <span class="picker-row-body"><strong>${esc(c.name)}</strong> <span class="status-badge ${esc(cat)}">${esc(COMP_CATEGORY_LABEL[cat]||cat)}</span>${(c.tags||[]).includes(DRY_RUN_TAG)?` <span class="badge draft" title="Test / dry run event">${DRY_RUN_TAG}</span>`:''}${competing?'<span class="picker-row-flag">You compete here</span>':''}
            <span class="bulk-assign-row-meta">${cat==='late-entry'&&c.late_entry_deadline_effective?`Late entry open until ${fmtDt(c.late_entry_deadline_effective,'long')}`:fmtDt(c.start_time,'long')}</span></span>
          </label>`;
        }).join('')}
      </div>`:'<p class="picker-note">No live, upcoming or late-entry events.</p>'}
      ${allGroups.length?`<div style="margin-top:12px">
        <p class="picker-note" style="margin-bottom:6px">Optionally also bind whole groups (live-synced — members join/leave the event as the group changes):</p>
        ${_groupsWithheld?`<span class="settings-help chip-note" style="margin:0 0 6px;display:block">${_groupsWithheld} group${_groupsWithheld===1?' is':'s are'} not offered — used by an event you do not manage.</span>`:''}
        ${allGroups.length>8?pickerFilterHtml('bulk-group-filter',{placeholder:'Filter groups…',label:'Filter groups'}):''}
        <div style="display:flex;flex-wrap:wrap;gap:4px" id="bulk-group-list">
          ${chipMultiselectHtml(allGroups,{cls:'bulk-group-pick',countKey:'member_count',selected:_bulkGroupSet(),idAttr:'group-id'})}
        </div>
      </div>`:''}
      <div class="picker-modal-foot">
        <button class="btn secondary" data-action="overlay-close" data-overlay-id="bulk-assign-overlay">Cancel</button>
        <button class="btn" data-action="bulk-assign-next">Next</button>
      </div>
    </div>`);
    // Toggle group selection (multi-select chips).
    const _gf=overlay.querySelector('#bulk-group-filter');
    if(_gf){
      _gf.value=_bulkGroupFilter;
      _gf.addEventListener('input',()=>{_bulkGroupFilter=_gf.value;});
      wirePickerFilter(overlay,'bulk-group-filter','.bulk-group-pick',{emptyText:'No group matches that filter.',noun:'group'});   // applies the kept text at once
    }
    // v7.21.16 (phase 4) — same helper as the invitation dialog. S.bulkSelectedGroups
    // stays an ARRAY on the state object (other code and the request body read it
    // as one); the Set is the working view, written back on every toggle so the
    // Step 2 → Back restore keeps working.
    const _bg=_bulkGroupSet();
    wireChipMultiselect(overlay,'bulk-group-pick',_bg,{idProp:'groupId',onChange:sel=>{S.bulkSelectedGroups=[...sel];}});
  }

  // v7.21.16 — S.bulkSelectedGroups is an ARRAY (the request body and other
  // callers read it as one); the chip helper works in a Set. One conversion
  // point rather than two, so the two representations cannot disagree.
  function _bulkGroupSet(){ return new Set((S.bulkSelectedGroups||[]).map(String)); }

  function renderStep2(){
    const selectedUsers=S.adminParticipantsData.filter(p=>S.selectedParticipants.has(p.id));
    const selectedCompData=nonEnded.filter(c=>S.bulkSelectedComps.includes(c.id));
    setSafeHtml(overlay, `<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="bulk-assign-title">
      <div class="picker-modal-head">
        <h3 id="bulk-assign-title">Step 2: Confirm Assignment</h3>
      </div>
      <div class="bulk-assign-section">
        <h4 class="bulk-assign-section-title">Participants (${selectedUsers.length})</h4>
        <div class="bulk-assign-summary bulk-assign-summary-scroll">
          ${selectedUsers.map(p=>`<div>${esc(p.first_name)} ${esc(p.last_name)} &lt;${esc(p.email)}&gt;</div>`).join('')}
        </div>
      </div>
      <div class="bulk-assign-section">
        <h4 class="bulk-assign-section-title">Events (${selectedCompData.length})</h4>
        <div class="bulk-assign-summary">
          ${selectedCompData.map(c=>isLateEntryOpen(c)
            ?`<div><strong>${esc(c.name)}</strong> - late entry open until ${fmtDt(c.late_entry_deadline_effective,'long')}</div>`
            :`<div><strong>${esc(c.name)}</strong> - ${fmtDt(c.start_time,'long')}</div>`).join('')}
        </div>
        ${selectedCompData.some(isLateEntryOpen)?'<p class="picker-note" style="margin-top:6px">An event that has ended but is still taking late entries admits everyone you add here as a <strong>late entrant</strong> — ranked in its separate Late entrants section until the late-entry deadline.</p>':''}
      </div>
      ${S.bulkSelectedGroups.length?`<div class="bulk-assign-section">
        <h4 class="bulk-assign-section-title">Groups bound (${S.bulkSelectedGroups.length})</h4>
        <div class="bulk-assign-summary">${allGroups.filter(g=>S.bulkSelectedGroups.includes(g.id)).map(g=>`<div><strong>${esc(g.name)}</strong> — ${g.member_count} member(s), live-synced</div>`).join('')}</div>
      </div>`:''}
      <p class="picker-note">&#x2709; An invitation email will be sent to each participant.</p>
      <div class="picker-modal-foot">
        <button class="btn secondary" data-action="overlay-close" data-overlay-id="bulk-assign-overlay">Cancel</button>
        <button class="btn secondary" data-action="bulk-assign-back">Back</button>
        <button class="btn" data-action="bulk-assign-execute">Confirm &amp; Send Invitations</button>
      </div>
    </div>`);
  }

  window.renderBulkAssign=()=>{if(S.bulkAssignStep===1)renderStep1();else renderStep2();};

  window.bulkAssignNext=()=>{
    const checks=document.querySelectorAll('#bulk-comp-list input[type="checkbox"]:checked');
    S.bulkSelectedComps=Array.from(checks).map(c=>c.value);
    if(!S.bulkSelectedComps.length){showToast('Select at least one event.');return;}
    S.bulkAssignStep=2;
    renderBulkAssign();
  };

  window.executeBulkAssign=async()=>{
    const res=await fetchWithLoading('/api/admin/competitions/assign',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({userIds:Array.from(S.selectedParticipants),competitionIds:S.bulkSelectedComps,groupIds:S.bulkSelectedGroups})});
    if(!res)return;
    if(res.r.ok){
      const d=res.d;
      let msg=`Assigned ${d.assigned||0} user(s). ${d.emailsSent||0} email(s) sent.`;
      // v8.12.6 — name the events that took people through their late-entry window.
      const _lateIds=Array.isArray(d.lateEntryCompetitionIds)?d.lateEntryCompetitionIds:[];
      if(_lateIds.length){
        const _names=nonEnded.filter(c=>_lateIds.includes(c.id)).map(c=>`“${c.name}”`);
        msg+=` Anyone added to ${_names.length?_names.join(', '):'an event that has ended'} joined as a late entrant.`;
      }
      msg+=_assignSkipNote(d);
      _showSkippedAuthorsModal(d);
      if(d.groupsBound)msg+=` ${d.groupsBound} group binding(s).`;
      if(d.revived&&d.revived.length)msg+=` Revived: ${d.revived.join(', ')}.`;
      // ext-audit v7.15.15 — the assignment is committed; these two flags mean
      // work is still finishing in the background, so the counts are a floor.
      if(d.emailsDeferred)msg+=' Some emails are still sending — that count is not final.';
      if(d.membersDeferred)msg+=' Group membership is still syncing in the background.';
      showToast(msg,(d.emailsDeferred||d.membersDeferred)?'info':undefined);
      document.getElementById('bulk-assign-overlay')?.remove();
      S.selectedParticipants.clear();
      loadAdminParticipants();loadAdminCompetitions();
    }else{showToast(res.d.error||'Assignment failed.');}
  };

  renderStep1();
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
}

// ── v8.1.0 — THE DESK FALLBACK, on the admin's own screen ────────────────────
//
// `showParticipantCode` is the row action; `deskInvite` creates a walk-up who is
// not in the system yet. Both end the same way: a code the organiser reads out.
//
// The code is shown ONCE and never stored client-side. It is a live credential —
// a narrow, deliberate carve-out from "no production response ever contains
// one" — and the justification is that without it the rule is a lockout: the
// person who can fix a greylisted first contact is standing three feet from the
// person who has the problem.
export async function showParticipantCode(userId, nickname) {
  let d;
  try {
    const r = await fetch(`/api/admin/participants/${encodeURIComponent(userId)}/login-code/reveal`, {
      method: 'POST', headers: csrfHeaders({ 'Content-Type': 'application/json' }), body: '{}',
    });
    d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(d.error || 'Could not create a sign-in code.', 'error'); return; }
  } catch (_) { showToast('Could not reach the server.', 'error'); return; }
  await _showCodeDialog(nickname || 'this participant', d.code, d.expires_in_minutes);
}

/**
 * Create a walk-up at the desk and hand over their code in one step.
 *
 * Scoped to the FOCUSED competition when there is one, because at a stand that
 * is the event the organiser is running — and an account created with no event
 * is a person who still cannot do anything.
 */
export async function deskInvite() {
  // Sweep #501: while approval is required, a role that cannot approve accounts
  // cannot sign anyone up here; the button is static markup, so the reason is
  // spoken on the press (its title says it too).
  if (deskApprovalWithheld()) { showToast(DESK_APPROVAL_REASON, 'error'); return; }
  // v8.12.0 — the desk shortcut enrols into the FOCUSED event, and that is a
  // competitor door: say so before asking for an address the server would
  // refuse (the button is static markup, so the reason is spoken here).
  const _focus = S.adminSelectedCompetitionId ? (S.adminCompetitionsData || []).find(c => c.id === S.adminSelectedCompetitionId) : null;
  if (_focus && _focus.competing) {
    // An EVENT ADMIN's desk shortcut is refused with no event at all
    // (event_admin_competition_required), so the first remedy is not theirs to
    // take — an instruction that is not true is worse than none.
    showToast(`You are competing in “${_focus.name}”, so you cannot add people to it. ${S.isEventAdmin ? 'Open another of your events, or ask another organiser.' : 'Open People from the sidebar to add somebody with no event, or ask another organiser.'}`, 'error');
    return;
  }
  // v8.12.6 — a FINISHED focus that is not taking late entries refuses the desk
  // (409), so say so before asking for an address the server would refuse — the
  // button is static markup, which is why the reason is spoken here, as the
  // competing branch above does. One still taking late entries is admitted, and
  // the person joins it as a late entrant (said in the prompt and the code dialog).
  if (_focus && !compAcceptsNewMembers(_focus)) {
    showToast(`“${_focus.name}” has finished and is not taking late entries, so nobody can be added to it. ${S.isEventAdmin ? 'Open another of your events.' : 'Open another event, or People from the sidebar to add somebody with no event.'}`, 'error');
    return;
  }
  const _deskLate = !!(_focus && isLateEntryOpen(_focus));
  const _deskDeadline = _deskLate && _focus.late_entry_deadline_effective ? fmtDt(_focus.late_entry_deadline_effective, 'long') : '';
  // `showPrompt` takes no message body, so the explanation rides the label —
  // matching its real signature rather than one I assumed.
  const email = await showPrompt({
    title: 'Add someone at the desk',
    label: 'Work email — creates the account and shows a sign-in code straight away, with no email sent'
      + (_deskLate ? `. They join “${_focus.name}” as a late entrant${_deskDeadline ? ` and can play until ${_deskDeadline}` : ''}` : ''),
    placeholder: 'name@company.com',
    confirmText: 'Create and show code',
  });
  if (!email || !String(email).trim()) return;
  let d;
  try {
    const r = await fetch('/api/admin/participants/desk-invite', {
      method: 'POST', headers: csrfHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: String(email).trim(), competitionId: S.adminSelectedCompetitionId || undefined }),
    });
    d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(d.error || 'Could not add that person.', 'error'); return; }
  } catch (_) { showToast('Could not reach the server.', 'error'); return; }
  // v8.12.6 — keyed on the SERVER's `lateEntry`, not on the focus: it is the
  // answer to what the route actually did with this account.
  const _lateLine = d.lateEntry && _focus
    ? `They joined <strong>${esc(_focus.name)}</strong> as a <strong>late entrant</strong>${_deskDeadline ? ` and can play until <strong>${esc(_deskDeadline)}</strong>` : ''}.`
    : '';
  await _showCodeDialog(d.nickname || d.email, d.code, d.expires_in_minutes, _lateLine);
  loadAdminParticipants();
}

/** One dialog for both, so the two paths cannot describe the code differently. */
async function _showCodeDialog(who, code, minutes, extraHtml = '') {
  await showModal({
    title: 'Sign-in code',
    message: `Read this out to <strong>${esc(who)}</strong>. They type their address on the sign-in screen, `
      + `press <strong>Continue</strong> and enter it in the box that opens.<br><br>`
      + `<div class="desk-code">${esc(code || '')}</div>`
      + `<p class="desk-code-note">Works once, for ${esc(_codeLifeLabel(minutes))}. `
      + `Asking for another replaces this one.</p>`
      + (extraHtml ? `<p class="desk-code-note">${extraHtml}</p>` : ''),
    confirmText: 'Done',
    cancelText: null,
  });
}

/**
 * v8.1.3 — say how long the code ACTUALLY has, not the headline TTL.
 *
 * The window is anchored to the FIRST code minted for that account and a
 * re-issue deliberately does not move it, so on the scenario this whole feature
 * exists for — the emailed code greylisted, the attendee arriving at the desk
 * eight minutes later — the honest answer is two minutes, not ten. This used to
 * render a flat `minutes || 10`, so the admin read out a code they believed had
 * ten minutes on it and the attendee met a generic "may have expired" three
 * minutes later, with nothing on either screen pointing at the TTL.
 *
 * NO `|| 10` DEFAULT: that is what turned the most urgent case into the most
 * relaxed-sounding one. An absent field means we were not told, and saying so
 * vaguely beats inventing the largest possible number. There is deliberately no
 * "less than a minute" branch — the server floors the value at 1 (lib/login-code:
 * "expires in 0 minutes" reads as already dead, and the holder is about to type
 * it), so a branch for 0 would be dead code that reads as coverage.
 */
function _codeLifeLabel(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 1) return 'a short time';
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}
