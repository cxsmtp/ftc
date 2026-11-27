// @ts-check
// Cross-browser + mobile-viewport smoke.
//
// Runs on every project when CROSS_BROWSER=1 is set. Non-Chromium projects
// in playwright.config.js use `testMatch: /cross-browser\.spec\.js$/` so they
// ONLY pick up this file — the other ~280 tests stay on Chromium. The goal
// is to catch the categories of bugs that actually diverge between engines:
//
//   • CSP / Trusted Types enforcement differences (Chromium enforces
//     require-trusted-types-for; Safari + Firefox ignore it — the page must
//     still render without throwing the TT-violation error either way).
//   • Mobile viewport chrome: 100dvh vs 100vh, env(safe-area-inset-bottom).
//     This locks in the v6.2.2 Help-drawer bottom-cutoff fix on Android
//     Chrome, iOS Safari, and mobile Firefox.
//   • Fetch / session / CSRF basics on a non-Chromium engine.
//
// The smoke is deliberately anonymous (no login) and read-only — so it can
// hit the same per-worker server as the rest of the suite without mutating
// the seeded state. See README § Cross-browser testing for how to run.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, getSuperadminPass, PARTICIPANT_PASS, settleThroughRenderStall, gotoThroughRenderStall, pressThroughRenderStall, apiLogin, freshCtx, TEST_DB_PATH, codeLogin, awaitUploadRoom } = require("./helpers");

test.use({ baseURL: BASE });

// Log `page` in via its own request context (shares the cookie jar with
// page.goto), tolerant of a superadmin password rotation landing mid-call.
// Read-only: the authed smokes below never mutate seeded state, so they're
// safe on the shared per-worker server alongside the rest of the suite.
async function pageLogin(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  let r = await doPost(password);
  if (!r.ok() && email === "superadmin") r = await doPost(getSuperadminPass());
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy();
}

