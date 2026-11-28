"use strict";

// ── Admin tables: a Columns chooser, and sort + filter on every heading ──────
//
// ONE component for the data tables on the admin PAGES. A table inside a dialog
// keeps its own search, sort and pages, as the History dialog does (operator
// ruling, 14 Nov 2026; its exemption is recorded in
// tests/admin-tables-component.spec.js). A table opts in with
// `data-tcols="<key>"` (static markup, or the renderer that builds it) and,
// optionally, a `defineTable(key, cfg)` call naming its defaults. Everything
// else is derived from the table's own header row, so a renderer that rebuilds
// its <thead> (rankings, logs) needs nothing more than the attribute.
//
// Three jobs:
//  1. COLUMNS. A small default set fits the card; the rest are under a
//     "Columns" button (checkboxes, Reset to default), remembered per table per
//     browser (localStorage, every access in try/catch). A column is hidden by
//     a class on its heading and on each cell at its index — the row renderers
//     know nothing about it, exactly as `ui/table-cards.js` writes the phone
//     labels. Nothing scrolls sideways at desktop widths (CSS "TABLE COLUMNS").
//  2. SORT on every heading. A heading that already sorts (`.sortable` with a
//     data-action) keeps its own sort — the model sort, server sort or rankings
//     cache — and the menu's two buttons drive it. A table whose order cannot
//     be read back from a toggled heading names a setter instead,
//     `cfg.sortTo(col, asc, th)`, so the menu sets the order rather than
//     clicking a toggle twice: a server-sorted table (Submissions, Logs), which
//     answers after a fetch, and the rankings boards, which rebuild their
//     heading on every sort. A heading with no sort of its own gets one here:
//     the rows on screen are reordered by the cell's text (blanks last in both
//     directions), and the heading carries aria-sort and an arrow. The bar's
//     Clear drops it, and the rows go back to the order they were drawn in
//     (sweeps #311, #316); a list drawn for another event (`data-tcols-scope`)
//     starts with no sort or filters.
//  3. FILTER on every heading: text contains, a select for enums and tags, a
//     date range for dates. A table that registers a MODEL (`cfg.model`) filters
//     its whole data set before paging (`applyColumnFilters`); any other table
//     filters the rows it has on screen and SAYS so ("on this page"), never
//     claiming a total it does not have.
//
// A table's UNIT is a row, or, where the table draws each entry as its own
// <tbody> (a fact row plus full-width detail rows: the Checkmarx One removals
// card) and declares it (`unit: 'tbody'`), the whole <tbody>: it is filtered,
// counted and sorted as one, by its first data row, so a detail row never stays
// behind without its facts — however many entries are drawn, one included.
//
// While the component sorts a table (a heading with no sort of its own), no
// native heading claims a sort: its aria-sort reads "none" and its arrow is
// cleared, and pressing it takes over in ascending order, whatever its own
// state was before the component sort.
//
// On a phone (<=768px) every table in a `.table-card` is drawn as one card per
// row (ui/table-cards.js) and its headings, with their buttons, are not shown.
// The bar above the cards then carries **Sort & filter** (`.tcol-sf-btn`, shown
// by CSS only for such a bar): it lists the columns a wide screen gives a
// heading button and opens the very same heading menu for the one picked, so
// the phone has the same choices, not a second implementation of them. On a
// touch screen from 769 to 1279 px every table's bar shows it too: there a
// heading's button stays 24 px (its 44 px strip would not fit the tables), and
// Sort & filter is the 44 px door to the same menus.
//
// Popovers live on <body> (position:fixed) — a sibling of every container a
// renderer re-renders, so a half-typed filter survives the re-render it causes
// (the sibling rule, CLAUDE.md "Recurring rules").

import { esc } from "./format.js";
import { setSafeHtml } from "../core/trusted-types.js";

const _cfgs = new Map();            // key -> config
const _state = new Map();           // key -> { filters: Map(col -> value), sort: {col, asc} | null, scope }
// Sweep #311 — the order a page-only table was drawn in, so a sort can be undone:
// each unit's place in the order its renderer drew it, stamped before the first
// move, and the tables whose units the component has moved.
const _drawnAt = new WeakMap();
let _drawnSeq = 0;
const _domSorted = new WeakSet();

const ICON_FUNNEL = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>';
const ICON_COLS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>';

function _st(key) {
  let s = _state.get(key);
  if (!s) { s = { filters: new Map(), sort: null, scope: null }; _state.set(key, s); }
  return s;
}

/** Declare a table's defaults. Safe to call before its markup exists. */
export function defineTable(key, cfg = {}) {
  _cfgs.set(key, { ...cfg, key });
  _st(key);
}

function _cfg(key) { return _cfgs.get(key) || { key }; }

function _storageKey(key) { return _cfg(key).storageKey || `ha:tcols:${key}`; }

function _labelOf(th) {
  if (th.dataset.label != null) return th.dataset.label;
  const c = th.cloneNode(true);
  c.querySelectorAll('.tcol-hbtn, .tcol-sort-ic, [id$="-icon"]').forEach(n => n.remove());
  return c.textContent.replace(/[▲▼↑↓]/g, '').replace(/\s+/g, ' ').trim();
}

function _slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

/** The table's columns, from its first header row: [{key, label, idx:[...], th:[...]}]. */
export function tableColumns(table) {
  const row = table?.tHead?.rows?.[0];
  if (!row) return [];
  const byKey = new Map();
  const order = [];
  let idx = 0;
  for (const th of row.cells) {
    const span = Number(th.colSpan) || 1;
    let key = th.dataset.tcol || th.dataset.pcol || th.dataset.col || th.dataset.sort || '';
    if (!key) key = th.classList.contains('cb-cell') ? '_select' : _slug(_labelOf(th)) || `col${idx}`;
    let col = byKey.get(key);
    if (!col) { col = { key, label: '', idx: [], th: [] }; byKey.set(key, col); order.push(col); }
    const lab = _labelOf(th);
    if (!col.label || (th.classList.contains('sortable') && lab)) col.label = lab || col.label;
    for (let i = 0; i < span; i++) col.idx.push(idx + i);
    col.th.push(th);
    idx += span;
  }
  const over = _cfg(table.dataset.tcols).labels || {};
  for (const c of order) {
    if (over[c.key]) c.label = over[c.key];
    if (c.key === '_select') c.label = '';
  }
  return order;
}

function _colOpts(key, colKey) { return (_cfg(key).cols || {})[colKey] || {}; }

// The selection column and a row's actions are never hidden: the actions are
// the row's only doors, so switching them off would strand every row.
function _isFixed(key, colKey) {
  if (colKey === '_select' || colKey === 'actions') return true;
  const cfg = _cfg(key);
  return (cfg.fixed || []).includes(colKey) || !!_colOpts(key, colKey).fixed;
}

