// @ts-check
//
// THE PARTICIPANT PULSE, CLIENT HALF (public/js/features/participant-tasks.js
// `_pulseTick`, leaderboard.js `_lbPollDue`, session-monitor.js `_sessionMonTick`).
//
// A participant in a live event used to send, per tab: /api/status + /api/me every
// 15 s, /api/session/status + a keepalive POST every 30 s, and the whole board every
// 15 s while it was open. The locks below hold what replaced that, each beside a
// control that shows the witness can see the thing it says is absent:
//
//   1. On the challenge page the ONLY timer-driven request is the pulse: no
//      /api/status, /api/me, /api/session/status, leaderboard or keepalive in a
//      35 s window, and at least one pulse (the positive control) — and a pulse
//      paints the score pill /api/me used to.
//   2. A hidden tab pulses not at all: a tick that answers while hidden does not
//      reschedule, and nothing is sent for 20 s; the return re-enters the view at
//      once (control: the /api/status the resume sends).
//   3. The decisions, driven directly: the jittered cadence and its idle slowdown;
//      the board fetched only on a new version or past the one-minute floor; the
//      session monitor reading a fresh pulse instead of asking (control: a stale
//      one asks); the keepalive only once the expiry is within its margin
//      (control: inside the margin it is sent).
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, gradingHashFor, registerPost, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const crypto = require("crypto");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test.use({ baseURL: BASE });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

async function mkParticipant(sa, saCsrf, nick) {
  const email = `pu_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Pu", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), `register ${nick}: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const listed = await (await sa.get(`/api/admin/participants?limit=5000`)).json();
  const u = (listed.participants || []).find(p => p.email === email);
  expect(u, `participant ${nick} exists`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
  return { id: u.id, email, nick };
}

/** A participant of their own, enrolled in one live event of their own with two challenges. */
async function fixture() {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `PU ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }})).json()).competition.id;
    const mkTask = async (n) => (await (await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `PU-${n} ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published",
    }})).json()).id;
    const task1 = await mkTask(1), task2 = await mkTask(2);
    for (const id of [task1, task2]) await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
    const p = await mkParticipant(sa, csrf, `p${t}`);
    const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [compId] } })).json();
    expect(asg.assigned, `assigned: ${JSON.stringify(asg)}`).toBe(1);
    return { compId, task1, task2, p };
  } finally { await sa.dispose(); }
}

/** Sign in in the browser and land on the event's challenge page with the pulse armed. */
async function onChallengePage(page, f) {
  const { api, csrf } = await apiLogin(f.p.email);
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: f.compId } });
  expect(sel.ok(), `pre-select: ${await sel.text()}`).toBeTruthy();
  await api.dispose();
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => !!(window.S && window.S.statusPollInterval && window.S.currentCompetitionId)),
    { timeout: 20000, message: "PRECONDITION: the participant entered the event and the pulse is armed" }).toBe(true);
  await expect(page.locator("#tasks-page")).toHaveClass(/active/, { timeout: 10000 });
}

function recorder(page) {
  const seen = [];
  const on = (req) => { const u = new URL(req.url()); if (u.pathname.startsWith("/api/")) seen.push(`${req.method()} ${u.pathname}`); };
  page.on("request", on);
  return { seen, stop: () => page.off("request", on), count: (s) => seen.filter(x => x === s).length };
}

test("on the challenge page the only timer-driven request is the pulse, and it paints the score", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fixture();
  await onChallengePage(page, f);
  // The entry's own one-off reads (tasks, the score pill, the board) settle first:
  // only what the TIMERS send is under test.
  await page.waitForLoadState("networkidle");
  const rec = recorder(page);
  await page.waitForTimeout(35_000);
  rec.stop();
  const pulses = rec.count("GET /api/participant/pulse");
  expect(pulses, `positive control: the pulse ran (seen: ${rec.seen.join(", ")})`).toBeGreaterThanOrEqual(1);
  expect(pulses, "about one per 15 s (+/-20 %), never more").toBeLessThanOrEqual(3);
  for (const absent of ["GET /api/status", "GET /api/me", "GET /api/session/status", "GET /api/leaderboard", "POST /api/session/keepalive"]) {
    expect(rec.count(absent), `${absent} is no longer polled (seen: ${rec.seen.join(", ")})`).toBe(0);
  }
  // The pulse is what moves the score pill now: a wrong answer, then one tick.
  const csrf = await page.evaluate(() => window.S.csrfToken);
  const sub = await page.request.post(`/api/tasks/${f.task1}/submit`, { headers: H(csrf), data: { answer: "nope", gradingHash: await gradingHashFor(page.request, f.task1) } });
  expect(sub.ok(), `wrong answer: ${await sub.text()}`).toBeTruthy();
  const after = (await sub.json()).score;
  expect(typeof after, "the submit reports the new score").toBe("number");
  await page.evaluate(() => { document.getElementById("header-score").textContent = "stale"; });
  await page.evaluate(() => window._pulseTick());
  await expect(page.locator("#header-score")).toHaveText(`${after} pts`);
});

