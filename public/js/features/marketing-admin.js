"use strict";

// THE MARKETING PAGE — how the platform is doing across events.
//
// One read, GET /api/admin/analytics/marketing (lib/marketing-analytics.js holds
// every definition; the help tips below repeat each in a sentence). Every figure
// is a count of what the platform recorded, shown with its denominator; a figure
// only some events can answer says how many could. Nothing here estimates.
//
// The range picks events by their START (the server's one basis), so the totals
// and the per-event table always add up. The filter bar is static markup, a
// SIBLING of the containers a fetch re-renders (#mk-body, the table body), so a
// half-made choice survives every answer. Stale answers are dropped by
// S._mkFetchSeq; a failed read renders renderLoadFailure with Try again.
//
// The per-event table is a MODEL table (ui/table-columns.js): its heading
// filters and sort cover every row before paging, and Export CSV writes exactly
// those rows, every page, through `_mkRowsInView`, the one definition both use.

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc, fmtDt, eventKindLabel } from "../ui/format.js";
import { paginationHtml, renderLoadFailure } from "../ui/list-controls.js";
import { applyColumnFilters, applyColumnSort, hasColumnFilters } from "../ui/table-columns.js";
import { downloadCsv } from "../ui/csv.js";
import { showToast } from "../ui/toast.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { adminPaneLoaders } from "../ui/nav.js";

const PANE = 'admin-marketing-tab';
const TABLE = 'marketing';

const TIPS = {
  'marketing.page': 'How the platform is doing across events, counted from what it recorded. Events are chosen by when they started. Dry runs, staff (unless the event lets staff compete), benchmark accounts, event admins and anything done while viewing as somebody are left out of every figure.',
  'marketing.range': 'Picks events by their start. An event counts in the range its start falls in, with everything its people did, whenever they did it. Events that have not started yet are not counted.',
  'marketing.reach': 'Who the selected events reached. A person in two events is one person but two joins.',
  'marketing.events': 'Events that started in the range, by type. Dry runs are never counted.',
  'marketing.people': 'Distinct people who joined at least one of the selected events, counted once each.',
  'marketing.joined': 'Joins: one per person per event. Someone in three events counts three times here.',
  'marketing.new': 'People among them whose account was created inside the range, by how the records say it came: at the desk, from an invitation, through a join link, or otherwise (the sign-up form, an import or something else: the records do not tell these apart).',
  'marketing.origin': 'The country and company people gave on their profile, the eight most common of each. Companies are grouped ignoring case and endings such as Inc or Ltd.',
  'marketing.engagement': 'What people did once they joined.',
  'marketing.played': 'Joins where the person answered anything, right or wrong, a quick question included.',
  'marketing.answers': 'Answers to scoring questions, right or wrong. Answers to quick (qualifying) questions are counted apart.',
  'marketing.solve': 'Of every question a person answered at least once (scoring questions only), the share they got right in the end.',
  'marketing.completion': 'Of the people who played, the share who solved every scoring question the event shows now. Asked only in events that have scoring questions.',
  'marketing.time': 'The middle value of each person\'s net active time, in events that measure it. Half spent less, half more. Events that do not measure it are left out, and the figure says how many measured it.',
  'marketing.returning': 'People who joined more than one of the selected events.',
  'marketing.outcomes': 'What people took away: certificates and, in Programs, grades.',
  'marketing.certificates': 'Certificates issued and not revoked, by what they record: a top-three place, taking part, or completing a Program.',
  'marketing.shared': 'Certificates whose holder pressed Share, which publishes the certificate\'s page for LinkedIn. Whether a post was then made is not known to the platform.',
  'marketing.pass': 'Program learners who finished (every scoring question solved or out of attempts) and scored 60% or more, out of those who finished. Grades follow each learner\'s current attempt.',
  'marketing.pipeline': 'The leads the event team reports show, only from events that asked the qualifying questions.',
  'marketing.leads': 'People the event team reports list as leads: everyone who took part, less anyone who said No to a follow-up. Hot: a large team evaluating soon, or asked to be contacted. Warm: one of the two. Cold: neither, or no answers.',
  'marketing.followup': 'Answers to the follow-up quick question. Those who said No are not leads.',
  'marketing.contacted': 'Leads an organiser marked as contacted in the event\'s Team & reports.',
  'marketing.per-event': 'One row per selected event. Filters and sort cover every row, and Export CSV saves exactly the rows they leave, on every page.',
};

