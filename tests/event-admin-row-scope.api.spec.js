"use strict";

// v8.8.4 — SCOPING THE ROWS, NOT ONLY THE ENTITY.
//
// The sibling-surface sweep of the event-admin challenge-visibility rule found
// two routes gated on ONE of the two questions their response asks. Each was
// confirmed by more than one lens and reproduced against a real server:
//
//   * GET /api/admin/tasks/:id/feedback — taskViewDenied answers "may you open
//     this challenge". The rows carry each rater's name, nickname and EMAIL, and
//     task_feedback has no competition_id, so the join was unfiltered over the
//     whole users table. Through the shared pool — a challenge EVERY event admin
//     can see by design — this reached raters enrolled only in other organisers'
//     events. The route's own comment named the risk and closed only half of it.
//
//   * GET /api/admin/participants/:id/events — participantDenied answers "may you
//     see this participant". Once it passed, their whole cross-event history came
//     back: hint_revealed / feedback_submitted / attempt_grant carry task_title
//     and task_id, first_joined and added_to_competition carry competition_name.
//     It is the DEFAULT primary button on every participant row, and it
//     contradicted ROLES §6, whose sibling `competitions` column IS narrowed.
//
// WHY A SUPERADMIN CONTROL SITS BESIDE EVERY ASSERTION: "the event admin did not
// see it" is equally true of a build that returns nothing, of a broken fixture,
// and of a row that was never written. The control proves the row exists and is
// reachable by somebody, so the narrowing is the thing being measured.

