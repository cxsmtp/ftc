// @ts-check
//
// The platform certificate designer is reachable for every role that may save
// it (operator ruling, 29 Oct 2026: admins AND superadmins edit certificate
// designs, event admins preview only). Before, the Settings item needed
// `settings.edit` (superadmin only), so a regular admin, who holds
// `certificates.design`, could edit the platform design through the API alone.
//
// Settings opens for any permission one of its cards' routes checks
// (ui/nav.js settingsOffered), and each card shows to a role holding what its
// own routes check (SETTINGS_CARD_PERMISSIONS; operator ruling, 14 Nov 2026:
// a regular admin, who may read them, sees Retention and Alerts). Locked here:
//   1. a regular admin opens Settings → Branding (the certificate design), saves a design and
//      the server reads it back; the cards they see are exactly the ones their
//      routes allow (by heading text), with a SUPERADMIN control that sees the
//      superadmin-only cards;
//   2. an event admin gets neither the Settings item nor the designer card, and
//      the route refuses them (the offer is the route's predicate).
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { adminLogin, loginViaApi, openSettingsSection } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const settingsItem = (page) =>
  page.locator("li:has(> [data-action='admin-tab'][data-tab-id='admin-settings-tab'])");

// The headings of the Settings cards this session is shown (display not none),
// in markup order — the VALUE a reader sees, whichever section is on screen.
const shownCardHeadings = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#admin-settings-tab .settings-card")]
    .filter((c) => c.id !== "settings-load-failure" && c.style.display !== "none")
    .map((c) => (c.querySelector(".settings-heading")?.textContent || "").trim()));

// Every card heading only a superadmin may see among the built-in roles (its
// route is settings.edit, ops.email, ops.cxone or the built-in session).
const SUPERADMIN_ONLY = ["Platform name", "New accounts", "Outbound email", "Unsubscribe List",
  "Global Default CheckmarxOne Integration"];
// The cards a regular admin may read (ops.retention_view, ops.alerts, settings.view).
const ADMIN_READS = ["Event history retention", "Blocked-address alerts", "Platform health"];

