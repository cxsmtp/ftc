// @ts-check
const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

// Parallelism knobs — override via env:
//   WORKERS=1      → debug mode (sequential, matches pre-v5.3 behaviour)
//   (unset)        → 24, the measured default (history below), or 2 with
//                    CROSS_BROWSER=1. Each worker spawns its own Node server +
//                    Chromium browser; override (e.g. WORKERS=4) on smaller hosts.
//   TEST_PORT_BASE → override the base port (default 4567). Each worker uses BASE + index.
//   CROSS_BROWSER=1 → opt-in cross-browser / OS / device matrix (the project
//                    list below — desktop OS profiles, laptops, monitors, phones,
//                    tablets and a touchscreen laptop, plus branded Chrome when
//                    installed). Non-Chromium projects run *only*
//                    cross-browser.spec.js and cross-device.spec.js — the full
//                    regression suite still runs on Chromium alone. Requires:
//                      npx playwright install firefox webkit
//                      sudo npx playwright install-deps firefox webkit
//                    See README § Cross-browser testing.
//
// Worker count: the default Chromium suite is API-heavy (request contexts, not
// real browsers) and startup-bound, so it parallelises well. The CROSS_BROWSER
// matrix is the opposite — EVERY test drives a real, heavy browser
// (Firefox/WebKit), so many concurrent engines oversubscribe a typical box (load
// >> cores). Firefox is the most sensitive: when CPU-starved its Juggler agent
// stalls and ops like boundingBox/waitForSelector hang the full test timeout even
// after the element "resolved to visible". The matrix is browser-startup-bound
// (≈same wall-clock at 2 vs 8 workers), so it defaults to 2 — deterministic, no
// contention flakes. Override either with WORKERS=N.
// v7.21.37 — default raised 8 -> 12, MEASURED not assumed. Before the file
// splits, WORKERS=16 bought only 5.8% because one file (ui-admin, 181s of a
// 248s suite) was a serial floor no worker count could shorten. With the four
// biggest files split, the same knob is worth ~17%:
//     W=8 ~200s | W=12 169.4s | W=16 167.9s   (all 1838 passed, 0 flaky)
// 16 beats 12 by ~1% while running four more server+browser pairs on a 12-core
// box, so 12 — the core count — is where the gain actually is. Re-measure with
// `npm run test:balance` after adding tests; it derives its budget from this
// number, so raising it also tightens what counts as a balanced file.
//
// v8.3.32 — default raised 12 -> 18 on an 18-core box, MEASURED not assumed, and
// the model that predicted otherwise was REFUTED by its own stated criterion.
// Medians of 3 runs each, RETRIES=0, 2617 passed every time:
//     W=12 185s | W=14 173s | W=16 166s | W=18 161s | W=20 159s | W=24 156s | W=28 147s
// then re-measured INTERLEAVED, because the desktop tax on this box drifts 1.9-4.5
// cores and a straight sweep confounds it with the knob:
//     W=18 164s | W=24 157s | W=28 155s
// The prediction was that the CORE BUDGET binds at ~14-16 and 18 would lose. It
// does not bind: `/proc/stat` shows the box plateauing at ~16 of 18 cores busy at
// EVERY worker count, because this suite is startup-bound (144 per-file server
// recycles, ~1.7s of boot+seed each) rather than CPU-bound — a worker spends much
// of its life waiting, so its marginal core draw is far below 1. That is also why
// oversubscribing past the core count still pays.
// 18 — the core count — is adopted over the marginally faster 24/28 for the reason
// v7.21.37 adopted 12 over 16: the remaining 4% costs a third more server+browser
// pairs on a box the operator also uses interactively, and 24->28 is only 1.3%.
// Memory is NOT the constraint (min 10.9 GB available, zero swap, even at W=28).
//
// v8.12.3 — default raised 18 -> 24 when the box grew to 24 cores, MEASURED the
// same way: INTERLEAVED rounds (18/24/30, 24/30/18, 30/18/24), RETRIES=0, 3668
// tests every run, medians of 3:
//     W=18 265.3s | W=24 255.5s | W=30 253.8s     (each within ~1% of its median)
// 24 is 3.7% faster than 18; 30 buys only 0.7% more for six more server+browser
// pairs, so 24 — the core count again — is adopted, for the v7.21.37 / v8.3.32
// reason. The suite is still startup-bound: `/proc/stat` shows the box only ~50%
// busy at every one of the three counts.
const WORKERS = parseInt(process.env.WORKERS || (process.env.CROSS_BROWSER === "1" ? "2" : "24"), 10);
const PORT_BASE = parseInt(process.env.TEST_PORT_BASE || "4567", 10);

