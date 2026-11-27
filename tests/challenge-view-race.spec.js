// @ts-check
//
// v8.12.6 — AN OPEN BELONGS TO THE LATEST ASK; AN OUTCOME BELONGS TO ITS CARD.
//
// openTask(), revealHint(), submitAnswer() and submitFeedback() each await the
// network and then wrote into the ONE shared #task-detail-card (or navigated),
// with nothing ordering those writes against what the participant did while
// they waited. Measured on the unfixed tree, every one of these:
//   * open A (slow) -> open B -> type into B: A replaced B and the draft was lost
//     (reachable with no slow server at all — one transient 503 and the client's
//     own 400 ms retry backoff is the window);
//   * open A (slow) -> Leaderboard: A pulled the participant back;
//   * Show Hint on A (the re-check slow) -> B: the PRICED "this penalty is
//     permanent" confirm — which names no challenge — appeared over B, and
//     confirming it charged A and painted A's hint into B's card;
//   * submit A (slow) -> B: "Incorrect. −5 pts penalty" in B's card; a correct
//     answer threw the solve dialog, cleared B's telemetry id and navigated off B;
//   * rate A (slow) -> B: B's stars showed A's rating;
//   * Events (the list read slow) -> B: "Leave Event?" appeared over B's draft.
//
// TWO QUESTIONS, TWO PREDICATES, and the controls are what keep them apart. An
// OPEN asks "has the participant moved on?" (a view generation). An OUTCOME asks
// "is THIS challenge's card still the one on screen?" — because going Back and
// re-opening the same challenge means they ARE looking at it, and the first draft
// of the fix, which asked the generation for outcomes too, left a live answer box
// on a challenge just solved and a priced "Show Hint" over a hint already paid
// for. Hence the SAME-CHALLENGE CONTROLS below: every absence assertion in the
// defect arms is equally satisfied by a build that suppresses every outcome after
// any navigation, and only those controls fail it.
//
// WHY THE TESTS LOOK LIKE THIS
//   * page.route holds ONE request on a manually released promise — never a timer
//     — and every held arm asserts the hold really happened (a route that never
//     matched lets the request finish early and every absence passes vacuously).
//   * NO FIXED SLEEPS. The action under test is started programmatically with a
//     done-flag (fire-and-forget, BRACES in page.evaluate so it does not await a
//     promise the held route is blocking), and every assertion is made after a
//     positive barrier: the function returned, or the one thing it could have
//     shown instead (a modal, the solve dialog) is on screen.
//   * Each test owns its world: a live competition, two challenges, the
//     participant and a second enrolled participant who never solves, so the
//     all-solved auto-end cannot end the event under the test (`assigned === 2`).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const crypto = require("crypto");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const HINT_COST = 15;   // easy = 50 pts; the hint costs 30% of it

function dbGet(sql, ...args) {
  // Required lazily, inside the test, so the handle is opened against the
  // database this file's server is using now (v7.20.2).
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

async function mkUser(sa, csrf, nick) {
  const email = `${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "View", lastName: "Race", nickname: nick, email, company: "Acme Ltd", title: "Eng",
    country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
    jobFunction: "Software Developer / Engineer", city: "NYC" } });
  expect(reg.status(), await reg.text()).toBeLessThan(400);
  await anon.dispose();
  // `?search=` is a no-op on this endpoint; the documented 5000 cap is what
  // finds a just-created account (v8.2.3).
  const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
  expect(u, `participant ${nick} must exist`).toBeTruthy();
  for (const a of ["verify", "approve"]) {
    const r = await sa.post(`/api/admin/participants/${u.id}/${a}`, { headers: H(csrf) });
    expect(r.ok(), `${a} ${nick}: ${r.status()} ${await r.text()}`).toBeTruthy();
  }
  return { id: u.id, email };
}

/** A live competition, challenges A and B, the participant and an idle one. */
async function world({ capA } = {}) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const cr = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `ViewRace ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240 } });
    expect(cr.status(), await cr.text()).toBe(200);
    const compId = (await cr.json()).competition.id;
    const mkTask = async (title, hint, cap) => {
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title, description: `<p>Body of ${title}</p>`, difficulty: "easy", answer_type: "text",
        correct_answer: "right", explanation: "<p>e</p>", hint, status: "published",
        ...(cap ? { attempt_cap: cap } : {}) } });
      expect(r.status(), await r.text()).toBe(200);
      const id = (await r.json()).id;
      const a = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
      expect(a.status(), await a.text()).toBe(200);
      return { id, title, hint };
    };
    const A = await mkTask(`Alpha ${t}`, `HINT-OF-A-${t}`, capA);
    const B = await mkTask(`Bravo ${t}`, `HINT-OF-B-${t}`);
    const p = await mkUser(sa, csrf, `vr${t}`);
    const idle = await mkUser(sa, csrf, `vri${t}`);
    const asg = await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id, idle.id], competitionIds: [compId] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
    expect((await asg.json()).assigned, "both participants must enrol").toBe(2);
    return { compId, A, B, p };
  } finally { await sa.dispose(); }
}

/** Sign the participant in, select the event, and land on its challenge list. */
async function enter(page, w) {
  // The session is established BEFORE the first navigation (v7.21.26): an
  // anonymous SPA started first would 401 its polls when the login regenerates.
  const c0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, w.p.email, H(c0));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(c1), data: { competitionId: w.compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  await page.goto("/");
  // Cards carrying THESE challenges' ids cannot exist before loadTasks has
  // rendered, which is after boot has finished routing (v8.1.0).
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  await page.locator(`#task-grid [data-task-id="${w.A.id}"]`).waitFor({ state: "visible", timeout: 20000 });
  await page.locator(`#task-grid [data-task-id="${w.B.id}"]`).waitFor({ state: "visible", timeout: 20000 });
}

