"use strict";

// THE TEAM & REPORTS SECTION, its layout and its offers (public/js/features/event-team.js).
//   • every table is an admin data table (ui/table-columns.js): cards at 390 px
//     with every control on screen and no sideways scroll, the default columns
//     inside the card at 1024 px;
//   • a failed report read is a failure with Try again, never a permission the
//     organiser lacks (the competitor's lock and the missing permission keep
//     their own sentences);
//   • the targets are offered only where the PUT is allowed (a competitor sees
//     them, with the reason, and no Save);
//   • the managers' comparison is read once per event and kept across a save
//     (other events' figures, which a save does not move);
//   • a second targets save before the first one's reload lands sends the
//     version the first saved, and one save is out at a time;
//   • Recent reports and the scheduled line say when a send failed;
//   • the allowed-domain list's Save is hidden from a role that cannot save it.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, loginViaApi, openSettingsSection } = require("./ui-admin-helpers");
const { H, makeParticipant, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const STAMP = Date.now().toString(36);
const DAY = 86_400_000;

async function eventWithTeam(sa, csrf, extra = {}) {
  const dom = await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: ["corp.example"] } });
  expect(dom.ok(), await dom.text()).toBeTruthy();
  const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: { name: `Team ${STAMP} ${Math.random().toString(36).slice(2, 7)}`, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, ...extra } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const ev = (await r.json()).competition;
  // A long name and address, as wide as real rows get.
  const m = await sa.post(`/api/admin/competitions/${ev.id}/team`, { headers: H(csrf), data: { role: "marketing", name: "Maximiliana Wolfeschlegelsteinhausen", email: `maximiliana.wolfeschlegelsteinhausen.${STAMP}@corp.example` } });
  expect(m.ok(), await m.text()).toBeTruthy();
  const p = await makeParticipant(sa, csrf, "teamsectlead");
  await enrol(sa, csrf, ev.id, [p.id]);
  return { ev, p };
}

async function openTeam(page, ev) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-event-team-tab" }), { id: ev.id, n: ev.name });
  await expect(page.locator("#team-members-h")).toBeVisible({ timeout: 15000 });
}

