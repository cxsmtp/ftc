// @ts-check
//
// v8.7.7 — THE ASSIGN-TO-EVENTS DIALOG, AS AN EVENT ADMIN.
//
// Reported: "I logged in as an event admin and then tried to remove a challenge
// from a live event of which I'm the admin. It refused saying 'you're not an
// organiser of this event blah blah' and referred to a DIFFERENT event."
//
// THE CHAIN THAT PRODUCED IT:
//
//   1. GET /api/admin/competitions is SCOPED — an event admin sees only their own
//      events, so the dialog renders a checkbox for those alone.
//   2. GET /api/admin/tasks is NOT — each row's `competitions[]` is built from an
//      unfiltered `competitions JOIN competition_tasks`, so it names EVERY event
//      holding the challenge. The dialog computes `assignedIds` and
//      `expectedAssignments` from THAT.
//   3. `saveTaskCompAssignments` submitted `competitionIds` = (ticked, in-scope) +
//      (currently-assigned ENDED events, re-appended from `endedIds`). An event
//      outside the actor's scope was in NEITHER bucket — and `endedIds` could not
//      rescue an out-of-scope ended one either, being itself derived from the
//      narrowed list — so every such assignment vanished from the desired set.
//   4. PUT computes `toRemoveIds = currentSet \ desiredSet`, so those invisible
//      events read as REMOVALS THE ADMIN NEVER REQUESTED, and taskUnassignDenied
//      → competitionDenied refused the WHOLE request, appending that event's name.
//
// It was a total lockout of the dialog, not merely of removal: `toRemoveIds` is
// computed before anything the admin ticked is consulted, so a PURE ADD and even
// an unchanged NO-OP save were refused too.
//
// THE FIX IS CLIENT-SIDE AND THE SERVER IS UNCHANGED. The dialog now preserves
// every currently-assigned event it did not RENDER — keyed on what was drawn
// rather than on why a row was dropped, so it subsumes the ended case and cannot
// miss a third reason invented later. That is v7.20.10's rule for the sibling
// bulk picker, THE BASELINE IS `assigned ∩ LISTED` never `assigned`, which this
// dialog never learned.
//
// WHAT THIS FILE CAN AND CANNOT LOCK. It replays what the fixed client puts on
// the wire, so it pins the SERVER CONTRACT the fix depends on. It cannot catch a
// regression in the client itself — reverting challenges-admin.js leaves every
// test here green. The client half is locked in tests/event-admin-assign-dialog.spec.js,
// which drives the real dialog in a browser. Both halves are required.
//
// Every refusal READS THE ROW BACK as the superadmin, because a 403 is not a
// rollback: a build that refuses loudly and writes anyway is byte-identical from
// the status code alone. Every positive arm reads back too — a 200 is not a write
// either, and accept-and-ignore is a control that appears to work.

const { test, expect } = require("./isolated-test");
const {
  H, makeCompetition, makeTask, assignTask, grantEventAdmin, buildWorld, expectRefused,
} = require("./event-admin-helpers");

/** The exact sentence `competitionDenied` produces (lib/event-admin.js). */
const OUT_OF_SCOPE = "You are not an organiser of this event. Ask an administrator to add you to it.";

/** The assigned competition ids for a task, read as the SUPERADMIN (unnarrowed). */
/**
 * What the ACTOR's own dialog was given, which since v8.8.8 is the narrowed set.
 *
 * `task.competitions` is scoped per viewer now, so a payload assembled from the
 * SUPERADMIN's view models a client that cannot exist and is refused — correctly
 * — by the scope guard. Every arm below that stands in for the real dialog reads
 * this; the arms that deliberately hand-roll an out-of-scope request keep reading
 * the superadmin's, because forging one is their entire subject.
 */
