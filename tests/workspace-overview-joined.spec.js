"use strict";

// WHO HAS JOINED, ON THE OVERVIEW (public/js/features/event-workspace.js
// `_joinedCount`). Joined, and every Overview line that says how many have
// joined, counts EVERYONE ENROLLED: the roster the Events list and the
// Participants tab show, read from the events model, so it never waits for the
// live figures. The other live figures (the pulse) still leave out the roles
// the boards leave out where staff do not compete (operator rulings, 14 Nov
// 2026). Every event below is one where staff do not compete, and its organiser
// is an event admin granted on another event, so only the ROLE leaves them out:
//   • live, the organiser (enrolled and playing) and two participants: with the
//     pulse held, Joined already reads 3 — the Events list's count — beside a
//     Playing now still waiting; answered, Joined still reads 3 and the
//     attention row is all clear, while CONTROL: the live figures leave the
//     organiser out (Playing now 2, Answers 2, Progress "of 2"), the activity
//     chart's Joins and summary among them (operator ruling, 14 Nov 2026);
//   • the same people on an upcoming event: "Ready to start?" says "3 people
//     have joined" while the pulse read fails and while it is held (never
//     "checking" or "could not check" who has joined), and once read the chart
//     agrees; CONTROL: its challenges row waited for the read;
//   • live, the organiser alone: Joined 1, the attention row never says
//     "Nobody has joined yet", and Progress says only staff and event admins
//     have joined (never "Nobody has joined yet"); CONTROL: a live event nobody
//     joined says "Nobody has joined yet" in both, with Joined 0;
//   • a competitor is never sent the pulse: their band and checklist read the
//     roster, like everyone's, and follow it when the poll brings a new member,
//     and coming back to the Overview from another section shows the band and
//     the checklist with the same, new roster;
//   • an organiser who does not compete, with the live read held: a reload of
//     the events model (as after the header's Invite) moves Joined and the
//     checklist with the Participants tab, though no read has answered, and
//     after the form's own redraw of the band (renderScopeBanner) the
//     checklist follows too;
//   • a failed refresh after an ordinary participant joins: Joined follows the
//     roster, and Progress, whose last read predates the join, says
//     "Counting…", never "Nobody has joined yet." beside Joined 1;
//   • only an event admin has joined, then an ordinary participant: Progress
//     says "Counting…" until a read has seen them, never "only staff";
//   • a competitor across a move of the start (an hour closer, then 25 s out
//     with no poll): the band's time tile follows each poll, and the face the
//     clock rebuilds at the start;
//   • an organiser who starts competing while watching: the band's live
//     figures go off the page with the rest, and Joined stays;
//   • the live read newer than the events model (opened just after a join,
//     with no poll): nothing says nobody has joined, and Joined catches up;
//   • a member joins on the poll and the read answers a moment later: Joined's
//     count-up and flash carry over the rebuild, end on time, never go back,
//     and never come back on a later rebuild.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { adminLogin, loginViaApi, filterComps, openOverviewDetail } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `joined-key-${STAMP}`;
const made = { comps: [], people: [] };
const ev = {};

async function createEvent(api, csrf, label, data) {
  const name = `WsJoined ${label} ${STAMP}`;
  const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: { name, ...data } });
  expect(r.status(), `create ${label}: ${await r.text()}`).toBe(200);
  const c = (await r.json()).competition;
  made.comps.push(c.id);
  return c;
}

async function person(api, csrf, label) {
  const p = await makeParticipant(api, csrf, label);
  made.people.push(p.id);
  return p;
}

// What the server says about the event: the events model's roster count and the
// pulse's live figures — the two the page must keep apart.
async function figures(api, compId) {
  const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === compId);
  const pulse = await (await api.get(`/api/admin/competitions/${compId}/overview-pulse`)).json();
  const t = pulse.totals || {};
  return { roster: row ? row.participant_count : null, joined: t.joined, answers: t.answers, active: t.active_now };
}

// One account answers `taskId` in `compId`. An organiser plays from participant view.
async function answer(s, compId, taskId, ans) {
  const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
  const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf), data: { answer: ans, gradingHash: await gradingHashFor(s.api, taskId) } });
  expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).correct;
}

async function openWs(page, e) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), e.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: e.id, n: e.name });
  await expect(page.locator("#ws-title")).toHaveText(e.name, { timeout: 15000 });
}

const pulseUrl = (id) => `**/api/admin/competitions/${id}/overview-pulse`;

// Hold the event's pulse: the page asks, nothing answers until `release()`.
async function holdPulse(page, compId) {
  const h = { asked: 0 };
  let open;
  const gate = new Promise((r) => { open = r; });
  await page.route(pulseUrl(compId), async (route) => {
    h.asked++;
    await gate;
    await route.continue().catch(() => {});
  });
  h.release = open;
  return h;
}

