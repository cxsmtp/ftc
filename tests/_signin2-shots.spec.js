// Review captures of the email-first sign-in (not a lock; `_` keeps it out of
// `npm test`). Run with CAPTURE_SCREENSHOTS=1 SHOT_DIR=<dir>.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
test.use({ baseURL: BASE });
const path = require("path");
const fs = require("fs");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "test-results", "signin2-shots");
const SIZES = [[1440, 900], [390, 844]];
const LOOKS = [["signature", "light"], ["signature", "dark"], ["ambient", "light"], ["ambient", "dark"]];

async function prime(page, look, theme) {
  await page.addInitScript(([l, t]) => {
    try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); }
    catch (e) { console.warn("look not stored:", e && e.message); }
  }, [look, theme]);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });

test.describe.configure({ mode: "serial" });
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("entry screen, code step and the pre-verified sign-up form in every look", async ({ browser }) => {
  test.setTimeout(240_000);
  for (const [look, theme] of LOOKS) {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, timezoneId: "Asia/Kolkata", locale: "en-IN" });
      const page = await ctx.newPage();
      await prime(page, look, theme);
      await page.goto("/");
      await page.locator("#login-email").waitFor({ state: "visible" });
      await shot(page, `entry__${look}-${theme}__${w}`);
      const email = `shot-${look}-${w}-${Date.now()}@shots.example`;
      await page.fill("#login-email", email);
      await page.click("#login-submit");
      await page.locator("#sc-code").waitFor({ state: "visible" });
      const r = await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
      const { code } = await r.json();
      await page.fill("#sc-code", code.slice(0, 5));
      await page.dispatchEvent("#sc-code", "input");
      await shot(page, `code__${look}-${theme}__${w}`);
      await page.fill("#sc-code", code);
      await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
      await page.locator("#register-page.active #reg-first").waitFor({ state: "visible" });
      await shot(page, `signup__${look}-${theme}__${w}`);
      await page.fill("#login-email", "personal@gmail.com").catch(() => null);
      await ctx.close();
    }
  }
});

test("free-mail hint, the break-glass password step, and a join-link arrival", async ({ browser }) => {
  test.setTimeout(120_000);
  const { api, csrf } = await apiLogin("superadmin");
  const cr = await api.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {
    name: "India AI-Day 2026, Mumbai", event_kind: "booth", timezone: "UTC",
    start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, self_enroll_enabled: true,
  } });
  expect(cr.ok()).toBeTruthy();
  const comp = (await cr.json()).competition;
  const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
  for (const [look, theme] of [["signature", "light"], ["ambient", "dark"]]) {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, timezoneId: "Asia/Kolkata", locale: "en-IN" });
      const page = await ctx.newPage();
      await prime(page, look, theme);
      await page.goto("/");
      await page.locator("#login-email").waitFor({ state: "visible" });
      await page.locator("#login-email").pressSequentially("jane@gmail.com");
      await page.locator("#login-email-hint").waitFor({ state: "visible" });
      await shot(page, `freemail__${look}-${theme}__${w}`);
      // The break-glass username is typed on the card: anything that is not an
      // address opens the password step, with no code button.
      await page.locator("#login-email").fill("superadmin");
      await page.click("#login-submit");
      await page.locator("#login-password").waitFor({ state: "visible" });
      await shot(page, `breakglass__${look}-${theme}__${w}`);
      await page.goto("/join/" + token);
      await page.locator("#join-banner").waitFor({ state: "visible" });
      await shot(page, `join__${look}-${theme}__${w}`);
      await ctx.close();
    }
  }
  await api.dispose();
});
