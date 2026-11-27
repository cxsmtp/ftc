// @ts-check
//
// v8.12.7 (external audit F2) — A DELETED PARTICIPANT'S CHECKMARX ONE ACCOUNT IS
// TAKEN BACK, AND ONLY ONE THIS PLATFORM PROVABLY CREATED.
//
// v8.12.6 withdrew the realm account a provisioning job created only when the
// participant was deleted WHILE that job ran. A deletion afterwards removed
// nothing from the customer's realm. Now every account the platform creates is
// written to `cxone_realm_accounts` at its own 201 (lib/cxone.js), the erasure
// cascade marks the deleted person's rows pending (lib/account-reaper.js), and
// the runner (lib/cxone-withdraw.js) removes each one — after re-reading the
// realm's own record and standing down on every sign that the account is not
// ours to remove: a living participant bound to it, a living holder of its
// address, adoption by the tenant's sign-in provider, or a record that does not
// match what we created.
//
// Driven through tests/cxone-provision-harness.cjs, a spawned child with the
// transport stubbed (see tests/cxone-grant-after-delete.spec.js for why nothing
// reaches this code through the server). Each scenario is one child, one
// throwaway data directory; `steps` run after provisioning, each logged with the
// calls it made, so an arm can say "THIS action made exactly THESE calls".
//
// EVERY ARM ASSERTS ITS PRECONDITION — the deletion fired, the row existed —
// because a scenario that silently stopped reaching the runner would otherwise
// pass every "no DELETE" assertion vacuously.
const { test, expect } = require("./isolated-test");
const crypto = require("crypto");
const { provision } = require("./cxone-harness-client");

// A realm id that IS a UUID, so the ledger records it; the harness default
// ("kc-created") is not, which is what keeps the v8.12.6 arms row-free.
const ID = "5e1f0c2a-7b3d-4e8f-9a01-23456789abcd";
const MATCH_ID = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN_T1 = "POST /auth/realms/tenant1/protocol/openid-connect/token";
const GET_USER = `GET /users/${ID}`;
const GET_FED = `GET /users/${ID}/federated-identity`;
const GET_GROUPS = `GET /users/${ID}/groups?first=0&max=100`;
const GET_DEFAULTS = "GET /default-groups";
const DEL = `DELETE /users/${ID}`;
// Step 8 past the groups: the account's direct roles, its credentials, and the
// key's proof that it sees every role (the realm-management client); the realm's
// user profile only when the record carries an attribute nothing explains.
const GET_ROLES = `GET /users/${ID}/role-mappings`;
const GET_CREDS = `GET /users/${ID}/credentials`;
const GET_CLIENTS = "GET /clients?clientId=realm-management&first=0&max=1";
const GET_PROFILE = "GET /users/profile";
// Every adoption read, all clean — what precedes the address check (step 9) —
// and then, only on the way to a DELETE, the key's proof that it sees every role.
const BEFORE_PROBE = [TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_ROLES, GET_CREDS];
const ADOPTION_CLEAN = [...BEFORE_PROBE, GET_CLIENTS];
// A hand-over to the same person: decided on the realm's own record, before any
// adoption sign or the visibility probe is read.
const HANDED_OVER = [TOKEN_T1, GET_USER];
const FULL_WITHDRAWAL = [...ADOPTION_CLEAN, DEL];
const HOLDER = "holder@acme.test";
// The deleted participant's own address — what the harness's create sends, and
// what the realm's record carries unless an arm changes it.
const EMAIL = "erin.erased@acme.test";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const rowOf = (ledger, id = ID) => (ledger || []).find(r => r.cxone_user_id === id) || null;

/** PRECONDITION: step `i` is the real erasure cascade, and it stamped `n` rows. */
function cascaded(o, i, n) {
  const s = o.stepLog[i];
  expect(s && s.step, `step ${i} is not the cascade: ${o.dump()}`).toBe("cascade");
  expect(o.alive, "the participant must be gone").toBe(false);
  expect(s.result && s.result.cxoneWithdrawalsScheduled, `the cascade stamped the wrong number of rows: ${o.dump()}`).toBe(n);
}

/** PRECONDITION: provisioning recorded exactly the created account, unmarked. */
function recorded(snapshot, dump) {
  const row = rowOf(snapshot.ledger);
  expect(row, `provisioning did not record the created account: ${dump}`).not.toBeNull();
  expect(row.pending_since, "a living participant's row is not pending").toBeNull();
  return row;
}

test.describe("v8.12.7 F2 — the ledger records only accounts this platform provably created", () => {
  test("1: a 201 naming a UUID records ONE confirmed row; nothing is withdrawn from a living participant", () => {
    const o = provision({ createdId: ID, autorun: true, steps: [{ run: 0 }] });
    expect(o.alive).toBe(true);
    expect(o.binding && o.binding.cxone_user_id, o.dump()).toBe(ID);
    expect(o.ledger, o.dump()).toHaveLength(1);
    const row = o.ledger[0];
    expect(row).toMatchObject({
      cxone_user_id: ID, iam_origin: "https://iam.checkmarx.net", tenant: "tenant1", realm_confirmed: 1,
      user_id: "u-1", competition_id: "c-1", created_username: "erin", provenance: "created",
      instance_origin: "http://localhost", pending_since: null, claim_token: null, claimed_at: null,
      // The fingerprint of the address the create SENT — never the address.
      created_email_sha: sha(EMAIL),
    });
    expect(JSON.stringify(o.ledger), "the address itself never enters the ledger").not.toContain(EMAIL);
    expect(Date.parse(row.provenance_at)).toBeGreaterThan(Date.now() - 60_000);
    // The explicit pass selects nothing for a living participant.
    expect(o.stepCalls(0)).toEqual([]);
    expect(o.stepLog[0].result.attempted).toBe(0);
    expect(o.dels).toEqual([]);
  });

  // The record is written AT the 201, before the job's next await — not at the
  // end of the job. Every later deletion that lands during an await is caught by
  // the job's own ask and handed over anyway, so only a process that DIES after
  // the 201 can tell the two apart: this snapshots the ledger as committed at the
  // group lookup, which is what such a crash would leave on disk. The control
  // snapshots at the create itself, so the assertion is about WHEN, not about the
  // end state.
  test("1b: the account is recorded AT the 201 — a process that died during the group lookup would leave it in the ledger", () => {
    const o = provision({ createdId: ID, ledgerAt: "GET /groups" });
    expect(o.fired.snapshotLedger, "precondition: the snapshot fired at the group lookup").not.toBeNull();
    expect(o.ledgerAtFire, o.dump()).toHaveLength(1);
    expect(o.ledgerAtFire[0]).toMatchObject({ cxone_user_id: ID, user_id: "u-1", provenance: "created", pending_since: null });
    expect(o.ledgerAtFire[0].claim_token, "held by the job while it runs").toEqual(expect.any(String));
    const c = provision({ createdId: ID, ledgerAt: "POST /users" });
    expect(c.fired.snapshotLedger, "precondition: the control snapshot fired at the create").not.toBeNull();
    expect(c.ledgerAtFire, "CONTROL: nothing is recorded before the realm has answered").toEqual([]);
    expect(c.ledger, c.dump()).toHaveLength(1);
  });

  test("2: a Location that is not a UUID records no row, and is COUNTED", () => {
    const o = provision({ autorun: true });
    expect(o.binding && o.binding.cxone_user_id, `precondition: the 201's own id was bound: ${o.dump()}`).toBe("kc-created");
    expect(o.ledger).toEqual([]);
    expect(o.unc.id_not_uuid, o.dump()).toBe(1);
    expect(o.unc.no_location + o.unc.non_201 + o.unc.ledger_write_failed).toBe(0);
  });

  test("3: a 2xx that is not a 201 records no row, and is COUNTED", () => {
    const o = provision({ createdId: ID, createStatus: 200, autorun: true });
    expect(o.binding && o.binding.cxone_user_id, `precondition: the Location's id was taken: ${o.dump()}`).toBe(ID);
    expect(o.ledger).toEqual([]);
    expect(o.unc.non_201, o.dump()).toBe(1);
    expect(o.unc.id_not_uuid).toBe(0);
  });
});