function _defaultShown(key, cols) {
  const cfg = _cfg(key);
  if (Array.isArray(cfg.defaults)) return cols.map(c => c.key).filter(k => cfg.defaults.includes(k) || _isFixed(key, k));
  const hide = new Set(cfg.hidden || []);
  return cols.map(c => c.key).filter(k => !hide.has(k));
}

// The stored choice is two lists: the keys ticked (`ha:tcols:<key>`, as always)
// and the keys UNticked (the same key + ':off'). One table can draw different
// columns in different states (the Logs streams; Rankings with names hidden), so
// a key in neither list was never on screen when the operator chose, and keeps
// its default: a choice made in one state never hides what only another draws.
// A ticked list saved before the ':off' list existed reads as it always did
// (every drawn key missing from it is hidden) until the next save.
function _readList(k) {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { v = null; }
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : null;
}

// The choices made on this page, by table ({on, off}, as stored; null means the
// defaults). Storage only REMEMBERS them across a reload: where it is blocked
// (or a write fails) the choice still applies for as long as the page is open,
// rather than a ticked box that changes nothing.
const _memShown = new Map();

/** This page's choice for a table, else the stored one: {on, off}, either null. */
function _choice(key) {
  if (_memShown.has(key)) return _memShown.get(key) || { on: null, off: null };
  const on = _readList(_storageKey(key));
  return { on, off: on ? _readList(`${_storageKey(key)}:off`) : null };
}

/** The keys the operator has chosen to show (this page's choice, else stored), else the defaults. */
export function shownColumns(key, cols) {
  const { on, off } = _choice(key);
  const known = new Set(cols.map(c => c.key));
  let list;
  if (!on) list = _defaultShown(key, cols);
  else if (!off) list = on.filter(k => known.has(k));
  else {
    const def = new Set(_defaultShown(key, cols));
    list = cols.map(c => c.key).filter(k => on.includes(k) || (!off.includes(k) && def.has(k)));
  }
  for (const c of cols) if (_isFixed(key, c.key) && !list.includes(c.key)) list.push(c.key);
  return list;
}

/** Store the choice made over `drawn` (the keys on screen), keeping the earlier
 *  choice for every key not drawn now. */
function _saveShown(key, drawn, ticked) {
  const k = _storageKey(key);
  const prev = _choice(key);
  const keep = (l) => (l || []).filter(x => !drawn.includes(x));
  const on = [...keep(prev.on), ...ticked];
  const off = [...keep(prev.off), ...drawn.filter(x => !ticked.includes(x))];
  _memShown.set(key, { on, off });
  try { localStorage.setItem(k, JSON.stringify(on)); localStorage.setItem(`${k}:off`, JSON.stringify(off)); } catch (_) { return false; }
  return true;
}

/** Back to the table's defaults, on this page and in storage. A stored choice
 *  that cannot be removed is overruled for this page (null means the defaults). */
function _resetShown(key) {
  _memShown.delete(key);
  try { localStorage.removeItem(_storageKey(key)); localStorage.removeItem(`${_storageKey(key)}:off`); } catch (_) { _memShown.set(key, null); }
}

function _filterType(key, col) {
  const o = _colOpts(key, col.key);
  if (o.filter !== undefined) return o.filter;
  if (col.key === '_select' || col.key === 'actions' || /^actions?$/i.test(col.label) || !col.label) return null;
  return 'text';
}

function _sortable(key, col) {
  const o = _colOpts(key, col.key);
  if (o.sort === false) return false;
  if (col.key === '_select' || col.key === 'actions' || !col.label || /^actions?$/i.test(col.label)) return false;
  return true;
}

function _nativeTh(col) { return col.th.find(t => t.classList.contains('sortable') && (t.dataset.action || t.dataset.sort)) || null; }

/** 'ascending' | 'descending' | 'none': the heading's own sort, else the component's. */
function _curSort(key, col) {
  const native = _nativeTh(col);
  if (native) return native.getAttribute('aria-sort') || 'none';
  const s = _st(key);
  return s.sort && s.sort.col === col.key ? (s.sort.asc ? 'ascending' : 'descending') : 'none';
}

// ── Units: what is filtered, counted and sorted ──────────────────────────────
// A full-width row (an empty state, a "Show all" row, a divider, an entry's
// detail row) is never a unit of its own.
function _isDataRow(tr) { return !(tr.cells.length === 1 && (Number(tr.cells[0].colSpan) || 1) > 1); }

/** True when the table draws each entry as its own <tbody> (`unit: 'tbody'`). */
function _bodyUnits(table) { return _cfg(table.dataset.tcols).unit === 'tbody'; }

/** [{row, rows, unit}]: `row` is read for values, every one of `rows` is shown
 *  or hidden together, and `unit` is the node a sort moves. A `unit: 'tbody'`
 *  table: each <tbody> that holds a data row, whole (one drawn alone included).
 *  Any other: each data row. */
function _entries(table) {
  const bodies = [...table.tBodies];
  if (_bodyUnits(table)) {
    const out = [];
    for (const tb of bodies) {
      const rows = [...tb.rows];
      const row = rows.find(_isDataRow);
      if (row) out.push({ row, rows, unit: tb });
    }
    return out;
  }
  return bodies.flatMap(tb => [...tb.rows].filter(_isDataRow).map(r => ({ row: r, rows: [r], unit: r })));
}

// ── Cell values ──────────────────────────────────────────────────────────────
function _cellAt(tr, colIdx) {
  let i = 0;
  for (const td of tr.cells) {
    const span = Number(td.colSpan) || 1;
    if (colIdx >= i && colIdx < i + span) return span > 1 ? null : td;
    i += span;
  }
  return null;
}

function _cellText(tr, col) {
  const parts = [];
  for (const i of col.idx) {
    const td = _cellAt(tr, i);
    if (!td) continue;
    parts.push(td.dataset.sortValue != null ? td.dataset.sortValue : td.textContent);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function _isBlank(v) { return v == null || v === '' || v === '—' || v === '-' || (Array.isArray(v) && !v.length); }

// A value is a NUMBER only when the whole of it is one: an optional sign, digits
// (thousands commas allowed), an optional fraction and an optional %. Text that
// merely contains digits (a date, a tenant "acme-2", an ISO time, a code) is text,
// compared with numeric collation: read as a number it compared by an arbitrary
// fragment ("Nov 5, 2026" as 5202610).
const _NUM_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
function _num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v) || (v && typeof v === 'object')) return null;
  const s = String(v).trim();
  if (!_NUM_RE.test(s)) return null;
  return parseFloat(s.replace(/[,%]/g, ''));
}

