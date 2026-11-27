// @ts-check
//
// v8.10.2 / v8.10.3 — EXITING IMPERSONATION FROM INSIDE A CHALLENGE.
//
// v8.10.3 CORRECTS THE DIAGNOSIS BELOW RATHER THAN REPLACING IT. The telemetry
// POST really can sign somebody out and is really fixed here — but it is one
// member of a class, and it was not the one the operator hit: the fix shipped and
// the report came back unchanged. The class is:
//
//   `exitImpersonation` AWAITS its fetch before `location.href = "/"`, and the
//   session-expiry interceptor answers a refusal it recognises with
//   `new Promise(() => {})`. So any refusal of the EXIT REQUEST ITSELF disables
//   the one control an admin has for getting out of somebody else's account —
//   and on the `csrf_invalid` arm the same branch POSTs /api/logout, destroying
//   the admin session the exit was trying to restore.
//
// MEASURED against a real dev-mode server, both directions: with a CSRF token the
// page cannot use, the click produces `403 POST /api/impersonation/exit` then
// `403 POST /api/logout`, leaves the page on the impersonated view behind a
// "Signed out" dialog, and a refresh lands on the login card — the reported
// symptom, both halves, exactly. With the fix the same input produces
// `200 GET /api/csrf-token` then `200 POST /api/impersonation/exit`, and the
// admin is back in their own session.
//
// THE STALE TOKEN IS NOT CONTRIVED. Every read in an impersonated browse is a
// GET, so a token that never arrived (a 429 from the 120/min per-IP cap at boot,
// a blip) or that stopped matching (the 60-minute idle sweep — and inside an
// ENDED competition the keepalive's `_inLiveCompetition` arm is off, so reading a
// challenge keeps nothing alive) shows no symptom at all until the first non-GET.
// In that flow the first non-GET is the Exit click.
//
// THE ORIGINAL v8.10.2 MECHANISM, still covered by the first two tests:
//
// Reported: "as superadmin, I impersonate a normal user. I go into one of their
// competitions (already ended). If I also go inside one of the challenges and
// click on exit impersonation there, the app hangs and refreshing the page logs
// me out."
//
// THE MECHANISM, measured end to end. `fireNavigatedAway` (participant-tasks.js)
// posts `/api/tasks/:id/navigated-away` from the `pagehide` handler with
// `keepalive:true` — deliberately, so it OUTLIVES the page (v7.27.0). It is
// therefore the one request in the SPA guaranteed to land AFTER a session
// transition rather than before it, and it only fires at all when
// `S._openedTaskId` is set, i.e. from INSIDE a challenge detail view — which is
// exactly the condition the report names.
//
// Exiting impersonation regenerates the session. The keepalive POST then arrives
// at the freshly restored ADMIN session carrying the participant's context and
// the old page's CSRF token, and whichever guard answers first, the session-
// expiry interceptor (core/api.js) took it as proof the session had died:
//   • `requireParticipant` -> 401 "Not authenticated" -> _stopAllPolls, a
//     "signed out" modal, and `return new Promise(() => {})` — a fetch that never
//     settles. That is the hang.
//   • or, for a user-backed superadmin who had a competition selected, `staff`
//     short-circuits membership and it reaches `csrfProtection` -> 403
//     `csrf_invalid` -> the one branch that POSTs /api/logout, DESTROYING the
//     admin session the exit had just restored. That is the logout on refresh.
//
// WHY IT READS AS A RACE, and why the reported version is intermittent: whether
// the response beats the navigation decides whether the old document is still
// alive to react. Verified against v8.9.0 in a worktree — the identical 401 is
// produced there, so this predates the sealed-answer work and was always latent.
// The tests below therefore drive the mechanism DIRECTLY rather than relying on
// the race, and the end-to-end arm covers the reported flow on top.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, getSuperadminPass, codeLogin } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const iso = ms => new Date(Date.now() + ms).toISOString();

