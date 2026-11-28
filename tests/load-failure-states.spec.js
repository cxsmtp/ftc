// @ts-check
//
// v7.23.5 (audit Wave 5) — every list surface must REPORT a failed load, never
// dress it up as "there is no data".
//
// This started as a throwaway harness and earned a permanent place: driving all
// eleven surfaces with their data request forced to 500 found that EIGHT
// mishandled it, in four distinct ways, where the audit's prose had named about
// four. The source explains the gap — 21 loaders across 12 files, and 8 of those
// files had no failure branch at all.
//
// What was measured before the fix:
//   admin/participants   "No participants yet."      <- FALSE CLAIM
//   admin/submissions    "No submissions yet."       <- FALSE CLAIM
//   admin/rankings       header + "No participants yet.", and
//                        "board.filter is not a function"
//   admin/competitions   blank, "rows.slice is not a function"
//   admin/logs           5 skeleton rows shimmering for ever
//   participant/picker   completely blank — no text, no toast, no spinner, and
//                        its poll starts AFTER the early return, so no recovery
//   admin/analytics      the bare token "Boom" AND, simultaneously, "No challenge
//                        activity in the selected window."
//
// THE ASSERTION IS DELIBERATELY A PROPERTY, NOT A STRING: the surface must admit
// the failure, and must NOT render an empty-state claim. Pinning exact copy would
// break on every wording change and would not have caught "Boom", which admits
// nothing while matching no empty-state pattern either.
const { test, expect } = require("./isolated-test");
const { BASE, getSuperadminPass, PARTICIPANT_PASS, codeLogin } = require("./helpers");

// v8.7.5 — resolve an admin tab by its `data-tab-id`, never by its visible
// label: the sidebar's Events tab keeps the id `admin-competitions-tab` (ids are
// identifiers) while the label is copy and moves. Mirrors TAB_SLUG in
// tests/ui-admin-helpers.js.
const _TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions" };
const _tabSel = (n) => `button.admin-nav-item[data-tab-id="admin-${_TAB_SLUG[String(n).toLowerCase()] || String(n).toLowerCase()}-tab"]`;


test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

async function login(page, email, pass) {
  const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const r = await codeLogin(page.request, email, H(t), { password: pass });
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy();
}

// Read what the user is actually left with — `innerText`, which respects
// rendering, NOT textContent.
//
// The distinction is load-bearing in both directions. textContent includes
// `display:none` subtrees, so the analytics fix (which HIDES the "No challenge
// activity" line on a failure rather than deleting it) still read as a false
// claim and failed this test against correct code. And a message the user cannot
// see is not a message: counting a hidden one as "the app admitted the failure"
// would be the vacuous direction of the same mistake.
function readSurface() {
  return (sel) => {
    const el = document.querySelector(sel);
    const txt = el ? (el.innerText || "").trim() : "";
    return {
      found: !!el,
      skeletons: el ? el.querySelectorAll(".skeleton, .skeleton-row, .skeleton-line").length : -1,
      admits: /could not|failed to|unable to|network error|try again/i.test(txt),
      // The empty-state claims this product actually makes. Each is a real string
      // from the codebase, so a new one has to be added here deliberately.
      falseClaim: /no participants yet|no submissions yet|no challenge activity|no events found|no challenges found|no history available|no open alerts|no platform users yet|no templates yet|no one on the team yet|nobody has joined yet|no events started in this range/i.test(txt),
      text: txt.replace(/\s+/g, " ").slice(0, 160),
    };
  };
}