test.describe("v8.12.7 F2 — a deletion after provisioning withdraws the account", () => {
  test("4 (THE FINDING): provisioning completes, THEN the cascade — the runner removes the account at its own realm", () => {
    const o = provision({ createdId: ID, autorun: true, steps: ["snapshot", "cascade"] });
    recorded(o.stepLog[0].result, o.dump());
    cascaded(o, 1, 1);
    expect(o.stepCalls(1), o.dump()).toEqual(FULL_WITHDRAWAL);
    for (const c of o.stepCallsFull(1)) expect(c.split(" ")[1], c).toBe("iam.checkmarx.net/tenant1");
    expect(o.ledger, "the row goes with the account").toEqual([]);
    const lines = o.logOf("cxone_realm_account_withdrawn");
    expect(lines, o.dump()).toHaveLength(1);
    expect(lines[0]).toMatchObject({ cxone_user_id: ID, result: "deleted", provenance: "created" });
    expect(o.events, "nothing is written back into the erased history").toEqual([]);
    expect(o.totals.withdrawn).toBe(1);
  });

  test("5: a 409 matched to an existing account records nothing, and its erasure makes no remote call", () => {
    const o = provision({ create: 409, matchId: MATCH_ID, autorun: true, steps: ["snapshot", "cascade", { run: 0 }] });
    expect(o.stepLog[0].result.binding && o.stepLog[0].result.binding.cxone_user_id,
      `precondition: the search's account was bound: ${o.dump()}`).toBe(MATCH_ID);
    expect(o.stepLog[0].result.ledger).toEqual([]);
    cascaded(o, 1, 0);
    expect(o.withdrawCalls, o.dump()).toEqual([]);
    expect(o.ledger).toEqual([]);
  });

  test("6: a 201 with no Location — found by search — records nothing and is never withdrawn", () => {
    const o = provision({ createdId: ID, noLocation: true, autorun: true, steps: ["snapshot", "cascade", { run: 0 }] });
    expect(o.stepLog[0].result.binding && o.stepLog[0].result.binding.cxone_user_id,
      `precondition: the search found the account we made: ${o.dump()}`).toBe(ID);
    expect(o.stepLog[0].result.ledger).toEqual([]);
    expect(o.unc.no_location).toBe(1);
    cascaded(o, 1, 0);
    expect(o.withdrawCalls, o.dump()).toEqual([]);
    expect(o.dels).toEqual([]);
  });

  test("7: a local binding with no ledger row behind it is never withdrawn — the backfill does not source from bindings", () => {
    const o = provision({ noProvision: true, plantBinding: ID, autorun: true,
      steps: ["snapshot", "backfill", "cascade", { run: 0 }] });
    expect(o.stepLog[0].result.binding && o.stepLog[0].result.binding.cxone_user_id, "precondition: the binding is planted").toBe(ID);
    expect(o.stepLog[1].result, o.dump()).toMatchObject({ inserted: 0 });
    cascaded(o, 2, 0);
    expect(o.calls, o.dump()).toEqual([]);
    expect(o.ledger).toEqual([]);
  });

  test("8: ABSENCE IS NOT A DELETION — a row whose user vanished by hand is listed unmarked and untouched until a superadmin retries", () => {
    const o = provision({ noProvision: true, autorun: true, plantLedger: [{ id: ID }],
      steps: ["sqlDeleteUser", { run: 0 }, "list", { retry: ID }] });
    expect(o.stepLog[0].result, "precondition: the user row was deleted by hand").toBe(1);
    expect(o.alive).toBe(false);
    expect(o.stepCalls(1), "a pass makes no call for a row nobody marked").toEqual([]);
    expect(o.stepLog[1].result.attempted).toBe(0);
    const listed = rowOf(o.stepLog[2].result);
    expect(listed, o.dump()).not.toBeNull();
    expect(listed).toMatchObject({ state: "unmarked", reason: "unmarked", pending_since: null });
    // The superadmin decides, and only then does it leave.
    expect(o.stepLog[3].result, o.dump()).toMatchObject({ ok: true });
    expect(o.stepCalls(3), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });

  test("9: an unhealthy instance makes no remote call; the row waits", () => {
    const o = provision({ createdId: ID, autorun: true, healthy: false, steps: ["cascade", { run: 0 }] });
    cascaded(o, 0, 1);
    expect(o.withdrawCalls, o.dump()).toEqual([]);
    expect(o.stepLog[1].result).toMatchObject({ skipped: "unhealthy" });
    const row = rowOf(o.ledger);
    expect(row, o.dump()).not.toBeNull();
    expect(row.pending_since).not.toBeNull();
    expect(row.attempts).toBe(0);
  });
});

test.describe("v8.12.7 F2 — the runner stands down when the account may not be ours", () => {
  for (const [label, rep] of [
    ["created a day before our 201", { createdTimestamp: "old" }],
    ["no creation time at all", { createdTimestamp: null }],
    ["a different username", { username: "someone-else" }],
  ]) {
    test(`10: provenance unconfirmed (${label}) — held, never removed, and NOT overridable`, () => {
      const o = provision({ createdId: ID, autorun: true, rep, steps: ["cascade", { retry: true, override: true }] });
      cascaded(o, 0, 1);
      expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER]);
      const row = rowOf(o.ledger);
      expect(row, o.dump()).not.toBeNull();
      expect(row).toMatchObject({ held_reason: "provenance_unconfirmed", attention: 1, user_id: "u-1" });
      expect(o.stepLog[1].result).toMatchObject({ status: 409, code: "cxone_withdrawal_not_overridable" });
      expect(o.stepCalls(1)).toEqual([]);
      expect(o.dels).toEqual([]);
      expect(o.logOf("cxone_realm_withdrawal_held").map(d => d.reason)).toEqual(["provenance_unconfirmed"]);
    });
  }

  for (const [label, S, calls] of [
    ["a federated identity link", { fed: [{ identityProvider: "okta", userId: "x-1" }] }, [TOKEN_T1, GET_USER, GET_FED]],
    ["a federationLink on the record", { rep: { federationLink: "ldap-1" } }, [TOKEN_T1, GET_USER]],
  ]) {
    test(`11: adopted by the tenant (${label}) — held; a superadmin override then removes it`, () => {
      const o = provision({ createdId: ID, autorun: true, ...S, steps: ["cascade", "snapshot", { retry: true, override: true }] });
      cascaded(o, 0, 1);
      expect(o.stepCalls(0), o.dump()).toEqual(calls);
      expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant" });
      expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "adopted_by_tenant" });
      expect(o.stepCalls(2), o.dump()).toContain(DEL);
      expect(o.ledger).toEqual([]);
    });
  }

  // The holder arms plant the holder AFTER the erasure, with the deleted
  // participant's own address — the realistic shape (they re-register with it),
  // and the only one the unique index allows. The realm still carries the
  // address the create sent, so the email-change hold stays out of the way.
  const holderRun = (holder, S = {}) => provision({ createdId: ID, plantUsers: holder.pre ? [holder.pre] : [], ...S,
    steps: ["cascade", ...(holder.post ? [{ plantUser: holder.post }] : []), { run: 0 }] });
  const SAME = { id: "u-2", email: EMAIL, first_name: " erin ", last_name: "ERASED" };

  test("12: a living holder whose VERIFIED PRIMARY is the address and whose names match gets the account — transferred, never removed", () => {
    const o = holderRun({ post: { id: "u-2", email: EMAIL, first_name: " erin ", last_name: "ERASED" } });
    cascaded(o, 0, 1);
    expect(o.stepCalls(2), "handed over on the realm's record, before any adoption sign or the visibility probe is read").toEqual(HANDED_OVER);
    const row = rowOf(o.ledger);
    expect(row, o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, held_reason: null });
    expect(row.transferred_at).not.toBeNull();
    expect(o.dels).toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "address_held_by_same_person" })]);
  });

  // (pre-release review) — ONLY a verified primary may take an account over. A
  // secondary address or a pending change is written straight from a profile
  // form, and names are free text, so each of these holders matches the realm's
  // names exactly and must still only HOLD it. The reviewer's reproduction is the
  // first: a stranger adds the address as an unverified secondary and copies the
  // names.
  for (const [label, holder] of [
    ["the address as an UNVERIFIED secondary, same names", { pre: { id: "u-2", email: "mallory@evil.test",
      secondary_email: EMAIL, verified: 0, first_name: "erin ", last_name: "ERASED" } }],
    ["the address as a VERIFIED account's secondary, same names", { pre: { id: "u-2", email: "mallory@evil.test",
      secondary_email: EMAIL, first_name: "Erin", last_name: "Erased" } }],
    ["the address as a pending email change, same names", { pre: { id: "u-2", email: "mallory@evil.test",
      pending_email: EMAIL, first_name: "Erin", last_name: "Erased" } }],
    ["the address as an UNVERIFIED primary, same names", { post: { id: "u-2", email: EMAIL, verified: 0,
      first_name: "Erin", last_name: "Erased" } }],
    ["the address as a verified primary, DIFFERENT names", { post: { id: "u-2", email: EMAIL,
      first_name: "Holly", last_name: "Holder" } }],
  ]) {
    test(`12: a living holder of the address (${label}) — held, never taken over, never removed`, () => {
      const o = holderRun(holder);
      cascaded(o, 0, 1);
      expect(o.stepCalls(holder.post ? 2 : 1), o.dump()).toEqual(BEFORE_PROBE);
      expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-1", held_reason: "address_held_by_living_account",
        transferred_at: null });
      expect(o.logOf("cxone_realm_withdrawal_transferred")).toEqual([]);
      expect(o.dels).toEqual([]);
    });
  }

  // The visibility probe guards a DELETE and nothing else, so it never stands
  // between the account and the same person: a key that cannot view the
  // tenant's clients (on some tenants, every key) must not turn each hand-over
  // into a hold whose Remove anyway would then hand it over anyway.
  for (const [label, S] of [["refuses the probe (403)", { clientsStatus: 403 }], ["cannot see the client", { clients: [] }]]) {
    test(`12: the same person still gets the account when the key ${label} — the probe is never asked`, () => {
      const o = holderRun({ post: SAME }, S);
      cascaded(o, 0, 1);
      expect(o.stepCalls(2), o.dump()).toEqual(HANDED_OVER);
      expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, held_reason: null });
      expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
        .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "address_held_by_same_person" })]);
      expect(o.dels).toEqual([]);
    });
  }

  // (operator, 21 Oct 2026) — nor does any sign that the TENANT took the account
  // into use: the same person is handed it before those are weighed. A hand-over
  // removes nothing, and when that participant is deleted in turn, every sign is
  // asked again. Before this, each of these held the account for a superadmin,
  // whose Remove anyway then handed it over regardless.
  for (const [label, S] of [
    ["a role given to it directly", { roles: { realmMappings: [
      { id: "rr-default-tenant1", name: "default-roles-tenant1", composite: true, clientRole: false, containerId: "tenant1" },
      { id: "rr-admin", name: "admin", composite: false, clientRole: false, containerId: "tenant1" }] } }],
    ["a group this platform does not grant", { userGroups: [{ id: "g-x", name: "Tenant-Admins" }] }],
    ["a link to the tenant's sign-in provider", { fed: [{ identityProvider: "okta", userId: "x-1" }] }],
    ["a federationLink on the record", { rep: { federationLink: "ldap-1" } }],
  ]) {
    test(`12: the same person gets the account although the tenant took it into use (${label}) — never held, nothing more read`, () => {
      const o = holderRun({ post: SAME }, S);
      cascaded(o, 0, 1);
      expect(o.stepCalls(2), o.dump()).toEqual(HANDED_OVER);
      expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, held_reason: null, held_signal: null });
      expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([]);
      expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
        .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "address_held_by_same_person" })]);
      expect(o.dels).toEqual([]);
    });
    // CONTROL — the same sign with a holder who is NOT the same person still
    // holds, and as ADOPTED (the sign is weighed before the address hold).
    test(`12 CONTROL: someone else with the address and ${label} — held as taken into use, not handed over`, () => {
      const o = holderRun({ post: { id: "u-2", email: EMAIL, first_name: "Holly", last_name: "Holder" } }, S);
      cascaded(o, 0, 1);
      expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-1", held_reason: "adopted_by_tenant", transferred_at: null });
      expect(o.logOf("cxone_realm_withdrawal_transferred")).toEqual([]);
      expect(o.dels).toEqual([]);
    });
  }

  // The hand-over still rests on the proof that the account is the one the
  // platform made: a realm record that does not match is never handed over.
  test("12 CONTROL: the same person, but the realm's record was not created when the platform's was — provenance holds, never handed over", () => {
    const o = holderRun({ post: SAME }, { rep: { createdTimestamp: "old" } });
    cascaded(o, 0, 1);
    expect(o.stepCalls(2), o.dump()).toEqual(HANDED_OVER);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-1", held_reason: "provenance_unconfirmed", transferred_at: null });
    expect(o.logOf("cxone_realm_withdrawal_transferred")).toEqual([]);
    expect(o.dels).toEqual([]);
  });

  // Remove anyway on an adopted row reaches the same hand-over: the confirm says
  // so (tests/cxone-withdrawals-ui.spec.js), and this is what it describes.
  test("12: Remove anyway on a row held as taken into use, after the same person registered — handed over, not removed", () => {
    const o = provision({ createdId: ID, autorun: true, fed: [{ identityProvider: "okta", userId: "x-1" }],
      steps: ["cascade", { plantUser: SAME }, { retry: true, override: true }] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED]);
    expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([expect.objectContaining({ reason: "adopted_by_tenant", signal: "federated_identity" })]);
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "adopted_by_tenant" });
    expect(o.stepCalls(2), o.dump()).toEqual(HANDED_OVER);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, held_reason: null });
    expect(o.dels).toEqual([]);
  });

  // …and because the probe is an await on the way to the DELETE, the holder is
  // asked again after it: one who registers DURING it is seen.
  for (const [label, who, want] of [
    ["the same person", SAME, "transferred"],
    ["someone else with the address", { id: "u-2", email: EMAIL, first_name: "Holly", last_name: "Holder" }, "held"],
    ["CONTROL: someone with another address", { id: "u-2", email: "someone.else@acme.test", first_name: "Erin", last_name: "Erased" }, "removed"],
  ]) {
    test(`12: ${label} registers DURING the visibility probe → ${want}`, () => {
      const o = provision({ createdId: ID, plantAt: "GET /clients", plantAtUser: who, steps: ["cascade", { run: 0 }] });
      cascaded(o, 0, 1);
      expect(o.fired.plantLate, `precondition: they arrived inside the probe: ${o.dump()}`).not.toBeNull();
      if (want === "removed") {
        expect(o.stepCalls(1), o.dump()).toEqual(FULL_WITHDRAWAL);
        expect(o.ledger).toEqual([]);
        return;
      }
      expect(o.stepCalls(1), o.dump()).toEqual(ADOPTION_CLEAN);
      expect(o.dels).toEqual([]);
      if (want === "transferred") expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
      else expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-1", held_reason: "address_held_by_living_account" });
    });
  }

  test("12 CONTROL: the address with NO living holder is removed", () => {
    const o = holderRun({ post: { id: "u-2", email: "someone.else@acme.test", first_name: "Erin", last_name: "Erased" } });
    cascaded(o, 0, 1);
    expect(o.stepCalls(2), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });

  test("13: a LIVING participant bound to the account locally gets it — with ZERO remote calls", () => {
    const o = provision({ createdId: ID, autorun: true,
      plantUsers: [{ id: "u-2", enrolIn: "c-1", cxoneUserId: ID }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([]);
    const row = rowOf(o.ledger);
    expect(row, o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
  });
});

// ─── Arms 14-26 ──────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (h) => new Date(Date.now() - h * HOUR_MS).toISOString();
// A `cxone_provisioned` history payload the boot backfill accepts — override one
// key to make it a control.
const HIST = (over = {}) => ({ success: true, already_existed: false, cxone_user_id: ID, competition_id: "c-1",
  username: "erin", ...over });
const xid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const realmOf = (full) => full.split(" ")[1];

test.describe("v8.12.7 F2 — a living claim on the account always wins", () => {
  // DECLARED, not locked: the ownership half of the pre-DELETE gate
  // (`_stillMine(...) || _userExists(...)` just above the DELETE) survives its
  // mutation — every path to the DELETE already asks `ours()` right after its
  // last await, and nothing between that ask and the gate is async, so no
  // scenario can change the answer in between. It is defence in depth for the
  // next await somebody adds, and S4 (audit-v8111.spec.js) pins its placement.
  // The LIVING-BINDER half is not redundant, and this arm kills its mutation.
  test("14: a living participant bound to the account DURING the realm read gets it — the pre-DELETE re-check, no DELETE", () => {
    // "#2": the creating job's own read-back of the account (its creation
    // baseline) is the first GET of it; the runner's is the second.
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }], bindAt: "GET /users/<id>#2",
      steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.fired.bindLiving, `precondition: the binding landed inside the realm read: ${o.dump()}`).not.toBeNull();
    expect(o.fired.bindLiving, `precondition: …the RUNNER's read, not the provisioning job's: ${o.dump()}`).toBeGreaterThanOrEqual(o.provisionCalls);
    expect(o.stepCalls(0), o.dump()).toEqual(ADOPTION_CLEAN);
    expect(o.dels).toEqual([]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
  });

  test("15: a LIVING participant matched by email to a pending account takes it AT PROVISIONING — and no later run removes it", () => {
    const B = { id: "u-2", email: "bee@acme.test", first_name: "Bee", last_name: "Living", enrolIn: "c-1" };
    // No autorun: the cascade must not withdraw it before B arrives. The
    // explicit pass at the end runs regardless.
    const o = provision({ noProvision: true, create: 409, matchId: ID, plantLedger: [{ id: ID }], plantUsers: [B],
      steps: ["cascade", "snapshot", { provision: "u-2" }, "snapshot", { run: 0 }] });
    cascaded(o, 0, 1);
    expect(rowOf(o.stepLog[1].result.ledger), `precondition: A's row is pending: ${o.dump()}`)
      .toMatchObject({ user_id: "u-1", pending_since: expect.any(String) });
    expect(o.stepLog[2].result && o.stepLog[2].result.cxone_user_id, `precondition: B was matched to it: ${o.dump()}`).toBe(ID);
    // THE ASSERTION: re-keyed at the match, before any run could see it.
    expect(rowOf(o.stepLog[3].result.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
    expect(o.stepLog[4].result.attempted).toBe(0);
    expect(o.stepCalls(4)).toEqual([]);
    expect(o.dels).toEqual([]);
  });
});

test.describe("v8.12.7 F2 — the right realm, and only the right realm", () => {
  for (const realm of ["tenant2", "eu"]) {
    test(`16: only a ${realm} key cannot reach a tenant1 account — no call, needs attention; a tenant1 key then removes it THERE`, () => {
      const o = provision({ noProvision: true, autorun: true, eventKeyRealm: realm, plantLedger: [{ id: ID }],
        steps: ["cascade", "snapshot", { setGlobalKey: "tenant1" }, { retry: ID }] });
      cascaded(o, 0, 1);
      expect(o.stepCalls(0), o.dump()).toEqual([]);
      expect(rowOf(o.stepLog[1].result.ledger), o.dump())
        .toMatchObject({ attempts: 1, attention: 1, last_error: "0/no_credentials_for_realm" });
      expect(o.logOf("cxone_realm_withdrawal_needs_attention").map(d => d.code)).toEqual(["no_credentials_for_realm"]);
      expect(o.stepLog[3].result, o.dump()).toMatchObject({ ok: true });
      expect(o.stepCalls(3), o.dump()).toEqual(FULL_WITHDRAWAL);
      for (const c of o.stepCallsFull(3)) expect(realmOf(c), c).toBe("iam.checkmarx.net/tenant1");
      expect(o.ledger).toEqual([]);
    });
  }

  test("17: a CONFIRMED realm's 404 means already gone — row deleted, no DELETE", () => {
    const o = provision({ createdId: ID, autorun: true, getUser: 404, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER]);
    expect(o.ledger).toEqual([]);
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "already_gone" })]);
    expect(o.totals.already_gone).toBe(1);
    expect(o.dels).toEqual([]);
  });

  test("17: an UNCONFIRMED realm's 404 is not proof — row kept, needs attention, never 'gone'", () => {
    const o = provision({ noProvision: true, autorun: true, getUser: 404,
      plantLedger: [{ id: ID, realm_confirmed: 0, iam_origin: null, tenant: null }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER]);
    expect(rowOf(o.ledger), o.dump())
      .toMatchObject({ realm_confirmed: 0, attention: 1, last_error: "404/not_found_in_reachable_realms" });
    expect(o.logOf("cxone_realm_account_withdrawn")).toEqual([]);
    expect(o.totals.already_gone).toBe(0);
  });

  test("25: an unconfirmed row is looked for with ITS event's key and the global key — never every key on the platform", () => {
    const o = provision({ noProvision: true, autorun: true, globalKeyRealm: "tenant2",
      extraEvents: [{ id: "c-eu", keyRealm: "eu" }], getUser: { tenant1: 404, tenant2: 404 },
      plantHistory: [{ details: HIST() }], steps: ["backfill", "cascade", { retry: ID, override: true }] });
    expect(o.stepLog[0].result, `precondition: backfilled: ${o.dump()}`).toMatchObject({ inserted: 1 });
    cascaded(o, 1, 1);
    expect(o.stepCalls(1), "held for the instance with no call").toEqual([]);
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "instance_unconfirmed" });
    const gets = o.stepCallsFull(2).filter(c => c.startsWith("GET "));
    expect(gets, o.dump()).toEqual([`GET iam.checkmarx.net/tenant1 /users/${ID}`, `GET iam.checkmarx.net/tenant2 /users/${ID}`]);
    expect(o.stepCallsFull(2).filter(c => realmOf(c).startsWith("eu.")), o.dump()).toEqual([]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ realm_confirmed: 0, last_error: "404/not_found_in_reachable_realms" });
    expect(o.dels).toEqual([]);
  });
});

