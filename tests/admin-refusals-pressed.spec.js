"use strict";

// REFUSALS THAT NO SPEC PRESSED (sweep #475). Each door below already has its
// success path pressed elsewhere; here the server refuses it, and what the
// admin is told is the subject ("every mutation reports its refusal"):
//
//   * Users & roles: Change role refused (the server's reason, else "The role
//     was not changed."), the dialog kept open and the role unchanged; Add user
//     on an address that already has an account, whose role change is refused;
//     the Events dialog's removal of a grant refused ("1 change was refused"),
//     the grant kept;
//   * Team & reports: Download leads refused: an error toast, and no file;
//   * looks: the platform look's Save, an event's Save look and the Appearance
//     page's organisation default, each refused (the server's reason, else the
//     door's own sentence), nothing stored;
//   * templates: Restore, Protect and Delete refused, the template as it was.
//
// Each refusal is the server's answer to the page's own request, given by
// page.route; each test then lets the same press through (CONTROL), so the
// press is shown to reach the door the refusal was answered for. The page.route
// answers only the browser's requests: the read-backs (page.request) reach the
// server. Every request goes through the browser's own superadmin session (one
// session per principal).

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH } = require("./helpers");
const Database = require("better-sqlite3");
const { adminLogin, viewComp, openSettingsSection, clickTab } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { openAppearance } = require("./chrome-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const errorToast = (page, text) => page.locator("#toast-stack .toast-error", { hasText: text });
const DEFAULT_LOOK = { look: "", mode: "", ambient: "", lock: false };
const REFUSE = { status: 403, contentType: "application/json", body: JSON.stringify({ error: "Probe refusal" }) };
const BROKEN = { status: 500, contentType: "text/plain", body: "" };

async function signedIn(page) {
  await adminLogin(page);
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  return { sa: page.request, csrf };
}

/** Route one method on a URL glob; every other method goes through. */
async function refuse(page, glob, method, answer) {
  await page.route(glob, (r) => (r.request().method() === method ? r.fulfill(answer) : r.continue()));
}

async function openUsers(page) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-users-tab"]').click();
  await expect(page.locator("#admin-users-tab")).toBeVisible();
  await expect(page.locator("#ua-body .ua-switch")).toBeVisible({ timeout: 10000 });
}
const userRow = (page, email) => page.locator("#ua-users-list tr", { hasText: email });
/** The account's stored role, read from the server's database. */
const roleOf = (id) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT role FROM users WHERE id=?").get(id)?.role; } finally { db.close(); }
};

test("Users & roles: a refused role change keeps the dialog and the role, and says why", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const adm = await makeParticipant(sa, csrf, "refrole");
  const pr = await sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(csrf), data: { role: "admin" } });
  expect(pr.ok(), `promote: ${pr.status()}`).toBeTruthy();
  expect(roleOf(adm.id), "PRECONDITION: an admin account").toBe("admin");

  await openUsers(page);
  await userRow(page, adm.email).locator('[data-action="ua-change-role"]').click();
  const dlg = page.locator("#ua-role-change");
  await expect(dlg).toBeVisible();
  await dlg.locator("#ua-rc-role").selectOption("participant");
  await refuse(page, "**/api/admin/users/*/role", "PATCH", REFUSE);
  await dlg.locator('button[type="submit"]').click();
  await expect(dlg.locator("#ua-role-change-err"), "the server's reason").toHaveText("Probe refusal");
  await expect(dlg, "the dialog stays open").toBeVisible();
  expect(roleOf(adm.id), "nothing changed").toBe("admin");
  await page.unroute("**/api/admin/users/*/role");
  await refuse(page, "**/api/admin/users/*/role", "PATCH", BROKEN);
  await dlg.locator('button[type="submit"]').click();
  await expect(dlg.locator("#ua-role-change-err"), "no reason given: the door's own sentence").toHaveText("The role was not changed.");
  await page.unroute("**/api/admin/users/*/role");
  // CONTROL — let through, the same press changes the role and closes.
  await dlg.locator('button[type="submit"]').click();
  await expect(page.locator("#toast-stack")).toContainText("Role changed.", { timeout: 10000 });
  await expect(dlg).toHaveCount(0);
  expect(roleOf(adm.id), "the control's change reached the server").toBe("participant");
});

