// @ts-check
//
// PICK-ONE QUESTIONS OUTSIDE THE SEED PATH: an `any` challenge that carries
// options (lib/choices.js `validateSurveyChoices`, `isSurveyTask`). The built-in
// qualifying questions are one; an organiser may author, edit, import and
// restore their own. Locked here, each by value:
//
//   * create and edit: two options or more, unique non-empty text; a single
//     option, a duplicate or an empty one is refused; no options is a free
//     response; an edit keeps the ids of the options it keeps;
//   * submit: exactly one of THIS challenge's option ids is correct and scores
//     the difficulty's points; anything else is refused before grading (no row);
//     the solved view names the participant's own pick (`my_choice_ids`);
//   * Recalculate grades a pick-one question by the `any` rule (every non-empty
//     answer is correct), so adding, removing or rewording an option never
//     turns an earlier answer wrong — with a `text` CONTROL that the same run
//     does re-grade;
//   * import keeps a valid row's option ids verbatim and skips a malformed one;
//   * restore brings a version's options back, ids included;
//   * the qualifying tag: a malformed key is refused, and adding or removing it
//     on a challenge in an event with an ended session is refused (a scoring
//     change on a final board);
//   * the editor's Options box authors one and keeps an untouched option's id.
//
// FIXTURES: every test owns its event, its challenges and its participants. An
// `any` challenge is solved by the first non-empty answer, so every event that
// must stay live holds an extra challenge nobody answers and a second
// participant who never plays (fixture checklist item 1): an all-solved
// auto-end would freeze the event, and Recalculate skips a frozen one.
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, BASE, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const ro = () => new Database(TEST_DB_PATH, { readonly: true });
const dbGet = (sql, ...a) => { const db = ro(); try { return db.prepare(sql).get(...a); } finally { db.close(); } };
const dbAll = (sql, ...a) => { const db = ro(); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const choicesOf = (taskId) => JSON.parse(dbGet("SELECT choices FROM tasks WHERE id=?", taskId).choices || "null");
const HEX8 = /^[a-f0-9]{8}$/;

let SA;
test.beforeAll(async () => { SA = await apiLogin("superadmin"); });
test.afterAll(async () => { try { await SA.api.dispose(); } catch (_) { /* already gone */ } });

async function createPickOne(texts, extra = {}) {
  const r = await SA.api.post("/api/admin/tasks", { headers: H(SA.csrf), data: {
    title: `PickOne ${uniq("p")}`, description: "d", difficulty: "easy", answer_type: "any",
    status: "published", choices: texts.map(text => ({ text })), ...extra } });
  return r;
}

/** A LIVE event holding `taskIds` plus a challenge nobody answers, two members, one playing. */
async function liveEventWith(taskIds, label) {
  const comp = await makeCompetition(SA.api, SA.csrf, label);
  const idle = await makeTask(SA.api, SA.csrf, `${label}-idle`);
  // `ids`: the event's OWN copy of each named question, in order (lib/event-copies.js).
  const ids = [];
  for (const id of taskIds) ids.push((await assignTask(SA.api, SA.csrf, id, [comp.id])).copies[0].task_id);
  await assignTask(SA.api, SA.csrf, idle.id, [comp.id]);
  const player = await makeParticipant(SA.api, SA.csrf, `${label}-player`);
  const bystander = await makeParticipant(SA.api, SA.csrf, `${label}-bystander`);
  await enrol(SA.api, SA.csrf, comp.id, [player.id, bystander.id]);
  const p = await apiLogin(player.email);
  const sel = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } });
  expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  return { comp, player, p, ids };
}
async function submit(p, compId, taskId, answer) {
  const gradingHash = await gradingHashFor(p.api, taskId);
  expect(gradingHash, "PRECONDITION: the challenge is readable to the participant").toBeTruthy();
  return p.api.post(`/api/tasks/${taskId}/submit`, { headers: { ...H(p.csrf), "x-competition-id": compId }, data: { answer, gradingHash } });
}
async function recalculate(taskId) {
  const r = await SA.api.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: H(SA.csrf), data: { confirm_live: true } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}
async function putTask(taskId, data) {
  const r = await SA.api.put(`/api/admin/tasks/${taskId}`, { headers: H(SA.csrf), data });
  return r;
}

