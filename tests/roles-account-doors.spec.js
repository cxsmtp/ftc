// @ts-check
//
// ROLES & PERMISSIONS: AN ADMIN ACCOUNT'S OWN DOORS (owner decision, 27 Nov 2026).
//
// People no longer lists the platform's admin accounts, so each user row on Roles
// & permissions offers what People's row menu offered them: Edit or View
// profile, History, Block or Unblock, Unlock, Email sign-in code. The doors are
// People's own (participants-admin.js `accountDoors`, one definition) over
// People's own rows for those accounts (GET /api/admin/participants?kind=admins),
// and every press goes to the route People's press goes to.
//
// Locked here, by value:
//   (1) a superadmin's row menu offers the four doors, and each one works: Block
//       stores the block and the row then offers Unblock (which lifts it), a
//       locked account offers Unlock (which clears the lock), History opens the
//       account's history, Email sign-in code mails one, Edit Profile opens the
//       editable profile;
//   (2) a regular admin looking at a fellow admin gets the privileged-account
//       note, View Profile and History, and no Block or sign-in code — exactly
//       where the routes refuse (CONTROL: the route answers 403 for that pair);
//   (3) a role that may read Roles & permissions but not People gets no doors at
//       all (the doors act on People's rows), while the list still renders.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, BASE, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { adminLogin, loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const F = {};
const dbRow = (id) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT blocked, locked_until FROM users WHERE id=?").get(id); } finally { db.close(); }
};
const dbRun = (sql, ...args) => {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const mkAdmin = async (label, role = "admin") => {
      const p = await makeParticipant(sa, csrf, label);
      const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(csrf), data: { role } });
      expect(r.ok(), `role ${label}: ${await r.text()}`).toBeTruthy();
      return p;
    };
    F.target = await mkAdmin("rpdoor-t");
    F.locked = await mkAdmin("rpdoor-l");
    F.viewer = await mkAdmin("rpdoor-v");
    // A lock as the lockout writes it (lib/lockout.js), an hour ahead.
    dbRun("UPDATE users SET locked_until=? WHERE id=?", new Date(Date.now() + 3600_000).toISOString(), F.locked.id);
    // A role that reads Roles & permissions but not People.
    const role = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `Roles reader ${Date.now()}`, scope_mode: "all", permissions: ["panel.access", "users.view"] } });
    expect(role.ok(), `custom role: ${await role.text()}`).toBeTruthy();
    F.readerRole = (await role.json()).role.id;
    F.reader = await mkAdmin("rpdoor-r", F.readerRole);
  } finally { await sa.dispose(); }
});

async function openRoles(page) {
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 30000 });
  await page.locator("button.admin-nav-item[data-tab-id='admin-users-tab']").first().evaluate((el) => el.click());
  await expect(page.locator("#admin-users-tab .ua-table")).toBeVisible({ timeout: 15000 });
}
const rowOf = (page, email) => page.locator("#admin-users-tab .ua-table tbody tr", { hasText: email });

/** Open a row's doors menu and return its item labels and notes. */
async function doorsOf(page, email) {
  await page.locator("#ua-search").fill(email);
  const row = rowOf(page, email);
  await expect(row).toHaveCount(1, { timeout: 10000 });
  const btn = row.locator(".ua-doors");
  await expect(btn, `${email}: the row offers its account doors`).toBeVisible({ timeout: 15000 });
  await btn.click();
  const portal = page.locator("#kebab-portal.open");
  await expect(portal).toBeVisible({ timeout: 5000 });
  return {
    portal,
    items: (await portal.locator("button").allTextContents()).map((t) => t.trim()),
    notes: (await portal.locator(".kebab-note").allTextContents()).map((t) => t.trim()),
  };
}
const press = async (portal, label) => portal.locator("button", { hasText: label }).first().click();
const confirm = async (page) => {
  const ok = page.locator("#modal-overlay.open #modal-confirm-btn");
  await expect(ok).toBeVisible({ timeout: 10000 });
  await ok.click();
};

