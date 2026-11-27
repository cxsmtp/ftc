// @ts-check
//
// A QUALIFYING ("QUICK") QUESTION COUNTS TOWARD NOTHING BUT ITS OWN ANSWER.
//
// lib/qualifying.js: a qualifying question scores 0 and is left out of every
// count of finishing (`notQualifyingSql`). The source half is held by
// tests/qualifying-counting-sites.spec.js; these are the behaviours a
// participant or organiser meets, each beside a control that moves:
//
//   * THE TIE-BREAK. Three participants on the same score: one answered a quick
//     question long after their last scoring solve, one finished later, and one
//     made a SCORING solve at the very moment of that quick answer. The quick
//     answer moves nothing (their finish time is their last scoring solve, and
//     they keep first place); the scoring solve at the same moment does move a
//     finish time (that participant is last). Times are planted after real,
//     graded submissions, so the board's arithmetic is exact.
//   * TAKING PART. A participant whose only answer is a quick question did not
//     take part: no participation certificate is offered (the certificates list,
//     the board's call to action) or minted (403 `not_attempted`, asked of a
//     participant who IS on the final board, so it is the attempt test that
//     refuses). A participant whose only answer is a WRONG scoring answer did
//     take part, and gets all three (control). Likewise for a hint: one whose
//     only act is revealing the (free) hint of an older qualifying question of
//     another type (planted: no route tags one now) did not take part; one whose
//     only act is a hint on a scoring challenge did (control).
//   * RECALCULATE prices a qualifying question's stored answer, a WRONG one (an
//     empty stored selection an older release kept) and its hint at 0, and a
//     scoring pick-one question's at its points, the penalty and a hint at 30%
//     (control): each stored row holds the other's price, so both runs must
//     change it.
//   * A MALFORMED `qualifying:` tag an older import stored scores nothing, so the
//     participant's challenge list calls it a quick question as the challenge's
//     own view does (no points shown it cannot award); an untagged one neither.
//   * A Booth Event where staff compete is seeded no quick questions when the
//     create leaves "Add the qualifying questions" unsaid (it admits sealed
//     challenges only, and a quick question can never be sealed); the same
//     create without staff competing gets the four built-in ones (control).
//
// Already held elsewhere, and not repeated: a completion certificate's date
// ignores a later quick answer (tests/completion-credential.spec.js, sweep #92);
// a Program completes without the quick answers and the all-solved early end
// waits for them (tests/event-team-reports.spec.js); a quick answer is stored
// at 0 points (tests/event-team-reports.spec.js, "qualifying questions").
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

const MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
// better-sqlite3 opened inside each call: per-file isolation recreates the
// database, so a module-scope handle would read the previous file's inode.
const sql = (fn, opts = { readonly: true }) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
};
const write = (fn) => sql(fn, {});
/** The quick questions an event holds, by key. */
const quickOf = (compId) => sql(db => db.prepare(
  `SELECT t.id, t.choices, tt.tag FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
     JOIN task_tags tt ON tt.task_id=t.id AND tt.tag LIKE 'qualifying:%' WHERE ct.competition_id=? ORDER BY tt.tag`
).all(compId)).map(r => ({ id: r.id, key: r.tag.slice("qualifying:".length), options: JSON.parse(r.choices) }));
// A pick-one question (the only kind a qualifying tag may go on): easy, 50 points while it scores.
const PICK_ONE = { answer_type: "any", correct_answer: "", choices: [{ text: "Small" }, { text: "Large" }] };
const optionIds = (taskId) => JSON.parse(sql(db => db.prepare("SELECT choices FROM tasks WHERE id=?").get(taskId).choices)).map(c => c.id);

let sa, saCsrf;
const sessions = [];
test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
test.afterAll(async () => {
  for (const a of [sa, ...sessions]) { try { await a.dispose(); } catch (e) { console.warn("dispose failed:", e && e.message); } }
});