const ADMIN = [
  ["competitions", "**/api/admin/competitions*", "Events", "admin-competitions-tab", "#admin-competitions-tab"],
  ["participants", "**/api/admin/participants*", "Participants", "admin-participants-tab", "#admin-participants-tab"],
  ["submissions",  "**/api/admin/submissions*",  "Submissions",  "admin-submissions-tab",  "#admin-submissions-tab"],
  ["audit",        "**/api/admin/audit*",        "Audit",        "admin-audit-tab",        "#admin-audit-tab"],
  // v8.2.3 — the Rankings tab needs a PRECONDITION, and without it this test was
  // asserting on a pane that had issued no request at all.
  //
  // `loadAdminRankingsTab` picks the live competitions out of
  // `S.adminCompetitionsData`; with nothing selected and that model still empty
  // it short-circuits to "No live competitions" and never calls
  // `/api/admin/leaderboard` — so there is no failed load to admit, and nothing
  // re-enters the tab when the model arrives moments later. That is the state
  // the flake caught: `Screen said: "Select a Live Event No live
  // competitions…"`. The model is filled asynchronously by the boot poll, so
  // whether the tab click wins the race is machine load — the v7.22.x `viewComp`
  // class, on a different surface.
  ["rankings",     "**/api/admin/leaderboard*",  "Rankings",     "admin-rankings-tab",     "#admin-rankings-tab",
    async (page) => {
      await expect.poll(
        () => page.evaluate(() => ((window.S && window.S.adminCompetitionsData) || []).some(c => window.computeCompStatus(c) === "live")),
        { timeout: 20000, message: "the seeded LIVE competition must be in the admin model before Rankings is entered, or the tab short-circuits and issues no request" },
      ).toBe(true);
      // Re-enter now the precondition holds. Braces = fire-and-forget: the poll
      // below is what waits for the result (v7.21.15 — `page.evaluate` AWAITS a
      // returned promise, which would serialise the load and hide the race).
      await page.evaluate(() => { window.loadAdminRankingsTab(); });
    }],
  ["logs",         "**/api/admin/logs*",         "Logs",         "admin-logs-tab",         "#admin-logs-tab"],
  // v8.1.0 — Analytics no longer loads on entry: with no focused competition it
  // prompts for a scope and issues nothing (PR 21). So there is no failed load to
  // admit until a scope is chosen, and the pane must be driven one step further
  // to reach the state this test is about. Taking the prompt's own action keeps
  // it on a path a human can take; the `if` means a build that went back to
  // auto-querying still exercises the same assertions.
  ["analytics",    "**/api/admin/analytics/challenges*", "Analytics", "admin-analytics-tab", "#admin-analytics-tab",
    async (page) => {
      const b = page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="global"]');
      await expect.poll(async () => (await b.count()) > 0
        || (await page.locator("#analytics-summary").innerText().catch(() => "")).trim().length > 0,
        { timeout: 20000 }).toBe(true);
      if (await b.count()) await b.click();
    }],
  ["challenges",   "**/api/admin/tasks*",        "Challenges",   "admin-tasks-tab",        "#admin-tasks-tab"],
  // The Marketing page (features/marketing-admin.js): one read, on entry.
  ["marketing",    "**/api/admin/analytics/marketing*", "Marketing", "admin-marketing-tab", "#admin-marketing-tab"],
  // v8.3.33 — Settings was the ONE admin pane this table omitted, and it was the
  // one that was broken: `loadAdminSettings` answered a failed load with a toast
  // and nothing in the pane, the only such loader in the SPA. Worse than blank —
  // it left the CxOne card standing in its "Not configured" shape over a config
  // it had failed to READ, and `saveCxOneSettings` posts `cxone_group_name`
  // unconditionally, so a superadmin who pasted a key and saved would silently
  // clear the configured group.
  ["settings",     "**/api/admin/settings*",     "Settings",     "admin-settings-tab",     "#admin-settings-tab"],
  // v8.12.7 — the Checkmarx One account-removals card is its OWN loader inside
  // the Settings pane, and the card is hidden until it has something to say. A
  // failed read must SHOW the card with the failure, not leave it hidden: a
  // hidden card tells a superadmin nothing is waiting to be removed, which we do
  // not know. The container is the card, so the Settings row's success (the
  // other cards) cannot satisfy this one.
  // Settings is two panes (one section on screen), so each card's own row picks
  // its section after entering the tab.
  ["cxone removals", "**/api/admin/cxone/withdrawals*", "Settings", "admin-settings-tab",  "#cxone-withdrawals-card",
    async (page) => require("./ui-admin-helpers").openSettingsSection(page, "cxone-audit")],
  // The Data & retention and Alerts sections' own loaders: a failed read is said
  // in the card, never an empty "kept for —" or "No open alerts".
  ["retention",    "**/api/admin/retention*",    "Settings",     "admin-settings-tab",     "#retention-card",
    async (page) => require("./ui-admin-helpers").openSettingsSection(page, "general")],
  ["alerts",       "**/api/admin/alerts*",       "Settings",     "admin-settings-tab",     "#alerts-card",
    async (page) => require("./ui-admin-helpers").openSettingsSection(page, "general")],
  // The panes and workspace parts that came later, each with its own failure
  // branch: a 500 must never read as "no users", "no templates", an empty team
  // or an event nobody has joined.
  ["users and roles", "**/api/admin/users",    "Users",        "admin-users-tab",        "#admin-users-tab"],
  ["templates",    "**/api/admin/event-templates", "Templates",  "admin-templates-tab",    "#tpl-list"],
  ["team and reports", "**/api/admin/competitions/*/team", "Events", "admin-competitions-tab", "#ws-team",
    async (page) => {
      await require("./ui-admin-helpers").focusOwnLiveComp(page, "LF team");
      await page.locator("#ws-tabs [data-section='admin-event-team-tab']").click();
    }],
  ["overview live parts", "**/api/admin/competitions/*/overview-pulse", "Events", "admin-competitions-tab", "#ws-ov-progress",
    async (page) => require("./ui-admin-helpers").focusOwnLiveComp(page, "LF pulse")],
  // The workspace's Certificates section holds two loaders, each with its own
  // failure branch (public/js/features/certificate-wizard.js): the design and
  // the issued list. Each row fails ONE read, and its container is that read's
  // own card, so the other card's success cannot satisfy it. Abort, Try again
  // and recovery: tests/certificate-pane-load-failure.spec.js.
  ["certificate design", "**/api/admin/competitions/*/certificate-config", "Events", "admin-competitions-tab", "#ws-certs-design",
    async (page) => {
      await require("./ui-admin-helpers").focusOwnLiveComp(page, "LF cert design");
      await page.locator("#ws-tabs [data-section='admin-event-certs-tab']").click();
    }],
  ["issued certificates", "**/api/admin/competitions/*/certificates", "Events", "admin-competitions-tab", "#ws-certs-issued",
    async (page) => {
      await require("./ui-admin-helpers").focusOwnLiveComp(page, "LF cert issued");
      await page.locator("#ws-tabs [data-section='admin-event-certs-tab']").click();
    }],
];

