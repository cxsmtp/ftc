"use strict";

// USERS & ROLES — the admin screen.
//
//   * a superadmin opens Users & roles from the sidebar, sees the platform's
//     admin accounts (by value: an admin made for this file is listed, and a
//     participant made beside it is NOT — People is participants only), creates
//     a custom role through the role editor and finds it on the Roles list;
//   * built-in roles open read-only (every permission box disabled), each
//     locked row marked by a dashed edge and muted ink at full strength (never
//     the global .is-disabled opacity), only its box faded;
//   * an event admin is not offered the item at all (and the server refuses
//     the read — the control's two halves agree);
//   * at phone width the users table becomes one card per row (labels from the
//     column headings) with no sideways scroll;
//   * the role editor offers a platform-wide permission (the raw logs) only to a
//     role that acts on every event, saying why otherwise;
//   * a competing account manager is not offered Change role on a rival.
//   * Change role never offers Event admin as a new role (it is granted per
//     event), says before the click that leaving an organiser role drops every
//     event grant (with the count) and reports the server's own count after;
//   * the Events dialog lists events in the shared picker order (live first),
//     saves a grant, and a second press supersedes a slower first (the dialog
//     names the person pressed last);
//   * a role nobody holds is deleted; deleting a held one reports the refusal.

const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { adminLogin, loginViaApi, rowMarking, textContrast } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, grantEventAdmin, enrol } = require("./event-admin-helpers");
const { apiLogin, PARTICIPANT_PASS } = require("./helpers");

test.use({ baseURL: BASE });

