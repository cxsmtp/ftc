// @ts-check
//
// v8.11.0 — THE PRESENTER'S VIEW ON THE ADMIN RANKINGS BOARD.
//
// A toggle in the Rankings controls row leaves the participant's COMPANY and
// EMAIL off the board, for an organiser projecting the standings, sharing a
// screen or handing a laptop round the room.
//
// WHAT MAKES THIS MORE THAN TWO `display:none` RULES, and why every arm below
// exists:
//   * The values must leave the DOM, not be painted over. A hidden cell is still
//     in the markup, still found by the browser's own Find, still copied by
//     select-all — so a control promising the columns are not shown would be one
//     that only looks like it works. Arm 1 asserts BY VALUE across the whole
//     table, so a leak arriving under a renamed cell still fails.
//   * The table has to stay rectangular. Nine colspans, three row shapes (the
//     regular rows, the late-entrant block, the benchmark block) and four
//     separate `<thead>`s read the column count; a literal left behind anywhere
//     is a visibly ragged board. Arm 2 counts cells against the header.
//   * The SEARCH has to follow it, which is the reason this cannot be CSS: a box
//     that still matched an employer nobody can see returns rows for a reason the
//     admin cannot explain.
//   * A board sorted by a column that has just been hidden must not stay in that
//     order — the header it would have to click to undo it is gone.
//   * Entering the tab with the toggle ALREADY ON must not paint the nine-column
//     static fallback header over seven-cell rows.
//
// AND THE DELIBERATE NON-CHANGE: the CSV export still carries every column
// (v8.1.7's rule — the header is the contract with the human reading the file,
// and a shape that varies by circumstance breaks any reader indexing by column).
// The toggle's own note says so; arm 6 is what stops that quietly changing.
//
// The board is INTERCEPTED rather than seeded. Every assertion here is about
// client-side rendering over a payload, the payload is the honest input, and
// fixing the company and email strings is what lets arm 1 search for them by
// value. One arm drives the REAL server end to end so the wire is not taken on
// trust.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, clickTab, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const fs = require("fs");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Distinctive enough that a by-value search over the rendered table cannot match
// them by accident, and distinct from the nickname/first/last so the arms can
// tell "the company is gone" from "the whole row is gone".
const CO = "Zyxwv Holdings QQ";
const MAIL = "qqq.presenter@zyxwv-holdings.example";

function boardPayload() {
  const row = (i, extra = {}) => ({
    userId: `u${i}`, rank: i, nickname: `pvnick${i}`, avatar: "default1",
    firstName: `Pvfirst${i}`, lastName: `Pvlast${i}`,
    company: i === 1 ? CO : `Other Co ${i}`,
    email: i === 1 ? MAIL : `other${i}@elsewhere.example`,
    score: 100 - i, solveTimeMs: 60_000 + i * 1000, allSolved: i === 1,
    incorrectCount: 0, pointsLostIncorrect: 0, hintCount: 0, pointsLostHints: 0,
    pointsLostTotal: 0, presenceMs: null,
    ...extra,
  });
  return [
    row(1), row(2), row(3),
    // The two pinned sections, so arm 2 measures the row shapes that do NOT go
    // through the ordinary branch — each has its own literal `<tr>` in the
    // renderer and its own divider colspan.
    row(4, { isLateEntrant: true, rank: 1 }),
    row(5, { isBenchmark: true, rank: null }),
  ];
}

let compId = null, compName = null;

test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    compName = `Presenter View ${uniq()}`;
    const r = await sa.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: compName, start_time: new Date(Date.now() - 60_000).toISOString(),
              duration_minutes: 240, timezone: "UTC" },
    });
    expect(r.ok(), `competition: ${r.status()} ${await r.text()}`).toBeTruthy();
    compId = (await r.json()).competition.id;
  } finally { await sa.dispose(); }
});

test.afterAll(async () => {
  if (!compId) return;
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) }).catch(() => {});
    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  } finally { await sa.dispose(); }
});

/** Focus the fixture competition, land on Rankings with the intercepted board. */
async function openRankings(page, { intercept = true } = {}) {
  if (intercept) {
    await page.route("**/api/admin/leaderboard*", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      // The group board asks with `groups=1`; it has no identity columns and is
      // deliberately untouched by this feature, so it stays empty here.
      body: JSON.stringify(route.request().url().includes("groups=1") ? [] : boardPayload()),
    }));
  }
  await adminLogin(page);
  await focusRankings(page);
}

