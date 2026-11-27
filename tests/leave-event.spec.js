// v8.1.0 — "Leave this event": self-service un-enrolment.
//
// The walk-up case: someone scans the wrong QR at a busy stand, or joins to look
// and decides not to take part. Without this their only remedy is to find an
// organiser — and at a Booth Event with a ceiling they are also holding a place
// somebody else wants.
//
// THE LOAD-BEARING DECISION IS THE SCOPING. Only a membership the participant
// created themselves (`assigned_by='self_enroll'`) can be left. A participant an
// ADMIN assigned must not be able to remove themselves: that is not self-service,
// it is silently undoing someone else's decision on a cohort the organiser
// believes is enrolled.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `lv${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeEvent(api, csrf, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Ev`, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true, ...extra,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const rv = await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
  return { comp, token: rv.token };
}

async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Leave", lastName: "Tester", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

const myComps = async (api) => (await (await api.get("/api/my-competitions")).json()).competitions
  || (await (await api.get("/api/my-competitions")).json());

test.describe("v8.1.0 — Leave this event", () => {
  test("a SELF-ENROLLED participant can leave, and can re-join afterwards", async () => {
    // v8.2.2 — this used to prove "leaving frees the place" against a ceiling of
    // 1. The self-enrolment ceiling is removed, so there is no place to free and
    // that framing is gone. What it actually needs to prove is unchanged and is
    // now asserted directly: the membership really ends, and the door is still
    // open afterwards — leaving must not be a one-way door for someone who
    // scanned the wrong QR, which is the whole reason this feature exists.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);

    const a = await makeParticipant(api, csrf);
    const actx = await signIn(a.email);
    expect((await actx.api.post("/api/competitions/join", { headers: H(actx.csrf), data: { token: ev.token } })).status()).toBe(200);
    expect((await myComps(actx.api)).map(c => c.id), "precondition: they are a member").toContain(ev.comp.id);

    const leave = await actx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(actx.csrf) });
    expect(leave.status(), `leave: ${await leave.text()}`).toBe(200);

    // The leaver is really gone from their own list.
    const mine = await myComps(actx.api);
    expect(mine.map(c => c.id), "no longer a member").not.toContain(ev.comp.id);

    // And the same token still works — the departure is not a ban.
    const again = await actx.api.post("/api/competitions/join", { headers: H(actx.csrf), data: { token: ev.token } });
    expect(again.status(), `re-join after leaving: ${await again.text()}`).toBe(200);
    expect((await myComps(actx.api)).map(c => c.id), "a member again").toContain(ev.comp.id);
  });

  test("an ADMIN-ASSIGNED participant is REFUSED — self-service is not undoing an organiser", async () => {
    // The scoping decision, and the control that makes every other test in this
    // file meaningful: without it, "a participant can leave" would be satisfied
    // by a build that lets anyone walk out of a cohort they were placed in.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { competitionIds: [ev.comp.id], userIds: [u.id] },
    });
    expect((await asg.json()).assigned, "precondition: assigned by an admin").toBe(1);

    const ctx = await signIn(u.email);
    const r = await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) });
    const body = await r.json().catch(() => ({}));
    expect(r.status(), `must be refused: ${JSON.stringify(body)}`).toBe(403);
    expect(body.code).toBe("not_self_enrolled");
    expect(body.error, "and it names who CAN do it").toMatch(/organiser/i);

    // Still enrolled — a refusal that removed them anyway is the worst outcome
    // and the status code alone cannot see it.
    expect((await myComps(ctx.api)).map(c => c.id), "still a member").toContain(ev.comp.id);
  });

  test("the wire says which events can be left, and the route agrees", async () => {
    // The affordance and the outcome come from one predicate, so the button can
    // never be offered for something the server will refuse (v7.14.2).
    const { api, csrf } = await sa();
    const selfEv = await makeEvent(api, csrf);
    const adminEv = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);

    const ctx = await signIn(u.email);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: selfEv.token } })).status()).toBe(200);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [adminEv.comp.id], userIds: [u.id] } });

    const mine = await myComps(ctx.api);
    const self = mine.find(c => c.id === selfEv.comp.id);
    const admin = mine.find(c => c.id === adminEv.comp.id);
    expect(self, "the self-enrolled event is listed").toBeTruthy();
    expect(admin, "the assigned event is listed").toBeTruthy();
    expect(self.can_leave, "self-enrolled → leavable").toBe(true);
    expect(admin.can_leave, "admin-assigned → NOT leavable").toBe(false);
  });

  test("a FINISHED event cannot be left — a settled result set is not edited from the participant side", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);

    // A second enrollee who never solves, so the all-solved auto-end cannot fire
    // and change the reason this event ends (fixture checklist item 1).
    const other = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [ev.comp.id], userIds: [other.id] } });

    const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === ev.comp.id);
    const end = await api.post(`/api/admin/competitions/${ev.comp.id}/end-now`, {
      headers: H(csrf), data: { expectedUpdatedAt: row.updated_at },
    });
    expect(end.ok(), `end: ${await end.text()}`).toBeTruthy();

    const r = await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) });
    const body = await r.json().catch(() => ({}));
    expect(r.status(), `must be refused: ${JSON.stringify(body)}`).toBe(409);
    expect(body.code).toBe("ended");
    // ...and the wire says so too, so nothing offers the button.
    const mine = await myComps(ctx.api);
    expect(mine.find(c => c.id === ev.comp.id)?.can_leave, "an ended event is not leavable").toBe(false);
  });

  test("THE SCORE SURVIVES — leaving and re-joining is lossless", async () => {
    // This is what makes the confirm copy true. It reuses the absence-row path,
    // which preserves submissions and hint reveals; re-implementing the removal
    // would have been a second definition of it, and this is the assertion that
    // would catch one.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published" },
    });
    const taskId = (await tr.json()).id;
    await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [ev.comp.id] } });

    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);
    // A second enrollee who never solves, so solving everything does not auto-end
    // the event underneath the test.
    const other = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [ev.comp.id], userIds: [other.id] } });

    expect((await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: ev.comp.id } })).ok()).toBeTruthy();
    const view = await (await ctx.api.get(`/api/tasks/${taskId}`)).json();
    const sub = await ctx.api.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": ctx.csrf },
      multipart: { answer: "right", gradingHash: view.grading_hash || "" },
    });
    const solved = await sub.json();
    expect(solved.correct, `solve: ${JSON.stringify(solved)}`).toBe(true);
    const scoreBefore = solved.score;
    expect(scoreBefore, "a real score").toBeGreaterThan(0);

    expect((await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) })).status()).toBe(200);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);
    expect((await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: ev.comp.id } })).ok()).toBeTruthy();

    const me = await (await ctx.api.get("/api/me")).json();
    expect(me.score, "the score survived the round trip").toBe(scoreBefore);
    const back = await (await ctx.api.get(`/api/tasks/${taskId}`)).json();
    expect(back.solved, "and the challenge is still solved").toBeTruthy();
  });

  test("leaving is recorded on the participant's History as SELF-service", async () => {
    // An organiser reading the trail must be able to tell a participant walking
    // out from a removal they or a colleague performed — the two are otherwise
    // indistinguishable, and one of them is a support question.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);
    expect((await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) })).status()).toBe(200);

    const ev1 = await (await api.get(`/api/admin/participants/${u.id}/events?limit=100`)).json();
    const rows = (ev1.events || ev1).filter(e => e.event_type === "removed_from_competition");
    expect(rows.length, "the departure is recorded").toBeGreaterThan(0);
    const blob = JSON.stringify(rows);
    expect(blob, 'attributed as via:"self"').toContain('"via":"self"');
    expect(blob, "and to the participant, not an organiser").toContain(u.email);
  });

  test("a participant who is not a member gets a plain refusal", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    const r = await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toMatch(/not in this event/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 — LEAVE + REJOIN MUST NOT RESET THE SOLVE CLOCK.
//
// Every removal DELETEs the `competition_users` row, which destroys
// `login_time` — the anchor `solveTimeMs` measures from, and time-to-solve is
// the SOLE tie-breaker on a score tie. Any re-add re-inserted with
// `login_time IS NULL`, and the lazy stamp (`_stampLoginTimeIfLive`, guarded on
// exactly that NULL) re-anchored the clock to the REJOIN moment on the next
// request. `buildLeaderboardEntries` clamps each absence to [loginMs, refEndMs],
// so with the anchor moved forward the whole pre-removal period falls outside
// the window and is excluded — and for a FINISHER `refEndMs` is their last
// correct submission, which now PRECEDES the anchor, so the subtraction goes
// negative and is clamped to 0: the best possible value on the tie-break.
//
// Self-service leave (this file) turned that into two API calls.
//
// The fix records the anchor on the absence row and restores it on re-add
// (`closeAbsenceAndRestoreAnchor`, lib/competitions.js). THE DISCRIMINATING
// MUTATION FOR BOTH TESTS BELOW IS DROPPING THAT RESTORE — i.e. leaving the
// helper as the bare `UPDATE … SET returned_at=?` it replaced. The exploit test
// then sees solveTimeMs 0 and a stolen first place; the innocent test sees a
// clock that restarts at the rejoin.
const _ADMIN_BOARD = (api, compId) => api.get(`/api/admin/leaderboard?competitionId=${compId}`).then(r => r.json());
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
// `_leaderboardCache` has a 5 s TTL and this file reads the board across writes
// that do not all bust it, so wait it out rather than asserting on a snapshot
// taken before the rejoin. Cheaper than making every read a poll, and a poll
// would be VACUOUS here anyway: the pre-leave value already satisfies
// "solveTimeMs > 0", so an early-returning poll could pass on stale data.
const _LB_TTL_MS = 5_200;

async function makeTask(api, csrf, compId, answer) {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: answer, status: "published" },
  });
  expect(r.ok(), `task create: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).id;
  const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(asg.ok(), `task assign: ${await asg.text()}`).toBeTruthy();
  return id;
}

// The grading token from GET /api/tasks/:id is REQUIRED on submit (v7.20.9 F1),
// so a hand-built submit without one is 409 `task_changed` and never grades.
async function solve(ctx, taskId, answer) {
  const view = await (await ctx.api.get(`/api/tasks/${taskId}`)).json();
  const r = await ctx.api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": ctx.csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  const d = await r.json();
  expect(d.correct, `solve ${taskId}: ${JSON.stringify(d)}`).toBe(true);
  return d;
}

const joinAndEnter = async (ctx, ev) => {
  expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);
  // select-competition on a LIVE event is what stamps the anchor.
  expect((await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: ev.comp.id } })).ok()).toBeTruthy();
};

test.describe("v8.1.0 — leave+rejoin preserves the solve-clock anchor", () => {
  test("a FINISHER cannot leave-and-rejoin their way to a better time-to-solve", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const taskId = await makeTask(api, csrf, ev.comp.id, "right");

    // The RIVAL enters and finishes immediately; the EXPLOITER enters and
    // finishes measurably later. Same score, so time-to-solve is the ONLY thing
    // separating them — which is exactly the tie-break being defended.
    const rival = await makeParticipant(api, csrf);
    const rctx = await signIn(rival.email);
    await joinAndEnter(rctx, ev);
    await solve(rctx, taskId, "right");

    const exploiter = await makeParticipant(api, csrf);
    const ectx = await signIn(exploiter.email);
    await joinAndEnter(ectx, ev);
    await _sleep(1500);                       // the exploiter is genuinely slower
    await solve(ectx, taskId, "right");

    // Precondition: self-enrolment being open SUPPRESSES the all-solved auto-end
    // (v7.7.18), so the event is still live with everybody finished. Assert it,
    // because an ended event would change refEndMs and the test would be
    // measuring something else.
    const compRow = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === ev.comp.id);
    expect(compRow.status, "precondition: self-enrol suppresses the all-solved auto-end").not.toBe("ended");

    await _sleep(_LB_TTL_MS);
    const before = await _ADMIN_BOARD(api, ev.comp.id);
    const rB = before.find(u => u.userId === rival.id);
    const eB = before.find(u => u.userId === exploiter.id);
    expect(rB && eB, "both are on the board").toBeTruthy();
    expect(eB.score, "precondition: identical scores, so only time separates them").toBe(rB.score);
    expect(rB.allSolved && eB.allSolved, "precondition: both are finishers").toBeTruthy();
    expect(eB.solveTimeMs, "precondition: the exploiter really is the slower one").toBeGreaterThan(rB.solveTimeMs);
    expect(rB.rank, "precondition: the honest order is rival first").toBeLessThan(eB.rank);

    // THE EXPLOIT: leave, rejoin, and touch a competition-scoped endpoint so the
    // lazy stamp fires. Pre-fix this re-anchors the clock AFTER the exploiter's
    // own finish time, so solveTimeMs goes negative, clamps to 0, and takes
    // first place — with the badge and the certificate attached to it.
    expect((await ectx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ectx.csrf) })).status()).toBe(200);
    await joinAndEnter(ectx, ev);
    expect((await ectx.api.get("/api/status")).ok(), "a request that fires the lazy stamp").toBeTruthy();

    await _sleep(_LB_TTL_MS);
    const after = await _ADMIN_BOARD(api, ev.comp.id);
    const rA = after.find(u => u.userId === rival.id);
    const eA = after.find(u => u.userId === exploiter.id);
    expect(eA, "the exploiter is back on the board").toBeTruthy();

    // The sharpest assertion: pre-fix this is EXACTLY 0 (a negative window
    // clamped), which is the best value the tie-break can hold.
    expect(eA.solveTimeMs, "the solve clock did not restart at the rejoin").toBeGreaterThan(0);
    // Their real time survives the round trip — the absence falls entirely after
    // their finish, so it is clamped out and subtracts nothing.
    expect(eA.solveTimeMs, "the exploiter's honest time is preserved").toBeGreaterThanOrEqual(eB.solveTimeMs - 500);
    expect(eA.score, "and their score is untouched").toBe(eB.score);
    // ...and the consequence that actually matters.
    expect(eA.solveTimeMs, "still slower than the rival").toBeGreaterThan(rA.solveTimeMs);
    expect(rA.rank, "first place is not stolen by leaving and rejoining").toBeLessThan(eA.rank);
  });

  test("an INNOCENT leave+rejoin keeps the original anchor and still excludes the gap", async () => {
    // POSITIVE CONTROL. Without it, "leaving gives no advantage" is equally
    // satisfied by a build that never restores the anchor at all — or by one
    // that restores it and then forgets to close the absence, silently
    // re-charging the participant for time they had no access.
    //
    // A NON-finisher, so refEndMs is `now` and the clock is still running: that
    // is the only shape in which the anchor and the gap are BOTH observable.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const t1 = await makeTask(api, csrf, ev.comp.id, "one");
    await makeTask(api, csrf, ev.comp.id, "two");   // deliberately left unsolved

    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    const anchorWallMs = Date.now();
    await joinAndEnter(ctx, ev);
    await solve(ctx, t1, "one");
    await _sleep(2000);                              // real time competing

    await _sleep(_LB_TTL_MS);
    const beforeEntry = (await _ADMIN_BOARD(api, ev.comp.id)).find(e => e.userId === u.id);
    expect(beforeEntry, "on the board before leaving").toBeTruthy();
    expect(beforeEntry.allSolved, "precondition: NOT a finisher, so the clock is still running").toBeFalsy();
    const beforeMs = beforeEntry.solveTimeMs;
    expect(beforeMs, "precondition: a real elapsed time").toBeGreaterThan(2000);

    expect((await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) })).status()).toBe(200);
    const gapStart = Date.now();
    await _sleep(2500);                              // the no-access gap
    await joinAndEnter(ctx, ev);
    const gapMs = Date.now() - gapStart;
    expect((await ctx.api.get("/api/status")).ok()).toBeTruthy();

    await _sleep(_LB_TTL_MS);
    const afterEntry = (await _ADMIN_BOARD(api, ev.comp.id)).find(e => e.userId === u.id);
    expect(afterEntry, "back on the board").toBeTruthy();
    const afterMs = afterEntry.solveTimeMs;
    const rawElapsed = Date.now() - anchorWallMs;

    // HALF ONE — the anchor survived. Pre-fix the clock restarts at the rejoin,
    // so this collapses to roughly the few hundred ms since then.
    expect(afterMs, "the clock did not restart at the rejoin").toBeGreaterThanOrEqual(beforeMs);
    // HALF TWO — the no-access gap is still excluded, which is the documented
    // remove+re-add invariant and the reason the absence row exists at all. A
    // build that restored the anchor but stopped closing the absence would leave
    // this at the full raw elapsed.
    expect(afterMs, "the no-access gap is excluded").toBeLessThan(rawElapsed - (gapMs * 0.5));
  });
});