let sa, saCsrf, participant, compId, taskId;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  participant = await makeParticipant(sa, saCsrf, "navaway");

  const cr = await sa.post("/api/admin/competitions", {
    headers: H(saCsrf),
    data: { name: uniq("NavAwayExit"), start_time: iso(-3600_000), duration_minutes: 120, timezone: "UTC" },
  });
  expect(cr.ok(), `competition: ${cr.status()} ${await cr.text()}`).toBeTruthy();
  compId = (await cr.json()).competition.id;

  const tr = await sa.post("/api/admin/tasks", {
    headers: H(saCsrf),
    data: { title: uniq("NavAwayTask"), description: "<p>d</p>", difficulty: "easy",
            answer_type: "text", correct_answer: "k", status: "published" },
  });
  expect(tr.ok(), `challenge: ${tr.status()} ${await tr.text()}`).toBeTruthy();
  taskId = (await tr.json()).id;
  const asn = await sa.post(`/api/admin/tasks/${taskId}/competitions`,
    { headers: H(saCsrf), data: { competitionIds: [compId] } });
  expect(asn.ok(), `assign challenge: ${asn.status()} ${await asn.text()}`).toBeTruthy();

  const asg = await sa.post("/api/admin/competitions/assign",
    { headers: H(saCsrf), data: { userIds: [participant.id], competitionIds: [compId] } });
  expect(asg.ok(), `assign participant: ${asg.status()} ${await asg.text()}`).toBeTruthy();
  // The assign SKIPS an ineligible user and still answers 200 (fixture item 7).
  expect((await asg.json()).assigned, "the participant really was enrolled").toBe(1);

  // They enter, so they hold a real competition context; THEN it ends — the
  // reported condition, and the one that raises the ended modal on entry.
  const { api: pc, csrf: pc1 } = await freshCtx();
  try {
    const li = await codeLogin(pc, participant.email, H(pc1));
    expect(li.ok(), `participant login: ${li.status()} ${await li.text()}`).toBeTruthy();
    const c = (await (await pc.get("/api/csrf-token")).json()).csrfToken;
    const sel = await pc.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } });
    expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  } finally { await pc.dispose(); }

  const en = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(saCsrf) });
  expect(en.ok(), `end-now: ${en.status()} ${await en.text()}`).toBeTruthy();
});

test.afterAll(async () => { await sa?.dispose(); });

