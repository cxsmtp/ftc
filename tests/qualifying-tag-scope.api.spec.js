"use strict";

// MAKING A CHALLENGE A QUALIFYING QUESTION, OR UNDOING IT, IS A SCORING CHANGE.
//
// A `qualifying:<key>` tag takes the challenge out of scoring, out of the finish
// count and to the end of the numbering of every event holding it (and removing
// it puts it back), so both tag doors take the strict scoring gate
// (lib/event-admin.js `taskScoringEditDenied`: the owner, and every event holding
// it in the actor's scope), as publish and visibility do. The world: an event
// admin who WROTE two challenges, one used only by their own event and one also
// used by another organiser's event.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }
const TAG = "qualifying:scope_probe";
// The control's own key: an event asks each topic once (operator ruling N7), and
// the first test leaves TAG on the shared challenge, which event A holds too.
const OWN_TAG = "qualifying:scope_probe_own";

test.describe("Qualifying tag — the strict scoring gate at both tag doors", () => {
  let sa, saCsrf, ea, A, B, tShared, tOwn;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    A = await makeCompetition(sa, saCsrf, "qtagA");
    B = await makeCompetition(sa, saCsrf, "qtagB");
    const who = await makeParticipant(sa, saCsrf, "qtagea");
    await grantEventAdmin(sa, saCsrf, A.id, who.id);
    ea = await apiLogin(who.email);
    // Pick-one questions: only one can carry a qualifying tag (lib/qualifying.js).
    const PICK = { answer_type: "any", correct_answer: "", choices: [{ text: "Few" }, { text: "Many" }] };
    tShared = await makeTask(ea.api, ea.csrf, "qtagShared", PICK);
    await assignTask(ea.api, ea.csrf, tShared.id, [A.id]);
    await assignTask(sa, saCsrf, tShared.id, [B.id]);
    tOwn = await makeTask(ea.api, ea.csrf, "qtagOwn", PICK);
    await assignTask(ea.api, ea.csrf, tOwn.id, [A.id]);
  });

  test.afterAll(async () => { if (ea) await ea.api.dispose(); });

  const tags = async (id) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(id).map(r => r.tag); } finally { db.close(); }
  };
  const addTag = (api, csrf, id, tag) => api.post(`/api/admin/tasks/${id}/tags`, { headers: H(csrf), data: { tag } });
  const dropTag = (api, csrf, id, tag) => api.delete(`/api/admin/tasks/${id}/tags/${encodeURIComponent(tag)}`, { headers: H(csrf) });

  test("the writer of a challenge another organiser's event uses can neither make it a qualifying question nor undo one", async () => {
    const add = await addTag(ea.api, ea.csrf, tShared.id, TAG);
    expect(add.status(), `add: ${await add.text()}`).toBe(403);
    expect((await json(add)).code).toBe("event_admin_scoring_locked");
    // Ruling N7's rule at this door: another organiser's event is named only to
    // its organisers, so this refusal does not name it either.
    expect(await add.text(), "the refusal names no event the writer does not organise").not.toContain(B.name);
    expect(await tags(tShared.id), "the refused add changed nothing").not.toContain(TAG);

    const byAdmin = await addTag(sa, saCsrf, tShared.id, TAG);
    expect(byAdmin.status(), `PRECONDITION: a superadmin makes it one: ${await byAdmin.text()}`).toBe(200);
    const drop = await dropTag(ea.api, ea.csrf, tShared.id, TAG);
    expect(drop.status(), `remove: ${await drop.text()}`).toBe(403);
    expect((await json(drop)).code).toBe("event_admin_scoring_locked");
    expect(await drop.text(), "nor does the removal's").not.toContain(B.name);
    expect(await tags(tShared.id), "the refused removal changed nothing").toContain(TAG);

    // An ordinary tag on the same challenge stays the owner's (CONTROL: the
    // strict gate is for the scoring tag only).
    const plain = await addTag(ea.api, ea.csrf, tShared.id, "category:probe");
    expect(plain.status(), `CONTROL: an ordinary tag: ${await plain.text()}`).toBe(200);
  });

  test("CONTROL: the writer of a challenge used only by their own event makes it a qualifying question and undoes it", async () => {
    const add = await addTag(ea.api, ea.csrf, tOwn.id, OWN_TAG);
    expect(add.status(), `add: ${await add.text()}`).toBe(200);
    expect(await tags(tOwn.id)).toContain(OWN_TAG);
    const drop = await dropTag(ea.api, ea.csrf, tOwn.id, OWN_TAG);
    expect(drop.status(), `remove: ${await drop.text()}`).toBe(200);
    expect(await tags(tOwn.id)).not.toContain(OWN_TAG);
  });
});