const tile = (page, key) => page.locator(`#ws-kpis .ws-kpi[data-kpi-tile="${key}"]`);
const fig = (page, key) => tile(page, key).locator(".ws-count");

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const sa = await apiLogin("superadmin");
  try {
    // The organiser: an event admin, granted on an event of their own (never
    // the ones below), so only the ROLE can leave them out of those.
    const anchor = await createEvent(sa.api, sa.csrf, "anchor", { event_kind: "tournament", start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 60 });
    ev.ea = await person(sa.api, sa.csrf, "wsjea");
    await grantEventAdmin(sa.api, sa.csrf, anchor.id, ev.ea.id);
    ev.p1 = await person(sa.api, sa.csrf, "wsjp1");
    ev.p2 = await person(sa.api, sa.csrf, "wsjp2");
    // Two challenges, so one solve finishes nothing (fixture item 1).
    ev.t1 = await makeTask(sa.api, sa.csrf, "wsjt1", { correct_answer: KEY });
    ev.t2 = await makeTask(sa.api, sa.csrf, "wsjt2", { correct_answer: KEY });
    const live = { event_kind: "tournament", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 240 };
    ev.mixed = await createEvent(sa.api, sa.csrf, "mixed", live);
    ev.solo = await createEvent(sa.api, sa.csrf, "solo", live);
    ev.empty = await createEvent(sa.api, sa.csrf, "empty", live);
    ev.up = await createEvent(sa.api, sa.csrf, "up", { event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
    for (const t of [ev.t1, ev.t2]) await assignTask(sa.api, sa.csrf, t.id, [ev.mixed.id, ev.solo.id, ev.empty.id, ev.up.id]);
    await enrol(sa.api, sa.csrf, ev.mixed.id, [ev.ea.id, ev.p1.id, ev.p2.id]);
    await enrol(sa.api, sa.csrf, ev.up.id, [ev.ea.id, ev.p1.id, ev.p2.id]);
    await enrol(sa.api, sa.csrf, ev.solo.id, [ev.ea.id]);
  } finally { await sa.api.dispose(); }

  // The organiser plays both live events they are in, from participant view.
  const o = await apiLogin(ev.ea.email, PARTICIPANT_PASS);
  try {
    const tg = await o.api.post("/api/toggle-admin-view", { headers: H(o.csrf), data: { mode: "participant" } });
    expect(tg.ok(), `participant view: ${tg.status()} ${await tg.text()}`).toBeTruthy();
    o.csrf = (await (await o.api.get("/api/csrf-token")).json()).csrfToken;
    expect(await answer(o, ev.mixed.id, ev.t1.id, KEY), "PRECONDITION: the organiser solves one challenge").toBe(true);
    expect(await answer(o, ev.solo.id, ev.t1.id, KEY), "…on the event they are alone in too").toBe(true);
  } finally { await o.api.dispose(); }
  // One participant right, one wrong.
  for (const [p, ans, ok] of [[ev.p1, KEY, true], [ev.p2, `wrong-${STAMP}`, false]]) {
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    try { expect(await answer(s, ev.mixed.id, ev.t1.id, ans), `PRECONDITION: ${p.email} answers ${ok ? "right" : "wrong"}`).toBe(ok); }
    finally { await s.api.dispose(); }
  }

  // PRECONDITIONS, by value: the roster and the live figures differ by exactly
  // the organiser (challenge events are written after the commit: poll).
  const sa2 = await apiLogin("superadmin");
  try {
    await expect.poll(() => figures(sa2.api, ev.mixed.id), { timeout: 15000, message: "mixed: the roster holds the organiser; the live figures do not" })
      .toEqual({ roster: 3, joined: 2, answers: 2, active: 2 });
    expect(await figures(sa2.api, ev.up.id), "up: the same people").toMatchObject({ roster: 3, joined: 2 });
    expect(await figures(sa2.api, ev.solo.id), "solo: only the organiser, who plays").toEqual({ roster: 1, joined: 0, answers: 0, active: 0 });
    expect(await figures(sa2.api, ev.empty.id), "empty: nobody").toMatchObject({ roster: 0, joined: 0 });
  } finally { await sa2.api.dispose(); }
});

test.afterAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  for (const id of made.comps) await api.delete(`/api/admin/competitions/${id}`, { headers: H(csrf) }).catch(() => {});
  for (const id of made.people) await api.delete(`/api/admin/participants/${id}`, { headers: H(csrf) }).catch(() => {});
  await api.dispose();
});

