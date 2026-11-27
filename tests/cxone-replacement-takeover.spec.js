// @ts-check
//
// v8.13.1 (external audit, P2) — AN ABANDONED PROVISIONING JOB DELETED A LIVING
// PARTICIPANT'S CHECKMARX ONE ACCOUNT.
//
// The auditor's reproduction, with two real provisioning calls. A job creates a
// realm account for participant A and is suspended on an upstream call (the
// group lookup, its body read, the grant). Meanwhile A is erased, B registers
// with the address A had — the unique index refused it while A existed — and
// B's OWN provisioning runs to completion: B's create 409s on that address, B's
// search finds the account A's job just made, and B is matched to it
// (`transferTo` re-keys its ledger row to B; B's event binding names it). Then
// A's job resumes, sees its participant gone, and — v8.12.6's in-flight
// withdrawal — DELETED the account, and its ledger row with it, under the claim
// it still held. B kept a binding to an account that no longer existed.
//
// THE FIX, in three parts, each with its arm below:
//   • `_abandon` asks, synchronously and with no await before its DELETE,
//     whether the account has passed to somebody living
//     (`_withdrawalOwnershipLost`: the ledger row names someone else; the job no
//     longer holds its claim; or a living participant is bound to the id
//     locally — `livingBinder`, the runner's own question). If so it skips the
//     DELETE and says why (`realm_account_withdrawal_skipped`).
//   • `transferTo` ENDS every claim — a claim is a run's licence to act for the
//     participant who was deleted, and the account is no longer theirs.
//   • `deleteOwned` / `markInFlightRefusal` are bound to the OWNER as well as
//     the claim, so a run that resumes after a transfer — the job's own DELETE,
//     or the runner's — cannot remove the row the living participant now owns.
//   • (v8.14) a take-over that lands while a removal is ALREADY OUT — which the
//     three above could only log — is prevented: both removers announce the
//     removal before the DELETE leaves and the match defers and retries
//     instead of linking it; a link made anyway is cleared when the realm says
//     the account is gone (banner "A MATCH THAT MEETS A REMOVAL IN PROGRESS").
// The two ledger halves are each locked in tests/cxone-ledger.spec.js; this
// file is the behaviour, and it is what goes red on the pre-fix tree.
//
// Driven through tests/cxone-provision-harness.cjs (see
// tests/cxone-grant-after-delete.spec.js for why nothing reaches this code
// through the server). `replaceAt` names the call of the ORIGINAL job inside
// which the replacement happens: A is erased by the real cascade, B is planted
// with A's address and enrolled in the event, and B's provisioning runs to
// completion — all before that call returns to A's job.
//
// EVERY ARM ASSERTS ITS PRECONDITION: the replacement fired during the named
// call, and B really was matched to the account (read off B's own
// `cxone_provisioned` record — the harness reports A's binding only, and B's
// record is written right after B's binding write-back). Without it "no DELETE"
// is equally satisfied by a scenario that never reached the race. And every
// "kept" arm has its CONTROL: the same erasure with nobody taking the account
// over still withdraws it, or the fix is satisfied by a job that never removes
// anything — the v8.12.6 finding over again.
const { test, expect } = require("./isolated-test");
const { provision } = require("./cxone-harness-client");

// A realm id that IS a UUID, so the ledger records it (the harness default,
// "kc-created", is not).
const ID = "5e1f0c2a-7b3d-4e8f-9a01-23456789abcd";
const DEL = `DELETE /users/${ID}`;
const TOKEN_T1 = "POST /auth/realms/tenant1/protocol/openid-connect/token";
// The runner's reads of an account nobody has taken into use (step 8 clean:
// sign-in links, groups, roles, credentials) — where a hand-over to the same
// person happens — then the key's proof that it sees every role, asked only on
// the way to the removal that follows.
const BEFORE_PROBE = [TOKEN_T1, `GET /users/${ID}`, `GET /users/${ID}/federated-identity`,
  `GET /users/${ID}/groups?first=0&max=100`, `GET /users/${ID}/role-mappings`, `GET /users/${ID}/credentials`];
const ADOPTION_CLEAN = [...BEFORE_PROBE, "GET /clients?clientId=realm-management&first=0&max=1"];
// A hand-over to the same person is decided on the realm's own record, before
// any adoption sign is read.
const HANDED_OVER = [TOKEN_T1, `GET /users/${ID}`];
const FULL_WITHDRAWAL = [...ADOPTION_CLEAN, DEL];
// B's provisioning, as the harness answers it: create 409, the username search
// finds the account A's job made (by email — B's verified primary is A's old
// address), the group lookup, the grant.
const REPLACEMENT_CALLS = [TOKEN_T1, "POST /users", "GET /users?username=u-2-nick&exact=true",
  "GET /groups?search=hackers", `PUT /users/${ID}/groups/g-1`];

const rowOf = (ledger, id = ID) => (ledger || []).find(r => r.cxone_user_id === id) || null;

/** PRECONDITION: B replaced A during the named call, and B was matched to the account A's job created. */
function replaced(o) {
  expect(o.fired.replaceUser, `the replacement never fired — the call key no longer matches: ${o.dump()}`).not.toBeNull();
  expect(o.alive, "the original participant is gone").toBe(false);
  const b = o.log.filter(j => j.event_type === "cxone_provisioned" && j.scope_id === "u-2").map(j => j.details);
  expect(b, `the replacement's own provisioning must have bound the account: ${o.dump()}`).toEqual([
    expect.objectContaining({ success: true, already_existed: true, matched_by: "email", cxone_user_id: ID })]);
}

/** The ledger row as the replacement must find it: theirs, not pending, held by no run. */
function ownedByReplacement(row, dump) {
  expect(row, `the ledger row was deleted: ${dump}`).not.toBeNull();
  expect(row).toMatchObject({ user_id: "u-2", pending_since: null, deletion_source: null,
    claim_token: null, claimed_at: null, attempts: 0 });
  expect(row.transferred_at, "re-keyed by the replacement's match").toEqual(expect.any(String));
}

// Every await the creating job makes after its create, each mapped to the stage
// its next ask abandons at — the creation-baseline reads included (the account
// read back, then its role mappings), so an await added later joins this map.
const STAGE = { "GET /groups": "before_group_grant", "GET /groups:json": "before_group_grant", "PUT grant": "before_record",
  "GET /users/<id>": "during_baseline", "GET /users/<id>:json": "during_baseline",
  "GET /users/<id>/role-mappings": "during_baseline", "GET /users/<id>/role-mappings:json": "during_baseline" };

test.describe("v8.13.1 F2 — the auditor's reproduction: the account passed to a replacement while the job was suspended", () => {
  for (const at of Object.keys(STAGE)) {
    test(`replaced during ${at} → the job does NOT delete the account the replacement now holds, nor its ledger row`, () => {
      const o = provision({ createdId: ID, autorun: true, replaceAt: at, steps: ["snapshot", { run: 0 }] });
      replaced(o);
      expect(o.after.slice(0, REPLACEMENT_CALLS.length), `precondition: B's whole provisioning ran inside A's call: ${o.dump()}`)
        .toEqual(REPLACEMENT_CALLS);
      // THE FINDING: no DELETE, from the job or from any run after it.
      expect(o.dels, o.dump()).toEqual([]);
      ownedByReplacement(rowOf(o.stepLog[0].result.ledger), o.dump());
      // The abandon line SAYS why nothing was withdrawn, and carries no
      // `realm_account_withdrawn` key — that key means a removal was attempted.
      expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: STAGE[at], reason: "user_deleted",
        cxone_user_id: ID, created_by_this_job: true, realm_account_withdrawal_skipped: "transferred_to_living_account" })]);
      expect(Object.keys(o.abandoned[0])).not.toContain("realm_account_withdrawn");
      expect(Object.keys(o.abandoned[0])).not.toContain("withdrawal_retry_scheduled");
      expect(o.appLog.some(l => l.includes("may now belong to a living participant (transferred_to_living_account)")),
        "the skip is said in the log").toBe(true);
      // And nothing later takes it back: the row is not pending, so a pass selects nothing.
      expect(o.stepLog[1].result).toMatchObject({ attempted: 0 });
      expect(o.stepCalls(1)).toEqual([]);
      ownedByReplacement(rowOf(o.ledger), o.dump());
      expect(rowOf(o.ledger).created_baseline, "the job's creation baseline never lands on the replacement's row").toBeNull();
    });

    test(`CONTROL: erased during ${at} with NOBODY taking it over → the job still withdraws it, row and all`, () => {
      const o = provision({ createdId: ID, autorun: true, deleteUserAt: at });
      expect(o.fired.deleteUser, `precondition: the erasure landed during ${at}: ${o.dump()}`).not.toBeNull();
      expect(o.alive).toBe(false);
      expect(o.dels, o.dump()).toEqual([DEL]);
      expect(o.ledger, "the row goes with the account").toEqual([]);
      expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: STAGE[at], realm_account_withdrawn: true })]);
      expect(Object.keys(o.abandoned[0])).not.toContain("realm_account_withdrawal_skipped");
    });
  }
});

