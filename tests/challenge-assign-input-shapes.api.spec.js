// @ts-check
//
// v8.13.3 — THE CHALLENGE ROUTES: WHAT A MALFORMED BODY AND AN INTERNAL ERROR
// LOOK LIKE ON THE WIRE.
//
// Four defects of one family, all in routes/challenges.js:
//
//   • POST / PUT /api/admin/tasks/:id/competitions answered EVERY throw from
//     their transactions as a 400 quoting `e.message` (plus `e.code` and an
//     empty refusal ledger whenever the thrown object had a code), and logged
//     nothing. An internal error — a SQLITE_BUSY from an operator's sqlite3
//     session, a failed constraint, a strict predicate refusing an under-selected
//     row — reached the admin as the driver's own text, under a status saying
//     their request was wrong. Deliberate refusals now carry a marker where they
//     are thrown; anything unmarked goes to the global handler (logged with its
//     stack, generic 500).
//   • A non-string `competitionIds` element reached the SQL bind. better-sqlite3
//     FLATTENS a one-element array, so on the POST a nested id `[["<E>"]]` SKIPPED
//     the staff-compete competitor lock (its pre-pass `continue`d past non-strings)
//     and was then assigned — a competing admin could add a challenge to their own
//     board. On the PUT the same nested id was a remove-plus-re-add that rewrote
//     the row's provenance. Every other shape answered the driver's text.
//   • POST :id/restore bound `versionId` raw: `[v]` PERFORMED the restore, `{}` /
//     `true` / `[v, v]` answered 500.
//   • `attachment_url` was missing from the challenge create/edit type guard: a
//     two-element array 500'd the INSERT, a one-element array was stored, and on
//     EDIT `{}` / `false` / `0` silently CLEARED the stored URL with a 200.
//
// HOW THE INTERNAL ERROR IS PRODUCED. A RAISE(ABORT) trigger on
// `competition_tasks`, scoped to ONE challenge id and planted through this
// worker's own handle on the per-file database (the sealed-reveal-unrecorded
// precedent). It is the realistic shape — a SqliteError with a code — and,
// unlike a held external write lock, it needs no timing. INSERT OR IGNORE does
// not suppress RAISE(ABORT). Every arm drops it in a `finally` and asserts it
// was really armed; every 500 arm is followed by the SAME request with the
// trigger dropped, which must succeed — or "the route answered 500" is satisfied
// by a fixture that was never assignable.
//
// EVERY REFUSAL HAS A CONTROL. "It is a 400" is equally true of a build that
// refuses every body, so each malformed shape is paired with the well-formed one
// on the same fixture; and "the deliberate refusals still say what they said" is
// pinned by exact bodies, because a build that 500s everything would pass the
// internal-error arms alone.
const { test, expect } = require("./isolated-test");
const path = require("path");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, findLogLine } = require("./helpers");
const {
  H, uniq, makeParticipant, makeCompetition, makeTask, enrol, grantEventAdmin,
} = require("./event-admin-helpers");

const GENERIC_500 = "An internal error occurred. Please try again.";
const IDS_SHAPE = "competitionIds must be an array of strings";
const EXPECTED_SHAPE = "expectedAssignments must be an array of strings";
// What a driver error looks like when it leaks. Asserted ABSENT from every
// refusal body: the named sentence must replace it, not sit beside it.
const DRIVER_TEXT = /SQLite3|parameter values|can only bind|SQLITE_|constraint|trigger/i;
const BULK_ADMIN_MAX = 1000; // lib/config.js — the boundary is asserted on both sides below

