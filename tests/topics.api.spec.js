// @ts-check
//
// STAGE B — TOPICS (lib/topics.js, routes/topics.js).
//
// A question belongs to at most one topic; a topic holds many. Pinned here:
//
//   1. THE MIGRATION, by value: a database whose questions carry `category:`
//      tags and no topic is booted (db.js runs the one-shot again once its
//      marker is gone) and each question is filed under its FIRST category,
//      one topic per name; a question that already has a topic is left alone,
//      and the tags are kept. Control: a question with no category stays topicless.
//   2. CRUD: create (201), a name taken case-insensitively (409 topic_exists),
//      rename, rename onto another topic's name (409), delete an empty topic,
//      delete a held one refused (409, can_move) until `move_to` names where
//      the questions go (another topic, or none); every change audited.
//   3. SCOPE for an event admin: may create; may not rename or delete a topic
//      somebody else made (403 topic_not_yours); may rename their own; may not
//      move questions out of their own held topic (can_move false); the counts
//      they read are their own visible bank questions (a superadmin control
//      counts the one they cannot see).
//   4. PARTICIPANTS' `categories`: a question with a topic shows exactly the
//      topic's name (its legacy category tags no longer), one without falls
//      back to its tags; an event's copy takes its bank question's topic.
//   5. The task create/PUT `topic_id` field: refused when it names no topic or
//      is not text, cleared by null, and the History records the change by NAME.
//   6. Export carries the topic by name; import files the question under the
//      topic of that name, made when missing.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, enrol, grantEventAdmin, eventCopyOf } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