test.describe("RBAC — Users & roles screen", () => {
  let adminU, partU, eaU, ea2U, ea3U, liveC, laterC, grantC1, grantC2, moverRole, tempRole, heldRole, heldU, keeperRole, keeper1, keeper2;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    adminU = await makeParticipant(s.api, s.csrf, "uiadmin");
    const r = await s.api.post(`/api/admin/participants/${adminU.id}/role`, { headers: H(s.csrf), data: { role: "admin" } });
    expect(r.ok(), `promote: ${r.status()}`).toBeTruthy();
    partU = await makeParticipant(s.api, s.csrf, "uipart");
    eaU = await makeParticipant(s.api, s.csrf, "uiea");
    const comp = await makeCompetition(s.api, s.csrf, "uiea-comp");
    await grantEventAdmin(s.api, s.csrf, comp.id, eaU.id);
    // An organiser of TWO events (their grants are what a role change drops).
    ea2U = await makeParticipant(s.api, s.csrf, "uiea2");
    grantC1 = await makeCompetition(s.api, s.csrf, "uigrant-a");
    grantC2 = await makeCompetition(s.api, s.csrf, "uigrant-b");
    await grantEventAdmin(s.api, s.csrf, grantC1.id, ea2U.id);
    await grantEventAdmin(s.api, s.csrf, grantC2.id, ea2U.id);
    ea3U = await makeParticipant(s.api, s.csrf, "uiea3");
    await grantEventAdmin(s.api, s.csrf, grantC1.id, ea3U.id);
    // The picker order: a LIVE event and a later UPCOMING one (the server lists
    // the later start first; the shared picker order puts live first).
    liveC = await makeCompetition(s.api, s.csrf, "uiorder-live");
    laterC = await makeCompetition(s.api, s.csrf, "uiorder-later", { start_time: new Date(Date.now() + 3 * 86400e3).toISOString() });
    const stamp = Date.now();
    const role = async (label) => {
      const r = await s.api.post("/api/admin/roles", { headers: H(s.csrf), data: { label: `${label} ${stamp}`, scope_mode: "all", permissions: ["events.view"] } });
      expect(r.ok(), `role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).role;
    };
    moverRole = await role("Mover");
    tempRole = await role("Temporary");
    heldRole = await role("Held");
    heldU = await makeParticipant(s.api, s.csrf, "uiheld");
    const g = await s.api.patch(`/api/admin/users/${heldU.id}/role`, { headers: H(s.csrf), data: { role: heldRole.id } });
    expect(g.ok(), `give held role: ${g.status()}`).toBeTruthy();
    // A custom role that may manage users, held by two accounts.
    const kr = await s.api.post("/api/admin/roles", { headers: H(s.csrf), data: { label: `Keeper ${stamp}`, scope_mode: "all", permissions: ["users.view", "users.manage"] } });
    expect(kr.ok(), `keeper role: ${kr.status()} ${await kr.text()}`).toBeTruthy();
    keeperRole = (await kr.json()).role;
    keeper1 = await makeParticipant(s.api, s.csrf, "uikeep1");
    keeper2 = await makeParticipant(s.api, s.csrf, "uikeep2");
    for (const u of [keeper1, keeper2]) {
      const k = await s.api.patch(`/api/admin/users/${u.id}/role`, { headers: H(s.csrf), data: { role: keeperRole.id } });
      expect(k.ok(), `give keeper role: ${k.status()}`).toBeTruthy();
    }
  });

  async function openUsers(page) {
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    const item = page.locator('button.admin-nav-item[data-tab-id="admin-users-tab"]');
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.locator("#admin-users-tab")).toBeVisible();
    await expect(page.locator("#ua-body .ua-switch")).toBeVisible({ timeout: 10000 });
  }

  test("a superadmin lists platform users and creates a custom role", async ({ page }) => {
    await adminLogin(page);
    await openUsers(page);
    const list = page.locator("#ua-users-list");
    await expect(list).toContainText(adminU.email);
    await expect(list, "a participant is not a platform user").not.toContainText(partU.email);
    await expect(list.locator("tr", { hasText: adminU.email })).toContainText("Admin");

    await page.locator('#ua-body [data-action="ua-view"][data-view="roles"]').click();
    // The four built-in roles (this file also makes custom ones of its own).
    await expect(page.locator("#ua-roles-list .ua-role", { has: page.locator(".chip", { hasText: "Built-in" }) })).toHaveCount(4);
    // A built-in role is read-only.
    await page.locator('#ua-roles-list [data-action="ua-role-open"][data-role-id="event_admin"]').click();
    const ro = page.locator("#ua-role-ed");
    await expect(ro).toBeVisible();
    const boxes = ro.locator(".ua-matrix input[type=checkbox]");
    expect(await boxes.count(), "the permission matrix rendered").toBeGreaterThan(40);
    expect(await ro.locator(".ua-matrix input[type=checkbox]:not([disabled])").count(), "every box is read-only").toBe(0);
    await ro.locator("[data-ua-cancel]").click();
    await expect(ro).toHaveCount(0);

    const name = `Support desk ${Date.now()}`;
    await page.locator('#ua-roles-list [data-action="ua-role-new"]').click();
    const ed = page.locator("#ua-role-ed");
    await ed.locator("#ua-re-label").fill(name);
    await ed.locator('.ua-matrix input[data-perm="participants.view"]').check();
    await ed.locator('.ua-matrix input[data-perm="participants.signin_codes"]').check();
    await ed.locator('button[type="submit"]').click();
    await expect(ed).toHaveCount(0);
    const card = page.locator("#ua-roles-list .ua-role", { hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText("3 permissions");
    // The server holds what the screen says.
    const roles = await (await page.request.get("/api/admin/roles")).json();
    const stored = roles.roles.find(r => r.label === name);
    expect(stored && stored.permissions).toEqual(["panel.access", "participants.signin_codes", "participants.view"]);
  });

  // A permission the role cannot change is MARKED (dashed edge, muted ink at
  // full strength), never dimmed: the global `.is-disabled{opacity:.5}` took a
  // built-in role's whole matrix — every label and its "cannot be changed"
  // reason — below AA. Only the disabled box itself stays faded.
  test("a built-in role's locked permission rows read at full strength; only their boxes are faded", async ({ page }) => {
    await adminLogin(page);
    await openUsers(page);
    await page.locator('#ua-body [data-action="ua-view"][data-view="roles"]').click();
    await page.locator('#ua-roles-list [data-action="ua-role-open"][data-role-id="event_admin"]').click();
    const ro = page.locator("#ua-role-ed");
    await expect(ro).toBeVisible();
    const rows = ro.locator(".ua-perm.is-disabled");
    expect(await rows.count(), "PRECONDITION: a built-in role's rows are all locked").toBeGreaterThan(40);
    const row = rows.first();
    await expect(row.locator(".ua-perm-why"), "PRECONDITION: the locked row says why").not.toHaveText("");
    const m = await rowMarking(row);
    expect(m.opacity, `the row is not dimmed: ${JSON.stringify(m)}`).toBe("1");
    expect(m.color, "its ink is the muted token").toBe(m.muted);
    expect(m.borderLeftStyle, "it is marked by a dashed edge").toBe("dashed");
    expect(m.boxOpacity, "CONTROL: the disabled box itself is faded, so a fade does reach this row").toBe("0.5");
    for (const part of [row.locator(":scope > span").first(), row.locator(".ua-perm-why")]) {
      const c = await textContrast(part);
      expect(c.opacity, `no opacity on the words: ${JSON.stringify(c)}`).toBe(1);
      expect(c.ratio, `readable: ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(4.5);
    }
    await ro.locator("[data-ua-cancel]").click();
  });

  test("an event admin is not offered Users & roles", async ({ page }) => {
    await loginViaApi(page, eaU.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]'), "control: the sidebar rendered").toBeVisible();
    await expect(page.locator('button.admin-nav-item[data-tab-id="admin-users-tab"]')).toBeHidden();
    expect((await page.request.get("/api/admin/users")).status(), "and the server refuses the read").toBe(403);
  });

  test("phone width: one card per user row, no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await adminLogin(page);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await page.evaluate(() => window.adminTab(null, "admin-users-tab"));
    await expect(page.locator("#ua-users-list tr", { hasText: adminU.email })).toBeVisible({ timeout: 10000 });
    await expect.poll(() => page.locator("#ua-users-list td").first().getAttribute("data-label")).toBe("Name");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, "the page does not scroll sideways").toBeLessThanOrEqual(1);
  });

  test("the role editor offers the raw logs only to a role that acts on every event, and says why otherwise", async ({ page }) => {
    // The server refuses a platform-wide permission for a scoped role by name
    // (tests/rbac-users-roles.api.spec.js), so the editor must not offer it there.
    await adminLogin(page);
    await openUsers(page);
    await page.locator('#ua-body [data-action="ua-view"][data-view="roles"]').click();
    await page.locator('#ua-roles-list [data-action="ua-role-new"]').click();
    const ed = page.locator("#ua-role-ed");
    const logs = ed.locator('.ua-matrix input[data-perm="audit.raw_logs"]');
    // `has` is matched INSIDE each row, so its locator names only the input.
    const logsRow = ed.locator(".ua-perm", { has: page.locator('input[data-perm="audit.raw_logs"]') });
    await expect(ed.locator('input[name="ua-scope"][value="granted"]'), "PRECONDITION: a new role starts scoped").toBeChecked();
    await expect(logs).toBeDisabled();
    await expect(logsRow.locator(".ua-perm-why")).toContainText("acts on every event");
    await expect(ed.locator('.ua-matrix input[data-perm="audit.view"]'), "CONTROL: an event-scoped permission stays offered").toBeEnabled();
    await ed.locator('input[name="ua-scope"][value="all"]').check();
    await expect(logs, "every event: offered").toBeEnabled();
    await expect(logsRow.locator(".ua-perm-why")).toHaveText("");
    await logs.check();
    await ed.locator('input[name="ua-scope"][value="granted"]').check();
    await expect(logs, "back to scoped: withdrawn and unticked").toBeDisabled();
    await expect(logs).not.toBeChecked();
  });

  test("a competing account manager is not offered Change role on a rival, and is told why; a non-rival keeps it (CONTROL)", async ({ page }) => {
    const s = await apiLogin("superadmin");
    const comp = await makeCompetition(s.api, s.csrf, "ua-rival-ui", { staff_compete: true });
    const actor = await makeParticipant(s.api, s.csrf, "uauiactor");
    const rival = await makeParticipant(s.api, s.csrf, "uauirival");
    const other = await makeParticipant(s.api, s.csrf, "uauiother");
    await enrol(s.api, s.csrf, comp.id, [actor.id, rival.id]);
    for (const [u, role] of [[actor, "superadmin"], [rival, "admin"], [other, "admin"]]) {
      const r = await s.api.post(`/api/admin/participants/${u.id}/role`, { headers: H(s.csrf), data: { role } });
      expect(r.ok(), `make ${role}: ${await r.text()}`).toBeTruthy();
    }
    await loginViaApi(page, actor.email, PARTICIPANT_PASS);
    await openUsers(page);
    const rivalRow = page.locator("#ua-users-list tr", { hasText: rival.email });
    const otherRow = page.locator("#ua-users-list tr", { hasText: other.email });
    await expect(rivalRow).toBeVisible();
    await expect(rivalRow.locator('[data-action="ua-change-role"]')).toHaveCount(0);
    await expect(rivalRow.locator(".ua-rival-note")).toContainText(comp.name);
    await expect(otherRow.locator('[data-action="ua-change-role"]'), "CONTROL: a non-rival keeps Change role").toHaveCount(1);
    await expect(otherRow.locator(".ua-rival-note")).toHaveCount(0);
  });

  test("Change role never offers Event admin, warns before an organiser's grants go, and reports how many were cleared", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await openUsers(page);
    // On an admin's row: Event admin is not a role this dialog gives.
    await page.locator("#ua-users-list tr", { hasText: adminU.email }).locator('[data-action="ua-change-role"]').click();
    let dlg = page.locator("#ua-role-change");
    await expect(dlg).toBeVisible();
    const opts = await dlg.locator("#ua-rc-role option").evaluateAll((os) => os.map((o) => o.value));
    expect(opts, "POSITIVE: the dialog offers roles").toEqual(expect.arrayContaining(["participant", "admin", "superadmin", moverRole.id]));
    expect(opts, "Event admin is granted per event, never offered as a new role").not.toContain("event_admin");
    // CONTROL for the warning: a move between unscoped roles drops no grant.
    await dlg.locator("#ua-rc-role").selectOption("superadmin");
    await expect(dlg.locator("#ua-rc-grants")).toBeHidden();
    await dlg.locator("[data-ua-cancel]").click();
    await expect(dlg).toHaveCount(0);

    // An organiser of two events moved to an unscoped role: told first, with the count.
    await page.locator("#ua-users-list tr", { hasText: ea2U.email }).locator('[data-action="ua-change-role"]').click();
    dlg = page.locator("#ua-role-change");
    await expect(dlg.locator("#ua-rc-role")).toHaveValue("event_admin");
    await expect(dlg.locator("#ua-rc-grants"), "no warning before a move is chosen").toBeHidden();
    await dlg.locator("#ua-rc-role").selectOption(moverRole.id);
    await expect(dlg.locator("#ua-rc-grants")).toBeVisible();
    await expect(dlg.locator("#ua-rc-grants")).toContainText("This also removes every event they organise (2).");
    await expect(dlg.locator("#ua-rc-grants")).toContainText("Putting the role back does not restore them");
    await dlg.locator('button[type="submit"]').click();
    await expect(page.locator("#toast-stack"), "the server's own count is reported").toContainText("Role changed. 2 event grants cleared.", { timeout: 10000 });
    const users = await (await page.request.get("/api/admin/users")).json();
    const row = users.users.find((u) => u.id === ea2U.id);
    expect(row && row.role, "the role changed").toBe(moverRole.id);
    const admins = await (await page.request.get(`/api/admin/competitions/${grantC2.id}/admins`)).json();
    expect(JSON.stringify(admins), "the grant is gone server-side").not.toContain(ea2U.id);
  });

  test("Events lists events live first, saves a grant, and a second press supersedes a slower first", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await openUsers(page);
    // Hold the FIRST events read (the first press) until the second has rendered.
    let first = null, release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/admin/competitions", async (route) => {
      if (!first) { first = route.request(); await gate; }
      await route.continue();
    });
    await page.locator("#ua-users-list tr", { hasText: eaU.email }).locator('[data-action="ua-events"]').click();
    await expect.poll(() => !!first).toBe(true);
    await page.locator("#ua-users-list tr", { hasText: ea3U.email }).locator('[data-action="ua-events"]').click();
    const dlg = page.locator("#ua-events");
    await expect(dlg, "the second press renders").toBeVisible({ timeout: 10000 });
    await expect(dlg.locator(".modal-title")).toContainText("uiea3");
    // Now the superseded FIRST answer arrives: wait for its body, then let the
    // page run what it queued (two event-loop turns).
    const done = page.waitForEvent("requestfinished", (r) => r === first);
    release();
    await done;
    await page.evaluate(() => new Promise((r) => setTimeout(() => setTimeout(r, 0), 0)));
    await expect(dlg.locator(".modal-title"), "the dialog still names the person pressed last").toContainText("uiea3");
    await expect(page.locator("#ua-events")).toHaveCount(1);
    await page.unroute("**/api/admin/competitions");
    // The shared picker order: the live event above the later upcoming one.
    const names = await dlg.locator(".ua-ev-list label span").allInnerTexts();
    const iLive = names.indexOf(liveC.name), iLater = names.indexOf(laterC.name);
    expect(iLive, "PRECONDITION: both events listed").toBeGreaterThanOrEqual(0);
    expect(iLater).toBeGreaterThanOrEqual(0);
    expect(iLive, "live first, then soonest start").toBeLessThan(iLater);
    // Saving a grant works through the dialog.
    await dlg.locator(`.ua-ev-list input[value="${liveC.id}"]`).check();
    await dlg.locator('button[type="submit"]').click();
    await expect(page.locator("#toast-stack")).toContainText("Events saved.", { timeout: 10000 });
    const admins = await (await page.request.get(`/api/admin/competitions/${liveC.id}/admins`)).json();
    expect(JSON.stringify(admins), "the grant was written").toContain(ea3U.id);
  });

  // The same shared picker order in a challenge's Assign to Events dialog: the
  // server lists events by start, latest first, which would put the later
  // upcoming event above the live one.
  test("a challenge's Assign to Events dialog lists the live event above a later upcoming one", async ({ page }) => {
    const s = await apiLogin("superadmin");
    let task;
    try { task = await makeTask(s.api, s.csrf, "uiorder-assign"); } finally { await s.api.dispose(); }
    await adminLogin(page);
    await page.locator('.admin-nav-item[data-tab-id="admin-tasks-tab"]').click();
    await expect.poll(() => page.evaluate((id) => (window.S.adminTasksData || []).some((t) => t.id === id), task.id), { timeout: 15000 }).toBe(true);
    await page.evaluate((id) => window.openAssignTaskToComps(id), task.id);
    const boxes = page.locator("#assign-task-overlay #assign-task-comp-list input[type=checkbox]");
    await expect(boxes.first(), "PRECONDITION: the dialog listed events").toBeVisible({ timeout: 10000 });
    const ids = await boxes.evaluateAll((els) => els.map((e) => e.value));
    const iLive = ids.indexOf(liveC.id), iLater = ids.indexOf(laterC.id);
    expect(iLive, "PRECONDITION: the live event is listed").toBeGreaterThanOrEqual(0);
    expect(iLater, "PRECONDITION: the later upcoming event is listed").toBeGreaterThanOrEqual(0);
    expect(iLive, "live first, then soonest start").toBeLessThan(iLater);
  });

  test("a role nobody holds is deleted; deleting a held role reports the refusal", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await openUsers(page);
    await page.locator('#ua-body [data-action="ua-view"][data-view="roles"]').click();
    await page.locator(`#ua-roles-list [data-action="ua-role-delete"][data-role-id="${heldRole.id}"]`).click();
    await expect(page.locator("#modal-overlay.open")).toContainText("1 person holds this role. Give them another role first.");
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack"), "the refusal is reported").toContainText("1 account holds this role", { timeout: 10000 });
    let roles = (await (await page.request.get("/api/admin/roles")).json()).roles.map((r) => r.id);
    expect(roles, "the held role stays").toContain(heldRole.id);

    await page.locator(`#ua-roles-list [data-action="ua-role-delete"][data-role-id="${tempRole.id}"]`).click();
    await expect(page.locator("#modal-overlay.open")).toContainText("Nobody holds this role.");
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack")).toContainText("Role deleted.", { timeout: 10000 });
    await expect(page.locator(`#ua-roles-list [data-role-id="${tempRole.id}"]`)).toHaveCount(0);
    roles = (await (await page.request.get("/api/admin/roles")).json()).roles.map((r) => r.id);
    expect(roles).not.toContain(tempRole.id);
  });

  test("a custom role that may manage users is offered Change role only where the server would move the account", async ({ page }) => {
    test.setTimeout(120_000);
    await loginViaApi(page, keeper1.email, PARTICIPANT_PASS);
    await openUsers(page);
    const list = page.locator("#ua-users-list");
    const fellow = list.locator("tr", { hasText: keeper2.email });
    await expect(fellow, "PRECONDITION: the fellow holder is listed").toHaveCount(1, { timeout: 10000 });
    await expect(fellow.locator('[data-action="ua-change-role"]'), "POSITIVE: an account on its own role can be moved").toHaveCount(1);
    await expect(list.locator("tr", { hasText: adminU.email }), "PRECONDITION: the admin is listed").toHaveCount(1);
    await expect(list.locator("tr", { hasText: adminU.email }).locator('[data-action="ua-change-role"]'), "an admin's role holds permissions this role lacks: no Change role").toHaveCount(0);
    // The dialog offers only roles this session may give.
    await fellow.locator('[data-action="ua-change-role"]').click();
    const opts = await page.locator("#ua-role-change #ua-rc-role option").evaluateAll((os) => os.map((o) => o.value));
    expect(opts, "its own role stays selectable").toContain(keeperRole.id);
    for (const r of ["admin", "superadmin", "event_admin"]) expect(opts, `${r} is not this role's to give`).not.toContain(r);
  });
});