/** Everything the assertions read, in ONE evaluate so it is a single frame. */
const view = (page) => page.evaluate(() => {
  const m = document.getElementById("modal-overlay");
  return {
    page: document.querySelector(".page.active")?.id || null,
    title: document.querySelector("#task-detail-card .qa-title")?.textContent || null,
    opened: window._openedTaskId || null,
    draft: document.getElementById("ans-text")?.value ?? null,
    result: (document.querySelector("#task-detail-card #submit-result")?.textContent || "").trim(),
    hint: (document.querySelector("#task-detail-card #hint-area")?.textContent || "").replace(/\s+/g, " ").trim(),
    modal: m && m.classList.contains("open") ? (document.getElementById("modal-title")?.textContent || "") : null,
    toasts: [...document.querySelectorAll("#toast-stack .toast")].map(t => t.textContent.trim()),
  };
});
const congrats = (page) => page.locator("body > div", { has: page.locator("h2", { hasText: "Challenge Solved!" }) });

/**
 * Hold matching requests until `release()`; a promise, never a timer.
 * `firstStatus` answers the FIRST match with that status instead of holding it
 * (a transient 429/5xx) and holds the next one (the client's own retry).
 * `release({abort:true})` fails the held request as a dropped connection;
 * `release({status})` answers it with that status instead of the server.
 */
async function gate(page, method, pathname, { firstStatus } = {}) {
  const st = { seen: 0, held: 0, action: null };
  let open;
  const opened = new Promise(r => { open = r; });
  await page.route((u) => u.pathname === pathname, async (route) => {
    if (route.request().method() !== method) return route.continue();
    st.seen++;
    if (firstStatus && st.seen === 1) {
      return route.fulfill({ status: firstStatus, contentType: "application/json", body: JSON.stringify({ error: "try again shortly" }) });
    }
    st.held++;
    await opened;
    const a = st.action;
    if (a && a.abort) return route.abort("failed");
    if (a && a.status) return route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body || {}) });
    return route.continue();
  });
  return { held: () => st.held, seen: () => st.seen, release: (a) => { st.action = a || null; open(); } };
}
async function waitHeld(g) {
  await expect.poll(() => g.held(), { timeout: 10000,
    message: "the gate never held the request — every absence assertion below would be vacuous" }).toBeGreaterThan(0);
}

/** Start window[name](...args) WITHOUT awaiting it; `flag` flips when it settles. */
async function fire(page, flag, name, ...args) {
  await page.evaluate(([flag, name, args]) => {
    window[flag] = false;
    window[name](...args).then(() => { window[flag] = true; }, (e) => { window[flag] = "rejected: " + (e && e.message); });
  }, [flag, name, args]);
}
async function settled(page, flag) {
  await expect.poll(() => page.evaluate((f) => window[f], flag), { timeout: 15000 }).toBe(true);
}
/** The action settled, or it is waiting on a dialog it put up — whichever comes first. */
async function settledOrAsking(page, flag) {
  await expect.poll(() => page.evaluate((f) => window[f] === true
    || !!document.getElementById("modal-overlay")?.classList.contains("open")
    || [...document.querySelectorAll("body > div h2")].some(h => h.textContent === "Challenge Solved!"), flag),
    { timeout: 15000 }).toBe(true);
}

async function open(page, t) {
  await page.locator(`#task-grid [data-task-id="${t.id}"]`).click();
  await expect.poll(async () => { const v = await view(page); return v.page === "task-detail-page" ? v.title : null; },
    { timeout: 15000 }).toBe(t.title);
}
async function back(page, w) {
  await page.locator("#task-detail-page .back-btn").click();
  await page.locator("#tasks-page.active").waitFor({ state: "visible" });
  await page.locator(`#task-grid [data-task-id="${w.B.id}"]`).waitFor({ state: "visible" });
}
async function openB(page, w) {
  await open(page, w.B);
  await page.locator("#ans-text").fill("draft-for-B");
}

/** Type an answer into A's card and submit it, with the submit HELD. */
async function submitHeld(page, w, answer) {
  await page.locator("#ans-text").fill(answer);
  const g = await gate(page, "POST", `/api/tasks/${w.A.id}/submit`);
  await fire(page, "__sub", "submitAnswer", w.A.id, "text");
  await page.locator("#modal-overlay.open #modal-confirm-btn").click();
  await waitHeld(g);
  return g;
}
/** Ask for A's hint and confirm the priced dialog, with the charge HELD. */
async function hintPaidHeld(page, w) {
  await fire(page, "__hint", "revealHint", w.A.id, HINT_COST);
  await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Reveal Hint");
  const g = await gate(page, "POST", `/api/tasks/${w.A.id}/hint`);
  await page.locator("#modal-overlay.open #modal-confirm-btn").click();
  await waitHeld(g);
  return g;
}

