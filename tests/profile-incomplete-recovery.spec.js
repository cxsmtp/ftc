"use strict";

// v8.8.23 — `profile_incomplete` IS ANSWERED IN ONE PLACE.
//
// 18 endpoints can answer `400 {error:"profile_incomplete", missing:[…]}` and,
// until this release, exactly TWO client sites knew what it meant. Measured in a
// browser before the fix:
//
//   * idle 15 s on the challenge list → toast "You are no longer in this event."
//     and an eject — FALSE, the picker behind it still lists that event as live;
//   * submit an answer → the literal token `profile_incomplete` rendered inside
//     the RED `.result-msg wrong` panel that otherwise means "your answer was
//     incorrect", seconds after the participant accepted a modal warning of a
//     PERMANENT five-point penalty. Nothing was charged and nothing said so;
//   * reveal a hint → the same token in a toast, after accepting the cost;
//   * open a challenge → the same token, detail view never opens.
//
// The fix is the fetch interceptor: it recognises the shape, opens the completion
// gate, and RETRIES the request the participant actually made — so the action
// they asked for completes instead of being reported as a failure. Retrying is
// safe because the check is the FIRST statement in `requireCompetitionContext`,
// so the refusal precedes every handler write.
//
// THE CONTROLS ARE HALF THIS FILE. "No false toast" is equally satisfied by a
// build that deleted the eject, which would leave a participant genuinely removed
// mid-event staring at a frozen grid; and "the gate opens" is equally satisfied by
// one that gates everybody, including the admin tier the gate must never trap —
// it covers the header, and with it the Admin View button that is their only way
// out (v8.7.3).

const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
// v7.21.25 — reuse the solution the suite already has rather than writing a
// second one: `loginViaApi` absorbs a thrown ECONNRESET under load and reports
// WHY on a 401, which the anti-enumeration message alone never does.
const { loginViaApi } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `pir${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/**
 * A live Booth Event whose sign-up form HIDES `phone`, plus a walk-up who
 * registered through its join link and therefore has that column blank BY
 * CONSTRUCTION — which is what makes the trigger total rather than partial:
 * every one of the five configurable booth fields defaults to `hidden`, so
 * flipping one to required gates the whole cohort at once.
 */
async function boothWorld(api, csrf, { tasks = 1, passwordless = false } = {}) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} booth`, event_kind: "booth", add_qualifying: false, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true,
      registration_fields: passwordless ? { phone: "hidden", password: "hidden" } : { phone: "hidden" },
    },
  });
  expect(cr.ok(), `create booth: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const taskIds = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} T${i}`, description: "d", difficulty: "easy",
              answer_type: "text", correct_answer: `right${i}`, hint: "a hint", status: "published" },
    });
    expect(tr.ok(), await tr.text()).toBeTruthy();
    const id = (await tr.json()).id;
    taskIds.push(id);
    expect((await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();
  }

  const se = await api.get(`/api/admin/competitions/${comp.id}/self-enroll`);
  expect(se.ok(), `self-enroll reveal: ${await se.text()}`).toBeTruthy();
  const token = (await se.json()).token;
  expect(token, "the join token was revealed").toBeTruthy();

  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  try {
    const reg = await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: { firstName: "Walk", lastName: "Up", nickname: label, email, company: "Acme",
              title: "Engineer", country: "US", timezone: "America/New_York",
              password: passwordless ? "" : PARTICIPANT_PASS, joinToken: token },
    });
    expect(reg.status(), `join-link register: ${await reg.text()}`).toBe(200);
  } finally { await anon.dispose(); }

  return { comp, taskIds, email, label };
}

