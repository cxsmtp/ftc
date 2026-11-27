// @ts-check
//
// Screenshot capture — opt-in tooling (NOT part of the regression suite).
//
// Run with:   npm run docs:shots                  # all roles
//             npm run docs:shots:participant      # one role at a time
//             npm run docs:shots:admin
//             npm run docs:shots:superadmin
//
// Output:     docs/screenshots/<role>/<NN>-<slug>.png
//             docs/screenshots/MANIFEST.json (version + counts + timestamp)
//
// Excluded from the default `npm test` run by the testIgnore rule in
// playwright.config.js (matches every `_*.spec.js` unless CAPTURE_SCREENSHOTS=1).
//
// Light theme by design — matches the public docs aesthetic and avoids
// dark-on-dark contrast issues when the markdown is rendered on github.com /
// the hosted docs site. The runtime SPA still respects user OS preference
// in production; we just pin emulated colour-scheme here.

const { test, expect, request } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => {
  await require("./ui-admin-helpers").openFilterPanels(page);
  // Each run pins its theme, light or dark, whatever the house mode resolves
  // to (only when nothing is stored: a capture that sets its own keeps it).
  await page.addInitScript((t) => { try { if (!localStorage.getItem("hck-theme")) localStorage.setItem("hck-theme", t); } catch (_) { /* no storage */ } }, process.env.THEME === "dark" ? "dark" : "light");
});
const { registerPost } = require("./helpers");
const fs = require("fs");
const path = require("path");
const { apiLogin, getSuperadminPass, freshCtx, BASE, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");
const { openAnalyticsTab, openCompCreateForm, filterComps, openKebab, signUpViaUi, narrowChallengesTable, narrowEventsTable, narrowPeopleTable, pickFormKind, peopleWithAdminAccounts, openCompAdvanced } = require("./ui-admin-helpers"); // v8.1.0 — one analytics entry point; v8.2.0 — one create entry point

// An event's doors are its WORKSPACE's ⋯ menu (the Events-row menu keeps only
// Delete event; owner's decision, 27 Nov 2026). Open an event's workspace from
// its row (narrowed to `name` when given, else the first row) and its ⋯ menu.
async function openEventWsMenu(page, name) {
  if (name) await filterComps(page, name);
  const row = name ? page.locator("#admin-comp-body tr", { hasText: name }).first() : page.locator("#admin-comp-body tr").first();
  await row.locator('[data-action="comp-open"]').first().click();
  await page.locator("#ws-record").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("#ws-quick .ws-more-btn").click();
  await page.locator("#kebab-portal.open").waitFor({ state: "visible", timeout: 5000 });
  return page.locator("#kebab-portal");
}

// Theme controlled by env so the same spec can produce both light and dark
// shots via two sequential runs (see the `docs:shots` npm script). Output
// naming: light shots keep the base name (`foo.png`) — back-compat with the
// markdown sources that reference them — while dark shots get the `.dark`
// suffix (`foo.dark.png`). The help-drawer renderer emits a <picture> pair
// so the browser picks the variant matching the user's OS colour scheme.
const THEME = process.env.THEME === "dark" ? "dark" : "light";

test.use({
  baseURL: BASE,
  colorScheme: THEME,
  viewport: { width: 1280, height: 900 },
});

const SHOTS_DIR = path.resolve(__dirname, "..", "docs", "screenshots");
// v8.6.6 — MODULE SCOPE, not inside a describe: a describe body is evaluated
// late enough that captures already written are counted as pre-existing (measured:
// it reported 0 of 20 participant captures).
const RUN_STARTED_AT = Date.now();
function shotPath(role, slug) {
  const dir = path.join(SHOTS_DIR, role);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = THEME === "dark" ? ".dark" : "";
  return path.join(dir, `${slug}${suffix}.png`);
}

// In-page logins via the request context — same pattern as the regular
// UI tests. Avoids racing the login form input fields.
async function loginViaApi(page, email, password) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: password });
  // v7.22.0 — say WHY (see the shared probe in helpers.js).
  if (!r.ok()) throw new Error(`login(${email}) failed: ${r.status()} ${await r.text()}`
    + await require("./helpers").describeAccountState(email, password));
}


// ── v8.3.22 — FIXTURES FOR THE ATTEMPT-CAP AND CERTIFICATE CAPTURES ──────────
//
// v8.3.21 documented attempt limits and the Program completion certificate for
// the first time and deliberately shipped those sections WITHOUT pictures,
// because each needs a state the seed does not produce: a capped challenge with
// a participant who has spent their attempts, and a Program somebody has
// finished. Both are built here rather than in a `beforeAll`, so a capture that
// nobody asked for costs nothing, and both are memoised so the pair of attempt
// shots share one build.
//
// A DEDICATED participant, never alice: entering a competition writes
// `users.active_competition_id`, and the auto-resume rule would then route
// later participant captures into whichever fixture ran last.
async function _mkParticipant(sa, saH, label, nickname, [firstName, lastName] = ["Robin", "Shaw"]) {
  const email = `${label}@company.example`;
  const reg = await registerPost(sa, "/api/register", {
    headers: { "content-type": "application/json", "x-csrf-token": (await (await sa.get("/api/csrf-token")).json()).csrfToken },
    data: {
      firstName, lastName, nickname: nickname || label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  if (!reg.ok()) throw new Error(`register(${email}) failed: ${reg.status()} ${await reg.text()}`);
  const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
  const row = (list.participants || []).find(p => p.email === email);
  if (!row) throw new Error(`registered ${email} but it is not in the admin list`);
  await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: saH });
  await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: saH });
  return { id: row.id, email };
}

let _capFixture = null;
async function ensureCappedFixture() {
  if (_capFixture) return _capFixture;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const t = Date.now().toString(36);
    const cr = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: "Attempt Limits Demo", event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      },
    });
    if (!cr.ok()) throw new Error(`create competition failed: ${cr.status()} ${await cr.text()}`);
    const compId = (await cr.json()).competition.id;

    // The cap lives on the CHALLENGE here, which is also what makes the admin
    // kebab offer Grant Attempts (`_taskMayHaveCap` resolves the same
    // most-specific-wins chain the server does).
    const mkTask = async (title, difficulty) => {
      const r = await sa.post("/api/admin/tasks", {
        headers: saH,
        data: {
          title, description: "<p>Find the flaw in the snippet and name it.</p>",
          difficulty, answer_type: "text", correct_answer: "sql-injection",
          explanation: "<p>Unparameterised query.</p>", hint: "Look at how the query is built.",
          status: "published", attempt_cap: 3,
        },
      });
      if (!r.ok()) throw new Error(`create task failed: ${r.status()} ${await r.text()}`);
      const id = (await r.json()).id;
      await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
      return id;
    };
    const partial = await mkTask("Injection triage", "medium");
    const spent = await mkTask("Broken access control", "hard");

    const p = await _mkParticipant(sa, saH, `cap${t}`, "robin_s");
    const asg = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [p.id], competitionIds: [compId] } });
    // The assign endpoint SKIPS ineligible users silently, so assert it landed
    // rather than discovering an empty board three captures later.
    const asgBody = await asg.json();
    if (!asg.ok() || asgBody.assigned !== 1) throw new Error(`assign failed: ${asg.status()} ${JSON.stringify(asgBody)}`);

    const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
    const pH = { "x-csrf-token": pc, "content-type": "application/json" };
    await pa.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
    const burn = async (taskId, n) => {
      for (let i = 0; i < n; i++) {
        await pa.post(`/api/tasks/${taskId}/submit`, {
          headers: pH,
          data: { answer: `wrong-${i}`, gradingHash: await gradingHashFor(pa, taskId) },
        });
      }
    };
    await burn(partial, 1);   // -> "2 of 3 attempts left"
    await burn(spent, 3);     // -> the locked "No attempts left" panel
    await pa.dispose();

    _capFixture = { compId, partial, spent, email: p.email };
    return _capFixture;
  } finally { await sa.dispose(); }
}

let _programFixture = null;
async function ensureCompletedProgramFixture() {
  if (_programFixture) return _programFixture;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const t = Date.now().toString(36);
    const cr = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: "Secure Coding Foundations", event_kind: "program", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(),
        deadline_at: new Date(Date.now() + 90 * 24 * 3600e3).toISOString(),
      },
    });
    if (!cr.ok()) throw new Error(`create program failed: ${cr.status()} ${await cr.text()}`);
    const compId = (await cr.json()).competition.id;
    const tr = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: "Parameterised queries", description: "<p>Rewrite the query safely.</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "done",
        explanation: "<p>Bind, do not concatenate.</p>", status: "published",
      },
    });
    if (!tr.ok()) throw new Error(`create task failed: ${tr.status()} ${await tr.text()}`);
    const taskId = (await tr.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });

    const p = await _mkParticipant(sa, saH, `prog${t}`, "alex_m");
    const asg = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [p.id], competitionIds: [compId] } });
    const asgBody = await asg.json();
    if (!asg.ok() || asgBody.assigned !== 1) throw new Error(`assign failed: ${asg.status()} ${JSON.stringify(asgBody)}`);

    const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
    const pH = { "x-csrf-token": pc, "content-type": "application/json" };
    await pa.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
    // SOLVE EVERYTHING — a completion certificate is earned by solving all of it,
    // never by exhausting attempts (`participantSolvedAll`, not the auto-end
    // predicate), and it is available at once rather than at the deadline.
    const sub = await pa.post(`/api/tasks/${taskId}/submit`, {
      headers: pH, data: { answer: "done", gradingHash: await gradingHashFor(pa, taskId) },
    });
    const subBody = await sub.json();
    if (!subBody.correct) throw new Error(`solve failed, certificate would not be offered: ${JSON.stringify(subBody)}`);
    await pa.dispose();

    _programFixture = { compId, taskId, email: p.email };
    return _programFixture;
  } finally { await sa.dispose(); }
}

/**
 * v8.3.25 — a Program whose participant has finished it, held SEPARATELY from
 * `ensureCompletedProgramFixture`.
 *
 * It has to be its own: the impersonation capture CLICKS the offer, which mints
 * the certificate — and `17-certificate-cta` asserts its own fixture still reads
 * "Your certificate is ready", the CLAIMABLE state. Sharing one fixture would
 * make that capture depend on which of the two ran first.
 *
 * A Program rather than a Competition because the completion certificate is
 * where the withheld-Share note earns its place: on that kind, pressing Share is
 * what makes the participant's public page live at all.
 */
let _impCertFixture = null;
async function ensureImpersonationCertFixture() {
  if (_impCertFixture) return _impCertFixture;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const t = Date.now().toString(36);
    const cr = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: "Cloud Security Essentials", event_kind: "program", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(),
        deadline_at: new Date(Date.now() + 90 * 24 * 3600e3).toISOString(),
      },
    });
    if (!cr.ok()) throw new Error(`create program failed: ${cr.status()} ${await cr.text()}`);
    const compId = (await cr.json()).competition.id;
    const tr = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: "Least-privilege IAM roles", description: "<p>Tighten the policy.</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "done",
        explanation: "<p>Grant only what is used.</p>", status: "published",
      },
    });
    if (!tr.ok()) throw new Error(`create task failed: ${tr.status()} ${await tr.text()}`);
    const taskId = (await tr.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });

    const p = await _mkParticipant(sa, saH, `impcert${t}`, "sam_delacroix");
    const asg = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [p.id], competitionIds: [compId] } });
    const asgBody = await asg.json();
    if (!asg.ok() || asgBody.assigned !== 1) throw new Error(`assign failed: ${asg.status()} ${JSON.stringify(asgBody)}`);

    const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
    const pH = { "x-csrf-token": pc, "content-type": "application/json" };
    await pa.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
    const sub = await pa.post(`/api/tasks/${taskId}/submit`, {
      headers: pH, data: { answer: "done", gradingHash: await gradingHashFor(pa, taskId) },
    });
    const subBody = await sub.json();
    if (!subBody.correct) throw new Error(`solve failed, certificate would not be offered: ${JSON.stringify(subBody)}`);
    await pa.dispose();

    _impCertFixture = { compId, taskId, id: p.id, email: p.email };
    return _impCertFixture;
  } finally { await sa.dispose(); }
}

/**
 * v8.12.1 — AN EVENT ADMIN TARGET FOR THE IMPERSONATION CAPTURES. Three
 * captures photograph an organiser being looked at THROUGH THEIR OWN PANEL —
 * the dialog that asks which of their two views to open, the panel itself
 * under a read-only banner, and the same panel under a superadmin's
 * full-access banner. The event-admin describe below builds its own organiser
 * inside a `beforeAll`, which the `admin` and `superadmin` describes cannot
 * reach, so this is a module-scope, memoised twin: one organiser, one event
 * they run, one decoy they must NOT see. The decoy is the load-bearing half —
 * without it "the panel lists their event" is equally true of an unscoped
 * admin panel, and the capture would be a picture of the wrong thing under a
 * caption about a narrowed one.
 *
 * Deliberately NOT the seeded carol: `tests/isolated-test.js` asserts in an
 * afterAll that the three seeded participants still hold `role: 'participant'`,
 * and carol is the ACTING admin in the `admin` describe anyway.
 */
let _orgTargetFixture = null;
async function ensureOrganiserTargetFixture() {
  if (_orgTargetFixture) return _orgTargetFixture;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const stamp = Date.now().toString(36);
    const mk = async (name) => {
      const r = await sa.post("/api/admin/competitions", { headers: saH, data: {
        name, start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 600, event_kind: "tournament",
      }});
      if (!r.ok()) throw new Error(`shots: could not create ${name}: ${r.status()} ${await r.text()}`);
      return { id: (await r.json()).competition.id, name };
    };
    const evt = await mk(`Lisbon Booth ${stamp}`);
    const decoy = await mk(`Oslo Track ${stamp}`);
    const email = `organiser-target-${stamp}@acme.com`;
    const anon = await request.newContext({ baseURL: BASE });
    const acsrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", { headers: { "x-csrf-token": acsrf, "content-type": "application/json" }, data: {
      email, password: PARTICIPANT_PASS, nickname: `tomas_${stamp.slice(-5)}`,
      firstName: "Tomás", lastName: "Ferreira", company: "Acme", title: "Engineer",
      country: "PT", timezone: "Europe/Lisbon",
    }});
    if (!reg.ok()) throw new Error(`shots: could not register the organiser target: ${reg.status()} ${await reg.text()}`);
    await anon.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants || [];
    const row = parts.find(p => p.email === email);
    if (!row) throw new Error("shots: the organiser target was not found after registering");
    await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: saH });
    const g = await sa.post(`/api/admin/competitions/${evt.id}/admins`, { headers: saH, data: { userId: row.id } });
    if (!g.ok()) throw new Error(`shots: could not grant the event-admin role: ${g.status()} ${await g.text()}`);
    // A challenge in their event, so the panel they are looked at through is
    // not an empty one.
    const t = await sa.post("/api/admin/tasks", { headers: saH, data: {
      title: `Broken access control on /orders ${stamp}`, description: "<p>Find the IDOR.</p>",
      difficulty: "medium", answer_type: "text", correct_answer: "idor", status: "published",
    }});
    if (t.ok()) await sa.post(`/api/admin/tasks/${(await t.json()).id}/competitions`, { headers: saH, data: { competitionIds: [evt.id] } });
    _orgTargetFixture = { id: row.id, email, nickname: `tomas_${stamp.slice(-5)}`, evt, decoy };
    return _orgTargetFixture;
  } finally { await sa.dispose(); }
}

/**
 * v8.12.1 — enter an organiser's Event Admin Panel through the API and land the
 * browser in it. Shared by the regular-admin and superadmin captures, which
 * differ only in who is signed in and therefore in the banner's tier. Every
 * assertion here is the picture's own claim: the banner names the view AND the
 * tier, the panel title is the organiser's, the decoy is absent, and the two
 * nav items an organiser never has are hidden — or it is a screenshot of the
 * acting admin's OWN panel under an impersonation banner.
 */
async function enterOrganiserPanelViaApi(page, target, tierText) {
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const r = await page.request.post(`/api/admin/participants/${target.id}/impersonate`, {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { view: "admin" },
  });
  if (!r.ok()) throw new Error(`shots: impersonate(view=admin) refused: ${r.status()} ${await r.text()}`);
  await page.goto("/");
  await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
  await expect(page.locator("#impersonation-banner")).toContainText(/Event Admin Panel/);
  await expect(page.locator("#impersonation-banner")).toContainText(tierText);
  await expect(page.locator("#admin-panel-title")).toHaveText(/Event Admin Panel/);
  await expect(page.locator("li:has(> button.admin-nav-item[data-tab-id='admin-users-tab'])")).toBeHidden();
  await expect(page.locator("li:has(> button.admin-nav-item[data-tab-id='admin-settings-tab'])")).toBeHidden();
  await expect(page.locator("#admin-comp-body")).toContainText(target.evt.name, { timeout: 15000 });
  await expect(page.locator("#admin-comp-body")).not.toContainText(target.decoy.name);
}

async function exitImpersonationViaApi(page) {
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/impersonation/exit", { headers: { "x-csrf-token": csrf } }).catch(() => {});
}

async function loginAsAlice(page) {
  await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
  await page.goto("/");
}

// v8.6.6 — OWN THE COMPETITION, DO NOT INHERIT A MARKER.
// `loginAsAlice` relies on server-side auto-resume, i.e. on
// `users.active_competition_id` still pointing at the seeded live competition.
// `03-comp-picker` clicks Competitions, which fires `POST /api/deselect-competition`
// (competition-picker.js:578) and NULLs that column DURABLY — so a later capture
// that merely logs in boots to the picker instead, where `#nav-challenges` keeps
// the `display:none` it ships with (nav.js:265) and is revealed only for a
// live-or-ended competition (nav.js:490). The click then never becomes actionable
// and burns its full timeout. Fixture-checklist item 10, and the v7.17.3 class;
// it went unnoticed because `testIgnore` keeps this file out of `npm test`.
// v8.17.0 — an ENDED Competition whose certificates have been issued, for the
// workspace Certificates section. Three finishers on a two-challenge board (so
// the podium has three distinct places), ended with the real End Now, then one
// forced certificate-dispatch pass, which issues and (to the dead test relay)
// tries to mail them — exactly the list an organiser sees after an event.
let _issuedFixture = null;
async function ensureIssuedCertsFixture() {
  if (_issuedFixture) return _issuedFixture;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const t = Date.now().toString(36);
    const name = "Spring Secure Code Cup";
    const cr = await sa.post("/api/admin/competitions", { headers: saH, data: {
      name, event_kind: "tournament", timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 240 } });
    if (!cr.ok()) throw new Error(`create competition failed: ${cr.status()} ${await cr.text()}`);
    const compId = (await cr.json()).competition.id;
    const tasks = [];
    for (const [title, difficulty] of [["Spot the injection", "easy"], ["Fix the access check", "medium"]]) {
      const r = await sa.post("/api/admin/tasks", { headers: saH, data: {
        title, description: "<p>Name the flaw.</p>", difficulty, answer_type: "text", correct_answer: "ok", status: "published" } });
      if (!r.ok()) throw new Error(`create task failed: ${r.status()} ${await r.text()}`);
      const id = (await r.json()).id;
      await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
      tasks.push(id);
    }
    const people = [];
    for (const [nick, solves, names] of [["maya_k", 2, ["Maya", "Kowalski"]], ["dev_r", 2, ["Dev", "Raman"]], ["lena_o", 1, ["Lena", "Okafor"]]]) {
      const p = await _mkParticipant(sa, saH, `cert${nick.replace("_", "")}${t}`, nick, names);
      people.push({ ...p, solves });
    }
    const asg = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: people.map(p => p.id), competitionIds: [compId] } });
    const asgBody = await asg.json();
    if (!asg.ok() || asgBody.assigned !== people.length) throw new Error(`assign failed: ${asg.status()} ${JSON.stringify(asgBody)}`);
    for (const p of people) {
      const { api: pa, csrf: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
      const pH = { "x-csrf-token": pc, "content-type": "application/json" };
      try {
        await pa.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
        for (const id of tasks.slice(0, p.solves)) {
          const s = await pa.post(`/api/tasks/${id}/submit`, { headers: pH, data: { answer: "ok", gradingHash: await gradingHashFor(pa, id) } });
          if (!(await s.json()).correct) throw new Error("fixture solve failed");
        }
      } finally { await pa.dispose(); }
    }
    const end = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH, data: {} });
    if (!end.ok()) throw new Error(`end-now failed: ${end.status()} ${await end.text()}`);
    await sa.post("/api/test/certificate-dispatch-tick", { headers: saH, data: { force: true } });
    const list = await (await sa.get(`/api/admin/competitions/${compId}/certificates`)).json();
    const rows = list.certificates || list.rows || list;
    if (!Array.isArray(rows) || rows.length < 3) throw new Error(`certificates were not issued: ${JSON.stringify(list).slice(0, 300)}`);
    _issuedFixture = { compId, name };
    return _issuedFixture;
  } finally { await sa.dispose(); }
}

// v8.17.0 — an upcoming Booth Event with its join link ON (a Booth Event's
// seed), for the join pill's QR popover.
let _boothJoinFixture = null;
async function ensureBoothJoinFixture() {
  if (_boothJoinFixture) return _boothJoinFixture;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const name = "Booth at DevCon";
    const cr = await sa.post("/api/admin/competitions", { headers: saH, data: {
      name, event_kind: "booth", timezone: "UTC",
      start_time: new Date(Date.now() + 26 * 3600e3).toISOString(), duration_minutes: 60, self_enroll_enabled: true } });
    if (!cr.ok()) throw new Error(`create booth failed: ${cr.status()} ${await cr.text()}`);
    const comp = (await cr.json()).competition;
    if (!comp.self_enroll_enabled) throw new Error("the booth's join link is off");
    _boothJoinFixture = { compId: comp.id, name };
    return _boothJoinFixture;
  } finally { await sa.dispose(); }
}

/** Open an event's workspace (by id) as the signed-in admin. */
async function openWorkspace(page, compId, name) {
  await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), compId),
    { timeout: 15000, message: "the event is in the admin model" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: compId, n: name });
  await page.locator("#ws-record").waitFor({ state: "visible", timeout: 10000 });
}

let _seededLiveId = null;
async function seededLiveCompId() {
  if (_seededLiveId) return _seededLiveId;
  const sa = await apiLogin("superadmin");
  try {
    const body = await (await sa.api.get("/api/admin/competitions")).json();
    const comps = Array.isArray(body) ? body : (body.competitions || []);
    const live = comps.find(c => c.name === "Test Live");
    if (!live) throw new Error("seeded 'Test Live' competition not found");
    _seededLiveId = live.id;
  } finally { await sa.api.dispose(); }
  return _seededLiveId;
}

/** Sign alice in and put her INSIDE the seeded live competition, explicitly. */
async function loginAliceIntoLive(page) {
  const compId = await seededLiveCompId();
  await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const sel = await page.request.post("/api/select-competition", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { competitionId: compId },
  });
  if (!sel.ok()) throw new Error(`select-competition failed: ${sel.status()} ${await sel.text()}`);
  await page.goto("/");
  // A nav BUTTON, never `#main-nav` — that container is static shell markup
  // with a real box at first paint, so waiting on it is satisfied before boot
  // has resolved who we are (the v8.3.33 / v8.6.4 class).
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first()
    .waitFor({ state: "visible", timeout: 15000 });
}

async function loginAsSuperadmin(page) {
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
}

// Ensure carol (seeded as a regular participant) is promoted to `admin`
// for the duration of the admin-role captures. Idempotent: skip if she's
// already admin. Used by the admin describe block so admin screenshots
// reflect what a regular admin actually sees (no superadmin-only buttons,
// no CxOne override section, redacted log entries, etc).
async function ensureCarolIsAdmin() {
  const { api, csrf } = await apiLogin("superadmin");
  const h = { "x-csrf-token": csrf, "content-type": "application/json" };
  const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants || [];
  const carol = parts.find(p => p.email === "carol@acme.com");
  if (carol && carol.role !== "admin") {
    await api.post(`/api/admin/participants/${carol.id}/role`, { headers: h, data: { role: "admin" } });
  }
  await api.dispose();
}

async function restoreCarolToParticipant() {
  const { api, csrf } = await apiLogin("superadmin");
  const h = { "x-csrf-token": csrf, "content-type": "application/json" };
  // kind=all: the default list leaves admin accounts out, and she is one now.
  const parts = (await (await api.get("/api/admin/participants?limit=200&kind=all")).json()).participants || [];
  const carol = parts.find(p => p.email === "carol@acme.com");
  if (carol && carol.role !== "participant") {
    await api.post(`/api/admin/participants/${carol.id}/role`, { headers: h, data: { role: "participant" } });
  }
  await api.dispose();
}

