// v8.1.x — the CLIENT half of the sign-in-code door, and the three things it
// used to report untruthfully.
//
// The 200-always contract (see tests/login-code.spec.js) is about the HANDLER:
// every refusal it makes answers 200, because a non-429 4xx feeds the
// scanner-reputation counter that blocks a whole venue NAT for fifteen minutes.
// Nothing here weakens that — the locks below still require the client to branch
// on `d.ok` for every handler outcome. What they add is the case the client had
// no answer for at all: a response that NEVER REACHED the handler.
//
//   • the LIMITER's 429 in front of it (deliberately outside the contract — the
//     counter ignores 429s precisely so a throttled room cannot block itself);
//   • the CSRF middleware's 403 on a login tab left open past the anonymous
//     session's expiry.
//
// Both were being reported as handler verdicts: "a code is on its way" when
// nothing was minted, and "it may have expired — ask for a new one" to somebody
// holding a perfectly good code (asking supersedes it AND spends one of the
// account's three capped sends, so following that advice can leave them with
// nothing).
//
// Every test owns its fixtures. The two POSITIVE CONTROLS are what stop all of
// this being satisfied by a build that shows one message for every outcome.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const fs = require("fs");
const path = require("path");
const { freshCtx, apiLogin, BASE, TEST_DB_PATH } = require("./helpers");

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/**
 * A participant who can actually sign in with a code: approved (the redeem
 * ladder keeps that branch), verified (so requireParticipant does not eject them
 * on the very next request — they have no instant-join grace), and
 * `password_set_at` NULL, which is the discriminator the whole passwordless
 * design keys on. Registration always stamps a password, so that column is
 * cleared here the way a LinkedIn or desk-created account arrives.
 */
async function makeCodeParticipant() {
  const Database = require("better-sqlite3");
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `codeclient-${stamp}@company.co`;
  const { api, csrf } = await freshCtx();
  const reg = await registerPost(api, "/api/register", {
    headers: h(csrf),
    data: {
      firstName: "Code", lastName: "Client", nickname: `codeclient_${stamp}`,
      company: "C", title: "T", country: "US", timezone: "America/New_York",
      email, password: "chosen-at-signup-1",
    },
  });
  expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  await api.dispose();

  const db = new Database(TEST_DB_PATH);
  let id;
  try {
    db.prepare("UPDATE users SET verified=1, approved=1, password_set_at=NULL WHERE email=?").run(email);
    const row = db.prepare("SELECT id, approved, verified, password_set_at FROM users WHERE email=?").get(email);
    // Assert the PRECONDITION, or a fixture that stopped producing a
    // code-eligible account would surface as a redeem failure and read as a bug
    // in the code under test.
    expect(row, "the fixture participant exists").toBeTruthy();
    expect(row.approved, "redeem keeps the approved branch").toBe(1);
    expect(row.password_set_at, "password_set_at NULL IS the code-eligibility discriminator").toBeNull();
    id = row.id;
  } finally { db.close(); }
  return { email, id };
}

/** Reach the code STEP for real (the request endpoint answers 200 for everyone).
 *
 * v8.3.1 — this flow moved off the login card into its own dialog: the link now
 * opens it, the address is asked for there (seeded from the login form), and the
 * code field appears only after the send. Every guarantee below is unchanged;
 * only where the controls live has moved. */
async function openCodeBox(page, email) {
  await page.goto(BASE);
  await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
  // Email first: the card's one button opens the code step for the address.
  await page.locator("#login-email").fill(email);
  await page.locator("#login-submit").click();
  await expect(page.locator("#sc-code")).toBeVisible({ timeout: 10000 });
}

