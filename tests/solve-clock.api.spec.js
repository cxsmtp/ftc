// @ts-check
//
// v7.21.3 — THE SOLVE CLOCK: where it starts, and that it can never run backwards.
//
// `competition_users.login_time` is what `solveTimeMs` measures from, and
// time-to-solve is the SOLE tie-breaker on a score tie (`sortLeaderboard`).
// Two defects, one subject:
//
//  1. THE ANCHOR WAS NEVER SET ON THE LOBBY PATH. login_time was written by
//     three statements, all in select-competition / select-timeslot and all
//     gated on the entity being live AT THE MOMENT OF THAT CALL. Picking an
//     UPCOMING competition stamps nothing; status is TIME-DERIVED, so nothing
//     requests anything when it flips; and the pending page's 1-second tick
//     navigates to the tasks page and clears the 15 s poll that would have
//     re-selected. So the lobby-waiter's clock fell through to
//     COALESCE(login_time, first submission/hint) — it started at their first
//     ATTEMPT, rewarding the time they spent reading. Two participants with the
//     same score and the same finish time got different times purely from how
//     they navigated in. `_stampLoginTimeIfLive` (lib/middleware.js) now anchors
//     it on the first competition-scoped request while the entity is live.
//
//  2. A NEGATIVE DURATION COULD LEAVE THE SERVER. `solveTimeMs = refEndMs -
//     loginMs` was clamped to >= 0 only inside the `gapMs > 0` branch, so a
//     refEnd EARLIER than login stayed negative and rendered as a negative
//     time-to-solve on the board and in the placement card. NOTE the clamp is a
//     floor on the VALUE, not a re-ranking: a zero-window participant still
//     sorts as "fastest", because for unfinished participants a shorter window
//     is already a better tie-break by design. Changing THAT would be a scoring
//     -semantics change and is deliberately out of scope.
//
// The two interact, which is why they ship together: the lazy stamp is itself a
// way to acquire a login_time later than your own finish time.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

function withDb(fn) {
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

const cuRow = (compId, userId) => withDb(d =>
  d.prepare("SELECT login_time, last_login_time FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));

async function createComp(api, csrf, name, startOffsetMs, durationMin = 180) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name, start_time: new Date(Date.now() + startOffsetMs).toISOString(), duration_minutes: durationMin },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).competition.id;
}

async function createTask(api, csrf, title) {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
            correct_answer: "yes", explanation: "<p>e</p>", hint: "h", status: "published" },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).id;
}

/** A dedicated verified+approved participant (v7.15.32: never mutate a shared fixture). */
async function makeParticipant(api, csrf, tag) {
  const email = `clock-${tag}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: { firstName: "Clock", lastName: "Probe", nickname: `clk_${tag}`, email,
            company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
            password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" },
  });
  expect(reg.status(), await reg.text()).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, "the fresh participant must be findable").toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { email, id: u.id };
}

async function assignUsers(api, csrf, userIds, compId) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds, competitionIds: [compId] },
  });
  expect(r.status(), await r.text()).toBe(200);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The lobby path anchors the clock.
// ─────────────────────────────────────────────────────────────────────────────

test("v7.21.3: selecting an UPCOMING competition leaves the clock unset, and the first live request anchors it", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const tag = uniq();
  // Starts 3 s out: genuinely UPCOMING at select time, LIVE a moment later —
  // the real lobby path, not a simulation of it.
  const compId = await createComp(api, csrf, `Clock Lobby ${tag}`, 3000, 180);
  const taskBank = await createTask(api, csrf, `Clock Task ${tag}`);
  const taskAssign = await api.post(`/api/admin/tasks/${taskBank}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(taskAssign.ok(), await taskAssign.text()).toBeTruthy();
  const task = (await taskAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is answered there
  const p = await makeParticipant(api, csrf, tag);
  await assignUsers(api, csrf, [p.id], compId);
  await api.dispose();

  const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    // Pick it while UPCOMING. This is the state the whole defect lives in.
    const sel = await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
    expect(sel.status(), await sel.text()).toBe(200);
    expect(cuRow(compId, p.id).login_time,
      "an upcoming pick must NOT anchor the clock — that is correct and unchanged"
    ).toBeNull();

    // Wait out the countdown, exactly as the participant does.
    await expect.poll(async () => {
      const r = await pa.get("/api/status");
      return r.ok() ? (await r.json()).status : "err";
    }, { timeout: 15000, intervals: [250, 500, 750, 1000] }).toBe("live");

    // THE FIX: the first competition-scoped request while live anchors it.
    const row = cuRow(compId, p.id);
    expect(row.login_time,
      "the first live request must anchor the solve clock — otherwise solveTimeMs falls back to the first SUBMISSION and the lobby-waiter gets a shorter tie-break clock than someone who clicked in at the start"
    ).toBeTruthy();
    expect(row.last_login_time, "last_login_time is stamped alongside it").toBeTruthy();

    // The anchor is EARLIER than the first attempt — the whole point.
    const anchoredAt = Date.parse(row.login_time);
    const gradingHash = await gradingHashFor(pa, task);
    const sub = await pa.post(`/api/tasks/${task}/submit`, { headers: H(pc), data: { answer: "yes", gradingHash } });
    expect(sub.status(), await sub.text()).toBe(200);
    const firstSubmitAt = withDb(d => Date.parse(
      d.prepare("SELECT submitted_at FROM submissions WHERE task_id=? AND user_id=?").get(task, p.id).submitted_at));
    expect(anchoredAt,
      "the clock must start when they ENTERED, not when they first attempted"
    ).toBeLessThanOrEqual(firstSubmitAt);

    // Idempotent: a later request must not re-anchor and shorten the clock.
    await pa.get("/api/status");
    expect(cuRow(compId, p.id).login_time, "the anchor is written once").toBe(row.login_time);
  } finally { await pa.dispose(); }
});

