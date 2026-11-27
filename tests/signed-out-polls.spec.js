// @ts-check
//
// A ROOM OF SIGNED-OUT BROWSERS BEHIND ONE ADDRESS (public/js/core/api.js's fetch
// interceptor, features/session-monitor.js `_stopAllPolls`).
//
// Every refused request counts toward the scanner block (100 in 10 minutes blocks
// the address), so when a classroom's sessions end together, after a long break
// or a restart, what each tab sends next decides whether the venue is blocked.
// The session check (GET /api/session/status) always answers 200 and is never
// counted. Each arm beside a control:
//
//   1. Once a tab knows its session ended it sends no /api/ request at all, even
//      when it returns from the background (control: before the end, the same
//      request is sent).
//   2. Past the session's known expiry a tab asks the session check before a poll,
//      so it learns of the end without a refused request (control: a live
//      session's check is followed by the request itself).
//   3. Another tab of the browser found the session ended: this tab's next request
//      asks the session check first.
//   4. The address block (429 `address_blocked`): nothing leaves until its
//      Retry-After has passed, then the session check goes first (the server's
//      half, the block's code, is in tests/scanner-silent.api.spec.js).
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
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
    return { comp, p };
  } finally { await sa.dispose(); }
}

async function enter(page, f) {
  const P = await apiLogin(f.p.email);
  try {
    const sel = await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: f.comp.id } });
    expect(sel.ok(), `pre-select: ${await sel.text()}`).toBeTruthy();
  } finally { await P.api.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect(page.locator("#tasks-page")).toHaveClass(/active/, { timeout: 20000 });
}

/** Every /api/ request the page sends, and every refusal it is answered with. */
function recorder(page) {
  const sent = []; const refused = [];
  const onReq = (q) => { const u = new URL(q.url()); if (u.pathname.startsWith("/api/")) sent.push(`${q.method()} ${u.pathname}`); };
  const onRes = (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 400) refused.push(`${r.status()} ${u.pathname}`); };
  page.on("request", onReq); page.on("response", onRes);
  return { sent, refused, stop: () => { page.off("request", onReq); page.off("response", onRes); } };
}

/** Ends the participant's session on the server, as the idle sweep does. */
function endSessions(userId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { timeout: 5000 });
  try {
    return db.prepare("DELETE FROM express_session WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.userId') END)=?").run(userId).changes;
  } finally { db.close(); }
}

const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}, hidden);
// Stops the tab's own pulse, leaderboard poll and session monitor (without the
// halt under test), so the request the test fires is the one that meets the end:
// on a loaded runner a pulse can otherwise land first and sign the tab out itself.
const quiet = (page) => page.evaluate(() => {
  const S = window.S;
  clearTimeout(S.statusPollInterval); S.statusPollInterval = null;
  clearInterval(S.lbInterval); S.lbInterval = null;
  window.stopSessionMonitor();
});
const fire = (page, url) => page.evaluate((u) => { window.fetch(u); }, url);
const signedOut = (page) => expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Signed out", { timeout: 15000 });

test("a tab whose session ended sends no /api/ request any more, back from the background included", async ({ page }) => {
  const f = await liveEvent("sopa");
  await enter(page, f);
  const before = recorder(page);
  await fire(page, "/api/my-competitions");
  await expect.poll(() => before.sent.includes("GET /api/my-competitions"), { message: "CONTROL: a live tab sends it" }).toBe(true);
  before.stop();

  await setHidden(page, true);
  expect(endSessions(f.p.id), "PRECONDITION: the session existed").toBeGreaterThan(0);
  await fire(page, "/api/status");                 // the refusal that tells the tab
  await signedOut(page);
  expect(await page.evaluate(() => window.S._pollsHalted), "the tab halted").toBe(true);

  const after = recorder(page);
  await setHidden(page, false);                    // the return re-entered the view before the fix
  await setHidden(page, true);
  await setHidden(page, false);
  await fire(page, "/api/status");
  await fire(page, "/api/my-competitions");
  await page.waitForTimeout(3000);
  after.stop();
  expect(after.sent, "nothing more left the tab").toEqual([]);
  expect(await page.evaluate(() => ({ st: window.S.statusPollInterval, lb: window.S.lbInterval, cd: window.S.compDataPollInterval, paused: window.S._pausedIntervals })),
    "no poll is armed or waiting to resume").toEqual({ st: null, lb: null, cd: null, paused: [] });
});