test.describe("v8.13.1 F2 — a living participant BOUND to the account, with no transfer, stops the job too", () => {
  // The third half of `_withdrawalOwnershipLost`, and the one the ledger cannot
  // see: the row is still the erased participant's and the job still holds its
  // claim, but a living participant's event binding names the id. The job must
  // not remove it; the runner, which owns the hand-over, transfers it later.
  test("bound during GET /groups → skipped as bound_to_living_account, the row left PENDING for the erased owner, and the runner then hands it over with no remote call", () => {
    const o = provision({ createdId: ID, plantUsers: [{ id: "u-2" }], deleteUserAt: "GET /groups", bindAt: "GET /groups",
      steps: ["snapshot", { run: 0 }] });
    expect(o.fired.deleteUser, `precondition: the erasure landed during the lookup: ${o.dump()}`).not.toBeNull();
    expect(o.fired.bindLiving, `precondition: the binding landed in the same call: ${o.dump()}`).not.toBeNull();
    expect(o.alive).toBe(false);
    expect(o.calls, "the job stops at the lookup; no grant, no DELETE").toEqual([TOKEN_T1, "POST /users", "GET /groups?search=hackers"]);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "before_group_grant", reason: "user_deleted",
      cxone_user_id: ID, realm_account_withdrawal_skipped: "bound_to_living_account" })]);
    expect(Object.keys(o.abandoned[0])).not.toContain("realm_account_withdrawn");
    // Not the job's to hand over: the row stays the erased owner's, stamped by
    // the cascade, released by the job — exactly what the runner selects.
    expect(rowOf(o.stepLog[0].result.ledger), o.dump()).toMatchObject({ user_id: "u-1", deletion_source: "cascade",
      claim_token: null, transferred_at: null });
    expect(rowOf(o.stepLog[0].result.ledger).pending_since).toEqual(expect.any(String));
    // The runner: one attempt, ZERO remote calls, handed to the living binder.
    expect(o.stepLog[1].result, o.dump()).toMatchObject({ attempted: 1 });
    expect(o.stepCalls(1)).toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, claim_token: null });
    expect(o.dels).toEqual([]);
  });

  // The same question one await earlier: the erasure and the binding land while
  // the CREATE is in flight, so the job records the account after both — and
  // the very next ask abandons. Only the living binder can stop the DELETE here
  // (the row is the erased participant's and the job holds its claim).
  //
  // AND THE ROW MUST STILL REACH THE RUNNER. The cascade marks the rows its
  // participant owned when it ran, and this one did not exist yet — it was
  // written at a 201 answered after the erasure. Unmarked, the runner never
  // selects it: an erased participant's row naming an account a living one
  // holds, listed "Not scheduled" with a Schedule-removal button beside it. The
  // job marks it (`in_flight`, the cascade having left no source of its own),
  // and the runner then hands it over with no remote call.
  test("bound during the CREATE → the job skips the DELETE, marks the row it wrote AFTER the cascade, and the runner hands it over", () => {
    const o = provision({ createdId: ID, plantUsers: [{ id: "u-2" }], deleteUserAt: "POST /users", bindAt: "POST /users",
      steps: ["snapshot", { run: 0 }] });
    expect(o.fired.deleteUser, `precondition: the erasure landed during the create: ${o.dump()}`).not.toBeNull();
    expect(o.fired.bindLiving, `precondition: the binding landed during the create: ${o.dump()}`).not.toBeNull();
    expect(o.calls, o.dump()).toEqual([TOKEN_T1, "POST /users"]);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "before_group_lookup", reason: "user_deleted",
      cxone_user_id: ID, created_by_this_job: true, realm_account_withdrawal_skipped: "bound_to_living_account" })]);
    const before = rowOf(o.stepLog[0].result.ledger);
    expect(before, `the record of the account survives: ${o.dump()}`).not.toBeNull();
    // `in_flight`, not `cascade`: the source says the cascade never saw this row,
    // which is the precondition that makes the job's own mark necessary at all.
    expect(before, o.dump()).toMatchObject({ user_id: "u-1", deletion_source: "in_flight", claim_token: null,
      attempts: 0, next_attempt_at: null });
    expect(before.pending_since, "marked for the runner").toEqual(expect.any(String));
    expect(o.stepLog[1].result, o.dump()).toMatchObject({ attempted: 1 });
    expect(o.stepCalls(1), "the hand-over needs no remote call").toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
    expect(o.dels).toEqual([]);
  });
});

test.describe("v8.13.1 F2 — a read that cannot say whose the account is fails CLOSED", () => {
  // The job's ownership question is a database read, and a read that throws is
  // not an answer: the job must not remove the account on the strength of a
  // question it could not ask. It leaves the row marked for the runner, which
  // asks again — and here nobody living holds the account, so the runner then
  // removes it. Two orderings, because they need different marks: an erasure
  // during the group lookup lands after the row exists (the cascade marks it),
  // one during the CREATE lands before (only the job's own mark reaches it).
  for (const [at, source] of [["GET /groups", "cascade"], ["POST /users", "in_flight"]]) {
    test(`erased during ${at}, ownership unreadable → the job sends no DELETE; the runner asks again and removes it`, () => {
      const o = provision({ createdId: ID, deleteUserAt: at, ownershipReadFails: true, steps: ["snapshot", { run: 0 }] });
      expect(o.fired.deleteUser, `precondition: the erasure landed during ${at}: ${o.dump()}`).not.toBeNull();
      expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ reason: "user_deleted", cxone_user_id: ID,
        realm_account_withdrawal_skipped: "ownership_unreadable" })]);
      expect(Object.keys(o.abandoned[0]), "no withdrawal was attempted").not.toContain("realm_account_withdrawn");
      // ONE DELETE in the whole run, and it is the runner's (FULL_WITHDRAWAL ends
      // with it) — a job that deleted too would make it two.
      expect(o.dels, `the job removed nothing; only the runner did: ${o.dump()}`).toEqual([DEL]);
      expect(rowOf(o.stepLog[0].result.ledger), o.dump()).toMatchObject({ user_id: "u-1", deletion_source: source,
        claim_token: null, attempts: 0 });
      // CONTROL inside the arm: the runner, which never makes that read, does the
      // removal — so the skip deferred it rather than abandoning it.
      expect(o.stepCalls(1), o.dump()).toEqual(FULL_WITHDRAWAL);
      expect(o.ledger, o.dump()).toEqual([]);
    });
  }
});

test.describe("v8.13.1 F2 — a replacement that lands during the original job's CREATE", () => {
  // One await earlier than the auditor's reproduction, and the ledger's blind
  // spot: B is matched to the account BEFORE A's job has written it down, so B's
  // `transferTo` finds no row to re-key, and A's job then records it — for A,
  // who no longer exists. Only the living-binder half of the job's ask can see
  // that B holds it (B's event binding names the id), and the row must still
  // reach the runner, which hands it to B. The cascade marked nothing: the row
  // did not exist when it ran.
  test("replaced during POST /users → the job records the account late, does NOT delete it, and the runner hands the row to the replacement", () => {
    const o = provision({ createdId: ID, replaceAt: "POST /users", steps: ["snapshot", { run: 0 }] });
    replaced(o);
    // A's own create was answered 201 — the replacement's create is the one that 409s.
    expect(o.calls.slice(0, 2), o.dump()).toEqual([TOKEN_T1, "POST /users"]);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "before_group_lookup", reason: "user_deleted",
      cxone_user_id: ID, created_by_this_job: true, realm_account_withdrawal_skipped: "bound_to_living_account" })]);
    expect(Object.keys(o.abandoned[0])).not.toContain("realm_account_withdrawn");
    expect(o.dels, "nothing removed the account the replacement holds").toEqual([]);
    const before = rowOf(o.stepLog[0].result.ledger);
    expect(before, `A's job recorded the account after B's match: ${o.dump()}`).toMatchObject({ user_id: "u-1",
      deletion_source: "in_flight", claim_token: null, transferred_at: null });
    expect(o.stepLog[1].result, o.dump()).toMatchObject({ attempted: 1 });
    expect(o.stepCalls(1), "the hand-over needs no remote call").toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, claim_token: null });
    expect(o.dels).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A MATCH THAT MEETS A REMOVAL IN PROGRESS WAITS FOR IT — never links it.
