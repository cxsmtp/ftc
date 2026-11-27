"use strict";
//
// v7.25.0 — the ordering rules for GET /api/admin/logs, in one place.
//
// Sorting the Logs tab used to be a purely client-side reorder of the rows in
// hand, and the pager said so ("Sorted within this page"). That is honest and
// useless for the job an operator actually opens this tab to do: filter to one
// address, then reach the OLDEST request it made. The oldest row is on the last
// page by construction, so a page-local sort can never surface it.
//
// So a FILTERED query now sorts globally on the server, and the server needs a
// comparator. This module is it — pure, no db, no fs, so the whole ordering
// matrix is a unit test.
//
// THE RULES ARE THE CLIENT'S, DELIBERATELY. `_sortLogRows` in
// public/js/features/settings-admin.js has ordered these columns for releases,
// and the one thing this feature must never do is make a column REORDER when
// the admin types into the search box — a filter is not supposed to change what
// "sorted by Status" means. So this file mirrors that function's three branches
// exactly (severity rank for `level`, numeric-with-blanks-last for the number
// columns, `localeCompare` for the rest) rather than improving on them.
// `public/js` is a browser-only ESM graph and cannot import `lib/`, so the copy
// is irreducible — the same situation as DIFF_PTS, DRY_RUN_TAG and
// compareTaskNumbers, and like those it is held by a Docs-hygiene lock that
// diffs the two rule tables.

// Severity, worst first when descending. A missing level reads as 0, below
// `debug` — mirroring the client, where `??0` does the same. Sorting `level`
// alphabetically (debug, error, info, warn) buries errors in the middle of the
// one column an operator sorts to triage, which is why the rank exists at all
// (v7.16.7).
const LOG_LEVEL_RANK = { error: 4, warn: 3, info: 2, debug: 1 };

// Columns compared as numbers. A missing value sorts LAST in both directions
// rather than switching the column to text ordering, where "9" sorts after
// "100".
const LOG_NUMERIC_COLS = new Set(["status", "ms", "bytes"]);

// The columns a filtered query can sort GLOBALLY.
//
// Row-native fields only, and that boundary is the whole reason the list is
// short. `user_first_name` / `user_last_name` / `user_email` / `user_groups`
// do not exist in the log file at all — they are attached at read time by
// `_enrichLogRowsWithUserDetails`, which runs on the ALREADY-SLICED page.
// Sorting them globally would mean enriching the entire matched set: a
// full-table user directory plus a group-membership read on every request, for
// a platform whose own perf fixtures seed 5 000 users. `changed_by` is in the
// file but the cell renders the RESOLVED actor name, so ordering by the raw
// column would disagree with what is on screen — the v7.21.16 "mirror what the
// cell renders" rule, refused rather than half-kept.
//
// A header click on one of those still works; it sorts the page in hand and the
// pager SAYS SO. That is the honest degradation, and it is why the note is
// keyed on the server's own `sorted_globally` echo rather than on whether a
// filter happens to be applied.
const LOG_SORT_COLUMNS = new Set([
  "ts", "level", "msg", "method", "path", "status", "ms", "ip",
]);

/**
 * Compare two rows on one column, in ONE direction (ascending).
 * Returns 0 for "indistinguishable on this key" — the caller applies the
 * direction and the tiebreak.
 *
 * Blank handling differs per branch because the client's differs per branch,
 * and matching it is the point. Numeric blanks sort last in BOTH directions
 * (the sign is not flipped); `level` and string blanks ride the direction, as
 * they do today.
 */
function _compareOnKey(a, b, col) {
  if (col === "level") {
    const ra = LOG_LEVEL_RANK[String((a && a.level) || "").toLowerCase()] ?? 0;
    const rb = LOG_LEVEL_RANK[String((b && b.level) || "").toLowerCase()] ?? 0;
    return ra === rb ? 0 : (ra - rb);
  }
  if (LOG_NUMERIC_COLS.has(col)) {
    // Test null/undefined/"" BEFORE Number(): Number(null) and Number("") are
    // both 0, so a row with no duration would otherwise sort as a genuine zero
    // and sit at the top of an ascending sort — a different wrong answer from
    // the one the numeric branch exists to fix.
    const rawA = a ? a[col] : undefined, rawB = b ? b[col] : undefined;
    const aMissing = (rawA === null || rawA === undefined || rawA === "");
    const bMissing = (rawB === null || rawB === undefined || rawB === "");
    const na = aMissing ? NaN : Number(rawA), nb = bMissing ? NaN : Number(rawB);
    const aOk = Number.isFinite(na), bOk = Number.isFinite(nb);
    if (aOk && bOk) return na === nb ? 0 : (na - nb);
    if (aOk !== bOk) return aOk ? -Infinity : Infinity;   // blanks last, direction-independent
    return 0;
  }
  const sa = String((a && a[col]) ?? "");
  const sb = String((b && b[col]) ?? "");
  return sa.localeCompare(sb);
}

/**
 * The comparator the selection and the final ordering both use.
 *
 * ONE function for both, deliberately: a hand-written heap would need its own
 * sift ordering, which is two implementations of one rule and the drift shape
 * this codebase keeps rediscovering.
 *
 * THE TAIL IS NOT DECORATION (v6.10.54). Without a total order, rows sharing a
 * sort key swap places between two fetches and the table silently drops or
 * duplicates a row as the admin pages through. `walkSeq` — a counter stamped
 * per surviving row during the newest-first walk — gives that total order by
 * construction, and it is the analogue of the submissions endpoint's `tie_key`.
 * Its direction is FIXED regardless of `dir`, exactly like
 * `ORDER BY <col> <dir>, event_time DESC, tie_key DESC`.
 *
 * The comparator must never return NaN: a NaN result gives implementation-
 * defined ordering, and a log row with an absent or unparseable `ts` is
 * reachable (the walk deliberately lets one through every ts guard).
 */
function makeLogComparator(col, dir) {
  const sign = String(dir || "").toLowerCase() === "asc" ? 1 : -1;
  return (x, y) => {
    const a = x.row, b = y.row;
    const primary = _compareOnKey(a, b, col);
    if (primary !== 0) {
      // The blanks-last sentinels must not be multiplied by the direction, or
      // a descending pass would put every blank first.
      if (primary === Infinity) return 1;
      if (primary === -Infinity) return -1;
      return primary < 0 ? -sign : sign;
    }
    // Tiebreak 1: newest first, always.
    const ta = _tsMs(a), tb = _tsMs(b);
    if (ta !== tb) return tb - ta;
    // Tiebreak 2: walk order, always. Total by construction.
    return x.seq - y.seq;
  };
}

// A row with no usable ts sorts as the beginning of time rather than poisoning
// the comparator with NaN.
function _tsMs(row) {
  const t = row && row.ts ? Date.parse(row.ts) : NaN;
  return Number.isFinite(t) ? t : -8640000000000000;
}

module.exports = {
  LOG_LEVEL_RANK, LOG_NUMERIC_COLS, LOG_SORT_COLUMNS,
  makeLogComparator,
};