async function loginAsAdminCarol(page) {
  await loginViaApi(page, "carol@acme.com", PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
}

// Standard polite delay after a tab/modal opens — gives ECharts canvases /
// CSS animations a moment to settle before the screenshot.
async function settle(page, ms = 400) { await page.waitForTimeout(ms); }

// Seed a small batch of synthetic challenge_events for the Analytics shots
// so the donut and per-challenge table aren't empty.
//
// v7.27.0 — IT MUST NOT GIVE ONE PARTICIPANT TWO `solved` EVENTS FOR ONE
// CHALLENGE. The round-robin below walks users and tasks on different moduli, so
// it can land a synthetic `solved` on a (user, task) that already has a REAL one
// from the seeded submissions. The platform itself cannot produce that — a
// second submit on a solved challenge is refused — but the fixture could, and
// the arithmetic showed: `solved` counts EVENTS while `unique_attempters` counts
// DISTINCT USERS, so the extra row rendered a **150% solve rate** in the
// documentation screenshot. Invisible until v7.27.0 put the denominator on
// screen next to the ratio.
async function seedAnalyticsRows() {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const { v4: uuidv4 } = require("uuid");
    const liveComp = db.prepare("SELECT id FROM competitions WHERE name=?").get("Test Live");
    if (!liveComp) return;
    const tasks = db.prepare("SELECT id FROM tasks WHERE active=1 LIMIT 5").all();
    const users = db.prepare("SELECT id FROM users WHERE role='participant' LIMIT 3").all();
    if (!tasks.length || !users.length) return;
    const insert = db.prepare("INSERT INTO challenge_events (id, user_id, task_id, competition_id, timeslot_id, event_type, details, occurred_at) VALUES (?,?,?,?,?,?,?,?)");
    const types = ["solved", "incorrect", "incorrect", "hint_revealed", "navigated_away"];
    // Every (user, task) that ALREADY counts as solved — real submissions
    // included, which is the pair the round-robin used to collide with.
    const solvedPairs = new Set(
      db.prepare("SELECT user_id, task_id FROM challenge_events WHERE event_type='solved'").all()
        .map(r => `${r.user_id}|${r.task_id}`));
    for (let i = 0; i < 12; i++) {
      const u = users[i % users.length];
      const t = tasks[i % tasks.length];
      let ev = types[i % types.length];
      const pair = `${u.id}|${t.id}`;
      // Substitute rather than skip, so the donut keeps its 12 events and the
      // shots stay as full as they were.
      if (ev === "solved" && solvedPairs.has(pair)) ev = "incorrect";
      if (ev === "solved") solvedPairs.add(pair);
      insert.run(uuidv4(), u.id, t.id, liveComp.id, null, ev, null, new Date(Date.now() - i * 60_000).toISOString());
    }
  } finally { db.close(); }
}

// v7.11.x — set up a live competition with two BOUND groups + a solo entrant, scored so
// the Group Rankings (admin) / Team Rankings (participant) boards render illustrative
// rows: Team Red (Priya 100 + Marcus 80 → avg 90), Ana on her own (70), Team Blue (Wei
// 50). Idempotent + cached so the participant and admin captures can both call it.
let _groupBoardScenario = null;
async function seedGroupBoardScenario() {
  if (_groupBoardScenario) return _groupBoardScenario;
  const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
  const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
  const compName = "Regional Cup";
  const existing = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.name === compName);
  if (existing) { await sa.dispose(); _groupBoardScenario = { compName, compId: existing.id, teamMemberEmail: "priya@acme.com" }; return _groupBoardScenario; }
  const now = Date.now();
  const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: compName, start_time: new Date(now - 30 * 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true } })).json()).competition.id;
  const mkTask = async (title, ans) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>Solve it.</p>", difficulty: "easy", answer_type: "text", correct_answer: ans, status: "published" } })).json()).id;
  const t1 = await mkTask("Warm-up", "a"), t2 = await mkTask("Main challenge", "b");
  for (const tid of [t1, t2]) await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
  const mkMember = async (nick, email) => {
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: { firstName: nick, lastName: "Player", nickname: nick, email, company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "New York" } });
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    return u.id;
  };
  const priya = await mkMember("Priya", "priya@acme.com");
  const marcus = await mkMember("Marcus", "marcus@acme.com");
  const wei = await mkMember("Wei", "wei@acme.com");
  const ana = await mkMember("Ana", "ana@acme.com");
  const red = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: "Team Red", userIds: [priya, marcus] } })).json()).group.id;
  const blue = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: "Team Blue", userIds: [wei] } })).json()).group.id;
  await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [red, blue], competitionIds: [compId] } });
  await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [ana], competitionIds: [compId] } });
  await sa.dispose();
  const play = async (email, seq) => {
    const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    await api.post("/api/select-competition", { headers: h, data: { competitionId: compId } });
    for (const [tid, ans] of seq) await api.post(`/api/tasks/${tid}/submit`, { headers: h, data: { answer: ans , gradingHash: await gradingHashFor(api, tid)} });
    await api.dispose();
  };
  const wrong = (tid, n) => Array.from({ length: n }, (_, i) => [tid, `no${i}`]);
  await play("priya@acme.com", [[t1, "a"], [t2, "b"]]);                     // 100
  await play("marcus@acme.com", [[t1, "a"], ...wrong(t2, 4), [t2, "b"]]);   // 80  → Team Red avg 90
  await play("wei@acme.com", [[t1, "a"]]);                                 // 50  → Team Blue 50
  await play("ana@acme.com", [[t1, "a"], ...wrong(t2, 6), [t2, "b"]]);      // 70  (solo)
  _groupBoardScenario = { compName, compId, teamMemberEmail: "priya@acme.com" };
  return _groupBoardScenario;
}

// v7.21.0 — challenge CATEGORIES.
//
// A category is an ordinary task tag spelled `category:<name>`, so seeding one
// is just adding a tag. This runs before the participant captures so the
// EXISTING challenge-grid (04) and challenge-detail (05) screenshots show the
// ribbons in situ — a reader meeting categories in the normal screenshots is
// better served than by a one-off shot that only exists to demonstrate them.
//
// `Challenge med1` deliberately gets TWO categories: it is the first UNSOLVED
// card (alice solved easy1 in the seed, and the participant grid forces the
// Unsolved filter while the competition is live), so it is the card 05 opens —
// which puts the multi-category case in both captures.
//
// Tags are lower-cased at insert by POST /api/admin/tasks/:id/tags, so the
// names below render lower-case; that is what a real instance looks like.
// Idempotent: a duplicate INSERT is swallowed server-side.
const SHOT_CATEGORIES = [
  ["Challenge easy1", ["category:web security"]],
  ["Challenge med1", ["category:cryptography", "category:reverse engineering"]],
  ["Challenge hard1", ["category:cloud"]],
];

