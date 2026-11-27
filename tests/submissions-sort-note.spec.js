// @ts-check
//
// v8.8.12 — THE SUBMISSIONS PAGER TOLD AN ADMIN THEIR DEFAULT VIEW WAS
// PAGE-SCOPED, ON A PANE NOBODY HAD TOUCHED.
//
// `S.subSortCol` is initialised to 'time' descending because that IS the
// server's default ordering — so the note's old gate
// (`subSortCol && totalPages>1 && !_subSortedGlobally`) held on a virgin tab
// with more than one page. `sorted_globally:false` on the default read is a
// PERFORMANCE contract ("the server did not take the sorting path", pinned in
// this same file), not a claim that the rows are only page-locally ordered: the
// branch-capped index walk returns the true global newest-N. So the pager made a
// false claim about correct data — the v7.16.7 defect the note was ADDED to fix,
// with the sides swapped.
//
// The stylesheet had it right the whole time: `.page-scope-note`'s own comment
// says "the note appears only once a different column is chosen and there is
// more than one page". A comment describing an invariant the code does not
// implement (v8.3.34's `_credFails` class).
//
// THE POSITIVE NOTE IS PART OF THE FIX, NOT AN EXTRA. Suppressing the false one
// makes "no note" mean two different things — nothing was clicked, and your sort
// WAS ranked across every match — which is the very ambiguity the note exists to
// remove. Logs has carried both halves since v7.25.0.

const { test, expect } = require("./isolated-test");
const { apiLogin, getSuperadminPass, TEST_DATA_DIR, BASE } = require("./helpers");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const PAGE_SIZE = 30;          // the pane's smallest offered page size

