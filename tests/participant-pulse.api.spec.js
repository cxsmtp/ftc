// @ts-check
//
// THE PARTICIPANT PULSE (GET /api/participant/pulse) AND THE BOARD IT GATES.
//
// The SPA's three participant polls (/api/status, /api/me for the score pill,
// /api/session/status) became one, and the leaderboard is fetched only when the
// pulse's `lb_version` moves (perf/RESULTS.md, "1000-user sign-in storm"). What
// must hold for that to be safe, each with a control:
//
//   1. `status` IS the /api/status body, `score` IS /api/me's score, and
//      `session` matches /api/session/status for the same live session — the
//      pulse cannot describe the participant differently from what it replaced.
//   2. An unchanged pulse revalidates to 304 on its ETag (and a changed one does
//      not): the poll that runs every 15 s for the whole event costs no body.
//   3. `lb_version` does NOT move on a read (control: two reads agree) and DOES
//      move on a solve, and the board read right after shows the solve — the
//      ranked-board memo (lib/leaderboard.js buildLeaderboard) never serves a
//      board older than the bust that moved the version.
//   4. It is a poll: a GET that does not slide the session, and an anonymous
//      caller gets the ordinary 401.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, gradingHashFor, registerPost } = require("./helpers");
const crypto = require("crypto");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