/** Blanks last in both directions; numbers before text, numbers numerically,
 *  text by locale. The number/text partition keeps the order total: mixing the
 *  two comparisons on one pair ("1,240" > "999" by value, < "5 apples" by
 *  locale, which is < "999") made a cycle the input order then decided. */
export function compareValues(a, b, asc) {
  const ba = _isBlank(a), bb = _isBlank(b);
  if (ba || bb) return ba === bb ? 0 : (ba ? 1 : -1);
  const na = _num(a), nb = _num(b);
  let r;
  if (na != null && nb != null) r = na - nb;
  else if ((na != null) !== (nb != null)) r = na != null ? -1 : 1;
  else r = String(Array.isArray(a) ? a.join(', ') : a).localeCompare(String(Array.isArray(b) ? b.join(', ') : b), undefined, { numeric: true, sensitivity: 'base' });
  return asc ? r : -r;
}

function _matches(type, value, f) {
  if (f == null || f === '' || (typeof f === 'object' && !f.from && !f.to && !Array.isArray(f))) return true;
  if (type === 'date') {
    if (_isBlank(value)) return false;
    const t = Date.parse(value);
    if (Number.isNaN(t)) return false;
    if (f.from && t < Date.parse(f.from + 'T00:00:00')) return false;
    if (f.to && t > Date.parse(f.to + 'T23:59:59.999')) return false;
    return true;
  }
  if (type === 'enum' || type === 'tags') {
    const vals = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
    if (f === '__blank__') return vals.every(v => _isBlank(v));
    return vals.some(v => v.toLowerCase() === String(f).toLowerCase());
  }
  const hay = (Array.isArray(value) ? value.join(' ') : String(value ?? '')).toLowerCase();
  return hay.includes(String(f).toLowerCase().trim());
}

// ── Public helpers for MODEL tables ─────────────────────────────────────────
/** True when any column filter is set on this table. */
export function hasColumnFilters(key) { return _st(key).filters.size > 0; }

/** Rows that pass every column filter (model tables call this before paging). */
export function applyColumnFilters(key, rows) {
  const s = _st(key), cfg = _cfg(key);
  if (!s.filters.size || !cfg.model?.get) return rows;
  const table = _tableFor(key);
  const cols = table ? tableColumns(table) : [];
  const typeOf = k => { const c = cols.find(x => x.key === k); return c ? _filterType(key, c) : (_colOpts(key, k).filter || 'text'); };
  return rows.filter(r => { for (const [k, f] of s.filters) if (!_matches(typeOf(k), cfg.model.get(r, k), f)) return false; return true; });
}

/** Apply a component sort (a column with no sort of its own) to model rows. */
export function applyColumnSort(key, rows) {
  const s = _st(key), cfg = _cfg(key);
  if (!s.sort || !cfg.model?.get) return rows;
  const { col, asc } = s.sort;
  return rows.slice().sort((a, b) => compareValues(cfg.model.get(a, col), cfg.model.get(b, col), asc));
}

/** True while this table is sorted by the component rather than its own sort. */
export function columnSortActive(key) { return !!_st(key).sort; }

/** A native header sort was chosen: drop the component's own sort. */
export function clearColumnSort(key) { _st(key).sort = null; }

function _tableFor(key) {
  return document.querySelector(`table[data-tcols="${CSS.escape(key)}"]`);
}

// ── Applying to the DOM ──────────────────────────────────────────────────────
function _applyColumns(table, key, cols) {
  const forced = new Set((_cfg(key).forceHidden && _cfg(key).forceHidden()) || []);
  const shown = new Set(shownColumns(key, cols));
  for (const k of forced) shown.delete(k);
  const off = new Set();
  for (const c of cols) if (!shown.has(c.key)) for (const i of c.idx) off.add(i);
  table.dataset.hide = cols.filter(c => !shown.has(c.key)).map(c => c.key).join(' ');
  for (const row of [...table.tHead.rows, ...[...table.tBodies].flatMap(b => [...b.rows])]) {
    let i = 0;
    for (const cell of row.cells) {
      const span = Number(cell.colSpan) || 1;
      const hide = span === 1 && off.has(i);
      if (cell.classList.contains('tcol-off') !== hide) cell.classList.toggle('tcol-off', hide);
      i += span;
    }
  }
  // A <col> of a hidden column would keep its width.
  const cg = table.querySelector(':scope > colgroup');
  if (cg) [...cg.children].forEach((c, i) => { const h = off.has(i); if (c.classList.contains('tcol-off') !== h) c.classList.toggle('tcol-off', h); });
  for (const c of cols) {
    // `grow` takes the spare width; the actions column keeps its buttons on one
    // line where the window has room (CSS decides the width at which it does).
    const cls = _colOpts(key, c.key).grow ? 'tcol-grow' : c.key === 'actions' ? 'tcol-acts' : '';
    if (!cls) continue;
    for (const tb of table.tBodies) for (const tr of tb.rows) for (const i of c.idx) { const td = _cellAt(tr, i); if (td && !td.classList.contains(cls)) td.classList.add(cls); }
    for (const th of c.th) if (!th.classList.contains(cls)) th.classList.add(cls);
  }
}

function _decorateHeads(table, key, cols) {
  const s = _st(key);
  for (const c of cols) {
    const native = _nativeTh(c);
    // The component's sort orders the rows: the heading whose own sort is
    // not in force must not claim it (two aria-sort claims, an arrow over the
    // wrong column). A table that owns its aria-sort (Analytics) is left alone.
    if (native && s.sort && !_cfg(key).ariaSortOwner) {
      if (native.getAttribute('aria-sort') !== 'none') native.setAttribute('aria-sort', 'none');
      const ic = native.querySelector('[id$="-icon"]');
      if (ic && ic.textContent) ic.textContent = '';
    }
    const ft = _filterType(key, c), so = _sortable(key, c);
    if (!ft && !so) continue;
    const th = native || [...c.th].reverse().find(t => _labelOf(t)) || c.th[c.th.length - 1];
    if (so && !native && !th.hasAttribute('data-tcol-dsort')) {
      th.setAttribute('data-tcol-dsort', c.key);
      th.classList.add('sortable');
      if (!th.hasAttribute('tabindex')) th.setAttribute('tabindex', '0');
    }
    if (so && !native) {
      const want = s.sort && s.sort.col === c.key ? (s.sort.asc ? 'ascending' : 'descending') : 'none';
      if (!_cfg(key).ariaSortOwner) {
        if (th.getAttribute('aria-sort') !== want) th.setAttribute('aria-sort', want);
        // Sweep #316 — the arrow a sighted reader sees, as on a native heading;
        // aria-sort says it to a screen reader, so the arrow is hidden from one.
        // Never an id ending -icon: those clears are for native icons only.
        const glyph = want === 'ascending' ? ' ▲' : want === 'descending' ? ' ▼' : '';
        let ic = th.querySelector(':scope > .tcol-sort-ic');
        if (!ic && glyph) {
          ic = document.createElement('span');
          ic.className = 'tcol-sort-ic';
          ic.setAttribute('aria-hidden', 'true');
          th.insertBefore(ic, th.querySelector(':scope > .tcol-hbtn'));
        }
        if (ic && ic.textContent !== glyph) ic.textContent = glyph;
      }
    }
    if (!th.classList.contains('tcol-has-menu')) th.classList.add('tcol-has-menu');
    let btn = th.querySelector(':scope > .tcol-hbtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tcol-hbtn';
      btn.setAttribute('data-tcol-menu', c.key);
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      setSafeHtml(btn, ICON_FUNNEL);
      th.appendChild(btn);
      // A heading rebuilt under its own open menu (the rankings boards rebuild
      // theirs on a sort): this button is that menu's opener now, and says so.
      if (_pop) _popAnchor();
    }
    const lbl = `${c.label || 'Column'}: ${ft && so ? 'sort and filter' : ft ? 'filter' : 'sort'}${s.filters.has(c.key) ? ' (filtered)' : ''}`;
    if (btn.getAttribute('aria-label') !== lbl) btn.setAttribute('aria-label', lbl);
    const on = s.filters.has(c.key);
    if (btn.classList.contains('is-on') !== on) btn.classList.toggle('is-on', on);
  }
}

