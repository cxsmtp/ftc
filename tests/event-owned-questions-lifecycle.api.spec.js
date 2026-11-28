// @ts-check
//
// EVENT-OWNED QUESTIONS (lib/event-copies.js) — what happens to an event's own
// copies over the event's life, beyond the assign doors event-owned-questions
// .api.spec.js holds:
//
//   (1) Deleting an event deletes the questions it owns — their tags and
//       attachment rows with them, and an attachment FILE no other row names —
//       while a file the bank question still names survives, and a question a
//       template names is released into the library rather than deleted.
//   (2) Re-adding a bank question to an event that still holds an (edited) copy
//       reuses that copy, so every refusal judges the COPY: an unassigned copy
//       edited into a `file` answer is refused at a Booth Event by all three
//       assign doors, while the bank question (text) is accepted elsewhere.
//   (3) A participant's attachment download naming the BANK question's ids, in
//       an event holding its copy, is served the copy's file.
//   (4) The desired-state PUT queues completion certificates per event COPY:
//       taking a question out of a Program queues the learner it completes and
//       never one who had already answered that event's copy.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, gradingHashFor, zipOf, awaitUploadRoom } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const ro = (fn) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return fn(db); } finally { db.close(); } };
const rw = (fn) => { const db = new Database(TEST_DB_PATH); try { return fn(db); } finally { db.close(); } };
const taskRow = (id) => ro(db => db.prepare("SELECT * FROM tasks WHERE id=?").get(id));

let sa, saCsrf;
test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
test.afterAll(async () => { try { await sa.dispose(); } catch (_) {} });

async function assign(taskId, competitionIds) {
  const r = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(saCsrf), data: { competitionIds } });
  expect(r.status(), `assign: ${await r.text()}`).toBe(200);
  return r.json();
}
async function upload(taskId, body) {
  if (typeof awaitUploadRoom === "function") await awaitUploadRoom();
  const r = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
    headers: { "x-csrf-token": saCsrf },
    multipart: { display_name: uniq("att"), file: { name: "a.zip", mimeType: "application/zip", buffer: zipOf("README.txt", body) } },
  });
  expect(r.status(), `upload: ${await r.text()}`).toBe(200);
  const row = ro(db => db.prepare("SELECT id, storage_path FROM task_attachments WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId));
  expect(row, "PRECONDITION: the attachment row exists").toBeTruthy();
  return row;
}
const fileOf = (rel) => path.join(TEST_DATA_DIR, rel);
async function inEvent(email, compId) {
  const p = await apiLogin(email, PARTICIPANT_PASS);
  const s = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: compId } });
  expect(s.ok(), `select ${compId}: ${await s.text()}`).toBeTruthy();
  return p;
}

