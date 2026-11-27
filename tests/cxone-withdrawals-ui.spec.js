// @ts-check
// v8.12.7 (F2) — the CLIENT half of Checkmarx One account removal: the delete
// confirm names the account the platform created, the toast reports the SERVER's
// two counts, the superadmin's removals card offers only what the server will
// accept, and the header banner reaches a superadmin and nobody else.
//
// Everything here is driven against the REAL server. Rows are PLANTED through a
// better-sqlite3 handle on the worker server's database, exactly as
// tests/cxone-withdrawals.api.spec.js does (no app module is required at module
// scope — db.js opens its file at require time, v7.20.2), so every string the UI
// renders comes from a real response: `has_cxone_realm_account` from the
// participants list, the counts from the DELETE, the remedy and `overridable`
// from GET /api/admin/cxone/withdrawals, the attention count from the alerts poll.
// Mocking any of them would test the client against a shape the server may not send.
//
// Every positive carries its CONTROL, or it is satisfied by a build that renders
// the sentence, the button or the banner unconditionally.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, loginViaApi, clickTab, openSettingsSection, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `cxwu${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const nowIso = () => new Date().toISOString();
const CX_NOTE = "The platform created a Checkmarx One account for them; it will try to remove it from the customer's tenant too.";
// Both confirms that start a removal: the runner may hand the account to its owner instead.
const HANDOVER_NOTE = "If a participant still on the platform turns out to own it — linked to it, or with its email address as their confirmed primary address and the same first and last names — it passes to them instead and nothing is removed.";

function dbGet(sql, ...a) {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
}
function dbRun(sql, ...a) {
  const d = new Database(TEST_DB_PATH, { timeout: 5000 });
  try { return d.prepare(sql).run(...a); } finally { d.close(); }
}

/** One ledger row: by default an account THIS installation created a minute ago
 *  for `userId`, in a confirmed realm, not yet marked for removal. */
function plant(userId, over = {}) {
  const row = {
    cxone_user_id: crypto.randomUUID(), iam_origin: "https://iam.checkmarx.net", tenant: "tenant1",
    realm_confirmed: 1, user_id: userId, competition_id: null, created_username: uniq(),
    provenance: "created", provenance_at: nowIso(), instance_origin: new URL(BASE).origin,
    recorded_at: nowIso(), pending_since: null, deletion_source: null, attempts: 0,
    first_failed_at: null, next_attempt_at: null, last_error: null, held_reason: null, attention: 0,
    override_reason: null, override_by: null, override_at: null, transferred_at: null,
    claim_token: null, claimed_at: null, given_up_at: null, ...over,
  };
  const cols = Object.keys(row);
  dbRun(`INSERT INTO cxone_realm_accounts (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`, row);
  return row.cxone_user_id;
}
const goneUser = () => `gone-${crypto.randomUUID()}`;
const plantPending = (over = {}) => plant(goneUser(), { pending_since: nowIso(), deletion_source: "cascade",
  next_attempt_at: nowIso(), ...over });
const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600e3).toISOString();
const unplant = (...ids) => dbRun(`DELETE FROM cxone_realm_accounts WHERE cxone_user_id IN (${ids.map(() => "?").join(",")})`, ...ids);
/** A provisioning-history line naming an account the platform MATCHED rather than
 *  created — what the DELETE counts as left in place. */
const planMatched = (userId) => dbRun(
  "INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)",
  crypto.randomUUID(), userId, "cxone_provisioned", "system", nowIso(),
  JSON.stringify({ success: true, cxone_user_id: crypto.randomUUID(), username: uniq(), already_existed: true, matched_by: "email" }));

async function mkParticipant(sa, label) {
  const email = `${label}@company.example`;
  const { api, csrf } = await freshCtx();
  try {
    const reg = await registerPost(api, "/api/register", { headers: H(csrf), data: {
      firstName: "Withdraw", lastName: "Ui", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "Testville", password: PARTICIPANT_PASS,
    }});
    expect(reg.status(), `register ${email}: ${await reg.text()}`).toBe(200);
  } finally { await api.dispose(); }
  const u = dbGet("SELECT id FROM users WHERE email=?", email);
  expect(u, `${email} must exist after register`).toBeTruthy();
  // Order matters: POST /approve REFUSES an unverified account.
  expect((await sa.api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(sa.csrf) })).ok()).toBeTruthy();
  expect((await sa.api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(sa.csrf) })).ok()).toBeTruthy();
  return { id: u.id, email };
}

/** Superadmin in the browser, on the Participants tab, with `ids` in the model the
 *  delete dialog reads (`deleteParticipant` looks the row up there). */
async function participantsLoaded(page, ids) {
  await adminLogin(page);
  await clickTab(page, "participants");
  await expect.poll(() => page.evaluate((want) => {
    const d = (window.S && window.S.adminParticipantsData) || [];
    return want.every((i) => d.some((u) => u.id === i));
  }, ids), { timeout: 20000, message: "the participants model never held the test's rows" }).toBe(true);
}
const rowFlag = (page, id) => page.evaluate((i) => {
  const u = (window.S.adminParticipantsData || []).find((x) => x.id === i);
  return u ? ("has_cxone_realm_account" in u ? u.has_cxone_realm_account : "absent") : "missing";
}, id);

/** Open the delete confirm for `id` (fire-and-forget — the call awaits the dialog). */
async function openDelete(page, id) {
  await page.evaluate((i) => { window.deleteParticipant(i); }, id);
  await expect(page.locator("#modal-overlay.open")).toBeVisible();
  await expect(page.locator("#modal-title")).toHaveText("Delete User");
  return (await page.locator("#modal-body").innerText());
}
async function cancelDialog(page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
}