// better-sqlite3 is opened INSIDE the callback, never at module scope: per-file
// isolation recreates the database in a `beforeAll`, so a handle taken at
// require time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}
const dbGet = (sql, ...a) => withDb(db => db.prepare(sql).get(...a));
const dbExec = sql => withDb(db => db.exec(sql), { readonly: false });
const heldCount = tid => dbGet("SELECT COUNT(*) c FROM competition_tasks WHERE task_id=?", tid).c;
const held = (cid, tid) => !!dbGet("SELECT 1 x FROM competition_tasks WHERE competition_id=? AND task_id=?", cid, tid);
const assignmentRow = (cid, tid) => dbGet("SELECT assigned_at, assigned_by_id FROM competition_tasks WHERE competition_id=? AND task_id=?", cid, tid);
const assignEvents = (cid, tid) => dbGet(
  "SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type IN ('task_added','task_removed') AND details LIKE ?",
  cid, `%${tid}%`).c;
const taskRow = tid => dbGet("SELECT title, updated_at, attachment_url FROM tasks WHERE id=?", tid);

/** Run `fn` with every INSERT of `taskId` into competition_tasks failing; the trigger is ALWAYS dropped. */
async function withAssignFailing(taskId, token, fn) {
  const trig = `zz_assignerr_${taskId.replace(/[^a-zA-Z0-9]/g, "")}`;
  dbExec(`CREATE TRIGGER ${trig} BEFORE INSERT ON competition_tasks WHEN NEW.task_id='${taskId}' BEGIN SELECT RAISE(ABORT,'${token}'); END;`);
  try {
    expect(dbGet("SELECT 1 x FROM sqlite_master WHERE type='trigger' AND name=?", trig), "precondition: the failure is really armed").toBeTruthy();
    return await fn();
  } finally { dbExec(`DROP TRIGGER IF EXISTS ${trig}`); }
}

/** A fresh participant promoted to `role`, signed in AFTER the promotion (a role change purges sessions). */
async function makeAdmin(sa, saCsrf, label, role = "admin", { enrolIn = [] } = {}) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  for (const cid of enrolIn) await enrol(sa, saCsrf, cid, [p.id]);
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  return { ...p, api, csrf };
}

const postAssign = (c, taskId, competitionIds) =>
  c.api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(c.csrf), data: { competitionIds } });
const putDesired = (c, taskId, competitionIds, expectedAssignments) =>
  c.api.put(`/api/admin/tasks/${taskId}/competitions`, { headers: H(c.csrf), data: { competitionIds, expectedAssignments } });

/** A 400 whose body is EXACTLY `{error}` and carries no driver text. */
async function expectNamed400(res, error, what) {
  const txt = await res.text();
  expect(res.status(), `${what}: ${txt}`).toBe(400);
  expect(JSON.parse(txt), `${what}: the named sentence and nothing else`).toEqual({ error });
  expect(txt, `${what}: no driver text`).not.toMatch(DRIVER_TEXT);
}

/** The generic 500, its request logged with the driver's code and text — not swallowed, not echoed. */
async function expectInternal500(res, token, what) {
  const txt = await res.text();
  expect(res.status(), `${what}: ${txt}`).toBe(500);
  expect(JSON.parse(txt), `${what}: the generic body, no code and no refusal ledger`).toEqual({ error: GENERIC_500 });
  expect(txt, `${what}: the driver's own text stays server-side`).not.toContain(token);
  expect(txt, `${what}: nothing of the driver at all`).not.toMatch(DRIVER_TEXT);
  const reqId = res.headers()["x-request-id"];
  expect(reqId, `${what}: the response names its request`).toBeTruthy();
  // Tied to THIS request by req_id, so a stale line from an earlier arm cannot
  // satisfy it. This is the only assertion that sees the difference between
  // re-throwing to the global handler and answering 500 inline with no log.
  const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
    j => j.level === "error" && j.req_id === reqId,
    { what: `the error line for ${what} (req_id ${reqId})` });
  expect(line.err_type, `${what}: the log names the driver's code`).toBe("SQLITE_CONSTRAINT_TRIGGER");
  expect(String(line.msg), `${what}: the log carries the driver's text`).toContain(token);
  expect(String(line.stack || ""), `${what}: with a stack`).toMatch(/at /);
}

