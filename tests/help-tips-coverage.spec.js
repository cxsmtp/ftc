"use strict";

// THE "?" HELP TIPS RESOLVE — every placeholder names a registered sentence.
//
// ui/help-tips.js renders NOTHING for a `data-help` key it has no text for (a
// "?" that explains nothing is worse than none), so a misspelt key, a tip whose
// text lives in a module that registers late, or a key nobody wrote is a silent
// gap: the screen looks finished and the help is missing. Two arms:
//
//   SOURCE — every literal `data-help="…"` in public/index.html and public/js
//     (comments stripped), every account-menu `tip:` and every workspace card
//     key, resolves to a non-empty sentence in the running app's HELP_TIPS for
//     every role (a string, or an object with a non-empty `default`, or one
//     sentence per role). Floor: the literal scan must find dozens of keys, so a
//     renamed attribute cannot make it pass by matching nothing.
//   BROWSER — the screens a participant, an organiser and an administrator
//     visit: every [data-help] in the DOM is wired (data-help-ready) and carries
//     its button — none rendered empty — and the keys this sweep added are among
//     those seen (an anti-vacuity control per area).
//
// The regression this also pins: tips registered AFTER the boot-time wiring
// (the Filters tips, templates) rendered nothing on the static placeholders;
// registerHelpTips now re-wires a placeholder that was wired empty.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS } = require("./helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
/** Elements whose text is a heading or a name: a tip never sits inside one. */
const NAMED_HOSTS = "h1,h2,h3,h4,h5,h6,label,legend,summary,button,th,caption,dt";
/** Every `data-help` placeholder written INSIDE one of those, in markup source. */
function tipsInside(src, label) {
  const tags = NAMED_HOSTS.split(",").join("|");
  const re = new RegExp(`<(${tags})\\b[^>]*>((?:(?!<\\/\\1\\s*>)[\\s\\S])*?)<\\/\\1\\s*>`, "gi");
  return [...src.matchAll(re)].filter((m) => /data-help\s*=/.test(m[2])).map((m) => `${label}: ${m[0].slice(0, 120).replace(/\s+/g, " ")}`);
}

function jsFiles(dir) {
  let out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== "vendor") out = out.concat(jsFiles(p)); }
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

