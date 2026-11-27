// The event workspace's Overview as a command centre built around the
// organiser's jobs, decided by the event's STATE and its wire policy keys:
//  (1) every KPI figure is a large display number (a computed font size of at
//      least 28 px and no chip fill) — never the tab strip's count chip;
//  (2) the section tab strip is a raised track with a fill of its own, and the
//      active tab is a filled segment;
//  (3) the face of the page per state, never a leaderboard (it lives in
//      Rankings): upcoming = the "Ready to start?" checklist (no chart); live =
//      the countdown hero, the attention row (nobody joined → "Show me" focuses
//      the header's join pill), Progress with the solve rates, and the walk-up
//      QR card on a Booth Event; ended = the final progress and the
//      certificates card with Download top 3. The challenge set, the chart and
//      the organisers are behind ONE "Show …" toggle. What each state SAYS is
//      locked in tests/workspace-overview-states.spec.js;
//  (4) no horizontal page scroll at 390 px in any of those states.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE, gradingHashFor } = require("./helpers");
const { adminLogin, clickTab, viewComp } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `ov-layout-key-${stamp}`;
const ev = {};
const people = [];
let sa, saCsrf;

async function mk(name, data) {
  const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `${name} ${stamp}`, ...data } });
  expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  return { id: d.competition?.id || d.id, name: `${name} ${stamp}` };
}

async function solve(email, compId, taskId, answer) {
  const s = await apiLogin(email, PARTICIPANT_PASS);
  try {
    const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
    const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf), data: { answer, gradingHash: await gradingHashFor(s.api, taskId) } });
    expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  } finally { await s.api.dispose(); }
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  const now = Date.now();
  // Booth: live, walk-ups on, nobody joined yet.
  ev.booth = await mk("OvBooth", { event_kind: "booth", start_time: new Date(now - 5 * 60_000).toISOString(), duration_minutes: 60, self_enroll_enabled: true });
  // Tournament, upcoming.
  ev.up = await mk("OvUpcoming", { event_kind: "tournament", start_time: new Date(now + 26 * 3600_000).toISOString(), duration_minutes: 120 });
  // Program (unranked), live, one participant has solved one of two.
  ev.prog = await mk("OvProgram", { event_kind: "program", start_time: new Date(now - 86400_000).toISOString(), deadline_at: new Date(now + 20 * 86400_000).toISOString() });
  // Tournament that ends after a solve.
  ev.end = await mk("OvEnded", { event_kind: "tournament", start_time: new Date(now - 30 * 60_000).toISOString(), duration_minutes: 120 });
  const t1 = await makeTask(sa, saCsrf, "ovl1", { correct_answer: KEY });
  const t2 = await makeTask(sa, saCsrf, "ovl2", { correct_answer: KEY, difficulty: "hard" });
  for (const t of [t1, t2]) await assignTask(sa, saCsrf, t.id, [ev.booth.id, ev.up.id, ev.prog.id, ev.end.id]);
  for (let i = 0; i < 2; i++) people.push(await makeParticipant(sa, saCsrf, `ovl${i}`));
  await enrol(sa, saCsrf, ev.prog.id, [people[0].id]);
  await enrol(sa, saCsrf, ev.end.id, people.map(p => p.id));
  expect((await solve(people[0].email, ev.prog.id, t1.id, KEY)).correct, "the learner solves one").toBe(true);
  expect((await solve(people[0].email, ev.end.id, t1.id, KEY)).correct, "a solve on the event that ends").toBe(true);
  expect((await solve(people[1].email, ev.end.id, t2.id, KEY)).correct, "a second scorer").toBe(true);
  const end = await sa.post(`/api/admin/competitions/${ev.end.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.ok(), `End now: ${await end.text()}`).toBeTruthy();
  // challenge_events are written post-commit: wait for the pulse to see them.
  await expect.poll(async () => (await (await sa.get(`/api/admin/competitions/${ev.prog.id}/overview-pulse`)).json()).totals?.solvers,
    { timeout: 15000, message: "the program's solve reaches the pulse" }).toBe(1);
});

test.afterAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  for (const c of Object.values(ev)) await api.delete(`/api/admin/competitions/${c.id}`, { headers: H(csrf) }).catch(() => {});
  for (const p of people) await api.delete(`/api/admin/participants/${p.id}`, { headers: H(csrf) }).catch(() => {});
  await api.dispose();
});

async function openOverview(page, key, state) {
  await adminLogin(page);
  await clickTab(page, "Events");
  await viewComp(page, ev[key].name);
  await expect(page.locator("#ws-overview"), "the Overview names its state").toHaveAttribute("data-ov-state", state, { timeout: 20000 });
}

/** Overflowing elements, for the failure message. */
async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll("#admin-page *")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 0.5) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].join(".")} right=${Math.round(r.right)}`);
      if (out.length > 8) break;
    }
    return { scroll: document.documentElement.scrollWidth - vw, out };
  });
}

