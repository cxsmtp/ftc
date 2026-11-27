// @ts-check
//
// THE SIGNED-OUT HEADER AND THE BOOT SIGNAL.
//
// The header's day/night toggle is gone (operator report, 9.1.1): signed out,
// the one appearance control is the look picker, whose dialog holds the mode;
// signed in, Appearance lives in the account menu. The mode preference itself
// stays (tests/theme-cycle.spec.js).
//
// The toggle used to double as the tests' "boot() has run" signal. That job is
// now <html data-booted="1">, set by the LAST statement of boot() in
// public/js/core/main.js, after every delegated handler and the OS-theme
// listener. The sign-in page is static markup that paints without the app, so a
// signal that could appear before the handlers exist would let a spec act on a
// page that does nothing. Pinned two ways:
//   - SOURCE: the assignment is boot()'s last statement, after the OS-theme
//     listener, the header mount and the handler registrations, and nothing
//     else in public/ writes the attribute;
//   - BEHAVIOUR: a load whose app never booted never shows it, while a clean
//     load shows it and the look picker answers the first press.
//
// With the toggle gone, the look picker is a signed-out visitor's only MODE
// control, so a locked look keeps it: the dialog offers the mode and says the
// look is set. Only a lock that sets the mode too leaves nothing to offer.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, settleFiniteAnimations } = require("./helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const DEFAULT_LOOK = { look: "", mode: "", ambient: "", lock: false };   // the platform look's hard-coded default

/** A fresh signed-out page on `url`, booted. */
async function freshPage(browser, url) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(url);
  await expect(page.locator('html[data-booted="1"]'), "the app booted").toBeAttached({ timeout: 20000 });
  return { ctx, page };
}

/** Open the picker, check it says `note` in place of the looks, and set Night through it. */
async function modeThroughLockedPicker(page, note) {
  const btn = page.locator("#app-header #look-picker-btn");
  await expect(btn, "the visitor's one mode control stays under a locked look").toBeVisible();
  await btn.click();
  const dlg = page.locator("#look-picker-overlay [role=dialog]");
  await expect(dlg.locator(".ap-lock-note"), "the look is said, not offered").toHaveText(note);
  await expect(dlg.locator(".lp-card"), "no look the visitor cannot apply").toHaveCount(0);
  await expect(dlg.locator('[data-action="look-picker-mode"][data-mode="system"]'), "the mode's own choice is focused").toBeFocused();
  await dlg.locator('[data-action="look-picker-mode"][data-mode="dark"]').click();
  await expect(page.locator("html"), "the mode applies").toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("hck-theme")), "…and is kept").toBe("dark");
}

test.describe("The signed-out header", () => {
  test("holds the look picker and no theme toggle; the picker answers the first press after the boot signal", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('html[data-booted="1"]'), "the app booted").toBeAttached({ timeout: 20000 });
    const header = page.locator("#app-header");
    await expect(header.locator("#look-picker-btn"), "CONTROL: the look picker is in the signed-out header").toBeVisible();
    await expect(page.locator("#theme-toggle-btn, [data-action='toggle-theme']"), "the day/night toggle is gone").toHaveCount(0);
    expect(await page.locator("#theme-slot").evaluate(el => [...el.children].map(c => c.id)), "the slot holds the picker alone").toEqual(["look-picker-btn"]);
    // The handlers exist the moment the signal does: the first press opens it.
    await header.locator("#look-picker-btn").click();
    await expect(page.locator("#look-picker-overlay [role=dialog]")).toBeVisible();
  });

  test("under a locked platform look the picker keeps the mode; with the mode locked too, nothing is offered", async ({ browser }) => {
    test.setTimeout(90_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const lk = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", lock: true } });
      expect(lk.ok(), await lk.text()).toBeTruthy();
      const a = await freshPage(browser, "/");
      try {
        await expect(a.page.locator("html"), "PRECONDITION: the lock is in force").toHaveAttribute("data-look", "signature");
        await modeThroughLockedPicker(a.page, "Your organisation has set the look for everyone.");
      } finally { await a.ctx.close(); }

      const lm = await api.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature", mode: "light", lock: true } });
      expect(lm.ok(), await lm.text()).toBeTruthy();
      const b = await freshPage(browser, "/");
      try {
        await expect(b.page.locator("html"), "PRECONDITION: the locked mode is in force").toHaveAttribute("data-theme", "light");
        await expect(b.page.locator("#look-picker-btn"), "look and mode both set: nothing to offer").toHaveCount(0);
        expect(await b.page.locator("#theme-slot").evaluate(el => el.children.length)).toBe(0);
      } finally { await b.ctx.close(); }
    } finally {
      await api.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT_LOOK });
      await api.dispose();
    }
  });

  test("an event look locked on a join landing, arriving after the header is drawn, keeps the mode", async ({ browser }) => {
    test.setTimeout(90_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `Signed-out look ${Date.now()}`, event_kind: "booth", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, self_enroll_enabled: true } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      const comp = (await cr.json()).competition;
      const lk = await api.put(`/api/admin/competitions/${comp.id}/look`, { headers: H(csrf), data: { look: "signature", locked: true } });
      expect(lk.ok(), await lk.text()).toBeTruthy();
      const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      expect(token, "PRECONDITION: the join link").toBeTruthy();
      const a = await freshPage(browser, `/join/${token}`);
      try {
        await expect.poll(() => a.page.evaluate(() => document.documentElement.getAttribute("data-look")), { timeout: 15000, message: "PRECONDITION: the event's locked look is in force" }).toBe("signature");
        await modeThroughLockedPicker(a.page, "This event has its own look while you are in it. It returns to yours when you leave.");
      } finally { await a.ctx.close(); }
    } finally { await api.dispose(); }
  });
});