for (const [name, apiGlob, navLabel, tabId, container, afterEnter] of ADMIN) {
  test(`v7.23.5: admin/${name} reports a failed load instead of claiming there is no data`, async ({ page }) => {
    const threw = [];
    page.on("pageerror", (e) => threw.push(e.message.slice(0, 100)));
    await login(page, "superadmin", getSuperadminPass());
    await page.route(apiGlob, (r) =>
      r.request().method() === "GET"
        ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
        : r.continue());

    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    const ham = page.locator("#admin-mobile-menu-btn");
    if (await ham.isVisible().catch(() => false) && !(await page.locator("#admin-sidebar.mobile-open").count())) await ham.click();
    // RBAC sidebar — Submissions and Logs have no sidebar item (Audit covers both).
    if (tabId === "admin-submissions-tab" || tabId === "admin-logs-tab") await page.evaluate((id) => window.adminTab(null, id), tabId);
    else await page.locator(_tabSel(navLabel)).first().evaluate((el) => el.click());
    await page.locator(`#${tabId}`).waitFor({ state: "visible", timeout: 20000 });
    if (afterEnter) await afterEnter(page);

    // Poll: the message arrives when the request settles, and several of these
    // panes fire more than one request.
    let r = null;
    for (let i = 0; i < 25; i++) {
      r = await page.evaluate(readSurface(), container);
      if (r.admits) break;
      await page.waitForTimeout(300);
    }
    expect(r.found, `${container} must exist, or this test is vacuous`).toBe(true);
    // v8.12.7 (review) — AND BE ON SCREEN. `innerText` on a `display:none`
    // element falls back to its textContent, so a failure branch that renders
    // the message and then HIDES its own container still "admitted" the failure
    // here. That is the exact defect the cxone-removals row exists to catch (the
    // card is the element its loader shows or hides), so without this it passed
    // against a build that hid the card. Every other row's container is its tab
    // pane, which the wait above has already proved visible.
    await expect(page.locator(container), `${container} must be ON SCREEN — a failure message inside a hidden container tells the admin nothing`)
      .toBeVisible();
    expect(r.admits, `admin/${name} did not admit the failure. Screen said: ${JSON.stringify(r.text)}`).toBe(true);
    expect(r.falseClaim, `admin/${name} showed an EMPTY-STATE claim for a FAILED request: ${JSON.stringify(r.text)}`).toBe(false);
    expect(r.skeletons, `admin/${name} left skeletons up: ${r.skeletons}`).toBe(0);
    // v8.12.6 (review) — a failed load must also release the loading spinner it
    // raised: the participants loader returned from its failure branch without
    // `hideLoading()`, so the spinner stayed up for the rest of the session.
    await expect(page.locator("#loading-overlay"), `admin/${name} left the loading spinner up after the failure`)
      .not.toHaveClass(/\bactive\b/, { timeout: 5000 });
    // A non-array error body reaching .filter/.slice/spread is the other half of
    // this defect class — reporting the failure while leaving the model slot
    // holding an object keeps every downstream TypeError in place.
    expect(threw.filter((m) => /is not a function|not iterable/i.test(m)),
      `admin/${name} threw on the error body: ${threw.join(" | ")}`).toEqual([]);
  });
}

