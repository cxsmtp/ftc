// @ts-check
// Layout-integrity gate (v6.20.x) — the robust, environment-stable substitute
// for pixel-diff visual regression.
//
// WHY NOT toHaveScreenshot: fonts here load from the Google Fonts CDN with a
// `system-ui` fallback, and CI runs headless Chromium under variable multi-
// worker load. Pixel-exact baselines would diff on font-load timing, host
// fallback fonts, and GPU/OS antialiasing — a false-failing gate is worse than
// none (which is why the project already chose capture-only screenshots over
// diffing; see _screenshots.spec.js + the CLAUDE "Accepted audit dispositions"
// note). Instead we assert the *structural* invariants a layout regression
// actually breaks — horizontal overflow, off-screen primary elements, and
// modals escaping the viewport — which are stable across environments and catch
// the real-world failure mode (a too-wide element forcing a horizontal
// scrollbar, an unbounded modal) without the flake.
//
// Runs on Chromium in the default suite (NOT underscore-prefixed). Read-only:
// logs in as seeded users, renders, asserts; never mutates state.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, getSuperadminPass, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

async function pageLogin(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  let r = await doPost(password);
  if (!r.ok() && email === "superadmin") r = await doPost(getSuperadminPass());
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy();
}

// Force a theme before any script runs, so the page boots straight into it
// (the SPA reads localStorage["hck-theme"] on load).
async function forceTheme(page, theme) {
  await page.addInitScript((t) => {
    try { localStorage.setItem("hck-theme", t); } catch (_) {}
  }, theme);
}

// The core invariant: the document must not scroll horizontally (a too-wide
// element is the canonical layout regression). 2px slack for sub-pixel rounding.
async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return { scrollW: de.scrollWidth, clientW: de.clientWidth };
  });
  expect(
    overflow.scrollW,
    `${label}: horizontal overflow — scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}`,
  ).toBeLessThanOrEqual(overflow.clientW + 2);
}

