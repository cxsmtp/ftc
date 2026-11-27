// THE SIGN-IN CARD AND "HOW YOU SIGN IN", in the browser (v9.0.0; the wire half
// is tests/login-method.api.spec.js).
//   * a participant's Continue goes straight to the code step: no password box;
//   * an account that signs in with a password gets the password box ON THE CARD,
//     Continue becomes "Sign in", and "Email me a code instead" is beside it —
//     both doors sign in; a wrong password says so and clears the box;
//   * an admin with no password is told so, signs in by code, and is then asked
//     to set one (or keep codes) in a dialog that cannot be dismissed otherwise;
//   * the built-in superadmin types its username on the same card and gets the
//     password box alone;
//   * the profile's "How you sign in" sets the method and the password, and the
//     next sign-in follows it.
// axe runs on each new surface, gated on the suite's impact threshold.
const { test, expect } = require("./isolated-test");
const bcrypt = require("bcrypt");
const { BASE, freshCtx, getSuperadminPass, TEST_DB_PATH } = require("./helpers");
const { expectSpaBooted, loginViaApi, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { openAccountMenu, pressAccountMenuItem } = require("./chrome-helpers");
const { makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const PW = "a long enough password";

function dbRun(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
}
function plantPassword(id, plain) {
  dbRun((db) => db.prepare("UPDATE users SET password_hash=?, password_set_at=? WHERE id=?")
    .run(bcrypt.hashSync(plain, 4), new Date().toISOString(), id));
}
async function builtin() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(csrf), data: { username: "superadmin", password: getSuperadminPass() } });
  expect(r.ok()).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}
