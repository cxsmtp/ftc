// @ts-check
//
// PER-SESSION QUESTION SETS AND THE RANKING CHOICE (owner decision, 27 Nov 2026):
//
//   "Competition sessions: each session can hold a different question set. The
//    event creator chooses the ranking: a winner per session, a consolidated
//    overall winner, or both; and whether scores are turned into percentages so
//    sessions with different question sets compare fairly."
//   Overall winner: "scoring and then timing both considered, timing for tie
//    breaker".
//
// A question is in EVERY session unless it is narrowed to chosen ones
// (`competition_task_sessions`, lib/session-tasks.js). A participant sees,
// answers, is scored on and finishes only their own session's questions. The
// ranking is `leaderboard_mode` (per_slot | global, unchanged meanings) plus
// `leaderboard_overall` (an overall board beside the sessions: "both") and
// `leaderboard_percent` (the overall board ranks by each person's share of their
// own session's maximum points, compared exactly, time breaking a tie).
//
// Every fixture owns its event, questions and participants; every assertion is
// by value beside a control that the rule it rules out really runs.
const { test, expect } = require("./isolated-test");
const {
  H, uniq, MIN, sa, makeParticipant, enrol, participantCtx, submit, rawAll, rawRun, outliveCompCache,
} = require("./late-entry-fixture");
const { addQuestion, sessionEvent, setSessions, goLive, endAll, chooseSession, rawGet } = require("./session-sets-fixture");

const ids = (rows) => rows.map(r => r.id).sort();

/** One ZIP entry's text. */
function zipEntry(buf, name) {
  return new Promise((resolve, reject) => {
    require("yauzl").fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on("entry", (e) => {
        if (e.fileName !== name) return zip.readEntry();
        zip.openReadStream(e, (e2, st) => {
          if (e2) return reject(e2);
          const parts = []; st.on("data", d => parts.push(d)); st.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        });
      });
      zip.on("end", () => resolve(""));
      zip.readEntry();
    });
  });
}

/** The admin board for one session (or the overall one: tsId null), read until `pred` holds. */
async function adminBoard(api, compId, tsId, pred = () => true, message = "board") {
  let last = null;
  await expect.poll(async () => {
    const r = await api.get(`/api/admin/leaderboard?competitionId=${compId}${tsId ? `&timeslotId=${tsId}` : ""}`);
    last = r.ok() ? await r.json() : null;
    return !!(last && pred(last));
  }, { timeout: 12_000, intervals: [300, 600, 1000], message }).toBe(true);
  return last;
}

/** Two participants, one in each session of `slots`. */
async function onePerSession(api, csrf, comp, slots) {
  const out = [];
  for (const s of slots) {
    const p = await makeParticipant(api, csrf, `sq${uniq()}`);
    await enrol(api, csrf, comp.id, p.id);
    const ctx = await participantCtx(p.email, comp.id);
    await chooseSession(ctx, s.id);
    out.push({ ...p, ...ctx, slot: s });
  }
  return out;
}

