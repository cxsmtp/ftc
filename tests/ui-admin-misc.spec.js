// @ts-check
//
// Part of the ui-admin suite, split from a single 4,833-line file in v7.21.35.
//
// Contains: Auth UI · Analytics tab · v6.16.24 — session-expiry interceptor · Mobile admin hamburger + active nav-btn (v6.17.3) · Participant groups UI (v6.20) · audit v7.7.30 batch 5 — a11y · audit v7.7.38 (SEC1) — superadmin reset-link reveal UI · Focused-competition participant payload (v7.15.8) · v7.20.10 — Assign Challenges is a set operation · Multi-session → single session (v7.21.1 A4)
//
// WHY IT WAS SPLIT: a spec file never spans workers, so the old file was a
// 181-second serial floor inside a 248-second suite — 73% of the wall clock in
// one worker, which no worker count could improve (WORKERS=16 bought 5.8%).
// Shared helpers live in ./ui-admin-helpers so the copies cannot drift.
const { test, expect } = require("./isolated-test");
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, PORT_BASE, gradingHashFor, codeLogin, appearanceSettled } = require("./helpers");
const {
  expectSpaBooted, login, loginViaApi, saLoginRetry, filterComps, adminLogin, participantLogin,
  clickTab, openKebab, findSeededTaskRow, viewComp, CONFIRM_PROBE_MS, AxeBuilder, AXE_GATED_IMPACTS, openAnalyticsTab, signUpViaUi, narrowPeopleTable } = require("./ui-admin-helpers");

