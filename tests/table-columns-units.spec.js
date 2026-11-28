"use strict";

// THE SHARED TABLE COMPONENT'S INVARIANTS (public/js/ui/table-columns.js and
// public/js/ui/table-cards.js) that no single table owns:
//
//  1. ONE CLAIM TO A SORT. While the component sorts a table (a heading with no
//     sort of its own, here the library's Tags), the native heading whose state
//     still says "Title, ascending" claims nothing: aria-sort "none", no arrow.
//     Its menu's Sort ascending, and a press on the heading itself, then take
//     over in ascending order and redraw the rows — never a no-op on a stale
//     aria-sort, never a toggle to descending from a state nobody could see.
//  2. A ROW'S DOORS STAY. The Actions column cannot be switched off under
//     Columns (Groups here), and a column choice applies on the page even where
//     the browser refuses storage.
//  3. THE OBSERVERS ACT ON TOUCHED TABLES ONLY. The workspace status strip
//     repaints every second inside #admin-page; a change outside every table
//     re-syncs and re-labels nothing, while a change inside a table still does.
//     Witness: reads of `HTMLTableElement#tHead`, which only these two modules
//     make.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, clickTab, narrowChallengesTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const STAMP = `tcu${Date.now().toString(36)}`;
const T = {
  a: `${STAMP} Aardvark`,
  b: `${STAMP} Badger`,
  c: `${STAMP} Cobra`,
};