test("every table is cards at 390 px, with Remove and Contacted on screen; the defaults fit at 1024 px", async ({ page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev;
  try { ({ ev } = await eventWithTeam(sa.api, sa.csrf)); } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await adminLogin(page);
  await openTeam(page, ev);
  await expect(page.locator('#ws-team [data-change-action="team-contacted"]').first(), "PRECONDITION: the lead list is drawn").toBeAttached({ timeout: 15000 });
  const geo = async () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const right = (sel) => [...document.querySelectorAll(sel)].map(e => e.getBoundingClientRect()).filter(r => r.width).map(r => Math.round(r.right));
    return {
      vw, docW: document.documentElement.scrollWidth,
      remove: right('#ws-team [data-action="team-remove"]'),
      contacted: right('#ws-team [data-change-action="team-contacted"]'),
      unlabelled: [...document.querySelectorAll("#ws-team table[data-tcols] tbody td")].filter(td => td.getBoundingClientRect().width && !td.hasAttribute("data-label") && td.colSpan < 2).length,
      tables: [...document.querySelectorAll("#ws-team table[data-tcols]")].filter(t => t.getBoundingClientRect().width).map(t => t.dataset.tcols),
    };
  });
  let g = await geo();
  expect(g.remove.length, `PRECONDITION: a Remove button: ${JSON.stringify(g)}`).toBeGreaterThan(0);
  expect(g.contacted.length, `PRECONDITION: a Contacted box: ${JSON.stringify(g)}`).toBeGreaterThan(0);
  expect(g.docW, `no sideways page scroll: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.vw);
  for (const r of [...g.remove, ...g.contacted]) expect(r, `every control is on screen: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.vw);
  expect(g.tables, "the members and the lead list are admin data tables").toEqual(expect.arrayContaining(["team-members", "team-leads"]));
  expect(g.unlabelled, `every card cell carries its column's label: ${JSON.stringify(g)}`).toBe(0);
  // Every persona's table, the same rule.
  for (const persona of ["se", "sales", "sdr", "manager"]) {
    await page.locator(`[data-action="team-persona"][data-persona="${persona}"]`).click();
    await expect(page.locator("#team-persona-view")).toHaveAttribute("data-persona", persona);
    g = await geo();
    expect(g.docW, `${persona}: no sideways page scroll: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.vw);
    expect(g.unlabelled, `${persona}: cards: ${JSON.stringify(g)}`).toBe(0);
  }
  // At 1024 px the default columns fit their card.
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.locator('[data-action="team-persona"][data-persona="marketing"]').click();
  await expect(page.locator('#ws-team table[data-tcols="team-leads"]')).toBeVisible();
  const fit = await page.evaluate(() => [...document.querySelectorAll("#ws-team table[data-tcols]")].filter(t => t.getBoundingClientRect().width)
    .map(t => { const host = t.closest(".table-card") || t.parentElement; return { key: t.dataset.tcols, table: Math.round(t.scrollWidth), host: host.clientWidth }; }));
  expect(fit.length).toBeGreaterThan(0);
  for (const f of fit) expect(f.table, `${f.key} fits its card: ${JSON.stringify(fit)}`).toBeLessThanOrEqual(f.host + 1);
});

test("a failed report read offers Try again, never a permission the organiser lacks", async ({ page }) => {
  const sa = await apiLogin("superadmin");
  let ev;
  try { ({ ev } = await eventWithTeam(sa.api, sa.csrf)); } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  const reportUrl = `**/api/admin/competitions/${ev.id}/team-report`;
  await page.route(reportUrl, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await openTeam(page, ev);
  const body = page.locator("#team-report-body");
  await expect(body.locator('[data-action="team-report-retry"]'), "a failure, with Try again").toBeVisible({ timeout: 15000 });
  await expect(body).not.toContainText("need permission");
  await expect(body).not.toContainText("compete in");
  await page.unroute(reportUrl);
  await body.locator('[data-action="team-report-retry"]').click();
  await expect(body.locator('[data-action="team-persona"]').first(), "CONTROL: read, the reports show").toBeVisible({ timeout: 15000 });
});

test("a competitor sees the targets with the reason and no Save; the managers' comparison is kept across a save", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev, compEv, adm;
  try {
    // An earlier ended Booth Event: the managers' comparison has one to average.
    const prev = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: { name: `Team prev ${STAMP}`, event_kind: "booth", start_time: new Date(Date.now() - 3 * DAY).toISOString(), duration_minutes: 60 } });
    expect(prev.ok(), await prev.text()).toBeTruthy();
    ({ ev } = await eventWithTeam(sa.api, sa.csrf));
    ({ ev: compEv } = await eventWithTeam(sa.api, sa.csrf, { staff_compete: true }));
    adm = await makeParticipant(sa.api, sa.csrf, "teamsectcomp");
    const pr = await sa.api.post(`/api/admin/participants/${adm.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } });
    expect(pr.ok(), await pr.text()).toBeTruthy();
    await enrol(sa.api, sa.csrf, compEv.id, [adm.id]);
  } finally { await sa.api.dispose(); }

  // The competing admin: the targets are shown read-only with the reason.
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const cp = await ctx.newPage();
  try {
    await loginViaApi(cp, adm.email, PARTICIPANT_PASS);
    await cp.goto("/");
    await expect(cp.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openTeam(cp, compEv);
    await expect(cp.locator("#team-targets-refusal"), "the reason, where the Save was").toBeVisible();
    await expect(cp.locator('[data-action="team-targets-save"]'), "no Save the PUT would refuse").toHaveCount(0);
    await expect(cp.locator("#team-lead-target")).toHaveAttribute("readonly", "");
  } finally { await ctx.close(); }

  // CONTROL (a superadmin): Save is offered; after it, the managers' comparison
  // is still shown, from the one read the view made when it opened.
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  const peerReads = [];
  page.on("request", (rq) => { if (rq.url().includes(`/api/admin/competitions/${ev.id}/team-report?peer=1`)) peerReads.push(rq.url()); });
  await openTeam(page, ev);
  await expect(page.locator("#team-targets-refusal")).toHaveCount(0);
  await page.locator('[data-action="team-persona"][data-persona="manager"]').click();
  const avgLeads = page.locator("#team-persona-view table.team-scorecard tbody tr").first().locator("td").nth(3);
  await expect(avgLeads, "the comparison is read when the view opens").not.toHaveText("—", { timeout: 15000 });
  expect(peerReads.length, "one read for the view").toBe(1);
  await page.locator("#team-lead-target").fill("12");
  const reloaded = page.waitForResponse((r) => r.url().endsWith(`/api/admin/competitions/${ev.id}/team`) && r.request().method() === "GET");
  await page.locator('[data-action="team-targets-save"]').click();
  await expect(page.locator(".toast").filter({ hasText: "Targets saved." })).toBeVisible({ timeout: 10000 });
  await reloaded;
  await expect(page.locator("#team-persona-view table.team-scorecard tbody tr").first().locator("td").nth(1), "the saved target shows").toHaveText("12", { timeout: 10000 });
  await expect(avgLeads, "and the comparison is still shown, not left blank").not.toHaveText("—", { timeout: 15000 });
  expect(peerReads.length, "kept across the save's reload, not read again").toBe(1);
});

