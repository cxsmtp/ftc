// @ts-check
//
// ext-audit v7.21.1 — THE ENDED-SESSION SCORING FREEZE, in one place.
//
// `taskFrozenByEndedCompetition(taskId)` (lib/competitions.js) is now the ONE
// definition of "this challenge's scoring is frozen", and five writers to the
// `tasks` table consult it. Before this release they implemented that rule four
// different ways:
//
//   PATCH /api/admin/tasks/:id/visibility   no guard at all      → 409
//   POST  /api/admin/tasks/:id/publish      no guard at all      → 409
//   PUT   /api/admin/tasks/:id              froze correct_answer /
//                                           answer_type /
//                                           difficulty, NOT `active`
//                                                                → `active` joins
//   POST  /api/admin/import/tasks (overwrite)  no guard at all   → row SKIPPED
//   POST  /api/admin/tasks/:id/recalculate  no competition scope → frozen comps'
//                                                                 rows left alone,
//                                                                 counted as
//                                                                 frozen_skipped
//
// WHY IT MATTERS, and why the first test below reaches around the guard rather
// than only asserting an error string: `buildLeaderboardEntries` counts
// `totalTasks` with `t.active=1 AND t.status='published'`, so hiding or
// unpublishing a challenge SHRINKS the all-solved denominator. `allSolved`
// shapes `solveTimeMs` (a finisher's window ends at their finish time; an
// unfinished participant's at the competition's effective end), and
// time-to-solve is the SOLE tie-breaker on a score tie. So the scores do not
// move — the RANKS do, on a competition whose standings are supposed to be
// final. A test that only asserted "409" would pass just as happily against a
// guard defending nothing.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const { withLegacySharedAssign } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const MIN = 60_000;

// ── fixture helpers ──────────────────────────────────────────────────────────

async function createComp(api, csrf, name, startOffsetMs, durationMin) {
  const start = new Date(Date.now() + startOffsetMs).toISOString();
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf), data: { name, start_time: start, duration_minutes: durationMin },
  });
  expect(r.status(), await r.text()).toBe(200);
  return { id: (await r.json()).competition.id, startMs: Date.parse(start) };
}

async function createTask(api, csrf, title, difficulty = "easy", correct = "yes") {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf), data: {
      title, description: "<p>d</p>", difficulty, answer_type: "text",
      correct_answer: correct, explanation: "<p>e</p>", hint: "hint", status: "published",
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).id;
}

/** Assign; answers the question the event now holds — its OWN copy of a bank question (lib/event-copies.js). */
async function assignTask(api, csrf, taskId, compId) {
  const r = await api.post(`/api/admin/tasks/${taskId}/competitions`, {
    headers: H(csrf), data: { competitionIds: [compId] },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).copies[0].task_id;
}

async function assignUsers(api, csrf, userIds, compId) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds, competitionIds: [compId] },
  });
  expect(r.status(), await r.text()).toBe(200);
}

async function endNow(api, csrf, compId) {
  const r = await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) });
  expect(r.status(), await r.text()).toBe(200);
}

/** Log a seeded participant in, enter `compId`, and submit each {id, answer}. */
async function solveAs(email, compId, answers) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  let r = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(r.status(), await r.text()).toBe(200);
  for (const a of answers) {
    const gradingHash = await gradingHashFor(api, a.id);
    r = await api.post(`/api/tasks/${a.id}/submit`, {
      headers: H(csrf), data: { answer: a.answer, gradingHash },
    });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).correct, `${email} should have solved ${a.id}`).toBe(true);
  }
  await api.dispose();
}

async function participants(api) {
  const r = await api.get("/api/admin/participants?limit=200");
  return (await r.json()).participants || [];
}

async function board(api, compId) {
  const r = await api.get(`/api/admin/leaderboard?competitionId=${compId}`);
  expect(r.status(), await r.text()).toBe(200);
  return await r.json();
}

