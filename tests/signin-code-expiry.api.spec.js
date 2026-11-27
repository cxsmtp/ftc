// HOW LONG A CODE LIVES, AND HOW OFTEN AN ADDRESS IS SENT A PROOF.
//
// An emailed sign-in code (lib/login-code.js) and an address proof — the code an
// address no account holds is mailed (lib/email-proof.js) — each live for
// LOGIN_CODE_TTL_MS, read here from the server itself (GET /api/config
// `login_code_ttl_ms`), never retyped. Emailed codes are how nearly every account
// signs in, so a change letting an old code work must fail a test.
//
// What is held, each beside the control that makes it mean something:
//   * a correct sign-in code past its lifetime is answered exactly as a wrong code
//     is and signs nobody in; the SAME code a minute inside its lifetime signs in;
//   * a proof is minted with exactly that lifetime; a correct proof past it is
//     refused and buys no sign-up grant, while a live one redeems; the session GC
//     removes the expired proof and keeps the live one;
//   * an address is mailed at most LOGIN_CODE_MAX_SENDS proofs a window (the next
//     window starts again), and ONE origin may spend only two of them: the third
//     is kept for somebody else.
//
// Every request from this spec comes from one origin (127.0.0.1), so the address
// cap is reached only by clearing the per-origin share between asks
// (POST /api/test/reset-origin-code-budget); the origin test leaves it in place.
// The two-minute re-send suppression is lifted the same way for both
// (POST /api/test/reset-recent-code-sends, which also lifts a proof's).
const { test, expect } = require("./isolated-test");
const { freshCtx, registerPost, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const workAddress = (tag) => `${tag}-${Date.now()}-${++seq}@code-expiry.example`;
const FORM = { firstName: "Ada", lastName: "Expiry", company: "Analytical", title: "Engineer", country: "GB", timezone: "Europe/London" };
// A well-formed code (Crockford base32) that is not the one minted.
const wrongFor = (code) => (String(code).replace(/-/g, "") === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ");

async function lastCode(api, email) {
  const r = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  return r.ok() ? r.json() : null;
}
async function serverTtl(api) {
  const ttl = (await (await api.get("/api/config")).json()).login_code_ttl_ms;
  expect(Number.isInteger(ttl) && ttl >= 2 * 60_000, `PRECONDITION: the server states a code lifetime (${ttl})`).toBe(true);
  return ttl;
}
const proofRow = (email) => sql(db => db.prepare("SELECT * FROM email_proofs WHERE email_norm=?").get(email.toLowerCase()));

test.describe("a sign-in code and an address proof stop working when they expire", () => {
  test("a correct sign-in code past its lifetime is refused like a wrong one; the same code inside it signs in", async () => {
    const email = workAddress("code");
    {
      const { api, csrf } = await freshCtx();
      const made = await registerPost(api, "/api/register", { headers: H(csrf), data: { ...FORM, email }, keepState: true });
      expect(made.status(), await made.text()).toBe(200);
      await api.dispose();
    }
    const acct = sql(db => db.prepare("SELECT id, approved, verified, blocked, denied_at FROM users WHERE LOWER(email)=LOWER(?)").get(email));
    expect(acct, "PRECONDITION: an approved, verified account that may sign in").toMatchObject({ approved: 1, verified: 1, blocked: 0, denied_at: null });

    const { api, csrf } = await freshCtx();
    const ttl = await serverTtl(api);
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
    const rq = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(await rq.json()).toEqual({ ok: true });
    const mailed = await lastCode(api, email);
    expect(mailed && mailed.via, "PRECONDITION: an emailed sign-in code").toBe("email");
    const redeem = (code) => api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
    // The window is anchored on login_code_at (the first mint); moving it is the
    // only way to move a code's clock.
    const anchor = (ageMs) => sql(db => db.prepare("UPDATE users SET login_code_at=? WHERE id=?").run(new Date(Date.now() - ageMs).toISOString(), acct.id).changes);

    const wrong = await redeem(wrongFor(mailed.code));
    expect(wrong.status()).toBe(200);
    const wrongText = await wrong.text();
    expect(wrongText, "PRECONDITION: what a wrong code is answered").toBe('{"ok":false}');

    expect(anchor(ttl + 5_000), "PRECONDITION: the code's window is moved back").toBe(1);
    const stale = await redeem(mailed.code);
    expect(stale.status(), "200, like every refusal at this door").toBe(200);
    expect(await stale.text(), "an expired code is answered exactly as a wrong one").toBe(wrongText);
    expect((await api.get("/api/me")).status(), "…and signs nobody in").toBe(401);
    expect(sql(db => db.prepare("SELECT login_code_hash FROM users WHERE id=?").get(acct.id)).login_code_hash,
      "refused for its age: the code is still the one stored").toBeTruthy();

    // THE CONTROL: the same code, a minute inside its lifetime. Without it, the
    // refusal above is equally satisfied by a code that never worked at all.
    anchor(ttl - 60_000);
    const live = await redeem(mailed.code);
    expect(await live.json(), "the same code inside its lifetime signs in").toMatchObject({ ok: true });
    const me = await api.get("/api/me");
    expect(me.status(), `signed in: ${await me.text()}`).toBe(200);
    expect((await me.json()).email).toBe(email);
    await api.dispose();
  });

  test("a proof lives exactly a code's lifetime; past it a correct proof grants nothing, and the GC removes it", async () => {
    const { api, csrf } = await freshCtx();
    const ttl = await serverTtl(api);
    const dead = workAddress("proof-dead");
    const alive = workAddress("proof-live");
    for (const email of [dead, alive]) {
      await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
      await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
      const rq = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
      expect(await rq.json()).toEqual({ ok: true });
    }
    const deadCode = await lastCode(api, dead);
    const aliveCode = await lastCode(api, alive);
    expect([deadCode && deadCode.via, aliveCode && aliveCode.via], "PRECONDITION: both addresses were mailed a proof").toEqual(["proof", "proof"]);
    for (const email of [dead, alive]) {
      const row = proofRow(email);
      expect(Date.parse(row.expires_at) - Date.parse(row.created_at), `${email}: a proof is minted to live exactly a code's lifetime`).toBe(ttl);
    }

    expect(sql(db => db.prepare("UPDATE email_proofs SET expires_at=? WHERE email_norm=?").run(new Date(Date.now() - 1_000).toISOString(), dead.toLowerCase()).changes),
      "PRECONDITION: the first proof is moved past its expiry").toBe(1);
    const stale = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email: dead, code: deadCode.code } });
    expect(stale.status()).toBe(200);
    expect(await stale.text(), "an expired proof is answered exactly as a wrong code").toBe('{"ok":false}');
    const form = await api.post("/api/register", { headers: H(csrf), data: { ...FORM, email: dead } });
    expect(form.status(), "it bought no sign-up grant").toBe(403);
    expect((await form.json()).code).toBe("email_proof_required");
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM users WHERE LOWER(email)=LOWER(?)").get(dead).n), "and no account").toBe(0);

    // The session GC reclaims the expired proof and leaves the live one. State,
    // not the pass's count: the 5-minute timer may have run the same sweep first.
    const sweep = await api.post("/api/test/sweep-sessions", { headers: H(csrf) });
    expect(sweep.ok(), await sweep.text()).toBeTruthy();
    expect(proofRow(dead), "the expired proof is swept").toBeUndefined();
    expect(proofRow(alive), "the live one is kept").toBeTruthy();

    // THE CONTROL: a proof minted the same way, still inside its lifetime.
    const live = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email: alive, code: aliveCode.code } });
    expect(await live.json(), "a live proof redeems").toMatchObject({ ok: true, needsProfile: true, email: alive });
    await api.dispose();
  });
});

