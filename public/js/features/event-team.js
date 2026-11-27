"use strict";

// THE EVENT TEAM AND ITS PERSONA REPORTS — the workspace's "Team & reports"
// section (#admin-event-team-tab) and the Settings card of allowed domains.
//
// Server: routes/event-team.js (data lib/event-team.js, sending lib/team-reports.js).
// The team is report RECIPIENTS (name + address per role, no platform login);
// whoever may edit the event adds or removes them, and the server refuses an
// address outside the superadmin's allowed domains. The persona views read one
// scoped GET; "Preview email" shows the HTML email a role would receive.
// `can_manage_team` is the routes' own rule (scope and not competing), and
// `manage_refusal` says why when it is false. Adding a recipient and Send now
// also take what reading the reports takes (the server's `add_refusal`,
// `send_refusal` and a role's `refusal`, shown in their place).
//
// Kept apart from features/event-workspace.js on purpose: the workspace only
// lists the section label; this module registers the pane's loader.

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonObject } from "../core/api.js";
import { setSafeHtml, setSafeSrcdoc } from "../core/trusted-types.js";
import { esc, fmtDt } from "../ui/format.js";
import { showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { renderLoadFailure } from "../ui/list-controls.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { downloadBlob } from "../ui/download.js";
import { adminPaneLoaders, adminCan, workspaceHooks } from "../ui/nav.js";
import { openEventWorkspace } from "./event-workspace.js";

const PANE = 'admin-event-team-tab';
const PERSONAS = [
  { id: 'se', label: 'Solutions Engineer' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'sales', label: 'Sales' },
  { id: 'sdr', label: 'SDR' },
  { id: 'manager', label: 'Managers' },
];
const SIGNAL = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };
const STATUS = { new: 'New', returning: 'Returning', possible_duplicate: 'Possible duplicate' };
const STATUS_TONE = { new: 'new', returning: 'ret', possible_duplicate: 'dup' };

let _seq = 0;
let _team = null;      // GET …/team
let _report = null;    // GET …/team-report
// Why there is no report to show: 'permission' (the role lacks
// participants.view, so it is never asked), 'competitor' (the route's lock) or
// 'failed' (any other refusal or a lost answer: Try again, never a reason the
// organiser does not have).
let _reportWhy = null;
let _persona = 'marketing';
let _compId = null;
let _sending = false;  // a Send now is in flight (one at a time)
let _savingTargets = false;  // a targets save is in flight (one at a time)

const TIPS = {
  'team.members': 'The people this event\'s reports go to, by role. They need no account: each report arrives by email (Marketing\'s with the lead file attached once anyone has taken part, each SDR\'s with their own leads). Only someone whose address can open this event gets the email\'s button; everyone else is told the next step in words. Whoever can edit the event adds or removes them, only at the email domains a superadmin allowed.',
  'team.targets': 'Optional. The reports compare the leads and hot leads this event brings in against these numbers.',
  'team.reports': 'What each role is sent about 15 minutes after the event ends (a Program: every Monday, then at its deadline). Late entries and an extended end send only the new leads. Preview email shows the email as it is sent.',
  'team.leads': 'Everyone who took part. Hot: 250 or more developers and evaluating within 6 months, or asked to be contacted. Warm: one of the two. Mark contacted once an SDR has reached out; 48 hours after the report, the owners of uncontacted hot leads are reminded, leaving out anyone who opted out of email.',
  'settings.team-domains': 'Event team reports carry participants\' details, so they may only go to these domains. Checked when a team member is added and again at every send.',
  'event.qualifying': 'Four pick-one questions every participant can answer: team size, current scanner, evaluation timeline and whether they want a follow-up. They score no points and never count toward finishing.',
  'challenge.pick-one': 'Optional. With two or more options the participant picks one, and every option is accepted. Leave it empty for a free answer.',
};

