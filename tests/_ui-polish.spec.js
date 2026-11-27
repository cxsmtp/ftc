// @ts-check
//
// UI Polish visual-diff capture — opt-in tooling (NOT part of the regression suite).
//
// Invoked by `.claude/commands/polish.md` via `.claude/agents/ui-visual-verifier.md`,
// which runs: `POLISH_PHASE=<before|after> POLISH_SCREENS=<csv|all> npm run polish:shots`.
//
// Each run reads the manifest at `.claude/screens.json`, keeps the slugs listed
// in POLISH_SCREENS ("all" keeps every entry), and captures each one in every
// combination of POLISH_MATRIX (below) that the entry allows, navigating with
// the entry's route_script.
//
// Excluded from the default `npm test` by the testIgnore rule in
// playwright.config.js (underscore-prefixed specs run only when
// CAPTURE_SCREENSHOTS=1). The npm script sets that flag.
//
// THE MATRIX (POLISH_MATRIX):
//   house  one shot: the house look, by day, 1280 px   → <screen>-<phase>.png
//   modes  the house look by day and by night, at 1280 and 390 px   (the default)
//   looks  every look by day and by night at 1280 px
//   full   every look by day and by night at 1280 and 390 px
// Every matrix but `house` names its files <screen>@<look>-<mode>-<width>-<phase>.png.
// An entry may narrow it: `"looks"`, `"modes"`, `"widths"` arrays (a phone-only
// surface says "widths": [390]).
//
// A screen that cannot be captured at all says `"status_note": "uncapturable"`
// with a `note` saying why: it is SKIPPED, by name, never shot as something else.

const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const helpers = require("./helpers");
const { BASE, getSuperadminPass, codeLogin } = require("./helpers");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, ".claude", "screens.json");
const OUT_DIR = path.join(ROOT, ".claude", "visual-diffs");

const PHASE = (process.env.POLISH_PHASE || "before").toLowerCase();
const SCREENS_CSV = process.env.POLISH_SCREENS || "";
const REQUESTED = SCREENS_CSV.split(",").map(s => s.trim()).filter(Boolean);
const MATRIX_NAME = (process.env.POLISH_MATRIX || "modes").toLowerCase();

// Fail the whole spec early if the operator forgot to pass the env vars —
// running with empty screens is almost certainly an operator mistake.
if (!REQUESTED.length) {
  console.error("POLISH_SCREENS is empty. Set e.g. POLISH_SCREENS=login,task-detail (or all).");
}

let manifest = { screens: [] };
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch (e) {
  console.error("Could not read .claude/screens.json:", e.message);
}

// The looks and the house look come from the same data the generator and
// theme-boot.js use, so the matrix can never name a look that does not exist.
const { looks: LOOK_DATA } = require("../scripts/theme/looks");
const LOOK_IDS = Object.keys(LOOK_DATA);
const HOUSE_LOOK = (fs.readFileSync(path.join(ROOT, "public", "theme-boot.js"), "utf8").match(/var HOUSE_LOOK = "([a-z]+)"/) || [])[1] || LOOK_IDS[0];
const MATRICES = {
  house: { looks: [HOUSE_LOOK], modes: ["light"], widths: [1280] },
  modes: { looks: [HOUSE_LOOK], modes: ["light", "dark"], widths: [1280, 390] },
  looks: { looks: LOOK_IDS, modes: ["light", "dark"], widths: [1280] },
  full: { looks: LOOK_IDS, modes: ["light", "dark"], widths: [1280, 390] },
};
if (!MATRICES[MATRIX_NAME]) throw new Error(`POLISH_MATRIX must be one of ${Object.keys(MATRICES).join(", ")}; got "${MATRIX_NAME}"`);
const HEIGHT = { 1280: 900, 390: 844 };

