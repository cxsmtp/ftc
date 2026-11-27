"use strict";

// RAW LOGS, INSIDE THE AUDIT PAGE (operator report, 9.1.1: "the logs under audit
// lost pagination control and the pagination on live logs").
//
// The Logs pane is the Audit page's Raw logs view: Audit's switch opens it, the
// same switch sits on it (Raw logs pressed, Audit trail one press away), and the
// Audit sidebar item stays current. Inside it the log keeps everything the Logs
// tab had: the pager (First, −10, Prev, Next, +10, Last, Go to page), page 1
// refreshing live every 15 s, and deeper pages pinned to the moment the reader
// left page 1, so the refresh never pulls them back or reshuffles them.
//
// The live refresh is a 15 s setInterval: an init script records each interval's
// callback by its handle, and the test runs the logs refresh's own callback
// (`S._logsAutoRefreshHandle`) instead of waiting for it.
//
// Also here, the Logs-table defects of the same group:
//   - a Columns choice made on one stream keeps the other stream's own columns;
//   - unfiltered, a heading menu's sort reorders the page in hand and asks the
//     server nothing (the server cannot rank the whole log);
//   - keyboard focus survives a Logs heading sort, by the menu and by the
//     heading itself;
//   - the Audit item always opens on the trail, never on the view used last
//     (operator ruling, 14 Nov 2026): after Raw logs, through the sidebar and
//     after a reload.

const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const { logsBody, mockJson } = require("./table-columns-fixture");

test.use({ baseURL: BASE });

const STAMP = `f911r${Date.now().toString(36)}`;

/** Record each setInterval callback by its handle, so a test can run one tick. */
async function captureIntervals(page) {
  await page.addInitScript(() => {
    window.__intervals = new Map();
    const orig = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) { const id = orig.call(this, fn, ms, ...rest); window.__intervals.set(id, fn); return id; };
  });
}
/** Run the Logs pane's live-refresh tick now. */
const logsTick = (page) => page.evaluate(() => {
  const fn = window.__intervals.get(window.S._logsAutoRefreshHandle);
  if (typeof fn !== "function") throw new Error("the Logs live refresh is not running");
  fn();
});

async function openRawLogs(page) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]').evaluate(el => el.click());
  await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#audit-view-raw").click();
  await page.locator("#admin-logs-tab").waitFor({ state: "visible", timeout: 20000 });
}