// esc() turns a falsy value into '', which would blank every zero count.
function _n(v) { return esc(String(v)); }
function _wsComp() { return S.adminSelectedCompetitionId || null; }
function _pct(x) { return x == null ? '—' : `${Math.round(x * 100)}%`; }
function _name(l) { return `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email; }
function _canManage() { return !!(_team && _team.can_manage_team) && adminCan('events.edit'); }
function _manageRefusal() { return (_team && _team.manage_refusal) || 'Your role cannot change this event\'s team.'; }
// Marking a lead contacted: the route's own rule (participants.edit, scoped,
// never a competitor).
function _canMarkContacted() { return !!(_team && _team.can_manage_team) && adminCan('participants.edit'); }

/** Called once from boot(). */
export function initEventTeam({ registerAction, registerChange }) {
  registerHelpTips(TIPS);
  adminPaneLoaders.set(PANE, () => loadEventTeam());
  registerAction('team-add', () => teamAdd());
  registerAction('team-remove', (e, el) => teamRemove(el.dataset.memberId, el.dataset.memberName));
  registerAction('team-targets-save', () => teamTargetsSave());
  registerAction('team-persona', (e, el) => _pickPersona(el.dataset.persona));
  registerAction('team-preview', () => teamPreview());
  registerAction('team-send', () => teamSend());
  registerAction('team-leads-csv', () => teamLeadsCsv());
  registerAction('team-retry', () => loadEventTeam());
  registerAction('team-report-retry', () => loadEventTeam());
  registerAction('team-domains-save', () => teamDomainsSave());
  registerChange('team-contacted', (e, el) => teamContacted(el.dataset.userId, el.checked, el));
  document.addEventListener('admin:settings-loaded', () => loadTeamDomainsCard());
  // A link from a report email: /?event=<id>&section=<key> opens the workspace
  // there once an admin is signed in (the link carries no capability).
  _captureDeepLink();
  const prev = workspaceHooks.adminNavBuilt;
  workspaceHooks.adminNavBuilt = (...a) => { if (prev) prev(...a); _consumeDeepLink(); };
}

const _DL_KEY = 'ha:team-deeplink';
const SECTION_TABS = { overview: 'admin-event-overview-tab', challenges: 'admin-tasks-tab', certificates: 'admin-event-certs-tab', team: PANE };
function _captureDeepLink() {
  try {
    const q = new URLSearchParams(location.search);
    const ev = q.get('event'), sec = q.get('section');
    if (!ev || !/^[0-9a-f-]{36}$/i.test(ev)) return;
    try { sessionStorage.setItem(_DL_KEY, JSON.stringify({ ev, sec: SECTION_TABS[sec] ? sec : 'overview' })); } catch (_) { /* no storage: the link still lands on the Events list */ }
    history.replaceState({}, '', '/');
  } catch (_) { /* malformed URL: ignore */ }
}
function _consumeDeepLink() {
  let dl = null;
  try { dl = JSON.parse(sessionStorage.getItem(_DL_KEY) || 'null'); sessionStorage.removeItem(_DL_KEY); } catch (_) { dl = null; }
  if (!dl || !(S.isAdmin || S.isSuperAdmin)) return;
  // The admin nav is built before the events list has loaded: the workspace
  // reads the event first, then opens it on the linked section (name, status
  // strip and panes included).
  openEventWorkspace(dl.ev, '', { tab: SECTION_TABS[dl.sec] || SECTION_TABS.overview });
}

// ── loading ──────────────────────────────────────────────────────────────────

export async function loadEventTeam() {
  const host = document.getElementById('ws-team');
  const id = _wsComp();
  if (!host || !id) return;
  const my = ++_seq;
  if (_compId !== id) { _team = null; _report = null; _reportWhy = null; _compId = id; }
  if (!_team) setSafeHtml(host, '<p class="ws-empty">Loading the team…</p>');
  const [team, report] = await Promise.all([
    fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(id)}/team`),
    adminCan('participants.view') ? _readReport(id) : Promise.resolve({ why: 'permission' }),
  ]);
  if (my !== _seq || _wsComp() !== id) return;
  if (!team) { renderLoadFailure('ws-team', { noun: 'the event team', retryAction: 'team-retry' }); return; }
  _team = team; _report = report.data || null; _reportWhy = report.data ? null : report.why;
  _render();
  // The managers' comparison is read when that view shows (a reload replaced it).
  if (_persona === 'manager') _loadPeer();
}

// The report read, telling a refusal for a reason from a failed read.
async function _readReport(id) {
  let r = null;
  try { r = await fetch(`/api/admin/competitions/${encodeURIComponent(id)}/team-report`); } catch (_) { r = null; }
  if (!r) return { why: 'failed' };
  let d = null;
  try { d = await r.json(); } catch (_) { d = null; }
  if (r.ok && d && typeof d === 'object' && Array.isArray(d.leads)) return { data: d };
  if (r.status === 403 && d && d.code === 'competitor_cannot_edit') return { why: 'competitor' };
  return { why: 'failed' };
}

function _render() {
  const host = document.getElementById('ws-team');
  if (!host || !_team) return;
  setSafeHtml(host, `<div class="team-grid">
    <section class="card team-card" aria-labelledby="team-members-h">
      <div class="help-label-row"><h3 id="team-members-h" class="ws-card-title">Event team</h3><span data-help="team.members" data-help-label="Event team"></span></div>
      ${_membersHtml()}
      ${!_canManage() ? `<p class="settings-help" id="team-manage-refusal">${esc(_manageRefusal())}</p>`
        : _team.add_refusal ? `<p class="settings-help" id="team-add-refusal">${esc(_team.add_refusal)}</p>` : _addFormHtml()}
    </section>
    <section class="card team-card" aria-labelledby="team-targets-h">
      <div class="help-label-row"><h3 id="team-targets-h" class="ws-card-title">Targets</h3><span data-help="team.targets" data-help-label="Targets"></span></div>
      <div class="team-targets">
        <div class="form-group"><label for="team-lead-target">Lead target</label><input id="team-lead-target" inputmode="numeric" maxlength="6" value="${_n(_team.targets.lead_target ?? '')}"${_canManage() ? '' : ' readonly'}/></div>
        <div class="form-group"><label for="team-hot-target">Hot-lead target</label><input id="team-hot-target" inputmode="numeric" maxlength="6" value="${_n(_team.targets.hot_lead_target ?? '')}"${_canManage() ? '' : ' readonly'}/></div>
      </div>
      ${_canManage() ? '<button type="button" class="btn secondary" data-action="team-targets-save">Save targets</button>' : `<p class="settings-help" id="team-targets-refusal">${esc(_manageRefusal())}</p>`}
      ${_pendingHtml()}
      ${_sendsHtml()}
    </section>
  </div>
  <section class="card team-card" aria-labelledby="team-reports-h">
    <div class="help-label-row"><h3 id="team-reports-h" class="ws-card-title">Reports</h3><span data-help="team.reports" data-help-label="Reports"></span></div>
    <div id="team-report-body"></div>
  </section>`);
  _renderReport();
}

