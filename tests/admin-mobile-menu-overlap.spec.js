// @ts-check
//
// v8.12.6 — THE PHONE ADMIN MENU BUTTON SAT ON THE CONTENT IT OPENS A MENU FOR.
//
// LANE CHROME (v8.16) — the floating button is gone: `#admin-mobile-menu-btn` is
// now the SECTION BAR, full width and in flow right under the header (not
// sticky: it scrolls with the page), naming the section on screen. Every arm below still holds for it (it is >=44px, on
// screen, below the header, and nothing it opens lands under it); the band the
// content reserved for a floating button is gone because nothing floats.
//
// `#admin-mobile-menu-btn` is `position:fixed` at the header's bottom edge + 8px,
// left 12px, 48x44 — and at <=768px `.admin-content` reserved no room for it (16px
// top padding), so the FIRST thing in the admin content sat under it. Measured at
// 320/390/600/667-landscape/768 and under event-admin impersonation: the left 40px
// of every pane heading (all nine; "Logs" is 42px wide), 1-3px of the first toolbar
// control, and — with an event focused — the scope banner's "Viewing:" line.
// Hit-testing inside the heading text returned the BUTTON at 3-4 of 4 points.
//
// The same element carried four more defects, found by the same sweep, and this
// file locks each of them:
//  - at z-index 210 the button painted ON the open drawer (200), over its second
//    and third items, so a tap on their icons hit the button;
//  - a second activation while open (a double-tap, a mouse double-click, or a
//    screen reader's virtual cursor — the button is outside the inert content)
//    installed a SECOND focus trap and orphaned the first: Tab was stuck on the
//    button for the rest of the session, and after widening past 768px it was
//    confined to the sidebar — a full keyboard trap on desktop;
//  - the shared trap's re-entry target was display:none (#admin-sidebar-toggle),
//    so once focus left the OPEN drawer forward Tab went nowhere (pre-existing);
//  - leaving the admin page, or rotating past 768px, with the drawer open left its
//    modality behind (the trap, the inert content, the unscoped scrim).
//
// SCOPE, STATED SO NOBODY INFERS MORE: the band locks the UNSCROLLED state. The
// bar is in flow and scrolls away with the content, so nothing passes under it;
// scrolled content passes only under the sticky header. The one scrolled case
// this file locks is the route focus after a tab switch from a scrolled pane
// (the scroll-margin arm).
//
// This file is also the ONLY lock on v7.23.3 #17 (the button must not sit on the
// HEADER, where at a hard-coded 70px it covered Logout): arm A's header control.
// Without it every arm here passes a "fix" that lifts the button into the header.
//
// Every positive has a control: the button must still be VISIBLE, >=44px and on
// screen (or "nothing overlaps it" is satisfied by a build that hid it), the
// desktop layout must be untouched, and one ordinary open/close must leave Tab
// working (or a leak arm proves nothing about the trap).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, getSuperadminPass, waitForAdminPage, codeLogin } = require("./helpers");

test.use({ baseURL: BASE, reducedMotion: "reduce" });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
// RBAC sidebar — every pane reached from the sidebar (Submissions and Logs are
// opened through Audit now, so Audit and Users & roles take their places).
const TABS = ["competitions", "tasks", "participants", "groups", "audit", "rankings", "analytics", "users", "settings"];
const csrf = async (page) => (await (await page.request.get("/api/csrf-token")).json()).csrfToken;