async function seedChallengeCategories() {
  const { api, csrf } = await apiLogin("superadmin");
  const h = { "x-csrf-token": csrf, "content-type": "application/json" };
  try {
    const body = await (await api.get("/api/admin/tasks?limit=200")).json();
    const tasks = Array.isArray(body) ? body : (body.tasks || []);
    let tagged = 0;
    for (const [title, cats] of SHOT_CATEGORIES) {
      const t = tasks.find(x => x.title === title);
      if (!t) continue;
      let ok = true;
      for (const tag of cats) {
        const r = await api.post(`/api/admin/tasks/${t.id}/tags`, { headers: h, data: { tag } });
        if (!r.ok()) { ok = false; console.warn(`[shots] tag ${tag} -> ${title}: ${r.status()} ${await r.text().catch(() => "")}`); }
      }
      if (ok) tagged++;
    }
    // Fail LOUD rather than silently producing category-free screenshots: if the
    // seed fixture is ever renamed, the captures would still succeed and the docs
    // would quietly lose the ribbons they are supposed to be showing.
    if (tagged < 2) throw new Error(`[shots] category seeding tagged only ${tagged} challenge(s) — seed fixture titles changed?`);
  } finally {
    await api.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Participant role
// ═══════════════════════════════════════════════════════════════════════════════
// v8.7.5 — resolve an admin tab by its STABLE pane id, never by the label.
// The nav item now READS "Events" while its data-tab-id stays
// `admin-competitions-tab`, so navigation must not be spelled with copy.
// Mirrors TAB_SLUG in tests/ui-admin-helpers.js. MODULE scope: two describes
// use it, and a describe-scoped copy left the event-admin captures with a
// free variable that `node --check` cannot see (the v7.16.2 class).
const _TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions" };
const _tabSel = (name) =>
  `button.admin-nav-item[data-tab-id="admin-${_TAB_SLUG[String(name).toLowerCase()] || String(name).toLowerCase()}-tab"]`;

// v8.3.21 — widen until the named scroller has nothing left to scroll, so a
// capture cannot ship clipped (that release shot a column header cut off
// mid-word). v8.8.7 hoisted it out of the `admin` describe for the reason
// `_tabSel` above was hoisted: a describe-scoped copy leaves every other
// describe with a free variable `node --check` cannot see.
async function widenUntilUnclipped(page, scrollerSel, { max = 2400, step = 200 } = {}) {
  let width = 1280;
  for (; width <= max; width += step) {
    await page.setViewportSize({ width, height: 900 });
    await settle(page, 250);
    const over = await page.locator(scrollerSel).evaluate((el) => el.scrollWidth - el.clientWidth);
    if (over <= 2) return width;
  }
  const over = await page.locator(scrollerSel).evaluate((el) => el.scrollWidth - el.clientWidth);
  throw new Error(`${scrollerSel} still overflows by ${over}px at ${max}px wide — the capture would be clipped`);
}

test.describe("participant", () => {
  // v7.21.0 — put `category:` tags on the live competition's challenges so the
  // 04/05 captures show the category ribbons. See seedChallengeCategories.
  test.beforeAll(seedChallengeCategories);


  // v6.13.9 — ensure at least one unsolved task in the live competition
  // has an attachment before the 05-task-detail screenshot runs, so the
  // capture shows the "Download attachment" link that participant.md
  // describes. Idempotent: skip if an attachment already exists.
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const tasksList = await (await api.get("/api/admin/tasks")).json();
      const tasks = Array.isArray(tasksList) ? tasksList : (tasksList.tasks || []);
      // Attach to the first few un-locked published tasks so whichever
      // one the 05-task-detail test clicks shows the download link.
      const targets = tasks.filter(t => !t.locked && (t.status === "published" || !t.status)).slice(0, 5);
      if (targets.length === 0) return;
      // Check if any already has an attachment — if so skip entirely.
      const first = await (await api.get(`/api/admin/tasks/${targets[0].id}/attachments`)).json();
      if (Array.isArray(first.attachments) && first.attachments.length > 0) return;
      // Build a minimal valid (unencrypted) ZIP in-memory. Single file
      // "starter.txt" with a short message. Matches ATTACH_PREFLIGHT
      // validator's contract: central directory present, no encryption flag.
      const fs = require("fs");
      const path = require("path");
      const zlib = require("zlib");
      // Tiny hand-built ZIP: "starter.txt" with 18 bytes of text. We use
      // stored (no compression) for simplicity — local file header +
      // central directory + end-of-central-directory marker.
      const name = Buffer.from("starter.txt");
      const body = Buffer.from("hint: start here\n");
      // CRC32 via node:zlib (available since Node 22).
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),             // signature
        Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x00, 0x00]), // version/flags/method
        Buffer.from([0x00, 0x00, 0x21, 0x00]),             // time/date (arbitrary)
        crcBuf,
        Buffer.from([body.length, 0, 0, 0]),               // compressed size
        Buffer.from([body.length, 0, 0, 0]),               // uncompressed size
        Buffer.from([name.length, 0]),                     // name length
        Buffer.from([0, 0]),                               // extra length
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        Buffer.from([0x0a, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x00, 0x00, 0x21, 0x00]),
        crcBuf,
        Buffer.from([body.length, 0, 0, 0]),
        Buffer.from([body.length, 0, 0, 0]),
        Buffer.from([name.length, 0]),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // extra/comment/disk/internal/external
        Buffer.from([0, 0, 0, 0]),                          // offset of lfh (0)
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
        Buffer.from([0, 0, 0, 0]),                         // disk #
        Buffer.from([1, 0, 1, 0]),                         // entries (disk + total)
        Buffer.from([cdh.length, 0, 0, 0]),                // cd size
        Buffer.from([lfh.length, 0, 0, 0]),                // cd offset
        Buffer.from([0, 0]),                               // comment length
      ]);
      // Uploaded straight from memory: no temporary file is written.
      const zip = Buffer.concat([lfh, cdh, eocd]);
      {
        for (const target of targets) {
          const r = await api.post(`/api/admin/tasks/${target.id}/attachments`, {
            headers: { "x-csrf-token": csrf },
            multipart: {
              file: { name: "starter.zip", mimeType: "application/zip", buffer: zip },
              display_name: "starter",
            },
          });
          if (!r.ok()) {
            // Don't throw — continue so unrelated tests can still run.
            // eslint-disable-next-line no-console
            console.warn(`[shots beforeAll] attachment upload to ${target.id} failed: ${r.status()} ${await r.text().catch(() => "")}`);
          }
        }
      }
    } finally {
      await api.dispose();
    }
  });

  test("01-login", async ({ page }) => {
    await page.goto("/");
    await page.locator("#login-email").waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "01-login") });
  });

  test("02-registration", async ({ page }) => {
    // Dedicated /register SPA route (v6.9.10) — screenshot the form by
    // navigating straight to it so the URL bar in the capture reflects
    // the canonical link users get in invitation emails.
    // Email first: the sign-up card opens after a code proves a new address.
    await page.goto("/");
    await signUpViaUi(page, `sam.taylor.${Date.now()}@acme-shots.example`, {}, { submit: false });
    await page.locator("#reg-first").first().waitFor({ state: "visible", timeout: 5000 });
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "02-registration") });
  });

  test("11-event-code-dialog", async ({ page }) => {
    // v8.3.1 — the event-code dialog, reached from the sign-in screen's
    // "Here for an event? Enter its code" link. Captured in its RESOLVED state
    // (the event named, both doors, and the discard) because that is the state
    // the participant guide describes.
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    // A joinable Booth Event of its own — every seeded competition is either
    // ended, multi-session or has self-enrolment off. Created on an INDEPENDENT
    // superadmin context: this describe's page fixture is a participant (and
    // here, anonymous), so `page.request` could not create it.
    let display = null;
    const { api: sa, csrf: sc } = await freshCtx();
    try {
      await sa.post("/api/login", { headers: { "x-csrf-token": sc, "content-type": "application/json" },
        data: { email: "superadmin", password: getSuperadminPass() } });
      const c2 = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
      const cr = await sa.post("/api/admin/competitions", {
        headers: { "x-csrf-token": c2, "content-type": "application/json" },
        data: {
          name: "Security Summit Booth", event_kind: "booth", timezone: "UTC",
          start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
          self_enroll_enabled: true,
        },
      });
      if (cr.ok()) {
        const comp = (await cr.json()).competition;
        const rv = await (await sa.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
        display = rv.join_code_display;
      }
    } finally { await sa.dispose(); }
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.waitForSelector("#ec-code", { timeout: 10000 });
    if (display) {
      await page.fill("#ec-code", display);
      await page.click('[data-action="event-code-apply"]');
      await page.waitForSelector('[data-action="event-code-signin"]', { timeout: 15000 }).catch(() => {});
    }
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "11-event-code-dialog") });
    await page.click('[data-action="overlay-close"]').catch(() => {});
  });

  test("11b-join-banner-not-your-event", async ({ page }) => {
    // The sign-in card holding an event a join link, QR or event code brought,
    // with "Not your event? Continue without it" under its name: the state the
    // participant guide's "Scanned the wrong thing?" describes.
    let display = null;
    const { api: sa, csrf: sc } = await freshCtx();
    try {
      await sa.post("/api/login", { headers: { "x-csrf-token": sc, "content-type": "application/json" },
        data: { email: "superadmin", password: getSuperadminPass() } });
      const c2 = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
      const cr = await sa.post("/api/admin/competitions", {
        headers: { "x-csrf-token": c2, "content-type": "application/json" },
        data: {
          name: "Cloud Security Day", event_kind: "booth", timezone: "UTC",
          start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
          self_enroll_enabled: true,
        },
      });
      if (cr.ok()) {
        const comp = (await cr.json()).competition;
        const rv = await (await sa.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
        display = rv.join_code_display;
      }
    } finally { await sa.dispose(); }
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.waitForSelector("#ec-code", { timeout: 10000 });
    await page.fill("#ec-code", display || "");
    await page.click('[data-action="event-code-apply"]');
    await page.click('[data-action="event-code-signin"]', { timeout: 15000 });
    await page.locator("#join-banner-out").waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "11b-join-banner-not-your-event") });
  });

  test("12-signin-code-dialog", async ({ page }) => {
    // v8.3.1 — the emailed sign-in code, in its own dialog. Captured at STEP TWO,
    // which is the whole point of the move: it names the mailbox the code was
    // sent to, which the old inline field never did.
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    // "Already have a code?" with an address already typed opens straight at the
    // code step, so the address goes into the dialog's own step one instead.
    await page.fill("#login-email", "sam.taylor@acme.com");
    await page.click("#login-submit");
    await page.waitForSelector("#sc-code", { timeout: 15000 }).catch(() => {});
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "12-signin-code-dialog") });
    await page.click('[data-action="overlay-close"]').catch(() => {});
  });



  // ── v9.0.0 — HOW AN ACCOUNT SIGNS IN ───────────────────────────────────────
  // The card's password step, the profile's "How you sign in", an admin's
  // first-sign-in password prompt, and the break-glass username on the card.
  // Fixed, readable addresses, created once and reused by the light and dark
  // passes (which share one data dir): a create that finds the account is fine.
  async function _shotAccount(email, { role = null, password = null, first = "Jordan", last = "Ellis" } = {}) {
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    const H = { "x-csrf-token": sc, "content-type": "application/json" };
    try {
      if (role) {
        await sa.post("/api/admin/users", { headers: H, data: { email, role, first_name: first, last_name: last } });
      } else {
        const exists = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.some((p) => p.email === email);
        if (!exists) {
          const r = await registerPost(sa, "/api/register", { headers: H, keepState: true, data: {
            firstName: first, lastName: last, company: "Acme", title: "Security Engineer", country: "GB", timezone: "Europe/London", email } });
          if (!r.ok()) throw new Error(`shot account ${email}: ${r.status()} ${await r.text()}`);
        }
      }
    } finally { await sa.dispose(); }
    if (password) {
      const { api, csrf } = await freshCtx();
      try {
        const li = await codeLogin(api, email, { "x-csrf-token": csrf, "content-type": "application/json" });
        if (!li.ok()) throw new Error(`shot sign-in ${email}: ${li.status()}`);
        const t = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        const r = await api.put("/api/me/sign-in-method", { headers: { "x-csrf-token": t, "content-type": "application/json" }, data: { method: "password", password } });
        if (!r.ok()) throw new Error(`shot password ${email}: ${r.status()} ${await r.text()}`);
      } finally { await api.dispose(); }
    }
    return email;
  }

  test("20-signin-password", async ({ page }) => {
    const email = await _shotAccount("jordan.ellis@acme.com", { password: "a-long-shot-password" });
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.fill("#login-email", email);
    await page.click("#login-submit");
    await page.waitForSelector("#login-password", { state: "visible", timeout: 15000 });
    await page.fill("#login-password", "a-long-shot-password");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "20-signin-password") });
  });

  test("21-how-you-sign-in", async ({ page }) => {
    const email = await _shotAccount("riley.chen@acme.com", { first: "Riley", last: "Chen" });
    await loginViaApi(page, email);
    await page.goto(BASE + "/");
    await page.waitForSelector("#main-nav .nav-btn", { timeout: 20000 });
    await require("./chrome-helpers").pressAccountMenuItem(page, "open-profile-editor");
    await page.click("[data-action='open-sign-in-method']");
    await page.waitForSelector("#sign-in-method-overlay", { timeout: 10000 });
    await page.check("#sign-in-method-overlay input[name='sim-method'][value='password']");
    await page.waitForSelector("#sim-new", { state: "visible", timeout: 5000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "21-how-you-sign-in") });
  });

  test("71-set-password", async ({ page }) => {
    const email = await _shotAccount("morgan.reyes@acme.com", { role: "admin", first: "Morgan", last: "Reyes" });
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.fill("#login-email", email);
    await page.click("#login-submit");
    await page.waitForSelector("#login-code-instead", { state: "visible", timeout: 15000 });
    await page.request.post(BASE + "/api/test/reset-recent-code-sends", { headers: { "x-csrf-token": (await (await page.request.get(BASE + "/api/csrf-token")).json()).csrfToken } }).catch(() => {});
    await page.click("#login-code-instead");
    await page.waitForSelector("#sc-code", { timeout: 15000 });
    const code = (await (await page.request.get(BASE + "/api/test/last-login-code?email=" + encodeURIComponent(email))).json()).code;
    await page.fill("#sc-code", code);
    await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
    await page.waitForSelector("#set-password-overlay", { timeout: 15000 });
    await settle(page, 400);
    // Left unanswered, so the next (dark) pass finds the same prompt.
    await page.screenshot({ path: shotPath("admin", "71-set-password") });
  });

  test("14-breakglass-signin", async ({ page }) => {
    await page.goto(BASE + "/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.fill("#login-email", "superadmin");
    await page.click("#login-submit");
    await page.waitForSelector("#login-password", { state: "visible", timeout: 15000 });
    await page.fill("#login-password", "break-glass-shot");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("superadmin", "14-breakglass-signin") });
  });

  test("03-comp-picker", async ({ page }) => {
    await loginAsAlice(page);
    // Alice has `active_competition_id` set after seed-time, so the post-login
    // auto-resume drops her on tasks-page. Clicking Competitions on a live
    // comp pops a "Leave Event?" confirm modal — accept it to land on
    // the picker.
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().waitFor({ state: "visible" });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().click();
    // The leave modal may take a moment to animate in; wait briefly. If the
    // user has no active comp yet (fresh-worker edge case) the modal never
    // shows and we skip directly to the picker.
    const leaveBtn = page.locator("#modal-confirm-btn:has-text('Leave')");
    await leaveBtn.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    if (await leaveBtn.isVisible().catch(() => false)) await leaveBtn.click();
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#comp-grid .comp-card").first().waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 600);
    await page.screenshot({ path: shotPath("participant", "03-comp-picker") });
  });

  test("04-tasks-list", async ({ page }) => {
    await loginAliceIntoLive(page);
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
    await page.locator(".task-card").first().waitFor({ state: "visible" });
    // v7.21.0 — the point of this capture is now partly the category ribbons, so
    // assert they are actually ON SCREEN before the shutter: a screenshot cannot
    // fail, it just quietly documents the wrong thing. `>= 3` is the positive
    // control for the MULTI-category case — two cards are shown (med1 + hard1)
    // and med1 carries two categories, so a build that rendered only the first
    // category per card would give 2 and fail here.
    await expect(page.locator(".task-card .cat-ribbon").first()).toBeVisible();
    expect(await page.locator(".task-card .cat-ribbon").count()).toBeGreaterThanOrEqual(3);
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "04-tasks-list") });
  });

  test("05-task-detail", async ({ page }) => {
    await loginAliceIntoLive(page);
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
    // Pick the first challenge that's NOT yet solved (alice solved easy1 in seed).
    await page.locator(".task-card:not(.solved)").first().click();
    await page.locator("#task-detail-card").waitFor({ state: "visible" });
    // v7.21.0 — as in 04: the ribbons must be visible at capture time, and the
    // card opened here is the two-category one, so assert both are rendered.
    await expect(page.locator("#task-detail-card .cat-ribbon").first()).toBeVisible();
    expect(await page.locator("#task-detail-card .cat-ribbon").count()).toBeGreaterThanOrEqual(2);
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "05-task-detail") });
  });

  test("13-mc-review-after-end", async ({ page }) => {
    // v7.20.1 — reviewing a multiple-choice challenge after the competition has
    // ended: the OPTIONS are still shown, and the answer is stated above them
    // (this participant solved it). Referenced from participant.md.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r0 = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() } });
    if (!r0.ok()) throw new Error(`superadmin login: ${r0.status()}`);
    const sc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": sc, "content-type": "application/json" };
    const t = Date.now();
    const comp = (await (await page.request.post("/api/admin/competitions", { headers: H, data: {
      name: `AppSec Radar Review`, start_time: new Date(t - 30 * 60_000).toISOString(),
      duration_minutes: 120, reveal_answers_on_end: true } })).json()).competition.id;
    const taskId = (await (await page.request.post("/api/admin/tasks", { headers: H, data: {
      title: "Which repository deserves attention first?",
      difficulty: "easy", answer_type: "choice", status: "published",
      description: "<p>Three repositories need triage and you only have time for one today.</p>",
      explanation: "<p>Public exposure, production runtime, a known exploit and an available fix together make the highest priority.</p>",
      choices: [
        { text: "CustomerAPI — public, production, exploit available, fix available", correct: true },
        { text: "ReportingJob — internal, production, no known exploit" },
        { text: "TestHarness — internal, non-production" },
      ] } })).json()).id;
    await page.request.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [comp] } });
    const ps = await (await page.request.get("/api/admin/participants?limit=5000")).json();
    const alice = (ps.participants || ps).find((p) => p.email === "alice@acme.com");
    await page.request.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [alice.id], competitionIds: [comp] } });

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    const ac = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: { competitionId: comp } });
    // Solve it, so the shot shows the "you got it right" state.
    const body = await (await page.request.get(`/api/tasks/${taskId}`)).json();
    // (No admin call here — we are alice at this point; the correct option is
    // identified by its text from the participant payload.)
    const correctText = "CustomerAPI";
    const pick = (body.choices || []).find((c) => c.text.startsWith(correctText));
    await page.request.post(`/api/tasks/${taskId}/submit`, { headers: { "x-csrf-token": ac },
      multipart: { answer: JSON.stringify([pick.id]), gradingHash: body.grading_hash } });

    // End it as superadmin, then review as alice.
    await loginViaApi(page, "superadmin", getSuperadminPass());
    const sc2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post(`/api/admin/competitions/${comp}/end-now`, { headers: { "x-csrf-token": sc2 } });
    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    const ac2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": ac2, "content-type": "application/json" }, data: { competitionId: comp } });

    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    const ended = page.locator("#modal-overlay.open");
    await ended.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    for (let i = 0; i < 5 && await ended.isVisible().catch(() => false); i++) {
      await page.locator("#modal-confirm-btn").click({ timeout: 3000 }).catch(() => {});
      await ended.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`).click();
    await page.locator("#choice-review").waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "13-mc-review-after-end") });

    // RESTORE alice's competition. Per-file isolation separates spec FILES;
    // these screenshot tests all live in one file and share the seeded state,
    // so a test that switches alice into a competition it created must switch
    // her back — otherwise the next one (06-hint-reveal) looks for an unsolved
    // challenge in an ended competition and times out.
    const back = await (await page.request.get("/api/my-competitions")).json();
    const liveOne = (back.competitions || back || []).find((c) => c.status === "live");
    if (liveOne) {
      const rc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": rc, "content-type": "application/json" },
        data: { competitionId: liveOne.id } });
    }
  });

  test("18-any-answer-detail", async ({ page }) => {
    // v8.9.1 — a participant's Any answer challenge BEFORE answering: a
    // single-line box whose label says any non-empty answer is accepted, a
    // plain Submit Answer button, no hint. Referenced from participant.md.
    // Nothing is submitted: alice is the sole enrollee on the sole challenge,
    // so a submit would auto-end the event on the spot (fixture checklist 1),
    // and the pre-answer state is what the guide's bullet describes.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r0 = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() } });
    if (!r0.ok()) throw new Error(`superadmin login: ${r0.status()}`);
    const sc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": sc, "content-type": "application/json" };
    const t = Date.now();
    const cr = await page.request.post("/api/admin/competitions", { headers: H, data: {
      name: `AppSec Retro`, start_time: new Date(t - 30 * 60_000).toISOString(), duration_minutes: 120 } });
    if (!cr.ok()) throw new Error(`competition seed failed: ${cr.status()} ${await cr.text()}`);
    const comp = (await cr.json()).competition.id;
    const tr = await page.request.post("/api/admin/tasks", { headers: H, data: {
      title: "What would you change first in this codebase?",
      difficulty: "easy", answer_type: "any", status: "published",
      description: "<p>Tell us in a sentence or two. There is no right answer — we read every response after the event.</p>" } });
    if (!tr.ok()) throw new Error(`task seed failed: ${tr.status()} ${await tr.text()}`);
    const taskId = (await tr.json()).id;
    await page.request.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [comp] } });
    const ps = await (await page.request.get("/api/admin/participants?limit=5000")).json();
    const alice = (ps.participants || ps).find((p) => p.email === "alice@acme.com");
    const asg = await (await page.request.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [alice.id], competitionIds: [comp] } })).json();
    if (asg.assigned !== 1) throw new Error(`assign skipped alice: ${JSON.stringify(asg)}`);

    await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
    const ac = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: { competitionId: comp } });
    await page.goto("/");
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`).click();
    await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 15000 });
    // The state the caption describes, asserted before shooting.
    await expect(page.locator('#ans-text[data-mode="any"]')).toBeVisible();
    await expect(page.locator('label[for="ans-text"]')).toContainText(/any non-empty answer is accepted/i);
    await expect(page.locator('[data-action="task-submit-answer"][data-mode="any"]')).toBeVisible();
    await expect(page.locator("#hint-area")).toHaveCount(0);
    await expect(page.locator('[data-action="task-reveal-hint"]')).toHaveCount(0);
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "18-any-answer-detail") });

    // RESTORE alice's competition (see 13-mc-review-after-end for why).
    const back = await (await page.request.get("/api/my-competitions")).json();
    const liveOne = (back.competitions || back || []).find((c) => c.status === "live" && c.id !== comp);
    if (liveOne) {
      const rc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": rc, "content-type": "application/json" },
        data: { competitionId: liveOne.id } });
    }
  });

  test("21-booth-tap-answer", async ({ browser }) => {
    // v8.13.0 — a Booth Event's multiple-choice question on a phone: the question
    // at the top, lettered answer tiles below, the countdown in the bar beside
    // Back, the header/menu/footer set aside. Referenced from participant.md.
    // Its OWN participant (never alice: entering an event writes the auto-resume
    // marker other captures rely on), on a 390x664 touch screen, nothing answered.
    const bct = require("./booth-choice-tap-fixture");
    const { api, csrf } = await bct.sa();
    const { comp, ids } = await bct.eventWithChoices(api, csrf, { tasks: [bct.SQL_Q] });
    const who = await bct.participantIn(api, csrf, comp.id);
    await api.dispose();
    const ctx = await bct.deviceContext(browser, { width: 390, height: 664, theme: THEME });
    const page = await ctx.newPage();
    try {
      await page.emulateMedia({ colorScheme: THEME, reducedMotion: "reduce" });
      await bct.signInTo(page, who.email, comp.id);
      await bct.openChallenge(page, ids[0]);
      // The state the caption describes, asserted before shooting.
      const s = await bct.tapState(page);
      if (!s.tap || s.fit !== "fixed" || s.headerShown || !s.timerInBar || s.tileCount !== 4)
        throw new Error(`not the one-screen tap view: ${JSON.stringify(s)}`);
      await expect(page.locator(".mcf-back")).toBeVisible();
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await settle(page, 400);
      await page.screenshot({ path: shotPath("participant", "21-booth-tap-answer") });
    } finally { await ctx.close(); }
  });

  test("20-staff-events-two-sections", async ({ page }) => {
    // v8.12.0 — a STAFF member's Events page: "Your Events" (the events they
    // were added to, one of them badged Competing) above "All other events"
    // (the rest of the platform, enterable without enrolment). Its own
    // participant, tagged staff, enrolled in TWO events where staff compete —
    // two, because with exactly one the sole-event landing puts them straight
    // into it and the picker under test is never shown (fixture checklist 10).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const email = `staff-shot-${t}@acme.com`;
    const anon = await request.newContext({ baseURL: BASE });
    const ac = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
      email, password: PARTICIPANT_PASS, nickname: `staff_shot_${t % 100000}`, firstName: "Sam", lastName: "Staff",
      company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" } });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()} ${await reg.text()}`);
    await anon.dispose();
    const ps = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const w = (ps.participants || ps).find(p => p.email === email);
    await sa.post(`/api/admin/participants/${w.id}/verify`, { headers: H });
    await sa.post(`/api/admin/participants/${w.id}/approve`, { headers: H });
    await sa.post(`/api/admin/participants/${w.id}/tags`, { headers: H, data: { tag: "staff" } });
    const mk = async (name, offsetMin) => {
      const r = await sa.post("/api/admin/competitions", { headers: H, data: {
        name, start_time: new Date(t + offsetMin * 60_000).toISOString(), duration_minutes: 240,
        event_kind: "tournament", staff_compete: true } });
      if (!r.ok()) throw new Error(`event seed failed: ${r.status()} ${await r.text()}`);
      const d = await r.json(); return d.competition?.id || d.id;
    };
    const e1 = await mk("Cloud Security Cup", -30), e2 = await mk("AppSec Autumn Open", 120);
    const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [w.id], competitionIds: [e1, e2] } })).json();
    if (asg.assigned !== 2) throw new Error(`assign skipped the staff member: ${JSON.stringify(asg)}`);
    await sa.dispose();

    await loginViaApi(page, email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 20000 });
    // ASSERT THE STATE BEFORE SHOOTING: both sections, and the own event badged.
    await expect(page.locator("#comp-other-section")).toBeVisible();
    await expect(page.locator("#comp-grid .comp-card")).toHaveCount(2);
    await expect(page.locator("#comp-grid .status-badge.competing").first()).toBeVisible();
    await expect(page.locator("#comp-other-grid .comp-card").first()).toBeVisible();
    await expect(page.locator("#comp-other-grid"), "the own events are not repeated below").not.toContainText("Cloud Security Cup");
    await settle(page, 500);
    await page.screenshot({ path: shotPath("participant", "20-staff-events-two-sections"), fullPage: true });
  });

  test("19-sealed-answer-not-shown", async ({ page }) => {
    // v8.10.0 — after an event that DOES reveal its answers, a sealed challenge
    // shows "Answer not shown" where the Solution box would be, and says why.
    // Referenced from participant.md → After the event.
    //
    // The sealed challenge must be seeded by a REAL admin account, not the
    // built-in superadmin: a seal names an author and the built-in account has
    // no `users` row, so the platform refuses it (and that refusal has its own
    // test). Carol is promoted for the seed and put back afterwards.
    await ensureCarolIsAdmin();
    let taskId = null, comp = null, sealCsrf = null;
    try {
      await loginViaApi(page, "carol@acme.com", PARTICIPANT_PASS);
      sealCsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const H = { "x-csrf-token": sealCsrf, "content-type": "application/json" };
      const t = Date.now();
      // reveal_answers_on_end ON, or the absence below means nothing: it is the
      // unsealed twin being revealed that makes the sealed one's panel a
      // withholding rather than an event that publishes nothing.
      const cr = await page.request.post("/api/admin/competitions", { headers: H, data: {
        name: "Packet Capture Night", start_time: new Date(t - 30 * 60_000).toISOString(),
        duration_minutes: 120, reveal_answers_on_end: true } });
      if (!cr.ok()) throw new Error(`competition seed failed: ${cr.status()} ${await cr.text()}`);
      comp = (await cr.json()).competition.id;

      const mk = async (data) => {
        const r = await page.request.post("/api/admin/tasks", { headers: H, data });
        if (!r.ok()) throw new Error(`task seed failed: ${r.status()} ${await r.text()}`);
        const id = (await r.json()).id;
        await page.request.post(`/api/admin/tasks/${id}/competitions`, { headers: H, data: { competitionIds: [comp] } });
        return id;
      };
      taskId = await mk({
        title: "Recover the flag from the packet capture",
        difficulty: "medium", answer_type: "text", status: "published",
        description: "<p>The capture is attached. Find the flag the operator leaked.</p>",
        correct_answer: "CTF{quiet_on_the_wire}",
        explanation: "<p>The credentials cross the wire in the clear on the third TCP stream.</p>",
        answer_sealed: true });

      const ps = await (await page.request.get("/api/admin/participants?limit=5000")).json();
      const alice = (ps.participants || ps).find((p) => p.email === "alice@acme.com");
      const asg = await (await page.request.post("/api/admin/competitions/assign", {
        headers: H, data: { userIds: [alice.id], competitionIds: [comp] } })).json();
      if (asg.assigned !== 1) throw new Error(`assign skipped alice: ${JSON.stringify(asg)}`);

      // End it, so the reveal has happened and the panel is what a participant
      // meets. Alice submits nothing: she is the sole enrollee, so a correct
      // answer would auto-end the event underneath us (fixture checklist 1) and
      // the panel renders for a non-solver just the same.
      const en = await page.request.post(`/api/admin/competitions/${comp}/end-now`, { headers: H });
      if (!en.ok()) throw new Error(`end-now failed: ${en.status()} ${await en.text()}`);

      await loginViaApi(page, "alice@acme.com", PARTICIPANT_PASS);
      const ac = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      await page.request.post("/api/select-competition", {
        headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: { competitionId: comp } });
      // The ended-event modal is raised by the status poll and intercepts every
      // click, so dismiss it the way the platform does (v8.6.6).
      await page.request.post("/api/dismiss-ended", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {} });
      await page.goto("/");
      await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
      await page.locator("#nav-challenges:not([aria-disabled=true])").click();
      await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`).click();
      await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 15000 });

      // The state the caption describes, asserted before shooting — including
      // by VALUE, so a build that revealed the key would fail here rather than
      // ship a screenshot of the thing this feature exists to prevent.
      await expect(page.locator("#task-detail-card")).toContainText("Answer not shown");
      await expect(page.locator("#task-detail-card")).toContainText(/sealed its answer, so it is not shown here/i);
      await expect(page.locator("#task-detail-card")).not.toContainText("CTF{quiet_on_the_wire}");
      await expect(page.locator("#task-detail-card")).not.toContainText(/third TCP stream/i);
      await settle(page, 500);
      await page.screenshot({ path: shotPath("participant", "19-sealed-answer-not-shown") });

      // RESTORE alice's competition (see 13-mc-review-after-end for why).
      const back = await (await page.request.get("/api/my-competitions")).json();
      const liveOne = (back.competitions || back || []).find((c) => c.status === "live" && c.id !== comp);
      if (liveOne) {
        const rc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
        await page.request.post("/api/select-competition", {
          headers: { "x-csrf-token": rc, "content-type": "application/json" }, data: { competitionId: liveOne.id } });
      }
    } finally {
      await restoreCarolToParticipant();
    }
  });

  test("06-hint-reveal", async ({ page }) => {
    await loginAsAlice(page);
    const tasksPage = page.locator("#tasks-page");
    if (!(await tasksPage.isVisible().catch(() => false))) {
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click();
    }
    // Open a challenge with an unrevealed hint.
    await page.locator(".task-card:not(.solved)").first().click();
    await page.locator("#hint-area").waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "06-hint-reveal") });
  });

  test("07-leaderboard", async ({ page }) => {
    // v7.15.0 — seed one participant who has finished EVERY challenge, so the
    // shot actually shows the green "All Solved" pill the guide describes. Safe
    // for the seeded comp: the all-solved auto-end only fires when EVERY active
    // participant has finished, and alice/bob/carol have not. Idempotent across
    // the light+dark passes that share a data dir (the nickname is stable and a
    // repeat solve is a no-op "already solved").
    {
      const sa = await apiLogin("superadmin");
      const H = { "x-csrf-token": sa.csrf, "content-type": "application/json" };
      const comps = await (await sa.api.get("/api/admin/competitions")).json();
      const live = comps.find(c => c.name === "Test Live");
      const email = "finisher@acme.com";
      let parts = (await (await sa.api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json()).participants || [];
      if (!parts.find(p => p.email === email)) {
        const { api: anon, csrf: ac } = await freshCtx();
        await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
          firstName: "Dana", lastName: "Reyes", nickname: "dana_r", email,
          company: "Acme", title: "Security Engineer", country: "US", timezone: "America/New_York",
          jobFunction: "Software Developer / Engineer", city: "New York", password: PARTICIPANT_PASS,
        }});
        await anon.dispose();
        parts = (await (await sa.api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json()).participants || [];
        const u = parts.find(p => p.email === email);
        await sa.api.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": sa.csrf } });
        await sa.api.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": sa.csrf } });
        await sa.api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [u.id], competitionIds: [live.id] } });
      }
      // Solve every published challenge assigned to the competition.
      const p = await apiLogin(email, PARTICIPANT_PASS);
      const pH = { "x-csrf-token": p.csrf, "content-type": "application/json" };
      await p.api.post("/api/select-competition", { headers: pH, data: { competitionId: live.id } });
      const tasks = await (await p.api.get("/api/tasks")).json();
      for (const t of (tasks.tasks || tasks || [])) {
        const key = String(t.title || "").replace(/^Challenge\s+/i, "");
        await p.api.post(`/api/tasks/${t.id}/submit`, { headers: pH, data: { answer: `answer-${key}` , gradingHash: await gradingHashFor(p.api, t.id)} }).catch(() => {});
      }
      await p.api.dispose();
      await sa.api.dispose();
    }
    await loginAsAlice(page);
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().waitFor({ state: "visible" });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
    await page.locator("#leaderboard-page").waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "07-leaderboard") });
  });

  test("10-timeslot-picker", async ({ page }) => {
    // Multi-session competition triggers the timeslot picker before
    // letting the participant in. Not part of the base seed; we
    // create a throwaway multi-slot comp, assign bob to it, and
    // navigate him to the picker.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const now = Date.now();
    const cr = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `MultiSlot-Shot-${t}`, start_time: new Date(now + 4 * 3600_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await cr.json()).competition.id;
    // Add two timeslots so the picker has at least two cards to render.
    for (const [label, offsetH] of [["Morning (UTC+1)", 4], ["Afternoon (UTC+8)", 12]]) {
      await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saH, data: { name: label, start_time: new Date(now + offsetH * 3600_000).toISOString(), duration_minutes: 120 },
      });
    }
    // Get bob's id and assign him.
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const bobId = parts.find(p => p.email === "bob@acme.com").id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [bobId], competitionIds: [compId] } });
    await sa.dispose();

    await loginViaApi(page, "bob@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 10000 });
    // Click the MultiSlot card — it should redirect to the picker.
    await page.locator(`.comp-card:has-text('MultiSlot-Shot-${t}')`).first().click();
    await page.locator("#timeslot-picker-page.active").waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "10-timeslot-picker") });
  });

  test("09-pending-page", async ({ page }) => {
    // Participant waiting for an upcoming competition to start. Alice
    // is seeded with active_competition_id = Test Live, so she
    // auto-resumes into that tab. To land on the pending page we
    // click Competitions → pick Test Upcoming → accept the Leave
    // modal if it shows.
    await loginAsAlice(page);
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().click();
    const leaveBtn = page.locator("#modal-confirm-btn:has-text('Leave')");
    await leaveBtn.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    if (await leaveBtn.isVisible().catch(() => false)) await leaveBtn.click();
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".comp-card:has-text('Test Upcoming')").first().click();
    await page.locator("#pending-page.active").waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "09-pending-page") });
  });

  test("08-profile", async ({ page }) => {
    await loginAsAlice(page);
    // Profile lives in the account menu (tests/chrome-helpers.js).
    await require("./chrome-helpers").pressAccountMenuItem(page, "open-profile-editor");
    await page.locator("#profile-overlay, .card:has-text('Edit Profile'), input[id^='prof-']").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "08-profile") });
  });

  test("11-badge-share", async ({ page }) => {
    // Top-3 finisher on a fully-ended competition → the LinkedIn share-badge
    // preview modal. Not in the base seed; we create a throwaway competition
    // where Alice is the sole member and solves the only task, which auto-ends
    // it and ranks her 1st, then open the share modal.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const cr = await sa.post("/api/admin/competitions", {
      headers: saH, data: { name: `AI Security Challenge ${new Date().getUTCFullYear()}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180 },
    });
    const compId = (await cr.json()).competition.id;
    const tr = await sa.post("/api/admin/tasks", {
      headers: saH, data: { title: `BadgeShotTask ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "win", explanation: "<p>e</p>", hint: "h", status: "published" },
    });
    const taskId = (await tr.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const aliceId = parts.find(p => p.email === "alice@acme.com").id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [aliceId], competitionIds: [compId] } });
    await sa.dispose();

    const { api: pa, csrf: pc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const pH = { "x-csrf-token": pc, "content-type": "application/json" };
    await pa.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
    await pa.post(`/api/tasks/${taskId}/submit`, { headers: pH, data: { answer: "win" , gradingHash: await gradingHashFor(pa, taskId)} }); // → auto-ends
    // v8.6.6 — THE SUBMIT ABOVE AUTO-ENDS THE COMPETITION, AND SINCE v8.3.15
    // auto-resume enters an ENDED event — so the login below lands alice INSIDE
    // it, the status poll raises the "Event Ended" modal, and
    // `#modal-overlay` (position:fixed; inset:0; z-index:9600) intercepts the
    // CTA click for ever. `tests/badge-ui.spec.js` carries this exact fix with a
    // comment naming the trap; v8.3.15 added it there and skipped this file.
    // MEASURED: this line alone makes the capture pass; changing the readiness
    // wait alone does NOT.
    await pa.post("/api/dismiss-ended", { headers: pH });
    await pa.dispose();

    await loginAsAlice(page);
    // A nav BUTTON, not `#main-nav`: that container is static markup satisfied
    // before boot (v8.6.4 swept four of these across two files and missed this
    // one, for the same testIgnore reason).
    await page.waitForSelector("#main-nav .nav-btn", { timeout: 15000 });
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { competitionId: compId } });
    await page.evaluate((id) => { window.S.currentCompetitionId = id; window.showMain("leaderboard-page"); }, compId);
    const cta = page.locator('#lb-badge-cta [data-action="open-badge-share"]');
    await cta.waitFor({ state: "visible", timeout: 10000 });
    await cta.click();
    await page.locator(".badge-share-img").waitFor({ state: "visible", timeout: 10000 });
    await expect.poll(async () => page.locator(".badge-share-img").evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    await settle(page, 500);
    await page.screenshot({ path: shotPath("participant", "11-badge-share") });
  });

  test("12-team-rankings", async ({ page }) => {
    // v7.11.x — the participant-facing group leaderboard ("Team Rankings").
    // Priya plays on Team Red in a competition that has bound groups, so her
    // leaderboard shows both the individual board and the team board below it.
    const s = await seedGroupBoardScenario();
    await loginViaApi(page, s.teamMemberEmail, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrfToken, "content-type": "application/json" }, data: { competitionId: s.compId } });
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
    await page.locator("#leaderboard-page").waitFor({ state: "visible" });
    await page.locator("#lb-group-section").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#lb-group-section").scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: shotPath("participant", "12-team-rankings") });
  });

  test("15-attempt-counter", async ({ page }) => {
    // v8.3.22 — the counter a capped challenge shows while attempts remain.
    // The whole point of the picture is the pair of numbers, so the capture
    // ASSERTS the text before shooting rather than trusting the fixture: a
    // challenge whose burn silently failed would otherwise ship a screenshot of
    // an ordinary answer box under a caption about attempt limits.
    const fx = await ensureCappedFixture();
    await loginViaApi(page, fx.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrfToken, "content-type": "application/json" }, data: { competitionId: fx.compId } });
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.evaluate((id) => window.openTask(id), fx.partial);
    await page.locator("#task-detail-card .attempts-left").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#task-detail-card .attempts-left")).toContainText("2 of 3 attempts left");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "15-attempt-counter") });
  });

  test("16-attempts-exhausted", async ({ page }) => {
    // v8.3.22 — the state the participant guide sends people to an organiser
    // from. The input is REPLACED by this panel rather than disabled, which is
    // the thing worth showing: there is no live box in front of a submission
    // that can only be refused.
    const fx = await ensureCappedFixture();
    await loginViaApi(page, fx.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrfToken, "content-type": "application/json" }, data: { competitionId: fx.compId } });
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.evaluate((id) => window.openTask(id), fx.spent);
    await page.locator("#task-detail-card .attempts-exhausted").waitFor({ state: "visible", timeout: 15000 });
    // The answer box must be GONE, not merely hidden — that is the claim.
    await expect(page.locator("#task-detail-card #answer-input")).toHaveCount(0);
    // With no answer box to focus, focus falls to the challenge title and paints
    // a focus ring around it — an artefact of the state, not something a reader
    // needs to see. Every other task-detail capture shows the ring on the input.
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "16-attempts-exhausted") });
  });

  test("17-certificate-cta", async ({ page }) => {
    // v8.3.22 — a Program's completion certificate, offered at the top of the
    // Challenges page rather than from a leaderboard, and available the moment
    // every challenge is solved rather than when the event ends. Both facts are
    // what the participant guide now says and neither had ever been shown.
    const fx = await ensureCompletedProgramFixture();
    await loginViaApi(page, fx.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/select-competition", { headers: { "x-csrf-token": csrfToken, "content-type": "application/json" }, data: { competitionId: fx.compId } });
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#cert-cta").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#cert-cta")).toContainText("Your certificate is ready");
    // The Leaderboard button stays in the bar on a Program but INACTIVE
    // (aria-disabled, "This event has no leaderboard"), captured in the same
    // frame, because that is half of what the section explains. The selector asks
    // for an ACTIVE button: `updateParticipantNav()` makes it inactive for an
    // unranked event.
    await expect(page.locator("#nav-leaderboard:not([aria-disabled=true])")).toBeHidden();
    // The list forces the Unsolved filter while an event is live, so a finished
    // Program shows an empty grid under the CTA. Click All, which is what the
    // empty state itself tells the participant to do, so the picture shows the
    // certificate offer above the work that earned it.
    await page.locator("#solve-filters [data-value=\"all\"]").first().click();
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "17-certificate-cta") });
  });

  // The account menu (the round button at the top right) and the Appearance
  // page it opens. Both were described by the participant guide with no picture.
  test("22-account-menu", async ({ page }) => {
    await loginAliceIntoLive(page);
    await page.locator("#profile-menu-btn").click();
    const menu = page.locator("#profile-menu-overlay");
    await menu.waitFor({ state: "visible", timeout: 10000 });
    await expect(menu.locator(".pm-item[data-action='open-appearance']")).toBeVisible();
    await expect(menu.locator(".pm-item[data-action='do-logout']")).toBeVisible();
    await settle(page, 400);
    await page.screenshot({ path: shotPath("participant", "22-account-menu") });
  });

  test("23-appearance", async ({ page }) => {
    await loginAliceIntoLive(page);
    await page.locator("#profile-menu-btn").click();
    await page.locator("#profile-menu-overlay [data-action='open-appearance']").click();
    const ap = page.locator("#appearance-overlay");
    await ap.waitFor({ state: "visible", timeout: 10000 });
    await expect(ap.locator(".lp-card"), "a live preview per look").toHaveCount(Object.keys(require("../scripts/theme/looks").looks).length);
    await expect(ap.locator("#ap-org-look"), "a participant has no organisation default").toHaveCount(0);
    await settle(page, 500);
    await page.screenshot({ path: shotPath("participant", "23-appearance") });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Admin role
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("admin", () => {
  test.beforeAll(async () => {
    await seedAnalyticsRows();
    // Promote carol → admin so every capture below reflects what a
    // regular admin sees (not what a superadmin sees). The admin guide
    // only describes admin-relevant functionality, so the screenshots
    // must match: no superadmin-only buttons (Import Participants,
    // Import Challenges, Promote, Delete, Lock, Recalculate), no CxOne
    // override section in the Edit Competition dialog, no default-CxOne
    // card in Settings, and redacted log entries under Logs.
    await ensureCarolIsAdmin();
  });
  test.afterAll(async () => { await restoreCarolToParticipant(); });

  // v8.7.5 — resolve a tab by its `data-tab-id`, not by its visible label, so a
  // copy change to the sidebar cannot silently break every capture in this file
  // (which `npm test` never runs — the v8.6.6 trap). Mirrors TAB_SLUG in
  // tests/ui-admin-helpers.js.

  async function gotoTab(page, tabName) {
    await loginAsAdminCarol(page);
    // RBAC sidebar — Submissions and Logs have no sidebar item (Audit covers both).
    if (/^(submissions|logs)$/i.test(tabName)) {
      await page.locator("#admin-page").waitFor({ state: "visible" });
      await page.evaluate((id) => window.adminTab(null, id), `admin-${tabName.toLowerCase()}-tab`);
      return;
    }
    await page.locator(_tabSel(tabName)).first().click();
  }

  // v8.3.21 — A PICTURE THAT CONTRADICTS ITS OWN CAPTION IS WORSE THAN NO
  // PICTURE. Two captures were clipped at 1280: the rankings board lost Score /
  // Time to Solve / All Solved, and the analytics breakdown lost Unique
  // Attempters and Solve rate — in both cases the exact columns the paragraph
  // above the image tells the reader to look at.
  //
  // Widening is honest rather than flattering (the 44-analytics-breakdown
  // precedent): the card scrolls horizontally BY DESIGN, so this is what a
  // desktop admin sees once the window is wide enough, and the prose's claim is
  // about which columns exist and in what order.
  //
  // It ASSERTS the result rather than assuming a width is enough — a hard-coded
  // viewport is exactly how these two went stale when a column was added. The
  // scroller must end up with nothing left to scroll, or the capture fails
  // loudly instead of shipping another clipped picture.

  test("01-competitions", async ({ page }) => {
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "01-competitions") });
  });

  test("02-challenges", async ({ page }) => {
    await gotoTab(page, "Challenges");
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "02-challenges") });
  });

  test("03-participants", async ({ page }) => {
    await gotoTab(page, "Participants");
    await page.locator("#admin-participants-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "03-participants") });
  });

  // v8.8.11 — the Participants tab with an event FOCUSED. No capture had ever
  // shot this state, and that absence is part of why the defect survived: the
  // focused pane used to fill from the picker, so it showed members plus the
  // OLDEST 500 accounts under its own pager and count and looked complete. The
  // guide's claim beside this picture — that focus floats members to the top and
  // hides nobody — is what the shot has to make visible, so it asserts the scope
  // banner AND that non-members are still listed before shooting.
  test("03b-participants-focused", async ({ page }) => {
    // The picture needs somebody who is NOT in the event, or the caption's claim
    // — that focus reorders rather than narrows — has nothing to illustrate. The
    // seeded three are all enrolled in "Test Live", so a run of this capture
    // alone would otherwise shoot a table where every row is a member and be
    // indistinguishable from the build this release removed.
    {
      const sa = await request.newContext({ baseURL: BASE });
      await sa.post("/api/login", { data: { email: "superadmin", password: await getSuperadminPass() } });
      const saH = { "content-type": "application/json", "x-csrf-token": (await (await sa.get("/api/csrf-token")).json()).csrfToken };
      const have = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants || [];
      for (let i = have.length; i < 6; i++) {
        await _mkParticipant(sa, saH, `focusshot${i}`, `focusshot${i}`).catch(() => {});
      }
      await sa.dispose();
    }
    await gotoTab(page, "Events");
    // NARROW FIRST, then click Focus IN THE NAMED ROW — the v8.6.6 rule; the
    // table default-sorts live-first by effective end DESCENDING, so `.first()`
    // is whatever another capture happened to create. `.first()` on the BUTTON
    // too: a row carries two Focus controls.
    await filterComps(page, "Test Live");
    await page.locator("#admin-comp-body tr", { hasText: "Test Live" }).first()
      .locator('button[data-action="comp-open"]').first().click();
    await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 5000 });

    // The WORKSPACE's Participants section (the sidebar's People item leaves the
    // workspace, which is how this capture came to shoot the cross-event list).
    // Inside an event the list holds only its members, with "Search everyone on
    // the platform" beside it, which is what the caption's paragraph describes.
    await page.locator('#ws-tabs [data-section="admin-participants-tab"]').first().click();
    await page.locator("#admin-participants-body tr").first().waitFor({ state: "attached", timeout: 10000 });
    await expect(page.locator("#p-ws-scope"), "the Search everyone switch is offered").toBeVisible({ timeout: 10000 });
    await expect(page.locator("#ws-record"), "the event's workspace is open").toBeVisible();
    // Scroll back to the top so the scope banner — the thing that says an event
    // IS focused — is in frame beside the reordered table.
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector(".admin-content")?.scrollTo(0, 0); });
    await settle(page, 600);
    await page.screenshot({ path: shotPath("admin", "03b-participants-focused") });
    // Clear the scope so subsequent admin captures start unscoped.
    await page.locator("#admin-scope-banner .scope-clear").click().catch(() => {});
  });

  test("04-submissions", async ({ page }) => {
    await gotoTab(page, "Submissions");
    await page.locator("#admin-submissions-tab").waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "04-submissions") });
  });

  test("05-rankings", async ({ page }) => {
    // v8.3.21 — FOCUS A COMPETITION FIRST. Unscoped, the tab renders a picker of
    // live competitions rather than a board, so the capture showed none of the
    // nine columns the guide's Rankings section describes — and told the reader
    // to click headings that were not in the frame.
    await gotoTab(page, "Events");
    // v8.6.6 — NARROW FIRST; "row 1" is not the seeded competition. The table
    // default-filters to live+upcoming and sorts live-first by effective end
    // DESCENDING, and an earlier participant capture creates a Program whose
    // deadline is +90 days — so it sorts first, and a Program renders no
    // rankings table at all. MEASURED: `05-rankings` alone passes; run
    // `17-certificate-cta` before it and it fails.
    await filterComps(page, "Test Live");
    // …and click Focus IN THAT ROW. `.first()` was the whole defect and
    // `filterComps` alone does NOT fix it: that helper waits for a row
    // CONTAINING the name to be visible, which is true whether or not the table
    // narrowed — so it passes vacuously and `.first()` still takes whatever sorts
    // to the top. MEASURED with a diagnostic: the scope banner read "Viewing:
    // Secure Coding Foundations" with the filter applied.
    // `.first()` on the BUTTON too: a row carries two Focus controls (the inline
    // one and the kebab's), so an unscoped match is a strict-mode violation.
    await page.locator("#admin-comp-body tr", { hasText: "Test Live" }).first()
      .locator('button[data-action="comp-open"]').first().click();
    await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 5000 });
    // The workspace's own Rankings section keeps the event; the sidebar's
    // Live rankings is the cross-event page and would close it.
    await page.locator('#ws-tabs [data-section="admin-rankings-tab"]').first().click();
    await page.locator("#admin-rankings-tab").waitFor({ state: "visible" });
    // Real rows, not just the table shell — an empty board would document the
    // feature as having no data.
    await page.locator("#admin-rankings-content .rankings-table-card tbody tr")
      .first().waitFor({ state: "visible", timeout: 15000 });
    await widenUntilUnclipped(page, "#admin-rankings-content .rankings-table-card");
    await settle(page, 400);
    await page.locator("#admin-rankings-content .rankings-table-card").first()
      .screenshot({ path: shotPath("admin", "05-rankings") });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Clear the scope so subsequent admin captures start unscoped.
    await page.locator("#admin-scope-banner .scope-clear").click().catch(() => {});
  });

  test("59-rankings-presenter-view", async ({ page }) => {
    // v8.11.0 — the SAME board with Company and Email left off, which is the
    // whole of what the guide's paragraph claims. It has to be its own capture
    // rather than a second frame of 05: the point a reader needs to see is the
    // TOGGLE ticked in the controls row and the two columns absent from the
    // header at the same time, so the shot spans both.
    //
    // Numbered 59 rather than slotted in beside 05 because the admin captures
    // are referenced by filename from the guide and renumbering would re-point
    // every one of them.
    await gotoTab(page, "Events");
    await filterComps(page, "Test Live");
    await page.locator("#admin-comp-body tr", { hasText: "Test Live" }).first()
      .locator('button[data-action="comp-open"]').first().click();
    await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 5000 });
    // The workspace's own Rankings section keeps the event; the sidebar's
    // Live rankings is the cross-event page and would close it.
    await page.locator('#ws-tabs [data-section="admin-rankings-tab"]').first().click();
    await page.locator("#admin-rankings-tab").waitFor({ state: "visible" });
    await page.locator("#admin-rankings-content .rankings-table-card tbody tr")
      .first().waitFor({ state: "visible", timeout: 15000 });

    // ASSERT THE STATE BEFORE SHOOTING (the v8.3.21 rule). Without this a
    // fixture whose toggle silently failed ships a picture of the ordinary board
    // under a caption about the presenter's view — the picture contradicting its
    // own caption, which is worse than no picture.
    await expect(page.locator("#admin-rankings-tab th[data-col='company']")).toHaveCount(1);
    await page.locator("#rankings-hide-identity").check();
    await expect(page.locator("#admin-rankings-tab th[data-col='company']")).toHaveCount(0);
    await expect(page.locator("#admin-rankings-tab th[data-col='email']")).toHaveCount(0);
    await expect(page.locator("#admin-rankings-tab th[data-col='first']"),
      "the names stay — that is what makes it standings").toHaveCount(1);

    await widenUntilUnclipped(page, "#admin-rankings-content .rankings-table-card");
    await settle(page, 400);
    await page.locator("#admin-rankings-tab").screenshot({ path: shotPath("admin", "59-rankings-presenter-view") });
    await page.locator("#rankings-hide-identity").uncheck();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#admin-scope-banner .scope-clear").click().catch(() => {});
  });

  // ── v8.12.0 — STAFF CAN COMPETE ─────────────────────────────────────────────
  // Two captures the admin guide's "Letting staff compete" section rests on. Both
  // build their own event (carol, the guide's regular admin, creates it), assert
  // the state they photograph, and clean up: the second enrols carol as a
  // COMPETITOR, which locks her out of that event's edits for the rest of the
  // file, so she removes herself through the one door the lock keeps open.
  async function _staffCompeteEvent(page, name, extra = {}) {
    await loginAsAdminCarol(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const r = await page.request.post("/api/admin/competitions", { headers: H, data: {
      name, start_time: new Date(Date.now() + 3 * 3600_000).toISOString(), duration_minutes: 180,
      event_kind: "tournament", staff_compete: true, ...extra } });
    if (!r.ok()) throw new Error(`staff-compete event seed failed: ${r.status()} ${await r.text()}`);
    const d = await r.json();
    return { id: d.competition?.id || d.id, H };
  }

  test("60-staff-can-compete", async ({ page }) => {
    // The edit form's "Staff can compete" section, on an UPCOMING event so the
    // box is live rather than locked — the guide's paragraph is about the
    // decision, and a disabled box with a lock note is the next capture's job.
    const { id } = await _staffCompeteEvent(page, "Blue Team Sprint");
    await page.locator(_tabSel("Events")).first().click();
    await page.locator("#admin-competitions-tab").waitFor({ state: "visible" });
    // editCompetition renders from S.adminCompetitionsData and silently does
    // nothing for an id the model has not loaded yet (the v8.3.39 readiness
    // class) — wait for the ROW, not the pane.
    await expect.poll(() => page.evaluate((cid) =>
      (window.S?.adminCompetitionsData || []).some((c) => c.id === cid), id),
      { timeout: 15000 }).toBe(true);
    await page.evaluate((cid) => window.editCompetition(cid), id);
    const box = page.locator("#comp-staff-compete");
    await box.waitFor({ state: "visible", timeout: 10000 });
    // ASSERT THE STATE BEFORE SHOOTING: the switch really is on, and it is not
    // locked — a picture of a greyed box under a caption about choosing would
    // contradict itself.
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await expect(page.locator("#comp-staff-compete-hint")).toContainText(/sealed/i);
    const group = box.locator("xpath=ancestor::div[contains(@class,'form-group')][1]");
    await group.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await group.screenshot({ path: shotPath("admin", "60-staff-can-compete") });
    await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click().catch(() => {});
  });

  test("61-competitor-locked-event", async ({ page }) => {
    // The Events row of an event the signed-in admin COMPETES in: the kebab
    // carries the reason and none of the mutating items. Carol enrols herself
    // (an admin may always add themselves), opens the menu, and afterwards
    // removes herself — the escape hatch the guide names — so nothing below
    // inherits the lock.
    const { id, H } = await _staffCompeteEvent(page, "Purple Team Invitational");
    const me = await (await page.request.get("/api/me")).json();
    const asg = await (await page.request.post("/api/admin/competitions/assign",
      { headers: H, data: { userIds: [me.id], competitionIds: [id] } })).json();
    if (asg.assigned !== 1) throw new Error(`self-enrol skipped: ${JSON.stringify(asg)}`);
    try {
      await page.goto("/");
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
      await page.locator(_tabSel("Events")).first().click();
      const menu = await openEventWsMenu(page, "Purple Team Invitational");
      // ASSERT THE STATE: the note is there and Edit is not. Both halves, or the
      // picture could be an ordinary menu under a caption about a lock.
      await expect(menu).toContainText(/competing in this event/i);
      await expect(menu.locator('button[data-action="comp-edit"]')).toHaveCount(0);
      await expect(menu.locator('button[data-action="comp-history"]')).toHaveCount(1);
      await settle(page, 300);
      await page.screenshot({ path: shotPath("admin", "61-competitor-locked-event") });
    } finally {
      await page.request.delete(`/api/admin/competitions/${id}/users/${me.id}`, { headers: H });
    }
  });

  test("06-analytics", async ({ page }) => {
    // v8.1.0 — through the SHARED entry point. The pane now opens UNSCOPED and
    // issues no aggregate until the admin says what to measure (PR 21), so a
    // plain tab click leaves the prompt on screen and the donut never renders.
    //
    // This file is excluded from `npm test` (`testIgnore: ["**/_*.spec.js"]`),
    // which is exactly why it was the one caller of the analytics tab that the
    // 24-call-site sweep did not reach — the documented trap, arriving on cue.
    await gotoTab(page, "Analytics");   // logs in AND opens the admin pane
    await openAnalyticsTab(page);       // ...then chooses a scope, which the pane now requires
    await page.locator("#analytics-donut canvas").first().waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 800); // donut animation
    await page.screenshot({ path: shotPath("admin", "06-analytics") });
  });

  test("44-analytics-breakdown", async ({ page }) => {
    // v7.27.0 — the PER-CHALLENGE TABLE, which sits below the fold on
    // 06-analytics (a viewport shot of the filter bar + donut). The columns are
    // what the guide describes at "unique attempters", and the whole point of
    // that paragraph is the ORDER — the denominator immediately before the rate
    // it divides by — so the header row has to be visible in a picture.
    await gotoTab(page, "Analytics");
    await openAnalyticsTab(page);
    // Wait for real rows, not just the table shell: an empty body would
    // document the feature as having no data.
    await page.locator("#analytics-table-body tr").first().waitFor({ state: "visible", timeout: 15000 });
    // An ELEMENT shot of the card, on a WIDER viewport — the 39-logs-pager
    // precedent. Two reasons a plain viewport shot cannot carry this:
    //   * the table sits below the fold behind the filter bar and the donut;
    //   * with twelve columns it is wider than the standard 1280 shot, and the
    //     card scrolls horizontally by design (the house rule for wide content),
    //     so the last two columns — the very pair this picture is about — are
    //     clipped. Widening is honest rather than flattering: this is what a
    //     desktop admin sees, and the guide's claim is about column ORDER.
    //
    // v8.3.21 — 1700 was not enough: the header ended mid-word at "UNIQUE AT…"
    // and Solve rate was out of frame entirely, so the picture omitted the exact
    // pair the paragraph is about. Widen until the card's own scroller has
    // nothing left to scroll, and fail loudly rather than clip.
    await widenUntilUnclipped(page, '#analytics-table-card [role="region"]');
    await settle(page, 400);
    await page.locator("#analytics-table-card").screenshot({ path: shotPath("admin", "44-analytics-breakdown") });
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test("48-grant-attempts", async ({ page }) => {
    // v8.3.22 — the remedy the participant's own exhausted panel sends them to an
    // organiser for. It had no capture because nothing in the seed carries an
    // attempt cap, and the kebab item is offered only where the server can honour
    // it (`_taskMayHaveCap`: assigned to a non-ended event, with a cap resolved
    // by the same most-specific-wins chain the endpoint uses).
    //
    // Shares the participant captures' fixture, so the challenge in the picture
    // is the same one somebody has actually run out of attempts on.
    const fx = await ensureCappedFixture();
    await gotoTab(page, "Challenges");
    // The table paginates and its search is debounced, so narrow to the row
    // rather than hunting for it (the v7.17.2 paginated-row-lookup rule).
    await narrowChallengesTable(page, "Broken access control");
    const row = page.locator("#admin-task-body tr", { hasText: "Broken access control" }).first();
    await row.waitFor({ state: "visible", timeout: 15000 });
    await row.locator(".kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#kebab-portal button:has-text('Grant Attempts')").first().click();
    await page.locator("#attempt-grant-overlay").waitFor({ state: "visible", timeout: 10000 });
    // The dialog lists the people who have spent their attempts; without a row
    // the picture would show an empty chooser under a caption about granting.
    await expect(page.locator("#attempt-grant-overlay")).toContainText("robin_s");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "48-grant-attempts") });
    await page.locator('[data-action="overlay-close"]').first().click().catch(() => {});
  });

  test("47-analytics-prompt", async ({ page }) => {
    // v8.3.21 — THE STATE EVERY OTHER ANALYTICS CAPTURE SKIPS PAST. Since
    // v8.1.0 the tab opens UNSCOPED and issues no aggregate until the admin says
    // what to measure, and `openAnalyticsTab()` — which every other analytics
    // shot goes through — presses "Show platform-wide" on the way in. So the one
    // screen an admin actually meets first had never been captured, while the
    // guide implied the tab opens on a chart.
    //
    // Driven by a RAW tab click for exactly that reason: routing it through the
    // shared helper would dismiss the thing being photographed.
    await gotoTab(page, "Analytics");
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible" });
    await page.locator(".analytics-prompt").waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "47-analytics-prompt") });
  });

  test("07-analytics-comp-picker", async ({ page }) => {
    await gotoTab(page, "Analytics");
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible" });
    await page.locator("#analytics-filterbar .seg:has-text('Event')").click();
    await page.locator(".picker-btn").first().waitFor({ state: "visible" });
    await page.locator(".picker-btn").first().click();
    await page.locator(".picker-modal").waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "07-analytics-comp-picker") });
  });

  test("08-analytics-challenge-picker", async ({ page }) => {
    await gotoTab(page, "Analytics");
    await page.locator("#admin-analytics-tab").waitFor({ state: "visible" });
    // The CHALLENGE picker by its own action: in Event scope the first
    // picker-btn is the event picker, which this capture then shot twice.
    await page.locator('[data-action="analytics-open-task-picker"]').first().click();
    await page.locator(".picker-modal").waitFor({ state: "visible" });
    await expect(page.locator(".picker-modal"), "the challenge picker, not the event picker").not.toContainText("Pick an event");
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "08-analytics-challenge-picker") });
  });

  test("09-history-dialog", async ({ page }) => {
    await gotoTab(page, "Participants");
    await page.locator("#admin-participants-body .kebab-btn").first().waitFor({ state: "visible" });
    await page.locator("#admin-participants-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    // History opens in a centred overlay; wait for any overlay holding a heading-like row.
    await settle(page, 800);
    await page.screenshot({ path: shotPath("admin", "09-history-dialog") });
  });

  test("10-edit-profile-modal", async ({ page }) => {
    await gotoTab(page, "Participants");
    await page.locator("#admin-participants-body .kebab-btn").first().waitFor({ state: "visible" });
    await page.locator("#admin-participants-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit Profile')").first().click();
    await page.locator("#admin-profile-overlay").waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "10-edit-profile-modal") });
  });

  test("11-logs", async ({ page }) => {
    await gotoTab(page, "Logs");
    await page.locator("#admin-logs-tab").waitFor({ state: "visible" });
    await settle(page, 800);
    await page.screenshot({ path: shotPath("admin", "11-logs") });
  });

  test("72-audit-trail", async ({ page }) => {
    await gotoTab(page, "Audit");
    await page.locator("#admin-audit-tab").waitFor({ state: "visible" });
    await page.locator("#admin-audit-body tr td").first().waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 800);
    await page.screenshot({ path: shotPath("admin", "72-audit-trail") });
  });

  test("39-logs-pager", async ({ page }) => {
    // v7.25.0 — the pager is BELOW the fold in 11-logs, and the guide now makes
    // several claims about it (exact page count, Last, ±10, Go to page). An
    // element shot carries them; a viewport shot of the tab does not.
    //
    // A search is applied first because that is the state the claims are about:
    // filtered, the total is exact, and the jump controls are live.
    await gotoTab(page, "Logs");
    await page.locator("#admin-logs-tab").waitFor({ state: "visible" });
    // The REQUEST log with a broad term, so the shot shows a multi-page result
    // with an exact count — which is what makes Last and the jump box live, and
    // therefore what the guide is describing.
    await page.locator("button[data-action='logs-set-stream'][data-stream='access']").click();
    await page.locator("#logs-search").fill("api");
    await expect(page.locator("#logs-pagination .page-info")).toBeVisible();
    await expect(page.locator("#logs-page-input")).toBeEnabled();
    await page.locator("#logs-pagination").scrollIntoViewIfNeeded();
    await settle(page, 600);
    await page.locator("#logs-pagination").screenshot({ path: shotPath("admin", "39-logs-pager") });
  });

  test("13-edit-competition-modal", async ({ page }) => {
    // Edit Competition dialog from the admin perspective. v7.13.2 — a regular
    // admin now ALSO sees the CxOne Integration section (per-competition CxOne
    // is admin-level; only the GLOBAL default credentials in Settings stay
    // superadmin-only). Referenced from the admin guide's Competitions section.
    await gotoTab(page, "Events");
    await (await openEventWsMenu(page, "Test Live")).locator('[data-action="comp-edit"]').click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible" });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "13-edit-competition-modal") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("18-challenges-scoped", async ({ page }) => {
    // v6.10.12: Challenges tab with a competition focused. The
    // assigned challenges float to the top and their comp badges
    // are outlined with the accent colour, mirroring the members-
    // first behaviour on the Participants tab.
    await gotoTab(page, "Events");
    // v8.6.6 — NARROW FIRST; "row 1" is not the seeded competition. The table
    // default-filters to live+upcoming and sorts live-first by effective end
    // DESCENDING, and an earlier participant capture creates a Program whose
    // deadline is +90 days — so it sorts first, and a Program renders no
    // rankings table at all. MEASURED: `05-rankings` alone passes; run
    // `17-certificate-cta` before it and it fails.
    await filterComps(page, "Test Live");
    // …and click Focus IN THAT ROW. `.first()` was the whole defect and
    // `filterComps` alone does NOT fix it: that helper waits for a row
    // CONTAINING the name to be visible, which is true whether or not the table
    // narrowed — so it passes vacuously and `.first()` still takes whatever sorts
    // to the top. MEASURED with a diagnostic: the scope banner read "Viewing:
    // Secure Coding Foundations" with the filter applied.
    // `.first()` on the BUTTON too: a row carries two Focus controls (the inline
    // one and the kebab's), so an unscoped match is a strict-mode violation.
    await page.locator("#admin-comp-body tr", { hasText: "Test Live" }).first()
      .locator('button[data-action="comp-open"]').first().click();
    await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 5000 });
    // The WORKSPACE's Challenges section; the sidebar item leaves the workspace.
    await page.locator('#ws-tabs [data-section="admin-tasks-tab"]').first().click();
    await page.locator("#admin-tasks-tab").waitFor({ state: "visible" });
    await expect(page.locator("#ws-record"), "the event's workspace is open").toBeVisible();
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    // From the top, so the section tabs show under the event strip (the strip
    // is sticky and the tab click can leave the page scrolled).
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "18-challenges-scoped") });
    // Clear the scope so subsequent admin captures start unscoped.
    await page.locator("#admin-scope-banner .scope-clear").click().catch(() => {});
  });

  test("17-challenge-form", async ({ page }) => {
    // Admin's create-challenge form — inline card below the Challenges
    // table, revealed by clicking "+ New Challenge". Referenced from
    // admin.md Challenges section.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#admin-task-form").waitFor({ state: "visible", timeout: 5000 });
    // v8.9.0 — the guide's Text bullet and the "Several accepted answers"
    // paragraph both name the "+ Add another accepted answer" control, and this
    // is the only capture that shows it in its resting state — so it is asserted
    // rather than hoped for (v8.3.21: a capture asserts its own result). The
    // control is visible only because the form opens on the text type.
    await expect(page.locator("#tf-atype")).toHaveValue("text");
    await expect(page.locator("#tf-add-answer"), "the text form offers + Add another accepted answer").toBeVisible();
    await expect(page.locator("#tf-any-note-group")).toBeHidden();
    // Scroll the form into view so the screenshot frames the whole card.
    await page.locator("#admin-task-form").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "17-challenge-form") });
  });

  test("52-public-domain-tag", async ({ page }) => {
    // Stage B — the question editor's Topic and sharing row, open: the topic
    // picker with + New topic, the Shared with all organisers switch (the
    // public-domain marker; the file keeps its name) and the needs choices.
    // Referenced from admin.md, Topics > Shared with all organisers.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator('[aria-controls="tf-org-body"]').click();
    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21): the row is open and offers
    // what the caption names.
    await expect(page.locator("#tf-topic"), "the topic picker").toBeVisible();
    await expect(page.locator("#tf-shared"), "the shared switch").toBeVisible();
    await expect(page.locator("#tf-needs-list input[data-need]").first(), "the needs choices").toBeVisible();
    // Centred, so the editor's pinned Save row does not cover the needs choices.
    await page.locator("#tf-org-sec").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await settle(page, 400);
    await page.locator("#tf-org-sec").screenshot({ path: shotPath("admin", "52-public-domain-tag") });
    await page.locator("[data-action='close-task-form']").first().click().catch(() => {});
  });

  test("40-challenge-table-menu", async ({ page }) => {
    // v7.18.0 — the rich-text Table menu, open over a table the test just
    // inserted so the shot shows the editing items (which only render when the
    // caret is inside a table). Referenced from admin.md Challenges section.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-desc .rich-body").waitFor({ state: "visible", timeout: 5000 });
    const editor = page.locator("#tf-desc");
    const body = editor.locator(".rich-body");
    await body.click();
    await editor.locator("button[aria-label='Table']").click();
    await editor.locator(".drop-pop [role='menuitem']").first().click();
    await page.locator("#table-insert-overlay #tbl-ok").click();
    // Put some content in so the shot reads as a real table, then re-open the
    // menu from inside it.
    await body.locator("th").first().click();
    await page.keyboard.type("Region");
    await body.locator("th").nth(1).click();
    await page.keyboard.type("Findings");
    await body.locator("tbody td").first().click();
    await page.keyboard.type("EMEA");
    await body.locator("tbody td").nth(1).click();
    await page.keyboard.type("12");
    await body.locator("tbody td").first().click();
    await editor.locator("button[aria-label='Table']").click();
    await page.locator("#admin-task-form").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "40-challenge-table-menu") });
  });

  test("41-challenge-multiple-choice", async ({ page }) => {
    // v7.19.0 — the multiple-choice editor with real options and two ticked, so
    // the shot shows both the rows and the "one correct = radios" note.
    // Referenced from admin.md Challenges section.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#tf-title").fill("Which of these prevent SQL injection?");
    await page.locator("#tf-atype").selectOption("choice");
    await page.locator("#tf-add-choice").click();
    await page.locator("#tf-add-choice").click();
    const texts = page.locator("#tf-choices-list .choice-text");
    await texts.nth(0).fill("Parameterised queries");
    await texts.nth(1).fill("Escaping quotes by hand");
    await texts.nth(2).fill("Prepared statements");
    await texts.nth(3).fill("Turning off the WAF");
    await page.locator("#tf-choices-list input[data-change-action='task-choice-correct']").nth(2).check();
    await page.locator("#admin-task-form").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "41-challenge-multiple-choice") });
  });

  test("42-challenge-mc-preview", async ({ page }) => {
    // v7.19.0 — "View as Participant" on a multiple-choice challenge: the
    // options as a participant sees them, with the correct ones marked for the
    // author. Referenced from admin.md Challenges section.
    // gotoTab() is what establishes the admin session, so seed AFTER it — a
    // request before that 401s.
    const title = `Which of these prevent SQL injection?`;
    await gotoTab(page, "Challenges");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const r = await page.request.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { title, difficulty: "easy", answer_type: "choice", status: "published",
        description: "<p>Pick every technique that actually prevents SQL injection.</p>",
        choices: [
          { text: "Parameterised queries", correct: true },
          { text: "Escaping quotes by hand" },
          { text: "Prepared statements", correct: true },
          { text: "Turning off the WAF" },
        ] },
    });
    if (!r.ok()) throw new Error(`seed failed: ${r.status()} ${await r.text()}`);
    const id = (await r.json()).id;
    // Re-enter the tab so the freshly-seeded challenge is in the list.
    await gotoTab(page, "Challenges");
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "42-challenge-mc-preview") });
    if (id) await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("53-challenge-text-alternatives", async ({ page }) => {
    // v8.9.1 — a Text challenge with several accepted answers: the Correct
    // Answer box is answer #1 and two further rows sit beneath it, each with
    // its Remove button. Referenced from admin.md "Several accepted answers"
    // — the sibling multiple-choice paragraph has 41, this one had no picture.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#tf-title").fill("Which OWASP Top 10 category covers SQL injection?");
    await expect(page.locator("#tf-atype")).toHaveValue("text");
    await page.locator("#tf-answer").fill("Injection");
    await page.locator("#tf-add-answer").click();
    await page.locator("#tf-add-answer").click();
    const rows = page.locator("#tf-answers-extra input");
    await expect(rows).toHaveCount(2);
    await rows.nth(0).fill("A03");
    await rows.nth(1).fill("A03:2021 Injection");
    // The state the caption describes, asserted before shooting.
    await expect(rows.nth(0)).toHaveAttribute("aria-label", "Accepted answer 2");
    await expect(rows.nth(1)).toHaveAttribute("aria-label", "Accepted answer 3");
    await expect(page.locator("#tf-answer-group")).toBeVisible();
    await expect(page.locator("#tf-add-answer")).toBeVisible();
    await expect(page.locator("#tf-any-note-group")).toBeHidden();
    await page.locator("#admin-task-form").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "53-challenge-text-alternatives") });
  });

  test("54-challenge-any-answer", async ({ page }) => {
    // v8.9.1 — the editor with "Any answer (free response)" chosen: no Correct
    // Answer box, no Hint field, and the note that explains the rule where the
    // box would have been. Referenced from admin.md "Any answer (free response)".
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#tf-title").fill("What was the most useful thing you learned today?");
    await page.locator("#tf-atype").selectOption("any");
    await expect(page.locator("#tf-answer-group")).toBeHidden();
    await expect(page.locator("#tf-hint-group")).toBeHidden();
    await expect(page.locator("#tf-choices-group")).toBeHidden();
    await expect(page.locator("#tf-add-answer")).toBeHidden();
    await expect(page.locator("#tf-any-note-group")).toBeVisible();
    await expect(page.locator("#tf-any-note")).toContainText(/any non-empty answer is accepted/i);
    await page.locator("#admin-task-form").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "54-challenge-any-answer") });
  });

  test("55-challenge-any-preview", async ({ page }) => {
    // v8.9.1 — "View as Participant" on an Any answer challenge: the header
    // says any answer is accepted, and a note stands where the hint and the
    // correct answer would be. Referenced from admin.md "Previewing a challenge
    // as a participant". Seed AFTER gotoTab, which establishes the session.
    const title = "What would you change first in this codebase?";
    await gotoTab(page, "Challenges");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const r = await page.request.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { title, difficulty: "easy", answer_type: "any", status: "published",
        description: "<p>Tell us in a sentence or two.</p>",
        explanation: "<p>There is no right answer — we read every response after the event.</p>" },
    });
    if (!r.ok()) throw new Error(`seed failed: ${r.status()} ${await r.text()}`);
    const id = (await r.json()).id;
    await gotoTab(page, "Challenges");
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(overlay.locator(".task-preview-kicker")).toContainText(/any answer is accepted/i);
    await expect(overlay).toContainText("Any non-empty answer is accepted exactly as typed");
    await expect(overlay.locator(".task-preview-hint")).toHaveCount(0);
    await expect(overlay.locator(".task-preview-answer")).toHaveCount(0);
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "55-challenge-any-preview") });
    if (id) await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("56-challenge-answer-seal", async ({ page }) => {
    // v8.10.0 — the create form's "Seal the answer" checkbox, ticked, with the
    // note that spells out what it costs. Referenced from admin.md → Sealing a
    // challenge answer. CREATE ONLY: the control does not exist on an edit,
    // which is the one-way door, so this capture must come from a fresh form.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#tf-title").fill("Recover the flag from the packet capture");
    await page.locator("#tf-answer").fill("CTF{quiet_on_the_wire}");
    await page.locator("#tf-answer-seal").check();
    // The state the caption describes, asserted before shooting.
    await expect(page.locator("#tf-seal-group")).toBeVisible();
    await expect(page.locator("#tf-answer-seal")).toBeChecked();
    // v8.17.0 — the note sits behind the "?" beside the switch; open it for the shot.
    await page.locator("#tf-seal-tip").click();
    await expect(page.locator("#tf-seal-note")).toBeVisible();
    // v8.12.2 — the note no longer says "not superadmins": a superadmin CAN see it,
    // by a recorded reveal, and the note says so. Pin the new sentence rather
    // than the absence of the old one.
    await expect(page.locator("#tf-seal-note")).toContainText(/a superadmin who reveals it/i);
    await expect(page.locator("#tf-seal-note")).toContainText(/you cannot seal it again/i);
    await page.locator("#tf-seal-group").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "56-challenge-answer-seal") });
  });

  test("57-challenge-sealed-unseal", async ({ page }) => {
    // v8.10.0 — the AUTHOR reopening their own sealed challenge: the seal
    // checkbox is gone (it is create-only), a note says the answer is sealed,
    // and the only control left is "Remove the seal". Referenced from admin.md →
    // Sealing a challenge answer. Carol is the describe's admin, so seeding
    // through her own session is what makes her the author — the whole point.
    await gotoTab(page, "Challenges");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const title = "Recover the flag from the packet capture";
    const r = await page.request.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { title, difficulty: "medium", answer_type: "text", status: "published",
        description: "<p>The capture is attached. Find the flag the operator leaked.</p>",
        correct_answer: "CTF{quiet_on_the_wire}", answer_sealed: true },
    });
    if (!r.ok()) throw new Error(`seed failed: ${r.status()} ${await r.text()}`);
    const id = (await r.json()).id;
    await gotoTab(page, "Challenges");
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.evaluate(i => window.editTask(i), id);
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 10000 });
    // The state the caption describes, asserted before shooting. The seal
    // checkbox must be ABSENT, or the picture contradicts the one-way door the
    // paragraph above it describes.
    await expect(page.locator("#tf-seal-group")).toBeHidden();
    await expect(page.locator("#tf-sealed-note")).toBeVisible();
    await expect(page.locator("#tf-unseal-row")).toBeVisible();
    await expect(page.locator("#tf-answer")).toHaveValue("CTF{quiet_on_the_wire}");
    // A PICTURE THAT CONTRADICTS ITS OWN CAPTION IS WORSE THAN NO PICTURE
    // (v8.3.21). The caption promises the unseal control, so scroll to IT and
    // then assert it is really on screen — the first draft scrolled to the note
    // above it and left "Remove the seal" a few pixels below the fold.
    await page.locator("#tf-unseal-row").scrollIntoViewIfNeeded();
    await settle(page, 500);
    const box = await page.locator("#tf-unseal-row").boundingBox();
    const vh = page.viewportSize().height;
    if (!box || box.y < 0 || box.y + box.height > vh) {
      throw new Error(`the unseal control is not fully on screen: ${JSON.stringify(box)} in a ${vh}px viewport`);
    }
    await page.screenshot({ path: shotPath("admin", "57-challenge-sealed-unseal") });
    if (id) await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("58-challenge-seal-free-response", async ({ page }) => {
    // v8.10.1 — the seal checkbox DISABLED because the answer type is "Any
    // answer (free response)", with the note that explains it. Referenced from
    // admin.md → Sealing a challenge answer. The state is reachable only by
    // choosing that type, so the capture drives the real control.
    await gotoTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#tf-title").fill("What would you change first in this codebase?");
    // PRECONDITION: it is offered before the switch, or the picture below shows
    // a control that is always disabled rather than one this choice disabled.
    await expect(page.locator("#tf-answer-seal")).toBeEnabled();
    await page.locator("#tf-atype").selectOption("any");
    // The state the caption describes, asserted before shooting.
    await expect(page.locator("#tf-answer-seal")).toBeDisabled();
    await expect(page.locator("#tf-seal-type-note")).toBeVisible();
    await expect(page.locator("#tf-seal-type-note")).toContainText(/no answer to seal/i);
    await page.locator("#tf-seal-type-note").scrollIntoViewIfNeeded();
    await settle(page, 500);
    const box = await page.locator("#tf-answer-seal").boundingBox();
    const vh = page.viewportSize().height;
    if (!box || box.y < 0 || box.y + box.height > vh) {
      throw new Error(`the seal checkbox is not on screen: ${JSON.stringify(box)} in a ${vh}px viewport`);
    }
    await page.screenshot({ path: shotPath("admin", "58-challenge-seal-free-response") });
  });

  test("43-competition-activity-export", async ({ page }) => {
    // v7.23.0 — the Competitions row kebab on a LIVE competition, showing
    // "Export Activity (CSV)". Referenced from admin.md → Export challenge
    // activity. It must be a LIVE (or ended) row: the item is deliberately
    // absent on an upcoming one, so capturing the wrong row would document the
    // feature as missing.
    await gotoTab(page, "Events");
    await openEventWsMenu(page, "Test Live");
    await page.locator("#kebab-portal [data-action='comp-export-activity']")
      .waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "43-competition-activity-export") });
    await page.keyboard.press("Escape").catch(() => {});
    await narrowEventsTable(page, "").catch(() => {});
  });

  test("16-invite-dialog", async ({ page }) => {
    // Bulk-invite dialog — referenced from admin.md Participants
    // section. Admin clicks the "Invite" button on the toolbar; the
    // modal lets them paste a list of emails, pick a set of
    // competitions to auto-assign, and pick groups to add invitees to
    // (the "Add to Groups" picker) on accept.
    await gotoTab(page, "Participants");
    // Seed a couple of representative groups so the dialog's "Add to
    // Groups" picker renders chips (not the "No groups yet." empty
    // state) — this capture runs before "28-groups" in file order, so
    // we can't rely on its seeding. Idempotent across the light+dark
    // passes that share one data dir; members are participant-only so
    // the privileged-target group guard never trips.
    {
      const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const H = { "x-csrf-token": csrf, "content-type": "application/json" };
      const parts = (await (await page.request.get("/api/admin/participants?limit=50")).json()).participants || [];
      const memberIds = parts.filter(p => (p.role || "participant") === "participant").map(p => p.id);
      await page.request.post("/api/admin/groups", { headers: H, data: { name: "Acme Cohort", userIds: memberIds.slice(0, 2) } }).catch(() => {});
      await page.request.post("/api/admin/groups", { headers: H, data: { name: "QA Reviewers", userIds: memberIds.slice(0, 1) } }).catch(() => {});
    }
    await page.locator("[data-action='open-invite-dialog']").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("[data-action='open-invite-dialog']").first().click();
    await page.locator("#invite-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "16-invite-dialog") });
    await page.locator("#invite-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("15-search-active", async ({ page }) => {
    // Search field with a live query. Every table tab (Competitions,
    // Challenges, Participants, Submissions, Logs) has one at the top
    // and narrows rows on every keystroke. Captured on Participants
    // with "alice" typed so the reader sees the narrowed result set
    // and the search input state.
    await gotoTab(page, "Participants");
    await page.locator("#admin-participants-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await page.locator("#participants-search").waitFor({ state: "visible", timeout: 5000 });
    await narrowPeopleTable(page, "alice");
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "15-search-active") });
    await narrowPeopleTable(page, "");
  });

  // v6.10.17: fill in the dialog-level documentation gap for the
  // admin guide. Screenshots 19–26 cover the overlays that were
  // referenced in admin.md prose but never captured.

  // The New event page: one card per type (recommended setup, Start blank) and the templates. The admin
  // guide introduces the three kinds from this screen.
  test("44-competition-create-kind", async ({ page }) => {
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await page.locator("[data-action='open-competition-form']").first().click();
    await page.locator("#admin-templates-tab").waitFor({ state: "visible", timeout: 10000 });
    await page.locator('#tpl-kind-cards button[data-action="tpl-pick"]:enabled').first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#tpl-list .tpl-row, #tpl-list-empty").first().waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "44-competition-create-kind") });
  });

  // v8.2.0 — the SCOPING, shown rather than described: a Program's step 2 has a
  // deadline where a Competition has a duration, and carries none of the
  // ranking-shaped settings. The admin guide puts this beside the Competition
  // capture so the difference is visible at a glance.
  test("46-competition-change-kind", async ({ page }) => {
    // v8.3.0 — the kind chooser reached from an EDIT, which is how an admin
    // corrects a type they picked wrongly. Referenced from the admin guide's
    // "Changing the event type" section.
    //
    // It creates its own UPCOMING, session-free event rather than editing a
    // seeded one: the control is offered only in that state, and every seeded
    // competition is either live, ended or multi-session.
    await gotoTab(page, "Events");
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const cr = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: {
        name: "Autumn Onboarding Sprint", event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() + 7 * 864e5).toISOString(), duration_minutes: 180,
      },
    });
    const comp = (await cr.json()).competition;
    await page.evaluate(() => window.loadAdminCompetitions());
    await page.waitForTimeout(500);
    await page.evaluate((id) => window.openCompetitionForm(id), comp.id);
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });
    // The type is a field on the form; picking another asks to confirm.
    await pickFormKind(page, "program");
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "46-competition-change-kind") });
    await page.locator("#modal-overlay [data-action='modal-cancel'], #modal-cancel-btn").first().click().catch(() => {});
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
    await page.request.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrfToken } }).catch(() => {});
  });

  // v8.4.0 — the sign-up-form matrix, which is a Booth Event's alone and is what
  // the admin guide's "What a Booth Event asks for at sign-up" section is about.
  // Every capture ASSERTS ITS OWN STATE before shooting (the v8.3.21 rule): a
  // picture of an empty form under a caption about six configurable fields would
  // be worse than no picture, and this section's whole subject is the two
  // controls per row.
  test("50-booth-signup-form", async ({ page }) => {
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await openCompCreateForm(page, "booth");
    await page.locator("#comp-name").fill("Security Booth — Autumn Expo");
    const matrix = page.locator(".reg-editor");
    await matrix.waitFor({ state: "visible", timeout: 10000 });
    // One field switched to Required, so the preview shows what it adds.
    await page.locator('#comp-form-overlay input[name="reg-state-phone"][value="required"]').check();
    await expect(page.locator("#reg-preview")).toContainText("Phone");
    // (The LinkedIn sign-up switch that once sat in this frame was removed with
    // LinkedIn sign-in; nothing replaces it here.)
    await matrix.scrollIntoViewIfNeeded();
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "50-booth-signup-form") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("45-competition-create-program", async ({ page }) => {
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await openCompCreateForm(page, "program");
    await page.locator("#comp-name").fill("Secure Coding Certification");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "45-competition-create-program") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("50-late-entry-deadline", async ({ page }) => {
    // v8.6.3 — the Late entries block on a Booth Event's form. It is the one
    // section of that form the guide describes control by control and had no
    // picture of, and this release changes what it SAYS: the label and the note
    // now name the dialog's timezone, and the note states the selected deadline
    // in bold.
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await openCompCreateForm(page, "booth");
    await page.locator("#comp-name").fill("Security Stand — Hall 2");

    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21). A capture of an unfilled or
    // un-timezoned block would illustrate the caption with the wrong thing, and
    // the whole subject here is what the label and the note say.
    const box = page.locator("#comp-late-entry-box");
    await expect(box, "the late-entry block is shown for a Booth Event").toBeVisible();
    await expect(page.locator("#comp-late-deadline-label"), "the label names the timezone").toContainText("(");
    await expect(page.locator("#comp-late-note strong"), "and the note states the deadline in bold").toHaveCount(1);
    await expect(page.locator("#comp-late-deadline-date"), "the Automatic fill has run").not.toHaveValue("");

    await box.scrollIntoViewIfNeeded();
    await settle(page, 400);
    // CLIPPED to the section the caption is about — heading through the note —
    // rather than a full-page shot whose middle happens to contain it. Derived
    // from the real boxes, so it cannot go stale against a layout change, and it
    // THROWS rather than shooting something arbitrary if either end is missing.
    const head = page.locator("#comp-form-overlay h3", { hasText: "Late entries" }).first();
    const a = await head.boundingBox();
    const b = await box.boundingBox();
    if (!a || !b) throw new Error("late-entry section not laid out — refusing to capture an arbitrary region");
    await page.screenshot({
      path: shotPath("admin", "50-late-entry-deadline"),
      clip: { x: Math.max(0, a.x - 12), y: Math.max(0, a.y - 12),
              width: Math.max(a.width, b.width) + 24, height: (b.y + b.height) - a.y + 24 },
    });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  // v8.12.6 — the late-entry stand captures 51 and 32 both photograph, built
  // CREATE-IF-MISSING so either capture can run alone (`-g`) and a second theme
  // pass finds it rather than 409-ing on the duplicate name. Built LIVE and then
  // moved into the past: an ended event refuses the challenge assignment (and,
  // outside a late-entry window, the participant assign), and End Now cannot
  // reach far enough back to be interesting. Returns the event's id.
  async function ensureLateEntryStand(page, name = "Security Stand — Hall 2") {
    const list = await (await page.request.get("/api/admin/competitions")).json();
    const have = (Array.isArray(list) ? list : []).find(c => c.name === name);
    if (have) return have.id;
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const created = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        name, event_kind: "booth", timezone: "UTC",
        start_time: new Date(Date.now() - 5 * 60_000).toISOString(),
        duration_minutes: 180, late_entry_enabled: true,
      },
    });
    expect(created.ok(), `create booth: ${await created.text()}`).toBeTruthy();
    const compId = (await created.json()).competition.id;
    _expireStand(compId);
    await page.waitForTimeout(1300);   // past the per-competition row cache TTL
    return compId;
  }

  /** Finish a stand half an hour ago, leaving its late-entry window open. */
  function _expireStand(compId) {
    // The require is LAZY (v7.20.2): a module-scope binding would be taken
    // before the per-file recycle recreates the database file.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      const end = Date.now() - 30 * 60_000;   // finished half an hour ago
      expect(db.prepare("UPDATE competitions SET start_time=?, duration_minutes=? WHERE id=?")
        .run(new Date(end - 60 * 60_000).toISOString(), 60, compId).changes,
        "the direct write must land").toBe(1);
      return end;
    } finally { db.close(); }
  }

  test("51-late-entry-badge", async ({ page }) => {
    // v8.8.0 — an event inside its LATE-ENTRY window, in the events table. The
    // guide says such an event "reads Late entry open rather than Ended" and has
    // its own filter chip on by default; without a picture that sentence is the
    // only evidence, and the state cannot occur in the seed.
    await gotoTab(page, "Events");
    const name = "Security Stand — Hall 2";
    await ensureLateEntryStand(page, name);
    await page.reload();
    await gotoTab(page, "Events");
    await filterComps(page, name);

    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21). A capture taken while the row
    // still read "Ended", or with the chip inactive, would illustrate the caption
    // with the exact thing this release changed.
    const row = page.locator("#admin-comp-body tr", { hasText: name }).first();
    await expect(row, "the late-entry event is in the table").toBeVisible();
    await expect(row.locator(".status-badge.late-entry"),
      "…badged apart from a finished event").toContainText(/late entry open/i);
    await expect(page.locator('#comp-status-filters [data-status="late-entry"]'),
      "…and its chip is active, which is why the row is here at all").toHaveClass(/active/);

    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "51-late-entry-badge") });
  });

  test("64-late-entry-assign", async ({ page }) => {
    // v8.12.6 — adding and removing people DURING the late-entry window. The
    // Participants tab focused on a Booth Event that has ended but is still
    // taking late entries: the scope banner says so, the late entrant's row is
    // badged "late entrant", and its menu offers "Remove from …" — which the
    // ordinary member beside them is not offered. The state cannot occur in the
    // seed, so the guide's paragraph would otherwise be its own only evidence.
    const name = "Security Stand — Hall 3";
    const ORD = { label: "hall3-kim", first: "Kim", last: "Lindqvist" };
    const LATE = { label: "hall3-ana", first: "Ana", last: "Moreno" };
    {
      // Built through a SUPERADMIN context (verify is superadmin-only); carol,
      // the regular admin every capture here is taken as, stays the browser's
      // user. Create-if-missing throughout, so a second theme pass finds it.
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      const saH = { "content-type": "application/json", "x-csrf-token": saCsrf };
      const comps = await (await sa.get("/api/admin/competitions")).json();
      expect(Array.isArray(comps), `the superadmin context can read the events list: ${JSON.stringify(comps).slice(0, 200)}`).toBe(true);
      if (!comps.some(c => c.name === name)) {
        const created = await sa.post("/api/admin/competitions", {
          headers: saH,
          data: { name, event_kind: "booth", timezone: "UTC",
                  start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 180, late_entry_enabled: true },
        });
        expect(created.ok(), `create booth: ${await created.text()}`).toBeTruthy();
        const compId = (await created.json()).competition.id;
        const mk = async (p) => {
          const email = `${p.label}@company.example`;
          const reg = await registerPost(sa, "/api/register", {
            headers: saH,
            data: { firstName: p.first, lastName: p.last, nickname: p.label, email, company: "Acme", title: "Engineer",
                    country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
                    jobFunction: "Software Developer / Engineer", city: "Testville" },
          });
          expect(reg.ok(), `register ${email}: ${await reg.text()}`).toBeTruthy();
          const row = ((await (await sa.get("/api/admin/participants?limit=5000")).json()).participants || []).find(x => x.email === email);
          expect(row, `${email} is in the admin list`).toBeTruthy();
          await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: saH });
          await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: saH });
          return row.id;
        };
        const assign = async (uid) => {
          const r = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [uid], competitionIds: [compId] } });
          expect((await r.json()).assigned, "the assign landed").toBe(1);
        };
        // The ordinary member joins WHILE LIVE; moving the end into the past
        // re-times that join to after the end (the late-entry fixture trap), so
        // it is back-dated to before it.
        const ordId = await mk(ORD);
        await assign(ordId);
        const end = _expireStand(compId);
        {
          const Database = require("better-sqlite3");
          const db = new Database(TEST_DB_PATH);
          try {
            expect(db.prepare("UPDATE competition_users SET assigned_at=? WHERE competition_id=? AND user_id=?")
              .run(new Date(end - 40 * 60_000).toISOString(), compId, ordId).changes, "the back-date must land").toBe(1);
          } finally { db.close(); }
        }
        await new Promise(r => setTimeout(r, 1300));   // past the per-competition row cache TTL
        await assign(await mk(LATE));                   // through the window: a late entrant
      }
      await sa.dispose();
    }

    await gotoTab(page, "Events");
    await filterComps(page, name);
    await page.locator("#admin-comp-body tr", { hasText: name }).first()
      .locator('button[data-action="comp-open"]').first().click();
    const banner = page.locator("#admin-scope-banner");
    await banner.waitFor({ state: "visible", timeout: 5000 });
    // The workspace's own Participants section (the sidebar's People closes it).
    await page.locator('#ws-tabs [data-section="admin-participants-tab"]').first().click();
    await narrowPeopleTable(page, "hall3-");
    const lateRow = page.locator("#admin-participants-body tr", { hasText: `${LATE.label}@company.example` }).first();
    const ordRow = page.locator("#admin-participants-body tr", { hasText: `${ORD.label}@company.example` }).first();
    await expect(lateRow).toBeVisible({ timeout: 15000 });
    await expect(ordRow).toBeVisible();

    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21): the banner, the badge on the
    // late entrant and NOT on the ordinary member, and the Remove item.
    await expect(banner, "the banner says the event is still taking late entries").toContainText("Ended · late entry open until");
    await expect(lateRow.locator(".comp-badge"), "the late entrant is badged").toContainText("late entrant");
    await expect(ordRow.locator(".comp-badge"), "…and the ordinary member is not").not.toContainText("late entrant");
    // WIDENED, not clipped (the v8.3.21 rule): at 1280 the table scrolls sideways
    // to reach the row menu, which takes the NAMES out of the picture — and the
    // caption is about which of the two people can be removed.
    await widenUntilUnclipped(page, "#admin-participants-tab .table-card", { max: 3000 });
    await openKebab(page, lateRow);
    await expect(page.locator('#kebab-portal [data-action="participant-uninvite"]'),
      "the late entrant can be removed during the window").toBeVisible();
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "64-late-entry-assign") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press("Escape").catch(() => {});
    await banner.locator(".scope-clear").click().catch(() => {});
  });

  test("65-close-late-entries", async ({ page }) => {
    // v8.12.8 — "Close late entries now": the confirmation an organiser sees
    // after choosing it from a window-open Booth Event's menu, naming the event
    // and the deadline it replaces. Taken as carol, a REGULAR admin — which is
    // itself the point: closing the window early no longer needs a superadmin.
    // The state cannot occur in the seed, so the guide's paragraph would
    // otherwise be its own only evidence.
    const name = "Security Stand — Hall 5";
    {
      // Built through a SUPERADMIN context; carol stays the browser's user.
      // Create-if-missing, and ended with the REAL End Now so the window opens
      // at once. A stand found with its window already CLOSED (an interrupted
      // run that confirmed) is deleted and rebuilt — never photograph that.
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      const saH = { "content-type": "application/json", "x-csrf-token": saCsrf };
      try {
        const comps = await (await sa.get("/api/admin/competitions")).json();
        expect(Array.isArray(comps), `the superadmin context can read the events list: ${JSON.stringify(comps).slice(0, 200)}`).toBe(true);
        let have = comps.find(c => c.name === name);
        if (have && !have.late_entry_window_open) {
          const del = await sa.delete(`/api/admin/competitions/${have.id}`, { headers: saH });
          expect(del.ok(), `delete a stand whose window is closed: ${await del.text()}`).toBeTruthy();
          have = null;
        }
        if (!have) {
          const created = await sa.post("/api/admin/competitions", {
            headers: saH,
            data: { name, event_kind: "booth", timezone: "UTC",
                    start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 180,
                    late_entry_enabled: true, self_enroll_enabled: true },
          });
          expect(created.ok(), `create booth: ${await created.text()}`).toBeTruthy();
          const compId = (await created.json()).competition.id;
          const ended = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH, data: {} });
          expect(ended.ok(), `end the stand: ${await ended.text()}`).toBeTruthy();
        }
      } finally { await sa.dispose(); }
    }

    await gotoTab(page, "Events");
    await filterComps(page, name);
    const row = page.locator("#admin-comp-body tr", { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21): the row is badged as taking late
    // entries, the SERVER offers the close to this regular admin, the menu carries
    // it, and the dialog names the deadline it replaces.
    await expect(row.locator(".status-badge.late-entry"), "the stand is still taking late entries").toContainText(/late entry open/i);
    const model = await page.evaluate((n) => (window.S?.adminCompetitionsData || []).find(c => c.name === n), name);
    expect(model && model.can_close_late_entries, "the server offers the close to a regular admin").toBe(true);
    // WIDENED, not clipped (the v8.3.21 rule): at 1280 the Events table scrolls
    // sideways to reach the row menu, which takes the event's NAME and its "Late
    // entry open" badge out of the picture behind the dialog.
    await widenUntilUnclipped(page, "#admin-competitions-tab .table-card", { max: 3000 });
    await row.locator('[data-action="comp-open"]').first().click();
    await page.locator("#ws-record").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#ws-quick .ws-more-btn").click();
    const item = page.locator('#kebab-portal.open [data-action="comp-close-late-entries"]');
    await expect(item, "the event's menu offers Close late entries now").toBeVisible();
    await item.click();
    const modal = page.locator("#modal-overlay");
    await expect(modal.locator("#modal-title")).toHaveText("Close late entries now", { timeout: 10000 });
    const deadline = await page.evaluate((iso) => window.fmtDt(iso, "long", { withZone: true }), model.late_entry_deadline_effective);
    expect(deadline, "the page can format the deadline").toBeTruthy();
    await expect(modal.locator("#modal-body"), "the dialog names the deadline it replaces").toContainText(deadline);
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "65-close-late-entries") });

    // Cancel, and confirm nothing moved, so the other theme's pass finds the same state.
    await modal.locator("#modal-cancel-btn").click();
    await expect(modal).toBeHidden({ timeout: 10000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    {
      const { api: sa } = await apiLogin("superadmin");
      try {
        const after = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.name === name);
        expect(after.late_entry_window_open, "Cancel left the window open").toBe(true);
        expect(after.late_entry_deadline_at, "…and the deadline unpinned").toBeFalsy();
      } finally { await sa.dispose(); }
    }
  });

  test("19-competition-create-single", async ({ page }) => {
    // New Competition dialog in the default single-session mode.
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await openCompCreateForm(page);
    // Fill the name so the screenshot reads as a real in-progress creation.
    await page.locator("#comp-name").fill("New Tournament");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "19-competition-create-single") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("20-competition-create-multi", async ({ page }) => {
    // New Competition dialog with the Multiple-sessions radio toggled
    // on and one session added via "+ Add Session".
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await openCompCreateForm(page);
    await page.locator("#comp-name").fill("Multi-Region Tournament");
    // Flip to Multiple-sessions mode. The radio is `display:none` —
    // click its label proxy.
    await page.locator("label[for='comp-mode-multi']").click();
    await page.locator("#comp-multi-section").waitFor({ state: "visible", timeout: 3000 });
    // Add one session so the screenshot shows a real session row (not just
    // the empty "+ Add Session" prompt).
    await page.locator("[data-action='comp-add-form-session']").click();
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "20-competition-create-multi") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("21-competition-edit-multi", async ({ page }) => {
    // Edit Competition dialog on a multi-session competition. Seeded via
    // the admin API so the test doesn't depend on prior captures leaving
    // a multi-session comp behind.
    await loginAsAdminCarol(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Create a fresh multi-session comp with two future sessions.
    const now = Date.now();
    const create = await page.request.post("/api/admin/competitions", {
      headers: h,
      data: { name: "Multi-Session Demo", start_time: new Date(now + 24 * 3600_000).toISOString(), duration_minutes: 120, leaderboard_mode: "per_slot" },
    });
    const comp = (await create.json()).competition;
    // Add two timeslots.
    await page.request.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: h, data: { name: "Americas", start_time: new Date(now + 24 * 3600_000).toISOString(), duration_minutes: 120 },
    });
    await page.request.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: h, data: { name: "EMEA", start_time: new Date(now + 36 * 3600_000).toISOString(), duration_minutes: 120 },
    });
    // Reload so the competitions list picks up the new comp.
    await page.locator("button.admin-nav-item[data-tab-id=\"admin-competitions-tab\"]").first().click();
    await page.locator(`#admin-comp-body tr:has-text('Multi-Session Demo')`).first().waitFor({ state: "visible", timeout: 5000 });
    // Open Edit settings from the event's workspace ⋯ menu.
    await (await openEventWsMenu(page, "Multi-Session Demo")).locator('[data-action="comp-edit"]').click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "21-competition-edit-multi") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
    // Clean up the seeded comp so subsequent captures aren't perturbed.
    await page.request.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  });

  test("22-competition-history", async ({ page }) => {
    // Competition-history dialog (Competitions tab → kebab → History).
    // The events feed includes create / edit / tag-add / assign /
    // start-now / end-now rows. We need the comp to have at least one
    // event, which is guaranteed by its creation.
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await (await openEventWsMenu(page)).locator('[data-action="comp-history"]').click();
    await page.locator("#hist-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "22-competition-history") });
    await page.locator("[data-action='history-close']").first().click().catch(() => {});
  });

  test("23-task-picker", async ({ page }) => {
    // Task-picker overlay — reached via the comp kebab → "Assign
    // Challenges". Same overlay is opened from "Create & Assign
    // Challenges" on comp creation AND from "+ Add Challenges to <Comp>"
    // on the Challenges tab when a non-ended comp is focused.
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    // Find the Test Upcoming row (non-ended so Assign Challenges is
    // enabled).
    // The event's one door into the bank: its Questions section's + Add from bank
    // (Stage B, owner ruling, 27 Nov 2026; neither event menu offers it).
    await filterComps(page, "Test Upcoming");
    await page.locator("#admin-comp-body tr", { hasText: "Test Upcoming" }).first().locator('[data-action="comp-open"]').first().click();
    await page.locator("#ws-record").waitFor({ state: "visible", timeout: 10000 });
    await page.locator('#ws-tabs [data-section="admin-tasks-tab"]').first().click();
    await page.locator("#add-tasks-to-comp-btn").click();
    await page.locator("#task-picker-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 500);
    // Type a partial query so the search bar shows active state in the screenshot.
    await page.locator("#task-picker-search").fill("hard");
    await settle(page, 200);
    await page.screenshot({ path: shotPath("admin", "23-task-picker") });
    await page.locator("#task-picker-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("24-challenge-view-as-participant", async ({ page }) => {
    // Task-preview overlay (Challenges tab → kebab → View as Participant
    // OR the row's View button). Reveals hint + correct answer +
    // explanation so admins can sanity-check what a participant will see
    // before the competition goes live.
    await gotoTab(page, "Challenges");
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await page.locator("#admin-task-body .task-actions button:has-text('View')").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "24-challenge-view-as-participant") });
    await page.locator("[data-action='task-preview-close']").first().click().catch(() => {});
  });

  test("25-challenge-history", async ({ page }) => {
    // Challenge-history dialog (Challenges tab → kebab → History).
    // Shows task_versions rows — created/edited/tag-added/lock/unlock/
    // scores_recalculated events. Seeded tasks always have at least a
    // "created" version.
    await gotoTab(page, "Challenges");
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await page.locator("#admin-task-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    await page.locator("#hist-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "25-challenge-history") });
    await page.locator("[data-action='history-close']").first().click().catch(() => {});
  });

  test("26-challenge-assign-comps", async ({ page }) => {
    // Assign-to-Competitions overlay (Challenges tab → kebab →
    // "Assign to Events"). Opposite direction of the task picker
    // in 23: there you pick N challenges for 1 competition; here you
    // pick N competitions for 1 challenge.
    //
    // Pick a non-draft row — the "Assign to Events" menu item
    // only renders for published tasks. Sort is alphabetical so
    // "Challenge draft1" is first in the list; target easy1 instead.
    await gotoTab(page, "Challenges");
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    // Stage B — the Question bank's one door into events: tick ONE question and
    // press Add to events on the selection bar, which opens its own dialog.
    const row = page.locator("#admin-task-body tr:has-text('Challenge easy1')").first();
    await row.locator('input[data-change-action="challenge-select-toggle"]').check();
    await page.locator("#challenge-selection-bar-assign-btn").click();
    await page.locator("#assign-task-overlay").waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "26-challenge-assign-comps") });
    await page.locator("#assign-task-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("27-deny-approval-modal", async ({ page }) => {
    // Deny Approval confirm dialog (Participants tab → row kebab →
    // "Deny Approval"). Captures the new v6.14.0 surface: explanatory
    // body, optional reason textarea, danger-styled primary button.
    // We need a verified-but-unapproved row to make the action button
    // visible — the seed registers Alice/Bob/Carol as verified +
    // approved, so we create a throwaway "PendingDeny" user via
    // /api/register + /verify BEFORE navigating to the page.
    const stamp = Date.now().toString(36);
    const tmpEmail = `pending-deny-shot-${stamp}@cust.test`;
    let tmpId;
    {
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      const saH = { "x-csrf-token": saCsrf };
      const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
      try {
        await registerPost(sa, "/api/register", {
          headers: saJsonH,
          data: {
            firstName: "Pending", lastName: "Deny", nickname: `pdeny_${stamp}`,
            email: tmpEmail, company: "Acme", title: "T",
            avatar: "default1", country: "US", timezone: "America/New_York",
          },
        });
        const list = await (await sa.get("/api/admin/participants?limit=500")).json();
        tmpId = (list.participants || []).find(p => p.email === tmpEmail)?.id;
        if (tmpId) await sa.post(`/api/admin/participants/${tmpId}/verify`, { headers: saH });
      } finally {
        await sa.dispose();
      }
    }
    try {
      await gotoTab(page, "Participants");
      await page.locator("#admin-participants-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
      await settle(page, 400);
      // Filter to Pending so our new row is the only visible one (or near top).
      await page.locator('#p-status-filters .filter-btn[data-value="pending"]').first().click().catch(() => {});
      await settle(page, 300);
      const row = page.locator(`#admin-participants-body tr:has-text("${tmpEmail}")`).first();
      await row.waitFor({ state: "attached", timeout: 8000 });
      await row.locator(".kebab-btn").click();
      await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
      await page.locator("#kebab-portal button:has-text('Deny Approval')").first().click();
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 3000 });
      await page.locator("#deny-reason").fill("Ineligible domain — disposable email provider.").catch(() => {});
      await settle(page, 200);
      await page.screenshot({ path: shotPath("admin", "27-deny-approval-modal") });
      // Cancel so we don't actually deny — this preserves a clean DB
      // for the next test run.
      await page.locator("#modal-cancel-btn").click().catch(() => {});
    } finally {
      if (tmpId) {
        const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
        await sa2.delete(`/api/admin/participants/${tmpId}`, {
          headers: { "x-csrf-token": sa2Csrf },
        }).catch(() => {});
        await sa2.dispose();
      }
    }
  });

  test("28-groups", async ({ page }) => {
    await loginAsAdminCarol(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Create-or-reuse a couple of representative groups (tolerant of reruns
    // across the light + dark passes that share one data dir).
    const ensureGroup = async (name, userIds) => {
      await page.request.post("/api/admin/groups", { headers: H, data: { name, userIds } }).catch(() => {});
      const list = await (await page.request.get("/api/admin/groups")).json();
      return (Array.isArray(list) ? list : []).find(g => g.name.toLowerCase() === name.toLowerCase());
    };
    const parts = (await (await page.request.get("/api/admin/participants?limit=50")).json()).participants || [];
    const memberIds = parts.filter(p => (p.role || "participant") === "participant").map(p => p.id);
    const g1 = await ensureGroup("Acme Cohort", memberIds.slice(0, 2));
    await ensureGroup("QA Reviewers", memberIds.slice(0, 1));
    // Bind one group to an upcoming competition so the Competitions count is non-zero.
    const comps = await (await page.request.get("/api/admin/competitions")).json();
    const bindTarget = (Array.isArray(comps) ? comps : []).find(c => c.name === "Test Upcoming");
    if (g1 && bindTarget) {
      await page.request.post("/api/admin/competitions/assign", { headers: H, data: { groupIds: [g1.id], competitionIds: [bindTarget.id] } }).catch(() => {});
    }
    await page.locator("button.admin-nav-item[data-tab-id='admin-groups-tab']").first().click();
    await page.locator("#admin-groups-body table").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "28-groups") });
  });

  // v6.20.6 — capture the group dialogs operators see most often: create,
  // rename, manage-members (with the new server-paginated picker), and
  // bind-to-competitions. Each test relies on the seed groups from "28-groups";
  // we just need the row to be visible. To avoid clobbering DB state when run
  // back-to-back across light/dark, each test takes the screenshot then
  // dismisses the modal with Cancel/Close.
  test("29-group-create-dialog", async ({ page }) => {
    await loginAsAdminCarol(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-groups-tab']").first().click();
    await page.locator("#admin-groups-body").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.locator("button[data-action='group-create']").first().click().catch(() => {});
    await page.locator("#prompt-input").waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await page.locator("#prompt-input").fill("EMEA Cohort").catch(() => {});
    await settle(page, 200);
    await page.screenshot({ path: shotPath("admin", "29-group-create-dialog") });
    await page.locator("#prompt-cancel").click().catch(() => {});
  });

  // Helper: idempotently seed a "Acme Cohort" group with a couple of members
  // so dialog screenshots have something to operate on, even when run in
  // isolation (without test "28-groups" running first).
  async function ensureSeedGroup(page) {
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const parts = (await (await page.request.get("/api/admin/participants?limit=50")).json()).participants || [];
    const memberIds = parts.filter(p => (p.role || "participant") === "participant").map(p => p.id).slice(0, 2);
    await page.request.post("/api/admin/groups", { headers: H, data: { name: "Acme Cohort", userIds: memberIds } }).catch(() => {});
  }

  test("30-group-rename-dialog", async ({ page }) => {
    await loginAsAdminCarol(page);
    await ensureSeedGroup(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-groups-tab']").first().click();
    await page.locator("#admin-groups-body table").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.locator("button[data-action='group-rename']").first().click().catch(() => {});
    await page.locator("#prompt-input").waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await settle(page, 200);
    await page.screenshot({ path: shotPath("admin", "30-group-rename-dialog") });
    await page.locator("#prompt-cancel").click().catch(() => {});
  });

  test("31-group-members-dialog", async ({ page }) => {
    await loginAsAdminCarol(page);
    await ensureSeedGroup(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-groups-tab']").first().click();
    await page.locator("#admin-groups-body table").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.locator("button[data-action='group-manage-members']").first().click().catch(() => {});
    await page.locator("#gm-search").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "31-group-members-dialog") });
    await page.locator("#gm-close").click().catch(() => {});
  });

  test("32-group-competitions-dialog", async ({ page }) => {
    await loginAsAdminCarol(page);
    await ensureSeedGroup(page);
    // v8.12.6 — the dialog now lists an event still taking late entries, badged
    // apart, and its hint says what binding a group to one means. The stand is
    // built here if capture 51 has not already built it, so this capture shows
    // that state when run alone too.
    const stand = "Security Stand — Hall 2";
    await ensureLateEntryStand(page, stand);
    await page.locator("button.admin-nav-item[data-tab-id='admin-groups-tab']").first().click();
    await page.locator("#admin-groups-body table").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await settle(page);
    await page.locator("button[data-action='group-bind-comps']").first().click().catch(() => {});
    await page.locator("#gc-save").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21).
    const standRow = page.locator("#gc-list label", { hasText: stand }).first();
    await expect(standRow, "the late-entry stand is listed").toBeVisible();
    await expect(standRow.locator(".status-badge"), "…badged apart from a finished event").toHaveText("Late entry open");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "32-group-competitions-dialog") });
    await page.locator("#gc-close").click().catch(() => {});
  });

  test("33-self-enroll-dialog", async ({ page }) => {
    // Self-enrollment ("Join Link") dialog from a competition's kebab menu:
    // the secret link + QR + enable toggle. Referenced from the
    // admin guide's Competitions section. The first comp row is non-ended
    // (start_time DESC), so its kebab carries the Join Link action.
    await gotoTab(page, "Events");
    await (await openEventWsMenu(page, "Test Live")).locator('[data-action="comp-self-enroll"]').click();
    await page.locator("#self-enroll-overlay").waitFor({ state: "visible" });
    // The QR is rendered from a lazy-loaded vendor lib — wait for the <svg>.
    await page.locator("#self-enroll-qr img.se-qr-img").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "33-self-enroll-dialog") });
    await page.locator("#self-enroll-overlay [data-action='self-enroll-close']").first().click().catch(() => {});
  });

  test("34-group-rankings", async ({ page }) => {
    // v7.11.x — the admin "Group Rankings" board under the Rankings tab, shown when a
    // competition has bound groups. Focus the Regional Cup (Team Red + Team Blue bound,
    // plus a solo entrant) and open Rankings so both the individual and group boards render.
    const s = await seedGroupBoardScenario();
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await page.evaluate(({ id, name }) => window.openEventWorkspace(id, name), { id: s.compId, name: s.compName });
    await page.locator('#ws-tabs [data-section="admin-rankings-tab"]').first().click();
    await page.locator("#admin-rankings-group-section").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#admin-rankings-group-section").scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "34-group-rankings") });
  });

  test("35-challenges-bulk-assign", async ({ page }) => {
    // v7.12.0 — the Challenges pane's bulk-select checkboxes + the "Add to
    // Competitions" selection bar. Select the first two published challenges so
    // the bar appears.
    await gotoTab(page, "Challenges");
    await page.locator("#admin-task-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    const boxes = page.locator("#admin-task-body input[type=checkbox]");
    await boxes.first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const n = Math.min(2, await boxes.count());
    for (let i = 0; i < n; i++) await boxes.nth(i).check();
    await page.locator("#challenges-selection-bar").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "35-challenges-bulk-assign") });
  });

  test("36-trusted-network-ips", async ({ page }) => {
    // v7.16.0 — the per-competition trusted-network control. Shot on a
    // SINGLE-session competition, which is the only shape that can carry it:
    // on a multi-session competition the input is disabled and replaced by the
    // explanatory note, so a screenshot there would document the wrong state.
    await gotoTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await openCompCreateForm(page).catch(() => {});
    const tip = page.locator("#comp-trusted-ips");
    if (await tip.count()) {
      await tip.fill("203.0.113.7, 198.51.100.0/24");
      await tip.scrollIntoViewIfNeeded().catch(() => {});
    }
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "36-trusted-network-ips") });
    await page.keyboard.press("Escape").catch(() => {});
  });

  test("37-ip-ban-alert", async ({ page }) => {
    // v7.16.0 — the IP-ban alert an admin sees when a venue's shared address is
    // blocked. Driven directly through the exported renderer rather than by
    // provoking a real 100-4xx ban, which would take ten minutes of traffic and
    // would then rate-limit the very session taking the screenshot.
    await gotoTab(page, "Events");
    await page.waitForFunction(() => typeof window._showIpBanAlert === "function", { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      window._showIpBanAlert({
        id: "demo", kind: "ip_banned", ip: "203.0.113.7",
        at: Date.now(), blocked_until: new Date(Date.now() + 15 * 60_000).toISOString(),
        count_4xx: 103, competition_id: "demo", competition_name: "Spring Hackathon",
        already_trusted: false,
      }, true); // true → also render the superadmin-only "dismiss for everyone"
    }).catch(() => {});
    await page.locator("#admin-alert-overlay").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "37-ip-ban-alert") });
    await page.evaluate(() => window._closeAdminAlert && window._closeAdminAlert()).catch(() => {});
  });

  test("38-ip-ban-alert-admin", async ({ page }) => {
    // The SAME alert as 37, rendered for a REGULAR admin. The two differ by one
    // button — "Not our venue — dismiss for everyone" is superadmin-only — and
    // that difference matters in the docs: admin.md is read by regular admins,
    // so illustrating it with the superadmin view shows them a control they do
    // not have. 37 stays, and is the one the superadmin guide uses.
    await gotoTab(page, "Events");
    await page.waitForFunction(() => typeof window._showIpBanAlert === "function", { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      window._showIpBanAlert({
        id: "demo-admin", kind: "ip_banned", ip: "203.0.113.7",
        at: Date.now(), blocked_until: new Date(Date.now() + 15 * 60_000).toISOString(),
        count_4xx: 103, competition_id: "demo", competition_name: "Spring Hackathon",
        already_trusted: false,
      }, false); // false → regular admin: "Dismiss" only
    }).catch(() => {});
    await page.locator("#admin-alert-overlay").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "38-ip-ban-alert-admin") });
    await page.evaluate(() => window._closeAdminAlert && window._closeAdminAlert()).catch(() => {});
  });

  test("30-impersonate-kebab", async ({ page }) => {
    // v7.14.0 — the "Impersonate" row action in the Participants kebab.
    // Search down to alice (a plain participant) so the menu shown is the
    // participant-target variant that actually carries the item — privileged
    // rows deliberately don't offer it.
    await gotoTab(page, "Participants");
    await narrowPeopleTable(page, "alice@acme.com");
    const row = page.locator("#admin-participants-body tr:has-text('alice@acme.com')").first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.locator(".kebab-btn").first().click();
    await page.locator("#kebab-portal button:has-text('Impersonate')").waitFor({ state: "visible", timeout: 5000 });
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "30-impersonate-kebab") });
  });

  test("32-peer-admin-restricted-kebab", async ({ page }) => {
    // v7.14.2 — what a REGULAR admin sees on another admin's row: the menu is
    // deliberately short (the peer-admin doctrine reserves block / reset / role /
    // delete / edit for superadmins) and now says so, instead of collapsing
    // silently in a way that reads as a broken feature.
    await loginAsAdminCarol(page);
    // A dedicated throwaway admin to point at — avoids mutating a seeded account
    // that later scenes rely on.
    const stamp = `${Date.now().toString(36)}`;
    const email = `peer-admin-${stamp}@acme.com`;
    {
      const sa = await apiLogin("superadmin");
      const H = { "x-csrf-token": sa.csrf, "content-type": "application/json" };
      const { api: anon, csrf: ac } = await freshCtx();
      await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
        firstName: "Priya", lastName: "Nair", nickname: `priya_${stamp}`, email,
        company: "Acme", title: "Platform Lead", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York", password: PARTICIPANT_PASS,
      }});
      await anon.dispose();
      const u = (await (await sa.api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
        .participants.find(p => p.email === email);
      await sa.api.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
      await sa.api.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
      await sa.api.post(`/api/admin/participants/${u.id}/role`, { headers: H, data: { role: "admin" } });
      await sa.api.dispose();
    }
    await gotoTab(page, "Participants");
    // People lists admin accounts only after a link to one (they live on Roles &
    // permissions); the helper takes that path.
    await peopleWithAdminAccounts(page);
    await narrowPeopleTable(page, email);
    const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.locator(".kebab-btn").first().click();
    await page.locator("#kebab-portal .kebab-note").waitFor({ state: "visible", timeout: 5000 });
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "32-peer-admin-restricted-kebab") });
  });

  test("31-impersonation-banner", async ({ page }) => {
    // v7.14.0 — the participant view as seen while impersonating, with the
    // fixed banner + Exit control across the top. Entering via the API keeps
    // the capture deterministic (the kebab + confirm flow is covered by
    // 30-impersonate-kebab and the E2E specs); the reload is what boot() needs
    // to pick the impersonation block out of /api/me and render the banner.
    await loginAsAdminCarol(page);
    const parts = (await (await page.request.get("/api/admin/participants?limit=200")).json()).participants || [];
    const alice = parts.find(p => p.email === "alice@acme.com");
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post(`/api/admin/participants/${alice.id}/impersonate`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    });
    await page.goto("/");
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "31-impersonation-banner") });
    // Leave the session clean for the shared data dir / later captures.
    const csrf2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/impersonation/exit", { headers: { "x-csrf-token": csrf2 } }).catch(() => {});
  });

  test("62-impersonate-event-admin-dialog", async ({ page }) => {
    // v8.12.1 — the Impersonate dialog on an EVENT ADMIN's row asks which of
    // their two views to open; the organiser's panel is the default. Captured
    // as a regular admin so the tier note is the read-only one the admin
    // guide describes. The radios ARE the picture, so assert them: the same
    // dialog on a participant's row has none, and a capture of that one under
    // this caption would show a choice that is not there.
    const target = await ensureOrganiserTargetFixture();
    await gotoTab(page, "Participants");
    await narrowPeopleTable(page, target.email);
    const row = page.locator(`#admin-participants-body tr:has-text("${target.email}")`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.locator(".kebab-btn").first().click();
    const item = page.locator("#kebab-portal button:has-text('Impersonate')");
    await item.waitFor({ state: "visible", timeout: 5000 });
    await expect(item).toHaveAttribute("data-role", "event_admin");
    await item.click();
    await page.locator('#modal-body input[name="imp-view"]').first().waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator('#modal-body input[name="imp-view"]')).toHaveCount(2);
    await expect(page.locator('#modal-body input[name="imp-view"][value="admin"]')).toBeChecked();
    await expect(page.locator("#modal-body")).toContainText(/read-only/);
    await settle(page);
    await page.screenshot({ path: shotPath("admin", "62-impersonate-event-admin-dialog") });
    await page.locator("#modal-cancel-btn").click().catch(() => {});
  });

  test("63-impersonate-event-admin-view", async ({ page }) => {
    // v8.12.1 — an organiser's Event Admin Panel as a REGULAR admin sees it
    // while impersonating them: their events only, the two nav items an
    // organiser never has withheld, and the read-only banner across the top
    // naming the view in force. Entered via the API for determinism (the
    // dialog is 62); the reload is what boot() needs to render the banner
    // BEFORE it builds the admin nav.
    const target = await ensureOrganiserTargetFixture();
    await loginAsAdminCarol(page);
    try {
      await enterOrganiserPanelViaApi(page, target, /read-only/);
      await settle(page, 500);
      await page.screenshot({ path: shotPath("admin", "63-impersonate-event-admin-view") });
    } finally { await exitImpersonationViaApi(page); }
  });

  test("49-impersonation-certificate", async ({ page }) => {
    // v8.3.25 — the ONE durable thing a read-only impersonation session may do:
    // generate the participant's certificate. Captured as a REGULAR admin
    // (loginAsAdminCarol), because the whole point is the tier that could not do
    // this before, and on a Program, where the withheld LinkedIn Share is most
    // load-bearing — pressing Share is what makes that page public.
    const fx = await ensureImpersonationCertFixture();
    await loginAsAdminCarol(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const imp = await page.request.post(`/api/admin/participants/${fx.id}/impersonate`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    });
    if (!imp.ok()) throw new Error(`impersonate failed: ${imp.status()} ${await imp.text()}`);
    // select-competition is on the impersonation write-allowlist (pure
    // navigation), so this is the door the picker uses — it just skips a click.
    const csrf3 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf3, "content-type": "application/json" }, data: { competitionId: fx.compId },
    });
    await page.goto("/");
    await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#cert-cta").waitFor({ state: "visible", timeout: 20000 });
    // The list forces the Unsolved filter while an event is live, so a finished
    // Program shows "no challenges match" behind the dialog. Click All first —
    // the same step 17-certificate-cta takes — so the background reads as the
    // work that earned the certificate rather than as an error.
    await page.locator("#solve-filters [data-value=\"all\"]").first().click();
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 10000 });

    // ASSERT THE STATE BEFORE SHOOTING (v8.3.21): without this a fixture whose
    // solve silently failed would ship a picture of an empty page under a caption
    // about generating a certificate.
    await page.locator('#cert-cta [data-action="open-badge-share"]').click();
    await expect(page.locator("#modal-overlay")).toContainText(/Generate this certificate/i, { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    // A regular admin may not look certificates up by code, so viewing as the
    // participant hides the certificate's code, picture and downloads, and the
    // dialog says why (operator ruling, 23 Nov 2026).
    await page.locator(".badge-withheld-note").waitFor({ state: "visible", timeout: 20000 });
    // The facts the caption is about: the note explaining what is hidden, no
    // download, and a primary button that is Close rather than "Share on LinkedIn".
    await expect(page.locator(".badge-share-img")).toHaveCount(0);
    await expect(page.locator('#modal-overlay a[href*="/badge/"]')).toHaveCount(0);
    await expect(page.locator("#modal-confirm-btn")).toHaveText(/^Close$/);
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "49-impersonation-certificate") });

    // Leave the shared data dir clean for the captures that follow.
    const csrf4 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/impersonation/exit", { headers: { "x-csrf-token": csrf4 } }).catch(() => {});
  });

  // ── v8.17.0 — surfaces the admin guide describes that had no picture ────────

  test("66-template-editor", async ({ page }) => {
    await gotoTab(page, "Templates");
    await page.locator("#tpl-list .tpl-row, #tpl-list-empty").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#tpl-new-btn").click();
    const ed = page.locator("#tpl-editor");
    await ed.waitFor({ state: "visible", timeout: 10000 });
    await ed.locator("#tpl-ed-name").fill("Booth — 45 minutes, phone and city");
    await ed.locator("#tpl-ed-kind").selectOption("booth");
    await ed.locator("#tpl-ed-duration").fill("45");
    await expect(ed.locator("#tpl-ed-sum"), "the live summary follows the form").toContainText("45 min");
    // Back to the top of the editor (filling the duration scrolled it), so the
    // picture opens on Basics with the Summary beside it.
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await ed.locator("#tpl-ed-name").scrollIntoViewIfNeeded();
    await ed.evaluate((el) => { for (let n = el; n; n = n.parentElement) if (n.scrollTop) n.scrollTop = 0; });
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "66-template-editor") });
  });

  test("67-clone-dialog", async ({ page }) => {
    const compId = await seededLiveCompId();
    await gotoTab(page, "Events");
    await openWorkspace(page, compId, "Test Live");
    await page.evaluate(() => window.wsClone());
    const dlg = page.locator("#ws-clone-dialog");
    await dlg.waitFor({ state: "visible", timeout: 10000 });
    await expect(dlg.locator("#ws-clone-name")).toHaveValue(/Test Live \(copy\)/);
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "67-clone-dialog") });
  });

  test("68-join-qr-popover", async ({ page }) => {
    const fx = await ensureBoothJoinFixture();
    await gotoTab(page, "Events");
    await openWorkspace(page, fx.compId, fx.name);
    await page.locator('#ws-join [data-action="ws-join-reveal"]').click();
    const pop = page.locator("#ws-join-pop");
    await pop.waitFor({ state: "visible", timeout: 10000 });
    const img = pop.locator("#ws-qr img");
    await img.waitFor({ state: "visible", timeout: 10000 });
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth), { message: "the QR decoded" }).toBeGreaterThan(0);
    await settle(page, 400);
    await page.screenshot({ path: shotPath("admin", "68-join-qr-popover") });
  });

  test("69-workspace-certificates", async ({ page }) => {
    const fx = await ensureIssuedCertsFixture();
    await gotoTab(page, "Events");
    await openWorkspace(page, fx.compId, fx.name);
    await page.locator('#ws-tabs [data-section="admin-event-certs-tab"]').first().click();
    const issued = page.locator("#ws-certs-issued");
    await expect(issued.locator("tbody tr"), "the issued certificates are listed").toHaveCount(3, { timeout: 15000 });
    await page.locator("#ws-certs-design #cw-img").waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await settle(page, 500);
    await page.screenshot({ path: shotPath("admin", "69-workspace-certificates"), fullPage: true });
  });

  test("70-workspace-team-reports", async ({ page }) => {
    const fx = await ensureIssuedCertsFixture();
    await gotoTab(page, "Events");
    await openWorkspace(page, fx.compId, fx.name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').first().click();
    await page.locator("#admin-event-team-tab").waitFor({ state: "visible", timeout: 10000 });
    await settle(page, 800);
    await page.screenshot({ path: shotPath("admin", "70-workspace-team-reports"), fullPage: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Superadmin role — features only superadmins can see/use
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("superadmin", () => {
  test("01-role-promotion", async ({ page }) => {
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#admin-participants-body .kebab-btn").first().waitFor({ state: "visible" });
    await page.locator("#admin-participants-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    // Role changes live on Roles & permissions: the row menu links there.
    await page.locator("#kebab-portal [data-action='participant-open-roles']").first().waitFor({ state: "visible" });
    await settle(page);
    await page.screenshot({ path: shotPath("superadmin", "01-role-promotion") });
    await page.keyboard.press("Escape");
  });

  test("02-task-delete-confirm", async ({ page }) => {
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-tasks-tab']").first().click();
    await page.locator("#admin-task-body .kebab-btn").first().waitFor({ state: "visible" });
    await page.locator("#admin-task-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button.km-danger:has-text('Delete')").first().click();
    await settle(page);
    await page.screenshot({ path: shotPath("superadmin", "02-task-delete-confirm") });
    await page.locator("#modal-cancel-btn").click().catch(() => {});
  });

  test("09-sealed-challenge-not-yours", async ({ page }) => {
    // v8.10.1 — the row menu on a challenge somebody ELSE sealed, seen by a
    // SUPERADMIN: no Edit, no Publish, no Hide, no tag controls, and a note
    // saying why. Referenced from superadmin.md → Sealed answers, whose whole
    // section describes this and had no picture of it.
    // v8.12.2 — the same menu now also offers "Reveal sealed answer" (the
    // built-in superadmin is never an author, so it is always offered the
    // reveal); the caption names it, so assert it is there before shooting.
    //
    // The author must be a real account (the built-in superadmin cannot seal —
    // it has no user record), so carol is promoted for the seed and put back.
    await ensureCarolIsAdmin();
    let id = null;
    try {
      await loginViaApi(page, "carol@acme.com", PARTICIPANT_PASS);
      const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const title = "Recover the flag from the packet capture";
      const r = await page.request.post("/api/admin/tasks", {
        headers: { "x-csrf-token": c, "content-type": "application/json" },
        data: { title, difficulty: "medium", answer_type: "text", status: "published",
          description: "<p>The capture is attached. Find the flag the operator leaked.</p>",
          correct_answer: "CTF{quiet_on_the_wire}", answer_sealed: true },
      });
      if (!r.ok()) throw new Error(`seed failed: ${r.status()} ${await r.text()}`);
      id = (await r.json()).id;

      await loginAsSuperadmin(page);
      await page.locator("button.admin-nav-item[data-tab-id='admin-tasks-tab']").first().click();
      await page.locator("#task-search").waitFor({ state: "visible", timeout: 10000 });
      await narrowChallengesTable(page, title);
      const row = page.locator("#admin-task-body tr", { hasText: title }).first();
      await row.waitFor({ state: "visible", timeout: 10000 });
      // The state the caption describes, asserted before shooting: the Sealed
      // badge is there, and the menu really is missing the four controls.
      await expect(row).toContainText("Sealed");
      // A PICTURE THAT CONTRADICTS ITS OWN CAPTION IS WORSE THAN NO PICTURE
      // (v8.3.21): the caption names the Sealed badge AND the menu, and the
      // table is min-width:1372px inside a narrower card, so at the default
      // width one or the other is behind the horizontal scroll. Widen until the
      // card has nothing left to scroll, and ASSERT it rather than trusting a
      // hard-coded number — that is exactly how two captures went stale when a
      // column was added.
      for (const w of [1280, 1500, 1700, 1900, 2100, 2300]) {
        await page.setViewportSize({ width: w, height: 900 });
        await settle(page, 200);
        const over = await page.evaluate(() => {
          const el = document.querySelector("#admin-task-body")?.closest(".table-wrap, .card");
          return el ? el.scrollWidth - el.clientWidth : 0;
        });
        if (over <= 1) break;
      }
      const stillClipped = await page.evaluate(() => {
        const el = document.querySelector("#admin-task-body")?.closest(".table-wrap, .card");
        return el ? el.scrollWidth - el.clientWidth : 0;
      });
      if (stillClipped > 1) throw new Error(`the challenges table is still clipped by ${stillClipped}px — the badge or the menu would be out of frame`);
      await row.locator(".kebab-btn").first().click();
      await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 5000 });
      const menu = page.locator("#kebab-portal");
      for (const gone of ["Edit", "Publish", "Hide"]) {
        await expect(menu.locator(`button:has-text("${gone}")`)).toHaveCount(0);
      }
      // The reason must name the SEAL, not authorship — a superadmin can edit
      // anybody else's challenge, so "created by someone else" would be a rule
      // that does not bind them standing in for the one that does.
      await expect(menu.locator(".kebab-note")).toContainText(/answer is sealed/i);
      await expect(menu.locator("button[data-action='task-reveal-sealed']")).toHaveCount(1);
      await settle(page, 400);
      await page.screenshot({ path: shotPath("superadmin", "09-sealed-challenge-not-yours") });
      await page.keyboard.press("Escape").catch(() => {});
      if (id) await page.request.delete(`/api/admin/tasks/${id}`,
        { headers: { "x-csrf-token": (await (await page.request.get("/api/csrf-token")).json()).csrfToken } });
    } finally {
      await restoreCarolToParticipant();
    }
  });

  test("03-verify-modal", async ({ page }) => {
    // Need an unverified user to make the Verify action visible. Create a
    // throwaway one via the API as superadmin, capture the modal, then exit.
    const t = Date.now();
    const { api: sa, csrf } = await apiLogin("superadmin");
    await registerPost(sa, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Shot", lastName: "Verify", nickname: `shotverify_${t}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email: `shot-verify-${t}@company.co`,
      },
    });
    await sa.dispose();

    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    const row = page.locator(`#admin-participants-body tr:has-text('shotverify_${t}')`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.locator(".kebab-btn").click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Verify')").first().click();
    await settle(page);
    await page.screenshot({ path: shotPath("superadmin", "03-verify-modal") });
    await page.locator("#modal-cancel-btn").click().catch(() => {});
  });

  test("04-import-workflow", async ({ page }) => {
    // Import is a `<label for=hidden-file-input>` that opens the OS file
    // dialog when clicked — Playwright can't render that. Instead, capture
    // the Participants tab cropped to the bulk-actions area where the
    // Import button lives, alongside the Export and Bulk-Approve buttons.
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    // Import is in the Export ▾ menu beside CSV and JSON: open it for the shot.
    await page.locator("#p-export-menu-btn").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#p-export-menu-btn").scrollIntoViewIfNeeded();
    await page.locator("#p-export-menu-btn").click();
    await page.locator('#kebab-portal.open [data-target-id="import-participants-file"]').waitFor({ state: "visible", timeout: 5000 });
    await settle(page, 400);
    await page.screenshot({ path: shotPath("superadmin", "04-import-workflow") });
  });

  // v7.26.0 — MOVED here from the `admin` describe. The Settings tab is
  // superadmin-only now (all three of its cards are), so `gotoTab`'s regular
  // admin can no longer reach it and the capture timed out. It also means the
  // shipped image was an ADMIN-tier view — one card, no CxOne, no unsubscribe
  // list — while `superadmin.md`, which is where this PNG is now embedded,
  // describes the tab as holding all three. The output path stays
  // `admin/12-settings` because both guides reference that path.
  test("12-settings", async ({ page }) => {
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item:has-text('Settings')").first().click();
    await page.locator("#admin-settings-tab").waitFor({ state: "visible" });
    await settle(page, 600);
    await page.screenshot({ path: shotPath("admin", "12-settings") });
  });

  test("05-cxone-settings", async ({ page }) => {
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item:has-text('Settings')").first().click();
    await page.locator("#admin-settings-tab").waitFor({ state: "visible" });
    // Settings is two panes: the CxOne card is in General.
    await require("./ui-admin-helpers").openSettingsSection(page, "general");
    const card = page.locator("#cxone-card");
    await expect(card).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => {
      const el = document.getElementById("cxone-card");
      const hb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")) || 64;
      window.scrollBy(0, el.getBoundingClientRect().top - hb - 16);
    });
    await settle(page, 600);
    await page.screenshot({ path: shotPath("superadmin", "05-cxone-settings") });
  });

  test("07-comp-edit-cxone", async ({ page }) => {
    // Superadmin edit modal — shows the per-competition CxOne override
    // section. Referenced from both the admin guide (to clarify the
    // superadmin-only nature of this section — regular admins don't see
    // it at all) and the superadmin guide (to illustrate the override
    // UI). The CxOne section lives at the bottom of the scrollable card
    // so we scroll it into view inside the card before capture.
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id=\"admin-competitions-tab\"]").first().click();
    // A Competition: a Booth Event has no Checkmarx One section at all.
    await (await openEventWsMenu(page, "Test Live")).locator('[data-action="comp-edit"]').click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible" });
    await openCompAdvanced(page);   // folded on an edit too
    await page.locator("#comp-form-overlay h3:has-text('CxOne')").scrollIntoViewIfNeeded();
    await settle(page, 400);
    await page.screenshot({ path: shotPath("superadmin", "07-comp-edit-cxone") });
    await page.locator("#comp-form-overlay [data-action='overlay-close']").first().click().catch(() => {});
  });

  test("08-unsubscribe-list", async ({ page }) => {
    // Seed one entry so the list isn't empty in the screenshot.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    db.prepare(
      `INSERT OR IGNORE INTO unsubscribed_emails (email, unsubscribed_at, reason)
       VALUES ('demo-participant@example.com', datetime('now','-2 days'), 'one_click')`
    ).run();
    db.close();

    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item:has-text('Settings')").first().click();
    await page.locator("#admin-settings-tab").waitFor({ state: "visible" });
    await require("./ui-admin-helpers").openSettingsSection(page, "email");   // two panes: the list is in Email
    await page.locator("#unsubscribe-card").waitFor({ state: "visible" });
    await page.locator("#unsubscribe-card").scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("superadmin", "08-unsubscribe-list") });
  });



  test("10-impersonate-event-admin-view", async ({ page }) => {
    // v8.12.1 — the same organiser's panel under a SUPERADMIN's banner: full
    // access, every write confirmed first. The superadmin guide's capture is
    // this one rather than the admin guide's because the tier is the whole
    // difference, and the banner is where it is printed. The built-in
    // superadmin login purges every other superadmin session, so the fixture
    // (which signs in as the built-in account on its own context) is built
    // BEFORE the browser signs in.
    const target = await ensureOrganiserTargetFixture();
    await loginAsSuperadmin(page);
    try {
      await enterOrganiserPanelViaApi(page, target, /full access/);
      await settle(page, 500);
      await page.screenshot({ path: shotPath("superadmin", "10-impersonate-event-admin-view") });
    } finally { await exitImpersonationViaApi(page); }
  });

  test("11-cxone-removals", async ({ page }) => {
    // v8.12.7 (F2) — the Checkmarx One account removals card: the accounts the
    // platform created for participants who have since been deleted, and could
    // not remove from the customer's tenant (or will not without a superadmin's
    // say-so). The seed provisions nothing, so three ledger rows are PLANTED,
    // one per state a superadmin has to decide on:
    //   * HELD and overridable — the tenant adopted the account, so "Remove
    //     anyway" is offered beside Retry and Mark removed; its deletion is old
    //     enough to be past any 730-day window, so its Since cell also says it
    //     was kept past the retention period (no removal is dropped for its age);
    //   * NEEDS ATTENTION — three failed attempts with the last error shown;
    //   * UNMARKED — the participant is gone and nothing recorded a deletion,
    //     so its first button is "Schedule removal" rather than Retry.
    // Every `user_id` names nobody in `users` (a deleted participant), which is
    // what makes the unmarked row listed at all. Timestamps are FIXED, so the
    // picture does not move between runs — except that the other two rows'
    // September 2026 dates cross the 730-day window in September 2028, after
    // which they carry the label too; so nothing below asserts that they do NOT
    // (that would be a capture-suite time bomb); the account ids are fixed UUIDs for
    // the same reason, so the light and dark twins show the same values. Planted through better-sqlite3 on the
    // worker server's database, the idiom 08-unsubscribe-list uses; the rows are
    // removed in a `finally` so no later capture's header carries the banner.
    //
    // The browser signs in AFTER the database set-up and there is no API login
    // here at all: the built-in superadmin sign-in purges every other session
    // for the account (single-session rule).
    const Database = require("better-sqlite3");
    const { randomUUID } = require("crypto");
    const db = new Database(TEST_DB_PATH, { timeout: 5000 });
    const comp = db.prepare("SELECT id, name FROM competitions WHERE name=?").get("Test Live");
    const before = db.prepare("SELECT COUNT(*) AS n FROM cxone_realm_accounts").get().n;
    db.close();
    if (!comp) throw new Error("[shots] the seeded 'Test Live' competition is missing");
    // Precondition: nothing else on the ledger, or the card shows rows this
    // capture did not plant and the banner's count is not the one asserted below.
    expect(before, "cxone_realm_accounts must be empty before the capture plants its rows").toBe(0);

    const base = {
      iam_origin: "https://iam.checkmarx.net", tenant: "acme", realm_confirmed: 1,
      competition_id: comp.id, created_username: "jdoe", provenance: "created",
      instance_origin: new URL(BASE).origin, deletion_source: null, attempts: 0,
      first_failed_at: null, next_attempt_at: null, last_error: null, held_reason: null,
      attention: 0, override_reason: null, override_by: null, override_at: null,
      transferred_at: null, claim_token: null, claimed_at: null, given_up_at: null,
    };
    const rows = {
      held: { ...base, cxone_user_id: "5f0c3a9e-7d41-4b8e-9a26-3c1e8f47b2d0", user_id: `gone-${randomUUID()}`,
        provenance_at: "2023-09-18T09:12:00.000Z", recorded_at: "2023-09-18T09:12:00.000Z",
        pending_since: "2023-09-25T14:20:00.000Z", deletion_source: "cascade",
        held_reason: "adopted_by_tenant", held_signal: "role_mapping", attention: 1 },
      attention: { ...base, cxone_user_id: "a83e61d2-40bf-4c77-8e15-9b2d07c4f6a1", user_id: `gone-${randomUUID()}`, created_username: "asmith",
        provenance_at: "2026-09-17T11:40:00.000Z", recorded_at: "2026-09-17T11:40:00.000Z",
        pending_since: "2026-09-24T10:05:00.000Z", deletion_source: "cascade",
        attempts: 3, first_failed_at: "2026-09-24T10:05:30.000Z",
        next_attempt_at: "2026-09-26T10:05:30.000Z", last_error: "503/delete_failed", attention: 1 },
      unmarked: { ...base, cxone_user_id: "c2d94b70-1e8a-4f35-b6c9-58a0e3d1f927", user_id: `gone-${randomUUID()}`, created_username: "mlee",
        provenance_at: "2026-09-16T15:30:00.000Z", recorded_at: "2026-09-16T15:30:00.000Z",
        pending_since: null },
    };
    const planted = Object.values(rows).map((r) => r.cxone_user_id);
    const plantDb = new Database(TEST_DB_PATH, { timeout: 5000 });
    try {
      for (const r of Object.values(rows)) {
        const cols = Object.keys(r);
        plantDb.prepare(`INSERT INTO cxone_realm_accounts (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(r);
      }
    } finally { plantDb.close(); }

    try {
      await loginAsSuperadmin(page);
      // Preconditions from the SERVER: exactly the three planted rows, in the
      // three states the caption describes, and the held one overridable.
      const listed = await (await page.request.get("/api/admin/cxone/withdrawals")).json();
      expect((listed.rows || []).map((r) => r.cxone_user_id).sort(), "the card lists exactly the planted rows").toEqual([...planted].sort());
      const stateOf = (id) => listed.rows.find((r) => r.cxone_user_id === id);
      expect(stateOf(rows.held.cxone_user_id).state).toBe("held");
      expect(stateOf(rows.held.cxone_user_id).overridable).toBe(true);
      expect(stateOf(rows.held.cxone_user_id).past_retention, "the held row is kept past the retention window").toBe(true);
      expect(listed.retention_days).toBe(730);
      expect(stateOf(rows.attention.cxone_user_id).state).toBe("needs_attention");
      expect(stateOf(rows.unmarked.cxone_user_id).state).toBe("unmarked");

      // The header banner names all three, and its one action lands on the card.
      const banner = page.locator("#cxone-withdrawal-banner");
      await expect(banner).toBeVisible({ timeout: 15000 });
      await expect(banner).toContainText("3 Checkmarx One accounts need your decision.");
      await banner.locator('[data-action="cxone-withdrawals-review"]').click();
      await expect(page.locator("#admin-settings-tab")).toBeVisible();
      await expect(page.locator("#cxone-withdrawals-heading")).toBeFocused();
      const card = page.locator("#cxone-withdrawals-card");
      const entries = card.locator("#cxone-withdrawals-body tbody.cxone-wd-entry");
      await expect(entries).toHaveCount(3);
      const heldEntry = card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${rows.held.cxone_user_id}"]`);
      await expect(heldEntry.locator('[data-action="cxone-withdrawal-override"]')).toHaveCount(1);
      // CONTROL — Remove anyway is offered on the held row alone.
      await expect(card.locator('[data-action="cxone-withdrawal-override"]')).toHaveCount(1);
      // The unmarked row's first action reads "Schedule removal"; the other two keep Retry.
      const unmarkedEntry = card.locator(`tbody.cxone-wd-entry[data-cxone-user-id="${rows.unmarked.cxone_user_id}"]`);
      await expect(unmarkedEntry.locator('[data-action="cxone-withdrawal-retry"]')).toHaveText("Schedule removal");
      await expect(heldEntry.locator('[data-action="cxone-withdrawal-retry"]')).toHaveText("Retry");
      await expect(heldEntry).toContainText("kept past the 730-day retention period");
      // …and says WHICH sign held it, in the server's words.
      expect(stateOf(rows.held.cxone_user_id).held_signal_text, "precondition: the server names the sign").toEqual(expect.any(String));
      await expect(heldEntry.locator(".cxone-wd-found")).toHaveText(`What the platform found: ${stateOf(rows.held.cxone_user_id).held_signal_text}`);

      // The focus ring on the heading is an artefact of arriving from the banner.
      await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
      const vw = await widenUntilUnclipped(page, "#cxone-withdrawals-card .cxone-wd-scroll");
      // A card taller than the viewport is shot with the fixed header over its
      // top (the held entry's kept-past-retention line makes it taller than
      // 900px). Bring its top just below the header, grow the viewport until its
      // bottom fits too, and ASSERT both rather than trusting a height.
      const place = () => card.evaluate((el) => {
        const hb = document.querySelector("header").getBoundingClientRect().bottom;
        let s = el.parentElement;
        while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
        (s || document.scrollingElement).scrollTop += el.getBoundingClientRect().top - hb - 16;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, headerBottom: hb, vh: window.innerHeight };
      });
      let fit = await place();
      if (fit.bottom > fit.vh - 8) {
        await page.setViewportSize({ width: vw, height: Math.ceil(fit.bottom + 24) });
        await settle(page, 250);
        fit = await place();
      }
      expect(fit.top, `the card's top is under the header: ${JSON.stringify(fit)}`).toBeGreaterThanOrEqual(fit.headerBottom);
      expect(fit.bottom, `the card runs past the viewport: ${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.vh);
      await settle(page, 400);
      await card.screenshot({ path: shotPath("superadmin", "11-cxone-removals") });
      await page.setViewportSize({ width: 1280, height: 900 });
    } finally {
      const cleanDb = new Database(TEST_DB_PATH, { timeout: 5000 });
      try {
        cleanDb.prepare(`DELETE FROM cxone_realm_accounts WHERE cxone_user_id IN (${planted.map(() => "?").join(",")})`).run(...planted);
      } finally { cleanDb.close(); }
    }
  });

  // v8.17.0 — the Appearance page as a superadmin, with the Organisation
  // default section only that tier sees, and the platform certificate designer.
  test("12-appearance-org-default", async ({ page }) => {
    await loginAsSuperadmin(page);
    await page.locator("#profile-menu-btn").click();
    await page.locator("#profile-menu-overlay [data-action='open-appearance']").click();
    const ap = page.locator("#appearance-overlay");
    await ap.waitFor({ state: "visible", timeout: 10000 });
    const org = ap.locator(".ap-org");
    await expect(org.locator("#ap-org-look"), "the organisation default is offered").toBeVisible();
    await org.scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shotPath("superadmin", "12-appearance-org-default") });
  });

  test("13-certificate-designer", async ({ page }) => {
    await loginAsSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-settings-tab']").first().click();
    await require("./ui-admin-helpers").openSettingsSection(page, "branding");   // two panes
    const open = page.locator("[data-cw-open]");
    await open.waitFor({ state: "visible", timeout: 15000 });
    await open.click();
    const box = page.locator("#cert-config-body");
    await expect(box.locator(".cw-sec")).toHaveCount(5, { timeout: 15000 });
    await box.locator("#cw-img").waitFor({ state: "visible", timeout: 20000 });
    await page.evaluate(() => {
      const el = document.getElementById("cert-config-body");
      const hb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")) || 64;
      window.scrollBy(0, el.getBoundingClientRect().top - hb - 16);
    });
    await settle(page, 600);
    await page.screenshot({ path: shotPath("superadmin", "13-certificate-designer") });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v8.7.0 — EVENT ADMIN
//
// The guide for this role is about what is DIFFERENT, so the captures are too:
// the panel with two nav items missing, the events list holding one event, a
// challenge somebody else owns, and the analytics scope with no Global segment.
//
// It builds its OWN participant and its OWN competition rather than promoting a
// seeded one. `tests/isolated-test.js` asserts in an afterAll that alice, bob
// and carol still hold `role: 'participant'`, so promoting one here would fail
// the whole file — and the point of this role is a NARROW scope, which a seeded
// participant already enrolled in three fixtures cannot demonstrate.
//
// Every capture ASSERTS the state it is about before shooting (v8.3.22). A
// screenshot of an ordinary admin panel under a caption about a restricted one
// is worse than no screenshot.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("event-admin", () => {
  let ea = null;         // { id, email } — the organiser
  let evt = null;        // { id, name }  — the one event they organise
  let decoy = null;      // { id, name }  — an event they must NOT see
  let ownTask = null;    // a challenge THEY created
  let otherTask = null;  // one the superadmin created, used by their event
  let dual = null;       // v8.8.6 — a participant in BOTH events, for the scope capture
  const EA_PASS = "testpass123";

  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = Date.now();

    const mk = async (name, offsetMin) => {
      const r = await api.post("/api/admin/competitions", { headers: h, data: {
        name, start_time: new Date(Date.now() - offsetMin * 60_000).toISOString(),
        duration_minutes: 600, event_kind: "tournament",
      }});
      if (!r.ok()) throw new Error(`shots: could not create ${name}: ${r.status()} ${await r.text()}`);
      return { id: (await r.json()).competition.id, name };
    };
    evt = await mk(`Berlin Booth ${stamp}`, 1);
    decoy = await mk(`Munich Track ${stamp}`, 1);

    // The organiser, registered like any participant then promoted per event.
    const email = `organiser-${stamp}@acme.com`;
    const anon = await request.newContext({ baseURL: BASE });
    const acsrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", { headers: { "x-csrf-token": acsrf, "content-type": "application/json" }, data: {
      email, password: EA_PASS, nickname: `organiser${stamp % 100000}`,
      firstName: "Rita", lastName: "Okonkwo", company: "Acme", title: "Engineer",
      country: "GB", timezone: "Europe/London",
    }});
    if (!reg.ok()) throw new Error(`shots: could not register the organiser: ${reg.status()} ${await reg.text()}`);
    await anon.dispose();

    const parts = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants || [];
    const row = parts.find(p => p.email === email);
    if (!row) throw new Error("shots: the organiser was not found after registering");
    await api.post(`/api/admin/participants/${row.id}/verify`, { headers: h });
    await api.post(`/api/admin/participants/${row.id}/approve`, { headers: h });
    const g = await api.post(`/api/admin/competitions/${evt.id}/admins`, { headers: h, data: { userId: row.id } });
    if (!g.ok()) throw new Error(`shots: could not grant the event-admin role: ${g.status()} ${await g.text()}`);
    ea = { id: row.id, email };

    // A challenge the superadmin owns, used by the organiser's event — the row
    // that must render WITHOUT Edit in the kebab.
    const t1 = await api.post("/api/admin/tasks", { headers: h, data: {
      title: `Shared: SQL injection basics ${stamp}`, description: "Find the injectable parameter.",
      difficulty: "easy", answer_type: "text", correct_answer: "id", status: "published",
    }});
    otherTask = { id: (await t1.json()).id };

    // v8.8.6 — a participant enrolled in BOTH events, so the impersonation capture
    // shows a NARROWED list rather than a short one. With a single-event target the
    // picture would be identical before and after the change, and the guide's
    // sentence would be its own only evidence.
    {
      const demail = `dual-${stamp}@acme.com`;
      const anon2 = await request.newContext({ baseURL: BASE });
      const dcsrf = (await (await anon2.get("/api/csrf-token")).json()).csrfToken;
      const dreg = await registerPost(anon2, "/api/register", { headers: { "x-csrf-token": dcsrf, "content-type": "application/json" }, data: {
        firstName: "Priya", lastName: "Raman", nickname: `priya${stamp}`, email: demail, password: EA_PASS,
        company: "Acme", title: "Engineer", country: "DE", timezone: "Europe/Berlin",
      } });
      if (!dreg.ok()) throw new Error(`shots: could not register the dual participant: ${dreg.status()} ${await dreg.text()}`);
      await anon2.dispose();
      const ps = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants || [];
      const drow = ps.find(x => x.email === demail);
      if (!drow) throw new Error("shots: the dual participant is not in the admin list");
      await api.post(`/api/admin/participants/${drow.id}/verify`, { headers: h });
      await api.post(`/api/admin/participants/${drow.id}/approve`, { headers: h });
      // The assign endpoint SKIPS an ineligible user and still answers 200, so a
      // lost enrolment would be invisible in the response (fixture checklist #7).
      for (const cid of [evt.id, decoy.id]) {
        const as = await api.post("/api/admin/competitions/assign", { headers: h, data: { competitionIds: [cid], userIds: [drow.id] } });
        if (!as.ok()) throw new Error(`shots: assign to ${cid}: ${as.status()} ${await as.text()}`);
        const body = await as.json();
        if (body.assigned !== 1) throw new Error(`shots: assign to ${cid} skipped the participant (assigned=${body.assigned})`);
      }
      dual = { id: drow.id, email: demail, name: "Priya Raman" };
    }
    await api.post(`/api/admin/tasks/${otherTask.id}/competitions`, { headers: h, data: { competitionIds: [evt.id] } });
    await api.dispose();

    // …and one the ORGANISER creates, which they may edit. Created as them, so
    // `created_by_id` is genuinely theirs rather than back-filled.
    const eaCtx = await request.newContext({ baseURL: BASE });
    const ec0 = (await (await eaCtx.get("/api/csrf-token")).json()).csrfToken;
    const li = await codeLogin(eaCtx, email, { "x-csrf-token": ec0, "content-type": "application/json" }, { password: EA_PASS });
    if (!li.ok()) throw new Error(`shots: the organiser could not sign in: ${li.status()}`);
    // RE-FETCH after the login. `POST /api/login` regenerates the session, so the
    // token minted against the anonymous one is dead — reusing it answers
    // `403 csrf_invalid`, which reads as a permission problem and is not one.
    const ec = (await (await eaCtx.get("/api/csrf-token")).json()).csrfToken;
    const t2 = await eaCtx.post("/api/admin/tasks", { headers: { "x-csrf-token": ec, "content-type": "application/json" }, data: {
      title: `Mine: XSS in the search box ${stamp}`, description: "Reflected, unescaped.",
      difficulty: "medium", answer_type: "text", correct_answer: "x", status: "published",
    }});
    if (!t2.ok()) throw new Error(`shots: the organiser could not create a challenge: ${t2.status()} ${await t2.text()}`);
    ownTask = { id: (await t2.json()).id };
    await eaCtx.post(`/api/admin/tasks/${ownTask.id}/competitions`, { headers: { "x-csrf-token": ec, "content-type": "application/json" }, data: { competitionIds: [evt.id] } });
    await eaCtx.dispose();
  });

  async function openAsEventAdmin(page, tabName) {
    await page.goto("/");
    await loginViaApi(page, ea.email, EA_PASS);
    await page.goto("/");
    // Wait for a nav BUTTON, not #main-nav: the shell ships that element
    // statically, so it is attached before boot has resolved who we are (v8.3.33).
    await page.locator("button.admin-nav-item").first().waitFor({ state: "visible", timeout: 15000 });
    if (tabName) await page.locator(_tabSel(tabName)).first().click();
    await settle(page, 500);
  }

  test("01 — the panel an event admin sees", async ({ page }) => {
    await openAsEventAdmin(page, "Events");
    // The two absences ARE the picture. Assert them, or this is a screenshot of
    // an ordinary admin panel under a caption about a restricted one.
    await expect(page.locator("li:has(> button.admin-nav-item[data-tab-id='admin-users-tab'])")).toBeHidden();
    await expect(page.locator("li:has(> button.admin-nav-item[data-tab-id='admin-settings-tab'])")).toBeHidden();
    await expect(page.locator("#admin-panel-title")).toHaveText(/Event Admin Panel/);
    await expect(page.locator("#new-competition-btn")).toBeHidden();
    // Their event is listed; the decoy is not.
    await expect(page.locator("#admin-comp-body")).toContainText(evt.name);
    await expect(page.locator("#admin-comp-body")).not.toContainText(decoy.name);
    await page.screenshot({ path: shotPath("event-admin", "01-panel") });
  });

  test("02 — a challenge somebody else owns", async ({ page }) => {
    await openAsEventAdmin(page, "Challenges");
    if (await page.locator("#task-search").count()) { await narrowChallengesTable(page, "Shared:"); await settle(page, 700); }
    const row = page.locator("#admin-task-body tr", { hasText: "Shared:" }).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.locator(".kebab-btn").first().click();
    const portal = page.locator("#kebab-portal");
    await portal.waitFor({ state: "visible", timeout: 5000 });
    // The claim the caption makes: no Edit, and the absence is explained.
    await expect(portal.locator("button:has-text('Edit')")).toHaveCount(0);
    await expect(portal).toContainText(/created by someone else/i);
    await settle(page, 300);
    await page.screenshot({ path: shotPath("event-admin", "02-challenge-not-mine") });
    await page.keyboard.press("Escape").catch(() => {});
  });

  test("03 — analytics has no platform-wide scope", async ({ page }) => {
    await openAsEventAdmin(page, "Analytics");
    await settle(page, 800);
    // The prompt is the entry state, and its platform-wide action is the one
    // control that must be absent for this tier.
    await expect(page.locator("[data-action='analytics-set-scope'][data-value='global']")).toHaveCount(0);
    await expect(page.locator("[data-action='analytics-set-scope'][data-value='competition']").first()).toBeVisible();
    await page.screenshot({ path: shotPath("event-admin", "03-analytics-scope") });
  });

  test("04 — the role, and which events it covers", async ({ page }) => {
    // Viewed as the SUPERADMIN, whose participants list is unrestricted — this
    // is the operator's "admins must be able to see WHICH events" requirement.
    // The people list starts with six columns and Role is not one of them
    // (Columns adds it), so the capture chooses the columns this picture is about.
    await page.addInitScript(() => {
      try { localStorage.setItem("ha:p-cols", JSON.stringify(["participant", "email", "role", "events", "status", "actions"])); } catch (_) { /* no storage */ }
    });
    await page.goto("/");
    await loginViaApi(page, "superadmin", getSuperadminPass());
    await page.goto("/");
    await page.locator("button.admin-nav-item").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    if (await page.locator("#participants-search").count()) { await narrowPeopleTable(page, "Okonkwo"); await settle(page, 700); }
    const row = page.locator("#admin-participants-body tr", { hasText: "Okonkwo" }).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await expect(row).toContainText("Event admin");
    // v8.8.7 — ASSERT THE BADGE, not merely the name. The row also carries an
    // events column, so "the name appears" is satisfied by a build that renders
    // the role cell as plain text again — which is what this picture is about.
    const roleCell = row.locator("td:has(> .role-badge)");
    await expect(roleCell.locator(".comp-badge")).toHaveCount(1);
    await expect(roleCell.locator(".comp-badge")).toHaveText(evt.name);

    // v8.8.7 — SCROLL THE ROLE COLUMN INTO FRAME BEFORE SHOOTING. The
    // participants table has 22 columns and Role is the 15th, so the previous
    // clip — x:0, width:1280 at the row's y — shipped a picture of Participant
    // through Registered and none of its own subject. The assertions above
    // passed throughout, because a locator resolves off-screen: *a picture that
    // does not show what its caption is about is worse than no picture*
    // (v8.3.21).
    //
    // Widening the viewport cannot help here — 22 columns do not fit at any
    // readable width — so the table's own scroller is moved instead, which also
    // frames the Events column beside Role, the comparison the guide draws.
    const scroller = page.locator("#admin-participants-body").locator("xpath=ancestor::div[contains(@class,'table-card')][1]");
    const roleTh = page.locator('th[data-col="role"]');
    await scroller.evaluate((el, thSel) => {
      const th = document.querySelector(thSel);
      el.scrollLeft = Math.max(0, th.offsetLeft - 24);
    }, 'th[data-col="role"]');
    await settle(page, 400);

    // ASSERT THE FRAME, not merely the element. Both boxes must be inside the
    // clip, or this capture silently goes back to shooting the wrong columns.
    const thBox = await roleTh.boundingBox();
    const cellBox = await roleCell.boundingBox();
    const clip = { x: 0, y: Math.max(0, thBox.y - 16), width: 1280, height: (cellBox.y + cellBox.height + 24) - Math.max(0, thBox.y - 16) };
    if (!(thBox.x >= 0 && thBox.x + thBox.width <= clip.width))
      throw new Error(`shots: the Role header is not in frame (x=${thBox.x} w=${thBox.width}, clip w=${clip.width})`);
    if (!(cellBox.x >= 0 && cellBox.x + cellBox.width <= clip.width))
      throw new Error(`shots: the Role cell is not in frame (x=${cellBox.x} w=${cellBox.width})`);
    await settle(page, 200);
    await page.screenshot({ path: shotPath("event-admin", "04-role-badge"), clip });
  });

  // v8.8.6 — the impersonated view, narrowed to the organiser's own events.
  test("05-impersonation-scope", async ({ page }) => {
    await page.goto("/");
    await loginViaApi(page, ea.email, EA_PASS);
    // Enter impersonation over the API: the kebab route is captured already in
    // admin/30, and what this picture is about is the RESULT, not the control.
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const imp = await page.request.post(`/api/admin/participants/${dual.id}/impersonate`, { headers: { "x-csrf-token": csrf } });
    if (!imp.ok()) throw new Error(`shots: impersonate: ${imp.status()} ${await imp.text()}`);
    await page.goto("/");
    await page.locator("#comp-grid").waitFor({ state: "visible", timeout: 20000 });

    // ASSERT THE STATE BEFORE SHOOTING. The narrowing is the entire subject, and
    // it cannot occur in the seed — without this the caption would be the only
    // evidence the picture shows anything at all.
    await expect(page.locator("#comp-grid")).toContainText(evt.name, { timeout: 15000 });
    await expect(page.locator("#comp-grid")).not.toContainText(decoy.name);
    await expect(page.locator(".impersonation-banner")).toBeVisible();
    await settle(page, 400);
    await page.screenshot({ path: shotPath("event-admin", "05-impersonation-scope") });
  });

  // v8.13.7 — the Invite dialog for an organiser with exactly ONE event that can
  // take people: it is ticked for them, its box disabled, marked Always included.
  // The organiser manages `evt` (live) and nothing else, and competes nowhere, so
  // the fixture already is that state — ASSERTED before shooting, or the guide's
  // caption is the only evidence the picture shows a locked row rather than an
  // ordinary ticked one (a global admin's dialog looks the same at a glance).
  test("06-invite-one-event", async ({ page }) => {
    await openAsEventAdmin(page, "Participants");
    const open = page.locator("[data-action='open-invite-dialog']").first();
    await open.waitFor({ state: "visible", timeout: 10000 });
    await open.click();
    const overlay = page.locator("#invite-overlay");
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(overlay).toHaveAttribute("data-require-event", "1");
    const boxes = overlay.locator(".invite-comp-cb");
    await expect(boxes).toHaveCount(1);
    await expect(boxes.first()).toHaveValue(evt.id);
    await expect(boxes.first()).toBeChecked();
    await expect(boxes.first()).toBeDisabled();
    const locked = overlay.locator("label.picker-row.is-locked");
    await expect(locked).toHaveCount(1);
    await expect(locked).toContainText(evt.name);
    await expect(locked.locator(".picker-row-flag.is-on")).toHaveText("Always included");
    await expect(overlay.locator("label.picker-row.is-disabled")).toHaveCount(0);
    await expect(overlay.locator("#invite-comp-locked-note")).toBeVisible();
    await expect(overlay.locator("#invite-comp-none")).toHaveCount(0);
    await expect(overlay).not.toContainText(decoy.name);
    await expect(page.locator("#invite-submit-btn")).toBeEnabled();
    // Two example addresses, so the shot reads as a dialog in use.
    await page.locator("#invite-emails").fill("sam.lee@acme.com\njordan.park@acme.com");
    // The groups box fills asynchronously; shoot its settled state, not "Loading".
    await expect(overlay.locator("#invite-group-list")).not.toContainText("Loading groups");
    await settle(page, 400);
    await page.screenshot({ path: shotPath("event-admin", "06-invite-one-event") });
    await overlay.locator("[data-action='overlay-close']").first().click().catch(() => {});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANIFEST writer — runs after every test in this file. Records the version
// the screenshots were captured against so a stale set is visible at a glance.
// ═══════════════════════════════════════════════════════════════════════════════
// v8.6.6 — THE MANIFEST USED TO LAUNDER FAILURES, AND THAT IS WHY IT NEEDED
// FIXING RATHER THAN DOCUMENTING. `counts` is a `readdirSync` of what is ON
// DISK, not of what this run actually captured — so with `RETRIES=0` a failed
// capture leaves the PREVIOUS run's PNG in place and the manifest still wrote a
// FULL count stamped with the CURRENT version. A reader then concludes the whole
// set is current at that version. Measured at v8.6.5: it claimed 20/55/8 at
// 8.6.5 while ten files had been regenerated and three captures could not be.
//
// `counts` keeps its meaning (what exists) and gains `regenerated`, which is
// what THIS pass wrote, by mtime — no per-call-site bookkeeping, so it cannot
// drift from the 83 `shotPath` uses. Each theme updates only its own entry, or
// the dark pass would erase the light pass's record. Comparing the two numbers
// is what makes a partial run visible.
test.afterAll(async () => {
  const version = require("../version.json").version;
  const manifestPath = path.join(SHOTS_DIR, "MANIFEST.json");
  const counts = { light: {}, dark: {} };
  const wroteNow = {};
  for (const role of ["participant", "admin", "event-admin", "superadmin"]) {
    const dir = path.join(SHOTS_DIR, role);
    const pngs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".png")) : [];
    const isDark = f => f.endsWith(".dark.png");
    counts.light[role] = pngs.filter(f => !isDark(f)).length;
    counts.dark[role]  = pngs.filter(isDark).length;
    const fresh = pngs.filter(f => {
      try { return fs.statSync(path.join(dir, f)).mtimeMs >= RUN_STARTED_AT; } catch { return false; }
    });
    wroteNow[role] = fresh.filter(f => (THEME === "dark" ? isDark(f) : !isDark(f))).length;
  }
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* first run */ }
  const regenerated = { light: {}, dark: {}, ...(prev.regenerated || {}) };
  regenerated[THEME] = { at: new Date().toISOString(), ...wroteNow };
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    version,
    regenerated_at: new Date().toISOString(),
    last_theme: THEME,
    counts,
    regenerated,
  }, null, 2) + "\n");
});
