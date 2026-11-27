// v8.3.1 — the pre-auth surface: what the login card asks, and what it delegates.
//
// Four changes, and three of them are one idea: the login card had grown two
// inline mechanisms (the event code, the emailed sign-in code) that most people
// arriving at it do not want, and neither had room to explain itself. Both are
// links to dedicated dialogs now. The fourth is the Booth Event's registration
// deal: Professional Role moved from DROPPED to OPTIONAL, which is a different
// promise — the walk-up is offered it and never required to give it.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `sd${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// A joinable event of any kind. Booth/Competition run on a window; a Program
// runs to a deadline, so its schedule is supplied differently — the point of
// covering all three is that the registration deal differs by kind.
// v8.4.1 — `extra` was added so a test can state this event's LinkedIn sign-up
// door, the way the same helper in the three sibling specs already could. It is
// needed because a Booth Event is now created with that door CLOSED.
async function joinableEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(),
      ...(kind === "program"
        ? { deadline_at: new Date(Date.now() + 30 * 864e5).toISOString() }
        : { duration_minutes: 600 }),
      self_enroll_enabled: true,
      ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const rv = await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
  return { comp, token: rv.token, display: rv.join_code_display };
}

const storedRow = (email) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const row = db.prepare("SELECT id,email,job_function,city,personal_title,phone,profile_policy,registered_via,linkedin_url,linkedin_sub FROM users WHERE LOWER(email)=LOWER(?)").get(email);
  db.close();
  return row;
};

// The short form (29 Oct 2026): every kind asks for the base set; City and Job
// function are shown but optional, Salutation, Phone and LinkedIn are off, and
// every event's creator may change that.
test.describe("the sign-up form asks for the short set, and the gate never asks again", () => {
  test("the wire says what this event asks for, and every kind is configurable", async () => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const bp = await (await api.get(`/api/competitions/self-enroll/${booth.token}`)).json();
    expect(bp.policy.registration_fields.city, "City is optional").toBe("optional");
    expect(bp.policy.registration_fields.job_function, "Job function is optional").toBe("optional");
    expect(bp.policy.registration_fields.password, "no sign-up asks for a password: it is not a field at all").toBeUndefined();
    expect(bp.policy.registration_fields_configurable, "a Booth Event may be configured").toBe(true);
    for (const kind of ["tournament", "program"]) {
      const ev = await joinableEvent(api, csrf, kind);
      const p = await (await api.get(`/api/competitions/self-enroll/${ev.token}`)).json();
      expect(p.policy.registration_fields, `${kind} uses the short form`).toEqual(bp.policy.registration_fields);
      expect(p.policy.registration_fields_configurable, `${kind} is configurable`).toBe(true);
    }
    await api.dispose();
  });

  test("the completion gate never demands an optional field it was told to skip", async () => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const label = uniq();
    const email = `${label}@company.example`;
    const { api: anon, csrf: ac } = await freshCtx();
    expect((await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: {
        firstName: "Gate", lastName: "Check", email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        joinToken: booth.token, jobFunction: "", city: "",
      },
    })).status()).toBe(200);
    await anon.dispose();
    const { api: p, csrf: pc0 } = await freshCtx();
    expect((await codeLogin(p, email, H(pc0))).ok()).toBeTruthy();
    const me = await (await p.get("/api/me")).json();
    for (const f of ["city", "job_function", "personal_title", "phone", "linkedin_url"]) {
      expect(me.missing_fields || [], `${f} is not demanded`).not.toContain(f);
    }
    expect(me.profile_complete, "so the account is complete as it stands").toBe(true);
    await p.dispose();
    await api.dispose();
  });
});

