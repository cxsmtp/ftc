"use strict";

// THE TEMPLATE EDITOR AND THE NEW EVENT PAGE, held to what a template DOES.
//
//   * New template opens with no type chosen and refuses Create until one is.
//
//   * A setting whose absence means "the kind's create seed" (join link, instant
//     play, the Checkmarx One opt-out, late entries) is SHOWN as the chosen
//     kind's seed while the template leaves it out, re-seeded when the kind
//     changes, and SENT only once the organiser changes it: never as an
//     explicit value the kind never chose (a Booth Event made from an edited
//     built-in used to create Checkmarx One accounts for every walk-up).
//   * The challenge library is read at every editor open, and never offers a
//     qualifying question (another event's own copy).
//   * A save or a spin whose answer is lost never claims nothing was saved.
//   * The blank starters are cards whose control is the title button.
//   * No surface captions a template with its stored kind value.
//   * An event admin's quick spin offers "Add the qualifying questions".
//   * Recently deleted keeps the name readable at a phone's width.

const { test, expect } = require("./isolated-test");
const { adminLogin, loginViaApi } = require("./ui-admin-helpers");
const { apiLogin, PARTICIPANT_PASS, BASE, TEST_DB_PATH } = require("./helpers");
const { makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const SEEDED = ["self_enroll_enabled", "cxone_disabled", "late_entry_enabled"];
const uniq = (p) => `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const dbGet = (sql, ...a) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare(sql).get(...a); } finally { db.close(); } };

async function openTemplates(page) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
  await expect(page.locator("#admin-templates-tab")).toBeVisible({ timeout: 15000 });
  // Settled: the type cards are drawn and the list has answered (a row, or the
  // empty sentence: the built-ins are on the cards, never listed twice).
  await expect(page.locator("#tpl-kind-cards .tpl-kind").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#tpl-list .tpl-row, #tpl-list-empty").first()).toBeVisible({ timeout: 15000 });
}
// Writes through the BROWSER's own session (a second superadmin sign-in would end it).
async function browserApi(page, method, url, data) {
  const csrf = await page.evaluate(() => window.csrfToken);
  const r = await page.request.fetch(url, { method, headers: { "x-csrf-token": csrf, "content-type": "application/json" }, ...(data ? { data } : {}) });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}
async function newTemplateEditor(page, name, kind) {
  await page.locator("#tpl-new-btn").click();
  const ed = page.locator("#tpl-editor");
  await expect(ed).toBeVisible();
  await ed.locator("#tpl-ed-name").fill(name);
  await ed.locator("#tpl-ed-kind").selectOption(kind);
  return ed;
}

test.describe("Template editor — a setting left out takes the kind's seed", () => {
  test("shown as the kind's seed, re-seeded by a kind change, and kept out of the save", async ({ page }) => {
    const name = uniq("Seeds");
    await adminLogin(page);
    await openTemplates(page);
    const ed = await newTemplateEditor(page, name, "booth");
    for (const key of SEEDED) await expect(ed.locator(`#tpl-ed-${key}`), `a Booth Event's ${key} seed is on`).toBeChecked();
    await expect(ed.locator("#tpl-ed-sum"), "the summary says what the event will do").toContainText("No Checkmarx One accounts");
    await expect(ed.locator("#tpl-ed-sum")).toContainText("Join link and QR code");
    // "Allow instant join" was retired (operator ruling, 14 Nov 2026).
    await expect(ed.locator("#tpl-ed-self_enroll_allow_instant"), "the retired switch is not offered").toHaveCount(0);
    await expect(ed.locator("#tpl-ed-sum"), "nor named in the summary").not.toContainText(/instant/i);
    // A different kind, a different seed: nothing touched follows the kind.
    await ed.locator("#tpl-ed-kind").selectOption("tournament");
    await expect(ed.locator("#tpl-ed-cxone_disabled"), "a Competition's opt-out seed is off").not.toBeChecked();
    await expect(ed.locator("#tpl-ed-self_enroll_enabled"), "…and its join link").not.toBeChecked();
    await ed.locator("#tpl-ed-kind").selectOption("booth");
    await expect(ed.locator("#tpl-ed-cxone_disabled")).toBeChecked();

    const posted = page.waitForRequest((r) => r.url().endsWith("/api/admin/event-templates") && r.method() === "POST");
    await ed.locator('button[type="submit"]').click();
    const body = JSON.parse((await posted).postData() || "{}");
    for (const key of SEEDED) expect(body.settings[key], `${key} is left to the kind`).toBeUndefined();
    expect(body.settings.duration_minutes, "CONTROL: the settings were sent").toBe(60);
    await expect(ed).toHaveCount(0, { timeout: 10000 });

    // What a spawn of it makes: the Booth Event's seeds, by value.
    const tpl = ((await (await page.request.get("/api/admin/event-templates")).json()).templates || []).find(t => t.name === name);
    expect(tpl, "the template was saved").toBeTruthy();
    const sp = await browserApi(page, "POST", `/api/admin/event-templates/${tpl.id}/spawn`, { name: uniq("From seeds") });
    expect(sp.status, JSON.stringify(sp.body)).toBe(200);
    const row = dbGet("SELECT cxone_disabled, self_enroll_enabled, late_entry_enabled FROM competitions WHERE id=?", sp.body.competition.id);
    expect(row).toEqual({ cxone_disabled: 1, self_enroll_enabled: 1, late_entry_enabled: 1 });
  });

  test("a setting the organiser changes is theirs: it survives a kind change and is sent", async ({ page }) => {
    const name = uniq("Stated");
    await adminLogin(page);
    await openTemplates(page);
    const ed = await newTemplateEditor(page, name, "booth");
    await ed.locator("#tpl-ed-cxone_disabled").uncheck();
    await ed.locator("#tpl-ed-kind").selectOption("program");
    await expect(ed.locator("#tpl-ed-cxone_disabled"), "a stated choice is not re-seeded (a Program's seed is on)").not.toBeChecked();
    await ed.locator("#tpl-ed-kind").selectOption("booth");
    await expect(ed.locator("#tpl-ed-cxone_disabled")).not.toBeChecked();
    await expect(ed.locator("#tpl-ed-sum")).toContainText("Checkmarx One accounts on enrolment");
    const posted = page.waitForRequest((r) => r.url().endsWith("/api/admin/event-templates") && r.method() === "POST");
    await ed.locator('button[type="submit"]').click();
    const body = JSON.parse((await posted).postData() || "{}");
    expect(body.settings.cxone_disabled, "the stated value is sent").toBe(false);
    expect(body.settings.late_entry_enabled, "CONTROL: an untouched one is still left to the kind").toBeUndefined();
  });

  test("editing the built-in Booth Event changes only what was changed", async ({ page }) => {
    await adminLogin(page);
    await openTemplates(page);
    const builtin = ((await (await page.request.get("/api/admin/event-templates")).json()).templates || []).find(t => t.is_builtin && t.event_kind === "booth");
    expect(builtin, "PRECONDITION: the built-in Booth Event template").toBeTruthy();
    expect(Object.keys(builtin.settings).sort(), "PRECONDITION: it leaves the opt-out and late entries to the kind").toEqual(["duration_minutes", "self_enroll_enabled"]);
    // The built-in is platform-wide: whatever happens below, it goes back to
    // its shipped definition in the finally (a failed assertion must not leave
    // it edited for the rest of the file).
    try {
      // A built-in is its type's recommended setup: edited from that card's menu.
      await page.locator('#tpl-kind-cards .tpl-kind[data-kind="booth"] .tpl-kind-more').click();
      await page.locator(`#kebab-portal [data-action="tpl-edit"][data-tpl-id="${builtin.id}"]`).click();
      const ed = page.locator("#tpl-editor");
      await expect(ed.locator("#tpl-ed-name")).toHaveValue(builtin.name, { timeout: 10000 });
      await expect(ed.locator("#tpl-ed-cxone_disabled"), "the kind's seed is shown").toBeChecked();
      await ed.locator("#tpl-ed-duration").fill("75");
      await ed.locator('button[type="submit"]').click();
      await expect(ed).toHaveCount(0, { timeout: 10000 });
      const after = ((await (await page.request.get("/api/admin/event-templates")).json()).templates || []).find(t => t.id === builtin.id);
      expect(after.settings.duration_minutes, "the change landed").toBe(75);
      expect(after.settings.cxone_disabled, "the opt-out is still the kind's").toBeUndefined();
      expect(after.settings.late_entry_enabled, "late entries are still the kind's").toBeUndefined();
    } finally {
      const reset = await browserApi(page, "POST", `/api/admin/event-templates/${builtin.id}/reset`);
      // Soft: it never hides the failure that brought the test here.
      expect.soft(reset.status, "clean-up: back to the shipped definition").toBe(200);
      const back = ((await (await page.request.get("/api/admin/event-templates")).json()).templates || []).find(t => t.id === builtin.id);
      expect.soft(back && back.settings, "clean-up: the shipped settings are back").toEqual(builtin.settings);
    }
  });
});

