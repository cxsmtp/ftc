// @ts-check
//
// A QUESTION ADDED TO AN EVENT LIVES IN THAT EVENT (lib/event-copies.js).
//
//   (a) Adding a bank question makes the event's OWN copy; editing the copy's
//       answer changes grading in that event only — the bank question and a
//       second event's copy keep the old key (by value, graded by real submits).
//   (b) An event's question cannot be assigned to another event, at any of the
//       three assign doors (named refusal / skip counter).
//   (c) A clone and a template spawn get FRESH copies (the source event's own
//       as edited there; the template's bank question as it is).
//   (d) THE BATCH MIGRATION over a database built the previous release's way
//       (the assign doors put into "legacy" mode through a test hook, so the
//       submissions, hints, grants, ended board and certificate are made by the
//       real routes): every row lands under the right copy, scores, boards, the
//       frozen team board and the certificate read the same, the library holds
//       no copy, a re-run does nothing, and a file two rows share survives the
//       bank question's delete.
//   (e) The dry run (test hook and the operator's script) writes nothing.
//   (f) An event admin edits the questions their event owns, not another's.
//   Plus: the per-table manifest is a decision for every table with a task_id,
//   both ways; a question created inside an event is the event's from birth.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, gradingHashFor } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, enrol, buildWorld, eventCopyOf } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ro = (fn) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return fn(db); } finally { db.close(); } };
const rw = (fn) => { const db = new Database(TEST_DB_PATH); try { return fn(db); } finally { db.close(); } };
const taskRow = (id) => ro(db => db.prepare("SELECT * FROM tasks WHERE id=?").get(id));

let W;
test.beforeAll(async () => { W = await buildWorld(); });
test.afterAll(async () => {
  // Never leave the process-global legacy switch on for a later file.
  try { await W.sa.post("/api/test/legacy-shared-assign", { headers: H(W.saCsrf), data: { on: false } }); } catch (_) {}
  for (const a of [W && W.sa, W && W.eaApi, W && W.zeroApi]) { try { await a.dispose(); } catch (_) {} }
});

async function assign(api, csrf, taskId, competitionIds) {
  const r = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds } });
  expect(r.status(), `assign: ${await r.text()}`).toBe(200);
  return r.json();
}
async function asParticipant(email, compId) {
  const p = await apiLogin(email, PARTICIPANT_PASS);
  const s = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: compId } });
  expect(s.ok(), `select ${compId}: ${await s.text()}`).toBeTruthy();
  return p;
}
async function submit(p, taskId, answer) {
  const r = await p.api.post(`/api/tasks/${taskId}/submit`, { headers: H(p.csrf), data: { answer, gradingHash: await gradingHashFor(p.api, taskId) } });
  expect(r.status(), `submit ${taskId}: ${await r.text()}`).toBe(200);
  return r.json();
}

