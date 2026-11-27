// @ts-check
//
// v7.17.2 — Phase 3 of the long-list remediation: the four remaining surfaces
// that presented an unbounded list with no way to search, sort or page it.
//
//   • the Groups tab table          — no controls at all
//   • the import participant picker — search only, and select-all IGNORED it
//   • the analytics competition picker — the longest picker, no search
//   • the group-members dialog      — the candidates half had controls, the
//                                     members half had none
//
// The import select-all case is the one genuine correctness fix here rather
// than an ergonomics one, so it is asserted against the built request body.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { getSuperadminPass, BASE, codeLogin } = require("./helpers");
const { openAnalyticsTab, openCompCreateForm, narrowGroupsTable, narrowEventsTable, openRowEventEdit } = require("./ui-admin-helpers"); // v8.1.0 — one analytics entry point; v8.2.0 — one create entry point; v9.2.4 — one way into the Groups search

test.use({ baseURL: BASE });

async function adminPage(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const login = (pw) => page.request.post("/api/login", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { email: "superadmin", password: pw },
  });
  let r = await login(getSuperadminPass());
  // The built-in superadmin password rotates GLOBALLY after 10 consecutive
  // failed logins, so a lockout test elsewhere in the suite can invalidate the
  // one we just read off disk. The server writes the new password BEFORE
  // responding, so a single re-read recovers — this is the same retry
  // helpers.apiLogin has, which a hand-rolled login here was missing.
  if (!r.ok()) r = await login(getSuperadminPass());
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  // Login REGENERATES the session (fixation defence), so the token used to log
  // in is dead for every request after it — re-read it or every seeding call
  // 403s with csrf_invalid.
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

test.describe("Groups tab list controls (v7.17.2)", () => {
  test("search narrows, sort reorders, and paging never invents or drops a row", async ({ page }) => {
    const csrf = await adminPage(page);
    const t = Date.now();
    // Distinct member counts so the numeric sort has something to order by; a
    // fixture where every row is identical makes a comparator test vacuous
    // (exactly the trap the v7.15.0 participant-sort lock fell into).
    const names = [`P3zeta ${t}`, `P3alpha ${t}`, `P3mike ${t}`];
    for (const name of names) {
      const res = await page.request.post("/api/admin/groups", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { name },
      });
      expect(res.ok(), `create ${name}: ${res.status()}`).toBeTruthy();
    }

    await page.locator("button[data-tab-id='admin-groups-tab']").click();
    await page.locator("#groups-tbody tr").first().waitFor({ state: "visible", timeout: 10000 });

    // 1. Search narrows to exactly the seeded three.
    await narrowGroupsTable(page, `P3zeta ${t}`);
    await expect(page.locator("#groups-tbody tr")).toHaveCount(1);
    await expect(page.locator("#groups-tbody tr").first()).toContainText(`P3zeta ${t}`);

    // 2. Sort by name, both directions, over the seeded set.
    await narrowGroupsTable(page, String(t));
    await expect(page.locator("#groups-tbody tr")).toHaveCount(3);
    const namesNow = async () => page.locator("#groups-tbody tr td:first-child").allTextContents();

    await page.locator("th[data-action='groups-sort'][data-col='name']").click();
    const asc = await namesNow();
    expect(asc, "ascending by name").toEqual([...asc].sort((a, b) => a.localeCompare(b)));
    expect(asc[0]).toContain("P3alpha");

    await page.locator("th[data-action='groups-sort'][data-col='name']").click();
    const desc = await namesNow();
    expect(desc, "a second click reverses it").toEqual([...asc].reverse());
    await expect(page.locator("th[data-action='groups-sort'][data-col='name']")).toHaveAttribute("aria-sort", "descending");

    // 3. Page size 30 → the seeded 3 fit on one page; assert the bar reports
    //    the filtered count, not the whole table.
    await expect(page.locator("#groups-pagination .page-info")).toContainText("3 of");
  });

  test("a half-typed search term survives the reload that follows a group mutation", async ({ page }) => {
    // The reason the chrome is static markup rather than part of the rendered
    // string. Renaming a group calls loadAdminGroups(), which re-renders rows;
    // if the search box were re-emitted it would lose the operator's text.
    const csrf = await adminPage(page);
    const t = Date.now();
    const mk = async (name) => (await (await page.request.post("/api/admin/groups", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { name },
    })).json()).group.id;
    const gid = await mk(`P3keep ${t}`);

    await page.locator("button[data-tab-id='admin-groups-tab']").click();
    await page.locator("#groups-tbody tr").first().waitFor({ state: "visible", timeout: 10000 });
    await narrowGroupsTable(page, `P3keep ${t}`);
    await expect(page.locator("#groups-tbody tr")).toHaveCount(1);

    // Drive the same code path a rename does, then confirm the term is intact
    // and still applied (count still 1, not the whole table).
    await page.evaluate(() => window.loadAdminGroups());
    await expect(page.locator("#groups-search")).toHaveValue(`P3keep ${t}`);
    await expect(page.locator("#groups-tbody tr")).toHaveCount(1);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });

  test("v9.2.4: narrowGroupsTable leaves no re-render pending, so a row pressed after it cannot be replaced mid-press", async ({ page }) => {
    // The flake this holds (phase3-ui, main CI, 21 Nov 2026): typing re-renders
    // every row 160 ms later, a press straddling that render gets no click, and
    // the Members dialog never opened. Did the table re-render within one
    // debounce of now? A page timer started now with a timeout of at least the
    // search box's 160 ms runs after every timer of that page started earlier
    // with an equal or shorter timeout (HTML timer ordering), so a render the
    // typing left pending lands inside the window: this answers without a race.
    const csrf = await adminPage(page);
    const t = Date.now();
    const res = await page.request.post("/api/admin/groups", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { name: `P3settle ${t}` } });
    expect(res.ok(), `create: ${res.status()}`).toBeTruthy();
    const gid = (await res.json()).group.id;
    // The tab's first load is held back, so typing at once would land before that
    // load renders: the helper must wait for the load as well as for the
    // typing's own render (a load landing after the typing re-renders the rows).
    let held = false, released = false;
    await page.route("**/api/admin/groups", async (route) => {
      if (!held && route.request().method() === "GET") { held = true; await new Promise((r) => setTimeout(r, 1500)); released = true; }
      await route.continue();
    });
    await page.locator("button[data-tab-id='admin-groups-tab']").click();
    const rendersWithinOneDebounce = (typeFirst) => page.evaluate((typeFirst) => new Promise((resolve) => {
      const tb = document.getElementById("groups-tbody");
      let n = 0;
      const mo = new MutationObserver((ms) => { n += ms.length; });
      mo.observe(tb, { childList: true });
      if (typeFirst) {
        const box = document.getElementById("groups-search");
        box.value = typeFirst;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setTimeout(() => { mo.disconnect(); resolve(n); }, 250);
    }), typeFirst);

    await narrowGroupsTable(page, `P3settle ${t}`);
    expect(held, "PRECONDITION: the tab's first load was held back").toBe(true);
    expect(released, "the helper waited for the tab's first load, not only for the typing's render").toBe(true);
    expect(await rendersWithinOneDebounce(null), "no re-render is left pending once the helper returns").toBe(0);
    await expect(page.locator(`button[data-action='group-manage-members'][data-group-id='${gid}']`)).toBeVisible();
    // CONTROL: the same window does see the render that typing leaves pending.
    expect(await rendersWithinOneDebounce("P3settle"), "CONTROL: a render typing leaves pending is seen").toBeGreaterThan(0);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });
});

