// @ts-check
//
// v8.12.6 (external audit F2) — CHECKMARX ONE ACCESS GRANTED AFTER A LOCAL DELETION.
//
// `cxOneProvisionUser` is a chain of upstream awaits: the token, `POST /users`,
// on a 409 up to four searches, `GET /groups` and its body read, the grant.
// v8.11.1 (F6) re-asked "does this participant still exist?" at THREE points,
// the last one BEFORE the group lookup — so a deletion landing during the
// lookup, the grant or a search still reached the grant, wrote a
// `cxone_provisioned` row back into the history the GDPR cascade had just
// emptied (on the failure path with the erased email in `error`), and kept
// sending the erased nickname and address to the customer's realm. The fix asks
// after EVERY await, withdraws the one realm account THIS run created, and (the
// operator's sibling ruling) also stops when the participant is removed from
// the event, the event is deleted, or its Checkmarx One opt-out is ticked.
//
// THE FIRST BEHAVIOURAL LOCK IN THE SUITE TO REACH `cxOneProvisionUser`, and how.
// Nothing reaches it through the server — `CXONE_HOSTNAME_ALLOWED` refuses a
// localhost IDP — which is why every earlier lock on this module is a SOURCE
// lock. tests/cxone-provision-harness.cjs runs ONE scenario per spawned child:
// the transport stubbed on lib/http's exports object before lib/cxone
// destructures it, `globalThis.fetch` poisoned, the mid-flight change made INSIDE
// the stubbed call it is named for. Stubbing a transport is forbidden in a
// Playwright WORKER (db.js opens the database at require time; the stub would
// leak into every spec the worker runs); in a throwaway child it is harmless.
// No port is bound, so there is no spawner offset to register.
//
// EVERY ARM ASSERTS ITS PRECONDITION — that the change really fired during the
// named call — because a stub key that stops matching (a URL-shape change)
// otherwise turns "nothing happened after the deletion" into a vacuous pass.
// And the abandon line is read from app-*.jsonl AFTER the child has exited:
// lib/log writes through an async stream and the audit mirror is
// setImmediate-deferred, so a read inside the child races both (measured).
const { test, expect } = require("./isolated-test");
const { provision } = require("./cxone-harness-client");

const TOKEN = "POST /auth/realms/tenant1/protocol/openid-connect/token";
const CREATED_DELETE = "DELETE /users/kc-created";

/** PRECONDITION: the erasure really happened, during the call it was named for. */
function erased(o) {
  expect(o.fired.deleteUser, `the deletion never fired — the stub key no longer matches: ${o.dump()}`).not.toBeNull();
  expect(o.alive, "the participant must be gone").toBe(false);
}

