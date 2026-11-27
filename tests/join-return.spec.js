// @ts-check
//
// v7.22.8 — PERSISTED PENDING JOIN (the returning /join visitor).
//
// The reported live-event failure: a visitor opens the /join/<token> event
// link, abandons sign-up, and later comes back via the HOMEPAGE. The SPA
// deliberately strips the token from the URL and history (secrecy), so the
// return visit used to know nothing about the event — the visitor registered
// as an ordinary signee: unapproved, unassociated, and needing an admin to
// notice and repair all three steps by hand.
//
// The fix persists the pending join in localStorage (NOT a cookie — a cookie
// would retransmit the 256-bit secret on every request, including over the
// plain-http venue LANs this platform runs on) with expiry at the
// competition's EFFECTIVE end, revalidated against the public preview endpoint
// at boot (which also catches rotation / disable / early end — things a clock
// cannot see). Purged on success, on a preview 404, and on expiry.
//
// Fixture rules (CLAUDE.md checklist): every test owns its competition and its
// participant; nothing authenticates as a shared seeded fixture.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { fillBreakGlass, submitLogin, signUpViaUi } = require("./ui-admin-helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const JOIN_KEY = "hck-pending-join";

/** Single-slot comp with an enabled /join link. `live:true` starts it in the past. */
async function makeJoinableComp(sa, h, label, { live = false, enabled = true, withTask = false } = {}) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const name = `${label} ${stamp}`;
  const start = new Date(Date.now() + (live ? -5 * 60_000 : 3600_000)).toISOString();
  const cr = await sa.post("/api/admin/competitions", {
    headers: h, data: { name, start_time: start, duration_minutes: 240 },
  });
  expect(cr.ok(), `competition ${name} created`).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  let taskTitle = null;
  if (withTask) {
    taskTitle = `${label}-CH ${stamp}`;
    const taskId = (await (await sa.post("/api/admin/tasks", {
      headers: h,
      data: { title: taskTitle, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
    })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });
  }
  const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
  if (enabled) {
    const put = await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { self_enroll_enabled: true, expectedUpdatedAt: rv.updated_at } });
    expect(put.ok(), "self-enrollment enabled").toBeTruthy();
  }
  return { compId, name, token: rv.token, taskTitle, start };
}

/** Register + verify + approve + set a known password. Returns { id, email }. */
async function makeParticipant(sa, h) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const email = `jr_${stamp}@acme.com`;
  const { api: anon, csrf: anonCsrf } = await freshCtx();
  const rr = await registerPost(anon, "/api/register", {
    headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
    data: {
      firstName: "Join", lastName: "Returner", nickname: `jr_${stamp}`,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", email,
    },
  });
  expect(rr.ok(), `participant ${email} registered`).toBeTruthy();
  await anon.dispose();
  const parts = (await (await sa.get("/api/admin/participants?limit=2000")).json()).participants;
  const me = parts.find(p => p.email === email);
  expect(me, `participant ${email} present`).toBeTruthy();
  await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
  await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
  return { id: me.id, email };
}

function dbRow(sql, ...args) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

async function cleanupComp(compId) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const hh = { "x-csrf-token": csrf };
  await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: hh }).catch(() => {});
  await sa.delete(`/api/admin/competitions/${compId}`, { headers: hh }).catch(() => {});
  await sa.dispose();
}

const storedJoin = (page) => page.evaluate((k) => localStorage.getItem(k), JOIN_KEY);

// Log the page's request context in via the API (no SPA involvement). Same
// shape as ui-participant-b's helper: one retry absorbs a transient under load.
async function loginViaApi(page, email, password) {
  const doPost = async () => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: password });
  };
  let r = await doPost().catch(() => null);
  if (!r || !r.ok()) r = await doPost();
  if (!r.ok()) throw new Error(`Login failed for ${email}: ${r.status()}`);
}

