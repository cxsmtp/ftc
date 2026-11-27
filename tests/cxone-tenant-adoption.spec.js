// @ts-check
//
// A CHECKMARX ONE ACCOUNT THE TENANT HAS TAKEN INTO USE IS HELD, NOT REMOVED —
// AND "TAKEN INTO USE" NOW INCLUDES ITS ROLES, ITS DETAILS AND ITS CREDENTIALS.
//
// The finding (external audit, finding 2): the withdrawal runner's adoption
// check (lib/cxone-withdraw.js, step 8) read sign-in links, the address and
// group memberships, and nothing else. An account the platform created that the
// tenant's administrator then gave a role directly — the commonest way a tenant
// puts an account to use — was deleted like an untouched one (reproduced: the
// runner's calls were token, record, federated identity, groups, DELETE).
//
// The operator's rulings (19 Oct 2026), and the arms that hold each:
//   HOLDS adopted_by_tenant — a direct realm role beyond the default role and the
//     creation baseline, any direct client role beyond the baseline (A1, A2,
//     A3); the default role taken away and not explained by the baseline (A4);
//     an attribute key only an administrator can set (A9, A10; one the realm's
//     profile would not classify is its own sign, A10); a credential created
//     after the deletion was scheduled (A11b, dated inside the windows a wrong
//     anchor gets wrong), or dated by the realm's clock inside the margin before
//     it that a realm running behind ours needs (A11c).
//   DOES NOT HOLD — ordinary self-use (A11).
//   When the key cannot PROVE it sees every role — the realm-management client
//     with access.view true — the overridable hold roles_unreadable, asked
//     always and last, on the way to a DELETE, so visible evidence wins (A5, A7,
//     A8; the hand-over it never blocks is tests/cxone-erasure-withdrawal.spec.js
//     arm 12).
//   The creation baseline: what a created account carried as its job finished,
//     role ids and attribute names only, read by the job and written owner- and
//     claim-bound (A12-A15); a part it could not read explains nothing (A14b),
//     and a default role it recorded is known by that id alone (A4b).
// Every hold arm has its removed CONTROL, or "held" is satisfied by a runner
// that holds everything; every arm asserts the cascade stamped the row, or "no
// DELETE" is satisfied by a scenario that never reached the runner.
//
// Driven through tests/cxone-provision-harness.cjs (see
// tests/cxone-grant-after-delete.spec.js for why nothing reaches this code
// through the server). The pure rules (lib/cxone-identity.js) are tabled at the
// end, at module scope.
const { test, expect } = require("./isolated-test");
const { provision } = require("./cxone-harness-client");
const I = require("../lib/cxone-identity");

const ID = "5e1f0c2a-7b3d-4e8f-9a01-23456789abcd";
const TOKEN_T1 = "POST /auth/realms/tenant1/protocol/openid-connect/token";
const GET_USER = `GET /users/${ID}`;
const GET_FED = `GET /users/${ID}/federated-identity`;
const GET_GROUPS = `GET /users/${ID}/groups?first=0&max=100`;
const GET_DEFAULTS = "GET /default-groups";
const GET_ROLES = `GET /users/${ID}/role-mappings`;
const GET_CREDS = `GET /users/${ID}/credentials`;
const GET_CLIENTS = "GET /clients?clientId=realm-management&first=0&max=1";
const GET_PROFILE = "GET /users/profile";
const DEL = `DELETE /users/${ID}`;
const UPTO_ROLES = [TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_ROLES];
const ADOPTION_CLEAN = [...UPTO_ROLES, GET_CREDS, GET_CLIENTS];
const FULL_WITHDRAWAL = [...ADOPTION_CLEAN, DEL];
const EMAIL = "erin.erased@acme.test";

const DEFAULT_ROLE = { id: "rr-default-tenant1", name: "default-roles-tenant1", composite: true, clientRole: false, containerId: "tenant1" };
const PRISTINE = { realmMappings: [DEFAULT_ROLE] };
const withRealm = (...roles) => ({ realmMappings: [DEFAULT_ROLE, ...roles] });
const AST_CLIENT = { "ast-app": { id: "cl-ast", client: "ast-app", mappings: [{ id: "cr-scan", name: "ast-scanner" }] } };
const profileWith = (attrs, extra = {}) => ({ attributes: [
  ...["username", "email", "firstName", "lastName"].map((name) => ({ name, permissions: { view: ["admin", "user"], edit: ["admin", "user"] } })),
  ...attrs], ...extra });

const rowOf = (ledger, id = ID) => (ledger || []).find(r => r.cxone_user_id === id) || null;
const listRow = (list) => (list || []).find(r => r.cxone_user_id === ID) || null;

/** One created account, provisioned, then erased by the real cascade (step 0), then `steps`. */
function erased(S = {}, steps = []) {
  const o = provision({ createdId: ID, autorun: true, ...S, steps: ["cascade", "snapshot", ...steps] });
  const c = o.stepLog[0];
  expect(c && c.step === "cascade" && c.result && c.result.cxoneWithdrawalsScheduled, `precondition: the cascade stamped the row: ${o.dump()}`).toBe(1);
  expect(o.alive).toBe(false);
  return o;
}

/** Held as adopted by the tenant for `signal` after step 0's calls `calls`, no DELETE, no attempt charged. */
function heldAdopted(o, signal, calls) {
  expect(o.stepCalls(0), o.dump()).toEqual(calls);
  expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", held_signal: signal,
    attention: 1, attempts: 0, last_error: null });
  expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([expect.objectContaining({ reason: "adopted_by_tenant", signal })]);
  expect(o.stepCalls(0), "no DELETE on the hold").not.toContain(DEL);
}

/** Removed in step 0 after exactly `calls` (ending in the DELETE), the row gone with it. */
function removed(o, calls = FULL_WITHDRAWAL) {
  expect(o.stepCalls(0), o.dump()).toEqual(calls);
  expect(o.ledger, o.dump()).toEqual([]);
  expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "deleted" })]);
}

