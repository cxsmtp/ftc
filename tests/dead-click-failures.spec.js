// @ts-check
//
// v7.23.0 (audit Wave 0) — a failed request must never present as "nothing
// happened" or, worse, as a confident statement about the data.
//
// Three sites, one class. All are reachable with NO server fault at all: the
// per-IP limiters 429 a whole venue behind one NAT egress address (v7.15.34),
// which is exactly when a roomful of people are tapping at once.
//
//   1. openTask()                     — `if(!r.ok)return;`  Tapping a challenge
//                                       did literally nothing. No message, no
//                                       spinner, no state change.
//   2. loadAdminTasks()               — `.then(r=>r.json()).catch(()=>[])` with
//                                       no r.ok check. On a 500 the error body
//                                       parses to `{error:...}`, a NON-ARRAY, so
//                                       the render threw and the skeleton rows
//                                       animated for ever. This tab has no poll
//                                       to self-heal.
//   3. openAddTasksToCompetition()    — same pattern, but it then reported
//                                       "No more published challenges to add."
//                                       — a WRONG ANSWER about the data from a
//                                       request that failed.
//
// Every test here drives the real failure by intercepting the route, and each
// carries a positive control so "it showed an error" cannot be satisfied by a
// surface that is simply broken.
const { test, expect } = require("./isolated-test");
const { narrowEventsTable } = require("./ui-admin-helpers"); // v9.2.5 — the one way to type into the admin search boxes
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });
const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