/** Flip one configurable field to `required` on a live booth — the reported trigger. */
async function makeRequired(api, csrf, comp, field) {
  const cur = await (await api.get("/api/admin/competitions")).json();
  const row = cur.find(c => c.id === comp.id);
  expect(row, "the event is listed").toBeTruthy();
  const r = await api.put(`/api/admin/competitions/${comp.id}`, {
    headers: H(csrf),
    data: { expectedUpdatedAt: row.updated_at, registration_fields: { [field]: "required" } },
  });
  expect(r.ok(), `make ${field} required: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/**
 * Sign a participant in and land them INSIDE their event, on the challenge list.
 *
 * ESTABLISH THE SESSION FIRST, THEN NAVIGATE (v7.21.25): `page.request` shares
 * the context cookie jar, so a warm-up `goto` before the login starts an
 * ANONYMOUS SPA whose polls 401 the instant the login regenerates the session —
 * at which point its own interceptor signs that session out.
 *
 * The walk-up has exactly one event, so the sole-event landing (v8.3.12) takes
 * them straight in; the picker click is the fallback for a fixture that ever
 * grows a second.
 */
async function enterAsParticipant(page, email, compName) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await page.goto("/");
  const grid = page.locator("#task-grid .task-card").first();
  const card = page.locator(`#comp-grid .comp-card:has-text("${compName}")`).first();
  await Promise.race([
    grid.waitFor({ state: "visible", timeout: 25000 }).catch(() => {}),
    card.waitFor({ state: "visible", timeout: 25000 }).then(() => card.click()).catch(() => {}),
  ]);
  await expect(grid, "the participant is inside the event, on the challenge list")
    .toBeVisible({ timeout: 25000 });
}

/** Every toast this page has EVER rendered — they auto-dismiss, so sampling loses them. */
async function recordToasts(page) {
  await page.evaluate(() => {
    window.__toasts = [];
    const seen = new WeakSet();
    new MutationObserver(() => {
      document.querySelectorAll("#toast-stack .toast").forEach(t => {
        if (seen.has(t)) return; seen.add(t); window.__toasts.push(t.textContent || "");
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
}
const toasts = (page) => page.evaluate(() => window.__toasts || []);

test.describe("v8.8.23 — an incomplete profile is gated, not mis-reported", () => {
  test("the 15-second poll opens the gate and never claims they left the event", async ({ page }) => {
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      await enterAsParticipant(page, w.email, w.comp.name);
      await recordToasts(page);

      await makeRequired(api, csrf, w.comp, "phone");

      // The gate arrives through the interceptor on the next polled read.
      await expect(page.locator("#profile-gate-overlay"), "the completion gate opened")
        .toBeVisible({ timeout: 40000 });
      await expect(page.locator("#profile-gate-overlay"), "…and names the field the organiser made mandatory")
        .toContainText(/phone/i);

      // THE FALSEHOOD IS GONE. They were never removed from anything.
      const seen = await toasts(page);
      expect(seen.join(" | "), "no toast claims they left the event").not.toMatch(/no longer in this event/i);
      // …and the machine token never reaches a human.
      expect(seen.join(" | "), "the raw error code is not shown").not.toContain("profile_incomplete");

      // They are still where they were — not ejected to the picker.
      await expect(page.locator("#tasks-page"), "still inside the event").toBeVisible();
    } finally { await api.dispose(); }
  });

  test("a submit interrupted by the gate COMPLETES once the field is filled", async ({ page }) => {
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      await enterAsParticipant(page, w.email, w.comp.name);
      await recordToasts(page);

      const submitPosts = [];
      page.on("request", (rq) => { if (rq.method() === "POST" && /\/api\/tasks\/[^/]+\/submit$/.test(rq.url())) submitPosts.push(rq.url()); });

      await page.locator("#task-grid .task-card").first().click();
      await expect(page.locator("#ans-text"), "the challenge opened").toBeVisible({ timeout: 15000 });
      await page.locator("#ans-text").fill("right0");

      // The organiser flips the field while this participant is mid-challenge —
      // the realistic shape, and the only one that can reach the submit branch at
      // all, since opening a challenge is itself gated.
      await makeRequired(api, csrf, w.comp, "phone");

      await page.locator('[data-action="task-submit-answer"][data-mode="text"]').first().click();
      // The pre-submit penalty confirmation is unchanged and still comes first.
      const modal = page.locator("#modal-overlay");
      await modal.waitFor({ state: "visible", timeout: 15000 });
      await expect(modal, "the permanent-penalty warning is still what they accept")
        .toContainText(/5 points.*deducted/is);
      await modal.locator("button:has-text('Submit')").first().click({ timeout: 10000 });

      // THE GATE, not the red "your answer was incorrect" panel.
      const gate = page.locator("#profile-gate-overlay");
      await expect(gate, "the gate fronts the refusal").toBeVisible({ timeout: 30000 });
      await gate.locator("#gate-phone").fill("+1 555 0100");
      await gate.locator("#gate-save-btn").click();
      await gate.waitFor({ state: "detached", timeout: 20000 });

      // …AND THE ANSWER THEY SUBMITTED IS GRADED. This is the retry, and it is
      // asserted three ways because each alone is weaker: the WIRE (two POSTs to
      // the same URL — nothing but a retry produces that), the STORED row, and
      // what the participant is actually shown.
      expect(submitPosts.length, "the interrupted submit was re-sent, not dropped").toBe(2);

      const Database = require("better-sqlite3");
      await expect.poll(() => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try {
          return db.prepare("SELECT COUNT(*) n FROM submissions WHERE competition_id=? AND is_correct=1").get(w.comp.id).n;
        } finally { db.close(); }
      }, { timeout: 20000, message: "the retried answer was graded and stored" }).toBe(1);

      // …and the participant ends up where a correct answer takes them: back on
      // the list, with the challenge marked solved. NOT `#submit-result` — the
      // success path runs `showCongrats` then `loadTasks` then
      // `showMain('tasks-page')`, so that panel is legitimately empty by the time
      // the flow settles. (An earlier draft asserted it and was wrong about the
      // PRODUCT, not the fix.)
      // WHAT THE PARTICIPANT IS ACTUALLY TOLD, and it is the point of the whole
      // change: "Challenge Solved!", not a red panel carrying a machine token.
      // The congratulations dialog has NO auto-dismiss by design (WCAG 2.2.1), so
      // it must be answered before the list re-renders behind it.
      await expect(page.getByRole("heading", { name: "Challenge Solved!" }),
        "the interrupted answer is reported as CORRECT").toBeVisible({ timeout: 20000 });
      await page.getByRole("button", { name: "Continue" }).click();

      // …and the counter behind it agrees. `#tasks-subtitle`, not a `.solved`
      // card: a LIVE event forces the Unsolved filter (v8.3.26), so solving the
      // only challenge empties the grid rather than marking a card.
      await expect(page.locator("#tasks-subtitle"),
        "the solved counter moved").toHaveText(/1\s*\/\s*1\s*solved/i, { timeout: 20000 });

      const seen = await toasts(page);
      expect(seen.join(" | "), "the raw token was never shown").not.toContain("profile_incomplete");
      const panel = await page.locator("#submit-result").textContent().catch(() => "");
      expect(panel || "", "the red wrong-answer panel does not carry the token").not.toContain("profile_incomplete");
    } finally { await api.dispose(); }
  });



  // v8.14.2 (review) — SIGNING OUT NEVER WAITS ON THE GATE. The sign-out sends
  // the open challenge's navigated-away row first; that route is gated on the
  // profile too, and the gate cannot be dismissed — so a participant whose
  // profile an organiser made incomplete could not sign out at all.
  test("Sign out with a challenge open and the profile just made incomplete: signed out, no gate", async ({ page }) => {
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      await enterAsParticipant(page, w.email, w.comp.name);
      await page.locator("#task-grid .task-card").first().click();
      await expect(page.locator("#ans-text"), "a challenge is open").toBeVisible({ timeout: 15000 });
      expect(await page.evaluate(() => !!window._openedTaskId), "PRECONDITION: the sign-out will send a navigated-away row").toBe(true);
      await makeRequired(api, csrf, w.comp, "phone");
      // Watch for the gate from before the press: the page reloads once signed
      // out, so a look afterwards would see nothing either way.
      await page.evaluate(() => {
        window.__gateSeen = false;
        new MutationObserver(() => { if (document.getElementById("profile-gate-overlay")) window.__gateSeen = true; })
          .observe(document.body, { childList: true, subtree: true });
      });
      // Park the sign-out itself, so the page is still here to be asked.
      let release; const parkedP = new Promise((r) => { release = r; });
      await page.route("**/api/logout", async (route) => { await parkedP; await route.continue(); });
      const navAway = page.waitForResponse((r) => r.url().includes("/navigated-away"));
      const logout = page.waitForRequest((q) => new URL(q.url()).pathname === "/api/logout" && q.method() === "POST");
      await page.evaluate(() => { window.doLogout(); });
      expect((await navAway).status(), "PRECONDITION: the row met the profile gate's refusal").toBe(400);
      await logout;
      expect(await page.evaluate(() => window.__gateSeen), "the gate never opened for it").toBe(false);
      await expect(page.locator("#profile-gate-overlay")).toHaveCount(0);
      release();
    } finally { await api.dispose(); }
  });

  test("CONTROL — a participant genuinely REMOVED is still ejected, and told so", async ({ page }) => {
    // Without this, "no false toast" is satisfied by a build that deleted the
    // eject entirely — which would leave somebody actually removed mid-event
    // staring at a frozen challenge list.
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      await enterAsParticipant(page, w.email, w.comp.name);
      await recordToasts(page);

      const list = await (await api.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(w.email)}`)).json();
      const u = (list.participants || []).find(p => p.email === w.email);
      expect(u, "the walk-up is findable").toBeTruthy();
      const del = await api.delete(`/api/admin/competitions/${w.comp.id}/users/${u.id}`, { headers: H(csrf) });
      expect(del.ok(), `remove: ${await del.text()}`).toBeTruthy();
      expect((await del.json()).removed, "the removal really happened").toBe(true);

      await expect.poll(async () => (await toasts(page)).join(" | "),
        { timeout: 45000, message: "a real removal still says so" }).toMatch(/no longer in this event/i);
      await expect(page.locator("#competitions-page"), "…and they are ejected to the picker").toBeVisible();
    } finally { await api.dispose(); }
  });

  test("CONTROL — the interceptor is PARTICIPANTS ONLY, so no gate can trap an admin", async ({ page }) => {
    // The gate is `position:fixed` over the header, so it hides the Admin View
    // button that is an admin's only way out of participant view — which is why
    // every proactive trigger is admin-exempt (v8.7.3). The interceptor must be
    // too.
    //
    // v8.12.4 — driven with a REAL admin. The first draft flipped
    // `S.userRole` on a participant's session, a shape no actor can produce; the
    // real one is ordinary: an organiser who registered through a booth link,
    // was promoted, and switched to participant view after the booth made a
    // field mandatory. The server answers their participant reads with the same
    // 400 (it must: `requireCompleteProfile` has no role exemption).
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      const who = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === w.email);
      expect(who, "the walk-up is registered").toBeTruthy();
      expect((await api.post(`/api/admin/participants/${who.id}/verify`, { headers: H(csrf) })).ok(), "verify").toBeTruthy();
      const role = await api.post(`/api/admin/participants/${who.id}/role`, { headers: H(csrf), data: { role: "admin" } });
      expect(role.ok(), `promote: ${await role.text()}`).toBeTruthy();
      await makeRequired(api, csrf, w.comp, "phone");

      await loginViaApi(page, w.email, PARTICIPANT_PASS);
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      const tog = await page.request.post("/api/toggle-admin-view", { headers: H(csrfToken), data: { mode: "participant" } });
      expect(tog.ok(), `participant view: ${await tog.text()}`).toBeTruthy();
      await page.goto("/");
      await expect.poll(() => page.evaluate(() => window.S && window.S.userRole), { timeout: 20000 }).toBe("admin");

      // Raced, because a build that DOES open the gate holds the request until
      // the gate is saved — that must fail here, not at the test timeout.
      const through = await page.evaluate(async () => {
        const hung = new Promise(res => setTimeout(() => res({ status: "HUNG — the interceptor held the request behind a gate" }), 10000));
        return Promise.race([hung, fetch("/api/my-competitions").then(async r => ({ status: r.status, body: await r.text() }))]);
      });
      expect(through.status, "the server refuses this admin's participant read, and the answer comes straight back").toBe(400);
      expect(through.body, "…and the caller gets the answer, unretried").toContain("profile_incomplete");
      await expect(page.locator("#profile-gate-overlay"), "no gate for a non-participant").toHaveCount(0);
      await expect((await require("./chrome-helpers").openAccountMenu(page)).locator('[data-action="toggle-admin-view"]'), "the way back to the admin panel stays reachable").toBeVisible();
    } finally { await api.dispose(); }
  });

  test("the retry survives the caller's deadline expiring while the gate is open", async ({ page }) => {
    // THE SUBTLE ONE. `fetchTransientRetry` arms a 15-second abort timer per
    // attempt and deliberately does NOT clear it on a definitive answer — it
    // hands the deadline to `readBody` so a stalled BODY is bounded too
    // (v7.15.15). So by the time a human has typed a phone number, that
    // controller has fired, and a retry carrying its signal aborts before it
    // leaves the browser: the participant completes the gate and the request they
    // were making dies anyway.
    //
    // A test that fills the gate quickly cannot see this — measured, the earlier
    // draft passed with the strip removed. The abort is therefore driven
    // EXPLICITLY, which is both deterministic and faster than waiting out a real
    // fifteen seconds.
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      await enterAsParticipant(page, w.email, w.comp.name);
      await makeRequired(api, csrf, w.comp, "phone");

      const gateOpened = await page.evaluate(async () => {
        const ctrl = new AbortController();
        // Resolves to a verdict either way, so the assertion can tell an ABORT
        // from an ordinary failure rather than just seeing a rejected promise.
        window.__pending = fetch("/api/status", { signal: ctrl.signal })
          .then(r => ({ status: r.status }), e => ({ err: e && e.name }));
        for (let i = 0; i < 400 && !document.getElementById("profile-gate-overlay"); i++) {
          await new Promise(res => setTimeout(res, 50));
        }
        // The caller's deadline expires WHILE the participant is filling the form.
        ctrl.abort();
        return !!document.getElementById("profile-gate-overlay");
      });
      expect(gateOpened, "precondition: the gate is open and the request is parked behind it").toBe(true);

      const g = page.locator("#profile-gate-overlay");
      await g.locator("#gate-phone").fill("+1 555 0100");
      await g.locator("#gate-save-btn").click();
      await g.waitFor({ state: "detached", timeout: 20000 });

      const out = await page.evaluate(() => window.__pending);
      expect(out.err, "the retry must not carry the caller's expired deadline").toBeUndefined();
      expect(out.status, "…and the request the participant made completes").toBe(200);
    } finally { await api.dispose(); }
  });

  test("ONE gate at a time, however many requests 400 together", async ({ page }) => {
    // The status poll, the leaderboard poll and a tasks load all tick together,
    // so without the shared promise they would stack overlays over each other.
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const w = await boothWorld(api, csrf);
      await enterAsParticipant(page, w.email, w.comp.name);
      await makeRequired(api, csrf, w.comp, "phone");

      // THE HAZARD IS AN UNRESOLVED PROMISE, NOT A SECOND OVERLAY — and getting
      // that wrong is why two earlier drafts of this test could not fail. The gate
      // has removed any prior overlay since v7.6.x (`getElementById(...)?.remove()`),
      // so the DOM can never hold two whatever happens. What it does NOT do is
      // settle the promise it orphaned: without the shared promise, three
      // concurrent callers build three gates, the third's overlay survives, and
      // saving resolves only the third — leaving two awaiting requests hung for
      // the life of the tab. With the interceptor those are real participant
      // actions, so this is exactly the shape that matters.
      //
      // `boot()` republishes every export on `window`, which is what makes the
      // direct call available.
      await page.evaluate(() => {
        window.__gateResolved = 0;
        for (let i = 0; i < 3; i++) {
          window.openProfileCompletionGate(["phone"]).then(() => { window.__gateResolved++; });
        }
      });
      const g = page.locator("#profile-gate-overlay");
      await expect(g.first(), "a gate opened").toBeVisible({ timeout: 30000 });
      expect(await g.count(), "and only ever one is in the DOM").toBe(1);

      await g.locator("#gate-phone").fill("+1 555 0100");
      await g.locator("#gate-save-btn").click();
      await g.waitFor({ state: "detached", timeout: 20000 });

      await expect.poll(() => page.evaluate(() => window.__gateResolved),
        { timeout: 15000, message: "every caller was released, not just the last one" }).toBe(3);
    } finally { await api.dispose(); }
  });
});

test.describe("v8.8.23 — the gate asks for the control that WORKS", () => {
  test("a corporate-email miss marks the SECONDARY required, and it satisfies the rule", async ({ page }) => {
    // `corporate_email` is missing when NEITHER address is a company one. The
    // gate used to mark PRIMARY required — a box that cannot fix it, because a
    // primary change has been STAGED since v8.3.36, so `PUT /api/me` still tests
    // the old free address and refuses. The only working control was the one
    // labelled "(optional)".
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      const label = uniq();
      const email = `${label}@gmail.com`;                 // free — and no secondary
      const corp = `${label}-reg@company.example`;
      // Email first: a free-mail address with no invitation is mailed no proof,
      // so it cannot register. Register on a company address, then plant the
      // free primary (below) where the rule cannot see it arrive.
      const { api: anon, csrf: ac } = await freshCtx();
      try {
        const reg = await registerPost(anon, "/api/register", {
          headers: H(ac),
          data: { firstName: "Free", lastName: "Mail", nickname: label, email: corp,
                  company: "Acme", title: "Engineer",
                  country: "US", timezone: "America/New_York",
                  jobFunction: "Software Developer / Engineer", city: "Testville" },
        });
        expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
      } finally { await anon.dispose(); }

      const list = await (await api.get(`/api/admin/participants?limit=5000`)).json();
      const u = (list.participants || []).find(p => p.email === corp);
      expect(u, "findable").toBeTruthy();
      await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
      await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
      {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        try { db.prepare("UPDATE users SET email=? WHERE id=?").run(email, u.id); }
        finally { db.close(); }
      }

      // NEITHER address is a company one now, which is exactly the
      // `corporate_email` miss.
      const { api: pa, csrf: pc0 } = await freshCtx();
      try {
        expect((await codeLogin(pa, email, H(pc0))).ok()).toBeTruthy();
        const pc = (await (await pa.get("/api/csrf-token")).json()).csrfToken;
        // Removing it through the API is refused for the same reason the gate
        // exists, so the state is planted where the rule cannot see it going.
        const me = await (await pa.get("/api/me")).json();
        expect(me.email, "precondition: a free primary").toContain("@gmail.com");
      } finally { await pa.dispose(); }

      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("UPDATE users SET secondary_email=NULL WHERE id=?").run(u.id); }
      finally { db.close(); }

      await loginViaApi(page, email, PARTICIPANT_PASS);
      await page.goto("/");

      const gate = page.locator("#profile-gate-overlay");
      await expect(gate, "the gate opens on a corporate-email miss").toBeVisible({ timeout: 30000 });

      // THE REQUIRED CONTROL IS THE ONE THAT WORKS.
      await expect(gate.locator("#gate-email2"), "the company-email box is required")
        .toHaveAttribute("aria-required", "true");
      expect(await gate.locator("#gate-email").getAttribute("aria-required"),
        "…and the staged primary is NOT marked required").toBeNull();

      await gate.locator("#gate-email2").fill(`${label}@company.example`);
      await gate.locator("#gate-save-btn").click();
      await gate.waitFor({ state: "detached", timeout: 20000 });

      const after = await page.evaluate(async () => (await (await fetch("/api/me")).json()).missing_fields);
      expect(after, "the requirement really is satisfied").toEqual([]);
    } finally { await api.dispose(); }
  });
});

// v8.8.23 — THE EJECT GUARDS ARE DEFENCE IN DEPTH, AND THAT IS WHY THEY ARE
// PINNED HERE RATHER THAN BEHAVIOURALLY. With the interceptor working, a polled
// read's 400 is retried before its caller ever sees it, so the guards below are
// unreachable from a browser — measured: removing all five leaves every test in
// this file green. They still matter, because the interceptor is deliberately
// PARTICIPANTS ONLY and carries a skip list, so any future narrowing of it hands
// the 400 straight back to these branches — where the pre-fix behaviour was to
// claim a membership the participant still has.
test.describe("v8.8.23 — no eject site can claim a lost membership for this 400", () => {
  test("every 'no longer in this event' eject is preceded by a profile_incomplete guard", () => {
    const fs = require("fs"), path = require("path");
    const root = path.resolve(__dirname, "..", "public", "js", "features");
    const files = ["participant-tasks.js", "leaderboard.js"];
    let ejects = 0;
    const bad = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(root, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/ejectToCompetitionPicker\(\s*["']You are no longer in this event/.test(l)) return;
        ejects++;
        // The guard is within the same `if(!r.ok)` block, so a short lookback is
        // the right window — wide enough for the transient arm above it, narrow
        // enough that a guard belonging to a DIFFERENT branch cannot vouch for
        // this one.
        const back = lines.slice(Math.max(0, i - 12), i).join("\n");
        if (!/isProfileIncomplete\(|error===['"]profile_incomplete['"]/.test(back)) {
          bad.push(`${f}:${i + 1}`);
        }
      });
    }
    // Anti-vacuity: a renamed message would empty the match set and pass in
    // silence, which is exactly the regression this guards.
    expect(ejects, "the eject sites are still found by this pattern").toBeGreaterThanOrEqual(5);
    expect(bad, "an eject that can fire on an incomplete profile says something FALSE").toEqual([]);
  });
});