test("Users & roles: Add user on an address that has an account reports a refused role change", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const who = await makeParticipant(sa, csrf, "refadd");
  await openUsers(page);
  await page.locator('[data-action="ua-add-user"]').click();
  const dlg = page.locator("#ua-add");
  await expect(dlg).toBeVisible();
  await dlg.locator("#ua-add-email").fill(who.email);
  await dlg.locator("#ua-add-role").selectOption("admin");
  await refuse(page, "**/api/admin/users/*/role", "PATCH", REFUSE);
  await dlg.locator('button[type="submit"]').click();
  await expect(page.locator("#modal-overlay.open"), "the existing account is offered the role").toContainText("That address has an account");
  await page.locator("#modal-confirm-btn").click();
  await expect(dlg.locator("#ua-add-err"), "the refusal is said in the dialog").toHaveText("Probe refusal");
  await expect(dlg).toBeVisible();
  expect(roleOf(who.id), "the account keeps its role").toBe("participant");
  await page.unroute("**/api/admin/users/*/role");
  // CONTROL — let through, the same two presses give the role.
  await dlg.locator('button[type="submit"]').click();
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator("#toast-stack")).toContainText(`${who.email} now holds that role.`, { timeout: 10000 });
  expect(roleOf(who.id), "the control's change reached the server").toBe("admin");
});

test("Users & roles: the Events dialog reports a refused removal and the grant stays", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const ea = await makeParticipant(sa, csrf, "refevents");
  const a = await makeCompetition(sa, csrf, "refeva");
  const b = await makeCompetition(sa, csrf, "refevb");
  await grantEventAdmin(sa, csrf, a.id, ea.id);
  await grantEventAdmin(sa, csrf, b.id, ea.id);
  const holds = async (compId) => JSON.stringify(await (await sa.get(`/api/admin/competitions/${compId}/admins`)).json()).includes(ea.id);
  expect([await holds(a.id), await holds(b.id)], "PRECONDITION: two grants").toEqual([true, true]);

  await openUsers(page);
  await userRow(page, ea.email).locator('[data-action="ua-events"]').click();
  const dlg = page.locator("#ua-events");
  await expect(dlg).toBeVisible({ timeout: 10000 });
  await dlg.locator(`.ua-ev-list input[value="${a.id}"]`).uncheck();
  await refuse(page, `**/api/admin/competitions/${a.id}/admins/*`, "DELETE", REFUSE);
  await dlg.locator('button[type="submit"]').click();
  await expect(dlg.locator("#ua-events-err"), "the refused removal is reported").toHaveText("1 change was refused: Probe refusal");
  await expect(dlg).toBeVisible();
  expect(await holds(a.id), "the grant stays").toBe(true);
  await page.unroute(`**/api/admin/competitions/${a.id}/admins/*`);
  // CONTROL — let through, the same press removes it.
  await dlg.locator('button[type="submit"]').click();
  await expect(page.locator("#toast-stack")).toContainText("Events saved.", { timeout: 10000 });
  await expect(dlg).toHaveCount(0);
  expect([await holds(a.id), await holds(b.id)], "only the unticked grant is gone").toEqual([false, true]);
});

