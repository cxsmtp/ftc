"use strict";

// v8.17.0 — ADMIN TABLES: NO SIDEWAYS SCROLL, A COLUMNS CHOOSER, AND SORT +
// FILTER ON EVERY HEADING (public/js/ui/table-columns.js).
//
// Three locks:
//  1. GEOMETRY. At 1024, 1280 and 1440 px no admin table that carries
//     `data-tcols` is wider than its container with its DEFAULT columns, and the
//     page itself does not scroll sideways. Geometry, not markup (CLAUDE.md
//     "Lock layout defects as geometry"): a fixture with long titles, long tags
//     and long emails is what made the old Challenge library scroll.
//  2. COLUMNS MENU. Hiding and showing a column takes effect at once, survives a
//     reload (per table, per browser), and Reset to default restores the set.
//  3. HEADING SORT + FILTER on the Challenge library and Participants: a filter
//     narrows the WHOLE model before paging (a row on another page is reached),
//     the count says it is filtered, Clear restores, and a heading with no sort
//     of its own (Tags) sorts with aria-sort set. Each positive has a negative
//     control beside it.
//  4. PHONE (<=768px). The card layout hides every heading, and with it the
//     heading's button; **Sort & filter** above the cards lists exactly the
//     columns a wide screen gives a button, in order, and opens the same menu:
//     its filter narrows the whole library, its sort drives the heading's own
//     sort, a server-sorted table sends its one request, "All columns" goes
//     back. Controls: the button is absent where the headings show, the
//     headings' buttons are absent where it shows.
// Plus axe on both menus. The Events list, Submissions and Logs join the
// geometry walk here (the two server-paged ones answer from mocks with their
// widest values); their heading sort and filter are locked in
// tests/table-columns-server.spec.js.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, registerPost } = require("./helpers");
const { adminLogin, clickTab, narrowGroupsTable, AxeBuilder, AXE_GATED_IMPACTS, narrowChallengesTable, narrowEventsTable, narrowPeopleTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const STAMP = `tc${Date.now().toString(36)}`;
const LONG_TAG = `category:${"verylongcategoryname".repeat(2)}`;
const titles = {
  a: `${STAMP} Aardvark ${"supercalifragilistic".repeat(3)} challenge`,
  b: `${STAMP} Badger challenge with an ordinary title`,
  c: `${STAMP} Cobra`,
};
let groupName;
const eventName = `${STAMP} Global Security Championship ${"Finals".repeat(4)} Edition`;
const { submissionsBody, logsBody, mockJson } = require("./table-columns-fixture");

test.describe("v8.17.0 — admin tables fit, choose columns, sort and filter", () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const tags = { a: ["alpha", LONG_TAG, "zeta-tag", "extra-one", "extra-two"], b: ["beta"], c: [] };
    const topics = { a: `${STAMP} alpha ${"verylongtopic".repeat(2)}`, b: `${STAMP} beta`, c: null };
    for (const [k, t] of Object.entries(titles)) {
      const r = await api.post("/api/admin/tasks", { headers: h, data: {
        title: t, description: "<p>d</p>", difficulty: k === "a" ? "hard" : k === "b" ? "medium" : "easy",
        answer_type: "text", correct_answer: "x", status: "published",
      } });
      expect(r.ok(), `create ${k}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const id = (await r.json()).id;
      for (const tag of tags[k]) {
        const tr = await api.post(`/api/admin/tasks/${id}/tags`, { headers: h, data: { tag } });
        expect(tr.ok(), `tag ${tag}: ${tr.status()} ${await tr.text()}`).toBeTruthy();
      }
      // Stage B — the Question bank shows a TOPIC column, not the tags: a long
      // topic on (a), a short one on (b), none on (c).
      if (topics[k]) {
        const tp = await api.post("/api/admin/topics", { headers: h, data: { name: topics[k] } });
        expect(tp.status(), `topic ${topics[k]}: ${await tp.text()}`).toBe(201);
        const pr = await api.put(`/api/admin/tasks/${id}`, { headers: h, data: { topic_id: (await tp.json()).id } });
        expect(pr.ok(), `file under topic: ${await pr.text()}`).toBeTruthy();
      }
    }
    // A participant with a long address and company, so the Participants table
    // has a row as wide as real ones get.
    const reg = await registerPost(api, BASE + "/api/register", { headers: h, data: {
      firstName: "Maximiliana", lastName: `Wolfeschlegelsteinhausen${STAMP}`, nickname: `${STAMP}_max`,
      email: `${STAMP}.maximiliana.wolfeschlegelsteinhausen@longcompanyname-example.com`,
      company: "International Business Consolidated Holdings Incorporated", title: "Principal Engineer",
      avatar: "🦊", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "New York",
    } });
    expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    groupName = `${STAMP} A group with a fairly long descriptive name for wrapping`;
    const g = await api.post("/api/admin/groups", { headers: h, data: { name: groupName } });
    expect(g.ok(), `group: ${g.status()} ${await g.text()}`).toBeTruthy();
    // An upcoming event (so the default status chips show it) with a long name,
    // long tags and two named sessions: as wide as real Events rows get.
    const ev = await api.post("/api/admin/competitions", { headers: h, data: {
      name: eventName, event_kind: "tournament", timezone: "UTC",
      start_time: new Date(Date.now() + 3 * 86400_000).toISOString(), duration_minutes: 240 } });
    expect(ev.ok(), `event: ${ev.status()} ${await ev.text()}`).toBeTruthy();
    const evId = (await ev.json()).competition.id;
    for (const tag of ["regional-final-emea", "verylongtagname-for-wrapping"]) {
      const tr = await api.post(`/api/admin/competitions/${evId}/tags`, { headers: h, data: { tag } });
      expect(tr.ok(), `event tag ${tag}: ${tr.status()} ${await tr.text()}`).toBeTruthy();
    }
  });

  test.beforeEach(async ({ page }) => {
    // Every test starts from the defaults: no stored column choice.
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("tc-keep")) {
          for (const k of Object.keys(localStorage)) if (k.startsWith("ha:tcols:") || k === "ha:p-cols") localStorage.removeItem(k);
        }
      } catch (_) { /* no storage: defaults apply */ }
    });
  });

  async function overflowReport(page) {
    return page.evaluate(() => {
      const out = [];
      for (const t of document.querySelectorAll("#admin-page table[data-tcols]")) {
        const r = t.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const host = t.closest(".table-card, .table-wrap") || t.parentElement;
        const hr = host.getBoundingClientRect();
        if (host.scrollWidth > host.clientWidth + 1 || r.right > hr.right + 1) {
          // Name the widest columns, so a failure says what to fix.
          const cols = [...(t.tHead?.rows[0]?.cells || [])].filter(th => th.getBoundingClientRect().width)
            .map(th => `${(th.textContent || "").trim().slice(0, 14) || "?"}=${Math.round(th.getBoundingClientRect().width)}`);
          out.push(`${t.dataset.tcols}: table ${Math.round(t.scrollWidth)}px / host ${host.clientWidth}px [${cols.join(", ")}]`);
        }
      }
      const de = document.documentElement;
      if (de.scrollWidth > de.clientWidth + 1) out.push(`page scrolls sideways: ${de.scrollWidth} > ${de.clientWidth}`);
      return out;
    });
  }

  async function shownTables(page) {
    return page.evaluate(() => [...document.querySelectorAll("#admin-page table[data-tcols]")]
      .filter(t => t.getBoundingClientRect().width > 0).map(t => t.dataset.tcols));
  }

  // The walk over every admin table, measuring each against its card.
  async function fitWalk(page) {
    // The two server-paged tables answer from mocks with the longest values
    // their cells carry (a sentence-length answer, a long path and message).
    const LONG = "an-answer-without-spaces-".repeat(4);
    await mockJson(page, "**/api/admin/submissions?**", () => submissionsBody([
      { nickname: `${STAMP}_maximiliana_longnickname`, competition_name: eventName, timeslot_name: "Morning session in the main hall",
        task_title: titles.a, answer: LONG, is_correct: 0, points_delta: -5 },
      { event_type: "hint", nickname: `${STAMP}_b`, competition_name: eventName, task_title: titles.b, points_delta: -30 },
    ]));
    await mockJson(page, "**/api/admin/logs?**", () => logsBody([
      { level: "warn", msg: `Request refused: ${LONG}${LONG}`, user_email: `${STAMP}.maximiliana.wolfeschlegelsteinhausen@longcompanyname-example.com`,
        user_first_name: "Maximiliana", user_last_name: `Wolfeschlegelsteinhausen${STAMP}`, user_groups: [groupName],
        changed_by: "superadmin", ip: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff" },
    ]));
    await adminLogin(page);
    const seen = new Set();

    await clickTab(page, "Events");
    await narrowEventsTable(page, STAMP);
    await expect(page.locator("#admin-comp-body tr", { hasText: eventName })).toBeVisible({ timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Events").toEqual([]);

    await clickTab(page, "Submissions");
    await page.locator("#submissions-search").fill(STAMP);   // the mock answers any search with the two wide rows
    await expect(page.locator("#admin-submissions-body tr", { hasText: `${STAMP}_maximiliana` })).toBeVisible({ timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Submissions").toEqual([]);

    await clickTab(page, "Logs");
    await expect(page.locator("#logs-body tr", { hasText: "Request refused" })).toBeVisible({ timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Logs").toEqual([]);

    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    await expect(page.locator("#admin-task-body tr", { hasText: titles.a })).toBeVisible({ timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Challenge library").toEqual([]);

    await clickTab(page, "Participants");
    await narrowPeopleTable(page, STAMP);
    await expect(page.locator("#admin-participants-body tr", { hasText: "Maximiliana" })).toBeVisible({ timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Participants").toEqual([]);

    await clickTab(page, "Groups");
    await narrowGroupsTable(page, STAMP);
    await expect(page.locator("#groups-tbody tr", { hasText: groupName })).toBeVisible({ timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Groups").toEqual([]);

    await page.locator("button[data-tab-id='admin-rankings-tab']").first().evaluate(el => el.click());
    await page.locator("#admin-rankings-tab").waitFor({ state: "visible" });
    await expect.poll(() => page.locator("#admin-rankings-tab table[data-tcols] thead th").count(), { timeout: 15000 }).toBeGreaterThan(0);
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Live rankings").toEqual([]);

    await page.route("**/api/admin/analytics/challenges*", (r) => r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ per_challenge: [{ task_id: "t1", task_number: "1.01", title: titles.a, difficulty: "hard",
        tags: ["alpha", LONG_TAG], solved: 12, incorrect: 340, hint_revealed: 5, navigated_away: 7, unique_attempters: 120 }],
      summary: {}, totals: {}, scope: { type: "global" } }),
    }));
    const { openAnalyticsTab } = require("./ui-admin-helpers");
    await openAnalyticsTab(page);
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(1, { timeout: 15000 });
    for (const k of await shownTables(page)) seen.add(k);
    expect(await overflowReport(page), "Analytics").toEqual([]);

    // Anti-vacuity: the walk really measured every table it claims to.
    expect([...seen].sort()).toEqual(expect.arrayContaining(["analytics", "challenges", "events", "groups", "logs", "participants", "rankings", "submissions"]));
  }

  for (const width of [1024, 1280, 1440]) {
    test(`no admin table is wider than its card at ${width}px with default columns`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      await fitWalk(page);
    });
  }

  // Under a coarse pointer the heading buttons' strips widen from 1280 px
  // (public/styles.css), so every table must still fit its card there on a
  // touch screen too.
  for (const width of [1280, 1440]) {
    test(`under touch, no admin table is wider than its card at ${width}px with default columns`, async ({ browser }) => {
      test.setTimeout(120_000);
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, hasTouch: true });
      try {
        const page = await ctx.newPage();
        await fitWalk(page);
        expect(await page.evaluate(() => matchMedia("(pointer:coarse)").matches), "PRECONDITION: the touch context reports a coarse pointer").toBe(true);
        // The wide strips took effect: a heading with a menu is 48 px of strip.
        const pad = await page.locator("#admin-page table[data-tcols] th.tcol-has-menu").first()
          .evaluate(h => parseFloat(getComputedStyle(h).paddingRight));
        expect(pad, "the touch strip is in force at this width").toBe(48);
      } finally { await ctx.close(); }
    });
  }

  test("Columns menu: hide and show apply at once and survive a reload; Reset restores", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    const row = page.locator("#admin-task-body tr", { hasText: titles.a });
    await expect(row).toBeVisible({ timeout: 15000 });
    const authorTh = page.locator("#admin-task-table thead th[data-col='author']");
    const typeTh = page.locator("#admin-task-table thead th[data-col='difficulty']");
    // Defaults: Author hidden, Difficulty shown (the control).
    await expect(authorTh).toBeHidden();
    await expect(typeTh).toBeVisible();

    const btn = page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-cols-btn");
    await btn.click();
    const menu = page.locator(".tcol-cols-pop");
    await expect(menu).toBeVisible();
    const axe = await new AxeBuilder({ page }).include(".tcol-cols-pop").analyze();
    expect(axe.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact)).map(v => v.id), "axe on the Columns menu").toEqual([]);
    await menu.locator("[data-tcol-key='author']").check();
    await menu.locator("[data-tcol-key='difficulty']").uncheck();
    await expect(authorTh).toBeVisible();
    await expect(typeTh).toBeHidden();
    // Every cell of the hidden column goes with its heading.
    expect(await row.evaluate(tr => [...tr.cells].filter(c => getComputedStyle(c).display !== "none").length))
      .toBe(await page.locator("#admin-task-table thead th:visible").count());
    await menu.locator("[data-tcol-done]").click();
    await expect(menu).toHaveCount(0);

    await page.evaluate(() => sessionStorage.setItem("tc-keep", "1"));
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await clickTab(page, "Challenges");
    await expect(page.locator("#admin-task-body tr").first()).toBeVisible({ timeout: 15000 });
    await expect(authorTh, "the choice is remembered across a reload").toBeVisible();
    await expect(typeTh).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ha:tcols:challenges") || "[]"))).toContain("author");

    await btn.click();
    await page.locator(".tcol-cols-pop [data-tcol-reset]").click();
    await expect(authorTh).toBeHidden();
    await expect(typeTh).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".tcol-cols-pop")).toHaveCount(0);
    await expect(btn, "Escape returns focus to the opener").toBeFocused();
  });

  test("Participants keeps its `ha:p-cols` chooser on the shared component", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, STAMP);
    await expect(page.locator("#admin-participants-body tr", { hasText: "Maximiliana" })).toBeVisible({ timeout: 15000 });
    const emailTh = page.locator("#p-table thead th[data-pcol='email']");
    await expect(emailTh).toBeHidden();
    await page.locator("#p-columns-btn").click();
    await expect(page.locator("#p-columns-pop")).toBeVisible();
    await page.locator("#p-columns-pop [data-tcol-key='email']").check();
    await expect(emailTh).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ha:p-cols") || "[]"))).toContain("email");
    await expect(page.locator("#p-columns-btn")).toHaveAttribute("aria-expanded", "true");
    await page.locator("#p-columns-pop [data-tcol-done]").click();
    await expect(page.locator("#p-columns-btn")).toHaveAttribute("aria-expanded", "false");
  });

  test("Question bank: heading filter narrows the whole bank; the topic heading sorts", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Page size 30 with the seeded library and earlier files' rows: the filter
    // must reach rows on every page, so go to a filter-free, search-free state.
    await expect(page.locator("#admin-task-body tr").first()).toBeVisible({ timeout: 15000 });
    const rows = page.locator("#admin-task-body tr");

    // Difficulty: an enum select.
    await page.locator("#admin-task-table thead th[data-col='difficulty'] .tcol-hbtn").click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    const axe = await new AxeBuilder({ page }).include(".tcol-pop").analyze();
    expect(axe.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact)).map(v => v.id), "axe on the heading menu").toEqual([]);
    await pop.locator("select").selectOption("hard");
    await expect.poll(async () => (await rows.allInnerTexts()).every(t => /\bhard\b/i.test(t)), { timeout: 5000 }).toBe(true);
    await expect(rows.filter({ hasText: titles.a })).toHaveCount(1);
    await expect(rows.filter({ hasText: titles.b }), "negative control: a medium challenge is filtered out").toHaveCount(0);
    await expect(page.locator("#task-search-count")).toContainText(/of/);
    await expect(page.locator("#admin-task-table thead th[data-col='difficulty'] .tcol-hbtn")).toHaveClass(/is-on/);
    await pop.locator("[data-tcol-done]").click();

    // Title contains: combines with the difficulty filter.
    await page.locator("#admin-task-table thead th[data-col='title'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially(STAMP, { delay: 20 });
    await expect(rows).toHaveCount(1, { timeout: 5000 });
    await page.keyboard.press("Escape");

    // Clear column filters restores both.
    const clear = page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-clear");
    await expect(clear).toBeVisible();
    await expect(page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-note")).toContainText(/Difficulty/);
    await clear.click();
    await expect(clear).toBeHidden();
    await narrowChallengesTable(page, STAMP);
    await expect(rows).toHaveCount(3, { timeout: 5000 });

    // Topic has no sort of its own: the heading sorts through the component,
    // blanks last both ways, with aria-sort on the heading.
    const tagsTh = page.locator("#admin-task-table thead th[data-tcol='topic']");
    // On the heading's label, not its centre (the heading's own sort-and-filter
    // button sits beside the label and a click on it opens the menu instead).
    await tagsTh.click({ position: { x: 8, y: 10 } });
    await expect(tagsTh).toHaveAttribute("aria-sort", "ascending");
    const firstTitle = async () => (await rows.first().innerText());
    expect(await firstTitle(), "ascending by topic: alpha… (a) before beta (b)").toContain(titles.a);
    expect(await rows.last().innerText(), "the topicless question sorts last").toContain(titles.c);
    await tagsTh.press("Enter");
    await expect(tagsTh).toHaveAttribute("aria-sort", "descending");
    expect(await firstTitle(), "descending: beta (b) first").toContain(titles.b);
    expect(await rows.last().innerText(), "blanks still last when descending").toContain(titles.c);
    // A native heading takes over: the component sort is dropped.
    await page.locator("#admin-task-table thead th[data-col='title']").click();
    await expect(tagsTh).toHaveAttribute("aria-sort", "none");
  });

  test("Participants: a status heading filter narrows before paging and says so", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Participants");
    const rows = page.locator("#admin-participants-body tr");
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    await page.locator("#p-table thead th[data-col='name'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("Maximiliana", { delay: 20 });
    await expect(rows).toHaveCount(1, { timeout: 5000 });
    await expect(rows.first()).toContainText("Maximiliana");
    await expect(page.locator("#participants-search-count")).toContainText(/1 of/);
    // Sort buttons in the menu drive the native heading sort.
    await page.locator(".tcol-pop [data-tcol-sort='desc']").click();
    await expect(page.locator("#p-table thead th[data-col='name']")).toHaveAttribute("aria-sort", "descending", { timeout: 5000 });
    await page.locator(".tcol-pop [data-tcol-fclear]").click();
    await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(1);
  });

  // ── 4. Phone: the headings are hidden by the cards; Sort & filter is the door ──
  const PHONE = { width: 390, height: 844 };
  // The keys of the heading buttons a reader can SEE: their heading has a box.
  // At 390 the card layout clips every heading to 1 px, so this reads [] there.
  const shownHeadKeys = (page, table) => page.locator(`${table} thead th .tcol-hbtn`).evaluateAll(bs => bs
    .filter(b => { const r = b.closest("th").getBoundingClientRect(); return r.width > 1 && r.height > 1; })
    .map(b => b.dataset.tcolMenu));
  const withinPhone = async (loc, what) => {
    const b = await loc.boundingBox();
    expect(b, `${what} has a box`).not.toBeNull();
    expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= PHONE.width && b.y + b.height <= PHONE.height,
      `${what} sits on the ${PHONE.width}x${PHONE.height} screen: ${JSON.stringify(b)}`).toBe(true);
    return b;
  };

  test("Phone: Sort & filter above the cards opens each heading's own sort and filter (Question bank)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    const rows = page.locator("#admin-task-body tr");
    await expect(rows).toHaveCount(3, { timeout: 15000 });
    const bar = page.locator(".tcol-bar[data-tcols-for='challenges']");
    const sf = bar.locator(".tcol-sf-btn");
    const wide = await shownHeadKeys(page, "#admin-task-table");
    expect(wide.length, "anti-vacuity: the wide headings carry their buttons").toBeGreaterThanOrEqual(4);
    expect(wide).toEqual(expect.arrayContaining(["title", "difficulty"]));
    await expect(sf, "control: no Sort & filter where the headings show").toBeHidden();

    await page.setViewportSize(PHONE);
    await expect(rows.first()).toHaveCSS("display", "grid");   // premise: cards
    expect(await shownHeadKeys(page, "#admin-task-table"), "premise: the cards hide every heading button").toEqual([]);
    await expect(sf).toBeVisible();
    const sb = await withinPhone(sf, "Sort & filter");
    expect(sb.height, "a 44 px touch target").toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll").toBe(true);

    await sf.click();
    const list = page.locator(".tcol-sf-pop");
    await expect(list).toBeVisible();
    await expect(sf).toHaveAttribute("aria-expanded", "true");
    expect(await list.locator("[data-tcol-pick]").evaluateAll(bs => bs.map(b => b.dataset.tcolPick)),
      "the same columns as the wide headings, in the same order").toEqual(wide);
    await withinPhone(list, "the column list");
    for (const h of await list.locator("[data-tcol-pick]").evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height))) {
      expect(h, "every column is a 44 px target").toBeGreaterThanOrEqual(44);
    }
    const axe = await new AxeBuilder({ page }).include(".tcol-sf-pop").analyze();
    expect(axe.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact)).map(v => v.id), "axe on the phone column list").toEqual([]);

    // FILTER through it: Difficulty = hard narrows the whole library.
    await list.locator("[data-tcol-pick='difficulty']").click();
    const menu = page.locator(".tcol-pop[role='dialog']:not(.tcol-sf-pop)");
    await expect(menu.locator(".t-eyebrow")).toHaveText("Difficulty");
    await withinPhone(menu, "the Difficulty menu");
    await menu.locator("select").selectOption("hard");
    await expect(rows).toHaveCount(1, { timeout: 5000 });
    await expect(rows.first()).toContainText(titles.a);
    await expect(rows.filter({ hasText: titles.b }), "control: the medium challenge goes").toHaveCount(0);
    await expect(sf, "the button shows the list is filtered").toHaveClass(/is-on/);
    await expect(bar.locator(".tcol-note")).toContainText("Filtered by Difficulty");
    // All columns: back to the list, which names the filter on that column only.
    await menu.locator("[data-tcol-back]").click();
    await expect(list.locator("[data-tcol-pick='difficulty'] .tcol-pick-state")).toHaveText("Filtered");
    await expect(list.locator("[data-tcol-pick='status']"), "control: an unfiltered column says nothing").not.toContainText("Filtered");
    await list.locator("[data-tcol-pclear]").click();
    await expect(rows).toHaveCount(3, { timeout: 5000 });
    await expect(sf).not.toHaveClass(/is-on/);

    // SORT through it: the Title heading's own sort, both ways.
    const order = async () => (await rows.allInnerTexts())
      .map(t => t.includes(titles.a) ? "a" : t.includes(titles.b) ? "b" : t.includes(titles.c) ? "c" : "?").join("");
    expect(await order(), "precondition: not already descending").not.toBe("cba");
    await page.locator(".tcol-sf-pop [data-tcol-pick='title']").click();
    await menu.locator("[data-tcol-sort='desc']").click();
    await expect.poll(order, { timeout: 5000 }).toBe("cba");
    await expect(page.locator("#admin-task-table thead th[data-col='title']")).toHaveAttribute("aria-sort", "descending");
    await menu.locator("[data-tcol-sort='asc']").click();
    await expect.poll(order, { timeout: 5000 }).toBe("abc");
    // A newer press owns the heading. Descending then Ascending in one task: the
    // heading (which sorts as it is clicked) is clicked once per press, never a
    // third and fourth time by the first press's 60 ms look-again, which flipped
    // it to descending in between (seen in the pinned CI image).
    await page.evaluate(() => {
      window.__titleClicks = 0;
      document.querySelector("#admin-task-table thead th[data-col='title']").addEventListener("click", () => { window.__titleClicks++; });
    });
    await menu.evaluate(m => { m.querySelector("[data-tcol-sort='desc']").click(); m.querySelector("[data-tcol-sort='asc']").click(); });
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));   // past any look-again
    expect(await page.evaluate(() => window.__titleClicks), "one heading click per press").toBe(2);
    expect(await order(), "the last press wins").toBe("abc");
    await expect(page.locator("#admin-task-table thead th[data-col='title']")).toHaveAttribute("aria-sort", "ascending");
    await menu.locator("[data-tcol-back]").click();
    await expect(list.locator("[data-tcol-pick='title'] .tcol-pick-state"), "the list says which column sorts the cards").toHaveText("Sorted ascending");
    await expect(list.locator("[data-tcol-pick='difficulty'] .tcol-pick-state"), "control: no other column claims it").toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tcol-pop")).toHaveCount(0);
    await expect(sf, "Escape returns focus to Sort & filter").toBeFocused();
    await expect(sf).toHaveAttribute("aria-expanded", "false");
  });

  // The cards hide the headings, and that includes the KEYBOARD: a heading was
  // only clipped to 1 px, so its tab stop (a sortable th, tabindex 0) and its
  // menu button stayed in the tab order — Tab landed on controls nobody could
  // see, and Space on them sorted the cards unseen. Select-all stays reachable.
  test("Phone: the hidden headings hold no tab stop; select-all keeps one (control: a wide screen's headings do)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    const rows = page.locator("#admin-task-body tr");
    await expect(rows).toHaveCount(3, { timeout: 15000 });
    // Can each heading control take focus? (focus() is a no-op on one that cannot.)
    const focusable = () => page.evaluate(() => {
      const can = (el) => { el.focus(); return document.activeElement === el; };
      // The columns this table shows (a column hidden by the Columns chooser is
      // display:none at every width, so it is no witness either way).
      const shown = [...document.querySelectorAll("#admin-task-table thead th:not(.cb-cell)")].filter(th => !th.classList.contains("tcol-off"));
      const heads = shown.filter(th => th.getAttribute("tabindex") === "0");
      const btns = shown.flatMap(th => [...th.querySelectorAll(".tcol-hbtn")]);
      const all = document.querySelector("#admin-task-table thead .cb-cell input[type=checkbox]");
      const out = { heads: heads.length, btns: btns.length, headsFocusable: heads.filter(can).length, btnsFocusable: btns.filter(can).length, selectAll: !!all && can(all) };
      document.activeElement && document.activeElement.blur();
      return out;
    });
    const wide = await focusable();
    expect(wide.heads, `anti-vacuity: sortable headings with a tab stop exist: ${JSON.stringify(wide)}`).toBeGreaterThanOrEqual(3);
    expect(wide.btns, "anti-vacuity: heading menu buttons exist").toBeGreaterThanOrEqual(4);
    expect(wide, "CONTROL: on a wide screen every heading control takes focus")
      .toMatchObject({ headsFocusable: wide.heads, btnsFocusable: wide.btns, selectAll: true });

    await page.setViewportSize(PHONE);
    await expect(rows.first()).toHaveCSS("display", "grid");   // premise: cards
    const phone = await focusable();
    expect(phone, "on a phone no hidden heading control takes focus, and select-all still does")
      .toMatchObject({ headsFocusable: 0, btnsFocusable: 0, selectAll: true });
    // And Tab from Sort & filter walks past them: nothing it reaches is a heading.
    const sf = page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-sf-btn");
    await sf.focus();
    const reached = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      reached.push(await page.evaluate(() => {
        const a = document.activeElement;
        return { inHiddenHead: !!a.closest("#admin-task-table thead th:not(.cb-cell)"), what: `${a.tagName}${a.id ? "#" + a.id : ""}${a.className ? "." + String(a.className).split(" ")[0] : ""}` };
      }));
    }
    expect(reached.filter(r => r.inHiddenHead), `Tab reached a hidden heading control: ${JSON.stringify(reached)}`).toEqual([]);
    expect(reached.some(r => r.what.startsWith("INPUT#select-all")), `CONTROL: Tab does reach select-all: ${JSON.stringify(reached)}`).toBe(true);
  });

  test("Phone: every card table offers Sort & filter with the wide headings' columns; a server sort goes through it", async ({ page }) => {
    test.setTimeout(120_000);
    const subsSeen = await mockJson(page, "**/api/admin/submissions?**", () => submissionsBody([
      { nickname: `${STAMP}_zed`, task_title: "Regex Golf" }, { nickname: `${STAMP}_amy`, task_title: "SQL Injection" },
    ], { total: 2, sorted_globally: true }));
    await mockJson(page, "**/api/admin/logs?**", () => logsBody([{ level: "warn", msg: `${STAMP} slow` }, { level: "info", msg: `${STAMP} served` }]));
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    const TABLES = [
      { tab: "Events", key: "events", table: "#admin-comp-table" },
      { tab: "Participants", key: "participants", table: "#p-table" },
      { tab: "Submissions", key: "submissions", table: "table[data-tcols='submissions']" },
      { tab: "Logs", key: "logs", table: "table[data-tcols='logs']" },
      { tab: "Audit", key: "audit", table: "table[data-tcols='audit']" },
    ];
    for (const t of TABLES) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await clickTab(page, t.tab);
      await expect.poll(() => shownHeadKeys(page, t.table), { timeout: 15000, message: `${t.tab}: heading buttons` }).not.toEqual([]);
      const wide = await shownHeadKeys(page, t.table);
      const sf = page.locator(`.tcol-bar[data-tcols-for='${t.key}'] .tcol-sf-btn`);
      await expect(sf, `${t.tab}: control, hidden on a wide screen`).toBeHidden();
      await page.setViewportSize(PHONE);
      expect(await shownHeadKeys(page, t.table), `${t.tab}: premise, the cards hide the headings`).toEqual([]);
      await expect(sf, `${t.tab}: Sort & filter on a phone`).toBeVisible();
      expect((await withinPhone(sf, `${t.tab} Sort & filter`)).height).toBeGreaterThanOrEqual(44);
      await sf.click();
      const list = page.locator(".tcol-sf-pop");
      await expect(list).toBeVisible();
      expect(await list.locator("[data-tcol-pick]").evaluateAll(bs => bs.map(b => b.dataset.tcolPick)), `${t.tab}: the wide headings' columns`).toEqual(wide);
      await withinPhone(list, `${t.tab} column list`);
      if (t.key === "submissions") {
        // A SERVER sort: the phone path sends the same ONE request as the heading.
        await list.locator("[data-tcol-pick='participant']").click();
        const before = subsSeen.length;
        await page.locator(".tcol-pop [data-tcol-sort='desc']").click();
        await expect(page.locator(`${t.table} thead th[data-col='participant']`)).toHaveAttribute("aria-sort", "descending", { timeout: 5000 });
        await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
        expect(subsSeen.slice(before).map(u => `${u.searchParams.get("sort")}:${u.searchParams.get("dir")}:${u.searchParams.get("offset")}`),
          "exactly one request: participant, descending, page 1").toEqual(["participant:desc:0"]);
      }
      await page.keyboard.press("Escape");
      await expect(page.locator(".tcol-pop")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${t.tab}: no sideways scroll`).toBe(true);
    }
  });

  // THE TOUCH TARGET (sweep #430). On a phone a table that keeps its headings
  // (Groups, Live rankings, Analytics, the Checkmarx One removals) has no Sort &
  // filter: the heading's own button is the only way to its sort and filter. On
  // a touch screen that button answers across 44 x 44 (the house rule) while it
  // is still drawn at 24 px, and the target stays inside its heading: a tap in
  // the heading's middle still sorts, and the first row is never the button.
  // From 1280 px every table's headings take it too (between 769 and 1279 px the
  // wider strips would not fit the tables: the 24 px button stays there). The
  // ring of points 21 px out is the witness; the taps are not (Chromium's touch
  // adjustment snaps a near-miss tap onto a nearby button anyway).
  // Control: with a mouse the target is the 24 px button alone.
  test("Touch: a heading's sort-and-filter button answers across 44 px inside its heading; the middle still sorts (control: a mouse, 24 px)", async ({ browser }) => {
    test.setTimeout(120_000);
    // Groups keeps its headings at every width; the Challenge library is a card
    // table on a phone and keeps them only on a wide screen.
    const GROUPS = { tab: "Groups", narrow: narrowGroupsTable, th: "table[data-tcols='groups'] thead th[data-col='name']" };
    const CHALLENGES = { tab: "Challenges", narrow: narrowChallengesTable, th: "#admin-task-table thead th[data-col='difficulty']" };
    const probe = async (touch, viewport, where) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport, hasTouch: touch });
      try {
        const page = await ctx.newPage();
        await adminLogin(page);
        await clickTab(page, where.tab);
        await where.narrow(page, STAMP);
        const th = page.locator(where.th);
        await expect(th.locator(".tcol-hbtn")).toBeVisible();
        const m = await th.evaluate((h) => {
          const b = h.querySelector(".tcol-hbtn");
          // On a phone the table scrolls inside its own box: bring the button on screen.
          b.scrollIntoView({ block: "center", inline: "center" });
          const r = b.getBoundingClientRect(), hr = h.getBoundingClientRect();
          const row = h.closest("table").tBodies[0].rows[0].getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const isBtn = (x, y) => { const e = document.elementFromPoint(x, y); return !!(e && (e === b || b.contains(e))); };
          const out = { coarse: matchMedia("(pointer:coarse)").matches, drawn: [Math.round(r.width), Math.round(r.height)],
            centre: isBtn(cx, cy), ring: [isBtn(cx - 21, cy), isBtn(cx + 21, cy), isBtn(cx, cy - 21), isBtn(cx, cy + 21)],
            // The target stays in its heading: inside its box, never on the first row.
            inside: r.left - 10 >= hr.left - 0.5 && r.right + 10 <= hr.right + 0.5 && r.top - 10 >= hr.top - 0.5 && r.bottom + 10 <= hr.bottom + 0.5,
            firstRow: isBtn(cx, row.top + 1) };
          // The heading's middle, or, for a heading running off the screen, the
          // middle of what shows of it beside the button's target.
          const left = Math.max(hr.left, 0), shownMid = left + (Math.min(hr.right, innerWidth) - left) / 2;
          const mx = shownMid <= r.left - 10 ? shownMid : (left + r.left - 10) / 2;
          return { ...out, middle: isBtn(mx, cy), mid: [mx, cy] };
        });
        let sorted = null, opened = null;
        if (touch) {
          // A tap in the heading's middle sorts and opens no menu ...
          const before = await th.getAttribute("aria-sort");
          await page.touchscreen.tap(m.mid[0], m.mid[1]);
          await expect(th).not.toHaveAttribute("aria-sort", before || "none", { timeout: 5000 });
          sorted = (await page.locator(".tcol-pop").count()) === 0;
          // ... and a tap 18 px left of the button's centre, outside its drawn box,
          // opens the menu (measured again: the sort can move the columns).
          const edge = await th.locator(".tcol-hbtn").evaluate((b) => { b.scrollIntoView({ block: "center", inline: "center" }); const r = b.getBoundingClientRect(); return [r.left + r.width / 2 - 18, r.top + r.height / 2]; });
          await page.touchscreen.tap(edge[0], edge[1]);
          await expect(page.locator(".tcol-pop")).toBeVisible({ timeout: 5000 });
          opened = true;
          await page.keyboard.press("Escape");
        }
        return { ...m, sorted, opened };
      } finally { await ctx.close(); }
    };
    const WIDE = { width: 1280, height: 900 };
    for (const [viewport, where] of [[PHONE, GROUPS], [WIDE, GROUPS], [WIDE, CHALLENGES]]) {
      const touch = await probe(true, viewport, where);
      const at = `${where.tab} ${viewport.width}px ${JSON.stringify(touch)}`;
      expect(touch.coarse, `PRECONDITION: the touch context reports a coarse pointer (${at})`).toBe(true);
      expect(touch.drawn, `the button is still drawn at 24 px (${at})`).toEqual([24, 24]);
      expect(touch.ring, `every point 21 px from its centre is the button's target (${at})`).toEqual([true, true, true, true]);
      expect(touch.inside, `the 44 px target stays inside its heading (${at})`).toBe(true);
      expect(touch.firstRow, `the first row under it is not the button (${at})`).toBe(false);
      expect(touch.middle, `the heading's middle is not the button (${at})`).toBe(false);
      expect(touch.sorted, `a tap in the middle sorts and opens no menu (${at})`).toBe(true);
      expect(touch.opened, `a tap on the target outside the drawn box opens the menu (${at})`).toBe(true);
    }
    const mouse = await probe(false, PHONE, GROUPS);
    expect(mouse.coarse, "PRECONDITION: the mouse context does not").toBe(false);
    expect(mouse.centre, "CONTROL: the centre is the button with a mouse too").toBe(true);
    expect(mouse.drawn, "CONTROL: drawn at 24 px").toEqual([24, 24]);
    expect(mouse.ring, `CONTROL: with a mouse the target is the 24 px button alone: ${JSON.stringify(mouse)}`).toEqual([false, false, false, false]);
  });

  // From 769 to 1279 px the 48 px strip would push the tables past their cards,
  // so a coarse pointer meets each heading button at its drawn 24 px; every
  // table's bar then shows Sort & filter, a 44 px door to the same heading menus
  // (operator ruling, 24 Nov 2026). Groups keeps its headings at every width (a
  // `.table-wrap`), the Challenge library is a `.table-card`: both must offer it.
  // Controls: a mouse at the same width, and a touch screen at 1280 px (whose
  // headings take the 44 px target), show none.
  test("Touch, 769-1279 px: a table's bar offers Sort & filter, a 44 px door to its heading menus (Groups, a .table-wrap; the Challenge library, a .table-card; controls: a mouse; touch at 1280 px)", async ({ browser }) => {
    test.setTimeout(180_000);
    const TABLES = [
      { tab: "Groups", key: "groups", narrow: narrowGroupsTable },
      { tab: "Challenges", key: "challenges", narrow: narrowChallengesTable },
    ];
    const probe = async (touch, width, drive) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, hasTouch: touch });
      try {
        const page = await ctx.newPage();
        await adminLogin(page);
        const out = { coarse: await page.evaluate(() => matchMedia("(pointer:coarse)").matches), shown: {}, height: {} };
        for (const t of TABLES) {
          await clickTab(page, t.tab);
          await t.narrow(page, STAMP);
          const bar = page.locator(`.tcol-bar[data-tcols-for='${t.key}']`);
          await expect(bar, `${t.key}: its bar is drawn`).toBeVisible();
          const sf = bar.locator(".tcol-sf-btn");
          out.shown[t.key] = await sf.isVisible();
          if (out.shown[t.key]) out.height[t.key] = Math.round((await sf.boundingBox()).height);
        }
        if (drive) {
          // The library: the list holds the wide headings' columns, and a pick opens
          // that heading's own menu, whose filter narrows the whole library.
          const rows = page.locator("#admin-task-body tr");
          await expect(rows).toHaveCount(3, { timeout: 15000 });
          const sf = page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-sf-btn");
          const wide = await shownHeadKeys(page, "#admin-task-table");
          expect(wide.length, "anti-vacuity: the headings show, with their buttons").toBeGreaterThanOrEqual(4);
          await sf.tap();
          const list = page.locator(".tcol-sf-pop");
          await expect(list).toBeVisible();
          expect(await list.locator("[data-tcol-pick]").evaluateAll(bs => bs.map(b => b.dataset.tcolPick)),
            "the same columns as the headings' buttons, in the same order").toEqual(wide);
          for (const h of await list.locator("[data-tcol-pick]").evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height))) {
            expect(h, "every column is a 44 px target").toBeGreaterThanOrEqual(44);
          }
          await list.locator("[data-tcol-pick='difficulty']").tap();
          const menu = page.locator(".tcol-pop[role='dialog']:not(.tcol-sf-pop)");
          await expect(menu.locator(".t-eyebrow")).toHaveText("Difficulty");
          await menu.locator("select").selectOption("hard");
          await expect(rows).toHaveCount(1, { timeout: 5000 });
          await expect(rows.first()).toContainText(titles.a);
          await expect(page.locator("#admin-task-table thead th[data-col='difficulty'] .tcol-hbtn"),
            "the heading's own button shows the same filter").toHaveClass(/is-on/);
          await expect(sf, "and so does Sort & filter").toHaveClass(/is-on/);
          await menu.locator("[data-tcol-fclear]").click();
          await expect(rows).toHaveCount(3, { timeout: 5000 });
          await page.keyboard.press("Escape");
          await expect(page.locator(".tcol-pop")).toHaveCount(0);
        }
        return out;
      } finally { await ctx.close(); }
    };
    for (const width of [800, 1024]) {
      const r = await probe(true, width, width === 1024);
      const at = `${width}px ${JSON.stringify(r)}`;
      expect(r.coarse, `PRECONDITION: the touch context reports a coarse pointer (${at})`).toBe(true);
      expect(r.shown, `both representative bars show Sort & filter (${at})`).toEqual({ groups: true, challenges: true });
      expect(r.height.groups >= 44 && r.height.challenges >= 44, `a 44 px target (${at})`).toBe(true);
    }
    const mouse = await probe(false, 1024, false);
    expect(mouse.coarse, "PRECONDITION: the mouse context does not report a coarse pointer").toBe(false);
    expect(mouse.shown, "CONTROL: with a mouse the headings' buttons are the door").toEqual({ groups: false, challenges: false });
    const wideTouch = await probe(true, 1280, false);
    expect(wideTouch.coarse, "PRECONDITION: coarse at 1280 px").toBe(true);
    expect(wideTouch.shown, "CONTROL: from 1280 px the headings take the 44 px target").toEqual({ groups: false, challenges: false });
  });
});
