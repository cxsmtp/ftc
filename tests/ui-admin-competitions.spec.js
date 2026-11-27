// @ts-check
//
// Part of the ui-admin suite, split from a single 4,833-line file in v7.21.35.
//
// Contains: Admin — Tasks · Admin — Participants · v7.8.1 — internal-competition checkbox · v7.15.0 — admin rankings columns + sorting · User-field matrix (v7.15.8) · v7.20.9 (ext-audit F12) — analytics empty states · Start times across a DST transition (v7.21.1 A3)
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
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, PORT_BASE, gradingHashFor } = require("./helpers");
const {
  login, loginViaApi, saLoginRetry, filterComps, adminLogin, participantLogin,
  clickTab, openKebab, openAddToEventsFor, findSeededTaskRow, viewComp, showEveryoneInWorkspace, focusOwnLiveComp, CONFIRM_PROBE_MS, AxeBuilder, AXE_GATED_IMPACTS, openAnalyticsTab, openCompCreateForm, narrowChallengesTable, narrowPeopleTable } = require("./ui-admin-helpers");

// Route every page.goto() + page.request.* to THIS worker's server.
test.use({ baseURL: BASE });


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — TASKS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — Tasks", () => {
  test("tasks table renders with badges", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // The search filter is what makes these lookups pagination-proof, but a
    // filter narrow enough to pin ONE seeded row necessarily excludes the
    // other — so the two badge states are asserted one at a time, each against
    // the seeded challenge that actually carries it. (Asserting both after a
    // single filter is what failed in v7.15.29.)
    for (const [title, badge] of [["Challenge draft1", "draft"], ["Challenge easy1", "published"]]) {
      await findSeededTaskRow(page, title);
      const row = page.locator(`#admin-task-body tr:has-text('${title}')`).first();
      await expect(row,
        "the seeded challenge must be findable regardless of what other specs added to this worker's DB"
      ).toBeVisible({ timeout: 15000 });
      await expect(row.locator(`.badge.${badge}`)).toBeVisible();
    }
  });

  test("search filter works", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, "hard1");
    // hard1 visible + easy1 hidden — both expects auto-retry, so the filter
    // debounce is absorbed without a fixed delay.
    await expect(page.locator("td:has-text('Challenge hard1')").first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#admin-task-body tr:has-text('Challenge easy1')")).toHaveCount(0);
  });

  test("competition badges are clickable", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Scope to the visible Challenges tab — other tabs in the DOM may have their own
    // comp-badges that are display:none due to their parent tab being hidden.
    const badge = page.locator("#admin-tasks-tab .comp-badge").first();
    await expect(badge).toBeVisible({ timeout: 3000 });
    await badge.click();
    await expect(page.locator("text=Viewing").first()).toBeVisible({ timeout: 5000 });
  });

  test("v6.13.12: Cancel on Edit Challenge form rolls back attachments uploaded during the session", async ({ page }) => {
    // Pre-v6.13.12, Cancel left in-edit uploads committed — they
    // were on disk + in task_attachments + visible to participants
    // even though the admin never hit Save. Fix: track uploads made
    // during an edit session and DELETE them from closeTaskForm().
    // This test creates a fresh task, opens the edit form for it,
    // uploads a ZIP via the file picker, clicks Cancel, and asserts
    // via the admin API that attachment_count for that task is still
    // 0 (matches the pre-upload baseline).
    const zlib = require("zlib");
    // Log the page in FIRST, then use page.request for admin API
    // calls — sharing the page's cookie jar avoids the single-session
    // invariant invalidating a parallel apiLogin context mid-test.
    await adminLogin(page);
    const { csrfToken: csrf } = await (await page.request.get("/api/csrf-token")).json();
    const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
    const created = await page.request.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `UI-CancelUpload-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    try {
      await clickTab(page, "Challenges");
      // Narrow the table to just our fresh task via the search box
      // (handles the new task landing on page N under default sort).
      await narrowChallengesTable(page, "UI-CancelUpload-");
      const row = page.locator(`#admin-task-body tr:has-text('UI-CancelUpload-')`).first();
      await row.waitFor({ state: "visible", timeout: 10000 });
      // Open kebab, then click the Edit action inside the portalled
      // kebab menu (#kebab-portal is rendered on document.body with
      // the clicked row's menu template, not inside the row itself).
      await row.locator(".kebab-btn").click();
      await page.locator("#kebab-portal [data-action='task-edit']").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#kebab-portal [data-action='task-edit']").click();
      await page.locator("#admin-task-form").waitFor({ state: "visible", timeout: 5000 });

      // Open the attachment picker + set the file input.
      await page.locator("[data-action='open-attach-picker']").click();
      await page.locator("#tf-attach-file").waitFor({ state: "visible", timeout: 5000 });
      // Build a minimal valid ZIP (same hand-built shape used elsewhere).
      const name = Buffer.from("a"); const body = Buffer.from("x");
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x03,0x04]),
        Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0]),
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x01,0x02]),
        Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
        Buffer.from([0,0,0,0]),
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50,0x4b,0x05,0x06]),
        Buffer.from([0,0,0,0]),
        Buffer.from([1,0,1,0]),
        Buffer.from([cdh.length,0,0,0]),
        Buffer.from([lfh.length,0,0,0]),
        Buffer.from([0,0]),
      ]);
      const zip = Buffer.concat([lfh, cdh, eocd]);
      await page.locator("#tf-attach-file").setInputFiles({
        name: "cancel-upload.zip", mimeType: "application/zip", buffer: zip,
      });
      await page.locator("[data-action='confirm-attach-upload']").click();
      // Wait for the upload toast to fire — that's the signal the
      // xhr.onload promise resolved and the chip list re-rendered.
      await page.locator(".toast:has-text('Attachment uploaded')").first().waitFor({ state: "visible", timeout: 10000 });
      // v6.13.15 flow: the upload went to the staging table, NOT
      // task_attachments. Participants can't see it mid-session; the
      // task's attachment_count on /api/admin/tasks stays 0 until the
      // admin hits Save (which promotes staging rows into
      // task_attachments atomically). Mid-session check: still 0.
      const midState = await page.request.get("/api/admin/tasks");
      const midList = await midState.json();
      const midTask = midList.find(t => t.id === taskId);
      expect(midTask.attachment_count, "mid-session upload is staged, not published → count stays 0").toBe(0);

      // Click Cancel — should trigger closeTaskForm → discard path.
      // The staging row gets DELETEd via _discardPendingStagingAttachments.
      await page.locator("[data-action='close-task-form']").first().click();
      await expect(page.locator("#admin-task-form")).toBeHidden({ timeout: 5000 });
      // After Cancel: count is still 0 (nothing was ever published),
      // and the staging row is gone from the server side.
      await expect.poll(async () => {
        const r = await page.request.get("/api/admin/tasks");
        const list = await r.json();
        const t = list.find(x => x.id === taskId);
        return t ? t.attachment_count : -1;
      }, { timeout: 5000 }).toBe(0);
    } finally {
      await page.request.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  test("v6.13.13: uploading in Edit form on a live-assigned challenge does NOT trigger a live-comp confirm", async ({ page }) => {
    // Regression lock for the v6.13.13 UX cleanup. Pre-fix, uploading
    // an attachment via the Edit form popped a "Add Attachment to
    // Live Challenge" confirmation when the challenge was assigned to
    // a live competition. With v6.13.12's upload-rollback-on-cancel
    // in place, that confirmation became redundant: the upload is
    // only visible to participants after Save, and Save already
    // triggers its own live-competition confirmation — two dialogs
    // for one action. This test confirms the upload flow completes
    // without ANY intervening modal (i.e. the toast fires without
    // requiring dismissal of a confirm) on a live-assigned task.
    const zlib = require("zlib");
    await adminLogin(page);
    const { csrfToken: csrf } = await (await page.request.get("/api/csrf-token")).json();
    const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Fresh task + assign to the seeded "Test Live" competition so
    // the live-comp guard has something to trip on. Without the
    // assignment, _confirmLiveChallengeMutation would fall through
    // to "no live comps — return true" and never show the modal,
    // which wouldn't exercise the regression at all.
    const created = await page.request.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `UI-NoLivePopup-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    try {
      // v8.1.0 — OWNS ITS COMPETITION. This borrowed the seeded "Test Live", which
      // other tests on the same worker end (and which can auto-end on its own) —
      // and an assign to an ended competition is REFUSED, so the precondition
      // failed intermittently with a bare `expect(assign.ok())` that named
      // nothing. The test needs *a* live competition, not *that* one.
      const liveR = await page.request.post("/api/admin/competitions", {
        headers: saH,
        data: {
          name: `UI-NoLivePopup-Comp-${Date.now()}`,
          start_time: new Date(Date.now() - 3600e3).toISOString(),
          duration_minutes: 600, timezone: "UTC",
        },
      });
      expect(liveR.ok(), `create live comp: ${liveR.status()} ${await liveR.text()}`).toBeTruthy();
      const live = (await liveR.json()).competition;
      const assign = await page.request.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saH, data: { competitionIds: [live.id] },
      });
      expect(assign.ok(), `assign to the live comp: ${assign.status()} ${await assign.text()}`).toBeTruthy();

      await clickTab(page, "Challenges");
      await narrowChallengesTable(page, "UI-NoLivePopup-");
      const row = page.locator(`#admin-task-body tr:has-text('UI-NoLivePopup-')`).first();
      await row.waitFor({ state: "visible", timeout: 10000 });
      await row.locator(".kebab-btn").click();
      await page.locator("#kebab-portal [data-action='task-edit']").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#kebab-portal [data-action='task-edit']").click();
      await page.locator("#admin-task-form").waitFor({ state: "visible", timeout: 5000 });

      // Open picker + set file.
      await page.locator("[data-action='open-attach-picker']").click();
      await page.locator("#tf-attach-file").waitFor({ state: "visible", timeout: 5000 });
      const name = Buffer.from("a"); const body = Buffer.from("x");
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x03,0x04]),
        Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0]),
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x01,0x02]),
        Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
        Buffer.from([0,0,0,0]),
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50,0x4b,0x05,0x06]),
        Buffer.from([0,0,0,0]),
        Buffer.from([1,0,1,0]),
        Buffer.from([cdh.length,0,0,0]),
        Buffer.from([lfh.length,0,0,0]),
        Buffer.from([0,0]),
      ]);
      const zip = Buffer.concat([lfh, cdh, eocd]);
      await page.locator("#tf-attach-file").setInputFiles({
        name: "live-upload.zip", mimeType: "application/zip", buffer: zip,
      });

      // Click confirm-upload, then immediately assert the
      // live-challenge confirm modal did NOT render. If the popup
      // still existed it'd block the flow and the toast wouldn't
      // fire. We assert BOTH: no modal title + toast present.
      await page.locator("[data-action='confirm-attach-upload']").click();
      await page.locator(".toast:has-text('Attachment uploaded')").first().waitFor({ state: "visible", timeout: 10000 });
      // No "Add Attachment to Live Challenge" modal anywhere visible.
      await expect(page.locator("#modal-overlay:has-text('Add Attachment to Live Challenge')")).toHaveCount(0);

      // Clean up the session via Cancel so the rollback fires and the
      // next test's state isn't polluted with a live-comp attachment.
      await page.locator("[data-action='close-task-form']").first().click();
      await expect(page.locator("#admin-task-form")).toBeHidden({ timeout: 5000 });
    } finally {
      await page.request.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
  });

  test("v6.13.10: Attachments column is present and sortable", async ({ page }) => {
    // Column header visible, clickable, and sorting flips the `▲` / `▼`
    // glyph on the paired icon span. Content of the cell itself is
    // covered by the functional-core API test
    // (`/api/admin/tasks` returns `attachment_count`) — the UI test just
    // verifies the plumbing (header → sort action wired → icon updates).
    // v8.17.0 — Attachments is past the library's default columns (Columns menu).
    const { showAllTableColumns, CHALLENGE_ALL_COLUMNS } = require("./ui-admin-helpers");
    await showAllTableColumns(page, "challenges", CHALLENGE_ALL_COLUMNS);
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const header = page.locator('#admin-tasks-tab th[data-col="attachments"]');
    await expect(header, "Attachments header exists in the Challenges tab").toBeVisible({ timeout: 5000 });
    // Sanity: paired sort-icon span is present.
    await expect(page.locator("#tsort-attachments-icon")).toHaveCount(1);
    // Click to sort ascending; glyph should become "▲".
    await header.click();
    await expect(page.locator("#tsort-attachments-icon")).toHaveText(/▲/, { timeout: 2000 });
    // Second click flips to descending.
    await header.click();
    await expect(page.locator("#tsort-attachments-icon")).toHaveText(/▼/, { timeout: 2000 });
  });

  test("dimmed rows have visible action buttons when competition selected", async ({ page }) => {
    // v8.1.0 — OWNS ITS COMPETITION. This borrowed the seeded "Test Live", which
    // is created live with a finite duration — so on a long file run it had ENDED
    // by the time this test reached it, and the readiness signal below
    // (`#add-tasks-to-comp-btn`) is CORRECTLY hidden for an ended competition:
    // `directAdd = comp && computeCompStatus(comp) !== "ended"` (v7.12.2), because
    // assignment is frozen once a session has ended. Three earlier hardenings
    // guessed at timing; the helper's diagnostic named it as
    // `matchStatuses:["ended"]` on the first recurrence. Fixture checklist item 2.
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const ownName = `DimmedRows ${Date.now()}`;
    const mk = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: ownName, start_time: new Date(Date.now() - 3600e3).toISOString(),
              duration_minutes: 600, timezone: "UTC" },
    });
    expect(mk.ok(), `create own competition: ${await mk.text()}`).toBeTruthy();
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await viewComp(page, ownName);
    await clickTab(page, "Challenges");
    // Scoping fires loadAdminTasks() which re-renders the body async. Wait for
    // the scope-only "+ Add Challenges" button (rendered by the scoped task
    // pane) before counting View buttons — guarantees the re-render finished.
    await page.locator("#add-tasks-to-comp-btn").waitFor({ state: "visible", timeout: 5000 });
    const viewBtns = page.locator("#admin-task-body .task-actions button:has-text('View')");
    await expect(viewBtns.first()).toBeVisible({ timeout: 5000 });
    expect(await viewBtns.count()).toBeGreaterThan(0);
  });

  // Regression: the picker UI used to increment its local `assigned`
  // counter on any 200 OK, even when the server reported `assigned: 0`
  // (INSERT OR IGNORE no-op because another admin already added the
  // challenge). Intercept the POST, force the server to report 0, and
  // assert the toast tells the truth instead of lying "1 assigned".
  test("+ Add Challenges picker uses server's assigned count, not 200-OK count", async ({ page }) => {
    await adminLogin(page);
    // Intercept the assignment POST and force assigned: 0 for this test.
    await page.route("**/api/admin/tasks/*/competitions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, assigned: 0 }),
      });
    });
    // v8.1.0 — owns its competition. `#add-tasks-to-comp-btn` renders only for a
    // NON-ended focus, so borrowing the seeded "Test Live" made this test hostage
    // to that fixture's lifecycle. See focusOwnLiveComp.
    await focusOwnLiveComp(page, "AddPicker");
    await clickTab(page, "Challenges");
    const addBtn = page.locator("#add-tasks-to-comp-btn");
    await addBtn.waitFor({ state: "visible", timeout: 5000 });
    await addBtn.click();
    const picker = page.locator("#task-picker-overlay");
    await expect(picker).toBeVisible({ timeout: 5000 });
    // v7.20.10 — the dialog is a SET operation now: it lists the ALREADY-
    // assigned challenges too (ticked), the button is "Save Changes"
    // (#task-picker-save) and it always confirms before applying. So the row
    // this test posts must be one that is currently UNticked — ticking an
    // already-ticked row would be a removal, not an addition.
    const firstUnchecked = picker.locator("#task-picker-list input[type='checkbox']:not(:checked)").first();
    // v6.8.5: the seeded test state always has at least one challenge
    // available for assignment. If there isn't, the fixture is broken —
    // assert rather than silently skip.
    await expect(firstUnchecked).toHaveCount(1, { timeout: 5000 });
    await firstUnchecked.check();
    await page.locator("#task-picker-save").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: CONFIRM_PROBE_MS });
    await page.locator("#modal-confirm-btn").click();
    // The toast must report the TRUE (server) count — nothing was added — AND
    // flag the skipped duplicate so the operator sees what happened. The lie
    // this guards against is a toast that claims an addition on a 200 OK the
    // server answered with `assigned: 0`.
    const toast = page.locator(".toast, #toast, [data-toast]").first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    // Read ONCE. A second polling assertion can race the toast's own dismissal
    // and report "element not found" instead of the thing it was checking.
    const toastText = await toast.textContent();
    expect(toastText, "the skipped duplicate is reported").toMatch(/already\s+assigned/i);
    expect(toastText, "no addition is claimed").not.toMatch(/\badded\b/i);
  });

  test("+ Add Tasks button prominent for non-ended competition", async ({ page }) => {
    // v8.1.0 — owns its competition: the assertion is precisely that the button
    // renders for a NON-ENDED focus, so borrowing a shared fixture makes the test
    // hostage to that fixture's lifecycle.
    await adminLogin(page);
    await focusOwnLiveComp(page, "AddTasksProminent");
    await clickTab(page, "Challenges");
    const addBtn = page.locator("#add-tasks-to-comp-btn");
    await expect(addBtn).toBeVisible({ timeout: 3000 });
    const cls = await addBtn.getAttribute("class");
    expect(cls).not.toContain("secondary");
  });

  test("v6.10.12: scoped view floats assigned challenges to the top of the list", async ({ page }) => {
    // When a competition is focused, challenges assigned to it
    // must appear BEFORE unassigned ones — mirroring the members-
    // first grouping in the Participants list. The column sort is
    // used only as a tiebreaker within each group.
    //
    // Test fixture: "Test Live" has easy1 + med1 + hard1 assigned;
    // other seeded challenges (easy2, draft1) are not in "Test Live".
    // After focusing, every assigned row must come before the first
    // unassigned row in the DOM order.
    await adminLogin(page);
    await viewComp(page, "Test Live");
    await clickTab(page, "Challenges");
    // v8.1.0 — wait for the scoped re-render on a signal that does NOT depend on
    // lifecycle. This used to wait for `#add-tasks-to-comp-btn`, which renders
    // only for a non-ended focus (`directAdd`, v7.12.2) — so if the shared
    // fixture had ended, a test about ROW ORDER failed on an unrelated button.
    // The fixture itself must stay: the assertion needs the seeded assignments.
    await expect.poll(async () => page.evaluate(() =>
      (window.S && window.S.adminSelectedCompetitionId ? 1 : 0) &&
      document.querySelectorAll("#admin-task-body tr").length),
      { timeout: 15000, message: "the scoped challenges table never rendered" }).toBeGreaterThan(0);
    // Force the largest page size so every task is on one page —
    // otherwise assigned-at-top could be hidden by pagination.
    await page.locator("select[data-change-action='tasks-page-size']").selectOption("200");
    // Collect every row + whether it carries the focused comp badge
    // (outlined via the v6.10.0 `outline:2px solid var(--accent)`).
    // A task row is "assigned" iff a comp-badge inside it has the
    // scoped comp's name and the accent outline.
    const rows = page.locator("#admin-task-body tr");
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
    const assignedFlags = await rows.evaluateAll(trs => trs.map(tr => {
      const badges = tr.querySelectorAll(".comp-badge");
      // The scoped badge is the one with outline:2px solid in its
      // inline style. That's the visual "this is the focused comp"
      // marker from renderAdminTasks().
      for (const b of badges) if ((b.getAttribute("style") || "").includes("outline:2px")) return true;
      return false;
    }));
    // Every `true` must appear before every `false` (i.e. no
    // unassigned row in the middle of the assigned block).
    const firstUnassigned = assignedFlags.indexOf(false);
    if (firstUnassigned === -1) return; // all assigned — trivially sorted
    const anyAssignedAfter = assignedFlags.slice(firstUnassigned).some(v => v === true);
    expect(
      anyAssignedAfter,
      `Assigned challenges must come before unassigned when the comp is focused. Flags (true=assigned): [${assignedFlags.join(",")}]`,
    ).toBe(false);
  });

  test("assign dialog — filtered, save disabled, shows Assigned", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Stage B — the bank's one door into events: tick it, then Add to events.
    const row = await findSeededTaskRow(page, "Challenge easy1");
    await openAddToEventsFor(page, row.first());
    const overlay = page.locator("#assign-task-overlay");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(overlay.locator("text=Test Ended")).not.toBeVisible();
    await expect(overlay.locator("#assign-task-save-btn")).toBeDisabled();
    await expect(overlay.locator("text=Assigned").first()).toBeVisible();
  });

  test("assign dialog — toggling checkbox enables save", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, "Challenge easy1");
    await openAddToEventsFor(page, row.first());
    const saveBtn = page.locator("#assign-task-save-btn");
    await expect(saveBtn).toBeDisabled({ timeout: 5000 });
    await page.locator("#assign-task-comp-list input[type='checkbox']").first().click();
    await expect(saveBtn).toBeEnabled();
  });

  test("View action shows attachment chip in the participant-preview overlay", async ({ page }) => {
    // End-to-end lock for the bug the user reported: "View action doesn't
    // show attachments". Seeds a task + attachment via API, then exercises
    // the admin UI path the user was on — table row → View button → preview
    // overlay. Asserts the Downloads section renders with the expected chip.
    const { request: r } = require("./isolated-test");
    const { BASE: B, getSuperadminPass: gp } = require("./helpers");
    // Build a minimal valid zip inline so no filesystem coupling is needed.
    const zlib = require("zlib");
    const crc32 = (buf) => (typeof zlib.crc32 === "function") ? zlib.crc32(buf) : (() => {
      const t = []; for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
      let c = 0xFFFFFFFF; for (const b of buf) c = (c >>> 8) ^ t[(c ^ b) & 0xFF]; return (c ^ 0xFFFFFFFF) >>> 0;
    })();
    const nameBuf = Buffer.from("readme.txt"); const dataBuf = Buffer.from("hi"); const crc = crc32(dataBuf);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4);
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18); lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
    const cdBuf = Buffer.concat([cd, nameBuf]);
    const content = Buffer.concat([lh, nameBuf, dataBuf]);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(content.length, 16);
    const zipBuf = Buffer.concat([content, cdBuf, eocd]);

    const api = await r.newContext({ baseURL: B });
    await saLoginRetry(api); // audit v7.7.35 (T2)
    let csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const taskTitle = `UIView Probe ${Date.now()}`;
    const task = await (await api.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { title: taskTitle, difficulty: "easy", answer_type: "text", correct_answer: "ok", status: "published" },
    })).json();
    await api.post(`/api/admin/tasks/${task.id}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "pack.zip", mimeType: "application/zip", buffer: zipBuf },
        display_name: "Preview Pack",
      },
    });
    await api.dispose();

    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Search narrows the table to the unique title so .first() is our task.
    await narrowChallengesTable(page, taskTitle);
    const row = page.locator(`#admin-task-body tr:has-text('${taskTitle}')`).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    // Target the View button by data-action — more robust than text matching
    // when the button carries an inline SVG icon before the label.
    await row.locator("button[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(overlay.locator(".task-preview-attachments")).toBeVisible({ timeout: 5000 });
    await expect(overlay.locator(".task-preview-attach-name")).toContainText("Preview Pack");
    // Link resolves against the admin-scoped download so the admin doesn't
    // need a competition scope for the preview.
    const href = await overlay.locator(".task-preview-attachment-link").first().getAttribute("href");
    expect(href).toMatch(/\/api\/admin\/tasks\/[^/]+\/attachments\/[^/]+$/);
  });

  // ── Task-picker filter (v6.19.0) ──────────────────────────────────────────
  test.describe("Task-picker filter", () => {
    // Helper: open the task picker for the Test Upcoming competition (which has
    // med1 and hard1 as assignable challenges — published, not yet in upcoming).
    async function openPicker(page) {
      await adminLogin(page);
      await viewComp(page, "Test Upcoming");
      await clickTab(page, "Challenges");
      const addBtn = page.locator("#add-tasks-to-comp-btn");
      await addBtn.waitFor({ state: "visible", timeout: 5000 });
      await addBtn.click();
      const picker = page.locator("#task-picker-overlay");
      await expect(picker).toBeVisible({ timeout: 5000 });
      return picker;
    }

    test("picker shows search input and difficulty filter buttons", async ({ page }) => {
      const picker = await openPicker(page);
      await expect(picker.locator("#task-picker-search")).toBeVisible();
      await expect(picker.locator("#task-picker-diff-filters .filter-btn:has-text('All')")).toBeVisible();
      await expect(picker.locator("#task-picker-diff-filters .filter-btn:has-text('Easy')")).toBeVisible();
      await expect(picker.locator("#task-picker-diff-filters .filter-btn:has-text('Medium')")).toBeVisible();
      await expect(picker.locator("#task-picker-diff-filters .filter-btn:has-text('Hard')")).toBeVisible();
    });

    test("search by title filters the visible rows", async ({ page }) => {
      const picker = await openPicker(page);
      // Baseline: med1 and hard1 must be present (other tests may add more tasks).
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toBeVisible({ timeout: 5000 });
      await expect(picker.locator("#task-picker-list .picker-row:has-text('hard1')")).toBeVisible();
      // Type to narrow to med1 only.
      await picker.locator("#task-picker-search").fill("med1");
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toHaveCount(1, { timeout: 3000 });
      await expect(picker.locator("#task-picker-list .picker-row:has-text('hard1')")).toHaveCount(0);
    });

    test("difficulty filter shows only matching rows", async ({ page }) => {
      const picker = await openPicker(page);
      await expect(picker.locator("#task-picker-list .picker-row:has-text('hard1')")).toBeVisible({ timeout: 5000 });
      // Click Hard — hard1 visible, med1 gone.
      await picker.locator("#task-picker-diff-filters .filter-btn:has-text('Hard')").click();
      await expect(picker.locator("#task-picker-list .picker-row:has-text('hard1')")).toHaveCount(1, { timeout: 3000 });
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toHaveCount(0);
      // The Hard button must be active.
      await expect(picker.locator("#task-picker-diff-filters .filter-btn:has-text('Hard')")).toHaveClass(/active/);
    });

    test("checked rows survive filter change (selection persists across re-renders)", async ({ page }) => {
      const picker = await openPicker(page);
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toBeVisible({ timeout: 5000 });
      // Explicitly check med1's checkbox.
      const med1Check = picker.locator("#task-picker-list .picker-row:has-text('med1') input[type='checkbox']");
      if (!(await med1Check.isChecked())) await med1Check.click();
      // Switch to Hard filter — med1 disappears.
      await picker.locator("#task-picker-diff-filters .filter-btn:has-text('Hard')").click();
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toHaveCount(0, { timeout: 3000 });
      // Switch back to All — med1 must still be checked.
      await picker.locator("#task-picker-diff-filters .filter-btn:has-text('All')").click();
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toBeVisible({ timeout: 3000 });
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1') input[type='checkbox']")).toBeChecked();
    });

    // v7.20.10 — the count now reports the DIFF ("N selected — A to add, R to
    // remove") rather than "N visible · M total selected", because Save can now
    // REMOVE as well as add and a bare selection size no longer describes what
    // pressing it will do. The invariant this test has always guarded is
    // unchanged and is what the leading number still proves: the count is the
    // TOTAL selection, including picks the current filter has hidden.
    test("count badge reflects total selected (not just visible)", async ({ page }) => {
      const picker = await openPicker(page);
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toBeVisible({ timeout: 5000 });
      const countEl = picker.locator("#task-picker-count");
      // Derive the competition's own challenge count from the untouched dialog
      // rather than hard-coding a seed number.
      const baseline = parseInt((await countEl.textContent()).match(/^(\d+) in this event/)[1], 10);
      // Reset to a known baseline: deselect everything, then check only med1.
      await picker.locator("button[data-action='task-picker-unselect-all']").click();
      const med1Check = picker.locator("#task-picker-list .picker-row:has-text('med1') input[type='checkbox']");
      await med1Check.check();
      await expect(countEl).toHaveText(`1 selected — 1 to add, ${baseline} to remove`, { timeout: 3000 });
      // Switch to Hard filter — med1 hidden but still in the total-selected count.
      await picker.locator("#task-picker-diff-filters .filter-btn:has-text('Hard')").click();
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toHaveCount(0, { timeout: 3000 });
      // Zero rows on screen are ticked, so a visible-scoped count would read 0.
      await expect(countEl).toHaveText(/^1 selected — /);
    });

    test("search + difficulty filters combine (AND semantics)", async ({ page }) => {
      const picker = await openPicker(page);
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toBeVisible({ timeout: 5000 });
      // Medium filter active, then search for "hard1" → no rows match.
      await picker.locator("#task-picker-diff-filters .filter-btn:has-text('Medium')").click();
      await picker.locator("#task-picker-search").fill("hard1");
      await expect(picker.locator("#task-picker-list .picker-row")).toHaveCount(0, { timeout: 3000 });
      // Clear search — medium row comes back.
      await picker.locator("#task-picker-search").fill("");
      await expect(picker.locator("#task-picker-list .picker-row:has-text('med1')")).toBeVisible({ timeout: 3000 });
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — PARTICIPANTS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — Participants", () => {
  test("participants list renders", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await expect(page.locator("td:has-text('Alice')").first()).toBeVisible({ timeout: 5000 });
  });

  test("edit-profile dialog has Work Title + optional Salutation + Phone, grouped uniformly", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await page.locator("#admin-participants-body .kebab-btn").first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#admin-participants-body .kebab-btn").first().click();
    await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
    await page.locator("#kebab-portal button:has-text('Edit Profile')").first().click();
    await page.locator("#admin-profile-overlay").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("label[for='adp-title']")).toContainText(/work title/i);
    const pt = page.locator("#adp-personal-title");
    await expect(pt).toBeVisible();
    expect(await pt.evaluate(el => el.tagName)).toBe("SELECT");
    await expect(page.locator("label[for='adp-personal-title']")).toContainText(/salutation/i);
    await expect(page.locator("label[for='adp-personal-title']")).toContainText(/optional/i);
    await expect(page.locator("#adp-phone")).toBeVisible();
    await expect(page.locator("label[for='adp-phone']")).toContainText(/optional/i);
    // Uniform grouping: Emails → Identity → Location → Professional.
    const order = await page.evaluate(() => {
      const t = id => { const e = document.getElementById(id); return e ? e.getBoundingClientRect().top : null; };
      return { email: t("adp-email"), salutation: t("adp-personal-title"), country: t("adp-country"), company: t("adp-company") };
    });
    expect(order.email).toBeLessThan(order.salutation);
    expect(order.salutation).toBeLessThan(order.country);
    expect(order.country).toBeLessThan(order.company);
    // Clean form: Cancel closes immediately (modal-dismissal contract).
    await page.locator("#admin-profile-overlay [data-action='overlay-close']").click();
    await expect(page.locator("#admin-profile-overlay")).toHaveCount(0);
  });

  test("competition badges clickable", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    const badge = page.locator(".comp-badge").first();
    if (await badge.isVisible()) {
      await badge.click();
      await expect(page.locator("text=Viewing").first()).toBeVisible({ timeout: 5000 });
    }
  });

  test("an event's Participants lists its own people, each with its actions", async ({ page }) => {
    await adminLogin(page);
    await viewComp(page, "Test Live");
    await clickTab(page, "Participants");
    await expect(page.locator("td:has-text('Alice')").first()).toBeVisible({ timeout: 5000 });
    const btns = page.locator("#admin-participants-body .btn.sm");
    await expect(btns.first()).toBeVisible({ timeout: 5000 });
    expect(await btns.count()).toBeGreaterThan(0);
  });

  test("participants table search matches secondary_email (v6.2.4)", async ({ page }) => {
    // Regression for v6.2.4: adminParticipantsData filter only checked
    // primary email; admins searching by the secondary address (which
    // users can actually log in + reset password with) saw zero hits.
    const ts = Date.now();
    const secondary = `alice-sec-${ts}@acme.com`;

    // Set Alice's secondary_email via admin API.
    const { loginViaApi, csrfOf } = await (async () => {
      await saLoginRetry(page.request); // audit v7.7.35 (T2)
      const csrf2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const parts = (await (await page.request.get("/api/admin/participants?limit=200")).json()).participants;
      const alice = parts.find(p => p.email === "alice@acme.com");
      const r = await page.request.put(`/api/admin/participants/${alice.id}`, {
        headers: { "x-csrf-token": csrf2, "content-type": "application/json" },
        data: { secondaryEmail: secondary },
      });
      expect(r.ok()).toBe(true);
      return { loginViaApi: true, csrfOf: csrf2 };
    })();

    try {
      await adminLogin(page);
      await clickTab(page, "Participants");
      await expect(page.locator("#admin-participants-body td:has-text('Alice')").first()).toBeVisible({ timeout: 5000 });

      // Type a fragment of the secondary email — Alice's row must survive
      // the filter, and rows without the fragment must drop out.
      await narrowPeopleTable(page, `alice-sec-${ts}`);
      // Alice row still visible
      await expect(page.locator("#admin-participants-body td:has-text('Alice')").first()).toBeVisible({ timeout: 3000 });
      // Bob / Carol must disappear — they don't have the secondary email.
      await expect(page.locator("#admin-participants-body tr:has-text('Bob')")).toHaveCount(0);
      await expect(page.locator("#admin-participants-body tr:has-text('Carol')")).toHaveCount(0);
    } finally {
      // Cleanup via API: clear Alice's secondary_email.
      const csrf3 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const parts = (await (await page.request.get("/api/admin/participants?limit=200")).json()).participants;
      const alice = parts.find(p => p.email === "alice@acme.com");
      if (alice) {
        await page.request.put(`/api/admin/participants/${alice.id}`, {
          headers: { "x-csrf-token": csrf3, "content-type": "application/json" },
          data: { secondaryEmail: "" },
        });
      }
    }
  });

  test("invite/uninvite hidden for ended competition", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await expect(page.locator(".status-badge.live").first()).toBeVisible({ timeout: 10000 });
    await page.locator("#comp-status-filters button[data-status='all']").click();
    // Wait for the "Test Ended" row to appear before trying to click it.
    await filterComps(page, "Test Ended");
    await expect(page.locator("#admin-comp-body tr:has-text('Test Ended')")).toBeVisible({ timeout: 5000 });
    await viewComp(page, "Test Ended");
    await clickTab(page, "Participants");
    // The workspace lists its members; the Invite rows are the NON-members, so
    // list everyone (members first), as the old focus did.
    await showEveryoneInWorkspace(page);
    // Wait for the scoped re-render to finish (a user row must be visible)
    // before asserting negative counts — otherwise an empty body races into
    // the assertion as a false-positive zero.
    await expect(page.locator("#admin-participants-body td:has-text('Alice')").first()).toBeVisible({ timeout: 5000 });
    expect(await page.locator("#admin-participants-body button:has-text('Invite to')").count()).toBe(0);
    expect(await page.locator("#admin-participants-body button:has-text('Remove from')").count()).toBe(0);
  });

  // v6.20.5 — the competition-badge column shows only live/upcoming comps;
  // ended competitions are hidden so the list stays focused on what's actionable.
  test("competition badges hide ended competitions, keep live/upcoming", async ({ page }) => {
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const s = Date.now().toString(36);
    const email = `badge_${s}@acme.com`, nick = `badge_${s}`;
    const endedName = `EndedBadge_${s}`;
    let userId, endedCompId;
    try {
      // Throwaway approved participant.
      await registerPost(page.request, "/api/register", { headers: H, data: {
        firstName: "Badge", lastName: "Test", nickname: nick, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
      }});
      const list = (await (await page.request.get("/api/admin/participants?limit=2000")).json()).participants;
      userId = list.find(p => p.email === email).id;
      await page.request.post(`/api/admin/participants/${userId}/verify`, { headers: H });
      await page.request.post(`/api/admin/participants/${userId}/approve`, { headers: H });
      // A live comp we'll end + a still-live seed comp.
      endedCompId = (await (await page.request.post("/api/admin/competitions", { headers: H, data: {
        name: endedName, start_time: new Date(Date.now() - 30 * 60_000).toISOString(), duration_minutes: 60,
      }})).json()).competition.id;
      const comps = await (await page.request.get("/api/admin/competitions")).json();
      const stillLive = comps.find(c => c.name === "Test Live");
      await page.request.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [userId], competitionIds: [endedCompId, stillLive.id] } });
      await page.request.post(`/api/admin/competitions/${endedCompId}/end-now`, { headers: H, data: {} });
      // Unscoped participants view, search to isolate the user's row.
      await clickTab(page, "Participants");
      await narrowPeopleTable(page, nick);
      const row = page.locator("#admin-participants-body tr", { hasText: email }).first();
      await expect(row).toBeVisible({ timeout: 10000 });
      // The live competition renders a badge; the ended one is filtered out.
      // Auto-retrying locators avoid snapshotting the row mid re-render.
      await expect(row.locator(".comp-badge", { hasText: "Test Live" })).toBeVisible();
      await expect(row.locator(".comp-badge", { hasText: endedName })).toHaveCount(0);
    } finally {
      if (endedCompId) await page.request.delete(`/api/admin/competitions/${endedCompId}`, { headers: H }).catch(() => {});
      if (userId) await page.request.delete(`/api/admin/participants/${userId}`, { headers: H }).catch(() => {});
    }
  });
});


