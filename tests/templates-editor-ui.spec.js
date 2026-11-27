"use strict";

// THE TEMPLATE EDITOR (Templates page): from scratch, edit, duplicate, delete
// from the row's ⋯ menu; options the kind's POLICY forbids are disabled WITH
// the reason and never sent; the kind cards carry three ticked lines; an event
// admin is offered none of the template doors, and a competitor is offered no
// Save as template on the event they compete in.

const { test, expect } = require("./isolated-test");
const { adminLogin, loginViaApi, viewComp } = require("./ui-admin-helpers");
const { apiLogin, PARTICIPANT_PASS, BASE } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

async function openTemplates(page) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
  await expect(page.locator("#tpl-list")).toBeVisible({ timeout: 15000 });
  // Settled: the type cards are drawn and the list has answered (a row, or
  // the empty sentence: the built-ins are on the cards, never listed twice).
  await expect(page.locator("#tpl-kind-cards .tpl-kind").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#tpl-list .tpl-row, #tpl-list-empty").first()).toBeVisible({ timeout: 15000 });
}

// Read through the BROWSER's own session: a second superadmin sign-in would
// end it (one session per principal).
let _page = null;
async function templatesByName(name) {
  const d = await (await _page.request.get("/api/admin/event-templates")).json();
  return (d.templates || []).filter((t) => t.name === name);
}

