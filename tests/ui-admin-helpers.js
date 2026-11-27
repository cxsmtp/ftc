// @ts-check
//
// Shared helpers for the ui-admin* spec files (v7.21.35).
//
// ui-admin.spec.js was 4,833 lines and 143 tests — 181s of a 248s suite. A file
// never spans workers, so it was a 3-minute serial floor that no worker count
// could beat. Splitting it needed these helpers in ONE place: four copies of
// openKebab would drift, and this repo has already paid for that exact mistake
// (v7.21.25 — the hardened kebab helper lived in participant-actions-matrix and
// had never reached the naive copy in ui-admin).
//
// The bodies below were MOVED verbatim, not retyped (v7.21.26: when hoisting
// shared code, move the bytes). Two deliberate edits: `test.use()` stays in
// each spec (it is a per-file declaration), and the ./isolated-test import is
// narrowed to `expect` from @playwright/test — see the note at the import.
const { expect } = require("@playwright/test");
// PORT_BASE is used by the alice-recovery path below. It was referenced without
// being imported, so the recovery threw `ReferenceError: PORT_BASE is not
// defined` and MASKED whatever made alice fail to log in — three CI failures
// in v7.16.0's run reported the ReferenceError instead of the real cause. A
// self-heal that cannot run is worse than none: it converts a recoverable
// drift into an unexplained crash.
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, PORT_BASE, gradingHashFor, codeLogin } = require("./helpers");

// Route every page.goto() + page.request.* in this file to THIS worker's
// server (PORT_BASE + TEST_PARALLEL_INDEX) rather than a config-level default
// that would otherwise collapse all workers onto a single port.

// v8.14.0 — THE LOGIN PAGE PAINTS WITHOUT THE APP. #login-page is static markup
// carrying `active`, and theme-boot.js sets the theme, so the form, its buttons
// and their hover styles are all on screen before (and without) boot() in
// public/js/core/main.js. Acting on them first turns "the app never booted" into
// a symptom that names something else: Sign Up "does nothing" (#reg-first stays
// hidden), the page "does not follow the OS" into dark. The LAST statement of
// boot() sets <html data-booted="1">, after every delegated click handler and
// the OS-theme listener are installed, so that attribute is the readiness signal
// (source-locked as last by tests/signed-out-header.spec.js). If one module
// request of the load failed, theme-boot.js reloads the page once, inside the
// goto; this wait is what names a load that still did not boot.
async function expectSpaBooted(page, what = "the page") {
  await expect(page.locator('html[data-booted="1"]'),
    `PRECONDITION: ${what} booted the app (boot() sets html[data-booted] last; ` +
    `the login page is static markup and paints without it)`).toBeAttached({ timeout: 20000 });
}

// Submit the login form once. Used by the tests that exercise the form path
// itself (error banner, register link). The happy-path helpers below skip the
// form entirely via loginViaApi() to avoid a rare UI race under WORKERS=8
// contention where the form submit + response races produced spurious
// "Invalid email or password" banners.
// The login card is ONE email box and ONE button ("Continue").
// Only the built-in superadmin keyword reveals a password box. These three
// drive it the way a person does; the code is read back through the test-only
// GET /api/test/last-login-code.
// EMAIL FIRST. The card has one email box and Continue. Continue on an address
// asks the server which step it gets: an account that signs in with a PASSWORD
// (by default every unscoped admin) gets the password box plus "Email me a code
// instead"; every other address gets the code step. Anything that is not an
// address (the break-glass username, `superadmin` in tests) gets the password
// box alone. `fillBreakGlass` opens that step and fills the password when the
// email box holds a non-address; `submitLogin` then presses Sign in — or, for an
// address, signs in BY CODE (choosing "Email me a code instead" when the
// password step appears), reading the code back through the test-only
// GET /api/test/last-login-code. An admin with no password is then asked to
// set one; the helper answers "Keep using emailed codes" (which stores that
// choice), decided from the redeem's own `password_required`, never a timed
// probe. Specs about the password step drive it themselves.
async function fillBreakGlass(page, password) {
  const name = (await page.locator("#login-email").inputValue()).trim();
  if (!name || name.includes("@")) return;      // an address: submitLogin decides the step
  await page.locator("#login-submit").click();  // a non-address opens the password step
  await page.locator("#login-password").waitFor({ state: "visible", timeout: 5000 });
  await page.fill("#login-password", password || "");
}
async function submitLogin(page) {
  const email = (await page.locator("#login-email").inputValue()).trim();
  const btn = page.locator("#login-submit");
  await btn.waitFor({ state: "visible", timeout: 5000 });
  await btn.click();
  if (!email.includes("@")) return;             // the break-glass password step: that was Sign in
  const box = page.locator("#sc-code");
  const pwStep = page.locator("#login-password-group:not([hidden])");
  // Which step did Continue open? The code dialog, the password step, or
  // neither (an invalid address: the card shows its own error).
  const step = await Promise.race([
    box.waitFor({ state: "visible", timeout: 10000 }).then(() => "code", () => null),
    pwStep.waitFor({ state: "visible", timeout: 10000 }).then(() => "password", () => null),
  ]);
  if (!step) return;
  if (step === "password") {
    await page.locator("#login-code-instead").click();
    if (!(await box.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false))) return;
  }
  // Absolute, from the page's own origin: a spec without a baseURL (or one on a
  // spawned server) would otherwise hand page.request a bare path.
  const r = await page.request.get(new URL("/api/test/last-login-code?email=" + encodeURIComponent(email), page.url()).href);
  const code = r.ok() ? (await r.json()).code : "NOCODE00";
  await box.fill(code);
  const redeemed = page.waitForResponse((res) => res.url().includes("/api/auth/code/redeem"), { timeout: 15000 }).catch(() => null);
  await page.locator("#signin-code-overlay [data-action='signin-code-redeem']").click();
  const res = await redeemed;
  const body = res ? await res.json().catch(() => ({})) : {};
  if (body && body.ok && body.password_required) {
    const sp = page.locator("#set-password-overlay");
    await sp.waitFor({ state: "visible", timeout: 10000 });
    await sp.locator("[data-action='set-password-codes']").click();
    await sp.waitFor({ state: "detached", timeout: 10000 });
  }
}
async function login(page, email, password = "") {
  await page.goto("/");
  await expectSpaBooted(page, "the login page");
  await page.waitForSelector("#login-email", { timeout: 5000 });
  await page.fill("#login-email", email);
  await fillBreakGlass(page, password);
  await submitLogin(page);
}

// Authenticate via the JSON API on the page's BrowserContext. page.request
// shares cookies with the page, so a subsequent goto("/") loads an already-
// authenticated app — no UI form submit, no banner-timing fragility.
// Retries once with a fresh password read to absorb a live password
// rotation that lands between getSuperadminPass() and the POST.
// v7.15.23 — how long to wait when PROBING for an optional confirm dialog.
//
// A 1500 ms probe was the root cause of four CI-only failures: the modal took
// longer than that to appear on the CI runner, `isVisible` returned false, the
// confirm was never clicked, and the form then sat open until a later
// `waitFor({state:"hidden"})` timed out — reported as a form-never-closes
// failure, which points nowhere near the actual cause.
//
// The probe has to stay conditional (the confirm only appears for a LIVE
// competition), so it cannot simply become a hard wait. Instead it scales with
// the environment: unchanged locally, generous in CI. Evidence for the value —
// the CI artifact showed the overlay still visible after 16 polls across 6 s.
const CONFIRM_PROBE_MS = process.env.CI ? 8000 : 1500;

