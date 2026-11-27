"use strict";

// ── NEW EVENT: the one place every event starts ─────────────────────────────
//
// "New event" (the sidebar item, and + New Event on the Events page). ONE card
// per event type, each offering two starts that end in the ONE create form
// (features/competitions-admin.js `openCompetitionForm`), where the kind is a
// field:
//   • RECOMMENDED SETUP: the kind's built-in template (`tpl-pick`): the form
//     opens seeded from it, and saving spawns it (POST
//     /api/admin/event-templates/:id/spawn) and applies the form on top. A
//     kind whose built-in is missing offers Start blank alone (Recently
//     deleted's "Restore built-in templates" brings it back);
//   • START BLANK (`new-event-start`).
// Below, "Your templates" lists only the templates organisers made; a
// built-in is edited, duplicated or reset from its kind card's ⋮ menu.
// An event admin cannot create from scratch (spawning a template and cloning
// one of their events are their tier's only ways to make an event), so their
// cards offer the recommended setup alone, and a template opens the QUICK
// SPIN panel instead (a name and a start). Global admins also manage
// templates here: edit, duplicate, protect, reset a built-in, delete (a soft
// delete) and restore from Recently deleted. The server decides every door.

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonObject } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc, fmtDt, eventKindLabel, eventKindPhraseClient, policyOrDefault, DEFAULT_REGISTRATION_FIELDS } from "../ui/format.js";
import { overlayDismiss } from "../ui/modal.js";
import { fetchJsonList } from "../core/api.js";
import { ICO } from "../ui/icons.js";
import { showModal } from "../ui/modal.js";
import { taskMatchesQuery, taskTagHit, isQualifyingTask } from "../ui/task-search.js";   // the one qualifying test
import { showToast } from "../ui/toast.js";
import { wallClockToUtcChecked, dstGapMessage } from "../data/country-tz.js";
import { loadAdminCompetitions, openCompetitionForm } from "./competitions-admin.js";
import { openEventWorkspace, skippedSummary } from "./event-workspace.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)

let _templates = null;
let _templatesFailed = false;   // the last list read failed (the cards stop waiting for it)
let _picked = null;   // the template the quick spin is showing
let _spinModal = null; // the phone sheet's modal contract (overlayDismiss's cleanup), while open
let _loadSeq = 0;

const KIND_ART = {
  booth: `<svg viewBox="0 0 160 96" aria-hidden="true"><rect x="62" y="12" width="36" height="72" rx="8"/><rect x="69" y="24" width="22" height="9" rx="2"/><rect x="69" y="38" width="22" height="9" rx="2"/><rect x="69" y="52" width="22" height="9" rx="2"/><rect x="69" y="66" width="22" height="9" rx="2"/><rect x="28" y="34" width="14" height="14" rx="2"/><rect x="118" y="44" width="14" height="14" rx="2"/><path d="M42 41h20M98 51h20" stroke-dasharray="3 3"/></svg>`,
  tournament: `<svg viewBox="0 0 160 96" aria-hidden="true"><circle cx="80" cy="40" r="24"/><path d="M80 40V26M80 40l10 8M74 10h12M80 10v6"/><rect x="40" y="70" width="22" height="12" rx="2"/><rect x="69" y="62" width="22" height="20" rx="2"/><rect x="98" y="74" width="22" height="8" rx="2"/></svg>`,
  program: `<svg viewBox="0 0 160 96" aria-hidden="true"><circle cx="36" cy="72" r="6"/><circle cx="72" cy="52" r="5"/><circle cx="104" cy="34" r="5"/><path d="M42 68c10-6 18-10 26-14M77 49c8-4 16-8 23-12M110 30l12-6" stroke-dasharray="3 4"/><path d="M126 30V10l18 6-18 6"/></svg>`,
};

// Three ticked lines per kind, read from the kind's wire POLICY (never from the
// kind's name), so a policy change rewrites the card.
function _kindBullets(k) {
  const p = policyOrDefault(k.policy);
  const lines = [
    p.schedule === 'deadline' ? 'Open until a deadline; people go at their own pace' : 'Runs for a set time',
    p.ranking_enabled !== false ? 'Ranked leaderboard and a podium' : 'No ranking; completion certificates',
    p.late_entry === 'allowed' ? 'Walk-ups join by QR; late entries after the end'
      : p.sessions === 'many' ? 'Run it once or in several sessions' : 'One open window for everyone',
  ];
  return `<ul class="tpl-kind-bullets">${lines.map(l => `<li>${ICO.check}<span>${esc(l)}</span></li>`).join('')}</ul>`;
}

// The kind's RECOMMENDED SETUP: its built-in template, or null while the list
// is unread or when none is listed for the kind (missing, or edited to
// another type). Matched by type, the wire carrying no key-to-kind table.
function _builtinFor(kind) {
  return (_templates || []).find(t => t.is_builtin && t.event_kind === kind) || null;
}

// ONE CARD PER EVENT TYPE. The card itself is no button (its bullet list is
// no button content, and it holds two starts): its controls are the buttons
// in its foot, each named from the words it shows first.
//   • Recommended setup — the kind's built-in, offered to a role that may read
//     templates and start from one (`templates.view`, `events.clone`); shown
//     disabled while the list is read, so the card does not move when it lands.
//   • Start blank — a role holding `events.create` (the built-in event admin
//     lacks it: spawning a template or cloning an event is how their tier makes
//     one).
// A role that may manage templates gets the built-in's own doors in the card's
// ⋮ menu (Edit, Duplicate, Reset to default): the list below shows only the
// templates organisers made.
function _kindCards() {
  const kinds = Array.isArray(S.eventKinds) ? S.eventKinds : [];
  const canBlank = adminCan('events.create');
  const canRec = adminCan('templates.view') && adminCan('events.clone');
  if (!canBlank && !canRec) return '';
  if (!kinds.length) return '<p class="ws-empty">The event-type list did not load. Reload the page to start a new event.</p>';
  const manage = adminCan('templates.manage');
  return kinds.map(k => {
    const rec = canRec ? _builtinFor(k.value) : null;
    const waiting = canRec && !rec && _templates === null && !_templatesFailed;
    if (!canBlank && !rec && !waiting) return '';
    const kindName = eventKindPhraseClient(k.value) || k.label;   // "a Booth Event": the table's article
    const recBtn = rec
      ? `<button type="button" class="btn sm tpl-kind-rec" data-action="tpl-pick" data-tpl-id="${esc(rec.id)}" aria-label="Recommended setup — start ${esc(kindName)} from ${esc(rec.name)}"${_picked && _picked.id === rec.id ? ' aria-current="true"' : ''}>Recommended setup</button>`
      : waiting ? '<button type="button" class="btn sm tpl-kind-rec" disabled aria-label="Recommended setup — loading">Recommended setup</button>' : '';
    const blankBtn = canBlank
      ? `<button type="button" class="btn sm secondary tpl-kind-blank" data-action="new-event-start" data-kind="${esc(k.value)}" aria-label="Start blank — an empty ${esc(k.label)} with nothing set up">Start blank</button>`
      : '';
    const more = rec && manage ? `<button type="button" class="kebab-btn kebab-always tpl-kind-more" data-action="kebab-toggle" aria-label="More actions for the ${esc(k.label)} recommended setup">⋮</button><div class="kebab-menu">
        <button data-action="tpl-edit" data-tpl-id="${esc(rec.id)}">${ICO.edit} Edit recommended setup</button>
        <button data-action="tpl-duplicate" data-tpl-id="${esc(rec.id)}">${ICO.copy} Duplicate as a template</button>
        <button data-action="tpl-reset" data-tpl-id="${esc(rec.id)}">${ICO.refresh} Reset to default</button>
      </div>` : '';
    const about = rec ? `<p class="tpl-kind-rec-about"><b>${esc(rec.name)}</b>${rec.description ? ` · ${esc(rec.description)}` : ''}</p>` : '';
    return `<div class="tpl-kind${_picked && rec && _picked.id === rec.id ? ' active' : ''}" data-kind="${esc(k.value)}">
      <span class="tpl-kind-art">${KIND_ART[k.value] || ''}</span>
      <div class="tpl-kind-body">
        <div class="tpl-kind-head"><h4 class="tpl-kind-title">${esc(k.label)}</h4>${more}</div>
        ${k.isDefault ? '<span class="tpl-kind-default">Most common</span>' : ''}${_kindBullets(k)}
        ${about}
        <div class="tpl-kind-actions">${recBtn}${blankBtn}</div>
      </div>
    </div>`;
  }).join('');
}

