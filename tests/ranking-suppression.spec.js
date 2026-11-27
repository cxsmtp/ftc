// v8.1.0 — PR 18: an unranked kind has no rank or placing ANYWHERE, and says so.
//
// The load-bearing decision is the STATUS CODE. features/leaderboard.js treats a
// considered non-ok as lost access and calls
// ejectToCompetitionPicker("You are no longer in this event.") — so a 403
// here would throw a participant out of an OPEN Program with a false explanation.
// Both routes therefore answer 200 with an empty board.
//
// Points still accrue and are still stored: forking lib/scoring.js is forbidden
// (the ladder is mirror-locked to DIFF_PTS, and recalculate would silently
// re-charge hint deductions). What changes is that nothing renders them.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `rs${Date.now().toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// A Program and a Competition, both LIVE, with one participant in both — so every
// assertion below has its own control in the identical shape.
async function fixture(api, csrf, label) {
  const start = new Date(Date.now() - 3600e3).toISOString();
  const mk = async (kind, nm) => {
    const body = kind === "program"
      ? { deadline_at: new Date(Date.now() + 200 * 86400e3).toISOString() }
      : { duration_minutes: 600 };
    const r = await api.post("/api/admin/competitions", {
      headers: H(csrf), data: { name: nm, event_kind: kind, start_time: start, timezone: "UTC", ...body },
    });
    expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
    return (await r.json()).competition.id;
  };
  const prog = await mk("program", `${TAG} ${label} Prog`);
  const comp = await mk("tournament", `${TAG} ${label} Comp`);

  const email = `${TAG}-${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Rank", lastName: "Off", nickname: `${TAG}_${label}`, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), await reg.text()).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [prog, comp] },
  });
  expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
  expect((await asg.json()).assigned).toBeGreaterThan(0);

  // v8.8.17 — a challenge in BOTH events, because the boundary arm below needs a
  // wrong answer to submit and its control needs the identical challenge on the
  // ranked kind. `medium` so the points figure is distinctive (100), not the 50
  // that a difficulty default would also produce.
  const tk = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${TAG} ${label} Task`, description: "d", difficulty: "medium",
            answer_type: "text", correct_answer: "right", status: "published" },
  });
  expect(tk.ok(), `create task: ${await tk.text()}`).toBeTruthy();
  const taskId = (await tk.json()).id;
  // The bulk route, not `PUT /tasks/:id/competitions` — that one is the
  // optimistic-concurrency path and requires `expectedAssignments` (v8.7.7).
  const at = await api.post("/api/admin/tasks/assign-competitions", {
    headers: H(csrf), data: { taskIds: [taskId], competitionIds: [prog, comp] },
  });
  expect(at.ok(), `assign task: ${await at.text()}`).toBeTruthy();
  const ab = await at.json();
  expect(ab.assigned, "the challenge reached BOTH events").toBe(2);
  // Each event holds its OWN copy (lib/event-copies.js): the card shown in it.
  const held = Object.fromEntries(ab.copies.map(c => [c.competition_id, c.task_id]));

  return { prog, comp, email, taskId, held };
}

/** Sign in as the fixture participant, enter `compId`, open the challenge. */
async function openChallenge(page, f, compId) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await codeLogin(page.request, f.email, H(csrfToken));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  await page.goto("/");
  // Wait for the challenge's OWN card — `#main-nav` goes visible for any main
  // page, so it is true before boot has finished routing (the v8.1.0 rule).
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  const card = page.locator(`#task-grid [data-task-id="${f.held[compId]}"]`);
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.click();
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
  await expect(page.locator("#ans-text")).toBeVisible({ timeout: 15000 });
}

