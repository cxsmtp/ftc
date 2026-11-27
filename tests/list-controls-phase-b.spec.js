// @ts-check
//
// v7.20.8 — the shared multiselect filter, and bounded rankings boards.
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE } = require("./helpers");
const { narrowGroupsTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });
const GUH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

async function adminPage(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: GUH(csrfToken),
    data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

test.describe("The shared multiselect filter (v7.20.8)", () => {
  test("it narrows the group chips AND keeps the picks already made", async ({ page }) => {
    // The load-bearing half is the second one. These are MULTISELECTS: a filter
    // that re-rendered the list would drop the ticks the operator had already
    // made, which is the single most annoying way to lose work in a dialog. The
    // implementation hides non-matching items instead.
    const csrf = await adminPage(page);
    const stamp = Date.now();
    for (let i = 0; i < 10; i++) {
      const name = i === 3 ? `Needle ${stamp}` : `Filler group ${i} ${stamp}`;
      const r = await page.request.post("/api/admin/groups", { headers: GUH(csrf), data: { name } });
      expect(r.ok(), `seed group ${i}: ${r.status()}`).toBeTruthy();
    }

    await page.locator("button[data-tab-id='admin-participants-tab']").click();
    await page.locator("[data-action='open-invite-dialog'], #invite-btn").first().click();
    await page.locator("#invite-group-filter").waitFor({ state: "visible", timeout: 15000 });

    const chips = page.locator(".invite-group-pick");
    const before = await chips.count();
    expect(before, "there are enough groups for the filter to appear").toBeGreaterThan(8);

    // Pick one, THEN filter — the pick must survive.
    const needle = chips.filter({ hasText: `Needle ${stamp}` }).first();
    await needle.click();
    await expect(needle).toHaveAttribute("aria-pressed", "true");

    await page.locator("#invite-group-filter").fill("Filler group 5");
    await expect(chips.filter({ visible: true })).toHaveCount(1);
    // Still selected, even though it is hidden — the state lives on the element.
    await expect(needle, "a filter must not clear a selection already made")
      .toHaveAttribute("aria-pressed", "true");

    await page.locator("#invite-group-filter").fill(`Needle ${stamp}`);
    await expect(chips.filter({ visible: true })).toHaveCount(1);
    await expect(chips.filter({ visible: true }).first()).toHaveAttribute("aria-pressed", "true");

    // A miss says so rather than showing an empty box.
    await page.locator("#invite-group-filter").fill("zzz-no-such-group");
    await expect(chips.filter({ visible: true })).toHaveCount(0);
    await expect(page.locator("#invite-group-filter-empty")).toBeVisible();
  });

  test("the group→competitions dialog filters too, without losing ticks", async ({ page }) => {
    const csrf = await adminPage(page);
    const stamp = Date.now();
    for (let i = 0; i < 10; i++) {
      await page.request.post("/api/admin/competitions", { headers: GUH(csrf), data: {
        name: i === 4 ? `GcNeedle ${stamp}` : `GcFiller ${i} ${stamp}`,
        start_time: new Date(stamp + 3600_000).toISOString(), duration_minutes: 60 } });
    }
    const g = (await (await page.request.post("/api/admin/groups", { headers: GUH(csrf),
      data: { name: `GcGroup ${stamp}` } })).json()).group.id;

    await page.locator("button[data-tab-id='admin-groups-tab']").click();
    await narrowGroupsTable(page, `GcGroup ${stamp}`);   // v9.2.4 — waits out the re-render the click below could straddle
    await page.locator(`button[data-action='group-bind-comps'][data-group-id='${g}']`).click();
    await page.locator("#gc-filter").waitFor({ state: "visible", timeout: 15000 });

    const boxes = page.locator("#gc-list .gc-cb");
    expect(await boxes.count(), "enough competitions for the filter").toBeGreaterThan(8);
    const needleRow = page.locator("#gc-list label").filter({ hasText: `GcNeedle ${stamp}` }).first();
    await needleRow.locator(".gc-cb").check();

    await page.locator("#gc-filter").fill(`GcFiller 2 ${stamp}`);
    await expect(page.locator("#gc-list label").filter({ visible: true })).toHaveCount(1);
    await expect(needleRow.locator(".gc-cb"), "the tick survives filtering").toBeChecked();
  });
});

test.describe("Rankings boards are bounded (v7.20.8)", () => {
  test("a long board shows the top 50 and can be expanded", async ({ page }) => {
    // A ranking is not paged, deliberately: paging would break the continuity
    // that makes standings readable. It is capped with an expander instead.
    await adminPage(page);
    // No tab navigation: renderLeaderboardTable is a pure function, so driving
    // it directly tests the cap without depending on the Rankings tab having a
    // competition to show — which is worker-DB state this test does not own.
    await page.waitForFunction(() => typeof window.renderLeaderboardTable === "function", { timeout: 20000 });

    // A known 120-row board — the subject is the cap, not the aggregation.
    const html = await page.evaluate(() => {
      const board = Array.from({ length: 120 }, (_, i) => ({
        userId: `u${i}`, rank: i + 1, nickname: `player${i}`, avatar: "🦊",
        score: 1000 - i, solveTimeMs: 60000 + i, allSolved: false, isBenchmark: false,
      }));
      return window.renderLeaderboardTable(board, "main");
    });
    const rowCount = (html.match(/<tr>/g) || []).length;
    expect(rowCount, "capped at the documented page size").toBe(50);
    expect(html, "and it says what it is showing").toContain("Showing the top 50 of 120");
    expect(html, "with a way to see the rest").toContain("Show all 120");

    // A SHORT board gets no expander at all — the control must not appear when
    // there is nothing hidden.
    const short = await page.evaluate(() => window.renderLeaderboardTable(
      Array.from({ length: 5 }, (_, i) => ({ userId: `s${i}`, rank: i + 1, nickname: `p${i}`,
        avatar: "🦊", score: 10 - i, solveTimeMs: 1000, allSolved: false, isBenchmark: false })), "main"));
    expect(short).not.toContain("Show all");
    expect((short.match(/<tr>/g) || []).length).toBe(5);
  });
});
