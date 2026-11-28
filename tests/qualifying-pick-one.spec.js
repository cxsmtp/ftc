// @ts-check
//
// A QUALIFYING QUESTION IS A PICK-ONE QUESTION (lib/qualifying.js
// `qualifyingNeedsPickOneDenied`).
//
// The event team's reports, lead file and hot-lead rule read an answer as the
// PLACE of the one option picked, so a text, free-answer or multiple-choice
// challenge tagged `qualifying:` used to be accepted and then ignored: its
// answers reached no report and everyone read as unanswered. Each door that can
// make one now refuses (the tag route, the task PUT, restore) or skips and counts
// (the task import), each with a control that the pick-one case still passes.
// An older qualifying challenge of another type can still be edited without
// touching its type or options, and its hint costs nothing, as the question
// scores nothing (the card already quoted 0; Recalculate already charged 0).
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, TEST_DB_PATH, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

let sa;   // { api, csrf }: the built-in superadmin, for the whole file
test.beforeAll(async () => { sa = await apiLogin("superadmin"); });
test.afterAll(async () => { await sa?.api.dispose(); });

function sql(fn, write = false) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, write ? {} : { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const tagsOf = (id) => sql(db => db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(id).map(r => r.tag));
const rowOf = (id) => sql(db => db.prepare("SELECT answer_type, choices FROM tasks WHERE id=?").get(id));
/** An older qualifying challenge of another type: the tag written as a release before this rule left it. */
const tagDirectly = (id, tag) => sql(db => db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(id, tag), true);

const pickOne = (label, texts = ["Few", "Many"]) => makeTask(sa.api, sa.csrf, label, { answer_type: "any", correct_answer: "", choices: texts.map(text => ({ text })) });
const tag = (id, t) => sa.api.post(`/api/admin/tasks/${id}/tags`, { headers: H(sa.csrf), data: { tag: t } });
const put = (id, body) => sa.api.put(`/api/admin/tasks/${id}`, { headers: H(sa.csrf), data: body });
const NEEDS = "Only a pick-one question (Any answer, with two or more options) can be a qualifying question";

test("the qualifying tag is refused on a challenge that is not a pick-one question, and taken by one", async () => {
  const text = await makeTask(sa.api, sa.csrf, "q-text");
  const choice = await makeTask(sa.api, sa.csrf, "q-choice", { answer_type: "choice", correct_answer: "", choices: [{ text: "Right", correct: true }, { text: "Wrong" }] });
  const free = await makeTask(sa.api, sa.csrf, "q-free", { answer_type: "any", correct_answer: "" });
  for (const [what, t] of [["a text challenge", text], ["a multiple-choice challenge", choice], ["a free answer with no options", free]]) {
    const r = await tag(t.id, "qualifying:budget");
    const body = await r.text();
    expect(r.status(), `${what}: ${body}`).toBe(400);
    expect(JSON.parse(body).code, what).toBe("qualifying_needs_pick_one");
    expect(JSON.parse(body).error, what).toContain(NEEDS);
    expect(tagsOf(t.id), `${what}: no tag written`).toEqual([]);
  }
  // CONTROL: a pick-one question takes the tag.
  const p = await pickOne("q-pick");
  const r = await tag(p.id, "qualifying:budget");
  expect(r.status(), await r.text()).toBe(200);
  expect(tagsOf(p.id)).toEqual(["qualifying:budget"]);
});

test("an edit that would leave a qualifying question of another type, or without its options, is refused; other edits are not", async () => {
  const p = await pickOne("q-edit");
  expect((await tag(p.id, "qualifying:timeline")).status()).toBe(200);
  const before = rowOf(p.id);
  for (const [what, body] of [
    ["made a text challenge", { answer_type: "text", correct_answer: "x" }],
    ["made multiple choice", { answer_type: "choice", choices: [{ text: "A", correct: true }, { text: "B" }] }],
    ["every option dropped", { choices: [] }],
  ]) {
    const r = await put(p.id, body);
    const t = await r.text();
    expect(r.status(), `${what}: ${t}`).toBe(400);
    expect(JSON.parse(t).code, what).toBe("qualifying_needs_pick_one");
    expect(rowOf(p.id), `${what}: unchanged`).toEqual(before);
  }
  // CONTROL: an edit that keeps it a pick-one question goes through.
  const opts = JSON.parse(before.choices);
  let r = await put(p.id, { choices: [...opts, { text: "Lots" }] });
  expect(r.status(), await r.text()).toBe(200);
  expect(JSON.parse(rowOf(p.id).choices).length).toBe(3);
  r = await put(p.id, { title: uniq("Renamed pick") });
  expect(r.status(), await r.text()).toBe(200);
  // CONTROL: the same type change on a challenge that is NOT qualifying goes through.
  const plain = await pickOne("q-plain");
  r = await put(plain.id, { answer_type: "text", correct_answer: "x" });
  expect(r.status(), await r.text()).toBe(200);

  // AN OLDER QUALIFYING CHALLENGE OF ANOTHER TYPE (tagged before the rule):
  // editing it without touching its type or options still works, and so does
  // making it a pick-one question; moving it to yet another type does not.
  const old = await makeTask(sa.api, sa.csrf, "q-legacy");
  tagDirectly(old.id, "qualifying:legacy");
  r = await put(old.id, { title: uniq("Legacy renamed") });
  expect(r.status(), `a title edit: ${await r.text()}`).toBe(200);
  r = await put(old.id, { answer_type: "json", correct_answer: "{}" });
  expect(r.status(), await r.text()).toBe(400);
  expect((await r.json()).code).toBe("qualifying_needs_pick_one");
  r = await put(old.id, { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] });
  expect(r.status(), `made a pick-one question: ${await r.text()}`).toBe(200);
  expect(rowOf(old.id).answer_type).toBe("any");
  // The editor sends a multiple-choice or Any-answer challenge's options on every
  // save: an older qualifying one of those kinds, saved with its options as they
  // are, is not asked either.
  const freeOld = await makeTask(sa.api, sa.csrf, "q-legacy-free", { answer_type: "any", correct_answer: "" });
  tagDirectly(freeOld.id, "qualifying:legacy_free");
  r = await put(freeOld.id, { title: uniq("Legacy free renamed"), answer_type: "any", choices: [] });
  expect(r.status(), `an older free-answer one, saved as the editor saves it: ${await r.text()}`).toBe(200);
  const choiceOld = await makeTask(sa.api, sa.csrf, "q-legacy-choice", { answer_type: "choice", correct_answer: "", choices: [{ text: "Right", correct: true }, { text: "Wrong" }] });
  tagDirectly(choiceOld.id, "qualifying:legacy_choice");
  const stored = JSON.parse(rowOf(choiceOld.id).choices);
  const key = JSON.parse(sql(db => db.prepare("SELECT correct_answer FROM tasks WHERE id=?").get(choiceOld.id).correct_answer));
  r = await put(choiceOld.id, { title: uniq("Legacy choice renamed"), answer_type: "choice", choices: stored.map(c => ({ id: c.id, text: c.text, correct: key.includes(c.id) })) });
  expect(r.status(), `an older multiple-choice one, saved as the editor saves it: ${await r.text()}`).toBe(200);
  // …while changing its options is asked, and refused.
  r = await put(choiceOld.id, { answer_type: "choice", choices: [...stored.map(c => ({ id: c.id, text: c.text, correct: key.includes(c.id) })), { text: "Another" }] });
  expect(r.status(), await r.text()).toBe(400);
  expect((await r.json()).code).toBe("qualifying_needs_pick_one");
});