test.describe("per-session question sets", () => {
  test("each participant sees, opens and answers only their own session's questions; a question in every session is in both", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const { comp, slots } = await sessionEvent(api, csrf);
      const [A, B] = slots;
      const shared = await addQuestion(api, csrf, comp.id, { title: `shared ${uniq()}` });
      const onlyA = await addQuestion(api, csrf, comp.id, { title: `onlyA ${uniq()}` });
      const onlyB = await addQuestion(api, csrf, comp.id, { title: `onlyB ${uniq()}`, difficulty: "hard" });
      // Narrowed while both sessions are upcoming (the only time a session's set can change).
      for (const [t, s] of [[onlyA, [A.id]], [onlyB, [B.id]]]) {
        const r = await setSessions(api, csrf, comp.id, t, s);
        expect(r.status(), await r.text()).toBe(200);
        expect((await r.json()).changed).toBe(true);
      }
      // Recorded on the event's History with the request's context, by session NAME.
      const ev = rawAll("SELECT details FROM competition_events WHERE competition_id=? AND event_type='task_sessions_changed' ORDER BY changed_at", [comp.id])
        .map(r => JSON.parse(r.details));
      expect(ev.map(d => [d.task_id, d.from, d.to])).toEqual([[onlyA, "every session", [A.name]], [onlyB, "every session", [B.name]]]);
      expect(ev.every(d => typeof d.ip === "string" && d.ip.length > 0), "each record carries the request's context").toBe(true);
      // The read the Questions section draws from.
      const read = await (await api.get(`/api/admin/competitions/${comp.id}/task-sessions`)).json();
      expect(read.offered).toBe(true);
      expect(read.tasks).toEqual({ [onlyA]: [A.id], [onlyB]: [B.id] });

      await goLive(comp.id, [A.id, B.id]);
      const [pa, pb] = await onePerSession(api, csrf, comp, slots);
      people.push(pa, pb);
      const list = async (p) => ids(await (await p.api.get("/api/tasks")).json());
      expect(await list(pa), "A sees the shared question and A's own").toEqual([shared, onlyA].sort());
      expect(await list(pb), "B sees the shared question and B's own").toEqual([shared, onlyB].sort());
      // Another session's question answers as an unassigned one does, at every door.
      expect((await pa.api.get(`/api/tasks/${onlyB}`)).status(), "A cannot open B's question").toBe(404);
      expect((await pa.api.get(`/api/tasks/${onlyA}`)).status(), "CONTROL: A opens their own").toBe(200);
      expect((await submit(pa.api, pa.csrf, onlyB)).status(), "A cannot answer B's question").toBe(404);
      expect((await pa.api.post(`/api/tasks/${onlyB}/hint`, { headers: H(pa.csrf) })).status(), "nor buy its hint").toBe(404);
      expect(rawAll("SELECT 1 FROM submissions WHERE competition_id=? AND user_id=? AND task_id=?", [comp.id, pa.id, onlyB]).length,
        "nothing was stored for the refused answer").toBe(0);
      const ok = await submit(pb.api, pb.csrf, onlyB);
      expect(ok.status(), "CONTROL: B answers their own").toBe(200);
      expect((await ok.json()).correct).toBe(true);
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("the refusals: a sessionless kind, one session, an unknown or empty list, a Quick question, a session that has started; and a changed choice since the dialog opened", async () => {
    const { api, csrf } = await sa();
    try {
      // A Booth Event runs no sessions.
      const booth = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `SQ booth ${uniq()}`, event_kind: "booth", add_qualifying: false,
        start_time: new Date(Date.now() + 60 * MIN).toISOString(), duration_minutes: 60 } });
      const boothComp = (await booth.json()).competition;
      const bt = await addQuestion(api, csrf, boothComp.id);
      let r = await setSessions(api, csrf, boothComp.id, bt, ["x"]);
      expect([r.status(), (await r.json()).code]).toEqual([400, "task_sessions_forbidden"]);
      // One session is nothing to choose between.
      const one = await sessionEvent(api, csrf, { sessions: 1 });
      const ot = await addQuestion(api, csrf, one.comp.id);
      r = await setSessions(api, csrf, one.comp.id, ot, [one.slots[0].id]);
      expect([r.status(), (await r.json()).code]).toEqual([400, "task_sessions_need_two"]);

      const { comp, slots } = await sessionEvent(api, csrf);
      const [A, B] = slots;
      const t = await addQuestion(api, csrf, comp.id);
      r = await setSessions(api, csrf, comp.id, t, [A.id, "not-a-session"]);
      expect([r.status(), (await r.json()).code]).toEqual([400, "task_sessions_unknown"]);
      r = await setSessions(api, csrf, comp.id, t, []);
      expect([r.status(), (await r.json()).code]).toEqual([400, "task_sessions_empty"]);
      r = await setSessions(api, csrf, comp.id, t, "A");
      expect([r.status(), (await r.json()).code], "a wrong-typed body field is a named 400").toEqual([400, "task_sessions_invalid"]);
      // Naming every session is "every session": stored as no rows.
      r = await setSessions(api, csrf, comp.id, t, [A.id, B.id]);
      expect((await r.json()).changed, "every session is the default, so nothing changes").toBe(false);
      expect(rawAll("SELECT 1 FROM competition_task_sessions WHERE competition_id=?", [comp.id]).length).toBe(0);
      // A question not in the event.
      r = await setSessions(api, csrf, comp.id, bt, [A.id]);
      expect([r.status(), (await r.json()).code]).toEqual([404, "task_not_in_event"]);
      // A Quick (qualifying) question is asked of everyone.
      const qComp = await sessionEvent(api, csrf, { create: { add_qualifying: true } });
      const quick = rawGet("SELECT ct.task_id AS id FROM competition_tasks ct JOIN task_tags tt ON tt.task_id=ct.task_id WHERE ct.competition_id=? AND tt.tag LIKE 'qualifying:%' LIMIT 1", [qComp.comp.id]);
      expect(quick, "PRECONDITION: the event asks its Quick questions").toBeTruthy();
      r = await setSessions(api, csrf, qComp.comp.id, quick.id, [qComp.slots[0].id]);
      expect([r.status(), (await r.json()).code]).toEqual([400, "task_sessions_qualifying"]);

      // A stale dialog: someone narrowed it since.
      expect((await setSessions(api, csrf, comp.id, t, [A.id])).status()).toBe(200);
      r = await setSessions(api, csrf, comp.id, t, [B.id], { expectedTimeslotIds: null });
      expect([r.status(), (await r.json()).code]).toEqual([409, "task_sessions_changed"]);
      r = await setSessions(api, csrf, comp.id, t, [B.id], { expectedTimeslotIds: [A.id] });
      expect(r.status(), "CONTROL: drawn from the current choice, it saves").toBe(200);

      // LOCKED ONCE A SESSION THE CHANGE TOUCHES HAS STARTED. A goes live; B stays upcoming.
      await goLive(comp.id, [A.id]);
      r = await setSessions(api, csrf, comp.id, t, [A.id]);
      expect([r.status(), (await r.json()).code], "moving the question into live A is refused").toEqual([409, "task_sessions_locked"]);
      const t2 = await addQuestion(api, csrf, comp.id);
      r = await setSessions(api, csrf, comp.id, t2, [A.id]);
      expect([r.status(), (await r.json()).code], "CONTROL: taking a question from upcoming B (live A keeps it) is allowed").toEqual([200, undefined]);
      r = await setSessions(api, csrf, comp.id, t2, [B.id]);
      expect([r.status(), (await r.json()).code], "taking it from live A is refused").toEqual([409, "task_sessions_locked"]);
      expect(rawAll("SELECT timeslot_id FROM competition_task_sessions WHERE competition_id=? AND task_id=?", [comp.id, t2]).map(x => x.timeslot_id),
        "the refused change wrote nothing").toEqual([A.id]);
    } finally { await api.dispose(); }
  });
});

