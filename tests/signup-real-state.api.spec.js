// @ts-check
//
// WHAT A REAL SIGN-UP IS, BEFORE AND AFTER ITS FIRST SIGN-IN — and how it
// differs from the state the suite's fixtures run on.
//
// `tests/helpers.js` `registerPost` runs the real doors (an address proof
// requested, redeemed, then the form) and, unless `keepState: true`, rewinds the
// new account through the test-only POST /api/test/registration-legacy-state to a
// FIXTURE state: unverified with a live verify_code, never signed in, and pending
// unless a join link or an invitation made it. No sign-up creates that state any
// more (only an older or imported account can be in it), so the arms below pin
// what the doors really create, by value, with `keepState: true`:
//   * an ordinary sign-up: verified (no verify_code: the proven address needs no
//     link), approved, and signed in by the sign-up itself — its first sign-in;
//   * a held sign-up (Require account approval on): verified, unapproved, never
//     signed in, with no verify_code; its emailed code is refused until an
//     administrator approves it, and then signs it in (its first sign-in).
// The CONTRAST arm runs the same doors through registerPost's default, so a
// helper that stopped rewinding, or rewound a keepState account, fails here.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, codeLogin, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const FORM = { firstName: "Real", lastName: "State", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" };
let seq = 0;
const addr = (tag) => `${tag}-${Date.now()}-${++seq}@realstate.example`;

function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const row = (email) => sql(db => db.prepare(
  `SELECT id, verified, first_verified_at, verify_code, verify_code_at, approved, approved_at, approved_by,
          login_time, last_login_time, pending_self_enroll_comp_id, job_function, city FROM users WHERE LOWER(email)=LOWER(?)`).get(email));
const events = (userId, type) => sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type=? ORDER BY rowid").all(userId, type))
  .map(r => JSON.parse(r.details || "{}"));

/** Sign `email` up through registerPost (the real doors); the registration's answer. */
async function signUp(email, opts = {}) {
  const { api, csrf } = await freshCtx();
  try {
    const { extra, ...rest } = opts;
    const r = await registerPost(api, "/api/register", { headers: H(csrf), data: { ...FORM, ...(extra || {}), email }, ...rest });
    return { status: r.status(), body: await r.json() };
  } finally { await api.dispose(); }
}