function _applyDomFilterSort(table, key, cols) {
  const s = _st(key), cfg = _cfg(key);
  if (!table.tBodies.length) return null;
  const entries = _entries(table);
  let shown = 0;
  if (!cfg.model) {
    for (const e of entries) {
      let ok = true;
      for (const [k, f] of s.filters) {
        const c = cols.find(x => x.key === k);
        if (c && !_matches(_filterType(key, c), _cellText(e.row, c), f)) { ok = false; break; }
      }
      // An entry's rows go together: its detail row never outlives its facts.
      for (const r of e.rows) if (r.classList.contains('tcol-row-off') === ok) r.classList.toggle('tcol-row-off', !ok);
      if (ok) shown++;
    }
  } else shown = entries.length;
  if (!cfg.model && entries.length > 1 && (s.sort || _domSorted.has(table))) {
    // Each unit's place in the order drawn, stamped before the first move (a
    // re-render's new rows too). It breaks ties, so a tie keeps the drawn order
    // whatever sorted before; with no sort it IS the order, so a cleared sort
    // puts the rows back (sweep #311). A table never sorted is never touched.
    for (const e of entries) if (!_drawnAt.has(e.unit)) _drawnAt.set(e.unit, ++_drawnSeq);
    const drawn = (a, b) => _drawnAt.get(a.unit) - _drawnAt.get(b.unit);
    const c = s.sort ? cols.find(x => x.key === s.sort.col) : null;
    const sorted = entries.slice().sort(c
      ? (a, b) => compareValues(_cellText(a.row, c), _cellText(b.row, c), s.sort.asc) || drawn(a, b)
      : drawn);
    if (sorted.some((e, i) => e !== entries[i])) {
      // Whole <tbody> entries move as one. Rows move only within a lone
      // <tbody> with no full-width siblings (a divider, a "Show all" row),
      // which are left where they are.
      if (_bodyUnits(table)) for (const e of sorted) table.insertBefore(e.unit, table.tFoot);
      else if (table.tBodies.length === 1 && entries.length === table.tBodies[0].rows.length) for (const e of sorted) table.tBodies[0].appendChild(e.unit);
    }
    if (c) _domSorted.add(table); else _domSorted.delete(table);
  }
  return { shown, total: entries.length };
}

function _barFor(table, key) {
  const host = table.closest('.table-card, .table-wrap') || table;
  let bar = host.previousElementSibling;
  if (!bar || !bar.classList.contains('tcol-bar') || bar.dataset.tcolsFor !== key) {
    bar = document.querySelector(`.tcol-bar[data-tcols-for="${CSS.escape(key)}"]`);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tcol-bar';
      bar.dataset.tcolsFor = key;
      const cfg = _cfg(key);
      setSafeHtml(bar, `${cfg.button ? '' : `<button type="button" class="btn sm secondary tcol-cols-btn" data-tcol-columns="${esc(key)}" aria-haspopup="dialog" aria-expanded="false">${ICON_COLS} Columns</button>`}<button type="button" class="btn sm secondary tcol-sf-btn" data-tcol-sortfilter="${esc(key)}" aria-haspopup="dialog" aria-expanded="false">${ICON_FUNNEL} Sort &amp; filter</button><span class="tcol-note" role="status" aria-live="polite"></span><button type="button" class="btn sm secondary tcol-clear" data-tcol-clear="${esc(key)}" hidden>Clear column filters</button>`);
      host.parentNode.insertBefore(bar, host);
    }
  }
  // Only a `.table-card` becomes cards on a phone (styles.css "admin: phone
  // layout"); CSS shows Sort & filter for this class there (and for every bar
  // on a 769-1279 px touch screen).
  const cards = host.classList.contains('table-card');
  if (bar.classList.contains('tcol-cards') !== cards) bar.classList.toggle('tcol-cards', cards);
  return bar;
}

function _paintBar(bar, key, cols, counts) {
  const s = _st(key), cfg = _cfg(key);
  const names = [...s.filters.keys()].map(k => cols.find(c => c.key === k)?.label || k);
  let text = '';
  if (names.length) {
    const what = `Filtered by ${names.join(', ')}`;
    if (!cfg.model && counts) {
      const noun = counts.total === 1 ? (cfg.noun || 'row') : (cfg.nounPlural || `${cfg.noun || 'row'}s`);
      text = `${what} — ${counts.shown} of ${counts.total} ${noun} ${cfg.paged === false ? 'shown' : 'on this page shown'}`;
    } else text = what;
  } else if (s.sort && !cfg.model && cfg.paged !== false) {
    text = `Sorted by ${cols.find(c => c.key === s.sort.col)?.label || s.sort.col} on this page`;
  }
  const note = bar.querySelector('.tcol-note');
  if (note && note.textContent !== text) note.textContent = text;
  // The bar's Clear drops the component's own sort too (`s.sort` is set only for
  // one: a native heading's sort nulls it), naming what it clears.
  const sorted = !!s.sort, show = !!names.length || sorted;
  const clr = bar.querySelector('.tcol-clear');
  if (clr) {
    if (clr.hidden === show) clr.hidden = !show;
    const lab = names.length && sorted ? 'Clear sort and filters' : sorted ? 'Clear sort' : 'Clear column filters';
    if (clr.textContent !== lab) clr.textContent = lab;
  }
  const sf = bar.querySelector('.tcol-sf-btn');
  if (sf && sf.classList.contains('is-on') !== !!names.length) sf.classList.toggle('is-on', !!names.length);
}

