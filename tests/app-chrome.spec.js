"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// THE APP CHROME (lane chrome): the header's two controls, the account menu, the
// one participant bar, the organiser's phone section bar, the Appearance page,
// the org default look, the "?" help tips and the quiet anonymous boot.
//
// GEOMETRY, not markup, wherever a layout promise is made: the bar's box sits
// inside the sticky header, directly under its first row, at 1440, 700 and 390 px,
// and it does not move when the page scrolls. Every positive arm has a control.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, codeLogin, registerPost } = require("./helpers");
const { openAccountMenu } = require("./chrome-helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `chr${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Own participant enrolled in one live event with one challenge. */
async function fixture() {
  const label = uniq(), email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Chrome", lastName: "Lane", nickname: label, email, company: "Acme", title: "Eng",
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
    for (let i = 0; i < 2; i++) {
      const c = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `${label} Event ${i}`, event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
      expect(c.ok(), `create: ${await c.text()}`).toBeTruthy();
      ids.push((await c.json()).competition.id);
    }
    const t = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `${label} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } });
    await api.post(`/api/admin/tasks/${(await t.json()).id}/competitions`, { headers: H(csrf), data: { competitionIds: [ids[0]] } });
    const as = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: ids } });
    expect(as.ok(), `assign: ${await as.text()}`).toBeTruthy();
    expect((await as.json()).assigned, "both enrolments landed (two events: the picker, not the sole-event landing)").toBeGreaterThanOrEqual(2);
    return { email, ids };
  } finally { await api.dispose(); }
}

async function signIn(page, email) {
  const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
  const r = await codeLogin(page.request, email, H(csrfToken), { base: `${BASE}` });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 60000 });
}

const geometry = (page) => page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) }; };
  const header = document.getElementById("app-header"), nav = document.getElementById("main-nav"), h1 = header.querySelector("h1");
  return { header: r(header), nav: r(nav), h1: r(h1), navPos: getComputedStyle(nav).position, vw: innerWidth, vh: innerHeight,
    items: [...nav.querySelectorAll(".nav-btn")].map((b) => ({ id: b.id, visible: b.getClientRects().length > 0, disabled: b.getAttribute("aria-disabled") === "true" })) };
});

test.describe("lane chrome — the participant bar", () => {
  // 700 px is inside the 601-760 px band, which once had a bottom bar of its
  // own: the geometry at that width keeps it from coming back.
  for (const vp of [{ width: 1440, height: 900 }, { width: 700, height: 900 }, { width: 390, height: 844 }]) {
    test(`at ${vp.width}px the bar is one row under the header row, inside the sticky header, and never scrolls away`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(vp);
      const f = await fixture();
      await signIn(page, f.email);
      await expect(page.locator("#competitions-page")).toBeVisible({ timeout: 30000 });
      const g = await geometry(page);
      expect(g.items.map((i) => i.id), "always the same three items").toEqual(["nav-competitions", "nav-challenges", "nav-leaderboard"]);
      expect(g.items.every((i) => i.visible), "none of them hidden").toBe(true);
      expect(g.navPos, "the bar is in the header's flow, not fixed to the bottom of the screen").not.toBe("fixed");
      expect(g.nav.top, "the bar sits below the header row (under the logo)").toBeGreaterThanOrEqual(g.h1.bottom - 1);
      expect(Math.abs(g.nav.bottom - g.header.bottom), "and is the header's last row (the 1 px border aside)").toBeLessThanOrEqual(1);
      expect(g.nav.left <= 0 && g.nav.right >= g.vw - 1, "full width").toBe(true);
      expect(g.nav.bottom, "nowhere near the bottom of the screen").toBeLessThan(g.vh / 2);
      // Inactive until an event is entered: aria-disabled, the dashed edge and the note.
      expect(g.items.find((i) => i.id === "nav-challenges").disabled).toBe(true);
      expect(g.items.find((i) => i.id === "nav-leaderboard").disabled).toBe(true);
      expect(g.items.find((i) => i.id === "nav-competitions").disabled, "CONTROL: Events is never inactive").toBe(false);
      await expect(page.locator("#nav-lock-note")).toHaveText("Choose an event first");
      const locked = page.locator("#nav-challenges");
      await expect(locked, "a dashed edge marks it inactive").toHaveCSS("border-top-style", "dashed");
      await expect(locked, "never dimmed with opacity (once any entrance animation settles)").toHaveCSS("opacity", "1");
      // Pinned: scrolling the page does not move it.
      const top0 = g.nav.top;
      // The header sticks within #app, so the page CONTENT is what grows.
      await page.evaluate(() => { document.getElementById("main-content").style.minHeight = "3000px"; window.scrollTo(0, 900); });
      await expect.poll(() => page.evaluate(() => window.scrollY), { message: "PRECONDITION: the page really scrolled" }).toBeGreaterThan(100);
      expect((await geometry(page)).nav.top, "the bar stays where it was").toBe(top0);
      await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById("main-content").style.minHeight = ""; });
      // Entering an event activates the tabs (entering a live event asks first).
      await page.locator(`.comp-card[data-comp-id="${f.ids[0]}"] .card-open`).first().click();
      await page.locator("#modal-confirm-btn").click({ timeout: 10000 });
      await expect(page.locator("#nav-challenges"), "entering the event activates Challenges").not.toHaveAttribute("aria-disabled", "true", { timeout: 20000 });
      await expect(page.locator("#nav-leaderboard")).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("#nav-lock-note")).toBeHidden();
    });
  }

  // THE RESERVED ROW (html.app-shell-hint) DRAWS THE BAR'S OWN RULES. On a
  // signed-in reload boot fills the bar, then waits on select-competition before
  // showMain marks the header `.is-app`; for that wait the filled bar is what the
  // page shows. Drawn by the bar's own rules it keeps the 48 px row and the
  // content under it stays put when `.is-app` lands. (The retired tab bar's
  // rules drew it 51 px tall at <=600 px, a jump when the header took over.)
  for (const vp of [{ width: 390, height: 844 }, { width: 700, height: 900 }]) {
    test(`at ${vp.width}px a signed-in reload draws the bar in its final shape before the header takes over`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(vp);
      const f = await fixture();
      await signIn(page, f.email);
      // Enter an event, so the reload resumes it through select-competition.
      const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
      const sel = await page.request.post(`${BASE}/api/select-competition`, { headers: H(csrfToken), data: { competitionId: f.ids[0] } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      // One load inside the event, so this browser was last showing it (its bar
      // with no lock note: ha_shell=1), as it is after entering one in the app.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#nav-challenges"), "PRECONDITION: the reload resumed the event").not.toHaveAttribute("aria-disabled", "true", { timeout: 20000 });
      let release, held = 0;
      const gate = new Promise((r) => { release = r; });
      await page.route("**/api/select-competition", async (route) => { held++; await gate; await route.continue().catch(() => {}); });
      const snap = () => page.evaluate(() => {
        const nav = document.getElementById("main-nav");
        const nb = nav.getBoundingClientRect(), mb = document.getElementById("main-content").getBoundingClientRect();
        return { appHeader: document.getElementById("app-header").classList.contains("is-app"), hint: document.documentElement.classList.contains("app-shell-hint"),
          buttons: nav.querySelectorAll(".nav-btn").length, navHeight: Math.round(nb.height), contentTop: Math.round(mb.top),
          direction: [...nav.querySelectorAll(".nav-btn")].map((b) => getComputedStyle(b).flexDirection) };
      });
      try {
        await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
        await expect.poll(() => held, { message: "boot asked select-competition, and it is held" }).toBeGreaterThan(0);
        await expect(page.locator("#main-nav .nav-btn")).toHaveCount(3);
        const frame = await snap();
        expect(frame.hint, "PRECONDITION: the browser reserves the bar's row (the ha_shell cookie)").toBe(true);
        expect(frame.appHeader, "PRECONDITION: the header has not taken over yet").toBe(false);
        expect(frame.navHeight, "the filled bar keeps the reserved 48 px row").toBe(48);
        expect(frame.direction, "its tabs are drawn as the bar draws them: a row, not an icon over a word").toEqual(["row", "row", "row"]);
        release();
        await expect(page.locator("#app-header.is-app")).toBeAttached({ timeout: 20000 });
        await expect(page.locator("#nav-challenges"), "CONTROL: the resume finished (the tabs unlocked)").not.toHaveAttribute("aria-disabled", "true", { timeout: 20000 });
        const after = await snap();
        expect(after.navHeight, "the same row once the header has taken over").toBe(frame.navHeight);
        expect(after.contentTop, "so the page under the bar did not move").toBe(frame.contentTop);
      } finally { release(); await page.unrouteAll({ behavior: "ignoreErrors" }); }
    });
  }
});

// A SIGNED-IN RELOAD ON A PHONE MOVES NOTHING. The `ha_shell` cookie tells
// theme-boot.js what the browser was last showing, and the still signed-out
// header takes the signed-in header's geometry from the first frame: without it
// the signed-out header's own #user-info row (44 px at <=480 px portrait)
// dissolved when the header turned `.is-app`, moving the page up (0.0486 in the
// participant view at 390 px, 0.146 in the admin console), and on the events
// list the bar's lock note took a line of its own afterwards. The layout shifts
// are recorded from an init script; only those moving the header or the page
// under it (#main-content) are counted, as the page's own content is not the
// header's doing.
const SHIFT_RECORDER = () => {
  window.__shifts = [];
  document.addEventListener("DOMContentLoaded", () => {
    window.__firstHint = document.documentElement.className;
  });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      const header = document.getElementById("app-header"), main = document.getElementById("main-content");
      const nodes = (e.sources || []).map((x) => x.node).filter(Boolean);
      const mine = nodes.some((n) => n === main || (header && header.contains(n)));
      window.__shifts.push({ value: e.value, header: mine, nodes: nodes.map((n) => n.id || n.nodeName) });
    }
  }).observe({ type: "layout-shift", buffered: true });
};

/** An account of `role` ("participant" or "admin"), signed in on `page`. */
async function signedInAccount(page, role) {
  if (role === "participant") { const f = await fixture(); await signIn(page, f.email); return; }
  const label = uniq(), email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Chrome", lastName: "Admin", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
      jobFunction: "Software Developer / Engineer", city: "Testville" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const body = await (await api.get("/api/admin/participants?limit=5000")).json();
    const rows = Array.isArray(body) ? body : (body.users || body.participants || []);
    const u = rows.find((x) => x.email === email);
    expect(u, "the account we just registered is findable").toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf), data: {} });
    const pr = await api.post(`/api/admin/participants/${u.id}/role`, { headers: H(csrf), data: { role: "admin" } });
    expect(pr.ok(), `promote: ${pr.status()} ${await pr.text()}`).toBeTruthy();
  } finally { await api.dispose(); }
  const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
  const r = await codeLogin(page.request, email, H(csrfToken), { base: `${BASE}` });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 60000 });
}

test.describe("lane chrome — a signed-in reload on a phone", () => {
  for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    for (const role of ["participant", "admin"]) {
      test(`at ${vp.width}x${vp.height} the ${role === "admin" ? "admin console" : "participant view"} reloads with no header shift`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(vp);
        await signedInAccount(page, role);
        await expect(page.locator("#app-header.is-app")).toBeAttached({ timeout: 20000 });
        await page.addInitScript(SHIFT_RECORDER);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("html[data-booted='1']")).toBeAttached({ timeout: 30000 });
        await expect(page.locator("#app-header.is-app")).toBeAttached({ timeout: 20000 });
        if (role === "participant") await expect(page.locator("#nav-lock-note"), "PRECONDITION: the events list, its lock note shown").toBeVisible();
        else await expect(page.locator("#admin-mobile-menu-btn"), "PRECONDITION: the admin console").toBeVisible();
        // Let the observer deliver what the last frames recorded.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));
        const got = await page.evaluate(() => ({ first: window.__firstHint, shifts: window.__shifts }));
        expect(got.first, "PRECONDITION: the first frame had the signed-in header's hint").toContain("app-header-hint");
        const headerShift = got.shifts.filter((x) => x.header).reduce((a, x) => a + x.value, 0);
        expect(headerShift, `no shift moves the header or the page under it: ${JSON.stringify(got.shifts)}`).toBeLessThan(0.005);
      });
    }
  }

  test("signed out, the header keeps its own #user-info row on a phone (no hint, nothing reserved)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html[data-booted='1']")).toBeAttached({ timeout: 30000 });
    const g = await page.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), width: Math.round(b.width) }; };
      return { cls: document.documentElement.className, display: getComputedStyle(document.getElementById("user-info")).display,
        h1: r(document.querySelector("#app-header h1")), info: r(document.getElementById("user-info")) };
    });
    expect(g.cls, "no signed-in hint on a signed-out load").not.toMatch(/app-(header|shell|note)-hint/);
    expect(g.display, "the row is a box of its own").not.toBe("contents");
    expect(g.info.top, "under the logo's row").toBeGreaterThanOrEqual(g.h1.bottom);
    expect(g.info.height, "44 px tall, as the signed-out header draws it").toBe(44);
    expect(g.info.width, "across the header").toBeGreaterThan(300);
  });

  // A STALE COOKIE (a session that ended while the browser was away: idled out,
  // a restart, a kick) still paints the first frame with the signed-in header's
  // geometry, which hides "?" and the look picker; boot drops the hint, classes
  // and cookie, as soon as it learns nobody is signed in. The static login page
  // is already showing, so no showPage would. Each value the code writes, by the
  // session check's answer and, when that check fails, by the identity reads'.
  for (const [value, how] of [["1", "probe"], ["2", "probe"], ["3", "probe"], ["2", "no probe"]]) {
    test(`a stale ha_shell=${value} on a signed-out load (${how === "probe" ? "the session check says nobody" : "the session check fails"}) gives the signed-out header back: "?" and the look picker, no hint, no cookie`, async ({ page, context }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await context.addCookies([{ name: "ha_shell", value, url: BASE }]);
      // Whether the hint was ever on <html>: observed from before <html> exists.
      await page.addInitScript(() => {
        window.__hintSeen = false;
        const look = () => { if (document.documentElement && /app-header-hint/.test(document.documentElement.className)) window.__hintSeen = true; };
        new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
        look();
      });
      if (how === "no probe") await page.route("**/api/session/status", (r) => r.abort());
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html[data-booted='1']")).toBeAttached({ timeout: 30000 });
      expect(await page.evaluate(() => window.__hintSeen), "PRECONDITION: theme-boot.js read the cookie into the first frame's hint").toBe(true);
      await expect.poll(() => page.evaluate(() => document.documentElement.className), { timeout: 15000, message: "boot dropped every hint class" })
        .not.toMatch(/app-(header|shell|note)-hint/);
      await expect(page.locator("#help-icon-btn"), "the signed-out header's \"?\"").toBeVisible();
      await expect(page.locator("#look-picker-btn"), "and its look picker").toBeVisible();
      await expect(page.locator("#app-search-btn"), "no Search, which does nothing signed out").toBeHidden();
      expect((await context.cookies(BASE)).filter((c) => c.name === "ha_shell" && c.value), "the cookie is gone too").toEqual([]);
      await expect(page.locator("#login-page"), "CONTROL: still the sign-in screen, nobody signed in").toBeVisible();
    });
  }

  // A SIGNED-IN SESSION WHOSE IDENTITY READ FAILS FOR A MOMENT keeps the cookie:
  // its /api/me answers 503 once and its /api/admin/me 401 (it answers 401 to
  // every session that is not an admin's), so boot takes the not-signed-in
  // branch, but only /api/me's own 401 would say nobody is signed in.
  // Dropping it there made the next good reload shift the page again. The
  // stale-cookie arms above are its control: there boot has that evidence and
  // drops it.
  test("a signed-in participant whose /api/me answers 503 once keeps the ha_shell cookie (nothing says nobody is signed in)", async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture();
    await signIn(page, f.email);
    const shellCookie = async () => (await context.cookies(BASE)).filter((c) => c.name === "ha_shell" && c.value).map((c) => c.value);
    await expect.poll(shellCookie, { timeout: 15000, message: "PRECONDITION: the signed-in participant's browser holds the hint" }).not.toEqual([]);
    const before = await shellCookie();
    let failed = 0;
    await page.route((u) => u.pathname === "/api/me", async (r) => {
      if (failed++ === 0) return r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service unavailable" }) });
      return r.continue();
    });
    const adminMe = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/me");
    await page.reload({ waitUntil: "domcontentloaded" });
    const am = await adminMe;
    expect(failed, "PRECONDITION: boot's /api/me answered 503").toBe(1);
    expect(am.status(), "PRECONDITION: and the participant's /api/admin/me was refused, so boot took the not-signed-in branch").toBe(401);
    await expect(page.locator("html[data-booted='1']")).toBeAttached({ timeout: 30000 });
    // The branch runs as /api/admin/me's answer lands; give it the turn.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    expect(await shellCookie(), "the cookie is kept, with the value the signed-in view wrote").toEqual(before);
    const s = await (await page.request.get(`${BASE}/api/session/status`)).json();
    expect(s.active, "CONTROL: the session is still signed in").toBe(true);
  });
});

test.describe("lane chrome — the header and the account menu", () => {
  test("signed in, the header keeps only Search and the account button; the menu holds the rest, Sign out last, and Escape returns focus", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    await signIn(page, f.email);
    const header = page.locator("#app-header");
    await expect(header.locator("#app-search-btn")).toBeVisible();
    await expect(header.locator("#app-search-btn"), "named by its visible word").toHaveAccessibleName("Search");
    await expect(header.locator("#profile-menu-btn")).toBeVisible();
    for (const gone of ["#help-icon-btn", "#look-picker-btn", "#release-notes-btn", "[data-action='do-logout']", "[data-action='toggle-admin-view']", "#platform-version"]) {
      await expect(header.locator(gone), `${gone} is not loose in the signed-in header`).toBeHidden();
    }
    const menu = await openAccountMenu(page);
    await expect(menu.locator(".pm-name")).toHaveText(/Chrome Lane/);
    await expect(menu.locator(".pm-role")).toHaveText("Participant");
    await expect(menu.locator("[data-action='toggle-admin-view']"), "a participant has no view to switch to").toHaveCount(0);
    // Appearance is ONE row now; its controls are a level down, on the page.
    await expect(menu.locator("[data-action='appearance-look']"), "no look controls inside the menu").toHaveCount(0);
    await expect(menu.locator("[data-action='open-appearance']"), "one Appearance row").toHaveCount(1);
    await expect(menu.locator("[data-action='open-appearance']")).toHaveAccessibleName(/^Appearance\b/);
    await expect(menu.locator("[data-action='help-open']"), "Help stays reachable from the menu").toHaveCount(1);
    const actions = await menu.locator(".pm-item").evaluateAll((els) => els.map((e) => e.dataset.action));
    expect(actions[actions.length - 1], "Sign out is last").toBe("do-logout");
    expect(actions, "Profile is there for a user-backed account").toContain("open-profile-editor");
    // A sleek window: compact at 1440x900 (at most 70% of the viewport), and
    // under the button, inside the viewport.
    const b = await menu.locator(".pm-panel").boundingBox();
    expect(b.height, `the menu is compact (${Math.round(b.height)}px)`).toBeLessThanOrEqual(900 * 0.7);
    expect(b.x + b.width).toBeLessThanOrEqual(1440);
    const btn = await page.locator("#profile-menu-btn").boundingBox();
    expect(b.y, "it opens below the account button").toBeGreaterThanOrEqual(btn.y + btn.height);
    await page.keyboard.press("Escape");
    await expect(page.locator("#profile-menu-overlay")).toHaveCount(0);
    await expect(page.locator("#profile-menu-btn"), "focus returns to the opener").toBeFocused();
  });

  // A MENU, NOT A DIALOG (operator ruling, 14 Nov 2026): a press outside the
  // account menu closes it, a named exception to "a backdrop click never
  // closes". The dialog control below separates it from a page-wide
  // close-on-any-outside-press: an ordinary dialog keeps its backdrop inert.
  test("a press outside the account menu closes it; a press inside it does not, and a dialog's backdrop never closes the dialog", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    await signIn(page, f.email);
    const outside = async (sel) => {
      const b = await page.locator(sel).boundingBox();
      const pt = { x: 24, y: 870 };
      expect(pt.x < b.x || pt.x > b.x + b.width || pt.y < b.y || pt.y > b.y + b.height,
        `PRECONDITION: the press point lies outside ${sel} ${JSON.stringify(b)}`).toBe(true);
      return pt;
    };
    const menu = await openAccountMenu(page);
    // CONTROL: a press on the panel, away from every item, keeps it open.
    await menu.locator(".pm-name").click();
    await expect(menu, "a press inside the menu keeps it open").toBeVisible();
    const pm = await outside("#profile-menu-overlay .pm-panel");
    await page.mouse.click(pm.x, pm.y);
    await expect(page.locator("#profile-menu-overlay"), "a press outside the menu closes it").toHaveCount(0);

    // CONTROL: an ordinary dialog (the Appearance page) stays open when its
    // backdrop is pressed.
    const m2 = await openAccountMenu(page);
    await m2.locator("[data-action='open-appearance']").click();
    const ap = page.locator("#appearance-overlay");
    await expect(ap).toBeVisible();
    const ad = await outside("#appearance-overlay [role=dialog]");
    await page.mouse.click(ad.x, ad.y);
    await expect(ap, "a dialog's backdrop never closes it").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ap).toHaveCount(0);
  });

  test("after an in-app sign-in (no reload) the account menu names the person, not the generated nickname", async ({ page }) => {
    // The sign-in answer is what the SPA keeps as the current user until a
    // reload, so it must carry the names the menu and the greeting read.
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    const { expectSpaBooted, submitLogin } = require("./ui-admin-helpers");
    await page.goto(`${BASE}/`);
    await expectSpaBooted(page, "the login page");
    await page.fill("#login-email", f.email);
    const redeem = page.waitForResponse((r) => r.url().includes("/api/auth/code/redeem"));
    await submitLogin(page);
    const body = await (await redeem).json();
    expect(body, "the sign-in answer carries the names").toMatchObject({ ok: true, first_name: "Chrome", last_name: "Lane" });
    await page.waitForSelector("#main-nav .nav-btn", { timeout: 60000 });
    const menu = await openAccountMenu(page);
    await expect(menu.locator(".pm-name"), "the person's name, from the sign-in answer").toHaveText("Chrome Lane");
    await expect(menu.locator(".pm-name"), "never the generated handle").not.toContainText(body.nickname);
  });

  test("the menu's Help item opens the guide, and the Appearance row opens the page with focus returning to the account button", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    await signIn(page, f.email);
    const menu = await openAccountMenu(page);
    await menu.locator("[data-action='help-open']").click();
    await expect(page.locator("#profile-menu-overlay"), "the menu closes first").toHaveCount(0);
    await expect(page.locator("#help-drawer-body h1").first()).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#help-drawer-overlay")).toBeHidden();
    await expect(page.locator("#profile-menu-btn"), "the drawer returns focus to a live opener").toBeFocused();
    const m2 = await openAccountMenu(page);
    await m2.locator("[data-action='open-appearance']").click();
    const ap = page.locator("#appearance-overlay");
    await expect(ap).toBeVisible();
    await expect(ap.locator("[data-action='appearance-look']").first(), "the look controls are on the page").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ap).toHaveCount(0);
    await expect(page.locator("#profile-menu-btn"), "focus returns to the account button").toBeFocused();
  });

  test("on a phone the menu is a bottom sheet", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture();
    await signIn(page, f.email);
    await openAccountMenu(page);
    const b = await page.locator("#profile-menu-overlay .pm-panel").boundingBox();
    expect(Math.round(b.y + b.height), "anchored to the bottom edge").toBe(844);
    expect(Math.round(b.width), "full width").toBe(390);
  });

  test("an anonymous load asks /api/session/status and never the identity reads", async ({ page }) => {
    const seen = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) seen.push(u.pathname); });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('html[data-booted="1"]'), "the app booted (boot() sets html[data-booted] last)").toBeAttached({ timeout: 30000 });
    await expect(page.locator("#look-picker-btn"), "the signed-out header keeps its look picker").toBeVisible();
    await expect.poll(() => seen.includes("/api/session/status"), { message: "POSITIVE CONTROL: the probe ran" }).toBe(true);
    // The anonymous decision is taken as the status answer is parsed, so an
    // identity read, were one made, starts before the network can go quiet.
    await page.waitForLoadState("networkidle");
    expect(seen.filter((p) => p === "/api/me" || p === "/api/admin/me"), "no 401-bound identity read").toEqual([]);
  });
});

test.describe("lane chrome — Appearance, the org default look and help tips", () => {
  test("Ambient lights Ice when no colour is stored; a stored colour wins", async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem("hck-look", "ambient"); localStorage.removeItem("hck-ambient"); } catch (_) { /* no storage */ } });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-ambient"))).toBe("ice");
    await page.evaluate(() => window._applyLookPreference("signature"));
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-ambient")), "Signature lights no ambient colour").toBe(null);
    await page.evaluate(() => { window._applyAmbientPreference("rose"); window._applyLookPreference("ambient"); });
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-ambient")), "CONTROL: a stored pick is kept").toBe("rose");
  });

  test("the org default look applies to a browser with no look of its own, never over one", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const bad = await api.patch("/api/admin/settings", { headers: H(csrf), data: { default_look: "neon" } });
      expect(bad.status(), "an unknown look is refused").toBe(400);
      const ok = await api.patch("/api/admin/settings", { headers: H(csrf), data: { default_look: "signature" } });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      const pub = await (await page.request.get(`${BASE}/api/settings/appearance`)).json();
      expect(pub.default_look).toBe("signature");
      // A fresh browser: no look of its own → the org default, painted after boot.
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-look"))).toBe("signature");
      // CONTROL: a browser that picked a look keeps it.
      const ctx = await browser.newContext();
      try {
        const p2 = await ctx.newPage();
        await p2.addInitScript(() => { try { localStorage.setItem("hck-look", "ambient"); } catch (_) { /* no storage */ } });
        await p2.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
        await expect(p2.locator('html[data-booted="1"]'), "PRECONDITION: the app booted").toBeAttached({ timeout: 30000 });
        // The page's own read of the org default, awaited: after it the default
        // has been applied, so the look below is the app's answer.
        expect(await p2.evaluate(() => window.loadOrgDefaultLook()), "PRECONDITION: this browser read the org default").toBe("signature");
        expect(await p2.evaluate(() => document.documentElement.getAttribute("data-look")), "a per-browser choice overrides the org default").toBe("ambient");
      } finally { await ctx.close(); }
      // The change is audited.
      const ev = await (await api.get("/api/admin/settings/events")).json();
      const list = Array.isArray(ev) ? ev : (ev.events || []);
      expect(list.some((e) => e.setting_key === "default_look"), "a default_look settings event was recorded").toBe(true);
    } finally {
      // Restore the hard-coded default (no org look), in the test body.
      await api.patch("/api/admin/settings", { headers: H(csrf), data: { default_look: "" } });
      await api.dispose();
    }
  });

  test("the Appearance page opens from the menu, and its '?' tips open one at a time or all at once", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    await signIn(page, f.email);
    const menu = await openAccountMenu(page);
    await menu.locator("[data-action='open-appearance']").click();
    const ap = page.locator("#appearance-overlay");
    await expect(ap).toBeVisible();
    await expect(ap.locator(".lp-card"), "a live preview per look").toHaveCount(Object.keys(require("../scripts/theme/looks").looks).length);
    const tip = ap.locator(".help-tip-btn").first();
    await expect(tip, "the placeholders were wired into buttons").toHaveAttribute("aria-expanded", "false");
    const noteId = await tip.getAttribute("aria-controls");
    await expect(page.locator(`#${noteId}`)).toBeHidden();
    await tip.click();
    await expect(tip).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#${noteId}`)).toBeVisible();
    await ap.locator("#ap-tips-all").check();
    const states = await ap.locator(".help-tip-btn").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-expanded")));
    expect(states.length).toBeGreaterThan(2);
    expect(states.every((s) => s === "true"), "Show all tips opens every note").toBe(true);
    await ap.locator("#ap-tips-all").uncheck();
    await page.evaluate(() => { try { localStorage.removeItem("hck-tips-all"); } catch (_) { /* no storage */ } });
  });

  // Each look card's traits line is drawn as the look picker draws it (the
  // .lp-traits rule: smaller, muted). It carried a class with no rule, so it
  // rendered at the page's own size in the body ink.
  test("the Appearance page's look cards draw their traits line as the look picker does (control: the blurb above it)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    await signIn(page, f.email);
    const menu = await openAccountMenu(page);
    await menu.locator("[data-action='open-appearance']").click();
    const ap = page.locator("#appearance-overlay");
    await expect(ap.locator(".lp-card")).toHaveCount(Object.keys(require("../scripts/theme/looks").looks).length);
    const lines = await ap.locator(".lp-card").evaluateAll((cards) => cards.map((c) => {
      const t = c.querySelector(".lp-card-text p:last-child"), b = c.querySelector(".lp-blurb");
      const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
      const probe = document.createElement("span");
      probe.style.color = muted;
      document.body.appendChild(probe);
      const mutedRgb = getComputedStyle(probe).color;
      probe.remove();
      return { cls: t.className, text: t.textContent, size: getComputedStyle(t).fontSize, colour: getComputedStyle(t).color,
        blurbSize: getComputedStyle(b).fontSize, mutedRgb };
    }));
    for (const l of lines) {
      const why = JSON.stringify(l);
      expect(l.text, `PRECONDITION: the traits line: ${why}`).toMatch(/day and night/);
      expect(l.cls, why).toBe("lp-traits");
      expect(l.colour, `the traits line is in the muted ink: ${why}`).toBe(l.mutedRgb);
      expect(parseFloat(l.size), `and smaller than the blurb above it (control): ${why}`).toBeLessThan(parseFloat(l.blurbSize));
    }
  });
});

