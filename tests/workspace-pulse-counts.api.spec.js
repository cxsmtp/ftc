// What the event workspace's Overview pulse (GET …/overview-pulse) counts, by
// value, against the platform's own definitions:
//  (1) a QUALIFYING question never counts toward a solve or finishing: it is out
//      of `visible_tasks` and `finished` (both sides), out of `solvers`, out of
//      the feed's solves, and each task row says `qualifying`; its answers still
//      count as answers (the accepted disposition);
//  (2) `finished` and `solvers` count the event's current MEMBERS, the
//      population `joined` counts: removing a finisher takes them out of both;
//  (3) `active_now` (the KPI "Playing now — answered in the last 5 minutes")
//      counts people who ANSWERED: leaving a challenge is not playing;
//  (4) the chart's window runs to the late-entry deadline while late entrants
//      play, so its buckets hold every answer the totals count;
//  (5) where staff compete, the staff enrolled count (never a staff spectator,
//      nor the same staff member where staff do not compete);
//  (6) where staff do NOT compete, the roles the boards leave out (the event
//      admin, and any custom role of its class) are out of every figure, person
//      for person as on the event's admin board; where staff compete they count.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin, eventCopyOf, originOf } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `pulse-key-${stamp}`;
let sa, saCsrf;
const made = { comps: [], people: [], roles: [] };

async function mk(name, data) {
  const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `${name} ${stamp}`, ...data } });
  expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  const c = { id: d.competition?.id || d.id, name: `${name} ${stamp}` };
  made.comps.push(c);
  return c;
}

async function person(label) {
  const p = await makeParticipant(sa, saCsrf, label);
  made.people.push(p);
  return p;
}

// One signed-in participant session, in the event.
async function enter(p, compId) {
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
  return s;
}
async function submit(s, taskId, answer) {
  const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf), data: { answer, gradingHash: await gradingHashFor(s.api, taskId) } });
  expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

// The event's qualifying questions and their options, read from the server's own
// database (read-only): no admin read returns a challenge's option ids by tag.
function qualifyingOf(compId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(
      `SELECT t.id, t.choices FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
        WHERE ct.competition_id=? AND EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id=t.id AND g.tag LIKE 'qualifying:%')`
    ).all(compId).map(r => ({ id: r.id, options: JSON.parse(r.choices) }));
  } finally { db.close(); }
}