const _mk = {
  preset: '90d', from: '', to: '',
  kinds: new Set(),
  eventIds: new Set(),
  options: [],            // the events offered in the picker: the last answer with no event chosen
  data: null, failed: false, loading: false,
  page: 1, pageSize: 25,
  kindsDrawn: false,
};

// esc() blanks a falsy value, which would erase every zero.
const n = v => esc(String(v ?? 0));
const pct = (num, den) => den ? `${Math.round((num / den) * 100)}%` : '—';
// Escaped where it is made (a count and fixed words), so it is safe in markup.
const plural = (k, one, many) => esc(`${k} ${k === 1 ? one : many}`);
function _kindName(k) { return eventKindLabel(k) || k; }
function _kinds() { return Array.isArray(S.eventKinds) ? S.eventKinds : []; }

// ── The range ───────────────────────────────────────────────────────────────
function _localMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function _fromDateInput(v) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }

/** The range as instants: {from (or null), to}; null while a custom range is incomplete or backwards. */
export function marketingRange() {
  const now = new Date();
  const days = { '30d': 30, '90d': 90, '365d': 365 }[_mk.preset];
  if (days) return { from: new Date(_localMidnight(now).getTime() - (days - 1) * 86400000), to: now };
  if (_mk.preset === 'ytd') return { from: new Date(now.getFullYear(), 0, 1), to: now };
  if (_mk.preset === 'all') return { from: null, to: now };
  const f = _fromDateInput(_mk.from), t = _fromDateInput(_mk.to);
  if (!f || !t) return null;
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);   // the "to" day is included
  return end > f ? { from: f, to: end } : null;
}

function _query() {
  const r = marketingRange();
  if (!r) return null;
  const p = new URLSearchParams();
  if (r.from) p.set('from', r.from.toISOString());
  p.set('to', r.to.toISOString());
  if (_mk.kinds.size) p.set('kinds', [..._mk.kinds].join(','));
  if (_mk.eventIds.size) p.set('events', [..._mk.eventIds].join(','));
  return p.toString();
}

// ── Loading ─────────────────────────────────────────────────────────────────
export function loadMarketing() {
  _drawKinds();
  _syncCustom();
  return fetchMarketing();
}

export async function fetchMarketing() {
  const q = _query();
  if (q === null) {
    _mk.data = null;
    setSafeHtml(document.getElementById('mk-body'), '<p class="mk-empty card">Choose both dates, the first on or before the second.</p>');
    _renderTable();
    return;
  }
  const mySeq = ++S._mkFetchSeq;
  _mk.loading = true;
  _setStatus('Loading…');
  let r, d;
  try {
    r = await fetch(`/api/admin/analytics/marketing?${q}`);
    d = await r.json().catch(() => null);
  } catch (_) { r = null; d = null; }
  if (mySeq !== S._mkFetchSeq) return;   // a newer choice is on its way
  _mk.loading = false;
  if (!r || !r.ok || !d || d.ok !== true) {
    _mk.data = null; _mk.failed = true;
    _setStatus('');
    renderLoadFailure('mk-body', {
      noun: 'the marketing figures', retryAction: 'mk-retry',
      message: r && d && d.error ? `Could not load the marketing figures: ${esc(d.error)}` : null,
    });
    _renderTable();
    return;
  }
  _mk.failed = false;
  _mk.data = d;
  if (!_mk.eventIds.size) { _mk.options = d.events.map(e => ({ id: e.id, name: e.name, kind: e.kind, start_time: e.start_time })); _drawEventPicker(); }
  _setStatus(`Figures as of ${fmtDt(d.generated_at, 'long')}.`);
  renderMarketing(d);
}

