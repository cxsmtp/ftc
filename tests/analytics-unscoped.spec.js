// v8.1.0 — PR 21: Analytics runs no aggregate until the admin has said what to
// aggregate.
//
// It opened on Global every time and issued a platform-wide query over every
// competition ever run, painted before anyone had asked — so an admin could read a
// platform-wide chart believing it was scoped, because nothing on the way in said
// otherwise.
//
// The v7.22.3 focused-scope adoption IS the scope for the common workflow (focus
// today's event, open Analytics), so that path is byte-for-byte unchanged and
// still one click. What changes is the NO-FOCUS case.
//
// SEQUENCING NOTE, because the first attempt at this PR got it wrong: the 24 test
// entry points into this tab were unified into openAnalyticsTab FIRST, as a pure
// refactor verified green, so this behaviour change is absorbed in one helper
// rather than chased across 33 failing tests.
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, BASE } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `au${Date.now().toString(36)}`;

// Deliberately NOT openAnalyticsTab: this file tests the prompt that helper
// dismisses, so it must open the tab raw.
async function rawOpenAnalytics(page) {
  const btn = page.locator("button[data-tab-id='admin-analytics-tab']").first();
  await btn.waitFor({ state: "attached" });
  await btn.evaluate((el) => el.click());
  await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 10000 });
}

test.describe("v8.1.0 — Analytics opens unscoped", () => {
  test("with no focus it PROMPTS, issues no query, and hides the table card", async ({ page }) => {
    await adminLogin(page);
    await page.evaluate(() => { window.S.adminSelectedCompetitionId = null; window.S.adminSelectedTimeslotId = null; });

    let calls = 0;
    page.on("request", (r) => { if (r.url().includes("/api/admin/analytics/challenges")) calls++; });
    await rawOpenAnalytics(page);

    const summary = page.locator("#analytics-summary");
    await expect(summary).toContainText("Choose what to measure");
    // The composition line — what platform-wide would actually include. Without
    // it the second button is a leap of faith.
    await expect(summary, "it says what platform-wide covers").toContainText("test/dry run");
    await expect(summary).toContainText("staff");

    // NO aggregate was requested. The prompt is not a cosmetic overlay on a query
    // that ran anyway.
    expect(calls, "no aggregate is issued before the admin chooses").toBe(0);

    // ONE RULE: the card is gone, taking the search box, its clear button,
    // Export CSV, the header, the pager and the "no activity" line with it.
    await expect(page.locator("#analytics-table-card")).toBeHidden();
    // …and NOT the contradiction that predates this release: a prompt on screen at
    // the same time as "No challenge activity in the selected window."
    await expect(page.locator("#analytics-empty")).toBeHidden();
  });

  test("choosing platform-wide runs the query and brings the table card back", async ({ page }) => {
    // The positive control. Without it, "no query was issued" is equally satisfied
    // by a pane that never queries at all.
    await adminLogin(page);
    await page.evaluate(() => { window.S.adminSelectedCompetitionId = null; window.S.adminSelectedTimeslotId = null; });
    let calls = 0;
    page.on("request", (r) => { if (r.url().includes("/api/admin/analytics/challenges")) calls++; });
    await rawOpenAnalytics(page);
    expect(calls).toBe(0);

    await page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="global"]').click();
    await expect.poll(() => calls, { timeout: 10000 }).toBeGreaterThan(0);
    await expect(page.locator("#analytics-table-card")).toBeVisible();
  });

  test("an OPEN event (its workspace) is adopted on entry — the common workflow is unchanged", async ({ page }) => {
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `${TAG} Focused`, start_time: new Date(Date.now() - 3600e3).toISOString(),
        duration_minutes: 600, timezone: "UTC",
      },
    });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const comp = (await cr.json()).competition;
    await api.dispose();

    await adminLogin(page);
    await clickTab(page, "Events");
    // The event is OPEN in its workspace (what the old focus was), and Analytics
    // is entered through the workspace's own section tab, which keeps the event.
    await page.evaluate((c) => window.openEventWorkspace(c.id, c.name), comp);
    await page.locator("#admin-workspace:not([hidden])").waitFor({ timeout: 10000 });

    let calls = 0;
    page.on("request", (r) => { if (r.url().includes("/api/admin/analytics/challenges")) calls++; });
    await page.locator("#ws-tabs [data-section='admin-analytics-tab']").evaluate((el) => el.click());
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 10000 });
    // Adopted, queried and painted — one click, exactly as before.
    await expect.poll(() => calls, { timeout: 10000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => window._analyticsState && window._analyticsState.scope),
      "the focused competition is adopted rather than prompting").toBe("competition");
    await expect(page.locator("#analytics-summary")).not.toContainText("Choose what to measure");
  });

  test("the SIDEBAR's Analytics leaves the workspace: an event it only inherited is dropped, one chosen in the pane stays", async ({ page }) => {
    // The sidebar is the page about every event (ui/nav.js adminTab closes the
    // workspace first), so it must never paint the event a workspace once handed
    // it — but a scope the admin chose inside the pane is theirs and is kept.
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const mk = async (label) => {
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `${TAG} ${label}`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      return (await cr.json()).competition;
    };
    const x = await mk("Sidebar X"), y = await mk("Sidebar Y");
    await api.dispose();

    const queried = [];
    page.on("request", (r) => { const u = r.url(); if (u.includes("/api/admin/analytics/challenges")) queried.push(new URL(u).searchParams.get("competitionId")); });
    const state = () => page.evaluate(() => ({ scope: window._analyticsState.scope, competitionId: window._analyticsState.competitionId }));
    const openWs = async (c) => {
      await page.evaluate((cc) => window.openEventWorkspace(cc.id, cc.name), c);
      await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId)).toBe(c.id);
    };

    await adminLogin(page);
    await clickTab(page, "Events");
    // X's workspace hands its event to the Analytics section (the adoption).
    await openWs(x);
    await page.locator("#ws-tabs [data-section='admin-analytics-tab']").evaluate((el) => el.click());
    await expect.poll(() => queried.includes(x.id), { message: "PRECONDITION: X was adopted and measured", timeout: 10000 }).toBe(true);

    // Back to Events, open Y, then the SIDEBAR's Analytics.
    await clickTab(page, "Events");
    await openWs(y);
    const before = queried.length;
    await rawOpenAnalytics(page);
    await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId), { message: "PRECONDITION: the sidebar door left the workspace" }).toBeFalsy();
    await expect(page.locator("#analytics-summary"), "it asks, rather than painting X").toContainText("Choose what to measure");
    expect(await state(), "the inherited event is gone").toEqual({ scope: null, competitionId: null });
    expect(queried.slice(before), "nothing was measured on the way in").toEqual([]);

    // CONTROL: a scope chosen INSIDE the pane survives the same round trip.
    await page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="competition"]').click();
    await page.locator('[data-action="analytics-open-comp-picker"]').click();
    await page.locator(`#analytics-picker-overlay [data-action="analytics-pick-comp"][data-comp-id="${x.id}"]`).click();
    await expect.poll(() => queried.slice(before).includes(x.id), { message: "X chosen in the pane is measured", timeout: 10000 }).toBe(true);
    await clickTab(page, "Events");
    await openWs(y);
    await rawOpenAnalytics(page);
    await expect.poll(() => state(), { message: "the pane's own choice is kept", timeout: 10000 }).toEqual({ scope: "competition", competitionId: x.id });
    await expect(page.locator("#analytics-summary")).not.toContainText("Choose what to measure");
  });
});