/** Re-apply a table's columns, headings and (DOM-mode) filters/sort. */
export function syncTable(table) {
  if (!table || !table.dataset || !table.dataset.tcols || !table.tHead) return;
  const key = table.dataset.tcols;
  // A list drawn for another event (`data-tcols-scope`) starts with no sort or
  // filters: one chosen in event A is not applied to event B's (sweep #311).
  const scope = table.dataset.tcolsScope;
  if (scope != null) { const st = _st(key); if (st.scope !== scope) { st.sort = null; st.filters.clear(); st.scope = scope; } }
  const cols = tableColumns(table);
  if (!cols.length) return;
  _decorateHeads(table, key, cols);
  _applyColumns(table, key, cols);
  const counts = _applyDomFilterSort(table, key, cols);
  _paintBar(_barFor(table, key), key, cols, counts);
}

function _rerender(key) {
  const cfg = _cfg(key);
  if (cfg.model && typeof cfg.model.onChange === 'function') cfg.model.onChange();
  document.querySelectorAll(`table[data-tcols="${CSS.escape(key)}"]`).forEach(syncTable);
}

function _rerenderColumns(key) {
  document.querySelectorAll(`table[data-tcols="${CSS.escape(key)}"]`).forEach(syncTable);
  if (_cfg(key).onColumns) _cfg(key).onColumns();
}

// ── A heading across a re-render ─────────────────────────────────────────────
// Some boards rebuild their whole <thead> on every sort (the rankings cards and
// the group board), so a heading held from before the sort is detached. Its own
// sort attributes, which the rebuilt heading repeats, find the one now on screen.
function _thSelector(th) {
  if (!th) return null;
  const attrs = ['data-action', 'data-key', 'data-col', 'data-sort', 'data-tcol', 'data-pcol'].filter(a => th.hasAttribute(a));
  const tab = th.closest('table[data-tcols]');
  if (!attrs.length || !tab) return null;
  return `table[data-tcols="${CSS.escape(tab.dataset.tcols)}"] th${attrs.map(a => `[${a}="${CSS.escape(th.getAttribute(a))}"]`).join('')}`;
}

function _liveTh(th, sel) { return th && th.isConnected ? th : ((sel && document.querySelector(sel)) || null); }

// ── Popovers ─────────────────────────────────────────────────────────────────
let _pop = null;
// A heading button whose <thead> was rebuilt while its menu was open (Logs and
// the rankings boards rebuild theirs on every render, a sort included) is
// detached: the same column's button in the table now on screen (the same one
// of several boards sharing a key, by position) is the opener from then on.
function _liveTwin(anchor, tableKey, tableIdx) {
  const col = anchor?.getAttribute?.('data-tcol-menu');
  if (!col || !tableKey) return null;
  const tables = [...document.querySelectorAll(`table[data-tcols="${CSS.escape(tableKey)}"]`)];
  const t = tables[tableIdx] || tables[0];
  return t ? t.querySelector(`.tcol-hbtn[data-tcol-menu="${CSS.escape(col)}"]`) : null;
}

/** The popover's opener as it is on screen now: the rebuilt heading's button
 *  when the heading was rebuilt under the open menu, for the focus return and
 *  the outside-click test, and it says the menu is open (aria-expanded), as the
 *  button it replaced did. */
function _popAnchor() {
  if (!_pop) return null;
  const { anchor, tableKey, tableIdx } = _pop;
  if (anchor && anchor.isConnected) return anchor;
  const live = _liveTwin(anchor, tableKey, tableIdx);
  if (!live) return anchor;
  _pop.anchor = live;
  if (live.getAttribute('aria-expanded') !== 'true') live.setAttribute('aria-expanded', 'true');
  return live;
}

function _closePop(focusBack = true) {
  if (!_pop) return;
  const anchor = _popAnchor();
  const { el, outside } = _pop;
  _pop = null;
  el.remove();
  document.removeEventListener('pointerdown', outside, true);
  anchor?.setAttribute('aria-expanded', 'false');
  if (focusBack && anchor && anchor.isConnected) anchor.focus();
}

function _place(el, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
  let top = r.bottom + 6;
  // Below the opener, else above it, else (a short screen: neither fits) as
  // low as it fits, over the opener rather than off the screen. The popover's
  // max-height (70% of the viewport) means it always fits somewhere.
  if (top + h > vh - 8) top = r.top - h - 6 > 8 ? r.top - h - 6 : vh - h - 8;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
}

