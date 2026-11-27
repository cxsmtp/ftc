// @ts-check
// Participant impersonation — browser E2E (v7.14.0). Covers the five product
// invariants from the UI side: (1) the control lives in the Participants-row
// kebab, (2) a regular admin sees the "not allowed in impersonation mode" modal
// on a state-changing action, (3) a superadmin sees the "are you sure?" warning
// and can proceed, (4) the exit control is visible and returns to the admin
// view, (5) impersonated actions carry the analytics-exclusion flag.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
// v8.1.0 — reuse the HARDENED kebab opener rather than keeping a second, naive
// copy. This file had its own single-click version; the shared one closes any
// open menu first (the kebab is a toggle, so a click can spend itself closing
// another), retries, and treats an EMPTY portal as not-open — isVisible cannot
// tell an empty menu from a closed one and would report success only to fail
// later on a missing item. The v7.21.25 rule: when a flake shape is already
// solved somewhere in the suite, reuse that solution, do not write a second.
const { openKebab, narrowPeopleTable } = require("./ui-admin-helpers");
const { AxeBuilder } = require("@axe-core/playwright");
const Database = require("better-sqlite3");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

async function loginViaApi(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, h(csrfToken), { password: pw });
  };
  let r = await doPost(password);
  if (r.ok()) return;
  r = await doPost(email === "superadmin" ? getSuperadminPass() : password);
  // v7.22.0 — say WHY (see the shared probe in helpers.js).
  if (!r.ok()) throw new Error(`loginViaApi(${email}) failed: ${r.status()} ${await r.text()}`
    + await require("./helpers").describeAccountState(email, password));
}

async function adminLogin(page, email, password) {
  await loginViaApi(page, email || "superadmin", password || getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

/** Open the Participants tab and search down to a single row for `email`. */
async function findParticipantRow(page, email) {
  const hamburger = page.locator("#admin-mobile-menu-btn");
  if (await hamburger.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await hamburger.click();
  const btn = page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first();
  await btn.waitFor({ state: "attached" });
  await btn.evaluate((el) => el.click());
  await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 5000 });
  // RBAC — People lists admin accounts only with "Show admin accounts" ticked;
  // the privileged-row arm below needs one.
  const inc = page.locator("#p-include-admins");
  if (await inc.isVisible().catch(() => false) && !(await inc.isChecked())) {
    const reload = page.waitForResponse((r) => r.url().includes("/api/admin/participants?") && r.url().includes("kind=all"));
    await inc.check();
    await reload;
  }
  await narrowPeopleTable(page, email);
  // v8.1.0 — POLL for the filter to settle rather than taking the first visible
  // match. The search is DEBOUNCED, so `.fill()` returns while the table still
  // holds the pre-filter rows: the row found here can be an element the debounce
  // is about to destroy, and the kebab click then lands on a detached node and
  // opens nothing. That is a live mechanism for the intermittent
  // "Impersonate control in the kebab" failure, not a hypothetical — the same
  // `.fill()`-returns-before-the-debounce shape documented at filterComps.
  const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
  await expect.poll(async () => page.locator("#admin-participants-body tr").count(),
    { timeout: 10000, intervals: [100, 200, 400, 800] }).toBeLessThan(5);
  await row.waitFor({ state: "visible", timeout: 10000 });
  return row;
}

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

/**
 * Enter the impersonated participant's competition through the picker — the
 * real path an impersonating admin takes (the impersonation session starts with
 * no competition context, so boot lands on the competitions page), then open
 * the challenge detail. Exercises the read-only navigation allowance end-to-end.
 */
async function openChallengeAsImpersonated(page, compId, taskId) {
  const card = page.locator(`#comp-grid .comp-card[data-comp-id="${compId}"]`).first();
  await card.waitFor({ state: "visible", timeout: 15000 });
  await card.click();
  // Picking a LIVE competition raises the app's own "Enter Live Event"
  // confirm (pickCompetition). select-competition is exempt from the
  // impersonation warning — it is navigation — so this is the only dialog.
  await expect(page.locator("#modal-overlay")).toContainText(/Enter Live Event/i, { timeout: 5000 });
  await page.locator("#modal-confirm-btn").click();
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
  const task = page.locator(`[data-task-id="${taskId}"]`).first();
  await task.waitFor({ state: "visible", timeout: 10000 });
  await task.click();
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 5000 });
}