test.describe("v8.12.7 — Checkmarx One removals, client half", () => {
  // ONE SESSION PER USER: the browser's superadmin sign-in ends any API session
  // for the same account, so every test signs the API in afresh and finishes its
  // API set-up BEFORE the browser signs in (the DEVELOPMENT.md harness rule).
  let sa;
  test.beforeEach(async () => { sa = await apiLogin("superadmin"); });
  test.afterEach(async () => { await sa.api.dispose(); });

  test("the delete confirm names the Checkmarx One account only when the platform created one", async ({ page }) => {
    const withAcct = await mkParticipant(sa, uniq());
    const without = await mkParticipant(sa, uniq());
    plant(withAcct.id);
    await participantsLoaded(page, [withAcct.id, without.id]);
    // Preconditions: the server sent the flag on one row and NOT on the other.
    expect(await rowFlag(page, withAcct.id)).toBe(true);
    expect(await rowFlag(page, without.id)).toBe("absent");

    // CONTROL first: no account, no sentence — the dialog is the ordinary one.
    const plain = await openDelete(page, without.id);
    expect(plain).toContain("This will permanently delete");
    expect(plain).not.toContain("Checkmarx One");
    await cancelDialog(page);

    const named = await openDelete(page, withAcct.id);
    expect(named).toContain("This will permanently delete");
    expect(named).toContain(CX_NOTE);
    await cancelDialog(page);
    // Cancelling deleted nothing.
    expect(dbGet("SELECT id FROM users WHERE id=?", withAcct.id)).toBeTruthy();
    expect(dbGet("SELECT id FROM users WHERE id=?", without.id)).toBeTruthy();
  });

  test("the delete toast reports the server's two counts, and a plain delete says only that", async ({ page }) => {
    const one = await mkParticipant(sa, uniq());      // one created account, nothing left in place
    const two = await mkParticipant(sa, uniq());      // two created, two matched
    const none = await mkParticipant(sa, uniq());     // CONTROL: nothing either way
    plant(one.id);
    plant(two.id); plant(two.id);
    planMatched(two.id); planMatched(two.id);
    await participantsLoaded(page, [one.id, two.id, none.id]);

    const cases = [
      { p: one, counts: { cxone_withdrawals_scheduled: 1 },
        text: "User deleted. Removal of 1 Checkmarx One account the platform created has been scheduled — follow it under Settings → Checkmarx One account removals." },
      { p: two, counts: { cxone_withdrawals_scheduled: 2, cxone_accounts_left_in_place: 2 },
        text: "User deleted. Removal of 2 Checkmarx One accounts the platform created has been scheduled — follow it under Settings → Checkmarx One account removals."
          + " 2 other Checkmarx One accounts linked to them already existed in the tenant and are left in place; the tenant's administrator decides about those." },
      { p: none, counts: {}, text: "User deleted." },
    ];
    for (const c of cases) {
      await openDelete(page, c.p.id);
      const resP = page.waitForResponse((r) => r.request().method() === "DELETE"
        && r.url().includes(`/api/admin/participants/${c.p.id}`));
      await page.locator("#modal-confirm-btn").click();
      const res = await resP;
      // The toast is built from THESE numbers — assert them, so the text below is
      // pinned to the response rather than to a coincidence.
      expect(await res.json(), `DELETE ${c.p.email}`).toEqual({ ok: true, ...c.counts });
      await expect(page.locator("#toast-stack .toast").filter({ hasText: "User deleted." }).last()).toHaveText(c.text);
      expect(dbGet("SELECT id FROM users WHERE id=?", c.p.id)).toBeFalsy();
    }
  });

  test("the removals card renders the server's rows, and Remove anyway only where the server allows it", async ({ page }) => {
    const ids = {
      adopted: plantPending({ held_reason: "adopted_by_tenant", attention: 1 }),
      adoptedSignal: plantPending({ held_reason: "adopted_by_tenant", held_signal: "role_mapping", attention: 1 }),
      provenance: plantPending({ held_reason: "provenance_unconfirmed", attention: 1 }),
      inProgress: plantPending({ claim_token: crypto.randomUUID(), claimed_at: nowIso() }),
    };
    const listed = await (await sa.api.get("/api/admin/cxone/withdrawals")).json();
    const row = (id) => listed.rows.find((r) => r.cxone_user_id === id);
    // Preconditions, from the server: which rows it calls overridable / in progress.
    expect(row(ids.adopted).overridable).toBe(true);
    expect(row(ids.provenance).overridable).toBe(false);
    expect(row(ids.inProgress).in_progress).toBe(true);

    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
    const card = page.locator("#cxone-withdrawals-card");
    await expect(card).toBeVisible();
    const entry = (id) => card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`);
    const btn = (id, a) => entry(id).locator(`[data-action="cxone-withdrawal-${a}"]`);
    for (const id of Object.values(ids)) await expect(entry(id)).toHaveCount(1);

    // An overridable hold: all three decisions, and the server's remedy beside them.
    for (const a of ["retry", "override", "dismiss"]) await expect(btn(ids.adopted, a)).toHaveCount(1);
    await expect(entry(ids.adopted)).toContainText(row(ids.adopted).remedy);
    // WHICH sign held it, in the server's words, beside the remedy — and a hold
    // recorded with no sign (an older one) says nothing it does not know.
    expect(row(ids.adoptedSignal).held_signal_text, "precondition: the server names the sign").toEqual(expect.any(String));
    await expect(entry(ids.adoptedSignal).locator(".cxone-wd-found")).toHaveText(`What the platform found: ${row(ids.adoptedSignal).held_signal_text}`);
    await expect(entry(ids.adoptedSignal)).toContainText(row(ids.adoptedSignal).remedy);
    await expect(entry(ids.adopted).locator(".cxone-wd-found")).toHaveCount(0);
    // CONTROL — a hold the server never lets anyone override: no Remove anyway.
    await expect(btn(ids.provenance, "override")).toHaveCount(0);
    for (const a of ["retry", "dismiss"]) await expect(btn(ids.provenance, a)).toHaveCount(1);
    await expect(entry(ids.provenance)).toContainText(row(ids.provenance).remedy);
    // In progress: nothing to press — Mark removed would 409, Retry would say "in progress".
    await expect(entry(ids.inProgress).locator("button")).toHaveCount(0);
    await expect(entry(ids.inProgress)).toContainText("working on this account right now");
  });

  // RT — no removal is dropped for its age. An entry whose deletion is older than
  // EVENT_RETENTION_DAYS stays, and says so. Both the label and the count are the
  // SERVER's answer: the second half rewrites the real response so the flags
  // contradict the dates and the window is not 730 days, which a card doing its
  // own date arithmetic, or printing a fixed window, cannot satisfy.
  test("RT-U1: an entry kept past the retention window says so under Since, and the count line says how many — from the server, never the card's own dates", async ({ page }) => {
    const old = plantPending({ held_reason: "adopted_by_tenant", attention: 1, pending_since: daysAgo(731) });
    const young = plantPending({ held_reason: "adopted_by_tenant", attention: 1 });
    try {
      const api = await (await sa.api.get("/api/admin/cxone/withdrawals")).json();
      const flag = (id) => api.rows.find((r) => r.cxone_user_id === id).past_retention;
      // Preconditions, from the server.
      expect(flag(old)).toBe(true);
      expect(flag(young)).toBe(false);
      expect(api.retention_days).toBe(730);
      expect(api.past_retention_count).toBeGreaterThanOrEqual(1);

      await adminLogin(page);
      await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
      const entry = (id) => page.locator(`#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`);
      await expect(entry(old)).toHaveCount(1);
      await expect(entry(young)).toHaveCount(1);
      // ONE snapshot of both entries' Since cells and the count line.
      const read = () => page.evaluate(([o, y]) => {
        const since = (id) => document.querySelector(
          `#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${id}"] tr td:nth-child(5)`).textContent;
        return { old: since(o), young: since(y), count: document.querySelector("#cxone-withdrawals-body .list-count").textContent };
      }, [old, young]);
      const real = await read();
      expect(real.old).toContain("kept past the 730-day retention period");
      expect(real.young, "CONTROL — the same render, a young entry").not.toContain("kept past");
      const m = /(\d+) kept past the 730-day retention period/.exec(real.count);
      expect(m, real.count).toBeTruthy();
      expect(Number(m[1])).toBe(api.past_retention_count);

      // The real response, with the flags contradicting the dates and another window.
      let mode = "contradict";
      await page.route("**/api/admin/cxone/withdrawals", async (route) => {
        const resp = await route.fetch();
        const body = await resp.json();
        for (const r of body.rows) {
          if (r.cxone_user_id === old) r.past_retention = false;
          if (r.cxone_user_id === young) r.past_retention = true;
        }
        if (mode === "contradict") { body.retention_days = 30; body.past_retention_count = 7; }
        else delete body.retention_days;
        await route.fulfill({ response: resp, json: body });
      });
      const reload = async () => {
        const got = page.waitForResponse((r) => r.url().includes("/api/admin/cxone/withdrawals") && r.request().method() === "GET");
        await page.evaluate(() => { window.loadCxoneWithdrawals(); });
        await got;
      };
      await reload();
      await expect(entry(young)).toContainText("kept past the 30-day retention period");
      const contra = await read();
      expect(contra.old, "a 731-day-old deletion the server does not flag is not labelled").not.toContain("kept past");
      expect(contra.young).toContain("kept past the 30-day retention period");
      expect(contra.count).toContain("7 kept past the 30-day retention period");

      // No window in the response: the words stay true without a number.
      mode = "noWindow";
      await reload();
      await expect(entry(young)).toContainText("kept past the retention period");
      const generic = await read();
      expect(generic.young).toContain("kept past the retention period");
      expect(generic.count).toContain(`${api.past_retention_count} kept past the retention period`);
      expect(generic.count + generic.young).not.toMatch(/-day/);
    } finally { unplant(old, young); }
  });

  test("the banner reaches a superadmin with accounts to decide on, and not a regular admin", async ({ page, browser }) => {
    plant(goneUser());   // an UNMARKED row of a deleted participant: attention, for a superadmin
    // The CONTROL's regular admin is made now, while the API session is live.
    const adm = await mkParticipant(sa, uniq());
    const role = await sa.api.post(`/api/admin/participants/${adm.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } });
    expect(role.ok(), `promote: ${role.status()} ${await role.text()}`).toBeTruthy();
    await adminLogin(page);
    const alerts = await (await page.request.get("/api/admin/alerts")).json();
    const n = alerts.cxone_withdrawals_attention;
    expect(n, "precondition: the server counts at least the planted row").toBeGreaterThan(0);
    const banner = page.locator("#cxone-withdrawal-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(`${n} Checkmarx One account${n === 1 ? "" : "s"} need`);
    // Its one action lands on the card, focused on the heading.
    await banner.locator('[data-action="cxone-withdrawals-review"]').click();
    await expect(page.locator("#admin-settings-tab")).toBeVisible();
    await expect(page.locator("#cxone-withdrawals-heading")).toBeFocused();

    // CONTROL — a regular admin, on the SAME database with the count above zero.
    const ctx = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx.newPage();
      await loginViaApi(p2, adm.email, PARTICIPANT_PASS);   // after the role change, which purged sessions
      const alertsP = p2.waitForResponse((r) => r.url().includes("/api/admin/alerts") && r.request().method() === "GET");
      await p2.goto("/");
      await expect(p2.locator("#admin-page")).toBeVisible({ timeout: 30000 });
      const body = await (await alertsP).json();
      expect(body, "the server withholds the count from a regular admin").not.toHaveProperty("cxone_withdrawals_attention");
      await expect(p2.locator("#cxone-withdrawal-banner")).toBeHidden();
    } finally { await ctx.close(); }
  });

  for (const theme of ["dark", "light"]) {
    test(`the removals card and banner have no moderate+ axe violations (${theme})`, async ({ page }) => {
      plantPending({ held_reason: "adopted_by_tenant", attention: 1 });
      await page.addInitScript((t) => { try { localStorage.setItem("hck-theme", t); } catch (_) {} }, theme);
      await adminLogin(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("#cxone-withdrawal-banner")).toBeVisible();
      await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
      await expect(page.locator("#cxone-withdrawals-body tbody.cxone-wd-entry").first()).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include("#cxone-withdrawals-card").include("#cxone-withdrawal-banner").analyze();
      const gated = results.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
      expect(gated.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(" | ")}`)).toEqual([]);
    });
  }

  // Each account is its own <tbody> (a fact row, then a full-width "What to do"
  // row with the buttons). The heading filter, its value list and the sort must
  // treat the <tbody> as the unit: reading only the first one filtered one
  // account, left the other accounts unfiltered, could hide a fact row under its
  // still-visible buttons, and offered only the first account's values.
  test("the heading filter, its values and the sort take every account whole", async ({ page }) => {
    const tn = (x) => `${TAG}-${x}`;
    const ids = {
      b: plantPending({ tenant: tn("b"), held_reason: "adopted_by_tenant", attention: 1 }),
      a: plantPending({ tenant: tn("a") }),
      c: plantPending({ tenant: tn("c"), held_reason: "provenance_unconfirmed", attention: 1 }),
    };
    try {
      const listed = await (await sa.api.get("/api/admin/cxone/withdrawals")).json();
      for (const id of Object.values(ids)) expect(listed.rows.some((r) => r.cxone_user_id === id), `PRECONDITION: ${id} is listed`).toBe(true);
      const total = listed.rows.length;
      expect(total, "PRECONDITION: several accounts, so the first is not the only one").toBeGreaterThanOrEqual(3);
      const realm = (x) => `iam.checkmarx.net / ${tn(x)}`;

      await adminLogin(page);
      await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
      const card = page.locator("#cxone-withdrawals-card");
      const entry = (k) => card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${ids[k]}"]`);
      for (const k of Object.keys(ids)) await expect(entry(k)).toHaveCount(1);
      // What a reader sees of one account: its fact row and its detail row.
      const shown = (k) => entry(k).evaluate((tb) => [...tb.rows].map((r) => r.getClientRects().length > 0));

      // The Tenant heading's values come from EVERY account, not the first.
      const tenantTh = card.locator("thead th").filter({ hasText: "Tenant" });
      await tenantTh.locator(".tcol-hbtn").click();
      const pop = page.locator(".tcol-pop[role='dialog']");
      await expect(pop).toBeVisible();
      const opts = await pop.locator("select option").allTextContents();
      for (const k of ["a", "b", "c"]) expect(opts, `the value list offers ${realm(k)}`).toContain(realm(k));

      // Filter to b: b shows whole; a and c go whole — buttons included.
      await pop.locator("select").selectOption(realm("b"));
      await expect.poll(() => shown("b"), { timeout: 5000 }).toEqual([true, true]);
      expect(await shown("a"), "an account the filter excludes goes, detail row and all").toEqual([false, false]);
      expect(await shown("c")).toEqual([false, false]);
      await expect(entry("a").locator("[data-action='cxone-withdrawal-dismiss']"), "no buttons without their facts").toBeHidden();
      await expect(card.locator(".tcol-note")).toHaveText(`Filtered by Tenant — 1 of ${total} accounts shown`);
      await pop.locator("[data-tcol-fclear]").click();
      await expect.poll(() => shown("a"), { timeout: 5000 }).toEqual([true, true]);
      expect(await shown("c"), "Clear brings every account back").toEqual([true, true]);
      await page.keyboard.press("Escape");

      // Sort by Tenant: each account moves as one, its detail row right under it.
      const ours = () => card.locator("tbody.cxone-wd-entry").evaluateAll((tbs, want) => tbs
        .map((tb) => ({ id: tb.dataset.cxoneUserId, detailFollows: tb.rows.length === 2 && tb.rows[1].classList.contains("cxone-wd-detail") }))
        .filter((e) => want.includes(e.id)), Object.values(ids));
      const idOrder = async () => (await ours()).map((e) => Object.keys(ids).find((k) => ids[k] === e.id)).join("");
      await tenantTh.locator(".tcol-hbtn").click();
      await page.locator(".tcol-pop [data-tcol-sort='asc']").click();
      await expect.poll(idOrder, { timeout: 5000 }).toBe("abc");
      await page.locator(".tcol-pop [data-tcol-sort='desc']").click();
      await expect.poll(idOrder, { timeout: 5000 }).toBe("cba");
      expect((await ours()).every((e) => e.detailFollows), "each account's detail row stays in its own entry").toBe(true);
      await expect(tenantTh).toHaveAttribute("aria-sort", "descending");
    } finally { unplant(...Object.values(ids)); }
  });

  // ONE account drawn alone is still a whole entry: the table declares its
  // <tbody> as the unit, so a filter that excludes the account takes its "What
  // to do" row and buttons too (a rule inferred from "several <tbody>" left them
  // on screen under no facts). The list is the server's own answer, narrowed to
  // this test's account so that it is the only one drawn, whatever else is listed.
  test("one account listed alone: a filter that excludes it hides its buttons with its facts", async ({ page }) => {
    const id = plantPending({ tenant: `${TAG}-solo`, held_reason: "adopted_by_tenant", attention: 1 });
    try {
      let listed = null;
      await page.route("**/api/admin/cxone/withdrawals", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const d = await res.json();
        listed = Array.isArray(d.rows) && d.rows.some((r) => r.cxone_user_id === id);
        return route.fulfill({ response: res, json: { ...d, rows: (d.rows || []).filter((r) => r.cxone_user_id === id) } });
      });
      await adminLogin(page);
      await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
      const card = page.locator("#cxone-withdrawals-card");
      await expect(card.locator("tbody.cxone-wd-entry"), "PRECONDITION: one account is drawn").toHaveCount(1);
      expect(listed, "PRECONDITION: the server itself listed the account").toBe(true);
      const entry = card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`);
      const shown = () => entry.evaluate((tb) => [...tb.rows].map((r) => r.getClientRects().length > 0));
      expect(await shown(), "PRECONDITION: its facts and its detail row are on screen").toEqual([true, true]);

      const accountTh = card.locator("thead th").filter({ hasText: "Account" });
      await accountTh.locator(".tcol-hbtn").click();
      const pop = page.locator(".tcol-pop[role='dialog']");
      await pop.locator("input[data-tcol-input]").pressSequentially("no-such-account", { delay: 20 });
      await expect.poll(shown, { timeout: 5000, message: "the excluded account goes whole, detail row and all" }).toEqual([false, false]);
      await expect(entry.locator("[data-action='cxone-withdrawal-dismiss']"), "no buttons without their facts").toBeHidden();
      await expect(card.locator(".tcol-note")).toHaveText("Filtered by Account — 0 of 1 account shown");
      // CONTROL: Clear brings it back whole.
      await pop.locator("[data-tcol-fclear]").click();
      await expect.poll(shown, { timeout: 5000 }).toEqual([true, true]);
      await expect(entry.locator("[data-action='cxone-withdrawal-dismiss']")).toBeVisible();
    } finally { unplant(id); }
  });

  // SINCE SORTS AND FILTERS BY TIME, not by its words. The two dates are chosen
  // so that every reading of the shown text disagrees with time: "Apr 2" sorts
  // before "Mar 13" as words, and 2 before 13 as a day of the month.
  test("Since sorts and filters by the time it shows, not by the words", async ({ page }) => {
    const ids = {
      m: plantPending({ pending_since: "2026-03-13T10:00:00.000Z" }),   // earlier, the 13th
      a: plantPending({ pending_since: "2026-04-02T10:00:00.000Z" }),   // later, the 2nd
    };
    try {
      await adminLogin(page);
      await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
      const card = page.locator("#cxone-withdrawals-card");
      for (const id of Object.values(ids)) await expect(card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`)).toHaveCount(1);
      const order = () => card.locator("tbody.cxone-wd-entry").evaluateAll((tbs, want) => tbs
        .map((tb) => Object.keys(want).find((k) => want[k] === tb.dataset.cxoneUserId)).filter(Boolean).join(""), ids);
      const sinceTh = card.locator("thead th").filter({ hasText: "Since" });
      await sinceTh.locator(".tcol-hbtn").click();
      const pop = page.locator(".tcol-pop[role='dialog']");
      await pop.locator("[data-tcol-sort='asc']").click();
      await expect.poll(order, { timeout: 5000, message: "ascending: 13 March before 2 April" }).toBe("ma");
      await pop.locator("[data-tcol-sort='desc']").click();
      await expect.poll(order, { timeout: 5000 }).toBe("am");
      // The filter is a date range over the same times.
      await pop.locator("input[data-tcol-from]").fill("2026-04-01");
      await pop.locator("input[data-tcol-from]").dispatchEvent("change");
      const visible = (k) => card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${ids[k]}"] tr`).first();
      await expect(visible("a")).toBeVisible();
      await expect(visible("m"), "an account from before the range is filtered out").toBeHidden();
    } finally { unplant(...Object.values(ids)); }
  });
});