function _setStatus(text) { const el = document.getElementById('mk-status'); if (el) el.textContent = text; }

// ── The filter bar (static markup; filled once, then only on a real change) ──
function _drawKinds() {
  const box = document.getElementById('mk-kinds');
  if (!box || _mk.kindsDrawn) return;
  const ks = _kinds();
  if (!ks.length) return;
  setSafeHtml(box, ks.map(k => `<label class="checkbox-row mk-kind"><input type="checkbox" data-change-action="mk-kind" value="${esc(k.value)}"${_mk.kinds.has(k.value) ? ' checked' : ''}/> <span>${esc(k.plural || k.label)}</span></label>`).join(''));
  _mk.kindsDrawn = true;
}

function _syncCustom() {
  const c = document.getElementById('mk-custom');
  if (c) c.hidden = _mk.preset !== 'custom';
}

function _drawEventPicker() {
  const list = document.getElementById('mk-events-list');
  if (!list) return;
  _syncEventSummary();
  if (!_mk.options.length) { setSafeHtml(list, '<p class="mk-note">No events started in this range.</p>'); return; }
  setSafeHtml(list, `<p class="mk-note">Tick events to count only those. With none ticked, every event in the range counts.</p><ul class="mk-event-opts" role="list">${_mk.options.map(e =>
    `<li><label class="checkbox-row"><input type="checkbox" data-change-action="mk-event" value="${esc(e.id)}"${_mk.eventIds.has(e.id) ? ' checked' : ''}/> <span>${esc(e.name)} <small>${esc(_kindName(e.kind))} · ${esc(fmtDt(e.start_time, 'short'))}</small></span></label></li>`).join('')}</ul>`
    + (_mk.eventIds.size ? '<button type="button" class="btn sm secondary" data-action="mk-events-clear">Count every event</button>' : ''));
}

function _syncEventSummary() {
  const s = document.getElementById('mk-events-summary');
  if (s) s.textContent = _mk.eventIds.size ? `Events: ${_mk.eventIds.size} chosen` : `Events: all in the range (${_mk.options.length})`;
}

export function marketingPresetChanged(el) {
  _mk.preset = el.value; _syncCustom();
  _mk.eventIds.clear(); _mk.page = 1;
  if (_mk.preset === 'custom' && !_mk.from && !_mk.to) {
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
    _mk.to = `${y}-${m}-${d}`;
    _mk.from = `${y}-01-01`;
    const f = document.getElementById('mk-from'), t = document.getElementById('mk-to');
    if (f) f.value = _mk.from; if (t) t.value = _mk.to;
  }
  _schedule();
}
export function marketingDateChanged() {
  _mk.from = document.getElementById('mk-from')?.value || '';
  _mk.to = document.getElementById('mk-to')?.value || '';
  _mk.eventIds.clear(); _mk.page = 1;
  _schedule();
}
export function marketingKindChanged(el) {
  if (el.checked) _mk.kinds.add(el.value); else _mk.kinds.delete(el.value);
  _mk.eventIds.clear(); _mk.page = 1;
  _schedule();
}
export function marketingEventChanged(el) {
  if (el.checked) _mk.eventIds.add(el.value); else _mk.eventIds.delete(el.value);
  _syncEventSummary(); _mk.page = 1;
  _schedule();
}
export function marketingEventsClear() {
  _mk.eventIds.clear(); _mk.page = 1;
  _drawEventPicker();
  _schedule();
}
function _schedule() { clearTimeout(S._mkDebounce); S._mkDebounce = setTimeout(() => fetchMarketing(), 250); }

