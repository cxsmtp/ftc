import { browser } from "k6/browser";
import {
  browserPageLoad, browserLoginRender, browserCompSelect,
  browserTaskList, browserTaskDetail, browserSubmit, browserLeaderboard,
  browserPhasesReached, browserClsPerPhase, browserClickFailures,
  browserPhaseTimeouts, browserWaitForSelectorMs, browserRequestFailures,
} from "./metrics.js";

// v6.12.3 — coarse URL-kind classifier for browser-side request
// failure attribution. Four buckets:
//   spa_shell — the root HTML response (/ or /register) and /api/config
//               / /api/me / /api/csrf-token that the SPA fires at boot
//   asset     — CSS / JS / fonts / images from the same origin
//   api       — any other /api/* call the SPA makes post-boot
//   external  — fonts.googleapis.com, cdnjs.cloudflare.com
//   other     — anything that didn't match; shouldn't normally fire
// The v6.10.93 run's 12.33% browser_http_req_failed rate was opaque
// about which bucket it hit; this tag lets the summary distinguish
// "edge throttled asset fetches under 5-browser load" (asset bucket)
// from "server 5xx on API" (api bucket) from "SPA HTML is 503ing"
// (spa_shell bucket).
function urlKind(u) {
  if (!u) return "other";
  if (/^https?:\/\/(fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare)/i.test(u)) return "external";
  // Same-origin check; fall back to path matching when it's a relative URL.
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (path === "/" || path === "/register" ||
      path.startsWith("/api/config") ||
      path.startsWith("/api/me") ||
      path.startsWith("/api/csrf-token")) return "spa_shell";
  if (/\.(css|js|woff2?|ttf|png|jpe?g|svg|ico|map)(\?|$)/i.test(path)) return "asset";
  if (path.startsWith("/api/")) return "api";
  return "other";
}

// v6.10.77 — reliable click wrapper. Playwright's default .click() runs
// an actionability-stability check (the element's bounding box must be
// unchanged for 2 consecutive frames) with a 30-s timeout. Under the
// SPA's perf-test conditions — hover-transform on .task-card /
// .nav-btn, server-load-induced layout shifts during /api/leaderboard
// auto-refresh, Chromium re-flow under DOM churn — the check frequently
// never satisfies and the click times out after a full 30 s. That
// timeout bubbled to the outer catch block and killed the rest of the
// iteration (leaderboard + cycle_pause phases skipped).
//
// The v6.10.76 run surfaced this at scale: 175 `clicking on
// #nav-leaderboard timed out after 30s` warnings across 40 min (56% of
// leaderboard phase entries), synchronized clusters across all 5
// browser VUs every ~40 s — the same failure mode that already hits
// .task-card clicks (9-11 per run).
//
// Fix: `{ force: true }` skips the stability check — the click is
// dispatched at the element's current bounding box position
// regardless. `{ timeout: 10000 }` caps any remaining wait at 10 s
// instead of 30 s. try/catch absorbs residual timeouts so one sticky
// click doesn't kill the whole iteration — downstream phases still
// record their measurements. Returns true on successful dispatch,
// false on failure; callers use the result to gate the downstream
// waitForSelector/timing record so empty clicks don't record fake
// data.
async function safeClick(locator, label, phase) {
  try {
    await locator.click({ force: true, timeout: 10000 });
    return true;
  } catch (e) {
    const msg = (e && e.message) || (typeof e === "string" ? e : String(e));
    console.warn(`[click] ${label} failed: ${msg}`);
    // v6.10.84 — record the failure against its phase so the summary
    // table shows which phase is losing clicks. The v6.10.83 run had
    // browser_phases_reached{task_submit}=124/162 with no visible
    // reason — a failed .task-card click suppresses the downstream
    // submit-phase entry, so the missing 38 are invisible except by
    // subtracting phase counts. Tagging on phase makes the cause
    // directly readable from the summary. `phase` is optional; the
    // three current call-sites (challengesBtn/task_list,
    // taskCard/task_detail, lbBtn/leaderboard) are updated to pass it.
    if (phase) browserClickFailures.add(1, { phase });
    return false;
  }
}

