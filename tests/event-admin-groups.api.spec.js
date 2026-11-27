"use strict";

// v8.7.0 — THE EVENT-ADMIN SCOPE OVER PARTICIPANT GROUPS.
//
// Groups are the one admin object whose write reaches OUTSIDE the object being
// written: membership live-syncs into every bound competition
// (`reconcileCompetitionMembership`), so a group bound both to your event and to
// somebody else's is a lever on an event you do not manage. That is
// ROLES_AND_PERMISSIONS.md §9.2, and the transitive-hole block below is the
// sharpest test in this file — it is the only place where "I can SEE it" and "I
// may WRITE it" deliberately come apart.
//
// Three rules, three different predicates, and they are genuinely different
// questions — a group can be visible and unwritable, or writable and
// undeletable:
//   groupViewDenied   — created by me, OR bound to one of my events
//   groupWriteDenied  — EVERY binding in scope   (the transitive rule)
//   groupDeleteDenied — created by me            (creator only)
//
// House rules this file obeys, each of which has cost this repo a release:
//   * every REFUSAL carries a control that the same call still works for the
//     superadmin — "the event admin was refused" is equally satisfied by a build
//     that broke the route for everybody;
//   * every POSITIVE list assertion names an ABSENT decoy — "the list contains my
//     group" is equally satisfied by an unfiltered list;
//   * the ZERO-GRANT actor is tested wherever a list is narrowed. `[]` is not
//     `null`: `IN ()` is a SQLite syntax error, so the naive
//     `ids.length ? clause : ""` leaves the query UNFILTERED for exactly the
//     actor who must see nothing.

const { test, expect } = require("./isolated-test");
const { PARTICIPANT_PASS, apiLogin } = require("./helpers");
const {
  H, uniq, buildWorld, expectRefused, makeParticipant, grantEventAdmin,
} = require("./event-admin-helpers");

