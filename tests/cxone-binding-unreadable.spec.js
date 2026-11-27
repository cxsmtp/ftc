// @ts-check
//
// A LIVING PARTICIPANT'S CHECKMARX ONE SET-UP RECORD THAT CANNOT BE READ IS NOT
// "NOBODY" (sweep #407, operator ruling 24 Nov 2026: hold it, and a superadmin
// decides).
//
// Before a realm account is removed, both removers ask the one definition of "a
// living participant is bound to it" (lib/cxone-ledger.js `livingBinder`): an
// event binding, or that participant's own `cxone_provisioned` record naming the
// account. A record whose text names the account but which could not be read as
// JSON was counted in a variable nothing read and otherwise treated as naming
// nobody — so the runner went on to DELETE an account whose only local evidence
// of a living owner was that record. It is now its own answer
// (`BINDING_UNREADABLE`):
//   • the runner HOLDS the account (`binding_unreadable`, overridable), with no
//     remote call, at its local check and again at the synchronous gate right
//     before the DELETE; it never hands the account over on it either;
//   • Remove anyway (the hold named as `expected_hold`) removes it, and still
//     hands it to a participant a READABLE record or binding names;
//   • the provisioning job's own in-flight withdrawal skips its DELETE
//     (`realm_account_withdrawal_skipped: "binding_unreadable"`) and leaves the
//     row marked for the runner, which holds it.
//
// Driven through tests/cxone-provision-harness.cjs (a spawned child with the
// transport stubbed; tests/cxone-erasure-withdrawal.spec.js explains why). A
// record that cannot be read is planted as raw text (`detailsRaw`). Every arm
// asserts its precondition — the deletion fired, the row was recorded — and
// every hold is paired with the control that the same scenario with a READABLE
// record, or a damaged record naming ANOTHER account, does what it always did.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { provision } = require("./cxone-harness-client");
const { stripJsComments } = require("./doc-registry");

const ID = "5e1f0c2a-7b3d-4e8f-9a01-23456789abcd";
const OTHER = "6f2a1d3b-8c4e-4f9a-8b12-34567890bcde";
const TOKEN_T1 = "POST /auth/realms/tenant1/protocol/openid-connect/token";
const DEL = `DELETE /users/${ID}`;
// The runner's reads of an account nobody has taken into use, ending with the
// key's proof that it sees every role — the LAST await before its DELETE.
const ADOPTION_CLEAN = [TOKEN_T1, `GET /users/${ID}`, `GET /users/${ID}/federated-identity`,
  `GET /users/${ID}/groups?first=0&max=100`, `GET /users/${ID}/role-mappings`, `GET /users/${ID}/credentials`,
  "GET /clients?clientId=realm-management&first=0&max=1"];
const FULL_WITHDRAWAL = [...ADOPTION_CLEAN, DEL];
const PARKED = "9999-12-31T00:00:00.000Z";

// A provisioning record cut off mid-value — what a torn write or a hand edit
// leaves. Its text still names `id` the way a record does, so the LIKE
// pre-filter hands it to the JSON read; the tail is a token no log may carry.
const TAIL = "zq-unreadable-tail";
const damagedRecord = (id, userId = "u-2") => ({ userId,
  detailsRaw: `{"competition_id":"c-1","success":true,"already_existed":false,"cxone_user_id":"${id}","username":"${TAIL}` });
// The same participant's record, readable: a binding the runner honours.
const readableRecord = (id, userId = "u-2") => ({ userId,
  details: { competition_id: "c-1", success: true, already_existed: true, matched_by: "email", cxone_user_id: id, username: "holly" } });

const rowOf = (ledger, id = ID) => (ledger || []).find(r => r.cxone_user_id === id) || null;
const listed = (rows, id = ID) => (rows || []).find(r => r.cxone_user_id === id) || null;