test("an ordinary sign-up is verified, approved and signed in by the sign-up itself, with no verify_code; registerPost's default rewinds the same sign-up to a state no sign-up creates (CONTRAST)", async () => {
  const email = addr("ordinary");
  const r = await signUp(email, { keepState: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const u = row(email);
  expect(r.body, "the sign-up answers as a sign-in does").toMatchObject({ ok: true, id: u.id, userRole: "participant", verified: true });
  expect(r.body.pendingApproval, "nothing waits").toBeUndefined();
  expect(u, "verified and approved at creation, with no verification link").toMatchObject({
    verified: 1, approved: 1, approved_by: "email_proof", verify_code: null, verify_code_at: null, pending_self_enroll_comp_id: null,
  });
  expect(u.first_verified_at, "the proven address is the first verification").toBeTruthy();
  expect(u.approved_at).toBeTruthy();
  // The short form leaves City and Job function out (optional by default), and
  // nothing fills them in: the account stores neither.
  expect({ job_function: u.job_function, city: u.city }, "a short-form sign-up that leaves out City and Job function stores neither")
    .toEqual({ job_function: null, city: null });
  expect(u.login_time, "signed in by the sign-up itself: its first sign-in").toBeTruthy();
  expect(u.last_login_time).toBe(u.login_time);
  expect(events(u.id, "login_success").map(d => d.method), "recorded as a sign-in through the address proof").toEqual(["email_proof"]);
  expect(events(u.id, "self_verified").map(d => d.via)).toEqual(["email_proof"]);
  expect(events(u.id, "approved").map(d => d.via)).toEqual(["email_proof_auto_approval"]);

  // A later sign-in is not its first: the first sign-in time stays the sign-up's.
  await (await apiLogin(email)).api.dispose();
  const later = row(email);
  expect(later.login_time, "the first sign-in time is kept").toBe(u.login_time);
  expect(events(u.id, "login_success").map(d => d.method)).toEqual(["email_proof", "login_code"]);

  // CONTRAST — the same doors through registerPost's DEFAULT: the account is
  // rewound to the fixture state, though its own History records the sign-up's
  // sign-in and verification.
  const fx = addr("fixture");
  const f = await signUp(fx);
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const fu = row(fx);
  expect(fu, "the fixture state: unverified, pending, never signed in").toMatchObject({
    verified: 0, first_verified_at: null, approved: 0, approved_at: null, approved_by: null, login_time: null, last_login_time: null,
  });
  expect(fu.verify_code, "…with a live verification link, which no sign-up mints").toBeTruthy();
  expect(fu.verify_code_at).toBeTruthy();
  expect(events(fu.id, "login_success").map(d => d.method), "while the doors it ran signed it in").toEqual(["email_proof"]);
  expect(events(fu.id, "self_verified").map(d => d.via), "and verified it").toEqual(["email_proof"]);

  // CONTROL for the stored-neither check above: the same doors with City and Job
  // function sent store exactly what was sent, so that check can tell.
  const wf = addr("with-fields");
  const w = await signUp(wf, { keepState: true, extra: { jobFunction: "Software Developer / Engineer", city: "Leeds" } });
  expect(w.status, JSON.stringify(w.body)).toBe(200);
  expect((({ job_function, city }) => ({ job_function, city }))(row(wf)), "sent fields are stored as sent")
    .toEqual({ job_function: "Software Developer / Engineer", city: "Leeds" });
});

test("a held sign-up (Require account approval on) is verified, unapproved and never signed in, with no verify_code; its emailed code is refused until an administrator approves it, and then signs it in", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  expect((await (await sa.get("/api/admin/settings")).json()).require_account_approval, "PRECONDITION: the setting starts at its default, off").toBe(false);
  try {
    const on = await sa.patch("/api/admin/settings", { headers: H(csrf), data: { require_account_approval: true } });
    expect(on.ok(), await on.text()).toBeTruthy();
    const email = addr("held");
    const r = await signUp(email, { keepState: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body, "the sign-up says it waits, and signs nobody in").toEqual({ ok: true, pendingApproval: true, email });
    const u = row(email);
    expect(u, "verified (the address is proven), unapproved, never signed in, no verification link").toMatchObject({
      verified: 1, approved: 0, approved_at: null, approved_by: null, login_time: null, last_login_time: null, verify_code: null, verify_code_at: null,
    });
    expect(u.first_verified_at).toBeTruthy();
    expect(events(u.id, "login_success"), "no sign-in on record").toEqual([]);

    // Before approval its emailed code is refused, and still no sign-in.
    const early = await freshCtx();
    try {
      const li = await codeLogin(early.api, email, H(early.csrf));
      expect(li.status(), "refused while waiting").toBe(403);
      expect((await li.json()).error).toBe("pending_approval");
    } finally { await early.api.dispose(); }
    expect(row(email), "still waiting, still never signed in").toMatchObject({ approved: 0, login_time: null, last_login_time: null });

    const ap = await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
    expect(ap.ok(), `approve: ${await ap.text()}`).toBeTruthy();
    expect(row(email), "approved by an administrator, still never signed in").toMatchObject({ approved: 1, login_time: null });

    // Approved, the emailed code signs it in: its first sign-in.
    const s = await apiLogin(email);
    expect(s.body).toMatchObject({ ok: true, id: u.id, verified: true });
    await s.api.dispose();
    const after = row(email);
    expect(after.login_time, "the first sign-in is stamped").toBeTruthy();
    expect(after.last_login_time).toBe(after.login_time);
    expect(events(u.id, "login_success").map(d => d.method)).toEqual(["login_code"]);
  } finally {
    await sa.patch("/api/admin/settings", { headers: H(csrf), data: { require_account_approval: false } });
    await sa.dispose();
  }
});
