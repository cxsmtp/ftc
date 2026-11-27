// @ts-check
//
// v7.23.1 (audit Wave 1) — axe in the DARK theme.
//
// Until now every axe scan in this suite ran in the LIGHT theme, and nobody had
// noticed: playwright.config.js sets no `colorScheme`, Playwright's default is
// `light`, and public/theme-boot.js then resolves `data-theme="light"`. So the
// gate covered exactly one of the two themes the platform ships — and the dark
// one is the DEFAULT for a visitor whose OS is dark.
//
// The consequence was a whole class of live defects. public/styles.css carries
// ~40 `html[data-theme="light"] … {color:var(--badge-*-fg)}` remediation rules
// and, before v7.23.1, ZERO dark equivalents: the light theme had been fixed
// repeatedly against a gate that could see it, while the identical failure in
// dark was never looked at. The first run of this file found 13 nodes across 4
// root causes, worst 2.53:1.
//
// Why a dedicated spec rather than a second Playwright project: a project can
// only filter by FILE, so a dark project over the a11y specs would also re-run
// every non-axe test in them. This scans the same surfaces, states its purpose,
// and runs inside the default `npm test`.
//
// THE THEME ASSERTION IS LOAD-BEARING. A dark sweep that silently ran in light
// would pass for ever and prove nothing — it is precisely how the gap arose. So
// every scan is preceded by a check that --bg really is the dark value.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, getSuperadminPass, codeLogin, appearanceSettled } = require("./helpers");
const { openAnalyticsTab } = require("./ui-admin-helpers"); // v8.1.0 — one analytics entry point
const AxeBuilder = require("@axe-core/playwright").default;

// v8.7.5 — resolve an admin tab by its `data-tab-id`, never by its visible
// label: the sidebar's Events tab keeps the id `admin-competitions-tab` (ids are
// identifiers) while the label is copy and moves. Mirrors TAB_SLUG in
// tests/ui-admin-helpers.js.
const _TAB_SLUG = { challenges: "tasks", events: "competitions", competitions: "competitions", "new event": "templates" };
const _tabSel = (n) => `button.admin-nav-item[data-tab-id="admin-${_TAB_SLUG[String(n).toLowerCase()] || String(n).toLowerCase()}-tab"]`;


test.use({ baseURL: BASE, colorScheme: "dark" });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const GATED = new Set(["moderate", "serious", "critical"]);
// The house look's (Ambient's) night canvas (scripts/theme/looks.js is the
// palette the stylesheet is generated from).
const DARK_BG = require("../scripts/theme/looks").looks.ambient.dark.bg;

async function forceDark(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem("hck-theme", "dark"); } catch (_) {}
  });
}

/** Assert the page really is dark, then scan. Returns gated violations. */
async function scanDark(page, sel, label) {
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  expect(bg.toLowerCase(), `${label}: the sweep must actually be in the DARK theme (--bg was ${bg})`)
    .toBe(DARK_BG.toLowerCase());

  // applyReveal transitions opacity, and waitFor({state:"visible"}) is satisfied
  // at opacity:0 — so a scan can sample mid-transition and report a phantom
  // contrast failure (v7.22.0). Reduced motion removes the hazard entirely.
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });

  const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
  return (r.violations || [])
    .filter((v) => GATED.has(v.impact))
    .flatMap((v) => v.nodes.map((n) => ({
      rule: v.id, impact: v.impact,
      target: (n.target || []).join(" "),
      why: (n.failureSummary || "").replace(/\s+/g, " ").slice(0, 200),
    })));
}

const fmt = (label, bad) =>
  `${label}: ${bad.length} moderate+ axe violation(s) in the DARK theme:\n  ` +
  bad.map((b) => `[${b.impact}] ${b.rule} — ${b.target}\n      ${b.why}`).join("\n  ");

test("v7.23.1: the anonymous surfaces are clean in the dark theme", async ({ page }) => {
  await forceDark(page);
  await page.goto("/");
  await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 20000 });
  const bad = await scanDark(page, "#login-page", "login");
  expect(bad, fmt("login", bad)).toEqual([]);
});