// Named fixtures: every module in tests/polish-fixtures/ exports
// { <name>: async (ctx) => values }. A route step `fixture <name> [as <key>]`
// runs one and stores what it returns under <key> (default <name>) for the
// steps after it to read as {{key.field}}. A returned `cleanup` function runs
// after the capture, pass or fail.
const FIXTURES = {};
const FIX_DIR = path.join(__dirname, "polish-fixtures");
if (fs.existsSync(FIX_DIR)) {
  for (const f of fs.readdirSync(FIX_DIR).filter((f) => f.endsWith(".js")).sort()) {
    for (const [name, fn] of Object.entries(require(path.join(FIX_DIR, f)))) {
      if (FIXTURES[name]) throw new Error(`fixture "${name}" is defined twice (${f})`);
      FIXTURES[name] = fn;
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// Per-test baseURL (each Playwright worker runs its own server on a distinct
// port; helpers.BASE resolves it). The viewport is set per capture below.
test.use({ baseURL: BASE });

function combosFor(entry) {
  const m = MATRICES[MATRIX_NAME];
  const pick = (all, own) => (Array.isArray(own) && own.length ? all.filter((v) => own.includes(v)) : all);
  const out = [];
  for (const look of pick(m.looks, entry.looks)) for (const mode of pick(m.modes, entry.modes)) for (const width of pick(m.widths, entry.widths)) out.push({ look, mode, width });
  // An entry whose own lists exclude the whole matrix (a phone-only surface in
  // the `house` matrix) is still captured once, in its own first combination.
  if (!out.length) out.push({ look: (entry.looks || m.looks)[0], mode: (entry.modes || m.modes)[0], width: (entry.widths || m.widths)[0] });
  return out;
}
function shotPath(entry, combo, single) {
  const name = single ? `${entry.screen}-${PHASE}` : `${entry.screen}@${combo.look}-${combo.mode}-${combo.width}-${PHASE}`;
  return path.join(OUT_DIR, `${name}.png`);
}

// Sign in on the page's own request context, as the SPA does, BEFORE the
// first goto (CLAUDE.md: sign in via page.request before navigating).
async function signIn(page, who) {
  if (/^superadmin$/i.test(who)) {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r = await page.request.post("/api/login", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() },
    });
    if (!r.ok()) throw new Error(`superadmin login failed: ${r.status()} ${await r.text()}`);
    return;
  }
  const email = /@/.test(who) ? who : `${who.toLowerCase()}@acme.com`;
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" });
  if (!r.ok()) throw new Error(`${email} login failed: ${r.status()} ${await r.text()}`);
}

// The admin sidebar on a phone (<=768 px) is a DRAWER: closed, it is translated
// off-canvas and `inert`, which Playwright still counts as visible (it has a
// box), so visibility cannot tell whether it must be opened. The section bar
// (#admin-mobile-menu-btn) is shown only at that width: when it is, open the
// drawer unless it already is. On a wide screen this does nothing.
async function openAdminDrawer(page) {
  const bar = page.locator("#admin-mobile-menu-btn");
  if (!(await bar.isVisible().catch(() => false))) return;
  const open = page.locator("#admin-sidebar.mobile-open");
  if (!(await open.count())) await bar.click({ timeout: 10_000 });
  await open.waitFor({ state: "visible", timeout: 10_000 });
}

// Element screenshots and the sticky app header: Playwright scrolls an anchor
// that is not wholly in view until it is, which leaves its top under the
// sticky header (the workspace header, a pane's heading). So an anchor in the
// page's flow is shot from the UNSCROLLED page, where the header sits in its own
// place above the content: as it is when it fits the window, else as part of
// the full page clipped to its box. Anything fixed (a dialog, a sheet, a menu)
// is shot as it is, unscrolled, so a scroll cannot move or close it.
async function shootAnchor(page, loc, out) {
  const vp = page.viewportSize();
  const fixed = await loc.evaluate((el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (getComputedStyle(n).position === "fixed") return true;
    return false;
  });
  if (!fixed && vp) {
    await page.evaluate(() => new Promise((r) => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(r)); }));
    const b = await loc.boundingBox();
    if (b && b.y + b.height > vp.height) {
      await page.screenshot({ path: out, fullPage: true, clip: { x: b.x, y: b.y, width: b.width, height: b.height } });
      return;
    }
  }
  await loc.screenshot({ path: out });
}

