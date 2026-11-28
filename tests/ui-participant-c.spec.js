// @ts-check
//
// Split from ui-participant.spec.js in v7.21.37 — it was 118s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Avatar rendering · Reset-password page CSP compliance · LinkedIn error popup mapping · Challenge rich content — embedded links and images · Hint reveal — Trusted Types safe render · Help drawer · Participant accessibility — axe-core scan · Profile completion gate (v6.18.x) · v7.15.0 — participant leaderboard columns + sorting · v7.15.4 — a restart is reported as a restart, not as inactivity · Code-block syntax highlighting meets WCAG AA (v7.21.1)
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { fillBreakGlass, submitLogin, signUpViaUi } = require("./ui-admin-helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, codeLogin, appearanceSettled } = require("./helpers");

// v8.7.5 — resolve an admin tab by its `data-tab-id`, never by its visible
// label: the sidebar's Events tab keeps the id `admin-competitions-tab` (ids are
// identifiers) while the label is copy and moves. Mirrors TAB_SLUG in
// tests/ui-admin-helpers.js.
const _TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions" };
const _tabSel = (n) => `button.admin-nav-item[data-tab-id="admin-${_TAB_SLUG[String(n).toLowerCase()] || String(n).toLowerCase()}-tab"]`;


// Route page.goto() + page.request.* to this worker's server. See ui-admin.spec.js.
test.use({ baseURL: BASE });

// Since the short form (29 Oct 2026) no account owes Job function or City by
// default, so the gate specs below point the account at a Booth Event that
// REQUIRES both (the live registration pointer), which is the one way a missing
// job function still raises the gate. Created once per file.
let _gateEventId = null;
async function gateEventId() {
  if (_gateEventId) return _gateEventId;
  const { api, csrf } = await apiLogin("superadmin");
  const r = await api.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {
    name: `Gate fields ${Date.now()}`, event_kind: "booth", timezone: "UTC",
    start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
    registration_fields: { job_function: "required", city: "required" },
  } });
  expect(r.ok(), `gate event: ${await r.text()}`).toBeTruthy();
  _gateEventId = (await r.json()).competition.id;
  await api.dispose();
  return _gateEventId;
}

async function login(page, email, password = "") {
  await page.goto("/");
  await page.waitForSelector("#login-email", { timeout: 5000 });
  await page.fill("#login-email", email);
  await fillBreakGlass(page, password);
  await submitLogin(page);
}

// See ui-admin.spec.js for rationale — one retry with a fresh password read
// absorbs a password rotation landing between getSuperadminPass() and POST.
async function loginViaApi(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  // v7.15.16 — see the twin in ui-admin.spec.js: retry a THROWN transient
  // (ECONNRESET under WORKERS=8) as well as a non-ok response.
  const tryPost = async (pw) => {
    try { return { r: await doPost(pw) }; }
    catch (e) { return { err: e }; }
  };
  let { r, err } = await tryPost(password);
  if (r && r.ok()) return;
  await new Promise(res => setTimeout(res, 300));
  const pw2 = email === "superadmin" ? getSuperadminPass() : password;
  ({ r, err } = await tryPost(pw2));
  if (r && r.ok()) return;
  if (!r) throw new Error(`loginViaApi(${email}) failed: ${err && err.message}`);
  // v7.22.0 — say WHY, using the SAME probe apiLogin uses. `401 {"error":
  // "Invalid email or password"}` is the deliberate anti-enumeration answer for
  // six different account states, so on its own it names none of them — and this
  // path had no diagnostic at all, which is why two v7.22.0 occurrences of the
  // class each cost a fresh investigation.
  throw new Error(`loginViaApi(${email}) failed: ${r.status()} ${await r.text()}`
    + await require("./helpers").describeAccountState(email, password));
}

// Test-robustness helper (v6.3.1): clear `users.active_competition_id` for a
// given email directly in the DB. Prevents the login auto-resume path from
// routing the next `page.goto("/")` into whichever competition a PRIOR test
// may have dropped the user into. Without this, a test that asserts "lands
// on the picker" is flaky under high-worker-count runs — an earlier test's
// successful select-competition on the same participant leaks through
// because active_competition_id is persisted user-level, not per-session.
//
// The server's own DELETE /api/admin/competitions/:id/users/:uid endpoint
// clears active_competition_id ONLY when it matches the comp being removed
// from (server.js ~5102). A test that needs a guaranteed-clean picker entry
// can't rely on that — it would need to discover what comp is "active" and
// remove from that one. Direct DB UPDATE is simpler, local to the test,
// and doesn't require introducing a new admin API surface.
function _resetActiveCompetition(email) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    db.prepare("UPDATE users SET active_competition_id=NULL WHERE email=?").run(email);
  } finally {
    db.close();
  }
}

// v6.20.x — shared E2E factory: create an approved, password-set participant
// and assign them to `compId`. Returns { id, email }. Uses the superadmin API
// (caller supplies a logged-in `sa` context + headers `h`). This is the
// reusable primitive the participant-flow E2E tests are built on — it replaces
// the ad-hoc register+verify+approve+reset blocks that several tests copy-paste.
async function createAssignedParticipant(sa, h, compId, opts = {}) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const email = opts.email || `e2e_${stamp}@acme.com`;
  const { api: anon, csrf: anonCsrf } = await freshCtx();
  await registerPost(anon, "/api/register", {
    headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
    data: {
      firstName: "E2E", lastName: "User", nickname: opts.nickname || `e2e_${stamp}`,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", email,
    },
  });
  await anon.dispose();
  const parts = (await (await sa.get("/api/admin/participants?limit=2000")).json()).participants;
  const me = parts.find(p => p.email === email);
  expect(me, `participant ${email} created`).toBeTruthy();
  await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
  await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
  if (compId) {
    await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [me.id], competitionIds: [compId] } });
  }
  return { id: me.id, email };
}

// v6.20.x — log `page` in AS the given participant, pre-select `compId` via the
// request context (so the SPA skips the picker on load), then land on the
// in-app shell. Waits on the Challenges nav button — the reliable "live comp is
// active" signal (auto-resume may land on the picker OR tasks page, but the nav
// button appears whenever a live/ended comp is selected). This is the exact
// proven sequence from the navigated_away tests; using #tasks-page.active as the
// wait target is what made earlier ad-hoc attempts flaky.
async function enterCompAsParticipant(page, email, compId) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: compId },
  });
  await page.goto("/");
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
}

// Per-tab body selector used by clickTab() / adminLogin() to wait for real
// data to render before the test pokes at the DOM.
const TAB_BODY = {
  competitions: "#admin-comp-body tr",
  tasks: "#admin-task-body tr",
  participants: "#admin-participants-body tr",
  submissions: "#admin-submissions-body tr",
  rankings: "#admin-rankings-body tr",
  logs: "#admin-logs-tab tbody tr",
};

async function adminLogin(page) {
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator(TAB_BODY.competitions).first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
}

async function participantLogin(page) {
  await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#comp-grid .comp-card, .nav-btn").first().waitFor({ state: "visible", timeout: 30000 });
}

/** Click an admin tab by name and wait for the sub-pane + first data row. */
async function clickTab(page, name) {
  // On mobile the sidebar is fixed off-screen. Open it via the hamburger button
  // (which IS in the viewport at narrow widths), wait for the slide-in, then click.
  // Only while the drawer is CLOSED: since v8.12.6 the button sits below the open
  // drawer's scrim, so clicking it then fails actionability instead of re-opening.
  const hamburger = page.locator("#admin-mobile-menu-btn");
  if (await hamburger.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await hamburger.click();
  const btn = page.locator(_tabSel(name)).first();
  // Use locator.evaluate to fire the click inside the page context, bypassing
  // Playwright's "must be in viewport" actionability check (the event delegation
  // at document level handles clicks regardless of position).
  await btn.waitFor({ state: "attached" });
  await btn.evaluate((el) => el.click());
  const slug = _TAB_SLUG[name.toLowerCase()] || name.toLowerCase();
  await page.locator(`#admin-${slug}-tab`).waitFor({ state: "visible", timeout: 5000 });
  const bodySel = TAB_BODY[slug];
  if (bodySel) {
    await page.locator(bodySel).first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
  }
}

/** Scope to a competition by clicking its name cell (same as old "View" button) */
async function viewComp(page, name) {
  await page.locator(`#admin-comp-body tr:has-text('${name}') td`).first().click();
  await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 5000 });
}

/** Open the kebab on a row-like locator and wait for the portal menu to render. */
async function openKebab(page, row) {
  await row.locator(".kebab-btn").first().click();
  await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
}

/**
 * Select the first competition card (if a picker is shown) and click the
 * given nav button. Waits deterministically for the nav button to render
 * before clicking — no fixed delays.
 */
async function enterCompAndNav(page, navText) {
  // v7.21.38 — WAIT FOR THE APP TO SETTLE BEFORE DECIDING WHICH VIEW IT IS IN.
  // `card.isVisible()` is a point-in-time check with no wait: while the picker
  // is still loading it answers false, the click is skipped, the participant
  // never enters a competition, and the nav button therefore never appears —
  // surfacing 10 s later as `locator.waitFor: Timeout` on the NAV, which names
  // nothing about the cause. That is the v7.21.1 rule ("a long wait that ends
  // in nothing means the wrong VIEW, not a slow one") applied to a helper.
  const navBtn = page.locator(`.nav-btn:not([aria-disabled=true]):has-text('${navText}')`).first();
  const anyCard = page.locator("#comp-grid .comp-card, [data-comp-id]").first();
  const seen = async (l) => l.isVisible().catch(() => false);
  await expect
    .poll(async () => (await seen(navBtn)) || (await seen(anyCard)),
      { timeout: 20000, message: "neither the competition picker nor the participant nav ever rendered" })
    .toBe(true);
  if (!(await seen(navBtn))) {
    // v7.22.0 — ENTER A COMPETITION THAT HAS THESE TABS.
    //
    // `updateParticipantNav()` reveals #nav-challenges / #nav-leaderboard only
    // when the entered competition is live or ended (ui/nav.js: `showCompTabs =
    // status==='live'||status==='ended'`). The picker's default filter hides
    // ENDED competitions, so the visible cards are live + UPCOMING — and this
    // used to click `.first()`, on a grid that accumulates a competition per
    // fixture from every earlier test in the file. Land on an upcoming one and
    // the nav button never appears at all: the wait then burns its full 15 s and
    // reports "33 x locator resolved to hidden", naming the button rather than
    // the reason. Prefer a card that actually carries the tabs.
    const live = page.locator('#comp-grid .comp-card[data-status="live"]').first();
    const ended = page.locator('#comp-grid .comp-card[data-status="ended"]').first();
    // v8.1.0 — SHOW THE ENDED ONES BEFORE FALLING BACK TO THEM. The picker
    // defaults to "Active & Upcoming", so an ended competition is not in the grid
    // at all — which made the `ended` fallback above unreachable and dropped the
    // choice through to `anyCard`, i.e. an UPCOMING competition, whose pending
    // page carries no Challenges tab. Diagnosed from this helper's own dump:
    // `not-shown (page=pending-page, ..., status=upcoming)`. Exactly the admin
    // status-chip defect (v8.1.0, viewComp) one layer over.
    if (!(await seen(live)) && !(await seen(ended))) {
      const all = page.locator('#comp-filters [data-action="set-comp-filter"][data-value="all"]');
      if (await seen(all)) {
        await all.click();
        await expect.poll(async () => (await seen(live)) || (await seen(ended)) || (await seen(anyCard)),
          { timeout: 10000 }).toBe(true);
      }
    }
    const target = (await seen(live)) ? live : (await seen(ended)) ? ended : anyCard;
    await target.click();
    // Picking a DIFFERENT competition while one is already active raises a
    // "Leave Event?" confirm, which swallows the click — the participant
    // never enters, so the tab never appears and the wait below burns its full
    // budget naming only the button. Whether the modal appears depends on the
    // ambient active_competition_id, i.e. on what ran before.
    //
    // v8.3.22 — WAIT FOR IT, do not sample for it. This was a bare
    // `isVisible()`, which is the very point-in-time check this helper's own
    // header warns about for the CARD: the modal is raised by JS AFTER the
    // click, so the sample lost the race, the confirm was skipped, and the modal
    // then intercepted the nav click below — surfacing as a 60 s timeout whose
    // call log reads `<div id="modal-overlay"> intercepts pointer events` and
    // names nothing about a competition switch. Settle into one of two states
    // instead: the confirm is up, or the nav already is.
    const confirmBtn = page.locator("#modal-confirm-btn");
    await expect
      .poll(async () => (await seen(confirmBtn)) || (await seen(navBtn)),
        { timeout: 10000, message: "after picking a competition, neither the confirm modal nor the nav appeared" })
      .toBe(true);
    if (await seen(confirmBtn)) {
      await confirmBtn.click();
      // And wait for the scrim to actually go: the click resolves the promise,
      // but the overlay is removed a tick later and still eats a nav click.
      await page.locator("#modal-overlay").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
    }
  }
  // Report the VIEW on failure. "33 x locator resolved to hidden" says the tab
  // is not shown; it does not say that the app is sitting on the picker, or on
  // the pending page of an UPCOMING competition (updateParticipantNav only
  // reveals these tabs for live/ended) — which is the actual answer.
  await expect.poll(async () => (await seen(navBtn)) ? "shown" : await page.evaluate(() => {
    const active = document.querySelector(".page.active");
    return `not-shown (page=${active ? active.id : "none"}, comp=${window.S?.currentCompetitionId || "none"}, status=${window.S?.currentCompStatus || "none"})`;
  }), { timeout: 15000, message: `the ${navText} tab never appeared` }).toBe("shown");
  await navBtn.click();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
// v7.21.37 — hoisted here from between two describes so the file can be
// split: a binding declared outside every describe belongs to whichever
// part inherits it, and the others fail with a bare ReferenceError.
const { AxeBuilder } = require("@axe-core/playwright");
// Gate tightened from serious+ to moderate+ in v6.8.4 — moderate violations
// include medium-severity colour-contrast and aria issues worth surfacing.
const AXE_GATED_IMPACTS = new Set(["moderate", "serious", "critical"]);



// ═══════════════════════════════════════════════════════════════════════════════
// AVATAR & VERSION
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Avatar rendering", () => {
  test("emoji avatars in participants list", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    expect(await page.locator("td span:has-text('🦊')").count()).toBeGreaterThan(0);
  });
});








// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE RICH CONTENT — embedded hyperlinks + images
// ═══════════════════════════════════════════════════════════════════════════════
//
// Authors paste images directly into the rich-text editor (as data:image/...
// URIs) and insert hyperlinks via the link toolbar (as <a href="https://…">).
// The server's processRichText() pipeline:
//   • sanitiseRichText(html) — drops disallowed tags/attrs, forces target=_blank
//     + rel=noopener noreferrer on every <a>, accepts only data:image/ or
//     /api/images/ src on <img>, adds style="max-width:100%" to images.
//   • extractAndStoreImages(html) — for every <img src="data:image/...">,
//     stores the binary in the `images` table and rewrites src to
//     /api/images/<uuid>.
// Then the participant's openTask(id) flow renders the description through
// renderRich(), which whitelists <a> (href|target|rel) and <img> (src|alt|
// width|height) and re-validates the URL protocol against
// (?:https?:|data:image/|/api/images/).
//
// These tests prove the round-trip end-to-end:
//   1. POST a description containing one inline link + one base64-pasted image.
//   2. Verify the API response (which is what participants see) has
//      • <a> with href intact + target="_blank" + rel="noopener noreferrer"
//      • <img> with src rewritten to /api/images/<uuid>
//   3. Verify the image bytes round-trip through GET /api/images/<id>
//      with the original Content-Type.
//   4. Render the task in a real browser (Playwright) and assert the same
//      attributes survive client-side renderRich() sanitization.

