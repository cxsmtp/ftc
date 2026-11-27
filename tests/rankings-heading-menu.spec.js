// @ts-check
//
// THE RANKINGS BOARDS' HEADING MENUS (public/js/features/rankings-admin.js over
// public/js/ui/table-columns.js).
//
//  1. SORT ON A REBUILT BOARD. The group board (like the all-live and
//     per-session cards) rebuilds its <thead> on every sort, so a menu that
//     toggled the heading twice reached the second click on a detached heading:
//     Sort descending gave ascending, later presses did nothing, and focus left
//     the menu. The menu now SETS the order, every press, and focus stays in it;
//     the rebuilt heading's button is the menu's opener (aria-expanded "true").
//  2. A FILTER REACHES THE WHOLE BOARD, not the 50 rows on screen, and says no
//     false total: one shared bar above several boards names the filter, the
//     count beside the search box sums every board.
//  3. THE FILE FOLLOWS THE FILTER: Export CSV writes the rows the heading
//     filter left, and the presenter's view drops a filter on a column it hides.
//
// The boards are served from intercepted payloads (the documented pattern of
// tests/rankings-csv-export.spec.js): what is under test is client rendering
// over the payload, and a 120-row board would take minutes to seed.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const crypto = require("crypto");
const fs = require("fs");

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

const wireRow = (o) => ({
  userId: o.id, nickname: o.nick, avatar: "default1",
  score: o.score ?? 0, finishTime: null, solveTimeMs: o.ms ?? 1000,
  allSolved: !!o.allSolved, rank: o.rank ?? null,
  firstName: o.first ?? "F", lastName: o.last ?? "L",
  company: o.company ?? "Co", email: o.email ?? `${o.nick}@x.test`,
  incorrectCount: 0, pointsLostIncorrect: 0, hintCount: 0, pointsLostHints: 0, pointsLostTotal: 0,
});
const groupRow = (name, rank, score) => ({
  type: "group", groupId: `g-${name}`, name, memberCount: 2, score, solveTimeMs: 60_000, allSolved: false, rank,
  incorrectCount: 0, pointsLostIncorrect: 0, hintCount: 0, pointsLostHints: 0, pointsLostTotal: 0,
});

async function mkLiveEvent(prefix) {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const name = `${prefix} ${uniq()}`;
    const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240 } });
    expect(r.status(), await r.text()).toBe(200);
    return { id: (await r.json()).competition.id, name };
  } finally { await api.dispose(); }
}

/** Serve fixed boards for one live event and open its Rankings. */
async function openMocked(page, { board, groupBoard = [] }) {
  const ev = await mkLiveEvent("RkMenu");
  await page.route("**/api/admin/leaderboard*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify(route.request().url().includes("groups=1") ? groupBoard : board),
  }));
  await adminLogin(page);
  await clickTab(page, "Events");
  await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), ev.id),
    { timeout: 20000 }).toBe(true);
  await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), ev);
  await clickTab(page, "Rankings");
  await expect(page.locator("#admin-rankings-body tr").first()).toBeVisible({ timeout: 20000 });
  return ev;
}

