// @ts-check
//
// v8.8.8 — `task.competitions` IS NARROWED, AND THE TWO THINGS THAT READ IT
// MOVED IN THE SAME COMMIT.
//
// v8.7.0 scoped every list an event admin opens and left this projection alone,
// so a shared challenge named the id, name, status and internal task_number of
// every event holding it — including another organiser's. v8.7.7 found it while
// fixing the dialog it broke, confirmed it live, and deliberately did NOT fix it,
// because narrowing it alone re-creates the very defect that release cured:
//
//   * the removal diff (`toRemoveIds = currentSet \ desiredSet`) would compute
//     every out-of-scope assignment as a removal nobody requested — a total
//     lockout of the dialog, refusing a pure ADD and an unchanged NO-OP alike; and
//   * the optimistic-concurrency comparison would fail against a narrowed
//     expectation, turning every save on a shared challenge into a spurious 409
//     blaming a colleague for a conflict that does not exist, with a "reopen the
//     dialog" remedy that can never succeed.
//
// So this file drives all three: the projection, the diff and the comparison.
// EVERY refusal here carries a GLOBAL-ADMIN control, because "the event admin
// could not see it" is equally satisfied by a build that shows nobody anything.

const { test, expect } = require("./isolated-test");
const { H, buildWorld, makeTask, assignTask } = require("./event-admin-helpers");