test.describe("v8.1.0 — ranking suppression", () => {
  test("BOTH leaderboard routes answer 200 with an empty board, never a 4xx", async () => {
    const { api, csrf } = await sa();
    let papi;
    try {
      const f = await fixture(api, csrf, "routes");

      // PARTICIPANT — the one where a 4xx would eject with a false explanation.
      const pc = await freshCtx();
      papi = pc.api;
      const li = await codeLogin(papi, f.email, H(pc.csrf));
      expect(li.ok(), `login: ${await li.text()}`).toBeTruthy();
      const pcsrf = (await (await papi.get("/api/csrf-token")).json()).csrfToken;

      const read = async (id) => {
        const sel = await papi.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: id } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
        const r = await papi.get("/api/leaderboard");
        expect(r.status(), "NEVER a 4xx — the client would eject on one").toBe(200);
        return await r.json();
      };

      const bProg = await read(f.prog);
      expect(bProg.ranking_enabled, "the key the client branches on").toBe(false);
      expect(bProg.board).toEqual([]);
      expect(bProg.top3).toEqual([]);
      expect(bProg.me).toBeNull();
      expect(bProg.groupBoard).toBeNull();
      expect(bProg.canShareBadge).toBe(false);
      // The envelope keeps every key it already had, so nothing downstream reads
      // undefined and branches the wrong way.
      for (const k of ["leaderboard_mode", "board_limit", "ended", "timeslot_id"]) {
        expect(k in bProg, `${k} survives the suppressed envelope`).toBe(true);
      }

      const bComp = await read(f.comp);
      expect(bComp.ranking_enabled, "and the control is ranked — present on BOTH branches").toBe(true);
      expect(Array.isArray(bComp.board)).toBe(true);

      // ADMIN — the surface that had no gate at all.
      //
      // ASSERTED ONLY NOW, AND THE ORDER IS THE POINT. buildAdminLeaderboard omits
      // a participant with no login_time, so before the reads above the Program's
      // board was empty whether or not the gate existed — measured: deleting the
      // gate passed. Entering both competitions stamps the solve-clock anchor, so
      // the un-gated build would return a row here and the mutation goes red.
      const aComp = await api.get(`/api/admin/leaderboard?competitionId=${f.comp}`);
      expect(aComp.status()).toBe(200);
      expect((await aComp.json()).length,
        "the Competition control has a real row, so an empty Program board means the GATE").toBeGreaterThan(0);
      const aProg = await api.get(`/api/admin/leaderboard?competitionId=${f.prog}`);
      expect(aProg.status(), "an unranked event is not an error to an admin").toBe(200);
      expect(await aProg.json(), "…it is an empty board, in the shape every consumer indexes").toEqual([]);
    } finally {
      await api.dispose();
      if (papi) await papi.dispose();
    }
  });

  test("the two flags an unranked kind cannot honour are REFUSED, on create and on edit", async () => {
    // Accept-and-ignore would be a control that appears to work. reveal_answers is
    // the one that matters: the deadline passes, answers are published to EVERY
    // enrollee, an admin moves the deadline forward, and everyone mints a
    // verifiable certificate from the published key.
    const { api, csrf } = await sa();
    try {
      const base = {
        event_kind: "program",
        start_time: new Date(Date.now() + 3600e3).toISOString(),
        deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
        timezone: "UTC",
      };
      const r1 = await api.post("/api/admin/competitions", {
        headers: H(csrf), data: { ...base, name: `${TAG} RevealCreate`, reveal_answers_on_end: true },
      });
      expect(r1.status()).toBe(400);
      expect((await r1.json()).code).toBe("reveal_answers_forbidden");

      const r2 = await api.post("/api/admin/competitions", {
        headers: H(csrf), data: { ...base, name: `${TAG} GroupCreate`, group_leaderboard_enabled: true },
      });
      expect(r2.status()).toBe(400);
      expect((await r2.json()).code).toBe("group_leaderboard_forbidden");

      // EDIT too, or the forbidden state is reachable by reordering — the v7.29.0
      // sessions lesson, one field over.
      const ok = await api.post("/api/admin/competitions", { headers: H(csrf), data: { ...base, name: `${TAG} EditProg` } });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      const comp = (await ok.json()).competition;
      const r3 = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { reveal_answers_on_end: true, expectedUpdatedAt: comp.updated_at },
      });
      expect(r3.status()).toBe(400);
      expect((await r3.json()).code).toBe("reveal_answers_forbidden");

      // The positive control: a Competition accepts both, or "everything 400s"
      // would pass this whole test.
      const okc = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: {
          name: `${TAG} CompFlags`, start_time: base.start_time, duration_minutes: 60, timezone: "UTC",
          reveal_answers_on_end: true, group_leaderboard_enabled: true,
        },
      });
      expect(okc.ok(), `a Competition still accepts both: ${await okc.text()}`).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("a start reminder is refused for a self-paced event, and still works for a Competition", async () => {
    const { api, csrf } = await sa();
    let papi;
    try {
      const f = await fixture(api, csrf, "remind");
      const pc = await freshCtx();
      papi = pc.api;
      const li = await codeLogin(papi, f.email, H(pc.csrf));
      expect(li.ok()).toBeTruthy();
      const pcsrf = (await (await papi.get("/api/csrf-token")).json()).csrfToken;

      const bad = await papi.post(`/api/competitions/${f.prog}/reminder`, { headers: H(pcsrf), data: {} });
      expect(bad.status()).toBe(400);
      const body = await bad.json();
      expect(body.code).toBe("start_reminder_forbidden");
      expect(body.error, "the refusal says what IS true of this kind").toMatch(/self-paced/i);

      // The control. A Competition's reminder path is untouched — and this one is
      // live, so it refuses for a DIFFERENT, pre-existing reason; what matters is
      // that it is not the kind refusal.
      const other = await papi.post(`/api/competitions/${f.comp}/reminder`, { headers: H(pcsrf), data: {} });
      expect((await other.json()).code, "a Competition never gets the kind refusal").not.toBe("start_reminder_forbidden");
    } finally {
      await api.dispose();
      if (papi) await papi.dispose();
    }
  });

  test("the participant nav has no active Leaderboard, drops the score pill, and keeps Challenges", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, "nav");
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      const li = await codeLogin(page.request, f.email, H(csrfToken));
      expect(li.ok(), `login: ${await li.text()}`).toBeTruthy();
      const pcsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;

      const enter = async (id) => {
        const sel = await page.request.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: id } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
        await page.goto("/");
        await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 15000 });
      };

      // The CONTROL first: a Competition shows all three, or "they are hidden"
      // is satisfied by a build where they never appear.
      await enter(f.comp);
      await expect(page.locator("#nav-leaderboard:not([aria-disabled=true])"), "the Competition control shows Leaderboard").toBeVisible();
      await expect(page.locator("#header-score")).toBeVisible();

      await enter(f.prog);
      await expect(page.locator("#nav-challenges:not([aria-disabled=true])"), "Challenges STAYS — a Program has challenges").toBeVisible();
      await expect(page.locator("#nav-leaderboard:not([aria-disabled=true])"), "Leaderboard goes inactive").toBeHidden();
      await expect(page.locator("#header-score"), "…and the score pill goes with it, from one flag").toBeHidden();

      // The leaderboard poll must not be running either: its tick calls
      // refreshScore() every 15 s regardless of the active page, writing into an
      // element this kind hides.
      expect(await page.evaluate(() => window.S.lbInterval == null),
        "the leaderboard poll is not started for an unranked kind").toBe(true);
    } finally { await api.dispose(); }
  });

  test("the admin Rankings pane becomes PROGRESS rather than an empty board", async ({ page }) => {
    // An empty standings table under the heading "Rankings" is indistinguishable
    // from a load failure, which is how it gets reported (v7.14.2).
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, "panel");
      await adminLogin(page);
      await clickTab(page, "Events");
      await page.evaluate((id) => { window.S.adminRankingsCompId = id; }, f.prog);
      await clickTab(page, "Rankings");
      await page.evaluate(() => window.loadAdminLeaderboard());
      const content = page.locator("#admin-rankings-content");
      await expect(content).toContainText("Progress");
      await expect(content, "it names the kind in words, with its article").toContainText("a Program");
      // By value: what a Program lacks is a rank and a placing, never a score —
      // its points accrue and show on every challenge (the boundary arms below).
      await expect(content.locator(".rk-unranked-note").first(), "it says why there is no board, truly")
        .toHaveText(`${TAG} panel Prog is a Program, which has no rank or placing — so there is no leaderboard to show.`);
      expect(await content.textContent(), "it never claims a Program has no score").not.toMatch(/no score/i);
      await expect(content, "and points at where the equivalent information lives").toContainText("Analytics");
      await expect(page.locator("#admin-rankings-body"), "no standings table is rendered").toHaveCount(0);
    } finally { await api.dispose(); }
  });

  test("policyOrDefault keeps a payload that predates the policy behaving as before", async ({ page }) => {
    // The failure this prevents: `undefined` is falsy, so a stale or partial
    // payload would strip a COMPETITION participant's Leaderboard button and score
    // pill. The default must be the ranked shape.
    await page.goto("/");
    const r = await page.evaluate(() => ({
      absent: window.policyOrDefault(undefined).ranking_enabled,
      nulled: window.policyOrDefault(null).ranking_enabled,
      junk: window.policyOrDefault("nonsense").ranking_enabled,
      // Per FIELD: a partial policy must not lose the keys it does not mention.
      partial: window.policyOrDefault({ schedule: "deadline" }),
      real: window.policyOrDefault({ ranking_enabled: false }).ranking_enabled,
    }));
    expect(r.absent).toBe(true);
    expect(r.nulled).toBe(true);
    expect(r.junk).toBe(true);
    expect(r.partial.ranking_enabled).toBe(true);
    expect(r.partial.schedule).toBe("deadline");
    expect(r.real, "an explicit false is still honoured").toBe(false);
  });

  // ── v8.8.17 — WHERE THE SUPPRESSION STOPS ──────────────────────────────────
  //
  // This file pinned the nav button, the score pill and the board, and asserted
  // NOTHING about per-challenge points copy. So CLAUDE.md's claim that a Program
  // "suppresses every score surface, so the −5 wrong-answer penalty is invisible
  // to the participant" was never true and nothing could go red — it survived
  // three releases and was corrected only when the operator's backlog triage put
  // it under measurement (v8.8.16). *A count in prose is not an enumeration*, on
  // this suite's own words.
  //
  // The fix is to pin the BOUNDARY in both directions, because a one-sided lock
  // is what let the sentence drift: `ranking_enabled` suppresses the BOARD-level
  // surfaces and nothing else. `public/js/features/participant-tasks.js` never
  // branches on it, so the pre-submit warning, the wrong-answer result WITH the
  // running score, and the per-challenge points are all ungated on every kind.
  // (v8.9.0: the pre-submit warning IS gated by answer TYPE — an any-answer
  // challenge cannot be answered wrongly, so it shows none — but never by kind;
  // the text challenge this fixture drives still gets it on every kind.)
  //
  // THIS ASSERTS WHAT IS TRUE, NOT WHAT WOULD BE NICER. The operator accepted the
  // behaviour on 7 September 2026 (*Accepted audit dispositions* — a Program's
  // guessing is PRICED but not BOUNDED), so suppressing this copy is a product
  // decision, not a bug fix. If it is ever taken, this test goes red — which is
  // the whole point: whoever takes it must re-point this lock AND correct the
  // prose, in the same commit.
  test("the boundary: a Program hides the BOARD surfaces and keeps the POINTS copy", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, "boundary");
      await openChallenge(page, f, f.prog);

      // PRECONDITION — this really is the suppressed kind. Without it every
      // assertion below is equally satisfied by a build that never suppressed
      // anything, which is the state this file exists to detect.
      await expect(page.locator("#nav-leaderboard:not([aria-disabled=true])"), "precondition: the board is suppressed here").toBeHidden();
      await expect(page.locator("#header-score"), "precondition: so is the score pill").toBeHidden();

      // (a) THE PER-CHALLENGE POINTS. `medium` is 100, so a bare "50" from a
      //     difficulty default cannot satisfy this by accident.
      await expect(page.locator("#task-detail-page"),
        "the challenge still states what it is worth").toContainText(/100/);

      // (b) THE PRE-SUBMIT WARNING, which is the one a participant meets BEFORE
      //     spending anything — the surface that makes the guessing priced.
      await page.locator("#ans-text").fill("wrong-on-purpose");
      await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
      const modal = page.locator("#modal-overlay");
      await modal.waitFor({ state: "visible", timeout: 15000 });
      await expect(modal, "the penalty is stated before the participant spends it")
        .toContainText(/5 points.*deducted/is);
      await expect(modal, "…and that it is permanent").toContainText(/permanent/i);
      await modal.locator("button:has-text('Submit')").first().click({ timeout: 10000 });

      // (c) THE RESULT, carrying the penalty AND the running score — the single
      //     sharpest refutation of "no score surface", since it prints the score
      //     the header pill is hidden to withhold.
      const res = page.locator("#submit-result");
      await expect(res, "the penalty is reported").toContainText(/pts penalty/i, { timeout: 15000 });
      await expect(res, "…with the running score beside it").toContainText(/Score:\s*-?\d+/i);
    } finally { await api.dispose(); }
  });

  test("CONTROL — the ranked kind shows the identical points copy", async ({ page }) => {
    // Without this, "the Program shows the penalty" is equally satisfied by a
    // build that shows it to nobody, or by copy that has changed shape — this
    // pins that the two kinds are the SAME on this axis, which is the actual
    // claim. Same challenge, same participant, only the event differs.
    const { api, csrf } = await sa();
    try {
      const f = await fixture(api, csrf, "boundctl");
      await openChallenge(page, f, f.comp);

      await expect(page.locator("#nav-leaderboard:not([aria-disabled=true])"), "precondition: the ranked kind DOES show the board").toBeVisible();
      await expect(page.locator("#task-detail-page")).toContainText(/100/);

      await page.locator("#ans-text").fill("wrong-on-purpose");
      await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
      const modal = page.locator("#modal-overlay");
      await modal.waitFor({ state: "visible", timeout: 15000 });
      await expect(modal).toContainText(/5 points.*deducted/is);
      await modal.locator("button:has-text('Submit')").first().click({ timeout: 10000 });

      await expect(page.locator("#submit-result")).toContainText(/pts penalty/i, { timeout: 15000 });
      await expect(page.locator("#submit-result")).toContainText(/Score:\s*-?\d+/i);
    } finally { await api.dispose(); }
  });

});
