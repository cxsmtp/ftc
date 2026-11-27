// @ts-check
//
// PEOPLE: EXPORT CSV WRITES WHAT THE TABLE LISTS (operator ruling, 14 Nov 2026).
//
// The file used to be the whole loaded list whatever the screen showed: the
// search box, the status chips and the heading filters were ignored. Now it is
// the People table's own pipeline (participants-admin.js participantsInView):
// every page of the rows the table lists, in its order. Each arm builds a state
// in which the old file and the new one differ, and asserts by value:
//
//   * 32 rows match the search, so the table pages (30 + 2): the file holds all
//     32 and nobody else (a seeded participant the search leaves out is the
//     negative control);
//   * the status chip, the heading filter and the sort each narrow or reorder
//     the file exactly as they do the table (its first page, read off screen);
//   * a search that matches nobody saves no file and says so;
//   * inside an event workspace the file is the event's people, and everyone
//     the table lists once "Search everyone on the platform" is ticked; the
//     button names the event only while the file is the event's people;
//   * in an event nobody has joined, the empty answer says so (the table's own
//     reason), not that a search or filter matched nobody (CONTROL: a search
//     that matches nobody there is named as one);
//   * the command palette's Export people (CSV), opened from another page while
//     the People search still holds a term, opens People first and saves the
//     list it shows: a witness on the save records the People page on screen
//     with that term in its box, never a file narrowed by a filter off screen.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, clickTab, viewComp, openFilterPanels, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, makeCompetition, enrol } = require("./event-admin-helpers");
const { openPalette } = require("./chrome-helpers");

test.use({ baseURL: BASE });

const STAMP = `pcsv${Date.now().toString(36)}`;
const N = 32;                                   // more than one 30-row page
/** @type {{id:string,email:string,nickname:string,company:string}[]} */
let people = [];
let blocked = null;
let ev = null;
let evEmpty = null;                             // an event nobody has joined

/** A fully quoted CSV (ui/csv.js always quotes; BOM first) → array of objects. */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '"') { if (body[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]])));
}

/** Press the real Export ▾ → Export CSV and read the file it saves. */
async function exportCsv(page) {
  await page.locator("#p-export-menu-btn").click();
  const item = page.locator('#kebab-portal [data-action="export-participants-csv"]');
  await expect(item).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), item.click()]);
  expect(dl.suggestedFilename()).toBe("participants.csv");
  return parseCsv(fs.readFileSync(await dl.path(), "utf8"));
}

/** What the Export menu's two file doors say: {csv, json} (the menu is closed again). */
async function exportLabels(page) {
  await page.locator("#p-export-menu-btn").click();
  const csv = page.locator('#kebab-portal [data-action="export-participants-csv"]');
  await expect(csv).toBeVisible();
  const out = { csv: (await csv.innerText()).trim(), json: (await page.locator('#kebab-portal [data-action="export-participants"]').innerText()).trim() };
  await page.locator("#p-export-menu-btn").click();
  await expect(csv).toBeHidden();
  return out;
}

/** The nicknames on the table's current page, top to bottom (by row id). */
async function pageNicknames(page) {
  const ids = await page.locator("#admin-participants-body tr").evaluateAll((trs) => trs.map((tr) =>
    tr.querySelector('input[type="checkbox"][value]')?.value || tr.querySelector("[data-user-id]")?.getAttribute("data-user-id") || ""));
  const byId = new Map(people.map((p) => [p.id, p.nickname]));
  return ids.map((id) => byId.get(id) || `other:${id}`);
}

async function openPeople(page) {
  await openFilterPanels(page);
  await adminLogin(page);
  await clickTab(page, "Participants");
  await expect(page.locator("#admin-participants-body tr").first()).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => Array.isArray(window.S.adminParticipantsData) && window.S.adminParticipantsData.length > 0);
}