// v7.15.26 — the WORKER process needs BASE_URL too, not just the servers.
//
// Several specs `require()` an app module directly (lib/attachments, lib/http,
// lib/cxone, lib/event-retention …) to unit-test a pure helper. Every one of
// those pulls in lib/config.js, which runs its boot check AT MODULE LOAD and
// calls process.exit(1) when BASE_URL is unset. In a Playwright worker that is
// fatal and invisible: the run reports only "worker process exited unexpectedly
// (code=1, signal=null)", with every other test on that worker failing as
// collateral and no stack anywhere.
//
// It passed locally for one reason only — the developer's shell happened to
// export BASE_URL — so the suite had a hidden dependency on a machine's
// environment, and CI (which has no such variable) failed while local was
// green. Setting it here makes the worker self-sufficient and identical
// everywhere. The per-worker webServer commands still set their own BASE_URL
// (each needs its own port); this is only for in-worker requires.
process.env.BASE_URL = process.env.BASE_URL || `http://localhost:${PORT_BASE}`;

// v8.8.24 — THE WORKER MUST NOT INHERIT THE DEFAULT `DATA_DIR`, WHICH IS THE
// OPERATOR'S LIVE `./data`.
//
// `lib/config.js` defaults `DATA_DIR` to `./data`, and `lib/log.js` acts on it AT
// REQUIRE TIME: it `mkdirSync`es `LOG_DIR` and then REPLACES `console.log/warn/
// error/debug` with writers into `app-YYYY-MM-DD.jsonl`. Eight `lib/` modules pull
// it at module scope — `attachments`, `admin-alerts`, `cxone`, `badge`, `audit`,
// `comp-allowlist`, `event-admin`, `email` — and four specs require one of those
// at MODULE scope, which runs before any hook. So a Playwright WORKER, which had
// no `DATA_DIR` of its own (`tests/server-env.js` sets one for the spawned CHILD
// only), wrote test output straight into a running deployment's application log.
// Measured: requiring `lib/badge` with `DATA_DIR` pointed at a throwaway path
// creates `<dir>/logs/` and captures a plain `console.log` into it as JSONL.
//
// The existing pins do not cover this. v7.20.2's scanner is about `db.js` opening
// the DATABASE at require time; v7.21.14's is about `lib/email`; v8.1.0 (PR 20)
// tells a spec that calls app code in-process to pin `DATA_DIR` ITSELF — a rule
// per spec, which four specs did not follow and a fifth (added v8.8.20) could not
// have known about. Pinning it once HERE makes the whole class unreachable
// regardless of what any spec requires, which is what the rule should always have
// been. `/data-test-*/` is already gitignored.
//
// v8.12.6 — AND IT MUST NOT INHERIT AN *EXPORTED* ONE EITHER, which is how the
// v8.8.24 pin failed on the one machine it was written for. It read
// `process.env.DATA_DIR || <worker dir>`, and the operator's shell exports
// `DATA_DIR` pointing at the live dev instance (that is how `npm run dev` finds
// its data) — so every Playwright worker started from that shell inherited the
// DEV instance's directory. Measured on 25 Sep 2026: the in-process
// `lib/admin-alerts` units wrote 35 test lines into the dev instance's
// `app-*.jsonl` (the same leak shows on 3 and 7 Sep). Worse by mechanism: a spec
// that `require`s a db-reaching `lib/` module inside a test (`lib/competitions`,
// `lib/leaderboard`, `lib/presence` …) makes `db.js` open `$DATA_DIR/hackathon.db`
// at require time and run the migrations of whatever tree is under test — under
// that shell, against the dev database. The worker's
// directory is therefore UNCONDITIONAL: a spec that needs a different one sets
// `process.env.DATA_DIR` itself, after this file has run (trusted-networks and
// completion-credential point it at the per-file server's directory). The
// spawned servers were never affected — tests/server-env.js builds their env
// from scratch.
process.env.DATA_DIR = path.join(__dirname, `data-test-worker-${PORT_BASE}`);
// v8.8.27 — and UPLOADS_DIR, for the same reason and by the same mechanism.
// It became REQUIRED in this release, and several lib/ modules a spec may
// require in-process reach `lib/config` eagerly (via `lib/log`), so without
// this pin the WORKER ITSELF would exit — not the code under test. The old
// default was `<repo>/uploads`, which server.js sweeps at boot.
process.env.UPLOADS_DIR = path.join(__dirname, `uploads-test-worker-${PORT_BASE}`);

