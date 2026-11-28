// MARKETING ANALYTICS — GET /api/admin/analytics/marketing (routes/
// marketing-analytics.js, lib/marketing-analytics.js), every figure BY VALUE.
//
// One world, built through the real doors, then RE-TIMED into 2001 (events'
// start, accounts' creation), so the range [2001, 2002) holds exactly this
// file's events and the figures can be asserted exactly:
//   E1 a Booth Event that asks the qualifying questions: A (hot: a large team
//      evaluating soon), B (warm: a large team only), C (said No to a
//      follow-up), D (asked to be contacted, marked contacted), and four people
//      who must count nowhere: a staff-tagged player, a benchmark account, an
//      event admin playing it, and the superadmin's answers while viewing as B;
//   E2 a Competition measuring active time: A again (returning) and E; both
//      solve, so it ends; A and E mint placement certificates, E's is revoked,
//      A shares hers;
//   E3 a Program, two attempts per question: F 100%, I 95%, G out of attempts at
//      40% (finished, under 60%), H unfinished; F mints a completion
//      certificate and shares it;
//   E4 a dry run (one player): never counted, reported as left out;
//   E5 a Competition where staff compete: its staff member counts.
// Then: the date range and kind filters, the event list, the refusals for a bad
// query, and who may read it at all (an event admin and a custom role without
// the permission are refused; a scoped role cannot be given it).
const { test, expect, request } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `mk-key-${stamp}`;
const WRONG = `mk-wrong-${stamp}`;
const URL = "/api/admin/analytics/marketing";
let sa, saCsrf;
const W = {};   // the world: events and people

function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