test.describe("external audit F2 — CxOne access granted after local account deletion", () => {
  // ── CONTROLS. Without these every refusal below is satisfied by a build that
  //    provisions nobody, or a stub that never reaches the grant. ──────────────
  test("CONTROL: a new account is created, granted the event's group, bound and recorded", () => {
    const o = provision({});
    expect(o.calls, o.dump()).toEqual([TOKEN, "POST /users", "GET /groups?search=hackers", "PUT /users/kc-created/groups/g-1"]);
    expect(o.binding?.cxone_user_id, "the binding names the created account").toBe("kc-created");
    expect(o.provisioned.map(e => [e.details.success, e.details.group_assigned])).toEqual([[true, true]]);
    expect(o.dels, "nothing is ever withdrawn from a living participant").toEqual([]);
    expect(o.abandoned, "and nothing is abandoned").toEqual([]);
  });

  test("CONTROL: a 409 binds the MATCHED account and grants it", () => {
    const o = provision({ create: 409 });
    expect(o.puts, o.dump()).toEqual(["PUT /users/kc-pre-existing/groups/g-1"]);
    expect(o.binding?.cxone_user_id).toBe("kc-pre-existing");
    expect(o.provisioned.map(e => e.details.success)).toEqual([true]);
    expect(o.dels).toEqual([]);
    expect(o.abandoned).toEqual([]);
  });

  // ── THE FINDING, and the awaits F6 did not re-ask after. ─────────────────────
  test("THE FINDING: deleted during GET /groups → no grant, the account WE created is withdrawn, nothing resurrected", () => {
    const o = provision({ deleteUserAt: "GET /groups" });
    erased(o);
    expect(o.after.filter(c => c.startsWith("PUT ")), `a grant went out after the erasure: ${o.dump()}`).toEqual([]);
    expect(o.dels, "exactly the account this run created is withdrawn").toEqual([CREATED_DELETE]);
    expect(o.events, "no row may be written back into the erased history").toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_group_grant", reason: "user_deleted",
      cxone_user_id: "kc-created", created_by_this_job: true, realm_account_withdrawn: true }]);
  });

  test("the ask sits AFTER the lookup's body read, not merely after the fetch", () => {
    // fetch resolves at the headers; `.json()` is an await of its own (v7.15.15).
    const o = provision({ deleteUserAt: "GET /groups:json" });
    erased(o);
    expect(o.puts, o.dump()).toEqual([]);
    expect(o.dels).toEqual([CREATED_DELETE]);
    expect(o.events).toEqual([]);
    expect(o.abandoned.map(a => a.stage)).toEqual(["before_group_grant"]);
  });

  test("409: deleted during GET /groups → no grant, and the MATCHED account is never deleted", () => {
    const o = provision({ create: 409, deleteUserAt: "GET /groups" });
    erased(o);
    expect(o.puts, o.dump()).toEqual([]);
    expect(o.dels, "a pre-existing customer account is not ours to delete").toEqual([]);
    expect(o.events).toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_group_grant", reason: "user_deleted",
      cxone_user_id: "kc-pre-existing" }]);
  });

  test("deleted during POST /users → no group lookup is sent, and the account is withdrawn", () => {
    const o = provision({ deleteUserAt: "POST /users" });
    erased(o);
    expect(o.after, o.dump()).toEqual([CREATED_DELETE]);
    expect(o.events).toEqual([]);
    expect(o.abandoned.map(a => [a.stage, a.realm_account_withdrawn])).toEqual([["before_group_lookup", true]]);
  });

  test("deleted during the grant → the account (and the grant with it) is withdrawn, no row written", () => {
    const o = provision({ deleteUserAt: "PUT grant" });
    erased(o);
    expect(o.dels, o.dump()).toEqual([CREATED_DELETE]);
    expect(o.events, "no cxone_provisioned row after the grant").toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_record", reason: "user_deleted",
      cxone_user_id: "kc-created", created_by_this_job: true, realm_account_withdrawn: true, group_granted: true }]);
  });

  test("409: deleted during the grant → recorded as granted, never undone, no row written", () => {
    const o = provision({ create: 409, deleteUserAt: "PUT grant" });
    erased(o);
    expect(o.dels, o.dump()).toEqual([]);
    expect(o.events).toEqual([]);
    expect(o.abandoned.map(a => [a.stage, a.group_granted, "realm_account_withdrawn" in a]))
      .toEqual([["before_record", true, false]]);
  });

  test("the CATCH path: deleted during a failing lookup → withdrawn, no failure row", () => {
    const o = provision({ groups: 500, deleteUserAt: "GET /groups" });
    erased(o);
    expect(o.dels, o.dump()).toEqual([CREATED_DELETE]);
    expect(o.events, "no success:false row resurrected either").toEqual([]);
    // cxUserId is hoisted above the try precisely so this line can name it.
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "on_error", reason: "user_deleted",
      cxone_user_id: "kc-created", created_by_this_job: true, realm_account_withdrawn: true }]);
  });

  test("409 search: deleted during the first search → no further query, no refusal row", () => {
    const o = provision({ create: 409, search: "conflict", deleteUserAt: "GET /users" });
    erased(o);
    expect(o.after, `the erased nickname/address kept going to the realm: ${o.dump()}`).toEqual([]);
    expect(o.events).toEqual([]);
    expect(o.abandoned.map(a => a.stage)).toEqual(["during_search"]);
  });

  test("409 search: deleted during an empty search → the email query is never sent", () => {
    const o = provision({ create: 409, search: "empty", deleteUserAt: "GET /users" });
    erased(o);
    expect(o.after, o.dump()).toEqual([]);
    expect(o.calls.some(c => c.includes("email=")), "the address must not leave after the erasure").toBe(false);
    expect(o.events).toEqual([]);
  });

  test("deleted during the LAST search → the erased address is neither logged nor written back", () => {
    // The not-found / refusal messages name the participant's nickname and email;
    // the ask in the catch sits BEFORE the console line and the failure row.
    const o = provision({ create: 409, search: "empty", deleteUserAt: "GET /users#2" });
    erased(o);
    expect(o.after, o.dump()).toEqual([]);
    expect(o.events).toEqual([]);
    expect(o.abandoned.map(a => a.stage)).toEqual(["on_error"]);
    expect(o.appLog.filter(l => l.includes(o.email)), "the erased address was re-logged after the erasure").toEqual([]);
  });

  test("CONTROL: the same failed search for a LIVING participant is logged and recorded as before", () => {
    // Without this, "the address was not logged" is satisfied by a log reader
    // that sees nothing, or a scenario that never reaches the catch.
    const o = provision({ create: 409, search: "empty" });
    expect(o.alive).toBe(true);
    expect(o.provisioned.map(e => e.details.success), o.dump()).toEqual([false]);
    expect(o.provisioned[0].details.error).toContain(o.email);
    expect(o.appLog.some(l => l.includes("CxOne provisioning error") && l.includes(o.email)),
      "the console line reaches app.jsonl").toBe(true);
    expect(o.abandoned).toEqual([]);
  });

  test("no group configured: deleted during POST /users → the account is still withdrawn", () => {
    const o = provision({ group: "", deleteUserAt: "POST /users" });
    erased(o);
    expect(o.dels, o.dump()).toEqual([CREATED_DELETE]);
    expect(o.events).toEqual([]);
  });

  test("withdrawal REFUSED by the realm is said, not claimed", () => {
    const o = provision({ deleteUserAt: "GET /groups", delStatus: 403 });
    erased(o);
    expect(o.dels, o.dump()).toEqual([CREATED_DELETE]);
    expect(o.abandoned.map(a => a.realm_account_withdrawn)).toEqual([false]);
    expect(o.appLog.some(l => l.includes("could NOT be withdrawn")), "the operator gets an actionable line").toBe(true);
  });

  test("a 404 on the withdrawal means it is already gone — that IS withdrawn", () => {
    const o = provision({ deleteUserAt: "GET /groups", delStatus: 404 });
    erased(o);
    expect(o.abandoned.map(a => a.realm_account_withdrawn), o.dump()).toEqual([true]);
  });

  test("a 201 WITHOUT a Location header → the account found by search is NOT withdrawn (cannot prove we made it)", () => {
    const o = provision({ noLocation: true, deleteUserAt: "GET /groups" });
    erased(o);
    expect(o.dels, o.dump()).toEqual([]);
    expect(o.puts).toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_group_grant", reason: "user_deleted",
      cxone_user_id: "kc-created" }]);
  });

  test("CONTROL: a living participant's failed lookup still records a failure row, with no abandon line", () => {
    const o = provision({ groups: 500 });
    expect(o.alive).toBe(true);
    expect(o.provisioned.map(e => e.details.success), o.dump()).toEqual([false]);
    expect(o.provisioned[0].details.error).toMatch(/GET groups failed \(500\)/);
    expect(o.abandoned).toEqual([]);
  });

  // ── F6's two SILENT checks, now behaviourally reachable. Nothing exists in the
  //    realm yet at either, so they return without an abandon line. ───────────
  test("deleted before the job starts → nothing leaves at all", () => {
    const o = provision({ deleteBefore: true });
    expect(o.alive).toBe(false);
    expect(o.calls, o.dump()).toEqual([]);
    expect(o.events).toEqual([]);
    expect(o.abandoned).toEqual([]);
  });

  test("deleted during the token fetch → POST /users is never sent", () => {
    const o = provision({ deleteUserAt: "TOKEN" });
    erased(o);
    expect(o.calls, o.dump()).toEqual([TOKEN]);
    expect(o.events).toEqual([]);
    expect(o.abandoned, "F6 check 2 stays silent — nothing was created").toEqual([]);
  });

  test("the global-default path (no event): deleted before, and during the token → nothing sent", () => {
    // The membership re-check below also stops an erased participant on the
    // EVENT path (the cascade removes the row), so the no-event path is the one
    // that proves F6's own two checks still hold.
    const before = provision({ globalOnly: true, globalGroup: "GLOBAL-DEFAULT-GROUP", deleteBefore: true });
    expect(before.calls, before.dump()).toEqual([]);
    const during = provision({ globalOnly: true, globalGroup: "GLOBAL-DEFAULT-GROUP", deleteUserAt: "TOKEN" });
    erased(during);
    expect(during.calls, during.dump()).toEqual([TOKEN]);
    expect(during.events).toEqual([]);
  });

  test("CONTROL: the global-default path provisions a living participant", () => {
    const o = provision({ globalOnly: true, globalGroup: "GLOBAL-DEFAULT-GROUP" });
    expect(o.calls, o.dump()).toEqual([TOKEN, "POST /users", "GET /groups?search=GLOBAL-DEFAULT-GROUP", "PUT /users/kc-created/groups/g-global"]);
    expect(o.provisioned.map(e => e.details.success)).toEqual([true]);
  });
});

