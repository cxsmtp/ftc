"use strict";

// v8.17.0 — HEADING SORT + FILTER ON THE THREE TABLES THAT CAME LAST: the Events
// list, Submissions and Logs (public/js/ui/table-columns.js).
//
// What each lock holds, by value, with a control row beside every positive:
//  - EVENTS (model table, paged in the browser). A heading filter narrows every
//    loaded event before paging (it finds a row on page 2) and the count says
//    so; the control events go.
//    The heading menu's sort drives the list's own sort; before any heading is
//    chosen the default total order (status band, latest end first) stands.
//  - SUBMISSIONS (paged and sorted by the SERVER, SUB_SORTS). The heading menu's
//    Sort sends ONE request with the server's key and direction, from page 1 with
//    the snapshot anchor dropped — never a toggle clicked twice (whose first
//    request asks for the other direction). A heading filter narrows the rows of
//    this page and says "on this page".
//  - LOGS (walked by the server). Same: one request carrying sort/dir, from page
//    1; the filter is page-scoped and says so.
//  - CERTIFICATES (an event's issued list, every row on screen). Holder sorts,
//    Certificate filters, and a row's own button still names its own holder
//    once the list is sorted and filtered.
// The server-paged tables answer from mocks (tests/table-columns-fixture.js):
// what is under test is the request the client sends and the rows it hides.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, clickTab, narrowEventsTable } = require("./ui-admin-helpers");
const { submissionsBody, logsBody, mockJson } = require("./table-columns-fixture");

test.use({ baseURL: BASE });

const STAMP = `tcs${Date.now().toString(36)}`;
// Upcoming, distinct ends: the default order (latest end first) is Gamma, Alpha, Beta.
const EVENTS = [
  { key: "alpha", name: `${STAMP} Alpha`, startH: 48, dur: 600 },
  { key: "beta", name: `${STAMP} Beta`, startH: 24, dur: 60 },
  { key: "gamma", name: `${STAMP} Gamma`, startH: 72, dur: 600 },
];