async function superadminLogin(page) {
  // The built-in password rotates GLOBALLY after 10 failed logins, and the server
  // writes the fresh one BEFORE answering — so one re-read recovers a stale read
  // (the apiLogin / loginViaApi retry, v7.2.x).
  let r = await page.request.post("/api/login", { headers: H(await csrf(page)), data: { email: "superadmin", password: getSuperadminPass() } });
  if (!r.ok()) r = await page.request.post("/api/login", { headers: H(await csrf(page)), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
}

async function admin(page) {
  // API login BEFORE the first navigation: an SPA booted anonymously would 401
  // its own polls the instant the login regenerated the session (v7.21.26).
  await superadminLogin(page);
  await page.goto("/");
  await waitForAdminPage(page);
  await page.locator("#admin-competitions-tab h2").waitFor({ state: "visible", timeout: 20000 });
}

const touchCtx = (browser, viewport) => browser.newContext({
  baseURL: BASE, viewport, hasTouch: true, isMobile: true, reducedMotion: "reduce",
});

const drawerIsOpen = async (page) => (await page.locator("#admin-sidebar.mobile-open").count()) > 0;

// Open a pane through the real drawer, by data-tab-id. The hamburger is clicked
// ONLY when the drawer is closed: since v8.12.6 it sits BELOW the open drawer's
// scrim, so a click on it while open fails actionability rather than silently
// re-running the handler.
async function openTab(page, slug) {
  const isDrawer = await page.evaluate(() => matchMedia("(max-width:768px)").matches);
  if (isDrawer && !(await drawerIsOpen(page))) {
    await page.locator("#admin-mobile-menu-btn").click();
    await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
  }
  await page.locator(`.admin-nav-item[data-tab-id="admin-${slug}-tab"]`).click();
  await page.locator(`#admin-${slug}-tab`).waitFor({ state: "visible", timeout: 15000 });
}

// Wait until the drawer has SETTLED on screen. Not a fixed sleep: the slide is
// --duration-normal and a sleep with little margin is a flake under load — a tap
// would land on a moving item.
async function drawerSettled(page) {
  await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
  await expect.poll(() => page.evaluate(() => {
    const s = document.getElementById("admin-sidebar");
    return s.getAnimations().length === 0 && Math.round(s.getBoundingClientRect().left) === 0;
  }), { timeout: 5000, message: "the drawer never settled on screen" }).toBe(true);
}

async function openDrawerSettled(page) {
  await page.locator("#admin-mobile-menu-btn").click();
  await drawerSettled(page);
}

// Count every click the document sees, so an arm can wait until a gesture's
// clicks have all been DISPATCHED rather than sleeping and hoping they have.
const armClickCounter = (page) => page.evaluate(() => {
  window.__f6clicks = 0;
  document.addEventListener("click", () => { window.__f6clicks++; }, true);
});
const clicksSeen = (page, n) => expect.poll(() => page.evaluate(() => window.__f6clicks), {
  timeout: 5000, message: `the gesture's ${n} clicks were never dispatched`,
}).toBeGreaterThanOrEqual(n);

const focusId = () => {
  const a = document.activeElement;
  if (!a) return "(none)";
  return (a.closest("#admin-sidebar") ? "DRAWER:" : "") + (a.id || a.getAttribute("data-tab-id") || a.getAttribute("data-action") || a.tagName);
};

async function tabStops(page, n, key = "Tab") {
  const stops = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    stops.push(await page.evaluate(focusId));
  }
  return stops;
}

const paneState = (page) => page.evaluate(() => ({
  open: document.getElementById("admin-sidebar").classList.contains("mobile-open"),
  pane: ([...document.querySelectorAll('#admin-page .admin-content > [id^="admin-"][id$="-tab"]')]
    .find((e) => getComputedStyle(e).display !== "none") || {}).id || null,
  focus: (() => { const a = document.activeElement; return a ? (a.id || a.getAttribute("data-tab-id") || a.tagName) : null; })(),
}));

// The OTHER half of the button's placement invariant (v7.23.3 #17): it must not
// sit on the HEADER either.
function buttonClearOfHeader(page) {
  return page.evaluate(() => {
    const b = document.getElementById("admin-mobile-menu-btn").getBoundingClientRect();
    const hdr = document.getElementById("app-header").getBoundingClientRect();
    const covered = [...document.querySelectorAll("#app-header button, #app-header a, #app-header [data-action]")]
      .filter((e) => e.getClientRects().length)
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(h && h.closest("#admin-mobile-menu-btn"));
      })
      .map((e) => (e.textContent || e.getAttribute("aria-label") || e.id).trim().slice(0, 20));
    return { btnTop: Math.round(b.top), headerBottom: Math.round(hdr.bottom), covered };
  });
}

// Is the first RENDERED match of `sel` clear of the menu button — by box AND by
// hit-test at three points inside its text? The box alone would pass a heading
// the button sat on if the button were transparent to hit-testing; the hit-test
// alone would pass a control whose text begins right of the button.
function clearOfButton(page, sel) {
  return page.evaluate((sel) => {
    const btn = document.getElementById("admin-mobile-menu-btn").getBoundingClientRect();
    const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length);
    if (!el) return { missing: sel, btnH: btn.height };
    const r = el.getBoundingClientRect();
    const boxHit = r.left < btn.right && r.right > btn.left && r.top < btn.bottom && r.bottom > btn.top;
    const rg = document.createRange(); rg.selectNodeContents(el);
    const tb = rg.getBoundingClientRect();
    const onBtn = [2, 10, 24].filter((dx) => {
      const h = document.elementFromPoint(tb.left + dx, (tb.top + tb.bottom) / 2);
      return !!(h && h.closest("#admin-mobile-menu-btn"));
    }).length;
    return { boxHit, onBtn, btnH: btn.height, el: [Math.round(r.left), Math.round(r.top)], btn: [Math.round(btn.top), Math.round(btn.bottom)] };
  }, sel).then((r) => {
    // Every arm's anti-vacuity precondition: a button with no box overlaps
    // nothing, so "clear of it" would be satisfied by a build that hid it.
    expect(r.btnH, `the menu button must be rendered (44px) for "${sel}" to be clear of it`).toBeGreaterThanOrEqual(44);
    return r;
  });
}