test("Joined is the roster the Events list shows, at once, before the live figures answer; the live figures still leave the organiser out", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);

  // The Events list's count for the event: its Participants cell, as shown.
  await filterComps(page, ev.mixed.name);
  const listed = await page.evaluate((name) => {
    const i = [...document.querySelectorAll("#admin-comp-table thead th")].findIndex((th) => th.dataset.col === "participants");
    const row = [...document.querySelectorAll("#admin-comp-body tr")].find((tr) => (tr.querySelector(".ev-name-cell")?.textContent || "").includes(name));
    const cell = row && i >= 0 ? row.children[i] : null;
    return cell ? { text: cell.textContent.trim(), shown: cell.getClientRects().length > 0 } : null;
  }, ev.mixed.name);
  expect(listed, "PRECONDITION: the Events list shows the event's Participants count").toEqual({ text: "3", shown: true });

  // The live figures are held: nothing from the pulse can reach the page.
  const held = await holdPulse(page, ev.mixed.id);
  try {
    await openWs(page, ev.mixed);
    await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });
    await expect.poll(() => held.asked, { message: "PRECONDITION: the page asked for the live figures" }).toBeGreaterThan(0);
    await expect(tile(page, "active").locator(".ws-kpi-text"), "PRECONDITION: Playing now is still waiting").toHaveText("—");
    await expect(tile(page, "active").locator(".ws-kpi-sub")).toHaveText("counting…");
    await expect(page.locator("#ws-ov-progress"), "…and so is Progress").toHaveText("Loading…");
    await expect(fig(page, "joined"), "Joined is there at once: the Events list's count").toHaveAttribute("data-count", listed.text);
    await expect(tile(page, "joined").locator(".ws-kpi-text"), "never '—'").toHaveCount(0);
    await expect(tile(page, "joined").locator(".ws-kpi-sub"), "nor 'counting…'").toHaveText("by invitation");
  } finally { held.release(); }

  // Answered: the live figures leave the organiser out (CONTROL), Joined does not.
  await expect(fig(page, "active"), "CONTROL: Playing now counts the two participants, not the organiser").toHaveAttribute("data-count", "2", { timeout: 15000 });
  await expect(fig(page, "answers"), "CONTROL: Answers counts theirs only").toHaveAttribute("data-count", "2");
  const prog = page.locator("#ws-ov-progress");
  await expect(prog.locator(".ws-prog-of"), "CONTROL: Progress counts the two participants").toHaveText("of 2 solved every question");
  await expect(prog.locator(".ws-prog-num")).toHaveText("0");
  await expect(prog.locator(".ws-prog-sub")).toHaveText("1 of 2 have solved at least one.");
  await expect(fig(page, "joined"), "Joined still counts everyone enrolled").toHaveAttribute("data-count", "3");
  await expect(page.locator("#ws-count-participants"), "the Participants tab gives the same figure").toHaveText("3");
  const attn = page.locator("#ws-ov-attn");
  await expect(attn.locator(".ws-allclear"), "the attention row: people have joined, nothing needs the organiser").toHaveText("Nothing needs you right now.");
  await expect(attn).not.toContainText("Nobody has joined yet");

  // The activity chart is a live figure too (operator ruling, 14 Nov 2026):
  // its Joins and summary leave the organiser out, beside Joined's 3.
  await openOverviewDetail(page);
  const chart = page.locator("#ws-ov-chart");
  await expect(chart.locator(".ws-legend li").filter({ hasText: "Joins" }), "the chart's Joins: the live figure").toHaveText("Joins 2", { timeout: 15000 });
  await expect(chart.locator(".ws-chart-summary"), "…and so is its summary").toContainText("2 joins between");
  await expect(fig(page, "joined"), "Joined beside it: the roster").toHaveAttribute("data-count", "3");
});

test("Ready to start? and the chart count everyone enrolled, while the read fails, while it is held and once it answers", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);

  // The read fails: who has joined is still known.
  await page.route(pulseUrl(ev.up.id), (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await openWs(page, ev.up);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "upcoming", { timeout: 15000 });
  const ready = page.locator("#ws-ov-ready");
  const joinedRow = ready.locator(".ws-ready-item").filter({ hasText: "joined" });
  await expect(ready, "CONTROL: the failed read is reported on the challenges row").toContainText("Could not check the questions", { timeout: 15000 });
  await expect(joinedRow, "who has joined: everyone enrolled, organiser included").toHaveText(/3 people have joined/);
  await expect(joinedRow).toHaveAttribute("data-ready", "ok");
  await expect(ready).not.toContainText("Could not check who has joined");
  await expect(ready).not.toContainText("Nobody has joined yet");
  await expect(fig(page, "joined"), "Joined: the roster").toHaveAttribute("data-count", "3");

  // Try again, the read held: the challenges row waits, who has joined does not.
  // The hold is registered over the failing route (the newest handler runs
  // first), so no poll can slip a good read in between.
  const held = await holdPulse(page, ev.up.id);
  try {
    await ready.locator('[data-action="ws-pulse-retry"]').click();
    await expect(ready, "CONTROL: the challenges row waits for the read").toContainText("Checking the questions…");
    await expect.poll(() => held.asked, { message: "PRECONDITION: the retry asked" }).toBeGreaterThan(0);
    await expect(joinedRow, "who has joined never waits").toHaveText(/3 people have joined/);
    await expect(ready).not.toContainText("Checking who has joined");
  } finally { held.release(); }

  // Answered: the same figure, and the chart's line agrees (the pulse's own
  // `joined`, 2, leaves the organiser out).
  await expect(ready, "PRECONDITION: the read has answered").toContainText("2 questions published", { timeout: 15000 });
  await expect(joinedRow).toHaveText(/3 people have joined/);
  await expect(ready.locator('.ws-ready-item[data-ready="todo"]'), "nothing left to do").toHaveCount(0);
  await expect(fig(page, "joined")).toHaveAttribute("data-count", "3");
  await openOverviewDetail(page);
  await expect(page.locator("#ws-ov-chart"), "the chart's line counts everyone enrolled").toContainText("3 people have joined so far.");
});