test.describe("v8.12.7 F2 — failure, back-off and giving up", () => {
  test("18: a transient refusal backs off, needs attention only on the THIRD attempt, then withdraws; kicks inside the back-off make no call", () => {
    const o = provision({ createdId: ID, autorun: true, delStatuses: [503, 503, 503],
      steps: ["cascade", "kick", "kick", "snapshot", { run: 2 }, "snapshot", { run: 5 }, "snapshot", { run: 10 }] });
    cascaded(o, 0, 1);
    const at = (i) => rowOf(o.stepLog[i].result.ledger);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.stepCalls(1), "a kick inside the back-off").toEqual([]);
    expect(o.stepCalls(2), "a second kick inside the back-off").toEqual([]);
    expect(at(3), o.dump()).toMatchObject({ attempts: 1, attention: 0, last_error: "503/delete_failed" });
    expect(o.stepCalls(4)).toEqual(FULL_WITHDRAWAL);
    expect(at(5), o.dump()).toMatchObject({ attempts: 2, attention: 0 });
    expect(o.stepCalls(6)).toEqual(FULL_WITHDRAWAL);
    expect(at(7), o.dump()).toMatchObject({ attempts: 3, attention: 1 });
    expect(o.stepCalls(8)).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
    expect(o.dels).toHaveLength(4);
    expect(o.logOf("cxone_realm_withdrawal_needs_attention").map(d => d.attempts)).toEqual([3]);
  });

  test("19: a refused KEY (token 401) needs attention on the FIRST attempt", () => {
    const o = provision({ createdId: ID, autorun: true, tokenStatus: 401, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ attempts: 1, attention: 1, last_error: "401/token_refused" });
    expect(o.logOf("cxone_realm_withdrawal_needs_attention").map(d => d.code)).toEqual(["token_refused"]);
    expect(o.dels).toEqual([]);
  });

  test("20: failing for over 30 days with 5+ attempts gives up, and says so", () => {
    const o = provision({ noProvision: true, autorun: true, delStatus: 503,
      plantLedger: [{ id: ID, attempts: 5, first_failed_at: hoursAgo(31 * 24) }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    const row = rowOf(o.ledger);
    expect(row, o.dump()).toMatchObject({ attempts: 6, attention: 1, next_attempt_at: "9999-12-31T00:00:00.000Z" });
    expect(row.given_up_at).not.toBeNull();
    expect(o.logOf("cxone_realm_withdrawal_given_up"), o.dump()).toEqual([expect.objectContaining({ attempts: 6 })]);
  });

  test("20: HELD for 40 days, then a 503, is NOT given up — the clock is the first failure, not the deletion", () => {
    const o = provision({ noProvision: true, autorun: true, delStatus: 503,
      plantLedger: [{ id: ID, pending_since: hoursAgo(40 * 24), attempts: 4, first_failed_at: hoursAgo(2) }],
      steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    const row = rowOf(o.ledger);
    expect(row, o.dump()).toMatchObject({ attempts: 5, given_up_at: null });
    expect(Date.parse(row.pending_since), "precondition: the deletion is 40 days old").toBeLessThan(Date.now() - 39 * 24 * HOUR_MS);
    expect(o.logOf("cxone_realm_withdrawal_given_up")).toEqual([]);
  });

  test("26: nothing the realm says about a person reaches the log or the ledger — last_error is a status and a code", () => {
    const LEAK = { email: "zq.leak@nowhere.test", firstName: "Qzxleaky", lastName: "Vwysecret" };
    // Recorded with the fingerprint of the address the realm carries, so the
    // email-change hold lets the run reach the DELETE whose refusal is under test.
    const o = provision({ noProvision: true, autorun: true, rep: LEAK, delStatus: 500, delBody: "rep",
      plantLedger: [{ id: ID, created_email_sha: sha(LEAK.email) }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), `precondition: the record was read and the DELETE answered: ${o.dump()}`).toEqual(FULL_WITHDRAWAL);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ attempts: 1, last_error: "500/delete_failed" });
    expect(o.appLog.length, "precondition: the run logged something").toBeGreaterThan(0);
    const everything = o.appLog.join("\n") + JSON.stringify(o.ledger);
    for (const v of Object.values(LEAK)) expect(everything, `"${v}" leaked`).not.toContain(v);
  });
});

test.describe("v8.12.7 F2 — the in-flight withdrawal and the runner share one row", () => {
  test("21: a deletion DURING provisioning — the job withdraws it and the runner never touches the claimed row: exactly ONE DELETE", () => {
    const o = provision({ createdId: ID, autorun: true, deleteUserAt: "GET /groups" });
    expect(o.fired.deleteUser, `precondition: the erasure landed mid-provisioning: ${o.dump()}`).not.toBeNull();
    expect(o.alive).toBe(false);
    expect(o.dels, o.dump()).toEqual([DEL]);
    expect(o.ledger).toEqual([]);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ realm_account_withdrawn: true })]);
  });

  test("22: the job's own withdrawal REFUSED is handed to the runner — scheduled, said so, and removed on the next pass", () => {
    const o = provision({ createdId: ID, autorun: true, deleteUserAt: "GET /groups", delStatuses: [403, 204],
      steps: ["snapshot", { run: 2 }] });
    expect(o.fired.deleteUser, `precondition: the erasure landed mid-provisioning: ${o.dump()}`).not.toBeNull();
    expect(o.abandoned, o.dump())
      .toEqual([expect.objectContaining({ withdrawal_retry_scheduled: true, realm_account_withdrawn: false })]);
    expect(o.appLog.some(l => l.includes("could NOT be withdrawn yet")), "the warning says a retry is coming").toBe(true);
    const row = rowOf(o.stepLog[0].result.ledger);
    expect(row, o.dump()).toMatchObject({ attempts: 1, last_error: "403/delete_refused", claim_token: null });
    expect(row.pending_since).not.toBeNull();
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now());
    expect(o.stepCalls(1), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
    expect(o.dels).toEqual([DEL, DEL]);
  });
});

