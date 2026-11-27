// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// v8.3.37 — A PROFILE SAVE CARRIES ONLY WHAT CHANGED
//
// Both editors used to submit the WHOLE form on every save, reading each input
// as it stood when the dialog OPENED, and neither route has optimistic
// concurrency — `users` has no `updated_at` column at all. So every save was a
// last-writer-wins over sixteen fields. The concurrent writer is not exotic: an
// organiser correcting a record through `PUT /api/admin/participants/:id` while
// the participant has their own editor open is a routine live-event occurrence.
//
// WHAT THIS LOCKS, and why each arm exists:
//  1. the body is SPARSE — the discriminating assertion, and the one that fails
//     against the pre-v8.3.37 build;
//  2. CLEARING is still an edit, sent as "" — the rule that must not be broken.
//     `certificateGivenName` / `certificateFamilyName` / `secondaryEmail` carry
//     comments at both call sites saying they must be sent even when empty,
//     because clearing them has to mean "clear". A naive "drop empty strings"
//     would make them unclearable, which is the one-way door PR 24 refused;
//  3. `jobFunction` is diffed per BODY KEY, not per element id — it is derived
//     from TWO inputs (the select plus its "Other…" box), and an element-wise
//     diff reports a free-text role as permanently dirty and misses real edits;
//  4. an auto-detected country/timezone is still PERSISTED. `autoDetectCountryTz`
//     runs BEFORE the dialog's own snapshot, so a DOM-snapshot baseline would
//     compare EQUAL and silently drop it — on exactly the accounts the
//     completion gate exists for. Baselining against the SERVER ROW is what
//     makes this right, and this arm is why that decision is not free;
//  5. the admin dialog gets the same treatment, and its certificate-name fields
//     now actually round-trip (see below).
// ═══════════════════════════════════════════════════════════════════════════
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, BASE, codeLogin } = require("./helpers");
const crypto = require("crypto");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
};

async function mkParticipant(tag, over = {}) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const H = { "x-csrf-token": csrf };
  const JH = { ...H, "content-type": "application/json" };
  const email = `sparse-${tag}@cust.test`;
  try {
    await registerPost(sa, "/api/register", {
      headers: JH,
      data: {
        firstName: "Sp", lastName: `Arse${tag}`, nickname: `sparse_${tag}`,
        email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
        avatar: "default1", country: "US", timezone: "America/New_York", ...over,
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const id = (list.participants || []).find(p => p.email === email)?.id;
    expect(id, "the participant must be findable").toBeTruthy();
    await sa.post(`/api/admin/participants/${id}/verify`, { headers: H });
    await sa.post(`/api/admin/participants/${id}/approve`, { headers: H });
    return { id, email };
  } finally { await sa.dispose(); }
}

/** Sign the browser in as this participant and open their own profile editor. */
async function openSelfEditor(page, email) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" });
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });
  await page.evaluate(() => window.openProfileEditor());
  await page.locator("#profile-overlay").waitFor({ state: "visible", timeout: 10000 });
}

/**
 * The FIELD keys of a captured save body, with the optimistic-concurrency token
 * removed — and asserted PRESENT on the way past.
 *
 * RE-POINTED, not weakened. This file's subject is unchanged: a save must carry
 * only the fields the dialog actually EDITED, never the sixteen it merely read.
 * `expectedUpdatedAt` is not one of those fields — it is the fingerprint of the
 * row the dialog was rendered from, which both editors now echo so the server
 * can 409 a second writer instead of letting last-writer-wins clobber it (the
 * gap v8.3.37's own header names: "it does not make concurrent edits safe").
 *
 * Asserting it is present makes every call site STRICTER than before: a build
 * that silently stopped sending the token — which would put both dialogs back on
 * the unchecked back-compat path, the control present and inert — now fails here
 * as well as in tests/profile-concurrency.spec.js.
 */
function fieldKeys(seen) {
  expect(seen.body, "a save body was captured").toBeTruthy();
  expect(seen.body.expectedUpdatedAt,
    "the dialog must echo the row fingerprint it was rendered from").toBeTruthy();
  const { expectedUpdatedAt: _tok, ...fields } = seen.body;
  return Object.keys(fields).sort();
}

/** Capture the PUT body the next save sends (null if no request is made). */
function captureBody(page, urlPart) {
  const seen = { body: null, count: 0 };
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes(urlPart)) {
      seen.count++;
      try { seen.body = JSON.parse(req.postData() || "{}"); } catch (_) { seen.body = {}; }
    }
  });
  return seen;
}