test.describe("the event code has its own dialog, and one way on", () => {
  test("the login card carries a LINK, not the entry", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    expect(await page.locator("#login-join-code-box").count(), "the inline box is gone").toBe(0);
    expect(await page.locator("#login-code-box").count(), "and so is the inline sign-in-code box").toBe(0);
    await expect(page.locator("#login-event-code-link"), "a link is offered instead").toBeVisible();
    expect(await page.locator("#event-code-overlay").count()).toBe(0);
  });

  test("a valid code names the event and continues to the ONE email step, the event held", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.locator("#event-code-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.fill("#ec-code", booth.display);
    await page.click('[data-action="event-code-apply"]');
    await page.locator('[data-action="event-code-signin"]').waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#event-code-overlay")).toContainText(booth.comp.name);
    expect(await page.locator("#event-code-overlay .event-code-actions .btn").count(), "one door, not sign-up AND sign-in").toBe(1);
    await page.click('[data-action="event-code-signin"]');
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "the code survives to the email step").toBe(booth.token);
    await expect(page.locator("#join-banner"), "and the card names the event").toContainText(booth.comp.name);
    await expect(page.locator("#login-event-code-row"), "with the event held, the code link steps aside").toBeHidden();
    await api.dispose();
  });

  test("DISCARD clears the code and purges the stored copy", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.fill("#ec-code", booth.display);
    await page.click('[data-action="event-code-apply"]');
    await page.locator('#event-code-overlay [data-action="event-code-discard"]').waitFor({ state: "visible", timeout: 15000 });
    expect(await page.evaluate(() => localStorage.getItem("hck-pending-join")), "stored first").toBeTruthy();
    await page.click('#event-code-overlay [data-action="event-code-discard"]');
    await expect(page.locator("#event-code-overlay")).toHaveCount(0);
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "memory cleared").toBeFalsy();
    expect(await page.evaluate(() => localStorage.getItem("hck-pending-join")), "storage purged").toBeNull();
    await expect(page.locator("#join-banner"), "no event on the card").toBeHidden();
    await page.reload();
    await page.waitForSelector(".page.active", { timeout: 20000 });
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "still gone after a reload").toBeFalsy();
    await api.dispose();
  });

  // "NOT YOUR EVENT? CONTINUE WITHOUT IT" (operator rulings, 18 and 20 Nov 2026):
  // on the card while an event is held, and on the sign-up form. A code already
  // emailed with the event is untied first (POST /api/auth/code/drop-event), so it
  // still signs in without joining; Continue then asks afresh, never reopening the
  // code step as "already on its way" for the event just dropped.
  test("Not your event? on the card unties a code already mailed; Continue reopens it, and it signs in without joining", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const { makeParticipant } = require("./event-admin-helpers");
    const p = await makeParticipant(api, csrf, "notyours");
    await api.dispose();
    const bound = () => {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return db.prepare("SELECT login_code_comp_id AS c FROM users WHERE id=?").get(p.id).c; } finally { db.close(); }
    };
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.fill("#ec-code", booth.display);
    await page.click('[data-action="event-code-apply"]');
    await page.click('[data-action="event-code-signin"]');
    const out = page.locator("#join-banner-out");
    await expect(out, "the card offers the way out").toBeVisible({ timeout: 15000 });
    await expect(out).toHaveText("Not your event? Continue without it");
    await page.fill("#login-email", p.email);
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
    expect(bound(), "PRECONDITION: the code went out with the event").toBe(booth.comp.id);
    await page.keyboard.press("Escape");
    await expect(page.locator("#signin-code-overlay")).toHaveCount(0);
    const drop = page.waitForRequest(r => r.url().endsWith("/api/auth/code/drop-event") && r.method() === "POST");
    await out.click();
    expect(JSON.parse((await drop).postData() || "{}"), "the code's address is sent").toEqual({ email: p.email.toLowerCase() });
    await expect(page.locator("#join-banner"), "the card holds no event").toBeHidden();
    await expect(page.locator("#login-event-code-row"), "the event-code link is back").toBeVisible();
    await expect(page.locator("#toast-stack .toast").last()).toContainText("still signs you in, without joining it");
    await expect.poll(bound, { message: "the code no longer joins the event" }).toBeNull();
    const marker = JSON.parse(await page.evaluate(() => sessionStorage.getItem("ha:last-code")) || "null");
    expect(marker && [marker.email, marker.comp], "the send stays remembered, now with no event").toEqual([p.email.toLowerCase(), null]);
    // Continue reopens the code step for the code already in the inbox rather than
    // asking for a new one (which, two minutes on, would replace it).
    let asked = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/auth/code/request") && r.method() === "POST") asked++; });
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
    expect(asked, "no new code is asked for").toBe(0);
    // That code signs in, and joins nothing.
    const code = (await (await page.request.get(`/api/test/last-login-code?email=${encodeURIComponent(p.email)}`)).json()).code;
    await page.fill("#sc-code", code);
    await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
    await expect(page.locator("#login-page")).toBeHidden({ timeout: 20000 });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(booth.comp.id, p.id), "not enrolled").toBeUndefined();
    } finally { db.close(); }
  });

  test("Not your event? on the sign-up form asks to untie the address just proved, and the form drops the event", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    await api.dispose();
    const email = `newbie-${uniq()}@acme.com`;
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.fill("#ec-code", booth.display);
    await page.click('[data-action="event-code-apply"]');
    await page.click('[data-action="event-code-signin"]');
    await expect(page.locator("#join-banner")).toBeVisible({ timeout: 15000 });
    const { signUpViaUi } = require("./ui-admin-helpers");
    await signUpViaUi(page, email, {}, { submit: false });
    const out = page.locator("#reg-join-banner-out");
    await expect(out, "the form offers the way out").toBeVisible();
    const drop = page.waitForRequest(r => r.url().endsWith("/api/auth/code/drop-event") && r.method() === "POST");
    await out.click();
    expect(JSON.parse((await drop).postData() || "{}"), "the proven address is sent").toEqual({ email });
    await expect(page.locator("#reg-join-banner"), "the form holds no event").toBeHidden();
    await expect(page.locator("#register-page.active #reg-first"), "and the typed form is still there").toBeVisible();
  });

  test("a bad code is refused in the dialog, and the dialog stays open to retry", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.fill("#ec-code", "ZZZZZZ");
    await page.click('[data-action="event-code-apply"]');
    await expect(page.locator("#toast-stack .toast-error").first()).toContainText(/not valid for any event/i, { timeout: 15000 });
    await expect(page.locator("#ec-code"), "the field is still there to try again").toBeVisible();
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "and nothing was adopted").toBeFalsy();
  });
});