test.describe("Import picker: select-all is scoped to the search (v7.17.2)", () => {
  test("searching then ticking select-all imports ONLY the matches", async ({ page }) => {
    await adminPage(page);
    await page.waitForFunction(() => typeof window.showParticipantSelectionStep === "function", { timeout: 20000 });

    // The defect: select-all walked the whole file and ignored the filter, so an
    // operator who searched "acme" and ticked the header box wrote every row in
    // the file to the users table while only the Acme rows were on screen.
    //
    // Asserting on S._importParticipantsSelected would be weaker but adequate
    // here — the set IS what the request is built from — so assert the request
    // body instead and keep the proof end-to-end.
    let sent = null;
    await page.route("**/api/admin/import/participants", async (route) => {
      sent = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ conflicts: [], imported: 0, overwritten: 0, skipped: 0 }),
      });
    });

    await page.evaluate(() => {
      // importParticipantsFile() stashes the payload on S before calling this,
      // and the renderer reads it from there — mirror that here.
      const data = {
        type: "hackarena-participants",
        participants: [
          { first_name: "Ann", last_name: "Acme", nickname: "annacme", email: "ann@acme.test", tags: [] },
          { first_name: "Bo", last_name: "Acme", nickname: "boacme", email: "bo@acme.test", tags: [] },
          { first_name: "Cy", last_name: "Other", nickname: "cyother", email: "cy@other.test", tags: [] },
          { first_name: "Di", last_name: "Other", nickname: "diother", email: "di@other.test", tags: [] },
        ],
      };
      window.S._importParticipantsData = data;
      window.showParticipantSelectionStep(data);
    });
    await page.locator("#import-select-overlay").waitFor({ state: "visible", timeout: 5000 });

    // Start from a clear selection so "select all" is the only thing that picks.
    const allBox = page.locator("[data-change-action='toggle-all-import-participants']");
    await allBox.uncheck();
    await expect(page.locator("#import-p-count")).toContainText("0 of 4");

    await page.locator("#import-p-search").fill("acme");
    await expect(page.locator("#import-p-rows tr")).toHaveCount(2);
    await allBox.check();

    // Two selected, not four — and specifically the two on screen.
    await expect(page.locator("#import-p-count")).toContainText("2 of 4");

    await page.locator("[data-action='import-conflict-check']").click();
    // The route posts {data:{...participants}} — a dry run first, then the real
    // import. Either carries the same participant set, which is the subject here.
    await expect.poll(() => (sent && sent.data ? sent.data.participants.length : null), { timeout: 10000 }).toBe(2);
    const emails = sent.data.participants.map((p) => p.email).sort();
    expect(emails, "only the searched-for rows are imported").toEqual(["ann@acme.test", "bo@acme.test"]);
  });

  test("clearing select-all under a search leaves the hidden rows selected", async ({ page }) => {
    // The other direction, and the one that would silently DROP people: if
    // unchecking cleared the whole file, an operator narrowing to fix one group
    // would deselect everyone else without seeing it happen.
    await adminPage(page);
    await page.waitForFunction(() => typeof window.showParticipantSelectionStep === "function", { timeout: 20000 });
    await page.evaluate(() => {
      // importParticipantsFile() stashes the payload on S before calling this,
      // and the renderer reads it from there — mirror that here.
      const data = {
        type: "hackarena-participants",
        participants: [
          { first_name: "Ann", last_name: "Acme", nickname: "annacme2", email: "ann2@acme.test", tags: [] },
          { first_name: "Cy", last_name: "Other", nickname: "cyother2", email: "cy2@other.test", tags: [] },
          { first_name: "Di", last_name: "Other", nickname: "diother2", email: "di2@other.test", tags: [] },
        ],
      };
      window.S._importParticipantsData = data;
      window.showParticipantSelectionStep(data);
    });
    await page.locator("#import-select-overlay").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#import-p-count")).toContainText("3 of 3");

    await page.locator("#import-p-search").fill("acme");
    await page.locator("[data-change-action='toggle-all-import-participants']").uncheck();
    // Only the one Acme row was dropped; the two hidden rows are untouched.
    await expect(page.locator("#import-p-count")).toContainText("2 of 3");
  });

  test("the header checkbox reflects the FILTERED set, not the whole file", async ({ page }) => {
    await adminPage(page);
    await page.waitForFunction(() => typeof window.showParticipantSelectionStep === "function", { timeout: 20000 });
    await page.evaluate(() => {
      // importParticipantsFile() stashes the payload on S before calling this,
      // and the renderer reads it from there — mirror that here.
      const data = {
        type: "hackarena-participants",
        participants: [
          { first_name: "Ann", last_name: "Acme", nickname: "annacme3", email: "ann3@acme.test", tags: [] },
          { first_name: "Cy", last_name: "Other", nickname: "cyother3", email: "cy3@other.test", tags: [] },
        ],
      };
      window.S._importParticipantsData = data;
      window.showParticipantSelectionStep(data);
    });
    await page.locator("#import-select-overlay").waitFor({ state: "visible", timeout: 5000 });
    const allBox = page.locator("[data-change-action='toggle-all-import-participants']");

    // Drop the non-matching row → under a search that hides it, the box must
    // read fully-checked, because everything VISIBLE is selected.
    await page.locator("#import-p-rows input[data-change-action='toggle-import-participant']").nth(1).uncheck();
    await expect(allBox).not.toBeChecked();
    await page.locator("#import-p-search").fill("acme");
    await expect(allBox).toBeChecked();
    await expect(allBox).toHaveJSProperty("indeterminate", false);
  });
});

test.describe("Analytics competition picker search (v7.17.2)", () => {
  test("typing filters the card grid and reports an empty result", async ({ page }) => {
    const csrf = await adminPage(page);
    const t = Date.now();
    const name = `P3An ${t}`;
    const res = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 60 },
    });
    expect(res.ok(), `create comp: ${res.status()}`).toBeTruthy();
    const compId = (await res.json()).competition.id;

    await openAnalyticsTab(page);
    // The competition picker only exists in competition scope — global scope has
    // no competition to pick.
    await page.locator("[data-action='analytics-set-scope'][data-value='competition']").click();
    await page.locator("[data-action='analytics-open-comp-picker']").click();
    await page.locator("#analytics-comp-search").waitFor({ state: "visible", timeout: 10000 });

    const visibleCards = () => page.locator("#analytics-comp-grid .picker-card:visible");
    const before = await visibleCards().count();
    expect(before, "the grid has cards to filter").toBeGreaterThan(0);

    await page.locator("#analytics-comp-search").fill(name);
    await expect(visibleCards()).toHaveCount(1);
    await expect(visibleCards().first()).toContainText(name);

    // A miss says so rather than showing a blank grid. v7.20.11 — the picker
    // moved onto the shared wirePickerFilter, so the empty node is its derived
    // `<inputId>-empty` rather than the hand-rolled `#analytics-comp-none`.
    await page.locator("#analytics-comp-search").fill("zzz_no_such_comp_zzz");
    await expect(visibleCards()).toHaveCount(0);
    await expect(page.locator("#analytics-comp-search-empty")).toBeVisible();

    // Recovering from a miss restores the full grid.
    await page.locator("#analytics-comp-search").fill("");
    await expect(visibleCards()).toHaveCount(before);
    await expect(page.locator("#analytics-comp-search-empty")).toHaveCount(0);

    await page.request.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
  });
});

