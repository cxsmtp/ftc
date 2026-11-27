// @ts-check
//
// THE EVENT FORM'S SECONDARY AND FAILURE PATHS, each driven through the real
// controls and read back by value (the happy paths live in
// create-form-challenges.spec.js and new-event-page-ui.spec.js).
//
//   * A template create whose settings PUT is refused stays the CREATE that
//     made the event: "Finish creating" sends the settings to that event, then
//     the ticked challenges and the Checkmarx One group, and never spawns twice.
//     A refusal that carries a list keeps its modal. When the save's ANSWER is
//     lost after it landed, the next press finishes on the token that save
//     produced, and never overwrites a change someone else made meanwhile.
//   * Tick all shown and Clear ticks act on what is listed; a ticked challenge
//     the server refuses is named and the rest are added; a staff-compete
//     create's refusal list reaches its modal.
//   * The template + staff compete + qualifying pre-check stops before anything
//     is made, and the create route refuses the same pair by name.
//   * "Create and pick challenges" opens the picker on the new event.
//   * A template's "one board across sessions" survives the PUT after its spawn.
//   * A Program's create confirmation names its deadline and how long it is open.
//   * A clone's message names what it did not carry over, and its dialog says
//     beforehand that an event with its own Checkmarx One key gives a copy with
//     accounts off; Save as template's dialog and message say the same of the
//     template.
//
// Every fixture is the test's own and is written through the API before the
// browser signs in (the built-in superadmin holds one session).
const { test, expect } = require("./isolated-test");
const { adminLogin, openCompCreateForm, openCompAdvanced, viewComp, pickFormKind } = require("./ui-admin-helpers");
const { apiLogin, BASE, TEST_DB_PATH, PARTICIPANT_PASS } = require("./helpers");
const { H, makeTask, makeParticipant } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const uniq = (p) => `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ro = () => new Database(TEST_DB_PATH, { readonly: true });
const dbAll = (sql, ...a) => { const db = ro(); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const dbGet = (sql, ...a) => { const db = ro(); try { return db.prepare(sql).get(...a); } finally { db.close(); } };
// The events holding a challenge: itself, or (a bank question) the event's own copy
// of it, which is what a tick puts in (lib/event-copies.js).
const eventsOfTask = (taskId) => dbAll("SELECT ct.competition_id FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE t.id=? OR (t.copied_from_task_id=? AND t.owner_competition_id=ct.competition_id)", taskId, taskId).map((r) => r.competition_id);
const eventsNamed = (name) => dbAll("SELECT id FROM competitions WHERE name=?", name).map((r) => r.id);
const dateIn = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

async function makeTemplate(sa, csrf, body) {
  const r = await sa.post("/api/admin/event-templates", { headers: H(csrf), data: { description: "", ...body } });
  expect(r.ok(), `template: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).template;
}
async function openTemplateForm(page, tplName) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
  await page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: tplName }) })
    .locator("button.card-open").click();
  const form = page.locator("#comp-form-overlay");
  await expect(form.locator("#comp-name")).toBeVisible({ timeout: 15000 });
  return form;
}
async function tick(form, title) {
  await form.locator("#comp-ch-search").fill(title);
  await form.locator("#comp-ch-list .picker-row", { hasText: title }).locator('input[type="checkbox"]').check();
}
/** Press Save and answer the confirmation, asserting it is the one expected. */
async function saveAndConfirm(page, titleRe) {
  await page.locator('#comp-form-overlay [data-action="comp-save"]').click();
  const modal = page.locator("#modal-overlay.open");
  await expect(modal.locator("#modal-title")).toHaveText(titleRe, { timeout: 10000 });
  await page.locator("#modal-confirm-btn").click();
}