const pulse = async (compId) => {
  const r = await sa.get(`/api/admin/competitions/${compId}/overview-pulse`);
  expect(r.ok(), `pulse: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
};

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
});

test.afterAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  for (const c of made.comps) await api.delete(`/api/admin/competitions/${c.id}`, { headers: H(csrf) }).catch(() => {});
  for (const p of made.people) await api.delete(`/api/admin/participants/${p.id}`, { headers: H(csrf) }).catch(() => {});
  // A custom role is deletable once nobody holds it, so after the people.
  for (const r of made.roles) await api.delete(`/api/admin/roles/${r}`, { headers: H(csrf) }).catch(() => {});
  await api.dispose();
});

test("qualifying questions and removed members never count toward solving or finishing; Playing now is answers only", async () => {
  test.setTimeout(120_000);
  // A live Booth Event: it seeds the four qualifying questions and never
  // auto-ends on all-solved (fixture item 1), so the finisher keeps it live.
  const ev = await mk("PulseBooth", { event_kind: "booth", start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 120, add_qualifying: true });
  // The event's own copies (lib/event-copies.js): what is played and what the pulse lists.
  const own = async (t) => ({ ...t, id: (await assignTask(sa, saCsrf, t.id, [ev.id])).copies[0].task_id });
  const t1 = await own(await makeTask(sa, saCsrf, "pc1", { correct_answer: KEY }));
  const t2 = await own(await makeTask(sa, saCsrf, "pc2", { correct_answer: KEY }));
  const q = qualifyingOf(ev.id);
  expect(q.length, "PRECONDITION: the Booth Event holds its qualifying questions").toBeGreaterThan(0);
  const fin = await person("pcfin");
  const marketer = await person("pcq");
  const leaver = await person("pclv");
  const half = await person("pchalf");
  await enrol(sa, saCsrf, ev.id, [fin.id, marketer.id, leaver.id, half.id]);

  // The finisher solves both scoring challenges and no qualifying question.
  const sf = await enter(fin, ev.id);
  try {
    expect((await submit(sf, t1.id, KEY)).correct).toBe(true);
    expect((await submit(sf, t2.id, KEY)).correct).toBe(true);
  } finally { await sf.api.dispose(); }
  // The marketer answers ONE qualifying question and nothing else.
  const sm = await enter(marketer, ev.id);
  try {
    const r = await submit(sm, q[0].id, JSON.stringify([q[0].options[0].id]));
    expect(r.correct, "PRECONDITION: a pick-one answer is accepted").toBe(true);
  } finally { await sm.api.dispose(); }
  // Half way: one scoring challenge and one question — two "solves", not finished.
  const sh = await enter(half, ev.id);
  try {
    expect((await submit(sh, t1.id, KEY)).correct).toBe(true);
    expect((await submit(sh, q[1].id, JSON.stringify([q[1].options[0].id]))).correct).toBe(true);
  } finally { await sh.api.dispose(); }
  // The leaver opens a challenge and leaves it without answering.
  const sl = await enter(leaver, ev.id);
  try {
    expect((await sl.api.get(`/api/tasks/${t1.id}`)).ok()).toBeTruthy();
    const nav = await sl.api.post(`/api/tasks/${t1.id}/navigated-away`, { headers: H(sl.csrf), data: { via: "spa_nav" } });
    expect(nav.ok(), `navigated-away: ${await nav.text()}`).toBeTruthy();
  } finally { await sl.api.dispose(); }

  // challenge_events are written post-commit: wait for all four rows.
  await expect.poll(async () => (await pulse(ev.id)).totals.answers, { timeout: 15000, message: "five answers reach the pulse" }).toBe(5);
  let d;
  await expect.poll(async () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT COUNT(*) AS n FROM challenge_events WHERE competition_id=? AND event_type='navigated_away'").get(ev.id).n; }
    finally { db.close(); }
  }, { timeout: 15000, message: "PRECONDITION: the leave is recorded" }).toBe(1);
  d = await pulse(ev.id);

  // (1) The qualifying questions: flagged per row, out of the finishing counts.
  const qualRows = d.tasks.filter(t => t.qualifying === true);
  expect(qualRows.map(t => t.id).sort(), "every qualifying row is flagged").toEqual(q.map(x => x.id).sort());
  expect(d.tasks.filter(t => t.qualifying === false).map(t => t.id).sort(), "the scoring rows are not").toEqual([t1.id, t2.id].sort());
  expect(d.totals.visible_tasks, "two scoring challenges are what finishing means").toBe(2);
  expect(d.totals.finished, "solving both scoring challenges is finishing (the questions are not owed); one scoring solve and one question is not").toBe(1);
  expect(d.totals.solvers, "a qualifying answer is not a solve: the finisher and the half-way one have solved").toBe(2);
  expect(d.totals.answers, "CONTROL: the qualifying answers still count as answers").toBe(5);
  const feedSolves = d.recent.filter(r => r.type === "solved");
  expect(feedSolves.map(r => r.nickname).sort(), "the feed's solves are the scoring ones").toEqual([fin.nickname, fin.nickname, half.nickname].sort());
  expect(feedSolves.some(r => r.nickname === marketer.nickname), "never a marketing answer as a solve").toBe(false);
  // (3) Playing now: the three who answered, never the one who left.
  expect(d.totals.active_now, "answered in the last five minutes: the finisher, the marketer, the half-way one").toBe(3);

  // CONTROL for (3): once the leaver answers, they are playing.
  const sl2 = await enter(leaver, ev.id);
  try { expect((await submit(sl2, t2.id, `wrong-${stamp}`)).correct).toBe(false); } finally { await sl2.api.dispose(); }
  await expect.poll(async () => (await pulse(ev.id)).totals.active_now, { timeout: 15000, message: "an answer makes the leaver a player" }).toBe(4);

  // (2) Removing the finisher takes them out of finished and solvers, as it
  // takes them out of joined.
  const rm = await sa.delete(`/api/admin/competitions/${ev.id}/users/${fin.id}`, { headers: H(saCsrf) });
  expect(rm.ok(), `remove: ${rm.status()} ${await rm.text()}`).toBeTruthy();
  expect((await rm.json()).removed, "PRECONDITION: the row was removed").not.toBe(false);
  d = await pulse(ev.id);
  expect(d.totals.joined, "PRECONDITION: three members left").toBe(3);
  expect(d.totals.finished, "a removed finisher is no longer counted finished").toBe(0);
  expect(d.totals.solvers, "nor as having solved one: only the half-way one has (the leaver's answer was wrong)").toBe(1);
  expect(d.totals.answers, "CONTROL: their answers still happened").toBe(6);
});

test("the chart's window runs through the late-entry window, so a late entrant's answer is in it", async () => {
  test.setTimeout(120_000);
  const ev = await mk("PulseLate", { event_kind: "booth", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 120, late_entry_enabled: true, add_qualifying: false });
  const t1 = await makeTask(sa, saCsrf, "pl1", { correct_answer: KEY });
  const t2 = await makeTask(sa, saCsrf, "pl2", { correct_answer: KEY });
  for (const t of [t1, t2]) await assignTask(sa, saCsrf, t.id, [ev.id]);
  const early = await person("plearly");
  await enrol(sa, saCsrf, ev.id, [early.id]);
  const se = await enter(early, ev.id);
  try { expect((await submit(se, t1.id, KEY)).correct).toBe(true); } finally { await se.api.dispose(); }
  const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.ok(), `End now: ${await end.text()}`).toBeTruthy();
  const late = await person("pllate");
  const effEnd = Date.parse((await (await sa.get("/api/admin/competitions")).json()).find(x => x.id === ev.id).effective_end);
  // CONTROL: nothing has happened since the end, so the window ends there — not
  // at the late-entry deadline, and not at "now" (read well after the end).
  await expect.poll(() => Date.now() - effEnd, { timeout: 5000, message: "PRECONDITION: read well after the end" }).toBeGreaterThan(1500);
  const d0 = await pulse(ev.id);
  expect(Math.abs(Date.parse(d0.window.to) - effEnd), `the window ends at the effective end: ${d0.window.to}`).toBeLessThanOrEqual(1000);
  // A late entrant joins the ended event's open window and answers in it.
  await enrol(sa, saCsrf, ev.id, [late.id]);
  const sl = await enter(late, ev.id);
  try { expect((await submit(sl, t1.id, KEY)).correct, "PRECONDITION: a late entrant plays in the window").toBe(true); } finally { await sl.api.dispose(); }
  await expect.poll(async () => (await pulse(ev.id)).totals.answers, { timeout: 15000, message: "both answers reach the pulse" }).toBe(2);
  const d = await pulse(ev.id);
  const endRow = await (await sa.get("/api/admin/competitions")).json();
  const c = endRow.find(x => x.id === ev.id);
  expect(c && c.effective_end, "PRECONDITION: the event has an effective end").toBeTruthy();
  expect(Date.parse(d.window.to), "the window runs past the effective end, into the late window").toBeGreaterThan(Date.parse(c.effective_end));
  expect(d.buckets.reduce((n, b) => n + b.answers, 0), "every answer the totals count is in the chart").toBe(d.totals.answers);
  expect(d.buckets.reduce((n, b) => n + b.joins, 0), "and the late join").toBe(2);
});

// (5) Operator ruling, 14 Nov 2026: on an event where staff COMPETE, the staff
// enrolled in it count in the live figures, as its boards, certificates and
// exports count them. Two controls, each a person or event the lifted filter
// must still leave out: a staff SPECTATOR (staff-tagged, no row on the event,
// playing it anyway), and the SAME staff member on a twin whose switch is off
// (where staff are spectators: their row there can only be planted, as a
// pre-release database holds it). An ordinary participant answers wrong on both,
// which keeps both live (fixture item 1) and counts everywhere (the CONTROL that
// the filter lets ordinary people through).
test("where staff compete, the staff taking part count; a staff spectator, and the same staff member where staff do not compete, never do", async () => {
  test.setTimeout(120_000);
  const makeAdmin = async (label) => {
    const p = await person(label);
    const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return p;
  };
  const tagStaff = async (p) => {
    const r = await sa.post(`/api/admin/participants/${p.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
    expect(r.ok(), `tag staff: ${r.status()} ${await r.text()}`).toBeTruthy();
  };
  // A staff-compete event holds sealed challenges only, and sealing needs an
  // author with a users row: a promoted admin enrolled nowhere writes it.
  const author = await makeAdmin("pcauthor");
  const au = await apiLogin(author.email, PARTICIPANT_PASS);
  let task;
  try { task = await makeTask(au.api, au.csrf, "pcsealed", { correct_answer: KEY, answer_sealed: true }); }
  finally { await au.api.dispose(); }
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const on = await mk("PulseStaffOn", { event_kind: "tournament", start_time: past, duration_minutes: 120, staff_compete: true });
  const off = await mk("PulseStaffOff", { event_kind: "tournament", start_time: past, duration_minutes: 120 });
  await assignTask(sa, saCsrf, task.id, [on.id, off.id]);
  const staffer = await person("pcstaff");
  const spectator = await person("pcspec");
  const plain = await person("pcplain");
  for (const p of [staffer, spectator]) await tagStaff(p);
  await enrol(sa, saCsrf, on.id, [staffer.id, plain.id]);
  await enrol(sa, saCsrf, off.id, [plain.id]);
  {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,1)")
        .run(off.id, staffer.id, "superadmin", new Date().toISOString());
      expect(db.prepare("SELECT user_id FROM competition_users WHERE competition_id=? ORDER BY user_id").all(on.id).map(r => r.user_id), "PRECONDITION: the compete event holds the staff member and the participant, never the spectator")
        .toEqual([staffer.id, plain.id].sort());
    } finally { db.close(); }
  }

  const play = async (p, compId, answer) => {
    const s = await enter(p, compId);
    try { return (await submit(s, task.id, answer)).correct; } finally { await s.api.dispose(); }
  };
  expect(await play(staffer, on.id, KEY), "PRECONDITION: the staff member solves where staff compete").toBe(true);
  expect(await play(spectator, on.id, KEY), "PRECONDITION: the spectator plays it too, with no row").toBe(true);
  expect(await play(plain, on.id, `wrong-${stamp}`)).toBe(false);
  expect(await play(staffer, off.id, KEY), "PRECONDITION: the staff member solves the twin too").toBe(true);
  expect(await play(plain, off.id, `wrong-${stamp}`)).toBe(false);
  // challenge_events are written post-commit: wait until every answer is on record.
  await expect.poll(() => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT COUNT(*) AS n FROM challenge_events WHERE competition_id IN (?,?) AND event_type IN ('solved','incorrect')").get(on.id, off.id).n; }
    finally { db.close(); }
  }, { timeout: 15000, message: "PRECONDITION: all five answers are recorded" }).toBe(5);

  // The compete event: the staff member counts, the spectator does not.
  const a = await pulse(on.id);
  expect(a.totals, "the staff member is a participant here; the spectator is nobody's figure").toMatchObject({
    joined: 2, answers: 2, correct: 1, solvers: 1, active_now: 2, finished: 1, visible_tasks: 1,
  });
  const ta = a.tasks.find(t => t.id === eventCopyOf(task.id, on.id));   // the compete event's own copy
  expect({ attempters: ta.attempters, solvers: ta.solvers, answerers: ta.answerers, answers: ta.answers }, "the challenge's own facts").toEqual({ attempters: 2, solvers: 1, answerers: 2, answers: 2 });
  expect(a.buckets.reduce((n, b) => n + b.answers, 0), "the chart holds the same answers").toBe(2);
  expect(a.buckets.reduce((n, b) => n + b.joins, 0), "and both joins").toBe(2);
  const feedA = a.recent.map(r => `${r.type}:${r.nickname}`).sort();
  expect(feedA, "the feed: both joins, the staff member's solve, never the spectator's").toEqual([`joined:${plain.nickname}`, `joined:${staffer.nickname}`, `solved:${staffer.nickname}`].sort());

  // The twin: staff do not compete there, so the same staff member is out of
  // every figure (the ordinary participant is the control that it still counts).
  const b = await pulse(off.id);
  expect(b.totals, "where staff do not compete, staff stay out").toMatchObject({
    joined: 1, answers: 1, correct: 0, solvers: 0, active_now: 1, finished: 0, visible_tasks: 1,
  });
  expect(b.recent.some(r => r.nickname === staffer.nickname), "never in the twin's feed").toBe(false);
  expect(b.recent.some(r => r.nickname === plain.nickname), "CONTROL: the participant is").toBe(true);
});

