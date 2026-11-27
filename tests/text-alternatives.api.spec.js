// Text grading — the CONTROL arms, pinned against the UNCHANGED predicate.
//
// Before this file the text rule was behaviourally UNPINNED: not one spec
// submitted a case or whitespace VARIANT of a stored answer. Every text submit
// in the suite sent the answer byte-for-byte as stored (or something plainly
// wrong), so the suite was green whether the server compared with
// `toLowerCase()`, without it, or stripped only ASCII spaces — the rule lived
// in one `else` branch of the submit handler and nothing could go red when it
// moved. It is about to move into `lib/scoring.js` and grow the answer-
// alternatives feature, so its existing shape is written down here FIRST,
// against the server exactly as it ships today:
//
//     answer.replace(/\s/g, "").toLowerCase()
//       === correct_answer.replace(/\s/g, "").toLowerCase()
//
// i.e. every whitespace character (space, tab, newline) is stripped from BOTH
// sides and the comparison is case-insensitive; anything that is not
// whitespace is significant. The `file` type reads the uploaded bytes into
// `answer` and falls through to the same predicate, which is why arm 5 is a
// file control: a newline is whitespace under the single-string rule.
//
// THESE ARMS MUST STAY GREEN WHEN THE PREDICATE MOVES. They are what says the
// extraction changed nothing for a single stored answer. And they are not
// decorative — each is killed by the realistic wrong implementation:
//   • drop `toLowerCase()`            → arm 1 ("open sesame") goes red;
//   • `/\s/g` narrowed to `/ /g`      → arm 3 (the embedded TAB) goes red;
//   • strip nothing at all            → arms 2 and 3 go red;
//   • strip non-whitespace too        → arm 4 ("open-sesame") goes red.
//
// Fixture rules (the standing checklist): every test OWNS its competition,
// challenge and participants; the fixture enrols TWO participants and only one
// of them ever submits, so the all-solved auto-end can never fire under a test;
// and there is ONE task per positive arm, because the server refuses any submit
// after a correct row exists for that (user, task). Arm 4 also reads the stored
// `submissions` row through better-sqlite3, opened INSIDE the test (a handle
// taken at module scope reads the previous file's unlinked inode, v7.20.2), so
// the wrong-answer arm cannot be satisfied by a response-only stub.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ta${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// The stored answer every text arm grades against. Mixed case and an internal
// space, so a variant can differ from it on EITHER axis independently.
const STORED = "Open Sesame";

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Text", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

/**
 * A live competition, one challenge per entry of `taskSpecs`, and `people`
 * participants enrolled. `taskSpecs[i]` supplies `answer_type` +
 * `correct_answer`; everything else is the attempt-caps fixture verbatim.
 */
async function makeFixture(api, csrf, { taskSpecs = [{ answer_type: "text", correct_answer: STORED }], people = 2, minutes = 600 } = {}) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
      duration_minutes: minutes, timezone: "UTC",
    },
  });
  expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const tasks = [];
  for (let i = 0; i < taskSpecs.length; i++) {
    const title = `${uniq()} T${i}`;
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title, description: "d", difficulty: "easy", status: "published", ...taskSpecs[i] },
    });
    expect(tr.ok(), `create task ${i}: ${await tr.text()}`).toBeTruthy();
    // Take the id the create RETURNS — resolving by title suffix matches a task
    // an EARLIER test in this file created (the attempt-caps lesson).
    const { id: tid } = await tr.json();
    expect(tid, "the create returns the new challenge's id").toBeTruthy();
    const asg = await api.post(`/api/admin/tasks/${tid}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign task ${i}: ${await asg.text()}`).toBeTruthy();
    // The event holds its OWN copy (lib/event-copies.js): the question its
    // participants answer and every edit below is made to. `bankId` is the library row.
    const t = { id: (await asg.json()).copies[0].task_id, bankId: tid, title };
    tasks.push(t);
  }

  const users = [];
  for (let i = 0; i < people; i++) users.push(await makeParticipant(api, csrf, uniq()));
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [comp.id] },
  });
  expect(asg.ok(), `assign users: ${await asg.text()}`).toBeTruthy();
  expect((await asg.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(users.length);
  return { comp, tasks, users };
}

/** Sign a participant in and put them into the competition. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/** One text submission through the real path, carrying the grading token. */
async function submit(api, csrf, taskId, answer) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** One FILE submission: the uploaded bytes are the answer. */
async function submitFile(api, csrf, taskId, content) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: {
      file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from(content) },
      gradingHash: view.grading_hash || "",
    },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