async function mkParticipant(sa, saCsrf, nick) {
  const email = `pl_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Pl", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), `register ${nick}: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const listed = await (await sa.get(`/api/admin/participants?limit=5000`)).json();
  const u = (listed.participants || []).find(p => p.email === email);
  expect(u, `participant ${nick} exists`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
  return { id: u.id, email, nick };
}

let fx;
test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `PL ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
  }})).json()).competition.id;
  // Two challenges and two participants, so one solve cannot end the event
  // (fixture checklist item 1).
  const mkTask = async (n) => (await (await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title: `PL-${n} ${t}`, description: "<p>x</p>", difficulty: "hard", answer_type: "text", correct_answer: "a", status: "published",
  }})).json()).id;
  const task1 = await mkTask(1), task2 = await mkTask(2);
  for (const id of [task1, task2]) await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  const a = await mkParticipant(sa, csrf, `a${t}`), b = await mkParticipant(sa, csrf, `b${t}`);
  const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [a.id, b.id], competitionIds: [compId] } })).json();
  expect(asg.assigned, `both assigned: ${JSON.stringify(asg)}`).toBe(2);
  await sa.dispose();
  fx = { compId, task1, task2, a, b };
});

async function enter(who) {
  const L = await apiLogin(who.email);
  const r = await L.api.post("/api/select-competition", { headers: H(L.csrf), data: { competitionId: fx.compId } });
  expect(r.ok(), `select: ${await r.text()}`).toBeTruthy();
  return L;
}

test("the pulse answers what the three polls answered, for the same session", async () => {
  const A = await enter(fx.a);
  try {
    const p = await A.api.get("/api/participant/pulse");
    expect(p.status(), await p.text()).toBe(200);
    const body = await p.json();
    const status = await (await A.api.get("/api/status")).json();
    const me = await (await A.api.get("/api/me")).json();
    const ss = await (await A.api.get("/api/session/status")).json();
    expect(body.status, "status is the /api/status body, field for field").toEqual(status);
    expect(body.status.status, "CONTROL: a live event").toBe("live");
    expect(body.score, "score is /api/me's score").toBe(me.score);
    expect(typeof body.lb_version, "an opaque board version").toBe("string");
    for (const k of ["active", "expires_at", "server_started_at", "role", "user_id", "impersonating", "admin_view"]) {
      expect(body.session[k], `session.${k} matches /api/session/status`).toEqual(ss[k]);
    }
    expect(body.session.active).toBe(true);
    expect(body.session.user_id).toBe(fx.a.id);
  } finally { await A.api.dispose(); }
});

test("an unchanged pulse revalidates to 304; a changed one answers 200 with a new body", async () => {
  const A = await enter(fx.a);
  try {
    const first = await A.api.get("/api/participant/pulse");
    expect(first.status()).toBe(200);
    const etag = first.headers()["etag"];
    expect(etag, "the pulse carries an ETag").toBeTruthy();
    const again = await A.api.get("/api/participant/pulse", { headers: { "if-none-match": etag } });
    expect(again.status(), "nothing changed: 304, no body").toBe(304);
    expect((await again.body()).length).toBe(0);
    const control = await A.api.get("/api/participant/pulse", { headers: { "if-none-match": 'W/"not-it"' } });
    expect(control.status(), "CONTROL: a different validator gets the body").toBe(200);
    // A wrong answer moves the score (and the board): the old validator no longer matches.
    const sub = await A.api.post(`/api/tasks/${fx.task2}/submit`, { headers: H(A.csrf), data: { answer: "wrong", gradingHash: await gradingHashFor(A.api, fx.task2) } });
    expect(sub.ok(), `submit: ${await sub.text()}`).toBeTruthy();
    const after = await A.api.get("/api/participant/pulse", { headers: { "if-none-match": etag } });
    expect(after.status(), "the score moved: a full answer").toBe(200);
    expect((await after.json()).score).toBe((await first.json()).score - 5);
  } finally { await A.api.dispose(); }
});

test("lb_version holds still across reads and moves on a solve, and the next board read shows the solve", async () => {
  const A = await enter(fx.a);
  const B = await enter(fx.b);
  try {
    const v = async (who) => (await (await who.api.get("/api/participant/pulse")).json()).lb_version;
    const board = async () => (await (await B.api.get("/api/leaderboard")).json()).board || [];
    const row = (lb) => lb.find(e => e.nickname === fx.a.nick);
    // Warm the board (and its ranked memo) for B, then read the version twice.
    const warm = await board();
    expect(row(warm), "A is on the board").toBeTruthy();
    const v1 = await v(B);
    const v2 = await v(B);
    expect(v2, "CONTROL: reads do not move the version").toBe(v1);
    expect(await v(A), "one version per event, whoever asks").toBe(v1);
    const before = row(await board()).score;
    const sub = await A.api.post(`/api/tasks/${fx.task1}/submit`, { headers: H(A.csrf), data: { answer: "a", gradingHash: await gradingHashFor(A.api, fx.task1) } });
    expect(sub.ok(), `solve: ${await sub.text()}`).toBeTruthy();
    expect((await sub.json()).correct, "precondition: graded correct").toBe(true);
    const v3 = await v(B);
    expect(v3, "the solve moved the version").not.toBe(v1);
    expect(v3, "an opaque token, not a counter").toMatch(/^[A-Za-z0-9_-]{22}$/);
    const after = await board();
    expect(row(after).score, "the board read after the version moved shows the solve, not a memoised board").toBeGreaterThan(before);
    expect(await v(B), "and the version holds still again").toBe(v3);
  } finally { await A.api.dispose(); await B.api.dispose(); }
});

test("lb_version is an opaque token: no number, no order, and two events in the same state read differently", async () => {
  // Before an event starts its version counter roughly counts joins and admin
  // edits, and no participant count may appear anywhere: the wire carries a
  // keyed token over it. Two fresh events taken through the same steps hold the
  // same counter, so a readable counter would give them the same value.
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const pairs = [];
  try {
    for (const n of [1, 2]) {
      const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `PLV${n} ${t}`, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60,
      }})).json()).competition.id;
      const p = await mkParticipant(sa, csrf, `v${n}${t}`);
      const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [compId] } })).json();
      expect(asg.assigned, `assigned: ${JSON.stringify(asg)}`).toBe(1);
      pairs.push({ compId, p });
    }
  } finally { await sa.dispose(); }
  const read = async (p, compId) => {
    const L = await apiLogin(p.email);
    try {
      const r = await L.api.post("/api/select-competition", { headers: H(L.csrf), data: { competitionId: compId } });
      expect(r.ok(), `select: ${await r.text()}`).toBeTruthy();
      const one = (await (await L.api.get("/api/participant/pulse")).json()).lb_version;
      const two = (await (await L.api.get("/api/participant/pulse")).json()).lb_version;
      expect(two, "CONTROL: unchanged state, the same token").toBe(one);
      return one;
    } finally { await L.api.dispose(); }
  };
  const v1 = await read(pairs[0].p, pairs[0].compId);
  const v2 = await read(pairs[1].p, pairs[1].compId);
  for (const v of [v1, v2]) {
    expect(v, "a fixed-length base64url token").toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(v, "no counter in the clear: not a number, no epoch.counter pair").not.toMatch(/^[\d.]+$/);
  }
  expect(v2, "the same count in two events reads differently").not.toBe(v1);
});

test("the pulse is a poll: it does not slide the session, and anonymous callers get 401", async () => {
  const A = await enter(fx.a);
  try {
    const exp1 = (await (await A.api.get("/api/participant/pulse")).json()).session.expires_at;
    await new Promise(r => setTimeout(r, 1100));
    const res = await A.api.get("/api/participant/pulse");
    expect(res.headers()["set-cookie"] || "", "a GET poll re-sends no session cookie").not.toMatch(/Expires=/i);
    expect((await res.json()).session.expires_at, "the stored expiry did not move").toBe(exp1);
    // CONTROL: a keepalive (a write) does slide it.
    const ka = await A.api.post("/api/session/keepalive", { headers: H(A.csrf) });
    expect(ka.ok()).toBeTruthy();
    expect((await (await A.api.get("/api/participant/pulse")).json()).session.expires_at, "CONTROL: the keepalive slid it").not.toBe(exp1);
  } finally { await A.api.dispose(); }
  const { api: anon } = await freshCtx();
  try {
    expect((await anon.get("/api/participant/pulse")).status()).toBe(401);
  } finally { await anon.dispose(); }
});