test("an event only its organiser has joined: Joined 1, never 'Nobody has joined yet'; CONTROL: an event nobody joined says so", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  const attn = page.locator("#ws-ov-attn");
  const prog = page.locator("#ws-ov-progress");

  await openWs(page, ev.solo);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });
  await expect(fig(page, "active"), "CONTROL: the live figures leave the organiser out").toHaveAttribute("data-count", "0", { timeout: 15000 });
  await expect(fig(page, "joined"), "Joined: the organiser has joined").toHaveAttribute("data-count", "1");
  await expect(prog, "Progress says who has joined, without claiming nobody has").toHaveText("Only staff and event admins (or roles like theirs) have joined; they are not counted here.");
  await expect(attn.locator(".ws-allclear"), "the attention row: somebody has joined").toHaveText("Nothing needs you right now.");
  await expect(attn).not.toContainText("Nobody has joined yet");

  // CONTROL: nobody enrolled.
  await openWs(page, ev.empty);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });
  await expect(fig(page, "active"), "PRECONDITION: the live figures have answered").toHaveAttribute("data-count", "0", { timeout: 15000 });
  await expect(fig(page, "joined"), "CONTROL: Joined 0").toHaveAttribute("data-count", "0");
  await expect(prog, "CONTROL: Progress says nobody has joined").toHaveText("Nobody has joined yet.");
  await expect(attn, "CONTROL: so does the attention row").toContainText("Nobody has joined yet.");
  await expect(attn.locator(".ws-allclear")).toHaveCount(0);
});

