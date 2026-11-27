// @ts-check
//
// Part of the ui-admin suite, split from a single 4,833-line file in v7.21.35.
//
// Contains: Admin accessibility — axe-core scan · v7.9.0 — self-enroll QR download · Competition creation from a UTC host (v7.15.23) · v7.21.2 — recalculate surfaces the frozen-skip count
//
// WHY IT WAS SPLIT: a spec file never spans workers, so the old file was a
// 181-second serial floor inside a 248-second suite — 73% of the wall clock in
// one worker, which no worker count could improve (WORKERS=16 bought 5.8%).
// Shared helpers live in ./ui-admin-helpers so the copies cannot drift.
const { test, expect } = require("./isolated-test");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, PORT_BASE, gradingHashFor } = require("./helpers");
const {
  login, loginViaApi, saLoginRetry, filterComps, adminLogin, participantLogin,
  clickTab, openKebab, findSeededTaskRow, viewComp, CONFIRM_PROBE_MS, AxeBuilder, AXE_GATED_IMPACTS, openAnalyticsTab, openCompCreateForm, narrowPeopleTable } = require("./ui-admin-helpers");

// Route every page.goto() + page.request.* to THIS worker's server.
test.use({ baseURL: BASE });


// ═══════════════════════════════════════════════════════════════════════════════
// Admin accessibility — axe-core scan (v6.8.3)
// ═══════════════════════════════════════════════════════════════════════════════
// Mirror the participant-side axe coverage on every admin tab (v6.8.3
// started with just Competitions; v6.8.4 fans out to every tab). Each
// test logs in once via the shared helper, clicks the target tab, waits
// for its sub-pane + first data row to render, and then runs the WCAG
// 2 A/AA rule set scoped to `#admin-page`. v6.8.4 tightens the gate to
// include `moderate` violations — previously we only gated on
// `serious` / `critical`, so form-label / landmark issues could slip in.
test.describe("Admin accessibility — axe-core scan", () => {
  function summarise(results) {
    return (results.violations || []).map(v => `${v.id} (${v.impact}): ${v.help}`).join("\n");
  }
  // v6.10.30: scope narrowed. Pre-v6.10.30 every tab's scan used
  // `include("#admin-page")` — the ENTIRE admin shell, chrome +
  // every hidden tab's DOM. axe-core walks that whole tree, yielding
  // 14-15 s scans even serially on the rankings / analytics tabs
  // (lots of leaderboard rows, ECharts canvas, etc.). Under
  // WORKERS=4 parallel contention, those same scans would exceed
  // the 60-s test timeout. New `scan(page, label, scope?)` takes
  // an optional scope selector — tab tests pass their pane id so
  // axe only walks that subtree. Competitions tab keeps
  // `#admin-page` so the shared chrome (nav, scope banner, user-
  // info) stays gated by the moderate+ rule; every other tab test
  // scans just its pane to avoid re-scanning the same chrome N
  // times. Typical per-scan drop: 14 s → 1-2 s.
  async function scan(page, label, scope = "#admin-page") {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include(scope)
      .analyze();
    const bad = (results.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact));
    // v7.21.40 — NAME THE RULES. This scan flakes under WORKERS=12 and passes
    // alone, and the message did not say WHICH rule fired — so each occurrence
    // cost a fresh investigation. `color-contrast` is the documented suspect
    // (axe cannot resolve a background when rows are clipped by an overflow:auto
    // boundary, so it oscillates between `incomplete` and a spurious violation
    // under load), but that is a HYPOTHESIS until a failure names it. Listing
    // the ids turns the next failure into evidence instead of a re-run.
    const ids = [...new Set(bad.map(v => v.id))].join(", ");
    expect(bad,
      `moderate+ a11y violations on ${label} [rules: ${ids || "none"}]:\n${summarise({ violations: bad })}`
    ).toHaveLength(0);
  }
  test("competitions tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    // Full-shell scan (#admin-page) — covers the chrome + competitions pane.
    // Every other tab test narrows scope to its own pane to keep total runtime bounded.
    await scan(page, "admin competitions tab");
  });
  test("challenges tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await scan(page, "admin challenges tab", "#admin-tasks-tab");
  });
  test("participants tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await scan(page, "admin participants tab", "#admin-participants-tab");
  });
  test("submissions tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Submissions");
    await scan(page, "admin submissions tab", "#admin-submissions-tab");
  });
  test("rankings tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Rankings");
    await scan(page, "admin rankings tab", "#admin-rankings-tab");
  });
  test("analytics tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    // Give the ECharts donut a moment to paint so axe sees a stable tree.
    await page.waitForSelector(".analytics-stat-value", { timeout: 5000 }).catch(() => {});
    await scan(page, "admin analytics tab", "#admin-analytics-tab");
  });
  test("logs tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Logs");
    await scan(page, "admin logs tab", "#admin-logs-tab");
  });
  test("settings tab: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Settings");
    await scan(page, "admin settings tab", "#admin-settings-tab");
  });

  // v6.9.22: per-modal scans. Every overlay in the SPA flows through
  // the same shell (overlayDismiss + installOverlayFocusTrap), so a
  // regression in the shared primitives hits every modal silently.
  // Scan each one explicitly rather than trusting the "all tabs
  // clean" aggregate.
  async function scanOverlay(page, selector, label) {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include(selector)
      .analyze();
    const bad = (results.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact));
    // v7.21.40 — NAME THE RULES. This scan flakes under WORKERS=12 and passes
    // alone, and the message did not say WHICH rule fired — so each occurrence
    // cost a fresh investigation. `color-contrast` is the documented suspect
    // (axe cannot resolve a background when rows are clipped by an overflow:auto
    // boundary, so it oscillates between `incomplete` and a spurious violation
    // under load), but that is a HYPOTHESIS until a failure names it. Listing
    // the ids turns the next failure into evidence instead of a re-run.
    const ids = [...new Set(bad.map(v => v.id))].join(", ");
    expect(bad,
      `moderate+ a11y violations on ${label} [rules: ${ids || "none"}]:\n${summarise({ violations: bad })}`
    ).toHaveLength(0);
  }

  test("v6.9.22: admin-edit-profile modal: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await page.locator("#admin-participants-body .kebab-btn").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#admin-participants-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit Profile')").first().click();
    await page.locator("#admin-profile-overlay").waitFor({ state: "visible", timeout: 5000 });
    await scanOverlay(page, "#admin-profile-overlay", "admin-profile-overlay");
  });

  test("v6.9.22: competition-edit modal: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await page.locator("#admin-comp-body .kebab-btn").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#admin-comp-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    await scanOverlay(page, "#comp-form-overlay", "comp-form-overlay");
  });

  test("v8.11.5: a BOOTH event's form is labelled — the registration matrix only exists there", async ({ page }) => {
    // The scan above edits whichever competition happens to be FIRST in the
    // list, and the sign-up matrix renders for the BOOTH kind alone — so its six
    // selects had never been scanned by anything, and shipped with no accessible
    // name at all (axe `select-name`, CRITICAL, WCAG 2.0-A 4.1.2). Exactly the
    // class the v7.16.2 comment below describes for session rows, one kind over:
    // a scan that takes whatever the fixture happens to give it cannot see a
    // control that only appears under a condition the fixture never sets.
    //
    // Per-kind reachability, measured: booth 6 selects, tournament 0, program 0.
    await adminLogin(page);
    await openCompCreateForm(page, "booth");
    const selects = page.locator('#comp-form-overlay .reg-field-row[data-reg-row]');
    await expect(selects.first(), "the booth form must render the registration field switches, or this scan is vacuous")
      .toBeVisible({ timeout: 10000 });
    expect(await selects.count(), "five configurable sign-up fields").toBeGreaterThanOrEqual(5);
    await scanOverlay(page, "#comp-form-overlay", "comp-form-overlay (booth)");
  });

  test("v7.16.2: session rows in the competition form are labelled", async ({ page }) => {
    // The scan above covers whichever competition happens to be first in the
    // list, which is usually SINGLE-session — so the inputs that only exist on
    // a session row were never scanned locally, and the End Date/Time pair
    // shipped with no label association at all (a CRITICAL axe finding, caught
    // only in CI where the first competition happened to have sessions).
    //
    // This scans the session-row DOM deliberately, but with ONLY the labelling
    // rules. The full ruleset is not viable here: each session row carries a
    // timezone input backed by the entire timezone datalist, and axe's
    // colour-contrast pass over those does not finish inside even a 3-minute
    // budget. Labelling is the class that went wrong and it is cheap to check.
    await adminLogin(page);
    await openCompCreateForm(page);
    // The radio itself is visually hidden — the segmented control's LABEL is
    // the click target, which is also how a real admin switches mode.
    await page.locator('label[for="comp-mode-multi"]').click();
    await page.locator("[data-action='comp-add-form-session']").first().click();
    await page.locator("#comp-sessions-list .session-form-row").first()
      .waitFor({ state: "visible", timeout: 8000 });

    const results = await new AxeBuilder({ page })
      .include("#comp-sessions-list")
      .withRules(["label", "aria-input-field-name", "form-field-multiple-labels"])
      .analyze();
    const bad = (results.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact));
    expect(bad,
      "every control in a session row needs a label association. The visible \"End Date/Time\" caption " +
      "sits above a PAIR of inputs so it cannot use for=, which is exactly how those two shipped " +
      "unlabelled:\n" + summarise({ violations: bad })
    ).toHaveLength(0);
  });

  test("v6.9.22: history dialog: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    // v7.21.40 — NARROW FIRST. `.kebab-btn").first()` on the unfiltered,
    // paginated table scans whichever participant happens to sort first, so the
    // DOM under test changes run to run (the v7.15.29 class). Pin it to a known
    // seeded row so the scan is reproducible; a11y of the dialog is the subject,
    // not of an arbitrary row.
    await narrowPeopleTable(page, "alice@acme.com");
    await expect.poll(() => page.locator("#admin-participants-body tr").count(),
      { timeout: 15000 }).toBe(1);
    await page.locator("#admin-participants-body .kebab-btn").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#admin-participants-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    await page.locator("#hist-overlay").waitFor({ state: "visible", timeout: 5000 });
    await scanOverlay(page, "#hist-overlay", "hist-overlay");
  });

  test("v6.9.22: invite dialog: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await page.locator("[data-action='open-invite-dialog']").first().click();
    await page.locator("#invite-overlay").waitFor({ state: "visible", timeout: 5000 });
    await scanOverlay(page, "#invite-overlay", "invite-overlay");
  });

  test("v6.9.22: participant-picker modal (analytics): no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator(".picker-btn").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator(".picker-btn").first().click();
    await page.locator(".picker-modal").waitFor({ state: "visible", timeout: 5000 });
    await scanOverlay(page, ".picker-modal", "picker-modal");
  });

  test("v6.9.22: confirm/danger modal: no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Pop the delete-challenge confirm (superadmin action) — this
    // lands on the modal-box shared confirm-dialog shell.
    await page.locator("#admin-task-body .kebab-btn").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#admin-task-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button.km-danger:has-text('Delete')").first().click();
    await page.locator("#modal-overlay").waitFor({ state: "visible", timeout: 5000 });
    await scanOverlay(page, "#modal-overlay", "confirm/danger modal");
    await page.locator("#modal-cancel-btn").click().catch(() => {});
  });
});


// v7.9.0 — the self-enroll ("Join Link") dialog can download a HIGH-RES PNG of
// the QR code (the module matrix drawn to a ~1000px canvas) so admins can print
// or embed the join code instead of screenshotting the small on-screen preview.
// Lock the control's presence + that clicking it yields a real .png download.
test.describe("v7.9.0 — self-enroll QR download", () => {
  test("Join Link dialog downloads a high-res PNG of the QR code", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    // v8.1.0 — OWNS ITS COMPETITION. The kebab carries "Join Link" only for a
    // NON-ended competition, so borrowing the seeded "Test Live" made this test
    // hostage to that fixture's lifecycle — diagnosed as `matchStatuses:["ended"]`
    // by viewComp's dump, after this test had been "hardened" for timing twice.
    // Fixture checklist item 2.
    const ownName = `JoinLink ${Date.now()}`;
    const _csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const _mk = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": _csrf, "content-type": "application/json" },
      data: { name: ownName, start_time: new Date(Date.now() - 3600e3).toISOString(),
              duration_minutes: 600, timezone: "UTC" },
    });
    expect(_mk.ok(), `create own competition: ${await _mk.text()}`).toBeTruthy();
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await clickTab(page, "Events");
    await filterComps(page, ownName);
    const row = page.locator(`#admin-comp-body tr:has-text('${ownName}')`);
    await expect(row).toBeVisible({ timeout: 5000 });
    // v8.1.0 — use the HARDENED opener, not a bare click. The kebab is a TOGGLE
    // and toggleKebab spends a click closing whatever is already open, so a single
    // click lands on a menu that never opens; `isVisible` also cannot tell an
    // EMPTY portal from a closed one, so the failure surfaces later as a missing
    // item. openKebab (v7.21.25) closes first, retries, and requires a populated
    // portal — this file already imported it and this test simply predated it.
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Join Link')").first().click();
    await page.locator("#self-enroll-overlay").waitFor({ state: "visible", timeout: 5000 });
    // The QR preview is lazy-rendered from a vendor lib — wait for the <svg> so the
    // lib is loaded before we download (the download re-derives from the same lib).
    await page.locator("#self-enroll-qr img.se-qr-img").waitFor({ state: "visible", timeout: 8000 });

    const btn = page.locator("#self-enroll-overlay [data-action='self-enroll-download-qr']");
    await expect(btn, "the Download QR button must be present").toHaveCount(1);
    await expect(btn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 8000 }),
      btn.click(),
    ]);
    // Filename is derived from the competition name and is a .png.
    expect(download.suggestedFilename()).toMatch(/^join-qr-.*\.png$/);
    // The saved file is a real, non-trivial PNG (magic bytes + size) — i.e. a
    // genuine high-res image, not an empty/placeholder blob.
    const fs = require("fs");
    const buf = fs.readFileSync(await download.path());
    expect(buf.length, "downloaded PNG should be a non-trivial image").toBeGreaterThan(500);
    expect(buf.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
    await page.locator("#self-enroll-overlay [data-action='self-enroll-close']").first().click().catch(() => {});
  });
});