async function saCtx() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function ownParticipantInLiveComp(page) {
  const { api, csrf } = await saCtx();
  const email = `deadclick-${Date.now().toString(36)}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: { firstName: "Dead", lastName: "Click", nickname: `dc_${Date.now().toString(36)}`, email,
            company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
            password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" },
  });
  expect(reg.status(), await reg.text()).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find((p) => p.email === email);
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });

  const comp = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `DeadClick ${Date.now()}`, start_time: new Date(Date.now() - 36e5).toISOString(),
            duration_minutes: 600, timezone: "UTC" },
  });
  const compId = (await comp.json()).competition.id;
  const task = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `DeadClick Task ${Date.now()}`, description: "<p>d</p>", difficulty: "easy",
            answer_type: "text", correct_answer: "yes", explanation: "<p>e</p>", status: "published" },
  });
  const taskId = (await task.json()).id;
  await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [String(compId)] } });
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [String(compId)] },
  });
  expect((await asg.json()).assigned, "the participant must actually be assigned").toBe(1);

  const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, email, H(tok));
  expect(li.ok(), `participant login: ${li.status()}`).toBeTruthy();
  const tok2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/select-competition", { headers: H(tok2), data: { competitionId: compId } });
  await api.dispose();
  return { compId, taskId };
}

test("v7.23.0: opening a challenge reports a failure instead of doing nothing", async ({ page }) => {
  await ownParticipantInLiveComp(page);
  await page.goto("/");
  const card = page.locator(".task-card").first();
  await card.waitFor({ state: "visible", timeout: 20000 });

  // POSITIVE CONTROL — the click works when the server is healthy, so a later
  // failure cannot be blamed on the card simply not being clickable.
  await card.click();
  await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 15000 });
  await page.goBack().catch(() => {});
  await page.goto("/");
  await card.waitFor({ state: "visible", timeout: 20000 });

  // Now make every GET /api/tasks/:id fail definitively. fetchTransientRetry
  // makes 3 attempts on a 5xx, so the route must answer consistently.
  await page.route(/\/api\/tasks\/[^/?]+$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
      : route.continue());

  await card.click();

  // The guarantee: the participant is TOLD. Before the fix this produced no
  // toast, no detail view and no state change whatsoever.
  const toast = page.locator(".toast");
  await expect(toast.first(), "a failed challenge-open must surface a message").toBeVisible({ timeout: 15000 });
  const txt = (await toast.first().innerText()) || "";
  expect(txt.trim().length, "the message must not be empty").toBeGreaterThan(0);
});

test("v7.23.0: a failed challenge-list load clears the skeletons and says so", async ({ page }) => {
  const { api, csrf } = await saCtx();
  const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/login", { headers: H(tok), data: { email: "superadmin", password: getSuperadminPass() } });

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.route("**/api/admin/tasks", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
      : route.continue());

  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  const ham = page.locator("#admin-mobile-menu-btn");
  if (await ham.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await ham.click();
  await page.locator("button.admin-nav-item[data-tab-id='admin-tasks-tab']").first().evaluate((el) => el.click());
  await page.locator("#admin-tasks-tab").waitFor({ state: "visible", timeout: 15000 });

  // 1. no skeleton may still be animating once the load has settled.
  await expect
    .poll(() => page.locator("#admin-task-body .skeleton-row").count(), { timeout: 15000 })
    .toBe(0);

  // 2. the operator is told, in the table itself.
  await expect(page.locator("#admin-task-body"), "the failed load must be stated in the table")
    .toContainText(/could not load/i, { timeout: 10000 });

  // 3. and the render must not have THROWN — the non-array body used to produce
  //    "S.adminTasksData is not iterable", which is what stranded the skeletons.
  expect(errors.filter((e) => /not iterable|is not a function/i.test(e)),
    `render threw on the error body: ${errors.join(" | ")}`).toEqual([]);
  await api.dispose();
});

test("v7.23.0: a failed load must not claim there are no challenges to add", async ({ page }) => {
  // The wrong-answer case: openAddTasksToCompetition() reported
  // "No more published challenges to add." whenever the fetch failed.
  const { api, csrf } = await saCtx();
  const comp = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `AddFail ${Date.now()}`, start_time: new Date(Date.now() + 36e5).toISOString(),
            duration_minutes: 120, timezone: "UTC" },
  });
  const compId = (await comp.json()).competition?.id;
  expect(compId, "fixture competition must be created").toBeTruthy();

  const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/login", { headers: H(tok), data: { email: "superadmin", password: getSuperadminPass() } });
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  const ham = page.locator("#admin-mobile-menu-btn");
  if (await ham.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await ham.click();
  await page.locator("button.admin-nav-item[data-tab-id=\"admin-competitions-tab\"]").first().evaluate((el) => el.click());
  await page.locator("#admin-comp-body tr").first().waitFor({ state: "visible", timeout: 20000 });

  // Focus our own competition (narrow first — the table paginates at 30 and the
  // worker DB accumulates; v7.15.29 / v7.17.2).
  await narrowEventsTable(page, "AddFail");
  await page.waitForTimeout(400);
  await page.locator("#admin-comp-body tr").first().locator("[data-action='comp-open']").first().click();
  await page.locator("#admin-scope-banner").waitFor({ state: "visible", timeout: 15000 });

  // Go to Challenges FIRST, with the server healthy: `#add-tasks-to-comp-btn`
  // is rendered by the challenges pane, and it only appears when a competition
  // is focused AND nothing is selected (v7.12.2). Installing the failure before
  // this point would break the very load that paints the button.
  // The event workspace's OWN Challenges section keeps the event open; the
  // sidebar's Challenges is the cross-event library and closes the workspace.
  await page.locator('#ws-tabs [data-section="admin-tasks-tab"]').first().evaluate((el) => el.click());
  const addBtn = page.locator("#add-tasks-to-comp-btn");
  await addBtn.waitFor({ state: "visible", timeout: 20000 });

  // NOW break it — this is the real-world shape: the pane loaded, the operator
  // clicks, and the second request is the one that fails.
  await page.route("**/api/admin/tasks", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) })
      : route.continue());

  await addBtn.click();

  const toast = page.locator(".toast");
  await expect(toast.first(), "a failed load must surface a message").toBeVisible({ timeout: 15000 });
  const txt = ((await toast.first().innerText()) || "").toLowerCase();
  // THE point of this test: it must not make a claim about the data.
  expect(txt, `toast said: ${txt}`).not.toContain("no more published challenges");
  expect(txt).toMatch(/could not load|try again/);
  await api.dispose();
});