/** A transient failure in step 0: retrying, one attempt, `last_error`, no hold, no DELETE. */
function transient(o, lastError, calls) {
  if (calls) expect(o.stepCalls(0), o.dump()).toEqual(calls);
  expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ attempts: 1, attention: 0, held_reason: null,
    held_signal: null, last_error: lastError });
  expect(o.stepCalls(0), "no DELETE on a failed read").not.toContain(DEL);
}

/** PRECONDITION for the dated-credential arms: every "beforeDeletion" fell after
 *  the account's creation and before the runner's clock margin, every
 *  "withinMargin" inside that margin, and every "afterDeletion" before the read
 *  — the windows an anchor on the creation, on the bare deletion, or on "now",
 *  would get wrong. */
function credWindows(o) {
  expect(o.credsDated.length, `precondition: the credentials were dated: ${o.dump()}`).toBeGreaterThanOrEqual(1);
  for (const d of o.credsDated) {
    expect(d.marginMs, `precondition: the runner allows for a realm clock behind ours: ${JSON.stringify(d)}`).toBeGreaterThan(0);
    const edge = d.pendingMs - d.marginMs;
    expect(d.provenanceMs < d.before && d.before < edge && edge < d.within && d.within < d.pendingMs
      && d.pendingMs < d.after && d.after < d.readMs,
    `precondition: creation < before < deletion − margin < within < deletion < after < read: ${JSON.stringify(d)}`).toBe(true);
  }
}
// The account made well before the deletion's clock margin, so "before" has
// room (the realm's own record moves with it, so provenance still matches).
const APART = { backdateCreationMs: 60 * 60 * 1000 };

test.describe("finding 2 — a role given directly holds the account", () => {
  test("A1 (THE FINDING): a direct realm role beyond the default role → held, the superadmin told WHICH sign; Remove anyway then removes it", () => {
    const o = erased({ roles: withRealm({ id: "rr-admin", name: "admin" }) }, ["list", { retry: true, override: true }]);
    heldAdopted(o, "role_mapping", UPTO_ROLES);
    const r = listRow(o.stepLog[2].result);
    expect(r, o.dump()).toMatchObject({ state: "held", reason: "adopted_by_tenant", overridable: true, held_signal: "role_mapping" });
    expect(r.held_signal_text).toMatch(/given a role directly/);
    expect(r.remedy).toMatch(/given it a role directly/);
    expect(o.stepLog[3].result, o.dump()).toMatchObject({ ok: true, overridden: "adopted_by_tenant" });
    // The override answers step 8 whole: nothing about adoption is read again.
    expect(o.stepCalls(3), o.dump()).toEqual([TOKEN_T1, GET_USER, DEL]);
    expect(o.ledger).toEqual([]);
  });

  test("A1 CONTROL: the same account with only the default role is removed", () => {
    removed(erased());
  });

  test("A2: a direct CLIENT role → held, and the visibility probe is never needed", () => {
    heldAdopted(erased({ roles: { ...PRISTINE, clientMappings: AST_CLIENT } }), "role_mapping", UPTO_ROLES);
  });

  test("A2 CONTROL: a client role the account had at creation is the baseline's — removed, and the probe is STILL asked (no 'a visible role proves visibility' shortcut)", () => {
    const o = erased({ rolesAtCreate: { ...PRISTINE, clientMappings: AST_CLIENT }, roles: { ...PRISTINE, clientMappings: AST_CLIENT } });
    removed(o);
    expect(o.stepCalls(0), "the probe ran").toContain(GET_CLIENTS);
  });

  test("A3: the default role is told apart by its exact name — an imported realm's '-<digits>' passes, anything else is foreign", () => {
    // No baseline (both creation reads fail), so the name rule alone decides.
    const NOBASE = { getUserAtCreate: 500, rolesAtCreateStatus: 503 };
    expect(rowOf(provision({ createdId: ID, ...NOBASE }).ledger).created_baseline, "precondition: no baseline").toBeNull();
    removed(erased({ ...NOBASE, roles: { realmMappings: [{ id: "rr-x", name: "default-roles-tenant1-1" }] } }));
    for (const name of ["default-roles-tenant2", "default-roles-tenant1-x", "default-roles-tenant1extra", "Default-Roles-Tenant1"]) {
      const o = erased({ ...NOBASE, roles: { realmMappings: [{ id: "rr-x", name }] } });
      heldAdopted(o, "role_mapping", UPTO_ROLES);
    }
  });

  test("A4: the default role taken away — an empty realmMappings is the tenant's doing, never 'unreadable' — held as default_role_removed", () => {
    for (const roles of [{}, { realmMappings: [] }, { realmMappings: [], clientMappings: {} }]) {
      const o = erased({ roles });
      heldAdopted(o, "default_role_removed", UPTO_ROLES);
      expect(listRow(o.list), o.dump()).toMatchObject({ reason: "adopted_by_tenant", held_signal: "default_role_removed" });
    }
  });

  test("A4 CONTROLS: an account that had no default role at creation, and a default role renamed since (known by its id), are removed", () => {
    removed(erased({ rolesAtCreate: { realmMappings: [] }, roles: {} }));
    removed(erased({ roles: { realmMappings: [{ ...DEFAULT_ROLE, name: "default-roles-oldname" }] } }));
  });

  test("A4b: with the default role's id recorded, a role that only carries the default's NAME is a role given directly → held", () => {
    for (const roles of [withRealm({ id: "rr-lookalike", name: "default-roles-tenant1-1" }),
      { realmMappings: [{ id: "rr-lookalike", name: "default-roles-tenant1" }] }]) {
      heldAdopted(erased({ roles }), "role_mapping", UPTO_ROLES);
    }
  });

  // A realm renamed since its default role was made: that role keeps the old
  // name, so at creation none bears the default's name — the baseline records
  // that it does not know which realm role is the default, not "had none".
  const RENAMED = { id: "rr-old-default", name: "default-roles-oldname" };
  test("A4c: a renamed realm's default role, taken away since → held default_role_removed; CONTROL: still there → removed", () => {
    const AT = { rolesAtCreate: { realmMappings: [RENAMED] } };
    const p = provision({ createdId: ID, ...AT });
    expect(JSON.parse(rowOf(p.ledger).created_baseline), "precondition: the default is unknown, not absent")
      .toMatchObject({ realm: [RENAMED.id], default_role: null });
    heldAdopted(erased({ ...AT, roles: { realmMappings: [] } }), "default_role_removed", UPTO_ROLES);
    removed(erased({ ...AT, roles: { realmMappings: [RENAMED] } }));
  });
});