test.describe("A template create whose settings save is refused", () => {
  test("finishes the SAME event: the settings, the ticks and the Checkmarx One group all land, and nothing spawns twice", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Finish tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    let inTpl, t1, t2;
    try {
      inTpl = await makeTask(sa, csrf, "fin-in");
      t1 = await makeTask(sa, csrf, "fin-one");
      t2 = await makeTask(sa, csrf, "fin-two");
      await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [inTpl.id] });
    } finally { await sa.dispose(); }

    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Finished from tpl");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    await tick(form, t1.title);
    await tick(form, t2.title);
    await expect(form.locator("#comp-ch-count")).toContainText("2 ticked");
    await openCompAdvanced(page);
    const group = `grp-${Date.now().toString(36)}`;
    await form.locator("#comp-cxone-group").fill(group);
    // "Staff can compete" on an event holding an UNSEALED challenge: the spawn
    // makes the event, and the PUT applying this form is refused with a list.
    await form.locator("#comp-staff-compete").check();
    await expect(form.locator("#comp-add-qualifying"), "PRECONDITION: a Competition's qualifying seed is off").not.toBeChecked();

    const seen = { spawn: 0, put: 0, assign: [], cxone: 0 };
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (r.method() === "POST" && /\/api\/admin\/event-templates\/[^/]+\/spawn$/.test(p)) seen.spawn++;
      if (r.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+$/.test(p)) seen.put++;
      if (r.method() === "POST" && /^\/api\/admin\/tasks\/[^/]+\/competitions$/.test(p)) seen.assign.push(p);
      if (r.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+\/cxone$/.test(p)) seen.cxone++;
    });
    await saveAndConfirm(page, /^Create /);

    // The refusal keeps its list, says the event exists, and how to finish it.
    const modal = page.locator("#modal-overlay.open");
    await expect(modal.locator("#modal-title"), "a refusal list keeps its modal").toHaveText("Seal these challenges first", { timeout: 15000 });
    await expect(modal).toContainText(inTpl.title);
    await expect(modal).toContainText("was created from the template, but these settings were not saved");
    await expect(modal).toContainText("Finish creating");
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);

    // Still the create that made the event, never an edit of it.
    await expect(form.locator('[data-action="comp-save"]')).toHaveText("Finish creating");
    await expect(form.locator("#comp-edit-id"), "the form is still a create").toHaveValue("");
    await expect(form.locator('[data-action="comp-save-and-pick-tasks"]'), "no door that would create again").toHaveCount(0);
    const made = eventsNamed(evName);
    expect(made.length, "PRECONDITION: the spawn made the event").toBe(1);
    const id = made[0];
    expect(seen.spawn).toBe(1);
    expect(eventsOfTask(t1.id), "PRECONDITION: nothing ticked was sent with the refused save").not.toContain(id);
    expect(dbGet("SELECT cxone_group_name g FROM competitions WHERE id=?", id).g, "PRECONDITION: nor the group").toBeNull();

    // Fix the named problem and finish.
    await form.locator("#comp-staff-compete").uncheck();
    await saveAndConfirm(page, /^Finish creating /);
    await expect(form, "the finished create closes the form").toHaveCount(0, { timeout: 20000 });

    expect(seen.spawn, "nothing spawned twice").toBe(1);
    expect(eventsNamed(evName), "one event, the one the first press made").toEqual([id]);
    expect(seen.put, "two saves of the same event's settings: the refused one and the finishing one").toBe(2);
    await expect.poll(() => eventsOfTask(t1.id), { timeout: 10000, message: "the first tick was added" }).toContain(id);
    await expect.poll(() => eventsOfTask(t2.id), { timeout: 10000, message: "the second tick was added" }).toContain(id);
    expect(eventsOfTask(inTpl.id), "CONTROL: the template's own challenge came with the spawn").toContain(id);
    expect(seen.assign.some((p) => p.includes(inTpl.id)), "the template's challenge is not sent again").toBe(false);
    expect(seen.cxone, "the Checkmarx One override is saved once").toBe(1);
    expect(dbGet("SELECT cxone_group_name g, staff_compete s FROM competitions WHERE id=?", id)).toEqual({ g: group, s: 0 });
  });

  // The settings save never reaches the server (the network drops it): the
  // event exists all the same, so the form says so and becomes the same
  // "Finish creating" create; a second press sends the settings, never a
  // second spawn (which would be refused as a duplicate name).
  test("a settings save the network lost is finished by the next press, on the same event", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Lost tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] }); }
    finally { await sa.dispose(); }

    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Lost save");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    await form.locator("#comp-attempt-cap").fill("3");   // a setting only the save carries
    let spawns = 0, dropped = 0;
    page.on("request", (r) => { if (r.method() === "POST" && /\/spawn$/.test(new URL(r.url()).pathname)) spawns++; });
    // Drop the FIRST settings save only.
    await page.route(/\/api\/admin\/competitions\/[^/?]+$/, async (route) => {
      if (route.request().method() === "PUT" && dropped === 0) { dropped++; return route.abort("failed"); }
      return route.continue();
    });
    await saveAndConfirm(page, /^Create /);
    await expect(page.locator("#toast-stack"), "the toast says the event exists, that the settings may not be saved, and how to finish it")
      .toContainText("so they may not have been saved. Press Finish creating", { timeout: 15000 });
    await expect(form.locator('[data-action="comp-save"]')).toHaveText("Finish creating");
    expect(dropped, "PRECONDITION: the first save was dropped").toBe(1);
    expect(eventsNamed(evName).length, "PRECONDITION: the spawn made the event").toBe(1);
    const id = eventsNamed(evName)[0];
    expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "PRECONDITION: the dropped save carried the setting").toBeNull();

    await saveAndConfirm(page, /^Finish creating /);
    await expect(form, "the finished create closes the form").toHaveCount(0, { timeout: 20000 });
    expect(spawns, "nothing spawned twice").toBe(1);
    expect(eventsNamed(evName), "one event, the one the first press made").toEqual([id]);
    expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "the second press saved the settings to it").toBe(3);
  });
});