test.describe("v7.22.8 — persisted pending join (returning /join visitor)", () => {

  test("the reported failure: abandon the /join sign-up, return via the HOMEPAGE — recognised, and registration carries the join", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinReturn");
    await sa.dispose();

    // First visit: the event link. Lands on sign-up with the banner (existing
    // behaviour) — and now also PERSISTS the pending join with the
    // competition's effective end as its expiry.
    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    const stored = JSON.parse(await storedJoin(page) || "null");
    expect(stored, "the pending join is persisted on the link visit").toBeTruthy();
    expect(stored.t).toBe(fx.token);
    // "Expires at the end of the competition" — the stored deadline IS the
    // competition's effective end (start + 240min for this single-slot comp).
    expect(stored.exp).toBe(Date.parse(fx.start) + 240 * 60_000);

    // THE RETURN: a plain homepage load — no token anywhere in the URL. This is
    // the exact reported scenario, and before the fix it landed on ordinary
    // sign-in with no memory of the event.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner")).toBeVisible();
    await expect(page.locator("#join-banner-info")).toContainText(fx.name);

    // Complete the registration the visitor abandoned. The rehydrated token
    // must ride the register call — that wiring (boot → S → doRegister) is the
    // whole recovery, so assert the REQUEST BODY, not just the outcome.
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const email = `ret_${stamp}@company.com`;
    // Email first: the rehydrated token rides the CODE REQUEST (the address proof
    // binds the event) and the form after it.
    const reqBody = page.waitForRequest(r => r.url().includes("/api/auth/code/request") && r.method() === "POST", { timeout: 20000 });
    const resp = signUpViaUi(page, email, { firstName: "Ret", lastName: "Urner" });
    expect(JSON.parse((await reqBody).postData() || "{}").joinToken, "the REHYDRATED token rode the code request").toBe(fx.token);
    const r = await resp;
    expect(r.status(), `registration succeeded: ${await r.text()}`).toBe(200);

    // The happy path is whole again: approved and ENROLLED (the sign-up signs the
    // new account in, and the sign-in consumes the join).
    const row = dbRow("SELECT id, approved, verified FROM users WHERE email=?", email);
    expect(row, "account created").toBeTruthy();
    expect(row.approved, "approval queue skipped").toBe(1);
    await expect.poll(() => dbRow("SELECT COUNT(*) n FROM competition_users WHERE user_id=? AND competition_id=?", row.id, fx.compId).n,
      { message: "enrolled in the event" }).toBe(1);

    // Purge-on-success: the server owns the pending state now; the browser
    // keeps no spent secret.
    await expect.poll(() => storedJoin(page)).toBeNull();

    await cleanupComp(fx.compId);
  });

  test("the pending join survives a browser RESTART", async ({ page, browser }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinRestart");
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });

    // A fresh context seeded from the persisted storage IS the restart: new
    // process-equivalent, no in-memory SPA state, only what survived on disk.
    const state = await page.context().storageState();
    const ctx2 = await browser.newContext({ storageState: state, baseURL: BASE });
    try {
      const page2 = await ctx2.newPage();
      await page2.goto("/");
      await page2.waitForSelector("#login-page.active", { timeout: 10000 });
      await expect(page2.locator("#join-banner")).toBeVisible();
      await expect(page2.locator("#join-banner-info")).toContainText(fx.name);
    } finally { await ctx2.close(); }

    await cleanupComp(fx.compId);
  });

  test("a stored token whose link the admin DISABLED is purged on return — ordinary sign-in landing, no banner", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinDisable");

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    expect(await storedJoin(page), "stored before the disable").toBeTruthy();

    // The admin turns self-enrollment off. The stored clock knows nothing of
    // this — only the boot revalidation against the preview endpoint can.
    const rv = await (await sa.get(`/api/admin/competitions/${fx.compId}/self-enroll`)).json();
    const put = await sa.put(`/api/admin/competitions/${fx.compId}`, { headers: h, data: { self_enroll_enabled: false, expectedUpdatedAt: rv.updated_at } });
    expect(put.ok(), "self-enrollment disabled").toBeTruthy();
    await sa.dispose();

    await page.goto("/");
    // NOT the sign-up landing: a dead stored token must leave a plain homepage
    // visit exactly as it always was.
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner")).toBeHidden();
    await expect.poll(() => storedJoin(page), "the dead token is purged").toBeNull();

    await cleanupComp(fx.compId);
  });

  // v8.1.4 — RE-POINTED, not weakened. This pinned "past `exp` purges with no
  // network", which was the defect: extending or reviving a competition is an
  // ordinary admin action, so `exp` can be in the past while the event is still
  // joinable, and the walk-up who abandoned a sign-up had their recovery deleted
  // on a clock's say-so (the failure v7.22.8 exists to prevent). Only the server's
  // 404 may now delete a token that could still be live. The zero-network purge
  // survives where it is genuinely free — past `exp + PENDING_JOIN_KEEP_MS`, a
  // deadline so far gone that no revive could still be in play — which is what
  // this test now pins. The just-past-`exp` case is locked in join-recovery.spec.js.
  test("a LONG-expired token purges with NO network round-trip", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinExpiry");
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });

    // Age the stored deadline PAST THE KEEP WINDOW (30 days), not merely past
    // `exp`: a token a second past its deadline may still belong to an event an
    // admin has just extended, and that one is worth a request. A year-old one
    // is not.
    await page.evaluate((k) => {
      const p = JSON.parse(localStorage.getItem(k));
      p.exp = Date.now() - 365 * 24 * 3600_000;
      localStorage.setItem(k, JSON.stringify(p));
    }, JOIN_KEY);

    let previews = 0;
    await page.route("**/api/competitions/self-enroll/**", (route) => { previews++; return route.continue(); });

    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect.poll(() => storedJoin(page), "expired token purged").toBeNull();
    // The expiry branch must not spend a request validating a token the clock
    // already condemned — that is the whole point of storing the deadline.
    expect(previews, "no preview call for an expired token").toBe(0);

    await cleanupComp(fx.compId);
  });

  test("signed-in recovery: abandon the link, return via the homepage, sign IN — enrolled, routed in, and the stored token is spent", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinSignin", { live: true, withTask: true });
    const me = await makeParticipant(sa, h); // deliberately NOT assigned
    await sa.dispose();

    expect(dbRow("SELECT 1 AS x FROM competition_users WHERE user_id=? AND competition_id=?", me.id, fx.compId),
      "not a member before the visit (anti-vacuity control)").toBeFalsy();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });

    // The return: homepage, then "Sign In" — an existing account holder who
    // clicked the event link days earlier. The banner on the LOGIN page is the
    // recovery evidence: it proves the rehydrated token survived into doLogin's
    // join path.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await page.waitForSelector("#login-page.active", { timeout: 5000 });
    await expect(page.locator("#join-banner")).toBeVisible();

    await page.fill("#login-email", me.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);

    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator(`.task-card:has-text("${fx.taskTitle}")`).first()).toBeVisible({ timeout: 15000 });

    const row = dbRow("SELECT assigned_by FROM competition_users WHERE user_id=? AND competition_id=?", me.id, fx.compId);
    expect(row, "enrolled via the recovered token").toBeTruthy();
    expect(row.assigned_by).toBe("self_enroll");

    // Purge-on-success — this is what keeps a later admin REMOVAL from being
    // silently undone by the stored token on the participant's next visit.
    await expect.poll(() => storedJoin(page)).toBeNull();

    await cleanupComp(fx.compId);
  });

  test("a DEAD link visit neither surfaces a DIFFERENT stored competition nor wipes its token", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fxA = await makeJoinableComp(sa, h, "JoinAlive");
    const fxB = await makeJoinableComp(sa, h, "JoinDead", { enabled: false }); // link inert
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fxA.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner-info")).toContainText(fxA.name);

    // Clicking DEAD link B: today's bannerless sign-up landing, unchanged — the
    // visitor asked for B, so stored A must not be overlaid onto this visit.
    await page.goto(`/join/${encodeURIComponent(fxB.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner")).toBeHidden();
    // …and A's stored token survives: purging on a 404 is same-token only.
    expect(JSON.parse(await storedJoin(page) || "null")?.t, "stored A survives the dead-B visit").toBe(fxA.token);

    // A later plain homepage visit still recovers A.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner-info")).toContainText(fxA.name);

    await cleanupComp(fxA.compId);
    await cleanupComp(fxB.compId);
  });

  test("the public preview carries effective_end — the expiry the client persists against", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinEnd");
    await sa.dispose();

    const { api: anon } = await freshCtx();
    const pv = await (await anon.get(`/api/competitions/self-enroll/${encodeURIComponent(fx.token)}`)).json();
    await anon.dispose();
    expect(pv.effective_end, "effective_end present").toBeTruthy();
    expect(Date.parse(pv.effective_end), "single-slot effective end = start + duration").toBe(Date.parse(fx.start) + 240 * 60_000);

    await cleanupComp(fx.compId);
  });

  test("effective_end is the EFFECTIVE end — a session ending after start+duration moves it (the v7.21.31 vacuity trap)", async ({}, testInfo) => {
    // The single-slot assertion above is satisfied by `start_time +
    // duration_minutes` as well as by competitionEffectiveEnd — the two only
    // diverge once a SESSION outlives the competition's own duration, so this
    // is the discriminating fixture.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinEndTs");
    const tsStart = new Date(Date.parse(fx.start) + 3600_000).toISOString();
    const ts = await sa.post(`/api/admin/competitions/${fx.compId}/timeslots`, {
      headers: h, data: { name: "Long Session", start_time: tsStart, duration_minutes: 600 },
    });
    expect(ts.ok(), "session created").toBeTruthy();

    const { api: anon } = await freshCtx();
    const pv = await (await anon.get(`/api/competitions/self-enroll/${encodeURIComponent(fx.token)}`)).json();
    await anon.dispose();
    await sa.dispose();
    const sessionEnd = Date.parse(tsStart) + 600 * 60_000;
    expect(sessionEnd, "fixture discriminates: session end != start + duration").not.toBe(Date.parse(fx.start) + 240 * 60_000);
    expect(Date.parse(pv.effective_end), "effective_end follows the session").toBe(sessionEnd);

    await cleanupComp(fx.compId);
  });

  test("a TRANSIENT preview failure (5xx) keeps the stored token — the recovery survives a deploy blip", async ({ page }) => {
    // The first cut of this feature purged on ANY non-OK preview, which the
    // adversarial review flagged as the v7.16.4 anti-pattern: the preview is
    // rate-limited 30/min/IP, so a venue-NAT cohort 429s it routinely, and a
    // 5xx arrives during any deploy — a blip would have permanently destroyed
    // the recovery in exactly the environment the feature targets. Only a 404
    // (the server's verdict) may purge.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinBlip");
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });

    await page.route("**/api/competitions/self-enroll/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"upstream"}' }));
    await page.goto("/");
    // No rehydration this boot (never act on unvalidated state) → plain login
    // landing — but the stored copy MUST survive.
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    expect(JSON.parse(await storedJoin(page) || "null")?.t, "storage kept across the 5xx").toBe(fx.token);

    // Blip over → the very next visit recovers.
    await page.unroute("**/api/competitions/self-enroll/**");
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await expect(page.locator("#join-banner-info")).toContainText(fx.name);

    await cleanupComp(fx.compId);
  });

  test("a rehydrated token auto-joins an already-authenticated PARTICIPANT at boot", async ({ page }) => {
    // The boot call site (main.js authenticated branch) previously only ever
    // saw a URL-clicked token; rehydration is a second supplier and needs its
    // own lock — the doLogin twin below cannot cover it.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinBoot2", { live: true, withTask: true });
    const me = await makeParticipant(sa, h);
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });

    // Sign in through the API (no SPA involvement — doLogin's join never runs),
    // then boot the app cold: only the rehydrated token can drive the join.
    await loginViaApi(page, me.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator(`.task-card:has-text("${fx.taskTitle}")`).first()).toBeVisible({ timeout: 15000 });

    const row = dbRow("SELECT assigned_by FROM competition_users WHERE user_id=? AND competition_id=?", me.id, fx.compId);
    expect(row, "enrolled by the rehydrated boot join").toBeTruthy();
    expect(row.assigned_by).toBe("self_enroll");
    await expect.poll(() => storedJoin(page)).toBeNull();

    await cleanupComp(fx.compId);
  });

  test("a rehydrated token does NOT auto-join an ADMIN entering participant view", async ({ page }) => {
    // An admin who once opened the event link while signed out (checking their
    // own link is an ordinary admin act) must not be silently enrolled the
    // next time they toggle into participant view — a rehydrated token is
    // ambient state, not a click. URL-clicked tokens keep today's behaviour.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinAdmin", { live: true });
    const me = await makeParticipant(sa, h);
    const promote = await sa.post(`/api/admin/participants/${me.id}/role`, { headers: h, data: { role: "admin" } });
    expect(promote.ok(), "promoted to admin").toBeTruthy();
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    expect(await storedJoin(page), "token stored from the anonymous visit").toBeTruthy();

    let joinPosts = 0;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/competitions/join")) joinPosts++; });

    await loginViaApi(page, me.email, PARTICIPANT_PASS);
    // Into participant view (the session flag flips; the reload boots the
    // participant branch with userRole 'admin'). POSITIVE CONTROLS below —
    // the first cut of this test passed VACUOUSLY because this toggle 500'd
    // (the body-less-POST bug fixed alongside) and boot never left admin
    // view, so the join branch was unreachable with or without its gate.
    const csrf2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const tg = await page.request.post("/api/toggle-admin-view", {
      headers: { "x-csrf-token": csrf2, "content-type": "application/json" },
      data: { mode: "participant" },
    });
    expect(tg.ok(), `toggle-admin-view succeeded: ${tg.status()}`).toBeTruthy();
    const meNow = await (await page.request.get("/api/me")).json();
    expect(meNow.isAdminView, "session really is in participant view").toBeFalsy();
    await page.goto("/");
    // The participant shell for a competition-less user is the picker — a
    // concrete landing, so a boot stuck in admin view fails HERE, loudly.
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });

    expect(joinPosts, "no join was fired for the admin").toBe(0);
    expect(dbRow("SELECT 1 AS x FROM competition_users WHERE user_id=? AND competition_id=?", me.id, fx.compId),
      "no membership row was created").toBeFalsy();

    await cleanupComp(fx.compId);
  });

  test("a body-less POST to /api/toggle-admin-view is answered, not 500'd", async () => {
    // Found while locking the test above: Express 5 leaves req.body UNDEFINED
    // when no parser ran, and the handler's bare `req.body.mode` threw — a 500
    // for any API client omitting the JSON body (the batch-5 "malformed body
    // must not 500" class). An empty body reads as participant view.
    //
    // Must be a USER-BACKED session: the built-in superadmin has no userId, so
    // the handler 403s before the body is ever touched and the lock would be
    // vacuous (measured — the first cut used the superadmin and passed with
    // the guard reverted).
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    const h = { "x-csrf-token": sc, "content-type": "application/json" };
    const me = await makeParticipant(sa, h);
    await sa.dispose();
    const { api } = await apiLogin(me.email, PARTICIPANT_PASS);
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const r = await api.post("/api/toggle-admin-view", { headers: { "x-csrf-token": csrf } });
    expect(r.status(), await r.text()).toBeLessThan(500);
    await api.dispose();
  });



  test("corrupt localStorage content is purged and never breaks boot", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    for (const junk of ["{{{not json", '{"foo":1}', '{"t":123,"exp":"x"}']) {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [JOIN_KEY, junk]);
      await page.goto("/");
      // Boots normally (login landing, no banner)…
      await page.waitForSelector("#login-page.active", { timeout: 10000 });
      await expect(page.locator("#join-banner")).toBeHidden();
      // …and the poisoned key is gone, not re-read forever.
      await expect.poll(() => storedJoin(page), `junk ${junk} purged`).toBeNull();
    }
  });

  test("a TRANSIENT refusal KEEPS the stored token", async ({ page }) => {
    // v8.2.2 — this was one test asserting two halves of one decision: a FULL
    // event purged the token, a transient refusal kept it. The self-enrolment
    // ceiling is removed, so there is no `event_full` refusal left to purge on
    // and that half is gone with it. The transient half is the one that was
    // always load-bearing and it stays: a 429 from the venue-NAT cohort or a 5xx
    // mid-deploy must not cost the recovery this whole module exists to provide
    // (v7.16.4). Only the server's 404 verdict deletes — asserted in the
    // sibling tests above.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, "JoinTransient", { live: true });
    const me = await makeParticipant(sa, h);
    await sa.dispose();

    await page.goto("/");
    await loginViaApi(page, me.email, PARTICIPANT_PASS);

    // BOTH the stored copy AND `S._pendingJoinToken` are seeded explicitly.
    // `joinViaPendingToken` returns immediately when the in-memory token is
    // empty, so seeding only localStorage makes the assertion below VACUOUS —
    // measured on the original of this test: it passed with the purge rule
    // inverted, because the function never ran. Boot's own rehydration also
    // consumes the in-memory token, so it cannot be relied on to still be there.
    const arm = async () => page.evaluate(([k, t]) => {
      localStorage.setItem(k, JSON.stringify({ t, exp: Date.now() + 3600e3 }));
      window.S._pendingJoinToken = t;
    }, [JOIN_KEY, fx.token]);

    await page.route("**/api/competitions/join", (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await arm();
    // FIRE-AND-FORGET (the braces), then poll. `page.evaluate` AWAITS a returned
    // promise, and awaiting this one races the SPA's own teardown of it —
    // "Resulting promise was garbage collected". The observable is the state it
    // leaves behind, so wait for that instead (v7.21.15).
    await page.evaluate(() => { window.joinViaPendingToken(); });
    await expect.poll(() => page.evaluate(() => window.S._pendingJoinToken),
      { message: "the join attempt ran (it clears the in-memory token first)" }).toBe("");
    expect(await storedJoin(page), "a 503 must not cost the recovery").toBeTruthy();
    await page.unroute("**/api/competitions/join");
  });


});