async function loginViaApi(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  // v7.15.16 — retry a THROWN transient too, not only a non-ok response. Under
  // WORKERS=8 the request can fail with ECONNRESET before any response exists,
  // which the old shape let propagate straight out and flake whichever test
  // happened to be logging in. Every admin UI test goes through here, so this
  // is the right place to absorb it.
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

// audit v7.7.35 (T2) — superadmin login on an arbitrary request context
// (page.request OR a raw newContext) with the SAME re-read-and-retry-once that
// loginViaApi does, so a global password rotation landing between the file read
// and the POST doesn't flake the test. getSuperadminPass() reads the file fresh
// on each call, so the retry naturally picks up a rotated password. Returns the
// (possibly-still-failing) response so callers can assert as they did before.
// v8.3.25 — `opts.timeout` is OPTIONAL and defaults to today's behaviour at every
// existing call site. This config sets no `actionTimeout`, so an API request
// bounded by nothing is bounded by the TEST budget; a caller doing this inside a
// `finally` (where the remaining budget may be small and the work must still
// land) can now say so rather than risk consuming all of it on one attempt.
async function saLoginRetry(reqCtx, opts = {}) {
  const _t = opts.timeout ? { timeout: opts.timeout } : {};
  const attempt = async () => {
    const { csrfToken } = await (await reqCtx.get("/api/csrf-token", _t)).json();
    return reqCtx.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() },
      ..._t,
    });
  };
  let r = await attempt();
  if (!r.ok()) r = await attempt();
  return r;
}

// Per-tab body selector used by clickTab() / adminLogin() to wait for real
// data to render before the test pokes at the DOM. Tabs whose seed rowcount
// could legitimately be zero use .catch(()=>{}) so the wait degrades to a
// best-effort nudge rather than a hard fail.
const TAB_BODY = {
  competitions: "#admin-comp-body tr",
  tasks: "#admin-task-body tr",
  participants: "#admin-participants-body tr",
  submissions: "#admin-submissions-body tr",
  rankings: "#admin-rankings-body tr",
  logs: "#admin-logs-tab tbody tr",
};

// v7.16.2 — filter the competitions table to ONE seeded fixture before looking
// it up. The table paginates at 30 rows and every spec on this worker shares a
// DB, so a seeded competition drifts off page 1 as earlier files add rows and
// the lookup then fails because the row is genuinely ABSENT. v7.15.29 fixed
// this for viewComp()/findSeededTaskRow() but left eight direct lookups behind;
// the Docs-hygiene scanner now finds them, and this is what they call.

// v8.1.0 — the single fact that separates the explanations when a competition row
// does not appear. Without it the failure reads "locator not visible", which is
// true of a model that never loaded, a filter that matched nothing, a status-chip
// set that excluded the row, and a page index pointing past the matches — four
// different searches.
async function compTableState(page, name) {
  return page.evaluate((n) => {
    const S = window.S || {};
    const data = S.adminCompetitionsData || [];
    return {
      searchBox: document.getElementById("comp-search")?.value ?? "(no box)",
      modelRows: data.length,
      modelHasName: data.some((c) => (c.name || "").includes(n)),
      matchStatuses: data.filter((c) => (c.name || "").includes(n)).map((c) => c.status),
      chipFilters: [...(S.compStatusFilters || [])],
      page: S.cPage,
      domRows: document.querySelectorAll("#admin-comp-body tr").length,
      tbody: (document.getElementById("admin-comp-body")?.innerText || "").replace(/\s+/g, " ").slice(0, 200),
    };
  }, name);
}

// Wait until the competitions MODEL has loaded before typing into the search box.
// Typing first is a real race: the input handler re-renders from
// `S.adminCompetitionsData`, so a fill that lands before the first
// loadAdminCompetitions resolves filters an empty array.
async function awaitCompModel(page) {
  await expect
    .poll(() => page.evaluate(() => (window.S?.adminCompetitionsData || []).length), { timeout: 20000 })
    .toBeGreaterThan(0);
}

// v8.1.0 — a name search must not be defeated by the STATUS CHIPS.
//
// Root-caused from the diagnostic below, after three earlier hardenings had
// guessed at timing: the seeded "Test Live" competition had ENDED by the time a
// long file reached this test, and the Competitions table defaults its chips to
// live+upcoming — so the row was in the model (`modelHasName: true`,
// `matchStatuses: ["ended"]`) and filtered out of the DOM, and the table read
// "No events match the current search."
//
// The chips are a BROWSING filter; these helpers exist to narrow to one named
// competition, so an ended one must still be findable. Applied as a FALLBACK
// rather than a default, so no currently-passing caller changes behaviour.
async function _clearCompStatusChips(page) {
  await page.evaluate(() => {
    if (window.S && window.S.compStatusFilters) window.S.compStatusFilters.clear();
    if (typeof window.renderAdminCompetitions === "function") window.renderAdminCompetitions();
  });
}
// v8.12.3 — DECIDE THE CHIPS BEFORE WAITING, not after. The fallback below
// waits the full 15 s for a row the chips are CERTAIN to hide before clearing
// them, so every lookup of an ENDED event paid 15 s for nothing — measured at
// ~16 s a test in staff-compete-admin-ui, five times over, which alone pushed
// that file past the per-file budget when the default rose to 24 workers. The
// model already knows: if every competition matching the name sits in a
// category the chips exclude, clear them first. Same end state as the fallback
// (which stays, for a model that changes under the fill), reached at once.
async function _unhideNamedComp(page, name) {
  const hidden = await page.evaluate((n) => {
    const S = window.S || {}, f = S.compStatusFilters;
    if (!f || !f.size || typeof window.compDisplayCategory !== "function") return false;
    const m = (S.adminCompetitionsData || []).filter((c) => (c.name || "").includes(n));
    return m.length > 0 && !m.some((c) => f.has(window.compDisplayCategory(c)));
  }, name);
  if (hidden) await _clearCompStatusChips(page);
}

/**
 * v9.2.4 — run `act`, then wait until it has RE-RENDERED the table body
 * `bodySel`.
 *
 * An admin table renders by replacing every row of its tbody (`setSafeHtml`),
 * whether the render comes from its search box's 160 ms debounce or a load.
 * NOT the Events table: since v9.2.5 it keeps every row unchanged at its place
 * (ui/list-controls.js patchTableRows), so a render that changed nothing
 * removes no mark and this would wait in vain; its witness is
 * narrowEventsTable's render record. A press that goes down on a row and comes up on that row's replacement
 * gets no click: Chromium sends pointerdown, mousedown, pointerup and mouseup,
 * and no click event, so the dialog never opens and nothing fails until the
 * next assertion (phase3-ui on main CI, 21 Nov 2026; measured with a held
 * press). Playwright reports the click done: its hit-target check sees only the
 * press. A wait for the row to be visible is no witness when the row was on
 * screen before the render: the unfiltered first page often holds it.
 *
 * The witness: every row on screen before `act` is marked (a JS property, so no
 * MutationObserver fires), and the table has re-rendered once no marked row is
 * left. That proves A render ran after `act`; call it with no other render of
 * the table pending (no search typed without waiting, no load in flight), or
 * the one it sees may be that one.
 */
