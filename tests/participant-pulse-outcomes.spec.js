// @ts-check
//
// WHAT THE PULSE IS FOR, DRIVEN THROUGH THE PULSE (public/js/features/
// participant-tasks.js `_pulseTick` / `_schedulePulse`, core/main.js's
// visibilitychange resume, session-monitor.js `_sessionMonTick`).
//
// tests/participant-pulse-ui.spec.js holds the cadence and the request set; these
// hold the outcomes, each beside a control:
//
//   1. A tab that enters the event while already hidden pulses not at all, and
//      its return re-enters the view and the pulse (no hide event ever recorded
//      a running poll for it).
//   2. The challenge view resumes too: hide and return while a challenge is open
//      re-enters the view (control: the /api/status the resume sends).
//   3. The pulse's answers: an extension moves the countdown's end; a 503 or 429
//      is a blip that ejects nobody and keeps the pulse going; an answer for an
//      event the tab has since left is dropped — whether the tab moved before the
//      headers (an "ended", a refusal that would eject) or while the body was
//      read; an early end is noticed (the control for the drop: the same
//      "ended", for the event still on screen); and a refusal that is not a blip
//      does eject (the control for the blip and for the stale refusal).
//   4. The keepalive's live-event arm keeps an IDLE participant's session alive
//      on its own (control: idle and not in a live event sends nothing), and a
//      hidden tab asks /api/session/status at most every two minutes — and,
//      when it does ask, still keeps a live event's session alive.
//   5. A score read for the event the tab has since left is not recorded as the
//      new event's progress or painted in its header — whether the tab moved
//      before the headers or while the body was read (control: in the same
//      event it is).
//   6. The pulse carries X-Client-Active only within a minute of the
//      participant's own input (control: an idle tab's pulse carries none), so
//      it banks presence for a person, never for a parked tab — the server half
//      is in tests/presence-display.spec.js.
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/** A live event of its own: a participant, an idle one (nothing auto-ends) and two challenges. */
async function liveEvent(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const comp = await makeCompetition(sa, csrf, label);
    const t1 = await makeTask(sa, csrf, `${label}-1`, { difficulty: "easy" });
    const t2 = await makeTask(sa, csrf, `${label}-2`);
    for (const t of [t1, t2]) await assignTask(sa, csrf, t.id, [comp.id]);
    const p = await makeParticipant(sa, csrf, label);
    const idle = await makeParticipant(sa, csrf, `${label}-idle`);
    await enrol(sa, csrf, comp.id, [p.id, idle.id]);
    return { comp, t1, t2, p };
  } finally { await sa.dispose(); }
}

/** Pre-select the event (so the sign-in resumes into it), sign in, and land on its challenge page. */
async function enter(page, f) {
  const P = await apiLogin(f.p.email);
  try {
    const sel = await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: f.comp.id } });
    expect(sel.ok(), `pre-select: ${await sel.text()}`).toBeTruthy();
  } finally { await P.api.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect.poll(() => page.evaluate((id) => !!(window.S && window.S.currentCompetitionId === id && window.S._inLiveCompetition), f.comp.id),
    { timeout: 20000, message: "PRECONDITION: the participant entered the live event" }).toBe(true);
  await expect(page.locator("#tasks-page")).toHaveClass(/active/, { timeout: 10000 });
}

function recorder(page) {
  const seen = [];
  const on = (req) => { const u = new URL(req.url()); if (u.pathname.startsWith("/api/")) seen.push(`${req.method()} ${u.pathname}`); };
  page.on("request", on);
  return { seen, stop: () => page.off("request", on), count: (s) => seen.filter((x) => x === s).length };
}

const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

