"use strict";

// THE OVERVIEW'S OPERATIONAL STATES, BY CONTENT (public/js/features/event-workspace.js).
//
// Each arm asserts what a state SAYS, beside a control that it said something
// else first or for a sibling fixture:
//   • "Ready to start?" and the Challenges tile count scoring challenges only
//     (a qualifying question scores nothing) and claim nothing about challenges
//     no pulse has read (a failed read is a failure with Try again);
//   • a qualifying question's facts say it scores no points, and "Answered by"
//     counts people who answered it, never one who opened and left it;
//   • the live attention row names what needs the organiser, says "Nothing needs
//     you right now" only when nothing does, and after a failed refresh says the
//     figures are stale (never "Nothing needs you" over stale figures);
//   • the live parts are re-read only while the Overview is on screen;
//   • the ended certificates card: "being issued", then the count once issued
//     (re-read while issuing), "none issued", and a failed read with Try again
//     that is never kept;
//   • the certificate design of an ended event is read-only for an admin who is
//     not a superadmin, with the reason (the routes' end lock);
//   • the clone dialog refuses a start inside the hour the clocks skip;
//   • a role that may add organisers but not search people is told so.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const { adminLogin, openOverviewDetail, loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const STAMP = Date.now().toString(36);
const DAY = 86_400_000;

async function createEvent(api, csrf, data) {
  const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: { name: `WsO ${STAMP} ${Math.random().toString(36).slice(2, 7)}`, ...data } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).competition;
}

async function openWs(page, ev, tab) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n, t }) => window.openEventWorkspace(id, n, t ? { tab: t } : {}), { id: ev.id, n: ev.name, t: tab || null });
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 10000 });
}

// One participant answers `taskId` (right or wrong) in a live event.
async function answer(p, compId, taskId, ans) {
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
    const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf), data: { answer: ans, gradingHash: await gradingHashFor(s.api, taskId) } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  } finally { await s.api.dispose(); }
}

const pulseUrl = (id) => `**/api/admin/competitions/${id}/overview-pulse`;

