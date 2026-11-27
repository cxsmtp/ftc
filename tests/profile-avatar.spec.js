// @ts-check
//
// v7.21.25 — the profile editor can change your avatar.
//
// Found while investigating the unattributed 413 (v7.21.24): the participant
// guide said the avatar was editable in the profile, and it was not — the editor
// had no avatar control at all. So the avatar was set once, at registration, and
// could never be changed. That is also what made the silent-substitution bug
// there permanent rather than merely annoying.
//
// The server side already accepted everything needed — `PUT /api/me` takes a
// preset name, an existing `/api/images/<id>` ref or a `data:image/` upload,
// validates it, persists it and reclaims the previous blob. The gap was entirely
// in the client, which is why most of these are browser tests.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { fillBreakGlass, submitLogin, narrowPeopleTable } = require("./ui-admin-helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, BASE, makePng, pngDataUri, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** A participant of our own — never a shared seeded one (fixture checklist #3). */
async function ownParticipant(tag) {
  const s = `${Date.now()}${Math.floor(Math.random() * 1e5)}${tag}`;
  const email = `av${s}@company.com`;
  const { api, csrf } = await freshCtx();
  const r = await registerPost(api, "/api/register", {
    headers: h(csrf),
    data: {
      firstName: "Ava", lastName: "Tarr", nickname: `av${s}`.slice(0, 20), email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
      avatar: "🦊",
    },
  });
  expect(r.status(), `register: ${await r.text()}`).toBe(200);
  await api.dispose();

  const { api: sa, csrf: sc } = await apiLogin("superadmin");
  const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
    .participants.find(p => p.email === email);
  expect(u, "the account exists").toBeTruthy();
  // registerPost's default rewinds the account to its fixture state, unverified AND
  // queued for approval (a real sign-up is neither) — both gates must be cleared
  // or the sign-in below is a 403 that says nothing about avatars.
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": sc } });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": sc } });
  await sa.dispose();
  return { email, id: u.id };
}

function storedAvatar(email) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT avatar FROM users WHERE email=?").get(email)?.avatar; }
  finally { db.close(); }
}
function imageExists(ref) {
  const id = String(ref || "").replace("/api/images/", "");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT COUNT(*) c FROM images WHERE id=?").get(id).c > 0; }
  finally { db.close(); }
}

/**
 * Sign in via the API (page.request shares the context cookie jar), then open the
 * editor. Deterministic where driving the login FORM is not: these participants
 * have no competition, so boot routes them to the picker and a UI login has to
 * be raced against that.
 */
async function signIn(page, email, password = PARTICIPANT_PASS) {
  // NO page.goto before the login. page.request is independent of navigation and
  // shares the context cookie jar, so booting the SPA first buys nothing and
  // costs correctness: the anonymous app starts polling, those polls 401 the
  // moment the login regenerates the session, and its fetch interceptor reads
  // that as an expired session and POSTs /api/logout — destroying the session
  // this helper just established. Same v7.19.0 mechanism as signing in twice,
  // reached one step earlier. Establish the session first, then navigate.
  const post = async pw => {
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { base: `${BASE}`, password: pw });
  };
  let r = await post(password);
  if (!r.ok() && email === "superadmin") {
    // The built-in password rotates GLOBALLY after 10 consecutive failed logins,
    // and another spec in this worker can trip that between the read and the POST.
    // Every helper in this suite retries with a re-read password; so must this.
    await new Promise(res => setTimeout(res, 300));
    r = await post(getSuperadminPass());
  }
  expect(r.ok(), `login ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  await page.goto(BASE);
  // Probe through page.request, NOT page.evaluate(fetch). Two reasons, and the
  // second one bit under full-suite load:
  //   • the BUILT-IN superadmin has no `users` row, so GET /api/me 401s for it
  //     BY DESIGN — the endpoint to poll depends on the principal;
  //   • window.fetch in the page is the SPA's INTERCEPTED fetch, so probing
  //     /api/me for a superadmin fed a 401 straight into the session-expiry
  //     interceptor, which POSTed /api/logout and destroyed the session this
  //     helper had just established. page.request shares the cookie jar but runs
  //     no page JS, so it observes without perturbing.
  const probe = email === "superadmin" ? "/api/admin/me" : "/api/me";
  await expect.poll(async () => (await page.request.get(`${BASE}${probe}`)).status(),
    { timeout: 20000 }).toBe(200);
}
async function openEditor(page, email) {
  await signIn(page, email);
  await page.waitForFunction(() => typeof window.openProfileEditor === "function", null, { timeout: 15000 });
  await page.evaluate(() => window.openProfileEditor());
  await page.waitForSelector("#prof-avatar-grid .avatar-option", { timeout: 15000 });
}

/**
 * Click a preset. The grid is 25 options inside a scrollable dialog, so an option
 * low in the grid can sit below the fold — scroll it in first rather than letting
 * a click time out on "not stable" while the overlay settles.
 */
async function pickAvatar(page, value) {
  const opt = page.locator(`#prof-avatar-grid .avatar-option[data-avatar='${value}']`);
  await opt.scrollIntoViewIfNeeded();
  await expect(opt).toBeVisible();
  await opt.click();
  await expect(opt).toHaveAttribute("aria-checked", "true");
}