function _renderKindCards() {
  const kinds = document.getElementById('tpl-kind-cards');
  if (!kinds) return;
  setSafeHtml(kinds, _kindCards()); kinds.hidden = !kinds.innerHTML.trim();
  const head = document.getElementById('tpl-blank-head');
  if (head) head.hidden = kinds.hidden;
}

// The row icon, from the kind's wire POLICY (never its stored value): a
// deadline kind gets the flag, a kind that takes walk-ups after the end the
// stand, every other the clock.
function _tplIcon(kind) {
  const p = policyOrDefault((_kindOf(kind) || {}).policy);
  return p.schedule === 'deadline' ? ICO.flag : p.late_entry === 'allowed' ? ICO.grid : ICO.clock;
}

function _tplRow(t) {
  // No label, no kind words: a stored value is never a caption (a wrong chip
  // is worse than none).
  const kind = eventKindLabel(t.event_kind);
  const meta = [kind, `${t.task_count} challenge${t.task_count === 1 ? '' : 's'}`].filter(Boolean);
  if (t.withheld_task_count) meta.push(`${t.withheld_task_count} not visible to you`);
  if (t.missing_task_count) meta.push(`${t.missing_task_count} deleted`);
  const on = _picked && _picked.id === t.id;
  // The badge says why a template has no Delete: a protected one waits for a
  // global admin to unprotect it. (A built-in is never a row: it is its kind
  // card's recommended setup, `_kindCards`.)
  const badges = t.protected ? `<span class="tpl-badge tpl-badge-protected">${ICO.lock} Protected</span>` : '';
  // The delete door and its explanation come from the server's own predicate
  // (`can_delete` / `delete_refused`), never re-derived here.
  const protTo = t.protected ? "0" : "1";
  const protLabel = t.protected ? "Unprotect" : "Protect";
  const del = t.can_delete === false
    ? `<span class="kebab-note">${ICO.lock}<span>${esc(t.delete_refused || 'This template cannot be deleted.')}</span></span>`
    : `<button class="km-danger" data-action="tpl-delete" data-tpl-id="${esc(t.id)}">${ICO.trash} Delete</button>`;
  // RBAC — every start from a template is a spawn (`events.clone`): for a role
  // without it the row lists the template, and is not a door it would be refused
  // at (the list's note says why, _renderList).
  const canStart = adminCan('events.clone');
  return `<div class="tpl-row${on ? ' active' : ''}">
    <div class="tpl-row-main"${canStart ? ` data-action="tpl-pick" data-tpl-id="${esc(t.id)}"` : ''}>
      <span class="tpl-row-ico" aria-hidden="true">${_tplIcon(t.event_kind)}</span>
      <span class="tpl-row-txt"><b>${canStart ? `<button type="button" class="card-open" data-action="tpl-pick" data-tpl-id="${esc(t.id)}" aria-label="${esc(t.name)} — start an event from this template"${on ? ' aria-current="true"' : ''}>${esc(t.name)}</button>` : esc(t.name)}</b>${badges ? `<span class="tpl-badges">${badges}</span>` : ''}<small>${esc(meta.join(' · '))}</small>${t.description ? `<small class="tpl-row-desc">${esc(t.description)}</small>` : ''}</span>
      <span class="tpl-row-when">Updated ${esc(fmtDt(t.updated_at, 'short'))}</span>
      ${canStart ? `<span class="tpl-row-chev" aria-hidden="true">${ICO.chevronRight}</span>` : ''}
    </div>
    ${adminCan('templates.manage') ? `<button type="button" class="kebab-btn kebab-always tpl-row-more" data-action="kebab-toggle" aria-label="More actions for template ${esc(t.name)}">⋮</button><div class="kebab-menu">
      <button data-action="tpl-edit" data-tpl-id="${esc(t.id)}">${ICO.edit} Edit</button>
      <button data-action="tpl-duplicate" data-tpl-id="${esc(t.id)}">${ICO.copy} Duplicate</button>
      <button data-action="tpl-protect" data-tpl-id="${esc(t.id)}" data-protect="${protTo}">${ICO.lock} ${protLabel}</button>
      <div class="km-sep" role="separator"></div>
      ${del}
    </div>` : ''}
  </div>`;
}

export async function loadTemplatesPane() {
  _renderKindCards();
  // Making and changing templates needs `templates.manage` (held server-side).
  const nb = document.getElementById('tpl-new-btn');
  if (nb) nb.hidden = !adminCan('templates.manage');
  const list = document.getElementById('tpl-list');
  if (!list) return;
  // RBAC — the list is a `templates.view` read. The page also opens for a role
  // that may only start blank events (`events.create`, ui/nav.js
  // ADMIN_NAV_PERMISSIONS): it is told so in the list's place, and nothing is read.
  if (!adminCan('templates.view')) {
    _templates = null;
    const count = document.getElementById('tpl-list-count'); if (count) count.textContent = '';
    setSafeHtml(list, '<p class="ws-empty" id="tpl-list-unseen">Your role cannot see templates. Start a blank event above.</p>');
    _loadDeleted();
    return;
  }
  const seq = ++_loadSeq;
  if (!_templates) setSafeHtml(list, '<p class="ws-empty">Loading templates…</p>');
  const d = await fetchJsonObject('/api/admin/event-templates');
  if (seq !== _loadSeq) return;
  if (!d || !Array.isArray(d.templates)) {
    // The kind cards drop their waiting Recommended setup and keep Start blank.
    _templatesFailed = true;
    _renderKindCards();
    setSafeHtml(list, `<div class="load-failure" role="alert">Could not load the templates. <button type="button" class="btn sm secondary" data-action="tpl-reload">Try again</button></div>`);
    return;
  }
  _templatesFailed = false;
  _templates = d.templates;
  _renderList();
  if (_picked) { const again = _templates.find(t => t.id === _picked.id); if (again) _picked = again; else _closeSpin(); }
  _loadDeleted();
}