test.describe("Group-members dialog: the members half (v7.17.2)", () => {
  test("members search + page, and the candidates half is unaffected", async ({ page }) => {
    const csrf = await adminPage(page);
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();

    // 26 members — one more than MEMBER_PAGE_SIZE, so the pager must appear.
    // Top up from the pool rather than registering 26 from scratch: each
    // registration costs a bcrypt hash, and the members half does not care
    // whether a member is verified or approved.
    const NEED = 26;
    const poolOf = async () => (await (await page.request.get("/api/admin/participants?limit=5000")).json()).participants || [];
    let pool = await poolOf();
    for (let i = pool.length; i < NEED; i++) {
      const reg = await registerPost(page.request, "/api/register", {
        headers: H,
        data: {
          firstName: "Mem", lastName: `Num${i}`, nickname: `p3m${i}x${t}`,
          email: `p3m${i}x${t}@corp.test`, password: "Passw0rd!23",
          company: "Corp", title: "Eng", country: "US", timezone: "UTC",
        },
      });
      expect(reg.ok(), `seed member ${i}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    }
    pool = await poolOf();
    expect(pool.length, "need at least 26 participants to page the members half").toBeGreaterThanOrEqual(NEED);
    const ids = pool.slice(0, NEED).map((p) => p.id);
    const targetNick = pool[6].nickname;   // an arbitrary member to search for

    const created = await page.request.post("/api/admin/groups", { headers: H, data: { name: `P3Big ${t}`, userIds: ids } });
    expect(created.ok(), `create group: ${created.status()} ${await created.text()}`).toBeTruthy();
    const gid = (await created.json()).group.id;
    // Guard the fixture: if the group did not actually take 26 members the pager
    // would never render and every assertion below would hold vacuously.
    const seeded = (await (await page.request.get(`/api/admin/groups/${gid}/picker?limit=1`)).json()).members.length;
    expect(seeded, "the fixture group must hold 26 members for the pager to exist").toBe(NEED);

    await page.locator("button[data-tab-id='admin-groups-tab']").click();
    await narrowGroupsTable(page, `P3Big ${t}`);
    await page.locator(`button[data-action='group-manage-members'][data-group-id='${gid}']`).click();
    await page.locator("#gm-member-search").waitFor({ state: "visible", timeout: 10000 });

    // Page 1 of 2 — 25 of 26 rows, and the pager says so.
    await expect(page.locator("[data-rm]")).toHaveCount(25);
    await expect(page.locator("#gm-m-prev")).toBeDisabled();
    await page.locator("#gm-m-next").click();
    await expect(page.locator("[data-rm]")).toHaveCount(1);
    await expect(page.locator("#gm-m-next")).toBeDisabled();

    // Search collapses to the one match and resets to page 1.
    await page.locator("#gm-member-search").fill(targetNick);
    await expect(page.locator("[data-rm]")).toHaveCount(1);
    await expect(page.locator("#gm-m-prev")).toHaveCount(0); // pager gone: one page

    // The candidates half still works — this dialog's two halves are separate
    // lists and the new client-side controls must not have touched the
    // server-paginated one.
    await expect(page.locator("#gm-search")).toBeVisible();
    await page.locator("#gm-search").fill("zzz_no_match_zzz");
    await expect(page.locator("#gm-candidates")).toContainText("No matching participants");

    // A miss in the members half says so rather than reading as an empty group.
    await page.locator("#gm-member-search").fill("zzz_no_member_zzz");
    await expect(page.locator("#gm-member-search")).toHaveValue("zzz_no_member_zzz");
    await expect(page.locator("[data-rm]")).toHaveCount(0);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v7.20.10 — the dialog swallowed keystrokes and shifted the caret left.
//
// render() used to setSafeHtml the WHOLE card, search inputs included,
// re-emitting `value="${search}"` from the variable captured when the 200 ms
// debounce fired. Every character typed during the debounce AND the picker round
// trip therefore landed in an input that was about to be replaced, and was
// overwritten. The caret was restored from an offset read BEFORE the rebuild, so
// against the now-shorter value the browser clamped it and the cursor jumped
// left — after which the remaining keys landed in the wrong place. Two reported
// symptoms, one cause.
//
// WHY .fill() CANNOT SEE THIS, and why two existing tests in this file did not.
// fill() sets the value atomically and fires ONE input event, so there is never a
// second keystroke racing an in-flight render. Reproducing the defect needs
// (a) real per-key events via pressSequentially / keyboard.type, spaced WIDER
// than the 200 ms debounce so a fetch is genuinely in flight while later keys
// arrive, and (b) a picker response slow enough that the render lands mid-typing
// rather than between two keys. Both are supplied deliberately below; with a
// ~10 ms local response the buggy code repaints faster than a human types and
// looks fine, which is exactly how it shipped.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.10 — the group Members dialog does not eat keystrokes", () => {
  const KEY_MS = 300;            // > the 200 ms #gm-search debounce, so it fires mid-word
  const PICKER_LATENCY_MS = 500; // a render then lands while the admin is still typing

  /**
   * Give every picker response a fixed, realistic latency. This is not a
   * contrivance to make a test pass: the defect is a race between a network
   * round trip and a typist, and on loopback the round trip always wins. Pinning
   * the latency makes the race deterministic in BOTH directions — the fixed
   * build never loses a character, the reverted build always does.
   */
  async function slowPicker(page, ms = PICKER_LATENCY_MS) {
    await page.route(/\/api\/admin\/groups\/[^/]+\/picker/, async (route) => {
      await new Promise((r) => setTimeout(r, ms));
      await route.continue();
    });
  }

  const poolOf = async (page) =>
    (await (await page.request.get("/api/admin/participants?limit=5000")).json()).participants || [];

  /**
   * Return at least `need` ids that are NOT the seeded @acme.com participants,
   * registering more if the pool is short. alice/bob/carol are excluded on
   * purpose: keeping them OUT of the fixture group is what leaves them available
   * as CANDIDATES, which is what the #gm-search assertions search for.
   *
   * The count that matters is the ELIGIBLE one, not the size of the whole
   * table — topping the table up to N leaves N-3 usable ids, which is how the
   * first draft of this seeded a 3-member group and asserted 6.
   */
  async function poolIds(page, H, need, tag) {
    const eligible = async () =>
      (await poolOf(page)).filter((p) => !/@acme\.com$/.test(p.email)).map((p) => p.id);
    let ids = await eligible();
    for (let i = ids.length; i < need; i++) {
      const reg = await registerPost(page.request, "/api/register", {
        headers: H,
        data: {
          firstName: "Mem", lastName: `N${i}`, nickname: `k${tag}${i}`,
          email: `k${tag}${i}@corp.test`, password: "Passw0rd!23",
          company: "Corp", title: "Eng", country: "US", timezone: "UTC",
        },
      });
      expect(reg.ok(), `seed pool ${i}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    }
    ids = await eligible();
    expect(ids.length, `pool must hold ${need} non-seed participants`).toBeGreaterThanOrEqual(need);
    return ids;
  }

  async function register(page, H, first, nick, email) {
    const r = await registerPost(page.request, "/api/register", {
      headers: H,
      data: {
        firstName: first, lastName: "Target", nickname: nick, email,
        password: "Passw0rd!23", company: "Corp", title: "Eng", country: "US", timezone: "UTC",
      },
    });
    expect(r.ok(), `register ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await poolOf(page)).find((p) => p.email === email).id;
  }

  async function makeGroup(page, H, name, userIds) {
    const r = await page.request.post("/api/admin/groups", { headers: H, data: { name, userIds } });
    expect(r.ok(), `create group: ${r.status()} ${await r.text()}`).toBeTruthy();
    const gid = (await r.json()).group.id;
    const got = (await (await page.request.get(`/api/admin/groups/${gid}/picker?limit=1`)).json()).members.length;
    expect(got, "the fixture group must actually hold its members").toBe(userIds.length);
    return gid;
  }

  async function openMembers(page, gid, name) {
    await page.locator("button[data-tab-id='admin-groups-tab']").click();
    await page.locator("#groups-tbody tr").first().waitFor({ state: "visible", timeout: 10000 });
    // v7.17.2 registry rule: narrow the paginated table before looking a row up
    // — and v9.2.4: only once it has re-rendered, as a press straddling that
    // render opens nothing (this test's flake on main CI, 21 Nov 2026).
    await narrowGroupsTable(page, name);
    const btn = page.locator(`button[data-action='group-manage-members'][data-group-id='${gid}']`);
    await expect(btn).toBeVisible();
    await btn.click();
    // #gm-search exists in both the fixed and the reverted build; waiting for a
    // member row proves the first picker response has landed and been rendered,
    // so nothing below races the dialog's own initial load.
    await expect(page.locator("#gm-search")).toBeVisible();
    await expect(page.locator("[data-rm]").first()).toBeVisible({ timeout: 15000 });
  }

  test("typing across the debounce + fetch window keeps EVERY character", async ({ page }) => {
    const csrf = await adminPage(page);
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const gid = await makeGroup(page, H, `P3kx ${t}`, (await poolIds(page, H, 4, `x${t}`)).slice(0, 3));

    await slowPicker(page);
    await openMembers(page, gid, `P3kx ${t}`);

    // alice_s / alice@acme.com is seeded and is NOT in this group, so she is a
    // candidate. Five real keystrokes, each wider apart than the debounce.
    await page.locator("#gm-search").pressSequentially("alice", { delay: KEY_MS });
    // Outlive every request the typing scheduled (last debounce + latency).
    await page.waitForTimeout(KEY_MS * 3 + PICKER_LATENCY_MS + 1000);

    // THE ASSERTION. Reverted, the input reads "alie"/"alce"/similar: an
    // in-flight render repaints it from a `search` that lags what was typed, the
    // caret is clamped left, and the remaining keys append to the mutilated value.
    await expect(page.locator("#gm-search")).toHaveValue("alice");

    // POSITIVE CONTROL — without this the test is satisfied by a dialog whose
    // search does nothing at all (an inert input trivially "keeps every
    // character"). The query must actually have reached the server and repainted
    // the candidates half.
    await expect(page.locator("#gm-candidates")).toContainText("alice@acme.com");
    await expect(page.locator("#gm-candidates label")).toHaveCount(1);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });

  test("a caret placed mid-string stays put — each character lands where it was typed", async ({ page }) => {
    const csrf = await adminPage(page);
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const gid = await makeGroup(page, H, `P3kc ${t}`, (await poolIds(page, H, 4, `c${t}`)).slice(0, 3));

    await slowPicker(page);
    await openMembers(page, gid, `P3kc ${t}`);

    // Establish a value the normal way, and let its fetch settle.
    await page.locator("#gm-search").fill("acme");
    await expect(page.locator("#gm-candidates")).toContainText("alice@acme.com", { timeout: 15000 });

    // Caret between "ac" and "me", then four characters typed AT it.
    await page.locator("#gm-search").evaluate((el) => { el.focus(); el.setSelectionRange(2, 2); });
    await page.keyboard.type("1234", { delay: KEY_MS });
    await page.waitForTimeout(KEY_MS * 3 + PICKER_LATENCY_MS + 1000);

    // Reverted, a render lands after the 3rd key, repaints the box from the
    // shorter `search`, and the browser clamps the caret — so the 4th key lands
    // past the "m" and the value comes out "ac12m4e". The value IS the record of
    // where the caret was for each keystroke, which is why it is asserted here.
    await expect(page.locator("#gm-search")).toHaveValue("ac1234me");
    expect(
      await page.locator("#gm-search").evaluate((el) => el.selectionStart),
      "the caret sits immediately after the four typed characters",
    ).toBe(6);

    // POSITIVE CONTROL — the debounce + fetch pipeline really ran across the
    // typing; "ac1234me" matches nobody, and the count says so.
    await expect(page.locator("#gm-search-count")).toHaveText(/No participants match/i);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });

  test("the MEMBER-side search keeps its keystrokes and stays wired to the list", async ({ page }) => {
    const csrf = await adminPage(page);
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const zulu = await register(page, H, "Zulu", `zulu${t}`, `zulu${t}@corp.test`);
    const ids = (await poolIds(page, H, 6, `m${t}`)).filter((id) => id !== zulu).slice(0, 5);
    const gid = await makeGroup(page, H, `P3km ${t}`, [...ids, zulu]);

    await slowPicker(page);
    await openMembers(page, gid, `P3km ${t}`);
    await expect(page.locator("[data-rm]")).toHaveCount(6);

    // The members half is filtered client-side, so it has no debounce — but it
    // lives in the same card and was replaced by exactly the same setSafeHtml.
    await page.locator("#gm-member-search").pressSequentially("zulu", { delay: KEY_MS });
    await page.waitForTimeout(500);

    await expect(page.locator("#gm-member-search")).toHaveValue("zulu");
    // POSITIVE CONTROL — the filter is applied, not merely the text retained.
    await expect(page.locator("[data-rm]")).toHaveCount(1);
    await expect(page.locator("#gm-members")).toContainText(`zulu${t}@corp.test`);
    await expect(page.locator("#gm-member-search-count")).toHaveText(/1 of 6 members match/i);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });

  test("#gm-member-search does not vanish when a Remove drops the count below one page", async ({ page }) => {
    const csrf = await adminPage(page);
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    // 26 = MEMBER_PAGE_SIZE + 1, i.e. exactly astride the old visibility
    // condition (allMembers.length > 25 || memberSearch). One Remove crosses it.
    const ids = (await poolIds(page, H, 26, `v${t}`)).slice(0, 26);
    expect(ids.length, "need 26 non-seed participants to straddle MEMBER_PAGE_SIZE").toBe(26);
    const gid = await makeGroup(page, H, `P3kv ${t}`, ids);

    await openMembers(page, gid, `P3kv ${t}`);
    await expect(page.locator("#gm-member-search")).toBeVisible();
    await expect(page.locator("#gm-m-next")).toBeVisible();   // 26 members = 2 pages

    await page.locator("[data-rm]").first().click();
    // POSITIVE CONTROL — the removal landed and the members half re-rendered:
    // 25 members fit on one page, so the pager is gone. Without it, "the input
    // is still there" is satisfied by nothing having happened at all. The pager
    // is used rather than the member-count text because the pager exists in BOTH
    // builds, so the assertion below fails on the vanishing input rather than on
    // an element id the fix introduced.
    await expect(page.locator("#gm-m-next")).toHaveCount(0, { timeout: 15000 });

    // Reverted, the input was conditional on the member count and disappeared
    // here — under the operator's hands, mid-session.
    await expect(page.locator("#gm-member-search")).toBeVisible();
    await expect(page.locator("#gm-member-count")).toContainText("25 member(s)");
    await page.locator("#gm-member-search").fill("zzz_no_such_member_zzz");
    await expect(page.locator("[data-rm]")).toHaveCount(0);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });

  test("a slow picker response cannot overwrite a newer one", async ({ page }) => {
    const csrf = await adminPage(page);
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const gid = await makeGroup(page, H, `P3ks ${t}`, (await poolIds(page, H, 4, `s${t}`)).slice(0, 3));
    // Registered AFTER the group, so both are candidates rather than members.
    const slowTok = `zalpha${t}`, fastTok = `zbeta${t}`;
    await register(page, H, "Alpha", slowTok, `${slowTok}@corp.test`);
    await register(page, H, "Beta", fastTok, `${fastTok}@corp.test`);

    let slowRequests = 0;
    await page.route(/\/api\/admin\/groups\/[^/]+\/picker/, async (route) => {
      if (route.request().url().includes(`search=${slowTok}`)) {
        slowRequests++;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });
    await openMembers(page, gid, `P3ks ${t}`);

    // POSITIVE CONTROL — the slow query DOES match somebody and DOES render.
    // Without it, "alpha is not on screen at the end" passes vacuously against a
    // token that never matched anything.
    await page.locator("#gm-search").fill(slowTok);
    // toContainText alone would be VACUOUS here and was, on the first draft: the
    // unfiltered candidate list already contains alpha, so it passed before the
    // debounce had even fired a request — the counter below is what caught it.
    // Requiring the list to have NARROWED to one row can only hold once the
    // slow, server-filtered response has landed and been rendered.
    await expect(page.locator("#gm-candidates label")).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#gm-candidates")).toContainText(`${slowTok}@corp.test`);
    // Park on a query that matches NOBODY before the race. Clearing the box
    // instead would list every candidate — alpha included — and the closing
    // "alpha is not on screen" assertion would then be unfalsifiable.
    await page.locator("#gm-search").fill("zznobody_zz");
    await expect(page.locator("#gm-candidates")).toContainText("No matching participants", { timeout: 15000 });

    // The race: the slow query is issued first and is still in flight when the
    // faster, NEWER one resolves.
    await page.locator("#gm-search").fill(slowTok);
    await page.waitForTimeout(400);            // its debounce has fired; the fetch is out
    await page.locator("#gm-search").fill(fastTok);
    await expect(page.locator("#gm-candidates")).toContainText(`${fastTok}@corp.test`, { timeout: 15000 });
    await page.waitForTimeout(2500);           // outlive the slow response

    expect(slowRequests, "the slow request was actually issued twice (control + race)").toBe(2);
    // Without the pickerSeq guard the late body is assigned unconditionally and
    // the admin is left looking at a query they had already typed past.
    await expect(page.locator("#gm-candidates")).toContainText(`${fastTok}@corp.test`);
    await expect(page.locator("#gm-candidates")).not.toContainText(`${slowTok}@corp.test`);
    await expect(page.locator("#gm-search")).toHaveValue(fastTok);

    await page.request.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v7.20.11 — the analytics pickers move onto the SHARED filter.
//
// The report: the "Pick a competition" dialog showed no match count and found
// nothing when you typed a tag. Both analytics pickers were hand-rolled
// near-copies of `wirePickerFilter`, and each had lost something in the copying:
//
//   • the COMPETITION picker matched the card's textContent — but the card
//     rendered no tags at all, so a tag was unfindable in principle, and the
//     dialog reported no count, so a narrow search and a short list looked
//     identical;
//   • the CHALLENGE picker matched only `.picker-card-name`, i.e. the TITLE, so
//     the DIFFICULTY and TAGS printed on the card right in front of the operator
//     were both unsearchable, it reported no count, and a query that matched
//     nothing produced a silently blank grid with no message at all.
//
// A note on where the count node comes from, because it is not where it looks:
// `countHtml('analytics-comp-search', …)` in the picker head is REDUNDANT.
// `wirePickerFilter` creates `#<inputId>-count` itself when it cannot find one,
// and takes the noun from its own options rather than the node's `data-noun` —
// so deleting the head's `countHtml(...)` changes nothing an operator or a test
// can observe. These tests therefore assert the count's TEXT, which is produced
// by `wirePickerFilter` either way, rather than the presence of a particular
// element declared in the markup.
//
// Two match paths now exist and the tests separate them deliberately: a card's
// own visible TEXT, and its `data-search` attribute for what the layout had no
// room to print. A tag inside the three the card renders matches either way, so
// asserting only that one would pass with `data-search` deleted — every tag test
// below therefore also drives a tag the card does NOT render, which only
// `data-search` can find.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.11 — the analytics pickers search everything the record has", () => {
  // Date.now() alone is not a unique key when one test seeds twice: the two
  // calls can land in the same millisecond, and two fixtures sharing a tag would
  // make a "narrows to exactly one card" assertion fail for a reason that has
  // nothing to do with the filter.
  let _seedN = 0;
  const _seedKey = () => `${Date.now()}${++_seedN}`;

  /** Seed a competition and hang `tags` off it. Returns {id, name, tags}. */
  async function seedTaggedComp(page, csrf, label, tagCount) {
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = _seedKey();
    const name = `${label} ${t}`;
    const res = await page.request.post("/api/admin/competitions", {
      headers: H,
      data: { name, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
    });
    expect(res.ok(), `create comp: ${res.status()}`).toBeTruthy();
    const id = (await res.json()).competition.id;
    // The server lowercases every tag, so the fixture is lowercase to begin with
    // — otherwise the assertion would be about case folding rather than about
    // whether the tag is reachable at all.
    const tags = Array.from({ length: tagCount }, (_, i) => `p3t${i}x${t}`);
    for (const tag of tags) {
      const r = await page.request.post(`/api/admin/competitions/${id}/tags`, { headers: H, data: { tag } });
      expect(r.ok(), `tag ${tag}: ${r.status()}`).toBeTruthy();
    }
    return { id, name, tags };
  }

  async function openCompPicker(page) {
    await openAnalyticsTab(page);
    // The competition picker only exists in competition scope.
    await page.locator("[data-action='analytics-set-scope'][data-value='competition']").click();
    await page.locator("[data-action='analytics-open-comp-picker']").click();
    await page.locator("#analytics-comp-search").waitFor({ state: "visible", timeout: 10000 });
  }

  test("a competition is findable BY TAG — including a tag the card had no room to print", async ({ page }) => {
    const csrf = await adminPage(page);
    // Four tags: the card prints the first three, so the fourth exists ONLY in
    // `data-search`. That is the assertion with teeth — a tag within the printed
    // three would match through the card's textContent and would therefore pass
    // against a build with no `data-search` at all.
    const comp = await seedTaggedComp(page, csrf, "P3TagComp", 4);

    await openCompPicker(page);
    const visible = () => page.locator("#analytics-comp-grid .picker-card:visible");
    const card = page.locator(`#analytics-comp-grid .picker-card[data-comp-id="${comp.id}"]`);
    await expect(card).toHaveCount(1);
    const before = await visible().count();
    expect(before, "the grid has cards to filter").toBeGreaterThan(1);

    // POSITIVE CONTROL. If the filter were broken open — every card always shown
    // — each "the seeded card is visible" assertion below would hold for the
    // wrong reason. Searching the NAME must narrow the grid to exactly one, so
    // the tag assertions that follow are known to be running against a filter
    // that really does hide things.
    await page.locator("#analytics-comp-search").fill(comp.name);
    await expect(visible()).toHaveCount(1);
    await expect(visible().first()).toContainText(comp.name);

    // Which tags did the card actually PRINT? Derived from the DOM rather than
    // assumed: the render slices the first three off whatever order the API
    // returns, and hard-coding that order would make this test a lie the day it
    // changes.
    const cardText = ((await card.textContent()) || "").toLowerCase();
    const printed = comp.tags.filter(tg => cardText.includes(tg));
    const unprinted = comp.tags.filter(tg => !cardText.includes(tg));
    expect(printed.length, "the card prints at least one tag (v7.20.11 renders up to three)").toBeGreaterThan(0);
    expect(unprinted.length, "and holds back at least one, which only data-search can reach").toBeGreaterThan(0);

    // A PRINTED tag — the operator can see it, so typing it must work.
    await page.locator("#analytics-comp-search").fill(printed[0]);
    await expect(visible()).toHaveCount(1);
    await expect(visible().first()).toHaveAttribute("data-comp-id", comp.id);

    // An UNPRINTED tag — the record has it, the layout had no room for it, and
    // `data-search` is the only thing that can find it.
    await page.locator("#analytics-comp-search").fill(unprinted[0]);
    await expect(visible()).toHaveCount(1);
    await expect(visible().first()).toHaveAttribute("data-comp-id", comp.id);

    // And the attribute really does carry the FULL set, not a truncated echo of
    // what was printed.
    const ds = (await card.getAttribute("data-search")) || "";
    for (const tg of comp.tags) expect(ds, `data-search carries ${tg}`).toContain(tg);

    await page.request.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("the competition picker reports a count, before the first keystroke and after every one", async ({ page }) => {
    const csrf = await adminPage(page);
    const comp = await seedTaggedComp(page, csrf, "P3CountComp", 1);

    await openCompPicker(page);
    const count = page.locator("#analytics-comp-search-count");
    const visible = () => page.locator("#analytics-comp-grid .picker-card:visible");

    // 1. PRESENT BEFORE TYPING. A count that materialises only once you type
    //    reads as something having gone wrong, and the size of the list is
    //    useful on its own. It states the size and does NOT claim a match.
    await expect(count).toBeVisible();
    const idle = ((await count.textContent()) || "").trim();
    const total = await visible().count();
    expect(idle, `idle count states the list size (was ${JSON.stringify(idle)})`)
      .toBe(`${total} ${total === 1 ? "event" : "events"}`);
    expect(idle, "nothing has been typed, so nothing 'matches'").not.toContain("match");

    // 2. TRACKS THE FILTER, and names BOTH numbers — "1 match" leaves the reader
    //    wondering one of how many. The verb agrees with the COUNT, not the noun.
    await page.locator("#analytics-comp-search").fill(comp.name);
    await expect(visible()).toHaveCount(1);
    await expect(count).toHaveText(`1 of ${total} events matches`);

    // 3. ZERO says so IN WORDS. An empty grid with a silent count is the one
    //    shape that looks like a bug rather than an answer.
    await page.locator("#analytics-comp-search").fill("zzz_no_such_comp_zzz");
    await expect(visible()).toHaveCount(0);
    await expect(count).toHaveText("No events match");

    // 4. And it recovers — a stuck "No events match" over a full grid
    //    would be worse than no count.
    await page.locator("#analytics-comp-search").fill("");
    await expect(visible()).toHaveCount(total);
    await expect(count).toHaveText(idle);

    await page.request.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
  });

  // The challenge picker renders from `S._analyticsTaskCache`, which is the
  // whole of `GET /api/admin/tasks` fetched once when the Analytics tab loads —
  // NOT a set derived from recorded analytics activity. So a challenge only has
  // to exist to appear here; no submissions, hints or competition assignment are
  // needed, and the fixture is correspondingly cheap.
  //
  // ONE CLAIM IN THE RELEASE NOTE IS NOT EXERCISABLE, and it is not the test's
  // fault: `task_number` lives on `competition_tasks`, not on `tasks`, so the
  // top-level `t.task_number` this card reads is `undefined` for every row the
  // endpoint returns. The `#NUM` span therefore never renders and no number
  // reaches `data-search`. Verified against a challenge assigned to a
  // competition as well as an unassigned one. Searching by challenge number is
  // not merely untested here — it does not work, and cannot until the payload
  // carries a number. See the report accompanying this change.
  async function seedTaggedTask(page, csrf, label, difficulty, tagCount) {
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = _seedKey();
    const title = `${label} ${t}`;
    const res = await page.request.post("/api/admin/tasks", {
      headers: H,
      data: { title, difficulty, correct_answer: "p3-answer", status: "published" },
    });
    expect(res.ok(), `create task: ${res.status()}`).toBeTruthy();
    const id = (await res.json()).id;
    const tags = Array.from({ length: tagCount }, (_, i) => `p3k${i}x${t}`);
    for (const tag of tags) {
      const r = await page.request.post(`/api/admin/tasks/${id}/tags`, { headers: H, data: { tag } });
      expect(r.ok(), `tag ${tag}: ${r.status()}`).toBeTruthy();
    }
    return { id, title, tags, difficulty };
  }

  async function openTaskPicker(page) {
    await openAnalyticsTab(page);
    await page.locator("[data-action='analytics-open-task-picker']").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("[data-action='analytics-open-task-picker']").click();
    await page.locator("#analytics-task-search").waitFor({ state: "visible", timeout: 10000 });
  }

  test("a challenge is findable by TAG and by DIFFICULTY, neither of which the old title-only matcher could do", async ({ page }) => {
    const csrf = await adminPage(page);
    // Two challenges of DIFFERENT difficulty. Searching "hard" against a fixture
    // where everything is hard proves nothing — the second row is what makes the
    // difficulty assertion discriminating.
    const hard = await seedTaggedTask(page, csrf, "P3HardTask", "hard", 4);
    const easy = await seedTaggedTask(page, csrf, "P3EasyTask", "easy", 0);

    await openTaskPicker(page);
    const grid = "#analytics-task-grid";
    const visible = () => page.locator(`${grid} .picker-card:visible`);
    const hardCard = page.locator(`${grid} .picker-card[data-task-id="${hard.id}"]`);
    const easyCard = page.locator(`${grid} .picker-card[data-task-id="${easy.id}"]`);
    await expect(hardCard).toHaveCount(1);
    await expect(easyCard).toHaveCount(1);

    // POSITIVE CONTROL — the TITLE is the one field the pre-v7.20.11 matcher
    // did search, so it must still work, and it proves the filter hides things.
    await page.locator("#analytics-task-search").fill(hard.title);
    await expect(visible()).toHaveCount(1);
    await expect(hardCard).toBeVisible();
    await expect(easyCard).toBeHidden();

    const cardText = ((await hardCard.textContent()) || "").toLowerCase();
    const printed = hard.tags.filter(tg => cardText.includes(tg));
    const unprinted = hard.tags.filter(tg => !cardText.includes(tg));
    expect(printed.length, "the card prints tags (up to three)").toBeGreaterThan(0);
    expect(unprinted.length, "and holds one back for data-search").toBeGreaterThan(0);

    // BY A PRINTED TAG — visible on the card, and previously unsearchable
    // because the matcher read `.picker-card-name` alone.
    await page.locator("#analytics-task-search").fill(printed[0]);
    await expect(visible()).toHaveCount(1);
    await expect(hardCard).toBeVisible();

    // BY A TAG THE CARD DOES NOT PRINT — reachable only through data-search.
    await page.locator("#analytics-task-search").fill(unprinted[0]);
    await expect(visible()).toHaveCount(1);
    await expect(hardCard).toBeVisible();

    // BY DIFFICULTY. Asserted as a DIFFERENCE between the two seeded cards, not
    // as an absolute count: other challenges in the worker DB are legitimately
    // hard too, and demanding "exactly one" would make this fixture-fragile
    // rather than correct.
    await page.locator("#analytics-task-search").fill("hard");
    await expect(hardCard).toBeVisible();
    await expect(easyCard).toBeHidden();
    await page.locator("#analytics-task-search").fill("easy");
    await expect(easyCard).toBeVisible();
    await expect(hardCard).toBeHidden();

    // The number, for the record: the card renders none, because the payload
    // carries none. Pinned so that a future payload change that starts shipping
    // one is noticed here rather than silently leaving this claim half-true.
    await expect(page.locator(`${grid} .picker-card .picker-card-num`)).toHaveCount(0);

    for (const id of [hard.id, easy.id]) {
      await page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
    }
  });

  test("the challenge picker reports a count and SAYS when nothing matches", async ({ page }) => {
    const csrf = await adminPage(page);
    const task = await seedTaggedTask(page, csrf, "P3CountTask", "medium", 1);

    await openTaskPicker(page);
    const grid = "#analytics-task-grid";
    const visible = () => page.locator(`${grid} .picker-card:visible`);
    const count = page.locator("#analytics-task-search-count");

    await expect(count).toBeVisible();
    const idle = ((await count.textContent()) || "").trim();
    const total = await visible().count();
    expect(idle).toBe(`${total} ${total === 1 ? "challenge" : "challenges"}`);
    expect(idle, "nothing typed yet, so nothing 'matches'").not.toContain("match");

    await page.locator("#analytics-task-search").fill(task.title);
    await expect(visible()).toHaveCount(1);
    await expect(count).toHaveText(`1 of ${total} challenges matches`);

    // The pre-v7.20.11 picker had NO empty-state node at all: a query matching
    // nothing produced a blank grid and total silence. Both the message and the
    // count must speak.
    await page.locator("#analytics-task-search").fill("zzz_no_such_challenge_zzz");
    await expect(visible()).toHaveCount(0);
    await expect(page.locator("#analytics-task-search-empty")).toBeVisible();
    await expect(page.locator("#analytics-task-search-empty")).toHaveText("No challenges match that search.");
    await expect(count).toHaveText("No challenges match");

    await page.locator("#analytics-task-search").fill("");
    await expect(visible()).toHaveCount(total);
    await expect(page.locator("#analytics-task-search-empty")).toHaveCount(0);
    await expect(count).toHaveText(idle);

    await page.request.delete(`/api/admin/tasks/${task.id}`, { headers: { "x-csrf-token": csrf } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.21.1 (A6) — a REGULAR admin's CxOne values were silently dropped
// when CREATING a competition
// ═══════════════════════════════════════════════════════════════════════════════
// Per-competition CxOne is admin-level by design (v7.13.2 restored that
// deliberately) and the form renders the API-key / group-name fields to EVERY
// admin. But the post-create persistence in saveCompetition() was gated on
// `S.isSuperAdmin`, and that call is the ONLY persistence path for a NEW
// competition: the create POST carries no CxOne fields, and the Save/Remove
// CxOne buttons only render for an EXISTING one. So a regular admin filled the
// fields in, was told "Competition created.", and the values were discarded —
// the competition then quietly using the global defaults they meant to override.
// EDIT was never affected (saveCompCxOne carries no such gate), which is why
// the mutation below is ASYMMETRIC: restoring the gate must fail the regular
// admin's create while the superadmin's identical create still passes.
//
// Every assertion here reads the SERVER's `cxone_configured` / `cxone_has_api_key`
// booleans. The raw key is never on the wire by design (CxOne key discipline),
// so asserting on it would be asserting the wrong thing — and would pass
// vacuously against a build that shipped nothing at all.
test.describe("v7.21.1 (A6) — CxOne fields survive a competition CREATE for a regular admin", () => {
  const { freshCtx, apiLogin, PARTICIPANT_PASS } = require("./helpers");

  // A syntactically real CxOne API key: the server runs decodeCxOneApiKey() on
  // it and 400s anything whose `iss` is not an https Checkmarx IAM realm URL, so
  // a placeholder string would make the PUT fail for a reason unrelated to the
  // fix and the test could never distinguish that from the bug.
  const cxKey = (tenant) => {
    const payload = Buffer.from(JSON.stringify({ iss: `https://iam.checkmarx.net/auth/realms/${tenant}` })).toString("base64url");
    return `hdr.${payload}.sig`;
  };

  /** Mint a verified+approved REGULAR admin and return its login credentials. */
  async function makeRegularAdmin(tag) {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const email = `a6${tag}-${stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" },
      data: {
        firstName: "A", lastName: "Six", nickname: `a6${tag}${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
      },
    });
    expect(reg.ok(), `register regular admin: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    expect(u, "the freshly-registered admin-to-be must be findable").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: h });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: h });
    const roleR = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: h, data: { role: "admin" } });
    expect(roleR.ok(), `promote to admin: ${roleR.status()}`).toBeTruthy();
    return { email, password: PARTICIPANT_PASS, id: u.id };
  }

  /** Log the BROWSER in (not an API context) and land on the admin panel. */
  async function browserLogin(page, email, password) {
    const doPost = async (pw) => {
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
    };
    let r = await doPost(password);
    if (!r.ok()) { await page.waitForTimeout(300); r = await doPost(password); }
    expect(r.ok(), `login ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    // The admin nav renders asynchronously; the Competitions tab is the entry
    // point every test below uses.
    await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().click();
  }

  /**
   * Drive the real New Competition form to completion. `cx` is
   * {key?, group?} — omitted entirely for the blank case, so the form is
   * left exactly as the SPA rendered it rather than being filled with "".
   */
  async function createCompThroughForm(page, name, cx) {
    await openCompCreateForm(page);
    await page.locator("#comp-name").fill(name);
    const start = new Date(Date.now() + 3600_000);
    const pad = (n) => String(n).padStart(2, "0");
    await page.locator("#comp-date").fill(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
    await page.locator("#comp-time").fill(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
    await page.locator("#comp-dur-h").fill("2");

    // The CxOne section renders on the NEW-competition form for every admin —
    // assert that before filling it, or a build that hid the fields from a
    // regular admin would make the rest of this test silently vacuous.
    await expect(page.locator("#comp-cxone-key"),
      "the CxOne override fields render on the CREATE form for this admin").toBeVisible();
    await expect(page.locator("#comp-cxone-group")).toBeVisible();
    // And there is no Save CxOne button yet — which is exactly why the
    // post-create call is the only persistence path for a new competition.
    await expect(page.locator("[data-action='comp-save-cxone']"),
      "a NEW competition has no Save CxOne button, so the create-time call is the only path").toHaveCount(0);

    if (cx) {
      if (cx.key) await page.locator("#comp-cxone-key").fill(cx.key);
      if (cx.group) await page.locator("#comp-cxone-group").fill(cx.group);
    }

    await page.locator('[data-action="comp-save"]').first().click();
    const confirm = page.locator("#modal-overlay");
    await expect(confirm).toContainText("Create Competition?", { timeout: 10000 });
    await confirm.locator("button", { hasText: /^Create$/ }).first().click();
    await expect(page.locator("#comp-name"), "the form closes on a successful create").toBeHidden({ timeout: 15000 });
  }

  /** Read the server's own view of a competition by name. */
  async function compByName(page, name) {
    const list = await (await page.request.get("/api/admin/competitions")).json();
    return list.find(c => c.name === name) || null;
  }

  test("a REGULAR admin's API key + group name are PERSISTED by the create flow", async ({ page }) => {
    const admin = await makeRegularAdmin("ra");
    await browserLogin(page, admin.email, admin.password);

    // Precondition: this really is a regular admin. Without it the test would
    // pass just as happily for a superadmin, i.e. prove nothing about the gate.
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isSuperAdmin, "this test is meaningless unless the actor is a REGULAR admin").toBeFalsy();

    const name = `A6 regular ${Date.now()}`;
    try {
      await createCompThroughForm(page, name, { key: cxKey("a6_regular_tenant"), group: "a6-regular-group" });

      await expect.poll(async () => !!(await compByName(page, name)),
        { timeout: 15000, intervals: [150, 300, 600, 1000] }).toBe(true);
      // The CxOne PUT is a SECOND request that follows the create, so the
      // competition can be listed a beat before its override lands — poll for
      // the thing under test rather than reading once and racing it.
      await expect.poll(async () => (await compByName(page, name))?.cxone_configured ?? null, {
        timeout: 15000, intervals: [150, 300, 600, 1000],
        message: "the regular admin's CxOne override must have been SAVED, not silently dropped",
      }).toBe(true);
      const comp = await compByName(page, name);

      expect(comp, "the competition itself must exist").toBeTruthy();
      // The server's own booleans — the raw key is never shipped, by design.
      expect(comp.cxone_configured,
        "the regular admin's CxOne override must have been SAVED, not silently dropped").toBe(true);
      expect(comp.cxone_has_api_key,
        "and the API KEY specifically — the pre-fix bug dropped both").toBe(true);
      expect(comp.cxone_group_name, "the group name rides the same call").toBe("a6-regular-group");
      // CxOne key discipline: the raw key never reaches the wire.
      expect(Object.prototype.hasOwnProperty.call(comp, "cxone_api_key"),
        "the raw api key must never be shipped").toBe(false);
    } finally {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const c = (await (await sa.get("/api/admin/competitions")).json()).find(x => x.name === name);
      if (c) await sa.delete(`/api/admin/competitions/${c.id}`, { headers: { "x-csrf-token": csrf } });
      await sa.dispose();
    }
  });

  // POSITIVE CONTROL for the mutation. The whole shape of this fix is that the
  // superadmin path ALREADY worked, so a "fix" that merely broke everyone
  // equally (or a test that passes because the create flow is broken for all
  // tiers) has to be distinguishable. Restoring `&& S.isSuperAdmin` must leave
  // THIS test green while the regular-admin one above goes red.
  test("a SUPERADMIN doing exactly the same still works (positive control)", async ({ page }) => {
    await browserLogin(page, "superadmin", getSuperadminPass());
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isSuperAdmin, "the control must genuinely be a superadmin").toBe(true);

    const name = `A6 superadmin ${Date.now()}`;
    try {
      await createCompThroughForm(page, name, { key: cxKey("a6_super_tenant"), group: "a6-super-group" });

      await expect.poll(async () => (await compByName(page, name))?.cxone_configured ?? null,
        { timeout: 15000, intervals: [150, 300, 600, 1000] }).toBe(true);
      const comp = await compByName(page, name);
      expect(comp.cxone_has_api_key).toBe(true);
      expect(comp.cxone_group_name).toBe("a6-super-group");
    } finally {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const c = (await (await sa.get("/api/admin/competitions")).json()).find(x => x.name === name);
      if (c) await sa.delete(`/api/admin/competitions/${c.id}`, { headers: { "x-csrf-token": csrf } });
      await sa.dispose();
    }
  });

  // The fix removed a gate, so the other direction matters too: leaving the
  // fields blank must issue NO CxOne request at all. A spurious PUT would write
  // cxone_group_name=NULL over nothing, emit a cxone_config_changed audit event
  // for a change that never happened, and cost a round trip on every create.
  //
  // The listener carries its own POSITIVE CONTROL: after the blank create it
  // watches the EDIT path's Save CxOne button, which was never affected by this
  // bug and must be seen firing. Without that, "zero requests observed" is
  // equally satisfied by a listener that was never wired up.
  test("blank CxOne fields issue NO CxOne request — and the listener proves it can see one", async ({ page }) => {
    const admin = await makeRegularAdmin("blank");
    await browserLogin(page, admin.email, admin.password);
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isSuperAdmin, "still a regular admin").toBeFalsy();

    const cxCalls = [];
    page.on("request", (req) => {
      if (/\/api\/admin\/competitions\/[^/]+\/cxone$/.test(new URL(req.url()).pathname)) {
        cxCalls.push(`${req.method()} ${new URL(req.url()).pathname}`);
      }
    });

    const name = `A6 blank ${Date.now()}`;
    try {
      await createCompThroughForm(page, name, null);

      await expect.poll(async () => !!(await compByName(page, name)),
        { timeout: 15000, intervals: [150, 300, 600, 1000] }).toBe(true);
      const comp = await compByName(page, name);
      expect(comp.cxone_configured, "nothing was entered, so nothing is configured").toBe(false);
      expect(comp.cxone_has_api_key).toBe(false);

      // Give any stray request a chance to land before declaring none happened.
      await page.waitForTimeout(1000);
      expect(cxCalls, `the create flow must not touch the CxOne endpoint when the fields are blank (saw: ${cxCalls.join(", ")})`).toEqual([]);

      // ── positive control: the listener really does see a CxOne request ──
      // The EDIT surface's Save CxOne button is a path this fix never touched,
      // so it is a clean witness that the instrumentation above is live.
      await page.reload();
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
      await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().click();
      await narrowEventsTable(page, name);
      const row = page.locator(`#admin-comp-body tr:has-text(${JSON.stringify(name)})`);
      await expect(row).toBeVisible({ timeout: 10000 });
      await openRowEventEdit(page, row);
      await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });
      await page.locator("#comp-cxone-group").fill("a6-edit-path-group");
      await page.locator("[data-action='comp-save-cxone']").click();
      await expect.poll(() => cxCalls.length, { timeout: 10000 }).toBeGreaterThan(0);
      expect(cxCalls[0], "the witnessed call is the CxOne PUT").toContain("PUT");
    } finally {
      const { api: sa, csrf } = await apiLogin("superadmin");
      const c = (await (await sa.get("/api/admin/competitions")).json()).find(x => x.name === name);
      if (c) await sa.delete(`/api/admin/competitions/${c.id}`, { headers: { "x-csrf-token": csrf } });
      await sa.dispose();
    }
  });
});
