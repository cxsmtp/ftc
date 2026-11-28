"use strict";

// THE STAFF-TEAMS DIRECTORY — Settings → People → Staff teams, and the two
// event doors that take a whole team in one step.
//
// Server: routes/staff-teams.js (data lib/staff-teams.js). A team is a name and
// its members, each a name, an address and an optional default event-team role.
// Members are recipients, not accounts: whether an address signs in here is the
// server's answer (`has_account`), sent only to a role that may see people.
//
//   • The Settings card (#staff-teams-card) lists the teams, and the members of
//     the one chosen; a role holding `teams.manage` (the read's `can_manage`)
//     adds, renames and deletes teams and their members. Shown to a role holding
//     `teams.view` (ui/nav.js SETTINGS_CARD_PERMISSIONS).
//   • Team & reports → "Add a staff team" (features/event-team.js offers it with
//     the single add's own predicates, and `teams.view`): POST …/team/staff-team.
//   • Overview → Organisers → "Add a staff team as organisers"
//     (features/event-workspace.js offers it where `_canManageOrganisers` allows,
//     and `teams.view`): POST …/admins/staff-team.
// Each event door answers who was added and who was skipped, with the reason,
// and the dialog shows both lists in place of its form.
//
// Every dialog here is one `.ws-dialog-overlay` built by `_stDialog`.

import { csrfHeaders, fetchJsonObject } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { showModal, overlayDismiss } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { renderLoadFailure } from "../ui/list-controls.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { adminCan, settingsCardOffered } from "../ui/nav.js";

const TIPS = {
  'settings.staff-teams': 'Named lists of colleagues: a name, an email address and, if you like, the role each usually takes on an event\'s team. An event\'s Team & reports can add a whole team at once, and its Overview can make a whole team its organisers. They are a list of people, not accounts: changing a team later changes no event it was added to.',
  'staff-teams.members': 'Default role is the role a member takes when the team is added to an event\'s Team & reports (it can be overridden there). Account says whether the address signs in here: only members with an account can be made organisers.',
  'team.staff-team': 'Adds every member of a staff team under the same rules as adding one person: only addresses at the allowed domains, only roles your role may add, and nobody already on the team with that role twice. Anyone left out is listed with the reason.',
  'ws.organisers-team': 'Makes every member of a staff team an organiser of this event, as picking each of them would. Members with no account, administrators and people who already organise it are listed as skipped.',
};

let _seq = 0;
let _dir = null;      // GET /api/admin/staff-teams
let _sel = null;      // the chosen team's id
let _busy = false;

function _n(v) { return esc(String(v)); }
function _plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

