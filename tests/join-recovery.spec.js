// @ts-check
//
// v8.1.4 — TWO CLIENT-SIDE DEFECTS THAT SHOW A PARTICIPANT SOMETHING THE
// SERVER DID NOT SAY.
//
// #13 — the stored pending join was DESTROYED BY A CLOCK. rehydratePendingJoin
// purged the persisted /join token whenever `Date.now() > p.exp`, before any
// network call, where `exp` was frozen at the competition's effective_end as
// of the last successful preview. But EXTENDING a time-expired competition
// revives it purely by time arithmetic, and reviving a manually-ended one is
// an ordinary admin action — so a stored deadline can be in the past while the
// event is still joinable. The walk-up who abandoned sign-up and came back
// after the original end, while the extended event was still running, had the
// recovery deleted on the clock's say-so and landed on the bannerless ordinary
// sign-up as a stray unapproved account: the exact failure v7.22.8 was built
// to fix. It also contradicted the same function's own transient-keep rule,
// which purges only on an authoritative 404.
//
// #26 — startCompDataPoll's interval callback wrote S.myCompetitions with no
// claim of and no re-check against S._myCompsFetchSeq, while loadMyCompetitions
// has carried the full pair since v7.22.1 — and ejectToCompetitionPicker bumps
// that counter with a comment claiming it stops "a poll that was ALREADY in
// flight". It did not: THIS is the poll. On the pending page (where the poll
// always runs and the v8.1.0 Leave button lives) a response carrying the
// PRE-leave list, landing after leaveCompetition's eject, re-rendered the
// picker with the event the participant had just been told they left. Clicking
// it 403s, and it does not self-heal — the eject stops the poll.
//
// Fixture rules (CLAUDE.md checklist): every test owns its competition and its
// participant; nothing authenticates as a shared seeded fixture.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const JOIN_KEY = "hck-pending-join";
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `jrec${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

const storedJoin = (page) => page.evaluate((k) => localStorage.getItem(k), JOIN_KEY);

/** Overwrite the stored deadline — the only way to model "time passed" without waiting it out. */
const ageStoredExp = (page, expMs) => page.evaluate(([k, e]) => {
  const p = JSON.parse(localStorage.getItem(k));
  p.exp = e;
  localStorage.setItem(k, JSON.stringify(p));
}, [JOIN_KEY, expMs]);

/**
 * Single-slot competition with an enabled /join link, LIVE by default (started
 * in the past) so the preview resolves. Returns the pieces every test needs.
 */
async function makeJoinableComp(sa, h, label, { startOffsetMs = -30 * 60_000, durationMinutes = 60 } = {}) {
  const name = `${uniq()} ${label}`;
  const start = new Date(Date.now() + startOffsetMs).toISOString();
  const cr = await sa.post("/api/admin/competitions", {
    headers: h,
    data: { name, timezone: "UTC", start_time: start, duration_minutes: durationMinutes, self_enroll_enabled: true },
  });
  expect(cr.ok(), `create ${name}: ${await cr.text()}`).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
  expect(rv.enabled, "self-enrollment is on at create").toBeTruthy();
  return { compId, name, token: rv.token, start };
}

/** Set duration_minutes, carrying the optimistic-concurrency token the PUT requires. */
async function setDuration(sa, h, compId, minutes) {
  const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
  const put = await sa.put(`/api/admin/competitions/${compId}`, {
    headers: h, data: { duration_minutes: minutes, expectedUpdatedAt: rv.updated_at },
  });
  expect(put.ok(), `duration -> ${minutes}: ${await put.text()}`).toBeTruthy();
}

/** The PUBLIC preview status — the server's verdict on whether a token still resolves. */
async function previewStatus(sa, token) {
  const r = await sa.get(`/api/competitions/self-enroll/${encodeURIComponent(token)}`);
  return r.status();
}

async function cleanupComp(compId) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  await sa.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════════
// #13 — the clock is a hint, the server is the verdict
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.1.4 — a stored pending join is deleted by the SERVER, never by the clock", () => {

  test("an EXTENDED event recovers a token whose stored deadline has passed — and the server really was consulted", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const fx = await makeJoinableComp(sa, h, "Extend");

    // The link visit, exactly as a walk-up makes it. The stored deadline is
    // this competition's effective end.
    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    // Email first: the link visit lands on the entry screen with the event on the card.
    await expect(page.locator("#join-banner"), "the card names the event").toBeVisible({ timeout: 15000 });
    const stored = JSON.parse(await storedJoin(page) || "null");
    expect(stored && stored.t, "the link visit persists the pending join").toBe(fx.token);

    // The event reaches its original end — modelled by shrinking the duration
    // into the past, which is a documented way to end a competition (and is
    // what makes the token stop resolving).
    await setDuration(sa, h, fx.compId, 5);
    expect(await previewStatus(sa, fx.token), "precondition: the original end really did stop the token resolving").toBe(404);

    // The visitor's clock passes that deadline. (Rewritten rather than waited
    // out — the stored value is now simply TRUE about a deadline that passed.)
    await ageStoredExp(page, Date.now() - 1000);

    // …and the organiser EXTENDS the event, which revives it purely by time
    // arithmetic. This is the whole point: the client's stored deadline is now
    // in the past while the event is joinable again, and ONLY the server knows.
    await setDuration(sa, h, fx.compId, 600);
    expect(await previewStatus(sa, fx.token), "precondition: the extend revived the event").toBe(200);
    await sa.dispose();

    let previews = 0;
    await page.route("**/api/competitions/self-enroll/**", (route) => { previews++; return route.continue(); });

    // THE RETURN VISIT. Pre-fix: purged on the clock, zero requests, ordinary
    // bannerless sign-up. It must instead ASK, and be told yes.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    await expect(page.locator("#join-banner")).toBeVisible();
    await expect(page.locator("#join-banner-info")).toContainText(fx.name);

    expect(previews, "the expired token must be taken to the server, not deleted by the clock").toBeGreaterThan(0);
    const after = JSON.parse(await storedJoin(page) || "null");
    expect(after && after.t, "the token survives").toBe(fx.token);
    // The refresh path ran: the stored deadline is the EXTENDED end now, so the
    // next visit is an ordinary in-date one.
    expect(after.exp, "the stored deadline is refreshed from the fresh preview").toBeGreaterThan(Date.now());

    // Mutation caught: restoring `if(Date.now()>p.exp){clearStoredJoin();return false;}`
    // — previews goes to 0, storage to null, and the banner never renders.
    await cleanupComp(fx.compId);
  });

  test("POSITIVE CONTROL — a token whose event is genuinely gone IS purged, on the server's 404", async ({ page }) => {
    // Same client state as the test above (a deadline in the past), opposite
    // server verdict, opposite outcome. Without this pair, "the token survived"
    // is equally satisfied by a build that never purges anything.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const fx = await makeJoinableComp(sa, h, "Gone");

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    // Email first: the link visit lands on the entry screen with the event on the card.
    await expect(page.locator("#join-banner"), "the card names the event").toBeVisible({ timeout: 15000 });
    expect(await storedJoin(page), "stored before the event ends").toBeTruthy();

    await setDuration(sa, h, fx.compId, 5);   // ended, and NOT extended
    expect(await previewStatus(sa, fx.token), "precondition: the event is really gone").toBe(404);
    await ageStoredExp(page, Date.now() - 1000);
    await sa.dispose();

    let previews = 0;
    await page.route("**/api/competitions/self-enroll/**", (route) => { previews++; return route.continue(); });

    await page.goto("/");
    // A dead token leaves a plain homepage visit exactly as it always was.
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    await expect(page.locator("#join-banner")).toBeHidden();
    expect(previews, "the verdict is asked for").toBeGreaterThan(0);
    await expect.poll(() => storedJoin(page), "a 404 still purges").toBeNull();

    // Mutation caught: deleting `if(pr.status===404){clearStoredJoin();return false;}`.
    await cleanupComp(fx.compId);
  });

  test("a TRANSIENT preview failure (429, then 5xx) keeps an expired token — and the next clean boot recovers it", async ({ page }) => {
    // The transient-keep rule now applies to expired tokens too, which is new
    // surface: before this fix an expired token never reached the network at
    // all, so it could not be protected by a rule about network answers. The
    // preview is rate-limited 30/min/IP, so a venue-NAT cohort 429s it
    // routinely, and a 5xx arrives during any deploy — either one destroying
    // the recovery would be the v7.16.4 anti-pattern.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const fx = await makeJoinableComp(sa, h, "Blip");
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    // Email first: the link visit lands on the entry screen with the event on the card.
    await expect(page.locator("#join-banner"), "the card names the event").toBeVisible({ timeout: 15000 });
    await ageStoredExp(page, Date.now() - 1000);

    for (const status of [429, 503]) {
      await page.route("**/api/competitions/self-enroll/**", (route) =>
        route.fulfill({ status, contentType: "application/json", body: '{"error":"transient"}' }));
      await page.goto("/");
      // No rehydration this boot — never act on unvalidated state — so the
      // plain login landing. But the stored copy MUST survive.
      await page.waitForSelector("#login-page.active", { timeout: 15000 });
      expect(JSON.parse(await storedJoin(page) || "null")?.t, `storage kept across the ${status}`).toBe(fx.token);
      await page.unroute("**/api/competitions/self-enroll/**");
    }

    // Blip over → the very next visit recovers, deadline still in the past.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    await expect(page.locator("#join-banner-info")).toContainText(fx.name);

    // Mutation caught: turning `if(!pr.ok){return false;}` into a purge.
    await cleanupComp(fx.compId);
  });

  test("the far-horizon retention backstop still purges with NO network round-trip", async ({ page }) => {
    // `exp` is not decoration: past the retention horizon a stored token is
    // dropped without asking, which is the one case where the zero-network
    // purge is genuinely free — no revive could still be in play. The
    // competition here is deliberately LIVE, so a build that lost the backstop
    // would RECOVER the token rather than merely spend a request, and both
    // assertions below fire.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const fx = await makeJoinableComp(sa, h, "Ancient");
    await sa.dispose();

    await page.goto(`/join/${encodeURIComponent(fx.token)}`);
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    // Email first: the link visit lands on the entry screen with the event on the card.
    await expect(page.locator("#join-banner"), "the card names the event").toBeVisible({ timeout: 15000 });
    await ageStoredExp(page, Date.now() - 40 * 24 * 3600_000);   // well past the 30-day horizon

    let previews = 0;
    await page.route("**/api/competitions/self-enroll/**", (route) => { previews++; return route.continue(); });

    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 15000 });
    await expect.poll(() => storedJoin(page), "an ancient token is dropped").toBeNull();
    expect(previews, "…and costs no request to drop it").toBe(0);

    // Mutation caught: removing the backstop — the live competition's preview
    // 200s, so the token is recovered instead of dropped and previews is 1.
    await cleanupComp(fx.compId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// #26 — the poll writer claims the sequence too
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v8.1.4 — the my-competitions POLL has a stale-response guard", () => {

  test("a poll captured BEFORE a leave cannot resurrect the left event after the eject", async ({ page }) => {
    // The poll ticks every 15 s and its callback is anonymous inside
    // setInterval, so there is no way to drive it other than letting it fire.
    // That is deliberate: calling loadMyCompetitions() instead would exercise
    // the loader, which has had this guard since v7.22.1 — the writer under
    // test here is the poll itself.
    test.setTimeout(120_000);

    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    // UPCOMING, so the participant lands on the PENDING page — where this poll
    // always runs and where the Leave button lives.
    const fx = await makeJoinableComp(sa, h, "PollRace", { startOffsetMs: 45 * 60_000, durationMinutes: 120 });

    // Own the participant (CLAUDE.md checklist item 3) and SELF-ENROL, because
    // `can_leave` is scoped to a membership the participant created themselves.
    const label = uniq();
    const email = `${label}@company.example`;
    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: {
        firstName: "Poll", lastName: "Racer", nickname: label, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
        password: PARTICIPANT_PASS,
      },
    });
    expect(reg.ok(), `register: ${await reg.text()}`).toBeTruthy();
    await anon.dispose();
    const u = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email);
    expect(u, "the test's own participant must exist").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });

    try {
      // Sign the page's request context in, then self-enrol + select, all
      // outside the SPA so boot lands straight on the pending page.
      const c0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const li = await codeLogin(page.request, email, H(c0));
      expect(li.ok(), `login: ${await li.text()}`).toBeTruthy();
      const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const join = await page.request.post("/api/competitions/join", { headers: H(c1), data: { token: fx.token } });
      expect(join.ok(), `self-enrol: ${await join.text()}`).toBeTruthy();
      const sel = await page.request.post("/api/select-competition", { headers: H(c1), data: { competitionId: fx.compId } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();

      await page.goto("/");
      await page.waitForSelector("#pending-page.active", { timeout: 20000 });
      // Precondition: the affordance really is offered (v7.14.2 — the server
      // computes can_leave, and without it the click below would do nothing).
      await expect(page.locator("#pending-leave")).toBeVisible({ timeout: 15000 });

      // The PRE-leave body — what a poll issued before the leave receives.
      // Taken through page.request (a separate context) BEFORE the route is
      // installed, so what we replay is genuine rather than hand-built.
      const staleBody = await (await page.request.get("/api/my-competitions")).text();
      expect(JSON.parse(staleBody).some(x => x.id === fx.compId),
        "the pre-leave snapshot must contain the event").toBe(true);

      // Hold the next /api/my-competitions — on the pending page nothing else
      // requests it, so that is the poll — and answer it with the stale body
      // only once the leave has completed. EVERYTHING AFTER IT IS ABORTED: leave
      // the network open and a later load self-corrects inside the assertion
      // window, which is what made the first version of the v7.22.1 lock pass
      // against both of its mutations.
      let release, calls = 0, servedStale = false;
      const held = new Promise(res => { release = res; });
      await page.route("**/api/my-competitions", async (route) => {
        if (++calls > 1) return route.abort();
        await held;
        servedStale = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: staleBody });
      });

      // Wait for the tick to reach the route — up to one full 15 s interval.
      await expect.poll(() => calls, { timeout: 45000, intervals: [500, 1000, 2000], message: "the 15s poll must reach the route" })
        .toBeGreaterThan(0);

      // …now leave, through the real control, while that request is in flight.
      await page.locator('[data-action="leave-competition"]').click();
      await page.locator("#modal-confirm-btn").click();
      await page.waitForSelector("#competitions-page.active", { timeout: 20000 });
      expect(await page.evaluate(() => (window.S?.myCompetitions || []).map(x => x.id)),
        "the leave + eject must have rebuilt the list without the left event").not.toContain(fx.compId);

      // Release the stale response. It predates the eject, so it must be
      // discarded — by the sequence the poll now claims.
      release();
      await expect.poll(() => servedStale, { timeout: 15000 }).toBe(true);
      await page.waitForTimeout(500);   // let the (discarded) handler run to completion

      // THE DISCRIMINATING ASSERTION is the model: pre-fix the stale body is
      // assigned wholesale, so the left event is back in S.myCompetitions.
      expect(await page.evaluate(() => (window.S?.myCompetitions || []).map(x => x.id)),
        "a stale in-flight poll must not resurrect the left event").not.toContain(fx.compId);
      // …and through the renderer, which is what the participant actually sees.
      // Rendered explicitly from the model rather than trusted to have been
      // repainted, because the eject's own reload was one of the aborted calls
      // and left a load-failure box in the grid.
      await page.evaluate(() => window.renderCompetitionPicker && window.renderCompetitionPicker());
      expect(await page.locator(`#comp-grid .comp-card[data-comp-id="${fx.compId}"]`).count(),
        "…nor re-offer its card in the picker").toBe(0);

      // Mutation caught: dropping `const mySeq=++S._myCompsFetchSeq;` /
      // `if(mySeq!==S._myCompsFetchSeq)return;` from the poll callback.
    } finally {
      await sa.delete(`/api/admin/participants/${u.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await sa.dispose();
      await cleanupComp(fx.compId);
    }
  });
});