// better-sqlite3 is opened INSIDE the callback rather than at module scope:
// per-file isolation recreates the database file in a `beforeAll`, and a handle
// taken at require time would read the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

/** The stored submission row for one (user, task) — what the API never ships. */
function storedSubmission(userId, taskId) {
  return withDb((db) => db.prepare(
    "SELECT is_correct, points_delta, answer FROM submissions WHERE user_id=? AND task_id=? ORDER BY submitted_at DESC LIMIT 1"
  ).get(userId, taskId));
}

/** Build a one-task fixture, enter as the FIRST participant, submit `answer`. */
async function driveText(answer, taskSpec = { answer_type: "text", correct_answer: STORED }) {
  const { api: adm, csrf: ac } = await sa();
  const { comp, tasks, users } = await makeFixture(adm, ac, { taskSpecs: [taskSpec], people: 2 });
  const { api, csrf } = await enter(users[0].email, comp.id);
  const res = await submit(api, csrf, tasks[0].id, answer);
  expect(res.status, `submit ${JSON.stringify(answer)}: ${JSON.stringify(res.body)}`).toBe(200);
  await api.dispose(); await adm.dispose();
  return { res, userId: users[0].id, taskId: tasks[0].id };
}

test.describe("text grading rule — controls pinned against the unchanged predicate", () => {
  test("1. case folding: \"open sesame\" solves a challenge stored as \"Open Sesame\"", async () => {
    const { res, userId, taskId } = await driveText("open sesame");
    expect(res.body.correct, JSON.stringify(res.body)).toBe(true);
    expect(res.body.pointsDelta, "a correct answer earns the difficulty's points").toBeGreaterThan(0);
    expect(storedSubmission(userId, taskId)?.is_correct, "the stored row agrees with the response").toBe(1);
  });

  test("2. padding: \"  OpenSesame  \" solves it (leading/trailing whitespace is stripped)", async () => {
    const { res } = await driveText("  OpenSesame  ");
    expect(res.body.correct, JSON.stringify(res.body)).toBe(true);
    expect(res.body.pointsDelta).toBeGreaterThan(0);
  });

  test("3. internal whitespace: \"O p e n\\tSes ame\" solves it (spaces AND a tab are stripped)", async () => {
    // The tab is the discriminating character: an implementation that strips
    // only ASCII spaces (`/ /g`) still passes arm 2 and fails here.
    const { res } = await driveText("O p e n\tSes ame");
    expect(res.body.correct, JSON.stringify(res.body)).toBe(true);
    expect(res.body.pointsDelta).toBeGreaterThan(0);
  });

  test("4. only whitespace is stripped: \"open-sesame\" is WRONG and costs the penalty", async () => {
    const { res, userId, taskId } = await driveText("open-sesame");
    expect(res.body.correct, JSON.stringify(res.body)).toBe(false);
    expect(res.body.refused, "a wrong answer is graded, not refused").toBeFalsy();
    expect(res.body.pointsDelta, "the wrong-answer penalty").toBe(-5);
    // Read the row the response was built from, so a stub that answers
    // `correct:false` without writing anything cannot satisfy this arm.
    const row = storedSubmission(userId, taskId);
    expect(row, "a wrong answer still stores a submission row").toBeTruthy();
    expect(row.is_correct).toBe(0);
    expect(row.points_delta).toBe(-5);
  });

  test("5. FILE control: stored \"a\\nb\", uploaded \"ab\" is correct (a newline is whitespace under the single-string rule)", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, {
      taskSpecs: [{ answer_type: "file", correct_answer: "a\nb" }], people: 2,
    });
    const { api, csrf } = await enter(users[0].email, comp.id);
    const res = await submitFile(api, csrf, tasks[0].id, "ab");
    expect(res.status, `file submit: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.correct, JSON.stringify(res.body)).toBe(true);
    expect(res.body.pointsDelta).toBeGreaterThan(0);
    expect(storedSubmission(users[0].id, tasks[0].id)?.is_correct, "the stored row agrees").toBe(1);
    await api.dispose(); await adm.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.9.0 — ANSWER ALTERNATIVES. A `text` challenge's `correct_answer` is a
// NEWLINE-separated list of accepted answers; each line is graded under the
// single-answer rule pinned above (all whitespace stripped, case folded), and
// the stored form is CANONICAL — lines trimmed, blanks dropped, duplicates
// dropped by normalised key keeping the FIRST spelling — on create, edit,
// restore and import. `file` deliberately keeps the single-string rule: a
// file's expected content may legitimately span lines, so arm 12 is the
// negative twin of arm 5 above.
//
// Every arm below owns its competition, its challenge(s) and its participants
// (two enrolled, one acting — so the all-solved auto-end never fires under a
// test), with ONE task per positive grading arm: the server refuses any submit
// after a correct row exists for that (user, task) ("Already solved").
//
// The arms that read the row directly do so because the API never ships the
// stored key: an admin GET returns whatever the route projects, and "the PUT
// answered 200" says nothing about whether the column was rewritten. Arm 10 is
// the sharpest of these — its whole subject is that a PADDED legacy value
// (which only a direct write can create now) is left byte-for-byte alone.
const KEY3 = "alpha\nBeta\ngamma";

/** The stored `tasks` row — the key as the platform actually holds it. */
function storedTask(taskId) {
  return withDb((db) => db.prepare(
    "SELECT id, title, answer_type, correct_answer, updated_at FROM tasks WHERE id=?"
  ).get(taskId));
}

/** A published challenge with no competition; returns the id the create RETURNS. */
async function createTask(api, csrf, data) {
  const title = `${uniq()} ${data.answer_type || "text"}`;
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title, description: "d", difficulty: "easy", status: "published", ...data },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), body, title, id: body.id };
}

async function putTask(api, csrf, taskId, data) {
  const r = await api.put(`/api/admin/tasks/${taskId}`, { headers: H(csrf), data });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

test.describe("text grading — answer alternatives (v8.9.0)", () => {
  test("6. every alternative solves: key \"alpha\\nBeta\\ngamma\" accepts \"ALPHA\", \"beta\" and \"g a m m a\"", async () => {
    const spec = { answer_type: "text", correct_answer: KEY3 };
    const { api: adm, csrf: ac } = await sa();
    // Three tasks, one per alternative: a second correct submit on ONE task is
    // refused "Already solved", so one task cannot prove three alternatives.
    const { comp, tasks, users } = await makeFixture(adm, ac, { taskSpecs: [spec, spec, spec], people: 2 });
    const { api, csrf } = await enter(users[0].email, comp.id);
    // Each variant differs from its stored line on a DIFFERENT axis: case only,
    // exact, and internal whitespace — so the three cannot all be satisfied by a
    // grader that happens to accept the first line verbatim.
    const answers = ["ALPHA", "beta", "g a m m a"];
    for (let i = 0; i < answers.length; i++) {
      const res = await submit(api, csrf, tasks[i].id, answers[i]);
      expect(res.status, `submit ${JSON.stringify(answers[i])}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.correct, `${JSON.stringify(answers[i])} is an accepted alternative: ${JSON.stringify(res.body)}`).toBe(true);
      expect(res.body.pointsDelta, "a correct alternative earns the difficulty's points").toBeGreaterThan(0);
      expect(storedSubmission(users[0].id, tasks[i].id)?.is_correct, "the stored row agrees").toBe(1);
    }
    await api.dispose(); await adm.dispose();
  });

  test("7. a non-listed answer is WRONG: \"delta\" against \"alpha\\nBeta\\ngamma\" costs the penalty", async () => {
    const { res, userId, taskId } = await driveText("delta", { answer_type: "text", correct_answer: KEY3 });
    expect(res.body.correct, JSON.stringify(res.body)).toBe(false);
    expect(res.body.refused, "graded, not refused").toBeFalsy();
    expect(res.body.pointsDelta, "the wrong-answer penalty").toBe(-5);
    const row = storedSubmission(userId, taskId);
    expect(row, "a wrong answer still stores a submission row").toBeTruthy();
    expect(row.is_correct).toBe(0);
    expect(row.points_delta).toBe(-5);
  });

  test("8. the key is stored CANONICAL on create and on edit: trimmed, CRLF-split, blanks dropped, duplicates dropped keeping the FIRST spelling", async () => {
    // "  x " and "X" are one alternative under the fold; the FIRST spelling
    // ("x") survives. The CRLF and the blank lines are dropped; every line is
    // trimmed; the trailing newline adds no empty alternative.
    const RAW = "  x \r\n\r\nX\nfoo\n  y  \n";
    const CANON = "x\nfoo\ny";
    const { api: adm, csrf: ac } = await sa();

    const created = await createTask(adm, ac, { answer_type: "text", correct_answer: RAW });
    expect(created.status, `create: ${JSON.stringify(created.body)}`).toBe(200);
    expect(created.id, "the create returns the new challenge's id").toBeTruthy();
    expect(storedTask(created.id).correct_answer, "POST stores the canonical list").toBe(CANON);

    // The EDIT route: a second task stored under an unrelated key, then the same
    // raw value through PUT, carrying the optimistic-concurrency token the admin
    // form sends (the create stamps `updated_at`, so the token is a real value).
    const other = await createTask(adm, ac, { answer_type: "text", correct_answer: "placeholder" });
    expect(other.status, `create: ${JSON.stringify(other.body)}`).toBe(200);
    const before = storedTask(other.id);
    expect(before.updated_at, "the create stamps updated_at, so expectedUpdatedAt is a real token").toBeTruthy();
    const put = await putTask(adm, ac, other.id, { correct_answer: RAW, expectedUpdatedAt: before.updated_at });
    expect(put.status, `PUT: ${JSON.stringify(put.body)}`).toBe(200);
    expect(storedTask(other.id).correct_answer, "PUT stores the same canonical bytes as POST").toBe(CANON);
    await adm.dispose();
  });

  test("9. an all-blank list is refused at create (\" \\n\\n  \" holds no usable answer)", async () => {
    const { api: adm, csrf: ac } = await sa();
    // Truthy as a string, so the plain "Missing fields" presence check cannot
    // see it — only the canonical form (empty) can.
    const r = await createTask(adm, ac, { answer_type: "text", correct_answer: " \n\n  " });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(String(r.body.error || "")).toMatch(/Missing fields/);
    expect(r.id, "nothing is created").toBeFalsy();
    await adm.dispose();
  });

  test("10. re-saving a PADDED legacy key is not a scoring edit on a frozen challenge — canonical-vs-canonical, BEFORE the freeze test, column untouched", async () => {
    const { api: adm, csrf: ac } = await sa();
    // create → assign → end-now (the multiple-choice fixture's order — assignment
    // is refused once a session has ended, so the end must come LAST).
    const compR = await adm.post("/api/admin/competitions", {
      headers: H(ac),
      data: { name: `${uniq()} Freeze`, start_time: new Date(Date.now() - 30_000).toISOString(), duration_minutes: 60, timezone: "UTC" },
    });
    expect(compR.ok(), `comp: ${compR.status()} ${await compR.text()}`).toBeTruthy();
    const compId = (await compR.json()).competition.id;
    const created = await createTask(adm, ac, { answer_type: "text", correct_answer: "abc" });
    expect(created.status, `create: ${JSON.stringify(created.body)}`).toBe(200);
    const bankId = created.id;

    // Plant the legacy shape. The API stores this key canonical ("abc"), so a
    // PADDED stored value is reachable only by a direct write — exactly the
    // corpus every pre-v8.9.0 deployment carries (the admin form never trimmed).
    withDb((db) => {
      const r = db.prepare("UPDATE tasks SET correct_answer=' abc ' WHERE id=?").run(bankId);
      expect(r.changes, "the legacy value was planted").toBe(1);
    }, { readonly: false });
    expect(storedTask(bankId).correct_answer, "precondition: the stored key is padded").toBe(" abc ");

    const asg = await adm.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H(ac), data: { competitionIds: [compId] } });
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    // The event's own copy is the frozen challenge; it carries the padded key verbatim.
    const taskId = (await asg.json()).copies[0].task_id;
    expect(storedTask(taskId).correct_answer, "precondition: the event's copy holds the padded key too").toBe(" abc ");
    const end = await adm.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": ac } });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    // Positive control: the ended-session freeze IS armed on this task, so the
    // 200s below mean "correctly allowed" rather than "no ended session seen".
    const armed = await putTask(adm, ac, taskId, { difficulty: "hard" });
    expect(armed.status, `the freeze is armed: ${JSON.stringify(armed.body)}`).toBe(409);

    // (a) The reported flow: the admin form posts the stored value back
    // UNTRIMMED. Byte-identical to the row, so even a raw comparison passes —
    // this half pins that canonicalising the INCOMING value and comparing it
    // against the RAW stored one (the tempting shape) does not turn it into a
    // scoring edit.
    const t0 = storedTask(taskId);
    const put1 = await putTask(adm, ac, taskId, { title: `${t0.title} renamed`, correct_answer: " abc " });
    expect(put1.status, `title + the byte-identical padded key: ${JSON.stringify(put1.body)}`).toBe(200);
    let row = storedTask(taskId);
    expect(row.title, "the cosmetic edit landed").toBe(`${t0.title} renamed`);
    expect(row.correct_answer, "the padded legacy key is left byte-for-byte ALONE (padding intact)").toBe(" abc ");

    // (b) An EQUIVALENT spelling — what a retype, or a trimming client, sends.
    // Not byte-identical to the row, so only a canonical-vs-canonical comparison
    // run BEFORE the freeze test can answer 200; this half is what goes red if
    // the canonicalisation is moved below `_scoringEditAttempted`.
    const put2 = await putTask(adm, ac, taskId, { title: `${t0.title} renamed twice`, correct_answer: "abc" });
    expect(put2.status, `title + an equivalent spelling of the key: ${JSON.stringify(put2.body)}`).toBe(200);
    row = storedTask(taskId);
    expect(row.title).toBe(`${t0.title} renamed twice`);
    expect(row.correct_answer, "an equivalent spelling rewrites nothing either").toBe(" abc ");

    // Control: a REAL change to the key is still a scoring edit and is refused.
    const put3 = await putTask(adm, ac, taskId, { correct_answer: "abc\nxyz" });
    expect(put3.status, `a genuinely new alternative is frozen: ${JSON.stringify(put3.body)}`).toBe(409);
    expect(storedTask(taskId).correct_answer, "the refusal wrote nothing").toBe(" abc ");
    await adm.dispose();
  });

  test("11. recalculate flips an old WRONG row once the key gains that answer as an alternative", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, { taskSpecs: [{ answer_type: "text", correct_answer: "alpha" }], people: 2 });
    const taskId = tasks[0].id;
    const { api, csrf } = await enter(users[0].email, comp.id);
    const res = await submit(api, csrf, taskId, "beta");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.correct, "\"beta\" is wrong against \"alpha\"").toBe(false);
    expect(res.body.pointsDelta).toBe(-5);
    expect(storedSubmission(users[0].id, taskId)?.is_correct, "precondition: the row is stored WRONG").toBe(0);

    const put = await putTask(adm, ac, taskId, { correct_answer: "alpha\nbeta" });
    expect(put.status, `widen the key: ${JSON.stringify(put.body)}`).toBe(200);
    expect(storedTask(taskId).correct_answer).toBe("alpha\nbeta");

    // The event is LIVE, so recalculate asks for confirmation first — assert
    // that, or the confirmed call below could be reaching a different branch.
    const unconfirmed = await adm.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: H(ac), data: {} });
    expect(unconfirmed.status(), "a live event needs confirm_live").toBe(409);
    expect((await unconfirmed.json()).code).toBe("live_session_confirm");
    const rc = await adm.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: H(ac), data: { confirm_live: true } });
    expect(rc.ok(), `recalculate: ${rc.status()} ${await rc.text()}`).toBeTruthy();
    const rb = await rc.json();
    expect(rb.flipped, `exactly the one row flips: ${JSON.stringify(rb)}`).toBe(1);

    const row = storedSubmission(users[0].id, taskId);
    expect(row.is_correct, "the old wrong row is now CORRECT").toBe(1);
    expect(row.points_delta, "and carries the difficulty's points").toBe(50);
    await api.dispose(); await adm.dispose();
  });

  test("12. FILE is NOT split: stored \"a\\nb\", uploaded \"a\" is WRONG (the single-string rule, arm 5's negative twin)", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, {
      taskSpecs: [{ answer_type: "file", correct_answer: "a\nb" }], people: 2,
    });
    const { api, csrf } = await enter(users[0].email, comp.id);
    const res = await submitFile(api, csrf, tasks[0].id, "a");
    expect(res.status, `file submit: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.correct, "\"a\" is not the whole stored string, and the list rule must not apply to a file").toBe(false);
    expect(res.body.pointsDelta).toBe(-5);
    expect(storedSubmission(users[0].id, tasks[0].id)?.is_correct, "the stored row agrees").toBe(0);
    await api.dispose(); await adm.dispose();
  });

  test("13. export → import round-trips a text list, and the importer canonicalises a raw one", async () => {
    const { api: adm, csrf: ac } = await sa();
    const src = await createTask(adm, ac, { answer_type: "text", correct_answer: "one\ntwo" });
    expect(src.status, `create: ${JSON.stringify(src.body)}`).toBe(200);

    const ex = await adm.get("/api/admin/export/tasks?include_attachment_content=0");
    expect(ex.ok(), `export: ${ex.status()} ${await ex.text()}`).toBeTruthy();
    const data = await ex.json();
    expect(data.type).toBe("hackarena-tasks");
    const entry = data.tasks.find(t => t.title === src.title);
    expect(entry, "the source challenge is in the export").toBeTruthy();
    expect(entry.correct_answer, "the file carries the list verbatim").toBe("one\ntwo");

    // Two rows in one file: the exported entry re-titled (a clean round trip),
    // and a hand-edited entry whose key is NOT canonical — a migration file may
    // carry one, and the importer must store what the platform itself would
    // have written.
    const roundTitle = `${uniq()} imported`;
    const rawTitle = `${uniq()} imported raw`;
    const payload = { ...data, tasks: [
      { ...entry, title: roundTitle },
      { ...entry, title: rawTitle, correct_answer: " one \r\n\r\ntwo\nONE\n" },
    ] };
    const countTitled = (t) => withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title=?").get(t).n);

    // Phase 1 is a DRY RUN: no `resolutions`, nothing written.
    const dry = await adm.post("/api/admin/import/tasks", { headers: H(ac), data: { data: payload } });
    expect(dry.ok(), `dry run: ${dry.status()} ${await dry.text()}`).toBeTruthy();
    const db1 = await dry.json();
    expect(db1.dryRun).toBe(true);
    expect(db1.conflicts, "fresh titles conflict with nothing").toEqual([]);
    expect(countTitled(roundTitle), "a dry run writes nothing").toBe(0);

    const imp = await adm.post("/api/admin/import/tasks", { headers: H(ac), data: { data: payload, resolutions: {} } });
    expect(imp.ok(), `import: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    const ib = await imp.json();
    expect(ib.dryRun, "the second phase is the real import").toBeFalsy();

    const round = withDb((db) => db.prepare("SELECT id, answer_type, correct_answer FROM tasks WHERE title=?").get(roundTitle));
    expect(round, "the round-tripped row exists").toBeTruthy();
    expect(round.id, "it is a NEW row, not the source").not.toBe(src.id);
    expect(round.answer_type).toBe("text");
    expect(round.correct_answer, "the list survives the round trip byte-for-byte").toBe("one\ntwo");
    const raw = withDb((db) => db.prepare("SELECT correct_answer FROM tasks WHERE title=?").get(rawTitle));
    expect(raw, "the raw-keyed row exists").toBeTruthy();
    expect(raw.correct_answer, "the importer canonicalises: trimmed, CRLF split, blanks and the ONE duplicate dropped").toBe("one\ntwo");
    await adm.dispose();
  });

  test("14. a stale grading hash is refused 409 task_changed after an alternative is added; a fresh GET + submit succeeds", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, { taskSpecs: [{ answer_type: "text", correct_answer: "alpha" }], people: 2 });
    const taskId = tasks[0].id;
    const { api, csrf } = await enter(users[0].email, comp.id);
    const viewA = await (await api.get(`/api/tasks/${taskId}`)).json();
    expect(viewA.grading_hash, "the participant view carries the grading token").toBeTruthy();

    // The admin adds an alternative while the page is open. The key is part of
    // the grading basis, so the token the participant holds is now stale.
    const put = await putTask(adm, ac, taskId, { correct_answer: "alpha\nbeta" });
    expect(put.status, `add an alternative: ${JSON.stringify(put.body)}`).toBe(200);

    const stale = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": csrf },
      multipart: { answer: "beta", gradingHash: viewA.grading_hash },
    });
    expect(stale.status(), "graded against criteria the participant did not see: refused").toBe(409);
    expect((await stale.json()).task_changed).toBe(true);
    expect(storedSubmission(users[0].id, taskId), "a refused attempt stores no row and costs nothing").toBeFalsy();

    const viewB = await (await api.get(`/api/tasks/${taskId}`)).json();
    expect(viewB.grading_hash, "the token moved with the key").not.toBe(viewA.grading_hash);
    const fresh = await submit(api, csrf, taskId, "beta");
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.correct, "the new alternative solves it once the participant has seen the new version").toBe(true);
    expect(fresh.body.pointsDelta).toBeGreaterThan(0);
    await api.dispose(); await adm.dispose();
  });
});