test.describe("Challenge rich content — embedded links and images", () => {
  // Smallest valid PNG — 1×1 transparent pixel. Used both directly in <img src="data:..."/>
  // and to verify the resulting /api/images/<id> response matches.
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

  test("API: <a href> survives sanitization with target=_blank + rel attrs", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqTitle = "RichLink-" + Date.now();
    const linkHref = "https://example.com/docs?ref=test";
    const description = `<p>Visit <a href="${linkHref}">our documentation</a> for setup details.</p>`;
    const create = await api.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: uniqTitle, description,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", hint: "—", status: "published",
      },
    });
    expect(create.ok()).toBeTruthy();
    const taskId = (await create.json()).id;
    // Read it back via the admin endpoint (returns the stored description verbatim).
    const fetched = await api.get(`/api/admin/tasks`);
    const tasks = await fetched.json();
    const t = tasks.find(x => x.id === taskId);
    expect(t).toBeTruthy();
    expect(t.description).toContain(`href="${linkHref}"`);
    expect(t.description).toContain(`target="_blank"`);
    expect(t.description).toContain(`rel="noopener noreferrer"`);
    // The displayed text wasn't dropped
    expect(t.description).toContain("our documentation");
    await api.dispose();
  });

  test("API: <img> data URI is extracted to /api/images/<uuid> and bytes round-trip", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqTitle = "RichImg-" + Date.now();
    const description = `<p>Diagram below:</p><p><img src="${TINY_PNG_DATA_URI}" alt="tiny"/></p>`;
    const create = await api.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: uniqTitle, description,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", hint: "—", status: "published",
      },
    });
    expect(create.ok()).toBeTruthy();
    const taskId = (await create.json()).id;
    const tasks = await (await api.get(`/api/admin/tasks`)).json();
    const t = tasks.find(x => x.id === taskId);
    expect(t).toBeTruthy();
    // Server replaced the data: URI with /api/images/<uuid>
    const m = t.description.match(/\/api\/images\/([\w-]+)/);
    expect(m, "extracted image URL not found").toBeTruthy();
    const imageId = m[1];
    // The original data URI must NOT remain in the stored description
    expect(t.description).not.toContain("data:image/png;base64,");
    // Server-side sanitizer adds style="max-width:100%" so the image scales
    expect(t.description).toContain('style="max-width:100%"');
    // GET /api/images/<id> returns the original PNG bytes with correct Content-Type
    const imgRes = await api.get(`/api/images/${imageId}`);
    expect(imgRes.ok()).toBeTruthy();
    expect(imgRes.headers()["content-type"]).toBe("image/png");
    const body = await imgRes.body();
    const expectedBytes = Buffer.from(TINY_PNG_BASE64, "base64");
    expect(Buffer.compare(body, expectedBytes)).toBe(0);
    // A browser keeps it for a day, no shared cache at all: a stored picture can
    // be deleted (tests/image-sweep.spec.js holds the header, the ETag and the 304).
    expect(imgRes.headers()["cache-control"]).toBe("private, max-age=86400");
    await api.dispose();
  });

  test("API: <img> with disallowed protocols is stripped (defence-in-depth)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqTitle = "RichBadImg-" + Date.now();
    // Two images: a javascript: URI (must be stripped) and a remote http URL
    // (also stripped — server only allows data:image/ or /api/images/).
    const description = `<p><img src="javascript:alert(1)"/></p><p><img src="https://attacker.example/evil.png"/></p>`;
    const create = await api.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: uniqTitle, description,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", hint: "—", status: "published",
      },
    });
    expect(create.ok()).toBeTruthy();
    const taskId = (await create.json()).id;
    const tasks = await (await api.get(`/api/admin/tasks`)).json();
    const t = tasks.find(x => x.id === taskId);
    expect(t).toBeTruthy();
    // Neither hostile src survives the server sanitizer
    expect(t.description).not.toContain("javascript:");
    expect(t.description).not.toContain("attacker.example");
    await api.dispose();
  });

  test("UI: rendered link is an <a target=_blank rel=noopener>, image renders with rewritten /api/images/ src", async ({ page, context }) => {
    // Set up the rich challenge via API and assign it to liveComp so Alice sees it.
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqTitle = "RichRender-" + Date.now();
    const linkHref = "https://example.com/learn-more";
    const linkText = "learn more";
    const description = `<p>Read about the API at <a href="${linkHref}">${linkText}</a>:</p><p><img src="${TINY_PNG_DATA_URI}" alt="logo"/></p>`;
    const create = await api.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: uniqTitle, description,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", hint: "—", status: "published",
      },
    });
    expect(create.ok()).toBeTruthy();
    let taskId = (await create.json()).id;

    // v8.3.5 — THIS TEST OWNS ITS COMPETITION, and that is the whole de-flake.
    //
    // It used to borrow the seeded "Test Live". v8.3.0 added a precondition
    // assertion because assignment is REFUSED once a competition has an ended
    // session, so a silently-skipped assign surfaced forty lines later as a card
    // that never appeared. The assertion worked — it fired again here, naming
    // `status=ended` — which is exactly the point at which the fixture, not the
    // message, is what needs fixing.
    //
    // THE MECHANISM, now that the in-file explanations are exhausted: nothing in
    // this file submits or ends anything, and the seed gives "Test Live" 180
    // minutes from 30 minutes ago, so neither the clock nor an in-file auto-end
    // can reach it. What CAN is the seed's own submits — `seedTestData` solves
    // `easy1` correctly as Alice in that competition, and the all-solved auto-end
    // fires on a submit whenever every scoring participant has solved every
    // published assigned challenge. That is one partially-applied seed away from
    // being true. Not claimed as proven; what IS certain is that the dependency
    // is unnecessary, and the fixture checklist's rule covers it either way: a
    // test that depends on an entity's lifecycle must own that entity.
    const own = await api.post("/api/admin/competitions", {
      headers: h,
      data: {
        name: `RichRender Live ${Date.now().toString(36)}`, timezone: "UTC",
        start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600,
      },
    });
    expect(own.ok(), `create the test's own live competition: ${await own.text()}`).toBeTruthy();
    const liveComp = (await own.json()).competition;

    // …AND ITS OWN PARTICIPANT, which is the other half.
    //
    // The first draft of this de-flake enrolled ALICE and pre-selected the new
    // competition on her session. That fixed this test and broke the two after it:
    // `select-competition` writes `users.active_competition_id`, so every later
    // test in the file booted into a competition holding one challenge and failed
    // on a `[data-task-id]` that was not there. Owning the competition is not
    // enough when the participant is shared — entering ANY competition mutates
    // her, so the only shape that leaves the file's other tests exactly as it
    // found them is a participant nobody else uses. (Fixture checklist, item 3.)
    const pLabel = `rr${Date.now().toString(36)}`;
    const pEmail = `${pLabel}@company.example`;
    const { api: reg, csrf: regCsrf } = await freshCtx();
    const rr = await registerPost(reg, "/api/register", {
      headers: { "x-csrf-token": regCsrf, "content-type": "application/json" },
      data: {
        firstName: "Rich", lastName: "Render", nickname: pLabel, email: pEmail,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      },
    });
    expect(rr.ok(), `register the test's own participant: ${await rr.text()}`).toBeTruthy();
    await reg.dispose();
    const all = await (await api.get("/api/admin/participants?limit=5000")).json();
    const mine = (all.participants || []).find(p => p.email === pEmail);
    expect(mine, `the new participant must be findable among ${(all.participants || []).length} rows`).toBeTruthy();
    // registerPost leaves its fixture state, unverified AND unapproved (a real
    // sign-up is neither); the assign endpoint
    // SILENTLY SKIPS both, so clear the lifecycle before enrolling or the
    // `assigned` count below is 0 for a reason unrelated to this test.
    for (const act of ["verify", "approve"]) {
      const r = await api.post(`/api/admin/participants/${mine.id}/${act}`, { headers: h, data: {} });
      expect(r.ok(), `${act} the new participant: ${await r.text()}`).toBeTruthy();
    }
    const assign = await api.post("/api/admin/competitions/assign", {
      headers: h, data: { userIds: [mine.id], competitionIds: [liveComp.id] },
    });
    // The assign endpoint SILENTLY SKIPS staff / benchmark / blocked / unapproved
    // users, so assert the count rather than the status — a skip would otherwise
    // surface as an empty picker much later.
    expect((await assign.json()).assigned, "the owned participant is enrolled").toBe(1);

    const asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: h, data: { competitionIds: [liveComp.id] },
    });
    expect(asg.ok(), `assign the rich challenge: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    taskId = (await asg.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is opened and answered there
    await api.dispose();

    // Pre-select on the OWNED participant's session before the browser loads —
    // the established shape (see ui-participant-a). Without it `enterCompAndNav`
    // meets the picker and an "Enter Live Event?" confirm.
    const { api: pPre, csrf: pPreCsrf } = await apiLogin(pEmail, PARTICIPANT_PASS);
    const sel = await pPre.post("/api/select-competition", {
      headers: { "x-csrf-token": pPreCsrf, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    expect(sel.ok(), `pre-select the owned competition: ${await sel.text()}`).toBeTruthy();
    await pPre.dispose();

    // Render in the browser as the owned participant — Alice is left untouched.
    await loginViaApi(page, pEmail, PARTICIPANT_PASS);
    await page.goto("/");
    await enterCompAndNav(page, "Challenges");
    // Click the new challenge — its title is unique
    const taskCard = page.locator(`.task-card:has-text("${uniqTitle}"), [data-task-id="${taskId}"]`).first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    await taskCard.click();
    // #task-detail-card renders the selected challenge's description — wait
    // for it to mount rather than a fixed delay.
    await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 5000 });
    // Description container is #task-detail-card. Find the rendered <a>.
    const link = page.locator(`#task-detail-card a[href="${linkHref}"]`).first();
    await expect(link).toBeVisible({ timeout: 5000 });
    expect(await link.getAttribute("target")).toBe("_blank");
    // rel must include noopener AND noreferrer to prevent reverse-tabnabbing
    const rel = (await link.getAttribute("rel")) || "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
    expect(await link.textContent()).toContain(linkText);
    // Click the link — Playwright surfaces a new browser tab via the context's
    // 'page' event because target=_blank. Verify the new tab navigates to the URL.
    const newPagePromise = context.waitForEvent("page", { timeout: 4000 }).catch(() => null);
    await link.click({ modifiers: [] });
    const newPage = await newPagePromise;
    if (newPage) {
      // Don't actually navigate (example.com is external); just confirm the URL was opened.
      expect(newPage.url()).toContain("example.com");
      await newPage.close();
    }
    // Image: rendered in #task-detail-card with src starting with /api/images/
    const img = page.locator("#task-detail-card img").first();
    await expect(img).toBeVisible({ timeout: 5000 });
    const src = await img.getAttribute("src");
    expect(src, "img src should be a server-stored URL, not the original data: URI").toMatch(/^\/api\/images\/[\w-]+$/);
    expect(src).not.toMatch(/^data:/);
    // The image actually loads (browser fetched it successfully)
    const naturalWidth = await img.evaluate(el => el.naturalWidth);
    expect(naturalWidth, "image must have decoded successfully (naturalWidth > 0)").toBeGreaterThan(0);
    // (Note: the server-side sanitizer currently strips the `alt` attribute
    //  on images. The client renderRich() would preserve it if it survived
    //  the server pass. Tracked separately as an accessibility refinement.)
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// HINT REVEAL — Trusted Types enforcement
// ═══════════════════════════════════════════════════════════════════════════════
// The CSP sets `require-trusted-types-for 'script'; trusted-types app-html`.
// A raw `element.outerHTML = ...` assignment throws TypeError in an enforcing
// browser. This test exercises the participant reveal flow in a real browser
// to catch any regression that reintroduces an unsafe sink (the earlier
// mutations.api.spec.js coverage only hits the API, not the DOM).
test.describe("Hint reveal — Trusted Types safe render", () => {
  test("participant reveals a hint; text renders in-place without TT violation", async ({ page }) => {
    const uniqHint = "Hint-TT-" + Date.now();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Create a published task with a unique hint text so we can assert rendering precisely.
    const create = await api.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: "HintReveal-" + Date.now(),
        description: "<p>Answer the question.</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", hint: uniqHint, status: "published",
      },
    });
    expect(create.ok()).toBeTruthy();
    let taskId = (await create.json()).id;

    // v8.3.11 — THIS TEST OWNS ITS COMPETITION AND ITS PARTICIPANT. It was the
    // last borrower of the seeded "Test Live" + the shared Alice in this file, and
    // it went flaky exactly the way v8.3.5's sibling twenty tests above did:
    // `[data-task-id]` never appeared, with a message naming the locator and
    // nothing about why.
    //
    // TWO independent hazards, either of which is sufficient, which is why the
    // remedy is the fixture rather than a longer timeout. (1) "Test Live" is
    // shared and its LIFECYCLE is not this test's to control — assignment is
    // refused once it has an ended session, and the all-solved auto-end can close
    // it, so the assign can be skipped and surface forty lines later as a missing
    // card. (2) Since v8.3.8 a sign-in AUTO-RESUMES the participant's last chosen
    // event, so whichever competition a previous test left on Alice's
    // `active_competition_id` is where `participantLogin` lands — and the card is
    // not there. Owning the competition alone would not fix (2): entering ANY
    // competition mutates her, so the only shape that leaves the rest of the file
    // as it found it is a participant nobody else uses. Fixture checklist, items
    // 2 and 3, and the v7.22.0 rule — select it, do not inherit it.
    const own = await api.post("/api/admin/competitions", {
      headers: h,
      data: {
        name: `HintTT Live ${Date.now().toString(36)}`, timezone: "UTC",
        start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600,
      },
    });
    expect(own.ok(), `create the test's own live competition: ${await own.text()}`).toBeTruthy();
    const liveComp = (await own.json()).competition;

    const asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: h, data: { competitionIds: [liveComp.id] },
    });
    expect(asg.ok(), `assign the hint challenge: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    taskId = (await asg.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is opened and answered there

    // The shared helper already registers, verifies, approves, sets the password
    // and enrols — the four steps a self-registration needs before the assign
    // endpoint will stop silently skipping it.
    const owner = await createAssignedParticipant(api, h, liveComp.id);
    await api.dispose();

    // Collect any page-level errors (TT violations surface as TypeError here)
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err));

    // Pre-selects the owned competition on the owned participant's session before
    // the browser loads, so the picker and its "Enter Live Event?" confirm
    // are never in the way.
    await enterCompAsParticipant(page, owner.email, liveComp.id);
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
    const taskCard = page.locator(`[data-task-id="${taskId}"]`).first();
    await expect(taskCard,
      "the owned challenge must be on the owned competition's list — if this fails, " +
      "check the assign above rather than the timeout"
    ).toBeVisible({ timeout: 15000 });
    await taskCard.click();

    // Before reveal: #hint-area contains a "Show Hint" button, not the hint text
    const hintArea = page.locator("#hint-area");
    await expect(hintArea).toBeVisible({ timeout: 5000 });
    await expect(hintArea.locator("button:has-text('Show Hint')")).toBeVisible();
    expect(await hintArea.innerText()).not.toContain(uniqHint);

    // Click reveal → confirm in the modal → hint renders in-place
    await hintArea.locator("button:has-text('Show Hint')").click();
    const confirmBtn = page.locator("#modal-confirm-btn");
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();

    // After reveal: same #hint-area element, new content with the unique hint text
    await expect(hintArea).toContainText(uniqHint, { timeout: 5000 });
    // v6.10.5: the "Hint" heading uses an inline SVG lightbulb icon
    // (ICO.lightbulb) rather than the legacy 💡 emoji — assert the
    // surrounding "Hint" word and the icon's presence instead.
    await expect(hintArea).toContainText("Hint");
    await expect(hintArea.locator("svg")).toHaveCount(1);
    // Button is gone
    await expect(hintArea.locator("button:has-text('Show Hint')")).toHaveCount(0);

    // No Trusted Types TypeError was thrown during the reveal
    expect(pageErrors.map(e => e.message).join("\n")).not.toMatch(/TrustedHTML|This document requires.*TrustedHTML/i);
  });

  test("Logs pane uses the canonical admin-pane markup + pagination shape", async ({ page }) => {
    await adminLogin(page);
    // Navigate to the Logs tab — expect-based wait auto-retries for the
    // table to render in place of a fixed delay.
    // RBAC sidebar — Logs has no sidebar item (Audit's Raw logs switch); the pane keeps its id.
    await page.locator("#admin-page").waitFor({ state: "visible" });
    await page.evaluate(() => window.adminTab(null, "admin-logs-tab"));

    // Canonical table container: <div class="card table-card"><table>
    const tableCard = page.locator("#admin-logs-tab .card.table-card table");
    await expect(tableCard).toBeVisible({ timeout: 5000 });

    // Sortable headers with the canonical trailing ▲ / ▼ icon span.
    const activeHeader = page.locator("#admin-logs-tab th.sortable").first();
    await expect(activeHeader).toBeVisible();
    const iconHtml = await activeHeader.locator("span[id^='sort-logs-'][id$='-icon']").first().innerText();
    // Default sort is desc on "ts" — the first header is "Date & Time" with ▼.
    expect(iconHtml).toContain("▼");

    // Pagination controls shape — First / Prev / "Page N of M (X total)" / Next / Last / size select.
    const pag = page.locator("#logs-pagination");
    await expect(pag.locator("button[data-action='logs-page-first']")).toBeVisible();
    await expect(pag.locator("button[data-action='logs-page-prev']")).toBeVisible();
    await expect(pag.locator("button[data-action='logs-page-next']")).toBeVisible();
    await expect(pag.locator("button[data-action='logs-page-last']")).toBeVisible();
    await expect(pag.locator(".page-info")).toContainText(/Page \d+ of \d+/);
    await expect(pag.locator("select[data-change-action='logs-page-size']")).toBeVisible();
  });

  test("opening a task with a <pre><code> block does not trigger a CSP violation report", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Rich-text description containing a fenced code block — triggers hljs
    // highlighting when the participant opens the task. Previously this hit
    // hljs.highlightElement → element.innerHTML = string, which violates the
    // strict Trusted Types policy and fires a CSP warn in app.jsonl.
    const uniqTitle = "CodeHL-" + Date.now();
    const create = await api.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: uniqTitle,
        description: `<p>Run this snippet:</p><pre><code class="language-javascript">const x = 42;\nconsole.log(x);</code></pre>`,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", hint: "—", status: "published",
      },
    });
    expect(create.ok()).toBeTruthy();
    let taskId = (await create.json()).id;
    const comps = await (await api.get("/api/admin/competitions")).json();
    const liveComp = comps.find(c => c.name === "Test Live");
    taskId = (await (await api.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: h, data: { competitionIds: [liveComp.id] },
    })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is opened and answered there
    await api.dispose();

    const pageErrors = [];
    const cspReports = [];
    page.on("pageerror", err => pageErrors.push(err));
    // CSP violations POST to /api/csp-report — capture any that fire.
    page.on("request", req => {
      if (req.url().endsWith("/api/csp-report")) cspReports.push(req.postData() || "");
    });

    await participantLogin(page);
    await enterCompAndNav(page, "Challenges");
    const taskCard = page.locator(`[data-task-id="${taskId}"]`).first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    await taskCard.click();

    // Wait for hljs to finish highlighting — the "hljs" class is added to
    // the <code> element when highlighting completes (runs via setTimeout 0).
    // toHaveClass auto-retries, so we don't need a fixed delay.
    const codeEl = page.locator("#task-detail-card pre code").first();
    await expect(codeEl).toBeVisible({ timeout: 5000 });
    await expect(codeEl).toHaveClass(/hljs/, { timeout: 3000 });

    // Neither page errors nor CSP reports should have fired.
    expect(pageErrors.map(e => e.message).join("\n")).not.toMatch(/TrustedHTML|This document requires.*TrustedHTML/i);
    expect(cspReports).toHaveLength(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// In-app Help drawer
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Help drawer", () => {
  test("Help (account menu) opens the participant guide for a participant, with a screenshot visible", async ({ page }) => {
    await participantLogin(page);
    // Signed in, the header holds Search; Help is an item of the account menu.
    await expect(page.locator("#app-search-btn")).toBeVisible({ timeout: 15000 });
    await require("./chrome-helpers").pressAccountMenuItem(page, "help-open");
    // Drawer slides in; body populated from /docs/user-guide/participant.md.
    const drawer = page.locator(".help-drawer");
    await expect(drawer).toBeVisible({ timeout: 5000 });
    // Marked renders the guide's H1 from the source.
    await expect(drawer.locator("h1:has-text('Participant Guide')")).toBeVisible({ timeout: 5000 });
    // Image paths are rewritten to /docs/screenshots/... and the PNG loads.
    const firstImg = drawer.locator("img").first();
    await expect(firstImg).toBeVisible({ timeout: 5000 });
    const src = await firstImg.getAttribute("src");
    expect(src).toMatch(/^\/docs\/screenshots\//);
    // v8.3.31 — POLLED, not sampled. `toBeVisible` is satisfied by an <img>
    // element that has been laid out, which says nothing about whether its bytes
    // have arrived: `naturalWidth` is 0 until the PNG decodes. On a loaded box
    // that decode lands after the assertion, and the failure reads as a broken
    // image path rather than as a race (seen once in a 60-run sweep).
    await expect.poll(() => firstImg.evaluate(el => el.naturalWidth),
      { timeout: 10000, intervals: [100, 200, 400, 800] })
      .toBeGreaterThan(0);
    // Esc closes.
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible({ timeout: 2000 });
  });

  test("internal .md links navigate in-drawer without leaving the app", async ({ page }) => {
    // v6.8.9: participant.md no longer has any internal doc links (the
    // top-level role-picker README was removed per operator ask — each
    // role lands directly on its own guide with no cross-nav out). The
    // drawer's internal-link routing is exercised via the admin → super-
    // admin path instead: the Admin guide has a "Next: Superadmin guide"
    // CTA that every admin can click through to.
    await adminLogin(page);
    await require("./chrome-helpers").pressAccountMenuItem(page, "help-open");
    const drawer = page.locator(".help-drawer");
    await expect(drawer.locator("h1:has-text('Admin Guide')")).toBeVisible({ timeout: 5000 });
    const urlBefore = page.url();
    const navLink = drawer.locator('a[data-help-nav*="superadmin.md"]').first();
    await expect(navLink).toHaveCount(1, { timeout: 5000 });
    await navLink.click();
    // URL shouldn't have changed (single-page drawer nav).
    expect(page.url()).toBe(urlBefore);
    // Body now shows the Superadmin guide.
    await expect(drawer.locator("h1:has-text('Superadmin Guide')")).toBeVisible({ timeout: 5000 });
  });

  // Regression: anonymous user opens Help → participant.md caches in
  // `_helpLastDoc` module-level state. When the SAME tab then logs in as
  // an admin via the in-app login form (no page reload), reopening ?
  // used to still show participant.md because `_helpLastDoc` shadowed
  // the role-default. The fix resets `_helpLastDoc` on login-success AND
  // adds a role-guard on the cache in `openHelpDrawer`.
  //
  // Must NOT call page.goto or page.reload between steps — a navigation
  // wipes the module state and hides the bug.
  test("admin role beats cached anonymous _helpLastDoc — opens admin.md after in-session login", async ({ page }) => {
    // 1. Anonymous: open Help, load participant.md, close drawer.
    await page.goto("/");
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#help-icon-btn").click();
    const drawer = page.locator(".help-drawer");
    await expect(drawer.locator("h1:has-text('Participant Guide')")).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible({ timeout: 2000 });

    // 2. Log in via the on-page form — this drives doLogin() without a
    //    page reload, keeping `_helpLastDoc` alive. Exercises exactly
    //    the code path the bug lives in.
    await page.fill("#login-email", "superadmin");
    await fillBreakGlass(page, getSuperadminPass());
    await submitLogin(page);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });

    // 3. Open Help again — MUST show admin.md now, not participant.md. Signed
    //    in, Help is an item of the account menu.
    await require("./chrome-helpers").pressAccountMenuItem(page, "help-open");
    await expect(drawer).toBeVisible({ timeout: 5000 });
    await expect(drawer.locator("h1:has-text('Admin Guide')")).toBeVisible({ timeout: 5000 });
    expect(await drawer.locator("h1:has-text('Participant Guide')").count()).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Participant accessibility — axe-core automated scan (v6.8.2)
// ═══════════════════════════════════════════════════════════════════════════════
// Axe-core runs a WCAG-aligned rule set against the rendered DOM. We scope
// to the two flows a participant spends the most time in — the login
// screen and the in-app Help drawer — and fail on any "serious" or
// "critical" violation. "minor" / "moderate" aren't failed yet so the
// gate is actionable; the report body lists them so they can be triaged.
test.describe("Participant accessibility — axe-core scan", () => {
  function summarise(results) {
    return (results.violations || []).map(v => `${v.id} (${v.impact}): ${v.help}`).join("\n");
  }
  function gated(results) {
    return (results.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact));
  }
  test("login screen: no moderate+ axe violations", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#login-email", { timeout: 5000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on login [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("help drawer open: no moderate+ axe violations", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#help-icon-btn", { timeout: 5000 });
    await page.click("#help-icon-btn");
    await page.waitForSelector("#help-drawer-overlay:not([hidden])", { timeout: 5000 });
    // Wait for the initial markdown to render so axe sees the real tree.
    await page.waitForSelector(".help-drawer-body h1, .help-drawer-body p", { timeout: 5000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#help-drawer-overlay")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations in help drawer:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("registration form: no moderate+ axe violations", async ({ page }) => {
    await page.goto("/");
    // Email first: the sign-up card opens after a code proves a new address.
    await signUpViaUi(page, `axe-${Date.now()}@company.example`, {}, { submit: false });
    await page.waitForSelector("#register-page.active", { timeout: 5000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#register-page")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on registration [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });



  test("v6.10.3: competitions picker: no moderate+ axe violations", async ({ page }) => {
    // v7.22.0 — scan the SETTLED page, not one mid-fade.
    //
    // `#comp-grid` gets applyReveal(), i.e. `.reveal{opacity:0}` transitioning to
    // `.reveal.visible{opacity:1}` over --duration-slow. Playwright's
    // `waitFor({state:"visible"})` is satisfied at opacity 0 — it checks the
    // bounding box and `visibility`, not opacity — so the v6.10.15 wait below
    // does not cover this, and axe could sample the cards part-way through the
    // fade and compute a BLENDED colour. Observed once at WORKERS=12: the live
    // countdown reported foreground #4d9d6c at 3.23:1, which is exactly
    // --green (#15803d) composited at ~76% over the #fdfcfe background — the
    // settled colour is the AA-compliant one the light theme was tuned for
    // (see the comment at the --green definition in styles.css). A contrast
    // result that depends on WHEN the sample was taken is the v7.21.1 A11 class:
    // vacuous when it passes, misleading when it fails.
    //
    // Fixed via the product's OWN mechanism rather than a bespoke poll: the
    // stylesheet has `@media(prefers-reduced-motion:reduce){.reveal{opacity:1}}`
    // and `_prefersReducedMotion` (ui/nav.js) skips the IntersectionObserver
    // entirely, so there is no fade to race. It must be set BEFORE the first
    // navigation, since that flag is read once at module load. Polling for
    // opacity:1 instead would hang on any card below the fold, which never
    // receives `.visible` at all.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const helpers = require("./helpers");
    const { api, csrf } = await helpers.apiLogin("alice@acme.com", helpers.PARTICIPANT_PASS);
    const me = await (await api.get("/api/me")).json();
    expect(me.userRole).toBe("participant");
    await api.dispose();
    // Log into the browser context fresh so the auto-resume goes to
    // the picker if we clear active-competition first.
    const csrfBrowser = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": csrfBrowser, "content-type": "application/json" });
    await page.goto("/");
    // Click Competitions and dismiss the Leave prompt if it appears.
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().click();
    const leaveBtn = page.locator("#modal-confirm-btn:has-text('Leave')");
    await leaveBtn.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    if (await leaveBtn.isVisible().catch(() => false)) await leaveBtn.click();
    await page.locator("#competitions-page.active").waitFor({ state: "visible", timeout: 10000 });
    // v6.10.15: wait for the data-driven content before axe scans.
    // Pre-fix the page became `active` synchronously inside showMain(),
    // but `loadMyCompetitions()` is fired-and-forgotten — axe could
    // scan the empty `#comp-grid` before the first `.comp-card`
    // rendered, and on slow / parallelism-contested runs the axe pass
    // caught the page mid-render with a transient intermediate state.
    // Now we wait for either a real comp-card OR the empty-state copy.
    // v8.3.26 — THE SETTLE IS A PRECONDITION, NOT A NUDGE. `.catch(()=>{})`
    // swallowed the case where BOTH branches lapsed, and axe then scanned an
    // unpopulated container, found nothing, and PASSED. That is how the v7.23.0
    // benchmark-row contrast defect stayed invisible: no rows in scope. An axe
    // scan over an empty region must fail as a precondition, not pass as a
    // result. 15 s because it covers a fetch plus a render on a contended box.
    await Promise.race([
      page.locator("#competitions-page .comp-card").first().waitFor({ state: "visible", timeout: 15000 }),
      page.locator("#competitions-page:has-text('No events found')").waitFor({ state: "visible", timeout: 15000 }),
    ]);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#competitions-page")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on competitions picker [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("v6.10.3: participant profile-edit modal: no moderate+ axe violations", async ({ page }) => {
    const helpers = require("./helpers");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": csrf, "content-type": "application/json" });
    await page.goto("/");
    // Profile lives in the account menu (tests/chrome-helpers.js).
    await require("./chrome-helpers").pressAccountMenuItem(page, "open-profile-editor");
    await page.waitForSelector("#profile-overlay", { state: "visible", timeout: 5000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#profile-overlay")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on participant profile modal [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("v6.10.3: leaderboard: no moderate+ axe violations", async ({ page }) => {
    const helpers = require("./helpers");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": csrf, "content-type": "application/json" });
    // v8.3.8 — SELECT the competition rather than inheriting alice's ambient one.
    // #nav-leaderboard is revealed only once a competition context resolves
    // (v7.17.3), so without a selection this asserts on the PICKER and waits out
    // the timeout. It used to pass on leftovers: an earlier test in this file
    // leaves the session pointing somewhere. That leftover is now correctly
    // cleared when a test navigates to the event list — leaving an event and
    // refreshing must not put you back inside it — which turns the pre-existing
    // ambient dependency from intermittent into deterministic. This is the
    // v7.22.0 fix ("when a participant UI test needs a competition, select it,
    // do not inherit it") applied to the last test in this file that inherited.
    const csrfSel = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const meBody = await (await page.request.get("/api/me")).json();
    const liveComp = meBody.competitions?.find(c => c.name === "Test Live") || meBody.competitions?.[0];
    expect(liveComp, "alice must have a competition to open the leaderboard of").toBeTruthy();
    const selR = await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": csrfSel, "content-type": "application/json" },
      data: { competitionId: liveComp.id },
    });
    expect(selR.ok(), `select ${liveComp.name}: ${await selR.text()}`).toBeTruthy();
    await page.goto("/");
    // Navigate to leaderboard via nav button.
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 5000 });
    // v6.10.15: wait for loadLeaderboard() to populate #lb-body before
    // axe scans. Same mid-render race as the competitions-picker test —
    // `leaderboard-page` becomes active inside showMain() before the
    // /api/leaderboard fetch resolves. Wait for either a board row or
    // the table being "settled empty" (response came back with 0 rows).
    // v8.3.26 — same class as the competitions scan above: a swallowed race let
    // axe scan an empty board and report zero violations. Asserted now.
    await Promise.race([
      page.locator("#lb-body tr:not([hidden])").first().waitFor({ state: "visible", timeout: 15000 }),
      page.waitForResponse(r => r.url().endsWith("/api/leaderboard") && r.ok(), { timeout: 15000 }),
    ]);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#leaderboard-page")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on participant leaderboard [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("v6.9.14: keyboard-only user can open a challenge by pressing Enter on a focused task-card", async ({ page }) => {
    // WCAG 2.1.1 regression for the finding that `.task-card` /
    // `.comp-card` render with role=button + tabindex=0 but had no
    // Enter/Space handler. The global delegator now covers any
    // [role="button"][data-action]:not(button) so the same synthetic-
    // click treatment `.sortable` headers get applies to card tiles.
    // Exercise the task path: log in as alice, focus the first card,
    // press Enter, assert the task-detail-page is now visible.
    const helpers = require("./helpers");
    const { api, csrf } = await helpers.apiLogin("alice@acme.com", helpers.PARTICIPANT_PASS);
    // Seed the right comp selection on this session via API so we
    // land on the tasks grid directly.
    const me = await (await api.get("/api/me")).json();
    const liveCompId = me.competitions?.find(c => c.name === "Test Live")?.id;
    expect(liveCompId).toBeTruthy();
    await api.post("/api/select-competition", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { competitionId: liveCompId } });
    await api.dispose();
    // Bring the same session cookie into the browser context.
    await page.goto("/api/csrf-token");
    await page.context().addCookies(await (async () => {
      const h = await (await codeLogin(page.request, "alice@acme.com", { "x-csrf-token": (await (await page.request.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" })).json();
      return [];
    })());
    // Re-select competition via the request context so auto-resume lands on tasks-page.
    const csrf2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrf2, "content-type": "application/json" }, data: { competitionId: liveCompId } });
    await page.goto("/");
    await page.waitForSelector("#tasks-page.active", { timeout: 5000 });
    // Focus the first card's control and press Enter. The control is the card's
    // title — a real <button class="card-open"> since the card stopped being
    // role=button (its name must open with the text it shows, WCAG 2.5.3) — so
    // Tab reaches it and Enter is the button's own; the card's data-action takes
    // the click it raises.
    const card = page.locator(".task-card").first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    const open = card.locator(".card-open");
    await open.focus();
    expect(await open.evaluate((el) => el === document.activeElement), "the card's title button takes focus").toBe(true);
    await page.keyboard.press("Enter");
    // Task detail page is the expected destination.
    await page.waitForSelector("#task-detail-page.active", { timeout: 5000 });
  });



  test("/register (an old link) lands an anonymous visitor on the email step, at /", async ({ page }) => {
    // Email first: there is no sign-up form without a proven address, so the old
    // dedicated URL leads to the one entry card and the address bar follows.
    await page.goto("/register");
    await page.waitForSelector("#login-page.active", { timeout: 5000 });
    await expect(page.locator("#login-email")).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    await expect(page.locator("#register-page.active")).toHaveCount(0);
  });
  test("verified.html: no moderate+ axe violations", async ({ page }) => {
    await page.goto("/verified.html");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on /verified.html [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("verify-failed.html: no moderate+ axe violations", async ({ page }) => {
    await page.goto("/verify-failed.html");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on /verify-failed.html [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  test("verify-expired.html: no moderate+ axe violations", async ({ page }) => {
    await page.goto("/verify-expired.html");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on /verify-expired.html [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });



  test("task-detail modal: no moderate+ axe violations", async ({ page }) => {
    // v6.8.4: re-added after the v6.8.3 implementation failed on
    // page.request.newContext. Uses the standard participantLogin +
    // enterCompAndNav pattern (see line 870) — no custom request context.
    await participantLogin(page);
    await enterCompAndNav(page, "Challenges");
    // Click the first task card and wait for the detail card to render.
    const taskCard = page.locator(".task-card").first();
    await taskCard.waitFor({ state: "visible", timeout: 10000 });
    await taskCard.click();
    await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 5000 });
    // Give the description markdown a moment to finish laying out (images,
    // syntax highlighting) so axe's contrast calculations use final colours.
    await page.locator("#task-detail-card h1, #task-detail-card h2, #task-detail-card p").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    // v7.23.4 — scope widened from #task-detail-card to #task-detail-page.
    // The card is a <div> INSIDE the page (index.html:334/340), so scanning it
    // skipped the page's own chrome — most importantly the "Back to Challenges"
    // control, which is the one thing on this screen a participant must be able
    // to find and press. Wave 4 moved that control's sticky offset, and no axe
    // scan could see it.
    // v8.3.5 — THE NODE DUMP BELOW IS WHAT MATTERS HERE, AND IT CORRECTED A WRONG
    // DIAGNOSIS OF MINE.
    //
    // This scan went flaky with one serious `color-contrast` violation. The
    // obvious reading was the documented mid-fade hazard — `applyReveal` animates
    // OPACITY, `waitFor({state:"visible"})` is satisfied at opacity 0, so axe can
    // sample a composite that never exists at rest (v7.23.0, v8.2.3) — and the
    // sibling scan below already guards against it. Guarding this one changed
    // NOTHING: it still failed, 2/2.
    //
    // Printing the failing NODE ended it in one run: `#hint-area > div:nth-child(1)`
    // at 4.22:1, i.e. a REAL and PERMANENT WCAG AA failure in the light theme,
    // fixed in this release. It presented as a flake only because `#hint-area`
    // exists solely once a hint has been revealed — the state an earlier test in
    // this file leaves behind and an isolated run never reaches. That is the
    // v7.23.0 benchmark-row shape exactly: a permanent defect wearing a flake's
    // clothes.
    //
    // The reduced-motion drain is KEPT — it is a genuine hazard on this surface
    // and costs nothing — but it is a precaution, not the fix, and saying so is
    // the point: a derivation that fits is not a diagnosis; only the failing node
    // is (v7.23.0).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(async () => {
      const root = document.getElementById("task-detail-page");
      if (root) await Promise.all(root.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
    });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#task-detail-page")
      .analyze();
    const bad = gated(results);
    const nodes = bad.flatMap((v) => (v.nodes || []).map((nd) =>
      `  ${v.id}: ${(nd.target || []).join(" ")}\n    ${(nd.failureSummary || "").replace(/\n/g, " ")}`)).join("\n");
    expect(bad, `moderate+ a11y violations on task-detail page [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}\nNODES:\n${nodes}`).toHaveLength(0);
  });

  // v7.23.4 (audit Wave 1 residue) — #main-nav had NEVER been scanned.
  //
  // Every participant scan is scoped to a #...-page container, and #main-nav
  // lives in <header>, outside all of them. That is not a small gap: the single
  // largest contrast group in the whole v7.23.0 audit was #nav-competitions at
  // 2.03:1 (66 axe instances), dimmed by an inline opacity for the entire
  // duration of a competition — and CI structurally could not see it. It was
  // found by a hand-driven sweep, not by the gate.
  test("v7.23.4: the header nav is clean (it was outside every scan scope)", async ({ page }) => {
    await participantLogin(page);
    await enterCompAndNav(page, "Challenges");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#main-nav")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on #main-nav [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);
  });

  // v7.23.4 — the shared confirm dialog had never been scanned. It is what every
  // destructive action routes through, so a failure there is one a user meets at
  // the highest-stakes moment. Driven through a real confirm rather than
  // injected markup, so the scan sees the actual rendered dialog.
  //
  // AXE CANNOT CHECK CONTRAST IN THIS DIALOG, AND THE TEST SAYS SO.
  //
  // Measured, with a deliberate 1.68:1 planted on #modal-body, scanning three
  // different scopes:
  //     #modal-overlay  violations: []  incomplete: ["color-contrast"]
  //     #modal-box      violations: []  incomplete: ["color-contrast"]
  //     #modal-body     violations: []  incomplete: ["color-contrast"]
  // Never a violation, at any scope — including #modal-body itself, whose
  // parent #modal-box is fully opaque (class="card", rgb(255,255,255)). axe's
  // colour-contrast algorithm walks the ancestor chain and bails once it meets
  // the translucent #modal-overlay scrim (--overlay: rgba(0,0,0,0.4)).
  //
  // So this scan is REAL for labelling, roles, names and ARIA — the dialog had
  // none of that covered — and is a silent no-op for contrast. A computed-style
  // assertion below closes that gap, because the shared confirm is exactly
  // where a contrast failure would be met at the highest-stakes moment.
  // Related: the v7.23.1 ghost-chip finding — a transparent fill turns a
  // deterministic contrast check into a flaky or absent one.
  test("v7.23.4: the shared confirm modal is clean", async ({ page }) => {
    await participantLogin(page);
    await page.goto("/");
    await page.emulateMedia({ reducedMotion: "reduce" });

    // v7.23.5 — raise the modal DIRECTLY rather than through the hint flow.
    //
    // The first version navigated into a competition, opened the first challenge
    // and clicked Show Hint. That made an a11y scan of a SHARED dialog depend on
    // which competition sorted first, which challenge the grid put first, and
    // whether a sibling test in this 30-test file had already solved it or
    // revealed its hint — and it flaked with "element(s) not found" on the hint
    // button. None of that is the subject: the subject is #modal-box.
    //
    // This is not a weakening. revealHint() calls plain showModal() (there is no
    // countdown variant on that path), so the options below are the ones the
    // hint flow itself passes — same DOM, same danger button, same red <strong>
    // that the contrast pass below is there to measure.
    const raised = await page.evaluate(() => {
      if (typeof window.showModal !== "function") return false;
      window.showModal({
        title: "Reveal Hint",
        message: 'Revealing this hint will immediately deduct <strong style="color:var(--red)">10 points</strong> from your score.<br><br>This penalty is permanent — it applies even if you don\'t solve the challenge later.',
        confirmText: "Reveal hint (−10 pts)",
        confirmClass: "danger",
        cancelText: "Keep my points",
      });
      return true;
    });
    expect(raised, "window.showModal must be exposed, or this scan is vacuous").toBe(true);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    // Non-vacuity: the modal must actually carry the content being scanned — a
    // scan of an empty #modal-box would pass every assertion below.
    await expect(page.locator("#modal-box .btn.danger"),
      "the danger confirm button must be present").toHaveCount(1);
    await expect(page.locator("#modal-box strong"),
      "the red <strong> the contrast pass measures must be present").toHaveCount(1);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include("#modal-box")
      .analyze();
    const bad = gated(results);
    expect(bad, `moderate+ a11y violations on #modal-box [rules: ${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]:\n${summarise({ violations: bad })}`).toHaveLength(0);

    // Non-vacuity + the contrast axe cannot do. Composites each text node's own
    // colour against the nearest OPAQUE ancestor background (the .card), which
    // is what a user actually sees, and asserts AA.
    const contrast = await page.evaluate(() => {
      const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const opaqueBg = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          const p = (c.match(/[\d.]+/g) || []).map(Number);
          if (p.length >= 3 && (p.length < 4 || p[3] >= 0.999)) return p.slice(0, 3);
        }
        return [255, 255, 255];
      };
      const box = document.getElementById("modal-box");
      const out = [];
      for (const el of box.querySelectorAll("*")) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const cs = getComputedStyle(el);
        const fg = rgb(cs.color), bg = opaqueBg(el);
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(cs.fontSize);
        const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
        out.push({ text: (el.textContent || "").trim().slice(0, 24), ratio: +ratio.toFixed(2),
                   need: large ? 3 : 4.5, ok: ratio >= (large ? 3 : 4.5) });
      }
      return out;
    });
    expect(contrast.length, "the confirm dialog must contain text, or this scan is vacuous").toBeGreaterThan(2);
    expect(contrast.filter((c) => !c.ok),
      `confirm-dialog text below AA (axe reports these as 'incomplete', so only this check can see them): ${JSON.stringify(contrast)}`).toEqual([]);
  });

  test("help drawer focus-trap: Shift+Tab from first wraps to last", async ({ page }) => {
    // The drawer's focus-trap wraps AT THE EDGES — Shift+Tab from the
    // first focusable returns to the last, so focus stays inside.
    await page.goto("/");
    await page.waitForSelector("#help-icon-btn", { timeout: 5000 });
    await page.click("#help-icon-btn");
    await page.waitForSelector("#help-drawer-overlay:not([hidden])", { timeout: 5000 });
    // Wait for the drawer markdown to render so the focusables list is stable.
    await page.waitForSelector(".help-drawer-body h1, .help-drawer-body p", { timeout: 5000 });
    // Force focus to the first focusable inside the drawer.
    await page.evaluate(() => {
      const overlay = document.getElementById("help-drawer-overlay");
      const focusables = overlay.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length) focusables[0].focus();
    });
    await page.keyboard.press("Shift+Tab");
    const inside = await page.evaluate(() => {
      const drawer = document.getElementById("help-drawer-overlay");
      const active = document.activeElement;
      return !!(drawer && active && drawer.contains(active));
    });
    expect(inside).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Profile completion gate (v6.18.x)
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Profile completion gate (v6.18.x)", () => {
  test("gate appears on login when job_function is missing, is non-dismissible, closes on save", async ({ page }) => {
    const Database = require("better-sqlite3");
    const suffix = Date.now();
    const email = `gate-ui-${suffix}@acme.com`;
    // Register + verify + approve a fresh user with both fields the gate event
    // requires; job_function is then cleared below, so it is the one missing.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: { firstName: "Gate", lastName: "User", nickname: `gate_${suffix}`,
              email, company: "GateCo", title: "Tester", country: "US", timezone: "America/New_York",
              jobFunction: "Software Developer / Engineer", city: "Gatesville" },
    });
    await anon.dispose();
    // Verify + approve via admin API
    const parts = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants;
    const u = parts.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    await sa.dispose();
    // Null out job_function to force the gate.
    const db = new Database(TEST_DB_PATH);
    db.prepare("UPDATE users SET job_function=NULL WHERE email=?").run(email);
    db.prepare("UPDATE users SET registration_competition_id=?, profile_policy='booth' WHERE email=?").run(await gateEventId(), email);
    db.close();
    // Login via browser form so doLogin() fires and checks missing_fields.
    await login(page, email, PARTICIPANT_PASS);
    const gate = page.locator("#profile-gate-overlay");
    await gate.waitFor({ state: "visible", timeout: 10000 });
    // No X button, no Cancel button inside the gate.
    expect(await gate.locator("button.close-btn, button[aria-label='Close'], #gate-cancel-btn").count()).toBe(0);
    // Escape must NOT close the gate.
    await page.keyboard.press("Escape");
    await gate.waitFor({ state: "visible", timeout: 2000 });
    // v7.15.2 (audit) — precisely BECAUSE it is non-dismissible, the card must be
    // able to scroll: a cross-axis-centred flex item that outgrows its container
    // overflows at the block START, which is not reachable by scrolling, so at
    // 200% zoom (or with every field missing) the heading and the missing-field
    // list would be clipped away with no way to reach them and no way out. The
    // sibling #profile-overlay card has always had this guard; the gate had no
    // CSS rule at all.
    const guard = await gate.locator(".profile-card").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { maxH: cs.maxHeight, overflowY: cs.overflowY, margin: cs.marginTop };
    });
    expect(guard.maxH, "gate card is height-bounded").not.toBe("none");
    expect(guard.overflowY, "gate card scrolls its own overflow").toMatch(/auto|scroll/);
    // Fill the role field and save.
    const roleSelect = gate.locator("#gate-job-function");
    await roleSelect.selectOption("Software Developer / Engineer");
    await gate.locator("#gate-save-btn").click();
    await gate.waitFor({ state: "detached", timeout: 10000 });
    // Clean up the test user.
    const { api: sa2, csrf: sa2C } = await apiLogin("superadmin");
    const parts2 = (await (await sa2.get("/api/admin/participants?limit=500")).json()).participants;
    const u2 = parts2.find(p => p.email === email);
    if (u2) await sa2.delete(`/api/admin/participants/${u2.id}`, { headers: { "x-csrf-token": sa2C } });
    await sa2.dispose();
  });



  test("PR B / F#5: gate fires on a plain page load (boot path) for an incomplete logged-in account", async ({ page }) => {
    // Locks the boot-path consolidation (previously UNCOVERED): the gate must fire
    // on a plain refresh, not only at the doLogin moment. Log in via API in the
    // page's cookie jar (bypassing doLogin's own gate), then plain-navigate.
    const Database = require("better-sqlite3");
    const suffix = Date.now();
    const email = `gate-boot-${suffix}@acme.com`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: { firstName: "Boot", lastName: "Gate", nickname: `bootgate_${suffix}`,
              email, company: "Co", title: "Eng", country: "US", timezone: "America/New_York",
              password: PARTICIPANT_PASS },
    });
    await anon.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants;
    const u = parts.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    await sa.dispose();
    const db = new Database(TEST_DB_PATH);
    db.prepare("UPDATE users SET job_function=NULL WHERE email=?").run(email);
    db.prepare("UPDATE users SET registration_competition_id=?, profile_policy='booth' WHERE email=?").run(await gateEventId(), email);
    db.close();

    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const lr = await codeLogin(page.request, email, { "x-csrf-token": csrf, "content-type": "application/json" });
    expect(lr.ok(), `api login: ${lr.status()}`).toBeTruthy();

    await page.goto("/");
    const gate = page.locator("#profile-gate-overlay");
    await expect(gate).toBeVisible({ timeout: 10000 });

    const { api: sa2, csrf: sa2C } = await apiLogin("superadmin");
    await sa2.delete(`/api/admin/participants/${u.id}`, { headers: { "x-csrf-token": sa2C } }).catch(() => {});
    await sa2.dispose();
  });

  // ── v7.6.x hardening: the gate must be a HARD block — non-bypassable and
  // unresolvable until EVERY mandatory field is actually complete. ───────────
  const GateDb = require("better-sqlite3");
  async function makeGateUser(suffix, nullCols) {
    const email = `gate-h-${suffix}@acme.com`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: { firstName: "Gate", lastName: "Hard", nickname: `gateh_${suffix}`, email,
        company: "Co", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS } });
    await anon.dispose();
    const u = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    await sa.dispose();
    const db = new GateDb(TEST_DB_PATH);
    db.prepare(`UPDATE users SET ${nullCols.map(c => c + "=NULL").join(",")} WHERE email=?`).run(email);
    db.prepare("UPDATE users SET registration_competition_id=?, profile_policy='booth' WHERE email=?").run(await gateEventId(), email);
    db.close();
    return { email, id: u.id };
  }
  async function cleanupGateUser(id) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    await sa.delete(`/api/admin/participants/${id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await sa.dispose();
  }

  test("the gate blocks 'Save & Continue' while a required field is empty — cannot bypass by leaving it blank", async ({ page }) => {
    const { email, id } = await makeGateUser(Date.now(), ["job_function"]);
    try {
      await login(page, email, PARTICIPANT_PASS);
      const gate = page.locator("#profile-gate-overlay");
      await gate.waitFor({ state: "visible", timeout: 10000 });
      // Try to save with the role unselected → validation error, gate STAYS up.
      await gate.locator("#gate-save-btn").click();
      await expect(gate.locator("#gate-error")).toBeVisible();
      await expect(gate).toBeVisible();
      // Provide it → gate closes.
      await gate.locator("#gate-job-function").selectOption("Software Developer / Engineer");
      await gate.locator("#gate-save-btn").click();
      await gate.waitFor({ state: "detached", timeout: 10000 });
    } finally { await cleanupGateUser(id); }
  });

  test("the gate re-verifies after save and re-opens for a field still missing — cannot proceed until ALL are complete", async ({ page }) => {
    const { email, id } = await makeGateUser(Date.now(), ["job_function"]);
    try {
      await login(page, email, PARTICIPANT_PASS);
      const gate = page.locator("#profile-gate-overlay");
      await gate.waitFor({ state: "visible", timeout: 10000 });
      await expect(gate.locator("#gate-job-function")).toBeVisible();
      // Sabotage: null `city` now, so completing job_function alone is NOT enough.
      const db = new GateDb(TEST_DB_PATH);
      db.prepare("UPDATE users SET city=NULL WHERE email=?").run(email);
      db.close();
      await gate.locator("#gate-job-function").selectOption("Software Developer / Engineer");
      await gate.locator("#gate-save-btn").click();
      // The gate must NOT have let through — it re-opens for the still-missing City.
      await expect(page.locator("#profile-gate-overlay #gate-city")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#profile-gate-overlay #gate-job-function")).toHaveCount(0);
      // Complete City → now truly complete → gate finally closes.
      await page.locator("#profile-gate-overlay #gate-city").fill("London");
      await page.locator("#profile-gate-overlay #gate-save-btn").click();
      await page.locator("#profile-gate-overlay").waitFor({ state: "detached", timeout: 10000 });
    } finally { await cleanupGateUser(id); }
  });

  test("with mandatory fields missing, the participant cannot reach the app — the nav stays empty until the gate is completed", async ({ page }) => {
    const { email, id } = await makeGateUser(Date.now(), ["job_function"]);
    try {
      await login(page, email, PARTICIPANT_PASS);
      const gate = page.locator("#profile-gate-overlay");
      await gate.waitFor({ state: "visible", timeout: 10000 });
      // doLogin awaits the gate BEFORE building the participant nav, so the app
      // behind the gate is never built/reachable while it's up.
      expect(await page.locator("#main-nav button").count()).toBe(0);
      expect(await page.locator("#competitions-page.active").count()).toBe(0);
      // Completing the gate lets the participant flow proceed.
      await gate.locator("#gate-job-function").selectOption("Software Developer / Engineer");
      await gate.locator("#gate-save-btn").click();
      await gate.waitFor({ state: "detached", timeout: 10000 });
    } finally { await cleanupGateUser(id); }
  });

  test("a double-click on Save never stacks two gate overlays (re-entrancy + singleton guard)", async ({ page }) => {
    const { email, id } = await makeGateUser(Date.now(), ["job_function"]);
    try {
      await login(page, email, PARTICIPANT_PASS);
      const gate = page.locator("#profile-gate-overlay");
      await gate.waitFor({ state: "visible", timeout: 10000 });
      // Sabotage city so saving job_function triggers the re-verify RE-OPEN path
      // (the only path that tears down + re-creates the overlay).
      const db = new GateDb(TEST_DB_PATH);
      db.prepare("UPDATE users SET city=NULL WHERE email=?").run(email);
      db.close();
      await page.locator("#gate-job-function").selectOption("Software Developer / Engineer");
      // Two SYNCHRONOUS clicks: the in-flight guard must make the 2nd a no-op, so
      // the recursion can't append a second #profile-gate-overlay.
      await page.evaluate(() => { const b = document.getElementById("gate-save-btn"); b.click(); b.click(); });
      // The gate re-opens for the still-missing City — and there is exactly ONE overlay.
      await expect(page.locator("#profile-gate-overlay #gate-city")).toBeVisible({ timeout: 10000 });
      expect(await page.locator("#profile-gate-overlay").count()).toBe(1);
      // Complete City → the (single) gate finally closes.
      await page.locator("#profile-gate-overlay #gate-city").fill("London");
      await page.locator("#profile-gate-overlay #gate-save-btn").click();
      await page.locator("#profile-gate-overlay").waitFor({ state: "detached", timeout: 10000 });
    } finally { await cleanupGateUser(id); }
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v7.15.0 — leaderboard: all-solved column + sortable columns
// ═══════════════════════════════════════════════════════════════════════════
// The load-bearing property here is FAIRNESS, not sorting. The participant board
// deliberately shows only the top 20 plus your own row, so a participant cannot
// learn who else is competing or how many. Client-side sorting re-orders the rows
// already on screen; if it ever fetched more, derived a total, or surfaced a
// participant who wasn't already visible, that invariant would be broken by a
// feature that looks purely cosmetic. Every sort assertion below therefore checks
// the ROW SET, not just the order.
test.describe("v7.15.0 — participant leaderboard columns + sorting", () => {
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

  /** Comp + a real logged-in caller + `dummies` DB-direct participants above them. */
  async function buildBoard(dummies) {
    const Database = require("better-sqlite3");
    const crypto = require("crypto");
    const tag = crypto.randomBytes(4).toString("hex");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const jsonH = H(csrf), h = { "x-csrf-token": csrf };
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: jsonH, data: {
      name: `LbSort-${tag}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;

    const email = `lbsort-${tag}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: H(ac), data: {
      firstName: "Sort", lastName: "Caller", nickname: `lbsort_${tag}`, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    }});
    await anon.dispose();
    const callerId = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email).id;
    await sa.post(`/api/admin/participants/${callerId}/verify`, { headers: h });
    await sa.post(`/api/admin/participants/${callerId}/approve`, { headers: h });

    // v7.15.2 (audit) — the fixture must VARY every sortable field. It originally
    // gave every dummy the same login_time and assigned no challenges, so score,
    // solveTimeMs and allSolved were uniform across all 20 rendered rows: those
    // three comparators always fell through to the rank tiebreak, and the sort
    // assertions passed no matter what they did. Two published challenges are
    // assigned, and the dummies get distinct login_times plus a 3-way solve split
    // (both / one / none), so score, time and solved each have a real ordering
    // AND a real ties-group.
    const mkTask = async (n) => {
      const id = (await (await sa.post("/api/admin/tasks", { headers: jsonH, data: {
        title: `LbSortTask ${tag} ${n}`, description: "<p>x</p>", difficulty: n === 1 ? "easy" : "medium",
        answer_type: "text", correct_answer: `a${n}`, status: "published",
      }})).json()).id;
      return (await (await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: jsonH, data: { competitionIds: [compId] } })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is opened and answered there
    };
    const taskIds = [await mkTask(1), await mkTask(2)];

    // Dummies rank ABOVE the caller (earlier login_time => smaller solveTimeMs),
    // so the caller lands outside the cap and the "your placement" banner shows.
    const dbW = new Database(TEST_DB_PATH);
    const ids = [];
    try {
      const insU = dbW.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, avatar, verified, approved, password_hash, created_at) VALUES (?,?,?,?,?,?,1,1,?,?)");
      const insCU = dbW.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, login_time) VALUES (?,?,?,?,?)");
      const insSub = dbW.prepare(`INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at)
                                  VALUES (?,?,?,?,?,1,?,?)`);
      dbW.transaction(() => {
        for (let i = 0; i < dummies; i++) {
          const id = `lbsort-${tag}-${String(i).padStart(2, "0")}`;
          ids.push(id);
          insU.run(id, "Sort", `Dummy${i}`, `lbs_${tag}_${i}`, `lbs-${tag}-${i}@acme.com`, "default1", "$2b$10$dummyhashdoesnotneedtowork", new Date(t - 90 * 60_000).toISOString());
          // Distinct login_time per dummy => distinct solveTimeMs (the `time`
          // comparator now has something to order). Still all LATER than the
          // caller's, so the caller stays worst-ranked and outside the cap.
          const lt = new Date(t - (10 * 60_000) + i * 1000).toISOString();
          insCU.run(compId, id, "test-system", lt, lt);
          // 3-way split: i%3===0 solves BOTH (allSolved + top score), i%3===1
          // solves ONE (mid score, not allSolved), i%3===2 solves NOTHING.
          const solves = i % 3 === 0 ? 2 : i % 3 === 1 ? 1 : 0;
          for (let k = 0; k < solves; k++) {
            insSub.run(`${id}-s${k}`, id, taskIds[k], compId, `a${k + 1}`, k === 0 ? 50 : 100,
              new Date(t - 5 * 60_000 + i * 1000).toISOString());
          }
        }
        const callerLT = new Date(t - 120 * 60_000).toISOString();
        insCU.run(compId, callerId, "test-system", callerLT, callerLT);
      })();
    } finally { dbW.close(); }
    return { compId, callerId, email, ids, sa, h, tag, taskIds };
  }

  async function teardown({ compId, callerId, ids, sa, h, taskIds }) {
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare("DELETE FROM submissions WHERE competition_id=?").run(compId);
      dbW.prepare("DELETE FROM competition_users WHERE competition_id=?").run(compId);
      dbW.prepare("DELETE FROM competition_tasks WHERE competition_id=?").run(compId);
      dbW.prepare("DELETE FROM competitions WHERE id=?").run(compId);
      for (const id of ids) dbW.prepare("DELETE FROM users WHERE id=?").run(id);
      for (const id of (taskIds || [])) dbW.prepare("DELETE FROM tasks WHERE id=?").run(id);
    } finally { dbW.close(); }
    if (callerId) await sa.delete(`/api/admin/participants/${callerId}`, { headers: h }).catch(() => {});
    await sa.dispose();
  }

  async function enterBoard(page, email, compId) {
    await loginViaApi(page, email, PARTICIPANT_PASS);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
    await page.goto("/");
    // Solving every challenge auto-ends the competition, and the resulting
    // "Event Ended" dialog covers the nav bar. Its primary action is
    // "View Leaderboard", so accepting it both clears the overlay and gets us
    // where we're going; the explicit nav click below is the no-modal path.
    // The dialog is raised by the post-boot status poll, so it can arrive AFTER a
    // single up-front check — dismiss in a short loop rather than racing it.
    for (let i = 0; i < 12; i++) {
      if (!(await page.locator("#modal-overlay.open").count())) break;
      await page.locator("#modal-confirm-btn").click().catch(() => {});
      await page.waitForTimeout(250);
    }
    if (!(await page.locator("#leaderboard-page.active").count())) {
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click({ timeout: 15000 });
    }
    // Rows on the podium are [hidden] in the table (it starts at rank 4).
    await page.locator("#lb-body tr:not([hidden])").first().waitFor({ state: "visible", timeout: 15000 });
  }

  test("sorting NEVER reveals more participants than the cap, and keeps your own row", async ({ page }) => {
    const ctx = await buildBoard(26);   // 26 dummies + caller = 27 ranked, cap is 20
    try {
      await enterBoard(page, ctx.email, ctx.compId);

      const rowsBefore = await page.locator("#lb-body tr").count();
      expect(rowsBefore, "board is capped at 20").toBe(20);
      const idsBefore = (await page.locator("#lb-body tr").evaluateAll(rs => rs.map(r => r.getAttribute("data-uid")))).sort();

      // The caller is outside the cap, so their placement shows in the banner —
      // and the banner must survive sorting too.
      await expect(page.locator("#lb-me-banner .lb-me-card")).toBeVisible();

      for (const col of ["place", "player", "score", "time", "solved"]) {
        for (const pass of [1, 2]) {   // click twice: ascending then descending
          await page.locator(`#leaderboard-page th[data-col="${col}"]`).click();
          await page.waitForTimeout(250);
          const rows = await page.locator("#lb-body tr").count();
          expect(rows, `sorting by ${col} (pass ${pass}) must not change how many rows are shown`).toBe(rowsBefore);
          const ids = (await page.locator("#lb-body tr").evaluateAll(rs => rs.map(r => r.getAttribute("data-uid")))).sort();
          expect(ids, `sorting by ${col} (pass ${pass}) must not reveal a different set of participants`).toEqual(idsBefore);
          await expect(page.locator("#lb-me-banner .lb-me-card"),
            `your placement stays visible while sorted by ${col}`).toBeVisible();
        }
      }

      // Nothing anywhere on the page discloses how many people are competing.
      // Your OWN rank is deliberately shown (that is what the placement banner is
      // for, and the API returns me.rank even outside the cap) — what must never
      // appear is a TOTAL, i.e. how many people you are competing against.
      const pageText = await page.locator("#leaderboard-page").innerText();
      expect(pageText).not.toMatch(/of\s+\d+\s+participants/i);
      expect(pageText).not.toMatch(/\b\d+\s+(participants|players|competitors)\b/i);
    } finally { await teardown(ctx); }
  });

  test("sorting actually re-orders, and the direction toggles with aria-sort", async ({ page }) => {
    const ctx = await buildBoard(24);
    try {
      await enterBoard(page, ctx.email, ctx.compId);
      const th = page.locator('#leaderboard-page th[data-col="player"]');
      const namesOf = () => page.locator("#lb-body tr td:nth-child(2)").allInnerTexts();

      await th.click();
      await page.waitForTimeout(250);
      const asc = (await namesOf()).map(s => s.trim().toLowerCase());
      await expect(th).toHaveAttribute("aria-sort", "ascending");
      expect([...asc].sort((a, b) => a.localeCompare(b)), "ascending by player name").toEqual(asc);

      await th.click();
      await page.waitForTimeout(250);
      const desc = (await namesOf()).map(s => s.trim().toLowerCase());
      await expect(th).toHaveAttribute("aria-sort", "descending");
      expect(desc, "second click reverses the order").toEqual([...asc].reverse());
    } finally { await teardown(ctx); }
  });

  // v7.15.2 (audit) — the test above only ever observed the `player` comparator.
  // Every other column was exercised on a fixture where the value was identical
  // for every row, so score/time/solved always fell through to the rank tiebreak
  // and their comparators could have been no-ops (or inverted) unnoticed. Assert
  // each one actually orders, in both directions, on a fixture that varies them.
  test("every column's comparator actually orders the rows, both directions", async ({ page }) => {
    const ctx = await buildBoard(24);
    try {
      await enterBoard(page, ctx.email, ctx.compId);
      // Read the value each comparator sorts on straight out of the rendered row,
      // so a broken comparator shows up as an out-of-order sequence here.
      const colValues = (col) => page.locator("#lb-body tr").evaluateAll((rows, c) => rows.map((r) => {
        const td = r.children;
        if (c === "score") return parseInt((td[2].textContent || "").replace(/[^\d-]/g, ""), 10) || 0;
        if (c === "solved") return td[4].querySelector(".lb-solved-pill") ? 1 : 0;
        return (td[3].textContent || "").trim();               // time, as displayed
      }), col);
      const isSorted = (a, cmp) => a.every((v, i) => i === 0 || cmp(a[i - 1], v) <= 0);
      const num = (x, y) => x - y;

      for (const col of ["score", "solved"]) {
        const th = page.locator(`#leaderboard-page th[data-col="${col}"]`);
        await th.click(); await page.waitForTimeout(250);
        const first = await colValues(col);
        await expect(th).toHaveAttribute("aria-sort", "ascending");
        const uniq = new Set(first.map(String));
        expect(uniq.size, `fixture must VARY ${col}, else this assertion is vacuous`).toBeGreaterThan(1);
        expect(isSorted(first, num), `${col} ascending: ${first.join(",")}`).toBe(true);

        await th.click(); await page.waitForTimeout(250);
        const second = await colValues(col);
        await expect(th).toHaveAttribute("aria-sort", "descending");
        expect(isSorted([...second].reverse(), num), `${col} descending: ${second.join(",")}`).toBe(true);
      }

      // Time-to-solve is rendered as text ("1m 03s"), so compare the underlying
      // ordering via the row set's rank instead: ascending time must be a strict
      // re-order of, not equal to, the descending pass.
      const thTime = page.locator('#leaderboard-page th[data-col="time"]');
      await thTime.click(); await page.waitForTimeout(250);
      const tAsc = await colValues("time");
      await thTime.click(); await page.waitForTimeout(250);
      const tDesc = await colValues("time");
      expect(new Set(tAsc).size, "fixture must VARY time-to-solve").toBeGreaterThan(1);
      expect(tDesc, "time sort reverses on the second click").toEqual([...tAsc].reverse());
    } finally { await teardown(ctx); }
  });

  // v7.15.5 — the mark looked shoved to the right of its own column and the
  // column hogged the table. Cause: `.lb-solved-col` is (0,1,0) and lost to
  // `.lb-table th{text-align:left}` (0,1,1), so the HEADER stayed left while the
  // CELL centred (measured: 256px-wide column, header text at x=844, pill centre
  // at x=972). The admin board's base rule is only `table th` (0,0,2), so it
  // centred correctly — the two views disagreed, which is precisely what the
  // shared solvedCell() leaf exists to prevent. Assert the rendered geometry,
  // not the stylesheet text.
  test("the all-solved column is centred and compact — header and mark share an axis", async ({ page }) => {
    const ctx = await buildBoard(6);
    try {
      await enterBoard(page, ctx.email, ctx.compId);
      const g = await page.evaluate(() => {
        const th = document.querySelector('#leaderboard-page th.lb-solved-col');
        const td = document.querySelector('#lb-body tr:not([hidden]) td.lb-solved-col');
        const mark = td.querySelector('.lb-solved-pill, .lb-unsolved');
        const mid = (el) => { const b = el.getBoundingClientRect(); return b.left + b.width / 2; };
        return {
          headerAlign: getComputedStyle(th).textAlign,
          cellAlign: getComputedStyle(td).textAlign,
          width: th.getBoundingClientRect().width,
          headerMid: mid(th),
          markMid: mid(mark),
          tableWidth: document.querySelector('#leaderboard-page .lb-table').getBoundingClientRect().width,
        };
      });
      expect(g.headerAlign, "header alignment matches the cell").toBe(g.cellAlign);
      expect(g.headerAlign).toBe("center");
      // The mark sits on the header's axis (a few px of slack for sub-pixel rounding).
      expect(Math.abs(g.headerMid - g.markMid),
        `mark is ${Math.abs(g.headerMid - g.markMid).toFixed(0)}px off the header's centre`).toBeLessThan(4);
      // And the column shrinks to its own content instead of absorbing the
      // table's slack — it was ~24% of the table before.
      expect(g.width / g.tableWidth, "solved column must not hog the table").toBeLessThan(0.15);
    } finally { await teardown(ctx); }
  });

  test("the all-solved mark is its own column, is labelled for screen readers, and survives a poll", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf }, jsonH = H(csrf);
    const stamp = `${Date.now().toString(36)}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: jsonH, data: {
      name: `LbSolved-${stamp}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    let taskId = (await (await sa.post("/api/admin/tasks", { headers: jsonH, data: {
      title: `LbSolved Task ${stamp}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "yes", explanation: "<p>e</p>", status: "published",
    }})).json()).id;
    taskId = (await (await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: jsonH, data: { competitionIds: [compId] } })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is opened and answered there
    const me = await createAssignedParticipant(sa, jsonH, compId);
    // A second enrolled participant who never solves anything. Without them the
    // all-solved auto-end fires the moment `me` finishes, the competition ends,
    // and the "Event Ended" dialog covers the nav — this keeps the comp
    // live so the test exercises the live board, which is the case that matters.
    await createAssignedParticipant(sa, jsonH, compId);
    try {
      // Solve the only challenge => allSolved true for this participant.
      const p = await apiLogin(me.email, PARTICIPANT_PASS);
      await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: compId } });
      const sub = await p.api.post(`/api/tasks/${taskId}/submit`, { headers: H(p.csrf), data: { answer: "yes" , gradingHash: await gradingHashFor(p.api, taskId)} });
      expect((await sub.json()).correct).toBe(true);
      await p.api.dispose();

      await enterBoard(page, me.email, compId);
      // textContent, not innerText: the header cells are tracked caps by CSS
      // (text-transform), and the words, not their case, are what is pinned.
      const headers = await page.locator("#leaderboard-page .lb-table thead th").allTextContents();
      expect(headers.map(s => s.trim()), "all-solved is its own column, after Time to Solve")
        .toEqual(["#", "Player", "Score", "Time to Solve", "All Solved"]);

      const row = page.locator("#lb-body tr").first();
      await expect(row.locator("td")).toHaveCount(5);
      // The mark lives in the LAST cell, not crammed beside the time.
      await expect(row.locator("td").nth(4).locator(".lb-solved-pill")).toHaveCount(1);
      await expect(row.locator("td").nth(3).locator("svg"), "no tick inside the time cell any more").toHaveCount(0);
      // Meaning is not carried by colour alone.
      await expect(row.locator(".lb-solved-col .sr-only")).toHaveText(/All challenges solved/i);
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: h }).catch(() => {});
      await sa.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Server-restart vs inactivity attribution — v7.15.4 regression lock
// ═══════════════════════════════════════════════════════════════════════════════
// Reported after a production upgrade: the operator restarted the server while
// actively working and was told they had been signed out "due to inactivity".
//
// A restart regenerates SESSION_SECRET, so every request 401s at once. The
// session monitor's own 30 s tick DID compare `server_started_at` and would have
// said "Server restarted" — but the SPA's other polls are faster (leaderboard /
// admin lists at 15 s), so one of them 401'd first and hit the fetch interceptor
// in core/api.js. That path fetched /api/session/status only to read `kicked_by`,
// ignored `server_started_at`, announced "inactivity", and set
// S._sessionExpiredHandled so the monitor's correct check never ran.
//
// These tests drive the INTERCEPTOR path specifically, because testing only the
// tick would have kept passing throughout the bug.
test.describe("v7.15.4 — a restart is reported as a restart, not as inactivity", () => {
  // Make the browser believe the server restarted: every /api/session/status
  // answer carries a different server_started_at than the one the SPA snapshotted.
  async function fakeRestart(page) {
    await page.route("**/api/session/status", async (route) => {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          active: false,
          expires_at: null,
          server_started_at: new Date(Date.now() + 60_000).toISOString(), // != snapshot
          role: null, reason: null, kicked_by: null,
        }),
      });
    });
  }
  // Any authenticated endpoint 401s after a restart; this is the poll that beats
  // the 30 s monitor tick in the real failure.
  async function fake401(page, urlGlob) {
    await page.route(urlGlob, (route) => route.fulfill({
      status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not authenticated" }),
    }));
  }

  test("the fetch INTERCEPTOR (not the monitor tick) reports a restart correctly", async ({ page }) => {
    await participantLogin(page);
    // The SPA must have snapshotted a server_started_at first — that snapshot is
    // what a restart is detected against. Without it there is nothing to compare.
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    // Stop the monitor so ONLY the interceptor can produce the dialog. Without
    // this the 30 s tick consumes the same stubbed route and shows the restart
    // popup itself, and the assertion would pass even with core/api.js reverted
    // — the test would stop locking the path that actually regressed.
    await page.evaluate(() => window.stopSessionMonitor());

    await fakeRestart(page);
    await fake401(page, "**/api/me");
    // Fire a normal authenticated request through the intercepted fetch — exactly
    // what a background poll does. This must NOT be /api/session/status, or we
    // would be re-testing the monitor path instead of the one that regressed.
    await page.evaluate(() => { fetch("/api/me").catch(() => {}); });

    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 10_000 });
    expect(await page.locator("#modal-title").textContent()).toMatch(/Server restarted/i);
    expect(await page.locator("#modal-body").textContent()).not.toMatch(/inactivity/i);
  });

  test("the monitor tick still reports a restart correctly", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    await fakeRestart(page);
    await page.evaluate(async () => { await window._sessionMonTick(); });
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 10_000 });
    expect(await page.locator("#modal-title").textContent()).toMatch(/Server restarted/i);
  });

  // The fix must not swallow the other two verdicts: a genuine idle timeout is
  // still "inactivity", and being kicked is still "Signed in elsewhere". Both go
  // through the SAME classifier now, so assert it discriminates rather than
  // simply always answering "restart".
  test("an ordinary expiry (same server_started_at) is still reported as inactivity", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    // Echo back the SPA's OWN snapshot → not a restart, just a dead session.
    const snap = await page.evaluate(() => window._sessionMon.serverStartedAt);
    await page.route("**/api/session/status", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ active: false, expires_at: null, server_started_at: snap, role: null, reason: null, kicked_by: null }),
    }));
    await fake401(page, "**/api/me");
    await page.evaluate(() => { fetch("/api/me").catch(() => {}); });
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 10_000 });
    expect(await page.locator("#modal-title").textContent()).toMatch(/Signed out/i);
    expect(await page.locator("#modal-body").textContent()).toMatch(/inactivity/i);
  });

  test("being kicked is still reported as 'Signed in elsewhere' through the interceptor", async ({ page }) => {
    await participantLogin(page);
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    const snap = await page.evaluate(() => window._sessionMon.serverStartedAt);
    await page.route("**/api/session/status", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        active: false, expires_at: null, server_started_at: snap, role: null, reason: "kicked",
        kicked_by: { ip: "10.1.2.3", first_name: "Alice", last_name: "Smith", email: "alice@acme.com", at: new Date().toISOString() },
      }),
    }));
    await fake401(page, "**/api/me");
    await page.evaluate(() => { fetch("/api/me").catch(() => {}); });
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && getComputedStyle(el).display !== "none";
    }, null, { timeout: 10_000 });
    expect(await page.locator("#modal-title").textContent()).toMatch(/Signed in elsewhere/i);
    expect(await page.locator("#modal-body").textContent()).toMatch(/10\.1\.2\.3/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Code-block syntax highlighting — WCAG AA (v7.21.1)
// ═══════════════════════════════════════════════════════════════════════════════
// An external audit measured .hljs-number at 4.39:1 on the light --code-bg.
// The a11y test that surfaced it was VACUOUS by this repo's standards: it axe-
// scanned whatever code sample the fixture happened to contain, so it PASSED on
// retry simply because that run's snippet held no numeric token. A check whose
// result depends on which token types the sample happened to produce is not a
// check.
//
// This one cannot pass by luck:
//   * the token contract is DERIVED FROM THE STYLESHEETS at runtime (every
//     `.hljs-*` selector in the vendored atom-one-dark file and in styles.css),
//     so a class nobody thought to test is still measured, and a class added to
//     either sheet later is picked up with no edit here;
//   * it is UNIONED with every class hljs actually emits over a multi-language
//     corpus, so a class the sheets do not name is measured too;
//   * every class is rendered in ALL THREE roots the code-block CSS is scoped
//     to (.rich-body, #task-detail-card, #task-preview-overlay — see v7.20.4),
//     because a colour fixed in two of them and missed in the third is exactly
//     the drift that release existed to stop;
//   * and it runs in BOTH themes.
//
// Positive control: a coloured token's computed colour must DIFFER from the
// plain --code-fg. Without it, a selector that stopped matching would leave the
// token inheriting the (passing) body colour and every ratio assertion would
// hold while the highlighting was gone.

test.describe("Code-block syntax highlighting meets WCAG AA (v7.21.1)", () => {
  // v7.21.37 — moved INSIDE this describe (its only user) so it travels with
  // the block when the file is split, rather than being left between blocks.
  const HLJS_CORPUS = {
    javascript: "// tag\nconst re = /a+b/g, n = 0x1f, s = `x${n}y`;\nfunction go(a, b) { return JSON.stringify({ a, b }); }\nclass Thing extends Base {}\n",
    python: "@decorator\ndef go(a, b=2):\n    \"\"\"doc @param a\"\"\"\n    return [x for x in range(10) if x is None]\n",
    css: "#id .cls[data-x='1']:hover { color: #fff; margin: 0 10px; }\na::before { content: 'x'; }\n",
    xml: "<!DOCTYPE html>\n<!-- c -->\n<div class=\"a\" id='b'>text</div>\n",
    markdown: "# Section\n\n> quoted\n\n- bullet\n\n**bold** and *em* and [link](http://x.y) and `code`\n",
    diff: "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-gone\n+added\n",
    ruby: "# c\nclass Foo\n  SYM = :sym\n  def bar(x)\n    \"a#{x}b\" =~ /re/\n  end\nend\n",
    bash: "#!/bin/sh\n# c\nexport FOO=1\necho \"$FOO\" | grep -q x\n",
    json: '{ "a": 1, "b": "s", "c": true, "d": null }\n',
    java: "/** @param a doc */\n@Override\npublic static int go(int a) { return a + 0x10; }\n",
    sql: "SELECT COUNT(*) FROM t WHERE a = 'x' AND b > 10; -- c\n",
    php: "<?php\n$x = 'a';\nfunction go($y) { return $y . 1; }\n",
    cpp: "#include <vector>\n// c\ntemplate<class T> int go(T a) { return 1; }\n",
  };

  /** Collects, for one theme, the measured ratio of every token class. */
  async function measureTokens(page, theme, corpus) {
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    return page.evaluate(({ theme, corpus }) => {
      document.documentElement.setAttribute("data-theme", theme);

      // ── 1. The contract: every `.hljs-*` selector chain any stylesheet
      // declares. Read from document.styleSheets rather than a hand-written
      // list so a class added to either sheet is covered without editing the
      // test — the hand-written list is how the vendored-only classes
      // (.hljs-doctag, .hljs-attribute, .hljs-section, …) went unnoticed.
      const chains = new Map(); // "a.b c" -> [[classes], [classes]]
      const addChain = (segs) => {
        const key = segs.map((s) => s.join(".")).join(" ");
        if (!chains.has(key)) chains.set(key, segs);
      };
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          const sel = rule.selectorText;
          if (!sel || sel.indexOf("hljs-") < 0) continue;
          for (const part of sel.split(",")) {
            const t = part.trim();
            // Our rules are scoped `<root> pre code .hljs-x`; the vendored ones
            // are bare. Take the tail after the last `code ` so both shapes
            // reduce to the same token chain.
            const ci = t.lastIndexOf("code ");
            const tail = (ci >= 0 ? t.slice(ci + 5) : t).trim();
            if (!tail) continue;
            const segs = tail.split(/\s+/).map((seg) =>
              /^(\.[A-Za-z0-9_-]+)+$/.test(seg) ? seg.slice(1).split(".") : null);
            if (!segs.length || segs.some((s) => !s)) continue;
            if (!segs.some((s) => s.some((c) => c.indexOf("hljs-") === 0))) continue;
            addChain(segs);
          }
        }
      }

      // ── 2. Union in every class hljs really emits, so a token the sheets do
      // not name is measured too (it inherits --code-fg; that must still pass).
      const emitted = new Set();
      for (const [lang, code] of Object.entries(corpus)) {
        if (!window.hljs || !window.hljs.getLanguage(lang)) continue;
        let html;
        try { html = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; }
        catch (_) { continue; }
        // Scrape the class names out of the markup rather than parsing it:
        // under this app's strict Trusted Types policy BOTH innerHTML and
        // DOMParser.parseFromString are guarded sinks and throw.
        const re = /class="([^"]*)"/g;
        let m;
        while ((m = re.exec(html))) {
          m[1].split(/\s+/).forEach((c) => { if (c.indexOf("hljs-") === 0) emitted.add(c); });
        }
      }
      emitted.forEach((c) => addChain([[c]]));

      // ── 3. Render every chain in each of the three roots the code-block CSS
      // is scoped to, then measure.
      const roots = [];
      const cleanups = [];
      const mkPre = (host) => {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.className = "hljs language-javascript";
        pre.appendChild(code);
        host.appendChild(pre);
        return code;
      };
      // .rich-body
      const rb = document.createElement("div");
      rb.className = "rich-body";
      document.body.appendChild(rb);
      cleanups.push(() => rb.remove());
      roots.push({ name: ".rich-body", code: mkPre(rb) });
      // #task-detail-card — the real element, so we exercise the real selector.
      // It lives inside an inactive .page, so force the chain visible; computed
      // colour would resolve anyway, but a rendered box removes all doubt.
      const tdc = document.getElementById("task-detail-card");
      if (tdc) {
        const restore = [];
        for (let n = tdc; n && n !== document.body; n = n.parentElement) {
          restore.push([n, n.style.display]);
          n.style.display = "block";
        }
        cleanups.push(() => restore.forEach(([n, d]) => { n.style.display = d; }));
        const holder = document.createElement("div");
        tdc.appendChild(holder);
        cleanups.push(() => holder.remove());
        roots.push({ name: "#task-detail-card", code: mkPre(holder) });
      }
      // #task-preview-overlay — created on demand by the admin preview, so make
      // one here (none exists on this page, so no duplicate id).
      const tpo = document.createElement("div");
      tpo.id = "task-preview-overlay";
      document.body.appendChild(tpo);
      cleanups.push(() => tpo.remove());
      roots.push({ name: "#task-preview-overlay", code: mkPre(tpo) });

      const chainList = Array.from(chains.entries());
      for (const root of roots) {
        for (const [key, segs] of chainList) {
          let parent = root.code;
          let leaf = null;
          for (const classes of segs) {
            const sp = document.createElement("span");
            sp.className = classes.join(" ");
            sp.textContent = "Xy09 ";
            parent.appendChild(sp);
            parent = sp;
            leaf = sp;
          }
          leaf.dataset.tokenKey = key;
        }
      }

      // ── 4. Measure: composited background, then WCAG contrast.
      const parseRgb = (s) => {
        const m = /rgba?\(([^)]+)\)/.exec(s || "");
        if (!m) return null;
        const p = m[1].split(",").map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const over = (top, bot) => ({
        r: top.r * top.a + bot.r * (1 - top.a),
        g: top.g * top.a + bot.g * (1 - top.a),
        b: top.b * top.a + bot.b * (1 - top.a), a: 1,
      });
      const bgOf = (el) => {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const bc = parseRgb(getComputedStyle(n).backgroundColor);
          if (bc && bc.a > 0) stack.push(bc);
          if (bc && bc.a >= 1) break;
        }
        let cur = stack.length && stack[stack.length - 1].a >= 1
          ? stack.pop() : { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) cur = over(stack[i], cur);
        return cur;
      };
      const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const hexOf = (c) => "#" + [c.r, c.g, c.b].map((v) =>
        Math.round(v).toString(16).padStart(2, "0")).join("");

      const rows = [];
      for (const root of roots) {
        const baseBg = bgOf(root.code);
        const baseFg = parseRgb(getComputedStyle(root.code).color);
        const push = (key, el) => {
          const bg = bgOf(el);
          let fg = parseRgb(getComputedStyle(el).color);
          if (fg.a < 1) fg = over(fg, bg);
          const l1 = lum(fg), l2 = lum(bg);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          rows.push({ root: root.name, token: key, fg: hexOf(fg), bg: hexOf(bg),
            ratio: Math.round(ratio * 100) / 100, sameAsBase: hexOf(fg) === hexOf(baseFg) });
        };
        push("(plain code — --code-fg)", root.code);
        root.code.querySelectorAll("[data-token-key]").forEach((el) => push(el.dataset.tokenKey, el));
        void baseBg;
      }
      cleanups.forEach((f) => f());
      return { rows, emitted: Array.from(emitted).sort(), contract: chainList.map(([k]) => k).sort() };
    }, { theme, corpus });
  }

  for (const theme of ["dark", "light"]) {
    test(`every syntax-highlight token clears 4.5:1 in the ${theme} theme, in all three code-block roots`, async ({ page }) => {
      await page.goto("/");
      await page.waitForSelector("#login-email", { timeout: 10000 });
      await page.waitForFunction(() => !!window.hljs, { timeout: 20000 });

      const { rows, emitted, contract } = await measureTokens(page, theme, HLJS_CORPUS);

      // The corpus really exercised the highlighter — otherwise every class
      // below would be a synthetic span and the "does hljs emit this?" half of
      // the check would be silently absent.
      console.log(`[${theme}] hljs emitted ${emitted.length} token classes: ${emitted.join(", ")}`);
      console.log(`[${theme}] measured ${contract.length} token chains across ${new Set(rows.map(r => r.root)).size} roots`);
      for (const must of ["hljs-keyword", "hljs-string", "hljs-comment", "hljs-number"]) {
        expect(emitted, `the corpus must really produce ${must}, or this test measures only synthetic spans`).toContain(must);
      }

      // All three roots were exercised — a fix applied to two of them and
      // missed on the third is the v7.20.4 drift this guards.
      const roots = Array.from(new Set(rows.map((r) => r.root))).sort();
      expect(roots).toEqual([".rich-body", "#task-detail-card", "#task-preview-overlay"].sort());

      // POSITIVE CONTROL — the token rules actually matched. If a selector
      // stopped applying, the token would inherit the (passing) --code-fg and
      // every ratio assertion below would hold while the highlighting was gone.
      for (const root of roots) {
        for (const key of ["hljs-keyword", "hljs-string", "hljs-number", "hljs-comment"]) {
          const row = rows.find((r) => r.root === root && r.token === key);
          expect(row, `${key} was not measured in ${root}`).toBeTruthy();
          expect(row.sameAsBase, `${key} in ${root} renders as the plain code colour (${row.fg}) — the token rule is not matching`).toBe(false);
        }
      }

      const fails = rows.filter((r) => r.ratio < 4.5);
      const fmt = (r) => `${r.root} ${r.token}: ${r.fg} on ${r.bg} = ${r.ratio}:1`;
      expect(fails.map(fmt).join("\n"),
        `WCAG AA 1.4.3 requires 4.5:1 for these code tokens in the ${theme} theme`).toBe("");
    });
  }
});