// ═══════════════════════════════════════════════════════════════════════════
//
// The external audit's residual, closed: a replacement matched to the account
// while a DELETE of it was already out (the runner's, or the job's `_abandon`)
// was left linked to an account the DELETE then removed — the row re-keyed to
// them, the binding naming the id, and only a log line. Both removers now
// ANNOUNCE the removal (lib/cxone.js `beginRealmRemoval`) in the same synchronous
// block as their last ownership check; the match asks (`realmRemovalBlock`)
// before `transferTo`, before its write-back and in its catch, and DEFERS: a
// `cxone_provisioned {deferred}` row, then a retry through the queue that gets a
// NEW account (or the old one, if the tenant refused the removal).
//
// Driven with the harness's realm MODEL (`realm: true`): a create 409s only while
// a live account holds the address, a removed account is gone from searches,
// reads and grants — so "a new account" and "the old one" are the realm's answer,
// not a fixed one. Each arm's FIRST row for the replacement is the deferral: the
// witness the repair layer (which reaches the same final binding) cannot give.
const RECREATED = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const EMAIL_Q = `email=${encodeURIComponent("erin.erased@acme.test")}&exact=true`;
// The replacement's first attempt, deferred at the match: create 409, username
// search (nothing), address search (the account), then nothing more.
const B_DEFERRED = [TOKEN_T1, "POST /users", "GET /users?username=u-2-nick&exact=true", `GET /users?${EMAIL_Q}`];
const HOLD_MS = 15 * 60_000 + 1_000;          // the default memory window, plus a second
// A row that promises a retry (scheduled, or stopped by a shutdown) names the
// installation that wrote it — only that one's boot resumes it. The harness's
// BASE_URL is http://localhost.
const ORIGIN = "http://localhost";
const deferral = (reason, extra = {}) => ({ type: "cxone_provisioned", competition_id: "c-1", success: false, deferred: reason, ...extra,
  ...(extra.retry_scheduled === true || extra.stopped ? { instance_origin: ORIGIN } : {}) });
const linkedTo = (id, extra = {}) => expect.objectContaining({ type: "cxone_provisioned", success: true, cxone_user_id: id, ...extra });
const boundOf = (o, uid = "u-2") => (o.bindingsOf(uid).find(b => b.competition_id === "c-1") || {}).cxone_user_id ?? null;
const lines = (o) => o.appLog.join("\n");
/** Every hold in the arm released, in order — or the race it names never happened. */
const holdsReleased = (o, n) => {
  expect(o.holdLog.filter(h => h.released), `precondition: every hold released: ${o.dump()}`).toHaveLength(n);
  expect(o.concurrentErrors, o.dump()).toEqual([]);
};

test.describe("v8.14 F2 — a take-over that lands DURING a removal waits for it, and is never linked to the removed account", () => {
  // Was "the RUNNER's DELETE: the row survives, re-keyed to the replacement".
  test("RUNNER, removed: the replacement is deferred, not linked — then given a NEW account; no repair was needed", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>",
      steps: ["cascade", "snapshot", "retries", "snapshot"] });
    expect(o.stepLog[0].result && o.stepLog[0].result.cxoneWithdrawalsScheduled, `precondition: the cascade stamped the row: ${o.dump()}`).toBe(1);
    expect(o.fired.replaceUser, o.dump()).not.toBeNull();
    // The runner's whole removal, then — inside its DELETE — the replacement's
    // first attempt, which stops at the match.
    expect(o.stepCalls(0), o.dump()).toEqual([...FULL_WITHDRAWAL, ...B_DEFERRED]);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    // NEVER `cxone_user_id`: livingBinder reads any provisioning row naming it as a binding.
    expect(Object.keys(b[0])).not.toContain("cxone_user_id");
    // THE WITNESS ONLY PREVENTION GIVES: right after the removal, nobody is linked
    // to the account, no row was re-keyed, and nothing had to be repaired.
    const s1 = o.stepLog[1].result;
    expect(s1.others.find(r => r.user_id === "u-2"), o.dump()).toMatchObject({ cxone_user_id: null });
    expect(rowOf(s1.ledger), "the removed account's row went with it").toBeNull();
    expect(o.dels).toEqual([DEL]);
    expect(o.logOf("cxone_realm_withdrawal_transferred")).toEqual([]);
    expect(b.filter(e => e.type === "cxone_binding_cleared"), "nothing to repair").toEqual([]);
    expect(lines(o), "nobody was linked meanwhile, so nothing is said about it").not.toContain("had been linked to meanwhile");
    // The retry gets a NEW account of its own, recorded for the replacement.
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
    expect(b, o.dump()).toHaveLength(2);
    expect(boundOf(o)).toBe(RECREATED);
    expect(rowOf(o.ledger, RECREATED), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
    expect(o.binderOfCreated, "nothing living is bound to the removed account").toBeNull();
    expect(o.retriesPending).toBe(0);
  });

  // Was "the RUNNER's DELETE refused after a take-over".
  test("RUNNER, refused (403): the deferral is lifted, and the retry takes the account the tenant kept", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", delStatus: 403,
      steps: ["cascade", "snapshot", "retries"] });
    expect(o.stepCalls(0), o.dump()).toEqual([...FULL_WITHDRAWAL, ...B_DEFERRED]);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(rowOf(o.stepLog[1].result.ledger), "still the erased participant's, the refusal recorded").toMatchObject({ user_id: "u-1", last_error: "403/delete_refused" });
    // A refusal FORGETS the announcement: a kept entry would defer the retry again.
    expect(b[1], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
    expect(b).toHaveLength(2);
    ownedByReplacement(rowOf(o.ledger), o.dump());
    expect(o.dels).toEqual([DEL]);
    expect(lines(o), "a refused DELETE removed nothing").not.toContain("had been linked to meanwhile");
  });

  // Was "the JOB's own DELETE: the row survives, re-keyed to the replacement".
  test("JOB, removed: the replacement is deferred during the job's own DELETE, then given a NEW account", () => {
    const o = provision({ createdId: ID, realm: true, deleteUserAt: "GET /groups", replaceAt: "DELETE /users/<id>",
      steps: ["snapshot", "retries"] });
    expect(o.fired.deleteUser, `precondition: A was erased during the lookup: ${o.dump()}`).not.toBeNull();
    expect(o.fired.replaceUser, "…and the replacement came while the job's DELETE was out").toBeGreaterThan(o.fired.deleteUser);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "before_group_grant", realm_account_withdrawn: true })]);
    expect(Object.keys(o.abandoned[0]), "nobody was linked to it, so nothing was taken over").not.toContain("taken_over_during_withdrawal");
    expect(Object.keys(o.abandoned[0])).not.toContain("bindings_cleared");
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(o.stepLog[0].result.others.find(r => r.user_id === "u-2"), o.dump()).toMatchObject({ cxone_user_id: null });
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
    expect(rowOf(o.ledger), "no row is left for the removed account").toBeNull();
    expect(o.dels).toEqual([DEL]);
  });

  // Was "the JOB's DELETE refused (403) after a take-over".
  test("JOB, refused (403): handed to the runner as before, and the replacement's retry takes the account over", () => {
    const o = provision({ createdId: ID, realm: true, deleteUserAt: "GET /groups", replaceAt: "DELETE /users/<id>", delStatus: 403,
      steps: ["retries"] });
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "before_group_grant", reason: "user_deleted",
      realm_account_withdrawn: false, withdrawal_retry_scheduled: true })]);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(b[1], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
    ownedByReplacement(rowOf(o.ledger), o.dump());
    expect(lines(o), "nobody is told to delete a living participant's account").not.toContain("remove it in the realm by hand");
  });

  // Was "the JOB's DELETE refused (500) after a take-over". A 5xx does not say
  // whether the account went, so it holds matches like no answer at all, and is
  // read again a minute later (the armed re-read) — never treated as a refusal.
  test("JOB, 5xx: unknown, not refused — matches keep waiting until the runner's re-read finds the account still there", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, deleteUserAt: "GET /groups", replaceAt: "DELETE /users/<id>", delStatus: 500,
      steps: ["snapshot", "retries", "rereads", "retries"] });
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ realm_account_withdrawn: false, withdrawal_retry_scheduled: true })]);
    const row0 = rowOf(o.stepLog[0].result.ledger);
    expect(row0, o.dump()).toMatchObject({ user_id: "u-1", last_error: "500/delete_failed" });
    expect(Date.parse(row0.next_attempt_at) - Date.parse(row0.first_failed_at), "re-read in a minute, not an hour").toBe(60_000);
    const b = o.eventsOf("u-2");
    expect(b[0]).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(b[1], "a 5xx is not a refusal: the retry still waits").toEqual(deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 2 }));
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ armed: [{ delayMs: 61_000 }], fired: 1 });
    expect(o.stepCalls(2), "the re-read asks the realm, finds it, and sends no DELETE").toEqual(
      HANDED_OVER);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump()).toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "address_held_by_same_person" })]);
    expect(b[2], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
    expect(o.dels).toEqual([DEL]);
  });

  // TWO REMOVERS, ONE ACCOUNT: the runner's DELETE is out when the job abandons.
  // Reached when the job does not hold the row — here it lost the record to a
  // row recovered from history, so the runner may claim it meanwhile.
  test("the runner's removal is already out when the job abandons: the job sends NO second DELETE, and says why", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, plantLedger: [{ id: ID }], deleteUserAt: "GET /groups",
      holds: [{ call: "GET /groups:json", until: { removal: "in_flight" } }, { call: "DELETE /users/<id>", until: "GET /groups#1:json" }] });
    holdsReleased(o, 2);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage: "before_group_grant", realm_account_withdrawal_skipped: "removal_in_flight" })]);
    expect(Object.keys(o.abandoned[0]), "no withdrawal was attempted by the job").not.toContain("realm_account_withdrawn");
    expect(lines(o)).toContain("is already under way, so this job did not send a second one");
    expect(o.dels, "one DELETE — the runner's").toEqual([DEL]);
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "deleted" })]);
    expect(rowOf(o.ledger)).toBeNull();
  });

  test("CONTROL: the JOB's DELETE refused with nobody taking the account over is handed to the runner", () => {
    const o = provision({ createdId: ID, deleteUserAt: "GET /groups", delStatus: 403 });
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ realm_account_withdrawn: false,
      withdrawal_retry_scheduled: true })]);
    expect(Object.keys(o.abandoned[0])).not.toContain("taken_over_during_withdrawal");
    expect(o.appLog.some(l => l.includes("the platform will retry")), o.dump()).toBe(true);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-1", attempts: 1, last_error: "403/delete_refused" });
    expect(rowOf(o.ledger).pending_since).toEqual(expect.any(String));
  });

  test("CONTROL: the runner's removal with nobody taking the account over deletes the row with it", () => {
    const o = provision({ createdId: ID, autorun: true, steps: ["cascade"] });
    expect(o.stepLog[0].result && o.stepLog[0].result.cxoneWithdrawalsScheduled, o.dump()).toBe(1);
    expect(o.stepCalls(0), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
    expect(o.appLog.some(l => l.includes("living participant")), "no take-over, nothing to say").toBe(false);
  });
});