test.describe("Pick-one questions — authoring through the API", () => {
  test("create and edit: two options or more with unique text; a single, duplicate or empty option is refused; none is a free response; an edit keeps the ids it keeps", async () => {
    const one = await createPickOne(["Only"]);
    expect(one.status(), await one.text()).toBe(400);
    expect((await one.json()).error).toMatch(/at least 2 options/);
    const dup = await createPickOne(["Same", "same"]);
    expect(dup.status()).toBe(400);
    expect((await dup.json()).error).toMatch(/same text/);
    const empty = await createPickOne(["Fine", "  "]);
    expect(empty.status()).toBe(400);
    expect((await empty.json()).error).toMatch(/cannot be empty/);

    const ok = await createPickOne(["Small", "Medium", "Large"]);
    expect(ok.status(), await ok.text()).toBe(200);
    const id = (await ok.json()).id;
    const stored = choicesOf(id);
    expect(stored.map(c => c.text), "the options, in the author's order").toEqual(["Small", "Medium", "Large"]);
    for (const c of stored) expect(c.id, "each option has a minted 8-hex id").toMatch(HEX8);
    expect(dbGet("SELECT correct_answer k FROM tasks WHERE id=?", id).k, "an `any` challenge stores no key").toBe("");

    // CONTROL: an `any` challenge with no options is a free response.
    const free = await SA.api.post("/api/admin/tasks", { headers: H(SA.csrf), data: {
      title: `Free ${uniq("f")}`, description: "d", difficulty: "easy", answer_type: "any", status: "published" } });
    expect(free.status(), await free.text()).toBe(200);
    expect(choicesOf((await free.json()).id), "no options: a free response").toBeNull();

    // An edit: one option alone is refused; a kept option keeps its id.
    const bad = await putTask(id, { choices: [{ id: stored[0].id, text: "Small" }] });
    expect(bad.status(), await bad.text()).toBe(400);
    expect(choicesOf(id), "a refused edit changed nothing").toEqual(stored);
    const good = await putTask(id, { choices: [{ id: stored[0].id, text: "Small" }, { id: stored[2].id, text: "Huge" }, { text: "Tiny" }] });
    expect(good.status(), await good.text()).toBe(200);
    const after = choicesOf(id);
    expect(after.map(c => c.text)).toEqual(["Small", "Huge", "Tiny"]);
    expect(after[0].id, "a kept option keeps its id").toBe(stored[0].id);
    expect(after[1].id, "a reworded option keeps its id").toBe(stored[2].id);
    expect(after[2].id, "a new option gets a new id").toMatch(HEX8);
    expect(stored.map(c => c.id), "…one not taken from another option").not.toContain(after[2].id);
  });

  test("submit: one of the options is correct and scores the difficulty's points; anything else is refused before grading; the solved view names the participant's own pick", async () => {
    const cr = await createPickOne(["Red", "Green"]);
    expect(cr.status(), await cr.text()).toBe(200);
    const taskBank = (await cr.json()).id;
    const [red, green] = choicesOf(taskBank);
    // The event's own copy (same option ids): what is answered and stored there.
    const { comp, player, p, ids: [taskId] } = await liveEventWith([taskBank], "pk-submit");
    try {
      const view = await (await p.api.get(`/api/tasks/${taskId}`)).json();
      expect(view.pick_one, "the participant is told it is a pick-one question").toBe(true);
      expect(view.choices.map(c => c.text), "in the author's order").toEqual(["Red", "Green"]);
      expect(view.my_choice_ids, "PRECONDITION: no pick before an answer").toBeUndefined();

      for (const bad of [JSON.stringify(["deadbeef"]), JSON.stringify([red.id, green.id]), "Red"]) {
        const r = await submit(p, comp.id, taskId, bad);
        expect(r.status(), `refused: ${bad}`).toBe(400);
      }
      expect(dbAll("SELECT 1 FROM submissions WHERE task_id=? AND user_id=?", taskId, player.id), "a refusal writes no row").toEqual([]);

      const ok = await submit(p, comp.id, taskId, JSON.stringify([green.id]));
      expect(ok.status(), await ok.text()).toBe(200);
      expect((await ok.json()).correct).toBe(true);
      expect(dbGet("SELECT is_correct, points_delta, answer, answer_canonical FROM submissions WHERE task_id=? AND user_id=?", taskId, player.id))
        .toEqual({ is_correct: 1, points_delta: 50, answer: "Green", answer_canonical: JSON.stringify([green.id]) });
      const solved = await (await p.api.get(`/api/tasks/${taskId}`)).json();
      expect(solved.my_choice_ids, "the solved view names their own pick").toEqual([green.id]);
    } finally { await p.api.dispose(); }
  });
});