test("restore will not bring back a version that is a qualifying question of another type", async () => {
  // An older qualifying text challenge (tagged before the rule), edited once so
  // its history holds a version that is both qualifying and text…
  const t = await makeTask(sa.api, sa.csrf, "q-restore");
  tagDirectly(t.id, "qualifying:size");
  let r = await put(t.id, { title: uniq("Restore legacy") });
  expect(r.status(), await r.text()).toBe(200);
  // …then made a pick-one question, which the rule allows.
  r = await put(t.id, { answer_type: "any", correct_answer: "", choices: [{ text: "Small" }, { text: "Large" }] });
  expect(r.status(), await r.text()).toBe(200);
  const vs = await (await sa.api.get(`/api/admin/tasks/${t.id}/versions`)).json();
  const snap = (v) => (typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : (v.snapshot || {}));
  const tagsIn = (v) => (Array.isArray(snap(v).tags) ? snap(v).tags : []);
  const textQ = vs.find(v => snap(v).answer_type === "text" && tagsIn(v).includes("qualifying:size"));
  const textPlain = vs.find(v => snap(v).answer_type === "text" && Array.isArray(snap(v).tags) && !tagsIn(v).length);
  expect(textQ && textPlain, `PRECONDITION: both text versions are in the history: ${JSON.stringify(vs.map(v => [v.change_type, snap(v).answer_type, snap(v).tags]))}`).toBeTruthy();
  r = await sa.api.post(`/api/admin/tasks/${t.id}/restore`, { headers: H(sa.csrf), data: { versionId: textQ.id } });
  expect(r.status(), await r.text()).toBe(409);
  expect((await r.json()).code).toBe("qualifying_needs_pick_one");
  expect(rowOf(t.id).answer_type, "unchanged").toBe("any");
  expect(tagsOf(t.id)).toEqual(["qualifying:size"]);
  // An older qualifying text challenge restored to an earlier wording of itself
  // (same type and options) changes neither, so it restores, as the PUT allows.
  const same = await makeTask(sa.api, sa.csrf, "q-restore-same");
  tagDirectly(same.id, "qualifying:same");
  const firstTitle = uniq("Same first");
  expect((await put(same.id, { title: firstTitle })).status()).toBe(200);
  expect((await put(same.id, { title: uniq("Same second") })).status()).toBe(200);
  const svs = await (await sa.api.get(`/api/admin/tasks/${same.id}/versions`)).json();
  const firstV = svs.find(v => snap(v).title === firstTitle);
  expect(firstV, "PRECONDITION: the first wording is in the history").toBeTruthy();
  const rs = await sa.api.post(`/api/admin/tasks/${same.id}/restore`, { headers: H(sa.csrf), data: { versionId: firstV.id } });
  expect(rs.status(), await rs.text()).toBe(200);
  // CONTROL: the first version, which carries no qualifying tag, restores (and
  // so stops being a qualifying question, as its tags say).
  r = await sa.api.post(`/api/admin/tasks/${t.id}/restore`, { headers: H(sa.csrf), data: { versionId: textPlain.id } });
  expect(r.status(), await r.text()).toBe(200);
  expect([rowOf(t.id).answer_type, tagsOf(t.id)]).toEqual(["text", []]);
});

