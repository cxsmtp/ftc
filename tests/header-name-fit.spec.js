"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// v8.6.5 — THE PLATFORM NAME SHOWS, OR IT HIDES. IT NEVER WRAPS.
//
// The header's height is the tallest thing in it: empty, that is `#main-nav` at
// 52 px (77 px with padding). Once the nav (8 -> 362 px) and the countdown
// (0 -> 71 px) populate they squeeze the `h1` from 798 px to 278 px, leaving the
// name ~133 px — at which "Checkmarx Enablement Platform" wrapped to THREE lines
// (60 px), taller than the nav, so the header grew 8 px and pushed
// `#main-content` and everything in it down.
//
// MEASURED on the CLS gate's own 400 kbps / 500 ms link, challenge page:
//     before   0.0994   of which 0.0613 was that header growth
//     after    0.0385   header holds at 77 px
//
// Three arms, because three different things can break: the SHIFT is gone, the
// name is hidden only where it does not fit, and the two CSS declarations that
// only work as a pair are both present.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `hnf${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Own participant, own events — shared `alice` carries whatever earlier tests left. */
async function fixture(nComps, nTasks) {
  const label = uniq(), email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Hdr", lastName: "Fit", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
      jobFunction: "Software Developer / Engineer", city: "Testville" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }

  const { api, csrf } = await apiLogin("superadmin");
  try {
    const body = await (await api.get("/api/admin/participants?limit=5000")).json();
    const rows = Array.isArray(body) ? body : (body.users || body.participants || []);
    const u = rows.find((x) => x.email === email);
    expect(u, "the participant we just registered is findable").toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf), data: {} });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf), data: {} });
    const ids = [];
    for (let i = 0; i < nComps; i++) {
      const c = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `${label} Event ${i}`, event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
      expect(c.ok(), `create: ${await c.text()}`).toBeTruthy();
      ids.push((await c.json()).competition.id);
    }
    for (let i = 0; i < nTasks; i++) {
      const t = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `${label} T${i}`, description: "d", difficulty: "easy", answer_type: "text",
        correct_answer: `a${i}`, status: "published" } });
      await api.post(`/api/admin/tasks/${(await t.json()).id}/competitions`,
        { headers: H(csrf), data: { competitionIds: [ids[0]] } });
    }
    const as = await api.post("/api/admin/competitions/assign",
      { headers: H(csrf), data: { userIds: [u.id], competitionIds: ids } });
    expect(as.ok(), `assign: ${await as.text()}`).toBeTruthy();
    return { email, ids };
  } finally { await api.dispose(); }
}

async function land(page, email, compId) {
  const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
  const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { base: `${BASE}` });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  if (compId) {
    // A fresh token: the login REGENERATED the session, and the CSRF failure
    // handler destroys an authenticated one — which lands the test on the login
    // page measuring nothing.
    const { csrfToken: t2 } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const sc = await page.request.post(`${BASE}/api/select-competition`, {
      headers: { "x-csrf-token": t2, "content-type": "application/json" },
      data: { competitionId: compId } });
    expect(sc.ok(), `select: ${await sc.text()}`).toBeTruthy();
  }
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 60000 });
  await page.waitForTimeout(1200);
}

const headerH = (page) => page.evaluate(() =>
  Math.round(document.querySelector("header").getBoundingClientRect().height));
const nameState = (page) => page.evaluate(() => {
  const el = document.querySelector("header h1 .platform-name");
  const r = el.getBoundingClientRect();
  return { hidden: !!el.hidden, lines: Math.round(r.height / 20) || 0,
           h1: Math.round(document.querySelector("header h1").getBoundingClientRect().height) };
});