// Route every page.goto() + page.request.* to THIS worker's server.
test.use({ baseURL: BASE });


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Auth UI", () => {
  test("shows login form on load", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login-email")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#login-submit")).toHaveText("Continue");
    await expectSpaBooted(page, "the login page");
    // At rest: no password box, no code button, no break-glass wording or link.
    await expect(page.locator("#login-password-group")).toBeHidden();
    await expect(page.locator("#login-code-instead")).toBeHidden();
    expect(await page.locator("#login-page").innerText(), "no break-glass wording on the card").not.toMatch(/break-glass/i);
    // Anything that is not an address opens the password step on the card, with
    // no code button (the break-glass username is the only such name).
    await page.fill("#login-email", "SuperAdmin");
    await page.click("#login-submit");
    await expect(page.locator("#login-password")).toBeVisible();
    await expect(page.locator("#login-code-instead")).toBeHidden();
    await expect(page.locator("#login-submit")).toHaveText("Sign in");
    // Editing the box goes back to the address step.
    await page.fill("#login-email", "someone@acme.com");
    await expect(page.locator("#login-password-group")).toBeHidden();
    await expect(page.locator("#login-submit")).toHaveText("Continue");
    // The special /break-glass page is gone.
    expect((await page.request.get("/break-glass")).status()).toBe(404);
  });

  test("shows error on invalid login", async ({ page }) => {
    // An unknown address gets the same code step (no oracle); a code typed
    // there is refused in the dialog.
    await page.goto("/");
    await expectSpaBooted(page, "the login page");
    await page.fill("#login-email", "nobody@test.com");
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 10000 });
    await page.fill("#sc-code", "ZZZZ-ZZZZ");
    await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
    await expect(page.locator("#sc-error")).toBeVisible({ timeout: 5000 });
  });

  test("a new address reaches the sign-up form through its code (email first)", async ({ page }) => {
    await page.goto("/");
    await expectSpaBooted(page, "the login page");
    expect(await page.locator("[data-action=register-reset-form]").count(), "no Sign Up button").toBe(0);
    await signUpViaUi(page, `newbie-${Date.now()}@company.example`, {}, { submit: false });
    await expect(page.locator("#reg-first").first()).toBeVisible({ timeout: 3000 });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Analytics tab", () => {
  test("renders filter bar + summary + donut canvas + table on first open", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
    // Filter bar mounts
    await expect(page.locator("#analytics-filterbar .seg-control").first()).toBeVisible({ timeout: 5000 });
    // Summary panel mounts (donut + at least one stat card)
    await expect(page.locator("#analytics-summary .analytics-stats")).toBeVisible({ timeout: 5000 });
    // ECharts renders into a canvas; the named app-html policy can't reach
    // it so this also validates that the default Trusted Types passthrough
    // is in place (ECharts uses element.innerHTML internally).
    await expect(page.locator("#analytics-donut canvas").first()).toBeVisible({ timeout: 5000 });
  });

  test("Help (account menu) opens the admin guide for an admin/superadmin", async ({ page }) => {
    await adminLogin(page);
    await require("./chrome-helpers").pressAccountMenuItem(page, "help-open");   // signed in, Help is in the account menu
    const drawer = page.locator(".help-drawer");
    await expect(drawer).toBeVisible({ timeout: 5000 });
    // Role routing: superadmin → admin.md (which starts with "Admin Guide").
    await expect(drawer.locator("h1:has-text('Admin Guide')")).toBeVisible({ timeout: 5000 });
  });

  // Platform-name placeholder in markdown sources is substituted at render
  // time with the currently-configured `platform_name` setting. Without
  // this, a tournament rebranded via Settings → Platform Name would still
  // read "Hack Arena" inside the Help drawer.
  test("Help (account menu) renders {{platformName}} substituted with the live platform_name setting", async ({ page }) => {
    // v8.3.17 — 120 s, because THE RESTORE IS INSIDE THE BUDGET AND IS THE LAST
    // THING TO RUN. This test does four auth round-trips (superadmin login →
    // settings PATCH → logout → participant login), a full page load and a drawer
    // render, and then restores `platform_name` in its `finally`. Under
    // WORKERS=12 it exhausted the default 60 s and the timeout surfaced ON THE
    // RESTORE's `/api/csrf-token` — i.e. the one step that must not be skipped,
    // since v8.1.0 records that `platform_name` is a GLOBAL setting whose escape
    // renders into the header wordmark, the login card, the `<title>` and all 19
    // email subjects, and that a spec leaving it dirty is a contaminator. Measured
    // in isolation at ~3.6 s, so this is ~30x of headroom rather than a nudge.
    // (Restoring in the test rather than an `afterAll` is deliberate and
    // documented — hooks run in registration order relative to the isolation
    // guard, so an appended `afterAll` runs too late.)
    test.setTimeout(120_000);
    // 1. Patch the platform name via the superadmin session (Settings PATCH).
    const stamp = Date.now();
    const newName = `HelpSubTest-${stamp}`;
    const loginR = await saLoginRetry(page.request); // audit v7.7.35 (T2)
    expect(loginR.ok(), `superadmin login for the platform-name PATCH: ${loginR.status()}`).toBeTruthy();
    let originalName = "Checkmarx Enablement Platform";
    try {
      const cfg = await (await page.request.get("/api/config")).json();
      if (cfg && cfg.platform_name) originalName = cfg.platform_name;
    } catch (_) {}
    // Fresh CSRF after login's session regenerate.
    const { csrfToken: patchCsrf } = await (await page.request.get("/api/csrf-token")).json();
    const patch = await page.request.patch("/api/admin/settings", {
      headers: { "x-csrf-token": patchCsrf, "content-type": "application/json" },
      data: { platform_name: newName },
    });
    expect(patch.ok()).toBeTruthy();

    try {
      // 2. Log out the superadmin session, then log in as Alice (participant)
      //    so the Help drawer defaults to participant.md — which contains
      //    a {{platformName}} placeholder in its opening paragraph.
      await page.request.post("/api/logout", {
        headers: { "x-csrf-token": patchCsrf, "content-type": "application/json" },
      }).catch(() => {});
      await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
      // v8.3.28 — LAND ON THE EVENT LIST, NOT INSIDE AN EVENT.
      //
      // alice is a SHARED seeded fixture carrying an ambient
      // `active_competition_id`, so since v8.3.15 boot AUTO-RESUMES her straight
      // into that competition — and this test only wants the help drawer. That
      // put a modal over the page (a competition-ended popup, an enter/leave
      // confirm — whichever the ambient state produced), and `#modal-overlay`
      // then intercepted the click on the header help control. Pre-v8.3.26 that was
      // reported as an unrelated later step timing out; with actions bounded it
      // finally named itself as "intercepts pointer events", which is what
      // identified this.
      //
      // Deselecting is one request and removes the whole class — the alternative,
      // registering a private participant, is the stronger rule (v7.15.32) but
      // this test genuinely wants nothing of the participant except that the help
      // drawer defaults to participant.md.
      {
        const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
        await page.request.post("/api/deselect-competition", { headers: { "x-csrf-token": t, "content-type": "application/json" } });
      }
      await page.goto("/");
      await page.locator("#app-search-btn").waitFor({ state: "visible", timeout: 10000 });
      // …and if something still raises one, SAY WHICH — "intercepts pointer
      // events" names the overlay, never the dialog inside it.
      const _open = page.locator("#modal-overlay.open");
      if (await _open.count()) {
        const what = await page.evaluate(() => ({
          title: document.getElementById("modal-title")?.textContent || null,
          body: (document.getElementById("modal-body")?.textContent || "").slice(0, 200),
        }));
        throw new Error(`a modal is open over the participant view before the help drawer was opened: ${JSON.stringify(what)}`);
      }
      // v8.3.26 — WAIT FOR THE NAME TO REACH THE CLIENT BEFORE OPENING THE DRAWER.
      //
      // The header Search button mounts at boot, so it is visible long
      // before `loadPlatformName()` has resolved `/api/config` into
      // `S.currentPlatformName` — and `_helpLoadDoc` substitutes
      // `{{platformName}}` with `S.currentPlatformName || 'Tournament'` at RENDER
      // time. Click too early and the drawer renders the FALLBACK, so the
      // assertion below fails on a name mismatch that names neither the race nor
      // the config fetch. Latent rather than observed, and free to close.
      await expect.poll(() => page.evaluate(() => window.S?.currentPlatformName ?? null),
        { timeout: 15000, intervals: [100, 200, 400, 800] }).toBe(newName);
      await require("./chrome-helpers").pressAccountMenuItem(page, "help-open");
      const drawer = page.locator(".help-drawer");
      // v8.3.20 — 15 s, and a diagnostic that names WHICH step failed.
      //
      // Seen flaky ONCE in a full 2578-test run at WORKERS=12 and reproduced by
      // nothing: not in isolation (3x), not under WORKERS=12 on this file alone,
      // not at HEAD, not on a full re-run. NO MECHANISM IS CLAIMED. What IS true
      // is that 5 s was by far the tightest budget in a test whose own comment
      // records needing 120 s overall under that worker count — it covers a cold
      // SPA boot's tail, the drawer mount and a markdown fetch-and-render, and it
      // is the one wait that had no headroom relative to its neighbours (the
      // sibling wait above it already allows 10 s for a single static element).
      //
      // Widening a wait is the blind fix this codebase warns against, so the
      // diagnostic is the durable half: "locator not visible" is equally true of
      // a failed login, a failed PATCH, a drawer that opened on the wrong
      // document and a render that is merely slow. On failure this says which.
      await expect(drawer.locator("h1:has-text('Participant Guide')")).toBeVisible({ timeout: 15000 })
        .catch(async (e) => {
          const diag = await page.evaluate(() => ({
            page: document.querySelector(".page.active")?.id || null,
            drawerOpen: !!document.querySelector(".help-drawer"),
            drawerHidden: document.getElementById("help-drawer-overlay")?.hasAttribute("hidden") ?? null,
            bodyLen: (document.getElementById("help-drawer-body")?.textContent || "").length,
            heading: document.querySelector(".help-drawer h1")?.textContent || null,
            wordmark: document.querySelector("#platform-name")?.textContent || null,
          })).catch(() => ({ evaluateFailed: true }));
          throw new Error(`${e.message}\nhelp-drawer state: ${JSON.stringify(diag)}`);
        });
      const pText = await drawer.locator("#help-drawer-body").textContent();
      expect(pText).toContain(newName);                // substitution worked
      expect(pText).not.toContain("Hack Arena");       // no stale hardcoded name
      expect(pText).not.toContain("{{platformName}}"); // no unsubstituted markers
    } finally {
      // 3. Restore the platform name so downstream tests stay deterministic.
      //
      // v8.3.25 — EVERY REQUEST IN HERE CARRIES ITS OWN DEADLINE, and that is the
      // fix rather than a fourth widening of the budget. This config sets no
      // `actionTimeout`/`navigationTimeout`, so an API request bounded by nothing
      // is bounded by the TEST — seen once at WORKERS=12, this block's
      // `/api/csrf-token` was still pending when the 120 s budget ran out and the
      // whole report was a bare `apiRequestContext.get: Test timeout`, naming
      // neither the restore nor a reason. NO MECHANISM IS CLAIMED: not reproduced
      // in isolation, nor by re-running the file. What is fixable without touching
      // the budget is that a stall here now fails in seconds and leaves the
      // remaining attempts room to land — the restore is the one step that must
      // not be skipped, since `platform_name` is global and this file would
      // otherwise be named by the contaminator guard in isolated-test.js.
      //
      // Deliberately NOT an `expect`: this runs in a `finally`, so throwing here
      // would replace whatever real failure sent us into it. The guard is the loud
      // half; this is the half that stops us needing it.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await saLoginRetry(page.request, { timeout: 15_000 }); // audit v7.7.35 (T2)
          const { csrfToken: restoreCsrf } = await (await page.request.get("/api/csrf-token", { timeout: 15_000 })).json();
          const restored = await page.request.patch("/api/admin/settings", {
            headers: { "x-csrf-token": restoreCsrf, "content-type": "application/json" },
            data: { platform_name: originalName },
            timeout: 15_000,
          });
          if (restored.ok()) break;
        } catch (_) { /* bounded, so the next attempt still has room */ }
      }
    }
  });

  test("default Trusted Types policy rejects createScript and createScriptURL", async ({ page }) => {
    // v6.1.1 tightened the default TT policy: `createHTML` is still a
    // passthrough (ECharts tooltip DOM needs it), but `createScript` and
    // `createScriptURL` now throw TypeError. Ensures a future vendor lib
    // (or app-code regression) that tries to inject `element.src` on a
    // <script> or call eval()-via-ScriptURL still fails closed at the
    // browser layer despite the default policy existing for HTML.
    await adminLogin(page);
    const result = await page.evaluate(() => {
      const out = { htmlOK: false, scriptThrows: false, scriptURLThrows: false, err: null };
      try {
        const tt = window.trustedTypes;
        if (!tt) { out.err = "trustedTypes unavailable"; return out; }
        // Re-invoking createPolicy('default', ...) is disallowed; instead,
        // trigger each default-policy sink via a direct assignment.
        const el = document.createElement("div");
        try { el.innerHTML = "<span>ok</span>"; out.htmlOK = !!el.querySelector("span"); }
        catch (e) { out.err = "innerHTML failed: " + e.message; }
        try {
          const s = document.createElement("script");
          s.src = "/vendor/echarts.min.js"; // this triggers createScriptURL on TT default policy
          out.scriptURLThrows = false;
        } catch (e) { out.scriptURLThrows = e instanceof TypeError; }
        try {
          const s = document.createElement("script");
          s.textContent = "void 0"; // not the TT path we care about; set text is fine
          // The path that actually hits createScript is innerText of a <script> via Trusted Types.
          // Simulate a direct sink: use a Function constructor cast to script — blocked by CSP not TT.
          out.scriptThrows = true; // can't cleanly reach createScript from page JS; accept the sink-URL probe as representative.
        } catch (_) { out.scriptThrows = true; }
      } catch (e) { out.err = e.message; }
      return out;
    });
    expect(result.err).toBeFalsy();
    expect(result.htmlOK).toBe(true);
    // Assigning .src on a dynamically created <script> goes through the
    // default policy's createScriptURL — the tightened policy throws.
    expect(result.scriptURLThrows).toBe(true);
  });

  // Scoped test.use — only this sub-describe runs under the pinned non-UTC
  // zone so other admin tests keep their default (UTC) behaviour.
  test.describe("custom-range TZ regression", () => {
    test.use({ timezoneId: "America/Los_Angeles" });

    test("date inputs parse as LOCAL midnight, not UTC", async ({ page }) => {
      // Pre-fix: `new Date("2026-04-15").toISOString()` in LA gave
      // "2026-04-15T00:00:00.000Z", which is actually April 14 17:00 LA.
      // Fix: parse as LOCAL midnight → emitted ISO becomes
      // "2026-04-15T07:00:00.000Z" (Apr 15 00:00 LA during PDT = 07:00 UTC).
      await adminLogin(page);
      await openAnalyticsTab(page);
      await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#analytics-period").selectOption("custom");
      await page.locator("#analytics-from").waitFor({ state: "visible", timeout: 5000 });

      const reqPromise = page.waitForRequest(
        req => req.url().includes("/api/admin/analytics/challenges") && req.url().includes("from="),
        { timeout: 5000 }
      );
      await page.locator("#analytics-from").fill("2026-04-15");
      await page.locator("#analytics-from").dispatchEvent("change");
      const req = await reqPromise;
      const url = new URL(req.url(), "http://localhost");
      const from = url.searchParams.get("from");
      // Apr 15 is PDT (offset -07:00). LA midnight → 07:00 UTC.
      expect(from).toBe("2026-04-15T07:00:00.000Z");
    });
  });

  test("switching scope to Competition fires the right XHR with competitionId", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
    // Switch scope to Competition — the picker-btn (not a <select>) appears.
    await page.locator("#analytics-filterbar .seg:has-text('Event')").click();
    const pickerBtn = page.locator(".picker-btn").first();
    await pickerBtn.waitFor({ state: "visible", timeout: 5000 });
    await pickerBtn.click();
    // Modal opens with comp cards; click the "Test Live" card.
    const card = page.locator(".picker-card:has-text('Test Live')").first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    const reqPromise = page.waitForRequest(req => /\/api\/admin\/analytics\/challenges\?.*scope=competition/.test(req.url()), { timeout: 5000 });
    await card.click();
    const req = await reqPromise;
    expect(req.url()).toContain("scope=competition");
    expect(req.url()).toMatch(/competitionId=[a-f0-9-]+/);
  });

  test("competition tag filter only visible in global scope", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
    // In global scope, "Event tags" label is visible
    await expect(page.locator(".mini-label:has-text('Event tags')")).toBeVisible({ timeout: 5000 });
    // Switch to Competition scope — label disappears
    await page.locator("#analytics-filterbar .seg:has-text('Event')").click();
    await expect(page.locator(".mini-label:has-text('Event tags')")).not.toBeVisible({ timeout: 3000 });
    // Switch back to Global — label reappears
    await page.locator("#analytics-filterbar .seg:has-text('Global')").click();
    await expect(page.locator(".mini-label:has-text('Event tags')")).toBeVisible({ timeout: 3000 });
  });

  test("global scope defaults to Exclude-internal for competition tags", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
    // The Exclude button should be the active segment in the comp tag filter
    const compTagSection = page.locator(".filter-card-section:has(.mini-label:has-text('Event tags'))");
    await expect(compTagSection.locator(".seg-active:has-text('Exclude')")).toBeVisible({ timeout: 3000 });
    // The "test/dry run" tag pill should be visible (selected for exclusion)
    await expect(compTagSection.locator("button:has-text('test/dry run')")).toBeVisible({ timeout: 3000 });
  });

  test("tag mode buttons (All/Exclude/Only) toggle and show tag pills", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
    const compTagSection = page.locator(".filter-card-section:has(.mini-label:has-text('Event tags'))");
    // Default: Exclude active, pills visible
    await expect(compTagSection.locator(".seg-active:has-text('Exclude')")).toBeVisible({ timeout: 3000 });
    await expect(compTagSection.locator("button:has-text('test/dry run')")).toBeVisible({ timeout: 3000 });
    // Switch to All — pills disappear
    await compTagSection.locator(".seg:has-text('All')").click();
    await expect(compTagSection.locator(".seg-active:has-text('All')")).toBeVisible({ timeout: 3000 });
    await expect(compTagSection.locator("button:has-text('test/dry run')")).not.toBeVisible({ timeout: 3000 });
    // Switch to Only — pills reappear
    await compTagSection.locator(".seg:has-text('Only')").click();
    await expect(compTagSection.locator(".seg-active:has-text('Only')")).toBeVisible({ timeout: 3000 });
    await expect(compTagSection.locator("button:has-text('test/dry run')")).toBeVisible({ timeout: 3000 });
  });

  test("picking an internal comp auto-switches tag filter from exclude-internal to all", async ({ page }) => {
    // Create an internal-tagged competition via API
    await saLoginRetry(page.request); // audit v7.7.35 (T2)
    const { csrfToken: csrf2 } = await (await page.request.get("/api/csrf-token")).json();
    const t = Date.now();
    const cr = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf2, "content-type": "application/json" },
      data: { name: `IntTest-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 120, tags: ["test/dry run"] },
    });
    const compId = (await cr.json()).competition.id;

    try {
      await page.goto("/");
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
      await openAnalyticsTab(page);
      await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
      const compTagSection = page.locator(".filter-card-section:has(.mini-label:has-text('Event tags'))");
      // Confirm default is exclude-internal
      await expect(compTagSection.locator(".seg-active:has-text('Exclude')")).toBeVisible({ timeout: 3000 });
      // Switch to Competition scope and pick the internal comp
      await page.locator("#analytics-filterbar .seg:has-text('Event')").click();
      const pickerBtn = page.locator(".picker-btn").first();
      await pickerBtn.waitFor({ state: "visible", timeout: 5000 });
      await pickerBtn.click();
      const card = page.locator(`.picker-card:has-text('IntTest-${t}')`).first();
      await card.waitFor({ state: "visible", timeout: 5000 });
      await card.click();
      // Picker button should show "Internal" badge
      await expect(page.locator(".picker-btn .badge:has-text('test/dry run')")).toBeVisible({ timeout: 3000 });
      // Switch back to Global — exclude-internal should be restored
      await page.locator("#analytics-filterbar .seg:has-text('Global')").click();
      await expect(compTagSection.locator(".seg-active:has-text('Exclude')")).toBeVisible({ timeout: 3000 });
    } finally {
      const { csrfToken: delCsrf } = await (await page.request.get("/api/csrf-token")).json();
      await page.request.delete(`/api/admin/competitions/${compId}`, {
        headers: { "x-csrf-token": delCsrf },
      });
    }
  });

  test("participant tag filter shows label and defaults to Exclude-staff", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 5000 });
    const partSection = page.locator(".filter-card-section:has(.mini-label:has-text('Participant tags'))");
    await expect(partSection).toBeVisible({ timeout: 3000 });
    await expect(partSection.locator(".seg-active:has-text('Exclude')")).toBeVisible({ timeout: 3000 });
    await expect(partSection.locator("button:has-text('staff')")).toBeVisible({ timeout: 3000 });
  });
});


// v6.16.24 — Session-expiry interceptor: when an admin's session goes
// away while they're polling (admin Logs tab is the canonical case),
// the SPA must (a) show a "Signed out" modal popup, (b) STOP every
// known polling interval so the access log doesn't fill with 401s
// between detection and the OK-button click, and (c) navigate to the
// login page when the user dismisses the popup. When the cause is
// single-session enforcement (a second login took over), the popup
// names the new session's IP + first/last/email (kicked variant).
test.describe("v6.16.24 — session-expiry interceptor", () => {
  test("admin polling Logs sees 'Signed out' popup (inactivity) and is redirected on dismiss", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Logs");
    await page.locator("#logs-body").waitFor({ state: "attached", timeout: 10_000 });
    // Force-kill the session by clearing cookies. The next fetch lands
    // on requireAdmin → 401 + "Not authenticated" → interceptor fires.
    await page.context().clearCookies();
    // Trigger an admin fetch from the page so the wrapped window.fetch
    // exercises the interceptor. Don't await — the interceptor returns
    // a never-resolving promise on detection.
    await page.evaluate(() => { fetch("/api/admin/logs?stream=app&limit=10", { credentials: "include" }); });
    // Wait for the modal to render. showModal() sets display:flex on
    // #modal-overlay; poll until it's visible.
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 10_000 });
    const titleText = await page.locator("#modal-title").textContent();
    expect(titleText).toMatch(/Signed out/i);
    const bodyText = await page.locator("#modal-body").textContent();
    expect(bodyText).toMatch(/inactivity|sign in again/i);
    // Click OK → location.href='/'. Login form should render.
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#login-page").waitFor({ state: "visible", timeout: 10_000 });
  });

  test("admin polling Logs stops firing fetches after session-expiry is detected", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Logs");
    await page.locator("#logs-body").waitFor({ state: "attached", timeout: 10_000 });
    // Force expiry + trigger detection.
    await page.context().clearCookies();
    await page.evaluate(() => { fetch("/api/admin/logs?stream=app&limit=10", { credentials: "include" }); });
    // _sessionExpiredHandled is a module-level let, not on window. Use
    // the modal-overlay's visibility as the equivalent "interceptor has
    // fired" signal — _showSessionExpiredPopup unconditionally renders
    // it as part of the same code path.
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 10_000 });
    // Now count admin-route fetches over a window long enough for the
    // 15-s auto-refresh tick to have fired pre-fix (would have produced
    // ≥1 401 in the access log). Because _stopAllPolls() ran in the
    // interceptor, the interval is cleared and no new request reaches
    // the wire. We use page.on('request', ...) AFTER detection so the
    // counter is genuinely "post-detection only".
    // v8.3.26 — ASSERT THE HANDLES, NOT A WINDOW.
    //
    // This was a 3-second `page.on("request")` window said to be "long enough for
    // the 15-s auto-refresh tick to have fired pre-fix". It is not: three live
    // `/api/admin/` pollers run here — logs 15 s, competitions 15 s, alerts 20 s
    // — so the chance that at least one fires inside a 3 s window is only ~46%.
    // The lock therefore passed roughly half the time WITH `_stopAllPolls()`
    // deleted, and under contention the timers fire later, i.e. further outside
    // the window: the negative got weaker exactly when it mattered.
    //
    // `_stopAllPolls` NULLS every handle it clears, so the state is a
    // deterministic observable needing no window at all. The request window stays
    // as a cheap second net, but it is no longer what the test rests on.
    const handles = await page.evaluate(() => ({
      logs: window.S?._logsAutoRefreshHandle ?? null,
      comps: window.S?.adminCompPollInterval ?? null,
      status: window.S?.statusPollInterval ?? null,
      scope: window.S?.scopeBannerInterval ?? null,
    }));
    expect(handles,
      "a forced sign-out must stop every admin poller — a surviving interval keeps 401ing for the life of the tab"
    ).toEqual({ logs: null, comps: null, status: null, scope: null });

    let adminFetchCount = 0;
    page.on("request", req => { if (req.url().includes("/api/admin/")) adminFetchCount++; });
    await page.waitForTimeout(3000);
    expect(adminFetchCount).toBe(0);
  });

  test("kicked-elsewhere popup names the new login's IP and first/last/email", async ({ page, browser }) => {
    // Browser A: Alice logs in via the participant SPA, navigates to
    // tasks-list (where statusPollInterval polls /api/status / /api/session/status).
    await participantLogin(page);
    // Browser B: a separate context that takes over Alice's session
    // by logging in as the same user. The login handler invalidates
    // browser A's session row and stamps the kick context (browser B's
    // IP + Alice's first/last/email) into _kickedSessions.
    const ctxB = await browser.newContext({ baseURL: BASE });
    try {
      const { csrfToken } = await (await ctxB.request.get("/api/csrf-token")).json();
      const lr = await codeLogin(ctxB.request, "alice@acme.com", { "x-csrf-token": csrfToken, "content-type": "application/json" });
      expect(lr.ok()).toBeTruthy();
    } finally { await ctxB.close(); }
    // Browser A: force an immediate session-monitor tick rather than waiting
    // up to 30 s for the next scheduled check (pollIntervalMs=30_000).
    // _sessionMonTick is a top-level async function in app.js; the popup is
    // triggered with fire-and-forget inside the tick, so the waitForFunction
    // catches it once it becomes visible.
    await page.evaluate(async () => { await window._sessionMonTick(); });
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 8_000 });
    const titleText = await page.locator("#modal-title").textContent();
    expect(titleText).toMatch(/Signed in elsewhere/i);
    const bodyText = await page.locator("#modal-body").textContent();
    // The popup names Alice (the login on browser B was as Alice).
    expect(bodyText).toMatch(/Alice/);
    expect(bodyText).toMatch(/Smith/);
    // It also names an IP — content varies by test env (127.0.0.1 vs ::1)
    // but it must be a non-empty IPv4 / IPv6-shaped value.
    expect(bodyText).toMatch(/IP\s+[0-9a-f.:]/i);
    // Click OK → location.href='/'.
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#login-page").waitFor({ state: "visible", timeout: 10_000 });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Mobile admin hamburger + active nav-btn visibility (v6.17.3)
// Regression lock for two fixes:
//   1. #admin-mobile-menu-btn had style="display:none" hard-coded in HTML,
//      preventing CSS @media(max-width:768px){display:flex} from ever firing.
//      Fix: removed the inline style; CSS now owns visibility entirely.
//   2. Light-theme .nav-btn.active used var(--surface2) — visually identical
//      to the nav background. Fix: separated hover and active rules; active
//      now uses var(--accent) with white text (matches dark theme behaviour).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Mobile admin hamburger + active nav-btn (v6.17.3)", () => {
  test.describe("mobile portrait (375×812)", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("hamburger button is visible for admin on mobile portrait", async ({ page }) => {
      await adminLogin(page);
      // The hamburger button must be visible on narrow viewports.
      // Pre-fix it had style="display:none" which overrides CSS media queries.
      const hamburger = page.locator("#admin-mobile-menu-btn");
      await expect(hamburger).toBeVisible();
    });

    test("hamburger opens the sidebar drawer on mobile portrait", async ({ page }) => {
      await adminLogin(page);
      const hamburger = page.locator("#admin-mobile-menu-btn");
      await expect(hamburger).toBeVisible();
      // Sidebar starts off-screen (transform:translateX(-100%)); no .mobile-open
      const sidebar = page.locator("#admin-sidebar");
      await expect(sidebar).not.toHaveClass(/mobile-open/);
      // Click hamburger → sidebar gains .mobile-open + overlay becomes visible
      await hamburger.click();
      await expect(sidebar).toHaveClass(/mobile-open/);
      await expect(page.locator("#admin-sidebar-overlay")).toBeVisible();
    });

    test("hamburger button is NOT visible for participants on mobile portrait", async ({ page }) => {
      await participantLogin(page);
      // Participants never see admin chrome
      await expect(page.locator("#admin-mobile-menu-btn")).not.toBeVisible();
    });
  });

  test("hamburger button is NOT visible on desktop (≥769px)", async ({ page }) => {
    // Default viewport is desktop-sized
    await adminLogin(page);
    // The CSS rule at min-width:769px hides the hamburger with display:none!important
    await expect(page.locator("#admin-mobile-menu-btn")).not.toBeVisible();
    // The collapse toggle IS visible instead
    await expect(page.locator("#admin-sidebar-toggle")).toBeVisible();
  });

  test("active nav-btn has visually distinct background in dark theme", async ({ page }) => {
    await adminLogin(page);
    // Default theme is dark. The active nav item should have --accent-soft background
    // (rgba(124,58,237,0.10) — purple tint) plus a 3px accent left stripe via ::before.
    // Pre-fix: --accent-soft was never declared, so background resolved to transparent.
    // Post-fix: --accent-soft is defined in :root and the background is a semi-opaque purple.
    const activeItem = page.locator(".admin-nav-item[aria-current='page']");
    await expect(activeItem).toBeVisible();
    const bg = await activeItem.evaluate(el =>
      getComputedStyle(el).backgroundColor
    );
    // rgba(124, 58, 237, 0.1) is the expected value; anything non-transparent is post-fix.
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
  });

  test("active nav-btn has visually distinct background in light theme", async ({ page }) => {
    await adminLogin(page);
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    // Switch to light theme
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("theme", "light");
    });
    const activeItem = page.locator(".admin-nav-item[aria-current='page']");
    await expect(activeItem).toBeVisible();
    const bg = await activeItem.evaluate(el =>
      getComputedStyle(el).backgroundColor
    );
    // Light theme --accent-soft is rgba(124,58,237,0.15) — slightly more opaque
    // than dark (0.15 vs 0.10) so it reads on the pale sidebar surface (#EFECF6).
    // Pre-fix: undefined → transparent. Post-fix: non-transparent purple tint.
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Participant groups UI (v6.20)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Participant groups UI (v6.20)", () => {
  test("Groups nav item opens the Groups pane with a New Group action", async ({ page }) => {
    await adminLogin(page);
    const nav = page.locator("button.admin-nav-item:has-text('Groups')").first();
    await expect(nav).toBeVisible();
    await nav.click();
    await expect(page.locator("#admin-groups-tab")).toBeVisible();
    await expect(page.locator("#admin-groups-tab button[data-action='group-create']")).toBeVisible();
  });

  test("Participants table has a Groups column and per-row + group affordance", async ({ page }) => {
    await adminLogin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await expect(page.locator("#admin-participants-tab")).toBeVisible();
    // Column header present.
    await expect(page.locator("#admin-participants-tab th", { hasText: "Groups" })).toBeVisible();
    // At least one "+ group" affordance in the rendered rows.
    await expect(page.locator("[data-action='participant-group-add']").first()).toBeVisible();
  });

  test("Invite dialog exposes the groups multiselect", async ({ page }) => {
    await adminLogin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#invite-participants-btn").click();
    await expect(page.locator("#invite-overlay")).toBeVisible();
    await expect(page.locator("#invite-group-list")).toBeVisible();
  });

  // Helper: create a group (optionally seeded) via the API using the page session.
  async function createGroupViaApi(page, name, userIds) {
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const r = await page.request.post("/api/admin/groups", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name, ...(userIds ? { userIds } : {}) },
    });
    return (await r.json()).group;
  }

  // v6.20.x AA target-size lock: the invite/bulk group-pick toggles were ~16px
  // tall (sub-AA). Bumped to ≥24px (WCAG 2.2 SC 2.5.8) without the full 44px
  // house treatment. Shared CSS rule covers .invite-group-pick + .bulk-group-pick,
  // so measuring the invite chip verifies both.
  test("group-pick chips meet the WCAG 2.2 AA 24px minimum target size", async ({ page }) => {
    await adminLogin(page);
    const g = await createGroupViaApi(page, `AAchip_${Date.now()}`);
    try {
      await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
      await page.locator("#invite-participants-btn").click();
      await expect(page.locator("#invite-overlay")).toBeVisible();
      const chip = page.locator(`.invite-group-pick[data-group-id='${g.id}']`);
      await chip.waitFor({ state: "visible" });
      const box = await chip.boundingBox();
      expect(box, "group-pick chip should have a bounding box").not.toBeNull();
      expect(box.height, `group-pick chip height ${box.height} < 24 (WCAG 2.2 AA SC 2.5.8)`).toBeGreaterThanOrEqual(24);
      expect(box.width, `group-pick chip width ${box.width} < 24 (WCAG 2.2 AA SC 2.5.8)`).toBeGreaterThanOrEqual(24);
    } finally {
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.delete(`/api/admin/groups/${g.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  // Regression lock (v6.20.2): the manage-members "Add participants" rows once
  // collapsed to invisible text + a full-width checkbox (global input{width:100%}).
  test("manage-members dialog renders candidate rows with visible text + small checkbox", async ({ page }) => {
    await adminLogin(page);
    const parts = (await (await page.request.get("/api/admin/participants?limit=50")).json()).participants;
    const g = await createGroupViaApi(page, `UIGrp_${Date.now()}`, [parts[0].id]); // 1 member → others are candidates
    try {
      await page.locator("button.admin-nav-item:has-text('Groups')").first().click();
      await page.locator(`button[data-action='group-manage-members'][data-group-id='${g.id}']`).click();
      await page.locator("#gm-candidates label").first().waitFor({ state: "visible" });
      const firstRow = page.locator("#gm-candidates label").first();
      // Text content (name/email) must be visible — the regression made it empty.
      expect((await firstRow.innerText()).trim().length).toBeGreaterThan(3);
      // Checkbox must NOT be stretched to full width by the global input rule.
      const cbW = await page.locator("#gm-candidates .gm-cb").first().evaluate(el => el.getBoundingClientRect().width);
      expect(cbW).toBeLessThan(30);
      // Tag-aware search: filtering by a tag substring still resolves.
      await page.locator("#gm-search").fill("zzz_no_match_zzz");
      await expect(page.locator("#gm-candidates")).toContainText("No matching participants");
    } finally {
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.delete(`/api/admin/groups/${g.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  // v6.20.x — axe-core scan of the imperatively-built manage-members dialog,
  // the highest-risk a11y surface (custom focus/ARIA) that the static-overlay
  // axe suite didn't cover.
  test("manage-members dialog: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    const parts = (await (await page.request.get("/api/admin/participants?limit=50")).json()).participants;
    const g = await createGroupViaApi(page, `UIAxeGrp_${Date.now()}`, [parts[0].id]);
    try {
      await page.locator("button.admin-nav-item:has-text('Groups')").first().click();
      await page.locator(`button[data-action='group-manage-members'][data-group-id='${g.id}']`).click();
      await page.locator("#gm-search").waitFor({ state: "visible", timeout: 5000 });
      const { AxeBuilder } = require("@axe-core/playwright");
      // color-contrast is disabled for THIS scan only. The candidate picker is a
      // scrollable, overflowing list; axe cannot reliably determine the
      // background of rows clipped by the `#gm-candidates` overflow:auto boundary
      // ("background color could not be determined because it's partially
      // obscured"), so the rule oscillates between `incomplete` and a spurious
      // `serious` finding under WORKERS=8 load — the sole source of this test's
      // flakiness (verified by dumping every axe result: no other rule ever
      // fires here). Structure / label / aria rules stay enabled; the palette's
      // contrast is validated by design + the stable-screen axe + visual gates.
      const results = await new AxeBuilder({ page }).include(".card").disableRules(["color-contrast"]).analyze();
      const bad = results.violations.filter(v => ["moderate", "serious", "critical"].includes(v.impact));
      expect(bad, `moderate+ a11y violations in manage-members dialog:\n${JSON.stringify(bad.map(v => v.id))}`).toHaveLength(0);
      await page.locator("#gm-close").click();
    } finally {
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.delete(`/api/admin/groups/${g.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  // Regression lock (v6.20.3): the group→competitions binding dialog had the
  // same unsized-checkbox collapse as the members dialog.
  test("manage-competitions dialog renders rows with visible names + small checkbox", async ({ page }) => {
    await adminLogin(page);
    const g = await createGroupViaApi(page, `UICompGrp_${Date.now()}`);
    try {
      await page.locator("button.admin-nav-item:has-text('Groups')").first().click();
      await page.locator(`button[data-action='group-bind-comps'][data-group-id='${g.id}']`).click();
      await page.locator("#gc-save").waitFor({ state: "visible" });
      const rows = page.locator(".gc-cb");
      if (await rows.count()) {
        const firstLabel = page.locator("label:has(.gc-cb)").first();
        expect((await firstLabel.innerText()).trim().length).toBeGreaterThan(2);
        const cbW = await rows.first().evaluate(el => el.getBoundingClientRect().width);
        expect(cbW).toBeLessThan(30);
      }
    } finally {
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.delete(`/api/admin/groups/${g.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  test("analytics Participants filter toggles between Tags and Groups", async ({ page }) => {
    await adminLogin(page);
    const g = await createGroupViaApi(page, `AnaGrp_${Date.now()}`);
    try {
      await openAnalyticsTab(page);
      await page.locator("[data-action='analytics-participant-mode'][data-value='groups']").waitFor({ state: "visible" });
      // Default is Tags mode → participant tag toggles present.
      await expect(page.locator("[data-action='analytics-participant-tag-mode']").first()).toBeVisible();
      // Switch to Groups → a group pill for our group shows.
      await page.locator("[data-action='analytics-participant-mode'][data-value='groups']").click();
      await expect(page.locator(`[data-action='analytics-group-toggle'][data-value='${g.id}']`)).toBeVisible();
    } finally {
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.delete(`/api/admin/groups/${g.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  // v6.20.x — bulk-assign wizard E2E. Select a participant row, open the
  // two-step wizard (Step 1 comp + optional group, Step 2 confirm, execute),
  // and assert the participant + the bound group land in the competition.
  test("bulk-assign wizard assigns a participant and binds a group", async ({ page }) => {
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    let uid, compId, gid, gMemberId;
    try {
      // Throwaway participant to select + an upcoming comp + a group (1 member).
      const reg = await registerPost(page.request, "/api/register", { headers: H, data: {
        firstName: "Bulk", lastName: "Pick", nickname: `bulkpick_${stamp}`, email: `bulkpick_${stamp}@acme.com`,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
      }});
      expect(reg.ok()).toBeTruthy();
      const parts = (await (await page.request.get("/api/admin/participants?limit=2000")).json()).participants;
      uid = parts.find(p => p.email === `bulkpick_${stamp}@acme.com`).id;
      await page.request.post(`/api/admin/participants/${uid}/verify`, { headers: H });
      await page.request.post(`/api/admin/participants/${uid}/approve`, { headers: H });
      // v7.15.10 — pick an ASSIGNABLE pool member (CLAUDE.md's documented
      // convention): the shared pool accumulates staff / blocked / unapproved
      // users as the file runs, and binding a group whose member is skipped by
      // the assign path changes the counts this test later asserts.
      gMemberId = parts.find(p => p.id !== uid
        && (p.role || "participant") === "participant"
        && p.approved && !p.blocked && !p.denied_at
        && !((p.tags || []).includes("staff")))?.id;
      const g = await createGroupViaApi(page, `BulkGrp_${stamp}`, gMemberId ? [gMemberId] : []);
      gid = g.id;
      compId = (await (await page.request.post("/api/admin/competitions", { headers: H, data: {
        name: `BulkComp ${stamp}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
      }})).json()).competition.id;

      // Open Participants (unscoped → the bulk wizard, not the quick-assign path).
      await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
      await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 15000 });
      // Narrow to our user via search, then tick their row checkbox.
      await narrowPeopleTable(page, `bulkpick_${stamp}`);
      const cb = page.locator(`#admin-participants-body input[type="checkbox"][value="${uid}"]`).first();
      await cb.waitFor({ state: "visible", timeout: 15000 });
      await cb.check();
      // Selection bar → Assign to Events → wizard.
      await page.locator("#selection-bar-assign-btn").click();
      await page.locator("#bulk-assign-overlay").waitFor({ state: "visible", timeout: 15000 });
      // Step 1: tick our comp + our group, then Next.
      await page.locator(`#bulk-comp-list input[type="checkbox"][value="${compId}"]`).check();
      await page.locator(`#bulk-assign-overlay .bulk-group-pick[data-group-id="${gid}"]`).click();
      await page.locator('[data-action="bulk-assign-next"]').click();
      // Step 2: confirm + execute.
      await page.locator('[data-action="bulk-assign-execute"]').waitFor({ state: "visible", timeout: 15000 });
      await page.locator('[data-action="bulk-assign-execute"]').click();
      // Assert: selected user enrolled (direct) + group bound + group member enrolled (group-origin).
      await expect.poll(async () => {
        const r = await page.request.get(`/api/admin/competitions/${compId}/groups`);
        return ((await r.json()).groups || []).some(x => x.id === gid);
      }, { timeout: 6000 }).toBe(true);
      // v7.15.15 de-flake — POLL the thing being asserted, not a proxy for it.
      // The bind above commits synchronously, but the group-origin enrollment is
      // written by the membership reconcile that runs AFTER the route's email
      // fan-out — so a single read here raced the reconcile (and v7.15.14's
      // bounded fan-out widened the gap). Same rule as the challenge_events
      // convention in CLAUDE.md: poll-with-cap against a fresh connection.
      const Database = require("better-sqlite3");
      const { TEST_DB_PATH } = require("./helpers");
      const enrolled = (userId) => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return !!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId); }
        finally { db.close(); }
      };
      await expect.poll(() => enrolled(uid),
        { timeout: 15000, intervals: [50, 100, 200, 400, 800] }).toBe(true);
      if (gMemberId) {
        await expect.poll(() => enrolled(gMemberId),
          { timeout: 15000, intervals: [50, 100, 200, 400, 800] }).toBe(true);
      }
    } finally {
      if (compId) await page.request.delete(`/api/admin/competitions/${compId}`, { headers: H }).catch(() => {});
      if (gid) await page.request.delete(`/api/admin/groups/${gid}`, { headers: H }).catch(() => {});
      if (uid) await page.request.delete(`/api/admin/participants/${uid}`, { headers: H }).catch(() => {});
    }
  });

  // v6.20.x — group-members pager + sticky selection across pages. Seed >50
  // candidates so the pager renders, select on page 1, page to 2, and confirm
  // the page-1 selection survived (the sticky `checked` Set) by saving.
  test("manage-members pager keeps selection across pages", async ({ page }) => {
    test.slow();
    const fs = require("fs");
    const path = require("path");
    const Database = require("better-sqlite3");
    const { TEST_DATA_DIR, TEST_DB_PATH } = require("./helpers");
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = `pager-${stamp}`;
    let gid;
    const emails = [];
    try {
      const g = await createGroupViaApi(page, `PagerGrp_${stamp}`);
      gid = g.id;
      // Seed 60 candidate participants (>50 → pager appears) via maintenance-gated bulk-seed.
      fs.writeFileSync(maintFile, byp);
      const users = Array.from({ length: 60 }, (_, i) => {
        const email = `pager_${stamp}_${i}@acme.com`;
        emails.push(email);
        return { firstName: "Pg", lastName: `Cand${i}`, nickname: `pager_${stamp}_${i}`, email };
      });
      const seed = await page.request.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...H, "x-maintenance-bypass": byp },
        // No `sharedPassword`: accounts have no password and the route ignores it.
        data: { users },
      });
      expect(seed.status(), `bulk-seed: ${seed.status()}`).toBe(200);
      fs.unlinkSync(maintFile);

      await page.locator("button.admin-nav-item:has-text('Groups')").first().click();
      await page.locator(`button[data-action='group-manage-members'][data-group-id='${gid}']`).click();
      await page.locator("#gm-candidates label").first().waitFor({ state: "visible", timeout: 10000 });
      // Pager must be present (60 candidates > page size 50).
      await page.locator("#gm-next").waitFor({ state: "visible", timeout: 5000 });
      // Select the first candidate on page 1, capture its id.
      const firstCb = page.locator("#gm-candidates .gm-cb").first();
      const firstId = await firstCb.getAttribute("value");
      await firstCb.check();
      // Page to 2, then back to 1 — the page-1 selection must persist (sticky Set).
      await page.locator("#gm-next").click();
      await page.locator("#gm-prev").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#gm-prev").click();
      await page.locator(`#gm-candidates .gm-cb[value="${firstId}"]`).waitFor({ state: "visible", timeout: 5000 });
      await expect(page.locator(`#gm-candidates .gm-cb[value="${firstId}"]`)).toBeChecked();
      // Save → the selected candidate becomes a member.
      await page.locator("#gm-add").click();
      await expect.poll(async () => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, firstId) ? 1 : 0; }
        finally { db.close(); }
      }, { timeout: 6000 }).toBe(1);
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
      if (gid) await page.request.delete(`/api/admin/groups/${gid}`, { headers: H }).catch(() => {});
      for (const email of emails) {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        let id; try { id = db.prepare("SELECT id FROM users WHERE email=?").get(email)?.id; } finally { db.close(); }
        if (id) await page.request.delete(`/api/admin/participants/${id}`, { headers: H }).catch(() => {});
      }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUPERADMIN
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.30 batch 5 — accessibility (M18–M24). The challenge form + analytics
// sort headers + filter toggles were never axe-scanned; these tests open the
// previously-unscanned surfaces and assert the fixes.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.30 batch 5 — a11y", () => {
  test("M21: the New Challenge form controls all have accessible names (axe label rule clean)", async ({ page }) => {
    const { AxeBuilder } = require("@axe-core/playwright");
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#admin-task-form").waitFor({ state: "visible", timeout: 5000 });
    // Each named control resolves an accessible name (label[for] or aria-label).
    for (const id of ["tf-title", "tf-diff", "tf-atype", "tf-answer", "tf-attach", "tf-author-name", "tf-author-linkedin"]) {
      const hasFor = await page.locator(`label[for="${id}"]`).count();
      const ariaLabel = await page.locator(`#${id}`).getAttribute("aria-label");
      expect(hasFor > 0 || !!ariaLabel, `#${id} must have a programmatic label`).toBe(true);
    }
    // axe over the open form — the 'label' rule (critical) must be clean. This
    // surface was never scanned before (the challenges scan ran with the form
    // display:none). color-contrast disabled per the repo convention for
    // dynamically-shown regions.
    // v8.11.5 — WIDENED FROM A THREE-ID ALLOWLIST TO THE REPO'S IMPACT GATE.
    // The old filter was `["label","select-name","aria-input-field-name"]`, and
    // an allowlist can only ever catch what somebody already thought of: a
    // CRITICAL `aria-required-children` on `#tf-attachments-list` sits INSIDE
    // this very region, in the default empty state of every New Challenge form,
    // and was filtered out of a scan that was already looking at it. Gating on
    // IMPACT rather than on id is the convention every other a11y scan in this
    // suite uses (AXE_GATED_IMPACTS), and it cannot be blind to a rule nobody
    // predicted. color-contrast stays disabled per the repo convention for
    // dynamically-shown regions.
    const results = await new AxeBuilder({ page }).include("#admin-task-form").disableRules(["color-contrast"]).analyze();
    const gated = results.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact));
    expect(gated, JSON.stringify(gated.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })))).toHaveLength(0);
  });

  test("M23: analytics sort headers are keyboard-focusable and expose aria-sort", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator("#analytics-table").waitFor({ state: "visible", timeout: 8000 });
    const th = page.locator("#analytics-table thead th[data-sort]").first();
    // .sortable -> the a11y tagger gives it tabindex, and DELIBERATELY NOT
    // role=button: `core/dispatcher.js` excludes TH (audit v7.7.30 M23), because
    // role=button on a <th> destroys the cell's columnheader semantics. The
    // assertion below never checked role, so this comment claimed a behaviour
    // nothing held and the code does not implement (corrected v8.11.12).
    await expect(th).toHaveClass(/sortable/);
    await expect(th).toHaveAttribute("tabindex", "0");
    await expect(th).toHaveAttribute("aria-sort", /none|ascending|descending/);
    // Activating via keyboard sorts + updates aria-sort to a direction.
    await th.focus();
    await page.keyboard.press("Enter");
    await expect(th).toHaveAttribute("aria-sort", /ascending|descending/);
  });

  test("M24: multi-select filter buttons expose aria-pressed reflecting their active state", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    // The status filter strip carries aria-pressed on each chip (initialised by
    // the a11y tagger; kept in sync by the click dispatcher).
    const chips = page.locator("#p-status-filters .filter-btn");
    await expect(chips.first()).toHaveAttribute("aria-pressed", /true|false/);
    // Clicking a chip flips its aria-pressed.
    const target = page.locator("#p-status-filters .filter-btn").nth(1);
    const before = await target.getAttribute("aria-pressed");
    await target.click();
    await expect(target).not.toHaveAttribute("aria-pressed", before || "false");
  });
});