test("Ready to start? counts scoring challenges only and claims nothing it has not read; a quick question scores no points", async ({ page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let onlyQ, withOne, scoring;
  try {
    onlyQ = await createEvent(sa.api, sa.csrf, { event_kind: "booth", add_qualifying: true, start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 });
    withOne = await createEvent(sa.api, sa.csrf, { event_kind: "booth", add_qualifying: true, start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 });
    scoring = await makeTask(sa.api, sa.csrf, "wsoscore");
    await assignTask(sa.api, sa.csrf, scoring.id, [withOne.id]);
  } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);

  // Only the four quick questions: no challenge to play yet.
  await openWs(page, onlyQ);
  const ready = page.locator("#ws-ov-ready");
  await expect(ready).toContainText("No questions yet", { timeout: 15000 });
  await expect(ready, "never 'published' for questions that score nothing").not.toContainText("published");
  await expect(page.locator('[data-kpi-tile="tasks"] .ws-kpi-sub')).toHaveText("none yet");

  // The other event, opened while its pulse read fails: nothing is claimed.
  await page.route(pulseUrl(withOne.id), (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await openWs(page, withOne);
  await expect(ready).toContainText("Could not check the questions", { timeout: 15000 });
  await expect(ready, "no 'published' claim without a read").not.toContainText("published");
  await expect(page.locator('[data-kpi-tile="tasks"] .ws-kpi-sub'), "nor in the tile").not.toHaveText("all published");
  await page.unroute(pulseUrl(withOne.id));
  await ready.locator('[data-action="ws-pulse-retry"]').click();
  // CONTROL: read, the one scoring challenge counts and the four questions do not.
  await expect(ready).toContainText("1 question published", { timeout: 15000 });
  await expect(page.locator('[data-kpi-tile="tasks"] .ws-kpi-sub')).toHaveText("all published");
  await expect(page.locator('[data-kpi-tile="tasks"] .ws-count')).toHaveAttribute("data-count", "1");

  // A quick question's facts: no points. A scoring challenge's: its points.
  await openOverviewDetail(page);
  const qRow = page.locator('#ws-ov-tasks [data-action="ws-task-facts"]').filter({ hasText: "How many developers" });
  await expect(qRow, "PRECONDITION: the question is listed").toBeVisible({ timeout: 15000 });
  await qRow.click();
  const qFacts = page.locator(`#${await qRow.getAttribute("aria-controls")}`);
  await expect(qFacts).toContainText("0 — a quick question scores no points");
  await expect(qFacts).not.toContainText("50");
  const sRow = page.locator('#ws-ov-tasks [data-action="ws-task-facts"]').filter({ hasText: scoring.title });
  await sRow.click();
  const sFacts = page.locator(`#${await sRow.getAttribute("aria-controls")}`);
  await expect(sFacts.locator("div").filter({ hasText: "Points" }), "CONTROL: an easy challenge's points").toContainText("50");
});

test("a quick question's 'Answered by' counts who answered it, not who opened it and left", async ({ page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev, qd, answerer, leaver;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "booth", add_qualifying: true, start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 120 });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      qd = db.prepare(`SELECT t.id, t.title, t.choices FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
        JOIN task_tags g ON g.task_id=t.id AND g.tag='qualifying:developers' WHERE ct.competition_id=?`).get(ev.id);
    } finally { db.close(); }
    expect(qd, "PRECONDITION: the event holds the developers question").toBeTruthy();
    answerer = await makeParticipant(sa.api, sa.csrf, "wsoqans");
    leaver = await makeParticipant(sa.api, sa.csrf, "wsoqleave");
    await enrol(sa.api, sa.csrf, ev.id, [answerer.id, leaver.id]);
    const r = await answer(answerer, ev.id, qd.id, JSON.stringify([JSON.parse(qd.choices)[0].id]));
    expect(r.correct, "PRECONDITION: a quick question accepts any option").toBe(true);
    // The other opens the question and leaves it without answering.
    const sl = await apiLogin(leaver.email, PARTICIPANT_PASS);
    try {
      expect((await sl.api.post("/api/select-competition", { headers: H(sl.csrf), data: { competitionId: ev.id } })).ok()).toBeTruthy();
      expect((await sl.api.get(`/api/tasks/${qd.id}`, { headers: { "x-competition-id": ev.id } })).ok()).toBeTruthy();
      const nav = await sl.api.post(`/api/tasks/${qd.id}/navigated-away`, { headers: H(sl.csrf), data: { via: "spa_nav" } });
      expect(nav.ok(), `navigated-away: ${await nav.text()}`).toBeTruthy();
    } finally { await sl.api.dispose(); }
    // Both are recorded (post-commit): one answer and one leave on the question.
    await expect.poll(async () => {
      const d = await (await sa.api.get(`/api/admin/competitions/${ev.id}/overview-pulse`)).json();
      const row = (d.tasks || []).find(t => t.id === qd.id) || {};
      return [row.attempters, row.answerers];
    }, { timeout: 15000, message: "the pulse: two people touched it, one answered" }).toEqual([2, 1]);
  } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, ev);
  await openOverviewDetail(page);
  const qRow = page.locator(`#ws-ov-tasks [data-action="ws-task-facts"][data-task-id="${qd.id}"]`);
  await expect(qRow, "PRECONDITION: the question is listed").toBeVisible({ timeout: 15000 });
  await qRow.click();
  const facts = page.locator(`#${await qRow.getAttribute("aria-controls")}`);
  const answeredBy = facts.locator("div").filter({ has: page.locator("dt", { hasText: "Answered by" }) }).locator("dd");
  await expect(answeredBy, "the one who answered, not the one who left").toHaveText("1", { timeout: 15000 });
});

