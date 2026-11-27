// WHAT AN ADMIN DOES WHILE VIEWING AS A PARTICIPANT IS IN NO LIVE FIGURE OF THE
// WORKSPACE OVERVIEW; A BENCHMARK ACCOUNT COUNTS LIKE ANYBODY (sweep gap #53).
//
// GET …/overview-pulse (routes/event-overview.js) shares Analytics' rule that
// impersonated rows never count (`ce.impersonated=0` in every challenge_events
// read) and keeps benchmark accounts in (only `staff`, and where staff do not
// compete the roles the boards leave out, are left out). Locked here by value:
//   (1) a superadmin viewing as a participant answers wrong, then solves every
//       challenge; a real participant does exactly the same; a benchmark account
//       answers wrong and solves one. Every figure (the totals — answers,
//       correct, solvers, Playing now, finished —, each challenge's facts, the
//       chart's answers and correct answers, the feed's solves) holds the real
//       participant and the benchmark account and none of the impersonated
//       activity, which is on record, flagged, beside them; the viewed
//       participant still counts as a member (joined, the feed's joins);
//   (2) past the end, an answer given while viewing as a late entrant does not
//       stretch the chart's window (it stays at the last real late activity, a
//       join); a real late entrant's answer does (the control).
// The other halves of the pulse's filter are held elsewhere, by value:
// `staff` out unless staff compete and hold a row, and the roles the boards leave
// out — tests/workspace-pulse-counts.api.spec.js tests (5) and (6).
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `pimp-key-${stamp}`;
const WRONG = `pimp-wrong-${stamp}`;
let sa, saCsrf;

function withDb(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

async function mk(name, data) {
  const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `${name} ${stamp}`, ...data } });
  expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  return { id: d.competition?.id || d.id, name: `${name} ${stamp}` };
}

async function freshCsrf(api) {
  return (await (await api.get("/api/csrf-token")).json()).csrfToken;
}

async function submit(api, csrf, taskId, answer) {
  const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(csrf), data: { answer, gradingHash: await gradingHashFor(api, taskId) } });
  expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).correct;
}

/** A participant, signed in as themselves, plays `plan` ([taskId, answer, correct]) in the event. */
async function play(p, compId, plan) {
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
    for (const [taskId, answer, correct] of plan) expect(await submit(s.api, s.csrf, taskId, answer), `PRECONDITION: ${p.nickname}'s answer is graded ${correct}`).toBe(correct);
  } finally { await s.api.dispose(); }
}

/** The superadmin, viewing as `p`, plays `plan` in the event, then leaves the view. */
async function playViewingAs(p, compId, plan) {
  const imp = await sa.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(saCsrf) });
  expect(imp.ok(), `view as: ${imp.status()} ${await imp.text()}`).toBeTruthy();
  expect((await imp.json()).readOnly, "PRECONDITION: a superadmin's view writes").toBe(false);
  let csrf = await freshCsrf(sa);
  try {
    const sel = await sa.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition while viewing: ${await sel.text()}`).toBeTruthy();
    for (const [taskId, answer, correct] of plan) expect(await submit(sa, csrf, taskId, answer), `PRECONDITION: the answer given as ${p.nickname} is graded ${correct}`).toBe(correct);
  } finally {
    const ex = await sa.post("/api/impersonation/exit", { headers: H(csrf) });
    expect(ex.ok(), `leave the view: ${ex.status()} ${await ex.text()}`).toBeTruthy();
    saCsrf = await freshCsrf(sa);
  }
  const me = await sa.get("/api/admin/me");
  expect(me.ok(), "PRECONDITION: back in the superadmin's own session").toBeTruthy();
}

/** Each person's answers in the event, as recorded: userId → sorted "type:impersonated". */
const answersOf = (compId) => withDb(db => db.prepare(
  "SELECT user_id, event_type, impersonated FROM challenge_events WHERE competition_id=? AND event_type IN ('solved','incorrect')"
).all(compId)).reduce((m, r) => { (m[r.user_id] = m[r.user_id] || []).push(`${r.event_type}:${r.impersonated}`); m[r.user_id].sort(); return m; }, {});

const pulse = async (compId) => {
  const r = await sa.get(`/api/admin/competitions/${compId}/overview-pulse`);
  expect(r.ok(), `pulse: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
};
const facts = (d, t) => {
  const x = d.tasks.find(r => r.id === t.id);
  expect(x, `the pulse has a row for ${t.title}`).toBeTruthy();
  return { attempters: x.attempters, solvers: x.solvers, answerers: x.answerers, answers: x.answers };
};
const sum = (d, k) => d.buckets.reduce((n, b) => n + b[k], 0);

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
});
test.afterAll(async () => {
  if (sa) await sa.dispose().catch(() => {});
});

