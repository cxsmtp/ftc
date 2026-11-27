"use strict";

// THE AUDIT PAGE'S WALK BUDGET (routes/audit.js AUDIT_SCAN_BUDGET).
//
// A filter no index serves (an activity, free text, an outcome) walks a source
// in time order until the page fills, however few rows match: on a platform with
// years of records, the whole table on the one thread that also serves live
// events. Such a walk examines at most the newest AUDIT_SCAN_BUDGET rows of the
// source below the cursor; the read answers what it found above the oldest row
// it examined, says how far back it searched (`searched_to`), and Next goes
// on from there. A walk another index leads (a person, an event, which a person
// row names inside `details` and an expression index serves) is never cut.
//
// Each arm plants more rows than the budget, NEWER than anything the server
// writes meanwhile (an hour ahead), so the newest rows of the table are the
// planted ones and every boundary is known. Its own file: a table this full
// would cut the other audit specs' walks.

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin } = require("./helpers");

test.use({ baseURL: BASE, timezoneId: "UTC", locale: "en-GB" });

const BUDGET = 20000;   // routes/audit.js AUDIT_SCAN_BUDGET
const T = `wb${Date.now().toString(36)}${process.pid % 1000}`;
const NEEDLE = `${T}_needle`;
const PERSON_OLD = `${T}_person_old`;
const BASE_MS = Date.now() + 3600e3;          // newer than anything recorded during the run
const iso = (ms) => new Date(ms).toISOString();
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

function openDb() {
  const Database = require("better-sqlite3");
  return new Database(TEST_DB_PATH);
}
const rid = () => require("crypto").randomUUID();

async function audit(api, qs) {
  const r = await api.get(`/api/admin/audit?${qs}`);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  expect(r.status(), text).toBe(200);
  return body;
}
/** Every page, following next_cursor, until has_more is false (at most `max`). */
async function walk(api, qs, max = 6) {
  const pages = [];
  let cursor = null;
  for (let i = 0; i < max; i++) {
    const b = await audit(api, cursor ? `${qs}&cursor=${encodeURIComponent(cursor)}` : qs);
    pages.push(b);
    if (!b.has_more) break;
    cursor = b.next_cursor;
    expect(cursor, "a page with more to come names where to go on").toBeTruthy();
  }
  return pages;
}

const ids = {};
let compId;

