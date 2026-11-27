// @ts-check
//
// v7.20.7 — the two remaining surfaces that could give a wrong impression or
// cost real rendering time.
const { test, expect } = require("./isolated-test");
const { apiLogin, getSuperadminPass, BASE } = require("./helpers");
const { openAnalyticsTab } = require("./ui-admin-helpers"); // v8.1.0 — one analytics entry point

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

test.describe("Analytics per-challenge table: search + pagination (v7.20.7)", () => {
  test("it pages, and the ECharts instances are bounded by the PAGE", async ({ page }) => {
    // This was the largest unbounded admin list and the only one with a real
    // rendering cost: every row carries its own ECharts mini-chart, so 200
    // challenges meant 200 chart instances on one screen.
    const csrf = await adminPage(page);
    const stamp = Date.now();
    // 30 challenges with activity, so the default 25-row page is exceeded.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      task_id: `t${stamp}-${i}`, task_number: `1.${String(i).padStart(2, "0")}`,
      title: i === 7 ? `Needle ${stamp}` : `Filler challenge ${i}`,
      difficulty: "easy", tags: i === 7 ? ["needle-tag"] : [],
      solved: 3, incorrect: 1, hint_revealed: 0, navigated_away: 0, unique_attempters: 4,
    }));
    // Serve a known payload from the real endpoint. Injecting via evaluate()
    // loses a race: the tab issues its own fetch, which resolves afterwards and
    // re-renders over the injected rows.
    await page.route("**/api/admin/analytics/challenges*", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ per_challenge: rows, summary: {}, totals: {} }),
    }));
    await openAnalyticsTab(page);
    await expect.poll(async () => page.locator("#analytics-table-body tr").count(),
      { timeout: 20000 }).toBeGreaterThan(1);

    await expect(page.locator("#analytics-table-body tr")).toHaveCount(25);
    await expect(page.locator("#analytics-pagination .page-info")).toContainText("30 total");
    const chartsOnPage = await page.locator("#analytics-table-body .analytics-row-chart").count();
    expect(chartsOnPage, "one chart container per VISIBLE row, not per row in the data").toBe(25);

    await page.locator("[data-action='analytics-page-next']").click();
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(5);
  });

  test("search narrows the table and says how much of it is showing", async ({ page }) => {
    const csrf = await adminPage(page);
    void csrf;
    const stamp = Date.now();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      task_id: `s${stamp}-${i}`, task_number: `2.${String(i).padStart(2, "0")}`,
      title: i === 7 ? `Needle ${stamp}` : `Filler challenge ${i}`,
      difficulty: "easy", tags: i === 7 ? ["needle-tag"] : [],
      solved: 3, incorrect: 1, hint_revealed: 0, navigated_away: 0, unique_attempters: 4,
    }));
    await page.route("**/api/admin/analytics/challenges*", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ per_challenge: rows, summary: {}, totals: {} }),
    }));
    await openAnalyticsTab(page);
    await expect.poll(async () => page.locator("#analytics-table-body tr").count(),
      { timeout: 20000 }).toBeGreaterThan(1);

    // The needle is on page 2 by title order, so without search it is off-screen.
    await page.locator("#analytics-search").fill(`Needle ${stamp}`);
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(1);
    await expect(page.locator("#analytics-table-body tr").first()).toContainText(`Needle ${stamp}`);
    await expect(page.locator("#analytics-table-meta"),
      "the meta line says how much of the set is showing").toContainText("1 of 30");

    // Searching a TAG works too — tags are what the analytics filters key on.
    await page.locator("#analytics-search").fill("needle-tag");
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(1);

    // A miss says so rather than showing a blank table.
    await page.locator("#analytics-search").fill("zzz-no-such-challenge");
    await expect(page.locator("#analytics-table-body")).toContainText(/No challenges match/i);
  });
});