async function rerenderedAfter(page, bodySel, act, { timeout = 15000 } = {}) {
  const body = page.locator(bodySel);
  await body.evaluate((tb) => { for (const tr of tb.rows) tr.__beforeAct = true; });
  await act();
  await expect.poll(() => body.evaluate((tb) => tb.rows.length > 0 && [...tb.rows].every((tr) => !tr.__beforeAct)), { timeout })
    .toBe(true)
    .catch(async (e) => {
      const state = await body.evaluate((tb) => ({
        rows: tb.rows.length,
        marked: [...tb.rows].filter((tr) => tr.__beforeAct).length,
        text: (tb.innerText || "").replace(/\s+/g, " ").slice(0, 200),
      })).catch((x) => String(x));
      throw new Error(`rerenderedAfter("${bodySel}"): the table did not re-render after the action. State: ${JSON.stringify(state)}\n${e.message}`);
    });
}

/**
 * v9.2.4 — narrow the Groups table to `query`, returning only once the table
 * has re-rendered for it, so a row's button can be pressed. The one way specs
 * type into `#groups-search` (scanner: functional-core-b Docs hygiene).
 *
 * It first waits for the tab's first load to render (the tbody is empty until
 * then), so it may be called straight after opening the tab. A later reload
 * (the tab opened again, or a group created, renamed or deleted through the UI)
 * must be waited for by the caller, with rerenderedAfter around the act that
 * starts it: a reload landing after the typing re-renders the rows again.
 */
async function narrowGroupsTable(page, query) {
  await expect(page.locator("#groups-tbody tr").first(), "the Groups table's first load has rendered").toBeAttached({ timeout: 15000 });
  const search = page.locator("#groups-search");
  if ((await search.inputValue()) === query) return;
  await rerenderedAfter(page, "#groups-tbody", () => search.fill(query));
}

/**
 * v9.2.5 — narrow the Challenges table to `query`, returning only once the
 * table has re-rendered for it (rerenderedAfter), so a row may be pressed. The
 * one way specs type into `#task-search` (scanner: functional-core-b Docs
 * hygiene). It first waits for the tab's newest load to render: loadAdminTasks
 * shows skeleton rows while its read is in flight and holds no loading count,
 * so "no skeleton row left" is the witness that it has landed.
 */
async function narrowChallengesTable(page, query) {
  const body = page.locator("#admin-task-body");
  await expect.poll(() => body.evaluate((tb) => tb.rows.length > 0 && !tb.querySelector(".skeleton-row")),
    { timeout: 15000, message: "the Challenges table's load has rendered (no skeleton row left)" }).toBe(true);
  const search = page.locator("#task-search");
  if ((await search.inputValue()) === query) return;
  await rerenderedAfter(page, "#admin-task-body", () => search.fill(query));
}

/**
 * v9.2.5 — narrow the People table (the Participants section inside an event
 * workspace too) to `query`, returning only once the table has re-rendered for
 * it. The one way specs type into `#participants-search` (scanner:
 * functional-core-b Docs hygiene). loadAdminParticipants holds the shared
 * loading count and renders in the step that releases it, so a count of 0 with
 * a row on screen means its newest load has rendered. Like every narrowing
 * helper it returns at once when the box already holds `query`, so call it
 * only where nothing else has just typed into the box (admin-crossnav's jump
 * does, and leaves its render pending).
 */
async function narrowPeopleTable(page, query) {
  await _awaitNoAdminLoad(page);
  await expect(page.locator("#admin-participants-body tr").first(), "the People table has rendered").toBeAttached({ timeout: 15000 });
  const search = page.locator("#participants-search");
  if ((await search.inputValue()) === query) return;
  await rerenderedAfter(page, "#admin-participants-body", () => search.fill(query));
}

// v9.2.4 — no Events load in flight, before typing: a load landing after the
// typing re-renders the rows again, and `clickTab(page, "Events")` just before a
// lookup starts one (adminTab reloads on every press). loadAdminCompetitions
// holds the shared loading counter for its fetch and renders in the same step
// that releases it, so a count of 0 means the newest load has rendered. A load
// the 15 s poll starts later is not covered.
async function _awaitNoAdminLoad(page) {
  await expect.poll(() => page.evaluate(() => (window.S && window.S._loadingCount) || 0),
    { timeout: 15000, message: "an admin load is still in flight (S._loadingCount)" }).toBe(0);
}

/**
 * v9.2.5 — run `act` (typing `query` into the box), then wait until the Events
 * table has RENDERED for `query` since.
 *
 * The Events table keeps every row unchanged at its place (its 15 s poll used
 * to replace them all, losing a press that straddled a tick), so marking rows
 * (rerenderedAfter) cannot see a render that changed nothing. The witness is
 * what renderAdminCompetitions records: a render count past the one before
 * `act` AND the search text that render filtered by (a poll render landing
 * just before the typing raises the count with the old text). Every render
 * reads the box, so once one has drawn `query`, a later one (the debounce's
 * own, a poll's) draws the same rows and replaces none.
 */
async function _compRenderedAfter(page, act, query, { timeout = 15000 } = {}) {
  const want = String(query).toLowerCase().trim();
  const seen = () => page.evaluate(() => ({ n: (window.S && window.S._compRenders) || 0, q: window.S ? window.S._compRenderedQuery : null }));
  const before = (await seen()).n;
  await act();
  await expect.poll(async () => { const s = await seen(); return s.n > before && s.q === want; },
    { timeout, message: "the Events table rendered for the typed text after the typing (S._compRenders, S._compRenderedQuery)" }).toBe(true);
}

/**
 * v9.2.5 — narrow the Events table to `query`, returning only once the table
 * has rendered for it, so a row may be pressed. The one way specs type into
 * `#comp-search` (scanner: functional-core-b Docs hygiene); filterComps and
 * viewComp narrow through it. It waits for the model and for no load in
 * flight first (a load landing after the typing would render again).
 */
async function narrowEventsTable(page, query) {
  // The list answered (an empty one too: S._adminCompsLoaded), and no load is
  // still in flight.
  await expect.poll(() => page.evaluate(() => !!(window.S && window.S._adminCompsLoaded)),
    { timeout: 20000, message: "the Events list has loaded (S._adminCompsLoaded)" }).toBe(true);
  await _awaitNoAdminLoad(page);
  const search = page.locator("#comp-search");
  if ((await search.inputValue()) === query) return;
  await _compRenderedAfter(page, () => search.fill(query), query);
}

async function filterComps(page, name) {
  if (!(await page.locator("#comp-search").count())) return;
  await awaitCompModel(page);
  await _awaitNoAdminLoad(page);
  await _unhideNamedComp(page, name);
  await narrowEventsTable(page, name);
  // v9.2.4 — the RENDER the typing causes, not merely a visible row: the row
  // is often on the unfiltered first page, and a caller's press can straddle
  // that render and be lost (narrowEventsTable).
  // v8.1.0 — DO NOT SWALLOW THIS. It used to end in `.catch(() => {})`, so a
  // filter that never landed carried on silently and the failure surfaced later
  // at the caller's own `expect(row).toBeVisible()` as a bare "element(s) not
  // found" — true of a model that never loaded, a filter that matched nothing, a
  // status-chip set that excluded the row and a page index past the matches, with
  // nothing to say which. Fail HERE, as a precondition, naming the state.
  await page.locator(`#admin-comp-body tr:has-text('${name}')`).first()
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(async () => {
      await _clearCompStatusChips(page);
      await page.locator(`#admin-comp-body tr:has-text('${name}')`).first()
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(async (e2) => {
          throw new Error(`filterComps("${name}"): the row never appeared, even with the status chips cleared. State: ${JSON.stringify(await compTableState(page, name))}\n${e2.message}`);
        });
    });
}

