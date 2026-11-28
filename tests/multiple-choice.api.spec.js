// @ts-check
//
// v7.19.0 — multiple-choice challenges.
//
// The design in one line: the author ticks which choices are correct; one
// correct renders radios and two or more renders checkboxes; the options are
// shuffled per participant; grading is all-or-nothing on the selected SET.
//
// Two invariants carry most of the risk and are pinned hardest here:
//   • the participant payload must expose the choice TEXTS but never which are
//     correct — the whole feature is worthless if the answer ships with it;
//   • grading keys on choice IDs, never on position, because the options are
//     shuffled per participant and a position means nothing across two of them.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");

test.use({ baseURL: BASE });

const GUH = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** Create a multiple-choice task. Returns the API response. */
function mkChoiceTask(api, csrf, choices, extra = {}) {
  return api.post("/api/admin/tasks", {
    headers: GUH(csrf),
    data: {
      title: `MC ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      difficulty: "easy", answer_type: "choice",
      description: "<p>Pick the right ones</p>", choices, ...extra,
    },
  });
}

// ── shared helpers for the ext-audit round 8 locks ──────────────────────────
//
// better-sqlite3 is opened INSIDE the callback rather than at module scope:
// per-file isolation recreates the database file in a `beforeAll`, and a handle
// taken at require time would read the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

/** The stored task row, straight from SQLite — the columns the API never ships. */
function storedTask(taskId) {
  return withDb((db) => db.prepare("SELECT title, choices, correct_answer, answer_type FROM tasks WHERE id=?").get(taskId));
}

/** Publish a choice task into the seed's live competition. */
async function seedLiveChoice(sa, saCsrf, choices, extra = {}) {
  const comps = await (await sa.get("/api/admin/competitions")).json();
  const live = (comps.competitions || comps).find((c) => c.name === "Test Live");
  expect(live, "the seed's live competition must exist").toBeTruthy();
  const r = await mkChoiceTask(sa, saCsrf, choices, { status: "published", ...extra });
  expect(r.ok(), `seed task: ${r.status()} ${await r.text()}`).toBeTruthy();
  const bankId = (await r.json()).id;
  const asg = await sa.post(`/api/admin/tasks/${bankId}/competitions`, {
    headers: GUH(saCsrf), data: { competitionIds: [live.id] },
  });
  expect(asg.ok(), `assign to live: ${asg.status()} ${await asg.text()}`).toBeTruthy();
  // The live event's OWN copy (lib/event-copies.js): what alice answers and an edit is made to.
  return { taskId: (await asg.json()).copies[0].task_id, bankId, compId: live.id };
}

/**
 * One alice submission against a choice task. The grading token is fetched from
 * the task read, which is mandatory since v7.20.9 — a submission without one is
 * refused exactly like a stale one, so a test that skipped it would grade
 * nothing and assert nothing.
 */
async function aliceSubmit(compId, taskId, ids) {
  const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  await api.post("/api/select-competition", { headers: GUH(csrf), data: { competitionId: compId } });
  const body = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer: JSON.stringify(ids), gradingHash: body.grading_hash },
  });
  const out = { status: r.status(), body: await r.json() };
  await api.dispose();
  return out;
}

/**
 * A choice challenge assigned to a competition that has since ENDED — the state
 * the multi-slot scoring freeze protects. Assignment must happen while the
 * competition is still live (assignments are frozen once a session ends), so
 * the order here is create → assign → end-now.
 */
async function endedCompWithChoiceTask(sa, saCsrf, choices) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const compR = await sa.post("/api/admin/competitions", {
    headers: GUH(saCsrf),
    data: { name: `MCFreeze ${stamp}`, start_time: new Date(Date.now() - 30_000).toISOString(), duration_minutes: 60 },
  });
  expect(compR.ok(), `comp: ${compR.status()} ${await compR.text()}`).toBeTruthy();
  const compId = (await compR.json()).competition.id;
  const tR = await mkChoiceTask(sa, saCsrf, choices, { status: "published" });
  expect(tR.ok(), `task: ${tR.status()} ${await tR.text()}`).toBeTruthy();
  const bankId = (await tR.json()).id;
  const asg = await sa.post(`/api/admin/tasks/${bankId}/competitions`, {
    headers: GUH(saCsrf), data: { competitionIds: [compId] },
  });
  expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
  const taskId = (await asg.json()).copies[0].task_id;   // the event's own copy: the one frozen
  const end = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": saCsrf } });
  expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
  return { compId, taskId };
}

test.describe("Multiple choice — authoring rules (v7.19.0)", () => {
  test("a valid choice task stores options and derives the correct set from the ticks", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await mkChoiceTask(api, csrf, [
      { text: "Parameterised queries", correct: true },
      { text: "String concatenation" },
      { text: "Prepared statements", correct: true },
      { text: "Disable the WAF" },
    ]);
    expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;

    const list = await (await api.get("/api/admin/tasks")).json();
    const row = (list.tasks || list).find((t) => t.id === id);
    const choices = JSON.parse(row.choices);
    expect(choices).toHaveLength(4);
    expect(choices.map((c) => c.text)).toEqual([
      "Parameterised queries", "String concatenation", "Prepared statements", "Disable the WAF",
    ]);
    // Every choice gets a stable id; the correct SET references those ids, which
    // is what lets the options be shuffled without losing correctness.
    for (const c of choices) expect(c.id).toMatch(/^[a-f0-9]{8}$/);
    const correct = JSON.parse(row.correct_answer);
    expect(correct.sort()).toEqual([choices[0].id, choices[2].id].sort());

    await api.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("the authoring rules are enforced server-side, each with its own message", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const cases = [
      [undefined, /need a list of choices/i, "no choices at all"],
      [[{ text: "only", correct: true }], /at least 2 choices/i, "a single choice"],
      [[{ text: "a" }, { text: "b" }], /at least one choice as correct/i, "nothing ticked correct"],
      [[{ text: "a", correct: true }, { text: "b", correct: true }], /at least one choice must be incorrect/i,
        "everything ticked correct — the question cannot be got wrong"],
      [[{ text: "a", correct: true }, { text: "A" }], /same text/i, "duplicate choice text (case-insensitively)"],
      [[{ text: "a", correct: true }, { text: "   " }], /cannot be empty/i, "a whitespace-only choice"],
      [[{ text: "a", correct: true }, { text: "x".repeat(301) }], /300 characters or fewer/i, "an over-long choice"],
      [Array.from({ length: 21 }, (_, i) => ({ text: `c${i}`, correct: i === 0 })), /at most 20 choices/i, "too many choices"],
      ["not-an-array", /need a list of choices/i, "a non-array body"],
    ];
    for (const [choices, re, label] of cases) {
      const r = await mkChoiceTask(api, csrf, choices);
      expect(r.status(), `${label} must be refused, not accepted`).toBe(400);
      expect((await r.json()).error, `${label}: message should say why`).toMatch(re);
    }
    await api.dispose();
  });

  test("`choice` is a real answer_type at the DB level, and a bogus one is still refused", async () => {
    // The enum lives in FOUR places: VALID_ANSWER_TYPES, the route guard, the
    // swagger doc, and a CHECK constraint on the tasks table. The CHECK is the
    // one that does not appear in any JS grep, and it is what rejected the very
    // first choice task until the table was rebuilt — so assert through the API,
    // which exercises all four.
    const { api, csrf } = await apiLogin("superadmin");
    const ok = await mkChoiceTask(api, csrf, [{ text: "a", correct: true }, { text: "b" }]);
    expect(ok.ok(), "answer_type=choice must reach the database").toBeTruthy();
    await api.delete(`/api/admin/tasks/${(await ok.json()).id}`, { headers: { "x-csrf-token": csrf } });

    const bad = await api.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: { title: `Bogus ${Date.now()}`, difficulty: "easy", answer_type: "multiple_choice", correct_answer: "x" },
    });
    expect(bad.status(), "an unknown answer_type is still refused").toBe(400);
    await api.dispose();
  });

  test("editing keeps choice IDENTITY, and switching type cleans up after itself", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const created = await mkChoiceTask(api, csrf, [
      { text: "keep me", correct: true }, { text: "b" }, { text: "c" },
    ]);
    const id = (await created.json()).id;
    const read = async () => {
      const l = await (await api.get("/api/admin/tasks")).json();
      return (l.tasks || l).find((t) => t.id === id);
    };
    const before = JSON.parse((await read()).choices);

    // Re-send the same ids with edited text: the ids must survive, because
    // correct_answer references them and an in-flight selection does too.
    const put = await api.put(`/api/admin/tasks/${id}`, {
      headers: GUH(csrf),
      data: { choices: [
        { id: before[0].id, text: "keep me (edited)", correct: true },
        { id: before[1].id, text: "b" },
        { text: "brand new" },
      ] },
    });
    expect(put.ok(), `edit: ${put.status()} ${await put.text()}`).toBeTruthy();
    const after = JSON.parse((await read()).choices);
    expect(after[0].id, "an existing choice keeps its id across an edit").toBe(before[0].id);
    expect(after[0].text).toBe("keep me (edited)");
    expect(after).toHaveLength(3);
    expect(after[2].id, "a new choice is minted an id").toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.parse((await read()).correct_answer)).toEqual([before[0].id]);

    // Switching away from choice must drop the now-meaningless options rather
    // than leaving them to reappear if the type is switched back.
    const away = await api.put(`/api/admin/tasks/${id}`, {
      headers: GUH(csrf), data: { answer_type: "text", correct_answer: "plain" },
    });
    expect(away.ok(), `switch away: ${away.status()} ${await away.text()}`).toBeTruthy();
    const plain = await read();
    expect(plain.answer_type).toBe("text");
    expect(plain.choices, "stale options are cleared when the type changes").toBeFalsy();

    // And switching TO choice with no choices supplied is refused rather than
    // leaving a choice task with nothing to choose from.
    const back = await api.put(`/api/admin/tasks/${id}`, { headers: GUH(csrf), data: { answer_type: "choice" } });
    expect(back.status()).toBe(400);
    expect((await back.json()).error).toMatch(/requires a list of choices/i);

    await api.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});

test.describe("Multiple choice — what a participant may see (v7.19.0)", () => {
  /** Seed a published choice task into the live competition and enrol alice. */
  async function seedLiveChoiceTask(choices) {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const live = (comps.competitions || comps).find((c) => c.name === "Test Live");
    expect(live, "the seed's live competition must exist").toBeTruthy();
    const title = `MCSeed ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await mkChoiceTask(sa, saCsrf, choices, { status: "published", title });
    expect(r.ok(), `seed task: ${r.status()} ${await r.text()}`).toBeTruthy();
    const bankId = (await r.json()).id;
    const asg = await sa.post(`/api/admin/tasks/${bankId}/competitions`, {
      headers: GUH(saCsrf), data: { competitionIds: [live.id] },
    });
    expect(asg.ok(), `assign to live: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    // The live event's OWN copy (lib/event-copies.js): what alice reads and an edit is made to.
    return { sa, saCsrf, taskId: (await asg.json()).copies[0].task_id, title, compId: live.id };
  }

  async function aliceInLive(compId) {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: GUH(csrf), data: { competitionId: compId } });
    return { api, csrf };
  }

  test("the payload carries the choice TEXTS and never which are correct", async () => {
    const { sa, saCsrf, taskId, compId } = await seedLiveChoiceTask([
      { text: "Correct one", correct: true }, { text: "Wrong one" }, { text: "Also wrong" },
    ]);
    const { api, csrf } = await aliceInLive(compId);
    const body = await (await api.get(`/api/tasks/${taskId}`)).json();

    expect(body.answer_type).toBe("choice");
    expect(body.choices.map((c) => c.text).sort())
      .toEqual(["Also wrong", "Correct one", "Wrong one"]);
    // The load-bearing assertion: nothing in the payload may say which is right.
    expect(body.correct_answer, "the answer must not ship to the participant").toBeUndefined();
    const asText = JSON.stringify(body);
    for (const c of body.choices) {
      expect(Object.keys(c).sort(), "a choice exposes id + text ONLY").toEqual(["id", "text"]);
      expect(c.correct).toBeUndefined();
    }
    expect(asText).not.toMatch(/"correct"\s*:\s*true/);
    // choice_mode is what selects radios vs checkboxes.
    expect(body.choice_mode).toBe("single");

    await api.dispose();
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("options are shuffled per participant but STABLE across reloads", async () => {
    // Both halves matter. Stable, or a refresh reorders the options under
    // someone mid-read. Different per participant, or "it's the third one" is
    // shareable and the shuffle buys nothing.
    const { sa, saCsrf, taskId, compId } = await seedLiveChoiceTask(
      Array.from({ length: 8 }, (_, i) => ({ text: `Option ${i}`, correct: i === 0 })));

    const { api: aApi, csrf: aCsrf } = await aliceInLive(compId);
    const order1 = (await (await aApi.get(`/api/tasks/${taskId}`)).json()).choices.map((c) => c.id);
    const order2 = (await (await aApi.get(`/api/tasks/${taskId}`)).json()).choices.map((c) => c.id);
    expect(order2, "a reload must not reshuffle under the participant").toEqual(order1);

    // A second participant on the same task. Bob must be ENROLLED in the live
    // competition first — the seed puts him in the UPCOMING one, so without
    // this he cannot read the task at all.
    //
    // The comparison below must never sit behind an `if (res.ok())`: an earlier
    // draft did exactly that, and disabling the shuffle entirely still passed,
    // because bob's 403 skipped the whole assertion. A guard that can switch the
    // check off is not a check. (Mutation-verified: reverting the shuffle now
    // fails here.)
    const bobId = await (async () => {
      const ps = await (await sa.get("/api/admin/participants?limit=5000")).json();
      return (ps.participants || ps).find((p) => p.email === "bob@acme.com")?.id;
    })();
    expect(bobId, "the seeded bob must exist for this comparison to mean anything").toBeTruthy();
    await sa.post("/api/admin/competitions/assign", {
      headers: GUH(saCsrf), data: { userIds: [bobId], competitionIds: [compId] },
    });
    const { api: bApi, csrf: bCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await bApi.post("/api/select-competition", { headers: GUH(bCsrf), data: { competitionId: compId } });
    const bobRes = await bApi.get(`/api/tasks/${taskId}`);
    expect(bobRes.ok(), `bob must be able to read the task: ${bobRes.status()} ${await bobRes.text()}`).toBeTruthy();
    const bobOrder = (await bobRes.json()).choices.map((c) => c.id);
    expect([...bobOrder].sort(), "both participants see the same SET of options").toEqual([...order1].sort());
    // With 8 options a coincidental identical permutation is 1/40320, so this is
    // a safe assertion rather than a flaky one.
    expect(bobOrder.join(), "two participants must get different orders").not.toBe(order1.join());
    await bApi.dispose(); await aApi.dispose();
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("grading is all-or-nothing on the selected SET, and keys on ids not positions", async () => {
    const { sa, saCsrf, taskId, compId } = await seedLiveChoiceTask([
      { text: "Alpha", correct: true }, { text: "Beta" }, { text: "Gamma", correct: true }, { text: "Delta" },
    ]);
    const stored = await (async () => {
      const l = await (await sa.get("/api/admin/tasks")).json();
      return (l.tasks || l).find((t) => t.id === taskId);
    })();
    const byText = new Map(JSON.parse(stored.choices).map((c) => [c.text, c.id]));
    const correctIds = [byText.get("Alpha"), byText.get("Gamma")];

    const submit = async (ids) => {
      const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      await api.post("/api/select-competition", { headers: GUH(csrf), data: { competitionId: compId } });
      const body = await (await api.get(`/api/tasks/${taskId}`)).json();
      const r = await api.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": csrf },
        multipart: { answer: JSON.stringify(ids), gradingHash: body.grading_hash },
      });
      const out = { ...(await r.json()), status: r.status() };
      await api.dispose();
      return out;
    };

    // A strict SUBSET is wrong — this is the all-or-nothing rule.
    expect((await submit([byText.get("Alpha")])).correct, "a subset of the correct set is wrong").toBe(false);
    // A SUPERSET is wrong.
    expect((await submit([...correctIds, byText.get("Beta")])).correct, "a superset is wrong").toBe(false);
    // Wrong ids are wrong.
    expect((await submit([byText.get("Beta"), byText.get("Delta")])).correct).toBe(false);
    // An id that is not on this task, or no id at all, is refused before grading
    // (never a 500, and never "correct" via empty-set equality); the full lock
    // is in tests/choice-grading-locks.api.spec.js.
    for (const ids of [["deadbeef"], []]) {
      const out = await submit(ids);
      expect(out.status, `${JSON.stringify(ids)}: ${JSON.stringify(out)}`).toBe(400);
      expect(out.correct, "refused, not graded").toBeUndefined();
    }
    // The exact set, in the OPPOSITE order to the author's, is correct — the
    // order a participant clicks in must not matter.
    expect((await submit([...correctIds].reverse())).correct, "the exact set is correct in any order").toBe(true);

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("the recorded submission is readable, not a list of opaque ids", async () => {
    // The admin Submissions view renders `submissions.answer` verbatim.
    const { sa, saCsrf, taskId, title, compId } = await seedLiveChoiceTask([
      { text: "Readable choice", correct: true }, { text: "Other" }, { text: "Third" },
    ]);
    const l = await (await sa.get("/api/admin/tasks")).json();
    const stored = (l.tasks || l).find((t) => t.id === taskId);
    const pick = JSON.parse(stored.choices).find((c) => c.text === "Readable choice").id;

    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: GUH(csrf), data: { competitionId: compId } });
    const body = await (await api.get(`/api/tasks/${taskId}`)).json();
    await api.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": csrf },
      multipart: { answer: JSON.stringify([pick]), gradingHash: body.grading_hash },
    });
    await api.dispose();

    // The endpoint returns its rows under `events` (it shares the row-stable
    // event-list envelope), not `submissions`.
    const subs = await (await sa.get(`/api/admin/submissions?limit=200`)).json();
    const mine = (subs.events || []).find((s) => s.task_title === title);
    expect(mine, "the submission was recorded").toBeTruthy();
    expect(mine.answer, "the stored answer names the choice a human can read").toContain("Readable choice");
    expect(mine.answer, "not the opaque id").not.toContain(pick);

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("editing the OPTIONS invalidates an in-flight submission, not just editing the answers", async () => {
    // The grading hash historically covered answer_type + correct_answer. For a
    // choice task, removing or rewording an OPTION leaves the correct set
    // untouched while changing what the participant was actually shown — so
    // `choices` had to join the hash, or that submission would be graded
    // against a question nobody saw and silently penalised.
    const { sa, saCsrf, taskId, compId } = await seedLiveChoiceTask([
      { text: "Alpha", correct: true }, { text: "Beta" }, { text: "Gamma" },
    ]);
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: GUH(csrf), data: { competitionId: compId } });
    const body = await (await api.get(`/api/tasks/${taskId}`)).json();
    const staleHash = body.grading_hash;
    const pick = body.choices[0].id;

    // The admin rewords an option; the correct SET is unchanged.
    const l = await (await sa.get("/api/admin/tasks")).json();
    const stored = (l.tasks || l).find((t) => t.id === taskId);
    const cur = JSON.parse(stored.choices);
    const edit = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf),
      data: { choices: cur.map((c) => ({ ...c, text: c.text === "Beta" ? "Beta (reworded)" : c.text, correct: c.text === "Alpha" })) },
    });
    expect(edit.ok(), `reword: ${edit.status()} ${await edit.text()}`).toBeTruthy();

    const r = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": csrf },
      multipart: { answer: JSON.stringify([pick]), gradingHash: staleHash },
    });
    expect(r.status(), "the stale submission is refused rather than graded").toBe(409);
    expect((await r.json()).task_changed).toBe(true);

    await api.dispose();
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });
});

test.describe("Multiple choice — ext-audit round 8 (v7.20.9)", () => {
  test("F2: recalculate re-grades a choice submission from its CANONICAL ids, not its human rendering", async () => {
    // `submissions.answer` holds describeSelection()'s rendering ("Paris | Rome")
    // because the admin Submissions view prints the column verbatim. Recalculate
    // used to re-grade from that same column against `correct_answer`, which for
    // a choice task is `["6bc9f335", …]` — two different languages, so the
    // comparison could never be true and EVERY correct choice submission was
    // rewritten to incorrect / -5.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId, compId } = await seedLiveChoice(sa, saCsrf, [
      { text: "Paris", correct: true }, { text: "Rome", correct: true },
      { text: "Berlin" }, { text: "Madrid" },
    ]);
    const t = storedTask(taskId);
    const byText = new Map(JSON.parse(t.choices).map((c) => [c.text, c.id]));
    const correctIds = JSON.parse(t.correct_answer);

    // Wrong first, then correct — a solved task refuses further submissions, so
    // this is the only order that produces both rows for one participant.
    const wrong = await aliceSubmit(compId, taskId, [byText.get("Berlin")]);
    expect(wrong.body.correct, "the wrong attempt must be graded wrong").toBe(false);
    const right = await aliceSubmit(compId, taskId, correctIds);
    expect(right.body.correct,
      "the setup must actually SOLVE it, or everything below is vacuous").toBe(true);

    const before = withDb((db) => db.prepare(
      "SELECT id, answer, answer_canonical, is_correct, points_delta FROM submissions WHERE task_id=?").all(taskId));
    expect(before, "one wrong + one correct row").toHaveLength(2);
    const solved = before.find((s) => s.is_correct === 1);
    expect(solved, "the solve landed").toBeTruthy();
    expect(solved.points_delta, "easy = +50").toBe(50);
    // The two languages, side by side: the human rendering an admin reads, and
    // the canonical ids recalculate must grade against.
    expect(solved.answer, "the stored answer is the human rendering").toContain("Paris");
    expect(JSON.parse(solved.answer_canonical).sort(),
      "answer_canonical carries the submitted ids").toEqual([...correctIds].sort());

    const rec = await sa.post(`/api/admin/tasks/${taskId}/recalculate`, {
      headers: GUH(saCsrf), data: { confirm_live: true },
    });
    expect(rec.ok(), `recalculate: ${rec.status()} ${await rec.text()}`).toBeTruthy();
    const out = await rec.json();
    // Positive control: a recalculation that walked no rows would satisfy
    // "nothing flipped" for the wrong reason.
    expect(out.total_submissions, "the recalculation actually walked both rows").toBe(2);
    expect(out.flipped, "a correct choice submission must survive a recalculation").toBe(0);
    expect(out.unresolved, "both rows carry canonical ids, so none is unresolved").toBe(0);

    const after = new Map(withDb((db) => db.prepare(
      "SELECT id, is_correct, points_delta FROM submissions WHERE task_id=?").all(taskId)).map((s) => [s.id, s]));
    for (const b of before) {
      expect(after.get(b.id).is_correct, `is_correct unchanged for ${b.answer}`).toBe(b.is_correct);
      expect(after.get(b.id).points_delta, `points unchanged for ${b.answer}`).toBe(b.points_delta);
    }

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("F2: a LEGACY choice submission is re-derived from its option TEXT — and left ALONE once that stops resolving", async () => {
    // Rows written before v7.20.9 have no `answer_canonical`. They are recovered
    // by matching the human rendering back to option TEXT, which is exact until
    // an option is renamed — and at that point the row must be SKIPPED and
    // counted, because guessing would reintroduce the defect being fixed.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId, compId } = await seedLiveChoice(sa, saCsrf, [
      { text: "Ada Lovelace", correct: true }, { text: "Grace Hopper" }, { text: "Alan Turing" },
    ]);
    const t0 = storedTask(taskId);
    const stored = JSON.parse(t0.choices);
    const correctIds = JSON.parse(t0.correct_answer);
    const solve = await aliceSubmit(compId, taskId, correctIds);
    expect(solve.body.correct, "the setup must actually solve it").toBe(true);

    // Age the row into the pre-v7.20.9 shape.
    withDb((db) => db.prepare("UPDATE submissions SET answer_canonical=NULL WHERE task_id=?").run(taskId), {});
    const legacy = withDb((db) => db.prepare(
      "SELECT answer, answer_canonical, is_correct, points_delta FROM submissions WHERE task_id=?").all(taskId));
    expect(legacy, "exactly one row to re-grade").toHaveLength(1);
    expect(legacy[0].answer_canonical, "the row now looks like a pre-v7.20.9 one").toBeNull();

    const rec1 = await (await sa.post(`/api/admin/tasks/${taskId}/recalculate`, {
      headers: GUH(saCsrf), data: { confirm_live: true },
    })).json();
    expect(rec1.total_submissions, "the recalculation walked the row").toBe(1);
    expect(rec1.unresolved, "the option text still resolves, so nothing is unresolved").toBe(0);
    expect(rec1.flipped, "a legacy correct row survives via the text fallback").toBe(0);
    let row = withDb((db) => db.prepare(
      "SELECT is_correct, points_delta FROM submissions WHERE task_id=?").get(taskId));
    expect(row.is_correct).toBe(1);
    expect(row.points_delta).toBe(50);

    // Now rename every option, keeping the IDS (and therefore the correct set)
    // byte-identical — so this is not a scoring edit, just a wording fix.
    const renamed = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf),
      data: { choices: stored.map((c, i) => ({ id: c.id, text: `Renamed option ${i}`, correct: correctIds.includes(c.id) })) },
    });
    expect(renamed.ok(), `reword: ${renamed.status()} ${await renamed.text()}`).toBeTruthy();
    expect(storedTask(taskId).correct_answer,
      "the correct SET must be unchanged — the rename is not a scoring edit").toBe(t0.correct_answer);

    const rec2 = await (await sa.post(`/api/admin/tasks/${taskId}/recalculate`, {
      headers: GUH(saCsrf), data: { confirm_live: true },
    })).json();
    expect(rec2.total_submissions, "the recalculation walked the row again").toBe(1);
    expect(rec2.unresolved, "the stored rendering names no option any more").toBe(1);
    expect(rec2.flipped, "an unrecoverable row is left alone, never guessed at").toBe(0);
    row = withDb((db) => db.prepare(
      "SELECT is_correct, points_delta FROM submissions WHERE task_id=?").get(taskId));
    expect(row.is_correct, "the participant keeps their solve").toBe(1);
    expect(row.points_delta, "and their points").toBe(50);

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("F3: a choices-only edit that changes the correct set is FROZEN once a session has ended", async () => {
    // The freeze used to test `req.body.correct_answer`, but for a choice task
    // the correct answer is DERIVED from `req.body.choices`. So an edit that
    // simply did not name the field walked straight past the gate and rewrote
    // the answer of a challenge whose session had already been graded.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId } = await endedCompWithChoiceTask(sa, saCsrf, [
      { text: "Alpha", correct: true }, { text: "Beta" }, { text: "Gamma" },
    ]);
    const before = storedTask(taskId);
    const opts = JSON.parse(before.choices);

    // Positive control: the task is otherwise editable, so a 409 below is the
    // freeze talking and not a blanket refusal.
    const titleOnly = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf), data: { title: `${before.title} (typo fixed)` },
    });
    expect(titleOnly.ok(), `a text-only edit stays allowed: ${titleOnly.status()} ${await titleOnly.text()}`).toBeTruthy();

    // Same option ids, the tick MOVED — `correct_answer` is never mentioned.
    const moved = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf),
      data: { choices: opts.map((c, i) => ({ id: c.id, text: c.text, correct: i === 1 })) },
    });
    expect(moved.status(), "changing the correct SET is a scoring edit however it is spelled").toBe(409);
    expect((await moved.json()).error).toMatch(/Cannot change scoring/i);

    const after = storedTask(taskId);
    expect(after.correct_answer, "the refusal must not have written anything").toBe(before.correct_answer);
    expect(after.choices, "…including the options").toBe(before.choices);

    await sa.dispose();
  });

  test("F3: a text-only edit that also posts an EMPTY correct_answer is NOT a scoring edit", async () => {
    // The admin form posts `correct_answer` unconditionally, and empty for a
    // choice task (the answer lives in the ticks). Comparing that raw "" against
    // the stored id array made a title typo-fix return 409 on any challenge in
    // an ended session.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId } = await endedCompWithChoiceTask(sa, saCsrf, [
      { text: "Ay", correct: true }, { text: "Bee" }, { text: "Cee" },
    ]);
    const before = storedTask(taskId);

    // Positive control: the freeze IS armed on this task, so the 200 below means
    // "correctly allowed" rather than "ended session never detected".
    const armed = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf), data: { difficulty: "hard" },
    });
    expect(armed.status(), "the ended-session freeze is armed").toBe(409);

    const edit = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf),
      data: { title: `${before.title} renamed`, correct_answer: "", description: "<p>reworded</p>" },
    });
    expect(edit.ok(), `the form's empty correct_answer must not read as a scoring edit: ${edit.status()} ${await edit.text()}`).toBeTruthy();

    const after = storedTask(taskId);
    expect(after.title, "the text edit landed").toBe(`${before.title} renamed`);
    expect(after.correct_answer, "and the answer is untouched, not erased").toBe(before.correct_answer);
    expect(after.choices).toBe(before.choices);

    await sa.dispose();
  });

  test("F3 (adjacent): an EMPTY correct_answer on a NON-choice challenge is refused, and the stored answer survives", async () => {
    // `correct_answer=COALESCE(?,correct_answer)` treats "" as a value, so an
    // empty string ERASED the answer — and since the text comparison strips
    // whitespace on both sides, an empty stored answer makes an empty SUBMISSION
    // grade as correct.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const created = await sa.post("/api/admin/tasks", {
      headers: GUH(saCsrf),
      data: {
        title: `MC empty-answer ${Date.now()}`, difficulty: "easy", answer_type: "text",
        correct_answer: "original-answer", description: "<p>d</p>",
      },
    });
    expect(created.ok(), `create: ${created.status()} ${await created.text()}`).toBeTruthy();
    const taskId = (await created.json()).id;

    for (const [value, label] of [["", "an empty string"], ["   ", "whitespace only"]]) {
      const r = await sa.put(`/api/admin/tasks/${taskId}`, { headers: GUH(saCsrf), data: { correct_answer: value } });
      expect(r.status(), `${label} must be refused`).toBe(400);
      expect((await r.json()).error).toMatch(/correct_answer cannot be empty/i);
      expect(storedTask(taskId).correct_answer, `${label}: the stored answer survives`).toBe("original-answer");
    }

    // Positive control: a real value still saves, so the guard is not simply
    // refusing every correct_answer edit.
    const ok = await sa.put(`/api/admin/tasks/${taskId}`, { headers: GUH(saCsrf), data: { correct_answer: "rotated" } });
    expect(ok.ok(), `a non-empty answer still saves: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect(storedTask(taskId).correct_answer).toBe("rotated");

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("F4: restoring a version restores the OPTIONS with the answer, so the challenge stays solvable", async () => {
    // `task_versions` snapshots the whole row, so it has always CONTAINED
    // `choices` — but the restore UPDATE's hand-written column list never
    // mentioned it. Restoring an old choice version therefore wrote old correct
    // IDS alongside today's options: correct ids naming no option, every
    // submission grading wrong, the challenge literally unsolvable.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId, compId } = await seedLiveChoice(sa, saCsrf, [
      { text: "Original A", correct: true }, { text: "Original B" }, { text: "Original C", correct: true },
    ]);
    const v1 = storedTask(taskId);

    // Edit to a completely different option set (new ids, new correct set).
    const edit = await sa.put(`/api/admin/tasks/${taskId}`, {
      headers: GUH(saCsrf),
      data: { choices: [{ text: "Replacement D", correct: true }, { text: "Replacement E" }, { text: "Replacement F" }] },
    });
    expect(edit.ok(), `edit: ${edit.status()} ${await edit.text()}`).toBeTruthy();
    const v2 = storedTask(taskId);
    expect(v2.choices, "the edit really did replace the options").not.toBe(v1.choices);
    expect(v2.correct_answer, "…and the correct set").not.toBe(v1.correct_answer);

    const versions = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
    // The event's own copy starts with ONE full snapshot naming its origin
    // (change_type `copy`, lib/event-copies.js): the version to restore.
    const createV = versions.find((v) => v.change_type === "copy");
    expect(createV, "the copy's first snapshot is the version to restore").toBeTruthy();
    expect(JSON.parse(createV.snapshot).choices,
      "the snapshot has always carried the options — the bug was in the restore").toBe(v1.choices);

    const restore = await sa.post(`/api/admin/tasks/${taskId}/restore`, {
      headers: GUH(saCsrf), data: { versionId: createV.id },
    });
    expect(restore.ok(), `restore: ${restore.status()} ${await restore.text()}`).toBeTruthy();

    const back = storedTask(taskId);
    expect(back.correct_answer, "the correct set came back").toBe(v1.correct_answer);
    expect(back.choices, "and so did the options it names").toBe(v1.choices);
    // The invariant, stated independently of which version it is: every correct
    // id must name an option that exists.
    const ids = new Set(JSON.parse(back.choices).map((c) => c.id));
    for (const cid of JSON.parse(back.correct_answer)) {
      expect(ids.has(cid), `correct id ${cid} names a real option`).toBe(true);
    }

    // The strongest form: a participant can actually answer it.
    const solve = await aliceSubmit(compId, taskId, JSON.parse(back.correct_answer));
    expect(solve.body.correct, "the restored challenge is solvable end to end").toBe(true);

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("F4: a version whose options and correct set do not match is REFUSED, not written", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const created = await mkChoiceTask(sa, saCsrf, [
      { text: "Snap A", correct: true }, { text: "Snap B" }, { text: "Snap C" },
    ]);
    expect(created.ok(), `create: ${created.status()} ${await created.text()}`).toBeTruthy();
    const taskId = (await created.json()).id;
    const before = storedTask(taskId);

    const versions = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
    const createV = versions.find((v) => v.change_type === "create");
    expect(createV).toBeTruthy();

    // Hand-corrupt the snapshot the way a botched migration or an older bug
    // would: correct ids that name no option.
    const snap = JSON.parse(createV.snapshot);
    snap.correct_answer = JSON.stringify(["ffffffff"]);
    withDb((db) => db.prepare("UPDATE task_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snap), createV.id), {});

    const r = await sa.post(`/api/admin/tasks/${taskId}/restore`, {
      headers: GUH(saCsrf), data: { versionId: createV.id },
    });
    expect(r.status(), "an unanswerable snapshot must be refused, not written").toBe(409);
    expect((await r.json()).error).toMatch(/do not match/i);
    const after = storedTask(taskId);
    expect(after.correct_answer, "nothing was written").toBe(before.correct_answer);
    expect(after.choices).toBe(before.choices);

    // Positive control: an INTACT snapshot of the same task still restores, so
    // the 409 above is the mismatch check and not a broken restore path.
    withDb((db) => db.prepare("UPDATE task_versions SET snapshot=? WHERE id=?").run(createV.snapshot, createV.id), {});
    const ok = await sa.post(`/api/admin/tasks/${taskId}/restore`, {
      headers: GUH(saCsrf), data: { versionId: createV.id },
    });
    expect(ok.ok(), `a consistent snapshot still restores: ${ok.status()} ${await ok.text()}`).toBeTruthy();

    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });
});

test.describe("Multiple choice — export/import round-trip (v7.19.0)", () => {
  test("choice IDs survive an export → import, so the correct set still resolves", async () => {
    // Re-minting ids on import would sever correct_answer from the options and
    // leave an imported question with no correct answer — and nothing would
    // report an error, because both columns would still be well-formed.
    const { api, csrf } = await apiLogin("superadmin");
    const created = await mkChoiceTask(api, csrf, [
      { text: "Round trip A", correct: true }, { text: "Round trip B" }, { text: "Round trip C", correct: true },
    ]);
    const id = (await created.json()).id;
    const l = await (await api.get("/api/admin/tasks")).json();
    const src = (l.tasks || l).find((t) => t.id === id);

    const exported = await (await api.get("/api/admin/export/tasks")).json();
    const mine = (exported.tasks || exported).find((t) => t.title === src.title);
    expect(mine, "the task is in the export").toBeTruthy();
    expect(mine.choices, "choices ride the export").toBeTruthy();
    expect(JSON.parse(mine.choices).map((c) => c.id)).toEqual(JSON.parse(src.choices).map((c) => c.id));
    expect(mine.correct_answer).toBe(src.correct_answer);

    // Import it under a new title and confirm the ids still line up.
    const renamed = { ...mine, title: `${mine.title} (imported)` };
    const imp = await api.post("/api/admin/import/tasks", {
      headers: GUH(csrf), data: { data: { type: "hackarena-tasks", tasks: [renamed] }, resolutions: {} },
    });
    expect(imp.ok(), `import: ${imp.status()} ${await imp.text()}`).toBeTruthy();

    const l2 = await (await api.get("/api/admin/tasks")).json();
    const copy = (l2.tasks || l2).find((t) => t.title === renamed.title);
    expect(copy, "the imported copy exists").toBeTruthy();
    expect(copy.answer_type).toBe("choice");
    const copyIds = JSON.parse(copy.choices).map((c) => c.id);
    const copyCorrect = JSON.parse(copy.correct_answer);
    expect(copyIds, "ids survive the round trip").toEqual(JSON.parse(src.choices).map((c) => c.id));
    for (const cid of copyCorrect) {
      expect(copyIds, "every correct id still names a real option").toContain(cid);
    }

    await api.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
    await api.delete(`/api/admin/tasks/${copy.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("an unimportable choice row is SKIPPED, never created unanswerable", async () => {
    // Without this the import creates a `choice` task with no options — or with
    // a correct_answer naming ids that no longer exist. Both are silent: the
    // columns are well-formed, nothing errors, and the question simply cannot be
    // answered by anyone. The import already skips rows with an invalid
    // difficulty/answer_type, so these are skipped the same way: a bad row must
    // not sink the whole import, but nor may it land broken.
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const good = {
      title: `MCImp good ${stamp}`, difficulty: "easy", answer_type: "choice",
      description: "", explanation: "", hint: "", attachment_url: "", status: "draft",
      choices: JSON.stringify([{ id: "aaaaaaaa", text: "A" }, { id: "bbbbbbbb", text: "B" }]),
      correct_answer: JSON.stringify(["aaaaaaaa"]),
    };
    const bad = [
      { ...good, title: `MCImp nochoices ${stamp}`, choices: null },
      { ...good, title: `MCImp onechoice ${stamp}`, choices: JSON.stringify([{ id: "aaaaaaaa", text: "A" }]) },
      { ...good, title: `MCImp danglingid ${stamp}`, correct_answer: JSON.stringify(["ffffffff"]) },
      { ...good, title: `MCImp nocorrect ${stamp}`, correct_answer: JSON.stringify([]) },
      { ...good, title: `MCImp allcorrect ${stamp}`, correct_answer: JSON.stringify(["aaaaaaaa", "bbbbbbbb"]) },
      { ...good, title: `MCImp garbage ${stamp}`, choices: "{not json" },
    ];
    const r = await api.post("/api/admin/import/tasks", {
      headers: GUH(csrf),
      data: { data: { type: "hackarena-tasks", tasks: [good, ...bad] }, resolutions: {} },
    });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();

    const l = await (await api.get("/api/admin/tasks")).json();
    const rows = l.tasks || l;
    const landed = rows.find((t) => t.title === good.title);
    expect(landed, "the WELL-FORMED row still imports — one bad row must not sink the batch").toBeTruthy();
    expect(JSON.parse(landed.choices)).toHaveLength(2);

    for (const b of bad) {
      expect(rows.find((t) => t.title === b.title),
        `"${b.title}" is unanswerable and must have been skipped, not created`).toBeFalsy();
    }
    if (landed) await api.delete(`/api/admin/tasks/${landed.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("F10 (v7.20.9): a choice row that is not CANONICAL is skipped — duplicate ids, duplicate text, non-hex ids", async () => {
    // The import used to hand-roll four of validateChoices' rules and let the
    // rest through. Each row below is well-formed JSON that nothing downstream
    // would complain about, and each is broken in a way an operator only
    // discovers later:
    //   • duplicate IDS — two visually distinct options share one id, so ticking
    //     either grades as the same answer;
    //   • duplicate TEXT — two identical rows, one right and one wrong;
    //   • a non-canonical ID — harmless to grading, but validateChoices re-mints
    //     anything failing /^[a-f0-9]{8}$/, so the first time an admin opened and
    //     saved the imported task the editor silently changed every id, on a
    //     feature whose whole doctrine is that ids never change.
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const base = {
      difficulty: "easy", answer_type: "choice",
      description: "", explanation: "", hint: "", attachment_url: "", status: "draft",
    };
    const good = {
      ...base, title: `MCCanon good ${stamp}`,
      choices: JSON.stringify([{ id: "1a2b3c4d", text: "A" }, { id: "5e6f7a8b", text: "B" }]),
      correct_answer: JSON.stringify(["1a2b3c4d"]),
    };
    const bad = [
      { ...base, title: `MCCanon dupid ${stamp}`,
        choices: JSON.stringify([{ id: "aaaaaaaa", text: "A" }, { id: "aaaaaaaa", text: "B" }]),
        correct_answer: JSON.stringify(["aaaaaaaa"]) },
      { ...base, title: `MCCanon duptext ${stamp}`,
        choices: JSON.stringify([{ id: "aaaaaaaa", text: "Alpha" }, { id: "bbbbbbbb", text: "ALPHA" }]),
        correct_answer: JSON.stringify(["aaaaaaaa"]) },
      { ...base, title: `MCCanon uppercaseid ${stamp}`,
        choices: JSON.stringify([{ id: "AAAAAAAA", text: "A" }, { id: "bbbbbbbb", text: "B" }]),
        correct_answer: JSON.stringify(["AAAAAAAA"]) },
      { ...base, title: `MCCanon shortid ${stamp}`,
        choices: JSON.stringify([{ id: "abc", text: "A" }, { id: "bbbbbbbb", text: "B" }]),
        correct_answer: JSON.stringify(["abc"]) },
      { ...base, title: `MCCanon nonhexid ${stamp}`,
        choices: JSON.stringify([{ id: "zzzzzzzz", text: "A" }, { id: "bbbbbbbb", text: "B" }]),
        correct_answer: JSON.stringify(["zzzzzzzz"]) },
    ];

    const r = await api.post("/api/admin/import/tasks", {
      headers: GUH(csrf),
      data: { data: { type: "hackarena-tasks", tasks: [good, ...bad] }, resolutions: {} },
    });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
    const out = await r.json();
    expect(out.imported, "the well-formed row still imports — a bad row must not sink the batch").toBe(1);
    expect(out.skipped, "every non-canonical row is skipped").toBe(bad.length);

    const l = await (await api.get("/api/admin/tasks")).json();
    const rows = l.tasks || l;
    const landed = rows.find((t) => t.title === good.title);
    expect(landed, "the good row landed").toBeTruthy();
    expect(JSON.parse(landed.choices).map((c) => c.id),
      "and its ids are preserved verbatim").toEqual(["1a2b3c4d", "5e6f7a8b"]);
    for (const b of bad) {
      expect(rows.find((t) => t.title === b.title),
        `"${b.title}" is not canonical and must have been skipped, not created`).toBeFalsy();
    }

    if (landed) await api.delete(`/api/admin/tasks/${landed.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});
