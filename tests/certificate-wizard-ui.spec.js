// @ts-check
// The certificate designer (public/js/features/certificate-wizard.js), operator
// rulings of 29 Oct 2026:
//   - each section is a disclosure button over a [hidden] panel, so a closed
//     panel takes no space (they overlapped as <details>);
//   - Save design is never drawn disabled; a press with nothing changed says so;
//   - the Email section holds the five per-tier thank-yous and the LinkedIn post;
//   - an event admin gets the designer read-only, with the one-line reason;
// and of 24 Nov 2026: the Verification QR box is disabled, with its reason,
// while Certificate ID is off (the QR is printed only beside the ID).
const { test, expect } = require("./isolated-test");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { BASE } = require("./helpers");

test.use({ baseURL: BASE });

test("platform designer: [hidden] panels, Save never disabled, the Email section's fields", async ({ page }) => {
  await adminLogin(page);
  await clickTab(page, "Settings");
  await require("./ui-admin-helpers").openSettingsSection(page, "branding");
  const open = page.locator("[data-cw-open]");
  await expect(open).toBeVisible({ timeout: 15000 });
  await open.click();
  const box = page.locator("#cert-config-body");
  await expect(box.locator(".cw-sec")).toHaveCount(5, { timeout: 15000 });
  // The designer's "?" tip is wired and explains the scope.
  const tip = box.getByRole("button", { name: "About Certificate design" });
  await expect(tip).toBeVisible();
  await tip.click();
  await expect(box.getByRole("note").filter({ hasText: "overrides it field by field" })).toBeVisible();

  // Only the first panel is open; every other one is [hidden] and takes no space.
  const panels = box.locator(".cw-panel");
  await expect(panels).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    const p = panels.nth(i);
    if (i === 0) { await expect(p).toBeVisible(); continue; }
    await expect(p).toHaveAttribute("hidden", "");
    expect(await p.evaluate((el) => el.getBoundingClientRect().height), "a closed panel has no box").toBe(0);
  }
  // The disclosure button opens and closes its own panel.
  const emailBtn = box.locator('[data-cw-panel="email"]');
  await expect(emailBtn).toHaveAttribute("aria-expanded", "false");
  await emailBtn.click();
  await expect(emailBtn).toHaveAttribute("aria-expanded", "true");
  const email = box.locator("#cw-panel-email");
  await expect(email).toBeVisible();
  for (const k of ["message_gold", "message_silver", "message_bronze", "message_participation", "message_completion", "linkedin_post"]) {
    await expect(email.locator(`#cw-e-${k}`), `${k} is editable`).toBeEditable();
  }
  await expect(email.locator("#cw-e-linkedin_hashtags")).toBeEditable();
  await expect(email.locator("#cw-e-message_gold")).toHaveValue(/1st place/);
  await emailBtn.click();
  await expect(email).toBeHidden();

  // Save is a live control even with nothing to save, and says so when pressed.
  const save = box.locator('[data-cw="save"]');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".toast").filter({ hasText: "Nothing has changed" })).toBeVisible();

  // The preview replaces its vector skeleton once it renders.
  await expect(box.locator("#cw-img")).toBeVisible({ timeout: 20000 });
  await expect(box.locator("#cw-skel")).toBeHidden();
});