test("every KPI is a large figure, and the tab strip is a raised track with a filled active tab", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOverview(page, "booth", "live");
  const tiles = page.locator("#ws-kpis .ws-kpi");
  await expect(page.locator('#ws-kpis .ws-kpi[data-kpi-tile="active"] .ws-count'), "the live figures arrive").toHaveCount(1, { timeout: 15000 });
  const figs = await tiles.evaluateAll(els => els.map(t => {
    const num = t.querySelector(".ws-kpi-num");
    const inner = num.querySelector(".ws-count, .ws-kpi-text");
    const cs = getComputedStyle(inner);
    return { key: t.dataset.kpiTile, size: parseFloat(cs.fontSize), bg: cs.backgroundColor, h: inner.getBoundingClientRect().height };
  }));
  // No answers yet on this event: no Answers figure (it would only say 0).
  expect(figs.map(f => f.key), "a live event: the countdown first, then playing now and joined").toEqual(["time", "active", "joined"]);
  for (const f of figs) {
    expect(f.size, `${f.key}: a display figure, not a chip (font-size)`).toBeGreaterThanOrEqual(28);
    expect(f.bg, `${f.key}: no chip fill behind the figure`).toBe("rgba(0, 0, 0, 0)");
    expect(f.h, `${f.key}: the figure's box is as tall as its type`).toBeGreaterThanOrEqual(28);
  }
  // CONTROL: the tab strip's count chip IS a chip — the two must stay apart.
  const chip = await page.locator('#ws-tabs .ws-tab[data-section="admin-tasks-tab"] .ws-count').evaluate(el => {
    const cs = getComputedStyle(el); return { size: parseFloat(cs.fontSize), bg: cs.backgroundColor };
  });
  expect(chip.size, "CONTROL: the tab count is small").toBeLessThan(16);
  expect(chip.bg, "CONTROL: the tab count has its chip fill").not.toBe("rgba(0, 0, 0, 0)");

  // These are the strip's RESTING fills, and a hovered idle tab is filled
  // (`.ws-tab:hover`). The pointer stays where viewComp clicked the Events row,
  // straight below the Participants tab, so a layout a little taller above the
  // strip put it on that tab: CI read the hover fill there twice. Park it in
  // the header's corner, and check the tab is not hovered, before reading.
  await page.mouse.move(2, 2);
  const strip = await page.evaluate(() => {
    const track = document.getElementById("ws-tabs");
    const active = track.querySelector(".ws-tab.active");
    const idle = track.querySelector(".ws-tab:not(.active)");
    const page = getComputedStyle(document.getElementById("admin-page")).backgroundColor;
    const body = getComputedStyle(document.body).backgroundColor;
    const t = getComputedStyle(track);
    const r = idle.getBoundingClientRect();
    return { track: t.backgroundColor, border: t.borderTopWidth, page, body,
      active: getComputedStyle(active).backgroundColor, idle: getComputedStyle(idle).backgroundColor,
      activeText: active.textContent.trim(), idleHovered: idle.matches(":hover"),
      idleBox: `${idle.textContent.trim()} at ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}` };
  });
  expect(strip.idleHovered, `precondition: the idle tab is not under the pointer (${strip.idleBox}; pointer parked at 2,2)`).toBe(false);
  expect(strip.activeText, "the Overview tab is the active one").toBe("Overview");
  expect(strip.track, "the track has a fill").not.toBe("rgba(0, 0, 0, 0)");
  expect(strip.track, "…distinct from the page").not.toBe(strip.body);
  expect(strip.track).not.toBe(strip.page);
  expect(parseFloat(strip.border), "…and an edge").toBeGreaterThan(0);
  expect(strip.active, "the active tab is a filled segment").not.toBe("rgba(0, 0, 0, 0)");
  expect(strip.active, "…distinct from the track").not.toBe(strip.track);
  expect(strip.idle, "an idle tab is not filled").toBe("rgba(0, 0, 0, 0)");
});