// v7.8.1 — the "Mark as internal (dry run / testing)" control regressed out of
// the competition create/edit form (only the generic "+ tag" adder remained, which
// is undiscoverable). Lock BOTH the control's PRESENCE in the create form AND its
// wiring: ticking it on an edit applies the permanent `internal` competition tag,
// unticking removes it (create seeds it via body.tags). Guards against the setting
// silently disappearing again.
test.describe("v7.8.1 — internal-competition checkbox", () => {
  test("create form exposes the #comp-internal checkbox (unchecked by default)", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page);
    const box = page.locator("#comp-internal");
    await expect(box, "the 'Mark as internal' checkbox must exist in the competition form").toHaveCount(1);
    await expect(box).not.toBeChecked();
    // Sibling reveal-answers box confirms we're looking at the real comp form.
    await expect(page.locator("#comp-reveal-answers")).toHaveCount(1);
    await page.keyboard.press("Escape"); // clean form → closes with no discard prompt
    await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 5000 });
  });

  test("ticking #comp-internal on edit applies the internal tag; unticking removes it", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, "Test Live");
    const liveRow = page.locator("#admin-comp-body tr:has-text('Test Live')");
    await expect(liveRow).toBeVisible({ timeout: 5000 });
    const tagsOf = async (name) => {
      const list = await (await page.request.get("/api/admin/competitions")).json();
      return (list.find(c => c.name === name)?.tags) || [];
    };
    const openEdit = async () => {
      await liveRow.locator(".kebab-btn").click();
      await page.locator("#kebab-portal").waitFor({ state: "visible", timeout: 3000 });
      await page.locator("#kebab-portal button:has-text('Edit')").first().click();
      await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    };
    const saveThroughConfirm = async () => {
      await page.locator("[data-action='comp-save']").first().click();
      // Editing a LIVE comp surfaces the "changes take effect immediately" confirm.
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
      await page.locator("#modal-confirm-btn").click();
      await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 5000 });
    };

    // Tick internal → Save → the edit-sync path POSTs the tag.
    await openEdit();
    await expect(page.locator("#comp-internal")).toHaveCount(1);
    await expect(page.locator("#comp-internal"), "seed comp starts non-internal").not.toBeChecked();
    await page.locator("#comp-internal").check();
    await saveThroughConfirm();
    await expect.poll(() => tagsOf("Test Live"), { timeout: 5000 }).toContain("test/dry run");

    // Reopen → box reflects the stored tag → untick → Save → tag removed (restore seed).
    await openEdit();
    await expect(page.locator("#comp-internal"), "internal box reflects the stored tag on reopen").toBeChecked();
    await page.locator("#comp-internal").uncheck();
    await saveThroughConfirm();
    await expect.poll(() => tagsOf("Test Live"), { timeout: 5000 }).not.toContain("test/dry run");
  });

  // v7.13.0 — the "Don't create CxOne accounts" opt-out checkbox (superadmin-only CxOne
  // section) disables the per-comp CxOne override controls when ticked, and persists.
  test("v7.13.0 — CxOne opt-out checkbox disables the override controls + persists", async ({ page }) => {
    await adminLogin(page); // superadmin — the CxOne section is superadmin-only
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const name = `CxOptOut ${Date.now()}`;
    const compId = (await (await page.request.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { name, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    // v8.1.0 — FILTER FIRST. The competitions table paginates at 30 rows and this
    // test sits ~900 lines into a file that creates a competition per fixture, so
    // by the time it runs the row it just made is off page 1 and the lookup fails
    // with "element(s) not found" (the v7.15.29 class). The v7.17.2 scanner does
    // not catch it: it matches only the `{hasText}` OPTION spelling, and v7.21.17
    // deliberately did not widen it because that yields ~116 hits on working code.
    await filterComps(page, name);
    const row = page.locator(`#admin-comp-body tr:has-text(${JSON.stringify(name)})`);
    await expect(row).toBeVisible({ timeout: 8000 });
    const openEdit = async () => {
      // The HARDENED opener (v7.21.25): the kebab is a toggle, so a single click
      // can land on a menu that never opens, and an empty portal is not "open".
      await openKebab(page, row);
      await page.locator("#kebab-portal button:has-text('Edit')").first().click();
      await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    };
    const save = async () => {
      await page.locator("[data-action='comp-save']").first().click();
      const confirmBtn = page.locator("#modal-overlay.open #modal-confirm-btn");
      // v8.3.26 — CONFIRM_PROBE_MS WAS INERT HERE, at the exact site it was
      // introduced to fix. `isVisible()` ignores its `timeout` option (this
      // repo's own helpers say so twice), so `CI ? 8000 : 1500` changed nothing
      // and the probe stayed the point-in-time sample the comment identifies as
      // the bug — the modal is raised by JS after the click, so a miss skips the
      // confirm and the failure surfaces 6 s later at the form-never-closes wait,
      // naming the wrong thing. Settle into either state first, then decide.
      await Promise.race([
        confirmBtn.waitFor({ state: "visible", timeout: CONFIRM_PROBE_MS }),
        page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: CONFIRM_PROBE_MS }),
      ]).catch(() => {});
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
      await page.locator("#comp-form-overlay").waitFor({ state: "hidden", timeout: 6000 });
    };

    await openEdit();
    // Checkbox present + OFF by default; the override controls start enabled.
    await expect(page.locator("#comp-cxone-disabled")).toHaveCount(1);
    await expect(page.locator("#comp-cxone-disabled")).not.toBeChecked();
    await expect(page.locator("#comp-cxone-key")).toBeEnabled();
    await expect(page.locator("#comp-cxone-group")).toBeEnabled();
    // Tick it → the override controls disable live.
    await page.locator("#comp-cxone-disabled").check();
    await expect(page.locator("#comp-cxone-key")).toBeDisabled();
    await expect(page.locator("#comp-cxone-group")).toBeDisabled();
    await save();
    const stored = async () => ((await (await page.request.get("/api/admin/competitions")).json()).find(c => c.id === compId)?.cxone_disabled);
    await expect.poll(stored, { timeout: 5000 }).toBe(1);
    // Reopen → the box reflects the stored state + controls are disabled from the start.
    await openEdit();
    await expect(page.locator("#comp-cxone-disabled")).toBeChecked();
    await expect(page.locator("#comp-cxone-key")).toBeDisabled();
  });

  // v7.13.1 — a REGULAR admin can opt a competition out of CxOne accounts. The
  // checkbox renders for every admin; only the override CREDENTIAL fields are
  // superadmin-only.
  test("v7.13.2 — a regular admin sees + can use the full per-competition CxOne section (opt-out + credential override)", async ({ page }) => {
    // Mint a regular admin (same flow as the functional-core CxOne test).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `cxra-ui-${Date.now()}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: { firstName: "R", lastName: "A", nickname: `cxraui${Date.now()}`, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/role`, { headers: saH, data: { role: "admin" } });

    // The BROWSER logs in as the regular admin.
    await loginViaApi(page, email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const name = `CxRA ${Date.now()}`;
    const compId = (await (await page.request.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { name, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    // v7.21.25 — FILTER FIRST. The competitions table paginates at 30 rows and
    // every earlier test in this file adds one, so an unfiltered lookup is the
    // documented paginated-table class (CLAUDE.md
    // *Test flakiness — root-cause conventions*). Note the v7.17.2 scanner does
    // not catch this spelling — it matches locator("… tr", {hasText}), not the
    // :has-text() pseudo-class (recorded in CLAUDE.md
    // *Stated gaps — what these do NOT cover*).
    await filterComps(page, name);
    const row = page.locator(`#admin-comp-body tr:has-text(${JSON.stringify(name)})`).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await openKebab(page, row);
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 5000 });
    // v7.13.2 — the whole per-competition CxOne section is admin-level: a regular admin
    // sees the opt-out checkbox AND the credential override fields + Save button.
    await expect(page.locator("#comp-cxone-disabled")).toHaveCount(1);
    await expect(page.locator("#comp-cxone-key")).toBeVisible();
    await expect(page.locator("#comp-cxone-group")).toBeVisible();
    await expect(page.locator("[data-action='comp-save-cxone']")).toBeVisible();
    // A regular admin can SAVE a per-competition override (group-name).
    await page.locator("#comp-cxone-group").fill("admin-override-group");
    await page.locator("[data-action='comp-save-cxone']").click();
    await expect.poll(async () => ((await (await page.request.get("/api/admin/competitions")).json()).find(c => c.id === compId)?.cxone_configured), { timeout: 5000 }).toBe(true);
    // The opt-out checkbox disables the override fields (shared behaviour).
    await page.locator("#comp-cxone-disabled").check();
    await expect(page.locator("#comp-cxone-key")).toBeDisabled();
    await expect(page.locator("#comp-cxone-group")).toBeDisabled();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v7.15.0 — admin rankings: all-solved column + sortable columns
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.15.0 — admin rankings columns + sorting", () => {
  test("rankings table has a sortable all-solved column and every column sorts", async ({ page }) => {
    // v8.17.0 — First/Last Name are under Columns by default; this test clicks every heading.
    const { showAllTableColumns } = require("./ui-admin-helpers");
    await showAllTableColumns(page, "rankings", ["place", "player", "first", "last", "company", "email", "score", "time", "solved"]);
    await adminLogin(page);
    await clickTab(page, "Events");
    await viewComp(page, "Test Live");          // focus a comp so the single-table view renders
    await clickTab(page, "Rankings");
    const body = page.locator("#admin-rankings-body");
    await body.locator("tr").first().waitFor({ state: "attached", timeout: 15000 });

    // textContent, not innerText: admin headings render as uppercase eyebrows
    // (CSS text-transform), and the order of the words is what is pinned.
    const headers = (await page.locator("#admin-rankings-tab thead th").allTextContents()).map(s => s.trim());
    // v7.22.0 re-pinned this: the four identity columns landed between Player
    // and Score. That is a behaviour change being re-asserted, not churn — the
    // guarantee (all-solved is its own column, every header sorts) is unchanged.
    expect(headers.slice(0, 9), "identity columns sit between Player and Score; all-solved is its own column")
      .toEqual(["#", "Player", "First Name", "Last Name", "Company", "Email", "Score", "Time to Solve", "All Solved"]);

    // Every header is a real sortable control, not just a label.
    for (const col of ["place", "player", "first", "last", "company", "email", "score", "time", "solved"]) {
      const th = page.locator(`#admin-rankings-tab th[data-col="${col}"]`).first();
      await expect(th, `${col} header is sortable`).toHaveClass(/sortable/);
      const rowsBefore = await body.locator("tr").count();
      await th.click();
      await page.waitForTimeout(300);
      await expect(th, `${col} reflects its sort state to assistive tech`).toHaveAttribute("aria-sort", "ascending");
      expect(await body.locator("tr").count(), `sorting by ${col} keeps every row`).toBe(rowsBefore);
      await th.click();
      await page.waitForTimeout(300);
      await expect(th).toHaveAttribute("aria-sort", "descending");
      expect(await body.locator("tr").count()).toBe(rowsBefore);
    }
  });

  // v7.15.2 (audit) — the test above observes only sortRankings + the icon/aria
  // paint: `_rkApplySort` could `return rows` untouched and it would still pass.
  // (Its row-count assertion is near-vacuous too — the seeded 'Test Live' board
  // can be a single row, making "keeps every row" 1 === 1.) Build a board that
  // actually VARIES every sortable field and assert the rows move.
  test("admin rankings: _rkApplySort actually re-orders the rows", async ({ page }) => {
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const crypto = require("crypto");
    const tag = crypto.randomBytes(4).toString("hex");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const jsonH = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const compName = `RkSort-${tag}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: jsonH, data: {
      name: compName, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    const taskIds = [];
    for (const n of [1, 2]) {
      const id = (await (await sa.post("/api/admin/tasks", { headers: jsonH, data: {
        title: `RkSortTask ${tag} ${n}`, description: "<p>x</p>", difficulty: n === 1 ? "easy" : "medium",
        answer_type: "text", correct_answer: `a${n}`, status: "published",
      }})).json()).id;
      const ar = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: jsonH, data: { competitionIds: [compId] } });
      taskIds.push((await ar.json()).copies[0].task_id);   // the event's own copy (lib/event-copies.js): the row its submissions name
    }
    const ids = [];
    const dbW = new Database(TEST_DB_PATH);
    try {
      const insU = dbW.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, avatar, verified, approved, password_hash, created_at) VALUES (?,?,?,?,?,?,1,1,?,?)");
      const insCU = dbW.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, login_time) VALUES (?,?,?,?,?)");
      const insSub = dbW.prepare(`INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at) VALUES (?,?,?,?,?,1,?,?)`);
      dbW.transaction(() => {
        for (let i = 0; i < 6; i++) {
          const id = `rksort-${tag}-${i}`;
          ids.push(id);
          insU.run(id, "Rk", `Dummy${i}`, `rks_${tag}_${i}`, `rks-${tag}-${i}@acme.com`, "default1", "$2b$10$dummyhashdoesnotneedtowork", new Date(t - 90 * 60_000).toISOString());
          const lt = new Date(t - 10 * 60_000 + i * 1000).toISOString();
          insCU.run(compId, id, "test-system", lt, lt);
          const solves = i % 3 === 0 ? 2 : i % 3 === 1 ? 1 : 0;   // both / one / none
          for (let k = 0; k < solves; k++) {
            insSub.run(`${id}-s${k}`, id, taskIds[k], compId, `a${k + 1}`, k === 0 ? 50 : 100,
              new Date(t - 5 * 60_000 + i * 1000).toISOString());
          }
        }
      })();
    } finally { dbW.close(); }

    try {
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, compName);
      await clickTab(page, "Rankings");
      const body = page.locator("#admin-rankings-body");
      await body.locator("tr").first().waitFor({ state: "attached", timeout: 15000 });
      expect(await body.locator("tr").count(), "fixture must render several rows").toBeGreaterThan(2);

      // v7.22.0 — the column index is DERIVED from the header, not written out.
      // It used to be a literal `children[2]`, which the four identity columns
      // moved: the read silently landed on First Name, every row parsed to 0,
      // and the failure surfaced as "fixture must VARY score" — pointing at the
      // fixture rather than at the read. Deriving it means the next column
      // insert cannot break this test at all.
      const scoreIdx = await page.locator("#admin-rankings-tab thead th").evaluateAll(
        ths => ths.findIndex(t => t.dataset.col === "score"));
      expect(scoreIdx, "the rankings header must expose a score column").toBeGreaterThan(-1);
      const scores = () => body.locator("tr").evaluateAll((rs, i) =>
        rs.map(r => parseInt((r.children[i]?.textContent || "").replace(/[^\d-]/g, ""), 10) || 0), scoreIdx);
      const th = page.locator('#admin-rankings-tab th[data-col="score"]').first();

      await th.click(); await page.waitForTimeout(300);
      const asc = await scores();
      expect(new Set(asc).size, "fixture must VARY score, else this is vacuous").toBeGreaterThan(1);
      expect(asc.every((v, i) => i === 0 || asc[i - 1] <= v), `score ascending: ${asc.join(",")}`).toBe(true);

      await th.click(); await page.waitForTimeout(300);
      const desc = await scores();
      expect(desc, "second click reverses the order").toEqual([...asc].reverse());
    } finally {
      const dbC = new Database(TEST_DB_PATH);
      try {
        dbC.prepare("DELETE FROM submissions WHERE competition_id=?").run(compId);
        dbC.prepare("DELETE FROM competition_users WHERE competition_id=?").run(compId);
        dbC.prepare("DELETE FROM competition_tasks WHERE competition_id=?").run(compId);
        dbC.prepare("DELETE FROM competitions WHERE id=?").run(compId);
        for (const id of ids) dbC.prepare("DELETE FROM users WHERE id=?").run(id);
        for (const id of taskIds) dbC.prepare("DELETE FROM tasks WHERE id=?").run(id);
      } finally { dbC.close(); }
      await sa.dispose();
    }
  });

  test("rankings tab has no moderate+ axe violations with the new column present", async ({ page }) => {
    // The solved pill's colours and the sortable <th> semantics both land here;
    // this is the gate that catches a sub-AA tint or a missing scope/aria-sort.
    await adminLogin(page);
    await clickTab(page, "Events");
    await viewComp(page, "Test Live");
    await clickTab(page, "Rankings");
    await page.locator("#admin-rankings-body tr").first().waitFor({ state: "attached", timeout: 15000 });
    await page.locator('#admin-rankings-tab th[data-col="solved"]').first().click();
    await page.waitForTimeout(300);
    // `heading-order` is disabled and ONLY that rule: the focused-competition view
    // renders #admin-rankings-title as an <h3> with no <h2> above it, which this
    // change neither introduced nor moved (it adds a column and header semantics,
    // no headings). It is a genuine pre-existing finding worth fixing on its own;
    // suppressing it here keeps this gate meaningful for what the change DID touch
    // — the solved pill's contrast and the sortable <th> semantics — rather than
    // being permanently red for an unrelated reason.
    const results = await new AxeBuilder({ page }).include("#admin-rankings-tab").disableRules(["heading-order"]).analyze();
    const bad = results.violations.filter(v => ["moderate", "serious", "critical"].includes(v.impact));
    expect(bad.flatMap(v => v.nodes.map(n => `${v.id} @ ${n.target.join(" ")}`))).toEqual([]);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// User-field matrix (v7.15.8) — every profile field, on every surface
// ═══════════════════════════════════════════════════════════════════════════════
// Prompted by a report that "Professional Role" was missing from the admin's
// profile view and from the CSV. The field-by-field audit that followed found
// the CSV genuinely dropping Salutation + Phone, and its headers carrying DB
// names rather than the labels the dialogs show. This test is the lasting guard:
// ONE populated participant, checked across every surface a field can hide in,
// so a future field addition cannot land on some surfaces and not others.
test.describe("User-field matrix (v7.15.8)", () => {
  // The participant-facing profile fields, with the value we seed for each. Add
  // a field here when you add one to the users table + profile dialogs.
  const FIELDS = {
    personal_title:  "Dr.",
    first_name:      "Matrix",
    last_name:       "Audit",
    company:         "Acme Corp",
    title:           "Staff Engineer",
    job_function:    "Application Security Engineer",
    city:            "Boston",
    phone:           "+1 555 0100",
    country:         "US",
    timezone:        "America/New_York",
    linkedin_url:    "https://linkedin.com/in/matrixaudit",
  };

  let ST;
  test.beforeAll(async () => {
    const stamp = Date.now();
    const email = `fmtx${stamp}@acme.com`;
    const nickname = `fmtx${stamp}`;
    const { api: anon, csrf: ac } = await freshCtx();
    const r = await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" },
      data: {
        firstName: FIELDS.first_name, lastName: FIELDS.last_name, nickname, email,
        secondaryEmail: `fmtx${stamp}.alt@acme.com`,
        company: FIELDS.company, title: FIELDS.title, personalTitle: FIELDS.personal_title,
        phone: FIELDS.phone, country: FIELDS.country, timezone: FIELDS.timezone,
        jobFunction: FIELDS.job_function, city: FIELDS.city,
        linkedinUrl: FIELDS.linkedin_url, avatar: "🦊", password: PARTICIPANT_PASS,
      },
    });
    expect(r.status(), "seed participant registers").toBe(200);
    await anon.dispose();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const u = (await (await sa.get(`/api/admin/participants?limit=2000`)).json())
      .participants.find(p => p.email === email);
    expect(u, "seeded participant is listed").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });
    await sa.dispose();
    ST = { email, nickname, id: u.id, secondary: `fmtx${stamp}.alt@acme.com` };
  });

  test("the PARTICIPANT's own view (GET /api/me) carries every profile field", async () => {
    const { api } = await apiLogin(ST.email, PARTICIPANT_PASS);
    const me = await (await api.get("/api/me")).json();
    await api.dispose();
    const missing = Object.entries(FIELDS).filter(([f, v]) => me[f] !== v).map(([f, v]) => `${f} (want ${JSON.stringify(v)}, got ${JSON.stringify(me[f])})`);
    expect(missing, `GET /api/me is missing or altering: ${missing.join("; ")}`).toEqual([]);
  });

  test("the ADMIN's view (GET /api/admin/participants) carries every profile field", async () => {
    // This is the surface the bug report was about: the admin profile dialog is
    // rendered ENTIRELY from this payload (S.adminParticipantsData), so a field
    // absent here shows as blank on screen even though the participant sees it.
    const { api } = await apiLogin("superadmin");
    const row = (await (await api.get("/api/admin/participants?limit=2000")).json())
      .participants.find(p => p.email === ST.email);
    await api.dispose();
    expect(row, "participant present in the admin list").toBeTruthy();
    const missing = Object.entries(FIELDS).filter(([f, v]) => row[f] !== v).map(([f, v]) => `${f} (want ${JSON.stringify(v)}, got ${JSON.stringify(row[f])})`);
    expect(missing, `admin list is missing or altering: ${missing.join("; ")}`).toEqual([]);
  });

  test("the JSON export carries every profile field", async () => {
    const { api } = await apiLogin("superadmin");
    const exp = await (await api.get("/api/admin/export/participants")).json();
    await api.dispose();
    const row = (exp.participants || exp.users || []).find(p => p.email === ST.email);
    expect(row, "participant present in the JSON export").toBeTruthy();
    const missing = Object.entries(FIELDS).filter(([f, v]) => row[f] !== v).map(([f]) => f);
    expect(missing, `JSON export is missing: ${missing.join(", ")}`).toEqual([]);
  });

  test("a JSON export → import round-trip preserves every profile field", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const exp = await (await api.get("/api/admin/export/participants")).json();
    const row = (exp.participants || exp.users || []).find(p => p.email === ST.email);
    // Re-import as a NEW identity so nothing is mutated in place; every profile
    // field must survive the round trip.
    const stamp = `${Date.now()}`;
    const clone = { ...row, id: undefined, email: `rt${stamp}@acme.com`, secondary_email: null, nickname: `rt${stamp}` };
    // Re-use the REAL export envelope (type + version) and swap in the single
    // cloned row — the import validates the envelope, and hand-rolling it would
    // only test my guess at the shape rather than the actual round trip.
    const envelope = { ...exp, participants: [clone] };
    // The import is two-phase: without `resolutions` it is a DRY RUN that only
    // reports conflicts. Passing `resolutions` is what actually applies it — a
    // test that skipped this would "pass" the POST and assert nothing was
    // written, which is how the first version of this test fooled itself.
    const dry = await api.post("/api/admin/import/participants", { headers: H, data: { data: envelope } });
    expect(dry.ok(), `dry run failed: ${dry.status()} ${await dry.text()}`).toBeTruthy();
    expect((await dry.json()).dryRun, "first call is the dry run").toBe(true);
    const imp = await api.post("/api/admin/import/participants", {
      headers: H, data: { data: envelope, resolutions: {} },
    });
    expect(imp.ok(), `import failed: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    const back = (await (await api.get("/api/admin/participants?limit=2000")).json())
      .participants.find(p => p.email === `rt${stamp}@acme.com`);
    await api.dispose();
    expect(back, "imported participant exists").toBeTruthy();
    const lost = Object.entries(FIELDS).filter(([f, v]) => back[f] !== v).map(([f, v]) => `${f} (want ${JSON.stringify(v)}, got ${JSON.stringify(back[f])})`);
    expect(lost, `import dropped or altered: ${lost.join("; ")}`).toEqual([]);
  });

  test("the CSV export carries every profile field, under its UI label", async ({ page }) => {
    // Rendered by the REAL client function against the real admin payload, so
    // this catches a column that exists in the header but is never populated.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const lr = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() },
    });
    expect(lr.ok()).toBeTruthy();
    await page.goto("/");
    await page.waitForSelector("#admin-page", { timeout: 20000 });
    // The list is paginated; make sure our participant is in the loaded page.
    await page.evaluate(async () => { await window.loadAdminParticipants(1, 2000); });
    const csv = await page.evaluate(async () => {
      let blob = null;
      const realCreate = URL.createObjectURL;
      const realClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (b) => { blob = b; return "blob:probe"; };
      HTMLAnchorElement.prototype.click = function () {};
      try { window.exportParticipantsCSV(); } finally {
        URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
      }
      return blob ? await blob.text() : null;
    });
    expect(csv, "CSV produced").toBeTruthy();
    const header = csv.split("\n")[0];
    // Headers use the labels the DIALOGS show, not the DB column names — an
    // operator searching for the on-screen label must find the column.
    for (const label of ["Salutation", "Job Function", "Work Title", "City", "Phone"]) {
      expect(header, `CSV header must name the field as the UI does: ${label}`).toContain(`"${label}"`);
    }
    expect(header, "no header names a label the dialogs no longer show").not.toContain('"Professional Role"');
    const line = csv.split("\n").find(l => l.includes(ST.email));
    expect(line, "our participant has a CSV row").toBeTruthy();
    const missing = Object.values(FIELDS).filter(v => !line.includes(v));
    expect(missing, `CSV row is missing values: ${missing.join(" | ")}`).toEqual([]);
  });

  // v7.15.8 (user-field audit) — an admin save must never ERASE a mandatory
  // profile field. Reported from production: a superadmin opened a profile,
  // changed the Professional Role, saved, reopened — and the role was blank;
  // impersonating the participant then demanded their City, "but it was filled
  // before". Cause: job_function / city / country / timezone / company / title
  // all ran through fillOptional, which for a superadmin maps an empty incoming
  // value to NULL. PUT /api/me has always refused to clear these (400); the
  // admin endpoint was the silent back door, and nulling one drops the
  // participant into the non-dismissible profile-completion gate.
  // v7.15.8 — the CSV must carry the profile fields when a competition is
  // FOCUSED too. exportParticipantsCSV() serialises S.adminParticipantsData, and
  // pre-v8.8.11 the focused view filled that array from the PICKER — the same
  // payload that caused the blank Edit-Profile dialog. Verified pre-fix: this
  // exact path produced a row with Professional Role, City, Salutation and Phone
  // all empty, so the operator's "it isn't exported" report was the same defect,
  // not a separate one.
  //
  // v8.8.11 collapsed the two loaders onto ONE endpoint, so both CSV tests now
  // read the same payload and this one can no longer diverge from its sibling by
  // construction. It is KEPT rather than merged: its subject is the FOCUSED
  // export, and a future re-split would silently make the sibling the only
  // coverage — which is precisely the state v7.15.8 was written against.
  test("the CSV carries every profile field when a competition is FOCUSED", async ({ page }) => {
    const stamp = Date.now();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `CsvFocus ${stamp}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition.id;
    const email = `csvf${stamp}@acme.com`;
    const VALUES = {
      job_function: "Application Security Engineer", city: `Boston-${stamp}`,
      personal_title: "Dr.", phone: `+1 555 ${String(stamp).slice(-4)}`,
      company: `Acme-${stamp}`, title: `Staff Engineer ${stamp}`,
    };
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
      firstName: "Csv", lastName: "Focus", nickname: `csvf${stamp}`, email,
      company: VALUES.company, title: VALUES.title, personalTitle: VALUES.personal_title,
      phone: VALUES.phone, country: "US", timezone: "America/New_York",
      jobFunction: VALUES.job_function, city: VALUES.city, password: PARTICIPANT_PASS,
    }});
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });
    await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [u.id], competitionIds: [compId] } });
    await sa.dispose();

    await adminLogin(page);
    const csv = await page.evaluate(async (cid) => {
      window.S.adminSelectedCompetitionId = cid;      // focus → list comes from the picker
      await window.loadAdminParticipants();
      let blob = null;
      const rc = URL.createObjectURL, rk = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (b) => { blob = b; return "blob:probe"; };
      HTMLAnchorElement.prototype.click = function () {};
      // v8.9.0 — FOCUSED, so the export awaits the free-text-responses read
      // before it downloads; the stubs must outlive that await.
      try { await window.exportParticipantsCSV(); } finally { URL.createObjectURL = rc; HTMLAnchorElement.prototype.click = rk; }
      return blob ? await blob.text() : null;
    }, compId);
    expect(csv, "CSV produced in the focused view").toBeTruthy();
    const line = csv.split("\n").find(l => l.includes(email));
    expect(line, "the focused competition's member has a CSV row").toBeTruthy();
    const missing = Object.entries(VALUES).filter(([, v]) => !line.includes(v)).map(([f]) => f);
    expect(missing,
      `focused-view CSV row is missing: ${missing.join(", ")} — the picker payload feeds this export too`).toEqual([]);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("an admin save cannot erase a mandatory profile field", async () => {
    const stamp = Date.now();
    const email = `wipe${stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
      firstName: "Wipe", lastName: "Guard", nickname: `wipe${stamp}`, email,
      company: "Acme", title: "Staff Engineer", country: "US", timezone: "America/New_York",
      jobFunction: "Application Security Engineer", city: "Boston", password: PARTICIPANT_PASS,
    }});
    await anon.dispose();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const u = (await (await sa.get(`/api/admin/participants?limit=2000`)).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });

    // A superadmin save that submits BLANK mandatory fields — the shape the
    // dialog produces when a control fails to populate.
    const put = await sa.put(`/api/admin/participants/${u.id}`, { headers: H, data: {
      firstName: "Wipe", lastName: "Guard", nickname: `wipe${stamp}`, email,
      company: "", title: "", country: "", timezone: "", jobFunction: "", city: "",
    }});
    expect(put.ok(), `admin save: ${put.status()}`).toBeTruthy();

    const after = (await (await sa.get(`/api/admin/participants?limit=2000`)).json()).participants.find(p => p.email === email);
    for (const [f, want] of Object.entries({
      job_function: "Application Security Engineer", city: "Boston",
      company: "Acme", title: "Staff Engineer", country: "US", timezone: "America/New_York",
    })) {
      expect(after[f], `mandatory field ${f} must survive a blank admin save`).toBe(want);
    }

    // …and the participant is therefore NOT pushed into the completion gate.
    const { api: pa } = await apiLogin(email, PARTICIPANT_PASS);
    const me = await (await pa.get("/api/me")).json();
    await pa.dispose();
    expect(me.missing_fields, "no mandatory field was silently emptied").toEqual([]);
    expect(me.profile_complete).toBe(true);

    // An admin can still CHANGE a mandatory field to a new value.
    const put2 = await sa.put(`/api/admin/participants/${u.id}`, { headers: H, data: {
      firstName: "Wipe", lastName: "Guard", nickname: `wipe${stamp}`, email,
      jobFunction: "DevOps / DevSecOps Engineer", city: "Berlin",
    }});
    expect(put2.ok()).toBeTruthy();
    const after2 = (await (await sa.get(`/api/admin/participants?limit=2000`)).json()).participants.find(p => p.email === email);
    expect(after2.job_function, "a real change still applies").toBe("DevOps / DevSecOps Engineer");
    expect(after2.city).toBe("Berlin");
    await sa.dispose();
  });
});