function ro(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const topicRow = (id) => ro(db => db.prepare("SELECT * FROM topics WHERE id=?").get(id));
const taskTopic = (id) => ro(db => (db.prepare("SELECT topic_id FROM tasks WHERE id=?").get(id) || {}).topic_id || null);
const orphanEvents = (id) => ro(db => db.prepare("SELECT event_type, details FROM orphan_events WHERE scope='topic' AND scope_id=? ORDER BY changed_at, rowid").all(id));

async function mkTopic(api, csrf, name) {
  const r = await api.post("/api/admin/topics", { headers: H(csrf), data: { name } });
  expect(r.status(), `create topic ${name}: ${await r.text()}`).toBe(201);
  return (await r.json()).id;
}
async function setTopic(api, csrf, taskId, topicId) {
  const r = await api.put(`/api/admin/tasks/${taskId}`, { headers: H(csrf), data: { topic_id: topicId } });
  expect(r.ok(), `file task under topic: ${r.status()} ${await r.text()}`).toBeTruthy();
}

test.describe("Topics — the one-shot migration from category tags", () => {
  test("each question is filed under its first category, one topic per name; topics already set and the tags are kept", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topics-mig-"));
    const up = path.join(dir, "uploads");
    fs.mkdirSync(up);
    const saved = { DATA_DIR: process.env.DATA_DIR, UPLOADS_DIR: process.env.UPLOADS_DIR };
    const purge = () => { for (const k of Object.keys(require.cache)) if (k.endsWith(`${path.sep}db.js`) || k.includes(`${path.sep}lib${path.sep}`)) delete require.cache[k]; };
    try {
      process.env.DATA_DIR = dir; process.env.UPLOADS_DIR = up;
      purge();
      let db = require("../db");
      const ins = db.prepare("INSERT INTO tasks (id,title,description,difficulty,answer_type,correct_answer,active,status) VALUES (?,?,'d','easy','text','a',1,'published')");
      const tag = db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)");
      ins.run("q-web", "Web one"); tag.run("q-web", "category:web"); tag.run("q-web", "category:zeta"); tag.run("q-web", "needs-review");
      ins.run("q-web2", "Web two"); tag.run("q-web2", "category: Web");
      ins.run("q-api", "Api one"); tag.run("q-api", "category:api");
      ins.run("q-plain", "Plain"); tag.run("q-plain", "needs-review");
      ins.run("q-set", "Already filed"); tag.run("q-set", "category:crypto");
      db.prepare("INSERT INTO topics (id, name, created_at) VALUES ('t-keep','Kept topic','2026-01-01T00:00:00Z')").run();
      db.prepare("UPDATE tasks SET topic_id='t-keep' WHERE id='q-set'").run();
      db.prepare("DELETE FROM settings WHERE key='topics_from_categories_at'").run();
      db.close();
      purge();
      db = require("../db");   // boots the migrations again over the planted rows
      const topicOf = (id) => { const r = db.prepare("SELECT tp.name FROM tasks t LEFT JOIN topics tp ON tp.id=t.topic_id WHERE t.id=?").get(id); return r && r.name; };
      expect({ web: topicOf("q-web"), web2: topicOf("q-web2"), api: topicOf("q-api"), plain: topicOf("q-plain") ?? null, set: topicOf("q-set") })
        .toEqual({ web: "web", web2: "web", api: "api", plain: null, set: "Kept topic" });
      expect(db.prepare("SELECT COUNT(*) n FROM topics WHERE name='web' COLLATE NOCASE").get().n, "one topic per name").toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM topics WHERE name='zeta'").get().n, "only the FIRST category becomes the topic").toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM topics WHERE name='crypto'").get().n, "a question with a topic is left alone").toBe(0);
      expect(db.prepare("SELECT tag FROM task_tags WHERE task_id='q-web' ORDER BY tag").all().map(r => r.tag),
        "no stored tag is deleted").toEqual(["category:web", "category:zeta", "needs-review"]);
      expect(db.prepare("SELECT value FROM settings WHERE key='topics_from_categories_at'").get(), "the marker is written").toBeTruthy();
      db.close();
    } finally {
      process.env.DATA_DIR = saved.DATA_DIR; process.env.UPLOADS_DIR = saved.UPLOADS_DIR;
      purge();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("Topics — create, rename, delete", () => {
  test("CRUD with the case-insensitive name rule, the move on delete, and the audit trail", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const name = uniq("Web security");
    const id = await mkTopic(api, csrf, name);
    expect(topicRow(id).name).toBe(name);
    const dup = await api.post("/api/admin/topics", { headers: H(csrf), data: { name: name.toUpperCase() } });
    expect(dup.status(), "a name taken case-insensitively").toBe(409);
    expect((await dup.json()).code).toBe("topic_exists");
    for (const bad of ["", "   ", "x".repeat(61), "a\u0007b", 42]) {
      const r = await api.post("/api/admin/topics", { headers: H(csrf), data: { name: bad } });
      expect(r.status(), `refused: ${JSON.stringify(bad)}`).toBe(400);
    }

    const renamed = `${name} renamed`;
    const rn = await api.put(`/api/admin/topics/${id}`, { headers: H(csrf), data: { name: renamed } });
    expect(rn.ok()).toBeTruthy();
    expect(topicRow(id).name).toBe(renamed);
    const other = await mkTopic(api, csrf, uniq("Crypto"));
    const clash = await api.put(`/api/admin/topics/${other}`, { headers: H(csrf), data: { name: renamed.toLowerCase() } });
    expect(clash.status(), "rename onto another topic's name").toBe(409);

    // Delete, held: refused until the questions have somewhere to go.
    const q1 = await makeTask(api, csrf, "topic-q1");
    const q2 = await makeTask(api, csrf, "topic-q2");
    await setTopic(api, csrf, q1.id, id); await setTopic(api, csrf, q2.id, id);
    const held = await api.delete(`/api/admin/topics/${id}`, { headers: H(csrf) });
    expect(held.status()).toBe(409);
    expect(await held.json()).toMatchObject({ code: "topic_not_empty", questions: 2, can_move: true });
    expect(topicRow(id), "nothing was deleted").toBeTruthy();
    const mv = await api.delete(`/api/admin/topics/${id}`, { headers: H(csrf), data: { move_to: other } });
    expect(mv.ok(), await mv.text()).toBeTruthy();
    expect((await mv.json()).moved).toBe(2);
    expect({ gone: topicRow(id) ?? null, q1: taskTopic(q1.id), q2: taskTopic(q2.id) }).toEqual({ gone: null, q1: other, q2: other });
    // …and to no topic.
    const none = await api.delete(`/api/admin/topics/${other}`, { headers: H(csrf), data: { move_to: null } });
    expect(none.ok()).toBeTruthy();
    expect({ q1: taskTopic(q1.id), q2: taskTopic(q2.id) }).toEqual({ q1: null, q2: null });
    // An empty topic goes with no move.
    const empty = await mkTopic(api, csrf, uniq("Empty"));
    expect((await api.delete(`/api/admin/topics/${empty}`, { headers: H(csrf) })).ok()).toBeTruthy();

    // The audit trail, by value.
    const ev = orphanEvents(id).map(e => ({ t: e.event_type, d: JSON.parse(e.details) }));
    expect(ev.map(e => e.t)).toEqual(["created", "edited", "deleted"]);
    expect(ev[1].d.changes.name).toEqual({ from: name, to: renamed });
    expect(ev[2].d).toMatchObject({ name: renamed, questions_moved: 2 });
    expect(ev[0].d.ip, "the request context rides every entry").toBeTruthy();
    await api.dispose();
  });
});

test.describe("Topics — an event admin's scope", () => {
  test("creates topics, manages only their own, cannot move questions out, and counts only what they can see", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const mine = await makeCompetition(sa, saCsrf, "topics-mine");
    const ea = await makeParticipant(sa, saCsrf, "topics-ea");
    await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
    const { api: eaApi, csrf: eaCsrf } = await apiLogin(ea.email, PARTICIPANT_PASS);

    const adminTopic = await mkTopic(sa, saCsrf, uniq("Admin topic"));
    const hidden = await makeTask(sa, saCsrf, "topic-hidden");   // the superadmin's, not shared: the event admin cannot see it
    await setTopic(sa, saCsrf, hidden.id, adminTopic);

    const own = await mkTopic(eaApi, eaCsrf, uniq("EA topic"));
    expect(topicRow(own).created_by_id, "the creator is recorded").toBe(ea.id);
    const q = await makeTask(eaApi, eaCsrf, "topic-ea-q");
    await setTopic(eaApi, eaCsrf, q.id, adminTopic);   // filing under somebody else's topic is allowed

    const list = await (await eaApi.get("/api/admin/topics")).json();
    const a = list.find(x => x.id === adminTopic), o = list.find(x => x.id === own);
    expect({ count: a.question_count, can: a.can_manage }, "the event admin counts only their own visible question").toEqual({ count: 1, can: false });
    expect(String(a.manage_refusal || "")).toMatch(/administrator/);
    expect(o.can_manage).toBe(true);
    const saList = await (await sa.get("/api/admin/topics")).json();
    expect(saList.find(x => x.id === adminTopic).question_count, "CONTROL: the superadmin counts both").toBe(2);

    for (const [method, data] of [["put", { name: uniq("Hijack") }], ["delete", { move_to: null }]]) {
      const r = await eaApi[method](`/api/admin/topics/${adminTopic}`, { headers: H(eaCsrf), data });
      expect(r.status(), `${method} somebody else's topic`).toBe(403);
      expect((await r.json()).code).toBe("topic_not_yours");
    }
    expect(topicRow(adminTopic), "nothing changed").toMatchObject({ id: adminTopic });

    const rn = await eaApi.put(`/api/admin/topics/${own}`, { headers: H(eaCsrf), data: { name: uniq("EA renamed") } });
    expect(rn.ok(), "their own topic renames").toBeTruthy();
    await setTopic(eaApi, eaCsrf, q.id, own);
    const del = await eaApi.delete(`/api/admin/topics/${own}`, { headers: H(eaCsrf), data: { move_to: null } });
    expect(del.status(), "a scoped creator may not move questions out").toBe(409);
    expect(await del.json()).toMatchObject({ code: "topic_not_empty", can_move: false });
    expect(taskTopic(q.id), "the question stayed filed").toBe(own);
    await setTopic(eaApi, eaCsrf, q.id, null);
    expect((await eaApi.delete(`/api/admin/topics/${own}`, { headers: H(eaCsrf) })).ok(), "an empty own topic deletes").toBeTruthy();
    await eaApi.dispose(); await sa.dispose();
  });
});