test.describe("v8.12.6 — an OPEN belongs to the latest ask", () => {
  test("a slow earlier open does not replace a later one, and the draft survives", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const g = await gate(page, "GET", `/api/tasks/${w.A.id}`);
    await fire(page, "__openA", "openTask", w.A.id);
    await waitHeld(g);
    await openB(page, w);
    g.release();
    await settled(page, "__openA");
    const v = await view(page);
    expect(v.page).toBe("task-detail-page");
    expect(v.title, "A answered after B was opened — it must not replace B").toBe(w.B.title);
    expect(v.draft, "the draft typed into B must survive").toBe("draft-for-B");
    expect(v.opened, "telemetry must point at the challenge on screen").toBe(w.B.id);
    expect(v.toasts.join(" | "), "an abandoned open raises nothing").not.toMatch(/Could not open/);
  });

  test("REACHABLE WITH NO SLOW SERVER: one transient 503, and the client's own retry lands after B", async ({ page }) => {
    // The first attempt answers 503 — what a venue-NAT 429 or a load-balancer
    // 5xx looks like — and fetchTransientRetry's 400 ms backoff is the window.
    // The retry is held only to pin the ORDER; it is the client's own request.
    const w = await world(); await enter(page, w);
    const g = await gate(page, "GET", `/api/tasks/${w.A.id}`, { firstStatus: 503 });
    await fire(page, "__openA", "openTask", w.A.id);
    await waitHeld(g);
    expect(g.seen(), "the first attempt was answered 503 and retried").toBe(2);
    await openB(page, w);
    g.release();
    await settled(page, "__openA");
    const v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.opened).toBe(w.B.id);
  });

  test("a slow open does not pull the participant back from another page", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const g = await gate(page, "GET", `/api/tasks/${w.A.id}`);
    await fire(page, "__openA", "openTask", w.A.id);
    await waitHeld(g);
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible" });
    g.release();
    await settled(page, "__openA");
    expect((await view(page)).page).toBe("leaderboard-page");
  });

  test("both pending: the LAST click wins even when the first answers first", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const gA = await gate(page, "GET", `/api/tasks/${w.A.id}`);
    const gB = await gate(page, "GET", `/api/tasks/${w.B.id}`);
    await fire(page, "__openA", "openTask", w.A.id); await waitHeld(gA);
    await fire(page, "__openB", "openTask", w.B.id); await waitHeld(gB);
    gA.release();
    await settled(page, "__openA");
    expect((await view(page)).page, "A answered first but was superseded — it must never paint").toBe("tasks-page");
    gB.release();
    await settled(page, "__openB");
    const v = await view(page);
    expect(v.page).toBe("task-detail-page");
    expect(v.title).toBe(w.B.title);
    expect(v.opened).toBe(w.B.id);
  });

  test("CONTROL: a slow open that nothing superseded still renders", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const g = await gate(page, "GET", `/api/tasks/${w.A.id}`);
    await fire(page, "__openA", "openTask", w.A.id);
    await waitHeld(g);
    g.release();
    await settled(page, "__openA");
    const v = await view(page);
    expect(v.page).toBe("task-detail-page");
    expect(v.title).toBe(w.A.title);
    expect(v.opened).toBe(w.A.id);
  });

  test("an Events click whose list read lands after a challenge was opened does not ask to leave over it", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const g = await gate(page, "GET", "/api/my-competitions");
    await fire(page, "__nav", "handleCompetitionsNav");
    await waitHeld(g);
    await openB(page, w);
    g.release();
    await settledOrAsking(page, "__nav");
    const v = await view(page);
    expect(v.modal, "no 'Leave Event?' over the challenge they moved on to").toBeNull();
    expect(v.page).toBe("task-detail-page");
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
  });

  // v8.12.6 (review) — THE REVERSE ORDER: a challenge opened BEFORE the Events
  // click, still loading, lands FIRST. The Events click is the later ask, so it
  // must still happen — and A, superseded by it, must never paint. Before the
  // click took its own turn in the view generation, A's render bumped the
  // generation itself, the Events click read that as "the participant moved on"
  // and silently did nothing: measured, the participant was left on A's card
  // with no "Leave Event?" and no event list.
  test("an Events click made while an EARLIER challenge open is still loading wins, even when that open lands first", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const gA = await gate(page, "GET", `/api/tasks/${w.A.id}`);
    await fire(page, "__openA", "openTask", w.A.id);
    await waitHeld(gA);
    const gN = await gate(page, "GET", "/api/my-competitions");
    await fire(page, "__nav", "handleCompetitionsNav");
    await waitHeld(gN);
    gA.release();
    await settled(page, "__openA");
    let v = await view(page);
    expect(v.page, "A was superseded by the Events click — it must not paint").toBe("tasks-page");
    expect(v.title).toBeNull();
    gN.release();
    await settled(page, "__nav");
    v = await view(page);
    // Events is plain navigation (no "Leave Event?" confirm since v8.16.x), so
    // the later ask winning means the list itself — not A's card.
    expect(v.modal, "Events asks nothing").toBeNull();
    expect(v.page, "the Events click still wins: it takes them to their events").toBe("competitions-page");
  });

  test("CONTROL: an Events click with nothing in between goes straight to the event list", async ({ page }) => {
    const w = await world(); await enter(page, w);
    const g = await gate(page, "GET", "/api/my-competitions");
    await fire(page, "__nav", "handleCompetitionsNav");
    await waitHeld(g);
    g.release();
    await settled(page, "__nav");
    const v = await view(page);
    expect(v.modal, "no confirm on the way out of a live event").toBeNull();
    expect(v.page).toBe("competitions-page");
  });
});