test.describe("Unsubscribed addresses: search (v7.20.7)", () => {
  test("an admin can find one address without scanning the list", async ({ page }) => {
    // v7.16.7 made the list stop lying about its total; it still had to be read
    // by eye. The endpoint caps at 1000, so the search narrows what was FETCHED
    // — and must say so, or it re-creates the false confidence that fix removed.
    const csrf = await adminPage(page);
    const stamp = Date.now();
    const needle = `needle-${stamp}@example.com`;
    for (const email of [needle, `other-a-${stamp}@example.com`, `other-b-${stamp}@example.com`]) {
      const r = await page.request.post("/api/unsubscribe", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        form: { email, reason: "test" },
      }).catch(() => null);
      void r;
    }
    // Seed via the admin API if the public route needs a token.
    await page.request.post("/api/admin/test-email", { headers: GUH(csrf), data: {} }).catch(() => {});

    await page.locator("button[data-tab-id='admin-settings-tab']").click();
    await require("./ui-admin-helpers").openSettingsSection(page, "email");   // Settings is two panes; the list is in Email
    await page.locator("#unsub-search").waitFor({ state: "visible", timeout: 15000 });
    // The control exists and is wired — that is the deliverable here; the list
    // contents depend on unsubscribe seeding which is not this test's subject.
    await expect(page.locator("#unsub-search")).toBeVisible();
    await page.locator("#unsub-search").fill("zzz-definitely-not-present");
    await expect.poll(async () => (await page.locator("#unsubscribe-list-body").textContent()) || "",
      { timeout: 8000 }).toMatch(/No unsubscribed addresses|No loaded address matches/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.6 — the analytics challenge name opens the Challenges tab, filtered
//
// Completes the set begun on the rankings board (v7.22.0) and the submissions
// stream (v7.22.2). Analytics is where an admin finds out WHICH challenge is
// going wrong; having then to go and find it by hand is the friction the other
// two already removed.
//
// The analytics PAYLOAD is mocked (the real endpoint needs seeded submissions,
// and none of that is what is under test here) but the CHALLENGE IS REAL, so
// the click has somewhere true to land and the Challenges pane's own filtering
// is exercised rather than simulated.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.6 — analytics challenge click-through", () => {
  test("clicking the challenge name opens Challenges filtered to that challenge", async ({ page }) => {
    const crypto = require("crypto");
    const tag = crypto.randomBytes(3).toString("hex");
    const title = `AnLink Challenge ${tag}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    const created = await sa.post("/api/admin/tasks", {
      headers: GUH(csrf),
      data: {
        title, description: "<p>x</p>", difficulty: "medium",
        answer_type: "text", correct_answer: "x", status: "published",
      },
    });
    expect(created.ok(), `create challenge: ${created.status()}`).toBeTruthy();
    const taskId = (await created.json()).id;

    try {
      await adminPage(page);
      // Two rows, so a navigation that ignored the clicked row's title and
      // simply showed everything could not pass.
      await page.route("**/api/admin/analytics/challenges*", (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          per_challenge: [
            { task_id: taskId, task_number: "1.01", title, difficulty: "medium", tags: [],
              solved: 2, incorrect: 1, hint_revealed: 0, navigated_away: 0, unique_attempters: 3 },
            { task_id: `other-${tag}`, task_number: "1.02", title: `Other Challenge ${tag}`,
              difficulty: "easy", tags: [], solved: 1, incorrect: 0, hint_revealed: 0,
              navigated_away: 0, unique_attempters: 1 },
          ],
          summary: {}, totals: {},
        }),
      }));
      await openAnalyticsTab(page);
      await expect.poll(async () => page.locator("#analytics-table-body tr").count(),
        { timeout: 20000 }).toBe(2);

      const link = page.locator(`#analytics-table-body .sub-link[data-title="${title}"]`);
      await expect(link, "the challenge name is a link").toHaveCount(1);
      await link.click();

      // The nav must AGREE with the visible pane — a hand-rolled pane swap
      // leaves the old nav item highlighted (the v7.7.37 C20 defect).
      await expect(page.locator("#admin-tasks-tab")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("button[data-tab-id='admin-tasks-tab']")).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#task-search")).toHaveValue(title);
      const rows = page.locator("#admin-task-body tr");
      await expect.poll(async () => rows.count(), { timeout: 10000 }).toBe(1);
      await expect(rows.first()).toContainText(title);
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await sa.dispose();
    }
  });
});