test("v7.23.1: every admin tab is clean in the dark theme", async ({ page }) => {
  await forceDark(page);
  const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await page.request.post("/api/login", {
    headers: H(t), data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(li.ok(), `superadmin login: ${li.status()}`).toBeTruthy();

  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });

  const TABS = [
    // Every sidebar item. Submissions and Logs have none (Audit covers both).
    ["Events", "admin-competitions-tab"], ["New event", "admin-templates-tab"],
    ["Challenges", "admin-tasks-tab"],
    ["Participants", "admin-participants-tab"], ["Groups", "admin-groups-tab"],
    ["Audit", "admin-audit-tab"], ["Rankings", "admin-rankings-tab"],
    ["Analytics", "admin-analytics-tab"], ["Users", "admin-users-tab"],
    ["Settings", "admin-settings-tab"],
  ];

  const all = [];
  for (const [name, tab] of TABS) {
    const ham = page.locator("#admin-mobile-menu-btn");
    if (await ham.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await ham.click();
    await page.locator(_tabSel(name)).first().evaluate((el) => el.click());
    await page.locator(`#${tab}`).waitFor({ state: "visible", timeout: 20000 });
    // The New event page's starters are drawn by its loader: a pane whose
    // cards never rendered would scan clean.
    if (tab === "admin-templates-tab") await expect(page.locator('#tpl-kind-cards [data-action="new-event-start"]').first(), "PRECONDITION: the blank starters rendered").toBeVisible({ timeout: 20000 });
    // let the tab's own loaders paint — an empty pane scans clean vacuously
    await page.waitForTimeout(700);
    const bad = await scanDark(page, `#${tab}`, name);
    if (bad.length) all.push(fmt(name, bad));
  }
  expect(all, all.join("\n\n")).toEqual([]);
});

test("v7.23.1: the analytics filter bar is clean with its chips ACTIVE", async ({ page }) => {
  // The default Analytics state already exercised the chips, but only in their
  // resting look. The ACTIVE chip is the one that inverts to a bright fill —
  // easy measured 2.53:1 and hard 3.67:1 with white text — so it has to be
  // switched on deliberately or the worst case is never sampled.
  await forceDark(page);
  const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/login", { headers: H(t), data: { email: "superadmin", password: getSuperadminPass() } });
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  const ham = page.locator("#admin-mobile-menu-btn");
  if (await ham.isVisible() && !(await page.locator("#admin-sidebar.mobile-open").count())) await ham.click();
  await openAnalyticsTab(page);
  await page.locator("#admin-analytics-tab").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(700);

  const chips = page.locator("#admin-analytics-tab [data-action='analytics-toggle-difficulty']");
  const n = await chips.count();
  expect(n, "the difficulty chips must be present, or this scan is vacuous").toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const c = chips.nth(i);
    if (!(await c.evaluate((el) => el.classList.contains("chip-active")))) await c.click();
  }
  await expect(page.locator("#admin-analytics-tab .chip-active").first()).toBeVisible();
  await page.waitForTimeout(300);

  const bad = await scanDark(page, "#admin-analytics-tab", "analytics (chips active)");
  expect(bad, fmt("analytics (chips active)", bad)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// v7.23.6 — filled STATUS surfaces, measured deterministically in both themes.
//
// The axe sweep above found `.btn.danger` at 3.67:1 — but only INTERMITTENTLY,
// because the Groups tab renders that button solely when a group exists, which
// depends on what earlier tests left behind. A gate that catches a permanent
// defect by luck will be read as a flake and silenced (the v7.22.0 dry-run-card
// lesson), so the family gets a lock that cannot miss it.
//
// It exercises the REAL stylesheet inside the REAL themed document — the
// elements are constructed rather than hunted so that every variant is present
// on every run regardless of app state. The subject is the CSS token, not the
// rendering path; the axe sweep above covers the rendering path.
const STATUS_SURFACES = [
  { name: ".btn.danger", html: '<button class="btn danger">Delete</button>' },
  { name: ".btn.warning", html: '<button class="btn warning">Warn</button>' },
  { name: ".btn.success", html: '<button class="btn success">Save</button>' },
  { name: ".task-card.solved::after", card: "solved" },
  { name: ".task-card.unsolved::after", card: "unsolved" },
];

for (const theme of ["dark", "light"]) {
  test(`v7.23.6: every filled status surface meets AA in the ${theme} theme`, async ({ page }) => {
    // Any authenticated app page will do — the subject is the stylesheet, and
    // it only has to be the real document with the real CSS loaded.
    const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const li = await page.request.post("/api/login", {
      headers: H(t), data: { email: "superadmin", password: getSuperadminPass() },
    });
    expect(li.ok(), `superadmin login: ${li.status()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    await page.evaluate((th) => { document.documentElement.setAttribute("data-theme", th); }, theme);

    const results = await page.evaluate((surfaces) => {
      const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)];
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(host);
      const out = [];
      for (const s of surfaces) {
        let el, cs;
        if (s.card) {
          const card = document.createElement("div");
          card.className = `task-card ${s.card}`;
          host.appendChild(card);
          // The badge is a ::after pseudo-element, so read it as one.
          cs = getComputedStyle(card, "::after");
          el = card;
        } else {
          host.insertAdjacentHTML("beforeend", s.html);
          el = host.lastElementChild;
          cs = getComputedStyle(el);
        }
        out.push({
          name: s.name,
          fg: cs.color,
          bg: cs.backgroundColor,
          size: parseFloat(cs.fontSize),
          weight: cs.fontWeight,
          ratio: +ratio(rgb(cs.color), rgb(cs.backgroundColor)).toFixed(2),
        });
      }
      host.remove();
      return out;
    }, STATUS_SURFACES);

    // Non-vacuity: a transparent background would make every ratio meaningless.
    for (const r of results) {
      expect(r.bg, `${r.name}: no background resolved, so the ratio is meaningless`)
        .not.toBe("rgba(0, 0, 0, 0)");
    }
    // 11.2px/700 and 13-14px/normal are both BELOW the WCAG large-text
    // threshold (18.66px bold / 24px), so all of these owe the full 4.5:1.
    const failing = results.filter((r) => r.ratio < 4.5);
    expect(failing, `filled status surfaces below AA in ${theme}:\n`
      + failing.map(r => `  ${r.name}: ${r.ratio}:1 (${r.fg} on ${r.bg}, ${r.size}px/${r.weight})`).join("\n")
    ).toEqual([]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// v7.23.7 — the mobile admin drawer must not keep tab stops off-screen.
//
// MEASURED before the fix at 390x844: the sidebar is
// `position:fixed;transform:translateX(-100%)` under @media(max-width:768px),
// which moves it out of sight but NOT out of the tab order — visibility read
// "visible" and 9 of its 10 focusable descendants were still tabbable. A
// keyboard user on a phone tabbed through nine invisible admin nav buttons
// before reaching any content. WCAG 2.4.3 + 2.4.7.
//
// The OPEN half is a positive control, not decoration: `display:none` would
// satisfy "nothing tabbable when closed" while breaking the drawer outright, so
// a test that only checked the closed state would bless a worse bug.
test.describe("v7.23.7 — mobile admin drawer tab stops", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the closed drawer holds no tab stops, and the open one holds them all", async ({ page }) => {
    const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const li = await page.request.post("/api/login", {
      headers: H(t), data: { email: "superadmin", password: getSuperadminPass() },
    });
    expect(li.ok(), `superadmin login: ${li.status()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });

    // Count sidebar descendants that are BOTH outside the viewport and still
    // reachable by Tab. Mirrors what the browser itself does: display:none,
    // visibility:hidden, inert and a negative tabIndex are the only things that
    // take an element out of the sequential focus order.
    const probe = () => page.evaluate(() => {
      const sb = document.getElementById("admin-sidebar");
      const items = [...sb.querySelectorAll("button,a,input,select,textarea,[tabindex]")];
      const tabbable = (el) => {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        if (el.closest("[inert]") || el.hasAttribute("disabled")) return false;
        return el.tabIndex >= 0;
      };
      const offscreen = (el) => {
        const b = el.getBoundingClientRect();
        return b.right <= 0 || b.left >= window.innerWidth;
      };
      return {
        open: sb.classList.contains("mobile-open"),
        total: items.length,
        // Items hidden for a reason of their OWN, independent of the drawer:
        // #admin-sidebar-toggle is display:none at <=768px (the collapse control
        // is desktop-only), so the open drawer legitimately exposes 9 of 10.
        // Deriving the expectation beats hard-coding it — the first draft
        // asserted all 10 and failed against a working fix.
        selfHidden: items.filter((el) => getComputedStyle(el).display === "none").length,
        tabbable: items.filter(tabbable).length,
        offscreenTabbable: items.filter((el) => offscreen(el) && tabbable(el)).length,
      };
    });

    const closed = await probe();
    expect(closed.total, "the sidebar must have focusable items, or this is vacuous").toBeGreaterThan(3);
    expect(closed.open, "the drawer must start closed on a phone").toBe(false);
    expect(closed.offscreenTabbable,
      `the closed drawer keeps ${closed.offscreenTabbable} off-screen tab stops`).toBe(0);

    // POSITIVE CONTROL: opening it must restore every one of them, or the fix
    // has simply deleted the drawer for keyboard users.
    await page.locator("#admin-mobile-menu-btn").click();
    // Poll for the SETTLED open state, both properties together.
    //
    // Polling on `tabbable` alone samples the wrong moment: visibility flips at
    // 0s on open while the transform still slides for --duration-normal, so the
    // items are reachable but still left of the viewport for ~250ms. The first
    // draft did exactly that and then failed its own on-screen assertion with 9.
    // Same class as the toast entry-animation race (v7.23.5).
    const want = closed.total - closed.selfHidden;
    await expect.poll(async () => {
      const p = await probe();
      return `${p.tabbable}/${p.offscreenTabbable}`;
    }, {
      message: "the open drawer must be both reachable and on-screen (tabbable/offscreenTabbable)",
      timeout: 5000,
    }).toBe(`${want}/0`);
    const open = await probe();
    expect(open.tabbable, "the open drawer must expose its nav").toBeGreaterThan(3);
  });
});

// v8.11.6 — THE PARTICIPANT'S CHALLENGE DETAIL HAS NEVER BEEN SCANNED IN DARK.
// Every scan above is anonymous or admin, so two dark-theme AA failures lived on
// the one screen a participant spends the event looking at: `.back-btn` at
// 3.13:1 (a light-theme remediation that was never mirrored — `--accent` is
// unusable as dark text, which the old CLAUDE.md recorded at v7.21.0 — see
// `git show e5f01929:CLAUDE.md`) and the Show-Hint PRICE ROW on its
// `--yellow-soft` tint, where `--muted` measured 4.45:1 and
// `--red` 4.16:1. That row is the warning a participant reads before spending
// points permanently, so it is the last string on the page that should be hard
// to read.
//
// The hint area only exists while a hint is UNREVEALED, so the fixture asserts
// it rendered — otherwise this scan passes by looking at nothing.
test("v8.11.6: the participant challenge detail is clean in the dark theme", async ({ page }) => {
  const { apiLogin, PARTICIPANT_PASS } = require("./helpers");
  const stamp = Date.now();
  const email = `darkdet-${stamp}@company.com`;
  const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");

  const reg = await registerPost(page.request, "/api/register", {
    headers: H((await (await page.request.get("/api/csrf-token")).json()).csrfToken),
    data: { firstName: "Dark", lastName: "Detail", nickname: `darkdet_${stamp}`, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS },
  });
  expect(reg.status(), "fixture participant registered").toBe(200);
  const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
    .participants.find(p => p.email === email);
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });

  const comp = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
    name: `DarkDetail ${stamp}`, event_kind: "tournament",
    start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600,
  }})).json()).competition;
  // TWO challenges, one unsolved by a second participant, so nothing can auto-end
  // the event under the test (*Competition-fixture checklist* item 1).
  const mk = async (title) => (await (await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
    title, description: "<p>body</p>", difficulty: "easy", answer_type: "text",
    correct_answer: "x", hint: "<p>a hint worth paying for</p>", status: "published",
  }})).json()).id;
  const t1 = await mk(`DarkDet A ${stamp}`), t2 = await mk(`DarkDet B ${stamp}`);
  for (const id of [t1, t2]) {
    await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [comp.id] } });
  }
  const asg = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: {
    userIds: [u.id], competitionIds: [comp.id] } });
  expect((await asg.json()).assigned, "the participant must really be enrolled").toBe(1);
  await sa.dispose();

  await forceDark(page);
  const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, email, H(t));
  expect(li.ok(), `participant login: ${li.status()}`).toBeTruthy();
  // A FRESH token: the login above REGENERATES the session, so the one fetched
  // before it is stale and this select would 403 on CSRF — surfacing twenty
  // seconds later as a missing #tasks-page, which names nothing about the cause.
  const tAfter = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(tAfter), data: { competitionId: comp.id } });
  expect(sel.ok(), `select-competition: ${sel.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#tasks-page").waitFor({ state: "visible", timeout: 20000 });
  await page.locator(`.task-card:has-text("DarkDet A ${stamp}")`).first().click();
  await page.locator("#task-detail-card").waitFor({ state: "visible", timeout: 20000 });

  // Preconditions — without these the scan is looking at a screen that does not
  // contain either of the two nodes this test exists for.
  await expect(page.locator("#task-detail-page .back-btn").first(),
    "the Back control must be on screen").toBeVisible();
  await expect(page.locator("#hint-area").first(),
    "the unrevealed hint PRICE ROW must be on screen, or this scan is vacuous").toBeVisible();

  const bad = await scanDark(page, "#task-detail-page", "task-detail");
  expect(bad, fmt("task-detail", bad)).toEqual([]);
});

// THE LOOKS. The sign-in screen, its code dialog and the Look & theme picker are
// scanned in EVERY look, day and night, so a look's
// palette or construction that drops a pair below AA fails here by name. The
// look and mode are asserted before each scan, as the theme is above.
test("the sign-in screen, its code step and the look picker are clean in every look", async ({ page }) => {
  test.setTimeout(240_000);
  const { looks } = require("../scripts/theme/looks");
  const all = [];
  for (const [id, look] of Object.entries(looks)) {
    for (const mode of ["light", "dark"]) {
      await page.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) {} }, [id, mode]);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: mode });
      await page.goto("/");
      await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 20000 });
      await page.waitForSelector("#look-picker-btn");
      const got = await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme,
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()]);
      expect(got, `${id}/${mode}: the page really is in this look and mode`).toEqual([id, mode, look[mode].bg.toLowerCase()]);
      const scan = async (sel, what) => {
        const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
        const bad = (r.violations || []).filter((v) => GATED.has(v.impact)).flatMap((v) => v.nodes.map((n) => ({
          rule: v.id, impact: v.impact, target: (n.target || []).join(" "),
          why: (n.failureSummary || "").replace(/\s+/g, " ").slice(0, 200) })));
        if (bad.length) all.push(fmt(`${what} ${id}/${mode}`, bad));
      };
      await scan("#login-page", "sign-in");
      await page.fill("#login-email", `axe-${id}-${mode}@acme.com`);
      await page.click("#login-submit");
      await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
      await page.fill("#sc-code", "K7QM");
      await expect(page.locator("#signin-code-overlay .ha-code-cell.is-filled"), "the cells mirror the typed code").toHaveCount(4);
      await scan("#signin-code-overlay", "code step");
      await page.keyboard.press("Escape");
      await page.click("#look-picker-btn");
      await page.locator("#look-picker-overlay [role=dialog]").waitFor({ state: "visible" });
      await scan("#look-picker-overlay", "look picker");
      await page.keyboard.press("Escape");
    }
  }
  expect(all, all.join("\n\n")).toEqual([]);
});