// v7.23.5 — this used to be login → goto → `waitFor('#admin-page')`, and when
// the session did not survive the navigation it failed as a bare 30 s locator
// timeout ("62 × resolved to hidden"), naming nothing. The page snapshot showed
// the LOGIN FORM, i.e. the wrong VIEW rather than a slow one (the v7.22.0 rule)
// — but a snapshot only exists if you go looking for the artefact, and this
// helper is used by most admin specs, so the cost is paid repeatedly.
//
// NO MECHANISM WAS CLAIMED for that sighting. v8.14.0 found one that produces
// exactly this picture: a single SPA module request failing in transit leaves
// the app unbooted, and the static login page is what stays on screen
// (theme-boot.js now reloads such a page once; see expectSpaBooted). What this
// helper fixes is the DIAGNOSIS: the session is asserted live immediately
// before the navigation, and the wait afterwards distinguishes "routed to
// login" from "still booting" instead of reporting both as the same timeout.
async function adminLogin(page) {
  await loginViaApi(page, "superadmin", getSuperadminPass());
  // Precondition, asserted rather than assumed: loginViaApi can return having
  // succeeded on a retry, and anything that invalidates the session between the
  // POST and the goto otherwise surfaces 30 s later pointing at the wrong thing.
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `the superadmin session was not live before goto("/"): `
    + `${meR.status()} ${await meR.text()}`).toBeTruthy();
  // v8.13.4 — record what BOOT saw, because the failure below was seen a second
  // time with the session live both before the goto and after the timeout, so
  // boot's own requests are the only thing left that can explain it: boot routes
  // a built-in superadmin through /api/me (401 by design) then /api/admin/me,
  // and stays on the login page if the second is not ok or if boot throws. A
  // listener costs nothing on the passing path and is detached either way.
  const bootSeen = [];
  const onResp = (r) => {
    const u = r.url();
    if (/\/api\/(me|admin\/me|csrf-token|config)(\?|$)/.test(u)) bootSeen.push(`${r.request().method()} ${new URL(u).pathname} ${r.status()}`);
  };
  const onFail = (rq) => {
    // /js/ too: one failed module request means boot never ran at all.
    if (/\/(api|js)\//.test(rq.url())) bootSeen.push(`FAILED ${new URL(rq.url()).pathname}: ${rq.failure() && rq.failure().errorText}`);
  };
  const onErr = (e) => bootSeen.push(`pageerror: ${e.message}`);
  page.on("response", onResp); page.on("requestfailed", onFail); page.on("pageerror", onErr);
  await page.goto("/");
  // Wait for the END state, then describe it only if it never arrives.
  //
  // An either-or poll CANNOT be used here, and the first draft of this helper
  // got it wrong: #login-page carries `active` in index.html and therefore
  // paints on EVERY load (v7.15.5), so "whichever view appears first" answers
  // "login" from frame one, before boot has routed anywhere. It reported 19
  // healthy admin specs as broken. The wait must be for #admin-page; the
  // diagnosis belongs in the .catch(), which is the only place that can
  // describe where the app actually ended up (the v7.22.7 rule).
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 })
    .catch(async (e) => {
      const end = await page.evaluate(() => {
        const shown = [...document.querySelectorAll(".page")]
          .filter(el => getComputedStyle(el).display !== "none")
          .map(el => el.id);
        return { shown, booting: document.documentElement.className };
      }).catch(() => null);
      const live = await page.request.get("/api/admin/me")
        .then(r => `${r.status()}`).catch(err => `threw ${err.message}`);
      throw new Error(`${e.message}\n`
        + `  the admin panel never rendered. visible .page ids: ${JSON.stringify(end && end.shown)}; `
        + `html class: ${JSON.stringify(end && end.booting)}; `
        + `GET /api/admin/me at failure time: ${live} `
        + `(a live 200 here means the SPA failed to route, NOT that the session died); `
        + `what boot saw: ${JSON.stringify(bootSeen)}`);
    })
    .finally(() => { page.off("response", onResp); page.off("requestfailed", onFail); page.off("pageerror", onErr); });
  await page.locator(TAB_BODY.competitions).first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
}

// v6.10.29: belt-and-braces self-heal. A prior test in the same worker
// might have left alice blocked / locked / removed from Test Live — the
// explicit try/finally patches in v6.10.27 and v6.10.29 closed every
// known drift source, but this helper now also refuses to proceed on a
// drifted state: it force-unblocks alice + re-assigns her to Test Live
// + primes `active_competition_id` on any path where the first login
// attempt fails. One-shot recovery; the second login is authoritative.
async function participantLogin(page) {
  // v6.13.16 — pre-login DB-direct fixup. Under WORKERS=4, alice's
  // users-row state is cross-contaminated by sibling test files in
  // the same worker (functional-core tests mutate her
  // active_competition_id via /api/select-competition into
  // upcomingComp / endedComp; mutations-* tests may remove her from
  // liveComp's competition_users; etc). Post-login auto-resume then
  // picks up whatever state is on the row, which is anything BUT the
  // live-comp alice these UI tests need. Do one short DB-direct
  // repair BEFORE login: ensure alice is enrolled in liveComp and
  // her active_competition_id points at it. Idempotent. ~3-5 ms.
  try {
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const dbFix = new Database(TEST_DB_PATH);
    try {
      const alice = dbFix.prepare("SELECT id FROM users WHERE email='alice@acme.com'").get();
      const live = dbFix.prepare("SELECT id FROM competitions WHERE name='Test Live'").get();
      if (alice && live) {
        dbFix.prepare(
          "INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?, ?, 'system', ?)"
        ).run(live.id, alice.id, new Date().toISOString());
        dbFix.prepare("UPDATE users SET active_competition_id=?, blocked=0, locked_until=NULL, failed_login_count=0, failed_login_first=NULL WHERE id=?")
          .run(live.id, alice.id);
      }
    } finally { dbFix.close(); }
  } catch (_) { /* best-effort only */ }
  try {
    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
  } catch (e) {
    // Recovery path — rewrite alice to a known-good state via
    // superadmin + DB. Rare enough that the overhead doesn't
    // burden every test run.
    const { request } = require("./isolated-test");
    const baseURL = `http://localhost:${PORT_BASE + parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10)}`;
    const api = await request.newContext({ baseURL });
    try {
      const Database = require("better-sqlite3");
      const { TEST_DB_PATH } = require("./helpers");
      const dbW = new Database(TEST_DB_PATH);
      const alice = dbW.prepare("SELECT id FROM users WHERE email='alice@acme.com'").get();
      if (alice) {
        dbW.prepare("UPDATE users SET blocked=0, locked_until=NULL, failed_login_count=0, failed_login_first=NULL WHERE id=?").run(alice.id);
      }
      dbW.close();
      // Re-assign alice to Test Live via admin API so active_competition_id
      // lands on the live comp (auto-resume on next login).
      await saLoginRetry(api); // audit v7.7.35 (T2)
      const csrf2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const comps = await (await api.get("/api/admin/competitions")).json();
      const live = comps.find(c => c.name === "Test Live");
      if (alice && live) {
        await api.post("/api/admin/competitions/assign", {
          headers: { "x-csrf-token": csrf2, "content-type": "application/json" },
          data: { userIds: [alice.id], competitionIds: [live.id] },
        });
      }
    } catch (_) { /* recovery best-effort */ }
    finally { await api.dispose(); }
    // Retry the original login once. If it still fails, propagate.
    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
  }
  // v6.13.16 — force alice's active competition to "Test Live" before
  // any downstream test assertion runs. Under WORKERS=4, other test
  // files in the same worker slot (functional-core, mutations-*) may
  // have Alice call /api/select-competition with upcomingComp or
  // endedComp for their own scenarios. That persists alice.users.
  // active_competition_id and the next login auto-resumes into the
  // wrong comp — a participant UI test then navigates to Challenges
  // / Leaderboard and hits "competition hasn't started yet" instead
  // of the seed's live-comp task list. Explicit select-competition
  // after login collapses this state variance to "always live" for
  // every participant UI test. Best-effort: if the call fails
  // (Alice not enrolled in Test Live on a freshly rebuilt DB) the
  // test proceeds with whatever state it has.
  try {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const compsBody = await (await page.request.get("/api/my-competitions")).json();
    const liveId = (compsBody.competitions || []).find(c => c.name === "Test Live")?.id;
    if (liveId) {
      await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
        data: { competitionId: liveId },
      });
    }
  } catch (_) { /* best-effort only */ }
  await page.goto("/");
  await page.locator("#comp-grid .comp-card, .nav-btn").first().waitFor({ state: "visible", timeout: 30000 });
}