/** Create a group as whoever `api` is. Returns `{id,name}`; asserts it took. */
async function makeGroup(api, csrf, label) {
  const name = `EA G ${uniq(label)}`.slice(0, 80);
  const r = await api.post("/api/admin/groups", { headers: H(csrf), data: { name } });
  expect(r.ok(), `create group ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).group?.id;
  expect(id, "create group must return an id").toBeTruthy();
  return { id, name };
}

/**
 * Bind a group to a competition — the ONLY route that does it — and then READ
 * THE BINDING BACK. A bind that silently did not happen turns every "shared
 * group" assertion below into a test of an ordinary group, which would pass for
 * entirely the wrong reason.
 */
async function bindGroup(sa, saCsrf, groupId, competitionId) {
  const r = await sa.post("/api/admin/competitions/assign", {
    headers: H(saCsrf), data: { groupIds: [groupId], competitionIds: [competitionId] },
  });
  expect(r.ok(), `bind group: ${r.status()} ${await r.text()}`).toBeTruthy();
  const back = await sa.get(`/api/admin/competitions/${competitionId}/groups`);
  const bound = (await back.json()).groups.map(g => g.id);
  expect(bound, "precondition: the bind really landed").toContain(groupId);
}

/** `GET /api/admin/groups` answers a BARE ARRAY. */
async function listGroups(api) {
  const r = await api.get("/api/admin/groups");
  expect(r.ok(), `group list: ${r.status()} ${await r.text()}`).toBeTruthy();
  const body = await r.json();
  expect(Array.isArray(body), "the group list is a bare array").toBeTruthy();
  return body;
}

test.describe("v8.7.0 — event-admin scope over groups", () => {
  let w;
  // The four list fixtures, built once and never mutated: every test that WRITES
  // mints its own group, so no test depends on what another left behind.
  let eaOwned;    // created BY the event admin, bound to nothing
  let saMine;     // created by the superadmin, bound to `mine` only
  let saTheirs;   // created by the superadmin, bound to `theirs` only  → the decoy
  let shared;     // created by the superadmin, bound to BOTH           → §9.2

  test.beforeAll(async () => {
    // NOTE: no seedTestData() — tests/isolated-test.js re-seeds before every spec
    // FILE, and the seed is not idempotent (its fixed competition names 409).
    w = await buildWorld();

    eaOwned = await makeGroup(w.eaApi, w.eaCsrf, "ea-owned");
    saMine = await makeGroup(w.sa, w.saCsrf, "sa-mine");
    saTheirs = await makeGroup(w.sa, w.saCsrf, "sa-theirs");
    shared = await makeGroup(w.sa, w.saCsrf, "shared");

    await bindGroup(w.sa, w.saCsrf, saMine.id, w.mine.id);
    await bindGroup(w.sa, w.saCsrf, saTheirs.id, w.theirs.id);
    await bindGroup(w.sa, w.saCsrf, shared.id, w.mine.id);
    await bindGroup(w.sa, w.saCsrf, shared.id, w.theirs.id);
  });

  // ── creation and ownership ────────────────────────────────────────────────

  test("creating a group stamps ownership, and the creator may delete it", async () => {
    const g = await makeGroup(w.eaApi, w.eaCsrf, "mine-to-delete");

    // `created_by_id` is not readable over the wire, so ownership is asserted
    // through the two things it decides: the offer, and the act.
    const row = (await listGroups(w.eaApi)).find(x => x.id === g.id);
    expect(row, "an event admin sees the group they just created").toBeTruthy();
    expect(row.can_delete, "…and is offered the delete").toBe(true);
    expect(row.can_write, "…and the write, the group being bound nowhere").toBe(true);

    const del = await w.eaApi.delete(`/api/admin/groups/${g.id}`, { headers: H(w.eaCsrf) });
    expect(del.ok(), `own-group delete: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect((await listGroups(w.eaApi)).map(x => x.id), "…and it is gone").not.toContain(g.id);
  });

  test("a group somebody ELSE created is visible but NOT deletable — with the superadmin control", async () => {
    // Purpose-built rather than reusing `saMine`: the superadmin control below
    // really deletes it, and a control that destroys a shared fixture is how a
    // later test comes to pass for the wrong reason.
    const g = await makeGroup(w.sa, w.saCsrf, "sa-owned-bound-mine");
    await bindGroup(w.sa, w.saCsrf, g.id, w.mine.id);

    const row = (await listGroups(w.eaApi)).find(x => x.id === g.id);
    expect(row, "it IS visible — it is bound to an event they organise").toBeTruthy();
    expect(row.can_delete, "…but the delete is not offered: deleting is creator-only").toBe(false);
    expect(row.can_write, "…while the write IS, every binding being in scope").toBe(true);

    const bad = await w.eaApi.delete(`/api/admin/groups/${g.id}`, { headers: H(w.eaCsrf) });
    await expectRefused(bad, "deleting somebody else's group", "event_admin_not_owner");

    // The refusal ran BEFORE the cascade, so it must have left the group AND its
    // binding standing. Without this, a 403 is equally satisfied by a route that
    // refuses only after destroying the row it was refusing to destroy.
    const survived = await w.sa.get(`/api/admin/competitions/${w.mine.id}/groups`);
    expect((await survived.json()).groups.map(x => x.id),
      "a refused delete leaves the group and its binding intact").toContain(g.id);

    // THE CONTROL. Without it, "the delete was refused" is equally satisfied by a
    // build in which nobody can delete a group at all — and `ok()` alone is
    // satisfied by a 200 that deleted nothing, so the absence is asserted too.
    const good = await w.sa.delete(`/api/admin/groups/${g.id}`, { headers: H(w.saCsrf) });
    expect(good.ok(), `superadmin delete: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await listGroups(w.sa)).map(x => x.id),
      "…and the control really destroyed it, so its 200 was not a no-op").not.toContain(g.id);
  });

  // ── list scoping ──────────────────────────────────────────────────────────

  test("the group list is created-by ∪ bound-to-a-scoped-event, and the decoy is ABSENT", async () => {
    const ids = (await listGroups(w.eaApi)).map(g => g.id);
    expect(ids, "the group they created").toContain(eaOwned.id);
    expect(ids, "a group bound to the event they organise").toContain(saMine.id);
    expect(ids, "a group bound to BOTH — visible, per §9.2, even though unwritable").toContain(shared.id);
    // THE DECOY. With this absent assertion removed, a build that dropped the
    // scope predicate entirely satisfies every line above.
    expect(ids, "a group bound only to an event they do NOT organise").not.toContain(saTheirs.id);

    // THE CONTROL: the rows are really there, and it is the SCOPE that hides one.
    const all = (await listGroups(w.sa)).map(g => g.id);
    for (const g of [eaOwned, saMine, saTheirs, shared]) {
      expect(all, `the superadmin sees ${g.name}`).toContain(g.id);
    }
  });

  test("ZERO GRANTS sees only what it created — the empty-scope fail-open catcher", async () => {
    // The sharper form of "sees nothing": the created-by arm must SURVIVE while
    // the bound arm collapses. A build that answered `[]` unconditionally for an
    // empty scope passes a bare emptiness check and fails this one, and a build
    // that degraded the empty branch to "" returns every group on the platform.
    const own = await makeGroup(w.zeroApi, w.zeroCsrf, "zero-owned");

    const ids = (await listGroups(w.zeroApi)).map(g => g.id);
    expect(ids, "the group they created is still theirs").toContain(own.id);
    for (const g of [eaOwned, saMine, saTheirs, shared]) {
      expect(ids, `a grantless event admin must not see ${g.name}`).not.toContain(g.id);
    }
    expect(ids.length, `saw ${ids.length} groups, expected exactly the one they made`).toBe(1);

    // …and the per-entity predicate agrees with the list about the same group:
    // if these two ever disagree, one of them is wrong and nothing says which.
    const peek = await w.zeroApi.get(`/api/admin/groups/${saMine.id}/members`);
    await expectRefused(peek, "a grantless actor opening a group they cannot see", "event_admin_out_of_scope");
    // THE CONTROL, on the SAME group and the SAME route, as an actor who holds
    // the grant. Without it the refusal is equally satisfied by a broken route or
    // by a group id that resolves for nobody — neither of which is about scope.
    const seen = await w.eaApi.get(`/api/admin/groups/${saMine.id}/members`);
    expect(seen.ok(),
      `the granted organiser reads the same group: ${seen.status()} ${await seen.text()}`).toBeTruthy();
  });

  // ── §9.2 — the transitive hole ────────────────────────────────────────────

  test("§9.2 — every WRITE to a shared group is refused, and the refusal NAMES the other event", async () => {
    // The group is bound to `mine` AND `theirs`. Membership live-syncs into every
    // bound competition, so any of these three writes would move people in an
    // event this actor has no remit over.
    const rename = await w.eaApi.put(`/api/admin/groups/${shared.id}`, {
      headers: H(w.eaCsrf), data: { name: `EA G ${uniq("nope")}` },
    });
    const b1 = await expectRefused(rename, "renaming a shared group", "event_admin_group_shared");
    // The refusal has to be actionable: "you cannot edit this" without naming the
    // event that makes it so leaves the organiser with nowhere to go.
    expect(b1.error, "the refusal names the event they do not manage").toContain(w.theirs.name);
    // …and it did not half-apply. A rename refused AFTER the UPDATE is worse than
    // one never refused, and a status-only assertion cannot tell the two apart.
    expect((await listGroups(w.sa)).find(x => x.id === shared.id).name,
      "a refused rename left the name alone").toBe(shared.name);

    const add = await w.eaApi.post(`/api/admin/groups/${shared.id}/members`, {
      headers: H(w.eaCsrf), data: { userIds: [w.inMine.id] },
    });
    const b2 = await expectRefused(add, "adding a member to a shared group", "event_admin_group_shared");
    expect(b2.error).toContain(w.theirs.name);

    // THE ADD CONTROL, hoisted ABOVE the removal refusal on purpose: it plants a
    // REAL membership row, so the removal refused below is protecting something
    // rather than refusing a no-op. `added` is asserted because `{ok:true,
    // added:0}` is exactly what a route that wrote nothing returns.
    const c2 = await w.sa.post(`/api/admin/groups/${shared.id}/members`, {
      headers: H(w.saCsrf), data: { userIds: [w.inMine.id] },
    });
    expect(c2.ok(), `superadmin member add: ${c2.status()} ${await c2.text()}`).toBeTruthy();
    expect((await c2.json()).added, "the control wrote the row the refusal below protects").toBe(1);

    const rm = await w.eaApi.delete(`/api/admin/groups/${shared.id}/members/${w.inMine.id}`, {
      headers: H(w.eaCsrf),
    });
    const b3 = await expectRefused(rm, "removing a member from a shared group", "event_admin_group_shared");
    expect(b3.error).toContain(w.theirs.name);
    const kept = await w.sa.get(`/api/admin/groups/${shared.id}/members`);
    expect((await kept.json()).members.map(m => m.id),
      "the refused removal left the membership standing").toContain(w.inMine.id);

    // THE REMAINING CONTROLS: the rename and the removal routes themselves work.
    // Both assert an EFFECT, not a status — a rename to the SAME name is a no-op
    // that any broken UPDATE satisfies, and the removal route answers `{ok:true}`
    // whether or not it deleted a row.
    const c1name = `EA G ${uniq("ctl")}`;
    const c1 = await w.sa.put(`/api/admin/groups/${shared.id}`, {
      headers: H(w.saCsrf), data: { name: c1name },
    });
    expect(c1.ok(), `superadmin rename: ${c1.status()} ${await c1.text()}`).toBeTruthy();
    expect((await c1.json()).group.name, "the control rename really applied").toBe(c1name);
    const c1back = await w.sa.put(`/api/admin/groups/${shared.id}`, {
      headers: H(w.saCsrf), data: { name: shared.name },
    });
    expect(c1back.ok(), `restoring the shared fixture's name: ${c1back.status()}`).toBeTruthy();

    const c3 = await w.sa.delete(`/api/admin/groups/${shared.id}/members/${w.inMine.id}`, {
      headers: H(w.saCsrf),
    });
    expect(c3.ok(), `superadmin member remove: ${c3.status()} ${await c3.text()}`).toBeTruthy();
    const gone = await w.sa.get(`/api/admin/groups/${shared.id}/members`);
    expect((await gone.json()).members.map(m => m.id),
      "…and the control really removed it, leaving the fixture as it was").not.toContain(w.inMine.id);

    // …and the READ is deliberately still allowed: view and write come apart
    // here, which is the whole point of §9.2 having its own predicate.
    const see = await w.eaApi.get(`/api/admin/groups/${shared.id}/members`);
    expect(see.ok(), "a shared group is still VISIBLE to an organiser of one of its events").toBeTruthy();
  });

  test("§9.2 CONTROL — the same three writes on a group bound ONLY to a scoped event all succeed", async () => {
    // Identical to `shared` in every respect except the second binding: same
    // creator (the superadmin, so ownership cannot be what lets this through),
    // same routes, same actor. Without this arm, "writes to a group are refused"
    // is satisfied by a build that refuses EVERY group write for an event admin,
    // which would make the tier unable to do the job the brief gives it.
    const g = await makeGroup(w.sa, w.saCsrf, "bound-mine-only");
    await bindGroup(w.sa, w.saCsrf, g.id, w.mine.id);

    const newName = `EA G ${uniq("renamed")}`;
    const rename = await w.eaApi.put(`/api/admin/groups/${g.id}`, {
      headers: H(w.eaCsrf), data: { name: newName },
    });
    expect(rename.ok(), `rename: ${rename.status()} ${await rename.text()}`).toBeTruthy();
    expect((await rename.json()).group.name, "the rename really applied, not merely answered 200").toBe(newName);

    const add = await w.eaApi.post(`/api/admin/groups/${g.id}/members`, {
      headers: H(w.eaCsrf), data: { userIds: [w.inMine.id] },
    });
    expect(add.ok(), `member add: ${add.status()} ${await add.text()}`).toBeTruthy();
    expect((await add.json()).added, "the add really wrote a row").toBe(1);

    const rm = await w.eaApi.delete(`/api/admin/groups/${g.id}/members/${w.inMine.id}`, {
      headers: H(w.eaCsrf),
    });
    expect(rm.ok(), `member remove: ${rm.status()} ${await rm.text()}`).toBeTruthy();
    const after = await w.eaApi.get(`/api/admin/groups/${g.id}/members`);
    expect((await after.json()).members.map(m => m.id), "…and the row is gone").not.toContain(w.inMine.id);
  });

  // ── member targets ────────────────────────────────────────────────────────

  test("member targets are scoped: a participant in nobody's event but the DECOY'S cannot be added", async () => {
    // The group is the actor's own and bound nowhere, so `groupWriteDenied` is
    // satisfied trivially — the ONLY thing that can refuse here is the target.
    const g = await makeGroup(w.eaApi, w.eaCsrf, "targets");

    const bad = await w.eaApi.post(`/api/admin/groups/${g.id}/members`, {
      headers: H(w.eaCsrf), data: { userIds: [w.inTheirs.id] },
    });
    await expectRefused(bad, "adding a participant from a decoy event", "event_admin_out_of_scope");

    // CONTROL A: a participant they CAN see goes in. Without it, the refusal is
    // satisfied by a build in which no member add ever works.
    const good = await w.eaApi.post(`/api/admin/groups/${g.id}/members`, {
      headers: H(w.eaCsrf), data: { userIds: [w.inMine.id] },
    });
    expect(good.ok(), `in-scope add: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await good.json()).added, "the in-scope add really wrote a row").toBe(1);

    // CONTROL B: the refused target is a real, addable user — the refusal is
    // about SCOPE, not about a broken id.
    const sup = await w.sa.post(`/api/admin/groups/${g.id}/members`, {
      headers: H(w.saCsrf), data: { userIds: [w.inTheirs.id] },
    });
    expect(sup.ok(), `superadmin add of the same target: ${sup.status()}`).toBeTruthy();
    expect((await sup.json()).added, "…and that target is genuinely addable — the refusal was about SCOPE").toBe(1);

    // A MIXED batch is refused WHOLE, not partially applied: a bulk route that
    // drops half its targets and reports success is the control-that-appears-to-
    // work failure this codebase keeps paying for.
    const g2 = await makeGroup(w.eaApi, w.eaCsrf, "targets-mixed");
    const mixed = await w.eaApi.post(`/api/admin/groups/${g2.id}/members`, {
      headers: H(w.eaCsrf), data: { userIds: [w.inMine.id, w.inTheirs.id] },
    });
    await expectRefused(mixed, "a batch with one out-of-scope target", "event_admin_out_of_scope");
    const members = await w.eaApi.get(`/api/admin/groups/${g2.id}/members`);
    expect((await members.json()).members.length, "nothing was written at all").toBe(0);
  });

  test("the per-participant chip checks BOTH ends — the participant AND the group", async () => {
    const g = await makeGroup(w.eaApi, w.eaCsrf, "chip");

    // (a) the PARTICIPANT side. Checked first in the handler, deliberately: the
    // `newName` branch below can CREATE a group, and a refused request must not
    // leave one behind.
    const badUser = await w.eaApi.post(`/api/admin/participants/${w.inTheirs.id}/groups`, {
      headers: H(w.eaCsrf), data: { groupId: g.id },
    });
    await expectRefused(badUser, "chipping a participant from a decoy event", "event_admin_out_of_scope");

    // …and THE ORDERING that check exists for. The `newName` branch below it
    // CREATES a group, so a participant-side refusal must leave nothing behind.
    // Without this arm the comment above is the only thing holding the order: a
    // build that checked the participant AFTER the create still answers 403 here
    // and still passes, having orphaned a group nobody asked for.
    const orphanName = `EA G ${uniq("orphan")}`;
    const badNew = await w.eaApi.post(`/api/admin/participants/${w.inTheirs.id}/groups`, {
      headers: H(w.eaCsrf), data: { newName: orphanName },
    });
    await expectRefused(badNew, "chipping a decoy participant into a NEW group", "event_admin_out_of_scope");
    expect((await listGroups(w.sa)).map(x => x.name),
      "a refused chip left no group behind").not.toContain(orphanName);

    // CONTROL for that arm: the create-on-the-fly branch really does create.
    // Without it, "no group was left behind" is equally satisfied by a build in
    // which `newName` never creates one at all.
    const okName = `EA G ${uniq("created")}`;
    const goodNew = await w.eaApi.post(`/api/admin/participants/${w.inMine.id}/groups`, {
      headers: H(w.eaCsrf), data: { newName: okName },
    });
    expect(goodNew.ok(), `newName chip: ${goodNew.status()} ${await goodNew.text()}`).toBeTruthy();
    expect((await listGroups(w.sa)).map(x => x.name),
      "…the branch under test genuinely creates a group").toContain(okName);

    // (b) the GROUP side — an in-scope participant, but a group shared with an
    // event they do not manage.
    const badGroup = await w.eaApi.post(`/api/admin/participants/${w.inMine.id}/groups`, {
      headers: H(w.eaCsrf), data: { groupId: shared.id },
    });
    await expectRefused(badGroup, "chipping into a shared group", "event_admin_group_shared");

    // CONTROL: both ends in scope, so the chip works.
    const good = await w.eaApi.post(`/api/admin/participants/${w.inMine.id}/groups`, {
      headers: H(w.eaCsrf), data: { groupId: g.id },
    });
    expect(good.ok(), `chip add: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await good.json()).groups.map(x => x.id), "the chip really landed").toContain(g.id);

    // …and the DELETE chip is gated the same way, on both ends.
    const badDel = await w.eaApi.delete(
      `/api/admin/participants/${w.inTheirs.id}/groups/${g.id}`, { headers: H(w.eaCsrf) });
    await expectRefused(badDel, "un-chipping a participant from a decoy event", "event_admin_out_of_scope");

    const badDelGroup = await w.eaApi.delete(
      `/api/admin/participants/${w.inMine.id}/groups/${shared.id}`, { headers: H(w.eaCsrf) });
    await expectRefused(badDelGroup, "un-chipping from a shared group", "event_admin_group_shared");

    const goodDel = await w.eaApi.delete(
      `/api/admin/participants/${w.inMine.id}/groups/${g.id}`, { headers: H(w.eaCsrf) });
    expect(goodDel.ok(), `chip remove: ${goodDel.status()} ${await goodDel.text()}`).toBeTruthy();
    expect((await goodDel.json()).groups.map(x => x.id), "…and it is gone").not.toContain(g.id);
  });

  // ── picker and bindings ───────────────────────────────────────────────────

  test("the picker offers only candidates the actor can see — count AND rows", async () => {
    const g = await makeGroup(w.eaApi, w.eaCsrf, "picker");
    const r = await w.eaApi.get(`/api/admin/groups/${g.id}/picker?limit=500`);
    expect(r.ok(), `picker: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    const ids = d.candidates.map(c => c.id);

    expect(ids, "a participant in the event they organise IS offered").toContain(w.inMine.id);
    // THE DECOY: an unfiltered pool contains every user on the platform, so
    // without this the line above passes against a build with no scope at all.
    expect(ids, "a participant only in the decoy event is NOT offered").not.toContain(w.inTheirs.id);
    // `candidatesTotal` is a SEPARATE query built by the same `buildFilter`; if
    // the scope clause reached only the rows, the count would advertise people
    // the pages can never reach.
    expect(d.candidatesTotal, "the COUNT is scoped too, not just the page").toBe(ids.length);

    // CONTROL: the superadmin's pool really does hold the decoy participant.
    const sup = await w.sa.get(`/api/admin/groups/${g.id}/picker?limit=500`);
    expect((await sup.json()).candidates.map(c => c.id),
      "the decoy participant exists and is pickable — it is the SCOPE that hides them").toContain(w.inTheirs.id);
  });

  test("ZERO GRANTS is offered nobody — the picker's own empty-scope branch", async () => {
    // `buildFilter` splices `AND 1=0` for an empty scope. If it degraded to an
    // omitted clause, the one actor who must see nobody would be offered the
    // whole platform. The group is theirs, so `groupViewDenied` cannot be what
    // produces the empty answer.
    const g = await makeGroup(w.zeroApi, w.zeroCsrf, "zero-picker");
    const r = await w.zeroApi.get(`/api/admin/groups/${g.id}/picker?limit=500`);
    expect(r.ok(), `zero picker: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    expect(d.candidates.length, `a grantless actor was offered ${d.candidates.length} candidates`).toBe(0);
    expect(d.candidatesTotal, "…and the count agrees").toBe(0);

    // THE CONTROL, on the SAME group: an unscoped actor is offered a real pool
    // there. Without it "offered nobody" is equally satisfied by a picker broken
    // for this group — or for everybody — which is not what this test is about.
    const sup = await w.sa.get(`/api/admin/groups/${g.id}/picker?limit=500`);
    expect(sup.ok(), `superadmin picker on the same group: ${sup.status()}`).toBeTruthy();
    const supBody = await sup.json();
    expect(supBody.candidates.map(c => c.id),
      "the pool is not empty — it is the SCOPE that empties it").toContain(w.inMine.id);
    expect(supBody.candidatesTotal, "…and its count is non-zero too").toBeGreaterThan(0);
  });

  test("the bind dialog's competition list is scoped — including for ZERO grants", async () => {
    const r = await w.eaApi.get(`/api/admin/groups/${eaOwned.id}/competitions`);
    expect(r.ok(), `group competitions: ${r.status()} ${await r.text()}`).toBeTruthy();
    const names = (await r.json()).competitions.map(c => c.name);
    expect(names, "the event they organise is offered to bind to").toContain(w.mine.name);
    expect(names, "the decoy event is NOT").not.toContain(w.theirs.name);
    expect(names, "nor is the seeded fixture, which is nobody's grant here").not.toContain("Test Live");

    // CONTROL: both events are live and bindable — it is the scope that hides one.
    const sup = await w.sa.get(`/api/admin/groups/${eaOwned.id}/competitions`);
    const supNames = (await sup.json()).competitions.map(c => c.name);
    expect(supNames).toContain(w.mine.name);
    expect(supNames).toContain(w.theirs.name);
    // …and the seeded fixture really IS live and bindable, so its absence above is
    // the scope narrowing rather than a competition nobody is ever offered (this
    // endpoint drops every ENDED event, so the negative would otherwise be free).
    expect(supNames, "the seeded live competition is offered to an unscoped actor").toContain("Test Live");

    // The empty-scope branch of `scopeFilterSql`, on a group the actor owns.
    const g = await makeGroup(w.zeroApi, w.zeroCsrf, "zero-bind");
    const z = await w.zeroApi.get(`/api/admin/groups/${g.id}/competitions`);
    expect(z.ok(), `zero group competitions: ${z.status()}`).toBeTruthy();
    const zc = (await z.json()).competitions;
    expect(zc.length, `a grantless actor was offered ${zc.length} events to bind to`).toBe(0);
  });

  test("a competition's group list is refused for a decoy event and served for a granted one", async () => {
    const bad = await w.eaApi.get(`/api/admin/competitions/${w.theirs.id}/groups`);
    // Refused by NAME rather than answered with an empty list: on an admin
    // surface "no groups" and "not your event" are indistinguishable, and one of
    // them is a bug the organiser would chase.
    await expectRefused(bad, "reading a decoy event's groups", "event_admin_out_of_scope");

    const good = await w.eaApi.get(`/api/admin/competitions/${w.mine.id}/groups`);
    expect(good.ok(), `own event's groups: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await good.json()).groups.map(g => g.id), "…and it really lists the binding").toContain(saMine.id);

    // CONTROL: the refused route works for the superadmin on the same event.
    const sup = await w.sa.get(`/api/admin/competitions/${w.theirs.id}/groups`);
    expect(sup.ok(), `superadmin on the decoy event: ${sup.status()}`).toBeTruthy();
    expect((await sup.json()).groups.map(g => g.id)).toContain(saTheirs.id);
  });

  test("unbinding checks BOTH ends — the event, and the group's other bindings", async () => {
    // (a) the EVENT side.
    const badComp = await w.eaApi.delete(
      `/api/admin/competitions/${w.theirs.id}/groups/${saTheirs.id}`, { headers: H(w.eaCsrf) });
    await expectRefused(badComp, "unbinding on a decoy event", "event_admin_out_of_scope");

    // (b) the GROUP side, and this is the arm a reader would call redundant: the
    // event IS in scope, but unbinding reconciles membership across every event
    // the group is bound to, so it is the same transitive write as a rename.
    const badGroup = await w.eaApi.delete(
      `/api/admin/competitions/${w.mine.id}/groups/${shared.id}`, { headers: H(w.eaCsrf) });
    await expectRefused(badGroup, "unbinding a shared group from your own event", "event_admin_group_shared");

    // Nothing was destroyed by EITHER refusal — and the decoy half is the one a
    // reader forgets: `badComp` targets it, and no later test in this file reads
    // that binding back, so a refusal landing after the DELETE would go unnoticed.
    const stillTheirs = await w.sa.get(`/api/admin/competitions/${w.theirs.id}/groups`);
    expect((await stillTheirs.json()).groups.map(g => g.id),
      "the refused decoy unbind left that binding intact").toContain(saTheirs.id);
    const still = await w.sa.get(`/api/admin/competitions/${w.mine.id}/groups`);
    expect((await still.json()).groups.map(g => g.id),
      "a refused unbind leaves the binding intact").toContain(shared.id);

    // CONTROL: both ends in scope → the unbind works, so the two refusals above
    // are not satisfied by a route that unbinds nothing for anybody.
    const g = await makeGroup(w.sa, w.saCsrf, "unbind-me");
    await bindGroup(w.sa, w.saCsrf, g.id, w.mine.id);
    const good = await w.eaApi.delete(
      `/api/admin/competitions/${w.mine.id}/groups/${g.id}`, { headers: H(w.eaCsrf) });
    expect(good.ok(), `in-scope unbind: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await good.json()).unbound, "…and it really removed the binding").toBe(true);
  });

  // ── the tier is re-read per request ───────────────────────────────────────

  test("revoking the last grant closes the group surface on the very next request", async () => {
    // The scope is re-read per request rather than at session expiry, so a
    // demotion takes effect immediately. Its own account, so nothing this file
    // asserts elsewhere moves under it.
    const solo = await makeParticipant(w.sa, w.saCsrf, "revoke");
    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, solo.id);
    const s = await apiLogin(solo.email, PARTICIPANT_PASS);

    const before = (await listGroups(s.api)).map(g => g.id);
    expect(before, "precondition: the grant really opens the bound group").toContain(saMine.id);

    const rev = await w.sa.delete(`/api/admin/competitions/${w.mine.id}/admins/${solo.id}`, {
      headers: H(w.saCsrf),
    });
    expect(rev.ok(), `revoke: ${rev.status()} ${await rev.text()}`).toBeTruthy();

    const after = (await listGroups(s.api)).map(g => g.id);
    expect(after, "the bound group is gone the moment the grant is").not.toContain(saMine.id);
    // …and they are still an event admin, with zero grants — the resting state
    // (§8), not a demotion. So this is the scope closing, not the tier.
    expect((await (await s.api.get("/api/admin/me")).json()).isEventAdmin).toBe(true);
  });
});