test.describe("v8.14 F2 — a match read across the removal (R2, R3) waits too", () => {
  // R2: the replacement's search was ANSWERED while the account existed, and its
  // body read finished after the DELETE did — the job used to link the removed
  // account with nothing logged at all. The hold on the body read is keyed on the
  // registry, so the reason is fixed: the removal is settled, a tombstone.
  test("R2, the JOB removes it: the search answered before, read after → deferred recently_removed, retried at once, given a new account", () => {
    const o = provision({ createdId: ID, realm: true, deleteUserAt: "GET /groups", replaceConcurrentAt: "GET /groups",
      holds: [{ call: "DELETE /users/<id>", until: "GET /users#2" }, { call: "GET /users#2:json", until: { removal: "removed" } }],
      steps: [{ wait: 300 }] });
    holdsReleased(o, 2);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ realm_account_withdrawn: true })]);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("recently_removed", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    // Retried AT ONCE — an account already gone cannot be matched again. With the
    // ordinary 5 s delay it would still be waiting after the 300 ms step.
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
    expect(b.filter(e => e.error), "no failure row").toEqual([]);
    expect(boundOf(o)).toBe(RECREATED);
  });

  // EXTERNAL_FETCH_TIMEOUT_MS is parsed from the environment; NaN through the
  // window arithmetic would make every comparison false — a gate that never blocks.
  test("R2 with a MALFORMED EXTERNAL_FETCH_TIMEOUT_MS: the window falls back to its floor, and the match still waits", () => {
    const o = provision({ createdId: ID, realm: true, deleteUserAt: "GET /groups", replaceConcurrentAt: "GET /groups",
      holds: [{ call: "DELETE /users/<id>", until: "GET /users#2" }, { call: "GET /users#2:json", until: { removal: "removed" } }],
      steps: [{ wait: 300 }] }, { env: { EXTERNAL_FETCH_TIMEOUT_MS: "ten-seconds" } });
    holdsReleased(o, 2);
    expect(o.eventsOf("u-2")[0], o.dump()).toEqual(deferral("recently_removed", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(o.eventsOf("u-2")[1]).toEqual(linkedTo(RECREATED, { already_existed: false }));
  });

  test("R2, the RUNNER removes it: the same, through the runner's DELETE", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceConcurrentAt: "DELETE /users/<id>",
      holds: [{ call: "DELETE /users/<id>", until: "GET /users#2" }, { call: "GET /users#2:json", until: { removal: "removed" } }],
      steps: ["cascade", { wait: 300 }] });
    holdsReleased(o, 2);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("recently_removed", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
    expect(o.dels).toEqual([DEL]);
    expect(o.ledger.map(r => r.cxone_user_id)).toEqual([RECREATED]);
  });

  // R3: the create collided (409) while the account existed; the searches ran
  // after it was gone and found nothing — a bare "not found in search", never
  // retried. It is the platform's own removal racing it, so it is deferred.
  test("R3: a 409, then searches after the removal finding nothing → deferred removal_raced_match, not a failure", () => {
    const o = provision({ createdId: ID, realm: true, deleteUserAt: "GET /groups", replaceConcurrentAt: "GET /groups",
      holds: [{ call: "DELETE /users/<id>", until: "POST /users#2" }, { call: "GET /users#1", until: { removal: "removed" } }],
      steps: [{ wait: 300 }] });
    holdsReleased(o, 2);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_raced_match", { retry_scheduled: true, retry_attempt: 1 }));
    expect(b.filter(e => typeof e.error === "string" && e.error.includes("not found in search")), "never the bare failure").toEqual([]);
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
  });

  // The likeliest R3 is the RETRY's: the first attempt deferred because the
  // DELETE was slow, and the retry 409s while it is still out. Every attempt asks
  // against its own create, so this defers again rather than failing.
  test("R3 on a RETRY: deferred removal_in_flight, then the retry's 409-then-nothing is deferred again — never the bare failure", () => {
    const o = provision({ createdId: ID, realm: true, deleteUserAt: "GET /groups", replaceConcurrentAt: "GET /groups",
      holds: [{ call: "GET /users#2:json", until: { removal: "in_flight" } },
        { call: "DELETE /users/<id>", until: "POST /users#3", fireRetries: true },
        { call: "GET /users#3", until: { removal: "removed" } }],
      steps: [{ wait: 300 }] });
    holdsReleased(o, 3);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(b[1], o.dump()).toEqual(deferral("removal_raced_match", { retry_scheduled: true, retry_attempt: 2 }));
    expect(b.filter(e => e.error), "no failure row").toEqual([]);
    expect(b[2], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
  });

  test("CONTROL: a 409 then an empty search with no removal anywhere is still the ordinary failure", () => {
    const o = provision({ create: 409, search: "empty" });
    expect(o.provisioned, o.dump()).toEqual([expect.objectContaining({ details: expect.objectContaining({ success: false,
      error: expect.stringContaining("not found in search") }) })]);
    expect(Object.keys(o.provisioned[0].details)).not.toContain("deferred");
  });

  // A removal that settled BEFORE this attempt's create left cannot explain its
  // 409: the collision was with something else. Asking "any removal lately?"
  // instead would defer every unrelated nickname collision in that realm for the
  // whole memory window — retried at once, up to five times, each re-sending the
  // person's name and address — and end on a false History line in place of the
  // real remedy.
  test("CONTROL: a removal settled BEFORE this attempt's create → its 409-then-nothing is the ordinary failure, not a deferral", () => {
    const o = provision({ noProvision: true, autorun: true, plantLedger: [{ id: ID }], create: 409, search: "empty",
      plantUsers: [{ id: "u-3", enrolIn: "c-1" }],
      steps: ["cascade", { wait: 5 }, { provision: "u-3" }, { wait: 50 }] });
    expect(o.stepLog[0].result && o.stepLog[0].result.cxoneWithdrawalsScheduled, `precondition: a removal ran: ${o.dump()}`).toBe(1);
    expect(o.stepCalls(0), o.dump()).toContain(DEL);
    expect(o.removals, "precondition: its tombstone is still remembered, in this realm").toEqual([expect.objectContaining({ id: ID, state: "removed" })]);
    const b = o.eventsOf("u-3");
    expect(b, o.dump()).toEqual([expect.objectContaining({ type: "cxone_provisioned", success: false, error: expect.stringContaining("not found in search") })]);
    expect(Object.keys(b[0])).not.toContain("deferred");
    expect(o.posts.filter(p => p.username === "u-3"), "one create, no retry").toHaveLength(1);
    expect(o.retriesPending).toBe(0);
    expect(o.deferredCounts.removal_raced_match).toBe(0);
  });
});