// THE REQUEST LANDED, BUT ITS ANSWER WAS LOST (route.fetch() sends it to the
// server, route.abort() keeps the answer from the browser). No message may then
// say nothing was saved or made. For a template create's settings save, the
// event holds the settings and its token has moved past the one the form sent:
// the next press re-reads the event, finds its own write there, takes that
// token and finishes, never refused as a conflict. A change SOMEONE ELSE made
// meanwhile is the negative control: it is never overwritten.
test.describe("An event create whose answer is lost after it landed", () => {
  /** The first settings save reaches the server; its answer never reaches the browser. */
  async function loseFirstAnswer(page, net) {
    await page.route(/\/api\/admin\/competitions\/[^/?]+$/, async (route) => {
      if (route.request().method() === "PUT" && net.landed.length === 0) {
        const resp = await route.fetch();
        net.landed.push(resp.status());
        return route.abort("failed");
      }
      return route.continue();
    });
  }
  /** Spawns, settings saves (sent / answered), tick assigns and Checkmarx One saves, by value. */
  function watchNet(page) {
    const net = { spawn: 0, sent: 0, answered: [], landed: [], assign: [], cxone: 0 };
    const settings = (p) => /^\/api\/admin\/competitions\/[^/]+$/.test(p);
    const onReq = (r) => {
      const p = new URL(r.url()).pathname;
      if (r.method() === "POST" && /\/api\/admin\/event-templates\/[^/]+\/spawn$/.test(p)) net.spawn++;
      if (r.method() === "PUT" && settings(p)) net.sent++;
      if (r.method() === "POST" && /^\/api\/admin\/tasks\/[^/]+\/competitions$/.test(p)) net.assign.push(p);
      if (r.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+\/cxone$/.test(p)) net.cxone++;
    };
    const onResp = (r) => {
      if (r.request().method() === "PUT" && settings(new URL(r.url()).pathname)) net.answered.push(r.status());
    };
    page.on("request", onReq);
    page.on("response", onResp);
    net.off = () => { page.off("request", onReq); page.off("response", onResp); };
    return net;
  }
  const lostToast = "so they may not have been saved. Press Finish creating";

  test("the next press finishes it without saving the settings twice, and the ticks and the Checkmarx One group land", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Landed tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    let t1;
    try {
      t1 = await makeTask(sa, csrf, "landed-one");
      await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] });
    } finally { await sa.dispose(); }

    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Landed save");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    await form.locator("#comp-attempt-cap").fill("3");
    await tick(form, t1.title);
    await openCompAdvanced(page);
    const group = `grp-${Date.now().toString(36)}`;
    await form.locator("#comp-cxone-group").fill(group);
    const net = watchNet(page);
    await loseFirstAnswer(page, net);

    await saveAndConfirm(page, /^Create /);
    await expect(page.locator("#toast-stack"), "the toast says they may not be saved, never that they were not")
      .toContainText(lostToast, { timeout: 15000 });
    await expect(form.locator('[data-action="comp-save"]')).toHaveText("Finish creating");
    expect(net.landed, "PRECONDITION: the save reached the server and was accepted").toEqual([200]);
    expect(net.answered, "PRECONDITION: the browser never heard its answer").toEqual([]);
    const made = eventsNamed(evName);
    expect(made.length, "PRECONDITION: the spawn made the event").toBe(1);
    const id = made[0];
    expect(dbGet("SELECT attempt_cap a, cxone_group_name g FROM competitions WHERE id=?", id),
      "PRECONDITION: the settings are stored; the group, sent after them, is not").toEqual({ a: 3, g: null });
    expect(eventsOfTask(t1.id), "PRECONDITION: nor is the tick").not.toContain(id);

    await saveAndConfirm(page, /^Finish creating /);
    await expect(form, "the finished create closes the form").toHaveCount(0, { timeout: 20000 });
    expect(net.spawn, "nothing spawned twice").toBe(1);
    expect(net.sent, "the settings were not sent again: the event already held them").toBe(1);
    expect(net.answered, "so no save was answered at all, and none refused as a conflict").toEqual([]);
    await expect.poll(() => eventsOfTask(t1.id), { timeout: 10000, message: "the tick was added" }).toContain(id);
    expect(net.cxone, "the Checkmarx One group is saved once").toBe(1);
    expect(dbGet("SELECT attempt_cap a, cxone_group_name g FROM competitions WHERE id=?", id)).toEqual({ a: 3, g: group });
    expect(eventsNamed(evName), "one event, the one the first press made").toEqual([id]);
    await expect(page.locator("#toast-stack")).toContainText("1 ticked challenge added");
  });

  test("a value changed since is sent with the token that lost save produced, for a Booth Event and a Program", async ({ page }) => {
    test.setTimeout(150_000);
    const kinds = [{ kind: "booth", minutes: 60 }, { kind: "program", minutes: 30 * 1440 }];
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      for (const k of kinds) {
        k.tpl = uniq(`Landed ${k.kind} tpl`);
        await makeTemplate(sa, csrf, { name: k.tpl, event_kind: k.kind, settings: { duration_minutes: k.minutes }, task_ids: [] });
      }
    } finally { await sa.dispose(); }

    await adminLogin(page);
    for (const k of kinds) {
      const form = await openTemplateForm(page, k.tpl);
      const evName = uniq(`Changed ${k.kind}`);
      await form.locator("#comp-name").fill(evName);
      await form.locator("#comp-date").fill(dateIn(3));
      if (k.kind === "program") {
        await form.locator("#comp-deadline-date").fill(dateIn(12));
        await form.locator("#comp-deadline-time").fill("18:00");
      }
      await form.locator("#comp-attempt-cap").fill("3");
      const net = watchNet(page);
      await loseFirstAnswer(page, net);
      await saveAndConfirm(page, /^Create /);
      await expect(page.locator("#toast-stack")).toContainText(lostToast, { timeout: 15000 });
      expect(net.landed, `PRECONDITION (${k.kind}): the save landed`).toEqual([200]);
      const id = eventsNamed(evName)[0];
      expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, `PRECONDITION (${k.kind}): it was stored`).toBe(3);

      await form.locator("#comp-attempt-cap").fill("5");
      await saveAndConfirm(page, /^Finish creating /);
      await expect(form, `${k.kind}: the finished create closes the form`).toHaveCount(0, { timeout: 20000 });
      expect(net.answered, `${k.kind}: the changed settings were sent once more and accepted, not refused as a conflict`).toEqual([200]);
      expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, `${k.kind}: the change landed`).toBe(5);
      expect(eventsNamed(evName), `${k.kind}: one event`).toEqual([id]);
      expect(net.spawn, `${k.kind}: nothing spawned twice`).toBe(1);
      await page.unrouteAll({ behavior: "wait" });
      net.off();
    }
  });

  test("two lost answers in a row: a save that never landed does not hide the one that did", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Twice lost tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] }); }
    finally { await sa.dispose(); }

    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Twice lost");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    await form.locator("#comp-attempt-cap").fill("3");
    const net = watchNet(page);
    // The first two settings saves reach the server and lose their answers; the
    // second press's re-read of the events list fails too, so that press sends
    // the token the form had before its first save landed.
    let failList = false;
    await page.route(/\/api\/admin\/competitions(\/[^/?]+)?$/, async (route) => {
      const rq = route.request();
      if (rq.method() === "GET" && new URL(rq.url()).pathname === "/api/admin/competitions" && failList) return route.abort("failed");
      if (rq.method() === "PUT" && /\/api\/admin\/competitions\/[^/?]+$/.test(rq.url()) && net.landed.length < 2) {
        net.landed.push((await route.fetch()).status());
        return route.abort("failed");
      }
      return route.continue();
    });

    await saveAndConfirm(page, /^Create /);
    await expect(page.locator("#toast-stack")).toContainText(lostToast, { timeout: 15000 });
    const id = eventsNamed(evName)[0];
    expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "PRECONDITION: the first save landed").toBe(3);

    await form.locator("#comp-attempt-cap").fill("5");
    failList = true;
    await saveAndConfirm(page, /^Finish creating /);
    await expect.poll(() => net.landed.length, { timeout: 15000, message: "the second save was sent" }).toBe(2);
    await expect(form.locator('[data-action="comp-save"]')).toHaveText("Finish creating");
    failList = false;
    expect(net.landed, "PRECONDITION: the second save, sent on the old token, was refused unseen").toEqual([200, 409]);
    expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "PRECONDITION: so it changed nothing").toBe(3);

    await saveAndConfirm(page, /^Finish creating /);
    await expect(form, "the third press finishes it").toHaveCount(0, { timeout: 20000 });
    expect(net.answered, "on the token the first save produced: accepted, not refused as a conflict").toEqual([200]);
    expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "the change landed").toBe(5);
    expect(net.spawn, "nothing spawned twice").toBe(1);
    await page.unrouteAll({ behavior: "wait" });
    net.off();
  });

  test("a change of type after the lost answer still finishes, on the token that save produced", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Retyped tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] }); }
    finally { await sa.dispose(); }

    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Retyped");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    await form.locator("#comp-attempt-cap").fill("3");
    const net = watchNet(page);
    await loseFirstAnswer(page, net);
    await saveAndConfirm(page, /^Create /);
    await expect(page.locator("#toast-stack")).toContainText(lostToast, { timeout: 15000 });
    expect(net.landed, "PRECONDITION: the save landed").toEqual([200]);
    const id = eventsNamed(evName)[0];
    expect(dbGet("SELECT attempt_cap a, event_kind k FROM competitions WHERE id=?", id), "PRECONDITION: it was stored").toEqual({ a: 3, k: "tournament" });

    // The form re-renders for the new type (the attempt cap typed differs from
    // the form as opened, so it asks first); it is still the same create.
    await pickFormKind(page, "booth");
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText(/^Change type to /, { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000 }).toBe("booth");
    const retyped = page.locator("#comp-form-overlay");
    await expect(retyped.locator('[data-action="comp-save"]'), "still the create that made the event").toHaveText("Finish creating");

    await saveAndConfirm(page, /^Finish creating /);
    await expect(retyped, "the finished create closes the form").toHaveCount(0, { timeout: 20000 });
    expect(net.answered, "accepted on the token the lost save produced, not refused as a conflict").toEqual([200]);
    expect(dbGet("SELECT event_kind k FROM competitions WHERE id=?", id).k, "the new type landed").toBe("booth");
    expect(net.spawn, "nothing spawned twice").toBe(1);
    expect(eventsNamed(evName)).toEqual([id]);
    await page.unrouteAll({ behavior: "wait" });
    net.off();
  });

  test("a spawn whose answer is lost says the event may have been made, never that it was not", async ({ page }) => {
    test.setTimeout(90_000);
    const tplName = uniq("Lost spawn tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] }); }
    finally { await sa.dispose(); }
    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Lost spawn");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    const net = watchNet(page);
    const spawned = [];
    await page.route(/\/api\/admin\/event-templates\/[^/]+\/spawn$/, async (route) => {
      spawned.push((await route.fetch()).status());
      return route.abort("failed");
    });
    await saveAndConfirm(page, /^Create /);
    const toasts = page.locator("#toast-stack");
    await expect(toasts).toContainText("so it may or may not have been made", { timeout: 15000 });
    expect(await toasts.innerText(), "never the claim it cannot know").not.toContain("Could not create the event");
    expect(spawned, "PRECONDITION: the spawn reached the server and was accepted").toEqual([200]);
    expect(eventsNamed(evName).length, "the event WAS made, which is why the message may not say otherwise").toBe(1);
    expect(net.sent, "nothing is sent to an event the form never heard of").toBe(0);
    await page.unrouteAll({ behavior: "wait" });
    net.off();
  });

  test("a blank create whose answer is lost says it may not have been saved, never that nothing was", async ({ page }) => {
    test.setTimeout(90_000);
    await adminLogin(page);
    await openCompCreateForm(page, "tournament", { advanced: false });
    const form = page.locator("#comp-form-overlay");
    const evName = uniq("Lost create");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    const created = [];
    await page.route(/\/api\/admin\/competitions$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      created.push((await route.fetch()).status());
      return route.abort("failed");
    });
    await saveAndConfirm(page, /^Create /);
    const toasts = page.locator("#toast-stack");
    await expect(toasts).toContainText("so this may not have been saved. Check the event in the Events list", { timeout: 15000 });
    expect(await toasts.innerText(), "never the claim it cannot know").not.toContain("nothing was saved");
    expect(created, "PRECONDITION: the create reached the server and was accepted").toEqual([200]);
    expect(eventsNamed(evName).length, "the event WAS made, which is why the message may not say otherwise").toBe(1);
    await page.unrouteAll({ behavior: "wait" });
  });

  test("a change someone else made meanwhile is never overwritten: the next press is refused as a conflict", async ({ page }) => {
    test.setTimeout(120_000);
    const tplName = uniq("Conflict tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    let t1, other;
    try {
      t1 = await makeTask(sa, csrf, "conflict-one");
      await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] });
      other = await makeParticipant(sa, csrf, "other-admin");
      const pr = await sa.post(`/api/admin/participants/${other.id}/role`, { headers: H(csrf), data: { role: "admin" } });
      expect(pr.ok(), await pr.text()).toBeTruthy();
    } finally { await sa.dispose(); }
    const al = await apiLogin(other.email, PARTICIPANT_PASS);
    try {
      await adminLogin(page);
      const form = await openTemplateForm(page, tplName);
      const evName = uniq("Changed meanwhile");
      await form.locator("#comp-name").fill(evName);
      await form.locator("#comp-date").fill(dateIn(3));
      await form.locator("#comp-attempt-cap").fill("3");
      await tick(form, t1.title);
      const net = watchNet(page);
      await loseFirstAnswer(page, net);
      await saveAndConfirm(page, /^Create /);
      await expect(page.locator("#toast-stack")).toContainText(lostToast, { timeout: 15000 });
      expect(net.landed, "PRECONDITION: the save landed").toEqual([200]);
      const id = eventsNamed(evName)[0];
      expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "PRECONDITION: it was stored").toBe(3);

      // Another admin changes a setting this form sends.
      const pu = await al.api.put(`/api/admin/competitions/${id}`, { headers: H(al.csrf), data: { attempt_cap: 7 } });
      expect(pu.status(), await pu.text()).toBe(200);

      await saveAndConfirm(page, /^Finish creating /);
      await expect(page.locator("#toast-stack"), "the conflict is named, with where to look")
        .toContainText("the event was changed after it was created", { timeout: 15000 });
      expect(net.answered, "the press was refused as a conflict").toEqual([409]);
      expect(dbGet("SELECT attempt_cap a FROM competitions WHERE id=?", id).a, "their change stands").toBe(7);
      expect(eventsOfTask(t1.id), "nothing ticked was added behind a refused save").not.toContain(id);
      await expect(form, "the form stays open, the admin's values on it").toBeVisible();
      expect(net.spawn, "nothing spawned twice").toBe(1);
      expect(eventsNamed(evName)).toEqual([id]);
    } finally { await al.api.dispose(); }
  });
});

