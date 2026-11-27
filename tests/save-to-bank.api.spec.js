// @ts-check
//
// STAGE B — SAVE TO BANK (POST /api/admin/tasks/:id/save-to-bank,
// lib/event-copies.js copyTaskToBank).
//
// An event's own question is copied back into the Question bank as a NEW bank
// question: never a link and never an overwrite of the bank question it came
// from. Pinned by value:
//
//   * the new row is a bank question (no owner, no origin) holding the event's
//     wording, answer, topic and tags, its free tags and needs markers included
//     but never a qualifying tag; it belongs to whoever saved it; its first
//     version is recorded `via: save_to_bank`, naming the source and its event;
//   * the source, and the bank question it was copied from, are unchanged, and a
//     later edit of either reaches neither (no link);
//   * refusals: a bank question (400), a quick question (400), an event admin
//     on an event they do not run (403, a superadmin CONTROL saves the same
//     question), a sealed answer the caller may not read (403), and a competitor
//     (403 competitor_cannot_edit).
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, enrol, grantEventAdmin, eventCopyOf } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

function ro(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const row = (id) => ro(db => db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
const tags = (id) => ro(db => db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(id).map(r => r.tag));
const save = (api, csrf, id) => api.post(`/api/admin/tasks/${id}/save-to-bank`, { headers: H(csrf) });

test.describe("Save to bank", () => {
  test("copies an event's own question into the bank as a new, unlinked bank question", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comp = await makeCompetition(sa, saCsrf, "stb-event");
    const ea = await makeParticipant(sa, saCsrf, "stb-ea");
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
    const { api: eaApi, csrf: eaCsrf } = await apiLogin(ea.email, PARTICIPANT_PASS);

    const topic = (await (await sa.post("/api/admin/topics", { headers: H(saCsrf), data: { name: uniq("STB topic") } })).json()).id;
    const bank = await makeTask(sa, saCsrf, "stb-bank", { correct_answer: "bank-answer", topic_id: topic });
    for (const tag of ["reuse-2024", "needs:desktop"]) {
      expect((await sa.post(`/api/admin/tasks/${bank.id}/tags`, { headers: H(saCsrf), data: { tag } })).ok()).toBeTruthy();
    }
    expect((await sa.post(`/api/admin/tasks/${bank.id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();
    const copy = eventCopyOf(bank.id, comp.id);
    expect(copy, "PRECONDITION: the event holds its own copy").toBeTruthy();
    // The organiser edits the event's question, answer included, for this event only.
    const edit = await eaApi.put(`/api/admin/tasks/${copy}`, { headers: H(eaCsrf), data: { title: `${bank.title} (event)`, correct_answer: "event-answer" } });
    expect(edit.ok(), await edit.text()).toBeTruthy();

    const r = await save(eaApi, eaCsrf, copy);
    expect(r.ok(), await r.text()).toBeTruthy();
    const { id } = await r.json();
    expect([bank.id, copy], "a NEW row").not.toContain(id);
    const n = row(id);
    expect({ owner: n.owner_competition_id, origin: n.copied_from_task_id, title: n.title, key: n.correct_answer, topic: n.topic_id, by: n.created_by_id, locked: n.locked })
      .toEqual({ owner: null, origin: null, title: `${bank.title} (event)`, key: "event-answer", topic, by: ea.id, locked: 0 });
    expect(tags(id), "its tags, free ones and markers alike").toEqual(["needs:desktop", "reuse-2024"]);
    const ver = ro(db => db.prepare("SELECT change_type FROM task_versions WHERE task_id=? ORDER BY version_num").all(id).map(v => v.change_type));
    expect(ver).toEqual(["create"]);
    const ev = ro(db => db.prepare("SELECT event_type, details, competition_id FROM orphan_events WHERE scope='task' AND scope_id=?").all(id));
    expect(ev.length).toBe(1);
    expect({ t: ev[0].event_type, comp: ev[0].competition_id, d: JSON.parse(ev[0].details) })
      .toMatchObject({ t: "created", comp: comp.id, d: { via: "save_to_bank", saved_from: copy } });

    // Unlinked: the source and the original bank question are unchanged, and an
    // edit of the new bank question reaches neither.
    expect({ bank: row(bank.id).correct_answer, copy: row(copy).correct_answer }).toEqual({ bank: "bank-answer", copy: "event-answer" });
    expect((await eaApi.put(`/api/admin/tasks/${id}`, { headers: H(eaCsrf), data: { correct_answer: "new-bank-answer" } })).ok(), "the saver owns the new bank question").toBeTruthy();
    expect({ bank: row(bank.id).correct_answer, copy: row(copy).correct_answer, mine: row(id).correct_answer })
      .toEqual({ bank: "bank-answer", copy: "event-answer", mine: "new-bank-answer" });
    // The admin list shows it as a bank question.
    const lib = await (await eaApi.get("/api/admin/tasks")).json();
    expect(lib.find(t => t.id === id)).toMatchObject({ owner_competition_id: null, topic_id: topic });
    await eaApi.dispose(); await sa.dispose();
  });

  test("refusals: a bank question, a quick question, another organiser's event, a sealed key, a competitor", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const mine = await makeCompetition(sa, saCsrf, "stb-mine");
    const theirs = await makeCompetition(sa, saCsrf, "stb-theirs");
    const ea = await makeParticipant(sa, saCsrf, "stb-ea2");
    await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
    const { api: eaApi, csrf: eaCsrf } = await apiLogin(ea.email, PARTICIPANT_PASS);

    const bank = await makeTask(sa, saCsrf, "stb-r-bank");
    const b400 = await save(sa, saCsrf, bank.id);
    expect(b400.status()).toBe(400);
    expect((await b400.json()).code).toBe("save_to_bank_not_event");
    expect((await save(sa, saCsrf, "no-such-question")).status()).toBe(404);

    // Another organiser's event: refused to the event admin, saved by the superadmin (CONTROL).
    const inTheirs = await makeTask(sa, saCsrf, "stb-r-theirs", { competitionId: theirs.id });
    const before = ro(db => db.prepare("SELECT COUNT(*) n FROM tasks WHERE title=?").get(inTheirs.title).n);
    const r403 = await save(eaApi, eaCsrf, inTheirs.id);
    expect(r403.status()).toBe(403);
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM tasks WHERE title=?").get(inTheirs.title).n), "nothing was copied").toBe(before);
    expect((await save(sa, saCsrf, inTheirs.id)).ok(), "CONTROL: the superadmin saves it").toBeTruthy();

    // A quick question (qualifying) belongs to its event: one made in the event
    // (a pick-one question) and tagged on a key the event does not ask yet.
    const quick = await makeTask(sa, saCsrf, "stb-quick", { competitionId: mine.id, answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] });
    const qt = await sa.post(`/api/admin/tasks/${quick.id}/tags`, { headers: H(saCsrf), data: { tag: `qualifying:stb${Date.now() % 100000}` } });
    expect(qt.ok(), `PRECONDITION: the question is a quick question: ${await qt.text()}`).toBeTruthy();
    const q400 = await save(sa, saCsrf, quick.id);
    expect(q400.status()).toBe(400);
    expect((await q400.json()).code).toBe("save_to_bank_qualifying");
    // CONTROL: the same kind of question, untagged, saves.
    const plainAny = await makeTask(sa, saCsrf, "stb-any", { competitionId: mine.id, answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] });
    expect((await save(sa, saCsrf, plainAny.id)).ok(), "CONTROL: an untagged pick-one question saves").toBeTruthy();

    // A sealed key the caller may not read: the superadmin (not the author,
    // not revealed) is refused; the author saves it and still owns the seal.
    const sealedByEa = await makeTask(eaApi, eaCsrf, "stb-sealed", { competitionId: mine.id, answer_sealed: true });
    const s403 = await save(sa, saCsrf, sealedByEa.id);
    expect(s403.status(), "a sealed key the caller cannot read").toBe(403);
    const sOk = await save(eaApi, eaCsrf, sealedByEa.id);
    expect(sOk.ok(), await sOk.text()).toBeTruthy();
    const sid = (await sOk.json()).id;
    expect({ sealed: row(sid).answer_sealed, by: row(sid).created_by_id }).toEqual({ sealed: 1, by: ea.id });

    // A competitor: a second organiser of a staff-compete event, enrolled in it,
    // asked about a sealed question the first organiser wrote there (the author
    // could not compete: the assign door skips them).
    const compete = await makeCompetition(sa, saCsrf, "stb-compete", { staff_compete: true });
    await grantEventAdmin(sa, saCsrf, compete.id, ea.id);
    const held = await makeTask(eaApi, eaCsrf, "stb-held", { competitionId: compete.id, answer_sealed: true });
    const rival = await makeParticipant(sa, saCsrf, "stb-rival");
    await grantEventAdmin(sa, saCsrf, compete.id, rival.id);
    await enrol(sa, saCsrf, compete.id, [rival.id]);
    const { api: rApi, csrf: rCsrf } = await apiLogin(rival.email, PARTICIPANT_PASS);
    const c403 = await save(rApi, rCsrf, held.id);
    expect(c403.status()).toBe(403);
    expect((await c403.json()).code).toBe("competitor_cannot_edit");
    await rApi.dispose();
    await eaApi.dispose(); await sa.dispose();
  });
});