function withDb(fn) {
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE LOAD-BEARING ONE — the harm is real, and the guard is what stops it.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.1: hiding a challenge in an ENDED competition re-orders its final ranks — and the visibility guard refuses to", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const all = await participants(api);
  const alice = all.find(p => p.email === "alice@acme.com");
  const bob = all.find(p => p.email === "bob@acme.com");
  expect(alice && bob, "seeded alice + bob must exist").toBeTruthy();

  // A live competition with THREE published challenges. Both participants solve
  // the same TWO (identical scores, 50 + 50), and neither solves the third — so
  // while all three count, NOBODY is allSolved.
  const comp = await createComp(api, csrf, "FZ-harm", -180 * MIN, 300);
  // The event's own copies: what is solved, frozen and (attempted to be) hidden.
  const tA = await assignTask(api, csrf, await createTask(api, csrf, "FZ-harm-A", "easy", "aaa"), comp.id);
  const tB = await assignTask(api, csrf, await createTask(api, csrf, "FZ-harm-B", "easy", "bbb"), comp.id);
  const tC = await assignTask(api, csrf, await createTask(api, csrf, "FZ-harm-C", "easy", "ccc"), comp.id);
  await assignUsers(api, csrf, [alice.id, bob.id], comp.id);

  await solveAs("alice@acme.com", comp.id, [{ id: tA, answer: "aaa" }, { id: tB, answer: "bbb" }]);
  await solveAs("bob@acme.com", comp.id, [{ id: tA, answer: "aaa" }, { id: tB, answer: "bbb" }]);

  // Reshape the clock so the two ORDERINGS disagree. Alice entered early and
  // finished fast (10 min of work); Bob entered an hour late and took 50.
  //   • nobody allSolved  → window ends at the competition's end, so the LATE
  //     entrant has the shorter window: Bob first.
  //   • everybody allSolved → window ends at each one's own finish, so the FAST
  //     solver has the shorter window: Alice first.
  // Same scores in both cases. That is the whole defect in two rows.
  const iso = (ms) => new Date(ms).toISOString();
  withDb(db => {
    db.prepare("UPDATE competition_users SET login_time=? WHERE competition_id=? AND user_id=?")
      .run(iso(comp.startMs + 1 * MIN), comp.id, alice.id);
    db.prepare("UPDATE submissions SET submitted_at=? WHERE competition_id=? AND user_id=?")
      .run(iso(comp.startMs + 11 * MIN), comp.id, alice.id);
    db.prepare("UPDATE competition_users SET login_time=? WHERE competition_id=? AND user_id=?")
      .run(iso(comp.startMs + 60 * MIN), comp.id, bob.id);
    db.prepare("UPDATE submissions SET submitted_at=? WHERE competition_id=? AND user_id=?")
      .run(iso(comp.startMs + 110 * MIN), comp.id, bob.id);
  });

  await endNow(api, csrf, comp.id);

  // Baseline: the FINAL standings of a finished competition.
  const before = await board(api, comp.id);
  const rowsBefore = before.filter(r => [alice.id, bob.id].includes(r.userId));
  expect(rowsBefore).toHaveLength(2);
  const byId = (rows) => Object.fromEntries(rows.map(r => [r.userId, r]));
  const b0 = byId(rowsBefore);
  expect(b0[alice.id].score, "equal scores are the premise — time is the SOLE tie-breaker").toBe(b0[bob.id].score);
  expect(b0[alice.id].score).toBe(100);
  expect(b0[alice.id].allSolved).toBe(false);
  expect(b0[bob.id].allSolved).toBe(false);
  expect(b0[bob.id].rank, "the late entrant leads while nobody is allSolved").toBe(1);
  expect(b0[alice.id].rank).toBe(2);

  // (a) The guard refuses the flip.
  const patch = await api.patch(`/api/admin/tasks/${tC}/visibility`, { headers: H(csrf) });
  expect(patch.status(), await patch.text()).toBe(409);
  expect((await patch.json()).error).toMatch(/ended session|frozen/i);
  expect(withDb(db => db.prepare("SELECT active FROM tasks WHERE id=?").get(tC).active),
    "a refused flip must not half-apply").toBe(1);

  // (b) …and that refusal is not decorative. Reach AROUND it — flip `active`
  // straight in the database, exactly what the route would have done — and the
  // finished competition's ranks move.
  withDb(db => db.prepare("UPDATE tasks SET active=0 WHERE id=?").run(tC));

  // The leaderboard cache has a 5 s TTL and there is no API to bust it, so poll.
  let flipped = null;
  await expect.poll(async () => {
    const rows = (await board(api, comp.id)).filter(r => [alice.id, bob.id].includes(r.userId));
    flipped = byId(rows);
    return flipped[alice.id] ? flipped[alice.id].rank : null;
  }, { timeout: 20_000, intervals: [500, 1000, 1000, 1000, 2000] }).toBe(1);

  expect(flipped[bob.id].rank, "the ranks swapped on a competition whose standings were final").toBe(2);
  expect(flipped[alice.id].allSolved, "hiding the challenge shrank the all-solved denominator").toBe(true);
  expect(flipped[bob.id].allSolved).toBe(true);
  // The scores never moved. That is what makes this so easy to miss.
  expect(flipped[alice.id].score).toBe(b0[alice.id].score);
  expect(flipped[bob.id].score).toBe(b0[bob.id].score);

  await api.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Each writer refuses/skips — each paired with a POSITIVE CONTROL proving
//    the same operation still SUCCEEDS against a competition with no ended
//    session. Without the control, "the feature never ran" would satisfy the
//    refusal half.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A frozen comp (created live, task assigned, then ended) + a still-live one.
 * `frozenTask`/`liveTask` are the question each event HOLDS: its own copy
 * (lib/event-copies.js) — or, with `legacy`, the bank question itself assigned
 * as the previous release did (the import overwrite reaches only library rows,
 * so its freeze skip is about such a row: a database from before the copies).
 */
async function frozenAndLive(api, csrf, tag, difficulty = "easy", { legacy = false } = {}) {
  const ended = await createComp(api, csrf, `FZ-${tag}-ended`, -30 * MIN, 180);
  const live = await createComp(api, csrf, `FZ-${tag}-live`, -30 * MIN, 180);
  const frozenBank = await createTask(api, csrf, `FZ-${tag}-frozen`, difficulty, "zzz");
  const liveBank = await createTask(api, csrf, `FZ-${tag}-open`, difficulty, "zzz");
  const put = async () => [await assignTask(api, csrf, frozenBank, ended.id), await assignTask(api, csrf, liveBank, live.id)];
  const [frozenTask, liveTask] = legacy ? await withLegacySharedAssign(api, csrf, put) : await put();
  await endNow(api, csrf, ended.id);
  return { endedId: ended.id, liveId: live.id, frozenTask, liveTask };
}

test("v7.21.1: PATCH visibility is refused on a frozen challenge and still works on a live one", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const f = await frozenAndLive(api, csrf, "vis");

  const bad = await api.patch(`/api/admin/tasks/${f.frozenTask}/visibility`, { headers: H(csrf) });
  expect(bad.status(), await bad.text()).toBe(409);
  expect((await bad.json()).error).toMatch(/ended session/i);
  expect(withDb(db => db.prepare("SELECT active FROM tasks WHERE id=?").get(f.frozenTask).active)).toBe(1);

  // POSITIVE CONTROL — same admin, same endpoint, unfrozen challenge.
  const ok = await api.patch(`/api/admin/tasks/${f.liveTask}/visibility`, { headers: H(csrf) });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).active).toBe(0);
  expect(withDb(db => db.prepare("SELECT active FROM tasks WHERE id=?").get(f.liveTask).active)).toBe(0);

  await api.dispose();
});