test.describe("Recalculate and a pick-one question", () => {
  test("adding options to a free response, or removing or rewording the option someone picked, turns no earlier answer wrong; a text CONTROL is re-graded by the same run", async () => {
    // A free response that will GAIN options, a pick-one question that will LOSE
    // the picked option, and a text challenge whose key will change.
    const free = await SA.api.post("/api/admin/tasks", { headers: H(SA.csrf), data: {
      title: `Recalc free ${uniq("f")}`, description: "d", difficulty: "easy", answer_type: "any", status: "published" } });
    expect(free.status(), await free.text()).toBe(200);
    const freeBank = (await free.json()).id;
    const po = await createPickOne(["Yes", "No", "Maybe"]);
    expect(po.status(), await po.text()).toBe(200);
    const poBank = (await po.json()).id;
    const [yes, no, maybe] = choicesOf(poBank);
    const txtBank = await makeTask(SA.api, SA.csrf, "recalc-text", { correct_answer: "alpha" });

    // The event's own copies: what is answered, edited and recalculated there.
    const { comp, player, p, ids: [freeId, poId, txtId] } = await liveEventWith([freeBank, poBank, txtBank.id], "pk-recalc");
    const txt = { ...txtBank, id: txtId };
    try {
      for (const [id, ans] of [[freeId, "whatever I typed"], [poId, JSON.stringify([maybe.id])], [txt.id, "alpha"]]) {
        const r = await submit(p, comp.id, id, ans);
        expect(r.status(), `submit ${id}: ${await r.text()}`).toBe(200);
        expect((await r.json()).correct, "PRECONDITION: each answer was right when given").toBe(true);
      }
    } finally { await p.api.dispose(); }
    const row = (taskId) => dbGet("SELECT is_correct, points_delta FROM submissions WHERE task_id=? AND user_id=?", taskId, player.id);

    // The edits: options for the free response; the picked option removed and
    // another reworded; the text key changed.
    expect((await putTask(freeId, { choices: [{ text: "Up" }, { text: "Down" }] })).status()).toBe(200);
    expect((await putTask(poId, { choices: [{ id: yes.id, text: "Yes" }, { id: no.id, text: "No, thanks" }] })).status()).toBe(200);
    expect((await putTask(txt.id, { correct_answer: "beta" })).status()).toBe(200);
    expect(dbGet("SELECT ended_at e FROM competitions WHERE id=?", comp.id).e, "PRECONDITION: the event is still live, so nothing is frozen").toBeNull();

    const rf = await recalculate(freeId);
    expect([rf.total_submissions, rf.flipped, rf.frozen_skipped || 0], "re-graded, and the free response's answer stays right").toEqual([1, 0, 0]);
    expect(row(freeId)).toEqual({ is_correct: 1, points_delta: 50 });
    const rp = await recalculate(poId);
    expect([rp.total_submissions, rp.flipped, rp.frozen_skipped || 0], "re-graded, and the answer on a removed option stays right").toEqual([1, 0, 0]);
    expect(row(poId)).toEqual({ is_correct: 1, points_delta: 50 });
    // CONTROL: the same run does re-grade, and moves a text answer the new key
    // no longer accepts.
    const rt = await recalculate(txt.id);
    expect(rt.flipped, "a text answer the new key refuses is re-graded").toBe(1);
    expect(row(txt.id)).toEqual({ is_correct: 0, points_delta: -5 });
  });
});