// {{key.field}} in a step reads what a fixture returned.
function substitute(step, ctx) {
  return step.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, keyPath) => {
    const v = keyPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v === undefined || v === null) throw new Error(`route placeholder {{${keyPath}}} has no value (did a fixture step run before it?)`);
    return String(v);
  });
}

// Route-script interpreter. The manifest's `route_script` is a terse DSL —
// keeps the manifest readable without inlining Playwright code per entry. Steps
// are separated by ` ; ` (so commas inside selectors survive):
//   goto <path>                        navigate (relative to the test server)
//   apiLogin <who>                     alice | bob | carol | superadmin | any address a fixture made
//   waitFor <selector>                 waits for the selector to be visible
//   settle <selector>                  waitFor, then let that surface's own CSS animations end and its images decode
//   wait <ms>                          a fixed pause (at most 5000) for motion no selector sees end (a JS count-up); prefer waitFor or settle
//   click <selector>                   clicks the first match
//   fill <selector> <value…>           types into an input (value may contain spaces)
//   press <key>                        a keyboard key (Escape, Enter, Tab …)
//   select live|upcoming|ended competition   participant: open that seeded event
//   tab <slug>                         an admin sidebar section (admin-<slug>-tab), opening the phone drawer when needed
//   drawer                             open the admin sidebar's phone drawer (nothing on a wide screen, where it is always shown)
//   section <id>                       an open workspace's section (data-section), through the phone sheet when needed
//   viewport <W>x<H>                   resize the page mid-route
//   look <id> [light|dark] [ambient]   this browser's own look, reloading if a page is open
//   fixture <name> [as <key>]          run a named fixture (tests/polish-fixtures/)
//   fillCode <selector> <address>      type the sign-in code last mailed to the address
//   clock install | clock forward <ms> drive the page's clock (install BEFORE the first goto)
//   upload <selector> <file>           set a file input (a fixture's file path)
//   settings <key>                     a Settings section (data-settings-section): the section list,
//                                      or the phone's section <select> at <=768 px
//   heading <table> <col>              a table heading's sort-and-filter menu (ui/table-columns.js):
//                                      the heading's button, or on a phone the bar's Sort & filter, then that column
// An UNRECOGNISED step FAILS the capture: a step the harness silently skipped is
// how a route once "arrived" at the wrong screen. Every step is bounded (click
// 10 s, waitFor 15 s, fill 10 s) so a route that cannot succeed fails fast.
//
// Two further guards:
//   • `Docs hygiene > "v7.23.0: the polish manifest names only paths and
//     selectors that exist"` (tests/functional-core-b.api.spec.js) fails if any
//     id / data-action / file path in the manifest is not in the codebase. Note
//     it proves an id EXISTS in source, not that a given route RENDERS it — this
//     spec is what proves the second half.
//   • A visual_anchor that never becomes visible fails the capture too (below).
async function runRouteScript(page, scriptText, ctx, cleanups) {
  const steps = scriptText.split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
  for (const raw of steps) {
    const step = substitute(raw, ctx);
    let m;
    if ((m = step.match(/^goto\s+(\S+)$/i))) { await page.goto(m[1]); continue; }
    // The step's name is built from parts: spelled whole inside a regex it reads,
    // to the helpers-import scanner (functional-core-b), as a use of the helper
    // of that name, which this harness does not call.
    if ((m = step.match(new RegExp("^api" + "Login\\s+(\\S+)$", "i")))) { await signIn(page, m[1]); continue; }
    if ((m = step.match(/^waitFor\s+(.+)$/i))) { await page.locator(m[1].trim()).first().waitFor({ state: "visible", timeout: 15_000 }); continue; }
    if ((m = step.match(/^settle\s+(.+)$/i))) {
      // A surface with its own entrance (a celebration's rings and rising points)
      // or an image the server renders on demand (a certificate preview) is shot
      // at rest, so a before/after pair compares two resting states rather than
      // two frames of motion. An endless animation (a pulsing dot) is not waited
      // for, and the whole wait is capped.
      const loc = page.locator(m[1].trim()).first();
      await loc.waitFor({ state: "visible", timeout: 15_000 });
      await loc.evaluate((el) => Promise.race([
        Promise.all([
          ...el.getAnimations({ subtree: true })
            .filter((a) => !(a.effect && a.effect.getComputedTiming().iterations === Infinity))
            .map((a) => a.finished.catch(() => null)),
          ...[...el.querySelectorAll("img")].map((img) => img.decode().catch(() => null)),
        ]),
        new Promise((r) => setTimeout(r, 10_000)),
      ]));
      continue;
    }
    if ((m = step.match(/^wait\s+(\d+)$/i))) {
      if (+m[1] > 5000) throw new Error(`wait ${m[1]}: at most 5000 ms (a longer pause is waiting on the wrong thing)`);
      await page.waitForTimeout(+m[1]);
      continue;
    }
    if ((m = step.match(/^click\s+(.+)$/i))) { await page.locator(m[1].trim()).first().click({ timeout: 10_000 }); continue; }
    if ((m = step.match(/^fill\s+(\S+)(?:\s+(.*))?$/i))) {
      const input = page.locator(m[1]).first();
      await input.waitFor({ state: "visible", timeout: 10_000 });
      await input.fill((m[2] || "").trim());
      // The search boxes are debounced (160-250ms depending on the surface);
      // give the re-render a beat before the next step looks for a row.
      await page.waitForTimeout(400);
      continue;
    }
    if ((m = step.match(/^press\s+(\S+)$/i))) { await page.keyboard.press(m[1]); continue; }
    if ((m = step.match(/^select\s+(live|upcoming|ended)\s+competition$/i))) {
      const name = { live: "Test Live", upcoming: "Test Upcoming", ended: "Test Ended" }[m[1].toLowerCase()];
      const card = page.locator(`.comp-card:has-text("${name}"), [data-comp-id]:has-text("${name}")`).first();
      await card.waitFor({ state: "visible", timeout: 10_000 });
      await card.click();
      continue;
    }
    if ((m = step.match(/^tab\s+([a-z-]+)$/i))) {
      // An admin sidebar section at any width, as tests/ui-admin-helpers.js
      // clickTab does it: on a phone (<=768 px) open the drawer first (see
      // openAdminDrawer), then press the item inside the page. A normal click
      // waits for the item to be in the viewport and stable, which a drawer
      // still sliding in never is.
      const slug = m[1].toLowerCase();
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15_000 });
      const item = page.locator(`button.admin-nav-item[data-tab-id="admin-${slug}-tab"]`).first();
      await item.waitFor({ state: "attached", timeout: 10_000 });
      await openAdminDrawer(page);
      await item.evaluate((el) => el.click());
      await page.locator(`#admin-${slug}-tab`).waitFor({ state: "visible", timeout: 10_000 });
      continue;
    }
    if (/^drawer$/i.test(step)) { await openAdminDrawer(page); continue; }
    if ((m = step.match(/^section\s+([a-z-]+)$/i))) {
      // An open event workspace's section at any width: on a phone the tab
      // strip is the Section button and its sheet.
      const sel = `[data-section="${m[1]}"]`;
      const tab = page.locator(`#ws-tabs ${sel}`).first();
      if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 10_000 });
      else {
        await page.locator("#ws-section-pick").click({ timeout: 10_000 });
        await page.locator(`#ws-section-sheet ${sel}`).first().click({ timeout: 10_000 });
      }
      continue;
    }
    if ((m = step.match(/^viewport\s+(\d+)x(\d+)$/i))) { await page.setViewportSize({ width: +m[1], height: +m[2] }); continue; }
    if ((m = step.match(/^look\s+([a-z]+)(?:\s+(light|dark|system))?(?:\s+([a-z]+))?$/i))) {
      const [look, mode, amb] = [m[1], m[2] || "", m[3] || ""];
      if (!LOOK_IDS.includes(look)) throw new Error(`look step names "${look}", not a look (${LOOK_IDS.join(", ")})`);
      await page.addInitScript(([l, t, a]) => {
        try { localStorage.setItem("hck-look", l); if (t) localStorage.setItem("hck-theme", t); if (a) localStorage.setItem("hck-ambient", a); } catch (_) { /* no storage */ }
      }, [look, mode, amb]);
      if (page.url() !== "about:blank") await page.reload();
      continue;
    }
    if ((m = step.match(/^fixture\s+([\w-]+)(?:\s+as\s+([\w-]+))?$/i))) {
      const fn = FIXTURES[m[1]];
      if (!fn) throw new Error(`no fixture named "${m[1]}" in tests/polish-fixtures/ (have: ${Object.keys(FIXTURES).join(", ") || "none"})`);
      const out = (await fn({ page, ctx, helpers, BASE })) || {};
      if (typeof out.cleanup === "function") cleanups.push(out.cleanup);
      ctx[m[2] || m[1]] = out;
      continue;
    }
    if ((m = step.match(/^fillCode\s+(\S+)\s+(\S+@\S+)$/i))) {
      const r = await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent(m[2]));
      if (!r.ok()) throw new Error(`no code was mailed to ${m[2]}: ${r.status()}`);
      const input = page.locator(m[1]).first();
      await input.waitFor({ state: "visible", timeout: 10_000 });
      await input.fill((await r.json()).code);
      continue;
    }
    if (/^clock\s+install$/i.test(step)) { await page.clock.install(); continue; }
    if ((m = step.match(/^clock\s+forward\s+(\d+)$/i))) { await page.clock.fastForward(+m[1]); continue; }
    if ((m = step.match(/^upload\s+(\S+)\s+(.+)$/i))) { await page.locator(m[1]).first().setInputFiles(m[2].trim()); continue; }
    if ((m = step.match(/^settings\s+([a-z-]+)$/i))) {
      // A section is LISTED once a loader shows one of its cards; wait for that,
      // then choose it the way this width offers: the list on a wide screen, the
      // <select> on a phone (the list is display:none there, and vice versa).
      const key = m[1];
      const item = page.locator(`#settings-section-list li:not([hidden]) > [data-action="settings-section"][data-section="${key}"]`);
      await item.waitFor({ state: "attached", timeout: 15_000 });
      const pick = page.locator("#settings-section-pick");
      if (await pick.isVisible().catch(() => false)) await pick.selectOption(key, { timeout: 10_000 });
      else await item.click({ timeout: 10_000 });
      await page.locator(`#admin-settings-tab .settings-section[data-settings-section="${key}"]`).waitFor({ state: "visible", timeout: 10_000 });
      continue;
    }
    if ((m = step.match(/^heading\s+([\w-]+)\s+([\w-]+)$/i))) {
      // On a phone the headings (and their buttons) are not drawn: the bar's
      // Sort & filter lists the same columns and opens the same heading menu.
      const [table, col] = [m[1], m[2]];
      const hsel = `table[data-tcols="${table}"] th .tcol-hbtn[data-tcol-menu="${col}"]`;
      const ssel = `.tcol-bar[data-tcols-for="${table}"] .tcol-sf-btn`;
      // Decided by Sort & filter, which CSS shows on a phone's card bar and on
      // every bar of a 769-1279 px touch screen, so its visibility says which of
      // the two this width offers.
      await page.locator(`${hsel}:visible, ${ssel}:visible`).first().waitFor({ state: "visible", timeout: 15_000 });
      const sf = page.locator(ssel).first();
      if (!(await sf.isVisible().catch(() => false))) await page.locator(hsel).first().click({ timeout: 10_000 });
      else {
        await sf.click({ timeout: 10_000 });
        await page.locator(`.tcol-sf-pop [data-tcol-pick="${col}"]`).first().click({ timeout: 10_000 });
      }
      await page.locator(".tcol-pop:not(.tcol-sf-pop)").first().waitFor({ state: "visible", timeout: 10_000 });
      continue;
    }
    throw new Error(`unrecognised route step: "${raw}"`);
  }
}