async function mk(name, data) {
  const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `${name} ${stamp}`, ...data } });
  expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  return { id: d.competition?.id || d.id, name: `${name} ${stamp}` };
}
async function submit(api, csrf, taskId, answer) {
  const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(csrf), data: { answer, gradingHash: await gradingHashFor(api, taskId) } });
  expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).correct;
}
/** Sign `p` in, enter `compId`, play `plan` ([taskId, answer, correct]); `after(s)` runs in the session. */
async function play(p, compId, plan, after = null) {
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
    for (const [taskId, answer, correct] of plan) expect(await submit(s.api, s.csrf, taskId, answer), `PRECONDITION: ${p.nickname}'s answer is graded ${correct}`).toBe(correct);
    if (after) await after(s);
  } finally { await s.api.dispose(); }
}
/** The event's qualifying questions by key: {key: {id, options}}. */
function qualifyingOf(compId) {
  return withDb(db => Object.fromEntries(db.prepare(
    `SELECT t.id, t.choices, g.tag FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
       JOIN task_tags g ON g.task_id=t.id AND g.tag LIKE 'qualifying:%' WHERE ct.competition_id=?`
  ).all(compId).map(r => [r.tag.slice("qualifying:".length), { id: r.id, options: JSON.parse(r.choices) }])));
}
const pick = (q, key, pos) => [q[key].id, JSON.stringify([q[key].options[pos].id]), true];
async function mint(p, compId) {
  let token = null;
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    const r = await s.api.post(`/api/competitions/${compId}/badge`, { headers: H(s.csrf), data: {} });
    expect(r.ok(), `mint for ${p.nickname}: ${r.status()} ${await r.text()}`).toBeTruthy();
    token = (await r.json()).token;
    expect(token, "PRECONDITION: a certificate token").toBeTruthy();
  } finally { await s.api.dispose(); }
  return token;
}
async function share(p, token) {
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    const r = await s.api.post(`/badge/${token}/shared`, { headers: H(s.csrf), data: {} });
    expect(r.ok(), `share: ${r.status()} ${await r.text()}`).toBeTruthy();
  } finally { await s.api.dispose(); }
}
const Y2001 = { from: "2001-01-01T00:00:00.000Z", to: "2002-01-01T00:00:00.000Z" };
/** One read over 2001 unless `params` say otherwise (each test's queries differ, so none is served from the route's 30 s cache). */
async function report(params = {}, who = null) {
  const qs = new URLSearchParams({ ...Y2001, ...params }).toString();
  const api = who || sa;
  const r = await api.get(`${URL}?${qs}`);
  expect(r.ok(), `marketing read (${qs}): ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  const P = async (label) => makeParticipant(sa, saCsrf, label);
  for (const k of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "STAFF", "BENCH", "EA", "X", "SC", "P5"]) W[k] = await P(`mk${k.toLowerCase()}`);
  const tag = async (p, t) => {
    const r = await sa.post(`/api/admin/participants/${p.id}/tags`, { headers: H(saCsrf), data: { tag: t } });
    expect(r.ok(), `tag ${t}: ${r.status()} ${await r.text()}`).toBeTruthy();
  };
  await tag(W.STAFF, "staff"); await tag(W.SC, "staff"); await tag(W.BENCH, "benchmark");

  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  W.E1 = await mk("MkBooth", { event_kind: "booth", start_time: past, duration_minutes: 600, add_qualifying: true });
  W.E2 = await mk("MkComp", { event_kind: "tournament", start_time: past, duration_minutes: 600, measure_presence: true, add_qualifying: false });
  W.E3 = await mk("MkProgram", { event_kind: "program", start_time: past, deadline_at: later, attempt_cap: 2, add_qualifying: false });
  W.E4 = await mk("MkDry", { event_kind: "tournament", start_time: past, duration_minutes: 600, add_qualifying: false });
  W.E5 = await mk("MkStaff", { event_kind: "tournament", start_time: past, duration_minutes: 600, staff_compete: true, add_qualifying: false });
  const dry = await sa.post(`/api/admin/competitions/${W.E4.id}/tags`, { headers: H(saCsrf), data: { tag: "test/dry run" } });
  expect(dry.ok(), `dry-run tag: ${await dry.text()}`).toBeTruthy();
  await grantEventAdmin(sa, saCsrf, W.E4.id, W.EA.id);   // EA: an event admin (organiser of the dry run)

  const own = async (label, ev) => (await assignTask(sa, saCsrf, (await makeTask(sa, saCsrf, label, { correct_answer: KEY })).id, [ev.id])).copies[0].task_id;
  const t1 = await own("mk1", W.E1), t2 = await own("mk2", W.E1);
  const t3 = await own("mk3", W.E2);
  const t4 = await own("mk4", W.E3), t5 = await own("mk5", W.E3);
  const t6 = await own("mk6", W.E4);

  // ── E1 ──
  await enrol(sa, saCsrf, W.E1.id, [W.A.id, W.B.id, W.C.id, W.D.id, W.BENCH.id, W.EA.id]);
  withDb(db => db.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,1)")
    .run(W.E1.id, W.STAFF.id, "superadmin", new Date().toISOString()), { readonly: false });
  const q = qualifyingOf(W.E1.id);
  expect(Object.keys(q).sort(), "PRECONDITION: the Booth Event asks the four built-in questions").toEqual(["developers", "evaluating", "follow_up", "scanner"]);
  await play(W.A, W.E1.id, [[t1, KEY, true], [t2, KEY, true], pick(q, "developers", 3), pick(q, "evaluating", 1)]);
  await play(W.B, W.E1.id, [[t1, KEY, true], [t2, WRONG, false], pick(q, "developers", 2)]);
  await play(W.C, W.E1.id, [[t1, WRONG, false], pick(q, "follow_up", 1)]);
  await play(W.D, W.E1.id, [pick(q, "follow_up", 0)]);
  for (const p of [W.STAFF, W.BENCH]) await play(p, W.E1.id, [[t1, KEY, true], [t2, KEY, true], pick(q, "follow_up", 0)]);
  {
    const s = await apiLogin(W.EA.email, PARTICIPANT_PASS);
    try {
      const tg = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "participant" } });
      expect(tg.ok(), `participant view: ${await tg.text()}`).toBeTruthy();
      const csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
      const sel = await s.api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: W.E1.id } });
      expect(sel.ok(), `EA select: ${await sel.text()}`).toBeTruthy();
      expect(await submit(s.api, csrf, t1, KEY), "PRECONDITION: the event admin plays").toBe(true);
      expect(await submit(s.api, csrf, t2, KEY)).toBe(true);
    } finally { await s.api.dispose(); }
  }
  // The superadmin, viewing as B, solves t2 (B's own answer to it was wrong).
  {
    const imp = await sa.post(`/api/admin/participants/${W.B.id}/impersonate`, { headers: H(saCsrf) });
    expect(imp.ok(), `view as B: ${await imp.text()}`).toBeTruthy();
    let csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    try {
      const sel = await sa.post("/api/select-competition", { headers: H(csrf), data: { competitionId: W.E1.id } });
      expect(sel.ok()).toBeTruthy();
      expect(await submit(sa, csrf, t2, KEY), "PRECONDITION: the answer given while viewing as B is right").toBe(true);
    } finally {
      const ex = await sa.post("/api/impersonation/exit", { headers: H(csrf) });
      expect(ex.ok(), `leave the view: ${await ex.text()}`).toBeTruthy();
      saCsrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    }
  }
  const mark = await sa.post(`/api/admin/competitions/${W.E1.id}/leads/${W.D.id}/contacted`, { headers: H(saCsrf), data: { contacted: true } });
  expect(mark.ok(), `mark D contacted: ${mark.status()} ${await mark.text()}`).toBeTruthy();
  // A certificate row a pre-release database could hold for the staff player: not counted.
  withDb(db => db.prepare(`INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot, created_at, basis)
    VALUES (?,?,?,NULL,1,'',?,?, 'participation')`).run(`mkstaff${stamp}`, W.STAFF.id, W.E1.id, W.STAFF.nickname, new Date().toISOString()), { readonly: false });

  // ── E2 ── A solves first (E unfinished keeps it live), then E finishes it.
  await enrol(sa, saCsrf, W.E2.id, [W.A.id, W.E.id]);
  await play(W.A, W.E2.id, [[t3, KEY, true]]);
  await play(W.E, W.E2.id, [[t3, WRONG, false], [t3, KEY, true]]);
  await expect.poll(() => withDb(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(W.E2.id).ended_at), { timeout: 15000, message: "PRECONDITION: E2 ends when both have finished" }).toBeTruthy();
  const tokA = await mint(W.A, W.E2.id);
  const tokE = await mint(W.E, W.E2.id);
  await share(W.A, tokA);
  const rv = await sa.post(`/api/admin/badges/${tokE}/revoke`, { headers: H(saCsrf), data: { reason: "fixture" } });
  expect(rv.ok(), `revoke: ${rv.status()} ${await rv.text()}`).toBeTruthy();

  // ── E3 ── two attempts per question.
  await enrol(sa, saCsrf, W.E3.id, [W.F.id, W.G.id, W.H.id, W.I.id]);
  await play(W.F, W.E3.id, [[t4, KEY, true], [t5, KEY, true]]);
  await play(W.I, W.E3.id, [[t4, KEY, true], [t5, WRONG, false], [t5, KEY, true]]);
  // Two DIFFERENT wrong answers: the same answer again within 3 s is folded into the first (no row, no attempt).
  await play(W.G, W.E3.id, [[t4, WRONG, false], [t4, `${WRONG}-again`, false], [t5, KEY, true]]);
  await play(W.H, W.E3.id, [[t4, KEY, true]]);
  const tokF = await mint(W.F, W.E3.id);
  await share(W.F, tokF);

  // ── E4, E5 ──
  await enrol(sa, saCsrf, W.E4.id, [W.X.id]);
  await play(W.X, W.E4.id, [[t6, KEY, true]]);
  await enrol(sa, saCsrf, W.E5.id, [W.SC.id, W.P5.id]);

  // Every answer is on record (challenge_events are written post-commit).
  await expect.poll(() => withDb(db => db.prepare(
    "SELECT COUNT(*) AS n FROM challenge_events WHERE competition_id IN (?,?,?,?) AND event_type IN ('solved','incorrect')"
  ).get(W.E1.id, W.E2.id, W.E3.id, W.E4.id).n), { timeout: 20000, message: "PRECONDITION: every answer is recorded" }).toBe(10 + 6 + 2 + 3 + 1 + 9 + 1);
  expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM challenge_events WHERE competition_id=? AND impersonated=1").get(W.E1.id).n),
    "PRECONDITION: the viewed-as answer is on record, flagged").toBe(1);

  // ── Re-time into 2001, and give the people their profiles ──
  withDb(db => {
    const at = { E1: "2001-03-01T10:00:00.000Z", E2: "2001-06-01T10:00:00.000Z", E3: "2001-09-01T10:00:00.000Z", E4: "2001-04-01T10:00:00.000Z", E5: "2001-10-01T10:00:00.000Z" };
    for (const [k, v] of Object.entries(at)) db.prepare("UPDATE competitions SET start_time=? WHERE id=?").run(v, W[k].id);
    for (const k of ["C", "D", "F", "G", "H", "I", "STAFF", "BENCH", "EA", "X", "SC", "P5"]) db.prepare("UPDATE users SET created_at=? WHERE id=?").run("2000-06-01T00:00:00.000Z", W[k].id);
    db.prepare("UPDATE users SET created_at=?, invitation_id=?, country='Germany', company='Globex Inc' WHERE id=?").run("2001-02-01T00:00:00.000Z", `inv-${stamp}`, W.A.id);
    db.prepare("UPDATE users SET created_at=?, registered_via='desk', country='Germany', company='globex' WHERE id=?").run("2001-02-02T00:00:00.000Z", W.B.id);
    db.prepare("UPDATE users SET created_at=?, registration_competition_id=? WHERE id=?").run("2001-05-20T00:00:00.000Z", W.E2.id, W.E.id);
    db.prepare("UPDATE users SET country='France', company='Initech Ltd' WHERE id=?").run(W.C.id);
    db.prepare("UPDATE users SET country='', company='' WHERE id=?").run(W.SC.id);
    // Net active time in E2: 30 minutes for A, 10 for E (five-minute buckets),
    // whatever their requests banked while playing.
    for (const [p, n] of [[W.A, 6], [W.E, 2]]) {
      db.prepare(`INSERT INTO competition_presence (competition_id, user_id, buckets, last_bucket) VALUES (?,?,?,0)
                  ON CONFLICT(competition_id, user_id) DO UPDATE SET buckets=excluded.buckets`).run(W.E2.id, p.id, n);
    }
  }, { readonly: false });
});

test.afterAll(async () => { if (sa) await sa.dispose().catch(() => {}); });

test("every figure, by value: only the people who count, only real activity, dry runs out", async () => {
  const d = await report();
  expect(d.range).toEqual({ from: Y2001.from, to: Y2001.to, basis: "event_start" });
  expect(d.dry_run_excluded, "the dry run is left out and reported").toBe(1);
  expect(d.events.map(e => e.id).sort(), "the four events, never the dry run").toEqual([W.E1.id, W.E2.id, W.E3.id, W.E5.id].sort());

  expect(d.reach).toEqual({
    events: 4, events_by_kind: { booth: 1, tournament: 2, program: 1 },
    joined: 12, people: 11, returning: 1,
    new_accounts: { total: 3, by_source: { desk: 1, invitation: 1, join_link: 1, other: 0 } },
    countries: { top: [{ name: "GB", count: 7 }, { name: "Germany", count: 2 }, { name: "France", count: 1 }], other: 0, other_kinds: 0, not_given: 1 },
    companies: { top: [{ name: "Acme", count: 7 }, { name: "Globex Inc", count: 2 }, { name: "Initech Ltd", count: 1 }], other: 0, other_kinds: 0, not_given: 1 },
  });
  expect(d.engagement).toEqual({
    joined: 12, played: 10, answers: 17, quick_answers: 5,
    answered_pairs: 14, solved_pairs: 11,
    finished: 5, finish_base: 10, finish_events: 3,
    presence: { events_measured: 1, people_seen: 2, median_minutes: 20 },
  });
  expect(d.outcomes.certificates, "A's placement and F's completion; E's is revoked, the staff row is not counted")
    .toEqual({ placement: 1, participation: 0, completion: 1, not_recorded: 0, total: 2, shared: 2 });
  const G = d.outcomes.programs;
  expect({ ...G, band_labels: undefined }).toEqual({
    events: 1, learners: 4, finished: 3, graded: 3, passed: 2, band_labels: undefined,
    bands: { excellent: 2, very_good: 0, good: 0, satisfactory: 0, try_again: 1 },
  });
  expect(G.band_labels.map(b => b.key)).toEqual(["excellent", "very_good", "good", "satisfactory", "try_again"]);
  expect(d.pipeline, "E1's leads by the reports' own rules; D marked contacted; C declined").toEqual({
    events_asked: 1, leads: 3, hot: 2, warm: 1, cold: 0, follow_up_yes: 1, follow_up_no: 1, contacted: 1,
  });

  const row = (ev) => d.events.find(e => e.id === ev.id);
  expect(row(W.E1)).toMatchObject({ kind: "booth", joined: 4, played: 4, answers: 5, answered_pairs: 5, solved_pairs: 3, scoring_questions: 2, finished: 1, completion: 0.25, certificates: 0, asked_qualifying: true, hot_leads: 2 });
  expect(row(W.E1).solve_rate).toBeCloseTo(0.6, 10);
  expect(row(W.E2)).toMatchObject({ kind: "tournament", joined: 2, played: 2, answers: 3, solve_rate: 1, finished: 2, completion: 1, certificates: 1, asked_qualifying: false, hot_leads: null });
  expect(row(W.E3)).toMatchObject({ kind: "program", joined: 4, played: 4, answers: 9, answered_pairs: 7, solved_pairs: 6, finished: 2, completion: 0.5, certificates: 1, hot_leads: null });
  expect(row(W.E5), "where staff compete, the staff member counts").toMatchObject({ joined: 2, played: 0, scoring_questions: 0, finished: null, completion: null, solve_rate: null });
  expect(d.events.map(e => e.id), "newest start first").toEqual([W.E5.id, W.E3.id, W.E2.id, W.E1.id]);
});

test("the date range, the kinds and the event list each narrow every figure", async () => {
  // The range picks by start: [May, end of 2001) holds E2, E3 and E5.
  const r = await report({ from: "2001-05-01T00:00:00.000Z", to: "2001-12-31T00:00:00.000Z" });
  expect(r.events.map(e => e.id).sort()).toEqual([W.E2.id, W.E3.id, W.E5.id].sort());
  expect([r.reach.people, r.reach.returning, r.reach.joined, r.dry_run_excluded, r.pipeline.events_asked]).toEqual([8, 0, 8, 0, 0]);
  expect(r.reach.new_accounts.total, "only E's account was created inside this range").toBe(1);
  // CONTROL: the end is exclusive, and no lower bound holds every event before it.
  const early = await report({ from: "", to: "2001-03-01T10:00:00.000Z" });
  expect(early.events.length, "E1 starts exactly at the end: out").toBe(0);
  expect((await report({ from: "", to: "2001-03-01T10:00:00.001Z" })).events.map(e => e.id)).toEqual([W.E1.id]);

  const prog = await report({ kinds: "program" });
  expect(prog.events.map(e => e.id)).toEqual([W.E3.id]);
  expect([prog.reach.events_by_kind, prog.reach.joined, prog.engagement.played, prog.outcomes.certificates.total, prog.outcomes.programs.events])
    .toEqual([{ booth: 0, tournament: 0, program: 1 }, 4, 4, 1, 1]);
  const two = await report({ kinds: "booth,tournament" });
  expect(two.events.map(e => e.id).sort()).toEqual([W.E1.id, W.E2.id, W.E5.id].sort());
  expect([two.outcomes.programs.events, two.pipeline.events_asked, two.reach.people]).toEqual([0, 1, 7]);

  const list = await report({ events: `${W.E1.id},${W.E3.id},${W.E4.id}` });
  expect(list.events.map(e => e.id).sort(), "the list narrows; a dry run in it stays out").toEqual([W.E1.id, W.E3.id].sort());
  expect([list.dry_run_excluded, list.reach.joined, list.reach.returning]).toEqual([1, 8, 0]);
  expect(list.filters.event_ids.sort()).toEqual([W.E1.id, W.E3.id, W.E4.id].sort());
});

test("a malformed query is refused by name", async () => {
  const bad = async (qs, code) => {
    const r = await sa.get(`${URL}?${qs}`);
    expect(r.status(), `${qs}: ${await r.text()}`).toBe(400);
    expect((await r.json()).code, qs).toBe(code);
  };
  await bad("kinds=booth,bogus", "marketing_kind_unknown");
  await bad("from=yesterday", "marketing_range_invalid");
  await bad("to=2001-13-45", "marketing_range_invalid");
  await bad("from=2002-01-01&to=2001-01-01", "marketing_range_invalid");
  await bad("events=a%20b", "marketing_event_invalid");
  await bad(`events=${Array.from({ length: 1001 }, (_, i) => `e${i}`).join(",")}`, "marketing_too_many_events");
  const rep = await sa.get(`${URL}?kinds=booth&kinds=program`);
  expect(rep.status(), "a repeated parameter").toBe(400);
  // CONTROL: the same values, well formed, answer.
  expect((await sa.get(`${URL}?kinds=booth,program&from=2001-01-01&to=2001-12-31`)).status()).toBe(200);
});

test("who may read it: administrators; never an event admin, a role without the permission, or anybody signed out", async () => {
  // Signed out.
  const anon = await request.newContext({ baseURL: BASE });
  try { expect((await anon.get(`${URL}?kinds=booth`)).status()).toBe(401); } finally { await anon.dispose(); }

  // An event admin (EA organises the dry run): refused at the gate, in words.
  const ea = await apiLogin(W.EA.email, PARTICIPANT_PASS);
  try {
    const r = await ea.api.get(`${URL}?kinds=booth`);
    expect(r.status()).toBe(403);
    const b = await r.json();
    expect(b.code).toBe("event_admin_forbidden");
    expect(b.error).toMatch(/every event on the platform/);
    expect(JSON.stringify(b), "no figure leaks with the refusal").not.toContain("events_by_kind");
  } finally { await ea.api.dispose(); }

  // Custom roles: one of scope "all" without the permission is refused; one
  // with it reads; a scoped role cannot be given it.
  const role = async (label, scope_mode, permissions) => sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${stamp}`, scope_mode, permissions } });
  const scoped = await role("Mk scoped", "granted", ["analytics.view", "analytics.marketing"]);
  expect(scoped.status(), "a role scoped to its events cannot hold a platform-wide permission").toBe(400);
  expect((await scoped.json()).code).toBe("role_permission_needs_every_event");
  const without = (await (await role("Mk without", "all", ["analytics.view"])).json()).role;
  const withIt = (await (await role("Mk with", "all", ["analytics.marketing"])).json()).role;
  expect(without && withIt, "PRECONDITION: both roles exist").toBeTruthy();
  const give = async (p, r) => {
    const x = await sa.patch(`/api/admin/users/${p.id}/role`, { headers: H(saCsrf), data: { role: r.id } });
    expect(x.ok(), `give ${r.id}: ${await x.text()}`).toBeTruthy();
  };
  await give(W.X, without);
  await give(W.P5, withIt);
  const sx = await apiLogin(W.X.email, PARTICIPANT_PASS);
  try {
    const r = await sx.api.get(`${URL}?kinds=booth`);
    expect(r.status()).toBe(403);
    expect((await r.json())).toMatchObject({ code: "permission_denied", permission: "analytics.marketing" });
    const me = await (await sx.api.get("/api/admin/me")).json();
    expect(me.permissions, "PRECONDITION: the role is an admin role without it").toContain("analytics.view");
    expect(me.permissions).not.toContain("analytics.marketing");
  } finally { await sx.api.dispose(); }
  const sp = await apiLogin(W.P5.email, PARTICIPANT_PASS);
  try {
    const r = await sp.api.get(`${URL}?kinds=program&from=2001-01-01&to=2002-01-01`);
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).events.map(e => e.id), "the same whole-platform answer").toEqual([W.E3.id]);
  } finally { await sp.api.dispose(); }

  // The built-in admin holds it.
  const adm = await makeParticipant(sa, saCsrf, "mkadmin");
  const pr = await sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(pr.ok()).toBeTruthy();
  const sad = await apiLogin(adm.email, PARTICIPANT_PASS);
  try { expect((await sad.api.get(`${URL}?kinds=tournament&from=2001-01-01&to=2002-01-01`)).status()).toBe(200); }
  finally { await sad.api.dispose(); }
});