test.describe("finding 2 — the key must PROVE it sees every role (roles_unreadable)", () => {
  for (const [label, S] of [
    ["the realm-management client is not listed", { clients: [] }],
    ["listed with no `access` at all", { clients: [{ id: "cl-rm", clientId: "realm-management" }] }],
    ["listed with access.view false", { clients: [{ id: "cl-rm", clientId: "realm-management", access: { view: false } }] }],
    ["another client only", { clients: [{ id: "cl-x", clientId: "account", access: { view: true } }] }],
    ["the probe refused (403)", { clientsStatus: 403 }],
  ]) {
    test(`A5: ${label} → held roles_unreadable (overridable), and Remove anyway then removes it without asking again`, () => {
      const o = erased(S, ["list", { retry: true, override: true }]);
      expect(o.stepCalls(0), o.dump()).toEqual(ADOPTION_CLEAN);
      expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "roles_unreadable", held_signal: null, attention: 1, attempts: 0 });
      expect(o.logOf("cxone_realm_withdrawal_held").map(d => d.reason), o.dump()).toEqual(["roles_unreadable"]);
      expect(Object.keys(o.logOf("cxone_realm_withdrawal_held")[0]), "no adoption sign rides a visibility hold").not.toContain("signal");
      const r = listRow(o.stepLog[2].result);
      expect(r, o.dump()).toMatchObject({ state: "held", reason: "roles_unreadable", overridable: true, held_signal: null, held_signal_text: null });
      expect(r.remedy).toMatch(/view-clients/);
      expect(r.remedy, "the remedy never asks to widen the key to the whole realm").not.toMatch(/view-realm/);
      expect(o.stepLog[3].result, o.dump()).toMatchObject({ ok: true, overridden: "roles_unreadable" });
      expect(o.stepCalls(3), "the override waives only the probe").toEqual([...UPTO_ROLES, GET_CREDS, DEL]);
      expect(o.ledger).toEqual([]);
    });
  }

  for (const [label, S, err] of [
    ["a 401 (the token, not the key)", { clientsStatuses: [401] }, "401/role_visibility_unreadable"],
    ["a 503", { clientsStatuses: [503] }, "503/role_visibility_unreadable"],
    ["no answer at all", { throwAt: "GET /clients" }, "0/role_visibility_unreadable"],
    ["an answer that is not a list", { clientsBodies: [{}] }, "200/role_visibility_unreadable"],
  ]) {
    test(`A5: the probe got ${label} → retried, never held, and removed once it answers`, () => {
      const o = erased(S, [{ run: 2 }]);
      transient(o, err, ADOPTION_CLEAN);
      expect(o.stepCalls(2), o.dump()).toEqual(FULL_WITHDRAWAL);
      expect(o.ledger).toEqual([]);
    });
  }
});

test.describe("finding 2 — a role read that fails is never 'no roles'", () => {
  for (const [label, S, err] of [
    ["a 503", { rolesStatuses: [503] }, "503/role_mappings_unreadable"],
    ["a 401", { rolesStatuses: [401] }, "401/role_mappings_unreadable"],
    ["no answer (the runner's read, after the job's own)", { throwAt: "GET /users/<id>/role-mappings#2" }, "0/role_mappings_unreadable"],
    ["a list instead of an object", { rolesBodies: [[]] }, "200/role_mappings_unreadable"],
    ["realmMappings that is not a list", { rolesBodies: [{ realmMappings: "x" }] }, "200/role_mappings_unreadable"],
    ["a client entry that is not an object", { rolesBodies: [{ ...PRISTINE, clientMappings: { app: "x" } }] }, "200/role_mappings_unreadable"],
  ]) {
    test(`A6: ${label} → retried as transient, never removed on it; removed once it reads`, () => {
      const o = erased(S, [{ run: 2 }]);
      transient(o, err, UPTO_ROLES);
      expect(o.stepCalls(2), o.dump()).toEqual(FULL_WITHDRAWAL);
    });
  }

  test("A6: a 403 on the roles of an account the key just read → needs attention at once, with ITS remedy (not 'may not read its users')", () => {
    const o = erased({ rolesStatus: 403 });
    expect(o.stepCalls(0), o.dump()).toEqual(UPTO_ROLES);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ attempts: 1, attention: 1, held_reason: null, last_error: "403/account_details_refused" });
    const r = listRow(o.list);
    expect(r, o.dump()).toMatchObject({ state: "needs_attention", reason: "account_details_refused", overridable: false });
    expect(r.remedy).toMatch(/refused to show its roles or its sign-in credentials/);
    expect(o.dels).toEqual([]);
  });
});

test.describe("finding 2 — visible evidence first, and it short-circuits", () => {
  test("A7: a foreign group AND no default role → held for the GROUP, roles never read", () => {
    const o = erased({ userGroups: [{ id: "g-x", name: "Tenant-Admins" }], roles: {} });
    heldAdopted(o, "foreign_group", [TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_DEFAULTS]);
  });

  test("A7: a foreign role AND an admin-only detail → held for the ROLE, the profile never read", () => {
    const o = erased({ roles: withRealm({ id: "rr-admin", name: "admin" }), rep: { attributes: { employeeNumber: ["E1"] } } });
    heldAdopted(o, "role_mapping", UPTO_ROLES);
  });

  test("A7: an admin-only detail AND a key that cannot prove it sees roles → held as ADOPTED, the probe never asked", () => {
    const o = erased({ rep: { attributes: { employeeNumber: ["E1"] } }, clients: [] });
    heldAdopted(o, "attribute", [...UPTO_ROLES, GET_PROFILE]);
  });

  test("A7: a credential added after the deletion AND a key that cannot prove it sees roles → held as ADOPTED", () => {
    const o = erased({ ...APART, creds: [{ id: "c1", type: "password", createdDate: "afterDeletion" }], clients: [] });
    credWindows(o);
    heldAdopted(o, "credential_after_deletion", [...UPTO_ROLES, GET_CREDS]);
  });

  test("A7: every earlier signal names itself on the hold", () => {
    for (const [S, signal] of [
      [{ rep: { federationLink: "ldap-1" } }, "federation_link"],
      [{ rep: { email: "someone.new@tenant.test" } }, "email_changed"],
      [{ fed: [{ identityProvider: "okta", userId: "x-1" }] }, "federated_identity"],
      [{ userGroups: Array.from({ length: 100 }, (_, i) => ({ id: `g-${i}`, name: "hackers" })) }, "groups_full_page"],
    ]) {
      const o = erased(S);
      expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", held_signal: signal });
      expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([expect.objectContaining({ reason: "adopted_by_tenant", signal })]);
      expect(typeof listRow(o.list).held_signal_text).toBe("string");
    }
  });
});

