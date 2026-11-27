// @ts-check
//
// v8.14.5 — HOW A MULTIPLE-CHOICE ANSWER IS INTERPRETED, STORED AND RE-GRADED,
// and the gates around it.
//
// Each test below was written against a mutation that survived the whole suite
// before it existed (named in the test's comment), and was seen failing with that
// mutation applied. Where a test plants state with a direct database write, it
// is state the API refuses to create (a key naming no option, two options with
// one label, a row from before `answer_canonical`), which is exactly the state
// the guarded line exists for.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { withLegacySharedAssign } = require("./event-admin-helpers");
const {
  H, uniq, makeParticipant, makeCompetition, assignTask, grantEventAdmin,
  dbAll, dbGet, dbRun, storedTask, storedIds, signIn, asPlayer, mkTask, mkChoice, liveEvent, playerIn,
  readTask, answer, pick, setTicks,
} = require("./choice-locks-fixture");

test.use({ baseURL: BASE });

const tagOf = (label) => uniq(label).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const rowsOf = (userId, taskId) =>
  dbAll("SELECT answer, answer_canonical, is_correct, points_delta FROM submissions WHERE user_id=? AND task_id=? ORDER BY rowid", userId, taskId);

async function recalculate(sa, csrf, taskId) {
  const r = await sa.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: H(csrf), data: { confirm_live: true } });
  expect(r.ok(), `recalculate: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

test.describe("v8.14.5 — interpreting, storing and re-grading a multiple-choice answer", () => {
  test("a LOCKED challenge refuses every answer type before grading: no row, no penalty", async () => {
    // Survived before: `if (task.locked)` → `if (task.locked && req.file)` in the
    // submit route. Only the file path had a test, so text, choice and any
    // answers to a locked challenge were graded and scored.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("lock");
    const choiceBank = await mkChoice(sa, csrf, [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }]);
    const textBank = await mkTask(sa, csrf, { answer_type: "text", correct_answer: `KEY_${T}` });
    const anyIdBank = await mkTask(sa, csrf, { answer_type: "any" });
    const ev = await liveEvent(sa, csrf, "lock", [choiceBank, textBank, anyIdBank]);
    const [choice, text, anyId] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "lock", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    // Read every grading token BEFORE locking: a locked read is not the subject.
    const tokens = {};
    for (const id of [choice, text, anyId]) tokens[id] = (await readTask(s.api, id)).grading_hash;
    for (const id of [choice, text, anyId]) {
      const l = await sa.post(`/api/admin/tasks/${id}/lock`, { headers: H(csrf) });
      expect((await l.json()).locked, "PRECONDITION: locked").toBe(1);
    }
    const right = storedIds(choice).correct;
    for (const [id, ans] of [[choice, JSON.stringify(right)], [text, `KEY_${T}`], [anyId, "anything at all"]]) {
      const r = await s.api.post(`/api/tasks/${id}/submit`, {
        headers: { "x-csrf-token": s.csrf }, multipart: { answer: ans, gradingHash: tokens[id] },
      });
      expect(r.status(), `a locked ${storedTask(id).answer_type} challenge refuses: ${await r.text()}`).toBe(423);
      expect(rowsOf(p.id, id), "nothing was stored or scored").toEqual([]);
    }
    // CONTROL: unlocked, the same answer is graded.
    const u = await sa.post(`/api/admin/tasks/${choice}/lock`, { headers: H(csrf) });
    expect((await u.json()).locked).toBe(0);
    expect((await answer(s.api, s.csrf, choice, JSON.stringify(right))).body.correct).toBe(true);
    await s.api.dispose(); await sa.dispose();
  });

  test("one ended session beside a live one freezes the correct options; reordering a multi-answer set counts", async () => {
    // Survived before: competitionAnySlotEnded → competitionFullyEnded in the task
    // PUT's freeze. Every freeze test ended the WHOLE event, where the two agree.
    // Also pins the corrected rule that the freeze compares the ORDERED key
    // string: reordering the options of a 2+-correct challenge changes it.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("frz");
    const ev = await makeCompetition(sa, csrf, "frz", { start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240 });
    const slot = async (name, startAgo) => {
      const r = await sa.post(`/api/admin/competitions/${ev.id}/timeslots`, { headers: H(csrf), data: {
        name, start_time: new Date(Date.now() - startAgo).toISOString(), duration_minutes: 120 } });
      expect(r.ok(), `session ${name}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot.id;
    };
    const slotA = await slot("A", 60_000);
    const slotB = await slot("B", 30_000);
    const singleBank = await mkChoice(sa, csrf, [{ text: `S1_${T}`, correct: true }, { text: `S2_${T}` }, { text: `S3_${T}` }]);
    const multiBank = await mkChoice(sa, csrf, [{ text: `M1_${T}`, correct: true }, { text: `M2_${T}` }, { text: `M3_${T}`, correct: true }]);
    // The event's own copies (lib/event-copies.js): the ended session freezes those.
    const single = (await assignTask(sa, csrf, singleBank, [ev.id])).copies[0].task_id;
    const multi = (await assignTask(sa, csrf, multiBank, [ev.id])).copies[0].task_id;
    const end = await sa.post(`/api/admin/competitions/${ev.id}/timeslots/${slotA}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end session A: ${await end.text()}`).toBeTruthy();
    const comp = (await (await sa.get("/api/admin/competitions")).json()).find((c) => c.id === ev.id);
    expect(comp.status, "PRECONDITION: the event is still live").toBe("live");
    expect(comp.timeslots.find((t) => t.id === slotA).status, "PRECONDITION: A has ended").toBe("ended");
    expect(comp.timeslots.find((t) => t.id === slotB).status, "PRECONDITION: B is live").toBe("live");

    const before = storedTask(single);
    const title = await sa.put(`/api/admin/tasks/${single}`, { headers: H(csrf), data: { title: `${before.title} typo` } });
    expect(title.status(), `CONTROL: a title edit is not frozen: ${await title.text()}`).toBe(200);
    const moved = await setTicks(sa, csrf, single, [`S2_${T}`]);
    expect(moved.status(), "moving the tick is frozen").toBe(409);
    expect(await moved.text()).toMatch(/Cannot change scoring/);
    const switched = await sa.put(`/api/admin/tasks/${single}`, { headers: H(csrf), data: { answer_type: "text", correct_answer: "x" } });
    expect(switched.status(), "switching the type is frozen").toBe(409);
    expect(storedTask(single).correct_answer).toBe(before.correct_answer);

    // Reordering: the single-correct key string is unchanged, the multi one is not.
    const reorder = (id) => {
      const { opts, correct } = storedIds(id);
      return sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: {
        choices: [...opts].reverse().map((o) => ({ id: o.id, text: o.text, correct: correct.includes(o.id) })) } });
    };
    expect((await reorder(single)).status(), "CONTROL: reordering a single-correct set is not a scoring edit").toBe(200);
    const multiBefore = storedTask(multi).correct_answer;
    const mr = await reorder(multi);
    expect(mr.status(), "reordering a multi-answer set changes the stored key, so it is frozen").toBe(409);
    expect(storedTask(multi).correct_answer).toBe(multiBefore);
    await sa.dispose();
  });

  test("the stored key lists the correct ids in OPTION order, whatever order the ticks arrive in", async () => {
    // Survived before: validateChoices storing JSON.stringify([...correct].reverse()).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("ord");
    const id = await mkChoice(sa, csrf, [
      { text: `A_${T}`, correct: true }, { text: `B_${T}` }, { text: `C_${T}`, correct: true }, { text: `D_${T}` }]);
    let { byText, row } = storedIds(id);
    expect(row.correct_answer).toBe(JSON.stringify([byText[`A_${T}`], byText[`C_${T}`]]));
    // The PUT sends D before A in its tick list's natural order: still option order.
    expect((await setTicks(sa, csrf, id, [`D_${T}`, `A_${T}`])).ok()).toBeTruthy();
    ({ byText, row } = storedIds(id));
    expect(row.correct_answer).toBe(JSON.stringify([byText[`A_${T}`], byText[`D_${T}`]]));
    await sa.dispose();
  });

  test("Recalculate re-grades choice answers against the CURRENT key", async () => {
    // Survived before: `correct = gradeChoice(picked, _correctIds)` →
    // `correct = !!s.is_correct` — Recalculate then kept every old verdict.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("rc");
    const idBank = await mkChoice(sa, csrf, [{ text: `A_${T}`, correct: true }, { text: `B_${T}` }, { text: `C_${T}` }]);
    const ev = await liveEvent(sa, csrf, "rc", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p1 = await playerIn(sa, csrf, "rc1", [ev.id]);
    const p2 = await playerIn(sa, csrf, "rc2", [ev.id]);
    const s1 = await asPlayer(p1.email, ev.id);
    const s2 = await asPlayer(p2.email, ev.id);
    expect((await pick(s1.api, s1.csrf, id, [`A_${T}`])).body.correct).toBe(true);
    expect((await pick(s2.api, s2.csrf, id, [`B_${T}`])).body.correct).toBe(false);
    expect((await setTicks(sa, csrf, id, [`B_${T}`])).ok(), "PRECONDITION: the key moves").toBeTruthy();

    await recalculate(sa, csrf, id);
    expect(rowsOf(p1.id, id).map((r) => r.is_correct), "the old-key answer is now wrong").toEqual([0]);
    expect(rowsOf(p2.id, id).map((r) => r.is_correct), "the new-key answer is now right").toEqual([1]);
    expect(rowsOf(p2.id, id)[0].points_delta).toBeGreaterThan(0);
    await s1.api.dispose(); await s2.api.dispose(); await sa.dispose();
  });

  test("a legacy row whose label two options share is left alone; a resolvable one is re-graded", async () => {
    // Survived before: `byText.set(k, byText.has(k) ? null : c.id)` → `set(k, c.id)`,
    // which graded an ambiguous label as whichever option came last.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("leg");
    const idBank = await mkChoice(sa, csrf, [{ text: `Alpha${T}`, correct: true }, { text: `Beta${T}` }, { text: `Gamma${T}` }]);
    const ev = await liveEvent(sa, csrf, "leg", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p1 = await playerIn(sa, csrf, "leg1", [ev.id]);
    const p2 = await playerIn(sa, csrf, "leg2", [ev.id]);
    const s1 = await asPlayer(p1.email, ev.id);
    const s2 = await asPlayer(p2.email, ev.id);
    expect((await pick(s1.api, s1.csrf, id, [`Alpha${T}`])).body.correct).toBe(true);
    expect((await pick(s2.api, s2.csrf, id, [`Beta${T}`])).body.correct).toBe(false);
    // Both rows become pre-v7.20.9 rows, and the LAST option takes Alpha's label
    // (case and spacing folded) — a state the editor refuses, which an old import allowed.
    dbRun("UPDATE submissions SET answer_canonical=NULL WHERE task_id=?", id);
    const { opts, byText } = storedIds(id);
    const planted = opts.map((o) => (o.text === `Gamma${T}` ? { ...o, text: `  alpha${T.toLowerCase()} ` } : o));
    dbRun("UPDATE tasks SET choices=?, correct_answer=? WHERE id=?",
      JSON.stringify(planted), JSON.stringify([byText[`Beta${T}`]]), id);

    const rc = await recalculate(sa, csrf, id);
    expect(rc.unresolved, "the ambiguous row is counted, not guessed").toBe(1);
    expect(rowsOf(p1.id, id).map((r) => r.is_correct), "and left exactly as it was").toEqual([1]);
    expect(rowsOf(p2.id, id).map((r) => r.is_correct), "CONTROL: the unambiguous legacy row is re-graded").toEqual([1]);
    await s1.api.dispose(); await s2.api.dispose(); await sa.dispose();
  });

  test("after a switch away from multiple choice, Recalculate re-grades the old answers under the new rule", async () => {
    // Survived before: skipping every row with an answer_canonical once the
    // challenge is no longer a choice one, which left them on their old verdicts.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("sw");
    const idBank = await mkChoice(sa, csrf, [{ text: `Paris${T}`, correct: true }, { text: `Rome${T}` }]);
    const ev = await liveEvent(sa, csrf, "sw", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p1 = await playerIn(sa, csrf, "sw1", [ev.id]);
    const p2 = await playerIn(sa, csrf, "sw2", [ev.id]);
    const s1 = await asPlayer(p1.email, ev.id);
    const s2 = await asPlayer(p2.email, ev.id);
    expect((await pick(s1.api, s1.csrf, id, [`Paris${T}`])).body.correct).toBe(true);
    expect((await pick(s2.api, s2.csrf, id, [`Rome${T}`])).body.correct).toBe(false);
    const sw = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { answer_type: "text", correct_answer: `Rome${T}` } });
    expect(sw.ok(), `switch to text: ${await sw.text()}`).toBeTruthy();

    await recalculate(sa, csrf, id);
    expect(rowsOf(p2.id, id).map((r) => r.is_correct), "the stored label now matches the text key").toEqual([1]);
    expect(rowsOf(p1.id, id).map((r) => r.is_correct), "and the old right answer no longer does").toEqual([0]);
    await s1.api.dispose(); await s2.api.dispose(); await sa.dispose();
  });

  test("after a switch to Any answer, Recalculate leaves a stored choice answer that picked nothing wrong", async () => {
    // v8.14.6. Survived before: grading a pick of nothing ("(nothing selected)")
    // as a non-empty answer, so it became a solve. Submit refuses such a pick
    // now, so the row from before that is planted from a real wrong pick. The
    // empty stored selection is what marks it: an option may carry that text.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("anysw");
    const idBank = await mkChoice(sa, csrf, [{ text: `Paris${T}`, correct: true }, { text: `Rome${T}` }, { text: "(nothing selected)" }]);
    const ev = await liveEvent(sa, csrf, "anysw", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "anysw", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    for (const texts of [[`Rome${T}`], ["(nothing selected)"], [`Paris${T}`, `Rome${T}`], [`Rome${T}`, "(nothing selected)"]]) {
      expect((await pick(s.api, s.csrf, id, texts)).body.correct, texts.join("+")).toBe(false);
    }
    const rows = dbAll("SELECT id, answer, answer_canonical FROM submissions WHERE user_id=? AND task_id=? ORDER BY rowid", p.id, id);
    expect(rows).toHaveLength(4);
    // Row 1 is a REAL pick of the option named "(nothing selected)": the same
    // text as a pick of nothing, with a real id.
    expect([rows[1].answer, JSON.parse(rows[1].answer_canonical)], "PRECONDITION: the text collides")
      .toEqual(["(nothing selected)", [storedIds(id).byText["(nothing selected)"]]]);
    // Row 2 becomes a pick of nothing from before the refusal. Row 3 becomes
    // the same text with no stored selection: a typed answer, still an answer.
    dbRun("UPDATE submissions SET answer='(nothing selected)', answer_canonical='[]' WHERE id=?", rows[2].id);
    dbRun("UPDATE submissions SET answer='(nothing selected)', answer_canonical=NULL WHERE id=?", rows[3].id);
    const sw = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { answer_type: "any" } });
    expect(sw.ok(), `switch to any: ${await sw.text()}`).toBeTruthy();

    await recalculate(sa, csrf, id);
    expect(rowsOf(p.id, id).map((r) => [r.is_correct, r.points_delta]),
      "every real pick and the typed text become correct; only the pick of nothing stays wrong")
      .toEqual([[1, 50], [1, 50], [0, -5], [1, 50]]);
    await s.api.dispose(); await sa.dispose();
  });

  test("a JSON answer holding anything but ids is refused; ids are taken verbatim; a bare id is one id", async () => {
    // Survived before: parseSubmittedIds keeping every element as String(x);
    // since v8.14.6, dropping the non-strings and grading what is left.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("ids");
    const opts = [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }];
    const a = await mkChoice(sa, csrf, opts);
    const b = await mkChoice(sa, csrf, opts);
    const ev = await liveEvent(sa, csrf, "ids", [a, b]);
    const p = await playerIn(sa, csrf, "ids", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    const ra = storedIds(a).correct[0], rb = storedIds(b).correct[0];
    expect((await answer(s.api, s.csrf, a, JSON.stringify([ra, 5, null, [ra]]))).status,
      "non-strings are refused, not dropped or turned into ids").toBe(400);
    expect((await answer(s.api, s.csrf, a, JSON.stringify([[ra]]))).status,
      "a nested id is not an id, though String() would make it one").toBe(400);
    expect((await answer(s.api, s.csrf, a, JSON.stringify([ra]))).body.correct, "CONTROL: the id alone").toBe(true);
    expect((await answer(s.api, s.csrf, b, JSON.stringify([` ${rb}`]))).status, "ids are not trimmed").toBe(400);
    expect((await answer(s.api, s.csrf, b, rb)).body.correct, "CONTROL: a bare id is that id").toBe(true);
    await s.api.dispose(); await sa.dispose();
  });

  test("a position number is never read as an option", async () => {
    // Survived before: mapping a 1-2 digit answer to the option at that index.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("pos");
    const id = await mkChoice(sa, csrf, [{ text: `First${T}`, correct: true }, { text: `Second${T}` }, { text: `Third${T}` }]);
    const ev = await liveEvent(sa, csrf, "pos", [id]);
    const p = await playerIn(sa, csrf, "pos", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    expect(storedIds(id).opts[0].text, "PRECONDITION: the right option is at index 0").toBe(`First${T}`);
    for (const ans of ["0", '["0"]', "1"]) {
      const r = await answer(s.api, s.csrf, id, ans);
      expect(r.status, `"${ans}" is not an option: ${r.text}`).toBe(400);
    }
    expect((await pick(s.api, s.csrf, id, [`First${T}`])).body.correct, "CONTROL").toBe(true);
    await s.api.dispose(); await sa.dispose();
  });

  test("an answer that is not one or more of the challenge's options is refused before grading: no row, no penalty, no attempt", async () => {
    // v8.14.6. Survived before: grading these as wrong answers (a -5 and a
    // stored row; a pick of nothing was kept as "(nothing selected)"). Each half
    // of the refusal has its own cases: the empty-pick ones and the not-an-option ones.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("ref");
    const idBank = await mkChoice(sa, csrf, [{ text: `Paris${T}`, correct: true }, { text: `Rome${T}` }], { attempt_cap: 1 });
    const ev = await liveEvent(sa, csrf, "ref", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "ref", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    const { byText } = storedIds(id);
    const paris = byText[`Paris${T}`], rome = byText[`Rome${T}`];
    const cases = [
      ["nothing picked", "[]"],
      ["an empty answer", ""],
      ["numbers, not ids", "[1,2]"],
      ["an id that names no option", JSON.stringify(["zzzzzzzz"])],
      ["an option's label instead of its id", `Paris${T}`],
      ["a real option plus one that is not", JSON.stringify([rome, "zzzzzzzz"])],
      ["the right option plus one that is not", JSON.stringify([paris, "zzzzzzzz"])],
    ];
    for (const [what, raw] of cases) {
      const r = await answer(s.api, s.csrf, id, raw);
      expect(r.status, `${what}: ${r.text}`).toBe(400);
      expect(r.body.error, what).toBe("Choose one or more of this challenge's options.");
      expect(r.body.correct, `${what}: refused, not graded`).toBeUndefined();
    }
    expect(rowsOf(p.id, id), "nothing was stored, so no penalty either").toEqual([]);
    // CONTROL: a real wrong pick is still graded, and it is the one attempt the
    // cap allows, so none of the refusals spent one.
    const real = await pick(s.api, s.csrf, id, [`Rome${T}`]);
    expect(real.status, real.text).toBe(200);
    expect(real.body.correct).toBe(false);
    expect([real.body.attempts, real.body.attempts_left], "the refusals spent no attempt").toEqual([1, 0]);
    expect(rowsOf(p.id, id).map((r) => [r.answer, r.points_delta])).toEqual([[`Rome${T}`, -5]]);
    await s.api.dispose(); await sa.dispose();
  });

  test("an id that names no option is refused, even when the stored key names it", async () => {
    // Survived before: dropping the not-an-option half of the refusal. Only a key
    // naming a missing option (hand edit, old import) makes such an answer grade
    // CORRECT without it, so the key is planted directly.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("dang");
    const id = await mkChoice(sa, csrf, [{ text: `A_${T}`, correct: true }, { text: `B_${T}` }]);
    const dup = await mkChoice(sa, csrf, [{ text: `X_${T}`, correct: true }, { text: `Y_${T}` }]);
    const ev = await liveEvent(sa, csrf, "dang", [id, dup]);
    const p = await playerIn(sa, csrf, "dang", [ev.id]);
    const a = storedIds(id).correct[0];
    dbRun("UPDATE tasks SET correct_answer=? WHERE id=?", JSON.stringify([a, "zzzzzzzz"]), id);
    const s = await asPlayer(p.email, ev.id);
    const r = await answer(s.api, s.csrf, id, JSON.stringify([a, "zzzzzzzz"]));
    expect(r.status, `an id that is not an option is never graded: ${r.text}`).toBe(400);
    expect(rowsOf(p.id, id)).toEqual([]);
    // CONTROL: a repeated id is one pick of a real option, not a refusal.
    const x = storedIds(dup).correct[0];
    expect((await answer(s.api, s.csrf, dup, JSON.stringify([x, x]))).body.correct).toBe(true);
    await s.api.dispose(); await sa.dispose();
  });

  test("the stored answer names the picked options in the order SUBMITTED", async () => {
    // Survived before: describeSelection writing the texts in author order.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("txt");
    const idBank = await mkChoice(sa, csrf, [
      { text: `Aa${T}`, correct: true }, { text: `Bb${T}` }, { text: `Cc${T}`, correct: true }]);
    const ev = await liveEvent(sa, csrf, "txt", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "txt", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    const { byText } = storedIds(id);
    expect((await pick(s.api, s.csrf, id, [`Bb${T}`, `Aa${T}`])).body.correct).toBe(false);
    expect((await pick(s.api, s.csrf, id, [`Cc${T}`, `Aa${T}`])).body.correct).toBe(true);
    const [wrongRow, rightRow] = rowsOf(p.id, id);
    expect(wrongRow.answer, "submitted order, not author order").toBe(`Bb${T} | Aa${T}`);
    expect(JSON.parse(wrongRow.answer_canonical)).toEqual([byText[`Bb${T}`], byText[`Aa${T}`]]);
    expect(rightRow.answer, "submitted order, not author order").toBe(`Cc${T} | Aa${T}`);
    expect(JSON.parse(rightRow.answer_canonical)).toEqual([byText[`Cc${T}`], byText[`Aa${T}`]]);
    await s.api.dispose(); await sa.dispose();
  });

  test("an event admin cannot change the options of a challenge another organiser's event holds", async () => {
    // Survived before: dropping the `choices` clause from `_scoringTouched`, which
    // let an option-text edit through the strict scoring gate.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("ea");
    const mine = await makeCompetition(sa, csrf, "ea-mine");
    const theirs = await makeCompetition(sa, csrf, "ea-theirs");
    const eaUser = await makeParticipant(sa, csrf, "ea-org");
    await grantEventAdmin(sa, csrf, mine.id, eaUser.id);
    const ea = await signIn(eaUser.email);
    const opts = [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }];
    const shared = await mkChoice(ea.api, ea.csrf, opts);
    const own = await mkChoice(ea.api, ea.csrf, opts);
    // ONE row held by both events — the shape a database from before event-owned
    // copies holds (built through the real doors in the previous model's mode).
    // Event copies are never shared, so this is the only way a challenge is.
    await withLegacySharedAssign(sa, csrf, async () => {
      await assignTask(ea.api, ea.csrf, shared, [mine.id]);
      await assignTask(sa, csrf, shared, [theirs.id]);
    });
    await assignTask(ea.api, ea.csrf, own, [mine.id]);

    const retext = (taskId) => {
      const { opts: o, correct } = storedIds(taskId);
      return ea.api.put(`/api/admin/tasks/${taskId}`, { headers: H(ea.csrf), data: {
        choices: o.map((c) => ({ id: c.id, text: c.text === `W_${T}` ? `Wrong_${T}` : c.text, correct: correct.includes(c.id) })) } });
    };
    const before = storedTask(shared).choices;
    const refused = await retext(shared);
    expect(refused.status(), "an option edit is a scoring edit on a shared challenge").toBe(403);
    expect((await refused.json()).code).toBe("event_admin_scoring_locked");
    expect(storedTask(shared).choices, "nothing was written").toBe(before);
    const title = await ea.api.put(`/api/admin/tasks/${shared}`, { headers: H(ea.csrf), data: { title: `T ${T} edited` } });
    expect(title.status(), "CONTROL: a title edit is not a scoring edit").toBe(200);
    expect((await retext(own)).status(), "CONTROL: the same edit on a challenge only their event holds").toBe(200);
    await ea.api.dispose(); await sa.dispose();
  });
});