test.describe("v7.20.9 (ext-audit F12) — analytics empty states", () => {
  // 30 rows so the default 25-row page is exceeded and the pagination bar is
  // genuinely populated before the empty render is provoked.
  const mkRows = (stamp, n = 30) => Array.from({ length: n }, (_, i) => ({
    task_id: `f12-${stamp}-${i}`, task_number: `9.${String(i).padStart(2, "0")}`,
    title: `Filler challenge ${i}`, difficulty: "easy", tags: [],
    solved: 3, incorrect: 1, hint_revealed: 0, navigated_away: 0, unique_attempters: 4,
  }));

  // F12a — the no-match row shipped as colspan="10" against an 11-column table
  // (the Solve-rate column arrived later), so the empty state rendered one cell
  // short of the table's width. It is DERIVED from the real <thead> now.
  test("the no-match row spans the full table width, derived from the thead", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    // Intercept rather than injecting rows via evaluate(): the tab issues its
    // own fetch, which resolves afterwards and re-renders over injected rows
    // (the v7.20.7 lesson).
    await page.route("**/api/admin/analytics/challenges*", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ per_challenge: mkRows(stamp), summary: {}, totals: {} }),
    }));
    await openAnalyticsTab(page);
    await expect.poll(() => page.locator("#analytics-table-body tr").count(),
      { timeout: 25000, intervals: [100, 200, 400, 800] }).toBeGreaterThan(1);

    await page.locator("#analytics-search").fill(`zzz-no-such-challenge-${stamp}`);
    const emptyCell = page.locator("#analytics-table-body tr td").first();
    await expect(emptyCell).toContainText(/No challenges match/i, { timeout: 10000 });

    const cols = await page.locator("#analytics-table thead th").count();
    // Positive control on the fixture itself: if the table ever stops having 12
    // columns this test must be re-read, not silently keep agreeing with itself.
    // It has done its job once already — v7.27.0 added "Unique Attempters" and
    // this line went red, which is exactly the re-read it exists to force.
    expect(cols, "the analytics table has 12 columns").toBe(12);
    expect(
      await emptyCell.evaluate((el) => el.colSpan),
      "the empty-state row spans every column of the real header",
    ).toBe(cols);
  });

  // F12b — the ZERO-DATA early return left the pagination bar and the
  // search-clear button behind, so a filter change that emptied the result set
  // showed "Page 2 of 5" and a Clear button over an explicit "no activity"
  // message; and S._anPage stayed put, so the next non-empty render silently
  // started on a page the operator had never seen page 1 of.
  test("a zero-data render clears the pagination bar, the search-clear button and the page index", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    let payload = { per_challenge: mkRows(stamp), summary: {}, totals: {} };
    await page.route("**/api/admin/analytics/challenges*", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(payload),
    }));
    await openAnalyticsTab(page);
    await expect.poll(() => page.locator("#analytics-table-body tr").count(),
      { timeout: 25000, intervals: [100, 200, 400, 800] }).toBeGreaterThan(1);

    // Build the state the fix has to tear down. Search FIRST (its handler resets
    // the page index), then page forward.
    // v7.21.35 — PROVE THE DEBOUNCE HAS FIRED before clicking "next".
    // `registerInput('analytics-search')` debounces 160 ms and its timer sets
    // `S._anPage = 1`. The old sequence filled the box and clicked immediately,
    // and the 25-row assertion cannot see the search land — all 30 mock rows are
    // titled "Filler challenge N", so page 1 shows 25 before AND after. The
    // click could therefore land first and the timer then reset the index,
    // failing the positive control below with `Received: 1`. Seen once in a full
    // run; reproduced from the handler, not guessed.
    //
    // A fixed sleep would be the wrong fix (this suite deliberately has none):
    // park a sentinel the handler MUST overwrite, and wait for that.
    await page.evaluate(() => { window.S._anPage = 2; });
    await page.locator("#analytics-search").fill("Filler challenge");
    await expect.poll(() => page.evaluate(() => window.S._anPage),
      { timeout: 10000, message: "the debounced search handler never ran" }).toBe(1);
    await expect(page.locator("#analytics-table-body tr")).toHaveCount(25, { timeout: 10000 });
    await page.locator("[data-action='analytics-page-next']").click();

    // POSITIVE CONTROL — every assertion below is trivially true of chrome that
    // was never populated, so prove it IS populated first.
    await expect(page.locator("#analytics-pagination"), "the bar is populated before the empty render").not.toBeEmpty();
    await expect(page.locator("#analytics-search-clear"), "the clear button is showing").not.toHaveClass(/\bhidden\b/);
    expect(await page.evaluate(() => window.S._anPage), "…and we are past page 1").toBe(2);

    // Now the same filters yield nothing at all.
    payload = { per_challenge: [], summary: {}, totals: {} };
    await page.evaluate(() => window._analyticsScheduleRefetch());
    await expect(page.locator("#analytics-empty"), "the zero-data state is what we are in").toBeVisible({ timeout: 15000 });

    await expect(page.locator("#analytics-pagination"), "no pager over an explicit 'no activity' message").toBeEmpty();
    await expect(page.locator("#analytics-search-clear"), "no Clear button over an empty result set").toHaveClass(/\bhidden\b/);
    await expect.poll(() => page.evaluate(() => window.S._anPage),
      { timeout: 5000 }).toBe(1);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.21.1 (A3) — wall-clock → UTC across a DST transition