test.describe("v8.13.3 — an internal error in the assignment transaction is a logged 500, never a 400 quoting the driver", () => {
  test("POST :id/competitions — a failing INSERT answers the generic 500, writes nothing, and is logged", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const C = await makeCompetition(sa, saCsrf, "raw-post");
    const T = await makeTask(sa, saCsrf, "raw-post");
    const token = `zz-internal-${uniq("post")}`;
    await withAssignFailing(T.id, token, async () => {
      const r = await postAssign({ api: sa, csrf: saCsrf }, T.id, [C.id]);
      await expectInternal500(r, token, "POST with a failing INSERT");
      expect(heldCount(T.id), "the transaction rolled back").toBe(0);
    });
    // CONTROL — the same request with the failure disarmed succeeds: the 500
    // came from the trigger, not from a fixture that could never be assigned.
    const ok = await postAssign({ api: sa, csrf: saCsrf }, T.id, [C.id]);
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).assigned).toBe(1);
    expect(held(C.id, T.id)).toBe(true);
  });

  test("PUT :id/competitions — a failing INSERT answers the generic 500, writes nothing, and is logged", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const C = await makeCompetition(sa, saCsrf, "raw-put");
    const T = await makeTask(sa, saCsrf, "raw-put");
    const token = `zz-internal-${uniq("put")}`;
    await withAssignFailing(T.id, token, async () => {
      const r = await putDesired({ api: sa, csrf: saCsrf }, T.id, [C.id], []);
      await expectInternal500(r, token, "PUT with a failing INSERT");
      expect(heldCount(T.id), "the transaction rolled back").toBe(0);
    });
    const ok = await putDesired({ api: sa, csrf: saCsrf }, T.id, [C.id], []);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, added: 1, removed: 0 });
  });

  test("CONTROL — every DELIBERATE refusal keeps its status and its exact body, on both doors", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const SA = { api: sa, csrf: saCsrf };
    const T = await makeTask(sa, saCsrf, "deliberate");

    // (i) An ENDED event — a time-expired one, created in the past.
    const ended = await makeCompetition(sa, saCsrf, "ended", {
      start_time: new Date(Date.now() - 2 * 3_600_000).toISOString(), duration_minutes: 30,
    });
    const endedMsg = `Cannot modify challenge assignments for competition "${ended.name}" — a session has already ended.`;
    await expectNamed400(await postAssign(SA, T.id, [ended.id]), endedMsg, "POST into an ended event");
    await expectNamed400(await putDesired(SA, T.id, [ended.id], []), endedMsg, "PUT into an ended event");

    // (ii) A well-formed id that names no event — on BOTH doors. The PUT's
    // was pinned by nothing before this release.
    const ghost = `no-such-${uniq("event")}`;
    await expectNamed400(await postAssign(SA, T.id, [ghost]), `Competition not found: ${ghost}`, "POST naming no event");
    await expectNamed400(await putDesired(SA, T.id, [ghost], []), `Competition not found: ${ghost}`, "PUT naming no event");

    // (iii) The CODED refusal keeps its code and its ledger: an UNSEALED
    // challenge into an event where staff compete.
    const sc = await makeCompetition(sa, saCsrf, "compete", {
      staff_compete: true, start_time: new Date(Date.now() + 86_400_000).toISOString(),
    });
    for (const [what, res] of [["POST", await postAssign(SA, T.id, [sc.id])], ["PUT", await putDesired(SA, T.id, [sc.id], [])]]) {
      const txt = await res.text();
      expect(res.status(), `${what} unsealed into a compete event: ${txt}`).toBe(400);
      const b = JSON.parse(txt);
      expect(b.code, `${what}: the seal code survives`).toBe("staff_compete_unsealed");
      expect(b.refused_total, `${what}: the ledger survives`).toBe(1);
      expect(b.refused[0].competition_id).toBe(sc.id);
    }

    // (iv) The concurrency sentinel is still a 409.
    const c = await putDesired(SA, T.id, [], [`other-${uniq("x")}`]);
    expect(c.status(), await c.text()).toBe(409);
    expect((await c.json()).conflict).toBe(true);

    expect(heldCount(T.id), "no refusal wrote anything").toBe(0);
  });
});