test.describe("v8.14 F2 — an unanswered removal holds matches until the realm answers", () => {
  // The runner's DELETE got no answer: the account may or may not be gone. Its
  // row is due a minute later and a one-shot re-read is ARMED for then — on its
  // own the runner runs only on kicks and the hourly sweep. `rereads` fires the
  // armed timer with the clock it would fire at; it runs nothing that was not armed.
  test("the DELETE throws → '0/delete_unanswered' due in a minute; the ARMED re-read finds it still there and hands it to the same person", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", throwAt: "DELETE /users/<id>",
      steps: ["cascade", "snapshot", "retries", "rereads", "retries"] });
    const row = rowOf(o.stepLog[1].result.ledger);
    expect(row, o.dump()).toMatchObject({ user_id: "u-1", last_error: "0/delete_unanswered", attempts: 1 });
    expect(Date.parse(row.next_attempt_at) - Date.parse(row.first_failed_at), "due in a minute").toBe(60_000);
    const b = o.eventsOf("u-2");
    expect(b[0]).toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(b[1], o.dump()).toEqual(deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 2 }));
    expect(o.stepCalls(2), "the retry's own kick finds nothing due yet").toEqual(B_DEFERRED);
    expect(o.stepLog[3].result, o.dump()).toMatchObject({ armed: [{ delayMs: 61_000 }], fired: 1 });
    expect(o.stepCalls(3), "the re-read: the realm still has it — no DELETE").toEqual(
      HANDED_OVER);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump()).toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "address_held_by_same_person" })]);
    expect(b[2], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
    expect(o.dels).toEqual([DEL]);
  });

  // (A retry that reaches the realm first needs no re-read at all: the account is
  // gone, so its own create is answered with a new one.)
  test("the DELETE throws but LANDED → the armed re-read reads 404: gone, its row with it; the waiting replacement gets a new account", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>",
      throwAt: [{ call: "DELETE /users/<id>", landed: true }], steps: ["cascade", "rereads", "retries"] });
    expect(o.stepLog[1].result, o.dump()).toMatchObject({ armed: [{ delayMs: 61_000 }], fired: 1 });
    expect(o.stepCalls(1), o.dump()).toEqual([TOKEN_T1, `GET /users/${ID}`]);
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ cxone_user_id: ID, result: "already_gone" })]);
    expect(rowOf(o.ledger), "the removed account's row is gone").toBeNull();
    const b = o.eventsOf("u-2");
    expect(b.map(e => e.deferred || "linked"), o.dump()).toEqual(["removal_in_flight", "linked"]);
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
  });

  test("the runner's DELETE answered 5xx: unknown too — '503/delete_failed' due in a minute, the same re-read", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", delStatus: 503,
      steps: ["cascade", "snapshot", "retries", "rereads", "retries"] });
    const row = rowOf(o.stepLog[1].result.ledger);
    expect(row, o.dump()).toMatchObject({ last_error: "503/delete_failed" });
    expect(Date.parse(row.next_attempt_at) - Date.parse(row.first_failed_at)).toBe(60_000);
    const b = o.eventsOf("u-2");
    expect(b[1], "a 5xx is not a refusal").toEqual(deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 2 }));
    expect(o.stepLog[3].result).toMatchObject({ fired: 1 });
    expect(b[2], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
  });

  // A link made DURING the unanswered removal (a writer the announcement does not
  // stop): the runner's next pass must not hand the account over on the strength
  // of that link before the realm has said whether it still exists — step 2 skips
  // the local hand-over while the removal is unanswered, and reads the realm first.
  test("a link made during an unanswered removal: the re-read asks the realm FIRST, then hands it over (it is still there)", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, plantUsers: [{ id: "u-2", email: "bee@acme.test", nickname: "bee", enrolIn: "c-1" }],
      bindAt: "DELETE /users/<id>", throwAt: "DELETE /users/<id>", steps: ["cascade", "rereads"] });
    expect(o.fired.bindLiving, o.dump()).not.toBeNull();
    expect(o.stepCalls(1), "the realm is read before any hand-over").toEqual(
      ADOPTION_CLEAN);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump()).toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
  });

  test("…and when the unanswered DELETE had landed, the re-read's 404 clears that link and sets the participant up again", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, plantUsers: [{ id: "u-2", email: "bee@acme.test", nickname: "bee", enrolIn: "c-1" }],
      bindAt: "DELETE /users/<id>", throwAt: [{ call: "DELETE /users/<id>", landed: true }], steps: ["cascade", "rereads"] });
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "already_gone", bindings_cleared: 1 })]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), "never handed over").toEqual([]);
    expect(o.eventsOf("u-2").map(e => e.type), o.dump()).toEqual(["cxone_binding_cleared", "cxone_provisioned"]);
    expect(o.bindingsOf("u-2")).toEqual([{ competition_id: "c-1", cxone_username: "bee", cxone_user_id: RECREATED }]);
  });

  // The hand-over and a tombstone: an account the platform has just removed is
  // never given to anyone. Reached when a row survives its own removal — here a
  // row recovered from history, which the job that removed the account did not
  // own (its record lost the INSERT), and a living participant linked since.
  test("a hand-over meets an account the platform has just removed: it is NOT handed over — gone, its row with it, the link cleared", () => {
    // No autorun: the cascade's own kick would read the realm (404) before the link exists.
    const o = provision({ createdId: ID, realm: true, plantLedger: [{ id: ID }], deleteUserAt: "GET /groups",
      steps: [{ plantUser: { id: "u-2", email: "bee@acme.test", nickname: "bee", enrolIn: "c-1", cxoneUserId: ID } }, { run: 0 }] });
    expect(o.abandoned, `precondition: the job removed it: ${o.dump()}`).toEqual([expect.objectContaining({ realm_account_withdrawn: true })]);
    expect(o.stepLog[1].result, o.dump()).toMatchObject({ attempted: 1 });
    expect(o.stepCalls(1).filter(c => c.includes(ID)), "no read, no DELETE of the removed account: the tombstone answers").toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump()).toEqual([]);
    expect(o.logOf("cxone_realm_account_withdrawn").map(d => d.result), o.dump()).toEqual(["already_gone"]);
    expect(o.ledger.map(r => r.cxone_user_id), "no row is left naming the removed account").not.toContain(ID);
    expect(o.eventsOf("u-2")[0], o.dump()).toMatchObject({ type: "cxone_binding_cleared", cleared_cxone_user_id: ID, reprovision: true });
    expect(boundOf(o), "set up again with an account of their own").toBe(RECREATED);
  });

  // Nothing re-read it: the window ends, and the retry re-observes the realm
  // itself (here the account is still there, so it is linked to it).
  test("with no re-read, the hold ends with the memory window and the retry asks the realm itself", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", throwAt: "DELETE /users/<id>",
      steps: ["cascade", "retries", { ageRemovals: HOLD_MS }, "retries"] });
    const b = o.eventsOf("u-2");
    expect(b.map(e => e.deferred || "linked"), o.dump()).toEqual(["removal_in_flight", "removal_outcome_unknown", "linked"]);
    expect(b[2]).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
  });
});