test.describe("Pick-one questions — import and restore", () => {
  test("import keeps a valid row's option ids verbatim and skips one with a single option or a malformed id", async () => {
    const opts = [{ id: "a1b2c3d4", text: "North" }, { id: "0f0f0f0f", text: "South" }];
    const titles = { ok: `Imp ok ${uniq("i")}`, one: `Imp one ${uniq("i")}`, badId: `Imp bad ${uniq("i")}` };
    const row = (title, choices) => ({ title, description: "<p>d</p>", difficulty: "easy", answer_type: "any", correct_answer: "", choices: JSON.stringify(choices), status: "published", active: 1 });
    const r = await SA.api.post("/api/admin/import/tasks", { headers: H(SA.csrf), data: { resolutions: {}, data: { type: "hackarena-tasks", tasks: [
      row(titles.ok, opts),
      row(titles.one, [opts[0]]),
      row(titles.badId, [{ id: "NOT-HEX!", text: "East" }, { id: "12345678", text: "West" }]),
    ] } } });
    expect(r.status(), await r.text()).toBe(200);
    const b = await r.json();
    expect([b.imported, b.skipped], "one imported, two skipped").toEqual([1, 2]);
    const got = dbGet("SELECT id, choices, answer_type, correct_answer FROM tasks WHERE title=?", titles.ok);
    expect(JSON.parse(got.choices), "the ids travel verbatim").toEqual(opts);
    expect([got.answer_type, got.correct_answer]).toEqual(["any", ""]);
    expect(dbGet("SELECT 1 x FROM tasks WHERE title=?", titles.one), "a single option is no pick-one question").toBeUndefined();
    expect(dbGet("SELECT 1 x FROM tasks WHERE title=?", titles.badId), "a malformed id is skipped, not repaired").toBeUndefined();
  });

  test("restore brings a version's options back, ids included", async () => {
    const cr = await createPickOne(["One", "Two"]);
    expect(cr.status(), await cr.text()).toBe(200);
    const id = (await cr.json()).id;
    const before = choicesOf(id);
    expect((await putTask(id, { choices: [...before, { text: "Three" }] })).status()).toBe(200);
    expect(choicesOf(id).length, "PRECONDITION: the edit added an option").toBe(3);
    const vs = await (await SA.api.get(`/api/admin/tasks/${id}/versions`)).json();   // a bare array
    expect(Array.isArray(vs) && vs.length >= 2, `PRECONDITION: the history holds the create and the edit: ${JSON.stringify(vs).slice(0, 200)}`).toBe(true);
    const snap = (v) => (typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : v.snapshot) || {};
    const v1 = vs.find(v => { try { return JSON.parse(snap(v).choices || "[]").length === 2; } catch (_) { return false; } });
    expect(v1, "the two-option version is in the history").toBeTruthy();
    const rr = await SA.api.post(`/api/admin/tasks/${id}/restore`, { headers: H(SA.csrf), data: { versionId: v1.id } });
    expect(rr.status(), await rr.text()).toBe(200);
    expect(choicesOf(id), "the version's options, ids and all").toEqual(before);
  });
});

