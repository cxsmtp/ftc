"use strict";

// ── Admin tables become label-gutter cards on phones ─────────────────────────
//
// At <=768px every admin data table in a `.table-card` (`#admin-page
// .table-card table`; a `.table-wrap` host, such as Groups', scrolls inside
// itself instead) is laid out as one card per row, each cell a "label | value"
// line (styles.css, "admin: phone cards"). The label is the cell's column heading, carried on the
// cell as `data-label` — written HERE, once, for every table, rather than by
// each of the dozen row renderers (which would drift: a new column would ship
// with no label on phones). Nothing scrolls sideways at 360/390 px.
//
// A MutationObserver on the admin page re-labels the tables a change TOUCHED —
// rows refilled inside one, or a table added whole — and nothing else: the page
// also changes every second outside any table (the live status strip), and
// those changes label nothing. Cells that already carry a `data-label` keep it;
// a cell spanning columns (an empty or failure row) gets none.

import { tablesTouched } from "./table-columns.js";

function _headLabels(table) {
  const ths = table.tHead ? [...table.tHead.rows[0]?.cells || []] : [];
  const out = [];
  for (const th of ths) {
    const span = Number(th.colSpan) || 1;
    const t = th.dataset.label != null ? th.dataset.label
      : (th.querySelector('input') && !th.textContent.trim() ? '' : th.textContent.replace(/[▲▼↑↓]/g, '').replace(/\s+/g, ' ').trim());
    for (let i = 0; i < span; i++) out.push(t);
  }
  return out;
}

export function labelTableCells(table) {
  if (!table || !table.tBodies) return;
  const labels = _headLabels(table);
  if (!labels.length) return;
  for (const tb of table.tBodies) {
    for (const tr of tb.rows) {
      let col = 0;
      for (const td of tr.cells) {
        const span = Number(td.colSpan) || 1;
        if (span > 1) { td.classList.add('tc-span'); col += span; continue; }
        if (!td.hasAttribute('data-label')) td.setAttribute('data-label', labels[col] || '');
        col += 1;
      }
    }
  }
}

const CARD_TABLES = '.table-card table, .tc-cards table';
const _touched = new Set();
let _pending = false;
function _flush() {
  _pending = false;
  const tables = [..._touched];
  _touched.clear();
  for (const t of tables) if (t.isConnected && t.matches(CARD_TABLES)) labelTableCells(t);
}

/** Installed once from boot(). */
export function installTableCards() {
  const root = document.getElementById('admin-page');
  if (!root || root._tcObs) return;
  const obs = new MutationObserver((muts) => {
    for (const t of tablesTouched(muts.filter(m => m.addedNodes.length), 'table')) _touched.add(t);
    if (_pending || !_touched.size) return;
    _pending = true;
    queueMicrotask(_flush);
  });
  obs.observe(root, { childList: true, subtree: true });
  root._tcObs = obs;
  root.querySelectorAll(CARD_TABLES).forEach(labelTableCells);
}
