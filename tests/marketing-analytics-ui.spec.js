"use strict";

// THE MARKETING PAGE IN THE BROWSER (features/marketing-admin.js).
//   • it fits at 1440, 1024 and 390 px: no sideways scroll, the per-event table
//     inside its card at desktop widths, its four sections and the table drawn;
//   • it passes axe in every look, day and night (each scan preceded by a check
//     that the page really is in that look and mode);
//   • a failed read says so in the page, with Try again that recovers; a range
//     with no events says so, and hides the table;
//   • Export CSV writes exactly the rows the heading filters leave, every page of
//     them, in the order shown (more matching rows than one page holds);
//   • who is offered it: the sidebar item and the palette's Go to for a
//     superadmin and for a custom role holding `analytics.marketing`; neither for
//     a custom role without it, nor for an event admin (route refusals by value:
//     tests/marketing-analytics.api.spec.js).

const fs = require("fs");
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, waitForAdminPage, settleFiniteAnimations } = require("./helpers");
const { loginViaApi, adminLogin, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { openPalette } = require("./chrome-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const STAMP = Date.now().toString(36);
const W = {};

async function openMarketing(page) {
  const item = page.locator('.admin-nav-item[data-tab-id="admin-marketing-tab"]');
  if ((page.viewportSize() || { width: 1440 }).width <= 768) {
    await page.locator("#admin-mobile-menu-btn").click();
    await expect(page.locator("#admin-sidebar")).toHaveClass(/mobile-open/);
  }
  await item.click();
  await expect(page.locator("#admin-marketing-tab")).toBeVisible();
}
const navShown = (page) => page.evaluate(() => [...document.querySelectorAll("#admin-sidebar .admin-nav-item[data-tab-id]")]
  .filter((b) => { const li = b.closest("li"); return !b.hidden && !(li && (li.hidden || li.style.display === "none")); })
  .map((b) => b.dataset.tabId));

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const mk = async (data) => {
      const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: { name: `Mk UI ${STAMP} ${Math.random().toString(36).slice(2, 7)}`, start_time: new Date(Date.now() - 3600_000).toISOString(), ...data } });
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).competition;
    };
    // Enough Booth Events that one type fills more than a page of the table.
    W.booths = [];
    for (let i = 0; i < 27; i++) W.booths.push(await mk({ event_kind: "booth", duration_minutes: 600, add_qualifying: false }));
    W.comp = await mk({ event_kind: "tournament", duration_minutes: 600, measure_presence: true });
    W.prog = await mk({ event_kind: "program", deadline_at: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const t = await makeTask(sa, csrf, "mkui", { correct_answer: "right" });
    await assignTask(sa, csrf, t.id, [W.comp.id]);
    const people = [];
    for (let i = 0; i < 3; i++) people.push(await makeParticipant(sa, csrf, `mkui${i}`));
    await enrol(sa, csrf, W.comp.id, people.map(p => p.id));
    await enrol(sa, csrf, W.booths[0].id, people.map(p => p.id));
    // Roles: one holding the permission, one without it; and an event admin.
    const role = async (label, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `${label} ${STAMP}`, scope_mode: "all", permissions } });
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).role;
    };
    const rWith = await role("Marketer", ["analytics.marketing"]);
    const rWithout = await role("Analyst only", ["analytics.view"]);
    W.marketer = await makeParticipant(sa, csrf, "mkuimarketer");
    W.analyst = await makeParticipant(sa, csrf, "mkuianalyst");
    for (const [p, r] of [[W.marketer, rWith], [W.analyst, rWithout]]) {
      const g = await sa.patch(`/api/admin/users/${p.id}/role`, { headers: H(csrf), data: { role: r.id } });
      expect(g.ok(), await g.text()).toBeTruthy();
    }
    W.ea = await makeParticipant(sa, csrf, "mkuiea");
    await grantEventAdmin(sa, csrf, W.comp.id, W.ea.id);
  } finally { await sa.dispose(); }
});