test("a competitor is never sent the pulse: their band and Ready to start? read the roster, like everyone's, and follow the poll", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let cmp, org;
  try {
    org = await person(sa.api, sa.csrf, "wsjorg");
    const pr = await sa.api.post(`/api/admin/participants/${org.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } });
    expect(pr.ok(), `promote: ${await pr.text()}`).toBeTruthy();
    const other = await person(sa.api, sa.csrf, "wsjother");
    cmp = await createEvent(sa.api, sa.csrf, "compete", { event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60, staff_compete: true });
    await enrol(sa.api, sa.csrf, cmp.id, [org.id, other.id]);
    expect(await figures(sa.api, cmp.id), "PRECONDITION: two enrolled; where staff compete the pulse counts both").toMatchObject({ roster: 2, joined: 2 });
  } finally { await sa.api.dispose(); }

  let pulseReads = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === `/api/admin/competitions/${cmp.id}/overview-pulse`) pulseReads++; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginViaApi(page, org.email);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  await openWs(page, cmp);
  await expect(page.locator("#ws-record .ws-chip-competing"), "PRECONDITION: the organiser competes in it").toBeVisible({ timeout: 15000 });
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "upcoming", { timeout: 15000 });
  await expect(fig(page, "joined"), "Joined: the roster").toHaveAttribute("data-count", "2", { timeout: 15000 });
  const ready = page.locator("#ws-ov-ready");
  await expect(ready, "the checklist keeps the challenges off the page").toContainText("kept off this page while you compete");
  const joinedRow = ready.locator(".ws-ready-item").filter({ hasText: "joined" });
  await expect(joinedRow, "…and counts who has joined from the roster").toHaveText(/2 people have joined/);

  // A third member arrives: the 15 s events poll brings the roster, and Joined
  // and the checklist follow it as the Participants tab beside them does.
  const sa2 = await apiLogin("superadmin");
  try {
    const third = await person(sa2.api, sa2.csrf, "wsjthird");
    await enrol(sa2.api, sa2.csrf, cmp.id, [third.id]);
  } finally { await sa2.api.dispose(); }
  await expect(page.locator("#ws-count-participants"), "PRECONDITION: the poll has brought the new roster").toHaveText("3", { timeout: 40000 });
  await expect(fig(page, "joined"), "Joined follows the poll").toHaveAttribute("data-count", "3");
  await expect(joinedRow, "…and so does the checklist").toHaveText(/3 people have joined/);

  // Away on another section while a fourth member arrives, then back: the band
  // comes back with the Overview, never the old Joined beside a new checklist.
  // Read in the same task that paints the checklist (a mutation observer), so
  // the strip's 1 s tick cannot repaint the band in between.
  await page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]').click();
  await expect(page.locator("#ws-overview"), "PRECONDITION: off the Overview").toBeHidden();
  const sa3 = await apiLogin("superadmin");
  try {
    const fourth = await person(sa3.api, sa3.csrf, "wsjfourth");
    await enrol(sa3.api, sa3.csrf, cmp.id, [fourth.id]);
  } finally { await sa3.api.dispose(); }
  await expect(page.locator("#ws-count-participants"), "PRECONDITION: the poll has brought the new roster").toHaveText("4", { timeout: 40000 });
  const backP = page.evaluate(() => new Promise((resolve) => {
    const read = () => {
      const row = [...document.querySelectorAll("#ws-ov-ready .ws-ready-item")].map(li => li.textContent).find(t => /joined/.test(t)) || "";
      if (!/4 people have joined/.test(row)) return false;
      resolve({ joined: document.querySelector('#ws-kpis .ws-kpi[data-kpi-tile="joined"] .ws-count')?.dataset.count || null, ready: row });
      return true;
    };
    if (read()) return;
    const mo = new MutationObserver(() => { if (read()) mo.disconnect(); });
    mo.observe(document.getElementById("admin-page") || document.body, { subtree: true, childList: true, characterData: true });
    setTimeout(() => { mo.disconnect(); resolve(null); }, 10000);
  }));
  await page.locator('#ws-tabs .ws-tab[data-section="admin-event-overview-tab"]').click();
  const back = await backP;
  expect(back, "the Overview came back with the new roster in its checklist").not.toBeNull();
  expect(back.joined, "…and Joined beside it the same, at once").toBe("4");
  expect(pulseReads, "the page never asks for the pulse").toBe(0);
});

async function userAdmin(api, csrf, label) {
  const a = await person(api, csrf, label);
  const pr = await api.post(`/api/admin/participants/${a.id}/role`, { headers: H(csrf), data: { role: "admin" } });
  expect(pr.ok(), `promote ${label}: ${await pr.text()}`).toBeTruthy();
  return a;
}

// Signed in as a user-backed admin: the superadmin sessions these tests open
// to change the roster would end a built-in superadmin's browser session.
async function signInAs(page, who) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginViaApi(page, who.email);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
}

test("an organiser who does not compete: with the live read held, Joined and the checklist follow a reload of the events model", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let watcher, e;
  try {
    watcher = await userAdmin(sa.api, sa.csrf, "wsjwatch");
    e = await createEvent(sa.api, sa.csrf, "follow", { event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
    await enrol(sa.api, sa.csrf, e.id, [ev.p1.id, ev.p2.id]);
  } finally { await sa.api.dispose(); }

  await signInAs(page, watcher);
  const firstRead = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/competitions/${e.id}/overview-pulse` && r.ok(), { timeout: 20000 });
  await openWs(page, e);
  await firstRead;
  const joinedRow = page.locator("#ws-ov-ready .ws-ready-item").filter({ hasText: "joined" });
  await expect(fig(page, "joined"), "PRECONDITION: Joined is the roster").toHaveAttribute("data-count", "2", { timeout: 15000 });
  await expect(joinedRow).toHaveText(/2 people have joined/);

  // From here no live read can answer: only the events model can move Joined.
  const held = await holdPulse(page, e.id);
  try {
    const sa2 = await apiLogin("superadmin");
    try {
      const third = await person(sa2.api, sa2.csrf, "wsjfollow3");
      await enrol(sa2.api, sa2.csrf, e.id, [third.id]);
    } finally { await sa2.api.dispose(); }
    // The model reloads as it does after the header's Invite.
    await page.evaluate(() => window.loadAdminCompetitions());
    await expect(page.locator("#ws-count-participants"), "PRECONDITION: the Participants tab has the new roster").toHaveText("3");
    await expect(fig(page, "joined"), "Joined follows it, the live read still held").toHaveAttribute("data-count", "3");
    await expect(joinedRow, "…and so does the checklist").toHaveText(/3 people have joined/);

    // A save of the event form reloads the model and redraws the band itself
    // (renderScopeBanner) before anything asks whether the roster moved: the
    // checklist must follow all the same.
    const sa3 = await apiLogin("superadmin");
    try {
      const fourth = await person(sa3.api, sa3.csrf, "wsjfollow4");
      await enrol(sa3.api, sa3.csrf, e.id, [fourth.id]);
    } finally { await sa3.api.dispose(); }
    await page.evaluate(async () => { await window.loadAdminCompetitions(); window.renderScopeBanner(); });
    await expect(fig(page, "joined"), "Joined after the form's own redraw").toHaveAttribute("data-count", "4");
    await expect(joinedRow, "…and the checklist with it, the live read still held").toHaveText(/4 people have joined/);
  } finally { held.release(); }
});

