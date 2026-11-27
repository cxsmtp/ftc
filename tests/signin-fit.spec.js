// The sign-in card fits ONE viewport, with no page scroll, at every size the
// operator named and in every look (operator order, 29 Oct 2026). Geometry, not
// markup: the document's scroll height against the window's inner height.
const { test, expect } = require("./isolated-test");
const { BASE, freshCtx, getSuperadminPass, TEST_DB_PATH } = require("./helpers");
test.use({ baseURL: BASE });

const SIZES = [[1366, 768], [1440, 900], [1920, 1080], [1873, 960], [390, 844], [360, 740]];
const LOOKS = Object.keys(require("../scripts/theme/looks").looks);

test.describe("the sign-up card fits one viewport too (detected location)", () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    test(`sign-up at ${w}x${h}: no page scroll`, async ({ browser }) => {
      const { signUpViaUi } = require("./ui-admin-helpers");
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, timezoneId: "Europe/London" });
      const page = await ctx.newPage();
      await page.goto("/");
      await signUpViaUi(page, `fit-${w}-${Date.now()}@company.example`, {}, { submit: false });
      await expect(page.locator("#reg-location-pick"), "a detected location shows as one line").toBeHidden();
      const m = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: window.innerHeight }));
      expect(m.sh, JSON.stringify(m)).toBeLessThanOrEqual(m.ih);
      await ctx.close();
    });
  }
});

test.describe("the sign-in card fits one viewport", () => {
  for (const look of LOOKS) {
    test(`${look}: no page scroll at any listed size`, async ({ page }) => {
      await page.addInitScript((l) => {
        try { localStorage.setItem("hck-look", l); }
        catch (e) { console.warn("look not stored:", e && e.message); }
      }, look);
      const bad = [];
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto("/");
        await page.locator("#login-email").waitFor({ state: "visible" });
        await expect(page.locator("html")).toHaveAttribute("data-look", look);
        const m = await page.evaluate(() => ({
          sh: document.documentElement.scrollHeight, ih: window.innerHeight,
          sw: document.documentElement.scrollWidth, iw: window.innerWidth,
          card: (() => { const r = document.querySelector("#login-page .auth-card").getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })(),
        }));
        if (m.sh > m.ih || m.sw > m.iw) bad.push(`${w}x${h}: ${JSON.stringify(m)}`);
        // Control: the card itself is on screen, whole (a collapsed page also "fits").
        expect(m.card.bottom - m.card.top, `${w}x${h}: the card has a real height`).toBeGreaterThan(200);
        expect(m.card.bottom, `${w}x${h}: the card ends inside the viewport`).toBeLessThanOrEqual(m.ih);
      }
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }
});

// v9.0.0 — the PASSWORD STEP (an account that signs in with a password: the
// password box, Sign in and "Email me a code instead") is the tallest state the
// card has, and it must fit the same sizes in every look.
test.describe("the password step fits one viewport too", () => {
  let email = null;
  test.beforeAll(async () => {
    const { makeParticipant } = require("./event-admin-helpers");
    const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
    const { api, csrf } = await freshCtx();
    const r = await api.post("/api/login", { headers: H(csrf), data: { username: "superadmin", password: getSuperadminPass() } });
    expect(r.ok()).toBeTruthy();
    const c = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const u = await makeParticipant(api, c, "fit-pw");
    const rr = await api.post(`/api/admin/participants/${u.id}/role`, { headers: H(c), data: { role: "admin" } });
    expect(rr.ok()).toBeTruthy();
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE users SET password_hash=?, password_set_at=? WHERE id=?").run(require("bcrypt").hashSync("fit-password", 4), new Date().toISOString(), u.id); }
    finally { db.close(); }
    email = u.email;
    await api.dispose();
  });
  for (const look of LOOKS) {
    test(`${look}: the password step, no page scroll at any listed size`, async ({ page }) => {
      await page.addInitScript((l) => {
        try { localStorage.setItem("hck-look", l); }
        catch (e) { console.warn("look not stored:", e && e.message); }
      }, look);
      const bad = [];
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto("/");
        await page.locator("#login-email").waitFor({ state: "visible" });
        await page.fill("#login-email", email);
        await page.click("#login-submit");
        await expect(page.locator("#login-code-instead"), `${w}x${h}: PRECONDITION — the password step is open`).toBeVisible();
        const m = await page.evaluate(() => ({
          sh: document.documentElement.scrollHeight, ih: window.innerHeight,
          sw: document.documentElement.scrollWidth, iw: window.innerWidth,
          alt: document.getElementById("login-code-instead").getBoundingClientRect().bottom,
        }));
        if (m.sh > m.ih || m.sw > m.iw || m.alt > m.ih) bad.push(`${w}x${h}: ${JSON.stringify(m)}`);
      }
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }
});