function _membersHtml() {
  const ms = _team.members || [];
  if (!ms.length) return '<p class="ws-empty">No one on the team yet, so no reports are sent.</p>';
  // The name over the address in one cell (the address shortened with its full
  // text on hover), and a Remove that names the member to assistive tech only:
  // the default columns fit the card beside the targets at 1024 px.
  const rows = ms.map(m => `<tr>
    <td>${esc(m.role_label)}</td><td class="cell-stack"><strong>${esc(m.name)}</strong><span class="sub team-member-email" title="${esc(m.email)}">${esc(m.email)}</span>${m.allowed ? '' : '<span class="chip-note">domain no longer allowed: not sent</span>'}</td>
    <td>${_canManage() ? `<button type="button" class="btn sm secondary" data-action="team-remove" data-member-id="${esc(m.id)}" data-member-name="${esc(m.name)}" aria-label="Remove ${esc(m.name)}">Remove</button>` : ''}</td>
  </tr>`).join('');
  return `<div class="table-card"><table class="dense" data-tcols="team-members" data-tcols-scope="${esc(_compId || '')}"><thead><tr><th scope="col">Role</th><th scope="col">Member</th><th scope="col" data-tcol="actions" data-label=""><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function _addFormHtml() {
  // A role the actor may not add (Marketing or SDR, whose reports attach a lead
  // file, without the permission to download one) is listed, disabled, with the
  // reason beneath: never a choice the server refuses. Roles refused for one
  // reason share one note.
  const roles = (_team.roles || []).map(r => `<option value="${esc(r.id)}"${r.refusal ? ' disabled' : ''}>${esc(r.label)}${r.refusal ? ' (not available to your role)' : ''}</option>`).join('');
  const byReason = new Map();
  for (const r of (_team.roles || []).filter(x => x.refusal)) byReason.set(r.refusal, [...(byReason.get(r.refusal) || []), r.label]);
  const roleNotes = [...byReason].map(([why, labels]) => `<p class="settings-help team-role-refusal">${esc(labels.join(', '))}: ${esc(why)}</p>`).join('');
  const doms = (_team.allowed_domains || []);
  return `<div class="team-add">
    <div class="form-group"><label for="team-add-role">Role</label><select id="team-add-role">${roles}</select></div>
    <div class="form-group"><label for="team-add-name">Name</label><input id="team-add-name" maxlength="120" autocomplete="off"/></div>
    <div class="form-group"><label for="team-add-email">Email</label><input id="team-add-email" type="email" maxlength="254" autocomplete="off"/></div>
    <button type="button" class="btn" data-action="team-add">Add to team</button>
  </div>
  ${roleNotes}
  <p class="settings-help">${doms.length ? `Addresses at ${esc(doms.join(', '))} only.` : 'No email domain is allowed yet: a superadmin adds them under Settings, Email.'}</p>`;
}

const KIND_LABEL = { wrapup: 'Wrap-up', delta: 'New leads update', nudge: 'Reminder to SDRs', weekly: 'Weekly digest', manual: 'Sent now' };

function _pendingHtml() {
  const p = _team.pending || [];
  if (!p.length) return '';
  // A job with a failed send is retried: say so, and when.
  return `<p class="settings-help">Scheduled: ${p.map(j => `${esc(KIND_LABEL[j.kind] || j.kind)} ${esc(fmtDt(j.due_at, 'long'))}${j.last_error === 'send_failed' ? ' (trying again: a send failed)' : ''}`).join('; ')}.</p>`;
}

// The last few reports and whether they reached everyone (the send ledger).
// A failed or unknown delivery is said in words, never left to the History.
function _sendsHtml() {
  const rows = _team.recent_sends || [];
  if (!rows.length) return '';
  const runs = [];
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.kind}|${r.end_key}`;
    let run = byKey.get(k);
    if (!run) { run = { kind: r.kind, at: r.created_at, sent: 0, failed: 0, refused: 0, unknown: 0, sending: 0 }; byKey.set(k, run); runs.push(run); }
    if (r.created_at > run.at) run.at = r.created_at;
    if (run[r.status] !== undefined) run[r.status]++;
  }
  const items = runs.slice(0, 4).map(run => {
    const total = run.sent + run.failed + run.refused + run.unknown + run.sending;
    const bad = [run.failed ? `${run.failed} could not be sent` : '', run.refused ? `${run.refused} refused (domain not allowed)` : '', run.unknown ? `${run.unknown} unknown (cut by a restart)` : '', run.sending ? `${run.sending} still going out` : ''].filter(Boolean).join(', ');
    return `<li class="team-send${run.failed || run.refused || run.unknown ? ' is-bad' : ''}"><b>${esc(KIND_LABEL[run.kind] || run.kind)}</b> ${esc(fmtDt(run.at, 'long'))}: ${_n(run.sent)} of ${_n(total)} delivered${bad ? ` — ${esc(bad)}` : ''}</li>`;
  }).join('');
  return `<div class="team-sends"><h4 class="team-sends-h">Recent reports</h4><ul class="team-send-list">${items}</ul></div>`;
}

