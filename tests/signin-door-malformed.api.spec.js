// A FIELD THAT IS NOT TEXT IS ANSWERED BY THE DOOR, NEVER BY A 500 (sweep #193).
//
// The anonymous doors answer 200 for every outcome, so a caller learns nothing
// from their answers (and a venue NAT's typos never feed the scanner block). A
// crafted body broke that: JSON, and the form parser (`code[toString]=1`), can
// deliver an object whose own `toString` is not callable, which throws inside
// String(). The code redeem handed its raw `code` to the code normaliser, and
// POST /credential its raw `code` and `surname` to theirs, so each answered a
// server error instead of its uniform answer.
//
// Held here, door by door, with the limiters off (the test server's default; the
// limiter-on arm, where a non-text address meets the bucket key, is in
// tests/signin-door-limits.api.spec.js):
//   * the code request, the code redeem (for an account's address and for an
//     address only a proof was mailed to), "Not your event?", the sign-in-method
//     lookup and the password door each answer a non-text field exactly as they
//     answer an empty one, with 200;
//   * POST /credential answers a non-text code or surname as an unknown
//     certificate, in JSON and as the page;
//   * a non-text code is a typo, never a guess: the account's failure count and
//     the proof's attempt count stay where they were. The control: one
//     well-formed wrong code DOES count, so the "not charged" check can fail;
//   * the right codes still work afterwards.
// The pure halves (the bucket key, the printed-code normaliser) are held without
// a server at the end.
const { test, expect } = require("./isolated-test");
const { freshCtx, registerPost, serverLogTail, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const workAddress = (tag) => `${tag}-${Date.now()}-${++seq}@door-malformed.example`;
const FORM = { firstName: "Ada", lastName: "Malformed", company: "Analytical", title: "Engineer", country: "GB", timezone: "Europe/London" };
const wrongFor = (code) => (String(code).replace(/-/g, "") === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ");

// Every shape a JSON body can give a field that is not text. The first is the
// one that threw: String() calls the object's own `toString`, here a number.
const NOT_TEXT = [{ toString: 1 }, ["ABCD-EFGH"], 12345678, {}, true, null];

async function makeAccount(tag) {
  const email = workAddress(tag);
  const { api, csrf } = await freshCtx();
  const r = await registerPost(api, "/api/register", { headers: H(csrf), data: { ...FORM, email }, keepState: true });
  expect(r.status(), `sign-up ${tag}: ${await r.text()}`).toBe(200);
  await api.dispose();
  const row = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email));
  expect(row, `PRECONDITION: ${tag} exists`).toBeTruthy();
  return { email, id: row.id };
}
/** Mail `email` a code through the entry door; `via` is "email" for an account, "proof" for a newcomer. */
async function mailCode(email, via) {
  const { api, csrf } = await freshCtx();
  await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
  await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
  const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
  expect(await r.json()).toEqual({ ok: true });
  const c = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  const body = c.ok() ? await c.json() : null;
  expect(body && body.via, `PRECONDITION: ${email} was mailed a ${via} code`).toBe(via);
  await api.dispose();
  return body.code;
}
const failures = (id) => sql(db => db.prepare("SELECT failed_login_count n FROM users WHERE id=?").get(id).n);
const proofAttempts = (email) => sql(db => (db.prepare("SELECT attempts FROM email_proofs WHERE email_norm=?").get(email.toLowerCase()) || {}).attempts);

