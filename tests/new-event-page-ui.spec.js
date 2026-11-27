"use strict";

// THE NEW EVENT PAGE: the one place every event starts.
//   • A TEMPLATE opens the ONE create form, seeded from the template; saving
//     goes through the template's own door (spawn: its challenges, tags and
//     provenance) and then applies the form to the new event — never a plain
//     create, which would drop the challenges.
//   • Templates are protected from loss: a built-in has no Delete; a Protected
//     one has no Delete until unprotected; a delete is soft and one Restore
//     button in Recently deleted undoes it.
//   • An event admin, whose only creating door is the spawn, gets no blank
//     starters and keeps the quick start (name + start).

const { test, expect } = require("./isolated-test");
const { adminLogin, loginViaApi } = require("./ui-admin-helpers");
const { apiLogin, PARTICIPANT_PASS, BASE } = require("./helpers");
const { makeTask, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = (p) => `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makeTemplate(sa, csrf, body) {
  const r = await sa.post("/api/admin/event-templates", { headers: H(csrf), data: body });
  expect(r.ok(), `create template: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).template;
}

async function openNewEvent(page) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
  await expect(page.locator("#admin-templates-tab")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#tpl-list .tpl-row").first()).toBeVisible({ timeout: 15000 });
}

const rowFor = (page, name) => page.locator("#tpl-list .tpl-row")
  .filter({ has: page.locator("button.card-open", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });

test.describe("New event — one place, one form", () => {
  test("a template opens the one create form seeded from it; saving spawns it and applies the form", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Seeded tpl");
    const tag = `autumn${Date.now().toString(36)}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    let task;
    try {
      task = await makeTask(sa, csrf, "seeded");
      await makeTemplate(sa, csrf, {
        name: tplName, description: "", event_kind: "tournament",
        settings: { duration_minutes: 90, attempt_cap: 4, reveal_answers_on_end: true, tags: [tag] },
        task_ids: [task.id],
      });
    } finally { await sa.dispose(); }

    await adminLogin(page);
    await openNewEvent(page);
    await rowFor(page, tplName).locator("button.card-open").click();
    const form = page.locator("#comp-form-overlay");
    await expect(form).toBeVisible({ timeout: 10000 });
    // Seeded from the template, and saying so.
    await expect(form.locator("#comp-form-from")).toContainText(tplName);
    await expect(form.locator("#comp-form-from")).toContainText("1 challenge");
    await expect(form.locator('input[name="comp-kind-seg"][value="tournament"]')).toBeChecked();
    await expect(form.locator("#comp-name")).toHaveValue(tplName);
    await expect(form.locator("#comp-attempt-cap")).toHaveValue("4");
    await expect(form.locator("#comp-reveal-answers")).toBeChecked();
    await expect(form.locator("#comp-dur-h")).toHaveValue("1");
    await expect(form.locator("#comp-dur-m")).toHaveValue("30");
    // No "pick challenges" door: the template brings them.
    await expect(form.locator('[data-action="comp-save-and-pick-tasks"]')).toHaveCount(0);

    const evName = uniq("From tpl");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-attempt-cap").fill("5");
    await form.locator("#comp-date").fill(new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10));
    await form.locator("#comp-time").fill("10:00");

    const seen = [];
    let spawnBody = null;
    page.on("request", (r) => {
      if (/\/api\/admin\/(competitions|event-templates)/.test(r.url()) && r.method() !== "GET") seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    page.on("response", async (r) => {
      if (/\/spawn$/.test(r.url()) && r.request().method() === "POST") spawnBody = await r.json().catch(() => null);
    });
    await form.locator('[data-action="comp-save"]').click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#modal-overlay")).toContainText(tplName);
    await page.locator("#modal-confirm-btn").click();
    await expect(form).toHaveCount(0, { timeout: 15000 });

    // The template's door made it (with its challenge); the form went on top.
    await expect.poll(() => seen.some((s) => /^POST \/api\/admin\/event-templates\/[^/]+\/spawn$/.test(s)), { timeout: 10000 }).toBe(true);
    expect(seen.some((s) => s === "POST /api/admin/competitions"), `never a plain create: ${seen.join(", ")}`).toBe(false);
    expect(seen.some((s) => /^PUT \/api\/admin\/competitions\/[^/]+$/.test(s)), `the form is applied as an edit: ${seen.join(", ")}`).toBe(true);
    expect(spawnBody && spawnBody.assigned_challenges, "the template's challenge came with it").toBe(1);

    const rows = await (await page.request.get("/api/admin/competitions")).json();
    const row = rows.find((c) => c.name === evName);
    expect(row, "the event exists under the name typed").toBeTruthy();
    expect(row.attempt_cap, "the form's value beat the template's").toBe(5);
    expect(!!row.reveal_answers_on_end, "the template's setting the form kept").toBe(true);
    expect(row.duration_minutes).toBe(90);
    expect(row.tags || [], "the template's tags came with it").toContain(tag);
    // And it opens in its workspace, ready to share.
    await expect(page.locator("#ws-record")).toBeVisible({ timeout: 10000 });
  });

  test("protected and built-in templates have no Delete; a delete is undone by one Restore", async ({ page }) => {
    test.setTimeout(120_000);
    const name = uniq("Keep me");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await makeTemplate(sa, csrf, { name, description: "", event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [] }); }
    finally { await sa.dispose(); }

    await adminLogin(page);
    await openNewEvent(page);
    const menu = page.locator("#kebab-portal");
    const openMenu = async (n) => { await rowFor(page, n).locator(".tpl-row-more").click(); await expect(page.locator("#kebab-portal.open")).toBeVisible(); };
    const tpl = async () => ((await (await page.request.get("/api/admin/event-templates")).json()).templates || []).find((t) => t.name === name);

    // A built-in: Reset, never Delete, and the reason in its place.
    const builtin = ((await (await page.request.get("/api/admin/event-templates")).json()).templates || []).find((t) => t.is_builtin);
    expect(builtin, "PRECONDITION: a built-in template exists").toBeTruthy();
    await openMenu(builtin.name);
    await expect(menu.locator('[data-action="tpl-delete"]'), "a built-in has no Delete").toHaveCount(0);
    await expect(menu.locator('[data-action="tpl-reset"]')).toHaveCount(1);
    await expect(menu.locator(".kebab-note")).toContainText(/built-in/i);
    await page.keyboard.press("Escape");

    // CONTROL: an ordinary template offers Delete. Protect it, and Delete goes.
    await openMenu(name);
    await expect(menu.locator('[data-action="tpl-delete"]'), "CONTROL: an ordinary template can be deleted").toHaveCount(1);
    await menu.locator('[data-action="tpl-protect"]').click();
    await expect.poll(async () => (await tpl()).protected, { timeout: 10000 }).toBe(true);
    await expect(rowFor(page, name).locator(".tpl-badge-protected")).toBeVisible({ timeout: 10000 });
    await openMenu(name);
    await expect(menu.locator('[data-action="tpl-delete"]'), "a protected template has no Delete").toHaveCount(0);
    await expect(menu.locator(".kebab-note")).toContainText(/protected/i);
    await menu.locator('[data-action="tpl-protect"]').click();   // Unprotect
    await expect.poll(async () => (await tpl()).protected, { timeout: 10000 }).toBe(false);

    // Delete is soft: the row moves to Recently deleted, and Restore brings it back.
    await openMenu(name);
    await menu.locator('[data-action="tpl-delete"]').click();
    await page.locator("#modal-overlay #modal-confirm-btn").click();
    await expect(rowFor(page, name)).toHaveCount(0, { timeout: 10000 });
    const deleted = page.locator("#tpl-deleted");
    await expect(deleted).toBeVisible({ timeout: 10000 });
    const restore = deleted.locator('[data-action="tpl-restore"]', { hasText: name });
    await expect(restore).toHaveCount(1);
    await restore.click();
    await expect(rowFor(page, name), "one press of Restore puts it back").toHaveCount(1, { timeout: 10000 });
    expect((await tpl()), "and the server lists it again").toBeTruthy();
    await expect(deleted.locator('[data-action="tpl-restore"]', { hasText: name })).toHaveCount(0);
  });

  test("an event admin gets no blank starters, and a template opens the quick start, not the form", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea;
    try {
      ea = await makeParticipant(sa, csrf, "neea");
      const comp = await makeCompetition(sa, csrf, "neea");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
    } finally { await sa.dispose(); }
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openNewEvent(page);
    await expect(page.locator('#tpl-kind-cards [data-action="new-event-start"]'), "no blank starter").toHaveCount(0);
    await expect(page.locator("#tpl-blank-head")).toBeHidden();
    await expect(page.locator("#tpl-deleted"), "no Recently deleted").toBeHidden();
    await page.locator("#tpl-list .tpl-row button.card-open").first().click();
    await expect(page.locator("#tpl-spin"), "the quick start opens").toBeVisible({ timeout: 10000 });
    await expect(page.locator("#comp-form-overlay"), "never the full form").toHaveCount(0);
  });

  // ON A PHONE THE QUICK START IS A SHEET OVER THE PAGE, behind a scrim: a
  // modal, so it keeps the modal contract — Tab stays inside it, Escape closes
  // it, and focus returns to the template that opened it. Beside the list on a
  // wide screen it is a side panel, not a modal (the control). Either way its
  // buttons are the dialog order: Cancel, then Create, in one row (operator
  // ruling, 14 Nov 2026).
  //
  // HOW MANY TABS "PAST THE PANEL" TAKES IS NOT A CONSTANT. A native date or
  // time input holds one Tab stop per segment and, in some environments, one
  // more for its picker button: in the pinned CI image (Chromium, en-US, UTC)
  // the date AND the time input hold four each, so the side panel holds twelve
  // stops after the name box, and a fixed twelve presses ended on its last
  // button there while passing on a machine where the time input holds three.
  // So Tab is pressed until focus leaves the panel, within a bound well past
  // every stop it could hold.
  test("on a phone the quick start is a modal sheet: Tab stays in it, Escape closes it, focus returns (wide screen: a side panel, control)", async ({ browser }) => {
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea;
    try {
      ea = await makeParticipant(sa, csrf, "nesheet");
      const comp = await makeCompetition(sa, csrf, "nesheet");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
    } finally { await sa.dispose(); }
    /** Sign in at a size, open the first template's quick start, report how the sheet behaves. */
    const probe = async (viewport) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport });
      try {
        const page = await ctx.newPage();
        await loginViaApi(page, ea.email, PARTICIPANT_PASS);
        await page.goto("/");
        await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
        if (viewport.width <= 768) {
          await page.locator("#admin-mobile-menu-btn").click();
          await expect(page.locator("#admin-sidebar.mobile-open")).toBeVisible();
        }
        await openNewEvent(page);
        const pick = page.locator("#tpl-list .tpl-row button.card-open").first();
        const pickId = await pick.getAttribute("data-tpl-id");
        await pick.click();
        const sheet = page.locator("#tpl-spin");
        await expect(sheet).toBeVisible({ timeout: 10000 });
        await expect(page.locator("#tpl-spin-name"), "the name box takes focus").toBeFocused();
        const position = await sheet.evaluate((el) => getComputedStyle(el).position);
        const aria = await sheet.evaluate((el) => `${el.getAttribute("role")} ${el.getAttribute("aria-modal")}`);
        // The buttons: Cancel, then Create, side by side.
        const order = await sheet.evaluate((el) => {
          const cancel = el.querySelector(".tpl-spin-cancel"), go = el.querySelector(".tpl-spin-go");
          if (!cancel || !go) return "missing";
          const c = cancel.getBoundingClientRect(), g = go.getBoundingClientRect();
          const first = cancel.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING ? "cancel" : "create";
          return `${first} first, ${Math.abs(c.top - g.top) <= 2 && c.right <= g.left ? "one row" : "stacked"}`;
        });
        // Tab until focus leaves the sheet, or a bound well past its stops (each
        // control holds at most a few: see the note above) runs out.
        const stops = await sheet.evaluate((el) => el.querySelectorAll("input, button, select, textarea, a[href]").length);
        let escaped = false;
        for (let i = 0; i < stops * 5 + 5 && !escaped; i++) {
          await page.keyboard.press("Tab");
          escaped = !(await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest("#tpl-spin")));
        }
        await page.locator("#tpl-spin-name").focus();
        await page.keyboard.press("Escape");
        const closed = await sheet.isHidden();
        const back = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-tpl-id"));
        const ariaAfter = await sheet.evaluate((el) => `${el.getAttribute("role")} ${el.getAttribute("aria-modal")}`);
        return { position, aria, order, stops, escaped, closed, focusBack: back === pickId, ariaAfter };
      } finally { await ctx.close(); }
    };
    const phone = await probe({ width: 390, height: 844 });
    expect(phone.position, "PRECONDITION: on a phone the quick start is a fixed sheet").toBe("fixed");
    expect(phone.stops, "PRECONDITION: the sheet's controls were counted").toBeGreaterThan(3);
    expect({ ...phone, stops: undefined }, "a modal dialog while open (and not once closed); Cancel then Create in one row; Tab never leaves the sheet; Escape closes it; focus returns to the template")
      .toEqual({ position: "fixed", aria: "dialog true", order: "cancel first, one row", stops: undefined, escaped: false, closed: true, focusBack: true, ariaAfter: "null null" });
    const wide = await probe({ width: 1440, height: 900 });
    expect(wide.position, "PRECONDITION: on a wide screen it is a side panel").not.toBe("fixed");
    expect(wide.order, "the side panel's buttons are in the same order").toBe("cancel first, one row");
    expect(wide.escaped, "CONTROL: beside the list, Tab moves on past the panel").toBe(true);
    expect(wide.closed, "CONTROL: and Escape does not close a side panel").toBe(false);
    expect(wide.aria, "CONTROL: nor is the side panel a modal dialog").toBe("null null");
  });
});