// THE 32 px ICON BUTTONS ARE 44 px TARGETS. The look picker and "?" (and the help
// drawer's two) draw a 32 px circle or pill; the target is the button's own ::after,
// 6 px beyond its border all round. Two side by side need 12 px between them, or
// the later one's target covers the earlier's edge: the phone header's 8 px gap is
// widened for the pair, and the drawer's row is 12 px. Held two ways, at a desktop
// and a phone width: the TARGET box (the ::after's resolved rect) is at least 44 px
// each way and never overlaps a neighbour's; and in the page a press 4 px beyond
// the drawn edge lands on the button while one 9 px beyond does not. (A probe at a
// half pixel is no witness: hit testing snaps it, so the size is read as geometry.)
/** The drawn box, the target box and where presses land, for each button `sel` names (DOM order). */
const hitsAround = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
  .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
  .map((el) => {
    const b = el.getBoundingClientRect(), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
    const cs = getComputedStyle(el), a = getComputedStyle(el, "::after");
    // An absolutely positioned ::after sits in the padding box: offset by the border.
    const tl = b.left + parseFloat(cs.borderLeftWidth) + parseFloat(a.left);
    const tt = b.top + parseFloat(cs.borderTopWidth) + parseFloat(a.top);
    const target = a.content === "none" || a.position !== "absolute" ? null
      : { left: tl, top: tt, right: tl + parseFloat(a.width), bottom: tt + parseFloat(a.height), events: a.pointerEvents };
    const on = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e)); };
    return { id: el.id || el.getAttribute("data-action") || el.className, w: b.width, h: b.height, left: b.left, right: b.right, top: b.top, bottom: b.bottom, target,
      inside: [on(b.left - 4, cy), on(b.right + 4, cy), on(cx, b.top - 4), on(cx, b.bottom + 4)],
      outside: [on(b.left - 9, cy), on(b.right + 9, cy)] };
  }), sel);
function expectTargets(list, where) {
  for (const b of list) {
    const why = `${where}: ${JSON.stringify(b)}`;
    expect(b.h, `${b.id} still draws 32 px tall — ${why}`).toBe(32);
    expect(b.w, `${b.id} draws at least 32 px wide — ${why}`).toBeGreaterThanOrEqual(32);
    expect(b.target, `${b.id} has a target box of its own (its ::after) — ${why}`).not.toBeNull();
    const t = b.target;
    expect(t.right - t.left, `${b.id}'s target is at least 44 px wide — ${why}`).toBeGreaterThanOrEqual(44);
    expect(t.bottom - t.top, `${b.id}'s target is at least 44 px tall — ${why}`).toBeGreaterThanOrEqual(44);
    expect(t.left <= b.left && t.right >= b.right && t.top <= b.top && t.bottom >= b.bottom, `${b.id}'s target holds the drawn button — ${why}`).toBe(true);
    expect(b.inside, `a press 4 px beyond ${b.id}'s left, right, top and bottom edge lands on it — ${why}`).toEqual([true, true, true, true]);
    expect(b.outside, `a press 9 px beyond ${b.id} does not — ${why}`).toEqual([false, false]);
  }
  for (let i = 1; i < list.length; i++) {
    const [p, n] = [list[i - 1], list[i]];
    expect(n.left - p.right, `${where}: 12 px between ${p.id} and ${n.id}`).toBeGreaterThanOrEqual(12);
    expect(p.target.right, `${where}: ${p.id}'s target ends before ${n.id}'s begins (no press on one can land on the other)`).toBeLessThanOrEqual(n.target.left + 0.01);
  }
}