const CROSS_BROWSER = process.env.CROSS_BROWSER === "1";
const LIB_PATH = "/tmp/pw-libs/usr/lib/x86_64-linux-gnu";

// v8.12.4 — LONGEST FILES FIRST, SO THE WORKERS FINISH TOGETHER.
//
// Playwright queues spec files ALPHABETICALLY (collectFiles sorts by name, and
// the dispatcher is a FIFO that hands the next file to whichever worker frees
// up). A spec file never spans workers, so the order is the whole schedule — and
// alphabetical put the long browser files (`ui-admin-*`, `ui-participant-*`,
// `staff-compete-admin-ui`) at the END. Measured at W=24, 3668 tests: the run
// took 186.7 s against a perfect split of 125 s, with worker finish times spread
// over 110-186 s, because the 95 s `staff-compete-admin-ui` did not START until
// 90.9 s and every `ui-*` file started after 105 s.
//
// The fix is longest-processing-time-first. The ONLY ordering lever Playwright
// offers at config level is PROJECT order (the queue is built project by
// project), so the chromium suite is split into up to four same-named projects
// by the per-file wall time recorded in `tests/file-timings.json`:
//
//     bucket 0 — files >= 0.35 x P, plus every file the manifest does not know
//     bucket 1 — files >= 0.20 x P
//     bucket 2 — files >= 0.10 x P
//     bucket 3 — the rest            (P = recorded total / WORKERS)
//
// Why these edges: simulated against the recorded timings at W = 4, 8, 12, 18,
// 24 and 30, they land within ~6 s of an exact LPT schedule at every count,
// where fixed-second edges drifted badly at the counts they were not tuned for.
// Why not one project per file: a worker PROCESS restarts whenever the next job
// belongs to a different project (the worker hash includes the project id), so
// every bucket boundary costs each worker one restart — four buckets cost at
// most three, the ~1 s each the simulation charged.
//
// All buckets are NAMED "chromium" on purpose. `filterProjects` matches by name
// and accepts duplicates, so `--project=chromium` still selects the whole suite;
// snapshot paths (`{projectName}`) are unchanged, so the visual-regression
// baselines keep resolving; and every report line still reads `[chromium]`.
// Playwright gives duplicate names distinct internal ids, so nothing collides.
//
// An UNKNOWN file (added since the manifest was written) goes in bucket 0: a
// new long file scheduled first costs nothing, one scheduled last is the defect
// this exists to prevent. `npm run test:balance -- --write` regenerates the
// manifest and reports files that are missing from it or stale in it.
const fs = require("fs");
const TIMINGS_PATH = path.join(__dirname, "tests", "file-timings.json");
const BUCKET_EDGES = [0.35, 0.2, 0.1];
function chromiumBuckets(workers) {
  let files = {};
  try { files = JSON.parse(fs.readFileSync(TIMINGS_PATH, "utf8")).files || {}; } catch (_) { /* no manifest: one bucket */ }
  const known = Object.keys(files);
  const esc = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ignoreUnderscore = process.env.CAPTURE_SCREENSHOTS === "1" ? [] : ["**/_*.spec.js"];
  const byName = (list) => new RegExp(`(^|[\\\\/])(${list.map(esc).join("|")})$`);
  const base = (i) => ({ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, metadata: { bucket: i } });
  if (!known.length) return [{ ...base(0), testIgnore: ignoreUnderscore }];
  const total = known.reduce((a, f) => a + files[f], 0);
  const P = total / Math.max(1, workers);
  const edges = BUCKET_EDGES.map((x) => x * P);
  const bucketOf = (f) => { for (let i = 0; i < edges.length; i++) if (files[f] >= edges[i]) return i; return edges.length; };
  const lists = Array.from({ length: edges.length + 1 }, () => []);
  for (const f of known) lists[bucketOf(f)].push(f);
  const projects = [];
  // Bucket 0 = long known files + everything unknown: match all, ignore the
  // known files that belong to later buckets.
  const later = known.filter((f) => bucketOf(f) > 0);
  projects.push({ ...base(0), testIgnore: [...ignoreUnderscore, ...(later.length ? [byName(later)] : [])] });
  for (let i = 1; i < lists.length; i++) {
    if (!lists[i].length) continue;
    projects.push({ ...base(i), testMatch: byName(lists[i]), testIgnore: ignoreUnderscore });
  }
  return projects;
}