async function mkParticipant(sa, H, email, nick) {
  const { api: anon, csrf: anonCsrf } = await freshCtx();
  await registerPost(anon, "/api/register", { headers: h(anonCsrf), data: {
    firstName: "Imp", lastName: "Target", nickname: nick, email,
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
  }});
  await anon.dispose();
  const parts = (await (await sa.get(`/api/admin/participants?limit=2000&search=${encodeURIComponent(email)}`)).json()).participants;
  const u = parts.find(p => p.email === email);
  expect(u, `participant ${email} created`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
  return u.id;
}

/**
 * v8.3.25 — an ENDED competition whose sole participant finished it, so the
 * leaderboard offers them a real PLACEMENT certificate. Memoised: both tests
 * below need the same holder, and building it twice would mint two certificates
 * for two different people and prove nothing about either.
 *
 * It is a SEPARATE competition from `ST.compId` on purpose — that one is live
 * and deliberately holds three tasks so an impersonated solve cannot auto-end it
 * under the rest of the file.
 */
let _certFixture = null;
async function ensureCertFixture() {
  if (_certFixture) return _certFixture;
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  try {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const compId = (await (await api.post("/api/admin/competitions", { headers: H, data: {
      name: `ImpUI Cert ${stamp}`, start_time: new Date(Date.now() - 20 * 60_000).toISOString(), duration_minutes: 300,
    }})).json()).competition.id;
    const bankId = (await (await api.post("/api/admin/tasks", { headers: H, data: {
      title: `ImpUI Cert Task ${stamp}`, description: "<p>solve me</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "cert-answer", explanation: "<p>e</p>", status: "published",
    }})).json()).id;
    const taskId = (await (await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H, data: { competitionIds: [compId] } })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what its participants open and answer
    const tgtEmail = `impui-cert-${stamp}@acme.com`;
    const tgtId = await mkParticipant(api, H, tgtEmail, `impui_cert_${stamp}`.slice(0, 30));
    const asg = await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [tgtId], competitionIds: [compId] } });
    const asgBody = await asg.json();
    expect(asgBody.assigned, `assign failed: ${asg.status()} ${JSON.stringify(asgBody)}`).toBe(1);

    const p = await apiLogin(tgtEmail, PARTICIPANT_PASS);
    const pH = h(p.csrf);
    await p.api.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
    const sub = await p.api.post(`/api/tasks/${taskId}/submit`, {
      headers: pH, data: { answer: "cert-answer", gradingHash: await gradingHashFor(p.api, taskId) },
    });
    expect((await sub.json()).correct, "the fixture participant must actually finish, or no certificate is offered").toBe(true);
    await p.api.dispose();
    expect(dbGet("SELECT ended_at FROM competitions WHERE id=?", compId).ended_at,
      "the all-solved auto-end must have fired — a placement certificate needs a final board").toBeTruthy();

    _certFixture = { compId, taskId, tgtEmail, tgtId };
    return _certFixture;
  } finally { await api.dispose(); }
}

/** Impersonate `email`'s target through the real kebab flow, then land on the
 *  ended competition's leaderboard, where the certificate CTA lives. */
async function impersonateOntoLeaderboard(page, adminEmail, adminPass, fx) {
  await adminLogin(page, adminEmail, adminPass);
  const row = await findParticipantRow(page, fx.tgtEmail);
  await openKebab(page, row);
  await page.locator("#kebab-portal button:has-text('Impersonate')").click();
  await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#modal-confirm-btn").click();
  await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });
  // select-competition is on the impersonation write-allowlist (pure
  // navigation), so this is the same door the picker uses — it just skips the
  // ENDED-competition filter the picker defaults to hiding.
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const sel = await page.request.post("/api/select-competition", { headers: h(csrfToken), data: { competitionId: fx.compId } });
  expect(sel.ok(), `select-competition must be allowed under impersonation: ${sel.status()}`).toBe(true);
  await page.evaluate((id) => { window.S.currentCompetitionId = id; window.showMain("leaderboard-page"); }, fx.compId);
  const cta = page.locator('#lb-badge-cta [data-action="open-badge-share"]');
  await cta.waitFor({ state: "visible", timeout: 15000 });
  return cta;
}