test.describe("an address with no account is sent a bounded number of proofs", () => {
  // The scope_id the proof's records share (a fingerprint, never the address),
  // taken from this address's own request record.
  const proofScope = (requestedAfterRowid) => sql(db => db.prepare(
    "SELECT scope_id FROM orphan_events WHERE event_type='email_proof_requested' AND rowid>? ORDER BY rowid DESC LIMIT 1").get(requestedAfterRowid)).scope_id;
  const lastRowid = () => sql(db => db.prepare("SELECT COALESCE(MAX(rowid),0) m FROM orphan_events").get().m);
  const refusals = (scope, reason) => sql(db => db.prepare(
    "SELECT COUNT(*) n FROM orphan_events WHERE event_type='email_proof_refused' AND scope_id=? AND json_extract(details,'$.reason')=?").get(scope, reason).n);
  const sends = (email) => (proofRow(email) || { sends: 0 }).sends;

  test("three proofs a window per address, the fourth is not sent, and the next window starts again", async () => {
    const { api, csrf } = await freshCtx();
    const email = workAddress("cap");
    // Every ask here clears the origin share first, so the ADDRESS cap is what
    // refuses: on this server every request comes from the same origin.
    const ask = async () => {
      await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
      await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
      const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
      expect(r.status(), "200 for every outcome").toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      return lastCode(api, email);
    };
    const mark = lastRowid();
    const first = await ask();
    expect(first && first.via, "PRECONDITION: a proof was mailed").toBe("proof");
    const scope = proofScope(mark);
    expect(scope, "PRECONDITION: the request is on the record").toBeTruthy();
    expect(sends(email)).toBe(1);
    const second = await ask();
    expect(second.code, "a second proof was minted").not.toBe(first.code);
    expect(sends(email)).toBe(2);
    const third = await ask();
    expect(third.code, "and a third").not.toBe(second.code);
    expect(sends(email)).toBe(3);
    expect(refusals(scope, "send_cap_reached"), "nothing refused so far").toBe(0);

    const fourth = await ask();
    expect(sends(email), "the fourth in the window is not sent").toBe(3);
    expect(fourth, "nothing new was minted").toEqual(third);
    expect(refusals(scope, "send_cap_reached"), "the refusal is on the record with its reason").toBe(1);

    // THE CONTROL: the cap is per WINDOW. Once the proof has expired the next ask
    // opens a new window and is sent; a cap that never reset would refuse it too.
    sql(db => db.prepare("UPDATE email_proofs SET expires_at=? WHERE email_norm=?").run(new Date(Date.now() - 1_000).toISOString(), email.toLowerCase()));
    const fresh = await ask();
    expect(fresh.code, "a new window mails a new proof").not.toBe(third.code);
    expect(sends(email), "…as the first of its window").toBe(1);
    await api.dispose();
  });

  test("one origin may spend only two of an address's three proofs; the third is left for another", async () => {
    const { api, csrf } = await freshCtx();
    const email = workAddress("origin");
    // Start from a clean share (other tests in this file clear it as they go).
    await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
    const ask = async ({ otherOrigin = false } = {}) => {
      await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
      // A second origin cannot be made on this server (no trust proxy); clearing
      // the process-resident share is what a different origin would see.
      if (otherOrigin) await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
      const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
      expect(await r.json()).toEqual({ ok: true });
      return lastCode(api, email);
    };
    const mark = lastRowid();
    const first = await ask();
    expect(first && first.via, "PRECONDITION: a proof was mailed").toBe("proof");
    const scope = proofScope(mark);
    const second = await ask();
    expect(sends(email)).toBe(2);
    const third = await ask();
    expect(sends(email), "this origin's third ask is not sent").toBe(2);
    expect(third, "nothing new was minted").toEqual(second);
    expect(refusals(scope, "origin_cap_reached"), "refused for the ORIGIN's share").toBe(1);
    expect(refusals(scope, "send_cap_reached"), "…not the address's cap, which has a send left").toBe(0);

    // THE CONTROL that makes it a share, not a lowered cap: the third send is
    // still there for somebody else.
    const elsewhere = await ask({ otherOrigin: true });
    expect(elsewhere.code, "another origin is mailed the address's third proof").not.toBe(second.code);
    expect(sends(email)).toBe(3);
    await api.dispose();
  });
});