test("Team & reports: a refused Download leads is reported and saves no file", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const dom = await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: ["refusal.example"] } });
  expect(dom.ok(), await dom.text()).toBeTruthy();
  try {
    const comp = await makeCompetition(sa, csrf, "refleads");
    const p = await makeParticipant(sa, csrf, "refleadsp");
    await enrol(sa, csrf, comp.id, [p.id]);
    const m = await sa.post(`/api/admin/competitions/${comp.id}/team`, { headers: H(csrf), data: { role: "sdr", name: "Rae Fused", email: "rae.fused@refusal.example" } });
    expect(m.ok(), `add member: ${await m.text()}`).toBeTruthy();
    await clickTab(page, "Events");
    await viewComp(page, comp.name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
    await expect(page.locator("#ws-team")).toContainText("rae.fused@refusal.example", { timeout: 15000 });
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    const btn = page.locator('[data-action="team-leads-csv"]');
    await expect(btn).toBeVisible();

    let files = 0;
    page.on("download", () => { files++; });
    let asked = 0;
    await page.route("**/team-report/leads.csv", (r) => { asked++; return r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Boom"}' }); });
    await btn.click();
    await expect(errorToast(page, "Could not download the lead file."), "the refusal is said").toBeVisible({ timeout: 10000 });
    expect(asked, "the press asked for the file").toBe(1);
    expect(files, "no file was saved").toBe(0);
    await page.unroute("**/team-report/leads.csv");
    // CONTROL — let through, the same press saves the file.
    const [file] = await Promise.all([page.waitForEvent("download"), btn.click()]);
    expect(file.suggestedFilename()).toMatch(/^leads-.+\.csv$/);
  } finally {
    const r = await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: [] } });
    expect(r.ok(), "the allowed domains are back to their default").toBeTruthy();
  }
});

test("looks: a refused platform look, event look and organisation default each say so and store nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const comp = await makeCompetition(sa, csrf, "reflook");
  const appearance = async () => (await (await sa.get("/api/settings/appearance")).json());
  const evRow = async () => (await (await sa.get("/api/admin/competitions")).json()).find((c) => c.id === comp.id);
  try {
    const before = (await appearance()).platform_look;
    expect(before.look, "PRECONDITION: the platform look is the default").toBe("");

    // ── The platform look's Save (Settings, Look).
    await page.evaluate(() => window.adminTab(null, "admin-settings-tab"));
    await openSettingsSection(page, "look");
    await page.locator("#pl-look").selectOption("signature");
    await refuse(page, "**/api/admin/platform-look", "PUT", { ...REFUSE, status: 400 });
    await page.locator('[data-action="platform-look-save"]').click();
    await expect(errorToast(page, "Probe refusal"), "the server's reason").toBeVisible({ timeout: 10000 });
    await page.unroute("**/api/admin/platform-look");
    await refuse(page, "**/api/admin/platform-look", "PUT", BROKEN);
    await page.locator('[data-action="platform-look-save"]').click();
    await expect(errorToast(page, "Could not save the platform look."), "no reason: the door's own sentence").toBeVisible({ timeout: 10000 });
    await page.unroute("**/api/admin/platform-look");
    expect((await appearance()).platform_look.look, "nothing stored").toBe("");

    // ── The organisation default (Appearance page).
    await openAppearance(page);
    await page.locator("#ap-org-look").selectOption("signature");
    await refuse(page, "**/api/admin/settings", "PATCH", { ...REFUSE, status: 400 });
    await page.locator('[data-action="appearance-org-save"]').click();
    await expect(page.locator("#toast-stack .toast-error").last(), "the server's reason (the newest error: the last one said the platform look's sentence)").toContainText("Probe refusal", { timeout: 10000 });
    await page.unroute("**/api/admin/settings");
    await refuse(page, "**/api/admin/settings", "PATCH", BROKEN);
    await page.locator('[data-action="appearance-org-save"]').click();
    await expect(errorToast(page, "Could not save the default look.")).toBeVisible({ timeout: 10000 });
    await page.unroute("**/api/admin/settings");
    expect((await appearance()).platform_look.look, "nothing stored").toBe("");
    await page.keyboard.press("Escape");
    await expect(page.locator("#appearance-overlay")).toHaveCount(0);

    // ── The event's Save look (its workspace's Settings).
    await clickTab(page, "Events");
    await viewComp(page, comp.name);
    await page.locator('#ws-tabs [data-section="admin-event-settings-tab"]').click();
    await page.locator("#ev-look").selectOption("signature");
    await refuse(page, `**/api/admin/competitions/${comp.id}/look`, "PUT", BROKEN);
    await page.locator('[data-action="event-look-save"]').click();
    await expect(errorToast(page, "Could not save the event look.")).toBeVisible({ timeout: 10000 });
    await page.unroute(`**/api/admin/competitions/${comp.id}/look`);
    expect((await evRow()).event_look ?? null, "nothing stored").toBeNull();
    // CONTROL — let through, the same press stores it.
    await page.locator('[data-action="event-look-save"]').click();
    await expect(page.locator("#toast-stack")).toContainText("Event look saved.", { timeout: 10000 });
    expect((await evRow()).event_look, "the control's save reached the server").toBe("signature");
  } finally {
    const r = await sa.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT_LOOK });
    expect(r.ok(), `the platform look is back to its default: ${await r.text()}`).toBeTruthy();
  }
});