test.describe("v8.13.3 — competitionIds / expectedAssignments must be arrays of strings, and are bounded", () => {
  test("POST :id/competitions — every non-string element is the named 400, and assigns nothing", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const SA = { api: sa, csrf: saCsrf };
    const C = await makeCompetition(sa, saCsrf, "shape-post");
    const T = await makeTask(sa, saCsrf, "shape-post");
    // `[[C]]` is the shape that flattened into a REAL assignment; the rest
    // answered the driver's text (or "Competition not found: null").
    for (const bad of [[[C.id]], [true], [{}], [["a", "b"]], [123], [null], [C.id, {}]]) {
      await expectNamed400(await postAssign(SA, T.id, bad), IDS_SHAPE, `POST ${JSON.stringify(bad)}`);
    }
    expect(heldCount(T.id), "nothing was assigned").toBe(0);
    // CONTROL — the string form of the same id lands.
    const ok = await postAssign(SA, T.id, [C.id]);
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).assigned).toBe(1);
  });

  test("PUT :id/competitions — a nested id no longer deletes and re-inserts the row; every bad shape is named", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const SA = { api: sa, csrf: saCsrf };
    const C1 = await makeCompetition(sa, saCsrf, "shape-put");
    // The ORIGINAL assignment is made by a USER-BACKED admin, so the row carries
    // a non-null `assigned_by_id`. Made by the built-in superadmin the column is
    // NULL either side of a rewrite, and that half of the snapshot would prove
    // nothing (the built-in account has no actor id).
    const A = await makeAdmin(sa, saCsrf, "assigner");
    const T = await makeTask(A.api, A.csrf, "shape-put");
    const first = await postAssign(A, T.id, [C1.id]);
    expect(first.status(), await first.text()).toBe(200);
    const before = assignmentRow(C1.id, T.id);
    expect(before && before.assigned_by_id, "precondition: the row carries its assigner").toBe(A.id);
    const eventsBefore = assignEvents(C1.id, T.id);
    expect(eventsBefore, "precondition: the assignment was recorded").toBe(1);
    // Let the clock move, so a rewrite of `assigned_at` is visible.
    await new Promise(r => setTimeout(r, 15));

    await expectNamed400(await putDesired(SA, T.id, [[C1.id]], [C1.id]), IDS_SHAPE, "PUT competitionIds [[C1]]");
    await expectNamed400(await putDesired(SA, T.id, [{}], [C1.id]), IDS_SHAPE, "PUT competitionIds [{}]");
    await expectNamed400(await putDesired(SA, T.id, [true], [C1.id]), IDS_SHAPE, "PUT competitionIds [true]");
    // At HEAD these two were a FALSE 409 blaming a colleague, not driver text:
    // a NEW rule (a malformed body is a 400), stated as such.
    await expectNamed400(await putDesired(SA, T.id, [C1.id], [[C1.id]]), EXPECTED_SHAPE, "PUT expectedAssignments [[C1]]");
    await expectNamed400(await putDesired(SA, T.id, [C1.id], [{}]), EXPECTED_SHAPE, "PUT expectedAssignments [{}]");

    expect(assignmentRow(C1.id, T.id), "the row was not deleted and re-inserted: provenance and time unchanged").toEqual(before);
    expect(assignEvents(C1.id, T.id), "no spurious task_removed / task_added pair").toBe(eventsBefore);

    // CONTROL — the well-formed round trip is a true no-op: 200, nothing moved.
    const ok = await putDesired(SA, T.id, [C1.id], [C1.id]);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, added: 0, removed: 0 });
    expect(assignmentRow(C1.id, T.id)).toEqual(before);
  });

  test("an EVENT ADMIN's PUT with a non-string id is the named 400 — the PUT bound it before its scope loop", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const mine = await makeCompetition(sa, saCsrf, "ea-mine");
    const ea = await makeParticipant(sa, saCsrf, "ea-shape");
    await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
    const E = { ...(await apiLogin(ea.email, PARTICIPANT_PASS)) };
    const me = await (await E.api.get("/api/admin/me")).json();
    expect(me.isEventAdmin, "precondition: a real event admin").toBe(true);
    const T = await makeTask(E.api, E.csrf, "ea-shape");
    await expectNamed400(await putDesired(E, T.id, [true], []), IDS_SHAPE, "event admin PUT [true]");
    expect(heldCount(T.id)).toBe(0);
    // CONTROL — their own event, as a string, lands.
    const ok = await putDesired(E, T.id, [mine.id], []);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, added: 1, removed: 0 });
  });

  test("a PUT naming an id that does not exist tells an event admin nothing an out-of-scope id does not", async () => {
    // v8.13.3 — the existence check sat ABOVE the scope check inside the PUT, so
    // an event admin heard "Competition not found: X" for a phantom id and
    // `event_admin_out_of_scope` for a real one that was not theirs: an
    // existence oracle the POST door (scope first) and the bulk door do not offer.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const mine = await makeCompetition(sa, saCsrf, "oracle-mine");
    const theirs = await makeCompetition(sa, saCsrf, "oracle-theirs");
    const ea = await makeParticipant(sa, saCsrf, "ea-oracle");
    await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
    const E = { ...(await apiLogin(ea.email, PARTICIPANT_PASS)) };
    const T = await makeTask(E.api, E.csrf, "ea-oracle");
    const ghost = `no-such-${uniq("event")}`;
    const real = await putDesired(E, T.id, [mine.id, theirs.id], []);
    const phantom = await putDesired(E, T.id, [mine.id, ghost], []);
    const rb = await real.json(), pb = await phantom.json();
    expect(real.status(), JSON.stringify(rb)).toBe(403);
    expect(rb.code, "precondition: an out-of-scope real id is the scope refusal").toBe("event_admin_out_of_scope");
    expect(phantom.status(), JSON.stringify(pb)).toBe(403);
    expect(pb, "a phantom id answers EXACTLY what a real out-of-scope id answers").toEqual(rb);
    expect(heldCount(T.id)).toBe(0);
    // CONTROL — for an unscoped actor nothing is hidden, so the phantom id is
    // still named as not found.
    await expectNamed400(await putDesired({ api: sa, csrf: saCsrf }, T.id, [ghost], []), `Competition not found: ${ghost}`, "superadmin PUT naming no event");
  });

  test("both doors are BOUNDED at BULK_ADMIN_MAX, and the bound is exactly there", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const SA = { api: sa, csrf: saCsrf };
    const C = await makeCompetition(sa, saCsrf, "cap");
    const T = await makeTask(sa, saCsrf, "cap");
    // The POST twin adds exactly what it lists, so its LIST is the change.
    const over = Array(BULK_ADMIN_MAX + 1).fill(C.id);
    await expectNamed400(await postAssign(SA, T.id, over), `Cannot assign a challenge to more than ${BULK_ADMIN_MAX} events in a single request.`, "POST over the cap");
    expect(heldCount(T.id)).toBe(0);
    // The PUT is a DESIRED-STATE door, so its bound is on the CHANGE (the
    // pre-release review): more than BULK_ADMIN_MAX DISTINCT new ids is refused
    // before any of them is looked up…
    const ghosts = Array.from({ length: BULK_ADMIN_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const changeMsg = `Cannot add or remove more than ${BULK_ADMIN_MAX} events in one save.`;
    await expectNamed400(await putDesired(SA, T.id, ghosts, []), changeMsg, "PUT adding more than the cap");
    // …and an expected set far beyond what the challenge holds cannot be what
    // the dialog was shown.
    await expectNamed400(await putDesired(SA, T.id, [C.id], ghosts), "expectedAssignments lists far more events than this challenge is assigned to.", "PUT expectedAssignments far beyond the state");
    expect(heldCount(T.id)).toBe(0);
    // …while REPEATS are one id, on both doors: the list's length is not the cap.
    const okPost = await postAssign(SA, T.id, Array(BULK_ADMIN_MAX).fill(C.id));
    expect(okPost.status(), await okPost.text()).toBe(200);
    expect((await okPost.json()).assigned).toBe(1);
    const repeats = await putDesired(SA, T.id, Array(5 * BULK_ADMIN_MAX).fill(C.id), Array(5 * BULK_ADMIN_MAX).fill(C.id));
    expect(repeats.status(), `a no-op save spelled with repeats is accepted: ${await repeats.text()}`).toBe(200);
    expect(heldCount(T.id)).toBe(1);
  });

  test("a challenge already held by more than BULK_ADMIN_MAX events still saves a one-box change from the dialog", async () => {
    // The pre-release review: the first draft capped the desired-state LIST, so
    // once a challenge was in more than BULK_ADMIN_MAX events — reachable, since
    // the POST twin and the bulk door each bound only one request — every save
    // from the Assign-to-Events dialog (which sends every current assignment
    // back) was refused, a no-op one included. The held assignments are planted
    // directly: building over a thousand events through the API is not the
    // subject, and an upcoming event with no participants is all a row needs.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const SA = { api: sa, csrf: saCsrf };
    const T = await makeTask(sa, saCsrf, "manyheld");
    const C = await makeCompetition(sa, saCsrf, "manyheld-new");
    const N = BULK_ADMIN_MAX + 5;
    const tag = T.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    const ids = Array.from({ length: N }, (_, i) => `held-${tag}-${i}`);
    const start = new Date(Date.now() + 7 * 86_400_000).toISOString();
    withDb(db => {
      const insC = db.prepare("INSERT INTO competitions (id, name, start_time, duration_minutes, created_at) VALUES (?,?,?,?,?)");
      const insT = db.prepare("INSERT INTO competition_tasks (competition_id, task_id, assigned_at) VALUES (?,?,?)");
      db.transaction(() => { for (const id of ids) { insC.run(id, `Held ${id}`, start, 60, start); insT.run(id, T.id, start); } })();
    }, { readonly: false });
    expect(heldCount(T.id), "PRECONDITION: the challenge is held by more than the cap").toBe(N);
    // The dialog's save: every held event back, plus one newly ticked.
    const add = await putDesired(SA, T.id, [...ids, C.id], ids);
    expect(add.status(), `ticking one box on a challenge held by ${N} events: ${await add.text()}`).toBe(200);
    expect(held(C.id, T.id)).toBe(true);
    // And unticking one.
    const drop = await putDesired(SA, T.id, ids.slice(1).concat(C.id), [...ids, C.id]);
    expect(drop.status(), `unticking one box: ${await drop.text()}`).toBe(200);
    expect(heldCount(T.id)).toBe(N);
    expect(held(ids[0], T.id)).toBe(false);
    // The bound is on the CHANGE in BOTH directions: unticking more than
    // BULK_ADMIN_MAX boxes in one save is refused, and nothing moves.
    const mass = await putDesired(SA, T.id, [C.id], ids.slice(1).concat(C.id));
    await expectNamed400(mass, `Cannot add or remove more than ${BULK_ADMIN_MAX} events in one save.`, "PUT removing more than the cap");
    expect(heldCount(T.id), "a refused mass removal removes nothing").toBe(N);
  });
});