test("v7.23.5: the participant competition picker reports a failure AND keeps polling", async ({ page }) => {
  // NOT alice: the seed gives her an active competition, so boot routes straight
  // past the picker and measuring it there is vacuous — which is exactly what the
  // first version of this harness did.
  //
  // v8.3.12 — and NOT carol either, for a second reason that arrived later. The
  // seed gives her exactly ONE competition, and a sign-in now lands a
  // single-event participant inside it (the sole-event landing rule), so the
  // picker is again never rendered. BOB is the one that works: the seed puts him
  // in TWO (live + upcoming) so there is a choice to make, and his marker is NULL
  // post-seed so nothing is resumed either. Both halves are needed — one event
  // lands, and a marker resumes.
  const threw = [];
  page.on("pageerror", (e) => threw.push(e.message.slice(0, 100)));
  await login(page, "bob@acme.com", PARTICIPANT_PASS);

  // v8.3.13 — ESTABLISH THE PRECONDITION INSTEAD OF ASSUMING IT. This test needs
  // the PICKER, and bob is a shared seeded participant: anything earlier can have
  // left `users.active_competition_id` set on him, and since v8.3.12 a sign-in
  // RESUMES that — so boot routed to `tasks-page` and `#comp-grid` was never
  // rendered. Its own diagnostic named it on the first occurrence:
  // `{"activePage":"tasks-page","sessionComp":"2d294353-…"}`.
  //
  // `POST /api/deselect-competition` is the platform's own "show me the event
  // list" action and is exactly what this test wants: it clears the session
  // pointer AND the durable marker, and stamps `left_event_at` so the sole-event
  // landing rule does not put him straight back either. Precise, and it holds
  // whatever an earlier test left behind.
  {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const d = await page.request.post("/api/deselect-competition", { headers: { "x-csrf-token": csrfToken } });
    expect(d.ok(), `deselect so the picker is where boot lands: ${await d.text()}`).toBeTruthy();
  }

  await page.route("**/api/my-competitions*", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
      : r.continue());
  await page.goto("/");

  // v8.3.13 — WAIT FOR BOOT TO SETTLE, then poll the surface. The loop below is a
  // 7.5-second budget for the picker to admit a failure, and under a loaded
  // WORKERS=8 run boot itself can still be in flight when it starts — so the
  // failure read `Screen said: ""`, i.e. nothing had rendered at all, which is a
  // different thing from "the picker did not admit the failure" and names none of
  // it. Settle on the app having ROUTED (v7.21.38: a settle signal must be
  // something that cannot be true before this entry's JS has run).
  // THE PICKER SPECIFICALLY, not "any page". `#comp-grid` lives on
  // `#competitions-page`, so settling on tasks-page or pending-page would leave
  // the poll below reading an empty grid on a screen that was never going to have
  // one — which is exactly the shape of the failure this test kept producing
  // ("Screen said: \"\""), and it names none of it.
  await page.waitForFunction(
    () => !!document.querySelector("#competitions-page.active"),
    null, { timeout: 30000 },
  ).catch(() => {});

  let r = null;
  for (let i = 0; i < 40; i++) {
    r = await page.evaluate(readSurface(), "#comp-grid");
    if (r.admits) break;
    await page.waitForTimeout(300);
  }
  // v8.3.13 — SAY WHICH OF THE FOUR THINGS WENT WRONG. `Screen said: ""` is
  // equally true of: boot never routed; it routed somewhere ELSE (which is what
  // the sole-event landing rule can now do to a participant with one event, so
  // the fixture matters); `loadMyCompetitions` never ran; and it ran and rendered
  // nothing. A bare empty string cannot distinguish them, and this flake has
  // already survived one round of hardening on that basis (v7.21.34: when a flake
  // survives a hardening, stop widening it and make it self-explaining).
  const diag = await page.evaluate(() => ({
    activePage: (document.querySelector(".page.active") || {}).id || "(none)",
    comps: (window.S && Array.isArray(window.S.myCompetitions)) ? window.S.myCompetitions.length : "(unset)",
    sessionComp: (window.S && window.S.currentUser && window.S.currentUser.competitionId) || null,
    gridHtml: ((document.querySelector("#comp-grid") || {}).innerHTML || "").slice(0, 200),
  })).catch(() => ({}));
  expect(r.admits,
    `the picker did not admit the failure. Screen said: ${JSON.stringify(r.text)} | ${JSON.stringify(diag)}`
  ).toBe(true);
  expect(r.falseClaim, `the picker claimed there are no competitions: ${JSON.stringify(r.text)}`).toBe(false);
  // This surface has NO poll until startCompDataPoll() runs, and that call sat
  // after the old early return — so a failed first load was terminal. A Retry
  // affordance is required here, unlike the admin tables which refresh on a 15 s
  // timer and self-heal.
  await expect(page.locator("#comp-grid [data-action=retry-load-my-competitions]"),
    "a surface with no poll must offer a way to retry").toHaveCount(1);
});