test.describe("v8.14 F2 — deferred set-ups: the cap, the shutdown, the boot and the remedy", () => {
  test("five retries at most: the sixth deferral says it was NOT retried, and nothing is left pending", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", throwAt: "DELETE /users/<id>",
      steps: ["cascade", "retries", "retries", "retries", "retries", "retries"] });
    const b = o.eventsOf("u-2");
    expect(b, o.dump()).toEqual([
      deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }),
      ...[2, 3, 4, 5].map(n => deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: true, retry_attempt: n })),
      deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: false }),
    ]);
    expect(o.retriesPending).toBe(0);
    expect(o.posts.filter(p => p.username === "u-2-nick"), "each attempt re-sent the create, six in all").toHaveLength(6);
    expect(o.deferredCounts).toMatchObject({ removal_in_flight: 1, removal_outcome_unknown: 5 });
  });

  test("SHUTDOWN starts no remote work: a pending retry is cancelled and said; the next boot resumes it", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", steps: ["cascade", "stopRetries", "resume"] });
    expect(o.stepLog[1].result, o.dump()).toBe(1);
    expect(o.stepCalls(1), "nothing reached the realm at the stop").toEqual([]);
    const b = o.eventsOf("u-2");
    expect(b[1], o.dump()).toEqual(deferral("removal_in_flight", { retry_scheduled: false, retry_attempt: 1, stopped: "shutdown" }));
    // The boot's re-queue reads that row and finishes the set-up.
    expect(o.stepLog[2].result, o.dump()).toBe(1);
    expect(b[2], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
    expect(o.retriesPending).toBe(0);
  });

  // A job already queued still runs in the drain. If it defers there, nothing can
  // be scheduled — and its row must say so the way the stop does, or the next
  // boot (which resumes only rows promising a retry) would leave it for good.
  test("a set-up that defers AFTER the stop is not rescheduled, says so as the stop does — and the next boot resumes it", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", throwAt: "DELETE /users/<id>",
      steps: ["cascade", "stopRetries", "resume", { ageRemovals: HOLD_MS }, "resume"] });
    const b = o.eventsOf("u-2");
    expect(b.slice(1, 3), o.dump()).toEqual([
      deferral("removal_in_flight", { retry_scheduled: false, retry_attempt: 1, stopped: "shutdown" }),
      deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: false, retry_attempt: 2, stopped: "shutdown" }),
    ]);
    expect(o.stepLog[2].result, "precondition: the first resume re-queued the stopped retry").toBe(1);
    expect(lines(o)).toContain("their set-up resumes when the server next starts");
    // The next boot (the removal's memory window over by then) picks it up.
    expect(o.stepLog[4].result, o.dump()).toBe(1);
    expect(b[3], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
    expect(b, o.dump()).toHaveLength(4);
    expect(o.retriesPending).toBe(0);
  });

  test("BOOT resumes only an unanswered deferral that promised a retry, for a member of an event that still provisions, written HERE", () => {
    const at = (s) => new Date(Date.now() - s * 1000).toISOString();
    const D = (deferred, extra = {}) => ({ competition_id: "c-1", success: false, deferred, matched_account_id: ID, instance_origin: ORIGIN, ...extra });
    const o = provision({ noProvision: true, realm: true,
      plantUsers: ["u-3", "u-4", "u-5", "u-6", "u-7", "u-8", "u-9"].map(id => ({ id, enrolIn: id === "u-6" ? undefined : "c-1" })),
      plantHistory: [
        { userId: "u-3", details: D("removal_in_flight", { retry_scheduled: true, retry_attempt: 2 }), at: at(60) },
        { userId: "u-7", details: D("recently_removed", { retry_scheduled: false, retry_attempt: 1, stopped: "shutdown" }), at: at(60) },
        { userId: "u-4", details: D("removal_in_flight", { retry_scheduled: true, retry_attempt: 1 }), at: at(60) },
        { userId: "u-4", details: { competition_id: "c-1", success: true, cxone_user_id: "kc-other" }, at: at(30) },
        { userId: "u-5", details: D("removal_outcome_unknown", { retry_scheduled: false }), at: at(60) },
        { userId: "u-6", details: D("removal_in_flight", { retry_scheduled: true, retry_attempt: 1 }), at: at(60) },
        // A copy of the database booted elsewhere (a staging restore) must not send
        // anyone to the real tenant: a row another installation wrote, and one
        // naming none, are left alone.
        { userId: "u-8", details: D("removal_in_flight", { retry_scheduled: true, retry_attempt: 1, instance_origin: "https://hackarena.example" }), at: at(60) },
        { userId: "u-9", details: (({ instance_origin, ...d }) => d)(D("removal_in_flight", { retry_scheduled: true, retry_attempt: 1 })), at: at(60) },
      ],
      steps: ["resume"] });
    expect(o.stepLog[0].result, o.dump()).toBe(2);
    expect(o.posts.map(p => p.username).sort(), "only the two that promised a retry, written here, are set up again").toEqual(["u-3", "u-7"]);
    for (const uid of ["u-3", "u-7"]) expect(o.eventsOf(uid).pop(), o.dump()).toEqual(expect.objectContaining({ success: true }));
    expect(lines(o)).toContain("2 deferred set-up(s) recorded by another installation (or none) were not resumed here");
  });

  // The boot's resume waits for the instance to be IN SERVICE — the withdrawal
  // runner's own gate, read live — so a boot in maintenance (or with a failed
  // check) resumes them once that clears, with no second restart.
  test("BOOT in maintenance: nothing resumes while the gate is closed; it resumes at the first check after it opens, once", () => {
    const D = { competition_id: "c-1", success: false, deferred: "removal_in_flight", matched_account_id: ID, retry_scheduled: true, retry_attempt: 1, instance_origin: ORIGIN };
    const o = provision({ noProvision: true, realm: true, plantUsers: [{ id: "u-3", enrolIn: "c-1" }],
      plantHistory: [{ userId: "u-3", details: D }],
      steps: [{ resumeWhenHealthy: false }, "resumeCheck", { resumeHealth: true }, "resumeCheck", "resumeCheck", { resumeWhenHealthy: true }] });
    expect(o.stepLog[0].result, "unhealthy at boot: it waits").toBeNull();
    expect(o.stepLog[1].result, "still closed: still waiting").toBeNull();
    expect(o.stepCalls(0).concat(o.stepCalls(1)), "nothing reached the realm while the gate was closed").toEqual([]);
    expect(o.stepLog[3].result, `open: the waiting check resumes it: ${o.dump()}`).toBe(1);
    expect(o.posts.map(p => p.username)).toEqual(["u-3"]);
    expect(o.eventsOf("u-3").pop(), o.dump()).toEqual(expect.objectContaining({ success: true }));
    expect(o.stepLog[4].result, "once: nothing waits any more").toBe("none_waiting");
    expect(o.stepLog[5].result, "once per process: a second start does nothing").toBeNull();
    expect(o.posts).toHaveLength(1);
  });

  test("…and a shutdown while it waits cancels it: nothing is resumed into the drain", () => {
    const D = { competition_id: "c-1", success: false, deferred: "removal_in_flight", matched_account_id: ID, retry_scheduled: true, retry_attempt: 1, instance_origin: ORIGIN };
    const o = provision({ noProvision: true, realm: true, plantUsers: [{ id: "u-3", enrolIn: "c-1" }],
      plantHistory: [{ userId: "u-3", details: D }],
      steps: [{ resumeWhenHealthy: false }, "stopRetries", { resumeHealth: true }, "resumeCheck"] });
    expect(o.stepLog[0].result).toBeNull();
    expect(o.stepLog[3].result, o.dump()).toBe("none_waiting");
    expect(o.posts, o.dump()).toEqual([]);
  });

  // THE REMEDY the History row names once retries have run out: assign them to
  // the event again. Narrow — only a member with no link whose latest row for the
  // event is a deferral, and no retry pending.
  test("RE-ASSIGN provisions nobody whose latest row for the event is anything but a deferral — a failure stays a failure", () => {
    const D = { competition_id: "c-1", success: false, deferred: "removal_outcome_unknown", matched_account_id: ID, retry_scheduled: false };
    const o = provision({ noProvision: true, realm: true,
      plantUsers: [{ id: "u-3", enrolIn: "c-1" }, { id: "u-4", enrolIn: "c-1" }],
      plantHistory: [{ userId: "u-3", details: { competition_id: "c-1", success: false, error: "CxOne create user failed (500)" } },
        { userId: "u-4", details: D }],
      steps: [{ reassign: "u-3" }, { reassign: "u-4" }] });
    expect(o.stepLog[0].result, "an ordinary failure is not re-queued by a re-assign").toBe(false);
    expect(o.stepCalls(0)).toEqual([]);
    expect(o.stepLog[1].result, "CONTROL — an exhausted deferral is").toBe(true);
    expect(o.posts.map(p => p.username)).toEqual(["u-4"]);
  });

  test("RE-ASSIGN re-queues an exhausted deferral — and only that", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>", throwAt: "DELETE /users/<id>",
      steps: ["cascade", { reassign: "u-2" }, "retries", "retries", "retries", "retries", "retries",
        { ageRemovals: HOLD_MS }, { reassign: "u-2" }, { reassign: "u-2" }] });
    expect(o.stepLog[1].result, "a retry is pending: not re-queued").toBe(false);
    expect(o.stepCalls(1)).toEqual([]);
    expect(o.eventsOf("u-2")[5], o.dump()).toEqual(deferral("removal_outcome_unknown", { matched_account_id: ID, retry_scheduled: false }));
    expect(o.stepLog[8].result, "exhausted: the re-assign re-queues it").toBe(true);
    expect(o.eventsOf("u-2")[6], o.dump()).toEqual(linkedTo(ID, { already_existed: true, matched_by: "email" }));
    expect(o.stepLog[9].result, "linked now: a re-assign provisions nobody").toBe(false);
    expect(o.stepCalls(9)).toEqual([]);
  });
  // A re-assign must never queue a SECOND job beside one already queued or
  // running for that participant and event: two creates for one person (the
  // second 409s, and History can show a failure after a success). The fired
  // retry's entry is gone before its job runs, and the boot's resume and an
  // earlier re-assign register no retry at all — so the remedy asks the queue.
  test("RE-ASSIGN while a fired retry's job is queued or running queues nothing more", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>",
      steps: ["cascade", { reassign: "u-2", after: "retries" }] });
    expect(o.eventsOf("u-2")[0], `precondition: deferred with a retry pending: ${o.dump()}`)
      .toEqual(deferral("removal_in_flight", { matched_account_id: ID, retry_scheduled: true, retry_attempt: 1 }));
    expect(o.stepLog[1].result, o.dump()).toEqual({ first: 1, r: false });
    expect(o.stepCalls(1).filter(c => c === "POST /users"), "one create — the retry's").toHaveLength(1);
    expect(o.eventsOf("u-2").slice(1), o.dump()).toEqual([linkedTo(RECREATED, { already_existed: false })]);
  });

  test("RE-ASSIGN beside the boot's resume, or twice in a row, queues one job", () => {
    const D = (extra) => ({ competition_id: "c-1", success: false, deferred: "removal_outcome_unknown", matched_account_id: ID, ...extra });
    const o = provision({ noProvision: true, realm: true,
      plantUsers: [{ id: "u-3", enrolIn: "c-1" }, { id: "u-4", enrolIn: "c-1" }],
      plantHistory: [{ userId: "u-3", details: D({ retry_scheduled: true, retry_attempt: 2, instance_origin: ORIGIN }) },
        { userId: "u-4", details: D({ retry_scheduled: false }) }],
      steps: [{ reassign: "u-3", after: "resume" }, { reassign: "u-4", after: "reassign" }] });
    expect(o.stepLog[0].result, o.dump()).toEqual({ first: 1, r: false });
    expect(o.stepLog[1].result, o.dump()).toEqual({ first: true, r: false });
    expect(o.posts.map(p => p.username), "one create each").toEqual(["u-3", "u-4"]);
    for (const uid of ["u-3", "u-4"]) expect(o.eventsOf(uid).slice(1), o.dump()).toEqual([expect.objectContaining({ success: true })]);
  });
});