test("v7.21.3: an ALREADY-anchored clock is never moved, and a non-live competition never anchors", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const tag = uniq();
  // POSITIVE CONTROL for the negative below: a live comp DOES anchor, so the
  // "upcoming never anchors" assertion cannot pass on a dead mechanism.
  const liveId = await createComp(api, csrf, `Clock Live ${tag}`, -60_000, 180);
  const upcomingId = await createComp(api, csrf, `Clock Upcoming ${tag}`, 60 * 60_000, 180);
  const p = await makeParticipant(api, csrf, `n${tag}`);
  await assignUsers(api, csrf, [p.id], liveId);
  await assignUsers(api, csrf, [p.id], upcomingId);
  await api.dispose();

  const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: liveId } });
    await pa.get("/api/status");
    const anchored = cuRow(liveId, p.id).login_time;
    expect(anchored, "control: a live competition anchors").toBeTruthy();

    await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: upcomingId } });
    // /api/status on an upcoming comp is allowed; it must not anchor.
    await pa.get("/api/status");
    expect(cuRow(upcomingId, p.id).login_time,
      "an UPCOMING competition must never anchor the clock"
    ).toBeNull();

    // Re-enter the live one: the original anchor must survive.
    await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: liveId } });
    await pa.get("/api/status");
    expect(cuRow(liveId, p.id).login_time, "re-entry must not move the anchor").toBe(anchored);
  } finally { await pa.dispose(); }
});