test.describe("event-owned questions", () => {
  test("(a) adding a bank question makes the event's own copy; editing the copy's answer changes that event only", async () => {
    const { sa, saCsrf } = W;
    const E1 = await makeCompetition(sa, saCsrf, "own1"), E2 = await makeCompetition(sa, saCsrf, "own2");
    const B = await makeTask(sa, saCsrf, "own-bank", { correct_answer: "old", hint: "<p>a hint</p>" });
    const a = await assign(sa, saCsrf, B.id, [E1.id, E2.id]);
    expect(a.assigned).toBe(2);
    const byEvent = Object.fromEntries(a.copies.map(c => [c.competition_id, c.task_id]));
    const C1 = byEvent[E1.id], C2 = byEvent[E2.id];
    expect(C1 && C2 && C1 !== C2 && C1 !== B.id && C2 !== B.id, "two fresh copies, neither the bank question").toBe(true);
    for (const [c, e] of [[C1, E1.id], [C2, E2.id]]) {
      const r = taskRow(c);
      expect({ owner: r.owner_competition_id, origin: r.copied_from_task_id, answer: r.correct_answer, hint: r.hint, title: r.title },
        "the copy is the event's, records its origin, and carries the question").toEqual({ owner: e, origin: B.id, answer: "old", hint: "<p>a hint</p>", title: B.title });
    }
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM competition_tasks WHERE task_id=?").get(B.id).n), "the bank question itself is in no event").toBe(0);
    expect(ro(db => db.prepare("SELECT change_type, details FROM task_versions WHERE task_id=?").all(C1)).map(v => [v.change_type, JSON.parse(v.details).copied_from]),
      "the copy starts with one version naming its origin").toEqual([["copy", B.id]]);
    // Adding it again reuses the event's copy.
    const again = await assign(sa, saCsrf, B.id, [E1.id]);
    expect({ assigned: again.assigned, copy: again.copies[0].task_id }, "re-adding finds the event's own copy").toEqual({ assigned: 0, copy: C1 });

    // The library lists the bank question once and names the events holding a copy.
    const list = await (await sa.get("/api/admin/tasks")).json();
    const bankRow = list.find(t => t.id === B.id);
    expect(bankRow.owner_competition_id ?? null, "the bank row is a bank question").toBeNull();
    expect(bankRow.competitions.map(c => [c.id, c.copy_id]).sort()).toEqual([[E1.id, C1], [E2.id, C2]].sort());

    // Edit the E1 copy's answer.
    const put = await sa.put(`/api/admin/tasks/${C1}`, { headers: H(saCsrf), data: { correct_answer: "new", expectedUpdatedAt: taskRow(C1).updated_at } });
    expect(put.status(), await put.text()).toBe(200);
    expect([taskRow(C1).correct_answer, taskRow(C2).correct_answer, taskRow(B.id).correct_answer], "only the E1 copy changed").toEqual(["new", "old", "old"]);

    // Graded by real submits: E1 takes the new key, E2 the old one.
    // N never answers, so neither event ends on all-solved (fixture checklist 1).
    const P = await makeParticipant(sa, saCsrf, "ownp"), N = await makeParticipant(sa, saCsrf, "ownn");
    await enrol(sa, saCsrf, E1.id, [P.id, N.id]);
    await enrol(sa, saCsrf, E2.id, [P.id, N.id]);
    const p1 = await asParticipant(P.email, E1.id);
    try {
      expect((await submit(p1, C1, "old")).correct, "E1: the old key is now wrong").toBe(false);
      expect((await submit(p1, C1, "new")).correct, "E1: the new key is right").toBe(true);
    } finally { await p1.api.dispose(); }
    const p2 = await asParticipant(P.email, E2.id);
    try {
      // A bank question id named in the event means the event's copy (a tab opened before the change).
      const view = await (await p2.api.get(`/api/tasks/${B.id}`)).json();
      expect(view.id, "the bank id reads as E2's own copy").toBe(C2);
      expect((await submit(p2, B.id, "new")).correct, "E2: the edited key is not E2's").toBe(false);
      expect((await submit(p2, B.id, "old")).correct, "E2: its own key still grades").toBe(true);
    } finally { await p2.api.dispose(); }
    expect(ro(db => db.prepare("SELECT task_id, competition_id, is_correct FROM submissions WHERE user_id=? ORDER BY submitted_at").all(P.id)),
      "every answer is stored under the event's own question").toEqual([
      { task_id: C1, competition_id: E1.id, is_correct: 0 }, { task_id: C1, competition_id: E1.id, is_correct: 1 },
      { task_id: C2, competition_id: E2.id, is_correct: 0 }, { task_id: C2, competition_id: E2.id, is_correct: 1 },
    ]);

    // Removing the bank question from an event removes that event's copy.
    const del = await sa.delete(`/api/admin/tasks/${B.id}/competitions/${E2.id}`, { headers: H(saCsrf) });
    expect(del.status(), await del.text()).toBe(200);
    expect(ro(db => db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id IN (?,?) ORDER BY competition_id").all(E1.id, E2.id)).map(r => r.task_id),
      "E2's copy is out; E1's stays").toEqual([C1]);
  });

  test("(b) an event's question cannot be assigned to another event — single, bulk and desired-state doors", async () => {
    const { sa, saCsrf } = W;
    const E1 = await makeCompetition(sa, saCsrf, "x1"), E2 = await makeCompetition(sa, saCsrf, "x2");
    const B = await makeTask(sa, saCsrf, "x-bank");
    const C1 = (await assign(sa, saCsrf, B.id, [E1.id])).copies[0].task_id;
    const single = await sa.post(`/api/admin/tasks/${C1}/competitions`, { headers: H(saCsrf), data: { competitionIds: [E2.id] } });
    expect(single.status()).toBe(400);
    const sb = await single.json();
    expect(sb.code).toBe("task_owned_by_other_event");
    expect(sb.error, "the refusal names the owning event").toContain(E1.name);
    const bulk = await sa.post("/api/admin/tasks/assign-competitions", { headers: H(saCsrf), data: { taskIds: [C1], competitionIds: [E2.id] } });
    expect(bulk.status()).toBe(200);
    const bb = await bulk.json();
    expect({ assigned: bb.assigned, ownedElsewhere: bb.skipped.ownedElsewhere }).toEqual({ assigned: 0, ownedElsewhere: 1 });
    const putR = await sa.put(`/api/admin/tasks/${C1}/competitions`, { headers: H(saCsrf), data: { competitionIds: [E1.id, E2.id], expectedAssignments: [E1.id] } });
    expect(putR.status()).toBe(400);
    expect((await putR.json()).code).toBe("task_owned_by_other_event");
    expect(ro(db => db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(C1)).map(r => r.competition_id), "nothing moved").toEqual([E1.id]);
    // CONTROL: the bank question goes into E2 as E2's own copy.
    const ok = await assign(sa, saCsrf, B.id, [E2.id]);
    expect(ok.assigned).toBe(1);
    expect(taskRow(ok.copies[0].task_id).owner_competition_id).toBe(E2.id);
  });

  test("(c) a clone and a template spawn get fresh copies: the clone the source's edited question, the spawn the bank's", async () => {
    const { sa, saCsrf } = W;
    const src = await makeCompetition(sa, saCsrf, "csrc", { start_time: new Date(Date.now() + 3_600_000).toISOString() });
    const B = await makeTask(sa, saCsrf, "c-bank", { correct_answer: "bank-key" });
    const Cs = (await assign(sa, saCsrf, B.id, [src.id])).copies[0].task_id;
    const put = await sa.put(`/api/admin/tasks/${Cs}`, { headers: H(saCsrf), data: { correct_answer: "event-key", expectedUpdatedAt: taskRow(Cs).updated_at } });
    expect(put.status(), await put.text()).toBe(200);
    const cl = await sa.post(`/api/admin/competitions/${src.id}/clone`, { headers: H(saCsrf), data: { name: `Clone ${uniq("c")}` } });
    expect(cl.status(), await cl.text()).toBe(200);
    const cid = (await cl.json()).competition.id;
    const held = ro(db => db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=?").all(cid)).map(r => r.task_id);
    expect(held.length).toBe(1);
    const Cc = held[0];
    expect(Cc === Cs || Cc === B.id, "the clone shares nothing").toBe(false);
    expect({ owner: taskRow(Cc).owner_competition_id, origin: taskRow(Cc).copied_from_task_id, key: taskRow(Cc).correct_answer },
      "the clone's own copy of the SOURCE's question, origin the bank question").toEqual({ owner: cid, origin: B.id, key: "event-key" });
    const tr = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name: `Tpl ${uniq("t")}`, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [B.id] } });
    expect(tr.status(), await tr.text()).toBe(200);
    const sp = await sa.post(`/api/admin/event-templates/${(await tr.json()).template.id}/spawn`, { headers: H(saCsrf), data: { name: `Spawn ${uniq("s")}` } });
    expect(sp.status(), await sp.text()).toBe(200);
    const sid = (await sp.json()).competition.id;
    const sheld = ro(db => db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=?").all(sid)).map(r => r.task_id);
    expect({ fresh: ![B.id, Cs, Cc].includes(sheld[0]), owner: taskRow(sheld[0]).owner_competition_id, key: taskRow(sheld[0]).correct_answer },
      "the spawn's own copy of the BANK question").toEqual({ fresh: true, owner: sid, key: "bank-key" });
    // Save-as-template names the bank question the event's copy came from.
    const st = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name: `Saved ${uniq("s")}` } });
    expect(st.status(), await st.text()).toBe(200);
    expect((await st.json()).template.task_ids).toEqual([B.id]);
  });

  test("a question created inside an event is the event's from birth; the competitor and scope rules apply", async () => {
    const { sa, saCsrf, eaApi, eaCsrf } = W;
    const r = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: { title: `In-event ${uniq("q")}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", competitionId: W.mine.id } });
    expect(r.status(), await r.text()).toBe(200);
    const id = (await r.json()).id;
    expect({ owner: taskRow(id).owner_competition_id, origin: taskRow(id).copied_from_task_id }).toEqual({ owner: W.mine.id, origin: null });
    expect(ro(db => db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(W.mine.id, id)), "assigned to it at once").toBeTruthy();
    const out = await eaApi.post("/api/admin/tasks", { headers: H(eaCsrf), data: { title: `Theirs ${uniq("q")}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", competitionId: W.theirs.id } });
    expect(out.status(), "an event admin cannot create inside an event they do not run").toBe(403);
    const mine = await eaApi.post("/api/admin/tasks", { headers: H(eaCsrf), data: { title: `Mine ${uniq("q")}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", competitionId: W.mine.id } });
    expect(mine.status(), `CONTROL: their own event: ${await mine.text()}`).toBe(200);
    const bad = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: { title: `Bad ${uniq("q")}`, difficulty: "easy", answer_type: "text", correct_answer: "x", competitionId: ["x"] } });
    expect(bad.status()).toBe(400);
  });

  test("(f) an event admin edits the questions their event owns and not another event's", async () => {
    const { sa, saCsrf, eaApi, eaCsrf } = W;
    const B = await makeTask(sa, saCsrf, "f-bank", { correct_answer: "k" });
    const a = await assign(sa, saCsrf, B.id, [W.mine.id, W.theirs.id]);
    const byEvent = Object.fromEntries(a.copies.map(c => [c.competition_id, c.task_id]));
    const Cm = byEvent[W.mine.id], Ct = byEvent[W.theirs.id];
    const edit = (id, answer) => eaApi.put(`/api/admin/tasks/${id}`, { headers: H(eaCsrf), data: { correct_answer: answer, expectedUpdatedAt: taskRow(id).updated_at } });
    const okMine = await edit(Cm, "mine-key");
    expect(okMine.status(), `their event's question, answer included: ${await okMine.text()}`).toBe(200);
    expect(taskRow(Cm).correct_answer).toBe("mine-key");
    const theirs = await edit(Ct, "nope");
    expect(theirs.status(), "another organiser's event's question").toBe(403);
    const bank = await edit(B.id, "nope");
    expect(bank.status(), "the bank question they did not write").toBe(403);
    expect([taskRow(Ct).correct_answer, taskRow(B.id).correct_answer], "neither changed").toEqual(["k", "k"]);
    const rows = await (await eaApi.get("/api/admin/tasks")).json();
    const ids = rows.map(t => t.id);
    expect(ids, "their event's copy is listed").toContain(Cm);
    expect(ids, "the bank question their event holds a copy of is listed").toContain(B.id);
    expect(ids, "another event's copy is not").not.toContain(Ct);
    expect(rows.find(t => t.id === Cm).can_edit_scoring, "the row offers scoring edits on their own question").toBe(true);
    // The bank question is "used by their event" only while that event's copy is
    // assigned: taken out, the bank question is no longer theirs to open, while
    // the event's own (now unassigned) question still is.
    const versions = (id) => eaApi.get(`/api/admin/tasks/${id}/versions`);
    expect((await versions(B.id)).status(), "PRECONDITION: the bank question opens while their event holds its copy").toBe(200);
    const out = await sa.delete(`/api/admin/tasks/${B.id}/competitions/${W.mine.id}`, { headers: H(saCsrf) });
    expect(out.status(), await out.text()).toBe(200);
    expect((await versions(B.id)).status(), "the bank question is not theirs once the copy is out").toBe(403);
    expect((await versions(Cm)).status(), "CONTROL: their event's own question still is").toBe(200);
  });

  test("the manifest decides every table with a task_id, both ways", async () => {
    const { TASK_TABLE_MANIFEST, MOVED_TABLES } = require("../lib/event-copies");
    const withTaskId = ro(db => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map(r => r.name).filter(n => db.prepare(`PRAGMA table_info(${n})`).all().some(c => c.name === "task_id"))).sort();
    expect(withTaskId.length, "anti-vacuity: the schema has task_id tables").toBeGreaterThan(5);
    expect(Object.keys(TASK_TABLE_MANIFEST).sort(), "a decision for every table holding a task_id, and none for a table without").toEqual(withTaskId);
    for (const t of MOVED_TABLES) {
      const cols = ro(db => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
      expect(cols, `${t} is moved by competition, so it has a competition_id`).toContain("competition_id");
    }
  });
});

test.describe("the batch migration over a database built the previous way", () => {
  test("(d)+(e) every row lands under the event's copy, scores, boards and the certificate read the same, the dry runs write nothing, a re-run does nothing", async () => {
    test.setTimeout(180_000);
    const { sa, saCsrf } = W;
    const legacy = async (on) => {
      const r = await sa.post("/api/test/legacy-shared-assign", { headers: H(saCsrf), data: { on } });
      expect((await r.json()).on).toBe(on);
    };
    // A user-backed admin authors the sealed question (a seal names an author).
    const author = await makeParticipant(sa, saCsrf, "migauth");
    expect((await sa.post(`/api/admin/participants/${author.id}/role`, { headers: H(saCsrf), data: { role: "admin" } })).ok()).toBeTruthy();
    const al = await apiLogin(author.email, PARTICIPANT_PASS);
    let S;
    try { S = await makeTask(al.api, al.csrf, "mig-sealed", { answer_sealed: true, correct_answer: "sealed-key" }); } finally { await al.api.dispose(); }
    const T = await makeTask(sa, saCsrf, "mig-text", { correct_answer: "t", hint: "<p>h</p>", attempt_cap: 2 });
    const C = await makeTask(sa, saCsrf, "mig-choice", { answer_type: "choice", correct_answer: undefined, choices: [{ text: "Right", correct: true }, { text: "Wrong" }] });
    const bank = [T.id, C.id, S.id];
    const choiceIds = JSON.parse(taskRow(C.id).choices);
    const right = choiceIds.find(c => c.text === "Right").id, wrong = choiceIds.find(c => c.text === "Wrong").id;
    // An attachment FILE, named by the bank question's row.
    const rel = `attachments/${crypto.randomUUID()}.zip`;
    fs.mkdirSync(path.join(TEST_DATA_DIR, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DATA_DIR, rel), "PK\u0005\u0006" + "\0".repeat(18));
    rw(db => db.prepare("INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) VALUES (?,?,?,?,?,?,?,?,?,0)")
      .run(crypto.randomUUID(), T.id, "notes", "notes.zip", 22, "0".repeat(64), rel, new Date().toISOString(), "superadmin"));

    const E3 = await makeCompetition(sa, saCsrf, "mig3");
    const E4 = await makeCompetition(sa, saCsrf, "mig4", { group_leaderboard_enabled: true });
    const p1 = await makeParticipant(sa, saCsrf, "migp1"), p2 = await makeParticipant(sa, saCsrf, "migp2");
    for (const E of [E3, E4]) await enrol(sa, saCsrf, E.id, [p1.id, p2.id]);
    const g = async (name, ids) => (await (await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `${name} ${uniq("g")}`.slice(0, 80), userIds: ids } })).json()).group.id;
    const G1 = await g("MigG1", [p1.id]), G2 = await g("MigG2", [p2.id]);
    expect((await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [G1, G2], competitionIds: [E4.id] } })).ok()).toBeTruthy();

    // ── The previous release's shape, made by the real doors ──
    await legacy(true);
    try {
      for (const id of bank) {
        const a = await assign(sa, saCsrf, id, [E3.id, E4.id]);
        expect(a.copies.map(c => c.task_id), "PRECONDITION: legacy mode shares the bank question").toEqual([id, id]);
      }
    } finally { await legacy(false); }
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM competition_tasks WHERE task_id IN (?,?,?)").get(...bank).n), "PRECONDITION: two events share three questions").toBe(6);

    const act = async (who, E, steps) => {
      const p = await asParticipant(who.email, E.id);
      try { for (const s of steps) await s(p); } finally { await p.api.dispose(); }
    };
    const hint = (id) => async (p) => { const r = await p.api.post(`/api/tasks/${id}/hint`, { headers: H(p.csrf) }); expect(r.status(), await r.text()).toBe(200); };
    const ans = (id, a) => async (p) => { await submit(p, id, a); };
    await act(p1, E3, [ans(T.id, "nope"), hint(T.id), ans(T.id, "t"), ans(C.id, JSON.stringify([right])), ans(S.id, "sealed-key")]);
    await act(p2, E3, [ans(C.id, JSON.stringify([wrong]))]);
    await act(p1, E4, [ans(T.id, "t"), ans(C.id, JSON.stringify([right]))]);
    await act(p2, E4, [hint(T.id), ans(T.id, "x"), ans(T.id, "y"), ans(S.id, "sealed-key")]);
    const grant = await sa.post(`/api/admin/tasks/${T.id}/attempt-grant`, { headers: H(saCsrf), data: { userId: p2.id, competitionId: E4.id, extra: 1 } });
    expect(grant.status(), await grant.text()).toBe(200);
    const end = await sa.post(`/api/admin/competitions/${E4.id}/end-now`, { headers: H(saCsrf) });
    expect(end.status(), await end.text()).toBe(200);
    const p1api = await apiLogin(p1.email, PARTICIPANT_PASS);
    try {
      const m = await p1api.api.post(`/api/competitions/${E4.id}/badge`, { headers: H(p1api.csrf) });
      expect(m.status(), await m.text()).toBe(200);
    } finally { await p1api.api.dispose(); }
    await new Promise(r => setTimeout(r, 300));   // post-commit challenge_events drain

    const comps = [E3.id, E4.id];
    const rowsOf = (db, tb, ids) => db.prepare(`SELECT COUNT(*) n FROM ${tb} WHERE competition_id IN (?,?) AND task_id IN (SELECT value FROM json_each(?))`).get(...comps, JSON.stringify(ids)).n;
    const { MOVED_TABLES } = require("../lib/event-copies");
    const before = ro(db => Object.fromEntries(MOVED_TABLES.map(t => [t, rowsOf(db, t, bank)])));
    for (const t of MOVED_TABLES) expect(before[t], `PRECONDITION: ${t} holds rows under the shared questions`).toBeGreaterThan(0);
    // Score, finish and the finish time (stable once reached; a live event's
    // unfinished solve time moves with the clock, so it is not compared).
    const board = async (q) => { const r = await sa.get(`/api/admin/leaderboard?competitionId=${q}`); expect(r.ok()).toBeTruthy(); return (await r.json()).map(e => ({ key: e.userId || e.groupId || e.id, score: e.score, finished: e.allSolved, finishTime: e.finishTime ?? null })).sort((a, b) => String(a.key).localeCompare(String(b.key))); };
    const boardsBefore = { e3: await board(E3.id), e4: await board(E4.id), g4: await board(`${E4.id}&groups=1`) };
    expect(boardsBefore.e3.find(e => e.key === p1.id).score, "PRECONDITION: real scores").toBeGreaterThan(0);
    expect(boardsBefore.g4.length, "PRECONDITION: a frozen team board").toBeGreaterThan(1);
    const snapBefore = ro(db => db.prepare("SELECT * FROM group_leaderboard_snapshots WHERE competition_id=? ORDER BY slot_key").all(E4.id));
    expect(snapBefore.length, "PRECONDITION: the end froze the team board").toBe(1);
    const badgeBefore = ro(db => db.prepare("SELECT * FROM achievement_badges WHERE competition_id=?").all(E4.id));
    expect(badgeBefore.length, "PRECONDITION: an issued certificate").toBe(1);
    const tasksBefore = ro(db => db.prepare("SELECT COUNT(*) n FROM tasks").get().n);

    // ── (e) The dry runs report and write nothing ──
    const dry = await (await sa.post("/api/test/event-copies-migrate", { headers: H(saCsrf), data: { dryRun: true } })).json();
    const dryFor = (rep) => Object.fromEntries(rep.events.filter(e => comps.includes(e.competition_id)).map(e => [e.competition_id, e]));
    const d = dryFor(dry);
    expect(Object.keys(d).sort()).toEqual([...comps].sort());
    expect([d[E3.id].questions, d[E4.id].questions], "three shared questions in each event").toEqual([3, 3]);
    for (const t of MOVED_TABLES) expect(d[E3.id].rows[t] + d[E4.id].rows[t], `dry run counts ${t}`).toBe(before[t]);
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM tasks").get().n), "the dry run made no question").toBe(tasksBefore);
    expect(ro(db => Object.fromEntries(MOVED_TABLES.map(t => [t, rowsOf(db, t, bank)]))), "…and moved no row").toEqual(before);
    // The operator's script: read-only, against the live file, its own report.
    const script = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "event-copies-dry-run.js"), "--json"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", DATA_DIR: TEST_DATA_DIR, UPLOADS_DIR: path.join(TEST_DATA_DIR, "unused-uploads") }, encoding: "utf8",
    });
    expect(script.status, script.stderr).toBe(0);
    const sd = dryFor(JSON.parse(script.stdout));
    expect([sd[E3.id].questions, sd[E4.id].questions], "the script agrees").toEqual([3, 3]);
    for (const t of MOVED_TABLES) expect(sd[E3.id].rows[t] + sd[E4.id].rows[t], `script counts ${t}`).toBe(before[t]);
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM tasks").get().n), "the script made no question").toBe(tasksBefore);

    // ── (d) The migration ──
    const mig = await (await sa.post("/api/test/event-copies-migrate", { headers: H(saCsrf), data: {} })).json();
    expect(dryFor(mig)[E3.id].questions).toBe(3);
    expect(ro(db => Object.fromEntries(MOVED_TABLES.map(t => [t, rowsOf(db, t, bank)]))), "no row of either event names a bank question any more")
      .toEqual(Object.fromEntries(MOVED_TABLES.map(t => [t, 0])));
    const copyOf = (id, E) => ro(db => db.prepare("SELECT id FROM tasks WHERE owner_competition_id=? AND copied_from_task_id=?").all(E, id).map(r => r.id));
    for (const E of comps) for (const id of bank) {
      const c = copyOf(id, E);
      expect(c.length, `exactly one copy of ${id} in ${E}`).toBe(1);
      expect(ro(db => db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(E, c[0])), "assigned in place of the bank question").toBeTruthy();
    }
    const after = ro(db => Object.fromEntries(MOVED_TABLES.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t} t JOIN tasks k ON k.id=t.task_id WHERE t.competition_id IN (?,?) AND k.owner_competition_id=t.competition_id AND k.copied_from_task_id IN (SELECT value FROM json_each(?))`).get(...comps, JSON.stringify(bank)).n])));
    expect(after, "every row moved, under its own event's copy").toEqual(before);
    // The copies carry the question: option ids, seal and author, the file.
    const cC = taskRow(copyOf(C.id, E3.id)[0]), cS = taskRow(copyOf(S.id, E3.id)[0]);
    expect({ choices: cC.choices, key: cC.correct_answer }, "the choice copy keeps its option ids").toEqual({ choices: taskRow(C.id).choices, key: taskRow(C.id).correct_answer });
    expect({ sealed: cS.answer_sealed, author: cS.created_by_id }).toEqual({ sealed: 1, author: author.id });
    const cT = copyOf(T.id, E3.id)[0];
    const att = ro(db => db.prepare("SELECT id, storage_path FROM task_attachments WHERE task_id=?").all(cT));
    expect(att.map(a => a.storage_path), "the copy names the same file").toEqual([rel]);
    // Scores, boards, the frozen team board and the certificate read the same.
    expect({ e3: await board(E3.id), e4: await board(E4.id), g4: await board(`${E4.id}&groups=1`) }).toEqual(boardsBefore);
    expect(ro(db => db.prepare("SELECT * FROM group_leaderboard_snapshots WHERE competition_id=? ORDER BY slot_key").all(E4.id))).toEqual(snapBefore);
    expect(ro(db => db.prepare("SELECT * FROM achievement_badges WHERE competition_id=?").all(E4.id))).toEqual(badgeBefore);
    // The library holds the bank questions, never a copy.
    const exp = await (await sa.get("/api/admin/export/tasks")).json();
    expect(exp.tasks.filter(t => t.title === T.title).length, "the library export holds the bank question once").toBe(1);
    const lib = await (await sa.get("/api/admin/tasks")).json();
    expect(lib.filter(t => t.title === T.title && !t.owner_competition_id).map(t => t.id), "one bank row").toEqual([T.id]);
    // A re-run does nothing.
    const rerun = await (await sa.post("/api/test/event-copies-migrate", { headers: H(saCsrf), data: {} })).json();
    expect(Object.keys(dryFor(rerun)), "nothing left to copy").toEqual([]);
    // A participant still answering, with the bank id in an open tab, answers the event's copy.
    await act(p2, E3, [async (p) => { expect((await submit(p, T.id, "t")).correct).toBe(true); }]);
    expect(ro(db => db.prepare("SELECT task_id FROM submissions WHERE user_id=? AND competition_id=? AND is_correct=1 AND task_id=?").get(p2.id, E3.id, cT)), "stored under E3's copy").toBeTruthy();
    // The bank question can now go; the file its copies name stays.
    const del = await sa.delete(`/api/admin/tasks/${T.id}`, { headers: H(saCsrf) });
    expect(del.status(), await del.text()).toBe(200);
    await new Promise(r => setTimeout(r, 300));
    expect(fs.existsSync(path.join(TEST_DATA_DIR, rel)), "a file another row names is never unlinked").toBe(true);
    expect(taskRow(cT).copied_from_task_id, "the copy keeps its origin").toBe(T.id);
  });
});
