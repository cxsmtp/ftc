// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// v8.14.4 (external audit R2) — A TAB ACTS ONLY ON THE EVENT IT SHOWS.
//
// Tabs share one session and a session holds one event. Selecting event B in
// a second tab moved the first tab's answers onto B: the first tab still showed
// its challenge, and a submit there was graded — and penalised — against B.
// Reproduced by the audit through the real submit buttons.
//
// Each tab now names the event it shows in `X-Competition-Id`
// (public/js/core/api.js) and the server refuses a request naming another one
// (lib/middleware.js `tabEventMismatch`). The client tells the person once;
// it stays quiet about a refusal caused by its OWN move (a pick made in this
// tab while a request for the old event was in flight), and sends no name
// while a pick is in flight. Every client arm is pinned by what goes over the
// wire or what the caller is handed, beside the server arm, so neither half
// can pass for the other.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const net = require("net");
const { apiLogin, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { signIn } = require("./admin-inflight-helpers");

test.use({ baseURL: BASE });

function dbAll(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } }
const submissionsOf = (uid) => dbAll("SELECT competition_id, is_correct, points_delta FROM submissions WHERE user_id=? ORDER BY submitted_at", uid);
const hintsOf = (uid) => dbAll("SELECT competition_id FROM hint_reveals WHERE user_id=?", uid);

/**
 * One participant in two live events that BOTH hold the same challenge — the
 * shape in which the server would otherwise accept the answer for either. The
 * participant only ever answers wrongly, so nobody finishes and neither event
 * auto-ends (fixture checklist item 1).
 */
async function world(sa, saCsrf, label) {
  const p = await makeParticipant(sa, saCsrf, label);
  const A = await makeCompetition(sa, saCsrf, `${label}-A`);
  const B = await makeCompetition(sa, saCsrf, `${label}-B`);
  const t = await makeTask(sa, saCsrf, label, { hint: "<p>look closer</p>" });
  await assignTask(sa, saCsrf, t.id, [A.id, B.id]);
  await enrol(sa, saCsrf, A.id, [p.id]);
  await enrol(sa, saCsrf, B.id, [p.id]);
  return { p, A, B, t };
}

/** Sign the page's context in and put the session in `compId`, before the SPA boots. */
async function signInPage(page, email, compId) {
  const t1 = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const r = await codeLogin(page.request, email, H(t1), { base: `${BASE}` });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  const t2 = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const s = await page.request.post(`${BASE}/api/select-competition`, { headers: H(t2), data: { competitionId: compId } });
  expect(s.ok(), `select: ${await s.text()}`).toBeTruthy();
}
async function booted(page, compId) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.selectCompetition === "function", null, { timeout: 30000 });
  await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { timeout: 30000, message: "the tab entered the event the session holds" }).toBe(compId);
}
const OUT_OF_DATE = "This tab is out of date";
const modalText = (page) => page.evaluate(() => {
  const o = document.getElementById("modal-overlay");
  return o && getComputedStyle(o).display !== "none" ? o.textContent : "";
});
/** Run `fetch(url, init)` from the page and report what the CALLER is handed within `ms`. */
const callerGets = (page, url, init, ms = 4000) => page.evaluate(({ url, init, ms }) =>
  Promise.race([fetch(url, init).then(r => r.status), new Promise(r => setTimeout(() => r("never settled"), ms))]), { url, init, ms });
/** Another tab of the same browser (the page's own cookie jar) moves the session: to `compId`, or to no event. */
async function otherTab(page, compId) {
  const t = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const r = compId
    ? await page.request.post(`${BASE}/api/select-competition`, { headers: H(t), data: { competitionId: compId } })
    : await page.request.post(`${BASE}/api/deselect-competition`, { headers: H(t), data: {} });
  expect(r.ok(), `PRECONDITION: another tab moved the session: ${await r.text()}`).toBeTruthy();
}
const toastText = (page) => page.evaluate(() => (document.getElementById("toast-stack") || {}).textContent || "");
/** Hold one request matching `re`: `seen` once it is out, then `fetched` (the server's status) once released, then delivered on `deliver()`. */
async function holdOne(page, re) {
  const h = { seen: false, fetched: null };
  let go1, go2;
  const p1 = new Promise(r => { go1 = r; }), p2 = new Promise(r => { go2 = r; });
  h.release = () => go1();
  h.deliver = () => go2();
  await page.route(re, async (route) => {
    h.seen = true; await p1;
    const resp = await route.fetch(); h.fetched = resp.status();
    // Delivered without its Set-Cookie: route.fetch() shares the context's jar.
    const headers = { ...resp.headers() }; delete headers["set-cookie"];
    const body = await resp.body();
    await p2;
    await route.fulfill({ status: resp.status(), headers, body });
  });
  return h;
}