/** PRECONDITION: step `i` is the real erasure cascade, and it stamped `n` rows. */
function cascaded(o, i, n) {
  const s = o.stepLog[i];
  expect(s && s.step, `step ${i} is not the cascade: ${o.dump()}`).toBe("cascade");
  expect(o.alive, "the participant must be gone").toBe(false);
  expect(s.result && s.result.cxoneWithdrawalsScheduled, `the cascade stamped the wrong number of rows: ${o.dump()}`).toBe(n);
}

/** The row as the runner leaves it held for this reason: no attempt charged, parked for a superadmin. */
function heldUnreadable(row, dump) {
  expect(row, dump).toMatchObject({ user_id: "u-1", held_reason: "binding_unreadable", held_signal: null, attention: 1,
    attempts: 0, first_failed_at: null, last_error: null, given_up_at: null, next_attempt_at: PARKED, claim_token: null });
  expect(row.pending_since, "still marked for removal").toEqual(expect.any(String));
}

test.describe("sweep #407 — the runner holds an account a record it cannot read may tie to a living participant", () => {
  test("B1 (THE FINDING): held binding_unreadable with ZERO remote calls and no attempt charged, listed with its remedy; CONTROL: a damaged record naming another account changes nothing", () => {
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }], plantHistory: [damagedRecord(ID)],
      steps: ["cascade", "list", "counts"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), `the hold needs no remote call: ${o.dump()}`).toEqual([]);
    expect(o.dels).toEqual([]);
    heldUnreadable(rowOf(o.ledger), o.dump());
    expect(o.binderOfCreated, "the one definition answers that it cannot say").toBe("binding_unreadable");
    expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([expect.objectContaining({ cxone_user_id: ID, reason: "binding_unreadable" })]);
    expect(Object.keys(o.logOf("cxone_realm_withdrawal_held")[0]), "no adoption sign rides this hold").not.toContain("signal");
    expect(o.totals, o.dump()).toMatchObject({ held: 1, withdrawn: 0, transferred: 0, failed: 0 });
    // Said at warn level — the account and realm only, never the record's text.
    const warn = o.log.filter(j => j.level === "warn" && /cannot be read/.test(String(j.msg)));
    expect(warn, o.dump()).toEqual([expect.objectContaining({ cxone_user_id: ID })]);
    expect(o.appLog.filter(l => l.includes(TAIL)), "nothing the damaged record holds reaches the log").toEqual([]);
    // The superadmin's list: held, overridable, with the server's own remedy.
    const r = listed(o.stepLog[1].result);
    expect(r, o.dump()).toMatchObject({ state: "held", reason: "binding_unreadable", held_reason: "binding_unreadable",
      overridable: true, held_signal: null, held_signal_text: null, attempts: 0 });
    expect(r.remedy).toMatch(/set-up record that names this account, but the record cannot be read/);
    expect(r.remedy).toMatch(/Remove anyway only if you are sure it belongs to the deleted participant alone\.$/);
    expect(o.stepLog[2].result, "counted as held").toMatchObject({ held: 1, retrying: 0, total: 1 });

    // CONTROL: the same damage on a record that names a DIFFERENT account is no
    // claim on this one — removed exactly as with no record at all.
    const c = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }], plantHistory: [damagedRecord(OTHER)],
      steps: ["cascade"] });
    cascaded(c, 0, 1);
    expect(c.stepCalls(0), c.dump()).toEqual(FULL_WITHDRAWAL);
    expect(c.ledger).toEqual([]);
    expect(c.binderOfCreated).toBeNull();
  });

  test("B2: a READABLE record of a living participant still wins — handed over with no remote call, never held", () => {
    // The same damaged record, beside the participant's readable one: positive
    // evidence decides, and a hand-over removes nothing.
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }, { id: "u-3" }],
      plantHistory: [damagedRecord(ID, "u-3"), readableRecord(ID, "u-2")], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.stepCalls(0), o.dump()).toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-2", pending_since: null, held_reason: null });
    expect(o.dels).toEqual([]);
  });

  test("B3: Remove anyway naming binding_unreadable removes it — the override is remembered and the record is not asked again", () => {
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }], plantHistory: [damagedRecord(ID)],
      steps: ["cascade", "snapshot", { retry: ID, override: true, expectedHold: "binding_unreadable" }] });
    cascaded(o, 0, 1);
    heldUnreadable(rowOf(o.stepLog[1].result.ledger), o.dump());
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "binding_unreadable",
      row: expect.objectContaining({ override_reason: "binding_unreadable", held_reason: null }) });
    // The record still cannot be read; the superadmin decided, so the runner
    // walks the realm's record and removes it.
    expect(o.binderOfCreated).toBe("binding_unreadable");
    expect(o.stepCalls(2), o.dump()).toEqual(FULL_WITHDRAWAL);
    expect(o.ledger).toEqual([]);
    expect(o.dels).toEqual([DEL]);
    expect(o.logOf("cxone_realm_account_withdrawn"), o.dump()).toEqual([expect.objectContaining({ result: "deleted" })]);
  });

  test("B4: an override naming another hold, or none, is refused and changes nothing; a plain Retry asks again and holds again, charging nothing", () => {
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }], plantHistory: [damagedRecord(ID)],
      steps: ["cascade", "snapshot",
        { retry: ID, override: true, expectedHold: "roles_unreadable" },
        { retry: ID, override: true, expectedHold: null },
        "snapshot", { retry: ID }, "snapshot"] });
    cascaded(o, 0, 1);
    const before = rowOf(o.stepLog[1].result.ledger);
    heldUnreadable(before, o.dump());
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ status: 409, code: "cxone_withdrawal_hold_changed",
      row: expect.objectContaining({ held_reason: "binding_unreadable", overridable: true }) });
    expect(o.stepLog[3].result, o.dump()).toMatchObject({ status: 400, code: "cxone_withdrawal_expected_hold_required" });
    expect(o.stepCalls(2)).toEqual([]);
    expect(o.stepCalls(3)).toEqual([]);
    expect(rowOf(o.stepLog[4].result.ledger), "a refused override leaves the row exactly as it was").toEqual(before);
    // A plain Retry is not a decision about the record: asked again, held again.
    expect(o.stepLog[5].result, o.dump()).toMatchObject({ ok: true, overridden: null });
    expect(o.stepCalls(5), "held again at the local check, with no remote call").toEqual([]);
    const again = rowOf(o.stepLog[6].result.ledger);
    heldUnreadable(again, o.dump());
    expect(again.override_reason).toBeNull();
    expect(o.dels).toEqual([]);
  });

  test("B5: a record that cannot be read, written during the LAST realm read, holds it at the gate before the DELETE; CONTROL: the same record readable is handed over", () => {
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }],
      plantHistoryAt: "GET /clients", plantHistoryLate: [damagedRecord(ID)], steps: ["cascade"] });
    cascaded(o, 0, 1);
    expect(o.fired.plantHistoryLate, `precondition: the record landed in the runner's last read: ${o.dump()}`).toBeGreaterThanOrEqual(o.provisionCalls);
    expect(o.stepCalls(0), "every read was made — and no DELETE").toEqual(ADOPTION_CLEAN);
    expect(o.dels).toEqual([]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ held_reason: "binding_unreadable", attempts: 0, user_id: "u-1" });
    expect(o.logOf("cxone_realm_withdrawal_held"), o.dump()).toEqual([expect.objectContaining({ reason: "binding_unreadable" })]);

    const c = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }],
      plantHistoryAt: "GET /clients", plantHistoryLate: [readableRecord(ID)], steps: ["cascade"] });
    cascaded(c, 0, 1);
    expect(c.fired.plantHistoryLate, `precondition: the control's record landed in the same read: ${c.dump()}`).toBeGreaterThanOrEqual(c.provisionCalls);
    expect(c.stepCalls(0), c.dump()).toEqual(ADOPTION_CLEAN);
    expect(c.logOf("cxone_realm_withdrawal_transferred"), c.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-2", reason: "bound_to_living_account" })]);
    expect(rowOf(c.ledger), c.dump()).toMatchObject({ user_id: "u-2", pending_since: null });
    expect(c.dels).toEqual([]);
  });

  test("B6: after Remove anyway, a participant a READABLE binding names is still handed the account — the override waives only the record nobody can read", () => {
    // "#2": the creating job's own read-back of the account is the first GET of
    // it; the first run after the cascade holds with no call, so the second is
    // the run that follows the override.
    const o = provision({ createdId: ID, autorun: true, plantUsers: [{ id: "u-2" }, { id: "u-3" }],
      plantHistory: [damagedRecord(ID)], bindAt: "GET /users/<id>#2", bindUser: "u-3",
      steps: ["cascade", "snapshot", { retry: ID, override: true }] });
    cascaded(o, 0, 1);
    heldUnreadable(rowOf(o.stepLog[1].result.ledger), o.dump());
    expect(o.stepLog[2].result, o.dump()).toMatchObject({ ok: true, overridden: "binding_unreadable" });
    expect(o.fired.bindLiving, `precondition: the binding landed in the run after the override: ${o.dump()}`).toBeGreaterThanOrEqual(o.stepLog[2].from);
    expect(o.stepCalls(2), o.dump()).toEqual(ADOPTION_CLEAN);
    expect(o.dels).toEqual([]);
    expect(o.logOf("cxone_realm_withdrawal_transferred"), o.dump())
      .toEqual([expect.objectContaining({ transferred_to_user_id: "u-3", reason: "bound_to_living_account" })]);
    expect(rowOf(o.ledger), o.dump()).toMatchObject({ user_id: "u-3", pending_since: null, override_reason: null });
  });
});

