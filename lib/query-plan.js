"use strict";

// READING A QUERY PLAN — the rows of `EXPLAIN QUERY PLAN` ({ id, parent, detail }).
// Pure: the caller runs the EXPLAIN (routes/audit.js, the Audit page's walk
// budget) and hands the rows here, so the reading is testable on its own.
//
// walksByTime(plan, alias, timeColumn) answers: does this plan visit rows of the
// table `alias` until its LIMIT fills, however few of them match?
//
//   false — the table is reached through SEARCHES alone, loop by loop from the
//           outermost, each on something other than its time column (a person,
//           an event's own column, an actor; an OR over such searches too). The
//           walk visits only the rows those searches select.
//   true  — anything else: the table walked by its time index, with or without
//           a range on the time column ("SEARCH sb … (submitted_at<?)" is still
//           a walk through time), or whole; or reached from an outer loop that
//           enumerates another table whole ("SCAN u" driving "SEARCH user_events
//           … (user_id=?)" visits every user's rows); or not found at all.
//
// Subquery, sort and bloom-filter nodes are not loops of the walk and are
// skipped; only top-level nodes (parent 0) and the searches under a top-level
// "MULTI-INDEX OR" are read.

function _selective(detail, timeColumn) {
  if (!detail.startsWith("SEARCH ")) return false;
  const terms = /\(([^)]*)\)$/.exec(detail);
  if (!terms) return false;
  const time = new RegExp(`^${timeColumn}[<>=]`);
  return !terms[1].split(" AND ").every(t => time.test(t.trim()));
}

function walksByTime(plan, alias, timeColumn) {
  const rows = (plan || []).map(p => ({ id: p.id, parent: p.parent, d: String(p.detail) }));
  const own = new RegExp(`^SEARCH ${alias}(?: |$)`);
  for (const node of rows.filter(p => p.parent === 0)) {
    let loops;
    if (/^(?:SCAN|SEARCH) /.test(node.d)) loops = [node.d];
    else if (node.d.startsWith("MULTI-INDEX OR")) loops = rows.filter(p => rows.some(q => q.parent === node.id && q.id === p.parent)).map(p => p.d);
    else continue;
    if (!loops.length || !loops.every(d => _selective(d, timeColumn))) return true;
    if (loops.some(d => own.test(d))) return false;
  }
  return true;
}

module.exports = { walksByTime };