test("a superadmin's row menu offers an admin account's doors, and each one works", async ({ page }) => {
  await adminLogin(page);
  await openRoles(page);
  let m = await doorsOf(page, F.target.email);
  expect(m.items, "People's doors, in People's words").toEqual(["Edit Profile", "History", "Block", "Email sign-in code"]);
  expect(m.notes, "nothing withheld, nothing explained").toEqual([]);

  // Block, then Unblock: stored, and the row follows.
  await press(m.portal, "Block");
  await confirm(page);
  await expect.poll(() => dbRow(F.target.id).blocked, { timeout: 10000 }).toBe(1);
  await expect(rowOf(page, F.target.email)).toContainText("blocked", { timeout: 10000 });
  m = await doorsOf(page, F.target.email);
  expect(m.items).toContain("Unblock");
  expect(m.items).not.toContain("Block");
  await press(m.portal, "Unblock");
  await confirm(page);
  await expect.poll(() => dbRow(F.target.id).blocked, { timeout: 10000 }).toBe(0);

  // History: the account's own.
  await expect(rowOf(page, F.target.email)).toContainText("active", { timeout: 10000 });
  m = await doorsOf(page, F.target.email);
  await press(m.portal, "History");
  await expect(page.locator("text=/History: Event rpdoor-t/").first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Escape");

  // Email sign-in code: one is mailed to the account's address.
  const before = await (await page.request.get(`/api/test/last-login-code?email=${encodeURIComponent(F.target.email)}`)).json().catch(() => null);
  m = await doorsOf(page, F.target.email);
  await press(m.portal, "Email sign-in code");
  await confirm(page);
  await expect.poll(async () => {
    const r = await page.request.get(`/api/test/last-login-code?email=${encodeURIComponent(F.target.email)}`);
    const d = r.ok() ? await r.json() : null;
    return !!(d && d.code && JSON.stringify(d) !== JSON.stringify(before));
  }, { timeout: 10000, message: "a sign-in code was mailed" }).toBe(true);

  // Edit Profile: the editable profile of that account.
  m = await doorsOf(page, F.target.email);
  await press(m.portal, "Edit Profile");
  const ov = page.locator("#admin-profile-overlay");
  await expect(ov).toBeVisible({ timeout: 10000 });
  await expect(ov.locator("#adp-email")).toHaveValue(F.target.email);
  await expect(ov.locator("#adp-email"), "editable by a superadmin").toBeEnabled();
  await page.keyboard.press("Escape");

  // A locked account: Unlock in Block's place, and it clears the lock.
  m = await doorsOf(page, F.locked.email);
  expect(m.items).toContain("Unlock");
  expect(m.items).not.toContain("Block");
  await press(m.portal, "Unlock");
  await confirm(page);
  await expect.poll(() => dbRow(F.locked.id).locked_until, { timeout: 10000 }).toBeNull();
});

test("a regular admin looking at a fellow admin gets the note, View Profile and History — where the routes refuse the rest", async ({ page }) => {
  await loginViaApi(page, F.viewer.email, PARTICIPANT_PASS);
  await openRoles(page);
  const m = await doorsOf(page, F.target.email);
  expect(m.items, "only the reads").toEqual(["View Profile", "History"]);
  expect(m.notes.join(" "), "with the reason").toContain("only superadmins can manage it");
  await page.keyboard.press("Escape");
  // CONTROL: the route refuses this pair, so the doors withheld are exactly the refused ones.
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const r = await page.request.post(`/api/admin/participants/${F.target.id}/block`, { headers: H(csrf) });
  expect(r.status(), "a regular admin cannot block an admin").toBe(403);
  expect(dbRow(F.target.id).blocked, "and nothing changed").toBe(0);
});

test("a role that reads Roles & permissions but not People gets the list with no account doors", async ({ page }) => {
  const asked = [];
  page.on("request", (q) => { if (q.url().includes("/api/admin/participants")) asked.push(q.url()); });
  await loginViaApi(page, F.reader.email, PARTICIPANT_PASS);
  await openRoles(page);
  await page.locator("#ua-search").fill(F.target.email);
  await expect(rowOf(page, F.target.email), "the list renders").toHaveCount(1, { timeout: 10000 });
  await expect(page.locator("#admin-users-tab .ua-doors"), "no doors without People's rows").toHaveCount(0);
  expect(asked.filter((u) => u.includes("kind=admins")), "and no read it would be refused (a refusal counts towards the scanner block)").toEqual([]);
  await expect(page.locator("#ua-doors-unread"), "nothing failed, so nothing to explain").toHaveCount(0);
});