test("v7.21.3: IMPERSONATION does not start the target's clock", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const tag = uniq();
  const compId = await createComp(api, csrf, `Clock Imp ${tag}`, -60_000, 180);
  const taskBank = await createTask(api, csrf, `Clock Imp Task ${tag}`);
  const taskAssign = await api.post(`/api/admin/tasks/${taskBank}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(taskAssign.ok(), await taskAssign.text()).toBeTruthy();
  const task = (await taskAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is answered there
  const p = await makeParticipant(api, csrf, `i${tag}`);
  await assignUsers(api, csrf, [p.id], compId);

  // Impersonate and browse the target's live competition.
  const imp = await api.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(csrf) });
  expect(imp.status(), await imp.text()).toBe(200);
  const csrf2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf2), data: { competitionId: compId } });
  expect(sel.status(), await sel.text()).toBe(200);
  const st = await api.get("/api/status");
  expect(st.status(), "the impersonating admin can read the target's status").toBe(200);

  expect(cuRow(compId, p.id).login_time,
    "peeking must NEVER start the participant's solve clock — v7.14.0 suppresses exactly this on the select path, and the lazy anchor must honour it too"
  ).toBeNull();
  await api.post("/api/impersonation/exit", { headers: H(csrf2) }).catch(() => {});
  await api.dispose();

  // CONTROL: the participant's own first live request DOES anchor it, so the
  // assertion above cannot be satisfied by an anchor that never works.
  const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
    await pa.get("/api/status");
    expect(cuRow(compId, p.id).login_time, "control: the real participant anchors it").toBeTruthy();
  } finally { await pa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A negative time can never out-rank a real one.
// ─────────────────────────────────────────────────────────────────────────────

test("v7.21.3: a login_time later than the reference end yields 0, never a negative duration", async () => {
  // v8.12.4 — driven through the REAL path rather than a forged anchor. An
  // admin shrinking a live event's duration so its scheduled end falls before
  // somebody's entry is ordinary (the shrink-to-past detector, v6.16.6), and it
  // leaves that participant's anchor AFTER the event's effective end: refEnd -
  // login is negative with nobody writing to the database. The first draft of
  // this test planted a post-end anchor directly and claimed the shrink in a
  // comment; the shrink is now what produces it.
  const { api, csrf } = await apiLogin("superadmin");
  const tag = uniq();
  const compId = await createComp(api, csrf, `Clock Neg ${tag}`, -120 * 60_000, 180);
  const taskBank = await createTask(api, csrf, `Clock Neg Task ${tag}`);
  const taskAssign = await api.post(`/api/admin/tasks/${taskBank}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(taskAssign.ok(), await taskAssign.text()).toBeTruthy();
  const task = (await taskAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is answered there

  const early = await makeParticipant(api, csrf, `f${tag}`);  // entered long before the new end
  const late = await makeParticipant(api, csrf, `b${tag}`);   // enters now, i.e. after the new end
  await assignUsers(api, csrf, [early.id, late.id], compId);

  // Both enter and neither solves, so scores tie at 0 and TIME decides — the
  // only condition under which the clamp can change an ordering.
  for (const who of [early, late]) {
    const { api: pa, csrf: pc } = await apiLogin(who.email, PARTICIPANT_PASS);
    await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
    await pa.get("/api/status");
    await pa.dispose();
  }
  const anchors = () => Object.fromEntries(withDb(d => d.prepare(
    "SELECT user_id, login_time FROM competition_users WHERE competition_id=?").all(compId)).map(r => [r.user_id, r.login_time]));
  expect(anchors()[late.id], "PRECONDITION: the late participant's clock started when they entered").toBeTruthy();
  // The control entered 90 minutes ago — a real state (it only needs somebody to
  // have arrived earlier), set here because the suite has no clock control.
  withDb(d => d.prepare("UPDATE competition_users SET login_time=? WHERE competition_id=? AND user_id=?")
    .run(new Date(Date.now() - 90 * 60_000).toISOString(), compId, early.id));

  // The admin shrinks the event to 60 minutes: its scheduled end is now an hour
  // ago, BEFORE the late participant's anchor and after the early one's.
  const shrink = await api.put(`/api/admin/competitions/${compId}`, { headers: H(csrf), data: { duration_minutes: 60 } });
  expect(shrink.ok(), `shrink: ${shrink.status()} ${await shrink.text()}`).toBeTruthy();
  expect(new Date(anchors()[late.id]).getTime(), "PRECONDITION: the late anchor now lies after the scheduled end")
    .toBeGreaterThan(Date.now() - 60 * 60_000);

  const rows = await (await api.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
  const board = Array.isArray(rows) ? rows : (rows.board || []);
  const b = board.find(e => e.userId === late.id || e.user_id === late.id);
  const f = board.find(e => e.userId === early.id || e.user_id === early.id);
  expect(b, "the late participant must be on the board").toBeTruthy();
  expect(f, "the control participant must be on the board").toBeTruthy();

  expect(b.solveTimeMs,
    "a negative duration must never reach the payload — it renders as a negative time-to-solve on the board and in the participant's own placement card"
  ).toBe(0);
  // Every row, not just this one: the clamp is a floor on the whole build.
  for (const e of board) {
    expect(e.solveTimeMs === null || e.solveTimeMs >= 0,
      `every solveTimeMs must be non-negative (saw ${e.solveTimeMs})`).toBe(true);
  }
  // SCOPE, stated so nobody later reads this test as promising more than it does:
  // the clamp is a floor on the VALUE, not a change to the tie-break. A
  // zero-window participant still sorts as "fastest", because for unfinished
  // participants a shorter window already means a better tie-break by design
  // (documented semantics). Re-ranking them would be a scoring-behaviour change,
  // deliberately out of scope here. What is fixed is that an impossible
  // measurement can no longer leave the server as a negative number.
  expect(f.solveTimeMs, "the control keeps a real window: 30 minutes, from entry to the new end").toBeGreaterThan(25 * 60_000);
  expect(f.solveTimeMs).toBeLessThan(35 * 60_000);
  await api.dispose();
});