// v8.7.5 — the pane SLUG for a tab's logical name. The two remaps are the two
// places where the DOM id and the display label have deliberately diverged:
// "Challenges" has always been `admin-tasks-tab` (the code term is `tasks`), and
// the Events tab keeps `admin-competitions-tab` because DOM ids are identifiers
// and the `competitions` table is what it lists. Both spellings of the latter
// resolve, so this helper is stable across the label rename itself.
const TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions" };

/** Click an admin tab by name and wait for the sub-pane + first data row. */
async function clickTab(page, name) {
  // EVENT WORKSPACES. While an event is open (viewComp / focusOwnLiveComp), its
  // Participants / Challenges / Rankings / Submissions / Analytics are the
  // workspace's OWN section tabs (#ws-tabs), which keep the event; the sidebar
  // item of the same pane is the cross-event page and closes the workspace. A
  // spec that opened an event and asks for "Participants" means the event's —
  // what the old focus gave it — so route through the workspace tab here.
  {
    const _slug = TAB_SLUG[name.toLowerCase()] || name.toLowerCase();
    const wsBtn = page.locator(`#ws-tabs .ws-tab[data-section="admin-${_slug}-tab"]`);
    if (await page.locator("#admin-workspace:not([hidden])").count() && await wsBtn.count()) {
      await wsBtn.evaluate((el) => el.click());
      await page.locator(`#admin-${_slug}-tab`).waitFor({ state: "visible", timeout: 5000 });
      const bodySel = TAB_BODY[_slug];
      if (bodySel) await page.locator(bodySel).first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
      return;
    }
  }
  // On mobile the sidebar is fixed off-screen. Open it via the hamburger button
  // (which IS in the viewport at narrow widths), wait for the slide-in, then click.
  // Only while the drawer is CLOSED: since v8.12.6 the button sits below the open
  // drawer's scrim, so clicking it then fails actionability instead of re-opening.
  const hamburger = page.locator("#admin-mobile-menu-btn");
  if (await hamburger.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await hamburger.click();
  // Sub-pane ids: "admin-{competitions,tasks,participants,submissions,rankings,logs,settings}-tab".
  const slug = TAB_SLUG[name.toLowerCase()] || name.toLowerCase();
  // v8.7.5 — RESOLVE BY `data-tab-id`, NOT BY THE VISIBLE LABEL.
  //
  // `has-text('${name}')` coupled every navigation in the suite to display copy,
  // so renaming one sidebar label would have churned 68 call sites and 15 raw
  // selectors — and a test that changes for a copy edit hides whether the edit
  // changed behaviour (the v7.17.1 rule). The id is the identifier and does not
  // move; the label is copy and does. Specs that mean to assert the LABEL should
  // assert it explicitly rather than rely on navigation succeeding.
  // RBAC sidebar — Submissions and Logs have no sidebar item (Audit covers both;
  // its Raw logs switch and the workspace's Activity tab open them). Their panes
  // keep their ids, so those two are opened through the shell's own adminTab.
  if (slug === "submissions" || slug === "logs") {
    await page.locator("#admin-page").waitFor({ state: "visible" });
    await page.evaluate((id) => window.adminTab(null, id), `admin-${slug}-tab`);
  } else {
    // The sidebar items are static markup, attached before boot has read who is
    // signed in: a press before #admin-page shows runs the pane's loader with no
    // role facts, so every permission-gated card stays hidden (seen as a Settings
    // pane with every section unlisted after a reload under full-suite load).
    // Admin is ready once #admin-page is visible, never once nav items attach.
    await page.locator("#admin-page").waitFor({ state: "visible" });
    const btn = page.locator(`button.admin-nav-item[data-tab-id="admin-${slug}-tab"]`).first();
    // Use locator.evaluate to fire the click inside the page context, bypassing
    // Playwright's "must be in viewport" actionability check (the event delegation
    // at document level handles clicks regardless of position).
    await btn.waitFor({ state: "attached" });
    await btn.evaluate((el) => el.click());
  }
  await page.locator(`#admin-${slug}-tab`).waitFor({ state: "visible", timeout: 5000 });
  const bodySel = TAB_BODY[slug];
  if (bodySel) {
    await page.locator(bodySel).first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
  }
}

/**
 * Open the kebab on a row-like locator and wait for the portal menu to render.
 *
 * v7.21.25 — hardened, because the naive single-click-then-wait is a known flake
 * shape this repo has already solved ONCE, in participant-actions-matrix.spec.js
 * (v7.20.2 / v7.21.3) — and the hardening never reached this copy. Three ways a
 * single click leaves the portal hidden, all seen under load and none of them a
 * product defect:
 *   • the kebab is a TOGGLE, so a click while OUR menu is open closes it;
 *   • toggleKebab() closes whatever is open first, so a click landing while
 *     another row's menu is up is spent on closing that one;
 *   • the admin tables re-render on a 15 s poll and on the search debounce, so a
 *     click landing on a row being replaced opens nothing.
 * Closing first makes each attempt deterministic (closed → click → open), and an
 * EMPTY portal is treated as NOT open: `isVisible` cannot tell an empty menu from
 * a closed one, so it would otherwise read as success and fail later on a missing
 * item.
 */
async function openKebab(page, row) {
  const portal = page.locator("#kebab-portal");
  const btn = row.locator(".kebab-btn").first();
  await expect(async () => {
    if (await portal.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await expect(portal).toBeHidden({ timeout: 2000 });
    }
    await btn.click({ timeout: 3000 });
    await expect(portal).toBeVisible({ timeout: 2000 });
    expect(await portal.locator("[data-action], button, a").count(),
      "the portal is open but empty — toggleKebab never populated it").toBeGreaterThan(0);
  }).toPass({ timeout: 20000, intervals: [200, 400, 800] });
}

/**
 * v7.15.29 — find a SEEDED row in a paginated admin table.
 *
 * Both admin tables paginate at 30 rows (S.tPageSize / S.cPageSize) and every
 * spec file running on the same worker shares one server + DB. Once earlier
 * files have created enough challenges or competitions, the seeded fixtures
 * these tests look for fall off page 1 and the lookup fails — which subset
 * fails depends on how Playwright happened to distribute files across workers,
 * so it varies with WORKERS and shows up only in CI.
 *
 * Filtering first makes the lookup independent of whatever else has run.
 */
async function findSeededTaskRow(page, title) {
  // v8.12.4 / v9.2.5 — the FILTERED render, not merely a visible match: a
  // just-created challenge is often already on the unfiltered first page, and
  // the debounced render then replaces it (narrowChallengesTable).
  if (await page.locator("#task-search").count()) await narrowChallengesTable(page, title);
  return page.locator(`#admin-task-body tr:has-text('${title}')`);
}

/**
 * Inside an event workspace the Participants section lists the event's own
 * people; "Everyone (to add)" lists every account, members first — what the
 * old focused pane showed. A no-op outside a workspace.
 */
async function showEveryoneInWorkspace(page) {
  // "Search everyone on the platform" — a checkbox beside the search.
  const cb = page.locator('#p-ws-scope:not([hidden]) #p-ws-everyone');
  if (!(await cb.count())) return;
  if (!(await cb.isChecked())) await cb.check();
  await expect(cb).toBeChecked();
}

/**
 * The admin lists keep their filter chips in a "Filters" panel (closed by
 * default, open state remembered per browser). Specs that click the chips
 * directly open every panel first; call before the first page.goto. At 768 px
 * or narrower it does nothing (a page load never opens the phone sheet): a spec
 * there presses the list's Filters button instead.
 */
async function openFilterPanels(page) {
  await page.addInitScript(() => {
    try {
      for (const id of ["comp-filters-panel", "p-filters-panel", "task-filters-panel"]) localStorage.setItem(`ha:filters-open:${id}`, "1");
    } catch (_) { /* no storage: the panels stay closed */ }
  });
}

/**
 * The Participants table shows six columns by default (a per-browser chooser
 * adds the rest). Specs that act inside Email / Tags / Groups / Events cells
 * show every column first; call before the first page.goto.
 */
async function showAllParticipantColumns(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("ha:p-cols", JSON.stringify(["participant", "email", "company", "title", "location", "source", "status", "score",
        "registered", "approved", "approver", "invited", "inviter", "role", "first_login", "last_active", "events", "tags", "groups", "actions"]));
    } catch (_) { /* no storage: the default six stay */ }
  });
}