test("live booth: countdown hero, the attention row points at the join pill, the walk-up card; detail is one press away", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOverview(page, "booth", "live");
  await expect(page.locator('#ws-kpis .ws-kpi:first-child')).toHaveAttribute("data-kpi-tile", "time");
  await expect(page.locator('#ws-kpis .ws-kpi-hero .eyebrow')).toContainText("Time left");
  await expect(page.locator("#ws-kpis .ws-kpi-hero .ws-kpi-bar"), "live: the bar of the event gone").toBeVisible();
  const attn = page.locator("#ws-ov-attn");
  await expect(attn, "nobody has joined: the attention row says so").toContainText("Nobody has joined yet", { timeout: 15000 });
  await expect(attn.locator(".ws-allclear"), "…so it is not 'all clear'").toHaveCount(0);
  await expect(page.locator("#ws-ov-progress"), "progress, not a leaderboard, is on the face").toBeVisible();
  await expect(page.locator("#ws-ov-board"), "no leaderboard on the organiser's Overview").toHaveCount(0);
  await expect(page.locator("#ws-ov-join [data-action=\"ws-ov-qr\"]"), "walk-ups: the full-screen QR is within reach").toBeVisible();
  await expect(page.locator(".ws-ticker-card"), "no activity yet: no empty feed card").toBeHidden();
  // Detail: hidden until asked for, then in place.
  await expect(page.locator("#ws-ov-detail")).toBeHidden();
  await expect(page.locator("#ws-ov-tasks")).toBeHidden();
  await expect(page.locator("#ws-ov-chart")).toBeHidden();
  await page.locator("#ws-ov-detail-more").click();
  await expect(page.locator("#ws-ov-detail-more")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#ws-ov-tasks")).toBeVisible();
  await expect(page.locator("#ws-ov-chart"), "no activity: an empty state, not a flat line").toContainText("No joins or answers");
  await expect(page.locator("#ws-ov-chart svg")).toHaveCount(0);
  // "Show me" moves focus to the header's own control rather than repeating it.
  await attn.locator('[data-action="ws-point"]').click();
  await expect(page.locator("#ws-join .ws-join-pill"), "Show me focuses the join pill").toBeFocused();
});