test.describe("The create form's Challenges section", () => {
  test("Tick all shown and Clear ticks act on what is listed; a ticked challenge the server refuses is named and the rest are added", async ({ page }) => {
    test.setTimeout(120_000);
    const stem = `pf${Date.now().toString(36)}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ok, file, decoy;
    try {
      ok = await makeTask(sa, csrf, `${stem} ok`);
      // A Booth Event takes no file answer (lib/challenge-fit.js): that tick is
      // refused once the event exists.
      file = await makeTask(sa, csrf, `${stem} file`, { answer_type: "file", correct_answer: "flag" });
      decoy = await makeTask(sa, csrf, "pf-decoy");
    } finally { await sa.dispose(); }

    await adminLogin(page);
    await openCompCreateForm(page, "booth", { advanced: false });
    const form = page.locator("#comp-form-overlay");
    const evName = uniq("Partly ticked");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(2));
    await form.locator("#comp-ch-search").fill(stem);
    const rows = form.locator("#comp-ch-list .picker-row");
    await expect(rows, "PRECONDITION: the two matches are listed").toHaveCount(2, { timeout: 15000 });
    const count = form.locator("#comp-ch-count");
    await form.locator("#comp-ch-all").click();
    await expect(count).toContainText("2 ticked");
    await form.locator("#comp-ch-none").click();
    await expect(count).toContainText("0 ticked");
    await expect(rows.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await form.locator("#comp-ch-all").click();
    await expect(count).toContainText("2 ticked");
    await expect(rows.locator('input[type="checkbox"]:checked')).toHaveCount(2);

    await saveAndConfirm(page, /^Create /);
    await expect(form).toHaveCount(0, { timeout: 20000 });
    const id = eventsNamed(evName)[0];
    expect(id, "the event was made").toBeTruthy();
    const toast = page.locator("#toast-stack");
    await expect(toast, "the partial result is said").toContainText("Event created with 1 of 2 ticked challenges. 1 could not be added", { timeout: 15000 });
    await expect(toast, "the refused challenge is named").toContainText(file.title);
    await expect.poll(() => eventsOfTask(ok.id), { timeout: 10000 }).toContain(id);
    expect(eventsOfTask(file.id), "the refused tick is not on the event").not.toContain(id);
    expect(eventsOfTask(decoy.id), "CONTROL: an unlisted challenge is not on the event").not.toContain(id);
  });

  test("a staff-compete create lists the challenges it refused in their own dialog", async ({ page }) => {
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    let open;
    try { open = await makeTask(sa, csrf, "sc-unsealed"); } finally { await sa.dispose(); }

    await adminLogin(page);
    await openCompCreateForm(page, "tournament");
    const form = page.locator("#comp-form-overlay");
    const evName = uniq("Compete tick");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(2));
    await form.locator("#comp-staff-compete").check();
    await tick(form, open.title);
    await saveAndConfirm(page, /^Create /);
    const modal = page.locator("#modal-overlay.open");
    await expect(modal.locator("#modal-title")).toHaveText("Some challenges were not added", { timeout: 20000 });
    await expect(modal, "the refused challenge is listed").toContainText(open.title);
    await expect(modal).toContainText(evName);
    const id = eventsNamed(evName)[0];
    expect(id, "the event was made").toBeTruthy();
    expect(dbGet("SELECT staff_compete s FROM competitions WHERE id=?", id).s, "PRECONDITION: staff compete there").toBe(1);
    expect(eventsOfTask(open.id), "the unsealed challenge was refused").not.toContain(id);
    await expect(page.locator("#toast-stack")).toContainText("Event created with 0 of 1 ticked challenge. 1 could not be added");
  });

  test("Create and pick challenges opens the picker on the event it just made", async ({ page }) => {
    test.setTimeout(90_000);
    await adminLogin(page);
    await openCompCreateForm(page, "tournament", { advanced: false });
    const form = page.locator("#comp-form-overlay");
    const evName = uniq("Then pick");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(2));
    await form.locator('[data-action="comp-save-and-pick-tasks"]').click();
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText(/^Create /, { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    const picker = page.locator("#task-picker-overlay");
    await expect(picker).toBeVisible({ timeout: 20000 });
    const id = eventsNamed(evName)[0];
    expect(id, "the event was made").toBeTruthy();
    await expect(picker.locator("#task-picker-title")).toHaveText(`Challenges in ${evName}`);
    await expect(picker.locator("#task-picker-save"), "the picker saves to the new event").toHaveAttribute("data-comp-id", id);
  });
});

test.describe("Staff compete and the built-in qualifying questions", () => {
  test("a template create with both ticked stops before anything is made", async ({ page }) => {
    test.setTimeout(90_000);
    const tplName = uniq("Pre tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await makeTemplate(sa, csrf, { name: tplName, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] }); }
    finally { await sa.dispose(); }

    await adminLogin(page);
    const form = await openTemplateForm(page, tplName);
    const evName = uniq("Never made");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(2));
    await openCompAdvanced(page);
    await form.locator("#comp-staff-compete").check();
    await form.locator("#comp-add-qualifying").check();
    let spawned = 0;
    page.on("request", (r) => { if (r.method() === "POST" && /\/spawn$/.test(new URL(r.url()).pathname)) spawned++; });
    await form.locator('[data-action="comp-save"]').click();
    await expect(page.locator("#toast-stack"), "the pair is refused by name").toContainText("holds sealed challenges only", { timeout: 10000 });
    await expect(page.locator("#modal-overlay.open"), "no confirmation: nothing would be made").toHaveCount(0);
    expect(spawned, "the template was not spawned").toBe(0);
    expect(eventsNamed(evName)).toEqual([]);
    await expect(form, "the form stays open to fix").toBeVisible();
    // CONTROL: untick one of the two and the same form creates the event.
    await form.locator("#comp-add-qualifying").uncheck();
    await saveAndConfirm(page, /^Create /);
    await expect(form).toHaveCount(0, { timeout: 20000 });
    expect(eventsNamed(evName).length).toBe(1);
    expect(spawned).toBe(1);
  });

  test("the create route refuses add_qualifying that is not a boolean, and on an event where staff compete", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const create = (extra) => sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: uniq("AddQ"), event_kind: "tournament", start_time: new Date(Date.now() + 864e5).toISOString(), duration_minutes: 60, ...extra } });
      const quals = (id) => dbAll("SELECT ct.task_id FROM competition_tasks ct WHERE ct.competition_id=? AND EXISTS (SELECT 1 FROM task_tags t WHERE t.task_id=ct.task_id AND t.tag LIKE 'qualifying:%')", id).length;
      const bad = await create({ add_qualifying: "yes" });
      expect(bad.status(), await bad.text()).toBe(400);
      expect((await bad.json()).code).toBe("add_qualifying_invalid");
      const compete = await create({ staff_compete: true, add_qualifying: true });
      expect(compete.status(), await compete.text()).toBe(400);
      const cb = await compete.json();
      expect(cb.code).toBe("qualifying_in_compete_event");
      // The reason is one that can be acted on: a qualifying question can never be
      // sealed, so such an event asks none (no "add your own sealed ones" advice,
      // which every door refuses).
      expect(cb.error, "the refusal says why").toContain("a qualifying question (an Any answer question) can never be sealed");
      expect(cb.error, "…and what to do").toContain("Leave out the qualifying questions, or turn off staff competing");
      expect(cb.error).not.toMatch(/add your own sealed/i);
      // CONTROLS: each half alone is accepted, and the tick does what it says.
      const competeOnly = await create({ staff_compete: true, add_qualifying: false });
      expect(competeOnly.status(), await competeOnly.text()).toBe(200);
      expect(quals((await competeOnly.json()).competition.id)).toBe(0);
      const qOnly = await create({ add_qualifying: true });
      expect(qOnly.status(), await qOnly.text()).toBe(200);
      expect(quals((await qOnly.json()).competition.id), "the four built-in questions").toBe(4);
    } finally { await sa.dispose(); }
  });
});

test.describe("A template seeds the form", () => {
  test("its 'one board across sessions' is the mode selected, and the save after its spawn keeps it", async ({ page }) => {
    test.setTimeout(120_000);
    const globalTpl = uniq("Global board tpl");
    const plainTpl = uniq("Plain board tpl");
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      await makeTemplate(sa, csrf, { name: globalTpl, event_kind: "tournament", settings: { duration_minutes: 60, leaderboard_mode: "global" }, task_ids: [] });
      await makeTemplate(sa, csrf, { name: plainTpl, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [] });
    } finally { await sa.dispose(); }

    await adminLogin(page);
    // CONTROL first: a template that leaves the mode out opens per session.
    let form = await openTemplateForm(page, plainTpl);
    await expect(form.locator("#comp-lb-mode")).toHaveValue("per_slot");
    await form.locator('[data-action="overlay-close"]').first().click();
    await expect(form).toHaveCount(0);

    form = await openTemplateForm(page, globalTpl);
    await expect(form.locator("#comp-lb-mode"), "the template's mode is the one selected").toHaveValue("global");
    const evName = uniq("Global board");
    await form.locator("#comp-name").fill(evName);
    await form.locator("#comp-date").fill(dateIn(3));
    let putBody = null;
    page.on("request", (r) => { if (r.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+$/.test(new URL(r.url()).pathname)) putBody = r.postDataJSON(); });
    await saveAndConfirm(page, /^Create /);
    await expect(form).toHaveCount(0, { timeout: 20000 });
    expect(putBody && putBody.leaderboard_mode, "the save after the spawn sends the template's mode").toBe("global");
    const id = eventsNamed(evName)[0];
    expect(dbGet("SELECT leaderboard_mode m FROM competitions WHERE id=?", id).m, "and the event keeps it").toBe("global");
  });
});

test.describe("The create confirmation", () => {
  test("a Program's names its deadline and how long it is open; a Competition's its end and duration", async ({ page }) => {
    test.setTimeout(90_000);
    await adminLogin(page);
    await openCompCreateForm(page, "program", { advanced: false });
    let form = page.locator("#comp-form-overlay");
    await form.locator("#comp-name").fill(uniq("Deadline summary"));
    // 4 days and 8 hours in a January three years out: no daylight-saving
    // change falls inside it in any zone, and it is always past the form's
    // two-year typo check, which therefore asks first.
    const year = new Date().getFullYear() + 3;
    await form.locator("#comp-date").fill(`${year}-01-10`);
    await form.locator("#comp-time").fill("10:00");
    await form.locator("#comp-deadline-date").fill(`${year}-01-14`);
    await form.locator("#comp-deadline-time").fill("18:00");
    await form.locator('[data-action="comp-save"]').click();
    let modal = page.locator("#modal-overlay.open");
    await expect(modal.locator("#modal-title"), "PRECONDITION: the two-year check").toHaveText("Confirm the deadline", { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(modal.locator("#modal-title")).toHaveText(/^Create Program/, { timeout: 10000 });
    const text = await modal.locator("#modal-body").innerText();
    expect(text, "the deadline is named").toMatch(/Deadline:\s*\S/);
    expect(text, "and how long it is open").toMatch(/Open for:\s*4d 8h/);
    expect(text, "no end equal to the start, no empty duration").not.toMatch(/Duration:/);
    await page.locator("#modal-cancel-btn").click();
    await form.locator('[data-action="overlay-close"]').first().click();
    await expect(form).toHaveCount(0);

    // CONTROL: a window kind still states its end and duration.
    await openCompCreateForm(page, "tournament", { advanced: false });
    form = page.locator("#comp-form-overlay");
    await form.locator("#comp-name").fill(uniq("Window summary"));
    await form.locator("#comp-date").fill(`${year}-01-10`);
    await form.locator("#comp-time").fill("10:00");
    await form.locator('[data-action="comp-save"]').click();
    modal = page.locator("#modal-overlay.open");
    await expect(modal.locator("#modal-title")).toHaveText(/^Create Competition/, { timeout: 10000 });
    await expect(modal).toContainText("End:");
    await expect(modal).toContainText("Duration:");
    await expect(modal).not.toContainText("Open for:");
    await page.locator("#modal-cancel-btn").click();
  });
});

test.describe("Clone, from the workspace", () => {
  test("the message names what was not carried over, and a plain clone says nothing of the kind", async ({ page }) => {
    test.setTimeout(120_000);
    const withIps = uniq("Venue event");
    const plain = uniq("Plain event");
    const withKey = uniq("Own key event");
    // A key the decoder accepts: an `iss` on an allowlisted IAM host.
    const fakeKey = `header.${Buffer.from(JSON.stringify({ iss: "https://iam.checkmarx.net/auth/realms/cxone_clone_ui" })).toString("base64url")}.signature`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      for (const [name, extra] of [[withIps, { trusted_network_ips: "203.0.113.7" }], [plain, {}], [withKey, {}]]) {
        const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
          name, event_kind: "tournament", start_time: new Date(Date.now() + 2 * 864e5).toISOString(), duration_minutes: 60, ...extra } });
        expect(r.ok(), `create ${name}: ${await r.text()}`).toBeTruthy();
        if (name === withKey) {
          const k = await sa.put(`/api/admin/competitions/${(await r.json()).competition.id}/cxone`, { headers: H(csrf), data: { cxone_api_key: fakeKey, cxone_group_name: "" } });
          expect(k.ok(), `own key: ${await k.text()}`).toBeTruthy();
        }
      }
    } finally { await sa.dispose(); }
    expect(dbGet("SELECT cxone_disabled d, cxone_api_key IS NOT NULL k FROM competitions WHERE name=?", withKey), "PRECONDITION: its own key, accounts on").toEqual({ d: 0, k: 1 });

    await adminLogin(page);
    // `beforeSubmit` reads the open dialog (the Checkmarx One note is said BEFORE the press).
    const cloneVia = async (name, beforeSubmit) => {
      await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
      await viewComp(page, name);
      await expect(page.locator("#ws-record")).toBeVisible({ timeout: 15000 });
      await page.locator("#ws-quick .ws-more-btn").click();
      await page.locator('#kebab-portal [data-action="ws-clone"]').click();
      const dlg = page.locator("#ws-clone-dialog");
      await expect(dlg).toBeVisible({ timeout: 10000 });
      const copyName = `${name} (copy)`;
      await expect(dlg.locator("#ws-clone-name")).toHaveValue(copyName);
      if (beforeSubmit) await beforeSubmit(dlg);
      await dlg.locator('button[type="submit"]').click();
      await expect(dlg).toHaveCount(0, { timeout: 15000 });
      return copyName;
    };
    const copy = await cloneVia(withIps, async (dlg) => {
      await expect(dlg.locator("[data-cxone-off-note]"), "CONTROL: an event on the platform's key says nothing about accounts").toHaveCount(0);
    });
    const toast = page.locator("#toast-stack");
    await expect(toast).toContainText("Not carried over: trusted network IPs", { timeout: 15000 });
    expect(dbGet("SELECT trusted_network_ips t FROM competitions WHERE name=?", copy).t, "PRECONDITION: the copy has none").toBeNull();
    expect(dbGet("SELECT trusted_network_ips t FROM competitions WHERE name=?", withIps).t, "PRECONDITION: the source had them").toBe("203.0.113.7");

    const copy2 = await cloneVia(plain);
    await expect(toast).toContainText(`Created “${copy2}”`, { timeout: 15000 });
    const last = toast.locator(".toast").filter({ hasText: `Created “${copy2}”` });
    await expect(last, "CONTROL: a plain clone names nothing it left behind").not.toContainText("Not carried over");

    // Operator ruling, 14 Nov 2026: a copy of an event that creates Checkmarx One
    // accounts with its own key has them OFF, and the dialog says so before the
    // press, the message after it.
    const copy3 = await cloneVia(withKey, async (dlg) => {
      await expect(dlg.locator("[data-cxone-off-note]"), "the dialog says it before the press").toContainText("Checkmarx One accounts: off in the copy");
    });
    const keyed = toast.locator(".toast").filter({ hasText: `Created “${copy3}”` });
    await expect(keyed, "the message says it after").toContainText("Not carried over: Checkmarx One accounts (turned off", { timeout: 15000 });
    expect(dbGet("SELECT cxone_disabled d, cxone_api_key k FROM competitions WHERE name=?", copy3), "the copy creates no accounts, and holds no key").toEqual({ d: 1, k: null });
  });
});

// Operator ruling, 14 Nov 2026: a template never holds a Checkmarx One key, so an
// event that creates accounts with its OWN key gives a template with them off.
// The Save as template dialog says so before the press (a template creates no
// accounts: the events made from it would) and the message says so after it.
test.describe("Save as template, from the workspace", () => {
  test("an event with its own Checkmarx One key: the dialog and the message say the template has accounts off; an event on the platform's key says nothing", async ({ page }) => {
    test.setTimeout(120_000);
    const withKey = uniq("Tpl own key event");
    const plain = uniq("Tpl plain event");
    // A key the decoder accepts: an `iss` on an allowlisted IAM host.
    const fakeKey = `header.${Buffer.from(JSON.stringify({ iss: "https://iam.checkmarx.net/auth/realms/cxone_tpl_ui" })).toString("base64url")}.signature`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      for (const name of [withKey, plain]) {
        const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
          name, event_kind: "tournament", start_time: new Date(Date.now() + 2 * 864e5).toISOString(), duration_minutes: 60 } });
        expect(r.ok(), `create ${name}: ${await r.text()}`).toBeTruthy();
        if (name !== withKey) continue;
        const k = await sa.put(`/api/admin/competitions/${(await r.json()).competition.id}/cxone`, { headers: H(csrf), data: { cxone_api_key: fakeKey, cxone_group_name: "" } });
        expect(k.ok(), `own key: ${await k.text()}`).toBeTruthy();
      }
    } finally { await sa.dispose(); }
    const keyRow = (name) => dbGet("SELECT cxone_disabled d, cxone_api_key IS NOT NULL k FROM competitions WHERE name=?", name);
    expect(keyRow(withKey), "PRECONDITION: its own key, accounts on").toEqual({ d: 0, k: 1 });
    expect(keyRow(plain), "PRECONDITION: the platform's key, accounts on").toEqual({ d: 0, k: 0 });

    await adminLogin(page);
    // `beforeSubmit` reads the open dialog (the note is said BEFORE the press).
    const saveVia = async (name, beforeSubmit) => {
      await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
      await viewComp(page, name);
      await expect(page.locator("#ws-record")).toBeVisible({ timeout: 15000 });
      await page.locator("#ws-quick .ws-more-btn").click();
      await page.locator('#kebab-portal [data-action="ws-save-template"]').click();
      const dlg = page.locator("#ws-tpl-dialog");
      await expect(dlg).toBeVisible({ timeout: 10000 });
      await expect(dlg.locator("#ws-tpl-name"), "PRECONDITION: the dialog is this event's").toHaveValue(name);
      await beforeSubmit(dlg);
      await dlg.locator('button[type="submit"]').click();
      await expect(dlg).toHaveCount(0, { timeout: 15000 });
    };
    const toastOf = (name) => page.locator("#toast-stack .toast").filter({ hasText: `Saved template “${name}”` });

    await saveVia(plain, async (dlg) => {
      await expect(dlg.locator(".ws-dialog-lede").first(), "PRECONDITION: the dialog is drawn").toContainText("Keeps this event's type");
      await expect(dlg.locator("[data-cxone-off-note]"), "CONTROL: an event on the platform's key says nothing about accounts").toHaveCount(0);
    });
    await expect(toastOf(plain), "CONTROL: its message names nothing it left behind").toHaveText(`Saved template “${plain}”.`, { timeout: 15000 });

    await saveVia(withKey, async (dlg) => {
      const note = dlg.locator("[data-cxone-off-note]");
      await expect(note, "the dialog says it before the press, of the events made from the template (a template creates no accounts)")
        .toHaveText("Checkmarx One accounts: off in the template. This event creates them with its own Checkmarx One key, which is never copied, so events made from it would otherwise create them in the platform's default tenant.");
    });
    await expect(toastOf(withKey), "the message says it after")
      .toHaveText(`Saved template “${withKey}”. Not carried over: Checkmarx One accounts (turned off: the event used its own Checkmarx One key, which is never copied).`, { timeout: 15000 });

    const stored = (name) => JSON.parse(dbGet("SELECT settings s FROM event_templates WHERE name=?", name).s).cxone_disabled;
    expect(stored(withKey), "the template creates no accounts").toBe(true);
    expect(stored(plain), "CONTROL: a template of an event on the platform's key keeps them on").toBe(false);
  });
});