test("a failed refresh after an ordinary participant joins: Joined follows the roster, Progress claims nothing its last read did not see", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let watcher, e;
  try {
    watcher = await userAdmin(sa.api, sa.csrf, "wsjstale");
    e = await createEvent(sa.api, sa.csrf, "stale", { event_kind: "tournament", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 240 });
  } finally { await sa.api.dispose(); }

  await signInAs(page, watcher);
  await openWs(page, e);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });
  const prog = page.locator("#ws-ov-progress");
  await expect(prog, "PRECONDITION: the first read: nobody has joined").toHaveText("Nobody has joined yet.", { timeout: 15000 });

  // Every later read fails; then an ordinary participant joins.
  let refused = 0;
  await page.route(pulseUrl(e.id), (route) => { refused++; return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }); });
  const sa2 = await apiLogin("superadmin");
  try {
    const p = await person(sa2.api, sa2.csrf, "wsjstalep");
    await enrol(sa2.api, sa2.csrf, e.id, [p.id]);
  } finally { await sa2.api.dispose(); }
  await page.evaluate(() => window.loadAdminCompetitions());
  await expect(fig(page, "joined"), "Joined follows the roster").toHaveAttribute("data-count", "1");
  await expect(page.locator("#ws-ov-attn"), "a refresh has failed, and the row says whose figures these are").toContainText("The live figures on this page are from", { timeout: 25000 });
  expect(refused, "PRECONDITION: the page asked again and was refused").toBeGreaterThan(0);
  await expect(prog, "Progress's last read predates the join: it claims neither 'nobody' nor 'only staff'").toHaveText("Counting…");
  const attnNow = await page.locator("#ws-ov-attn").textContent();
  expect(attnNow, "…nor does the attention row say nobody has joined, beside Joined 1").not.toContain("Nobody has joined yet");

  // A failed read is no newer than the model, so it never reloads it: between
  // two of the poll's reads, only that poll's own load of the events model.
  const reqs = [];
  page.on("request", (r) => {
    const pth = new URL(r.url()).pathname;
    if (pth === "/api/admin/competitions") reqs.push("events");
    else if (pth === `/api/admin/competitions/${e.id}/overview-pulse`) reqs.push("pulse");
  });
  await expect.poll(() => reqs.filter((x) => x === "pulse").length, { timeout: 40000, message: "two more of the poll's reads" }).toBeGreaterThanOrEqual(2);
  const i0 = reqs.indexOf("pulse"), i1 = reqs.indexOf("pulse", i0 + 1);
  expect(reqs.slice(i0 + 1, i1), `between two failed reads, the poll's own model load alone: ${reqs.join(",")}`).toEqual(["events"]);
});

test("only an event admin has joined, then an ordinary participant: Progress waits for a read that has seen them, never 'only staff'", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let watcher, e;
  try {
    watcher = await userAdmin(sa.api, sa.csrf, "wsjb2");
    e = await createEvent(sa.api, sa.csrf, "b2", { event_kind: "tournament", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 240 });
    await enrol(sa.api, sa.csrf, e.id, [ev.ea.id]);
  } finally { await sa.api.dispose(); }

  await signInAs(page, watcher);
  await openWs(page, e);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });
  const prog = page.locator("#ws-ov-progress");
  await expect(prog, "PRECONDITION: the read saw only the event admin, and counts nobody").toHaveText("Only staff and event admins (or roles like theirs) have joined; they are not counted here.", { timeout: 15000 });

  const held = await holdPulse(page, e.id);
  try {
    const sa2 = await apiLogin("superadmin");
    try {
      const p = await person(sa2.api, sa2.csrf, "wsjb2p");
      await enrol(sa2.api, sa2.csrf, e.id, [p.id]);
    } finally { await sa2.api.dispose(); }
    await page.evaluate(() => window.loadAdminCompetitions());
    await expect(fig(page, "joined"), "Joined follows the roster").toHaveAttribute("data-count", "2");
    await expect(prog, "the last read predates the join: Progress claims neither").toHaveText("Counting…");
  } finally { held.release(); }
  await expect(prog.locator(".ws-prog-of"), "the next read counts the participant").toHaveText("of 1 solved every question", { timeout: 25000 });
});

