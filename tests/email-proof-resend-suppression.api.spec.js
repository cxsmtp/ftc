// AN ADDRESS PROOF ASKED FOR AGAIN INSIDE TWO MINUTES IS NOT RE-SENT (sweep #352).
//
// An address no account holds is mailed an ADDRESS PROOF (lib/email-proof.js)
// when somebody presses Continue on it. A second ask while a proof mailed under
// LOGIN_CODE_RESEND_MIN_MS ago is live — a double-click, or somebody else typing
// the same address — is refused `recently_sent`: nothing is minted or mailed, so
// the code the newcomer is typing keeps working. The answer stays the uniform
// `{ok:true}` and the refusal is on the record (`email_proof_refused`, the
// address's domain and fingerprint, never the address).
//
// The proof's two other budgets — LOGIN_CODE_MAX_SENDS a window and the origin's
// share of it — are held by tests/signin-code-expiry.api.spec.js; this file holds
// the suppression those tests lift before every ask.
//
// The CONTROL makes the lock mean something: lifted (as two minutes passing
// would, POST /api/test/reset-recent-code-sends), the next ask re-issues, and the
// code that was being typed stops working — which is exactly what the
// suppression spares the newcomer.
const { test, expect } = require("./isolated-test");
const { freshCtx, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const workAddress = (tag) => `${tag}-${Date.now()}-${++seq}@proof-resend.example`;
const proofRow = (email) => sql(db => db.prepare("SELECT * FROM email_proofs WHERE email_norm=?").get(email.toLowerCase()));
const lastRowid = () => sql(db => db.prepare("SELECT COALESCE(MAX(rowid),0) m FROM orphan_events").get().m);
/** The fingerprint an address's proof records share (never the address), from its first request record. */
const proofScope = (afterRowid) => (sql(db => db.prepare(
  "SELECT scope_id FROM orphan_events WHERE event_type='email_proof_requested' AND rowid>? ORDER BY rowid DESC LIMIT 1").get(afterRowid)) || {}).scope_id;
const recorded = (scope, type, reason) => sql(db => db.prepare(
  `SELECT COUNT(*) n FROM orphan_events WHERE event_type=? AND scope_id=? ${reason ? "AND json_extract(details,'$.reason')=?" : ""}`)
  .get(...(reason ? [type, scope, reason] : [type, scope])).n);

test.describe("an address proof is not re-sent while the last one is fresh", () => {
  /** The one entry door, through one browser (a cookie jar and its CSRF token). */
  async function browser() {
    const { api, csrf } = await freshCtx();
    const ask = async (email) => {
      const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
      expect(r.status(), "200 for every outcome").toBe(200);
      expect(await r.json(), "…and the same answer").toEqual({ ok: true });
    };
    const lastCode = async (email) => {
      const r = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
      return r.ok() ? r.json() : null;
    };
    // A redeem that works regenerates the session, so it is the last thing a
    // browser here does.
    const redeem = async (email, code) => (await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } })).json();
    const lift = () => api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    return { api, csrf, ask, lastCode, redeem, lift };
  }

  test("a second ask inside two minutes mints and mails nothing, and the code being typed still works; lifted, a re-ask replaces it", async () => {
    const one = await browser();
    // A clean start for this origin's share of each address's sends.
    await one.api.post("/api/test/reset-origin-code-budget", { headers: H(one.csrf) });
    await one.lift();

    // THE SUPPRESSION.
    const a = workAddress("fresh");
    const mark = lastRowid();
    await one.ask(a);
    const first = await one.lastCode(a);
    expect(first && first.via, "PRECONDITION: a proof was mailed").toBe("proof");
    const scope = proofScope(mark);
    expect(scope, "PRECONDITION: the request is on the record").toBeTruthy();
    const row = proofRow(a);
    expect(row.sends, "PRECONDITION: one proof sent").toBe(1);

    await one.ask(a);
    expect(await one.lastCode(a), "no new code was minted").toEqual(first);
    expect(proofRow(a), "the proof is untouched: same code, same count, same send time").toEqual(row);
    await expect.poll(() => recorded(scope, "email_proof_refused", "recently_sent"), { message: "the refusal is on the record, with its reason" }).toBe(1);
    expect(recorded(scope, "email_proof_requested"), "and only the first ask was sent").toBe(1);
    expect(await one.redeem(a, first.code), "the code being typed still works").toMatchObject({ ok: true, needsProfile: true, email: a });
    await one.api.dispose();

    // CONTROL: with the suppression lifted, a re-ask re-issues, and the earlier
    // code is dead — what the suppression spared the first newcomer.
    const two = await browser();
    const b = workAddress("lifted");
    await two.ask(b);
    const before = await two.lastCode(b);
    expect(before && before.via, "PRECONDITION: a proof was mailed").toBe("proof");
    await two.lift();
    await two.ask(b);
    const after = await two.lastCode(b);
    expect(after.code, "a new proof replaced it").not.toBe(before.code);
    expect(proofRow(b).sends, "…counted as the address's second send").toBe(2);
    expect(await two.redeem(b, before.code), "the code that was being typed no longer works").toEqual({ ok: false });
    expect(await two.redeem(b, after.code), "the new one does").toMatchObject({ ok: true, needsProfile: true, email: b });
    await two.api.dispose();
  });
});