test.describe("v8.13.3 — a nested competition id no longer slips past the staff-compete competitor lock", () => {
  test("a competing admin is refused the string form AND the nested form; the challenge stays out of their event", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    // E: a LIVE event where staff compete. A compete event admits only SEALED
    // challenges whose author does not compete there, so the challenge is
    // authored by S, a user-backed admin who is NOT enrolled.
    const E = await makeCompetition(sa, saCsrf, "compete-live", { staff_compete: true });
    const S = await makeAdmin(sa, saCsrf, "author");
    const T = await makeTask(S.api, S.csrf, "sealed", { answer_sealed: true, hint: "h", correct_answer: "k" });
    // A: a user-backed admin holding a row on E — a COMPETITOR there.
    const A = await makeAdmin(sa, saCsrf, "competitor", "admin", { enrolIn: [E.id] });

    // CONTROL and precondition in one: the string form is the competitor lock.
    const plain = await postAssign(A, T.id, [E.id]);
    const pb = await plain.json();
    expect(plain.status(), JSON.stringify(pb)).toBe(403);
    expect(pb.code, "precondition: A really competes in E").toBe("competitor_cannot_edit");

    // THE BYPASS: at HEAD this answered 200 {assigned:1}.
    await expectNamed400(await postAssign(A, T.id, [[E.id]]), IDS_SHAPE, "competitor POST [[E]]");
    await expectNamed400(await postAssign(A, T.id, [{}]), IDS_SHAPE, "competitor POST [{}]");
    // …and through a urlencoded body, which the extended parser turns into the
    // same nested array (the bypass was not JSON-only).
    const form = await A.api.post(`/api/admin/tasks/${T.id}/competitions`, {
      headers: { "x-csrf-token": A.csrf }, form: { "competitionIds[0][0]": E.id },
    });
    await expectNamed400(form, IDS_SHAPE, "competitor POST urlencoded competitionIds[0][0]");
    // The PUT twin (its in-transaction re-ask already flattened the id through
    // SQL and refused; it is a named 400 now).
    await expectNamed400(await putDesired(A, T.id, [[E.id]], []), IDS_SHAPE, "competitor PUT [[E]]");
    expect(held(E.id, T.id), "the challenge was NOT added to the competitor's own event").toBe(false);

    // CONTROL — the challenge IS assignable to E (sealed, author not competing):
    // the built-in superadmin, who can never be a competitor, assigns it. So the
    // refusals above are the shape check, not a seal or fit refusal in disguise.
    const ok = await postAssign({ api: sa, csrf: saCsrf }, T.id, [E.id]);
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).assigned).toBe(1);
    expect(held(E.id, T.id)).toBe(true);
  });
});