test.describe("GET /api/admin/audit — the walk budget", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `Walk budget ${T}`, event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() + 864e5).toISOString(), duration_minutes: 60 } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      compId = (await cr.json()).competition.id;
    } finally { await api.dispose(); }

    const db = openDb();
    try {
      const insO = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      const insE = db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      const insU = db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      db.transaction(() => {
        // Log events: a needle newer than everything, BUDGET + 10 filler rows, and
        // a needle older than every filler row (beyond the first window).
        ids.newNeedle = `log_event:${insO.run(rid(), "export", "x", NEEDLE, "superadmin", iso(BASE_MS + 1000), null, null, null).lastInsertRowid}`;
        for (let i = 0; i < BUDGET + 10; i++) insO.run(rid(), "export", "x", `${T}_fill`, "superadmin", iso(BASE_MS - i), null, null, null);
        ids.oldNeedle = `log_event:${insO.run(rid(), "export", "x", NEEDLE, "superadmin", iso(BASE_MS - 60_000), null, null, null).lastInsertRowid}`;
        // An event record between them: older than the first window's floor, so a
        // read that answered it before the log events' older needle had been
        // searched for would put rows out of order or twice.
        ids.compRow = `event:${insE.run(rid(), compId, NEEDLE, "superadmin", iso(BASE_MS - 30_000), null).lastInsertRowid}`;
        // People: BUDGET + 10 filler rows, then one older row about one person,
        // naming the event inside its details.
        ids.personUser = rid();
        for (let i = 0; i < BUDGET + 10; i++) insU.run(rid(), rid(), `${T}_pfill`, "system", iso(BASE_MS - i), JSON.stringify({ n: i }));
        ids.personOld = `person:${insU.run(rid(), ids.personUser, PERSON_OLD, "system", iso(BASE_MS - 60_000), JSON.stringify({ competition_id: compId })).lastInsertRowid}`;
        // Challenge versions past the budget too, of a challenge in no event: an
        // event filter must reach versions through the event's own challenges,
        // never by walking every version newest first.
        const taskId = rid();
        db.prepare("INSERT INTO tasks (id, title, difficulty, answer_type, correct_answer, status) VALUES (?,?,?,?,?,?)").run(taskId, `Walk budget ${T}`, "easy", "text", "x", "published");
        const insV = db.prepare("INSERT INTO task_versions (id, task_id, version_num, changed_by, changed_at, snapshot, change_type) VALUES (?,?,?,?,?,?,?)");
        for (let i = 0; i < BUDGET + 10; i++) insV.run(rid(), taskId, i + 1, "superadmin", iso(BASE_MS - i), "{}", `${T}_vfill`);
      })();
    } finally { db.close(); }
  });

  // The plan reading, on plan lines this SQLite build prints (captured from the
  // Audit page's own queries). The first case cannot be reached through the test
  // server: with no table statistics the planner walks an organiser's people by
  // time; with them, it drives from every user and searches each one's rows,
  // which visits the whole table just the same.
  test("unit: a plan walks by time unless searches alone, outermost first, reach the table", () => {
    const { walksByTime } = require("../lib/query-plan");
    let id = 0;
    const P = (...nodes) => nodes.map(([parent, detail]) => ({ id: ++id, parent: parent === "top" ? 0 : parent, detail }));
    const top = (d) => ["top", d];
    // An organiser's scope over people, with statistics: every user drives it.
    id = 0;
    expect(walksByTime(P(top("SCAN u"), top("CORRELATED SCALAR SUBQUERY 1"), [2, "SEARCH cu2 USING COVERING INDEX sqlite_autoindex_competition_users_1 (competition_id=? AND user_id=?)"],
      top("SEARCH user_events USING INDEX idx_user_events_user (user_id=?)"), top("USE TEMP B-TREE FOR ORDER BY")), "user_events", "changed_at"), "a full scan outside drives the search").toBe(true);
    id = 0;
    expect(walksByTime(P(top("SEARCH user_events USING COVERING INDEX idx_user_events_user (user_id=?)"), top("USE TEMP B-TREE FOR RIGHT PART OF ORDER BY")), "user_events", "changed_at"), "one person").toBe(false);
    id = 0;
    expect(walksByTime(P(top("SEARCH user_events USING INDEX idx_user_events_competition (<expr>=?)")), "user_events", "changed_at"), "an event named in details, by its expression index").toBe(false);
    id = 0;
    expect(walksByTime(P(top("SEARCH user_events USING INDEX idx_user_events_changed_by (changed_by=? AND changed_at<?)")), "user_events", "changed_at"), "an actor, past a cursor").toBe(false);
    id = 0;
    expect(walksByTime(P(top("SEARCH t USING INDEX idx_timeslots_comp (competition_id=?)"), top("SEARCH te USING COVERING INDEX idx_timeslot_events_ts (timeslot_id=?)"), top("USE TEMP B-TREE FOR ORDER BY")), "te", "changed_at"), "an event's sessions, then their records").toBe(false);
    id = 0;
    expect(walksByTime(P(top("SEARCH t USING COVERING INDEX sqlite_autoindex_tasks_1 (id=?)"), top("LIST SUBQUERY 1"), [2, "SEARCH _act USING COVERING INDEX sqlite_autoindex_competition_tasks_1 (competition_id=?)"],
      top("REUSE LIST SUBQUERY 1"), top("SEARCH v USING INDEX idx_task_versions_task (task_id=?)"), top("USE TEMP B-TREE FOR ORDER BY")), "v", "changed_at"), "an event's challenges, then their versions").toBe(false);
    id = 0;
    expect(walksByTime(P(top("MULTI-INDEX OR"), [1, "INDEX 1"], [2, "SEARCH sb USING COVERING INDEX idx_submissions_user_task_comp_time (user_id=?)"], [1, "INDEX 2"],
      [4, "SEARCH sb USING INDEX idx_submissions_task_correct (task_id=?)"], top("USE TEMP B-TREE FOR ORDER BY")), "sb", "submitted_at"), "a person or a challenge, by two indexes").toBe(false);
    id = 0;
    expect(walksByTime(P(top("SCAN user_events USING INDEX idx_user_events_changed_at"), top("CORRELATED SCALAR SUBQUERY 4"), [2, "SCAN jt VIRTUAL TABLE INDEX 1:"]), "user_events", "changed_at"), "newest first through the time index").toBe(true);
    id = 0;
    expect(walksByTime(P(top("SEARCH sb USING COVERING INDEX idx_submissions_subtime (submitted_at<?)"), top("USE TEMP B-TREE FOR RIGHT PART OF ORDER BY")), "sb", "submitted_at"), "a range on the time column is still a walk through time").toBe(true);
    id = 0;
    expect(walksByTime(P(top("SCAN e USING INDEX idx_competition_events_changed_at"), top("LIST SUBQUERY 1"), [2, "SCAN json_each VIRTUAL TABLE INDEX 1:"]), "e", "changed_at"), "an activity filter").toBe(true);
    id = 0;
    expect(walksByTime(P(top("SCAN o")), "o", "changed_at"), "the whole table").toBe(true);
    expect(walksByTime([], "o", "changed_at"), "no plan line for the table").toBe(true);
  });

  // Every arm below plants just past the budget; a changed budget must move them.
  test("source: the budget is the one this spec plants past", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "audit.js"), "utf8"));
    const m = src.match(/const AUDIT_SCAN_BUDGET = (\d+);/);
    expect(m, "AUDIT_SCAN_BUDGET exists").toBeTruthy();
    expect(Number(m[1])).toBe(BUDGET);
  });

  test("a walk no index serves stops at the budget, says how far back it searched, and Next goes on", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      const q = `types=log_event&event_type=${NEEDLE}&limit=50`;
      const p1 = await audit(api, q);
      expect(p1.rows.map(r => r.id), "only the needle inside the first window").toEqual([ids.newNeedle]);
      expect(p1.has_more, "the walk was cut, so there is more to search").toBe(true);
      expect(typeof p1.searched_to, "and the read says how far back it searched").toBe("string");
      expect(p1.searched_to < iso(BASE_MS + 1000) && p1.searched_to > iso(BASE_MS - BUDGET - 10), `searched_to ${p1.searched_to} lies among the filler rows`).toBe(true);
      expect(p1.total, "the count covers the rows searched").toBe(1);
      expect(p1.total_exact, "…and says it is a floor").toBe(false);
      const p2 = await audit(api, `${q}&cursor=${encodeURIComponent(p1.next_cursor)}`);
      expect(p2.rows.map(r => r.id), "Next finds the older needle").toEqual([ids.oldNeedle]);
      expect(p2.has_more, "the rest of the table fits the budget").toBe(false);
      expect(p2.searched_to, "nothing was cut short").toBeNull();
    } finally { await api.dispose(); }
  });

  test("From and To bound the walk: the older needle is found on the first page, counted exactly", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      const b = await audit(api, `types=log_event&event_type=${NEEDLE}&from=${encodeURIComponent(iso(BASE_MS - 60_001))}&to=${encodeURIComponent(iso(BASE_MS - 59_999))}`);
      expect(b.rows.map(r => r.id)).toEqual([ids.oldNeedle]);
      expect(b.has_more).toBe(false);
      expect(b.searched_to).toBeNull();
      expect(b.total).toBe(1);
      expect(b.total_exact).toBe(true);
    } finally { await api.dispose(); }
  });

  test("across sources, a row older than a cut walk's floor waits for the next page: every row once, in order", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      const pages = await walk(api, `event_type=${NEEDLE}&limit=50`);
      expect(pages[0].rows.map(r => r.id), "the event record is older than the log events' floor").toEqual([ids.newNeedle]);
      expect(pages[0].has_more).toBe(true);
      const all = pages.flatMap(p => p.rows.map(r => r.id));
      expect(all, "each row exactly once, newest first").toEqual([ids.newNeedle, ids.compRow, ids.oldNeedle]);
      const ats = pages.flatMap(p => p.rows.map(r => r.at));
      expect(ats.every((a, i) => i === 0 || ats[i - 1] > a), `strictly newest first: ${ats.join(", ")}`).toBe(true);
    } finally { await api.dispose(); }
  });

  test("a walk an index leads is never cut: one person's records, the event a person row names, and an event across every type", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      // CONTROL: the people table is past the budget, so a walk no index serves
      // does stop short of the older row.
      const cut = await audit(api, `types=person&event_type=${PERSON_OLD}`);
      expect(cut.rows, "CONTROL: the activity filter's walk stops before the older row").toEqual([]);
      expect(cut.has_more).toBe(true);
      expect(typeof cut.searched_to).toBe("string");

      const subject = await audit(api, `types=person&subjectId=${ids.personUser}`);
      expect(subject.rows.map(r => r.id), "the person's own index reaches the older row at once").toEqual([ids.personOld]);
      expect(subject.has_more).toBe(false);
      expect(subject.searched_to).toBeNull();
      expect(subject.total_exact).toBe(true);

      const event = await audit(api, `types=person&competitionId=${compId}`);
      expect(event.rows.map(r => r.id), "the event inside details is served by its expression index").toContain(ids.personOld);
      expect(event.has_more).toBe(false);
      expect(event.searched_to).toBeNull();

      // Every record type at once: the event filter is index-led for each.
      const all = await audit(api, `competitionId=${compId}`);
      const got = all.rows.map(r => r.id);
      expect(got, "the event record and the person record naming the event").toEqual(expect.arrayContaining([ids.compRow, ids.personOld]));
      expect(got.indexOf(ids.compRow), "newest first").toBeLessThan(got.indexOf(ids.personOld));
      expect(all.has_more).toBe(false);
      expect(all.searched_to, "no record type's walk was cut").toBeNull();
      expect(all.total_exact).toBe(true);
    } finally { await api.dispose(); }
  });

  test("the pane says how far back a cut search reached, and Next goes on", async ({ page }) => {
    test.setTimeout(120_000);
    await require("./ui-admin-helpers").adminLogin(page);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    await page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]').evaluate(el => el.click());
    await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#admin-audit-body tr").first()).toBeVisible({ timeout: 20000 });
    const kinds = () => page.locator("#admin-audit-body td.audit-activity").evaluateAll(els => els.map(e => e.dataset.eventType));

    // A search that finds nothing inside the first window: never "nothing matches".
    await page.locator("#audit-search").fill(PERSON_OLD);
    const empty = page.locator("#admin-audit-body td.table-empty-row");
    await expect(empty).toContainText("No matching records back to", { timeout: 15000 });
    await expect(empty).toContainText("Next searches further back, or set From and To.");
    await expect(empty, "not the sentence for a search that searched everything").not.toContainText("match these filters");
    await expect(page.locator("#audit-count")).toContainText("searched back to");
    const next = page.locator('#audit-pagination-bar button[data-action="audit-page-next"]');
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(kinds, { timeout: 15000 }).toEqual([PERSON_OLD]);
    await expect(page.locator("#audit-count"), "the whole table was searched this time").not.toContainText("searched back to");
    await expect(next).toBeDisabled();

    // A search whose first window holds one of three matches.
    await page.locator("#audit-search").fill(NEEDLE);
    await expect.poll(kinds, { timeout: 15000 }).toEqual([NEEDLE]);
    await expect(page.locator("#audit-count")).toContainText("searched back to");
    await next.click();
    await expect.poll(kinds, { timeout: 15000 }).toEqual([NEEDLE, NEEDLE]);
    await expect(page.locator("#audit-count"), "a floor smaller than the rows shown is not quoted").toHaveText("Showing 2 records");
  });
});
