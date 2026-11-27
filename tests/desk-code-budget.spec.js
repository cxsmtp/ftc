// @ts-check
//
// v8.8.9 — THE SEND CAP IS AN EMAIL BUDGET, SO ONLY THE EMAIL PATH SPENDS IT.
//
// `LOGIN_CODE_MAX_SENDS` bounds how much mail one account can be made to send.
// The at-desk REVEAL sends none — the code is returned in the admin's own
// response body — but it called the same `issueCode`, so it was refused by that
// budget with the sentence "this account has already been SENT the maximum
// number of codes", about a path that sends nothing.
//
// IT NEEDED NO ATTACKER. A passwordless walk-up registers (mint 1), presses
// "send another" twice, walks to the desk, and is refused — which is exactly the
// greylisted-first-contact scenario the reveal exists for. The recorded residual
// this file closes described something else entirely (an attacker burning the
// budget "from enough addresses"), and that framing was wrong twice over: the
// route's limiter permits 5 against a cap of 3, so ONE address burns it, and the
// limiter is bypassed outright for an allowlisted venue IP.
//
// It was also a v7.14.2 affordance that lies: `codeBlockedReason` has no
// send-cap term, so the row still answered `can_use_code`, the kebab still
// offered "Show sign-in code", and the desk-invite duplicate remedy still
// pointed AT the control the server then refused.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
const Database = require("better-sqlite3");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = (l) => `${l}-${Date.now().toString(36)}-${Math.floor(Math.random() * 9973)}`;

/** The account's live code state, read straight from the row. */
function codeState(userId) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT login_code_sends, login_code_via, login_code_at, login_code_hash, password_set_at FROM users WHERE id=?").get(userId);
  } finally { db.close(); }
}

/** Age the window's anchor so the next mint takes the FRESH branch. */
function ageWindow(userId, minutes) {
  const db = new Database(TEST_DB_PATH);
  try {
    db.prepare("UPDATE users SET login_code_at=? WHERE id=?")
      .run(new Date(Date.now() - minutes * 60_000).toISOString(), userId);
  } finally { db.close(); }
}