test.describe("v8.12.7 F2 — rows the platform cannot prove it made", () => {
  test("23: a row recorded by ANOTHER installation is held with zero calls; a superadmin override removes it", () => {
    const o = provision({ noProvision: true, autorun: true, plantLedger: [{ id: ID, instance_origin: "https://other.example" }],
      steps: ["cascade", "snapshot", { retry: ID, override: true }] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([]);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "instance_mismatch", attention: 1 });
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "instance_mismatch" });
    expect(o.stepCalls(2), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });

  test("23: a BACKFILLED row is held as instance_unconfirmed, with zero calls", () => {
    const o = provision({ noProvision: true, autorun: true, plantHistory: [{ details: HIST() }], steps: ["backfill", "cascade"] });
    expect(o.stepLog[0].result, `precondition: backfilled: ${o.dump()}`).toMatchObject({ inserted: 1 });
    cascaded(o, 1, 1);
    expect(o.stepCalls(1), o.dump()).toEqual([]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ provenance: "history", instance_origin: null,
      realm_confirmed: 0, held_reason: "instance_unconfirmed" });
  });

  test("24: the backfill takes only an account the history proves this platform created — and only once", () => {
    const o = provision({ noProvision: true, plantLedger: [{ id: xid(6) }], plantHistory: [
      { details: HIST() },                                              // qualifies
      { details: HIST({ cxone_user_id: xid(2), matched_by: "email" }) },
      { details: HIST({ cxone_user_id: xid(3), already_existed: true }) },
      { details: HIST({ cxone_user_id: xid(4), success: false }) },
      { details: HIST({ cxone_user_id: undefined }) },                  // no id
      { userId: "u-gone", details: HIST({ cxone_user_id: xid(5) }) },  // a deleted user
      { details: HIST({ cxone_user_id: xid(6) }) },                     // already recorded as created
    ], steps: ["backfill", "backfill"] });
    expect(o.stepLog[0].result, o.dump()).toEqual({ scanned: 6, inserted: 1 });
    expect(o.stepLog[1].result, "a second run changes nothing").toEqual({ scanned: 6, inserted: 0 });
    expect(o.ledger.map(r => r.cxone_user_id)).toEqual([xid(6), ID]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ provenance: "history", user_id: "u-1", competition_id: "c-1",
      created_username: "erin", realm_confirmed: 0, instance_origin: null, pending_since: null });
    expect(rowOf(o.ledger, xid(6))).toMatchObject({ provenance: "created" });
  });
});

