// @ts-check
//
// v7.21.11 — A STORED VALUE THE PICKER DOES NOT CONTAIN MUST SURVIVE.
//
// `country` is deliberately FREE TEXT on the server (v7.21.1 A7: nothing
// computes with it, and a stale ISO-3166 allowlist would be a lockout rather
// than a hardening — the participant import and the invited-LinkedIn capture are
// not constrained to any vocabulary, and this repo's own fixtures carry "UK"
// while the COUNTRY_TZ key is "GB").
//
// Every CLIENT edit surface, though, is a closed <select> over COUNTRY_TZ. So a
// participant whose country arrived by either of those paths saw the field
// render BLANK — and country is required client-side, so they could not save
// their own profile at all without first replacing their real country with a
// listed one. The timezone went with it, because the timezone list is rebuilt
// from the country and an unknown country left it empty.
//
// Three surfaces, and the consequences differ:
//   • the profile editor      — the participant cannot save anything;
//   • the completion GATE     — non-dismissible, so they are trapped;
//   • the admin edit dialog   — a superadmin sees blank and a save REPLACES the
//                               participant's real country with whatever they
//                               pick (fillRequired only keeps the current value
//                               when the incoming one is blank).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, BASE, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// Deliberately NOT a COUNTRY_TZ key. "UK" is the repo's own fixture value and
// the exact shape an operator's spreadsheet produces; the key is "GB".
const ODD_COUNTRY = "UK";
const ODD_TZ = "Europe/London";

function withDb(fn, ro = true) {
  const db = new Database(TEST_DB_PATH, ro ? { readonly: true } : undefined);
  try { return fn(db); } finally { db.close(); }
}

/** A participant whose stored country is outside the picker's vocabulary. */
async function mkOddParticipant(sa, csrf, tag) {
  const email = `odd-${tag}@company.example`;
  expect((await registerPost(sa, "/api/register", { headers: H(csrf), data: {
    firstName: "Odd", lastName: "Country", nickname: `odd_${tag}`, email,
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
    password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "London",
  }})).ok(), "register").toBeTruthy();
  const u = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  expect(u, "participant findable").toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  // Write the out-of-vocabulary values the way the import / OAuth capture does.
  // Going through SQL rather than an endpoint is deliberate: this is the state
  // those paths legitimately produce, and the test is about the CLIENT.
  withDb(d => d.prepare("UPDATE users SET country=?, timezone=? WHERE id=?")
    .run(ODD_COUNTRY, ODD_TZ, u.id), false);
  return { id: u.id, email };
}

async function loginAs(page, email, password) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: password });
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy();
}

test("v7.21.11: a participant whose country is not in the picker can still save their profile", async ({ page }) => {
  const tag = uniq();
  const { api: sa, csrf } = await apiLogin("superadmin");
  let p;
  try { p = await mkOddParticipant(sa, csrf, tag); } finally { await sa.dispose(); }

  await loginAs(page, p.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.openProfileEditor === "function", null, { timeout: 30000 });
  await page.evaluate(() => window.openProfileEditor());

  const country = page.locator("#prof-country");
  const tz = page.locator("#prof-tz");
  await expect(country).toBeVisible({ timeout: 10000 });

  // THE DEFECT: the stored value must not render as an unset field.
  await expect(country,
    "a stored country outside COUNTRY_TZ must be shown, not silently blank — country is " +
    "required client-side, so a blank field means the participant cannot save at all without " +
    "first overwriting their real country"
  ).toHaveValue(ODD_COUNTRY);
  await expect(tz,
    "…and the timezone must survive too: its list is rebuilt from the country, so an " +
    "unrecognised country used to leave it empty"
  ).toHaveValue(ODD_TZ);

  // And the save round-trips it untouched.
  await page.locator("#prof-save, [data-action='save-profile']").first().click();
  const confirm = page.locator("#modal-confirm-btn");
  if (await confirm.isVisible().catch(() => false)) await confirm.click();

  await expect.poll(() => withDb(d => d.prepare("SELECT country FROM users WHERE id=?").get(p.id).country),
    { timeout: 10000, intervals: [100, 250, 500] }
  ).toBe(ODD_COUNTRY);
  expect(withDb(d => d.prepare("SELECT timezone FROM users WHERE id=?").get(p.id).timezone),
    "the save must not have replaced the timezone either").toBe(ODD_TZ);
});

test("v7.21.11: the non-dismissible completion GATE does not trap them either", async ({ page }) => {
  const tag = uniq();
  const { api: sa, csrf } = await apiLogin("superadmin");
  let p;
  try {
    p = await mkOddParticipant(sa, csrf, tag);
    // Reproduce the COMPOUND scenario, which is how this is actually reached:
    // the participant import DROPS a timezone `Intl` cannot resolve to empty
    // (v7.21.2), which puts that participant into the non-dismissible completion
    // gate — and the gate renders the country row only when country/timezone is
    // missing. So the timezone drop is what exposes the odd country here, and
    // satisfying the gate for the TIMEZONE used to force overwriting the
    // COUNTRY. Clearing it in SQL is exactly what the import does.
    withDb(d => d.prepare("UPDATE users SET timezone='' WHERE id=?").run(p.id), false);
  } finally { await sa.dispose(); }

  await loginAs(page, p.email, PARTICIPANT_PASS);
  await page.goto("/");
  const gateCountry = page.locator("#gate-country");
  await expect(gateCountry,
    "the completion gate is non-dismissible, so a blank required country there is a trap"
  ).toBeVisible({ timeout: 30000 });
  await expect(gateCountry,
    "the gate opened because the TIMEZONE was dropped — the country must not be collateral. " +
    "Blank here means satisfying the gate requires replacing a country the participant never " +
    "chose to change."
  ).toHaveValue(ODD_COUNTRY);
  // The timezone is legitimately blank (that is why the gate fired); the point
  // is that fixing it must not cost the country.
  await expect(page.locator("#gate-tz"), "the timezone is the field they came here to set").toHaveValue("");
});

test("v7.21.11: an admin opening the profile sees the real country, so a save cannot replace it", async ({ page }) => {
  const tag = uniq();
  const { api: sa, csrf } = await apiLogin("superadmin");
  let p;
  try { p = await mkOddParticipant(sa, csrf, tag); } finally { await sa.dispose(); }

  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const { getSuperadminPass } = require("./helpers");
  const r = await page.request.post("/api/login", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), "superadmin signs in").toBeTruthy();
  await page.goto("/");
  await page.waitForFunction(() => typeof window.adminEditProfile === "function", null, { timeout: 30000 });
  // The dialog renders entirely from S.adminParticipantsData (CLAUDE.md
  // v7.15.8), so the list has to be loaded before the row can be opened —
  // calling adminEditProfile against an empty array renders nothing at all.
  await page.evaluate(() => window.loadAdminParticipants());
  await page.waitForFunction((id) => (window.S?.adminParticipantsData || []).some(u => u.id === id),
    p.id, { timeout: 30000 });
  await page.evaluate((id) => window.adminEditProfile(id), p.id);

  await expect(page.locator("#adp-country"),
    "a blank field here is worse than an inconvenience: fillRequired keeps the current value " +
    "only when the incoming one is BLANK, so an admin who picks a listed country to satisfy " +
    "the form silently replaces the participant's real one"
  ).toHaveValue(ODD_COUNTRY, { timeout: 10000 });
  await expect(page.locator("#adp-tz")).toHaveValue(ODD_TZ);
});
