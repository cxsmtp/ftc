"use strict";

// ── THE EVENT WORKSPACE ──────────────────────────────────────────────────────
//
// Every event runs as a campaign with its own workspace: a record header (kind,
// live status, schedule, organisers, the join card), a KPI band, and the event's
// own sections — Overview, Participants, Challenges, Rankings, Activity,
// Analytics, Certificates, Settings. Organisers (event admins, admins and
// superadmins) run the whole lifecycle from inside it.
//
// WHAT IT IS UNDER THE HOOD. "Which event is open" is `S.adminSelectedCompetitionId`
// (and `S.adminSelectedTimeslotId` for one session) — the same two keys every
// admin loader already narrows on. The workspace replaced the old "focus an
// event" chips and the scope switcher: there is no way to narrow a cross-event
// page any more, only to OPEN an event, and every sidebar page closes it again
// (ui/nav.js adminTab). The server is untouched: every request is the one the
// scoped panes always sent, and the server still decides what the actor may do.
//
// The pieces this module owns:
//   • open / close / section switch, and the sidebar + tab-strip state;
//   • the record header (#ws-record) and KPI band (#ws-kpis), rendered on
//     EXPLICIT changes, and the header (with the tab counts and the open
//     section) again on the status strip's 1 s tick only when what it shows has
//     changed — the live countdown and session controls are the 1 s status strip
//     (#admin-scope-banner, competitions-admin.js);
//   • the join card (reveal is audited server-side, so it is never automatic);
//   • the Overview, Settings and Certificates panes;
//   • the phone section sheet; the clone and save-as-template dialogs.

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonList, fetchJsonObject } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc, fmtDt, eventKindLabel, eventKindChipHtml, DRY_RUN_TAG, policyOrDefault, NO_FIXED_DEADLINE, eventEndText } from "../ui/format.js";
import { ICO, DIFF_PTS } from "../ui/icons.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { wallClockToUtcChecked, dstGapMessage } from "../data/country-tz.js";
import { copyText } from "../ui/clipboard.js";
import { downloadBlob } from "../ui/download.js";
import { renderLoadFailure } from "../ui/list-controls.js";
import { isQualifyingTask } from "../ui/task-search.js";   // the one qualifying test
import { adminTab, adminPaneLoaders, workspaceHooks, adminCan, deskApprovalWithheld, DESK_APPROVAL_REASON } from "../ui/nav.js";
import { computeCompStatus, COMP_CATEGORY_LABEL, isLateEntryOpen, compAcceptsNewMembers } from "./competition-picker.js";
import { setAdminCompetitionScope, setAdminTimeslotScope, clearAdminCompetitionScope, _compEffectiveBounds, loadAdminCompetitions } from "./competitions-admin.js";
import { pStatus, renderParticipants } from "./participants-admin.js";
import { _ensureQrLib, _renderQrInto, joinQrDataUri } from "./self-enroll.js";
import { renderCertificateWizard, renderIssuedCertificates } from "./certificate-wizard.js";
import { eventLookCardHtml, eventLookFormState, eventLookShown, setEventLookForm } from "./look-admin.js";

const OVERVIEW = 'admin-event-overview-tab';
const SECTION_LABELS = {
  'admin-event-overview-tab': 'Overview',
  'admin-participants-tab': 'Participants',
  'admin-tasks-tab': 'Questions',
  'admin-rankings-tab': 'Rankings',
  'admin-submissions-tab': 'Activity',
  'admin-analytics-tab': 'Analytics',
  'admin-event-certs-tab': 'Certificates',
  'admin-event-team-tab': 'Team & reports',   // features/event-team.js registers its loader
  'admin-event-settings-tab': 'Settings',
};
// RBAC — the permission each section's first read asks for (lib/rbac.js
// ADMIN_ROUTE_PERMISSIONS), as the sidebar's ADMIN_NAV_PERMISSIONS does for the
// cross-event pages: a section the role cannot read is not offered (its tab, the
// phone section sheet and the command palette's "Go to" all read the tab strip).
const SECTION_PERMISSIONS = {
  'admin-event-overview-tab': 'events.view',
  'admin-participants-tab': 'participants.view',
  'admin-tasks-tab': 'challenges.view',
  'admin-rankings-tab': 'leaderboard.view',
  'admin-submissions-tab': 'audit.view',
  'admin-analytics-tab': 'analytics.view',
  'admin-event-certs-tab': 'certificates.view',
  'admin-event-team-tab': 'events.view',
  'admin-event-settings-tab': 'events.view',
};
/** May this role open the workspace section `tabId`? */
export function wsSectionOffered(tabId) {
  const perm = SECTION_PERMISSIONS[tabId];
  return !perm || adminCan(perm);
}

// Per-open caches. Cleared whenever a different event opens or the workspace
// closes, so nothing one event revealed is ever painted on another.
let _join = null;        // {compId, data} — the revealed join link/code
let _organisers = null;  // {compId, list|null}
let _pulse = null;       // {compId, data|null, failed} — GET …/overview-pulse
let _pulseSeq = 0;
let _certs = null;       // {compId, data|null, at} — GET …/certificates, an ended event's summary
let _lastRecordHtml = '';
let _openSeq = 0;
// What the Overview has opened in place, for the event that is open.
let _ovUi = _freshOvUi(null);
// The figure each KPI tile last showed ("<compId>:<key>"), so a change counts
// from it and flashes.
const _kpiShown = new Map();
// A figure still counting up or flashing: `${compId}:${kpi}` → { from, to, t0, flash }.
const _kpiAnim = new Map();
// The roster the Overview's lines last drew (`_paintPulse`): { compId, n }.
let _linesRoster = null;
// The events model reload a live read that disagreed with it asked for.
let _rosterReload = null;

function _freshOvUi(compId) {
  return { compId, detail: false, tasks: false, orgs: false, openTasks: new Set(), ratePct: new Map(), chartPainted: false, tickerSeen: null };
}

function _comp() {
  const id = S.adminSelectedCompetitionId;
  return id ? (S.adminCompetitionsData || []).find(c => c.id === id) || null : null;
}

function _resetCaches(compId) {
  if (_join && _join.compId !== compId) _join = null;
  if (_organisers && _organisers.compId !== compId) _organisers = null;
  if (_pulse && _pulse.compId !== compId) _pulse = null;
  if (_certs && _certs.compId !== compId) _certs = null;
  if (_ovUi.compId !== compId) _ovUi = _freshOvUi(compId);
}

/** Registered once from boot(): nav.js calls these without importing us. */
export function initEventWorkspace() {
  workspaceHooks.close = (opts) => closeEventWorkspace(opts);
  workspaceHooks.adminNavBuilt = () => refreshApprovalSetting();
  workspaceHooks.sync = (tabId) => _syncSection(tabId);
  adminPaneLoaders.set('admin-event-overview-tab', () => loadEventOverview());
  adminPaneLoaders.set('admin-event-settings-tab', () => loadEventSettings());
  adminPaneLoaders.set('admin-event-certs-tab', () => loadEventCertificates());
  // The Overview's challenge list and the pending-approval counts read the
  // Challenges and People models; repaint those parts when either lands. A
  // session change reloads the events model: the open section follows it.
  document.addEventListener('admin:model-loaded', (e) => {
    const c = _comp();
    if (!c) return;
    if (e.detail === 'tasks') { _renderOverviewTasks(c); _paintReady(c); }
    if (e.detail === 'participants') { _lastRecordHtml = ''; _renderRecord(c); _renderOverviewAttn(c); }
    if (e.detail === 'competitions') _syncOpenSection(c);
  });
  // Regenerate (self-enroll.js) rotated the join link: the revealed link, code
  // and QR this workspace holds stopped working at that instant.
  document.addEventListener('admin:join-link-rotated', (e) => _joinRotated(e.detail || {}));
}

/**
 * Open an event's workspace. From the Events list, a template spawn, a clone or
 * a create it lands on Overview; re-opening the event already open (the status
 * strip's "All sessions") keeps the section the organiser is on.
 *
 * An event the events model does not hold yet (a link from a report email,
 * opened before the list has loaded) is read first: opened without its row, the
 * workspace would have no name (so no status strip and no ← Events) and every
 * pane loader would find no event to paint.
 */
export function openEventWorkspace(compId, compName, opts = {}) {
  if (!compId) return;
  if (!_rowOf(compId)) { _openWhenKnown(compId, opts, () => openEventWorkspace(compId, compName, opts)); return; }
  const same = S.adminSelectedCompetitionId === compId;
  _resetCaches(compId);
  _openSeq++;
  const name = compName || _rowOf(compId).name || '';
  const renders = !same || !!opts.tab;
  _openingScope(renders, () => setAdminCompetitionScope(compId, name));
  if (renders) wsTab(opts.tab || OVERVIEW);
}

/** Open one SESSION of an event (a session chip on the Events list or a People
 *  row). `opts.tab` names the section to land on when the event was not open. */
export function openEventWorkspaceSession(compId, compName, tsId, tsName, opts = {}) {
  if (!compId) return;
  if (!_rowOf(compId)) { _openWhenKnown(compId, opts, () => openEventWorkspaceSession(compId, compName, tsId, tsName, opts)); return; }
  const same = S.adminSelectedCompetitionId === compId;
  _resetCaches(compId);
  _openingScope(!same, () => setAdminTimeslotScope(compId, compName || _rowOf(compId).name || '', tsId, tsName));
  if (!same) wsTab(opts.tab || OVERVIEW);
}

// An open that renders its section itself (the wsTab after the scope change)
// must not have the scope change's header render (`syncWorkspaceChrome` →
// `_syncOpenSection`) render it first: the section on screen is still the
// previous event's, so its signature differs and it would be rebuilt for the
// new event once before the open's own render, and each render reads the pulse
// and the certificates card.
let _openRendersSection = false;
function _openingScope(renders, change) {
  _openRendersSection = renders;
  try { change(); } finally { _openRendersSection = false; }
}

function _rowOf(compId) { return (S.adminCompetitionsData || []).find(c => c.id === compId) || null; }

// Read the events model until it holds the event (at most twice: a load already
// in flight can supersede ours and land without writing), then open it. An event
// the actor cannot see, or one deleted meanwhile, says so and opens nothing.
async function _openWhenKnown(compId, opts, reopen) {
  const seq = ++_openSeq;
  for (let i = 0; i < 2 && !_rowOf(compId); i++) await loadAdminCompetitions({ keepPage: true });
  if (seq !== _openSeq) return;          // another open (or a close) since
  if (!_rowOf(compId)) {
    showToast('That event could not be opened: it may have been deleted, or you do not organise it.', 'error');
    return;
  }
  reopen();
}

/**
 * Leave the workspace. `silent` (from the sidebar, which is about to show its
 * own page) only clears the event; otherwise the Events list is shown.
 */
export function closeEventWorkspace(opts = {}) {
  _join = null; _organisers = null; _pulse = null; _certs = null; _lastRecordHtml = '';
  _ovUi = _freshOvUi(null); _kpiShown.clear(); _kpiAnim.clear(); _linesRoster = null; ++_pulseSeq; ++_orgSearchSeq; ++_openSeq;
  _ovPaintedSig = ''; _wasOpen = false;
  _forgetLookCard();
  document.getElementById('ws-qr-full')?.remove();
  _closing = true;
  try { if (S.adminSelectedCompetitionId) clearAdminCompetitionScope(); }
  finally { _closing = false; }
  _closeSectionSheet();
  if (!opts.silent) {
    const ev = document.querySelector('.admin-nav-item[data-tab-id="admin-competitions-tab"]');
    adminTab(ev, 'admin-competitions-tab');
  }
}

// `closeEventWorkspace` is clearing the event itself; any other clear (the open
// event was deleted from its ⋯ menu, or vanished from the events model) leaves
// the workspace from `syncWorkspaceChrome`.
let _closing = false;
let _wasOpen = false;

/** Switch to one of the workspace's sections, keeping the event. */
export function wsTab(tabId) {
  if (!S.adminSelectedCompetitionId) return;
  // A section the role cannot read is never opened, whoever asks (a cross-pane
  // link, the palette): the workspace stays on its Overview.
  if (!wsSectionOffered(tabId)) tabId = OVERVIEW;
  const btn = document.querySelector(`#ws-tabs [data-section="${tabId}"]`);
  _closeSectionSheet();
  adminTab(btn, tabId, { keepEvent: true });
}