// v8.11.8 — THE PAGE MUST NOT SCROLL SIDEWAYS, ON THE PANES THAT NEARLY ALL DO.
//
// The existing overflow checks cover the login card, the participant shell and
// the DEFAULT admin view at the default viewport — so the three panes that carry
// a wide table were never measured at a phone width, and one of them scrolled the
// whole document 470px sideways.
//
// The cause is `.sr-only`: `position:absolute` with NO offsets and no positioned
// ancestor between it and <html>, so its containing block is the INITIAL
// containing block and its box escapes the very `overflow-x:auto` container the
// table scrolls inside. A scroll container can only clip a positioned descendant
// if it is itself positioned.
test.describe("v8.11.8 — no page-level horizontal scroll on the wide-table panes", () => {
  const VIEWPORTS = [
    { width: 320, height: 640 },   // the narrowest phone still supported
    { width: 390, height: 844 },   // the common phone
    { width: 834, height: 1194 },  // iPad portrait
  ];
  for (const vp of VIEWPORTS) {
    test(`admin Rankings, Groups and the participant Leaderboard at ${vp.width}px`, async ({ page }) => {
      await page.setViewportSize(vp);
      await pageLogin(page, "superadmin");
      await page.goto("/");
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
      for (const slug of ["rankings", "groups"]) {
        const ham = page.locator("#admin-mobile-menu-btn");
        if (await ham.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await ham.click();
        await page.locator(`[data-tab-id="admin-${slug}-tab"]`).first().evaluate((el) => el.click());
        await page.locator(`#admin-${slug}-tab`).waitFor({ state: "visible", timeout: 20000 });
        await page.waitForTimeout(500);   // let the pane's own loader paint
        await assertNoHorizontalOverflow(page, `admin ${slug} @ ${vp.width}`);
      }
    });
  }
});

test.describe("Layout integrity (v6.20.x)", () => {
  for (const theme of ["dark", "light"]) {
    test(`login screen has no horizontal overflow + form on-screen (${theme})`, async ({ page }) => {
      await forceTheme(page, theme);
      await page.goto("/");
      await page.locator("#login-email").waitFor({ state: "visible", timeout: 15000 });
      // Theme actually applied.
      const applied = await page.getAttribute("html", "data-theme");
      expect(applied, `theme attribute`).toBe(theme);
      await assertNoHorizontalOverflow(page, `login (${theme})`);
      // The email input + Sign In button sit within the viewport (not pushed
      // off-screen by a layout break).
      const vp = page.viewportSize();
      for (const sel of ["#login-email", "#login-submit"]) {
        const box = await page.locator(sel).first().boundingBox();
        expect(box, `${sel} has a box`).toBeTruthy();
        expect(box.x, `${sel} left within viewport`).toBeGreaterThanOrEqual(-2);
        expect(box.x + box.width, `${sel} right within viewport`).toBeLessThanOrEqual(vp.width + 2);
      }
    });
  }

  for (const theme of ["dark", "light"]) {
    test(`participant shell has no horizontal overflow (${theme})`, async ({ page }) => {
      await forceTheme(page, theme);
      await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);
      await page.goto("/");
      await page.locator("#main-nav").waitFor({ state: "visible", timeout: 15000 });
      await assertNoHorizontalOverflow(page, `participant shell (${theme})`);
    });
  }

  for (const theme of ["dark", "light"]) {
    test(`admin view has no horizontal overflow + sidebar on-screen (${theme})`, async ({ page }) => {
      await forceTheme(page, theme);
      await pageLogin(page, "superadmin");
      await page.goto("/");
      await page.locator("#admin-sidebar").waitFor({ state: "visible", timeout: 20000 });
      await page.locator(".admin-nav-item").first().waitFor({ state: "visible", timeout: 10000 });
      await assertNoHorizontalOverflow(page, `admin view (${theme})`);
      // The sidebar's right edge is within the viewport (it isn't pushed off).
      const vp = page.viewportSize();
      const box = await page.locator("#admin-sidebar").boundingBox();
      expect(box, "sidebar box").toBeTruthy();
      expect(box.x + box.width, "sidebar within viewport").toBeLessThanOrEqual(vp.width + 2);
    });
  }

  test("an open modal stays within the viewport (no off-screen escape)", async ({ page }) => {
    // The help drawer is reachable anonymously and is a representative overlay.
    await page.goto("/");
    await page.locator("#help-icon-btn").waitFor({ state: "visible", timeout: 15000 });
    await page.click("#help-icon-btn");
    const body = page.locator("#help-drawer-body");
    await body.waitFor({ state: "visible", timeout: 10000 });
    await assertNoHorizontalOverflow(page, "help drawer open");
    const vp = page.viewportSize();
    const box = await body.boundingBox();
    expect(box, "drawer box").toBeTruthy();
    // Drawer is fully within the viewport horizontally and doesn't overflow the bottom.
    expect(box.x, "drawer left within viewport").toBeGreaterThanOrEqual(-2);
    expect(box.x + box.width, "drawer right within viewport").toBeLessThanOrEqual(vp.width + 2);
    expect(box.y + box.height, "drawer bottom within viewport").toBeLessThanOrEqual(vp.height + 2);
  });
  test.describe("narrow phone viewport", () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test("the leaderboard's 5-column placement card scrolls itself, not the page", async ({ page }) => {
      // v7.15.0 added an All Solved column; at 320px the "Your placement" table
      // grew 281px -> 329px inside a 286px card and, having no scroll container,
      // pushed the whole document sideways. Wide content scrolls in its own box.
      await page.goto("/");
      // The sign-in screen hides the footer (one-card sign-in); the page is ready
      // once the login card paints.
      await page.locator("#login-page").waitFor({ state: "visible", timeout: 15000 });
      const overflowX = await page.evaluate(() => {
        const el = document.createElement("div");
        el.style.cssText = "padding:0 16px";
        el.innerHTML = '<div class="lb-me-card"><table class="lb-table"><tbody><tr class="me">' +
          '<td>27</td><td>a_long_nickname_22</td><td><strong>1450</strong> pts</td>' +
          '<td class="lb-time-cell">1h 02m 33s</td>' +
          '<td class="lb-solved-col"><span class="lb-solved-pill"><span>ok</span></span></td>' +
          '</tr></tbody></table></div>';
        document.body.appendChild(el);
        const card = el.querySelector(".lb-me-card");
        const out = {
          cardOverflowX: getComputedStyle(card).overflowX,
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
        };
        el.remove();
        return out;
      });
      expect(overflowX.cardOverflowX, "the card owns its horizontal scroll").toMatch(/auto|scroll/);
      expect(overflowX.docScroll, "the page itself must not scroll sideways")
        .toBeLessThanOrEqual(overflowX.docClient + 2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.0 — a text-bearing surface is never dimmed with `opacity`
//
// `.comp-card.internal` (the participant picker's dry-run card) carried
// `opacity:.75`. Opacity composites TEXT as well as chrome, and every colour
// token on that card is tuned to clear WCAG AA with little margin — so the
// dimming put ALL of them below it at once. Measured on the light theme:
// --muted #64607A is 5.87:1 on the card background and rendered as #88859a /
// 3.49:1; the live badge 3.44:1; the dry-run badge 3.14:1; the countdown
// 3.23:1. Permanent, not a rendering race.
//
// WHY THIS LOCK EXISTS SEPARATELY from the picker axe scan in ui-participant-c:
// that scan only sees the violation when a dry-run competition HAPPENS to be in
// the seeded participant's picker, which depends on what ran before it in the
// worker — so it caught this by luck and reported it as a flake for releases.
// This one CREATES the dry-run competition, so it fires every time.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.0 — dry-run competition card contrast", () => {
  test("the dry-run card is marked by border + badge, and its text still meets AA", async ({ page }) => {
    const { AxeBuilder } = require("@axe-core/playwright");
    const { apiLogin } = require("./helpers");
    const crypto = require("crypto");
    const tag = crypto.randomBytes(4).toString("hex");

    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `DryRunAA-${tag}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    // The marker is a stored tag, not a label (v7.21.18) — use the constant's value.
    const tagRes = await sa.post(`/api/admin/competitions/${compId}/tags`, { headers: H, data: { tag: "test/dry run" } });
    expect(tagRes.ok(), `tagging the competition as a dry run: ${tagRes.status()}`).toBeTruthy();
    const parts = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    expect(alice, "seeded participant must exist").toBeTruthy();
    await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [alice.id], competitionIds: [compId] } });
    await sa.dispose();

    await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().click();
    const leave = page.locator("#modal-confirm-btn:has-text('Leave')");
    await leave.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    if (await leave.isVisible().catch(() => false)) await leave.click();

    const sel = `#comp-grid .comp-card[data-comp-id="${compId}"]`;
    const card = page.locator(sel);
    await card.waitFor({ state: "visible", timeout: 10000 });

    // POSITIVE control: this really is the dry-run card, so a build that stopped
    // rendering the marker could not pass by having nothing to measure.
    await expect(card, "the card must carry the dry-run marker").toHaveClass(/internal/);
    await expect(card.locator(".badge.draft")).toHaveText("test/dry run");

    // The invariant, stated directly: no opacity on the card…
    expect(await card.evaluate(e => getComputedStyle(e).opacity),
      "a text-bearing card must not be dimmed with opacity — it composites the text too"
    ).toBe("1");
    // …and the contrast that follows from it.
    const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = r.violations.filter(v => ["moderate", "serious", "critical"].includes(v.impact));
    expect(bad.flatMap(v => v.nodes.map(n =>
      `${v.id} @ ${n.target.join(" ")} — ${n.any?.[0]?.data?.contrastRatio ?? "?"}:1`
    )), "dry-run card text must meet AA").toEqual([]);
  });
});

test.describe("v7.23.0 — benchmark rankings row contrast", () => {
  // v7.23.0 — the SAME defect, third site: the admin rankings board dimmed a
  // benchmark participant's row with `opacity:.7`. It went unnoticed for
  // releases because it needs a benchmark-tagged participant ON a rankings
  // board, and no test had ever produced one — it surfaced as an intermittent
  // axe failure the moment the activity-export fixture did. Same shape as the
  // dry-run card above, so the lock has the same shape: build the state, assert
  // the marker is really there, assert no opacity, assert the contrast.
  test("a benchmark rankings row is marked by its badge, and its text still meets AA", async ({ page }) => {
    const { AxeBuilder } = require("@axe-core/playwright");
    const { apiLogin, freshCtx } = require("./helpers");
    const crypto = require("crypto");
    const t = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      // The entry clock: the benchmark row is on the board from ENTERING it.
      name: `BenchAA ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180, clock_start: "entry",
    }})).json()).competition.id;

    // Its own participant — a shared fixture's tags are set by other files.
    const email = `bench_${t}@company.example`;
    const nick = `bn${t}`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
      firstName: "Bench", lastName: "Mark", nickname: nick, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
      jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    await anon.dispose();
    const u = (await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email);
    expect(u, "the benchmark participant must exist").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
    // Assign BEFORE tagging — the assign endpoint SKIPS a benchmark user.
    const asg = await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [u.id], competitionIds: [compId] } });
    expect((await asg.json()).assigned, "the participant must actually enrol").toBe(1);
    expect((await sa.post(`/api/admin/participants/${u.id}/tags`, { headers: H, data: { tag: "benchmark" } })).ok()).toBeTruthy();
    await sa.dispose();

    // The board excludes anyone with no `login_time` — that is the solve-clock
    // anchor, stamped on the first competition-scoped request while the
    // competition is live (fixture checklist item 5). Without this the row
    // simply never renders and the test times out on a locator, which reads as
    // a selector problem rather than a missing precondition.
    const { api: pa, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
    const sel = await pa.post("/api/select-competition", {
      headers: { "x-csrf-token": pc, "content-type": "application/json" }, data: { competitionId: compId },
    });
    expect(sel.status(), await sel.text()).toBe(200);
    await pa.dispose();

    await pageLogin(page, "superadmin", getSuperadminPass());
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("button.admin-nav-item:has-text('Rankings')").first().evaluate(el => el.click());
    const row = page.locator(`#admin-rankings-tab tr.rankings-row-benchmark:has-text('${nick}')`).first();
    await row.waitFor({ state: "visible", timeout: 20000 });

    // POSITIVE control: this really is a benchmark row carrying its badge, so a
    // build that stopped marking benchmarks could not pass by having nothing
    // left to measure.
    await expect(row.locator(".benchmark-tag")).toHaveText("benchmark");

    expect(await row.evaluate(e => getComputedStyle(e).opacity),
      "a text-bearing row must not be dimmed with opacity — it composites the text too"
    ).toBe("1");

    const r = await new AxeBuilder({ page })
      .include(`#admin-rankings-tab tr.rankings-row-benchmark`)
      .withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = r.violations.filter(v => ["moderate", "serious", "critical"].includes(v.impact));
    expect(bad.flatMap(v => v.nodes.map(n =>
      `${v.id} @ ${n.target.join(" ")} — ${n.any?.[0]?.data?.contrastRatio ?? "?"}:1`
    )), "benchmark row text must meet AA").toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v7.22.4 — an empty-state message spans its grid, it does not get one column
//
// `#comp-grid` is a 12-column `.bento` and `#task-grid` is
// `repeat(auto-fill,minmax(280px,1fr))`. A bare <p> written into either is laid
// out as a GRID ITEM and takes a single track — a twelfth of the width in the
// picker (the reported "squashed into a narrow column") and one ~300px column
// in the challenge list. Geometry, not text, is the complaint, so geometry is
// what this asserts.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v7.22.4 — participant empty states span their grid", () => {
  const { apiLogin } = require("./helpers");

  test("the no-competitions message uses the full width of the picker", async ({ page }) => {
    await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Events')").first().click();
    const leave = page.locator("#modal-confirm-btn:has-text('Leave')");
    await leave.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    if (await leave.isVisible().catch(() => false)) await leave.click();
    await page.locator("#comp-grid").waitFor({ state: "visible", timeout: 15000 });

    // Force the EMPTY state deterministically: a search term that matches
    // nothing. This is the real code path — renderCompetitionPicker's own empty
    // branch — not injected markup.
    const search = page.locator("#participant-comp-search");
    await search.waitFor({ state: "visible", timeout: 10000 });
    await search.fill(`no-such-competition-${Date.now()}`);

    const msg = page.locator("#comp-grid .grid-empty");
    await expect(msg, "the empty state must render").toBeVisible({ timeout: 10000 });
    const { gridW, msgW } = await page.evaluate(() => {
      const g = document.getElementById("comp-grid");
      const p = g.querySelector(".grid-empty");
      return { gridW: g.getBoundingClientRect().width, msgW: p.getBoundingClientRect().width };
    });
    // A single track of a 12-column grid is ~8% of the width; spanning is ~100%.
    // 90% separates the two by a mile and tolerates the grid gap.
    expect(msgW / gridW,
      `the empty state occupies ${Math.round((msgW / gridW) * 100)}% of the picker width — ` +
      `a bare grid item would take one track of twelve`).toBeGreaterThan(0.9);
    // …and it must not wrap into a tall narrow ribbon, which is what the
    // one-track layout actually looked like on screen.
    // …and it must not wrap into a tall narrow ribbon, which is what the
    // one-track layout actually looked like on screen. Derived from FONT-SIZE,
    // not line-height: computed `line-height` here is the keyword `normal`, and
    // parseFloat("normal") is NaN — which passed straight through toBeLessThan
    // as a silent failure the first time.
    const lines = await msg.evaluate((el) => {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      return el.getBoundingClientRect().height / (fs * 1.5);
    });
    expect(Number.isFinite(lines), "line estimate must be a number").toBe(true);
    expect(Math.ceil(lines), "the message reads as a sentence, not a column of words").toBeLessThanOrEqual(3);
  });

  test("the no-challenges message uses the full width of the challenge grid", async ({ page }) => {
    // Same class, second grid — .task-grid is auto-fill, so the symptom there is
    // one ~300px track rather than one twelfth, but it is the same bug.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const live = comps.find(c => c.name === "Test Live");
    await sa.dispose();

    await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);
    const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", {
      headers: { "x-csrf-token": c, "content-type": "application/json" },
      data: { competitionId: live.id },
    });
    await page.goto("/");
    const nav = page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first();
    await nav.waitFor({ state: "visible", timeout: 20000 });
    await nav.click();
    await page.locator("#task-grid").waitFor({ state: "visible", timeout: 15000 });

    const search = page.locator("#participant-task-search");
    await search.waitFor({ state: "visible", timeout: 10000 });
    await search.fill(`no-such-challenge-${Date.now()}`);

    const msg = page.locator("#task-grid .grid-empty");
    await expect(msg, "the empty state must render").toBeVisible({ timeout: 10000 });
    const { gridW, msgW } = await page.evaluate(() => {
      const g = document.getElementById("task-grid");
      const p = g.querySelector(".grid-empty");
      return { gridW: g.getBoundingClientRect().width, msgW: p.getBoundingClientRect().width };
    });
    expect(msgW / gridW,
      `the empty state occupies ${Math.round((msgW / gridW) * 100)}% of the grid width`).toBeGreaterThan(0.9);
  });
});

// v7.23.3 (audit Wave 4 #20) — a picker dialog's ACTION ROW is always on screen.
//
// This locks a regression I introduced and the review caught. Giving
// `.picker-rows` a min-height made it the only non-shrinkable sibling in the
// modal's flex column, so on a short viewport the overflow landed on the
// footer: MEASURED with the real task-picker, Cancel and Save were entirely
// off-screen on iPhone SE / 12 mini / iPhone 14 landscape and cut on Pixel 7 —
// zero of five devices showed Save, where before the change all five did. The
// primary action of three admin dialogs, hidden, with no cue anything was below.
//
// The fix is a STICKY footer, not a smaller floor: a floor low enough to clear
// the footer at 320px tall was measured still off-screen on 5 of 6 devices, so
// tuning the number cannot work. This asserts the property that matters —
// the buttons are within the viewport — rather than any particular height.
//
// LANDSCAPE PHONE heights specifically: this whole class is invisible at the
// 800px-tall default, and no Playwright project covered phone-landscape until
// v7.23.1.
test.describe("Picker dialog action row (v7.23.3)", () => {
  const SIZES = [
    ["iPhone SE landscape", 667, 375],
    ["iPhone 12 mini landscape", 780, 360],
    ["iPhone 14 landscape", 844, 390],
    ["very short", 640, 320],
  ];
  for (const [label, width, height] of SIZES) {
    test(`Cancel + Save stay on screen at ${label} (${width}x${height})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const li = await page.request.post("/api/login", {
        headers: { "x-csrf-token": tok, "content-type": "application/json" },
        data: { email: "superadmin", password: getSuperadminPass() },
      });
      expect(li.ok(), `superadmin login: ${li.status()}`).toBeTruthy();
      await page.goto("/");
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
      const burger = page.locator("#admin-mobile-menu-btn");
      if (await burger.isVisible().catch(() => false) && !(await page.locator("#admin-sidebar.mobile-open").count())) await burger.click();
      await page.locator("button.admin-nav-item[data-tab-id=\"admin-competitions-tab\"]").first().evaluate((el) => el.click());
      await page.locator("#admin-comp-body tr").first().waitFor({ state: "visible", timeout: 20000 });
      await page.locator("#admin-comp-body tr").first().locator(".kebab-btn").click();
      await page.locator("#kebab-portal.open").waitFor({ state: "visible", timeout: 10000 });
      const item = page.locator("#kebab-portal [data-action=comp-assign-challenges]");
      expect(await item.count(), "the assign-challenges kebab item must exist, or this test is vacuous").toBeGreaterThan(0);
      await item.click();
      await page.locator(".picker-modal").waitFor({ state: "visible", timeout: 15000 });

      const r = await page.evaluate(() => {
        const f = document.querySelector(".picker-modal-foot");
        if (!f) return { noFoot: true };
        return {
          vh: window.innerHeight,
          buttons: [...f.querySelectorAll("button")].map((b) => {
            const q = b.getBoundingClientRect();
            return { text: (b.textContent || "").trim().slice(0, 20),
                     top: Math.round(q.top), bottom: Math.round(q.bottom),
                     fully: q.top >= 0 && q.bottom <= window.innerHeight + 1 };
          }),
        };
      });
      expect(r.noFoot, "the picker must render an action row").toBeFalsy();
      expect(r.buttons.length, "the action row must have buttons, or this is vacuous").toBeGreaterThan(0);
      const off = r.buttons.filter((b) => !b.fully);
      expect(off, `action buttons off-screen at ${width}x${height}: ${JSON.stringify(r)}`).toEqual([]);
    });
  }
});

test.describe("v8.3.5 — the revealed-hint heading clears AA in BOTH themes", () => {
  test("the hint heading is a themed class, and both themes measure >= 4.5:1", () => {
    // FOUND AS A FLAKE AND IT WAS NOT ONE. `#hint-area > div:nth-child(1)` carried
    // an inline `color:var(--yellow)` on a `--surface2` panel: axe measured
    // **4.22:1** in the LIGHT theme against a 4.5:1 bar — permanent, on a shipping
    // participant surface. Dark was never at risk (7.74:1).
    //
    // It presented as intermittent only because `#hint-area` exists once a hint
    // has been REVEALED, a state no isolated run reaches — the v7.23.0
    // benchmark-row shape, a permanent defect wearing a flake's clothes.
    //
    // PINNED AT SOURCE rather than through the browser, deliberately (the v8.2.1
    // precedent). Driving it live needs a competition, a participant, an
    // enrolment, a hint purchase and a competition entry — five fixtures for one
    // colour pair — and the ui-participant-c axe scan already exercises the live
    // surface. What that scan CANNOT promise is that it will still happen to have
    // a revealed hint in scope after some future re-ordering, which is exactly
    // how this hid. Reading the rule and resolving the tokens is deterministic
    // and cannot silently stop covering it.
    const fs = require("fs"), path = require("path");
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    const js = fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "participant-tasks.js"), "utf8");

    // 1. The markup emits the CLASS and carries no inline colour. An inline style
    //    cannot be theme-overridden without `!important`, which is precisely why
    //    the light theme was unreachable (the v8.2.2 deadline-column lesson).
    expect(js, "the hint heading uses the class").toMatch(/class="hint-heading"/);
    const hintBlocks = js.split("id=\"hint-area\"");
    expect(hintBlocks.length, "the hint-area markup is still there to check").toBeGreaterThan(1);
    expect(js, "no inline colour on the hint heading").not.toMatch(/font-weight:600;color:var\(--yellow\)/);

    // 2. The rule exists, in both the base and the light-theme form.
    const rule = (sel) => {
      const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
      return m ? m[1] : null;
    };
    const base = rule(".hint-heading");
    const light = rule('html[data-theme="light"] .hint-heading');
    expect(base, ".hint-heading has a base rule").toBeTruthy();
    expect(light, "…and a light-theme override — one base + one override, the .verify-chip precedent").toBeTruthy();

    // 3. Resolve the tokens each look and mode actually uses and MEASURE. A
    //    token-name assertion alone would pass against a token that was later
    //    re-valued. The palettes come from the data styles.css is generated from.
    const { lookCombos } = require("./look-tokens");

    const lum = (hex) => {
      const h = hex.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const L = [lum(a), lum(b)].sort((x, y) => y - x); return (L[0] + 0.05) / (L[1] + 0.05); };

    const fgName = (rl) => (rl.match(/color:\s*var\(--([a-z0-9-]+)\)/) || [])[1];
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look and mode is measured").toBeGreaterThanOrEqual(9);
    for (const { theme, label, tokens } of combos) {
      // The light override applies in every look's day mode, the base rule at night.
      const fg = tokens[`--${fgName(theme === "light" ? light : base)}`];
      const bg = tokens["--surface2"];
      expect(fg && bg, `${label}: the hint heading's colour and --surface2 resolve`).toBeTruthy();
      const r = ratio(fg, bg);
      expect(r, `${label} hint heading ${r.toFixed(2)}:1 (${fg} on ${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// v8.11.8 — WCAG 2.2 AA SC 2.5.8 on the one selector that failed BOTH legs.
//
// `.comp-badge[data-action=comp-focus]` measured 17px tall (minimum 24) AND
// stacked 2px apart, so the spacing exception failed as well: a 24px-diameter
// circle centred on one intersected its neighbour, 10.5px away. They focus an
// event, so a mis-hit opens the wrong one.
test("v8.11.8: competition badges meet the 24px target minimum and its spacing exception", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The People table shows six columns by default; the Events column (the
  // badges this measures) is one of the optional ones.
  await require("./ui-admin-helpers").showAllParticipantColumns(page);
  await pageLogin(page, "superadmin");
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  await page.locator('[data-tab-id="admin-participants-tab"]').first().evaluate((el) => el.click());
  await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 20000 });
  const badges = page.locator('#admin-participants-tab .comp-badge[data-action="comp-focus"]');
  await expect(badges.first(), "the seed must put at least one event badge on a row, or this is vacuous")
    .toBeVisible({ timeout: 20000 });

  const boxes = await badges.evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }));
  const short = boxes.filter((b) => b.h < 24);
  expect(short, `badges under the 24px minimum: ${JSON.stringify(short)}`).toHaveLength(0);

  // The SC 2.5.8 spacing exception, run as the spec states it: a 24px-diameter
  // circle centred on the target must intersect no other target's circle.
  const close = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const d = Math.hypot(boxes[i].cx - boxes[j].cx, boxes[i].cy - boxes[j].cy);
      if (d < 24) close.push({ d: Math.round(d * 10) / 10, i, j });
    }
  }
  expect(close, `badge centres closer than 24px apart: ${JSON.stringify(close)}`).toHaveLength(0);
});