test.describe("F2 sibling — the EVENT goes away mid-flight", () => {
  test("event deleted, or opted out, before the job starts → nothing leaves, silently (v7.21.15, v7.13.0)", () => {
    // Behavioural at last for the two top-of-function gates, which until this
    // harness were pinned at source only (functional-core-a). The GLOBAL default
    // key is configured, so a gate that let the job through would provision
    // under it — the exact fall-back v7.21.15 names.
    for (const S of [{ deleteCompBefore: true }, { disableBefore: true }]) {
      const o = provision({ ...S, globalKey: true });
      expect(o.calls, `${JSON.stringify(S)}: ${o.dump()}`).toEqual([]);
      expect(o.provisioned).toEqual([]);
      expect(o.abandoned).toEqual([]);
    }
  });

  test("event deleted during POST /users → no lookup, no grant into the GLOBAL group; the living participant is told why", () => {
    // The global default IS configured: with none, "no PUT into the global group"
    // holds vacuously on the shipped code.
    const o = provision({ deleteCompAt: "POST /users", globalGroup: "GLOBAL-DEFAULT-GROUP" });
    expect(o.fired.deleteComp, o.dump()).not.toBeNull();
    expect(o.alive).toBe(true);
    expect(o.after, "nothing after the event deletion").toEqual([]);
    expect(o.puts.some(c => c.includes("g-global")), "a group the event never configured").toBe(false);
    expect(o.provisioned.map(e => e.details.success)).toEqual([false]);
    expect(o.provisioned[0].details.error).toMatch(/event was deleted during provisioning/);
    expect(o.dels, "deleting an event never withdraws an account").toEqual([]);
  });

  test("CONTROL: an EXISTING event with no group of its own still falls back to the global default", () => {
    const o = provision({ group: "", globalGroup: "GLOBAL-DEFAULT-GROUP" });
    expect(o.puts, o.dump()).toEqual(["PUT /users/kc-created/groups/g-global"]);
    expect(o.provisioned.map(e => e.details.success)).toEqual([true]);
  });

  test("event deleted during the token fetch → POST /users is never sent under its key", () => {
    const o = provision({ deleteCompAt: "TOKEN" });
    expect(o.fired.deleteComp, o.dump()).not.toBeNull();
    expect(o.calls, "the participant's name and email must not leave").toEqual([TOKEN]);
    expect(o.provisioned).toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_create", reason: "event_deleted" }]);
  });

  test("event deleted during GET /groups → no grant; the account is left in place, and said so", () => {
    const o = provision({ deleteCompAt: "GET /groups" });
    expect(o.fired.deleteComp, o.dump()).not.toBeNull();
    expect(o.after).toEqual([]);
    expect(o.provisioned).toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_group_grant", reason: "event_deleted",
      cxone_user_id: "kc-created", created_by_this_job: true }]);
  });
});