const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { H, buildWorld, makeTask, enrol, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

test.describe("v8.8.4 — an event admin sees rows about their own events only", () => {
  /** @type {any} */ let w;
  let pdTask, mineRater, theirsRater, dual;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();

    // A shared-pool challenge: visible to EVERY event admin by design, which is
    // what makes the feedback leak reachable with no special state at all.
    pdTask = await makeTask(w.sa, w.saCsrf, "pdfeedback");
    const tagR = await w.sa.post(`/api/admin/tasks/${pdTask.id}/tags`, {
      headers: H(w.saCsrf), data: { tag: "public-domain" },
    });
    expect(tagR.ok(), `tag: ${tagR.status()} ${await tagR.text()}`).toBeTruthy();

    mineRater = w.inMine;      // enrolled in the event the actor organises
    theirsRater = w.inTheirs;  // enrolled ONLY in the event they do not

    // The feedback rows are planted directly. The defect is in the READ, and the
    // participant-side write needs a live competition context per rater — which
    // would test the submit path, not the scoping. Planting keeps the subject
    // exactly the join this fix narrowed.
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const db = new Database(TEST_DB_PATH);
    try {
      const ins = db.prepare("INSERT OR REPLACE INTO task_feedback (user_id, task_id, rating, updated_at) VALUES (?,?,?,?)");
      ins.run(mineRater.id, pdTask.id, 5, new Date().toISOString());
      ins.run(theirsRater.id, pdTask.id, 4, new Date().toISOString());
    } finally { db.close(); }

    // A participant enrolled in BOTH events — the ordinary shape the role exists
    // for, and the only fixture that can tell a narrowed history from an empty
    // one. Each enrolment writes a REAL added_to_competition row carrying its own
    // competition_id, so nothing about the history assertions is synthetic.
    const reg = await w.sa.post("/api/admin/participants/desk-invite", {
      headers: H(w.saCsrf),
      data: { email: `dual${uniq("d")}@acme.com`, firstName: "Dual", lastName: "Enrolled", nickname: `dual${uniq("n")}` },
    });
    expect(reg.ok(), `desk-invite: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    dual = await reg.json();
    dual.id = dual.id || dual.user?.id;
    await enrol(w.sa, w.saCsrf, w.mine.id, [dual.id]);
    await enrol(w.sa, w.saCsrf, w.theirs.id, [dual.id]);
  });

  // ── the feedback route ─────────────────────────────────────────────────────

  test("challenge feedback shows only raters the actor may see", async () => {
    const r = await w.eaApi.get(`/api/admin/tasks/${pdTask.id}/feedback`);
    expect(r.ok(), `feedback: ${r.status()} ${await r.text()}`).toBeTruthy();
    const rows = await r.json();
    const ids = rows.map(x => x.user_id);

    expect(ids, "a rater enrolled in the event they organise IS shown").toContain(mineRater.id);
    expect(ids, "a rater enrolled only in an event they do NOT organise is not")
      .not.toContain(theirsRater.id);

    // By VALUE as well as by id: the leak was an email address, so assert the
    // address itself appears nowhere in the serialised payload. A key-name check
    // would pass on a build that folded it into another field.
    expect(JSON.stringify(rows), "the out-of-scope rater's email does not appear at all")
      .not.toContain(theirsRater.email);
  });

  test("CONTROL — a superadmin sees BOTH raters, so the fixture is real", async () => {
    const r = await w.sa.get(`/api/admin/tasks/${pdTask.id}/feedback`);
    expect(r.ok()).toBeTruthy();
    const ids = (await r.json()).map(x => x.user_id);
    expect(ids, "both feedback rows exist and are reachable").toEqual(
      expect.arrayContaining([mineRater.id, theirsRater.id]));
  });

  test("CONTROL — a ZERO-GRANT event admin sees the shared challenge and NO raters", async () => {
    // The actor the design says must see least, and the sharpest form of the leak:
    // the shared pool is visible to them by construction, so before the fix the
    // whole rater directory was one request away.
    const vis = await w.zeroApi.get("/api/admin/tasks");
    expect((await vis.json()).map(t => t.id), "PRECONDITION — the shared challenge IS visible to them")
      .toContain(pdTask.id);
    const r = await w.zeroApi.get(`/api/admin/tasks/${pdTask.id}/feedback`);
    expect(r.ok(), `feedback: ${r.status()}`).toBeTruthy();
    expect(await r.json(), "an empty scope matches no rater").toEqual([]);
  });

  // ── the participant history ────────────────────────────────────────────────

  test("a participant's history names the actor's own events, not the others", async () => {
    const r = await w.eaApi.get(`/api/admin/participants/${dual.id}/events?paginated=1&limit=200`);
    expect(r.ok(), `history: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const blob = JSON.stringify(body);

    expect(blob, "the event they organise is named").toContain(w.mine.id);
    expect(blob, "the event they do NOT organise is not").not.toContain(w.theirs.id);
    expect(blob, "…nor by name").not.toContain(w.theirs.name);

    // `total` must agree with the page, or the count describes rows the caller
    // never receives — which is why the filter is in SQL and not applied after.
    expect(body.total, "the count is over the narrowed set").toBe(body.events.length);
  });

  test("account-lifecycle rows are still shown — the admit is deliberate", async () => {
    // A row with no competition_id is about the ACCOUNT, not about any event, and
    // is exactly what an organiser opens this dialog for. Withholding it would
    // trade a leak for a blind spot, so the fix must not be "hide everything".
    const r = await w.eaApi.get(`/api/admin/participants/${dual.id}/events?paginated=1&limit=200`);
    const body = await r.json();
    const types = body.events.map(e => e.event_type);
    expect(types.length, "the history is not empty").toBeGreaterThan(0);
    expect(types.some(t => !/competition|timeslot/i.test(t)),
      "at least one account-level row survives the narrowing").toBe(true);
  });

  test("CONTROL — a superadmin sees BOTH events in the same history", async () => {
    const r = await w.sa.get(`/api/admin/participants/${dual.id}/events?paginated=1&limit=200`);
    expect(r.ok()).toBeTruthy();
    const blob = JSON.stringify(await r.json());
    expect(blob, "the row for the other event exists and is reachable").toContain(w.theirs.id);
    expect(blob, "…as does the row for theirs").toContain(w.mine.id);
  });
});