test("a tab that enters the event already hidden does not pulse, and its return starts the pulse", async ({ page }) => {
  test.setTimeout(150_000);
  const f = await liveEvent("pohid");
  // Hidden from the first script on: no hide EVENT ever fires, so no poll is
  // recorded as paused by the visibility handler — the entry would arm the pulse
  // while hidden, which is the case under test.
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  const rec = recorder(page);
  await enter(page, f);
  // The entry's pulse is not armed while hidden: it is RECORDED as paused, which
  // is what the return resumes from (a hidden tab's visibility handler never ran).
  await expect.poll(() => page.evaluate(() => window.S._pausedIntervals.includes("statusPollInterval")),
    { timeout: 10000, message: "the entry recorded its pulse as paused" }).toBe(true);
  expect(await page.evaluate(() => window.S.statusPollInterval), "no pulse is armed in a hidden tab").toBeNull();
  expect(rec.count("GET /api/participant/pulse"), `no pulse while hidden (seen: ${rec.seen.join(", ")})`).toBe(0);
  rec.stop();

  // The return: only what it sends is counted from here.
  const back = recorder(page);
  await setHidden(page, false);
  await expect.poll(() => back.count("GET /api/status"), { timeout: 8000, message: "the return re-entered the view" }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => !!window.S.statusPollInterval), { timeout: 8000, message: "and armed the pulse" }).toBe(true);
  await expect.poll(() => back.count("GET /api/participant/pulse"), { timeout: 20_000, message: "which then pulses" }).toBeGreaterThanOrEqual(1);
  back.stop();
});