// ── the persona views ────────────────────────────────────────────────────────
//
// One designed panel per role, mirroring what that role's email leads with: the
// one thing to do (`focus`, the email's own call to action, from the server),
// figures against their targets, then the role's table. Every value passes esc()
// or _n().

function _renderReport() {
  const host = document.getElementById('team-report-body');
  if (!host) return;
  if (!_report) {
    if (_reportWhy === 'failed') { renderLoadFailure('team-report-body', { noun: 'the reports', retryAction: 'team-report-retry' }); return; }
    setSafeHtml(host, `<p class="ws-empty">${esc(_reportWhy === 'competitor' ? 'You cannot open the reports of an event you compete in.' : 'The reports need permission to see participants.')}</p>`);
    return;
  }
  const tabs = PERSONAS.map(p => `<button type="button" data-action="team-persona" data-persona="${esc(p.id)}" aria-pressed="${p.id === _persona}">${esc(p.label)}</button>`).join('');
  const tools = `<div class="team-tools">
    <button type="button" class="btn secondary" data-action="team-preview">Preview email</button>
    ${!_canManage() ? '' : _team.send_refusal ? `<p class="settings-help" id="team-send-refusal">${esc(_team.send_refusal)}</p>` : `<button type="button" class="btn" data-action="team-send"${_sending ? ' disabled aria-busy="true"' : ''}>${_sending ? 'Sending…' : 'Send now'}</button>`}
    ${adminCan('export.data') ? '<button type="button" class="btn secondary" data-action="team-leads-csv">Download leads CSV</button>' : ''}
  </div>`;
  setSafeHtml(host, `<div class="ha-seg team-personas" role="group" aria-label="Report for">${tabs}</div>${tools}<div id="team-persona-view" data-persona="${esc(_persona)}">${_personaHtml(_persona)}</div>`);
}

function _pickPersona(p) {
  _persona = p;
  _renderReport();
  if (p === 'manager') _loadPeer();
}

