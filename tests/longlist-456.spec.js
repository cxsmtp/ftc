// @ts-check
//
// v7.21.16 — long-list remediation phases 4, 5 and 6.
//
// Phase 4: the group-chip multiselect is MODEL-backed and shared.
// Phase 5: Submissions sorts on the SERVER, across the whole filtered stream.
// Phase 6: the participant's challenge list and competition picker can be searched.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

async function loginSuperadmin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: h(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

async function loginParticipant(page, email = "alice@acme.com") {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, h(csrfToken));
  expect(r.ok(), `${email} login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  return (await r.json()) || {};
}

/**
 * Log in AND select a competition explicitly, so the landing view is decided by
 * this test rather than by the account's ambient `active_competition_id`.
 *
 * v7.21.18 — the challenge-list test relied on that ambient value and went flaky
 * on a full 8-worker run, waiting 30 s for a `.task-card` that was never coming
 * because boot had routed to the PICKER instead. That is the documented v7.21.1
 * trap ("a participant test that does not SELECT a competition is asserting on
 * the picker") and the fixture checklist's reason to own your fixture: a long
 * wait that ends empty means the wrong VIEW, not a slow one.
 */
async function loginParticipantInCompetition(page, email = "alice@acme.com") {
  const body = await loginParticipant(page, email);
  const live = (body.competitions || []).find(c => c.status === "live")
            || (body.competitions || [])[0];
  expect(live, `${email} must be in at least one competition for this test`).toBeTruthy();
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: h(csrf), data: { competitionId: live.id } });
  expect(sel.ok(), `select ${live.name}: ${sel.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#tasks-page").waitFor({ state: "visible", timeout: 30000 });
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — the chip multiselect keeps its selection in a MODEL
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.16 phase 4 — group chips are model-backed", () => {
  test("a pick survives the chip element being destroyed", async ({ page }) => {
    // THE INVARIANT, stated as a test. submitInvitations() used to read the
    // selection back with querySelectorAll('[aria-pressed="true"]'), so the
    // picks existed only as long as the markup did — any re-render of that box
    // (a filter that rebuilds instead of hiding, pagination, a refetch) would
    // have dropped every tick silently, with nothing on screen to show it.
    //
    // Destroying the chip is how a test reproduces "the box was re-rendered"
    // without waiting for some future feature to do it. The model survives; a
    // DOM scrape cannot. This is preventive by design — v7.17.0 called exactly
    // this shape a HARD PREREQUISITE before that modal could be paginated.
    const stamp = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const g = await (await sa.post("/api/admin/groups", { headers: h(saCsrf), data: { name: `ChipModel ${stamp}` } })).json();
    const gid = g.group?.id || g.id;
    expect(gid, "fixture group created").toBeTruthy();
    await sa.dispose();

    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#invite-participants-btn").click();
    await expect(page.locator("#invite-overlay")).toBeVisible();

    const chip = page.locator(`.invite-group-pick[data-group-id='${gid}']`);
    await chip.waitFor({ state: "visible", timeout: 15000 });
    await chip.click();
    await expect(chip, "the chip reflects the pick").toHaveAttribute("aria-pressed", "true");

    // The model holds it…
    expect(await page.evaluate(() => [...(window.S._inviteSelectedGroups || [])]),
      "the selection must live in S._inviteSelectedGroups").toContain(gid);

    // …and it still holds it once the markup is gone.
    await page.evaluate(id => { document.querySelector(`.invite-group-pick[data-group-id='${id}']`)?.remove(); }, gid);
    expect(await page.evaluate(() => [...(window.S._inviteSelectedGroups || [])]),
      "the pick vanished with the element — the selection is being read from the DOM"
    ).toContain(gid);

    // And the request built from it carries the group.
    let sent = null;
    await page.route("**/api/admin/invitations", async route => {
      sent = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ invited: 0, results: [] }) });
    });
    await page.fill("#invite-emails", `chipmodel-${stamp}@company.com`);
    await page.locator("[data-action='invite-submit'], #invite-submit-btn").first().click();
    await expect.poll(() => sent, { timeout: 15000 }).not.toBeNull();
    expect(sent.groupIds, "the submitted body must carry the picked group").toContain(gid);
    await page.unroute("**/api/admin/invitations");
  });

  test("the bulk dialog's Step 2 → Back still restores the picks", async ({ page }) => {
    // The bulk sibling already kept a model; this proves the migration onto the
    // shared helper did not lose that — the Set is written back to the ARRAY on
    // every toggle, which is what the restore reads.
    const stamp = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const g = await (await sa.post("/api/admin/groups", { headers: h(saCsrf), data: { name: `ChipBack ${stamp}` } })).json();
    const gid = g.group?.id || g.id;
    await sa.dispose();

    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 15000 });
    const firstRow = page.locator('#admin-participants-body input[type="checkbox"]').first();
    await firstRow.waitFor({ state: "visible", timeout: 20000 });
    await firstRow.check();
    await page.locator("#selection-bar-assign-btn").click();
    await page.locator("#bulk-assign-overlay").waitFor({ state: "visible", timeout: 15000 });

    const chip = page.locator(`#bulk-assign-overlay .bulk-group-pick[data-group-id="${gid}"]`);
    await chip.waitFor({ state: "visible", timeout: 15000 });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => [...(window.S.bulkSelectedGroups || [])]),
      "the state array must mirror the chip Set").toContain(gid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Submissions sorts on the server
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.16 phase 5 — Submissions sorts across the whole stream", () => {
  test("the sort is applied by the SERVER, and an unknown column is refused", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      const get = async qs => (await (await api.get(`/api/admin/submissions?limit=50${qs}`)).json());

      // The default read must keep the fast path — a poll must not pay for a
      // feature nobody asked it for.
      const dflt = await get("");
      expect(dflt.sorted_globally, "the default read must not take the sorting path").toBe(false);
      expect(dflt.sort).toBeNull();

      // Explicitly asking for the DEFAULT ordering is still the default: it must
      // not silently downgrade every poll that echoes its own sort state back.
      const explicitDefault = await get("&sort=time&dir=desc");
      expect(explicitDefault.sorted_globally,
        "sort=time&dir=desc IS the default ordering and must keep the fast path").toBe(false);

      // A real sort.
      const desc = await get("&sort=points&dir=desc");
      expect(desc.sorted_globally, "a non-default sort must be applied server-side").toBe(true);
      expect(desc.sort).toBe("points");
      expect(desc.dir).toBe("desc");
      const pts = desc.events.map(e => e.points_delta);
      expect(pts.length, "the fixture must have produced some events").toBeGreaterThan(1);
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i - 1], `points must be non-increasing: ${JSON.stringify(pts)}`).toBeGreaterThanOrEqual(pts[i]);
      }
      // …and the other direction, so this cannot pass on a coincidental order.
      const asc = (await get("&sort=points&dir=asc")).events.map(e => e.points_delta);
      for (let i = 1; i < asc.length; i++) {
        expect(asc[i - 1], `points must be non-decreasing: ${JSON.stringify(asc)}`).toBeLessThanOrEqual(asc[i]);
      }
      expect(asc.join(","), "asc and desc must differ, or the sort did nothing").not.toBe(pts.join(","));

      // An unknown column must not reach the SQL. It falls back to the default
      // ordering rather than erroring — the column name comes from a header click,
      // so a stale client asking for a retired column should still get rows.
      const bogus = await get("&sort=' OR 1=1 --&dir=asc");
      expect(bogus.sorted_globally, "an unknown sort column must not be applied").toBe(false);
      expect(bogus.sort).toBeNull();
      expect(Array.isArray(bogus.events), "an unknown sort still returns rows").toBe(true);

      // A sort must not FILTER: the same total, however it is ordered.
      expect(desc.total, "sorting must not change how many rows there are").toBe(dflt.total);
    } finally { await api.dispose(); }
  });

  test("sorting is global, not page-scoped — page 1 holds the true extreme", async () => {
    // The claim that matters. With a page size of 1, a page-scoped sort is a
    // no-op (one row is already sorted), so page 1 of a descending sort must
    // hold the maximum over the WHOLE stream — which only a server-side sort
    // can produce.
    const { api } = await apiLogin("superadmin");
    try {
      const all = await (await api.get("/api/admin/submissions?limit=500")).json();
      const every = all.events.map(e => e.points_delta);
      expect(every.length, "need more than one event for this to mean anything").toBeGreaterThan(1);
      const max = Math.max(...every), min = Math.min(...every);
      expect(max, "the fixture needs a spread of point values").toBeGreaterThan(min);

      const top = await (await api.get("/api/admin/submissions?limit=1&sort=points&dir=desc")).json();
      expect(top.events[0].points_delta, "page 1 of a global descending sort must hold the stream maximum").toBe(max);
      const bottom = await (await api.get("/api/admin/submissions?limit=1&sort=points&dir=asc")).json();
      expect(bottom.events[0].points_delta, "…and ascending must hold the minimum").toBe(min);
    } finally { await api.dispose(); }
  });

  test("the client refetches on a header click and drops the page-scoped note", async ({ page }) => {
    await loginSuperadmin(page);
    // RBAC sidebar — Submissions has no sidebar item (Audit covers it); the pane keeps its id.
    await page.locator("#admin-page").waitFor({ state: "visible" });
    await page.evaluate(() => window.adminTab(null, "admin-submissions-tab"));
    await page.locator("#admin-submissions-tab").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#admin-submissions-body tr").first().waitFor({ state: "visible", timeout: 25000 });

    const urls = [];
    page.on("request", r => { if (r.url().includes("/api/admin/submissions?")) urls.push(r.url()); });
    await page.locator("th[data-action='sort-submissions'][data-col='points']").first().click();
    await expect.poll(() => urls.filter(u => u.includes("sort=points")).length, { timeout: 15000 }).toBeGreaterThan(0);

    // The note claims a page-scoped sort. Now that the server sorts globally it
    // would be a wrong answer — the same class the note was added to fix, with
    // the sides swapped.
    await expect.poll(() => page.evaluate(() => !!window.S._subSortedGlobally), { timeout: 15000 }).toBe(true);
    expect(await page.locator(".page-scope-note").count(),
      "the 'Sorted within this page' note must not appear once the server sorted globally").toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — the participant can search
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.16 phase 6 — participant-facing search", () => {
  // v8.3.28 — THIS DESCRIBE OWNS ITS PARTICIPANT AND ITS COMPETITION.
  //
  // These tests used the seeded `alice`, and `loginParticipantInCompetition`
  // falls back to `competitions[0]` when it finds no LIVE event. alice's
  // enrolment set is whatever the rest of the suite has left her in, so on the
  // adjacency that put `ended-popup.spec.js` before this file she landed in an
  // ENDED "EndPop" competition with one challenge — where `all` is already the
  // default and the filter under test was never overridden by anything. The
  // failure then read as a filter regression rather than as a fixture that had
  // drifted (fixture checklist items 2, 3 and 10).
  //
  // Built ONCE for the describe and memoised: every test here wants the same
  // shape, and re-creating it per test would triple the setup for no isolation
  // gain — the file already gets a wiped database of its own.
  let _fx = null;
  async function liveFixture(page) {
    if (_fx) return _fx;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin", getSuperadminPass());
    const t = Date.now();
    const email = `filter-${t}@acme.com`;
    // Registered through the real endpoint, so the account is an ordinary
    // participant rather than one assembled by hand.
    const reg = await registerPost(sa, "/api/register", {
      headers: h(saCsrf),
      data: { firstName: "Filter", lastName: "Fixture", nickname: `filt${t}`,
              email, password: PARTICIPANT_PASS, company: "Acme Corp", title: "QA",
              country: "GB", timezone: "Europe/London" },
    });
    expect(reg.ok(), `register fixture participant: ${reg.status()}`).toBeTruthy();
    // `POST /api/register` returns no id. Resolve it through the admin list with
    // the endpoint's documented cap: `?search=` is a NO-OP there, so a small
    // limit silently means "the 50 OLDEST users" and would never contain a row
    // created a moment ago.
    const listed = await sa.get("/api/admin/participants?limit=5000");
    expect(listed.ok(), `list participants: ${listed.status()}`).toBeTruthy();
    const rows = (await listed.json()).participants || [];
    const uid = (rows.find(p => p.email === email) || {}).id;
    expect(uid, `fixture participant ${email} must be findable among ${rows.length} rows`).toBeTruthy();
    for (const ep of ["verify", "approve"]) {
      const r = await sa.post(`/api/admin/participants/${uid}/${ep}`, { headers: h(saCsrf) });
      expect(r.ok(), `${ep} fixture participant: ${r.status()}`).toBeTruthy();
    }
    // LIVE: started a minute ago, running for two hours.
    const comp = await sa.post("/api/admin/competitions", {
      headers: h(saCsrf),
      data: { name: `FilterFix ${t}`, start_time: new Date(t - 60_000).toISOString(),
              duration_minutes: 120, timezone: "Europe/London" },
    });
    expect(comp.ok(), `create fixture competition: ${comp.status()}`).toBeTruthy();
    const compId = (await comp.json()).competition?.id;
    // TWO challenges, so "unsolved" and "all" can differ; neither is solved, so
    // the default filter is observable.
    for (const n of [1, 2]) {
      const task = await sa.post("/api/admin/tasks", {
        headers: h(saCsrf),
        data: { title: `FilterFix task ${n} ${t}`, description: "d", difficulty: "easy",
                answer_type: "text", correct_answer: "x", status: "published",
                category: null },
      });
      expect(task.ok(), `create fixture task ${n}: ${task.status()}`).toBeTruthy();
      const tid = (await task.json()).id;
      const asg = await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: h(saCsrf), data: { competitionIds: [compId] } });
      expect(asg.ok(), `assign fixture task ${n}: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    }
    // The assign endpoint SKIPS ineligible users, so assert it took one.
    const asn = await sa.post("/api/admin/competitions/assign", {
      headers: h(saCsrf),
      data: { competitionIds: [compId], userIds: [uid] },
    });
    expect(asn.ok(), `assign fixture participant: ${asn.status()}`).toBeTruthy();
    expect((await asn.json()).assigned, "the fixture participant must be assigned").toBe(1);
    await sa.dispose();
    _fx = { email, compId, name: `FilterFix ${t}` };
    return _fx;
  }

  /** Sign the OWNED participant in and select the OWNED live competition. */
  async function enterOwnedLive(page) {
    const fx = await liveFixture(page);
    await loginParticipant(page, fx.email);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: h(csrf), data: { competitionId: fx.compId } });
    expect(sel.ok(), `select ${fx.name}: ${sel.status()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#tasks-page").waitFor({ state: "visible", timeout: 30000 });
    return fx;
  }

  test("v8.3.26: a chosen solve filter survives the status poll during a LIVE event", async ({ page }) => {
    // The chips were a control that appeared to work: `loadTasks()` reset the
    // filter to `unsolved` on every call while the event was live, ignoring the
    // `solveFilterUserSet` flag the click sets — and the 15 s status poll calls
    // `loadTasks()`. So a participant pressed **All**, saw the grid change, and
    // watched it change back within fifteen seconds with nothing to explain it.
    await enterOwnedLive(page);
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });

    // PRECONDITION: live, and defaulting to `unsolved` — without this the
    // assertion below is equally satisfied by an event that ended, where `all`
    // was already the default and nothing was ever overridden.
    //
    // POLLED, and it reports what it saw. A single `evaluate` here samples
    // whatever frame it lands in: the card that gates it can be visible while
    // `S.allTasks` is still being written, and `loginParticipantInCompetition`
    // falls back to `competitions[0]` when no LIVE one is found, which would
    // enter a finished event and make `ended` true for a reason that has nothing
    // to do with the filter. `{filter, ended}` alone could not tell those apart.
    let before = null;
    await expect.poll(async () => {
      before = await page.evaluate(() => ({
        tasks: (window.S?.allTasks || []).length,
        filter: window.S?.currentSolveFilter ?? null,
        ended: !!(window.S?.allTasks || [])[0]?.hackathon_ended,
        comp: window.S?.currentCompName ?? null,
      }));
      return before.tasks > 0;
    }, { timeout: 20000, intervals: [100, 200, 400, 800] }).toBe(true);
    expect({ filter: before.filter, ended: before.ended },
      `a LIVE event opens on the unsolved filter — observed ${JSON.stringify(before)}`
    ).toEqual({ filter: "unsolved", ended: false });

    await page.locator("#solve-filters .filter-btn[data-filter='all']").click();
    expect(await page.evaluate(() => window.S.currentSolveFilter)).toBe("all");

    // Drive the poll's own entry point rather than waiting 15 s for it.
    await page.evaluate(() => window.loadTasks && window.loadTasks());
    await expect.poll(() => page.evaluate(() => window.S.currentSolveFilter),
      { timeout: 15000 }).toBe("all");
    await expect(page.locator("#solve-filters .filter-btn[data-filter='all']"),
      "…and the chip still shows it").toHaveClass(/\bactive\b/);
  });

  test("the challenge list searches by title and by category, and says how many match", async ({ page }) => {
    await enterOwnedLive(page);
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
    // Show everything, so the assertion is about the SEARCH and not about the
    // solved-state chip that is forced on while a competition is live.
    await page.locator("#solve-filters .filter-btn[data-filter='all']").click();
    // Sample the FILTER STATE and the grid in ONE evaluate, and poll until they
    // agree. Two separate reads assert across a re-render (the v7.21.1 class),
    // and until v8.3.26 `loadTasks()` also FORCED the filter back to `unsolved`
    // on every 15 s status poll while the event was live — so a single click
    // could be undone between the click and the read, and this test sampled one
    // card where the fixture has two. That override is gone; polling on the
    // chip's own `active` state is what makes the read prove it.
    let snap = null;
    await expect.poll(async () => {
      snap = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("#task-grid .task-card")];
        return {
          allActive: !!document.querySelector("#solve-filters .filter-btn[data-filter='all'].active"),
          total: cards.length,
          titles: cards.map(c => (c.querySelector("h3")?.textContent || "").trim()),
        };
      });
      return snap.allActive;
    }, { timeout: 15000, intervals: [100, 200, 400, 800] }).toBe(true);
    const total = snap.total;
    expect(total, `the fixture needs more than one challenge; grid was ${JSON.stringify(snap.titles)}`).toBeGreaterThan(1);

    const firstTitle = snap.titles[0];
    expect(firstTitle, `the first card must have a title; grid was ${JSON.stringify(snap.titles)}`).toBeTruthy();
    await page.fill("#participant-task-search", firstTitle);
    await expect.poll(() => page.locator("#task-grid .task-card").count(), { timeout: 10000 }).toBeLessThan(total);
    await expect(page.locator("#task-grid .task-card h3").first()).toHaveText(firstTitle);
    // The count must say MATCH (the participant typed), not "shown".
    await expect(page.locator("#task-grid-count")).toContainText(/match/i);

    // A miss names the search rather than implying the list is empty.
    await page.fill("#participant-task-search", "zzz-no-such-challenge-zzz");
    await expect.poll(() => page.locator("#task-grid .task-card").count(), { timeout: 10000 }).toBe(0);
    await expect(page.locator("#task-grid"),
      "an empty result must name the query and what is searched"
    ).toContainText(/No challenges match/i);

    // Clearing restores everything.
    await page.locator("[data-action='participant-task-search-clear']").click();
    await expect.poll(() => page.locator("#task-grid .task-card").count(), {
      timeout: 10000,
      message: `Clear must restore all ${total} cards. If this is off by one the challenge SET moved under the test `
             + `(the grid is polled), not the search — the snapshot was ${JSON.stringify(snap.titles)}.`,
    }).toBe(total);
    expect(await page.inputValue("#participant-task-search"), "Clear empties the box").toBe("");
  });

  test("typing does not lose keystrokes or move the caret", async ({ page }) => {
    // v7.20.10's defect, in the shape that produced it: the handler re-renders a
    // container, and if the input lived INSIDE that container the characters
    // typed during the render would be overwritten and the caret clamped. These
    // inputs are siblings of the grid — this proves it, per keystroke.
    //
    // .fill() cannot reproduce it (it sets the value atomically); that is
    // exactly why two existing tests drove other inputs and never caught it.
    await enterOwnedLive(page);
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
    const box = page.locator("#participant-task-search");
    await box.click();
    await box.pressSequentially("chall", { delay: 60 });
    expect(await box.inputValue(), "every keystroke must survive the re-render").toBe("chall");
    expect(await box.evaluate(el => el.selectionStart), "the caret must stay at the end").toBe(5);
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id),
      "focus must stay in the search box").toBe("participant-task-search");
  });

  test("the competition picker searches by name", async ({ page }) => {
    // OWNS ITS PARTICIPANT. The shared `alice` carries an ambient
    // active_competition_id whose value depends on what ran before her in this
    // file, so boot routes her to the tasks page and reaching the picker means
    // walking a "Leave Event?" confirm that is there on some runs and not
    // others — which is a flake, not a test. A participant registered here has
    // no active competition, so the picker IS the landing view.
    const stamp = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const mk = async name => (await (await sa.post("/api/admin/competitions", {
      headers: h(saCsrf),
      data: { name, start_time: new Date(stamp + 3_600_000).toISOString(), duration_minutes: 120 },
    })).json()).competition.id;
    const compAlpha = await mk(`PickerAlpha ${stamp}`);
    const compBeta  = await mk(`PickerBeta ${stamp}`);

    const email = `picker-${stamp}@company.com`;
    const { csrfToken: ac } = await (await page.request.get("/api/csrf-token")).json();
    const reg = await registerPost(page.request, "/api/register", {
      headers: h(ac),
      data: {
        firstName: "Pick", lastName: "Er", nickname: `picker_${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
      },
    });
    expect(reg.status(), "fixture participant registered").toBe(200);
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: h(saCsrf), data: { userIds: [u.id], competitionIds: [compAlpha, compBeta] },
    });
    expect((await asg.json()).assigned, "the participant must actually be enrolled").toBeGreaterThan(0);
    await sa.dispose();

    await loginParticipant(page, email);
    await page.locator("#comp-grid").waitFor({ state: "visible", timeout: 30000 });
    await expect.poll(() => page.locator("#comp-grid .comp-card").count(), { timeout: 20000 }).toBe(2);

    // A search that matches exactly one of the two.
    await page.fill("#participant-comp-search", "PickerAlpha");
    await expect.poll(() => page.locator("#comp-grid .comp-card").count(), { timeout: 10000 }).toBe(1);
    await expect(page.locator("#comp-grid")).toContainText(`PickerAlpha ${stamp}`);
    await expect(page.locator("#comp-grid")).not.toContainText(`PickerBeta ${stamp}`);
    await expect(page.locator("#comp-grid-count"), "the count must say MATCH, not shown").toContainText(/match/i);

    // A miss names the query rather than implying there are no competitions.
    await page.fill("#participant-comp-search", "zzz-no-such-competition-zzz");
    await expect(page.locator("#comp-grid")).toContainText(/No events match/i, { timeout: 10000 });

    // Clearing restores both.
    await page.locator("[data-action='participant-comp-search-clear']").click();
    await expect.poll(() => page.locator("#comp-grid .comp-card").count(), { timeout: 10000 }).toBe(2);
    expect(await page.inputValue("#participant-comp-search"), "Clear empties the box").toBe("");
  });

  test("the LEADERBOARD is deliberately NOT searchable", async ({ page }) => {
    // Not an omission — a fairness invariant. The participant board is capped at
    // 20 plus your own row, and a control that could surface someone not already
    // visible would leak the field size the payload is built to withhold
    // (functional-security pins the response keys for the same reason). If a
    // search is ever wanted here it has to be a deliberate decision, so this
    // test exists to make adding one fail rather than slip in with a sweep.
    await loginParticipant(page);
    await page.evaluate(() => window.showLeaderboard && window.showLeaderboard());
    await page.waitForTimeout(800);
    expect(await page.locator("#leaderboard-page input[type='search'], #leaderboard-page .search-wrap").count(),
      "the participant leaderboard must not gain a search box without a deliberate decision"
    ).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.2 — Submissions rows link into the panes that own them
//
// Owns its whole fixture (competition, challenge, participant) per the
// competition-fixture checklist. The participant solves the ONE challenge, which
// would normally trip the all-solved auto-end — a second enrolled participant
// who solves nothing keeps the competition live.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.2 — submissions click-through", () => {
  const crypto = require("crypto");

  async function seed() {
    const tag = crypto.randomBytes(3).toString("hex");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `SubLink-${tag}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    const title = `SubLinkChallenge ${tag}`;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: H, data: {
      title, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "right", status: "published",
      // A hint, so the third test can reveal one and render the OTHER row
      // template. Without it the reveal 400s "This challenge has no hint".
      hint: "Try the obvious thing.", explanation: "<p>Because.</p>",
    }})).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [compId] } });

    // Two participants; only the first acts, so the all-solved auto-end cannot
    // fire and end the competition under the test.
    const mk = async (label) => {
      const email = `sublink-${label}-${tag}@cust.test`;
      await registerPost(sa, "/api/register", { headers: H, data: {
        firstName: "Sub", lastName: label, nickname: `sub_${label}_${tag}`, email,
        company: "Acme", title: "Eng", avatar: "default1", country: "US", timezone: "UTC",
      }});
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      const u = (list.participants || []).find(p => p.email === email);
      expect(u, `participant ${email} created`).toBeTruthy();
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
      await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });
      return { id: u.id, email, nickname: `sub_${label}_${tag}` };
    };
    const solver = await mk("solver");
    const bystander = await mk("bystander");
    await sa.post("/api/admin/competitions/assign", { headers: H, data: {
      userIds: [solver.id, bystander.id], competitionIds: [compId],
    }});

    // One real submission, through the real path (grading token included).
    const { api: p, csrf: pc } = await apiLogin(solver.email, PARTICIPANT_PASS);
    await p.post("/api/select-competition", { headers: h(pc), data: { competitionId: compId } });
    const gh = (await (await p.get(`/api/tasks/${taskId}`)).json()).grading_hash;
    const sub = await p.post(`/api/tasks/${taskId}/submit`, { headers: h(pc), data: { answer: "right", gradingHash: gh } });
    expect(sub.ok(), `submit: ${sub.status()} ${await sub.text()}`).toBeTruthy();
    await p.dispose();
    return { tag, compId, taskId, title, solver, bystander, sa, csrf };
  }

  async function cleanup(fx) {
    await fx.sa.delete(`/api/admin/competitions/${fx.compId}`, { headers: { "x-csrf-token": fx.csrf } }).catch(() => {});
    await fx.sa.delete(`/api/admin/tasks/${fx.taskId}`, { headers: { "x-csrf-token": fx.csrf } }).catch(() => {});
    for (const u of [fx.solver, fx.bystander]) {
      await fx.sa.delete(`/api/admin/participants/${u.id}`, { headers: { "x-csrf-token": fx.csrf } }).catch(() => {});
    }
    await fx.sa.dispose();
  }

  /** Open Submissions narrowed to this fixture's rows. */
  async function openSubmissions(page, term) {
    // RBAC sidebar — Submissions has no sidebar item (Audit covers it); its pane keeps its id.
    await page.locator("#admin-page").waitFor({ state: "visible" });
    await page.evaluate(() => window.adminTab(null, "admin-submissions-tab"));
    const search = page.locator("#submissions-search");
    await search.waitFor({ state: "visible", timeout: 15000 });
    await search.fill(term);
    const row = page.locator("#admin-submissions-body tr").first();
    await expect.poll(async () => row.innerText().catch(() => ""),
      { timeout: 15000, message: "the fixture's submission row must be listed" }).toContain(term);
    return row;
  }

  test("clicking the participant opens Participants filtered to them", async ({ page }) => {
    const fx = await seed();
    try {
      await loginSuperadmin(page);
      const row = await openSubmissions(page, fx.solver.nickname);
      await row.locator(`.sub-link[data-nickname="${fx.solver.nickname}"]`).click();

      await expect(page.locator("#admin-participants-tab")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#participants-tab-btn")).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#participants-search")).toHaveValue(fx.solver.nickname);
      const rows = page.locator("#admin-participants-body tr");
      await expect.poll(async () => rows.count(), { timeout: 10000 }).toBe(1);
      await expect(rows.first()).toContainText(fx.solver.nickname);
    } finally { await cleanup(fx); }
  });

  test("clicking the challenge opens Challenges filtered to it", async ({ page }) => {
    const fx = await seed();
    try {
      await loginSuperadmin(page);
      const row = await openSubmissions(page, fx.solver.nickname);
      await row.locator(`.sub-link[data-title="${fx.title}"]`).click();

      await expect(page.locator("#admin-tasks-tab")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#task-search")).toHaveValue(fx.title);
      const rows = page.locator("#admin-task-body tr");
      await expect.poll(async () => rows.count(), { timeout: 10000 }).toBe(1);
      await expect(rows.first()).toContainText(fx.title);
    } finally { await cleanup(fx); }
  });

  test("BOTH row templates carry the links — a hint row too, not just a submission", async ({ page }) => {
    // The hint and submission rows are separate templates in submissions-admin.js.
    // Patching one and not the other works in one view only, which is how it
    // would be reported as "it works for some rows". Reveal a hint so the OTHER
    // template renders, and assert the links on that row specifically.
    const fx = await seed();
    try {
      const { api: p, csrf: pc } = await apiLogin(fx.bystander.email, PARTICIPANT_PASS);
      await p.post("/api/select-competition", { headers: h(pc), data: { competitionId: fx.compId } });
      const hint = await p.post(`/api/tasks/${fx.taskId}/hint`, { headers: h(pc) });
      expect(hint.ok(), `reveal hint: ${hint.status()} ${await hint.text()}`).toBeTruthy();
      await p.dispose();

      await loginSuperadmin(page);
      const row = await openSubmissions(page, fx.bystander.nickname);
      await expect(row.locator(".sub-event-pill.is-hint"), "this must be the HINT template").toHaveCount(1);
      await expect(row.locator(`.sub-link[data-nickname="${fx.bystander.nickname}"]`)).toHaveCount(1);
      await expect(row.locator(`.sub-link[data-title="${fx.title}"]`)).toHaveCount(1);
    } finally { await cleanup(fx); }
  });
});