test.describe("finishing is per session", () => {
  test("a participant who answers their own session's set is finished on the board and ends their session alone; the other session stays live until its own participant finishes", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const { comp, slots } = await sessionEvent(api, csrf, { create: { leaderboard_mode: "per_slot" } });
      const [A, B] = slots;
      const shared = await addQuestion(api, csrf, comp.id);
      const onlyA = await addQuestion(api, csrf, comp.id);
      const onlyB = await addQuestion(api, csrf, comp.id);
      expect((await setSessions(api, csrf, comp.id, onlyA, [A.id])).ok()).toBeTruthy();
      expect((await setSessions(api, csrf, comp.id, onlyB, [B.id])).ok()).toBeTruthy();
      await goLive(comp.id, [A.id, B.id]);
      const [pa, pb] = await onePerSession(api, csrf, comp, slots);
      people.push(pa, pb);
      // B answers one of their two; A answers both of theirs (the event holds three).
      expect((await (await submit(pb.api, pb.csrf, shared)).json()).correct).toBe(true);
      expect((await (await submit(pa.api, pa.csrf, shared)).json()).correct).toBe(true);
      const last = await submit(pa.api, pa.csrf, onlyA);
      expect((await last.json()).correct).toBe(true);
      // A is finished with two of the event's three questions: their set.
      const boardA = await adminBoard(api, comp.id, A.id, b => b.some(e => e.userId === pa.id), "A on A's board");
      expect(boardA.find(e => e.userId === pa.id).allSolved, "A finished their session's set").toBe(true);
      const boardB = await adminBoard(api, comp.id, B.id, b => b.some(e => e.userId === pb.id), "B on B's board");
      expect(boardB.find(e => e.userId === pb.id).allSolved, "CONTROL: B, one of two, has not").toBe(false);
      // A's finishing answer ended session A (its only participant is done), and only A.
      const ended = (id) => !!(rawGet("SELECT ended_at FROM competition_timeslots WHERE id=?", [id]) || {}).ended_at;
      await expect.poll(() => ended(A.id), { message: "session A auto-ended" }).toBe(true);
      expect(ended(B.id), "session B is still running").toBe(false);
      // B finishing their own set ends B, and with it the event.
      expect((await (await submit(pb.api, pb.csrf, onlyB)).json()).correct).toBe(true);
      await expect.poll(() => ended(B.id), { message: "session B auto-ended once B finished B's set" }).toBe(true);
      await expect.poll(() => !!rawGet("SELECT ended_at FROM competitions WHERE id=?", [comp.id]).ended_at, { message: "the event ended with its last session" }).toBe(true);
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("CONTROL: with no session narrowed, finishing still means every question of the event", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const { comp, slots } = await sessionEvent(api, csrf);
      const [A, B] = slots;
      const q1 = await addQuestion(api, csrf, comp.id);
      await addQuestion(api, csrf, comp.id);
      await goLive(comp.id, [A.id, B.id]);
      const [pa, pb] = await onePerSession(api, csrf, comp, slots);
      people.push(pa, pb);
      expect(ids(await (await pa.api.get("/api/tasks")).json()).length, "both questions in both sessions").toBe(2);
      expect((await (await submit(pa.api, pa.csrf, q1)).json()).correct).toBe(true);
      const board = await adminBoard(api, comp.id, A.id, b => b.some(e => e.userId === pa.id));
      expect(board.find(e => e.userId === pa.id).allSolved, "one of two is not finished").toBe(false);
      expect(rawGet("SELECT ended_at FROM competition_timeslots WHERE id=?", [A.id]).ended_at, "and A runs on").toBeNull();
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });
});