test.describe("v8.6.5 — the platform name shows or hides, never wraps", () => {
  test("the header does not grow on the challenge page, and the name is hidden there", async ({ page }) => {
    test.setTimeout(120_000);
    const f = await fixture(3, 12);
    await land(page, f.email, f.ids[0]);

    // The participant bar is its own row under the header row (lane chrome), so
    // the name now competes only with the countdown and the two buttons. What
    // must hold is unchanged: shown whole on ONE line, or hidden — never a stack
    // of wrapped lines that grows the header.
    const before = await headerH(page);
    const n = await nameState(page);
    expect(n.lines, "the name is never wrapped").toBeLessThanOrEqual(1);
    expect(n.h1, "and the h1 is the logo's height, not a stack of wrapped lines").toBeLessThanOrEqual(44);
    await page.evaluate(() => window.applyPlatformName("An Extremely Long Platform Name That Cannot Possibly Fit Beside The Logo, Not Even On The Widest Desktop Screen Anyone Owns"));
    await page.waitForTimeout(300);
    expect((await nameState(page)).hidden, "a name that cannot fit is hidden").toBe(true);
    expect(await headerH(page), "hiding the name moves no other header box").toBe(before);
  });

  test("CONTROL: on the picker there is room, so the name is SHOWN in full", async ({ page }) => {
    test.setTimeout(120_000);
    // Without this, "the name is hidden" is satisfied by a build that hides it
    // everywhere — which is a strictly worse product than the wrap it replaced.
    const f = await fixture(3, 0);
    await land(page, f.email, null);

    const n = await nameState(page);
    expect(n.hidden, "there is room on the picker, so the name stays").toBe(false);
    expect(n.lines, "and it is on ONE line — the wrap is what grew the header").toBe(1);
    // Shown means shown WHOLE: the point of hiding rather than ellipsising is
    // that a half-name is never on screen.
    const clipped = await page.evaluate(() => {
      const el = document.querySelector("header h1 .platform-name");
      return el.scrollWidth > el.clientWidth + 1;
    });
    expect(clipped, "…and not a clipped half of it").toBe(false);
  });

  test("a RENAME re-decides the fit, which no resize can report", async ({ page }) => {
    test.setTimeout(120_000);
    // `applyPlatformName` rewrites this span's text. That changes what has to
    // fit while changing NO box — the h1 is `flex:1` — so the ResizeObserver
    // cannot see it, and without the text observer the verdict goes stale: a
    // longer name stays SHOWN and is then clipped by `overflow:hidden`, the one
    // thing this rule promises never to do.
    const f = await fixture(3, 0);
    await land(page, f.email, null);
    expect((await nameState(page)).hidden, "precondition: shown on the picker").toBe(false);
    const before = await headerH(page);

    await page.evaluate(() => window.applyPlatformName(
      "An Extremely Long Platform Name That Cannot Possibly Fit Beside The Logo, Not Even On The Widest Desktop Screen Anyone Owns"));
    await page.waitForTimeout(300);
    const long = await nameState(page);
    expect(long.hidden, "a name that no longer fits is hidden, not clipped").toBe(true);
    expect(await headerH(page), "and the header still does not grow").toBe(before);

    await page.evaluate(() => window.applyPlatformName("Arena"));
    await page.waitForTimeout(300);
    // The reverse direction matters as much: a stale verdict would leave a
    // short name hidden for ever, which reads as the name having been deleted.
    expect((await nameState(page)).hidden, "a name that fits again comes back").toBe(false);
  });

  // v8.14.4 (external audit R4) — THE LOGO IS NEVER UNDER THE NAV. `min-width:0`
  // let the nav squeeze the h1 below the logo, which does not shrink, so the logo
  // ran on underneath it — MEASURED: an h1 16 px wide holding a 142 px logo at
  // 768 px, and on a participant's challenge page anywhere below ~1120 px. The
  // assertion is GEOMETRY, not markup: the visible logo's box meets no other
  // header item's box, at every width the audit named plus the ones measured.
  const logoClashes = (page) => page.evaluate(() => {
    const logo = [...document.querySelectorAll("header h1 img")].find(i => getComputedStyle(i).display !== "none");
    const a = logo.getBoundingClientRect();
    const h1 = document.querySelector("header h1").getBoundingClientRect();
    const hits = [...document.querySelector("header").children]
      .filter(e => e.tagName !== "H1" && getComputedStyle(e).display !== "none")
      .map(e => ({ id: e.id || e.tagName, b: e.getBoundingClientRect() }))
      .filter(({ b }) => b.width > 0 && b.height > 0 && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)
      .map(({ id }) => id);
    return { hits, h1Width: Math.round(h1.width), logoWidth: Math.round(a.width), logoHeight: Math.round(a.height) };
  });
  async function sweep(page, widths, height = 800) {
    const out = [];
    for (const w of widths) {
      await page.setViewportSize({ width: w, height });
      await expect.poll(async () => (await logoClashes(page)).hits, { message: `${w} px: the logo shares its box with no other header item` }).toEqual([]);
      out.push({ w, ...(await logoClashes(page)) });
    }
    return out;
  }

  test("R4: on a participant's challenge page the logo never sits under the nav, at any width", async ({ page }) => {
    test.setTimeout(120_000);
    const f = await fixture(1, 1);
    await land(page, f.email, f.ids[0]);
    expect(await page.locator("#main-nav #nav-challenges:not([aria-disabled=true])").isVisible(), "PRECONDITION: the full participant nav is populated").toBe(true);
    // From 500: at <=600 px the nav moves to the bottom of the screen, and the
    // logo ran under the countdown and the account box instead.
    for (const m of await sweep(page, [500, 540, 568, 600, 601, 700, 768, 800, 844, 900, 1024, 1100])) {
      expect(m.h1Width, `${m.w} px: the h1 is never narrower than the logo it holds`).toBeGreaterThanOrEqual(m.logoWidth);
      // The smaller logo the <=768 px rule always meant (it lost to the classed
      // 36 px rule until v8.14.4), and the full one above it.
      expect(m.logoHeight, `${m.w} px: the logo's height`).toBe(m.w <= 768 ? 26 : 36);
    }
  });

  test("R4: in the admin panel the logo never sits under the nav, at any width", async ({ page }) => {
    test.setTimeout(120_000);
    const { getSuperadminPass } = require("./helpers");
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const r = await page.request.post(`${BASE}/api/login`, {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() } });
    expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 60000 });
    await page.waitForSelector("#profile-menu-btn", { timeout: 60000 });
    await sweep(page, [601, 650, 700, 768, 800, 844]);
  });

  test("R4: under touch emulation too (a phone held landscape)", async ({ browser }) => {
    test.setTimeout(120_000);
    // Coarse pointers raise controls to 44 px, which widens the nav — the
    // audit reproduced the overlap here as well.
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    try {
      const page = await ctx.newPage();
      const f = await fixture(1, 1);
      await land(page, f.email, f.ids[0]);
      expect(await page.evaluate(() => matchMedia("(pointer:coarse)").matches), "PRECONDITION: the page sees a coarse pointer").toBe(true);
      await sweep(page, [568, 601, 768, 844], 390);
    } finally { await ctx.close(); }
  });

  test("R4: a phone held upright shows the 22 px logo, clear of everything beside it", async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const page = await ctx.newPage();
      const f = await fixture(1, 1);
      await land(page, f.email, f.ids[0]);
      expect(await page.evaluate(() => matchMedia("(max-width:480px) and (orientation:portrait)").matches), "PRECONDITION: the portrait-phone rules apply").toBe(true);
      await expect.poll(async () => (await logoClashes(page)).hits).toEqual([]);
      const m = await logoClashes(page);
      expect(m.logoHeight, "the portrait rule's logo, not the 26 px or 36 px one").toBe(22);
    } finally { await ctx.close(); }
  });

  test("the two CSS declarations that only work as a pair are both present", async () => {
    // `white-space:nowrap` WITHOUT `min-width:0` on the h1 is WORSE than the bug:
    // the h1 then refuses to shrink below the name's intrinsic 272 px and the
    // whole header flex-wraps to a second row — MEASURED at 125 px against the
    // 85 px it was trying to fix. A behavioural test cannot separate them (both
    // arms above pass on a build with neither, because then nothing is hidden
    // and the name simply wraps as before on a viewport with room), so the
    // pairing is pinned at source.
    const css = require("fs").readFileSync(
      require("path").join(__dirname, "..", "public", "styles.css"), "utf8");
    const h1Rule = /header h1\{[^}]*\}/.exec(css);
    expect(h1Rule, "the header h1 rule exists").toBeTruthy();
    expect(h1Rule[0], "the h1 must be allowed to shrink, or nowrap wraps the whole header")
      .toMatch(/min-width:\s*0/);
    const nameRule = /header h1 \.platform-name\{[^}]*\}/.exec(css);
    expect(nameRule, "the platform-name rule exists").toBeTruthy();
    expect(nameRule[0], "the name never wraps — that is what fixes the header's height")
      .toMatch(/white-space:\s*nowrap/);
    // v8.14.4 — and the FLOOR is a second pair. `min-width:min-content` alone
    // would make the floor logo PLUS name, and the header would wrap early —
    // the failure above. The name must contribute nothing to it (the
    // behavioural arms cannot separate the two halves at every width either).
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const contain = /@supports \(contain:inline-size\)\{([\s\S]*?)\}\s*\}/.exec(bare);
    expect(contain, "the name's containment is guarded by @supports (contain:inline-size)").toBeTruthy();
    expect(contain[1], "the name contributes nothing to the h1's min-content").toMatch(/header h1 \.platform-name\{[^}]*contain:\s*inline-size/);
    const floor = /@supports \(contain:inline-size\) and selector\(:has\(\*\)\)\{([\s\S]*?)\}\s*\}/.exec(bare);
    expect(floor, "the floor is guarded by containment AND :has()").toBeTruthy();
    expect(floor[1], "the h1 is floored at its min-content once the nav has content").toMatch(/header:has\(#main-nav:not\(:empty\)\) h1\{[^}]*min-width:\s*min-content/);
  });

  // A HIDDEN NAME KEEPS ITS BOX, so the floor is the same whichever way
  // `initPlatformNameFit` decides: a floor that grew when the name was shown
  // could wrap the header just to show the name, inside the ResizeObserver.
  test("R4: the floor is the same with the name shown or hidden", async ({ page }) => {
    test.setTimeout(120_000);
    const f = await fixture(1, 1);
    await land(page, f.email, f.ids[0]);
    const floors = await page.evaluate(() => {
      const h1 = document.querySelector("header h1"), el = h1.querySelector(".platform-name"), was = el.hidden;
      const floor = (hidden) => {
        el.hidden = hidden;
        h1.style.flex = "none"; h1.style.width = "min-content";
        const w = h1.getBoundingClientRect().width;
        h1.style.flex = ""; h1.style.width = "";
        return Math.round(w * 10) / 10;
      };
      const out = { shown: floor(false), hidden: floor(true) };
      el.hidden = was;
      return out;
    });
    expect(floors.shown, "PRECONDITION: a real floor was measured").toBeGreaterThan(80);
    expect(floors.hidden, "showing the name does not move the floor").toBe(floors.shown);
  });

  // The participant header is TWO rows by design: the header row and, under it,
  // the participant bar (Events / Challenges / Leaderboard) on every device. The
  // header row itself never wraps.
  const rowsOf = (page) => page.evaluate(() => {
    const centres = [...document.querySelector("header").children]
      .filter(e => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.position !== "fixed" && e.getBoundingClientRect().height > 0; })
      .map(e => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; })
      .sort((a, b) => a - b);
    let rows = centres.length ? 1 : 0;
    for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > 12) rows++;
    return rows;
  });

  test("R4: on the challenge page the header is one row plus the participant bar, at every width", async ({ page }) => {
    test.setTimeout(120_000);
    const f = await fixture(1, 1);
    await land(page, f.email, f.ids[0]);
    for (const w of [360, 390, 500, 601, 700, 768, 800, 844, 900, 1024, 1100, 1280, 1440]) {
      await page.setViewportSize({ width: w, height: 800 });
      await expect.poll(() => rowsOf(page), { message: `${w} px: the header row and the bar` }).toBe(2);
    }
  });

  test("R4: a signed-out page keeps its one-row header — the boxes beside the logo are empty there, so there is nothing to floor against", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#login-page")).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(() => !!document.querySelector("header h1"), null, { timeout: 30000 });
    expect(await page.evaluate(() => document.getElementById("main-nav").children.length), "PRECONDITION: the nav is empty when signed out").toBe(0);
    for (const w of [481, 540, 606, 700, 768, 1024]) {
      await page.setViewportSize({ width: w, height: 800 });
      await expect.poll(() => rowsOf(page), { message: `${w} px: the signed-out header stays one row` }).toBe(1);
    }
  });
});