test("the live attention row: what needs you, then 'Nothing needs you'; a failed refresh says so; the reads stop off the Overview", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let ev, t1, t2, p;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
    t1 = await makeTask(sa.api, sa.csrf, "wsoattn1", { correct_answer: "right" });
    t2 = await makeTask(sa.api, sa.csrf, "wsoattn2", { correct_answer: "right" });
    Object.assign(t1, { bankId: t1.id, id: (await assignTask(sa.api, sa.csrf, t1.id, [ev.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
    Object.assign(t2, { bankId: t2.id, id: (await assignTask(sa.api, sa.csrf, t2.id, [ev.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
    const hide = await sa.api.patch(`/api/admin/tasks/${t2.id}/visibility`, { headers: H(sa.csrf), data: { active: false } });
    expect(hide.ok(), `hide: ${await hide.text()}`).toBeTruthy();
    p = await makeParticipant(sa.api, sa.csrf, "wsoattnp");
    await enrol(sa.api, sa.csrf, ev.id, [p.id]);
  } finally { await sa.api.dispose(); }
  // Somebody tried the visible challenge and got it wrong.
  expect((await answer(p, ev.id, t1.id, "wrong")).correct).toBe(false);

  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, ev);
  const attn = page.locator("#ws-ov-attn");
  await expect(attn).toContainText("1 question is not visible to participants.", { timeout: 20000 });
  await expect(attn).toContainText("Nobody has solved this question yet:");
  await expect(attn).toContainText(t1.title);
  await expect(attn.locator(".ws-allclear"), "nothing is all clear while two things need the organiser").toHaveCount(0);

  // Both fixed: the hidden challenge shown, the stuck one solved.
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const vis = await page.request.patch(`/api/admin/tasks/${t2.id}/visibility`, { headers: H(csrf), data: { active: true } });
  expect(vis.ok(), await vis.text()).toBeTruthy();
  expect((await answer(p, ev.id, t1.id, "right")).correct).toBe(true);
  await page.evaluate(() => window.refreshOverviewLive());
  await expect(attn.locator(".ws-allclear")).toHaveText("Nothing needs you right now.", { timeout: 15000 });
  await expect(attn).not.toContainText("not visible to participants");

  // The next refresh fails: the row says the figures are old, and never "Nothing needs you".
  await page.route(pulseUrl(ev.id), (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await page.evaluate(() => window.refreshOverviewLive());
  const stale = attn.locator(".ws-attn-stale");
  await expect(stale).toContainText("Could not refresh just now.", { timeout: 15000 });
  await expect(attn.locator(".ws-allclear"), "no all-clear over stale figures").toHaveCount(0);
  // A live figure (Joined is the roster, from the events model, so it cannot
  // witness this): the wrong answer and the right one.
  await expect(page.locator('[data-kpi-tile="answers"] .ws-count'), "the last live figures stay on screen").toHaveAttribute("data-count", "2");
  await page.unroute(pulseUrl(ev.id));
  await stale.locator('[data-action="ws-pulse-retry"]').click();
  await expect(stale, "a good read clears the notice").toHaveCount(0, { timeout: 15000 });
  await expect(attn.locator(".ws-allclear")).toBeVisible();

  // The live parts are read only while the Overview is the section on screen.
  let reads = 0;
  await page.route(pulseUrl(ev.id), (route) => { reads++; return route.continue(); });
  await page.evaluate(() => window.wsTab("admin-rankings-tab"));
  await expect(page.locator("#admin-rankings-tab")).toBeVisible();
  await page.evaluate(() => window.refreshOverviewLive());
  expect(reads, "off the Overview, the poll reads nothing").toBe(0);
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await expect.poll(() => reads, { timeout: 10000, message: "CONTROL: back on the Overview it reads" }).toBeGreaterThan(0);
  const before = reads;
  await page.evaluate(() => window.refreshOverviewLive());
  expect(reads, "and the poll reads again").toBeGreaterThan(before);
});

// What the card says of an event that ended before this server's automatic-issue floor.
const NONE_BEFORE_FLOOR = "No certificates issued: this event ended before certificates were issued automatically, so participants collect their own from the event.";

test("the ended certificates card: being issued, then the count; none issued; a failed read offers Try again and is never kept", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let ev, old, t, p;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
    t = await makeTask(sa.api, sa.csrf, "wsocert", { correct_answer: "right" });
    const spare = await makeTask(sa.api, sa.csrf, "wsocerts", { correct_answer: "right" });
    await assignTask(sa.api, sa.csrf, t.id, [ev.id]);
    await assignTask(sa.api, sa.csrf, spare.id, [ev.id]);
    p = await makeParticipant(sa.api, sa.csrf, "wsocertp");
    await enrol(sa.api, sa.csrf, ev.id, [p.id]);
    old = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 });
  } finally { await sa.api.dispose(); }
  expect((await answer(p, ev.id, t.id, "right")).correct).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const end = await page.request.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(csrf), data: {} });
  expect(end.ok(), await end.text()).toBeTruthy();
  await page.evaluate(() => window.loadAdminCompetitions());
  await openWs(page, ev);
  const card = page.locator("#ws-ov-certs");
  await expect(card).toContainText("Being issued: they go out a few minutes after the end.", { timeout: 15000 });
  // The dispatcher issues them; the card's next poll shows it, without leaving.
  const tick = await page.request.post("/api/test/certificate-dispatch-tick", { headers: H(csrf), data: { force: true } });
  expect(tick.ok(), await tick.text()).toBeTruthy();
  await page.evaluate(() => window.refreshOverviewLive());
  await expect(card.locator(".ws-prog-num")).toHaveText("1", { timeout: 15000 });
  await expect(card).toContainText("issued");

  // An event that ended with nobody, three days ago: none issued, and since it
  // ended before automatic certificates began (this server's floor), the card
  // says why rather than a bare "No certificates issued." (sweep finding #230).
  await openWs(page, old);
  await expect(card).toContainText(NONE_BEFORE_FLOOR, { timeout: 15000 });

  // A failed read: a failure with Try again, and the failure is never kept.
  // The card asks for the counts (`?summary=1`): match the path, whatever the query.
  const certsUrl = (u) => u.pathname === `/api/admin/competitions/${old.id}/certificates`;
  let reads = 0;
  await page.route(certsUrl, (route) => { reads++; return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }); });
  const retry = card.locator('[data-action="ws-certs-retry"]');
  // A success is kept a minute: opening another event and coming back drops it.
  await openWs(page, ev);
  await openWs(page, old);
  await expect(retry, "a failed read offers Try again").toBeVisible({ timeout: 15000 });
  await expect(card).not.toContainText("No certificates issued");
  const failedReads = reads;
  expect(failedReads, "PRECONDITION: the read was made and failed").toBeGreaterThan(0);
  await page.evaluate(() => window.wsTab("admin-rankings-tab"));
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await expect.poll(() => reads, { timeout: 10000, message: "back on the Overview the failure is not served from a cache: it reads again" }).toBeGreaterThan(failedReads);
  await page.unroute(certsUrl);
  await card.locator('[data-action="ws-certs-retry"]').click();
  await expect(card).toContainText(NONE_BEFORE_FLOOR, { timeout: 15000 });
});

test("the certificates card re-reads on the poll only while a job is due soon, never every poll for a late entrant's far-off one", async ({ page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev, other;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 });
    other = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 });
  } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  // The list as the server sends it while a job waits: first held to a late-entry
  // deadline two days away, then (CONTROL) due in a minute.
  let dueAt = new Date(Date.now() + 2 * DAY).toISOString();
  let reads = 0;
  // The card asks for the counts (`?summary=1`): match the path, whatever the
  // query, and answer in the summary's shape.
  await page.route((u) => u.pathname === `/api/admin/competitions/${ev.id}/certificates`, (route) => {
    reads++;
    return route.fulfill({ json: { competitionId: ev.id, emailEnabled: true, counts: { issued: 0, revoked: 0, emailed: 0, failed: 0 }, pending: [{ scope: "event", reason: "late_entry_pending", dueAt }] } });
  });
  await openWs(page, ev);
  const card = page.locator("#ws-ov-certs");
  await expect(card).toContainText("Being issued", { timeout: 15000 });
  expect(reads, "PRECONDITION: one read on open").toBe(1);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.refreshOverviewLive());
  expect(reads, "a job days away: the polls keep the minute-long cache").toBe(1);
  // CONTROL: due within the minute, every poll reads it again.
  dueAt = new Date(Date.now() + 60_000).toISOString();
  await openWs(page, other);
  await openWs(page, ev);
  await expect.poll(() => reads, { timeout: 10000, message: "PRECONDITION: reopened, read again" }).toBeGreaterThanOrEqual(2);
  const before = reads;
  for (let i = 0; i < 2; i++) await page.evaluate(() => window.refreshOverviewLive());
  expect(reads - before, "a job due soon: each poll reads it").toBeGreaterThanOrEqual(2);
});

