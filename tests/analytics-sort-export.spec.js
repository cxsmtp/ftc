// @ts-check
//
// v7.24.0 — THE ANALYTICS PER-CHALLENGE TABLE: default order, and Export CSV.
//
// Two changes, one fixture style. The default row order used to be "total
// events, descending" for every scope, which reads as arbitrary to anyone
// looking at one competition — the row an admin wants is the one whose NUMBER
// they can see on the participant's screen. It is now:
//
//   competition / session scope → challenge number, ascending
//   global scope               → challenge name, ascending
//
// and the same order is what the new Export CSV button writes.
//
// WHY THE PAYLOAD IS INTERCEPTED rather than seeded: the ordering rules have to
// be driven with numbers a real fixture cannot easily produce — a bucket past
// 99 (where the zero-padding runs out and a string sort inverts), and a row
// with NO number at all (reachable when a challenge is unassigned from the
// competition but keeps its challenge_events). Seeding those would take a
// hundred challenges and a mid-test unassign; the ordering is pure client-side
// computation over the payload, so the payload is the honest input. It is also
// the documented pattern for this table (v7.20.7): injecting rows via
// evaluate() loses a race, because the tab issues its own fetch which resolves
// afterwards and re-renders over them.
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE, apiLogin } = require("./helpers");
const { openAnalyticsTab } = require("./ui-admin-helpers"); // v8.1.0 — one analytics entry point
const fs = require("fs");

test.use({ baseURL: BASE });
const GUH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

async function adminPage(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: GUH(csrfToken),
    data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

const row = (o) => ({
  task_id: o.id, task_number: o.num ?? null, title: o.title,
  difficulty: o.difficulty || "easy", tags: o.tags || [],
  solved: o.solved ?? 0, incorrect: o.incorrect ?? 0,
  hint_revealed: o.hints ?? 0, navigated_away: o.nav ?? 0,
  unique_attempters: o.attempters ?? 0,
});

/**
 * Serve a fixed analytics payload and open the tab.
 *
 * `scope` is echoed back the way the real endpoint echoes it, because the
 * CLIENT reads `_analyticsState.scope` for the default sort and reads
 * `data.scope` for the export FILENAME — two different things, and a fixture
 * that only set one of them would leave half the behaviour untested.
 */
async function openAnalytics(page, rows, scope = { type: "global" }) {
  await page.route("**/api/admin/analytics/challenges*", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ per_challenge: rows, summary: {}, totals: {}, scope }),
  }));
  await openAnalyticsTab(page);
  // The table pages at 25, so the readiness gate is the PAGE size, not the
  // payload size — the 30-row export test depends on those two differing.
  await expect.poll(async () => page.locator("#analytics-table-body tr").count(),
    { timeout: 20000 }).toBe(Math.min(rows.length, 25));
}

/** Set the client's own scope state, then re-render from the cached response. */
async function setScope(page, scope, competitionId = "c1") {
  await page.evaluate(([s, cid]) => {
    window._analyticsState.scope = s;
    window._analyticsState.competitionId = cid;
    window.renderAnalyticsTable(window._analyticsState.lastResponse);
  }, [scope, competitionId]);
}

const titlesOnScreen = (page) =>
  page.locator("#analytics-table-body tr td:nth-child(2)").allInnerTexts();

