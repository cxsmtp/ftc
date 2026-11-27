"use strict";
// Lane-chrome review captures (never part of `npm test`: `_*.spec.js` runs only
// under CAPTURE_SCREENSHOTS=1). Writes PNGs to $SHOTS_DIR (default
// test-results/chrome-shots): header, account menu, participant bar and the
// Appearance page in Signature light and Ambient dark at 360, 390 and 1440 px,
// plus the organiser's phone section bar.
const path = require("path");
const fs = require("fs");
const { test, expect } = require("./isolated-test");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, codeLogin, registerPost, getSuperadminPass } = require("./helpers");

const OUT = process.env.SHOTS_DIR || path.join(__dirname, "..", "test-results", "chrome-shots");
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const LOOKS = [["signature", "light"], ["ambient", "dark"]];
const WIDTHS = [360, 390, 1440];

async function participant() {
  const label = `shot${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Avery", lastName: "Quinn", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  } finally { await reg.dispose(); }
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const rows = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants || [];
    const u = rows.find((x) => x.email === email);
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf), data: {} });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf), data: {} });
    const c = await api.post("/api/admin/competitions", { headers: H(csrf), data: { name: `${label} Night Shift CTF`, event_kind: "tournament", timezone: "UTC",
      start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
    const id = (await c.json()).competition.id;
    const c2 = await api.post("/api/admin/competitions", { headers: H(csrf), data: { name: `${label} Booth Day`, event_kind: "tournament", timezone: "UTC",
      start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [id, (await c2.json()).competition.id] } });
    return email;
  } finally { await api.dispose(); }
}

test("chrome captures", async ({ browser }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(OUT, { recursive: true });
  const email = await participant();
  for (const [look, theme] of LOOKS) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 800 ? 780 : 900 }, reducedMotion: "reduce", colorScheme: theme });
      await ctx.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) { /* none */ } }, [look, theme]);
      const page = await ctx.newPage();
      const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
      expect((await codeLogin(page.request, email, H(csrfToken), { base: BASE })).ok()).toBeTruthy();
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#main-nav .nav-btn", { timeout: 60000 });
      await page.waitForTimeout(800);
      const tag = `${look}-${theme}-${w}`;
      await page.screenshot({ path: path.join(OUT, `participant-${tag}.png`) });
      await page.locator("#profile-menu-btn").click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `menu-${tag}.png`) });
      await page.locator("#profile-menu-overlay [data-action='open-appearance']").click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `appearance-${tag}.png`) });
      await ctx.close();
    }
  }
  // The organiser: phone section bar, desktop shell, menu.
  for (const w of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 800 ? 780 : 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    expect((await page.request.post(`${BASE}/api/login`, { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } })).ok()).toBeTruthy();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 60000 });
    await page.waitForTimeout(800);
    const geo = await page.evaluate(() => {
      const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), getComputedStyle(e).position]; };
      const chain = []; let e = document.getElementById("admin-mobile-menu-btn");
      while (e && e !== document.body) { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); chain.push(`${e.id || e.tagName}:${Math.round(b.top)} pt=${cs.paddingTop} mt=${cs.marginTop}`); e = e.parentElement; }
      const prev = [...document.querySelectorAll("#main-content > *")].filter((x) => x.getClientRects().length).map((x) => `${x.id || x.className}:${Math.round(x.getBoundingClientRect().top)}-${Math.round(x.getBoundingClientRect().bottom)}`);
      const hb = document.documentElement.style.getPropertyValue("--header-bottom");
      const ht = getComputedStyle(document.getElementById("app-header")).top;
      return { header: r("app-header"), bar: r("admin-mobile-menu-btn"), chain, prev, hb, ht, barTopCss: getComputedStyle(document.getElementById("admin-mobile-menu-btn")).top };
    });
    console.log(`[chrome-shots] admin ${w}: ${JSON.stringify(geo)}`);
    await page.screenshot({ path: path.join(OUT, `admin-${w}.png`) });
    await page.locator("#profile-menu-btn").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `admin-menu-${w}.png`) });
    await ctx.close();
  }
});
