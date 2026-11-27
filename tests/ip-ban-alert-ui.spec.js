// @ts-check
//
// v7.16.5 — BEHAVIOURAL browser coverage for the IP-ban alert.
//
// The modal appeared only in _screenshots.spec.js, which proves it RENDERS and
// nothing else — and that file is gated behind CAPTURE_SCREENSHOTS=1, so it is
// not part of `npm test` at all. Everything the client half actually has to get
// right was therefore unverified: that the poll surfaces an alert without a
// reload, that "Dismiss" hides it for that admin ALONE, that the
// dismiss-for-everyone control is superadmin-only in the markup *and* on the
// wire, and that a dismissal survives the next poll instead of the modal
// immediately reappearing.
//
// That last one is the reason this file exists rather than more API tests: the
// server contract was already covered, but a client that acked with the wrong
// scope — or forgot to stop showing an alert it had just dismissed — would pass
// every one of those and still nag an admin every twenty seconds during a live
// event.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DATA_DIR, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });


async function loginSuperadmin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => typeof window._adminAlertTick === "function", { timeout: 20000 });
}

// Raise the alert IN THE SERVER PROCESS. The store is in-process by design, so
// `require("../lib/admin-alerts")` from a spec gets a DIFFERENT Map and the
// server would never see it — the poll would then be tested against an alert
// that does not exist. (That was the first draft, and every assertion failed
// for exactly that reason.) The test-only endpoint reaches the real one.
async function raise(page, ip) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/test/raise-ip-ban-alert", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { ip, count4xx: 103, competitionId: "demo", competitionName: "Spring Hackathon" },
  });
  expect(r.ok(), `raise alert: ${r.status()}`).toBeTruthy();
  return (await r.json()).alert;
}
// Read the server's view of who can still see an alert.
async function openFor(page) {
  const r = await page.request.get("/api/admin/alerts");
  return r.ok() ? (await r.json()).alerts : [];
}

