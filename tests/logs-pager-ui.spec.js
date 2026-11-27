// @ts-check
//
// v7.25.0 — the Logs pager: jump to a page, ±10, and a note that tells the
// truth about which rows were ranked.
//
// EVERY TEST HERE MOCKS `/api/admin/logs`. That is deliberate, not laziness:
// the access log is written by the test's own traffic (including the pane's own
// 15-second poll), so a real fixture's `total` and `total_pages` move between
// the read and the assertion and every clamp assertion would flake. The SERVER
// contract is exercised for real in logs-global-sort.api.spec.js; what is under
// test here is what the client does with each answer — including the answers a
// real server gives rarely and an operator meets at the worst moment.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

// A response body of the shape the endpoint now returns.
function body(over = {}) {
  const total = over.total ?? 600;
  const limit = over.limit ?? 50;
  const page = over.page ?? 1;
  const rows = [];
  for (let i = 0; i < Math.min(limit, Math.max(0, total - (page - 1) * limit)); i++) {
    const n = (page - 1) * limit + i;
    rows.push({ ts: new Date(Date.parse("2001-06-12T00:00:00.000Z") + n * 1000).toISOString(), level: "info", msg: `mock row-${n}` });
  }
  return {
    entries: rows, file: null, files_scanned: [`app-2001-06-12.jsonl`],
    count: rows.length, total, offset: (page - 1) * limit, limit,
    truncated: false, redacted: false, anchor_ts: rows.length ? rows[0].ts : null,
    sort: null, dir: null,
    sortable_globally: true, sorted_globally: false, sort_scope: "default",
    sort_unavailable: null, sort_max_window: 25000,
    total_exact: true, truncated_reason: null,
    total_pages: Math.max(1, Math.ceil(total / limit)), scanned: total,
    ...over,
  };
}

/** Route the logs endpoint through `fn(url) -> body`, and record every request. */
async function mockLogs(page, fn) {
  const seen = [];
  await page.route("**/api/admin/logs?**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fn(url)) });
  });
  return seen;
}

const openLogs = async (page) => {
  await adminLogin(page);
  await clickTab(page, "Logs");
  await expect(page.locator("#admin-logs-tab .card.table-card table")).toBeVisible({ timeout: 10000 });
};