/**
 * Settings is two panes: a section list beside ONE section (settings-admin.js
 * installSettingsShell). A spec acting on a card outside the default Platform
 * section picks that section first. Clicked through the page (the list is
 * display:none on phones, where the <select> stands in), then waits until the
 * section is the one on screen. Keys: platform, look, accounts, email,
 * certificates, cxone, data, alerts, breakglass.
 */
async function openSettingsSection(page, key) {
  // Listed items only: a section with nothing to show keeps a hidden item.
  const btn = page.locator(`#settings-section-list li:not([hidden]) > [data-action="settings-section"][data-section="${key}"]`);
  // An unlisted section has been seen once under full-suite load and never in
  // isolation: on failure, print what the page held (which pane is active, the
  // section's cards and their display, the role facts the cards are offered
  // from), so the next sighting names its cause.
  await btn.waitFor({ state: "attached", timeout: 15000 }).catch(async (e) => {
    const state = await page.evaluate((k) => {
      const S = window.S || {};
      const sec = document.querySelector(`#admin-settings-tab .settings-section[data-settings-section="${k}"]`);
      return {
        shownPanes: [...document.querySelectorAll("[id^='admin-'][id$='-tab']")].filter((t) => t.tagName === "DIV" && t.style.display !== "none").map((t) => t.id),
        currentNav: (document.querySelector(".admin-nav-item[aria-current='page'], .admin-nav-item.active") || {}).dataset?.tabId || null,
        listed: [...document.querySelectorAll("#settings-section-list li")].map((li) => `${li.querySelector("[data-section]")?.dataset.section}${li.hidden ? "(hidden)" : ""}`),
        cards: sec ? [...sec.querySelectorAll(".settings-card")].map((c) => `${c.id || "?"}:${c.style.display || "shown"}`) : "no such section",
        isAdmin: S.isAdmin, isSuperAdmin: S.isSuperAdmin, isEventAdmin: S.isEventAdmin,
        permissions: Array.isArray(S.permissions) ? S.permissions.length : S.permissions,
        overlays: [...document.querySelectorAll("[role=dialog], .modal-overlay, #modal-overlay")].filter((o) => o.offsetParent !== null).map((o) => o.id || o.className),
      };
    }, key).catch((pe) => `state unreadable: ${pe.message}`);
    throw new Error(`openSettingsSection("${key}"): the section was never listed. Page state: ${JSON.stringify(state)}\n${e.message}`);
  });
  await btn.evaluate((el) => el.click());
  await page.locator(`#admin-settings-tab .settings-section[data-settings-section="${key}"]`)
    .waitFor({ state: "visible", timeout: 10000 });
}

/** Show every column of a shared-component admin table (ui/table-columns.js),
 *  per browser, before the first goto: a spec that acts in a column past the
 *  table's default set. `keys` are the column keys (th data-col / data-tcol). */
async function showAllTableColumns(page, table, keys) {
  await page.addInitScript(([t, k]) => {
    try { localStorage.setItem(`ha:tcols:${t}`, JSON.stringify(k)); } catch (_) { /* no storage: defaults stay */ }
  }, [table, keys]);
}
const CHALLENGE_ALL_COLUMNS = ["_select", "title", "difficulty", "type", "status", "attachments", "feedback", "last_changed", "changed_by", "author", "tags", "events", "actions"];
const EVENT_ALL_COLUMNS = ["name", "start", "end", "duration", "status", "tags", "participants", "challenges", "sessions", "actions"];