// The managers' comparison rebuilds other events' reports, so it is read once
// per event, when that view first opens, and kept: a team action reloads the
// report, never the comparison (other events' figures, which it does not move).
// Until it lands the column reads "—"; a failed read is not kept.
let _peerFor = null;   // { id, read } — the comparison's one read for an event
async function _loadPeer() {
  const id = _wsComp();
  if (!id || !_report || _report.peer !== undefined) return;
  const report = _report;
  report.peer = null;
  if (!_peerFor || _peerFor.id !== id) {
    const read = fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(id)}/team-report?peer=1`)
      .then(d => (d && 'peer' in d ? (d.peer || null) : undefined));
    _peerFor = { id, read };
    read.then(v => { if (v === undefined && _peerFor && _peerFor.read === read) _peerFor = null; });
  }
  const peer = await _peerFor.read;
  if (peer && report === _report) {
    report.peer = peer;
    if (_persona === 'manager') _renderReport();
  }
}

function _pill(tone, text) { return `<span class="team-pill is-${esc(tone)}">${esc(text)}</span>`; }

function _tiles(items) {
  return `<div class="team-kpis">${items.map(k => `<div class="ws-kpi"${k.key ? ` data-kpi="${esc(k.key)}"` : ''}><p class="eyebrow">${esc(k.label)}</p><p class="bignum ws-kpi-num">${esc(String(k.num))}</p>${k.sub ? `<p class="ws-kpi-sub">${esc(k.sub)}</p>` : ''}</div>`).join('')}</div>`;
}

// The hot leads somebody may still reach: one meaning of "waiting" (operator
// ruling, 14 Nov 2026), the 48-hour reminder's and the emails'. Each lead's
// `contactable` is the server's verdict (lib/event-team.js `isContactable`, on
// the report read and on the contacted mark's answer), never re-derived here.
function _hotToContact(leads) { return leads.filter(l => l.signal === 'hot' && l.contactable === true).length; }

/** The email's call to action, as a sentence: strings and {b} parts from the server. */
function _focusHtml(f) {
  if (!f || !Array.isArray(f.why) || !f.why.length) return '';
  return `<div class="team-focus">${f.why.map(x => (x && typeof x === 'object' ? `<strong>${esc(x.b)}</strong>` : esc(x))).join('')}</div>`;
}

function _subhead(text, help) {
  return `<div class="help-label-row team-subhead"><h4>${esc(text)}</h4>${help ? `<span data-help="${esc(help)}" data-help-label="${esc(text)}"></span>` : ''}</div>`;
}

/** One qualifying question: its options drawn to scale of those who answered it. */
function _barsHtml(b) {
  const total = b.counts.reduce((a, x) => a + x.n, 0);
  const rows = b.counts.map(x => {
    const pct = total ? Math.round((x.n / total) * 100) : 0;
    return `<div class="team-bar" data-count="${_n(x.n)}"><span class="team-bar-label">${esc(x.text)}</span><span class="team-bar-track" aria-hidden="true"><span class="team-bar-fill" style="width:${pct}%"></span></span><span class="team-bar-n">${_n(x.n)}</span></div>`;
  }).join('');
  return `<div class="team-bars" data-question="${esc(b.key)}"><h4>${esc(b.title)}</h4>${rows}${b.unanswered ? `<p class="ws-kpi-sub">Not answered: ${_n(b.unanswered)}</p>` : ''}</div>`;
}

function _seHtml(r) {
  const s = r.summary, c = r.certificates;
  const tiles = [{ label: 'Joined', num: s.joined }, { label: 'Played', num: s.played, sub: s.joined ? `${_pct(s.played / s.joined)} of those who joined` : '' }];
  if (s.avg_solve_rate != null) tiles.push({ label: 'Average solve rate', num: _pct(s.avg_solve_rate) });
  if (s.avg_rating != null) tiles.push({ label: 'Challenge rating', num: `${s.avg_rating.toFixed(1)} of 5` });
  tiles.push({ label: 'Certificates', num: c.issued, sub: `${c.delivered} delivered${c.bounced ? `, ${c.bounced} not delivered` : ''}` });
  const flag = (x) => (x.flag === 'too_easy' ? _pill('warm', 'Too easy') : x.flag === 'too_hard' ? _pill('hot', 'Too hard') : '');
  const rows = r.challenges.map(x => `<tr><td>${esc(x.title)}</td><td>${_n(x.attempters)}</td><td>${_n(x.solvers)}</td><td>${esc(_pct(x.solve_rate))}</td><td>${_n(x.wrong)}</td><td>${flag(x)}</td><td>${x.ratings ? `${esc(x.avg_rating.toFixed(1))} (${_n(x.low_ratings)} low)` : '—'}</td></tr>`).join('');
  // The podium: one group per board the event ranks on (each session's in per_slot
  // mode, the late entrants' once their window closes); its headings are
  // lib/team-report-mail.js `podiumHeading`'s words, mirrored by hand (browser ESM).
  return `${_focusHtml(r.focus && r.focus.se)}${_tiles(tiles)}
    ${_subhead('Every challenge')}
    <div class="table-card"><table class="dense" data-tcols="team-challenges" data-tcols-scope="${esc(_compId || '')}"><thead><tr><th scope="col">Challenge</th><th scope="col">Tried</th><th scope="col">Solved</th><th scope="col">Rate</th><th scope="col">Wrong</th><th scope="col">Flag</th><th scope="col">Rating</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No scoring challenges yet.</td></tr>'}</tbody></table></div>
    ${r.podium.map(g => `<p class="team-note">${g.session ? `Podium, ${esc(g.session)}` : (g.late ? 'Podium, late entrants' : 'Podium')}: ${g.places.map(x => `${_n(x.rank)}. ${esc(x.name)} (${_n(x.score)})`).join('; ')}</p>`).join('')}`;
}

function _marketingHtml(r) {
  const s = r.summary, t = r.targets;
  const tiles = [
    { label: 'Leads', num: s.leads, sub: t.lead_target != null ? `target ${t.lead_target}` : '' },
    { label: 'Hot', num: s.hot, sub: t.hot_lead_target != null ? `target ${t.hot_lead_target}` : '' },
    { label: 'Warm', num: s.warm }, { label: 'Cold', num: s.cold },
    { label: 'Brand new', num: s.new }, { label: 'Returning', num: s.returning },
    { label: 'Possible duplicates', num: s.possible_duplicate }, { label: 'Opted out', num: s.opted_out },
  ];
  const focus = r.focus && r.focus.marketing;
  return `${_focusHtml(focus)}${_tiles(tiles)}
    ${s.breakdown.length ? `${_subhead('Qualifying answers')}<div class="team-bars-grid">${s.breakdown.map(_barsHtml).join('')}</div>` : '<p class="team-note">This event has no qualifying questions.</p>'}
    ${_leadsTable(r.leads, { emptyLine: !(focus && Array.isArray(focus.why) && focus.why.length) })}`;
}

function _salesHtml(r) {
  const accts = r.accounts;
  const ready = accts.filter(a => a.signal === 'hot').length;
  const rows = accts.slice(0, 50).map(a => `<tr><td><strong>${esc(a.company)}</strong></td><td>${_n(a.people)}</td><td>${esc(a.top_title || '—')}</td><td>${esc((a.answers || {}).developers || '—')}</td><td>${esc((a.answers || {}).evaluating || '—')}</td><td>${_pill(a.signal, SIGNAL[a.signal])}</td></tr>`).join('');
  return `${_focusHtml(r.focus && r.focus.sales)}${_tiles([{ label: 'Companies', num: accts.length }, { label: 'Ready for a meeting', num: ready }, { label: 'People', num: r.leads.length }])}
    ${_subhead('Accounts, most ready first')}
    <div class="table-card"><table class="dense" data-tcols="team-accounts" data-tcols-scope="${esc(_compId || '')}"><thead><tr><th scope="col">Company</th><th scope="col">People</th><th scope="col">Most senior</th><th scope="col">Developers</th><th scope="col">Evaluating</th><th scope="col">Signal</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No accounts yet.</td></tr>'}</tbody></table></div>`;
}

function _contactedBox(l) {
  // Read-only for whoever the route refuses (a competitor, a role without
  // participants.edit): the state, in words, never a box that cannot save.
  if (!_canMarkContacted()) return `<span class="team-contacted-ro">${l.contacted_at ? 'Contacted' : 'Not contacted'}<span class="sr-only"> ${esc(_name(l))}</span></span>`;
  return `<label class="checkbox-row"><input type="checkbox" data-change-action="team-contacted" data-user-id="${esc(l.user_id)}" ${l.contacted_at ? 'checked' : ''}/><span>Contacted<span class="sr-only"> ${esc(_name(l))}</span></span></label>`;
}