/** Save and clear the "Save changes?" confirmation. */
async function saveAndConfirm(page) {
  const resp = page.waitForResponse(r => r.url().endsWith("/api/me") && r.request().method() === "PUT", { timeout: 20000 });
  await page.click("#profile-overlay [data-action='save-profile']");
  await page.click("#modal-overlay [data-action='modal-confirm'], #modal-overlay .btn:not(.secondary)");
  return resp;
}

test.describe("v7.21.25 — the profile editor's avatar control", () => {
  test("the control exists and shows the CURRENT avatar — the reported gap", async ({ page }) => {
    const p = await ownParticipant("a");
    await openEditor(page, p.email);

    // THE GAP. Before this there was no avatar control in this dialog at all.
    await expect(page.locator("#prof-avatar-grid")).toBeVisible();
    await expect(page.locator("#prof-avatar-upload")).toBeAttached();
    // It must show what you HAVE, or "change your avatar" starts by guessing.
    await expect(page.locator("#prof-avatar-preview")).toContainText("🦊");
    // …and the matching preset must be the one ticked.
    await expect(page.locator("#prof-avatar-grid .avatar-option[data-avatar='🦊']"))
      .toHaveAttribute("aria-checked", "true");
    // It is a real radiogroup, not a row of clickable divs.
    await expect(page.locator("#prof-avatar-grid")).toHaveAttribute("role", "radiogroup");
  });

  test("picking a preset saves it, and the header updates without a reload", async ({ page }) => {
    const p = await ownParticipant("b");
    await openEditor(page, p.email);

    await pickAvatar(page, "🐼");
    await expect(page.locator("#prof-avatar-preview"), "the preview follows the pick").toContainText("🐼");

    const r = await saveAndConfirm(page);
    expect(r.status(), `save: ${await r.text()}`).toBe(200);
    expect(JSON.parse(r.request().postData() || "{}").avatar, "the new value is actually sent").toBe("🐼");
    await expect.poll(() => storedAvatar(p.email), { timeout: 5000 }).toBe("🐼");

    // saveProfile refreshes the nav from /api/me — the change must be visible
    // where the user looks, not only in the database.
    await expect(page.locator("#user-info")).toContainText("🐼", { timeout: 10000 });
  });

  test("an ordinary phone photo can be uploaded, and is downscaled on the way", async ({ page }) => {
    const p = await ownParticipant("c");
    await openEditor(page, p.email);

    // 800x800 of noise is ~1.9 MB — over the register cap on its own, so it
    // arrives only because the browser downscales first (v7.21.24).
    const big = makePng(800);
    expect(big.length).toBeGreaterThan(1024 * 1024);
    await page.setInputFiles("#prof-avatar-upload", { name: "me.png", mimeType: "image/png", buffer: big });
    await expect(page.locator("#prof-avatar-preview img"), "the picked photo previews before saving")
      .toBeVisible({ timeout: 10000 });
    // A photo wins over the preset that was ticked — leaving one highlighted
    // would say the opposite of what is about to be saved.
    await expect(page.locator("#prof-avatar-grid .avatar-option[aria-checked='true']")).toHaveCount(0);

    const r = await saveAndConfirm(page);
    expect(r.status(), `save: ${await r.text()}`).toBe(200);
    const sent = JSON.parse(r.request().postData() || "{}");
    expect(sent.avatar).toMatch(/^data:image\//);
    expect(sent.avatar.length, "downscaled, not shipped raw").toBeLessThan(big.length / 4);

    await expect.poll(() => storedAvatar(p.email), { timeout: 5000 }).toMatch(/^\/api\/images\//);
  });

  test("there is a way BACK to no picture — the one-way door", async ({ page }) => {
    // Without `default1` in the grid, uploading a photo would be irreversible:
    // the presets are all emoji, so nothing would return you to the plain 👤.
    const p = await ownParticipant("d");
    const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const set = await api.put("/api/me", { headers: h(csrf), data: { avatar: pngDataUri(120) } });
      expect(set.status(), await set.text()).toBe(200);
      await expect.poll(() => storedAvatar(p.email)).toMatch(/^\/api\/images\//);
    } finally { await api.dispose(); }

    await openEditor(page, p.email);
    await expect(page.locator("#prof-avatar-preview img"), "starts on the uploaded photo").toBeVisible();
    await pickAvatar(page, "default1");
    const r = await saveAndConfirm(page);
    expect(r.status(), await r.text()).toBe(200);
    await expect.poll(() => storedAvatar(p.email), { timeout: 5000 }).toBe("default1");
  });

  test("an avatar-only change is treated as a CHANGE — Save saves, Cancel warns", async ({ page }) => {
    // The subtle one. The dirty snapshot drives BOTH the v6.9.2 "nothing changed,
    // close silently" short-circuit on Save and the discard prompt on Cancel. An
    // avatar missing from that snapshot would make an avatar-only edit vanish
    // through a dialog that behaved as though nothing had been touched.
    const p = await ownParticipant("e");

    // Cancel side: the discard prompt must appear.
    await openEditor(page, p.email);
    await pickAvatar(page, "🦉");
    await page.click("#profile-overlay [data-action='overlay-close']");
    await expect(page.locator("#modal-overlay"), "an avatar-only edit is unsaved work")
      .toContainText(/Discard changes/i, { timeout: 10000 });
    await page.click("#modal-overlay .btn.secondary");

    // Save side: the API must actually be called.
    const r = await saveAndConfirm(page);
    expect(r.status(), await r.text()).toBe(200);
    await expect.poll(() => storedAvatar(p.email), { timeout: 5000 }).toBe("🦉");
  });

  test("an untouched form is still a no-op — the positive control", async ({ page }) => {
    // Without this, "the avatar counts as a change" is equally satisfied by a
    // snapshot that reports EVERY form as dirty, which would resurrect the
    // spurious save/discard prompts v6.9.2 removed.
    const p = await ownParticipant("f");
    await openEditor(page, p.email);
    let putSeen = false;
    page.on("request", q => { if (q.url().endsWith("/api/me") && q.method() === "PUT") putSeen = true; });
    await page.click("#profile-overlay [data-action='save-profile']");
    await expect(page.locator("#profile-overlay")).toHaveCount(0, { timeout: 10000 });
    expect(putSeen, "an unchanged form must not call the API or raise a confirmation").toBe(false);
  });

  test("the control is reachable by keyboard and clean under axe", async ({ page }) => {
    const p = await ownParticipant("g");
    await openEditor(page, p.email);

    // Roving tabindex: exactly one option is focusable, arrows move the selection.
    await expect(page.locator("#prof-avatar-grid .avatar-option[tabindex='0']")).toHaveCount(1);
    await page.focus("#prof-avatar-grid .avatar-option[tabindex='0']");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#prof-avatar-grid .avatar-option[aria-checked='true']")).toHaveCount(1);
    const picked = await page.locator("#prof-avatar-grid .avatar-option[aria-checked='true']").getAttribute("data-avatar");
    expect(picked, "arrow keys move the choice, not just the focus ring").not.toBe("🦊");

    const AxeBuilder = require("@axe-core/playwright").default;
    const res = await new AxeBuilder({ page }).include("#profile-overlay").analyze();
    const bad = res.violations.filter(v => ["serious", "critical", "moderate"].includes(v.impact));
    expect(bad.map(v => `${v.id}: ${v.nodes.length}`), JSON.stringify(bad.map(v => v.id))).toEqual([]);
  });


});

test.describe("v7.21.25 — what changing an avatar does to storage", () => {
  test("replacing an uploaded avatar RECLAIMS the previous image row", async () => {
    // Before this feature an avatar was written once and never replaced, so the
    // reclaim path was effectively dead code. Making avatars editable makes it
    // routine — and an un-reclaimed 150 KB blob per change adds up.
    const p = await ownParticipant("h");
    const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const first = await api.put("/api/me", { headers: h(csrf), data: { avatar: pngDataUri(120, "first") } });
      expect(first.status(), await first.text()).toBe(200);
      const refA = storedAvatar(p.email);
      expect(refA).toMatch(/^\/api\/images\//);
      expect(imageExists(refA), "the first image is stored").toBe(true);

      const second = await api.put("/api/me", { headers: h(csrf), data: { avatar: pngDataUri(120, "second") } });
      expect(second.status(), await second.text()).toBe(200);
      const refB = storedAvatar(p.email);
      expect(refB, "a genuinely different image").not.toBe(refA);
      expect(imageExists(refB), "the new one is stored").toBe(true);
      expect(imageExists(refA), "and the old one is reclaimed, not orphaned").toBe(false);
    } finally { await api.dispose(); }
  });

  test("a rejected upload leaves the existing avatar alone", async () => {
    const p = await ownParticipant("i");
    const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const before = storedAvatar(p.email);
      const svg = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
      const r = await api.put("/api/me", { headers: h(csrf), data: { avatar: svg } });
      expect(r.status(), "an unsupported format is refused").toBe(400);
      expect((await r.json()).error).toMatch(/Avatar image rejected/i);
      expect(storedAvatar(p.email), "…and nothing was changed").toBe(before);
    } finally { await api.dispose(); }
  });
});

// (The sign-up form has no avatar grid since the short form, 29 Oct 2026: a picture
// is chosen in the profile editor, whose grid the tests above cover.)

// ── v7.21.26 — the ADMIN editor gets the same control, under admin policy ────

/** Mint a regular (non-super) admin who can sign in. */
async function regularAdmin(tag) {
  const s = `${Date.now()}${Math.floor(Math.random() * 1e5)}${tag}`;
  const email = `radm${s}@company.com`;
  const { api: anon, csrf: ac } = await freshCtx();
  await registerPost(anon, "/api/register", { headers: h(ac), data: {
    firstName: "Reg", lastName: "Admin", nickname: `radm${s}`.slice(0, 20), email,
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS } });
  await anon.dispose();
  const { api: sa, csrf: sc } = await apiLogin("superadmin");
  try {
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.email === email);
    expect(u, "the admin-to-be exists").toBeTruthy();
    const hd = { "x-csrf-token": sc };
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: hd });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: hd });
    await sa.post(`/api/admin/participants/${u.id}/role`, { headers: h(sc), data: { role: "admin" } });
    return { email, id: u.id };
  } finally { await sa.dispose(); }
}