test.describe("sweep #193: a field that is not text gets each door's own answer", () => {
  test("the sign-in doors answer a non-text code or address as they answer an empty one, and charge nothing", async () => {
    const acct = await makeAccount("malformed-acct");
    const acctCode = await mailCode(acct.email, "email");
    const newcomer = workAddress("malformed-new");
    const proofCode = await mailCode(newcomer, "proof");
    const failuresBefore = failures(acct.id);
    expect(proofAttempts(newcomer), "PRECONDITION: the proof is live and unguessed").toBe(0);

    const { api, csrf } = await freshCtx();
    const post = async (p, data) => {
      const r = await api.post(p, { headers: H(csrf), data });
      return { status: r.status(), body: await r.text() };
    };
    // What each door says to an EMPTY field: the answer a non-text one must get.
    const emptyAnswer = {
      request: await post("/api/auth/code/request", { email: "" }),
      redeemCode: await post("/api/auth/code/redeem", { email: acct.email, code: "" }),
      redeemProof: await post("/api/auth/code/redeem", { email: newcomer, code: "" }),
      redeemEmail: await post("/api/auth/code/redeem", { email: "", code: "ZZZZZZZZ" }),
      drop: await post("/api/auth/code/drop-event", { email: "" }),
      method: await post("/api/auth/sign-in-method", { email: "" }),
      password: await post("/api/auth/password", { email: "", password: "" }),
    };
    for (const [k, v] of Object.entries(emptyAnswer)) expect(v.status, `PRECONDITION: the ${k} door answers an empty field with 200`).toBe(200);
    expect(JSON.parse(emptyAnswer.redeemCode.body)).toEqual({ ok: false });

    for (const bad of NOT_TEXT) {
      const label = JSON.stringify(bad);
      expect(await post("/api/auth/code/request", { email: bad }), `code request, email ${label}`).toEqual(emptyAnswer.request);
      expect(await post("/api/auth/code/redeem", { email: acct.email, code: bad }), `redeem an account's code ${label}`).toEqual(emptyAnswer.redeemCode);
      expect(await post("/api/auth/code/redeem", { email: newcomer, code: bad }), `redeem a proof ${label}`).toEqual(emptyAnswer.redeemProof);
      expect(await post("/api/auth/code/redeem", { email: bad, code: "ZZZZZZZZ" }), `redeem with email ${label}`).toEqual(emptyAnswer.redeemEmail);
      expect(await post("/api/auth/code/drop-event", { email: bad }), `not your event, email ${label}`).toEqual(emptyAnswer.drop);
      expect(await post("/api/auth/sign-in-method", { email: bad }), `sign-in method, email ${label}`).toEqual(emptyAnswer.method);
      expect(await post("/api/auth/password", { email: bad, password: bad }), `password door ${label}`).toEqual(emptyAnswer.password);
    }
    // A non-text code is a typo, never a guess: nothing was charged ...
    expect(failures(acct.id), "the account's failure count is untouched").toBe(failuresBefore);
    expect(proofAttempts(newcomer), "the proof's attempt count is untouched").toBe(0);
    // ... which can fail: one well-formed WRONG code is charged on each.
    expect(JSON.parse((await post("/api/auth/code/redeem", { email: acct.email, code: wrongFor(acctCode) })).body)).toEqual({ ok: false });
    expect(failures(acct.id), "CONTROL: a well-formed wrong code counts").toBe(failuresBefore + 1);
    expect(JSON.parse((await post("/api/auth/code/redeem", { email: newcomer, code: wrongFor(proofCode) })).body)).toEqual({ ok: false });
    expect(proofAttempts(newcomer), "CONTROL: a well-formed wrong proof code counts").toBe(1);
    await api.dispose();

    // The right codes still work.
    const a = await freshCtx();
    const okA = await a.api.post("/api/auth/code/redeem", { headers: H(a.csrf), data: { email: acct.email, code: acctCode } });
    expect((await okA.json()).ok, "the account's own code signs in").toBe(true);
    expect((await a.api.get("/api/me")).status()).toBe(200);
    await a.api.dispose();
    const n = await freshCtx();
    const okN = await n.api.post("/api/auth/code/redeem", { headers: H(n.csrf), data: { email: newcomer, code: proofCode } });
    expect(await okN.json(), "the newcomer's proof is redeemed").toEqual({ ok: true, needsProfile: true, email: newcomer.toLowerCase() });
    await n.api.dispose();
    expect(serverLogTail({ lines: 400, match: /"level":"error".*(auth\/code|auth\/password|sign-in-method|credential)/ }), "no request ended in a server error").toMatch(/no matching error line/);
  });

  test("POST /credential answers a non-text code or surname as an unknown certificate, in JSON and as the page", async () => {
    const { api } = await freshCtx();
    const json = { "content-type": "application/json", accept: "application/json" };
    const unknown = await api.post("/credential", { headers: json, data: { code: "", surname: "Lovelace" } });
    expect(unknown.status(), "PRECONDITION: an empty code is an unknown certificate").toBe(200);
    expect(await unknown.json()).toEqual({ found: false });
    for (const bad of NOT_TEXT) {
      const label = JSON.stringify(bad);
      const c = await api.post("/credential", { headers: json, data: { code: bad, surname: "Lovelace" } });
      expect(c.status(), `code ${label}`).toBe(200);
      expect(await c.json(), `code ${label}`).toEqual({ found: false });
      const s = await api.post("/credential", { headers: json, data: { code: "ABCD-EFGH-JKMN", surname: bad } });
      expect(s.status(), `surname ${label}`).toBe(200);
      expect(await s.json(), `surname ${label}`).toEqual({ found: false });
    }
    // The form the page posts: the extended parser turns `code[toString]=1` into
    // an object whose toString is the string "1".
    const form = await api.post("/credential", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "code[toString]=1&surname[toString]=1",
    });
    expect(form.status(), "the page answers the crafted form").toBe(200);
    expect(form.headers()["content-type"]).toMatch(/text\/html/);
    await api.dispose();
    expect(serverLogTail({ lines: 400, match: /"level":"error".*(auth\/code|auth\/password|sign-in-method|credential)/ }), "no request ended in a server error").toMatch(/no matching error line/);
  });

  test("the pure halves: a limiter's bucket key and the printed-code normaliser never throw", () => {
    // lib/util.js and lib/human-code.js open nothing at require time.
    const { rateBucketKey } = require("../lib/util");
    const { normaliseHumanCode } = require("../lib/human-code");
    const key = (fn) => rateBucketKey("p", "1.2.3.4", fn, {});
    expect(key((r) => "a@b.example")).toBe("p:1.2.3.4:a@b.example");
    // A session's user id narrows a bucket to that user, whatever its type.
    expect(key(() => 42)).toBe("p:1.2.3.4:42");
    expect(key(() => "")).toBe("p:1.2.3.4");
    expect(key(() => { throw new Error("x"); })).toBe("p:1.2.3.4");
    expect(rateBucketKey("p", "1.2.3.4", null, {})).toBe("p:1.2.3.4");
    // Anything else shares ONE fixed bucket per source, and never reaches a template literal.
    expect(key(() => ({ toString: 1 }))).toBe("p:1.2.3.4:~malformed");
    expect(key(() => ["a@b.example"])).toBe("p:1.2.3.4:~malformed");
    expect(key(() => NaN)).toBe("p:1.2.3.4:~malformed");
    for (const bad of NOT_TEXT) expect(normaliseHumanCode(bad), `printed code ${JSON.stringify(bad)}`).toBe("");
    // CONTROL: text is still folded as a printed code is typed.
    expect(normaliseHumanCode("abc-123")).toBe("ABC123");
    expect(normaliseHumanCode("o0Il")).toBe("0011");
  });
});
