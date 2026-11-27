// @ts-check
//
// v8.14.5 — WHERE A MULTIPLE-CHOICE KEY MUST NOT GO, pinned surface by surface.
//
// Each test below was written against a mutation that survived the whole suite
// before it existed (named in the test's comment): the code was broken in an
// rsync copy, every one of the 4805 tests still passed, and this test was then
// seen failing against that same break. Most of these surfaces are guarded by a
// single line, so a refactor that drops it would otherwise ship silently.
//
// Absence is asserted BY VALUE (the key's own text or ids never appear in the
// serialised body), not only by key, beside a positive control showing the same
// value really exists where it is allowed — or a build that lost the value
// everywhere would pass every negative check here.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const {
  H, uniq, makeParticipant, makeCompetition, assignTask, enrol,
  storedTask, storedIds, dbRun, signIn, makeTier, asPlayer, mkTask, mkChoice, liveEvent, playerIn,
  readTask, answer, pick, setTicks,
} = require("./choice-locks-fixture");

test.use({ baseURL: BASE });

/** Upper-case-and-digits tag, so a key built from it cannot occur by accident. */
const tagOf = (label) => uniq(label).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

/** Turn the admin's own participant view on, then select the event. */
async function asParticipantView(ctx, compId) {
  const t = await ctx.api.post("/api/toggle-admin-view", { headers: H(ctx.csrf), data: { mode: "participant" } });
  expect(t.ok(), `toggle-admin-view: ${await t.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
}

test.describe("v8.14.5 — a multiple-choice key stays where it belongs", () => {
  test("the challenge LIST carries no key and no options, for any answer type", async () => {
    // Survived before: adding `t.choices, t.correct_answer` to the list SELECT
    // (routes/participant.js), which spreads every selected column onto the wire.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("list");
    const choiceIdBank = await mkChoice(sa, csrf, [{ text: `RIGHT_${T}`, correct: true }, { text: `WRONG_${T}` }]);
    const textIdBank = await mkTask(sa, csrf, { answer_type: "text", correct_answer: `TEXTKEY_${T}\nALTKEY_${T}` });
    const ev = await liveEvent(sa, csrf, "list", [choiceIdBank, textIdBank]);
    const [choiceId, textId] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "list", [ev.id]);
    const { correct } = storedIds(choiceId);

    const s = await asPlayer(p.email, ev.id);
    const raw = await (await s.api.get("/api/tasks")).text();
    const list = JSON.parse(raw);
    expect(list.map((t) => t.id), "PRECONDITION: both challenges are listed").toEqual(expect.arrayContaining([choiceId, textId]));
    for (const t of list) {
      expect("correct_answer" in t, `list entry ${t.title} carries no key field`).toBe(false);
      expect("choices" in t, `list entry ${t.title} carries no options`).toBe(false);
    }
    for (const v of [`TEXTKEY_${T}`, `ALTKEY_${T}`, `RIGHT_${T}`, correct[0]]) {
      expect(raw, `the list never contains ${v}`).not.toContain(v);
    }
    // CONTROLS: the options are real (the detail read shows them), and so is the key.
    expect(JSON.stringify(await readTask(s.api, choiceId))).toContain(`RIGHT_${T}`);
    expect(storedTask(textId).correct_answer).toContain(`ALTKEY_${T}`);
    await s.api.dispose(); await sa.dispose();
  });

  test("a submit response never carries the key: wrong, correct, folded repeat, or refused", async () => {
    // Survived before: `correct_answer: task.correct_answer` added to the submit
    // handler's final res.json — the first wrong guess then returned the answer.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("submit");
    const multi = await mkChoice(sa, csrf, [
      { text: `RA_${T}`, correct: true }, { text: `RB_${T}`, correct: true }, { text: `WX_${T}` }]);
    const capped = await mkChoice(sa, csrf, [{ text: `CR_${T}`, correct: true }, { text: `CW_${T}` }], { attempt_cap: 1 });
    const text = await mkTask(sa, csrf, { answer_type: "text", correct_answer: `KEYONE_${T}\nKEYTWO_${T}` });
    const ev = await liveEvent(sa, csrf, "submit", [multi, capped, text]);
    const p = await playerIn(sa, csrf, "submit", [ev.id]);
    const secrets = [...storedIds(multi).correct, ...storedIds(capped).correct, `KEYONE_${T}`];

    const s = await asPlayer(p.email, ev.id);
    const wrong = await pick(s.api, s.csrf, multi, [`WX_${T}`]);
    const folded = await pick(s.api, s.csrf, multi, [`WX_${T}`]);
    const right = await pick(s.api, s.csrf, multi, [`RB_${T}`, `RA_${T}`]);
    const textWrong = await answer(s.api, s.csrf, text, `nope_${T}`);
    const textRight = await answer(s.api, s.csrf, text, `KEYTWO_${T}`);
    const capWrong = await pick(s.api, s.csrf, capped, [`CW_${T}`]);
    const refused = await pick(s.api, s.csrf, capped, [`CR_${T}`]);

    expect(wrong.body.correct, "PRECONDITION: graded wrong").toBe(false);
    expect(folded.body.deduped, "PRECONDITION: the repeat was folded").toBe(true);
    expect(right.body.correct, "PRECONDITION: graded correct").toBe(true);
    expect(textWrong.body.correct).toBe(false);
    expect(textRight.body.correct).toBe(true);
    expect(capWrong.body.correct).toBe(false);
    expect(refused.body.refused, "PRECONDITION: the capped challenge refuses").toBe("attempts_exhausted");
    for (const [label, r] of Object.entries({ wrong, folded, right, textWrong, textRight, capWrong, refused })) {
      expect(r.status, `${label}: ${r.text}`).toBe(200);
      expect("correct_answer" in r.body, `${label} response has no key field`).toBe(false);
      for (const v of secrets) expect(r.text, `${label} response never contains ${v}`).not.toContain(v);
    }
    expect(textWrong.text, "a wrong text answer is not told an accepted one").not.toContain(`KEYTWO_${T}`);
    await s.api.dispose(); await sa.dispose();
  });

  test("out of attempts but unsolved: no key until the end-of-event reveal", async () => {
    // Survived before: widening the solver concession to `solved || exhausted`.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("exh");
    const capped = await mkChoice(sa, csrf, [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }, { text: `V_${T}` }], { attempt_cap: 1 });
    const ev = await liveEvent(sa, csrf, "exh", [capped], { reveal_answers_on_end: true });
    const out = await playerIn(sa, csrf, "exh-out", [ev.id]);
    const solver = await playerIn(sa, csrf, "exh-solver", [ev.id]);
    const { correct } = storedIds(capped);
    const keyStr = JSON.stringify(correct);

    const a = await asPlayer(out.email, ev.id);
    expect((await pick(a.api, a.csrf, capped, [`W_${T}`])).body.correct).toBe(false);
    const mid = await readTask(a.api, capped);
    expect(mid.attempts_left, "PRECONDITION: out of attempts").toBe(0);
    expect(mid.solved, "PRECONDITION: unsolved").toBe(false);
    expect("correct_answer" in mid, "no key for an exhausted, unsolved participant mid-event").toBe(false);
    expect(JSON.stringify(mid)).not.toContain(keyStr);

    // CONTROL: a solver of the same challenge IS sent the key (the concession works).
    const b = await asPlayer(solver.email, ev.id);
    expect((await pick(b.api, b.csrf, capped, [`R_${T}`])).body.correct).toBe(true);
    expect((await readTask(b.api, capped)).correct_answer).toBe(keyStr);

    // CONTROL: after the end, with reveal on, the exhausted participant gets it too.
    const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    expect((await readTask(a.api, capped)).correct_answer).toBe(keyStr);
    await a.api.dispose(); await b.api.dispose(); await sa.dispose();
  });

  test("a solve is per event: solving in one event reveals nothing in another holding the challenge", async () => {
    // Survived before: dropping `AND competition_id=?` from the `solved` lookup.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("xev");
    const shared = await mkChoice(sa, csrf, [{ text: `A_${T}`, correct: true }, { text: `B_${T}` }, { text: `C_${T}` }]);
    const evA = await liveEvent(sa, csrf, "xevA", [shared]);
    const evB = await liveEvent(sa, csrf, "xevB", [shared]);
    const p = await playerIn(sa, csrf, "xev", [evA.id, evB.id]);
    const keyStr = storedTask(shared).correct_answer;

    const s = await asPlayer(p.email, evB.id);
    const b0 = await readTask(s.api, shared);
    expect(b0.solved, "PRECONDITION: unsolved in B").toBe(false);
    const selA = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: evA.id } });
    expect(selA.ok()).toBeTruthy();
    expect((await pick(s.api, s.csrf, shared, [`A_${T}`])).body.correct).toBe(true);
    const a1 = await readTask(s.api, shared);
    expect(a1.solved, "CONTROL: solved in A").toBe(true);
    expect(a1.correct_answer, "CONTROL: A's solver concession sends the key").toBe(keyStr);

    const selB = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: evB.id } });
    expect(selB.ok()).toBeTruthy();
    const b1 = await readTask(s.api, shared);
    expect(b1.solved, "a solve in A is not a solve in B").toBe(false);
    expect("correct_answer" in b1, "B sends no key").toBe(false);
    expect(JSON.stringify(b1)).not.toContain(keyStr);
    await s.api.dispose(); await sa.dispose();
  });

  test("mid-event only a CHOICE solver is sent the key; a text solver is not shown the other accepted answers", async () => {
    // Survived before: removing `task.answer_type === "choice" &&` from the solver concession.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("txt");
    const text = await mkTask(sa, csrf, { answer_type: "text", correct_answer: `FIRST_${T}\nSECOND_${T}` });
    const choice = await mkChoice(sa, csrf, [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }]);
    const ev = await liveEvent(sa, csrf, "txt", [text, choice]);
    const p = await playerIn(sa, csrf, "txt", [ev.id]);

    const s = await asPlayer(p.email, ev.id);
    expect((await answer(s.api, s.csrf, text, `FIRST_${T}`)).body.correct).toBe(true);
    const t = await readTask(s.api, text);
    expect(t.solved, "PRECONDITION: solved").toBe(true);
    expect(t.competition_fully_ended, "PRECONDITION: mid-event").toBe(false);
    expect("correct_answer" in t, "a text solver gets no key mid-event").toBe(false);
    expect(JSON.stringify(t)).not.toContain(`SECOND_${T}`);

    expect((await pick(s.api, s.csrf, choice, [`R_${T}`])).body.correct).toBe(true);
    expect((await readTask(s.api, choice)).correct_answer, "CONTROL: a choice solver does get it")
      .toBe(storedTask(choice).correct_answer);
    await s.api.dispose(); await sa.dispose();
  });

  test("a sealed challenge still tells a participant whether one or several options are correct", async () => {
    // Survived before: withholding `choice_mode` wherever the seal hides the key —
    // every sealed multi-answer challenge then rendered as single-answer radios
    // and could never be answered correctly.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("mode");
    const author = await makeTier(sa, csrf, "mode-author", "admin");
    const sealedMulti = await mkChoice(author.api, author.csrf,
      [{ text: `M1_${T}`, correct: true }, { text: `M2_${T}`, correct: true }, { text: `M3_${T}` }], { answer_sealed: true });
    const sealedSingle = await mkChoice(author.api, author.csrf,
      [{ text: `S1_${T}`, correct: true }, { text: `S2_${T}` }], { answer_sealed: true });
    expect(storedTask(sealedMulti).answer_sealed, "PRECONDITION: sealed").toBe(1);
    const ev = await liveEvent(sa, csrf, "mode", [sealedMulti, sealedSingle]);
    const p = await playerIn(sa, csrf, "mode", [ev.id]);

    const s = await asPlayer(p.email, ev.id);
    const m = await readTask(s.api, sealedMulti);
    expect(m.answer_sealed, "PRECONDITION: the participant is told it is sealed").toBeTruthy();
    expect("correct_answer" in m, "PRECONDITION: the key is withheld").toBe(false);
    expect(m.choice_mode, "a sealed multi-answer challenge still renders checkboxes").toBe("multi");
    expect((await readTask(s.api, sealedSingle)).choice_mode, "CONTROL: a sealed single-answer one, radios").toBe("single");
    await s.api.dispose(); await author.api.dispose(); await sa.dispose();
  });

  test("the stored options are {id, text} only: a correct flag never lands beside them", async () => {
    // Survived before: validateChoices writing `correct` into each stored option.
    // Options ship to readers the key is withheld from (a sealed challenge's admin
    // list, its export, its History), so a flag stored there would hand it out.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("store");
    const id = await mkChoice(sa, csrf, [
      { text: `R_${T}`, correct: true, extra: "x" }, { text: `W_${T}`, correct: false, note: 1 }, { text: `V_${T}` }]);
    const keysOf = () => JSON.parse(storedTask(id).choices).map((o) => Object.keys(o).sort().join(","));
    expect(keysOf(), "on create").toEqual(["id,text", "id,text", "id,text"]);
    expect((await setTicks(sa, csrf, id, [`W_${T}`])).ok(), "PRECONDITION: the PUT is accepted").toBeTruthy();
    expect(keysOf(), "after a PUT").toEqual(["id,text", "id,text", "id,text"]);
    expect(storedTask(id).choices).not.toMatch(/correct/i);
    // CONTROL: the key moved, so the PUT really re-validated the options.
    const { byText, correct } = storedIds(id);
    expect(correct).toEqual([byText[`W_${T}`]]);
    await sa.dispose();
  });

  test("a sealed choice challenge's admin list row, History and export keep the options but not the key", async () => {
    // Survived before, one per surface:
    //   • the tasks export sending the key of a sealed CHOICE row (export-import.js);
    //   • the admin list deleting `choices` along with the key (challenges.js);
    //   • the versions route deleting `choices` from redacted snapshots.
    // The options are the question: a reader without the key still needs them.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("seal");
    const author = await makeTier(sa, csrf, "seal-author", "admin");
    const id = await mkChoice(author.api, author.csrf,
      [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }, { text: `V_${T}` }],
      { answer_sealed: true, explanation: `<p>WHY_${T}</p>` });
    const stored = storedTask(id);
    const keyStr = stored.correct_answer;
    expect(stored.answer_sealed, "PRECONDITION: sealed").toBe(1);
    // A second version, so History has more than the create snapshot.
    const put = await author.api.put(`/api/admin/tasks/${id}`, { headers: H(author.csrf), data: { title: `${stored.title} v2` } });
    expect(put.ok(), `title edit: ${await put.text()}`).toBeTruthy();

    // The admin list.
    const listRow = async (c) => {
      const d = await (await c.get("/api/admin/tasks")).json();
      return (d.tasks || d).find((t) => t.id === id);
    };
    const saRow = await listRow(sa);
    expect(saRow, "PRECONDITION: listed").toBeTruthy();
    expect(saRow.can_see_answer, "PRECONDITION: the superadmin has not revealed it").toBe(false);
    expect("correct_answer" in saRow, "no key on a sealed row").toBe(false);
    expect(saRow.choices, "the options stay on a sealed row").toBe(stored.choices);
    expect((await listRow(author.api)).correct_answer, "CONTROL: the author sees the key").toBe(keyStr);

    // History.
    const versions = async (c) => (await (await c.get(`/api/admin/tasks/${id}/versions`)).json()).map((v) => JSON.parse(v.snapshot));
    const saSnaps = await versions(sa);
    expect(saSnaps.length, "PRECONDITION: at least two versions").toBeGreaterThanOrEqual(2);
    for (const snap of saSnaps) {
      expect("correct_answer" in snap, "no key in a redacted snapshot").toBe(false);
      expect(JSON.stringify(snap)).not.toContain(`WHY_${T}`);
      expect(JSON.parse(snap.choices).map((o) => o.text), "the options stay in every snapshot").toEqual([`R_${T}`, `W_${T}`, `V_${T}`]);
    }
    expect((await versions(author.api)).some((s) => s.correct_answer === keyStr), "CONTROL: the author's History has the key").toBe(true);

    // The export.
    const exported = async (c) => {
      const body = await (await c.get("/api/admin/export/tasks?include_attachment_content=0")).text();
      return { body, row: JSON.parse(body).tasks.find((t) => t.title === `${stored.title} v2`) };
    };
    const saExp = await exported(sa);
    expect(saExp.row, "PRECONDITION: exported").toBeTruthy();
    expect(saExp.row.correct_answer, "no key in a non-author's export").toBeNull();
    expect(saExp.row.answer_sealed).toBe(1);
    expect(saExp.row.choices, "the options travel").toBe(stored.choices);
    expect(saExp.body).not.toContain(keyStr);
    expect((await exported(author.api)).row.correct_answer, "CONTROL: the author's export has it").toBe(keyStr);
    await author.api.dispose(); await sa.dispose();
  });

  test("a superadmin competing in an event that holds a sealed choice challenge is not shown its key at the reveal", async () => {
    // Survived before: letting the END-REVEAL arm through for a competing
    // superadmin on a choice challenge. The solver arm had a lock; this arm had none.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("comp");
    const author = await makeTier(sa, csrf, "comp-author", "admin");
    const id = await mkChoice(author.api, author.csrf, [{ text: `R_${T}`, correct: true }, { text: `W_${T}` }],
      { answer_sealed: true, explanation: `<p>WHY_${T}</p>` });
    const keyStr = storedTask(id).correct_answer;
    const ev = await makeCompetition(sa, csrf, "comp", { duration_minutes: 120, staff_compete: true, reveal_answers_on_end: true });
    await assignTask(author.api, author.csrf, id, [ev.id]);
    const bystander = await makeParticipant(sa, csrf, "comp-by");
    const competing = await makeTier(sa, csrf, "comp-su", "superadmin");
    const free = await makeTier(sa, csrf, "comp-free", "superadmin");
    await enrol(sa, csrf, ev.id, [bystander.id, competing.id]);
    const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();

    await asParticipantView(competing, ev.id);
    const raw = await (await competing.api.get(`/api/tasks/${id}`)).text();
    const g = JSON.parse(raw);
    expect(g.competition_fully_ended, "PRECONDITION: the reveal applies").toBe(true);
    expect(g.answer_withheld_reason).toBe("competing_elsewhere");
    expect("correct_answer" in g, "no key for a competing superadmin").toBe(false);
    expect(raw).not.toContain(keyStr);
    expect(raw).not.toContain(`WHY_${T}`);

    await asParticipantView(free, ev.id);
    expect((await readTask(free.api, id)).correct_answer, "CONTROL: a non-competing superadmin is shown it").toBe(keyStr);
    for (const c of [author, competing, free]) await c.api.dispose();
    await sa.dispose();
  });

  test("after the correct options change mid-event, an earlier solver is not sent the new key", async () => {
    // The v8.14.5 fix. The solver concession sent the CURRENT key to anyone
    // holding a correct row, on the premise that their set WAS the answer; after
    // a key change it handed the new answer out mid-event.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("chg");
    const idBank = await mkChoice(sa, csrf, [{ text: `A_${T}`, correct: true }, { text: `B_${T}` }, { text: `C_${T}` }]);
    const ev = await liveEvent(sa, csrf, "chg", [idBank], { reveal_answers_on_end: true });
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const early = await playerIn(sa, csrf, "chg-early", [ev.id]);
    const late = await playerIn(sa, csrf, "chg-late", [ev.id]);
    const legacy = await playerIn(sa, csrf, "chg-legacy", [ev.id]);
    const { byText } = storedIds(id);
    const keyA = JSON.stringify([byText[`A_${T}`]]), keyB = JSON.stringify([byText[`B_${T}`]]);

    const e = await asPlayer(early.email, ev.id);
    expect((await pick(e.api, e.csrf, id, [`A_${T}`])).body.correct).toBe(true);
    expect((await readTask(e.api, id)).correct_answer, "PRECONDITION: the solver is shown the key").toBe(keyA);
    // A row from before answer_canonical existed: only its label says what it picked.
    const g = await asPlayer(legacy.email, ev.id);
    expect((await pick(g.api, g.csrf, id, [`A_${T}`])).body.correct).toBe(true);
    dbRun("UPDATE submissions SET answer_canonical=NULL WHERE user_id=? AND task_id=?", legacy.id, id);
    expect((await readTask(g.api, id)).correct_answer, "a legacy row is re-derived from its label").toBe(keyA);

    const moved = await setTicks(sa, csrf, id, [`B_${T}`]);
    expect(moved.ok(), `moving the key on a live challenge is allowed: ${await moved.text()}`).toBeTruthy();
    for (const [label, ctx] of [["the early solver", e], ["the legacy solver", g]]) {
      const t = await readTask(ctx.api, id);
      expect(t.solved, `${label} keeps the solve`).toBe(true);
      expect("correct_answer" in t, `${label} is not sent the new key`).toBe(false);
      expect(JSON.stringify(t)).not.toContain(keyB);
      expect(t.answer_changed_since_solve, `${label} is told why nothing is marked`).toBe(true);
    }

    // CONTROL: a solve under the new key is shown it, with no note.
    const l = await asPlayer(late.email, ev.id);
    expect((await pick(l.api, l.csrf, id, [`B_${T}`])).body.correct).toBe(true);
    const lt = await readTask(l.api, id);
    expect(lt.correct_answer).toBe(keyB);
    expect("answer_changed_since_solve" in lt).toBe(false);

    // CONTROL: moving the key back makes the early solve match again.
    expect((await setTicks(sa, csrf, id, [`A_${T}`])).ok()).toBeTruthy();
    const back = await readTask(e.api, id);
    expect(back.correct_answer).toBe(keyA);
    expect("answer_changed_since_solve" in back).toBe(false);

    // CONTROL: at the end, with reveal on, the published key reaches everyone and the note goes.
    expect((await setTicks(sa, csrf, id, [`C_${T}`])).ok()).toBeTruthy();
    const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const after = await readTask(e.api, id);
    expect(after.correct_answer).toBe(JSON.stringify([byText[`C_${T}`]]));
    expect("answer_changed_since_solve" in after).toBe(false);
    for (const c of [e, g, l]) await c.api.dispose();
    await sa.dispose();
  });
});