// A JOIN LINK CLOSED WHILE THE SIGN-UP FORM IS OPEN. The account is made in no
// event and the register's answer says the link closed (`join_link_closed`):
// the app forgets the dead link, so nothing asks to join through it after the
// sign-in (a refused join is an error toast and a 4xx the scanner counts), and
// says so in plain words. CONTROL: the link left open, the app joins through it.
test.describe("a join link closed while the sign-up form is open", () => {
  const CLOSED_TOAST = "That event's join link was closed, so you were not added to it.";
  async function signUpThroughLink(page, { closeBeforeSubmit }) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fx = await makeJoinableComp(sa, h, closeBeforeSubmit ? "JoinClosedMid" : "JoinLeftOpen", { live: true });
    const joins = [];
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/competitions/join") joins.push(r.url()); });
    try {
      await page.goto(`/join/${encodeURIComponent(fx.token)}`);
      await page.waitForSelector("#login-page.active", { timeout: 10000 });
      const email = `jclosed_${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}@company.com`;
      await signUpViaUi(page, email, { firstName: "Mid", lastName: "Form" }, { submit: false });
      if (closeBeforeSubmit) {
        const rv = await (await sa.get(`/api/admin/competitions/${fx.compId}/self-enroll`)).json();
        const put = await sa.put(`/api/admin/competitions/${fx.compId}`, { headers: h, data: { self_enroll_enabled: false, expectedUpdatedAt: rv.updated_at } });
        expect(put.ok(), `switch the link off: ${await put.text()}`).toBeTruthy();
      }
      const resp = page.waitForResponse(x => x.url().includes("/api/register") && x.request().method() === "POST", { timeout: 20000 });
      await page.click("#register-page [data-action='do-register']");
      const r = await resp;
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      // The participant bar is built once the sign-in routes on.
      await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 20000 });
      const row = dbRow("SELECT id FROM users WHERE email=?", email);
      expect(row, "PRECONDITION: the account was made").toBeTruthy();
      return { fx, body, joins, row };
    } finally { await sa.dispose(); }
  }

  test("closed after the code was entered: the app says so and asks to join nothing", async ({ page }) => {
    const { fx, body, joins, row } = await signUpThroughLink(page, { closeBeforeSubmit: true });
    expect(body.join_link_closed, "the answer says the link closed").toBe(true);
    await expect(page.locator("#toast-stack .toast", { hasText: CLOSED_TOAST })).toBeVisible();
    // The witness that the sign-in got past its join step: an account in no
    // event lands on the events list only after that step.
    await expect(page.locator("#competitions-page.active")).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() => window.S._pendingJoinToken), "the dead link is forgotten").toBeFalsy();
    expect(joins, "no join is asked for through the closed link").toEqual([]);
    expect(dbRow("SELECT COUNT(*) n FROM competition_users WHERE user_id=? AND competition_id=?", row.id, fx.compId).n, "in no event").toBe(0);
    await cleanupComp(fx.compId);
  });

  test("CONTROL: left open, the app joins through the link and says nothing about a closed one", async ({ page }) => {
    const { fx, body, joins, row } = await signUpThroughLink(page, { closeBeforeSubmit: false });
    expect(body.join_link_closed, "CONTROL: a live link says nothing").toBeUndefined();
    await expect.poll(() => joins.length, { message: "CONTROL: the app joins through the live link after the sign-in" }).toBeGreaterThan(0);
    await expect.poll(() => dbRow("SELECT COUNT(*) n FROM competition_users WHERE user_id=? AND competition_id=?", row.id, fx.compId).n, { message: "CONTROL: in the event" }).toBe(1);
    expect(await page.locator("#toast-stack .toast", { hasText: CLOSED_TOAST }).count(), "CONTROL: no closed-link toast").toBe(0);
    await cleanupComp(fx.compId);
  });
});