// Assert a control a user must act on to reach the next step is genuinely
// REACHABLE — not merely attached/`toBeVisible()` (which passes for an element
// scrolled off-screen or transformed out of view). Three layers:
//   1. visible (in DOM, not display:none / visibility:hidden, non-zero box)
//   2. scrolled into view, then a trial click → Playwright's full actionability
//      (stable + receives pointer events AT ITS CENTRE + enabled) WITHOUT
//      activating it — catches occlusion + zero-size the bare assertion misses.
//   3. its box actually sits within the viewport after scrolling — an affordance
//      pushed off the visible area (the classic mobile failure) is not reachable.
// v7.23.0 — the containment reference is the LAYOUT viewport, not
// page.viewportSize().
//
// `page.viewportSize()` returns the number Playwright was CONFIGURED with. Under
// Chromium's mobile emulation (`isMobile: true`) that is not necessarily the
// viewport the page lays out against. Measured on `Galaxy S24 landscape`:
// viewportSize() = 780x360 while `window.innerWidth` = 860. Every CSS length,
// every media query and every rect the user can actually see is relative to 860.
//
// This surfaced the moment the phone-landscape projects were added in v7.23.0:
// `.selection-bar` is correctly pinned `left:8px;right:8px`, so it spans 8->852
// — inside the real 860px viewport, but 70px "off-screen" against the stale 780.
// The product was right and the assertion was wrong. Reading it from the page
// also makes the check honest on any future device profile without a table of
// per-device corrections.
async function layoutViewport(page) {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function assertReachable(page, locator, label) {
  await expect(locator, `${label}: not visible`).toBeVisible();
  const ceiling = test.info().project.use.actionTimeout;
  expect(typeof ceiling, "the settle wait is bounded by the project's actionTimeout").toBe("number");
  const settled = await settleThroughRenderStall(locator, label, ceiling);
  expect(settled.ok, `${label}: the page never settled — ${settled.frames} frame(s) painted in ${settled.ms} ms; still animating: ${JSON.stringify(settled.pending)}`).toBe(true);
  // The trial click scrolls the element into view AND runs full actionability,
  // both bounded by its own timeout — so a transient engine scroll hang (seen on
  // Firefox under load) fails fast + retries instead of burning the 60s test
  // timeout on a separate, un-timeout-able scrollIntoViewIfNeeded(). Through a
  // WebKit rendering stall too (helpers.js pressThroughRenderStall).
  await pressThroughRenderStall(locator, label, "trial", 8000);
  const box = await locator.boundingBox();
  expect(box, `${label}: no layout box`).not.toBeNull();
  const vp = await layoutViewport(page);
  const slack = 2;
  expect(
    box.x >= -slack && box.y >= -slack &&
    box.x + box.width <= vp.width + slack && box.y + box.height <= vp.height + slack,
    `${label}: off-viewport box=${JSON.stringify(box)} vp=${vp.width}x${vp.height}`,
  ).toBe(true);
}

// Navigate to an admin tab on any viewport. On mobile (≤768px) the sidebar is an
// off-canvas drawer, so the hamburger must be opened first (idempotent — only if
// the drawer isn't already `mobile-open`). adminTab() auto-closes the drawer.
//
// WAIT FOR THE ADMIN SHELL, THEN OPEN THE DRAWER, THEN SEE IT OPEN.
// The callers' settle signal, `#admin-sidebar` attached, is static markup: it
// holds the moment page.goto() returns, while boot() is still three round trips
// (csrf-token + config, /api/me, /api/admin/me) short of buildAdminNav +
// showMain('admin-page'). The hamburger was then read ONCE with isVisible(),
// which is point-in-time and does not wait, and a false SKIPPED the click. In
// the CI image the page shows ~20 ms after goto() returns and that read lands
// ~50 ms later, so a runner answering those round trips ~50 ms slower read
// false, never opened the drawer, and the nav-item click spent its 20 s on
// "element is outside of the viewport": the closed drawer is translateX(-100%).
// `#admin-page` visible is the ready signal, and buildAdminNav wires the
// hamburger before showMain shows the page, so the click has its handler. The
// drawer state is then asserted rather than assumed, so a click that did not
// open it fails here by name instead of as a viewport timeout one step later.
async function openAdminTab(page, tabId) {
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  // v7.23.0 — ask the PAGE whether the drawer rule is in force rather than
  // comparing a configured number: the off-canvas sidebar is driven by
  // `@media(max-width:768px)`, and under mobile emulation page.viewportSize()
  // can differ from the width that media query actually evaluates against
  // (measured 780 vs 860 on Galaxy S24 landscape). matchMedia is the authority.
  const isDrawer = await page.evaluate(() => matchMedia("(max-width:768px)").matches);
  if (isDrawer && !(await page.locator("#admin-sidebar.mobile-open").count())) {
    await pressThroughRenderStall(page.locator("#admin-mobile-menu-btn"), "the admin menu button", "click", 20000);
    await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
  }
  await pressThroughRenderStall(page.locator(`.admin-nav-item[data-tab-id="${tabId}"]`), `${tabId} in the sidebar`, "click", 20000);
  await page.locator(`#${tabId}`).waitFor({ state: "visible", timeout: 15000 });
}

test.describe("cross-browser smoke", () => {
  test("home page loads with no CSP or Trusted-Types violations", async ({ page, browserName }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const t = msg.text();
        // Filter out benign network errors (e.g. favicon on mobile Safari)
        // and keep only violation-class messages we actually care about.
        if (/trusted.?type|csp|content security policy|violation/i.test(t)) errors.push(t);
      }
    });

    await gotoThroughRenderStall(page, "/");
    await page.waitForSelector("#login-email", { timeout: 15000 });

    // The login form should be interactive (not stuck behind a TT error)
    await expect(page.locator("#login-email")).toBeVisible();
    await expect(page.locator("#login-submit").first()).toBeVisible();

    if (errors.length) {
      throw new Error(`[${browserName}] unexpected violations: ${errors.join(" | ")}`);
    }
  });

  test("help drawer opens and markdown renders across engines", async ({ page, browserName }) => {
    await gotoThroughRenderStall(page, "/");
    await page.waitForSelector("#help-icon-btn", { timeout: 15000 });
    await pressThroughRenderStall(page.locator("#help-icon-btn"), `[${browserName}] Help`, "click", 20000);

    // Drawer visible
    const body = page.locator("#help-drawer-body");
    await body.waitFor({ state: "visible", timeout: 10000 });

    // At least one markdown element rendered (h1 or p)
    const hasContent = await body.locator("h1, p").first().isVisible();
    expect(hasContent, `[${browserName}] help drawer rendered no markdown`).toBe(true);
  });

  test("help drawer bottom is not clipped on mobile viewport (regression for v6.2.2)", async ({ page, browserName, viewport }) => {
    // This test is the one that actually exercises the 100dvh +
    // env(safe-area-inset-bottom) fix. On desktop it degenerates to a
    // trivial "last element is in the viewport" check; on mobile-chrome
    // (Pixel 7) and mobile-webkit (iPhone 14) it exercises the same
    // collapsing-URL-bar path that the user hit on Android Chrome.
    await gotoThroughRenderStall(page, "/");
    await page.waitForSelector("#help-icon-btn", { timeout: 15000 });
    await pressThroughRenderStall(page.locator("#help-icon-btn"), `[${browserName}] Help`, "click", 20000);

    const body = page.locator("#help-drawer-body");
    await body.waitFor({ state: "visible", timeout: 10000 });

    // Scroll the drawer to its bottom, then assert the last child element
    // is fully within the drawer's own client rect — if 100vh were used
    // instead of 100dvh, or safe-area padding missing, the last element
    // would extend past the visible area on mobile.
    const clipped = await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      const last = el.lastElementChild;
      if (!last) return { error: "no children" };
      const drawerRect = el.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return {
        lastBottom: lastRect.bottom,
        drawerBottom: drawerRect.bottom,
        viewportH: window.innerHeight,
        // 2px slack for sub-pixel rounding
        clipped: lastRect.bottom > drawerRect.bottom + 2,
        // The drawer itself must not extend past the visible viewport —
        // that's the failure mode the user reported on Android Chrome.
        drawerOverflows: drawerRect.bottom > window.innerHeight + 2,
      };
    });

    expect(clipped.error, `[${browserName}] ${clipped.error || ""}`).toBeUndefined();
    expect(clipped.clipped, `[${browserName} ${viewport?.width}x${viewport?.height}] last drawer child bottom=${clipped.lastBottom} > drawer bottom=${clipped.drawerBottom}`).toBe(false);
    expect(clipped.drawerOverflows, `[${browserName} ${viewport?.width}x${viewport?.height}] drawer bottom=${clipped.drawerBottom} > viewport=${clipped.viewportH}`).toBe(false);
  });

  test("v6.9.22: register page loads + first-field is keyboard-focusable on every engine", async ({ page, browserName }) => {
    // The dedicated /register route (v6.9.10) must land on the form
    // across engines. Explicit anchor for the v6.9.10/v6.9.11 popstate
    // fixes — both are chromium-first-designed; WebKit + Firefox's
    // popstate semantics can diverge on fragment navigations.
    //
    // Email first: /register is the email step (the form opens only once a
    // code proves an address with no account), so the route must land on the
    // entry card, and the real door — Continue, the code — must open the form.
    await gotoThroughRenderStall(page, "/register");
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 10000 });
    const { signUpViaUi } = require("./ui-admin-helpers");
    await signUpViaUi(page, `xb-reg-${browserName}-${Date.now().toString(36)}@company.example`, {}, { submit: false });
    const first = page.locator("#reg-first");
    await first.waitFor({ state: "visible", timeout: 10000 });
    // Tab into the form; focus should land on an input in the dialog.
    await page.keyboard.press("Tab");
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName || "");
    expect(["INPUT", "BUTTON", "A", "SELECT"], `[${browserName}] focused <${focusedTag}>`).toContain(focusedTag);
  });

  test("v6.9.22: focus-trap keeps Tab inside an open modal on every engine", async ({ page, browserName }) => {
    // overlayDismiss + installOverlayFocusTrap are chromium-first.
    // Verify the behaviour on Firefox + WebKit: opening the help
    // drawer traps focus inside the overlay — pressing Tab ~10 times
    // should never land focus on an element outside the overlay.
    await gotoThroughRenderStall(page, "/");
    await page.waitForSelector("#help-icon-btn", { timeout: 15000 });
    await pressThroughRenderStall(page.locator("#help-icon-btn"), `[${browserName}] Help`, "click", 20000);
    await page.locator("#help-drawer-body").waitFor({ state: "visible", timeout: 10000 });
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const insideOverlay = await page.evaluate(() => {
        const overlay = document.getElementById("help-drawer-overlay");
        return !!(overlay && document.activeElement && overlay.contains(document.activeElement));
      });
      expect(insideOverlay, `[${browserName}] Tab #${i+1} escaped the help drawer focus trap`).toBe(true);
    }
  });

  test("CSRF token endpoint works via fetch", async ({ page, browserName }) => {
    // Ensures fetch() + cookies work the same way on Firefox/WebKit as on
    // Chromium — a cheap proof that the login flow would work.
    await gotoThroughRenderStall(page, "/");
    const csrf = await page.evaluate(async () => {
      const r = await fetch("/api/csrf-token", { credentials: "same-origin" });
      const d = await r.json();
      return d.csrfToken;
    });
    expect(csrf, `[${browserName}] empty CSRF token`).toBeTruthy();
    expect(typeof csrf).toBe("string");
    expect(csrf.length).toBeGreaterThan(10);
  });

  // v6.20.x — authenticated smoke. The anonymous tests above prove the login
  // form renders; these prove the post-login JS chain (the riskiest
  // engine-divergence surface — dynamic Trusted-Types innerHTML, ECharts,
  // overlay focus management) actually runs on Firefox/WebKit, not just
  // Chromium. Read-only: log in as a seeded user, render, assert, no writes.
  test("participant can log in and the SPA shell renders across engines", async ({ page, browserName }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" && /trusted.?type|csp|content security policy|violation/i.test(msg.text())) errors.push(msg.text());
    });
    await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);
    await gotoThroughRenderStall(page, "/");
    // Post-login: the main nav renders (the SPA bootstrapped past the login gate).
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator(".nav-btn").first()).toBeVisible();
    expect(errors, `[${browserName}] post-login violations: ${errors.join(" | ")}`).toHaveLength(0);
  });

  test("admin can log in and the sidebar + a data tab render across engines", async ({ page, browserName }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" && /trusted.?type|csp|content security policy|violation/i.test(msg.text())) errors.push(msg.text());
    });
    await pageLogin(page, "superadmin");
    await gotoThroughRenderStall(page, "/");
    // buildAdminNav + showMain('admin-page') + the default loaders must run.
    await page.locator("#admin-sidebar").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator(".admin-nav-item").first()).toBeVisible();
    // The default Competitions pane is visible (a data loader ran without TT/CSP error).
    await expect(page.locator("#admin-competitions-tab")).toBeVisible({ timeout: 10000 });
    expect(errors, `[${browserName}] post-login admin violations: ${errors.join(" | ")}`).toHaveLength(0);

    // audit v7.23.7 — the closed mobile drawer must hold no tab stops, checked on
    // EVERY engine because `inert` is the mechanism and its support is exactly
    // the kind of thing that diverges between them. The chromium-only lock in
    // dark-theme-a11y.spec.js cannot answer that question.
    //
    // This assertion also pins the reason `inert` was chosen over
    // `visibility:hidden`: the waitFor above requires #admin-sidebar to be
    // VISIBLE, and any CSS that removes an element from the tab order removes it
    // from Playwright's visibility too. The two assertions together are only
    // satisfiable by an attribute that is invisible to CSS.
    const drawer = await page.evaluate(() => {
      const sb = document.getElementById("admin-sidebar");
      const isDrawer = window.matchMedia("(max-width:768px)").matches;
      const items = [...sb.querySelectorAll("button,a,input,select,textarea,[tabindex]")];
      const tabbable = items.filter((el) => {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        if (el.closest("[inert]") || el.hasAttribute("disabled")) return false;
        return el.tabIndex >= 0;
      });
      return { isDrawer, open: sb.classList.contains("mobile-open"),
               total: items.length, tabbable: tabbable.length };
    });
    expect(drawer.total, `[${browserName}] the sidebar must have focusable items, or this is vacuous`)
      .toBeGreaterThan(3);
    if (drawer.isDrawer && !drawer.open) {
      expect(drawer.tabbable,
        `[${browserName}] the CLOSED off-screen drawer still holds ${drawer.tabbable} tab stops — `
        + "inert is not taking effect on this engine").toBe(0);
    } else {
      // Desktop: the sidebar is permanently on-screen and must stay reachable.
      expect(drawer.tabbable, `[${browserName}] the desktop sidebar must be reachable`)
        .toBeGreaterThan(3);
    }
  });

  // ── Navigation-reachability across engines + viewports (v7.7.x) ─────────────
  // The smokes above prove anchors render; these prove the controls a user must
  // TAP to reach the next step are actually on-screen and clickable (not just
  // toBeVisible()) on every engine and every mobile/tablet form factor.

  test("login-screen entry controls are reachable + clickable on every engine", async ({ page, browserName }) => {
    await gotoThroughRenderStall(page, "/");
    await page.waitForSelector("#login-email", { timeout: 15000 });
    await assertReachable(page, page.locator("[data-action='do-login']"), `[${browserName}] Continue`);
    await assertReachable(page, page.locator("#login-event-code-link"), `[${browserName}] Have an event code?`);
    // The break-glass username is typed on the card itself: anything that is not
    // an address opens the password step (no special page any more).
    await page.fill("#login-email", "superadmin");
    await pressThroughRenderStall(page.locator("#login-submit"), `[${browserName}] Continue (break-glass name)`, "click", 20000);
    await assertReachable(page, page.locator("#login-password"), `[${browserName}] Password box (break-glass name)`);
  });

  test("participant nav controls are reachable + clickable on every engine", async ({ page, browserName }) => {
    await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);

    // v7.19.1 — ESTABLISH the precondition instead of inheriting it.
    //
    // #nav-challenges and #nav-leaderboard ship as `display:none` and are
    // revealed by updateParticipantNav() only when the SELECTED competition is
    // live or ended. Alice's selection is shared mutable state: the seed points
    // her at "Test Live", but timeslots-lifecycle and ui-participant both
    // re-point her at other competitions, so this test inherited whatever the
    // last spec on the worker happened to leave. Land on an UPCOMING one and
    // those two buttons are legitimately hidden — nothing is broken and the
    // test fails anyway.
    //
    // v7.17.3 read that as a race and waited for the nav to settle. It is not a
    // race: the nav had settled, into a state with no Challenges tab, and the
    // wait simply burned its 20s. CI showed it plainly — 43 polls, "hidden"
    // every time. It stayed green locally at WORKERS=8 and failed at CI's 4
    // for the usual reason: fewer workers means more spec files per worker.
    const live = await (await page.request.get("/api/my-competitions")).json();
    const liveComp = (live.competitions || live || []).find((c) => c.status === "live");
    expect(liveComp, `[${browserName}] alice must have a LIVE competition for the full nav to exist`).toBeTruthy();
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    expect(sel.ok(), `[${browserName}] select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();

    await gotoThroughRenderStall(page, "/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });
    // #main-nav becomes visible at showMain(), which is EARLIER than the status
    // resolution that reveals these two — so still wait for the settled nav
    // before iterating. With the precondition established this is now a genuine
    // wait rather than a hope.
    await expect(page.locator("#nav-challenges:not([aria-disabled=true])"), `[${browserName}] participant nav never settled — challenges tab not revealed`).toBeVisible({ timeout: 20000 });
    const navBtns = page.locator("#main-nav .nav-btn");
    const n = await navBtns.count();
    expect(n, `[${browserName}] no participant nav buttons rendered`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await assertReachable(page, navBtns.nth(i), `[${browserName}] participant nav-btn #${i}`);
    }
  });

  test("admin navigation incl. the mobile drawer is reachable on every engine", async ({ page, browserName }) => {
    await pageLogin(page, "superadmin");
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    const vp = await layoutViewport(page);
    if (vp.width <= 768) {
      // On mobile the sidebar is an off-canvas drawer — the hamburger is the
      // ONLY way in, so it must be reachable and opening it must bring the nav
      // on-screen. (The plain admin smoke above asserts #admin-sidebar
      // toBeVisible(), which passes even while it's transformed off-screen.)
      const burger = page.locator("#admin-mobile-menu-btn");
      await assertReachable(page, burger, `[${browserName}] admin hamburger`);
      await pressThroughRenderStall(burger, `[${browserName}] admin hamburger`, "click", 20000);
      await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
    }
    // Every sidebar nav item must be reachable (on mobile: inside the open drawer).
    const items = page.locator(".admin-nav-item");
    const n = await items.count();
    expect(n, `[${browserName}] no admin nav items`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await assertReachable(page, items.nth(i), `[${browserName}] admin nav item #${i}`);
    }
    // …and navigating to a non-default tab actually renders its pane (the drawer
    // is already open on mobile; the sidebar is visible on desktop).
    await pressThroughRenderStall(page.locator(".admin-nav-item[data-tab-id='admin-participants-tab']"), `[${browserName}] Participants in the sidebar`, "click", 20000);
    await expect(page.locator("#admin-participants-tab")).toBeVisible({ timeout: 15000 });
  });

  test("admin row kebab menus are reachable + fully on-screen in every viewport (mobile focus)", async ({ page, browserName }) => {
    // At ≤768px the inline row-action buttons are hidden (.task-actions /
    // .comp-actions → display:none), so the ⋮ kebab is the ONLY path to row
    // actions. Its trigger must be reachable in the wide horizontally-scrolling
    // table, and the portal menu (rendered on document.body) must position
    // FULLY within the viewport — not hang off the bottom/right edge where its
    // actions become untappable.
    await pageLogin(page, "superadmin");
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    const vp = await layoutViewport(page);
    const slack = 2;
    // Competitions (default), Challenges, Participants — the three kebab lists.
    for (const tab of ["admin-competitions-tab", "admin-tasks-tab", "admin-participants-tab"]) {
      await openAdminTab(page, tab);
      const kebab = page.locator(`#${tab} .kebab-btn`).first();
      await kebab.waitFor({ state: "visible", timeout: 15000 });
      // 1) The trigger is reachable (scrolls into the wide table, clickable).
      await assertReachable(page, kebab, `[${browserName}] ${tab} kebab trigger`);
      // 2) Open it → the menu portals to #kebab-portal on document.body.
      await pressThroughRenderStall(kebab, `[${browserName}] ${tab} kebab trigger`, "click", 20000);
      const portal = page.locator("#kebab-portal");
      await portal.waitFor({ state: "visible", timeout: 5000 });
      // 3) The opened menu sits fully within the viewport (the core mobile risk).
      const box = await portal.boundingBox();
      expect(box, `[${browserName}] ${tab} kebab portal has no box`).not.toBeNull();
      expect(box.x, `[${browserName}] ${tab} kebab menu off LEFT edge`).toBeGreaterThanOrEqual(-slack);
      expect(box.y, `[${browserName}] ${tab} kebab menu off TOP edge`).toBeGreaterThanOrEqual(-slack);
      expect(box.x + box.width, `[${browserName}] ${tab} kebab menu off RIGHT edge (vw=${vp.width})`).toBeLessThanOrEqual(vp.width + slack);
      expect(box.y + box.height, `[${browserName}] ${tab} kebab menu off BOTTOM edge (vh=${vp.height})`).toBeLessThanOrEqual(vp.height + slack);
      // 4) At least one action inside the menu is reachable + clickable.
      await assertReachable(page, portal.locator("[role='menuitem'], button").first(), `[${browserName}] ${tab} kebab first action`);
      // Close (read-only — never activate a destructive action).
      await page.keyboard.press("Escape");
      await portal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
  });

  test("v7.12.0: challenges bulk-select checkbox + sticky selection bar reachable + on-screen in every viewport", async ({ page, browserName }) => {
    // The bulk-assign affordance must be operable on mobile: the leading row
    // checkbox (in the wide horizontally-scrolling table) and, once something is
    // selected, the sticky bottom selection bar + its button — fully within the
    // viewport, not hanging off an edge where they become untappable.
    await pageLogin(page, "superadmin");
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    await openAdminTab(page, "admin-tasks-tab");
    const box = page.locator("#admin-task-body input[type=checkbox]").first(); // seed has published challenges
    await box.waitFor({ state: "visible", timeout: 15000 });
    await assertReachable(page, page.locator("#select-all-challenges"), `[${browserName}] challenges select-all`);
    await assertReachable(page, box, `[${browserName}] challenges row checkbox`);
    await pressThroughRenderStall(box, `[${browserName}] challenges row checkbox`, "click", 20000);
    await expect(box).toBeChecked();
    const bar = page.locator("#challenges-selection-bar");
    await expect(bar).toBeVisible();
    const vp = await layoutViewport(page); const slack = 2;
    const bb = await bar.boundingBox();
    expect(bb, `[${browserName}] selection bar has no box`).not.toBeNull();
    expect(bb.x, `[${browserName}] selection bar off LEFT`).toBeGreaterThanOrEqual(-slack);
    expect(bb.x + bb.width, `[${browserName}] selection bar off RIGHT (vw=${vp.width})`).toBeLessThanOrEqual(vp.width + slack);

    // v7.17.3 — BOTTOM containment is asserted only where the design actually
    // promises it, and the promise is read from the element rather than
    // re-derived from the breakpoints (which would silently drift if they move).
    //
    // `.selection-bar` is `position:fixed` on phones and coarse-pointer devices
    // — the v7.12.3 fix — and there it is pinned to the viewport by definition.
    // On DESKTOP it is `position:sticky;bottom:0` inside `.admin-content`, whose
    // `overflow-y:auto` never gets a bounded height, so its scrollport bottom IS
    // its content bottom: the bar sits at the natural end of the pane and is
    // below the fold whenever the list is long. That is the documented desktop
    // design, not a defect — v7.12.1 added the TOP button precisely as "the
    // primary affordance when the sticky bottom bar has scrolled below a tall
    // list", and that button is asserted on-screen below.
    //
    // Asserting viewport containment on desktop therefore encoded a hidden
    // dependency on ROW COUNT: it held on a fresh seed (5 rows → bar at y=773 of
    // 800) and failed once a worker DB had accumulated challenges (30 rows → bar
    // at y=1011). It passed locally and failed in CI for that reason alone.
    //
    // The expectation is derived from the DEVICE, never from the bar's own
    // computed style. Reading `position` off the element and only checking
    // containment when it says "fixed" is the tempting version and it is
    // VACUOUS: deleting `position:fixed` from the CSS — the actual v7.12.3
    // regression this guards — would make the test stop checking rather than
    // fail. (Written that way first, and the mutation passed.) So assert which
    // position the device is entitled to, THEN assert containment.
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    const expectFixed = vp.width <= 600 || coarse;   // mirrors the two @media blocks
    if (expectFixed) {
      await expect(bar, `[${browserName}] touch/phone selection bar must be position:fixed (v7.12.3)`).toHaveCSS("position", "fixed");
      expect(bb.y + bb.height, `[${browserName}] fixed selection bar off BOTTOM (vh=${vp.height})`).toBeLessThanOrEqual(vp.height + slack);
    }
    await assertReachable(page, page.locator("#challenge-selection-bar-assign-btn"), `[${browserName}] selection bar Add-to-Competitions`);
    await expect(page.locator("#challenge-selection-bar-assign-btn"), `[${browserName}] the bar's door reads Add to events`).toHaveText("Add to events");
    // Stage B (owner ruling, 27 Nov 2026) — the selection bar is the Question
    // bank's ONE door into events: the old top button is gone.
    await expect(page.locator("#assign-challenges-to-comp-btn"), `[${browserName}] no second, top door`).toHaveCount(0);
  });

  test("v9.0.2: a table's sort and filter menu is reachable + on-screen in every viewport (the phone cards hide the headings)", async ({ page, browserName }) => {
    // At <=768px every admin table is a stack of cards and its headings, each
    // with its sort-and-filter button, are not shown: Sort & filter above the
    // cards is the door, and it opens the very menu the heading opens on a wider
    // screen. On a touch screen from 769 to 1279 px the headings show but their
    // button stays 24 px, so the bar shows Sort & filter there too (the 44 px
    // door) beside the headings' buttons. The device decides which door applies
    // (matchMedia, the authority openAdminTab also reads); either way the menu and
    // its controls must sit on the screen. Read-only: the menu is closed without
    // sorting or filtering.
    await pageLogin(page, "superadmin");
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    await openAdminTab(page, "admin-tasks-tab");
    await page.locator("#admin-task-body tr").first().waitFor({ state: "visible", timeout: 15000 }); // seed has challenges
    const cards = await page.evaluate(() => matchMedia("(max-width:768px)").matches);
    const touchMid = await page.evaluate(() => matchMedia("(pointer:coarse) and (min-width:769px) and (max-width:1279px)").matches);
    test.info().annotations.push({ type: "door", description: cards ? "Sort & filter (cards)" : touchMid ? "Sort & filter (touch, 769-1279 px)" : "heading button" });
    const vp = await layoutViewport(page); const slack = 2;
    const onScreen = async (loc, what) => {
      const b = await loc.boundingBox();
      expect(b, `${what}: no box`).not.toBeNull();
      expect(b.x >= -slack && b.y >= -slack && b.x + b.width <= vp.width + slack && b.y + b.height <= vp.height + slack,
        `${what}: off-viewport box=${JSON.stringify(b)} vp=${vp.width}x${vp.height}`).toBe(true);
    };
    const sf = page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-sf-btn");
    if (touchMid) {
      // The headings still show there, with their own buttons.
      await assertReachable(page, page.locator("#admin-task-table thead th[data-col='title'] .tcol-hbtn"), `[${browserName}] Title heading's sort-and-filter button (touch, 769-1279 px)`);
    }
    if (cards || touchMid) {
      await assertReachable(page, sf, `[${browserName}] Sort & filter`);
      await pressThroughRenderStall(sf, `[${browserName}] Sort & filter`, "click", 20000);
      const list = page.locator(".tcol-sf-pop");
      await list.waitFor({ state: "visible", timeout: 5000 });
      await onScreen(list, `[${browserName}] Sort & filter column list`);
      const pick = list.locator("[data-tcol-pick='title']");
      await assertReachable(page, pick, `[${browserName}] Title in the column list`);
      await pressThroughRenderStall(pick, `[${browserName}] Title in the column list`, "click", 20000);
    } else {
      await expect(sf, `[${browserName}] no Sort & filter where the headings show`).toBeHidden();
      const hb = page.locator("#admin-task-table thead th[data-col='title'] .tcol-hbtn");
      await assertReachable(page, hb, `[${browserName}] Title heading's sort-and-filter button`);
      await pressThroughRenderStall(hb, `[${browserName}] Title heading's sort-and-filter button`, "click", 20000);
    }
    const menu = page.locator(".tcol-pop[role='dialog']:not(.tcol-sf-pop)");
    await menu.waitFor({ state: "visible", timeout: 5000 });
    await expect(menu.locator(".t-eyebrow")).toHaveText("Title");
    await onScreen(menu, `[${browserName}] Title sort-and-filter menu`);
    for (const sel of ["[data-tcol-sort='desc']", "input[data-tcol-input]", "[data-tcol-done]"]) {
      await assertReachable(page, menu.locator(sel), `[${browserName}] Title menu ${sel}`);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".tcol-pop")).toHaveCount(0);
  });

  test("v7.12.3 (audit #6): a row kebab's actions stay reachable while the fixed selection bar is visible", async ({ page, browserName }) => {
    // Ticking a checkbox raises the fixed bottom selection bar (mobile). The row kebab
    // menu (z-index 160) must render ABOVE that bar (150) so its bottom items (Delete)
    // aren't painted over + their taps intercepted — the kebab is the ONLY mobile
    // row-action path, so a selection must never make it unusable.
    await pageLogin(page, "superadmin");
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    await openAdminTab(page, "admin-tasks-tab");
    const cb = page.locator("#admin-task-body input[type=checkbox]").first(); // seed has published challenges
    await cb.waitFor({ state: "visible", timeout: 15000 });
    await pressThroughRenderStall(cb, `[${browserName}] challenges row checkbox`, "click", 20000);   // → fixed selection bar shows
    await expect(cb).toBeChecked();
    await expect(page.locator("#challenges-selection-bar")).toBeVisible();
    const kebab = page.locator("#admin-tasks-tab .kebab-btn").first();
    await kebab.waitFor({ state: "visible", timeout: 15000 });
    await kebab.scrollIntoViewIfNeeded();
    await pressThroughRenderStall(kebab, `[${browserName}] challenges kebab with the selection bar up`, "click", 20000);
    const portal = page.locator("#kebab-portal");
    await portal.waitFor({ state: "visible", timeout: 5000 });
    const vp = await layoutViewport(page); const slack = 2;
    const mb = await portal.boundingBox();
    expect(mb, `[${browserName}] kebab portal has no box`).not.toBeNull();
    expect(mb.y + mb.height, `[${browserName}] kebab menu off BOTTOM edge with bar shown (vh=${vp.height})`).toBeLessThanOrEqual(vp.height + slack);
    // The LAST menu item (typically Delete) must be reachable — NOT under the fixed bar.
    await assertReachable(page, portal.locator("[role='menuitem'], button").last(), `[${browserName}] kebab last action with selection bar visible`);
    await page.keyboard.press("Escape");
  });

  // v8.11.8 — THE ONE SHAPE THIS SMOKE NEVER OPENED: a form containing a
  // `<select>`, an `<input type=date>` or an `<input type=time>`.
  //
  // Measured: every cross-engine divergence a UI audit found sits in exactly that
  // shape, and none of it was exercised. The smoke covers the login card, the
  // register page's FIRST FIELD only, the help drawer, a focus trap, the
  // participant shell, the admin sidebar, row kebabs and the selection bar — and
  // every control it DOES touch agreed across all three engines. The three
  // UA-styled control classes it does not touch all diverge: `<select>` 44/44/52
  // (chromium/firefox/webkit), `<input type=file>` 46/51/53, bare `<button>`
  // font-size 13.33/13.33/16.
  //
  // WEBKIT'S 52px SELECT IS AN ACCEPTED DISPOSITION, NOT A BUG TO CHASE. The
  // stylesheet declares `appearance` nowhere, so WebKit's intrinsic menulist
  // height exceeds the 44px floor — it is LARGER than the target minimum, so it
  // passes every accessibility requirement, and forcing `appearance:none` would
  // strip the native control's look on the one engine whose users expect it.
  // What this test pins is that the controls are REACHABLE and the form does not
  // overflow, which is what a divergence could actually break.
  test("v8.11.8: a form with a select and a date/time pair is reachable on every engine", async ({ page, browserName }) => {
    await pageLogin(page, "superadmin", getSuperadminPass());
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await openAdminTab(page, "admin-competitions-tab");
    await pressThroughRenderStall(page.locator('[data-action="open-competition-form"]').first(), `[${browserName}] + New Event`, "click", 20000);
    await page.locator("#admin-templates-tab").waitFor({ state: "visible", timeout: 15000 });
    await pressThroughRenderStall(page.locator('#tpl-kind-cards [data-action="new-event-start"][data-kind="tournament"]'), `[${browserName}] the Competition starter`, "click", 20000);
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#comp-name").waitFor({ state: "visible", timeout: 15000 });

    // A select, a date and a time — the three UA-styled classes, in one form.
    await assertReachable(page, page.locator("#comp-tz"), `[${browserName}] timezone select`);
    await assertReachable(page, page.locator("#comp-date"), `[${browserName}] start date`);
    await assertReachable(page, page.locator("#comp-time"), `[${browserName}] start time`);

    // Every one must clear the 44px target floor — the divergence is that WebKit
    // renders a select TALLER, never shorter, so this holds on all three.
    const heights = await page.evaluate(() =>
      ["comp-tz", "comp-date", "comp-time"].map((id) => {
        const el = document.getElementById(id);
        return { id, h: el ? Math.round(el.getBoundingClientRect().height) : 0 };
      }));
    for (const { id, h } of heights) {
      expect(h, `[${browserName}] #${id} is ${h}px, under the 44px target floor`).toBeGreaterThanOrEqual(44);
    }

    // And the dialog must not scroll sideways on any engine — a taller or wider
    // native control is exactly what would push it over.
    const over = await page.evaluate(() => {
      const c = document.querySelector("#comp-form-overlay .card");
      return c ? c.scrollWidth - c.clientWidth : 0;
    });
    expect(over, `[${browserName}] the competition form scrolls sideways by ${over}px`).toBeLessThanOrEqual(2);
  });

  // A workspace section opened by pressing the control each width shows: the
  // section tab, or on a phone the Section button and a row of its sheet. The
  // workspace opens on the Overview, so the section is absent until the press.
  async function openWorkspaceSection(page, section, label) {
    await expect(page.locator(`.ws[data-section='${section}']`), `${label} PRECONDITION: not yet on ${section}`).toHaveCount(0);
    if (await page.locator("#ws-section-pick").isVisible()) {
      await pressThroughRenderStall(page.locator("#ws-section-pick"), `${label} the Section button`, "click", 20000);
      const sheet = page.locator("#ws-section-sheet .ws-sheet");
      await sheet.waitFor({ state: "visible", timeout: 10000 });
      const box = await sheet.boundingBox();
      const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      expect(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= vp.w + 1 && box.y + box.height <= vp.h + 1,
        `${label} the section sheet is on screen: ${JSON.stringify({ box, vp })}`).toBe(true);
      await pressThroughRenderStall(page.locator(`#ws-section-sheet .ws-sheet-item[data-section='${section}']`), `${label} ${section} in the sheet`, "click", 20000);
    } else {
      await pressThroughRenderStall(page.locator(`#ws-tabs .ws-tab[data-section='${section}']`), `${label} the ${section} tab`, "click", 20000);
    }
    await expect(page.locator(`.ws[data-section='${section}']`), `${label} the press opened ${section}`).toHaveCount(1, { timeout: 10000 });
  }

  // The workspace's ⋯ menu opens on every engine and sits inside the window.
  test("the event workspace's More menu opens inside the window", async ({ page, browserName }) => {
    await pageLogin(page, "superadmin");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const cr = await page.request.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {
      name: `More ${browserName} ${Date.now().toString(36)}`, event_kind: "tournament",
      start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 } });
    expect(cr.status(), await cr.text()).toBe(200);
    const ev = (await cr.json()).competition;
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id), { timeout: 15000 }).toBe(true);
    await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: ev.id, n: ev.name });
    await expect(page.locator("#ws-record")).toBeVisible({ timeout: 10000 });
    const menu = page.locator("#kebab-portal.open");   // the menu opens in the row-menu portal
    await expect(menu, `[${browserName}] PRECONDITION: the menu is closed`).toHaveCount(0);
    await pressThroughRenderStall(page.locator("#ws-quick .ws-more-btn"), `[${browserName}] More`, "click", 20000);
    await expect(menu, `[${browserName}] the menu opened`).toBeVisible({ timeout: 10000 });
    const fit = await menu.evaluate((m) => { const r = m.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight }; });
    expect(fit.l >= -1 && fit.t >= -1 && fit.r <= fit.w + 1 && fit.b <= fit.h + 1, `[${browserName}] the menu is inside the window: ${JSON.stringify(fit)}`).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu, `[${browserName}] Escape closes it`).toHaveCount(0, { timeout: 5000 });
  });

  // THE EVENT WORKSPACE on every engine. Its header strip sticks under the
  // header through `display:contents` and two `overflow:clip` boxes; an engine
  // that resolves the sticky container differently fails with no error, toast
  // or log (the strip stops sticking, or sits over the Section button on a
  // phone). At rest nothing overlaps the strip; scrolled, it sits right under
  // the header. Its own event, made through the page's session.
  test("the event workspace's header strip overlaps nothing at rest and sticks under the header when scrolled", async ({ page, browserName }) => {
    test.setTimeout(90_000);
    await pageLogin(page, "superadmin");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const cr = await page.request.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {
      name: `Strip ${browserName} ${Date.now().toString(36)}`, event_kind: "tournament",
      start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 } });
    expect(cr.status(), await cr.text()).toBe(200);
    const ev = (await cr.json()).competition;
    await gotoThroughRenderStall(page, "/");
    await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
    await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id), { timeout: 15000 }).toBe(true);
    await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: ev.id, n: ev.name });
    await expect(page.locator("#ws-record")).toBeVisible({ timeout: 10000 });
    await openWorkspaceSection(page, "admin-tasks-tab", `[${browserName}]`);
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 15000 });
    // At rest means scrolled to the top: on a short screen opening the section
    // scrolls its heading into view, and a stuck strip then lies over the content.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => scrollY), { message: `[${browserName}] back at the top` }).toBe(0);
    const rest = await page.evaluate(() => {
      const rec = document.getElementById("ws-record").getBoundingClientRect();
      const ws = document.querySelector(".ws");
      const next = [...ws.parentElement.querySelectorAll("#ws-section-pick, #admin-tasks-tab")].find(e => e.getBoundingClientRect().height > 0);
      return { recBottom: rec.bottom, recHeight: rec.height, nextTop: next.getBoundingClientRect().top, next: next.id, vw: innerWidth, vh: innerHeight, sy: scrollY };
    });
    expect(rest.nextTop, `[${browserName}] the element after the strip starts below it: ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(rest.recBottom - 0.5);
    // Room to scroll, then scroll the WINDOW.
    await page.evaluate(() => { const sp = document.createElement("div"); sp.id = "strip-spacer"; sp.style.height = "2000px"; document.getElementById("admin-tasks-tab").appendChild(sp); window.scrollTo(0, 600); });
    await expect.poll(() => page.evaluate(() => scrollY), { message: `[${browserName}] the window scrolled` }).toBeGreaterThan(300);
    const stuck = await page.evaluate(() => ({ top: document.getElementById("ws-record").getBoundingClientRect().top,
      hb: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")) }));
    expect(Math.abs(stuck.top - stuck.hb), `[${browserName}] the strip sticks under the header: ${JSON.stringify(stuck)}`).toBeLessThanOrEqual(2);
  });
});

// An upload refused BEFORE its body is read (the submit route's declared-length
// gate, the attachment preflight) answers while the browser is still uploading.
// Closing that connection is what Firefox and WebKit report as a network error,
// so the refusal drains the body instead (lib/http.js refuseBeforeBody). Chromium
// shows the answer either way, so these arms witness the drain only on the
// Firefox and WebKit projects (CROSS_BROWSER=1); in the Chromium-only suite the
// DRAIN arms in tests/multer-limits.api.spec.js hold it. Each test owns what it
// writes on its worker's server.
test.describe("an upload refused before its body is read", () => {
  const TOO_LARGE = "That file is too large. Reduce the size and try again — retrying unchanged will not help.";
  const uniq = () => `xb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

  test("a participant's answer file over the gate's ceiling gets the 413 sentence, not a network error", async ({ page, browserName }) => {
    // One live event holding one file challenge, and one participant in it. The
    // correct answer is never sent, so nothing auto-ends.
    const admin = await apiLogin("superadmin");
    let compId, taskId;
    const email = `${uniq()}@company.example`;
    try {
      const cr = await admin.api.post("/api/admin/competitions", { headers: H(admin.csrf),
        data: { name: `${uniq()} Upload`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" } });
      expect(cr.ok(), `create event: ${await cr.text()}`).toBeTruthy();
      compId = (await cr.json()).competition.id;
      const tr = await admin.api.post("/api/admin/tasks", { headers: H(admin.csrf),
        data: { title: `${uniq()} File`, description: "d", difficulty: "easy", status: "published", answer_type: "file", correct_answer: "never-sent" } });
      expect(tr.ok(), `create challenge: ${await tr.text()}`).toBeTruthy();
      taskId = (await tr.json()).id;
      expect((await admin.api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(admin.csrf), data: { competitionIds: [compId] } })).ok()).toBeTruthy();
      const anon = await freshCtx();
      try {
        const reg = await registerPost(anon.api, "/api/register", { headers: H(anon.csrf), data: {
          firstName: "Up", lastName: "Load", nickname: uniq(), email, company: "Acme", title: "Engineer",
          country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
          jobFunction: "Software Developer / Engineer", city: "Testville" } });
        expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
      } finally { await anon.api.dispose(); }
      const list = await (await admin.api.get("/api/admin/participants?limit=5000")).json();
      const u = (list.participants || []).find((p) => p.email === email);
      expect(u, "the participant is findable").toBeTruthy();
      for (const step of ["verify", "approve"]) {
        expect((await admin.api.post(`/api/admin/participants/${u.id}/${step}`, { headers: H(admin.csrf) })).ok(), step).toBeTruthy();
      }
      const asg = await admin.api.post("/api/admin/competitions/assign", { headers: H(admin.csrf), data: { userIds: [u.id], competitionIds: [compId] } });
      expect((await asg.json()).assigned, "the assign endpoint skips ineligible users, so assert it took").toBe(1);
    } finally { await admin.api.dispose(); }

    await pageLogin(page, email, PARTICIPANT_PASS);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    const gradingHash = (await (await page.request.get(`/api/tasks/${taskId}`)).json()).grading_hash;
    expect(gradingHash, "the challenge detail carries a grading token").toBeTruthy();
    await gotoThroughRenderStall(page, "/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });

    // The request the participant client builds (submitAnswer): the file, then the
    // grading token, sent by fetch with the CSRF header.
    const send = (bytes, withHash) => page.evaluate(async ({ url, token, bytes, hash }) => {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array(bytes).fill(97)], "answer.txt", { type: "text/plain" }));
      if (hash) fd.append("gradingHash", hash);
      try {
        const r = await fetch(url, { method: "POST", headers: { "x-csrf-token": token }, body: fd });
        return { status: r.status, body: await r.text() };
      } catch (e) { return { threw: String((e && e.message) || e) }; }
    }, { url: `/api/tasks/${taskId}/submit`, token: csrf, bytes, hash: withHash ? gradingHash : null });

    // 12 MiB declares a Content-Length over the gate's ceiling (about 10.44 MiB),
    // so the gate answers before reading any of it.
    const refused = await send(12 * 1024 * 1024, true);
    expect(refused.threw, `[${browserName}] the upload must not fail as a network error`).toBeUndefined();
    expect(refused.status, `[${browserName}] ${refused.body}`).toBe(413);
    expect(JSON.parse(refused.body).error, `[${browserName}] the sentence the participant is shown`).toBe(TOO_LARGE);
    // CONTROL: the same request with an ordinary file is graded (wrong), so the
    // route was open to this participant and the refusal was about size alone.
    const graded = await send(64, true);
    expect(graded.status, `[${browserName}] ${graded.body || graded.threw}`).toBe(200);
    expect(JSON.parse(graded.body).correct, `[${browserName}] graded, and wrong`).toBe(false);
  });

  test("an admin's attachment refused by the preflight gets its sentence over XHR, not 'Network error.'", async ({ page, browserName }) => {
    // The preflight refuses before multer when the staging budget is gone: a
    // planted staging row of another admin fills the server-wide ceiling.
    const Database = require("better-sqlite3");
    const planted = require("crypto").randomUUID();
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("INSERT INTO task_attachments_staging (id, admin_id, display_name, original_name, size_bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(planted, `xb-other-${uniq()}`, "bulk", "bulk.zip", 4 * 1024 * 1024 * 1024, "0".repeat(64), `attachments-staging/${planted}.zip`, new Date().toISOString());
    } finally { db.close(); }
    try {
      await pageLogin(page, "superadmin");
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await gotoThroughRenderStall(page, "/");
      await page.locator("#admin-sidebar").waitFor({ state: "attached", timeout: 20000 });
      // The request the attachment picker sends (challenges-admin.js): XHR, so a
      // failure is status 0 and the picker can only say "Network error.".
      const BYTES = 20 * 1024 * 1024;
      const send = () => page.evaluate(({ token, bytes }) => new Promise((resolve) => {
        const fd = new FormData();
        fd.append("file", new File([new Uint8Array(bytes)], "big.zip", { type: "application/zip" }));
        fd.append("display_name", "big");
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => resolve({ status: xhr.status, networkError: true });
        xhr.open("POST", "/api/admin/attachment-staging");
        xhr.setRequestHeader("X-CSRF-Token", token);
        xhr.send(fd);
      }), { token: csrf, bytes: BYTES });
      // The disk floor is asked before the quota, so on a runner whose disk dips
      // under it the preflight names the disk instead. Only the quota sentence is
      // the preflight's alone (after multer the reserve names the STAGING quota),
      // so a disk refusal is asked again once the room is back; every answer must
      // still arrive as a status and a sentence.
      const answers = [];
      for (;;) {
        const r = await send();
        expect(r.networkError, `[${browserName}] the upload must not fail as a network error (status ${r.status})`).toBeUndefined();
        expect(r.status, `[${browserName}] ${r.body}`).toBe(507);
        answers.push(JSON.parse(r.body).error);
        if (!/^Server storage is too low/.test(answers[answers.length - 1]) || answers.length === 3) break;
        await awaitUploadRoom(BYTES);
      }
      expect(answers[answers.length - 1], `[${browserName}] the preflight's own sentence (answers: ${JSON.stringify(answers)})`).toMatch(/^Server-wide upload quota exceeded/);
    } finally {
      const dbC = new Database(TEST_DB_PATH);
      try { dbC.prepare("DELETE FROM task_attachments_staging WHERE id=?").run(planted); } finally { dbC.close(); }
    }
  });
});