async function noSidewaysScroll(page) {
  return page.evaluate(() => {
    const el = document.scrollingElement;
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
}

for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`the page fits at ${vp.width} px: its sections and the table, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await adminLogin(page);
    await openMarketing(page);
    for (const id of ["reach", "engagement", "outcomes", "pipeline"]) await expect(page.locator(`#mk-h-${id}`), `the ${id} section`).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#mk-table-card")).toBeVisible();
    await expect(page.locator("#mk-table-body tr").first()).toBeVisible();
    expect(await page.locator(".mk-kpi").count(), "the figures are drawn").toBeGreaterThanOrEqual(12);
    const s = await noSidewaysScroll(page);
    expect(s.scroll, `the page does not scroll sideways at ${vp.width}`).toBeLessThanOrEqual(s.client);
    const fit = await page.evaluate(() => {
      const card = document.getElementById("mk-table-card").getBoundingClientRect();
      const table = document.getElementById("mk-table").getBoundingClientRect();
      const kpis = [...document.querySelectorAll(".mk-kpi")].map(k => k.getBoundingClientRect());
      return { cardR: card.right, tableR: table.right, kpiOut: kpis.filter(k => k.right > window.innerWidth + 0.5 || k.left < -0.5).length };
    });
    expect(fit.tableR, "the table sits inside its card").toBeLessThanOrEqual(fit.cardR + 0.5);
    expect(fit.kpiOut, "every figure is on screen").toBe(0);
    // The table component's bar (Columns, Sort & filter) sits INSIDE the card,
    // under the "Per event" heading and above the table.
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.tcol-bar[data-tcols-for="marketing"]');
      const card = document.getElementById("mk-table-card");
      if (!b) return null;
      const r = (el) => el.getBoundingClientRect();
      return { inside: card.contains(b), barTop: r(b).top, barBottom: r(b).bottom, headBottom: r(card.querySelector("h3")).bottom, tableTop: r(document.getElementById("mk-table")).top };
    });
    expect(bar, "the bar was drawn").toBeTruthy();
    expect(bar.inside, "the bar is inside the table's card").toBe(true);
    expect(bar.barTop, "under the heading").toBeGreaterThanOrEqual(bar.headBottom - 0.5);
    expect(bar.barBottom, "above the table").toBeLessThanOrEqual(bar.tableTop + 0.5);
    // Each KPI's "?" stays beside its label (never alone on a line), and the
    // tiles in one row are one height.
    const tiles = await page.evaluate(() => [...document.querySelectorAll(".mk-kpi")].map(k => {
      const l = k.querySelector(".mk-kpi-label").getBoundingClientRect();
      const t = k.querySelector(".help-tip-btn").getBoundingClientRect();
      const box = k.getBoundingClientRect();
      return { label: k.querySelector(".mk-kpi-label").textContent, lTop: l.top, lBottom: l.bottom, lRight: l.right, tTop: t.top, tLeft: t.left, top: Math.round(box.top), h: box.height };
    }));
    expect(tiles.length).toBeGreaterThanOrEqual(12);
    const lonely = tiles.filter(t => !(t.tTop < t.lBottom && t.tLeft >= t.lRight - 1));
    expect(lonely.map(t => t.label), "a tip that left its label's line").toEqual([]);
    // The same for the note under Countries and companies.
    const note = await page.evaluate(() => {
      const row = document.querySelector("#mk-body .mk-note-row");
      const l = row.querySelector(".mk-note").getBoundingClientRect(), t = row.querySelector(".help-tip-btn").getBoundingClientRect();
      return { beside: t.top < l.bottom && t.left >= l.right - 1 };
    });
    expect(note.beside, "the note's tip stays beside it").toBe(true);
    const rows = new Map();
    for (const t of tiles) { if (!rows.has(t.top)) rows.set(t.top, []); rows.get(t.top).push(t.h); }
    const uneven = [...rows.entries()].filter(([, hs]) => Math.max(...hs) - Math.min(...hs) > 1);
    expect(uneven, "tiles in one row share a height").toEqual([]);
  });
}

test("the page passes axe in every look, day and night", async ({ page }) => {
  test.setTimeout(240_000);
  const { looks } = require("../scripts/theme/looks");
  const found = [];
  for (const [id, look] of Object.entries(looks)) {
    for (const mode of ["light", "dark"]) {
      await page.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) {} }, [id, mode]);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: mode });
      await adminLogin(page);
      const got = await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme,
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()]);
      expect(got, `${id}/${mode}: the page really is in this look and mode`).toEqual([id, mode, look[mode].bg.toLowerCase()]);
      await openMarketing(page);
      await expect(page.locator("#mk-h-pipeline")).toBeVisible({ timeout: 15000 });
      await page.locator("#mk-events-pick summary").click();
      await expect(page.locator("#mk-events-list input").first()).toBeVisible();
      await settleFiniteAnimations(page);
      const r = await new AxeBuilder({ page }).include("#admin-marketing-tab").withTags(["wcag2a", "wcag2aa"]).analyze();
      const bad = (r.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact)).flatMap(v => v.nodes.map(n => `[${v.impact}] ${v.id} — ${(n.target || []).join(" ")}`));
      if (bad.length) found.push(`${id}/${mode}:\n  ${bad.join("\n  ")}`);
    }
  }
  expect(found, found.join("\n\n")).toEqual([]);
});

test("a failed read says so in the page and Try again recovers; a range with no events says so", async ({ page }) => {
  await adminLogin(page);
  let fail = true;
  await page.route("**/api/admin/analytics/marketing*", (route) => fail
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
    : route.continue());
  await openMarketing(page);
  const failure = page.locator("#mk-body .load-failed");
  await expect(failure).toBeVisible({ timeout: 15000 });
  await expect(failure).toContainText("Could not load the marketing figures");
  await expect(page.locator("#mk-table-card"), "no table for figures that did not load").toBeHidden();
  await expect(page.locator("#mk-h-reach"), "no section claims a figure").toHaveCount(0);
  fail = false;
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#mk-h-reach")).toBeVisible({ timeout: 15000 });
  await expect(failure).toHaveCount(0);

  // An empty range: 2001.
  await page.locator("#mk-preset").selectOption("custom");
  await page.locator("#mk-from").fill("2001-01-01");
  await page.locator("#mk-from").dispatchEvent("change");
  await page.locator("#mk-to").fill("2001-12-31");
  await page.locator("#mk-to").dispatchEvent("change");
  await expect(page.locator("#mk-body .mk-empty")).toContainText("No events started in this range", { timeout: 15000 });
  await expect(page.locator("#mk-table-card")).toBeHidden();
  await expect(page.locator("#mk-events-summary")).toHaveText("Events: all in the range (0)");
  // CONTROL: back to a range with events.
  await page.locator("#mk-preset").selectOption("90d");
  await expect(page.locator("#mk-h-reach")).toBeVisible({ timeout: 15000 });
});