async function search(page, text, expectRows) {
  await narrowPeopleTable(page, text);
  await expect(page.locator("#admin-participants-body tr")).toHaveCount(expectRows, { timeout: 10000 });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const rows = Array.from({ length: N }, (_, i) => ({
      nickname: `${STAMP}_${String(i).padStart(2, "0")}`, email: `${STAMP}.${i}@acme.com`,
      first_name: "Csv", last_name: `Row${String(i).padStart(2, "0")}`,
      company: `${STAMP} ${i % 2 ? "Alpha" : "Zeta"} ${String(i).padStart(2, "0")}`,
      title: "Engineer", country: "GB", timezone: "Europe/London", verified: 1, approved: 1,
    }));
    const r = await api.post("/api/admin/import/participants", { headers: H(csrf),
      data: { resolutions: {}, data: { type: "hackarena-participants", version: 2, participants: rows } } });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).imported, "every fixture row imported").toBe(N);
    const list = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
    people = list.filter((p) => String(p.email || "").startsWith(`${STAMP}.`))
      .map((p) => ({ id: p.id, email: p.email, nickname: p.nickname, company: p.company }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
    expect(people.length, "PRECONDITION: the fixture is in the admin list").toBe(N);
    blocked = people.find((p) => p.nickname.endsWith("_07"));
    const b = await api.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(csrf) });
    expect(b.ok(), `block: ${b.status()} ${await b.text()}`).toBeTruthy();
    const after = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants.find((p) => p.id === blocked.id);
    expect(after.blocked, "PRECONDITION: one fixture row is blocked").toBeTruthy();
    ev = await makeCompetition(api, csrf, `pcsv-${STAMP}`);
    await enrol(api, csrf, ev.id, people.slice(0, 3).map((p) => p.id));
    // Named with an ampersand: the Export menu shows the name as typed.
    const emptyName = `EA pcsv-empty R&D ${STAMP}`;
    evEmpty = { ...(await makeCompetition(api, csrf, `pcsv-empty-${STAMP}`, { name: emptyName })), name: emptyName };
  } finally { await api.dispose(); }
});