test.describe("the code step: one dialog, the address remembered", () => {
  test("Continue opens the code step NAMING the address; there is no second email step", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    expect(await page.locator('[data-action="request-login-code"]').count(), "no 'Already have a code?' door").toBe(0);
    await page.fill("#login-email", "someone@acme.com");
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#signin-code-overlay")).toContainText("someone@acme.com");
    expect(await page.locator("#sc-email").count(), "the dialog never asks for the address again").toBe(0);
  });

  test("Continue again for the same address goes straight to the code step and sends NOTHING", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    let requests = 0;
    page.on("request", (r) => { if (r.url().includes("/api/auth/code/request")) requests++; });
    await page.fill("#login-email", "holder@acme.com");
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
    expect(requests, "control: the first Continue asked for a code").toBe(1);
    await page.click('[data-action="signin-code-restart"]');
    await expect(page.locator("#signin-code-overlay")).toHaveCount(0);
    // The card reuses a code only while the server's lifetime says it lives (the
    // page carries it; GET /api/config, awaited here, reports the same value).
    await expect.poll(() => page.evaluate(() => window.S && window.S.loginCodeTtlMs), { message: "the server's code lifetime reached the card" }).toBeGreaterThan(0);
    await page.click("#login-submit");
    const step = page.locator("#signin-code-overlay");
    await expect(step, "the second Continue says the code is already out")
      .toContainText("a code is already on its way", { timeout: 10000 });
    await expect(step, "naming the address").toContainText("holder@acme.com");
    expect(requests, "and asked for no new code (it would replace the live one)").toBe(1);
  });

  test("an empty address is refused on the card, and nothing opens", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click("#login-submit");
    await expect(page.locator("#login-error")).toBeVisible();
    await expect(page.locator("#signin-code-overlay")).toHaveCount(0);
  });

  test("a WRONG code is reported as wrong even though the server answers 200", async ({ page }) => {
    const statuses = [];
    page.on("response", (r) => { if (r.url().includes("/api/auth/code/redeem")) statuses.push(r.status()); });
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.fill("#login-email", "nobody@acme.com");
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
    await page.fill("#sc-code", "ZZZZ-ZZZZ");
    await page.click('[data-action="signin-code-redeem"]');
    await expect(page.locator("#sc-error"), "the user IS told").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#sc-error")).toContainText(/not accepted|not valid|expired/i);
    expect(statuses, "…and the SERVER answered 200 while it was told").toEqual([200]);
  });
});