test.describe("the ranking choice", () => {
  test("stored and refused: per session / overall / both, percentages only where an overall board exists, nothing on a sessionless kind; locked once a session starts; audited", async () => {
    const { api, csrf } = await sa();
    try {
      const stored = (id) => rawGet("SELECT leaderboard_mode, leaderboard_overall, leaderboard_percent FROM competitions WHERE id=?", [id]);
      const both = await sessionEvent(api, csrf, { create: { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true } });
      expect(stored(both.comp.id)).toEqual({ leaderboard_mode: "per_slot", leaderboard_overall: 1, leaderboard_percent: 1 });
      const created = JSON.parse(rawGet("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'", [both.comp.id]).details);
      expect([created.leaderboard_overall, created.leaderboard_percent], "the create records both").toEqual([true, true]);
      const make = (data) => api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `SQ r ${uniq()}`, event_kind: "tournament", start_time: new Date(Date.now() + 60 * MIN).toISOString(), duration_minutes: 60, ...data } });
      let r = await make({ leaderboard_mode: "per_slot", leaderboard_percent: true });
      expect([r.status(), (await r.json()).code], "percentages with per-session boards only").toEqual([400, "leaderboard_percent_needs_overall"]);
      r = await make({ leaderboard_mode: "global", leaderboard_overall: true });
      expect([r.status(), (await r.json()).code], "\"both\" needs the per-session mode").toEqual([400, "leaderboard_overall_needs_per_session"]);
      r = await make({ event_kind: "booth", leaderboard_overall: true });
      expect([r.status(), (await r.json()).code], "a sessionless kind has one board").toEqual([400, "leaderboard_ranking_forbidden"]);
      r = await make({ leaderboard_mode: "global", leaderboard_percent: true });
      expect(r.status(), "CONTROL: an overall winner by percentages saves").toBe(200);
      r = await make({ leaderboard_overall: { on: true } });
      expect(r.status(), "a wrong-typed flag is a 400, never truthy").toBe(400);

      // The edit: echoing the stored values changes nothing; a change is recorded.
      const { comp, slots } = await sessionEvent(api, csrf);
      const put = (data) => api.put(`/api/admin/competitions/${comp.id}`, { headers: H(csrf), data });
      r = await put({ leaderboard_mode: "per_slot", leaderboard_overall: false, leaderboard_percent: false });
      expect(r.status(), await r.text()).toBe(200);
      r = await put({ leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true });
      expect(r.status(), await r.text()).toBe(200);
      expect(stored(comp.id)).toEqual({ leaderboard_mode: "per_slot", leaderboard_overall: 1, leaderboard_percent: 1 });
      const edited = rawAll("SELECT details FROM competition_events WHERE competition_id=? AND event_type='edited'", [comp.id]).map(x => JSON.parse(x.details));
      const ch = edited.map(d => d.changes || d).find(c => c.leaderboard_overall);
      expect(ch && [ch.leaderboard_overall, ch.leaderboard_percent], "the edit records each flag, from and to").toEqual([{ from: false, to: true }, { from: false, to: true }]);
      // Only "global" with overall left on is refused on an edit too.
      r = await put({ leaderboard_mode: "global" });
      expect([r.status(), (await r.json()).code]).toEqual([400, "leaderboard_overall_needs_per_session"]);
      // Locked once a session starts.
      await goLive(comp.id, [slots[0].id]);
      r = await put({ leaderboard_percent: false });
      expect([r.status(), (await r.json()).code]).toEqual([400, "leaderboard_ranking_locked"]);
      r = await put({ leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true });
      expect(r.status(), "CONTROL: an echo of the stored values is no change, so it saves").toBe(200);
    } finally { await api.dispose(); }
  });

  test("an overall board by percentages beats raw points where sessions hold different question sets (raw-points control), and time breaks a tie; session boards keep raw points", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      // Two twin events: percentages on and off. Session A holds one easy (50);
      // session B one easy and one hard (200). A answers theirs: 50/50 = 100%.
      // B answers the hard one only: 150 points, 150/200 = 75%.
      const build = async (percent) => {
        const ev = await sessionEvent(api, csrf, { create: { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: percent } });
        const [A, B] = ev.slots;
        const easyA = await addQuestion(api, csrf, ev.comp.id, { difficulty: "easy" });
        const easyB = await addQuestion(api, csrf, ev.comp.id, { difficulty: "easy" });
        const hardB = await addQuestion(api, csrf, ev.comp.id, { difficulty: "hard" });
        expect((await setSessions(api, csrf, ev.comp.id, easyA, [A.id])).ok()).toBeTruthy();
        expect((await setSessions(api, csrf, ev.comp.id, easyB, [B.id])).ok()).toBeTruthy();
        expect((await setSessions(api, csrf, ev.comp.id, hardB, [B.id])).ok()).toBeTruthy();
        await goLive(ev.comp.id, [A.id, B.id]);
        const [pa, pb] = await onePerSession(api, csrf, ev.comp, ev.slots);
        people.push(pa, pb);
        expect((await (await submit(pa.api, pa.csrf, easyA)).json()).correct).toBe(true);
        expect((await (await submit(pb.api, pb.csrf, hardB)).json()).correct).toBe(true);
        return { ...ev, pa, pb };
      };
      const pct = await build(true);
      const raw = await build(false);
      const overallPct = await adminBoard(api, pct.comp.id, null, b => b.length === 2, "overall % board");
      expect(overallPct.map(e => [e.userId, e.score, e.percent, e.maxPoints, e.rank]),
        "by percentages: A's 100% beats B's 75% though B has more points").toEqual([[pct.pa.id, 50, 100, 50, 1], [pct.pb.id, 150, 75, 200, 2]]);
      const overallRaw = await adminBoard(api, raw.comp.id, null, b => b.length === 2, "overall raw board");
      expect(overallRaw.map(e => [e.userId, e.score, e.rank]), "CONTROL: by points, B's 150 beats A's 50").toEqual([[raw.pb.id, 150, 1], [raw.pa.id, 50, 2]]);
      expect(overallRaw.every(e => e.percent === undefined), "and no percentage is shown on a points board").toBe(true);
      const sessB = await adminBoard(api, pct.comp.id, pct.slots[1].id, b => b.length === 1, "session B board");
      expect([sessB[0].score, sessB[0].percent], "a session board keeps raw points").toEqual([150, undefined]);
      // The participant's view: their session board, and the overall board beside it.
      const lb = await (await pct.pb.api.get("/api/leaderboard")).json();
      expect([lb.ranking, lb.percent, lb.sessionName]).toEqual(["both", false, pct.slots[1].name]);
      expect(lb.board.map(e => e.userId), "B's session board").toEqual([pct.pb.id]);
      expect(lb.overallBoard.percent, "the overall board ranks by percentages").toBe(true);
      expect(lb.overallBoard.board.map(e => [e.userId, e.percent]), "the overall board, by percentages").toEqual([[pct.pa.id, 100], [pct.pb.id, 75]]);
      expect(lb.overallBoard.me.rank, "B's overall place").toBe(2);
      expect(JSON.stringify(lb).includes("maxPoints"), "the maximum stays the organiser's").toBe(false);

      // TIME BREAKS A TIE. A third event: A holds one easy (50), B two easies (100).
      // Both answer everything: 100% each. B entered 20 minutes ago, A 2 minutes
      // ago, so A was faster and wins the tie; by points B's 100 would win.
      const ev = await sessionEvent(api, csrf, { create: { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true } });
      const [A, B] = ev.slots;
      const a1 = await addQuestion(api, csrf, ev.comp.id);
      const b1 = await addQuestion(api, csrf, ev.comp.id);
      const b2 = await addQuestion(api, csrf, ev.comp.id);
      expect((await setSessions(api, csrf, ev.comp.id, a1, [A.id])).ok()).toBeTruthy();
      expect((await setSessions(api, csrf, ev.comp.id, b1, [B.id])).ok()).toBeTruthy();
      expect((await setSessions(api, csrf, ev.comp.id, b2, [B.id])).ok()).toBeTruthy();
      await goLive(ev.comp.id, [A.id, B.id], { agoMinutes: 30 });
      const [qa, qb] = await onePerSession(api, csrf, ev.comp, ev.slots);
      people.push(qa, qb);
      rawRun("UPDATE competition_users SET login_time=? WHERE competition_id=? AND user_id=?", [new Date(Date.now() - 2 * MIN).toISOString(), ev.comp.id, qa.id]);
      rawRun("UPDATE competition_users SET login_time=? WHERE competition_id=? AND user_id=?", [new Date(Date.now() - 20 * MIN).toISOString(), ev.comp.id, qb.id]);
      expect((await (await submit(qb.api, qb.csrf, b1)).json()).correct).toBe(true);
      expect((await (await submit(qb.api, qb.csrf, b2)).json()).correct).toBe(true);
      expect((await (await submit(qa.api, qa.csrf, a1)).json()).correct).toBe(true);
      const tie = await adminBoard(api, ev.comp.id, null, b => b.length === 2 && b.every(e => e.allSolved), "tie board");
      expect(tie.map(e => [e.userId, e.percent, e.score]), "both at 100%: the faster one (A) is first, ahead of more points").toEqual([[qa.id, 100, 50], [qb.id, 100, 100]]);
      expect(tie[0].solveTimeMs < tie[1].solveTimeMs, "and A's time is the shorter").toBe(true);
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("the comparator: percentages compare exactly (equal shares tie, then time decides), and every permutation sorts to one order (a strict weak ordering)", async () => {
    const { compareLeaderboardEntries, sortLeaderboard } = require("../lib/leaderboard");
    const e = (userId, score, max, solveTimeMs, allSolved = false, presence = 0) => ({ userId, score, _maxPoints: max, solveTimeMs, allSolved, _presenceMs: presence });
    // 1/3 and 2/6 are the same share; in doubles 1/3 and 2/6 are equal but 0.1+0.2
    // style drift is exactly what a float key would invite. Cross-multiplication ties them.
    const a = e("a", 1, 3, 500), b = e("b", 2, 6, 400), c = e("c", 50, 150, 600);
    expect(compareLeaderboardEntries(a, b, false, "percent") > 0, "equal shares: the faster (b) first").toBe(true);
    expect(compareLeaderboardEntries(a, c, false, "percent") < 0, "equal shares: a faster than c").toBe(true);
    expect(compareLeaderboardEntries(a, b, false, "points") > 0, "CONTROL: by points, b's 2 beats a's 1").toBe(true);
    // A share one part in a hundred thousand apart is not a tie.
    const p = e("p", 99999, 100000, 1), q = e("q", 99998, 99999, 999999);
    expect(compareLeaderboardEntries(p, q, false, "percent"), "99999/100000 > 99998/99999").toBeLessThan(0);
    // A maximum of 0 reads as 0%; a negative score stays below it.
    const z = e("z", 0, 0, 1), n = e("n", -5, 100, 1);
    expect(compareLeaderboardEntries(z, n, false, "percent") < 0, "0% above a negative share").toBe(true);
    // Every permutation of a mixed set (finishers and not, presence on) sorts to ONE order.
    const set = [e("u1", 50, 100, 300, true, 600_000), e("u2", 1, 2, 200, false, 0), e("u3", 75, 150, 100, true, 300_000),
      e("u4", 150, 200, 50, false, 900_000), e("u5", 30, 40, 400, true, 1), e("u6", 0, 0, 10, false, 0)];
    const perms = (xs) => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r]));
    // Shares: u4, u5 75%; u1, u2, u3 50%; u6 0%. By elapsed alone the ties go to
    // the faster; ranking on presence, a finisher leads a tied non-finisher and
    // finishers order by presence (the block rule, unchanged by the basis).
    const expected = { false: "u4,u5,u3,u2,u1,u6", true: "u5,u4,u3,u1,u2,u6" };
    for (const pres of [false, true]) {
      const orders = new Set(perms(set).map(pm => sortLeaderboard([...pm], pres, "percent").map(x => x.userId).join(",")));
      expect(orders.size, `one order under presence=${pres}`).toBe(1);
      expect([...orders][0], `the order under presence=${pres}`).toBe(expected[pres]);
    }
    // ANTI-VACUITY: the percentage key decides, not insertion order or userId.
    const byPct = sortLeaderboard([e("x", 10, 100, 1), e("y", 90, 100, 9)], false, "percent").map(x => x.userId);
    expect(byPct, "90% before 10%").toEqual(["y", "x"]);
  });
});