async function assignedIdsAsActor(api, taskId) {
  const r = await api.get("/api/admin/tasks");
  expect(r.ok(), `tasks list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the task must be findable in this actor's list").toBeTruthy();
  return new Set((row.competitions || []).map(c => c.id));
}

async function assignedIdsAsSuperadmin(sa, taskId) {
  const r = await sa.get("/api/admin/tasks");
  expect(r.ok(), `tasks list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the task must be findable in the superadmin's list").toBeTruthy();
  return new Set((row.competitions || []).map(c => c.id));
}

/**
 * Exactly what the FIXED `saveTaskCompAssignments` puts on the wire.
 *
 * `rendered` is the set the dialog drew checkboxes for (non-ended, in scope);
 * `ticked` is what the admin left ticked among those; `assigned` is the task's
 * full current set as the row reports it. The preserved arm is the fix.
 */
function dialogPayload({ rendered, ticked, assigned }) {
  const preserved = [...assigned].filter(id => !rendered.has(id));
  return {
    competitionIds: [...new Set([...ticked, ...preserved])],
    expectedAssignments: [...assigned],
  };
}

function putAssign(api, csrf, taskId, body) {
  return api.put(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: body });
}

test.describe("v8.7.7 — the assign-to-events dialog, as an event admin", () => {
  /** @type {any} */ let w;
  let alsoMine;      // a SECOND event they run, so the ADD arm is a real add
  let rendered;      // what the dialog draws: their non-ended events

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    w = await buildWorld();
    // Granted AFTER buildWorld, which asserts a count of exactly 1.
    alsoMine = await makeCompetition(w.sa, w.saCsrf, "alsomine");
    await grantEventAdmin(w.sa, w.saCsrf, alsoMine.id, w.ea.id);
    // PRECONDITION asserted, not assumed — and it forces a live read past the
    // TTL cache on `eventAdminCompetitionIds`.
    const me = await (await w.eaApi.get("/api/admin/me")).json();
    expect(me.eventAdminCompetitionCount, "the event admin now runs two events").toBe(2);
    rendered = new Set([w.mine.id, alsoMine.id]);
  });

  /**
   * A challenge shared between an event they run and one they do not — the
   * ordinary case for a shared challenge bank, and the precondition for the bug.
   *
   * Created and assigned to `mine` BY THE EVENT ADMIN, so
   * `competition_tasks.assigned_by_id` names them and the provenance arm of
   * taskUnassignDenied permits the removal they actually asked for. That is what
   * made the refusal name the OTHER event rather than their own.
   *
   * Each test builds its own (the fixture checklist's rule), so these tests are
   * independent and a failure is about the dialog rather than about what ran before.
   */
  async function sharedTask(label) {
    const t = await makeTask(w.eaApi, w.eaCsrf, label);
    await assignTask(w.eaApi, w.eaCsrf, t.id, [w.mine.id]);
    await assignTask(w.sa, w.saCsrf, t.id, [w.theirs.id]);
    const current = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect([...current].sort(), `fixture ${label}: the challenge is in BOTH events`)
      .toEqual([w.mine.id, w.theirs.id].sort());
    return t;
  }

  // ── the precondition the fix rests on ────────────────────────────────────

  test("the task row is SCOPED, and the events list agrees with it", async () => {
    // v8.8.8 — RE-POINTED, and the instruction to re-point it was written here.
    //
    // This test used to assert the OPPOSITE: that the row still names events
    // outside the actor's scope, because the CLIENT could only carry an
    // out-of-scope assignment through if it was told about it. Its own comment
    // then recorded the condition for changing that — "if this array is ever
    // scoped, the server's removal diff and its concurrency comparison must be
    // scoped in the SAME commit" — which is exactly what v8.8.8 did. The
    // preservation moved to the server, which now diffs against the set it
    // SHOWED, so the client no longer needs to be told about another organiser's
    // event and is no longer told.
    //
    // The ASYMMETRY was the bug: the events list withheld the event while the
    // task row named it. What this arm pins now is that the two AGREE — which is
    // the property that removed the cause rather than working around it.
    const t = await sharedTask("precond");
    const r = await w.eaApi.get("/api/admin/tasks");
    expect(r.ok(), `event admin tasks list: ${r.status()}`).toBeTruthy();
    const row = (await r.json()).find(x => x.id === t.id);
    expect(row, "the event admin sees their own challenge").toBeTruthy();
    const ids = (row.competitions || []).map(c => c.id);
    expect(ids, "…and the row does NOT name the out-of-scope event").not.toContain(w.theirs.id);
    expect(ids, "…while still naming their own").toContain(w.mine.id);

    const cr = await w.eaApi.get("/api/admin/competitions");
    const listed = (await cr.json()).map(c => c.id);
    expect(listed, "the scoped events list withholds it too").not.toContain(w.theirs.id);

    // CONTROL: the assignment is still THERE. Without this, "the row does not
    // name it" is equally satisfied by a build that dropped the assignment.
    const asSa = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect(asSa.has(w.theirs.id), "the row is withheld, not deleted").toBe(true);
  });

  // ── the reported flow ────────────────────────────────────────────────────

  test("REPORTED FLOW — unticking their own event succeeds, and the out-of-scope assignment survives", async () => {
    const t = await sharedTask("removal");
    const assigned = await assignedIdsAsActor(w.eaApi, t.id);
    const res = await putAssign(w.eaApi, w.eaCsrf, t.id,
      dialogPayload({ rendered, ticked: [], assigned }));

    expect(res.status(), `the removal must succeed: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.removed, "exactly their own event was removed").toBe(1);
    expect(body.added, "…and nothing was added").toBe(0);

    const after = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect(after.has(w.mine.id), "their own assignment is gone").toBe(false);
    expect(after.has(w.theirs.id), "the OUT-OF-SCOPE assignment is untouched").toBe(true);
  });

  test("PURE ADD — assigning to their second event succeeds and removes nothing", async () => {
    const t = await sharedTask("add");
    const assigned = await assignedIdsAsActor(w.eaApi, t.id);
    const res = await putAssign(w.eaApi, w.eaCsrf, t.id,
      dialogPayload({ rendered, ticked: [w.mine.id, alsoMine.id], assigned }));

    expect(res.status(), `the add must succeed: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.added, "the second event was added").toBe(1);
    expect(body.removed, "…and nothing was removed").toBe(0);

    const after = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect([...after].sort(), "all three assignments now stand")
      .toEqual([w.mine.id, alsoMine.id, w.theirs.id].sort());
  });

  test("NO-OP — an unchanged save succeeds and writes nothing", async () => {
    const t = await sharedTask("noop");
    const assigned = await assignedIdsAsActor(w.eaApi, t.id);
    const res = await putAssign(w.eaApi, w.eaCsrf, t.id,
      dialogPayload({ rendered, ticked: [w.mine.id], assigned }));

    expect(res.status(), `the no-op must succeed: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.added, "nothing added").toBe(0);
    expect(body.removed, "nothing removed").toBe(0);

    const after = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect([...after].sort(), "both assignments stand").toEqual([w.mine.id, w.theirs.id].sort());
  });

  // ── the controls ─────────────────────────────────────────────────────────

  test("CONTROL — an EXPLICIT out-of-scope removal is STILL refused, and writes nothing", async () => {
    // The fail-closed property the fix must not cost. Here the payload omits the
    // out-of-scope event AND does not preserve it, which is the one thing the
    // client can no longer produce — so the server's guard is what stands
    // between a stale or hand-rolled client and another organiser's event.
    // Without this arm, "the save succeeded" is equally satisfied by a build that
    // stopped scoping removals altogether.
    const t = await sharedTask("control-refuse");
    const assigned = await assignedIdsAsSuperadmin(w.sa, t.id);
    const res = await putAssign(w.eaApi, w.eaCsrf, t.id, {
      competitionIds: [w.mine.id],                 // theirs deliberately dropped
      expectedAssignments: [...assigned],
    });

    const b = await expectRefused(res, "an explicit out-of-scope removal", "event_admin_out_of_scope");
    expect(b.error, "the refusal states the reason").toContain(OUT_OF_SCOPE);

    const after = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect([...after].sort(), "the 403 was a rollback — nothing was written")
      .toEqual([w.mine.id, w.theirs.id].sort());
  });

  test("CONTROL — a GLOBAL admin is unaffected and can still remove both", async () => {
    // "The event admin's save works" is equally satisfied by a build that stopped
    // enforcing anything; this is the other side of that.
    const t = await sharedTask("control-global");
    const assigned = await assignedIdsAsSuperadmin(w.sa, t.id);
    const res = await putAssign(w.sa, w.saCsrf, t.id, {
      competitionIds: [],
      expectedAssignments: [...assigned],
    });
    expect(res.status(), `superadmin save: ${await res.text()}`).toBe(200);
    expect((await res.json()).removed, "the superadmin removed both").toBe(2);
    expect((await assignedIdsAsSuperadmin(w.sa, t.id)).size, "the challenge is unassigned").toBe(0);
  });

  test("CONTROL — a genuinely stale expectedAssignments still raises the concurrency 409", async () => {
    // v8.8.8 — RE-POINTED, not weakened. Its subject is unchanged: the
    // optimistic-concurrency guard must survive being narrowed, or "saves
    // succeed" is satisfied by a build that deleted the check. What moved is how
    // a stale expectation is EXPRESSED.
    //
    // It used to name the out-of-scope event in `competitionIds`, which since
    // v8.8.8 is refused on SCOPE before concurrency is considered — a better
    // answer for that request, and no longer a test of this guard. The stale set
    // is now built from events the actor really organises, which is the only
    // shape a real client could produce and therefore the only one where "reopen
    // the dialog" is advice that can succeed.
    const t = await sharedTask("control-conflict");
    const res = await putAssign(w.eaApi, w.eaCsrf, t.id, {
      competitionIds: [alsoMine.id],
      expectedAssignments: [],                     // stale: omits `mine`, which IS shown
    });
    expect(res.status(), `stale expected set: ${await res.text()}`).toBe(409);
    expect((await res.json()).conflict, "…as a conflict").toBe(true);

    const after = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect([...after].sort(), "the 409 wrote nothing").toEqual([w.mine.id, w.theirs.id].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ENDED case the old `endedIds` re-append existed for. The fix subsumes it,
// so it needs its own arm: a regression here would mean the generalisation lost
// the behaviour it replaced.
//
// Its own describe because the fixture needs an event that is ENDED, and an
// ended event refuses the assign — so it must be created LIVE, assigned, and
// only then ended (the fixture checklist's rule).
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.7.7 — an in-scope ENDED assignment is still preserved", () => {
  test("a save that does not render an ended event does not drop it", async () => {
    test.setTimeout(180_000);
    const w = await buildWorld();
    const endedMine = await makeCompetition(w.sa, w.saCsrf, "endedmine");
    await grantEventAdmin(w.sa, w.saCsrf, endedMine.id, w.ea.id);

    const t = await makeTask(w.eaApi, w.eaCsrf, "endedpreserve");
    // Assign while it is still LIVE, then end it.
    await assignTask(w.eaApi, w.eaCsrf, t.id, [w.mine.id, endedMine.id]);
    const end = await w.sa.post(`/api/admin/competitions/${endedMine.id}/end-now`, { headers: H(w.saCsrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    const assigned = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect([...assigned].sort(), "fixture: assigned to a live and an ended event of theirs")
      .toEqual([w.mine.id, endedMine.id].sort());

    // The dialog renders only NON-ended events, so `rendered` excludes endedMine.
    const res = await putAssign(w.eaApi, w.eaCsrf, t.id,
      dialogPayload({ rendered: new Set([w.mine.id]), ticked: [w.mine.id], assigned }));
    expect(res.status(), `save: ${await res.text()}`).toBe(200);
    expect((await res.json()).removed, "nothing was removed").toBe(0);

    const after = await assignedIdsAsSuperadmin(w.sa, t.id);
    expect(after.has(endedMine.id), "the ENDED assignment survived the save").toBe(true);
  });
});