test.describe("v8.1.x — a throttled sign-in-code request is not a delivered one", () => {
  test("a 429 on REQUEST does not tell the user a code is on its way", async ({ page }) => {
    // Intercepted rather than driven through the real bucket: the assertion is
    // about what the CLIENT does with a 429, and hostage-to-bucket-state is how
    // a lock becomes flaky and then gets deleted.
    await page.goto(BASE);
    await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
    await page.route("**/api/auth/code/request", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }) }));

    await page.locator("#login-email").fill("someone@company.co");
    await page.locator("#login-submit").click();

    // The lie was TWO-part, so both halves are asserted.
    await expect(page.locator("#login-error"), "the throttle is named, with a remedy that works")
      .toContainText(/too many requests/i, { timeout: 10000 });
    await expect(page.locator("#sc-code"), "and the code step is NOT reached — nothing was minted or sent")
      .toHaveCount(0);
    await expect(page.locator("#signin-code-overlay"), "no code step opens for a refused request").toHaveCount(0);
    // Mutation caught: deleting the `if(!rq.ok)` block in requestLoginCode — the
    // box opens and the note promises a code that does not exist.
  });

  test("a 403 csrf_invalid on REQUEST is the form's own error, never a forced sign-out", async ({ page }) => {
    // FINDING #27. The interceptor's csrf_invalid clause fires with NO signed-in
    // check, so before the skipPaths fix this turned an anonymous login tab into
    // the full forced-signout machinery: polls stopped, an unattributed
    // POST /api/logout, a "Signed out — you were signed out" modal shown to
    // somebody who was never signed in, then a reload — while the form's own
    // await never resolved, because the interceptor hands back a promise that
    // never settles.
    await page.goto(BASE);
    await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 15000 });
    let logouts = 0;
    page.on("request", (r) => { if (r.url().includes("/api/logout")) logouts++; });
    await page.route("**/api/auth/code/request", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "csrf_invalid" }) }));

    await page.locator("#login-email").fill("someone@company.co");
    await page.locator("#login-submit").click();

    // The form answered — which it can only do if the interceptor let the
    // response through rather than swallowing it in a never-settling promise.
    await expect(page.locator("#login-error")).toContainText(/try again/i, { timeout: 10000 });
    await expect(page.locator("#login-page.active"), "still on the login page").toBeVisible();
    await expect(page.locator("#modal-overlay"), "no 'Signed out' modal for somebody who was never signed in")
      .toBeHidden();
    expect(logouts, "and no un-attributed POST /api/logout").toBe(0);
    // Mutation caught: removing '/api/auth/code/request' from skipPaths in
    // public/js/core/api.js.
  });
});

test.describe("v8.1.x — a throttled redeem is not a dead code", () => {
  test("a 429 on REDEEM does not claim the code expired, and does not send them back for a new one", async ({ page }) => {
    const { email } = await makeCodeParticipant();
    await openCodeBox(page, email);

    await page.route("**/api/auth/code/redeem", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }) }));
    await page.locator("#sc-code").fill("ABCD-EFGH");
    await page.locator("[data-action='signin-code-redeem']").click();

    const err = page.locator("#sc-error");
    await expect(err).toContainText(/too many attempts/i, { timeout: 10000 });
    // THE HALF THAT MATTERS. "Ask for a new one" tells the holder of a valid
    // code to supersede it (the one-credential rule cancels the old one on the
    // next mint) and spends one of three capped sends.
    await expect(err, "never a verdict on the code itself").not.toContainText(/expired|already been used/i);
    await expect(err, "and never advice that would destroy a working code").not.toContainText(/ask for a new one/i);
    await expect(page.locator("#login-page.active"), "nobody was signed in").toBeVisible();
    // Mutation caught: deleting the `if(!r.ok)` block in redeemLoginCode — a 429
    // body has no `ok` key, so it falls into `!d.ok` and renders the
    // expired/used copy.
  });

  test("a 403 csrf_invalid on REDEEM is the form's own error, never a forced sign-out", async ({ page }) => {
    const { email } = await makeCodeParticipant();
    await openCodeBox(page, email);
    let logouts = 0;
    page.on("request", (r) => { if (r.url().includes("/api/logout")) logouts++; });
    await page.route("**/api/auth/code/redeem", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "csrf_invalid" }) }));

    await page.locator("#sc-code").fill("ABCD-EFGH");
    await page.locator("[data-action='signin-code-redeem']").click();

    await expect(page.locator("#sc-error")).toContainText(/could not check that code/i, { timeout: 10000 });
    await expect(page.locator("#modal-overlay")).toBeHidden();
    expect(logouts, "no un-attributed POST /api/logout").toBe(0);
    // Mutation caught: removing '/api/auth/code/redeem' from skipPaths.
  });
});

