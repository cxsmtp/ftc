// @ts-check
//
// THE PLATFORM LOOK AND THE EVENT LOOK (lib/platform-look.js, routes/settings.js
// PUT /api/admin/platform-look, routes/event-look.js, public/theme-boot.js,
// ui/theme.js).
//
// The bug these lock: a per-browser "hck-look" always won over the organisation
// default, and the default reached a browser only from its SECOND load (it was
// cached from an API answer after boot). Now the default rides the SPA shell,
// so the FIRST paint has it — proven here with the app's module graph blocked,
// so only theme-boot.js can have painted. "Apply to everyone now" stamps a
// version that overrides older personal choices; the lock keeps participants on
// it; an event's look paints its join landing and, locked, overrides a choice.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, appearanceSettled } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const DEFAULT = { look: "", mode: "", ambient: "", lock: false };
/** Put the platform look back to the hard-coded default on a FRESH session: a
 *  browser superadmin sign-in (adminLogin) ends every earlier superadmin
 *  session, so a restore through one made before it fails silently. */
async function restoreDefaultLook() {
  const s = await apiLogin("superadmin");
  try { await s.api.put("/api/admin/platform-look", { headers: H(s.csrf), data: DEFAULT }); } finally { await s.api.dispose(); }
}

/** A fresh browser whose app module never loads: only theme-boot.js paints. */
async function firstPaint(browser, init, ctxOpts) {
  const ctx = await browser.newContext({ baseURL: BASE, ...(ctxOpts || {}) });
  const page = await ctx.newPage();
  if (init) await page.addInitScript(init.fn, init.arg);
  let blocked = 0;
  await page.route(/\/js\/core\/main\.js/, (r) => { blocked++; return r.abort(); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const out = await page.evaluate(() => ({
    look: document.documentElement.getAttribute("data-look"),
    theme: document.documentElement.getAttribute("data-theme"),
    ambient: document.documentElement.getAttribute("data-ambient"),
    attr: document.documentElement.getAttribute("data-platform-look"),
    own: (() => { try { return localStorage.getItem("hck-look"); } catch (_) { return "n/a"; } })(),
  }));
  expect(blocked, "PRECONDITION: the app module was blocked, so the paint is theme-boot's alone").toBeGreaterThan(0);
  await ctx.close();
  return out;
}
const withOwn = (look, extra) => ({
  fn: ([l, x]) => {
    try {
      if (!sessionStorage.getItem("primed")) {
        localStorage.setItem("hck-look", l);
        for (const [k, v] of Object.entries(x || {})) localStorage.setItem(k, v);
        sessionStorage.setItem("primed", "1");
      }
    } catch (_) { /* no storage */ }
  },
  arg: [look, extra],
});

test.describe("the platform look", () => {
  test("the server refuses what it cannot honour, and audits what it stores", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // The four retired looks (operator ruling, 13 Nov 2026) are unknown ids now.
      for (const [body, code] of [[{ look: "neon" }, "platform_look_unknown"], [{ mode: "dim" }, "platform_mode_unknown"],
        ...["heritage", "command", "hyperscreen", "checkmarx"].map((look) => [{ look }, "platform_look_unknown"]),
        [{ ambient: "teal" }, "platform_ambient_unknown"], [{ lock: "yes" }, "platform_look_invalid"], [{ colour: "x" }, "platform_look_unknown_key"]]) {
        const r = await api.put("/api/admin/platform-look", { headers: H(csrf), data: body });
        expect(r.status(), JSON.stringify(body)).toBe(400);
        expect((await r.json()).code).toBe(code);
      }
      const ok = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", mode: "dark", ambient: "rose", lock: false } });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      const d = await ok.json();
      expect(d.platform_look).toMatchObject({ look: "signature", mode: "dark", ambient: "rose", lock: false, stamp: 0 });
      const pub = await (await api.get("/api/settings/appearance")).json();
      expect(pub.default_look, "the legacy field follows the look").toBe("signature");
      expect(pub.platform_look.look).toBe("signature");
      const ev = await (await api.get("/api/admin/settings/events")).json();
      const list = Array.isArray(ev) ? ev : (ev.events || []);
      const row = list.find((e) => e.setting_key === "platform_look");
      expect(row, "a platform_look settings event was recorded").toBeTruthy();
      const det = typeof row.details === "string" ? JSON.parse(row.details) : row.details;
      expect(det.to).toMatchObject({ look: "signature", mode: "dark" });
      expect(det.ip, "the event carries the request context").toBeTruthy();
    } finally {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT });
      await api.dispose();
    }
  });

  test("a signed-out caller cannot set it", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE });
    try {
      const t = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
      const r = await anon.put("/api/admin/platform-look", { headers: H(t), data: { look: "signature" } });
      expect([401, 403], `got ${r.status()}`).toContain(r.status());
      expect((await (await anon.get("/api/settings/appearance")).json()).platform_look.look, "nothing was stored").toBe("");
    } finally { await anon.dispose(); }
  });

  test("the FIRST paint of a fresh, signed-out browser has it — before the app runs", async ({ browser }) => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // The house mode follows the device (operator ruling, 13 Nov 2026).
      const dark = { colorScheme: "dark" };
      const before = await firstPaint(browser, null, dark);
      expect(before.look, "CONTROL: with no platform look the house look (Ambient) paints").toBe("ambient");
      expect(before.theme, "in the house mode, the device's: dark on a dark device").toBe("dark");
      const beforeLight = await firstPaint(browser, null, { colorScheme: "light" });
      expect(beforeLight.theme, "CONTROL: and light on a light device").toBe("light");
      expect(before.ambient, "lit by Ambient's own colour").toBe("ice");
      // A stored personal choice still wins over the house default, mode included.
      const ownSig = await firstPaint(browser, withOwn("signature", { "hck-theme": "dark" }), dark);
      expect([ownSig.look, ownSig.theme], "a stored look and mode win").toEqual(["signature", "dark"]);
      const ownSys = await firstPaint(browser, withOwn("ambient", { "hck-theme": "system" }), dark);
      expect(ownSys.theme, "a stored \"system\" keeps following the device").toBe("dark");
      const sysLight = await firstPaint(browser, withOwn("ambient", { "hck-theme": "system" }), { colorScheme: "light" });
      expect(sysLight.theme, "CONTROL: \"system\" on a light device is light").toBe("light");
      const r = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", mode: "dark" } });
      expect(r.ok(), await r.text()).toBeTruthy();
      const after = await firstPaint(browser);
      expect(after.attr, "the shell carries the platform look").toContain("signature");
      expect(after.look, "the first paint is the platform look").toBe("signature");
      expect(after.theme, "and its mode").toBe("dark");
    } finally {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT });
      await api.dispose();
    }
  });

  test("a personal choice wins until \"Apply to everyone now\", which replaces older ones", async ({ browser }) => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature" } });
      const kept = await firstPaint(browser, withOwn("ambient"));
      expect(kept.look, "CONTROL: without Apply, a personal look still wins").toBe("ambient");
      const ap = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", apply_now: true } });
      expect(ap.ok(), await ap.text()).toBeTruthy();
      const stamp = (await ap.json()).platform_look.stamp;
      expect(stamp, "Apply stamps a version").toBeGreaterThan(0);
      const over = await firstPaint(browser, withOwn("ambient"));
      expect(over.look, "a choice made before the stamp gives way").toBe("signature");
      expect(over.own, "and is dropped").toBeNull();
      // CONTROL: a choice made AFTER the stamp (its version is the stamp) wins again.
      const newer = await firstPaint(browser, withOwn("ambient", { "hck-look-v": String(stamp) }));
      expect(newer.look, "a choice made after Apply is kept").toBe("ambient");
    } finally {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT });
      await api.dispose();
    }
  });

  test("locked, participants and signed-out visitors get it; staff browsers keep their own", async ({ browser }) => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const lk = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", lock: true } });
      // A choice made against the current stamp (an earlier test may have applied one).
      const v = { "hck-look-v": String((await lk.json()).platform_look.stamp) };
      const locked = await firstPaint(browser, withOwn("ambient", v));
      expect(locked.look, "the lock overrides a personal choice").toBe("signature");
      expect(locked.own, "without deleting it").toBe("ambient");
      const staff = await firstPaint(browser, withOwn("ambient", { ...v, "hck-staff": "1" }));
      expect(staff.look, "CONTROL: a staff browser keeps its own look").toBe("ambient");
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", lock: false } });
      const unlocked = await firstPaint(browser, withOwn("ambient", v));
      expect(unlocked.look, "CONTROL: unlocked, the personal choice wins").toBe("ambient");
    } finally {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT });
      await api.dispose();
    }
  });

  // A LOCK THAT SETS THE MODE. The setter keeps the locked mode, so a Mode
  // control there pressed to no effect and said nothing. Every Mode control now
  // says so instead (the Appearance page's Mode section, the signed-out header
  // toggle); staff, whom the lock does not bind, keep the choice.
  test("locked with a mode, every Mode control says so instead of offering a choice; staff and a lock without a mode keep it (controls)", async ({ browser }) => {
    test.setTimeout(180_000);
    const { api, csrf } = await apiLogin("superadmin");
    const { makeParticipant } = require("./event-admin-helpers");
    const { loginViaApi, adminLogin } = require("./ui-admin-helpers");
    const { openAppearance } = require("./chrome-helpers");
    const { PARTICIPANT_PASS } = require("./helpers");
    /** The Appearance page's Mode section, as this viewer gets it. */
    const modeSection = async (page) => {
      const ap = await openAppearance(page);
      const sec = ap.locator('section[aria-labelledby="ap-mode-title"]');
      // Where focus went on open: into the dialog, whatever the lock leaves to press.
      const focusIn = await page.evaluate(() => !!(document.activeElement && document.activeElement.closest("#appearance-overlay [role=dialog]")));
      // allTextContents never waits: an absent note reads as "".
      return { buttons: await sec.locator('[data-action="appearance-mode"]').count(), note: (await sec.locator(".ap-lock-note").allTextContents()).join("").trim(),
        lookNote: (await ap.locator('section[aria-labelledby="ap-look-title"] .ap-lock-note').allTextContents()).join("").trim(), focusIn };
    };
    try {
      const p = await makeParticipant(api, csrf, "modelock");
      const lk = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", mode: "dark", lock: true } });
      expect(lk.ok(), await lk.text()).toBeTruthy();

      // Signed out, on a LIGHT device: dark is kept, and with the look AND the
      // mode locked the header offers nothing to choose (no look picker; the old
      // day/night toggle is gone for good).
      const ctx = await browser.newContext({ baseURL: BASE, colorScheme: "light" });
      try {
        const page = await ctx.newPage();
        await page.goto("/");
        await expect(page.locator('html[data-booted="1"]'), "PRECONDITION: the app booted").toBeAttached({ timeout: 20000 });
        await expect(page.locator("#look-picker-btn"), "look and mode locked: no look picker in the header").toHaveCount(0);
        await expect(page.locator("#theme-toggle-btn, [data-action='toggle-theme']"), "and no day/night toggle").toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark is kept on a light device").toBe("dark");

        // Signed in as a participant: the page says so, with no Mode buttons.
        await loginViaApi(page, p.email, PARTICIPANT_PASS);
        await page.goto("/");
        await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 60000 });
        const got = await modeSection(page);
        expect(got.buttons, `no Mode buttons under the lock: ${JSON.stringify(got)}`).toBe(0);
        expect(got.note, "the Mode section says why").toBe("Your organisation has set the mode for everyone: Dark.");
        expect(got.lookNote, "and the Look section too").toBe("Your organisation has set the look for everyone.");
        expect(got.focusIn, "with no look or mode to press, focus still goes into the dialog (to Done)").toBe(true);
      } finally { await ctx.close(); }

      // CONTROL: staff under the same lock keep the Mode choice.
      const ctx2 = await browser.newContext({ baseURL: BASE, colorScheme: "light" });
      try {
        const page = await ctx2.newPage();
        await adminLogin(page);
        await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
        const got = await modeSection(page);
        expect(got, "CONTROL: an organiser is offered the three Mode buttons and no note, and focus goes in").toMatchObject({ buttons: 3, note: "", focusIn: true });
      } finally { await ctx2.close(); }

      // CONTROL: locked WITHOUT a mode, the participant chooses the mode (the look stays locked).
      // (A fresh API session: the organiser's browser sign-in above ended the first.)
      const s2 = await apiLogin("superadmin");
      try {
        const lk2 = await s2.api.put("/api/admin/platform-look", { headers: H(s2.csrf), data: { look: "signature", mode: "", lock: true } });
        expect(lk2.ok(), await lk2.text()).toBeTruthy();
      } finally { await s2.api.dispose(); }
      const ctx3 = await browser.newContext({ baseURL: BASE, colorScheme: "light" });
      try {
        const page = await ctx3.newPage();
        await page.goto("/");
        await expect(page.locator('html[data-booted="1"]'), "PRECONDITION: the app booted").toBeAttached({ timeout: 20000 });
        // CONTROL: only the look locked, the header keeps its look picker (it
        // holds the mode): its Mode buttons are offered, the look note stays.
        await page.locator("#look-picker-btn").click();
        const lp = page.locator("#look-picker-overlay");
        await expect(lp.locator('[data-action="look-picker-mode"]'), "CONTROL: the picker offers the three Mode buttons").toHaveCount(3);
        await expect(lp.locator(".ap-lock-note"), "…and says the look is set").toHaveText("Your organisation has set the look for everyone.");
        await page.keyboard.press("Escape");
        await expect(lp).toHaveCount(0);
        await loginViaApi(page, p.email, PARTICIPANT_PASS);
        await page.goto("/");
        await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 60000 });
        const got = await modeSection(page);
        expect(got, "CONTROL: the Mode buttons are offered; the look note stays; focus goes in (to the mode in force)").toMatchObject({ buttons: 3, note: "", lookNote: "Your organisation has set the look for everyone.", focusIn: true });
      } finally { await ctx3.close(); }
    } finally {
      await api.dispose();
      await restoreDefaultLook();
    }
  });

  test("the Settings card saves it, and the page repaints", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      await require("./ui-admin-helpers").adminLogin(page);
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
      await page.locator('.admin-nav-item[data-tab-id="admin-settings-tab"]').click();
      await require("./ui-admin-helpers").openSettingsSection(page, "branding");   // Settings is two panes
      const card = page.locator("#platform-look-card");
      await expect(card).toBeVisible();
      await card.locator("#pl-look").selectOption("signature");
      await card.locator("[data-action='platform-look-save']").click();
      await expect.poll(async () => (await (await api.get("/api/settings/appearance")).json()).platform_look.look).toBe("signature");
      // A superadmin is staff, so their own pick would win; this browser has none.
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-look"))).toBe("signature");
    } finally {
      await api.dispose();
      await restoreDefaultLook();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PRECEDENCE ONCE THE APP RUNS (ui/theme.js). The arms above block the app
// module, so they hold theme-boot.js alone; ui/theme.js holds the second copy of
// the precedence and repaints on every sign-in, event change and boot read. Here
// the app runs, and the witness is the look it leaves painted.
test.describe("the precedence once the app runs (ui/theme.js)", () => {
  test("boot's own look read: S._appearanceSettled stays false while the read waits, and turns true only once its answer has repainted <html> (the witness tests/helpers.js appearanceSettled waits on)", async ({ page }) => {
    // Specs that paint the look in place wait on this witness first: the read is
    // never awaited, and its repaint once landed on a test's paint (PR CI,
    // 24 Nov 2026: css-token-sites read the Ice chip under its Cyan paint).
    const READ = "**/api/settings/appearance";
    let release; const gate = new Promise((r) => { release = r; });
    let asked; const arrived = new Promise((r) => { asked = r; });
    // A failed run may end the page before the gate opens: nothing to answer then.
    await page.route(READ, async (route) => { asked(); await gate; await route.continue().catch(() => {}); });
    // Its body is read 300 ms late, so a witness set before the repaint (at the
    // answer's headers, say) shows true beside the probe for that long.
    await page.addInitScript(() => {
      const json = Response.prototype.json;
      Response.prototype.json = function () {
        const p = json.call(this);
        return /\/api\/settings\/appearance$/.test(this.url) ? p.then((v) => new Promise((r) => setTimeout(() => r(v), 300))) : p;
      };
    });
    let timer;
    try {
      await page.goto("/");
      await Promise.race([arrived, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("the app never asked for its look")), 20000); })]);
      await page.waitForFunction(() => document.documentElement.getAttribute("data-booted") === "1", null, { timeout: 20000 });
      expect(await page.evaluate(() => window._appearanceSettled), "booted, but the read has not answered: not settled").toBe(false);
      await page.evaluate(() => document.documentElement.setAttribute("data-ambient", "settle-probe"));
      expect(await page.evaluate(() => window._appearanceSettled), "still waiting: not settled").toBe(false);
      release();
      // Polled as tightly as the page allows: the moment it reads settled, the
      // read's repaint has already replaced the probe.
      const seen = await page.waitForFunction(
        () => window._appearanceSettled === true && { ambient: document.documentElement.getAttribute("data-ambient") },
        null, { timeout: 20000, polling: 1 });
      expect((await seen.jsonValue()).ambient, "settled only once the read's repaint replaced the probe").not.toBe("settle-probe");
      await appearanceSettled(page);   // and the helper answers at once
    } finally {
      clearTimeout(timer);
      release();
      await page.unroute(READ);
    }
  });

  test("locked: a participant's sign-in repaints the platform look over their own and clears a staff mark this browser kept; an organiser keeps theirs (control)", async ({ browser }) => {
    test.setTimeout(150_000);
    const { api, csrf } = await apiLogin("superadmin");
    const { makeParticipant } = require("./event-admin-helpers");
    const { loginViaApi, adminLogin } = require("./ui-admin-helpers");
    const { PARTICIPANT_PASS } = require("./helpers");
    const state = (page) => page.evaluate(() => ({ look: document.documentElement.getAttribute("data-look"),
      staff: localStorage.getItem("hck-staff"), own: localStorage.getItem("hck-look") }));
    try {
      const p = await makeParticipant(api, csrf, "lookprec");
      const lk = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", lock: true } });
      expect(lk.ok(), await lk.text()).toBeTruthy();
      // An own look made against the stamp in force, and the staff mark an
      // earlier organiser's session left in this browser: theme-boot.js, which
      // cannot know who signs in, paints the own look first.
      const kept = withOwn("ambient", { "hck-look-v": String((await lk.json()).platform_look.stamp), "hck-staff": "1" });

      const ctx = await browser.newContext({ baseURL: BASE });
      try {
        const page = await ctx.newPage();
        await page.addInitScript(kept.fn, kept.arg);
        await loginViaApi(page, p.email, PARTICIPANT_PASS);
        await page.goto("/");
        await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 60000 });
        await expect.poll(() => state(page), { message: "the participant is repainted to the locked look; the staff mark is gone; their own look is kept, not deleted" })
          .toEqual({ look: "signature", staff: null, own: "ambient" });
      } finally { await ctx.close(); }

      const ctx2 = await browser.newContext({ baseURL: BASE });
      try {
        const page = await ctx2.newPage();
        await page.addInitScript(kept.fn, kept.arg);
        await adminLogin(page);
        await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
        await expect.poll(() => state(page), { message: "CONTROL: an organiser keeps their own look and the staff mark" })
          .toEqual({ look: "ambient", staff: "1", own: "ambient" });
      } finally { await ctx2.close(); }
    } finally {
      await api.dispose();
      await restoreDefaultLook();
    }
  });

  // UNLOCKED, THE ORDER IS: the viewer's own look, then the event's, then the
  // platform's, then the house look. Signature is the platform look here and
  // Ambient (also the house look) the event's, so the two cannot be confused.
  test("unlocked: an event's look beats the platform look, and a viewer's own beats the event's; locked, the event's beats theirs — with the app running and in theme-boot.js alone (control: outside the event, the platform look)", async ({ browser }) => {
    test.setTimeout(150_000);
    const { api, csrf } = await apiLogin("superadmin");
    const look = (page) => page.evaluate(() => document.documentElement.getAttribute("data-look"));
    const EVENT_LOOK = JSON.stringify({ look: "ambient", locked: false });
    const seedEvent = { fn: (v) => { try { sessionStorage.setItem("hck-event-look", v); } catch (_) { /* no storage */ } }, arg: EVENT_LOOK };
    try {
      const lk = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", mode: "", ambient: "", lock: false } });
      expect(lk.ok(), await lk.text()).toBeTruthy();
      const stamp = String((await lk.json()).platform_look.stamp || 0);
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `Unlocked look ${Date.now()}`, event_kind: "booth", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, self_enroll_enabled: true } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      const comp = (await cr.json()).competition;
      const el = await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: "ambient", locked: false } });
      expect(el.ok(), await el.text()).toBeTruthy();
      const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      /** A fresh visitor on a page, with the app running. */
      const visit = async (url, init) => {
        const ctx = await browser.newContext({ baseURL: BASE });
        const page = await ctx.newPage();
        if (init) await page.addInitScript(init.fn, init.arg);
        await page.goto(url);
        await expect(page.locator('html[data-booted="1"]'), "PRECONDITION: the app booted").toBeAttached({ timeout: 20000 });
        return { ctx, page };
      };

      // CONTROL: outside any event the platform look is in force (not the house look, Ambient).
      const out = await visit("/");
      try { expect(await look(out.page), "CONTROL: the platform look, outside the event").toBe("signature"); } finally { await out.ctx.close(); }

      // Inside the event (its join landing, signed out): the event's look beats the platform's.
      const inn = await visit(`/join/${token}`);
      try {
        await expect(inn.page.locator("#join-banner-info"), "the landing resolved the event").toHaveText(comp.name, { timeout: 20000 });
        await expect.poll(() => inn.page.evaluate(() => sessionStorage.getItem("hck-event-look")), { message: "PRECONDITION: the app took the event's look" }).toBe(EVENT_LOOK);
        await expect.poll(() => look(inn.page), { message: "the event's unlocked look beats the platform look", timeout: 15000 }).toBe("ambient");
      } finally { await inn.ctx.close(); }

      // CONTROL: a viewer's own look (made against the stamp in force) beats the event's.
      const own = withOwn("signature", { "hck-look-v": stamp });
      const mine = await visit(`/join/${token}`, own);
      try {
        await expect(mine.page.locator("#join-banner-info")).toHaveText(comp.name, { timeout: 20000 });
        await expect.poll(() => mine.page.evaluate(() => sessionStorage.getItem("hck-event-look")), { message: "PRECONDITION: the app took the event's look" }).toBe(EVENT_LOOK);
        expect(await look(mine.page), "CONTROL: the viewer's own look stays over the event's").toBe("signature");
      } finally { await mine.ctx.close(); }

      // theme-boot.js alone (a reload inside the event): the same two answers.
      expect((await firstPaint(browser, seedEvent)).look, "theme-boot.js: the event's look over the platform's").toBe("ambient");
      const both = { fn: ([v, o]) => { try { sessionStorage.setItem("hck-event-look", v); localStorage.setItem("hck-look", "signature"); localStorage.setItem("hck-look-v", o); } catch (_) { /* no storage */ } }, arg: [EVENT_LOOK, stamp] };
      expect((await firstPaint(browser, both)).look, "theme-boot.js: a viewer's own look over the event's").toBe("signature");
      // And LOCKED, the event's look beats the viewer's own there too (the app's
      // half is the event-look arm below).
      const lockedBoth = { ...both, arg: [JSON.stringify({ look: "ambient", locked: true }), stamp] };
      expect((await firstPaint(browser, lockedBoth)).look, "theme-boot.js: a locked event look over a viewer's own").toBe("ambient");
    } finally {
      await api.dispose();
      await restoreDefaultLook();
    }
  });

  // THE AMBIENT COLOUR has its own rule (ui/theme.js _ambientPreference, its
  // copy in theme-boot.js): a platform locked WITH a colour lights that colour
  // over a viewer's own; unlocked, or locked with no colour, the viewer's own
  // wins. Rose is the platform's colour and Cyan the viewer's, so the two cannot
  // be confused; the witness is the running app's own repaint, after boot.
  test("ambient colour: a platform locked with a colour lights it over a viewer's own; unlocked, or locked with no colour, the viewer's own stays (controls) — with the app running and in theme-boot.js alone", async ({ browser }) => {
    test.setTimeout(120_000);
    const { api, csrf } = await apiLogin("superadmin");
    /** The colour the running app paints, after boot and its own repaint. */
    const appAmbient = async (own) => {
      const ctx = await browser.newContext({ baseURL: BASE });
      try {
        const page = await ctx.newPage();
        await page.addInitScript(own.fn, own.arg);
        await page.goto("/");
        await expect(page.locator('html[data-booted="1"]'), "PRECONDITION: the app booted").toBeAttached({ timeout: 20000 });
        return await page.evaluate(() => {
          window.repaintAppearance();
          return { ambient: document.documentElement.getAttribute("data-ambient"), own: localStorage.getItem("hck-ambient") };
        });
      } finally { await ctx.close(); }
    };
    const setPlatform = async (data) => {
      const r = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "ambient", mode: "", ...data } });
      expect(r.ok(), await r.text()).toBeTruthy();
      // The viewer's own colour is made against the stamp in force, so it counts.
      return withOwn("ambient", { "hck-ambient": "cyan", "hck-look-v": String((await r.json()).platform_look.stamp || 0) });
    };
    try {
      const locked = await setPlatform({ ambient: "rose", lock: true });
      expect(await appAmbient(locked), "the locked platform colour lights over the viewer's own, which is kept").toEqual({ ambient: "rose", own: "cyan" });
      expect((await firstPaint(browser, locked)).ambient, "theme-boot.js: the same answer").toBe("rose");

      const unlocked = await setPlatform({ ambient: "rose", lock: false });
      expect(await appAmbient(unlocked), "CONTROL: unlocked, the viewer's own colour wins").toEqual({ ambient: "cyan", own: "cyan" });
      expect((await firstPaint(browser, unlocked)).ambient, "CONTROL: theme-boot.js, the same answer").toBe("cyan");

      const bare = await setPlatform({ ambient: "", lock: true });
      expect(await appAmbient(bare), "CONTROL: a lock with no colour keeps the viewer's own").toEqual({ ambient: "cyan", own: "cyan" });
      expect((await firstPaint(browser, bare)).ambient, "CONTROL: theme-boot.js, the same answer").toBe("cyan");
    } finally {
      await api.dispose();
      await restoreDefaultLook();
    }
  });

  test("\"Apply to everyone now\" read by the running app replaces a choice made before it; one made after it stays (control)", async ({ page }) => {
    test.setTimeout(90_000);
    const { api, csrf } = await apiLogin("superadmin");
    const state = () => page.evaluate(() => ({ look: document.documentElement.getAttribute("data-look"), own: localStorage.getItem("hck-look") }));
    try {
      expect((await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT })).ok()).toBeTruthy();
      await page.goto("/");
      await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
      // The visitor picks Ambient while the page is open (stamped with the stamp then in force).
      await page.evaluate(() => window._applyLookPreference("ambient"));
      expect(await state(), "PRECONDITION: their own choice is painted and kept").toEqual({ look: "ambient", own: "ambient" });
      const ap = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", apply_now: true } });
      expect(ap.ok(), await ap.text()).toBeTruthy();
      // The page's own read of the platform look (the one boot makes), not a reload.
      await page.evaluate(() => window.loadOrgDefaultLook());
      expect(await state(), "the older choice gives way and is dropped").toEqual({ look: "signature", own: null });
      // CONTROL: a choice made after Apply stays through the same read.
      await page.evaluate(() => window._applyLookPreference("ambient"));
      await page.evaluate(() => window.loadOrgDefaultLook());
      expect(await state(), "CONTROL: a choice made after Apply is kept").toEqual({ look: "ambient", own: "ambient" });
    } finally {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT });
      await api.dispose();
    }
  });
});

