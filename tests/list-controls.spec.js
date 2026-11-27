// @ts-check
//
// v7.17.1 — the extracted list chrome. These are unit assertions over pure
// functions, so they are cheap and they pin the contract the six migrated
// surfaces depend on.
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE } = require("./helpers");

test.use({ baseURL: BASE });

async function inPage(page, fn, arg) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  await page.request.post("/api/login", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { email: "superadmin", password: getSuperadminPass() },
  });
  await page.goto("/");
  await page.waitForFunction(() => typeof window.paginationHtml === "function", { timeout: 20000 });
  return page.evaluate(fn, arg);
}

test.describe("list-controls (v7.17.1)", () => {
  test("the action names stay per-surface, because tests and handlers key on them", async ({ page }) => {
    const html = await inPage(page, () => window.paginationHtml("tasks",
      { page: 1, totalPages: 3, totalLabel: "70 total", pageSize: 30 }));
    for (const a of ["tasks-page-first", "tasks-page-prev", "tasks-page-next", "tasks-page-last"]) {
      expect(html, `${a} must be emitted verbatim — ui-admin/ui-participant locate these by name`).toContain(a);
    }
    expect(html, "and the page-size select keeps its own change-action").toContain('data-change-action="tasks-page-size"');
    expect(html, "a generic list-page action would break those assertions for no behavioural gain")
      .not.toContain('data-action="list-page');
  });

  test("edges are disabled at the ends, and can be overridden where the total is approximate", async ({ page }) => {
    const out = await inPage(page, () => ({
      first: window.paginationHtml("x", { page: 1, totalPages: 3, totalLabel: "t", pageSize: 30 }),
      last: window.paginationHtml("x", { page: 3, totalPages: 3, totalLabel: "t", pageSize: 30 }),
      // Logs walks rotated files with a scan budget, so it knows hasPrev/hasNext
      // but not a true totalPages — it renders "N+".
      logs: window.paginationHtml("logs", { page: 2, totalPages: 4, pagesLabel: "4+", totalLabel: "200+ total", pageSize: 50, hasPrev: true, hasNext: true }),
    }));
    expect(out.first.match(/x-page-first" disabled/), "First is disabled on page 1").toBeTruthy();
    expect(out.first.match(/x-page-next" disabled/), "…but Next is not").toBeFalsy();
    expect(out.last.match(/x-page-last" data-total-pages="3" disabled/), "Last is disabled on the final page").toBeTruthy();
    expect(out.logs, "an approximate page count renders as given").toContain("Page 2 of 4+");
    expect(out.logs.match(/logs-page-next" disabled/), "hasNext:true overrides the page/totalPages derivation").toBeFalsy();
  });

  test("paginate clamps rather than returning an empty page", async ({ page }) => {
    const out = await inPage(page, () => {
      const rows = Array.from({ length: 65 }, (_, i) => i);
      return {
        beyond: window.paginate(rows, { page: 99, pageSize: 30 }),
        zero: window.paginate(rows, { page: 0, pageSize: 30 }),
        empty: window.paginate([], { page: 1, pageSize: 30 }),
      };
    });
    // A page number can go stale — a filter narrows the list while the operator
    // is on page 4. Clamping is what stops that rendering as "no results".
    expect(out.beyond.page, "an over-range page clamps to the last one").toBe(3);
    expect(out.beyond.visible.length, "…and still returns rows").toBe(5);
    expect(out.zero.page, "a zero/negative page clamps to 1").toBe(1);
    expect(out.empty.totalPages, "an empty list is one page, not zero — otherwise the bar reads 'Page 1 of 0'").toBe(1);
  });

  test("search matches case-insensitively across every field a row exposes", async ({ page }) => {
    const out = await inPage(page, () => {
      const row = { name: "Spring Hackathon", owner: "Alice O'Hara", count: 42, missing: null };
      const hay = r => [r.name, r.owner, r.count, r.missing];
      return {
        caseless: window.matchesQuery(row, "SPRING", hay),
        other: window.matchesQuery(row, "o'hara", hay),
        numeric: window.matchesQuery(row, "42", hay),
        miss: window.matchesQuery(row, "zzz", hay),
        blank: window.matchesQuery(row, "   ", hay),
      };
    });
    expect(out.caseless).toBe(true);
    expect(out.other, "a second field is searched too").toBe(true);
    expect(out.numeric, "non-string values are coerced, not skipped").toBe(true);
    expect(out.miss).toBe(false);
    expect(out.blank, "a whitespace-only query matches everything rather than nothing").toBe(true);
  });
});