// The certificate draws its QR only beside the ID (lib/badge.js), so the QR box
// does nothing while Certificate ID is off: it is disabled with the reason
// beside it, live as the ID box is pressed and on load from a stored design
// (operator ruling, 24 Nov 2026). Controls: every other box stays enabled, and
// the QR box keeps its stored tick for when the ID returns.
// clickTab waits for the admin page before pressing a sidebar item: the items are
// static markup, attached before boot knows who is signed in, and a press then
// ran the Settings loader with no role facts, leaving every card hidden (once
// under full-suite load, after a reload). A slow /api/admin/me makes it certain.
test("clickTab presses a sidebar item only once the admin page shows: a Settings press during a slow boot still shows its cards", async ({ page }) => {
  await adminLogin(page);
  await page.route("**/api/admin/me", async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  try {
    await page.reload();
    await clickTab(page, "Settings");
    await require("./ui-admin-helpers").openSettingsSection(page, "branding");
    await expect(page.locator("#cert-config-card"), "the designer card is offered once the role is known").toBeVisible();
  } finally { await page.unroute("**/api/admin/me"); }
});

test("the Verification QR box is disabled, with its reason, while Certificate ID is off (live and on load)", async ({ page }) => {
  const openShow = async () => {
    await clickTab(page, "Settings");
    await require("./ui-admin-helpers").openSettingsSection(page, "branding");
    const open = page.locator("[data-cw-open]");
    await expect(open).toBeVisible({ timeout: 15000 });
    await open.click();
    const box = page.locator("#cert-config-body");
    await box.locator('[data-cw-panel="show"]').click();
    return box;
  };
  await adminLogin(page);
  try {
    let box = await openShow();
    const qr = () => box.locator('[data-sec="show"][data-key="qr"]');
    const code = () => box.locator('[data-sec="show"][data-key="code"]');
    const note = () => box.locator("#cw-qr-note");
    await expect(qr()).toBeEnabled();
    await expect(qr(), "precondition: the default design prints the QR").toBeChecked();
    await expect(note()).toBeHidden();
    // Live: the ID off holds the QR box, its reason beside it ...
    await code().uncheck();
    await expect(qr()).toBeDisabled();
    await expect(qr(), "its stored tick is kept").toBeChecked();
    await expect(note()).toBeVisible();
    await expect(note()).toHaveText("The QR code prints beside the certificate ID. Turn on Certificate ID to print it.");
    await expect(qr()).toHaveAttribute("aria-describedby", "cw-qr-note");
    for (const k of ["logo", "score", "date", "code", "pattern", "shield", "medal"]) {
      await expect(box.locator(`[data-sec="show"][data-key="${k}"]`), `CONTROL: ${k} stays enabled`).toBeEnabled();
    }
    // ... and the ID on again frees it.
    await code().check();
    await expect(qr()).toBeEnabled();
    await expect(note()).toBeHidden();
    await expect(qr()).not.toHaveAttribute("aria-describedby", /./);
    // On load: a SAVED design with the ID off opens with the QR box held.
    await code().uncheck();
    const saved = page.waitForResponse(r => r.url().endsWith("/api/admin/certificate-config") && r.request().method() === "PUT");
    await box.locator('[data-cw="save"]').click();
    expect((await saved).status()).toBe(200);
    await page.reload();
    box = await openShow();
    await expect(code()).not.toBeChecked();
    await expect(qr()).toBeDisabled();
    await expect(note()).toBeVisible();
  } finally {
    // The global design's default is no stored layer (a test restores the
    // default, never what it found). Through this page's own session: a second
    // built-in superadmin sign-in would end it.
    const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const del = await page.request.delete("/api/admin/certificate-config", { headers: { "x-csrf-token": t } });
    expect(del.ok(), await del.text()).toBe(true);
  }
});

test("an event admin's designer is read-only, with the one-line reason", async ({ page }) => {
  await adminLogin(page);
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15000 });
  // Drive the renderer with the event-admin flag set, on a scratch box: the
  // reason and the disabled inputs come from the module itself, not the caller.
  await page.evaluate(async () => {
    const m = await import("/js/features/certificate-wizard.js");
    const box = document.createElement("div");
    box.id = "cw-ea-probe";
    document.body.appendChild(box);
    // The offer reads the session's permissions first (an event admin holds
    // certificates.view, never certificates.design).
    const perms = window.S.permissions;
    window.S.isEventAdmin = true;
    window.S.isSuperAdmin = false;
    window.S.permissions = ["panel.access", "certificates.view", "certificates.send"];
    try { await m.renderCertificateWizard(box, {}); }
    finally { window.S.isEventAdmin = false; window.S.isSuperAdmin = true; window.S.permissions = perms; }
  });
  const probe = page.locator("#cw-ea-probe");
  await expect(probe.locator(".cw-ro-note")).toContainText("Only an administrator can change certificate designs");
  await expect(probe.locator('[data-cw="save"]'), "no Save for an event admin").toHaveCount(0);
  await expect(probe.locator('[data-cw="download"]'), "CONTROL: the download stays").toHaveCount(1);
  const inputs = probe.locator(".cw-edit input, .cw-edit textarea");
  expect(await inputs.count()).toBeGreaterThan(5);
  expect(await inputs.evaluateAll((els) => els.every((e) => e.disabled)), "every field is read-only").toBe(true);
});

// Found by the 8.17.0 page re-check: the Settings designer sat in ONE column of
// the two-column settings bento, so its preview drew at about 220 px and every
// section label wrapped. It spans the whole row. Geometry, with a CONTROL card
// that still takes one column (so a bento collapsed to one column cannot pass).
// Settings is now two panes: the designer fills the content column beside the
// section list. CONTROL: the content column really is narrower than the pane
// (the list takes its share), so "fills the column" is not "fills the page".
test("the Settings designer spans the whole content column beside the section list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await clickTab(page, "Settings");
  await require("./ui-admin-helpers").openSettingsSection(page, "branding");
  const open = page.locator("[data-cw-open]");
  await expect(open).toBeVisible({ timeout: 15000 });
  await open.click();
  await expect(page.locator("#cert-config-body #cw-img")).toBeVisible({ timeout: 20000 });
  const g = await page.evaluate(() => {
    const w = (el) => el.getBoundingClientRect().width;
    return { bento: w(document.querySelector("#admin-settings-tab .settings-bento")), card: w(document.getElementById("cert-config-card")),
      pane: w(document.getElementById("admin-settings-tab")), nav: w(document.querySelector("#admin-settings-tab .settings-nav")),
      preview: w(document.getElementById("cw-img")) };
  });
  expect(g.card, JSON.stringify(g)).toBeGreaterThan(g.bento - 2);
  expect(g.nav, `CONTROL: the section list takes a column of its own: ${JSON.stringify(g)}`).toBeGreaterThan(150);
  expect(g.bento, `CONTROL: the content column is narrower than the pane: ${JSON.stringify(g)}`).toBeLessThan(g.pane - 150);
  expect(g.preview, `the preview is drawn at a readable size: ${JSON.stringify(g)}`).toBeGreaterThan(400);
});