test.describe("the event look", () => {
  // A LOCK THAT ARRIVES AFTER THE HEADER. A join landing draws the header, look
  // picker included, before the event's preview answers; a locked event look
  // then arrived with the picker's looks still offered, and every choice in it
  // was refused without a word. An open picker now says why and offers no look;
  // the header keeps the picker, which holds the signed-out visitor's mode.
  test("a locked event look that arrives after the header turns an open picker's looks into the reason, and the picker keeps the mode (control: unlocked keeps the looks)", async ({ browser }) => {
    test.setTimeout(120_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const make = async (locked) => {
        const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
          name: `Late look ${locked ? "locked" : "open"} ${Date.now()}`, event_kind: "booth", timezone: "UTC",
          start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, self_enroll_enabled: true } });
        expect(cr.ok(), await cr.text()).toBeTruthy();
        const comp = (await cr.json()).competition;
        const ok = await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: "signature", locked } });
        expect(ok.ok(), await ok.text()).toBeTruthy();
        return (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      };
      /** A fresh visitor on the landing, with the event preview HELD until released. */
      const land = async (token) => {
        const ctx = await browser.newContext({ baseURL: BASE });
        const page = await ctx.newPage();
        let release;
        const held = new Promise((r) => { release = r; });
        let asked = 0;
        await page.route((u) => u.pathname === `/api/competitions/self-enroll/${token}`, async (route) => { asked++; await held; await route.continue(); });
        await page.goto(`/join/${token}`);
        const btn = page.locator("#look-picker-btn");
        await expect(btn, "PRECONDITION: the header offers the picker before the preview answers").toBeVisible({ timeout: 20000 });
        await expect.poll(() => asked, { message: "PRECONDITION: the preview was asked and is held" }).toBeGreaterThan(0);
        return { ctx, page, btn, release };
      };

      const L = await land(await make(true));
      try {
        await L.btn.click();
        const ov = L.page.locator("#look-picker-overlay");
        await expect(ov.locator('.card-open[data-look-id="ambient"]'), "PRECONDITION: the picker opened with its choices").toBeVisible();
        L.release();
        await expect.poll(() => L.page.evaluate(() => document.documentElement.getAttribute("data-look")), { timeout: 15000 }).toBe("signature");
        await expect(L.btn, "the header keeps its look picker: it holds the mode").toBeVisible();
        await ov.locator('.card-open[data-look-id="ambient"]').click();
        await expect(ov.locator(".ap-lock-note"), "the open picker now says why").toHaveText("This event has its own look while you are in it. It returns to yours when you leave.");
        await expect(ov.locator(".card-open"), "and offers no look").toHaveCount(0);
        await expect(ov.locator('[data-action="look-picker-mode"]'), "…while the mode is still offered").toHaveCount(3);
        await expect(ov.locator('[data-action="overlay-close"]'), "focus stays in the picker").toBeFocused();
        expect(await L.page.evaluate(() => document.documentElement.getAttribute("data-look")), "nothing changed").toBe("signature");
      } finally { await L.ctx.close(); }

      const O = await land(await make(false));
      try {
        O.release();
        await expect.poll(() => O.page.evaluate(() => document.documentElement.getAttribute("data-look")), { timeout: 15000 }).toBe("signature");
        await O.btn.click();
        const ov = O.page.locator("#look-picker-overlay");
        await expect(ov.locator(".card-open"), "CONTROL: unlocked, the picker offers both looks").toHaveCount(2);
        await expect(ov.locator(".ap-lock-note"), "…and no lock note").toHaveCount(0);
      } finally { await O.ctx.close(); }
    } finally { await api.dispose(); }
  });

  test("set per event, validated, audited; the join landing wears it, and its lock beats a choice", async ({ browser }) => {
    test.setTimeout(90_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `Look event ${Date.now()}`, event_kind: "booth", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, self_enroll_enabled: true } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      const comp = (await cr.json()).competition;
      // A personal choice made against the current stamp, so only the event look can override it.
      const own = withOwn("ambient", { "hck-look-v": String((await (await api.get("/api/settings/appearance")).json()).platform_look.stamp) });
      for (const look of ["neon", "heritage", "command", "hyperscreen", "checkmarx"]) {
        const bad = await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look } });
        expect(bad.status(), look).toBe(400);
        expect((await bad.json()).code, look).toBe("event_look_unknown");
      }
      const extra = await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: "signature", theme: "x" } });
      expect(extra.status()).toBe(400);
      const nf = await api.put(`/api/admin/competitions/nope/look`, { headers: H(csrf), data: { look: "signature" } });
      expect(nf.status()).toBe(404);
      const ok = await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: "signature", locked: true } });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      const pv = await (await api.get(`/api/competitions/self-enroll/${token}`)).json();
      expect(pv).toMatchObject({ event_look: "signature", event_look_locked: true });
      const evs = await (await api.get(`/api/admin/competitions/${comp.id}/events`)).json();
      const list = Array.isArray(evs) ? evs : (evs.events || []);
      expect(list.some((e) => e.event_type === "look_changed"), "look_changed is on the event's History").toBe(true);

      // The join landing paints it, over a personal look, because it is locked.
      const ctx = await browser.newContext({ baseURL: BASE });
      const page = await ctx.newPage();
      await page.addInitScript(own.fn, own.arg);
      await page.goto(`/join/${token}`);
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-look")), { timeout: 15000 }).toBe("signature");
      await ctx.close();

      // CONTROL: unlocked, the personal choice wins on the landing.
      await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: "signature", locked: false } });
      const ctx2 = await browser.newContext({ baseURL: BASE });
      const p2 = await ctx2.newPage();
      await p2.addInitScript(own.fn, own.arg);
      await p2.goto(`/join/${token}`);
      await p2.locator("#login-email").waitFor({ state: "visible" });
      // The banner is painted in the same synchronous call that takes the event's look.
      await expect(p2.locator("#join-banner-info"), "the landing resolved the event").toHaveText(comp.name, { timeout: 15000 });
      expect(await p2.evaluate(() => sessionStorage.getItem("hck-event-look")), "PRECONDITION: the unlocked event look arrived")
        .toBe(JSON.stringify({ look: "signature", locked: false }));
      expect(await p2.evaluate(() => document.documentElement.getAttribute("data-look"))).toBe("ambient");
      await ctx2.close();
      // And with no personal choice, the unlocked event look still dresses the landing.
      const ctx3 = await browser.newContext({ baseURL: BASE });
      const p3 = await ctx3.newPage();
      await p3.goto(`/join/${token}`);
      await expect.poll(() => p3.evaluate(() => document.documentElement.getAttribute("data-look")), { timeout: 15000 }).toBe("signature");
      await ctx3.close();
    } finally { await api.dispose(); }
  });

  // THE ENDED-EVENT RULE every per-event write shares: once the effective end
  // has passed, only a superadmin changes the event (re-skinning a finished
  // event is an edit to it, as the certificate design's door also says).
  test("an ended event's look is a superadmin's to change: a regular admin is refused, and the Look card is read-only for them", async ({ page }) => {
    test.setTimeout(90_000);
    const { makeParticipant } = require("./event-admin-helpers");
    const { PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
    const { loginViaApi, viewComp } = require("./ui-admin-helpers");
    const Database = require("better-sqlite3");
    const row = (id) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT event_look, (SELECT COUNT(*) FROM competition_events e WHERE e.competition_id=c.id AND e.event_type='look_changed') AS n FROM competitions c WHERE id=?").get(id); } finally { db.close(); } };
    const { api: sa, csrf } = await apiLogin("superadmin");
    let adm, ended, live;
    try {
      adm = await makeParticipant(sa, csrf, "lookadm");
      const pr = await sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(csrf), data: { role: "admin" } });
      expect(pr.ok(), await pr.text()).toBeTruthy();
      const mk = async (label, startMs, minutes) => {
        const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
          name: `Look ${label} ${Date.now().toString(36)}`, event_kind: "booth", timezone: "UTC",
          start_time: new Date(startMs).toISOString(), duration_minutes: minutes } });
        expect(r.ok(), await r.text()).toBeTruthy();
        return (await r.json()).competition;
      };
      ended = await mk("ended", Date.now() - 3 * 3600e3, 60);
      live = await mk("live", Date.now() - 600e3, 600);
      const al = await apiLogin(adm.email, PARTICIPANT_PASS);
      try {
        const refused = await al.api.put(`/api/admin/competitions/${ended.id}/look`, { headers: H(al.csrf), data: { look: "signature", locked: true } });
        expect(refused.status(), await refused.text()).toBe(403);
        expect((await refused.json()).code).toBe("event_look_ended_locked");
        expect(row(ended.id), "nothing stored, nothing recorded").toEqual({ event_look: null, n: 0 });
        // CONTROL: the same admin changes a live event's look.
        const ok = await al.api.put(`/api/admin/competitions/${live.id}/look`, { headers: H(al.csrf), data: { look: "signature" } });
        expect(ok.status(), await ok.text()).toBe(200);
        expect(row(live.id).event_look).toBe("signature");
      } finally { await al.api.dispose(); }
      // CONTROL: a superadmin changes the ended one.
      const sOk = await sa.put(`/api/admin/competitions/${ended.id}/look`, { headers: H(csrf), data: { look: "ambient" } });
      expect(sOk.status(), await sOk.text()).toBe(200);
      expect(row(ended.id)).toEqual({ event_look: "ambient", n: 1 });
    } finally { await sa.dispose(); }

    // The card follows the route: read-only under the ended note for them.
    await loginViaApi(page, adm.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    const settingsOf = async (comp) => {
      await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
      await viewComp(page, comp.name);
      await page.locator('#ws-tabs [data-section="admin-event-settings-tab"]').click();
      await expect(page.locator("#admin-event-settings-tab .ws-grid-settings")).toBeVisible({ timeout: 15000 });
    };
    await settingsOf(ended);
    await expect(page.locator("#admin-event-settings-tab")).toContainText("Only a superadmin can change an event that has ended.");
    await expect(page.locator("#ev-look"), "no look control on an ended event").toHaveCount(0);
    await expect(page.locator('[data-action="event-look-save"]')).toHaveCount(0);
    await expect(page.locator("#admin-event-settings-tab"), "the look is shown, read-only").toContainText("Ambient");
    await settingsOf(live);
    await expect(page.locator("#ev-look"), "CONTROL: a live event's look is theirs to change").toHaveCount(1);
    await expect(page.locator('[data-action="event-look-save"]')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RETIRED LOOKS (operator ruling, 13 Nov 2026): Heritage, Command, Hyperscreen
// and Checkmarx left the product. A stored choice of one moves, ONCE, to the
// nearest look still offered (db.js, marker `looks_retired_at`). A platform look
// moves Hyperscreen, which was night only, to Ambient at night and the others to
// Signature, whether it is stored as `platform_look` or still as its legacy
// `default_look` row (operator ruling, 14 Nov 2026: the same result either way).
// An event look has no mode, so an event's Hyperscreen moves to Ambient with no
// mode and the others to Signature. Driven against the real db.js in a
// throwaway data directory, because the shared test server is always a FIRST
// boot and the subject is what a later boot does to rows an earlier release
// left behind.
test.describe("the retired looks move to the nearest look still offered", () => {
  test("platform look, legacy default and event looks move once; nothing else changes", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const Database = require("better-sqlite3");
    const boot = (dir) => {
      const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
        encoding: "utf8",
      });
      expect(r.status, `db.js boot must succeed: ${r.stderr}`).toBe(0);
    };
    const MARKER = "looks_retired_at";
    const T0 = "2026-03-01T09:00:00.000Z";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "looks-retired-"));
    try {
      boot(tmp);
      let db = new Database(path.join(tmp, "hackathon.db"));
      expect(db.prepare(`SELECT value FROM settings WHERE key='${MARKER}'`).get(), "a first boot writes the marker though nothing moved").toBeTruthy();
      // What an earlier release could have stored.
      const put = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      put.run("platform_look", JSON.stringify({ look: "hyperscreen", mode: "light", ambient: "rose", lock: true, stamp: 5 }));
      put.run("default_look", "heritage");
      const comp = db.prepare("INSERT INTO competitions (id,name,event_kind,start_time,duration_minutes,created_at,event_look,event_look_locked) VALUES (?,?,?,?,?,?,?,?)");
      const looks = { c1: "command", c2: "checkmarx", c3: "hyperscreen", c4: "heritage", c5: "signature", c6: "ambient", c7: null };
      for (const [id, look] of Object.entries(looks)) comp.run(id, `Event ${id}`, "booth", T0, 120, T0, look, look ? 1 : 0);
      db.prepare(`DELETE FROM settings WHERE key='${MARKER}'`).run();
      db.close();

      boot(tmp);
      db = new Database(path.join(tmp, "hackathon.db"));
      const setting = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
      expect(JSON.parse(setting("platform_look")), "Hyperscreen becomes Ambient at night; colour, lock and stamp kept")
        .toEqual({ look: "ambient", mode: "dark", ambient: "rose", lock: true, stamp: 5 });
      expect(setting("default_look"), "a legacy default the stored platform look outranks moves in place").toBe("signature");
      const ev = Object.fromEntries(db.prepare("SELECT id, event_look, event_look_locked FROM competitions").all().map((r) => [r.id, [r.event_look, r.event_look_locked]]));
      // An event look has no mode: an event's Hyperscreen is Ambient, no more.
      expect(ev).toEqual({
        c1: ["signature", 1], c2: ["signature", 1], c3: ["ambient", 1], c4: ["signature", 1],
        c5: ["signature", 1], c6: ["ambient", 1], c7: [null, 0],
      });
      expect(setting(MARKER), "the marker is written").toBeTruthy();
      // ONE shot: with the marker in place a later boot leaves even a retired id alone.
      db.prepare("UPDATE competitions SET event_look='command' WHERE id='c5'").run();
      db.close();
      boot(tmp);
      db = new Database(path.join(tmp, "hackathon.db"));
      expect(db.prepare("SELECT event_look FROM competitions WHERE id='c5'").get().event_look, "CONTROL: the marker stops a second run").toBe("command");
      db.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // The legacy `default_look` row is a bare look id: it cannot hold "at night".
  // A Hyperscreen one still in force (no platform look stored, as on a database
  // a pre-platform-look build wrote) must end up exactly where a stored
  // Hyperscreen platform look does, stored row for stored row, and read by the
  // app's own reader (lib/platform-look.js getPlatformLook), never a copy of it.
  test("a legacy Hyperscreen default moves to Ambient at night, stored exactly as a Hyperscreen platform look moves; a legacy Heritage default still moves to Signature with no mode, an outranked legacy row never replaces the stored look, and a marked database is left alone (controls)", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const Database = require("better-sqlite3");
    const MARKER = "looks_retired_at";
    // Boot the real db.js on `dir`, then answer the platform look as the app reads it.
    const boot = (dir) => {
      const r = spawnSync(process.execPath, ["-e",
        "require('./db.js'); process.stdout.write('\\nPLATFORM_LOOK=' + JSON.stringify(require('./lib/platform-look').getPlatformLook()) + '\\n')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
        encoding: "utf8",
      });
      expect(r.status, `db.js boot must succeed: ${r.stderr}`).toBe(0);
      const line = String(r.stdout).split("\n").find((l) => l.startsWith("PLATFORM_LOOK="));
      expect(line, `the child printed the platform look: ${r.stdout}`).toBeTruthy();
      return JSON.parse(line.slice("PLATFORM_LOOK=".length));
    };
    const rows = (dir) => {
      const db = new Database(path.join(dir, "hackathon.db"), { readonly: true });
      try {
        const v = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
        return { platform_look: v("platform_look"), default_look: v("default_look"), marked: !!v(MARKER) };
      } finally { db.close(); }
    };
    // What an earlier release left behind: only `planted` among the two look
    // rows, and (unless `marked`) no marker, so the next boot runs the move.
    const plant = (dir, planted, { marked = false } = {}) => {
      const db = new Database(path.join(dir, "hackathon.db"));
      try {
        db.prepare("DELETE FROM settings WHERE key IN ('platform_look', 'default_look')").run();
        const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries(planted)) put.run(k, v);
        if (!marked) db.prepare(`DELETE FROM settings WHERE key='${MARKER}'`).run();
      } finally { db.close(); }
    };
    const fresh = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "looks-retired-legacy-"));
      boot(dir);
      expect(rows(dir).marked, "PRECONDITION: a first boot writes the marker").toBe(true);
      return dir;
    };
    const NIGHT = { look: "ambient", mode: "dark", ambient: "", lock: false, stamp: 0 };
    const dirs = [];
    try {
      // THE LEGACY PATH: the bare row is the look in force.
      const legacy = fresh(); dirs.push(legacy);
      plant(legacy, { default_look: "hyperscreen" });
      expect(rows(legacy), "PRECONDITION: only the legacy row, and no marker")
        .toEqual({ platform_look: undefined, default_look: "hyperscreen", marked: false });
      const legacyLook = boot(legacy);
      const legacyRows = rows(legacy);

      // THE JSON PATH: the same choice stored as a platform look (the shape
      // setPlatformLook writes).
      const json = fresh(); dirs.push(json);
      plant(json, { platform_look: JSON.stringify({ look: "hyperscreen", mode: "", ambient: "", lock: false, stamp: 0 }) });
      const jsonLook = boot(json);
      const jsonRows = rows(json);

      expect(jsonLook, "PRECONDITION: the JSON path moves Hyperscreen to Ambient at night").toEqual(NIGHT);
      expect(legacyLook, "the legacy Hyperscreen default reads as Ambient at night").toEqual(NIGHT);
      expect(legacyRows, "…and is STORED as the JSON path stores it: the same platform look row, the legacy row dropped").toEqual(jsonRows);
      expect(JSON.parse(legacyRows.platform_look), "by value").toEqual(NIGHT);
      expect(legacyRows.default_look, "the legacy row is gone, as a platform look's first write drops it").toBeUndefined();
      expect(legacyRows.marked, "the marker is written").toBe(true);

      // CONTROL: a legacy Heritage default still moves to Signature with no mode,
      // in place.
      const heritage = fresh(); dirs.push(heritage);
      plant(heritage, { default_look: "heritage" });
      expect(boot(heritage), "a legacy Heritage default reads as Signature, with no mode")
        .toEqual({ look: "signature", mode: "", ambient: "", lock: false, stamp: 0 });
      expect(rows(heritage), "…stored in place, with no platform look written")
        .toEqual({ platform_look: undefined, default_look: "signature", marked: true });

      // CONTROL: a legacy Hyperscreen row a stored platform look outranks is not
      // the look in force, so it never replaces that look: it moves in place.
      const outranked = fresh(); dirs.push(outranked);
      const live = JSON.stringify({ look: "signature", mode: "light", ambient: "", lock: true, stamp: 7 });
      plant(outranked, { platform_look: live, default_look: "hyperscreen" });
      expect(boot(outranked), "the stored platform look still reads as it was")
        .toEqual({ look: "signature", mode: "light", ambient: "", lock: true, stamp: 7 });
      expect(rows(outranked), "…stored as it was, the outranked legacy row moved in place")
        .toEqual({ platform_look: live, default_look: "ambient", marked: true });

      // CONTROL: a database already marked is untouched, a legacy Hyperscreen row included.
      plant(legacy, { default_look: "hyperscreen" }, { marked: true });
      expect(rows(legacy).marked, "PRECONDITION: the marker is in place").toBe(true);
      expect(boot(legacy), "a retired id the marker leaves alone reads as no choice").toEqual({ look: "", mode: "", ambient: "", lock: false, stamp: 0 });
      expect(rows(legacy), "nothing moved: the legacy row as it was, and no platform look written")
        .toEqual({ platform_look: undefined, default_look: "hyperscreen", marked: true });
    } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
  });
});