test("what a superadmin answers while viewing as a participant is in no live figure; a participant's identical play is in every one, and a benchmark account counts like anybody", async () => {
  test.setTimeout(120_000);
  // A live Booth Event: it never auto-ends on all-solved (fixture item 1), so
  // two people finishing keep it live; no qualifying questions.
  const ev = await mk("PulseImp", { event_kind: "booth", start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 120, add_qualifying: false });
  const t1 = await makeTask(sa, saCsrf, "pi1", { correct_answer: KEY });
  const t2 = await makeTask(sa, saCsrf, "pi2", { correct_answer: KEY });
  for (const t of [t1, t2]) await assignTask(sa, saCsrf, t.id, [ev.id]);
  const real = await makeParticipant(sa, saCsrf, "pireal");
  const viewed = await makeParticipant(sa, saCsrf, "piviewed");
  const bench = await makeParticipant(sa, saCsrf, "pibench");
  const tg = await sa.post(`/api/admin/participants/${bench.id}/tags`, { headers: H(saCsrf), data: { tag: "benchmark" } });
  expect(tg.ok(), `tag benchmark: ${tg.status()} ${await tg.text()}`).toBeTruthy();
  expect(withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(bench.id).map(r => r.tag)), "PRECONDITION: a benchmark account, not staff").toEqual(["benchmark"]);
  await enrol(sa, saCsrf, ev.id, [real.id, viewed.id, bench.id]);

  // The same play twice: once by the participant, once by the superadmin
  // viewing as another participant. A wrong answer first (an `incorrect` row
  // the filter must also leave out), then both challenges.
  const same = [[t1.id, WRONG, false], [t1.id, KEY, true], [t2.id, KEY, true]];
  await play(real, ev.id, same);
  await playViewingAs(viewed, ev.id, same);
  await play(bench, ev.id, [[t2.id, WRONG, false], [t1.id, KEY, true]]);

  // PRECONDITION: every answer is on record (written post-commit), the
  // impersonated ones flagged, so their absence below is the filter's doing.
  await expect.poll(() => answersOf(ev.id), { timeout: 15000, message: "every answer is recorded" }).toEqual({
    [real.id]: ["incorrect:0", "solved:0", "solved:0"],
    [viewed.id]: ["incorrect:1", "solved:1", "solved:1"],
    [bench.id]: ["incorrect:0", "solved:0"],
  });

  const d = await pulse(ev.id);
  // The totals: the participant (3 answers, 2 right, finished) and the
  // benchmark account (2 answers, 1 right); the viewed participant is a member
  // and nothing more.
  expect(d.totals, "every total holds the participant and the benchmark account, never what was answered while viewing").toEqual({
    joined: 3, joined_before_start: 0, enrolled: 3,
    answers: 5, correct: 3, solvers: 2, active_now: 2, finished: 1, visible_tasks: 2,
  });
  expect(facts(d, t1), "the first challenge: the participant (wrong, then right) and the benchmark account").toEqual({ attempters: 2, solvers: 2, answerers: 2, answers: 3 });
  expect(facts(d, t2), "the second: the participant's solve and the benchmark account's wrong answer").toEqual({ attempters: 2, solvers: 1, answerers: 2, answers: 2 });
  expect([sum(d, "answers"), sum(d, "correct"), sum(d, "joins")], "the chart: the same answers, right answers and joins").toEqual([5, 3, 3]);
  const feed = d.recent.map(r => `${r.type}:${r.nickname}`).sort();
  expect(feed, "the feed: three joins, and the solves of the participant and the benchmark account only").toEqual([
    `joined:${real.nickname}`, `joined:${viewed.nickname}`, `joined:${bench.nickname}`,
    `solved:${real.nickname}`, `solved:${real.nickname}`, `solved:${bench.nickname}`,
  ].sort());
});