test("v7.21.1: publish is refused on a frozen challenge and still works on a live one", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const f = await frozenAndLive(api, csrf, "pub");

  // Both challenges are put back to draft. Assignment REQUIRES `published`, but
  // a task can legitimately be draft while still assigned (restore-to-draft
  // keeps its competition_tasks rows) — which is the exact state that made
  // `publish` reachable on a finished competition. The route's own pre-check
  // ("already published") returns before the freeze, so draft is the only state
  // that reaches it.
  withDb(db => db.prepare("UPDATE tasks SET status='draft' WHERE id IN (?,?)").run(f.frozenTask, f.liveTask));

  const bad = await api.post(`/api/admin/tasks/${f.frozenTask}/publish`, { headers: H(csrf) });
  expect(bad.status(), await bad.text()).toBe(409);
  expect((await bad.json()).error).toMatch(/Cannot publish/i);
  expect(withDb(db => db.prepare("SELECT status FROM tasks WHERE id=?").get(f.frozenTask).status)).toBe("draft");

  // POSITIVE CONTROL
  const ok = await api.post(`/api/admin/tasks/${f.liveTask}/publish`, { headers: H(csrf) });
  expect(ok.status(), await ok.text()).toBe(200);
  expect(withDb(db => db.prepare("SELECT status FROM tasks WHERE id=?").get(f.liveTask).status)).toBe("published");

  await api.dispose();
});