// ── The sections ────────────────────────────────────────────────────────────
function _tip(key, label) { return `<span data-help="${esc(key)}" data-help-label="${esc(label)}"></span>`; }
function _kpi(label, tip, value, sub) {
  return `<div class="mk-kpi"><div class="help-label-row"><p class="eyebrow mk-kpi-label">${esc(label)}</p>${_tip(tip, label)}</div>`
    + `<p class="mk-kpi-num">${esc(value)}</p>${sub ? `<p class="mk-kpi-sub">${esc(sub)}</p>` : ''}</div>`;
}
function _section(id, title, tip, inner) {
  return `<section class="card mk-section" aria-labelledby="mk-h-${esc(id)}"><div class="help-label-row"><h3 id="mk-h-${esc(id)}">${esc(title)}</h3>${_tip(tip, title)}</div>${inner}</section>`;
}
/** A bar list: [{label, value, of, note}] — each bar its share of `of` (or of the largest). */
function _bars(caption, rows, { of = null } = {}) {
  const max = of || Math.max(1, ...rows.map(r => r.value));
  return `<figure class="mk-figure"><figcaption class="mk-fig-cap">${esc(caption)}</figcaption><ol class="ws-bars mk-bars">${rows.map(r =>
    `<li class="ws-bar-row"><div class="ws-bar-head"><span class="ws-bar-label"><span class="ws-bar-title">${esc(r.label)}</span></span><span class="ws-bar-val">${esc(r.note ?? String(r.value))}</span></div>`
    + `<span class="ws-bar-track" aria-hidden="true"><span class="ws-bar-fill mk-bar-fill" data-pct="${esc(String(max ? Math.round((r.value / max) * 1000) / 10 : 0))}"></span></span></li>`).join('')}</ol></figure>`;
}
function _topRows(t) {
  const rows = t.top.map(x => ({ label: x.name, value: x.count }));
  if (t.other) rows.push({ label: `Other (${plural(t.other_kinds, 'more', 'more')})`, value: t.other });
  if (t.not_given) rows.push({ label: 'Not given', value: t.not_given });
  return rows;
}