test("templates: a refused Restore, Protect and Delete each say so and leave the template as it was", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const mk = async (name) => {
    const r = await sa.post("/api/admin/event-templates", { headers: H(csrf), data: { name, description: "", event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [] } });
    expect(r.ok(), `create template: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).template;
  };
  const stamp = Date.now().toString(36);
  const keep = await mk(`Refusal keep ${stamp}`);
  const gone = await mk(`Refusal gone ${stamp}`);
  const del = await sa.delete(`/api/admin/event-templates/${gone.id}`, { headers: H(csrf) });
  expect(del.ok(), `PRECONDITION: soft-deleted: ${await del.text()}`).toBeTruthy();
  const live = async () => ((await (await sa.get("/api/admin/event-templates")).json()).templates || []).find((t) => t.id === keep.id);
  const deleted = async () => ((await (await sa.get("/api/admin/event-templates/deleted")).json()).templates || []).some((t) => t.id === gone.id);

  await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
  await expect(page.locator("#tpl-list .tpl-row").first()).toBeVisible({ timeout: 15000 });
  const row = page.locator("#tpl-list .tpl-row").filter({ has: page.locator("button.card-open", { hasText: keep.name }) });
  const menu = page.locator("#kebab-portal");
  const openMenu = async () => { await row.locator(".tpl-row-more").click(); await expect(page.locator("#kebab-portal.open")).toBeVisible(); };

  // ── Restore.
  const restore = page.locator(`#tpl-deleted [data-action="tpl-restore"][data-tpl-id="${gone.id}"]`);
  await expect(restore).toBeVisible({ timeout: 15000 });
  await refuse(page, `**/api/admin/event-templates/${gone.id}/restore`, "POST", { ...REFUSE, status: 409 });
  await restore.click();
  await expect(errorToast(page, "Probe refusal")).toBeVisible({ timeout: 10000 });
  await page.unroute(`**/api/admin/event-templates/${gone.id}/restore`);
  await refuse(page, `**/api/admin/event-templates/${gone.id}/restore`, "POST", BROKEN);
  await restore.click();
  await expect(errorToast(page, "Could not restore the template.")).toBeVisible({ timeout: 10000 });
  await page.unroute(`**/api/admin/event-templates/${gone.id}/restore`);
  expect(await deleted(), "still deleted").toBe(true);

  // ── Protect.
  await refuse(page, `**/api/admin/event-templates/${keep.id}/protect`, "POST", BROKEN);
  await openMenu();
  await menu.locator('[data-action="tpl-protect"]').click();
  await expect(errorToast(page, "Could not change the protection.")).toBeVisible({ timeout: 10000 });
  await page.unroute(`**/api/admin/event-templates/${keep.id}/protect`);
  expect((await live()).protected, "not protected").toBeFalsy();

  // ── Delete.
  await refuse(page, `**/api/admin/event-templates/${keep.id}`, "DELETE", BROKEN);
  await openMenu();
  await menu.locator('[data-action="tpl-delete"]').click();
  await page.locator("#modal-overlay #modal-confirm-btn").click();
  await expect(errorToast(page, "Could not delete the template.")).toBeVisible({ timeout: 10000 });
  await page.unroute(`**/api/admin/event-templates/${keep.id}`);
  expect(await live(), "still listed").toBeTruthy();

  // CONTROL — let through, Restore and Protect reach the server.
  await restore.click();
  await expect(page.locator("#toast-stack")).toContainText("Restored template", { timeout: 10000 });
  expect(await deleted(), "the control's restore reached the server").toBe(false);
  await openMenu();
  await menu.locator('[data-action="tpl-protect"]').click();
  await expect.poll(async () => (await live()).protected, { timeout: 10000, message: "the control's protect reached the server" }).toBeTruthy();
});