/** The challenge row as a given actor sees it, from the list they really read. */
async function taskRow(api, taskId) {
  const r = await api.get("/api/admin/tasks");
  expect(r.ok(), `tasks list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the challenge is visible to this actor at all").toBeTruthy();
  return row;
}

const ids = row => (row.competitions || []).map(c => c.id).sort();

test.describe("v8.8.8 — task.competitions is scoped to the viewer", () => {
  /** @type {any} */ let w;
  let shared;   // in BOTH events — the only shape that separates the three changes
  let mineOnly; // in the event admin's event alone — the control

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    w = await buildWorld();

    // Created by the SUPERADMIN and tagged public-domain, so the event admin can
    // see it through the shared-pool arm rather than through ownership — the
    // ordinary way a challenge comes to be held by two organisers' events.
    shared = await makeTask(w.sa, w.saCsrf, "tcshared");
    const tag = await w.sa.post(`/api/admin/tasks/${shared.id}/tags`, {
      headers: H(w.saCsrf), data: { tag: "public-domain" },
    });
    expect(tag.ok(), `tag: ${tag.status()} ${await tag.text()}`).toBeTruthy();
    await assignTask(w.sa, w.saCsrf, shared.id, [w.mine.id, w.theirs.id]);

    mineOnly = await makeTask(w.sa, w.saCsrf, "tcmine");
    await w.sa.post(`/api/admin/tasks/${mineOnly.id}/tags`, { headers: H(w.saCsrf), data: { tag: "public-domain" } });
    await assignTask(w.sa, w.saCsrf, mineOnly.id, [w.mine.id]);
  });

  test("the projection names only the viewer's own events", async () => {
    const mine = await taskRow(w.eaApi, shared.id);
    expect(ids(mine), "one entry, and it is theirs").toEqual([w.mine.id]);

    // BY VALUE, not by key. A narrowing that merely renamed the field, or moved
    // the decoy under a key this test does not enumerate, would pass a
    // shape-only assertion — the v7.22.0 leak-lock shape.
    const blob = JSON.stringify(mine);
    expect(blob, "the decoy's id appears nowhere").not.toContain(w.theirs.id);
    expect(blob, "…nor its name").not.toContain(w.theirs.name);
  });

  test("CONTROL — a global admin still sees both, unchanged", async () => {
    // Without this, every assertion above is satisfied by a build that returns an
    // empty array to everybody.
    const sa = await taskRow(w.sa, shared.id);
    expect(ids(sa), "the unscoped tier is byte-identical to before").toEqual([w.mine.id, w.theirs.id].sort());
    expect(sa.withheld_competition_count, "and nothing is withheld from them").toBeUndefined();
    expect(sa.withheld_live, "…so the flag is absent too").toBeUndefined();
  });

  test("what was withheld is COUNTED, because the live-edit warning is built from it", async () => {
    // An event admin may still legally edit this challenge's cosmetic fields
    // while another organiser is running it, so narrowing the array to nothing
    // and stopping there would delete the "participants are answering this right
    // now" confirmation at the moment it matters most.
    const mine = await taskRow(w.eaApi, shared.id);
    expect(mine.withheld_competition_count, "one event was withheld").toBe(1);
    expect(mine.withheld_live, "…and it is live, which the warning needs").toBe(true);

    // CONTROL: a challenge with nothing withheld emits NEITHER key, so every
    // unshared row is byte-identical to before.
    const only = await taskRow(w.eaApi, mineOnly.id);
    expect(ids(only)).toEqual([w.mine.id]);
    expect(only.withheld_competition_count, "nothing withheld, so no count").toBeUndefined();
    expect(only.withheld_live, "…and no flag").toBeUndefined();
  });

  test("the reported v8.7.7 flow still works: a narrowed save preserves the rest", async () => {
    // THE REGRESSION THIS RELEASE MUST NOT REINTRODUCE. The client now sends only
    // what it was shown, so the SERVER has to preserve the out-of-scope row by
    // diffing against the set it showed. A no-op save is the sharpest form: it
    // asks for nothing and must therefore change nothing.
    const before = await taskRow(w.eaApi, shared.id);
    const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: ids(before), expectedAssignments: ids(before) },
    });
    expect(r.status(), `no-op save: ${await r.text()}`).toBe(200);

    // Read back as the SUPERADMIN — the event admin cannot see the row that
    // matters, so asserting from their payload would prove nothing.
    const after = await taskRow(w.sa, shared.id);
    expect(ids(after), "the other organiser's assignment survived").toEqual([w.mine.id, w.theirs.id].sort());
  });

  test("a pure ADD works, and still leaves the out-of-scope assignment alone", async () => {
    const extra = await makeTask(w.sa, w.saCsrf, "tcadd");
    await w.sa.post(`/api/admin/tasks/${extra.id}/tags`, { headers: H(w.saCsrf), data: { tag: "public-domain" } });
    await assignTask(w.sa, w.saCsrf, extra.id, [w.theirs.id]);

    const before = await taskRow(w.eaApi, extra.id);
    expect(ids(before), "precondition: they see none of its events").toEqual([]);
    const r = await w.eaApi.put(`/api/admin/tasks/${extra.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: [w.mine.id], expectedAssignments: [] },
    });
    expect(r.status(), `add: ${await r.text()}`).toBe(200);

    const after = await taskRow(w.sa, extra.id);
    expect(ids(after), "added to theirs, and the decoy untouched")
      .toEqual([w.mine.id, w.theirs.id].sort());
  });

  test("naming an event they cannot see is REFUSED, and the refusal names nothing", async () => {
    // Reachable only by hand — the client cannot name what it was not shown — so
    // this is the fail-closed backstop. Before this release it landed in neither
    // `toAdd` nor `toRemoveIds` and was accepted in silence.
    const before = await taskRow(w.eaApi, shared.id);
    const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: [w.mine.id, w.theirs.id], expectedAssignments: ids(before) },
    });
    expect(r.status(), "refused").toBe(403);
    const body = await r.json();
    expect(body.code).toBe("event_admin_out_of_scope");
    expect(JSON.stringify(body), "the refusal does not disclose the event it is about")
      .not.toContain(w.theirs.name);
  });

  test("an explicit out-of-scope REMOVAL is still impossible, and nothing was written", async () => {
    // The client cannot express this any more, so the assertion is that the
    // server does not carry it out however it is asked.
    const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: [w.mine.id], expectedAssignments: [w.mine.id, w.theirs.id] },
    });
    // The expectation names an event outside the scope — the same category error
    // as naming one in the desired set — so it is a named 403 about scope rather
    // than a concurrency 409 telling the caller to reopen a dialog that would
    // show them exactly what it showed before.
    expect(r.status(), "refused on scope, not on concurrency").toBe(403);
    expect((await r.json()).code).toBe("event_admin_out_of_scope");
    const after = await taskRow(w.sa, shared.id);
    expect(ids(after), "the other organiser's assignment is untouched")
      .toEqual([w.mine.id, w.theirs.id].sort());
  });

  test("a REAL in-scope conflict still 409s", async () => {
    // The concurrency check must stay live after being narrowed — without this,
    // "saves succeed" is satisfied by a build that deleted the check.
    const before = await taskRow(w.eaApi, shared.id);
    const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: ids(before), expectedAssignments: [] },
    });
    expect(r.status(), "a stale expectation is refused").toBe(409);
  });

  test("the not-assigner refusal still NAMES the event, because it is theirs", async () => {
    // The out-of-scope arm of `taskUnassignDenied` is now unreachable from this
    // route, so the surviving arm is always about an event the actor organises —
    // which is what makes naming it correct rather than a disclosure, the
    // reconsideration v8.7.7 asked for.
    const before = await taskRow(w.eaApi, shared.id);
    expect(before.competitions[0].can_unassign,
      "precondition: a superadmin put it there, so they may not remove it").toBe(false);
    const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}/competitions`, {
      headers: H(w.eaCsrf), data: { competitionIds: [], expectedAssignments: ids(before) },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error, "names the event, which is one of their own")
      .toContain(w.mine.name);
  });

  test("CONTROL — a global admin's diff is still computed against the WHOLE set", async () => {
    // The narrowing is per-actor. For an unscoped admin a desired state that
    // omits an event must still remove it, or this release quietly turned every
    // removal into a no-op for everybody.
    const t = await makeTask(w.sa, w.saCsrf, "tcglobal");
    await assignTask(w.sa, w.saCsrf, t.id, [w.mine.id, w.theirs.id]);
    const r = await w.sa.put(`/api/admin/tasks/${t.id}/competitions`, {
      headers: H(w.saCsrf),
      data: { competitionIds: [w.mine.id], expectedAssignments: [w.mine.id, w.theirs.id].sort() },
    });
    expect(r.status(), `global removal: ${await r.text()}`).toBe(200);
    expect(ids(await taskRow(w.sa, t.id)), "the removal really happened").toEqual([w.mine.id]);
  });
});