// ── RECENTLY DELETED: one button puts a template back ────────────────────────
//
// Deleting a template is a soft delete; for the server's restore window it is
// listed here with a Restore button. A built-in deleted before built-ins were
// protected gets "Restore built-in templates". Global admins only (the routes
// are held twice), so an event admin gets nothing here.
let _delSeq = 0;
async function _loadDeleted() {
  const box = document.getElementById('tpl-deleted');
  if (!box) return;
  // The list and its restores are `templates.manage` routes: a role without it
  // sends no read (a refused one would paint "Could not load" on every visit).
  if (!adminCan('templates.manage')) { box.hidden = true; setSafeHtml(box, ''); return; }
  const seq = ++_delSeq;
  const d = await fetchJsonObject('/api/admin/event-templates/deleted');
  if (seq !== _delSeq) return;
  if (!d || !Array.isArray(d.templates)) {
    box.hidden = false;
    setSafeHtml(box, `<div class="load-failure" role="alert">Could not load recently deleted templates. <button type="button" class="btn sm secondary" data-action="tpl-reload">Try again</button></div>`);
    return;
  }
  const missing = Array.isArray(d.missing_builtins) ? d.missing_builtins : [];
  if (!d.templates.length && !missing.length) { box.hidden = true; setSafeHtml(box, ''); return; }
  box.hidden = false;
  const days = Number.isInteger(d.restore_days) ? Number(d.restore_days) : null;
  setSafeHtml(box, `<div class="tpl-list-head"><h3 class="tpl-list-title">Recently deleted</h3><span data-help="templates.deleted" data-help-label="Recently deleted"></span></div>
    ${days ? `<p class="tpl-deleted-note">Deleted templates can be restored for ${days} days, then they are removed for good.</p>` : ''}
    <div class="tpl-deleted-list">${d.templates.map(t => `<div class="tpl-deleted-row">
      <span class="tpl-row-txt"><b>${esc(t.name)}</b><small>${esc([eventKindLabel(t.event_kind), `deleted ${fmtDt(t.deleted_at, 'short')}`].filter(Boolean).join(' · '))}${t.purge_at ? ` · removed for good ${esc(fmtDt(t.purge_at, 'short'))}` : ''}</small></span>
      <button type="button" class="btn sm secondary" data-action="tpl-restore" data-tpl-id="${esc(t.id)}">Restore ${esc(t.name)}</button>
    </div>`).join('')}</div>
    ${missing.length ? `<div class="tpl-deleted-row"><span class="tpl-row-txt"><b>Built-in templates missing</b><small>${esc(missing.join(', '))}</small></span><button type="button" class="btn sm secondary" data-action="tpl-restore-builtins">Restore built-in templates</button></div>` : ''}`);
}