test.describe("finding 2 — overrides answer one reason each", () => {
  test("A8: a roles_unreadable override waives only the proof — a role that appears afterwards still holds the account", () => {
    const o = erased({ clients: [], rolesBodies: [PRISTINE, withRealm({ id: "rr-admin", name: "admin" })] },
      [{ retry: true, override: true }, "snapshot"]);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "roles_unreadable" });
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "roles_unreadable" });
    expect(o.stepCalls(2), o.dump()).toEqual(UPTO_ROLES);
    expect(rowOf(o.stepLog[3].result.ledger), o.dump()).toMatchObject({ override_reason: "roles_unreadable",
      held_reason: "adopted_by_tenant", held_signal: "role_mapping" });
    expect(o.dels).toEqual([]);
  });

  test("A8: an adopted_by_tenant override waives the whole adoption check, the proof included", () => {
    const o = erased({ roles: withRealm({ id: "rr-admin", name: "admin" }), clients: [] }, [{ retry: true, override: true }]);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", held_signal: "role_mapping" });
    expect(o.stepCalls(2), o.dump()).toEqual([TOKEN_T1, GET_USER, DEL]);
    expect(o.ledger).toEqual([]);
  });

  test("A8: Remove anyway confirmed against one sign is refused once the account is held for ANOTHER — the row as it is now; against the sign it shows, it goes", () => {
    const o = erased({ rolesBodies: [withRealm({ id: "rr-admin", name: "admin" }), {}] }, [{ retry: true }, "snapshot",
      { retry: true, override: true, expectedSignal: "role_mapping" }, { retry: true, override: true, expectedSignal: null },
      { retry: true, override: true }]);
    expect(rowOf(o.stepLog[3].result.ledger), "precondition: held again, for another sign").toMatchObject({
      held_reason: "adopted_by_tenant", held_signal: "default_role_removed" });
    for (const i of [4, 5]) {
      expect(o.stepLog[i].result, o.dump()).toMatchObject({ status: 409, code: "cxone_withdrawal_hold_changed",
        row: { held_reason: "adopted_by_tenant", held_signal: "default_role_removed" } });
      expect(o.stepLog[i].result.error).toMatch(/something else it found/);
      expect(o.stepCalls(i), "a refused override runs nothing").toEqual([]);
    }
    expect(o.stepLog[6].result, o.dump()).toMatchObject({ ok: true, overridden: "adopted_by_tenant" });
    expect(o.ledger).toEqual([]);
  });

  test("A8: a Retry (no override) clears the recorded sign with the hold, and the next run records what it finds then", () => {
    const o = erased({ rolesBodies: [withRealm({ id: "rr-admin", name: "admin" }), {}] }, [{ retry: true }, "snapshot"]);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_signal: "role_mapping" });
    expect(rowOf(o.stepLog[3].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", held_signal: "default_role_removed" });
    expect(o.logOf("cxone_realm_withdrawal_held").map(d => d.signal), o.dump()).toEqual(["role_mapping", "default_role_removed"]);
  });
});