// ─── Pre-release review ──────────────────────────────────────────────────────
//
// The first draft held only on a sign-in link, so an account the tenant (or a
// second installation sharing it) had since put to use was deleted from under
// whoever was using it. Two more signals, both the same overridable hold:
// membership of a group this platform could never have granted, and a realm
// address that no longer hashes to the one the create sent. Every arm pairs the
// hold with the control that is NOT held, or "held" is satisfied by a runner
// that holds everything.
test.describe("v8.12.7 F2 review — an account the tenant has taken into use is held, not removed", () => {
  test("R1: a membership of a group this platform never grants — held; a superadmin override then removes it", () => {
    const o = provision({ createdId: ID, autorun: true,
      userGroups: [{ id: "g-1", name: "hackers" }, { id: "g-x", name: "Tenant-Admins" }],
      steps: ["cascade", "snapshot", { retry: true, override: true }] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_DEFAULTS]);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", attention: 1, attempts: 0 });
    expect(o.logOf("cxone_realm_withdrawal_held").map(d => d.reason)).toEqual(["adopted_by_tenant"]);
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "adopted_by_tenant" });
    // The override answers the question: nothing about adoption is re-read.
    expect(o.stepCalls(2), o.dump()).toEqual([TOKEN_T1, GET_USER, DEL]);
    expect(o.ledger).toEqual([]);
  });

  // v8.13.1 — RE-POINTED, not weakened: `globalKey: true` is new. This arm was
  // written against the unscoped set, which held the global default group
  // whatever key granted it — and its fixture configured NO global default key,
  // so under the realm-scoped rule (see "the grantable group set is the
  // account's own realm", below) nothing could have granted that group in
  // tenant1 and holding the account is now the CORRECT answer. The subject is
  // unchanged — memberships this platform could grant, matched in any case, are
  // removed — so the fixture now states what makes the global default group
  // grantable here: the global default key, in tenant1.
  test("R1 CONTROL: only groups this platform grants — an event's and the global default, in any case — is removed", () => {
    const o = provision({ createdId: ID, autorun: true, globalGroup: "GLOBAL-DEFAULT-GROUP", globalKey: true,
      userGroups: [{ id: "g-1", name: "HACKERS" }, { id: "g-global", name: "global-default-group" }],
      steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });

  test("R2: a realm DEFAULT group (assigned to every account at creation) is not adoption — removed", () => {
    const o = provision({ createdId: ID, autorun: true, userGroups: [{ id: "g-def", name: "Default Users" }],
      defaultGroups: [{ id: "g-def", name: "Default Users" }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_DEFAULTS, GET_ROLES, GET_CREDS, GET_CLIENTS, DEL]);
    expect(o.ledger).toEqual([]);
  });

  test("R2: the realm's default groups cannot be read (403) — the foreign group stands, held", () => {
    const o = provision({ createdId: ID, autorun: true, userGroups: [{ id: "g-def", name: "Default Users" }],
      defaultGroups: [{ id: "g-def", name: "Default Users" }], defaultGroupsStatus: 403, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_DEFAULTS]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant" });
    expect(o.dels).toEqual([]);
  });

  test("R3: a FULL page of memberships cannot be proven free of a foreign group — held, even if every one is ours", () => {
    const o = provision({ createdId: ID, autorun: true,
      userGroups: Array.from({ length: 100 }, (_, i) => ({ id: `g-${i}`, name: "hackers" })), steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED, GET_GROUPS]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant" });
    expect(o.dels).toEqual([]);
  });

  test("R4: the memberships cannot be read (503) — retried, never read as 'no groups', and removed once they can be", () => {
    const o = provision({ createdId: ID, autorun: true, userGroupsStatuses: [503],
      steps: ["cascade", "snapshot", { run: 2 }] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED, GET_GROUPS]);
    expect(rowOf(o.stepLog[1].result.ledger), o.dump())
      .toMatchObject({ attempts: 1, attention: 0, held_reason: null, last_error: "503/groups_unreadable" });
    expect(o.stepCalls(2), "the retry reads them and removes it").toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
    expect(o.dels).toHaveLength(1);
  });

  test("R4: the key may not read memberships (403) — a structural refusal that needs attention at once, no DELETE", () => {
    const o = provision({ createdId: ID, autorun: true, userGroupsStatus: 403, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER, GET_FED, GET_GROUPS]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ attempts: 1, attention: 1, last_error: "403/read_refused" });
    expect(o.dels).toEqual([]);
  });

  for (const [label, email] of [["changed", "someone.new@tenant.test"], ["removed", null]]) {
    test(`R5: the realm's address was ${label} since the create — held with no further read; an override then removes it`, () => {
      const o = provision({ createdId: ID, autorun: true, rep: { email },
        steps: ["cascade", "snapshot", { retry: true, override: true }] });
      cascaded(o, 0, 1);
      expect(o.stepCalls(0), o.dump()).toEqual([TOKEN_T1, GET_USER]);
      expect(rowOf(o.stepLog[1].result.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", created_email_sha: sha(EMAIL) });
      expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "adopted_by_tenant" });
      expect(o.stepCalls(2), o.dump()).toEqual([TOKEN_T1, GET_USER, DEL]);
      expect(o.ledger).toEqual([]);
    });
  }

  test("R5 CONTROL: the same address in a different case and with padding is unchanged — removed", () => {
    const o = provision({ createdId: ID, autorun: true, rep: { email: "  Erin.Erased@ACME.test " }, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });

  test("R5: a row with no recorded fingerprint (backfilled, or recorded before the column) skips ONLY the address check", () => {
    const o = provision({ noProvision: true, autorun: true, rep: { email: "someone.new@tenant.test" },
      plantLedger: [{ id: ID }], steps: ["snapshot", "cascade"] });
    expect(rowOf(o.stepLog[0].result.ledger), "precondition: no fingerprint").toMatchObject({ created_email_sha: null });
    cascaded(o, 1, 1);
    expect(o.stepCalls(1), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });
});

// ─── v8.13.1 (external audit) ────────────────────────────────────────────────
//
// THE GRANTABLE GROUP SET WAS PLATFORM-WIDE, AND A GROUP NAME MEANS NOTHING
// OUTSIDE THE REALM THAT HOLDS IT. R1 holds an account that belongs to a group
// this platform could never have granted — and "could have granted" was every
// group name configured on ANY event, under ANY key. So an event provisioning a
// DIFFERENT customer's tenant, granting a group that happened to share its name
// with one this tenant had made for itself, made the tenant's membership look
// like ours: the hold vanished and the account was deleted. The auditor
// reproduced exactly that — R1's shape held; adding the unrelated event's
// configuration deleted it — and G1 is that reproduction.
//
// The set is now built per row, for the realm the row lives in (origin AND
// tenant, so the same tenant name in another region is another realm): an
// event's group counts only under the key it provisions with — its own, or the
// global default when it has none (G4) — a group-less event grants the global
// default group under that key (G3), and the global default group also counts
// under the global default key (G2). EVERY ARM IS A PAIR: the held half alone is
// satisfied by a runner that finds every membership foreign, the removed half
// alone by one that finds none foreign (the unscoped set), so only the pair says
// the set is SCOPED.
//
// An event whose own key does not DECODE falls back to the global default key's
// realm (getCxOneConfig's precedence): G4b, planted with a raw key string.
// What is not here, and why: a row naming no realm at all yields an empty set, which is
// unreachable at the adoption check: a confirmed row without one has no key that
// can reach it (step 3 stops it — arm 16's shape), and an unconfirmed row's realm
// is confirmed from the key that answered (step 7) before step 8 asks. G5 locks
// the reachable half of that: the confirmation is what feeds the set.

// A hold on a foreign membership. The default-groups read is made ONLY once a
// membership has been found foreign, so its presence says the set lacked the
// group, independently of the hold.
const HELD_FOREIGN = [TOKEN_T1, GET_USER, GET_FED, GET_GROUPS, GET_DEFAULTS];
const HACKERS = { id: "g-1", name: "hackers" };
const ADMINS = { id: "g-x", name: "Tenant-Admins" };
const GLOBAL_GROUP = { id: "g-global", name: "GLOBAL-DEFAULT-GROUP" };

/** Step `i` held the account as adopted, in tenant1, with no DELETE — and no other realm was asked. */
function heldForeign(o, i, holds = ["adopted_by_tenant"]) {
  expect(o.stepCalls(i), o.dump()).toEqual(HELD_FOREIGN);
  for (const c of o.stepCallsFull(i)) expect(realmOf(c), c).toBe("iam.checkmarx.net/tenant1");
  expect(rowOf(o.ledger), o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", attention: 1,
    realm_confirmed: 1, iam_origin: "https://iam.checkmarx.net", tenant: "tenant1" });
  expect(o.logOf("cxone_realm_withdrawal_held").map(d => d.reason), o.dump()).toEqual(holds);
  expect(o.dels).toEqual([]);
}

/** Step `i` removed the account: the full read, then the DELETE, and the row went with it. */
function removedWhole(o, i) {
  expect(o.stepCalls(i), o.dump()).toEqual(FULL_WITHDRAWAL);
  expect(o.ledger, o.dump()).toEqual([]);
  expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "deleted" })]);
}