export function renderMarketing(d) {
  const body = document.getElementById('mk-body');
  if (!body) return;
  const R = d.reach, E = d.engagement, O = d.outcomes, P = d.pipeline;
  const dry = d.dry_run_excluded ? ` ${plural(d.dry_run_excluded, 'dry run was', 'dry runs were')} left out.` : '';
  if (!R.events) {
    setSafeHtml(body, `<div class="card mk-empty"><p><b>No events started in this range${_mk.kinds.size || _mk.eventIds.size ? ' with these filters' : ''}.</b> Choose a longer range or clear the filters.${esc(dry)}</p></div>`);
    _renderTable();
    return;
  }
  const kindsLine = _kinds().filter(k => R.events_by_kind[k.value]).map(k => `${R.events_by_kind[k.value]} ${(R.events_by_kind[k.value] === 1 ? k.label : (k.plural || k.label))}`).join(', ');
  const nb = R.new_accounts.by_source;
  const reach = _section('reach', 'Reach', 'marketing.reach',
    `<div class="mk-kpis">`
    + _kpi('Events run', 'marketing.events', String(R.events), kindsLine)
    + _kpi('People', 'marketing.people', String(R.people), `${plural(R.joined, 'join', 'joins')} in all`)
    + _kpi('New accounts', 'marketing.new', String(R.new_accounts.total),
        R.people ? `${pct(R.new_accounts.total, R.people)} of the people · ${nb.join_link} by join link, ${nb.invitation} by invitation, ${nb.desk} at the desk, ${nb.other} otherwise` : '')
    + `</div><div class="mk-split">`
    + _bars('Countries', _topRows(R.countries))
    + _bars('Companies', _topRows(R.companies))
    + `</div><div class="help-label-row mk-note-row"><p class="mk-note">Countries and companies as people gave them on their profile, once per person.</p>${_tip('marketing.origin', 'Countries and companies')}</div>`);

  const pres = E.presence;
  const timeVal = pres.events_measured && pres.median_minutes != null ? `${Math.round(pres.median_minutes)} min` : '—';
  const timeSub = pres.events_measured
    ? `in ${pres.events_measured} of ${plural(R.events, 'event', 'events')} that measure it (${plural(pres.people_seen, 'person', 'people')} seen)`
    : 'No selected event measures active time.';
  const engage = _section('engagement', 'Engagement', 'marketing.engagement',
    `<div class="mk-kpis">`
    + _kpi('Played', 'marketing.played', pct(E.played, E.joined), `${E.played} of ${plural(E.joined, 'join', 'joins')} answered anything`)
    + _kpi('Answers', 'marketing.answers', String(E.answers), `to scoring questions, plus ${E.quick_answers} to quick questions`)
    + _kpi('Solve rate', 'marketing.solve', pct(E.solved_pairs, E.answered_pairs), E.answered_pairs ? `${E.solved_pairs} of ${E.answered_pairs} questions tried were solved` : 'No scoring question was answered.')
    + _kpi('Completion', 'marketing.completion', pct(E.finished, E.finish_base),
        E.finish_events ? `${E.finished} of ${E.finish_base} who played solved every question (${E.finish_events} of ${plural(R.events, 'event', 'events')} have scoring questions)` : 'No selected event has scoring questions.')
    + _kpi('Active time (median)', 'marketing.time', timeVal, timeSub)
    + _kpi('Returning', 'marketing.returning', String(R.returning), R.people ? `${pct(R.returning, R.people)} of the people joined more than one event` : '')
    + `</div>`
    + _bars('From joining to solving every question', [
        { label: 'Joined', value: E.joined },
        { label: 'Played', value: E.played, note: `${E.played} · ${pct(E.played, E.joined)}` },
        { label: 'Solved every question', value: E.finished, note: `${E.finished} · ${pct(E.finished, E.joined)} of joins` },
      ], { of: Math.max(1, E.joined) }));

  const C = O.certificates, G = O.programs;
  const progVal = G.events ? pct(G.passed, G.graded) : '—';
  const progSub = G.events
    ? (G.graded ? `${G.passed} of ${G.graded} learners who finished passed · ${G.finished} of ${G.learners} finished, in ${plural(G.events, 'Program', 'Programs')}` : `Nobody has finished yet, in ${plural(G.events, 'Program', 'Programs')}.`)
    : 'No selected event is a Program.';
  const outRows = [
    { label: 'A top-three place', value: C.placement },
    { label: 'Taking part', value: C.participation },
    { label: 'Completing a Program', value: C.completion },
  ];
  if (C.not_recorded) outRows.push({ label: 'Issued before the kind was recorded', value: C.not_recorded });
  const outcomes = _section('outcomes', 'Outcomes', 'marketing.outcomes',
    `<div class="mk-kpis">`
    + _kpi('Certificates', 'marketing.certificates', String(C.total), R.people ? `for ${pct(C.total, R.joined)} of joins` : '')
    + _kpi('Shared on LinkedIn', 'marketing.shared', String(C.shared), C.total ? `${pct(C.shared, C.total)} of the certificates` : 'No certificate issued yet.')
    + _kpi('Program pass rate', 'marketing.pass', progVal, progSub)
    + `</div><div class="mk-split">`
    + _bars('Certificates by what they record', outRows, { of: Math.max(1, C.total) })
    + (G.events && G.graded ? _bars('Program grades of those who finished', (G.band_labels || []).map(b => ({ label: b.label, value: G.bands[b.key] || 0 })), { of: G.graded }) : '')
    + `</div>`);

  const pipe = P.events_asked
    ? `<p class="mk-note">From ${n(P.events_asked)} of ${plural(R.events, 'event', 'events')}: those that asked the qualifying questions.</p><div class="mk-kpis">`
      + _kpi('Leads', 'marketing.leads', String(P.leads), `${P.hot} hot, ${P.warm} warm, ${P.cold} cold`)
      + _kpi('Asked to be contacted', 'marketing.followup', String(P.follow_up_yes), `${P.follow_up_no} said no follow-up is needed`)
      + _kpi('Contacted', 'marketing.contacted', String(P.contacted), P.leads ? `${pct(P.contacted, P.leads)} of the leads` : '')
      + `</div>`
      + _bars('Leads by signal', [
          { label: 'Hot', value: P.hot }, { label: 'Warm', value: P.warm }, { label: 'Cold', value: P.cold },
        ], { of: Math.max(1, P.leads) })
    : '<p class="mk-note">None of the selected events asked the qualifying questions, so there are no leads to count.</p>';
  const pipeline = _section('pipeline', 'Pipeline', 'marketing.pipeline', pipe);

  const note = dry ? `<p class="mk-note">${esc(dry.trim())}</p>` : '';
  setSafeHtml(body, note + reach + engage + outcomes + pipeline);
  for (const f of body.querySelectorAll('.mk-bar-fill')) f.style.setProperty('--pct', String(Number(f.dataset.pct) / 100));
  _renderTable();
}