test("a second targets save before the first one's reload lands is not refused as somebody else's; one save is out at a time", async ({ page }) => {
  test.setTimeout(60_000);
  const sa = await apiLogin("superadmin");
  let ev;
  try { ({ ev } = await eventWithTeam(sa.api, sa.csrf)); } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openTeam(page, ev);
  const puts = [];
  page.on("response", (r) => { if (r.request().method() === "PUT" && r.url().endsWith(`/api/admin/competitions/${ev.id}/team-targets`)) puts.push(r.status()); });
  // Every save starts a re-read of the team; hold it, so the next save cannot
  // take its version from that re-read.
  const teamUrl = `**/api/admin/competitions/${ev.id}/team`;
  const held = [];
  let teamReads = 0;
  page.on("response", (r) => { if (r.request().method() === "GET" && r.url().endsWith(`/api/admin/competitions/${ev.id}/team`)) teamReads++; });
  await page.route(teamUrl, (route) => { held.push(route); });
  try {
    await page.locator("#team-lead-target").fill("11");
    await page.locator('[data-action="team-targets-save"]').click();
    await expect.poll(() => puts.slice(), { timeout: 10000 }).toEqual([200]);
    await expect.poll(() => held.length, { timeout: 10000, message: "PRECONDITION: the save's re-read is held" }).toBeGreaterThan(0);
    await page.locator("#team-lead-target").fill("22");
    await page.locator('[data-action="team-targets-save"]').click();
    await expect.poll(() => puts.length, { timeout: 10000 }).toBe(2);
    expect(puts[1], "the second save carries the version the first one saved").toBe(200);
    await expect(page.locator(".toast").filter({ hasText: "changed by someone else" }), "no conflict nobody caused").toHaveCount(0);
  } finally {
    const n = held.length;
    for (const r of held) await r.continue().catch(() => {});
    await page.unroute(teamUrl);
    // The held re-reads land (and redraw the form) before the next step types.
    await expect.poll(() => teamReads, { timeout: 10000 }).toBeGreaterThanOrEqual(n);
  }
  await expect(page.locator("#team-lead-target")).toHaveValue("22");
  // One save at a time: two presses in one go send one PUT. The PUT is held, so
  // a second press that got through would be seen before the first answers.
  const putUrl = `**/api/admin/competitions/${ev.id}/team-targets`;
  const putReqs = [];
  await page.route(putUrl, (route) => { putReqs.push(route); });
  try {
    await page.locator("#team-lead-target").fill("33");
    await page.evaluate(() => { window.teamTargetsSave(); window.teamTargetsSave(); });
    await expect.poll(() => putReqs.length, { timeout: 10000 }).toBe(1);
    await expect(page.locator('#ws-team [data-action="team-targets-save"]'), "the button says a save is out").toBeDisabled();
    await putReqs[0].continue();
  } finally { await page.unroute(putUrl).catch(() => {}); }
  await expect.poll(async () => (await (await page.request.get(`/api/admin/competitions/${ev.id}/team`)).json()).targets.lead_target, { timeout: 10000 }).toBe(33);
  expect(putReqs.length, "the second press sent nothing").toBe(1);
});