test.describe("F2 sibling (operator ruling) — removed from the event, or the event opted out", () => {
  const removed = (o) => {
    expect(o.fired.removeMembership, `the removal never fired: ${o.dump()}`).not.toBeNull();
    expect(o.member, "the membership must be gone").toBe(false);
    expect(o.alive, "a removal is not an erasure").toBe(true);
  };

  test("removed before the job starts → nothing leaves, silently", () => {
    const o = provision({ removeMembershipBefore: true });
    expect(o.member).toBe(false);
    expect(o.calls, o.dump()).toEqual([]);
    expect(o.provisioned).toEqual([]);
    expect(o.abandoned).toEqual([]);
  });

  test("removed during the token fetch → POST /users is never sent", () => {
    const o = provision({ removeMembershipAt: "TOKEN" });
    removed(o);
    expect(o.calls, o.dump()).toEqual([TOKEN]);
    expect(o.provisioned).toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_create", reason: "membership_removed" }]);
  });

  test("removed during GET /groups → no grant, and the account is NOT withdrawn", () => {
    // A SECOND event keeps a membership row alive for this participant, so a
    // re-check that forgot the event (`WHERE user_id=?` alone) would still see a
    // member and grant.
    const o = provision({ secondEvent: true, removeMembershipAt: "GET /groups" });
    removed(o);
    expect(o.after, "no grant after the removal").toEqual([]);
    expect(o.dels, "removal from an event has never de-provisioned anybody").toEqual([]);
    expect(o.provisioned).toEqual([]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_group_grant", reason: "membership_removed",
      cxone_user_id: "kc-created", created_by_this_job: true }]);
  });

  test("CONTROL: removal from a DIFFERENT event does not stop this one", () => {
    const o = provision({ secondEvent: true, removeMembershipAt: "GET /groups", removeFrom: "c-2" });
    expect(o.fired.removeMembership, o.dump()).not.toBeNull();
    expect(o.member).toBe(true);
    expect(o.puts).toEqual(["PUT /users/kc-created/groups/g-1"]);
    expect(o.provisioned.map(e => e.details.success)).toEqual([true]);
    expect(o.abandoned).toEqual([]);
  });

  test("the opt-out ticked during the token fetch → no further calls", () => {
    const o = provision({ disableCxoneAt: "TOKEN" });
    expect(o.fired.disableCxone, o.dump()).not.toBeNull();
    expect(o.calls).toEqual([TOKEN]);
    expect(o.abandoned).toEqual([{ competition_id: "c-1", stage: "before_create", reason: "cxone_disabled" }]);
  });

  test("the opt-out ticked during GET /groups → no further calls, nothing withdrawn", () => {
    const o = provision({ disableCxoneAt: "GET /groups" });
    expect(o.fired.disableCxone, o.dump()).not.toBeNull();
    expect(o.after).toEqual([]);
    expect(o.provisioned).toEqual([]);
    expect(o.abandoned.map(a => [a.stage, a.reason, "realm_account_withdrawn" in a]))
      .toEqual([["before_group_grant", "cxone_disabled", false]]);
  });

  test("CONTROL: another event's opt-out does not stop this one", () => {
    const o = provision({ secondEvent: true, disableCxoneAt: "GET /groups", disableOn: "c-2" });
    expect(o.fired.disableCxone, o.dump()).not.toBeNull();
    expect(o.puts).toEqual(["PUT /users/kc-created/groups/g-1"]);
    expect(o.abandoned).toEqual([]);
  });
});