// A SECOND admin, on its own request context, so "hidden for me but not for my
// colleague" can actually be asserted. Built fresh rather than promoting a
// shared fixture, which would leak an admin role into every later test here.
async function freshAdminContext(page) {
  const { request } = require("./isolated-test");
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const email = `alertpeer_${stamp}@acme.com`;
  const password = "AlertPeer!2026";
  let t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  // v8.3.25 — ASSERT THE REGISTER. It was fire-and-forget, so a step that
  // silently did not happen surfaced forty lines later as "the peer admin
  // account must exist", which names neither the register nor a reason
  // (the v7.22.5 rule: a seed step that silently does not happen is worse than
  // one that fails).
  const reg = await registerPost(page.request, "/api/register", {
    headers: { "x-csrf-token": t, "content-type": "application/json" },
    data: {
      firstName: "Alert", lastName: "Peer", nickname: `apeer_${stamp}`, email,
      company: "Acme Corp", title: "Engineer", country: "US",
      timezone: "America/New_York", jobFunction: "Software Developer / Engineer",
      city: "New York", password,
    },
  });
  expect(reg.ok(), `peer register failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  // …AND LOOK THE ACCOUNT UP THE ONLY WAY THAT WORKS. `?search=` is a NO-OP on
  // GET /api/admin/participants — the handler never reads it — so this read was
  // really "page 1, ordered created_at ASC, the fifty OLDEST users" while the
  // account it wants is the NEWEST in the table. Fourth occurrence of the class
  // (v7.22.0, v8.2.3 ×2); the documented remedy is the endpoint's own 5000 cap,
  // and never to let `search` imply the server is filtering.
  //
  // IT IS NOT THE MECHANISM OF THE FAILURE THAT PROMPTED IT, and saying so
  // matters more than the fix: measured, this file's DB holds FOUR participants
  // and the peer lands at index 3, so fifty was never the binding constraint
  // here. It is a latent defect fixed on its own merits. What the observed
  // failure was — seen twice in full runs on a box at ~1.7x load, never in
  // isolation — is not established, so the durable half is the diagnostic below
  // rather than this line.
  const listR = await page.request.get(`/api/admin/participants?limit=5000`);
  // v8.3.26 — ASSERT THE READ. Every non-200 here has a JSON body
  // (`{"error":…}`), so it PARSES, `rows` becomes `[]`, and a 401 reported itself
  // as "the peer admin account must exist" — a missing row rather than a dead
  // session. With the register asserted above, this was the last unasserted step
  // on the path to that message.
  expect(listR.ok(),
    `the admin participants read must succeed: ${listR.status()} ${await listR.text().catch(() => "")}`).toBeTruthy();
  const list = await listR.json().catch(() => ({}));
  const rows = list.participants || [];
  const u = rows.find(p => p.email === email);
  // "Received: undefined" is equally true of a register that did not land, a
  // scan that never reached the row, and an admin session that had gone away
  // under this call — the three explanations this helper can fail by. Say which.
  expect(u,
    `the peer admin account must exist. register=${reg.status()} list=${listR.status()} ` +
    `scanned=${rows.length} looking for ${email}`).toBeTruthy();
  for (const path of ["verify", "approve"]) {
    t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post(`/api/admin/participants/${u.id}/${path}`, { headers: { "x-csrf-token": t } });
  }
  t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const role = await page.request.post(`/api/admin/participants/${u.id}/role`, {
    headers: { "x-csrf-token": t, "content-type": "application/json" }, data: { role: "admin" },
  });
  expect(role.ok(), `promote peer to admin: ${role.status()}`).toBeTruthy();

  const ctx = await request.newContext({ baseURL: BASE });
  const c = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(ctx, email, { "x-csrf-token": c, "content-type": "application/json" }, { password: password });
  expect(li.ok(), `peer admin login: ${li.status()}`).toBeTruthy();
  return ctx;
}

let _ipSeq = Date.now() % 1000;
const freshIp = () => `198.51.100.${(_ipSeq++ % 250) + 1}`;

test.describe("IP-ban alert — the admin's side (v7.16.5)", () => {
  // Alerts live in the SERVER process and outlive a test, so an alert an
  // earlier test raised and never dismissed is still open when the next one
  // polls — which reads as "the modal came back" and points at entirely the
  // wrong thing. (It did exactly that on the first run here.) Start each test
  // from an empty view by acking whatever is already open, for this admin only.
  // Leave NOTHING behind. An alert this file raises and does not dismiss stays
  // open in the server process and is then served to every later spec on the
  // same worker, whose admin sessions get a blocking modal over the panel —
  // 27 CI failures in v7.16.7, all reporting
  // "#admin-alert-overlay intercepts pointer events". The per-test drain below
  // is not enough on its own: it only runs BEFORE a test, so the last raise in
  // the file always escaped.
  test.afterEach(async ({ page }) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/test/clear-ip-ban-alerts", { headers: { "x-csrf-token": csrfToken } });
  });

  test.beforeEach(async ({ page }) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const login = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() },
    });
    if (!login.ok()) return;                       // the participant test logs in itself
    const list = await page.request.get("/api/admin/alerts");
    if (!list.ok()) return;
    const open = (await list.json()).alerts || [];
    for (const a of open) {
      const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post(`/api/admin/alerts/${a.id}/ack`, {
        headers: { "x-csrf-token": t, "content-type": "application/json" },
        data: { scope: "self" },
      });
    }
  });

  test("the poll raises the modal without a reload, and it names the address and the remedy", async ({ page }) => {
    await loginSuperadmin(page);
    const ip = freshIp();
    await raise(page, ip);
    // No navigation: the alert must arrive through the poll the admin already
    // has running, because a room-wide outage cannot wait for them to refresh.
    await page.evaluate(() => window._adminAlertTick());
    const overlay = page.locator("#admin-alert-overlay");
    await expect(overlay).toBeVisible({ timeout: 10000 });
    await expect(overlay).toContainText(ip);
    await expect(overlay, "names the competition, so the admin knows where to go")
      .toContainText("Spring Hackathon");
    await expect(overlay, "tells them the field to use").toContainText("Trusted network IPs");
    await expect(overlay, "and that the block lifts on save").toContainText("immediately on save");
    await expect(overlay, "and that it clears itself if the traffic stops").toContainText("clears itself");
  });

  // ON A PHONE THE NOTICE OPENS AT ITS TITLE. The card scrolls there (the copy
  // is long and the actions sit at its foot), and moving focus to Dismiss on
  // open scrolled it to the foot: the notice opened mid-message, past its
  // title and the blocked address. Focus still lands on Dismiss (the modal
  // contract), without scrolling to it.
  test("on a phone the notice opens at its title with focus on Dismiss, not scrolled to the button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginSuperadmin(page);
    const ip = freshIp();
    await raise(page, ip);
    await page.evaluate(() => window._adminAlertTick());
    const overlay = page.locator("#admin-alert-overlay");
    await expect(overlay).toBeVisible({ timeout: 10000 });
    const dismiss = overlay.locator("[data-action='admin-alert-dismiss']");
    await expect(dismiss, "the primary action holds focus on open").toBeFocused();
    const g = await page.evaluate(() => {
      const card = document.querySelector(".admin-alert-card"), ov = document.getElementById("admin-alert-overlay");
      const t = document.getElementById("admin-alert-title").getBoundingClientRect(), c = card.getBoundingClientRect();
      const d = document.querySelector("[data-action='admin-alert-dismiss']").getBoundingClientRect();
      // Where Dismiss sits in the card's CONTENT (independent of how far it is scrolled).
      return { overflow: card.scrollHeight - card.clientHeight, cardTop: card.scrollTop, overlayTop: ov.scrollTop,
        titleTop: t.top, cardBoxTop: c.top, dismissInContent: d.top - c.top + card.scrollTop, cardClient: card.clientHeight };
    });
    const why = JSON.stringify(g);
    expect(g.overflow, `PRECONDITION: on a phone the card scrolls, its Dismiss below the fold: ${why}`).toBeGreaterThan(40);
    expect(g.dismissInContent, `PRECONDITION: Dismiss sits below the card's first screenful: ${why}`).toBeGreaterThan(g.cardClient);
    expect(g.cardTop, `the card is not scrolled to the button: ${why}`).toBe(0);
    expect(g.overlayTop, `nor is the overlay: ${why}`).toBe(0);
    expect(g.titleTop, `the title is on screen at the top of the card: ${why}`).toBeGreaterThanOrEqual(g.cardBoxTop);
    await expect(overlay, "the notice reads from its start: the address it names is in view").toContainText(ip);
  });

  test("a superadmin sees BOTH controls; a regular admin sees only Dismiss", async ({ page }) => {
    await loginSuperadmin(page);
    await raise(page, freshIp());
    await page.evaluate(() => window._adminAlertTick());
    await expect(page.locator("#admin-alert-overlay")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[data-action='admin-alert-dismiss']")).toHaveCount(1);
    await expect(page.locator("[data-action='admin-alert-dismiss-global']"),
      "the superadmin gets the dismiss-for-everyone control").toHaveCount(1);

    // The regular-admin rendering is driven by the payload's isSuperAdmin flag,
    // which the SERVER sets from the session — so render it false and assert the
    // control is absent from the markup, not merely disabled.
    await page.evaluate(() => window._closeAdminAlert());
    await page.evaluate(() => window._showIpBanAlert({
      id: "x", kind: "ip_banned", ip: "198.51.100.250", at: Date.now(),
      blocked_until: new Date(Date.now() + 900000).toISOString(),
      count_4xx: 103, competition_id: "c", competition_name: "Spring Hackathon",
      already_trusted: false,
    }, false));
    await expect(page.locator("#admin-alert-overlay")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("[data-action='admin-alert-dismiss']")).toHaveCount(1);
    await expect(page.locator("[data-action='admin-alert-dismiss-global']"),
      "a regular admin must not be offered a control the server would 403"
    ).toHaveCount(0);
  });

  test("Dismiss hides it for THIS admin and it does not come back on the next poll", async ({ page }) => {
    await loginSuperadmin(page);
    const ip = freshIp();
    await raise(page, ip);
    await page.evaluate(() => window._adminAlertTick());
    await expect(page.locator("#admin-alert-overlay")).toBeVisible({ timeout: 10000 });

    await page.locator("[data-action='admin-alert-dismiss']").click();
    await expect(page.locator("#admin-alert-overlay")).toBeHidden({ timeout: 10000 });

    // The load-bearing half: poll again. A client that acked with the wrong
    // scope — or never acked at all — re-opens the modal here, and would nag an
    // admin every 20 seconds for the life of the block.
    await page.evaluate(() => window._adminAlertTick());
    await page.waitForTimeout(500);
    await expect(page.locator("#admin-alert-overlay"),
      "a dismissed alert must stay dismissed across polls"
    ).toBeHidden();

    // …and it was a SELF ack, not a global one: the alert is still live
    // server-side. A global dismiss would remove it for every admin, which is
    // the superadmin-only decision this button must never quietly make.
    const stillListed = await page.evaluate(async () => {
      const r = await fetch("/api/admin/alerts");
      return r.ok ? (await r.json()) : null;
    });
    expect(stillListed, "the alerts endpoint still answers").toBeTruthy();
    expect(stillListed.alerts.some(a => a.ip === ip),
      "…hidden for THIS admin (it is gone from their own list)"
    ).toBe(false);

    // Prove it was a SELF ack and not a global one. Both look identical from
    // this admin's own list, so that assertion alone cannot tell them apart —
    // verified by mutating the client to always send scope:"global", which the
    // check above happily passed. (A re-raise does not discriminate either: the
    // de-dup rule refuses a second alert for an address that already has one
    // open, whichever way it was dismissed.) The observable difference is what
    // a COLLEAGUE sees, which is also precisely the behaviour the two-tier
    // design exists for: one admin clearing their own dialog must not hide a
    // room-wide outage from the others.
    const peer = await freshAdminContext(page);
    try {
      const theirs = await (await peer.get("/api/admin/alerts")).json();
      expect(theirs.alerts.some(a => a.ip === ip),
        "a SELF dismiss must leave the alert visible to other admins; if this fails the client " +
        "acked with scope:global and silenced a room-wide outage for everyone"
      ).toBe(true);
    } finally { await peer.dispose(); }
  });

  test("a reader the event's PUT would refuse is told who can take the advice, never to save; a regular admin keeps the steps (CONTROL)", async ({ page }) => {
    // The alerts route decides `can_set_trusted_ips` per reader (events.edit, the
    // event in scope, not competing); the modal and the mail branch on it.
    await loginSuperadmin(page);
    const { request } = require("./isolated-test");
    const tok = async () => (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const hdr = async () => ({ "x-csrf-token": await tok(), "content-type": "application/json" });
    const name = `Alert reader ${Date.now()}`;
    const cr = await page.request.post("/api/admin/competitions", { headers: await hdr(), data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const ip = freshIp();
    const ra = await page.request.post("/api/test/raise-ip-ban-alert", { headers: await hdr(), data: { ip, count4xx: 103, competitionId: compId, competitionName: name } });
    expect(ra.ok(), await ra.text()).toBeTruthy();
    // An unscoped custom role that reads alerts but may not edit events.
    const role = await page.request.post("/api/admin/roles", { headers: await hdr(), data: { label: `Alert reader ${Date.now()}`, scope_mode: "all", permissions: ["events.view", "ops.alerts"] } });
    expect(role.ok(), await role.text()).toBeTruthy();
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const email = `alertreader_${stamp}@acme.com`;
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const reg = await registerPost(anon, "/api/register", { headers: { "x-csrf-token": (await (await anon.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" },
        data: { firstName: "Alert", lastName: "Reader", nickname: `areader_${stamp}`, email, company: "Acme Corp", title: "Engineer", country: "US", timezone: "America/New_York" } });
      expect(reg.ok(), await reg.text()).toBeTruthy();
    } finally { await anon.dispose(); }
    const all = await (await page.request.get("/api/admin/participants?limit=5000")).json();
    const u = all.participants.find(p => p.email === email);
    expect(u, "the reader account exists").toBeTruthy();
    for (const path of ["verify", "approve"]) await page.request.post(`/api/admin/participants/${u.id}/${path}`, { headers: await hdr() });
    const give = await page.request.post(`/api/admin/participants/${u.id}/role`, { headers: await hdr(), data: { role: (await role.json()).role.id } });
    expect(give.ok(), await give.text()).toBeTruthy();
    const reader = await request.newContext({ baseURL: BASE });
    const peer = await freshAdminContext(page);
    try {
      const rc = (await (await reader.get("/api/csrf-token")).json()).csrfToken;
      expect((await codeLogin(reader, email, { "x-csrf-token": rc, "content-type": "application/json" })).ok(), "the reader signs in").toBeTruthy();
      const mine = (await (await reader.get("/api/admin/alerts")).json()).alerts.find(a => a.ip === ip);
      expect(mine, "PRECONDITION: the reader sees the alert").toBeTruthy();
      expect(mine.can_set_trusted_ips, "events.edit is not theirs").toBe(false);
      const theirs = (await (await peer.get("/api/admin/alerts")).json()).alerts.find(a => a.ip === ip);
      expect(theirs.can_set_trusted_ips, "CONTROL: a regular admin may save the address").toBe(true);

      // The modal, from each reader's own payload. The superadmin page's own poll
      // is stopped first, so it cannot put ITS copy of the alert on screen.
      await page.evaluate(() => { window.stopAdminAlertPoll(); window._closeAdminAlert(); });
      await page.evaluate((a) => window._showIpBanAlert(a, false), mine);
      const overlay = page.locator("#admin-alert-overlay");
      await expect(overlay).toBeVisible({ timeout: 5000 });
      await expect(overlay).toContainText("You cannot change the event");
      await expect(overlay).toContainText("ask an administrator who can");
      await expect(overlay, "no steps the reader cannot take").not.toContainText("To unblock them now");
      await page.evaluate(() => window._closeAdminAlert());
      await page.evaluate((a) => window._showIpBanAlert(a, false), theirs);
      await expect(overlay).toBeVisible({ timeout: 5000 });
      await expect(overlay, "CONTROL: the steps").toContainText("To unblock them now");
      await expect(overlay).not.toContainText("You cannot change the event");
    } finally { await reader.dispose(); await peer.dispose(); }
  });

  test("a participant session never polls the admin alert endpoint", async ({ page }) => {
    // The tick short-circuits before issuing any request when the session is
    // not an admin in the admin view. Without that, a participant's browser
    // would poll an admin endpoint every 20 s and collect 403s.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r = await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": csrfToken, "content-type": "application/json" });
    expect(r.ok(), `alice login: ${r.status()}`).toBeTruthy();
    await page.goto("/");
    await page.waitForFunction(() => typeof window._adminAlertTick === "function", { timeout: 20000 });

    const calls = [];
    page.on("request", (req) => { if (req.url().includes("/api/admin/alerts")) calls.push(req.url()); });
    await page.evaluate(() => window._adminAlertTick());
    await page.waitForTimeout(500);
    expect(calls, "a participant must issue no admin-alert request at all").toEqual([]);
  });
});
