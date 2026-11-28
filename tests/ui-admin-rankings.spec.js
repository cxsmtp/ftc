// @ts-check
//
// Part of the ui-admin suite, split from a single 4,833-line file in v7.21.35.
//
// Contains: Admin sidebar isolation (v6.17.0) · v7.8.0 — challenge competition badges hide ended competitions · Admin create flows, end to end (v7.15.16) · v7.20.9 (ext-audit F9) — admin rankings
//
// WHY IT WAS SPLIT: a spec file never spans workers, so the old file was a
// 181-second serial floor inside a 248-second suite — 73% of the wall clock in
// one worker, which no worker count could improve (WORKERS=16 bought 5.8%).
// Shared helpers live in ./ui-admin-helpers so the copies cannot drift.
const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
// v8.17.0 — First/Last Name are under Columns by default; these tests read and sort them.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllTableColumns(page, "rankings", ["place", "player", "first", "last", "company", "email", "score", "time", "solved"]); });
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, PORT_BASE, gradingHashFor } = require("./helpers");
const {
  login, loginViaApi, saLoginRetry, filterComps, adminLogin, participantLogin,
  clickTab, openKebab, findSeededTaskRow, viewComp, CONFIRM_PROBE_MS, AxeBuilder, AXE_GATED_IMPACTS, openCompCreateForm, narrowChallengesTable } = require("./ui-admin-helpers");

// Route every page.goto() + page.request.* to THIS worker's server.
test.use({ baseURL: BASE });


// ═══════════════════════════════════════════════════════════════════════════════
// Admin sidebar isolation — v6.17.0 regression lock
// Ensures admin chrome (sidebar, hamburger, overlay) is never visible on
// non-admin pages. The original bug: #admin-page{display:flex} overrode
// .page{display:none} because the ID selector wins specificity.
// Fix: #admin-page.active{display:flex} — only active when admin is shown.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin sidebar isolation (v6.17.0)", () => {
  test("login page: #admin-page is hidden and sidebar chrome is not visible", async ({ page }) => {
    await page.goto("/");
    // Login page is the default for anonymous users
    await page.locator("#login-page").waitFor({ state: "visible" });
    // The admin page element must not be rendered (display:none via .page)
    await expect(page.locator("#admin-page")).not.toBeVisible();
    // Sidebar and its nav items must not be visible either
    await expect(page.locator("#admin-sidebar")).not.toBeVisible();
    await expect(page.locator("#admin-mobile-menu-btn")).not.toBeVisible();
    await expect(page.locator(".admin-nav-item").first()).not.toBeVisible();
    // Overlay must not be visible
    await expect(page.locator("#admin-sidebar-overlay")).not.toBeVisible();
  });

  test("participant logged-in view: admin sidebar is not visible", async ({ page }) => {
    // participantLogin navigates to / and waits for the participant UI to appear
    await participantLogin(page);
    // Admin chrome must be invisible — no admin page, no sidebar, no hamburger
    await expect(page.locator("#admin-page")).not.toBeVisible();
    await expect(page.locator("#admin-sidebar")).not.toBeVisible();
    await expect(page.locator("#admin-mobile-menu-btn")).not.toBeVisible();
  });

  test("admin logged-in view: sidebar IS visible with all 11 nav items", async ({ page }) => {
    await adminLogin(page);
    await expect(page.locator("#admin-page")).toBeVisible();
    await expect(page.locator("#admin-sidebar")).toBeVisible();
    // All 11 nav items present: Manage 7 (Events, New event, Question bank,
    // Live rankings, Analytics, Marketing, Audit), Participants 2 (People,
    // Groups), Admin 2 (Roles & permissions, Settings). Submissions and Logs are
    // reached through Audit.
    await expect(page.locator(".admin-nav-item")).toHaveCount(11);
    // Exactly one item is marked active with aria-current
    await expect(page.locator(".admin-nav-item[aria-current='page']")).toHaveCount(1);
  });
});