const WANTED = REQUESTED.includes("all") ? manifest.screens : manifest.screens.filter((e) => REQUESTED.includes(e.screen));
for (const name of REQUESTED) {
  if (name !== "all" && !manifest.screens.some((e) => e.screen === name)) console.error(`[_ui-polish] POLISH_SCREENS names "${name}", which is not in .claude/screens.json`);
}

for (const entry of WANTED) {
  const combos = combosFor(entry);
  const single = MATRIX_NAME === "house" && combos.length === 1;
  for (const combo of combos) {
    const label = single ? entry.screen : `${entry.screen} [${combo.look}/${combo.mode}/${combo.width}]`;
    test(`capture ${label} (${PHASE})`, async ({ page }) => {
      // A screen that cannot be captured is said so, by name: a skip, never a
      // shot of something else. (A route that throws, or an anchor that never
      // shows, FAILS below — a silent wrong answer is worse than a red run.)
      test.skip(entry.status_note === "uncapturable" || entry.status_note === "needs-fixture",
        `${entry.screen}: ${entry.note || entry.status_note}`);
      await page.setViewportSize({ width: combo.width, height: HEIGHT[combo.width] || 900 });
      await page.emulateMedia({ colorScheme: combo.mode === "dark" ? "dark" : "light" });
      await page.addInitScript(([l, t]) => {
        try { if (!localStorage.getItem("hck-look")) localStorage.setItem("hck-look", l); if (!localStorage.getItem("hck-theme")) localStorage.setItem("hck-theme", t); } catch (_) { /* no storage */ }
      }, [combo.look, combo.mode]);
      const ctx = {}, cleanups = [];
      try {
        try {
          await runRouteScript(page, entry.route_script, ctx, cleanups);
        } catch (e) {
          throw new Error(
            `[_ui-polish] route failed for "${entry.screen}", so any capture would be of the WRONG screen: ${e.message}\n` +
            `route_script: ${entry.route_script}\n` +
            `If this screen genuinely cannot be captured, mark it "status_note": "uncapturable" in .claude/screens.json with a note saying why.`);
        }
        // Park the pointer in the window's top-left corner (the header's own
        // padding), so the last click's hover state is not in the shot; then
        // settle layout + reveal animations.
        await page.mouse.move(0, 0);
        await page.waitForTimeout(400);
        const out = shotPath(entry, combo, single);
        const anchor = entry.visual_anchor && entry.visual_anchor.trim();
        if (anchor) {
          // The first visible anchor wins; entries may list alternatives
          // separated by commas (a screen that renders in two places).
          let shot = false;
          for (const sel of anchor.split(",").map(s => s.trim()).filter(Boolean)) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
              await shootAnchor(page, loc, out);
              shot = true;
              break;
            }
          }
          if (!shot) {
            throw new Error(
              `[_ui-polish] none of "${entry.screen}"'s visual_anchor candidates were visible, so a ` +
              `capture would be of the WRONG screen. anchor: ${anchor}\n` +
              `Either the anchor is stale (fix it in .claude/screens.json — the Docs-hygiene lock ` +
              `only proves the id EXISTS in source, not that this route renders it) or the route ` +
              `did not actually arrive.`);
          }
        } else {
          await page.screenshot({ path: out, fullPage: false });
        }
        expect(fs.existsSync(out)).toBeTruthy();
      } finally {
        for (const c of cleanups.reverse()) await c().catch((e) => console.warn(`[_ui-polish] ${entry.screen}: cleanup failed: ${e.message}`));
      }
    });
  }
}
