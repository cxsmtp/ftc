// v8.14.5 — shared set-up for the multiple-choice lock specs
// (choice-key-leaks.api, choice-grading-locks.api, choice-order-locks,
// choice-editor-locks, choice-tap-locks).
//
// Each lock in those specs was written against a mutation that once SURVIVED the
// whole suite: the mutation is named in the test's comment, and the test was seen
// failing with it applied. Keep that pairing when editing one.
//
// This module must NOT require ./isolated-test (it registers the per-file recycle
// at import time), and it opens the server's database LAZILY, per call (v7.20.2):
// a module-scope handle reads the previous file's unlinked inode.
const { expect } = require("@playwright/test");
const { freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

/** Read-only SQL against the SERVER's database. */
function dbAll(sql, ...args) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const dbGet = (sql, ...args) => dbAll(sql, ...args)[0];

/** A direct write the API cannot express (legacy rows, hand-edited keys); asserts it landed. */
function dbRun(sql, ...args) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare(sql).run(...args);
    expect(r.changes, `the direct write must land: ${sql}`).toBeGreaterThan(0);
    return r;
  } finally { db.close(); }
}

const storedTask = (id) => dbGet("SELECT title, answer_type, choices, correct_answer, answer_sealed, updated_at FROM tasks WHERE id=?", id);

/** A signed-in API session for an existing account. */
async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${li.status()} ${await li.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A fresh account promoted to `role`, signed in. */
async function makeTier(sa, saCsrf, label, role) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { ...p, ...(await signIn(p.email)) };
}

/** A participant session with the event selected. */
async function asPlayer(email, compId) {
  const s = await signIn(email);
  const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  return s;
}

/** Create a published challenge; returns its id. */
async function mkTask(api, csrf, data) {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: uniq("MCL"), description: "<p>Q</p>", difficulty: "easy", status: "published", ...data },
  });
  expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).id;
}
const mkChoice = (api, csrf, choices, extra = {}) => mkTask(api, csrf, { answer_type: "choice", choices, ...extra });

/**
 * A LIVE event holding `taskIds` plus one unsolved text FILLER, so a participant
 * who finishes the challenges under test cannot trip the all-solved auto-end
 * (fixture checklist item 1).
 */
async function liveEvent(sa, saCsrf, label, taskIds, extra = {}) {
  const ev = await makeCompetition(sa, saCsrf, label, extra);
  const fillerBank = await mkTask(sa, saCsrf, { answer_type: "text", correct_answer: `filler-${uniq("f")}` });
  const filler = (await assignTask(sa, saCsrf, fillerBank, [ev.id])).copies[0].task_id;
  // `ids`: the event's OWN copy of each named question, in order (lib/event-copies.js)
  // — what its participants answer and what an edit to "the challenge in the
  // event" is made to.
  const ids = [];
  for (const id of taskIds) ids.push((await assignTask(sa, saCsrf, id, [ev.id])).copies[0].task_id);
  return { ...ev, filler, ids };
}

/** One owned participant, enrolled in `compIds`. */
async function playerIn(sa, saCsrf, label, compIds) {
  const p = await makeParticipant(sa, saCsrf, label);
  for (const c of compIds) await enrol(sa, saCsrf, c, [p.id]);
  return p;
}

const readTask = async (api, taskId) => {
  const r = await api.get(`/api/tasks/${taskId}`);
  expect(r.ok(), `GET task: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
};

/** Submit `answer` (the raw multipart string) with a fresh grading token. */
async function answer(api, csrf, taskId, answerStr) {
  const t = await readTask(api, taskId);
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf }, multipart: { answer: answerStr, gradingHash: t.grading_hash },
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch (_) {}
  return { status: r.status(), body, text };
}

/** Submit the options named by their TEXT, in the order given. */
async function pick(api, csrf, taskId, texts) {
  const t = await readTask(api, taskId);
  const ids = texts.map((x) => {
    const c = t.choices.find((o) => o.text === x);
    expect(c, `option "${x}" must be offered`).toBeTruthy();
    return c.id;
  });
  return answer(api, csrf, taskId, JSON.stringify(ids));
}

/** The stored options and correct ids, keyed by option text. */
function storedIds(taskId) {
  const row = storedTask(taskId);
  const opts = JSON.parse(row.choices);
  const byText = Object.fromEntries(opts.map((o) => [o.text, o.id]));
  return { row, opts, byText, correct: JSON.parse(row.correct_answer) };
}

/** PUT a new set of ticks, keeping every option's id and text. */
async function setTicks(api, csrf, taskId, correctTexts, extra = {}) {
  const { opts } = storedIds(taskId);
  return api.put(`/api/admin/tasks/${taskId}`, {
    headers: H(csrf),
    data: { choices: opts.map((o) => ({ id: o.id, text: o.text, correct: correctTexts.includes(o.text) })), ...extra },
  });
}

module.exports = {
  H, uniq,
  makeParticipant, makeCompetition, assignTask, enrol, grantEventAdmin,
  dbAll, dbGet, dbRun, storedTask, storedIds,
  signIn, makeTier, asPlayer, mkTask, mkChoice, liveEvent, playerIn, readTask, answer, pick, setTicks,
};