async function signIn(p) {
  if (!p.s) { p.s = await apiLogin(p.email, PARTICIPANT_PASS); sessions.push(p.s.api); }
  return p.s;
}
async function enter(p, compId) {
  const s = await signIn(p);
  const r = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
  expect(r.ok(), `select: ${r.status()} ${await r.text()}`).toBeTruthy();
}
/** Answer through the real door (the grading hash read first, as the client does). */
async function answer(p, compId, taskId, value) {
  const s = await signIn(p);
  const v = await s.api.get(`/api/tasks/${taskId}`, { headers: { "x-competition-id": compId } });
  expect(v.ok(), `view: ${v.status()} ${await v.text()}`).toBeTruthy();
  const r = await s.api.post(`/api/tasks/${taskId}/submit`, {
    headers: { ...H(s.csrf), "x-competition-id": compId },
    data: { answer: value, gradingHash: (await v.json()).grading_hash || "" },
  });
  expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}
const pick = (q, i = 0) => JSON.stringify([q.options[i].id]);
async function adminBoard(compId) {
  const r = await sa.get(`/api/admin/leaderboard?competitionId=${compId}`);
  expect(r.ok(), `board: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}
/** Reveal a challenge's hint through the real door. */
async function revealHint(p, compId, taskId) {
  const s = await signIn(p);
  const r = await s.api.post(`/api/tasks/${taskId}/hint`, { headers: { ...H(s.csrf), "x-competition-id": compId } });
  expect(r.ok(), `hint: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}
/** What an ENDED event offers `p`: the certificates list and the board's call to action. */
async function certOffer(p, compId) {
  const s = await signIn(p);
  const certs = await (await s.api.get("/api/me/certificates")).json();
  expect(Array.isArray(certs.claimable), JSON.stringify(certs)).toBe(true);
  const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
  expect(sel.ok(), await sel.text()).toBeTruthy();
  const lb = await (await s.api.get("/api/leaderboard", { headers: { "x-competition-id": compId } })).json();
  expect(lb.ended, "PRECONDITION: the board is final").toBe(true);
  return { listed: certs.claimable.some(c => c.competitionId === compId), cta: lb.canShareBadge };
}
/** The participant's own mint. */
async function certMint(p, compId) {
  const s = await signIn(p);
  const r = await s.api.post(`/api/competitions/${compId}/badge`, { headers: H(s.csrf) });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

test.describe("A quick answer never moves the tie-break finish time", () => {
  test("three on one score: a late quick answer keeps first place; a scoring solve at the same moment is last (control)", async () => {
    const start = Date.now() - 3 * HOUR;
    const ev = await makeCompetition(sa, saCsrf, "tiebreak", { start_time: iso(start), duration_minutes: 600, add_qualifying: true });
    const quick = quickOf(ev.id);
    expect(quick.length, "PRECONDITION: the four quick questions").toBe(4);
    const s1 = await makeTask(sa, saCsrf, "tb-s1"), s2 = await makeTask(sa, saCsrf, "tb-s2");
    s1.id = (await assignTask(sa, saCsrf, s1.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    s2.id = (await assignTask(sa, saCsrf, s2.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    const A = await makeParticipant(sa, saCsrf, "tb-quick"), B = await makeParticipant(sa, saCsrf, "tb-later");
    const D = await makeParticipant(sa, saCsrf, "tb-scoring"), E = await makeParticipant(sa, saCsrf, "tb-idle");
    // E never plays: an unfinished member keeps the all-solved end away (fixture item 1).
    await enrol(sa, saCsrf, ev.id, [A.id, B.id, D.id, E.id]);
    for (const p of [A, B, D]) {
      await enter(p, ev.id);
      expect((await answer(p, ev.id, s1.id, "a")).correct).toBe(true);
      expect((await answer(p, ev.id, s2.id, "a")).correct).toBe(true);
    }
    const qa = await answer(A, ev.id, quick[0].id, pick(quick[0]));
    expect(qa.correct, "PRECONDITION: the quick answer is accepted").toBe(true);
    expect(qa.qualifying, "…as a quick question").toBe(true);
    expect(sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(ev.id).ended_at), "PRECONDITION: still live").toBeNull();

    // The same entry time for all three, then each answer at a known moment.
    const T0 = start + 10 * MIN;
    const at = { A: [[s1, 2], [s2, 10], [quick[0], 50]], B: [[s1, 2], [s2, 20]], D: [[s1, 2], [s2, 50]] };
    const who = { A, B, D };
    write(db => {
      for (const [k, rows] of Object.entries(at)) {
        db.prepare("UPDATE competition_users SET login_time=? WHERE competition_id=? AND user_id=?").run(iso(T0), ev.id, who[k].id);
        for (const [t, m] of rows) {
          const c = db.prepare("UPDATE submissions SET submitted_at=? WHERE competition_id=? AND user_id=? AND task_id=?").run(iso(T0 + m * MIN), ev.id, who[k].id, t.id);
          expect(c.changes, `PRECONDITION: ${k} has one answer to plant`).toBe(1);
        }
      }
    });
    // B's time involves no quick question either way: once it shows, the board
    // was built from the planted times (the board cache lives 5 s).
    const rowOf = (b, p) => b.find(r => r.userId === p.id);
    await expect.poll(async () => (rowOf(await adminBoard(ev.id), B) || {}).solveTimeMs, { timeout: 8000 }).toBe(20 * MIN);
    const board = await adminBoard(ev.id);
    const [a, b, d] = [A, B, D].map(p => rowOf(board, p));
    expect([a.score, b.score, d.score], "PRECONDITION: one score; the quick answer earned nothing").toEqual([100, 100, 100]);
    expect([a.allSolved, b.allSolved, d.allSolved], "all three finished every scoring challenge").toEqual([true, true, true]);
    expect(a.finishTime, "A finished at their last SCORING solve, not at the quick answer 40 minutes later").toBe(iso(T0 + 10 * MIN));
    expect(a.solveTimeMs).toBe(10 * MIN);
    expect(d.solveTimeMs, "CONTROL: a scoring solve at the quick answer's moment does move the finish time").toBe(50 * MIN);
    expect([a.rank, b.rank, d.rank], "the quick answer cost A nothing; the scoring solve put D last").toEqual([1, 2, 3]);
    expect(rowOf(board, E), "E never entered, so is not on the board").toBeUndefined();
  });
});

test.describe("A quick answer alone is not taking part", () => {
  test("no participation certificate is offered or minted for it; a wrong scoring answer earns one (control)", async () => {
    const ev = await makeCompetition(sa, saCsrf, "tookpart", { start_time: iso(Date.now() - HOUR), duration_minutes: 600, add_qualifying: true });
    const quick = quickOf(ev.id);
    expect(quick.length, "PRECONDITION: the four quick questions").toBe(4);
    const s1 = await makeTask(sa, saCsrf, "tp-s1"), s2 = await makeTask(sa, saCsrf, "tp-s2");
    s1.id = (await assignTask(sa, saCsrf, s1.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    s2.id = (await assignTask(sa, saCsrf, s2.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    const Q = await makeParticipant(sa, saCsrf, "tp-quickonly"), W = await makeParticipant(sa, saCsrf, "tp-wrong");
    const C = await makeParticipant(sa, saCsrf, "tp-scorer");
    await enrol(sa, saCsrf, ev.id, [Q.id, W.id, C.id]);
    for (const p of [Q, W, C]) await enter(p, ev.id);
    expect((await answer(Q, ev.id, quick[0].id, pick(quick[0]))).qualifying, "PRECONDITION: Q's one answer is a quick one").toBe(true);
    expect((await answer(W, ev.id, s1.id, "not it")).correct, "PRECONDITION: W's one answer is a wrong scoring one").toBe(false);
    expect((await answer(C, ev.id, s1.id, "a")).correct).toBe(true);
    const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(saCsrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    // Both are on the final board, so a refusal is the attempt test's, not "not on the board".
    const board = await adminBoard(ev.id);
    const row = (p) => board.find(r => r.userId === p.id) || {};
    expect([row(Q).score, row(W).score, row(C).score], "PRECONDITION: Q 0 (the quick answer scores nothing), W -5, C 50").toEqual([0, -5, 50]);
    expect(typeof row(Q).rank === "number" && typeof row(W).rank === "number", "PRECONDITION: Q and W are ranked").toBe(true);

    expect(await certOffer(Q, ev.id), "Q is offered nothing: neither the certificates list nor the board's call to action").toEqual({ listed: false, cta: false });
    const mq = await certMint(Q, ev.id);
    expect({ status: mq.status, code: mq.body.code }, JSON.stringify(mq.body)).toEqual({ status: 403, code: "not_attempted" });
    // CONTROL: one wrong scoring answer is taking part.
    expect(await certOffer(W, ev.id), "CONTROL: W is offered a certificate on both surfaces").toEqual({ listed: true, cta: true });
    const mw = await certMint(W, ev.id);
    expect(mw.status, JSON.stringify(mw.body)).toBe(200);
    expect(mw.body.basis, "a participation certificate (no points above zero)").toBe("participation");
  });

  test("a hint revealed on an older qualifying question alone is not taking part; a hint on a scoring challenge is (control)", async () => {
    const ev = await makeCompetition(sa, saCsrf, "hinted", { start_time: iso(Date.now() - HOUR), duration_minutes: 600, add_qualifying: false });
    // An older qualifying challenge of another type, which may still carry a
    // hint: the tag written as a release before the pick-one rule left it (no
    // route tags a text challenge now: tests/qualifying-pick-one.spec.js).
    const QH = await makeTask(sa, saCsrf, "hq-legacy", { hint: "<p>Look left</p>" });
    const key = `hq${uniq("k").replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 40);
    write(db => db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(QH.id, `qualifying:${key}`));
    const SH = await makeTask(sa, saCsrf, "hs-scoring", { hint: "<p>Look right</p>" });
    QH.id = (await assignTask(sa, saCsrf, QH.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    SH.id = (await assignTask(sa, saCsrf, SH.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    expect(quickOf(ev.id).map(q => [q.id, q.key]), "PRECONDITION: the event's one quick question is the planted one").toEqual([[QH.id, key]]);
    const HQ = await makeParticipant(sa, saCsrf, "hq-hintonly"), HS = await makeParticipant(sa, saCsrf, "hs-hintonly");
    await enrol(sa, saCsrf, ev.id, [HQ.id, HS.id]);
    for (const p of [HQ, HS]) await enter(p, ev.id);
    expect((await revealHint(HQ, ev.id, QH.id)).pointsDeducted, "PRECONDITION: HQ's one act, a free hint on the quick question").toBe(0);
    expect((await revealHint(HS, ev.id, SH.id)).pointsDeducted, "PRECONDITION: HS's one act, a priced hint on a scoring challenge").toBe(15);
    const acts = (p) => sql(db => ({
      answers: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE competition_id=? AND user_id=?").get(ev.id, p.id).n,
      hints: db.prepare("SELECT task_id FROM hint_reveals WHERE competition_id=? AND user_id=?").all(ev.id, p.id).map(r => r.task_id),
    }));
    expect([acts(HQ), acts(HS)], "PRECONDITION: no answer from either; one hint each").toEqual([{ answers: 0, hints: [QH.id] }, { answers: 0, hints: [SH.id] }]);
    const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(saCsrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    // Both are on the final board, so a refusal is the attempt test's, not "not on the board".
    const board = await adminBoard(ev.id);
    const row = (p) => board.find(r => r.userId === p.id) || {};
    expect([row(HQ).score, row(HS).score], "PRECONDITION: HQ 0 (the quick question's hint is free), HS -15").toEqual([0, -15]);
    expect(typeof row(HQ).rank === "number" && typeof row(HS).rank === "number", "PRECONDITION: HQ and HS are ranked").toBe(true);

    expect(await certOffer(HQ, ev.id), "HQ is offered nothing: neither the certificates list nor the board's call to action").toEqual({ listed: false, cta: false });
    const mq = await certMint(HQ, ev.id);
    expect({ status: mq.status, code: mq.body.code }, JSON.stringify(mq.body)).toEqual({ status: 403, code: "not_attempted" });
    // CONTROL: a hint on a scoring challenge alone is taking part.
    expect(await certOffer(HS, ev.id), "CONTROL: HS is offered a certificate on both surfaces").toEqual({ listed: true, cta: true });
    const ms = await certMint(HS, ev.id);
    expect(ms.status, JSON.stringify(ms.body)).toBe(200);
    expect(ms.body.basis, "a participation certificate (no points above zero)").toBe("participation");
  });
});

test.describe("Recalculate scores a qualifying question 0", () => {
  test("a stored answer, a WRONG one and a hint are re-priced to 0 for a qualifying question, and to its points and the penalty for a scoring pick-one question (control)", async () => {
    const ev = await makeCompetition(sa, saCsrf, "recalc", { start_time: iso(Date.now() - HOUR), duration_minutes: 600 });
    const Q = await makeTask(sa, saCsrf, "rc-quick", PICK_ONE), P = await makeTask(sa, saCsrf, "rc-scoring", PICK_ONE);
    const X = await makeTask(sa, saCsrf, "rc-open");   // left unsolved: keeps the all-solved end away
    const key = `rc${uniq("k").replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 40);
    const tg = await sa.post(`/api/admin/tasks/${Q.id}/tags`, { headers: H(saCsrf), data: { tag: `qualifying:${key}` } });
    expect(tg.ok(), `tag: ${tg.status()} ${await tg.text()}`).toBeTruthy();
    for (const t of [Q, P, X]) t.id = (await assignTask(sa, saCsrf, t.id, [ev.id])).copies[0].task_id;   // the event's own copies
    const p = await makeParticipant(sa, saCsrf, "rc-p"), w = await makeParticipant(sa, saCsrf, "rc-empty");
    await enrol(sa, saCsrf, ev.id, [p.id, w.id]);
    await enter(p, ev.id);
    expect((await answer(p, ev.id, Q.id, JSON.stringify([optionIds(Q.id)[0]]))).qualifying).toBe(true);
    expect((await answer(p, ev.id, P.id, JSON.stringify([optionIds(P.id)[0]]))).correct).toBe(true);
    const sub = (t, u = p) => sql(db => db.prepare("SELECT is_correct, points_delta FROM submissions WHERE competition_id=? AND user_id=? AND task_id=?").get(ev.id, u.id, t.id));
    const hint = (t) => sql(db => db.prepare("SELECT points_deducted FROM hint_reveals WHERE competition_id=? AND user_id=? AND task_id=?").get(ev.id, p.id, t.id).points_deducted);
    expect([sub(Q), sub(P)], "PRECONDITION: the submit priced them 0 and 50").toEqual([{ is_correct: 1, points_delta: 0 }, { is_correct: 1, points_delta: 50 }]);
    // Each row and hint planted at the OTHER challenge's price (a row stored
    // before the tag, an older release), so each Recalculate must change both.
    // `w` holds a WRONG row on each: an empty stored selection, which the submit
    // now refuses but an older release stored, and Recalculate grades wrong.
    write(db => {
      db.prepare("UPDATE submissions SET points_delta=? WHERE competition_id=? AND user_id=? AND task_id=?").run(50, ev.id, p.id, Q.id);
      db.prepare("UPDATE submissions SET points_delta=? WHERE competition_id=? AND user_id=? AND task_id=?").run(0, ev.id, p.id, P.id);
      const ins = db.prepare("INSERT INTO hint_reveals (competition_id, user_id, task_id, points_deducted, revealed_at) VALUES (?,?,?,?,?)");
      ins.run(ev.id, p.id, Q.id, 15, iso(Date.now()));
      ins.run(ev.id, p.id, P.id, 0, iso(Date.now()));
      const empty = db.prepare(`INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, answer, answer_canonical, is_correct, points_delta, submitted_at, updated_at)
        VALUES (?,?,?,?,NULL,'(nothing selected)','[]',0,?,?,?)`);
      const at = iso(Date.now() - 30 * MIN);
      empty.run(require("crypto").randomUUID(), w.id, Q.id, ev.id, -5, at, at);
      empty.run(require("crypto").randomUUID(), w.id, P.id, ev.id, 0, at, at);
    });
    expect([sub(Q, w), sub(P, w)], "PRECONDITION: the wrong rows, each at the other's price").toEqual([{ is_correct: 0, points_delta: -5 }, { is_correct: 0, points_delta: 0 }]);
    const recalc = async (t) => {
      const r = await sa.post(`/api/admin/tasks/${t.id}/recalculate`, { headers: H(saCsrf), data: { confirm_live: true } });
      expect(r.status(), await r.text()).toBe(200);
      return r.json();
    };
    expect(await recalc(Q), "the qualifying question's answers and hint are re-priced").toMatchObject({ total_submissions: 2, flipped: 2, hints_rescaled: 1 });
    expect(sub(Q), "a qualifying answer scores 0").toEqual({ is_correct: 1, points_delta: 0 });
    expect(sub(Q, w), "a wrong one costs nothing: no penalty on a qualifying question").toEqual({ is_correct: 0, points_delta: 0 });
    expect(hint(Q), "and its hint costs nothing").toBe(0);
    expect(await recalc(P), "CONTROL: the scoring question's too").toMatchObject({ total_submissions: 2, flipped: 2, hints_rescaled: 1 });
    expect(sub(P), "CONTROL: a scoring pick-one answer earns an easy challenge's points").toEqual({ is_correct: 1, points_delta: 50 });
    expect(sub(P, w), "CONTROL: the same empty selection on a scoring question is graded wrong and costs the penalty").toEqual({ is_correct: 0, points_delta: -5 });
    expect(hint(P), "CONTROL: and its hint costs 30% of them").toBe(15);
  });
});

test.describe("A Booth Event where staff compete is seeded no quick questions", () => {
  test("left unsaid, add_qualifying gives a staff-compete Booth Event none; the same create without staff competing gets the four (control)", async () => {
    const create = async (label, extra) => {
      const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
        name: `QD ${uniq(label)}`, event_kind: "booth", start_time: iso(Date.now() + 24 * HOUR), duration_minutes: 60, ...extra } });
      expect(r.status(), await r.text()).toBe(200);
      return (await r.json()).competition;
    };
    const compete = await create("compete", { staff_compete: true });
    const row = sql(db => db.prepare("SELECT event_kind, staff_compete FROM competitions WHERE id=?").get(compete.id));
    expect(row, "PRECONDITION: a Booth Event where staff compete").toEqual({ event_kind: "booth", staff_compete: 1 });
    expect(quickOf(compete.id), "no quick question in an event that admits sealed challenges only").toEqual([]);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM competition_tasks WHERE competition_id=?").get(compete.id).n), "nothing at all was seeded").toBe(0);
    const plain = await create("plain", {});
    expect(quickOf(plain.id).map(q => q.key), "CONTROL: a Booth Event's create seeds the four built-in quick questions")
      .toEqual(["developers", "evaluating", "follow_up", "scanner"]);
  });
});

test.describe("A malformed qualifying tag an older import stored", () => {
  test("the challenge list and the challenge itself both call it a quick question, as scoring does; an untagged one neither (control)", async () => {
    const ev = await makeCompetition(sa, saCsrf, "badtag");
    const Q = await makeTask(sa, saCsrf, "badtag-q", PICK_ONE), T = await makeTask(sa, saCsrf, "badtag-t");
    Q.id = (await assignTask(sa, saCsrf, Q.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    T.id = (await assignTask(sa, saCsrf, T.id, [ev.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    // The shape an import stored before it refused a malformed key: no route adds one now.
    write(db => db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)").run(Q.id, "qualifying:bad key!"));
    const P = await makeParticipant(sa, saCsrf, "badtag-p");
    await enrol(sa, saCsrf, ev.id, [P.id]);
    await enter(P, ev.id);
    const s = await signIn(P);
    const list = await s.api.get("/api/tasks", { headers: { "x-competition-id": ev.id } });
    expect(list.ok(), await list.text()).toBeTruthy();
    const rows = await list.json();
    const flag = (id) => { const r = rows.find(x => x.id === id); expect(r, `PRECONDITION: ${id} is listed`).toBeTruthy(); return r.qualifying; };
    const detail = async (id) => {
      const r = await s.api.get(`/api/tasks/${id}`, { headers: { "x-competition-id": ev.id } });
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).qualifying;
    };
    expect([flag(Q.id), await detail(Q.id)], "the list agrees with the challenge's own view").toEqual([true, true]);
    expect([flag(T.id), await detail(T.id)], "CONTROL: an untagged challenge is not a quick question").toEqual([false, false]);
  });
});