test("hiding and returning while a challenge is open re-enters the view", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await liveEvent("pordet");
  await enter(page, f);
  await page.evaluate((id) => window.openTask(id), f.t1.id);
  await expect(page.locator("#task-detail-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => !!window.S.statusPollInterval), { message: "PRECONDITION: the pulse runs" }).toBe(true);
  const rec = recorder(page);
  await setHidden(page, true);
  await setHidden(page, false);
  await expect.poll(() => rec.count("GET /api/status"), { timeout: 8000, message: "the challenge view resumed the polls" }).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#task-detail-page"), "and stayed on the challenge").toHaveClass(/active/);
  rec.stop();
});

test("the pulse's answers: extension, blips, a stale event, an early end, a refusal", async ({ page }) => {
  test.setTimeout(150_000);
  const f = await liveEvent("poans");
  await enter(page, f);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    // Driven by hand from here: the timer's own pulse must not land between a
    // change and its assertion. A stopped pulse's manual ticks rearm nothing
    // unless the step under test does.
    await page.evaluate(() => { clearTimeout(window.S.statusPollInterval); window.S.statusPollInterval = null; });
    const endMs = () => page.evaluate(() => window.S.hackathonEndTime.getTime());
    const before = await endMs();

    // EXTENSION: the countdown's end follows the server's.
    const put = await sa.put(`/api/admin/competitions/${f.comp.id}`, { headers: H(csrf), data: { duration_minutes: 660 } });
    expect(put.ok(), `extend: ${await put.text()}`).toBeTruthy();
    const status = await (await page.request.get("/api/status")).json();
    const serverEnd = new Date(status.end).getTime();
    expect(serverEnd - before, "precondition: the server's end moved by an hour").toBe(60 * 60_000);
    await page.evaluate(() => window._pulseTick());
    expect(await endMs(), "the pulse moved the countdown's end").toBe(serverEnd);

    // BLIPS: every attempt answers 503 (then 429). Nobody is ejected, and a
    // running pulse is rescheduled.
    for (const code of [503, 429]) {
      await page.route("**/api/participant/pulse", (r) => r.fulfill({ status: code, contentType: "application/json", body: '{"error":"busy"}' }));
      const handles = await page.evaluate(async () => {
        const S = window.S;
        S.statusPollInterval = setTimeout(() => {}, 600_000);   // a pulse that is running
        const h = S.statusPollInterval;
        await window._pulseTick();
        const next = S.statusPollInterval;
        clearTimeout(next); S.statusPollInterval = null;
        return { h, next };
      });
      await page.unroute("**/api/participant/pulse");
      expect(handles.next, `a ${code} keeps the pulse going`).not.toBeNull();
      expect(handles.next, `…as a NEW timer`).not.toBe(handles.h);
      expect(await page.evaluate(() => window.S.currentCompetitionId), `a ${code} ejects nobody`).toBe(f.comp.id);
      await expect(page.locator("#tasks-page")).toHaveClass(/active/);
    }

    // A STALE EVENT: an "ended" that lands after the tab left the event it was
    // asked for is dropped (the tab's generation moved mid-flight).
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/participant/pulse", async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      body.status = { ...body.status, status: "ended" };
      await gate;
      await r.fulfill({ response: res, json: body });
    });
    await page.evaluate(() => { window.__stalePulse = window._pulseTick(); });
    await page.evaluate(() => { window.S._compGen++; });
    release();
    await page.evaluate(() => window.__stalePulse);
    await page.unroute("**/api/participant/pulse");
    expect(await page.evaluate(() => window.S.hackathonEnded), "an answer for an event the tab left is dropped").toBe(false);

    // A STALE REFUSAL: a refusal answered for the event the tab has since left
    // throws nobody out of the one it is in now (the check on the headers).
    let release403;
    const gate403 = new Promise((r) => { release403 = r; });
    await page.route("**/api/participant/pulse", async (r) => {
      await gate403;
      await r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Not in this event"}' });
    });
    await page.evaluate(() => { window.__stale403 = window._pulseTick(); });
    await page.evaluate(() => { window.S._compGen++; });
    release403();
    await page.evaluate(() => window.__stale403);
    await page.unroute("**/api/participant/pulse");
    expect(await page.evaluate(() => window.S.currentCompetitionId), "a stale refusal ejects nobody").toBe(f.comp.id);
    await expect(page.locator("#tasks-page")).toHaveClass(/active/);

    // A STALE BODY: the tab moves on while the answer's body is read, after its
    // headers were checked — what it says is dropped too (the check after parsing).
    await page.route("**/api/participant/pulse", async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      body.status = { ...body.status, status: "ended" };
      await r.fulfill({ response: res, json: body });
    });
    await page.evaluate(async () => {
      const f0 = window.fetch;
      window.fetch = async function (u) {
        const res = await f0.apply(this, arguments);
        if (String(u).includes("/api/participant/pulse")) {
          window.fetch = f0;
          const parse = res.json.bind(res);
          res.json = async () => { window.S._compGen++; return parse(); };
        }
        return res;
      };
      await window._pulseTick();
    });
    await page.unroute("**/api/participant/pulse");
    expect(await page.evaluate(() => window.S.hackathonEnded), "an answer whose event the tab left mid-read is dropped").toBe(false);

    // AN EARLY END, for the event on screen: noticed (the drop's control).
    const end = await sa.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end now: ${await end.text()}`).toBeTruthy();
    await page.evaluate(() => window._pulseTick());
    expect(await page.evaluate(() => window.S.hackathonEnded), "the pulse noticed the early end").toBe(true);
    await expect(page.locator("#modal-overlay.open")).toContainText("has ended");
    await page.getByRole("button", { name: "Close" }).click();

    // A REFUSAL that is not a blip ejects (the blips' control).
    await page.route("**/api/participant/pulse", (r) => r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Not in this event"}' }));
    await page.evaluate(() => window._pulseTick());
    await page.unroute("**/api/participant/pulse");
    await expect(page.locator("#competitions-page")).toHaveClass(/active/, { timeout: 10000 });
    expect(await page.evaluate(() => window.S.currentCompetitionId)).toBeNull();
  } finally { await sa.dispose(); }
});

test("the keepalive keeps an idle participant in a live event signed in; a hidden tab asks at most every two minutes", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await liveEvent("poka");
  await enter(page, f);
  // Every tick below is driven by hand: the monitor's own 30 s timer and the
  // pulse (which refreshes S._lastPulse) are stopped first.
  await page.evaluate(() => {
    window.stopSessionMonitor();
    clearTimeout(window.S.statusPollInterval); window.S.statusPollInterval = null;
  });
  const real = await (await page.request.get("/api/participant/pulse")).json();
  const rec = recorder(page);
  const run = (fn, arg) => page.evaluate(fn, arg);

  // IDLE (no input for ten minutes), in a live event, expiry inside the margin:
  // the live-event arm alone sends the keepalive.
  await run(async (session) => {
    const S = window.S; const M = window._sessionMon;
    M.lastActivityAt = Date.now() - 10 * 60_000;
    S._lastPulse = { at: Date.now(), session: { ...session, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } };
    await window._sessionMonTick();
  }, real.session);
  expect(rec.count("POST /api/session/keepalive"), `the live-event arm on its own (seen: ${rec.seen.join(", ")})`).toBe(1);

  // CONTROL: idle and NOT in a live event — nothing keeps the session alive.
  await run(async (session) => {
    const S = window.S; const M = window._sessionMon;
    M.lastActivityAt = Date.now() - 10 * 60_000;
    const was = S._inLiveCompetition;
    S._inLiveCompetition = false;
    S._lastPulse = { at: Date.now(), session: { ...session, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } };
    try { await window._sessionMonTick(); } finally { S._inLiveCompetition = was; }
  }, real.session);
  expect(rec.count("POST /api/session/keepalive"), "CONTROL: an idle participant outside a live event sends none").toBe(1);

  // HIDDEN: with no fresh pulse to read, a tab asked a minute ago does not ask again…
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  });
  await run(async () => {
    const S = window.S; const M = window._sessionMon;
    S._lastPulse = null;
    M.lastAskedAt = Date.now() - 60_000;
    await window._sessionMonTick();
  });
  expect(rec.count("GET /api/session/status"), "a hidden tab asked a minute ago does not ask").toBe(0);
  // …but past two minutes it asks, and the answer still keeps a live event's
  // session alive for an idle participant (the expiry is stubbed into the margin).
  await page.route("**/api/session/status", async (r) => {
    const res = await r.fetch();
    const d = await res.json();
    d.expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
    await r.fulfill({ response: res, json: d });
  });
  await run(async () => {
    const M = window._sessionMon;
    M.lastActivityAt = Date.now() - 10 * 60_000;
    M.lastAskedAt = Date.now() - 3 * 60_000;
    await window._sessionMonTick();
  });
  await page.unroute("**/api/session/status");
  expect(rec.count("GET /api/session/status"), "CONTROL: past two minutes the hidden tab asks").toBe(1);
  expect(rec.count("POST /api/session/keepalive"), "and a hidden, idle tab in a live event still keeps its session").toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); });
  rec.stop();
});

test("a score read for the event the tab has left is not recorded or painted as the new event's", async ({ page }) => {
  test.setTimeout(120_000);
  const fA = await liveEvent("posca");
  // A second live event for the same participant, where they have scored nothing.
  const { api: sa, csrf } = await apiLogin("superadmin");
  let compB;
  try {
    compB = await makeCompetition(sa, csrf, "poscb");
    const tB = await makeTask(sa, csrf, "poscb-1");
    await assignTask(sa, csrf, tB.id, [compB.id]);
    await enrol(sa, csrf, compB.id, [fA.p.id]);
  } finally { await sa.dispose(); }
  // In A the participant scores 50.
  const P = await apiLogin(fA.p.email);
  try {
    expect((await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: fA.comp.id } })).ok()).toBeTruthy();
    const r = await P.api.post(`/api/tasks/${fA.t1.id}/submit`, { headers: H(P.csrf), data: { answer: "a", gradingHash: await gradingHashFor(P.api, fA.t1.id) } });
    expect((await r.json()).correct, "precondition: 50 points in A").toBe(true);
  } finally { await P.api.dispose(); }
  await enter(page, fA);
  // The pulse records the score too: stopped, so the reads below are the only writers.
  await page.evaluate(() => { clearTimeout(window.S.statusPollInterval); window.S.statusPollInterval = null; });

  // CONTROL: in the same event, a score read is painted and recorded.
  await page.evaluate((id) => { window.recordProgress(id, { score: -1 }); return window.refreshScore(); }, fA.comp.id);
  await expect.poll(() => page.evaluate((id) => (window.progressFor(id) || {}).score, fA.comp.id), { message: "CONTROL: A's score recorded" }).toBe(50);
  await expect(page.locator("#header-score")).toHaveText("50 pts");

  // A STALE BODY: the tab moves on while the answer's body is read, after its
  // headers were checked — what it says is dropped too (the check after parsing).
  // The read goes through a wrapper that can move the generation inside the
  // body read; its control is the same wrapper leaving the generation alone.
  const readScore = (bump) => page.evaluate(async ([id, move]) => {
    window.recordProgress(id, { score: -1 });
    document.getElementById("header-score").textContent = "-1 pts";
    const f0 = window.fetch;
    let wrapped = false;
    window.fetch = async function (u) {
      const res = await f0.apply(this, arguments);
      if (String(u) === "/api/me") {
        wrapped = true;
        const parse = res.json.bind(res);
        res.json = async () => { if (move) window.S._compGen++; return parse(); };
      }
      return res;
    };
    try { await window.refreshScore(); } finally { window.fetch = f0; }
    return { wrapped, recorded: (window.progressFor(id) || {}).score, painted: document.getElementById("header-score").textContent };
  }, [fA.comp.id, bump]);
  expect(await readScore(false), "CONTROL: through the same wrapper, an unmoved read is recorded and painted")
    .toEqual({ wrapped: true, recorded: 50, painted: "50 pts" });
  expect(await readScore(true), "a read whose event the tab left while its body was read is dropped")
    .toEqual({ wrapped: true, recorded: -1, painted: "-1 pts" });

  // A read for A is answered, then held back while the tab moves to B.
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = false;
  await page.route("**/api/me", async (r) => {
    if (held) return r.continue();
    held = true;
    const res = await r.fetch();
    await gate;
    await r.fulfill({ response: res });
  });
  await page.evaluate(() => { window.__staleScore = window.refreshScore(); });
  await expect.poll(() => held, { message: "precondition: the read for A is out" }).toBe(true);
  await page.locator("#nav-competitions").click();
  await expect(page.locator("#competitions-page")).toHaveClass(/active/, { timeout: 10000 });
  // Into B: the select reads B's own score (through the hold, which is one-shot).
  await page.evaluate((id) => window.selectCompetition(id), compB.id);
  await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { timeout: 10000 }).toBe(compB.id);
  await expect(page.locator("#header-score"), "precondition: B's own score is painted").toHaveText("0 pts", { timeout: 10000 });
  await expect.poll(() => page.evaluate((id) => (window.progressFor(id) || {}).score, compB.id), { message: "precondition: and recorded" }).toBe(0);
  release();
  // The stale read has run to its end — body read and all — before the checks.
  await page.evaluate(() => window.__staleScore);
  await page.unroute("**/api/me");
  expect(await page.evaluate((id) => (window.progressFor(id) || {}).score, compB.id), "A's score is not recorded as B's progress").toBe(0);
  await expect(page.locator("#header-score"), "nor painted in B's header").toHaveText("0 pts");
});

test("the pulse says a person is present only after their own recent input", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await liveEvent("pohdr");
  await enter(page, f);
  // Driven by hand: the timer's own pulse is stopped, so each pulse below is ours.
  await page.evaluate(() => { clearTimeout(window.S.statusPollInterval); window.S.statusPollInterval = null; });
  const sent = [];
  page.on("request", (q) => {
    if (new URL(q.url()).pathname === "/api/participant/pulse") sent.push(q.headers()["x-client-active"] || null);
  });
  // Nothing done for two minutes: the pulse is a bare poll and banks no presence.
  await page.evaluate(async () => { window.S._lastIntentAt = Date.now() - 120_000; await window._pulseTick(); });
  await expect.poll(() => sent.length, { message: "precondition: the idle pulse was sent" }).toBe(1);
  expect(sent[0], "an idle tab's pulse declares nobody present").toBeNull();
  // A key pressed just now: the next pulse declares the person present
  // (core/main.js trackIntent, core/api.js's interceptor).
  await page.keyboard.press("Shift");
  await page.evaluate(() => window._pulseTick());
  await expect.poll(() => sent.length, { message: "precondition: the second pulse was sent" }).toBe(2);
  expect(sent[1], "a pulse within a minute of input carries X-Client-Active").toBe("1");
});