// ── The two doors a person meets first, driven IN THE PAGE on every engine ──────
// Every other arm here signs in through page.request; these press the real
// controls: a walk-up scans a Booth Event's join link, proves the address with an
// emailed code, fills the short form, lands in the event and answers; an existing
// account signs in with an emailed code. finishSignIn, adoptNewSessionToken, the
// /join landing and the register POST then run on each engine and device.
test.describe("the walk-up door and the code door, in the page, on every engine", () => {
  /** The code the server last mailed to `email` (test servers only). */
  async function mailedCode(page, email) {
    let code = null;
    await expect.poll(async () => {
      const r = await page.request.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`);
      code = r.ok() ? ((await r.json()).code || null) : null;
      return code;
    }, { message: `a code was mailed to ${email}`, timeout: 15000 }).not.toBeNull();
    return code;
  }
  async function enterCode(page, email, label) {
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 20000 });
    await page.fill("#sc-code", await mailedCode(page, email));
    await pressThroughRenderStall(page.locator("#signin-code-overlay [data-action='signin-code-redeem']"), `${label} Continue with the code`, "click", 20000);
  }

  test("a walk-up scans the join link, signs up with the short form, lands in the event and answers", async ({ page, browserName }) => {
    const { sa: saLogin, liveBooth } = require("./late-entry-fixture");
    const { api, csrf } = await saLogin();
    let comp, taskIds, token;
    try {
      ({ comp, taskIds } = await liveBooth(api, csrf));
      const r = await api.get(`/api/admin/competitions/${comp.id}/self-enroll`);
      expect(r.ok(), `reveal the join link: ${await r.text()}`).toBeTruthy();
      token = (await r.json()).token;
    } finally { await api.dispose(); }
    const label = `[${browserName}]`;
    const email = `xb-walk-${browserName}-${Date.now().toString(36)}@company.example`.toLowerCase();

    await gotoThroughRenderStall(page, `/join/${encodeURIComponent(token)}`);
    await expect(page.locator("#join-banner-info"), `${label} the entry card names the event`).toHaveText(comp.name, { timeout: 20000 });
    await page.fill("#login-email", email);
    await pressThroughRenderStall(page.locator("#login-submit"), `${label} Continue`, "click", 20000);
    await enterCode(page, email, label);

    await page.locator("#register-page.active #reg-first").waitFor({ state: "visible", timeout: 20000 });
    await page.fill("#reg-first", "Walk");
    await page.fill("#reg-last", "Up");
    await page.fill("#reg-company", "Acme");
    await page.fill("#reg-title", "Engineer");
    if (await page.locator("#reg-location-pick").isVisible()) {
      await page.selectOption("#reg-country", "US");
      await page.selectOption("#reg-tz", { index: 1 });
    }
    const reg = page.waitForResponse((x) => x.url().includes("/api/register") && x.request().method() === "POST", { timeout: 30000 });
    await pressThroughRenderStall(page.locator("#register-page [data-action='do-register']"), `${label} Create account`, "click", 20000);
    expect((await reg).status(), `${label} the account was made`).toBe(200);

    // In the event, by the sign-in's own routing, and the first answer is graded.
    await expect(page.locator('#nav-challenges:not([aria-disabled="true"])'), `${label} landed in the event`).toBeVisible({ timeout: 30000 });
    const card = page.locator(`[data-task-id="${taskIds[0]}"]`).first();
    await card.waitFor({ state: "visible", timeout: 20000 });
    await pressThroughRenderStall(card, `${label} the challenge card`, "click", 20000);
    await page.locator("#task-detail-page.active #ans-text").waitFor({ state: "visible", timeout: 20000 });
    await page.fill("#ans-text", "win");
    await pressThroughRenderStall(page.locator('[data-action="task-submit-answer"][data-mode="text"]'), `${label} Submit`, "click", 20000);
    await page.locator("#modal-overlay.open #modal-confirm-btn").waitFor({ state: "visible", timeout: 10000 });
    await pressThroughRenderStall(page.locator("#modal-confirm-btn"), `${label} confirm the answer`, "click", 20000);
    await expect.poll(() => {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return db.prepare("SELECT s.is_correct AS c FROM submissions s JOIN users u ON u.id = s.user_id WHERE u.email = ? AND s.task_id = ?").get(email, taskIds[0])?.c ?? null;
      } finally { db.close(); }
    }, { message: `${label} the answer was graded correct`, timeout: 15000 }).toBe(1);
  });

  // The join link opened once and abandoned: the browser keeps it (localStorage
  // `hck-pending-join`), and coming back to the plain site later brings the event
  // back to the card and enrols the sign-up in it.
  test("a walk-up who opened the join link earlier comes back to the site and joins the event", async ({ page, context, browserName }) => {
    const { sa: saLogin, liveBooth } = require("./late-entry-fixture");
    const { api, csrf } = await saLogin();
    let comp, token;
    try {
      ({ comp } = await liveBooth(api, csrf));
      const r = await api.get(`/api/admin/competitions/${comp.id}/self-enroll`);
      expect(r.ok(), `reveal the join link: ${await r.text()}`).toBeTruthy();
      token = (await r.json()).token;
    } finally { await api.dispose(); }
    const label = `[${browserName}]`;
    const email = `xb-back-${browserName}-${Date.now().toString(36)}@company.example`.toLowerCase();
    const stored = (p) => p.evaluate(() => { try { return localStorage.getItem("hck-pending-join"); } catch (_) { return "unreadable"; } });
    const banner = (p) => p.locator("#join-banner-info");

    // CONTROL: before the link, the plain site keeps nothing and names no event.
    await gotoThroughRenderStall(page, "/");
    await page.locator("html[data-booted='1']").waitFor({ state: "attached", timeout: 20000 });
    expect(await stored(page), `${label} nothing is kept before the link`).toBeNull();
    expect((await banner(page).textContent().catch(() => "")) || "", `${label} no event on the card`).not.toContain(comp.name);

    await gotoThroughRenderStall(page, `/join/${encodeURIComponent(token)}`);
    await expect(banner(page), `${label} the link's card names the event`).toHaveText(comp.name, { timeout: 20000 });
    await expect.poll(() => stored(page), { message: `${label} the browser kept the link`, timeout: 10000 }).not.toBeNull();
    await page.close();

    // Later, in the same browser: the plain site, no token in the address.
    const back = await context.newPage();
    await gotoThroughRenderStall(back, "/");
    expect(new URL(back.url()).pathname, `${label} PRECONDITION: no join path`).toBe("/");
    await expect(banner(back), `${label} the event is back on the card`).toHaveText(comp.name, { timeout: 20000 });
    await back.fill("#login-email", email);
    await pressThroughRenderStall(back.locator("#login-submit"), `${label} Continue`, "click", 20000);
    await enterCode(back, email, label);
    await back.locator("#register-page.active #reg-first").waitFor({ state: "visible", timeout: 20000 });
    await back.fill("#reg-first", "Came");
    await back.fill("#reg-last", "Back");
    await back.fill("#reg-company", "Acme");
    await back.fill("#reg-title", "Engineer");
    if (await back.locator("#reg-location-pick").isVisible()) {
      await back.selectOption("#reg-country", "US");
      await back.selectOption("#reg-tz", { index: 1 });
    }
    const reg = back.waitForResponse((x) => x.url().includes("/api/register") && x.request().method() === "POST", { timeout: 30000 });
    await pressThroughRenderStall(back.locator("#register-page [data-action='do-register']"), `${label} Create account`, "click", 20000);
    expect((await reg).status(), `${label} the account was made`).toBe(200);
    await expect(back.locator('#nav-challenges:not([aria-disabled="true"])'), `${label} landed in the event`).toBeVisible({ timeout: 30000 });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT 1 AS ok FROM competition_users cu JOIN users u ON u.id = cu.user_id WHERE u.email = ? AND cu.competition_id = ?").get(email, comp.id);
      expect(row && row.ok, `${label} the new account is enrolled in the event`).toBe(1);
    } finally { db.close(); }
  });

  test("an existing account signs in with an emailed code, in the page", async ({ page, browserName }) => {
    const { makeParticipant } = require("./event-admin-helpers");
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, csrf, `xbcode${browserName}`); } finally { await sa.dispose(); }
    const label = `[${browserName}]`;
    expect((await page.request.get("/api/me")).status(), `${label} PRECONDITION: signed out`).toBe(401);

    await gotoThroughRenderStall(page, "/");
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 15000 });
    await page.fill("#login-email", p.email);
    await pressThroughRenderStall(page.locator("#login-submit"), `${label} Continue`, "click", 20000);
    await enterCode(page, p.email, label);
    await expect(page.locator("#main-nav .nav-btn").first(), `${label} the app opened`).toBeVisible({ timeout: 30000 });
    const me = await page.request.get("/api/me");
    expect(me.status(), `${label} the session is this account's`).toBe(200);
    expect((await me.json()).email).toBe(p.email);
  });
});