test("an admin who is not a superadmin gets an ended event's certificate design read-only, with the reason", async ({ browser }) => {
  const sa = await apiLogin("superadmin");
  let ended, live, adm;
  try {
    ended = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 });
    live = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
    adm = await makeParticipant(sa.api, sa.csrf, "wsoadm");
    const pr = await sa.api.post(`/api/admin/participants/${adm.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } });
    expect(pr.ok(), await pr.text()).toBeTruthy();
  } finally { await sa.api.dispose(); }
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginViaApi(page, adm.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() => !!window.isSuperAdmin), "PRECONDITION: not a superadmin").toBe(false);
    await openWs(page, ended, "admin-event-certs-tab");
    const design = page.locator("#ws-certs-design");
    await expect(design.locator(".cw-ro-note")).toContainText("Only a superadmin can change the certificate design of an event that has ended", { timeout: 15000 });
    await expect(design.locator('[data-cw="save"]'), "no Save the route would refuse").toHaveCount(0);
    await expect(design.locator('[data-cw="reset"]')).toHaveCount(0);
    await expect(design.locator('.cw-edit input[data-sec="text"]').first(), "the fields are not editable").toBeDisabled();
    await expect(design.locator('[data-cw="download"]'), "previewing and downloading stay").toBeVisible();
    // CONTROL: a live event's design is theirs to change.
    await openWs(page, live, "admin-event-certs-tab");
    await expect(design.locator('[data-cw="save"]')).toBeVisible({ timeout: 15000 });
    await expect(design.locator(".cw-ro-note")).toHaveCount(0);
  } finally { await ctx.close(); }
});

test.describe("in a time zone that skips an hour", () => {
  test.use({ timezoneId: "America/New_York" });

  test("the clone dialog refuses a start inside the hour the clocks skip, and clones at a real one", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    let ev;
    try { ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 }); }
    finally { await sa.api.dispose(); }
    await adminLogin(page);
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "PRECONDITION: the browser's zone").toBe("America/New_York");
    await openWs(page, ev);
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/clone$/.test(r.url())) posts.push(r.url()); });
    await page.locator("#ws-quick .ws-more-btn").click();
    await page.locator('[data-action="ws-clone"]').filter({ visible: true }).click();
    const dlg = page.locator("#ws-clone-dialog");
    await expect(dlg).toBeVisible();
    // 14 March 2027, 02:30 does not exist in New York (02:00 jumps to 03:00).
    await dlg.locator("#ws-clone-start").fill("2027-03-14T02:30");
    await dlg.locator('button[type="submit"]').click();
    await expect(dlg.locator("#ws-clone-dialog-err")).toContainText("does not exist on that date in America/New_York");
    expect(posts, "nothing was sent").toEqual([]);
    // CONTROL: 03:30 that day is real, and clones.
    await dlg.locator("#ws-clone-start").fill("2027-03-14T03:30");
    await dlg.locator('button[type="submit"]').click();
    await expect(page.locator(".toast").filter({ hasText: "Created" })).toBeVisible({ timeout: 15000 });
    expect(posts.length).toBe(1);
  });
});

test("a role that may add organisers but not search people is told so, and offered Remove only", async ({ browser }) => {
  const sa = await apiLogin("superadmin");
  let ev, org, user;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 });
    org = await makeParticipant(sa.api, sa.csrf, "wsoorg");
    await grantEventAdmin(sa.api, sa.csrf, ev.id, org.id);
    const role = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `Organiser keeper ${STAMP}`, scope_mode: "all", permissions: ["panel.access", "events.view", "events.organisers"] } });
    expect(role.ok(), `create role: ${await role.text()}`).toBeTruthy();
    user = await makeParticipant(sa.api, sa.csrf, "wsokeeper");
    const pr = await sa.api.patch(`/api/admin/users/${user.id}/role`, { headers: H(sa.csrf), data: { role: (await role.json()).role.id } });
    expect(pr.ok(), `assign role: ${await pr.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginViaApi(page, user.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openWs(page, ev);
    await openOverviewDetail(page);
    const add = page.locator("#ws-ov-orgs-add");
    await expect(add).toContainText("Your role cannot search people", { timeout: 15000 });
    await expect(add.locator("#ws-org-search"), "no search it would be refused").toHaveCount(0);
    await expect(page.locator(`#ws-ov-orgs [data-action="ws-org-remove"][data-user-id="${org.id}"]`), "Remove is still offered").toBeVisible();
  } finally { await ctx.close(); }
  // CONTROL: a superadmin gets the search.
  const c2 = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const p2 = await c2.newPage();
  try {
    await adminLogin(p2);
    await openWs(p2, ev);
    await openOverviewDetail(p2);
    await expect(p2.locator("#ws-ov-orgs-add #ws-org-search")).toBeVisible({ timeout: 15000 });
  } finally { await c2.close(); }
});

test("Top 3 and Export everything are offered only with their routes' permissions", async ({ browser, page }) => {
  const sa = await apiLogin("superadmin");
  let ev, user;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 });
    const role = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `Event watcher ${STAMP}`, scope_mode: "all", permissions: ["panel.access", "events.view"] } });
    expect(role.ok(), `create role: ${await role.text()}`).toBeTruthy();
    user = await makeParticipant(sa.api, sa.csrf, "wsowatch");
    const pr = await sa.api.patch(`/api/admin/users/${user.id}/role`, { headers: H(sa.csrf), data: { role: (await role.json()).role.id } });
    expect(pr.ok(), `assign role: ${await pr.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }
  const menuHas = async (pg, action) => {
    await pg.locator("#ws-quick .ws-more-btn").click();
    // Its items follow the role (a role without events.clone has no Clone), so
    // the menu itself is the witness that it opened.
    await expect(pg.locator("#ws-quick .ws-more-btn"), "PRECONDITION: the ⋯ menu is open").toHaveAttribute("aria-expanded", "true");
    await expect(pg.locator("#kebab-portal.open"), "…and drawn").toBeVisible();
    const n = await pg.locator(`[data-action="${action}"]`).filter({ visible: true }).count();
    await pg.keyboard.press("Escape");
    return n;
  };
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const wp = await ctx.newPage();
  try {
    await loginViaApi(wp, user.email, PARTICIPANT_PASS);
    await wp.goto("/");
    await expect(wp.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openWs(wp, ev);
    await expect(wp.locator("#ws-overview")).toHaveAttribute("data-ov-state", "ended", { timeout: 15000 });
    // Without certificates.view the ended face shows no Certificates card at all
    // (its read would be refused), so no Top 3 either.
    await expect(wp.locator("#ws-overview #ws-ov-progress"), "PRECONDITION: the ended face is drawn").toBeVisible();
    await expect(wp.locator("#ws-overview .ws-certs-card"), "no Certificates card without certificates.view").toHaveCount(0);
    await expect(wp.locator(".ws-top3-btn"), "no Top 3 without certificates.view").toHaveCount(0);
    expect(await menuHas(wp, "ws-export-zip"), "no Export everything without export.data").toBe(0);
  } finally { await ctx.close(); }
  // CONTROL: a superadmin is offered both.
  await adminLogin(page);
  await openWs(page, ev);
  await expect(page.locator("#ws-overview .ws-certs-card"), "CONTROL: the card is there").toBeVisible({ timeout: 15000 });
  await expect(page.locator("#ws-overview .ws-top3-btn")).toBeVisible({ timeout: 15000 });
  expect(await menuHas(page, "ws-export-zip")).toBe(1);
});

test("Download top 3 says when the ZIP is only part of the podium", async ({ page }) => {
  const sa = await apiLogin("superadmin");
  let ev;
  try { ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 }); }
  finally { await sa.api.dispose(); }
  await adminLogin(page);
  await openWs(page, ev);
  const btn = page.locator("#ws-overview .ws-top3-btn");
  await expect(btn).toBeVisible({ timeout: 15000 });
  // The server's answers, as the route sends them: places still being issued,
  // a place that will not be issued automatically, then the whole podium (two
  // sessions' worth).
  let headers = { "X-Top3-Count": "1", "X-Top3-Missing": "3", "X-Top3-Missing-Reason": "being_issued" };
  await page.route(`**/api/admin/competitions/${ev.id}/certificates/top3.zip`, (route) => route.fulfill({
    status: 200, contentType: "application/zip", body: Buffer.from("PK\u0005\u0006" + "\u0000".repeat(18), "binary"), headers,
  }));
  const whole = page.locator(".toast").filter({ hasText: "Downloaded all" });
  await btn.click();
  await expect(page.locator(".toast").filter({ hasText: "Downloaded 1 top-three certificate. 3 more are still being issued — download again in a few minutes." })).toBeVisible({ timeout: 10000 });
  await expect(whole, "never the whole-podium message").toHaveCount(0);
  headers = { "X-Top3-Count": "1", "X-Top3-Missing": "1", "X-Top3-Missing-Reason": "email_disabled" };
  await btn.click();
  await expect(page.locator(".toast").filter({ hasText: "Downloaded 1 top-three certificate. 1 more place has no certificate yet: this event's certificates are not issued automatically while its congratulations email is off." })).toBeVisible({ timeout: 10000 });
  await expect(whole, "nor for a place that is not coming").toHaveCount(0);
  headers = { "X-Top3-Count": "6" };
  await btn.click();
  await expect(page.locator(".toast").filter({ hasText: "Downloaded all 6 top-three certificates." }), "CONTROL: every podium whole").toBeVisible({ timeout: 10000 });
});
