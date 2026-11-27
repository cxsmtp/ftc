// v8.9.0 — the `any` answer type.
//
// The rule in one line: every NON-EMPTY answer is correct, and it is stored and
// graded VERBATIM — no trim, no case fold. Everything else in the feature
// follows from "there is no key": `correct_answer` is forced to "" (the column
// is NOT NULL) and may be omitted at create; a hint is REFUSED rather than
// silently dropped (a field the platform accepts and ignores is a control that
// appears to work); a switch from `text` clears the stored hint; the reveal
// ships the explanation and no key; the hint route says there is nothing to
// reveal; recalculate turns an old wrong row correct; and the ended-session
// freeze refuses the type change like every other scoring edit.
//
// Every arm below is pinned against a realistic wrong implementation, and the
// five mutations in the report kill exactly their own arm:
//   • trim the answer for every type          → arm 2 (verbatim storage) goes red;
//   • drop the empty-answer 400               → arm 3 goes red (a row and a score
//                                                appear where the rule says none may);
//   • drop the POST hint refusal              → arm 4 goes red;
//   • drop the recalculate `any` branch       → arm 10 goes red;
//   • `_importAnyRowOk` always true           → arm 8 goes red.
//
// Fixture rules (the standing checklist): every grading arm OWNS its
// competition, challenges and participants; the fixture enrols TWO participants
// and only one of them ever submits, because an any-answer challenge is solved by
// its FIRST submission, so a sole participant solving it ENDS the event under the
// test (the all-solved rule); and there is ONE task per positive grading arm,
// since the server refuses a second submit once a correct row exists for that
// (user, task). The stored rows are read through better-sqlite3 opened INSIDE the
// test (a module-scope handle reads the previous file's unlinked inode, v7.20.2),
// because "the response said correct" is equally true of a build that stores the
// trimmed answer, and the whole point of arm 2 is what was STORED.
//
// The admin-only arms (create, hint refusals, switch, restore, import) build
// standalone challenges — no competition holds them, so neither the ended-session
// freeze nor the challenge-fit gate can be the thing that answered.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `an${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// The two refusal strings the server owns. Asserted by CONTENT (a fragment each
// human would recognise), never by full equality on the hint one — its wording
// is the product's to change, what must not change is that it names the hint.
const EMPTY_REFUSAL = "An answer is required.";

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
      firstName: "Any", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `?search=` is a no-op on this endpoint (CLAUDE.md), so the documented 5000
  // cap is what makes a just-created account findable rather than the filter.
  const list = await (await api.get(`/api/admin/participants?limit=5000`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

/**
 * A live competition, one challenge per entry of `taskSpecs`, and `people`
 * participants enrolled. `taskSpecs[i]` supplies `answer_type` and whatever else
 * the arm needs (`correct_answer`, `hint`, `explanation`); `compExtra` rides the
 * competition create (the reveal flag for arm 12). Everything else is the
 * attempt-caps fixture verbatim.
 */
async function makeFixture(api, csrf, { taskSpecs = [{ answer_type: "any" }], people = 2, minutes = 600, compExtra = {} } = {}) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
      duration_minutes: minutes, timezone: "UTC", ...compExtra,
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
    const t = { id: tid, title };
    tasks.push(t);
    const asg = await api.post(`/api/admin/tasks/${t.id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign task ${i}: ${await asg.text()}`).toBeTruthy();
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

/**
 * One submission through the real path, carrying the grading token. The answer
 * goes as a MULTIPART field, exactly as the SPA sends it, so a leading or
 * trailing space survives the wire — the thing arm 2 is about.
 */
async function submit(api, csrf, taskId, answer) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
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

/** The stored task row — the columns the wire never ships for a participant. */
function storedTask(taskId) {
  return withDb((db) => db.prepare("SELECT title, answer_type, correct_answer, hint, updated_at FROM tasks WHERE id=?").get(taskId));
}

/** The most recent stored submission for one (user, task). */
function storedSubmission(userId, taskId) {
  return withDb((db) => db.prepare(
    "SELECT is_correct, points_delta, answer FROM submissions WHERE user_id=? AND task_id=? ORDER BY submitted_at DESC LIMIT 1"
  ).get(userId, taskId));
}

/** Create a standalone challenge (held by no competition). Returns the response. */
function mkTask(api, csrf, data) {
  return api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} task`, description: "d", difficulty: "easy", ...data },
  });
}

test.describe("any-answer challenges (v8.9.0)", () => {
  test("1. create: no correct_answer is needed, the key is stored as \"\" with no hint, and an edit leaves the key \"\"", async () => {
    const { api, csrf } = await sa();
    const r = await mkTask(api, csrf, { answer_type: "any" });
    expect(r.ok(), `create with no correct_answer must be accepted: ${r.status()} ${await r.text()}`).toBeTruthy();
    const { id } = await r.json();
    expect(id).toBeTruthy();

    const row = storedTask(id);
    expect(row.answer_type).toBe("any");
    // Asserted by IDENTITY with the empty string: `toBeFalsy()` would also be
    // satisfied by a NULL that the NOT NULL column cannot hold — and by a build
    // that stored "0".
    expect(row.correct_answer, "the NOT NULL key column holds the empty string").toBe("");
    expect(row.hint, "no hint on a challenge nobody can hint towards").toBeNull();

    const put = await api.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { title: `${uniq()} renamed` } });
    expect(put.ok(), `title edit: ${put.status()} ${await put.text()}`).toBeTruthy();
    const after = storedTask(id);
    expect(after.title).toMatch(/renamed$/);
    expect(after.correct_answer, "an edit that does not name the key leaves it \"\"").toBe("");
    expect(after.answer_type).toBe("any");
    await api.dispose();
  });

  test("2. verbatim: \" MiXeD  Case \" is correct AND stored byte-for-byte; the text control stores it TRIMMED", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, {
      taskSpecs: [
        { answer_type: "any" },
        // Stored canonical as "mixed case"; the padded, cased variant grades
        // correct under the text rule, which is what makes it a CONTROL for the
        // storage half rather than for the grading half.
        { answer_type: "text", correct_answer: "mixed case" },
      ],
      people: 2,
    });
    const [anyTask, textTask] = tasks;
    const { api, csrf } = await enter(users[0].email, comp.id);
    const ANSWER = " MiXeD  Case ";

    const res = await submit(api, csrf, anyTask.id, ANSWER);
    expect(res.status, `any submit: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.correct, JSON.stringify(res.body)).toBe(true);
    expect(res.body.refused, "graded, not refused").toBeFalsy();
    expect(res.body.pointsDelta, "a correct answer earns the difficulty's points").toBeGreaterThan(0);
    const row = storedSubmission(users[0].id, anyTask.id);
    expect(row, "a submission row was written").toBeTruthy();
    expect(row.is_correct).toBe(1);
    // THE ARM: leading space, trailing space, internal double space and the
    // case all survive. `toBe` on the exact string, so a build that trims
    // (the realistic wrong implementation — every other type does) goes red.
    expect(row.answer, "stored VERBATIM").toBe(ANSWER);

    // Control: the same bytes on a text challenge grade correct AND are stored
    // trimmed, which is what says the any path is not merely "how everything is
    // stored now".
    const ctl = await submit(api, csrf, textTask.id, ANSWER);
    expect(ctl.status, `text submit: ${JSON.stringify(ctl.body)}`).toBe(200);
    expect(ctl.body.correct, JSON.stringify(ctl.body)).toBe(true);
    const trow = storedSubmission(users[0].id, textTask.id);
    expect(trow.is_correct).toBe(1);
    expect(trow.answer, "the text path trims the ends (and keeps the inside)").toBe("MiXeD  Case");
    await api.dispose(); await adm.dispose();
  });

  test("3. empty refused: \"\" and whitespace-only are 400 BEFORE grading — no row, no penalty — and a real answer then scores", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, { taskSpecs: [{ answer_type: "any" }], people: 2 });
    const task = tasks[0];
    const { api, csrf } = await enter(users[0].email, comp.id);

    for (const bad of ["", "   \t"]) {
      const res = await submit(api, csrf, task.id, bad);
      expect(res.status, `submit ${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.error, JSON.stringify(res.body)).toBe(EMPTY_REFUSAL);
      // Not a 200 "refused" (the attempt-cap shape) and not a graded wrong answer:
      // a validation failure names itself and takes nothing.
      expect(res.body.correct).toBeUndefined();
    }
    const written = withDb((db) => db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE task_id=?").get(task.id).c);
    expect(written, "a refused answer writes NO submission row").toBe(0);
    const score = withDb((db) => db.prepare(
      "SELECT COALESCE(SUM(points_delta),0) AS s FROM submissions WHERE user_id=? AND competition_id=?"
    ).get(users[0].id, comp.id).s);
    expect(score, "and costs no penalty").toBe(0);

    // Control: the refusal was about EMPTINESS, not about the challenge or the
    // participant — a real answer on the same (user, task) now scores.
    const ok = await submit(api, csrf, task.id, "x");
    expect(ok.status, `real submit: ${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.body.correct).toBe(true);
    expect(ok.body.pointsDelta).toBeGreaterThan(0);
    expect(storedSubmission(users[0].id, task.id)?.answer).toBe("x");
    await api.dispose(); await adm.dispose();
  });

  test("4. POST refuses a real hint on an any-answer challenge, accepts empty markup, and the text control still stores one", async () => {
    const { api, csrf } = await sa();
    const bad = await mkTask(api, csrf, { answer_type: "any", hint: "<p>real</p>" });
    expect(bad.status(), `a real hint must be refused: ${await bad.text()}`).toBe(400);
    expect((await bad.json()).error, "the refusal names the hint").toMatch(/hint/i);

    // `<p></p>` is what a rich-text editor posts for an untouched field; it
    // carries no content, so it must not brick the create.
    const empty = await mkTask(api, csrf, { answer_type: "any", hint: "<p></p>" });
    expect(empty.ok(), `empty markup is not a hint: ${empty.status()} ${await empty.text()}`).toBeTruthy();
    const emptyRow = storedTask((await empty.json()).id);
    expect(emptyRow.hint, "stored as NULL, not as the empty markup").toBeNull();
    expect(emptyRow.correct_answer).toBe("");

    // Control: the same hint on a text challenge is accepted and STORED, so the
    // 400 above is the any-answer rule and not a broken hint field.
    const ctl = await mkTask(api, csrf, { answer_type: "text", correct_answer: "k", hint: "<p>real</p>" });
    expect(ctl.ok(), `text control: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
    const ctlRow = storedTask((await ctl.json()).id);
    expect(ctlRow.hint, "the text challenge keeps its hint").toContain("real");
    await api.dispose();
  });

  test("5. PUT refuses a real hint on an existing any-answer challenge; empty markup is accepted and the hint stays NULL", async () => {
    const { api, csrf } = await sa();
    const r = await mkTask(api, csrf, { answer_type: "any" });
    expect(r.ok(), await r.text()).toBeTruthy();
    const { id } = await r.json();

    const bad = await api.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { hint: "<p>real</p>" } });
    expect(bad.status(), `a real hint on an edit must be refused: ${await bad.text()}`).toBe(400);
    expect((await bad.json()).error).toMatch(/hint/i);
    expect(storedTask(id).hint, "nothing was written").toBeNull();

    // A lone non-breaking space is what the editor emits when a hint is opened
    // and closed; stripped, it is nothing, so the save goes through with the
    // column still NULL rather than holding "&nbsp;".
    const ok = await api.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { hint: "<p>&nbsp;</p>" } });
    expect(ok.ok(), `empty markup: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    const row = storedTask(id);
    expect(row.hint).toBeNull();
    expect(row.correct_answer, "and the key is untouched by an edit of an any row").toBe("");
    await api.dispose();
  });

  test("6. switching text → any clears the stored hint and the key", async () => {
    const { api, csrf } = await sa();
    const r = await mkTask(api, csrf, { answer_type: "text", correct_answer: "the key", hint: "<p>a real hint</p>" });
    expect(r.ok(), await r.text()).toBeTruthy();
    const { id } = await r.json();
    const before = storedTask(id);
    expect(before.hint, "precondition: the text challenge really holds a hint").toContain("a real hint");
    expect(before.correct_answer, "precondition: and a key").toBe("the key");

    const put = await api.put(`/api/admin/tasks/${id}`, {
      headers: H(csrf), data: { answer_type: "any", expectedUpdatedAt: before.updated_at },
    });
    expect(put.ok(), `switch to any: ${put.status()} ${await put.text()}`).toBeTruthy();
    const after = storedTask(id);
    expect(after.answer_type).toBe("any");
    // The type forbids a hint, so the switch CLEARS it — the v8.3.0 "a kind
    // change resets what the new kind forbids" rule, one entity over. A COALESCE
    // write cannot express NULL, which is why this arm exists.
    expect(after.hint, "the hint the new type forbids is cleared").toBeNull();
    expect(after.correct_answer, "and the key is gone").toBe("");
    await api.dispose();
  });

  test("7. restore: a hand-corrupted any snapshot carrying a hint is refused 409; a clean one restores with hint NULL", async () => {
    const { api, csrf } = await sa();
    const r = await mkTask(api, csrf, { answer_type: "any" });
    expect(r.ok(), await r.text()).toBeTruthy();
    const { id } = await r.json();
    // A second version, so the restore has somewhere to go back TO.
    const put = await api.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { title: `${uniq()} v2` } });
    expect(put.ok(), await put.text()).toBeTruthy();

    const versions = await (await api.get(`/api/admin/tasks/${id}/versions`)).json();
    const createV = versions.find((v) => v.change_type === "create");
    expect(createV, "the create version exists").toBeTruthy();
    const original = createV.snapshot;

    // Hand-corrupt the snapshot the way only a hand-edited row can: no writer
    // stores a hint on an any-answer challenge, so this state is reachable ONLY
    // by editing the version table directly (or by a botched migration).
    const snap = JSON.parse(original);
    expect(snap.answer_type, "precondition: the snapshot is an any-answer version").toBe("any");
    snap.hint = "<p>leak</p>";
    withDb((db) => db.prepare("UPDATE task_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snap), createV.id), {});

    const refused = await api.post(`/api/admin/tasks/${id}/restore`, { headers: H(csrf), data: { versionId: createV.id } });
    expect(refused.status(), `an any snapshot with a hint must be refused: ${await refused.text()}`).toBe(409);
    expect((await refused.json()).error).toMatch(/hint/i);
    const untouched = storedTask(id);
    expect(untouched.hint, "nothing was written").toBeNull();
    expect(untouched.title, "the restore did not land").toMatch(/ v2$/);

    // Positive control: the INTACT snapshot of the same version restores, so the
    // 409 above is the hint check and not a broken restore path — and it lands
    // with the invariant held.
    withDb((db) => db.prepare("UPDATE task_versions SET snapshot=? WHERE id=?").run(original, createV.id), {});
    const ok = await api.post(`/api/admin/tasks/${id}/restore`, { headers: H(csrf), data: { versionId: createV.id } });
    expect(ok.ok(), `a clean any snapshot restores: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    const restored = storedTask(id);
    expect(restored.title, "the restore landed").toBe(snap.title);
    expect(restored.answer_type).toBe("any");
    expect(restored.hint).toBeNull();
    expect(restored.correct_answer).toBe("");
    await api.dispose();
  });

  test("8. import: an any row with a real hint is SKIPPED; one without imports with key \"\" and hint NULL", async () => {
    const { api, csrf } = await sa();
    const titleA = `${uniq()} import A (hinted)`;
    const titleB = `${uniq()} import B`;
    const r = await api.post("/api/admin/import/tasks", {
      headers: H(csrf),
      data: {
        data: {
          type: "hackarena-tasks",
          tasks: [
            { title: titleA, difficulty: "easy", answer_type: "any", hint: "<p>x</p>" },
            { title: titleB, difficulty: "easy", answer_type: "any" },
          ],
        },
        // The importer is two-phase: no `resolutions` is a DRY RUN that writes
        // nothing. An empty object is the "execute, with no conflicts to resolve"
        // shape.
        resolutions: {},
      },
    });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    expect(body.dryRun, "this was an execution, not a dry run").toBeFalsy();
    expect(body.skipped, "the hinted any row is skipped, and reported").toBe(1);
    expect(body.imported, "the clean any row imports").toBe(1);

    const rows = withDb((db) => db.prepare("SELECT title, answer_type, correct_answer, hint FROM tasks WHERE title IN (?,?)").all(titleA, titleB));
    const a = rows.find((x) => x.title === titleA);
    const b = rows.find((x) => x.title === titleB);
    expect(a, "the hinted row landed NOWHERE — not even with its hint stripped").toBeUndefined();
    expect(b, "the clean row exists").toBeTruthy();
    expect(b.answer_type).toBe("any");
    expect(b.correct_answer, "the NOT NULL key column holds \"\"").toBe("");
    expect(b.hint).toBeNull();
    await api.dispose();
  });

  test("9. the hint route answers 400 on an any-answer challenge (control: a text challenge's hint is served)", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, {
      taskSpecs: [
        { answer_type: "any" },
        { answer_type: "text", correct_answer: "k", hint: "<p>look left</p>" },
      ],
      people: 2,
    });
    const [anyTask, textTask] = tasks;
    const { api, csrf } = await enter(users[0].email, comp.id);

    const r = await api.post(`/api/tasks/${anyTask.id}/hint`, { headers: H(csrf) });
    expect(r.status(), `hint on any: ${await r.text()}`).toBe(400);
    expect((await r.json()).error).toMatch(/no hint/i);
    const charged = withDb((db) => db.prepare("SELECT COUNT(*) AS c FROM hint_reveals WHERE user_id=? AND task_id=?").get(users[0].id, anyTask.id).c);
    expect(charged, "no deduction was recorded for a hint that does not exist").toBe(0);

    // Control: the same participant, same competition, same session — a text
    // challenge's hint is served, so the 400 above is about the TYPE and not
    // about a session gate or a missing assignment.
    const ctl = await api.post(`/api/tasks/${textTask.id}/hint`, { headers: H(csrf) });
    expect(ctl.ok(), `text hint: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
    expect((await ctl.json()).hint).toContain("look left");
    await api.dispose(); await adm.dispose();
  });

  test("10. recalculate after a text → any switch re-grades an old WRONG row as correct", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, {
      taskSpecs: [{ answer_type: "text", correct_answer: "alpha" }], people: 2,
    });
    const task = tasks[0];
    const { api, csrf } = await enter(users[0].email, comp.id);
    const wrong = await submit(api, csrf, task.id, "beta");
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(200);
    expect(wrong.body.correct, "precondition: \"beta\" is wrong under the text key").toBe(false);
    const before = storedSubmission(users[0].id, task.id);
    expect(before.is_correct, "precondition: the wrong row is stored").toBe(0);
    expect(before.points_delta).toBe(-5);

    // The switch is a scoring edit on a challenge held by a LIVE event — allowed,
    // since nothing has ended; the freeze arm (11) is the ended twin.
    const put = await adm.put(`/api/admin/tasks/${task.id}`, { headers: H(ac), data: { answer_type: "any" } });
    expect(put.ok(), `switch: ${put.status()} ${await put.text()}`).toBeTruthy();
    expect(storedTask(task.id).answer_type).toBe("any");

    // Live events need the explicit confirmation — the same override the client
    // sends after its second confirm dialog (v8.1.5).
    const rc = await adm.post(`/api/admin/tasks/${task.id}/recalculate`, { headers: H(ac), data: { confirm_live: true } });
    expect(rc.ok(), `recalculate: ${rc.status()} ${await rc.text()}`).toBeTruthy();
    const after = storedSubmission(users[0].id, task.id);
    expect(after.is_correct, "\"beta\" is a non-empty answer, so under `any` it is correct").toBe(1);
    expect(after.points_delta, "and it now carries the points, not the penalty").toBeGreaterThan(0);
    await api.dispose(); await adm.dispose();
  });

  test("11. a text → any switch is frozen 409 once a competition holding the challenge has ended", async () => {
    const { api, csrf } = await sa();
    // Assignment must happen while the competition is still live (assignments
    // are frozen once a session ends), so the order is create → assign → end-now.
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `${uniq()} Freeze`, start_time: new Date(Date.now() - 30_000).toISOString(), duration_minutes: 60, timezone: "UTC" },
    });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const tr = await mkTask(api, csrf, { answer_type: "text", correct_answer: "k", status: "published" });
    expect(tr.ok(), await tr.text()).toBeTruthy();
    const { id } = await tr.json();
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
    const end = await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": csrf } });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    const put = await api.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { answer_type: "any" } });
    expect(put.status(), `the switch is a scoring edit and the event has ended: ${await put.text()}`).toBe(409);
    expect((await put.json()).error).toMatch(/scoring|ended/i);
    const row = storedTask(id);
    expect(row.answer_type, "nothing moved").toBe("text");
    expect(row.correct_answer).toBe("k");

    // Control: a COSMETIC edit on the same frozen challenge still goes through,
    // so the 409 is the scoring freeze and not a wholesale lock.
    const cosmetic = await api.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { title: `${uniq()} retitled` } });
    expect(cosmetic.ok(), `cosmetic edit on a frozen challenge: ${cosmetic.status()} ${await cosmetic.text()}`).toBeTruthy();
    await api.dispose();
  });

  test("12. reveal: an ended, revealing competition ships the explanation but NO correct_answer key for any (control: text ships its key)", async () => {
    const { api: adm, csrf: ac } = await sa();
    const { comp, tasks, users } = await makeFixture(adm, ac, {
      taskSpecs: [
        { answer_type: "any", explanation: "<p>Because you said so.</p>" },
        { answer_type: "text", correct_answer: "the key", explanation: "<p>Text reasons.</p>" },
      ],
      people: 2,
      compExtra: { reveal_answers_on_end: true },
    });
    const [anyTask, textTask] = tasks;
    const { api, csrf } = await enter(users[0].email, comp.id);
    const res = await submit(api, csrf, anyTask.id, "anything at all");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.correct).toBe(true);

    // The reveal is gated on the competition having FULLY ENDED with the flag
    // on; a solve alone reveals nothing. End it.
    const end = await adm.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: { "x-csrf-token": ac } });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    const anyView = await api.get(`/api/tasks/${anyTask.id}`);
    expect(anyView.ok(), `read after end: ${anyView.status()} ${await anyView.text()}`).toBeTruthy();
    const anyBody = await anyView.json();
    expect(anyBody.solved, "precondition: the participant solved it").toBe(true);
    expect(anyBody.competition_fully_ended, "precondition: the competition has fully ended").toBe(true);
    expect(anyBody.explanation, "the explanation is revealed").toContain("Because you said so");
    // The KEY, not the value: `correct_answer: ""` on the wire would be a wrong
    // answer of its own (a client would render an empty "Correct answer" line).
    expect(Object.prototype.hasOwnProperty.call(anyBody, "correct_answer"), "there is no key to reveal, so no key is shipped").toBe(false);

    // Control: the text challenge in the SAME ended, revealing competition ships
    // its key — so the absence above is the any rule, not a reveal that never
    // fired.
    const textBody = await (await api.get(`/api/tasks/${textTask.id}`)).json();
    expect(textBody.competition_fully_ended).toBe(true);
    expect(textBody.correct_answer, "the text challenge reveals its key").toBe("the key");
    expect(textBody.explanation).toContain("Text reasons");
    await api.dispose(); await adm.dispose();
  });
});
