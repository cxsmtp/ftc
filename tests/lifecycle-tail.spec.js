// v8.1.7 — two lifecycle defects that misattribute or fail open.
//
// #40  A session ended by an OPERATOR shrinking its duration into the past was
//      recorded as the clock's doing. The timeslot PUT lacked the shrink-to-past
//      detector its competition-level twin gained in v6.16.6, so `ended_at`
//      stayed NULL, `ended_manually` stayed 0, and the scheduler's next tick
//      emitted a system-attributed `auto_ended` — the deliberate decision
//      survived only as an `edited` event, and every surface downstream then
//      described the session as having ended when its scheduled time elapsed.
//
// #41  The submit transaction's ended re-check tests `freshStatus === "ended"`,
//      and `competitionStatus(null)` returns null — so a competition that had
//      gone away fell THROUGH the guard rather than into it. See the source
//      lock at the bottom for exactly what this file does and does not cover
//      there; it is deliberately not claimed as behaviourally reachable.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");

const Database = require("better-sqlite3");
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const iso = (ms) => new Date(ms).toISOString();
const TAG = `lt${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// Read-only probes. The events tables and `entity_status_observations` have no
// admin endpoint that carries the actor + details in one shape, and after a
// competition delete there is by definition no API left to ask — so these read
// the database directly, the way the sibling scheduler locks do
// (tests/schedule-arithmetic.spec.js).
function dbRead(fn) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const slotRow = (tsId) => dbRead(d => d.prepare("SELECT ended_at, ended_manually FROM competition_timeslots WHERE id=?").get(tsId));
const slotEvents = (tsId, type) => dbRead(d =>
  d.prepare("SELECT changed_by, details FROM timeslot_events WHERE timeslot_id=? AND event_type=? ORDER BY changed_at").all(tsId, type));
const observed = (tsId) => dbRead(d =>
  d.prepare("SELECT last_status FROM entity_status_observations WHERE entity_type='timeslot' AND entity_id=?").get(tsId));

async function makeCompWithLiveSlot(api, csrf, { slotStartMs, slotMinutes }) {
  // The PARENT stays comfortably live: a competition-level end would end the
  // session for a reason that is not the one under test.
  const c = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `${uniq()} Ev`, timezone: "UTC", start_time: iso(Date.now() - 3 * 3600e3), duration_minutes: 600 },
  });
  expect(c.ok(), `create competition: ${c.status()} ${await c.text()}`).toBeTruthy();
  const compId = (await c.json()).competition.id;

  const t = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
    headers: H(csrf),
    data: { name: `${uniq()} Slot`, timezone: "UTC", start_time: iso(slotStartMs), duration_minutes: slotMinutes },
  });
  expect(t.ok(), `create session: ${t.status()} ${await t.text()}`).toBeTruthy();
  const ts = (await t.json()).timeslot;
  expect(ts.status, "precondition: the session is LIVE before anything acts on it").toBe("live");
  return { compId, tsId: ts.id, updatedAt: ts.updated_at };
}

const tick = async (api, csrf) => {
  const r = await api.post("/api/test/scheduler-tick", { headers: H(csrf), data: {} });
  expect(r.ok(), `scheduler tick: ${r.status()} ${await r.text()}`).toBeTruthy();
};

test.describe("v8.1.7 — a deliberate end is not recorded as the clock's doing", () => {
  test("shrinking a LIVE session into the past is stamped as a MANUAL end, and the scheduler cannot claim it", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // Started 90 minutes ago and running for 10 hours, so a duration of 1
      // minute puts the scheduled end 89 minutes in the past.
      const { compId, tsId, updatedAt } = await makeCompWithLiveSlot(api, csrf, { slotStartMs: Date.now() - 90 * 60e3, slotMinutes: 600 });

      // OBSERVE IT AS LIVE FIRST. The scheduler `continue`s on a FIRST sighting
      // without emitting anything, so without this tick the "no auto_ended"
      // assertion below would hold for a reason that has nothing to do with the
      // fix — the transition would never be seen at all.
      await tick(api, csrf);
      expect(observed(tsId)?.last_status, "precondition: the scheduler has seen this session LIVE").toBe("live");

      const put = await api.put(`/api/admin/competitions/${compId}/timeslots/${tsId}`, {
        headers: H(csrf), data: { duration_minutes: 1, expectedUpdatedAt: updatedAt },
      });
      expect(put.ok(), `shrink: ${put.status()} ${await put.text()}`).toBeTruthy();
      expect((await put.json()).timeslot.status, "the shrink really ended it").toBe("ended");

      // The attribution itself.
      const row = slotRow(tsId);
      expect(row.ended_at, "an operator-ended session carries an ended_at").toBeTruthy();
      expect(row.ended_manually, "…and is marked as ENDED MANUALLY, like /end-now and the competition twin").toBe(1);

      const manual = slotEvents(tsId, "ended_manually");
      expect(manual.length, "exactly one manual-end event").toBe(1);
      expect(manual[0].changed_by, "attributed to the acting admin, not to `system`").toBe("superadmin");
      const d = JSON.parse(manual[0].details);
      expect(d.via, "the discriminator that separates a shrink-to-end from /end-now").toBe("duration_shrink");
      expect(d.duration_minutes, "…and records the duration that ended it").toBe(1);
      expect(d.ip, "user-driven events carry reqContext").toBeTruthy();

      // AND THE PAYOFF: the next tick sees live→ended and must NOT claim it.
      await tick(api, csrf);
      expect(slotEvents(tsId, "auto_ended").length,
        "the scheduler re-reads ended_manually before emitting, so a stamped session is never reported as auto-ended").toBe(0);
    } finally { await api.dispose(); }

    // Mutations this catches: the detector removed entirely (no ended_at, no
    // ended_manually event, and the tick emits `auto_ended`); the emit dropped
    // while the UPDATE stays (no attribution, though the scheduler is silenced);
    // `via` renamed or `ended_manually=0` written (the audit no longer separates
    // a shrink from the clock).
  });

  test("POSITIVE CONTROL — a session that ends by the CLOCK alone is still recorded as an automatic end", async () => {
    // Without this, "the shrunk session was not auto-ended" is equally satisfied
    // by a build in which nothing is ever auto-ended, or in which every ended
    // session is stamped manual.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const startMs = Date.now() - 90 * 60e3;
      const { tsId } = await makeCompWithLiveSlot(api, csrf, { slotStartMs: startMs, slotMinutes: 600 });
      await tick(api, csrf);
      expect(observed(tsId)?.last_status, "precondition: seen LIVE, same as the test above").toBe("live");

      // Expire it WITHOUT going through the PUT — the PUT is the thing under
      // test, so using it here would make the control a copy of the defect.
      {
        const db = new Database(TEST_DB_PATH);
        try { db.prepare("UPDATE competition_timeslots SET duration_minutes=1 WHERE id=?").run(tsId); }
        finally { db.close(); }
      }

      await tick(api, csrf);
      const auto = dbRead(d => d.prepare(
        "SELECT changed_by, details FROM timeslot_events WHERE timeslot_id=? AND event_type='auto_ended'").all(tsId));
      expect(auto.length, "a genuinely time-expired session IS auto-ended by the tick").toBe(1);
      expect(auto[0].changed_by, "and it is system-attributed — nobody decided this").toBe("system");
      expect(JSON.parse(auto[0].details).scheduled_end, "carrying the end the clock actually reached")
        .toBe(iso(new Date(startMs).getTime() + 60e3));

      // The row is untouched: time-derived status leaves ended_at NULL, which is
      // exactly the state the detector must NOT manufacture for a clock end.
      const row = slotRow(tsId);
      expect(row.ended_at, "a clock end stamps no ended_at").toBeNull();
      expect(row.ended_manually, "…and claims no operator").toBe(0);

      expect(slotEvents(tsId, "ended_manually").length, "and no manual-end event was invented").toBe(0);
    } finally { await api.dispose(); }

    // Mutation this catches: a detector that fires regardless of HOW the end
    // arrived (e.g. keyed on the status rather than on a duration change), which
    // would stamp this session manual and silence its `auto_ended`.
  });
});

test.describe("v8.1.7 — a submission is never graded into a competition that has gone away", () => {
  test("a competition deleted during the upload window refuses the submission and writes no row", async () => {
    // WHAT THIS COVERS, precisely, because the two are not the same thing:
    //
    //   COVERED — end to end, the participant is refused and NO `submissions`
    //   row survives for a competition that no longer exists. That orphan is the
    //   observable harm in the finding: `submissions.competition_id` has no
    //   foreign key, so a row written after the delete's own explicit purge would
    //   outlive the competition for ever.
    //
    //   NOT COVERED — the `!freshComp` guard inside the write transaction. The
    //   delete purges `competition_tasks` in the same transaction, so the file
    //   path's post-read assignment re-check answers 404 first, and there is no
    //   await between it and the transaction for a delete to land in. That guard
    //   is defence in depth and is pinned at SOURCE below instead. Do not "fix"
    //   this test by asserting the guard's status code — it is not the net that
    //   answers here.
    const { api, csrf } = await apiLogin("superadmin");
    let taskId, pctx = null;
    try {
      const c = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${uniq()} Vanish`, timezone: "UTC", start_time: iso(Date.now() - 3600e3), duration_minutes: 600 },
      });
      expect(c.ok(), `create competition: ${await c.text()}`).toBeTruthy();
      const compId = (await c.json()).competition.id;

      const t = await api.post("/api/admin/tasks", {
        headers: H(csrf),
        data: {
          title: `${uniq()} FileQ`, description: "<p>x</p>", difficulty: "easy",
          answer_type: "file", correct_answer: "right-answer", explanation: "<p>x</p>",
          hint: "h", status: "published",
        },
      });
      expect(t.ok(), `create challenge: ${await t.text()}`).toBeTruthy();
      taskId = (await t.json()).id;
      const asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: H(csrf), data: { competitionIds: [compId] },
      });
      expect(asg.ok(), `assign challenge: ${await asg.text()}`).toBeTruthy();

      // Own the participant (never authenticate as a shared seeded fixture).
      const email = `${uniq()}@company.example`;
      const { api: anon, csrf: ac } = await freshCtx();
      const reg = await registerPost(anon, "/api/register", {
        headers: H(ac),
        data: {
          firstName: "Vanish", lastName: "Tester", nickname: uniq(), email,
          company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
          password: PARTICIPANT_PASS,
        },
      });
      expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
      await anon.dispose();
      const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
        .participants.find(p => p.email === email);
      expect(u, "the participant exists after registration").toBeTruthy();
      expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
      expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
      const assign = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { competitionIds: [compId], userIds: [u.id] },
      });
      // The assign endpoint SKIPS ineligible users silently, so assert the count
      // rather than the status — a skip would surface later as an unrelated 403.
      expect((await assign.json()).assigned, "precondition: the participant really is enrolled").toBe(1);

      const { api: p, csrf: c0 } = await freshCtx();
      pctx = p;
      const li = await codeLogin(p, email, H(c0));
      expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
      const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;
      expect((await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } })).ok(),
        "precondition: the participant is in the competition").toBeTruthy();
      const gradingHash = await gradingHashFor(p, taskId);
      expect(gradingHash, "the grading token is REQUIRED on submit").toBeTruthy();

      // Park the submit inside the file-read window. Without the hook the read
      // finishes in well under a millisecond and no admin write could land in it.
      expect((await api.post("/api/test/submit-read-delay", { headers: H(csrf), data: { delayMs: 2000 } })).ok()).toBeTruthy();
      const submitting = p.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": pc },
        multipart: {
          file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("right-answer") },
          gradingHash,
        },
      });
      await new Promise(r => setTimeout(r, 400));   // inside the window

      // The delete refuses a LIVE competition, so an operator reaching this
      // state ends it first — which is exactly why the transaction's `=== ended`
      // re-check is the guard that SHOULD have caught the vanished row.
      const end = await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) });
      expect(end.ok(), `end-now during the upload window: ${await end.text()}`).toBeTruthy();
      const del = await api.delete(`/api/admin/competitions/${compId}`, { headers: H(csrf) });
      expect(del.ok(), `delete during the upload window: ${del.status()} ${await del.text()}`).toBeTruthy();

      const r = await submitting;
      expect(r.ok(), `a submission into a deleted competition must be refused: ${r.status()} ${await r.text()}`).toBeFalsy();
      const body = await r.json().catch(() => ({}));
      expect(body.correct, "and it must not be graded").toBeFalsy();

      // The point of the finding: no orphan row for a competition that is gone.
      const rows = dbRead(d => d.prepare("SELECT COUNT(*) AS c FROM submissions WHERE task_id=?").get(taskId).c);
      expect(rows, "a refused submission writes nothing — and nothing outlives the competition").toBe(0);
    } finally {
      // The knob is process-global and does NOT auto-reset, so leaving it set
      // would slow every later file submit on this worker. Reset it with its own
      // client, so a failure that already disposed `api` still clears it.
      const { api: reset, csrf: rc } = await apiLogin("superadmin");
      await reset.post("/api/test/submit-read-delay", { headers: H(rc), data: { delayMs: 0 } }).catch(() => {});
      await reset.dispose();
      if (pctx) await pctx.dispose().catch(() => {});
      await api.dispose();
    }

    // Mutation this catches: the post-read assignment re-check removed (v7.15.13)
    // — the submit then grades against the pre-read snapshot and INSERTs an
    // orphan row for a competition that no longer exists.
  });

  test("the write transaction refuses a VANISHED competition rather than reading it as `not ended`", () => {
    // A SOURCE lock, and the reason is stated rather than left to be discovered:
    // the two 404 nets above answer first and there is no await between the last
    // of them and this transaction, so the guard cannot be reached from outside
    // today. It is still the difference between a fail-open and a fail-closed on
    // the one path that WRITES, and the shape it insures against — a future
    // refactor moving or removing a net — would restore the reachability
    // silently. Precedent: the v7.21.15 CxOne source lock, for the same reason.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    const startIdx = src.indexOf('app.post("/api/tasks/:id/submit"');
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf('require("./routes/leaderboard")', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);

    const guardIdx = body.search(/if\s*\(\s*!freshComp\s*\)\s*return\s*\{\s*compGone:\s*true\s*\}/);
    expect(guardIdx, "the write transaction tests freshComp before it tests its status").toBeGreaterThan(-1);
    // v8.6.0 — the ended test grew a late-entry clause (`&& !(...)`), so the regex
    // no longer requires a closing paren straight after the comparison. What this
    // lock is about is the ORDER of two guards, not the shape of the second one.
    const endedIdx = body.search(/if\s*\(\s*freshStatus\s*===\s*"ended"/);
    expect(endedIdx, "…and the ended re-check is still there").toBeGreaterThan(-1);
    // ORDER is the property. `competitionStatus(null)` returns null, so a guard
    // placed after the status test is one the status test has already sailed past.
    expect(guardIdx, "the vanished-competition guard must precede the ended test").toBeLessThan(endedIdx);

    // Its own outcome tag: the perf span asserts by PRESENCE, so a terminal
    // branch shipping under a neighbour's tag would attribute this refusal to
    // "the event has ended" in the one record an operator reads afterwards.
    expect(body, "the refusal carries its own perf-span outcome").toMatch(/outcome\s*=\s*"competition_gone"/);
    expect(body, "…and answers 404, the same shape requireCompetitionContext already uses")
      .toMatch(/compGone[\s\S]{0,200}res\.status\(404\)/);
  });
});