test.describe("v8.14 F2 — a participant erased while deferred leaves no History behind", () => {
  // user_events has no FK: a row written for an erased participant brings their
  // History back. Each arm's CONTROL is the same scenario with nobody erased
  // ("RUNNER, removed" above; "SHUTDOWN starts no remote work" above).
  test("erased during the search that met the removal → abandoned, never deferred: no row, no retry", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>",
      deleteUserAt: "GET /users#2:json", deleteWho: "u-2", steps: ["cascade"] });
    expect(o.fired.replaceUser, o.dump()).not.toBeNull();
    expect(o.fired.deleteUser, "precondition: the replacement was erased during its address search's body read").toBeGreaterThan(o.fired.replaceUser);
    expect(o.stepCalls(0), o.dump()).toEqual([...FULL_WITHDRAWAL, ...B_DEFERRED]);
    expect(o.dbEventsOf("u-2"), `no History row for the erased replacement: ${o.dump()}`).toEqual([]);
    const ab = o.log.filter(j => j.event_type === "cxone_provision_abandoned" && j.scope_id === "u-2").map(j => j.details);
    expect(ab, o.dump()).toEqual([expect.objectContaining({ stage: "during_search", reason: "user_deleted" })]);
    expect(o.retriesPending, "nothing is retried for them").toBe(0);
    expect(o.deferredCounts.removal_in_flight, "not counted as a deferral").toBe(0);
  });

  test("erased while a retry was pending → the shutdown's stop writes nothing for them", () => {
    const o = provision({ createdId: ID, autorun: true, realm: true, replaceAt: "DELETE /users/<id>",
      steps: ["cascade", "pending", { erase: "u-2" }, "stopRetries"] });
    expect(o.stepLog[1].result, `precondition: the replacement's retry was pending when they were erased: ${o.dump()}`)
      .toEqual([expect.objectContaining({ userId: "u-2", attempt: 1 })]);
    expect(o.alive === false && !o.people["u-2"], "precondition: both are gone").toBe(true);
    expect(o.stepLog[3].result, o.dump()).toBe(0);
    expect(o.dbEventsOf("u-2"), o.dump()).toEqual([]);
  });
});

test.describe("v8.14 F2 — the repair layer: a link made anyway to an account the realm says is gone is cleared", () => {
  // `bindLiving` writes a binding with NO registry question — a writer prevention
  // cannot see — inside the runner's DELETE. The realm's answer (204) must clear
  // it and set the participant up again, under their OWN name.
  const BEE = { id: "u-2", email: "bee@acme.test", first_name: "Bee", last_name: "Living", nickname: "bee", enrolIn: "c-1" };
  const run = (extra) => provision({ createdId: ID, autorun: true, realm: true, plantUsers: [BEE], bindAt: "DELETE /users/<id>",
    bindUsername: "erin", steps: ["cascade"], ...extra });

  test("removed → the link (id AND the removed account's username) is cleared, said without naming anyone, and the set-up runs again under the participant's own name", () => {
    const o = run();
    expect(o.fired.bindLiving, o.dump()).not.toBeNull();
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual({ type: "cxone_binding_cleared", competition_id: "c-1", cleared_cxone_user_id: ID,
      reason: "realm_account_removed", reprovision: true });
    expect(Object.keys(b[0]), "the removed account's username is the erased participant's nickname").not.toContain("username");
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
    expect(o.bindingsOf("u-2"), o.dump()).toEqual([{ competition_id: "c-1", cxone_username: "bee", cxone_user_id: RECREATED }]);
    expect(o.posts[o.posts.length - 1], "the new account is named for the participant, not for the removed one")
      .toEqual({ username: "bee", email: "bee@acme.test" });
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "deleted", bindings_cleared: 1 })]);
    expect(Object.keys(o.logOf("cxone_realm_account_withdrawn")[0])).not.toContain("taken_over_during_withdrawal");
    expect(lines(o)).toContain("the link was cleared and their set-up queued again");
    expect(o.stepLog[0].scans, "the repair runs no living-binder scan of its own").toBe(2);
  });

  test("the JOB's own removal repairs the same way: the abandon line counts the cleared link, and nothing was taken over", () => {
    const o = provision({ createdId: ID, realm: true, plantUsers: [BEE], deleteUserAt: "GET /groups", bindAt: "DELETE /users/<id>",
      bindUsername: "erin", steps: ["queue"] });
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ realm_account_withdrawn: true, bindings_cleared: 1 })]);
    expect(Object.keys(o.abandoned[0]), "the record did not pass to anyone").not.toContain("taken_over_during_withdrawal");
    expect(o.eventsOf("u-2")[0], o.dump()).toMatchObject({ type: "cxone_binding_cleared", cleared_cxone_user_id: ID, reprovision: true });
    expect(o.bindingsOf("u-2")).toEqual([{ competition_id: "c-1", cxone_username: "bee", cxone_user_id: RECREATED }]);
    expect(lines(o)).toContain("the link was cleared and their set-up queued again");
  });

  test("…and when the realm holds ANOTHER account under the removed one's username, it is not mistaken for theirs", () => {
    const o = run({ realmAddAt: "DELETE /users/<id>", realmAdd: { id: "kc-other-erin", username: "erin", email: "other.erin@else.test" } });
    expect(o.fired.realmAdd, o.dump()).not.toBeNull();
    expect(o.bindingsOf("u-2"), o.dump()).toEqual([{ competition_id: "c-1", cxone_username: "bee", cxone_user_id: RECREATED }]);
    expect(o.calls.filter(c => c.includes("kc-other-erin")), "nothing granted to the stranger's account").toEqual([]);
  });

  test("CONTROL: refused (403) → the link stands, nothing is cleared, nobody is set up again", () => {
    const o = run({ delStatus: 403 });
    expect(o.fired.bindLiving, o.dump()).not.toBeNull();
    expect(o.eventsOf("u-2"), o.dump()).toEqual([]);
    expect(o.bindingsOf("u-2")).toEqual([{ competition_id: "c-1", cxone_username: "erin", cxone_user_id: ID }]);
    expect(o.posts.map(p => p.username), "only the original participant's create").toEqual(["erin"]);
    expect(o.stepLog[0].scans).toBe(2);
  });

  test("an event that no longer provisions: the link is cleared and NOT set up again, and says why", () => {
    const o = run({ disableCxoneAt: "DELETE /users/<id>" });
    expect(o.eventsOf("u-2"), o.dump()).toEqual([{ type: "cxone_binding_cleared", competition_id: "c-1", cleared_cxone_user_id: ID,
      reason: "realm_account_removed", reprovision: false, reprovision_skipped: "cxone_disabled" }]);
    expect(o.bindingsOf("u-2")).toEqual([{ competition_id: "c-1", cxone_username: null, cxone_user_id: null }]);
    expect(o.posts.map(p => p.username)).toEqual(["erin"]);
  });

  test("a row re-keyed meanwhile past the registry: forgotten with its removed account, and said as taken over", () => {
    const o = run({ bindAt: undefined, transferAt: "DELETE /users/<id>" });
    expect(o.fired.transferLiving, o.dump()).not.toBeNull();
    expect(o.ledger, "no row is left naming a removed account").toEqual([]);
    // No binding names the id here, so a living-binder ask would fall through
    // to its history scan — the repair must not make one.
    expect(o.stepLog[0].scans, "the repair runs no living-binder scan of its own").toBe(2);
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "deleted", taken_over_during_withdrawal: true })]);
  });
});

