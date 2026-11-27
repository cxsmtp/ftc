// @ts-check
//
// v7.16.7 — browser locks for the Phase-0 client fixes.
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE } = require("./helpers");

test.use({ baseURL: BASE });

async function adminPage(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => typeof window._sortLogRows === "function", { timeout: 20000 });
}

test.describe("Phase-0 client correctness (v7.16.7)", () => {
  test("log rows sort by SEVERITY, not alphabetically, and numeric columns compare as numbers", async ({ page }) => {
    await adminPage(page);
    const out = await page.evaluate(() => {
      const rows = [{ level: "warn" }, { level: "debug" }, { level: "error" }, { level: "info" }];
      window.S._logsSortCol = "level"; window.S._logsSortDir = "desc";
      const bySeverity = window._sortLogRows(rows).map(r => r.level);
      // A real 0 must stay a 0; a missing value must not become one.
      const ms = [{ ms: 5 }, { ms: null }, { ms: 30 }, { ms: 200 }, { ms: 9 }, { ms: 0 }];
      window.S._logsSortCol = "ms"; window.S._logsSortDir = "asc";
      const byMs = window._sortLogRows(ms).map(r => String(r.ms));
      return { bySeverity, byMs };
    });
    expect(out.bySeverity,
      "descending 'level' must put errors FIRST — alphabetical buried them between debug and info"
    ).toEqual(["error", "warn", "info", "debug"]);
    expect(out.byMs.slice(0, 5),
      "numeric ascending: a single missing value used to send the whole column down the string path, where 9 sorts after 100"
    ).toEqual(["0", "5", "9", "30", "200"]);
    expect(out.byMs[5], "a missing value sinks, and is NOT coerced to zero").toBe("null");
  });

  test("sorting the competitions table does not reorder the canonical array", async ({ page }) => {
    await adminPage(page);
    await page.evaluate(() => window.loadAdminCompetitions());
    await page.waitForFunction(() => (window.S.adminCompetitionsData || []).length > 1, { timeout: 15000 });
    const before = await page.evaluate(() => window.S.adminCompetitionsData.map(c => c.id));
    // Sort by a column, twice, in both directions.
    await page.evaluate(() => { window.S.cSortCol = "name"; window.S.cSortAsc = true; window.renderAdminCompetitions(); });
    await page.evaluate(() => { window.S.cSortCol = "name"; window.S.cSortAsc = false; window.renderAdminCompetitions(); });
    const after = await page.evaluate(() => window.S.adminCompetitionsData.map(c => c.id));
    expect(after,
      "renderAdminCompetitions used to sort S.adminCompetitionsData IN PLACE, permanently reordering the array " +
      "the scope banner, switcher and timeslot dialogs all look competitions up in"
    ).toEqual(before);
  });

  // Retired: "the scope switcher shows the competition you are currently
  // viewing, even if it has ended". The switcher is gone — events are opened
  // from the Events list into their own workspace, whose header always names
  // the open event and its status.
});