test("the challenge import skips and counts a qualifying row that is not a pick-one question, and says so", async () => {
  const bad = uniq("Imported qualifying text");
  const good = uniq("Imported qualifying pick");
  const file = { type: "hackarena-tasks", version: 1, tasks: [
    { title: bad, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", tags: ["qualifying:imported-a"] },
    { title: good, difficulty: "easy", answer_type: "any", correct_answer: "", status: "published",
      choices: [{ id: "a1b2c3d4", text: "One" }, { id: "e5f6a7b8", text: "Two" }], tags: ["qualifying:imported-b"] },
  ] };
  const r = await sa.api.post("/api/admin/import/tasks", { headers: H(sa.csrf), data: { data: file, resolutions: {} } });
  expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
  const out = await r.json();
  expect([out.imported, out.qualifying_not_pick_one_skipped], JSON.stringify(out)).toEqual([1, 1]);
  const titles = sql(db => db.prepare("SELECT title FROM tasks WHERE title IN (?,?)").all(bad, good).map(x => x.title));
  expect(titles, "only the pick-one row landed").toEqual([good]);
  // The import summary names the skip (public/js/features/export-import.js `_importDropNote`).
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "public/js/features/export-import.js"), "utf8");
  expect(src, "the summary renders the new counter").toContain("d.qualifying_not_pick_one_skipped");
});