// v7.8.0 — the Challenges table's per-challenge competition column shows only
// live/upcoming comps; ENDED (past) comps are hidden so the column stays focused
// on what's actionable (mirrors the Participants view, v6.20.5). The currently-
// scoped comp is kept even if ended (covered by the participants precedent); here
// we assert the unscoped case: a challenge in one live + one ended comp shows only
// the live badge.
test.describe("v7.8.0 — challenge competition badges hide ended competitions", () => {
  test("challenge badges show live/upcoming comps, hide ended ones", async ({ page }) => {
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const s = Date.now().toString(36);
    const title = `ChBadge_${s}`;
    const liveName = `ChLive_${s}`, endedName = `ChEnded_${s}`;
    let taskId, liveId, endedId;
    try {
      // Throwaway PUBLISHED task.
      taskId = (await (await page.request.post("/api/admin/tasks", { headers: H, data: {
        title, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published",
      }})).json()).task?.id
        || (await (await page.request.get("/api/admin/tasks")).json()).find?.(t => t.title === title)?.id;
      // resolve id robustly from the list if the create response shape differs
      if (!taskId) {
        const all = (await (await page.request.get("/api/admin/tasks")).json());
        taskId = (Array.isArray(all) ? all : all.tasks || []).find(t => t.title === title)?.id;
      }
      expect(taskId, "throwaway task must be created").toBeTruthy();
      // Two live comps; assign the task to both while both are live, then end one.
      const mkLive = async (name) => (await (await page.request.post("/api/admin/competitions", { headers: H, data: {
        name, start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 180,
      }})).json()).competition.id;
      liveId = await mkLive(liveName);
      endedId = await mkLive(endedName);
      await page.request.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [liveId, endedId] } });
      await page.request.post(`/api/admin/competitions/${endedId}/end-now`, { headers: H, data: {} });

      // Unscoped Challenges tab, isolate the task row via search (the table is
      // paginated, so a throwaway task can land on a later page).
      await clickTab(page, "Challenges");
      await narrowChallengesTable(page, title);
      const row = page.locator("#admin-task-body tr", { hasText: title }).first();
      await expect(row).toBeVisible({ timeout: 10000 });
      // Live comp badge shows; ended one is filtered out.
      await expect(row.locator(".comp-badge", { hasText: liveName })).toBeVisible();
      await expect(row.locator(".comp-badge", { hasText: endedName })).toHaveCount(0);
    } finally {
      if (endedId) await page.request.delete(`/api/admin/competitions/${endedId}`, { headers: H }).catch(() => {});
      if (liveId) await page.request.delete(`/api/admin/competitions/${liveId}`, { headers: H }).catch(() => {});
      if (taskId) await page.request.delete(`/api/admin/tasks/${taskId}`, { headers: H }).catch(() => {});
    }
  });
});


