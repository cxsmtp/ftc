// WHAT THE CODE DOOR TELLS A CALLER ABOUT AN ACCOUNT: NOTHING, UNTIL THE CODE IS RIGHT.
//
// POST /api/auth/code/redeem answers 200 for every outcome. Its order is what
// keeps an account's state private (routes/auth.js): a wrong code is answered
// `{ok:false}` BEFORE the account's lifecycle is consulted, and a correct code on
// a blocked or denied account is refused by `isCodeEligible` before anything
// signs in. Only a correct code on an account still waiting for approval learns
// so (`pending_approval`).
//
// Held here, each with its control:
//   * a wrong code is answered alike — status, body and cookie — for an approved,
//     a pending, a locked, a blocked and a denied account, and for an address no
//     account holds; the guess against the locked account is not counted again.
//     The controls: a correct code on the pending account DOES say it waits, and
//     the locked account's correct code is still honoured (each held a live code
//     throughout, so the guesses were guesses beside a real one);
//   * a correct, live, emailed code on a blocked account and on a denied one is
//     refused exactly as a wrong code is and signs nobody in — the block and the
//     denial leave the code stored, so it is the redeem's gate that refuses it.
//     The controls: the same code works once the account is unblocked, and a
//     pending account that was NOT denied is answered differently.
//
// The out-of-band split (denied_at set, blocked 0) is the v6.16.17 L1 arm of
// tests/functional-security-b.api.spec.js.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { freshCtx, apiLogin, registerPost, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const workAddress = (tag) => `${tag}-${Date.now()}-${++seq}@code-refusal.example`;
const FORM = { firstName: "Grace", lastName: "Refusal", company: "Analytical", title: "Engineer", country: "GB", timezone: "Europe/London" };
const wrongFor = (code) => (String(code).replace(/-/g, "") === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ");

// The lockout threshold, read from its one definition (requiring lib/lockout.js
// from the worker would open a database at module scope).
const LOCKOUT_MAX = Number((fs.readFileSync(path.join(__dirname, "..", "lib", "lockout.js"), "utf8").match(/\bconst\s+LOCKOUT_MAX\s*=\s*(\d+)/) || [])[1]);

/** An account made through the real doors, as a signed-up person (not signed in here). */
async function makeAccount(tag) {
  const email = workAddress(tag);
  const { api, csrf } = await freshCtx();
  const r = await registerPost(api, "/api/register", { headers: H(csrf), data: { ...FORM, email }, keepState: true });
  expect(r.status(), `sign-up ${tag}: ${await r.text()}`).toBe(200);
  await api.dispose();
  const row = sql(db => db.prepare("SELECT id, approved FROM users WHERE LOWER(email)=LOWER(?)").get(email));
  expect(row, `PRECONDITION: ${tag} exists`).toBeTruthy();
  return { tag, email, id: row.id, approved: row.approved };
}
/** Mail `email` a sign-in code through the entry door and read it back. */
async function mailCode(email) {
  const { api, csrf } = await freshCtx();
  await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
  await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
  const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
  expect(await r.json()).toEqual({ ok: true });
  const c = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  const body = c.ok() ? await c.json() : null;
  expect(body && body.via, `PRECONDITION: ${email} was mailed a sign-in code`).toBe("email");
  await api.dispose();
  return body.code;
}
/** One redeem from a browser that holds nothing: what any caller would see. */
async function redeemAsStranger(email, code) {
  const { api, csrf } = await freshCtx();
  try {
    const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
    const answer = { status: r.status(), body: await r.text(), cookie: r.headersArray().some(h => h.name.toLowerCase() === "set-cookie") };
    const me = (await api.get("/api/me")).status();
    return { answer, me };
  } finally { await api.dispose(); }
}
const codeRow = (id) => sql(db => db.prepare("SELECT login_code_hash, login_code_at, login_code_via, blocked, denied_at, locked_until, failed_login_count FROM users WHERE id=?").get(id));
const loginSuccesses = (id) => sql(db => db.prepare("SELECT COUNT(*) n FROM user_events WHERE user_id=? AND event_type='login_success'").get(id).n);
async function setApproval(sa, csrf, on) {
  const r = await sa.patch("/api/admin/settings", { headers: H(csrf), data: { require_account_approval: on } });
  expect(r.ok(), `require_account_approval=${on}: ${await r.text()}`).toBeTruthy();
}
function expectLiveCode(acct, ttl) {
  const row = codeRow(acct.id);
  expect(row.login_code_hash, `PRECONDITION: ${acct.tag} still holds its code`).toBeTruthy();
  expect(row.login_code_via, `PRECONDITION: ${acct.tag}'s code was emailed`).toBe("email");
  expect(Date.now() - Date.parse(row.login_code_at), `PRECONDITION: ${acct.tag}'s code is live`).toBeLessThan(ttl);
}

test.describe("the code door tells a caller nothing about an account until the code is right", () => {
  test("a wrong code is answered alike for an approved, a pending, a locked, a blocked and a denied account", async () => {
    expect(Number.isInteger(LOCKOUT_MAX) && LOCKOUT_MAX > 1, `PRECONDITION: lib/lockout.js declares LOCKOUT_MAX (read ${LOCKOUT_MAX})`).toBe(true);
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const ttl = (await (await sa.get("/api/config")).json()).login_code_ttl_ms;
      const approved = await makeAccount("approved");
      const locked = await makeAccount("locked");
      const blocked = await makeAccount("blocked");
      await setApproval(sa, csrf, true);
      const pending = await makeAccount("pending");
      const denied = await makeAccount("denied");
      expect([approved, locked, blocked].map(a => a.approved), "PRECONDITION: approved at sign-up").toEqual([1, 1, 1]);
      expect([pending, denied].map(a => a.approved), "PRECONDITION: held for approval").toEqual([0, 0]);

      // Each holds a live code first, so every guess below is a guess beside a real one.
      const all = [approved, pending, locked, blocked, denied];
      const codes = {};
      for (const a of all) codes[a.tag] = await mailCode(a.email);

      // Into their states, through the doors an admin and a guesser use.
      const b = await sa.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(csrf) });
      expect(b.ok(), `block: ${await b.text()}`).toBeTruthy();
      const d = await sa.post(`/api/admin/participants/${denied.id}/deny`, { headers: H(csrf), data: { reason: "test" } });
      expect(d.ok(), `deny: ${await d.text()}`).toBeTruthy();
      {
        const { api, csrf: gc } = await freshCtx();
        for (let i = 0; i < LOCKOUT_MAX; i++) {
          const r = await api.post("/api/auth/code/redeem", { headers: H(gc), data: { email: locked.email, code: wrongFor(codes.locked) } });
          expect((await r.json()).ok, `guess ${i + 1}`).toBe(false);
        }
        await api.dispose();
      }
      expect(codeRow(blocked.id).blocked, "PRECONDITION: blocked").toBe(1);
      expect(codeRow(denied.id).denied_at, "PRECONDITION: denied").toBeTruthy();
      const lockedBefore = codeRow(locked.id);
      expect(Date.parse(lockedBefore.locked_until), "PRECONDITION: the guesses armed the lock").toBeGreaterThan(Date.now());
      for (const a of all) expectLiveCode(a, ttl);

      // THE GUESS, from a browser that holds nothing — plus an address nobody holds.
      const answers = {};
      for (const a of all) answers[a.tag] = await redeemAsStranger(a.email, wrongFor(codes[a.tag]));
      answers.nobody = await redeemAsStranger(workAddress("nobody"), "ZZZZZZZZ");
      expect(answers.approved.answer, "the reference: what a wrong code is answered").toMatchObject({ status: 200, body: '{"ok":false}' });
      for (const k of ["pending", "locked", "blocked", "denied", "nobody"]) {
        expect(answers[k].answer, `a wrong code on a ${k} account is answered exactly as on an approved one`).toEqual(answers.approved.answer);
        expect(answers[k].me, `…and signs nobody in (${k})`).toBe(401);
      }
      expect(codeRow(locked.id).failed_login_count, "a guess while locked is not counted again").toBe(lockedBefore.failed_login_count);

      // THE CONTROLS. The pending state IS visible to a correct code, so the
      // uniform answer above is the door's order, not a server that never says it.
      const right = await redeemAsStranger(pending.email, codes.pending);
      expect(right.answer.body, "a correct code on the pending account says it waits").toBe('{"ok":false,"error":"pending_approval"}');
      // And the lock held a live code throughout: the correct one is still honoured.
      const unlocked = await redeemAsStranger(locked.email, codes.locked);
      expect(JSON.parse(unlocked.answer.body).ok, "the locked account's correct code is honoured").toBe(true);
      expect(unlocked.me, "…and signs in").toBe(200);
    } finally {
      await setApproval(sa, csrf, false);
      await sa.dispose();
    }
  });

  test("a correct, live code on a blocked or a denied account is refused like a wrong one; unblocked, the same code signs in", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const ttl = (await (await sa.get("/api/config")).json()).login_code_ttl_ms;
      const blocked = await makeAccount("blocked");
      await setApproval(sa, csrf, true);
      const denied = await makeAccount("denied");
      const pending = await makeAccount("pending");
      expect(blocked.approved, "PRECONDITION: approved").toBe(1);
      expect([denied.approved, pending.approved], "PRECONDITION: held for approval").toEqual([0, 0]);
      const codes = {};
      for (const a of [blocked, denied, pending]) codes[a.tag] = await mailCode(a.email);

      const b = await sa.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(csrf) });
      expect(b.ok(), `block: ${await b.text()}`).toBeTruthy();
      const d = await sa.post(`/api/admin/participants/${denied.id}/deny`, { headers: H(csrf), data: { reason: "test" } });
      expect(d.ok(), `deny: ${await d.text()}`).toBeTruthy();
      expect(codeRow(blocked.id).blocked, "PRECONDITION: blocked").toBe(1);
      expect(codeRow(denied.id).denied_at, "PRECONDITION: denied").toBeTruthy();
      // Neither act clears the code: what refuses it below is the redeem's own gate.
      expectLiveCode(blocked, ttl);
      expectLiveCode(denied, ttl);

      for (const a of [blocked, denied]) {
        const signedIn = loginSuccesses(a.id);
        const r = await redeemAsStranger(a.email, codes[a.tag]);
        expect(r.answer.status, `${a.tag}: 200, as every refusal at this door`).toBe(200);
        expect(r.answer.body, `${a.tag}: the correct code is refused exactly as a wrong one`).toBe('{"ok":false}');
        expect(r.me, `${a.tag}: …and signs nobody in`).toBe(401);
        expect(loginSuccesses(a.id), `${a.tag}: no sign-in is recorded`).toBe(signedIn);
      }

      // THE CONTROLS. An account held for approval but NOT denied is answered
      // differently, so the bare refusal above is the denial's. (The deny door
      // also sets blocked; a denial alone, blocked cleared out of band, is the
      // v6.16.17 L1 arm of tests/functional-security-b.api.spec.js.)
      const held = await redeemAsStranger(pending.email, codes.pending);
      expect(held.answer.body, "a pending account's correct code says it waits").toBe('{"ok":false,"error":"pending_approval"}');
      // …and the blocked account's code was the right one all along: unblocked
      // (the same toggle), it signs in.
      const u = await sa.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(csrf) });
      expect(u.ok(), `unblock: ${await u.text()}`).toBeTruthy();
      expect(codeRow(blocked.id).blocked, "PRECONDITION: unblocked").toBe(0);
      // Counted from here: the sign-up itself already signed the account in once.
      const signedInBefore = loginSuccesses(blocked.id);
      const back = await redeemAsStranger(blocked.email, codes.blocked);
      expect(JSON.parse(back.answer.body).ok, `the same code signs in once unblocked: ${back.answer.body}`).toBe(true);
      expect(back.me).toBe(200);
      expect(loginSuccesses(blocked.id), "…and that sign-in is recorded").toBe(signedInBefore + 1);
    } finally {
      await setApproval(sa, csrf, false);
      await sa.dispose();
    }
  });

  test("an admin's manual verify leaves a sign-in code the person holds working", async () => {
    // An unverified account (registerPost's fixture rewind: the state an older or
    // imported account is in), holding a live emailed code.
    const email = workAddress("manual-verify");
    {
      const { api, csrf } = await freshCtx();
      const r = await registerPost(api, "/api/register", { headers: H(csrf), data: { ...FORM, email } });
      expect(r.status(), `sign-up: ${await r.text()}`).toBe(200);
      await api.dispose();
    }
    const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)).id;
    const state = () => sql(db => db.prepare("SELECT verified, login_code_hash FROM users WHERE id=?").get(id));
    expect(state().verified, "PRECONDITION: unverified").toBe(0);
    const first = await mailCode(email);
    const firstHash = state().login_code_hash;
    expect(firstHash, "PRECONDITION: the code is stored").toBeTruthy();
    // CONTROL: the stored hash moves when the code is replaced, so the equality
    // below can tell a code that survived from one that did not.
    const code = await mailCode(email);
    expect(code, "PRECONDITION: a second code was minted").not.toBe(first);
    const before = state().login_code_hash;
    expect(before, "the stored hash moves with the code").not.toBe(firstHash);

    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const v = await sa.post(`/api/admin/participants/${id}/verify`, { headers: H(csrf) });
      expect(v.status(), `verify: ${await v.text()}`).toBe(200);
    } finally { await sa.dispose(); }
    expect(state().verified, "the manual verify verified the account").toBe(1);
    expect(state().login_code_hash, "…and left the code the person holds stored").toBe(before);

    const r = await redeemAsStranger(email, code);
    expect(JSON.parse(r.answer.body).ok, `the held code still signs in: ${r.answer.body}`).toBe(true);
    expect(r.me).toBe(200);
  });
});