// Operator ruling, 14 Nov 2026: New template opens with NO type chosen, refuses
// Create until one is picked, and fills the type-seeded boxes once it is.
// CONTROL: an edit opens on the template's own type, with no "Choose a type…".
test.describe("Template editor — no type is chosen for you", () => {
  test("New template opens on Choose a type…, refuses Create until one is picked, and fills the type's seeds once it is", async ({ page }) => {
    const name = uniq("No type");
    await adminLogin(page);
    await openTemplates(page);
    await page.locator("#tpl-new-btn").click();
    const ed = page.locator("#tpl-editor");
    await expect(ed).toBeVisible();
    const kind = ed.locator("#tpl-ed-kind");
    await expect(kind, "no type chosen").toHaveValue("");
    await expect(kind.locator("option:checked"), "the select says so").toHaveText("Choose a type…");
    for (const key of SEEDED) await expect(ed.locator(`#tpl-ed-${key}`), `${key}: no type, so no seed`).not.toBeChecked();
    await expect(ed.locator("#tpl-ed-sum"), "the summary waits for a type").toContainText("Choose an event type");
    await ed.locator("#tpl-ed-name").fill(name);
    const posts = [];
    page.on("request", (r) => { if (r.url().endsWith("/api/admin/event-templates") && r.method() === "POST") posts.push(r.postData()); });
    await ed.locator('button[type="submit"]').click();
    await expect(ed.locator("#tpl-ed-err"), "Create is refused until a type is picked").toHaveText("Choose an event type.");
    await expect(kind, "and focus goes to the type").toBeFocused();
    expect(posts.length, "nothing was sent").toBe(0);
    // Picked: a Booth Event's seeds fill in, and Create goes through with it.
    await kind.selectOption("booth");
    for (const key of SEEDED) await expect(ed.locator(`#tpl-ed-${key}`), `${key}: the Booth Event's seed`).toBeChecked();
    await expect(ed.locator("#tpl-ed-sum")).toContainText("Booth Event");
    await ed.locator('button[type="submit"]').click();
    await expect(ed).toHaveCount(0, { timeout: 10000 });
    expect(posts.length, "one save").toBe(1);
    expect(JSON.parse(posts[0] || "{}").event_kind, "the type picked").toBe("booth");
    // CONTROL: an edit opens on the template's own type.
    const row = page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: name }) });
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await row.locator(".tpl-row-more").click();
    await page.locator('#kebab-portal [data-action="tpl-edit"]').click();
    await expect(ed.locator("#tpl-ed-name")).toHaveValue(name, { timeout: 10000 });
    await expect(ed.locator("#tpl-ed-kind"), "an edit opens on the template's own type").toHaveValue("booth");
    await expect(ed.locator('#tpl-ed-kind option[value=""]'), "with no Choose a type… to fall back to").toHaveCount(0);
  });
});