test.describe("Topics — participants and the question's topic field", () => {
  test("a topic is the participant's category; the copy takes its bank question's topic; no topic falls back to tags", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comp = await makeCompetition(sa, saCsrf, "topics-play");
    const p = await makeParticipant(sa, saCsrf, "topics-player");
    await enrol(sa, saCsrf, comp.id, [p.id]);
    const tname = uniq("Cloud");
    const topic = await mkTopic(sa, saCsrf, tname);
    const withTopic = await makeTask(sa, saCsrf, "topic-play-1", { topic_id: topic });
    const legacy = await makeTask(sa, saCsrf, "topic-play-2");
    for (const [id, tag] of [[withTopic.id, "category:legacyname"], [legacy.id, "category:legacyname"]]) {
      expect((await sa.post(`/api/admin/tasks/${id}/tags`, { headers: H(saCsrf), data: { tag } })).ok()).toBeTruthy();
    }
    for (const id of [withTopic.id, legacy.id]) {
      expect((await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();
    }
    const c1 = eventCopyOf(withTopic.id, comp.id), c2 = eventCopyOf(legacy.id, comp.id);
    expect(taskTopic(c1), "the event's copy takes the bank question's topic").toBe(topic);

    const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
    expect((await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
    const list = await (await api.get("/api/tasks")).json();
    const byId = Object.fromEntries(list.map(t => [t.id, t.categories]));
    expect({ topic: byId[c1], legacy: byId[c2] }).toEqual({ topic: [tname], legacy: ["legacyname"] });
    expect((await (await api.get(`/api/tasks/${c1}`)).json()).categories, "the detail agrees").toEqual([tname]);

    // Renaming the topic reaches the participant at once.
    const renamed = `${tname} 2`;
    expect((await sa.put(`/api/admin/topics/${topic}`, { headers: H(saCsrf), data: { name: renamed } })).ok()).toBeTruthy();
    expect((await (await api.get(`/api/tasks/${c1}`)).json()).categories).toEqual([renamed]);
    await api.dispose();

    // The field: refused when it names nothing or is not text, cleared by null.
    const bad = await sa.put(`/api/admin/tasks/${withTopic.id}`, { headers: H(saCsrf), data: { topic_id: "no-such-topic" } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).code).toBe("topic_not_found");
    expect((await sa.put(`/api/admin/tasks/${withTopic.id}`, { headers: H(saCsrf), data: { topic_id: { id: topic } } })).status()).toBe(400);
    expect((await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: { title: uniq("x"), difficulty: "easy", answer_type: "text", correct_answer: "a", topic_id: "nope" } })).status()).toBe(400);
    expect(taskTopic(withTopic.id), "a refused save changed nothing").toBe(topic);
    await setTopic(sa, saCsrf, withTopic.id, null);
    expect(taskTopic(withTopic.id)).toBeNull();
    const ver = ro(db => db.prepare("SELECT details FROM orphan_events WHERE scope='task' AND scope_id=? AND event_type='edited' ORDER BY changed_at DESC, rowid DESC LIMIT 1").get(withTopic.id));
    expect(JSON.parse(ver.details).changes.topic, "History names the topic").toEqual({ from: renamed, to: null });
    // The admin list carries the name beside the id.
    await setTopic(sa, saCsrf, legacy.id, topic);
    const row = (await (await sa.get("/api/admin/tasks")).json()).find(t => t.id === legacy.id);
    expect({ id: row.topic_id, name: row.topic_name }).toEqual({ id: topic, name: renamed });
    await sa.dispose();
  });

  test("export carries the topic by name; import files the question under that name, made when missing", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const tname = uniq("Exported topic");
    const topic = await mkTopic(sa, saCsrf, tname);
    const q = await makeTask(sa, saCsrf, "topic-export", { topic_id: topic });
    const file = await (await sa.get("/api/admin/export/tasks")).json();
    const row = file.tasks.find(t => t.title === q.title);
    expect(row.topic).toBe(tname);
    expect(Object.keys(row), "the local id does not travel").not.toContain("topic_id");

    const fresh = uniq("Imported topic");
    const t1 = { ...row, title: uniq("Imported A"), topic: tname.toUpperCase() };
    const t2 = { ...row, title: uniq("Imported B"), topic: fresh };
    const t3 = { ...row, title: uniq("Imported C"), topic: null };
    const imp = await sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: { data: { type: "hackarena-tasks", version: 1, tasks: [t1, t2, t3] }, resolutions: {} } });
    expect(imp.ok(), await imp.text()).toBeTruthy();
    const lib = await (await sa.get("/api/admin/tasks")).json();
    const got = (title) => lib.find(t => t.title === title && !t.owner_competition_id);
    expect({ a: got(t1.title).topic_id, b: got(t2.title).topic_name, c: got(t3.title).topic_id ?? null })
      .toEqual({ a: topic, b: fresh, c: null });
    const bad = await sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: { data: { type: "hackarena-tasks", version: 1, tasks: [{ ...row, title: uniq("Bad"), topic: { x: 1 } }] } } });
    expect(bad.status(), "a topic that is not text is a malformed file").toBe(400);
    await sa.dispose();
  });
});