/** Parse a CSV whose every field is quoted (which is what ui/csv.js emits). */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = "", inQ = false, started = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQ) {
      if (ch === '"') { if (body[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') { inQ = true; started = true; }
    else if (ch === ",") { row.push(field); field = ""; started = false; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; started = false; }
    else field += ch;
  }
  if (field.length || started || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function exportCsv(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.locator("#analytics-export-csv-btn").click(),
  ]);
  return { download, rows: parseCsv(fs.readFileSync(await download.path(), "utf8")) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DEFAULT ORDER — one fixture, both scopes, and the two cases a plain
//    string sort gets wrong.
// ─────────────────────────────────────────────────────────────────────────────
//
// The numbers are chosen so that NUMBER order, TITLE order and PAYLOAD order
// all disagree. Without that a correct implementation is indistinguishable
// from one that sorted by the wrong key or did not sort at all.
//
//   payload order : Delta, Alpha, Charlie, Bravo, Echo
//   title  order  : Alpha, Bravo, Charlie, Delta, Echo
//   number order  : Charlie 1.10, Bravo 1.99, Delta 1.100, Alpha 2.01, Echo —
//
// THE NUMBERS ARE 1.10 / 1.99 / 1.100 SPECIFICALLY. Numerically that is
// 10 < 99 < 100; as TEXT it is "1.10" < "1.100" < "1.99", i.e. Charlie, Delta,
// Bravo — a different order. That is the case the two-digit zero-padding cannot
// express, and it is the ONLY arrangement here that distinguishes the numeric
// comparator from a plain string sort. (A first draft used 1.09/1.10/1.100 and
// the string mutation PASSED, because "1.10" is a prefix of "1.100" and the two
// orders coincide.) `Echo` carries no number at all and must land LAST.
// Solve rates are all DISTINCT (100 / 80 / 50 / 25 / 10 %) on purpose: a tie
// would make the pinned-sort assertion below depend on V8 sort stability over
// the PAYLOAD order, which is an implementation detail rather than a promise.
const ORDER_ROWS = [
  row({ id: "t-d", num: "1.100", title: "Delta",   difficulty: "easy",   solved: 1, attempters: 10 }), //  10%
  row({ id: "t-a", num: "2.01",  title: "Alpha",   difficulty: "medium", solved: 9, attempters: 9 }),  // 100%
  row({ id: "t-c", num: "1.10",  title: "Charlie", difficulty: "hard",   solved: 2, attempters: 8 }),  //  25%
  row({ id: "t-b", num: "1.99",  title: "Bravo",   difficulty: "easy",   solved: 4, attempters: 5 }),  //  80%
  row({ id: "t-e", num: null,    title: "Echo",    difficulty: "easy",   solved: 3, attempters: 6 }),  //  50%
];

test.describe("v7.24.0 — the analytics table's default order", () => {
  test("global scope orders by challenge NAME; competition scope by challenge NUMBER", async ({ page }) => {
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);

    // Global: by title. Note this is also the assertion that proves the default
    // is not simply "payload order" — the payload leads with Delta.
    expect(await titlesOnScreen(page)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);

    await setScope(page, "competition");
    expect(await titlesOnScreen(page),
      "1.10 < 1.99 < 1.100 NUMERICALLY (as text it is 1.10 < 1.100 < 1.99), and the unnumbered row sorts LAST")
      .toEqual(["Charlie", "Bravo", "Delta", "Alpha", "Echo"]);

    // A SESSION is a competition scope too — the number exists there as well,
    // so the rule is "not global" rather than "competition".
    await setScope(page, "timeslot");
    expect(await titlesOnScreen(page)).toEqual(["Charlie", "Bravo", "Delta", "Alpha", "Echo"]);
  });

  test("the default order is ANNOUNCED, not merely applied", async ({ page }) => {
    // A sort a screen-reader user cannot perceive is conveyed by row order
    // alone, i.e. not at all — which is what audit M23 added aria-sort for. The
    // attribute used to be written only by the header-click handler, so a
    // freshly-opened table announced "none" on all twelve columns while being
    // sorted.
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);
    const ariaOf = (col) => page.locator(`#analytics-table thead th[data-sort="${col}"]`).getAttribute("aria-sort");

    expect(await ariaOf("title"), "global default is title-ascending").toBe("ascending");
    expect(await ariaOf("task_number")).toBe("none");

    await setScope(page, "competition");
    expect(await ariaOf("task_number"), "competition default is number-ascending").toBe("ascending");
    expect(await ariaOf("title")).toBe("none");
  });

  test("clicking the column the table is ALREADY sorted by flips it", async ({ page }) => {
    // The first click a real admin makes is on the column the default already
    // used, and `sortKey` starts null — so a handler comparing the RAW state
    // (`sortKey === k`) finds no match, re-pins the same key in the same
    // direction, and NOTHING MOVES. A header that does nothing when clicked
    // reads as broken. It has to compare against the EFFECTIVE sort.
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);

    const th = page.locator('#analytics-table thead th[data-sort="title"]');
    expect(await titlesOnScreen(page), "the global default is title-ascending")
      .toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);

    await th.click();
    expect(await titlesOnScreen(page), "one click on the ACTIVE column reverses it")
      .toEqual(["Echo", "Delta", "Charlie", "Bravo", "Alpha"]);
    expect(await th.getAttribute("aria-sort")).toBe("descending");

    await th.click();
    expect(await titlesOnScreen(page), "and back again")
      .toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    expect(await th.getAttribute("aria-sort")).toBe("ascending");

    // The same on the competition-scope default, which is a different column —
    // so this cannot pass by the handler special-casing `title`.
    //
    // The pin has to be released first: the two clicks above deliberately pinned
    // `title`, and a pin SURVIVING a scope change is the documented behaviour
    // (asserted in the next test). Without this the scope default never applies
    // and the assertion below would be about the pin, not the default.
    await page.evaluate(() => { window._analyticsState.sortKey = null; });
    await setScope(page, "competition");
    const num = page.locator('#analytics-table thead th[data-sort="task_number"]');
    expect(await titlesOnScreen(page)).toEqual(["Charlie", "Bravo", "Delta", "Alpha", "Echo"]);
    await num.click();
    expect(await titlesOnScreen(page), "unnumbered rows stay LAST in both directions")
      .toEqual(["Alpha", "Delta", "Bravo", "Charlie", "Echo"]);
  });

  test("clicking a header PINS a sort that outranks the default, in both directions", async ({ page }) => {
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);

    // Solve rate: Alpha 100%, Bravo 80%, Echo 50%, Charlie 25%, Delta 10%.
    await page.locator('#analytics-table thead th[data-sort="solve_rate"]').click();
    expect(await titlesOnScreen(page), "first click on a numeric column is descending")
      .toEqual(["Alpha", "Bravo", "Echo", "Charlie", "Delta"]);  // 100 80 50 25 10
    expect(await page.locator('#analytics-table thead th[data-sort="solve_rate"]').getAttribute("aria-sort"))
      .toBe("descending");

    await page.locator('#analytics-table thead th[data-sort="solve_rate"]').click();
    expect(await titlesOnScreen(page), "a second click flips it")
      .toEqual(["Delta", "Charlie", "Echo", "Bravo", "Alpha"]);

    // The pin SURVIVES a scope change — it is a choice the admin made, and
    // silently reverting it to the default would be the surprise.
    await setScope(page, "competition");
    expect(await titlesOnScreen(page), "an explicit sort outranks the scope default")
      .toEqual(["Delta", "Charlie", "Echo", "Bravo", "Alpha"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXPORT CSV
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.24.0 — Export CSV from the analytics table", () => {
  test("it exports every FILTERED row, not the page on screen, in the table's order", async ({ page }) => {
    await adminPage(page);
    // 30 rows against a 25-row page: the page-vs-filtered-set distinction is
    // the whole point, and a fixture inside one page could not express it.
    // Numbered so that number order is the REVERSE of title order, so the file
    // cannot pass by having been written in either payload or title order.
    const rows = Array.from({ length: 30 }, (_, i) => row({
      id: `x${i}`, num: `1.${String(30 - i).padStart(2, "0")}`,
      title: `Challenge ${String(i).padStart(2, "0")}`,
      difficulty: ["easy", "medium", "hard"][i % 3],
      solved: i, incorrect: 1, hints: 2, nav: 3, attempters: 10,
      tags: i === 0 ? ["alpha", "beta", "gamma", "delta", "epsilon"] : [],
    }));
    await openAnalytics(page, rows, { type: "competition", competition_id: "c1", competition_name: "Rocket Day" });
    await setScope(page, "competition");

    await expect(page.locator("#analytics-table-body tr"), "the SCREEN shows one page").toHaveCount(25);

    const { download, rows: csv } = await exportCsv(page);
    expect(download.suggestedFilename()).toBe(
      `analytics-rocket-day-${new Date().toISOString().slice(0, 10)}.csv`);

    // v7.29.0 — "Total Events" → "Total Activity". A deliberate rename, not a
    // regression: "Event" became the platform's collective noun for a
    // competition, and the column counts the four participant signals the
    // platform already calls ACTIVITY elsewhere (the competition-activity CSV,
    // the "Export Activity" kebab item). It also closes a pre-existing mismatch —
    // the file said "Total Events" while the screen said "Total", and the header
    // is the contract with the human reading the file (v7.15.8).
    expect(csv[0]).toEqual([
      "Challenge ID", "Title", "Difficulty", "Tags", "Total Activity",
      "Solved", "Incorrect", "Hints Revealed", "Navigated Away",
      "Unique Attempters", "Solve Rate (%)",
    ]);
    expect(csv.length - 1, "all 30 filtered rows, not the 25 on screen").toBe(30);

    // Number order, which is the reverse of the titles.
    expect(csv[1][0]).toBe("1.01");
    expect(csv[1][1]).toBe("Challenge 29");
    expect(csv[30][0]).toBe("1.30");
    expect(csv[30][1]).toBe("Challenge 00");

    // Cell mapping, on the row whose signals are all distinct from one another.
    const c00 = csv.find(r => r[1] === "Challenge 00");
    expect(c00.slice(2)).toEqual([
      "easy",
      // The TABLE truncates to four tags + "+1"; the file carries all five.
      "alpha; beta; gamma; delta; epsilon",
      "6",  // 0 solved + 1 incorrect + 2 hints + 3 nav
      "0", "1", "2", "3",
      "10", // unique attempters — the solve-rate denominator
      "0",  // 0/10
    ]);
    const c29 = csv.find(r => r[1] === "Challenge 29");
    expect(c29[10], "29 solved of 10 attempters rounds to 290%").toBe("290");
  });

  test("it exports what the SEARCH box narrowed to, and nothing else", async ({ page }) => {
    await adminPage(page);
    const rows = [
      row({ id: "n1", num: "1.01", title: "Needle one",  difficulty: "hard" }),
      row({ id: "h1", num: "1.02", title: "Haystack A",  difficulty: "easy" }),
      row({ id: "n2", num: "1.03", title: "Needle two",  difficulty: "easy", tags: ["needle-tag"] }),
      row({ id: "h2", num: "1.04", title: "Haystack B",  difficulty: "easy" }),
    ];
    await openAnalytics(page, rows, { type: "competition", competition_name: "Scoped" });
    await setScope(page, "competition");

    await page.locator("#analytics-search").fill("needle");
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(2);

    const { rows: csv } = await exportCsv(page);
    expect(csv.length - 1).toBe(2);
    expect(csv.slice(1).map(r => r[1])).toEqual(["Needle one", "Needle two"]);

    // POSITIVE CONTROL: without it, "the export respects the search" is equally
    // satisfied by an export that always emitted two rows, or none.
    await page.locator("#analytics-search").fill("");
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(4);
    const { rows: all } = await exportCsv(page);
    expect(all.length - 1).toBe(4);
  });

  // A heading filter is a filter the admin set on screen, so it narrows the file
  // exactly as the search does — over every page, not the 25 rows on screen —
  // and the file keeps every column whatever the Columns chooser hides.
  test("it exports what a HEADING filter left, across every page, with every column", async ({ page }) => {
    await adminPage(page);
    // 30 rows over two pages; the needles sit on both pages.
    const rows = Array.from({ length: 30 }, (_, i) => row({
      id: `t${i}`, num: `1.${String(i + 1).padStart(2, "0")}`,
      title: i % 10 === 3 ? `Needle ${i}` : `Haystack ${i}`, difficulty: i % 2 ? "hard" : "easy",
    }));
    await openAnalytics(page, rows, { type: "competition", competition_name: "Scoped" });
    await setScope(page, "competition");
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(25);
    // PRECONDITION: Difficulty is hidden under Columns by default.
    await expect(page.locator("#analytics-table thead th[data-sort='difficulty']")).toBeHidden();

    await page.locator("#analytics-table thead th[data-sort='title'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("Needle", { delay: 20 });
    // Needle 3, 13 and 23: the last is on the second page of the unfiltered table.
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(3, { timeout: 5000 });
    await expect(page.locator("#analytics-table-meta")).toHaveText("3 of 30 challenges match");
    await expect(page.locator(".tcol-bar[data-tcols-for='analytics'] .tcol-note")).toHaveText("Filtered by Title");
    await page.keyboard.press("Escape");

    const { rows: csv } = await exportCsv(page);
    expect(csv[0], "every column, hidden ones included").toEqual([
      "Challenge ID", "Title", "Difficulty", "Tags", "Total Activity",
      "Solved", "Incorrect", "Hints Revealed", "Navigated Away",
      "Unique Attempters", "Solve Rate (%)",
    ]);
    expect(csv.slice(1).map((r) => r[1]), "the file matches the screen").toEqual(["Needle 3", "Needle 13", "Needle 23"]);
    expect(csv.slice(1).map((r) => r[2]), "a column hidden on screen is still written").toEqual(["hard", "hard", "hard"]);

    // POSITIVE CONTROL: cleared, the whole table goes back into the file.
    await page.locator(".tcol-bar[data-tcols-for='analytics'] .tcol-clear").click();
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(25, { timeout: 5000 });
    const { rows: all } = await exportCsv(page);
    expect(all.length - 1).toBe(30);
  });

  test("a challenge title that is a spreadsheet formula is neutralised", async ({ page }) => {
    // Quoting alone does NOT stop Excel evaluating a cell — the quotes are the
    // delimiter and are stripped before type inference. Titles are
    // admin-authored and can arrive through an import, and this download had no
    // shipped bytes to preserve, so it starts out guarded (unlike the
    // participants CSV, whose bytes are deliberately unchanged).
    await adminPage(page);
    await openAnalytics(page, [
      row({ id: "f1", num: "1.01", title: '=HYPERLINK("http://evil.example","x")' }),
      row({ id: "p1", num: "1.02", title: "Ordinary challenge" }),
    ], { type: "competition", competition_name: "Formula" });
    await setScope(page, "competition");

    const { rows: csv } = await exportCsv(page);
    expect(csv[1][1]).toBe(`'=HYPERLINK("http://evil.example","x")`);
    // POSITIVE CONTROL: a writer that apostrophised EVERY cell would satisfy
    // the assertion above.
    expect(csv[2][1]).toBe("Ordinary challenge");
    expect(csv[2][1].startsWith("'")).toBe(false);
  });

  test("the file carries a UTF-8 BOM, so Excel does not mangle a non-ASCII title", async ({ page }) => {
    await adminPage(page);
    // `num: null` mirrors the real endpoint: task_number is populated only when
    // scope is competition or timeslot, so a global-scope fixture that carried
    // one would be testing a payload the server never sends.
    await openAnalytics(page, [row({ id: "u1", num: null, title: "Übung — naïve café" })],
      { type: "global" });

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      page.locator("#analytics-export-csv-btn").click(),
    ]);
    const text = fs.readFileSync(await download.path(), "utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("Übung — naïve café");
    // Global scope has no competition to name, and no numbers to carry.
    expect(download.suggestedFilename()).toMatch(/^analytics-global-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(parseCsv(text)[1][0], "task_number is null outside a competition scope").toBe("");
  });

  test("a competition whose name has no ASCII letters is not filed as 'global'", async ({ page }) => {
    // The slug strips everything outside [a-z0-9], so a name written entirely in
    // Hebrew, CJK or Cyrillic reduces to the empty string. Falling back to the
    // same 'global' token the no-competition case uses would hand the admin a
    // file called analytics-global-… for a competition-scoped export — a
    // filename asserting the opposite of what is inside it.
    await adminPage(page);
    await openAnalytics(page, [row({ id: "he1", num: "1.01", title: "Challenge" })],
      { type: "competition", competition_id: "c9", competition_name: "תחרות הפיתוח" });
    await setScope(page, "competition");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      page.locator("#analytics-export-csv-btn").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^analytics-event-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(download.suggestedFilename(), "it must not claim to be the global export")
      .not.toContain("global");
  });

  test("switching to a scope with no data does not export the PREVIOUS scope's rows", async ({ page }) => {
    // The sharpest failure this button can have. `lastResponse` is the cached
    // payload the export reads; an empty or failed render used to leave it in
    // place, so an admin who moved to a competition with no activity saw an
    // empty table and downloaded the previous competition's rows — under a
    // filename naming the new one. Wrong data, wrong label, no error.
    await adminPage(page);
    await openAnalytics(page, [
      row({ id: "old1", num: "1.01", title: "Secret Alpha", solved: 5, attempters: 5 }),
      row({ id: "old2", num: "1.02", title: "Secret Beta", solved: 3, attempters: 4 }),
    ], { type: "competition", competition_id: "c1", competition_name: "First Comp" });
    await setScope(page, "competition");

    // POSITIVE CONTROL: the export works right now, so a later "no download"
    // cannot be satisfied by a button that never worked.
    const { rows: before } = await exportCsv(page);
    expect(before.length - 1).toBe(2);

    // Now land the empty state the way the app does — the render path every
    // failed or scope-incomplete fetch goes through.
    await page.evaluate(() => { window._renderAnalyticsEmpty("Pick a competition to see its analytics."); });

    let downloaded = false;
    page.on("download", () => { downloaded = true; });

    // v8.1.0 — TWO halves, because PR 21 made the guarantee stronger and the old
    // single assertion can no longer be reached. The empty render now hides
    // #analytics-table-card, and the export BUTTON lives inside it, so the
    // affordance is gone rather than present-and-refusing. That is the better
    // outcome — but "the button is hidden" on its own is a weaker claim than the
    // one this test was written for, because a hidden button can still sit in
    // front of a live payload. So assert both: the affordance is gone, AND the
    // guard behind it still refuses when driven directly.
    await expect(page.locator("#analytics-export-csv-btn"),
      "an empty view offers no export affordance at all").toBeHidden();
    await page.evaluate(() => { window.exportAnalyticsCsv(); });
    await expect(page.locator(".toast").last()).toContainText(/has not loaded/i, { timeout: 8000 });
    expect(downloaded, "the previous scope's rows must not be downloadable from an empty view").toBe(false);
  });

  test("with nothing to export it says so instead of saving an empty file", async ({ page }) => {
    // An empty CSV is indistinguishable from "there is genuinely no activity",
    // and the admin would take it as an answer.
    await adminPage(page);
    await openAnalytics(page, [row({ id: "z1", num: "1.01", title: "Only one" })]);

    await page.locator("#analytics-search").fill("zzz-no-such-challenge");
    await expect(page.locator("#analytics-table-body")).toContainText(/No challenges match/i);

    let downloaded = false;
    page.on("download", () => { downloaded = true; });
    await page.locator("#analytics-export-csv-btn").click();
    await expect(page.locator(".toast").last()).toContainText(/nothing to export/i, { timeout: 8000 });
    expect(downloaded, "no file may be saved when there is nothing in it").toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v7.27.0 — the "Unique Attempters" column
// ═══════════════════════════════════════════════════════════════════════════
//
// The table showed a solve RATE with no denominator. "43%" of 7 attempters is a
// different claim from 43% of 70, and only the CSV carried the number — so the
// screen an admin actually reads could not be checked against it.
//
// It sits SECOND TO LAST, immediately before the rate it divides by, which is
// also where the CSV puts it. The CSV carries every column; the screen shows a
// default set (six are hidden under Columns), in the same order.
//
// ORDER_ROWS is what makes these assertions non-vacuous. Its attempter counts
// (10 / 9 / 8 / 5 / 6) are all distinct AND yield an ordering that differs from
// every other numeric column — attempters ascending is Bravo, Echo, Charlie,
// Alpha, Delta, whereas `solved` gives Delta, Charlie, Echo, Bravo, Alpha and
// solve_rate gives Delta, Charlie, Echo, Bravo, Alpha. A cell read from the
// wrong column, or a sort keyed on the wrong field, therefore cannot pass.
test.describe("v7.27.0 — Unique Attempters is a table column", () => {
  const attemptersOnScreen = (page) =>
    page.locator("#analytics-table-body tr td:nth-last-child(2)").allInnerTexts();

  test("it is the second-to-last header, right before Solve rate", async ({ page }) => {
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);
    // The header cells are upper-cased by CSS, and allInnerTexts() returns what
    // is RENDERED — so compare case-insensitively rather than pinning the
    // stylesheet's text-transform into an unrelated assertion.
    const heads = (await page.locator("#analytics-table thead th").allInnerTexts()).map(s => s.toLowerCase());
    expect(heads.slice(-2), "denominator immediately before the ratio").toEqual(["unique attempters", "solve rate"]);
    expect(await page.locator('#analytics-table thead th[data-sort="unique_attempters"]').count(),
      "and it is sortable, like every other numeric column").toBe(1);
  });

  test("the cell carries the attempter count, not a neighbouring column", async ({ page }) => {
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);
    // Global default order is by title: Alpha, Bravo, Charlie, Delta, Echo.
    expect(await titlesOnScreen(page)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    expect(await attemptersOnScreen(page)).toEqual(["9", "5", "8", "10", "6"]);
    // The rate is still in the LAST cell — i.e. the new column was inserted,
    // not swapped over the top of one.
    expect(await page.locator("#analytics-table-body tr td:last-child").allInnerTexts())
      .toEqual(["100%", "80%", "25%", "10%", "50%"]);
  });

  test("sorting by it works in BOTH directions", async ({ page }) => {
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);
    const th = page.locator('#analytics-table thead th[data-sort="unique_attempters"]');

    // A numeric column opens DESCENDING — the established convention for this
    // table (main.js: only `title` and `task_number` open ascending), and the
    // right one for a count: "which challenge did most people try" is the
    // question a click on it is asking.
    await th.click();
    expect(await titlesOnScreen(page), "descending by attempters on the first click")
      .toEqual(["Delta", "Alpha", "Charlie", "Echo", "Bravo"]);
    expect(await th.getAttribute("aria-sort")).toBe("descending");

    await th.click();
    expect(await titlesOnScreen(page), "ascending on the second")
      .toEqual(["Bravo", "Echo", "Charlie", "Alpha", "Delta"]);
    expect(await th.getAttribute("aria-sort")).toBe("ascending");
  });

  test("a zero-attempter challenge reads 0, and its solve rate still reads —", async ({ page }) => {
    // Zero is a real answer for a challenge nobody opened; the RATE is not
    // (0/0 is undefined, which is why that cell has always shown an em dash).
    // The two cells must therefore disagree, and this is the row that proves it.
    await adminPage(page);
    await openAnalytics(page, [row({ id: "z0", num: "1.01", title: "Untouched", attempters: 0 })]);
    expect(await attemptersOnScreen(page)).toEqual(["0"]);
    expect(await page.locator("#analytics-table-body tr td:last-child").allInnerTexts()).toEqual(["—"]);
  });

  test("the empty-state row still spans the whole table", async ({ page }) => {
    // The colspan is derived from the real <thead> (v7.20.9 / ext-audit F12), so
    // this is the assertion that proves the derivation actually tracked the new
    // column rather than being a hard-coded number that happens to look right.
    await adminPage(page);
    await openAnalytics(page, ORDER_ROWS);
    const cols = await page.locator("#analytics-table thead th").count();
    await page.locator("#analytics-search").fill("zzz-no-such-challenge");
    await expect(page.locator("#analytics-table-body")).toContainText(/No challenges match/i);
    expect(await page.locator("#analytics-table-body tr td").first().getAttribute("colspan")).toBe(String(cols));
  });
});

// A QUALIFYING challenge (a `qualifying:<key>` tag) is left out of every
// Analytics answer by the server, so neither its tag nor the challenge itself
// may be offered as a filter: choosing one could only return "no activity" for
// a question everyone answered (accept-and-ignore is worse than no control).
test.describe("qualifying challenges are not offered as Analytics filters", () => {
  test("no qualifying tag among the challenge-tag chips, and no qualifying challenge in the picker", async ({ page }) => {
    const stamp = `anq${Date.now().toString(36)}`;
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const mk = async (title, tags) => {
        // A qualifying question is a pick-one question (lib/qualifying.js).
        const kind = tags.some(t => t.startsWith("qualifying:"))
          ? { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] }
          : { answer_type: "text", correct_answer: "x" };
        const r = await api.post("/api/admin/tasks", { headers: GUH(csrf), data: {
          title, description: "<p>d</p>", difficulty: "easy", ...kind, status: "published" } });
        expect(r.ok(), `create ${title}: ${await r.text()}`).toBeTruthy();
        const id = (await r.json()).id;
        for (const tag of tags) {
          const t = await api.post(`/api/admin/tasks/${id}/tags`, { headers: GUH(csrf), data: { tag } });
          expect(t.ok(), `tag ${tag}: ${await t.text()}`).toBeTruthy();
        }
        return id;
      };
      await mk(`${stamp} qualifying question`, [`qualifying:${stamp}`, `${stamp}-shared`]);
      await mk(`${stamp} ordinary challenge`, [`${stamp}-shared`, `${stamp}-plain`]);
      const lib = await (await api.get("/api/admin/tasks")).json();
      const listed = (Array.isArray(lib) ? lib : lib.tasks || []).find((t) => t.title === `${stamp} qualifying question`);
      expect(listed && listed.tags, "PRECONDITION: the library sends the qualifying challenge and its tag").toContain(`qualifying:${stamp}`);
    } finally { await api.dispose(); }

    await adminPage(page);
    await openAnalytics(page, [row({ id: "x1", num: null, title: "Anything" })], { type: "global" });

    // The challenge-tag chips (shown under "Only").
    await page.locator('[data-action="analytics-challenge-tag-mode"][data-value="include"]').click();
    const chips = await page.locator('[data-action="analytics-challenge-tag-toggle"]').evaluateAll((bs) => bs.map((b) => b.dataset.value));
    expect(chips, "an ordinary tag is offered").toEqual(expect.arrayContaining([`${stamp}-shared`, `${stamp}-plain`]));
    expect(chips.filter((t) => t.toLowerCase().startsWith("qualifying:")), "no qualifying tag is offered").toEqual([]);

    // The challenge picker.
    await page.locator('[data-action="analytics-open-task-picker"]').click();
    const picker = page.locator("#analytics-picker-overlay");
    await expect(picker).toBeVisible();
    await expect(picker, "an ordinary challenge is offered").toContainText(`${stamp} ordinary challenge`);
    await expect(picker, "a qualifying challenge is not").not.toContainText(`${stamp} qualifying question`);
  });
});