test.describe("v8.12.6 — an OUTCOME belongs to its card (left for another challenge)", () => {
  test("a hint re-check that lands after leaving offers no priced confirm over another challenge", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await gate(page, "GET", `/api/tasks/${w.A.id}`);   // armed AFTER A is open
    await fire(page, "__hint", "revealHint", w.A.id, HINT_COST);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release();
    await settledOrAsking(page, "__hint");
    const v = await view(page);
    expect(v.modal, "the priced confirm names no challenge — it must not appear over B").toBeNull();
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(dbGet("SELECT COUNT(*) n FROM hint_reveals WHERE user_id=? AND task_id=?", w.p.id, w.A.id).n).toBe(0);
  });

  test("a hint paid for after leaving is reported by name, and shown when that challenge is reopened", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await hintPaidHeld(page, w);
    await back(page, w);
    await openB(page, w);
    g.release();
    await settled(page, "__hint");
    const v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.hint, "A's hint must not be painted into B's card").not.toContain(w.A.hint);
    await expect(page.locator(`#task-detail-card #hint-area [data-action="task-reveal-hint"][data-task-id="${w.B.id}"]`),
      "B's own hint is still offered, unrevealed").toBeVisible();
    expect(v.toasts).toContain(`Hint revealed for “${w.A.title}”. It is shown when you open that challenge again.`);
    // The charge was real — the participant confirmed it — and the toast's
    // promise holds: reopening A shows the hint in A's own card.
    expect(dbGet("SELECT COUNT(*) n FROM hint_reveals WHERE user_id=? AND task_id=?", w.p.id, w.A.id).n).toBe(1);
    await back(page, w);
    await open(page, w.A);
    await expect(page.locator("#task-detail-card #hint-area")).toContainText(w.A.hint);
  });

  test("a hint already paid for elsewhere, re-fetched after leaving, is not painted into another challenge", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    // "Another tab" pays for A's hint through the SPA's own session and token,
    // so this card still offers the priced button: revealHint's fresh read then
    // says hint_revealed and takes the idempotent re-fetch branch.
    const paid = await page.evaluate((id) => fetch(`/api/tasks/${id}/hint`, { method: "POST", headers: window.csrfHeaders() }).then(r => r.status), w.A.id);
    expect(paid).toBe(200);
    await expect(page.locator(`#task-detail-card [data-action="task-reveal-hint"][data-task-id="${w.A.id}"]`)).toBeVisible();
    const g = await gate(page, "POST", `/api/tasks/${w.A.id}/hint`);
    await fire(page, "__hint", "revealHint", w.A.id, HINT_COST);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release();
    await settledOrAsking(page, "__hint");
    const v = await view(page);
    expect(v.modal, "a paid hint never asks to be paid for again").toBeNull();
    expect(v.title).toBe(w.B.title);
    expect(v.hint, "A's hint must not be painted into B's card").not.toContain(w.A.hint);
    await expect(page.locator(`#task-detail-card #hint-area [data-action="task-reveal-hint"][data-task-id="${w.B.id}"]`)).toBeVisible();
  });

  test("a wrong answer graded after leaving is a toast naming it, never in another challenge's card", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await submitHeld(page, w, "wrong");
    await back(page, w);
    await openB(page, w);
    g.release();
    await settled(page, "__sub");
    const v = await view(page);
    expect(v.page).toBe("task-detail-page");
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.result, "nothing is painted into B's result line").toBe("");
    expect(v.opened, "B's telemetry id is untouched").toBe(w.B.id);
    expect(v.toasts).toContain(`Incorrect answer on “${w.A.title}”. −5 pts penalty.`);
  });

  test("a LAST wrong answer graded after leaving says it was the last, and names the challenge", async ({ page }) => {
    const w = await world({ capA: 1 }); await enter(page, w);
    await open(page, w.A);
    const g = await submitHeld(page, w, "wrong");
    await back(page, w);
    await openB(page, w);
    g.release();
    await settled(page, "__sub");
    const v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.toasts).toContain(`Incorrect answer on “${w.A.title}”. −5 pts penalty. That was your last attempt.`);
  });

  test("a correct answer graded after leaving names the challenge in the solve dialog and leaves the participant where they are", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await submitHeld(page, w, "right");
    await back(page, w);
    await openB(page, w);
    g.release();
    // Either barrier: the fixed build returns without awaiting the dialog, the
    // in-card path awaits it — whichever this build takes, the dialog is up.
    await settledOrAsking(page, "__sub");
    const dlg = congrats(page);
    await expect(dlg, "the solve is still announced by the dialog (AL7), not a toast").toBeVisible();
    await expect(dlg).toContainText(w.A.title);
    let v = await view(page);
    expect(v.page).toBe("task-detail-page");
    expect(v.title).toBe(w.B.title);
    expect(v.opened, "a solve elsewhere must not clear B's telemetry id").toBe(w.B.id);
    await dlg.locator("button", { hasText: "Continue" }).click();
    await expect(dlg).toHaveCount(0);
    v = await view(page);
    expect(v.page, "Continue does not navigate off B").toBe("task-detail-page");
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.opened).toBe(w.B.id);
  });

  test("a correct answer graded while on the Leaderboard leaves the participant on the Leaderboard", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await submitHeld(page, w, "right");
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible" });
    g.release();
    await settledOrAsking(page, "__sub");
    const dlg = congrats(page);
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText(w.A.title);
    await dlg.locator("button", { hasText: "Continue" }).click();
    await expect(dlg).toHaveCount(0);
    expect((await view(page)).page).toBe("leaderboard-page");
  });

  test("a submit refused or dropped after leaving is reported by name, never in another challenge's card", async ({ page }) => {
    const w = await world(); await enter(page, w);
    // (1) a 429 answered after the participant left
    await open(page, w.A);
    let g = await submitHeld(page, w, "wrong");
    await back(page, w);
    await openB(page, w);
    g.release({ status: 429, body: {} });
    await settled(page, "__sub");
    let v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.result).toBe("");
    expect(v.toasts).toContain(`“${w.A.title}”: you are submitting too quickly. Wait a moment and try again.`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    // (2) the connection dropped after they left: "your answer is still here" is
    // false once the card on screen is another challenge's.
    await back(page, w);
    await open(page, w.A);
    g = await submitHeld(page, w, "wrong");
    await back(page, w);
    await openB(page, w);
    g.release({ abort: true });
    await settled(page, "__sub");
    v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.result).toBe("");
    expect(v.draft).toBe("draft-for-B");
    expect(v.toasts).toContain(`Could not send your answer to “${w.A.title}” — check your connection, then reopen that challenge before trying again.`);
  });

  test("a rating saved after leaving does not mark another challenge's stars", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await gate(page, "PUT", `/api/tasks/${w.A.id}/feedback`);
    await fire(page, "__rate", "submitFeedback", w.A.id, 4);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release();
    await settled(page, "__rate");
    const stars = await page.evaluate(() => ({
      current: document.getElementById("star-rating")?.dataset.current,
      label: document.getElementById("star-label")?.textContent || "" }));
    expect(stars.current, "B's stars still say B is unrated").toBe("0");
    expect(stars.label).toBe("");
    // v8.12.6 (review) — re-pointed: the confirmation NAMES the challenge, like
    // every other off-card outcome (it was the bare "Thanks for your feedback!",
    // which says nothing about which rating once another challenge is on screen).
    expect((await view(page)).toasts).toContain(`Thanks for your feedback on “${w.A.title}”!`);
    expect(dbGet("SELECT rating FROM task_feedback WHERE user_id=? AND task_id=?", w.p.id, w.A.id).rating,
      "A's rating was saved").toBe(4);
  });

  // v8.12.6 (review) — AN OFF-CARD FAILURE NAMES ITS CHALLENGE TOO. "Failed to
  // save feedback." and "Failed to reveal hint." over another challenge's card
  // say nothing about which one; the answer outcomes have named theirs since the
  // release that introduced the off-card path. The in-place CONTROL below the
  // describe keeps the ordinary on-card wording.
  test("a rating refused, or dropped, after leaving names the challenge — and B's stars are untouched", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    let g = await gate(page, "PUT", `/api/tasks/${w.A.id}/feedback`);
    await fire(page, "__rate", "submitFeedback", w.A.id, 4);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release({ status: 500, body: {} });
    await settled(page, "__rate");
    let v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.toasts).toContain(`“${w.A.title}”: your rating could not be saved.`);
    expect(v.toasts.join(" | "), "no bare, unnamed failure").not.toContain("Failed to save feedback.");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    // …and the connection dropping is spoken, by name, rather than escaping
    // as an unhandled rejection.
    await back(page, w);
    await open(page, w.A);
    g = await gate(page, "PUT", `/api/tasks/${w.A.id}/feedback`);
    await fire(page, "__rate", "submitFeedback", w.A.id, 2);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release({ abort: true });
    await settled(page, "__rate");
    v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.toasts).toContain(`Could not save your rating for “${w.A.title}” — check your connection and try again.`);
    const stars = await page.evaluate(() => document.getElementById("star-rating")?.dataset.current);
    expect(stars, "B's stars still say B is unrated").toBe("0");
    expect(dbGet("SELECT rating FROM task_feedback WHERE user_id=? AND task_id=?", w.p.id, w.A.id), "neither rating reached the server").toBeUndefined();
  });

  test("a priced hint refused, or dropped, after leaving names the challenge — never a bare failure over another card", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    let g = await hintPaidHeld(page, w);
    await back(page, w);
    await openB(page, w);
    g.release({ status: 503, body: {} });
    await settled(page, "__hint");
    let v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.toasts).toContain(`“${w.A.title}”: the hint could not be revealed.`);
    expect(v.toasts.join(" | ")).not.toContain("Failed to reveal hint.");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await back(page, w);
    await open(page, w.A);
    g = await hintPaidHeld(page, w);
    await back(page, w);
    await openB(page, w);
    g.release({ abort: true });
    await settled(page, "__hint");
    v = await view(page);
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.hint, "A's hint is not painted into B's card").not.toContain(w.A.hint);
    expect(v.toasts).toContain(`Could not reveal the hint for “${w.A.title}” — check your connection, then reopen that challenge to see whether it was revealed.`);
    expect(v.toasts.join(" | "), "…not the dispatcher's catch-all for an exception").not.toContain("Something went wrong");
  });

  test("a paid hint's re-fetch REFUSED after leaving names the challenge — it used to return in silence", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const paid = await page.evaluate((id) => fetch(`/api/tasks/${id}/hint`, { method: "POST", headers: window.csrfHeaders() }).then(r => r.status), w.A.id);
    expect(paid, "PRECONDITION: A's hint is paid for in 'another tab'").toBe(200);
    const g = await gate(page, "POST", `/api/tasks/${w.A.id}/hint`);
    await fire(page, "__hint", "revealHint", w.A.id, HINT_COST);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release({ status: 503, body: {} });
    await settledOrAsking(page, "__hint");
    const v = await view(page);
    expect(v.modal).toBeNull();
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.toasts).toContain(`“${w.A.title}”: the hint could not be loaded.`);
  });

  // v8.12.6 (review) — THE PAID-HINT RE-FETCH THAT DROPS. The fresh read said
  // A's hint is already paid for, so revealHint re-fetches it; the connection
  // then drops after the participant moved to B. The rejection used to fall
  // through the catch into the PRICED "this penalty is permanent" confirm —
  // which names no challenge — raised over B's card while B offered its own
  // priced Show Hint. Measured on the unfixed tree: modal "Reveal Hint" over B.
  test("a paid hint's re-fetch that DROPS after leaving raises no priced confirm over another challenge — it is named as unloadable — and B's own hint still asks its price (CONTROL)", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const paid = await page.evaluate((id) => fetch(`/api/tasks/${id}/hint`, { method: "POST", headers: window.csrfHeaders() }).then(r => r.status), w.A.id);
    expect(paid, "PRECONDITION: A's hint is paid for in 'another tab'").toBe(200);
    await expect(page.locator(`#task-detail-card [data-action="task-reveal-hint"][data-task-id="${w.A.id}"]`),
      "PRECONDITION: A's card still offers the priced button").toBeVisible();
    const g = await gate(page, "POST", `/api/tasks/${w.A.id}/hint`);
    await fire(page, "__hint", "revealHint", w.A.id, HINT_COST);
    await waitHeld(g);
    await back(page, w);
    await openB(page, w);
    g.release({ abort: true });
    await settledOrAsking(page, "__hint");
    const v = await view(page);
    expect(v.modal, "no priced confirm for a hint already paid — least of all over B").toBeNull();
    expect(v.title).toBe(w.B.title);
    expect(v.draft).toBe("draft-for-B");
    expect(v.toasts).toContain(`Could not load the hint for “${w.A.title}” — check your connection, then reopen that challenge.`);
    // CONTROL: on the card being viewed, an UNPAID hint still asks its price —
    // or "no priced confirm" is satisfied by a build that never asks at all.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await fire(page, "__hintB", "revealHint", w.B.id, HINT_COST);
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Reveal Hint");
    await page.locator("#modal-overlay.open #modal-cancel-btn").click();   // Keep my points
    await settled(page, "__hintB");
    expect(dbGet("SELECT COUNT(*) n FROM hint_reveals WHERE user_id=? AND task_id=?", w.p.id, w.B.id).n, "nothing charged for B").toBe(0);
  });
});