// ── The per-event table ─────────────────────────────────────────────────────
function _rate(x) { return x == null ? '' : Math.round(x * 100); }
export const MARKETING_TABLE_COLUMNS = {
  noun: 'event',
  // The default set fits a 1024 px window; Played and Certificates are under Columns (the CSV carries every column).
  hidden: ['played', 'certificates'],
  cols: { name: { grow: true }, kind: { filter: 'enum' }, start: { filter: 'date' } },
  model: {
    rows: () => (_mk.data && _mk.data.events) || [],
    get: (r, k) => {
      switch (k) {
        case 'name': return r.name || '';
        case 'kind': return _kindName(r.kind);
        case 'start': return r.start_time || '';
        case 'joined': case 'played': case 'certificates': return r[k] || 0;
        case 'solve_rate': return _rate(r.solve_rate);
        case 'completion': return _rate(r.completion);
        case 'hot_leads': return r.hot_leads == null ? '' : r.hot_leads;
        default: return '';
      }
    },
    onChange: () => { _mk.page = 1; _renderTable(); },
  },
};

/** The rows in view: every event the heading filters leave, in the order shown. The table and the CSV both read it. */
export function _mkRowsInView() {
  const all = (_mk.data && _mk.data.events) || [];
  const matched = applyColumnSort(TABLE, applyColumnFilters(TABLE, all));
  return { all, matched, narrowed: hasColumnFilters(TABLE) };
}

function _renderTable() {
  const card = document.getElementById('mk-table-card');
  const body = document.getElementById('mk-table-body');
  const pag = document.getElementById('mk-pagination');
  const meta = document.getElementById('mk-table-meta');
  if (!card || !body) return;
  if (!_mk.data || !_mk.data.events.length) {
    card.hidden = true;
    setSafeHtml(body, ''); if (pag) setSafeHtml(pag, ''); if (meta) meta.textContent = '';
    return;
  }
  card.hidden = false;
  const { all, matched, narrowed } = _mkRowsInView();
  const PAGE = _mk.pageSize;
  const totalPages = Math.max(1, Math.ceil(matched.length / PAGE));
  _mk.page = Math.min(Math.max(1, _mk.page), totalPages);
  const rows = matched.slice((_mk.page - 1) * PAGE, _mk.page * PAGE);
  if (meta) meta.textContent = narrowed ? `${matched.length} of ${plural(all.length, 'event', 'events')} match` : plural(all.length, 'event', 'events');
  const cols = document.querySelectorAll('#mk-table thead th').length || 9;
  setSafeHtml(body, rows.length ? rows.map(r => `<tr>`
    + `<td class="mk-ev-name">${esc(r.name)}</td>`
    + `<td>${esc(_kindName(r.kind))}</td>`
    + `<td data-sort-value="${esc(r.start_time)}">${esc(fmtDt(r.start_time, 'short'))}</td>`
    + `<td class="num-cell">${n(r.joined)}</td>`
    + `<td class="num-cell">${n(r.played)}</td>`
    + `<td class="num-cell">${r.solve_rate == null ? '<span class="mk-na">—</span>' : esc(`${_rate(r.solve_rate)}%`)}</td>`
    + `<td class="num-cell">${r.completion == null ? '<span class="mk-na">—</span>' : esc(`${_rate(r.completion)}%`)}</td>`
    + `<td class="num-cell">${n(r.certificates)}</td>`
    + `<td class="num-cell">${r.hot_leads == null ? '<span class="mk-na" title="This event did not ask the qualifying questions">—</span>' : n(r.hot_leads)}</td>`
    + `</tr>`).join('')
    : `<tr><td colspan="${cols}" class="table-empty-row">No events match the column filters.</td></tr>`);
  if (pag) setSafeHtml(pag, matched.length > PAGE || _mk.page > 1
    ? paginationHtml('mk', { page: _mk.page, totalPages, totalLabel: `${matched.length} total`, pageSize: PAGE, sizes: [25, 50, 100] })
    : '');
}

