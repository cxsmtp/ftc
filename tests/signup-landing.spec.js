// @ts-check
//
// THE BROWSER HALF OF A REAL SIGN-UP, to where the new participant lands:
//   • an invitation link pre-fills the invited address; a personal (free-mail)
//     address it names gets no "use your work email" warning, because the
//     invitation rides the code request and the server lets it start an
//     account (a different personal address typed there still gets the warning);
//   • an invited sign-up shows the invitation on the form and lands IN the event;
//   • a walk-up who scans a join link signs up and lands IN that event.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
const { signUpViaUi, expectSpaBooted } = require("./ui-admin-helpers");
const { H, uniq, makeCompetition, makeTask, assignTask } = require("./event-admin-helpers");
const { sa: saLogin, liveBooth } = require("./late-entry-fixture");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};

/** A live event with a challenge, and an invitation to `email` for it. */
async function invitedTo(email, label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const comp = await makeCompetition(sa, csrf, label);
    const task = await makeTask(sa, csrf, label);
    await assignTask(sa, csrf, task.id, [comp.id]);
    const inv = await sa.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [email], competitionIds: [comp.id] } });
    expect(inv.ok(), `invite: ${inv.status()} ${await inv.text()}`).toBeTruthy();
    const row = dbGet("SELECT id FROM invitations WHERE email=?", email);
    expect(row && row.id, "PRECONDITION: the invitation exists").toBeTruthy();
    return { comp, invitationId: row.id };
  } finally { await sa.dispose(); }
}

/** In the event: its tabs are active and the tab names it as the one shown. */
async function expectInEvent(page, compId) {
  await expect(page.locator('#nav-challenges:not([aria-disabled="true"])'), "the event's Challenges tab is active").toBeVisible({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { message: "the tab shows the event" }).toBe(compId);
}

test("an invitation to a personal address pre-fills it with no work-email warning, and its code is sent", async ({ page }) => {
  const email = `inv-${uniq("fm").toLowerCase()}@gmail.com`;
  const { invitationId } = await invitedTo(email, "invfm");
  await page.goto(`/?invitation=${encodeURIComponent(invitationId)}`);
  await expectSpaBooted(page, "the invitation landing");
  const box = page.locator("#login-email");
  await expect(box).toHaveValue(email, { timeout: 15000 });
  const hint = page.locator("#login-email-hint");
  await expect(hint, "no warning for the address the invitation names").toBeHidden();
  // CONTROL: another personal address typed here still gets the warning, and
  // the warning says what an invited person does instead (the server takes a
  // personal address only with the invitation riding the request).
  await box.fill(`someone-else-${Date.now()}@gmail.com`);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("if you were invited, open the link in your invitation email");
  await box.fill(email);
  await expect(hint).toBeHidden();
  // And the server agrees: Continue sends this address a sign-up code.
  await page.click("#login-submit");
  await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
  await expect.poll(async () => {
    const r = await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
    return r.ok() ? (await r.json()).code || null : null;
  }, { message: "a code was mailed to the invited personal address" }).not.toBeNull();
});

test("an invited sign-up shows the invitation on the form and lands in the event", async ({ page }) => {
  const email = `inv-${uniq("wk").toLowerCase()}@company.example`;
  const { comp, invitationId } = await invitedTo(email, "invwork");
  await page.goto(`/?invitation=${encodeURIComponent(invitationId)}`);
  await expectSpaBooted(page, "the invitation landing");
  await expect(page.locator("#login-email")).toHaveValue(email, { timeout: 15000 });
  await expect(page.locator("#join-banner-info"), "the entry card names the invited event").toHaveText(comp.name);
  const resp = signUpViaUi(page, email, { firstName: "Invited", lastName: "Person" });
  await expect(page.locator("#register-page h2")).toHaveText("You've been invited — create your account", { timeout: 15000 });
  await expect(page.locator("#reg-invitation-info")).toHaveText(`Event(s): ${comp.name}`);
  const r = await resp;
  expect(r.status(), `registration succeeded: ${await r.text()}`).toBe(200);
  await expectInEvent(page, comp.id);
  const u = dbGet("SELECT id, approved FROM users WHERE email=?", email);
  expect(u.approved, "invited people are approved").toBe(1);
  expect(dbGet("SELECT COUNT(*) AS n FROM competition_users WHERE user_id=? AND competition_id=?", u.id, comp.id).n).toBe(1);
});

test("a walk-up who signs up through a join link lands in that event", async ({ page }) => {
  const { api, csrf } = await saLogin();
  let comp, token;
  try {
    ({ comp } = await liveBooth(api, csrf));
    const r = await api.get(`/api/admin/competitions/${comp.id}/self-enroll`);
    expect(r.ok(), await r.text()).toBeTruthy();
    token = (await r.json()).token;
  } finally { await api.dispose(); }
  await page.goto(`/join/${encodeURIComponent(token)}`);
  await page.waitForSelector("#login-page.active", { timeout: 15000 });
  await expect(page.locator("#join-banner-info")).toHaveText(comp.name, { timeout: 15000 });
  const email = `walk-${uniq("up").toLowerCase()}@company.example`;
  const r = await signUpViaUi(page, email, { firstName: "Walk", lastName: "In" });
  expect(r.status(), `registration succeeded: ${await r.text()}`).toBe(200);
  await expectInEvent(page, comp.id);
  const u = dbGet("SELECT id FROM users WHERE email=?", email);
  expect(dbGet("SELECT COUNT(*) AS n FROM competition_users WHERE user_id=? AND competition_id=?", u.id, comp.id).n, "enrolled").toBe(1);
});

// THE WAY BACK WHEN THE GRANT IS GONE. The address proof lives in this browser's
// session for 15 minutes; a form submitted without it (expired, or the session
// lost) is refused `email_proof_required`, and the form offers "Back to the
// email step", which must lead to a working entry card: a fresh code, the form
// again, and an account.
test("a sign-up form whose address proof is gone offers the way back, and the way back signs the person up", async ({ page }) => {
  const email = `lost-${uniq("gr").toLowerCase()}@company.example`;
  await page.goto("/");
  await expectSpaBooted(page, "the entry card");
  await signUpViaUi(page, email, { firstName: "Lost", lastName: "Grant" }, { submit: false });
  // The session holding the grant is gone (as after its 15 minutes).
  await page.context().clearCookies();
  await page.click("#register-page [data-action='do-register']");
  const err = page.locator("#reg-error");
  await expect(err).toBeVisible({ timeout: 15000 });
  await expect(err, "the refusal is the missing proof, not a token or network error").not.toContainText(/network|timed out|csrf/i);
  const back = err.locator('[data-action="register-cancel"]');
  await expect(back).toHaveText("Back to the email step");
  expect(dbGet("SELECT COUNT(*) AS n FROM users WHERE email=?", email).n, "no account was made").toBe(0);

  await back.click();
  await expect(page.locator("#login-page")).toHaveClass(/\bactive\b/);
  await expect(page.locator("#login-email")).toBeFocused();
  // The way back works: a new code, the form, the account.
  expect((await page.request.post("/api/test/reset-recent-code-sends")).ok(), "the re-send suppression is cleared for the second code").toBe(true);
  const r = await signUpViaUi(page, email, { firstName: "Lost", lastName: "Grant" });
  expect(r.status(), `registration succeeded: ${await r.text()}`).toBe(200);
  await expect(page.locator("#main-nav .nav-btn").first(), "signed in, in the app").toBeVisible({ timeout: 20000 });
  expect(dbGet("SELECT COUNT(*) AS n FROM users WHERE email=?", email).n).toBe(1);
});