async function loginSuperadmin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: h(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

async function openSubmissions(page) {
  // RBAC sidebar — Submissions has no sidebar item (Audit covers it); the pane keeps its id.
  await page.locator("#admin-page").waitFor({ state: "visible" });
  await page.evaluate(() => window.adminTab(null, "admin-submissions-tab"));
  await page.locator("#admin-submissions-tab").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#admin-submissions-body tr").first().waitFor({ state: "visible", timeout: 25000 });
  // The note lives in the pager, which renders from `adminSubmissionsTotal`.
  await expect.poll(() => page.evaluate(() => window.S?.adminSubmissionsTotal || 0),
    { timeout: 20000 }).toBeGreaterThan(0);
}

/** What the pager currently says about the ordering — '' when it says nothing. */
async function noteText(page) {
  return await page.evaluate(() => {
    const el = document.querySelector("#submissions-pagination .page-scope-note, #submissions-pagination .page-scope-ok");
    return el ? `${el.className}|${el.textContent.trim()}` : "";
  });
}

test.describe("v8.8.12 — the Submissions pager only claims a page-scoped sort when there is one", () => {
  test.slow();

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // MORE THAN ONE PAGE, or every assertion here is vacuous: the note is
      // suppressed on a single page by design, both halves of it. The seeded
      // stream is far short of 30 rows, so this builds a real one through the
      // maintenance-gated history seeder rather than 40 sequential submits.
      const streamTotal = async () =>
        (await (await api.get("/api/admin/submissions?limit=1")).json()).total || 0;

      // Seed in ROUNDS until the stream really spans two pages, rather than
      // guessing a shape for the seeder: how many rows one round produces
      // depends on the seed's own participant and challenge counts, and a first
      // attempt landed on 29 against a threshold of 30.
      for (let round = 0; round < 4 && (await streamTotal()) <= PAGE_SIZE; round++) {
        const tasks = await (await api.get("/api/admin/tasks")).json();
        const pool = tasks.filter(t => t.status === "published" && t.active).map(t => t.id).slice(0, 6);
        expect(pool.length, "the seed must offer some published challenges to draw on").toBeGreaterThan(1);

        const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants || [];
        const eligible = parts.filter(p => (p.role || "participant") === "participant").length;
        expect(eligible, "…and some participants to attribute them to").toBeGreaterThan(1);

        const stamp = `${Date.now().toString(36)}${round}`;
        const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
        const byp = `subnote-${stamp}`;
        try {
          fs.writeFileSync(maintFile, byp);
          const r = await api.post("/api/admin/perf/bulk-seed-history", {
            headers: { ...h(csrf), "x-maintenance-bypass": byp },
            data: {
              competitions: 1,
              participantsPer: Math.min(eligible, 3),
              tasksPer: pool.length,
              taskIds: pool,
              wrongRate: 0.5, hintRate: 0.5, navAwayRate: 0,
            },
          });
          expect(r.status(), `bulk-seed-history: ${r.status()} ${await r.text()}`).toBe(200);
        } finally { try { fs.unlinkSync(maintFile); } catch (_) {} }
      }

      const total = await streamTotal();
      expect(total, "PRECONDITION: the stream must span more than one page").toBeGreaterThan(PAGE_SIZE);
    } finally { await api.dispose(); }
  });

  test("the DEFAULT view says nothing — it is the server's own ordering", async ({ page }) => {
    // The reported defect, driven exactly as an operator meets it: open the tab
    // and look. Nothing is clicked.
    await loginSuperadmin(page);
    await openSubmissions(page);

    // The state that made the old gate fire, asserted rather than assumed — the
    // pane really is on 'time' descending, really has more than one page, and
    // the server really did answer `sorted_globally:false`.
    const st = await page.evaluate(() => ({
      col: window.S.subSortCol, asc: window.S.subSortAsc,
      global: window.S._subSortedGlobally,
      pages: Math.ceil((window.S.adminSubmissionsTotal || 0) / (window.S.subPageSize || 30)),
    }));
    expect(st, `PRECONDITION: ${JSON.stringify(st)}`).toMatchObject({ col: "time", asc: false, global: false });
    expect(st.pages, `PRECONDITION: more than one page — ${JSON.stringify(st)}`).toBeGreaterThan(1);

    expect(await noteText(page), "an untouched pane makes no claim about its ordering").toBe("");
  });

  test("a real sort says it was ranked across EVERY match", async ({ page }) => {
    // Without this, "the note is gone" is equally satisfied by a build that
    // deleted the note — and by one that leaves the admin unable to tell "I
    // clicked nothing" from "my sort covered the whole stream", which is the
    // ambiguity the note exists to remove.
    await loginSuperadmin(page);
    await openSubmissions(page);
    await page.locator("th[data-action='sort-submissions'][data-col='points']").first().click();
    await expect.poll(() => page.evaluate(() => !!window.S._subSortedGlobally), { timeout: 20000 }).toBe(true);

    const note = await noteText(page);
    expect(note, `the positive half is shown — got "${note}"`).toContain("page-scope-ok");
    expect(note, "…and says the ranking covered every match").toContain("Sorted across all matches");
    expect(note, "…and never the page-scoped claim").not.toContain("page-scope-note");
  });

  test("a sort the SERVER could not apply still says 'within this page'", async ({ page }) => {
    // THE ANTI-VACUITY CONTROL, and the case the note is actually for: the
    // server did not order these rows by the column on screen, so this pane did
    // it here, on this page only.
    //
    // Driven by withholding `sorted_globally` from the response — which is one
    // of the two documented reachable shapes (a pre-v6.3.0 array-shaped body;
    // the other is a stale client asking for a retired column). Not state
    // poking: the client's own fallback comment names this exact case.
    await loginSuperadmin(page);
    await page.route("**/api/admin/submissions?**", async route => {
      const res = await route.fetch();
      let body;
      try { body = await res.json(); } catch (_) { return route.fulfill({ response: res }); }
      delete body.sorted_globally;
      await route.fulfill({ response: res, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    });
    await openSubmissions(page);

    // Still nothing on the default ordering — the withheld flag must not
    // resurrect the false claim, because time-descending IS what came back.
    expect(await noteText(page), "the default ordering is still the server's").toBe("");

    await page.locator("th[data-action='sort-submissions'][data-col='points']").first().click();
    await expect.poll(() => noteText(page), { timeout: 20000 }).toContain("page-scope-note");
    expect(await noteText(page), "…and it is the page-scoped wording").toContain("Sorted within this page");
  });

  test("a SINGLE page says nothing either way", async ({ page }) => {
    // Both halves are suppressed when there is only one page: "within this
    // page" is a false alarm and "across all matches" is noise. Driven by the
    // largest page size the pane offers, which swallows the fixture.
    await loginSuperadmin(page);
    await openSubmissions(page);
    await page.locator("select[data-change-action='subs-page-size']").selectOption("500");
    await expect.poll(() => page.evaluate(() => window.S.subPageSize), { timeout: 15000 }).toBe(500);
    await page.locator("th[data-action='sort-submissions'][data-col='points']").first().click();
    await expect.poll(() => page.evaluate(() => !!window.S._subSortedGlobally), { timeout: 20000 }).toBe(true);

    const pages = await page.evaluate(() =>
      Math.ceil((window.S.adminSubmissionsTotal || 0) / (window.S.subPageSize || 30)));
    expect(pages, "PRECONDITION: one page").toBe(1);
    expect(await noteText(page), "one page makes both notes noise").toBe("");
  });
});