function _leadCard(l, qs) {
  const chips = qs.filter(q => l.answers[q.key]).map(q => `<span class="team-qual">${esc(q.title)} <strong>${esc(l.answers[q.key])}</strong></span>`).join('');
  // The lead's address, as on the SDR's email card (operator ruling 79).
  return `<article class="team-lead">
    <div class="team-lead-top"><strong>${esc(_name(l))}</strong><span class="team-lead-who">${esc([l.title, l.company].filter(Boolean).join(', '))}</span>${_pill(l.signal, SIGNAL[l.signal])}${l.opted_out ? _pill('dup', 'Do not email') : ''}</div>
    <p class="team-lead-email">${esc(l.email || '')}</p>
    ${chips ? `<div class="team-quals">${chips}</div>` : ''}
    <p class="team-opener"><strong>Suggested opener:</strong> ${esc(l.opener || '')}</p>
    ${_contactedBox(l)}
  </article>`;
}

function _sdrHtml(r) {
  if (!r.owners.length) return '<p class="ws-empty">No SDR or Marketing member owns this event\'s leads yet.</p>';
  return r.owners.map(o => {
    // Hot first, then the most senior: the order the email's cards come in.
    const rank = { hot: 3, warm: 2, cold: 1 };
    const mine = r.leads.filter(l => l.owner_member_id === o.id).sort((a, b) => rank[b.signal] - rank[a.signal] || b.seniority - a.seniority);
    const hot = mine.filter(l => l.signal === 'hot').length;
    return `<section class="team-owner" data-owner-id="${esc(o.id)}">${_subhead(`${o.name} — ${mine.length} lead${mine.length === 1 ? '' : 's'}`)}
      ${_tiles([{ label: 'Leads', num: mine.length }, { label: 'Hot', num: hot }, { key: 'hot-to-contact', label: 'Hot still to contact', num: _hotToContact(mine) }])}
      <div class="team-lead-list">${mine.map(l => _leadCard(l, r.qualifying)).join('') || '<p class="ws-empty">No leads yet.</p>'}</div>
    </section>`;
  }).join('');
}

function _managerHtml(r) {
  const s = r.summary, t = r.targets, peer = r.peer || null;
  const toContact = _hotToContact(r.leads);
  const avg = (x) => (peer && x != null ? x.toFixed(1) : '—');
  const met = (v, target) => (target == null ? '' : v >= target ? _pill('new', 'Met') : _pill('warm', 'Below'));
  const row = (label, target, value, peerValue, status) => `<tr><td>${esc(label)}</td><td>${esc(String(target ?? '—'))}</td><td><strong>${_n(value)}</strong></td><td>${esc(peerValue)}</td><td>${status}</td></tr>`;
  return `${_focusHtml(r.focus && r.focus.manager)}
    <div class="table-card"><table class="dense team-scorecard" data-tcols="team-scorecard" data-tcols-scope="${esc(_compId || '')}"><thead><tr><th scope="col">Measure</th><th scope="col">Target</th><th scope="col">Result</th><th scope="col" data-tcol="average">${esc(peer ? `Average of last ${peer.events}` : 'Average of last 3')}</th><th scope="col" data-tcol="status" data-label="Status"><span class="sr-only">Status</span></th></tr></thead><tbody>
      ${row('Leads', t.lead_target, s.leads, avg(peer && peer.leads), met(s.leads, t.lead_target))}
      ${row('Hot leads', t.hot_lead_target, s.hot, avg(peer && peer.hot), met(s.hot, t.hot_lead_target))}
      ${row('Hot still to contact', null, toContact, '—', toContact ? _pill('cold', 'Pending') : _pill('new', 'Done'))}
      ${row('New people', null, s.new, avg(peer && peer.new), '')}
      ${row('Played after joining', null, s.played, avg(peer && peer.played), '')}
      ${row('Certificates issued', null, r.certificates.issued, '—', '')}
    </tbody></table></div>`;
}

function _personaHtml(p) {
  if (p === 'se') return _seHtml(_report);
  if (p === 'marketing') return _marketingHtml(_report);
  if (p === 'sales') return _salesHtml(_report);
  if (p === 'sdr') return _sdrHtml(_report);
  return _managerHtml(_report);
}