async function _tplPost(url, body) {
  let r = null, d = {};
  try { r = await fetch(url, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  return { ok: !!(r && r.ok), d };
}

export async function restoreTemplate(id) {
  const { ok, d } = await _tplPost(`/api/admin/event-templates/${encodeURIComponent(id)}/restore`);
  if (!ok) { showToast((d && d.error) || 'Could not restore the template.', 'error'); return; }
  showToast(`Restored template “${d.template ? d.template.name : ''}”.`, 'success');
  loadTemplatesPane();
}

export async function restoreBuiltinTemplates() {
  const { ok, d } = await _tplPost('/api/admin/event-templates/restore-builtins');
  if (!ok) { showToast((d && d.error) || 'Could not restore the built-in templates.', 'error'); return; }
  const n = Array.isArray(d.restored) ? d.restored.length : 0;
  showToast(n ? `Restored ${n} built-in template${n === 1 ? '' : 's'}.` : 'Every built-in template is already there.', 'success');
  loadTemplatesPane();
}

export async function protectTemplate(id, on) {
  const t = (_templates || []).find(x => x.id === id);
  const { ok, d } = await _tplPost(`/api/admin/event-templates/${encodeURIComponent(id)}/protect`, { protected: !!on });
  if (!ok) { showToast((d && d.error) || 'Could not change the protection.', 'error'); return; }
  showToast(on ? `“${t ? t.name : 'Template'}” is protected: nobody can delete it until it is unprotected.` : `“${t ? t.name : 'Template'}” is no longer protected.`, 'success');
  loadTemplatesPane();
}

export async function resetTemplate(id) {
  const t = (_templates || []).find(x => x.id === id);
  if (!t) return;
  const ok = await showModal({ title: 'Reset to default', message: `Reset <strong>${esc(t.name)}</strong> to the template the platform ships? Its name, description, type and settings go back to the defaults, and its challenge list is emptied. Events already made from it are not affected.`, confirmText: 'Reset' });
  if (!ok) return;
  const r = await _tplPost(`/api/admin/event-templates/${encodeURIComponent(id)}/reset`);
  if (!r.ok) { showToast((r.d && r.d.error) || 'Could not reset the template.', 'error'); return; }
  showToast(`Reset “${r.d.template ? r.d.template.name : t.name}” to its default.`, 'success');
  loadTemplatesPane();
}

// "Your templates": the templates organisers made. The built-ins are each
// kind's recommended setup, on the cards above (`_kindCards`), never listed
// twice.
function _renderList() {
  _renderKindCards();
  const list = document.getElementById('tpl-list');
  const count = document.getElementById('tpl-list-count');
  if (!list) return;
  const own = (_templates || []).filter(t => !t.is_builtin);
  if (count) count.textContent = own.length ? `${own.length} template${own.length === 1 ? '' : 's'}` : '';
  if (!own.length) {
    setSafeHtml(list, `<p class="ws-empty" id="tpl-list-empty">No templates of your own yet.${!adminCan('templates.manage') ? '' : ' Choose <strong>New template</strong>, or open an event and choose <strong>Save as template</strong> from its ⋯ menu.'}</p>`);
    return;
  }
  // A role that may see templates but not start events from them is told so
  // once, above the list, rather than meeting rows that do nothing.
  const why = adminCan('events.clone') ? '' : '<p class="ws-empty" id="tpl-no-start">Your role can see templates, not start events from them.</p>';
  setSafeHtml(list, why + own.map(_tplRow).join(''));
}

/** Open the quick spin for one template. */
export async function pickTemplate(id) {
  const t = (_templates || []).find(x => x.id === id);
  if (!t) return;
  // A global admin gets the ONE create form, seeded from the template; saving
  // spawns the template (challenges, join link) and applies the form on top.
  // An event admin's only door is the spawn itself, so they keep the quick
  // start: a name and a start time.
  // RBAC — every start from a template is a spawn (`events.clone`); the ONE
  // create form also saves the form onto the new event (`events.edit`), and is
  // the global admin's path (`events.create`). Anyone else gets the quick spin.
  if (!adminCan('events.clone')) { showToast('Your role cannot start an event from a template. Ask an administrator to change your role.', 'error'); return; }
  if (adminCan('events.create') && adminCan('events.edit')) {
    if (_picked) _closeSpin();
    openCompetitionForm(null, { kind: t.event_kind, template: t });
    return;
  }
  _picked = t;
  _renderList();
  const panel = document.getElementById('tpl-spin');
  if (!panel) return;
  const start = new Date(Date.now() + 24 * 3600e3); start.setMinutes(0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
  const time = `${p(start.getHours())}:${p(start.getMinutes())}`;
  const settings = t.settings || {};
  // What the event WILL do: a setting the template leaves out takes the kind's
  // seed (`_tplSetting`), exactly as the spawn decides it.
  const facts = [
    t.task_count ? `${t.task_count} challenge${t.task_count === 1 ? '' : 's'}` : 'No challenges yet: add them in the workspace',
    _tplSetting(settings, t.event_kind, 'self_enroll_enabled') ? 'Join link and QR code ready' : null,
    settings.duration_minutes ? `Runs for ${settings.duration_minutes >= 60 ? `${Math.round(settings.duration_minutes / 6) / 10} h` : `${settings.duration_minutes} min`}` : null,
    (settings.tags || []).length ? `Tags: ${(settings.tags || []).join(', ')}` : null,
  ].filter(Boolean);
  const off = _tplSetting(settings, t.event_kind, 'cxone_disabled') ? ['Checkmarx One accounts stay off'] : [];
  // "Add the qualifying questions", seeded from the kind as on the create form
  // (`defaults.add_qualifying`, on for a Booth Event). Not offered where staff
  // compete: that event holds sealed challenges only, and the spawn refuses them.
  const kindSeed = _kindSeed(t.event_kind, 'add_qualifying');
  const qBox = settings.staff_compete ? '' : `<label class="checkbox-row tpl-spin-qualifying"><input type="checkbox" id="tpl-spin-qualifying"${kindSeed ? ' checked' : ''}/> Add the qualifying questions</label>`;
  const kindLabel = eventKindLabel(t.event_kind);
  setSafeHtml(panel, `<div class="tpl-spin-grip" aria-hidden="true"></div>
    <p class="eyebrow gold">Quick spin</p>
    <h3 id="tpl-spin-title" class="tpl-spin-title">${esc(t.name)}</h3>
    <p class="tpl-spin-from">${esc([kindLabel, t.description || ''].filter(Boolean).join(' · '))}</p>
    <div class="tpl-rule" aria-hidden="true"><span></span></div>
    <form id="tpl-spin-form" novalidate>
      <div class="form-group"><label for="tpl-spin-name">Event name</label><input id="tpl-spin-name" type="text" maxlength="120" required value="${esc(t.name)}"/></div>
      <label class="checkbox-row tpl-spin-now"><input type="checkbox" id="tpl-spin-now"/> Opens now</label>
      <div class="tpl-spin-when">
        <div class="form-group"><label for="tpl-spin-date">Date</label><input id="tpl-spin-date" type="date" value="${esc(date)}"/></div>
        <div class="form-group"><label for="tpl-spin-time">Opens</label><input id="tpl-spin-time" type="time" value="${esc(time)}"/></div>
      </div>
      ${qBox}
      <ul class="tpl-spin-facts">${facts.map(f => `<li>${ICO.check}<span>${esc(f)}</span></li>`).join('')}${off.map(f => `<li class="off">${ICO.x}<span>${esc(f)}</span></li>`).join('')}</ul>
      <p class="ws-dialog-err" id="tpl-spin-err" role="alert"></p>
      <p class="tpl-spin-foot">Opens in the event workspace, ready to share. Times are your local time.</p>
      <div class="modal-foot tpl-spin-actions"><button type="button" class="btn secondary tpl-spin-cancel" data-action="tpl-spin-close">Cancel</button><button type="submit" class="btn gold tpl-spin-go">${ICO.zap} Create event</button></div>
    </form>`);
  panel.hidden = false;
  document.getElementById('admin-templates-tab')?.classList.add('tpl-spinning');
  // On a phone the panel is a sheet over the page, behind a scrim (styles.css
  // "admin: phone layout"): a modal, so it keeps the modal contract — Escape
  // closes it, Tab stays inside it, and focus returns to the template picked.
  // Beside the list on a wider screen it is not a modal, and takes none of it.
  // Either way its buttons are the dialog order, Cancel then Create, in a row
  // (operator ruling, 14 Nov 2026: no recorded exception).
  if (!_spinModal && window.matchMedia && window.matchMedia('(max-width:768px)').matches) {
    _spinModal = overlayDismiss(panel, () => closeTemplateSpin());
    // ...and says so: a modal dialog, named by its title (aria-labelledby).
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
  }
  panel.querySelector('#tpl-spin-form').addEventListener('submit', (e) => { e.preventDefault(); _spin(t); });
  panel.querySelector('#tpl-spin-now')?.addEventListener('change', (e) => {
    const when = panel.querySelector('.tpl-spin-when');
    if (when) when.hidden = e.target.checked;
  });
  panel.querySelector('#tpl-spin-name')?.focus();
}

function _closeSpin() {
  _picked = null;
  // The sheet stays in the DOM (hidden), so its Escape entry and focus trap are
  // released here rather than by overlayDismiss's removal observer.
  if (_spinModal) { const done = _spinModal; _spinModal = null; done(); }
  const panel = document.getElementById('tpl-spin');
  if (panel) { panel.hidden = true; setSafeHtml(panel, ''); panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  document.getElementById('admin-templates-tab')?.classList.remove('tpl-spinning');
  _renderList();
}
// Focus goes back to the template's own button: the row's first tpl-pick match
// is its (unfocusable) card body, and the re-render replaced the opener.
// A built-in's opener is its kind card's Recommended setup, also a tpl-pick button.
export function closeTemplateSpin() { const id = _picked && _picked.id; _closeSpin(); if (id) document.querySelector(`button[data-action="tpl-pick"][data-tpl-id="${CSS.escape(id)}"]`)?.focus(); }

async function _spin(t) {
  const panel = document.getElementById('tpl-spin');
  const err = (m) => { const e = panel.querySelector('#tpl-spin-err'); if (e) e.textContent = m || ''; };
  const name = panel.querySelector('#tpl-spin-name').value.trim();
  const date = panel.querySelector('#tpl-spin-date').value;
  const time = panel.querySelector('#tpl-spin-time').value || '09:00';
  if (!name) { err('Give the event a name.'); panel.querySelector('#tpl-spin-name').focus(); return; }
  const body = { name };
  // Sent whenever the box is offered: an absent value means none (the spawn).
  const qBox = panel.querySelector('#tpl-spin-qualifying');
  if (qBox) body.add_qualifying = !!qBox.checked;
  // "Opens now": a new event must start in the future, so it opens in a minute
  // and runs for the template's own duration from then.
  if (panel.querySelector('#tpl-spin-now')?.checked) body.start_time = new Date(Date.now() + 60_000).toISOString();
  else if (date) {
    // A time inside the hour the clocks skip is refused (the event form's
    // rule), never stored as the nearest real instant.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const chk = wallClockToUtcChecked(date, time, tz);
    if (!chk.date || isNaN(chk.date)) { err('That date or time is not valid.'); return; }
    if (!chk.exists) { err(dstGapMessage(time, tz)); panel.querySelector('#tpl-spin-time')?.focus(); return; }
    body.start_time = chk.date.toISOString();
  }
  const go = panel.querySelector('.tpl-spin-go');
  go.disabled = true;
  let r = null, d = {};
  try { r = await fetch(`/api/admin/event-templates/${encodeURIComponent(t.id)}/spawn`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  go.disabled = false;
  // No answer: the spawn may have reached the server and made the event.
  if (!r) { err('No answer came back from the server, so the event may or may not have been made. Check the Events list before you try again.'); return; }
  if (!r.ok || !d.competition) { err((d && d.error) || 'Could not create the event.'); return; }
  const skipped = Array.isArray(d.skipped_challenges) ? d.skipped_challenges : [];
  showToast(`Created “${d.competition.name}” with ${d.assigned_challenges || 0} challenge${d.assigned_challenges === 1 ? '' : 's'}.${skippedSummary(skipped)}`, skipped.length ? 'info' : 'success');
  _closeSpin();
  await loadAdminCompetitions();
  openEventWorkspace(d.competition.id, d.competition.name);
}

export async function deleteTemplate(id) {
  const t = (_templates || []).find(x => x.id === id);
  if (!t) return;
  const ok = await showModal({ title: 'Delete template', message: `Delete the template <strong>${esc(t.name)}</strong>? It moves to <strong>Recently deleted</strong>, where one button restores it. Events already made from it are not affected.`, confirmText: 'Delete', confirmClass: 'danger' });
  if (!ok) return;
  let r = null, d = {};
  try { r = await fetch(`/api/admin/event-templates/${encodeURIComponent(id)}`, { method: 'DELETE', headers: csrfHeaders() }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  if (!r || !r.ok) { showToast((d && d.error) || 'Could not delete the template.', 'error'); return; }
  if (_picked && _picked.id === id) _closeSpin();
  showToast(`Deleted template “${t.name}”. Restore it from Recently deleted.`, 'success');
  loadTemplatesPane();
}

// ── THE TEMPLATE EDITOR ──────────────────────────────────────────────────────
//
// A template from scratch, an edit, or a duplicate (a copy saved as new). The
// fields are the server's template settings (`TEMPLATE_SETTINGS_SCHEMA`,
// routes/competitions.js), grouped as an organiser thinks of an event: Basics,
// Joining, Play, Scoring & boards, Challenges, Certificates. Every option the
// chosen kind's POLICY forbids is shown DISABLED with the reason (never hidden,
// never sent): the server refuses the same options with the create codes, so
// the offer and the refusal cannot disagree. A live summary reads the form.
// Global admins only (the routes are held twice: `requireGlobalAdmin` and
// `EVENT_ADMIN_FORBIDDEN`), so nothing here is offered to an event admin.

const REG_FIELDS = [
  ['personal_title', 'Salutation'], ['phone', 'Phone'], ['city', 'City'],
  ['linkedin_url', 'LinkedIn profile URL'], ['job_function', 'Job function'],
];
const REG_STATES = [['required', 'Required'], ['optional', 'Optional'], ['hidden', 'Off']];
let _edSeq = 0;
let _libTasks = null;   // the challenge library, read afresh at every editor open

// THE SETTINGS WHOSE ABSENCE MEANS "THE KIND'S CREATE SEED" (the server's
// `=== undefined` branch, `_bpResolve`): a Booth Event's walk-up join link and
// its Checkmarx One opt-out are on, a Program's opt-out is on, and so on. The
// editor SHOWS one a template leaves out as the chosen kind's seed (the wire's
// `defaults`), re-seeds it when the kind changes, and SENDS it only once the
// organiser changes it or the template already stores it — never as an
// explicit value the kind never chose (which turned Checkmarx One accounts on
// for every Booth Event made from an edited built-in).
const SEEDED_KEYS = Object.freeze(['self_enroll_enabled', 'cxone_disabled', 'late_entry_enabled']);

function _kindOf(value) {
  return (Array.isArray(S.eventKinds) ? S.eventKinds : []).find(k => k.value === value) || null;
}

/** The kind's create-time seed for one setting (the wire's `defaults`). */
function _kindSeed(kind, key) {
  const k = _kindOf(kind);
  return !!(k && k.defaults && k.defaults[key]);
}

/** What a template's setting does: its stored value, else the kind's seed. */
function _tplSetting(settings, kind, key) {
  return Object.prototype.hasOwnProperty.call(settings || {}, key) ? !!settings[key] : _kindSeed(kind, key);
}

/** Why the kind forbids an option, or '' when it is allowed. */
function _forbidReason(key, kind) {
  const k = _kindOf(kind);
  // No type chosen yet: nothing is judged against a type nobody picked (the
  // save is refused until one is, `_saveEditor`).
  if (!k) return '';
  const p = policyOrDefault(k && k.policy);
  const label = (k && k.label) || 'This event type';
  const presence = () => (p.measure_presence === 'forbidden' ? `${label} does not record time on the platform.` : '');
  const reasons = {
    reveal_answers_on_end: () => (p.reveal_answers === 'forbidden' ? `${label} never publishes answers: a moved deadline would hand everyone the key.` : ''),
    group_leaderboard_enabled: () => (p.group_leaderboard === 'forbidden' ? `${label} has no team board.` : ''),
    measure_presence: presence,
    time_basis: presence,
    late_entry_enabled: () => (p.late_entry !== 'allowed' ? `Only a Booth Event takes late entries after it ends.` : ''),
    registration_fields: () => (p.registration_fields_configurable === true ? '' : `${label} always asks the short sign-up form.`),
    leaderboard_mode: () => (p.sessions === 'many' ? '' : `${label} runs in one sitting, so there is one board.`),
  };
  // An unknown key has no refusal (never an exception).
  return Object.prototype.hasOwnProperty.call(reasons, key) ? reasons[key]() : '';
}

export function newTemplate() { _openEditor(null, 'new'); }
export function editTemplate(id) { _openEditor(id, 'edit'); }
export function duplicateTemplate(id) { _openEditor(id, 'copy'); }

async function _openEditor(id, mode) {
  if (!adminCan('templates.manage')) return;
  const seq = ++_edSeq;
  let t = null;
  if (id) {
    const d = await fetchJsonObject(`/api/admin/event-templates/${encodeURIComponent(id)}`);
    if (seq !== _edSeq) return;
    if (!d || !d.template) { showToast('Could not load the template.', 'error'); return; }
    t = d.template;
  }
  // Read at every open, never kept for the page's life: a challenge published
  // (or unpublished) since the last open must be offered (or not) now. Only a
  // role that may read the library asks for it (a refused read toasts and counts
  // towards the address's scanner block): without challenges.view the editor
  // shows the template's own challenges, read-only, and says why no picker.
  const canLib = adminCan('challenges.view');
  const lib = canLib ? await fetchJsonList('/api/admin/tasks') : null;
  if (seq !== _edSeq) return;
  _libTasks = lib;
  const kinds = Array.isArray(S.eventKinds) ? S.eventKinds : [];
  if (!kinds.length) { showToast('The event-type list did not load. Reload the page.', 'error'); return; }
  // NO PRE-SELECTED TYPE (operator ruling, 14 Nov 2026): New template opens on
  // "Choose a type…", and the save is refused until one is picked; the seeded
  // boxes fill in from the type once it is. An edit or a duplicate keeps the
  // template's own type; one the vocabulary does not know is shown as no choice
  // rather than as whichever type happens to come first.
  const kind0 = (t && kinds.some(k => k.value === t.event_kind)) ? t.event_kind : '';
  const s = (t && t.settings) || { duration_minutes: 60 };
  const state = {
    mode, id: mode === 'edit' && t ? t.id : null, updatedAt: mode === 'edit' && t ? t.updated_at : null,
    noLib: !canLib,
    refused: null,   // the save's refusal naming a listed challenge: {id, message}
    tasks: ((t && t.tasks) || []).map(x => ({ id: x.id, title: x.title, difficulty: x.difficulty })),
    // The seeded settings this template states for itself (see SEEDED_KEYS).
    explicit: new Set(SEEDED_KEYS.filter(k => Object.prototype.hasOwnProperty.call(s, k))),
  };
  document.getElementById('tpl-editor')?.remove();
  const ov = document.createElement('div');
  ov.id = 'tpl-editor';
  ov.className = 'ws-dialog-overlay tpl-editor-overlay';
  const title = mode === 'edit' ? 'Edit template' : mode === 'copy' ? 'Duplicate template' : 'New template';
  const name0 = t ? (mode === 'copy' ? `${t.name} (copy)` : t.name).slice(0, 120) : '';
  const chk = (key, label) => `<label class="checkbox-row tpl-ed-opt" data-opt="${key}"><input type="checkbox" id="tpl-ed-${key}"${(SEEDED_KEYS.includes(key) ? _tplSetting(s, kind0, key) : s[key]) ? ' checked' : ''}/> <span>${esc(label)}</span></label><p class="tpl-ed-why" data-why="${key}" hidden></p>`;
  const regRows = REG_FIELDS.map(([k, label]) => `<div class="tpl-ed-reg-row"><span>${esc(label)}</span><span class="seg-group" role="radiogroup" aria-label="${esc(label)}">${REG_STATES.map(([v, vl]) =>
    `<label class="tpl-ed-seg"><input type="radio" name="tpl-ed-reg-${k}" value="${v}"${((s.registration_fields || {})[k] || DEFAULT_REGISTRATION_FIELDS[k]) === v ? ' checked' : ''}/> ${esc(vl)}</label>`).join('')}</span></div>`).join('');
  setSafeHtml(ov, `<form class="card ws-dialog tpl-editor" role="dialog" aria-modal="true" aria-labelledby="tpl-ed-title" novalidate>
    <h3 id="tpl-ed-title" class="modal-title">${esc(title)}</h3>
    <div class="tpl-ed-body">
      <div class="tpl-ed-main">
        <fieldset class="tpl-ed-group"><legend class="t-eyebrow">Basics</legend>
          <div class="form-group"><label for="tpl-ed-name">Template name</label><input id="tpl-ed-name" type="text" maxlength="120" required value="${esc(name0)}"/></div>
          <div class="form-group"><label for="tpl-ed-desc">Description <span class="t-muted">(optional)</span></label><textarea id="tpl-ed-desc" rows="2" maxlength="1000">${esc((t && t.description) || '')}</textarea></div>
          <div class="form-group"><label for="tpl-ed-kind">Event type</label><select id="tpl-ed-kind">${kind0 ? '' : '<option value="" selected disabled>Choose a type…</option>'}${kinds.map(k => `<option value="${esc(k.value)}"${k.value === kind0 ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select></div>
          <div class="form-group"><label for="tpl-ed-tags">Tags <span class="t-muted">(comma separated)</span></label><input id="tpl-ed-tags" type="text" maxlength="400" value="${esc((s.tags || []).join(', '))}"/></div>
        </fieldset>
        <fieldset class="tpl-ed-group"><legend class="t-eyebrow">Joining</legend>
          ${chk('self_enroll_enabled', 'Join link and QR code on')}
          ${chk('late_entry_enabled', 'Take late entries after it ends')}
          <div class="tpl-ed-opt" data-opt="registration_fields"><p class="t-section">Sign-up fields</p><div class="tpl-ed-reg">${regRows}</div></div>
          <p class="tpl-ed-why" data-why="registration_fields" hidden></p>
        </fieldset>
        <fieldset class="tpl-ed-group"><legend class="t-eyebrow">Play</legend>
          <div class="form-group"><label for="tpl-ed-duration" id="tpl-ed-duration-label">Runs for (minutes)</label><input id="tpl-ed-duration" type="number" min="1" step="1" value="${esc(String(s.duration_minutes || 60))}"/></div>
          <div class="form-group"><label for="tpl-ed-cap">Attempts per challenge <span class="t-muted">(empty: unlimited)</span></label><input id="tpl-ed-cap" type="number" min="1" max="1000" step="1" value="${s.attempt_cap ? esc(String(s.attempt_cap)) : ''}"/></div>
          ${chk('staff_compete', 'Staff compete (their scores count)')}
          ${chk('cxone_disabled', 'Do not create Checkmarx One accounts')}
        </fieldset>
        <fieldset class="tpl-ed-group"><legend class="t-eyebrow">Scoring &amp; boards</legend>
          ${chk('reveal_answers_on_end', 'Show the answers when it ends')}
          ${chk('group_leaderboard_enabled', 'Team leaderboard')}
          ${chk('measure_presence', 'Record time on the platform')}
          <div class="form-group tpl-ed-opt" data-opt="time_basis"><label for="tpl-ed-time_basis">Ties are broken by</label><select id="tpl-ed-time_basis"><option value="elapsed"${s.time_basis !== 'presence' ? ' selected' : ''}>Time since starting</option><option value="presence"${s.time_basis === 'presence' ? ' selected' : ''}>Time on the platform</option></select></div>
          <p class="tpl-ed-why" data-why="time_basis" hidden></p>
          <div class="form-group tpl-ed-opt" data-opt="leaderboard_mode"><label for="tpl-ed-leaderboard_mode">With sessions, the board is</label><select id="tpl-ed-leaderboard_mode"><option value="per_slot"${s.leaderboard_mode !== 'global' ? ' selected' : ''}>One board per session</option><option value="global"${s.leaderboard_mode === 'global' ? ' selected' : ''}>One board across sessions</option></select></div>
          <p class="tpl-ed-why" data-why="leaderboard_mode" hidden></p>
        </fieldset>
        <fieldset class="tpl-ed-group"><legend class="t-eyebrow">Challenges</legend>
          <p class="t-small t-muted tpl-ed-task-order">Events number their challenges by difficulty, then title.</p>
          <ul class="tpl-ed-tasks" id="tpl-ed-tasks"></ul>
          ${canLib ? `<div class="search-wrap"><input id="tpl-ed-task-search" type="text" autocomplete="off" placeholder="Find a published challenge by title or tag…" aria-label="Find a published challenge by title or tag"/></div>
          <div class="tpl-ed-task-bar"><p class="settings-help list-count" id="tpl-ed-task-count" role="status" aria-live="polite" aria-atomic="true"></p><button type="button" class="btn sm secondary" id="tpl-ed-task-addall" hidden>Add all shown</button></div>
          <ul class="tpl-ed-task-results" id="tpl-ed-task-results"></ul>`
          : '<p class="t-small t-muted" id="tpl-ed-task-unseen">Your role cannot view the challenge library, so it cannot add challenges here. The template keeps the challenges listed above unless you remove them.</p>'}
        </fieldset>
        <fieldset class="tpl-ed-group"><legend class="t-eyebrow">Certificates</legend>
          <p class="t-small">Events made from this template use the platform's certificate design. Give one event its own design from its <strong>Certificates</strong> section; the platform design is under <strong>Settings</strong>.</p>
        </fieldset>
      </div>
      <aside class="tpl-ed-summary card" aria-labelledby="tpl-ed-sum-title"><p class="t-eyebrow" id="tpl-ed-sum-title">Summary</p><ul id="tpl-ed-sum" class="tpl-spin-facts" aria-live="polite"></ul></aside>
    </div>
    <p class="ws-dialog-err" id="tpl-ed-err" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn secondary" data-tpl-ed-cancel>Cancel</button><button type="submit" class="btn">${mode === 'edit' ? 'Save template' : 'Create template'}</button></div>
  </form>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  overlayDismiss(ov, close);
  ov.querySelector('[data-tpl-ed-cancel]').addEventListener('click', close);
  const form = ov.querySelector('form');
  const sync = () => _syncEditor(ov, state);
  // A seeded setting the organiser changes is theirs from then on; one they
  // have not touched follows the chosen kind's seed. Both run before the
  // form's own listeners (the target before its ancestors), so the summary
  // reads the re-seeded boxes.
  for (const key of SEEDED_KEYS) {
    ov.querySelector(`#tpl-ed-${key}`)?.addEventListener('change', () => state.explicit.add(key));
  }
  ov.querySelector('#tpl-ed-kind').addEventListener('change', (e) => {
    for (const key of SEEDED_KEYS) {
      const box = ov.querySelector(`#tpl-ed-${key}`);
      if (box && !state.explicit.has(key)) box.checked = _kindSeed(e.target.value, key);
    }
  });
  // The save's note on a challenge row answers the form as it was saved. A
  // change the server judges the list against (the event type: whether a
  // challenge fits; Staff compete: whether it must be sealed) may have answered
  // it, so the note goes and the next save judges the list again.
  form.addEventListener('change', (e) => {
    if (state.refused && _REJUDGES_TASKS.has(e.target && e.target.id)) { state.refused = null; _renderTasks(ov, state); }
  });
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  const _taskSearch = ov.querySelector('#tpl-ed-task-search');
  _taskSearch?.addEventListener('input', () => _renderTaskResults(ov, state));
  // Enter in the search box must not submit the whole form.
  _taskSearch?.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  // Pick several at once: every challenge the search currently shows.
  ov.querySelector('#tpl-ed-task-addall')?.addEventListener('click', () => {
    for (const lt of _taskHits(ov, state)) if (!_competingIn(lt).length) state.tasks.push({ id: lt.id, title: lt.title, difficulty: lt.difficulty });
    _renderTasks(ov, state); _renderTaskResults(ov, state); sync();
  });
  // Removing needs no library read, so a role without challenges.view keeps it:
  // the save re-judges the whole stored list, and a challenge it refuses (one held
  // by an event the role competes in) could otherwise never leave the template.
  ov.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl-task]');
    if (!b) return;
    const tid = b.dataset.tplTask, op = b.dataset.op;
    const i = state.tasks.findIndex(x => x.id === tid);
    if (op === 'add' && i < 0 && !state.noLib) { const lt = (_libTasks || []).find(x => x.id === tid); if (lt && !_competingIn(lt).length) state.tasks.push({ id: lt.id, title: lt.title, difficulty: lt.difficulty }); }
    if (op === 'remove' && i >= 0) { state.tasks.splice(i, 1); if (state.refused && state.refused.id === tid) state.refused = null; }
    _renderTasks(ov, state); _renderTaskResults(ov, state); sync();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await _saveEditor(ov, state, close); } finally { if (document.body.contains(btn)) btn.disabled = false; }
  });
  _renderTasks(ov, state); _renderTaskResults(ov, state); sync();
  setTimeout(() => ov.querySelector('#tpl-ed-name')?.focus(), 0);
}

// THE ORDER IS THE PLATFORM'S, NEVER THE TEMPLATE'S (operator ruling, 14 Nov
// 2026). An event numbers its challenges when it goes live, by difficulty (easy,
// medium, hard) and then title (lib/competitions.js `_assignTaskNumbers`: one
// counter per difficulty, `ORDER BY t.difficulty, t.title`), and participants
// meet them in that order. So the editor lists a template's challenges in that
// order too, with no row numbers and nothing to reorder them: an order arranged
// here never reached anybody. The saved list follows the same order. A client
// copy of that rule (CLAUDE.md, *Client/server mirror registry*): change both.
const _DIFF_LEVEL = { easy: 1, medium: 2, hard: 3 };
// SQLite's BINARY collation (the numbering's `ORDER BY t.title`) compares UTF-8
// bytes, which is code-point order. JS's `<` compares UTF-16 code units, which
// put a character above U+FFFF before one in U+E000–U+FFFF.
function _byCodePoint(a, b) {
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done || y.done) return (x.done ? 0 : 1) - (y.done ? 0 : 1);
    const d = x.value.codePointAt(0) - y.value.codePointAt(0);
    if (d) return d;
  }
}
function _byDifficultyThenTitle(a, b) {
  const la = _DIFF_LEVEL[a.difficulty] || 4, lb = _DIFF_LEVEL[b.difficulty] || 4;
  if (la !== lb) return la - lb;
  return _byCodePoint(String(a.title || ''), String(b.title || ''));
}

// Operator ruling, 23 Nov 2026 (sweep #63): a challenge held by an event you
// compete in cannot be carried into a template. The library row says which
// events (`competing_in`, the server's answer); the picker shows such a
// challenge with the reason and offers no Add, and a template already holding
// one says to remove it (the save refuses it, 403 template_task_competing).
function _competingIn(t) { return Array.isArray(t && t.competing_in) ? t.competing_in : []; }
function _competingWhy(t, lead) {
  const names = _competingIn(t).map(c => `“${c.name}”`).join(', ');
  return `${lead}you compete in ${names}, which ${_competingIn(t).length === 1 ? 'holds' : 'hold'} it`;
}

// The editor's controls whose change re-judges the template's challenges.
const _REJUDGES_TASKS = new Set(['tpl-ed-kind', 'tpl-ed-staff_compete']);

function _renderTasks(ov, state) {
  const ul = ov.querySelector('#tpl-ed-tasks');
  if (!ul) return;
  state.tasks.sort(_byDifficultyThenTitle);
  const lib = (id) => (_libTasks || []).find(x => x.id === id);
  // Why a listed challenge stops the save: the library row's competing events when
  // the role reads the library, else the save's own refusal naming it (task_id).
  const why = (t) => _competingIn(lib(t.id)).length ? _competingWhy(lib(t.id), 'Remove it to save: ')
    : (state.refused && state.refused.id === t.id ? `${state.refused.message} Remove it to save.` : '');
  setSafeHtml(ul, state.tasks.length ? state.tasks.map((t) => `<li class="tpl-ed-task"><span class="tpl-ed-task-title">${esc(t.title || 'Challenge')}</span><small class="t-muted">${esc(t.difficulty || '')}</small>${why(t) ? `<small class="tpl-ed-why">${esc(why(t))}</small>` : ''}
      <button type="button" class="btn sm secondary" data-tpl-task="${esc(t.id)}" data-op="remove" aria-label="Remove ${esc(t.title || 'challenge')}">${ICO.x}</button></li>`).join('')
    : '<li class="ws-empty">No challenges yet: events start empty and you add them in the workspace.</li>');
}

// How many matches the picker lists at once; the count says when there are more.
const TASK_RESULTS_SHOWN = 12;

/** Published library challenges matching the search, not yet picked (all of them).
 *  A qualifying question is another event's own copy, so it is never offered
 *  (the save refuses one): an event made from the template gets its own
 *  through "Add the qualifying questions", as on the create form. */
function _taskMatches(ov, state) {
  const q = ov.querySelector('#tpl-ed-task-search')?.value || '';
  if (!Array.isArray(_libTasks) || !q.trim()) return [];
  const have = new Set(state.tasks.map(t => t.id));
  return _libTasks.filter(t => t.status === 'published' && !have.has(t.id) && !isQualifyingTask(t) && taskMatchesQuery(t, q));
}
/** The matches the list is showing. */
function _taskHits(ov, state) { return _taskMatches(ov, state).slice(0, TASK_RESULTS_SHOWN); }

function _renderTaskResults(ov, state) {
  const ul = ov.querySelector('#tpl-ed-task-results');
  if (!ul) return;
  const cnt = ov.querySelector('#tpl-ed-task-count');
  const addAll = ov.querySelector('#tpl-ed-task-addall');
  const paint = (text, n) => {
    if (cnt) cnt.textContent = text;
    if (addAll) { addAll.hidden = n < 2; addAll.textContent = `Add all ${n} shown`; }
  };
  if (!Array.isArray(_libTasks)) { setSafeHtml(ul, '<li class="ws-empty">Could not load the challenge library.</li>'); paint('', 0); return; }
  const q = ov.querySelector('#tpl-ed-task-search')?.value || '';
  if (!q.trim()) { setSafeHtml(ul, ''); paint('', 0); return; }
  const all = _taskMatches(ov, state);
  const hits = all.slice(0, TASK_RESULTS_SHOWN);
  // Each result shows its tags as chips; a tag the query matched is marked, so
  // the reason a challenge is listed is visible.
  const chips = (t) => (t.tags || []).map(tg => `<span class="tag${taskTagHit(tg, q) ? ' is-hit' : ''}">${esc(tg)}</span>`).join('');
  setSafeHtml(ul, hits.length ? hits.map(t => `<li><span class="tpl-ed-hit-title">${esc(t.title)}</span><small class="t-muted">${esc(t.difficulty || '')}</small><span class="tpl-ed-hit-tags">${chips(t)}</span>${_competingIn(t).length
      ? `<small class="tpl-ed-why">${esc(_competingWhy(t, 'Cannot be added: '))}</small>`
      : `<button type="button" class="btn sm" data-tpl-task="${esc(t.id)}" data-op="add" aria-label="Add ${esc(t.title)}">Add</button>`}</li>`).join('')
    : '<li class="ws-empty">No published challenge matches that title or tag.</li>');
  paint(all.length > hits.length ? `${hits.length} of ${all.length} matches shown; type more to narrow.` : `${all.length} match${all.length === 1 ? '' : 'es'}.`, hits.filter(t => !_competingIn(t).length).length);
}

function _syncEditor(ov, state) {
  const kind = ov.querySelector('#tpl-ed-kind').value;
  const k = _kindOf(kind);
  const p = policyOrDefault(k && k.policy);
  // Policy-forbidden options: disabled, with the reason beside them.
  for (const key of ['reveal_answers_on_end', 'group_leaderboard_enabled', 'measure_presence', 'late_entry_enabled', 'registration_fields', 'time_basis', 'leaderboard_mode']) {
    let why = _forbidReason(key, kind);
    if (!why && key === 'time_basis' && !ov.querySelector('#tpl-ed-measure_presence').checked) why = 'Turn on Record time on the platform first.';
    const box = ov.querySelector(`[data-opt="${key}"]`);
    if (box) {
      box.classList.toggle('is-disabled', !!why);
      for (const inp of box.querySelectorAll('input,select')) inp.disabled = !!why;
    }
    const note = ov.querySelector(`[data-why="${key}"]`);
    if (note) { note.textContent = why; note.hidden = !why; }
  }
  const dl = ov.querySelector('#tpl-ed-duration-label');
  if (dl) dl.textContent = p.schedule === 'deadline' ? 'Open for (minutes from the start)' : 'Runs for (minutes)';
  // The live summary. It reads what the event WILL do, so a seeded setting the
  // save leaves out is read off its box (which shows the kind's seed), not off
  // the body.
  const v = _readEditor(ov, state);
  const on = (key) => !_forbidReason(key, kind) && !!ov.querySelector(`#tpl-ed-${key}`)?.checked;
  const mins = Number(v.settings.duration_minutes) || 0;
  const span = mins >= 2880 ? `${Math.round(mins / 1440)} days` : mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`;
  if (!k) {
    // Nothing the event will do can be said before its type is chosen.
    setSafeHtml(ov.querySelector('#tpl-ed-sum'), `<li>${ICO.info}<span>Choose an event type to see what events made from this template will do.</span></li>`
      + `<li>${ICO.check}<span>${esc(`${state.tasks.length} challenge${state.tasks.length === 1 ? '' : 's'}`)}</span></li>`);
    return;
  }
  const facts = [
    `${(k && k.label) || 'This event type'}, ${p.schedule === 'deadline' ? `open for ${span}` : `runs for ${span}`}`,
    on('self_enroll_enabled') ? 'Join link and QR code' : 'By invitation only',
    on('late_entry_enabled') ? 'Late entries after the end' : null,
    v.settings.attempt_cap ? `${v.settings.attempt_cap} attempt${v.settings.attempt_cap === 1 ? '' : 's'} per challenge` : 'Unlimited attempts',
    p.ranking_enabled !== false ? `Ranked${v.settings.group_leaderboard_enabled ? ', with a team board' : ''}` : 'Not ranked',
    v.settings.reveal_answers_on_end ? 'Answers shown at the end' : null,
    v.settings.measure_presence ? `Time on the platform recorded${v.settings.time_basis === 'presence' ? ' and used for ties' : ''}` : null,
    v.settings.staff_compete ? 'Staff compete' : null,
    on('cxone_disabled') ? 'No Checkmarx One accounts' : 'Checkmarx One accounts on enrolment',
    `${state.tasks.length} challenge${state.tasks.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  setSafeHtml(ov.querySelector('#tpl-ed-sum'), facts.map(f => `<li>${ICO.check}<span>${esc(f)}</span></li>`).join(''));
}

/** The body the routes take; a forbidden or unrendered option is never sent. */
function _readEditor(ov, state) {
  const kind = ov.querySelector('#tpl-ed-kind').value;
  const val = (id) => ov.querySelector(`#tpl-ed-${id}`);
  const settings = { duration_minutes: parseInt(val('duration').value, 10) || 0 };
  const cap = val('cap').value.trim();
  settings.attempt_cap = cap === '' ? null : parseInt(cap, 10);
  for (const key of ['self_enroll_enabled', 'staff_compete', 'cxone_disabled', 'reveal_answers_on_end', 'group_leaderboard_enabled', 'measure_presence', 'late_entry_enabled']) {
    if (_forbidReason(key, kind)) continue;
    // A seeded setting nobody stated stays out: the kind's seed decides it.
    if (SEEDED_KEYS.includes(key) && !state.explicit.has(key)) continue;
    settings[key] = !!val(key).checked;
  }
  if (!_forbidReason('time_basis', kind) && settings.measure_presence) settings.time_basis = val('time_basis').value;
  if (!_forbidReason('leaderboard_mode', kind)) settings.leaderboard_mode = val('leaderboard_mode').value;
  if (!_forbidReason('registration_fields', kind)) {
    settings.registration_fields = {};
    for (const [k] of REG_FIELDS) {
      const r = ov.querySelector(`input[name="tpl-ed-reg-${k}"]:checked`);
      if (r) settings.registration_fields[k] = r.value;
    }
  }
  const tags = val('tags').value.split(',').map(x => x.trim()).filter(Boolean);
  if (tags.length) settings.tags = tags;
  return {
    name: val('name').value.trim(), description: val('desc').value.trim(), event_kind: kind,
    settings, task_ids: state.tasks.map(t => t.id),
  };
}

async function _saveEditor(ov, state, close) {
  const err = (m) => { const e = ov.querySelector('#tpl-ed-err'); if (e) e.textContent = m || ''; };
  const body = _readEditor(ov, state);
  if (!body.name) { err('Give the template a name.'); ov.querySelector('#tpl-ed-name').focus(); return; }
  if (!body.event_kind) { err('Choose an event type.'); ov.querySelector('#tpl-ed-kind').focus(); return; }
  if (!(body.settings.duration_minutes >= 1)) { err('Say how long events made from it run.'); ov.querySelector('#tpl-ed-duration').focus(); return; }
  const editing = state.mode === 'edit' && state.id;
  if (editing && state.updatedAt) body.expectedUpdatedAt = state.updatedAt;
  let r = null, d = {};
  try {
    r = await fetch(editing ? `/api/admin/event-templates/${encodeURIComponent(state.id)}` : '/api/admin/event-templates', {
      method: editing ? 'PUT' : 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    d = await r.json().catch(() => ({}));
  } catch (_) { r = null; }
  // No answer: the request may have reached the server and been saved, so
  // nothing here may say it was not.
  if (!r) { err('No answer came back from the server, so the template may or may not have been saved. Check the list of templates before you try again.'); return; }
  if (!r.ok) {
    err((d && d.error) || 'Could not save the template.');
    // A refusal naming one of the listed challenges is said on that challenge too,
    // beside its Remove (the save re-judges the whole list).
    const named = d && typeof d.task_id === 'string' && state.tasks.some(t => t.id === d.task_id);
    state.refused = named ? { id: d.task_id, message: String(d.error || 'The save refused it.') } : null;
    _renderTasks(ov, state);
    return;
  }
  close();
  showToast(editing ? `Saved template “${body.name}”.` : `Created template “${body.name}”.`, 'success');
  _templates = null;
  loadTemplatesPane();
}