test.describe("lane chrome — one door per setting for the org default look", () => {
  test.use({ baseURL: BASE });   // the admin helpers address the server by path
  // ONE SETTING PER SAVE (routes/settings.js PATCH /api/admin/settings): each
  // branch writes only its own field, so a body naming two answered 200 and
  // silently dropped the rest. It is refused by name and nothing is saved.
  test("a settings save naming two settings is refused by name and saves neither; each alone saves (control)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const read = async () => { const s = await (await api.get("/api/admin/settings")).json(); return { name: s.platform_name, look: s.default_look || "", approval: !!s.require_account_approval }; };
      const before = await read();
      expect(before, "PRECONDITION: the defaults, so every attempted value below is a change").toEqual({ name: "Checkmarx Enablement Platform", look: "", approval: false });
      for (const data of [{ platform_name: "Two At Once", default_look: "signature" }, { platform_name: "Two At Once", require_account_approval: true },
        { require_account_approval: true, default_look: "signature" }]) {
        const r = await api.patch("/api/admin/settings", { headers: H(csrf), data });
        expect(r.status(), JSON.stringify(data)).toBe(400);
        const b = await r.json();
        expect(b.code, JSON.stringify(b)).toBe("settings_one_at_a_time");
        expect([...b.fields].sort(), "the refusal names both settings").toEqual(Object.keys(data).sort());
      }
      expect(await read(), "nothing was saved").toEqual(before);
      const one = await api.patch("/api/admin/settings", { headers: H(csrf), data: { default_look: "signature" } });
      expect(one.ok(), `CONTROL: one setting alone saves: ${await one.text()}`).toBe(true);
      expect((await read()).look).toBe("signature");
    } finally {
      await api.patch("/api/admin/settings", { headers: H(csrf), data: { default_look: "" } });
      await api.dispose();
    }
  });

  // TWO DOORS, ONE SETTING: the Appearance page's "Organisation default" and the
  // Settings card's Platform look both write the platform look. The page kept
  // the look it last saved, and the card was drawn once, so either could show a
  // look the other had replaced — and its next save put the old look back.
  test("the Appearance page and the Settings card each show the look the other saved, so neither puts an old one back", async ({ page }) => {
    test.setTimeout(120_000);
    const { api, csrf } = await apiLogin("superadmin");
    const { adminLogin, openSettingsSection } = require("./ui-admin-helpers");
    const { openAppearance } = require("./chrome-helpers");
    const serverLook = async () => (await (await api.get("/api/settings/appearance")).json()).platform_look.look;
    try {
      expect(await serverLook(), "PRECONDITION: no platform look").toBe("");
      await page.setViewportSize({ width: 1440, height: 900 });
      await adminLogin(page);
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
      await page.locator('.admin-nav-item[data-tab-id="admin-settings-tab"]').click();
      await openSettingsSection(page, "look");
      const card = page.locator("#platform-look-card");
      await expect(card.locator("#pl-look")).toHaveValue("");
      // The house default is named as it is: Ambient, following the device.
      await expect(card.locator('#pl-look option[value=""]')).toHaveText("Default (Ambient, following the device)");

      // 1. Saved from the Appearance page: the card, still on screen, follows.
      let ap = await openAppearance(page);
      await expect(ap.locator('#ap-org-look option[value=""]')).toHaveText("Default (Ambient, following the device)");
      await ap.locator("#ap-org-look").selectOption("signature");
      await ap.locator('[data-action="appearance-org-save"]').click();
      await expect.poll(serverLook).toBe("signature");
      await ap.locator('[data-action="overlay-close"]').click();
      await expect(ap).toHaveCount(0);
      await expect(card.locator("#pl-look"), "the Settings card shows the look just saved on the Appearance page").toHaveValue("signature");

      // 2. The card puts the house default back: the Appearance page shows it
      // (its list names the house look "Default"), and its Save keeps it.
      await card.locator("#pl-look").selectOption("");
      await card.locator("[data-action='platform-look-save']").click();
      await expect.poll(serverLook).toBe("");
      ap = await openAppearance(page);
      await expect(ap.locator("#ap-org-look"), "the Appearance page shows the look in force, not the one it saved last").toHaveValue("");
      const saved = page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH");
      await ap.locator('[data-action="appearance-org-save"]').click();
      expect((await saved).ok()).toBe(true);
      expect(await serverLook(), "saving again keeps the look in force").toBe("");
    } finally {
      await api.dispose();
      // Restored on a FRESH session: the browser's superadmin sign-in above
      // ended the one this test started with (one session per principal).
      const s = await apiLogin("superadmin");
      try { await s.api.put("/api/admin/platform-look", { headers: H(s.csrf), data: { look: "", mode: "", ambient: "", lock: false } }); }
      finally { await s.api.dispose(); }
    }
  });
});