/** Scope to a competition by clicking its name cell (same as old "View" button) */
async function viewComp(page, name) {
  // v7.15.29 — FILTER FIRST. The competitions table paginates at 30 rows
  // (S.cPageSize), and this helper used to click a row on whatever page
  // happened to be showing. Every spec file that runs on the same worker shares
  // one server + DB, so once the accumulated competition count passes 30 the
  // seeded rows fall off page 1 and every caller of this helper times out.
  //
  // That is worker-count dependent, which is why it appeared only in CI: at
  // WORKERS=8 locally, ui-admin lands on a worker with little accumulated data;
  // at WORKERS=4 it shares with more files. It is also why WORKERS=2 made CI
  // strictly WORSE — fewer workers means more files per worker, so more rows.
  // v8.1.0 — wait for the MODEL before typing. Seen flaky twice: the fill fires
  // the input handler, which re-renders from `S.adminCompetitionsData`, so a fill
  // that lands before the first load resolves filters an empty array.
  //
  // It runs BEFORE the locator so the locate-and-fill stay adjacent: the
  // v7.17.2 narrowing scanner requires `.fill(` within 200 characters of the
  // search selector, and it is right to be strict — a helper credited with
  // narrowing that stopped narrowing would wave every call site through.
  if (await page.locator("#comp-search").count()) { await awaitCompModel(page); await _awaitNoAdminLoad(page); await _unhideNamedComp(page, name); }
  if (await page.locator("#comp-search").count()) {
    await narrowEventsTable(page, name);
    // The list re-renders on input; v9.2.4 — wait for THAT render (above), as
    // the row is often visible before it and the click below would straddle it.
    await page.locator(`#admin-comp-body tr:has-text('${name}')`).first()
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(async () => {
        await _clearCompStatusChips(page);
        await page.locator(`#admin-comp-body tr:has-text('${name}')`).first()
          .waitFor({ state: "visible", timeout: 10000 })
          .catch(async (e2) => {
            throw new Error(`viewComp("${name}"): the row never appeared, even with the status chips cleared. State: ${JSON.stringify(await compTableState(page, name))}\n${e2.message}`);
          });
      });
  }
  await page.locator(`#admin-comp-body tr:has-text('${name}') td`).first().click();
  // The row opens the event's WORKSPACE (on its Overview); the workspace's live
  // status strip is #admin-scope-banner, as the focus banner was.
  // v8.1.0 — the focus is a PRECONDITION, not a nicety, and swallowing it is why
  // a failure here surfaced two tabs away. `#add-tasks-to-comp-btn` renders only
  // when a competition is focused (v7.12.2), so an unfocused viewComp presents
  // later as "resolved to hidden <button …>" in a test about something else
  // entirely — which is exactly how it was reported.
  await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 10000 })
    .catch(async (e) => {
      throw new Error(`viewComp("${name}"): the row was clicked but no competition became focused. State: ${JSON.stringify(await compTableState(page, name))}\n${e.message}`);
    });
}
// Hoisted from the middle of the old ui-admin.spec.js (v7.21.35). It sat at
// line 1643, between two describes — the split refused to run until it moved,
// because a binding declared outside every describe belongs to whichever file
// happens to inherit it, and the others would fail at run time with a bare
// ReferenceError. Shared here so the axe gate has ONE definition.
const { AxeBuilder } = require("@axe-core/playwright");
const AXE_GATED_IMPACTS = new Set(["moderate", "serious", "critical"]);


/**
 * v8.1.0 — the ONE way a spec enters the Analytics tab.
 *
 * There were three locator shapes across eight files (clickTab, a nav-item
 * has-text click, and a data-tab-id click), which is why a change to what the
 * pane does on entry could not be absorbed in one place. Unified FIRST, as a
 * pure no-behaviour-change refactor, so the change that follows is a small diff
 * instead of a 33-test hunt.
 */
async function openAnalyticsTab(page) {
  // Inside an event workspace, its OWN Analytics section (which keeps the event
  // and adopts it); otherwise the sidebar's cross-event Analytics page.
  const _ws = page.locator("#admin-workspace:not([hidden]) #ws-tabs [data-section='admin-analytics-tab']");
  const btn = (await _ws.count()) ? _ws : page.locator("button[data-tab-id='admin-analytics-tab']").first();
  await btn.waitFor({ state: "attached" });
  await page.evaluate(() => { const el = document.getElementById("analytics-summary"); if (el) el.textContent = ""; });
  await btn.evaluate((el) => el.click());
  await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 10000 });
  // v8.1.0 (PR 21) — the pane now opens UNSCOPED and issues no aggregate until the
  // admin says what to measure, so a spec that expects rows must choose a scope.
  // Taking the prompt's own "Show platform-wide" action keeps these tests on a
  // real path rather than poking client state — and the `if` matters: when a
  // competition is FOCUSED, v7.22.3's adoption has already set a scope, the prompt
  // never renders, and this is a plain tab click.
  //
  // This one place is why the entry points were unified FIRST. The behaviour
  // change is absorbed here instead of at 24 call sites.
  //
  // WAIT FOR THE PANE TO SETTLE INTO *EITHER* STATE BEFORE DECIDING, because
  // `locator.isVisible()` is a POINT-IN-TIME check whose `timeout` option is
  // ignored. The first cut of this helper asked `isVisible({timeout:2000})` the
  // instant the tab became visible, got `false` while loadAdminAnalytics was
  // still resolving, skipped the click, and 20 tests then timed out waiting for
  // rows that were never requested. Exactly the v7.21.38 `enterCompNav` defect,
  // in a helper written after it was written down.
  // The settle signal must be something that CANNOT be true before this entry's
  // JS has run. Two traps, both hit:
  //   - `#analytics-table-card` is STATIC markup in index.html and therefore
  //     visible on first paint, so "the card is visible" reported "settled with
  //     data" before a single row existed (seen as one flaky run);
  //   - `#analytics-summary` may still hold the PREVIOUS visit's panel when the
  //     tab is re-entered, which reads as a settled message just as wrongly.
  // So the summary is cleared first — after that, any content in it is from this
  // entry — and "data" is judged by real rows, never by the card's chrome.
  const promptBtn = page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="global"]');
  const card = page.locator("#analytics-table-card");
  await expect
    .poll(async () => ((await promptBtn.count()) > 0 ? "prompt"
      : (await page.locator("#analytics-table-body tr").count()) > 0 ? "data"
      : ((await page.locator("#analytics-summary").innerText().catch(() => "")).trim() ? "message" : "")),
      { timeout: 20000 })
    .not.toBe("");
  if ((await promptBtn.count()) > 0) {
    await promptBtn.click();
    await card.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  }
}


// v8.1.0 — focus a competition this test OWNS and that is definitely LIVE.
//
// Several admin tests focus the seeded "Test Live" and then wait for
// `#add-tasks-to-comp-btn`, which renders only when the focused competition is
// NOT ended (`directAdd = comp && computeCompStatus(comp) !== "ended"`, v7.12.2 —
// assignment is frozen once a session has ended). That makes the readiness signal
// hostage to a shared fixture's lifecycle: observed as `matchStatuses:["ended"]`
// in viewComp's diagnostic, after three earlier hardenings had guessed at timing.
//
// Fixture checklist item 2: own your competition. Returns the name so the caller
// can assert against it.
async function focusOwnLiveComp(page, label) {
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const name = `${label} ${Date.now()}`;
  const r = await page.request.post("/api/admin/competitions", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { name, start_time: new Date(Date.now() - 3600e3).toISOString(),
            duration_minutes: 600, timezone: "UTC" },
  });
  expect(r.ok(), `focusOwnLiveComp("${label}"): create failed: ${await r.text()}`).toBeTruthy();
  await page.reload();
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  await clickTab(page, "Events");
  await viewComp(page, name);
  return name;
}

