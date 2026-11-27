// @ts-check
//
// CLONE AND TEMPLATES COPY THE PLAN, NEVER ANOTHER EVENT'S OWN ROWS.
//
//   * End Now rewrites the schedule it cuts short: the event's duration becomes
//     the time it ran, and a session that had not started is moved to the end
//     moment with no length. A clone and save-as-template copy the PLAN (the
//     schedule just before the manual end, replayed from the row's history),
//     and never create a session shorter than a minute (the session routes'
//     own floor): one whose plan is lost is left out and named.
//   * Session offsets are measured from the first session, not from the event
//     row's own start, which no session route keeps current.
//   * A qualifying question is a per-event copy: a clone gets its own (fresh
//     built-in copies), a template never holds one, and a spawn never shares one.
//     A clone of a source holding ANY built-in question gets every built-in one,
//     in its default wording (operator ruling, 14 Nov 2026: today's rule kept).
//   * A challenge an event admin may not view is counted in a spawn's answer and
//     never named: no id, no title, not even its draft state.
//
// Every fixture is the test's own; each value asserted is one only the fix gives.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeCompetition, makeTask, assignTask, buildWorld } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ro = () => new Database(TEST_DB_PATH, { readonly: true });
const dbAll = (sql, ...a) => { const db = ro(); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const dbGet = (sql, ...a) => { const db = ro(); try { return db.prepare(sql).get(...a); } finally { db.close(); } };
const onTheMinute = (ms) => { const d = new Date(ms); d.setUTCSeconds(0, 0); return d; };
const sessions = (compId) => dbAll("SELECT name, start_time, duration_minutes FROM competition_timeslots WHERE competition_id=? ORDER BY start_time", compId);
// A qualifying question is a pick-one question (lib/qualifying.js `qualifyingNeedsPickOneDenied`).
const PICK_ONE = { answer_type: "any", correct_answer: "", choices: [{ text: "Small" }, { text: "Large" }] };
const qualifyingIds = (compId) => dbAll("SELECT ct.task_id FROM competition_tasks ct WHERE ct.competition_id=? AND EXISTS (SELECT 1 FROM task_tags t WHERE t.task_id=ct.task_id AND t.tag LIKE 'qualifying:%') ORDER BY ct.task_id", compId).map(r => r.task_id);

let W;
test.beforeAll(async () => { W = await buildWorld(); });
test.afterAll(async () => {
  for (const a of [W && W.sa, W && W.eaApi, W && W.zeroApi]) { try { await a.dispose(); } catch (_) {} }
});

async function endNow(sa, csrf, id) {
  const r = await sa.post(`/api/admin/competitions/${id}/end-now`, { headers: H(csrf) });
  expect(r.ok(), `end-now: ${r.status()} ${await r.text()}`).toBeTruthy();
}
async function clone(sa, csrf, id, data) {
  const r = await sa.post(`/api/admin/competitions/${id}/clone`, { headers: H(csrf), data });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}
async function addSession(sa, csrf, compId, name, startMs, dur) {
  const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H(csrf), data: { name, start_time: new Date(startMs).toISOString(), duration_minutes: dur } });
  expect(r.ok(), `session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
}

test.describe("Clone and save-as-template after End Now copy the plan", () => {
  test("a single-session event ended early is copied at its planned length, by clone and by save-as-template", async () => {
    const { sa, saCsrf } = W;
    const src = await makeCompetition(sa, saCsrf, "endearly", { duration_minutes: 120 });
    await endNow(sa, saCsrf, src.id);
    const stored = dbGet("SELECT duration_minutes, ended_manually FROM competitions WHERE id=?", src.id);
    expect(stored.ended_manually, "PRECONDITION: ended by hand").toBe(1);
    expect(stored.duration_minutes, "PRECONDITION: End Now stored the time it ran, not the plan").toBeLessThan(10);

    const b = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 3 * DAY).toISOString() });
    expect(dbGet("SELECT duration_minutes FROM competitions WHERE id=?", b.competition.id).duration_minutes,
      "the copy runs for the planned two hours").toBe(120);

    const t = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name: `Tpl ${uniq("t")}` } });
    expect(t.status(), await t.text()).toBe(200);
    expect((await t.json()).template.settings.duration_minutes, "the template keeps the plan too").toBe(120);

    // CONTROL: an explicit length still wins.
    const b2 = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 3 * DAY).toISOString(), duration_minutes: 45 });
    expect(dbGet("SELECT duration_minutes FROM competitions WHERE id=?", b2.competition.id).duration_minutes).toBe(45);
  });

  test("sessions are copied as planned — a session End Now cut before it began comes back whole — and one whose plan is lost is named, never created at 0 minutes", async () => {
    const { sa, saCsrf } = W;
    const src = await makeCompetition(sa, saCsrf, "multiend", { duration_minutes: 600 });
    const aStart = Date.now() - 30_000, bStart = Date.now() + 2 * HOUR;
    await addSession(sa, saCsrf, src.id, "Morning", aStart, 60);
    await addSession(sa, saCsrf, src.id, "Afternoon", bStart, 30);
    await endNow(sa, saCsrf, src.id);
    const s0 = sessions(src.id);
    const cut = s0.find(s => s.name === "Afternoon");
    expect(cut.duration_minutes, "PRECONDITION: End Now left the unstarted session with no length").toBe(0);

    const newStart = onTheMinute(Date.now() + 3 * DAY);
    const b = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: newStart.toISOString() });
    expect(b.sessions_copied).toBe(2);
    expect(b.skipped_sessions).toEqual([]);
    const c = sessions(b.competition.id);
    const m = c.find(s => s.name === "Morning"), a = c.find(s => s.name === "Afternoon");
    expect(m.duration_minutes, "the live session keeps its planned hour").toBe(60);
    expect(a.duration_minutes, "the cut session keeps its planned half hour").toBe(30);
    expect(Date.parse(m.start_time), "the first session opens the copy").toBe(newStart.getTime());
    expect(Date.parse(a.start_time) - Date.parse(m.start_time), "the planned spacing is kept").toBe(bStart - aStart);
    expect(dbGet("SELECT duration_minutes FROM competitions WHERE id=?", b.competition.id).duration_minutes, "the event row's plan too").toBe(600);

    // The history that holds the cut session's plan is gone (retention): the
    // session is left out and named, never created with no length.
    const tsId = dbGet("SELECT id FROM competition_timeslots WHERE competition_id=? AND name='Afternoon'", src.id).id;
    { const db = new Database(TEST_DB_PATH); try { db.prepare("DELETE FROM timeslot_events WHERE timeslot_id=?").run(tsId); } finally { db.close(); } }
    const b2 = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: newStart.toISOString() });
    expect(b2.sessions_copied).toBe(1);
    expect(b2.skipped_sessions).toEqual([{ name: "Afternoon", reason: "ended_before_start" }]);
    expect(sessions(b2.competition.id).map(s => s.name)).toEqual(["Morning"]);
    expect(dbAll("SELECT COUNT(*) n FROM competition_timeslots WHERE competition_id=? AND duration_minutes < 1", b2.competition.id)[0].n, "no session shorter than a minute").toBe(0);
    const created = JSON.parse(dbGet("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'", b2.competition.id).details);
    expect(created.skipped_sessions, "the copy's History says which session was left out").toEqual([{ name: "Afternoon", reason: "ended_before_start" }]);
  });

  test("a pinned late-entry deadline keeps its distance from the PLANNED end, also after End Now", async () => {
    const { sa, saCsrf } = W;
    // A Booth Event planned for two hours, its late entries pinned two hours
    // after that planned end.
    const start = Date.now() - 60_000;
    const pin = start + 120 * MIN + 120 * MIN;
    const src = await makeCompetition(sa, saCsrf, "latepin", {
      event_kind: "booth", start_time: new Date(start).toISOString(), duration_minutes: 120,
      late_entry_enabled: true, late_entry_deadline_at: new Date(pin).toISOString(),
    });
    const lateGap = (id) => {
      const c = dbGet("SELECT start_time, duration_minutes, late_entry_deadline_at FROM competitions WHERE id=?", id);
      return { minutes: c.duration_minutes, gap: Date.parse(c.late_entry_deadline_at) - (Date.parse(c.start_time) + c.duration_minutes * MIN) };
    };
    // CONTROL: before any End Now, the copy keeps the two-hour window.
    const before = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 3 * DAY).toISOString() });
    expect(lateGap(before.competition.id)).toEqual({ minutes: 120, gap: 120 * MIN });

    await endNow(sa, saCsrf, src.id);
    const stored = dbGet("SELECT duration_minutes, ended_manually, late_entry_deadline_at FROM competitions WHERE id=?", src.id);
    expect(stored.ended_manually, "PRECONDITION: ended by hand").toBe(1);
    expect(stored.duration_minutes, "PRECONDITION: End Now stored the time it ran").toBeLessThan(10);
    expect(Date.parse(stored.late_entry_deadline_at), "PRECONDITION: End Now left the pin where it was").toBe(pin);

    const after = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 3 * DAY).toISOString() });
    expect(lateGap(after.competition.id), "the planned length, and the planned two-hour window after it").toEqual({ minutes: 120, gap: 120 * MIN });
    expect(after.forced_settings, "the pin was carried, not dropped").not.toContain("late_entry_deadline_at");
  });

  test("a late window ended with Close late entries now is not carried: the copy follows its own end, and says so", async () => {
    const { sa, saCsrf } = W;
    // Planned for two hours and ended by time an hour ago (so its planned end IS
    // its end); late entries are closed now, an hour into the automatic window.
    const start = Date.now() - 3 * HOUR;
    const src = await makeCompetition(sa, saCsrf, "lateclose", {
      event_kind: "booth", start_time: new Date(start).toISOString(), duration_minutes: 120, late_entry_enabled: true,
    });
    const close = await sa.post(`/api/admin/competitions/${src.id}/late-entry/close`, { headers: H(saCsrf) });
    expect(close.ok(), `close: ${close.status()} ${await close.text()}`).toBeTruthy();
    const pinnedGap = Date.parse(dbGet("SELECT late_entry_deadline_at FROM competitions WHERE id=?", src.id).late_entry_deadline_at) - (start + 120 * MIN);
    expect(pinnedGap, "PRECONDITION: the close pinned the deadline about an hour after the end").toBeGreaterThan(30 * MIN);
    // The pin an editor sets is carried (the test above); the close's is not.
    const copy = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 3 * DAY).toISOString() });
    expect(dbGet("SELECT late_entry_deadline_at FROM competitions WHERE id=?", copy.competition.id).late_entry_deadline_at,
      "the copy's late entries follow its own end").toBeNull();
    expect(copy.forced_settings, "and the clone names what it left behind").toContain("late_entry_closed");
    // A copy of another type takes no late entries, so nothing is said about their time.
    const other = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 3 * DAY).toISOString(), event_kind: "tournament" });
    expect(other.forced_settings || [], "a Competition copy is not told about a late-entry time it does not have").not.toContain("late_entry_closed");
  });

  test("session offsets are measured from the first session, not the event row's stale start, so a copy is never born started", async () => {
    const { sa, saCsrf } = W;
    // The event row says day 10; its sessions run on day 8 (a session's own
    // start is its route's to move, and nothing resyncs the event row).
    const src = await makeCompetition(sa, saCsrf, "stale", { start_time: onTheMinute(Date.now() + 10 * DAY).toISOString(), duration_minutes: 600 });
    const s1 = onTheMinute(Date.now() + 8 * DAY).getTime();
    await addSession(sa, saCsrf, src.id, "First", s1, 60);
    await addSession(sa, saCsrf, src.id, "Second", s1 + 3 * HOUR, 60);
    const newStart = onTheMinute(Date.now() + 2 * DAY);
    const b = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: newStart.toISOString() });
    expect(b.competition.status, "the copy is upcoming").toBe("upcoming");
    const c = sessions(b.competition.id);
    expect(c.map(s => Date.parse(s.start_time)), "the first session opens at the new start, the second 3 h after").toEqual([newStart.getTime(), newStart.getTime() + 3 * HOUR]);
    expect(Math.min(...c.map(s => Date.parse(s.start_time))), "no session starts before the copy").toBeGreaterThan(Date.now());
  });
});

test.describe("Qualifying questions are per-event copies", () => {
  test("a clone gets its own copies, never the source's rows; another event's own question of a custom key is named", async () => {
    const { sa, saCsrf } = W;
    const src = await makeCompetition(sa, saCsrf, "qsrc", { event_kind: "booth", duration_minutes: 120 });
    const srcQ = qualifyingIds(src.id);
    expect(srcQ.length, "PRECONDITION: a Booth Event got the four built-in questions").toBe(4);
    const plain = await makeTask(sa, saCsrf, "q-plain");
    await assignTask(sa, saCsrf, plain.id, [src.id]);
    const own = await makeTask(sa, saCsrf, "q-own", PICK_ONE);
    const tg = await sa.post(`/api/admin/tasks/${own.id}/tags`, { headers: H(saCsrf), data: { tag: "qualifying:budget" } });
    expect(tg.ok(), await tg.text()).toBeTruthy();
    await assignTask(sa, saCsrf, own.id, [src.id]);

    const b = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 2 * DAY).toISOString() });
    const copyQ = qualifyingIds(b.competition.id);
    expect(copyQ.length, "the copy has four qualifying questions of its own").toBe(4);
    expect(copyQ.filter(id => srcQ.includes(id)), "none shared with the source").toEqual([]);
    expect(b.qualifying_questions).toBe(4);
    expect(dbGet("SELECT 1 x FROM competition_tasks WHERE competition_id=? AND task_id=?", b.competition.id, plain.id), "CONTROL: an ordinary challenge is copied").toBeTruthy();
    expect(b.skipped_challenges, "the replaced built-ins are not reported; the custom one is").toEqual([{ task_id: own.id, title: own.title, reason: "qualifying" }]);
  });

  test("a clone of an event holding only a question its organiser wrote gets no built-in ones, and its own is named", async () => {
    const { sa, saCsrf } = W;
    // A Competition (no built-in questions by default) holding one question an
    // organiser wrote and one ordinary challenge.
    const src = await makeCompetition(sa, saCsrf, "qcustom", { event_kind: "tournament", duration_minutes: 120 });
    const plain = await makeTask(sa, saCsrf, "qc-plain");
    await assignTask(sa, saCsrf, plain.id, [src.id]);
    const own = await makeTask(sa, saCsrf, "qc-own", PICK_ONE);
    const tg = await sa.post(`/api/admin/tasks/${own.id}/tags`, { headers: H(saCsrf), data: { tag: "qualifying:budget" } });
    expect(tg.ok(), await tg.text()).toBeTruthy();
    await assignTask(sa, saCsrf, own.id, [src.id]);
    expect(qualifyingIds(src.id), "PRECONDITION: its only qualifying question is the organiser's own").toEqual([own.id]);

    const b = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 2 * DAY).toISOString() });
    expect(qualifyingIds(b.competition.id), "no built-in questions the source never had").toEqual([]);
    expect(b.qualifying_questions).toBe(0);
    expect(b.skipped_challenges, "the organiser's own question is named as left out").toEqual([{ task_id: own.id, title: own.title, reason: "qualifying" }]);
    expect(dbGet("SELECT 1 x FROM competition_tasks WHERE competition_id=? AND task_id=?", b.competition.id, plain.id), "CONTROL: the ordinary challenge is copied").toBeTruthy();
  });

  test("a clone of an event holding ONE built-in question, reworded, gets every built-in one, fresh and in its default wording", async () => {
    const { sa, saCsrf } = W;
    const { DEFAULT_QUALIFYING } = require("../lib/qualifying");
    const keyOf = (taskId) => dbGet("SELECT tag FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%'", taskId).tag.slice("qualifying:".length);
    const src = await makeCompetition(sa, saCsrf, "qone", { event_kind: "booth", duration_minutes: 120 });
    const srcQ = qualifyingIds(src.id);
    expect(srcQ.length, "PRECONDITION: a Booth Event got every built-in question").toBe(DEFAULT_QUALIFYING.length);
    // Keep one, reworded; take the others out of the event.
    const [keep, ...drop] = srcQ;
    for (const t of drop) {
      const r = await sa.delete(`/api/admin/tasks/${t}/competitions/${src.id}`, { headers: H(saCsrf) });
      expect(r.ok(), `unassign: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const reworded = `Reworded ${uniq("q")}`;
    const ed = await sa.put(`/api/admin/tasks/${keep}`, { headers: H(saCsrf), data: { title: reworded } });
    expect(ed.ok(), `reword: ${ed.status()} ${await ed.text()}`).toBeTruthy();
    expect(qualifyingIds(src.id), "PRECONDITION: the source holds one built-in question").toEqual([keep]);
    expect(dbGet("SELECT title FROM tasks WHERE id=?", keep).title, "PRECONDITION: it is reworded").toBe(reworded);
    const keptKey = keyOf(keep);

    const b = await clone(sa, saCsrf, src.id, { name: `Copy ${uniq("c")}`, start_time: onTheMinute(Date.now() + 2 * DAY).toISOString() });
    const copyQ = qualifyingIds(b.competition.id);
    expect(copyQ.map(keyOf).sort(), "every built-in key, not only the one the source held").toEqual(DEFAULT_QUALIFYING.map(q => q.key).sort());
    expect(b.qualifying_questions).toBe(DEFAULT_QUALIFYING.length);
    expect(copyQ, "none of them the source's own row").not.toContain(keep);
    const copyTitle = dbGet(
      "SELECT t.title FROM tasks t JOIN task_tags g ON g.task_id=t.id JOIN competition_tasks ct ON ct.task_id=t.id WHERE ct.competition_id=? AND g.tag=?",
      b.competition.id, `qualifying:${keptKey}`).title;
    expect(copyTitle, "the rewording is not carried: the default wording").toBe(DEFAULT_QUALIFYING.find(q => q.key === keptKey).title);
    expect(b.skipped_challenges, "a built-in key the copy got fresh is not reported as left out").toEqual([]);
  });

  test("a template never holds one: save-as-template leaves them out by name, a save refuses one, a spawn never shares an older template's", async () => {
    const { sa, saCsrf } = W;
    const src = await makeCompetition(sa, saCsrf, "qtpl", { event_kind: "booth", duration_minutes: 90 });
    const srcQ = qualifyingIds(src.id);
    expect(srcQ.length, "PRECONDITION: the four built-in questions").toBe(4);
    const plain = await makeTask(sa, saCsrf, "qtpl-plain");
    await assignTask(sa, saCsrf, plain.id, [src.id]);

    const s = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name: `QTpl ${uniq("t")}` } });
    expect(s.status(), await s.text()).toBe(200);
    const sb = await s.json();
    expect(sb.template.task_ids, "only the ordinary challenge").toEqual([plain.id]);
    expect(sb.skipped_challenges.map(x => x.reason).sort(), "the four are named as left out").toEqual(["qualifying", "qualifying", "qualifying", "qualifying"]);

    const bad = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name: `QBad ${uniq("t")}`, event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [plain.id, srcQ[0]] } });
    expect(bad.status(), await bad.text()).toBe(400);
    expect((await bad.json()).code).toBe("template_task_qualifying");

    // An older template that holds one (saved before this rule): planted.
    const tplId = sb.template.id;
    { const db = new Database(TEST_DB_PATH); try { db.prepare("UPDATE event_templates SET task_ids=? WHERE id=?").run(JSON.stringify([plain.id, srcQ[0]]), tplId); } finally { db.close(); } }
    const sp1 = await sa.post(`/api/admin/event-templates/${tplId}/spawn`, { headers: H(saCsrf), data: { name: `QSpawn ${uniq("s")}`, add_qualifying: true } });
    expect(sp1.status(), await sp1.text()).toBe(200);
    const b1 = await sp1.json();
    const q1 = qualifyingIds(b1.competition.id);
    expect(q1.length, "four fresh questions, not five").toBe(4);
    expect(q1, "the older template's row is not shared").not.toContain(srcQ[0]);
    expect(b1.skipped_challenges, "a built-in key the spawn replaced is not reported").toEqual([]);
    const sp2 = await sa.post(`/api/admin/event-templates/${tplId}/spawn`, { headers: H(saCsrf), data: { name: `QSpawn ${uniq("s")}`, add_qualifying: false } });
    expect(sp2.status(), await sp2.text()).toBe(200);
    const b2 = await sp2.json();
    expect(qualifyingIds(b2.competition.id), "nothing shared without the tick").toEqual([]);
    expect(b2.skipped_challenges.map(x => [x.task_id, x.reason]), "and the left-out row is named").toEqual([[srcQ[0], "qualifying"]]);
    expect(dbGet("SELECT 1 x FROM competition_tasks WHERE competition_id=? AND task_id=?", b2.competition.id, plain.id), "CONTROL: the ordinary challenge comes with it").toBeTruthy();
  });
});

