// @ts-check
//
// SETTINGS → CXONE API AUDIT: A REAL TABLE OF EVERY CHECKMARX ONE CALL
// (features/settings-admin.js loadCxoneAuditCard; owner decision, 27 Nov 2026).
//
// The rows are the audit trail's own (GET /api/admin/audit narrowed by
// `event_type` to the Checkmarx One activity), so each is scoped exactly as the
// Audit page scopes it. Planted records by value, as tests/audit-row-permissions
// plants them: an account created and added to a group, one linked to an
// existing account, a failed set-up with its classified error, a deferred one,
// and the removal of a deleted participant's account. Held:
//   • each shows its time, activity, event, person, result and detail;
//   • a DECOY (a sign-in, and the Checkmarx One SETTINGS change) never shows;
//   • the read names exactly the Checkmarx One activity keys;
//   • the table is the table component's (Columns, heading filters) and pages
//     with the shared segment pager;
//   • the removals card stays in the section; axe-clean.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, TEST_DB_PATH, PARTICIPANT_PASS } = require("./helpers");
const { loginViaApi, openSettingsSection, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const T = Date.now().toString(36);
const W = {};
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    W.comp = await makeCompetition(sa, csrf, `cx-audit-${T}`);
    W.p = await makeParticipant(sa, csrf, `cxaud${T}`);
  } finally { await sa.dispose(); }
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const ue = db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
    const oe = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
    const at = (m) => new Date(Date.now() - m * 60_000).toISOString();
    W.at = { created: at(5), linked: at(4), failed: at(3), deferred: at(2), removed: at(1) };
    ue.run(`cxa1-${T}`, W.p.id, "cxone_provisioned", "system", W.at.created, JSON.stringify({ competition_id: W.comp.id, username: `cx_${T}`, already_existed: false, success: true, cxone_user_id: "11111111-1111-4111-8111-111111111111", group_name: `Readers ${T}`, group_assigned: true }));
    ue.run(`cxa2-${T}`, W.p.id, "cxone_provisioned", "system", W.at.linked, JSON.stringify({ competition_id: W.comp.id, username: `cx_${T}`, already_existed: true, success: true, matched_by: "email" }));
    ue.run(`cxa3-${T}`, W.p.id, "cxone_provisioned", "system", W.at.failed, JSON.stringify({ competition_id: W.comp.id, success: false, error: `HTTP 409 conflict ${T}` }));
    ue.run(`cxa4-${T}`, W.p.id, "cxone_provisioned", "system", W.at.deferred, JSON.stringify({ competition_id: W.comp.id, success: false, deferred: "removal_in_flight", retry_scheduled: true, retry_attempt: 2 }));
    oe.run(`cxa5-${T}`, "user", `gone-${T}`, "cxone_realm_account_withdrawn", "system", W.at.removed, W.comp.id, null, JSON.stringify({ competition_id: W.comp.id, cxone_user_id: "22222222-2222-4222-8222-222222222222", attempts: 1 }));
    // DECOYS: not calls to Checkmarx One.
    ue.run(`cxa6-${T}`, W.p.id, "login_success", "system", at(0.5), JSON.stringify({ method: "login_code", decoy: T }));
    db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
      .run(`cxa7-${T}`, "cxone_config", "cxone_config_changed", "superadmin", at(0.4), JSON.stringify({ decoy: T }));
  } finally { db.close(); }
});

async function openCxAudit(page) {
  await loginViaApi(page, "superadmin");
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await page.locator("#admin-settings-tab").waitFor({ state: "visible", timeout: 15000 });
  await openSettingsSection(page, "cxone-audit");
  await expect(page.locator("#cxone-audit-body tr").first()).toBeVisible({ timeout: 15000 });
}
const rowOf = (page, text) => page.locator("#cxone-audit-body tr").filter({ hasText: text });