async function _post(method, path, body) {
  const r = await fetch(path, { method, headers: csrfHeaders({ 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!(r && r.ok), status: r ? r.status : 0, d: d && typeof d === 'object' ? d : {} };
}

/** Called once from boot(). */
export function initStaffTeams({ registerAction }) {
  registerHelpTips(TIPS);
  registerAction('st-retry', () => loadStaffTeamsCard());
  registerAction('st-open', (e, el) => { _sel = el.dataset.teamId; _render(); document.querySelector(`#staff-teams-body [data-action="st-open"][data-team-id="${CSS.escape(_sel)}"]`)?.focus(); });
  registerAction('st-new', () => openTeamDialog(null));
  registerAction('st-rename', (e, el) => openTeamDialog(_team(el.dataset.teamId)));
  registerAction('st-delete', (e, el) => deleteTeam(el.dataset.teamId));
  registerAction('st-member-add', (e, el) => openMemberDialog(_team(el.dataset.teamId), null));
  registerAction('st-member-edit', (e, el) => { const t = _team(el.dataset.teamId); openMemberDialog(t, t && t.members.find(m => m.id === el.dataset.memberId)); });
  registerAction('st-member-remove', (e, el) => removeMember(el.dataset.teamId, el.dataset.memberId));
  document.addEventListener('admin:settings-loaded', () => loadStaffTeamsCard());
}

function _team(id) { return (_dir && _dir.teams.find(t => t.id === id)) || null; }
function _canManage() { return !!(_dir && _dir.can_manage) && adminCan('teams.manage'); }

// ── the Settings card ────────────────────────────────────────────────────────

export async function loadStaffTeamsCard() {
  const card = document.getElementById('staff-teams-card');
  if (!card) return;
  if (!settingsCardOffered('staff-teams-card')) { card.style.display = 'none'; return; }
  card.style.display = '';
  const my = ++_seq;
  if (!_dir) setSafeHtml(document.getElementById('staff-teams-body'), '<p class="ws-empty">Loading the staff teams…</p>');
  const d = await fetchJsonObject('/api/admin/staff-teams');
  if (my !== _seq) return;
  if (!d || !Array.isArray(d.teams)) { _dir = null; renderLoadFailure('staff-teams-body', { noun: 'the staff teams', retryAction: 'st-retry' }); return; }
  _dir = d;
  if (!_team(_sel)) _sel = d.teams.length ? d.teams[0].id : null;
  _render();
}

function _render() {
  const host = document.getElementById('staff-teams-body');
  if (!host || !_dir) return;
  const can = _canManage();
  const teams = _dir.teams;
  const head = `<div class="st-toolbar"><p class="settings-help st-count" role="status">${teams.length ? esc(_plural(teams.length, 'team')) : 'No staff teams yet.'}</p>${can ? '<button type="button" class="btn" data-action="st-new">New team</button>' : ''}</div>`;
  if (!teams.length) {
    setSafeHtml(host, `${head}<p class="ws-empty st-empty">${can ? 'Make a team, then add the colleagues who usually run an event together. An event can then take the whole team in one step.' : 'An administrator can make staff teams here.'}</p>`);
    return;
  }
  const rows = teams.map(t => {
    const on = t.id === _sel;
    return `<tr${on ? ' class="is-current"' : ''}>
      <td><button type="button" class="link-btn st-team-open" data-action="st-open" data-team-id="${esc(t.id)}" aria-pressed="${on}">${esc(t.name)}</button></td>
      <td data-sort-value="${_n(t.member_count)}">${_n(t.member_count)}</td>
      <td class="st-actions">${can ? `<button type="button" class="btn sm secondary" data-action="st-rename" data-team-id="${esc(t.id)}" aria-label="Rename ${esc(t.name)}">Rename</button><button type="button" class="btn sm secondary" data-action="st-delete" data-team-id="${esc(t.id)}" aria-label="Delete ${esc(t.name)}">Delete</button>` : ''}</td>
    </tr>`;
  }).join('');
  setSafeHtml(host, `${head}
    <div class="table-card"><table class="dense" data-tcols="staff-teams"><thead><tr><th scope="col" data-tcol="team">Team</th><th scope="col" data-tcol="members">Members</th><th scope="col" data-tcol="actions" data-label=""><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${_membersHtml(_team(_sel))}`);
}

function _membersHtml(t) {
  if (!t) return '';
  const can = _canManage();
  const acct = !!_dir.shows_accounts;
  const top = `<div class="st-members-head"><div class="help-label-row"><h4 id="st-members-h" class="st-members-title">${esc(t.name)} · ${esc(_plural(t.member_count, 'member'))}</h4><span data-help="staff-teams.members" data-help-label="Members"></span></div>${can ? `<button type="button" class="btn secondary" data-action="st-member-add" data-team-id="${esc(t.id)}"${t.member_count >= (_dir.limits?.members || 50) ? ' disabled' : ''}>Add member</button>` : ''}</div>`;
  if (!t.members.length) return `<section class="st-members" aria-labelledby="st-members-h">${top}<p class="ws-empty">No one in this team yet.</p></section>`;
  const rows = t.members.map(m => `<tr>
    <td class="cell-stack"><strong>${esc(m.name)}</strong><span class="sub st-email" title="${esc(m.email)}">${esc(m.email)}</span></td>
    <td>${m.default_role_label ? esc(m.default_role_label) : '<span class="t-muted">None</span>'}</td>
    ${acct ? `<td>${m.has_account ? 'Yes' : '<span class="t-muted">No</span>'}</td>` : ''}
    <td class="st-actions">${can ? `<button type="button" class="btn sm secondary" data-action="st-member-edit" data-team-id="${esc(t.id)}" data-member-id="${esc(m.id)}" aria-label="Edit ${esc(m.name)}">Edit</button><button type="button" class="btn sm secondary" data-action="st-member-remove" data-team-id="${esc(t.id)}" data-member-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">Remove</button>` : ''}</td>
  </tr>`).join('');
  return `<section class="st-members" aria-labelledby="st-members-h">${top}
    <div class="table-card"><table class="dense" data-tcols="staff-team-members" data-tcols-scope="${esc(t.id)}"><thead><tr><th scope="col" data-tcol="member">Member</th><th scope="col" data-tcol="default_role">Default role</th>${acct ? '<th scope="col" data-tcol="account">Account</th>' : ''}<th scope="col" data-tcol="actions" data-label=""><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ── dialogs ──────────────────────────────────────────────────────────────────

// One dialog shape for every staff-team dialog: a form with a body, an error
// line and a footer. `_showOutcome` replaces the body and footer with an event
// door's outcome and one Close button, keeping the overlay (and so the opener
// that focus returns to).
function _stDialog(id, title, inner, submitText, { submitClass = '' } = {}) {
  document.getElementById(id)?.remove();
  const ov = document.createElement('div');
  ov.id = id;
  ov.className = 'ws-dialog-overlay';
  setSafeHtml(ov, `<form class="card ws-dialog st-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" novalidate>
    <h3 id="${id}-title" class="modal-title">${esc(title)}</h3>
    <div class="st-dlg-body">${inner}</div>
    <p class="ws-dialog-err" id="${id}-err" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn secondary" data-st-cancel>${submitText ? 'Cancel' : 'Close'}</button>${submitText ? `<button type="submit" class="btn${submitClass ? ' ' + esc(submitClass) : ''}">${esc(submitText)}</button>` : ''}</div>
  </form>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  overlayDismiss(ov, close);
  ov.addEventListener('click', (e) => { if (e.target.closest('[data-st-cancel]')) close(); });
  const err = (m) => { const e = ov.querySelector(`#${id}-err`); if (e) e.textContent = m || ''; };
  const form = ov.querySelector('form');
  setTimeout(() => { const f = ov.querySelector('input:not([disabled]),select:not([disabled])') || ov.querySelector('.modal-foot button'); if (f) f.focus(); }, 0);
  return { ov, form, close, err };
}

/** An event door's answer, in place of its form: who was added, who was skipped. */
function _showOutcome(form, added, skipped, opts) {
  const e = form.querySelector('.ws-dialog-err');
  if (e) e.textContent = '';
  setSafeHtml(form.querySelector('.st-dlg-body'), _outcomeHtml(added, skipped, opts));
  setSafeHtml(form.querySelector('.modal-foot'), '<button type="button" class="btn" data-st-cancel>Close</button>');
  form.querySelector('.modal-foot [data-st-cancel]').focus();
}

function _setBusy(form, on) {
  const b = form.querySelector('button[type="submit"]');
  if (!b) return;
  b.disabled = on;
  if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
}

export function openTeamDialog(team) {
  const max = (_dir && _dir.limits && _dir.limits.team_name) || 80;
  const { form, close, err } = _stDialog('st-team', team ? 'Rename team' : 'New staff team', `
    <div class="form-group"><label for="st-team-name">Team name</label><input id="st-team-name" type="text" maxlength="${_n(max)}" autocomplete="off" value="${esc(team ? team.name : '')}"/></div>
    <p class="t-small">For example "EMEA field team" or "Partner launch crew".</p>`, team ? 'Rename' : 'Create team');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_busy) return;
    const name = form.querySelector('#st-team-name').value;
    if (!name.trim()) { err('Give the team a name.'); return; }
    _busy = true; _setBusy(form, true);
    let r;
    try {
      r = team
        ? await _post('PUT', `/api/admin/staff-teams/${encodeURIComponent(team.id)}`, { name, expectedUpdatedAt: team.updated_at })
        : await _post('POST', '/api/admin/staff-teams', { name });
    } finally { _busy = false; _setBusy(form, false); }
    if (!r.ok) { err(r.d.error || (team ? 'The team was not renamed.' : 'The team was not created.')); return; }
    close();
    if (!team && r.d.team) _sel = r.d.team.id;
    showToast(team ? (r.d.changed ? 'Team renamed.' : 'Name unchanged.') : `Team "${r.d.team ? r.d.team.name : name.trim()}" created.`, 'success');
    loadStaffTeamsCard();
  });
}

export async function deleteTeam(teamId) {
  const t = _team(teamId);
  if (!t) return;
  const ok = await showModal({
    title: 'Delete this staff team?',
    message: `<p><strong>${esc(t.name)}</strong> and its ${esc(_plural(t.member_count, 'member'))} leave the directory. Events the team was added to keep their team and organisers.</p>`,
    confirmText: 'Delete team', confirmClass: 'danger',
  });
  if (!ok) return;
  const r = await _post('DELETE', `/api/admin/staff-teams/${encodeURIComponent(t.id)}`);
  if (!r.ok) { showToast(r.d.error || 'The team was not deleted.', 'error'); return; }
  if (_sel === t.id) _sel = null;
  showToast(`Team "${t.name}" deleted.`, 'success');
  loadStaffTeamsCard();
}

function _roleOptions(selected, { anyLabel = 'None', roles = null } = {}) {
  const list = roles || (_dir && _dir.roles) || [];
  return `<option value="">${esc(anyLabel)}</option>${list.map(r => `<option value="${esc(r.id)}"${r.id === selected ? ' selected' : ''}${r.refusal ? ' disabled' : ''}>${esc(r.label)}${r.refusal ? ' (not available to your role)' : ''}</option>`).join('')}`;
}

export function openMemberDialog(team, member) {
  if (!team) return;
  const max = (_dir && _dir.limits && _dir.limits.member_name) || 120;
  const { form, close, err } = _stDialog('st-member', member ? 'Edit member' : `Add a member to ${team.name}`, `
    <div class="form-group"><label for="st-member-name">Name</label><input id="st-member-name" type="text" maxlength="${_n(max)}" autocomplete="off" value="${esc(member ? member.name : '')}"/></div>
    <div class="form-group"><label for="st-member-email">Email</label><input id="st-member-email" type="email" maxlength="254" autocomplete="off" value="${esc(member ? member.email : '')}"/></div>
    <div class="form-group"><label for="st-member-role">Default role on an event's team</label><select id="st-member-role">${_roleOptions(member ? member.default_role : '')}</select></div>
    <p class="t-small">The role they take when the team is added to an event's Team &amp; reports. Their address is checked against the allowed domains only then.</p>`, member ? 'Save' : 'Add member');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_busy) return;
    const body = {
      name: form.querySelector('#st-member-name').value,
      email: form.querySelector('#st-member-email').value,
      default_role: form.querySelector('#st-member-role').value || null,
    };
    if (!body.name.trim()) { err('Enter their name.'); return; }
    if (!body.email.trim()) { err('Enter their email address.'); return; }
    _busy = true; _setBusy(form, true);
    let r;
    try {
      r = member
        ? await _post('PUT', `/api/admin/staff-teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`, { ...body, expectedUpdatedAt: member.updated_at })
        : await _post('POST', `/api/admin/staff-teams/${encodeURIComponent(team.id)}/members`, body);
    } finally { _busy = false; _setBusy(form, false); }
    if (!r.ok) { err(r.d.error || 'Nothing was saved.'); return; }
    close();
    showToast(member ? (r.d.changed ? 'Member saved.' : 'Nothing changed.') : `${body.name.trim()} added to ${team.name}.`, 'success');
    _sel = team.id;
    loadStaffTeamsCard();
  });
}