async function panelLogin(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `${email} had no admin session: ${meR.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']")
    .first().waitFor({ state: "visible", timeout: 30000 });
  return meR.json();
}

async function openSettings(page) {
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await page.locator("#admin-settings-tab").waitFor({ state: "visible", timeout: 15000 });
  // The loader has run once the section list is derived from the cards.
  await expect(page.locator("#settings-section-list li:not([hidden])").first()).toBeAttached({ timeout: 15000 });
}

let fx;
test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const admin = await makeParticipant(sa, csrf, "certadmin");
  const role = await sa.post(`/api/admin/participants/${admin.id}/role`, { headers: H(csrf), data: { role: "admin" } });
  expect(role.ok(), `promote to admin: ${role.status()} ${await role.text()}`).toBeTruthy();
  const ea = await makeParticipant(sa, csrf, "certea");
  const comp = await makeCompetition(sa, csrf, "certea-event");
  await grantEventAdmin(sa, csrf, comp.id, ea.id);
  fx = { sa, csrf, admin, ea, comp };
});

test("a REGULAR admin opens the platform certificate designer from Settings, saves, and reads it back; no superadmin card shows", async ({ page }) => {
  const me = await panelLogin(page, fx.admin.email);
  expect(me.isAdmin && !me.isSuperAdmin && !me.isEventAdmin, "precondition: a regular admin").toBe(true);
  expect(me.permissions, "precondition: the role holds certificates.design").toContain("certificates.design");
  expect(me.permissions, "precondition: …and NOT settings.edit").not.toContain("settings.edit");

  await expect(settingsItem(page), "Settings is offered to a regular admin").toBeVisible();
  await openSettings(page);
  const headings = await shownCardHeadings(page);
  for (const h of SUPERADMIN_ONLY) expect(headings, `a regular admin is shown no "${h}" card`).not.toContain(h);
  expect(headings, "the designer card is shown").toContain("Certificate design");
  for (const h of ADMIN_READS) expect(headings, `a regular admin is shown the "${h}" card, which its route lets it read`).toContain(h);
  expect(await page.locator("#breakglass-account-card").evaluate((el) => el.style.display), "no break-glass card").toBe("none");
  // No section offers the platform-name setting: neither its card heading nor
  // its input is shown in any section this admin can open (the name itself is
  // public, in the header).
  const listed = await page.locator("#settings-section-list li:not([hidden]) [data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
  for (const key of listed) {
    await openSettingsSection(page, key);
    const txt = await page.locator(`#admin-settings-tab .settings-section[data-settings-section="${key}"]`).innerText();
    for (const h of SUPERADMIN_ONLY) expect(txt, `section ${key} shows no "${h}"`).not.toContain(h);
    expect(await page.locator("#settings-platform-name").isVisible(), `section ${key}: the platform name input is not on screen`).toBe(false);
  }
  expect(listed, "only the sections this admin may use are listed").toEqual(["cxone-audit", "general", "branding", "email", "updates", "health", "about"]);

  // Open the designer and save a design.
  const title = `ADMIN DESIGN ${Date.now() % 100000}`;
  try {
    await openSettingsSection(page, "branding");
    await page.locator("[data-cw-open]").click();
    const box = page.locator("#cert-config-body");
    const field = box.locator("#cw-t-title");
    await expect(field).toBeAttached({ timeout: 15000 });
    // Open the section that holds the field (one panel is open at a time).
    const panelId = await field.evaluate((el) => el.closest(".cw-panel").id.replace("cw-panel-", ""));
    if (!(await field.isVisible())) await box.locator(`[data-cw-panel="${panelId}"]`).click();
    await expect(field, "the designer is editable for an admin").toBeEditable({ timeout: 15000 });
    await expect(box.locator(".cw-ro-note"), "no read-only note for an admin").toHaveCount(0);
    await field.fill(title);
    const put = page.waitForResponse((r) => r.url().endsWith("/api/admin/certificate-config") && r.request().method() === "PUT");
    await box.locator('[data-cw="save"]').click();
    const res = await put;
    expect(res.status(), "the save is accepted").toBe(200);
    await expect(page.locator(".toast").filter({ hasText: "Certificate design saved" })).toBeVisible();
    // Read back, as this admin and as the superadmin.
    const mine = await (await page.request.get("/api/admin/certificate-config")).json();
    expect(mine.global.text.title, "the admin reads its own save back").toBe(title);
    const sas = await (await fx.sa.get("/api/admin/certificate-config")).json();
    expect(sas.global.text.title, "the stored platform layer holds it").toBe(title);
  } finally {
    const del = await fx.sa.delete("/api/admin/certificate-config", { headers: H(fx.csrf) });
    expect(del.ok(), `restore the platform design: ${del.status()}`).toBeTruthy();
    const after = await (await fx.sa.get("/api/admin/certificate-config")).json();
    expect(after.global, "the platform layer is back to defaults").toEqual({});
  }
});

test("CONTROL — a SUPERADMIN is shown the superadmin-only cards", async ({ page }) => {
  await adminLogin(page);
  await openSettings(page);
  await expect.poll(() => shownCardHeadings(page), { timeout: 15000 }).toEqual(expect.arrayContaining(["Platform name", "Global Default CheckmarxOne Integration", "Unsubscribe List", "Certificate design"]));
  const listed = await page.locator("#settings-section-list li:not([hidden]) [data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
  expect(listed, "a superadmin's list holds the superadmin sections").toEqual(expect.arrayContaining(["general", "signin", "cxone-audit", "branding"]));
});

test("an EVENT admin gets no Settings item and no platform designer; the route refuses them too", async ({ page }) => {
  const me = await panelLogin(page, fx.ea.email);
  expect(me.isEventAdmin, "precondition: an event admin").toBe(true);
  expect(me.permissions, "precondition: no certificates.design").not.toContain("certificates.design");
  // CONTROL — the sidebar really rendered for them.
  await expect(page.locator("li:has(> [data-tab-id='admin-tasks-tab'])")).toBeVisible();
  await expect(settingsItem(page), "Settings is hidden for an event admin").toBeHidden();
  // The card's own gate, driven directly (the item that would load it is absent).
  const shown = await page.evaluate(async () => {
    const m = await import("/js/features/certificate-wizard.js");
    m.loadPlatformCertificateCard();
    return document.getElementById("cert-config-card").style.display;
  });
  expect(shown, "the platform designer card stays hidden for an event admin").toBe("none");
  const r = await page.request.get("/api/admin/certificate-config");
  expect(r.status(), "the route refuses an event admin (the same predicate)").toBe(403);
});
