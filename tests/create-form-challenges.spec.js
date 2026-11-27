"use strict";

// THE CREATE FORM PICKS NO QUESTIONS (owner ruling, 27 Nov 2026: one door puts
// bank questions into an event, the event's Questions section's + Add from bank),
// the qualifying box on a template create, and the session row at phone width.
//   • A blank create shows no Challenges section and no "Create and pick
//     challenges"; the event is made with no question and no per-question
//     assignment is sent (asserted by value). CONTROL: a library question that
//     exists is simply not offered, and the event's one door is there afterwards.
//   • From a template, the template's own question comes with the spawn (never
//     sent a second time), and "Add the qualifying questions" is offered and
//     honoured through the spawn.
//   • A session row fits a 360 px phone.

const { test, expect } = require("./isolated-test");
const { adminLogin, openCompCreateForm, viewComp, clickTab } = require("./ui-admin-helpers");
const { apiLogin, BASE } = require("./helpers");
const { makeTask } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = (p) => `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Which events (by id) each challenge is on, read from the admin library. */
async function eventsOf(page, ids) {
  const list = await (await page.request.get("/api/admin/tasks")).json();
  const out = {};
  for (const id of ids) {
    const t = list.find((x) => x.id === id);
    out[id] = t ? (t.competitions || []).map((c) => c.id) : null;
  }
  return out;
}

async function confirmCreate(page) {
  await page.locator('#comp-form-overlay [data-action="comp-save"]').click();
  await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 20000 });
}

test.describe("Create form — no question picker; the event's one door", () => {
  test("a blank create picks nothing and sends no assignment; the event's Questions section offers + Add from bank", async ({ page }) => {
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    let lib;
    try { lib = await makeTask(sa, csrf, "library question"); } finally { await sa.dispose(); }

    await adminLogin(page);
    await openCompCreateForm(page, "tournament", { advanced: false });
    const form = page.locator("#comp-form-overlay");
    await expect(form.locator("#comp-name"), "PRECONDITION: the form is open").toBeVisible();
    await expect(form.locator("#comp-ch"), "no Challenges section").toHaveCount(0);
    await expect(form.locator('[data-action="comp-save-and-pick-tasks"]'), "no Create and pick challenges").toHaveCount(0);
    await expect(form, "the library question is not offered here").not.toContainText(lib.title);
    const evName = uniq("No picker");
    await form.locator("#comp-name").fill(evName);

    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/admin\/tasks\/[^/]+\/competitions$/.test(new URL(r.url()).pathname)) posts.push(new URL(r.url()).pathname);
    });
    await confirmCreate(page);
    const ev = (await (await page.request.get("/api/admin/competitions")).json()).find((c) => c.name === evName);
    expect(ev, "the event exists").toBeTruthy();
    expect(posts, "no per-question assignment was sent").toEqual([]);
    expect((await eventsOf(page, [lib.id]))[lib.id], "the library question is not on the event").not.toContain(ev.id);

    // CONTROL: the one door is in the event's Questions section.
    await viewComp(page, evName);
    await clickTab(page, "Challenges");
    await expect(page.locator("#add-tasks-to-comp-btn")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#add-tasks-to-comp-btn")).toHaveText("+ Add from bank");
  });

  test("from a template: its question comes with the spawn and is not sent again; the qualifying box is offered and honoured", async ({ page }) => {
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const tplName = uniq("Qual tpl");
    let inTpl;
    try {
      inTpl = await makeTask(sa, csrf, "in-template");
      const r = await sa.post("/api/admin/event-templates", { headers: H(csrf), data: {
        name: tplName, description: "", event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [inTpl.id],
      } });
      expect(r.ok(), `template: ${r.status()} ${await r.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }

    await adminLogin(page);
    await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
    const tplRow = page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: tplName }) });
    await tplRow.locator("button.card-open").click();
    const form = page.locator("#comp-form-overlay");
    await expect(form.locator("#comp-name")).toBeVisible({ timeout: 10000 });
    await expect(form.locator("#comp-ch"), "no Challenges section on a template create either").toHaveCount(0);
    const evName = uniq("Tpl with qual");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10));

    // Offered on a template create too (a Competition's seed is off).
    await form.locator("#comp-advanced summary").click();
    const q = form.locator("#comp-add-qualifying");
    await expect(q, "the qualifying box is offered on a template create").toHaveCount(1);
    await expect(q).not.toBeChecked();
    await q.check();

    let spawnReq = null;
    const posts = [];
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (r.method() === "POST" && /\/spawn$/.test(p)) spawnReq = r.postDataJSON();
      if (r.method() === "POST" && /\/api\/admin\/tasks\/[^/]+\/competitions$/.test(p)) posts.push(p);
    });
    await confirmCreate(page);
    expect(spawnReq && spawnReq.add_qualifying, "the box rides the spawn").toBe(true);

    const ev = (await (await page.request.get("/api/admin/competitions")).json()).find((c) => c.name === evName);
    expect(ev, "the event exists").toBeTruthy();
    await expect.poll(async () => (await eventsOf(page, [inTpl.id]))[inTpl.id], { timeout: 10000 }).toContain(ev.id);
    expect(posts, "the template's question is not assigned a second time, and nothing else is").toEqual([]);
    const lib = await (await page.request.get("/api/admin/tasks")).json();
    const qual = lib.filter((t) => (t.tags || []).some((tg) => tg.startsWith("qualifying:")) && (t.competitions || []).some((c) => c.id === ev.id));
    expect(qual.length, "the four qualifying questions were made for the event").toBe(4);
  });

  test("spawn: add_qualifying is a strict boolean, absent adds none, and a staff-compete template refuses it", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const mk = async (settings) => {
        const r = await sa.post("/api/admin/event-templates", { headers: H(csrf), data: { name: uniq("Spawn q"), description: "", event_kind: "tournament", settings: { duration_minutes: 60, ...settings }, task_ids: [] } });
        expect(r.ok(), `template: ${r.status()} ${await r.text()}`).toBeTruthy();
        return (await r.json()).template;
      };
      const plain = await mk({});
      const compete = await mk({ staff_compete: true });
      const spawn = (t, extra) => sa.post(`/api/admin/event-templates/${t.id}/spawn`, { headers: H(csrf), data: { name: uniq("Spawned"), ...extra } });
      const bad = await spawn(plain, { add_qualifying: "yes" });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).code).toBe("add_qualifying_invalid");
      const none = await spawn(plain, {});
      expect(none.status()).toBe(200);
      expect((await none.json()).qualifying_questions, "absent adds none").toBe(0);
      const yes = await spawn(plain, { add_qualifying: true });
      expect(yes.status()).toBe(200);
      expect((await yes.json()).qualifying_questions).toBe(4);
      const refused = await spawn(compete, { add_qualifying: true });
      expect(refused.status()).toBe(400);
      expect((await refused.json()).code).toBe("qualifying_in_compete_event");
      const ok = await spawn(compete, { add_qualifying: false });
      expect(ok.status(), "CONTROL: the same template spawns without it").toBe(200);
    } finally { await sa.dispose(); }
  });

  test("a session row fits a 360 px phone", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await adminLogin(page);
    // The phone section bar leads to Events; the New event page is one click on.
    await openCompCreateForm(page, "tournament", { advanced: false });
    const form = page.locator("#comp-form-overlay");
    await form.locator('label[for="comp-mode-multi"]').click();
    const srow = form.locator("#comp-sessions-list .session-form-row").first();
    await expect(srow).toBeVisible({ timeout: 10000 });
    await srow.scrollIntoViewIfNeeded();
    const geo = await srow.evaluate((row) => {
      const r = row.getBoundingClientRect();
      const edge = (sel) => { const el = row.querySelector(sel); const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, w: b.width }; };
      return {
        row: { left: r.left, right: r.right },
        date: edge(".ts-end-date"), time: edge(".ts-end-time"), box: edge(".session-form-dur-box"),
        vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
        rowScroll: row.scrollWidth - row.clientWidth,
      };
    });
    const msg = JSON.stringify(geo);
    expect(geo.date.w, `PRECONDITION: the end date rendered: ${msg}`).toBeGreaterThan(40);
    expect(geo.row.right, `the row stays inside the viewport: ${msg}`).toBeLessThanOrEqual(geo.vw + 0.5);
    for (const k of ["date", "time", "box"]) {
      expect(geo[k].right, `${k} stays inside the session row: ${msg}`).toBeLessThanOrEqual(geo.row.right + 0.5);
      expect(geo[k].left, `${k} stays inside the session row: ${msg}`).toBeGreaterThanOrEqual(geo.row.left - 0.5);
    }
    expect(geo.rowScroll, `the row does not scroll sideways: ${msg}`).toBeLessThanOrEqual(0);
    expect(geo.sw, `the page does not scroll sideways: ${msg}`).toBeLessThanOrEqual(geo.vw);
  });
});