async function saveAndConfirm(page) {
  await page.locator("#profile-overlay button:has-text('Save')").first().click();
  const confirm = page.locator("#modal-overlay button:has-text('Save')");
  if (await confirm.count()) await confirm.first().click().catch(() => {});
}

/**
 * Open the admin edit-profile dialog for a participant, waiting for the thing
 * that actually has to be true first.
 *
 * v8.3.39 — both call sites used to wait on `#admin-page` being visible and then
 * call straight through, which flaked once at WORKERS=18. `adminEditProfile`
 * renders ENTIRELY from `S.adminParticipantsData` and opens with
 * `if (!p) return;`, so against a model that has not loaded yet it is a SILENT
 * no-op and the failure surfaces ten seconds later as "#admin-profile-overlay
 * never became visible" — naming the overlay rather than the empty list. And
 * `#admin-page` is visible as soon as boot resolves who we are (v8.3.33), which
 * is strictly before the participants list has been fetched: a readiness signal
 * that is true too early, exactly the class that release is about.
 *
 * The suite already had the right shape in `country-freetext-ui.spec.js` and
 * `profile-avatar.spec.js` — wait for the ROW to be in the model — so this reuses
 * it rather than writing a third variant (v7.21.25).
 */
async function openAdminProfile(page, id) {
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(() => typeof window.adminEditProfile === "function", null, { timeout: 30000 });
  await page.waitForFunction(
    (uid) => (window.S?.adminParticipantsData || []).some(u => u.id === uid),
    id, { timeout: 30000 });
  await page.evaluate((uid) => window.adminEditProfile(uid), id);
  await page.locator("#admin-profile-overlay").waitFor({ state: "visible", timeout: 10000 });
}

test.describe("v8.3.37 — a profile save carries only what changed", () => {
  test("ONE edited field means ONE key on the wire, and the rest are untouched", async ({ page }) => {
    const tag = crypto.randomBytes(4).toString("hex");
    const { id, email } = await mkParticipant(tag);
    const before = dbGet("SELECT company, title, city, secondary_email FROM users WHERE id=?", id);

    await openSelfEditor(page, email);
    const seen = captureBody(page, "/api/me");
    await page.fill("#prof-city", "Sparseville");
    await saveAndConfirm(page);
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });

    expect(seen.count, "exactly one save request").toBe(1);
    // THE DISCRIMINATING ASSERTION. Pre-v8.3.37 this body carried all seventeen
    // keys, every one of them a value read when the dialog opened.
    expect(fieldKeys(seen), "only the edited key is sent").toEqual(["city"]);
    expect(seen.body.city).toBe("Sparseville");

    // …and the fields the dialog merely READ are untouched in the row.
    const after = dbGet("SELECT company, title, city, secondary_email FROM users WHERE id=?", id);
    expect(after.city, "the edit landed").toBe("Sparseville");
    expect(after.company).toBe(before.company);
    expect(after.title).toBe(before.title);
    expect(after.secondary_email).toBe(before.secondary_email);
  });

  test("CLEARING a field is an edit, and is sent as an empty string", async ({ page }) => {
    // The rule that must survive: the discriminator is DIRTINESS, never
    // TRUTHINESS. A "drop empty strings" diff would make these unclearable.
    const tag = crypto.randomBytes(4).toString("hex");
    const { id, email } = await mkParticipant(tag);
    {
      const p = await apiLogin(email, PARTICIPANT_PASS);
      const r = await p.api.put("/api/me", {
        headers: { "x-csrf-token": p.csrf, "content-type": "application/json" },
        data: { certificateGivenName: "Jane", certificateFamilyName: "Doe", phone: "+123456" },
      });
      expect(r.status(), "precondition: seed values to clear").toBe(200);
      await p.api.dispose();
    }
    expect(dbGet("SELECT certificate_given_name FROM users WHERE id=?", id).certificate_given_name,
      "precondition: there is something to clear").toBe("Jane");

    await openSelfEditor(page, email);
    const seen = captureBody(page, "/api/me");
    await page.fill("#prof-cert-given", "");
    await saveAndConfirm(page);
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });

    // Assert the REQUEST HAPPENED first: a diff that drops empty strings makes
    // the body empty, the save short-circuits, and the next line would fail with
    // an opaque TypeError on a null body instead of naming the cause.
    expect(seen.count, "clearing a field is a change, so it must still save").toBe(1);
    expect(fieldKeys(seen), "the cleared key is sent, and only it").toEqual(["certificateGivenName"]);
    expect(seen.body.certificateGivenName, "as an EMPTY STRING, which is what means 'clear'").toBe("");
    const row = dbGet("SELECT certificate_given_name, certificate_family_name, phone FROM users WHERE id=?", id);
    expect(row.certificate_given_name, "and it really cleared").toBeFalsy();
    expect(row.certificate_family_name, "while its untouched sibling survived").toBe("Doe");
    expect(row.phone, "and so did the other optional field").toBe("+123456");
  });

  test("an UNTOUCHED form still sends nothing at all", async ({ page }) => {
    // The control. Without it, "only what changed is sent" is equally satisfied
    // by a build that sends nothing ever — which would break saving outright.
    const tag = crypto.randomBytes(4).toString("hex");
    const { email } = await mkParticipant(tag);
    await openSelfEditor(page, email);
    const seen = captureBody(page, "/api/me");
    await page.locator("#profile-overlay button:has-text('Save')").first().click();
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });
    expect(seen.count, "an unchanged form makes no request and raises no confirmation").toBe(0);
  });

  test("jobFunction is diffed per BODY KEY, not per element — a free-text role is not permanently dirty", async ({ page }) => {
    // `jobFunction` is derived from the select PLUS its "Other…" box. Diffed
    // element-wise, a participant whose stored role is free text has the select
    // reading 'other' against a stored value that is not 'other', so every save
    // would report it dirty and re-send it; and switching to 'other' with
    // identical text would look changed.
    const tag = crypto.randomBytes(4).toString("hex");
    const { id, email } = await mkParticipant(tag, { jobFunction: "Chief Herder of Cats" });
    expect(dbGet("SELECT job_function FROM users WHERE id=?", id).job_function,
      "precondition: a free-text role").toBe("Chief Herder of Cats");

    await openSelfEditor(page, email);
    const seen = captureBody(page, "/api/me");
    // Edit something ELSE. If jobFunction were diffed element-wise it would ride
    // along on this save.
    await page.fill("#prof-city", "Elsewhere");
    await saveAndConfirm(page);
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });

    expect(fieldKeys(seen), "the free-text role is NOT dirty").toEqual(["city"]);
    expect(dbGet("SELECT job_function FROM users WHERE id=?", id).job_function,
      "and it survives untouched").toBe("Chief Herder of Cats");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Its own describe, because `test.use({timezoneId})` is per-describe — and the