// ─── v8.12.7 pre-release review — the client half, second pass ─────────────
//
// Five findings on the surfaces above, each locked by a test that goes RED on the
// code it replaced and carries the control that stops it being satisfied by a
// build that simply stopped doing the thing.
test.describe("v8.12.7 (review) — Checkmarx One removals, client fixes", () => {
  let sa;
  test.beforeEach(async () => { sa = await apiLogin("superadmin"); });
  test.afterEach(async () => { await sa.api.dispose(); });

  test("the delete toast names accounts the platform made but never recorded apart from ones that already existed", async ({ page }) => {
    // The DELETE response is INTERCEPTED: this is a test of what the client says
    // for each count, and the server's side of the split (which accounts land in
    // which count) is locked by the API spec. Nothing is deleted here — the
    // participant is only the row the confirm dialog names.
    const p = await mkParticipant(sa, uniq());
    await participantsLoaded(page, [p.id]);
    let body = null;
    await page.route(`**/api/admin/participants/${p.id}`, (r) =>
      r.request().method() === "DELETE"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
        : r.continue());
    const UNREC2 = " 2 Checkmarx One accounts the platform created for them are not in its records, so they cannot be removed automatically; remove them in the tenant by hand.";
    const UNREC1 = " 1 Checkmarx One account the platform created for them is not in its records, so it cannot be removed automatically; remove it in the tenant by hand.";
    const LEFT1 = " 1 other Checkmarx One account linked to them already existed in the tenant and is left in place; the tenant's administrator decides about it.";
    const LEFT2 = " 2 other Checkmarx One accounts linked to them already existed in the tenant and are left in place; the tenant's administrator decides about those.";
    const UNREAD1 = " 1 Checkmarx One set-up record of theirs could not be read, so the platform cannot tell which account, if any, it names; check the tenant for an account of theirs (their address is in the Audit page's record of the deletion).";
    const UNREAD2 = " 2 Checkmarx One set-up records of theirs could not be read, so the platform cannot tell which account, if any, they name; check the tenant for an account of theirs (their address is in the Audit page's record of the deletion).";
    const cases = [
      // A set-up record nobody can read: its own sentence, "check", never "remove".
      { body: { ok: true, cxone_records_unreadable: 1 }, text: "User deleted." + UNREAD1 },
      { body: { ok: true, cxone_accounts_unrecorded: 1, cxone_records_unreadable: 2 }, text: "User deleted." + UNREC1 + UNREAD2 },
      // The reported case: accounts the platform made but never recorded must
      // NOT be described as having "already existed in the tenant".
      { body: { ok: true, cxone_accounts_unrecorded: 2 }, text: "User deleted." + UNREC2 },
      { body: { ok: true, cxone_accounts_left_in_place: 1, cxone_accounts_unrecorded: 1 }, text: "User deleted." + LEFT1 + UNREC1 },
      // CONTROL — matched accounts alone keep their own sentence, and nothing
      // about a missing record is invented for them.
      { body: { ok: true, cxone_accounts_left_in_place: 2 }, text: "User deleted." + LEFT2 },
    ];
    for (const c of cases) {
      body = c.body;
      await openDelete(page, p.id);
      const resP = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/api/admin/participants/${p.id}`));
      await page.locator("#modal-confirm-btn").click();
      await resP;
      const toast = page.locator("#toast-stack .toast").filter({ hasText: c.text.slice(0, 60) }).last();
      await expect(toast).toHaveText(c.text);
      if (!c.body.cxone_accounts_left_in_place) await expect(toast).not.toContainText("already existed");
      if (!c.body.cxone_accounts_unrecorded) await expect(toast).not.toContainText("not in its records");
      if (!c.body.cxone_records_unreadable) await expect(toast).not.toContainText("could not be read");
    }
  });

  test("an alerts tick with an unchanged count leaves the banner — and the focus on its button — alone", async ({ page }) => {
    plant(goneUser());   // an unmarked row: the banner has something to say
    await adminLogin(page);
    const banner = page.locator("#cxone-withdrawal-banner");
    await expect(banner).toBeVisible();
    const count = async () => (await (await page.request.get("/api/admin/alerts")).json()).cxone_withdrawals_attention;
    const n = await count();
    expect(n, "precondition: the server counts the planted row").toBeGreaterThan(0);
    await expect(banner).toContainText(`${n} Checkmarx One account`);
    const btn = banner.locator('[data-action="cxone-withdrawals-review"]');
    await btn.focus();
    await expect(btn).toBeFocused();
    await page.evaluate(() => {
      window.__cxBtn = document.querySelector('#cxone-withdrawal-banner [data-action="cxone-withdrawals-review"]');
      window.__cxMut = 0;
      new MutationObserver((m) => { window.__cxMut += m.length; })
        .observe(document.getElementById("cxone-withdrawal-banner"), { childList: true, subtree: true, characterData: true });
    });
    // The poll's own body, run to completion (it awaits its fetch).
    await page.evaluate(() => window._adminAlertTick());
    const after = await page.evaluate(() => ({
      sameNode: document.querySelector('#cxone-withdrawal-banner [data-action="cxone-withdrawals-review"]') === window.__cxBtn,
      focused: document.activeElement === window.__cxBtn,
      mutations: window.__cxMut,
    }));
    expect(after, "an unchanged count must not rebuild the banner, drop the keyboard focus or re-announce the status").toEqual({ sameNode: true, focused: true, mutations: 0 });

    // CONTROL — a CHANGED count still repaints, or "untouched" is satisfied by a
    // banner that never updates.
    plant(goneUser());
    expect(await count()).toBe(n + 1);
    await page.evaluate(() => window._adminAlertTick());
    await expect(banner).toContainText(`${n + 1} Checkmarx One accounts need your decision.`);
  });

  test("the SMTP banner is not rewritten by a tick that has nothing new to say", async ({ page }) => {
    await adminLogin(page);
    await page.waitForFunction(() => typeof window._renderSmtpBanner === "function");
    const r = await page.evaluate(() => {
      const el = document.getElementById("smtp-banner");
      window._renderSmtpBanner(false);
      // Records are read with takeRecords(): an observer's callback is a
      // microtask, so inside this one synchronous evaluate it has not run yet,
      // and a counter it bumps would read 0 whatever happened (which is how the
      // first draft of this test passed with the guard removed).
      const mo = new MutationObserver(() => {});
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      window._renderSmtpBanner(false);              // the same outage, next tick
      const same = mo.takeRecords().length;
      window._renderSmtpBanner(true);               // CONTROL — it still clears…
      const cleared = el.hidden;
      window._renderSmtpBanner(false);              // …and still comes back
      const back = !el.hidden && /Email delivery is failing/.test(el.textContent || "");
      mo.disconnect();
      window._renderSmtpBanner(true);               // leave the shell as we found it
      return { same, cleared, back };
    });
    expect(r).toEqual({ same: 0, cleared: true, back: true });
  });

  for (const w of [360, 768, 1024, 1280]) {
    test(`the "What to do" line and its buttons are readable without scrolling sideways at ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      // At the narrowest and the desktop width the entry is also one kept past the
      // retention window, so the extra line under Since is laid out and measured too.
      const kept = w === 360 || w === 1280;
      const id = plantPending({ held_reason: "adopted_by_tenant", attention: 1,
        last_error: "http/delete_refused/403 a fairly long upstream error message that has to wrap somewhere",
        ...(kept ? { pending_since: daysAgo(731) } : {}) });
      try {
        await adminLogin(page);
        await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
        const entry = page.locator(`#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`);
        await expect(entry).toHaveCount(1);
        await expect(entry.locator('[data-action="cxone-withdrawal-override"]')).toBeVisible();
        const measure = () => page.evaluate((cid) => {
          const e = document.querySelector(`#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${cid}"]`);
          const s = e.closest(".cxone-wd-scroll"), sr = s.getBoundingClientRect();
          const rem = e.querySelector(".cxone-wd-remedy").getBoundingClientRect();
          const btns = [...e.querySelectorAll(".cxone-wd-actions button")].map((b) => b.getBoundingClientRect());
          const sinceTd = e.querySelector("tr td:nth-child(5)"), td = sinceTd.getBoundingClientRect();
          const sub = [...sinceTd.querySelectorAll(".cxone-wd-sub")].map((x) => ({ text: x.textContent, ...x.getBoundingClientRect().toJSON() }));
          return {
            scrollerLeft: sr.left, scrollerRight: sr.left + s.clientWidth, overflow: s.scrollWidth - s.clientWidth,
            remLeft: rem.left, remRight: rem.right, remW: rem.width,
            btnLeft: Math.min(...btns.map((b) => b.left)), btnRight: Math.max(...btns.map((b) => b.right)),
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            tdLeft: td.left, tdRight: td.right, sub,
          };
        }, id);
        const inView = (m, label) => {
          expect(m.remLeft, `${label}: the remedy starts left of the visible area`).toBeGreaterThanOrEqual(m.scrollerLeft - 1);
          expect(m.remRight, `${label}: the remedy runs past the visible area (${JSON.stringify(m)})`).toBeLessThanOrEqual(m.scrollerRight + 1);
          expect(m.btnLeft, `${label}: a button starts left of the visible area`).toBeGreaterThanOrEqual(m.scrollerLeft - 1);
          expect(m.btnRight, `${label}: a button runs past the visible area (${JSON.stringify(m)})`).toBeLessThanOrEqual(m.scrollerRight + 1);
        };
        const m0 = await measure();
        expect(m0.pageOverflow, "the page itself must never scroll sideways").toBe(0);
        inView(m0, `${w}px, unscrolled`);
        if (kept) {
          // The label renders, and wraps inside its own cell rather than spilling out of it.
          expect(m0.sub.map((x) => x.text), JSON.stringify(m0)).toEqual(["kept past the 730-day retention period"]);
          const [lab] = m0.sub;
          expect(lab.width, "the label has a box").toBeGreaterThan(0);
          expect(lab.left, `${w}px: the label starts left of its cell (${JSON.stringify(m0)})`).toBeGreaterThanOrEqual(m0.tdLeft - 1);
          expect(lab.right, `${w}px: the label runs out of its cell (${JSON.stringify(m0)})`).toBeLessThanOrEqual(m0.tdRight + 1);
        } else {
          expect(m0.sub, "CONTROL — a young entry has no label under Since").toEqual([]);
        }
        if (w <= 1024) {
          // Precondition — at these widths the TABLE really is wider than its box;
          // otherwise "in view" is satisfied by a layout that never overflowed.
          expect(m0.overflow, `precondition: the table overflows its scroll area at ${w}px`).toBeGreaterThan(40);
          // …and reading the columns the remedy is about does not take it away.
          await page.evaluate((cid) => {
            const s = document.querySelector(`#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${cid}"]`).closest(".cxone-wd-scroll");
            s.scrollLeft = s.scrollWidth;
          }, id);
          await expect.poll(async () => (await measure()).remLeft >= (await measure()).scrollerLeft - 1).toBe(true);
          inView(await measure(), `${w}px, scrolled to the last column`);
        } else {
          // CONTROL — the desktop layout keeps the 52rem reading measure it had.
          const remPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize) * 52);
          expect(m0.remW).toBeLessThanOrEqual(remPx + 1);
          expect(m0.remW, "the remedy is not squeezed at a desktop width").toBeGreaterThan(Math.min(remPx, 600));
        }
      } finally { unplant(id); }
    });
  }

  test("a failed Settings load does not leave the Review focus waiting for an ordinary visit", async ({ page }) => {
    plant(goneUser());
    await adminLogin(page);
    await expect(page.locator("#cxone-withdrawal-banner")).toBeVisible();
    let fail = true;
    await page.route("**/api/admin/settings", (r) => fail
      ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
      : r.continue());
    const heading = page.locator("#cxone-withdrawals-heading");
    await page.locator('#cxone-withdrawal-banner [data-action="cxone-withdrawals-review"]').click();
    await expect(page.locator("#settings-load-failure")).toBeVisible();
    await expect(heading).not.toBeFocused();

    // An ORDINARY visit afterwards — the sidebar, not the banner.
    fail = false;
    await clickTab(page, "competitions");
    const wdP = page.waitForResponse((r) => r.url().includes("/api/admin/cxone/withdrawals") && r.request().method() === "GET");
    await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
    await wdP;
    await expect(page.locator("#cxone-withdrawals-body tbody.cxone-wd-entry").first()).toBeVisible();
    // The focus move, had it been armed, runs in the same task as that render.
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id),
      "an ordinary Settings visit must not be pulled down to the removals card").not.toBe("cxone-withdrawals-heading");

    // CONTROL — the banner's Review still lands on the card, or "not focused" is
    // satisfied by a build that never focuses at all.
    await clickTab(page, "competitions");
    await page.locator('#cxone-withdrawal-banner [data-action="cxone-withdrawals-review"]').click();
    await expect(heading).toBeFocused();
  });

  test("the Review focus request is armed per entry AND cleared by a failed load (source: the two cover each other)", () => {
    // MEASURED: each half alone keeps the behavioural test above green — the
    // entry reset clears a request a failure left armed on the next ordinary
    // visit, and the failure clear leaves nothing for that visit to find. So no
    // behaviour distinguishes them, and a reader deleting either on the evidence
    // of a passing suite would be right about the suite and wrong about the day
    // the other one is touched. Pinned at source instead (the v8.10.3 shape).
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public/js/features/settings-admin.js"), "utf8"));
    const start = src.indexOf("export async function loadAdminSettings(");
    expect(start, "anti-vacuity: loadAdminSettings must exist").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    const arm = body.indexOf("_wdFocusPending=_wdReviewEntry;");
    expect(arm, "every entry to the tab re-decides the focus request").toBeGreaterThan(-1);
    expect(arm, "…synchronously, before the first await — inside the click that entered it").toBeLessThan(body.indexOf("await "));
    const failAt = body.indexOf("if(!d){");
    expect(failAt).toBeGreaterThan(-1);
    expect(body.slice(failAt, body.indexOf("return;", failAt)), "a failed load drops the request").toContain("_wdFocusPending=false;");
    const rs = src.indexOf("export function openCxoneWithdrawalsReview(");
    expect(src.slice(rs, src.indexOf("\n}", rs)), "the Review arm is scoped to the click's own dispatch")
      .toMatch(/_wdReviewEntry=true;\s*try\{\s*btn\.click\(\);\s*\}finally\{\s*_wdReviewEntry=false;\s*\}/);
    expect(src, "nothing arms the focus request directly any more").not.toMatch(/_wdFocusPending\s*=\s*true/);
  });

  test("an unmarked row's first go-ahead says what it is, confirms, and says it was scheduled", async ({ page }) => {
    const unmarked = plant(goneUser());                       // never scheduled
    const retrying = plantPending({ attempts: 2, last_error: "http/delete_failed/503", attention: 1 });  // CONTROL
    const acct = dbGet("SELECT created_username AS u FROM cxone_realm_accounts WHERE cxone_user_id=?", unmarked).u;
    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
    const entry = (id) => page.locator(`#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`);
    await expect(entry(unmarked)).toHaveCount(1);
    await expect(entry(retrying)).toHaveCount(1);
    const go = entry(unmarked).locator('[data-action="cxone-withdrawal-retry"]');
    await expect(go).toHaveText("Schedule removal");
    await expect(go).toHaveAttribute("aria-label", `Schedule removal of Checkmarx One account ${acct}`);
    // CONTROL — a row that is already scheduled keeps its Retry.
    await expect(entry(retrying).locator('[data-action="cxone-withdrawal-retry"]')).toHaveText("Retry");

    const posts = [];
    page.on("request", (q) => { if (q.method() === "POST" && q.url().includes("/api/admin/cxone/withdrawals/retry")) posts.push(q.postDataJSON()); });
    await go.click();
    await expect(page.locator("#modal-overlay.open")).toBeVisible();
    await expect(page.locator("#modal-title")).toHaveText("Schedule this removal?");
    await expect(page.locator("#modal-body")).toContainText(`The platform will remove Checkmarx One account ${acct} from the customer's tenant.`);
    // The press can end in a hand-over too, so "cannot be undone" is said of the removal alone.
    await expect(page.locator("#modal-body")).toContainText(HANDOVER_NOTE);
    await expect(page.locator("#modal-body")).toContainText("A removal cannot be undone once it runs.");
    await cancelDialog(page);
    await page.waitForTimeout(300);
    expect(posts, "cancelling the confirm must send nothing").toEqual([]);
    expect(dbGet("SELECT pending_since FROM cxone_realm_accounts WHERE cxone_user_id=?", unmarked).pending_since).toBeNull();

    await go.click();
    await expect(page.locator("#modal-title")).toHaveText("Schedule this removal?");
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack .toast").filter({ hasText: `Removal of ${acct}` }).last())
      .toHaveText(`Removal of ${acct} scheduled — the platform will remove it from the customer's tenant shortly, unless its owner is still on the platform.`);
    expect(posts).toEqual([{ cxone_user_id: unmarked, override: false }]);
    expect(dbGet("SELECT pending_since FROM cxone_realm_accounts WHERE cxone_user_id=?", unmarked).pending_since).not.toBeNull();

    // CONTROL — Retry on a scheduled row goes straight through, with its own words.
    const racct = dbGet("SELECT created_username AS u FROM cxone_realm_accounts WHERE cxone_user_id=?", retrying).u;
    await entry(retrying).locator('[data-action="cxone-withdrawal-retry"]').click();
    await expect(page.locator("#toast-stack .toast").filter({ hasText: `Removal of ${racct}` }).last())
      .toHaveText(`Removal of ${racct} scheduled — the platform will try again shortly.`);
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
    expect(posts.length).toBe(2);
  });
});