test.describe("The header's icon buttons", () => {
  for (const width of [1280, 390]) {
    test(`draw 32 px, answer a 44 px target, and never take a neighbour's press (${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await expect(page.locator('html[data-booted="1"]'), "the app booted").toBeAttached({ timeout: 20000 });
      const header = await hitsAround(page, "#app-header .help-icon-btn");
      expect(header.map((b) => b.id), "PRECONDITION: the signed-out header shows the look picker, then \"?\"").toEqual(["look-picker-btn", "help-icon-btn"]);
      expectTargets(header, `header at ${width} px`);
      // The help drawer's own pair: Open in new tab, then Close.
      await page.locator("#help-icon-btn").click();
      await expect(page.locator("#help-drawer-overlay.help-open")).toBeVisible({ timeout: 10000 });
      await settleFiniteAnimations(page, "#help-drawer-overlay");
      const drawer = await hitsAround(page, "#help-drawer-overlay .help-drawer-actions .help-icon-btn");
      expect(drawer.map((b) => b.id), "PRECONDITION: the drawer shows its two icon buttons").toEqual(["help-open-ext", "help-close"]);
      expectTargets(drawer, `help drawer at ${width} px`);
    });
  }
});

test.describe("The boot signal", () => {
  test("source: html[data-booted] is set by the LAST statement of boot(), and nowhere else", () => {
    const raw = fs.readFileSync(path.join(ROOT, "public", "js", "core", "main.js"), "utf8");
    const src = stripJsComments(raw);
    const start = src.indexOf("function boot() {");
    expect(start, "boot() exists").toBeGreaterThan(-1);
    // boot() is a top-level function: its closing brace is the first one at
    // column 0 after its opening line.
    const end = src.indexOf("\n}\n", start);
    expect(end, "boot() closes").toBeGreaterThan(start);
    const body = src.slice(start + "function boot() {".length, end);
    const SIGNAL = /document\.documentElement\.dataset\.booted\s*=\s*["']1["']\s*;?\s*$/;
    expect(body.trimEnd(), "the signal is the last statement of boot()").toMatch(SIGNAL);
    const at = body.search(/document\.documentElement\.dataset\.booted\s*=/);
    // Anti-vacuity: what it must follow is really in boot(), above it.
    const os = body.indexOf("prefers-color-scheme");
    expect(os, "the OS-theme listener is in boot()").toBeGreaterThan(-1);
    expect(os, "…and above the signal").toBeLessThan(at);
    const mount = body.indexOf("_mountHeaderIcons");
    expect(mount, "the header mount is in boot(), above the signal").toBeGreaterThan(-1);
    expect(mount).toBeLessThan(at);
    const regs = [...body.matchAll(/\bregister(?:Action|Change|Input)\s*\(/g)];
    expect(regs.length, "anti-vacuity: boot() registers its handlers").toBeGreaterThan(200);
    expect(regs.every(m => m.index < at), "every handler registration precedes the signal").toBe(true);
    // One writer: no other first-party script (theme-boot.js runs before the
    // app) and no static markup may set it, or the signal would not mean "booted".
    const writers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "vendor") walk(p); continue; }
        if (!/\.(js|html)$/.test(e.name)) continue;
        const s = /\.js$/.test(e.name) ? stripJsComments(fs.readFileSync(p, "utf8")) : fs.readFileSync(p, "utf8");
        if (/dataset\.booted|data-booted/.test(s)) writers.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, "public"));
    expect(writers, "only core/main.js writes the boot signal").toEqual([path.join("public", "js", "core", "main.js")]);
  });

  test("a load whose app never booted never shows the signal; a clean load does", async ({ page }) => {
    // Fail the entry module every time: theme-boot.js reloads once, then says so.
    await page.route(/\/js\/core\/main\.js(\?|$)/, (route) => route.abort("failed"));
    await page.goto("/");
    await expect(page.locator("#boot-failure"), "the page says it did not finish loading").toBeVisible({ timeout: 20000 });
    await expect(page.locator("#login-email"), "the static sign-in page painted").toBeVisible();
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-booted")), "no app, no signal").toBe(false);
    // CONTROL — the same page with the module served boots and says so.
    await page.unroute(/\/js\/core\/main\.js(\?|$)/);
    await page.evaluate(() => { try { sessionStorage.clear(); } catch (_) { /* no storage */ } });
    await page.goto("/");
    await expect(page.locator('html[data-booted="1"]'), "a clean load sets the signal").toBeAttached({ timeout: 20000 });
  });
});