// v8.12.6 (review) — TWO GUARDS KEEP THE PRICED CONFIRM OFF ANOTHER CARD, AND
// EACH IS SUFFICIENT ALONE. The paid-hint catch returns before the confirm on
// the one reachable route (a dropped re-fetch), and `if(gone())return;` sits in
// front of `showModal` for every other route into it — so removing EITHER leaves
// the behavioural arms above green (measured), and a reader deleting one on the
// evidence of a passing suite would be right about the suite and wrong the day
// somebody touches the other. The first is pinned by the arms above (the
// on-card drop arm and the named toast); this pins the second, comments
// stripped first because the explanation beside it quotes the pattern.
test("source: revealHint asks gone() immediately before raising the priced confirm", () => {
  const fs = require("fs"), path = require("path");
  const { stripJsComments } = require("./doc-registry");
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public/js/features/participant-tasks.js"), "utf8"));
  const start = src.indexOf("export async function revealHint(");
  expect(start, "revealHint must exist").toBeGreaterThan(-1);
  const end = src.indexOf("\nexport ", start + 10);
  const body = src.slice(start, end > 0 ? end : undefined);
  const modal = body.indexOf("showModal({");
  expect(modal, "anti-vacuity: the priced confirm is in revealHint").toBeGreaterThan(-1);
  expect(body.slice(modal, modal + 400), "…and it is the priced one").toContain("Reveal Hint");
  const before = body.slice(0, modal).replace(/\s+/g, "");
  expect(before.endsWith("if(gone())return;constok=await"),
    "the statement immediately before the priced confirm must be `if(gone())return;`").toBe(true);
  expect(body, "the paid-hint catch is still there").toMatch(/catch\(_\)\{\s*if\(alreadyPaid\)/);
});

test.describe("v8.12.6 — CONTROLS: an outcome still lands in its own card", () => {
  test("in place: a held wrong answer, hint and rating each paint in the card they were taken on", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g1 = await submitHeld(page, w, "wrong");
    g1.release();
    await settled(page, "__sub");
    await expect(page.locator("#task-detail-card #submit-result")).toContainText("Incorrect. −5 pts penalty.");
    expect((await view(page)).toasts.join(" | ")).not.toContain("Incorrect answer on");

    const g2 = await hintPaidHeld(page, w);
    g2.release();
    await settled(page, "__hint");
    await expect(page.locator("#task-detail-card #hint-area")).toContainText(w.A.hint);

    const g3 = await gate(page, "PUT", `/api/tasks/${w.A.id}/feedback`);
    await fire(page, "__rate", "submitFeedback", w.A.id, 3);
    await waitHeld(g3);
    g3.release();
    await settled(page, "__rate");
    await expect(page.locator("#star-label")).toHaveText("Your rating: 3/5");
  });

  test("SAME challenge reopened: a correct answer is celebrated and returns to the list with it solved", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await submitHeld(page, w, "right");
    await back(page, w);
    await open(page, w.A);
    g.release();
    await settledOrAsking(page, "__sub");
    const dlg = congrats(page);
    await expect(dlg).toBeVisible();
    await dlg.locator("button", { hasText: "Continue" }).click();
    await settled(page, "__sub");
    await expect.poll(async () => (await view(page)).page,
      { message: "the in-card solve path moves on to the list — a live answer box must not stay on a solved challenge" })
      .toBe("tasks-page");
    await expect.poll(() => page.evaluate((id) => (window.allTasks || []).find(t => t.id === id)?.solved, w.A.id)).toBe(true);
  });

  test("back to the LIST: a correct answer landing there takes the challenge off the unsolved list", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await submitHeld(page, w, "right");
    await back(page, w);
    g.release();
    await settledOrAsking(page, "__sub");
    const dlg = congrats(page);
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText(w.A.title);
    await dlg.locator("button", { hasText: "Continue" }).click();
    // The list is never polled, so without a reload it would go on offering A as unsolved.
    await expect.poll(() => page.evaluate((id) => (window.allTasks || []).find(t => t.id === id)?.solved, w.A.id),
      { message: "the list must be reloaded after a solve reported off-card" }).toBe(true);
    await expect(page.locator(`#task-grid [data-task-id="${w.A.id}"]`)).toHaveCount(0);
    expect((await view(page)).page).toBe("tasks-page");
  });

  test("SAME challenge reopened: a last wrong answer locks the card and says so", async ({ page }) => {
    const w = await world({ capA: 1 }); await enter(page, w);
    await open(page, w.A);
    await expect(page.locator("#task-detail-card .attempts-last")).toBeVisible();
    const g = await submitHeld(page, w, "wrong");
    await back(page, w);
    await open(page, w.A);
    g.release();
    await settled(page, "__sub");
    await expect(page.locator("#task-detail-card .attempts-exhausted"),
      "the locked panel replaces the input for an attempt already spent").toBeVisible();
    await expect(page.locator("#task-detail-card #ans-text")).toHaveCount(0);
    expect((await view(page)).toasts).toContain("Incorrect. −5 pts penalty. That was your last attempt.");
  });

  // v8.12.6 (review) — the ON-CARD half of the dropped paid-hint re-fetch: the
  // participant never left, and the fresh read said the hint is paid for, so it
  // costs nothing — a failed re-fetch says it could not be loaded, and never
  // puts that hint behind the priced "deduct N points" confirm.
  test("in place: a paid hint's re-fetch that drops says it could not be loaded — never offered for points", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const paid = await page.evaluate((id) => fetch(`/api/tasks/${id}/hint`, { method: "POST", headers: window.csrfHeaders() }).then(r => r.status), w.A.id);
    expect(paid, "PRECONDITION: A's hint is paid for in 'another tab'").toBe(200);
    const g = await gate(page, "POST", `/api/tasks/${w.A.id}/hint`);
    await fire(page, "__hint", "revealHint", w.A.id, HINT_COST);
    await waitHeld(g);
    g.release({ abort: true });
    await settledOrAsking(page, "__hint");
    const v = await view(page);
    expect(v.modal, "a hint already paid for is never behind the priced confirm").toBeNull();
    expect(v.title).toBe(w.A.title);
    expect(v.toasts).toContain("Could not load the hint — check your connection and try again.");
    expect(dbGet("SELECT COUNT(*) n FROM hint_reveals WHERE user_id=? AND task_id=?", w.p.id, w.A.id).n, "one paid row, no second").toBe(1);
  });

  test("SAME challenge reopened: a hint paid for while away is painted into its card", async ({ page }) => {
    const w = await world(); await enter(page, w);
    await open(page, w.A);
    const g = await hintPaidHeld(page, w);
    await back(page, w);
    await open(page, w.A);
    g.release();
    await settled(page, "__hint");
    await expect(page.locator("#task-detail-card #hint-area")).toContainText(w.A.hint);
    await expect(page.locator(`#task-detail-card [data-action="task-reveal-hint"]`),
      "no priced button for a hint already paid for").toHaveCount(0);
    expect((await view(page)).toasts.join(" | ")).not.toContain("Hint revealed for");
  });
});