// (6) Operator ruling, 14 Nov 2026: where staff do NOT compete, the Overview also
// leaves out the accounts whose ROLE the boards leave out (the built-in event
// admin and any custom role of its class, `granted`, by the boards' own list), so
// an organiser enrolled in such an event and playing it is in none of its live
// figures, as they are on none of its boards. Where staff compete, the same
// people count, as they do on that event's board.
//
// "Matching the boards" is asserted as such: each event's ADMIN BOARD is read,
// and the pulse must hold exactly the people the board holds. That also settles
// the global admin's case by value: every global role carries the `staff` tag,
// so the board leaves a global admin out where staff do not compete (their row
// there can only be planted: the assign door skips staff) and lists them where
// they do. The ordinary participant is the control that the filter still lets
// people through, on both events; they solve one of the two challenges, so
// nobody counted finishes and both events stay live (fixture item 1) while
// `solvers` has somebody to count.
test("where staff do not compete, event admins and custom roles of their class are out of every live figure, as off the board; where staff compete they count, person for person as on the board", async () => {
  test.setTimeout(180_000);
  const withDb = (fn, opts = { readonly: true }) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, opts);
    try { return fn(db); } finally { db.close(); }
  };
  const roleOf = (id) => withDb(db => db.prepare("SELECT role FROM users WHERE id=?").get(id).role);
  const tagsOf = (id) => withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(id).map(r => r.tag));
  const promote = async (p, role) => {
    const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
    expect(r.ok(), `promote to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  };

  // Two sealed challenges (a staff-compete event holds sealed ones only), by a
  // promoted admin who is enrolled nowhere.
  const author = await person("prauthor");
  await promote(author, "admin");
  const au = await apiLogin(author.email, PARTICIPANT_PASS);
  let t1, t2;
  try {
    t1 = await makeTask(au.api, au.csrf, "prt1", { correct_answer: KEY, answer_sealed: true });
    t2 = await makeTask(au.api, au.csrf, "prt2", { correct_answer: KEY, answer_sealed: true });
  } finally { await au.api.dispose(); }
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const anchor = await mk("PulseRoleAnchor", { event_kind: "tournament", start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 });
  const off = await mk("PulseRoleOff", { event_kind: "tournament", start_time: past, duration_minutes: 120 });
  const on = await mk("PulseRoleOn", { event_kind: "tournament", start_time: past, duration_minutes: 120, staff_compete: true });
  for (const t of [t1, t2]) await assignTask(sa, saCsrf, t.id, [off.id, on.id]);

  // The people. P: an ordinary participant. EA: the built-in event admin
  // (organising the anchor, never these two). CR: a custom role of the event
  // admin's class. GA: a global admin.
  const P = await person("prplain");
  const EA = await person("prea");
  await grantEventAdmin(sa, saCsrf, anchor.id, EA.id);
  const CR = await person("prcr");
  const mkRole = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `Pulse organiser ${stamp}`, scope_mode: "granted", permissions: ["events.view"] } });
  expect(mkRole.ok(), `create the custom role: ${mkRole.status()} ${await mkRole.text()}`).toBeTruthy();
  const customRole = (await mkRole.json()).role;
  made.roles.push(customRole.id);
  const give = await sa.patch(`/api/admin/users/${CR.id}/role`, { headers: H(saCsrf), data: { role: customRole.id } });
  expect(give.ok(), `give the custom role: ${give.status()} ${await give.text()}`).toBeTruthy();
  const GA = await person("prga");
  await promote(GA, "admin");
  // PRECONDITIONS: what each person is to the rule, asserted rather than assumed.
  expect(roleOf(EA.id), "EA holds the built-in event-admin role").toBe("event_admin");
  expect(roleOf(CR.id), "CR holds the custom role").toBe(customRole.id);
  expect(withDb(db => db.prepare("SELECT scope_mode FROM roles WHERE id=?").get(customRole.id).scope_mode), "…a role of the event admin's class").toBe("granted");
  expect(roleOf(GA.id), "GA holds a global role").toBe("admin");
  expect(tagsOf(EA.id), "the event admin is not tagged staff: only the ROLE can leave them out").not.toContain("staff");
  expect(tagsOf(CR.id), "nor is the custom role's holder").not.toContain("staff");
  expect(tagsOf(GA.id), "a global admin carries the staff tag").toContain("staff");

  // Enrolment. Where staff do not compete, the assign door admits the two
  // untagged organisers and skips the global admin (staff), so GA's row there is
  // planted, as a pre-release database holds it.
  await enrol(sa, saCsrf, off.id, [P.id, EA.id, CR.id]);
  const skip = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [GA.id], competitionIds: [off.id] } });
  expect(skip.ok(), `assign GA where staff do not compete: ${skip.status()} ${await skip.text()}`).toBeTruthy();
  const skipped = await skip.json();
  expect([skipped.assigned, skipped.skippedStaff], "PRECONDITION: the assign door skips a staff account there").toEqual([0, 1]);
  withDb(db => db.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,1)")
    .run(off.id, GA.id, "superadmin", new Date().toISOString()), { readonly: false });
  await enrol(sa, saCsrf, on.id, [P.id, EA.id, CR.id, GA.id]);
  const members = (compId) => withDb(db => db.prepare("SELECT user_id FROM competition_users WHERE competition_id=?").all(compId).map(r => r.user_id).sort());
  const everyone = [P.id, EA.id, CR.id, GA.id].sort();
  expect(members(off.id), "PRECONDITION: all four hold a row where staff do not compete").toEqual(everyone);
  expect(members(on.id), "…and where they do").toEqual(everyone);

  // Play. An admin tier competes from participant view, as the app has them do.
  const play = async (p, adminTier, plan) => {
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      if (adminTier) {
        const tg = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "participant" } });
        expect(tg.ok(), `participant view: ${tg.status()} ${await tg.text()}`).toBeTruthy();
        s.csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
      }
      for (const [compId, tasks] of plan) {
        const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
        expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
        for (const t of tasks) expect((await submit(s, t.id, KEY)).correct, `PRECONDITION: ${p.nickname} solves ${t.title}`).toBe(true);
      }
    } finally { await s.api.dispose(); }
  };
  await play(P, false, [[off.id, [t1]], [on.id, [t1]]]);
  for (const p of [EA, CR, GA]) await play(p, true, [[off.id, [t1, t2]], [on.id, [t1, t2]]]);
  // challenge_events are written post-commit: wait until every solve is on record.
  await expect.poll(() => withDb(db => db.prepare("SELECT COUNT(*) AS n FROM challenge_events WHERE competition_id IN (?,?) AND event_type='solved' AND impersonated=0").get(off.id, on.id).n),
    { timeout: 15000, message: "PRECONDITION: all fourteen solves are recorded" }).toBe(14);

  // THE BOARDS, read by value: who each one holds is what the pulse must match.
  const board = async (compId) => {
    const r = await sa.get(`/api/admin/leaderboard?competitionId=${compId}`);
    expect(r.ok(), `admin board: ${r.status()} ${await r.text()}`).toBeTruthy();
    const rows = await r.json();
    expect(Array.isArray(rows), "the admin board is a bare array").toBe(true);
    return new Set(rows.map(e => e.userId));
  };
  const four = [P, EA, CR, GA];
  await expect.poll(async () => { const bd = await board(on.id); return four.map(p => bd.has(p.id)); },
    { timeout: 10000, message: "where staff compete, the board lists all four" }).toEqual([true, true, true, true]);
  const offBoard = await board(off.id), onBoard = await board(on.id);
  expect(four.map(p => offBoard.has(p.id)), "where staff do not compete, the board lists the participant only (the global admin by the staff tag, the other two by role)").toEqual([true, false, false, false]);

  const facts = (d, t) => {
    // Each event lists its OWN copy of the question (lib/event-copies.js): found by its origin.
    const x = d.tasks.find(r => originOf(r.id) === t.id);
    expect(x, `the pulse has a row for ${t.title}`).toBeTruthy();
    return { attempters: x.attempters, solvers: x.solvers, answerers: x.answerers, answers: x.answers };
  };
  const feed = (d) => d.recent.map(r => `${r.type}:${r.nickname}`).sort();

  // Where staff do not compete: only the participant, in every figure.
  const a = await pulse(off.id);
  expect(a.totals, "where staff do not compete, the organisers are in no total; enrolled is all four rows").toMatchObject({
    joined: 1, enrolled: 4, answers: 1, correct: 1, solvers: 1, active_now: 1, finished: 0, visible_tasks: 2,
  });
  expect(facts(a, t1), "the first challenge's facts are the participant's answer alone").toEqual({ attempters: 1, solvers: 1, answerers: 1, answers: 1 });
  expect(facts(a, t2), "the second, which only the organisers answered, has nobody").toEqual({ attempters: 0, solvers: 0, answerers: 0, answers: 0 });
  expect(a.buckets.reduce((n, b) => n + b.answers, 0), "the chart holds the participant's answer only").toBe(1);
  expect(a.buckets.reduce((n, b) => n + b.joins, 0), "…and their join only").toBe(1);
  expect(feed(a), "the feed: the participant's join and solve, nobody else's").toEqual([`joined:${P.nickname}`, `solved:${P.nickname}`].sort());
  const rawA = JSON.stringify(a);
  for (const [who, p] of [["event admin", EA], ["custom role's holder", CR], ["global admin", GA]]) {
    expect(rawA.includes(p.nickname), `the ${who} appears nowhere in the pulse where staff do not compete`).toBe(false);
  }

  // Where staff compete: the same four, each counted.
  const b = await pulse(on.id);
  expect(b.totals, "where staff compete, the organisers count like the participant").toMatchObject({
    joined: 4, enrolled: 4, answers: 7, correct: 7, solvers: 4, active_now: 4, finished: 3, visible_tasks: 2,
  });
  expect(facts(b, t1), "the first challenge: all four solved it").toEqual({ attempters: 4, solvers: 4, answerers: 4, answers: 4 });
  expect(facts(b, t2), "the second: the three organisers").toEqual({ attempters: 3, solvers: 3, answerers: 3, answers: 3 });
  expect(b.buckets.reduce((n, x) => n + x.answers, 0), "the chart holds all seven answers").toBe(7);
  expect(b.buckets.reduce((n, x) => n + x.joins, 0), "…and all four joins").toBe(4);
  expect(feed(b), "the feed: four joins and every solve").toEqual([
    ...four.map(p => `joined:${p.nickname}`), `solved:${P.nickname}`,
    ...[EA, CR, GA].flatMap(p => [`solved:${p.nickname}`, `solved:${p.nickname}`]),
  ].sort());

  // Person for person, the pulse holds exactly who the board holds.
  for (const [where, d, bd] of [["where staff do not compete", a, offBoard], ["where staff compete", b, onBoard]]) {
    const joinedNames = new Set(d.recent.filter(r => r.type === "joined").map(r => r.nickname));
    expect(four.map(p => joinedNames.has(p.nickname)), `${where}, the pulse counts exactly the people on the board`).toEqual(four.map(p => bd.has(p.id)));
  }

  // Removed after playing, they stay out. A removal keeps the person's challenge
  // events, and the answer-based figures (answers, correct, Playing now, each
  // challenge's facts, the chart's answers, the feed's solves) count a
  // non-member's answers too: an organiser who is no longer a member is still
  // left out by ROLE. The removed participant is the control: their answer
  // still counts.
  for (const p of [P, EA, CR]) {
    const rm = await sa.delete(`/api/admin/competitions/${off.id}/users/${p.id}`, { headers: H(saCsrf) });
    expect(rm.ok(), `remove ${p.nickname}: ${rm.status()} ${await rm.text()}`).toBeTruthy();
    expect((await rm.json()).removed, `PRECONDITION: ${p.nickname}'s row was removed`).toBe(true);
  }
  expect(members(off.id), "PRECONDITION: only the planted global admin is still a member").toEqual([GA.id]);
  expect(withDb(db => db.prepare("SELECT user_id FROM challenge_events WHERE competition_id=? AND event_type='solved'").all(off.id).map(r => r.user_id).sort()),
    "PRECONDITION: the removed people's solves are still on record").toEqual([P.id, EA.id, EA.id, CR.id, CR.id, GA.id, GA.id].sort());
  const r = await pulse(off.id);
  expect(r.totals, "removed, the organisers are still in no total; the removed participant's answer still counts; enrolled is the one row left").toMatchObject({
    joined: 0, enrolled: 1, answers: 1, correct: 1, solvers: 0, active_now: 1, finished: 0,
  });
  expect(facts(r, t1), "the first challenge's facts: the removed participant's answer alone").toEqual({ attempters: 1, solvers: 1, answerers: 1, answers: 1 });
  expect(facts(r, t2), "the second: still nobody").toEqual({ attempters: 0, solvers: 0, answerers: 0, answers: 0 });
  expect(r.buckets.reduce((n, x) => n + x.answers, 0), "the chart: the removed participant's answer only").toBe(1);
  expect(feed(r), "the feed: the removed participant's solve, nobody else's").toEqual([`solved:${P.nickname}`]);
  const rawR = JSON.stringify(r);
  for (const [who, p] of [["event admin", EA], ["custom role's holder", CR], ["global admin", GA]]) {
    expect(rawR.includes(p.nickname), `the removed ${who} appears nowhere in the pulse`).toBe(false);
  }
});