function _syncSection(tabId) {
  const open = !!S.adminSelectedCompetitionId;
  document.querySelectorAll('#ws-tabs .ws-tab').forEach(b => {
    const on = open && b.dataset.section === tabId;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const ws = document.getElementById('admin-workspace');
  if (ws) ws.dataset.section = tabId;
  const nm = document.getElementById('ws-section-name');
  if (nm) nm.textContent = SECTION_LABELS[tabId] || 'Overview';
  // The participants pane's two-way scope chips exist only inside a workspace.
  _syncParticipantScopeChips();
}

// ── Chrome: record header + KPI band ─────────────────────────────────────────

/**
 * Show or hide the workspace and render its static chrome. Called by
 * renderScopeBanner on every EXPLICIT render (an open, an action, the poll's
 * category change, a tab return). The 1 s tick goes through `wsFlushHeldRecord`
 * instead, which repaints only what changed, so the join card's QR and the
 * quick-action menu are not rebuilt every second.
 */
export function syncWorkspaceChrome() {
  const ws = document.getElementById('admin-workspace');
  if (!ws) return;
  const open = !!S.adminSelectedCompetitionId;
  ws.hidden = !open;
  document.getElementById('admin-page')?.classList.toggle('ws-open', open);
  _syncParticipantScopeChips();
  if (!open) {
    _lastRecordHtml = '';
    // The event was cleared from OUTSIDE the workspace while one of its sections
    // was on screen (deleted from the ⋯ menu, or gone from the events model):
    // leave for the Events list, as ← Events does, rather than keep a section
    // whose header has gone and whose controls name an event that is no more.
    if (_wasOpen && !_closing) closeEventWorkspace();
    _wasOpen = false;
    return;
  }
  _wasOpen = true;
  // RBAC — only the sections this role may read are offered (inline display:
  // `.ws-tab` sets its own display, which would beat the `hidden` attribute).
  document.querySelectorAll('#ws-tabs .ws-tab').forEach(b => { b.style.display = wsSectionOffered(b.dataset.section) ? '' : 'none'; });
  const c = _comp();
  if (!c) return;
  _resetCaches(c.id);
  _renderRecord(c);
  _renderKpis(c);
  _renderTabCounts(c);
  if (!_organisers) _loadOrganisers(c.id);
  _syncOpenSection(c);
}

// The section tabs' counts. Read from the events model, which the 15 s poll
// reloads. The Participants count is the roster, every member its section
// lists (organisers included): the same figure as the KPI band's Joined
// (`_joinedCount`).
function _renderTabCounts(c) {
  const pc = document.getElementById('ws-count-participants');
  const pv = c.participant_count != null ? String(c.participant_count) : '';
  if (pc && pc.textContent !== pv) pc.textContent = pv;
  const tc = document.getElementById('ws-count-tasks');
  const tv = c.task_count != null ? String(c.task_count) : '';
  if (tc && tc.textContent !== tv) tc.textContent = tv;
}

// ── Keeping the open section current ─────────────────────────────────────────
//
// The Overview's face and the Settings facts are built from the event's state.
// An act (Start now, End now, a session's Start now / End now, Close late
// entries, an Edit settings save) reloads the events model, and the clock moves
// an event from upcoming to live to ended on its own. Either way the section on
// screen must follow, or it keeps offering a control for an act already done.
// `_syncOpenSection` is asked on every explicit header render, on the status
// strip's 1 s tick (`wsFlushHeldRecord`) and on the 15 s poll; it repaints only
// when what the section shows has changed, and never under an open dialog (the
// dialog hands focus back to a control a repaint would replace: the next tick
// carries the repaint out once it has gone).

// What the Overview's face is built from (never the live figures, which the
// pulse repaints in place).
function _ovSignature(c) {
  const m = _ovMode(c);
  const slots = (c.timeslots || []).map(ts => [ts.id, ts.name, ts.start_time, ts.duration_minutes, ts.ended_at || '', computeCompStatus(ts)]);
  return JSON.stringify([c.id, m.status, m.late, m.ranked, m.sessionsMany, m.walkUps, !!c.competing, top3Offered(c), c.task_count ?? 0, (c.tags || []).includes(DRY_RUN_TAG), slots]);
}
let _ovPaintedSig = '';

function _dialogOpen() {
  return _headerDialogOpen() || !!(window._modalEscStack && window._modalEscStack.length);
}

// Returns true when it rebuilt the Overview (which then reads its own pulse).
function _syncOpenSection(c) {
  c = c || _comp();
  if (!c || _dialogOpen() || _openRendersSection) return false;
  const shown = (id) => document.getElementById(id)?.style.display === 'block';
  if (shown(OVERVIEW) && document.getElementById('ws-overview') && _ovSignature(c) !== _ovPaintedSig) { loadEventOverview(); return true; }
  // The roster moved under an Overview whose state did not (`_syncRoster`).
  if (shown(OVERVIEW) && document.getElementById('ws-overview')) _syncRoster(c);
  if (shown('admin-event-settings-tab')) loadEventSettings();
  return false;
}

function _scheduleText(c) {
  // fmtDt is the one date formatter (CLAUDE.md, Date/time formatting). An
  // open-ended Program's end reads "No fixed deadline" (the server's
  // `open_ended`; operator ruling, 14 Nov 2026).
  const b = _compEffectiveBounds(c);
  return `${fmtDt(new Date(b.start), 'long')} – ${eventEndText(c, new Date(b.end), 'long')}`;
}

function _organiserText() {
  if (!_organisers || !_organisers.list) return '';
  const names = _organisers.list.map(a => [a.first_name, a.last_name].filter(Boolean).join(' ') || a.nickname || a.email).filter(Boolean);
  // Nobody yet: say nothing here (the Overview's Organisers card says it, with
  // the control that adds one) rather than a sentence floating in the meta row.
  if (!names.length) return '';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

function _renderRecord(c) {
  const competing = !!c.competing;
  const slots = c.timeslots || [];
  const isDry = (c.tags || []).includes(DRY_RUN_TAG);
  // The status chip is the live strip's (#admin-scope-banner, which ticks);
  // these chips are the static ones beside it.
  const chips = `${eventKindChipHtml(c.event_kind)}${isDry ? '<span class="ws-chip ws-chip-dry">Test / dry run</span>' : ''}${competing ? `<span class="ws-chip ws-chip-competing">${ICO.lock} You are competing</span>` : ''}`;
  // Line 2, muted: when, how many sittings, who runs it. No figures the KPI
  // band already shows (joined, challenges).
  const facts = [
    `<span class="ws-fact">${esc(_scheduleText(c))}</span>`,
    slots.length ? `<span class="ws-fact">${slots.length} session${slots.length === 1 ? '' : 's'}</span>` : '',
    _organiserText() ? `<span class="ws-fact">Run by ${esc(_organiserText())}</span>` : '',
  ].filter(Boolean).join('<span class="ws-facts-sep" aria-hidden="true">·</span>');
  // ONE primary action (Invite, which holds both ways of adding people: an
  // email invitation and a sign-up at the desk), the approval queue only while
  // somebody waits, and everything else in ⋯. Each is offered from its route's
  // predicate (the server re-checks every one): a competitor gets none of the
  // writes, an ended event no roster changes outside its late window.
  const canRoster = wsInviteOffered(c);
  // Approve opens the event's Participants section on the waiting people.
  const pending = adminCan('participants.approve') && adminCan('participants.view') ? wsPendingCount(c.id) : 0;
  const q = [];
  if (canRoster) q.push(`<button type="button" class="btn ws-invite-btn" data-action="kebab-toggle" aria-label="Invite — add people to ${esc(c.name)}">${ICO.userPlus} Invite ${ICO.chevronDown}</button><div class="kebab-menu">${wsInviteItemsHtml(c)}</div>`);
  if (pending > 0) q.push(`<button type="button" class="btn secondary" data-action="ws-review-pending">${ICO.userCheck} Approve <span class="ws-badge" aria-label="${pending} waiting">${pending}</span></button>`);
  q.push(`<button type="button" class="btn secondary ws-more-btn" data-action="kebab-toggle" aria-label="More actions for ${esc(c.name)}">${ICO.more}<span class="ws-more-label">More</span></button><div class="kebab-menu">${wsMenuItemsHtml(c)}</div>`);
  const joinHtml = _joinPillHtml(c);
  const html = `${chips}|${esc(c.name)}|${facts}|${q.join('')}|${joinHtml}`;
  if (html === _lastRecordHtml) return;
  // A dialog that hands focus back to a header control (the ⋯ menu's confirms,
  // the alerts, the session warning) is open: painting now would replace the
  // very control it returns to. HOLD the render; the status strip's 1 s tick
  // carries it out once the dialog has gone (`wsFlushHeldRecord`).
  if (_headerDialogOpen()) { _recordHeld = true; return; }
  _recordHeld = false;
  _lastRecordHtml = html;
  const rec = document.getElementById('ws-record');
  const prev = rec && rec.contains(document.activeElement) && !document.activeElement.closest('#admin-scope-banner') ? document.activeElement : null;
  const set = (id, v) => { const el = document.getElementById(id); if (el) setSafeHtml(el, v); };
  set('ws-rec-chips', chips);
  const t = document.getElementById('ws-title'); if (t) t.textContent = c.name;
  set('ws-facts', facts);
  // The buttons and the ⋯ trigger stay the SAME nodes when only the menu's
  // items changed (an act from the menu changes exactly that), so focus and a
  // dialog's opener stay attached.
  const quick = document.getElementById('ws-quick');
  const btnsHtml = `${q.slice(0, -1).join('')}|${c.name}`;
  if (quick && quick._btnsHtml === btnsHtml && quick.querySelector('.ws-more-btn + .kebab-menu')) {
    setSafeHtml(quick.querySelector('.ws-more-btn + .kebab-menu'), wsMenuItemsHtml(c));
  } else if (quick) {
    setSafeHtml(quick, q.join(''));
    quick._btnsHtml = btnsHtml;
  }
  set('ws-join', joinHtml);
  if (_join && _join.compId === c.id && _join.data) _paintQr();
  if (prev && !prev.isConnected) _refocusHeaderControl(prev);
}

let _recordHeld = false;

function _headerDialogOpen() {
  return !!document.getElementById('modal-overlay')?.classList.contains('open')
    || !!document.getElementById('admin-alert-overlay')
    || !!document.getElementById('session-warn-overlay');
}

/**
 * The status strip's 1 s tick: carry out a header render held for a dialog, and
 * keep the header's offers and the open section in step with the event's state
 * — the clock moves an event from upcoming to live to ended without any act,
 * and some acts reload only the events model. Each part repaints only when what
 * it shows has changed, so the tick costs a comparison when nothing moved.
 */
export function wsFlushHeldRecord() {
  const c = _comp();
  if (_recordHeld && !_headerDialogOpen()) {
    _recordHeld = false;
    if (c) _lastRecordHtml = '';
  }
  if (!c) return;
  _renderRecord(c);
  _renderTabCounts(c);
  _syncOpenSection(c);
}

// After a repaint replaced the focused header control: the same control in the
// new header (same data-action and event), else the ⋯ trigger, which every
// header state has. Never <body>; `preventScroll`, as the strip's rule.
function _refocusHeaderControl(prev) {
  const act = prev.getAttribute('data-action');
  let sel = act ? `#ws-record [data-action="${CSS.escape(act)}"]` : '';
  const id = prev.getAttribute('data-comp-id');
  if (sel && id !== null) sel += `[data-comp-id="${CSS.escape(id)}"]`;
  const next = (sel && document.querySelector(sel)) || document.querySelector('#ws-quick .ws-more-btn');
  if (next) next.focus({ preventScroll: true });
}

/**
 * The header's Invite: offered while the event takes new members (live,
 * upcoming, or ended with its late-entry window open: the invite dialog lists
 * exactly those), the viewer does not compete in it, and the role may invite
 * (`participants.enrol`, the route's permission of both its choices). The ONE
 * predicate for every door that stands for it (the header button, its two
 * choices, the command palette).
 */
export function wsInviteOffered(c) {
  return !!c && compAcceptsNewMembers(c) && !c.competing && adminCan('participants.enrol');
}

/**
 * The header Invite's two choices (owner's decision, 27 Nov 2026: ONE control
 * for adding people, where the header's Invite, the ⋯ menu's "Sign up at the
 * desk" and the Participants section's Invite and At the desk were four doors to
 * two acts). Both take `wsInviteOffered`; the desk sign-up is withheld WITH THE
 * REASON while approval is required and this role cannot approve the account it
 * would make (sweep #501).
 */
export function wsInviteItemsHtml(c) {
  if (!wsInviteOffered(c)) return '';
  const id = esc(c.id), nm = esc(c.name);
  const desk = deskApprovalWithheld()
    ? `<div class="kebab-note" role="presentation">${ICO.lock} ${esc(DESK_APPROVAL_REASON)}</div>`
    : `<button data-action="desk-invite" data-comp-id="${id}" data-comp-name="${nm}">${ICO.userCheck} Sign up at the desk</button>`;
  return `<button data-action="ws-invite" data-comp-id="${id}" data-comp-name="${nm}">${ICO.send} Email invitation</button>${desk}`;
}

/**
 * The header's ⋯ menu: every event door in ONE place (the people doors are the
 * header's Invite), in the order organisers reach for them, read-only doors
 * next, and the irreversible ones LAST, quiet (`km-danger`) and each behind its
 * own confirm. The Events-row menu (`compMenuItemsHtml`) keeps only Delete
 * event, with this menu's predicate, locked equal by
 * tests/menu-door-parity.spec.js; the server re-checks every door.
 */
export function wsMenuItemsHtml(c) {
  const status = computeCompStatus(c);
  const competing = !!c.competing;
  const late = isLateEntryOpen(c);
  const id = esc(c.id), nm = esc(c.name);
  // RBAC — every door also asks the permission of the route it ends at
  // (ui/nav.js adminCan): the built-in roles answer exactly as before, and a
  // custom role is offered only what its routes will do. The command palette
  // lists these items, so it inherits every gate.
  const canEdit = !competing && !endedEditLocked(c) && adminCan('events.edit');
  const b = (action, icon, label, extra = '') => `<button data-action="${action}" data-comp-id="${id}" data-comp-name="${nm}"${extra}>${icon} ${esc(label)}</button>`;
  const items = [];
  if (competing) items.push(`<div class="kebab-note" role="presentation">${ICO.lock} You are competing in this event — you can view it, not change it</div>`);
  // Stage B — no Add from bank here: the event's one door into the bank is its
  // Questions section's + Add from bank (owner ruling, 27 Nov 2026).
  if (!competing && adminCan('events.clone')) items.push(b('ws-clone', ICO.copy, 'Clone'));
  // The full export needs `export.data` (the route's permission).
  if (!competing && adminCan('export.data')) items.push(b('ws-export-zip', ICO.download, 'Export everything'));
  if ((status === 'live' || status === 'ended') && adminCan('export.data')) items.push(b('comp-export-activity', ICO.download, 'Export activity (CSV)'));
  // `templates.manage`, which the built-in event admin does not hold (the
  // server tells them "You can clone your own event instead"). Withheld from a
  // competitor as Clone is, by the same `!competing` and with the menu's note
  // as the reason: the route refuses them `competitor_cannot_edit`.
  if (!competing && adminCan('templates.manage')) items.push(b('ws-save-template', ICO.save, 'Save as template'));
  if ((status !== 'ended' || late) && adminCan('events.join_link')) items.push(b('comp-self-enroll', ICO.link, 'Join-link settings'));
  if (canEdit) items.push(b('comp-edit', ICO.edit, 'Edit settings'));
  items.push(b('comp-history', ICO.clock, 'History'));
  // No Organisers item: the Overview's Organisers card is the one place for
  // who runs the event (owner's decision, 27 Nov 2026).
  items.push(b('comp-delivery', ICO.mailCheck, 'Email delivery'));
  if (status === 'upcoming' && !(c.timeslots || []).length && !competing && adminCan('events.edit')) items.push(b('comp-start-now', ICO.play, 'Start now'));
  const danger = [];
  // From the SERVER's flag (the route's own predicate plus the competitor lock)
  // and the role's permission.
  if (c.can_close_late_entries && adminCan('events.run')) danger.push(b('comp-close-late-entries', ICO.hourglass, 'Close late entries now', ' class="km-danger"'));
  if (status === 'live' && !competing && adminCan('events.run')) danger.push(b('comp-end-now', ICO.stop, 'End now', ' class="km-danger"'));
  if (adminCan('events.delete') && !competing) danger.push(b('comp-delete', ICO.trash, 'Delete event', ' class="km-danger"'));
  if (danger.length) items.push('<div class="km-sep" role="separator"></div>', ...danger);
  return items.join('');
}

/**
 * Is an edit to this event refused for this admin because it has ended? Only a
 * superadmin changes an event whose effective end has passed: the event PUT's
 * rule and the certificate design routes' (`certificate_config_ended_locked`).
 * An event ended early by End Now whose scheduled end is still ahead is not
 * locked (`effective_end` in the future).
 */
export function endedEditLocked(c) {
  if (!c || computeCompStatus(c) !== 'ended' || S.isSuperAdmin) return false;
  return !(c.effective_end && new Date(c.effective_end) > new Date());
}

/** What a walk-up meets after joining by the link, in one sentence. Never the
 *  approval setting: a sign-up through a join link, QR or event code is approved
 *  whatever it says (operator ruling, 3 Nov 2026), so "they wait" would be false. */
// What a walk-up does, the same for every event: there is no "instant join"
// switch any more (operator ruling, 14 Nov 2026) — every sign-up confirms its
// email with a code, and a join-link sign-up is never held for approval.
const _JOIN_RULE_TEXT = 'Walk-ups confirm their email with a code, then join at once.';

function _span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 2 * 1440) return `${Math.floor(m / 1440)} days`;
  if (m >= 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return m <= 1 ? 'under a minute' : `${m} min`;
}

function _renderKpis(c) {
  const el = document.getElementById('ws-kpis');
  if (!el) return;
  const status = computeCompStatus(c);
  const b = _compEffectiveBounds(c);
  const now = Date.now();
  const m = _ovMode(c);
  let timeLabel, timeVal, timeSub, pct = null;
  // A coarse figure ("5 h 40 min"): the band is repainted on changes, not every
  // second — the exact countdown is the status strip's. Live, a bar shows how
  // much of the event has gone.
  if (status === 'upcoming') { timeLabel = 'Starts in'; timeVal = _span(b.start - now); timeSub = fmtDt(new Date(b.start), 'long'); }
  else if (status === 'live' && c.open_ended === true) {
    // An open-ended Program (the server's `open_ended`; operator ruling, 14 Nov
    // 2026): the same tile, saying so, with no countdown to its placeholder
    // deadline ten years out and no bar of how much of that has gone.
    timeLabel = 'Deadline'; timeVal = NO_FIXED_DEADLINE;
    timeSub = `started ${fmtDt(new Date(b.start), 'long')}`;
  }
  else if (status === 'live') {
    timeLabel = m.deadline ? 'Until the deadline' : 'Time left';
    timeVal = _span(b.end - now);
    timeSub = `${m.deadline ? 'closes' : 'ends'} ${fmtDt(new Date(b.end), 'long')}`;
    const span = b.end - b.start;
    pct = span > 0 ? Math.max(0, Math.min(1, (now - b.start) / span)) : null;
  }
  else if (m.late) {
    // One statement, not a bare date over "open until …" (QA P3).
    timeLabel = 'Late entry'; timeVal = 'Open';
    timeSub = c.late_entry_deadline_effective ? `Late entry open until ${fmtDt(c.late_entry_deadline_effective, 'long')}` : 'Late entry open';
  }
  else { timeLabel = 'Ended'; timeVal = fmtDt(new Date(b.end), 'short'); timeSub = m.ranked ? 'the results are final' : ''; }
  const p = _pulseData(c);
  const pt = p ? p.totals : null;
  const pending = c.competing ? _COMPETING_OFF_PAGE : 'counting…';
  // Each tile answers a question the organiser asks in THIS state; nothing the
  // cards below repeat, and no sub-line that only restates a zero.
  const tiles = [{ key: 'time', label: timeLabel, text: timeVal, sub: timeSub, hero: true, pct }];
  if (status === 'live') tiles.push({ key: 'active', label: 'Playing now', n: pt ? pt.active_now : null, sub: pt ? 'answered in the last 5 minutes' : pending });
  // Joined is the roster, from the events model: shown at once, never "—"
  // while the live figures load (`_joinedCount`).
  tiles.push({ key: 'joined', label: 'Joined', n: _joinedCount(c),
    sub: status === 'ended' ? '' : (c.self_enroll_enabled ? 'walk-ups can join' : 'by invitation') });
  if (status === 'upcoming') {
    // Scoring challenges only, and only once the pulse has read them: no
    // "all published" about challenges nobody has looked at.
    const scoring = _scoringTasks(c);
    const tasksN = scoring ? scoring.length : null;
    const unready = scoring ? scoring.filter(_notVisible).length : 0;
    tiles.push({ key: 'tasks', label: 'Challenges', n: tasksN, text: '—',
      sub: scoring === null ? pending : (!tasksN ? 'none yet' : (unready ? `${unready} not visible yet` : 'all published')) });
  } else if (m.ranked && pt && pt.answers > 0) {
    // Only once there are answers: a zero here says nothing the attention row
    // and the progress card do not already say.
    tiles.push({ key: 'answers', label: 'Answers', n: pt.answers,
      sub: `${pt.correct} correct · ${Math.round((pt.correct / pt.answers) * 100)}%` });
  }
  el.dataset.tiles = String(tiles.length);
  // A figure is two spans: the one that counts (aria-hidden, so a screen reader
  // never meets a number in mid-count) and the final value for assistive tech.
  setSafeHtml(el, tiles.map(t => {
    const num = t.n != null && Number.isFinite(t.n);
    const val = num
      ? `<span class="ws-count" data-kpi="${esc(t.key)}" data-count="${esc(String(t.n))}" aria-hidden="true">${esc(String(t.n))}</span><span class="sr-only">${esc(String(t.n))}</span>`
      : `<span class="ws-kpi-text">${esc(t.text ?? '—')}</span>`;
    const dot = t.hero && status === 'live' ? '<span class="ws-dot live" aria-hidden="true"></span>' : '';
    const bar = t.pct != null ? `<span class="ws-kpi-bar" aria-hidden="true"><span class="ws-kpi-bar-fill" data-pct="${t.pct.toFixed(4)}"></span></span>` : '';
    const sub = t.sub ? `<p class="ws-kpi-sub">${esc(t.sub)}</p>` : '';
    return `<div class="ws-kpi${t.hero ? ' ws-kpi-hero' : ''}" data-kpi-tile="${esc(t.key)}"><p class="eyebrow">${dot}${esc(t.label)}</p><p class="bignum ws-kpi-num">${val}</p>${bar}${sub}</div>`;
  }).join(''));
  el.querySelectorAll('.ws-kpi-bar-fill').forEach(f => f.style.setProperty('--pct', f.dataset.pct));
  _animateKpis(el, c.id);
}

/** What the Overview shows, from the event's STATE and its wire policy keys —
 *  never its kind literal (CLAUDE.md "Asking the policy"). */
function _ovMode(c) {
  const status = computeCompStatus(c);
  const late = status === 'ended' && isLateEntryOpen(c);
  const pol = policyOrDefault(c.policy);
  return {
    status, late,
    ranked: pol.ranking_enabled !== false,
    sessionsMany: pol.sessions === 'many',
    deadline: pol.schedule === 'deadline',
    walkUps: !!c.self_enroll_enabled && (status !== 'ended' || late),
  };
}

// ── Live figures: count-up, flash on change ──────────────────────────────────
//
// Each figure counts from what its tile last showed (0 on the first paint of an
// event) and its tile flashes when a poll moves it. Reduced motion: the final
// value at once, no flash. requestAnimationFrame only — no timer of its own.

function _reducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (_) { return false; }
}

function _animateKpis(el, compId) {
  const calm = _reducedMotion();
  el.querySelectorAll('.ws-count').forEach(span => {
    const key = `${compId}:${span.dataset.kpi}`;
    const to = Number(span.dataset.count);
    // The band is rebuilt whole on every paint (a roster repaint, then a live
    // read's answer a moment later): a figure still counting or flashing
    // towards the same value carries its motion onto the new tile, so a change
    // is still seen to change.
    const run = _kpiAnim.get(key);
    if (!calm && run && run.to === to && performance.now() - run.t0 < KPI_MOTION_MS) {
      _countUp(span, run.from, to, run.t0);
      if (run.flash) _flashTile(span, performance.now() - run.t0);
      return;
    }
    const had = _kpiShown.has(key);
    const from = had ? _kpiShown.get(key) : 0;
    _kpiShown.set(key, to);
    if (calm || from === to || !Number.isFinite(from)) { _kpiAnim.delete(key); span.textContent = String(to); return; }
    _kpiAnim.set(key, { from, to, t0: performance.now(), flash: had });
    _countUp(span, from, to);
    if (had) _flashTile(span);
  });
}

// The longer of the count-up and the flash (`.ws-kpi-flash`, 1.2 s).
const KPI_MOTION_MS = 1200;

// A carried flash goes on from where the replaced tile's had reached
// (`elapsedMs`), never from the start again.
function _flashTile(span, elapsedMs = 0) {
  const tile = span.closest('.ws-kpi');
  if (!tile) return;
  if (elapsedMs > 0) tile.style.animationDelay = `-${Math.round(elapsedMs)}ms`;
  tile.classList.add('ws-kpi-flash');
  tile.addEventListener('animationend', () => { tile.classList.remove('ws-kpi-flash'); tile.style.animationDelay = ''; }, { once: true });
}

function _countUp(span, from, to, t0 = performance.now()) {
  const dur = 700;
  const at = (t) => {
    const k = Math.min(1, Math.max(0, (t - t0) / dur));
    return Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
  };
  span.textContent = String(at(performance.now()));
  const step = (t) => {
    if (!span.isConnected) return;
    span.textContent = String(at(t));
    if (t - t0 < dur) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Join pill + QR popover ───────────────────────────────────────────────────
//
// The header carries the join link as ONE pill: "HWN-F7N ▦" once revealed. Its
// popover holds the QR (the event code printed in its centre, lib/qr.js level
// H via POST /api/admin/join-qr), Copy link, Full-screen QR and the settings.
// Revealing ships the event's join secret and is recorded on its History, so
// it happens on a click, never on opening the workspace.

let _joinOpen = false;

function _joinPillHtml(c) {
  const status = computeCompStatus(c);
  if (status === 'ended' && !isLateEntryOpen(c)) return '';
  // RBAC — every press of the pill reads or changes the join link (`events.join_link`).
  if (!adminCan('events.join_link')) return '';
  const grid = `<span class="ws-join-ico" aria-hidden="true">${ICO.grid}</span>`;
  if (!c.self_enroll_enabled) {
    return `<button type="button" class="ws-join-pill is-off" data-action="comp-self-enroll" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}" aria-label="Join link off — open join-link settings">Join link off ${grid}</button>`;
  }
  const d = _join && _join.compId === c.id ? _join.data : null;
  if (!d) {
    return `<button type="button" class="ws-join-pill" data-action="ws-join-reveal" aria-haspopup="dialog" aria-expanded="false" aria-label="Join code — show the code and QR">Join code ${grid}</button>`;
  }
  const code = d.join_code_display || '';
  const site = String(d.url || '').replace(/^https?:\/\//, '').replace(/\/join\/.*/, '/join');
  const open = _joinOpen;
  const note = _JOIN_RULE_TEXT;
  return `<button type="button" class="ws-join-pill is-on" data-action="ws-join-toggle" aria-haspopup="dialog" aria-expanded="${open}" aria-controls="ws-join-pop" aria-label="${esc(code)} — join code and QR">${esc(code)} ${grid}</button>
    <div id="ws-join-pop" class="ws-join-pop" role="dialog" aria-label="Join this event"${open ? '' : ' hidden'}>
      <div class="ws-qr" id="ws-qr" role="img" aria-label="QR code for the join link, with the code ${esc(code)} in its centre"></div>
      <p class="ws-jcode">${esc(code)}</p>
      <p class="ws-join-note">${esc(site)} · ${esc(note)} <span data-help="ws.join" data-help-label="Join code"></span></p>
      <div class="ws-join-actions"><button type="button" class="btn sm" data-action="ws-join-copy">${ICO.copy} Copy link</button><button type="button" class="btn sm secondary" data-action="ws-join-full">${ICO.maximize} Full-screen QR</button></div>
      <button type="button" class="link-btn ws-join-settings" data-action="comp-self-enroll" data-comp-id="${esc(c.id)}" data-comp-name="${esc(c.name)}">Join-link settings</button>
    </div>`;
}

export async function wsJoinReveal() {
  const c = _comp();
  if (!c) return;
  const seq = _openSeq;
  const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(c.id)}/self-enroll`);
  if (seq !== _openSeq || S.adminSelectedCompetitionId !== c.id) return;
  if (!d || !d.url) { showToast('Could not load the join link.', 'error'); return; }
  _join = { compId: c.id, data: d, svg: null };
  _setJoinOpen(true);
  document.querySelector('#ws-join-pop [data-action="ws-join-copy"]')?.focus();
}

/** The pill toggles its popover; Escape and a click outside close it. */
export function wsJoinToggle() { _setJoinOpen(!_joinOpen); }

// Regenerate rotated the event's link and code (`admin:join-link-rotated`, from
// self-enroll.js with the new link): the revealed copy, its QR (the code is in
// its centre) and a full-screen QR on the stand's screen all carry the dead
// ones. The new link replaces them at once — the organiser has just seen it in
// the dialog — and a full-screen QR showing the old one is closed.
function _joinRotated(d) {
  if (!d.compId || !_join || _join.compId !== d.compId) return;
  if (d.url) _join = { compId: d.compId, data: { ..._join.data, url: d.url, join_code_display: d.join_code_display || '' }, svg: null };
  else _join = null;
  document.getElementById('ws-qr-full')?.remove();
  const c = _comp();
  if (!c || c.id !== d.compId) return;
  _lastRecordHtml = '';
  _renderRecord(c);
  _paintJoinCard(c);
}

function _setJoinOpen(open) {
  const c = _comp();
  _joinOpen = !!open;
  if (!c) return;
  _lastRecordHtml = '';
  _renderRecord(c);
  _paintJoinCard(c);
  if (_joinOpen) _armJoinClose();
}

function _armJoinClose() {
  const onDoc = (e) => {
    const box = document.getElementById('ws-join');
    if (!_joinOpen) return off();
    if (e.type === 'keydown') {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      off(); _setJoinOpen(false);
      document.querySelector('#ws-join .ws-join-pill')?.focus();
      return;
    }
    if (box && box.contains(e.target)) return;
    off(); _setJoinOpen(false);
  };
  const off = () => { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onDoc, true); };
  // Armed after this click finishes, so the opening click cannot close it.
  setTimeout(() => { if (_joinOpen) { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onDoc, true); } }, 0);
}

/** The join QR as an SVG data URI, rendered once per reveal (self-enroll.js
 *  `joinQrDataUri`: the one way to the centred-code encoder). */
async function _joinQrSrc() {
  if (!_join) return null;
  if (_join.svg) return _join.svg;
  const mine = _join;
  const src = await joinQrDataUri(_join.data.url, _join.data.join_code_display);
  if (!src || _join !== mine) return null;
  mine.svg = src;
  return mine.svg;
}

function _qrImg(src, alt) {
  const img = document.createElement('img');
  img.src = src; img.alt = alt; img.decoding = 'async';
  img.className = 'ws-qr-img';
  return img;
}

async function _paintQr() {
  const el = document.getElementById('ws-qr');
  if (!el || !_join || !_joinOpen) return;
  const src = await _joinQrSrc();
  const now = document.getElementById('ws-qr');
  if (!now) return;
  if (!src) {
    // Fall back to the plain QR (no centre label) the dialog has always drawn.
    try { await _ensureQrLib(); _renderQrInto(now, _join.data.url); } catch (_) { now.textContent = 'QR unavailable'; }
    return;
  }
  now.replaceChildren(_qrImg(src, ''));
}

export async function wsJoinCopy() {
  if (!_join) return;
  const ok = await copyText(_join.data.url);
  showToast(ok ? 'Join link copied.' : 'Could not copy — open Join link settings and copy it from there.', ok ? 'success' : 'error');
}

/** A full-screen QR for the stand's screen: code, QR, address. Escape closes. */
export async function wsJoinFull() {
  const c = _comp();
  if (!c || !_join) return;
  document.getElementById('ws-qr-full')?.remove();
  const ov = document.createElement('div');
  ov.id = 'ws-qr-full';
  ov.className = 'ws-qr-full';
  ov.setAttribute('data-stage', '');
  setSafeHtml(ov, `<div class="ws-qr-full-box" role="dialog" aria-modal="true" aria-labelledby="ws-qr-full-title">
    <p class="eyebrow">Scan to join</p>
    <h3 id="ws-qr-full-title" class="ws-qr-full-title">${esc(c.name)}</h3>
    <div class="ws-qr-full-code" id="ws-qr-full-qr"></div>
    <p class="ws-jcode ws-qr-full-jcode">${esc(_join.data.join_code_display || '')}</p>
    <p class="ws-join-note">${esc(String(_join.data.url || '').replace(/^https?:\/\//, '').replace(/\/join\/.*/, '/join'))}</p>
    <button type="button" class="btn" data-action="ws-join-full-close">Close</button>
  </div>`);
  document.body.appendChild(ov);
  overlayDismiss(ov, () => ov.remove());
  const box = document.getElementById('ws-qr-full-qr');
  const src = await _joinQrSrc();
  if (src && box) box.replaceChildren(_qrImg(src, `QR code for the join link, with the code ${_join.data.join_code_display || ''} in its centre`));
  else if (box) {
    try { await _ensureQrLib(); _renderQrInto(box, _join.data.url); }
    catch (_) { box.textContent = 'QR unavailable — copy the link instead.'; }
  }
  // Close takes focus without scrolling to it: on a screen too short for the
  // whole block, moving to the button at its foot opened the QR scrolled past
  // "Scan to join" and the event's name.
  ov.querySelector('[data-action="ws-join-full-close"]')?.focus({ preventScroll: true });
}

// ── Organisers / pulse (lazy reads) ───────────────────────────────────────────────────────────────────────────

async function _loadOrganisers(compId) {
  const mine = { compId, list: null, failed: false };
  _organisers = mine;
  const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(compId)}/admins`);
  // Only the read that is still current may write: a newer one owns the card.
  if (_organisers !== mine) return;
  // A failed read is a failure, never "nobody organises this" (CLAUDE.md:
  // a failed read is null, never an empty list).
  if (d && Array.isArray(d.admins)) mine.list = d.admins; else mine.failed = true;
  const c = _comp();
  if (c && c.id === compId) { _lastRecordHtml = ''; _renderRecord(c); }
  if (S.adminSelectedCompetitionId === compId) _paintOrganisersCard();
}

function _paintOrganisersCard() {
  const ov = document.getElementById('ws-ov-orgs');
  if (!ov) return;
  const c = _comp();
  const more = document.getElementById('ws-ov-orgs-more');
  // Hidden up front for the no-list paths, but never while it has focus:
  // hiding the pressed toggle would drop focus to <body>.
  if (more && document.activeElement !== more) more.hidden = true;
  if (_organisers && _organisers.failed) {
    renderLoadFailure('ws-ov-orgs', { noun: 'organisers', retryAction: 'ws-organisers-retry' });
    return;
  }
  setSafeHtml(ov, _organisersListHtml(c));
  const n = _organisers && _organisers.list ? _organisers.list.length : 0;
  if (more && n > ORGS_SHOWN) _syncMore(more, _ovUi.orgs, _ovUi.orgs ? 'Show fewer' : `Show ${n - ORGS_SHOWN} more`);
  else if (more) more.hidden = true;
}

/** The Organisers card's "Try again" after a failed read. */
export function wsOrganisersRetry() {
  const c = _comp();
  if (!c) return;
  _organisers = null;
  _paintOrganisersCard();
  _loadOrganisers(c.id);
}

// Never for a competitor: an organiser who starts competing while watching
// keeps the read made before, which must not stay on the band beside the
// sentence that the live figures are kept off the page.
function _pulseData(c) {
  return c && !c.competing && _pulse && _pulse.compId === c.id ? _pulse.data : null;
}

// WHILE THE VIEWER COMPETES, the Overview keeps the LIVE figures off its page
// (the pulse refuses a competitor, routes/event-overview.js) and says only that:
// the event's other reads — Analytics, Rankings, Activity, Certificates — stay
// open to them, so nothing here may claim the figures are hidden from them
// (operator ruling, 14 Nov 2026).
const _COMPETING_OFF_PAGE = 'kept off this page while you compete';

// The event's SCORING challenges as the pulse reads them: a qualifying question
// scores nothing and never counts toward finishing, so it makes no event ready
// to play. null while there is no pulse (loading, a failed read, or a
// competitor, who is never sent it): then nothing is claimed about them.
function _scoringTasks(c) {
  const p = _pulseData(c);
  return p ? (p.tasks || []).filter(t => !t.qualifying) : null;
}
function _notVisible(t) { return t.status !== 'published' || !t.active; }

// HOW MANY HAVE JOINED: everyone enrolled, organisers and staff included — the
// events model's roster count, the figure the Events list and the Participants
// tab show (operator ruling, 14 Nov 2026). The band's Joined, the attention
// row, the checklist and the chart's empty state read it, so it is known at
// once, never waits for the pulse, and a competitor (never sent the pulse)
// reads it too. The pulse's own `joined` is a LIVE figure: where staff do not
// compete it leaves out staff and the roles the boards leave out, as the other
// live figures do; it stays Progress's "of N" and the activity chart's Joins
// and summary (operator ruling, 14 Nov 2026).
function _joinedCount(c) {
  return Number(c.participant_count || 0);
}

// The events model reloads on the poll, after the header's Invite or a save of
// the event form, and when the browser tab comes back; the Overview's parts
// otherwise repaint only when a live read answers. `_syncOpenSection` (the
// strip's 1 s tick and the poll) calls this: the band is repainted when the
// Joined it last drew (`_kpiShown`) is not the model's roster, and the lines
// that read the roster (`_paintPulse`) when the roster THEY last drew is not,
// each tracked apart, since an explicit render of the band (`_renderKpis`)
// leaves the lines as they were.
function _syncRoster(c) {
  const key = `${c.id}:joined`;
  if (_kpiShown.has(key) && _kpiShown.get(key) !== _joinedCount(c)) _renderKpis(c);
  if (_linesRoster && _linesRoster.compId === c.id && _linesRoster.n !== _joinedCount(c)) _paintPulse(c);
}

// GET …/overview-pulse — the KPI band's live figures, the chart, the feed and
// the solve rates. Never asked for an event the organiser competes in (the
// route refuses it). A failed refresh keeps the last figures and says so.
async function _loadPulse(compId) {
  const c = _comp();
  if (!c || c.id !== compId || c.competing) return;
  const seq = ++_pulseSeq;
  const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(compId)}/overview-pulse`);
  if (seq !== _pulseSeq || S.adminSelectedCompetitionId !== compId) return;
  if (d && d.ok === true && Array.isArray(d.buckets) && d.totals) _pulse = { compId, data: d, failed: false };
  else if (_pulse && _pulse.compId === compId && _pulse.data) _pulse.failed = true;
  else _pulse = { compId, data: null, failed: true };
  const cc = _comp();
  if (!cc || cc.id !== compId) return;
  _renderKpis(cc);
  _paintPulse(cc);
  _renderOverviewTasks(cc);
  _reloadModelIfBehind(cc);
}

// A read whose roster (`enrolled`) is not the events model's saw someone join
// or leave since the model loaded (the workspace opened just after a join, say):
// the model is reloaded at once, once per read, so Joined and the lines that
// read the roster catch up at the next tick (`_syncRoster`), not the next poll.
function _reloadModelIfBehind(c) {
  // Only a read that answered can be newer than the model: a failed one keeps
  // the last good read, which the poll's own model has already overtaken.
  if (!_pulse || _pulse.failed) return;
  const d = _pulseData(c);
  const enrolled = d && d.totals ? d.totals.enrolled : undefined;
  if (!Number.isFinite(enrolled) || enrolled === _joinedCount(c) || _rosterReload) return;
  _rosterReload = Promise.resolve().then(() => loadAdminCompetitions()).catch(() => {}).finally(() => { _rosterReload = null; });
}

/** The live parts' "Try again" after a failed read. A failed first read starts
 *  again from "Loading…"; a failed refresh keeps the last figures on screen
 *  (with their notice) until the new read lands. */
export function wsPulseRetry() {
  const c = _comp();
  if (!c) return;
  if (!_pulse || _pulse.compId !== c.id || !_pulse.data) { _pulse = null; _paintPulse(c); }
  _loadPulse(c.id);
}

/**
 * The workspace's existing 15 s events poll (competitions-admin.js
 * startAdminCompPoll) calls this after each load: the Overview's live parts
 * re-read while it is the section on screen, and nothing runs otherwise — no
 * timer of its own, so leaving the workspace or the Overview stops it.
 */
export async function refreshOverviewLive() {
  const c = _comp();
  if (!c) return;
  // The poll has just reloaded the events model: the tab counts and the open
  // section follow it whatever the section (a hidden tab included — it costs a
  // comparison, and the counts are right when the tab returns).
  _renderTabCounts(c);
  if (_syncOpenSection(c)) return;
  if (document.hidden) return;
  if (document.getElementById(OVERVIEW)?.style.display !== 'block') return;
  if (!document.getElementById('ws-ov-chart')) return;
  // A live read's answer repaints the band on each poll; a competitor is never
  // sent one, so their band (its time tile above all) is repainted here.
  if (c.competing) _renderKpis(c);
  await Promise.all([
    _loadPulse(c.id),
    // An ended event's certificates card: re-read while a dispatcher job is
    // due to run, else once its last read is a minute old.
    computeCompStatus(c) === 'ended' ? _loadCerts(c.id, { poll: true }) : null,
  ]);
}

/**
 * Read the platform's approval setting, which GET /api/admin/me carries for every
 * admin tier (GET /api/admin/settings refuses an event admin). Approval controls
 * then show only while the setting is on or somebody is actually waiting.
 */
export async function refreshApprovalSetting() {
  const d = await fetchJsonObject('/api/admin/me');
  if (!d) return;
  const was = S.requireAccountApproval;
  S.requireAccountApproval = d.require_account_approval === true;
  if (was !== S.requireAccountApproval && (S.adminParticipantsData || []).length) renderParticipants();
}

/** People in this event waiting for an organiser's approval. */
export function wsPendingCount(compId) {
  return (S.adminParticipantsData || []).filter(p => pStatus(p) === 'pending' && (p.competitions || []).some(x => x.id === compId)).length;
}

// ── Participants scope (members / everyone) ──────────────────────────────────

function _syncParticipantScopeChips() {
  const box = document.getElementById('p-ws-scope');
  if (!box) return;
  const open = !!S.adminSelectedCompetitionId;
  box.hidden = !open;
  // Its "?" tip is a sibling of the label (never inside it, which would join the
  // checkbox's name), so it follows the label's visibility here.
  const tip = document.getElementById('p-ws-scope-help');
  if (tip) tip.hidden = !open;
  box.querySelectorAll('[data-action="p-ws-scope"]').forEach(b => {
    const on = (b.dataset.scope === 'all') === !!S.pWsShowEveryone;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

export function setParticipantWsScope(scope) {
  S.pWsShowEveryone = scope === 'all';
  S.pPage = 1;
  _syncParticipantScopeChips();
  renderParticipants();
}

/** The Approve quick action: Participants, Pending only. */
export function wsReviewPending() {
  wsTab('admin-participants-tab');
  const pend = document.querySelector('#p-status-filters [data-value="pending"]');
  if (pend && !pend.classList.contains('active')) pend.click();
}

// ── Overview ─────────────────────────────────────────────────────────────────
//
// A command centre built around what the organiser does in the next five
// minutes, decided by the event's STATE (upcoming / live / ended) and its wire
// policy keys — never its kind literal:
//   • upcoming — "is everything ready?": a short checklist whose every open item
//     carries the existing control that fixes it (or points at the header's);
//   • live     — the attention row (who waits, which challenge nobody solves,
//     what participants cannot see) under the countdown, then progress (how
//     many finished, solved challenge by challenge — never a leaderboard: the
//     organiser acts on who is stuck, and the board lives in Rankings), the
//     feed while it has something to say, and the join QR for walk-ups;
//   • ended    — the final progress and whether the certificates went out
//     (Download top 3 certificates on that card).
// Everything else (the challenge set, solve rates, the activity chart, the
// organisers) is ONE "Show …" away, opened in place, never on the face of the
// page. Lists open IN PLACE too (a "Show more" toggle after each list, outside
// the container a repaint replaces, so focus stays on it). Organisers are added
// and removed from their card by the people the route lets do it
// (requireGlobalAdmin, never a competitor).

const TASKS_SHOWN = 6;
const ORGS_SHOWN = 5;

// `help` names a "?" tip (ui/help-tips.js) shown beside the title — a sibling of
// the <h3>, so the heading's own text stays exactly the title. `opts.hideEmpty`
// starts the card hidden (the live feed, until it has something to show).
function _card(title, body, action, help, cls, opts = {}) {
  const extra = opts.hideEmpty ? ' data-hide-empty="1" hidden' : '';
  return `<section class="card ws-card${cls ? ` ${cls}` : ''}"${extra}>${_cardInner(title, body, action, help)}</section>`;
}
// A card's contents, for a card painted in place (Settings' facts and Look).
function _cardInner(title, body, action, help) {
  const head = help
    ? `<div class="help-label-row ws-card-title"><h3>${esc(title)}</h3><span data-help="${esc(help)}" data-help-label="${esc(String(title).split(' · ')[0])}"></span></div>`
    : `<h3>${esc(title)}</h3>`;
  return `<div class="ws-card-head">${head}${action || ''}</div>${body}`;
}

// A list's in-place toggle: always after the list, never inside it.
function _moreBtn(part, controls) {
  return `<button type="button" class="link-btn ws-more-toggle" id="ws-ov-${part}-more" data-action="ws-ov-expand" data-part="${part}" aria-expanded="false" aria-controls="${controls}" hidden></button>`;
}
function _syncMore(btn, expanded, label) {
  btn.hidden = false;
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (btn.textContent !== label) btn.textContent = label;
}

// Paint `html` into `el` only when it changed, keeping focus on the control it
// replaced (matched by `focusSel(activeElement)`).
function _paintKeepingFocus(el, html, focusKey) {
  if (el._wsHtml === html) return false;
  const a = document.activeElement;
  const key = a && el.contains(a) ? focusKey(a) : null;
  setSafeHtml(el, html);
  el._wsHtml = html;
  if (key) { const back = el.querySelector(key); if (back) back.focus(); }
  return true;
}
// The focus key every action-button region shares: the same data-action (and
// target) in the new paint.
function _actionKey(a) {
  const act = a.getAttribute('data-action');
  if (!act) return null;
  const tgt = a.getAttribute('data-target');
  return `[data-action="${CSS.escape(act)}"]${tgt ? `[data-target="${CSS.escape(tgt)}"]` : ''}`;
}

function _detailLabel(open) { return `${open ? 'Hide' : 'Show'} challenges, activity and organisers`; }

// The selector that finds the same control in a rebuilt Overview: its id, else
// its action and the thing it acts on. '' when it has neither (the fallback).
function _ovFocusKey(a) {
  if (a.id) return `#${CSS.escape(a.id)}`;
  const act = a.getAttribute('data-action');
  if (!act) return '';
  let sel = `[data-action="${CSS.escape(act)}"]`;
  for (const k of ['data-ts-id', 'data-task-id', 'data-section', 'data-target', 'data-user-id', 'data-part']) {
    const v = a.getAttribute(k);
    if (v !== null) sel += `[${k}="${CSS.escape(v)}"]`;
  }
  return sel;
}

export async function loadEventOverview() {
  const box = document.getElementById('ws-overview');
  const c = _comp();
  if (!box || !c) return;
  const compId = c.id;
  _resetCaches(compId);
  const m = _ovMode(c);
  const status = m.status;
  const competing = !!c.competing;
  const slots = c.timeslots || [];
  // A card's way into a section is offered only for a section this role may read.
  const openLink = (section, label) => wsSectionOffered(section) ? `<button type="button" class="link-btn ws-open-link" data-action="ws-tab" data-section="${section}">${esc(label)}</button>` : '';
  // RBAC — the session controls are `events.edit` (start, edit, delete, add)
  // and `events.run` (end) routes.
  const canEditTs = !competing && adminCan('events.edit');
  const canRunTs = !competing && adminCan('events.run');

  // Sessions with their own controls (add / edit / delete / start / end): on the
  // face while there are sessions still to run (a session's status IS the
  // event's status there), behind "Show …" otherwise.
  const manyKinds = m.sessionsMany;
  const sessionsOnFace = manyKinds && slots.length > 0 && status !== 'ended';
  let sessions = '';
  if (slots.length || (manyKinds && status !== 'ended' && !competing)) {
    const rows = slots.map(ts => {
      const st = computeCompStatus(ts);
      const s = new Date(ts.start_time);
      const e = ts.ended_at ? new Date(ts.ended_at) : new Date(s.getTime() + ts.duration_minutes * 60000);
      let act = '';
      if (canEditTs && st === 'upcoming') act = `<button type="button" class="btn sm" data-action="ts-start-now" data-comp-id="${esc(compId)}" data-ts-id="${esc(ts.id)}">Start now</button>`;
      if (canRunTs && st === 'live') act = `<button type="button" class="btn sm danger" data-action="ts-end-now" data-comp-id="${esc(compId)}" data-ts-id="${esc(ts.id)}">End now</button>`;
      if (canEditTs && st === 'upcoming') act += ` <button type="button" class="btn sm secondary" data-action="ws-ts-edit" data-comp-id="${esc(compId)}" data-ts-id="${esc(ts.id)}" aria-label="Edit session ${esc(ts.name)}">${ICO.edit}<span class="sr-only">Edit</span></button><button type="button" class="btn sm secondary" data-action="ws-ts-delete" data-comp-id="${esc(compId)}" data-ts-id="${esc(ts.id)}" aria-label="Delete session ${esc(ts.name)}">${ICO.trash}<span class="sr-only">Delete</span></button>`;
      return `<li class="ws-li"><span class="ws-dot${st === 'live' ? ' live' : ''} ws-dot-${st}" aria-hidden="true"></span><span class="ws-li-main"><b>${esc(ts.name)}</b><small>${esc(fmtDt(s, 'long'))} – ${esc(fmtDt(e, 'long'))} · ${esc(COMP_CATEGORY_LABEL[st] || st)}</small></span>${act}</li>`;
    }).join('');
    sessions = _card('Sessions', rows ? `<ul class="ws-list">${rows}</ul>` : '<p class="ws-empty">No sessions: everyone plays in one sitting. Add sessions to run it more than once.</p>',
      manyKinds && status !== 'ended' && canEditTs ? `<button type="button" class="link-btn" data-action="ws-ts-add" data-comp-id="${esc(compId)}">Add session</button>` : '', 'ws.sessions');
  }

  // How far people have got: the completions, and where they are, challenge
  // by challenge. (No leaderboard here: the organiser acts on who is stuck, not
  // on who is leading; the board lives in Rankings.)
  const top3 = top3Offered(c) ? `<button type="button" class="btn sm gold ws-top3-btn" data-action="comp-top3" data-comp-id="${esc(compId)}">${ICO.download} Download top 3 certificates</button>` : '';
  const ratesOnFace = status !== 'upcoming';
  const progress = ratesOnFace
    ? _card('Progress', `<div id="ws-ov-progress"><p class="ws-empty">Loading…</p></div><h4 class="ws-sub-h">Solved, challenge by challenge</h4><div id="ws-ov-rates"><p class="ws-empty">Loading…</p></div>`,
      openLink('admin-analytics-tab', 'Open Analytics'), 'ws.progress', 'ws-progress-card ws-wide')
    : '';
  const rates = ratesOnFace ? '' : _card('Solve rate', '<div id="ws-ov-rates"><p class="ws-empty">Loading…</p></div>', '', 'ws.rates');
  const liveTag = status === 'live' ? '<span class="ws-live-tag"><span class="ws-dot live" aria-hidden="true"></span>Live</span>' : '';
  const feedOnFace = status === 'live';
  const feed = _card('Live feed', '<div id="ws-ov-ticker"><p class="ws-empty">Loading…</p></div>', liveTag, 'ws.feed', 'ws-ticker-card', { hideEmpty: feedOnFace });
  const chart = _card('Activity over time', '<div id="ws-ov-chart"><p class="ws-empty">Loading…</p></div>', '', 'ws.activity', 'ws-chart-card ws-wide');
  // The challenge set (from the Challenges model, which may still be loading),
  // each row opening its key facts in place.
  const tasks = _card(`Challenges · ${c.task_count ?? 0}`, `<div id="ws-ov-tasks"><p class="ws-empty">Loading…</p></div>${_moreBtn('tasks', 'ws-ov-tasks')}`,
    openLink('admin-tasks-tab', 'Open Challenges'), 'ws.challenges');
  // Organisers: the list (Remove per row), its toggle, the outcome line, and the
  // add picker — four siblings, so a repaint of one never takes another's focus.
  const orgs = _card('Organisers', `<div id="ws-ov-orgs">${_organisersListHtml(c)}</div>${_moreBtn('orgs', 'ws-ov-orgs')}<p id="ws-ov-orgs-msg" class="ws-orgs-msg" role="status"></p><div id="ws-ov-orgs-add"></div>`,
    '', 'ws.organisers');
  const ready = _card('Ready to start?', '<div id="ws-ov-ready"><p class="ws-empty">Loading…</p></div>', '', 'ws.ready', 'ws-ready-card ws-wide');
  const certs = !adminCan('certificates.view') ? '' : _card('Certificates', `<div id="ws-ov-certs"><p class="ws-empty">Loading…</p></div>${top3 ? `<div class="ws-card-foot">${top3}</div>` : ''}`, openLink('admin-event-certs-tab', 'Open Certificates'), 'ws.certs', 'ws-certs-card');
  // Its one control reveals the join link (`events.join_link`), as the header's pill does.
  const join = m.walkUps && adminCan('events.join_link') ? _card('Walk-ups', '<div id="ws-ov-join"></div>', '', 'ws.walkups', 'ws-join-card') : '';

  // The face: what the organiser acts on in this state. The rest: one press away.
  const face = [];
  if (status === 'upcoming') face.push(ready, sessionsOnFace ? sessions : '', join);
  else if (status === 'live') face.push(progress, feed, sessionsOnFace ? sessions : '', join);
  else face.push(progress, certs, join);
  const detail = [tasks, rates, chart, feedOnFace ? '' : feed, sessionsOnFace ? '' : sessions, orgs];

  const open = !!_ovUi.detail;
  // A rebuild (an act or the clock moved the event on) can replace the control
  // the organiser is on: focus goes back to the same control in the new face,
  // else to the detail toggle, which every state has — never to <body>.
  const prevFocus = box.contains(document.activeElement) ? _ovFocusKey(document.activeElement) : null;
  // The organiser search (Organisers card) is the one text box here, and a
  // rebuild comes from the clock or another admin's act, never from the
  // organiser: its box — the input with what they typed and the caret, and its
  // results — is carried into the new face rather than drawn again empty.
  const keptAdd = document.querySelector('#ws-ov-orgs-add .ws-org-add');
  const keptInput = keptAdd && keptAdd.querySelector('#ws-org-search');
  const keptFocus = !!keptInput && document.activeElement === keptInput;
  const keptSel = keptFocus ? [keptInput.selectionStart, keptInput.selectionEnd] : null;
  const keep = keptInput && (keptFocus || keptInput.value.trim()) ? keptAdd : null;
  if (keep) keep.remove();
  _ovPaintedSig = _ovSignature(c);
  box.dataset.ovState = status;
  box.dataset.ovRanked = m.ranked ? 'true' : 'false';
  setSafeHtml(box, '<div id="ws-ov-attn" class="ws-ov-attn" role="status"></div>'
    + `<div class="ws-grid ws-cc ws-cc-face">${face.join('')}</div>`
    + `<div class="ws-ov-more-row"><button type="button" class="btn secondary ws-detail-toggle" id="ws-ov-detail-more" data-action="ws-ov-expand" data-part="detail" aria-expanded="${open}" aria-controls="ws-ov-detail"><span class="ws-detail-label">${esc(_detailLabel(open))}</span><span class="ws-chev" aria-hidden="true">${ICO.chevronDown}</span></button></div>`
    + `<div id="ws-ov-detail" class="ws-grid ws-cc ws-cc-detail"${open ? '' : ' hidden'}>${detail.join('')}</div>`);
  if (prevFocus !== null && !(keep && keptFocus)) ((prevFocus && box.querySelector(prevFocus)) || document.getElementById('ws-ov-detail-more'))?.focus({ preventScroll: true });
  _renderOverviewAttn(c);
  _renderOverviewTasks(c);
  _paintPulse(c);
  // The band follows the face it sits on: a new state (the start, the end) and
  // the roster since it was drawn, for a competitor too (never sent the live
  // read whose answer repaints everyone else's).
  _renderKpis(c);
  _paintJoinCard(c);
  _paintCerts(c);
  _paintOrgAdd(c);
  // The carried search box goes where the new one was drawn (none: the actor may
  // no longer add organisers, and the reason stands instead).
  const fresh = keep && document.querySelector('#ws-ov-orgs-add .ws-org-add');
  if (fresh) {
    fresh.replaceWith(keep);
    if (keptFocus) {
      keptInput.focus({ preventScroll: true });
      try { keptInput.setSelectionRange(keptSel[0], keptSel[1]); } catch (_) { /* a type without a caret */ }
    }
  } else if (keep && keptFocus) document.getElementById('ws-ov-detail-more')?.focus({ preventScroll: true });
  // The Organisers card never waits on a read nobody started: a cache cleared
  // since the record header last asked starts one here; a finished one paints.
  if (!_organisers || _organisers.compId !== compId) _loadOrganisers(compId);
  else _paintOrganisersCard();

  await Promise.all([
    _loadPulse(compId),
    status === 'ended' ? _loadCerts(compId) : null,
  ]);
}

/** A list's "Show more / Show fewer" toggle: expands in place, focus stays.
 *  `detail` is the Overview's own: everything off the face of the page. */
export function wsOverviewExpand(part) {
  const c = _comp();
  if (!c || !['tasks', 'orgs', 'detail'].includes(part)) return;
  _ovUi[part] = !_ovUi[part];
  if (part === 'detail') {
    const open = _ovUi.detail;
    const panel = document.getElementById('ws-ov-detail');
    if (panel) panel.hidden = !open;
    const btn = document.getElementById('ws-ov-detail-more');
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const label = btn.querySelector('.ws-detail-label');
      if (label) label.textContent = _detailLabel(open);
    }
    return;
  }
  if (part === 'tasks') _renderOverviewTasks(c);
  else _paintOrganisersCard();
}

/** A challenge row's disclosure: its facts open beneath it, focus stays. */
export function wsTaskFacts(el) {
  const id = el && el.dataset.taskId;
  if (!id) return;
  const open = el.getAttribute('aria-expanded') !== 'true';
  el.setAttribute('aria-expanded', open ? 'true' : 'false');
  const panel = document.getElementById(el.getAttribute('aria-controls') || '');
  if (panel) panel.hidden = !open;
  if (open) _ovUi.openTasks.add(id); else _ovUi.openTasks.delete(id);
  const box = document.getElementById('ws-ov-tasks');
  if (box) box._wsHtml = '';
}

/** "Show me": move focus to the header control that does this (Invite, the
 *  join pill) instead of repeating it on the page. */
export function wsPoint(el) {
  const sel = el && el.dataset.target === 'join' ? '#ws-join .ws-join-pill' : '#ws-quick .ws-invite-btn';
  const t = document.querySelector(sel);
  if (!t) return;
  const calm = _reducedMotion();
  t.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
  t.focus({ preventScroll: true });
  if (calm) return;
  t.classList.remove('ws-pointed');
  void t.offsetWidth;
  t.classList.add('ws-pointed');
  t.addEventListener('animationend', () => t.classList.remove('ws-pointed'), { once: true });
}

// The attention row: only what needs an organiser NOW. Live, it also says so
// when nothing does (one compact line, never an empty card).
function _renderOverviewAttn(c) {
  const el = document.getElementById('ws-ov-attn');
  if (!el) return;
  const m = _ovMode(c);
  const items = [];
  // Approvals — only when somebody is actually waiting. Sign-ups wait only while
  // the platform's approval switch is on, so with it off this never shows.
  const pending = adminCan('participants.approve') && adminCan('participants.view') ? wsPendingCount(c.id) : 0;
  if (pending > 0) {
    items.push(`<div class="ws-attn ws-attn-warn">${ICO.clock}<span><b>${pending} ${pending === 1 ? 'person is' : 'people are'} waiting for approval.</b> They cannot play until an organiser approves them.</span>`
      + '<button type="button" class="btn sm" data-action="ws-review-pending">Review</button></div>');
  }
  const p = _pulseData(c);
  const watching = m.status === 'live' && p && !c.competing;
  // The last refresh failed: every figure on the page is the previous read's,
  // so the first thing on the face says so (and "Nothing needs you" is never
  // claimed from figures that may be stale).
  const stale = !!(p && _pulse.failed);
  if (stale) {
    items.push(`<div class="ws-attn ws-attn-warn ws-attn-stale">${ICO.alertTriangle}<span><b>Could not refresh just now.</b> The live figures on this page are from ${esc(fmtDt(new Date(p.generated_at), 'long'))}.</span>`
      + '<button type="button" class="btn sm secondary" data-action="ws-pulse-retry">Try again</button></div>');
  }
  if (watching) {
    const tasks = p.tasks || [];
    const hidden = tasks.filter(t => t.status !== 'published' || !t.active).length;
    if (hidden) {
      items.push(`<div class="ws-attn ws-attn-warn">${ICO.eyeOff}<span><b>${hidden} ${hidden === 1 ? 'challenge is' : 'challenges are'} not visible to participants.</b> Drafts and hidden challenges are not played.</span>`
        + (wsSectionOffered('admin-tasks-tab') ? '<button type="button" class="btn sm secondary" data-action="ws-tab" data-section="admin-tasks-tab">Open Questions</button>' : '') + '</div>');
    }
    // Nobody ENROLLED (`_joinedCount`, the roster): an organiser playing an
    // event where staff do not compete has joined it, though the live figures
    // leave them out. Never while this read saw someone (`enrolled`): the
    // model is then behind, and is being reloaded (`_reloadModelIfBehind`).
    if (!_joinedCount(c) && !(Number(p.totals && p.totals.enrolled) > 0)) {
      // "Show me" moves focus to the header control, so it is offered only
      // while that control is (the join pill, Invite).
      const showJoin = m.walkUps && adminCan('events.join_link');
      const showInvite = wsInviteOffered(c);
      items.push(m.walkUps
        ? `<div class="ws-attn ws-attn-warn">${ICO.users}<span><b>Nobody has joined yet.</b> Put the join code on screen, or invite people.</span>${showJoin ? '<button type="button" class="btn sm secondary" data-action="ws-point" data-target="join">Show me</button>' : ''}</div>`
        : `<div class="ws-attn ws-attn-warn">${ICO.users}<span><b>Nobody has joined yet.</b> Invite people to take part.</span>${showInvite ? '<button type="button" class="btn sm secondary" data-action="ws-point" data-target="invite">Show me</button>' : ''}</div>`);
    }
    const stuck = tasks.filter(t => t.status === 'published' && t.active && t.attempters > 0 && t.solvers === 0)
      .sort((a, b) => b.attempters - a.attempters);
    if (stuck.length) {
      const names = stuck.slice(0, 2).map(t => `${t.task_number ? `#${t.task_number} ` : ''}${t.title} (${t.attempters} tried)`).join(', ');
      items.push(`<div class="ws-attn ws-attn-info">${ICO.alertTriangle}<span><b>Nobody has solved ${stuck.length === 1 ? 'this challenge' : `${stuck.length} challenges`} yet:</b> ${esc(names)}${stuck.length > 2 ? ` and ${stuck.length - 2} more` : ''}.</span></div>`);
    }
  }
  let html = items.join('');
  if (!html && watching && !stale) html = `<p class="ws-allclear"><span class="ws-allclear-mark" aria-hidden="true">${ICO.check}</span>Nothing needs you right now.</p>`;
  _paintKeepingFocus(el, html, _actionKey);
}

// "Ready to start?" — an upcoming event's checklist. Each open item carries the
// control that fixes it: the ⋯ menu's own doors (Add challenges, Join-link
// settings), the Challenges section, or "Show me" for a header control.
function _paintReady(c) {
  const el = document.getElementById('ws-ov-ready');
  if (!el) return;
  const m = _ovMode(c);
  const competing = !!c.competing;
  const p = _pulseData(c);
  const id = esc(c.id), nm = esc(c.name);
  // One row per check: done (ok), still to do (todo) or optional (info).
  const text = (label, sub) => `<span class="ws-ready-text"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  const ok = (label, sub) => `<li class="ws-ready-item" data-ready="ok"><span class="ws-ready-mark" aria-hidden="true">${ICO.check}</span><span class="sr-only">Ready: </span>${text(label, sub)}`;
  const todo = (label, sub) => `<li class="ws-ready-item" data-ready="todo"><span class="ws-ready-mark" aria-hidden="true">${ICO.alertTriangle}</span><span class="sr-only">To do: </span>${text(label, sub)}`;
  const info = (label, sub) => `<li class="ws-ready-item" data-ready="info"><span class="ws-ready-mark" aria-hidden="true">${ICO.info}</span><span class="sr-only">Optional: </span>${text(label, sub)}`;
  const showMe = (target) => `<button type="button" class="btn sm secondary" data-action="ws-point" data-target="${esc(target)}">Show me</button>`;
  const items = [];
  let open = 0;
  // Scoring challenges only (a qualifying question scores nothing), and a claim
  // only about challenges the pulse has read.
  const scoring = _scoringTasks(c);
  const n = scoring ? scoring.length : 0;
  const unready = scoring ? scoring.filter(_notVisible).length : 0;
  if (!p) {
    if (competing) items.push(`${info('Challenges', 'Whether participants can see them is kept off this page while you compete.')}</li>`);
    else if (_pulse && _pulse.compId === c.id && _pulse.failed) {
      open++;
      items.push(todo('Could not check the challenges', 'Nothing is known about them until the check succeeds.')
        + '<button type="button" class="btn sm secondary" data-action="ws-pulse-retry">Try again</button></li>');
    } else items.push(`${info('Checking the challenges…', '')}</li>`);
  } else if (!n) {
    open++;
    items.push(todo('No challenges yet', 'Participants need at least one to play.')
      + (competing || !adminCan('challenges.assign') || !adminCan('challenges.view') ? '' : `<button type="button" class="btn sm secondary" data-action="ws-add-from-bank">Add from bank</button>`) + '</li>');
  } else if (unready) {
    open++;
    items.push(todo(`${unready} of ${n} challenges are not visible to participants`, 'Drafts and hidden challenges are not played.')
      + (wsSectionOffered('admin-tasks-tab') ? '<button type="button" class="btn sm secondary" data-action="ws-tab" data-section="admin-tasks-tab">Open Questions</button>' : '') + '</li>');
  } else items.push(`${ok(`${n} ${n === 1 ? 'challenge' : 'challenges'} published`, '')}</li>`);
  const canJoinLink = adminCan('events.join_link');
  if (c.self_enroll_enabled) items.push(`${ok('Join link is on', 'Walk-ups join with the event code.')}${canJoinLink ? showMe('join') : ''}</li>`);
  else {
    items.push(info('Join link is off', 'Only people you invite can join.')
      + (competing || !canJoinLink ? '' : `<button type="button" class="btn sm secondary" data-action="comp-self-enroll" data-comp-id="${id}" data-comp-name="${nm}">Join-link settings</button>`) + '</li>');
  }
  // Who has joined: everyone enrolled (`_joinedCount`, the roster), known from
  // the events model, so this line never waits for the pulse.
  const j = _joinedCount(c);
  if (j) items.push(`${ok(`${j} ${j === 1 ? 'person has' : 'people have'} joined`, '')}</li>`);
  else {
    open++;
    items.push(todo('Nobody has joined yet', c.self_enroll_enabled ? 'Invite people, or share the join code.' : 'Invite people to take part.')
      + (wsInviteOffered(c) ? showMe('invite') : '') + '</li>');
  }
  if (m.sessionsMany) {
    const s = (c.timeslots || []).length;
    if (s) items.push(`${ok(`${s} ${s === 1 ? 'session' : 'sessions'} scheduled`, '')}</li>`);
    else {
      items.push(info('One sitting', 'Add sessions to run it more than once.')
        + (competing || !adminCan('events.edit') ? '' : `<button type="button" class="btn sm secondary" data-action="ws-ts-add" data-comp-id="${id}">Add session</button>`) + '</li>');
    }
  }
  const html = `<p class="ws-ready-sum"><b>${items.length - open} of ${items.length}</b> ready</p><ul class="ws-ready">${items.join('')}</ul>`;
  _paintKeepingFocus(el, html, _actionKey);
}

// The Progress card (every kind): how many have finished, how many have started.
function _paintProgress(c) {
  const el = document.getElementById('ws-ov-progress');
  if (!el) return;
  const st = _pulseStateHtml(c, 'ws-ov-progress', 'progress');
  if (st === '') return;
  if (st !== null) { _paintKeepingFocus(el, st, () => null); return; }
  const t = _pulse.data.totals;
  // N is the pulse's `joined`, a live figure (where staff do not compete it
  // leaves out staff and the roles the boards leave out). Who has joined, when
  // there is nobody to count, never contradicts Joined or the live figures:
  // nobody only when the roster and this read's (`enrolled`) are both empty;
  // "only staff…" only when this read saw exactly the roster; otherwise the
  // two disagree (one is older) and Progress waits until they agree.
  const joined = Number(t.joined || 0);
  const roster = _joinedCount(c);
  const enrolled = Number(t.enrolled) || 0;
  if (!roster || !joined) {
    const none = !roster && !enrolled ? 'Nobody has joined yet.'
      : roster && enrolled === roster ? 'Only staff and event admins (or roles like theirs) have joined; they are not counted here.'
      : 'Counting…';
    _paintKeepingFocus(el, `<p class="ws-empty">${esc(none)}</p>`, () => null);
    return;
  }
  const fin = Number(t.finished || 0);
  const pct = Math.round((fin / joined) * 1000) / 10;
  const started = Number(t.solvers || 0);
  const html = `<p class="ws-prog-fig"><span class="bignum ws-prog-num">${esc(String(fin))}</span><span class="ws-prog-of">of ${esc(String(joined))} solved every challenge</span></p>`
    + `<span class="ws-bar-track ws-prog-track" aria-hidden="true"><span class="ws-bar-fill ws-prog-fill" data-pct="${pct}"></span></span>`
    + `<p class="ws-prog-sub">${esc(String(started))} of ${esc(String(joined))} have solved at least one.</p>`;
  if (!_paintKeepingFocus(el, html, () => null)) return;
  const f = el.querySelector('.ws-prog-fill');
  if (f) f.style.setProperty('--pct', String(pct / 100));
}

// The walk-up card: the join code once revealed, and the full-screen QR for the
// stand's screen. Revealing is audited, so it happens on the press.
function _paintJoinCard(c) {
  const el = document.getElementById('ws-ov-join');
  if (!el) return;
  const d = _join && _join.compId === c.id ? _join.data : null;
  const body = d
    ? `<p class="ws-jcode ws-ov-jcode">${esc(d.join_code_display || '')}</p><p class="ws-join-note">${esc(String(d.url || '').replace(/^https?:\/\//, '').replace(/\/join\/.*/, '/join'))}</p>`
    : '<p class="ws-join-note">Put the QR on the stand’s screen: walk-ups scan it and play.</p>';
  _paintKeepingFocus(el, `${body}<div class="ws-join-actions"><button type="button" class="btn sm" data-action="ws-ov-qr">${ICO.maximize} Full-screen QR</button></div>`, _actionKey);
}

/** The walk-up card's Full-screen QR: reveals the join link first if needed. */
export async function wsOverviewQr() {
  const c = _comp();
  if (!c) return;
  if (!_join || _join.compId !== c.id) {
    const seq = _openSeq;
    const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(c.id)}/self-enroll`);
    if (seq !== _openSeq || S.adminSelectedCompetitionId !== c.id) return;
    if (!d || !d.url) { showToast('Could not load the join link.', 'error'); return; }
    _join = { compId: c.id, data: d, svg: null };
    _lastRecordHtml = '';
    _renderRecord(c);
    _paintJoinCard(c);
  }
  await wsJoinFull();
}

// The card shows figures only, so it asks for the counts (`?summary=1`), never
// every row. A successful read is kept a minute; while a dispatcher job is due
// to run, the poll re-reads it on each pass. A failure is never kept: the card
// offers Try again, and the next entry reads.
const CERTS_TTL_MS = 60_000;
let _certsSeq = 0;
// A dispatcher job due within the next few minutes (the five-minute settle after
// an end, plus a minute) or overdue: the poll then re-reads the card before its
// cache is a minute old, so issued certificates show as they go out. A job
// deferred past that — a late entrant's, held to the late-entry deadline, days
// away — is not one: the card keeps its minute-long cache rather than
// re-reading on every poll until then.
const CERTS_DUE_SOON_MS = 6 * 60_000;
function _certsJobDueSoon(pending) {
  const soon = Date.now() + CERTS_DUE_SOON_MS;
  return (pending || []).some(j => { const t = Date.parse(j && j.dueAt); return !Number.isFinite(t) || t <= soon; });
}
// A summary answer the card can paint: every figure it shows is a number.
function _certCountsOk(d) {
  return !!(d && d.counts && ['issued', 'emailed', 'failed'].every(k => Number.isFinite(d.counts[k])));
}

async function _loadCerts(compId, { poll = false } = {}) {
  const c0 = _comp();
  // A competitor reads the counts like any organiser: the certificates read is
  // open to them (operator ruling, 14 Nov 2026, keeping the 14 Sep decision that
  // read-only viewing stays), and the Certificates section lists them anyway.
  if (!c0 || (c0.tags || []).includes(DRY_RUN_TAG) || !adminCan('certificates.view')) return;
  if (_certs && _certs.compId === compId && _certs.data && Date.now() - _certs.at < CERTS_TTL_MS
    && !(poll && _certsJobDueSoon(_certs.data.pending))) { _paintCerts(c0); return; }
  const seq = ++_certsSeq;
  const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(compId)}/certificates?summary=1`);
  if (seq !== _certsSeq || S.adminSelectedCompetitionId !== compId) return;
  if (_certCountsOk(d)) _certs = { compId, data: d, at: Date.now() };
  // A refresh that fails keeps the figures it had; a first read that fails is a failure.
  else if (!(_certs && _certs.compId === compId && _certs.data)) _certs = { compId, data: null, at: 0 };
  const c = _comp();
  if (c) _paintCerts(c);
}

/** The certificates card's "Try again". */
export function wsCertsRetry() {
  const c = _comp();
  if (!c) return;
  _certs = null;
  _paintCerts(c);
  _loadCerts(c.id);
}

// Why the dispatcher issues nothing for an event (the server's
// `automaticRefusal`), in the words the card ends "No certificates issued:" with.
const _CERTS_NOT_AUTOMATIC = {
  email_disabled: "they are not issued automatically while this event's congratulations email is off, so participants collect their own from the event.",
  ended_before_floor: 'this event ended before certificates were issued automatically, so participants collect their own from the event.',
  no_floor: 'certificates are not issued automatically on this installation, so participants collect their own from the event.',
  dry_run: 'this is a test event, which issues no certificates.',
};

// After the end: were the certificates issued and mailed? (Download top 3 sits
// on this card; everything else in the Certificates section.)
function _paintCerts(c) {
  const el = document.getElementById('ws-ov-certs');
  if (!el) return;
  let html;
  if ((c.tags || []).includes(DRY_RUN_TAG)) html = '<p class="ws-empty">A test event issues no certificates.</p>';
  else if (!_certs || _certs.compId !== c.id) html = '<p class="ws-empty">Loading…</p>';
  else if (!_certs.data) {
    // Painted once per failure, so a poll does not replace Try again under the pointer.
    if (el._wsHtml !== '__failed__') { renderLoadFailure('ws-ov-certs', { noun: 'certificates', retryAction: 'ws-certs-retry' }); el._wsHtml = '__failed__'; }
    return;
  } else {
    const d = _certs.data;
    const issued = d.counts.issued;
    const sent = d.counts.emailed;
    const failed = d.counts.failed;
    // The dispatcher decides when it runs, so a job still waiting for an event
    // it will not issue for (`automaticRefusal`) promises nothing: say why
    // instead of "being issued".
    const notAuto = _CERTS_NOT_AUTOMATIC[d.automaticRefusal] || '';
    const issuing = !notAuto && (d.pending || []).length > 0;
    if (!issued) html = `<p class="ws-empty">${issuing ? 'Being issued: they go out a few minutes after the end.' : (notAuto ? esc(`No certificates issued: ${notAuto}`) : 'No certificates issued.')}</p>`;
    else {
      const mail = d.emailEnabled
        ? `${sent} of ${issued} emailed${failed ? ` · ${failed} could not be sent` : ''}`
        : 'The congratulations email is off: holders collect theirs from the event.';
      html = `<p class="ws-prog-fig"><span class="bignum ws-prog-num">${esc(String(issued))}</span><span class="ws-prog-of">issued</span></p>`
        + `<p class="ws-prog-sub">${esc(mail)}</p>`
        + (issuing ? '<p class="ws-prog-sub">More are being issued.</p>' : '');
    }
  }
  _paintKeepingFocus(el, html, () => null);
}

function _taskNum(t, compId) { return ((t.competitions || []).find(x => x.id === compId) || {}).task_number || ''; }
function _cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : ''; }

function _renderOverviewTasks(c) {
  const el = document.getElementById('ws-ov-tasks');
  if (!el) return;
  const more = document.getElementById('ws-ov-tasks-more');
  // Hidden up front for the no-list paths, but never while it has focus:
  // hiding the pressed toggle would drop focus to <body>.
  if (more && document.activeElement !== more) more.hidden = true;
  const status = computeCompStatus(c);
  // The questions the event holds: its own copies (and a row it holds itself). A
  // bank question's entry naming the event's copy (`copy_id`) stands for that copy,
  // which is listed in its own right (lib/event-copies.js): never list both.
  const tasks = (S.adminTasksData || []).filter(t => (t.competitions || []).some(x => x.id === c.id && !x.copy_id));
  const focusKey = a => { const id = a.closest('[data-task-id]')?.dataset.taskId; return id ? `[data-action="ws-task-facts"][data-task-id="${CSS.escape(id)}"]` : null; };
  if (!tasks.length && (c.task_count || 0) > 0) { _paintKeepingFocus(el, '<p class="ws-empty">Loading…</p>', focusKey); return; }
  if (!tasks.length) {
    _paintKeepingFocus(el, `<p class="ws-empty">No challenges yet.${status !== 'ended' && !c.competing ? ' Add some from the library.' : ''}</p>`, focusKey);
    return;
  }
  tasks.sort((a, b) => String(_taskNum(a, c.id)).localeCompare(String(_taskNum(b, c.id)), undefined, { numeric: true }) || String(a.title).localeCompare(String(b.title)));
  const p = _pulseData(c);
  const stats = new Map((p ? p.tasks : []).map(t => [t.id, t]));
  const shown = _ovUi.tasks ? tasks : tasks.slice(0, TASKS_SHOWN);
  const rows = shown.map(t => {
    const open = _ovUi.openTasks.has(t.id);
    const fid = `ws-tf-${t.id}`;
    const s = stats.get(t.id);
    // A qualifying question (a "Quick question" to participants) scores no
    // points and every answer is accepted: no difficulty, points or solve rate.
    const qual = isQualifyingTask(t);
    const pts = DIFF_PTS[t.difficulty];
    const state = [t.status === 'draft' ? 'Draft' : 'Published', t.active === false || t.active === 0 ? 'hidden from participants' : 'visible to participants'].join(', ');
    const solved = s ? `${s.solvers} of ${s.attempters} who tried` : (c.competing ? _cap(_COMPETING_OFF_PAGE) : 'Counting…');
    const facts = (qual
      ? [
        ['Kind', 'Quick question'],
        ['Points', '0 — a quick question scores no points'],
        // People who ANSWERED it (opening and leaving it, or a hint, is no answer).
        ['Answered by', s ? String(s.answerers ?? s.solvers) : (c.competing ? _cap(_COMPETING_OFF_PAGE) : 'Counting…')],
        ['State', state],
      ]
      : [
        ['Difficulty', _cap(t.difficulty) || '—'],
        ['Points', pts != null ? String(pts) : '—'],
        ['Solved by', solved],
        ['Answers', s ? String(s.answers) : '—'],
        ['State', state],
      ]).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const sub = (qual
      ? ['Quick question', t.status === 'draft' ? 'draft' : '']
      : [_cap(t.difficulty), t.status === 'draft' ? 'draft' : '', s && s.attempters ? `${Math.round((s.solvers / s.attempters) * 100)}% solved` : '']).filter(Boolean).join(' · ');
    const expanded = open ? 'true' : 'false';
    const hiddenAttr = open ? '' : ' hidden';
    return `<li class="ws-li ws-task"><button type="button" class="ws-row-toggle" data-action="ws-task-facts" data-task-id="${esc(t.id)}" aria-expanded="${expanded}" aria-controls="${esc(fid)}">`
      + `<span class="ws-num">${esc(_taskNum(t, c.id))}</span><span class="ws-li-main"><b>${esc(t.title)}</b><small>${esc(sub)}</small></span>`
      + `<span class="ws-chev" aria-hidden="true">${ICO.chevronDown}</span></button>`
      + `<dl class="ws-task-facts" id="${esc(fid)}"${hiddenAttr}>${facts}</dl></li>`;
  }).join('');
  _paintKeepingFocus(el, `<ul class="ws-list ws-task-list">${rows}</ul>`, focusKey);
  if (more && tasks.length > TASKS_SHOWN) _syncMore(more, _ovUi.tasks, _ovUi.tasks ? 'Show fewer' : `Show ${tasks.length - TASKS_SHOWN} more`);
  else if (more) more.hidden = true;
}

// ── Live parts: chart, feed, solve rates ─────────────────────────────────────

function _paintPulse(c) { _linesRoster = { compId: c.id, n: _joinedCount(c) }; _paintChart(c); _paintTicker(c); _paintSolveRates(c); _paintProgress(c); _paintReady(c); _renderOverviewAttn(c); }

// The shared states of the three live parts. Returns the HTML to show instead
// of the part, or null when there is data to draw.
function _pulseStateHtml(c, containerId, noun) {
  if (c.competing) return '<p class="ws-empty">While you compete in this event, its live figures are kept off this page.</p>';
  if (!_pulse || _pulse.compId !== c.id) return '<p class="ws-empty">Loading…</p>';
  if (!_pulse.data) {
    // Painted once per failure, so a poll that fails again does not replace
    // the Try again button under the pointer.
    const el = document.getElementById(containerId);
    if (el && el._wsHtml !== '__failed__') { renderLoadFailure(containerId, { noun, retryAction: 'ws-pulse-retry' }); el._wsHtml = '__failed__'; }
    return '';
  }
  return null;
}

function _niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function _paintChart(c) {
  const el = document.getElementById('ws-ov-chart');
  if (!el) return;
  const st = _pulseStateHtml(c, 'ws-ov-chart', 'live activity');
  if (st === '') return;
  if (st !== null) { _paintKeepingFocus(el, st, () => null); return; }
  const d = _pulse.data;
  const stale = _pulse.failed ? `<p class="ws-stale">Could not refresh just now — showing the live figures from ${esc(fmtDt(new Date(d.generated_at), 'long'))}.</p>` : '';
  if (!d.window || !d.buckets.length) {
    // How many have joined: the roster (`_joinedCount`), never the pulse's live
    // `joined`.
    const j = _joinedCount(c);
    _paintKeepingFocus(el, `<p class="ws-empty">The chart fills once the event starts. ${esc(String(j))} ${j === 1 ? 'person has' : 'people have'} joined so far.</p>${stale}`, () => null);
    return;
  }
  const b = d.buckets;
  // Nothing has happened yet: say so, rather than draw a flat line at zero.
  if (!b.some(r => r.answers || r.joins)) {
    _paintKeepingFocus(el, `<p class="ws-empty">No joins or answers since the start yet. The chart draws them as they come in.</p>${stale}`, () => null);
    return;
  }
  const n = b.length;
  const W = 600, H = 160;
  const max = _niceMax(Math.max(2, ...b.map(r => Math.max(r.answers, r.joins))));
  const xs = n === 1 ? [0, W] : b.map((_, i) => (i / (n - 1)) * W);
  const yv = v => H - (v / max) * H;
  const series = key => (n === 1 ? [b[0], b[0]] : b).map((r, i) => [xs[i], yv(r[key])]);
  const path = pts => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' ');
  const ans = series('answers');
  const t = d.totals;
  const from = new Date(d.window.from), to = new Date(d.window.to);
  let busiest = 0;
  b.forEach((r, i) => { if (r.answers > b[busiest].answers) busiest = i; });
  const per = _span(d.window.bucket_ms);
  // The chart's Joins (legend and summary) are the pulse's live figures, so
  // they can be fewer than Joined, the roster (operator ruling, 14 Nov 2026).
  const summary = `${t.answers} answer${t.answers === 1 ? '' : 's'} (${t.correct} correct) and ${t.joined - t.joined_before_start} join${t.joined - t.joined_before_start === 1 ? '' : 's'} between ${fmtDt(from, 'long')} and ${fmtDt(to, 'long')}`
    + (b[busiest].answers ? `; the busiest ${per} began ${fmtDt(new Date(b[busiest].t), 'long')} with ${b[busiest].answers} answers.` : '.')
    + (t.joined_before_start ? ` ${t.joined_before_start} joined before the start.` : '');
  const live = computeCompStatus(c) === 'live';
  const last = ans[ans.length - 1];
  const svg = `<svg class="ws-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" focusable="false" aria-hidden="true">`
    + `<path class="ws-ch-grid" d="M0 ${yv(max).toFixed(1)} H${W} M0 ${yv(max / 2).toFixed(1)} H${W} M0 ${H - 0.5} H${W}"/>`
    + `<path class="ws-ch-area" d="${path(ans)} L${W} ${H} L0 ${H} Z"/>`
    + `<path class="ws-ch-line ws-ch-answers" d="${path(ans)}"/>`
    + `<path class="ws-ch-line ws-ch-correct" d="${path(series('correct'))}"/>`
    + `<path class="ws-ch-line ws-ch-joins" d="${path(series('joins'))}"/>`
    + `</svg>`;
  const table = `<table class="sr-only"><caption>Joins, answers and correct answers per ${esc(per)}</caption><thead><tr><th scope="col">From</th><th scope="col">Joins</th><th scope="col">Answers</th><th scope="col">Correct</th></tr></thead><tbody>${
    b.map(r => `<tr><th scope="row">${esc(fmtDt(new Date(r.t), 'long'))}</th><td>${esc(String(r.joins))}</td><td>${esc(String(r.answers))}</td><td>${esc(String(r.correct))}</td></tr>`).join('')}</tbody></table>`;
  const html = `<figure class="ws-chart" aria-labelledby="ws-chart-cap">`
    + `<div class="ws-chart-plot" aria-hidden="true">${svg}`
    + `<span class="ws-ch-y ws-ch-y-max">${esc(String(max))}</span><span class="ws-ch-y ws-ch-y-mid">${esc(String(max / 2))}</span>`
    + (live ? `<span class="ws-ch-now" data-x="${(last[0] / W * 100).toFixed(2)}" data-y="${(last[1] / H * 100).toFixed(2)}"></span>` : '')
    + `</div>`
    + `<div class="ws-ch-x" aria-hidden="true"><span>${esc(fmtDt(from, 'long'))}</span><span>${esc(live ? 'now' : fmtDt(to, 'long'))}</span></div>`
    + `<ul class="ws-legend">`
    + `<li><span class="ws-sw ws-sw-answers" aria-hidden="true"></span>Answers <b>${esc(String(t.answers))}</b></li>`
    + `<li><span class="ws-sw ws-sw-correct" aria-hidden="true"></span>Correct <b>${esc(String(t.correct))}</b></li>`
    + `<li><span class="ws-sw ws-sw-joins" aria-hidden="true"></span>Joins <b>${esc(String(t.joined))}</b></li>`
    + `</ul>`
    + `<figcaption id="ws-chart-cap" class="ws-chart-summary">${esc(summary)}</figcaption>${table}</figure>${stale}`;
  if (!_paintKeepingFocus(el, html, () => null)) return;
  const dot = el.querySelector('.ws-ch-now');
  if (dot) { dot.style.left = `${dot.dataset.x}%`; dot.style.top = `${dot.dataset.y}%`; }
  if (!_ovUi.chartPainted) {
    _ovUi.chartPainted = true;
    if (!_reducedMotion()) el.querySelector('.ws-chart-plot')?.classList.add('ws-chart-in');
  }
}

function _ago(at, nowMs) {
  const ms = nowMs - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return fmtDt(new Date(at), 'long');
}

function _paintTicker(c) {
  const el = document.getElementById('ws-ov-ticker');
  if (!el) return;
  // On the live face the feed's card shows only while it has something to say
  // (or a failure to report): no empty card.
  const card = el.closest('[data-hide-empty]');
  const st = _pulseStateHtml(c, 'ws-ov-ticker', 'activity');
  if (card) card.hidden = st === null ? !(_pulse.data.recent || []).length : st !== '';
  if (st === '') return;
  if (st !== null) { _paintKeepingFocus(el, st, () => null); return; }
  const d = _pulse.data;
  const items = Array.isArray(d.recent) ? d.recent : [];
  if (!items.length) {
    _ovUi.tickerSeen = new Set();
    _paintKeepingFocus(el, '<p class="ws-empty">Nothing yet. Joins and correct answers appear here as they happen.</p>', () => null);
    return;
  }
  const seen = _ovUi.tickerSeen;
  const next = new Set();
  const nowMs = Date.parse(d.generated_at) || Date.now();
  const html = `<ol class="ws-ticker" aria-label="Recent joins and solves">${items.map(it => {
    const key = `${it.type}|${it.at}|${it.nickname || ''}|${it.task_title || ''}`;
    next.add(key);
    const fresh = seen !== null && !seen.has(key);
    const who = esc(it.nickname || 'A participant');
    const what = it.type === 'solved'
      ? `solved <span class="ws-tk-task">${it.task_number ? `#${esc(String(it.task_number))} ` : ''}${esc(it.task_title || 'a challenge')}</span>`
      : 'joined';
    const solvedRow = it.type === 'solved';
    const mark = solvedRow ? ICO.check : ICO.userPlus;
    const cls = `ws-tk ws-tk-${solvedRow ? 'solved' : 'joined'}${fresh ? ' ws-tk-new' : ''}`;
    return `<li class="${cls}"><span class="ws-tk-mark" aria-hidden="true">${mark}</span>`
      + `<span class="ws-tk-text"><b>${who}</b> ${what}</span><time class="ws-tk-time" datetime="${esc(String(it.at))}">${esc(_ago(it.at, nowMs))}</time></li>`;
  }).join('')}</ol>`;
  _ovUi.tickerSeen = next;
  _paintKeepingFocus(el, html, () => null);
}

function _paintSolveRates(c) {
  const el = document.getElementById('ws-ov-rates');
  if (!el) return;
  const st = _pulseStateHtml(c, 'ws-ov-rates', 'solve rates');
  if (st === '') return;
  if (st !== null) { _paintKeepingFocus(el, st, () => null); return; }
  // Scoring challenges only: every answer to a qualifying question is accepted,
  // so its bar would read 100% and measure nothing (Analytics leaves it out too).
  const tasks = [...(_pulse.data.tasks || [])].filter(t => !t.qualifying).sort((a, b) =>
    String(a.task_number || '').localeCompare(String(b.task_number || ''), undefined, { numeric: true }) || String(a.title).localeCompare(String(b.title)));
  if (!tasks.length) { _paintKeepingFocus(el, '<p class="ws-empty">No challenges yet.</p>', () => null); return; }
  const html = `<ol class="ws-bars" aria-label="Solve rate by challenge">${tasks.map(t => {
    const rate = t.attempters ? t.solvers / t.attempters : null;
    const pct = rate == null ? 0 : Math.round(rate * 1000) / 10;
    const val = rate == null ? 'no attempts yet' : `${t.solvers} of ${t.attempters} · ${Math.round(rate * 100)}%`;
    return `<li class="ws-bar-row"><div class="ws-bar-head"><span class="ws-bar-label">${t.task_number ? `<span class="ws-num">${esc(String(t.task_number))}</span>` : ''}<span class="ws-bar-title">${esc(t.title)}</span></span><span class="ws-bar-val">${esc(val)}</span></div><span class="ws-bar-track" aria-hidden="true"><span class="ws-bar-fill" data-task-id="${esc(t.id)}" data-pct="${pct}"></span></span></li>`;
  }).join('')}</ol>`;
  if (!_paintKeepingFocus(el, html, () => null)) return;
  // Each bar grows from what it last showed (0 the first time), by a CSS
  // transition the reduced-motion rule turns off.
  const calm = _reducedMotion();
  const fills = [...el.querySelectorAll('.ws-bar-fill')];
  fills.forEach(f => { const was = _ovUi.ratePct.get(f.dataset.taskId); f.style.setProperty('--pct', String(calm ? f.dataset.pct / 100 : (was ?? 0) / 100)); });
  const settle = () => fills.forEach(f => { f.style.setProperty('--pct', String(f.dataset.pct / 100)); _ovUi.ratePct.set(f.dataset.taskId, Number(f.dataset.pct)); });
  if (calm) settle(); else requestAnimationFrame(() => requestAnimationFrame(settle));
}

// ── Organisers: list, remove, add ────────────────────────────────────────────

/** May this admin add and remove organisers here? The route's own predicate:
 *  requireGlobalAdmin (never an event admin; a custom role only with
 *  `events.organisers`), and never on an event the actor competes in. */
function _canManageOrganisers(c) {
  return !!c && !c.competing && !S.isEventAdmin && adminCan('events.organisers');
}
function _orgManageReason(c) {
  if (!c) return '';
  if (c.competing) return 'You compete in this event, so its organisers cannot be changed from here. Ask another administrator.';
  if (S.isEventAdmin) return 'Only an administrator can add or remove organisers.';
  if (!adminCan('events.organisers')) return 'Your role cannot add or remove organisers.';
  return '';
}
// Adding also searches people (GET …/participants/picker, `participants.view`):
// a role that may grant but not search is offered Remove only, and told why.
function _canAddOrganisers(c) { return _canManageOrganisers(c) && adminCan('participants.view'); }
function _orgAddReason(c) {
  return _orgManageReason(c) || (adminCan('participants.view') ? '' : 'Your role cannot search people, so organisers cannot be added from here. It can remove them.');
}

function _orgName(a) { return [a.first_name, a.last_name].filter(Boolean).join(' ') || a.nickname || a.email || 'This person'; }

function _organisersListHtml(c) {
  if (!_organisers || !_organisers.list) return '<p class="ws-empty">Loading…</p>';
  const list = _organisers.list;
  if (!list.length) return `<p class="ws-empty">No organisers yet. Administrators run this event.${_canAddOrganisers(c) ? ' Add one below.' : ''}</p>`;
  const can = _canManageOrganisers(c);
  const shown = _ovUi.orgs ? list : list.slice(0, ORGS_SHOWN);
  return `<ul class="ws-list ws-org-list">${shown.map(a => {
    const name = _orgName(a);
    const sub = [a.email || '', a.granted_at ? `added ${fmtDt(a.granted_at, 'short')}` : ''].filter(Boolean).join(' · ');
    const rm = can ? `<button type="button" class="btn sm secondary ws-org-remove" data-action="ws-org-remove" data-user-id="${esc(a.id)}" data-name="${esc(name)}" aria-label="Remove ${esc(name)} as an organiser">Remove</button>` : '';
    return `<li class="ws-li"><span class="ws-li-main"><b>${esc(name)}</b><small>${esc(sub)}</small></span>${rm}</li>`;
  }).join('')}</ul>`;
}

function _paintOrgAdd(c) {
  const el = document.getElementById('ws-ov-orgs-add');
  if (!el) return;
  if (!_canAddOrganisers(c)) {
    setSafeHtml(el, `<p class="ws-org-reason">${esc(_orgAddReason(c))}</p>`);
    return;
  }
  setSafeHtml(el, `<div class="ws-org-add"><label class="ws-org-add-label" for="ws-org-search">Add an organiser</label>`
    + `<input id="ws-org-search" class="ws-org-search" type="text" autocomplete="off" spellcheck="false" maxlength="80" placeholder="Name, nickname or email" data-input-action="ws-org-search" aria-describedby="ws-org-hint">`
    + `<p id="ws-org-hint" class="ws-org-hint">Type at least two letters. Picking someone makes them an event admin of this event.</p>`
    + `<div id="ws-org-results"></div></div>`);
}

let _orgSearchSeq = 0;
let _orgSearchTimer = 0;
let _orgBusy = false;
const ORG_RESULTS = 8;

function _setOrgResults(html) {
  const el = document.getElementById('ws-org-results');
  if (el) setSafeHtml(el, html);
}
function _orgMsg(text, kind) {
  const el = document.getElementById('ws-ov-orgs-msg');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
}
function _orgFail(text) { showToast(text, 'error'); _orgMsg(text, 'error'); }

/** The add picker's input (debounced; only the newest search may paint). */
export function wsOrgSearch(el) {
  clearTimeout(_orgSearchTimer);
  const c = _comp();
  const q = String((el && el.value) || '').trim();
  if (!c || q.length < 2) { ++_orgSearchSeq; _setOrgResults(''); return; }
  _orgSearchTimer = setTimeout(() => { _runOrgSearch(c.id, q); }, 250);
}

async function _runOrgSearch(compId, q) {
  const seq = ++_orgSearchSeq;
  _setOrgResults('<p class="ws-empty">Searching…</p>');
  // The people picker: members of this event in full, everyone else filtered
  // by `search` and capped (`truncated` says the cap cut matches off).
  const d = await fetchJsonObject(`/api/admin/participants/picker?competitionId=${encodeURIComponent(compId)}&search=${encodeURIComponent(q)}&limit=25`);
  if (seq !== _orgSearchSeq || S.adminSelectedCompetitionId !== compId) return;
  if (!d || !Array.isArray(d.users)) { _setOrgResults('<p class="ws-org-err" role="alert">Could not search people. Nothing changed — try again.</p>'); return; }
  const needle = q.toLowerCase();
  const hay = u => [u.first_name, u.last_name, [u.first_name, u.last_name].filter(Boolean).join(' '), u.nickname, u.email, u.secondary_email, u.company].filter(Boolean).join(' ').toLowerCase();
  const matches = d.users.filter(u => !u.in_competition || hay(u).includes(needle));
  const orgIds = new Set(((_organisers && _organisers.list) || []).map(a => a.id));
  const isAdmin = u => u.role === 'admin' || u.role === 'superadmin';
  const pickable = matches.filter(u => !orgIds.has(u.id) && !isAdmin(u));
  const admins = matches.filter(isAdmin).length;
  const already = matches.filter(u => orgIds.has(u.id)).length;
  const shown = pickable.slice(0, ORG_RESULTS);
  const cut = pickable.length > shown.length || d.truncated === true;
  const notes = [];
  if (cut) notes.push(`Showing the first ${shown.length} matches — type more of the name to narrow.`);
  if (already) notes.push(`${already} already ${already === 1 ? 'organises' : 'organise'} this event.`);
  if (admins) notes.push(`${admins} ${admins === 1 ? 'is an administrator' : 'are administrators'}, who already run every event.`);
  if (!shown.length) {
    _setOrgResults(`<p class="ws-empty">Nobody else matches “${esc(q)}”.</p>${notes.length ? `<p class="ws-org-count">${esc(notes.join(' '))}</p>` : ''}`);
    return;
  }
  _setOrgResults(`<ul class="ws-list ws-org-results">${shown.map(u => {
    const name = _orgName(u);
    const sub = [u.email || '', u.in_competition ? 'in this event' : '', u.role === 'event_admin' ? 'event admin' : ''].filter(Boolean).join(' · ');
    return `<li><button type="button" class="ws-org-pick" data-action="ws-org-add" data-user-id="${esc(u.id)}" data-name="${esc(name)}" data-role="${esc(u.role || '')}"><span class="ws-li-main"><b>${esc(name)}</b><small>${esc(sub)}</small></span><span class="ws-org-add-chip">Add</span></button></li>`;
  }).join('')}</ul>${notes.length ? `<p class="ws-org-count">${esc(notes.join(' '))}</p>` : ''}`);
}

async function _reloadOrganisers(compId) {
  _organisers = null;
  _paintOrganisersCard();
  await _loadOrganisers(compId);
}

/** Pick a search result: grant (POST …/admins), then re-read the card and header. */
export async function wsOrgAdd(el) {
  const c = _comp();
  if (!c || !el || _orgBusy) return;
  if (!_canAddOrganisers(c)) { _orgFail(_orgAddReason(c) || 'You cannot add organisers here.'); return; }
  const userId = el.dataset.userId;
  const name = el.dataset.name || 'This person';
  // Granting can change the account's ROLE (a participant becomes an event
  // admin, which signs them out everywhere and takes them off every board), so
  // it is confirmed first, as the People row's "Make event admin" is.
  // The route changes only a participant's role (a role already scoped by grants
  // keeps it), so the sentence follows the role the search reported.
  const role = el.dataset.role || '';
  const roleLine = role === 'participant'
    ? '<p>Their account becomes an <strong>event admin</strong>: they are signed out everywhere, and they no longer appear on any leaderboard. They see nothing outside the events they organise.</p>'
    : (role === 'event_admin' ? '<p>They already organise other events; their account does not change.</p>' : '');
  _orgBusy = true;
  let ok = false;
  try {
    ok = await showModal({
      title: 'Make organiser?',
      message: `<p><strong>${esc(name)}</strong> will organise <strong>${esc(c.name)}</strong> — its challenges, its participants and its rankings.</p>${roleLine}`,
      confirmText: 'Make organiser',
      confirmClass: 'warning',
    });
  } finally { _orgBusy = false; }
  if (!ok || S.adminSelectedCompetitionId !== c.id) return;
  _orgBusy = true;
  if (el.isConnected) el.disabled = true;
  _orgMsg('', '');
  try {
    let r = null;
    try {
      r = await fetch(`/api/admin/competitions/${encodeURIComponent(c.id)}/admins`, {
        method: 'POST', headers: csrfHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ userId }),
      });
    } catch (_) { r = null; }
    if (!r) { _orgFail('Could not reach the server. Nobody was added.'); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d || d.ok !== true) { _orgFail(d && d.error ? `${name} was not added: ${d.error}` : `${name} was not added as an organiser.`); return; }
    const msg = d.granted === false
      ? `${name} already organises this event.`
      : `${name} is now an organiser of this event.${d.role_changed ? ' Their account is now an event admin.' : ''}`;
    showToast(msg, 'success');
    _orgMsg(msg, 'ok');
    ++_orgSearchSeq;
    _setOrgResults('');
    const input = document.getElementById('ws-org-search');
    if (input) { input.value = ''; input.focus(); }
    if (S.adminSelectedCompetitionId === c.id) await _reloadOrganisers(c.id);
  } finally {
    _orgBusy = false;
    if (el.isConnected) el.disabled = false;
  }
}

/** Remove one organiser (DELETE …/admins/:uid) after a confirm. */
export async function wsOrgRemove(el) {
  const c = _comp();
  if (!c || !el || _orgBusy) return;
  if (!_canManageOrganisers(c)) { _orgFail(_orgManageReason(c) || 'You cannot remove organisers here.'); return; }
  const userId = el.dataset.userId;
  const name = el.dataset.name || 'This person';
  const ok = await showModal({
    title: 'Remove organiser?',
    message: `<p>${esc(name)} will no longer organise <strong>${esc(c.name)}</strong> or see its people. Their account keeps its role; an administrator can add them back at any time.</p>`,
    confirmText: 'Remove',
    confirmClass: 'danger',
  });
  if (!ok || S.adminSelectedCompetitionId !== c.id) return;
  _orgBusy = true;
  _orgMsg('', '');
  try {
    let r = null;
    try {
      r = await fetch(`/api/admin/competitions/${encodeURIComponent(c.id)}/admins/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: csrfHeaders() });
    } catch (_) { r = null; }
    if (!r) { _orgFail(`Could not reach the server. ${name} still organises this event.`); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d || d.ok !== true) { _orgFail(d && d.error ? `${name} was not removed: ${d.error}` : `${name} was not removed.`); return; }
    const msg = `${name} no longer organises this event.${d.remaining_events === 0 ? ' They organise no other event, so they see nothing until an administrator adds them to one.' : ''}`;
    showToast(msg, 'success');
    _orgMsg(msg, 'ok');
    if (S.adminSelectedCompetitionId === c.id) await _reloadOrganisers(c.id);
    document.getElementById('ws-org-search')?.focus();
  } finally {
    _orgBusy = false;
  }
}

// ── Top-three certificates (one click) ───────────────────────────────────────
//
// GET /api/admin/competitions/:id/certificates/top3.zip — the ISSUED 1st, 2nd
// and 3rd place PDFs of every board the event ranks on (one podium per session
// in per_slot mode, and the late entrants' own beside the main one). Offered on
// an ended, ranked event from the Events list and the Overview's Certificates
// card, to a role holding the route's permission (`certificates.view`). The
// server says when there is nothing to download and why (being issued, not
// issued automatically for this event, nobody placed), and how many podium
// places a ZIP leaves out and why (`X-Top3-Missing`, `X-Top3-Missing-Reason`);
// the button says so instead of handing over part of a podium as if it were
// the whole of it.

/** Should a "Download top 3 certificates" door be offered for this event? */
export function top3Offered(c) {
  return !!c && computeCompStatus(c) === 'ended' && policyOrDefault(c.policy).ranking_enabled !== false
    && !(c.tags || []).includes(DRY_RUN_TAG) && adminCan('certificates.view');
}

export async function downloadTop3(compId, btn) {
  const c = (S.adminCompetitionsData || []).find(x => x.id === compId);
  if (!c) return;
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try {
    let r = null;
    try { r = await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/certificates/top3.zip`, { headers: csrfHeaders() }); } catch (_) { r = null; }
    if (!r) { showToast('Could not reach the server. Nothing was downloaded.', 'error'); return; }
    if (r.status === 409) {
      const d = await r.json().catch(() => ({}));
      if (d.code === 'certificates_being_issued' && btn) btn.dataset.state = 'issuing';
      showToast(d.code === 'certificates_being_issued' ? 'The certificates are being issued — try again in a few minutes.' : (d.error || 'There are no top-three certificates yet.'), 'info');
      return;
    }
    if (!r.ok) { const d = await r.json().catch(() => ({})); showToast(d.error || 'Could not download the certificates.', 'error'); return; }
    const blob = await r.blob();
    const slug = String(c.name || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
    downloadBlob(blob, `${slug}-top-3-certificates.zip`);
    // The server counts the podium places no certificate fills yet, and says
    // why: this file is then not the whole top three.
    const n = Number(r.headers.get('X-Top3-Count') || 0);
    const m = Number(r.headers.get('X-Top3-Missing') || 0);
    // A certificate revoked while the file was being prepared is left out of it.
    const k = Number(r.headers.get('X-Top3-Revoked') || 0);
    const revoked = k > 0 ? ` ${k} ${k === 1 ? 'certificate was' : 'certificates were'} revoked while the file was being prepared and ${k === 1 ? 'is' : 'are'} not in it.` : '';
    const got = `${n} top-three certificate${n === 1 ? '' : 's'}`;
    if (m > 0) {
      const places = `${m} more ${m === 1 ? 'place has' : 'places have'} no certificate yet`;
      const why = r.headers.get('X-Top3-Missing-Reason');
      const tail = why === 'being_issued' ? `${m} more ${m === 1 ? 'is' : 'are'} still being issued — download again in a few minutes.`
        : why === 'email_disabled' ? `${places}: this event's certificates are not issued automatically while its congratulations email is off.`
        : why === 'ended_before_floor' ? `${places}: this event ended before certificates were issued automatically.`
        : why === 'no_floor' ? `${places}: certificates are not issued automatically on this installation.`
        : why === 'dry_run' ? `${places}: a test event issues no certificates.`
        : `${places}.`;
      showToast(`Downloaded ${got}. ${tail}${revoked}`, 'info');
    } else if (revoked) showToast(`Downloaded ${got}.${revoked}`, 'info');
    else showToast(n === 1 ? 'Downloaded the top-three certificate.' : `Downloaded all ${got}.`, 'success');
  } finally {
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.removeAttribute('aria-busy'); if (label) setSafeHtml(btn, label); }
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function loadEventSettings() {
  const box = document.getElementById('ws-settings');
  const c = _comp();
  if (!box || !c) return;
  const competing = !!c.competing;
  // RBAC — both doors here (Edit settings, the event look) are `events.edit` routes.
  const permEdit = adminCan('events.edit');
  const canEdit = !competing && permEdit && !endedEditLocked(c);
  const pol = policyOrDefault(c.policy);
  const yes = (v) => v ? 'On' : 'Off';
  const row = (k, v) => `<div class="ws-kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const slots = c.timeslots || [];
  const facts = [
    row('Type', esc(eventKindLabel(c.event_kind) || '—')),   // a stored value is never a caption
    row('Schedule', esc(_scheduleText(c))),
    row('Sessions', slots.length ? esc(slots.map(t => t.name).join(', ')) : 'None — one sitting'),
    row('Join link', yes(c.self_enroll_enabled) + (c.self_enroll_enabled ? ` · ${esc(_JOIN_RULE_TEXT)}` : '')),
    pol.ranking_enabled !== false ? row('Leaderboard', esc(c.leaderboard_mode === 'global' ? 'One board across sessions' : 'Per session')) : '',
    row('Attempts per challenge', c.attempt_cap ? esc(String(c.attempt_cap)) : 'Unlimited'),
    pol.reveal_answers !== 'forbidden' ? row('Show answers when it ends', yes(c.reveal_answers_on_end)) : '',
    pol.group_leaderboard !== 'forbidden' ? row('Team leaderboard', yes(c.group_leaderboard_enabled)) : '',
    pol.late_entry === 'allowed' ? row('Late entry', yes(c.late_entry_enabled)) : '',
    row('Staff compete', yes(c.staff_compete)),
    row('Checkmarx One accounts', policyOrDefault(c.policy).cxone_provisioning !== 'allowed' ? 'Never created for this type of event' : c.cxone_disabled ? 'Not created' : 'Created on enrolment'),
    row('Tags', (c.tags || []).length ? (c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ') : '—'),
  ].join('');
  // One place per action: this pane's only door is Edit settings. History,
  // organisers, email delivery, clone, templates and the lifecycle (start, end,
  // close late entries, delete) are the header's ⋯ menu.
  const edit = canEdit ? `<button type="button" class="btn" data-action="comp-edit" data-comp-id="${esc(c.id)}">${ICO.edit} Edit settings</button>` : '';
  const note = competing ? `<p class="ws-note">${ICO.lock} You are competing in this event — you can view its settings, not change them.</p>`
    : !permEdit ? `<p class="ws-note">${ICO.lock} Your role can view this event's settings, not change them.</p>`
    : (!canEdit ? `<p class="ws-note">${ICO.lock} Only a superadmin can change an event that has ended.</p>` : '');
  // Three parts, each painted only when what it shows changed (the 1 s tick
  // asks while the pane is open), focus going back to the same control. The
  // Look card holds a form, so a change in the facts never repaints it.
  let lookCard = document.getElementById('ws-settings-look');
  if (!lookCard || !box.contains(lookCard)) {
    setSafeHtml(box, '<div id="ws-settings-note"></div><div class="ws-grid ws-grid-settings"><section class="card ws-card" id="ws-settings-facts"></section><section class="card ws-card" id="ws-settings-look"></section></div>');
    lookCard = document.getElementById('ws-settings-look');
  }
  _paintKeepingFocus(document.getElementById('ws-settings-note'), note, _ovFocusKey);
  _paintKeepingFocus(document.getElementById('ws-settings-facts'), _cardInner('How this event runs', `<dl class="ws-kvs">${facts}</dl>`, edit, 'ws.settings'), _ovFocusKey);
  _paintLookCard(lookCard, c, canEdit);
}

// The Look card (look-admin.js). Its form follows the store (another
// organiser's save, the card's own) in place, and never over a choice not yet
// saved: a repaint putting the stored look back under the person's Save would
// have Save store it and say "saved" (a poll never overwrites a user's choice).
// A form already showing what is stored stands for it from then on, however
// it got there; while a save of it is on its way it is left alone (the answer
// decides). A card for another event, or one whose editability changed, is
// drawn afresh: a choice belongs to the event it was made for, and a form that
// cannot be saved must not stay on offer.
function _paintLookCard(el, c, canEdit) {
  if (canEdit && el._lookFor === c.id && el._lookEditable) {
    const form = eventLookFormState(el);
    if (form) {
      if (form.saving) return;
      const stored = eventLookShown(c);
      if (form.look === stored.look && form.locked === stored.locked) setEventLookForm(el, stored, false);
      else if (!form.unsaved) setEventLookForm(el, stored, true);
      return;
    }
  }
  _paintKeepingFocus(el, _cardInner('Look', eventLookCardHtml(c, canEdit), '', 'ws.look'), _ovFocusKey);
  el._lookFor = c.id;
  el._lookEditable = canEdit;
}

// A choice not yet saved belongs to the visit it was made in: leaving the
// workspace drops it, so the next visit draws the card from the store.
function _forgetLookCard() {
  const el = document.getElementById('ws-settings-look');
  if (el) { el._lookFor = null; el._lookEditable = false; el._wsHtml = ''; }
}

// ── Certificates ─────────────────────────────────────────────────────────────

export function loadEventCertificates() {
  const box = document.getElementById('ws-certs');
  const c = _comp();
  if (!box || !c) return;
  // This section reads the list afresh; the Overview's summary re-reads too when
  // it is next shown (a Re-send here changes what it says).
  _certs = null;
  setSafeHtml(box, '<section class="card ws-card ws-certs-issued" id="ws-certs-issued"></section><section class="card ws-card ws-certs-design" id="ws-certs-design"></section>');
  renderIssuedCertificates(document.getElementById('ws-certs-issued'), { compId: c.id, readOnly: !!c.competing });
  // The design routes' own gates: never a competitor, and once the event's
  // effective end has passed only a superadmin (certificate_config_ended_locked).
  const designLock = c.competing
    ? 'You are competing in this event — you can look at its certificate, not change it.'
    : (endedEditLocked(c) ? 'Only a superadmin can change the certificate design of an event that has ended: it would change the look of certificates already issued. You can preview and download.' : '');
  renderCertificateWizard(document.getElementById('ws-certs-design'), {
    compId: c.id, compName: c.name, certificate: policyOrDefault(c.policy).certificate,
    readOnly: !!designLock, readOnlyReason: designLock || undefined,
  });
}

// ── Phone section sheet ──────────────────────────────────────────────────────

export function openSectionSheet() {
  if (!S.adminSelectedCompetitionId) return;
  _closeSectionSheet();
  const ov = document.createElement('div');
  ov.id = 'ws-section-sheet';
  ov.className = 'ws-sheet-overlay';
  const cur = document.querySelector('#ws-tabs .ws-tab.active')?.dataset.section || OVERVIEW;
  const items = [...document.querySelectorAll('#ws-tabs .ws-tab')].filter(b => b.style.display !== 'none').map(b =>
    `<button type="button" class="ws-sheet-item${b.dataset.section === cur ? ' active' : ''}" data-action="ws-tab" data-section="${esc(b.dataset.section)}"${b.dataset.section === cur ? ' aria-current="page"' : ''}>${esc(SECTION_LABELS[b.dataset.section] || b.textContent.trim())}</button>`).join('');
  setSafeHtml(ov, `<div class="ws-sheet" role="dialog" aria-modal="true" aria-labelledby="ws-sheet-title"><div class="ws-sheet-grip" aria-hidden="true"></div><h3 id="ws-sheet-title" class="ws-sheet-title">Sections of this event</h3><div class="ws-sheet-list">${items}</div><button type="button" class="btn secondary ws-sheet-close" data-action="ws-section-sheet-close">Close</button></div>`);
  document.body.appendChild(ov);
  overlayDismiss(ov, () => ov.remove());
  (ov.querySelector('.ws-sheet-item.active') || ov.querySelector('.ws-sheet-item'))?.focus();
}

function _closeSectionSheet() { document.getElementById('ws-section-sheet')?.remove(); }
export function closeSectionSheet() { _closeSectionSheet(); document.getElementById('ws-section-pick')?.focus(); }

// ── Invite (pre-selects the open event) ──────────────────────────────────────

export function wsInvite() {
  // The Invite dialog pre-ticks the event this workspace is on (it reads the
  // same key the workspace sets).
  document.getElementById('invite-participants-btn')?.click();
}

// ── Clone / save as template / export ────────────────────────────────────────

function _localInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function _formDialog(id, title, bodyHtml, confirmText, onSubmit) {
  document.getElementById(id)?.remove();
  const ov = document.createElement('div');
  ov.id = id;
  ov.className = 'ws-dialog-overlay';
  setSafeHtml(ov, `<form class="card ws-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" novalidate>
    <h3 id="${id}-title" class="modal-title">${esc(title)}</h3>
    ${bodyHtml}
    <p class="ws-dialog-err" id="${id}-err" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn secondary" data-ws-cancel>Cancel</button><button type="submit" class="btn">${esc(confirmText)}</button></div>
  </form>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  overlayDismiss(ov, close);
  ov.querySelector('[data-ws-cancel]').addEventListener('click', close);
  const form = ov.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await onSubmit(form, (msg) => { ov.querySelector(`#${id}-err`).textContent = msg || ''; }, close); }
    finally { if (document.body.contains(btn)) btn.disabled = false; }
  });
  setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 0);
  return ov;
}

/** Clone: a new event with this one's challenges, sessions (re-timed) and settings. */
export function wsClone() {
  const c = _comp();
  if (!c) return;
  const start = new Date(Date.now() + 24 * 3600e3); start.setMinutes(0, 0, 0);
  const n = Number(c.task_count || 0);
  _formDialog('ws-clone-dialog', 'Clone event', `
    <p class="ws-dialog-lede">Copies the settings and ${n} challenge${n === 1 ? '' : 's'}. Participants, scores, the join link, the event team and its lead targets, the event's look and its own certificate design are not copied. The new event starts empty.</p>
    ${_ownKeyAccountsOffNote(c, 'copy')}
    <div class="form-group"><label for="ws-clone-name">Name</label><input id="ws-clone-name" type="text" maxlength="120" required value="${esc(`${c.name} (copy)`.slice(0, 120))}"/></div>
    <div class="form-group"><label for="ws-clone-start">Starts</label><input id="ws-clone-start" type="datetime-local" value="${esc(_localInputValue(start))}"/><p class="settings-hint">Your local time.</p></div>
`, 'Clone event', async (form, err, close) => {
    const name = form.querySelector('#ws-clone-name').value.trim();
    const st = form.querySelector('#ws-clone-start').value;
    if (!name) { err('Give the new event a name.'); return; }
    const body = { name };
    if (st) {
      // A time inside the hour the clocks skip is refused (the event form's
      // rule), never stored as the nearest real instant.
      const [dv, tv] = st.split('T');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const chk = wallClockToUtcChecked(dv, tv || '', tz);
      if (!chk.date || isNaN(chk.date)) { err('That start time is not a date.'); return; }
      if (!chk.exists) { err(dstGapMessage(tv || '', tz)); return; }
      body.start_time = chk.date.toISOString();
    }
    let r = null, d = {};
    try { r = await fetch(`/api/admin/competitions/${encodeURIComponent(c.id)}/clone`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
    if (!r || !r.ok || !d.competition) { err((d && d.error) || 'Could not clone the event.'); return; }
    close();
    const skippedList = Array.isArray(d.skipped_challenges) ? d.skipped_challenges : [];
    const notCarried = notCarriedSummary(d.forced_settings, d.skipped_sessions);
    showToast(`Created “${d.competition.name}” with ${d.assigned_challenges || 0} challenge${d.assigned_challenges === 1 ? '' : 's'}${d.sessions_copied ? ` and ${d.sessions_copied} session${d.sessions_copied === 1 ? '' : 's'}` : ''}.${skippedSummary(skippedList)}${notCarried}`, skippedList.length || notCarried ? 'info' : 'success');
    await loadAdminCompetitions();
    openEventWorkspace(d.competition.id, d.competition.name, { tab: OVERVIEW });
  });
}

// Why a challenge was not copied, in words (`_bpTaskSkip`, routes/competitions.js).
const SKIP_REASON_TEXT = {
  missing: 'it no longer exists',
  not_published: 'it is not published',
  locked: 'it is locked',
  not_visible: 'you cannot see it',
  qualifying: 'it is another event\'s own qualifying question',
  unfit: 'it does not fit this kind of event',
  unsealed: 'staff compete here, so its answer must be sealed',
  competing: 'you compete in an event that holds it',
};

/** " Not copied: “A” (it is not published); “B” (…) and 2 more." — or ''. */
export function skippedSummary(list) {
  if (!Array.isArray(list) || !list.length) return '';
  // A challenge the actor may not view comes with no title (`not_visible`): it
  // is counted as "a challenge", never captioned as if that were its name.
  const shown = list.slice(0, 3).map(s => `${s.title ? `“${s.title}”` : 'a challenge'} (${s.message || SKIP_REASON_TEXT[s.reason] || 'it could not be copied'})`);
  return ` Not copied: ${shown.join('; ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}.`;
}

// A copy of an event that creates Checkmarx One accounts with its OWN key has
// them OFF (routes/competitions.js `_bpOwnKeyTurnsAccountsOff`, the operator's
// ruling of 14 Nov 2026): the key is never copied, and the platform's default
// tenant is not one the event sent anybody to. The dialog says so before the
// press, from the same two facts the server reads (`cxone_has_api_key` is the
// admin row's own flag; the key itself never reaches the browser). `target` is
// 'copy' or 'template'; a template creates no accounts, the events made from it do.
function _ownKeyAccountsOffNote(c, target) {
  if (!c || c.cxone_has_api_key !== true || c.cxone_disabled) return '';
  const who = target === 'template' ? 'events made from it' : 'the copy';
  return `<p class="ws-dialog-lede ws-cxone-off-note" data-cxone-off-note>Checkmarx One accounts: off in the ${esc(target)}. This event creates them with its own Checkmarx One key, which is never copied, so ${esc(who)} would otherwise create them in the platform's default tenant.</p>`;
}

// What a clone did not carry over (`forced_settings` and `skipped_sessions`,
// routes/competitions.js), in words: a venue's trusted IPs left behind are
// otherwise found out at the venue, by the rate limits.
const FORCED_TEXT = {
  trusted_network_ips: 'trusted network IPs (a venue address is never copied)',
  cxone_disabled: 'Checkmarx One accounts (turned off: the event used its own Checkmarx One key, which is never copied)',
  cxone_provisioning: 'Checkmarx One accounts (turned off: the new type never creates them)',
  cxone_group_name: 'the Checkmarx One group (it belonged to the event\'s own key)',
  late_entry_deadline_at: 'the pinned late-entry deadline (it did not fit the new end)',
  late_entry_closed: 'the early close of late entries (the copy takes late entries for the usual time after its end)',
  sessions: 'the sessions (the new type has none)',
};
const SESSION_SKIP_TEXT = {
  ended_before_start: 'it was ended before it started',
  starts_before_event: 'it started before the event',
};
/** " Not carried over: trusted network IPs (…); session “B” (…)." — or ''. */
export function notCarriedSummary(forced, sessions) {
  const parts = (Array.isArray(forced) ? forced : []).map(k => FORCED_TEXT[k] || `${String(k).replace(/_/g, ' ')} (the new type does not allow it)`);
  for (const s of Array.isArray(sessions) ? sessions : []) parts.push(`session “${s.name || ''}” (${SESSION_SKIP_TEXT[s.reason] || 'it could not be copied'})`);
  return parts.length ? ` Not carried over: ${parts.join('; ')}.` : '';
}

export function wsSaveTemplate() {
  const c = _comp();
  if (!c) return;
  _formDialog('ws-tpl-dialog', 'Save as template', `
    <p class="ws-dialog-lede">Keeps this event's type, settings, tags and challenges so anyone can spin up the same event in a minute. People, scores and dates are not kept.</p>
    ${_ownKeyAccountsOffNote(c, 'template')}
    <div class="form-group"><label for="ws-tpl-name">Template name</label><input id="ws-tpl-name" type="text" maxlength="120" required value="${esc(c.name.slice(0, 120))}"/></div>
    <div class="form-group"><label for="ws-tpl-desc">Description <span class="muted">(optional)</span></label><textarea id="ws-tpl-desc" rows="2" maxlength="500"></textarea></div>`,
  'Save template', async (form, err, close) => {
    const name = form.querySelector('#ws-tpl-name').value.trim();
    const description = form.querySelector('#ws-tpl-desc').value.trim();
    if (!name) { err('Give the template a name.'); return; }
    let r = null, d = {};
    try { r = await fetch(`/api/admin/competitions/${encodeURIComponent(c.id)}/save-as-template`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
    if (!r || !r.ok) { err((d && d.error) || 'Could not save the template.'); return; }
    close();
    const left = Array.isArray(d.skipped_challenges) ? d.skipped_challenges : [];
    const notCarried = notCarriedSummary(d.forced_settings);
    showToast(`Saved template “${name}”.${skippedSummary(left)}${notCarried}`, left.length || notCarried ? 'info' : 'success');
  });
}