test("a competitor across a move of the start: the band's time tile follows each poll and the face the start rebuilds", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let org, cmp;
  try {
    org = await userAdmin(sa.api, sa.csrf, "wsjcross");
    const other = await person(sa.api, sa.csrf, "wsjcrossp");
    cmp = await createEvent(sa.api, sa.csrf, "cross", { event_kind: "tournament", start_time: new Date(Date.now() + 3 * 3_600_000).toISOString(), duration_minutes: 60, staff_compete: true });
    await enrol(sa.api, sa.csrf, cmp.id, [org.id, other.id]);
  } finally { await sa.api.dispose(); }
  const moveStart = async (iso) => {
    const s2 = await apiLogin("superadmin");
    try {
      const r = await s2.api.put(`/api/admin/competitions/${cmp.id}`, { headers: H(s2.csrf), data: { start_time: iso } });
      expect(r.status(), `move the start: ${await r.text()}`).toBe(200);
    } finally { await s2.api.dispose(); }
  };

  await signInAs(page, org);
  await openWs(page, cmp);
  await expect(page.locator("#ws-record .ws-chip-competing"), "PRECONDITION: the organiser competes in it").toBeVisible({ timeout: 15000 });
  const time = tile(page, "time");
  await expect(time.locator(".ws-kpi-text"), "PRECONDITION: the first paint").toHaveText("3 h", { timeout: 15000 });
  // The start moves an hour closer: the poll repaints a competitor's band,
  // though no live read answers for them.
  await moveStart(new Date(Date.now() + 2 * 3_600_000).toISOString());
  await expect(time.locator(".ws-kpi-text"), "the time tile follows the poll").toHaveText("2 h", { timeout: 25000 });
  await expect(page.locator("#ws-overview"), "…the event still upcoming").toHaveAttribute("data-ov-state", "upcoming");
  // Then 25 s out, the model told at once and the events poll stopped: only the
  // clock (the strip's 1 s tick) can turn the event live and rebuild the face,
  // and the band above it is read in the same task.
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  await moveStart(new Date(Date.now() + 25_000).toISOString());
  await page.evaluate(() => window.loadAdminCompetitions());
  await expect(page.locator("#ws-overview"), "PRECONDITION: still upcoming once the model has the new start").toHaveAttribute("data-ov-state", "upcoming");
  const atStartP = page.evaluate(() => new Promise((resolve) => {
    const ov = document.getElementById("ws-overview");
    const read = () => {
      if (ov.dataset.ovState !== "live") return false;
      const t = document.querySelector('#ws-kpis .ws-kpi[data-kpi-tile="time"] .eyebrow');
      resolve(t ? t.textContent.trim() : null);
      return true;
    };
    if (read()) return;
    const mo = new MutationObserver(() => { if (read()) mo.disconnect(); });
    mo.observe(document.getElementById("admin-page") || document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ov-state"] });
    setTimeout(() => { mo.disconnect(); resolve("timeout"); }, 60000);
  }));
  expect(await atStartP, "the band turns with the face that the start rebuilt").toBe("Time left");
});

test("an organiser who starts competing while watching: the band's live figures go off the page with the rest", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let watcher, e;
  try {
    watcher = await userAdmin(sa.api, sa.csrf, "wsjturn");
    e = await createEvent(sa.api, sa.csrf, "turn", { event_kind: "tournament", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 240, staff_compete: true });
    await enrol(sa.api, sa.csrf, e.id, [ev.p1.id]);
  } finally { await sa.api.dispose(); }

  await signInAs(page, watcher);
  await openWs(page, e);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });
  await expect(fig(page, "active"), "PRECONDITION: watching, the live figures are on the band").toHaveAttribute("data-count", "0", { timeout: 15000 });
  const sa2 = await apiLogin("superadmin");
  try { await enrol(sa2.api, sa2.csrf, e.id, [watcher.id]); } finally { await sa2.api.dispose(); }
  await expect(page.locator("#ws-record .ws-chip-competing"), "PRECONDITION: the poll says they now compete").toBeVisible({ timeout: 25000 });
  await expect(page.locator("#ws-ov-progress"), "PRECONDITION: the cards keep the live figures off").toContainText("kept off this page");
  await expect(tile(page, "active").locator(".ws-kpi-text"), "the band's Playing now goes off too").toHaveText("—");
  await expect(tile(page, "active").locator(".ws-kpi-sub")).toHaveText("kept off this page while you compete");
  await expect(fig(page, "joined"), "CONTROL: Joined, the roster, stays").toHaveAttribute("data-count", "2");
});