test.describe("finding 2 — a detail only the tenant's administrator can set holds the account", () => {
  test("A9: an attribute the profile reserves for administrators → held, after one profile read", () => {
    const o = erased({ rep: { attributes: { employeeNumber: ["EMPNO-77"] } },
      profile: profileWith([{ name: "employeeNumber", permissions: { view: ["admin"], edit: ["admin"] } }], { unmanagedAttributePolicy: "ENABLED" }) });
    heldAdopted(o, "attribute", [...UPTO_ROLES, GET_PROFILE]);
    expect(JSON.stringify(o.ledger) + JSON.stringify(o.log), "an attribute VALUE is never kept or logged").not.toContain("EMPNO-77");
  });

  test("A9 CONTROLS: Keycloak's own details need no profile read; a detail the user may edit is read and passes — each removed", () => {
    removed(erased({ rep: { attributes: { locale: ["de"] } } }));
    removed(erased({ rep: { attributes: { disabledReason: ["x"], terms_and_conditions: ["1"], "saml.persistent.name.id.for.app": ["p"] } } }));
    removed(erased({ rep: { attributes: { phone: ["1"] } },
      profile: profileWith([{ name: "phone", permissions: { view: ["admin", "user"], edit: ["admin", "user"] } }]) }),
    [...UPTO_ROLES, GET_PROFILE, GET_CREDS, GET_CLIENTS, DEL]);
  });

  for (const [policy, held] of [["ENABLED", false], ["ADMIN_VIEW", false], ["ADMIN_EDIT", true], [undefined, true], ["SOMETHING_NEW", true]]) {
    test(`A10: an undeclared attribute under unmanagedAttributePolicy ${policy === undefined ? "(absent)" : policy} → ${held ? "held" : "removed"}`, () => {
      const o = erased({ rep: { attributes: { cxCustom: ["1"] } }, profile: profileWith([], policy === undefined ? {} : { unmanagedAttributePolicy: policy }) });
      if (held) heldAdopted(o, "attribute", [...UPTO_ROLES, GET_PROFILE]);
      else removed(o, [...UPTO_ROLES, GET_PROFILE, GET_CREDS, GET_CLIENTS, DEL]);
    });
  }

  for (const st of [400, 403, 404]) {
    test(`A10: a profile the key may not read (${st}) leaves every key standing → held, as a detail NOT checked (never "only its administrator can set")`, () => {
      const o = erased({ rep: { attributes: { phone: ["1"] } }, profileStatus: st });
      heldAdopted(o, "attribute_unverified", [...UPTO_ROLES, GET_PROFILE]);
      const t = listRow(o.list).held_signal_text;
      expect(t).toMatch(/could not check/);
      expect(t, "the words claim nothing the platform did not establish").not.toMatch(/only the tenant's administrator can set\./);
    });
  }

  for (const [label, S, err] of [
    ["a 503", { profileStatuses: [503] }, "503/attributes_unreadable"],
    ["a 401", { profileStatuses: [401] }, "401/attributes_unreadable"],
    ["attributes that are not a list", { profileBodies: [{ attributes: "x" }] }, "200/attributes_unreadable"],
    ["attributes that are an object", { profileBodies: [{ attributes: { phone: {} } }] }, "200/attributes_unreadable"],
    ["a policy that is not text", { profileBodies: [profileWith([], { unmanagedAttributePolicy: 5 })] }, "200/attributes_unreadable"],
    ["an attribute with no name", { profileBodies: [{ attributes: [{}] }] }, "200/attributes_unreadable"],
    ["a JSON null", { profileBodies: [null] }, "200/attributes_unreadable"],
  ]) {
    test(`A10: the profile read gave ${label} → retried, never 'all editable'; removed once a good profile allows the detail`, () => {
      const o = erased({ rep: { attributes: { phone: ["1"] } }, ...S,
        profile: profileWith([{ name: "phone", permissions: { edit: ["user"] } }]) }, [{ run: 2 }]);
      transient(o, err, [...UPTO_ROLES, GET_PROFILE]);
      expect(o.stepCalls(2), o.dump()).toEqual([...UPTO_ROLES, GET_PROFILE, GET_CREDS, GET_CLIENTS, DEL]);
    });
  }

  test("A10: a record whose attributes are not an object → retried before any further read", () => {
    const o = erased({ rep: { attributes: "x" } });
    transient(o, "200/attributes_unreadable", [TOKEN_T1, GET_USER]);
  });
});

test.describe("finding 2 — credentials: only one added after the deletion holds (operator ruling)", () => {
  // DECISION LOCK (operator ruling, 19 Oct 2026): the participant's own use of
  // the account — a password, a one-time code, a passkey, a pending action, a
  // lockout, a verified address — is not the tenant taking it into use.
  test("A11: ordinary self-use is not adoption — disabled by a lockout, pending actions, verified, OTP, credentials it already had → removed", () => {
    const o = erased({ ...APART, rep: { enabled: false, attributes: { disabledReason: ["permanentLockout"] },
      requiredActions: ["UPDATE_PASSWORD", "VERIFY_EMAIL", "CONFIGURE_TOTP"], emailVerified: true, totp: true, firstName: "Erina" },
    creds: [{ id: "c1", type: "password", createdDate: "beforeDeletion" }, { id: "c2", type: "otp", createdDate: "beforeDeletion" },
      { id: "c3", type: "webauthn-passwordless", createdDate: "beforeDeletion" }] });
    credWindows(o);
    removed(o);
  });

  test("A11b: a credential created after the deletion was scheduled → held", () => {
    const o = erased({ ...APART, creds: [{ id: "c1", type: "password", createdDate: "beforeDeletion" }, { id: "c2", type: "otp", createdDate: "afterDeletion" }] });
    credWindows(o);
    heldAdopted(o, "credential_after_deletion", [...UPTO_ROLES, GET_CREDS]);
    expect(listRow(o.list).held_signal_text).toMatch(/after the participant was deleted/);
  });

  // The realm dates a credential by ITS clock, the deletion is dated by ours: a
  // realm running behind would date a credential added just after the deletion
  // a little before it. Inside the margin it holds (the safe side, overridable);
  // A11 above is the control, a credential dated before the margin.
  test("A11c: a credential the realm dates inside the clock margin before the deletion → held, and the words say so", () => {
    const o = erased({ ...APART, creds: [{ id: "c1", type: "password", createdDate: "beforeDeletion" }, { id: "c2", type: "otp", createdDate: "withinMargin" }] });
    credWindows(o);
    heldAdopted(o, "credential_after_deletion", [...UPTO_ROLES, GET_CREDS]);
    expect(listRow(o.list).held_signal_text).toMatch(/or in the 15 minutes before/);
    expect(listRow(o.list).remedy).toMatch(/since the participant was deleted \(or in the 15 minutes before\)/);
  });

  for (const [label, S, err] of [
    ["a 503", { credsStatuses: [503] }, "503/credentials_unreadable"],
    ["no answer", { throwAt: "GET /users/<id>/credentials" }, "0/credentials_unreadable"],
    ["an object instead of a list", { credsBodies: [{}] }, "200/credentials_unreadable"],
    ["a credential with no creation time", { credsBodies: [[{ id: "c1", type: "password" }]] }, "200/credentials_unreadable"],
  ]) {
    test(`A11c: the credentials read gave ${label} → retried, never 'none'; removed once it reads`, () => {
      const o = erased(S, [{ run: 2 }]);
      transient(o, err, [...UPTO_ROLES, GET_CREDS]);
      expect(o.stepCalls(2), o.dump()).toEqual(FULL_WITHDRAWAL);
    });
  }

  test("A11c: a 403 on the credentials → needs attention with the details-refused remedy, no DELETE", () => {
    const o = erased({ credsStatus: 403 });
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ attention: 1, last_error: "403/account_details_refused" });
    expect(listRow(o.list).reason).toBe("account_details_refused");
    expect(o.dels).toEqual([]);
  });
});