// ── THE POSITIVE CONTROLS ────────────────────────────────────────────────────
//
// Without these, every assertion above is equally satisfied by a build that
// shows the same "too many / try again" message for EVERY outcome, or by one
// where the code door does not work at all.
test.describe("v8.1.x — the ordinary outcomes still behave, un-mocked", () => {
  test("POSITIVE CONTROL: a handler refusal (200 {ok:false}) still says expired/used", async ({ page }) => {
    const { email } = await makeCodeParticipant();
    await openCodeBox(page, email);

    let redeemStatus = null;
    page.on("response", (r) => { if (r.url().includes("/api/auth/code/redeem")) redeemStatus = r.status(); });
    await page.locator("#sc-code").fill("ZZZZ-ZZZZ");
    await page.locator("[data-action='signin-code-redeem']").click();

    await expect.poll(() => redeemStatus, { timeout: 10000, message: "the redeem response arrives" }).not.toBeNull();
    expect(redeemStatus, "the HANDLER still answers 200 — the 200-always contract is untouched").toBe(200);
    await expect(page.locator("#sc-error"), "and the client still branched on d.ok")
      .toContainText(/expired or already been used/i, { timeout: 10000 });
  });

  test("POSITIVE CONTROL: a REAL code still signs the holder in", async ({ page }) => {
    const { email, id } = await makeCodeParticipant();
    await openCodeBox(page, email);
    await expect(page.locator("#signin-code-overlay")).toContainText("If this address can sign in or sign up, a code is on its way.");

    // Read the live code off the admin desk-fallback rather than an inbox: it
    // re-issues, so it hands back the code that is actually live AFTER the
    // request above superseded whatever came before it.
    const { api, csrf } = await apiLogin("superadmin");
    const rev = await api.post(`/api/admin/participants/${id}/login-code/reveal`, { headers: h(csrf) });
    expect(rev.ok(), `reveal: ${rev.status()} ${await rev.text()}`).toBeTruthy();
    const revealed = await rev.json();
    expect(revealed.code, "the desk fallback hands over a code").toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await api.dispose();

    await page.locator("#sc-code").fill(revealed.code);
    await page.locator("[data-action='signin-code-redeem']").click();

    // The redeem regenerates the session and the client takes the documented
    // app-transition reload, so the observable is leaving the login screen.
    await expect(page.locator("#login-page.active"), "signed in — the door still works")
      .toBeHidden({ timeout: 20000 });
    await expect(page.locator("#login-error")).not.toContainText(/too many|try again|expired/i);
  });
});

test.describe("v8.1.x — the skipPaths list itself", () => {
  test("both sign-in-code paths are in the interceptor's skipPaths", () => {
    // A behavioural test cannot prove the LIST, and the list is the fix: the
    // two tests above intercept one status each, while any other 401/403 from
    // these endpoints would take the same forced-signout path.
    const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "core", "api.js"), "utf8");
    const m = src.match(/const\s+skipPaths\s*=\s*\[([\s\S]*?)\]/);
    expect(m, "the interceptor still has a skipPaths allow-list").toBeTruthy();
    const list = m[1];
    expect(list, "the request door is an ANONYMOUS door — it must never trigger a forced sign-out")
      .toContain("/api/auth/code/request");
    expect(list, "and so is the redeem door").toContain("/api/auth/code/redeem");
    // The neighbours that make the rule legible: /api/login has always been here
    // and handles the identical condition inline. If it ever leaves, the two
    // doors on one login card have diverged again.
    expect(list).toContain("/api/login");
  });
});