test.describe("v8.8.9 — a desk reveal does not spend the email budget", () => {
  /** @type {any} */ let sa, csrf;
  let walkUp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;

    // The desk shortcut makes exactly the account this is about: verified,
    // approved and PASSWORDLESS, so the emailed code is its only remote door and
    // the desk reveal its only in-room one.
    const email = `${uniq("desk")}@acme.com`;
    const r = await sa.post("/api/admin/participants/desk-invite", {
      headers: H(csrf), data: { email, firstName: "Walk", lastName: "Up" },
    });
    expect(r.ok(), `desk-invite: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    walkUp = { id: body.userId || body.id, email };
    expect(walkUp.id, "the shortcut returns the new account's id").toBeTruthy();
    // PRECONDITION, asserted: passwordless is what makes it code-eligible at all.
    expect(codeState(walkUp.id).password_set_at, "the walk-up holds no password").toBeNull();
  });

  test("the EMAIL budget still binds — three sends, then no more mail", async () => {
    // The control for everything below. Without it, "the desk reveal worked" is
    // equally satisfied by a build that deleted the cap.
    // The desk shortcut showed a desk code, and a LIVE desk code is never
    // replaced by an emailed request (lib/login-code.js `deskCodeLive`): let it
    // expire first, so these requests are emailed mints.
    ageWindow(walkUp.id, 60);
    const anon = await sa.get("/api/csrf-token");
    expect(anon.ok()).toBeTruthy();
    for (let i = 0; i < 4; i++) {
      const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
      // v8.8.25 — RE-POINTED, not weakened. The subject is unchanged: the EMAIL
      // budget binds at three, and the desk reveal is not charged against it.
      // What moved is the premise — within those three, one ORIGIN may now spend
      // only two, and every request in this file comes from the same one. Left
      // alone the loop would exhaust the SUB-budget after two, and the assertion
      // below would read 2 while claiming to be about the account's three.
      // Clearing it between asks is what keeps this test about the account cap.
      await sa.post("/api/test/reset-origin-code-budget", { headers: H(c) });
      // …and the two-minute re-send suppression, for the same reason.
      await sa.post("/api/test/reset-recent-code-sends", { headers: H(c) });
      const r = await sa.post("/api/auth/code/request", { headers: H(c), data: { email: walkUp.email } });
      // 200 for every outcome, including the refusal — the anti-enumeration
      // contract. The budget is observable only in the row.
      expect(r.status(), `request ${i + 1} answers 200 whatever happened`).toBe(200);
    }
    expect(codeState(walkUp.id).login_code_sends,
      "three sends spent, and the fourth bought nothing").toBe(3);
  });

  test("the DESK reveal succeeds with the email budget spent", async () => {
    // The defect. Pre-fix this answered 429 send_budget_spent.
    expect(codeState(walkUp.id).login_code_sends, "precondition: the budget is spent").toBe(3);

    const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const r = await sa.post(`/api/admin/participants/${walkUp.id}/login-code/reveal`, { headers: H(c) });
    expect(r.status(), `the desk reveal must not be refused: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body.code, "…and it hands the admin a real code").toBeTruthy();
    expect(body.expires_in_minutes, "…with the minutes actually left").toBeGreaterThan(0);
  });

  test("…and spends none of it: the counter does not move, the provenance does", async () => {
    const before = codeState(walkUp.id);
    expect(before.login_code_sends, "precondition").toBe(3);

    const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const r = await sa.post(`/api/admin/participants/${walkUp.id}/login-code/reveal`, { headers: H(c) });
    expect(r.status()).toBe(200);

    const after = codeState(walkUp.id);
    expect(after.login_code_sends, "a reveal sends no mail, so it charges none").toBe(3);
    expect(after.login_code_via, "…and the provenance says desk, so redeeming it cannot verify").toBe("desk");
    expect(after.login_code_hash, "…and it really did re-mint").not.toBe(before.login_code_hash);
  });

  test("a desk mint on an EXPIRED window opens it at zero, not one", async () => {
    // THE TRAP. The fresh branch is an ASSIGNMENT, so a fix that merely skipped
    // the increment would stamp a new anchor over a stale `sends=3` and then
    // refuse the walk-up's next EMAILED request having sent them nothing.
    ageWindow(walkUp.id, 60);
    const c = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const r = await sa.post(`/api/admin/participants/${walkUp.id}/login-code/reveal`, { headers: H(c) });
    expect(r.status(), `reveal on an expired window: ${await r.text()}`).toBe(200);

    const after = codeState(walkUp.id);
    expect(after.login_code_sends, "the new window owes the participant all three emails").toBe(0);

    // While that desk code is live, an emailed request never replaces it (the
    // walk-up presses Continue and types the code they were shown), at any point
    // in its life — and so it spends nothing either.
    const c2 = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    await sa.post("/api/test/reset-recent-code-sends", { headers: H(c2) });
    const req = await sa.post("/api/auth/code/request", { headers: H(c2), data: { email: walkUp.email } });
    expect(req.status()).toBe(200);
    const held = codeState(walkUp.id);
    expect(held.login_code_via, "the live desk code is kept").toBe("desk");
    expect(held.login_code_sends, "…and nothing was charged").toBe(0);
    // Control: once it has expired, the email path mints and charges again.
    ageWindow(walkUp.id, 60);
    const req2 = await sa.post("/api/auth/code/request", { headers: H(c2), data: { email: walkUp.email } });
    expect(req2.status()).toBe(200);
    const post = codeState(walkUp.id);
    expect(post.login_code_sends, "the email path still charges").toBe(1);
    expect(post.login_code_via, "…and the provenance flips back, so this one CAN verify").toBe("email");
  });
});