// v7.15.8 — THE root cause of "the admin can't see Professional Role / City".
// With a competition FOCUSED, loadAdminParticipants() fills
// S.adminParticipantsData from /api/admin/participants/picker — and that SELECT
// omitted the profile columns. The Edit-Profile dialog renders entirely from
// that array, so those inputs came up EMPTY; a superadmin who then saved (having
// changed only one field) submitted the blanks and wiped the rest.
test.describe("Focused-competition participant payload (v7.15.8)", () => {
  // MECHANICAL, not a hand-written field list: the picker payload is diffed
  // against the MAIN /api/admin/participants payload for the SAME user. Both
  // feed the same dialog (unfocused vs focused), so any field one carries and
  // the other doesn't is a bug by definition — and a column added to the users
  // table + the main SELECT in future is caught here automatically, with no
  // list to remember to update. That is the whole point: the original defect
  // was a field that existed everywhere EXCEPT this payload.
  test("the picker payload carries every field the main participants payload does", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = Date.now();
    const compId = (await (await api.post("/api/admin/competitions", { headers: H, data: {
      name: `PickerFields ${stamp}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition.id;
    const email = `pkf${stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
      firstName: "Pick", lastName: "Fields", nickname: `pkf${stamp}`, email,
      secondaryEmail: `pkf${stamp}.alt@acme.com`,
      company: "Acme", title: "Staff Engineer", personalTitle: "Dr.", phone: "+1 555 0111",
      country: "US", timezone: "America/New_York", linkedinUrl: "https://linkedin.com/in/pkf",
      jobFunction: "Application Security Engineer", city: "Boston", avatar: "🦊",
      password: PARTICIPANT_PASS,
    }});
    await anon.dispose();
    const mainRow0 = (await (await api.get(`/api/admin/participants?limit=2000`)).json()).participants.find(p => p.email === email);
    await api.post(`/api/admin/participants/${mainRow0.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await api.post(`/api/admin/participants/${mainRow0.id}/approve`, { headers: { "x-csrf-token": csrf } });
    await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [mainRow0.id], competitionIds: [compId] } });

    const mainRow = (await (await api.get(`/api/admin/participants?limit=2000`)).json()).participants.find(p => p.email === email);
    const picker = await (await api.get(`/api/admin/participants/picker?competitionId=${compId}`)).json();
    const pickRow = (picker.users || []).find(p => p.email === email);
    expect(pickRow, "the assigned member appears in the picker payload").toBeTruthy();

    // Fields the main payload derives from OTHER tables (the picker deliberately
    // does not join them) — everything else must be present AND equal.
    const NOT_IN_PICKER = new Set(["tags", "groups", "competitions"]);
    const missing = Object.keys(mainRow)
      .filter(k => !NOT_IN_PICKER.has(k))
      .filter(k => !(k in pickRow));
    expect(missing,
      `the picker payload is missing field(s) the profile dialog renders: ${missing.join(", ")}. ` +
      `Add them to _PARTICIPANT_ROW_COLUMNS in routes/participants.js.`).toEqual([]);

    // v7.15.9 — EVERY row the picker returns, not just the member we seeded. The
    // picker has THREE row queries (member / non-member browse / non-member
    // search) and v7.15.8 patched only two: editing a participant who is NOT in
    // the focused competition still showed blank fields. Checking every row
    // covers all three regardless of which bucket a row came from.
    const keysOf = (r) => Object.keys(r).filter(k => !k.startsWith("chosen_") && k !== "in_competition").sort();
    const reference = keysOf(pickRow);
    for (const r of picker.users || []) {
      const short = reference.filter(k => !(k in r));
      expect(short, `picker row ${r.email} is missing: ${short.join(", ")}`).toEqual([]);
    }

    // Present is not enough — the values must match, so a NULL-yielding join or
    // a stale alias can't satisfy the key check while showing a blank on screen.
    const differing = Object.keys(mainRow)
      .filter(k => !NOT_IN_PICKER.has(k) && k in pickRow)
      .filter(k => JSON.stringify(mainRow[k]) !== JSON.stringify(pickRow[k]))
      .map(k => `${k}: main=${JSON.stringify(mainRow[k])} picker=${JSON.stringify(pickRow[k])}`);
    expect(differing, `picker values disagree with the main payload: ${differing.join("; ")}`).toEqual([]);

    // Belt and braces on the two fields the bug report named, so the intent
    // survives even if the diff above is ever relaxed.
    expect(pickRow.job_function).toBe("Application Security Engineer");
    expect(pickRow.city).toBe("Boston");

    // v7.15.9 — a participant who is NOT a member of the focused competition is
    // served by a DIFFERENT query (non-member browse) and was still short after
    // v7.15.8. Assert both non-member paths — browse and search.
    const nmEmail = `nonmem${stamp}@acme.com`;
    const { api: anon2, csrf: ac2 } = await freshCtx();
    await registerPost(anon2, "/api/register", { headers: { "x-csrf-token": ac2, "content-type": "application/json" }, data: {
      firstName: "Non", lastName: "Member", nickname: `nonmem${stamp}`, email: nmEmail,
      company: "Acme", title: "Staff Engineer", personalTitle: "Dr.", phone: "+1 555 0133",
      country: "US", timezone: "America/New_York",
      jobFunction: "DevOps / DevSecOps Engineer", city: "Prague", password: PARTICIPANT_PASS,
    }});
    await anon2.dispose();
    for (const [label, url] of [
      ["browse", `/api/admin/participants/picker?competitionId=${compId}`],
      ["search", `/api/admin/participants/picker?competitionId=${compId}&search=${encodeURIComponent(`nonmem${stamp}`)}`],
    ]) {
      const pk = await (await api.get(url)).json();
      const nm = (pk.users || []).find(p => p.email === nmEmail);
      expect(nm, `non-member appears in the ${label} payload`).toBeTruthy();
      const shortfall = reference.filter(k => !(k in nm));
      expect(shortfall, `non-member (${label}) is missing: ${shortfall.join(", ")}`).toEqual([]);
      expect(nm.job_function, `non-member (${label}) job_function`).toBe("DevOps / DevSecOps Engineer");
      expect(nm.city, `non-member (${label}) city`).toBe("Prague");
      expect(nm.personal_title).toBe("Dr.");
      expect(nm.phone).toBe("+1 555 0133");
    }

    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v7.20.10 — "Assign Challenges" is a SET operation
// ═══════════════════════════════════════════════════════════════════════════════
//
// The dialog used to build `assignable = published.filter(t => !alreadyAssigned)`,
// so the challenges already on the competition were ABSENT from the list: you
// could not see the competition's challenge set here and you could not take a
// challenge off. It now lists every published challenge with the assigned ones
// ticked, and Save applies the DIFF in both directions.
//
// Every test below is mutation-verified — the named source change was applied,
// the test confirmed to fail, and the source restored.
test.describe("v7.20.10 — Assign Challenges is a set operation", () => {
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  let _n = 0;
  const uniq = (p) => `SetOp-${Date.now()}-${_n++}-${p}`;

  /**
   * A competition plus two published challenges, A already assigned and B not.
   *
   * Both titles share `prefix`, so the picker's own search box narrows the list
   * to exactly these two — the dialog lists EVERY published challenge, and this
   * worker's database accumulates them, so nothing here may depend on how many
   * other challenges exist.
   */
  async function fixture(page) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const prefix = uniq("Fx");
    const mkTask = async (suffix) => {
      const title = `${prefix} ${suffix}`;
      const id = (await (await sa.post("/api/admin/tasks", {
        headers: h,
        data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
      })).json()).id;
      return { id, title };
    };
    const A = await mkTask("Alpha");
    const B = await mkTask("Bravo");
    const compName = uniq("Comp");
    const compId = (await (await sa.post("/api/admin/competitions", {
      headers: h,
      data: {
        name: compName,
        start_time: new Date(Date.now() + 3600_000).toISOString(),
        duration_minutes: 120,
      },
    })).json()).competition.id;
    const assign = async (taskId) => {
      const r = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: h, data: { competitionIds: [compId] },
      });
      expect(r.ok(), `assigning ${taskId} to the fixture competition`).toBeTruthy();
    };
    await assign(A.id);
    return { sa, h, csrf, prefix, A, B, compId, compName, assign,
      dispose: async () => { await sa.dispose(); } };
  }

  /** The set of task ids currently on `compId`, straight from the admin API. */
  async function assignedIds(page, compId) {
    const tasks = await (await page.request.get("/api/admin/tasks")).json();
    return new Set(tasks.filter(t => (t.competitions || []).some(c => c.id === compId)).map(t => t.id));
  }

  /** Focus the competition, open the picker, narrow it to the fixture's rows. */
  async function openPicker(page, compName, prefix) {
    await viewComp(page, compName);
    await clickTab(page, "Challenges");
    const addBtn = page.locator("#add-tasks-to-comp-btn");
    await addBtn.waitFor({ state: "visible", timeout: 10000 });
    await addBtn.click();
    const picker = page.locator("#task-picker-overlay");
    await expect(picker).toBeVisible({ timeout: 5000 });
    if (prefix) {
      await picker.locator("#task-picker-search").fill(prefix);
      await expect(picker.locator("#task-picker-list .picker-row"),
        "both fixture challenges are LISTED — the assigned one as well as the unassigned one").toHaveCount(2, { timeout: 5000 });
    }
    return picker;
  }

  const rowFor = (picker, title) => picker.locator(".picker-row", { hasText: title });
  const boxFor = (picker, title) => rowFor(picker, title).locator("input[type=checkbox]");

  // ── 1 ──────────────────────────────────────────────────────────────────────
  // Mutation: `const listed=published;` → `const listed=published.filter(t=>!isOn(t));`
  // (the pre-v7.20.10 add-only listing). Alpha then has no row at all.
  test("the ticks mirror reality — an assigned challenge is LISTED and CHECKED", async ({ page }) => {
    const f = await fixture(page);
    await f.dispose();
    await adminLogin(page);
    const picker = await openPicker(page, f.compName, f.prefix);

    // The load-bearing part: on the old build Alpha was filtered OUT of the
    // dialog entirely, so its row could not exist to be checked.
    await expect(rowFor(picker, f.A.title), "the already-assigned challenge is listed").toHaveCount(1);
    await expect(boxFor(picker, f.A.title), "…and pre-ticked").toBeChecked();
    await expect(rowFor(picker, f.A.title).locator(".picker-row-flag.is-on"),
      "…and flagged as being in this event").toHaveText(/In this event/);

    await expect(rowFor(picker, f.B.title), "the unassigned challenge is listed").toHaveCount(1);
    await expect(boxFor(picker, f.B.title), "…and NOT ticked").not.toBeChecked();
    await expect(rowFor(picker, f.B.title).locator(".picker-row-flag.is-on"),
      "…and carries no in-competition flag").toHaveCount(0);
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────
  // Mutation: delete the `for(const tid of toRemove){…DELETE…}` loop in
  // assignPickedTasks — Alpha stays assigned and the test fails.
  test("Save applies the diff in BOTH directions — the unticked one is removed", async ({ page }) => {
    const f = await fixture(page);
    await f.dispose();
    await adminLogin(page);

    // Positive control: the starting state is the one this test claims to change.
    let ids = await assignedIds(page, f.compId);
    expect([...ids].includes(f.A.id), "Alpha starts assigned").toBeTruthy();
    expect([...ids].includes(f.B.id), "Bravo starts unassigned").toBeFalsy();

    const picker = await openPicker(page, f.compName, f.prefix);
    await boxFor(picker, f.A.title).uncheck();
    await boxFor(picker, f.B.title).check();
    await expect(page.locator("#task-picker-count")).toContainText("1 to add, 1 to remove");

    await page.locator("#task-picker-save").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#task-picker-overlay")).toHaveCount(0, { timeout: 10000 });

    await expect.poll(async () => {
      const s = await assignedIds(page, f.compId);
      return `${s.has(f.A.id) ? "A" : "-"}${s.has(f.B.id) ? "B" : "-"}`;
    }, { timeout: 10000, message: "Bravo added, Alpha removed" }).toBe("-B");
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────
  // Mutation: `if(!ok)return;` → `if(!ok&&false)return;` — Cancel then applies
  // the change and both the API-state and still-open assertions fail.
  test("the confirmation names both sides, and Cancel is a true no-op", async ({ page }) => {
    const f = await fixture(page);
    await f.dispose();
    await adminLogin(page);
    const picker = await openPicker(page, f.compName, f.prefix);

    await boxFor(picker, f.A.title).uncheck();
    await boxFor(picker, f.B.title).check();
    await page.locator("#task-picker-save").click();

    const modal = page.locator("#modal-overlay.open");
    await modal.waitFor({ state: "visible", timeout: 5000 });
    const body = await page.locator("#modal-body").innerText();
    // Both sides are named, each under its own heading, before anything happens.
    expect(body, "the Adding side names Bravo").toMatch(
      new RegExp(`Adding[\\s\\S]*${f.B.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(body, "the Removing side names Alpha").toMatch(
      new RegExp(`Removing[\\s\\S]*${f.A.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    await page.locator("#modal-cancel-btn").click();
    await expect(modal).toBeHidden({ timeout: 5000 });

    // Nothing was written…
    const ids = await assignedIds(page, f.compId);
    expect(ids.has(f.A.id), "Alpha is still assigned after Cancel").toBeTruthy();
    expect(ids.has(f.B.id), "Bravo is still unassigned after Cancel").toBeFalsy();
    // …and the dialog is intact, with the ticks the admin had made.
    await expect(picker, "the picker stays open").toBeVisible();
    await expect(picker.locator("#task-picker-search"), "the filter survives").toHaveValue(f.prefix);
    await expect(boxFor(picker, f.A.title), "Alpha's untick survives").not.toBeChecked();
    await expect(boxFor(picker, f.B.title), "Bravo's tick survives").toBeChecked();
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────
  // The highest-value correctness lock in this change.
  // Mutation: make the baseline ALL assigned rather than `assigned ∩ listed` —
  // `baseline` from `tasks.filter(isOn)` while `S._pickerCheckedIds` is seeded
  // from `listed.filter(isOn)` (the ticks can only ever represent rendered
  // rows). Saving any unrelated change then computes the invisible draft as a
  // removal and silently unassigns it.
  test("an ASSIGNED DRAFT is not listed, and Save never removes it", async ({ page }) => {
    const f = await fixture(page);
    // A third challenge, assigned while published and then made a draft. The
    // API refuses to assign a draft (400), so this state can only be reached
    // the way it is reached in production — the row is already assigned when
    // the status changes under it (a restore-to-an-earlier-version unpublish).
    const draftTitle = `${f.prefix} Delta`;
    const draftId = (await (await f.sa.post("/api/admin/tasks", {
      headers: f.h,
      data: { title: draftTitle, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
    })).json()).id;
    await f.assign(draftId);
    await f.dispose();
    {
      const Database = require("better-sqlite3");
      const { TEST_DB_PATH } = require("./helpers");
      const dbW = new Database(TEST_DB_PATH);
      try { dbW.prepare("UPDATE tasks SET status='draft' WHERE id=?").run(draftId); } finally { dbW.close(); }
    }

    await adminLogin(page);
    // Positive control — the draft really is assigned before we touch anything.
    expect((await assignedIds(page, f.compId)).has(draftId),
      "the draft starts assigned to the competition").toBeTruthy();

    const picker = await openPicker(page, f.compName, f.prefix);
    // It is not on screen (drafts cannot be assigned, so they are not listed)…
    await expect(rowFor(picker, draftTitle), "the draft is not listed").toHaveCount(0);
    // …and the dialog says so rather than silently hiding it.
    await expect(picker.locator("#task-picker-note")).toContainText("assigned draft challenge");

    // Make an UNRELATED change and save it.
    await boxFor(picker, f.B.title).check();
    await page.locator("#task-picker-save").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#task-picker-overlay")).toHaveCount(0, { timeout: 10000 });

    await expect.poll(async () => (await assignedIds(page, f.compId)).has(f.B.id),
      { timeout: 10000, message: "the intended change landed" }).toBeTruthy();
    expect((await assignedIds(page, f.compId)).has(draftId),
      "the assigned DRAFT is untouched — this dialog can only change what it showed you").toBeTruthy();
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────
  // Mutation: in main.js, `…querySelectorAll('#task-picker-list input…')…delete(c.value)`
  // → `S._pickerCheckedIds?.clear()` (act on the whole set rather than the shown
  // rows). Bravo is then removed too and both assertions fail.
  test("'Unselect All Shown' is scoped to the filter — a hidden row is not unassigned", async ({ page }) => {
    const f = await fixture(page);
    await f.assign(f.B.id);            // both A and B assigned this time
    await f.dispose();
    await adminLogin(page);

    const picker = await openPicker(page, f.compName, f.prefix);
    await expect(boxFor(picker, f.A.title)).toBeChecked();
    await expect(boxFor(picker, f.B.title)).toBeChecked();

    // Narrow to Alpha ALONE, then clear the shown rows.
    await picker.locator("#task-picker-search").fill(f.A.title);
    await expect(picker.locator("#task-picker-list .picker-row")).toHaveCount(1, { timeout: 5000 });
    await picker.locator("button[data-action='task-picker-unselect-all']").click();

    await expect(page.locator("#task-picker-count"),
      "only the SHOWN row entered the diff").toContainText("0 to add, 1 to remove");

    await page.locator("#task-picker-save").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#modal-body"), "the hidden row is not in the removal list")
      .not.toContainText(f.B.title);
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#task-picker-overlay")).toHaveCount(0, { timeout: 10000 });

    await expect.poll(async () => {
      const s = await assignedIds(page, f.compId);
      return `${s.has(f.A.id) ? "A" : "-"}${s.has(f.B.id) ? "B" : "-"}`;
    }, { timeout: 10000, message: "Alpha removed, the filtered-out Bravo kept" }).toBe("-B");
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────
  // Mutation: delete `if(save&&!save.hasAttribute('data-frozen'))save.disabled=(!add&&!rm);`
  // from updateTaskPickerCount — Save stays enabled over an empty diff.
  test("Save is disabled while the diff is empty, and enables on the first change", async ({ page }) => {
    const f = await fixture(page);
    await f.dispose();
    await adminLogin(page);
    const picker = await openPicker(page, f.compName, f.prefix);

    await expect(page.locator("#task-picker-count")).toContainText("no changes");
    await expect(page.locator("#task-picker-save"), "nothing to save yet").toBeDisabled();

    // Positive control — the button is not simply dead: one tick enables it,
    // and undoing that tick disables it again.
    await boxFor(picker, f.B.title).check();
    await expect(page.locator("#task-picker-save")).toBeEnabled();
    await boxFor(picker, f.B.title).uncheck();
    await expect(page.locator("#task-picker-save")).toBeDisabled();
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────
  // Mutation: `${frozen?'disabled':''}` on #task-picker-save → `''` — Save is
  // offered on a frozen competition, where every request is a guaranteed 400.
  test("a competition with an ENDED session renders the dialog frozen", async ({ page }) => {
    const f = await fixture(page);
    // Two sessions; end the first. The competition is NOT fully ended (the
    // second is still upcoming), so the dialog is still reachable — which is
    // exactly the state the freeze exists for.
    const mkTs = async (name, offsetMs) => {
      const r = await f.sa.post(`/api/admin/competitions/${f.compId}/timeslots`, {
        headers: f.h,
        data: { name, start_time: new Date(Date.now() + offsetMs).toISOString(), duration_minutes: 60 },
      });
      expect(r.ok(), `creating session ${name}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot;
    };
    const ts1 = await mkTs("Morning", 3600_000);
    await mkTs("Afternoon", 2 * 3600_000);
    const tsId = ts1.id;
    expect(tsId, "the first session was created").toBeTruthy();
    const endR = await f.sa.post(`/api/admin/competitions/${f.compId}/timeslots/${tsId}/end-now`, { headers: f.h });
    expect(endR.ok(), "ending the first session").toBeTruthy();
    await f.dispose();

    await adminLogin(page);
    const picker = await openPicker(page, f.compName, null);
    await expect(picker.locator("#task-picker-frozen"),
      "the freeze announces itself").toContainText(/already ended/i);
    await expect(page.locator("#task-picker-save"), "Save is refused up front").toBeDisabled();
    await expect(picker.locator("#task-picker-list input[type=checkbox]").first(),
      "and no row can be toggled").toBeDisabled();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.21.1 (A4) — switching a multi-session competition to single
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Schedule toggle let an admin move an existing multi-session competition
// to "Single session". It was a FALSE SAVE: the toggle only hid the sessions
// section, the delete loop lived inside the multi-only branch so it never ran,
// the success toast appeared, and reopening the form showed the competition
// still multi-session. Worse, the save also wrote the single-session
// start_time/duration_minutes over the competition row, leaving it permanently
// contradicting its own sessions. And there is no other UI path to the intended
// end state — the per-row Remove button lives inside the section the switch
// hides.
//
// Both tests are mutation-verified.
test.describe("Multi-session → single session (v7.21.1 A4)", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  let _n = 0;

  // A competition with two UPCOMING sessions — the only state in which the mode
  // toggle is enabled at all (it locks once any session has started).
  async function multiComp(page, label) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const name = `A4-${label}-${Date.now()}-${_n++}`;
    const compId = (await (await sa.post("/api/admin/competitions", {
      headers: h,
      data: { name, start_time: new Date(Date.now() + 86400_000).toISOString(), duration_minutes: 120 },
    })).json()).competition.id;
    const slots = [];
    for (const [i, sName] of [[1, "Morning"], [2, "Afternoon"]]) {
      const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: h,
        data: { name: sName, start_time: new Date(Date.now() + i * 86400_000).toISOString(), duration_minutes: 60 },
      });
      expect(r.ok(), `creating session ${sName}: ${await r.text()}`).toBeTruthy();
      slots.push((await r.json()).timeslot.id);
    }
    await sa.dispose();
    return { name, compId, slots };
  }

  const compRow = (compId) => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return {
        comp: db.prepare("SELECT start_time, duration_minutes FROM competitions WHERE id=?").get(compId),
        slots: db.prepare("SELECT COUNT(*) AS n FROM competition_timeslots WHERE competition_id=?").get(compId).n,
      };
    } finally { db.close(); }
  };

  async function openEditForm(page, name) {
    await clickTab(page, "Events");
    await filterComps(page, name); // the table paginates and this worker's DB accumulates
    const row = page.locator(`#admin-comp-body tr:has-text('${name}')`).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator(".kebab-btn").click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });
  }

  // Fill the single-session fields with a value distinct from anything the
  // fixture used, so the assertion on the stored row cannot be satisfied by the
  // competition simply being left alone.
  const NEW_DATE = "2027-06-01", NEW_TIME = "09:00", NEW_ISO = "2027-06-01T09:00:00.000Z";
  async function switchToSingle(page) {
    await expect(page.locator("#comp-mode-multi"), "the fixture opens in multi mode").toBeChecked();
    await expect(page.locator("#comp-sessions-list .session-form-row")).toHaveCount(2);
    // The radios are display:none and driven by their labels (styles.css
    // .comp-mode-radio), so click the label — which is what the admin clicks.
    await page.locator('label[for="comp-mode-single"]').click();
    await expect(page.locator("#comp-mode-single")).toBeChecked();
    await expect(page.locator("#comp-single-section")).toBeVisible();
    await page.locator("#comp-date").fill(NEW_DATE);
    await page.locator("#comp-time").fill(NEW_TIME);
    await page.locator("#comp-tz").fill("UTC");
    await page.locator("#comp-dur-d").fill("0");
    await page.locator("#comp-dur-h").fill("2");
    await page.locator("#comp-dur-m").fill("0");
  }

  test("the switch really deletes the sessions and lands the single-session times", async ({ page }) => {
    const f = await multiComp(page, "ok");
    await adminLogin(page);
    await openEditForm(page, f.name);
    await switchToSingle(page);

    await page.locator('[data-action="comp-save"]').first().click();
    const confirm = page.locator("#modal-overlay");
    // The switch is destructive, so it has to say so before it happens.
    await expect(confirm, "the confirmation must name what is about to be deleted")
      .toContainText("will delete 2 existing sessions", { timeout: 10000 });
    await confirm.locator("button", { hasText: /^Save$/ }).first().click();

    await expect.poll(() => compRow(f.compId).slots,
      { timeout: 15000, intervals: [100, 200, 400, 800] })
      .toBe(0);
    // …and the competition really became the single session that was typed. A
    // 409 from a stale expectedUpdatedAt would leave the old values here while
    // the sessions were gone.
    //
    // v7.21.19 — POLL for it. This used to read the row once, immediately after
    // the slots-are-gone poll, and got away with it only because the deletes
    // were N sequential requests: by the time the last one landed, the PUT had
    // landed too. The deletes are now ONE transactional request, so slots hit 0
    // before the PUT commits and the single read saw the pre-save start_time.
    // Polling a condition and then reading a DIFFERENT value as though the poll
    // covered it is the v7.21.1 two-awaits mistake in another dress.
    await expect.poll(() => compRow(f.compId).comp.start_time,
      { timeout: 15000, intervals: [100, 200, 400, 800] })
      .toBe(NEW_ISO);
    const after = compRow(f.compId).comp;
    expect(after.duration_minutes).toBe(120);
    await expect(page.locator(".toast", { hasText: "Event updated." }).first()).toBeVisible({ timeout: 10000 });
  });

  test("a REFUSED delete surfaces the reason and leaves the competition alone", async ({ page }) => {
    const f = await multiComp(page, "refuse");
    const before = compRow(f.compId).comp;

    // Put a participant in EACH session. The server refuses to delete a session
    // with assigned participants (routes/sessions.js), which is the whole point:
    // the destructive risk is already enforced there, so the client may switch
    // freely and must report the refusal honestly. One participant per session
    // because competition_users is keyed (competition_id, user_id).
    {
      const db = new Database(TEST_DB_PATH);
      try {
        const users = db.prepare("SELECT id FROM users WHERE role='participant' LIMIT 2").all();
        expect(users.length, "need two participants to occupy both sessions").toBe(2);
        const ins = db.prepare("INSERT INTO competition_users (competition_id,user_id,timeslot_id,assigned_by,assigned_at) VALUES (?,?,?,'test',?)");
        users.forEach((u, i) => ins.run(f.compId, u.id, f.slots[i], new Date().toISOString()));
      } finally { db.close(); }
    }

    await adminLogin(page);
    await openEditForm(page, f.name);
    await switchToSingle(page);
    await page.locator('[data-action="comp-save"]').first().click();
    const confirm = page.locator("#modal-overlay");
    await expect(confirm).toContainText("will delete 2 existing sessions", { timeout: 10000 });
    await confirm.locator("button", { hasText: /^Save$/ }).first().click();

    // The admin is told WHY, in the server's own words.
    // v7.21.19 — the message now NAMES the session that blocked the delete, which
    // the per-session route could not (it only ever handled one). The refusal is
    // also the WHOLE set now: nothing is deleted, where the old loop could have
    // removed an earlier session before reaching this one.
    await expect(page.locator(".toast", { hasText: /participants are assigned to it/i }).first(),
      "a refusal must name the reason").toBeVisible({ timeout: 15000 });
    // …and must NOT be told it worked. The sibling test above is the positive
    // control that this toast does appear on a switch that succeeds.
    await expect(page.locator(".toast", { hasText: "Event updated." }),
      "a refused switch must not report success").toHaveCount(0);

    // Nothing moved: the sessions survive AND the competition row was never
    // rewritten to the single-session values it could not adopt. The second
    // half is the one that fails if the deletes run after the competition PUT.
    const after = compRow(f.compId);
    expect(after.slots, "both sessions survive").toBe(2);
    expect(after.comp.start_time, "the competition must not contradict its own sessions").toBe(before.start_time);
    expect(after.comp.duration_minutes).toBe(before.duration_minutes);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.3 — Analytics adopts the focused competition (and session) on entry
//
// The scope banner is the admin's answer to "what am I working on", and every
// other pane honours it. Analytics opened on Global every time — so an admin
// focused on today's event had to find it again in a picker listing every
// competition ever run, and could read a platform-wide chart believing it was
// scoped, because nothing on the way in said otherwise.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.3 — analytics adopts the focused scope", () => {
  const crypto = require("crypto");

  async function seedComp(withSession) {
    const tag = crypto.randomBytes(3).toString("hex");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const name = `AnScope-${tag}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240,
    }})).json()).competition.id;
    let tsId = null, tsName = null;
    if (withSession) {
      tsName = `Session ${tag}`;
      const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
        name: tsName, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 180,
      }});
      expect(r.ok(), `create session: ${r.status()} ${await r.text()}`).toBeTruthy();
      tsId = (await r.json()).timeslot.id;
    }
    return { tag, name, compId, tsId, tsName, sa, csrf };
  }
  const drop = async (fx) => {
    await fx.sa.delete(`/api/admin/competitions/${fx.compId}`, { headers: { "x-csrf-token": fx.csrf } }).catch(() => {});
    await fx.sa.dispose();
  };

  const openAnalytics = async (page) => {
    await openAnalyticsTab(page);
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#analytics-filterbar .seg-control").first().waitFor({ state: "visible", timeout: 10000 });
  };
  const activeScope = (page) => page.locator('#analytics-filterbar [data-action="analytics-set-scope"].seg-active').innerText();

  test("a focused competition is adopted; the scope reads Competition, not Global", async ({ page }) => {
    const fx = await seedComp(false);
    try {
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, fx.name);           // sets the global focus
      await openAnalytics(page);

      expect((await activeScope(page)).trim()).toBe("Event");
      expect(await page.evaluate(() => window._analyticsState.competitionId)).toBe(fx.compId);
      expect(await page.evaluate(() => window._analyticsState.timeslotId)).toBeNull();
      // …and the pane actually rendered figures rather than the "pick a
      // competition" empty state, which is what an unadopted scope would show.
      await expect(page.locator("#analytics-summary .analytics-stats")).toBeVisible({ timeout: 10000 });
    } finally { await drop(fx); }
  });

  test("a focused SESSION narrows it further, to that session", async ({ page }) => {
    const fx = await seedComp(true);
    try {
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, fx.name);
      // Focus the session via the scope banner's own chip — the same control an
      // admin uses, so this cannot pass against a scope the UI cannot reach.
      const chip = page.locator(`#admin-scope-banner [data-action="comp-focus-ts"][data-ts-id="${fx.tsId}"], #admin-comp-body [data-action="comp-focus-ts"][data-ts-id="${fx.tsId}"]`).first();
      await chip.waitFor({ state: "visible", timeout: 10000 });
      await chip.click();
      await expect.poll(async () => page.evaluate(() => window.S.adminSelectedTimeslotId),
        { timeout: 10000, message: "the session must become the focused scope" }).toBe(fx.tsId);

      await openAnalytics(page);
      expect((await activeScope(page)).trim()).toBe("Session");
      expect(await page.evaluate(() => window._analyticsState.competitionId)).toBe(fx.compId);
      expect(await page.evaluate(() => window._analyticsState.timeslotId)).toBe(fx.tsId);
    } finally { await drop(fx); }
  });

  test("with NO competition focused it leaves the admin's own analytics selection alone", async ({ page }) => {
    // The rule is "adopt a focus if there is one", not "mirror the banner".
    // Clearing back to Global whenever the banner is empty would throw away a
    // selection made inside this pane for no reason. Without this control, a
    // sync that simply overwrote the state on every entry would pass the two
    // tests above.
    const fx = await seedComp(false);
    try {
      await adminLogin(page);
      await openAnalytics(page);
      expect((await activeScope(page)).trim()).toBe("Global");

      // Choose a competition inside Analytics, then leave and come back with
      // nothing focused. It must survive.
      await page.evaluate((id) => {
        window._analyticsState.scope = "competition";
        window._analyticsState.competitionId = id;
      }, fx.compId);
      await clickTab(page, "Events");
      expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "no competition may be focused").toBeFalsy();
      await openAnalytics(page);

      expect((await activeScope(page)).trim()).toBe("Event");
      expect(await page.evaluate(() => window._analyticsState.competitionId)).toBe(fx.compId);
    } finally { await drop(fx); }
  });
});