let ST;

test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const compId = (await (await api.post("/api/admin/competitions", { headers: H, data: {
    name: `ImpUI Live ${stamp}`, start_time: new Date(Date.now() - 20 * 60_000).toISOString(), duration_minutes: 300,
  }})).json()).competition.id;
  // One task per test. Three published tasks also keep the competition from
  // auto-ending when a single impersonated solve lands (the all-solved scan
  // needs EVERY published challenge solved by every active participant) — a
  // one-task comp would end mid-suite and change the participant view for the
  // tests that follow.
  const mkTask = async (slug) => {
    const id = (await (await api.post("/api/admin/tasks", { headers: H, data: {
      title: `ImpUI ${slug} ${stamp}`, description: "<p>solve me</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "impui-answer", explanation: "<p>e</p>", hint: "a hint", status: "published",
    }})).json()).id;
    return (await (await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H, data: { competitionIds: [compId] } })).json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what its participants open and answer
  };
  const taskSubmit = await mkTask("Submit");
  const taskCancel = await mkTask("Cancel");
  const taskHint = await mkTask("Hint");

  const tgtEmail = `impui-target-${stamp}@acme.com`;
  const tgtNick = `impui_tgt_${stamp}`;
  const tgtId = await mkParticipant(api, H, tgtEmail, tgtNick);
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [tgtId], competitionIds: [compId] } });

  const admEmail = `impui-admin-${stamp}@acme.com`;
  const admId = await mkParticipant(api, H, admEmail, `impui_adm_${stamp}`);
  await api.post(`/api/admin/participants/${admId}/role`, { headers: H, data: { role: "admin" } });

  ST = { stamp, compId, taskSubmit, taskCancel, taskHint, tgtEmail, tgtNick, tgtId, admEmail, admId };
  await api.dispose();
});