test.describe("event-owned questions over the event's life", () => {
  test("(1) deleting an event deletes the questions it owns, their rows and unshared files; a template's question is released", async () => {
    const E = await makeCompetition(sa, saCsrf, "del", { start_time: new Date(Date.now() + 3_600_000).toISOString() });
    // A bank question with a file, copied into E: the copy's row names the SAME file.
    const B = await makeTask(sa, saCsrf, "del-bank");
    const bAtt = await upload(B.id, "bank file ".repeat(20));
    const C = (await assign(B.id, [E.id])).copies[0].task_id;
    const cAtt = ro(db => db.prepare("SELECT id, storage_path FROM task_attachments WHERE task_id=?").all(C));
    expect(cAtt.map(a => a.storage_path), "PRECONDITION: the copy names the bank question's file").toEqual([bAtt.storage_path]);
    // A question created in E, which a template will name: released, not deleted.
    const keep = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: { title: `Tpl-held ${uniq("q")}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", competitionId: E.id } });
    expect(keep.status(), await keep.text()).toBe(200);
    const Qk = (await keep.json()).id;
    const st = await sa.post(`/api/admin/competitions/${E.id}/save-as-template`, { headers: H(saCsrf), data: { name: `Saved ${uniq("s")}` } });
    expect(st.status(), await st.text()).toBe(200);
    expect((await st.json()).template.task_ids.sort(), "PRECONDITION: the template names the bank origin and the event's own question").toEqual([B.id, Qk].sort());
    // A question created in E after the template, with a file of its own and a tag.
    const own = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: { title: `Own ${uniq("q")}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", competitionId: E.id } });
    expect(own.status(), await own.text()).toBe(200);
    const Q = (await own.json()).id;
    const qAtt = await upload(Q, "own file ".repeat(20));
    const tg = await sa.post(`/api/admin/tasks/${Q}/tags`, { headers: H(saCsrf), data: { tag: "category:owned" } });
    expect(tg.ok(), await tg.text()).toBeTruthy();
    expect([fs.existsSync(fileOf(bAtt.storage_path)), fs.existsSync(fileOf(qAtt.storage_path))], "PRECONDITION: both files are on disk").toEqual([true, true]);
    expect(ro(db => db.prepare("SELECT id FROM tasks WHERE owner_competition_id=? ORDER BY id").all(E.id)).map(r => r.id), "PRECONDITION: E owns three questions")
      .toEqual([C, Qk, Q].sort());

    const del = await sa.delete(`/api/admin/competitions/${E.id}`, { headers: H(saCsrf) });
    expect(del.status(), await del.text()).toBe(200);

    expect([taskRow(C), taskRow(Q)], "the event's copy and its own question are gone").toEqual([undefined, undefined]);
    expect(ro(db => [C, Q].map(id => ({
      tags: db.prepare("SELECT COUNT(*) n FROM task_tags WHERE task_id=?").get(id).n,
      atts: db.prepare("SELECT COUNT(*) n FROM task_attachments WHERE task_id=?").get(id).n,
      versions: db.prepare("SELECT COUNT(*) n FROM task_versions WHERE task_id=?").get(id).n,
    }))), "with their tags, attachment rows and versions").toEqual([{ tags: 0, atts: 0, versions: 0 }, { tags: 0, atts: 0, versions: 0 }]);
    await expect.poll(() => fs.existsSync(fileOf(qAtt.storage_path)), { message: "the deleted question's own file is unlinked" }).toBe(false);
    expect(fs.existsSync(fileOf(bAtt.storage_path)), "the file the bank question still names survives").toBe(true);
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM task_attachments WHERE id=?").get(bAtt.id).n), "the bank question's row stays").toBe(1);
    expect({ bank: !!taskRow(B.id), bankOwner: taskRow(B.id).owner_competition_id }, "the bank question is untouched").toEqual({ bank: true, bankOwner: null });
    const kept = taskRow(Qk);
    expect({ exists: !!kept, owner: kept && kept.owner_competition_id }, "the question a template names is released into the library, not deleted").toEqual({ exists: true, owner: null });
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM tasks WHERE owner_competition_id=?").get(E.id).n), "nothing is left owned by the deleted event").toBe(0);
  });

  test("(2) re-adding a bank question reuses the event's edited copy, and every assign door judges that copy", async () => {
    const booth = { event_kind: "booth" };
    const E = await makeCompetition(sa, saCsrf, "reuse", booth);
    const E2 = await makeCompetition(sa, saCsrf, "reuse-ctl", booth);
    const B = await makeTask(sa, saCsrf, "reuse-bank");
    const C = (await assign(B.id, [E.id])).copies[0].task_id;
    // Take the copy out of E, then make it a file-answer question (unfit at a Booth Event).
    const out = await sa.delete(`/api/admin/tasks/${B.id}/competitions/${E.id}`, { headers: H(saCsrf) });
    expect(out.status(), await out.text()).toBe(200);
    const put = await sa.put(`/api/admin/tasks/${C}`, { headers: H(saCsrf), data: { answer_type: "file", correct_answer: "flag", expectedUpdatedAt: taskRow(C).updated_at } });
    expect(put.status(), await put.text()).toBe(200);
    expect([taskRow(C).answer_type, taskRow(B.id).answer_type], "PRECONDITION: only the copy is a file answer").toEqual(["file", "text"]);

    const single = await sa.post(`/api/admin/tasks/${B.id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [E.id] } });
    expect(single.status(), `single door: ${await single.text()}`).toBe(400);
    const bulk = await sa.post("/api/admin/tasks/assign-competitions", { headers: H(saCsrf), data: { taskIds: [B.id], competitionIds: [E.id] } });
    const bb = await bulk.json();
    expect({ status: bulk.status(), assigned: bb.assigned, unfit: bb.skipped.unfit }, "bulk door: skipped as unfit").toEqual({ status: 200, assigned: 0, unfit: 1 });
    const cur = (await (await sa.get("/api/admin/tasks")).json()).find(t => t.id === B.id).competitions.map(c => c.id);
    const pr = await sa.put(`/api/admin/tasks/${B.id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [...cur, E.id], expectedAssignments: cur } });
    expect(pr.status(), `desired-state door: ${await pr.text()}`).toBe(400);
    // (A Booth Event holds its qualifying questions from birth: count only B's lineage.)
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND (t.id=? OR t.copied_from_task_id=?)").get(E.id, B.id, B.id).n), "nothing of B's went into E").toBe(0);

    // CONTROL: E2 holds no copy, so the bank question (text) is judged and fits.
    const ok = await assign(B.id, [E2.id]);
    expect(ok.assigned).toBe(1);
    expect(taskRow(ok.copies[0].task_id).answer_type, "a fresh copy of the bank question").toBe("text");
    // CONTROL: the copy made fit again goes back into E — the copy, not a new one.
    const fix = await sa.put(`/api/admin/tasks/${C}`, { headers: H(saCsrf), data: { answer_type: "text", correct_answer: "k", expectedUpdatedAt: taskRow(C).updated_at } });
    expect(fix.status(), await fix.text()).toBe(200);
    const back = await assign(B.id, [E.id]);
    expect({ assigned: back.assigned, copy: back.copies[0].task_id }, "re-adding reuses the event's own copy").toEqual({ assigned: 1, copy: C });
  });

  test("(3) a participant's attachment download by the bank question's ids is served the event copy's file", async () => {
    const E = await makeCompetition(sa, saCsrf, "dl");
    const B = await makeTask(sa, saCsrf, "dl-bank");
    const body = "download me ".repeat(30);
    const bAtt = await upload(B.id, body);
    const C = (await assign(B.id, [E.id])).copies[0].task_id;
    const cAtt = ro(db => db.prepare("SELECT id FROM task_attachments WHERE task_id=?").get(C));
    expect(cAtt && cAtt.id !== bAtt.id, "PRECONDITION: the copy has its own attachment row").toBe(true);
    // A decoy bank question with a file of its own, never in E.
    const D = await makeTask(sa, saCsrf, "dl-decoy");
    const dAtt = await upload(D.id, "decoy ".repeat(30));
    const P = await makeParticipant(sa, saCsrf, "dlp"), N = await makeParticipant(sa, saCsrf, "dln");
    await enrol(sa, saCsrf, E.id, [P.id, N.id]);
    const p = await inEvent(P.email, E.id);
    try {
      const want = zipOf("README.txt", body);
      const own = await p.api.get(`/api/tasks/${C}/attachments/${cAtt.id}`);
      expect(own.status(), "CONTROL: the copy's own ids").toBe(200);
      expect(Buffer.compare(await own.body(), want)).toBe(0);
      for (const [tid, label] of [[B.id, "the bank question's ids"], [C, "the copy with the bank attachment id"]]) {
        const r = await p.api.get(`/api/tasks/${tid}/attachments/${bAtt.id}`);
        expect(r.status(), label).toBe(200);
        expect(Buffer.compare(await r.body(), want), `${label}: the same file`).toBe(0);
      }
      expect((await p.api.get(`/api/tasks/${B.id}/attachments/${dAtt.id}`)).status(), "another question's attachment id is not served").toBe(404);
      expect((await p.api.get(`/api/tasks/${D.id}/attachments/${dAtt.id}`)).status(), "a question the event does not hold is not served").toBe(404);
    } finally { await p.api.dispose(); }
  });

  test("(4) the desired-state PUT queues completion certificates per event copy", async () => {
    const cr = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `Prog ${uniq("p")}`, event_kind: "program", timezone: "UTC",
      start_time: new Date(Date.now() - 600_000).toISOString(), deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
    } });
    expect(cr.status(), await cr.text()).toBe(200);
    const prog = (await cr.json()).competition;
    const B1 = await makeTask(sa, saCsrf, "pc1", { correct_answer: "r1" });
    const B2 = await makeTask(sa, saCsrf, "pc2", { correct_answer: "r2" });
    const C1 = (await assign(B1.id, [prog.id])).copies[0].task_id;
    const C2 = (await assign(B2.id, [prog.id])).copies[0].task_id;
    const one = await makeParticipant(sa, saCsrf, "pc-one"), past = await makeParticipant(sa, saCsrf, "pc-past"), idle = await makeParticipant(sa, saCsrf, "pc-idle");
    await enrol(sa, saCsrf, prog.id, [one.id, past.id, idle.id]);
    const solve = async (u, ids) => {
      const p = await inEvent(u.email, prog.id);
      try {
        for (const [tid, ans] of ids) {
          const r = await p.api.post(`/api/tasks/${tid}/submit`, { headers: H(p.csrf), data: { answer: ans, gradingHash: await gradingHashFor(p.api, tid) } });
          expect(r.status(), await r.text()).toBe(200);
          expect((await r.json()).correct).toBe(true);
        }
      } finally { await p.api.dispose(); }
    };
    await solve(one, [[C1, "r1"]]);
    await solve(past, [[C1, "r1"], [C2, "r2"]]);
    const jobs = () => ro(db => db.prepare("SELECT user_id FROM certificate_dispatch_jobs WHERE competition_id=?").all(prog.id)).map(r => r.user_id).sort();
    expect(jobs(), "PRECONDITION: the learner who completed was queued at completion").toEqual([past.id]);
    // As if issued before automatic issue: their job is gone, no certificate.
    rw(db => db.prepare("DELETE FROM certificate_dispatch_jobs WHERE competition_id=?").run(prog.id));

    const r = await sa.put(`/api/admin/tasks/${B2.id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [], expectedAssignments: [prog.id] } });
    expect(r.status(), await r.text()).toBe(200);
    expect(ro(db => db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=?").all(prog.id)).map(x => x.task_id), "PRECONDITION: the event's copy of B2 is out").toEqual([C1]);
    expect(jobs(), "the learner the removal completed is queued; one who had answered the event's copy is not, nor one who answered nothing").toEqual([one.id]);
  });
});