// A user-backed admin: the built-in superadmin has no "Participant View" toggle
// (buildAdminNav renders it only for S.currentUser). Built from scratch, never a
// promoted seeded fixture (the v8.3.28 contract); the participants list is read at
// its documented 5000 cap — `?search=` is a no-op on that endpoint.
async function userBackedAdmin(page) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const email = `mm_${stamp}@acme.com`, password = "MenuBand!2026";
  const reg = await registerPost(page.request, "/api/register", { headers: H(await csrf(page)), data: {
    firstName: "Menu", lastName: "Band", nickname: `mm_${stamp}`, email, company: "Acme Corp", title: "Engineer",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "New York", password } });
  expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  await superadminLogin(page);
  const lr = await page.request.get("/api/admin/participants?limit=5000");
  expect(lr.ok(), `participants list: ${lr.status()}`).toBeTruthy();
  const body = await lr.json();
  const u = (body.participants || []).find((p) => p.email === email);
  expect(u, `the new account must be in the list (scanned ${(body.participants || []).length})`).toBeTruthy();
  for (const a of ["verify", "approve"]) {
    const r = await page.request.post(`/api/admin/participants/${u.id}/${a}`, { headers: H(await csrf(page)), data: {} });
    expect(r.ok(), `${a}: ${r.status()} ${await r.text()}`).toBeTruthy();
  }
  const rr = await page.request.post(`/api/admin/participants/${u.id}/role`, { headers: H(await csrf(page)), data: { role: "admin" } });
  expect(rr.ok(), `promote: ${rr.status()} ${await rr.text()}`).toBeTruthy();
  const li = await codeLogin(page.request, email, H(await csrf(page)), { password: password });
  expect(li.ok(), `admin login: ${li.status()}`).toBeTruthy();
  await page.goto("/");
  await waitForAdminPage(page);
  await page.locator("#admin-competitions-tab h2").waitFor({ state: "visible", timeout: 20000 });
}

// ── A. Every pane heading and first control is clear — and the button is still
//       there, still a touch target, and still off the header.
for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 667, height: 375 }]) {
  test.describe(`at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test("every pane heading and first control is clear of the menu button, and the button is clear of the header", async ({ page }) => {
      await admin(page);
      // CONTROL — the button is still there to be clear OF.
      const b = await page.locator("#admin-mobile-menu-btn").boundingBox();
      expect(b, "the menu button must be visible on a phone/tablet width").toBeTruthy();
      expect(b.width, "44px touch target").toBeGreaterThanOrEqual(44);
      expect(b.height, "44px touch target").toBeGreaterThanOrEqual(44);
      expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width, `the button must be on screen: ${JSON.stringify(b)}`).toBe(true);
      // HEADER-CLEAR CONTROL — v7.23.3 #17.
      const hc = await buttonClearOfHeader(page);
      expect(hc.btnTop, `the button must sit BELOW the header, not on it: ${JSON.stringify(hc)}`).toBeGreaterThanOrEqual(hc.headerBottom);
      expect(hc.covered, "header controls the menu button covers").toEqual([]);
      for (const slug of TABS) {
        await openTab(page, slug);
        const h = await clearOfButton(page, `#admin-${slug}-tab h2`);
        expect(h.missing, `${slug}: the pane must render a heading`).toBeUndefined();
        expect(h.boxHit || h.onBtn > 0, `${slug} heading under the menu button: ${JSON.stringify(h)}`).toBe(false);
        const c = await clearOfButton(page, `#admin-${slug}-tab :is(input,button,select)`);
        if (!c.missing) expect(c.boxHit, `${slug} first control under the menu button: ${JSON.stringify(c)}`).toBe(false);
      }
    });
  });
}