test.describe("finding 2 — the creation baseline", () => {
  test("A12: a created account's row records role ids and attribute NAMES from creation — no value, name or address", () => {
    const o = provision({ createdId: ID, createAttributes: { cxSync: ["VALUE-NEVER-STORED"] } });
    expect(o.calls.slice(-3), o.dump()).toEqual([`PUT /users/${ID}/groups/g-1`, GET_USER, GET_ROLES]);
    const raw = rowOf(o.ledger).created_baseline;
    expect(JSON.parse(raw), o.dump()).toEqual({ v: 1, realm: ["rr-default-tenant1"], client: [], attrs: ["cxSync"], default_role: "rr-default-tenant1" });
    for (const pii of ["VALUE-NEVER-STORED", EMAIL, "erin", "erased"]) expect(raw.toLowerCase()).not.toContain(pii.toLowerCase());
    expect(o.provisioned.map(e => e.details), o.dump()).toEqual([expect.objectContaining({ success: true, cxone_user_id: ID, group_assigned: true })]);
  });

  test("A12 CONTROLS: a matched account (409) and an id that is not a UUID record nothing and read nothing back", () => {
    const m = provision({ create: 409, matchId: ID });
    expect(m.ledger).toEqual([]);
    expect(m.calls.filter(c => c.startsWith("GET /users/") && !c.startsWith("GET /users?")), m.dump()).toEqual([]);
    const n = provision({});
    expect(n.ledger).toEqual([]);
    expect(n.calls.filter(c => c.startsWith("GET /users/") && !c.startsWith("GET /users?")), n.dump()).toEqual([]);
  });

  test("A13: what the account carried at creation is not the tenant's doing — removed; the same account with no baseline is held", () => {
    const AT = { rolesAtCreate: withRealm({ id: "rr-cx", name: "cx-user" }), createAttributes: { cxSync: ["1"] } };
    const NOW = { roles: withRealm({ id: "rr-cx", name: "cx-user" }), rep: { attributes: { cxSync: ["2"] } } };
    removed(erased({ ...AT, ...NOW }));
    heldAdopted(erased(NOW), "role_mapping", UPTO_ROLES);
    // …and the baseline explains only what it recorded: a role added since still holds.
    heldAdopted(erased({ ...AT, roles: withRealm({ id: "rr-cx", name: "cx-user" }, { id: "rr-new", name: "auditor" }) }), "role_mapping", UPTO_ROLES);
    heldAdopted(erased({ rep: { attributes: { cxSync: ["2"] } } }), "attribute", [...UPTO_ROLES, GET_PROFILE]);
  });

  test("A14: the creation reads are best-effort — failed, the set-up still succeeds, nothing is recorded, and the rules alone then remove a pristine account", () => {
    const FAIL = { getUserAtCreate: 500, rolesAtCreateStatus: 503 };
    const p = provision({ createdId: ID, ...FAIL });
    expect(p.provisioned.map(e => e.details), p.dump()).toEqual([expect.objectContaining({ success: true, cxone_user_id: ID, group_assigned: true })]);
    expect(p.binding, p.dump()).toMatchObject({ cxone_user_id: ID });
    expect(p.calls.slice(-2), "precondition: both creation reads were made").toEqual([GET_USER, GET_ROLES]);
    expect(rowOf(p.ledger).created_baseline).toBeNull();
    removed(erased(FAIL));
    const THROW = { throwAt: "GET /users/<id>/role-mappings" };
    const b = JSON.parse(rowOf(provision({ createdId: ID, ...THROW }).ledger).created_baseline);
    expect(b, "the part read is kept; the part that failed is unknown").toEqual({ v: 1, realm: null, client: null, attrs: [], default_role: null });
    removed(erased(THROW));
  });

  // A PARTIAL baseline (the roles read failed at creation, the account read did
  // not) explains nothing about roles: every role rule applies as if there were
  // no baseline at all. Each against A14's pristine control.
  test("A14b: a partial baseline (roles unknown) → a realm role given directly, a client role, and the default role taken away are each held", () => {
    const THROW = { throwAt: "GET /users/<id>/role-mappings" };
    for (const [roles, signal] of [[withRealm({ id: "rr-admin", name: "admin" }), "role_mapping"],
      [{ ...PRISTINE, clientMappings: AST_CLIENT }, "role_mapping"], [{ realmMappings: [] }, "default_role_removed"]]) {
      const o = erased({ ...THROW, roles });
      expect(JSON.parse(rowOf(o.stepLog[1].result.ledger).created_baseline), "precondition: the partial baseline")
        .toEqual({ v: 1, realm: null, client: null, attrs: [], default_role: null });
      heldAdopted(o, signal, UPTO_ROLES);
    }
  });

  // The write is bound to the job's claim AND its owner. A row re-keyed to a
  // living participant while the job reads (the participant it was made for is
  // still there — e.g. a replacement matched it on an address they gave up) ends
  // the claim, so the job's baseline is never written onto somebody else's row.
  test("A15: the row re-keyed to a living participant during a creation read → the job's baseline is NOT written; CONTROL: un-keyed, it is", () => {
    const o = provision({ createdId: ID, plantUsers: [{ id: "u-2" }], transferAt: GET_ROLES.replace(ID, "<id>") });
    expect(o.fired.transferLiving, `precondition: the re-key landed during the read: ${o.dump()}`).not.toBeNull();
    expect(o.alive, "the participant it was made for is still there").toBe(true);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", claim_token: null, created_baseline: null });
    expect(o.calls.slice(-2), "the job finished its reads").toEqual([GET_USER, GET_ROLES]);
    expect(rowOf(provision({ createdId: ID }).ledger).created_baseline, "CONTROL").toEqual(expect.any(String));
  });

  for (const at of [GET_USER.replace(ID, "<id>"), `${GET_USER.replace(ID, "<id>")}:json`, GET_ROLES.replace(ID, "<id>"), `${GET_ROLES.replace(ID, "<id>")}:json`]) {
    test(`A15: erased during the creation read ${at} → abandoned 'during_baseline', the account withdrawn, nothing read or written after`, () => {
      const o = provision({ createdId: ID, autorun: true, deleteUserAt: at });
      expect(o.fired.deleteUser, `precondition: the erasure landed during ${at}: ${o.dump()}`).not.toBeNull();
      expect(o.after, "only the withdrawal follows the erasure").toEqual([DEL]);
      expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "during_baseline", reason: "user_deleted",
        realm_account_withdrawn: true, group_granted: true })]);
      expect(o.events, "no History row is written back for the erased participant").toEqual([]);
      expect(o.ledger).toEqual([]);
    });
  }
});

// ─── The pure rules (lib/cxone-identity.js) ──────────────────────────────────