test.describe("Logs pager (v7.25.0)", () => {
  test("jump-by-number lands on the page the operator typed, with its real rows", async ({ page }) => {
    await mockLogs(page, (url) => body({ page: Math.floor(Number(url.searchParams.get("offset") || 0) / 50) + 1 }));
    await openLogs(page);
    const jump = page.locator("#logs-page-jump");
    await expect(jump).toBeVisible();
    await page.locator("#logs-page-input").fill("7");
    await page.locator("#logs-page-jump button[data-action='logs-page-goto']").click();
    await expect(page.locator("#logs-pagination .page-info")).toContainText("Page 7 of 12");
    // Assert the CONTENT, not only the label: a jump that moved the label and
    // not the offset would pass a label check. (Row ORDER within the page is
    // the client's default ts-DESC reorder — not what this test is about.)
    await expect(page.locator("#logs-body")).toContainText("row-300");
    await expect(page.locator("#logs-body")).toContainText("row-349");
  });

  test("an over-range page CLAMPS to the last one and says so, rather than emptying the table", async ({ page }) => {
    await mockLogs(page, (url) => body({ page: Math.floor(Number(url.searchParams.get("offset") || 0) / 50) + 1 }));
    await openLogs(page);
    await page.locator("#logs-page-input").fill("999");
    await page.locator("#logs-page-jump button[data-action='logs-page-goto']").click();
    await expect(page.locator("#logs-pagination .page-info")).toContainText("Page 12 of 12");
    await expect(page.locator("#logs-page-jump-note")).toContainText("does not exist — showing page 12");
    await expect(page.locator("#logs-body")).toContainText("row-550");
  });

  test("a non-numeric jump refuses without moving, and an EMPTY box is silent", async ({ page }) => {
    // The empty case is the one that bites: clicking Go blurs the input, which
    // fires `change`, which jumps and clears the value — and then the button's
    // own click arrives at an empty box. Without the silent no-op the operator
    // would be told they had not entered a page number after a jump that worked.
    await mockLogs(page, (url) => body({ page: Math.floor(Number(url.searchParams.get("offset") || 0) / 50) + 1 }));
    await openLogs(page);
    await page.locator("#logs-page-input").fill("abc");
    await page.locator("#logs-page-jump button[data-action='logs-page-goto']").click();
    await expect(page.locator("#logs-page-jump-note")).toContainText("Enter a page number.");
    await expect(page.locator("#logs-pagination .page-info")).toContainText("Page 1 of 12");

    // Now a real jump followed by the button-after-change sequence.
    await page.locator("#logs-page-input").fill("4");
    await page.locator("#logs-page-jump button[data-action='logs-page-goto']").click();
    await expect(page.locator("#logs-pagination .page-info")).toContainText("Page 4 of 12");
    await page.locator("#logs-page-jump button[data-action='logs-page-goto']").click();
    await expect(page.locator("#logs-page-jump-note")).toHaveText("");
    await expect(page.locator("#logs-pagination .page-info")).toContainText("Page 4 of 12");
  });

  test("+10 / -10 move ten pages and clamp at both ends", async ({ page }) => {
    await mockLogs(page, (url) => body({ page: Math.floor(Number(url.searchParams.get("offset") || 0) / 50) + 1 }));
    await openLogs(page);
    const info = page.locator("#logs-pagination .page-info");
    await page.locator("button[data-action='logs-page-fwd10']").click();
    await expect(info).toContainText("Page 11 of 12");
    // +10 from 11 would be 21: it must clamp to the real last page, not render
    // an empty table that reads as "no matches".
    await page.locator("button[data-action='logs-page-fwd10']").click();
    await expect(info).toContainText("Page 12 of 12");
    await expect(page.locator("#logs-body")).toContainText("row-550");
    await page.locator("button[data-action='logs-page-back10']").click();
    await expect(info).toContainText("Page 2 of 12");
    await page.locator("button[data-action='logs-page-back10']").click();
    await expect(info).toContainText("Page 1 of 12");
  });

  test("an approximate total disables the jump AND says why", async ({ page }) => {
    // Gate the affordance and the explanation together: a silently-disabled box
    // is the same support ticket as a silently-shrinking menu.
    await mockLogs(page, () => body({ total_exact: false, truncated: true, truncated_reason: "early_stop", sortable_globally: false }));
    await openLogs(page);
    await expect(page.locator("#logs-page-input")).toBeDisabled();
    await expect(page.locator("#logs-page-jump button[data-action='logs-page-goto']")).toBeDisabled();
    await expect(page.locator("#logs-page-jump-note")).toContainText("exact count");
    await expect(page.locator("button[data-action='logs-page-last']")).toBeDisabled();
    // …and the count beside the search box must agree with the pager, or one
    // screen carries two answers to the same question.
    await expect(page.locator("#logs-pagination .page-info")).toContainText("+");
  });

  test("the ordering note reports what the SERVER did, in all four states", async ({ page }) => {
    // The note is the only thing on screen that says which rows were ranked, so
    // it must come from the server's echo rather than from the client's guess
    // about whether a filter is applied.
    let mode = "global";
    await mockLogs(page, () => {
      if (mode === "global") return body({ sorted_globally: true, sort_scope: "global", sort: "level", dir: "desc" });
      if (mode === "budget") return body({ sorted_globally: false, sortable_globally: true, sort_unavailable: "scan_budget", truncated: true, total_exact: false, truncated_reason: "scan_budget" });
      if (mode === "deep") return body({ sorted_globally: false, sortable_globally: false, sort_unavailable: "window_too_deep" });
      return body({ sorted_globally: false, sortable_globally: false, sort_unavailable: "unfiltered" });
    });
    await openLogs(page);

    // Default ordering: no note at all.
    await expect(page.locator("#logs-pagination .page-scope-ok, #logs-pagination .page-scope-note, #logs-pagination .page-scope-warn")).toHaveCount(0);

    // One header click makes the ordering non-default; after that the MODE is
    // what varies, driven through an explicit reload. Clicking again would not
    // do: a click only refetches while the server says the set is rankable, so
    // the mode change would silently not reach the client.
    await page.locator("#admin-logs-tab th[data-col='level']").click();
    await expect(page.locator("#logs-pagination .page-scope-ok")).toHaveText("Sorted across all matches");
    await expect(page.locator("#logs-pagination .page-scope-note")).toHaveCount(0);

    const reload = () => page.evaluate(() => window.loadAdminLogs());

    mode = "budget"; await reload();
    await expect(page.locator("#logs-pagination .page-scope-warn")).toContainText("too many matches to rank");

    mode = "deep"; await reload();
    await expect(page.locator("#logs-pagination .page-scope-warn")).toContainText("too deep to rank");

    mode = "unfiltered"; await reload();
    await expect(page.locator("#logs-pagination .page-scope-note")).toHaveText("Sorted within this page");
  });

  test("a globally-sorted page is rendered in the SERVER's order, not re-sorted locally", async ({ page }) => {
    // The response order is deliberately one the client comparator would NOT
    // produce, or the assertion could not tell the two apart.
    const rows = [
      { ts: "2001-06-12T00:00:01.000Z", level: "debug", msg: "srv first" },
      { ts: "2001-06-12T00:00:03.000Z", level: "error", msg: "srv second" },
      { ts: "2001-06-12T00:00:02.000Z", level: "info", msg: "srv third" },
    ];
    await mockLogs(page, () => body({
      entries: rows, count: 3, total: 3, total_pages: 1,
      sorted_globally: true, sort: "level", dir: "desc", sort_scope: "global",
    }));
    await openLogs(page);
    await page.locator("#admin-logs-tab th[data-col='level']").click();
    await expect(page.locator("#logs-body tr")).toHaveCount(3);
    const msgs = await page.locator("#logs-body tr").allInnerTexts();
    expect(msgs[0]).toContain("srv first");
    expect(msgs[1]).toContain("srv second");
    expect(msgs[2]).toContain("srv third");
  });

  test("a header click REFETCHES with sort+dir when the server can rank globally", async ({ page }) => {
    const seen = await mockLogs(page, () => body({ sortable_globally: true }));
    await openLogs(page);
    const before = seen.length;
    await page.locator("#admin-logs-tab th[data-col='level']").click();
    await expect.poll(() => seen.length).toBeGreaterThan(before);
    const last = seen[seen.length - 1];
    expect(last.searchParams.get("sort")).toBe("level");
    expect(last.searchParams.get("dir")).toBe("desc");
    // A sort resets to page 1 and drops the anchor.
    expect(last.searchParams.get("offset")).toBe("0");
    expect(last.searchParams.has("anchor")).toBe(false);
  });

  test("the page-jump box survives a silent poll landing mid-type", async ({ page }) => {
    // The v7.20.10 defect, which here is not a cosmetic caret jump but a WRONG
    // PAGE: type 4, a poll re-renders the bar, type 7, and the box holds 7.
    //
    // Two things make this able to fail. `pressSequentially`, because `.fill()`
    // sets the value atomically and cannot reproduce it at all — which is why
    // two pre-existing tests drove other inputs and never caught the original.
    // And the poll must return DIFFERENT rows, or loadAdminLogs' identical-
    // entries short-circuit returns before the re-render and the input is never
    // in danger.
    let tick = 0;
    await mockLogs(page, () => body({ entries: [{ ts: "2001-06-12T00:00:00.000Z", level: "info", msg: `poll tick ${tick}` }], count: 1 }));
    await openLogs(page);
    const input = page.locator("#logs-page-input");
    await input.pressSequentially("4", { delay: 20 });
    tick++;
    // Braces: page.evaluate AWAITS a returned promise, and without them the poll
    // would complete before the next keystroke and the race could not happen.
    await page.evaluate(() => { window.loadAdminLogs({ silent: true }); });
    // A positive control that a re-render really did occur — otherwise "the
    // value survived" is equally satisfied by "nothing ran".
    await expect(page.locator("#logs-body")).toContainText("poll tick 1");
    await input.pressSequentially("7", { delay: 20 });
    await expect(input).toHaveValue("47");
  });

  test("the live-update pause is announced, not silent", async ({ page }) => {
    await mockLogs(page, () => body({ sortable_globally: true, sorted_globally: true, sort: "level", dir: "desc" }));
    await openLogs(page);
    await expect(page.locator("#logs-range-hint")).not.toContainText("Live updates paused");
    await page.locator("#admin-logs-tab th[data-col='level']").click();
    await expect(page.locator("#logs-range-hint")).toContainText("Live updates paused while sorted.");
  });

  test("a failed load stops the pager describing a table that is not there", async ({ page }) => {
    await page.route("**/api/admin/logs?**", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });
    await openLogs(page);
    await expect(page.locator("#logs-page-input")).toBeDisabled();
    // The explanation must not be written into a hidden subtree.
    await expect(page.locator("#logs-page-jump")).toBeVisible();
    await expect(page.locator("#logs-page-jump-note")).toContainText("Paging unavailable");
  });

  // RAW LOGS' AUDIT LOG PAGES LIKE THE AUDIT TRAIL (operator ruling, 17 Nov
  // 2026): the server counts only the first read and answers each later read
  // with no count and a cursor below its page. The pager keeps page 1's count,
  // goes Next by the cursor (no anchor, no offset), and Prev back by position.
  test("the Audit log keeps its first page's count and goes Next by its cursor", async ({ page }) => {
    const seen = await mockLogs(page, (url) => {
      const c = url.searchParams.get("cursor");
      if (!c) return body({ total: 120, next_cursor: "c1", has_more: true });
      return body({ page: c === "c1" ? 2 : 3, total: null, total_exact: false, total_pages: null,
        truncated_reason: "early_stop", next_cursor: c === "c1" ? "c2" : null, has_more: c === "c1" });
    });
    await openLogs(page);
    const info = page.locator("#logs-pagination .page-info");
    await expect(info).toContainText("Page 1 of 3 (120 total)");
    await page.locator("#logs-pagination [data-action='logs-page-next']").click();
    await expect(info, "page 1's count is kept").toContainText("Page 2 of 3 (120 total)");
    const next = seen[seen.length - 1];
    expect(next.searchParams.get("cursor"), "Next reads below page 1").toBe("c1");
    expect(next.searchParams.has("anchor")).toBe(false);
    expect(next.searchParams.get("offset")).toBe("0");
    await expect(page.locator("#logs-body")).toContainText("row-50");
    await page.locator("#logs-pagination [data-action='logs-page-prev']").click();
    await expect(info).toContainText("Page 1 of 3 (120 total)");
    const prev = seen[seen.length - 1];
    expect(prev.searchParams.has("cursor"), "page 1 is read from the top").toBe(false);
    expect(prev.searchParams.has("anchor")).toBe(false);
  });

  test("a search the scan budget cut says how far back it looked, and Next searches on", async ({ page }) => {
    const seen = await mockLogs(page, (url) => url.searchParams.get("cursor")
      ? body({ total: null, total_exact: false, total_pages: null, next_cursor: null, has_more: false, searched_to: null })
      : body({ total: 0, total_exact: false, truncated_reason: "scan_budget", has_more: true,
        searched_to: "2001-06-12T10:00:00.000Z", next_cursor: "c9" }));
    await openLogs(page);
    await expect(page.locator("#logs-body")).toContainText("No log entries match back to");
    await expect(page.locator("#logs-body")).toContainText("Next searches further back.");
    const next = page.locator("#logs-pagination [data-action='logs-page-next']");
    await expect(next, "Next is offered past the cut").toBeEnabled();
    await next.click();
    await expect.poll(() => seen[seen.length - 1].searchParams.get("cursor")).toBe("c9");
  });

  test("CONTROL: a search that found nothing, with nothing further back, says so and offers no Next", async ({ page }) => {
    await mockLogs(page, () => body({ total: 0, total_exact: true, has_more: false, next_cursor: null, searched_to: null }));
    await openLogs(page);
    await expect(page.locator("#logs-body")).toContainText("No log entries yet.");
    await expect(page.locator("#logs-body")).not.toContainText("back to");
    await expect(page.locator("#logs-pagination [data-action='logs-page-next']")).toBeDisabled();
  });

  // The pager moves when an answer lands, so a 15-second refresh fired while a
  // page move is still loading would supersede it (it reads page 1 again) and the
  // move would seem to do nothing. The refresh holds off until the move lands.
  test("a live refresh fired while a page move is loading does not swallow the move", async ({ page }) => {
    await page.addInitScript(() => {
      window.__intervals = new Map();
      const orig = window.setInterval;
      window.setInterval = function (fn, ms, ...rest) { const id = orig.call(this, fn, ms, ...rest); window.__intervals.set(id, fn); return id; };
    });
    let release; const held = new Promise((r) => { release = r; });
    const seen = [];
    await page.route("**/api/admin/logs?**", async (route) => {
      const url = new URL(route.request().url());
      seen.push(url);
      const c = url.searchParams.get("cursor");
      if (c) await held;   // the page move is slow
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(c
        ? body({ page: 2, total: null, total_exact: false, total_pages: null, next_cursor: null, has_more: false })
        : body({ total: 120, next_cursor: "c1", has_more: true })) });
    });
    await openLogs(page);
    const info = page.locator("#logs-pagination .page-info");
    await expect(info).toContainText("Page 1 of 3");
    await page.locator("#logs-pagination [data-action='logs-page-next']").click();
    await expect.poll(() => seen.some(u => u.searchParams.get("cursor") === "c1"), { message: "the move is on its way" }).toBe(true);
    const before = seen.length;
    await page.evaluate(() => {
      const fn = window.__intervals.get(window.S._logsAutoRefreshHandle);
      if (typeof fn !== "function") throw new Error("the Logs live refresh is not running");
      fn();
    });
    expect(seen.length, "the refresh holds off while the move loads").toBe(before);
    release();
    await expect(info).toContainText("Page 2 of 3");
    await expect(page.locator("#logs-body")).toContainText("row-50");
  });
});