test("v7.21.1: the task PUT freezes `active` too, and still edits an unfrozen challenge", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const f = await frozenAndLive(api, csrf, "put");

  // `active` used to be documented in the PUT as "not scoring-affecting and
  // remains editable" while the RESTORE handler in the same file froze it —
  // two contradictory definitions of one rule.
  const bad = await api.put(`/api/admin/tasks/${f.frozenTask}`, { headers: H(csrf), data: { active: 0 } });
  expect(bad.status(), await bad.text()).toBe(409);
  expect((await bad.json()).error).toMatch(/ended session/i);
  expect(withDb(db => db.prepare("SELECT active FROM tasks WHERE id=?").get(f.frozenTask).active)).toBe(1);

  // A TEXT-ONLY edit of the same frozen challenge is still allowed — the freeze
  // must not become a blanket lock, or it just re-creates the over-strict half
  // of the bug.
  const textOnly = await api.put(`/api/admin/tasks/${f.frozenTask}`, {
    headers: H(csrf), data: { title: "FZ-put-frozen renamed" },
  });
  expect(textOnly.status(), await textOnly.text()).toBe(200);

  // POSITIVE CONTROL — the identical `active` edit lands on the live comp's task.
  const ok = await api.put(`/api/admin/tasks/${f.liveTask}`, { headers: H(csrf), data: { active: 0 } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect(withDb(db => db.prepare("SELECT active FROM tasks WHERE id=?").get(f.liveTask).active)).toBe(0);

  await api.dispose();
});

test("v7.21.1: an import OVERWRITE skips a frozen challenge and applies to an unfrozen one", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const f = await frozenAndLive(api, csrf, "imp", "easy", { legacy: true });
  const titles = withDb(db => ({
    frozen: db.prepare("SELECT title FROM tasks WHERE id=?").get(f.frozenTask).title,
    live: db.prepare("SELECT title FROM tasks WHERE id=?").get(f.liveTask).title,
  }));

  // One request, both rows, both resolved "overwrite": the batch must apply the
  // unfrozen row and skip the frozen one rather than 400 the whole import.
  const row = (title) => ({
    title, description: "<p>imported</p>", difficulty: "hard", answer_type: "text",
    correct_answer: "rewritten", explanation: "<p>x</p>", hint: "h", active: 1, status: "published",
  });
  const r = await api.post("/api/admin/import/tasks", {
    headers: H(csrf),
    data: {
      data: { type: "hackarena-tasks", tasks: [row(titles.frozen), row(titles.live)] },
      resolutions: { "0": "overwrite", "1": "overwrite" },
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(body.overwritten, "the unfrozen row is applied").toBe(1);
  expect(body.skipped, "the frozen row is skipped, not rejected").toBe(1);

  const after = withDb(db => ({
    frozen: db.prepare("SELECT difficulty, correct_answer FROM tasks WHERE id=?").get(f.frozenTask),
    live: db.prepare("SELECT difficulty, correct_answer FROM tasks WHERE id=?").get(f.liveTask),
  }));
  expect(after.frozen.difficulty, "a frozen challenge is untouched by the overwrite").toBe("easy");
  expect(after.frozen.correct_answer).toBe("zzz");
  // POSITIVE CONTROL — the same payload really did rewrite the unfrozen row.
  expect(after.live.difficulty).toBe("hard");
  expect(after.live.correct_answer).toBe("rewritten");

  await api.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. recalculate is SCOPED, not refused.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.1: recalculate re-grades the live competition and leaves the ended one byte-identical", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const all = await participants(api);
  const alice = all.find(p => p.email === "alice@acme.com");
  const bob = all.find(p => p.email === "bob@acme.com");

  // ONE challenge, TWO competitions — the normal case for a reused bank, and
  // the reason recalculate is scoped rather than refused outright: refusing
  // would leave a superadmin unable to fix today's event.
  const ended = await createComp(api, csrf, "FZ-recalc-ended", -60 * MIN, 180);
  const live = await createComp(api, csrf, "FZ-recalc-live", -30 * MIN, 180);
  // ONE row held by both events: a database from before event-owned copies (the
  // previous model's mode, through the test hook) — the only way a challenge is
  // shared now, and the reason recalculate stays scoped per event.
  const task = await createTask(api, csrf, "FZ-recalc-task", "easy", "right");
  await withLegacySharedAssign(api, csrf, async () => {
    await assignTask(api, csrf, task, ended.id);
    await assignTask(api, csrf, task, live.id);
  });
  // A second, never-solved challenge in each competition. Without it the sole
  // participant solves EVERYTHING and the all-solved auto-end fires — the
  // "ended" competition then ends for the wrong reason (and `end-now` 400s),
  // and the "live" one silently freezes too, which would make frozen_skipped
  // read 2 and the whole scoping assertion vacuous.
  const fillerEnded = await createTask(api, csrf, "FZ-recalc-filler-ended", "easy", "nope");
  const fillerLive = await createTask(api, csrf, "FZ-recalc-filler-live", "easy", "nope");
  await assignTask(api, csrf, fillerEnded, ended.id);
  await assignTask(api, csrf, fillerLive, live.id);
  await assignUsers(api, csrf, [alice.id], ended.id);
  await assignUsers(api, csrf, [bob.id], live.id);
  await solveAs("alice@acme.com", ended.id, [{ id: task, answer: "right" }]);
  await solveAs("bob@acme.com", live.id, [{ id: task, answer: "right" }]);
  await endNow(api, csrf, ended.id);

  // Both submissions are now stored MIS-GRADED (the situation recalculate
  // exists for). A hint row in each competition is likewise stored on the wrong
  // scale — easy's hint cost is 15, not 45 — so the hint rescale has something
  // to do in both, and its scoping is exercised as well as the submissions'.
  const STALE = "2020-01-01T00:00:00.000Z";
  withDb(db => {
    db.prepare("UPDATE submissions SET is_correct=0, points_delta=-5, updated_at=? WHERE task_id=?").run(STALE, task);
    const ins = db.prepare(
      "INSERT INTO hint_reveals (competition_id,user_id,task_id,timeslot_id,points_deducted,revealed_at,updated_at) VALUES (?,?,?,NULL,45,?,?)"
    );
    ins.run(ended.id, alice.id, task, STALE, STALE);
    ins.run(live.id, bob.id, task, STALE, STALE);
  });
  const snapBefore = withDb(db =>
    db.prepare("SELECT id, competition_id, is_correct, points_delta, updated_at FROM submissions WHERE task_id=? ORDER BY id").all(task));
  expect(snapBefore).toHaveLength(2);

  const r = await api.post(`/api/admin/tasks/${task}/recalculate`, {
    headers: H(csrf), data: { confirm_live: true },
  });
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(body.frozen_skipped, "the ended competition's rows are reported, not silently dropped").toBe(1);
  expect(body.total_submissions, "only the unfrozen rows are even considered").toBe(1);
  // POSITIVE CONTROL — recalculate genuinely ran and changed something.
  expect(body.flipped).toBe(1);

  const after = withDb(db => ({
    subs: db.prepare("SELECT id, competition_id, is_correct, points_delta, updated_at FROM submissions WHERE task_id=? ORDER BY id").all(task),
    hints: db.prepare("SELECT competition_id, points_deducted, updated_at FROM hint_reveals WHERE task_id=?").all(task),
  }));
  const frozenBefore = snapBefore.find(s => s.competition_id === ended.id);
  const frozenAfter = after.subs.find(s => s.competition_id === ended.id);
  const openAfter = after.subs.find(s => s.competition_id === live.id);

  expect(frozenAfter, "the ended competition's submission is BYTE-IDENTICAL").toEqual(frozenBefore);
  expect(openAfter.is_correct, "the live competition's submission was re-graded").toBe(1);
  expect(openAfter.points_delta).toBe(50);
  expect(openAfter.updated_at).not.toBe(STALE);

  const frozenHint = after.hints.find(h => h.competition_id === ended.id);
  const openHint = after.hints.find(h => h.competition_id === live.id);
  expect(frozenHint.points_deducted, "a frozen competition's hint deduction is part of its final score").toBe(45);
  expect(openHint.points_deducted, "the live competition's hint deduction WAS rescaled").toBe(15);

  await api.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The tier that made this reachable in two clicks.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.1: a REGULAR admin is refused the visibility flip — and is otherwise allowed to use it", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const all = await participants(api);
  const carol = all.find(p => p.email === "carol@acme.com");
  expect(carol, "seeded carol must exist").toBeTruthy();
  const promote = await api.post(`/api/admin/participants/${carol.id}/role`, {
    headers: H(csrf), data: { role: "admin" },
  });
  expect(promote.status(), await promote.text()).toBe(200);

  // v8.3.29 — carol is promoted for the length of this test and there was NO
  // restore at all, so any failure below left her an `admin` carrying the
  // auto-applied `staff` tag for every later file on this worker. Demoting is
  // done from a FRESH superadmin context because `api` is disposed mid-test.
  try {
  const f = await frozenAndLive(api, csrf, "tier");
  await api.dispose();

  // The visibility route is `requireAdmin`, NOT `requireSuperAdmin` — a regular
  // admin reaches it from the challenge row kebab in two clicks, which is what
  // made the missing guard so easy to trip.
  const { api: adminApi, csrf: adminCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
  const me = await adminApi.get("/api/admin/me");
  expect(me.status(), await me.text()).toBe(200);
  expect((await me.json()).isSuperAdmin, "carol must be a REGULAR admin for this test to mean anything").toBeFalsy();

  const bad = await adminApi.patch(`/api/admin/tasks/${f.frozenTask}/visibility`, { headers: H(adminCsrf) });
  expect(bad.status(), await bad.text()).toBe(409);
  expect((await bad.json()).error).toMatch(/ended session/i);
  expect(withDb(db => db.prepare("SELECT active FROM tasks WHERE id=?").get(f.frozenTask).active)).toBe(1);

  // POSITIVE CONTROL — the 409 is the FREEZE, not a permission refusal: the
  // same admin flips the same field on an unfrozen challenge.
  const ok = await adminApi.patch(`/api/admin/tasks/${f.liveTask}/visibility`, { headers: H(adminCsrf) });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).active).toBe(0);

  await adminApi.dispose();
  } finally {
    // To the HARD-CODED seed value, never to whatever was read. A role post also
    // rewrites the staff tag (v7.21.32), but the tag delete is kept as well
    // because the guard checks both and a demote that left the tag would be
    // just as invisible.
    const { api: restore, csrf: rCsrf } = await apiLogin("superadmin");
    await restore.post(`/api/admin/participants/${carol.id}/role`, {
      headers: H(rCsrf), data: { role: "participant" },
    }).catch(() => {});
    await restore.delete(`/api/admin/participants/${carol.id}/tags/staff`, { headers: H(rCsrf) }).catch(() => {});
    await restore.dispose().catch(() => {});
  }
});