test("past the end, an answer given while viewing as a late entrant does not stretch the chart's window; a real late entrant's answer does", async () => {
  test.setTimeout(120_000);
  const ev = await mk("PulseImpLate", { event_kind: "booth", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 120, late_entry_enabled: true, add_qualifying: false });
  const t = await makeTask(sa, saCsrf, "pil", { correct_answer: KEY });
  await assignTask(sa, saCsrf, t.id, [ev.id]);
  const early = await makeParticipant(sa, saCsrf, "pilearly");
  await enrol(sa, saCsrf, ev.id, [early.id]);
  await play(early, ev.id, [[t.id, KEY, true]]);
  const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.ok(), `End now: ${await end.text()}`).toBeTruthy();
  const row = (await (await sa.get("/api/admin/competitions")).json()).find(x => x.id === ev.id);
  expect(row && row.late_entry_window_open, "PRECONDITION: the late-entry window is open").toBe(true);
  const effEnd = Date.parse(row.effective_end);

  // Two late entrants join the open window: one to be viewed, one real.
  const viewed = await makeParticipant(sa, saCsrf, "pilviewed");
  const lateReal = await makeParticipant(sa, saCsrf, "pilreal");
  await enrol(sa, saCsrf, ev.id, [viewed.id, lateReal.id]);
  const joins = withDb(db => db.prepare("SELECT user_id, assigned_at FROM competition_users WHERE competition_id=? AND user_id IN (?,?)").all(ev.id, viewed.id, lateReal.id));
  expect(joins.length, "PRECONDITION: both joined").toBe(2);
  for (const j of joins) expect(Date.parse(j.assigned_at), "PRECONDITION: each joined after the end (a late entrant)").toBeGreaterThan(effEnd);
  const lastJoin = Math.max(...joins.map(j => Date.parse(j.assigned_at)));
  // The window now runs to the last late join, to the millisecond (the pulse
  // does not round its end), so any answer it counted that came after that
  // join would move the end: the exact assertions below need no gap.
  const d0 = await pulse(ev.id);
  expect(Date.parse(d0.window.to), "CONTROL: the late joins already stretch the window, to the last of them").toBe(lastJoin);

  await playViewingAs(viewed, ev.id, [[t.id, KEY, true]]);
  let impAt;
  await expect.poll(() => {
    const r = withDb(db => db.prepare("SELECT occurred_at, impersonated FROM challenge_events WHERE competition_id=? AND user_id=? AND event_type='solved'").get(ev.id, viewed.id));
    impAt = r ? Date.parse(r.occurred_at) : null;
    return r ? r.impersonated : -1;
  }, { timeout: 15000, message: "PRECONDITION: the answer given while viewing is recorded, flagged" }).toBe(1);
  expect(impAt, "PRECONDITION: it came after the last join, so had the pulse counted it the window's end would be this answer").toBeGreaterThan(lastJoin);

  const d1 = await pulse(ev.id);
  expect(Date.parse(d1.window.to), "the window still ends at the last join, not at the answer given while viewing").toBe(lastJoin);
  expect(d1.totals.answers, "…and the answer is in no total: only the early solve").toBe(1);
  expect(sum(d1, "answers"), "…nor in the chart").toBe(1);

  // CONTROL: the same answer given by a real late entrant stretches it.
  await play(lateReal, ev.id, [[t.id, KEY, true]]);
  await expect.poll(async () => (await pulse(ev.id)).totals.answers, { timeout: 15000, message: "the real late answer reaches the pulse" }).toBe(2);
  const realAt = withDb(db => db.prepare("SELECT occurred_at FROM challenge_events WHERE competition_id=? AND user_id=? AND event_type='solved'").get(ev.id, lateReal.id));
  expect(realAt, "PRECONDITION: the real late answer is recorded").toBeTruthy();
  const d2 = await pulse(ev.id);
  expect(Date.parse(d2.window.to), "a real late answer moves the window's end to it").toBe(Date.parse(realAt.occurred_at));
  expect(sum(d2, "answers"), "…and the chart holds it").toBe(2);
});