async function adminAccount(bg, label, password) {
  const u = await makeParticipant(bg.api, bg.csrf, label);
  const r = await bg.api.post(`/api/admin/participants/${u.id}/role`, { headers: H(bg.csrf), data: { role: "admin" } });
  expect(r.ok()).toBeTruthy();
  if (password) plantPassword(u.id, password);
  return u;
}
async function axeClean(page, selector, what) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).include(selector).analyze();
  const bad = r.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact || ""));
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${what}: no moderate+ axe violations`).toEqual([]);
}
async function openCard(page, email) {
  await page.goto("/");
  await expectSpaBooted(page, "the sign-in card");
  await page.fill("#login-email", email);
  await page.click("#login-submit");
}
async function redeemInDialog(page, email) {
  await page.locator("#sc-code").waitFor({ state: "visible", timeout: 10_000 });
  const r = await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  expect(r.ok(), "a code was mailed").toBeTruthy();
  await page.fill("#sc-code", (await r.json()).code);
  await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
}

test.describe("the sign-in card", () => {
  test("a participant's Continue goes straight to the code step", async ({ page }) => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lmui-part");
      await openCard(page, p.email);
      await expect(page.locator("#sc-code")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#login-password-group"), "no password box for a code account").toBeHidden();
      await expect(page.locator("#login-code-instead")).toBeHidden();
    } finally { await bg.api.dispose(); }
  });

  test("a password account: the password step, a wrong password, then Sign in", async ({ page }) => {
    const bg = await builtin();
    try {
      const a = await adminAccount(bg, "lmui-pw", PW);
      await openCard(page, a.email);
      await expect(page.locator("#login-password")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#login-code-instead")).toBeVisible();
      await expect(page.locator("#login-submit")).toHaveText("Sign in");
      await expect(page.locator("#login-sub")).toHaveText(/Enter your password/);
      await expect(page.locator("#sc-code"), "no code was asked for").toHaveCount(0);
      await axeClean(page, "#login-page .auth-card", "the password step");
      await page.fill("#login-password", "not the password");
      await page.click("#login-submit");
      await expect(page.locator("#login-error")).toContainText("did not sign you in");
      await expect(page.locator("#login-password"), "the box is cleared for another try").toHaveValue("");
      await page.fill("#login-password", PW);
      await page.press("#login-password", "Enter");
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("#set-password-overlay"), "a password is set: nothing is asked").toHaveCount(0);
    } finally { await bg.api.dispose(); }
  });

  test("“Email me a code instead” signs a password account in by code", async ({ page }) => {
    const bg = await builtin();
    try {
      const a = await adminAccount(bg, "lmui-instead", PW);
      await openCard(page, a.email);
      await page.click("#login-code-instead");
      await redeemInDialog(page, a.email);
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15_000 });
    } finally { await bg.api.dispose(); }
  });

  test("an admin with no password is told so, signs in by code, then sets one", async ({ page, browser }) => {
    const bg = await builtin();
    try {
      const a = await adminAccount(bg, "lmui-noset", null);
      await openCard(page, a.email);
      await expect(page.locator("#login-password-note")).toContainText("no password yet");
      await expect(page.locator("#login-code-instead")).toBeFocused();
      await page.click("#login-code-instead");
      await redeemInDialog(page, a.email);
      const sp = page.locator("#set-password-overlay");
      await expect(sp).toBeVisible({ timeout: 10_000 });
      await axeClean(page, "#set-password-overlay", "the set-password dialog");
      // Not dismissable by Escape.
      await page.keyboard.press("Escape");
      await expect(sp).toBeVisible();
      await page.fill("#sp-new", PW);
      await page.fill("#sp-confirm", PW + "x");
      await sp.locator("[data-action='set-password-save']").click();
      await expect(page.locator("#sp-error")).toContainText("not the same");
      await page.fill("#sp-confirm", PW);
      await sp.locator("[data-action='set-password-save']").click();
      await expect(sp).toHaveCount(0);
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15_000 });
      // The next sign-in, in another browser, uses that password.
      const ctx = await browser.newContext({ baseURL: BASE });
      const p2 = await ctx.newPage();
      await openCard(p2, a.email);
      await expect(p2.locator("#login-password-note")).toBeHidden();
      await p2.fill("#login-password", PW);
      await p2.click("#login-submit");
      await expect(p2.locator("#admin-page")).toBeVisible({ timeout: 15_000 });
      await ctx.close();
    } finally { await bg.api.dispose(); }
  });

  test("“Keep using emailed codes” stores that choice", async ({ page }) => {
    const bg = await builtin();
    try {
      const a = await adminAccount(bg, "lmui-keep", null);
      await openCard(page, a.email);
      await page.click("#login-code-instead");
      await redeemInDialog(page, a.email);
      const sp = page.locator("#set-password-overlay");
      await expect(sp).toBeVisible({ timeout: 10_000 });
      await sp.locator("[data-action='set-password-codes']").click();
      await expect(sp).toHaveCount(0);
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15_000 });
      expect(dbRun((db) => db.prepare("SELECT login_method FROM users WHERE id=?").get(a.id)).login_method).toBe("code");
    } finally { await bg.api.dispose(); }
  });

  test("the built-in superadmin types its username on the card: the password box alone", async ({ page }) => {
    await openCard(page, "superadmin");
    await expect(page.locator("#login-password")).toBeVisible();
    await expect(page.locator("#login-code-instead"), "no code door for the built-in account").toBeHidden();
    await expect(page.locator("#login-password-note")).toBeHidden();
    await page.fill("#login-password", getSuperadminPass());
    await page.click("#login-submit");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Profile — how you sign in", () => {
  test("a participant chooses a password; the next sign-in asks for it", async ({ page, browser }) => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lmui-prof");
      await loginViaApi(page, p.email);
      await page.goto("/");
      await expectSpaBooted(page, "the signed-in app");
      await openAccountMenu(page);
      await pressAccountMenuItem(page, "open-profile-editor");
      const sum = page.locator("#signin-method-summary");
      await expect(sum).toContainText("code emailed to you");
      await expect(sum).toContainText("default for your role");
      await page.click("[data-action='open-sign-in-method']");
      const dlg = page.locator("#sign-in-method-overlay");
      await expect(dlg).toBeVisible();
      await expect(dlg.locator("#sim-pw")).toBeHidden();
      await axeClean(page, "#sign-in-method-overlay", "the How you sign in dialog");
      await dlg.locator("input[name='sim-method'][value='password']").check();
      await expect(dlg.locator("#sim-pw")).toBeVisible();
      await dlg.locator("[data-action='save-sign-in-method']").click();
      await expect(dlg.locator("#sim-error")).toContainText("Set a password");
      await page.fill("#sim-new", PW);
      await page.fill("#sim-confirm", PW);
      await dlg.locator("[data-action='save-sign-in-method']").click();
      await expect(dlg).toHaveCount(0);
      await expect(sum).toContainText("With your password");
      await expect(sum, "a choice, not the default any more").not.toContainText("default for your role");
      // Another browser: the card now asks this participant for the password.
      const ctx = await browser.newContext({ baseURL: BASE });
      const p2 = await ctx.newPage();
      await openCard(p2, p.email);
      await expect(p2.locator("#login-password")).toBeVisible({ timeout: 10_000 });
      await p2.fill("#login-password", PW);
      await p2.click("#login-submit");
      await expect(p2.locator("#login-page")).toBeHidden({ timeout: 15_000 });
      await expect(p2.locator("#main-nav .nav-btn").first()).toBeVisible({ timeout: 15_000 });
      await ctx.close();
    } finally { await bg.api.dispose(); }
  });
});
