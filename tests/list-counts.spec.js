// @ts-check
//
// v7.20.10 — every search/filter surface says HOW MANY matched.
//
// The defect this locks is a wrong-answer class, not an ergonomic one: a
// filtered list that has become short is indistinguishable from a list that was
// short already, and a truncated list that reports its slice as the whole answer
// is the v7.16.7 unsubscribed bug wearing a count's clothes.
//
// Five things are pinned here, and each is mutation-verified against the named
// source change:
//   1. countText()  — the PURE decision, including the pluraliser that shipped
//                     "addresss" in its first draft.  (mutations a + d)
//   2. the admin tables paint a live count that tracks the query.  (mutation a)
//   3. the unsubscribed list still ADMITS its search covers only what loaded.
//   4. wirePickerFilter paints a count BEFORE the first keystroke. (mutation b)
//   5. an unchanged count is not re-written into the aria-live region, so a
//      15-second poll does not re-announce it.  (mutation c)
//
// v7.20.11 extends it (see the second half of this file): the verb, the two
// PARTICIPANT surfaces that had no count at all, the unconditional unsubscribed
// count, and wirePickerFilter reading `data-search`.
const { test, expect } = require("./isolated-test");
const { narrowEventsTable } = require("./ui-admin-helpers"); // v9.2.5 — the one way to type into the admin search boxes
const { registerPost } = require("./helpers");
const { getSuperadminPass, BASE, apiLogin, freshCtx, gradingHashFor, PARTICIPANT_PASS, codeLogin } = require("./helpers");

// v8.7.5 — resolve an admin tab by its `data-tab-id`, never by its visible
// label: the sidebar's Events tab keeps the id `admin-competitions-tab` (ids are
// identifiers) while the label is copy and moves. Mirrors TAB_SLUG in
// tests/ui-admin-helpers.js.
const _TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions" };
const _tabSel = (n) => `button.admin-nav-item[data-tab-id="admin-${_TAB_SLUG[String(n).toLowerCase()] || String(n).toLowerCase()}-tab"]`;


test.use({ baseURL: BASE });

// Authenticate on the page's BrowserContext (page.request shares its cookie
// jar), so goto("/") loads an already-authenticated app.
//
// It retries EXACTLY ONCE, re-reading the password file, which is the repo's
// own apiLogin('superadmin') convention — and the attempt count is a hard
// constraint, not a style choice. The built-in superadmin password rotates
// GLOBALLY after 10 consecutive failed logins, so a generous retry loop turns
// one stale read into a real rotation that then breaks the NEXT server recycle's
// seed. A 6-attempt version of this helper did exactly that here (the server log
// named it: audit:settings:rotated reason:"brute_force_threshold" attempts:10).
//
// Tolerating a THROW on the first attempt is the one genuine addition: while a
// server is being replaced on this port, DATA_DIR/.superadmin-password is
// briefly absent and getSuperadminPass() itself raises ENOENT, which an
// `if (!r.ok())` shape lets escape as an unexplained crash.
async function loginSuperadmin(page) {
  const post = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: pw },
    });
  };
  let r = null;
  try { r = await post(getSuperadminPass()); } catch (_) { /* ENOENT mid-recycle */ }
  if (r && r.ok()) return;
  await new Promise((res) => setTimeout(res, 400));
  r = await post(getSuperadminPass());
  if (!r.ok()) throw new Error(`superadmin login failed: ${r.status()} ${await r.text()}`);
}