test("every Checkmarx One call shows its outcome by value, and nothing else is listed", async ({ page }) => {
  const reads = [];
  page.on("request", (r) => { if (r.url().includes("/api/admin/audit?")) reads.push(new URL(r.url())); });
  await openCxAudit(page);
  const ev = W.comp.name;
  const created = rowOf(page, `added to group Readers ${T}`);
  await expect(created).toHaveCount(1);
  await expect(created).toContainText("Account created");
  await expect(created).toContainText(ev);
  await expect(rowOf(page, "matched by email")).toContainText("Linked to an existing account");
  const failed = rowOf(page, `HTTP 409 conflict ${T}`);
  await expect(failed).toContainText("Failed");
  await expect(failed).toContainText(ev);
  await expect(rowOf(page, "removal_in_flight")).toContainText("Deferred");
  await expect(rowOf(page, "removal_in_flight")).toContainText("retry 2 scheduled");
  const removed = page.locator("#cxone-audit-body tr").filter({ hasText: "Checkmarx One account removed" }).filter({ hasText: ev });
  await expect(removed).toHaveCount(1);
  await expect(removed).toContainText("Deleted participant");
  // DECOYS absent (by their planted marker and their activity).
  await expect(page.locator("#cxone-audit-body")).not.toContainText("Signed in");
  await expect(page.locator("#cxone-audit-body")).not.toContainText("Checkmarx One settings changed");
  // The read names the Checkmarx One activity keys, and only those.
  const read = reads.find((u) => u.searchParams.get("event_type"));
  expect(read, "the table read the audit trail").toBeTruthy();
  const keys = read.searchParams.get("event_type").split(",");
  expect(keys).toContain("cxone_provisioned");
  expect(keys).toContain("cxone_realm_account_withdrawn");
  expect(keys.every((k) => k.startsWith("cxone_")), "only Checkmarx One activity").toBe(true);
  expect(keys).not.toContain("cxone_config_changed");
  // The table component's controls, and the shared pager.
  await expect(page.locator("#cxone-audit-card .tcol-bar")).toBeVisible();
  await expect(page.locator("#cxone-audit-pagination-bar .page-info")).toContainText(/Page 1 of/);
  await expect(page.locator("#cxone-withdrawals-card"), "the removals card keeps its place in the section")
    .toHaveCount(1);
  expect(await page.locator("#cxone-withdrawals-card").evaluate((c) => c.closest(".settings-section")?.dataset.settingsSection)).toBe("cxone-audit");
});

test("the table pages with the shared pager: Next reads below the first page", async ({ page }) => {
  await openCxAudit(page);
  await page.locator("#cxone-audit-pagination-bar select").selectOption("30");
  const total = await page.evaluate(async () => (await (await fetch("/api/admin/audit?event_type=cxone_provisioned,cxone_realm_account_withdrawn&limit=30")).json()).total);
  const next = page.locator("#cxone-audit-pagination-bar [data-action='cxone-audit-page-next']");
  if (total > 30) await expect(next).toBeEnabled(); else await expect(next, "one page holds them all").toBeDisabled();
  await expect(page.locator("#cxone-audit-pagination-bar [data-action='cxone-audit-page-prev']"), "page 1 has no Prev").toBeDisabled();
});

test("CxOne API audit is axe-clean", async ({ page }) => {
  await openCxAudit(page);
  const res = await new AxeBuilder({ page }).include("#cxone-audit-card").analyze();
  const bad = res.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("a role without audit.view gets no CxOne API audit section (CONTROL: with it, the table)", async ({ page, browser }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let who, reader;
  try {
    const r = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `No audit ${T}`, scope_mode: "all", permissions: ["settings.view"] } });
    const r2 = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `Audit reader ${T}`, scope_mode: "all", permissions: ["settings.view", "audit.view", "participants.view", "events.view"] } });
    who = await makeParticipant(sa, csrf, `cxnoaud${T}`);
    reader = await makeParticipant(sa, csrf, `cxaud${T}r`);
    await sa.patch(`/api/admin/users/${who.id}/role`, { headers: H(csrf), data: { role: (await r.json()).role.id } });
    await sa.patch(`/api/admin/users/${reader.id}/role`, { headers: H(csrf), data: { role: (await r2.json()).role.id } });
  } finally { await sa.dispose(); }
  await loginViaApi(page, who.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await expect(page.locator("#settings-section-list li:not([hidden])").first()).toBeAttached({ timeout: 15000 });
  await expect(page.locator('#settings-section-list li:not([hidden]) [data-section="cxone-audit"]')).toHaveCount(0);
  const ctx = await browser.newContext({ baseURL: BASE });
  const p2 = await ctx.newPage();
  try {
    await loginViaApi(p2, reader.email, PARTICIPANT_PASS);
    await p2.goto("/");
    await p2.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
    await openSettingsSection(p2, "cxone-audit");
    await expect(p2.locator("#cxone-audit-body"), "CONTROL: a reader with audit.view sees the planted rows").toContainText(`HTTP 409 conflict ${T}`, { timeout: 15000 });
  } finally { await ctx.close(); }
});