/**
 * Focus the fixture competition and land on Rankings — WITHOUT signing in again.
 *
 * Separate because the scope lives in memory: a reload drops it and Rankings
 * comes back on the event picker, with no board and no header to assert against.
 */
async function focusRankings(page) {
  await clickTab(page, "Events");
  await expect.poll(
    () => page.evaluate((id) => (window.S.adminCompetitionsData || []).some(c => c.id === id), compId),
    { timeout: 20_000, intervals: [100, 200, 400, 800] },
  ).toBe(true);
  // Open the event's workspace, as the Events list's Open does.
  await page.evaluate(({ id, name }) => window.openEventWorkspace(id, name), { id: compId, name: compName });
  await page.locator("#admin-workspace:not([hidden])").waitFor({ state: "attached", timeout: 10_000 });
  await clickTab(page, "Rankings");
  await expect(page.locator("#admin-rankings-body tr").first()).toBeVisible({ timeout: 20_000 });
}

const TOGGLE = "#rankings-hide-identity";
const HEADERS = () => "#admin-rankings-tab table thead th";

/** Wait for the board to settle into the mode the checkbox is in. */
async function expectMode(page, hidden) {
  await expect(page.locator(`${HEADERS()}[data-col='company']`)).toHaveCount(hidden ? 0 : 1, { timeout: 10_000 });
  await expect(page.locator(`${HEADERS()}[data-col='email']`)).toHaveCount(hidden ? 0 : 1);
}