// pin is REQUIRED, not tidiness. `autoDetectCountryTz` looks the browser's zone
// up in COUNTRY_TZ, and the CI container runs **UTC**, which maps to no country
// at all: the select stays blank, the precondition fails, and the arm reports a
// broken product on a correct build. Exactly the v7.15.23 class — a defect
// every local run missed because developer machines have a named timezone.
// Pinning makes it reproduce on ANY machine instead of depending on the runner.
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.37 — the auto-detect trap (browser zone pinned)", () => {
  const BROWSER_TZ = "America/New_York";
  test.use({ timezoneId: BROWSER_TZ });

  test("an AUTO-DETECTED country/timezone is still persisted (admin dialog)", async ({ page }) => {
    // THE TRAP THAT DECIDED THE DESIGN. `autoDetectCountryTz` fills a blank
    // country/timezone select BEFORE the dialog takes its own snapshot, so a
    // DOM-snapshot baseline compares EQUAL and drops them — silently
    // un-persisting exactly the accounts that most need the value. Baselining
    // against the SERVER ROW is what keeps this working.
    //
    // Driven through the ADMIN dialog, deliberately: a participant whose own
    // country is blank meets the NON-DISMISSIBLE profile-completion gate in
    // their own editor and can never reach it, so the self dialog cannot
    // exercise this state at all. Both dialogs run the same auto-detect and the
    // same diff, so the admin door is where the trap is reachable.
    const tag = crypto.randomBytes(4).toString("hex");
    const { id } = await mkParticipant(tag);
    {
      const d = new Database(TEST_DB_PATH);
      try { d.prepare("UPDATE users SET country=NULL, timezone=NULL WHERE id=?").run(id); } finally { d.close(); }
    }

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const login = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: require("./helpers").getSuperadminPass() },
    });
    expect(login.ok(), "superadmin login").toBeTruthy();
    await page.goto("/");
    await openAdminProfile(page, id);

    const detected = await page.evaluate(() => ({
      country: document.getElementById("adp-country")?.value || "",
      tz: document.getElementById("adp-tz")?.value || "",
      browserTz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    }));
    // Assert the PIN took, per tests/sessions-admin-ui.spec.js's precedent: on a
    // runner that ignored timezoneId this test could otherwise pass or fail for
    // a reason that has nothing to do with the diff.
    expect(detected.browserTz, "Playwright must have applied timezoneId").toBe(BROWSER_TZ);
    expect(detected.country, "precondition: auto-detect filled the blank country").toBeTruthy();

    const seen = captureBody(page, `/api/admin/participants/${id}`);
    await page.fill("#adp-city", "Detectville");
    await page.locator("#admin-profile-overlay button:has-text('Save')").first().click();
    const confirm = page.locator("#modal-overlay button:has-text('Save')");
    if (await confirm.count()) await confirm.first().click().catch(() => {});
    await expect(page.locator("#admin-profile-overlay")).toHaveCount(0, { timeout: 10000 });

    expect(fieldKeys(seen), "the auto-filled values ride along, because the ROW is blank")
      .toEqual(["city", "country", "timezone"]);
    const row = dbGet("SELECT country, timezone FROM users WHERE id=?", id);
    expect(row.country, "and they are persisted").toBe(detected.country);
    expect(row.timezone).toBe(detected.tz);
  });
});