test.describe("v8.14 F2 — an account the ledger never held (the job's own unrecorded create) is guarded too", () => {
  // `kc-created` is not a UUID, so the job's create records NO ledger row and the
  // job's own `_abandon` is the only remover. The replacement accepts the account
  // first (no row to re-key), then its group lookup or grant straddles the DELETE.
  test("the grant refused (404) because the account was removed under it → deferred, not 'group assign failed'", () => {
    const o = provision({ realm: true, deleteUserAt: "GET /groups", replaceConcurrentAt: "GET /groups",
      holds: [{ call: "GET /groups#1:json", until: "GET /users#2:json" }, { call: "GET /groups#2", until: { removal: "removed", id: "kc-created" } }],
      steps: [{ wait: 300 }] });
    holdsReleased(o, 2);
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ realm_account_withdrawn: true })]);
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("recently_removed", { matched_account_id: "kc-created", retry_scheduled: true, retry_attempt: 1 }));
    expect(b.filter(e => typeof e.error === "string" && e.error.includes("group assign failed")), "never the bare failure").toEqual([]);
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
  });

  test("the grant answered while the DELETE was still out → deferred at the write-back, never linked to the account", () => {
    const o = provision({ realm: true, deleteUserAt: "GET /groups", replaceConcurrentAt: "GET /groups",
      holds: [{ call: "GET /groups#1:json", until: "GET /users#2:json" },
        { call: "PUT grant#1", until: { removal: "in_flight", id: "kc-created" } },
        { call: "DELETE /users/<id>", until: "PUT grant#1" }],
      steps: ["retries"] });
    holdsReleased(o, 3);
    expect(o.calls, "the replacement's grant was made — the deferral is the write-back's").toContain("PUT /users/kc-created/groups/g-1");
    const b = o.eventsOf("u-2");
    expect(b[0], o.dump()).toEqual(deferral("removal_in_flight", { matched_account_id: "kc-created", retry_scheduled: true, retry_attempt: 1 }));
    expect(b.filter(e => e.cxone_user_id === "kc-created"), "never linked to the removed account").toEqual([]);
    expect(b[1], o.dump()).toEqual(linkedTo(RECREATED, { already_existed: false }));
  });
});

test.describe("v8.14 F2 — the registry's own rules", () => {
  // Past its cap the registry forgets the oldest TOMBSTONES only: dropping an
  // announced or unanswered removal would let a match link an account whose
  // DELETE is still out — the gate failing open.
  test("past the cap, the oldest tombstones go — never a removal in flight or unanswered", () => {
    const o = provision({ noProvision: true, steps: ["evictionProbe"] });
    const r = o.stepLog[0].result;
    expect(r.max, "anti-vacuity: the cap the probe filled past").toBeGreaterThanOrEqual(1000);
    expect(r.size, o.dump()).toBe(r.max);
    expect(r.inFlight).toBe("removal_in_flight");
    expect(r.unknown).toBe("removal_outcome_unknown");
    expect(r.oldest, "the oldest tombstone was evicted").toBeNull();
    expect(r.newest, "CONTROL: a recent one is remembered").toBe("recently_removed");
  });

  // The hooks reach into process state (age the registry, fire retries, run the
  // boot's resume check); outside test they must refuse.
  test("every test hook throws unless NODE_ENV=test", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const { spawnSync } = require("child_process");
    const ROOT = path.join(__dirname, "..");
    const HOOKS = { "lib/cxone.js": ["_realmRemovalsSnapshotForTest", "_ageRealmRemovalsForTest", "_provisionRetriesSnapshotForTest",
      "_fireCxOneProvisionRetriesNowForTest", "_checkCxOneProvisionResumeNowForTest"],
    "lib/cxone-withdraw.js": ["_armedRereadsForTest", "_fireArmedRereadsForTest"] };
    const script = `globalThis.fetch = async () => { throw new Error("no network"); };
      const out = {};
      for (const [f, names] of Object.entries(${JSON.stringify(HOOKS)})) {
        const m = require(require("path").join(${JSON.stringify(ROOT)}, f));
        for (const n of names) {
          if (typeof m[n] !== "function") { out[n] = "missing"; continue; }
          try { m[n](0); out[n] = "ran"; } catch (e) { out[n] = /is a test hook/.test(e.message) ? "refused" : "threw:" + e.message; }
        }
      }
      process.stdout.write(JSON.stringify(out) + "\\n"); process.exit(0);`;
    const run = (nodeEnv) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxone-hooks-"));
      try {
        const r = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 30_000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), NODE_OPTIONS: "", NODE_ENV: nodeEnv,
            BASE_URL: "http://localhost", LOG_CONSOLE_MIRROR: "0",
            DATA_DIR: path.join(tmp, "data"), UPLOADS_DIR: path.join(tmp, "uploads") } });
        expect(r.status, `child exited ${r.status}: ${r.stderr}`).toBe(0);
        return JSON.parse(r.stdout.trim().split("\n").pop());
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    };
    const names = Object.values(HOOKS).flat();
    const prod = run("production");
    expect(prod, "outside test every hook refuses").toEqual(Object.fromEntries(names.map(n => [n, "refused"])));
    const testRun = run("test");
    expect(Object.values(testRun).filter(v => v !== "ran"), `CONTROL: under test each runs: ${JSON.stringify(testRun)}`).toEqual([]);
    expect(Object.keys(testRun)).toHaveLength(names.length);
  });
});

test.describe("v8.14 F2 — History words a deferral and a cleared link, and names nobody", () => {
  test.use({ baseURL: require("./helpers").BASE });
  test("the renderer the History dialog calls", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.formatEventChange === "function");
    const out = await page.evaluate(() => {
      const f = (event_type, details) => window.formatEventChange({ event_type, details });
      const D = { competition_id: "c-1", success: false, deferred: "removal_in_flight", matched_account_id: "x" };
      return {
        scheduled: f("cxone_provisioned", { ...D, retry_scheduled: true, retry_attempt: 1 }),
        exhausted: f("cxone_provisioned", { ...D, retry_scheduled: false }),
        stopped: f("cxone_provisioned", { ...D, retry_scheduled: false, stopped: "shutdown" }),
        cleared: f("cxone_binding_cleared", { competition_id: "c-1", cleared_cxone_user_id: "x", reason: "realm_account_removed", reprovision: true }),
        disabled: f("cxone_binding_cleared", { competition_id: "c-1", cleared_cxone_user_id: "x", reason: "realm_account_removed", reprovision: false, reprovision_skipped: "cxone_disabled" }),
        failed: f("cxone_provisioned", { competition_id: "c-1", success: false, error: "x-failure" }),
      };
    });
    expect(out.scheduled).toContain("not set up yet");
    expect(out.scheduled).toContain("will try again");
    expect(out.scheduled, "a deferral is not a failure").not.toContain("failed");
    expect(out.exhausted).toContain("was not retried automatically");
    expect(out.exhausted, "…and names the remedy that works").toContain("assign them to this event again");
    expect(out.stopped).toContain("restarted");
    expect(out.cleared).toContain("a new one is being set up");
    expect(out.disabled).toContain("Checkmarx One accounts are off for this event");
    expect(out.failed, "CONTROL: a real failure still reads as one").toContain("failed: x-failure");
    for (const l of [out.scheduled, out.exhausted, out.stopped, out.cleared, out.disabled]) {
      expect(l, "never the bare event type").not.toMatch(/^<span[^>]*>cxone_/);
      expect(l, "nobody named").not.toMatch(/deleted participant/i);
    }
  });
});