test.describe("Templates — the editor", () => {
  test("kind cards say three things, as ticked lines", async ({ page }) => {
    await adminLogin(page);
    await page.goto("/");
    await openTemplates(page);
    const cards = page.locator("#tpl-kind-cards .tpl-kind");
    expect(await cards.count(), "PRECONDITION: the kinds rendered").toBeGreaterThanOrEqual(3);
    for (let i = 0; i < await cards.count(); i++) {
      await expect(cards.nth(i).locator(".tpl-kind-bullets li")).toHaveCount(3);
    }
  });

  test("a Booth Event template: forbidden options are disabled with the reason and not sent; create, edit, duplicate, delete", async ({ page }) => {
    test.setTimeout(120_000);
    const name = `TPL editor ${Date.now()}`;
    _page = page;
    await adminLogin(page);
    await page.goto("/");
    await openTemplates(page);
    await page.locator("#tpl-new-btn").click();
    const ed = page.locator("#tpl-editor");
    await expect(ed).toBeVisible();
    await ed.locator("#tpl-ed-name").fill(name);
    await ed.locator("#tpl-ed-kind").selectOption("booth");
    // Booth: no presence, no team-board restriction, late entry allowed, sign-up fields configurable.
    await expect(ed.locator("#tpl-ed-measure_presence"), "a Booth Event does not record presence").toBeDisabled();
    await expect(ed.locator('[data-why="measure_presence"]'), "…and says why").toContainText("does not record time");
    await expect(ed.locator("#tpl-ed-late_entry_enabled"), "CONTROL: late entry is allowed on a booth").toBeEnabled();
    await expect(ed.locator('input[name="tpl-ed-reg-phone"][value="required"]'), "CONTROL: a booth chooses its sign-up fields").toBeEnabled();
    // Program: late entry is forbidden; the field matrix is not (every kind
    // chooses its sign-up fields, operator ruling 30 Oct 2026).
    await ed.locator("#tpl-ed-kind").selectOption("program");
    await expect(ed.locator("#tpl-ed-late_entry_enabled")).toBeDisabled();
    await expect(ed.locator('[data-why="late_entry_enabled"]')).toContainText("Only a Booth Event");
    await expect(ed.locator('[data-why="reveal_answers_on_end"]'), "a Program never publishes answers").not.toHaveText("");
    // 8.17.0 page re-check (axe serious color-contrast): a forbidden option was
    // dimmed with the global `.is-disabled{opacity:.5}`, taking its labels below
    // AA. It is marked with a dashed edge and the muted ink at full opacity.
    {
      const { textContrast } = require("./ui-admin-helpers");
      await expect(ed.locator('input[name="tpl-ed-reg-phone"][value="required"]'), "a Program chooses its sign-up fields as well").toBeEnabled();
      await expect(ed.locator('.tpl-ed-opt.is-disabled[data-opt="registration_fields"]')).toHaveCount(0);
      const off = ed.locator('.tpl-ed-opt.is-disabled[data-opt="late_entry_enabled"]');
      await expect(off, "PRECONDITION: late entry is forbidden on a Program").toHaveCount(1);
      for (const l of [off.locator("span").first()]) {
        const c = await textContrast(l);
        expect(c.opacity, `no opacity dimming: ${JSON.stringify(c)}`).toBe(1);
        expect(c.ratio, `readable: ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    await ed.locator("#tpl-ed-kind").selectOption("booth");
    await ed.locator("#tpl-ed-duration").fill("45");
    await ed.locator('input[name="tpl-ed-reg-phone"][value="required"]').check();
    await expect(ed.locator("#tpl-ed-sum"), "the live summary follows the form").toContainText("runs for 45 min");

    const posted = page.waitForRequest((r) => r.url().endsWith("/api/admin/event-templates") && r.method() === "POST");
    await ed.locator('button[type="submit"]').click();
    const body = JSON.parse((await posted).postData() || "{}");
    expect(body.event_kind).toBe("booth");
    expect(body.settings.measure_presence, "a forbidden option is never sent").toBeUndefined();
    expect(body.settings.registration_fields.phone).toBe("required");
    await expect(ed).toHaveCount(0, { timeout: 10000 });
    expect((await templatesByName(name)).length, "the template was created").toBe(1);

    // Edit from the row's ⋯ menu.
    const diag = [];
    page.on("pageerror", (e) => diag.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") diag.push(`console: ${m.text()}`); });
    page.on("response", (r) => { if (r.url().includes("/api/admin/event-templates/") && r.request().method() === "GET") diag.push(`GET ${r.status()}`); });
    const row = page.locator("#tpl-list .tpl-row", { hasText: name });
    await expect(row, "the new template is listed").toHaveCount(1, { timeout: 10000 });
    await row.locator(".tpl-row-more").click();
    await expect(page.locator("#kebab-portal.open")).toBeVisible();
    await page.locator('#kebab-portal [data-action="tpl-edit"]').click();
    await expect(ed.locator("#tpl-ed-name"), "the editor opens on the template").toHaveValue(name, { timeout: 10000 })
      .catch(async (e) => { throw new Error(`${e.message}\ntoasts: ${await page.locator("#toast-stack").innerText().catch(() => "")}\n${diag.join("\n")}`); });
    await expect(ed.locator('input[name="tpl-ed-reg-phone"][value="required"]'), "the stored field state is shown").toBeChecked();
    await ed.locator("#tpl-ed-duration").fill("50");
    await ed.locator('button[type="submit"]').click();
    await expect(ed).toHaveCount(0, { timeout: 10000 });
    expect((await templatesByName(name))[0].settings.duration_minutes).toBe(50);

    // Duplicate.
    await row.locator(".tpl-row-more").click();
    await page.locator('#kebab-portal [data-action="tpl-duplicate"]').click();
    await expect(ed.locator("#tpl-ed-name")).toHaveValue(`${name} (copy)`);
    await ed.locator('button[type="submit"]').click();
    await expect(ed).toHaveCount(0, { timeout: 10000 });
    expect((await templatesByName(`${name} (copy)`)).length, "the copy is a new template").toBe(1);

    // Delete both, from the ⋯ menu (no detached trash button).
    await expect(page.locator("#tpl-list .tpl-row-del"), "no trash button outside the menu").toHaveCount(0);
    for (const n of [`${name} (copy)`, name]) {
      const r = page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: new RegExp(`^${n.replace(/[()]/g, "\\$&")}$`) }) });
      await r.locator(".tpl-row-more").click();
      await page.locator('#kebab-portal [data-action="tpl-delete"]').click();
      await page.locator("#modal-overlay #modal-confirm-btn").click();
      await expect.poll(async () => (await templatesByName(n)).length, { timeout: 10000 }).toBe(0);
    }
  });

  test("the challenge picker finds challenges by TAG, shows their tags, and adds several at once", async ({ page }) => {
    const { makeTask } = require("./event-admin-helpers");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const tag = `tagq${Date.now().toString(36)}`;
    let a, b, decoy;
    try {
      a = await makeTask(sa, csrf, "tagsearch-a");
      b = await makeTask(sa, csrf, "tagsearch-b");
      decoy = await makeTask(sa, csrf, "tagsearch-decoy");
      for (const t of [a, b]) {
        const r = await sa.post(`/api/admin/tasks/${t.id}/tags`, { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { tag } });
        expect(r.ok(), `tag ${t.title}: ${await r.text()}`).toBeTruthy();
      }
    } finally { await sa.dispose(); }
    _page = page;
    await adminLogin(page);
    await page.goto("/");
    await openTemplates(page);
    await page.locator("#tpl-new-btn").click();
    const ed = page.locator("#tpl-editor");
    await expect(ed).toBeVisible();
    // A tag is not in either title, so a title-only search finds nothing: the
    // two hits prove the tag was searched; the decoy (same title prefix, no
    // tag) proves it is the tag and not the title doing it.
    await ed.locator("#tpl-ed-task-search").fill(tag);
    const rows = ed.locator("#tpl-ed-task-results li");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: a.title })).toHaveCount(1);
    await expect(rows.filter({ hasText: b.title })).toHaveCount(1);
    await expect(rows.filter({ hasText: decoy.title })).toHaveCount(0);
    await expect(rows.first().locator(".tag.is-hit"), "the matched tag is shown as a chip").toHaveText(tag);
    // CONTROL: the title still matches.
    await ed.locator("#tpl-ed-task-search").fill(decoy.title);
    await expect(rows.filter({ hasText: decoy.title })).toHaveCount(1);
    // Several at once.
    await ed.locator("#tpl-ed-task-search").fill(tag);
    await expect(rows).toHaveCount(2);
    await ed.locator("#tpl-ed-task-addall").click();
    await expect(ed.locator("#tpl-ed-tasks .tpl-ed-task")).toHaveCount(2);
    await expect(rows.filter({ hasText: a.title }), "an added challenge leaves the results").toHaveCount(0);
  });

  // Operator ruling, 14 Nov 2026: an event numbers its challenges by difficulty,
  // then title, whatever a template held, so the editor lists them in that order
  // with no row numbers and nothing to reorder them, and the save keeps it. The
  // editor's order is a CLIENT COPY of the numbering (lib/competitions.js
  // `_assignTaskNumbers`: a counter per difficulty, titles in SQLite's BINARY
  // order, which is code-point order), so the test spawns an event from the
  // template, starts it, and holds the editor's order to the numbers that event
  // really gives. The titles are ones a looser comparison puts elsewhere: case
  // ("Zeta" before "alpha"), digits ("10" before "9"), an accent after "z", and a
  // character above U+FFFF after one just below it (UTF-16 code units put it
  // first); a medium and a hard one whose titles alone would put them first.
  test("challenges are listed as events number them, by difficulty then title: no numbers, nothing to reorder, and an event made from the template numbers them in that order", async ({ page }) => {
    test.setTimeout(120_000);
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const stem = `ord${Date.now().toString(36)}`;
    // Added in this order, which is neither difficulty nor title order.
    const fixture = [["hard", "0 first"], ["easy", "\u{1F525} warm"], ["easy", "alpha"], ["medium", "Aaa"], ["easy", "9 doors"],
      ["easy", "éclair"], ["easy", "Zeta"], ["easy", "！ bang"], ["easy", "10 doors"]].map(([difficulty, s]) => ({ difficulty, title: `${stem} ${s}` }));
    const expected = ["10 doors", "9 doors", "Zeta", "alpha", "éclair", "！ bang", "\u{1F525} warm", "Aaa", "0 first"].map((s) => `${stem} ${s}`);
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      for (const t of fixture) {
        const r = await sa.post("/api/admin/tasks", { headers: { "x-csrf-token": csrf, "content-type": "application/json" },
          data: { title: t.title, description: "d", difficulty: t.difficulty, answer_type: "text", correct_answer: "a", status: "published" } });
        expect(r.ok(), `create ${t.title}: ${await r.text()}`).toBeTruthy();
        const d = await r.json();
        t.id = d.id || (d.task && d.task.id);
      }
    } finally { await sa.dispose(); }
    const byTitle = Object.fromEntries(fixture.map((t) => [t.title, t]));
    _page = page;
    await adminLogin(page);
    await page.goto("/");
    await openTemplates(page);
    await page.locator("#tpl-new-btn").click();
    const ed = page.locator("#tpl-editor");
    await expect(ed).toBeVisible();
    await ed.locator("#tpl-ed-name").fill(`Order ${stem}`);
    await ed.locator("#tpl-ed-kind").selectOption("tournament");
    for (const t of fixture) {
      await ed.locator("#tpl-ed-task-search").fill(t.title);
      await ed.locator(`#tpl-ed-task-results [data-op="add"][data-tpl-task="${t.id}"]`).click();
    }
    const titles = ed.locator("#tpl-ed-tasks .tpl-ed-task .tpl-ed-task-title");
    await expect(titles, "PRECONDITION: all were added").toHaveCount(fixture.length);
    expect(await titles.allTextContents(), "easy, then medium, then hard; by title (code points) within a difficulty").toEqual(expected);
    await expect(ed.locator('#tpl-ed-tasks [data-op="up"], #tpl-ed-tasks [data-op="down"]'), "nothing to reorder them").toHaveCount(0);
    await expect(ed.locator("#tpl-ed-tasks .t-num"), "no row numbers").toHaveCount(0);
    expect(await ed.locator("#tpl-ed-tasks").evaluate((el) => el.tagName), "not an ordered list").toBe("UL");
    await expect(ed.locator('#tpl-ed-tasks [data-op="remove"]'), "CONTROL: each can still be removed").toHaveCount(fixture.length);
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/admin/event-templates") && r.request().method() === "POST");
    await ed.locator('button[type="submit"]').click();
    const res = await saved;
    expect(res.ok(), `the save: ${await res.text()}`).toBeTruthy();
    expect(JSON.parse(res.request().postData() || "{}").task_ids, "the save keeps the same order").toEqual(expected.map((x) => byTitle[x].id));
    const tplId = (await res.json()).template.id;
    await expect(ed).toHaveCount(0, { timeout: 10000 });

    // An event made from it, started (numbers are given when an event goes
    // live) and numbered by a read that numbers it. Through the browser's own
    // session: a second superadmin sign-in would end it.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const hdr = { "x-csrf-token": csrfToken, "content-type": "application/json" };
    const sp = await page.request.post(`/api/admin/event-templates/${tplId}/spawn`, { headers: hdr, data: { name: `Order event ${stem}`, start_time: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(sp.ok(), `spawn: ${await sp.text()}`).toBeTruthy();
    const evId = (await sp.json()).competition.id;
    const st = await page.request.put(`/api/admin/competitions/${evId}`, { headers: hdr, data: { start_time: new Date(Date.now() - 60_000).toISOString() } });
    expect(st.ok(), `start: ${await st.text()}`).toBeTruthy();
    const nr = await page.request.get(`/api/admin/competitions/${evId}/free-text-responses`);
    expect(nr.ok(), `numbering read: ${await nr.text()}`).toBeTruthy();
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let got;
    try { got = Object.fromEntries(db.prepare("SELECT task_id, task_number FROM competition_tasks WHERE competition_id=?").all(evId).map((r) => [r.task_id, r.task_number])); }
    finally { db.close(); }
    // The numbers the editor's order means: a counter per difficulty, in that order.
    const level = { easy: 1, medium: 2, hard: 3 }, count = {};
    const want = Object.fromEntries(expected.map((x) => {
      const lv = level[byTitle[x].difficulty];
      count[lv] = (count[lv] || 0) + 1;
      return [byTitle[x].id, `${lv}.${String(count[lv]).padStart(2, "0")}`];
    }));
    expect(Object.keys(got).length, "PRECONDITION: the event holds every challenge").toBe(fixture.length);
    expect(got, "an event made from the template numbers its challenges in the order the editor listed them").toEqual(want);
  });

  test("the quick spin counts a template's challenges and claims no order of its own", async ({ page }) => {
    const { makeTask, assignTask } = require("./event-admin-helpers");
    const name = `Spin count ${Date.now().toString(36)}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea;
    try {
      ea = await makeParticipant(sa, csrf, "qscount");
      const comp = await makeCompetition(sa, csrf, "qscount");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
      const t1 = await makeTask(sa, csrf, "qscount1");
      const t2 = await makeTask(sa, csrf, "qscount2");
      // On the event admin's own event, so the template shows them to them.
      for (const x of [t1, t2]) await assignTask(sa, csrf, x.id, [comp.id]);
      const r = await sa.post("/api/admin/event-templates", { headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { name, description: "", event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [t2.id, t1.id] } });
      expect(r.ok(), await r.text()).toBeTruthy();
    } finally { await sa.dispose(); }
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openTemplates(page);
    await page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: name }) }).locator("button.card-open").click();
    const facts = page.locator("#tpl-spin .tpl-spin-facts");
    await expect(facts, "the count").toContainText("2 challenges", { timeout: 10000 });
    await expect(facts, "and no order an event would not keep").not.toContainText("same order");
  });

  test("an event admin is offered no template doors", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea;
    const own = `EA sees ${Date.now()}`;
    try {
      ea = await makeParticipant(sa, csrf, "tplea");
      const comp = await makeCompetition(sa, csrf, "tplea");
      await grantEventAdmin(sa, csrf, comp.id, ea.id);
      const t = await sa.post("/api/admin/event-templates", { headers: H(csrf), data: { name: own, event_kind: "tournament", settings: { duration_minutes: 30 } } });
      expect(t.ok(), `PRECONDITION: a template of an organiser's own: ${await t.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openTemplates(page);
    await expect(page.locator("#tpl-new-btn"), "no New template").toBeHidden();
    await expect(page.locator("#tpl-list .tpl-row", { hasText: own }), "CONTROL: the organisers' template is listed").toHaveCount(1);
    await expect(page.locator("#tpl-list .tpl-row-more"), "no row menu").toHaveCount(0);
    await expect(page.locator("#tpl-kind-cards .tpl-kind-more"), "no menu on a recommended setup").toHaveCount(0);
    await expect(page.locator('#tpl-kind-cards button[data-action="tpl-pick"]:enabled'), "CONTROL: the recommended setups are offered").toHaveCount(3);
  });

  // THE OPERATOR'S RULING OF 14 NOV 2026: Save as template is withheld from a
  // competitor exactly as Clone is (the same `!competing`, the menu's note the
  // reason), and the route refuses it (tests/event-clone-templates.api.spec.js).
  test("a competitor's workspace ⋯ menu withholds Save as template with the reason; the same admin on another event, and a non-competing admin on this one, are offered it (controls)", async ({ page, browser }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let competitor, bystander, compete, plain;
    try {
      const promote = async (label) => {
        const u = await makeParticipant(sa, csrf, label);
        const r = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(csrf), data: { role: "admin" } });
        expect(r.ok(), await r.text()).toBeTruthy();
        return u;
      };
      competitor = await promote("tplcomp");
      bystander = await promote("tplby");
      compete = await makeCompetition(sa, csrf, "tplcompete", { staff_compete: true });
      plain = await makeCompetition(sa, csrf, "tplplain");
      await enrol(sa, csrf, compete.id, [competitor.id]);
    } finally { await sa.dispose(); }
    const signIn = async (p, who) => {
      await loginViaApi(p, who.email, PARTICIPANT_PASS);
      await p.goto("/");
      await expect(p.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    };
    // The event's workspace, its header ⋯ menu opened as an organiser opens it.
    const menuOf = async (p, ev) => {
      await p.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
      await viewComp(p, ev.name);
      await expect(p.locator("#ws-record")).toBeVisible({ timeout: 15000 });
      expect(await p.evaluate((id) => !!((window.adminCompetitionsData || []).find((c) => c.id === id) || {}).competing, ev.id),
        `PRECONDITION: the model says whether this admin competes in ${ev.name}`).toBe(ev === compete && p === page);
      await p.locator("#ws-quick .ws-more-btn").click();
      const portal = p.locator("#kebab-portal");
      await expect(portal.locator('[data-action="comp-history"]'), "PRECONDITION: the ⋯ menu is open").toBeVisible();
      return portal;
    };

    await signIn(page, competitor);
    let portal = await menuOf(page, compete);
    await expect(portal.locator(".kebab-note"), "withheld WITH its reason").toContainText("You are competing in this event");
    await expect(portal.locator('[data-action="ws-save-template"]'), "no Save as template on the event they compete in").toHaveCount(0);
    await expect(portal.locator('[data-action="ws-clone"]'), "…as Clone is withheld").toHaveCount(0);
    await page.keyboard.press("Escape");

    portal = await menuOf(page, plain);
    await expect(portal.locator('[data-action="ws-save-template"]'), "CONTROL: offered on an event they do not compete in").toBeVisible();
    await expect(portal.locator(".kebab-note"), "…with no competing note").toHaveCount(0);

    const ctx2 = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx2.newPage();
      await signIn(p2, bystander);
      const portal2 = await menuOf(p2, compete);
      await expect(portal2.locator('[data-action="ws-save-template"]'), "CONTROL: a non-competing admin is offered it on the same event").toBeVisible();
      await expect(portal2.locator(".kebab-note")).toHaveCount(0);
    } finally { await ctx2.close(); }
  });
});

// SWEEP #63 (operator ruling, 23 Nov 2026): a challenge held by an event you
// compete in cannot be put into a template. The picker shows it with the reason
// and no Add button (nor does Add all count it); a non-competing admin is offered
// it (CONTROL). The save refuses it too (tests/event-clone-templates.api.spec.js).
test.describe("Templates — a competitor's challenges", () => {
  // A challenge held by an event the admin at the keyboard competes in (sweep
  // #63): the template picker offers no Add for it, Add all leaves it out, and the
  // New event form from a template marks it "Left out" and does not count it.
  // CONTROL each time: an admin who does not compete there.
  async function competitorFixture(label) {
    const { makeTask, assignTask } = require("./event-admin-helpers");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const tag = `${label}${Date.now().toString(36)}`;
    try {
      const promote = async (who) => {
        const u = await makeParticipant(sa, csrf, `${label}${who}`);
        const r = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(csrf), data: { role: "admin" } });
        expect(r.ok(), await r.text()).toBeTruthy();
        return u;
      };
      const competitor = await promote("comp");
      const bystander = await promote("by");
      const author = await promote("auth");
      const ev = await makeCompetition(sa, csrf, `${label}compete`, { staff_compete: true });
      const al = await apiLogin(author.email, PARTICIPANT_PASS);
      let held, free, free2;
      try {
        held = await makeTask(al.api, al.csrf, `${label}-held`, { answer_sealed: true, correct_answer: "k" });
        free = await makeTask(al.api, al.csrf, `${label}-free`, { answer_sealed: true, correct_answer: "k" });
        free2 = await makeTask(al.api, al.csrf, `${label}-free2`, { answer_sealed: true, correct_answer: "k" });
        // A sealed challenge's tags are its author's to change.
        for (const t of [held, free, free2]) {
          const r = await al.api.post(`/api/admin/tasks/${t.id}/tags`, { headers: H(al.csrf), data: { tag } });
          expect(r.ok(), await r.text()).toBeTruthy();
        }
      } finally { await al.api.dispose(); }
      await assignTask(sa, csrf, held.id, [ev.id]);
      await enrol(sa, csrf, ev.id, [competitor.id]);
      return { sa, csrf, tag, competitor, bystander, ev, held, free, free2 };
    } catch (e) { await sa.dispose(); throw e; }
  }

  test("the picker shows a challenge of an event you compete in with the reason and offers no Add for it, and Add all leaves it out; another admin may add it", async ({ page, browser }) => {
    const f = await competitorFixture("c63ui");
    await f.sa.dispose();
    const pick = async (p, who) => {
      await loginViaApi(p, who.email, PARTICIPANT_PASS);
      await p.goto("/");
      await expect(p.locator("#admin-page")).toBeVisible({ timeout: 20000 });
      await openTemplates(p);
      await p.locator("#tpl-new-btn").click();
      const ed = p.locator("#tpl-editor");
      await expect(ed).toBeVisible();
      await ed.locator("#tpl-ed-task-search").fill(f.tag);
      const rows = ed.locator("#tpl-ed-task-results li");
      await expect(rows, "PRECONDITION: the three challenges are found").toHaveCount(3);
      return { ed, rows };
    };
    const { ed, rows } = await pick(page, f.competitor);
    const heldRow = rows.filter({ hasText: f.held.title });
    await expect(heldRow, "the reason, naming the event").toContainText(`you compete in “${f.ev.name}”`);
    await expect(heldRow.locator('[data-op="add"]'), "no Add for it").toHaveCount(0);
    await expect(rows.filter({ hasText: f.free.title }).locator('[data-op="add"]'), "CONTROL: the others are addable").toHaveCount(1);
    // Add all counts the addable rows only, and adds only them.
    const addAll = ed.locator("#tpl-ed-task-addall");
    await expect(addAll).toBeVisible();
    await expect(addAll).toHaveText("Add all 2 shown");
    await addAll.click();
    await expect(ed.locator("#tpl-ed-tasks .tpl-ed-task")).toHaveCount(2);
    await expect(ed.locator("#tpl-ed-tasks")).toContainText(f.free.title);
    await expect(ed.locator("#tpl-ed-tasks")).toContainText(f.free2.title);
    await expect(ed.locator("#tpl-ed-tasks"), "the competing challenge was not added").not.toContainText(f.held.title);

    const ctx2 = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx2.newPage();
      const other = await pick(p2, f.bystander);
      await expect(other.rows.filter({ hasText: f.held.title }).locator('[data-op="add"]'), "CONTROL: a non-competing admin may add it").toHaveCount(1);
      await expect(other.rows.filter({ hasText: f.held.title })).not.toContainText("you compete in");
      await expect(other.ed.locator("#tpl-ed-task-addall"), "CONTROL: and Add all counts all three").toHaveText("Add all 3 shown");
    } finally { await ctx2.close(); }
  });

  test("the New event form from a template marks a challenge of an event you compete in as left out, unticked, and does not count it as coming from the template", async ({ page, browser }) => {
    const f = await competitorFixture("c63nf");
    const tplName = `C63 form ${Date.now().toString(36)}`;
    try {
      const r = await f.sa.post("/api/admin/event-templates", { headers: H(f.csrf), data: {
        name: tplName, description: "", event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [f.held.id, f.free.id],
      } });
      expect(r.ok(), `template: ${r.status()} ${await r.text()}`).toBeTruthy();
    } finally { await f.sa.dispose(); }
    const openForm = async (p, who) => {
      await loginViaApi(p, who.email, PARTICIPANT_PASS);
      await p.goto("/");
      await expect(p.locator("#admin-page")).toBeVisible({ timeout: 20000 });
      await openTemplates(p);
      const tplRow = p.locator("#tpl-list .tpl-row").filter({ has: p.locator("button.card-open", { hasText: tplName }) });
      await tplRow.locator("button.card-open").click();
      const form = p.locator("#comp-form-overlay");
      await expect(form.locator("#comp-name")).toBeVisible({ timeout: 10000 });
      const row = (t) => form.locator("#comp-ch-list .picker-row", { hasText: t.title });
      await expect(row(f.free), "PRECONDITION: the library has loaded").toBeVisible({ timeout: 15000 });
      return { form, row };
    };
    const { form, row } = await openForm(page, f.competitor);
    await expect(row(f.held)).toContainText("Left out: you compete in an event that holds it");
    await expect(row(f.held).locator('input[type="checkbox"]'), "not ticked").not.toBeChecked();
    await expect(row(f.free)).toContainText("From the template");
    await expect(row(f.free).locator('input[type="checkbox"]')).toBeChecked();
    await expect(form.locator("#comp-ch-count"), "the count does not promise it").toContainText("0 ticked (plus 1 from the template; 1 left out)");

    const ctx2 = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx2.newPage();
      const other = await openForm(p2, f.bystander);
      await expect(other.row(f.held), "CONTROL: a non-competing admin carries it").toContainText("From the template");
      await expect(other.row(f.held).locator('input[type="checkbox"]')).toBeChecked();
      await expect(other.form.locator("#comp-ch-count")).toContainText("0 ticked (plus 2 from the template)");
    } finally { await ctx2.close(); }
  });
});
