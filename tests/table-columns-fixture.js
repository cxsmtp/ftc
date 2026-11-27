"use strict";

// Mocked answers for the two SERVER-paged admin tables (Submissions, Logs),
// shared by tests/table-columns.spec.js (geometry) and
// tests/table-columns-server.spec.js (heading sort + filter).
//
// Mocked on purpose, as tests/logs-pager-ui.spec.js does: what is under test is
// what the client does with an answer (which request a heading menu sends, and
// which rows a heading filter hides on the page in hand). The servers' own sort
// contracts are pinned for real in logs-global-sort.api.spec.js and
// submissions-sort-note.spec.js.

/** A /api/admin/submissions body. `rows` are partial event objects. */
function submissionsBody(rows, over = {}) {
  const events = rows.map((r, i) => ({
    event_type: "submission", is_correct: 1, points_delta: 100, answer: "flag",
    nickname: `player${i}`, competition_name: "Event", timeslot_name: null, task_title: "Challenge",
    event_time: new Date(Date.parse("2001-06-12T12:00:00.000Z") - i * 60_000).toISOString(),
    ...r,
  }));
  return {
    events, total: over.total ?? events.length, sorted_globally: !!over.sorted_globally,
    snapshot_before: events[0]?.event_time || null, snapshot_tie: "t0", max_mutation_at: null,
    ...over,
  };
}

/** A /api/admin/logs body (app stream). `rows` are partial entries. By default
 *  it answers for a NARROWED log (`sortable_globally: true`: a search or group is
 *  set, so a heading sort is a new request). The unnarrowed answer, where a sort
 *  reorders the page in hand and asks nothing, is `{ sortable_globally: false }`
 *  (tests/audit-raw-logs.spec.js). */
function logsBody(rows, over = {}) {
  const entries = rows.map((r, i) => ({
    ts: new Date(Date.parse("2001-06-12T12:00:00.000Z") - i * 1000).toISOString(),
    level: "info", msg: `entry ${i}`, ...r,
  }));
  const total = over.total ?? entries.length;
  const limit = over.limit ?? 50;
  return {
    entries, file: null, files_scanned: ["app-2001-06-12.jsonl"], count: entries.length, total,
    offset: 0, limit, truncated: false, redacted: false, anchor_ts: entries[0]?.ts || null,
    sort: null, dir: null, sortable_globally: true, sorted_globally: false, sort_scope: "default",
    sort_unavailable: null, sort_max_window: 25000, total_exact: true, truncated_reason: null,
    total_pages: Math.max(1, Math.ceil(total / limit)), scanned: total,
    ...over,
  };
}

/** Route an endpoint through `fn(url) -> body`, recording every request URL. */
async function mockJson(page, glob, fn) {
  const seen = [];
  await page.route(glob, async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fn(url)) });
  });
  return seen;
}

module.exports = { submissionsBody, logsBody, mockJson };