test.describe("People: Export CSV writes what the table lists", () => {
  test("the search: every page of the matches and nobody else; then the sort orders the file as it orders the table", async ({ page }) => {
    test.setTimeout(120_000);
    await openPeople(page);
    await search(page, STAMP, 30);
    await expect(page.locator("#participants-pagination"), "PRECONDITION: the matches fill more than one page").toContainText(/Page 1 of 2/);
    const file = await exportCsv(page);
    expect(file.map((r) => r.Nickname).sort(), "all 32 matches, from both pages, and no one else").toEqual(people.map((p) => p.nickname).sort());
    expect(file.some((r) => r.Email === "alice@acme.com" || r.Nickname === "alice"), "CONTROL: a participant the search leaves out is not in the file").toBe(false);
    expect(await page.evaluate(() => window.S.adminParticipantsData.length), "CONTROL: the model holds more than the matches").toBeGreaterThan(N);

    // The table's order is the file's order: sort by Company, both ways.
    const companyTh = page.locator("#p-table thead th[data-col='company']");
    for (const dir of ["ascending", "descending"]) {
      await companyTh.click();
      await expect(companyTh).toHaveAttribute("aria-sort", dir);
      const shown = await pageNicknames(page);
      const sorted = await exportCsv(page);
      expect(sorted.slice(0, shown.length).map((r) => r.Nickname), `the file opens with the table's first page, in its order (${dir})`).toEqual(shown);
      const companies = sorted.map((r) => r.Company);
      const want = [...companies].sort((a, b) => dir === "ascending" ? a.localeCompare(b) : b.localeCompare(a));
      expect(companies, `the whole file is in Company order (${dir})`).toEqual(want);
    }
  });

  test("a status chip and a heading filter narrow the file exactly as they narrow the table", async ({ page }) => {
    test.setTimeout(120_000);
    await openPeople(page);
    await search(page, STAMP, 30);
    // The Blocked chip: one row on screen, one row in the file.
    await page.locator('#p-status-filters [data-value="blocked"]').click();
    await expect(page.locator("#admin-participants-body tr")).toHaveCount(1, { timeout: 10000 });
    let file = await exportCsv(page);
    expect(file.map((r) => r.Nickname), "only the blocked match").toEqual([blocked.nickname]);
    expect(file[0].Status).toBe("blocked");
    await page.locator('#p-status-filters [data-value="all"]').click();
    await expect(page.locator("#admin-participants-body tr")).toHaveCount(30, { timeout: 10000 });
    // A heading filter: Company contains "Alpha" (every other fixture row).
    await page.locator("#p-table thead th[data-col='company'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("Alpha", { delay: 20 });
    await expect(page.locator("#admin-participants-body tr")).toHaveCount(N / 2, { timeout: 10000 });
    await page.locator(".tcol-pop [data-tcol-done]").click();
    file = await exportCsv(page);
    expect(file.map((r) => r.Nickname).sort(), "the Alpha half, and only it").toEqual(people.filter((p) => p.company.includes(" Alpha ")).map((p) => p.nickname).sort());
    expect(file.every((r) => r.Company.includes(" Alpha ")), "CONTROL: no Zeta row slipped through").toBe(true);
  });

  test("a search that matches nobody saves no file and says so", async ({ page }) => {
    await openPeople(page);
    let downloads = 0;
    page.on("download", () => { downloads++; });
    await search(page, `${STAMP}-nobody-matches-this`, 1);   // the "No participants match" row
    await expect(page.locator("#admin-participants-body")).toContainText("No participants match");
    await page.locator("#p-export-menu-btn").click();
    await page.locator('#kebab-portal [data-action="export-participants-csv"]').click();
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "Nothing to export" })).toBeVisible();
    expect(downloads, "no file was saved").toBe(0);
    // CONTROL: the same door saves a file once the search matches.
    await search(page, STAMP, 30);
    const file = await exportCsv(page);
    expect(file.length).toBe(N);
  });

  test("inside an event workspace: the event's people, then everyone the table lists with Search everyone ticked", async ({ page }) => {
    test.setTimeout(120_000);
    await openFilterPanels(page);
    await adminLogin(page);
    await clickTab(page, "Events");
    await viewComp(page, ev.name);
    await clickTab(page, "Participants");
    const rows = page.locator("#admin-participants-body tr");
    await expect(rows, "PRECONDITION: the workspace lists the event's three people").toHaveCount(3, { timeout: 15000 });
    expect(await exportLabels(page), "the file is the event's people, and Export CSV names the event").toEqual({ csv: `Export CSV (${ev.name})`, json: `Export JSON (${ev.name})` });
    let file = await exportCsv(page);
    expect(file.map((r) => r.Nickname).sort(), "the event's people").toEqual(people.slice(0, 3).map((p) => p.nickname).sort());
    // Search everyone on the platform: the table lists every account (members
    // first), and so does the file.
    await page.locator("#p-ws-everyone").check();
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBeGreaterThan(3);
    // The file is no longer the event's alone, so its door stops naming the
    // event; the JSON (the server's, always the event's people) still does.
    expect(await exportLabels(page), "Export CSV names no event while the list holds everyone").toEqual({ csv: "Export CSV", json: `Export JSON (${ev.name})` });
    await search(page, STAMP, 30);
    file = await exportCsv(page);
    expect(file.map((r) => r.Nickname).sort(), "every match the table lists, members or not").toEqual(people.map((p) => p.nickname).sort());
    expect(file.slice(0, 3).map((r) => r.Nickname).sort(), "the event's people first, as on screen").toEqual(people.slice(0, 3).map((p) => p.nickname).sort());
  });
  test("an event nobody has joined: the empty export gives the table's reason, not a search that matched nobody", async ({ page }) => {
    test.setTimeout(120_000);
    await openFilterPanels(page);
    await adminLogin(page);
    await clickTab(page, "Events");
    await viewComp(page, evEmpty.name);
    await clickTab(page, "Participants");
    await expect(page.locator("#admin-participants-body"), "PRECONDITION: the table says the event is empty").toContainText("Nobody is in this event yet", { timeout: 15000 });
    expect(await page.locator("#participants-search").inputValue(), "PRECONDITION: no search").toBe("");
    expect(await exportLabels(page), "the doors name the event as it is spelled, never as HTML").toEqual({ csv: `Export CSV (${evEmpty.name})`, json: `Export JSON (${evEmpty.name})` });
    let downloads = 0;
    page.on("download", () => { downloads++; });
    const toasts = page.locator("#toast-stack .toast");
    await page.locator("#p-export-menu-btn").click();
    await page.locator('#kebab-portal [data-action="export-participants-csv"]').click();
    await expect(toasts.filter({ hasText: "Nothing to export — nobody is in this event yet." })).toBeVisible();
    expect(await toasts.filter({ hasText: "search and filters" }).count(), "no search or filter is blamed").toBe(0);
    // CONTROL: a search that matches nobody here is a filter, and is named as one.
    await search(page, `${STAMP}-nobody-matches-this`, 1);
    await expect(page.locator("#admin-participants-body")).toContainText("No participants match");
    await page.locator("#p-export-menu-btn").click();
    await page.locator('#kebab-portal [data-action="export-participants-csv"]').click();
    await expect(toasts.filter({ hasText: "Nothing to export — nobody on the list matches the current search and filters." })).toBeVisible();
    expect(downloads, "no file was saved").toBe(0);
  });

  test("Search → Export people (CSV) from another page opens People first and saves the list it shows", async ({ page }) => {
    test.setTimeout(120_000);
    // A witness on the save itself: what the screen showed at the moment the
    // file was handed to the browser (ui/download.js clicks an <a download>).
    await page.addInitScript(() => {
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download === "participants.csv") {
          const pane = document.getElementById("admin-participants-tab");
          (window.__peopleCsvSaves = window.__peopleCsvSaves || []).push({
            peopleShown: !!pane && pane.style.display !== "none" && pane.getClientRects().length > 0,
            search: document.getElementById("participants-search")?.value || "",
            rows: document.querySelectorAll("#admin-participants-body tr").length,
          });
        }
        return orig.apply(this, arguments);
      };
    });
    await openPeople(page);
    await search(page, STAMP, 30);
    // Leave People. Its search box keeps the term: it is the page's own markup.
    await clickTab(page, "Events");
    await expect(page.locator("#admin-participants-tab"), "PRECONDITION: People is not on screen").toBeHidden();
    expect(await page.locator("#participants-search").inputValue(), "PRECONDITION: the People search outlives leaving the page").toBe(STAMP);
    await openPalette(page);
    await page.locator("#cp-input").fill("Export people");
    const item = page.locator("#cp-list .cp-opt", { hasText: "Export people (CSV)" });
    await expect(item).toHaveCount(1);
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), item.click()]);
    expect(dl.suggestedFilename()).toBe("participants.csv");
    const file = parseCsv(fs.readFileSync(await dl.path(), "utf8"));
    const saves = await page.evaluate(() => window.__peopleCsvSaves || []);
    expect(saves, "one save, made with the People page on screen, its search box holding the term that narrowed the file").toEqual([{ peopleShown: true, search: STAMP, rows: 30 }]);
    await expect(page.locator("#admin-participants-tab"), "People is the page now").toBeVisible();
    await expect(page.locator("#participants-search")).toHaveValue(STAMP);
    expect(file.map((r) => r.Nickname).sort(), "the file is the list People shows: all 32 matches").toEqual(people.map((p) => p.nickname).sort());
    expect(file.slice(0, 30).map((r) => r.Nickname), "in the table's order, its first page first").toEqual(await pageNicknames(page));
  });
});