/** Parse a CSV whose every field is quoted (ui/csv.js). */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQ) { if (ch === '"') { if (body[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows[0] || [];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
async function exportMain(page) {
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.locator('.rk-export-btn[data-board-key="main"]').first().click(),
  ]);
  return parseCsv(fs.readFileSync(await dl.path(), "utf8"));
}

const mainRows = (page) => page.locator("#admin-rankings-body tr");
const note = (page) => page.locator(".tcol-bar[data-tcols-for='rankings'] .tcol-note");
async function filterColumn(page, sel, col, text) {
  await page.locator(`${sel} th[data-col='${col}'] .tcol-hbtn`).first().click();
  const pop = page.locator(".tcol-pop[role='dialog']");
  await expect(pop).toBeVisible();
  await pop.locator("input[data-tcol-input]").pressSequentially(text, { delay: 20 });
  return pop;
}

test.describe("rankings heading menus: set the order, reach every row, and the file follows", () => {
  test("the group board's menu sets the order asked for on every press, and keeps focus in the menu", async ({ page }) => {
    await openMocked(page, {
      board: [wireRow({ id: "x", nick: "solo", rank: 1, score: 1 })],
      groupBoard: [groupRow("Alpha Team", 1, 10), groupRow("Bravo Team", 2, 30), groupRow("Charlie Team", 3, 20)],
    });
    const sec = page.locator("#admin-rankings-group-section");
    await expect(sec.locator("table[data-tcols='rankings-group']")).toBeVisible({ timeout: 20000 });
    const names = () => sec.locator("tbody tr .rk-player-link").allTextContents().then((t) => t.map((s) => s.trim()));
    const scoreTh = () => sec.locator("th[data-col='score']");
    expect(await names(), "PRECONDITION: the board's own order").toEqual(["Alpha Team", "Bravo Team", "Charlie Team"]);

    const scoreBtn = () => scoreTh().locator(".tcol-hbtn");
    await scoreBtn().click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    await expect(scoreBtn(), "the opener says its menu is open").toHaveAttribute("aria-expanded", "true");
    // Mark the opener, to tell it from the button a rebuilt heading gets.
    await scoreBtn().evaluate((b) => { b.dataset.probe = "opener"; });
    await pop.locator("[data-tcol-sort='desc']").click();
    await expect.poll(names, { timeout: 5000, message: "Sort descending sorts descending" }).toEqual(["Bravo Team", "Charlie Team", "Alpha Team"]);
    await expect(scoreTh()).toHaveAttribute("aria-sort", "descending");
    expect(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest(".tcol-pop"))),
      "focus stays in the menu that was pressed").toBe(true);
    // The heading was rebuilt under the open menu: its new button is the menu's
    // opener now, and says so, as the one it replaced did.
    await expect(scoreBtn(), "PRECONDITION: the Score heading was rebuilt").not.toHaveAttribute("data-probe", "opener");
    await expect(scoreBtn(), "the rebuilt heading's button reports its open menu").toHaveAttribute("aria-expanded", "true");
    await expect(sec.locator("th[data-col='player'] .tcol-hbtn"), "CONTROL: another heading's button is collapsed")
      .toHaveAttribute("aria-expanded", "false");

    // A later press, after the heading the menu came from was rebuilt.
    await pop.locator("[data-tcol-sort='asc']").click();
    await expect.poll(names, { timeout: 5000 }).toEqual(["Alpha Team", "Charlie Team", "Bravo Team"]);
    await expect(scoreTh()).toHaveAttribute("aria-sort", "ascending");
    await pop.locator("[data-tcol-sort='desc']").click();
    await expect.poll(names, { timeout: 5000 }).toEqual(["Bravo Team", "Charlie Team", "Alpha Team"]);

    // Escape still closes the menu, and focus returns to the rebuilt heading's button.
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    expect(await page.evaluate(() => {
      const a = document.activeElement;
      return !!(a && a.classList.contains("tcol-hbtn") && a.closest("th")?.dataset.col === "score" && a.closest("#admin-rankings-group-section"));
    }), "focus is back on the Score heading's button").toBe(true);
    await expect(scoreBtn(), "and it says the menu is closed").toHaveAttribute("aria-expanded", "false");

    // The group board's own filter narrows its rows, and its file with them.
    const exportGroup = async () => {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }),
        sec.locator('.rk-export-btn[data-board-key="group"]').click()]);
      return parseCsv(fs.readFileSync(await dl.path(), "utf8")).map((r) => r.Name);
    };
    expect(await exportGroup(), "CONTROL: unfiltered, the file has every group").toHaveLength(3);
    await filterColumn(page, "#admin-rankings-group-section", "player", "Charlie");
    await expect.poll(names, { timeout: 5000 }).toEqual(["Charlie Team"]);
    await page.keyboard.press("Escape");
    expect(await exportGroup(), "the file matches the filtered board").toEqual(["Charlie Team"]);
  });

  test("a heading filter reaches a row past the top 50, and the note claims no total", async ({ page }) => {
    const board = Array.from({ length: 120 }, (_, i) => wireRow({ id: `u${i}`, nick: `p${String(i).padStart(3, "0")}`, rank: i + 1, score: 1000 - i }));
    await openMocked(page, { board });
    await expect(page.locator("#admin-rankings-body tr.rankings-more-row"), "PRECONDITION: the board shows its top 50").toHaveCount(1);
    expect(await mainRows(page).count()).toBe(51);

    // Rank 101 is not among the 50 on screen; the filter must still find it.
    const pop = await filterColumn(page, "#admin-rankings-content", "player", "p100");
    await expect(mainRows(page)).toHaveCount(1, { timeout: 5000 });
    await expect(mainRows(page).first()).toContainText("p100");
    await expect(note(page), "the note names the filter and no count it cannot vouch for").toHaveText("Filtered by Player");
    await expect(page.locator("#rankings-search-count")).toHaveText("1 of 120 participants shown");

    // CONTROL: Clear brings the capped board back.
    await pop.locator("[data-tcol-fclear]").click();
    await expect.poll(() => mainRows(page).count(), { timeout: 5000 }).toBe(51);
    await expect(note(page)).toHaveText("");
  });

  test("Export CSV writes the rows a heading filter left, and the presenter's view drops a filter on a column it hides", async ({ page }) => {
    const board = [
      wireRow({ id: "a1", nick: "acme-one", rank: 1, score: 50, company: "Acme Ltd" }),
      wireRow({ id: "o1", nick: "other-one", rank: 2, score: 40, company: "Other Co" }),
      wireRow({ id: "a2", nick: "acme-two", rank: 3, score: 30, company: "Acme Ltd" }),
      wireRow({ id: "o2", nick: "other-two", rank: 4, score: 20, company: "Other Co" }),
      wireRow({ id: "a3", nick: "acme-three", rank: 5, score: 10, company: "Acme Ltd" }),
    ];
    await openMocked(page, { board });
    await expect(mainRows(page)).toHaveCount(5);
    const all = await exportMain(page);
    expect(all.map((r) => r.Nickname), "CONTROL: unfiltered, the file has every row").toEqual(board.map((u) => u.nickname));

    const pop = await filterColumn(page, "#admin-rankings-content", "company", "Acme");
    await expect(mainRows(page)).toHaveCount(3, { timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    const narrowed = await exportMain(page);
    expect(narrowed.map((r) => r.Nickname), "the file matches the filtered screen").toEqual(["acme-one", "acme-two", "acme-three"]);
    expect(narrowed.every((r) => r.Company === "Acme Ltd")).toBe(true);

    // The presenter's view hides Company: its filter goes with it.
    await page.locator("#rankings-hide-identity").check();
    await expect(page.locator("#admin-rankings-content th[data-col='company']")).toHaveCount(0);
    await expect.poll(() => mainRows(page).count(), { timeout: 5000, message: "no rows hidden by a column nobody can see" }).toBe(5);
    await expect(note(page)).toHaveText("");
  });

  test("on the all-live view one bar names the filter for every board, and the count sums them", async ({ page }) => {
    const A = await mkLiveEvent("RkLiveA");
    const B = await mkLiveEvent("RkLiveB");
    const boards = {
      [A.id]: [wireRow({ id: "a1", nick: "needle-a", rank: 1, score: 30 }), wireRow({ id: "a2", nick: "hay-a1", rank: 2, score: 20 }), wireRow({ id: "a3", nick: "hay-a2", rank: 3, score: 10 })],
      [B.id]: [wireRow({ id: "b1", nick: "hay-b1", rank: 1, score: 50 }), wireRow({ id: "b2", nick: "needle-b1", rank: 2, score: 40 }),
        wireRow({ id: "b3", nick: "hay-b2", rank: 3, score: 30 }), wireRow({ id: "b4", nick: "needle-b2", rank: 4, score: 20 }), wireRow({ id: "b5", nick: "hay-b3", rank: 5, score: 10 })],
    };
    await page.route("**/api/admin/leaderboard*", (route) => {
      const id = new URL(route.request().url()).searchParams.get("competitionId");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(boards[id] || []) });
    });
    await adminLogin(page);
    await clickTab(page, "Events");
    await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id)), [A.id, B.id]),
      { timeout: 20000 }).toBe(true);
    await clickTab(page, "Rankings");
    const card = (ev) => page.locator(".rankings-picker-card").filter({ hasText: ev.name });
    await expect(card(A).locator("tbody tr")).toHaveCount(3, { timeout: 20000 });
    await expect(card(B).locator("tbody tr")).toHaveCount(5);
    const nicks = (ev) => card(ev).locator("tbody .rk-player-link").allTextContents().then((t) => t.map((s) => s.trim()));

    await filterColumn(page, `.rankings-picker-card:has-text("${A.name}")`, "player", "needle");
    await expect.poll(() => nicks(A), { timeout: 5000 }).toEqual(["needle-a"]);
    expect(await nicks(B), "the one filter narrows every board").toEqual(["needle-b1", "needle-b2"]);
    await expect(page.locator(".tcol-bar[data-tcols-for='rankings']"), "one bar for the boards").toHaveCount(1);
    await expect(note(page), "no board's figures stand for all of them").toHaveText("Filtered by Player");
    await expect(page.locator("#rankings-search-count"), "the count sums every board").toHaveText("3 of 8 participants shown");
  });
});