function _leadsTable(leads, { emptyLine = true } = {}) {
  // With no leads, the call to action above already says "No leads yet." (it
  // stands alone in this view), so the empty list draws no second line; a view
  // shown without that call to action keeps the line.
  if (!leads.length) return emptyLine ? '<p class="ws-empty">No leads yet.</p>' : '';
  const rows = leads.map(l => `<tr>
    <td><strong>${esc(_name(l))}</strong>${l.opted_out ? ` ${_pill('dup', 'Do not email')}` : ''}<br/><span class="team-lead-who">${esc([l.title, l.company].filter(Boolean).join(', ') || '—')}</span></td>
    <td>${esc(l.answers.developers || '—')}</td><td>${esc(l.answers.evaluating || '—')}</td>
    <td>${_pill(l.signal, SIGNAL[l.signal])}</td><td>${_pill(STATUS_TONE[l.status], STATUS[l.status])}</td><td>${esc(l.source)}</td>
    <td>${esc(l.owner_name || '—')}${l.owner_preview && l.owner_name ? ' <span class="team-lead-who">(at the next report)</span>' : ''}</td>
    <td>${_contactedBox(l)}</td>
  </tr>`).join('');
  return `${_subhead('Lead list', 'team.leads')}
    <div class="table-card"><table class="dense" data-tcols="team-leads" data-tcols-scope="${esc(_compId || '')}"><thead><tr><th scope="col">Lead</th><th scope="col">Developers</th><th scope="col">Evaluating</th><th scope="col">Signal</th><th scope="col">New or returning</th><th scope="col">Where from</th><th scope="col">Owner</th><th scope="col">Contacted</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function _post(method, path, body) {
  const r = await fetch(path, { method, headers: csrfHeaders({ 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!(r && r.ok), status: r ? r.status : 0, d };
}

export async function teamAdd() {
  const id = _wsComp(); if (!id) return;
  const role = document.getElementById('team-add-role')?.value;
  const name = document.getElementById('team-add-name')?.value || '';
  const email = document.getElementById('team-add-email')?.value || '';
  const r = await _post('POST', `/api/admin/competitions/${encodeURIComponent(id)}/team`, { role, name, email });
  if (!r.ok) { showToast(r.d.error || 'Could not add the team member.', 'error'); return; }
  showToast(`${r.d.member.name} added as ${r.d.member.role_label}.`);
  loadEventTeam();
}

export async function teamRemove(memberId, memberName) {
  const id = _wsComp(); if (!id || !memberId) return;
  const ok = await showModal({ title: 'Remove from the team?', message: `${esc(memberName || 'This person')} stops receiving this event's reports. Their leads are shared out again at the next report.`, confirmText: 'Remove', confirmClass: 'danger' });
  if (!ok) return;
  const r = await _post('DELETE', `/api/admin/competitions/${encodeURIComponent(id)}/team/${encodeURIComponent(memberId)}`);
  if (!r.ok) { showToast(r.d.error || 'Could not remove the team member.', 'error'); return; }
  loadEventTeam();
}

export async function teamTargetsSave() {
  const id = _wsComp(); if (!id || !_team || _savingTargets) return;
  const val = (elId) => { const v = (document.getElementById(elId)?.value || '').trim(); return v === '' ? null : v; };
  // The version the form was filled from: a save over somebody else's newer
  // targets is refused (409) rather than quietly putting the old ones back.
  const team = _team;
  const body = { lead_target: val('team-lead-target'), hot_lead_target: val('team-hot-target'), expectedUpdatedAt: team.targets_updated_at ?? null };
  // One save at a time: a second press while the first is out would send the
  // version the first is about to replace, and be refused as somebody else's.
  _savingTargets = true;
  const btn = document.querySelector('#ws-team [data-action="team-targets-save"]');
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  let r;
  try { r = await _post('PUT', `/api/admin/competitions/${encodeURIComponent(id)}/team-targets`, body); }
  finally {
    _savingTargets = false;
    const b = document.querySelector('#ws-team [data-action="team-targets-save"]');
    if (b) { b.disabled = false; b.removeAttribute('aria-busy'); }
  }
  if (r.status === 409 && r.d.code === 'team_targets_changed') { showToast(r.d.error || 'The targets changed elsewhere. They are reloaded.', 'error'); loadEventTeam(); return; }
  if (!r.ok) { showToast(r.d.error || 'Could not save the targets.', 'error'); return; }
  // The form's own save moves its version (the reload below catches up with the
  // rest): a next save before that reload lands sends this one, not the old.
  if (team === _team && typeof r.d.targets_updated_at === 'string') { _team.targets_updated_at = r.d.targets_updated_at; _team.targets = r.d.targets || _team.targets; }
  showToast(r.d.changed ? 'Targets saved.' : 'Targets unchanged.');
  loadEventTeam();
}

export async function teamContacted(userId, contacted, el) {
  const id = _wsComp(); if (!id || !userId) return;
  // The answer is about the lead in the report the box was pressed on, so it
  // updates that report only. Another event's report may have replaced it
  // meanwhile, where the same person can be a lead too, or a reload may have:
  // the answer then leaves the screen as that read drew it.
  const report = _report;
  const r = await _post('POST', `/api/admin/competitions/${encodeURIComponent(id)}/leads/${encodeURIComponent(userId)}/contacted`, { contacted });
  if (!r.ok) {
    if (el) el.checked = !contacted;
    showToast(r.d.error || 'Could not save that.', 'error');
    return;
  }
  if (!report || report !== _report) return;
  const l = report.leads.find(x => x.user_id === userId);
  if (!l) return;
  l.contacted_at = contacted ? new Date().toISOString() : null;
  // The server's verdict after the mark (a lead who opted out stays out of the
  // count when unticked), never worked out here from the box.
  if (typeof r.d.contactable === 'boolean') l.contactable = r.d.contactable;
  _repaintToContact();
}

// The mark moves an SDR's "Hot still to contact" at once: each owner's tile on
// screen is repainted from the leads' verdicts, in place, so the box just
// pressed keeps its focus (a re-render would replace it).
function _repaintToContact() {
  if (!_report) return;
  for (const sec of document.querySelectorAll('#team-persona-view section.team-owner[data-owner-id]')) {
    const num = sec.querySelector('[data-kpi="hot-to-contact"] .ws-kpi-num');
    if (num) num.textContent = String(_hotToContact(_report.leads.filter(l => l.owner_member_id === sec.dataset.ownerId)));
  }
}