// ─── v8.13.1 (external audit, P2) — Remove anyway names the hold its confirm QUOTED
//
// The server refuses an override whose `expected_hold` is not the row's current
// hold (tests/cxone-withdrawals.api.spec.js owns that half). What this file owns
// is the CLIENT's half, and it is the half that decides whether the refusal can
// ever fire: the value must come from the row the confirm dialog quoted — the
// one the human read — and not from anything fetched afterwards, or a stale page
// would send the new hold and override a reason nobody had read.
test.describe("v8.13.1 — Remove anyway sends the hold its confirm quoted", () => {
  let sa;
  test.beforeEach(async () => { sa = await apiLogin("superadmin"); });
  test.afterEach(async () => { await sa.api.dispose(); });

  /** A second superadmin — user-backed, so its API session survives the
   *  browser's built-in superadmin sign-in (one session per USER). Made while the
   *  built-in API session is live, i.e. before the browser signs in. */
  async function colleagueSuperadmin() {
    const p = await mkParticipant(sa, uniq());
    const role = await sa.api.post(`/api/admin/participants/${p.id}/role`, { headers: H(sa.csrf), data: { role: "superadmin" } });
    expect(role.ok(), `promote to superadmin: ${await role.text()}`).toBeTruthy();
    return apiLogin(p.email, PARTICIPANT_PASS);
  }
  const listedRow = async (who, id) => ((await (await who.api.get("/api/admin/cxone/withdrawals")).json()).rows || [])
    .find((r) => r.cxone_user_id === id);
  /** What the runner writes when it stops at a hold (lib/cxone-withdraw.js `_hold`). */
  const runnerHolds = (id, reason) => dbRun(
    "UPDATE cxone_realm_accounts SET held_reason=?, attention=1, next_attempt_at=? WHERE cxone_user_id=?",
    reason, new Date(Date.now() + 7 * 24 * 3600e3).toISOString(), id);
  const ledger = (id) => dbGet("SELECT held_reason, override_reason FROM cxone_realm_accounts WHERE cxone_user_id=?", id);
  const entryOf = (page, id) => page.locator(`#cxone-withdrawals-card tbody.cxone-wd-entry[data-cxone-user-id="${id}"]`);
  /** Every POST to the retry route, as the JSON body the browser sent. */
  const isRetryPost = (q) => q.method() === "POST" && q.url().includes("/api/admin/cxone/withdrawals/retry");
  const capturePosts = (page) => {
    const posts = [];
    page.on("request", (q) => { if (isRetryPost(q)) posts.push(q.postDataJSON()); });
    return posts;
  };
  /** Confirm the open dialog and return the body of the retry POST it sends —
   *  asserted BEFORE the toast, so a wrong body is named as a wrong body rather
   *  than as the toast the server's answer to it produces. */
  async function confirmAndCapture(page) {
    const reqP = page.waitForRequest(isRetryPost);
    await page.locator("#modal-confirm-btn").click();
    return (await reqP).postDataJSON();
  }

  /** The override's body: the hold, and the sign only where the row showed one. */
  const bodyOf = (r) => ({ cxone_user_id: r.id, override: true, expected_hold: r.hold, ...(r.signal ? { expected_signal: r.signal } : {}) });

  test("each Remove anyway names its OWN row's hold, the one its confirm quoted; a plain Retry sends no override and no hold", async ({ page }) => {
    // Two DIFFERENT overridable holds, so a client that sent one fixed value (or
    // the first row's) cannot pass both; a third row is the plain-Retry control.
    const rows = [
      { id: plantPending({ held_reason: "adopted_by_tenant", held_signal: "attribute", attention: 1 }), hold: "adopted_by_tenant", signal: "attribute" },
      { id: plantPending({ held_reason: "instance_mismatch", attention: 1 }), hold: "instance_mismatch" },
      { id: plantPending({ held_reason: "roles_unreadable", attention: 1 }), hold: "roles_unreadable" },
      { id: plantPending({ held_reason: "binding_unreadable", attention: 1 }), hold: "binding_unreadable" },
    ];
    const plain = plantPending({ held_reason: "address_held_by_living_account", attention: 1 });
    for (const r of rows) {
      const lr = await listedRow(sa, r.id);
      expect(lr, `precondition: ${r.hold} is listed and overridable`).toMatchObject({ held_reason: r.hold, overridable: true });
      r.remedy = lr.remedy; r.acct = lr.created_username; r.found = lr.held_signal_text;
    }
    expect(rows[0].found, "precondition: the adoption hold names its sign").toEqual(expect.any(String));
    const plainAcct = (await listedRow(sa, plain)).created_username;

    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
    for (const r of [...rows, { id: plain }]) await expect(entryOf(page, r.id)).toHaveCount(1);
    const posts = capturePosts(page);

    for (const r of rows) {
      await entryOf(page, r.id).locator('[data-action="cxone-withdrawal-override"]').click();
      await expect(page.locator("#modal-title")).toHaveText("Remove this account anyway?");
      // The hold the request will name is the one this dialog shows the human.
      await expect(page.locator("#modal-body")).toContainText(r.remedy);
      // …and WHAT was found, where the server named it, so the decision is made on it.
      if (r.found) await expect(page.locator("#modal-body")).toContainText(`What the platform found: ${r.found}`);
      else await expect(page.locator("#modal-body")).not.toContainText("What the platform found");
      // Whatever hold it overrules, the runner still hands the account to an owner still here.
      await expect(page.locator("#modal-body")).toContainText("anyway? " + HANDOVER_NOTE + " A removal cannot be undone.");
      expect(await confirmAndCapture(page), `${r.hold}: the override names the hold (and the sign) its confirm quoted`)
        .toEqual(bodyOf(r));
      await expect(page.locator("#toast-stack .toast").filter({ hasText: `Removal of ${r.acct}` }).last())
        .toHaveText(`Removal of ${r.acct} approved — the platform will remove it shortly, unless its owner is still on the platform.`);
      expect(ledger(r.id), `${r.hold}: the server recorded the override`).toEqual({ held_reason: null, override_reason: r.hold });
    }
    expect(posts).toEqual(rows.map(bodyOf));

    // CONTROL — a plain Retry overrides nothing, so it names no hold at all.
    await entryOf(page, plain).locator('[data-action="cxone-withdrawal-retry"]').click();
    await expect(page.locator("#toast-stack .toast").filter({ hasText: `Removal of ${plainAcct}` }).last())
      .toHaveText(`Removal of ${plainAcct} scheduled — the platform will try again shortly.`);
    expect(posts.length).toBe(rows.length + 1);
    expect(posts[rows.length]).toEqual({ cxone_user_id: plain, override: false });
    expect(ledger(plain)).toEqual({ held_reason: null, override_reason: null });
  });

  test("a stale Remove anyway is refused with the server's reason, and the reloaded list shows the hold nobody had read", async ({ page }) => {
    // The auditor's sequence, with two real superadmins: the colleague's approval
    // lands while this page still shows the old hold, and the runner then stops
    // at a different one.
    const colleague = await colleagueSuperadmin();
    try {
      const id = plantPending({ held_reason: "adopted_by_tenant", attention: 1 });
      const before = await listedRow(sa, id);
      expect(before).toMatchObject({ held_reason: "adopted_by_tenant", overridable: true });
      const remX = before.remedy, acct = before.created_username;

      await adminLogin(page);
      await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
      const entry = entryOf(page, id);
      await expect(entry).toContainText(remX);

      const first = await colleague.api.post("/api/admin/cxone/withdrawals/retry", { headers: H(colleague.csrf),
        data: { cxone_user_id: id, override: true, expected_hold: "adopted_by_tenant" } });
      expect(first.status(), `the colleague's approval: ${await first.text()}`).toBe(200);
      runnerHolds(id, "address_held_by_living_account");
      const now = await listedRow(colleague, id);
      expect(now).toMatchObject({ held_reason: "address_held_by_living_account", overridable: true });
      const remY = now.remedy;
      expect(remY, "precondition: the two holds read differently").not.toBe(remX);
      // Precondition: this page is genuinely stale — nothing polls the card.
      await expect(entry).toContainText(remX);
      await expect(entry).not.toContainText(remY);

      const posts = capturePosts(page);
      await entry.locator('[data-action="cxone-withdrawal-override"]').click();
      // The human is confirming the OLD reason — that is the whole hazard.
      await expect(page.locator("#modal-body")).toContainText(remX);
      expect(await confirmAndCapture(page), "the stale override names the hold its confirm quoted — the one this page READ")
        .toEqual({ cxone_user_id: id, override: true, expected_hold: "adopted_by_tenant" });
      await expect(page.locator("#toast-stack .toast").filter({ hasText: "This account changed after you read it" }).last())
        .toHaveText("This account changed after you read it: the platform now holds it for a different reason. Read the new reason, then decide again.");
      expect(posts).toEqual([{ cxone_user_id: id, override: true, expected_hold: "adopted_by_tenant" }]);
      expect(ledger(id), "the new hold stands, not overridden").toEqual({ held_reason: "address_held_by_living_account", override_reason: "adopted_by_tenant" });
      // The failure path reloads the list, so the reason nobody had read is now on screen.
      await expect(entry).toContainText(remY);
      await expect(entry).not.toContainText(remX);
      await expect(page.locator("#toast-stack .toast").filter({ hasText: `Removal of ${acct} approved` })).toHaveCount(0);

      // CONTROL — pressing again, on the row as it now reads, quotes the new reason
      // and goes through: the refusal is about staleness, not about the account.
      await entry.locator('[data-action="cxone-withdrawal-override"]').click();
      await expect(page.locator("#modal-body")).toContainText(remY);
      expect(await confirmAndCapture(page), "the fresh override names the hold now on screen")
        .toEqual({ cxone_user_id: id, override: true, expected_hold: "address_held_by_living_account" });
      await expect(page.locator("#toast-stack .toast").filter({ hasText: `Removal of ${acct}` }).last())
        .toHaveText(`Removal of ${acct} approved — the platform will remove it shortly, unless its owner is still on the platform.`);
      expect(posts[1]).toEqual({ cxone_user_id: id, override: true, expected_hold: "address_held_by_living_account" });
      expect(ledger(id)).toEqual({ held_reason: null, override_reason: "adopted_by_tenant,address_held_by_living_account" });
    } finally { await colleague.api.dispose(); }
  });

  test("the same hold, a DIFFERENT sign since the page loaded: the confirm quoted the old sign, so it is refused and the list shows the new one", async ({ page }) => {
    // Both signs' words read first, through the API session the browser's
    // sign-in (one session per principal) is about to end.
    const id = plantPending({ held_reason: "adopted_by_tenant", held_signal: "credential_after_deletion", attention: 1 });
    const now = await listedRow(sa, id);
    dbRun("UPDATE cxone_realm_accounts SET held_signal='foreign_group' WHERE cxone_user_id=?", id);
    const before = await listedRow(sa, id);
    expect(before, "precondition").toMatchObject({ held_reason: "adopted_by_tenant", held_signal: "foreign_group", overridable: true });
    expect(now.held_signal_text, "precondition: the two signs read differently").not.toBe(before.held_signal_text);
    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "cxone");
    const entry = entryOf(page, id);
    await expect(entry.locator(".cxone-wd-found")).toHaveText(`What the platform found: ${before.held_signal_text}`);
    // The runner holds it again, for the same reason but another sign.
    dbRun("UPDATE cxone_realm_accounts SET held_signal='credential_after_deletion' WHERE cxone_user_id=?", id);

    await entry.locator('[data-action="cxone-withdrawal-override"]').click();
    await expect(page.locator("#modal-body")).toContainText(`What the platform found: ${before.held_signal_text}`);
    expect(await confirmAndCapture(page), "the override names the sign its confirm quoted")
      .toEqual({ cxone_user_id: id, override: true, expected_hold: "adopted_by_tenant", expected_signal: "foreign_group" });
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "This account changed after you read it" }).last())
      .toHaveText("This account changed after you read it: the platform now holds it for something else it found. Read what it found, then decide again.");
    expect(ledger(id), "not overridden").toEqual({ held_reason: "adopted_by_tenant", override_reason: null });
    await expect(entry.locator(".cxone-wd-found")).toHaveText(`What the platform found: ${now.held_signal_text}`);
  });
});