test.describe("at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // ── B. The banner, not the heading, is then first — a heading-only fix fails it.
  test("a FOCUSED event's scope banner is clear of the menu button", async ({ page }) => {
    await admin(page);
    const name = `F6 banner ${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const cr = await page.request.post("/api/admin/competitions", { headers: H(await csrf(page)),
      data: { name, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 60 } });
    expect(cr.ok(), `create: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const id = (await cr.json()).competition.id;
    await page.reload();
    await waitForAdminPage(page);
    // The MODEL, not a DOM row: the Events table paginates and chip-filters, so a
    // row's presence depends on how full the table is (v7.15.29).
    await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), id),
      { timeout: 15000, message: "the new event never reached the admin model" }).toBe(true);
    await page.evaluate(([id, n]) => window.setAdminCompetitionScope(id, n), [id, name]);
    await expect(page.locator("#admin-scope-banner")).toBeVisible();
    await expect(page.locator("#admin-scope-banner"), "the banner must be the focused event's").toContainText(name);
    const r = await clearOfButton(page, "#admin-scope-banner");
    expect(r.boxHit || r.onBtn > 0, `the scope banner is under the menu button: ${JSON.stringify(r)}`).toBe(false);
  });

  // ── C. The route focus from a SCROLLED pane.
  test("a tab switch from a SCROLLED pane lands the focused heading clear of the button", async ({ page }) => {
    // The route focus scrolls the heading into view with a scroll margin; one
    // measured against the header alone parked it at header+8px — exactly where
    // the button is (measured: scrollY 52, heading hit-test = the button).
    await admin(page);
    await openTab(page, "settings");
    await page.evaluate(() => window.scrollTo(0, 500));
    const y0 = await page.evaluate(() => window.scrollY);
    expect(y0, "precondition: the Settings pane must be long enough to scroll").toBeGreaterThan(100);
    await openTab(page, "analytics");
    await expect(page.locator("#admin-analytics-tab h2")).toBeFocused();
    const h = await clearOfButton(page, "#admin-analytics-tab h2");
    expect(h.boxHit || h.onBtn > 0, `the route-focused heading is under the menu button: ${JSON.stringify(h)}`).toBe(false);
  });

  // ── C2. 9.2.16 — the two phone rules that place the content, held as GEOMETRY
  //        (each survived every arm above when deleted: 9.2.15 mutations B1/B2).
  // The content's inset: 16 px from each viewport edge and 16 px under the section
  // bar. Without the phone rule the desktop padding (32 px 40 px) applies, which
  // the values below refuse by name.
  test("the admin content sits 16 px in from each edge of a phone screen and 16 px under the section bar", async ({ page }) => {
    await admin(page);
    for (const slug of ["competitions", "settings"]) {
      await openTab(page, slug);
      await page.evaluate(() => window.scrollTo(0, 0));
      const g = await page.evaluate((slug) => {
        const bar = document.getElementById("admin-mobile-menu-btn").getBoundingClientRect();
        const pane = document.getElementById(`admin-${slug}-tab`).getBoundingClientRect();
        return { left: Math.round(pane.left), right: Math.round(window.innerWidth - pane.right),
          belowBar: Math.round(pane.top - bar.bottom), barH: Math.round(bar.height), paneW: Math.round(pane.width) };
      }, slug);
      // PRECONDITIONS: the bar is there to be under, and the pane has a box.
      expect(g.barH, `${slug}: the section bar is rendered`).toBeGreaterThanOrEqual(44);
      expect(g.paneW, `${slug}: the pane is rendered`).toBeGreaterThan(200);
      // NEGATIVE CONTROL by value: the desktop inset (40 px sides, 32 px top) is not it.
      expect({ left: g.left, right: g.right, belowBar: g.belowBar }, `${slug}: the content's inset on a phone: ${JSON.stringify(g)}`)
        .toEqual({ left: 16, right: 16, belowBar: 16 });
    }
  });

  // The route-focused heading's landing: header bottom + 56 (the section bar's
  // height plus a margin), or 8 under a stuck strip if that is lower. The global
  // route-focus rule alone lands it 8 under the header; that value is refused.
  test("a route-focused heading reached from a scrolled pane lands 56 px under the header", async ({ page }) => {
    await admin(page);
    await openTab(page, "settings");
    // Press the next pane's sidebar item from the SCROLLED page, as a palette jump
    // or crossnav link does: opening the drawer first would scroll the in-flow
    // section bar (and so the page) back to the top, leaving nothing to land.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY), "precondition: the Settings pane scrolls").toBeGreaterThan(100);
    await page.evaluate(() => document.querySelector('.admin-nav-item[data-tab-id="admin-competitions-tab"]').click());
    await expect(page.locator("#admin-competitions-tab h2")).toBeFocused();
    // Settle: the focus scroll is synchronous, but read twice so a late layout cannot pass.
    const g = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const hb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")) || 0;
      const hdr = document.getElementById("app-header").getBoundingClientRect().bottom;
      const pg = document.getElementById("admin-page");
      const strip = parseFloat(pg.style.getPropertyValue("--strip-bottom")) || 0;
      const h = document.querySelector("#admin-competitions-tab h2").getBoundingClientRect();
      res({ hb, hdr: Math.round(hdr), strip, top: Math.round(h.top), scrollY: Math.round(window.scrollY),
        room: Math.round(document.documentElement.scrollHeight - window.innerHeight) });
    }))));
    // PRECONDITIONS: the header edge is published and is the header's, no strip
    // is stuck here, and the page scrolled (a heading already in view would not move).
    expect(Math.abs(g.hb - g.hdr), `--header-bottom is the header's edge: ${JSON.stringify(g)}`).toBeLessThanOrEqual(1);
    expect(g.strip, "no sticky strip outside a workspace").toBe(0);
    expect(g.scrollY, `the focus scrolled the page: ${JSON.stringify(g)}`).toBeGreaterThan(0);
    const expected = Math.max(Math.round(g.hb) + 56, g.strip + 8);
    // NEGATIVE CONTROL by value: where the global rule alone would land it.
    expect(Math.abs(g.top - (Math.round(g.hb) + 8)), `not 8 px under the header (the global rule): ${JSON.stringify(g)}`).toBeGreaterThan(20);
    expect(Math.abs(g.top - expected), `the heading lands at header + 56 (${expected}): ${JSON.stringify(g)}`).toBeLessThanOrEqual(1);
  });

  // ── D1. The open drawer and the button: nothing interactive under it, and the
  //        button BELOW the drawer (it only ever opens).
  test("with the drawer OPEN no nav item is under the button, and the button is beneath the drawer", async ({ browser }) => {
    const ctx = await touchCtx(browser, { width: 390, height: 844 });
    const page = await ctx.newPage();
    try {
      await admin(page);
      await openDrawerSettled(page);
      const g = await page.evaluate(() => {
        const btnEl = document.getElementById("admin-mobile-menu-btn");
        const b = btnEl.getBoundingClientRect();
        const items = [...document.querySelectorAll(".admin-nav-item")].filter((it) => {
          const r = it.getBoundingClientRect();
          return r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
        }).map((it) => it.textContent.trim());
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return {
          btnRendered: getComputedStyle(btnEl).display !== "none" && b.height >= 44,
          items, onTop: hit ? (hit.closest("#admin-mobile-menu-btn") ? "BUTTON" : hit.closest("#admin-sidebar") ? "DRAWER" : hit.id || hit.className || hit.tagName) : null,
        };
      });
      // CONTROL — the button is still rendered, so "nothing is under it" has a subject.
      expect(g.btnRendered, "the menu button must still be rendered while the drawer is open").toBe(true);
      expect(g.items, "nav items the menu button's box intersects").toEqual([]);
      expect(g.onTop, "the open drawer must paint ABOVE the menu button, not the other way round").toBe("DRAWER");
    } finally { await ctx.close(); }
  });

  // ── E. One ordinary open/close, and the re-activation paths that leaked.
  test("CONTROL: one open and close leaves Tab working", async ({ page }) => {
    await admin(page);
    await openDrawerSettled(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#admin-sidebar.mobile-open")).toHaveCount(0);
    const stops = await tabStops(page, 3);
    expect(stops.some((s) => s !== "admin-mobile-menu-btn"), `Tab is stuck: ${JSON.stringify(stops)}`).toBe(true);
  });

  // The section bar lies OUTSIDE the inert .admin-content, so it was the one
  // control behind the open (modal) drawer a screen reader's virtual cursor or a
  // programmatic focus could still reach. It is inert while the drawer is open
  // and released on EVERY exit: Escape, the scrim, a nav item, and widening.
  test("while the drawer is OPEN the section bar is inert and cannot take focus; every exit restores it", async ({ page }) => {
    await admin(page);
    const bar = page.locator("#admin-mobile-menu-btn");
    const barState = () => page.evaluate(() => {
      const b = document.getElementById("admin-mobile-menu-btn");
      // Can it TAKE focus: start from nothing focused, then ask.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      b.focus();
      return { inert: b.inert, focusable: document.activeElement === b };
    });
    // CONTROL — closed, the bar is an ordinary focusable button.
    expect(await barState(), "closed: the bar is live and takes focus").toEqual({ inert: false, focusable: true });
    const exits = {
      escape: async () => { await page.keyboard.press("Escape"); },
      scrim: async () => {
        // The scrim ignores presses inside the opening gesture's 500 ms window.
        await expect.poll(() => page.evaluate(() => Date.now() - (window.S._sidebarOpenedAt || 0)), { timeout: 5000 }).toBeGreaterThan(550);
        // A point on the scrim beside the drawer, asserted to BE the scrim.
        const pt = await page.evaluate(() => {
          const r = document.getElementById("admin-sidebar").getBoundingClientRect();
          const x = Math.round((r.right + window.innerWidth) / 2), y = Math.round(window.innerHeight / 2);
          const hit = document.elementFromPoint(x, y);
          return { x, y, scrim: !!(hit && hit.id === "admin-sidebar-overlay") };
        });
        expect(pt.scrim, `precondition: the point beside the drawer is the scrim: ${JSON.stringify(pt)}`).toBe(true);
        await page.mouse.click(pt.x, pt.y);
      },
      navItem: async () => { await page.locator('.admin-nav-item[data-tab-id="admin-tasks-tab"]').click(); },
    };
    for (const [name, exit] of Object.entries(exits)) {
      await openDrawerSettled(page);
      await expect.poll(() => page.evaluate(focusId), { timeout: 5000, message: `${name}: focus moves into the drawer` }).toMatch(/^DRAWER:/);
      const open = await barState();
      expect(open.inert, `${name}: the bar is inert while the drawer is open`).toBe(true);
      expect(open.focusable, `${name}: the bar cannot take focus while the drawer is open`).toBe(false);
      // Hand focus back into the drawer (the probe blurred it) before the exit.
      await page.locator("#admin-sidebar .admin-nav-item").first().focus();
      // CONTROL — inert, not hidden: the bar is still rendered under the drawer.
      await expect(bar, `${name}: the bar is still rendered`).toBeVisible();
      await exit();
      await expect(page.locator("#admin-sidebar.mobile-open")).toHaveCount(0);
      expect(await barState(), `${name}: the bar is live again after the drawer closes`).toEqual({ inert: false, focusable: true });
    }
    // The fourth exit: widening past the breakpoint with the drawer open.
    await openDrawerSettled(page);
    expect(await bar.evaluate((el) => el.inert), "precondition: inert while open").toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => page.evaluate(() => document.getElementById("admin-mobile-menu-btn").inert), { timeout: 5000 }).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
  });
});