test("past its known expiry a tab asks the session check before a poll, so the end costs no refused request", async ({ page }) => {
  const f = await liveEvent("sopb");
  await enter(page, f);
  // CONTROL: a live session past the expiry the tab last heard of. The check
  // answers it is alive (and when it now expires), and the request goes on.
  const live = recorder(page);
  await page.evaluate(() => { window._sessionMon.expiresAt = new Date(Date.now() - 10_000); });
  const st = await page.evaluate(() => window.fetch("/api/status").then((r) => r.status));
  live.stop();
  expect(st, "the request itself was answered").toBe(200);
  expect(live.sent.indexOf("GET /api/session/status"), `the check went first (${live.sent.join(", ")})`).toBeGreaterThanOrEqual(0);
  expect(live.sent.indexOf("GET /api/session/status")).toBeLessThan(live.sent.indexOf("GET /api/status"));
  expect(await page.evaluate(() => window._sessionMon.expiresAt && window._sessionMon.expiresAt.getTime() > Date.now()),
    "the check's answer moved the known expiry on").toBe(true);

  // The session ends unseen, as a room's do over a long break.
  await quiet(page);
  expect(endSessions(f.p.id), "PRECONDITION: the session existed").toBeGreaterThan(0);
  await page.evaluate(() => { window._sessionMon.expiresAt = new Date(Date.now() - 10_000); });
  const ended = recorder(page);
  await fire(page, "/api/status");
  await signedOut(page);
  await page.waitForTimeout(1000);
  ended.stop();
  expect(ended.sent, "only the session check left").not.toContain("GET /api/status");
  expect(ended.sent).toContain("GET /api/session/status");
  expect(ended.refused, "and nothing was refused").toEqual([]);
});

test("after another tab of the browser found the session ended, this tab asks the session check first", async ({ page }) => {
  const f = await liveEvent("sopc");
  await enter(page, f);
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.locator("#tasks-page")).toHaveClass(/active/, { timeout: 20000 });
  await quiet(page); await quiet(other);

  expect(endSessions(f.p.id), "PRECONDITION: the session existed").toBeGreaterThan(0);
  await fire(page, "/api/status");                 // this tab learns it from a refusal
  await signedOut(page);

  const rec = recorder(other);
  await fire(other, "/api/status");
  await signedOut(other);
  await other.waitForTimeout(1000);
  rec.stop();
  expect(rec.sent, "the other tab sent the check, not the poll").not.toContain("GET /api/status");
  expect(rec.sent).toContain("GET /api/session/status");
  expect(rec.refused, "and was refused nothing").toEqual([]);
  await other.close();
});

test("while the address is blocked nothing leaves until Retry-After; then the session check goes first", async ({ page }) => {
  const f = await liveEvent("sopd");
  await enter(page, f);
  let blocks = 0;
  await page.route("**/api/status", (route) => {
    if (blocks++ > 0) return route.continue();
    return route.fulfill({ status: 429, headers: { "Retry-After": "3", "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Too many invalid requests from this address. Try again later.", code: "address_blocked" }) });
  });
  const during = recorder(page);
  expect(await page.evaluate(() => window.fetch("/api/status").then((r) => r.status)), "PRECONDITION: the block answered").toBe(429);
  const local = await page.evaluate(() => window.fetch("/api/my-competitions").then(async (r) => ({ s: r.status, b: await r.json() })));
  await page.waitForTimeout(1000);
  during.stop();
  expect(local, "a request during the block is answered here, as the block would").toMatchObject({ s: 429, b: { code: "address_blocked" } });
  // (A request the app already had on its way when the block was answered may
  // still leave; the one made after it may not.)
  expect(during.sent, "PRECONDITION: the recorder saw the request that met the block").toContain("GET /api/status");
  expect(during.sent, "and the request made during the block never left").not.toContain("GET /api/my-competitions");

  await page.waitForTimeout(2500);                 // past the 3 s Retry-After
  const after = recorder(page);
  expect(await page.evaluate(() => window.fetch("/api/my-competitions").then((r) => r.status)), "after the block it is sent").toBe(200);
  after.stop();
  const i = after.sent.indexOf("GET /api/session/status");
  expect(i, `the session check went first (${after.sent.join(", ")})`).toBeGreaterThanOrEqual(0);
  expect(i).toBeLessThan(after.sent.indexOf("GET /api/my-competitions"));
});

// Not a session end, but the same cost: while the profile-completion gate is
// open every read of the events list is refused 400 `profile_incomplete`, and
// each refusal counts toward the address's scanner block.
test("the events page does not poll while the profile-completion gate is open", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await liveEvent("sope");
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const second = await makeCompetition(sa, csrf, "sope-2");
    await enrol(sa, csrf, second.id, [f.p.id]);
  } finally { await sa.dispose(); }
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  await expect(page.locator("#competitions-page")).toHaveClass(/active/, { timeout: 20000 });
  // CONTROL: the page polls its list (every 15 s).
  const before = recorder(page);
  await expect.poll(() => before.sent.includes("GET /api/my-competitions"), { timeout: 20000, message: "CONTROL: the events page polls" }).toBe(true);
  before.stop();

  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { timeout: 5000 });
  try { db.prepare("UPDATE users SET company='' WHERE id=?").run(f.p.id); } finally { db.close(); }
  await fire(page, "/api/my-competitions");        // refused profile_incomplete: the gate opens
  await expect(page.locator("#profile-gate-overlay")).toBeVisible({ timeout: 15000 });
  const during = recorder(page);
  await page.waitForTimeout(17_000);               // longer than the poll's period
  during.stop();
  expect(during.sent, "no list read while the gate is open").not.toContain("GET /api/my-competitions");
  expect(during.refused, "and nothing refused").toEqual([]);
});