test.describe("lane chrome — the organiser's phone section bar", () => {
  // 8.17.0 page re-check: on a phone each table row is a card and its select
  // box is pinned to the card's corner (absolute), but the cells after it are
  // positioned too and painted over it, so a tap on the box landed on a cell and
  // ticked nothing. The box is on top and a tap ticks it.
  test("at 390px a People card's select box is on top of its cells and a tap ticks it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const { getSuperadminPass } = require("./helpers");
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const r = await page.request.post(`${BASE}/api/login`, { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(r.ok()).toBeTruthy();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 60000 });
    await page.evaluate(() => window.adminTab(document.querySelector('.admin-nav-item[data-tab-id="admin-participants-tab"]'), "admin-participants-tab"));
    const box = page.locator("#admin-participants-body tr td.cb-cell input[type=checkbox]").first();
    await expect(box, "PRECONDITION: a card with a select box").toBeVisible({ timeout: 20000 });
    // Read once the box has a box of its own in the window. The People list is
    // loaded twice on the way in (the panel's landing and this tab), and once,
    // under a full suite's load, the probe right after the visibility check found
    // the header at the box's centre, as a box with no size (point 0,0) would; so
    // each probe says what it saw. Cells painted over the box still fail it.
    const hitAtCentre = () => box.evaluate((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return `the box has no size (its pane ${el.closest("#admin-participants-tab")?.style.display || "?"}, scrollY ${Math.round(scrollY)})`;
      const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return e === el || el.contains(e) ? "box" : `${e ? e.tagName + "." + e.className : "nothing"} at the box's centre (top ${Math.round(b.top)}, scrollY ${Math.round(scrollY)})`;
    });
    await expect.poll(hitAtCentre, { message: "the box is what is under its own centre", timeout: 10000 }).toBe("box");
    await expect(box).not.toBeChecked();
    const b = await box.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(box, "a tap at the box ticks it").toBeChecked();
  });

  test("at 390px the section bar is in flow under the header, full width, and the pane heading is below it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const { getSuperadminPass } = require("./helpers");
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const r = await page.request.post(`${BASE}/api/login`, { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(r.ok()).toBeTruthy();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 60000 });
    const g = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const bar = document.getElementById("admin-mobile-menu-btn"), header = document.getElementById("app-header");
      const heading = [...document.querySelectorAll("#admin-competitions-tab h2, #admin-competitions-tab h1")].find((h) => h.getClientRects().length);
      return { bar: r(bar).toJSON(), header: r(header).toJSON(), heading: heading ? r(heading).toJSON() : null, pos: getComputedStyle(bar).position, label: document.getElementById("admin-section-label").textContent };
    });
    expect(g.pos, "never fixed over the content").not.toBe("fixed");
    expect(Math.round(g.bar.top), "directly under the header").toBe(Math.round(g.header.bottom));
    expect(Math.round(g.bar.width), "full width").toBe(390);
    expect(g.label, "it names the section on screen").toBe("Events");
    expect(g.heading, "PRECONDITION: the Events heading rendered").toBeTruthy();
    expect(g.heading.top, "the heading is below the bar, not under it").toBeGreaterThanOrEqual(g.bar.bottom - 1);
    const hdrRows = await page.evaluate(() => new Set([...document.querySelectorAll("#app-header > *, #app-header #user-info > *")]
      .filter((e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== "contents")
      .map((e) => Math.round(e.getBoundingClientRect().top / 16))).size);
    expect(hdrRows, "the organiser's phone header is one row").toBe(1);
  });
});