async function openAdmin(page) {
  await loginSuperadmin(page);
  await page.goto("/");
  // v8.3.33 — WAIT FOR THE APP, NOT FOR THE SHELL. The admin nav <button>s are
  // STATIC markup in index.html, so ".admin-nav-item attached" is satisfied at
  // first paint — before boot has resolved who we are. `S.isSuperAdmin` starts
  // false, and for the built-in superadmin boot must await /api/me (401) then
  // /api/admin/me before setting it; `clickTab` then fires el.click() through a
  // still-hidden <li>, `loadAdminSettings` runs with the flag false, hides all
  // three cards, and the pane latches to ZERO HEIGHT for good — one caller, no
  // poll, nothing re-runs it. That is run 48 of the v8.3.32 sweep.
  // `#admin-page` cannot be visible before the flag is set (every one of the four
  // call sites sets it, builds the nav and shows the page in one statement), and
  // it is what ~30 other specs already wait for — this file was the only one in
  // the suite gating on `attached` (the v7.21.25 reuse-the-existing-solution rule).
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

/** Click an admin sidebar item by name and wait for its pane. */
async function clickTab(page, name, paneSlug) {
  const hamburger = page.locator("#admin-mobile-menu-btn");
  if (await hamburger.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await hamburger.click();
  const btn = page.locator(_tabSel(name)).first();
  await btn.waitFor({ state: "attached", timeout: 10000 });
  await btn.evaluate((el) => el.click());
  // v8.3.31 — a pane switch is one synchronous render, so 10 s was not a budget
  // problem; but on a loaded box it can lose that race, and "resolved to hidden"
  // names neither the pane that IS open nor whether the click even registered
  // (seen once in a 60-run sweep). Longer ceiling, and a failure that says which
  // pane won.
  await page.locator(`#admin-${paneSlug}-tab`).waitFor({ state: "visible", timeout: 30000 })
    .catch(async (e) => {
      // v8.3.33 — the ONE observable that separates the two ways this pane can be
      // open-but-zero-height: the cards' computed display against S.isSuperAdmin.
      // `display:none` WITH isSuperAdmin true means the loader ran to completion
      // on a falsy flag and nothing re-ran it (the boot race); cards displayed
      // means the pane is empty for some other reason entirely.
      const dbg = await page.evaluate(() => {
        const g = (id) => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : "(absent)"; };
        const pane = document.getElementById("admin-settings-tab");
        return {
          open: [...document.querySelectorAll('[id^="admin-"][id$="-tab"]')]
            .filter(el => el.offsetParent !== null).map(el => el.id),
          isSuperAdmin: window.S ? window.S.isSuperAdmin : "(no S)",
          cards: { platform: g("platform-name-card"), cxone: g("cxone-card"), unsub: g("unsubscribe-card") },
          cxoneStatus: (document.getElementById("cxone-status") || {}).textContent || "",
          paneHeight: pane ? Math.round(pane.getBoundingClientRect().height) : -1,
          toast: (document.querySelector("#toast-stack") || {}).textContent || "",
        };
      }).catch(() => null);
      throw new Error(`#admin-${paneSlug}-tab never became visible — ${JSON.stringify(dbg)} — ${e.message}`);
    });
}

// ────────────────────────────────────────────────────────────────────────────
// 1. countText() — the pure decision.
//
// Driven through window because core/main.js boot() spreads every
// ui/list-controls.js export onto window (_ns35 in the Object.assign), which is
// the established way this suite unit-tests a browser-side pure function. The
// namespace assignment is the FIRST statement of boot(), so an anonymous page
// load is enough — no auth, no admin panel.
// ────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.10 — countText (the pure decision)", () => {
  test("states the size, the match, the zero case and every honesty qualifier", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.countText === "function", null, { timeout: 30000 });

    const got = await page.evaluate(() => {
      const f = window.countText;
      return {
        // NOT FILTERED — state the size rather than going blank.
        unfiltered: f({ matched: 12, total: 12, filtered: false, noun: "participant" }),
        // MATCHES — both numbers; "3 match" leaves you wondering three of how many.
        matches: f({ matched: 3, total: 12, filtered: true, noun: "participant" }),
        // ZERO — the case an operator most needs, said in words.
        zero: f({ matched: 0, total: 12, filtered: true, noun: "participant" }),
        // total:null — a server-side search knows what MATCHED, not what exists.
        // It must invent no denominator.
        noTotal: f({ matched: 3, total: null, filtered: true, noun: "participant" }),
        singular: f({ matched: 1, total: 1, filtered: false, noun: "participant" }),
        // loadedOf — the count describes a server-capped slice and MUST admit it.
        loadedOf: f({ matched: 3, total: 12, filtered: true, noun: "address", loadedOf: 1000 }),
        loadedOfZero: f({ matched: 0, total: 12, filtered: true, noun: "address", loadedOf: 1000 }),
        // approximate — a floor (the logs' scan budget), so "N+", not a figure
        // that reads as exact.
        approximate: f({ matched: 200, total: null, filtered: true, noun: "entry", approximate: true }),
        // Pluralisation. A naive noun+"s" shipped "addresss" in the first draft.
        pluralAddress: f({ matched: 12, total: 12, filtered: false, noun: "address" }),
        pluralEntry: f({ matched: 12, total: 12, filtered: false, noun: "entry" }),
        pluralMatch: f({ matched: 12, total: 12, filtered: false, noun: "match" }),
        // An explicit nounPlural still wins, for anything irregular.
        explicitPlural: f({ matched: 2, total: 2, filtered: false, noun: "person", nounPlural: "people" }),
      };
    });

    expect(got.unfiltered).toBe("12 participants");
    expect(got.matches).toBe("3 of 12 participants match");
    expect(got.zero).toBe("No participants match");
    expect(got.noTotal).toBe("3 participants match");
    expect(got.singular).toBe("1 participant");
    expect(got.loadedOf).toBe("3 of 12 addresses match (of 1000 loaded)");
    expect(got.loadedOfZero).toBe("No addresses match the 1000 loaded");
    expect(got.approximate).toBe("200+ entries match");
    expect(got.pluralAddress).toBe("12 addresses");
    expect(got.pluralEntry).toBe("12 entries");
    expect(got.pluralMatch).toBe("12 matches");
    expect(got.explicitPlural).toBe("2 people");

    // Nothing here may be satisfied by an emitter that returns "" — assert that
    // explicitly, because every expectation above is an equality against a
    // non-empty string and a reader should not have to work that out.
    for (const [k, v] of Object.entries(got)) expect(v, `countText case ${k}`).not.toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. The admin tables show a live count that tracks the query.
//
// Three surfaces, three different callers of setListCount (competitions-admin,
// challenges-admin, participants-admin). Each is checked unfiltered → narrowed
// → zero, because a count that only ever paints the unfiltered size would pass
// a "is it non-empty" check while telling the operator nothing.
//
// The counts are asserted by SHAPE (a regex) plus the arithmetic relation
// matched < total, not by a hard-coded pair of numbers: the tables are polled
// and the worker DB is freshly seeded per file, but hard-coding a total here
// would break the moment the seed gains a row without saying anything true
// about the feature.
// ────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.10 — the admin tables count what matched", () => {
  const SURFACES = [
    // zeroWording:false — DEFECT, see the dedicated test at the end of this
    // describe. renderAdminCompetitions() returns early when the filter matches
    // nothing, BEFORE it reaches setListCount. The flag is static per surface
    // and the missing case is covered by its own test rather than skipped, so
    // this is not a guard that can switch a check off.
    { tab: "Events", pane: "competitions", search: "#comp-search", count: "#comp-search-count", noun: "events", hit: "Live", zeroWording: false },
    { tab: "Challenges", pane: "tasks", search: "#task-search", count: "#task-search-count", noun: "challenges", hit: "hard1", zeroWording: true },
    { tab: "Participants", pane: "participants", search: "#participants-search", count: "#participants-search-count", noun: "participants", hit: "alice", zeroWording: true },
  ];

  for (const s of SURFACES) {
    test(`${s.tab}: unfiltered size → "N of M ${s.noun} match"${s.zeroWording ? " → the zero wording" : ""}`, async ({ page }) => {
      await openAdmin(page);
      await clickTab(page, s.tab, s.pane);

      const count = page.locator(s.count);
      await expect(count).toBeVisible();

      // Before any typing the count is already there. v7.20.11 — it may legitimately
      // read "N of M … shown" rather than a bare "N": the Competitions tab defaults
      // its status chips to live+upcoming, so the list arrives narrowed and a count
      // that ignored the chips would overstate what is on screen. "shown" (not
      // "match") is the verb, because nobody has typed anything.
      await expect(count).toHaveText(new RegExp(`^(\\d+ ${s.noun}|\\d+ of \\d+ ${s.noun} shown)$`), { timeout: 15000 });
      // The TOTAL is the denominator when the list arrives chip-narrowed
      // ("2 of 3 events shown"), otherwise the single leading number.
      const _t = (await count.textContent()).trim();
      const _of = _t.match(/^(\d+) of (\d+)/);
      const total = parseInt(_of ? _of[2] : _t, 10);
      expect(total, "the seeded table must have rows for this test to mean anything").toBeGreaterThan(1);

      // Narrowed: both numbers, and the matched side genuinely smaller.
      await page.fill(s.search, s.hit);
      await expect(count).toHaveText(new RegExp(`^\\d+ of \\d+ ${s.noun} match(es)?$`), { timeout: 15000 });
      const m = (await count.textContent()).match(/^(\d+) of (\d+)/);
      expect(parseInt(m[1], 10), "the query must actually narrow the list").toBeLessThan(parseInt(m[2], 10));
      expect(parseInt(m[1], 10)).toBeGreaterThan(0);
      expect(parseInt(m[2], 10)).toBe(total);

      // Zero: said in words. An empty list with no message is the one shape
      // that looks like a bug.
      if (s.zeroWording) {
        await page.fill(s.search, "zzz-no-such-row-zzz");
        await expect(count).toHaveText(`No ${s.noun} match`, { timeout: 15000 });
      }
    });
  }

  // v7.20.11 — this was pinned with test.fail() as a KNOWN DEFECT of the
  // v7.20.10 change: renderAdminCompetitions() returned before its setListCount
  // call when the filter matched nothing, so a zero-match query left the
  // PREVIOUS query's number in an aria-live region beside a table that said "No
  // competitions match the current search." Two elements, two answers, and the
  // stale one was the one a screen reader announced. The call was hoisted above
  // the early return; this now asserts the fix rather than the defect.
  test("Competitions: the zero-match count is painted, not left stale", async ({ page }) => {
    await openAdmin(page);
    await clickTab(page, "Events", "competitions");
    const count = page.locator("#comp-search-count");
    // Positive control — a real narrowing first, so "No … match" cannot pass on
    // a count that never updates at all.
    await narrowEventsTable(page, "Live");
    await expect(count).toHaveText(/^\d+ of \d+ events match(es)?$/, { timeout: 15000 });
    await narrowEventsTable(page, "zzz-no-such-row-zzz");
    await expect(page.locator("#admin-comp-body")).toContainText("No events match the current search.");
    await expect(count).toHaveText("No events match", { timeout: 15000 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. The count does not lie about a truncated list.
//
// v7.16.7 fixed `total: rows.length` reporting the post-LIMIT slice as the whole
// table; v7.20.7 added the search over what was loaded. Neither may be undone by
// a count that presents the loaded slice as the answer.
//
// The payload is INTERCEPTED rather than seeded: `truncated` needs >1000 rows,
// and the v7.20.7 lesson is that this tab issues its own fetch, so anything
// injected via evaluate() is raced away by the response that follows.
// ────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.10 — a truncated list still admits it", () => {
  test("the unsubscribed search says it covers only the loaded addresses", async ({ page }) => {
    await page.route("**/api/admin/unsubscribed", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entries: [
            { email: "keeper@example.com", reason: "bounce", unsubscribed_at: new Date().toISOString() },
            { email: "other@example.com", reason: "manual", unsubscribed_at: new Date().toISOString() },
          ],
          shown: 2, total: 1500, truncated: true, limit: 1000,
        }),
      });
    });

    await openAdmin(page);
    await clickTab(page, "Settings", "settings");
    await require("./ui-admin-helpers").openSettingsSection(page, "email");   // Settings is two panes; the list is in Email

    const body = page.locator("#unsubscribe-list-body");
    // The truncation notice from v7.16.7 — the real total, not the slice.
    await expect(body).toContainText("most recent of", { timeout: 15000 });
    await expect(body).toContainText("1500");

    await page.fill("#unsub-search", "keeper");
    // v7.20.11 — the count moved onto the shared countText, so the wording is
    // "N address(es) match(es) (of M loaded)". Both halves still matter: the
    // plural must be "addresses" (a naive noun+"s" said "addresss"), the verb
    // must agree with the COUNT ("1 address matches"), and "(of M loaded)" is
    // what stops the figure reading as the whole answer.
    await expect(body).toContainText("1 address matches (of 2 loaded)", { timeout: 15000 });
    await expect(body).toContainText("The search covers only the addresses loaded above, not the full list.");
    // Positive control: the truncation notice survives the search, which is the
    // whole point — narrowing what was fetched must not read as narrowing the table.
    await expect(body).toContainText("An address missing from this list may still be unsubscribed.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. The multiselect dialogs count too — and paint it BEFORE the first keystroke.
//
// wirePickerFilter's count materialising only once you type reads as something
// having gone wrong, and "9 groups" is useful on its own. The cheapest
// wirePickerFilter surface is the invite dialog's Add-to-Groups chip list: its
// filter renders past 8 items and 9 groups are one API call each, where the
// group→competitions dialog (gc-filter) would need 9 competitions.
// ────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.10 — the multiselect filter counts", () => {
  test("invite dialog: a count before typing, and it tracks the filter", async ({ page }) => {
    await loginSuperadmin(page);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const h = { "x-csrf-token": csrfToken, "content-type": "application/json" };
    // 9 groups — pickerFilterHtml is only emitted past 8.
    //
    // The name carries a per-run key. Group names are UNIQUE (uq_groups_name_key),
    // so a fixed name 409s on any second pass over the same database and the
    // failure reports as "seeding group 1" rather than as the ordering problem it
    // is — the v7.16.1 lesson about fixed-identity fixtures, which cost a CI round
    // trip when a trusted-network test reused an IP.
    const key = `Zeta${Date.now().toString(36)}`;
    for (let i = 1; i <= 9; i++) {
      const r = await page.request.post("/api/admin/groups", { headers: h, data: { name: `${key} Filter Group ${i}` } });
      expect(r.ok(), `seeding group ${i}`).toBeTruthy();
    }

    await page.goto("/");
    // v8.3.33 — WAIT FOR THE APP, NOT FOR THE SHELL. The admin nav <button>s are
  // STATIC markup in index.html, so ".admin-nav-item attached" is satisfied at
  // first paint — before boot has resolved who we are. `S.isSuperAdmin` starts
  // false, and for the built-in superadmin boot must await /api/me (401) then
  // /api/admin/me before setting it; `clickTab` then fires el.click() through a
  // still-hidden <li>, `loadAdminSettings` runs with the flag false, hides all
  // three cards, and the pane latches to ZERO HEIGHT for good — one caller, no
  // poll, nothing re-runs it. That is run 48 of the v8.3.32 sweep.
  // `#admin-page` cannot be visible before the flag is set (every one of the four
  // call sites sets it, builds the nav and shows the page in one statement), and
  // it is what ~30 other specs already wait for — this file was the only one in
  // the suite gating on `attached` (the v7.21.25 reuse-the-existing-solution rule).
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await clickTab(page, "Participants", "participants");
    await page.locator("#invite-participants-btn").click();

    // The filter itself only exists past the 8-item threshold — assert it, or a
    // build that never renders the filter would make every count assertion
    // below vacuously unreachable rather than failing.
    await expect(page.locator("#invite-group-filter")).toBeVisible({ timeout: 15000 });

    const count = page.locator("#invite-group-filter-count");
    // BEFORE any keystroke: painted at wire time.
    await expect(count).toBeVisible({ timeout: 15000 });
    await expect(count).toHaveText(/^\d+ groups$/);
    const total = parseInt((await count.textContent()).trim(), 10);
    expect(total).toBeGreaterThanOrEqual(9);

    // AFTER a keystroke: it tracks the filter.
    await page.fill("#invite-group-filter", `${key} Filter Group 3`);
    // v7.20.11 — the verb agrees with the COUNT, so a single match reads
    // "1 of N groups matches".
    await expect(count).toHaveText(new RegExp(`^1 of ${total} groups match(es)?$`));
    // And the list really did narrow — otherwise the count above could be a
    // number the filter never consulted.
    await expect(page.locator(".invite-group-pick:visible")).toHaveCount(1);

    await page.fill("#invite-group-filter", "zzz-no-such-group-zzz");
    await expect(count).toHaveText("No groups match");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. An unchanged count is NOT re-written into the live region.
//
// renderAdminCompetitions() and renderParticipants() run on a 15-second poll, so
// an unguarded write would have a screen reader announce the same sentence four
// times a minute. MutationObserver.takeRecords() is read synchronously, so the
// three calls below are observed without an intervening microtask flush.
// ────────────────────────────────────────────────────────────────────────────
test.describe("v7.20.10 — the live region is not re-announced needlessly", () => {
  test("setListCount leaves identical text untouched, and still paints a change", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.setListCount === "function", null, { timeout: 30000 });

    const got = await page.evaluate(() => {
      const el = document.getElementById("comp-search-count");
      if (!el) return { missing: true };
      const opts = { matched: 3, total: 12, filtered: true };
      const first = window.setListCount("comp-search", opts);
      const painted = el.textContent;

      const obs = new MutationObserver(() => {});
      obs.observe(el, { childList: true, characterData: true, subtree: true });

      // Identical options → identical text → nothing may be written.
      const second = window.setListCount("comp-search", { matched: 3, total: 12, filtered: true });
      const recordsAfterIdentical = obs.takeRecords().length;
      const textAfterIdentical = el.textContent;

      // POSITIVE CONTROL. Without it, "no mutation" is equally satisfied by a
      // setListCount that never writes anything at all.
      const third = window.setListCount("comp-search", { matched: 4, total: 12, filtered: true });
      const recordsAfterChange = obs.takeRecords().length;
      const textAfterChange = el.textContent;
      obs.disconnect();

      return { first, painted, second, recordsAfterIdentical, textAfterIdentical, third, recordsAfterChange, textAfterChange };
    });

    expect(got.missing, "#comp-search-count must be static markup in index.html").toBeFalsy();
    // It paints, and returns what it painted.
    expect(got.first).toBe("3 of 12 events match");
    expect(got.painted).toBe(got.first);
    // Identical call: same answer, no write.
    expect(got.second).toBe(got.first);
    expect(got.recordsAfterIdentical, "an identical count must not be re-written into the live region").toBe(0);
    expect(got.textAfterIdentical).toBe(got.first);
    // Positive control: a genuine change DOES write.
    expect(got.third).toBe("4 of 12 events match");
    expect(got.recordsAfterChange, "a changed count must actually be painted").toBeGreaterThan(0);
    expect(got.textAfterChange).toBe(got.third);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// v7.20.11 — the follow-up.
//
// v7.20.10 taught the surfaces to count. Three things were still wrong, and
// two of them are wrong-answer defects rather than wording:
//
//   • the VERB. Several lists arrive filtered before anyone has typed — the
//     Competitions table defaults its chips to live+upcoming, the participant
//     challenge list FORCES Unsolved while a competition is live — and telling
//     that reader "2 of 3 events match" invites them to go looking for a
//     search term that does not exist. `queried` splits "matches" from "shown".
//   • the two PARTICIPANT surfaces had no count at all, so a forced filter that
//     emptied the list rendered a bare "No challenges found." / "No
//     competitions found." — indistinguishable from an empty competition, an
//     empty account, or a load failure.
//   • the unsubscribed count rendered only once a query was typed, which is the
//     very shape countText exists to refuse.
//
// Plus one capability: wirePickerFilter now searches `data-search` as well as
// the visible text, so a card can be found by a field it did not have room to
// render.
// ════════════════════════════════════════════════════════════════════════════

// ── 6. countText: "matches" vs "shown", and a verb that agrees with the count ─
test.describe("v7.20.11 — the verb", () => {
  test("a typed query MATCHES; a default filter is SHOWN; and the verb agrees with the count", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.countText === "function", null, { timeout: 30000 });

    const got = await page.evaluate(() => {
      const f = window.countText;
      return {
        // The same narrowing, said two ways. queried:false is a chip or a
        // default — nobody typed, so nothing "matched".
        shown: f({ matched: 2, total: 3, filtered: true, queried: false, noun: "event" }),
        matched: f({ matched: 2, total: 3, filtered: true, queried: true, noun: "event" }),
        // ZERO is where the distinction earns its keep: "No events match"
        // on a screen with an untouched search box is a lie about why the list
        // is empty. The not-queried wording names the filter instead.
        zeroShown: f({ matched: 0, total: 3, filtered: true, queried: false, noun: "event" }),
        zeroMatched: f({ matched: 0, total: 3, filtered: true, queried: true, noun: "event" }),
        // `queried` DEFAULTS to `filtered`, which is what keeps every v7.20.10
        // caller saying "match" without being touched.
        defaulted: f({ matched: 2, total: 3, filtered: true, noun: "event" }),
        // Verb agreement with the COUNT, not the noun.
        one: f({ matched: 1, total: 12, filtered: true, noun: "participant" }),
        three: f({ matched: 3, total: 12, filtered: true, noun: "participant" }),
        oneNoTotal: f({ matched: 1, total: null, filtered: true, noun: "participant" }),
        // "shown" is invariant — a singular must NOT drag it to "showns".
        oneShown: f({ matched: 1, total: 12, filtered: true, queried: false, noun: "participant" }),
        // approximate is a FLOOR ("200+"), so it can never be singular even
        // when the number happens to be 1 — the verb must stay plural.
        approx: f({ matched: 200, total: null, filtered: true, noun: "entry", approximate: true }),
        approxOne: f({ matched: 1, total: null, filtered: true, noun: "entry", approximate: true }),
      };
    });

    expect(got.shown).toBe("2 of 3 events shown");
    expect(got.matched).toBe("2 of 3 events match");
    expect(got.zeroShown).toBe("No events shown — every event is hidden by the current filter");
    expect(got.zeroMatched).toBe("No events match");
    expect(got.defaulted).toBe("2 of 3 events match");
    expect(got.one).toBe("1 of 12 participants matches");
    expect(got.three).toBe("3 of 12 participants match");
    expect(got.oneNoTotal).toBe("1 participant matches");
    expect(got.oneShown).toBe("1 of 12 participants shown");
    expect(got.approx).toBe("200+ entries match");
    expect(got.approxOne).toBe("1+ entries match");

    // The two wordings must genuinely DIFFER — an implementation that collapsed
    // them would satisfy half the equalities above and this says so directly.
    expect(got.shown).not.toBe(got.matched);
    expect(got.zeroShown).not.toBe(got.zeroMatched);
    for (const [k, v] of Object.entries(got)) expect(v, `countText case ${k}`).not.toBe("");
  });
});

// ── 7. The PARTICIPANT challenge list ────────────────────────────────────────
//
// The most severe fix in the release. loadTasks() FORCES the Unsolved filter on
// every load while the competition is live, so a participant who had solved
// everything got "No challenges found." on the screen they look at most —
// identical to a competition with nothing assigned and to a failed load.
//
// The first test builds its own participant (since v7.21.10); alice, the seed's
// partially-solved participant, is the POSITIVE CONTROL in the next test: a run
// where the filter never applied at all would show a full grid for both, and
// only a pair of tests can tell those apart.
test.describe("v7.20.11 — the participant challenge list counts", () => {
  /** Sign in on the page's own cookie jar so goto("/") loads an authenticated app. */
  async function loginParticipant(page, email) {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" });
    expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy();
    const body = await r.json();
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    return { body, csrf };
  }

  test("a participant who has solved EVERYTHING is told what the filter is hiding, not 'No challenges found.'", async ({ page }) => {
    // v7.21.10 — FULLY SELF-CONTAINED: this test now builds its own competition,
    // its own challenges and its own participant.
    //
    // It used to solve EVERY task in the shared seeded "Test Live" using the
    // seed's `answer-<key>` convention, which made its premise depend on no other
    // spec ever adding a challenge to that competition — and specs do:
    // categories.api.spec.js and code-blocks.api.spec.js both attach tasks to it.
    // Under WORKERS=8 that surfaced as this test flaking with "<foreign title>
    // must actually be solved", because it cannot know a foreign challenge's
    // answer. Two earlier attempts (a self-heal, then a dedicated participant on
    // the shared competition) each fixed a real thing and left this alive; the
    // dependency itself is what had to go. Owning the whole fixture makes the
    // premise true by construction rather than by luck of file ordering.
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `lcsolve-${tag}@company.example`;
    const ANSWER = "solved-it";
    let live, myTasks;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const SH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
      live = (await (await sa.post("/api/admin/competitions", { headers: SH, data: {
        name: `LC Solve ${tag}`,
        start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 240,
      }})).json()).competition;
      expect(live?.id, "own competition created").toBeTruthy();
      myTasks = [];
      for (const n of [1, 2, 3]) {
        const id = (await (await sa.post("/api/admin/tasks", { headers: SH, data: {
          title: `LCS ${tag}-${n}`, description: "<p>d</p>", difficulty: "easy",
          answer_type: "text", correct_answer: ANSWER, status: "published",
        }})).json()).id;
        expect(id, `challenge ${n} created`).toBeTruthy();
        await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: SH, data: { competitionIds: [live.id] } });
        myTasks.push(id);
      }
      expect((await registerPost(sa, "/api/register", { headers: SH, data: {
        firstName: "Lc", lastName: "Solve", nickname: `lc_${tag}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "NYC",
      }})).ok(), "register the dedicated participant").toBeTruthy();
      const u = (await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json())
        .participants.find(p => p.email === email);
      expect(u, "the dedicated participant must be findable").toBeTruthy();
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: SH });
      await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: SH });
      // A SECOND enrollee who never solves. Without them this participant is the
      // only one, so solving everything trips the all-solved AUTO-END — the
      // competition ends, and an ended competition defaults the filter to "all"
      // (participant-tasks.js forces Unsolved only while it is live), which is
      // not the state this test is about. The shared seeded competition hid this
      // because it always had several participants.
      expect((await registerPost(sa, "/api/register", { headers: SH, data: {
        firstName: "Lc", lastName: "Idle", nickname: `lci_${tag}`, email: `lcidle-${tag}@company.example`,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "NYC",
      }})).ok(), "register the non-solving enrollee").toBeTruthy();
      const idle = (await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(`lcidle-${tag}@company.example`)}`)).json())
        .participants.find(p => p.email === `lcidle-${tag}@company.example`);
      expect(idle, "the second enrollee must be findable").toBeTruthy();
      await sa.post(`/api/admin/participants/${idle.id}/verify`, { headers: SH });
      await sa.post(`/api/admin/participants/${idle.id}/approve`, { headers: SH });
      expect((await sa.post("/api/admin/competitions/assign", { headers: SH, data: {
        userIds: [u.id, idle.id], competitionIds: [live.id],
      }})).ok(), "enrol them").toBeTruthy();
    } finally { await sa.dispose(); }

    const { csrf } = await loginParticipant(page, email);
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    expect((await page.request.post("/api/select-competition", { headers: h, data: { competitionId: live.id } })).ok()).toBeTruthy();
    // The identity the BROWSER will boot with — the thing that was wrong when
    // this first flaked. Asserting it turns a mystery into a named failure.
    const me = await (await page.request.get("/api/me")).json();
    expect(me.email, "the browser session must belong to this test's participant").toBe(email);
    expect(!!me.isAdmin, "…and must NOT be an admin session").toBe(false);

    const tasks = await (await page.request.get("/api/tasks")).json();
    expect(tasks.map(t => t.id).sort(),
      "this competition is ours alone — no other spec can add a challenge to it, which is " +
      "exactly what made the shared-competition version of this test flaky"
    ).toEqual([...myTasks].sort());

    // Solve every one. Each submit is ASSERTED correct, so a fixture that stops
    // producing a solved state fails here by name rather than silently making
    // the whole test vacuous.
    for (const t of tasks) {
      const gradingHash = await gradingHashFor(page.request, t.id);
      const r = await page.request.post(`/api/tasks/${t.id}/submit`, {
        headers: h, data: { answer: ANSWER, gradingHash },
      });
      expect(r.ok(), `submit ${t.title}: ${r.status()}`).toBeTruthy();
      expect((await r.json()).correct, `${t.title} must actually be solved`).toBeTruthy();
    }

    await page.goto("/");
    // v7.21.10 — assert the identity the APP booted with, not just the one the
    // request context holds. The captured failure showed a good /api/me payload
    // beside an admin-page DOM, so the session being right is NOT sufficient
    // evidence that the SPA booted right — and every assertion below is about
    // what the SPA rendered. This is the first point at which the observed
    // symptom becomes checkable, so it is where it gets named.
    await page.waitForFunction(() => !!window.S, null, { timeout: 30000 });
    const booted = await page.evaluate(() => ({
      isAdmin: !!window.S.isAdmin,
      isAdminView: !!window.S.isAdminView,
      compId: window.S.competitionId ?? null,
    }));
    expect(booted.isAdmin,
      `the SPA booted an ADMIN view for a participant session (S=${JSON.stringify(booted)}). ` +
      "That is the v7.21.10 flake, and it is a real signal — not a slow selector."
    ).toBe(false);

    const count = page.locator("#task-grid-count");
    const grid = page.locator("#task-grid");
    // v7.21.2 — gate on the tasks VIEW, and re-boot once if it did not come up.
    // ROOT CAUSE (found by adding this gate — it turned an opaque `Received: ""`
    // subtitle timeout into "#tasks-page never got `active`", i.e. the v7.21.1
    // "wrong VIEW, not a slow one" signature): under WORKERS=8 load, boot
    // occasionally routes a participant who selected her competition via the
    // request API straight to the competition PICKER instead of #tasks-page. It
    // is a transient boot race — the DB state is correct (all seeded participants
    // are enrolled in Test Live, so carol solving her share does NOT all-solved-
    // auto-end it), and a completely fresh attempt always succeeded, which is
    // exactly why the test "flaked then passed". A single reload re-runs boot
    // against the same good session and lands on tasks, so a bounded re-boot
    // heals it without masking a product defect.
    const tasksPage = page.locator("#tasks-page");
    try {
      await expect(tasksPage).toHaveClass(/\bactive\b/, { timeout: 15000 });
    } catch {
      // v8.12.4 — a v7.21.3 self-heal used to sit here, re-signing in as the
      // seeded carol if boot had landed on the admin page. It could not run any
      // more (the booted identity is asserted non-admin above), and had it run
      // it would have switched to a participant not enrolled in this test's own
      // event, so every assertion below would have been about somebody else.
      await page.reload();
      try {
        await expect(tasksPage).toHaveClass(/\bactive\b/, { timeout: 20000 });
      } catch {
        // v7.21.3 — a RELOAD does not help, so this is not the transient boot
        // race the first hardening assumed. Two explanations remain live and
        // `Received: "page"` cannot separate them: the SPA routed somewhere
        // else on purpose (picker / ended popup / profile gate), or the tasks
        // view is genuinely stuck. Dump what this browser can actually see so
        // the next occurrence answers itself instead of buying another quiet
        // release — the v7.21.1 rule for a flake that survived a hardening.
        const diag = await page.evaluate(() => ({
          activePages: [...document.querySelectorAll(".page.active")].map(e => e.id),
          visibleOverlays: [...document.querySelectorAll(".picker-overlay,#modal-overlay.open,#profile-gate-overlay")].map(e => e.id || e.className),
          subtitle: document.querySelector("#tasks-subtitle")?.textContent ?? null,
          gridCount: document.querySelector("#task-grid-count")?.textContent ?? null,
          cards: document.querySelectorAll("#task-grid .task-card").length,
        })).catch(e => ({ evaluateFailed: String(e) }));
        const me = await page.request.get("/api/me").then(r => r.json()).catch(e => ({ meFailed: String(e) }));
        throw new Error(
          "boot did not route the selected participant to the tasks view, and a reload did not fix it.\n" +
          `DOM: ${JSON.stringify(diag)}\n` +
          `/api/me: ${JSON.stringify({ email: me.email, nickname: me.nickname, role: me.role, isAdmin: me.isAdmin, isAdminView: me.isAdminView, competitionName: me.competitionName })}`
        );
      }
    }
    // Wait on the SUBTITLE, not on the count: an empty <p> reports as hidden, so
    // a build that painted nothing would fail here with "hidden" and say nothing
    // about the wording. The subtitle proves loadTasks() ran and the forced
    // Unsolved filter has been applied.
    await expect(page.locator("#tasks-subtitle")).toHaveText(`${tasks.length}/${tasks.length} solved`, { timeout: 30000 });

    // THE FIX. Not "No challenges match" — nobody typed anything; the Unsolved
    // filter was forced on by the app itself, and the copy has to say so.
    await expect(count).toHaveText("No challenges shown — every challenge is hidden by the current filter", { timeout: 15000 });
    await expect(grid).toContainText(`${tasks.length} challenges are hidden by it`);
    await expect(grid).toContainText("Choose");
    // The exact string this release exists to remove.
    await expect(grid).not.toContainText("No challenges found.");

    // POSITIVE CONTROL. Without it, every assertion above is equally satisfied
    // by a build whose challenge list is simply broken: clicking All must bring
    // the real challenges back AND move the count to the unfiltered size.
    await page.locator('#solve-filters .filter-btn[data-filter="all"]').click();
    await expect(count).toHaveText(`${tasks.length} challenges`, { timeout: 15000 });
    await expect(grid.locator(".task-card")).toHaveCount(tasks.length);
  });

  test("with challenges still unsolved the grid renders and the count says how many are shown", async ({ page }) => {
    // alice has solved exactly one of the live competition's three challenges,
    // so the forced Unsolved filter leaves a NON-empty list — the ordinary case,
    // which must keep reading "shown" (nobody typed) and must keep rendering.
    // SELECT the competition explicitly, exactly as the sibling test above does.
    // Relying on alice's ambient active_competition_id is what made this flaky:
    // when boot reads a null competitionId it routes to the competition PICKER,
    // not the challenge list, so #tasks-subtitle stays empty for ever and the
    // 30 s wait expires with `Received string: ""` — the observed failure.
    const { body, csrf } = await loginParticipant(page, "alice@acme.com");
    const live = (body.competitions || []).find(c => c.name === "Test Live");
    expect(live, "the seed must provide a live competition").toBeTruthy();
    expect((await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: live.id },
    })).ok(), "select the live competition").toBeTruthy();

    await page.goto("/");
    const count = page.locator("#task-grid-count");
    await expect(page.locator("#tasks-subtitle")).toHaveText(/^\d+\/\d+ solved$/, { timeout: 30000 });
    // Sample the count text and the rendered cards in ONE frame. Reading them as
    // two separate awaits asserts across a gap the 15 s status poll can re-render
    // inside — and the first frame matching the count PATTERN can still predate
    // the solved-state filter, reading "3 of 3". Both showed up as a flake under
    // WORKERS=8 contention and neither reproduces serially, which is the tell for
    // a cross-read race rather than a slow selector.
    let snap = null;
    await expect.poll(async () => {
      snap = await page.evaluate(() => {
        const t = document.querySelector("#task-grid-count")?.textContent || "";
        const m = t.match(/^(\d+) of (\d+) challenges shown$/);
        if (!m) return null;
        return { shown: +m[1], total: +m[2], cards: document.querySelectorAll("#task-grid .task-card").length };
      });
      if (!snap) return "the count has not rendered yet";
      if (snap.cards !== snap.shown) return `count says ${snap.shown} but ${snap.cards} cards are rendered`;
      if (snap.shown === 0) return "no unsolved challenges on screen yet";
      if (snap.shown >= snap.total) return `the Unsolved filter has not applied yet (${snap.shown} of ${snap.total})`;
      return "ok";
    }, { timeout: 20000, message: "a settled, self-consistent challenge grid" }).toBe("ok");
    // Assert the semantics against the captured snapshot — re-reading here would
    // reintroduce exactly the gap the poll just closed.
    expect(snap.shown, "alice must have unsolved challenges left").toBeGreaterThan(0);
    expect(snap.shown, "and solved at least one, or the filter is not applying").toBeLessThan(snap.total);
    // The count is not fiction: it equals the cards actually on screen.
    expect(snap.cards, "the count must equal the cards actually rendered").toBe(snap.shown);
  });
});

// ── 8. The PARTICIPANT competition picker ────────────────────────────────────
//
// The default "Active & Upcoming" chip hides ended competitions, so a
// participant whose events have all finished saw "No events found."
// while /api/my-competitions was returning them. The All button was right there
// and nothing said it would reveal anything.
test.describe("v7.20.11 — the participant competition picker counts", () => {
  test("all-ended: the count blames the filter and the copy points at All", async ({ page }) => {
    // A dedicated participant + a dedicated competition. The seeded participants
    // are all enrolled in the LIVE competition, so none of them can express the
    // all-ended case, and the seeded "Test Ended" competition cannot be assigned
    // into (a naturally-ended, non-revivable comp is refused 400 by design).
    const key = `pk${Date.now().toString(36)}`;
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    try {
      // Created LIVE and ended afterwards — that is the only way to get an
      // enrolled participant on an ended competition.
      const comp = (await (await api.post("/api/admin/competitions", { headers: h, data: {
        name: `Picker ${key}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180,
      }})).json()).competition;
      expect(comp?.id, "competition create").toBeTruthy();
      // v8.3.12 — TWO ended competitions, not one. With exactly one event the
      // sign-in lands the participant INSIDE it (the sole-event landing rule),
      // so the picker is never rendered and this test's subject — the picker's
      // all-ended count and copy — is unreachable. Two keeps the state under
      // test EXACTLY ("every competition is ended") while leaving a choice to
      // make, which is what puts them on the picker.
      const comp2 = (await (await api.post("/api/admin/competitions", { headers: h, data: {
        name: `Picker2 ${key}`, start_time: new Date(Date.now() - 20 * 60_000).toISOString(), duration_minutes: 180,
      }})).json()).competition;
      expect(comp2?.id, "second competition create").toBeTruthy();

      const email = `${key}@acme.com`;
      expect((await registerPost(api, "/api/register", { headers: h, data: {
        firstName: "Pick", lastName: "Er", nickname: `pick_${key}`, email,
        company: "Acme Corp", title: "Engineer", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      }})).ok(), "register").toBeTruthy();

      // v8.2.3 — `?search=` is a NO-OP on this endpoint: the handler never reads
      // it, so this is really "page 1, ordered created_at ASC" — the N OLDEST
      // users — and the participant we have just created is the NEWEST. At
      // limit=50 it was found only because the pool happened to be smaller than
      // that: MEASURED, 42 users with the fixture at position 40, i.e. NINE rows
      // of headroom. Anything that adds ten users ahead of it pushes it onto page
      // 2 and this reads as "the new participant must be findable", which names
      // nothing about pagination. The endpoint's documented cap is 5000 (it
      // clamps there server-side), which is the same repoint v7.22.0 made on the
      // functional-security-b sibling.
      const _list = (await (await api.get(`/api/admin/participants?limit=5000`)).json());
      const found = (_list.participants || []).find(p => p.email === email);
      expect(found, `the new participant must be findable — scanned ${(_list.participants || []).length} of ${_list.total} participants for ${email}`).toBeTruthy();
      await api.post(`/api/admin/participants/${found.id}/verify`, { headers: h });
      await api.post(`/api/admin/participants/${found.id}/approve`, { headers: h });

      expect((await api.post("/api/admin/competitions/assign", { headers: h, data: {
        userIds: [found.id], competitionIds: [comp.id, comp2.id],
      }})).ok(), "assign").toBeTruthy();
      expect((await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: h })).ok(), "end-now").toBeTruthy();
      expect((await api.post(`/api/admin/competitions/${comp2.id}/end-now`, { headers: h })).ok(), "end-now 2").toBeTruthy();

      // Sign in as that participant on the page's own jar.
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      expect((await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" })).ok(), "participant login").toBeTruthy();

      await page.goto("/");
      const count = page.locator("#comp-grid-count");
      const grid = page.locator("#comp-grid");
      // Same reason as the challenge list: wait on something that is non-empty
      // whether or not the count was painted, so a missing count fails on its
      // WORDING rather than on "hidden".
      await expect(grid).not.toBeEmpty({ timeout: 30000 });
      await expect(count).toHaveText("No events shown — every event is hidden by the current filter", { timeout: 15000 });
      // Plural, because the fixture now has two (see the note at the create).
      // The count is asserted as well as the phrase: the copy's whole job is to
      // say how many are hidden, and "already ended" alone would pass on a build
      // that stopped counting.
      await expect(grid).toContainText("2 have already ended");
      await expect(grid).toContainText("All");
      await expect(grid).not.toContainText("No events found.");

      // POSITIVE CONTROL — All really does reveal it, and the count follows.
      await page.locator('#comp-filters .filter-btn[data-filter="all"]').click();
      await expect(count).toHaveText("2 events", { timeout: 15000 });
      await expect(grid.locator(".comp-card, .card")).not.toHaveCount(0);
      await expect(grid).toContainText(`Picker ${key}`);
    } finally {
      await api.dispose();
    }
  });
});

// ── 9. The unsubscribed count is UNCONDITIONAL ───────────────────────────────
//
// It used to render only inside `if(q)`, so the surface that v7.16.7 fixed for
// lying about its size went back to saying nothing at all until you typed. The
// truncation case is covered above; this pins the ordinary one, before any
// keystroke.
test.describe("v7.20.11 — the unsubscribed count is there before you type", () => {
  test("an untruncated list states its size, then tracks the query", async ({ page }) => {
    await page.route("**/api/admin/unsubscribed", async (route) => {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          entries: [
            { email: "keeper@example.com", reason: "bounce", unsubscribed_at: new Date().toISOString() },
            { email: "other@example.com", reason: "manual", unsubscribed_at: new Date().toISOString() },
          ],
          shown: 2, total: 2, truncated: false, limit: 1000,
        }),
      });
    });

    await openAdmin(page);
    await clickTab(page, "Settings", "settings");
    await require("./ui-admin-helpers").openSettingsSection(page, "email");   // Settings is two panes; the list is in Email
    const body = page.locator("#unsubscribe-list-body");
    // BEFORE any keystroke. Nothing is filtered, so it states the size — and it
    // must NOT claim a truncation that did not happen.
    await expect(body).toContainText("2 addresses", { timeout: 15000 });
    await expect(body).not.toContainText("loaded");
    await expect(body).not.toContainText("most recent of");

    // POSITIVE CONTROL — the same node tracks the query, so "2 addresses" above
    // cannot be a static string that never updates.
    await page.fill("#unsub-search", "keeper");
    await expect(body).toContainText("1 of 2 addresses matches", { timeout: 15000 });
  });
});

// ── 10. wirePickerFilter searches data-search too ────────────────────────────
//
// A card often knows more than it shows — a competition carries tags the layout
// had no room for — and typing one of those must find it. The DOM is built by
// hand here (createElement, not innerHTML: the page enforces Trusted Types) so
// the test depends on nothing but the helper's own contract.
test.describe("v7.20.11 — the picker filter searches hidden fields", () => {
  test("an item is found by its data-search value, and the count agrees", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.wirePickerFilter === "function", null, { timeout: 30000 });

    const got = await page.evaluate(() => {
      const root = document.createElement("div");
      const input = document.createElement("input");
      input.type = "search"; input.id = "ds-filter";
      root.appendChild(input);
      const mk = (text, search) => {
        const el = document.createElement("div");
        el.className = "ds-item";
        el.textContent = text;
        if (search) el.dataset.search = search;
        root.appendChild(el);
        return el;
      };
      const alpha = mk("Alpha", null);
      const beta = mk("Beta", "zebra");
      document.body.appendChild(root);

      window.wirePickerFilter(root, "ds-filter", ".ds-item", { noun: "item" });
      const cnt = () => root.querySelector("#ds-filter-count")?.textContent ?? null;
      const type = (v) => { input.value = v; input.dispatchEvent(new Event("input")); };
      const vis = (el) => el.style.display !== "none";

      const beforeCount = cnt();
      // The hidden field.
      type("zebra");
      const hidden = { alpha: vis(alpha), beta: vis(beta), count: cnt() };
      // POSITIVE CONTROL — the VISIBLE text still works, and picks the OTHER
      // item, so "beta is visible" above cannot be a filter that never runs.
      type("alpha");
      const visible = { alpha: vis(alpha), beta: vis(beta), count: cnt() };
      type("");
      const cleared = { alpha: vis(alpha), beta: vis(beta), count: cnt() };
      root.remove();
      return { beforeCount, hidden, visible, cleared };
    });

    // Painted at wire time, before any keystroke (v7.20.10), unfiltered wording.
    expect(got.beforeCount).toBe("2 items");
    // data-search hit: only Beta survives, and the count says so with a verb
    // that agrees with the count (v7.20.11).
    expect(got.hidden).toEqual({ alpha: false, beta: true, count: "1 of 2 items matches" });
    // Visible-text hit: only Alpha.
    expect(got.visible).toEqual({ alpha: true, beta: false, count: "1 of 2 items matches" });
    // Cleared: everything back, unfiltered wording.
    expect(got.cleared).toEqual({ alpha: true, beta: true, count: "2 items" });
  });
});