function _openPop(anchor, html, label, wire) {
  _closePop(false);
  const el = document.createElement('div');
  el.className = 'card tcol-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', label);
  setSafeHtml(el, html);
  document.body.appendChild(el);
  _place(el, anchor);
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (e) => { const a = _popAnchor(); if (!el.contains(e.target) && !(a && a.contains(e.target))) _closePop(false); };
  // The table the opener sits in, read while it is attached (see _liveTwin).
  const table = anchor.closest?.('table[data-tcols]') || null;
  const tableKey = table?.dataset?.tcols || null;
  const tableIdx = tableKey ? [...document.querySelectorAll(`table[data-tcols="${CSS.escape(tableKey)}"]`)].indexOf(table) : -1;
  _pop = { el, anchor, outside, tableKey, tableIdx };
  setTimeout(() => { if (_pop && _pop.el === el) document.addEventListener('pointerdown', outside, true); }, 0);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); _closePop(); return; }
    if (e.key === 'Tab') {
      const f = [...el.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  wire(el);
  (el.querySelector('[data-autofocus]') || el.querySelector('input:not([disabled]), select, button'))?.focus();
  return el;
}

/** The Columns menu. `anchor` is the button that opened it. */
export function openColumnsMenu(key, anchor, inTable = null) {
  const table = inTable || _tableFor(key);
  if (!table) return;
  const cols = tableColumns(table).filter(c => c.key !== '_select' && c.label);
  const shown = new Set(shownColumns(key, tableColumns(table)));
  const forced = new Set((_cfg(key).forceHidden && _cfg(key).forceHidden()) || []);
  const html = `<p class="t-eyebrow" id="tcol-cols-title">Columns</p><div class="tcol-cols-list">${cols.map(c =>
    `<label class="checkbox-row"><input type="checkbox" data-tcol-key="${esc(c.key)}"${shown.has(c.key) ? ' checked' : ''}${_isFixed(key, c.key) ? ' disabled' : ''}/> ${esc(c.label)}${forced.has(c.key) ? ` <span class="t-muted">${esc((_cfg(key).forceHiddenNote && _cfg(key).forceHiddenNote(c.key)) || '(in an event)')}</span>` : ''}</label>`).join('')}</div>
    <div class="modal-foot"><button type="button" class="btn sm secondary" data-tcol-reset>Reset to default</button><button type="button" class="btn sm" data-tcol-done>Done</button></div>`;
  _openPop(anchor, html, 'Columns', (el) => {
    el.classList.add('tcol-cols-pop');
    if (_cfg(key).popId) el.id = _cfg(key).popId;
    const save = () => {
      const drawn = tableColumns(table).map(c => c.key);
      const keys = drawn.filter(k => {
        const i = el.querySelector(`[data-tcol-key="${CSS.escape(k)}"]`);
        return i ? i.checked : shown.has(k);
      });
      _saveShown(key, drawn, keys);
      _rerenderColumns(key);
    };
    el.addEventListener('change', save);
    el.querySelector('[data-tcol-done]').addEventListener('click', () => _closePop());
    el.querySelector('[data-tcol-reset]').addEventListener('click', () => {
      _resetShown(key);
      const def = new Set(shownColumns(key, tableColumns(table)));
      for (const i of el.querySelectorAll('[data-tcol-key]')) i.checked = def.has(i.dataset.tcolKey);
      _rerenderColumns(key);
    });
  });
}

function _distinct(key, table, col) {
  const cfg = _cfg(key);
  const o = _colOpts(key, col.key);
  // `options` may be a function, read when the menu opens (a label table a
  // module cannot read while it is still being initialised).
  const opts = typeof o.options === 'function' ? o.options() : o.options;
  if (Array.isArray(opts)) return opts;
  const out = new Map();
  const add = v => { const s = String(v ?? '').trim(); if (s && s !== '—' && !out.has(s.toLowerCase())) out.set(s.toLowerCase(), s); };
  if (cfg.model?.get && cfg.model.rows) {
    for (const r of cfg.model.rows() || []) { const v = cfg.model.get(r, col.key); if (Array.isArray(v)) v.forEach(add); else add(v); }
  } else {
    for (const { row: tr } of _entries(table)) {
      if (_filterType(key, col) === 'tags') { for (const i of col.idx) { const td = _cellAt(tr, i); td?.querySelectorAll('.tag, .chip, .badge').forEach(n => add(n.childNodes[0]?.textContent || n.textContent)); } }
      else add(_cellText(tr, col));
    }
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** The sort-and-filter menu for one heading. `opts.back` adds "All columns",
 *  which returns to the phone list it was opened from. */
export function openHeadingMenu(key, colKey, anchor, inTable = null, opts = {}) {
  const table = inTable || anchor?.closest?.('table[data-tcols]') || _tableFor(key);
  if (!table) return;
  const cols = tableColumns(table);
  const col = cols.find(c => c.key === colKey);
  if (!col) return;
  const s = _st(key);
  const ft = _filterType(key, col), so = _sortable(key, col);
  const native = _nativeTh(col);
  const cur = s.filters.get(colKey);
  const id = esc(`tcol-f-${_slug(key)}-${_slug(colKey)}`);
  let control = '';
  if (ft === 'enum' || ft === 'tags') {
    const opts = _distinct(key, table, col);
    control = `<label class="tcol-field" for="${id}">${ft === 'tags' ? 'Has tag' : 'Is'}</label><select id="${id}" data-tcol-input data-autofocus><option value="">Any</option>${opts.map(v => `<option value="${esc(v)}"${String(cur || '').toLowerCase() === v.toLowerCase() ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  } else if (ft === 'date') {
    control = `<div class="tcol-dates"><label class="tcol-field" for="${id}-from">From</label><input type="date" id="${id}-from" data-tcol-from value="${esc(cur?.from || '')}" data-autofocus/><label class="tcol-field" for="${id}-to">To</label><input type="date" id="${id}-to" data-tcol-to value="${esc(cur?.to || '')}"/></div>`;
  } else if (ft === 'text') {
    control = `<label class="tcol-field" for="${id}">Contains</label><input type="text" id="${id}" data-tcol-input value="${esc(cur || '')}" autocomplete="off" spellcheck="false" data-autofocus/>`;
  }
  const curSort = _curSort(key, col);
  const html = `<p class="t-eyebrow">${esc(col.label)}</p>
    ${so ? `<div class="tcol-sort-row" role="group" aria-label="Sort ${esc(col.label)}"><button type="button" class="btn sm secondary${curSort === 'ascending' ? ' is-active' : ''}" data-tcol-sort="asc" aria-pressed="${curSort === 'ascending'}">Sort ascending</button><button type="button" class="btn sm secondary${curSort === 'descending' ? ' is-active' : ''}" data-tcol-sort="desc" aria-pressed="${curSort === 'descending'}">Sort descending</button></div>` : ''}
    ${control ? `<div class="tcol-filter">${control}</div>` : ''}
    <div class="modal-foot">${opts.back ? '<button type="button" class="btn sm secondary" data-tcol-back>All columns</button>' : ''}${ft ? '<button type="button" class="btn sm secondary" data-tcol-fclear>Clear</button>' : ''}<button type="button" class="btn sm" data-tcol-done>Done</button></div>`;
  _openPop(anchor, html, `${col.label}: sort and filter`, (el) => {
    let t = null;
    const set = (v) => {
      const empty = v == null || v === '' || (typeof v === 'object' && !v.from && !v.to);
      if (empty) s.filters.delete(colKey); else s.filters.set(colKey, v);
      _rerender(key);
    };
    const inp = el.querySelector('[data-tcol-input]');
    if (inp && inp.tagName === 'INPUT') inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => set(inp.value.trim()), 200); });
    if (inp && inp.tagName === 'SELECT') inp.addEventListener('change', () => set(inp.value));
    const fr = el.querySelector('[data-tcol-from]'), to = el.querySelector('[data-tcol-to]');
    if (fr && to) { const d = () => set({ from: fr.value, to: to.value }); fr.addEventListener('change', d); to.addEventListener('change', d); }
    el.querySelector('[data-tcol-fclear]')?.addEventListener('click', () => {
      clearTimeout(t);
      if (inp) inp.value = '';
      if (fr) fr.value = '';
      if (to) to.value = '';
      set('');
    });
    el.querySelector('[data-tcol-done]').addEventListener('click', () => { clearTimeout(t); if (inp && inp.tagName === 'INPUT') set(inp.value.trim()); _closePop(); });
    el.querySelector('[data-tcol-back]')?.addEventListener('click', () => { clearTimeout(t); if (inp && inp.tagName === 'INPUT') set(inp.value.trim()); opts.back(); });
    for (const b of el.querySelectorAll('[data-tcol-sort]')) b.addEventListener('click', () => {
      const asc = b.dataset.tcolSort === 'asc';
      if (native) _driveNative(key, native, asc, colKey);
      else { s.sort = { col: colKey, asc }; _rerender(key); }
      for (const o of el.querySelectorAll('[data-tcol-sort]')) { const on = o === b; o.classList.toggle('is-active', on); o.setAttribute('aria-pressed', String(on)); }
    });
  });
}

/** Sort & filter (phones; touch screens 769-1279 px): the columns whose heading carries a button on a
 *  wide screen — shown, and offering a sort or a filter — each opening that
 *  heading's own menu. Read from the table, so it cannot list another set. */
export function openSortFilterMenu(key, anchor, inTable = null) {
  const table = inTable || _tableFor(key);
  if (!table) return;
  const s = _st(key);
  const cols = tableColumns(table).filter(c => c.th.some(t => t.querySelector(':scope > .tcol-hbtn') && !t.classList.contains('tcol-off')));
  const STATE = { ascending: 'Sorted ascending', descending: 'Sorted descending' };
  const picks = cols.map(c => {
    const st = [STATE[_curSort(key, c)], s.filters.has(c.key) ? 'Filtered' : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="tcol-pick" data-tcol-pick="${esc(c.key)}"><span class="tcol-pick-name">${esc(c.label)}</span>${st ? ` <span class="tcol-pick-state">${esc(st)}</span>` : ''}</button>`;
  }).join('');
  const html = `<p class="t-eyebrow">Sort and filter by</p><div class="tcol-picks">${picks || '<p class="t-muted">No column here sorts or filters.</p>'}</div>
    <div class="modal-foot">${(s.filters.size || s.sort) ? `<button type="button" class="btn sm secondary" data-tcol-pclear>${s.filters.size && s.sort ? 'Clear sort and filters' : s.sort ? 'Clear sort' : 'Clear column filters'}</button>` : ''}<button type="button" class="btn sm" data-tcol-done>Done</button></div>`;
  _openPop(anchor, html, 'Sort and filter', (el) => {
    el.classList.add('tcol-sf-pop');
    for (const b of el.querySelectorAll('[data-tcol-pick]')) b.addEventListener('click', () => {
      openHeadingMenu(key, b.dataset.tcolPick, anchor, table, { back: () => openSortFilterMenu(key, anchor, table) });
    });
    el.querySelector('[data-tcol-pclear]')?.addEventListener('click', () => { clearColumnView(key); openSortFilterMenu(key, anchor, table); });
    el.querySelector('[data-tcol-done]').addEventListener('click', () => _closePop());
  });
}

let _driveTimer = null;
function _driveNative(key, th, asc, colKey) {
  const hadOwnSort = !!_st(key).sort;
  _st(key).sort = null;
  // A newer press owns the heading: an older press's look-again must not click
  // after it (Descending then Ascending inside 60 ms clicked four times and
  // left the heading saying "descending" in between).
  clearTimeout(_driveTimer);
  _driveTimer = null;
  // A table whose sort cannot be read back from a toggled heading names its own
  // setter (`cfg.sortTo(colKey, asc, th)`), which sets the order outright, never
  // a toggle: a SERVER sort (Submissions, Logs) answers after a fetch, and the
  // rankings boards rebuild the heading itself.
  const sortTo = _cfg(key).sortTo;
  if (typeof sortTo === 'function') { sortTo(colKey, asc, th); return; }
  const want = asc ? 'ascending' : 'descending';
  // Every read and click goes to the heading as it is on screen NOW (a re-render
  // may have replaced the one this press was given).
  const sel = _thSelector(th);
  const live = () => _liveTh(th, sel);
  const now = () => live()?.getAttribute('aria-sort') ?? null;
  const before = now();
  if (before === want) {
    // The order is already the heading's, but the rows were the component's:
    // they must be drawn again in the heading's order.
    if (hadOwnSort) _rerender(key);
    return;
  }
  live()?.click();
  const after = now();
  if (after === want) return;
  // A heading that sorts as it is clicked (the model tables) has answered:
  // it landed on the other direction, so one more click is the one asked for.
  if (after !== before) { live()?.click(); return; }
  // Otherwise the sort answers later: look again once it has.
  _driveTimer = setTimeout(() => {
    _driveTimer = null;
    const h = live();
    if (h && h.getAttribute('aria-sort') !== want) h.click();
  }, 60);
}

/** Clear every column filter on a table. */
export function clearColumnFilters(key) {
  _st(key).filters.clear();
  _rerender(key);
}

/** The bar's Clear: every column filter AND the component's own sort. A page-only
 *  table's rows go back to the order they were drawn in; a model table re-renders
 *  in its own order (sweep #311). */
export function clearColumnView(key) {
  const s = _st(key);
  s.filters.clear();
  s.sort = null;
  _rerender(key);
}

/** Drop the filters on columns a table no longer shows (the caller re-renders):
 *  a filter must not hide rows for a reason nobody can see. */
export function dropColumnFilters(key, colKeys) {
  const f = _st(key).filters;
  let dropped = false;
  for (const k of colKeys || []) if (f.delete(k)) dropped = true;
  return dropped;
}

// ── Tables that filter the rows on screen (no model) ────────────────────────
// Pure data; boot() defines each. `paged:false` means every row is on screen,
// so the count says "shown" rather than "on this page". A column that is a row's
// only door (Audit's Details) is `fixed`, like every Actions column.
export const PLAIN_TABLES = {
  groups: { noun: 'group', cols: { name: { grow: true } } },
  // Users & roles (features/users-admin.js): every platform user is on screen.
  // Last sign-in carries the instant as data-sort-value, so it sorts in time
  // order and filters by a date range.
  // The address takes the spare width (not the name, which is short): at a
  // desktop width it stays on one line.
  users: { noun: 'user', paged: false, cols: { email: { grow: true }, role: { filter: 'enum' }, status: { filter: 'enum' }, last_sign_in: { filter: 'date' } } },
  // Rankings (both boards) and Analytics filter their whole data set, which
  // their exports share: features/rankings-admin.js RANKINGS_TABLE_COLUMNS,
  // features/analytics-admin.js ANALYTICS_TABLE_COLUMNS.
  certificates: { noun: 'certificate', paged: false, cols: { holder: { grow: true }, certificate: { filter: 'enum' }, email: { filter: 'enum' } } },
  // Each account is its own <tbody>: its facts, then its "What to do" row.
  // Since sorts and filters by the time its cell carries (data-sort-value).
  'cxone-withdrawals': { noun: 'account', paged: false, unit: 'tbody', cols: { state: { filter: 'enum' }, tenant: { filter: 'enum' }, event: { filter: 'enum' }, since: { filter: 'date' } } },
  // The Audit pane (features/audit-admin.js): server filters live in its filter
  // bar; these sort and filter the page shown ("on this page"). Its When
  // cells carry the instant as data-sort-value (ISO 8601), so When sorts in time
  // order and filters by a date range. Details is a row's only door, so fixed.
  // Settings → CxOne API audit (features/settings-admin.js loadCxoneAuditCard):
  // the audit trail narrowed to Checkmarx One; Time carries the instant as
  // data-sort-value. Sorts and filters the page shown, as the Audit pane does.
  'cxone-audit': { noun: 'record', cols: { at: { filter: 'date' }, activity: { grow: true, filter: 'enum' }, event: { filter: 'enum' }, result: { filter: 'enum' }, detail: { grow: true } } },
  audit: { noun: 'record', cols: { when: { filter: 'date' }, activity: { grow: true }, type: { filter: 'enum' }, outcome: { filter: 'enum' }, details: { sort: false, filter: null, fixed: true } } },
  // An event's Team & reports section (features/event-team.js): every row is on
  // screen. Where a lead came from and whether they are new are under Columns,
  // so the lead list's default set fits a 1024 px window.
  'team-members': { noun: 'member', paged: false, cols: { member: { grow: true }, actions: { sort: false, filter: null } } },
  'team-challenges': { noun: 'question', paged: false, cols: { challenge: { grow: true }, flag: { filter: 'enum' } } },
  'team-accounts': { noun: 'account', paged: false, cols: { company: { grow: true }, signal: { filter: 'enum' } } },
  'team-scorecard': { noun: 'measure', paged: false, cols: { measure: { grow: true }, status: { sort: false, filter: null } } },
  // Settings → People → Staff teams (features/staff-teams.js): every team, and
  // the chosen team's members, are on screen.
  'staff-teams': { noun: 'team', paged: false, cols: { team: { grow: true }, actions: { sort: false, filter: null } } },
  'staff-team-members': { noun: 'member', paged: false, cols: { member: { grow: true }, default_role: { filter: 'enum' }, account: { filter: 'enum' }, actions: { sort: false, filter: null } } },
  'team-leads': { noun: 'lead', paged: false, hidden: ['new_or_returning', 'where_from'], cols: { lead: { grow: true }, signal: { filter: 'enum' }, owner: { filter: 'enum' }, contacted: { sort: false, filter: null } } },
};

// ── Install ──────────────────────────────────────────────────────────────────
// The observer syncs only the tables a change TOUCHED: a change inside one (its
// rows, a rebuilt heading) or a table added whole. The admin page also changes
// every second outside any table (the live status strip's countdown), and a
// sweep of every table on each of those walked thousands of cells per second
// for nothing.
const _touched = new Set();
let _pending = false;
function _flush() {
  _pending = false;
  const tables = [..._touched];
  _touched.clear();
  for (const t of tables) if (t.isConnected) syncTable(t);
}

/** The tables a batch of mutations touched (none for a change outside every table). */
export function tablesTouched(muts, selector) {
  const out = new Set();
  for (const m of muts) {
    if (m.type !== 'childList' || !(m.addedNodes.length || m.removedNodes.length)) continue;
    const own = m.target.closest ? m.target.closest(selector) : null;
    if (own) { out.add(own); continue; }
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(selector)) out.add(n);
      else n.querySelectorAll(selector).forEach(x => out.add(x));
    }
  }
  return out;
}

/** Installed once from boot(). */
export function installTableColumns() {
  const root = document.getElementById('admin-page');
  if (!root || root._tcolObs) return;
  const obs = new MutationObserver((muts) => {
    // A heading button, and its markup, are ours, not a change to the table.
    const ours = n => n.nodeType === 1 && (n.classList.contains('tcol-hbtn') || n.classList.contains('tcol-sort-ic'));
    const own = muts.filter(m => !(m.target.closest && m.target.closest('.tcol-hbtn, .tcol-sort-ic'))
      && !(m.addedNodes.length && !m.removedNodes.length && [...m.addedNodes].every(ours)));
    for (const t of tablesTouched(own, 'table[data-tcols]')) _touched.add(t);
    if (_pending || !_touched.size) return;
    _pending = true;
    queueMicrotask(_flush);
  });
  obs.observe(root, { childList: true, subtree: true });
  root._tcolObs = obs;

  // Capture phase: a heading button must not also fire its heading's sort.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const hb = t.closest('.tcol-hbtn');
    if (hb) {
      e.stopPropagation(); e.preventDefault();
      const key = hb.closest('table[data-tcols]')?.dataset.tcols;
      if (!key) return;
      if (_pop && (_pop.anchor === hb || _popAnchor() === hb)) { _closePop(); return; }
      openHeadingMenu(key, hb.dataset.tcolMenu, hb);
      return;
    }
    const sf = t.closest('[data-tcol-sortfilter]');
    if (sf) { e.stopPropagation(); if (_pop && _pop.anchor === sf) { _closePop(); return; } openSortFilterMenu(sf.dataset.tcolSortfilter, sf); return; }
    const cb = t.closest('[data-tcol-columns]');
    if (cb) { e.stopPropagation(); if (_pop && _pop.anchor === cb) { _closePop(); return; } openColumnsMenu(cb.dataset.tcolColumns, cb); return; }
    const clr = t.closest('[data-tcol-clear]');
    // The bar's own Clear drops the sort too; an empty state's "clear the
    // filters" button (it carries the same attribute) clears only filters.
    if (clr) { e.stopPropagation(); (clr.classList.contains('tcol-clear') ? clearColumnView : clearColumnFilters)(clr.dataset.tcolClear); return; }
    const ds = t.closest('th[data-tcol-dsort]');
    if (ds) {
      const key = ds.closest('table[data-tcols]')?.dataset.tcols;
      if (!key) return;
      const s = _st(key), col = ds.dataset.tcolDsort;
      s.sort = s.sort && s.sort.col === col ? { col, asc: !s.sort.asc } : { col, asc: true };
      _rerender(key);
      return;
    }
    // A native sortable heading takes over from the component's sort. It claimed
    // nothing while the component sorted, so the press is a fresh pick: its
    // column, ascending (its own toggle would start from its stale state).
    const nat = t.closest('table[data-tcols] th.sortable:not([data-tcol-dsort])');
    if (nat) {
      const table = nat.closest('table[data-tcols]');
      const key = table.dataset.tcols;
      if (_st(key).sort) {
        const col = tableColumns(table).find(c => c.th.includes(nat));
        if (col) { e.stopPropagation(); e.preventDefault(); _driveNative(key, nat, true, col.key); return; }
        _st(key).sort = null;
        queueMicrotask(() => { const tb = _tableFor(key); if (tb) syncTable(tb); });
      }
    }
  }, true);
  // Enter/Space on a heading button belongs to the button (its native click),
  // never to the `.sortable` heading delegator in core/main.js.
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('.tcol-hbtn')) e.stopPropagation();
  }, true);
  window.addEventListener('resize', () => { if (_pop) _place(_pop.el, _popAnchor()); });
  root.querySelectorAll('table[data-tcols]').forEach(syncTable);
}