test("the live read newer than the events model (opened just after a join): never 'Nobody has joined yet' beside it, and Joined catches up at once", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let watcher, e;
  try {
    watcher = await userAdmin(sa.api, sa.csrf, "wsjnewer");
    e = await createEvent(sa.api, sa.csrf, "newer", { event_kind: "tournament", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 240 });
  } finally { await sa.api.dispose(); }

  await signInAs(page, watcher);
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).find(c => c.id === id)?.participant_count, e.id),
    { timeout: 15000, message: "PRECONDITION: the events model holds the event, nobody in it" }).toBe(0);
  // No events poll from here, and someone joins after the model loaded: only
  // the page's own reload can bring the roster.
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  const sa2 = await apiLogin("superadmin");
  try { const p = await person(sa2.api, sa2.csrf, "wsjnewerp"); await enrol(sa2.api, sa2.csrf, e.id, [p.id]); }
  finally { await sa2.api.dispose(); }
  await page.evaluate(() => {
    window.__nobody = []; window.__joinedFirst = null;
    new MutationObserver(() => {
      const j = document.querySelector('#ws-kpis .ws-kpi[data-kpi-tile="joined"] .ws-count');
      if (j && window.__joinedFirst === null) window.__joinedFirst = j.dataset.count;
      for (const id of ["ws-ov-progress", "ws-ov-attn"]) {
        const el = document.getElementById(id);
        if (el && /Nobody has joined yet/.test(el.textContent)) window.__nobody.push(id);
      }
    }).observe(document.getElementById("admin-page"), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const firstRead = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/competitions/${e.id}/overview-pulse` && r.ok(), { timeout: 20000 });
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: e.id, n: e.name });
  await firstRead;
  await expect(fig(page, "joined"), "Joined catches up with the read at once, though no poll runs").toHaveAttribute("data-count", "1", { timeout: 5000 });
  await expect(page.locator("#ws-count-participants")).toHaveText("1");
  await expect(page.locator("#ws-ov-progress .ws-prog-of"), "…and Progress counts the newcomer").toHaveText("of 1 solved every question");
  const rec = await page.evaluate(() => ({ first: window.__joinedFirst, nobody: [...new Set(window.__nobody)] }));
  expect(rec.first, "PRECONDITION: the page opened on a model from before the join").toBe("0");
  expect(rec.nobody, "nothing said nobody has joined beside the read that saw them").toEqual([]);
});

test("a member joins on the poll and the live read answers a moment later: Joined's count-up and flash carry over the rebuild, end on time and never come back", async ({ page }) => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  let watcher, e;
  try {
    watcher = await userAdmin(sa.api, sa.csrf, "wsjflash");
    e = await createEvent(sa.api, sa.csrf, "flash", { event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
    await enrol(sa.api, sa.csrf, e.id, [ev.p1.id, ev.p2.id]);
  } finally { await sa.api.dispose(); }

  await signInAs(page, watcher);
  await openWs(page, e);
  await expect(fig(page, "joined"), "PRECONDITION: Joined is the roster").toHaveAttribute("data-count", "2", { timeout: 15000 });
  // The polls are driven by hand from here (the timer stopped), so where a
  // poll falls against the join can never decide the order of the paints.
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  // Every live read answers 800 ms late: a poll first repaints the band for
  // the roster, and the read's answer rebuilds it while the change is showing.
  await page.route(pulseUrl(e.id), async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue().catch(() => {}); });
  const sa2 = await apiLogin("superadmin");
  try {
    const third = await person(sa2.api, sa2.csrf, "wsjflash3");
    await enrol(sa2.api, sa2.csrf, e.id, [third.id]);
  } finally { await sa2.api.dispose(); }
  const seen = await page.evaluate(() => new Promise((resolve) => {
    const tileNow = () => document.querySelector('#ws-kpis .ws-kpi[data-kpi-tile="joined"]');
    const out = { values: [] };
    const mo = new MutationObserver(() => {
      const t = tileNow();
      const span = t && t.querySelector(".ws-count");
      if (!out.first) {
        if (!span || span.dataset.count !== "3") return;
        out.first = t;
        setTimeout(() => { const n = tileNow(); out.replaced = !!n && n !== out.first; out.at1000 = !!n && n.classList.contains("ws-kpi-flash"); }, 1000);
        // Settled: then one more poll, whose read rebuilds the band with nothing changed.
        setTimeout(() => { const n = tileNow(); out.at1600 = !!n && n.classList.contains("ws-kpi-flash"); out.settled = n; window.refreshOverviewLive(); }, 1600);
      }
      if (span) out.values.push(span.textContent);
      if (out.settled && t && t !== out.settled && !out.done) {
        out.done = true;
        setTimeout(() => {
          const n = tileNow();
          mo.disconnect();
          resolve({ replaced: out.replaced, at1000: out.at1000, at1600: out.at1600, later: !!n && n.classList.contains("ws-kpi-flash"), values: out.values });
        }, 300);
      }
    });
    mo.observe(document.getElementById("ws-kpis"), { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => { mo.disconnect(); resolve(null); }, 20000);
    // One poll, as the timer runs it: the events model, then the live parts.
    window.loadAdminCompetitions().then(() => window.refreshOverviewLive());
  }));
  expect(seen, "the poll brought the new roster, and a later read rebuilt the band").not.toBeNull();
  expect(seen.replaced, "PRECONDITION: the read's answer rebuilt the band while the change was showing").toBe(true);
  expect(seen.at1000, "the rebuilt tile carries the flash on").toBe(true);
  expect(seen.at1600, "…which ends on time, not 1.2 s after the rebuild").toBe(false);
  expect(seen.later, "a later rebuild with nothing changed never flashes").toBe(false);
  const nums = seen.values.map(Number);
  expect(nums.every((v, i) => i === 0 || v >= nums[i - 1]), `the count never goes back: ${seen.values.join(",")}`).toBe(true);
});
