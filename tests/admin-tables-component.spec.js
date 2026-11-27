// @ts-check
//
// EVERY ADMIN DATA TABLE GOES THROUGH THE TABLE COMPONENT (ui/table-columns.js:
// Columns, and sort and filter on every heading; CLAUDE.md "Lists, counts and
// load failures").
//
//   SOURCE  — every `<table` the SPA writes (public/index.html and public/js,
//             comments stripped) either opts in (`data-tcols`) or is a reviewed
//             exemption below, with its reason, checked both ways: a new table
//             with neither fails, and so does an exemption the code no longer
//             needs. The geometry lock (tests/table-columns.spec.js) measures only
//             the tables that opted in, so without this a missing one was silent.
//   BROWSER — the Users & roles list, which opted in: its Columns bar and a
//             button on every heading; a Role filter narrows it (CONTROL: the
//             other role's row comes back when cleared); Last sign-in sorts by the
//             instant, blanks last; and at 1024 px its default columns fit the card.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");
const { stripComments } = require("./html-sink-scan");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");

// A table that does not go through the component, and why. Key: the file and
// the exact opening tag; `count` occurrences of it.
const TABLE_EXEMPT = [
  { file: "public/index.html", tag: '<table class="lb-table">', count: 1,
    why: "the participant leaderboard: the participant app, not an admin page" },
  { file: "public/js/features/leaderboard.js", tag: '<table class="lb-table">', count: 5,
    why: "the participant leaderboard and its late-entrant and team boards: the participant app" },
  { file: "public/js/features/history.js", tag: "<table>", count: 1,
    why: "the History dialog: a table inside a dialog keeps its own search, sort and pages (operator ruling, 14 Nov 2026: the every-admin-table rule covers the admin pages); the component's popovers also sit on <body> at z-index 200, under the dialog's 3000 and outside its focus trap" },
  { file: "public/js/features/export-import.js", tag: '<table style="width:100%;border-collapse:collapse;font-size:var(--fs-13)">', count: 1,
    why: "the participant import's selection step: a form inside a dialog, a tick per row of the file" },
  { file: "public/js/features/export-import.js", tag: '<table style="width:100%;border-collapse:collapse;font-size:var(--fs-14)">', count: 1,
    why: "the import's conflict step: a form inside a dialog, one choice per conflicting row" },
  { file: "public/js/features/competitions-admin.js", tag: '<table style="font-size:var(--fs-14);text-align:left">', count: 1,
    why: "a two-line start and end summary inside a confirmation, laid out as a table rather than a list" },
  { file: "public/js/features/event-workspace.js", tag: '<table class="sr-only">', count: 1,
    why: "the activity chart's copy for screen readers: nothing is drawn, so there is nothing to choose or filter" },
  { file: "public/js/ui/richtext.js", tag: "<table>", count: 1,
    why: "a table an author inserts into a challenge's text: content, not the app's chrome" },
];

/** Every `<table …>` tag in the given sources: { "file :: tag": count }, plus the opted-in count. */
function tableTags(sources) {
  const tags = {};
  let optedIn = 0;
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/<table\b[^>]*>/gi)) {
      if (/\sdata-tcols=/.test(m[0])) { optedIn++; continue; }
      const k = `${file} :: ${m[0]}`;
      tags[k] = (tags[k] || 0) + 1;
    }
  }
  return { tags, optedIn };
}

function spaSources() {
  const out = [["public/index.html", fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "")]];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push([path.relative(ROOT, p).split(path.sep).join("/"), stripComments(fs.readFileSync(p, "utf8"))]);
    }
  })(path.join(ROOT, "public", "js"));
  return out;
}

test.describe("admin tables: every one opts in to the table component, or is a reviewed exemption", () => {
  test("SOURCE: a decision per table, both ways", () => {
    // Planted controls: an opted-in table passes, a bare one is found.
    const planted = tableTags([["planted.js", 'const a = `<table class="dense" data-tcols="x">`;\nconst b = `<table class="new-list">`;']]);
    expect(planted.optedIn).toBe(1);
    expect(planted.tags).toEqual({ 'planted.js :: <table class="new-list">': 1 });

    const { tags, optedIn } = tableTags(spaSources());
    expect(optedIn, "anti-vacuity: the opted-in tables are found").toBeGreaterThan(15);
    const exempt = new Map(TABLE_EXEMPT.map((e) => [`${e.file} :: ${e.tag}`, e]));
    const undecided = Object.entries(tags).filter(([k]) => !exempt.has(k)).map(([k, n]) => `${k} (x${n})`);
    expect(undecided, "a table with no data-tcols: opt it in (data-tcols + a defineTable entry), or add a reviewed exemption with its reason").toEqual([]);
    const stale = TABLE_EXEMPT.filter((e) => tags[`${e.file} :: ${e.tag}`] !== e.count)
      .map((e) => `${e.file} :: ${e.tag} — expected ${e.count}, found ${tags[`${e.file} :: ${e.tag}`] || 0}`);
    expect(stale, "an exemption the code no longer matches (gone, or one more such table): update or delete it").toEqual([]);
    for (const e of TABLE_EXEMPT) expect(e.why.length, `${e.file} :: ${e.tag} carries a reason`).toBeGreaterThan(40);
  });
});