test.describe("v7.14.0 — participant impersonation (UI)", () => {

  test("the Impersonate control is in the participant row kebab, and absent for privileged / self rows", async ({ page }) => {
    await adminLogin(page);
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    const item = page.locator("#kebab-portal button:has-text('Impersonate')");
    await expect(item, "participant rows expose Impersonate in the kebab").toHaveCount(1);
    await expect(item).toBeVisible();
    await page.keyboard.press("Escape");

    // Privileged target: no Impersonate (server 403s it; the UI hides it).
    const admRow = await findParticipantRow(page, ST.admEmail);
    await openKebab(page, admRow);
    await expect(page.locator("#kebab-portal button:has-text('Impersonate')"),
      "admin/superadmin rows must NOT offer Impersonate").toHaveCount(0);
  });

  test("full flow (superadmin): confirm → participant view + banner → state-change warning → exit restores admin", async ({ page }) => {
    await adminLogin(page);
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();

    // Entry confirmation names the target and states the tier.
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#modal-overlay")).toContainText(ST.tgtNick);
    await expect(page.locator("#modal-overlay")).toContainText(/full access/i);
    await page.locator("#modal-confirm-btn").click();

    // Lands in the participant view with the banner + Exit control (req 4).
    const banner = page.locator("#impersonation-banner");
    await banner.waitFor({ state: "visible", timeout: 15000 });
    await expect(banner).toContainText(ST.tgtNick);
    await expect(banner).toContainText(/full access/i);
    await expect(page.locator("#impersonation-banner [data-action='impersonation-exit']")).toBeVisible();
    // Admin chrome is gone — this is the participant shell.
    await expect(page.locator("#admin-page.active")).toHaveCount(0);

    // A state-changing action warns first (req 3). Open the challenge and submit.
    await openChallengeAsImpersonated(page, ST.compId, ST.taskSubmit);
    await page.locator("#ans-text").fill("impui-answer");
    await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
    // The app's own "Submit Answer" confirm comes first...
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    // ...then the impersonation are-you-sure warning fronts the actual request.
    // Assert on TEXT (both dialogs share the persistent #modal-overlay, so a
    // visibility-only wait could match the closing first modal).
    await expect(page.locator("#modal-overlay"), "superadmin gets an are-you-sure warning")
      .toContainText(/impersonation mode.*are you sure/i, { timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();

    // The submission lands for the TARGET and is analytics-excluded (req 5).
    await expect.poll(() => {
      const r = dbGet("SELECT is_correct FROM submissions WHERE user_id=? AND task_id=?", ST.tgtId, ST.taskSubmit);
      return r ? r.is_correct : -1;
    }, { timeout: 8000, intervals: [100, 200, 400, 800] }).toBe(1);
    await expect.poll(() => {
      const r = dbGet("SELECT impersonated FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='solved'", ST.tgtId, ST.taskSubmit);
      return r ? r.impersonated : -1;
    }, { timeout: 8000, intervals: [100, 200, 400, 800] }).toBe(1);

    // Exit returns to the admin view (req 4).
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#impersonation-banner")).toHaveCount(0);
    await expect(page.locator("body.impersonating")).toHaveCount(0);
  });

  test("cancelling the superadmin warning aborts the request — nothing is written", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${ST.stamp}c`;
    const email = `impui-cancel-${s}@acme.com`;
    const uid = await mkParticipant(api, H, email, `impui_cx_${s}`);
    await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [uid], competitionIds: [ST.compId] } });
    await api.dispose();

    await adminLogin(page);
    const row = await findParticipantRow(page, email);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });

    await openChallengeAsImpersonated(page, ST.compId, ST.taskCancel);
    await page.locator("#ans-text").fill("impui-answer");
    await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    // Impersonation warning → CANCEL.
    await expect(page.locator("#modal-overlay")).toContainText(/impersonation mode.*are you sure/i, { timeout: 5000 });
    await page.locator("#modal-cancel-btn").click();

    // Give the (aborted) request a beat, then assert nothing was written.
    await page.waitForTimeout(600);
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=?", uid).c,
      "cancelling the warning must not submit").toBe(0);
  });

  test("regular admin is read-only: a state-changing action shows the 'not allowed' modal and writes nothing", async ({ page }) => {
    await adminLogin(page, ST.admEmail, PARTICIPANT_PASS);
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    // Entry copy states the read-only tier for a regular admin.
    await expect(page.locator("#modal-overlay")).toContainText(/read-only/i);
    await page.locator("#modal-confirm-btn").click();

    const banner = page.locator("#impersonation-banner");
    await banner.waitFor({ state: "visible", timeout: 15000 });
    await expect(banner).toContainText(/read-only/i);

    // Navigation works (read-only ≠ frozen): pick the comp, list + open a challenge.
    await openChallengeAsImpersonated(page, ST.compId, ST.taskHint);

    // Reveal Hint is a state-changing action → blocked with the required copy (req 2).
    const hintBtn = page.locator('[data-action="task-reveal-hint"]').first();
    await expect(hintBtn, "the hint control renders for the impersonated participant").toHaveCount(1);
    await hintBtn.click();
    // The app's own "Reveal Hint" cost confirmation comes first; accept it so the
    // request is actually issued, then the server's 403 raises the rejection modal.
    await expect(page.locator("#modal-overlay")).toContainText(/Reveal Hint|deduct/i, { timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay"), "read-only admins get the 'not allowed' modal")
      .toContainText(/not allowed in impersonation mode/i, { timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();

    // Nothing was written for the target by this admin session.
    await page.waitForTimeout(400);
    expect(dbGet("SELECT COUNT(*) c FROM hint_reveals WHERE user_id=? AND task_id=?", ST.tgtId, ST.taskHint).c,
      "read-only impersonation must not reveal a hint").toBe(0);

    // Exit is always reachable and lands back in the admin view.
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#impersonation-banner")).toHaveCount(0);
  });

  test("v8.3.25 — a READ-ONLY admin generates the certificate, and is not offered Share", async ({ page }) => {
    const fx = await ensureCertFixture();
    const cta = await impersonateOntoLeaderboard(page, ST.admEmail, PARTICIPANT_PASS, fx);

    // The ENTRY POINT must not promise the outcome its dialog withholds — the
    // v7.14.2 relabel ("Edit Profile" → "View Profile") one screen upstream.
    await expect(cta, "the CTA label must not offer LinkedIn to a tier that cannot use it").not.toHaveText(/LinkedIn/i);
    // Operator ruling, 23 Nov 2026: a regular admin may not look certificates up
    // by code, so viewing as the participant offers no download either.
    await expect(cta).toHaveText(/Generate certificate/i);
    await expect(cta).not.toHaveText(/download/i);

    await cta.click();
    // A purpose-written confirm for the tier the fetch interceptor does not front
    // (that one is superadmin-only). Minting is irreversible from this seat.
    await expect(page.locator("#modal-overlay"), "the read-only tier is asked before a permanent artefact is created")
      .toContainText(/Generate this certificate/i, { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();

    // The mint really happened — a real row for the TARGET, not a toast.
    await page.locator(".badge-withheld-note").waitFor({ state: "visible", timeout: 20000 });
    await expect.poll(() => dbGet("SELECT COUNT(*) c FROM achievement_badges WHERE user_id=? AND competition_id=?", fx.tgtId, fx.compId).c,
      { timeout: 10000 }).toBe(1);

    // The withheld affordances, WITH their reason (v7.14.2: both together): the
    // certificate's code, picture, downloads and link are hidden from a hand
    // that may not look certificates up by code (operator ruling, 23 Nov 2026).
    await expect(page.locator(".badge-withheld-note")).toContainText(/code and downloads are hidden/i);
    await expect(page.locator(".badge-share-img"), "no picture: its address is the token").toHaveCount(0);
    await expect(page.locator('#modal-overlay a[href*="/badge/"]'), "no download link").toHaveCount(0);
    await expect(page.locator('#modal-overlay [data-action="badge-copy-link"]'), "no link to copy").toHaveCount(0);
    const _tok = dbGet("SELECT token, public_code FROM achievement_badges WHERE user_id=? AND competition_id=?", fx.tgtId, fx.compId);
    const _shown = await page.locator("#modal-overlay").innerHTML();
    expect(_shown, "the token is nowhere in the dialog").not.toContain(_tok.token);
    expect(_shown, "nor the code").not.toContain(_tok.public_code);
    await expect(page.locator("#modal-confirm-btn"), "the primary button must not be a Share this tier cannot perform")
      .toHaveText(/^Close$/);
    await expect(page.locator("#modal-cancel-btn"), "…and Cancel collapses, leaving one dismiss control").toBeHidden();
    // The lead paragraph must not contradict the note two paragraphs below it.
    await expect(page.locator(".badge-share-help")).not.toContainText(/LinkedIn/i);

    // Pressing the primary button must DISMISS, never share: with the confirm
    // relabelled to "Close", showModal still resolves TRUE, so a bare `if(ok)`
    // would open the LinkedIn composer on every dismissal.
    //
    // `page.on("popup")` cannot see this: the hand-off opens with
    // `noopener`, so no opener relationship exists and Playwright emits no popup
    // event — measured, the assertion passed with the guard reverted. Stub
    // `window.open` (the pattern credential-reach.spec.js already uses) AND watch
    // the wire, so neither half can be vacuous.
    const shareCalls = [];
    page.on("request", (r) => { if (/\/badge\/[^/]+\/shared/.test(r.url())) shareCalls.push(r.url()); });
    await page.evaluate(() => { window.__opens = []; window.open = (u) => { window.__opens.push(String(u || "")); return null; }; });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__opens),
      "closing the dialog must not hand off to LinkedIn").toEqual([]);
    expect(shareCalls, "…and must not fire the share POST either").toEqual([]);
    expect(dbGet("SELECT shared_at FROM achievement_badges WHERE user_id=? AND competition_id=?", fx.tgtId, fx.compId).shared_at,
      "and nothing was published").toBeFalsy();
  });

  test("v8.3.25 — the SUPERADMIN tier is unchanged: Share is offered and the note is absent", async ({ page }) => {
    // THE CONTROL. Without it, "the note is shown and Share is withheld" is
    // equally satisfied by a build that shows the note to everybody and removed
    // the LinkedIn hand-off from the platform.
    const fx = await ensureCertFixture();
    const cta = await impersonateOntoLeaderboard(page, "superadmin", getSuperadminPass(), fx);
    await expect(cta, "a superadmin still sees the ordinary participant-facing label").toHaveText(/Share on LinkedIn/i);
    await cta.click();
    // A superadmin's confirm is the interceptor's generic one, fronting EVERY
    // state-changing request — not the read-only tier's purpose-written copy.
    await expect(page.locator("#modal-overlay")).toContainText(/are you sure/i, { timeout: 10000 });
    await expect(page.locator("#modal-overlay")).not.toContainText(/Generate this certificate/i);
    await page.locator("#modal-confirm-btn").click();
    await page.locator(".badge-share-img").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator(".badge-imp-note")).toHaveCount(0);
    await expect(page.locator(".badge-withheld-note"), "a superadmin may look codes up: nothing is hidden").toHaveCount(0);
    await expect(page.locator('#modal-overlay a[href*="/certificate.pdf"]')).toHaveCount(1);
    await expect(page.locator("#modal-confirm-btn")).toHaveText(/Share on LinkedIn/i);
    await expect(page.locator("#modal-cancel-btn")).toBeVisible();
  });

  test("v8.3.27 — pressing Events under superadmin impersonation is not interrogated", async ({ page }) => {
    // `/api/deselect-competition` joined the server's no-durable-change allowlist
    // in v8.3.8 and never reached the client's confirm-exempt list, so pressing
    // the **Events** nav item raised "You're in impersonation mode — are you
    // sure? This will change real data for the impersonated participant." for a
    // request that changes nothing: it only removes a pointer, and its one
    // durable half (the target's auto-resume marker) is suppressed under
    // impersonation in the handler. A confirm that fires on a no-op is how an
    // operator learns to click through the ones that matter.
    await adminLogin(page);                       // built-in superadmin
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });

    // Get INTO a competition first — Events is only meaningful on the way out,
    // and this also proves `select-competition` is likewise unconfirmed.
    await openChallengeAsImpersonated(page, ST.compId, ST.taskCancel);

    const calls = [];
    page.on("request", r => { if (r.url().includes("/api/deselect-competition")) calls.push(r.url()); });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events'), .nav-btn:not([aria-disabled=true]):has-text('Events')").first().click();

    // Events is plain navigation (the app's own "Leave Event?" confirm was
    // removed in v8.16.x), so the deselect POST goes straight out.

    // The request really is made — without this, "no confirm appeared" is equally
    // satisfied by a build where pressing Events does nothing at all.
    await expect.poll(() => calls.length, { timeout: 15000 }).toBeGreaterThan(0);
    await page.locator("#competitions-page.active").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#modal-overlay.open"),
      "pressing Events must not raise the are-you-sure confirm — it changes nothing durable"
    ).toHaveCount(0);

    // CONTROL, and it drives the interceptor directly rather than through a
    // second navigation: without it, "no confirm appeared" is equally satisfied
    // by a build that lost the superadmin confirm altogether — which would be far
    // worse than the noise being removed. Fire-and-forget on purpose:
    // `page.evaluate` AWAITS a returned promise, and this one does not settle
    // until the modal is answered.
    await page.evaluate(() => {
      window.fetch("/api/me", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    });
    await expect(page.locator("#modal-overlay"),
      "a genuinely state-changing /api request is still fronted with the impersonation confirm"
    ).toContainText(/are you sure/i, { timeout: 10000 });
    await page.locator("#modal-cancel-btn").click();
  });

  test("the impersonation banner has no moderate+ axe violations and survives a page refresh", async ({ page }) => {
    await adminLogin(page);
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });

    // Refresh — the banner is re-derived from /api/me on every boot.
    await page.reload();
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });

    const results = await new AxeBuilder({ page }).include("#impersonation-banner").analyze();
    const bad = results.violations.filter(v => v.impact === "moderate" || v.impact === "serious" || v.impact === "critical");
    // Include the offending nodes in the failure message — a bare rule id makes
    // a contrast regression here needlessly hard to localise.
    expect(bad.flatMap(v => v.nodes.map(n => `${v.id} @ ${n.target.join(" ")} :: ${(n.failureSummary || "").replace(/\s+/g, " ").slice(0, 300)}`))).toEqual([]);

    // The banner must clear the sticky header (fixed bar + body offset).
    const box = await page.locator("#impersonation-banner").boundingBox();
    expect(box, "banner is laid out").toBeTruthy();
    expect(box.y, "banner sits at the very top").toBeLessThanOrEqual(1);
    const headerY = (await page.locator("header").boundingBox())?.y ?? 0;
    expect(headerY, "the sticky header is pushed below the banner").toBeGreaterThanOrEqual(box.height - 2);

    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
  });

  // ── v7.15.5 — the login screen must not flash on an app-initiated reload ────
  // Reported: entering and exiting impersonation showed the login screen for
  // several seconds. #login-page carries `active` in the markup, so it paints on
  // every load and is only swapped once boot()'s serial chain (csrf + config →
  // /api/me → competition/role routing) resolves. On a reload the APP triggered,
  // the user is already signed in, so that paint is simply wrong.
  //
  // These watch every animation frame of the NEW document. page.addInitScript
  // re-runs per navigation, so the flag it sets measures only the document under
  // test — the admin page we navigated away from can't pollute it.
  const watchForLoginPaint = (page) => page.addInitScript(() => {
    window.__loginPainted = false;
    const tick = () => {
      const el = document.getElementById("login-page");
      // offsetParent is null for a display:none ancestor chain — i.e. actually
      // painted, not merely present in the DOM.
      if (el && el.offsetParent !== null && getComputedStyle(el).display !== "none") {
        window.__loginPainted = true;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  test("entering impersonation never paints the login screen", async ({ page }) => {
    await adminLogin(page);
    await watchForLoginPaint(page);           // armed for the NEXT document
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();

    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });
    expect(await page.evaluate(() => window.__loginPainted),
      "the login screen must never be painted while entering impersonation").toBe(false);
    // And the mask is gone once routed, so the app is interactive (not stuck
    // behind the spinner the mask shows).
    expect(await page.evaluate(() => document.documentElement.classList.contains("booting-authed"))).toBe(false);
    await expect(page.locator("#loading-overlay")).toBeHidden();
  });

  test("exiting impersonation never paints the login screen", async ({ page }) => {
    await adminLogin(page);
    const row = await findParticipantRow(page, ST.tgtEmail);
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });

    await watchForLoginPaint(page);           // arm for the exit navigation
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
    expect(await page.evaluate(() => window.__loginPainted),
      "the login screen must never be painted while exiting impersonation").toBe(false);
    expect(await page.evaluate(() => document.documentElement.classList.contains("booting-authed"))).toBe(false);
  });

  // The mechanism itself, independent of impersonation: the marker is consumed
  // BEFORE first paint and is strictly ONE-SHOT, so a crash mid-boot can never
  // leave a later visit stuck behind a spinner with no login screen.
  test("the boot mask is applied pre-paint, is one-shot, and is lifted on routing", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => sessionStorage.setItem("ha:transition", "1"));
    await page.reload();
    // Consumed by theme-boot.js on the way in.
    expect(await page.evaluate(() => sessionStorage.getItem("ha:transition")),
      "the marker is removed as it is read — one-shot").toBeNull();
    // Anonymous boot routes to the login page, which lifts the mask.
    await page.locator("#login-page").waitFor({ state: "visible", timeout: 15000 });
    expect(await page.evaluate(() => document.documentElement.classList.contains("booting-authed"))).toBe(false);

    // A second reload without the marker must not mask anything.
    await page.reload();
    await page.locator("#login-page").waitFor({ state: "visible", timeout: 15000 });
    expect(await page.evaluate(() => document.documentElement.classList.contains("booting-authed"))).toBe(false);
  });

  // While the mask IS up, it must actually hide the login page and show the
  // spinner — otherwise the marker would be set but change nothing.
  test("the boot mask hides the login page and shows the spinner while it is up", async ({ page }) => {
    await page.goto("/");
    const state = await page.evaluate(() => {
      document.documentElement.classList.add("booting-authed");
      const login = document.getElementById("login-page");
      const spin = document.getElementById("loading-overlay");
      const r = { login: getComputedStyle(login).display, spinner: getComputedStyle(spin).display };
      document.documentElement.classList.remove("booting-authed");
      return r;
    });
    expect(state.login, "login page is hidden behind the mask").toBe("none");
    expect(state.spinner, "the spinner is shown instead").toBe("flex");
  });
});