// One open token for Preview email: it awaits the preview before it renders, so
// a second press supersedes the first, whose answer then paints nothing — two
// previews would open one after the other, and the first, settled as Cancel by
// the second, would hand the box's width back under it (CLAUDE.md, Stale-response
// guards).
let _previewSeq = 0;
export async function teamPreview() {
  const id = _wsComp(); if (!id) return;
  const seq = ++_previewSeq;
  const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(id)}/team-report/preview?persona=${encodeURIComponent(_persona)}`);
  if (seq !== _previewSeq) return;
  if (!d) { showToast('Could not build the preview.', 'error'); return; }
  if (d.empty) { showModal({ title: 'Nothing to preview', message: esc(d.reason || ''), confirmText: 'Close', cancelText: null }); return; }
  // THE EMAIL AS SENT, in a frame: its table layout and inline colours must not
  // meet the app's stylesheet, and `sandbox` (no scripts, an opaque origin, no
  // navigation) is what makes a whole document safe to load here.
  // `wide` only raises the box's max-width; its width rule is what holds it at 420
  // px, so this dialog sets that too and hands it back when it closes.
  const box = document.getElementById('modal-box');
  if (box) box.style.width = 'min(780px, calc(100vw - 32px))';
  showModal({
    title: `Email to ${d.to_role}`, wide: true, confirmClass: 'secondary',
    message: `<p class="team-preview-subject"><strong>${esc(d.subject)}</strong></p>${d.attachment ? `<p class="team-note">Attached: ${esc(d.attachment)}</p>` : ''}<iframe class="team-preview" sandbox="" title="Preview of the email"></iframe>`,
    confirmText: 'Close', cancelText: null,
  }).then(() => { if (box) box.style.width = ''; });
  const frame = document.querySelector('#modal-body iframe.team-preview');
  if (frame) setSafeSrcdoc(frame, d.html);
}

export async function teamSend() {
  const id = _wsComp(); if (!id || _sending) return;
  const ok = await showModal({ title: 'Send the reports now?', message: 'Every role on the team is sent its report as it stands now. The automatic reports after the end still go out.', confirmText: 'Send now' });
  if (!ok || _sending) return;
  // One send at a time: a second press while this one is out would send the
  // whole team a second report (the server refuses it too).
  _sending = true;
  _syncSendButton();
  let r;
  try { r = await _post('POST', `/api/admin/competitions/${encodeURIComponent(id)}/team-report/send`, {}); }
  finally { _sending = false; _syncSendButton(); }
  // A run that failed part-way answers 500 with what went: the Recent reports
  // list is read again so it shows those too.
  if (!r.ok) { showToast(r.d.error || 'Could not send the reports.', 'error'); if (r.d.code === 'team_report_send_failed') loadEventTeam(); return; }
  const d = r.d;
  if (d.deferred) showToast('The reports are still going out. The event\'s History records how many were sent.', 'info');
  else showToast(`${d.sent} report${d.sent === 1 ? '' : 's'} sent${d.failed ? `, ${d.failed} failed` : ''}${d.refused ? `, ${d.refused} refused (domain not allowed)` : ''}.`, d.failed || d.refused ? 'error' : undefined);
  loadEventTeam();
}

function _syncSendButton() {
  const b = document.querySelector('#team-report-body [data-action="team-send"]');
  if (!b) return;
  b.disabled = _sending;
  if (_sending) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  b.textContent = _sending ? 'Sending…' : 'Send now';
}

export async function teamLeadsCsv() {
  const id = _wsComp(); if (!id) return;
  const r = await fetch(`/api/admin/competitions/${encodeURIComponent(id)}/team-report/leads.csv`).catch(() => null);
  if (!r || !r.ok) { showToast('Could not download the lead file.', 'error'); return; }
  const blob = await r.blob();
  downloadBlob(blob, `leads-${id.slice(0, 8)}.csv`);
}

// ── Settings: the allowed domains ────────────────────────────────────────────

export async function loadTeamDomainsCard() {
  const card = document.getElementById('team-domains-card');
  if (!card) return;
  if (!adminCan('settings.view')) { card.style.display = 'none'; return; }
  const d = await fetchJsonObject('/api/admin/team-report-domains');
  if (!d) { card.style.display = 'none'; return; }
  card.style.display = '';
  const ta = document.getElementById('team-domains-input');
  if (ta) { ta.value = (d.domains || []).join('\n'); ta.readOnly = !d.can_edit; }
  const btn = document.getElementById('team-domains-save');
  if (btn) btn.hidden = !d.can_edit;
  const note = document.getElementById('team-domains-note');
  if (note) note.textContent = d.can_edit ? '' : 'Only a superadmin changes this list.';
}

export async function teamDomainsSave() {
  const ta = document.getElementById('team-domains-input');
  if (!ta) return;
  const domains = ta.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const r = await _post('PUT', '/api/admin/team-report-domains', { domains });
  const note = document.getElementById('team-domains-note');
  if (!r.ok) { showToast(r.d.error || 'Could not save the domains.', 'error'); return; }
  ta.value = r.d.domains.join('\n');
  if (note) note.textContent = r.d.changed ? 'Saved.' : 'Unchanged.';
}
