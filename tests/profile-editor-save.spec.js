// @ts-check
//
// The Edit Profile dialog's own save, where it disagreed with the server:
//   • City and Job function are optional for every account — PUT /api/me stores
//     either one blank, and an event that requires one asks for it through the
//     completion gate — so the dialog neither marks them required nor refuses a
//     save without them;
//   • a save in Admin View repaints the account button only: the participant
//     bar belongs to participant view, and writing it into the admin shell left
//     an organiser with Events / Challenges / Leaderboard over the admin panel.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");
const { pressAccountMenuItem } = require("./chrome-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const dbRun = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...a); } finally { db.close(); }
};

async function openEditor(page) {
  await pressAccountMenuItem(page, "open-profile-editor");
  await expect(page.locator("#profile-overlay")).toBeVisible({ timeout: 10000 });
}

async function saveAndConfirm(page) {
  await page.locator('#profile-overlay [data-action="save-profile"]').click();
  await expect(page.locator("#modal-overlay.open")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#modal-title")).toHaveText(/Save changes\?/);
  await page.locator("#modal-confirm-btn").click();
}

/** PUT /api/me bodies this page sent. */
function trackProfilePuts(page) {
  const puts = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/me") puts.push(r.postDataJSON());
  });
  return puts;
}

test("Edit Profile saves with City and Job function blank, and marks neither required", async ({ page }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let p;
  try { p = await makeParticipant(sa, csrf, "nocityjob"); } finally { await sa.dispose(); }
  // The short form leaves both blank; set that state before this account's
  // first /api/me, so no cached copy can say otherwise.
  dbRun("UPDATE users SET city=NULL, job_function=NULL WHERE id=?", p.id);
  expect(dbGet("SELECT city, job_function FROM users WHERE id=?", p.id), "PRECONDITION: both blank").toEqual({ city: null, job_function: null });
  const puts = trackProfilePuts(page);

  await loginViaApi(page, p.email);
  await page.goto("/");
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 20000 });
  await openEditor(page);

  for (const id of ["prof-city", "prof-job-function"]) {
    await expect(page.locator(`#${id}`), `${id} is not announced as required`).not.toHaveAttribute("aria-required", "true");
    await expect(page.locator(`label[for="${id}"] .req`), `${id} carries no required star`).toHaveCount(0);
  }
  // CONTROL: the base set is still required, star and announcement together.
  await expect(page.locator("#prof-company")).toHaveAttribute("aria-required", "true");
  await expect(page.locator('label[for="prof-company"] .req')).toHaveCount(1);

  // NEGATIVE CONTROL: an emptied base-set field is still refused before any PUT.
  await page.fill("#prof-company", "");
  await page.locator('#profile-overlay [data-action="save-profile"]').click();
  await expect(page.locator("#prof-error")).toHaveText("Required: Company.");
  expect(puts, "a refused save sends nothing").toEqual([]);

  const company = `Blank City Co ${Date.now()}`;
  await page.fill("#prof-company", company);
  await saveAndConfirm(page);
  await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => dbGet("SELECT company FROM users WHERE id=?", p.id).company, { message: "the save reached the server" }).toBe(company);
  expect(puts.length, "exactly one PUT").toBe(1);
  expect(dbGet("SELECT city, job_function FROM users WHERE id=?", p.id), "both stay blank").toEqual({ city: null, job_function: null });
  // Participant view keeps its bar after a save (the control for the next test).
  await expect(page.locator("#main-nav .nav-btn")).toHaveCount(3);
});

test("saving your own profile in Admin View keeps the admin shell: no participant bar appears", async ({ page }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let a;
  try {
    a = await makeParticipant(sa, csrf, "adminprofile");
    const r = await sa.post(`/api/admin/participants/${a.id}/role`, { headers: H(csrf), data: { role: "admin" } });
    expect(r.ok(), `promote: ${r.status()} ${await r.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
  expect(dbGet("SELECT role FROM users WHERE id=?", a.id).role, "PRECONDITION: a user-backed admin").toBe("admin");
  const puts = trackProfilePuts(page);

  await loginViaApi(page, a.email);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#profile-menu-btn")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#main-nav .nav-btn"), "PRECONDITION: the admin shell has no participant bar").toHaveCount(0);

  await openEditor(page);
  // Mark the header's account button: the repaint after the save replaces it,
  // which is how this test knows the refresh has run before it reads the bar.
  await page.evaluate(() => { const b = document.getElementById("profile-menu-btn"); if (b) b.dataset.beforeSave = "1"; });
  const company = `Admin Co ${Date.now()}`;
  await page.fill("#prof-company", company);
  await saveAndConfirm(page);
  await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => dbGet("SELECT company FROM users WHERE id=?", a.id).company, { message: "the save reached the server" }).toBe(company);
  expect(puts.length).toBe(1);
  await expect(page.locator('#profile-menu-btn[data-before-save="1"]'), "the header was repainted after the save").toHaveCount(0, { timeout: 10000 });
  await expect(page.locator("#profile-menu-btn")).toBeVisible();

  await expect(page.locator("#main-nav .nav-btn"), "no participant bar in Admin View").toHaveCount(0);
  await expect(page.locator("#admin-page")).toBeVisible();
});
