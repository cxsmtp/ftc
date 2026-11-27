// @ts-check
//
// v7.21.19 — external-audit round 10, the client-side halves.
//
// F2 (MED) a DST-gap wall clock is refused instead of silently saved as another
// F3 (MED) analytics has a stale-response guard, not just a debounce
// F5 (MED) an import failure is reported as a failure and takes its overlay down
// F8 (LOW) the dry-run rename reached the ACCESSIBLE name, not just the badge
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");
const { openAnalyticsTab, openCompCreateForm, narrowPeopleTable } = require("./ui-admin-helpers"); // v8.1.0 — one analytics entry point; v8.2.0 — one create entry point

test.use({ baseURL: BASE });

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

async function loginSuperadmin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: h(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

// ═══════════════════════════════════════════════════════════════════════════
// F2 — a wall clock that never happened
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F2 — a DST-gap start time is refused", () => {
  test("the pure conversion reports existence and ambiguity", async ({ page }) => {
    // The unit level, driven in a real browser so it is the platform's own Intl
    // answering — the same engine the admin's form uses.
    await loginSuperadmin(page);
    const out = await page.evaluate(() => {
      const f = window.wallClockToUtcChecked;
      if (!f) return { missing: true };
      const one = (d, t, tz) => { const r = f(d, t, tz); return { exists: r.exists, ambiguous: r.ambiguous, iso: r.date && r.date.toISOString() }; };
      return {
        gapNY:      one("2027-03-14", "02:30", "America/New_York"),
        beforeGap:  one("2027-03-14", "01:30", "America/New_York"),
        afterGap:   one("2027-03-14", "03:30", "America/New_York"),
        fallBackNY: one("2027-11-07", "01:30", "America/New_York"),
        ordinary:   one("2027-11-07", "03:30", "America/New_York"),
        gapLondon:  one("2027-03-28", "01:30", "Europe/London"),
        utc:        one("2027-06-01", "09:00", "UTC"),
      };
    });
    expect(out.missing, "wallClockToUtcChecked must be reachable").toBeFalsy();

    // The reported defect: 02:30 does not exist on the spring-forward day, and
    // the old conversion stored it as the same instant as 01:30 and rendered it
    // back as 01:30 — a save that silently changed what the admin typed.
    expect(out.gapNY.exists, "02:30 on the NY spring-forward day does NOT exist").toBe(false);
    expect(out.gapLondon.exists, "…and the same hour in London").toBe(false);
    // Anti-vacuity: the neighbours DO exist, so this is not "everything is false".
    expect(out.beforeGap.exists).toBe(true);
    expect(out.afterGap.exists).toBe(true);
    expect(out.ordinary.exists).toBe(true);
    expect(out.utc.exists, "a zone with no DST at all is unaffected").toBe(true);

    // The other side of the year: 01:30 happens TWICE on the fall-back day. That
    // is not an error — both instants are real and one has to be chosen — but it
    // is reported so a caller can say so rather than decide in silence.
    expect(out.fallBackNY.exists, "an ambiguous time still exists").toBe(true);
    expect(out.fallBackNY.ambiguous, "…and is flagged ambiguous").toBe(true);
    expect(out.ordinary.ambiguous, "an ordinary time is not").toBe(false);
  });

  test("the competition form refuses to save a start time inside the gap", async ({ page }) => {
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id=\"admin-competitions-tab\"]").first().click();
    await openCompCreateForm(page);

    await page.fill("#comp-name", `DST gap ${Date.now()}`);
    await page.fill("#comp-tz", "America/New_York");
    await page.locator("#comp-tz").dispatchEvent("change");
    // A FUTURE spring-forward day: 2027-03-14 in the US. Using a past one made
    // the positive control fail for a reason unrelated to DST (a start time in
    // the past is refused on its own).
    await page.fill("#comp-date", "2027-03-14");
    await page.fill("#comp-time", "02:30");
    await page.locator("[data-action='comp-save']").first().click();

    // It must SAY the time does not exist, and the dialog must stay open so the
    // admin can correct it — saving and showing a different time is the defect.
    await expect(page.locator(".toast"), "the refusal must name the problem")
      .toContainText(/does not exist on that date/i, { timeout: 10000 });
    await expect(page.locator("#comp-form-overlay"), "the form stays open to be corrected").toBeVisible();

    // POSITIVE CONTROL — scoped to the guard rather than to the whole create
    // flow. Driving a full successful save here means satisfying every other
    // validation in the dialog, and a failure then says nothing about DST; what
    // must be proven is that a REAL time is not refused by this check.
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
    await page.fill("#comp-time", "03:30");
    const ctrl = await page.evaluate(() => {
      // The helper is what performs the conversion, so it is what knows.
      const d = window._compFormGetStartDate();
      return { iso: d && d.toISOString(), err: window._compFormGetStartDate._dstError || null };
    });
    expect(ctrl.err, "03:30 is a real time on that date and must NOT be refused").toBeNull();
    expect(ctrl.iso, "…and must convert to an instant").toBeTruthy();
    // 03:30 EDT on the US spring-forward day is 07:30Z — proving the conversion
    // itself is still right, not merely un-refused.
    expect(ctrl.iso).toBe("2027-03-14T07:30:00.000Z");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F3 — analytics stale-response guard
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F3 — a slow earlier analytics response does not win", () => {
  test("the superseded response overwrites neither lastResponse nor the table", async ({ page }) => {
    // The 250 ms debounce only prevents requests that have NOT BEEN SENT. Once
    // two are in flight the network decides which the admin reads, and one
    // aggregate table looks much like another — so the wrong answer is silent.
    await loginSuperadmin(page);
    await openAnalyticsTab(page);
    await page.waitForFunction(() => typeof window.fetchAnalytics === "function", { timeout: 20000 });

    let n = 0;
    await page.route("**/api/admin/analytics/challenges**", async route => {
      const mine = ++n;
      const body = {
        summary: { solved: mine * 100, incorrect: 0, hint_revealed: 0, navigated_away: 0, unique_participants: mine, unique_challenges: 1 },
        tasks: [], challenges: [], scope: "global",
      };
      if (mine === 1) await new Promise(r => setTimeout(r, 1500));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    // Fire-and-forget, both — page.evaluate AWAITS a returned promise, which
    // would serialise them and make the race unreachable (v7.21.15).
    await page.evaluate(() => { window.fetchAnalytics(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.fetchAnalytics(); });
    await page.waitForTimeout(2500);

    const solved = await page.evaluate(() => {
      const s = window._analyticsState && window._analyticsState.lastResponse;
      return s && s.summary ? s.summary.solved : null;
    });
    expect(solved, "a response must have landed at all").not.toBeNull();
    expect(solved, "the superseded (slower, earlier) analytics response overwrote the newer one").toBe(200);
    await page.unroute("**/api/admin/analytics/challenges**");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F5 — an import failure is a failure
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F5 — import failures are reported and never strand the overlay", () => {
  test("an error response on the execution step is reported as an error, not 'Imported undefined'", async ({ page }) => {
    // The dry run was checked and the EXECUTION was not, so an error body
    // produced a success toast reading "Imported undefined challenge(s)" — the
    // import had failed and the admin was told it worked.
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-tasks-tab']").first().click();

    let call = 0;
    await page.route("**/api/admin/import/tasks", async route => {
      call++;
      if (call === 1) {
        // dry run: no conflicts, so the client proceeds straight to execution
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dryRun: true, conflicts: [] }) });
      } else {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Import exploded" }) });
      }
    });

    await page.evaluate(() => {
      const file = new File([JSON.stringify({ type: "hackarena-tasks", tasks: [{ title: "T", description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a" }] })], "t.json", { type: "application/json" });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById("import-tasks-file");
      if (!input) throw new Error("import file input not found");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await expect(page.locator(".toast"), "the failure must be reported AS a failure")
      .toContainText(/Import exploded|Import failed/i, { timeout: 15000 });
    const toasts = await page.locator(".toast").allTextContents();
    expect(toasts.join(" "), "and never as a success with undefined counts").not.toMatch(/Imported undefined/);
    // The blocking overlay must be gone either way.
    await expect(page.locator("#import-progress-overlay")).toBeHidden({ timeout: 10000 });
    await page.unroute("**/api/admin/import/tasks");
  });

  test("a thrown request takes the blocking overlay down with it", async ({ page }) => {
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    // Abort the request outright — the shape a dropped connection produces.
    await page.route("**/api/admin/import/participants", route => route.abort("failed"));
    await page.evaluate(() => {
      window.S._importParticipantsData = { type: "participants", participants: [{ email: "x@y.com", first_name: "X", last_name: "Y", nickname: "xy" }] };
      window.S._importParticipantsSelected = new Set([0]);
      window.proceedToConflictCheck();
    });
    // v8.12.4 — and the operator is TOLD. "The overlay is hidden" alone is also
    // true of a build that never showed it and never sent the request.
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "Network error during import" }).first(),
      "the dropped connection is reported").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#import-progress-overlay"),
      "a thrown fetch must not leave the blocking progress overlay up for ever"
    ).toBeHidden({ timeout: 15000 });
    await page.unroute("**/api/admin/import/participants");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F4 — the client actually ECHOES the tie token
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F4 — the client echoes snapshot_tie, not just the timestamp", () => {
  test("page 2 of Submissions carries both halves of the anchor", async ({ page }) => {
    // The server returns `snapshot_tie` and documents it as a client contract:
    // `snapshot_before` alone is a millisecond, so rows sharing that millisecond
    // cannot be ordered against the anchor and can cross a page boundary between
    // fetches. No client sent it, so every paged read silently used the weaker
    // ms-only filter. This asserts the request the client actually makes.
    await loginSuperadmin(page);
    const urls = [];
    page.on("request", r => { if (r.url().includes("/api/admin/submissions?")) urls.push(r.url()); });
    // RBAC sidebar — Submissions has no sidebar item (Audit covers it); the pane keeps its id.
    await page.locator("#admin-page").waitFor({ state: "visible" });
    await page.evaluate(() => window.adminTab(null, "admin-submissions-tab"));
    // The first load establishes the anchor pair; page 2 is what has to echo it.
    await expect.poll(() => urls.length, { timeout: 25000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => !!window.S && !!window.S._subSnapshotBefore), { timeout: 20000 }).toBe(true);
    expect(await page.evaluate(() => !!window.S._subSnapshotTie),
      "the client must STORE the tie token the server issued").toBe(true);

    urls.length = 0;
    await page.evaluate(() => { window.S.subPage = 2; window.loadAdminSubmissions(); });
    await expect.poll(() => urls.length, { timeout: 20000 }).toBeGreaterThan(0);
    const paged = urls[urls.length - 1];
    expect(paged, "a paged request was made").toBeTruthy();
    expect(paged, "the anchor timestamp is echoed (it always was)").toContain("snapshot_before=");
    expect(paged,
      "…and the TIE token must be echoed with it, or the server falls back to the " +
      "millisecond-only filter and same-ms rows can shift between pages"
    ).toContain("snapshot_tie=");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F8 — the rename reached the accessible name
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F8 — the dry-run rename covers the ACCESSIBLE name too", () => {
  test("a screen reader hears what the badge says", async ({ page }) => {
    // v7.21.18 renamed the visible badge and left the aria-label saying
    // "internal", so the two disagreed for exactly the users who cannot see the
    // badge. Same class as the v7.21.8 tag-chip labels.
    const stamp = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comp = (await (await sa.post("/api/admin/competitions", {
      headers: h(saCsrf),
      data: { name: `A11y ${stamp}`, start_time: new Date(stamp - 60_000).toISOString(), duration_minutes: 240, tags: ["test/dry run"] },
    })).json()).competition.id;
    const email = `a11y-${stamp}@company.com`;
    const { csrfToken: ac } = await (await page.request.get("/api/csrf-token")).json();
    await registerPost(page.request, "/api/register", { headers: h(ac), data: {
      firstName: "A", lastName: "Y", nickname: `a11y${stamp}`, email, company: "Acme", title: "E",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS } });
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });
    // v8.3.12 — A SECOND EVENT, because this test's subject is the PICKER CARD.
    // With exactly one event a sign-in now lands the participant inside it (the
    // sole-event landing rule) and the picker is never rendered, so the card
    // under test does not exist. Anything asserting on `#comp-grid` needs the
    // participant to have a choice to make.
    const comp2 = (await (await sa.post("/api/admin/competitions", {
      headers: h(saCsrf),
      data: { name: `A11y2 ${stamp}`, start_time: new Date(stamp + 3600_000).toISOString(), duration_minutes: 240 },
    })).json()).competition.id;
    await sa.post("/api/admin/competitions/assign", { headers: h(saCsrf), data: { userIds: [u.id], competitionIds: [comp, comp2] } });
    await sa.dispose();

    const { csrfToken: lc } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, email, h(lc));
    await page.goto("/");
    const card = page.locator(`#comp-grid .comp-card:has-text("A11y ${stamp}")`).first();
    await card.waitFor({ state: "visible", timeout: 30000 });

    // The card's control is its name button; that is what carries the
    // accessible name (WCAG 2.5.3 — the name opens with the text it shows).
    const label = await card.locator(".card-open").getAttribute("aria-label");
    expect(label, "the accessible name must carry the marker").toContain("test/dry run");
    expect(label, "…and must not still say the old name").not.toMatch(/internal/i);
    // The visible badge and the accessible name must agree — that is the point.
    await expect(card).toContainText("test/dry run");
  });

  test("no admin tooltip still says 'internal'", async ({ page }) => {
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id=\"admin-competitions-tab\"]").first().click();
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "visible", timeout: 20000 });
    const stale = await page.evaluate(() =>
      [...document.querySelectorAll("[title],[aria-label]")]
        .map(el => `${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""}`)
        .filter(t => /\binternal\b/i.test(t)));
    expect(stale, "a tooltip or accessible name still says 'internal'").toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v7.21.20 — the delete refusal reaches the admin, and offers the way out
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.20 — deleting a participant who is competing right now", () => {
  test("the admin is told WHY, and can go through in one step", async ({ page }) => {
    // THE REPORT, at the surface it was reported from. The client discarded the
    // response and showed a bare "Failed to delete user.", so a superadmin who
    // hit the live-competition guard learned nothing — which reads as "the
    // platform will not let me delete this user".
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#admin-participants-body tr").first().waitFor({ state: "visible", timeout: 20000 });

    // Drive the client's own delete path against the real refusal shape, so this
    // tests the CLIENT's handling rather than a hand-built dialog.
    let forcedUrl = null;
    await page.route("**/api/admin/participants/*", async route => {
      const req = route.request();
      if (req.method() !== "DELETE") return route.continue();
      if (req.url().includes("force=1")) {
        forcedUrl = req.url();
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({
        error: 'Cannot delete a participant who is actively competing in "Live Cup". Remove them from the event first, or confirm to delete them anyway.',
        code: "participant_in_live_competition", competitionId: "c1", competitionName: "Live Cup",
      }) });
    });

    const uid = await page.evaluate(() => (window.S.adminParticipantsData || [])[0]?.id);
    expect(uid, "a participant to act on").toBeTruthy();
    await page.evaluate(id => { window.deleteParticipant(id); }, uid);

    // First confirmation: the ordinary destructive one.
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();

    // SECOND dialog — the refusal, surfaced. It must name the competition, which
    // the generic toast never did.
    const second = page.locator("#modal-overlay.open");
    await second.waitFor({ state: "visible", timeout: 10000 });
    await expect(second, "the refusal must reach the admin, naming the competition").toContainText("Live Cup");
    await expect(second, "…and say what deleting now actually does").toContainText(/ends their session/i);
    await page.locator("#modal-confirm-btn").click();

    // …and confirming retries WITH the override, in one step.
    await expect.poll(() => forcedUrl, { timeout: 10000 }).not.toBeNull();
    expect(forcedUrl, "the override is what the second confirmation sends").toContain("force=1");
    await page.unroute("**/api/admin/participants/*");
  });

  test("v7.21.21 — the FIRST confirmation already says they are competing, and names it", async ({ page }) => {
    // The admin should not have to confirm a destructive action and be told
    // afterwards that the person is mid-competition. The second dialog reports
    // the server's refusal; this one warns BEFORE the decision, from the list
    // already on screen.
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#admin-participants-body tr").first().waitFor({ state: "visible", timeout: 20000 });

    const target = await page.evaluate(() => {
      const p = (window.S.adminParticipantsData || []).find(u => (u.competitions || []).some(c => c.status === "live"));
      return p ? { id: p.id, names: (p.competitions || []).filter(c => c.status === "live").map(c => c.name) } : null;
    });
    expect(target, "the seed must contain a participant in a LIVE competition").toBeTruthy();

    await page.evaluate(id => { window.deleteParticipant(id); }, target.id);
    const body = page.locator("#modal-body");
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await expect(body, "the first dialog must say they are competing right now").toContainText(/competing right now/i);
    for (const name of target.names) {
      await expect(body, "…and NAME the competition, not just its existence").toContainText(name);
    }
    await expect(body, "…and state what deleting does to it").toContainText(/ends their session/i);
    await expect(body, "…and offer the gentler option").toContainText(/leaves the account intact/i);
    // The ordinary copy is still there — the warning is added, not substituted.
    await expect(body).toContainText(/permanently delete/i);
    await page.locator("#modal-cancel-btn").click();
  });

  test("v7.21.21 — a participant in NO live competition gets no warning", async ({ page }) => {
    // POSITIVE CONTROL. Without it, "the dialog mentions competing" is equally
    // satisfied by copy that always says so — which would train admins to ignore
    // it, the opposite of the point.
    const stamp = Date.now();
    const email = `nolive-${stamp}@company.com`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { csrfToken: ac } = await (await page.request.get("/api/csrf-token")).json();
    await registerPost(page.request, "/api/register", { headers: h(ac), data: {
      firstName: "No", lastName: "Live", nickname: `nolive${stamp}`, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
      password: PARTICIPANT_PASS } });
    await sa.dispose();

    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await narrowPeopleTable(page, email);
    await expect.poll(() => page.locator("#admin-participants-body tr").count(), { timeout: 15000 }).toBe(1);
    const id = await page.evaluate(em => ((window.S.adminParticipantsData || []).find(u => u.email === em) || {}).id, email);
    expect(id, "the control participant is loaded").toBeTruthy();

    await page.evaluate(uid => { window.deleteParticipant(uid); }, id);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    const body = page.locator("#modal-body");
    await expect(body, "the ordinary confirmation still appears").toContainText(/permanently delete/i);
    await expect(body, "…with no competing-right-now warning").not.toContainText(/competing right now/i);
    await page.locator("#modal-cancel-btn").click();
  });

  test("cancelling the second confirmation deletes nothing", async ({ page }) => {
    // The override must be a decision, not a click-through.
    await loginSuperadmin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#admin-participants-body tr").first().waitFor({ state: "visible", timeout: 20000 });

    let forced = false;
    await page.route("**/api/admin/participants/*", async route => {
      const req = route.request();
      if (req.method() !== "DELETE") return route.continue();
      if (req.url().includes("force=1")) { forced = true; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({
        error: "Cannot delete a participant who is actively competing.",
        code: "participant_in_live_competition", competitionId: "c1", competitionName: "Live Cup",
      }) });
    });

    const uid = await page.evaluate(() => (window.S.adminParticipantsData || [])[0]?.id);
    await page.evaluate(id => { window.deleteParticipant(id); }, uid);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    // v8.12.4 — the SECOND dialog is the live-event refusal, asserted, or the
    // cancel below could be pressing the first dialog's button all over again.
    await expect(page.locator("#modal-overlay.open"), "the second dialog names the live event").toContainText("Live Cup", { timeout: 10000 });
    await page.locator("#modal-cancel-btn").click();
    await page.waitForTimeout(1200);
    expect(forced, "cancelling must NOT send the override").toBe(false);
    await page.unroute("**/api/admin/participants/*");
  });
});