test("a hidden tab does not pulse; its return re-enters the view at once", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fixture();
  await onChallengePage(page, f);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // A tick that lands while hidden (an answer in flight at the hide) must not
  // schedule the next one: it leaves no pulse armed, recorded paused for the
  // return instead (participant-tasks.js _schedulePulse).
  const next = await page.evaluate(async () => {
    await window._pulseTick();
    return window.S.statusPollInterval;
  });
  expect(next, "a hidden tick arms no next pulse").toBeNull();
  const rec = recorder(page);
  await page.waitForTimeout(20_000);
  expect(rec.count("GET /api/participant/pulse"), `no pulse while hidden (seen: ${rec.seen.join(", ")})`).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => rec.count("GET /api/status"), { timeout: 8000, message: "CONTROL: the return re-entered the view" }).toBeGreaterThanOrEqual(1);
  rec.stop();
  await expect.poll(() => page.evaluate(() => !!window.S.statusPollInterval), { timeout: 8000 }).toBe(true);
});

test("the decisions: jittered cadence, version-gated board, pulse-fed session monitor, throttled keepalive", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await fixture();
  await onChallengePage(page, f);

  // Cadence: 15 s +/-20 % with recent intent; 30 s +/-20 % once idle and unchanged.
  const cad = await page.evaluate(() => {
    const S = window.S;
    const sample = () => Array.from({ length: 300 }, () => window._pulseDelay());
    S._lastIntentAt = Date.now(); S._pulseUnchanged = 10;
    const active = sample();
    S._lastIntentAt = Date.now() - 120_000; S._pulseUnchanged = 10;
    const idle = sample();
    S._lastIntentAt = Date.now() - 120_000; S._pulseUnchanged = 0;
    const changed = sample();
    const stat = (a) => ({ min: Math.min(...a), max: Math.max(...a), distinct: new Set(a).size });
    return { active: stat(active), idle: stat(idle), changed: stat(changed), base: window.PULSE_BASE_MS, idleMs: window.PULSE_IDLE_MS };
  });
  expect(cad.base).toBe(15000);
  expect(cad.idleMs).toBe(30000);
  expect(cad.active.min).toBeGreaterThanOrEqual(12000); expect(cad.active.max).toBeLessThanOrEqual(18000);
  expect(cad.active.distinct, "jitter: tabs do not share one delay").toBeGreaterThan(50);
  expect(cad.idle.min, "idle and unchanged slows to 30 s").toBeGreaterThanOrEqual(24000); expect(cad.idle.max).toBeLessThanOrEqual(36000);
  expect(cad.changed.max, "CONTROL: a change keeps the 15 s cadence even when idle").toBeLessThanOrEqual(18000);

  // Board: fetched only on a new version, an unknown one, or past the floor.
  const lb = await page.evaluate(() => {
    const S = window.S; const now = Date.now();
    S._lbVersionLatest = "1.4"; S._lbVersionLoaded = "1.4"; S._lbLoadedAt = now - 5000;
    const same = window._lbPollDue(now);
    S._lbVersionLatest = "1.5";
    const moved = window._lbPollDue(now);
    S._lbVersionLatest = "1.4"; S._lbLoadedAt = now - window.LB_FLOOR_MS - 1;
    const floor = window._lbPollDue(now);
    S._lbVersionLatest = undefined; S._lbLoadedAt = now;
    const unknown = window._lbPollDue(now);
    return { same, moved, floor, unknown };
  });
  expect(lb).toEqual({ same: false, moved: true, floor: true, unknown: true });

  // Session monitor + keepalive.
  const rec = recorder(page);
  await page.evaluate(async () => {
    const S = window.S; const M = window._sessionMon;
    const real = await (await fetch("/api/participant/pulse")).json();
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    M.lastActivityAt = Date.now();                       // an active user: the keepalive gate is open
    S._lastPulse = { at: Date.now(), session: { ...real.session, expires_at: at(59 * 60_000) } };
    await window._sessionMonTick();                      // fresh pulse, expiry far: nothing sent
    S._lastPulse = { at: Date.now(), session: { ...real.session, expires_at: at(10 * 60_000) } };
    await window._sessionMonTick();                      // fresh pulse, expiry inside the margin: keepalive
    S._lastPulse = { at: Date.now() - 10 * 60_000, session: real.session };
    await window._sessionMonTick();                      // stale pulse: asks /api/session/status
  });
  rec.stop();
  expect(rec.seen.filter(x => x !== "GET /api/participant/pulse"), "in order: the keepalive (only for the near expiry), then the stale tick's own session probe")
    .toEqual(["POST /api/session/keepalive", "GET /api/session/status"]);
});