test.describe("Template editor — the challenge library", () => {
  test("is read at every open, and never offers a qualifying question", async ({ page }) => {
    const stem = `libq${Date.now().toString(36)}`;
    await adminLogin(page);
    await openTemplates(page);
    const ed1 = await newTemplateEditor(page, uniq("Lib"), "tournament");
    await ed1.locator("[data-tpl-ed-cancel]").click();
    await expect(ed1).toHaveCount(0);
    // Published AFTER the first open: a library kept for the page's life misses it.
    // The quick one is a pick-one question: only one can carry a qualifying tag.
    const mk = async (title, kind = { answer_type: "text", correct_answer: "a" }) => {
      const r = await browserApi(page, "POST", "/api/admin/tasks", { title, description: "d", difficulty: "easy", ...kind, status: "published" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.id || (r.body.task && r.body.task.id);
    };
    await mk(`${stem} plain`);
    const qid = await mk(`${stem} quick`, { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] });
    const tg = await browserApi(page, "POST", `/api/admin/tasks/${qid}/tags`, { tag: "qualifying:libtest" });
    expect(tg.status, JSON.stringify(tg.body)).toBe(200);
    const ed = await newTemplateEditor(page, uniq("Lib"), "tournament");
    await ed.locator("#tpl-ed-task-search").fill(stem);
    const rows = ed.locator("#tpl-ed-task-results li");
    await expect(rows.filter({ hasText: `${stem} plain` }), "a challenge published since the last open is offered").toHaveCount(1);
    await expect(rows.filter({ hasText: `${stem} quick` }), "a qualifying question is never offered").toHaveCount(0);
  });
});

test.describe("Template editor — a save whose answer is lost", () => {
  // The save REACHES the server and is stored (route.fetch), but its answer
  // never reaches the browser (route.abort). The editor cannot know which, so
  // it must not say nothing was saved: here, something was.
  test("says it may not have been saved, never that nothing was", async ({ page }) => {
    const name = uniq("Lost answer");
    await adminLogin(page);
    await openTemplates(page);
    const ed = await newTemplateEditor(page, name, "tournament");
    const landed = [];
    await page.route(/\/api\/admin\/event-templates$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      landed.push((await route.fetch()).status());
      return route.abort("failed");
    });
    await ed.locator('button[type="submit"]').click();
    const msg = ed.locator("#tpl-ed-err");
    await expect(msg).toContainText("may or may not have been saved", { timeout: 10000 });
    expect(await msg.innerText(), "never the claim it cannot know").not.toContain("Nothing was saved");
    expect(landed, "PRECONDITION: the save reached the server and was accepted").toEqual([200]);
    expect(dbGet("SELECT COUNT(*) n FROM event_templates WHERE name=? AND deleted_at IS NULL", name).n,
      "the template WAS saved, which is why the message may not say otherwise").toBe(1);
    await expect(ed, "the editor stays open").toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
  });
});