test("Export CSV writes exactly the rows the heading filters leave, every page, in the order shown", async ({ page }) => {
  await adminLogin(page);
  await openMarketing(page);
  await expect(page.locator("#mk-table-body tr").first()).toBeVisible({ timeout: 15000 });
  // Filter Type to Booth Event through the heading's own menu.
  await page.locator('#mk-table th[data-tcol="kind"] .tcol-hbtn').click();
  const sel = page.locator("#tcol-f-marketing-kind");
  await expect(sel).toBeVisible();
  await sel.selectOption("Booth Event");
  await page.locator("[data-tcol-done]").click();
  await expect(page.locator("#mk-table-meta")).toContainText("match");
  const meta = await page.locator("#mk-table-meta").textContent();
  const matched = Number(/^(\d+) of/.exec(meta)[1]);
  expect(matched, `PRECONDITION: more booth events than one page holds (${meta})`).toBeGreaterThan(25);
  const shown = await page.locator("#mk-table-body tr").evaluateAll(rs => rs.map(r => [r.cells[0].textContent, r.cells[1].textContent]));
  expect(shown.length, "the table shows one page").toBe(25);
  expect(new Set(shown.map(r => r[1])), "every row shown is a Booth Event").toEqual(new Set(["Booth Event"]));

  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#mk-export-csv-btn").click()]);
  const text = fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, "");
  const lines = text.trim().split("\n");
  expect(lines[0]).toBe('"Event","Type","Started","Joined","Played","Answers","Solve rate (%)","Scoring questions","Solved every question","Completion (%)","Certificates","Asked qualifying questions","Hot leads"');
  const rows = lines.slice(1).map(l => l.match(/"((?:[^"]|"")*)"/g).map(c => c.slice(1, -1).replace(/""/g, '"')));
  expect(rows.length, "every matching row, not one page").toBe(matched);
  expect(rows.every(r => r[1] === "Booth Event"), "only the filtered rows").toBe(true);
  expect(rows.slice(0, 25).map(r => r[0]), "in the order the table shows").toEqual(shown.map(r => r[0]));
  // CONTROL: clearing the filter writes the other types too.
  await page.locator('#mk-table th[data-tcol="kind"] .tcol-hbtn').click();
  await page.locator("[data-tcol-fclear]").click();
  await page.locator("[data-tcol-done]").click();
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.locator("#mk-export-csv-btn").click()]);
  const all = fs.readFileSync(await dl2.path(), "utf8").trim().split("\n").slice(1);
  expect(all.length, "the unfiltered file holds more rows").toBeGreaterThan(matched);
  expect(all.some(l => l.includes('"Competition"')), "including the Competition").toBe(true);
});

test("offered to a superadmin and a role holding the permission; never to a role without it or an event admin", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const offer = async (pg) => {
    const side = (await navShown(pg)).includes("admin-marketing-tab");
    await openPalette(pg);
    await pg.locator("#cp-input").fill("Marketing");
    // The palette's Go to section (its Help section also finds the guide's "Marketing" heading, for everyone).
    const pal = await pg.evaluate(() => [...document.querySelectorAll("#cp-list .cp-group")]
      .filter(g => g.querySelector(".cp-group-h").textContent.trim() === "Go to")
      .flatMap(g => [...g.querySelectorAll(".cp-opt .cp-label")].map(o => o.textContent.trim())));
    await pg.keyboard.press("Escape");
    return { side, palette: pal.includes("Marketing") };
  };
  await adminLogin(page);
  expect(await offer(page), "the superadmin").toEqual({ side: true, palette: true });
  for (const [who, want] of [[W.marketer, true], [W.analyst, false], [W.ea, false]]) {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    try {
      await loginViaApi(pg, who.email, PARTICIPANT_PASS);
      await pg.goto("/");
      await waitForAdminPage(pg);
      // The item follows the permissions /api/admin/me reports, read after boot.
      await expect.poll(() => pg.evaluate(() => Array.isArray(window.permissions)), { timeout: 15000 }).toBe(true);
      expect(await offer(pg), `${who.email}`).toEqual({ side: want, palette: want });
      if (want) {
        await openMarketing(pg);
        await expect(pg.locator("#mk-h-reach")).toBeVisible({ timeout: 15000 });
      }
    } finally { await ctx.close(); }
  }
});