test("v7.23.5: the 4th toast does not land on top of the 3rd", async ({ page }) => {
  // The old placement was `bottom = 24 + offset*50` with `offset` read as the
  // SURVIVOR COUNT after evicting the oldest — so with survivors at 74 and 124
  // the fourth toast was placed at 24+2*50 = 124, exactly on the survivor, while
  // the 24 slot sat empty. Toasts carry no dismiss control and no history, so a
  // covered message is unrecoverable. Asserting DISTINCT rects rather than any
  // particular geometry, because the fix removed the arithmetic entirely.
  await login(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
  const rects = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const m of ["first message", "second message", "third message", "fourth message"]) {
      window.showToast(m, "error");
      await sleep(60);
    }
    // Wait out `toast-in` before measuring. It is 250ms of translateX(20px) +
    // scale(0.96) on cubic-bezier(0.34,1.56,0.64,1) — the >1 control point
    // OVERSHOOTS — so a rect read mid-flight is both offset and scaled, which
    // would make this overlap comparison report a position no toast ever
    // occupies. Proven, not theoretical: the sibling positioning lock in
    // ui-participant-b measured 375.98 against a 375px viewport this way.
    const toasts = [...document.querySelectorAll(".toast")];
    await Promise.all(toasts.flatMap((t) => t.getAnimations().map((a) => a.finished))).catch(() => {});
    return toasts.map((t) => {
      const r = t.getBoundingClientRect();
      return { text: (t.textContent || "").trim(), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });
  });
  expect(rects.length, "the stack must cap at 3 toasts").toBe(3);
  const tops = rects.map((r) => r.top);
  expect(new Set(tops).size, `two toasts occupy the same position: ${JSON.stringify(rects)}`).toBe(rects.length);
  // ...and none may overlap, which distinct tops alone would not prove.
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].top, `toasts overlap: ${JSON.stringify(sorted)}`).toBeGreaterThanOrEqual(sorted[i - 1].bottom);
  }
});