export function marketingPage(step) {
  if (step === 'first') _mk.page = 1;
  else if (step === 'prev') _mk.page--;
  else if (step === 'next') _mk.page++;
  else if (Number.isFinite(step)) _mk.page = step;
  _renderTable();
}
export function marketingPageSize(el) { _mk.pageSize = Math.max(10, parseInt(el.value, 10) || 25); _mk.page = 1; _renderTable(); }

export const MARKETING_CSV_HEADERS = ['Event', 'Type', 'Started', 'Joined', 'Played', 'Answers', 'Solve rate (%)',
  'Scoring questions', 'Solved every question', 'Completion (%)', 'Certificates', 'Asked qualifying questions', 'Hot leads'];

export function exportMarketingCsv() {
  if (!_mk.data) { showToast('Nothing to export yet: the marketing figures have not loaded.', 'error'); return; }
  const { matched } = _mkRowsInView();
  if (!matched.length) { showToast('Nothing to export: no events match the current filters.', 'error'); return; }
  const rows = matched.map(r => [
    r.name || '', _kindName(r.kind), String(r.start_time || '').slice(0, 10),
    r.joined, r.played, r.answers, _rate(r.solve_rate),
    r.scoring_questions, r.finished == null ? '' : r.finished, _rate(r.completion),
    r.certificates, r.asked_qualifying ? 'yes' : 'no', r.hot_leads == null ? '' : r.hot_leads,
  ]);
  downloadCsv(`marketing-events-${new Date().toISOString().slice(0, 10)}.csv`, MARKETING_CSV_HEADERS, rows);
}

/** Called once from boot(). */
export function initMarketingAdmin({ registerAction, registerChange }) {
  registerHelpTips(TIPS);
  adminPaneLoaders.set(PANE, () => loadMarketing());
  registerChange('mk-preset', (e, el) => marketingPresetChanged(el));
  registerChange('mk-date', () => marketingDateChanged());
  registerChange('mk-kind', (e, el) => marketingKindChanged(el));
  registerChange('mk-event', (e, el) => marketingEventChanged(el));
  registerAction('mk-events-clear', () => marketingEventsClear());
  registerAction('mk-retry', () => fetchMarketing());
  registerAction('mk-export-csv', () => exportMarketingCsv());
  registerAction('mk-page-first', () => marketingPage('first'));
  registerAction('mk-page-prev', () => marketingPage('prev'));
  registerAction('mk-page-next', () => marketingPage('next'));
  registerAction('mk-page-last', (e, el) => marketingPage(parseInt(el.dataset.totalPages, 10)));
  registerChange('mk-page-size', (e, el) => marketingPageSize(el));
}
