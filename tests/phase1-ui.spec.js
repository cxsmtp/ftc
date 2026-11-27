// @ts-check
//
// v7.17.0 — Phase 1 of the long-list remediation.
//
// Two changes, both prerequisites for the pagination work that follows:
//   • the import conflict modal keeps its resolutions in a MODEL, not the DOM
//   • sorting the rankings re-renders from cached boards instead of refetching
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
  await page.waitForFunction(() => typeof window.showConflictModal === "function", { timeout: 20000 });
}

test.describe("Import conflict resolutions survive outside the DOM (v7.17.0)", () => {
  test("a row removed from the DOM is IMPORTED with its real resolution, not silently as 'keep'", async ({ page }) => {
    await adminPage(page);

    // Intercept the import so nothing reaches the server — what matters is the
    // body the client builds. Asserting on the in-memory model instead would be
    // vacuous: the model is set by setAllConflictResolutions, so it stays
    // correct even when executeConflictImport ignores it and reads the DOM.
    // (Verified: that version of this test passed against the unfixed code.)
    let sent = null;
    await page.route("**/api/admin/import/participants", async (route) => {
      sent = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ imported: 0, overwritten: 0, skipped: 0 }) });
    });

    await page.evaluate(async () => {
      const conflicts = [
        { index: 0, nickname: "alpha", email: "a@x.com", conflictType: "nickname" },
        { index: 1, nickname: "beta",  email: "b@x.com", conflictType: "nickname" },
      ];
      window.showConflictModal("participants", { participants: [{}, {}] }, conflicts);
      window.setAllConflictResolutions("overwrite");
      // Remove row 1 from the DOM — what pagination or virtualisation does.
      document.querySelectorAll('input[name="res-1"]').forEach(el => el.remove());
      await window.executeConflictImport("participants");
    });
    await expect.poll(() => sent, { timeout: 10000 }).not.toBeNull();

    expect(sent.resolutions["0"], "the on-screen row is unaffected").toBe("overwrite");
    expect(sent.resolutions["1"],
      "the OFF-SCREEN row must import with the resolution the operator chose. Reading the DOM here " +
      "returned nothing and fell back to 'keep' — a silent, wrong import with no error shown."
    ).toBe("overwrite");
  });

  test("'All: Overwrite' sets every conflict, including rows not rendered", async ({ page }) => {
    await adminPage(page);
    const choices = await page.evaluate(() => {
      const conflicts = [0, 1, 2].map(i => ({ index: i, nickname: `n${i}`, email: `e${i}@x.com`, conflictType: "nickname" }));
      window.showConflictModal("participants", { participants: [{}, {}, {}] }, conflicts);
      const ov = document.getElementById("conflict-overlay");
      document.querySelectorAll('input[name="res-2"]').forEach(el => el.remove()); // off-screen row
      window.setAllConflictResolutions("rename");
      return [...ov._res.values()].map(r => r.choice);
    });
    expect(choices,
      "a button labelled 'All' must mean all — ticking only the visible radios would leave the " +
      "off-screen row on its previous choice while claiming otherwise"
    ).toEqual(["rename", "rename", "rename"]);
  });
});

test.describe("Sorting the rankings does not refetch (v7.17.0)", () => {
  test("a column click re-renders from cached boards and issues no request", async ({ page }) => {
    await adminPage(page);
    await page.evaluate(() => window.loadAdminCompetitions());
    await page.evaluate(() => { window.S.adminSelectedCompetitionId = null; window.loadAdminRankingsTab(); });
    // Let the initial load settle — that one IS allowed to fetch. v8.12.4 — and
    // it must have RENDERED a board, or a sort over nothing issues no request
    // for the wrong reason (no live event → "select a live event" and no table).
    // (The pane is loaded without being shown, so the board is asserted in the
    // DOM rather than on screen.)
    await expect.poll(() => page.locator("#admin-rankings-content table").count(), { timeout: 15000,
      message: "a live event's board was rendered" }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    const calls = [];
    page.on("request", (r) => { if (r.url().includes("/api/admin/leaderboard")) calls.push(r.url()); });

    await page.evaluate(() => window.sortRankings("main", "score"));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.sortRankings("main", "score"));   // reverse it
    await page.waitForTimeout(800);

    expect(calls,
      "sorting is a pure operation over data already in hand; this path used to re-issue one " +
      `/api/admin/leaderboard request per competition per timeslot on every click (got: ${calls.length})`
    ).toEqual([]);
  });

  test("an explicit Refresh still fetches", async ({ page }) => {
    // The cache must not make the data stale forever — the positive control
    // without which "no requests" could be satisfied by a broken load path.
    await adminPage(page);
    await page.evaluate(() => { window.S.adminSelectedCompetitionId = null; window.loadAdminRankingsTab(); });
    await page.waitForTimeout(1500);
    const calls = [];
    page.on("request", (r) => { if (r.url().includes("/api/admin/leaderboard")) calls.push(r.url()); });
    await page.evaluate(() => window.loadAdminRankingsTab());
    await page.waitForTimeout(1500);
    expect(calls.length, "a genuine refresh must go to the network").toBeGreaterThan(0);
  });
});