// 8.17.0 page re-check: in the LIGHT theme an older `html[data-theme="light"]
// .filter-btn` rule outranked the redesign's `.filter-btn.active`, so the chosen
// filter chip was drawn like the others (only its weight changed), and hovering
// it painted dark text on the purple hover fill. The chosen chip is filled, and
// reads at rest and hovered; an unchosen chip beside it is the CONTROL.
test.describe("lane chrome — the challenge filter chips in the light theme", () => {
  test("the chosen chip is filled and readable at rest and hovered; an unchosen one is not filled", async ({ page }) => {
    test.setTimeout(120_000);
    const { textContrast } = require("./ui-admin-helpers");
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => { try { localStorage.setItem("hck-theme", "light"); localStorage.setItem("hck-look", "signature"); } catch (_) { /* none */ } });
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture();
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const r = await codeLogin(page.request, f.email, H(csrfToken), { base: `${BASE}` });
    expect(r.ok()).toBeTruthy();
    const c2 = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
    expect((await page.request.post(`${BASE}/api/select-competition`, { headers: H(c2), data: { competitionId: f.ids[0] } })).ok()).toBeTruthy();
    await page.goto(`${BASE}/`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const chosen = page.locator("#solve-filters .filter-btn.active");
    await expect(chosen).toHaveCount(1, { timeout: 30000 });
    const other = page.locator("#solve-filters .filter-btn:not(.active)").first();
    await page.mouse.move(5, 5);
    const bg = (l) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
    // Colour transitions run on these chips: read once they have settled.
    const settled = (l) => l.evaluate(async (e) => { await Promise.all(e.getAnimations().map((a) => a.finished.catch(() => {}))); });
    await settled(chosen);
    const [bgChosen, bgOther] = [await bg(chosen), await bg(other)];
    expect(bgChosen, "the chosen chip is filled, unlike its neighbour").not.toBe(bgOther);
    const rest = await textContrast(chosen);
    expect(rest.ratio, `at rest: ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(4.5);
    await chosen.hover();
    await expect.poll(() => bg(chosen)).not.toBe(bgChosen);
    await settled(chosen);
    const hov = await textContrast(chosen);
    expect(hov.ratio, `hovered: ${JSON.stringify(hov)}`).toBeGreaterThanOrEqual(4.5);
  });
});