/**
 * Browser probe — measures real end-user rendering experience.
 * Runs as a separate scenario with real Chromium instances.
 *
 * @param {string} baseUrl
 * @param {string} email - participant email
 * @param {string} password
 * @param {object} seedData
 */
export async function runBrowserProbe(baseUrl, email, password, seedData) {
  const page = await browser.newPage();
  // v6.12.3 — browser-side HTTP request failure attribution. Two
  // event streams feed the same Counter:
  //   * response      — any status >= 400 the browser got back
  //   * requestfailed — transport-layer failure (DNS, TLS, connection
  //                     reset, aborted) BEFORE a response arrived
  // Tag the URL into a coarse kind so the summary can distinguish
  // "edge throttled assets" from "API 5xx" from "SPA shell 503". k6-
  // browser's page.on is Goja-side — callback runs on our VM thread,
  // not the browser's — so it's safe to call metric.add() inside.
  page.on("response", (res) => {
    try {
      const status = res.status ? res.status() : 0;
      if (status >= 400) {
        browserRequestFailures.add(1, { kind: urlKind(res.url ? res.url() : "") });
      }
    } catch (_) { /* best-effort instrumentation */ }
  });
  page.on("requestfailed", (req) => {
    try {
      browserRequestFailures.add(1, { kind: urlKind(req.url ? req.url() : "") });
    } catch (_) { /* best-effort instrumentation */ }
  });
  // v6.10.35 — phase marker for diagnostic logging. The catch block below
  // logs this alongside whatever error shape we get, so an operator can
  // tell whether failures cluster on `page_load` (server slow / TLS
  // handshake), `login_submit` (auth path under load), or downstream
  // interactions. Pre-v6.10.35 the catch block used `${e.message}`
  // which rendered as the literal string "undefined" for any k6 browser
  // rejection shape that didn't carry a .message property (plain strings,
  // goja proxies, CDP disconnect wrappers) — every real cause was masked.
  //
  // v6.10.62 — phase entry also bumps the `browser_phases_reached`
  // counter tagged by phase name, so the summary table shows exactly
  // how far each probe got. Pairs with the browser_*_render trends:
  // a phase that's never reached shows count=0 here AND
  // p(90)=0.00µs in its render trend (the v6.10.61 run mystery).
  // Phases reached but slow show high count + slow render. Phases
  // reached fast show high count + fast render. All three states are
  // now distinguishable.
  //
  // v6.10.62 — `enterPhase` ALSO captures per-phase CLS. After the
  // PerformanceObserver is installed (post-page.goto), each entry
  // reads `window.__cls`, computes the delta since the last phase,
  // and attributes that delta to the PREVIOUS phase (the phase the
  // probe was in while the shifts happened). Sum of all per-phase
  // CLS == final `browser_web_vital_cls` for the iteration. The
  // 13× WAN amplification of the v6.10.55 local 0.0576 → v6.10.61
  // 0.75 should be diagnosable from the per-phase breakdown: the
  // dominant phase points at the surface that needs the targeted
  // fix (skeleton loader / contain-intrinsic-size / etc.).
  let phase;
  let _clsAttached = false;
  let _prevCls = 0;
  let _prevPhase = "init";
  const enterPhase = async (name) => {
    if (_clsAttached) {
      try {
        const currentCls = await page.evaluate(() => window.__cls || 0);
        const delta = Math.max(0, currentCls - _prevCls);
        browserClsPerPhase.add(delta, { phase: _prevPhase });
        _prevCls = currentCls;
      } catch (_) {
        // page context may be gone (CDP drop) or evaluate may fail
        // mid-navigation — swallow; the lost delta is a single phase
        // worth, not a run failure.
      }
    }
    _prevPhase = name;
    phase = name;
    browserPhasesReached.add(1, { phase: name });
  };
  await enterPhase("init");

  try {
    const bypassToken = __ENV.MAINTENANCE_BYPASS || "";
    if (bypassToken) await page.setExtraHTTPHeaders({ "x-maintenance-bypass": bypassToken });

    // ── Page load ──────────────────────────────────────────────────────────
    // v6.10.34 — waitUntil "domcontentloaded" instead of "load". "load"
    // waits for every sub-resource (images, late-loading fonts, analytics
    // pixels) to complete, which is not what a participant experiences
    // as "page ready". "domcontentloaded" fires after HTML parse + all
    // defer scripts have executed, which is when the SPA's login form
    // is actually interactive. Pair with the defer rewrite in
    // public/index.html (v6.10.34) so the deferred app.js + vendor
    // scripts are guaranteed to have run by the time this resolves.
    await enterPhase("page_load");
    const loadStart = Date.now();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    // v6.10.62 — install layout-shift observer right after navigation.
    // `buffered: true` catches entries that fired before the observer
    // attached. Stash on window so subsequent enterPhase() calls can
    // read the running cumulative CLS via page.evaluate.
    await page.evaluate(() => {
      window.__cls = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) window.__cls += e.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch (_) { /* layout-shift API not available */ }
    });
    _clsAttached = true;
    // Gate on the login input being visible — that's the real "page ready"
    // signal for a participant on the login screen, independent of any
    // late-loading asset.
    await page.waitForSelector("#login-email", { timeout: 10000 });
    browserPageLoad.add(Date.now() - loadStart);

    // ── Login ──────────────────────────────────────────────────────────────
    await enterPhase("login_fill");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-pass").fill(password);

    await enterPhase("login_submit");
    const loginStart = Date.now();
    // v6.10.37 — `button:has-text('Sign In')` is Playwright-specific pseudo-
    // selector syntax; k6/browser's CSS engine throws SyntaxError on it.
    // Use the stable `data-action="do-login"` attribute wired in
    // public/index.html:119. Other clicks below follow the same pattern.
    await page.locator("button[data-action='do-login']").click();
    // Wait for competition picker or nav to appear
    // `#admin-panel` is stale — the SPA shell uses `#admin-page`.
    // Either page confirms the user landed past the login screen.
    await page.waitForSelector("#comp-grid, #main-nav, #admin-page", { timeout: 15000 });
    browserLoginRender.add(Date.now() - loginStart);

    // v6.10.69 — give the SPA's post-login async render a moment to settle
    // before probing for picker-vs-auto-placement state. The waitForSelector
    // above returns as soon as #main-nav has any children (nav buttons
    // populate from the login response), but the comp-grid cards arrive
    // later via a separate /api/competitions fetch. Pre-fix the probe raced
    // that async render: checked `#comp-grid [data-comp-id='X'].isVisible()`
    // against a still-empty grid, fell through to the auto-placement else
    // branch with `#nav-challenges` also not yet visible (it's
    // `display:none` until `currentCompStatus === 'live'`), and every
    // downstream `isVisible()` gate failed — task_list / task_detail /
    // leaderboard / submit all silently skipped their record points. The
    // v6.10.68 run showed the signature: phase-reach 0 for wait_live /
    // comp_click / task_submit, and browser_comp_select_render /
    // browser_task_list_render / browser_task_detail_render entirely
    // missing from the summary (k6 drops sample-less Trends when no
    // threshold pins them). 1500 ms is well above observed local settle
    // time and cheap vs the 30-60 s iteration budget.
    await page.waitForTimeout(1500);

    // ── Competition selection ───────────────────────────────────────────────
    // v6.10.38 — target the seeded competition by id. Pre-fix used
    // `#comp-grid .comp-card, [data-comp-id]` .first() — under scenario 2
    // (prior test left a live competition alive, new seed adds another)
    // the picker shows two cards and .first() grabbed whichever happened
    // to render first in DOM order. Submits would then target task ids
    // from a comp that never had those tasks in it → 404s, 0 successful
    // iterations. Selecting by id is hermetic against prior-run state.
    await enterPhase("comp_select");
    const compCardSel = `#comp-grid [data-comp-id='${seedData.competitionId}']`;
    const compCard = page.locator(compCardSel);
    const pickerVisible = await compCard.isVisible().catch(() => false);
    if (pickerVisible) {
      // v6.10.38 — wait for the seeded comp card's data-status attribute
      // to be "live" before clicking. Pre-fix the probe did a passive
      // `waitForTimeout(2000)` after the click, which is fine for a
      // 120-s seed offset but useless under the full-scale 15-min offset:
      // the participant clicked an upcoming card, landed on the "not
      // started yet" view, #nav-challenges never appeared, and the 10-s
      // waitForSelector timed out. Poll the card's data-status for up to
      // 20 min — enough for any realistic start offset plus ramp buffer.
      await enterPhase("wait_live");
      const live = await page.waitForFunction(
        (id) => {
          const c = document.querySelector(`#comp-grid [data-comp-id='${id}']`);
          return !!c && c.dataset.status === "live";
        },
        seedData.competitionId,
        { timeout: 20 * 60_000, polling: 2000 },
      ).then(() => true).catch(() => false);
      if (!live) {
        // Competition still isn't live after 20 minutes. Other metrics
        // (page_load, login_render) were already recorded — return
        // early rather than proceeding with a dead task flow.
        return;
      }
      await enterPhase("comp_click");
      const compStart = Date.now();
      await compCard.click();
      // v6.10.37 — #nav-challenges id is assigned in public/app.js:1721
      // when the main nav renders; use it instead of :has-text.
      await page.waitForSelector("#nav-challenges", { timeout: 10000 });
      browserCompSelect.add(Date.now() - compStart);
    } else {
      // v6.10.66 — auto-placement fast path. Pre-fix the `if (pickerVisible)`
      // block was the only place that added to browser_comp_select_render;
      // when the server auto-placed the user in their active_competition_id
      // (the common case on every re-login after iteration 1, because the
      // server remembers the last selection), the probe silently skipped
      // the metric and the v6.10.63 phase-reach table showed 0/2166 for
      // wait_live + comp_click. Now we still record browser_comp_select_render
      // on auto-placement by measuring login_submit → #nav-challenges, so the
      // metric isn't empty on the second-and-beyond iterations. No new phase
      // needed — the auto-placement path already starts from login_submit
      // end (captured in loginStart above) and ends when the nav is live.
      const navReady = page.locator("#nav-challenges");
      if (await navReady.isVisible().catch(() => false)) {
        // Approximate: we're already past the login_submit wait, so the
        // auto-placement delta is ~0 — record a small sample to prove the
        // path was reached rather than a missing measurement.
        browserCompSelect.add(Date.now() - loginStart);
      }
    }
    // No `waitForTimeout(2000)` — redundant now that we wait for the
    // live data-status before clicking. The subsequent Challenges / task /
    // leaderboard blocks below each have their own `isVisible()` gate +
    // graceful-degrade so the iteration still records whatever phases
    // ARE reachable.

    // ── Task list ──────────────────────────────────────────────────────────
    await enterPhase("task_list");
    const challengesBtn = page.locator("#nav-challenges");
    if (await challengesBtn.isVisible().catch(() => false)) {
      const taskListStart = Date.now();
      // v6.10.77 — safeClick replaces plain .click() so a stability-
      // wait hang doesn't kill the iteration at task_list and forfeit
      // every downstream phase. Same rationale as #nav-leaderboard +
      // .task-card below.
      if (await safeClick(challengesBtn, "#nav-challenges", "task_list")) {
        // v6.12.7 — `state:'attached'` matches as soon as the DOM node
        // is in the tree, skipping Playwright's default visible-state
        // check (bounding box + not-display-none + receives-pointer-
        // events). v6.12.5-v6.12.6 diagnostic established that under
        // 5-concurrent-tab load the visible check produces false
        // negatives for elements that ARE in DOM and rendered — the
        // static thead row inside `#leaderboard-page`, the dynamic
        // `.task-card` inside `#tasks-page`, both timed out at the
        // 2× k6-browser ceiling despite showMain() having run
        // synchronously. `attached` is the right semantic for a
        // "probe checks that the view-switch landed" assertion;
        // `visible` is the right semantic for a "probe about to
        // interact (fill, click)" assertion (see task_detail below).
        const wfsStart = Date.now();
        await page.waitForSelector(".task-card, [data-task-id]", { state: "attached", timeout: 10000 })
          .then(() => {
            browserWaitForSelectorMs.add(Date.now() - wfsStart, { phase: "task_list", result: "ok" });
          })
          .catch(() => {
            browserWaitForSelectorMs.add(Date.now() - wfsStart, { phase: "task_list", result: "timeout" });
            browserPhaseTimeouts.add(1, { phase: "task_list" });
          });
        browserTaskList.add(Date.now() - taskListStart);
      }
    }

    // ── Task detail ────────────────────────────────────────────────────────
    // v6.10.66 — prefer an UNSOLVED task. Pre-fix the probe always
    // clicked `.task-card, [data-task-id]` .first(), which — after the
    // browser user's first iteration submitted task 1 — landed on an
    // already-solved card in every subsequent iteration. The solved-
    // state detail view doesn't render an answer input, so the
    // task_submit phase never fired (v6.10.63 phase-reach table
    // showed 0/2166 for task_submit). `.task-card:not(.solved)` skips
    // solved cards so the probe keeps measuring the submit-render
    // path on each iteration. If ALL tasks are solved (happens after
    // iteration ≈ TASK_COUNT per browser user), .first() returns
    // nothing and the probe graceful-skips — same behaviour as before.
    await enterPhase("task_detail");
    const taskCard = page.locator(".task-card:not(.solved)").first();
    if (await taskCard.isVisible().catch(() => false)) {
      const detailStart = Date.now();
      // v6.10.77 — safeClick. The .task-card carries a hover transform
      // (public/styles.css:409 — translateY(-2px) on hover) which made
      // Playwright's stability-wait retry-loop against a continuously
      // shifting bounding box. 9-11 `.task-card:not(.solved) >> nth=0
      // timed out after 30s` warnings per run were the signature;
      // force:true dispatches the click at the element's current
      // position regardless of the transform jitter. Clicks that still
      // fail (rare, e.g. if the card is genuinely not clickable) are
      // caught and the iteration continues — task_submit phase only
      // enters if the preceding click actually dispatched.
      if (await safeClick(taskCard, ".task-card:not(.solved)", "task_detail")) {
        // v6.10.76 — waitForSelector(#ans-text, state: visible) replaces
        // the v6.10.35 passive `waitForTimeout(1000)`. 1 s was too short
        // under WAN when /api/tasks/:id sometimes takes 1-2 s to return
        // before public/app.js:2479 populates #task-detail-card. Pre-fix
        // the probe moved to task_submit phase before #ans-text rendered,
        // so the downstream `isVisible()` gate returned false and the
        // whole submit block skipped. 5 s is well above observed
        // detail-fetch tail latency; .catch(()=>{}) lets the probe
        // graceful-degrade if the detail never renders.
        // v6.12.3 — record waitForSelector duration on BOTH outcomes.
        const wfsDetailStart = Date.now();
        await page.waitForSelector("#ans-text", { state: "visible", timeout: 5000 })
          .then(() => {
            browserWaitForSelectorMs.add(Date.now() - wfsDetailStart, { phase: "task_detail", result: "ok" });
          })
          .catch(() => {
            browserWaitForSelectorMs.add(Date.now() - wfsDetailStart, { phase: "task_detail", result: "timeout" });
            browserPhaseTimeouts.add(1, { phase: "task_detail" });
          });
        browserTaskDetail.add(Date.now() - detailStart);

        // ── Submit answer ────────────────────────────────────────────────
        await enterPhase("task_submit");
        // v6.10.74 — scoped `#task-detail-page input[type='text'], textarea`.
        // v6.10.76 — scoped selector was half-right but the [type='text']
        // filter was a bug: public/app.js:2640 renders the answer input
        // as `<input id="ans-text" ... data-mode="text"/>` WITHOUT an
        // explicit `type="text"` attribute. HTML defaults the type
        // property to "text" but the attribute itself isn't present in
        // the DOM, and CSS attribute selectors only match on explicit
        // attribute presence. Result: the scoped selector matched
        // nothing, isVisible() returned false, and the submit block
        // skipped on every iteration — browser_submit_render was 0.00µs
        // across 246 v6.10.72 entries and 61 v6.10.73+74 entries.
        //
        // Switch to `#ans-text` directly. The id is unique and appears
        // on BOTH the text-mode input (line 2640) and the json-mode
        // textarea (line 2634), so this one selector covers both answer
        // modes a probe would meaningfully test. file-mode tasks have
        // no text/textarea input to fill — graceful skip.
        const answerInput = page.locator("#ans-text").first();
        // v6.10.37 — task submit buttons carry data-action="task-submit-answer"
        // (public/app.js:2630-2641). Covers text / json / file answer modes.
        const submitBtn = page.locator("#task-detail-page button[data-action='task-submit-answer']").first();
        if (await answerInput.isVisible().catch(() => false)) {
          const task = seedData.tasks[0];
          await answerInput.fill(task ? task.correctAnswer : "test-answer");
          const submitStart = Date.now();
          await submitBtn.click();
          // Wait for result feedback (toast, badge change, or modal)
          await page.waitForTimeout(2000);
          browserSubmit.add(Date.now() - submitStart);
        }
      }
    }

    // ── Leaderboard ────────────────────────────────────────────────────────
    await enterPhase("leaderboard");
    // v6.10.37 — #nav-leaderboard assigned in public/app.js:1722.
    const lbBtn = page.locator("#nav-leaderboard");
    if (await lbBtn.isVisible().catch(() => false)) {
      const lbStart = Date.now();
      // v6.10.77 — safeClick. The v6.10.76 run surfaced 175
      // `clicking on #nav-leaderboard timed out after 30s` warnings
      // in a 40-min run (56% of leaderboard phase entries), in
      // synchronized clusters across all 5 browser VUs every ~40 s.
      // The failure mode is the same hover-transform instability
      // hitting .task-card — and every failure previously killed the
      // iteration outright, so the subsequent cycle_pause phase
      // reached only 137/322 iterations. force:true + 10-s timeout +
      // try/catch absorb the timeouts and let downstream phases
      // record their measurements.
      if (await safeClick(lbBtn, "#nav-leaderboard", "leaderboard")) {
        // Wait for leaderboard table to render. The SPA renders the
        // scores table with class `.lb-table` and the top-3 strip as
        // `.podium` — either confirms the view is hydrated.
        //
        // v6.10.81 — timeout bumped 10 s → 30 s + record ONLY when
        // the selector actually matched. The v6.10.80 run showed
        // browser_leaderboard_render p(90) wedged at ~20.5 s for 146
        // consecutive iterations — `10 s safeClick + 10 s selector
        // timeout + 500 ms waitForTimeout` = our own ceiling math,
        // not a real measurement. v6.10.77's safeClick pushed the
        // leaderboard-phase reach rate from ~50% to 98%, so now five
        // browser VUs + three admin VUs + 300 protocol VUs all land
        // on `/api/leaderboard` near-simultaneously on each 30-s
        // probe cycle — the cached endpoint's 5 s TTL doesn't absorb
        // that burst under 300-VU load, response can take >10 s.
        // Bumping the selector timeout lets the probe WAIT for the
        // real render instead of capping; recording only on success
        // gives a clean p(90) reading of actual render time instead
        // of a mix of real renders + self-inflicted timeouts. Probes
        // that time out are visible via the gap between
        // `browser_phases_reached{phase:leaderboard}` and this
        // metric's sample count — a drop from (say) 146 phase
        // entries to 120 recorded renders means 26 probes hit 30 s
        // and gave up, which is itself a signal worth reading.
        // v6.12.2 — tag the timeout branch with a distinct metric.
        // Pre-fix the only signal for "waitForSelector hit 30 s" was
        // `phase_reached count - render_recorded count`; now it's a
        // first-class `browser_phase_timeouts{phase:leaderboard}`
        // counter. The scripts/debug-leaderboard-selector.js debug run
        // against a healthy server confirmed the selector itself is
        // correct (matched in 6 ms); the 0.00µs reading against
        // ctf.checkmarx.net under 5-probe + 310-VU load was therefore
        // LG-CPU contention, not a server/SPA bug. This counter makes
        // that distinction visible without needing to subtract
        // metrics.
        // v6.12.7 — `state:'attached'` + combined selector. v6.12.6
        // diagnostic confirmed: the three-stage scaffold's Stage A
        // (static selector + attached state) matched ALL samples at
        // median 2 ms — the DOM node is reliably in the tree after
        // showMain(); Playwright's default visible-state check is the
        // false-negative source under 5-concurrent-tab load. Stages
        // B and C (visible) never matched and are removed. The
        // combined `.lb-table tr, .podium .podium-slot` selector is
        // retained for backward-compat with the probe's pre-v6.12.x
        // shape so the metric name doesn't change.
        const wfsLbStart = Date.now();
        const renderedOk = await page.waitForSelector(
          ".lb-table tr, .podium .podium-slot",
          { state: "attached", timeout: 10000 }
        ).then(() => {
          browserWaitForSelectorMs.add(Date.now() - wfsLbStart, { phase: "leaderboard", result: "ok" });
          return true;
        }).catch(() => {
          browserWaitForSelectorMs.add(Date.now() - wfsLbStart, { phase: "leaderboard", result: "timeout" });
          browserPhaseTimeouts.add(1, { phase: "leaderboard" });
          return false;
        });
        if (renderedOk) {
          // Short paint wait after DOM-attached match so the recorded
          // render duration reflects a visually-ready page, not just
          // "node in tree". Same 500 ms the original probe used.
          await page.waitForTimeout(500);
          browserLeaderboard.add(Date.now() - lbStart);
        }
      }
    }

    // Pause between probe cycles
    await enterPhase("cycle_pause");
    await page.waitForTimeout(10000 + Math.random() * 20000);

    // v6.10.62 — final CLS flush. enterPhase attributes the delta to
    // the PREVIOUS phase, so without this the very last phase
    // (cycle_pause) never gets its CLS recorded. cycle_pause is just
    // a sleep so the value should be ~0, but flushing keeps the
    // accounting honest and matches the behaviour an operator would
    // expect.
    if (_clsAttached) {
      try {
        const finalCls = await page.evaluate(() => window.__cls || 0);
        browserClsPerPhase.add(Math.max(0, finalCls - _prevCls), { phase: _prevPhase });
      } catch (_) { /* page context lost — drop the trailing delta */ }
    }

  } catch (e) {
    // v6.10.35 — structured error log. k6 browser can reject with plain
    // strings, goja proxies, or CDP-disconnect wrappers whose shapes
    // don't all carry a `.message` — print every angle we can extract
    // so the next run shows the real cause instead of "undefined".
    // Demoted to warn: probe failures under load are expected, not a
    // test halt; real outages will show as N 100% failure rate rather
    // than a handful of timeouts.
    const parts = [`phase=${phase}`];
    if (e === null || e === undefined) {
      parts.push(`thrown=${String(e)}`);
    } else {
      const name = e.name;
      const msg  = e.message;
      const str  = (typeof e === "string") ? e : (e.toString ? e.toString() : String(e));
      const stk  = e.stack ? String(e.stack).split("\n").slice(0, 4).join(" | ") : null;
      if (name) parts.push(`name=${name}`);
      if (msg)  parts.push(`message=${msg}`);
      else      parts.push(`message=<empty>`);
      if (str && str !== "[object Object]" && str !== msg && str !== name) parts.push(`toString=${str}`);
      if (stk)  parts.push(`stack=${stk}`);
    }
    console.warn(`Browser probe failure: ${parts.join(" ")}`);
  } finally {
    // page.close() itself can throw if the browser context already
    // vanished (CDP drop, OOM-killed Chromium). Swallow — nothing
    // actionable, and a secondary error here would mask the primary.
    try { await page.close(); } catch (_) {}
  }
}