test.describe("v8.13.1 — the grantable group set is the account's own realm", () => {
  for (const [label, keyRealm] of [["another tenant", "tenant2"], ["the same tenant name in another region", "eu"]]) {
    test(`G1 (THE FINDING): a group that only an event of ${label} grants is the TENANT'S here — held, and that event's key is never tried`, () => {
      // The participant was never in "c-other"; it is configuration elsewhere on
      // the platform, nothing more. The realm assertion inside heldForeign says
      // the other realm was not even asked: the set is scoped, not consulted.
      const o = provision({ createdId: ID, autorun: true, userGroups: [HACKERS, ADMINS],
        extraEvents: [{ id: "c-other", keyRealm, group: "Tenant-Admins" }], steps: ["cascade"] });
      cascaded(o, 0, 1);
      heldForeign(o, 0);
    });
  }

  test("G1 CONTROL: the SAME configuration keyed to this account's realm makes the group grantable — removed", () => {
    // An event the participant was never in still counts. The set is "what this
    // platform could have granted IN THIS REALM", not "what this account's own
    // events granted": a participant enrolled in a second event of the same
    // tenant is matched to the same account and given that event's group too, so
    // the narrower set would hold every such account.
    const o = provision({ createdId: ID, autorun: true, userGroups: [HACKERS, ADMINS],
      extraEvents: [{ id: "c-other", keyRealm: "tenant1", group: "Tenant-Admins" }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    removedWhole(o, 0);
  });

  test("G2: the global default group, under a global default key of ANOTHER tenant, is the tenant's here — held", () => {
    // The account's own event has a key and a group of its own ("hackers"), so
    // nothing in tenant1 grants the global default group; the global default key
    // provisions tenant2.
    const o = provision({ createdId: ID, autorun: true, globalGroup: "GLOBAL-DEFAULT-GROUP", globalKeyRealm: "tenant2",
      userGroups: [HACKERS, GLOBAL_GROUP], steps: ["cascade"] });
    expect(o.puts, `precondition: provisioning granted the event's own group: ${o.dump()}`).toEqual([`PUT /users/${ID}/groups/g-1`]);
    cascaded(o, 0, 1);
    heldForeign(o, 0);
  });

  test("G2 CONTROL: the same global default group under a global default key of THIS realm — removed", () => {
    const o = provision({ createdId: ID, autorun: true, globalGroup: "GLOBAL-DEFAULT-GROUP", globalKeyRealm: "tenant1",
      userGroups: [HACKERS, GLOBAL_GROUP], steps: ["cascade"] });
    cascaded(o, 0, 1);
    removedWhole(o, 0);
  });

  test("G3: an event with NO group of its own grants the global default group in ITS key's realm — removed", () => {
    // The account's own event: a key, no group. Provisioning therefore granted
    // the global default group (the precondition), and with NO global default
    // KEY configured, only the event's fall-back can put that group in the set —
    // so this is what stops the fix holding every account the platform itself
    // put in the global default group through a group-less event.
    const o = provision({ createdId: ID, autorun: true, group: "", globalGroup: "GLOBAL-DEFAULT-GROUP",
      userGroups: [GLOBAL_GROUP], steps: ["cascade"] });
    expect(o.puts, `precondition: provisioning granted the global default group: ${o.dump()}`).toEqual([`PUT /users/${ID}/groups/g-global`]);
    cascaded(o, 0, 1);
    removedWhole(o, 0);
  });

  test("G3 CONTROL: a group-less event keyed to ANOTHER tenant does not make the global default group grantable here — held", () => {
    const o = provision({ createdId: ID, autorun: true, globalGroup: "GLOBAL-DEFAULT-GROUP",
      extraEvents: [{ id: "c-other", keyRealm: "tenant2", group: "" }], userGroups: [HACKERS, GLOBAL_GROUP], steps: ["cascade"] });
    expect(o.puts, `precondition: provisioning granted the event's own group: ${o.dump()}`).toEqual([`PUT /users/${ID}/groups/g-1`]);
    cascaded(o, 0, 1);
    heldForeign(o, 0);
  });

  test("G4: an event with NO KEY of its own provisions under the global default key — its group is grantable in THAT realm — removed", () => {
    const o = provision({ createdId: ID, autorun: true, globalKeyRealm: "tenant1",
      extraEvents: [{ id: "c-keyless", keyRealm: null, group: "Keyless-Cohort" }],
      userGroups: [HACKERS, { id: "g-k", name: "Keyless-Cohort" }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    removedWhole(o, 0);
  });

  // An event whose key is SET but does not decode is the same case as no key:
  // getCxOneConfig falls back to the global default key, so the event provisions
  // that realm with its own group. Read as "no realm" instead, a group the
  // platform granted would read as the tenant's and hold the account.
  test("G4b: an event whose own key does NOT decode provisions under the global default key — its group is grantable there — removed", () => {
    const o = provision({ createdId: ID, autorun: true, globalKeyRealm: "tenant1",
      extraEvents: [{ id: "c-badkey", key: "not-a-checkmarx-key", group: "Keyless-Cohort" }],
      userGroups: [HACKERS, { id: "g-k", name: "Keyless-Cohort" }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    removedWhole(o, 0);
  });

  test("G4b CONTROL: the same undecodable key under a global default key of ANOTHER tenant — held", () => {
    const o = provision({ createdId: ID, autorun: true, globalKeyRealm: "tenant2",
      extraEvents: [{ id: "c-badkey", key: "not-a-checkmarx-key", group: "Keyless-Cohort" }],
      userGroups: [HACKERS, { id: "g-k", name: "Keyless-Cohort" }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    heldForeign(o, 0);
  });

  test("G4 CONTROL: the same key-less event under a global default key of ANOTHER tenant — held", () => {
    const o = provision({ createdId: ID, autorun: true, globalKeyRealm: "tenant2",
      extraEvents: [{ id: "c-keyless", keyRealm: null, group: "Keyless-Cohort" }],
      userGroups: [HACKERS, { id: "g-k", name: "Keyless-Cohort" }], steps: ["cascade"] });
    cascaded(o, 0, 1);
    heldForeign(o, 0);
  });

  // A BACKFILLED row has no realm until a key reaches the account (step 7 writes
  // it, to the row on disk AND to the run's copy). Under the unscoped set that
  // in-memory copy decided nothing at the adoption check; under the scoped one it
  // decides everything, so this pair is what holds it: without the copy the run
  // asks for an empty set, finds the account's own group foreign and holds it.
  test("G5: a row that STARTED with no realm is scoped to the realm its read confirmed — its own event's group, removed", () => {
    const o = provision({ noProvision: true, autorun: true, plantHistory: [{ details: HIST() }], userGroups: [HACKERS],
      steps: ["backfill", "cascade", "snapshot", { retry: ID, override: true }] });
    expect(o.stepLog[0].result, `precondition: backfilled: ${o.dump()}`).toMatchObject({ inserted: 1 });
    cascaded(o, 1, 1);
    expect(rowOf(o.stepLog[2].result.ledger), `precondition: no realm when the run starts: ${o.dump()}`)
      .toMatchObject({ realm_confirmed: 0, iam_origin: null, tenant: null, held_reason: "instance_unconfirmed" });
    expect(o.stepLog[3].result, o.dump()).toMatchObject({ ok: true, overridden: "instance_unconfirmed" });
    removedWhole(o, 3);
  });

  test("G5 CONTROL: the realm it confirmed is what scopes it — a group only another tenant's event grants, held", () => {
    const o = provision({ noProvision: true, autorun: true, plantHistory: [{ details: HIST() }], userGroups: [HACKERS, ADMINS],
      extraEvents: [{ id: "c-other", keyRealm: "tenant2", group: "Tenant-Admins" }],
      steps: ["backfill", "cascade", "snapshot", { retry: ID, override: true }] });
    expect(o.stepLog[0].result, `precondition: backfilled: ${o.dump()}`).toMatchObject({ inserted: 1 });
    cascaded(o, 1, 1);
    expect(rowOf(o.stepLog[2].result.ledger), `precondition: no realm when the run starts: ${o.dump()}`)
      .toMatchObject({ realm_confirmed: 0, iam_origin: null, tenant: null, held_reason: "instance_unconfirmed" });
    expect(o.stepLog[3].result, o.dump()).toMatchObject({ ok: true, overridden: "instance_unconfirmed" });
    heldForeign(o, 3, ["instance_unconfirmed", "adopted_by_tenant"]);
  });
});

test.describe("v8.12.7 F2 review — a hand-over needs a living new owner, and a deletion is never slowed by the scan", () => {
  // The reviewer's reproduction: B is matched (409, by email) to the account
  // deleted-A's row names, and B is erased DURING the search's body read. The
  // job's own erasure ask comes one iteration later, so the transfer ran first:
  // A's pending stamp was cleared and the row re-keyed to a user who no longer
  // exists — "unmarked", never acted on. The new owner is now required to exist
  // in the same statement.
  test("R6: a participant erased while their search answer was being read does NOT take the row — it stays pending for the deleted owner", () => {
    const B = { id: "u-2", email: "bea@acme.test", first_name: "Bea", last_name: "B", enrolIn: "c-1" };
    const o = provision({ noProvision: true, create: 409, matchId: ID, plantUsers: [B], plantLedger: [{ id: ID }],
      deleteWho: "u-2", deleteUserAt: "GET /users#1:json", steps: ["cascade", { provision: "u-2" }, "snapshot", "list"] });
    cascaded(o, 0, 1);
    expect(o.fired.deleteUser, `precondition: B was erased inside the search read: ${o.dump()}`).not.toBeNull();
    const row = rowOf(o.stepLog[2].result.ledger);
    expect(row, o.dump()).toMatchObject({ user_id: "u-1", deletion_source: "cascade", transferred_at: null });
    expect(row.pending_since, "the deletion record survives").not.toBeNull();
    expect(rowOf(o.stepLog[3].result), o.dump()).toMatchObject({ state: "retrying" });
    expect(o.logOf("cxone_provision_abandoned"), o.dump()).toEqual([expect.objectContaining({ reason: "user_deleted" })]);
  });

  test("R6 CONTROL: the same match, with B still alive, takes the row", () => {
    const B = { id: "u-2", email: "bea@acme.test", first_name: "Bea", last_name: "B", enrolIn: "c-1" };
    const o = provision({ noProvision: true, create: 409, matchId: ID, plantUsers: [B], plantLedger: [{ id: ID }],
      steps: ["cascade", { provision: "u-2" }, "snapshot"] });
    cascaded(o, 0, 1);
    expect(rowOf(o.stepLog[2].result.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
  });

  // The kick from the cascade used to START the run inside the call — and a run
  // is synchronous up to its first await, which includes the living-binder walk
  // over `user_events` and the token request. So both happened inside the admin's
  // DELETE request. The run now starts on the next turn of the event loop.
  test("R7: the deletion itself makes no remote call and no history scan — the run starts afterwards, and still removes it", () => {
    const o = provision({ createdId: ID, autorun: true, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepLog[0].result, o.dump()).toMatchObject({ callsDuringCascade: 0, scansDuringCascade: 0 });
    expect(o.stepCalls(0), "the deferred run did happen").toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
  });

  // The living-binder scan is needed twice — before any remote call, and at the
  // gate with no await before the DELETE — and not after it.
  test("R7: a full removal walks the provisioning history exactly TWICE", () => {
    const o = provision({ createdId: ID, autorun: true, steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.stepLog[0].scans, o.dump()).toBe(2);
  });
});

// ─── RT — no removal is dropped for its age ──────────────────────────────────
// The runner used to DELETE, first thing in every run, any held, needing-
// attention or given-up row whose deletion was older than EVENT_RETENTION_DAYS:
// the account stayed in the customer's tenant and nothing tracked it any more —
// and through the attention flag it also dropped rows the runner was still
// retrying. A row now ends only when the account is gone, passes to a living
// participant, or a superadmin marks it removed. Past the window it is kept as
// it is, listed `past_retention` (from the DELETION, `pending_since`), and noted.
test.describe("RT — no Checkmarx One removal is dropped for its age", () => {
  const PARKED = "9999-12-31T00:00:00.000Z";
  const held = (id, deletedDaysAgo, over = {}) => ({ id, pending_since: hoursAgo(deletedDaysAgo * 24), deletion_source: "cascade",
    held_reason: "adopted_by_tenant", attention: 1, next_attempt_at: PARKED, created_email_sha: sha(EMAIL), ...over });
  /** Every retention line — per row, or the process's first-pass count — names
   *  nobody: not the username, the address, nor the address's fingerprint. */
  function noPersonalData(o, row) {
    const lines = o.log.filter(j => j.event_type === "cxone_realm_withdrawal_past_retention"
      || j.event_type === "cxone_realm_withdrawals_past_retention");
    expect(lines.length, `precondition: the retention note wrote a line: ${o.dump()}`).toBeGreaterThan(0);
    // CONTROL — the row really carries each value, so its absence below means something.
    expect(row && row.created_username, o.dump()).toBe("erin");
    expect(row.created_email_sha).toBe(sha(EMAIL));
    for (const j of lines) {
      const s = JSON.stringify(j);
      for (const v of ["erin", EMAIL, sha(EMAIL)]) expect(s, `"${v}" rides a retention line`).not.toContain(v);
    }
  }

  test("RT1: a held removal past the window is kept byte for byte, listed past_retention, noted ONCE — and nothing is called", () => {
    const o = provision({ createdId: ID, autorun: true, rep: { federationLink: "ldap-1" },
      steps: ["cascade", "snapshot", { run: 729 * 24 }, { list: 729 * 24 }, { run: 731 * 24 }, { run: 731 * 24 + 1 },
        "snapshot", { list: 731 * 24 }, { counts: 731 * 24 }] });
    cascaded(o, 0, 1);
    const before = rowOf(o.stepLog[1].result.ledger);
    expect(before, o.dump()).toMatchObject({ held_reason: "adopted_by_tenant", attention: 1, next_attempt_at: PARKED });
    expect(o.stepLog[2].result, o.dump()).toEqual({ attempted: 0, past_retention: 0 });
    expect(rowOf(o.stepLog[3].result), "a day short of the window").toMatchObject({ state: "held", past_retention: false });
    expect(o.stepLog[4].result, o.dump()).toEqual({ attempted: 0, past_retention: 1 });
    expect(o.stepLog[5].result, "said once, not on every pass").toEqual({ attempted: 0, past_retention: 0 });
    expect(rowOf(o.stepLog[6].result.ledger), "nothing dropped, nothing stripped").toEqual(before);
    expect(rowOf(o.stepLog[7].result), o.dump()).toMatchObject({ state: "held", reason: "adopted_by_tenant",
      overridable: true, past_retention: true });
    expect(o.stepLog[8].result, "the per-state counts are unchanged by the flag")
      .toEqual({ retrying: 0, held: 1, needs_attention: 0, given_up: 0, unmarked: 0, total: 1 });
    expect(o.logOf("cxone_realm_withdrawal_past_retention"), o.dump()).toEqual([expect.objectContaining({
      cxone_user_id: ID, state: "held", reason: "adopted_by_tenant", pending_since: before.pending_since, retention_days: 730 })]);
    expect(o.logOf("cxone_realm_withdrawals_past_retention"), "the process's first pass had nothing past the window").toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_expired")).toEqual([]);
    for (const i of [2, 4, 5]) expect(o.stepCalls(i), `step ${i} made a call`).toEqual([]);
    expect(o.dels).toEqual([]);
    noPersonalData(o, before);
  });

  test("RT1b: a process's FIRST pass counts the removals already past the window in ONE line; no later pass repeats them", () => {
    const o = provision({ noProvision: true, autorun: true,
      plantLedger: [held(ID, 731), held(MATCH_ID, 800), held(xid(1), 10)],
      steps: ["sqlDeleteUser", { run: 0 }, { run: 1 }, "list"] });
    expect(o.stepLog[0].result, "precondition: the participant row is gone").toBe(1);
    expect(o.stepLog[1].result, o.dump()).toEqual({ attempted: 0, past_retention: 2 });
    expect(o.stepLog[2].result).toEqual({ attempted: 0, past_retention: 0 });
    expect(o.logOf("cxone_realm_withdrawals_past_retention"), o.dump()).toEqual([{ count: 2, retention_days: 730 }]);
    expect(o.logOf("cxone_realm_withdrawal_past_retention"), "no line per row for rows already past at the start").toEqual([]);
    const listed = o.stepLog[3].result;
    expect(listed.filter(r => r.past_retention).map(r => r.cxone_user_id).sort()).toEqual([ID, MATCH_ID].sort());
    expect(rowOf(listed, xid(1)), "CONTROL — a ten-day-old hold").toMatchObject({ state: "held", past_retention: false });
    expect(o.ledger, "every row kept").toHaveLength(3);
    expect(o.calls).toEqual([]);
    noPersonalData(o, rowOf(o.ledger));
  });

  test("RT2: a given-up removal past the window stays given up and listed — never dropped", () => {
    const o = provision({ noProvision: true, autorun: true, delStatus: 503,
      plantLedger: [{ id: ID, attempts: 5, first_failed_at: hoursAgo(31 * 24) }],
      steps: ["cascade", "snapshot", { run: 731 * 24 }, "snapshot"] });
    cascaded(o, 0, 1);
    const before = rowOf(o.stepLog[1].result.ledger);
    expect(before, o.dump()).toMatchObject({ next_attempt_at: PARKED });
    expect(before.given_up_at, "precondition: given up").not.toBeNull();
    expect(o.stepLog[2].result, o.dump()).toEqual({ attempted: 0, past_retention: 1 });
    expect(o.stepCalls(2)).toEqual([]);
    expect(rowOf(o.stepLog[3].result.ledger), "kept as it was").toEqual(before);
    expect(o.logOf("cxone_realm_withdrawal_past_retention"), o.dump()).toEqual([expect.objectContaining({
      cxone_user_id: ID, state: "given_up", reason: "given_up" })]);
    expect(o.dels, "only the cascade's own attempt").toHaveLength(1);
  });

  test("RT3: a removal still being retried after a refused key is retried past the window, not dropped", () => {
    const o = provision({ createdId: ID, autorun: true, tokenStatus: 401, steps: ["cascade", "snapshot", { run: 731 * 24 }, "snapshot"] });
    cascaded(o, 0, 1);
    const before = rowOf(o.stepLog[1].result.ledger);
    expect(before, o.dump()).toMatchObject({ attempts: 1, attention: 1, last_error: "401/token_refused" });
    expect(Date.parse(before.next_attempt_at), "precondition: retried within a day").toBeLessThan(Date.now() + 25 * HOUR_MS);
    expect(o.stepLog[2].result, o.dump()).toEqual({ attempted: 1, past_retention: 1 });
    expect(o.stepCalls(2)).toEqual([TOKEN_T1]);
    expect(rowOf(o.stepLog[3].result.ledger), o.dump()).toMatchObject({ attempts: 2, attention: 1, given_up_at: null,
      pending_since: before.pending_since });
    expect(o.logOf("cxone_realm_withdrawal_past_retention")).toEqual([expect.objectContaining({
      cxone_user_id: ID, state: "needs_attention", reason: "token_refused" })]);
  });

  test("RT4: the flag keys on the DELETION — never on the record's age or an old failure", () => {
    // An account whose participant vanished with no deletion recorded, made 800 days ago.
    const a = provision({ noProvision: true, autorun: true,
      plantLedger: [{ id: ID, recorded_at: hoursAgo(800 * 24), provenance_at: hoursAgo(800 * 24) }],
      steps: ["sqlDeleteUser", { run: 731 * 24 }, { list: 731 * 24 }] });
    expect(a.stepLog[0].result, "precondition: the user row was deleted by hand").toBe(1);
    expect(rowOf(a.stepLog[2].result), a.dump()).toMatchObject({ state: "unmarked", past_retention: false });
    expect(a.stepLog[1].result).toEqual({ attempted: 0, past_retention: 0 });
    expect(a.log.filter(j => /past_retention/.test(j.event_type || ""))).toEqual([]);
    expect(a.calls).toEqual([]);
    // A deletion a day old on a record, and a first failure, 800 days old.
    const b = provision({ noProvision: true, autorun: true,
      plantLedger: [held(ID, 1, { recorded_at: hoursAgo(800 * 24), provenance_at: hoursAgo(800 * 24), first_failed_at: hoursAgo(800 * 24) })],
      steps: ["sqlDeleteUser", "list", { list: 731 * 24 }] });
    expect(rowOf(b.stepLog[1].result), b.dump()).toMatchObject({ state: "held", past_retention: false });
    expect(rowOf(b.stepLog[2].result), "CONTROL — the same row once its deletion is past the window").toMatchObject({ past_retention: true });
  });

  test("RT5: under a 30-day EVENT_RETENTION_DAYS a removal retried at 31 days is kept and flagged in THAT window; at 29 days it is not past it", () => {
    const o = provision({ createdId: ID, autorun: true, tokenStatus: 401,
      steps: ["cascade", { run: 29 * 24 }, { list: 29 * 24 }, { run: 31 * 24 }, "snapshot", { list: 31 * 24 }] },
      { env: { EVENT_RETENTION_DAYS: "30" } });
    expect(o.retentionDays, "precondition: the child read the 30-day window").toBe(30);
    cascaded(o, 0, 1);
    expect(o.stepLog[1].result, o.dump()).toEqual({ attempted: 1, past_retention: 0 });
    expect(rowOf(o.stepLog[2].result)).toMatchObject({ state: "needs_attention", past_retention: false });
    expect(o.stepLog[3].result, o.dump()).toEqual({ attempted: 1, past_retention: 1 });
    expect(o.stepCalls(3)).toEqual([TOKEN_T1]);
    // Past the 30-day window and past 30 days of failing, yet not given up (three
    // attempts, not five) — the row the old expiry dropped before give-up could fire.
    expect(rowOf(o.stepLog[4].result.ledger), o.dump()).toMatchObject({ attempts: 3, attention: 1, given_up_at: null });
    expect(rowOf(o.stepLog[5].result)).toMatchObject({ state: "needs_attention", reason: "token_refused", past_retention: true });
    expect(o.logOf("cxone_realm_withdrawal_past_retention"), o.dump()).toEqual([expect.objectContaining({
      cxone_user_id: ID, retention_days: 30 })]);
  });

  test("RT6: a retention window longer than a date can hold flags nothing and stops nothing — the removal runs and the list answers", () => {
    const o = provision({ noProvision: true, autorun: true, plantLedger: [{ id: ID }, held(MATCH_ID, 800)],
      steps: ["cascade", { run: 731 * 24 }, "list", "counts"] }, { env: { EVENT_RETENTION_DAYS: "100030000" } });
    expect(o.retentionDays, "precondition: the child read the huge window").toBe(100030000);
    cascaded(o, 0, 2);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(rowOf(o.ledger), "the due account is removed").toBeNull();
    expect(o.stepLog[1].result).toEqual({ attempted: 0, past_retention: 0 });
    expect(o.stepLog[2].result.map(r => [r.cxone_user_id, r.state, r.past_retention])).toEqual([[MATCH_ID, "held", false]]);
    expect(o.stepLog[3].result).toMatchObject({ held: 1, total: 1 });
  });

  test("RT7: the past-retention note can never stop a removal — a failing read inside it is swallowed, after the removal", () => {
    const o = provision({ createdId: ID, autorun: true, listReadFails: 2, steps: ["cascade", { run: 0 }] });
    cascaded(o, 0, 1);
    expect(o.listReadFailures, `precondition: the note's read failed in both passes: ${o.dump()}`).toBe(2);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
    expect(o.stepLog[1].result).toEqual({ attempted: 0, past_retention: 0 });
  });
});