test("a hint on a qualifying question costs nothing; a hint on any other challenge keeps its price", async () => {
  const comp = await makeCompetition(sa.api, sa.csrf, "q-hint");
  const old = await makeTask(sa.api, sa.csrf, "q-hint-legacy", { hint: "<p>Look left</p>" });
  tagDirectly(old.id, "qualifying:hinted");
  const plain = await makeTask(sa.api, sa.csrf, "q-hint-plain", { hint: "<p>Look right</p>" });
  old.id = (await assignTask(sa.api, sa.csrf, old.id, [comp.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
  plain.id = (await assignTask(sa.api, sa.csrf, plain.id, [comp.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
  const p = await makeParticipant(sa.api, sa.csrf, "q-hinter");
  await enrol(sa.api, sa.csrf, comp.id, [p.id]);
  const me = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    const sel = await me.api.post("/api/select-competition", { headers: H(me.csrf), data: { competitionId: comp.id } });
    expect(sel.ok(), `enter: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    for (const t of [old, plain]) {
      const r = await me.api.post(`/api/tasks/${t.id}/hint`, { headers: { ...H(me.csrf), "x-competition-id": comp.id } });
      expect(r.ok(), `hint on ${t.title}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
  } finally { await me.api.dispose(); }
  const cost = (taskId) => sql(db => db.prepare("SELECT points_deducted AS d FROM hint_reveals WHERE user_id=? AND task_id=?").get(p.id, taskId).d);
  expect(cost(old.id), "the qualifying question's hint is free").toBe(0);
  expect(cost(plain.id), "CONTROL: an ordinary easy challenge's hint costs 30% of 50").toBe(15);
});

test("on the card, an older qualifying question of another type warns of no penalty, announces none, and offers its hint free", async ({ page }) => {
  test.setTimeout(90_000);
  const comp = await makeCompetition(sa.api, sa.csrf, "q-card");
  const old = await makeTask(sa.api, sa.csrf, "q-card-legacy", { hint: "<p>Look up</p>" });
  tagDirectly(old.id, "qualifying:cardtopic");
  const other = await makeTask(sa.api, sa.csrf, "q-card-other");   // a second challenge (fixture checklist 1)
  old.id = (await assignTask(sa.api, sa.csrf, old.id, [comp.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
  other.id = (await assignTask(sa.api, sa.csrf, other.id, [comp.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
  const p = await makeParticipant(sa.api, sa.csrf, "q-card-p");
  await enrol(sa.api, sa.csrf, comp.id, [p.id]);
  // Signed in before the first navigation (CLAUDE.md, *STANDING RULES for adding tests*).
  const c0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, p.email, H(c0));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/select-competition", { headers: H(c1), data: { competitionId: comp.id } })).ok()).toBeTruthy();
  await page.goto("/");
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20_000 });
  const open = async (id) => {
    const card = page.locator(`#task-grid [data-task-id="${id}"]`);
    await card.waitFor({ state: "visible", timeout: 20_000 });
    await card.click();
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.locator("#ans-text")).toBeVisible({ timeout: 15_000 });
  };
  await open(old.id);
  await expect(page.locator(".hint-price"), "the hint is free").toHaveText("Free: a quick question scores nothing");
  // The card knows it is a quick question from its own read and the answer's,
  // not only from the challenge list (a card reached by a link has none).
  await page.evaluate(() => { window.S.allTasks = []; });
  await page.locator("#ans-text").fill("not the answer");
  await page.locator(`[data-action="task-submit-answer"][data-task-id="${old.id}"]`).click();
  const result = page.locator("#submit-result");
  await expect(result, "the answer is graded").toContainText("Incorrect.", { timeout: 15_000 });
  await expect(result, "and announces no penalty").not.toContainText("pts penalty");
  await expect(page.locator("#modal-overlay"), "no penalty warning was raised").toBeHidden();
  // CONTROL: an ordinary challenge on the same card still warns, and quotes its hint's price.
  await page.locator("#nav-challenges").click();
  await open(other.id);
  await expect(page.locator(".hint-price")).toHaveCount(0);   // it has no hint
  await page.locator("#ans-text").fill("not the answer");
  await page.locator(`[data-action="task-submit-answer"][data-task-id="${other.id}"]`).click();
  await expect(page.locator("#modal-overlay"), "the ordinary challenge warns").toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#modal-overlay")).toContainText("5 points");
  await page.locator("#modal-confirm-btn").click();
  await expect(result).toContainText("Incorrect. −5 pts penalty.", { timeout: 15_000 });
});