test("Recent reports and the scheduled line say when a send failed", async ({ page }) => {
  const sa = await apiLogin("superadmin");
  let ev;
  try { ({ ev } = await eventWithTeam(sa.api, sa.csrf)); } finally { await sa.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  // The ledger and the job as the server sends them after a wrap-up whose SE send failed.
  const now = new Date().toISOString();
  await page.route(`**/api/admin/competitions/${ev.id}/team`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.pending = [{ kind: "wrapup", end_key: `end:${now}`, due_at: new Date(Date.now() + 300_000).toISOString(), passes: 1, last_error: "send_failed" }];
    d.recent_sends = [
      { kind: "wrapup", end_key: `end:${now}`, recipient: "mia@corp.example", persona: "marketing", status: "sent", created_at: now, sent_at: now },
      { kind: "wrapup", end_key: `end:${now}`, recipient: "sid@corp.example", persona: "se", status: "failed", created_at: now, sent_at: null },
    ];
    await route.fulfill({ response: res, json: d });
  });
  await openTeam(page, ev);
  const sends = page.locator("#ws-team .team-sends");
  await expect(sends.locator(".team-send")).toHaveText(/Wrap-up .*: 1 of 2 delivered — 1 could not be sent/);
  await expect(sends.locator(".team-send.is-bad"), "a failure is marked").toHaveCount(1);
  await expect(page.locator("#ws-team")).toContainText("(trying again: a send failed)");
});