/** Every help key the source names literally. */
function sourceKeys() {
  const keys = new Set();
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of html.matchAll(/data-help="([a-z][a-z0-9_.-]*)"/g)) keys.add(m[1]);
  for (const f of jsFiles(path.join(ROOT, "public", "js"))) {
    const src = stripJsComments(fs.readFileSync(f, "utf8"));
    for (const m of src.matchAll(/data-help="([a-z][a-z0-9_.-]*)"/g)) keys.add(m[1]);
    // The account menu's rows name their tip through `tip:"key"` (ui/nav.js).
    for (const m of src.matchAll(/\btip:\s*["']([a-z][a-z0-9_-]*\.[a-z0-9_.-]+)["']/g)) keys.add(m[1]);
    // The workspace cards pass their key to _card() (features/event-workspace.js).
    if (/event-workspace\.js$/.test(f)) for (const m of src.matchAll(/'(ws\.[a-z-]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

/** In the page: does every key resolve to a sentence for every role? */
async function unresolved(page, keys) {
  return page.evaluate((list) => {
    const T = window.HELP_TIPS || {};
    const roles = ["participant", "event_admin", "admin", "superadmin"];
    const bad = [];
    for (const k of list) {
      const v = T[k];
      if (typeof v === "string") { if (!v.trim()) bad.push(`${k}: empty`); continue; }
      if (!v || typeof v !== "object") { bad.push(`${k}: no text registered`); continue; }
      for (const r of roles) {
        const s = v[r] || v.default || "";
        if (!String(s).trim()) bad.push(`${k}: nothing for ${r}`);
      }
    }
    return bad;
  }, [...keys]);
}

/** Wait until every placeholder on the page is wired, then report each one. */
async function collect(page, where, seen) {
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("[data-help]:not([data-help-ready])").length),
    { message: `${where}: every [data-help] placeholder is wired`, timeout: 10000 }).toBe(0);
  const tips = await page.evaluate(() => [...document.querySelectorAll("[data-help]")].map(el => ({
    key: el.getAttribute("data-help"),
    btn: !!el.querySelector(".help-tip-btn"),
    note: (el.querySelector(".help-tip-note")?.textContent || "").trim().length,
  })));
  const empty = tips.filter(t => !t.btn || !t.note).map(t => t.key);
  expect(empty, `${where}: a "?" placeholder rendered with no text`).toEqual([]);
  // The tip sits BESIDE what it explains, never inside it: inside a heading,
  // label or legend its button's "About …" became part of that text or name.
  const inside = await page.evaluate((sel) => [...document.querySelectorAll("[data-help]")]
    .filter(el => el.parentElement && el.parentElement.closest(sel)).map(el => el.getAttribute("data-help")), NAMED_HOSTS);
  expect(inside, `${where}: a "?" sits inside a heading or label (it belongs beside it, in a .help-label-row)`).toEqual([]);
  for (const t of tips) seen.add(t.key);
  return tips;
}

test.describe('"?" help tips — every key resolves', () => {
  test("SOURCE: every literal key resolves to a sentence for every role", async ({ page }) => {
    const keys = sourceKeys();
    expect(keys.size, "anti-vacuity: the scan finds the tips (a renamed attribute would match nothing)").toBeGreaterThan(80);
    await page.goto("/");
    await page.waitForFunction(() => window.HELP_TIPS && typeof window.helpTipText === "function", null, { timeout: 20000 });
    expect(await unresolved(page, keys), "every data-help key the source names has text").toEqual([]);
    // CONTROL — the check refuses what it should: a key nobody wrote fails it.
    expect(await unresolved(page, ["zz.no-such-tip"])).toEqual(["zz.no-such-tip: no text registered"]);
  });

  // THE TIP SITS BESIDE WHAT IT EXPLAINS, NEVER INSIDE IT (CLAUDE.md "?" help
  // tips): inside a heading, a label or a legend, the button's "About …" became
  // part of the heading's text or the control's (or group's) name. The browser
  // arms check every visited screen; this scans the source, every screen at once.
  test("SOURCE: no tip is written inside a heading, label, legend or other named element", () => {
    // Anti-vacuity: the matcher sees a tip inside each kind, and a sibling clears it.
    expect(tipsInside('<h4 class="x">Mode <span data-help="a.b"></span></h4><label for="y">Name <span data-help="a.c"></span></label>'
      + '<legend>Acts on <span data-help="a.d"></span></legend>', "planted")).toHaveLength(3);
    expect(tipsInside('<div class="help-label-row"><h4 class="x">Mode</h4><span data-help="a.b"></span></div><label for="y">Name</label>', "ok")).toEqual([]);
    const hits = tipsInside(fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, ""), "public/index.html");
    let placing = 0;
    for (const f of jsFiles(path.join(ROOT, "public", "js"))) {
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      if (/data-help=/.test(src)) placing++;
      hits.push(...tipsInside(src, path.relative(ROOT, f)));
    }
    expect(placing, "anti-vacuity: the modules that place tips are scanned").toBeGreaterThan(10);
    expect(hits, `these tips sit inside the heading or label they explain; put them beside it (a .help-label-row):\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  test("BROWSER (organiser and admin): every tip on the visited screens is wired with text", async ({ page }) => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    const H = (t) => ({ "x-csrf-token": t, "content-type": "application/json" });
    const name = `Tips ${Date.now()}`;
    const cr = await s.api.post("/api/admin/competitions", {
      headers: H(s.csrf),
      data: { name, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600, event_kind: "tournament", self_enroll_enabled: true },
    });
    expect(cr.ok(), `create event: ${cr.status()}`).toBeTruthy();

    await page.setViewportSize({ width: 1440, height: 900 });
    const { adminLogin, viewComp } = require("./ui-admin-helpers");
    await adminLogin(page);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    const seen = new Set();
    const tab = async (id) => {
      await page.evaluate((t) => window.adminTab(document.querySelector(`.admin-nav-item[data-tab-id="${t}"]`), t), id);
      await page.locator(`#${id}`).waitFor({ state: "visible", timeout: 15000 });
      return collect(page, id, seen);
    };
    for (const id of ["admin-competitions-tab", "admin-templates-tab", "admin-tasks-tab", "admin-participants-tab",
      "admin-groups-tab", "admin-rankings-tab", "admin-analytics-tab", "admin-audit-tab", "admin-logs-tab", "admin-settings-tab"]) {
      await tab(id);
    }
    // The challenge editor.
    await tab("admin-tasks-tab");
    await page.evaluate(() => window.openTaskForm && window.openTaskForm());
    await page.locator("#admin-task-form").waitFor({ state: "visible", timeout: 10000 });
    await collect(page, "challenge editor", seen);
    // The Invite dialog.
    await tab("admin-participants-tab");
    await page.locator("#invite-participants-btn").click();
    await page.locator(".invite-card").waitFor({ state: "visible", timeout: 10000 });
    await collect(page, "invite dialog", seen);
    await page.keyboard.press("Escape");
    await expect(page.locator(".invite-card")).toHaveCount(0);
    // Users & roles, and the role editor (the scope radios' tip).
    await tab("admin-users-tab");
    await page.locator('#ua-body [data-action="ua-view"][data-view="roles"]').click();
    await page.locator('#ua-roles-list [data-action="ua-role-new"]').click();
    await page.locator("#ua-role-ed").waitFor({ state: "visible", timeout: 10000 });
    await collect(page, "role editor", seen);
    await page.locator("#ua-role-ed [data-ua-cancel]").click();
    // The event workspace: Overview, its join popover, Settings.
    await tab("admin-competitions-tab");
    await viewComp(page, name);
    await page.locator("#ws-overview .ws-card").first().waitFor({ state: "visible", timeout: 15000 });
    await collect(page, "workspace overview", seen);
    await page.locator('#ws-join [data-action="ws-join-reveal"]').click();
    await page.locator("#ws-join-pop").waitFor({ state: "visible", timeout: 15000 });
    await collect(page, "join popover", seen);
    await page.keyboard.press("Escape");
    await page.locator('#ws-tabs .ws-tab[data-section="admin-event-settings-tab"]').click();
    await page.locator("#ws-settings .ws-card").first().waitFor({ state: "visible", timeout: 10000 });
    await collect(page, "workspace settings", seen);
    await page.locator('#ws-tabs .ws-tab[data-section="admin-analytics-tab"]').click();
    await page.locator("#analytics-filterbar .filter-card").first().waitFor({ state: "visible", timeout: 10000 });
    await collect(page, "workspace analytics", seen);

    // Anti-vacuity, per area: the keys this sweep added were among those wired.
    for (const k of ["lists.filters", "library.list", "library.export", "people.desk", "people.columns", "people.status",
      "groups.list", "activity.list", "rankings.board", "analytics.columns", "analytics.scope", "logs.streams",
      "audit.filters", "users.scope", "invite.events", "invite.groups", "ws.sessions", "ws.challenges", "ws.progress",
      "ws.organisers", "ws.join", "ws.settings", "ws.look", "settings.platform-name", "challenge.attempts"]) {
      expect(seen.has(k), `the visited screens rendered the "${k}" tip`).toBe(true);
    }
  });

  test("BROWSER (participant): sign-in, code step, challenges, leaderboard, profile, events", async ({ browser }) => {
    test.setTimeout(180_000);
    const { makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
    const s = await apiLogin("superadmin");
    const p = await makeParticipant(s.api, s.csrf, "tips");
    const comp = await makeCompetition(s.api, s.csrf, "tips");
    // Two challenges, one solved by nobody: the event stays live (fixture item 1).
    for (const label of ["tips-a", "tips-b"]) {
      const t = await makeTask(s.api, s.csrf, label);
      await assignTask(s.api, s.csrf, t.id, [comp.id]);
    }
    await enrol(s.api, s.csrf, comp.id, [p.id]);
    const seen = new Set();

    // Anonymous: the sign-in card and its code step.
    const anon = await browser.newContext();
    try {
      const page = await anon.newPage();
      await page.goto("/");
      await expect(page.locator('html[data-booted="1"]'), "the app booted (boot() sets html[data-booted] last)").toBeAttached({ timeout: 20000 });
      await collect(page, "sign-in", seen);
      await page.locator("#login-email").fill(p.email);
      await page.locator("#login-submit").click();
      await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
      await collect(page, "code step", seen);
    } finally { await anon.close(); }

    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const { loginViaApi } = require("./ui-admin-helpers");
      await loginViaApi(page, p.email, PARTICIPANT_PASS);
      await page.goto("/");
      await expect(page.locator("#nav-challenges:not([aria-disabled=true])")).toBeVisible({ timeout: 25000 });
      await page.locator("#task-grid .task-card, #task-grid [data-task-id]").first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
      await collect(page, "challenges", seen);
      await page.locator("#nav-leaderboard").click();
      await page.locator("#leaderboard-page").waitFor({ state: "visible", timeout: 15000 });
      await collect(page, "leaderboard", seen);
      await require("./chrome-helpers").pressAccountMenuItem(page, "open-profile-editor");
      await page.locator("#profile-overlay").waitFor({ state: "visible", timeout: 10000 });
      await collect(page, "profile", seen);
      await page.keyboard.press("Escape");
      await expect(page.locator("#profile-overlay")).toHaveCount(0);
      const ap = await require("./chrome-helpers").openAppearance(page);
      await ap.locator(".lp-card").first().waitFor({ state: "visible", timeout: 10000 });
      await collect(page, "appearance", seen);
      await page.keyboard.press("Escape");
      await expect(ap).toHaveCount(0);
      await page.locator("#nav-competitions").click();
      await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 15000 });
      await collect(page, "events", seen);
    } finally { await ctx.close(); }

    for (const k of ["signin.email", "signin.code", "tasks.filters", "lb.board", "profile.emails", "profile.identity",
      "profile.location", "events.filters", "appearance.mode", "appearance.look", "appearance.tips"]) {
      expect(seen.has(k), `the visited screens rendered the "${k}" tip`).toBe(true);
    }
  });
});

test.describe('"?" help tips — what each one says and where it sits', () => {
  // ROLE-SPECIFIC TEXT ON A STATIC PLACEHOLDER. The shell's own placeholders
  // (index.html) are wired at boot, before anyone has signed in, and the text
  // was resolved once, there: an event admin read the default library.list
  // sentence, a superadmin the "a superadmin can import" one about themselves.
  // The nav builders now re-resolve every wired tip once the role is known
  // (help-tips.js refreshRoleTips), so the sentence is right before any press.
  test("a static tip reads the signed-in role's sentence (event admin and superadmin, each with the other as control)", async ({ browser }) => {
    test.setTimeout(150_000);
    const { makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");
    const { loginViaApi, adminLogin } = require("./ui-admin-helpers");
    const s = await apiLogin("superadmin");
    const ea = await makeParticipant(s.api, s.csrf, "tiprole");
    const comp = await makeCompetition(s.api, s.csrf, "tiprole");
    await grantEventAdmin(s.api, s.csrf, comp.id, ea.id);
    await s.api.dispose();

    /** The library's two tips as this page wired them, read before and after a press. */
    async function libraryTips(page) {
      await page.evaluate(() => window.adminTab(document.querySelector('.admin-nav-item[data-tab-id="admin-tasks-tab"]'), "admin-tasks-tab"));
      await page.locator("#admin-tasks-tab").waitFor({ state: "visible", timeout: 15000 });
      const out = {};
      for (const key of ["library.list", "library.export"]) {
        const ph = page.locator(`[data-help="${key}"]`);
        await expect(ph.locator(".help-tip-btn"), `PRECONDITION: the ${key} tip is wired`).toBeAttached({ timeout: 10000 });
        const wired = (await ph.locator(".help-tip-note").textContent()).trim();
        await ph.locator(".help-tip-btn").click();
        await expect(ph.locator(".help-tip-note")).toBeVisible();
        out[key] = { wired, shown: (await ph.locator(".help-tip-note").textContent()).trim() };
      }
      out.sentences = await page.evaluate(() => ({ list: window.HELP_TIPS["library.list"], exp: window.HELP_TIPS["library.export"] }));
      return out;
    }

    const eaCtx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const page = await eaCtx.newPage();
      await loginViaApi(page, ea.email, PARTICIPANT_PASS);
      await page.goto("/");
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
      const t = await libraryTips(page);
      expect(t.sentences.list.event_admin, "PRECONDITION: library.list has an event-admin sentence").toBeTruthy();
      expect(t["library.list"].wired, "the event admin's own sentence, before any press").toBe(t.sentences.list.event_admin);
      expect(t["library.list"].shown, "and when pressed").toBe(t.sentences.list.event_admin);
      expect(t["library.export"].shown, "CONTROL: a key with no event-admin sentence reads its default").toBe(t.sentences.exp.default);
    } finally { await eaCtx.close(); }

    const saCtx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const page = await saCtx.newPage();
      await adminLogin(page);
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
      const t = await libraryTips(page);
      expect(t["library.export"].wired, "the superadmin's own sentence, before any press").toBe(t.sentences.exp.superadmin);
      expect(t["library.export"].shown, "and when pressed").toBe(t.sentences.exp.superadmin);
      expect(t["library.list"].shown, "CONTROL: the superadmin reads library.list's default, not the event admin's").toBe(t.sentences.list.default);
    } finally { await saCtx.close(); }
  });

  // A TIP IN A ROW OF FILTER CHIPS. `.filters` wraps and stretches its items,
  // so an opened tip (button and note in one inline box) made the box tall and
  // every chip on its line stretched with it (~77 px at 1280 px), its note on
  // the same line. The note now takes a line of its own below the chips.
  test("opening the challenge filters' tip neither stretches the chips nor shares their line", async ({ page }) => {
    test.setTimeout(150_000);
    const { makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
    const { loginViaApi } = require("./ui-admin-helpers");
    const s = await apiLogin("superadmin");
    const p = await makeParticipant(s.api, s.csrf, "tipchips");
    const comp = await makeCompetition(s.api, s.csrf, "tipchips");
    for (const label of ["tipchips-a", "tipchips-b"]) {
      const t = await makeTask(s.api, s.csrf, label);
      await assignTask(s.api, s.csrf, t.id, [comp.id]);
    }
    await enrol(s.api, s.csrf, comp.id, [p.id]);
    await s.api.dispose();
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginViaApi(page, p.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator("#nav-challenges:not([aria-disabled=true])")).toBeVisible({ timeout: 25000 });
    const row = page.locator("#diff-filters");
    await expect(row).toBeVisible({ timeout: 15000 });
    const btn = row.locator('[data-help="tasks.filters"] .help-tip-btn');
    await expect(btn).toBeVisible();
    const measure = () => row.evaluate((r) => {
      const chips = [...r.querySelectorAll(".filter-btn")].map((c) => c.getBoundingClientRect());
      const note = r.querySelector(".help-tip-note");
      const n = note && !note.hidden ? note.getBoundingClientRect() : null;
      const b = r.querySelector(".help-tip-btn").getBoundingClientRect();
      return { heights: chips.map((c) => Math.round(c.height)), chipsBottom: Math.max(...chips.map((c) => c.bottom)), noteTop: n ? n.top : null,
        btn: [Math.round(b.left), Math.round(b.top)] };
    });
    const before = await measure();
    expect(before.noteTop, "PRECONDITION: the note starts closed").toBeNull();
    await btn.click();
    await expect(row.locator(".help-tip-note")).toBeVisible();
    const after = await measure();
    expect(after.heights, `the chips keep their height: ${JSON.stringify({ before, after })}`).toEqual(before.heights);
    expect(after.noteTop, `the note sits below the chips, on a line of its own: ${JSON.stringify(after)}`).toBeGreaterThanOrEqual(after.chipsBottom - 0.5);
    expect(after.btn, `and the "?" stays where it was, in the chip row: ${JSON.stringify({ before, after })}`).toEqual(before.btn);
  });

  // THE TOUCH TARGET. The "?" is a 24 px circle everywhere (participant pages
  // included); on a touch screen its target is 44 x 44 (the house rule) while
  // the circle stays as drawn: the button's own ::after is the hit area.
  test("on a touch screen the '?' answers across a 44 px target; with a mouse only its 24 px circle does (control)", async ({ browser }) => {
    const probe = async (touch) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, hasTouch: touch });
      try {
        const page = await ctx.newPage();
        await page.goto("/");
        const btn = page.locator('[data-help="signin.email"] .help-tip-btn');
        await expect(btn).toBeVisible({ timeout: 20000 });
        return await btn.evaluate((b) => {
          const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const at = (dx, dy) => { const e = document.elementFromPoint(cx + dx, cy + dy); return !!(e && (e === b || b.contains(e))); };
          return { coarse: matchMedia("(pointer:coarse)").matches, drawn: [Math.round(r.width), Math.round(r.height)],
            centre: at(0, 0), ring: [at(-17, 0), at(17, 0), at(0, -17), at(0, 17)],
            // The full 44 px: 21 px from the centre along each axis (a target
            // drawn 10 px inside the 22 px padding box was 42 px).
            edge: [at(-21, 0), at(21, 0), at(0, -21), at(0, 21)] };
        });
      } finally { await ctx.close(); }
    };
    const touch = await probe(true);
    expect(touch.coarse, "PRECONDITION: the touch context reports a coarse pointer").toBe(true);
    expect(touch.drawn, "the circle is still drawn at 24 px").toEqual([24, 24]);
    expect(touch.ring, `every point 17 px from its centre is the button's target: ${JSON.stringify(touch)}`).toEqual([true, true, true, true]);
    expect(touch.edge, `every point 21 px from its centre along an axis is too (a 44 px target): ${JSON.stringify(touch)}`).toEqual([true, true, true, true]);
    const mouse = await probe(false);
    expect(mouse.coarse, "PRECONDITION: the mouse context does not").toBe(false);
    expect(mouse.centre, "CONTROL: the centre is the button with a mouse too").toBe(true);
    expect(mouse.ring, `CONTROL: with a mouse the target is the 24 px circle alone: ${JSON.stringify(mouse)}`).toEqual([false, false, false, false]);
  });
});