test.describe("Users & roles: the list is an admin data table", () => {
  let fx = null;
  test.beforeAll(async () => {
    const s = await apiLogin("superadmin");
    try {
      const stamp = Date.now().toString(36);
      // A platform admin with a long address and name (as wide as real rows get)
      // who has never signed in…
      const longEmail = `${stamp}.maximiliana.wolfeschlegelsteinhausen@longcompanyname-example.com`;
      const a = await s.api.post("/api/admin/users", { headers: H(s.csrf), data: { email: longEmail, role: "admin", first_name: "Maximiliana", last_name: `Wolfeschlegelsteinhausen${stamp}` } });
      expect(a.ok(), `add user: ${a.status()} ${await a.text()}`).toBeTruthy();
      // …and an event admin who has.
      const ea = await makeParticipant(s.api, s.csrf, "ua-tcols");
      const r = await s.api.post(`/api/admin/participants/${ea.id}/role`, { headers: H(s.csrf), data: { role: "event_admin" } });
      expect(r.ok(), `role: ${r.status()} ${await r.text()}`).toBeTruthy();
      const l = await apiLogin(ea.email, PARTICIPANT_PASS);
      await l.api.dispose();
      const users = (await (await s.api.get("/api/admin/users")).json()).users;
      const admin = users.find((u) => u.email === longEmail), eventAdmin = users.find((u) => u.email === ea.email);
      expect(admin && !admin.last_login_time, "PRECONDITION: the admin never signed in").toBeTruthy();
      expect(eventAdmin && eventAdmin.last_login_time, "PRECONDITION: the event admin has signed in").toBeTruthy();
      fx = { admin, eventAdmin };
    } finally { await s.api.dispose(); }
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { for (const k of Object.keys(localStorage)) if (k.startsWith("ha:tcols:")) localStorage.removeItem(k); } catch (_) { /* defaults apply */ }
    });
  });

  async function openUsers(page, width) {
    await page.setViewportSize({ width, height: 900 });
    await adminLogin(page);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await page.evaluate(() => window.adminTab(null, "admin-users-tab"));
    await expect(page.locator("#ua-users-list tr", { hasText: fx.admin.email })).toBeVisible({ timeout: 15000 });
  }

  test("it carries the Columns bar and a button on every heading; Role filters it; Last sign-in sorts by time, blanks last", async ({ page }) => {
    await openUsers(page, 1280);
    const table = page.locator('#ua-users-list table[data-tcols="users"]');
    await expect(page.locator('.tcol-bar[data-tcols-for="users"] .tcol-cols-btn'), "the Columns chooser").toBeVisible();
    for (const label of ["Name", "Email", "Role", "Events", "Status", "Last sign-in"]) {
      await expect(table.locator("thead th", { hasText: label }).locator(".tcol-hbtn"), `${label} has its sort-and-filter button`).toHaveCount(1);
    }
    const rows = table.locator("tbody tr");
    const before = await rows.count();
    expect(before, "PRECONDITION: more than one platform user").toBeGreaterThan(1);
    // Role → the event admins only.
    await table.locator("thead th", { hasText: "Role" }).locator(".tcol-hbtn").click();
    const pick = page.locator(".tcol-pop select[data-tcol-input]");
    const label = await table.locator("tbody tr", { hasText: fx.eventAdmin.email }).locator(".ua-role-chip").innerText();
    await pick.selectOption({ label });
    await expect(table.locator("tbody tr:visible", { hasText: fx.eventAdmin.email })).toBeVisible();
    await expect(table.locator("tbody tr:visible", { hasText: fx.admin.email }), "the admin's row is filtered out").toHaveCount(0);
    await expect(page.locator('.tcol-bar[data-tcols-for="users"] .tcol-note'), "the bar says a filter is on").not.toBeEmpty();
    await page.locator(".tcol-pop [data-tcol-fclear]").click();
    await expect(table.locator("tbody tr:visible", { hasText: fx.admin.email }), "CONTROL: cleared, the row is back").toBeVisible();
    await page.keyboard.press("Escape");
    // Last sign-in, ascending: the instants in order, then every "Never".
    await table.locator("thead th", { hasText: "Last sign-in" }).locator(".tcol-hbtn").click();
    await page.locator(".tcol-pop [data-tcol-sort='asc']").click();
    const vals = await table.locator('tbody tr:visible td[data-sort-value]').evaluateAll((tds) => tds.map((td) => td.getAttribute("data-sort-value")));
    const signedIn = vals.filter(Boolean);
    expect(signedIn.length, "PRECONDITION: some users have signed in").toBeGreaterThan(0);
    expect(vals.slice(0, signedIn.length), "sign-ins first, in time order").toEqual([...signedIn].sort());
    expect(vals.slice(signedIn.length).every((v) => v === ""), "then everyone who never signed in").toBe(true);
    expect(vals.length, "every row carries the instant").toBe(before);
  });

  test("at 1024 px the default columns fit the card; at 390 px the bar offers Sort & filter", async ({ page }) => {
    await openUsers(page, 1024);
    const over = await page.evaluate(() => {
      const t = document.querySelector('#ua-users-list table[data-tcols="users"]');
      const host = t.closest(".table-card");
      return { table: Math.round(t.scrollWidth), host: host.clientWidth, hostScroll: host.scrollWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(over.hostScroll, `the table fits its card: ${JSON.stringify(over)}`).toBeLessThanOrEqual(over.host + 1);
    expect(over.page, "the page does not scroll sideways").toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.tcol-bar[data-tcols-for="users"] .tcol-sf-btn'), "the phone door to the heading menus").toBeVisible();
  });
});