// ── D2. A double-tap on the hamburger: the second tap lands on the drawer's brand
//        strip — not on the button (the leak) and not on a nav item (a navigation).
for (const [vp, gap] of [[{ width: 390, height: 844 }, 60], [{ width: 390, height: 844 }, 150], [{ width: 320, height: 568 }, 150], [{ width: 768, height: 1024 }, 150]]) {
  test(`a double-tap on the hamburger (${gap} ms apart) at ${vp.width}x${vp.height} keeps the drawer open on the same pane, and Tab then works`, async ({ browser }) => {
    const ctx = await touchCtx(browser, vp);
    const page = await ctx.newPage();
    try {
      await admin(page);
      const before = await paneState(page);
      expect(before.pane, "precondition: the Events pane is open").toBe("admin-competitions-tab");
      await armClickCounter(page);
      const bb = await page.locator("#admin-mobile-menu-btn").boundingBox();
      const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
      await page.touchscreen.tap(x, y);
      // The gap IS the gesture being modelled (an impatient double-tap), not a
      // wait for the app — the clicks are awaited through the counter below.
      await page.waitForTimeout(gap);
      await page.touchscreen.tap(x, y);
      await clicksSeen(page, 2);
      // Both clicks' handlers are synchronous, so the state is final once they
      // have been dispatched — read it BEFORE waiting on anything, so a drawer the
      // second tap closed is reported as that rather than as a settle timeout.
      const after = await paneState(page);
      expect(after.open, `the double-tap must leave the drawer OPEN: ${JSON.stringify(after)}`).toBe(true);
      expect(after.pane, `the second tap must not navigate anywhere: ${JSON.stringify(after)}`).toBe(before.pane);
      await drawerSettled(page);
      await page.keyboard.press("Escape");
      await expect(page.locator("#admin-sidebar.mobile-open")).toHaveCount(0);
      const stops = await tabStops(page, 3);
      expect(stops.some((s) => s !== "admin-mobile-menu-btn"), `Tab is stuck after a double-tap: ${JSON.stringify(stops)}`).toBe(true);
    } finally { await ctx.close(); }
  });
}