test("the allowed-domain list's Save is hidden from an administrator who cannot save it", async ({ browser, page }) => {
  const sa = await apiLogin("superadmin");
  let adm;
  try {
    adm = await makeParticipant(sa.api, sa.csrf, "teamsectdom");
    const pr = await sa.api.post(`/api/admin/participants/${adm.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } });
    expect(pr.ok(), await pr.text()).toBeTruthy();
  } finally { await sa.api.dispose(); }
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const ap = await ctx.newPage();
  try {
    await loginViaApi(ap, adm.email, PARTICIPANT_PASS);
    await ap.goto("/");
    await expect(ap.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await ap.locator('.admin-nav-item[data-tab-id="admin-settings-tab"]').click();
    await openSettingsSection(ap, "email");
    await expect(ap.locator("#team-domains-note")).toHaveText("Only a superadmin changes this list.", { timeout: 15000 });
    await expect(ap.locator("#team-domains-save"), "the Save its PUT refuses is not on screen").toBeHidden();
  } finally { await ctx.close(); }
  // CONTROL: a superadmin's Save is there.
  await adminLogin(page);
  await page.locator('.admin-nav-item[data-tab-id="admin-settings-tab"]').click();
  await openSettingsSection(page, "email");
  await expect(page.locator("#team-domains-save")).toBeVisible({ timeout: 15000 });
});

test("a role that may read the reports but not mark contacts sees each lead's state, not a box it cannot save", async ({ browser, page }) => {
  const sa = await apiLogin("superadmin");
  let ev, reader;
  try {
    ({ ev } = await eventWithTeam(sa.api, sa.csrf));
    const role = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `Report reader ${STAMP}`, scope_mode: "all", permissions: ["panel.access", "events.view", "participants.view"] } });
    expect(role.ok(), `create role: ${await role.text()}`).toBeTruthy();
    reader = await makeParticipant(sa.api, sa.csrf, "teamsectreader");
    const pr = await sa.api.patch(`/api/admin/users/${reader.id}/role`, { headers: H(sa.csrf), data: { role: (await role.json()).role.id } });
    expect(pr.ok(), `assign role: ${await pr.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const rp = await ctx.newPage();
  try {
    await loginViaApi(rp, reader.email, PARTICIPANT_PASS);
    await rp.goto("/");
    await expect(rp.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openTeam(rp, ev);
    await expect(rp.locator('#team-persona-view table[data-tcols="team-leads"]'), "PRECONDITION: the lead list is readable").toBeVisible({ timeout: 15000 });
    await expect(rp.locator("#ws-team .team-contacted-ro").first()).toContainText("Not contacted");
    await expect(rp.locator('#ws-team [data-change-action="team-contacted"]'), "no box its route refuses").toHaveCount(0);
  } finally { await ctx.close(); }
  // CONTROL: a superadmin gets the box.
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openTeam(page, ev);
  await expect(page.locator('#ws-team [data-change-action="team-contacted"]').first()).toBeVisible({ timeout: 15000 });
});

// Every Team & reports table sorts and filters from its headings (PLAIN_TABLES in
// public/js/ui/table-columns.js). The report is the server's own answer with its
// lists replaced by rows whose values differ (a route over the tab's own read),
// so each sort moves rows and each enum filter has a value to keep and others to
// hide; the members are real. Each filter keeps a control row of the chosen value.
test("every Team & reports table sorts and filters from its headings", async ({ page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev;
  try {
    ({ ev } = await eventWithTeam(sa.api, sa.csrf));
    for (const who of ["Zed Member", "Amy Member"]) {
      const r = await sa.api.post(`/api/admin/competitions/${ev.id}/team`, { headers: H(sa.csrf), data: { role: "se", name: who, email: `${who.split(" ")[0].toLowerCase()}.${STAMP}@corp.example` } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }
  } finally { await sa.api.dispose(); }
  const lead = (first, signal, owner, id) => ({
    user_id: `u-${id}`, first_name: first, last_name: "Lead", email: `${first.toLowerCase()}@corp.example`, title: "Engineer", company: `${first} Co`,
    answers: {}, signal, status: "new", source: "Join link", owner_name: owner, owner_member_id: null, owner_preview: false,
    contacted_at: null, opted_out: false, seniority: 1, contactable: true,
  });
  await page.route(`**/api/admin/competitions/${ev.id}/team-report`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.challenges = [
      { title: "Zulu", attempters: 3, solvers: 3, solve_rate: 1, wrong: 0, flag: "too_easy", ratings: 0 },
      { title: "Alpha", attempters: 3, solvers: 0, solve_rate: 0, wrong: 9, flag: "too_hard", ratings: 0 },
      { title: "Mike", attempters: 3, solvers: 2, solve_rate: 0.66, wrong: 1, flag: null, ratings: 0 },
    ];
    body.accounts = [
      { company: "Zeta Co", people: 2, top_title: "CTO", answers: {}, signal: "hot" },
      { company: "Acme Co", people: 1, top_title: "Dev", answers: {}, signal: "warm" },
      { company: "Mid Co", people: 1, top_title: "Dev", answers: {}, signal: "warm" },
    ];
    body.leads = [lead("Zoe", "hot", "Owner One", 1), lead("Abe", "warm", "Owner Two", 2), lead("Max", "cold", "Owner One", 3)];
    await route.fulfill({ response: res, json: body });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await adminLogin(page);
  await openTeam(page, ev);

  const T = (key) => page.locator(`#ws-team table[data-tcols="${key}"]`);
  const firstCells = (key) => T(key).locator("tbody tr").filter({ visible: true }).locator("td:first-child").allInnerTexts();
  const lead1 = (key) => firstCells(key).then(a => a.map(t => t.split("\n")[0].trim()));
  const head = (key, col) => T(key).locator(`th[data-tcol-dsort="${col}"]`);
  const note = (key) => page.locator(`.tcol-bar[data-tcols-for="${key}"] .tcol-note`);
  async function pick(key, col, value) {
    const btn = T(key).locator("thead th").filter({ hasText: new RegExp(`^${col}$`, "i") }).locator(".tcol-hbtn");
    await btn.click();
    const pop = page.locator(".tcol-pop[role='dialog']");
    await expect(pop).toBeVisible();
    await pop.locator("select[data-tcol-input]").selectOption(value);
    await pop.locator("[data-tcol-done]").click();
    await expect(pop).toBeHidden();
  }
  // The bar's Clear: the filters and the sort, back to the drawn order.
  async function clearFilters(key) {
    await page.locator(`.tcol-bar[data-tcols-for="${key}"] .tcol-clear`).click();
  }

  // MEMBERS: Member filters by text; the other member is the control.
  await expect.poll(() => lead1("team-members")).toHaveLength(3);
  await T("team-members").locator("thead th").filter({ hasText: /^Member$/ }).locator(".tcol-hbtn").click();
  await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("Amy", { delay: 20 });
  await expect.poll(() => T("team-members").locator("tbody tr").filter({ visible: true }).allInnerTexts(), { message: "only Amy is left" })
    .toEqual([expect.stringContaining("Amy Member")]);
  await expect(note("team-members")).toContainText("Member");
  await page.locator(".tcol-pop [data-tcol-fclear]").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => lead1("team-members"), { message: "cleared, every member again" }).toHaveLength(3);

  // SOLUTIONS ENGINEER: Every challenge sorts by Challenge and filters by Flag.
  await page.locator('[data-action="team-persona"][data-persona="se"]').click();
  expect(await lead1("team-challenges"), "PRECONDITION: drawn in the report's order").toEqual(["Zulu", "Alpha", "Mike"]);
  await head("team-challenges", "challenge").click({ position: { x: 8, y: 10 } });
  await expect.poll(() => lead1("team-challenges")).toEqual(["Alpha", "Mike", "Zulu"]);
  await expect(head("team-challenges", "challenge")).toHaveAttribute("aria-sort", "ascending");
  await pick("team-challenges", "Flag", "Too hard");
  await expect.poll(() => lead1("team-challenges"), { message: "only the too-hard challenge is left" }).toEqual(["Alpha"]);
  await expect(note("team-challenges")).toContainText("Flag");
  await clearFilters("team-challenges");
  await expect.poll(() => lead1("team-challenges")).toHaveLength(3);

  // SALES: Accounts sorts by Company and filters by Signal.
  await page.locator('[data-action="team-persona"][data-persona="sales"]').click();
  expect(await lead1("team-accounts"), "PRECONDITION: most ready first").toEqual(["Zeta Co", "Acme Co", "Mid Co"]);
  await head("team-accounts", "company").click({ position: { x: 8, y: 10 } });
  await expect.poll(() => lead1("team-accounts")).toEqual(["Acme Co", "Mid Co", "Zeta Co"]);
  await expect(head("team-accounts", "company")).toHaveAttribute("aria-sort", "ascending");
  await pick("team-accounts", "Signal", "Warm");
  await expect.poll(() => lead1("team-accounts"), { message: "the warm accounts stay, the hot one goes" }).toEqual(["Acme Co", "Mid Co"]);
  await expect(note("team-accounts")).toContainText("Signal");
  await clearFilters("team-accounts");

  // MARKETING: the lead list sorts by Lead and filters by Signal and Owner;
  // Contacted (a control per row) neither sorts nor filters.
  await page.locator('[data-action="team-persona"][data-persona="marketing"]').click();
  expect(await lead1("team-leads"), "PRECONDITION: the report's order").toEqual(["Zoe Lead", "Abe Lead", "Max Lead"]);
  await head("team-leads", "lead").click({ position: { x: 8, y: 10 } });
  await expect.poll(() => lead1("team-leads")).toEqual(["Abe Lead", "Max Lead", "Zoe Lead"]);
  await pick("team-leads", "Signal", "Cold");
  await expect.poll(() => lead1("team-leads")).toEqual(["Max Lead"]);
  await clearFilters("team-leads");   // the sort too: the drawn order again
  await pick("team-leads", "Owner", "Owner One");
  await expect.poll(() => lead1("team-leads"), { message: "Owner One's two leads; Owner Two's goes" }).toEqual(["Zoe Lead", "Max Lead"]);
  await expect(note("team-leads")).toContainText("Owner");
  await clearFilters("team-leads");
  const contactedTh = T("team-leads").locator("thead th").filter({ hasText: /^Contacted$/ });
  await expect(contactedTh, "PRECONDITION: the Contacted heading").toHaveCount(1);
  await expect(contactedTh.locator(".tcol-hbtn"), "Contacted has no menu").toHaveCount(0);
  await expect(head("team-leads", "lead").locator(".tcol-hbtn"), "CONTROL: Lead has one").toHaveCount(1);

  // MANAGERS: the scorecard sorts by Measure; its Status column has no menu.
  await page.locator('[data-action="team-persona"][data-persona="manager"]').click();
  const measures = await lead1("team-scorecard");
  expect(measures.length, "PRECONDITION: the scorecard's rows").toBeGreaterThan(2);
  await head("team-scorecard", "measure").click({ position: { x: 8, y: 10 } });
  await expect.poll(() => lead1("team-scorecard")).toEqual([...measures].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  await expect(T("team-scorecard").locator('th[data-tcol="status"] .tcol-hbtn'), "Status has no menu").toHaveCount(0);
  await expect(head("team-scorecard", "measure").locator(".tcol-hbtn"), "CONTROL: Measure has one").toHaveCount(1);
});
