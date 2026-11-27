// @ts-check
//
// A SIGN-IN CODE SIGNS IN ONCE, HOWEVER ITS REDEEMS INTERLEAVE.
//
// POST /api/auth/code/redeem spends a correct code with a CLAIM
// (lib/login-code.js `consumeCode`): the UPDATE clears the code only while the
// stored hash is still the one the redeem matched, and the redeem goes on only
// when it changed exactly one row. That claim comes before every other write the
// redeem makes. Single use then does not rest on the handler having no await
// between `resolveCodeAttempt` and the write, which nothing else holds (the
// address proof's DELETE is the same claim, lib/email-proof.js).
//
// Held here:
//   * by source: from the handler's start to its first `return _signInAs(` there
//     is no await (so no other request runs between match and claim), and the
//     claim is `consumeCode(` with its count compared, ahead of the lock clear
//     and the other writes; a planted copy with an await, and one spending the
//     code with a bare clearCode, are both flagged (the scanner's own controls);
//   * by behaviour: three browsers redeem one code at once; exactly one signs
//     in, the others are answered as a wrong code, and one sign-in is recorded.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { freshCtx, registerPost, TEST_DB_PATH } = require("./helpers");
const { stripJsComments } = require("./doc-registry");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
};

/** The redeem handler's text from its registration to its first sign-in, comments stripped. */
function redeemHead(src) {
  const body = stripJsComments(src);
  const start = body.indexOf('app.post("/api/auth/code/redeem"');
  if (start < 0) return null;
  const end = body.indexOf("return _signInAs(", start);
  if (end < 0) return null;
  return body.slice(start, end);
}
/** What is wrong with a redeem head, as a list of findings (empty: sound). */
function redeemFindings(head) {
  if (head === null) return ["the redeem handler or its sign-in was not found"];
  const out = [];
  if (/\bawait\b/.test(head)) out.push("an await between the code match and the sign-in");
  const claim = head.search(/\bconsumeCode\([^)]*\)\s*!==\s*1\b/);
  if (claim < 0) out.push("no `consumeCode(...) !== 1` claim");
  if (/\bclearCode\(/.test(head)) out.push("a bare clearCode spends the code");
  const lockClear = head.search(/\bclearLockout\(/);
  if (claim >= 0 && lockClear >= 0 && lockClear < claim) out.push("the lock is cleared before the claim");
  return out;
}

test.describe("a sign-in code signs in once", () => {
  test("the redeem claims the code with a compare-and-swap before its other writes, with no await before the sign-in", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "auth.js"), "utf8");
    const head = redeemHead(src);
    expect(head, "the redeem handler and its sign-in are found").not.toBeNull();
    expect(/\bresolveCodeAttempt\(/.test(/** @type {string} */ (head)), "ANTI-VACUITY: the head holds the match").toBe(true);
    expect(redeemFindings(head), "routes/auth.js POST /api/auth/code/redeem").toEqual([]);

    // The scanner's own controls: each defect it exists for is flagged when planted.
    const planted = (from, to) => {
      expect(src.includes(from), `CONTROL PRECONDITION: ${JSON.stringify(from)} is in routes/auth.js`).toBe(true);
      return redeemFindings(redeemHead(src.replace(from, to)));
    };
    expect(planted("const wasLocked = isLockedNow(user);", "const wasLocked = isLockedNow(user); await null;"),
      "an await planted after the match is flagged").toContain("an await between the code match and the sign-in");
    expect(planted("if (consumeCode(user.id, user.login_code_hash) !== 1) return fail(\"invalid\");", "clearCode(user.id);"),
      "a bare clearCode in place of the claim is flagged").toEqual(["no `consumeCode(...) !== 1` claim", "a bare clearCode spends the code"]);
  });

  test("three browsers redeeming one code at once: exactly one signs in", async () => {
    const email = `single-use-${Date.now()}@code-single.example`;
    {
      const { api, csrf } = await freshCtx();
      const r = await registerPost(api, "/api/register", { headers: H(csrf), data: {
        firstName: "Una", lastName: "Once", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London", email,
      }, keepState: true });
      expect(r.status(), `sign-up: ${await r.text()}`).toBe(200);
      await api.dispose();
    }
    const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)).id;
    const successes = () => sql(db => db.prepare("SELECT COUNT(*) n FROM user_events WHERE user_id=? AND event_type='login_success' AND json_extract(details,'$.method')='login_code'").get(id).n);
    expect(successes(), "PRECONDITION: no code sign-in yet (the sign-up signs in through the address proof)").toBe(0);

    let code;
    {
      const { api, csrf } = await freshCtx();
      await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
      const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
      expect(await r.json()).toEqual({ ok: true });
      const c = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
      code = (await c.json()).code;
      await api.dispose();
    }
    expect(code, "PRECONDITION: a code was mailed").toBeTruthy();

    const ctxs = await Promise.all([freshCtx(), freshCtx(), freshCtx()]);
    try {
      const bodies = await Promise.all(ctxs.map(async ({ api, csrf }) =>
        (await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } })).json()));
      expect(bodies.filter(b => b.ok === true).length, `exactly one redeem signs in: ${JSON.stringify(bodies)}`).toBe(1);
      expect(bodies.filter(b => b.ok !== true), "the others are answered as a wrong code").toEqual([{ ok: false }, { ok: false }]);
      const mes = await Promise.all(ctxs.map(async ({ api }) => (await api.get("/api/me")).status()));
      expect(mes.sort(), "one browser holds a session, the others none").toEqual([200, 401, 401]);
    } finally { await Promise.all(ctxs.map(c => c.api.dispose())); }
    expect(successes(), "one sign-in is recorded").toBe(1);
    expect(sql(db => db.prepare("SELECT login_code_hash FROM users WHERE id=?").get(id)).login_code_hash, "the code is spent").toBeNull();
  });
});