/** Open the admin edit-profile dialog for `targetEmail`. */
async function openAdminEditor(page, adminEmail, adminPass, targetEmail) {
  await signIn(page, adminEmail, adminPass);
  await page.waitForSelector("#admin-page", { state: "visible", timeout: 25000 });
  await page.click("#participants-tab-btn");
  await page.locator("#admin-participants-body tr").first().waitFor({ state: "visible", timeout: 20000 });
  // FILTER FIRST — the participants table paginates at 30 rows and this file
  // registers a participant per test (v7.15.29).
  await narrowPeopleTable(page, targetEmail);
  await expect.poll(async () => page.evaluate(em =>
    (window.S.adminParticipantsData || []).some(p => p.email === em), targetEmail),
    { timeout: 15000 }).toBe(true);
  const id = await page.evaluate(em =>
    (window.S.adminParticipantsData || []).find(p => p.email === em).id, targetEmail);
  await page.evaluate(i => window.adminEditProfile(i), id);
  await page.waitForSelector("#adp-avatar-grid .avatar-option", { timeout: 15000 });
  return id;
}

test.describe("v7.21.26 — the admin editor's avatar control", () => {
  test("a superadmin can change a participant's avatar from the admin dialog", async ({ page }) => {
    // Problem 1 as reported: there was no way to set an avatar from the admin
    // editor at all. The route did not even accept the field.
    const p = await ownParticipant("k");
    await openAdminEditor(page, "superadmin", getSuperadminPass(), p.email);

    await expect(page.locator("#adp-avatar-preview"), "the target's current avatar is shown").toContainText("🦊");
    const opt = page.locator("#adp-avatar-grid .avatar-option[data-avatar='🐧']");
    await opt.scrollIntoViewIfNeeded();
    await opt.click();
    await expect(opt).toHaveAttribute("aria-checked", "true");

    const resp = page.waitForResponse(r => /\/api\/admin\/participants\//.test(r.url()) && r.request().method() === "PUT", { timeout: 20000 });
    await page.click("#admin-profile-overlay [data-action='admin-profile-save']");
    await page.click("#modal-overlay .btn:not(.secondary)");
    const r = await resp;
    expect(r.status(), `admin save: ${await r.text()}`).toBe(200);
    expect(JSON.parse(r.request().postData() || "{}").avatar, "the avatar is on the wire").toBe("🐧");
    await expect.poll(() => storedAvatar(p.email), { timeout: 5000 }).toBe("🐧");
  });

  test("a superadmin can UPLOAD a photo for a participant, and it is downscaled", async ({ page }) => {
    const p = await ownParticipant("l");
    await openAdminEditor(page, "superadmin", getSuperadminPass(), p.email);
    const big = makePng(800);
    await page.setInputFiles("#adp-avatar-upload", { name: "them.png", mimeType: "image/png", buffer: big });
    await expect(page.locator("#adp-avatar-preview img")).toBeVisible({ timeout: 10000 });

    const resp = page.waitForResponse(r => /\/api\/admin\/participants\//.test(r.url()) && r.request().method() === "PUT", { timeout: 20000 });
    await page.click("#admin-profile-overlay [data-action='admin-profile-save']");
    await page.click("#modal-overlay .btn:not(.secondary)");
    const r = await resp;
    expect(r.status(), await r.text()).toBe(200);
    const sent = JSON.parse(r.request().postData() || "{}");
    expect(sent.avatar.length, "downscaled, not shipped raw").toBeLessThan(big.length / 4);
    await expect.poll(() => storedAvatar(p.email), { timeout: 5000 }).toMatch(/^\/api\/images\//);
  });

  test("a REGULAR admin may fill a blank avatar but not replace a chosen one", async ({ page }) => {
    // The established doctrine for every other field on this route, applied to
    // the avatar: `default1` is its unset state. Both halves are asserted,
    // because "disabled" alone would be equally satisfied by a control that never
    // works for a regular admin.
    const admin = await regularAdmin("m");
    const blank = await ownParticipant("n");
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // Put the blank target back to the unset avatar (ownParticipant registers with 🦊).
      const u = (await (await api.get("/api/admin/participants?limit=5000")).json())
        .participants.find(x => x.email === blank.email);
      const r0 = await api.put(`/api/admin/participants/${u.id}`, { headers: h(csrf), data: { avatar: "default1" } });
      expect(r0.ok(), await r0.text()).toBeTruthy();
    } finally { await api.dispose(); }
    await expect.poll(() => storedAvatar(blank.email)).toBe("default1");

    // (a) blank target — the control is LIVE and the save applies.
    await openAdminEditor(page, admin.email, PARTICIPANT_PASS, blank.email);
    await expect(page.locator("#adp-avatar-grid"), "a blank avatar is fillable").not.toHaveAttribute("aria-disabled", "true");
    const opt = page.locator("#adp-avatar-grid .avatar-option[data-avatar='🦉']");
    await opt.scrollIntoViewIfNeeded();
    await opt.click();
    const resp = page.waitForResponse(r => /\/api\/admin\/participants\//.test(r.url()) && r.request().method() === "PUT", { timeout: 20000 });
    await page.click("#admin-profile-overlay [data-action='admin-profile-save']");
    await page.click("#modal-overlay .btn:not(.secondary)");
    expect((await resp).status(), "a regular admin may FILL it").toBe(200);
    await expect.poll(() => storedAvatar(blank.email), { timeout: 5000 }).toBe("🦉");

    // (b) chosen target — the control is disabled AND says why.
    const chosen = await ownParticipant("o");
    await openAdminEditor(page, admin.email, PARTICIPANT_PASS, chosen.email);
    await expect(page.locator("#adp-avatar-upload"), "a chosen avatar is not replaceable").toBeDisabled();
    await expect(page.locator("#adp-avatar-grid")).toHaveAttribute("aria-disabled", "true");
    // v7.14.2 — gate the affordance and the EXPLANATION together.
    await expect(page.locator("#admin-profile-overlay .profile-avatar-note"))
      .toContainText(/Only a superadmin can replace it/i);
  });

  test("the SERVER enforces it too — a regular admin's avatar for a chosen target is kept", async () => {
    // The dialog disables the control; the route must not depend on that.
    const admin = await regularAdmin("p");
    const target = await ownParticipant("q");
    const { api, csrf } = await apiLogin(admin.email, PARTICIPANT_PASS);
    try {
      const before = storedAvatar(target.email);
      expect(before, "the target has a chosen avatar").toBe("🦊");
      const r = await api.put(`/api/admin/participants/${target.id}`, { headers: h(csrf), data: { avatar: "🐝" } });
      expect(r.status(), `the save itself succeeds: ${await r.text()}`).toBe(200);
      expect(storedAvatar(target.email), "…but the avatar is KEPT, as fillRequired keeps a populated field").toBe(before);
    } finally { await api.dispose(); }
  });

  test("a REJECTED upload from the admin route is refused and changes nothing", async () => {
    const target = await ownParticipant("r");
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const before = storedAvatar(target.email);
      const svg = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
      const r = await api.put(`/api/admin/participants/${target.id}`, { headers: h(csrf), data: { avatar: svg } });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/Avatar image rejected/i);
      expect(storedAvatar(target.email)).toBe(before);
    } finally { await api.dispose(); }
  });

  test("replacing an uploaded avatar through the ADMIN route reclaims the old image", async () => {
    const target = await ownParticipant("s");
    const { api, csrf } = await apiLogin("superadmin");
    try {
      expect((await api.put(`/api/admin/participants/${target.id}`, { headers: h(csrf), data: { avatar: pngDataUri(120, "adm-a") } })).ok()).toBeTruthy();
      const refA = storedAvatar(target.email);
      expect(refA).toMatch(/^\/api\/images\//);
      expect((await api.put(`/api/admin/participants/${target.id}`, { headers: h(csrf), data: { avatar: pngDataUri(120, "adm-b") } })).ok()).toBeTruthy();
      const refB = storedAvatar(target.email);
      expect(refB).not.toBe(refA);
      expect(imageExists(refA), "the replaced image is reclaimed, not orphaned").toBe(false);
      expect(imageExists(refB)).toBe(true);
    } finally { await api.dispose(); }
  });

  test("v8.1.0: a CERTIFICATE-NAME-only edit is a change, and it round-trips", async ({ page }) => {
    // THE WITNESS THE DIRTY SNAPSHOT NEEDS. `profileFieldIds()` feeds the
    // snapshot both dialogs diff against; a field missing from it makes an edit
    // to that field read as a CLEAN form, so the v6.9.2 short-circuit closes Save
    // silently and Cancel skips the discard prompt — the change vanishes through
    // a dialog behaving as if nothing was touched. Exactly the v7.21.25 avatar
    // defect, and the parity test above CANNOT see it: that asserts which fields
    // RENDER, not which are watched for changes.
    const p = await ownParticipant("cert");
    await openAdminEditor(page, "superadmin", getSuperadminPass(), p.email);
    await page.locator("#adp-cert-given").fill("Мария");
    await page.locator("#adp-cert-family").fill("Иванова");
    await page.click("#admin-profile-overlay [data-action='overlay-close']");
    await expect(page.locator("#modal-overlay"), "an unsaved certificate name must prompt")
      .toContainText(/Discard changes/i, { timeout: 10000 });
  });

  test("an avatar-only edit is a CHANGE in the admin dialog too", async ({ page }) => {
    const p = await ownParticipant("t");
    await openAdminEditor(page, "superadmin", getSuperadminPass(), p.email);
    const opt = page.locator("#adp-avatar-grid .avatar-option[data-avatar='🐸']");
    await opt.scrollIntoViewIfNeeded();
    await opt.click();
    await page.click("#admin-profile-overlay [data-action='overlay-close']");
    await expect(page.locator("#modal-overlay"), "unsaved work must prompt")
      .toContainText(/Discard changes/i, { timeout: 10000 });
  });
});

test.describe("v7.21.26 — the two editors are the same form", () => {
  test("both dialogs render the SAME field set, and the avatar group is LAST in both", async ({ browser }) => {
    // The "as close a match as possible" requirement, asserted mechanically: the
    // element-id SUFFIXES must match exactly, so a field added to one and not the
    // other fails here and names itself.
    //
    // TWO BROWSER CONTEXTS, deliberately. Signing in twice in one context is the
    // documented trap (v7.19.0): the first SPA keeps polling with its
    // pre-regeneration CSRF token, its fetch interceptor reads the mismatch as a
    // dead session and POSTs /api/logout — destroying the session the second
    // sign-in just created. It surfaces as a 401 on the readiness probe under
    // load, which is exactly how it surfaced here.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const p = await ownParticipant("u");

      const pageA = await ctxA.newPage();
      await openEditor(pageA, p.email);
      const self = await pageA.evaluate(() => ({
        ids: [...document.querySelectorAll("#profile-overlay [id^='prof-']")].map(e => e.id.replace(/^prof-/, "")).sort(),
        groups: [...document.querySelectorAll("#profile-overlay .profile-group .profile-group-label")].map(e => e.textContent.trim()),
      }));

      const pageB = await ctxB.newPage();
      await openAdminEditor(pageB, "superadmin", getSuperadminPass(), p.email);
      const admin = await pageB.evaluate(() => ({
        ids: [...document.querySelectorAll("#admin-profile-overlay [id^='adp-']")].map(e => e.id.replace(/^adp-/, "")).sort(),
        groups: [...document.querySelectorAll("#admin-profile-overlay .profile-group .profile-group-label")].map(e => e.textContent.trim()),
      }));

      expect(admin.ids, "the two editors must offer the same fields").toEqual(self.ids);
      expect(admin.groups, "…in the same groups, in the same order").toEqual(self.groups);
      expect(self.groups[self.groups.length - 1], "the avatar group renders LAST").toBe("Avatar");
      expect(admin.groups[admin.groups.length - 1], "…in both").toBe("Avatar");
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });

  test("v7.23.7: the SELF editor carries autocomplete tokens; the ADMIN editor carries 'off'", async ({ browser }) => {
    // WCAG 1.3.5 Identify Input Purpose (AA) covers fields collecting information
    // about THE USER. The self editor does; the admin dialog collects a THIRD
    // PARTY's data, where autofill is not merely unnecessary but harmful —
    // identity autofill cascades, `fillRequired` persists a non-blank value onto
    // the participant, and an autofill landing before snapshotAdminProfile()
    // BECOMES the dirty-check baseline, so Cancel then closes with no "Discard
    // changes?" at all.
    //
    // BOTH halves are asserted. Checking only the self editor would pass a build
    // that tokenised both, which is the outcome this split exists to prevent.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const p = await ownParticipant("ac");
      const READ = (root, pfx) => [...document.querySelectorAll(root + " [id^='" + pfx + "']")]
        .filter(e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && e.type !== "file")
        .map(e => ({ f: e.id.slice(pfx.length), ac: e.getAttribute("autocomplete") }));

      const pageA = await ctxA.newPage();
      await openEditor(pageA, p.email);
      const self = await pageA.evaluate(READ_SRC => {
        const fn = eval("(" + READ_SRC + ")");
        return fn("#profile-overlay", "prof-");
      }, READ.toString());

      const pageB = await ctxB.newPage();
      await openAdminEditor(pageB, "superadmin", getSuperadminPass(), p.email);
      const admin = await pageB.evaluate(READ_SRC => {
        const fn = eval("(" + READ_SRC + ")");
        return fn("#admin-profile-overlay", "adp-");
      }, READ.toString());

      expect(self.length, "the self editor must render fields, or this is vacuous").toBeGreaterThan(8);
      expect(admin.length, "the admin editor must render fields, or this is vacuous").toBeGreaterThan(8);

      // EVERY control declares one — `off` is a decision here, never an omission.
      expect(self.filter(x => !x.ac).map(x => x.f),
        "every self-editor control must declare an autocomplete").toEqual([]);
      expect(admin.filter(x => !x.ac).map(x => x.f),
        "every admin-editor control must declare an autocomplete").toEqual([]);

      // The identity fields a browser would autofill must carry a REAL token on
      // the self editor. These are the REGISTRATION form's own tokens rather
      // than a second vocabulary invented here — note `username` for nickname.
      const want = { first: "given-name", last: "family-name", nick: "username",
                     email: "email", company: "organization", title: "organization-title",
                     city: "address-level2", phone: "tel" };
      for (const [f, tok] of Object.entries(want)) {
        const got = self.find(x => x.f === f);
        expect(got, `the self editor must render #prof-${f}`).toBeTruthy();
        expect(got.ac, `#prof-${f} autocomplete`).toBe(tok);
      }
      // The secondary email is section-scoped, or one autofill fills BOTH email
      // fields with the same address — which the server refuses, because primary
      // and secondary must resolve to different mailboxes.
      expect(self.find(x => x.f === "email2").ac, "#prof-email2 must be section-scoped")
        .toBe("section-secondary email");

      // ...and the admin dialog must invite NO autofill at all.
      expect(admin.filter(x => x.ac !== "off").map(x => `${x.f}=${x.ac}`),
        "the admin dialog must not invite autofill of the ADMIN's own identity "
        + "into someone else's record").toEqual([]);
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// v7.23.7 — a failing field is announced, not just coloured.
//
// `.field-error` paints a red border and a red label. That is COLOUR ALONE
// (WCAG 1.4.1) and, worse, the error summary names the fields in prose while
// nothing on the controls themselves says which ones failed (3.3.1). The shared
// markFieldError() now moves aria-invalid with the class.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.23.7 — invalid fields are announced", () => {
  test("clearing a required field and saving marks it aria-invalid, and fixing it clears", async ({ page }) => {
    const p = await ownParticipant("inv");
    await openEditor(page, p.email);

    // Empty a required field and save. The dialog validates client-side and
    // marks the offenders; nothing should reach the server.
    await page.locator("#prof-company").fill("");
    await page.locator("#profile-overlay .btn:not(.secondary)").first().click();

    await expect.poll(async () => page.locator("#prof-company").getAttribute("aria-invalid"), {
      message: "an emptied required field must be announced as invalid",
      timeout: 5000,
    }).toBe("true");
    // Non-vacuity: a field that did NOT fail must stay unmarked, or the
    // assertion above would be satisfied by marking everything.
    expect(await page.locator("#prof-first").getAttribute("aria-invalid"),
      "a field that passed must not be marked invalid").toBeNull();
    // ...and the visual state must agree — the whole point of one helper.
    await expect(page.locator("#prof-company").locator("xpath=ancestor::div[contains(@class,'form-group')][1]"))
      .toHaveClass(/field-error/);

    // Typing clears both again (the input/change listeners route through the
    // same helper), so the announcement cannot outlive the error.
    await page.locator("#prof-company").fill("Acme Again");
    await expect.poll(async () => page.locator("#prof-company").getAttribute("aria-invalid"), {
      message: "fixing the field must clear the announcement, not just the colour",
      timeout: 5000,
    }).toBeNull();
  });
});