test.describe("The qualifying tag on an organiser's own question", () => {
  test("a malformed key is refused; adding or removing the tag on a challenge in an event with an ended session is refused, and allowed on one in a live event", async () => {
    const cr = await createPickOne(["Low", "High"]);
    expect(cr.status(), await cr.text()).toBe(200);
    const live = (await cr.json()).id;
    const tag = (taskId, t) => SA.api.post(`/api/admin/tasks/${taskId}/tags`, { headers: H(SA.csrf), data: { tag: t } });
    const untag = (taskId, t) => SA.api.delete(`/api/admin/tasks/${taskId}/tags/${encodeURIComponent(t)}`, { headers: H(SA.csrf) });

    const bad = await tag(live, "qualifying:Not A Key!");
    expect(bad.status(), await bad.text()).toBe(400);
    expect((await bad.json()).code).toBe("qualifying_tag_invalid");

    // A challenge in an event that has ENDED: both directions are refused.
    const ended = await createPickOne(["Few", "Many"]);
    const endedBank = (await ended.json()).id;
    const comp = await makeCompetition(SA.api, SA.csrf, "pk-frozen");
    // The event's own copy: the challenge an ended session freezes (lib/event-copies.js).
    const endedId = (await assignTask(SA.api, SA.csrf, endedBank, [comp.id])).copies[0].task_id;
    const pre = await tag(endedId, "qualifying:budget");
    expect(pre.status(), `PRECONDITION: tagged while live: ${await pre.text()}`).toBe(200);
    const end = await SA.api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(SA.csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const off = await untag(endedId, "qualifying:budget");
    expect(off.status(), await off.text()).toBe(409);
    expect((await off.json()).code).toBe("qualifying_tag_frozen");
    const again = await tag(endedId, "qualifying:other");
    expect(again.status(), await again.text()).toBe(409);
    expect((await again.json()).code).toBe("qualifying_tag_frozen");
    expect(dbAll("SELECT tag FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%'", endedId).map(r => r.tag), "nothing moved").toEqual(["qualifying:budget"]);

    // CONTROL: the same two acts on a challenge in no ended event succeed.
    const okTag = await tag(live, "qualifying:budget");
    expect(okTag.status(), await okTag.text()).toBe(200);
    const okUntag = await untag(live, "qualifying:budget");
    expect(okUntag.status(), await okUntag.text()).toBe(200);
  });

  test("restoring a version from before the qualifying tag is refused once an event holding it has ended a session; elsewhere it renumbers the challenge (CONTROL)", async () => {
    const tag = (taskId, t) => SA.api.post(`/api/admin/tasks/${taskId}/tags`, { headers: H(SA.csrf), data: { tag: t } });
    const restore = (taskId, versionId) => SA.api.post(`/api/admin/tasks/${taskId}/restore`, { headers: H(SA.csrf), data: { versionId } });
    const untaggedVersion = async (taskId) => {
      const vs = await (await SA.api.get(`/api/admin/tasks/${taskId}/versions`)).json();   // a bare array
      const tagsOf = (v) => { const sn = (typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : v.snapshot) || {}; return Array.isArray(sn.tags) ? sn.tags : null; };
      const v = vs.find(x => { const t = tagsOf(x); return t && !t.some(y => String(y).startsWith("qualifying:")); });
      expect(v, "PRECONDITION: a version from before the tag").toBeTruthy();
      return v.id;
    };
    const qualifyingTags = (taskId) => dbAll("SELECT tag FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%'", taskId).map(r => r.tag);

    const frozenBank = (await (await createPickOne(["Few", "Many"])).json()).id;
    const ended = await makeCompetition(SA.api, SA.csrf, "pk-restore-ended");
    const frozen = (await assignTask(SA.api, SA.csrf, frozenBank, [ended.id])).copies[0].task_id;   // the event's own copy
    expect((await tag(frozen, "qualifying:budget")).status(), "PRECONDITION: tagged while live").toBe(200);
    const vFrozen = await untaggedVersion(frozen);
    expect((await SA.api.post(`/api/admin/competitions/${ended.id}/end-now`, { headers: H(SA.csrf) })).ok()).toBeTruthy();
    const refused = await restore(frozen, vFrozen);
    expect(refused.status(), await refused.text()).toBe(409);
    expect((await refused.json()).code).toBe("qualifying_tag_frozen");
    expect(qualifyingTags(frozen), "nothing moved").toEqual(["qualifying:budget"]);

    // CONTROL: in a live event the same restore drops the tag and clears the
    // challenge's number, so the event renumbers it in the scoring level.
    const openBank = (await (await createPickOne(["Low", "High"])).json()).id;
    const live = await makeCompetition(SA.api, SA.csrf, "pk-restore-live");
    const open = (await assignTask(SA.api, SA.csrf, openBank, [live.id])).copies[0].task_id;   // the event's own copy
    expect((await tag(open, "qualifying:budget")).status()).toBe(200);
    const vOpen = await untaggedVersion(open);
    { const db = new Database(TEST_DB_PATH); try { db.prepare("UPDATE competition_tasks SET task_number='4.01' WHERE task_id=?").run(open); } finally { db.close(); } }
    const ok = await restore(open, vOpen);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(qualifyingTags(open), "the version's tags").toEqual([]);
    expect(dbGet("SELECT task_number FROM competition_tasks WHERE task_id=?", open).task_number, "the qualifying-level number is cleared").toBeNull();
  });

  // Scoring reads `tag LIKE 'qualifying:%'`, so a malformed key an import stored
  // (no well-formed key parses from it) still makes the challenge a quick
  // question. A restore that drops it is the same scoring change, refused once
  // an event holding the challenge has ended, though no well-formed key moves.
  test("restoring a version without a MALFORMED qualifying tag an import stored is refused once an event holding it has ended (CONTROL: without the tag it restores)", async () => {
    const restore = (taskId, versionId) => SA.api.post(`/api/admin/tasks/${taskId}/restore`, { headers: H(SA.csrf), data: { versionId } });
    const firstVersion = async (taskId) => {
      const vs = await (await SA.api.get(`/api/admin/tasks/${taskId}/versions`)).json();   // a bare array
      expect(vs.length, "PRECONDITION: the challenge has a version to restore").toBeGreaterThan(0);
      return vs[vs.length - 1].id;
    };
    const ended = await makeCompetition(SA.api, SA.csrf, "pk-restore-malformed");
    const badBank = (await (await createPickOne(["One", "Two"])).json()).id;
    const plainBank = (await (await createPickOne(["Uno", "Dos"])).json()).id;
    // The event's own copies: what the ended event holds, and what is restored.
    const bad = (await assignTask(SA.api, SA.csrf, badBank, [ended.id])).copies[0].task_id;
    const plain = (await assignTask(SA.api, SA.csrf, plainBank, [ended.id])).copies[0].task_id;
    const vBad = await firstVersion(bad);
    const vPlain = await firstVersion(plain);
    const MALFORMED = "qualifying:Not A Key!";
    { const db = new Database(TEST_DB_PATH); try { db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)").run(bad, MALFORMED); } finally { db.close(); } }
    const { qualifyingKeysFromTags } = require("../lib/qualifying");
    expect(qualifyingKeysFromTags([MALFORMED]), "PRECONDITION: no well-formed key parses from the tag").toEqual([]);
    expect(dbGet("SELECT 1 AS q FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%'", bad), "PRECONDITION: scoring reads it as qualifying").toBeTruthy();
    expect((await SA.api.post(`/api/admin/competitions/${ended.id}/end-now`, { headers: H(SA.csrf) })).ok()).toBeTruthy();

    const refused = await restore(bad, vBad);
    expect(refused.status(), await refused.text()).toBe(409);
    expect((await refused.json()).code).toBe("qualifying_tag_frozen");
    expect(dbAll("SELECT tag FROM task_tags WHERE task_id=?", bad).map(r => r.tag), "nothing moved").toContain(MALFORMED);

    const ok = await restore(plain, vPlain);
    expect(ok.status(), `CONTROL: the same restore without the tag: ${await ok.text()}`).toBe(200);
  });
});

test.describe("The editor's Options box", () => {
  test("authors a pick-one question, one option per line, and keeps an untouched option's id across an edit", async ({ page }) => {
    const { adminLogin, clickTab } = require("./ui-admin-helpers");
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await page.evaluate(() => window.openTaskForm());
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#tf-atype").selectOption("any");
    await expect(page.locator("#tf-any-options"), "the box is offered for an Any answer challenge").toBeVisible();
    const title = `Box ${uniq("b")}`;
    await page.locator("#tf-title").fill(title);
    await page.locator("#tf-any-options").fill("Red\n\n  Green  \n");
    const saved = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/admin/tasks"), { timeout: 15000 });
    await page.locator("#save-publish-btn").click();
    const res = await saved;
    expect(res.status(), await res.text()).toBe(200);
    const id = (await res.json()).id;
    const first = choicesOf(id);
    expect(first.map(c => c.text), "one option per non-empty line, trimmed").toEqual(["Red", "Green"]);

    // Edit: the box shows the options; a new line is added, the others kept.
    await page.evaluate((tid) => window.editTask(tid), id);
    await expect(page.locator("#tf-any-options")).toHaveValue("Red\nGreen", { timeout: 10000 });
    await page.locator("#tf-any-options").fill("Red\nGreen\nBlue");
    const put = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith(`/api/admin/tasks/${id}`), { timeout: 15000 });
    await page.locator("#save-task-btn").click();
    const pr = await put;
    expect(pr.status(), await pr.text()).toBe(200);
    const second = choicesOf(id);
    expect(second.map(c => c.text)).toEqual(["Red", "Green", "Blue"]);
    expect(second.slice(0, 2).map(c => c.id), "the untouched options keep their ids").toEqual(first.map(c => c.id));
    expect(first.map(c => c.id), "the new one has its own").not.toContain(second[2].id);
  });
});

// OPERATOR RULING 84 (14 Nov 2026): an edited option keeps its identity, and once
// anyone has answered a qualifying question its options keep their places.
test.describe("The editor's Options box keeps each option's identity", () => {
  test("a line reworded in place keeps its option's id; once a qualifying question is answered the box says so, and a move is refused before anything is sent", async ({ page }) => {
    test.setTimeout(90_000);
    const { adminLogin, clickTab } = require("./ui-admin-helpers");
    // The browser's superadmin session ends the file's API one (one session per
    // principal), so every admin call here goes through the browser's.
    await adminLogin(page);
    const api = page.request;
    const csrf = async () => (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const cr = await api.post("/api/admin/tasks", { headers: H(await csrf()), data: {
      title: `PickOne ${uniq("p")}`, description: "d", difficulty: "easy", answer_type: "any", status: "published",
      choices: ["Red", "Green", "Blue"].map(text => ({ text })) } });
    expect(cr.status(), await cr.text()).toBe(200);
    const id = (await cr.json()).id;
    const first = choicesOf(id);
    const puts = [];
    page.on("request", rq => { if (rq.method() === "PUT" && rq.url().endsWith(`/api/admin/tasks/${id}`)) puts.push(rq.postDataJSON()); });
    await clickTab(page, "Challenges");
    const edit = async () => {
      await page.evaluate(() => window.loadAdminTasks());
      await expect.poll(() => page.evaluate((tid) => (window.S.adminTasksData || []).some(t => t.id === tid), id), { timeout: 15000 }).toBe(true);
      await page.evaluate((tid) => window.editTask(tid), id);
      await expect(page.locator("#tf-any-options")).toBeVisible({ timeout: 10000 });
    };
    const putDone = () => page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith(`/api/admin/tasks/${id}`), { timeout: 15000 });

    // Unanswered: "Green" reworded where it stands keeps Green's id.
    await edit();
    await expect(page.locator("#tf-any-options-note"), "nothing answered yet: no note").toBeHidden();
    await page.locator("#tf-any-options").fill("Red\nEmerald\nBlue");
    let put = putDone();
    await page.locator("#save-task-btn").click();
    let r = await put;
    expect(r.status(), await r.text()).toBe(200);
    expect(choicesOf(id), "a reword in place is the same option").toEqual([{ id: first[0].id, text: "Red" }, { id: first[1].id, text: "Emerald" }, { id: first[2].id, text: "Blue" }]);

    // Make it a qualifying question somebody has answered, in a live event.
    const tag = await api.post(`/api/admin/tasks/${id}/tags`, { headers: H(await csrf()), data: { tag: `qualifying:${uniq("k").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30)}` } });
    expect(tag.status(), await tag.text()).toBe(200);
    const comp = await makeCompetition(api, await csrf(), "pk-fixed");
    const idle = await makeTask(api, await csrf(), "pk-fixed-idle");
    for (const t of [id, idle.id]) await assignTask(api, await csrf(), t, [comp.id]);
    const player = await makeParticipant(api, await csrf(), "pk-fixed-player");
    const bystander = await makeParticipant(api, await csrf(), "pk-fixed-bystander");
    await enrol(api, await csrf(), comp.id, [player.id, bystander.id]);
    const p = await apiLogin(player.email);
    try {
      const sel = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      const ans = await submit(p, comp.id, id, JSON.stringify([first[0].id]));
      expect(ans.status(), await ans.text()).toBe(200);
    } finally { await p.api.dispose(); }

    // The box says so, and a move or a removal is refused here, nothing sent.
    await edit();
    await expect(page.locator("#tf-any-options-note")).toBeVisible();
    await expect(page.locator("#tf-any-options-note")).toContainText("you can reword an option or add one at the end, but not move or remove one");
    const sent = puts.length;
    await page.locator("#tf-any-options").fill("Emerald\nRed\nBlue");
    await page.locator("#save-task-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "options keep their places" }).first()).toBeVisible();
    expect(puts.length, "refused before anything is sent").toBe(sent);
    await page.locator("#tf-any-options").fill("Red\nBlue");
    await page.locator("#save-task-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "options keep their places" }).first()).toBeVisible();
    expect(puts.length, "a removal too").toBe(sent);
    expect(choicesOf(id).map(c => c.text), "nothing moved").toEqual(["Red", "Emerald", "Blue"]);

    // CONTROL: a reword in place and an option added at the end save (past the
    // live-event confirm: the challenge is in a live event now).
    await page.locator("#tf-any-options").fill("Crimson\nEmerald\nBlue\nViolet");
    put = putDone();
    await page.locator("#save-task-btn").click();
    // The live-event confirm opens with its primary focused (showModal), and it
    // is confirmed with Enter, as a keyboard user does. A mouse press starts
    // with a move, which Chromium hands the page on its next frame: on CI (main
    // after 9.2.12) this press was never acknowledged ("performing click
    // action") until the PUT's 15 s ran out and the save never happened, though
    // nothing in the page runs long there. A key press waits for no frame.
    const confirm = page.locator("#modal-overlay.open #modal-confirm-btn");
    await expect(confirm, "the live-event confirm holds focus").toBeFocused();
    await confirm.press("Enter");
    r = await put;
    expect(r.status(), await r.text()).toBe(200);
    const after = choicesOf(id);
    expect(after.slice(0, 3)).toEqual([{ id: first[0].id, text: "Crimson" }, { id: first[1].id, text: "Emerald" }, { id: first[2].id, text: "Blue" }]);
    expect(after[3].text).toBe("Violet");
  });

  // A line keeps the identity of the option that stood on it only when that
  // accounts for every stored option. Removing one and rewording the next in one
  // save would otherwise hand the reworded line the REMOVED option's identity,
  // and with it that option's answers (a participant's own view would mark an
  // option they never picked).
  test("removing an option and rewording the next in one save gives the reworded line a new identity, never the removed one's; moving them with a reword in place keeps every identity", async ({ page }) => {
    test.setTimeout(60_000);
    const { adminLogin, clickTab } = require("./ui-admin-helpers");
    await adminLogin(page);
    const api = page.request;
    const csrf = async () => (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const create = async () => {
      const r = await api.post("/api/admin/tasks", { headers: H(await csrf()), data: {
        title: `PickOne ${uniq("p")}`, description: "d", difficulty: "easy", answer_type: "any", status: "published",
        choices: ["Alpha", "Bravo", "Charlie"].map(text => ({ text })) } });
      expect(r.status(), await r.text()).toBe(200);
      return (await r.json()).id;
    };
    const removed = await create(), moved = await create();
    await clickTab(page, "Challenges");
    const saveWith = async (id, lines) => {
      await page.evaluate(() => window.loadAdminTasks());
      await expect.poll(() => page.evaluate((tid) => (window.S.adminTasksData || []).some(t => t.id === tid), id), { timeout: 15000 }).toBe(true);
      await page.evaluate((tid) => window.editTask(tid), id);
      await expect(page.locator("#tf-any-options")).toBeVisible({ timeout: 10000 });
      await page.locator("#tf-any-options").fill(lines);
      const put = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith(`/api/admin/tasks/${id}`), { timeout: 15000 });
      await page.locator("#save-task-btn").click();
      const r = await put;
      expect(r.status(), await r.text()).toBe(200);
    };

    // Alpha removed and Bravo reworded: which line rewords which is a guess, so
    // the reworded line is a new option, with neither Alpha's identity nor Bravo's.
    const [alpha, bravo, charlie] = choicesOf(removed);
    await saveWith(removed, "Bravo two\nCharlie");
    const after = choicesOf(removed);
    expect(after.map(c => c.text)).toEqual(["Bravo two", "Charlie"]);
    expect(after[0].id, "not the removed option's identity").not.toBe(alpha.id);
    expect(after[0].id, "nor Bravo's, which may have been the one removed").not.toBe(bravo.id);
    expect(after[0].id).toMatch(HEX8);
    expect(after[1], "Charlie keeps its own").toEqual(charlie);

    // CONTROL: moved, with one reworded where it stood and nothing removed —
    // every option keeps its identity.
    const [a2, b2, c2] = choicesOf(moved);
    await saveWith(moved, "Charlie\nBravo two\nAlpha");
    expect(choicesOf(moved)).toEqual([{ id: c2.id, text: "Charlie" }, { id: b2.id, text: "Bravo two" }, { id: a2.id, text: "Alpha" }]);
  });
});
