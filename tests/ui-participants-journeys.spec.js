// @ts-check
//
// v8.12.4 — participants-pane controls no test had ever DRIVEN.
//
// A coverage run (`npm run test:coverage`) showed these handlers never executing
// in the browser: other specs assert that the menu item EXISTS (the row-action
// matrix) or perform the same change through the API, so the click → dialog →
// request → re-render path had no witness at all. Each test here presses the
// real control and then reads the STORED result, because a toast is the client
// talking to itself.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, clickTab, openKebab, viewComp, showEveryoneInWorkspace, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });
// The sort lock clicks the Email header, which the default six columns hide: show every column.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const dbRun = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...a); } finally { db.close(); }
};

/** Register an account and verify it, leaving it PENDING approval. */
async function pending(sa, csrf, label, prefix = "pend") {
  const tag = uniq(label).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const email = `${prefix}-${tag}@acme.com`;
  const { api, csrf: c } = await freshCtx();
  const r = await registerPost(api, "/api/register", { headers: H(c), data: {
    firstName: "Pen", lastName: String(label), nickname: `p_${tag}`.slice(0, 40), email,
    company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London", password: PARTICIPANT_PASS } });
  expect(r.ok(), `register ${label}: ${await r.text()}`).toBeTruthy();
  await api.dispose();
  const row = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
  expect(row, "registered").toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect(dbGet("SELECT approved FROM users WHERE id=?", row.id).approved, "PRECONDITION: pending approval").toBe(0);
  return { id: row.id, email };
}

/** Narrow the paginated table to `query` and wait for it to settle. */
async function narrow(page, query) {
  // Inside an event workspace the pane lists its members; the rows this file
  // invites are NON-members, so list everyone (a no-op outside a workspace).
  await showEveryoneInWorkspace(page);
  await narrowPeopleTable(page, query);
  const tbody = page.locator("#admin-participants-body");
  await expect(async () => {
    const a = await tbody.locator("tr").count();
    await page.waitForTimeout(250);
    expect(await tbody.locator("tr").count()).toBe(a);
  }).toPass({ timeout: 8000 });
}

/** Press a row action, inline if the row carries it, otherwise from the kebab. */
async function rowAction(page, email, action) {
  await narrow(page, email);
  const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  // The row also holds its kebab items as HIDDEN markup (the menu is portalled
  // on open), so "the row contains it" is not "the row shows it".
  const inline = row.locator(`[data-action="${action}"]:visible`);
  if (await inline.count()) { await inline.first().click(); return; }
  await openKebab(page, row);
  await page.locator(`#kebab-portal [data-action="${action}"]`).first().click();
}

async function confirmModal(page, expectText) {
  const ov = page.locator("#modal-overlay.open");
  await ov.waitFor({ state: "visible", timeout: 8000 });
  if (expectText) await expect(ov).toContainText(expectText);
  await page.locator("#modal-confirm-btn").click();
}

test.describe("v8.12.4 — participants pane, driven through its own controls", () => {
  test("Deny Approval from the row records the denial AND the reason typed into the dialog", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const u = await pending(sa, csrf, "deny");
      await adminLogin(page); await clickTab(page, "Participants");
      await rowAction(page, u.email, "participant-deny");
      await page.locator("#modal-overlay.open").waitFor({ state: "visible" });
      await page.locator("#deny-reason").fill("Not a registered attendee");
      await page.locator("#modal-confirm-btn").click();
      await expect.poll(() => dbGet("SELECT denied_at FROM users WHERE id=?", u.id).denied_at, { timeout: 10000 }).toBeTruthy();
      expect(dbGet("SELECT denied_reason, approved FROM users WHERE id=?", u.id))
        .toMatchObject({ denied_reason: "Not a registered attendee", approved: 0 });
    } finally { await sa.dispose(); }
  });

  test("ticking two pending rows and pressing the selection bar's Approve approves exactly those two", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const prefix = `bulkap${Date.now() % 1e8}`;
      const a = await pending(sa, csrf, "a", prefix), b = await pending(sa, csrf, "b", prefix);
      const bystander = await pending(sa, csrf, "c");        // pending too, but NOT ticked
      await adminLogin(page); await clickTab(page, "Participants");
      await narrow(page, prefix);
      for (const u of [a, b]) {
        await page.locator(`#admin-participants-body input[type=checkbox][value="${u.id}"]`).check();
      }
      await expect(page.locator("#selection-bar-approve-btn")).toBeVisible();
      await page.locator("#selection-bar-approve-btn").click();
      await confirmModal(page, /Approve 2 User/);
      for (const u of [a, b]) {
        await expect.poll(() => dbGet("SELECT approved FROM users WHERE id=?", u.id).approved, { timeout: 10000 }).toBe(1);
      }
      expect(dbGet("SELECT approved FROM users WHERE id=?", bystander.id).approved, "an unticked pending row is untouched").toBe(0);
    } finally { await sa.dispose(); }
  });

  test("Unlock on a locked row lifts the lockout", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const u = await makeParticipant(sa, csrf, "unlock");
      dbRun("UPDATE users SET locked_until=?, failed_login_count=10, failed_login_first=? WHERE id=?",
        new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString(), u.id);
      await adminLogin(page); await clickTab(page, "Participants");
      await rowAction(page, u.email, "participant-unlock");
      await confirmModal(page, /Unlock/);
      await expect.poll(() => dbGet("SELECT locked_until FROM users WHERE id=?", u.id).locked_until, { timeout: 10000 }).toBeNull();
      expect(dbGet("SELECT failed_login_count FROM users WHERE id=?", u.id).failed_login_count).toBe(0);
      // …and the person can sign in again with their password.
      const s = await apiLogin(u.email, PARTICIPANT_PASS);
      await s.api.dispose();
    } finally { await sa.dispose(); }
  });

  test("Show sign-in code displays a code that WORKS — and it replaces the one handed out before", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const email = `desk-${uniq("code").replace(/[^a-z0-9]/gi, "").toLowerCase()}@acme.com`;
      const desk = await sa.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
      expect(desk.ok(), `desk-invite: ${await desk.text()}`).toBeTruthy();
      const firstCode = (await desk.json()).code;
      expect(firstCode, "PRECONDITION: the desk handed out a code").toBeTruthy();

      await adminLogin(page); await clickTab(page, "Participants");
      await rowAction(page, email, "participant-show-code");
      const dlg = page.locator("#modal-overlay.open");
      await dlg.waitFor({ state: "visible", timeout: 10000 });
      await expect(dlg).toContainText("Sign-in code");
      const shown = (await dlg.locator(".desk-code").innerText()).trim();
      expect(shown, "a code is displayed").toMatch(/\S{6,}/);
      await expect(dlg.locator(".desk-code-note"), "it says how long it lasts").toContainText(/Works once, for (about \d+ minutes?|a short time)/);
      await page.locator("#modal-confirm-btn").click();

      const { api: anon, csrf: ac } = await freshCtx();
      try {
        const old = await anon.post("/api/auth/code/redeem", { headers: H(ac), data: { email, code: firstCode } });
        expect((await old.json()).ok, "the code handed out before is superseded, as the dialog says").toBe(false);
        const r = await anon.post("/api/auth/code/redeem", { headers: H(ac), data: { email, code: shown } });
        expect(await r.json(), "the code on the admin's screen signs the participant in").toMatchObject({ ok: true, email });
        expect((await anon.get("/api/me")).status()).toBe(200);
      } finally { await anon.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("with an event focused: Invite puts the row in it and Remove takes it out; Make event admin grants and Remove as event admin revokes", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "focus-journeys");
      const guest = await makeParticipant(sa, csrf, "invitee");
      const org = await makeParticipant(sa, csrf, "organiser");
      await enrol(sa, csrf, comp.id, [org.id]);           // the organiser-to-be is already a member
      const member = (uid) => !!dbGet("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?", comp.id, uid);
      const organises = (uid) => !!dbGet("SELECT 1 AS x FROM competition_admins WHERE competition_id=? AND user_id=?", comp.id, uid);
      expect(member(guest.id), "PRECONDITION: the guest is not in the event").toBe(false);

      await adminLogin(page);
      await viewComp(page, comp.name);
      await clickTab(page, "Participants");

      await rowAction(page, guest.email, "participant-invite");
      await expect.poll(() => member(guest.id), { timeout: 10000 }).toBe(true);
      await rowAction(page, guest.email, "participant-uninvite");
      await confirmModal(page, /Remove/);
      await expect.poll(() => member(guest.id), { timeout: 10000 }).toBe(false);

      await rowAction(page, org.email, "participant-event-admin-grant");
      await confirmModal(page, /event admin/i);
      await expect.poll(() => organises(org.id), { timeout: 10000 }).toBe(true);
      expect(dbGet("SELECT role FROM users WHERE id=?", org.id).role, "the grant confers the tier").toBe("event_admin");
      await rowAction(page, org.email, "participant-event-admin-revoke");
      await confirmModal(page, /no longer organise/);
      await expect.poll(() => organises(org.id), { timeout: 10000 }).toBe(false);
      expect(dbGet("SELECT role FROM users WHERE id=?", org.id).role, "revoking a grant keeps the role (v8.7.0)").toBe("event_admin");
    } finally { await sa.dispose(); }
  });

  test("clicking a sortable header orders the rows by that column, and a second click reverses it", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const prefix = `sortp${Date.now() % 1e8}`;
      const tagA = `${prefix}aaa`, tagB = `${prefix}zzz`;
      const mk = async (t) => {
        const { api, csrf: c } = await freshCtx();
        const r = await registerPost(api, "/api/register", { headers: H(c), data: {
          firstName: "Sort", lastName: t, nickname: t.slice(0, 40), email: `${t}@acme.com`,
          company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London", password: PARTICIPANT_PASS } });
        expect(r.ok(), await r.text()).toBeTruthy(); await api.dispose();
      };
      await mk(tagB); await mk(tagA);                       // created in REVERSE order, so creation order cannot pass for a sort
      await adminLogin(page); await clickTab(page, "Participants");
      await narrow(page, prefix);
      const order = () => page.locator("#admin-participants-body tr").evaluateAll(
        (rs) => rs.map(r => r.textContent || "").map(t => (t.match(/sortp\d+(aaa|zzz)@/) || [])[1]).filter(Boolean));
      const emailTh = page.locator('th.sortable[data-action="sort-participants"][data-col="email"]');
      await emailTh.click();
      await expect.poll(order, { timeout: 8000 }).toEqual(["aaa", "zzz"]);
      await expect(emailTh).toHaveAttribute("aria-sort", "ascending");
      await emailTh.click();
      await expect.poll(order, { timeout: 8000 }).toEqual(["zzz", "aaa"]);
      await expect(emailTh).toHaveAttribute("aria-sort", "descending");
    } finally { await sa.dispose(); }
  });
});