test.describe("table component: one sort claim, fixed doors, touched tables only", () => {
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const h = { "x-csrf-token": csrf, "content-type": "application/json" };
      // Tags make the Tags order (desc: b, a, c — blank last) differ from the
      // Title order (a, b, c), so which sort is in force shows in the rows.
      const tags = { a: ["alpha"], b: ["beta"], c: [] };
      for (const [k, title] of Object.entries(T)) {
        const r = await api.post("/api/admin/tasks", { headers: h, data: {
          title, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" } });
        expect(r.ok(), `create ${k}: ${r.status()} ${await r.text()}`).toBeTruthy();
        const id = (await r.json()).id;
        for (const tag of tags[k]) {
          const tr = await api.post(`/api/admin/tasks/${id}/tags`, { headers: h, data: { tag } });
          expect(tr.ok(), `tag ${tag}: ${tr.status()}`).toBeTruthy();
        }
        // Stage B — the component-sorted column is now Topic (the bank shows no tags).
        if (tags[k].length) {
          const tp = await api.post("/api/admin/topics", { headers: h, data: { name: `${STAMP} ${tags[k][0]}` } });
          expect(tp.status(), `topic: ${await tp.text()}`).toBe(201);
          const pr = await api.put(`/api/admin/tasks/${id}`, { headers: h, data: { topic_id: (await tp.json()).id } });
          expect(pr.ok(), `file under topic: ${await pr.text()}`).toBeTruthy();
        }
      }
      const g = await api.post("/api/admin/groups", { headers: h, data: { name: `${STAMP} group` } });
      expect(g.ok(), `group: ${g.status()} ${await g.text()}`).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      try { for (const k of Object.keys(localStorage)) if (k.startsWith("ha:tcols:")) localStorage.removeItem(k); } catch (_) { /* defaults apply */ }
    });
  });

  const order = (rows) => rows.allInnerTexts().then((ts) => ts.map((t) => (t.includes(T.a) ? "a" : t.includes(T.b) ? "b" : t.includes(T.c) ? "c" : "?")).join(""));
  // Every heading of the library that claims a sort, by column.
  const claims = (page) => page.locator("#admin-task-table thead th").evaluateAll((ths) => ths
    .filter((th) => ["ascending", "descending"].includes(th.getAttribute("aria-sort")))
    .map((th) => `${th.dataset.col || th.dataset.tcol}:${th.getAttribute("aria-sort")}`));

  test("a component sort leaves no native heading claiming one; the menu and the heading take over ascending", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    const rows = page.locator("#admin-task-body tr");
    await expect(rows).toHaveCount(3, { timeout: 15000 });
    const titleTh = page.locator("#admin-task-table thead th[data-col='title']");
    const tagsTh = page.locator("#admin-task-table thead th[data-tcol='topic']");
    // PRECONDITION: the library's own default sort, Title ascending, is in force.
    await expect(titleTh).toHaveAttribute("aria-sort", "ascending");
    expect(await order(rows)).toBe("abc");
    const arrowOf = async (th) => ((await th.innerText()).match(/[▲▼]/) || [""])[0];
    expect(await arrowOf(tagsTh), "PRECONDITION: no arrow on Topic before any sort of it").toBe("");

    // Topic has no sort of its own: two presses on its label sort it descending.
    await tagsTh.click({ position: { x: 8, y: 10 } });
    await tagsTh.click({ position: { x: 8, y: 10 } });
    await expect(tagsTh).toHaveAttribute("aria-sort", "descending");
    await expect.poll(() => order(rows), { timeout: 5000 }).toBe("bac");
    // ONE claim: the Title heading no longer says it sorts the rows.
    await expect.poll(() => claims(page), { timeout: 5000 }).toEqual(["topic:descending"]);
    await expect(page.locator("#tsort-title-icon"), "no arrow over a column that does not order the rows").toHaveText("");
    // Sweep #316 — the heading that orders the rows SHOWS it, as a native one
    // does; hidden from a screen reader, which hears aria-sort.
    await expect(tagsTh.locator(".tcol-sort-ic"), "Topic shows its arrow").toHaveText(/▼/);
    await expect(tagsTh.locator(".tcol-sort-ic")).toHaveAttribute("aria-hidden", "true");
    expect(await arrowOf(page.locator("#admin-task-table thead th[data-tcol='events']")), "CONTROL: only the sorting column has one").toBe("");

    // The Title heading's menu: Sort ascending redraws in Title order.
    await titleTh.locator(".tcol-hbtn").click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    await expect(pop.locator("[data-tcol-sort='asc']"), "the menu does not offer Title as already sorted").toHaveAttribute("aria-pressed", "false");
    await pop.locator("[data-tcol-sort='asc']").click();
    await expect.poll(() => order(rows), { timeout: 5000 }).toBe("abc");
    await expect.poll(() => claims(page), { timeout: 5000 }).toEqual(["title:ascending"]);
    await expect.poll(() => arrowOf(tagsTh), { message: "Topic gives its arrow up when Title takes over" }).toBe("");
    await expect(page.locator("#tsort-title-icon")).toHaveText(/▲/);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);

    // Back to Topic descending, then a press on the Title heading ITSELF: a fresh
    // pick, ascending — not the toggle of a state the heading no longer showed.
    await tagsTh.click({ position: { x: 8, y: 10 } });
    await tagsTh.click({ position: { x: 8, y: 10 } });
    await expect.poll(() => order(rows), { timeout: 5000 }).toBe("bac");
    await expect.poll(() => claims(page), { timeout: 5000 }).toEqual(["topic:descending"]);
    await titleTh.click({ position: { x: 8, y: 10 } });
    await expect.poll(() => claims(page), { timeout: 5000 }).toEqual(["title:ascending"]);
    expect(await order(rows), "the rows follow the heading that claims the sort").toBe("abc");
    // CONTROL: a second press on the same heading still toggles as it always has.
    await titleTh.click({ position: { x: 8, y: 10 } });
    await expect.poll(() => claims(page), { timeout: 5000 }).toEqual(["title:descending"]);
    expect(await order(rows)).toBe("cba");
  });

  test("Actions cannot be switched off under Columns, and a choice applies with storage refused", async ({ page }) => {
    // Storage refuses this component's keys (as a locked-down browser does);
    // everything else the app stores still works.
    await page.addInitScript(() => {
      const P = Storage.prototype;
      for (const m of ["getItem", "setItem", "removeItem"]) {
        const orig = P[m];
        P[m] = function (k, ...rest) {
          if (String(k).startsWith("ha:tcols:")) throw new DOMException("storage refused", "SecurityError");
          return orig.call(this, k, ...rest);
        };
      }
    });
    await adminLogin(page);
    expect(await page.evaluate(() => { try { localStorage.setItem("ha:tcols:probe", "[]"); return "stored"; } catch (_) { return "refused"; } }),
      "PRECONDITION: the component's storage is refused").toBe("refused");

    await clickTab(page, "Groups");
    await expect(page.locator("#groups-tbody tr").first()).toBeVisible({ timeout: 15000 });
    await page.locator(".tcol-bar[data-tcols-for='groups'] .tcol-cols-btn").click();
    const cols = page.locator(".tcol-cols-pop");
    await expect(cols).toBeVisible();
    const actions = cols.locator("[data-tcol-key='actions']");
    await expect(actions, "a row's only doors are listed").toHaveCount(1);
    await expect(actions).toBeChecked();
    await expect(actions, "and cannot be switched off").toBeDisabled();
    await expect(cols.locator("[data-tcol-key='members']"), "CONTROL: an ordinary column can").toBeEnabled();
    await page.keyboard.press("Escape");
    // The Audit table's Details is its rows' only door too.
    await clickTab(page, "Audit");
    await page.locator(".tcol-bar[data-tcols-for='audit'] .tcol-cols-btn").click();
    await expect(cols.locator("[data-tcol-key='details']"), "Audit's Details cannot be switched off").toBeDisabled();
    await expect(cols.locator("[data-tcol-key='actor']"), "CONTROL: an ordinary Audit column can").toBeEnabled();
    await page.keyboard.press("Escape");

    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    await expect(page.locator("#admin-task-body tr")).toHaveCount(3, { timeout: 15000 });
    const author = page.locator("#admin-task-table thead th[data-col='author']");
    await expect(author, "PRECONDITION: Author is past the default set").toBeHidden();
    await page.locator(".tcol-bar[data-tcols-for='challenges'] .tcol-cols-btn").click();
    const pop = page.locator(".tcol-cols-pop");
    await pop.locator("[data-tcol-key='author']").check();
    await expect(author, "the ticked column appears though storage refused to keep it").toBeVisible();
    await pop.locator("[data-tcol-key='author']").uncheck();
    await expect(author).toBeHidden();
    await pop.locator("[data-tcol-key='author']").check();
    await expect(author).toBeVisible();
    await pop.locator("[data-tcol-reset]").click();
    await expect(author, "Reset to default still resets").toBeHidden();
    await expect(pop.locator("[data-tcol-key='author']")).not.toBeChecked();
  });

  test("a change outside every table re-syncs nothing; a change inside one still syncs and labels it", async ({ page }) => {
    await page.addInitScript(() => {
      const d = Object.getOwnPropertyDescriptor(HTMLTableElement.prototype, "tHead");
      window.__tHeadReads = 0;
      Object.defineProperty(HTMLTableElement.prototype, "tHead", {
        configurable: true,
        get() { window.__tHeadReads++; return d.get.call(this); },
        set(v) { d.set.call(this, v); },
      });
    });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, STAMP);
    await expect(page.locator("#admin-task-body tr")).toHaveCount(3, { timeout: 15000 });
    // PREMISE: the live status strip that repaints every second is inside the
    // observed page, and the page holds several component tables.
    expect(await page.locator("#admin-page #admin-scope-banner").count()).toBe(1);
    expect(await page.locator("#admin-page table[data-tcols]").count()).toBeGreaterThanOrEqual(5);

    // What each countdown tick does: replace the strip's children.
    const tick = () => page.evaluate(async () => {
      const b = document.getElementById("admin-scope-banner");
      window.__tHeadReads = 0;
      const s = document.createElement("span");
      s.textContent = `tick ${performance.now()}`;
      b.replaceChildren(s);
      await new Promise((r) => setTimeout(r, 0));   // past the observers' microtask
      return window.__tHeadReads;
    });
    const runs = [await tick(), await tick(), await tick()];
    expect(Math.min(...runs), `a change outside every table read a table's head: ${runs.join(", ")}`).toBe(0);

    // CONTROL: a row added to a table is synced (its hidden column hidden) and
    // labelled for the phone cards — the observers still see table changes.
    const r = await page.evaluate(async () => {
      const tb = document.getElementById("admin-task-body");
      const proto = tb.rows[0];
      window.__tHeadReads = 0;
      const tr = proto.cloneNode(false);
      for (const td of proto.cells) { const c = document.createElement("td"); c.textContent = "probe"; tr.appendChild(c); }
      tb.appendChild(tr);
      await new Promise((res) => setTimeout(res, 0));
      const cells = [...tr.cells];
      const authorIdx = [...document.querySelectorAll("#admin-task-table thead th")].findIndex((th) => th.dataset.col === "author");
      const out = { reads: window.__tHeadReads, labelled: cells.filter((c) => c.hasAttribute("data-label")).length, cells: cells.length,
        authorHidden: authorIdx >= 0 && cells[authorIdx].classList.contains("tcol-off") };
      tr.remove();
      return out;
    });
    expect(r.reads, "the touched table was read").toBeGreaterThan(0);
    expect(r.labelled, "every cell of the new row is labelled").toBe(r.cells);
    expect(r.authorHidden, "and its hidden column is hidden").toBe(true);
  });
});