test.describe("v8.13.3 — POST :id/restore: versionId must be text", () => {
  test("a one-element array no longer PERFORMS the restore; every other shape is a 400, not a 500", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const T = await makeTask(sa, saCsrf, "restore");
    // Two edits, so the EARLIEST version's title differs from the current one
    // whichever side of an edit a snapshot is taken on.
    for (const title of [`R2 ${uniq("t")}`, `R3 ${uniq("t")}`]) {
      const e = await sa.put(`/api/admin/tasks/${T.id}`, { headers: H(saCsrf), data: { title } });
      expect(e.ok(), `edit: ${e.status()} ${await e.text()}`).toBeTruthy();
    }
    const v1 = dbGet("SELECT id, snapshot FROM task_versions WHERE task_id=? ORDER BY version_num ASC LIMIT 1", T.id);
    expect(v1, "precondition: a version exists").toBeTruthy();
    const v1Title = JSON.parse(v1.snapshot).title;
    const before = taskRow(T.id);
    expect(v1Title, "precondition: restoring v1 would change the title").not.toBe(before.title);

    const restore = data => sa.post(`/api/admin/tasks/${T.id}/restore`, { headers: H(saCsrf), data });
    // FIRST, the shape that restored at HEAD.
    await expectNamed400(await restore({ versionId: [v1.id] }), "versionId must be text", "versionId [v1]");
    expect(taskRow(T.id), "the one-element array restored nothing").toEqual(before);
    for (const bad of [{}, [v1.id, v1.id], true, 7]) {
      await expectNamed400(await restore({ versionId: bad }), "versionId must be text", `versionId ${JSON.stringify(bad)}`);
    }
    expect(taskRow(T.id)).toEqual(before);

    // CONTROLS — an absent versionId keeps its 404 (with a body, and with none
    // at all), and the string form really restores.
    const absent = await restore({});
    expect(absent.status(), await absent.text()).toBe(404);
    const bodyless = await sa.post(`/api/admin/tasks/${T.id}/restore`, { headers: { "x-csrf-token": saCsrf } });
    expect(bodyless.status(), `a body-less POST: ${await bodyless.text()}`).toBe(404);
    const ok = await restore({ versionId: v1.id });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(taskRow(T.id).title, "the string form restored v1").toBe(v1Title);
  });
});