test("upcoming: the Ready to start? checklist, each open item with its fix; no board", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOverview(page, "up", "upcoming");
  const ready = page.locator("#ws-ov-ready");
  await expect(ready).toBeVisible();
  await expect(ready.locator(".ws-ready-item"), "challenges, join link, people, sessions").toHaveCount(4, { timeout: 15000 });
  const todo = ready.locator('.ws-ready-item[data-ready="todo"]');
  await expect(todo, "nobody has joined: one item to do").toHaveCount(1);
  await expect(todo).toContainText("Nobody has joined yet");
  await expect(todo.locator('[data-action="ws-point"][data-target="invite"]'), "…with Show me pointing at Invite").toBeVisible();
  await expect(ready.locator('.ws-ready-item[data-ready="info"]').filter({ hasText: "Join link is off" }).locator('[data-action="comp-self-enroll"]'),
    "the join link is off: its settings door").toBeVisible();
  await expect(page.locator("#ws-ov-board"), "no board before the start").toHaveCount(0);
  await expect(page.locator("#ws-ov-chart"), "the chart is not on the face").toBeHidden();
  await expect(page.locator('#ws-kpis .ws-kpi-hero .eyebrow')).toContainText("Starts in");
  await todo.locator('[data-action="ws-point"]').click();
  await expect(page.locator('#ws-quick .ws-invite-btn'), "Show me focuses Invite").toBeFocused();
});

test("live program (unranked): progress and solve rates on the face; no board, no Answers figure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOverview(page, "prog", "live");
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-ranked", "false");
  const prog = page.locator("#ws-ov-progress");
  await expect(prog).toContainText("of 1 solved every challenge", { timeout: 15000 });
  await expect(prog).toContainText("1 of 1 have solved at least one");
  await expect(page.locator("#ws-ov-rates"), "the solve rates are on the face").toBeVisible();
  await expect(page.locator("#ws-ov-rates")).toContainText("1 of 1");
  await expect(page.locator("#ws-ov-board"), "an unranked event has no board").toHaveCount(0);
  await expect(page.locator('#ws-kpis .ws-kpi[data-kpi-tile="answers"]'), "no Answers figure").toHaveCount(0);
  await expect(page.locator('#ws-kpis .ws-kpi-hero .eyebrow')).toContainText("Until the deadline");
});

test("ended: final progress and the certificates card with Download top 3; no board, no checklist", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOverview(page, "end", "ended");
  await expect(page.locator("#ws-ov-progress"), "the final progress").toContainText("solved every challenge", { timeout: 15000 });
  await expect(page.locator("#ws-ov-board"), "no leaderboard on the organiser's Overview").toHaveCount(0);
  await expect(page.locator("#ws-ov-certs"), "were the certificates sent?").toBeVisible();
  await expect(page.locator(".ws-certs-card .ws-top3-btn"), "Download top 3 sits on the certificates card").toBeVisible();
  await expect(page.locator("#ws-ov-ready")).toHaveCount(0);
  await expect(page.locator("#ws-ov-attn .ws-allclear"), "no live 'all clear' after the end").toHaveCount(0);
  await expect(page.locator('#ws-kpis .ws-kpi[data-kpi-tile="active"]'), "no 'playing now' after the end").toHaveCount(0);
});

test("every section tab fits the strip at 1280 px, so Settings is never cut off", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverview(page, "booth", "live");
  const strip = page.locator("#ws-tabs");
  await expect(strip.locator('[data-section="admin-event-settings-tab"]')).toBeVisible();
  const m = await strip.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth, tabs: el.querySelectorAll(".ws-tab").length }));
  // CONTROL: the strip holds its sections, so a fit cannot come from an empty one.
  expect(m.tabs).toBeGreaterThanOrEqual(9);
  expect(m.scroll, `the strip needs ${m.scroll} px and has ${m.client}`).toBeLessThanOrEqual(m.client);
});

test("no horizontal page scroll at 390 px, in every state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [key, state] of [["booth", "live"], ["up", "upcoming"], ["prog", "live"], ["end", "ended"]]) {
    await openOverview(page, key, state);
    await page.locator("#ws-overview .ws-card").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#ws-ov-detail-more").click();
    await expect(page.locator("#ws-ov-detail")).toBeVisible();
    const o = await overflow(page);
    expect(o.scroll, `${key}: no sideways scroll at 390 px; overflowing: ${o.out.join(", ")}`).toBeLessThanOrEqual(0);
    // CONTROL: the measurement sees the page (the Overview really rendered).
    expect(await page.locator("#ws-overview .ws-card").count()).toBeGreaterThan(1);
  }
});