test.describe("lib/cxone-identity.js — the adoption table", () => {
  test("isRealmDefaultRoleName", () => {
    const T = [["default-roles-tenant1", "tenant1", true], ["default-roles-tenant1", "Tenant1", true], ["default-roles-tenant1-12", "tenant1", true],
      ["default-roles-tenant1-", "tenant1", false], ["default-roles-tenant1-1a", "tenant1", false], ["default-roles-tenant1x", "tenant1", false],
      ["Default-roles-tenant1", "tenant1", false], ["default-roles-tenant2", "tenant1", false], ["", "tenant1", false], [null, "tenant1", false],
      ["default-roles-", "", false], ["default-roles-tenant1", null, false]];
    for (const [n, t, want] of T) expect(I.isRealmDefaultRoleName(n, t), `${n} in ${t}`).toBe(want);
  });

  test("classifyRoleMappings", () => {
    const base = I.parseCreationBaseline(I.buildCreationBaseline({ userRep: {}, roleMappings: { realmMappings: [DEFAULT_ROLE, { id: "rr-cx", name: "cx" }],
      clientMappings: AST_CLIENT }, tenant: "tenant1" }));
    const noDefault = I.parseCreationBaseline(I.buildCreationBaseline({ userRep: {}, roleMappings: { realmMappings: [] }, tenant: "tenant1" }));
    const v = (body, baseline = null) => I.classifyRoleMappings(body, { tenant: "tenant1", baseline }).verdict;
    for (const bad of [null, [], "x", { realmMappings: "x" }, { realmMappings: ["x"] }, { realmMappings: [null] }, { clientMappings: [] },
      { clientMappings: { a: "x" } }, { clientMappings: { a: { mappings: "x" } } }, { clientMappings: { a: { mappings: [1] } } }]) {
      expect(v(bad), JSON.stringify(bad)).toBe("malformed");
    }
    expect(v(PRISTINE)).toBe("clean");
    expect(v({ ...PRISTINE, clientMappings: { a: { id: "x" } } }), "a client entry with no mappings").toBe("clean");
    expect(v({})).toBe("default_role_removed");
    expect(v({}, noDefault), "no default role at creation either").toBe("clean");
    expect(v({}, base), "had one at creation").toBe("default_role_removed");
    expect(v(withRealm({ id: "rr-admin", name: "admin" }))).toBe("role_mapping");
    expect(v(withRealm({ name: "no-id" }))).toBe("role_mapping");
    expect(v({ ...PRISTINE, clientMappings: AST_CLIENT })).toBe("role_mapping");
    expect(v({ realmMappings: [DEFAULT_ROLE, { id: "rr-cx", name: "cx" }], clientMappings: AST_CLIENT }, base), "all explained").toBe("clean");
    expect(v({ realmMappings: [{ ...DEFAULT_ROLE, name: "default-roles-renamed" }] }, base), "the default role by its recorded id").toBe("clean");
    expect(v({ realmMappings: [{ ...DEFAULT_ROLE, name: "default-roles-renamed" }] }), "…and without a baseline it is foreign").toBe("role_mapping");
    expect(v(withRealm({ id: "rr-admin", name: "admin" }), base)).toBe("role_mapping");
    // The default role known by its recorded id ALONE: a look-alike name is a role.
    expect(v(withRealm({ id: "rr-x", name: "default-roles-tenant1-1" }), base), "a look-alike beside it").toBe("role_mapping");
    expect(v({ realmMappings: [{ id: "rr-x", name: "default-roles-tenant1" }] }, base), "a look-alike instead of it").toBe("role_mapping");
    // A PARTIAL baseline — roles unknown — explains no role, and not the default's absence.
    const partial = I.parseCreationBaseline(JSON.stringify({ v: 1, realm: null, client: null, attrs: [], default_role: null }));
    expect(partial, "precondition").toMatchObject({ realm: null, client: null, hadDefaultRole: null });
    expect(v(PRISTINE, partial)).toBe("clean");
    expect(v(withRealm({ id: "rr-admin", name: "admin" }), partial), "a realm role").toBe("role_mapping");
    expect(v({ ...PRISTINE, clientMappings: AST_CLIENT }, partial), "a client role").toBe("role_mapping");
    expect(v({}, partial), "the default role gone").toBe("default_role_removed");
    expect(v({ realmMappings: [] }, I.parseCreationBaseline(JSON.stringify({ v: 1, realm: [], client: null, attrs: [], default_role: false }))),
      "CONTROL: a client part unknown, the realm part known to be empty").toBe("clean");
    // A renamed realm: the default unknown among the roles recorded — gone only when one of them is.
    const renamedAt = I.parseCreationBaseline(I.buildCreationBaseline({ userRep: {},
      roleMappings: { realmMappings: [{ id: "rr-old", name: "default-roles-oldname" }, { id: "rr-cx", name: "cx" }] }, tenant: "tenant1" }));
    expect(renamedAt, "precondition").toMatchObject({ defaultRoleId: null, hadDefaultRole: null });
    expect(v({ realmMappings: [{ id: "rr-old", name: "default-roles-oldname" }, { id: "rr-cx", name: "cx" }] }, renamedAt)).toBe("clean");
    expect(v({ realmMappings: [{ id: "rr-cx", name: "cx" }] }, renamedAt), "one of them gone").toBe("default_role_removed");
    expect(v({}, I.parseCreationBaseline(JSON.stringify({ v: 1, realm: [], client: [], attrs: [], default_role: null }))),
      "an empty set of recorded roles proves nothing").toBe("default_role_removed");
  });

  test("realmManagementVisible — positive only", () => {
    expect(I.realmManagementVisible({})).toBeNull();
    expect(I.realmManagementVisible(null)).toBeNull();
    expect(I.realmManagementVisible([])).toBe(false);
    expect(I.realmManagementVisible([{ clientId: "realm-management" }])).toBe(false);
    expect(I.realmManagementVisible([{ clientId: "realm-management", access: { view: false } }])).toBe(false);
    expect(I.realmManagementVisible([{ clientId: "realm-management", access: { view: "true" } }])).toBe(false);
    expect(I.realmManagementVisible([{ clientId: "account", access: { view: true } }])).toBe(false);
    expect(I.realmManagementVisible([null, { clientId: "realm-management", access: { view: true } }])).toBe(true);
  });

  test("unexplainedAttributeKeys", () => {
    const base = I.parseCreationBaseline(I.buildCreationBaseline({ userRep: { attributes: { cxSync: ["1"] } }, tenant: "tenant1" }));
    expect(I.unexplainedAttributeKeys(undefined)).toEqual({ keys: [] });
    expect(I.unexplainedAttributeKeys(null)).toEqual({ keys: [] });
    for (const bad of ["x", [], 1]) expect(I.unexplainedAttributeKeys(bad)).toEqual({ malformed: true });
    expect(I.unexplainedAttributeKeys({ username: [], email: [], firstName: [], lastName: [], locale: [], disabledReason: [],
      terms_and_conditions: [], "saml.persistent.name.id.for.x": [], zeta: [], alpha: [], cxSync: [] }, base)).toEqual({ keys: ["alpha", "zeta"] });
    expect(I.unexplainedAttributeKeys({ cxSync: [] })).toEqual({ keys: ["cxSync"] });
  });

  test("adminOnlyAttributeKeys", () => {
    expect(I.adminOnlyAttributeKeys(["a"], null), "an unread profile leaves every key standing").toEqual({ keys: ["a"] });
    // `attributes` that is not a list — iterable or not — is never read as "none declared".
    for (const bad of ["x", [], { attributes: "x" }, { attributes: {} }, { attributes: 5 }, { attributes: [{}] }, { attributes: [{ name: "" }] },
      { attributes: [null] }, { unmanagedAttributePolicy: 5 }]) {
      expect(I.adminOnlyAttributeKeys(["a"], bad), JSON.stringify(bad)).toEqual({ malformed: true });
    }
    const P = (policy, attrs = []) => ({ attributes: attrs, ...(policy === undefined ? {} : { unmanagedAttributePolicy: policy }) });
    expect(I.adminOnlyAttributeKeys(["a"], P(undefined, [{ name: "a", permissions: { edit: ["admin", "user"] } }]))).toEqual({ keys: [] });
    expect(I.adminOnlyAttributeKeys(["a"], P("ENABLED", [{ name: "a", permissions: { edit: ["admin"] } }])), "declared beats the policy").toEqual({ keys: ["a"] });
    expect(I.adminOnlyAttributeKeys(["a"], P("ENABLED", [{ name: "a" }])), "no permissions: not the user's").toEqual({ keys: ["a"] });
    expect(I.adminOnlyAttributeKeys(["a"], P("ENABLED", [{ name: "a", permissions: { edit: "user" } }]))).toEqual({ keys: ["a"] });
    for (const [pol, want] of [["ENABLED", []], ["ADMIN_VIEW", []], ["ADMIN_EDIT", ["u"]], [undefined, ["u"]], [null, ["u"]], ["enabled", ["u"]]]) {
      expect(I.adminOnlyAttributeKeys(["u"], P(pol)), String(pol)).toEqual({ keys: want });
    }
  });

  test("credentialsCreatedAfter", () => {
    expect(I.credentialsCreatedAfter([], 1000)).toEqual({ count: 0 });
    expect(I.credentialsCreatedAfter([{ createdDate: 1000 }, { createdDate: 999 }, { createdDate: 1001 }], 1000)).toEqual({ count: 1 });
    for (const bad of [{}, null, [null], [{}], [{ createdDate: "1001" }], [{ createdDate: NaN }]]) {
      expect(I.credentialsCreatedAfter(bad, 1000), JSON.stringify(bad)).toEqual({ malformed: true });
    }
    expect(I.credentialsCreatedAfter([], NaN), "no deletion time to compare with").toEqual({ malformed: true });
  });

  test("buildCreationBaseline / parseCreationBaseline — caps, unknown parts, and never throwing", () => {
    const b = (o) => I.buildCreationBaseline({ tenant: "tenant1", ...o });
    expect(b({})).toBeNull();
    expect(b({ userRep: "x", roleMappings: [] }), "nothing readable").toBeNull();
    expect(JSON.parse(b({ userRep: { attributes: { k: [] } } }))).toEqual({ v: 1, realm: null, client: null, attrs: ["k"], default_role: null });
    expect(JSON.parse(b({ roleMappings: { realmMappings: [] } }))).toEqual({ v: 1, realm: [], client: [], attrs: null, default_role: false });
    expect(JSON.parse(b({ roleMappings: { realmMappings: [{ id: "rr-old", name: "default-roles-oldname" }] } })).default_role,
      "realm roles, none bearing the default's name: unknown which, never 'had none'").toBeNull();
    const many = Array.from({ length: I.BASELINE_MAX_ENTRIES + 1 }, (_, i) => ({ id: `r-${i}` }));
    expect(JSON.parse(b({ userRep: {}, roleMappings: { realmMappings: many } })).realm, "over the cap: unknown").toBeNull();
    const long = "k".repeat(I.BASELINE_MAX_STRING + 1);
    expect(JSON.parse(b({ userRep: { attributes: { [long]: [] } }, roleMappings: PRISTINE })).attrs).toBeNull();
    expect(JSON.parse(b({ userRep: {}, roleMappings: { realmMappings: [{ name: "no-id" }] } })).realm).toBeNull();
    for (const bad of [null, 1, "", "{", "[]", JSON.stringify({ v: 2, realm: [] }), JSON.stringify({ realm: [] })]) {
      expect(I.parseCreationBaseline(bad), String(bad)).toBeNull();
    }
    const p = I.parseCreationBaseline(JSON.stringify({ v: 1, realm: ["a"], client: "x", attrs: [1], default_role: "zz" }));
    expect(p, "bad parts are unknown, and a default role not among the realm ids is unknown").toEqual({
      realm: new Set(["a"]), client: null, attrs: null, defaultRoleId: null, hadDefaultRole: null });
    expect(I.parseCreationBaseline(JSON.stringify({ v: 1, realm: [], client: [], attrs: [], default_role: false })))
      .toMatchObject({ defaultRoleId: null, hadDefaultRole: false });
    expect(I.parseCreationBaseline(JSON.stringify({ v: 1, realm: null, client: [], attrs: [], default_role: false })),
      "with the realm part unknown, so is the default role").toMatchObject({ realm: null, hadDefaultRole: null });
  });
});