// v8.2.0 — THE ONE ENTRY POINT for the competition CREATE form.
//
// Creating an event is a two-step wizard: step 1 chooses the KIND, step 2 is the
// form carrying only the settings that kind can use. Before it, ~13 specs each
// hand-rolled "click open-competition-form, then fill #comp-name" — one
// un-abstracted flow copy-pasted across eight files, so the entry change would
// have landed as ~30 unrelated red tests with any real regression buried among
// them. That is the v8.1.0 analytics lesson verbatim: when a change alters what a
// shared UI surface does on ENTRY, unify the test entry points first and absorb
// the change in ONE helper.
//
// The kind defaults to the platform default (Competition), which is what every
// one of those specs was implicitly creating when there was only one form.
//
// It waits on #comp-name rather than #comp-form-overlay because the overlay is
// created before its content is painted, and #comp-name is the first control
// every caller then fills — a settle signal that cannot be true too early
// (v7.21.38).
//
// Since the New event page, "+ New Event" opens that page and a blank starter
// per kind opens the ONE create form with the kind selected. The form keeps its
// rarely used settings in a collapsed Advanced section; this helper opens it
// (unless `advanced: false`), since most callers set one of those controls.
async function openCompCreateForm(page, kind = "tournament", opts = {}) {
  const timeout = opts.timeout || 15000;
  // A second create in one test starts where the first left the admin: on the
  // New event page (the Events list, and its + New Event, are behind it).
  // A save that just finished may still be navigating back to Events: it closes
  // the form, then awaits the list reload, and only then switches to Events. So
  // seeing the page once proves nothing (a second create once found the kind
  // card, then waited 15 s on it hidden). The page is (re)opened and the card
  // clicked until the FORM is open; a tab switch that lands after that leaves
  // the form open over the list.
  const card = page.locator(`#tpl-kind-cards [data-action="new-event-start"][data-kind="${kind}"]`);
  const form = page.locator("#comp-form-overlay");
  let clicked = false;
  await expect(async () => {
    if (clicked && await form.isVisible()) return;
    if (!(await page.locator("#admin-templates-tab").isVisible())) {
      await page.locator('[data-action="open-competition-form"]').first().click({ timeout: 3000 });
    }
    await card.click({ timeout: 3000 });
    clicked = true;
    await form.waitFor({ state: "visible", timeout: 3000 });
  }).toPass({ timeout });
  await page.locator("#comp-name").waitFor({ state: "visible", timeout });
  if (opts.advanced !== false) await openCompAdvanced(page);
}

// Open the create/edit form's Advanced section (a <details>), if it is closed.
async function openCompAdvanced(page) {
  const adv = page.locator("#comp-advanced");
  if (await adv.count() && !(await adv.evaluate(el => el.open))) {
    await adv.locator("summary").click();
  }
}

// v8.13.7 — WCAG contrast of an element's TEXT against what is really behind
// it, read in the page. axe cannot be the witness here: it skips the label of a
// disabled control, which is exactly where an inactive row's name and reason
// flag sit. The background is every translucent layer up the ancestor chain
// composited over the first opaque one; the text colour is composited over
// that, with the opacity of the element and its ancestors folded in, since
// opacity is what dims text. Fails loudly (ratio null, `unparsed` set) on a
// colour it cannot read, rather than guessing.
async function textContrast(locator) {
  return locator.evaluate(el => {
    const parse = s => {
      const m = /^rgba?\(([^)]+)\)$/.exec(String(s).trim());
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    // Opacity is multiplied over EVERY ancestor up to the root — a fade on a
    // container above the first opaque background still fades the text; the
    // background layers stop at the first opaque one.
    const layers = [];
    let opacity = 1;
    let opaqueFound = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= parseFloat(cs.opacity);
      if (opaqueFound) continue;
      const bg = parse(cs.backgroundColor);
      if (!bg) return { ratio: null, unparsed: cs.backgroundColor };
      if (bg.a > 0) { layers.push(bg); if (bg.a >= 1) opaqueFound = true; }
    }
    const over = (top, a, under) => ({ r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a) });
    let bg = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], layers[i].a, bg);
    const c = parse(getComputedStyle(el).color);
    if (!c) return { ratio: null, unparsed: getComputedStyle(el).color };
    const fg = over(c, c.a * opacity, bg);
    const lum = ({ r, g, b }) => {
      const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, opacity, fg, bg };
  });
}

// v8.13.7 — how a picker row is MARKED, in one read: its own opacity, its text
// colour beside the `--muted` token's computed value (a probe span, so the
// token is resolved in the row's own cascade and theme), its edge styles, and
// its checkbox's opacity. An inactive row is dashed, muted and at full
// strength; only its box is faded (CLAUDE.md, *CSS rules*).
async function rowMarking(locator) {
  return locator.evaluate(el => {
    const cs = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = "var(--muted)";
    el.appendChild(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const box = el.querySelector('input[type="checkbox"]');
    return {
      opacity: cs.opacity,
      color: cs.color,
      muted,
      borderTopStyle: cs.borderTopStyle,
      borderLeftStyle: cs.borderLeftStyle,
      boxOpacity: box ? getComputedStyle(box).opacity : null,
    };
  });
}

/**
 * EMAIL FIRST, through the UI: type the address on the card, Continue, read the
 * mailed code back (test-only GET /api/test/last-login-code), enter it, and land
 * on the pre-verified sign-up form for that address. `fields` then fills it
 * (firstName, lastName, company, title, …) and, unless `submit:false`, presses
 * "Create account and continue". Returns the register POST's response, or null.
 */
async function signUpViaUi(page, email, fields = {}, { submit = true } = {}) {
  await page.locator("#login-email").waitFor({ state: "visible", timeout: 15000 });
  await page.fill("#login-email", email);
  await page.click("#login-submit");
  await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
  const r = await page.request.get(new URL("/api/test/last-login-code?email=" + encodeURIComponent(email), page.url()).href);
  const code = r.ok() ? (await r.json()).code : "NOCODE00";
  await page.fill("#sc-code", code);
  await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
  await page.locator("#register-page.active #reg-first").waitFor({ state: "visible", timeout: 15000 });
  const f = { firstName: "Walk", lastName: "Up", company: "Acme", title: "Engineer", ...fields };
  await page.fill("#reg-first", f.firstName);
  await page.fill("#reg-last", f.lastName);
  await page.fill("#reg-company", f.company);
  await page.fill("#reg-title", f.title);
  if (await page.locator("#reg-location-pick").isVisible()) {
    await page.selectOption("#reg-country", f.country || "US");
    await page.selectOption("#reg-tz", { index: 1 });
  }
  if (!submit) return null;
  const resp = page.waitForResponse(x => x.url().includes("/api/register") && x.request().method() === "POST", { timeout: 20000 });
  await page.click("#register-page [data-action='do-register']");
  return resp;
}

/**
 * The workspace Overview keeps everything off its face (the challenge set,
 * solve rates, the activity chart, the organisers) behind ONE "Show …" toggle.
 * Open it (idempotent) before acting on those parts.
 */
async function openOverviewDetail(page) {
  const btn = page.locator("#ws-ov-detail-more");
  await btn.waitFor({ state: "visible", timeout: 20000 });
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#ws-ov-detail")).toBeVisible();
}

module.exports = {
  narrowEventsTable, narrowChallengesTable, narrowPeopleTable,
  openOverviewDetail,
  signUpViaUi,
  textContrast, rowMarking,
  focusOwnLiveComp, openCompCreateForm, openCompAdvanced,
  awaitCompModel, expectSpaBooted, login, fillBreakGlass, submitLogin, loginViaApi, openAnalyticsTab, saLoginRetry, filterComps, rerenderedAfter, narrowGroupsTable, adminLogin, participantLogin, clickTab, openKebab, findSeededTaskRow, viewComp, showEveryoneInWorkspace, showAllParticipantColumns, showAllTableColumns, openSettingsSection, CHALLENGE_ALL_COLUMNS, EVENT_ALL_COLUMNS, openFilterPanels, CONFIRM_PROBE_MS, AxeBuilder, AXE_GATED_IMPACTS };