test.describe("a narrow DESKTOP window (700x900, mouse)", () => {
  test.use({ viewport: { width: 700, height: 900 } });

  test("a mouse double-click on the hamburger leaves the drawer open and leaks no trap", async ({ page }) => {
    // A HUMAN-paced double-click, not locator.dblclick(): Playwright fires both
    // clicks inside one frame (measured ~9 ms apart), before the drawer has
    // painted at all, so the second lands on the scrim and closes it — no leak,
    // but not a gesture a person can make (an OS double-click's second click
    // comes 80 ms or more after the first). At a human pace it lands on the
    // drawer's brand strip.
    await admin(page);
    await armClickCounter(page);
    const bb = await page.locator("#admin-mobile-menu-btn").boundingBox();
    const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
    await page.mouse.click(x, y);
    await page.waitForTimeout(120); // the gesture's own timing, not a wait for the app
    await page.mouse.click(x, y, { clickCount: 2 });
    await clicksSeen(page, 2);
    const st = await paneState(page);
    expect(st.open, `the double-click must leave the drawer OPEN: ${JSON.stringify(st)}`).toBe(true);
    expect(st.pane, `the second click must not navigate: ${JSON.stringify(st)}`).toBe("admin-competitions-tab");
    await drawerSettled(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#admin-sidebar.mobile-open")).toHaveCount(0);
    const stops = await tabStops(page, 4);
    expect(stops.some((s) => s !== "admin-mobile-menu-btn"), `Tab is stuck after a double-click: ${JSON.stringify(stops)}`).toBe(true);
  });

  test("with the drawer OPEN, forward Tab from outside it re-enters it (the trap's list is rendered elements only)", async ({ page }) => {
    // A click on the drawer's non-interactive brand drops focus OUT of the open
    // drawer (to #main-content, tabindex=-1). The trap then redirects Tab to its
    // first candidate — which was #admin-sidebar-toggle, display:none at this
    // width, so focus went nowhere and stayed there for as many Tabs as pressed.
    await admin(page);
    await openDrawerSettled(page);
    const bb = await page.locator("#admin-panel-title").boundingBox();
    await page.mouse.click(bb.x + bb.width - 10, bb.y + bb.height / 2);
    const outside = await page.evaluate(focusId);
    expect(outside.startsWith("DRAWER:"), `precondition: the click must move focus OUT of the drawer (got ${outside})`).toBe(false);
    expect(await drawerIsOpen(page), "precondition: clicking the brand must not close the drawer").toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(focusId), "forward Tab must come back INTO the open drawer").toMatch(/^DRAWER:/);
    // The hamburger (section bar) is inert while the drawer is open, so it can
    // never hold focus outside the drawer to begin with.
    const took = await page.locator("#admin-mobile-menu-btn").evaluate((el) => { el.focus(); return document.activeElement === el; });
    expect(took, "the inert section bar must not take focus while the drawer is open").toBe(false);
  });

  test("a leaked trap cannot survive widening past 768px: Tab reaches the content", async ({ page }) => {
    // The orphaned trap's worst outcome: once the window is wide the sidebar is
    // no longer inert and its toggle is displayed, so the orphan confined Tab to
    // the sidebar (measured: 12 of 12 stops). The idempotent open is what stops
    // the orphan being made; the rendered-only trap list cannot help here, since
    // on desktop every sidebar control IS rendered.
    await admin(page);
    await page.locator("#admin-mobile-menu-btn").click();
    await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
    // The second activation — the assistive-technology path, which neither the
    // strip nor the z-index can intercept.
    await page.locator("#admin-mobile-menu-btn").evaluate((el) => el.click());
    expect(await drawerIsOpen(page), "precondition: the drawer is open across both activations").toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#admin-sidebar.mobile-open")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => page.evaluate(() => matchMedia("(max-width:768px)").matches)).toBe(false);
    await page.locator("#admin-competitions-tab h2").evaluate((el) => el.focus());
    const stops = [];
    // Enough presses to walk every sidebar stop (its items plus the toggle) and
    // then some, so a trapped Tab shows as a full cycle and a free one escapes.
    const tabBudget = (await page.locator("#admin-sidebar .admin-nav-item").count()) + 4;
    for (let i = 0; i < tabBudget; i++) {
      await page.keyboard.press("Tab");
      stops.push(await page.evaluate(() => {
        const a = document.activeElement;
        return (a.closest(".admin-content") ? "CONTENT:" : a.closest("#admin-sidebar") ? "SIDEBAR:" : "") + (a.id || a.getAttribute("data-action") || a.tagName);
      }));
    }
    expect(stops.some((s) => s.startsWith("CONTENT:")), `Tab never reached the content after widening: ${JSON.stringify(stops)}`).toBe(true);
  });
});