test.describe("v8.13.3 — attachment_url must be text on challenge create and edit", () => {
  const BAD = [["https://a.example/x", "https://b.example/y"], [["https://n.example"]], ["https://x.example"], { a: 1 }, false, 0];

  test("POST /api/admin/tasks — every non-string shape is the named 400 and creates nothing", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const prefix = `AttUrl ${uniq("p")}`;
    for (const bad of BAD) {
      const r = await sa.post("/api/admin/tasks", {
        headers: H(saCsrf),
        data: { title: `${prefix} ${JSON.stringify(bad)}`, difficulty: "easy", answer_type: "text", correct_answer: "a", attachment_url: bad },
      });
      await expectNamed400(r, "attachment_url must be text", `create attachment_url ${JSON.stringify(bad)}`);
    }
    expect(dbGet("SELECT COUNT(*) c FROM tasks WHERE title LIKE ?", `${prefix}%`).c, "no challenge was created").toBe(0);
    // CONTROL — a string URL is stored as given.
    const ok = await sa.post("/api/admin/tasks", {
      headers: H(saCsrf),
      data: { title: `${prefix} ok`, difficulty: "easy", answer_type: "text", correct_answer: "a", attachment_url: "https://ok.example/file.zip" },
    });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(taskRow((await ok.json()).id).attachment_url).toBe("https://ok.example/file.zip");
  });

  test("PUT /api/admin/tasks/:id — no non-string shape can CLEAR the stored URL any more", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const URL1 = "https://first.example/a.zip";
    const T = await makeTask(sa, saCsrf, "att-edit", { attachment_url: URL1 });
    expect(taskRow(T.id).attachment_url, "precondition: the URL is stored").toBe(URL1);
    const edit = attachment_url => sa.put(`/api/admin/tasks/${T.id}`, { headers: H(saCsrf), data: { attachment_url } });
    // `{}`, `[]`, `false` and `0` answered 200 at HEAD and stored "" — the
    // DATA-LOSS shapes, so they go FIRST and the stored value is asserted BEFORE
    // the status: with the guard gone the first failure names the cleared URL,
    // not merely a wrong status code.
    for (const bad of [{}, [], false, 0, ...BAD]) {
      const r = await edit(bad);
      expect(taskRow(T.id).attachment_url, `edit ${JSON.stringify(bad)} left the stored URL alone (answered ${r.status()})`).toBe(URL1);
      await expectNamed400(r, "attachment_url must be text", `edit attachment_url ${JSON.stringify(bad)}`);
    }
    // CONTROL — a string edit really changes it, so the refusals are not a
    // route that ignores the field.
    const URL2 = "https://second.example/b.zip";
    const ok = await edit(URL2);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(taskRow(T.id).attachment_url).toBe(URL2);
  });
});