test.describe("sweep #407 — the provisioning job's own withdrawal skips an account such a record names", () => {
  // Two orderings, as for a read that throws (tests/cxone-replacement-takeover.spec.js):
  // an erasure during the group lookup lands after the row exists (the cascade
  // marks it); one during the CREATE lands before (only the job's own mark
  // reaches it — without that mark the runner never selects the row).
  for (const [at, source, stage] of [["GET /groups", "cascade", "before_group_grant"], ["POST /users", "in_flight", "before_group_lookup"]]) {
    test(`B7: erased during ${at} → no DELETE, skipped as binding_unreadable, the row marked (${source}), and the runner holds it with no remote call`, () => {
      const o = provision({ createdId: ID, plantUsers: [{ id: "u-2" }], plantHistory: [damagedRecord(ID)], deleteUserAt: at,
        steps: ["snapshot", { run: 0 }, "list"] });
      expect(o.fired.deleteUser, `precondition: the erasure landed during ${at}: ${o.dump()}`).not.toBeNull();
      expect(o.alive).toBe(false);
      expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ stage, reason: "user_deleted", cxone_user_id: ID,
        created_by_this_job: true, realm_account_withdrawal_skipped: "binding_unreadable" })]);
      expect(Object.keys(o.abandoned[0]), "no withdrawal was attempted").not.toContain("realm_account_withdrawn");
      expect(o.appLog.some(l => l.includes("cannot be read — it was NOT withdrawn")), "the job says why").toBe(true);
      expect(o.dels, `nothing removed the account: ${o.dump()}`).toEqual([]);
      const before = rowOf(o.stepLog[0].result.ledger);
      expect(before, o.dump()).toMatchObject({ user_id: "u-1", deletion_source: source, claim_token: null, attempts: 0 });
      expect(before.pending_since, "marked for the runner").toEqual(expect.any(String));
      expect(o.stepLog[1].result, o.dump()).toMatchObject({ attempted: 1 });
      expect(o.stepCalls(1), "the runner holds it at its local check").toEqual([]);
      heldUnreadable(rowOf(o.ledger), o.dump());
      expect(listed(o.stepLog[2].result), o.dump()).toMatchObject({ state: "held", reason: "binding_unreadable", overridable: true });
    });
  }

  test("B7 CONTROL: the same erasure beside a damaged record naming ANOTHER account — the job withdraws its account at once", () => {
    const o = provision({ createdId: ID, plantUsers: [{ id: "u-2" }], plantHistory: [damagedRecord(OTHER)], deleteUserAt: "GET /groups" });
    expect(o.fired.deleteUser, `precondition: the erasure landed mid-provisioning: ${o.dump()}`).not.toBeNull();
    expect(o.abandoned, o.dump()).toEqual([expect.objectContaining({ reason: "user_deleted", realm_account_withdrawn: true })]);
    expect(Object.keys(o.abandoned[0])).not.toContain("realm_account_withdrawal_skipped");
    expect(o.dels).toEqual([DEL]);
    expect(o.ledger).toEqual([]);
  });
});