test.describe("drawer lifecycle at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const drawerOpen of [false, true]) {
    test(`${drawerOpen ? "leaving the admin page with the drawer OPEN" : "CONTROL: leaving the admin page with the drawer closed"} leaves Tab working, and the admin view comes back closed`, async ({ page }) => {
      // The header's "Participant View" is outside the inert content AND outside
      // the drawer, so a screen reader's virtual cursor reaches it while the drawer
      // is open. Leaving the admin page that way bypassed the drawer's close: its
      // modality survived over a now-hidden drawer, and switching back to the admin
      // view found the drawer still open over inert content.
      await userBackedAdmin(page);
      if (drawerOpen) await openDrawerSettled(page);
      // The account button sits in the header, outside the inert content and the
      // drawer, so the virtual cursor reaches it with the drawer open; its menu's
      // view item is the way out.
      await page.locator('#profile-menu-btn').evaluate((el) => el.click());
      await page.locator('#profile-menu-overlay [data-action="toggle-admin-view"]').evaluate((el) => el.click());
      await page.locator("#competitions-page.active").waitFor({ state: "attached", timeout: 15000 });
      await expect(page.locator("#admin-page")).toBeHidden();
      const stops = await tabStops(page, 3);
      expect(new Set(stops).size, `Tab does not move in the participant app: ${JSON.stringify(stops)}`).toBeGreaterThan(1);
      // …and back: the admin view must not return with a stale open drawer. The
      // way up is the account menu's view item, on a phone as everywhere.
      await page.locator('#profile-menu-btn').click();
      await page.locator('#profile-menu-overlay [data-action="toggle-admin-view"]').click();
      await waitForAdminPage(page);
      const back = await page.evaluate(() => ({
        open: document.getElementById("admin-sidebar").classList.contains("mobile-open"),
        scrim: getComputedStyle(document.getElementById("admin-sidebar-overlay")).display,
        contentInert: document.querySelector(".admin-content").inert,
      }));
      expect(back, "the admin view came back with the drawer's modality still installed").toEqual({ open: false, scrim: "none", contentInert: false });
    });
  }

  for (const drawerOpen of [false, true]) {
    test(`${drawerOpen ? "rotating past 768px with the drawer OPEN" : "CONTROL: rotating past 768px with the drawer closed"} — the first tap on the sidebar navigates`, async ({ browser }) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      try {
        await admin(page);
        if (drawerOpen) await openDrawerSettled(page);
        await page.setViewportSize({ width: 844, height: 390 });
        await expect.poll(() => page.evaluate(() => matchMedia("(max-width:768px)").matches)).toBe(false);
        const box = await page.locator('.admin-nav-item[data-tab-id="admin-tasks-tab"]').boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.locator("#admin-tasks-tab"), "the tap must reach the sidebar, not a scrim left over from the phone drawer").toBeVisible({ timeout: 5000 });
      } finally { await ctx.close(); }
    });
  }
});