// ---------------------------------------------------------------------------
// v8.12.6 (sweep) — THE PENDING PAGE'S DATA POLL DECIDES ABOUT THE PAGE THE
// PARTICIPANT IS ON NOW.
//
// The picker's 15 s data poll checked "is the pending page up?" at the START of
// its tick, then awaited the list and a selectCompetition round trip, and routed
// on the stale answer. A participant who went back to their events and into
// another one meanwhile was yanked: the late re-select of the pending event is
// SUPERSEDED by their newer pick and so returns `false` — the value a real
// removal returns — and the poll ejected them to the picker with "You are no
// longer in this event", out of the event they had just entered.
//
// The tick is captured and run ONCE, on demand (its interval is swapped for the
// capture), and the pending event's re-select is held at its RESPONSE — the
// server takes it in order, as it would — while the participant moves on. The
// CONTROL is a genuine removal on the pending page, which must still be ejected,
// or "not yanked" is satisfied by a poll that never routes at all.
// ---------------------------------------------------------------------------

/** An event starting in two hours (the pending page), a live one with a challenge, a second upcoming one, and the participant in all three. */
async function pendingWorld() {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const mkComp = async (name, startMs) => {
      const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name, start_time: new Date(startMs).toISOString(), duration_minutes: 240 } });
      expect(r.status(), await r.text()).toBe(200);
      return { id: (await r.json()).competition.id, name };
    };
    const A = await mkComp(`Pending ${t}`, Date.now() + 2 * 3600_000);
    const B = await mkComp(`Live ${t}`, Date.now() - 60_000);
    const C = await mkComp(`Later ${t}`, Date.now() + 3 * 3600_000);
    const tr = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `Live task ${t}`, description: "<p>b</p>", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published" } });
    expect(tr.status(), await tr.text()).toBe(200);
    const task = { id: (await tr.json()).id };
    const a = await sa.post(`/api/admin/tasks/${task.id}/competitions`, { headers: H(csrf), data: { competitionIds: [B.id] } });
    expect(a.status(), await a.text()).toBe(200);
    const p = await mkUser(sa, csrf, `pw${t}`);
    const idle = await mkUser(sa, csrf, `pwi${t}`);
    for (const c of [A, B, C]) {
      const asg = await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id, idle.id], competitionIds: [c.id] } });
      expect((await asg.json()).assigned, `both participants enrol in ${c.name}`).toBe(2);
    }
    return { A, B, C, task, p };
  } finally { await sa.dispose(); }
}

