// @ts-check
//
// SETTINGS → EMAIL (SMTP): THE MAIL SERVER CARD (features/settings-admin.js
// loadSmtpCard; owner decision, 27 Nov 2026).
//
// Every viewer who may open the Email section sees the server in use at a glance
// (host and port, security, username, password set or not, sender, each with
// where it comes from, and the last health check); a superadmin also gets the
// form (Test with these values, Save, Remove saved settings); everyone else the
// same facts read-only with "Only a superadmin can change this." The password is
// never in the page. axe-clean in both states.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { loginViaApi, openSettingsSection, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

let ADMIN = null;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    ADMIN = await makeParticipant(sa, csrf, "smtpuiadmin");
    const a = await sa.patch(`/api/admin/users/${ADMIN.id}/role`, { headers: H(csrf), data: { role: "admin" } });
    expect(a.ok(), `admin role: ${await a.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
});

async function openEmail(page, email, password) {
  await loginViaApi(page, email, password);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await page.locator("#admin-settings-tab").waitFor({ state: "visible", timeout: 15000 });
  await openSettingsSection(page, "email");
  await expect(page.locator("#smtp-settings-card")).toBeVisible();
  await expect(page.locator("#smtp-settings-body .smtp-facts")).toBeVisible({ timeout: 15000 });
}
const fact = (page, label) => page.locator("#smtp-settings-body .smtp-facts > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");

async function axeCard(page, what) {
  const res = await new AxeBuilder({ page }).include("#smtp-settings-card").analyze();
  const bad = res.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe: ${what}`).toEqual([]);
}

test("an admin sees the server in use and where each value comes from, read-only", async ({ page }) => {
  const reads = [];
  page.on("request", (r) => { if (r.url().includes("/api/admin/smtp-settings")) reads.push(r.method()); });
  await openEmail(page, ADMIN.email, PARTICIPANT_PASS);
  const g = await (await page.request.get("/api/admin/smtp-settings")).json();
  await expect(fact(page, "Server")).toContainText(`${g.in_use.host}:${g.in_use.port}`);
  for (const label of ["Server", "Security", "Username", "Password"]) {
    await expect(fact(page, label), `${label}: its source`).toContainText("From the server’s environment");
  }
  await expect(fact(page, "Password")).toContainText(g.in_use.password_set ? "Set (never shown)" : "Not set");
  await expect(fact(page, "Sender address")).toContainText(g.in_use.sender);
  await expect(fact(page, "Last check")).toContainText(/Not checked yet|last check/);
  await expect(page.locator("#smtp-settings-body"), "the read-only reason").toContainText("Only a superadmin can change this.");
  await expect(page.locator("#smtp-settings-body input, #smtp-settings-body select, #smtp-settings-body [data-action^='smtp-']"), "no form").toHaveCount(0);
  // A built-in admin holds no ops.email: no test send anywhere in the section.
  await expect(page.locator('#admin-settings-tab [data-action="send-test-email"]:visible'), "no test send without ops.email").toHaveCount(0);
  await expect(page.locator("#email-test-card")).toBeHidden();
  expect(reads.every((m) => m === "GET"), "only the read").toBe(true);
  await axeCard(page, "read-only");
});

test("a superadmin tests, saves and removes the server from the form; the password never reaches the page", async ({ page }) => {
  await openEmail(page, "superadmin");
  await expect(page.locator("#smtp-settings-body"), "no read-only note for the superadmin").not.toContainText("Only a superadmin can change this.");
  // ONE test send for the server in use and ONE relay status: the old Outbound
  // email card is not shown beside the card (owner decision, 27 Nov 2026).
  await expect(page.locator('#admin-settings-tab [data-action="send-test-email"]:visible')).toHaveCount(1);
  await expect(page.locator('#smtp-settings-body [data-action="send-test-email"]')).toBeVisible();
  await expect(page.locator("#email-test-card")).toBeHidden();
  await expect(page.locator("#admin-settings-tab .settings-section[data-settings-section=email]"), "one relay status").not.toContainText("The mail relay has not been checked");
  await expect(page.locator("#smtp-host"), "the form starts folded").toBeHidden();
  await page.locator("#smtp-change > summary").click();
  await expect(page.locator("#smtp-host")).toBeVisible();
  await axeCard(page, "the form");
  // A test with unsaved values reaches the server: the shared relay is dead by
  // design, so the answer is the relay's refusal, shown, and nothing is saved.
  await page.locator("#smtp-host").fill("127.0.0.1");
  await page.locator("#smtp-port").fill("9");
  await page.locator("#smtp-security").selectOption("starttls");
  await page.locator("#smtp-username").fill("");
  await page.locator("#smtp-sender").fill("ui-sender@acme.test");
  await page.locator("#smtp-test-to").fill("ui-test@acme.test");
  const testAnswer = page.waitForResponse((r) => r.url().endsWith("/api/admin/smtp-settings/test"));
  await page.locator("[data-action='smtp-test']").click();
  const t = await testAnswer;
  expect(t.status(), "the dead relay refuses the test").toBe(502);
  expect(JSON.parse(t.request().postData() || "{}"), "the UNSAVED values were sent").toMatchObject({ host: "127.0.0.1", port: "9", sender: "ui-sender@acme.test", to: "ui-test@acme.test" });
  await expect(page.locator(".toast").last()).toContainText("did not take the test email");
  await expect(fact(page, "Sender address"), "nothing was saved").toContainText("From the server’s environment");

  // Save: confirmed, then the card shows the saved server as set in the app.
  await page.locator("#smtp-password").fill("Ui-Typed-Secret-55");
  await page.locator("#smtp-username").fill("ui-user");
  await page.locator("[data-action='smtp-save']").click();
  await expect(page.locator("#modal-overlay")).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/admin/smtp-settings") && r.request().method() === "PUT");
  await page.locator("#modal-confirm-btn").click();
  expect((await saved).status()).toBe(200);
  await expect(fact(page, "Sender address")).toContainText("ui-sender@acme.test");
  for (const label of ["Server", "Username", "Password", "Sender address"]) {
    await expect(fact(page, label), `${label}: its source`).toContainText("Set in the app");
  }
  await expect(fact(page, "Password")).toContainText("Set (never shown)");
  expect(await page.content(), "the password is nowhere in the page").not.toContain("Ui-Typed-Secret-55");
  await expect(page.locator("#smtp-password"), "the password box comes back empty").toHaveValue("");

  // Remove: back to the environment.
  await page.locator("#smtp-change > summary").click();
  await page.locator("[data-action='smtp-remove']").click();
  const removed = page.waitForResponse((r) => r.url().endsWith("/api/admin/smtp-settings") && r.request().method() === "DELETE");
  await page.locator("#modal-confirm-btn").click();
  expect((await removed).status()).toBe(200);
  await expect(fact(page, "Server")).toContainText("From the server’s environment");
  await expect(page.locator("[data-action='smtp-remove']"), "nothing saved, nothing to remove").toHaveCount(0);
});