test.describe("at 320x568", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("CONTROL: the drawer strip costs no reach — every item in the open drawer is reachable, the last by scrolling", async ({ page }) => {
    // Hanging the drawer from the header and reserving its brand strip shortens
    // the item list; on the smallest phone the ninth item needs a scroll inside
    // the list (overflow-y:auto). Reachable is the property, not "on screen at rest".
    await admin(page);
    await openDrawerSettled(page);
    const unreachable = [];
    const n = await page.locator(".admin-nav-item").count();
    // Every item the shell declares must render for this superadmin, and there
    // must be enough of them that the smallest phone needs a scroll at all.
    const declared = (require("fs").readFileSync(require("path").join(__dirname, "..", "public", "index.html"), "utf8").match(/class="admin-nav-item[\s"]/g) || []).length;
    expect(declared, "the shell declares the sidebar items").toBeGreaterThanOrEqual(10);
    expect(n, "the fixture must render every sidebar item the shell declares").toBe(declared);
    for (let i = 0; i < n; i++) {
      const it = page.locator(".admin-nav-item").nth(i);
      await it.scrollIntoViewIfNeeded();
      const ok = await it.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(h && h.closest(".admin-nav-item") === el) && r.bottom <= innerHeight;
      });
      if (!ok) unreachable.push(await it.getAttribute("data-tab-id"));
    }
    expect(unreachable, "nav items the open drawer cannot bring on screen").toEqual([]);
    await page.locator('.admin-nav-item[data-tab-id="admin-settings-tab"]').click();
    await expect(page.locator("#admin-settings-tab"), "the ninth item must still navigate").toBeVisible({ timeout: 10000 });
  });
});

// ── F. The desktop layout is untouched.
test.describe("CONTROL at 1280x800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("the button is hidden and the desktop content padding is untouched", async ({ page }) => {
    await admin(page);
    await expect(page.locator("#admin-mobile-menu-btn")).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".admin-content")).paddingTop)).toBe("32px");
  });

  // The shared trap's contract, driven directly: its candidate list is RENDERED,
  // non-inert elements only, and with none of its own it stands aside. Every
  // arm above reaches this through the drawer, where the guard and the closes
  // now make a trap with nothing to hold unreachable — so without this the
  // stand-aside rule, and the inert half of the filter, would be held by nothing.
  test("the shared focus trap holds only rendered, non-inert controls, and stands aside when it has none", async ({ page }) => {
    await admin(page);
    const tabFrom = (shape) => page.evaluate(async (shape) => {
      document.getElementById("f6-probe")?.remove();
      const ov = document.createElement("div");
      ov.id = "f6-probe";
      const btn = document.createElement("button");
      btn.id = "f6-inner"; btn.textContent = "inner";
      if (shape === "display-none") btn.style.display = "none";
      if (shape === "inert") ov.inert = true;
      ov.appendChild(btn);
      document.body.appendChild(ov);
      const remove = window.installOverlayFocusTrap(ov);
      document.getElementById("comp-search").focus();
      return new Promise((resolve) => {
        // Read the landing spot on the NEXT task, after the browser's own Tab
        // handling (if the trap stood aside) has moved focus.
        const onKey = () => setTimeout(() => {
          const a = document.activeElement;
          document.removeEventListener("keyup", onKey, true);
          try { remove && remove(); } catch (_) {}
          ov.remove();
          resolve(a ? (a.id || a.getAttribute("data-action") || a.tagName) : null);
        }, 0);
        document.addEventListener("keyup", onKey, true);
      });
    }, shape);
    const landed = async (shape) => {
      const p = tabFrom(shape);
      await expect.poll(() => page.evaluate(() => !!document.getElementById("f6-probe"))).toBe(true);
      await page.keyboard.press("Tab");
      return p;
    };
    // CONTROL — a trap with something rendered of its own still traps.
    expect(await landed("rendered"), "a trap with a rendered control must still take Tab into it").toBe("f6-inner");
    for (const shape of ["display-none", "inert"]) {
      const got = await landed(shape);
      expect(got, `a trap whose only control is ${shape} must stand aside, not pin Tab`).not.toBe("comp-search");
      expect(got, `a trap whose only control is ${shape} must not focus it`).not.toBe("f6-inner");
    }
  });
});