test.describe("sweep #407 — where the gate before the DELETE asks", () => {
  // B5 lands the record in the runner's last read on the ordinary path. On a
  // path where that read is skipped (an overridden adoption or visibility hold)
  // the last await is an earlier one, which no stub here distinguishes — so the
  // placement is pinned too (the F6 lesson: a check moved one await earlier
  // passes every arm whose stub does not land in the LAST window). Comments are
  // stripped first, with the shared stripper.
  test("S: after the last await before the DELETE, the re-asked binder's unreadable answer is held unless overridden — before the removal is announced", () => {
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "cxone-withdraw.js"), "utf8"));
    const at = src.search(/async\s+function\s+_withdrawOne\s*\(/);
    expect(at, "_withdrawOne is gone — re-anchor this lock rather than weakening it").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at) + 2);
    const del = body.search(/method\s*:\s*"DELETE"/);
    expect(del, "anti-vacuity: _withdrawOne sends its DELETE").toBeGreaterThan(-1);
    const awaits = [...body.matchAll(/\bawait\b/g)].map(m => m.index);
    const own = awaits.filter(a => a < del).pop();
    const prev = awaits.filter(a => a < (own ?? -1)).pop();
    expect(own, "the DELETE is awaited").toBeDefined();
    expect(prev, "an await precedes the DELETE's own").toBeDefined();
    expect(body.slice(own, del), "the await found is the DELETE fetch's own").not.toContain(";");
    const win = body.slice(prev, own);
    const ask = /const\s+(\w+)\s*=\s*_livingBinder\(\s*id\s*\)\s*;/.exec(win);
    expect(ask, "the living binder is re-asked after the last await before the DELETE").toBeTruthy();
    const announce = win.search(/beginRealmRemoval\(/);
    expect(announce, "…before the removal is announced").toBeGreaterThan(ask.index);
    const gate = win.slice(ask.index, announce);
    const v = ask[1];
    expect(gate, "its answer is told apart from a binder's id").toMatch(new RegExp(String.raw`\b${v}\s*[!=]==\s*BINDING_UNREADABLE\b`));
    expect(gate, "an unreadable record holds the account unless a superadmin overrode that hold — and the run stops")
      .toMatch(/if\s*\(\s*!_overridden\(\s*row\s*,\s*"binding_unreadable"\s*\)\s*\)\s*\{\s*_holdBindingUnreadable\(\s*row\s*,\s*claim\s*,\s*now\s*,\s*ctx\s*\)\s*;\s*return\s*;\s*\}/);
    const helper = src.slice(src.search(/function\s+_holdBindingUnreadable\s*\(/));
    expect(helper.slice(0, helper.indexOf("\n}\n")), "the helper is the binding_unreadable hold")
      .toMatch(/_hold\(\s*row\s*,\s*claim\s*,\s*"binding_unreadable"\s*,\s*now\s*,\s*ctx\s*\)/);
  });
});