test.describe("The New event page", () => {
  // A type card holds two starts, so the card itself is no button and no
  // click target (which start would a press on its picture mean?): its
  // controls are the two buttons in its foot, each named from its own words.
  test("a type card is no button: its controls are Recommended setup and Start blank, never a button holding a list", async ({ page }) => {
    await adminLogin(page);
    await openTemplates(page);
    const cards = page.locator("#tpl-kind-cards .tpl-kind");
    await expect(cards, "PRECONDITION: three type cards").toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const card = cards.nth(i);
      expect(await card.evaluate(el => el.tagName), "the card is not a button").toBe("DIV");
      expect(await card.getAttribute("data-action"), "nor a click target").toBeNull();
      const btns = card.locator(".tpl-kind-actions button");
      await expect(btns).toHaveText(["Recommended setup", "Start blank"]);
      for (let j = 0; j < 2; j++) {
        const label = (await btns.nth(j).textContent()).trim();
        expect(await btns.nth(j).getAttribute("aria-label"), "the name opens with the words the button shows").toMatch(new RegExp(`^${label}\\b`));
      }
      await expect(card.locator(".tpl-kind-bullets li"), "CONTROL: the three lines are still on the card").toHaveCount(3);
    }
    await expect(page.locator("#tpl-kind-cards button ul"), "no list inside a button").toHaveCount(0);
    // A press on the card's picture starts nothing.
    await page.locator('#tpl-kind-cards .tpl-kind[data-kind="booth"] .tpl-kind-art').click();
    await page.waitForTimeout(300);
    expect(await page.locator("#comp-form-overlay").count(), "the picture is no door").toBe(0);
    // The keyboard path: Start blank opens the form on its type.
    await page.locator('#tpl-kind-cards .tpl-kind[data-kind="program"] button[data-action="new-event-start"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="program"]')).toBeChecked();
    await expect(page.locator("#comp-form-from"), "a blank start names no template").toHaveCount(0);
    await page.locator('#comp-form-overlay [data-action="overlay-close"]').click();
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 10000 });
    // ...and Recommended setup opens it seeded from the type's built-in.
    await page.locator('#tpl-kind-cards .tpl-kind[data-kind="booth"] button[data-action="tpl-pick"]').click();
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="booth"]')).toBeChecked({ timeout: 10000 });
    await expect(page.locator("#comp-form-from")).toContainText("Booth day (8 hours)");
  });

  test("a template row, live or recently deleted, is never captioned with its stored kind value", async ({ page }) => {
    const gone = uniq("Gone kind caption");
    await adminLogin(page);
    await openTemplates(page);
    const mk = await browserApi(page, "POST", "/api/admin/event-templates", { name: gone, description: "", event_kind: "tournament", settings: { duration_minutes: 30 }, task_ids: [] });
    expect(mk.status, JSON.stringify(mk.body)).toBe(200);
    const del = await browserApi(page, "DELETE", `/api/admin/event-templates/${mk.body.template.id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    await page.evaluate(() => window.loadTemplatesPane());
    const metas = page.locator("#tpl-list .tpl-row .tpl-row-txt small:not(.tpl-row-desc)");
    const deleted = page.locator("#tpl-deleted .tpl-deleted-row").filter({ hasText: gone }).locator("small");
    await expect(metas.first(), "CONTROL: with the vocabulary, the label is shown").toContainText(/Booth Event|Competition|Program/);
    await expect(deleted, "CONTROL: on a deleted row too").toContainText("Competition");
    // The vocabulary gone (a stale shell): the label is left out, never replaced
    // by the stored value.
    await page.evaluate(() => { window.eventKinds = []; return window.loadTemplatesPane(); });
    await expect(page.locator("#tpl-list .tpl-row").first()).toBeVisible();
    const texts = await metas.allTextContents();
    expect(texts.length, "PRECONDITION: rows rendered").toBeGreaterThan(0);
    for (const t of texts) expect(t, "no stored kind value").not.toMatch(/\b(booth|tournament|program)\b/);
    await expect(deleted, "PRECONDITION: the deleted row rendered").toContainText("deleted");
    expect(await deleted.textContent(), "nor on a deleted row").not.toMatch(/\b(booth|tournament|program)\b/);
  });

  // A SHORT name is the case that broke: the name column's basis was 0, so a
  // Restore button that fit beside it kept the line and squeezed the name to a
  // sliver. A long name is the control (its button never fit beside it).
  test("Recently deleted keeps the name readable at a phone's width", async ({ page }) => {
    const names = [uniq("Spin"), uniq("A template with a long name that someone deleted by mistake last week")];
    await adminLogin(page);
    await openTemplates(page);
    for (const name of names) {
      const mk = await browserApi(page, "POST", "/api/admin/event-templates", { name, description: "", event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [] });
      expect(mk.status, JSON.stringify(mk.body)).toBe(200);
      const del = await browserApi(page, "DELETE", `/api/admin/event-templates/${mk.body.template.id}`);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.loadTemplatesPane());
    for (const name of names) {
      const row = page.locator("#tpl-deleted .tpl-deleted-row").filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 10000 });
      const g = await row.evaluate((r) => {
        const txt = r.querySelector(".tpl-row-txt").getBoundingClientRect();
        const btn = r.querySelector('[data-action="tpl-restore"]').getBoundingClientRect();
        const rr = r.getBoundingClientRect();
        return { row: rr.width, rowRight: rr.right, txt: txt.width, txtBottom: txt.bottom, btnTop: btn.top, btnRight: btn.right, page: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
      });
      const tag = `${name.length} chars: ${JSON.stringify(g)}`;
      expect(g.txt, `the name keeps most of the row (${tag})`).toBeGreaterThan(g.row * 0.6);
      expect(g.btnTop, `Restore drops below the name (${tag})`).toBeGreaterThanOrEqual(g.txtBottom - 1);
      expect(g.btnRight, `Restore stays inside the row (${tag})`).toBeLessThanOrEqual(g.rowRight + 1);
      expect(g.page, `no sideways scroll (${tag})`).toBeLessThanOrEqual(g.vw);
    }
  });
});

test.describe("Quick spin — an event admin's door", () => {
  test("offers Add the qualifying questions, seeded by the kind, and a Booth Event gets them", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea, boothTpl, compTpl;
    try {
      ea = await makeParticipant(sa, csrf, "qsea");
      const comp = await makeCompetition(sa, csrf, "qsea");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
      const H = { "x-csrf-token": csrf, "content-type": "application/json" };
      const mkT = async (kind) => {
        const r = await sa.post("/api/admin/event-templates", { headers: H, data: { name: uniq(`QS ${kind}`), description: "", event_kind: kind, settings: { duration_minutes: 60 }, task_ids: [] } });
        expect(r.ok(), await r.text()).toBeTruthy();
        return (await r.json()).template;
      };
      boothTpl = await mkT("booth");
      compTpl = await mkT("tournament");
    } finally { await sa.dispose(); }
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openTemplates(page);
    const pick = async (t) => {
      await page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: t.name }) }).locator("button.card-open").click();
      await expect(page.locator("#tpl-spin")).toBeVisible({ timeout: 10000 });
    };
    // CONTROL first: a Competition's seed is off.
    await pick(compTpl);
    await expect(page.locator("#tpl-spin-qualifying"), "offered on every kind").toHaveCount(1);
    await expect(page.locator("#tpl-spin-qualifying"), "a Competition's seed is off").not.toBeChecked();
    await page.locator('[data-action="tpl-spin-close"]').click();
    await pick(boothTpl);
    await expect(page.locator("#tpl-spin-qualifying"), "a Booth Event's seed is on").toBeChecked();
    // "Opens now": the date and time give way, and the event opens in a minute
    // (a new event must start in the future) rather than at the default slot.
    await expect(page.locator("#tpl-spin .tpl-spin-when"), "PRECONDITION: a date and time are offered").toBeVisible();
    await page.locator("#tpl-spin-now").check();
    await expect(page.locator("#tpl-spin .tpl-spin-when"), "Opens now hides the date and time").toBeHidden();
    const posted = page.waitForRequest((r) => /\/spawn$/.test(r.url()) && r.method() === "POST");
    const t0 = Date.now();
    await page.locator("#tpl-spin-form .tpl-spin-go").click();
    const body = JSON.parse((await posted).postData() || "{}");
    expect(body.add_qualifying, "the tick rides the spawn").toBe(true);
    const lead = Date.parse(body.start_time) - t0;
    expect(lead, `opens about a minute from the press, not at the default slot (${body.start_time})`).toBeGreaterThan(45_000);
    expect(lead).toBeLessThan(90_000);
    await expect(page.locator("#ws-record")).toBeVisible({ timeout: 15000 });
    const id = await page.evaluate(() => window.adminSelectedCompetitionId);
    expect(dbGet("SELECT COUNT(*) n FROM competition_tasks ct WHERE ct.competition_id=? AND EXISTS (SELECT 1 FROM task_tags t WHERE t.task_id=ct.task_id AND t.tag LIKE 'qualifying:%')", id).n,
      "the Booth Event got its four questions").toBe(4);
  });

  // The spawn REACHES the server and makes the event (route.fetch), but its
  // answer never reaches the browser (route.abort): the panel may not say the
  // event was not made.
  test("a spin whose answer is lost says the event may have been made, never that it was not", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea, tpl;
    try {
      ea = await makeParticipant(sa, csrf, "qslost");
      const comp = await makeCompetition(sa, csrf, "qslost");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
      const r = await sa.post("/api/admin/event-templates", { headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { name: uniq("QS lost"), description: "", event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] } });
      expect(r.ok(), await r.text()).toBeTruthy();
      tpl = (await r.json()).template;
    } finally { await sa.dispose(); }
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openTemplates(page);
    await page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: tpl.name }) }).locator("button.card-open").click();
    await expect(page.locator("#tpl-spin")).toBeVisible({ timeout: 10000 });
    const evName = uniq("Lost spin");
    await page.locator("#tpl-spin-name").fill(evName);
    await page.locator("#tpl-spin-now").check();
    const landed = [];
    await page.route(/\/api\/admin\/event-templates\/[^/]+\/spawn$/, async (route) => {
      landed.push((await route.fetch()).status());
      return route.abort("failed");
    });
    await page.locator("#tpl-spin-form .tpl-spin-go").click();
    const msg = page.locator("#tpl-spin-err");
    await expect(msg).toContainText("may or may not have been made", { timeout: 10000 });
    expect(await msg.innerText(), "never the claim it cannot know").not.toContain("Could not create the event");
    expect(landed, "PRECONDITION: the spawn reached the server and was accepted").toEqual([200]);
    expect(dbGet("SELECT COUNT(*) n FROM competitions WHERE name=?", evName).n, "the event WAS made, which is why the panel may not say otherwise").toBe(1);
    await page.unrouteAll({ behavior: "wait" });
  });
});

// A start inside the hour the clocks skip is refused, as the event form and the
// clone dialog refuse it, never stored as the nearest real instant.
test.describe("Quick spin — in a time zone that skips an hour", () => {
  test.use({ timezoneId: "America/New_York" });

  test("refuses a start inside the hour the clocks skip and sends nothing; a real time that day spawns (control)", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea, tpl;
    try {
      ea = await makeParticipant(sa, csrf, "qsdst");
      const comp = await makeCompetition(sa, csrf, "qsdst");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
      const r = await sa.post("/api/admin/event-templates", { headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { name: uniq("QS dst"), description: "", event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] } });
      expect(r.ok(), await r.text()).toBeTruthy();
      tpl = (await r.json()).template;
    } finally { await sa.dispose(); }
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "PRECONDITION: the browser's zone").toBe("America/New_York");
    await openTemplates(page);
    await page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: tpl.name }) }).locator("button.card-open").click();
    await expect(page.locator("#tpl-spin")).toBeVisible({ timeout: 10000 });
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/spawn$/.test(r.url())) posts.push(r.url()); });
    const evName = uniq("DST spin");
    await page.locator("#tpl-spin-name").fill(evName);
    // 14 March 2027, 02:30 does not exist in New York (02:00 jumps to 03:00).
    await page.locator("#tpl-spin-date").fill("2027-03-14");
    await page.locator("#tpl-spin-time").fill("02:30");
    await page.locator("#tpl-spin-form .tpl-spin-go").click();
    await expect(page.locator("#tpl-spin-err")).toContainText("does not exist on that date in America/New_York");
    expect(posts, "nothing was sent").toEqual([]);
    // CONTROL: 03:30 that day is real, and spawns.
    await page.locator("#tpl-spin-time").fill("03:30");
    await page.locator("#tpl-spin-form .tpl-spin-go").click();
    await expect(page.locator(".toast").filter({ hasText: "Created" })).toBeVisible({ timeout: 15000 });
    expect(posts.length, "CONTROL: the real time was sent").toBe(1);
    const made = dbGet("SELECT id, start_time FROM competitions WHERE name=?", evName);
    expect(Date.parse(made.start_time), "stored at 03:30 New York time (07:30 UTC)").toBe(Date.parse("2027-03-14T07:30:00Z"));
    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    try { await sa2.delete(`/api/admin/competitions/${made.id}`, { headers: { "x-csrf-token": c2 } }); } finally { await sa2.dispose(); }
  });
});