test.describe("v8.3.37 — the admin dialog, and the certificate name it used to discard", () => {
  test("the ADMIN route finally stores the certificate name it renders", async () => {
    // A PRE-EXISTING defect, surfaced by making the body sparse. The shared form
    // renders both fields for this dialog, `_PARTICIPANT_ROW_COLUMNS` selects
    // them so they arrive pre-filled, they are in the dirty snapshot, the client
    // sent them on every save — and the handler named them NOWHERE, so the save
    // reported success and stored nothing. A control that appears to work.
    //
    // The existing spec that looks like it covers this (`profile-avatar.spec.js`
    // "a CERTIFICATE-NAME-only edit is a change, and it round-trips") asserts
    // only that Cancel raises the discard prompt — it never checks the round
    // trip its own title claims, which is consistent with there not being one.
    // The fixture logs in as the superadmin itself, and this platform enforces
    // ONE session per user — so build it BEFORE opening the session this test
    // uses, or that session is invalidated and every call 401s (the v7.19.0 trap).
    const tag = crypto.randomBytes(4).toString("hex");
    const { id } = await mkParticipant(tag);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    try {
      const r = await sa.put(`/api/admin/participants/${id}`, {
        headers: JH, data: { certificateGivenName: "Maria", certificateFamilyName: "García" },
      });
      expect(r.status(), `admin save: ${await r.text().catch(() => "")}`).toBe(200);
      const row = dbGet("SELECT certificate_given_name, certificate_family_name FROM users WHERE id=?", id);
      expect(row.certificate_given_name, "the admin's certificate name is stored").toBe("Maria");
      expect(row.certificate_family_name).toBe("García");

      // …and it is clearable, through the same fillOptional rule as every other
      // optional field on this route.
      const clr = await sa.put(`/api/admin/participants/${id}`, {
        headers: JH, data: { certificateGivenName: "", certificateFamilyName: "" },
      });
      expect(clr.status()).toBe(200);
      const after = dbGet("SELECT certificate_given_name, certificate_family_name FROM users WHERE id=?", id);
      expect(after.certificate_given_name, "a superadmin can clear it").toBeFalsy();
      expect(after.certificate_family_name).toBeFalsy();
    } finally {
      await sa.delete(`/api/admin/participants/${id}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("the admin dialog sends only what the admin edited", async ({ page }) => {
    const tag = crypto.randomBytes(4).toString("hex");
    const { id } = await mkParticipant(tag);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const login = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: require("./helpers").getSuperadminPass() },
    });
    expect(login.ok(), "superadmin login").toBeTruthy();
    await page.goto("/");
    await openAdminProfile(page, id);

    const before = dbGet("SELECT company, title, city FROM users WHERE id=?", id);
    const seen = captureBody(page, `/api/admin/participants/${id}`);
    await page.fill("#adp-company", "Reassigned Ltd");
    await page.locator("#admin-profile-overlay button:has-text('Save')").first().click();
    const confirm = page.locator("#modal-overlay button:has-text('Save')");
    if (await confirm.count()) await confirm.first().click().catch(() => {});
    await expect(page.locator("#admin-profile-overlay")).toHaveCount(0, { timeout: 10000 });

    expect(seen.count, "exactly one save request").toBe(1);
    expect(fieldKeys(seen), "only the edited key is sent").toEqual(["company"]);
    const after = dbGet("SELECT company, title, city FROM users WHERE id=?", id);
    expect(after.company, "the edit landed").toBe("Reassigned Ltd");
    expect(after.title, "and the fields the dialog only READ are untouched").toBe(before.title);
    expect(after.city).toBe(before.city);
  });
});