/** Superadmin -> impersonate -> the ended competition -> INSIDE a challenge. */
async function intoChallengeAsImpersonatedParticipant(page) {
  await page.goto("/");
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });

  const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const imp = await page.request.post(`/api/admin/participants/${participant.id}/impersonate`, { headers: { "x-csrf-token": c1 } });
  expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();

  await page.goto("/");
  await page.waitForSelector(".impersonation-banner", { state: "visible", timeout: 20_000 });
  const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/select-competition", {
    headers: { "x-csrf-token": c2, "content-type": "application/json" }, data: { competitionId: compId } });
  await page.goto("/");
  await page.waitForSelector(".impersonation-banner", { state: "visible", timeout: 20_000 });

  // The ended competition raises its modal from the status poll; it intercepts
  // every click, so dismiss it exactly as the reporting operator had to.
  await page.waitForTimeout(1200);
  for (const sel of ["#modal-confirm-btn", "#modal-cancel-btn", "#modal-close-btn"]) {
    const l = page.locator(sel);
    if (await l.count() && await l.isVisible().catch(() => false)) { await l.click().catch(() => {}); break; }
  }
  await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("#nav-challenges:not([aria-disabled=true])").click();
  await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`).click();
  await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 15_000 });

  // THE PRECONDITION THE WHOLE FILE RESTS ON: the departure telemetry only fires
  // from inside a challenge, so without this every assertion below is vacuous.
  expect(await page.evaluate(() => !!(window.S && window.S._openedTaskId)),
    "the challenge detail view really armed the navigated-away telemetry").toBe(true);
}

test.describe("v8.10.2/v8.10.3 — exiting impersonation from inside a challenge", () => {

  test("the departure telemetry settles and signs nobody out when it lands after the session transition", async ({ page }) => {
    const posts = [];
    page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/")) posts.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });

    await intoChallengeAsImpersonatedParticipant(page);

    // Regenerate the session WITHOUT navigating, so the page survives with its
    // stale participant state — the state the keepalive POST really lands in.
    // Driven directly rather than through the button, because the reported bug
    // is a RACE with the navigation and a test that depends on winning it proves
    // nothing on a fast machine (measured: this box takes the harmless branch).
    const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const ex = await page.request.post("/api/impersonation/exit", { headers: { "x-csrf-token": c } });
    expect(ex.ok(), `exit: ${ex.status()} ${await ex.text()}`).toBeTruthy();

    posts.length = 0;
    // PRE-FIX THIS NEVER SETTLES: the interceptor's forced-signout branch ends in
    // `return new Promise(() => {})`. The race against a timeout is what turns a
    // hang into a failing assertion instead of a hanging test.
    const outcome = await page.evaluate(async () => {
      const p = Promise.resolve(window.fireNavigatedAway("test")).then(() => "settled", () => "settled");
      const t = new Promise(res => setTimeout(() => res("HUNG"), 5000));
      return Promise.race([p, t]);
    });
    expect(outcome, "the telemetry POST settles — it must never hand back a promise that never resolves").toBe("settled");

    await page.waitForTimeout(600);
    expect(posts.filter(u => u.includes("/api/logout")),
      "nothing logged the admin out — that POST is what destroys the just-restored session").toEqual([]);
    expect(await page.evaluate(() => !!(window.S && window.S._sessionExpiredHandled)),
      "and the SPA did not decide the session had expired").toBe(false);

    // The restored ADMIN session is alive. page.request, not the intercepted
    // window.fetch, so the probe cannot itself be swallowed by the interceptor.
    const me = await page.request.get("/api/admin/me");
    expect(me.status(), "the admin session survived the departure telemetry").toBe(200);
  });

  test("CONTROL: a NON-telemetry request on the same dead session DOES still force the sign-out", async ({ page }) => {
    // Without this, the test above is satisfied by a build that deleted the
    // session-expiry machinery altogether — which would be far worse than the
    // bug it fixes.
    await intoChallengeAsImpersonatedParticipant(page);
    const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const ex = await page.request.post("/api/impersonation/exit", { headers: { "x-csrf-token": c } });
    expect(ex.ok(), `exit: ${ex.status()} ${await ex.text()}`).toBeTruthy();

    // An ordinary participant read on the now-admin session: 401 Not authenticated.
    await page.evaluate(() => { fetch("/api/status").catch(() => {}); });
    await expect.poll(() => page.evaluate(() => !!(window.S && window.S._sessionExpiredHandled)), {
      message: "an ordinary 401 still trips the forced-signout path",
      timeout: 10_000, intervals: [100, 200, 400, 800],
    }).toBe(true);
  });

  test("the reported flow: Exit from inside the challenge lands in the admin view, still signed in", async ({ page }) => {
    const posts = [];
    page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/")) posts.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });

    await intoChallengeAsImpersonatedParticipant(page);
    posts.length = 0;

    await page.locator(".impersonation-banner [data-action='impersonation-exit'], .impersonation-banner button")
      .first().click();
    await page.waitForTimeout(4000);

    expect(posts.filter(u => u.includes("/api/logout")), "the exit logged nobody out").toEqual([]);
    // Back in the ADMIN view rather than on the login card, which is what the
    // operator's refresh landed on.
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    expect(await page.request.get("/api/admin/me").then(r => r.status()),
      "still signed in as the admin after a refresh").toBe(200);
  });

  // ── v8.10.3 — THE ESCAPE HATCH ITSELF ──────────────────────────────────────

  test("v8.10.3: Exit with no usable CSRF token still exits cleanly, and the admin stays signed in", async ({ page }) => {
    const posts = [];
    page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/")) posts.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });

    await intoChallengeAsImpersonatedParticipant(page);

    // The page holds no token it can use. Reached in the wild by a boot-time
    // /api/csrf-token that failed; asserted here directly because the outcome,
    // not the cause, is what must not regress.
    await page.evaluate(() => { window.S.csrfToken = ""; });
    posts.length = 0;

    await page.locator(".impersonation-banner [data-action='impersonation-exit'], .impersonation-banner button")
      .first().click();
    await page.waitForTimeout(4000);

    // PRE-FIX: the empty token 403s, the server's EBADCSRFTOKEN handler DESTROYS
    // the authenticated session, the interceptor POSTs /api/logout and hands back
    // a promise that never settles — so `location.href` never runs. Refreshing a
    // second later lands on the login card. That is the whole report.
    expect(posts.filter(u => u.includes("/api/logout")),
      "pressing Exit must never log the admin out").toEqual([]);
    await expect(page.locator(".impersonation-banner")).toHaveCount(0);
    expect(await page.evaluate(() => !!(window.S && window.S._sessionExpiredHandled)),
      "and the SPA did not decide the session had expired").toBe(false);

    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    expect(await page.request.get("/api/admin/me").then(r => r.status()),
      "the admin is back in their own session after a refresh").toBe(200);
  });

  // BOTH HALVES OF THE FIX ARE INDEPENDENTLY SUFFICIENT, AND THAT IS WHY THIS
  // SOURCE ARM EXISTS. Measured: reverting BOTH turns the two tests above red;
  // reverting EITHER ONE leaves all five green, because `_origFetch` never
  // reaches the interceptor and the skip list never lets the interceptor act.
  // So no behavioural test can hold either guard on its own, and a reader who
  // deletes one on the evidence of a passing suite is right about the suite and
  // wrong about the platform the day somebody touches the other.
  test("v8.10.3: the escape hatch bypasses the interceptor AND the interceptor skips the escape hatch", () => {
    const fs = require("fs"), path = require("path");
    const root = path.join(__dirname, "..");
    const imp = fs.readFileSync(path.join(root, "public/js/features/impersonation.js"), "utf8");
    const api = fs.readFileSync(path.join(root, "public/js/core/api.js"), "utf8");

    expect(imp, "the session-transition POST must use the UNintercepted fetch")
      .toMatch(/_sessionTransitionPost[\s\S]{0,600}?_origFetch\(url,/);
    expect(imp, "and both doors must go through it")
      .toMatch(/_sessionTransitionPost\("\/api\/impersonation\/exit"\)/);
    // v8.12.1 — the entry carries an optional JSON body (`{view}` for an event
    // admin target); the subject is unchanged — it must still go THROUGH the
    // unintercepted door — so the arm admits the second argument.
    expect(imp, "including the entry, which regenerates the session too")
      .toMatch(/_sessionTransitionPost\(`\/api\/admin\/participants\/\$\{encodeURIComponent\(userId\)\}\/impersonate`(,[^)]*)?\)/);
    // v8.12.1 — and the view toggle, the third session-regenerating door and
    // under impersonation the in-session view switch (ui/nav.js).
    const nav = fs.readFileSync(path.join(root, "public/js/ui/nav.js"), "utf8");
    expect(nav, "toggleAdminView goes through the unintercepted door too")
      .toMatch(/_sessionTransitionPost\('\/api\/toggle-admin-view'/);
    // Neither door may go back to the intercepted global.
    expect(imp.includes('await fetch("/api/impersonation/exit"'),
      "exitImpersonation must not call the intercepted fetch again").toBe(false);

    const skip = api.match(/const skipPaths = \[([\s\S]*?)\];/);
    expect(skip, "the interceptor still has a skip list").toBeTruthy();
    for (const p of ["/api/impersonation/exit", "/impersonate", "/navigated-away", "/api/toggle-admin-view"]) {
      expect(skip[1], `${p} must be on the interceptor's skip list`).toContain(p);
    }
    // ANTI-VACUITY: a renamed constant would empty both matches above in silence.
    expect(skip[1].split(",").length, "the skip list is still a real list").toBeGreaterThanOrEqual(8);
  });

  test("v8.10.3: an Exit the server REFUSES still leaves the impersonated view instead of hanging", async ({ page }) => {
    const posts = [];
    page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/")) posts.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });

    await intoChallengeAsImpersonatedParticipant(page);

    // A token that is present and WRONG, so the pre-flight refresh above does not
    // fire and the refusal really reaches the interceptor. The session is then
    // destroyed by the server's own EBADCSRFTOKEN handler, which is by design —
    // so landing on the login card is the honest outcome. What must not happen is
    // being left on the impersonated page with nothing to click.
    await page.evaluate(() => { window.S.csrfToken = "not-the-stored-token"; });
    posts.length = 0;

    await page.locator(".impersonation-banner [data-action='impersonation-exit'], .impersonation-banner button")
      .first().click();
    await page.waitForTimeout(4000);

    await expect(page.locator(".impersonation-banner")).toHaveCount(0);
    expect(new URL(page.url()).pathname, "the escape hatch navigated").toBe("/");
    // The redundant logout is gone too: the session is already being destroyed by
    // the server, and a second POST only adds an unattributed line to the log.
    expect(posts.filter(u => u.includes("/api/logout")),
      "no piling-on logout for a request that IS the session transition").toEqual([]);

    // v8.13.4 — and the window is CLOSED on the target. The refusal has always
    // destroyed an impersonation session (it carries the target's userId), but
    // with no `impersonation_ended`, so the participant's History kept a window
    // that never ended. Exactly one: the client's one retry meets a fresh
    // anonymous session (400 "Not impersonating") and finds nothing to close.
    const { api: sa2 } = await apiLogin("superadmin");
    try {
      const j = await (await sa2.get(`/api/admin/participants/${participant.id}/events?limit=200`)).json();
      const evs = Array.isArray(j) ? j : (j.events || []);
      const closed = evs.filter(e => e.event_type === "impersonation_ended" && e.details && e.details.reason === "csrf_invalid");
      expect(closed.length, "the refused Exit closed the window exactly once").toBe(1);
      expect(closed[0].changed_by, "attributed to the acting superadmin").toBe("superadmin");
    } finally { await sa2.dispose(); }
  });
});