// v7.20.0 — workerServer() lived here. Its 40-key hermetic env now lives in
// tests/server-env.js, because the per-file spawner needs the SAME parameters
// and a second copy would drift silently: the suite would still run, just
// against a subtly different server than CI's.


module.exports = defineConfig({
  testDir: "./tests",
  // Underscore-prefixed specs (e.g. _screenshots.spec.js) are opt-in tooling,
  // not part of the regression suite. They run only when explicitly invoked
  // (e.g. via `npm run docs:shots`) and otherwise stay out of the default
  // `npm test` sweep so they never gate CI.
  testIgnore: process.env.CAPTURE_SCREENSHOTS === "1" ? [] : ["**/_*.spec.js"],
  globalSetup: "./tests/global-setup.js",   // v7.20.0 — port sweep only; seeding is per-file
  // 60s test timeout — the API tests typically finish in <1s, but UI tests
  // running in headless Chromium under multi-worker CPU contention can need
  // 30+ seconds for the post-login JS chain (loadCsrfToken + buildAdminNav +
  // showMain + 6 admin* loaders) to fully render. Generous timeout absorbs
  // load spikes without creating false negatives.
  timeout: 60_000,
  // One retry absorbs CPU-contention flakes (UI tests waiting for renders
  // when Chromium is descheduled). Real test bugs deterministically fail both
  // the original and the retry, so we still see them — but the suite as a
  // whole stays green under load. Override via RETRIES=0 for strict mode.
  retries: parseInt(process.env.RETRIES || "1", 10),
  workers: WORKERS,
  // Playwright's default is file-per-worker parallelism. Tests within a file
  // stay serial (which is what our shared S.alice/bob/carol + ensureState
  // pattern relies on). To distribute N worker processes across M files,
  // we split the 4 original specs into 8 so one-file-per-worker evenly loads.
  fullyParallel: false,
  use: {
    // NOTE: baseURL is deliberately NOT set here — a hardcoded value would
    // pin every worker's page.goto() + page.request.* to the same server
    // (port PORT_BASE = worker 0), even though each worker has its own
    // server on PORT_BASE + TEST_PARALLEL_INDEX. That caused cross-worker
    // auth failures where a non-zero worker's page hit worker 0's server
    // with its own (different) superadmin password. Each UI spec file
    // sets baseURL = helpers.BASE which is TEST_PARALLEL_INDEX-scoped.
    headless: true,
    viewport: { width: 1280, height: 800 },
    // v8.3.26 — BOUND AN ACTION SO A STALL FAILS WHERE IT HAPPENS.
    //
    // Playwright defaults `actionTimeout` and `navigationTimeout` to 0, which
    // means "no limit of your own — use the TEST budget". With `timeout:
    // 60_000` above, one stalled `page.request.*`, `page.goto` or `.click()`
    // silently ate the whole test and the report then named whichever step was
    // executing when the clock ran out. Measured: a test whose median duration
    // is 1.3 s failed at 120 s pointing at a `/api/csrf-token` in its cleanup —
    // a step with ~90x headroom, i.e. the number said nothing about the cause.
    //
    // These are CEILINGS, not budgets to work within: the same steps measure
    // 116-350 ms at p90 under a saturated box, so 20 s is 60-170x headroom and
    // no passing test moves. What changes is that a hang is now attributed to
    // the action that hung, and a test keeps enough of its 60 s to run its
    // `finally` — the cleanup that stops one failure contaminating the file.
    //
    // `expect()` is deliberately NOT set here: it has its own 5 s default, and
    // ~223 assertions in the suite already opt into something longer.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    launchOptions: { env: { ...process.env, LD_LIBRARY_PATH: LIB_PATH } },
  },
  // Project matrix:
  //   • chromium (always): full regression suite. Default `npm test`.
  //   • firefox / webkit / mobile-chrome / mobile-webkit (opt-in, CROSS_BROWSER=1):
  //     run ONLY tests/cross-browser.spec.js — a small smoke that covers
  //     layout, CSP, Trusted Types fallback, and the mobile Help-drawer
  //     bottom-cutoff regression. Tripling CI time for the full suite on
  //     three engines is not worth it — the smoke catches the categories
  //     of bugs that actually diverge between engines.
  projects: [
    ...chromiumBuckets(WORKERS),
    ...(CROSS_BROWSER ? [
      {
        name: "firefox",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: {
          ...devices["Desktop Firefox"],
          viewport: { width: 1280, height: 800 },
          // Firefox's Juggler agent goes unresponsive when the browser is
          // CPU-starved under the multi-engine matrix load (operations like
          // boundingBox/waitForSelector hang for the full test timeout even
          // though the element already "resolved to visible"). Shrink Firefox's
          // process/CPU footprint so its parent process keeps servicing the
          // protocol: a single content process (no fission/site-isolation
          // fan-out), software rendering, and no animations. (launchOptions
          // replaces the global one, so re-supply the NSS-libs env shim.)
          launchOptions: {
            env: { ...process.env, LD_LIBRARY_PATH: LIB_PATH },
            firefoxUserPrefs: {
              "dom.ipc.processCount": 1,
              "fission.autostart": false,
              "layers.acceleration.disabled": true,
              "gfx.canvas.accelerated": false,
              "general.smoothScroll": false,
              "toolkit.cosmeticAnimations.enabled": false,
            },
          },
        },
      },
      {
        name: "webkit",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
      },
      {
        name: "mobile-chrome",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["Pixel 7"] },
      },
      {
        name: "mobile-webkit",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["iPhone 14"] },
      },
      // v6.16.36 — iPad landscape (iOS Safari, ~1194x834). The form
      // factor sits between phone-portrait (~390x844) and desktop
      // (1280x800), so it exercises the in-between media-query
      // breakpoints (768px / 900px) that neither phone-portrait nor
      // desktop-chrome do. iPad portrait would mostly behave like
      // phone-portrait here at the markup level (single-column
      // reflow at <600px doesn't fire); landscape is the
      // differentiated coverage worth running on every PR.
      {
        name: "tablet-webkit-landscape",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["iPad Pro 11 landscape"] },
      },
      // v6.16.37 — Samsung phone + tablet (Chromium-engine proxies).
      // Playwright doesn't bundle the Samsung Internet browser; it
      // ships only Chromium / Firefox / WebKit. Samsung Internet is
      // a Chromium fork (Blink-based) with Samsung-specific UI
      // quirks, so a Chromium project with a Samsung viewport + UA
      // approximates ~95% of what Samsung Internet would surface.
      // The residual 5% (default-font fallbacks, scroll-behavior
      // differences, dark-mode auto-tinting, Samsung's PWA quirks)
      // requires a real device or a paid cloud (BrowserStack /
      // Sauce / LambdaTest) — see README § Cross-browser testing.
      //
      // v6.16.38 — bumped from Galaxy S9+ → Galaxy S24 (closest
      // bundled profile to S25-class) and Galaxy Tab S4 landscape
      // → Galaxy Tab S9 landscape. Both are now in Playwright's
      // bundled device list. The S9+/Tab S4 profiles I started
      // with predated the upstream additions; the S24 / Tab S9
      // profiles match what most Samsung-customer deployments are
      // actually running today.
      {
        name: "mobile-chrome-samsung",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["Galaxy S24"] },
      },
      {
        name: "tablet-chrome-samsung-landscape",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["Galaxy Tab S9 landscape"] },
      },
      // v7.23.0 — PHONE LANDSCAPE and TABLET PORTRAIT. Until now every phone
      // profile was portrait and every tablet profile was landscape, so two
      // whole form factors had ZERO coverage — and they are not cosmetic gaps:
      //
      //   • `@media(max-height:450px)` in public/styles.css was exercised by no
      //     project at all. It forces the header to `flex-wrap:nowrap`, which
      //     was measured giving every participant screen 343-461px of
      //     PAGE-WIDE horizontal scroll on a landscape phone.
      //
      //   • The only guard against iOS Safari's focus-zoom is
      //     `@media(max-width:600px){input,select,textarea{font-size:16px}}`
      //     (styles.css:153), and it is WIDTH-scoped. Every viewport below is
      //     WIDER than 600px, so the guard does not fire: 750, 780, 834, 640.
      //     The base rule at styles.css:150 sets font-family but no font-size,
      //     so controls fall back to the UA default (~13.3px in Blink/Gecko)
      //     and iOS zooms the page on focus without zooming back out on blur.
      //
      // Engine note: Playwright's Linux `webkit` is WebKitGTK, not Apple
      // WebKit, and its UA form-control default is already 16px — so these
      // projects catch the LAYOUT half (overflow, occlusion, target size)
      // reliably and CANNOT certify the iOS-zoom half. Pair any zoom assertion
      // with a source check that styles.css:150 declares a font-size.
      {
        name: "mobile-webkit-landscape",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["iPhone 14 landscape"] },   // 750x340 — shortest viewport in the matrix
      },
      {
        name: "mobile-chrome-samsung-landscape",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["Galaxy S24 landscape"] },  // 780x360 — Blink sibling of the above
      },
      {
        name: "tablet-webkit-portrait",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["iPad Pro 11"] },           // 834x1194 — iPadOS is WebKit-only
      },
      {
        name: "tablet-chrome-samsung-portrait",
        testMatch: /cross-(browser|device)\.spec\.js$/,
        use: { ...devices["Galaxy Tab S9"] },         // 640x1024 — narrowest tablet; 640 > 600
      },
      // v8.12.4 — OPERATING SYSTEMS, LAPTOPS, LARGE AND ROTATED MONITORS, AND
      // THE TOUCHSCREEN LAPTOP. The twelve projects above covered phones and
      // tablets in both orientations but only ONE desktop size (1280x800), no
      // touchscreen laptop and no operating-system difference at all.
      //
      // What an "OS" can and cannot be here, measured rather than assumed:
      // Playwright never emulates `navigator.platform` (it reads "Linux x86_64"
      // under every profile), so a Windows or macOS project is its user agent,
      // its VIEWPORT, its DEVICE-PIXEL-RATIO and its SCROLLBARS — which are
      // exactly the OS differences this app can feel:
      //   • Windows draws CLASSIC scrollbars that take ~15-17px of layout width.
      //     Headless Chromium hides them by default (`--hide-scrollbars`), so
      //     the "a 100vw element or a vertical scrollbar pushes the page
      //     sideways" class was exercised by no project. Removing that default
      //     arg brings back a real 15px scrollbar (measured). Firefox's headless
      //     build stays on overlay scrollbars even with the GTK prefs forced off
      //     (measured), so the Windows Firefox project cannot model this half.
      //   • Windows laptops ship at FRACTIONAL scaling (1920x1080 @125% is a
      //     1536x864 CSS viewport at DPR 1.25), a sub-pixel rounding regime no
      //     integer-DPR project reaches.
      //   • macOS is DPR 2 with overlay scrollbars.
      // NOT its screen. From Playwright 1.64 the test runner forwards the device
      // DESCRIPTOR's `screen` (before, no screen was set: Chromium and WebKit
      // reported the viewport, Firefox a fixed 1366x768 — measured), so every
      // project spreading "Desktop Chrome"/"Desktop Edge"/"Desktop Firefox" —
      // the chromium buckets and every browser.newContext() under them
      // included — reports window.screen 1920x1080, and every
      // "Desktop Safari" one 1792x1120, whatever laptop the viewport describes
      // (measured: windows-chrome-desktop-portrait is a 1080x1920 viewport on a
      // landscape screen; a portrait isMobile context under chromium reports
      // screen.orientation "landscape-primary"). The phone descriptors gained a
      // realistic screen — iOS keeps a portrait screen in landscape, as the real
      // device does. Deliberately NOT overridden: layout, CSS orientation and
      // every width/height/pointer query this app uses read the viewport, and
      // were measured unchanged on all three engines. That holds only while the
      // app reads no window.screen / window.orientation and uses no
      // device-width / device-height media feature — tests/screen-inert.spec.js
      // locks exactly that, and is where to start if it ever has to change.
      // iOS and Android were already present as the phone/tablet projects above.
      //
      // Input modes: a Chromium context with `hasTouch` is a TOUCH-ONLY device
      // (`pointer: coarse`, `hover: none` — measured, whatever the width), which
      // is how a Windows 2-in-1 in tablet mode presents, and the only way to
      // reach the `(pointer: coarse) and (min-width:601px)` rules on a laptop-
      // sized screen. Every other desktop/laptop project is `pointer: fine` +
      // `hover: hover`, i.e. mouse OR trackpad — CSS cannot tell those apart, so
      // tests/cross-device.spec.js drives both input STYLES (fine-grained
      // horizontal wheel panning for a trackpad, line-style vertical wheel for a
      // mouse) on these projects.
      ...(() => {
        const X = /cross-(browser|device)\.spec\.js$/;
        const env = { ...process.env, LD_LIBRARY_PATH: LIB_PATH };
        const classicScrollbars = { env, ignoreDefaultArgs: ["--hide-scrollbars"] };
        const macChromeUA = devices["Desktop Chrome"].userAgent.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7");
        const macFirefoxUA = devices["Desktop Firefox"].userAgent.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10.15");
        const ffPrefs = {  // the same footprint trims as the `firefox` project above
          "dom.ipc.processCount": 1, "fission.autostart": false, "layers.acceleration.disabled": true,
          "gfx.canvas.accelerated": false, "general.smoothScroll": false, "toolkit.cosmeticAnimations.enabled": false,
        };
        const list = [
          // Windows — Chrome/Edge (Chromium), Firefox.
          { name: "windows-chrome-laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, launchOptions: classicScrollbars } },
          { name: "windows-edge-laptop", use: { ...devices["Desktop Edge"], viewport: { width: 1366, height: 768 }, launchOptions: classicScrollbars } },
          { name: "windows-firefox-laptop", use: { ...devices["Desktop Firefox"], viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, launchOptions: { env, firefoxUserPrefs: ffPrefs } } },
          { name: "windows-chrome-touch-laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 }, hasTouch: true, launchOptions: classicScrollbars } },
          { name: "windows-chrome-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 }, launchOptions: classicScrollbars } },
          { name: "windows-chrome-desktop-portrait", use: { ...devices["Desktop Chrome"], viewport: { width: 1080, height: 1920 }, launchOptions: classicScrollbars } },
          // macOS — Safari (WebKit), Chrome, Firefox; retina, overlay scrollbars.
          { name: "macos-safari-laptop", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
          { name: "macos-chrome-laptop", use: { ...devices["Desktop Chrome"], userAgent: macChromeUA, viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 } },
          { name: "macos-firefox-laptop", use: { ...devices["Desktop Firefox"], userAgent: macFirefoxUA, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, launchOptions: { env, firefoxUserPrefs: ffPrefs } } },
          { name: "macos-safari-desktop", use: { ...devices["Desktop Safari"], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 } },
        ];
        // Branded GOOGLE CHROME, not Playwright's Chromium, wherever it is
        // installed (`channel: "chrome"` finds /opt/google/chrome on Linux).
        // Auto-detected rather than required: the CI image does not ship it, and
        // a project that fails to launch would turn the whole matrix red for a
        // browser nobody on that machine can run. Set NO_BRANDED_CHROME=1 to omit.
        const chromePath = process.env.CHROME_PATH || "/opt/google/chrome/chrome";
        if (!process.env.NO_BRANDED_CHROME && fs.existsSync(chromePath)) {
          list.push({ name: "google-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 800 }, launchOptions: { env } } });
        }
        return list.map((p) => ({ ...p, testMatch: X }));
      })(),
    ] : []),
  ],
  // v7.20.0 — NO webServer. Server lifecycle moved to tests/isolated-test.js,
  // which replaces the worker's server (same port, wiped data dir, fresh seed)
  // before EVERY spec file. Playwright's webServer is per-RUN, which is exactly
  // the worker-scoped boundary that let one file's mutations leak into the
  // next; leaving it enabled would also fight the per-file spawn for the port.
});