export async function removeMember(teamId, memberId) {
  const t = _team(teamId);
  const m = t && t.members.find(x => x.id === memberId);
  if (!m) return;
  const ok = await showModal({
    title: 'Remove from the team?',
    message: `<p><strong>${esc(m.name)}</strong> leaves <strong>${esc(t.name)}</strong>. Events the team was already added to keep them.</p>`,
    confirmText: 'Remove', confirmClass: 'danger',
  });
  if (!ok) return;
  const r = await _post('DELETE', `/api/admin/staff-teams/${encodeURIComponent(t.id)}/members/${encodeURIComponent(m.id)}`);
  if (!r.ok) { showToast(r.d.error || 'The member was not removed.', 'error'); return; }
  showToast(`${m.name} removed from ${t.name}.`, 'success');
  loadStaffTeamsCard();
}

// ── the two event doors ──────────────────────────────────────────────────────

/** The directory for a dialog: { teams, roles, shows_accounts } or null. */
async function _readDirectory() {
  const d = await fetchJsonObject('/api/admin/staff-teams');
  return d && Array.isArray(d.teams) ? d : null;
}

function _teamSelect(id, teams) {
  return `<div class="form-group"><label for="${id}">Staff team</label><select id="${id}">${teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(_plural(t.member_count, 'member'))})</option>`).join('')}</select></div>`;
}

const _NO_TEAMS = '<p>There are no staff teams yet. They are made under Settings, People, Staff teams.</p>';

/** Who was added and who was skipped, with each skip's reason. */
function _outcomeHtml(added, skipped, { addedTitle, addedLine }) {
  const a = added.length
    ? `<h4 class="st-out-h">${esc(addedTitle)} (${_n(added.length)})</h4><ul class="st-out-list" data-outcome="added">${added.map(x => `<li><strong>${esc(x.name)}</strong> <span class="t-muted">${esc(x.email)}</span>${addedLine(x) ? ` — ${esc(addedLine(x))}` : ''}</li>`).join('')}</ul>`
    : `<p class="st-out-none">Nobody was added.</p>`;
  const s = skipped.length
    ? `<h4 class="st-out-h">Skipped (${_n(skipped.length)})</h4><ul class="st-out-list" data-outcome="skipped">${skipped.map(x => `<li data-code="${esc(x.code || '')}"><strong>${esc(x.name)}</strong> <span class="t-muted">${esc(x.email)}</span> — ${esc(x.reason || 'Not added.')}</li>`).join('')}</ul>`
    : '';
  return `<div class="st-outcome">${a}${s}</div>`;
}

/**
 * Team & reports → Add a staff team. `roles`: the event team read's roles, each
 * with the server's `refusal` when this role may not add it; `onDone` reloads.
 */
export async function openStaffTeamToEvent({ compId, roles, onDone }) {
  if (!compId) return;
  const dir = await _readDirectory();
  if (!dir) { showToast('Could not load the staff teams. Try again.', 'error'); return; }
  if (!dir.teams.length) { _stDialog('st-to-event', 'Add a staff team', _NO_TEAMS, null); return; }
  const roleList = Array.isArray(roles) && roles.length ? roles : dir.roles;
  const { form, err } = _stDialog('st-to-event', 'Add a staff team', `
    <p class="ws-dialog-lede">Each member joins this event's team under the same rules as adding one person. Anyone already on the team with that role is kept, and anyone who cannot be added is listed with the reason.</p>
    ${_teamSelect('st-ev-team', dir.teams)}
    <div class="form-group"><label for="st-ev-role">Role on this event's team</label><select id="st-ev-role">${_roleOptions('', { anyLabel: "Each member's default role", roles: roleList })}</select></div>
    <div id="st-ev-preview" class="st-preview" aria-live="polite"></div>`, 'Add team');
  const paint = () => {
    const t = dir.teams.find(x => x.id === form.querySelector('#st-ev-team').value);
    const role = form.querySelector('#st-ev-role').value;
    const label = (id) => (roleList.find(r => r.id === id) || {}).label || '';
    setSafeHtml(form.querySelector('#st-ev-preview'), !t || !t.members.length ? '<p class="t-small">This team has no members.</p>'
      : `<ul class="st-out-list">${t.members.map(m => {
        const r = role || m.default_role;
        return `<li><strong>${esc(m.name)}</strong> <span class="t-muted">${esc(m.email)}</span> — ${r ? esc(label(r) || m.default_role_label || r) : 'no role: will be skipped'}</li>`;
      }).join('')}</ul>`);
  };
  form.addEventListener('change', paint);
  paint();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_busy) return;
    const teamId = form.querySelector('#st-ev-team').value;
    const role = form.querySelector('#st-ev-role').value || null;
    _busy = true; _setBusy(form, true);
    let r;
    try { r = await _post('POST', `/api/admin/competitions/${encodeURIComponent(compId)}/team/staff-team`, { teamId, role }); }
    finally { _busy = false; _setBusy(form, false); }
    if (!r.ok || !Array.isArray(r.d.added)) { err(r.d.error || 'Nobody was added: the request did not go through.'); return; }
    _showOutcome(form, r.d.added, r.d.skipped || [], { addedTitle: 'Added', addedLine: (x) => x.role_label || '' });
    showToast(`${_plural(r.d.added.length, 'person', 'people')} added to the team${r.d.skipped && r.d.skipped.length ? `, ${r.d.skipped.length} skipped` : ''}.`, r.d.added.length ? 'success' : 'error');
    if (typeof onDone === 'function') onDone();
  });
}

/**
 * Overview → Organisers → Add a staff team as organisers. `comp`: the event row;
 * `onDone` reloads the card. The confirm says it can change roles, as the single
 * pick's does.
 */
export async function openStaffTeamAsOrganisers({ comp, onDone }) {
  if (!comp) return;
  const dir = await _readDirectory();
  if (!dir) { showToast('Could not load the staff teams. Try again.', 'error'); return; }
  if (!dir.teams.length) { _stDialog('st-organisers', 'Add a staff team as organisers', _NO_TEAMS, null); return; }
  const { form, err } = _stDialog('st-organisers', 'Add a staff team as organisers', `
    <p class="ws-dialog-lede">Each member whose address signs in here will organise <strong>${esc(comp.name)}</strong> — its questions, its participants and its rankings.</p>
    ${_teamSelect('st-org-team', dir.teams)}
    <div id="st-org-preview" class="st-preview" aria-live="polite"></div>
    <p class="st-warn">Anyone whose account is a <strong>participant</strong> becomes an <strong>event admin</strong>: they are signed out everywhere and no longer appear on any leaderboard. Members with no account are skipped.</p>`, 'Make organisers', { submitClass: 'warning' });
  const paint = () => {
    const t = dir.teams.find(x => x.id === form.querySelector('#st-org-team').value);
    setSafeHtml(form.querySelector('#st-org-preview'), !t || !t.members.length ? '<p class="t-small">This team has no members.</p>'
      : `<ul class="st-out-list">${t.members.map(m => `<li><strong>${esc(m.name)}</strong> <span class="t-muted">${esc(m.email)}</span>${'has_account' in m ? (m.has_account ? '' : ' — no account: will be skipped') : ''}</li>`).join('')}</ul>`);
  };
  form.addEventListener('change', paint);
  paint();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_busy) return;
    const teamId = form.querySelector('#st-org-team').value;
    _busy = true; _setBusy(form, true);
    let r;
    try { r = await _post('POST', `/api/admin/competitions/${encodeURIComponent(comp.id)}/admins/staff-team`, { teamId }); }
    finally { _busy = false; _setBusy(form, false); }
    if (!r.ok || !Array.isArray(r.d.granted)) { err(r.d.error || 'Nobody was added: the request did not go through.'); return; }
    _showOutcome(form, r.d.granted, r.d.skipped || [], { addedTitle: 'Now organisers', addedLine: (x) => (x.role_changed ? 'their account is now an event admin' : '') });
    showToast(`${_plural(r.d.granted.length, 'organiser')} added${r.d.skipped && r.d.skipped.length ? `, ${r.d.skipped.length} skipped` : ''}.`, r.d.granted.length ? 'success' : 'error');
    if (typeof onDone === 'function') onDone();
  });
}