test.describe("Admin create flows, end to end (v7.15.16)", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  test("a challenge can be created and published through the UI", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const title = `UI created challenge ${Date.now()}`;
    try {
      await page.locator('[data-action="open-task-form"]').first().click();
      await page.locator("#tf-title").waitFor({ state: "visible", timeout: 15000 });

      await page.locator("#tf-title").fill(title);
      await page.locator("#tf-answer").fill("the-answer");
      // The description is a rich-text contenteditable, not an <input>.
      await page.locator("#tf-desc").click();
      await page.keyboard.type("Created through the admin UI.");

      await page.locator('[data-action="save-task"][data-status="published"]').first().click();

      // The list refreshes and the challenge is really there — asserted from the
      // DATABASE, so a purely cosmetic row insertion cannot satisfy this.
      await expect.poll(() => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return db.prepare("SELECT status FROM tasks WHERE title=?").get(title)?.status || null; }
        finally { db.close(); }
      }, { timeout: 15000, intervals: [100, 200, 400, 800] }).toBe("published");

      // Deliberately NOT asserting the row is visible in the table. The list is
      // paginated and its post-save reload races under load, so that assertion
      // exercises the list widget rather than the create flow — and the list is
      // already covered by other tests here. What THIS test is for is that the
      // flow commits, which the database check above proves; the editor closing
      // is the flow's own completion signal.
      await expect(page.locator("#tf-title"), "the editor closes on a successful save").toBeHidden({ timeout: 15000 });
    } finally {
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("DELETE FROM tasks WHERE title=?").run(title); } finally { db.close(); }
    }
  });

  test("a competition can be created through the UI", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    const name = `UI created comp ${Date.now()}`;
    try {
      await openCompCreateForm(page);
      await page.locator("#comp-name").fill(name);
      // Start is a separate date + time pair, and the duration is split across
      // days / hours / minutes — the form is not one datetime-local field.
      const start = new Date(Date.now() + 3600_000);
      const pad = (n) => String(n).padStart(2, "0");
      await page.locator("#comp-date").fill(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
      await page.locator("#comp-time").fill(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
      await page.locator("#comp-dur-h").fill("2");
      await page.locator('[data-action="comp-save"]').first().click();
      // The save opens a "Create Competition?" summary confirmation showing the
      // computed start/end/duration. An API-level test never sees this step,
      // which is precisely why the UI flow needed its own coverage.
      const confirm = page.locator("#modal-overlay");
      await expect(confirm).toContainText("Create Competition?", { timeout: 10000 });
      await expect(confirm, "the confirmation summarises what will be created").toContainText(name);
      await confirm.locator("button", { hasText: /^Create$/ }).first().click();

      await expect.poll(() => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return !!db.prepare("SELECT 1 FROM competitions WHERE name=?").get(name); }
        finally { db.close(); }
      }, { timeout: 15000, intervals: [100, 200, 400, 800] }).toBe(true);

      // Same reasoning as the challenge test above — the database check is the
      // proof; the confirmation modal closing is the flow's completion signal.
      await expect(page.locator("#comp-name"), "the form closes on a successful create").toBeHidden({ timeout: 15000 });
    } finally {
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("DELETE FROM competitions WHERE name=?").run(name); } finally { db.close(); }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// External-audit round 8 (v7.20.9) — F9 (rankings) + F12 (analytics empty state)
// ═══════════════════════════════════════════════════════════════════════════════
// Three rankings regressions of things this file already claims, plus the two
// halves of the analytics empty-state fix. Every assertion below carries a
// positive control, because each one is otherwise satisfiable by "the feature
// never ran" — a board that renders nothing has no expander either, a view that
// never fetches issues no requests, and a pagination bar that was never
// populated is trivially empty.
test.describe("v7.20.9 (ext-audit F9) — admin rankings", () => {
  const RH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

  // F9a — `loadAdminLeaderboardPerSlot` was the ONE load path v7.17.0's
  // S._rkCache never reached, so a column sort on the per-SESSION view still
  // re-issued one /api/admin/leaderboard request PER TIMESLOT for a pure
  // client-side reorder of data already in hand.
  test("sorting the PER-SESSION rankings view serves from cache — no refetch", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = Date.now();
    const compName = `RkSlotCache ${t}`;
    let compId = null;
    try {
      compId = (await (await sa.post("/api/admin/competitions", {
        headers: RH(csrf),
        data: {
          name: compName, start_time: new Date(t - 60_000).toISOString(),
          duration_minutes: 240, leaderboard_mode: "per_slot",
        },
      })).json()).competition.id;
      // TWO sessions: the per-slot card view only renders at timeslots.length > 1,
      // and two is also what makes "one request per timeslot" observable as a
      // number distinct from the single-board case.
      for (const n of ["Morning", "Afternoon"]) {
        const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
          headers: RH(csrf),
          data: { name: `${n} ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 120 },
        });
        expect(r.ok(), `create timeslot ${n}: ${r.status()}`).toBeTruthy();
      }

      await adminLogin(page);
      await clickTab(page, "Events");
      // The scope helpers read from S.adminCompetitionsData, so wait for the
      // freshly-created comp to be in it rather than racing the list load.
      await expect.poll(
        () => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), compId),
        { timeout: 20000, intervals: [100, 200, 400, 800] },
      ).toBe(true);
      await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), { id: compId, name: compName });
      await clickTab(page, "Rankings");
      // The per-session card view really rendered — one card per timeslot.
      await expect(page.locator(".rankings-slot-card")).toHaveCount(2, { timeout: 20000 });

      // Start counting only once the initial load has settled.
      await page.waitForTimeout(700);
      let lbReqs = 0;
      page.on("request", (r) => { if (r.url().includes("/api/admin/leaderboard")) lbReqs++; });

      const th = page.locator(".rankings-slot-card th[data-col='score']").first();
      await expect(th).toBeVisible();
      await th.click();
      // POSITIVE CONTROL for the click itself: without this, "zero requests"
      // is equally satisfied by a click that did nothing at all.
      await expect(th, "the click really sorted the board").toHaveAttribute("aria-sort", "ascending", { timeout: 10000 });
      await page.waitForTimeout(1000);
      expect(lbReqs, "a sort is a pure client-side reorder — it must not refetch").toBe(0);

      // POSITIVE CONTROL for the counter: an explicit Refresh DOES go back to
      // the network, once per timeslot. Without this the test passes on a build
      // that never fetches (or on a broken request listener).
      await page.locator("[data-action='rankings-refresh']").first().click();
      await expect.poll(() => lbReqs, { timeout: 15000, intervals: [100, 200, 400, 800] }).toBeGreaterThanOrEqual(2);
    } finally {
      if (compId) {
        await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: RH(csrf) }).catch(() => {});
        await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  // F9b — v7.20.8 capped the INDIVIDUAL boards at 50 rows with a "Show all N"
  // expander and missed the group board sitting directly beneath one of them.
  // The group board mixes group aggregates with every SOLO individual, so it is
  // the LONGER of the two: on a 300-person competition with two teams the two
  // tables on one screen disagreed about how many rows a board shows.
  //
  // Driven through the renderer directly (it is on `window` via boot()'s module
  // namespace) rather than by seeding 51 real board entries — the assertion is
  // about the renderer's slice, and 51 participants would cost minutes.
  test("the GROUP rankings board caps at 50 rows with a Show all expander", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Rankings");
    const key = `gbcap-${Date.now()}`;

    const res = await page.evaluate(({ key }) => {
      // A board of n entries: alternating group aggregates and solo individuals,
      // which is exactly the mix this board renders.
      const mk = (n) => Array.from({ length: n }, (_, i) => ({
        type: i % 2 === 0 ? "group" : "individual",
        rank: i + 1, name: `Team ${i}`, nickname: `player${i}`, memberCount: 3,
        score: 100 - i, solveTimeMs: 60_000 + i * 1000, allSolved: i === 0, avatar: "default1",
      }));
      const expanderCount = (h) => (h.match(/data-action="rankings-toggle-more"/g) || []).length;
      const dataRows = (h) => (h.match(/<tr\b/g) || []).length - (h.match(/rankings-more-row/g) || []).length;

      // Exactly at the cap — nothing is hidden, so NO expander may render.
      const short = window.renderGroupBoardTable(mk(50), `${key}-short`);
      // Past the cap.
      const long = window.renderGroupBoardTable(mk(63), `${key}-long`);
      // Expanding is the same toggle the individual boards use.
      try { window._rkToggleExpanded(`${key}-long`); } catch (_) { /* the re-render it triggers is irrelevant here */ }
      const expanded = window.renderGroupBoardTable(mk(63), `${key}-long`);

      return {
        shortRows: dataRows(short), shortExpanders: expanderCount(short),
        longRows: dataRows(long), longExpanders: expanderCount(long), longLabel: /Show all 63/.test(long),
        expandedRows: dataRows(expanded), expandedLabel: /Show top 50/.test(expanded),
        isExpanded: window._rkIsExpanded(`${key}-long`),
      };
    }, { key });

    // A short board renders every row AND no control — the expander must not
    // appear when nothing is hidden. Asserting the row count too is what stops
    // "no expander" passing on a renderer that returned nothing at all.
    expect(res.shortRows, "a 50-entry board renders all 50 rows").toBe(50);
    expect(res.shortExpanders, "nothing is hidden, so no expander").toBe(0);

    expect(res.longRows, "a 63-entry board renders only the first 50").toBe(50);
    expect(res.longExpanders, "…and exactly one expander").toBe(1);
    expect(res.longLabel, "the expander names the full count").toBe(true);

    expect(res.isExpanded, "the toggle flipped the board's expand state").toBe(true);
    expect(res.expandedRows, "expanding shows all 63").toBe(63);
    expect(res.expandedLabel, "the control now offers the way back").toBe(true);
  });

  // F9c — `rankingsThead` relied on `_enableSortableA11y`'s MutationObserver to
  // add tabindex, and that callback runs on a LATER microtask than the paint
  // pass that calls th.focus(). So the v7.15.2 focus restoration was a silent
  // no-op on all four rankings tables: a keyboard user lost their place on
  // every sort. The attribute is emitted with the markup now.
  test("a rankings header is focusable AT RENDER, and sorting restores focus to it", async ({ page }) => {
    await adminLogin(page);

    // The synchronous half: the markup itself carries the attributes, with no
    // observer involved. This is precisely the part that used to arrive late.
    const markup = await page.evaluate(() => window.rankingsThead("f9c-probe"));
    expect(markup, "tabindex is emitted inline, not supplied by the observer").toContain('tabindex="0"');
    expect(markup, "columnheader is what supports aria-sort").toContain('role="columnheader"');
    expect(markup).toContain('aria-sort="none"');

    // The behavioural half. It must run on a view whose <thead> is actually
    // REBUILT by a sort — the focused single-comp table reuses its existing
    // table element, so the th there is never destroyed and focus survives for
    // the wrong reason. The all-live card view rebuilds the whole container.
    await clickTab(page, "Rankings");
    const th = page.locator(".rankings-picker-card th[data-col='score']").first();
    await expect(th, "the all-live card view is what rebuilds its theads").toBeVisible({ timeout: 20000 });

    await th.focus();
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute?.("data-col")),
      "positive control: the header takes focus in the first place",
    ).toBe("score");

    await page.keyboard.press("Enter");
    await expect(th, "Enter on a sortable header sorts it").toHaveAttribute("aria-sort", "ascending", { timeout: 10000 });

    const after = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el ? el.tagName : null,
        col: el && el.getAttribute ? el.getAttribute("data-col") : null,
        inRankings: !!(el && el.closest && el.closest("#admin-rankings-tab")),
      };
    });
    expect(after, "the re-render destroyed the th — focus must land on its replacement")
      .toEqual({ tag: "TH", col: "score", inRankings: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.0 — rankings identity columns, copy, search and click-through
//
// Own fixture throughout (competition, challenges, participants), per the
// competition-fixture checklist: the seeded boards are shared and mutable, and
// a leaderboard assertion against a staff-tagged or never-active participant
// passes VACUOUSLY rather than failing. Two participants are enrolled and only
// one solves, so the all-solved auto-end cannot fire and end the competition
// under the test.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.0 — rankings identity columns", () => {
  const crypto = require("crypto");
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  /** Board with three participants whose identity fields VARY on every column. */
  async function seedBoard() {
    const tag = crypto.randomBytes(4).toString("hex");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const jsonH = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const compName = `RkIdent-${tag}`;
    const compId = (await (await sa.post("/api/admin/competitions", {
      headers: jsonH,
      data: { name: compName, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 180 },
    })).json()).competition.id;

    // Distinctive, deliberately UNSORTED values so every comparator has to do
    // real work: nickname order (zoe, adam, mid) disagrees with first-name
    // order (Alpha, Mid, Zed) and with company order (Aardvark, Mid, Zephyr).
    // The third row leaves company + email EMPTY, which is what exercises the
    // blanks-last rule and the em-dash cell.
    const people = [
      { n: `zoe_${tag}`,  f: "Alpha", l: "Zulu",  c: `Aardvark ${tag}`, e: `rk-alpha-${tag}@cust.test` },
      { n: `adam_${tag}`, f: "Zed",   l: "Alpha", c: `Zephyr ${tag}`,   e: `rk-zed-${tag}@cust.test` },
      { n: `mid_${tag}`,  f: "Mid",   l: "Mid",   c: "",                e: "" },
    ];
    const ids = [];
    const dbW = new Database(TEST_DB_PATH);
    try {
      const insU = dbW.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, company, avatar, verified, approved, password_hash, created_at) VALUES (?,?,?,?,?,?,?,1,1,?,?)");
      const insCU = dbW.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, login_time) VALUES (?,?,?,?,?)");
      dbW.transaction(() => {
        people.forEach((p, i) => {
          const id = `rkident-${tag}-${i}`;
          ids.push(id);
          // email is NOT NULL-able in practice for a real account, but the third
          // row must have an EMPTY one to exercise the blank cell; a unique
          // placeholder keeps the NOCASE unique index happy while still being
          // empty as far as the board is concerned.
          insU.run(id, p.f, p.l, p.n, p.e || `placeholder-${tag}-${i}@cust.test`, p.c, "default1",
            "$2b$10$dummyhashdoesnotneedtowork", new Date(t - 90 * 60_000).toISOString());
          const lt = new Date(t - 10 * 60_000 + i * 1000).toISOString();
          insCU.run(compId, id, "test-system", lt, lt);
        });
        // The third row's email is blanked AFTER insert so the unique index is
        // never asked to hold two empty strings.
        dbW.prepare("UPDATE users SET email='' WHERE id=?").run(ids[2]);
      })();
    } finally { dbW.close(); }

    // v8.8.14 — BUST THE SERVER'S PARTICIPANTS CACHE, because everything above
    // wrote STRAIGHT TO SQLITE and so reached none of the ~43 call sites that
    // invalidate it. GET /api/admin/participants caches a page for 5 s keyed on
    // (competition, page, limit, actor), and this file runs six tests that each
    // insert a fresh cohort and then delete it — so the pane could be served the
    // PREVIOUS test's cohort, with this one's people simply absent.
    //
    // It went unnoticed until v8.8.11 pointed the FOCUSED participants pane at
    // this endpoint; before that the pane used the picker, which has no cache.
    // The failure looked like a load race and was not: the diagnostic below
    // caught a model that was fully loaded, six rows, target absent.
    //
    // A tag add is a REAL admin write and invalidates as a side effect — the
    // idiom functional-core-c.api.spec.js already uses for the same cache, for
    // the same reason. Tagged on THIS fixture's own user rather than on a shared
    // seeded one, so `cleanup` takes the tag away with the row and nothing
    // accumulates on alice.
    const bust = await sa.post(`/api/admin/participants/${ids[0]}/tags`, {
      headers: jsonH, data: { tag: "cache-bust-" + Date.now() },
    });
    expect(bust.ok(), `cache-bust tag: ${bust.status()} ${await bust.text()}`).toBeTruthy();

    return { tag, compName, compId, ids, people, sa, jsonH };
  }

  async function cleanup({ compId, ids, sa }) {
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare("DELETE FROM competition_users WHERE competition_id=?").run(compId);
      dbW.prepare("DELETE FROM competitions WHERE id=?").run(compId);
      for (const id of ids) dbW.prepare("DELETE FROM users WHERE id=?").run(id);
    } finally { dbW.close(); }
    await sa.dispose();
  }

  /** Open the focused single-competition board for `compName`. */
  async function openBoard(page, compName) {
    await adminLogin(page);
    await clickTab(page, "Events");
    await viewComp(page, compName);
    await clickTab(page, "Rankings");
    const body = page.locator("#admin-rankings-body");
    await body.locator("tr").first().waitFor({ state: "attached", timeout: 15000 });
    return body;
  }

  /** The rendered identity columns, row by row, in DOM order. */
  const readRows = (body) => body.locator("tr").evaluateAll(rs => rs.map(r => {
    const td = r.querySelectorAll("td");
    const txt = i => (td[i]?.querySelector(".rk-id-text")?.textContent ?? td[i]?.textContent ?? "").trim();
    return {
      nickname: (td[1]?.querySelector(".rk-player-link")?.textContent || "").trim(),
      first: txt(2), last: txt(3), company: txt(4), email: txt(5),
    };
  }));

  test("the board renders first name, last name, company and email, and each one sorts", async ({ page }) => {
    const fx = await seedBoard();
    try {
      const body = await openBoard(page, fx.compName);
      const rows = await readRows(body);
      expect(rows.length, "fixture must render three rows").toBe(3);

      // Every seeded value reaches the screen. This is the positive control for
      // everything below: without it, a board rendering blank identity cells
      // would still satisfy the sort assertions (all-empty sorts as stable).
      const byNick = Object.fromEntries(rows.map(r => [r.nickname, r]));
      for (const p of fx.people) {
        expect(byNick[p.n], `row for ${p.n}`).toBeTruthy();
        expect(byNick[p.n].first).toBe(p.f);
        expect(byNick[p.n].last).toBe(p.l);
      }
      expect(byNick[fx.people[0].n].company).toBe(fx.people[0].c);
      expect(byNick[fx.people[0].n].email).toBe(fx.people[0].e);
      // An unset field renders an em-dash, never "undefined" or an empty cell
      // the admin cannot tell from a rendering failure.
      expect(byNick[fx.people[2].n].company).toBe("—");
      expect(byNick[fx.people[2].n].email).toBe("—");

      // Each identity column ORDERS the rows — asserted in both directions, so a
      // comparator that returns 0 (or ignores direction) cannot pass.
      for (const [col, field] of [["first", "first"], ["last", "last"]]) {
        const th = page.locator(`#admin-rankings-tab th[data-col="${col}"]`).first();
        await th.click();
        await expect(th).toHaveAttribute("aria-sort", "ascending");
        const asc = (await readRows(body)).map(r => r[field]);
        await th.click();
        await expect(th).toHaveAttribute("aria-sort", "descending");
        const desc = (await readRows(body)).map(r => r[field]);
        expect(asc, `${col} ascending is ordered`).toEqual([...asc].sort((a, b) => a.localeCompare(b)));
        expect(desc, `${col} descending is the reverse of ascending`).toEqual([...asc].reverse());
      }
    } finally { await cleanup(fx); }
  });

  test("an empty identity value sorts LAST in both directions", async ({ page }) => {
    // The rule cannot live in the comparator — _rkApplySort negates whatever a
    // comparator returns on the descending pass, so a blanks-last comparator is
    // a blanks-FIRST one after a second click. Assert both directions or the
    // test cannot tell the two implementations apart.
    const fx = await seedBoard();
    try {
      const body = await openBoard(page, fx.compName);
      const th = page.locator('#admin-rankings-tab th[data-col="company"]').first();
      for (const dir of ["ascending", "descending"]) {
        await th.click();
        await expect(th).toHaveAttribute("aria-sort", dir);
        const companies = (await readRows(body)).map(r => r.company);
        expect(companies.at(-1), `the unset company sorts last (${dir})`).toBe("—");
      }
    } finally { await cleanup(fx); }
  });

  test("the search narrows the board across every identity field and reports the count", async ({ page }) => {
    const fx = await seedBoard();
    try {
      const body = await openBoard(page, fx.compName);
      const search = page.locator("#rankings-search");
      await expect(search, "the search box is a sibling of the re-rendered container, so it must be present").toBeVisible();

      // Match on COMPANY — a field the search would miss if it only looked at
      // the nickname, which is what every other admin search started as.
      await search.fill(`Zephyr ${fx.tag}`);
      await expect.poll(async () => (await readRows(body)).map(r => r.nickname)).toEqual([fx.people[1].n]);
      await expect(page.locator("#rankings-search-count")).toContainText("1 of 3");

      // Match on EMAIL.
      await search.fill(fx.people[0].e);
      await expect.poll(async () => (await readRows(body)).map(r => r.nickname)).toEqual([fx.people[0].n]);

      // No match says so, rather than leaving an empty table under a header.
      await search.fill(`nobodyatall-${fx.tag}`);
      await expect(body).toContainText("No participants match");

      await page.locator("#rankings-search-clear").click();
      await expect.poll(async () => (await readRows(body)).length).toBe(3);
    } finally { await cleanup(fx); }
  });

  test("copy puts the cell's FULL value on the clipboard, not the truncated text", async ({ page, context }) => {
    // A truncated display must never become a truncated copy: the button carries
    // the value in data-copy rather than reading the rendered cell back out.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const fx = await seedBoard();
    try {
      const body = await openBoard(page, fx.compName);
      const row = body.locator("tr").filter({ hasText: fx.people[0].n });
      const emailCopy = row.locator("td").nth(5).locator(".rk-copy");
      await expect(emailCopy, "email cells carry a copy control").toHaveCount(1);
      await emailCopy.click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(fx.people[0].e);
      // Company is deliberately NOT copyable — you copy a person's details to
      // write to them, not a company label.
      await expect(row.locator("td").nth(4).locator(".rk-copy"), "company has no copy control").toHaveCount(0);
      // And the unset cells offer nothing to copy.
      const blankRow = body.locator("tr").filter({ hasText: fx.people[2].n });
      await expect(blankRow.locator("td").nth(5).locator(".rk-copy")).toHaveCount(0);
    } finally { await cleanup(fx); }
  });

  test("clicking a player opens the Participants pane filtered to them", async ({ page }) => {
    const fx = await seedBoard();
    try {
      const body = await openBoard(page, fx.compName);
      // Narrow first so the click target is unambiguous on a board that other
      // specs' fixtures may also populate.
      await body.locator("tr").filter({ hasText: fx.people[0].n })
        .locator(".rk-player-link").click();

      // The nav must AGREE with the visible pane — the v7.7.37 (C20) defect was
      // a hand-rolled pane swap that left the old nav item highlighted. This
      // board is the event's own (its workspace's Rankings), so the link opens
      // that workspace's Participants section and the event stays open: its tab
      // is the current one, not the sidebar's cross-event People item.
      await expect(page.locator("#admin-participants-tab")).toBeVisible();
      await expect(page.locator('#ws-tabs [data-section="admin-participants-tab"]')).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#participants-tab-btn"), "the sidebar's People item is not current inside the workspace").not.toHaveAttribute("aria-current", "page");
      await expect(page.locator("#ws-title"), "the event stays open").toHaveText(fx.compName);
      await expect(page.locator("#participants-search")).toHaveValue(fx.people[0].n);
      // v8.8.13 — POLL ON THE ROW, NOT ON THE COUNT. `count() === 1` is
      // satisfied by the SINGLE "No participants match the current filters."
      // row, so the poll accepted the empty state and the assertion below then
      // failed against it — a count that cannot tell a match from a miss. It is
      // reachable because the cross-nav fills the search box and dispatches
      // `input` synchronously, while `loadAdminParticipants` is still walking
      // its pages: the filter runs against a model that has not landed, the
      // pane renders the empty state, and it self-heals a moment later. Polling
      // the TEXT waits for the real answer and is strictly stronger.
      const prows = page.locator("#admin-participants-body tr");
      // v8.8.13 DIAGNOSTIC — "no participants match" is equally true of a model
      // that never loaded, one that loaded empty, and a filter that excluded
      // everyone. Print which, or the next reader guesses like I did.
      try {
        await expect(prows.first()).toContainText(fx.people[0].n, { timeout: 15000 });
      } catch (e) {
        // Ask the SERVER the same question the pane asked. This is what
        // separates "the client dropped her" from "the server never sent her",
        // and the first diagnostic could not tell them apart.
        const srv = await page.request.get("/api/admin/participants?limit=5000&page=1");
        const sb = srv.ok() ? await srv.json() : null;
        const srvInfo = sb ? {
          status: srv.status(), total: sb.total, returned: (sb.participants || []).length,
          hasTarget: (sb.participants || []).some(p => p.nickname === fx.people[0].n),
        } : { status: srv.status(), body: (await srv.text()).slice(0, 120) };
        const d = await page.evaluate((nick) => ({
          modelLen: (window.S?.adminParticipantsData || []).length,
          hasTarget: (window.S?.adminParticipantsData || []).some(p => p.nickname === nick),
          searchVal: document.getElementById("participants-search")?.value,
          statusFilter: [...(window.S?.pStatusFilter || [])],
          pPage: window.S?.pPage,
          fetchSeq: window.S?._partFetchSeq,
          focusedComp: window.S?.adminSelectedCompetitionId,
          paneVisible: document.getElementById("admin-participants-tab")?.style.display,
          firstRow: document.querySelector("#admin-participants-body tr")?.textContent?.slice(0, 80),
          countLine: document.querySelector("[data-count-for='participants-search'], #participants-search-count")?.textContent,
        }), fx.people[0].n);
        throw new Error("participants pane never showed " + fx.people[0].n
          + " — client=" + JSON.stringify(d) + " server=" + JSON.stringify(srvInfo) + "\n" + e.message);
      }
      // …and the filter really narrowed to them, rather than the row merely
      // happening to sort first.
      await expect.poll(async () => prows.count()).toBe(1);
    } finally { await cleanup(fx); }
  });

  test("the status chips are reset, so the target is never filtered out from under the navigation", async ({ page }) => {
    // Without this, an admin filtering on "blocked" who clicks an unblocked
    // participant lands on an empty table with nothing saying why — a
    // navigation that promises to show someone and then does not.
    const fx = await seedBoard();
    try {
      await adminLogin(page);
      await clickTab(page, "Participants");
      // "blocked", not "pending": the approval chips render only while there is
      // approval work (the platform's approval switch), so they are not always offered.
      await page.locator('#p-status-filters .filter-btn[data-value="blocked"]').click();
      await expect(page.locator('#p-status-filters .filter-btn[data-value="blocked"]')).toHaveClass(/active/);

      await clickTab(page, "Events");
      await viewComp(page, fx.compName);
      await clickTab(page, "Rankings");
      const body = page.locator("#admin-rankings-body");
      await body.locator("tr").first().waitFor({ state: "attached", timeout: 15000 });
      await body.locator("tr").filter({ hasText: fx.people[0].n }).locator(".rk-player-link").click();

      // The chip group is back to "All" — both the backing Set (no filtering)
      // and the control that reports it (only "All" highlighted).
      await expect(page.locator('#p-status-filters .filter-btn[data-value="all"]')).toHaveClass(/active/);
      await expect(page.locator('#p-status-filters .filter-btn[data-value="blocked"]')).not.toHaveClass(/active/);
      await expect.poll(async () => page.locator("#admin-participants-body tr").count()).toBe(1);
    } finally { await cleanup(fx); }
  });
});