// ═══════════════════════════════════════════════════════════════════════════════
//
// The admin types a wall clock and picks a zone; the app converts that to the
// instant it stores. The conversion was one-pass — it sampled the zone's offset
// at the NAIVE instant (the typed wall clock read as if it were UTC) instead of
// at the instant the conversion produces. Those are |offset| hours apart, so
// every entry within |offset| hours of a transition took the wrong side of it:
// 2027-03-14 03:30 in America/New_York, half an hour after the spring-forward,
// was stored as 08:30Z — 04:30 local. An hour late, silently, on the field that
// decides when participants can get in.
//
// The v7.15.31 session tests could not catch this: their table deliberately
// picks dates "unambiguously inside or outside DST … rather than near a
// boundary", which is precisely the region where one-pass and two-pass agree.
//
// The browser is pinned to UTC so these reproduce on ANY machine (the v7.15.23
// precedent) rather than depending on the runner's own zone.
test.describe("Start times across a DST transition (v7.21.1 A3)", () => {
  test.use({ timezoneId: "UTC" });
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  // What the admin types, in the zone they pick → the instant that must be
  // stored. Each row is inside the window the one-pass version got wrong, and
  // each wall clock genuinely exists (no spring-forward gap, no fall-back
  // ambiguity), so there is exactly one right answer.
  const DST_CASES = [
    // zone,                 date,         time,    expected instant,            what one-pass stored
    ["America/New_York",     "2027-03-14", "03:30", "2027-03-14T07:30:00.000Z", "04:30 local"],
    ["America/Los_Angeles",  "2027-03-14", "09:00", "2027-03-14T16:00:00.000Z", "10:00 local"],
    ["America/New_York",     "2027-11-07", "03:00", "2027-11-07T08:00:00.000Z", "02:00 local"],
  ];
  // Positive control: away from any transition the answer was already right, so
  // a "fix" that simply shifted everything by an hour must fail here.
  const CONTROL_CASES = [
    ["America/New_York",     "2027-01-15", "10:00", "2027-01-15T15:00:00.000Z"],
    ["America/New_York",     "2027-07-15", "10:00", "2027-07-15T14:00:00.000Z"],
    ["Asia/Kolkata",         "2027-01-15", "10:00", "2027-01-15T04:30:00.000Z"],
    ["Australia/Sydney",     "2027-01-15", "10:00", "2027-01-14T23:00:00.000Z"],
    ["UTC",                  "2027-01-15", "10:00", "2027-01-15T10:00:00.000Z"],
  ];

  test("v8.6.3 — utcToWallClock is the exact INVERSE, including across DST", async ({ page }) => {
    // The pair is the point: a date/time field WRITTEN with one and READ BACK with
    // the other must round-trip, or the value silently shifts by the offset. Three
    // sites had hand-rolled the inverse before it was extracted, and the late-entry
    // deadline is the one that re-renders after a timezone change — which is when
    // "the browser zone happens to equal the box zone" stops being true.
    //
    // Driven over the SAME tables the forward direction uses, so the two can never
    // be verified against different data.
    await adminLogin(page);
    await page.waitForFunction(() => typeof window.utcToWallClock === "function", { timeout: 20000 });

    for (const [tz, date, time, iso] of [...DST_CASES, ...CONTROL_CASES]) {
      const back = await page.evaluate(([i, z]) => window.utcToWallClock(new Date(i), z), [iso, tz]);
      expect(back, `${tz} ${date} ${time}: the instant renders back as the wall clock that produced it`)
        .toEqual({ date, time });
      // …and forward again, so the round trip closes rather than merely agreeing once.
      const fwd = await page.evaluate(([d, t, z]) => window.wallClockToUtc(d, t, z)?.toISOString(), [back.date, back.time, tz]);
      expect(fwd, `${tz}: and converts back to the same instant`).toBe(iso);
    }

    // Refuses rather than guessing, so a caller mid-type in the timezone box clears
    // its preview instead of showing a wrong one.
    const bad = await page.evaluate(() => ({
      zone: window.utcToWallClock(new Date("2027-01-15T10:00:00Z"), "Not/AZone"),
      date: window.utcToWallClock(new Date("nonsense"), "UTC"),
      nul:  window.utcToWallClock(null, "UTC"),
    }));
    expect(bad, "an unusable zone or instant yields null, never a wrong wall clock")
      .toEqual({ zone: null, date: null, nul: null });

    // Midnight renders "00". MEASURED: this Chromium never emits the "24" some
    // engines produce under hour12:false, so the normalisation branch is NOT
    // exercised here and this asserts the OUTCOME rather than that branch — it is
    // defence in depth carried over verbatim from the three copies this replaced,
    // and an <input type=time> rejects "24:00" outright, so it is not cosmetic.
    // Do not read a green run as evidence about an engine this suite never runs.
    expect(await page.evaluate(() => window.utcToWallClock(new Date("2027-01-15T00:00:00Z"), "UTC")))
      .toEqual({ date: "2027-01-15", time: "00:00" });
  });

  test("wallClockToUtc lands on the right side of the transition", async ({ page }) => {
    await adminLogin(page);
    await page.waitForFunction(() => typeof window.wallClockToUtc === "function", { timeout: 20000 });
    // The browser really is where we think — without this the whole table could
    // pass by accident on a runner that ignored timezoneId.
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      "Playwright must have applied timezoneId").toBe("UTC");

    for (const [tz, date, time, expected, wrong] of DST_CASES) {
      const got = await page.evaluate(([d, t, z]) => {
        const x = window.wallClockToUtc(d, t, z);
        return { iso: x && x.toISOString(), back: x && x.toLocaleString("en-GB", { timeZone: z, hour12: false }) };
      }, [date, time, tz]);
      expect(got.iso, `${date} ${time} ${tz} — one-pass stored ${wrong}`).toBe(expected);
      // The same claim stated the way a user would check it: the instant we
      // stored reads back as the wall clock they typed, in the zone they chose.
      expect(got.back, `${date} ${time} ${tz} must round-trip in its own zone`).toContain(time);
    }
    for (const [tz, date, time, expected] of CONTROL_CASES) {
      const iso = await page.evaluate(([d, t, z]) => window.wallClockToUtc(d, t, z)?.toISOString(), [date, time, tz]);
      expect(iso, `control: ${date} ${time} ${tz} was already correct and must stay so`).toBe(expected);
    }

    // The callers' contract: a missing half yields null (they early-return on
    // it), and an unusable zone still yields an instant so the row stays usable
    // and the save path can raise its own named error.
    const contract = await page.evaluate(() => ({
      noDate: window.wallClockToUtc("", "10:00", "UTC"),
      noTime: window.wallClockToUtc("2027-01-15", "", "UTC"),
      halfTypedZone: window.wallClockToUtc("2027-01-15", "10:00", "Europe/Lond")?.toISOString(),
    }));
    expect(contract.noDate, "no date → null").toBeNull();
    expect(contract.noTime, "no time → null").toBeNull();
    expect(contract.halfTypedZone, "a half-typed zone must not throw or return null").toBeTruthy();
  });

  test("a competition created on the spring-forward day is stored at the time that was typed", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    const name = `DST comp ${Date.now()}`;
    try {
      await openCompCreateForm(page);
      await page.locator("#comp-name").fill(name);
      await page.locator("#comp-date").fill("2027-03-14");
      await page.locator("#comp-time").fill("03:30");
      await page.locator("#comp-tz").fill("America/New_York");
      await page.locator("#comp-dur-h").fill("2");
      await page.locator('[data-action="comp-save"]').first().click();

      const confirm = page.locator("#modal-overlay");
      await expect(confirm).toContainText("Create Competition?", { timeout: 10000 });
      await confirm.locator("button", { hasText: /^Create$/ }).first().click();

      // Asserted from the DATABASE — this is the value participants are gated
      // on, and the form's own preview is rendered by the same code under test.
      await expect.poll(() => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try { return db.prepare("SELECT start_time FROM competitions WHERE name=?").get(name)?.start_time || null; }
        finally { db.close(); }
      }, { timeout: 15000, intervals: [100, 200, 400, 800] })
        .toBe("2027-03-14T07:30:00.000Z"); // one-pass stored …T08:30Z, i.e. 04:30 in New York
    } finally {
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("DELETE FROM competitions WHERE name=?").run(name); } finally { db.close(); }
    }
  });

  test("a SESSION created on the spring-forward day is stored at the time that was typed", async ({ page }) => {
    // The session rows are a SEPARATE renderer with their own copy of the
    // arithmetic (sessions-admin.js), which is why it is driven separately.
    await adminLogin(page);
    await clickTab(page, "Events");
    const name = `DST sessions comp ${Date.now()}`;
    try {
      await openCompCreateForm(page);
      await page.locator("#comp-name").fill(name);
      // The radios are display:none and driven by their labels (see
      // .comp-mode-radio in styles.css), so click the label the admin clicks.
      await page.locator('label[for="comp-mode-multi"]').click();
      await expect(page.locator("#comp-mode-multi")).toBeChecked();
      const rows = page.locator("#comp-sessions-list .session-form-row");
      await expect(rows, "switching to multi seeds two session rows").toHaveCount(2, { timeout: 10000 });

      const fillRow = async (i, sName, date, time) => {
        const row = rows.nth(i);
        await row.locator(".ts-name").fill(sName);
        await row.locator(".ts-date").fill(date);
        await row.locator(".ts-time").fill(time);
        await row.locator(".ts-tz").fill("America/New_York");
      };
      await fillRow(0, "Spring forward", "2027-03-14", "03:30");
      await fillRow(1, "Ordinary day", "2027-03-20", "03:30");

      await page.locator('[data-action="comp-save"]').first().click();
      const confirm = page.locator("#modal-overlay");
      await expect(confirm).toContainText("Create Competition?", { timeout: 10000 });
      await confirm.locator("button", { hasText: /^Create$/ }).first().click();

      await expect.poll(() => {
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try {
          return db.prepare(
            "SELECT ts.name AS n, ts.start_time AS s FROM competition_timeslots ts JOIN competitions c ON c.id=ts.competition_id WHERE c.name=? ORDER BY ts.start_time"
          ).all(name).map(r => `${r.n}=${r.s}`).join("|");
        } finally { db.close(); }
      }, { timeout: 15000, intervals: [100, 200, 400, 800] })
        // The second session is the control: 20 March is nowhere near a
        // transition, so it was already stored correctly and must stay so.
        .toBe("Spring forward=2027-03-14T07:30:00.000Z|Ordinary day=2027-03-20T07:30:00.000Z");
    } finally {
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("DELETE FROM competitions WHERE name=?").run(name); } finally { db.close(); }
    }
  });
});