test.describe("Raw logs inside the Audit page", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { for (const k of Object.keys(localStorage)) if (k.startsWith("ha:tcols:")) localStorage.removeItem(k); } catch (_) { /* defaults apply */ }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("is the Audit page's second view; its pager pages, page 2 holds still through the live refresh, page 1 picks up new lines", async ({ page }) => {
    test.setTimeout(180_000);
    await captureIntervals(page);
    await adminLogin(page);
    const MARK = `${STAMP}a`;
    const hit = async (tag) => { const r = await page.request.get(`/api/config?${MARK}=${tag}`); expect(r.ok()).toBeTruthy(); };
    for (let i = 0; i < 120; i++) await hit(`n${String(i).padStart(3, "0")}`);

    await openRawLogs(page);
    // One page, two views: Audit stays current and the switch is here too.
    const auditNav = page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]');
    await expect(auditNav, "the Audit sidebar item stays current on Raw logs").toHaveAttribute("aria-current", "page");
    await expect(page.locator("#admin-logs-tab h2")).toHaveText("Audit");
    await expect(page.locator("#logs-view-raw")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#logs-view-trail")).toBeVisible();
    await expect(page.locator("#logs-view-trail")).toHaveAttribute("aria-pressed", "false");

    // The request log, narrowed to this test's lines: an exact count.
    await page.locator("#logs-stream-access").click();
    await page.locator("#logs-search").fill(MARK);
    const info = page.locator("#logs-pagination .page-info");
    await expect(info).toHaveText("Page 1 of 3 (120 total)", { timeout: 15000 });
    const paths = () => page.locator("#logs-body tr").evaluateAll(trs => trs.map(tr => (tr.textContent.match(/=(n\d{3}|late\d|later\d)/) || [])[1] || null));
    expect((await paths())[0], "newest first").toBe("n119");
    const sent = [];
    page.on("request", (r) => { if (r.url().includes("/api/admin/logs?")) sent.push(new URL(r.url())); });

    // Next moves to page 2.
    await page.locator("#logs-pagination [data-action='logs-page-next']").click();
    await expect(info).toHaveText("Page 2 of 3 (120 total)", { timeout: 15000 });
    const page2 = await paths();
    expect(page2[0]).toBe("n069");
    expect(page2[page2.length - 1]).toBe("n020");

    // New lines arrive while the reader is on page 2; the 15 s tick fires.
    for (let i = 0; i < 5; i++) await hit(`late${i}`);
    const before = sent.length;
    await logsTick(page);
    // Pressing the view already on screen does nothing: re-opening Raw logs
    // would drop the reader back to page 1.
    await page.locator("#logs-view-raw").click();
    // A positive control afterwards orders the network: the jump's request is
    // the next one, so nothing the tick could have sent can still be in flight.
    await page.locator("#logs-page-input").fill("3");
    await page.locator("#logs-page-jump button[data-action='logs-page-goto']").click();
    await expect(info).toHaveText("Page 3 of 3 (120 total)", { timeout: 15000 });
    expect(sent.slice(before).map(u => u.searchParams.get("offset")), "the tick and the Raw logs press on page 2 asked nothing; the jump asked for page 3").toEqual(["100"]);
    expect(sent[sent.length - 1].searchParams.get("anchor"), "deeper pages are pinned to page 1's head").toBeTruthy();
    expect((await paths()).length, "page 3 holds the 20 oldest").toBe(20);

    // Back to page 2: the same rows, not shifted by the five new lines.
    await page.locator("#logs-pagination [data-action='logs-page-prev']").click();
    await expect(info).toHaveText("Page 2 of 3 (120 total)", { timeout: 15000 });
    expect(await paths(), "page 2 is where the reader left it").toEqual(page2);
    expect(await page.evaluate(() => window.S._logsPager.page)).toBe(2);

    // Page 1 is live: it shows what arrived, and the next tick picks up more.
    await page.locator("#logs-pagination [data-action='logs-page-first']").click();
    await expect(info).toHaveText("Page 1 of 3 (125 total)", { timeout: 15000 });
    expect((await paths())[0]).toBe("late4");
    for (let i = 0; i < 3; i++) await hit(`later${i}`);
    await logsTick(page);
    await expect(info, "the tick refreshed page 1").toHaveText("Page 1 of 3 (128 total)", { timeout: 15000 });
    expect((await paths())[0]).toBe("later2");

    // The trail is one press away; leaving stops the live refresh.
    const reads = [];
    page.on("request", (r) => { if (r.url().includes("/api/admin/audit?")) reads.push(new URL(r.url())); });
    await page.locator("#logs-view-trail").click();
    await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#admin-logs-tab")).toBeHidden();
    await expect(auditNav).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => window.S._logsAutoRefreshHandle), "no live refresh behind the trail").toBeNull();
    // The trail's own press is a no-op too (it would reload the trail's first
    // page). A positive control orders the network: the Outcome change sends the
    // next read, so a read the press caused would come before it.
    await page.locator("#audit-view-trail").click();
    await page.locator("#audit-outcome").selectOption("failure");
    await expect.poll(() => reads.some(u => u.searchParams.get("outcome") === "failure"), { timeout: 15000 }).toBe(true);
    expect(reads.map(u => u.searchParams.get("outcome")), "returning loaded the trail once; its own press asked nothing; the Outcome change asked once").toEqual([null, "failure"]);
  });

  test("the Audit item opens on the trail even when Raw logs was the view in use, through the sidebar and after a reload", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    const auditItem = page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]');
    const trailOnScreen = async (why) => {
      await expect(page.locator("#admin-audit-tab"), why).toBeVisible({ timeout: 15000 });
      await expect(page.locator("#admin-logs-tab"), `${why}: Raw logs is not on screen`).toBeHidden();
      await expect(page.locator("#audit-view-trail"), `${why}: the switch says the trail`).toHaveAttribute("aria-pressed", "true");
    };
    // CONTROL: Raw logs is reachable, so the view in use really was Raw logs.
    await openRawLogs(page);
    await expect(page.locator("#logs-view-raw"), "PRECONDITION: Raw logs is the view in use").toHaveAttribute("aria-pressed", "true");
    // Another page, then back through the sidebar.
    await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').evaluate(el => el.click());
    await expect(page.locator("#admin-competitions-tab")).toBeVisible({ timeout: 15000 });
    await auditItem.evaluate(el => el.click());
    await trailOnScreen("back through the sidebar");
    // Raw logs again, then a reload, then the sidebar.
    await page.locator("#audit-view-raw").click();
    await page.locator("#admin-logs-tab").waitFor({ state: "visible", timeout: 20000 });
    await page.reload();
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 30000 });
    await auditItem.evaluate(el => el.click());
    await trailOnScreen("after a reload");
  });

  test("a Columns choice on one stream keeps the other stream's own columns", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await openRawLogs(page);
    const head = (key) => page.locator(`#logs-thead th[data-col="${key}"]`);
    // A stream switch rebuilds the header row; the component hides columns in
    // the same pass that gives each heading its menu button, so the button is
    // the sign the row has been decided.
    const decided = (key) => expect(head(key).locator(".tcol-hbtn")).toHaveCount(1, { timeout: 15000 });
    const shown = async (key) => !(await head(key).evaluate(th => th.classList.contains("tcol-off")));
    await expect(head("level")).toBeVisible();
    await decided("level");
    await page.locator(".tcol-bar[data-tcols-for='logs'] .tcol-cols-btn").click();
    const pop = page.locator(".tcol-pop.tcol-cols-pop");
    await expect(pop).toBeVisible();
    await pop.locator('[data-tcol-key="user_first_name"]').check();
    await pop.locator("[data-tcol-done]").click();
    expect(await shown("user_first_name"), "First is now shown on the audit stream").toBe(true);
    expect(await shown("user_last_name"), "CONTROL: Last stays at its default (hidden)").toBe(false);

    await page.locator("#logs-stream-access").click();
    await decided("method");
    for (const k of ["method", "path", "status", "ms"]) expect(await shown(k), `the request log keeps its own ${k} column`).toBe(true);
    expect(await shown("user_first_name"), "the choice itself carries over").toBe(true);

    // The other direction: a choice on the request log leaves the audit log's own columns.
    await page.locator(".tcol-bar[data-tcols-for='logs'] .tcol-cols-btn").click();
    await expect(pop).toBeVisible();
    await pop.locator('[data-tcol-key="path"]').uncheck();
    await pop.locator("[data-tcol-done]").click();
    expect(await shown("path")).toBe(false);
    await page.locator("#logs-stream-app").click();
    await decided("level");
    for (const k of ["level", "msg", "changed_by"]) expect(await shown(k), `the audit log keeps its own ${k} column`).toBe(true);
    await page.locator("#logs-stream-access").click();
    await decided("path");
    expect(await shown("path"), "…and the request log keeps the choice made on it").toBe(false);
  });

  test("unfiltered, a heading menu's sort reorders the page in hand and asks the server nothing", async ({ page }) => {
    test.setTimeout(120_000);
    const ROWS = [{ level: "info", msg: `${STAMP} one` }, { level: "error", msg: `${STAMP} two` }, { level: "warn", msg: `${STAMP} three` }];
    // The server's answer for an unfiltered log: it cannot rank every line.
    const seen = await mockJson(page, "**/api/admin/logs?**", () => logsBody(ROWS, { total: 160, sortable_globally: false }));
    await adminLogin(page);
    await openRawLogs(page);
    const info = page.locator("#logs-pagination .page-info");
    await expect(info).toContainText("Page 1 of 4", { timeout: 15000 });
    for (let p = 2; p <= 3; p++) {
      await page.locator("#logs-pagination [data-action='logs-page-next']").click();
      await expect(info).toContainText(`Page ${p} of 4`);
    }
    const before = seen.length;
    await page.locator("#logs-thead th[data-col='level'] .tcol-hbtn").click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    await pop.locator("[data-tcol-sort='asc']").click();
    await expect(page.locator("#logs-thead th[data-col='level']")).toHaveAttribute("aria-sort", "ascending", { timeout: 5000 });
    await expect(info, "still on page 3").toContainText("Page 3 of 4");
    const levels = await page.locator("#logs-body td.log-level").evaluateAll(tds => tds.map(td => td.textContent.trim()));
    expect(levels, "the page in hand, least severe first").toEqual(["info", "warn", "error"]);
    await expect(page.locator("#logs-pagination .page-scope-note")).toHaveText("Sorted within this page");
    await expect(page.locator("#logs-range-hint")).toContainText("Live updates paused while sorted");
    await page.keyboard.press("Escape");
    // A positive control orders the network: Next's request is the next one.
    await page.locator("#logs-pagination [data-action='logs-page-next']").click();
    await expect(info).toContainText("Page 4 of 4");
    expect(seen.slice(before).map(u => u.searchParams.get("offset")), "the sort asked nothing; Next asked for page 4").toEqual(["150"]);
  });

  test("keyboard focus survives a Logs heading sort, by its menu and by the heading itself", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await openRawLogs(page);
    await expect(page.locator("#logs-body tr").first()).toBeVisible({ timeout: 15000 });
    // By the menu: the header row is rebuilt by the sort, while the menu is open.
    await page.locator("#logs-thead th[data-col='level'] .tcol-hbtn").focus();
    await page.keyboard.press("Enter");
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    await pop.locator("[data-tcol-sort='asc']").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#logs-thead th[data-col='level']")).toHaveAttribute("aria-sort", "ascending", { timeout: 5000 });
    await pop.locator("[data-tcol-done]").focus();
    await page.keyboard.press("Enter");
    await expect(pop).toHaveCount(0);
    const where = () => page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a && a.tagName, menu: a && a.getAttribute("data-tcol-menu"), col: a && a.getAttribute("data-col"), inHead: !!(a && a.closest && a.closest("#logs-thead")) };
    });
    expect(await where(), "back on the Level heading's menu button").toEqual({ tag: "BUTTON", menu: "level", col: null, inHead: true });

    // By the heading itself: Enter on Date & Time sorts (newest first again) and
    // rebuilds the row; Level losing its arrow is the witness that it did.
    await page.locator("#logs-thead th[data-col='ts']").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#logs-thead th[data-col='level']")).toHaveAttribute("aria-sort", "none", { timeout: 5000 });
    await expect(page.locator("#logs-thead th[data-col='ts']")).toHaveAttribute("aria-sort", "descending");
    expect(await where(), "back on the Date & Time heading").toEqual({ tag: "TH", menu: null, col: "ts", inHead: true });
  });

  test("a heading menu whose header row was rebuilt returns focus to the same column of the same table, when tables share a key", async ({ page }) => {
    // Live rankings draws one board per event under one key; a sort rebuilds
    // them all while the menu is open. Two tables stand in for them here.
    test.setTimeout(120_000);
    await adminLogin(page);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    // One header row of two columns, built with DOM calls (the page enforces
    // Trusted Types, so no HTML strings), on `window` for both evaluates.
    await page.evaluate(() => {
      window.__zzHead = () => {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        for (const label of ["Name", "Score"]) { const th = document.createElement("th"); th.scope = "col"; th.textContent = label; tr.appendChild(th); }
        thead.appendChild(tr);
        return thead;
      };
      window.defineTable("zztwin", { noun: "row" });
      const box = document.createElement("div");
      box.id = "zztwin-box";
      for (const n of [1, 2]) {
        const t = document.createElement("table");
        t.dataset.tcols = "zztwin"; t.dataset.n = String(n);
        t.appendChild(window.__zzHead());
        const tb = document.createElement("tbody");
        for (const [a, b] of [[`a${n}`, n], [`b${n}`, n + 1]]) { const tr = document.createElement("tr"); for (const v of [a, b]) { const td = document.createElement("td"); td.textContent = String(v); tr.appendChild(td); } tb.appendChild(tr); }
        t.appendChild(tb);
        box.appendChild(t);
      }
      document.querySelector("#admin-page .admin-content").prepend(box);
      for (const t of box.querySelectorAll("table")) window.syncTable(t);
    });
    const btn = (n) => page.locator(`#zztwin-box table[data-n="${n}"] .tcol-hbtn[data-tcol-menu="name"]`);
    await expect(btn(1)).toHaveCount(1);
    await expect(btn(2)).toHaveCount(1);
    await btn(2).click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    // Both header rows are rebuilt while the menu is open, as a board re-render does.
    await btn(2).evaluate(el => { el.dataset.zzOpener = "1"; });
    await page.evaluate(() => {
      for (const t of document.querySelectorAll("#zztwin-box table")) { t.tHead.remove(); t.prepend(window.__zzHead()); window.syncTable(t); }
    });
    await expect(page.locator("[data-zz-opener]"), "PRECONDITION: the opener left the page").toHaveCount(0);
    await expect(btn(2), "…and the new header row has its own button").toHaveCount(1);
    await pop.locator("[data-tcol-done]").click();
    await expect(pop).toHaveCount(0);
    const at = await page.evaluate(() => {
      const a = document.activeElement;
      return { menu: a && a.getAttribute("data-tcol-menu"), table: a && a.closest && a.closest("table") ? a.closest("table").dataset.n : null };
    });
    expect(at, "the second table's Name button, not the first table's, nor the page").toEqual({ menu: "name", table: "2" });
  });
});