test.describe("certificates name the board their place was on", () => {
  /** An ended event of `create` ranking: A's participant tops A (50/50), B's tops B with 150 of 200. */
  async function endedEvent(api, csrf, create, people) {
    const ev = await sessionEvent(api, csrf, { create });
    const [A, B] = ev.slots;
    const easyA = await addQuestion(api, csrf, ev.comp.id, { difficulty: "easy" });
    const easyB = await addQuestion(api, csrf, ev.comp.id, { difficulty: "easy" });
    const hardB = await addQuestion(api, csrf, ev.comp.id, { difficulty: "hard" });
    expect((await setSessions(api, csrf, ev.comp.id, easyA, [A.id])).ok()).toBeTruthy();
    expect((await setSessions(api, csrf, ev.comp.id, easyB, [B.id])).ok()).toBeTruthy();
    expect((await setSessions(api, csrf, ev.comp.id, hardB, [B.id])).ok()).toBeTruthy();
    await goLive(ev.comp.id, [A.id, B.id]);
    const [pa, pb] = await onePerSession(api, csrf, ev.comp, ev.slots);
    people.push(pa, pb);
    expect((await (await submit(pa.api, pa.csrf, easyA)).json()).correct).toBe(true);
    expect((await (await submit(pb.api, pb.csrf, hardB)).json()).correct).toBe(true);
    // The scheduler sees it live, then ended: its time-expiry is an end path, so
    // the automatic certificate issue is queued as for any event that runs out.
    expect((await api.post("/api/test/scheduler-tick", { headers: H(csrf) })).ok()).toBeTruthy();
    await endAll(ev.comp.id);
    expect((await api.post("/api/test/scheduler-tick", { headers: H(csrf) })).ok()).toBeTruthy();
    return { ...ev, pa, pb };
  }
  const mint = async (p, compId) => {
    const r = await p.api.post(`/api/competitions/${compId}/badge`, { headers: H(p.csrf) });
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  };
  const rows = (compId, userId) => rawAll(
    "SELECT timeslot_id, basis, rank, board_kind, board_name FROM achievement_badges WHERE competition_id=? AND user_id=? AND revoked_at IS NULL ORDER BY IFNULL(timeslot_id,'')", [compId, userId]);

  test("a winner per session: each first place names its session, frozen at mint; a rename afterwards keeps it", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const ev = await endedEvent(api, csrf, { leaderboard_mode: "per_slot" }, people);
      const m = await mint(ev.pa, ev.comp.id);
      expect([m.rankLabel, m.board, m.also], "A's certificate: 1st in A, and only that").toEqual([`1st Place — ${ev.slots[0].name}`, ev.slots[0].name, undefined]);
      expect(rows(ev.comp.id, ev.pa.id)).toEqual([{ timeslot_id: ev.slots[0].id, basis: "placement", rank: 1, board_kind: "session", board_name: ev.slots[0].name }]);
      const mb = await mint(ev.pb, ev.comp.id);
      expect(mb.rankLabel, "B's certificate: 1st in B").toBe(`1st Place — ${ev.slots[1].name}`);
      rawRun("UPDATE competition_timeslots SET name=? WHERE id=?", [`Renamed ${uniq()}`, ev.slots[0].id]);
      const held = await (await ev.pa.api.get("/api/me/certificates")).json();
      const mine = held.certificates.find(h => h.competitionId === ev.comp.id);
      expect([mine.label, mine.board], "a rename does not relabel an issued certificate").toEqual([`1st Place — ${ev.slots[0].name}`, ev.slots[0].name]);
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("an overall winner: places are on the one overall board and say so; CONTROL: an event with one session names no board", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const ev = await endedEvent(api, csrf, { leaderboard_mode: "global" }, people);
      // By points B (150) is first overall, A (50) second.
      expect((await mint(ev.pb, ev.comp.id)).rankLabel).toBe("1st Place — Overall");
      expect((await mint(ev.pa, ev.comp.id)).rankLabel).toBe("2nd Place — Overall");
      expect(rows(ev.comp.id, ev.pa.id)).toEqual([{ timeslot_id: null, basis: "placement", rank: 2, board_kind: "overall", board_name: null }]);
      // One session: one board, nothing to name.
      const one = await sessionEvent(api, csrf, { sessions: 1 });
      const q = await addQuestion(api, csrf, one.comp.id);
      await goLive(one.comp.id, [one.slots[0].id]);
      const [po] = await onePerSession(api, csrf, one.comp, one.slots);
      people.push(po);
      expect((await (await submit(po.api, po.csrf, q)).json()).correct).toBe(true);
      await endAll(one.comp.id);
      const m = await mint(po, one.comp.id);
      expect([m.rankLabel, m.board]).toEqual(["1st Place", undefined]);
      expect(rows(one.comp.id, po.id)[0].board_kind).toBeNull();
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("both: one press collects the session certificate AND the overall one (by percentages here), two rows; the automatic issue issues the same pair and nothing twice", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const ev = await endedEvent(api, csrf, { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true }, people);
      const m = await mint(ev.pa, ev.comp.id);
      expect(m.rankLabel, "A's own board: 1st in A").toBe(`1st Place — ${ev.slots[0].name}`);
      expect((m.also || []).map(x => x.rankLabel), "and 1st overall by percentages (100% beats 75%)").toEqual(["1st Place — Overall"]);
      expect(rows(ev.comp.id, ev.pa.id)).toEqual([
        { timeslot_id: null, basis: "placement", rank: 1, board_kind: "overall", board_name: null },
        { timeslot_id: ev.slots[0].id, basis: "placement", rank: 1, board_kind: "session", board_name: ev.slots[0].name },
      ]);
      // A second press returns both again and mints nothing new.
      const again = await mint(ev.pa, ev.comp.id);
      expect([again.token, (again.also || [])[0] && again.also[0].token]).toEqual([m.token, m.also[0].token]);
      expect(rows(ev.comp.id, ev.pa.id).length).toBe(2);
      // The automatic issue (the dispatcher): B gets B's session certificate and
      // the overall 2nd place; A's held pair is not issued again.
      const tick = await api.post("/api/test/certificate-dispatch-tick", { headers: H(csrf), data: { force: true, competitionId: ev.comp.id } });
      expect(tick.ok(), await tick.text()).toBeTruthy();
      expect(rows(ev.comp.id, ev.pb.id), "B's pair, from the automatic issue").toEqual([
        { timeslot_id: null, basis: "placement", rank: 2, board_kind: "overall", board_name: null },
        { timeslot_id: ev.slots[1].id, basis: "placement", rank: 1, board_kind: "session", board_name: ev.slots[1].name },
      ]);
      // B's own press now returns the same pair, minting nothing.
      const mb = await mint(ev.pb, ev.comp.id);
      expect([mb.rankLabel, (mb.also || []).map(x => x.rankLabel)]).toEqual([`1st Place — ${ev.slots[1].name}`, ["2nd Place — Overall"]]);
      expect(rows(ev.comp.id, ev.pb.id).length).toBe(2);
      expect(rows(ev.comp.id, ev.pa.id).length, "nothing issued twice").toBe(2);
      // The organisers' list names each board.
      const list = await (await api.get(`/api/admin/competitions/${ev.comp.id}/certificates`)).json();
      const labels = (list.certificates || list.rows || []).filter(c => c.userId === ev.pa.id).map(c => c.label).sort();
      expect(labels).toEqual([`1st Place — ${ev.slots[0].name}`, "1st Place — Overall"].sort());
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("a place on an overall board ranked by percentages prints that percentage, never its points, on every surface; CONTROL: a points board prints points", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const ev = await endedEvent(api, csrf, { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true }, people);
      const m = await mint(ev.pb, ev.comp.id);
      const overall = (m.also || [])[0];
      // B holds 150 of 200: the overall board ranked B on 75% (2nd, under A's 100%).
      expect(overall && overall.rankLabel, "PRECONDITION: B's overall place").toBe("2nd Place — Overall");
      const frozen = rawAll("SELECT timeslot_id, score_snapshot, score_permille FROM achievement_badges WHERE competition_id=? AND user_id=? ORDER BY IFNULL(timeslot_id,'')", [ev.comp.id, ev.pb.id]);
      expect(frozen, "the percentage is frozen on the overall certificate only").toEqual([
        { timeslot_id: null, score_snapshot: 150, score_permille: 750 },
        { timeslot_id: ev.slots[1].id, score_snapshot: 150, score_permille: null },
      ]);
      const svgOf = async (token) => (await (await api.get(`/api/test/certificate-svg/${token}`)).json());
      // The artwork the PDF is drawn from, and the share card: the drawn text.
      const ov = await svgOf(overall.token);
      expect(ov.certificate.includes(">75%<"), "the certificate draws 75% in its score slot").toBe(true);
      expect(ov.certificate.includes("150 pts"), "and never the points it was not ranked on").toBe(false);
      expect(ov.card.includes("75%") && !ov.card.includes("150 pts"), "the share card says the same").toBe(true);
      // CONTROL: the session board ranks on points, so its certificate prints points.
      const ses = await svgOf(m.token);
      expect(ses.certificate.includes(">150 pts<") || ses.certificate.includes("150 pts"), "a points board's certificate prints points").toBe(true);
      expect(ses.certificate.includes("75%"), "and no percentage").toBe(false);
      // The holder's list and the organisers' list.
      const mine = await (await ev.pb.api.get("/api/me/certificates")).json();
      const mineOverall = (mine.certificates || []).find(c => c.token === overall.token);
      expect(mineOverall && [mineOverall.scoreLabel, mineOverall.scorePercent]).toEqual(["75%", 75]);
      const list = await (await api.get(`/api/admin/competitions/${ev.comp.id}/certificates`)).json();
      const bRows = (list.certificates || []).filter(c => c.userId === ev.pb.id).map(c => [c.label, c.scoreLabel, c.scorePercent]).sort();
      expect(bRows).toEqual([[`1st Place — ${ev.slots[1].name}`, "150 pts", null], ["2nd Place — Overall", "75%", 75]].sort());
      // /credential, which a verifier reads.
      const code = rawAll("SELECT public_code FROM achievement_badges WHERE token=?", [overall.token])[0].public_code;
      const anon = await require("@playwright/test").request.newContext({ baseURL: require("./helpers").BASE });
      try {
        const v = await (await anon.post("/credential", { headers: { "content-type": "application/json", accept: "application/json" }, data: { code, surname: "Probe" } })).json();
        expect(JSON.stringify(v).includes("75%") && !JSON.stringify(v).includes("150 pts"), `the verification page says 75%: ${JSON.stringify(v).slice(0, 300)}`).toBe(true);
      } finally { await anon.dispose(); }
      // The full event export's certificates.csv carries it in its own column.
      const zip = await (await api.get(`/api/admin/competitions/${ev.comp.id}/export/full`)).body();
      const csv = await zipEntry(zip, "certificates.csv");
      const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
      const head = lines[0].split(",").map(x => x.replace(/^"|"$/g, ""));
      const pi = head.indexOf("Percent");
      expect(pi, "a Percent column").toBeGreaterThan(-1);
      const cells = lines.slice(1).map(l => l.split(",").map(x => x.replace(/^"|"$/g, ""))).filter(c => c[0] === ev.pb.id).map(c => [c[head.indexOf("Board")], c[pi]]).sort();
      expect(cells).toEqual([[ev.slots[1].name, ""], ["Overall", "75"]].sort());
    } finally {
      for (const p of people) await p.api.dispose();
      await api.dispose();
    }
  });

  test("the congratulations email states the frozen percentage, not the points (the mail builder, by value)", async () => {
    const { certificateEmailCopy } = require("../lib/certificate-dispatch");
    const base = { basis: "placement", rank: 1, score_snapshot: 150, late_entrant: 0, board_kind: "overall", board_name: null };
    const opts = { eventName: "E", platformName: "P", intro: "", code: null, pdfUrl: "https://x/p.pdf", messages: {} };
    const pct = JSON.stringify(certificateEmailCopy({ ...base, score_permille: 875 }, opts));
    expect(pct.includes("87.5%") && !pct.includes("150 points"), "a percentage board's place").toBe(true);
    const pts = JSON.stringify(certificateEmailCopy({ ...base, score_permille: null }, opts));
    expect(pts.includes("150 points") && !pts.includes("%<"), "CONTROL: a points board's place").toBe(true);
  });

  test("the artwork: a placement on a named board prints a LEADERBOARD column; a participation certificate and a one-board event print none", async () => {
    const { buildCertificateSvg } = require("../lib/badge");
    const base = { platformName: "P", competitionName: "E", displayName: "Ada Lovelace", dateLabel: "1 Dec 2026", scoreLabel: "50 pts" };
    const placed = buildCertificateSvg({ ...base, basis: "placement", rank: 1, board: "Overall" });
    expect(placed.includes(">LEADERBOARD<") || placed.includes("LEADERBOARD"), "the column is drawn").toBe(true);
    expect(placed.includes(">Overall<"), "naming the board").toBe(true);
    const session = buildCertificateSvg({ ...base, basis: "placement", rank: 2, board: "Morning cohort" });
    expect(session.includes(">Morning cohort<")).toBe(true);
    const part = buildCertificateSvg({ ...base, basis: "participation", rank: 7, board: "Overall" });
    expect(part.includes("LEADERBOARD"), "no place, no board").toBe(false);
    const oneBoard = buildCertificateSvg({ ...base, basis: "placement", rank: 1, board: null });
    expect(oneBoard.includes("LEADERBOARD"), "CONTROL: one board names none").toBe(false);
  });
});

test.describe("clone", () => {
  test("a clone carries the ranking choice and each question's sessions, by session order", async () => {
    const { api, csrf } = await sa();
    try {
      const ev = await sessionEvent(api, csrf, { create: { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true }, sessions: 3 });
      const [A, B, C] = ev.slots;
      const qAll = await addQuestion(api, csrf, ev.comp.id, { title: `cl-all ${uniq()}` });
      const qB = await addQuestion(api, csrf, ev.comp.id, { title: `cl-b ${uniq()}` });
      const qAC = await addQuestion(api, csrf, ev.comp.id, { title: `cl-ac ${uniq()}` });
      expect((await setSessions(api, csrf, ev.comp.id, qB, [B.id])).ok()).toBeTruthy();
      expect((await setSessions(api, csrf, ev.comp.id, qAC, [A.id, C.id])).ok()).toBeTruthy();
      const r = await api.post(`/api/admin/competitions/${ev.comp.id}/clone`, { headers: H(csrf), data: { name: `SQ clone ${uniq()}` } });
      expect(r.status(), await r.text()).toBe(200);
      const copy = (await r.json()).competition;
      expect(rawGet("SELECT leaderboard_mode, leaderboard_overall, leaderboard_percent FROM competitions WHERE id=?", [copy.id]))
        .toEqual({ leaderboard_mode: "per_slot", leaderboard_overall: 1, leaderboard_percent: 1 });
      const newSlots = rawAll("SELECT id, name FROM competition_timeslots WHERE competition_id=? ORDER BY start_time", [copy.id]);
      expect(newSlots.map(s => s.name), "the copy's sessions, in the source's order").toEqual([A.name, B.name, C.name]);
      const title = (id) => rawGet("SELECT title FROM tasks WHERE id=?", [id]).title;
      const narrowed = {};
      for (const row of rawAll("SELECT task_id, timeslot_id FROM competition_task_sessions WHERE competition_id=?", [copy.id])) {
        const t = title(row.task_id).split(" ")[0];
        (narrowed[t] = narrowed[t] || []).push(newSlots.findIndex(s => s.id === row.timeslot_id));
      }
      for (const k of Object.keys(narrowed)) narrowed[k].sort();
      expect(narrowed, "B's question in the copy's second session, A+C's in its first and third; the shared one in all").toEqual({ "cl-b": [1], "cl-ac": [0, 2] });
      expect(title(qAll).startsWith("cl-all"), "PRECONDITION").toBe(true);
      expect(rawAll("SELECT 1 FROM competition_events WHERE competition_id=? AND event_type='task_sessions_carried'", [copy.id]).length, "recorded on the copy's History").toBe(1);
    } finally { await api.dispose(); }
  });
});

test.describe("the event-copies migration", () => {
  test("a question's sessions follow its assignment to the event's own copy (ON UPDATE CASCADE): the batch moves them with competition_tasks", async () => {
    const { api, csrf } = await sa();
    const legacy = async (on) => {
      const r = await api.post("/api/test/legacy-shared-assign", { headers: H(csrf), data: { on } });
      expect((await r.json()).on).toBe(on);
    };
    try {
      const { comp, slots } = await sessionEvent(api, csrf);
      const t = await api.post("/api/admin/tasks", { headers: H(csrf), data: { title: `SQ mig ${uniq()}`, description: "<p>q</p>", difficulty: "easy", answer_type: "text", correct_answer: "win", status: "published" } });
      const bankId = (await t.json()).id;
      await legacy(true);
      try {
        const a = await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
        expect((await a.json()).copies[0].task_id, "PRECONDITION: the previous model put the bank question itself in").toBe(bankId);
      } finally { await legacy(false); }
      expect((await setSessions(api, csrf, comp.id, bankId, [slots[1].id])).ok()).toBeTruthy();
      expect(rawAll("SELECT task_id FROM competition_task_sessions WHERE competition_id=?", [comp.id]).map(r => r.task_id)).toEqual([bankId]);
      const mig = await api.post("/api/test/event-copies-migrate", { headers: H(csrf), data: {} });
      expect(mig.ok(), await mig.text()).toBeTruthy();
      const copy = rawGet("SELECT task_id FROM competition_tasks WHERE competition_id=?", [comp.id]).task_id;
      expect(copy, "the assignment moved to the event's copy").not.toBe(bankId);
      expect(rawAll("SELECT task_id, timeslot_id FROM competition_task_sessions WHERE competition_id=?", [comp.id]),
        "and the question's session came with it").toEqual([{ task_id: copy, timeslot_id: slots[1].id }]);
    } finally { await api.dispose(); }
  });
});