// ═══════════════════════════════════════════════════════════════════════════════
// v7.15.16 — the two create-and-save flows an operator actually uses
// ═══════════════════════════════════════════════════════════════════════════════
// Neither had a browser test. The challenge editor was exercised only up to the
// point of saving — one existing test even asserts "until the admin hits Save"
// and then never hits Save — so the whole submit path (field collection, the
// attachment-staging promotion, the redirect back to the list) ran in no test.
// ═══════════════════════════════════════════════════════════════════════════════
// v7.15.23 — a UTC machine must be able to create a competition
// ═══════════════════════════════════════════════════════════════════════════════
// The form pre-fills its timezone from Intl.DateTimeFormat().resolvedOptions()
// .timeZone but validated against Intl.supportedValuesOf('timeZone'), and those
// two disagree about "UTC": the first returns it, the second omits it. So on any
// host reporting UTC — a container, a CI runner, plenty of ordinary Linux
// installs — an admin saw a correctly-filled timezone, hit Save, and got
// "Please select a valid timezone" pointing at a field that looked fine. No
// competition could be created at all.
//
// Found by CI, and it is a real user-facing bug rather than a test artefact.
// `timezoneId` reproduces it deterministically on ANY developer machine, which
// is what stops it depending on whatever zone the runner happens to have.
test.describe("Competition creation from a UTC host (v7.15.23)", () => {
  test.use({ timezoneId: "UTC" });
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  test("a UTC browser can create a competition", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    const name = `UTC host comp ${Date.now()}`;
    try {
      await openCompCreateForm(page);

      // Precondition: the browser really is on UTC and the form pre-filled it.
      // Without this the test could pass simply by not reproducing the setup.
      const tz = await page.evaluate(() => ({
        browser: Intl.DateTimeFormat().resolvedOptions().timeZone,
        field: document.getElementById("comp-tz")?.value,
      }));
      expect(tz.browser, "the browser must actually be on UTC for this to mean anything").toBe("UTC");
      expect(tz.field, "and the form pre-fills that value — which it then had to accept").toBe("UTC");

      await page.locator("#comp-name").fill(name);
      const start = new Date(Date.now() + 3600_000);
      const pad = (n) => String(n).padStart(2, "0");
      await page.locator("#comp-date").fill(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
      await page.locator("#comp-time").fill(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
      await page.locator("#comp-dur-h").fill("2");
      await page.locator('[data-action="comp-save"]').first().click();

      const confirm = page.locator("#modal-overlay");
      await expect(confirm,
        "the save must reach its confirmation — a rejected timezone bails before this with a toast"
      ).toContainText("Create Competition?", { timeout: 10000 });
      await confirm.locator("button", { hasText: /^Create$/ }).first().click();

      await expect.poll(() => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return !!db.prepare("SELECT 1 FROM competitions WHERE name=?").get(name); }
        finally { db.close(); }
      }, { timeout: 15000, intervals: [100, 200, 400, 800] }).toBe(true);
    } finally {
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("DELETE FROM competitions WHERE name=?").run(name); } finally { db.close(); }
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// v7.21.2 — Recalculate surfaces the frozen-skip count (client copy)
//
// v7.21.1 SCOPED recalculate to skip competitions whose session has ended
// (their final scores are frozen) and returned a `frozen_skipped` count — but
// the confirm dialog still promised to re-grade "EVERY historical submission",
// and the toast never read the count. On a fully-finished challenge the toast
// therefore read "Recalculated 0 submission(s); 0 scores changed." —
// indistinguishable from "nothing needed changing" when the truth is "nothing
// COULD change". The API count is pinned by ended-freeze.api.spec.js; the
// CLIENT was the untested gap, which is exactly how this shipped. These drive
// the real client function through the real shared modal and intercept the
// endpoint, so every response shape is deterministic without a frozen-comp
// fixture. Mutation-verified by reverting the modal + toast copy.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.21.2 — recalculate surfaces the frozen-skip count", () => {
  // recalculateTaskScores() only opens the confirm modal and then POSTs — it
  // does no client-side gating — so a placeholder id reaches the intercepted
  // route and no seeded/published challenge is needed. window has the export via
  // main.js's boot Object.assign(window, …, _ns7 /* challenges-admin */, …).
  async function openRecalcModal(page) {
    await adminLogin(page);
    await page.locator("#modal-overlay").waitFor({ state: "attached", timeout: 15000 });
    await page.evaluate(() => { window.recalculateTaskScores("frozen-fixture-id"); });
    await expect(page.locator("#modal-title")).toHaveText("Recalculate Scores", { timeout: 5000 });
  }

  test("the confirm dialog no longer promises EVERY submission, and names the freeze", async ({ page }) => {
    await openRecalcModal(page);
    const body = page.locator("#modal-body");
    await expect(body).toContainText(/still open/i);
    await expect(body).toContainText(/frozen and will not change/i);
    // The exact promise the finding flagged — a lie on any finished event.
    await expect(body).not.toContainText(/EVERY historical submission/i);
    await page.locator("#modal-cancel-btn").click();
  });

  test("a fully-frozen recalc says nothing COULD change — not 'Recalculated 0'", async ({ page }) => {
    await page.route("**/api/admin/tasks/*/recalculate", route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, total_submissions: 0, flipped: 0, hints_rescaled: 0, unresolved: 0, frozen_skipped: 3, task_id: "frozen-fixture-id" }),
    }));
    await openRecalcModal(page);
    await page.locator("#modal-confirm-btn").click();
    const toast = page.locator(".toast").first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast, "the toast must explain WHY nothing changed").toContainText(/finished/i);
    await expect(toast).toContainText(/frozen/i);
    // The exact misleading string the fix removes for the all-frozen case.
    await expect(toast).not.toContainText(/Recalculated 0 submission/i);
  });

  test("a partly-frozen recalc reports BOTH the re-graded count and the frozen count", async ({ page }) => {
    await page.route("**/api/admin/tasks/*/recalculate", route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, total_submissions: 4, flipped: 2, hints_rescaled: 0, unresolved: 0, frozen_skipped: 3, task_id: "frozen-fixture-id" }),
    }));
    await openRecalcModal(page);
    await page.locator("#modal-confirm-btn").click();
    const toast = page.locator(".toast").first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText(/Recalculated 4 submission/i);
    await expect(toast, "the frozen count must be surfaced alongside the re-graded count")
      .toContainText(/3 submissions in finished events/i);
  });
});