test.describe("v8.17.0 — heading sort and filter on Events, Submissions and Logs", () => {
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const h = { "x-csrf-token": csrf, "content-type": "application/json" };
      for (const e of EVENTS) {
        const r = await api.post("/api/admin/competitions", { headers: h, data: {
          name: e.name, event_kind: "tournament", timezone: "UTC",
          start_time: new Date(Date.now() + e.startH * 3600_000).toISOString(), duration_minutes: e.dur } });
        expect(r.ok(), `create ${e.key}: ${r.status()} ${await r.text()}`).toBeTruthy();
      }
    } finally { await api.dispose(); }
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { for (const k of Object.keys(localStorage)) if (k.startsWith("ha:tcols:")) localStorage.removeItem(k); } catch (_) { /* defaults apply */ }
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  const names = async (rows) => (await rows.allInnerTexts()).map(t => (t.match(new RegExp(`${STAMP} (Alpha|Beta|Gamma)`)) || [])[1]).filter(Boolean);

  test("Events: a heading filter narrows the list before paging; the menu's sort drives the list's own", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    const rows = page.locator("#admin-comp-body tr");
    await narrowEventsTable(page, STAMP);
    await expect(rows).toHaveCount(3, { timeout: 15000 });
    expect(await names(rows), "PRECONDITION: the default total order — latest end first").toEqual(["Gamma", "Alpha", "Beta"]);

    // BEFORE PAGING: two to a page, so Beta (third in the default order) is on
    // page 2 and not drawn. A filter applied to the page in hand would find nothing.
    const pop = page.locator(".tcol-pop[role='dialog']");
    try {
      await page.evaluate(() => { window.S.cPageSize = 2; window.S.cPage = 1; window.renderAdminCompetitions(); });
      await expect(rows).toHaveCount(2, { timeout: 5000 });
      expect(await names(rows), "PRECONDITION: page 1 holds Gamma and Alpha; Beta is on page 2").toEqual(["Gamma", "Alpha"]);

      // Filter: Name contains "Beta". Gamma and Alpha (the controls) go.
      await page.locator("#admin-comp-table thead th[data-col='name'] .tcol-hbtn").click();
      await expect(pop).toBeVisible();
      await pop.locator("input[data-tcol-input]").pressSequentially("Beta", { delay: 20 });
      await expect(rows).toHaveCount(1, { timeout: 5000 });
      await expect(rows.first()).toContainText(EVENTS[1].name);
      await expect(page.locator("#comp-search-count")).toContainText(/1 of/);
      await expect(page.locator(".tcol-bar[data-tcols-for='events'] .tcol-note")).toContainText("Name");
      await pop.locator("[data-tcol-fclear]").click();
      await expect(rows).toHaveCount(2, { timeout: 5000 });
      await page.keyboard.press("Escape");
    } finally {
      await page.evaluate(() => { window.S.cPageSize = 30; window.S.cPage = 1; window.renderAdminCompetitions(); });
    }
    await expect(rows).toHaveCount(3, { timeout: 5000 });

    // With the search box empty the heading filter alone narrows the whole
    // loaded list (every seeded and earlier event).
    await narrowEventsTable(page, "");
    await page.locator("#admin-comp-table thead th[data-col='name'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially(`${STAMP} Gamma`, { delay: 10 });
    await expect(rows).toHaveCount(1, { timeout: 5000 });
    await expect(rows.first()).toContainText(EVENTS[2].name);
    await page.locator(".tcol-pop [data-tcol-fclear]").click();
    await page.keyboard.press("Escape");

    // Sort: the menu's buttons drive the native Name sort.
    await narrowEventsTable(page, STAMP);
    await expect(rows).toHaveCount(3, { timeout: 5000 });
    const nameTh = page.locator("#admin-comp-table thead th[data-col='name']");
    await nameTh.locator(".tcol-hbtn").click();
    await page.locator(".tcol-pop [data-tcol-sort='desc']").click();
    await expect(nameTh).toHaveAttribute("aria-sort", "descending", { timeout: 5000 });
    await expect.poll(() => names(rows), { timeout: 5000 }).toEqual(["Gamma", "Beta", "Alpha"]);
    await page.locator(".tcol-pop [data-tcol-sort='asc']").click();
    await expect(nameTh).toHaveAttribute("aria-sort", "ascending", { timeout: 5000 });
    await expect.poll(() => names(rows), { timeout: 5000 }).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("Submissions: the menu's sort is ONE server request from page 1; the filter is page-scoped and says so", async ({ page }) => {
    const ROWS = [
      { nickname: `${STAMP}_zed`, task_title: "Regex Golf" },
      { nickname: `${STAMP}_amy`, task_title: "Buffer Overflow" },
      { nickname: `${STAMP}_zed`, task_title: "Buffer Overflow", is_correct: 0, points_delta: -5 },
      { nickname: `${STAMP}_bob`, task_title: "SQL Injection" },
    ];
    const seen = await mockJson(page, "**/api/admin/submissions?**", () => submissionsBody(ROWS, { total: 90, sorted_globally: true }));
    await adminLogin(page);
    await clickTab(page, "Submissions");
    const rows = page.locator("#admin-submissions-body tr");
    await expect(rows).toHaveCount(4, { timeout: 15000 });

    // Move to page 2, so "from page 1, anchor dropped" is a real change.
    await page.locator("#submissions-pagination [data-action='subs-page-next']").click();
    await expect.poll(() => seen.some(u => u.searchParams.get("offset") === "30" && u.searchParams.get("snapshot_before")), { timeout: 5000 }).toBe(true);

    const pTh = page.locator("#admin-submissions-tab thead th[data-col='participant']");
    await pTh.locator(".tcol-hbtn").click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    const before = seen.length;
    await pop.locator("[data-tcol-sort='desc']").click();
    await expect(pTh).toHaveAttribute("aria-sort", "descending", { timeout: 5000 });
    // Let any second request land before reading the list.
    await expect.poll(() => page.evaluate(() => window.S.subSortCol + ":" + window.S.subSortAsc), { timeout: 5000 }).toBe("participant:false");
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    const sent = seen.slice(before).map(u => ({ sort: u.searchParams.get("sort"), dir: u.searchParams.get("dir"), offset: u.searchParams.get("offset"), snap: u.searchParams.get("snapshot_before") }));
    expect(sent, "exactly one request: the server's key, descending, page 1, no anchor").toEqual([{ sort: "participant", dir: "desc", offset: "0", snap: null }]);

    // Filter: Participant contains "_zed". The amy and bob rows (controls) go.
    await pop.locator("input[data-tcol-input]").pressSequentially("_zed", { delay: 20 });
    await expect(rows.filter({ visible: true })).toHaveCount(2, { timeout: 5000 });
    for (const t of await rows.filter({ visible: true }).allInnerTexts()) expect(t).toContain(`${STAMP}_zed`);
    await expect(rows.filter({ hasText: `${STAMP}_amy` })).toBeHidden();
    await expect(page.locator(".tcol-bar[data-tcols-for='submissions'] .tcol-note")).toContainText(/2 of 4 submissions on this page shown/);
    await expect(pTh.locator(".tcol-hbtn")).toHaveClass(/is-on/);
    // Clear restores the page.
    await pop.locator("[data-tcol-fclear]").click();
    await expect(rows.filter({ visible: true })).toHaveCount(4, { timeout: 5000 });
  });

  test("Logs: the menu's sort is ONE server request from page 1; the filter is page-scoped and says so", async ({ page }) => {
    const ROWS = [
      { level: "error", msg: `${STAMP} alpha refused` },
      { level: "info", msg: `${STAMP} beta served` },
      { level: "warn", msg: `${STAMP} alpha slow` },
    ];
    const seen = await mockJson(page, "**/api/admin/logs?**", () => logsBody(ROWS, { total: 160 }));
    await adminLogin(page);
    await clickTab(page, "Logs");
    const rows = page.locator("#logs-body tr");
    await expect(rows).toHaveCount(3, { timeout: 15000 });
    await page.locator("#logs-pagination [data-action='logs-page-next']").click();
    await expect.poll(() => seen.some(u => u.searchParams.get("offset") === "50"), { timeout: 5000 }).toBe(true);

    const lvTh = page.locator("#logs-thead th[data-col='level']");
    await lvTh.locator(".tcol-hbtn").click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    const before = seen.length;
    await pop.locator("[data-tcol-sort='asc']").click();
    await expect(page.locator("#logs-thead th[data-col='level']")).toHaveAttribute("aria-sort", "ascending", { timeout: 5000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    const sent = seen.slice(before).map(u => ({ sort: u.searchParams.get("sort"), dir: u.searchParams.get("dir"), offset: u.searchParams.get("offset") }));
    expect(sent, "exactly one request: level ascending, page 1").toEqual([{ sort: "level", dir: "asc", offset: "0" }]);
    await page.keyboard.press("Escape");

    // Filter: Message contains "alpha". The beta row (control) goes.
    await page.locator("#logs-thead th[data-col='msg'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("alpha", { delay: 20 });
    await expect(rows.filter({ visible: true })).toHaveCount(2, { timeout: 5000 });
    for (const t of await rows.filter({ visible: true }).allInnerTexts()) expect(t).toContain("alpha");
    await expect(rows.filter({ hasText: `${STAMP} beta` })).toBeHidden();
    await expect(page.locator(".tcol-bar[data-tcols-for='logs'] .tcol-note")).toContainText(/2 of 3 entries on this page shown/);
    // Switching stream starts clean: the Message filter names nothing there.
    await page.keyboard.press("Escape");
    await page.locator("#logs-stream-access").click();
    await expect(page.locator(".tcol-bar[data-tcols-for='logs'] .tcol-note")).toHaveText("", { timeout: 5000 });
  });
  // THE ISSUED CERTIFICATES (an event's Certificates section, a page-only table).
  // The list is the server's own answer with its rows replaced (a route over the
  // tab's own read): four holders, two of them Participation, drawn Zoe, Abe,
  // Max, Kim. Holder sorts, Certificate filters, and a row's PDF button, pressed
  // while the list is sorted and filtered, asks for THAT row's holder: rows name
  // their holder by their place in the list as drawn, never their place on screen.
  test("Certificates: Holder sorts, Certificate filters, and a sorted row's PDF names its own holder", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    let ev;
    try {
      const r = await api.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {
        name: `${STAMP} Certs`, event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } });
      expect(r.ok(), await r.text()).toBeTruthy();
      ev = (await r.json()).competition;
    } finally { await api.dispose(); }
    const cert = (first, tier, n) => ({ userId: `u-${first.toLowerCase()}`, name: `${first} Holder`, nickname: first, email: `${first.toLowerCase()}@corp.example`,
      tier, label: tier, score: n, code: null, emailStatus: null, revoked: false, lateEntrant: false });
    await page.route(`**/api/admin/competitions/${ev.id}/certificates`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.certificates = [cert("Zoe", "gold", 300), cert("Abe", "participation", 10), cert("Max", "participation", 20), cert("Kim", "silver", 200)];
      await route.fulfill({ response: res, json: body });
    });
    const pdfs = [];
    await page.route(`**/api/admin/competitions/${ev.id}/certificates/*/certificate.pdf`, (route) => {
      pdfs.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%%EOF\n" });
    });
    await adminLogin(page);
    await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id), { timeout: 15000 }).toBe(true);
    await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-event-certs-tab" }), { id: ev.id, n: ev.name });
    const T = page.locator('#ws-certs-issued table[data-tcols="certificates"]');
    const holders = () => T.locator("tbody tr").filter({ visible: true }).locator("td.ic-lead b").allInnerTexts();
    await expect.poll(holders, { timeout: 15000, message: "PRECONDITION: drawn in the list's order" }).toEqual(["Zoe Holder", "Abe Holder", "Max Holder", "Kim Holder"]);

    // Sort: Holder, descending, from its menu.
    await T.locator("th[data-tcol-dsort='holder'] .tcol-hbtn").click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    await pop.locator("[data-tcol-sort='desc']").click();
    await expect.poll(holders).toEqual(["Zoe Holder", "Max Holder", "Kim Holder", "Abe Holder"]);
    await expect(T.locator("th[data-tcol-dsort='holder']")).toHaveAttribute("aria-sort", "descending");
    await page.keyboard.press("Escape");

    // Filter: Certificate is Participation. The 1st and 2nd places go; Max and Abe stay.
    await T.locator("thead th").filter({ hasText: /^Certificate/ }).locator(".tcol-hbtn").click();
    await expect(pop).toBeVisible();
    await pop.locator("select[data-tcol-input]").selectOption("Participation");
    await pop.locator("[data-tcol-done]").click();
    await expect.poll(holders, { message: "only the Participation rows, still sorted" }).toEqual(["Max Holder", "Abe Holder"]);
    await expect(page.locator(".tcol-bar[data-tcols-for='certificates'] .tcol-note")).toContainText("Certificate");

    // The first row on screen is Max, drawn third: its PDF asks for Max.
    await T.locator("tbody tr").filter({ visible: true }).first().locator('[data-ic="pdf"]').click();
    await expect.poll(() => pdfs.length, { message: "the PDF was asked for" }).toBe(1);
    expect(pdfs[0], "the PDF names the row's own holder").toContain("/certificates/u-max/");
    // CONTROL: the last row on screen, Abe, asks for Abe.
    await T.locator("tbody tr").filter({ visible: true }).last().locator('[data-ic="pdf"]').click();
    await expect.poll(() => pdfs.length).toBe(2);
    expect(pdfs[1]).toContain("/certificates/u-abe/");
  });
});