test("v7.23.5: a toast raised over a dialog is not buried behind the scrim", async ({ page }) => {
  // .toast was z-index 999 while EVERY dialog scrim is 3000-9600, so an error
  // raised while a dialog was open rendered behind it at ~2.2:1 and could not
  // even be hovered to pause its timer — elementFromPoint at the toast's centre
  // returned the overlay, so the v7.7.33 hover-pause handlers could never fire.
  await login(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
  const r = await page.evaluate(async () => {
    // Raise the shared confirm (the highest scrim a toast has to clear), then a toast.
    window.showModal({ title: "Test", message: "Scrim under test", confirmText: "OK" });
    await new Promise((res) => setTimeout(res, 250));
    window.showToast("an error the operator must be able to read", "error");
    await new Promise((res) => setTimeout(res, 250));
    const t = document.querySelector(".toast");
    const o = document.getElementById("modal-overlay");
    if (!t || !o) return { missing: true };
    const rect = t.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const z = (el) => parseInt(getComputedStyle(el).zIndex || "0", 10) || 0;
    return {
      toastZ: z(document.getElementById("toast-stack") || t),
      overlayZ: z(o),
      hitIsToast: !!(hit && (hit === t || t.contains(hit))),
    };
  });
  expect(r.missing, "both the modal and the toast must be present").toBeFalsy();
  expect(r.toastZ, `the toast stack (${r.toastZ}) must outrank the dialog scrim (${r.overlayZ})`).toBeGreaterThan(r.overlayZ);
  // The decisive one: a toast the pointer cannot reach cannot be hovered to pause,
  // which is the WCAG 2.2.1 affordance v7.7.33 added.
  expect(r.hitIsToast, "the point at the toast's centre must hit the TOAST, not the scrim").toBe(true);
});

test("the group Members dialog reports a failed load, and nothing renders into the closed dialog", async ({ page }) => {
  // Each opening's FIRST picker load passes unless planned otherwise; `plan`
  // decides the loads in order. After a failed RELOAD the dialog closed while
  // `picker` still held the previous page, and render() then wrote into the
  // removed overlay: "Cannot set properties of null". A response landing after the
  // admin pressed Close did the same.
  const threw = [];
  page.on("pageerror", (e) => threw.push(e.message.slice(0, 160)));
  await login(page, "superadmin", getSuperadminPass());
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const made = await page.request.post("/api/admin/groups", { headers: H(csrf), data: { name: `LoadFail_${Date.now()}` } });
  expect(made.ok(), `create group: ${made.status()}`).toBe(true);
  const gid = (await made.json()).group.id;
  const plan = [];
  let held = 0, release = null;
  try {
    await page.route(`**/api/admin/groups/${gid}/picker*`, async (route) => {
      const step = plan.shift() || "pass";
      if (step === "fail") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) });
      if (step === "abort") return route.abort();
      if (step.startsWith("hold")) {
        held++;
        await new Promise((r) => { release = r; });
        if (step === "hold-fail") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) });
      }
      return route.continue();
    });
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    await page.locator(_tabSel("groups")).first().evaluate((el) => el.click());
    const open = page.locator(`button[data-action='group-manage-members'][data-group-id='${gid}']`);
    await open.waitFor({ state: "visible", timeout: 20000 });
    const failToast = page.locator(".toast", { hasText: "Failed to load members." });
    const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
    const openLoaded = async () => {
      await open.click();
      // render() ran: it is what writes the member count.
      await expect(page.locator("#gm-member-count")).toHaveText(/member\(s\)/);
    };

    // The first load fails: reported, and no dialog is left open.
    plan.push("fail");
    await open.click();
    await expect(failToast, "a failed first load is reported").toBeVisible();
    await expect(page.locator("#gm-members")).toHaveCount(0);

    // A failed or aborted RELOAD: reported, the dialog closes, nothing throws.
    for (const step of ["fail", "abort"]) {
      await clearToasts();
      await openLoaded();
      plan.push(step);
      await page.locator("#gm-search").fill("zz");
      await expect(failToast, `a reload that ends in "${step}" is reported`).toBeVisible();
      await expect(page.locator("#gm-members")).toHaveCount(0);
      await page.evaluate(() => 0);   // pageerror events arrive before this round trip
      expect(threw, `after a "${step}" reload: ${threw.join(" | ")}`).toEqual([]);
    }

    // A load that lands after the admin closed the dialog renders nothing, and a
    // failed one reports nothing: the admin abandoned it.
    for (const step of ["hold", "hold-fail"]) {
      await clearToasts();
      await openLoaded();
      held = 0;
      plan.push(step);
      await page.locator("#gm-search").fill("zz");
      await expect.poll(() => held).toBe(1);
      await page.locator("#gm-close").click();
      await expect(page.locator("#gm-members")).toHaveCount(0);
      const settled = page.waitForEvent(step === "hold" ? "requestfinished" : "response",
        (q) => q.url().includes(`/api/admin/groups/${gid}/picker`));
      release();
      await settled;
      // Witness that the abandoned load was handled: a reopened dialog's own first
      // load is requested after the late response finished, so the page handles it
      // later. Only then are the negatives read, once.
      await openLoaded();
      await page.evaluate(() => 0);   // pageerror events arrive before this round trip
      expect(threw, `after a late "${step}" load: ${threw.join(" | ")}`).toEqual([]);
      expect(await failToast.count(), `a late "${step}" load on a closed dialog is not reported`).toBe(0);
      await page.locator("#gm-close").click();
      await expect(page.locator("#gm-members")).toHaveCount(0);
    }
  } finally {
    if (release) release();
    await page.unroute(`**/api/admin/groups/${gid}/picker*`).catch(() => {});
    await page.request.delete(`/api/admin/groups/${gid}`, { headers: H(csrf) }).catch(() => {});
  }
});