test.describe("v8.14.4 (R2) — a tab acts only on the event it shows", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  test("the SERVER refuses a request naming another event than the session holds — before anything is graded, charged or read; absent means unchecked", async () => {
    const w = await world(sa, saCsrf, "xtabapi");
    const s = await signIn(w.p.email, PARTICIPANT_PASS);
    try {
      const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.B.id } });
      expect(sel.ok(), `PRECONDITION: the session holds B: ${await sel.text()}`).toBeTruthy();
      const gh = (await (await s.api.get(`/api/tasks/${w.t.id}`)).json()).grading_hash;
      expect(gh, "PRECONDITION: a grading hash, so a refusal is not the task_changed one").toBeTruthy();
      const showsA = { "x-competition-id": w.A.id };

      const sub = await s.api.post(`/api/tasks/${w.t.id}/submit`, { headers: { "x-csrf-token": s.csrf, ...showsA }, multipart: { answer: "wrong", gradingHash: gh } });
      expect(sub.status(), await sub.text()).toBe(409);
      expect(await sub.json(), "the refusal names the event the session holds now").toMatchObject({ code: "competition_changed", competition_id: w.B.id, competition_name: w.B.name });
      const hint = await s.api.post(`/api/tasks/${w.t.id}/hint`, { headers: { ...H(s.csrf), ...showsA }, data: {} });
      expect(hint.status(), await hint.text()).toBe(409);
      expect((await s.api.get("/api/status", { headers: showsA })).status(), "a read is refused the same way").toBe(409);
      expect(submissionsOf(w.p.id), "no answer and no penalty, in either event").toEqual([]);
      expect(hintsOf(w.p.id), "no hint bought").toEqual([]);

      // CONTROLS: the event the session holds is served, and no header is unchecked.
      expect((await s.api.get("/api/status", { headers: { "x-competition-id": w.B.id } })).status()).toBe(200);
      expect((await s.api.get("/api/status")).status(), "absent means unchecked: only the SPA has tabs").toBe(200);
      const ok = await s.api.post(`/api/tasks/${w.t.id}/submit`, { headers: { "x-csrf-token": s.csrf, "x-competition-id": w.B.id }, multipart: { answer: "wrong", gradingHash: gh } });
      expect(ok.status(), await ok.text()).toBe(200);
      expect(submissionsOf(w.p.id), "CONTROL: a request naming the session's event is graded").toEqual([{ competition_id: w.B.id, is_correct: 0, points_delta: -5 }]);
    } finally { await s.api.dispose(); }
  });

  test("as reported: an answer from a tab left on event A, after another tab opened B, is refused and the tab says so; CONTROL: before the switch it lands in A", async ({ page, context }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabui");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    // The polls would tell this tab too; the SUBMIT is the messenger under test.
    await page.route(/\/api\/(status|leaderboard)/, r => r.abort());
    const sentFor = [];
    page.on("request", rq => { if (/\/submit$/.test(rq.url())) sentFor.push(rq.headers()["x-competition-id"] || null); });
    const card = page.locator("#task-grid .card-open", { hasText: w.t.title });
    await card.click();
    const submitOnce = async (answer) => {
      await page.locator("#ans-text").fill(answer);
      await page.locator(`[data-action="task-submit-answer"][data-task-id="${w.t.id}"]`).click();
      const answered = page.waitForResponse(r => /\/submit$/.test(r.url()));
      await page.locator("#modal-overlay").getByRole("button", { name: "Submit", exact: true }).click();
      return answered;
    };

    const first = await submitOnce("wrong one");
    expect(first.status(), "CONTROL: before the switch the answer is graded").toBe(200);
    expect(submissionsOf(w.p.id), "CONTROL: …in the event this tab shows").toEqual([{ competition_id: w.A.id, is_correct: 0, points_delta: -5 }]);
    await expect(page.locator("#ans-text")).toBeVisible();

    // ANOTHER TAB of the same browser opens B through its own picker code.
    const tab2 = await context.newPage();
    try {
      await booted(tab2, w.A.id);
      expect(await tab2.evaluate((id) => window.selectCompetition(id), w.B.id), "PRECONDITION: the other tab opened B").toBe(true);
      const second = await submitOnce("wrong two");
      expect(second.status(), "the answer naming A is refused").toBe(409);
      expect(sentFor, "both submits named the event this tab shows").toEqual([w.A.id, w.A.id]);
      await expect.poll(() => modalText(page), { message: "the tab says what happened" }).toContain(OUT_OF_DATE);
      const said = await modalText(page);
      expect(said, "…naming the event the browser has open now").toContain(w.B.name);
      expect(said, "…and the one this tab showed").toContain(w.A.name);
      expect(submissionsOf(w.p.id), "nothing was recorded against B, and no second penalty anywhere").toEqual([{ competition_id: w.A.id, is_correct: 0, points_delta: -5 }]);

      // Reload lands this tab on the event the session holds.
      await page.unroute(/\/api\/(status|leaderboard)/);
      await page.locator("#modal-overlay").getByRole("button", { name: "Reload" }).click();
      await page.waitForFunction(() => typeof window.selectCompetition === "function", null, { timeout: 30000 });
      await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { timeout: 30000 }).toBe(w.B.id);
    } finally { await tab2.close(); }
  });

  test("THIS tab's own move is not reported as another tab's: a refusal for the event it just left reaches its caller quietly", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabself");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    // Hold one request that left naming A until this tab has moved to B itself.
    let release, seen = false;
    const held = new Promise(r => { release = r; });
    await page.route(/\/api\/status\?probe=self$/, async (route) => { seen = true; await held; await route.continue(); });
    const answer = page.waitForResponse(r => /probe=self$/.test(r.url()));
    const handed = callerGets(page, "/api/status?probe=self", undefined, 8000);
    await expect.poll(() => seen, { message: "PRECONDITION: the request is held" }).toBe(true);
    expect(await page.evaluate((id) => window.selectCompetition(id), w.B.id), "this tab picks B itself").toBe(true);
    release();
    expect((await answer).status(), "PRECONDITION: the server did refuse it — the client really had to decide").toBe(409);
    expect(await handed, "the caller is handed the refusal (its own stale-response guard drops it), never a hang").toBe(409);
    expect(await modalText(page), "and nothing claims another tab moved the session").not.toContain(OUT_OF_DATE);
  });

  test("while this tab is picking an event it names none, so its own pick cannot refuse its own requests; once picked it names the new one", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabpick");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    const named = new Map();
    page.on("request", rq => { const m = /probe=(\w+)$/.exec(rq.url()); if (m) named.set(m[1], rq.headers()["x-competition-id"] || null); });
    expect(await callerGets(page, "/api/status?probe=before"), "PRECONDITION").toBe(200);
    expect(named.get("before"), "CONTROL: an ordinary request names the event the tab shows").toBe(w.A.id);
    let release, seen = false;
    const held = new Promise(r => { release = r; });
    await page.route(/\/api\/select-competition$/, async (route) => { seen = true; await held; await route.continue(); });
    await page.evaluate((id) => { window._pick = window.selectCompetition(id); }, w.B.id);
    await expect.poll(() => seen, { message: "PRECONDITION: the pick is in flight" }).toBe(true);
    await callerGets(page, "/api/status?probe=during");
    expect(named.has("during"), "PRECONDITION: the request went out").toBe(true);
    expect(named.get("during"), "no event is named while the pick is in flight").toBeNull();
    release();
    expect(await page.evaluate(() => window._pick), "the pick completes").toBe(true);
    expect(await callerGets(page, "/api/status?probe=after")).toBe(200);
    expect(named.get("after"), "once picked, requests name the new event").toBe(w.B.id);
  });

  test("the navigated-away beacon is never the messenger: its refusal goes back to its caller", async ({ page }) => {
    test.setTimeout(120_000);
    // It is sent from `pagehide` and outlives its page; a notice raised by it
    // would land on whatever loads next.
    const w = await world(sa, saCsrf, "xtabnav");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    const t = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
    const moved = await page.request.post(`${BASE}/api/select-competition`, { headers: H(t), data: { competitionId: w.B.id } });
    expect(moved.ok(), "PRECONDITION: another tab moved the session to B").toBeTruthy();
    const answer = page.waitForResponse(r => /\/navigated-away$/.test(r.url()));
    const handed = await page.evaluate(({ id, ms }) => Promise.race([
      fetch(`/api/tasks/${id}/navigated-away`, { method: "POST", headers: { "x-csrf-token": window.S.csrfToken, "content-type": "application/json" }, body: "{}" }).then(r => r.status),
      new Promise(r => setTimeout(() => r("never settled"), ms)),
    ]), { id: w.t.id, ms: 4000 });
    expect((await answer).status(), "PRECONDITION: the server refused it").toBe(409);
    expect(handed, "the beacon's caller gets its answer").toBe(409);
  });
  test("another tab went back to the Events list: this tab is refused naming NO event, says the browser has left it, and Reload lands on the list", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtableft");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    await page.route(/\/api\/(status|leaderboard)/, r => r.abort());
    await otherTab(page, null);
    const st = await page.request.get(`${BASE}/api/status`, { headers: { "x-competition-id": w.A.id } });
    expect(st.status(), await st.text()).toBe(409);
    expect(await st.json(), "no event is named: the session holds none").toMatchObject({ code: "competition_changed", competition_id: null, competition_name: null });
    // CONTROL: a header naming an event that does not exist keeps the old answer.
    expect((await page.request.get(`${BASE}/api/status`, { headers: { "x-competition-id": "no-such-event" } })).status()).toBe(400);
    expect(await callerGets(page, "/api/tasks"), "the tab's own request is answered with the notice, not handed back").toBe("never settled");
    await expect.poll(() => modalText(page)).toContain(OUT_OF_DATE);
    const said = await modalText(page);
    expect(said, "it says the browser has left the event this tab shows").toContain(`has left “${w.A.name}”`);
    expect(said).toContain("choose an event");
    expect(await toastText(page), "and never the false 'You are no longer in this event.'").not.toContain("no longer in this event");
    await page.unroute(/\/api\/(status|leaderboard)/);
    await page.locator("#modal-overlay").getByRole("button", { name: "Reload" }).click();
    await page.waitForFunction(() => typeof window.selectCompetition === "function", null, { timeout: 30000 });
    await expect(page.locator("#competitions-page")).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => window.S.currentCompetitionId)).toBeNull();
  });

  test("session selection names the tab's event too: a stale tab gets the refusal, not 'Session not found in this event'", async () => {
    const w = await world(sa, saCsrf, "xtabslot");
    const s = await signIn(w.p.email, PARTICIPANT_PASS);
    try {
      const pick = (shows) => s.api.post("/api/select-timeslot", { headers: { ...H(s.csrf), ...(shows ? { "x-competition-id": shows } : {}) }, data: { timeslotId: "no-such-slot" } });
      expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.B.id } })).ok()).toBeTruthy();
      const r = await pick(w.A.id);
      expect(r.status(), await r.text()).toBe(409);
      expect(await r.json()).toMatchObject({ code: "competition_changed", competition_id: w.B.id });
      expect((await pick(w.B.id)).status(), "CONTROL: the event the session holds reaches the slot lookup").toBe(404);
      expect((await pick(null)).status(), "CONTROL: no header is unchecked").toBe(404);
      expect((await s.api.post("/api/deselect-competition", { headers: H(s.csrf), data: {} })).ok()).toBeTruthy();
      const left = await pick(w.A.id);
      expect(left.status(), await left.text()).toBe(409);
      expect((await left.json()).competition_id).toBeNull();
      expect((await pick(null)).status(), "CONTROL: no header, no event: the old answer").toBe(400);
    } finally { await s.api.dispose(); }
  });

  test("a refusal processed after this tab went A -> B -> A is still its own: the generation moved, so its caller gets it and no notice", async ({ page }) => {
    test.setTimeout(120_000);
    // The tab shows A again when the answer lands, so only the generation can
    // tell this tab's own round trip from another tab's move.
    const w = await world(sa, saCsrf, "xtabrt");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    const h = await holdOne(page, /\/api\/tasks\?probe=rt$/);
    const handed = callerGets(page, "/api/tasks?probe=rt", undefined, 30000);
    await expect.poll(() => h.seen, { message: "PRECONDITION: the request naming A is out" }).toBe(true);
    expect(await page.evaluate((id) => window.selectCompetition(id), w.B.id)).toBe(true);
    h.release();
    await expect.poll(() => h.fetched, { message: "PRECONDITION: the server refused it while the session held B" }).toBe(409);
    expect(await page.evaluate((id) => window.selectCompetition(id), w.A.id)).toBe(true);
    expect(await page.evaluate(() => window.S.currentCompetitionId), "PRECONDITION: the tab shows A again").toBe(w.A.id);
    h.deliver();
    expect(await handed).toBe(409);
    expect(await modalText(page)).not.toContain(OUT_OF_DATE);
  });

  test("leaving the event view bumps the generation, so a refusal for the event left reaches its caller quietly", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabeject");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    await page.route(/\/api\/(status|leaderboard)/, r => r.abort());
    const h = await holdOne(page, /\/api\/tasks\?probe=ej$/);
    const handed = callerGets(page, "/api/tasks?probe=ej", undefined, 30000);
    await expect.poll(() => h.seen).toBe(true);
    await otherTab(page, w.B.id);
    h.release();
    await expect.poll(() => h.fetched, { message: "PRECONDITION: refused" }).toBe(409);
    const g0 = await page.evaluate(() => window.S._compGen);
    await page.evaluate(() => { window.ejectToCompetitionPicker(); });
    await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId)).toBeNull();
    expect(await page.evaluate(() => window.S._compGen), "the eject bumped the generation").toBeGreaterThan(g0);
    h.deliver();
    expect(await handed).toBe(409);
    expect(await modalText(page), "a tab already on the list is not told about the event it left").not.toContain(OUT_OF_DATE);
  });

  test("the notice is shown ONCE however many requests are refused, waits for the person, and stops the polls", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabonce");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    await expect.poll(() => page.evaluate(() => !!window.S.statusPollInterval), { timeout: 20000, message: "PRECONDITION: the status poll runs" }).toBe(true);
    await page.evaluate(() => { window.__marker = 1; });
    let navs = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
    await otherTab(page, w.B.id);
    // Two refused requests at once: a second notice would settle the first as
    // Cancel, and its Reload would then fire before anybody read it.
    const both = await page.evaluate(() => Promise.all(["s1", "s2"].map(k =>
      Promise.race([fetch(`/api/tasks?probe=${k}`).then(r => r.status), new Promise(r => setTimeout(() => r("never settled"), 3000))]))));
    expect(both, "neither caller is handed the refusal").toEqual(["never settled", "never settled"]);
    expect(navs, "no reload the person did not press").toBe(0);
    expect(await page.evaluate(() => window.__marker), "the page is the one the test loaded").toBe(1);
    expect(await modalText(page)).toContain(OUT_OF_DATE);
    expect(await page.evaluate(() => [window.S.statusPollInterval, window.S.lbInterval, window.S.timerInterval]), "the polls are stopped").toEqual([null, null, null]);
  });

  test("an answer this tab sent just before picking another event in the same tab is refused, says nothing was recorded, and raises no notice", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabselfsub");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    await page.route(/\/api\/(status|leaderboard)/, r => r.abort());
    await page.locator("#task-grid .card-open", { hasText: w.t.title }).click();
    await page.locator("#ans-text").fill("wrong");
    const h = await holdOne(page, /\/submit$/);
    await page.locator(`[data-action="task-submit-answer"][data-task-id="${w.t.id}"]`).click();
    await page.locator("#modal-overlay").getByRole("button", { name: "Submit", exact: true }).click();
    await expect.poll(() => h.seen, { message: "PRECONDITION: the answer naming A is out" }).toBe(true);
    expect(await page.evaluate((id) => window.selectCompetition(id), w.B.id), "this tab picks B itself").toBe(true);
    h.release();
    await expect.poll(() => h.fetched, { message: "PRECONDITION: the server refused it" }).toBe(409);
    h.deliver();
    await expect.poll(() => toastText(page), { message: "the answer's caller reports it" }).toContain("nothing was recorded");
    expect(await modalText(page), "this tab moved itself: no notice").not.toContain(OUT_OF_DATE);
    expect(submissionsOf(w.p.id), "nothing recorded in either event").toEqual([]);
  });

  test("a FILE answer refused for naming another event is drained, so a client that asked to close still reads the refusal", async () => {
    // Firefox and WebKit show a connection reset while they are still uploading
    // as a network error and drop the answer. The refusal is answered before
    // multer reads the body, so it goes through `refuseBeforeBody` like the
    // other pre-body refusals (tests/multer-limits.api.spec.js, DRAIN arms).
    const w = await world(sa, saCsrf, "xtabdrain");
    const s = await signIn(w.p.email, PARTICIPANT_PASS);
    try {
      expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.B.id } })).ok()).toBeTruthy();
      const cookie = (await s.api.storageState()).cookies.map(c => `${c.name}=${c.value}`).join("; ");
      const u = new URL(BASE);
      const sock = net.connect({ host: u.hostname, port: Number(u.port) });
      await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
      let raw = Buffer.alloc(0), reset = null, closed = false;
      sock.on("data", (d) => { raw = Buffer.concat([raw, d]); });
      sock.on("error", (e) => { reset = e.code || e.message; });
      const closedP = new Promise((r) => sock.on("close", () => { closed = true; r(); }));
      try {
        const body = Buffer.alloc(4 * 1024 * 1024, 0x61);
        sock.write([`POST /api/tasks/${w.t.id}/submit HTTP/1.1`, `Host: ${u.host}`, `Cookie: ${cookie}`, `X-CSRF-Token: ${s.csrf}`,
          `X-Competition-Id: ${w.A.id}`, "Content-Type: multipart/form-data; boundary=XTAB", `Content-Length: ${body.length}`, "Connection: close"].join("\r\n") + "\r\n\r\n");
        const written = await new Promise((resolve) => sock.write(body, (e) => resolve(e ? (e.code || e.message) : "all")));
        await Promise.race([closedP, new Promise(r => setTimeout(r, 10000))]);
        const text = raw.toString("utf8");
        expect({ written, closed, reset }, `the whole body is written and the server closes without a reset: ${text.slice(0, 200)}`).toEqual({ written: "all", closed: true, reset: null });
        expect(text, "the one answer is the refusal").toMatch(/^HTTP\/1\.1 409 /);
        expect(text).toContain('"code":"competition_changed"');
      } finally { sock.destroy(); }
      expect(submissionsOf(w.p.id)).toEqual([]);
    } finally { await s.api.dispose(); }
  });
  test("a participant an organiser REMOVED keeps the old answer: the removal clears the session's event too, and it is not another tab's", async () => {
    // So the tab ejects with "You are no longer in this event." rather than
    // blaming another tab (tests/ui-participant-a.spec.js and
    // profile-incomplete-recovery.spec.js drive that eject in the browser).
    const w = await world(sa, saCsrf, "xtabrm");
    const s = await signIn(w.p.email, PARTICIPANT_PASS);
    try {
      expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.A.id } })).ok()).toBeTruthy();
      const del = await sa.delete(`/api/admin/competitions/${w.A.id}/users/${w.p.id}`, { headers: H(saCsrf) });
      expect(del.ok(), `PRECONDITION: removed: ${del.status()} ${await del.text()}`).toBeTruthy();
      const st = await s.api.get("/api/status", { headers: { "x-competition-id": w.A.id } });
      expect(st.status(), await st.text()).toBe(400);
      const slot = await s.api.post("/api/select-timeslot", { headers: { ...H(s.csrf), "x-competition-id": w.A.id }, data: { timeslotId: "no-such-slot" } });
      expect(slot.status(), `select-timeslot too: ${await slot.text()}`).toBe(400);
      // CONTROL: still in B, a session that holds no event while the tab names B is another tab's leaving.
      expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.B.id } })).ok()).toBeTruthy();
      expect((await s.api.post("/api/deselect-competition", { headers: H(s.csrf), data: {} })).ok()).toBeTruthy();
      const left = await s.api.get("/api/status", { headers: { "x-competition-id": w.B.id } });
      expect(left.status(), await left.text()).toBe(409);
    } finally { await s.api.dispose(); }
  });

  test("Back to Events on the pending page leaves the tab's event as well as the server's: its own next request raises no notice", async ({ page }) => {
    test.setTimeout(120_000);
    const p = await makeParticipant(sa, saCsrf, "xtabback");
    const U = await makeCompetition(sa, saCsrf, "xtabback-U", { start_time: new Date(Date.now() + 86_400_000).toISOString() });
    await enrol(sa, saCsrf, U.id, [p.id]);
    await signInPage(page, p.email, U.id);
    await booted(page, U.id);
    await expect(page.locator("#pending-back-btn"), "PRECONDITION: an upcoming event opens on the pending page").toBeVisible({ timeout: 20000 });
    const g0 = await page.evaluate(() => window.S._compGen);
    const forgot = page.waitForResponse(r => /\/api\/deselect-competition$/.test(r.url()));
    await page.locator("#pending-back-btn").click();
    expect((await forgot).status(), "PRECONDITION: the server forgot the event").toBe(200);
    await expect(page.locator("#competitions-page")).toBeVisible();
    expect(await page.evaluate(() => [window.S.currentCompetitionId, window.S._compGen > 0]), "the tab no longer names it").toEqual([null, true]);
    expect(await page.evaluate(() => window.S._compGen)).toBeGreaterThan(g0);
    expect(await callerGets(page, "/api/status"), "a request now names no event and gets the plain answer").toBe(400);
    expect(await modalText(page)).not.toContain(OUT_OF_DATE);
  });

  test("a pick still in flight when Back to Events is pressed is superseded: its answer does not put the event back in the tab", async ({ page }) => {
    test.setTimeout(120_000);
    // The pending page's poll re-selects the event. If its answer lands after
    // Back, the tab would sit on the list naming an event the server forgot,
    // and its next request would be announced as another tab's move.
    const p = await makeParticipant(sa, saCsrf, "xtabbackpick");
    const U = await makeCompetition(sa, saCsrf, "xtabbackpick-U", { start_time: new Date(Date.now() + 86_400_000).toISOString() });
    await enrol(sa, saCsrf, U.id, [p.id]);
    await signInPage(page, p.email, U.id);
    await booted(page, U.id);
    await expect(page.locator("#pending-back-btn")).toBeVisible({ timeout: 20000 });
    const h = await holdOne(page, /\/api\/select-competition$/);
    await page.evaluate((id) => { window.__pick = window.selectCompetition(id); }, U.id);
    await expect.poll(() => h.seen, { message: "PRECONDITION: the re-select is out" }).toBe(true);
    h.release();
    await expect.poll(() => h.fetched, { message: "PRECONDITION: the server applied it before the deselect" }).toBe(200);
    const forgot = page.waitForResponse(r => /\/api\/deselect-competition$/.test(r.url()));
    await page.locator("#pending-back-btn").click();
    expect((await forgot).status()).toBe(200);
    h.deliver();
    expect(await page.evaluate(() => window.__pick), "the pick answered after Back stands down").toBe(false);
    expect(await page.evaluate(() => window.S.currentCompetitionId), "the tab still names no event").toBeNull();
    expect(await callerGets(page, "/api/status")).toBe(400);
    expect(await modalText(page)).not.toContain(OUT_OF_DATE);
  });

  test("a pick still in flight when the tab is ejected to the list is superseded too", async ({ page }) => {
    test.setTimeout(120_000);
    const w = await world(sa, saCsrf, "xtabejpick");
    await signInPage(page, w.p.email, w.A.id);
    await booted(page, w.A.id);
    await page.route(/\/api\/(status|leaderboard)/, r => r.abort());
    const h = await holdOne(page, /\/api\/select-competition$/);
    await page.evaluate((id) => { window.__pick = window.selectCompetition(id); }, w.A.id);
    await expect.poll(() => h.seen, { message: "PRECONDITION: the pick is out" }).toBe(true);
    h.release();
    await expect.poll(() => h.fetched).toBe(200);
    await page.evaluate(() => window.ejectToCompetitionPicker());
    h.deliver();
    expect(await page.evaluate(() => window.__pick), "the pick answered after the eject stands down").toBe(false);
    expect(await page.evaluate(() => window.S.currentCompetitionId), "the tab still names no event").toBeNull();
  });

  test("a STAFF spectator (no membership row) whose session another tab cleared still gets the no-event refusal", async () => {
    // Staff enter any event without a row, so the membership condition admits
    // them as staff; the removal arm above is the no-row, non-staff control.
    const w = await world(sa, saCsrf, "xtabstaff");
    const st = await makeParticipant(sa, saCsrf, "xtabstaff-s");
    const tag = await sa.post(`/api/admin/participants/${st.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
    expect((await tag.json()).tags, "PRECONDITION: tagged staff").toContain("staff");
    const s = await signIn(st.email, PARTICIPANT_PASS);
    try {
      const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: w.A.id } });
      expect(sel.ok(), `PRECONDITION: staff enter without a row: ${await sel.text()}`).toBeTruthy();
      expect(dbAll("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?", w.A.id, st.id), "PRECONDITION: no membership row").toEqual([]);
      expect((await s.api.post("/api/deselect-competition", { headers: H(s.csrf), data: {} })).ok()).toBeTruthy();
      const r = await s.api.get("/api/status", { headers: { "x-competition-id": w.A.id } });
      expect(r.status(), await r.text()).toBe(409);
      expect((await r.json()).competition_id).toBeNull();
    } finally { await s.api.dispose(); }
  });

  test("every writer of the tab's event bumps the generation (source scanner)", () => {
    // The client tells "this tab moved" from "another tab moved the session" by
    // the generation alone, so a writer of S.currentCompetitionId that does not
    // bump S._compGen would turn this tab's own move into a false notice (or a
    // hang). Each assignment must have a bump between it and the start of its
    // function.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const root = path.join(__dirname, "..", "public", "js");
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".js")) files.push(f); } })(root);
    const sites = [], bad = [];
    for (const f of files) {
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      const re = /S\.currentCompetitionId\s*=(?!=)/g;
      let m;
      while ((m = re.exec(src))) {
        const before = src.slice(0, m.index);
        // The nearest `function` keyword: an arrow callback inside the writer
        // (a `.catch(() => …)`) is not where its bump would be.
        const fnStart = before.lastIndexOf("function ");
        const where = `${path.relative(root, f)}:${before.split("\n").length}`;
        sites.push(where);
        if (fnStart < 0 || !/S\._compGen\+\+/.test(src.slice(fnStart, m.index))) bad.push(where);
      }
    }
    expect(sites.length, "the scan found the writers (anti-vacuity)").toBeGreaterThanOrEqual(5);
    expect(bad, "a writer of S.currentCompetitionId with no S._compGen++ before it in its function").toEqual([]);
    // And the server is never told to forget the event while the tab still
    // names it: a function that POSTs the deselect clears the tab's event first.
    const leavers = [], stale = [];
    for (const f of files) {
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      const re = /fetch\(\s*['"`]\/api\/deselect-competition['"`]/g;   // the POST, not a URL test
      let m;
      while ((m = re.exec(src))) {
        const before = src.slice(0, m.index);
        const where = `${path.relative(root, f)}:${before.split("\n").length}`;
        leavers.push(where);
        const body = src.slice(Math.max(0, before.lastIndexOf("function ")), m.index);
        if (!/S\._compGen\+\+[\s\S]*?S\.currentCompetitionId\s*=\s*null/.test(body)) stale.push(where);
      }
    }
    expect(leavers.length, "the scan found the deselect (anti-vacuity)").toBeGreaterThanOrEqual(1);
    expect(stale, "a deselect POST sent while the tab still names its event").toEqual([]);
  });
});