test.describe("A spawn counts, never names, a challenge the event admin may not view", () => {
  test("no id, no title and no draft state reach the event admin; the superadmin control is told all three", async () => {
    const { sa, saCsrf, eaApi, eaCsrf } = W;
    const hidden = await makeTask(sa, saCsrf, "spawn-hidden");
    const c = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name: `Hid ${uniq("t")}`, event_kind: "tournament", settings: { duration_minutes: 30 }, task_ids: [hidden.id] } });
    expect(c.status(), await c.text()).toBe(200);
    const tpl = (await c.json()).template;
    // The challenge is a DRAFT by the time of the spawn: its state is not the
    // event admin's to learn either.
    { const db = new Database(TEST_DB_PATH); try { db.prepare("UPDATE tasks SET status='draft' WHERE id=?").run(hidden.id); } finally { db.close(); } }
    const sp = await eaApi.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(eaCsrf), data: { name: `EA ${uniq("s")}` } });
    expect(sp.status(), await sp.text()).toBe(200);
    const b = await sp.json();
    expect(b.skipped_challenges, "counted, never named").toEqual([{ reason: "not_visible" }]);
    const text = JSON.stringify(b);
    expect(text, "the id appears nowhere").not.toContain(hidden.id);
    expect(text, "nor the title").not.toContain(hidden.title);
    // CONTROL: the superadmin, who may view it, is told what it is and why.
    const sp2 = await sa.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(saCsrf), data: { name: `SA ${uniq("s")}` } });
    expect(sp2.status(), await sp2.text()).toBe(200);
    expect((await sp2.json()).skipped_challenges).toEqual([{ task_id: hidden.id, title: hidden.title, reason: "not_published" }]);
  });
});