/** Sign the participant in with the pending event selected, and land on its pending page. */
async function enterPending(page, w) {
  const c0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, w.p.email, H(c0));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(c1), data: { competitionId: w.A.id } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#pending-page.active").waitFor({ state: "visible", timeout: 20000 });
  await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { timeout: 10000 }).toBe(w.A.id);
}

/** Swap the data poll's 15 s interval for a handle the test runs once. */
async function capturePollTick(page, { staleList }) {
  await page.evaluate((staleList) => {
    const orig = window.setInterval;
    window.setInterval = (f, ms) => (ms === 15000 ? (window.__pollTick = f, 0) : orig(f, ms));
    try { window.startCompDataPoll(); } finally { window.setInterval = orig; }
    // The tick returns early on an UNCHANGED list; a changed copy makes it go on
    // to the re-select, exactly as an admin edit to the event would.
    if (staleList) window.S.myCompetitions = window.S.myCompetitions.map(c => ({ ...c, __stale: true }));
  }, staleList);
}
async function runTick(page) {
  await page.evaluate(() => {
    window.__tick = false;
    window.__pollTick().then(() => { window.__tick = true; }, (e) => { window.__tick = "rejected: " + (e && e.message); });
  });
}

test.describe("v8.12.6 (sweep) — the pending-page poll does not yank a participant who moved on", () => {
  test("its re-select answered after the participant went into ANOTHER event: they stay there", async ({ page }) => {
    const w = await pendingWorld(); await enterPending(page, w);
    await capturePollTick(page, { staleList: true });
    let release; const g = new Promise(r => { release = r; }); const st = { n: 0, held: 0 };
    await page.route((u) => u.pathname === "/api/select-competition", async (route) => {
      if (++st.n > 1) return route.continue();
      const resp = await route.fetch();            // the server takes it now, in order
      st.held++; await g;
      return route.fulfill({ response: resp });
    });
    await runTick(page);
    await expect.poll(() => st.held, { message: "the poll's re-select was held — the arm is vacuous otherwise" }).toBe(1);
    // The participant moves on: back to their events, and into the live one.
    await page.locator("#pending-back-btn").click();
    await page.locator(`#comp-grid [data-comp-id="${w.B.id}"]`).click();
    for (let i = 0; i < 3; i++) {
      await expect.poll(async () => { const v = await view(page); return v.page === "tasks-page" || !!v.modal; }, { timeout: 15000 }).toBe(true);
      if ((await view(page)).page === "tasks-page") break;
      await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    }
    await page.locator(`#task-grid [data-task-id="${w.task.id}"]`).waitFor({ state: "visible", timeout: 20000 });
    release();
    await expect.poll(() => page.evaluate(() => window.__tick), { timeout: 15000 }).toBe(true);
    const v = await view(page);
    expect(v.page, "the late answer about the pending event must not move them").toBe("tasks-page");
    expect(await page.evaluate(() => window.S.currentCompetitionId)).toBe(w.B.id);
    expect(v.toasts.join(" | ")).not.toMatch(/no longer in this event/i);
    await expect(page.locator(`#task-grid [data-task-id="${w.task.id}"]`)).toBeVisible();
  });

  // The PAGE check alone cannot catch this one: the participant is on a pending
  // page again when the answer lands — just not THIS event's. Only the
  // competition generation / event id says the answer is about the past.
  test("its re-select answered after the participant went to ANOTHER UPCOMING event: they stay on that one's waiting page", async ({ page }) => {
    const w = await pendingWorld(); await enterPending(page, w);
    await capturePollTick(page, { staleList: true });
    let release; const g = new Promise(r => { release = r; }); const st = { n: 0, held: 0 };
    await page.route((u) => u.pathname === "/api/select-competition", async (route) => {
      if (++st.n > 1) return route.continue();
      const resp = await route.fetch();
      st.held++; await g;
      return route.fulfill({ response: resp });
    });
    await runTick(page);
    await expect.poll(() => st.held, { message: "the poll's re-select was held — the arm is vacuous otherwise" }).toBe(1);
    await page.locator("#pending-back-btn").click();
    await page.locator(`#comp-grid [data-comp-id="${w.C.id}"]`).click();
    const onC = async () => { const v = await view(page); return v.page === "pending-page" && (await page.evaluate(() => window.S.currentCompetitionId)) === w.C.id; };
    for (let i = 0; i < 3; i++) {
      await expect.poll(async () => (await onC()) || !!(await view(page)).modal, { timeout: 15000 }).toBe(true);
      if (await onC()) break;
      await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    }
    expect(await onC(), "precondition: the participant is on the OTHER event's waiting page").toBe(true);
    release();
    await expect.poll(() => page.evaluate(() => window.__tick), { timeout: 15000 }).toBe(true);
    const v = await view(page);
    expect(v.page, "the late answer about the first event must not eject them").toBe("pending-page");
    expect(await page.evaluate(() => window.S.currentCompetitionId)).toBe(w.C.id);
    expect(v.toasts.join(" | ")).not.toMatch(/no longer in this event/i);
  });

  test("CONTROL: the event they wait for goes live, and the poll still takes them in", async ({ page }) => {
    const w = await pendingWorld(); await enterPending(page, w);
    await capturePollTick(page, { staleList: false });
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const r = await sa.put(`/api/admin/competitions/${w.A.id}`, { headers: H(csrf), data: {
        start_time: new Date(Date.now() - 60_000).toISOString() } });
      expect(r.ok(), `move the start into the past: ${await r.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
    await runTick(page);
    await expect.poll(() => page.evaluate(() => window.__tick), { timeout: 15000 }).toBe(true);
    expect((await view(page)).page, "the waiting participant is taken into the event that started").toBe("tasks-page");
    expect(await page.evaluate(() => window.S.currentCompetitionId)).toBe(w.A.id);
  });

  test("CONTROL: removed from the pending event while on its page, the poll still takes them back to their events", async ({ page }) => {
    const w = await pendingWorld(); await enterPending(page, w);
    await capturePollTick(page, { staleList: false });
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const r = await sa.delete(`/api/admin/competitions/${w.A.id}/users/${w.p.id}`, { headers: H(csrf) });
      expect(r.ok(), `remove: ${await r.text()}`).toBeTruthy();
      expect((await r.json()).removed, "the removal really happened").toBe(true);
    } finally { await sa.dispose(); }
    await runTick(page);
    await expect.poll(() => page.evaluate(() => window.__tick), { timeout: 15000 }).toBe(true);
    expect((await view(page)).page, "a genuine refusal on the pending page still ejects").toBe("competitions-page");
  });
});

// ---------------------------------------------------------------------------
// v8.12.6 (sweep) — THE REMINDER CONFIRMATION SAYS WHEN THE EMAIL WILL COME.
// The button is offered while the start is an hour or more away and stays
// clickable as the clock runs — and after an admin moves the start earlier —
// and a reminder whose hour has begun is sent at once, while the toast promised
// "an email 1 hour before the event starts". The server now says which case it
// is. The data poll is stopped first: its next tick (≤ 15 s) would re-render the
// block, and a participant is free to click inside that window.
// ---------------------------------------------------------------------------
test.describe("v8.12.6 (sweep) — the reminder confirmation says when the email will come", () => {
  async function stalePendingButton(page, w, moveStartToMs) {
    await enterPending(page, w);
    const btn = page.locator("#pending-reminder [data-action='request-reminder']");
    await expect(btn, "the reminder is offered while the start is an hour or more away").toBeVisible();
    await page.evaluate(() => window.stopCompDataPoll());
    if (moveStartToMs) {
      const { api: sa, csrf } = await apiLogin("superadmin");
      try {
        const r = await sa.put(`/api/admin/competitions/${w.A.id}`, { headers: H(csrf), data: { start_time: new Date(moveStartToMs).toISOString() } });
        expect(r.ok(), `move the start: ${await r.text()}`).toBeTruthy();
      } finally { await sa.dispose(); }
    }
    return btn;
  }

  test("the start moved inside the hour: the toast says the email is on its way now", async ({ page }) => {
    const w = await pendingWorld();
    const btn = await stalePendingButton(page, w, Date.now() + 10 * 60_000);
    await btn.click();
    await expect(page.locator("#toast-stack .toast", { hasText: "starts in under an hour" })).toBeVisible();
    expect((await view(page)).toasts.join(" | ")).not.toContain("1 hour before the event starts");
  });

  test("CONTROL: an unchanged start two hours away keeps the original confirmation", async ({ page }) => {
    const w = await pendingWorld();
    const btn = await stalePendingButton(page, w, null);
    await btn.click();
    await expect(page.locator("#toast-stack .toast", { hasText: "1 hour before the event starts" })).toBeVisible();
  });
});