test.describe("v8.11.0 — the rankings presenter's view", () => {

  test("the two columns and their VALUES leave the board, and nothing else does", async ({ page }) => {
    await openRankings(page);

    // PRECONDITION — without it every assertion below is vacuous: a build that
    // never rendered company or email passes the whole test.
    await expectMode(page, false);
    let table = await page.locator("#admin-rankings-tab .rankings-table-card").innerHTML();
    expect(table, "the fixture really puts the company on the board").toContain(CO);
    expect(table, "…and the email").toContain(MAIL);

    await page.locator(TOGGLE).check();
    await expectMode(page, true);

    table = await page.locator("#admin-rankings-tab .rankings-table-card").innerHTML();
    // BY VALUE over the whole card, so a value that survived under a renamed
    // cell, a title attribute or a copy button's data-copy still fails. The copy
    // buttons are exactly why: they carry the value in an ATTRIBUTE, so a
    // renderer that dropped the cell and kept the button would pass a
    // text-content check.
    expect(table, "the company must not be anywhere in the rendered board").not.toContain(CO);
    expect(table, "nor the email").not.toContain(MAIL);

    // CONTROL — the board is still standings. Names and nicknames stay, which is
    // what the request asked for and what stops "the columns are gone" being
    // satisfied by a build that renders no identity at all.
    expect(table).toContain("Pvfirst1");
    expect(table).toContain("Pvlast1");
    expect(table).toContain("pvnick1");
    await expect(page.locator(`${HEADERS()}[data-col='first']`)).toHaveCount(1);
    await expect(page.locator(`${HEADERS()}[data-col='last']`)).toHaveCount(1);

    // And back: the toggle is a view, not a deletion.
    await page.locator(TOGGLE).uncheck();
    await expectMode(page, false);
    expect(await page.locator("#admin-rankings-tab .rankings-table-card").innerHTML()).toContain(MAIL);
  });

  test("the table stays rectangular in both modes, including the pinned sections", async ({ page }) => {
    await openRankings(page);

    const shape = () => page.evaluate(() => {
      const card = document.querySelector("#admin-rankings-tab .rankings-table-card");
      const cols = card.querySelectorAll("thead th").length;
      const bad = [];
      for (const tr of card.querySelectorAll("tbody tr")) {
        const cells = [...tr.children];
        // A divider / empty-state / "show all" row is one cell spanning the table.
        const span = cells.length === 1 ? Number(cells[0].getAttribute("colspan") || 1) : null;
        if (span !== null) { if (span !== cols) bad.push(`colspan ${span} != ${cols} on "${tr.className}"`); }
        else if (cells.length !== cols) bad.push(`${cells.length} cells != ${cols} on "${tr.className}"`);
      }
      return { cols, bad, rows: card.querySelectorAll("tbody tr").length };
    });

    let s = await shape();
    expect(s.cols, "the full board is nine columns").toBe(9);
    // The fixture really renders all three row shapes plus their two dividers.
    expect(s.rows, "regular + late divider + late + benchmark divider + benchmark").toBe(7);
    expect(s.bad, `full view is ragged: ${s.bad.join("; ")}`).toEqual([]);

    await page.locator(TOGGLE).check();
    await expectMode(page, true);
    s = await shape();
    expect(s.cols, "two columns fewer").toBe(7);
    expect(s.rows, "the same rows — only the columns went").toBe(7);
    expect(s.bad, `presenter view is ragged: ${s.bad.join("; ")}`).toEqual([]);
  });

  test("the search follows the view — a hidden column stops being searchable", async ({ page }) => {
    await openRankings(page);
    const box = page.locator("#rankings-search");
    const count = page.locator("#rankings-search-count");

    // CONTROL FIRST: with the columns shown, the company IS searchable.
    await box.fill("Zyxwv");
    await expect(count).toContainText("1 of 5", { timeout: 10_000 });
    await expect(page.locator("#admin-rankings-body tr")).toHaveCount(1);

    await page.locator(TOGGLE).check();
    await expectMode(page, true);
    // The same term now matches nobody — and the board SAYS so rather than
    // rendering an empty tbody under a populated header (v7.16.7).
    await expect(count).toContainText("No participants match", { timeout: 10_000 });
    // The BOARD says so too, naming the term — an empty tbody under a populated
    // header is the v7.16.7 wrong answer.
    await expect(page.locator("#admin-rankings-body")).toContainText("No participants match zyxwv.");

    // CONTROL: a term that matches a column still on screen is unaffected, so
    // "the search found nothing" is not satisfied by a build that broke search.
    await box.fill("pvnick1");
    await expect(count).toContainText("1 of 5", { timeout: 10_000 });

    // And the box stops claiming to search two fields it no longer does.
    await expect(box).toHaveAttribute("aria-label", "Search rankings by nickname or name");
    await page.locator(TOGGLE).uncheck();
    await expect(box).toHaveAttribute("aria-label", /company or email/);
  });

  test("a board sorted by a column that is being hidden falls back to the default order", async ({ page }) => {
    await openRankings(page);

    const nicks = () => page.evaluate(() =>
      [...document.querySelectorAll("#admin-rankings-body .rk-player-link")].map(b => b.textContent.trim()));

    await page.locator(`${HEADERS()}[data-col='company']`).click();
    await expect(page.locator(`${HEADERS()}[data-col='company']`)).toHaveAttribute("aria-sort", "ascending");
    const sorted = await nicks();

    await page.locator(TOGGLE).check();
    await expectMode(page, true);
    // Back in rank order, and no header left claiming a sort.
    expect(await nicks()).toEqual(["pvnick1", "pvnick2", "pvnick3", "pvnick4", "pvnick5"]);
    expect(await page.locator(`${HEADERS()}[aria-sort='ascending'], ${HEADERS()}[aria-sort='descending']`).count(),
      "no column is still marked as the sort").toBe(0);
    // ANTI-VACUITY: the company sort really did produce a DIFFERENT order, or
    // "it fell back to rank order" is true of a build that never sorted at all.
    expect(sorted, "the company sort must actually reorder the fixture")
      .not.toEqual(["pvnick1", "pvnick2", "pvnick3", "pvnick4", "pvnick5"]);

    // CONTROL — a sort by a column that is STILL on screen survives the toggle.
    await page.locator(TOGGLE).uncheck();
    await expectMode(page, false);
    await page.locator(`${HEADERS()}[data-col='score']`).click();
    await expect(page.locator(`${HEADERS()}[data-col='score']`)).toHaveAttribute("aria-sort", "ascending");
    await page.locator(TOGGLE).check();
    await expectMode(page, true);
    await expect(page.locator(`${HEADERS()}[data-col='score']`), "a visible column's sort is untouched")
      .toHaveAttribute("aria-sort", "ascending");
  });

  test("entering the tab with the toggle already on paints a header that fits the rows", async ({ page }) => {
    await openRankings(page);
    await page.locator(TOGGLE).check();
    await expectMode(page, true);

    // Leave and come back. index.html supplies #admin-rankings-body, so the
    // focused loader's rebuild is SKIPPED unless it notices the header is stale —
    // which is the whole of this arm: pre-fix this is a nine-cell header over
    // seven-cell rows. Another SECTION of the event's workspace, not the Events
    // page: the sidebar's Events closes the workspace and its scope with it.
    await clickTab(page, "Participants");
    await clickTab(page, "Rankings");
    await expect(page.locator("#admin-rankings-body tr").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(TOGGLE), "the toggle survived the tab switch").toBeChecked();

    const s = await page.evaluate(() => {
      const card = document.querySelector("#admin-rankings-tab .rankings-table-card");
      const cols = card.querySelectorAll("thead th").length;
      const first = card.querySelector("tbody tr");
      return { cols, cells: first ? first.children.length : -1 };
    });
    expect(s.cols, "the header follows the mode").toBe(7);
    expect(s.cells, "and the rows fit it").toBe(7);
  });

  test("the CSV export still carries every column — the toggle is a view, not a redaction", async ({ page }) => {
    await openRankings(page);
    await page.locator(TOGGLE).check();
    await expectMode(page, true);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000 }),
      page.locator(".rk-export-btn[data-board-key='main']").first().click(),
    ]);
    const text = fs.readFileSync(await download.path(), "utf8");
    const header = (text.split("\n")[0] || "").replace(/^﻿/, "");
    // v8.1.7's rule: the header is the contract with the human reading the file,
    // and a shape that varies by circumstance breaks a reader indexing by column.
    expect(header, "Company stays in the file").toContain("Company");
    expect(header, "…and Email").toContain("Email");
    // And the VALUES are really there, not just the headings.
    // …and the note beside the toggle says so, or the file is a surprise.
    const note = await page.locator("#rankings-hide-identity-note").innerText();
    expect(note.toLowerCase(), "the toggle states the export's behaviour").toContain("csv export");
    expect(text, "the file carries what the screen is hiding — the note says so").toContain(CO);
    expect(text).toContain(MAIL);
  });

  test("it does not persist — a reload comes back to the full board", async ({ page }) => {
    await openRankings(page);
    await page.locator(TOGGLE).check();
    await expectMode(page, true);

    await page.reload();
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    // The checkbox is static markup, so this is assertable before any board is
    // on screen — and it is the half a browser would otherwise get wrong on its
    // own, by restoring the control's state across the reload.
    await expect(page.locator(TOGGLE), "the control comes back off").not.toBeChecked();
    // The scope is in memory too, so Rankings reloads onto the event picker;
    // focus it again to see the board the mode actually produces.
    await focusRankings(page);
    // A stored preference would mean opening Rankings next week to two missing
    // columns and no memory of asking — which reads as a broken feature and gets
    // reported as one (v7.14.2). Stated here so a later "improvement" is a
    // decision rather than a drift.
    await expect(page.locator(TOGGLE)).not.toBeChecked();
    await expectMode(page, false);
  });

  test("the REAL board honours it too, and the presenter's view is accessible", async ({ page }) => {
    // No interception: the wire shape is not taken on trust, and the toggle has
    // to work over an empty board as well as a populated one.
    await openRankings(page, { intercept: false });
    await page.locator(TOGGLE).check();
    await expectMode(page, true);

    // `heading-order` only, and for the reason the sibling scan in
    // ui-admin-competitions.spec.js gives: the focused view renders
    // #admin-rankings-title as an <h3> with no <h2> above it, which this change
    // neither introduced nor moved. Suppressing exactly that keeps the gate
    // meaningful for what the toggle DID touch — the checkbox's label
    // association, its describedby note and the header semantics — instead of
    // being permanently red for an unrelated finding.
    const scan = await new AxeBuilder({ page }).include("#admin-rankings-tab").disableRules(["heading-order"]).analyze();
    const bad = scan.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact));
    expect(bad.map(v => `${v.id} (${v.impact}) x${v.nodes.length}`), "presenter view a11y").toEqual([]);
  });
});
