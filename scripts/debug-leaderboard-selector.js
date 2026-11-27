#!/usr/bin/env node
"use strict";

// Debug script for the `browser_leaderboard_render = 0.00µs` regression.
//
// Mimics the k6-browser probe's leaderboard-phase flow from
// perf/k6/lib/browser-probe.js:
//   1. Login as a participant
//   2. Select a competition (if a picker is shown)
//   3. Click #nav-leaderboard with {force:true, timeout:10000} (probe's safeClick)
//   4. Wait briefly for render
//   5. Run page.waitForSelector(".lb-table tr, .podium .podium-slot", {timeout})
//
// The probe records a render-time metric ONLY if that waitForSelector
// matches. Across the v6.10.93 perf run the match rate was 0/66 —
// the metric came back at 0.00µs despite 66 phase entries. This
// script dumps every candidate selector's count / visibility /
// computed style against the live SPA so we can see whether:
//   (a) the selectors are stale (SPA's markup changed under the probe)
//   (b) the page is still hidden at check time (display:none on
//       #leaderboard-page)
//   (c) the click didn't actually route to the leaderboard view
//   (d) something else
//
// Usage (local dev server running at BASE_URL, seed data present):
//   node scripts/debug-leaderboard-selector.js
//   HEADFUL=1 node scripts/debug-leaderboard-selector.js   # show the browser
//   BASE_URL=http://localhost:4567 EMAIL=alice@acme.com PASSWORD=testpass123 \
//     node scripts/debug-leaderboard-selector.js
//
// Prep:
//   npm start           # start the dev server on :3000 (or a test worker)
//   # Seed: either run `npm test` once (populates test data volumes)
//   # or register alice via the SPA UI + create a Test Live competition.

const { chromium } = require("playwright");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const EMAIL    = process.env.EMAIL    || "alice@acme.com";
const PASSWORD = process.env.PASSWORD || "testpass123";
const HEADFUL  = !!process.env.HEADFUL;

function pad(s, n) { return (String(s) + " ".repeat(n)).slice(0, n); }

async function selectorReport(page, selectors, header) {
  console.log(`\n[debug] ===== ${header} =====`);
  for (const sel of selectors) {
    const count = await page.locator(sel).count();
    let firstVisible = false;
    let styleInfo = "-";
    if (count > 0) {
      const loc = page.locator(sel).first();
      firstVisible = await loc.isVisible().catch(() => false);
      styleInfo = await loc.evaluate(el => {
        const cs = window.getComputedStyle(el);
        return `display=${cs.display} visibility=${cs.visibility} size=${el.offsetWidth}x${el.offsetHeight}`;
      }).catch(() => "(evaluate failed)");
    }
    console.log(`  ${pad(sel, 44)} count=${String(count).padStart(2)} visible=${firstVisible}  ${styleInfo}`);
  }
}

async function main() {
  console.log(`[debug] BASE_URL=${BASE_URL} EMAIL=${EMAIL} HEADFUL=${HEADFUL}`);
  const browser = await chromium.launch({ headless: !HEADFUL });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // Surface SPA console errors/warnings; silence info noise.
  page.on("console", msg => {
    const t = msg.type();
    if (t === "error" || t === "warning") console.log(`[spa ${t}] ${msg.text()}`);
  });
  page.on("pageerror", err => console.log(`[spa pageerror] ${err.message}`));

  try {
    console.log("[debug] goto /");
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });

    console.log("[debug] login");
    await page.waitForSelector("#login-email", { timeout: 5000 });
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-pass", PASSWORD);
    await page.locator("button:has-text('Sign In')").first().click();

    // Wait for post-login shell — #main-nav hydrates after successful login.
    console.log("[debug] waiting for post-login (#main-nav)");
    await page.waitForSelector("#main-nav", { timeout: 10000 });
    await page.waitForTimeout(400); // settle SPA routing

    // Report the active page.
    const activePageId = await page.evaluate(() => {
      const p = document.querySelector(".page.active");
      return p ? p.id : "(none)";
    });
    console.log(`[debug] post-login active page: ${activePageId}`);

    // If a competition picker is showing, click the first card.
    const pickerSel = ".comp-card, [data-action='select-competition']";
    const pickerCount = await page.locator(pickerSel).count();
    console.log(`[debug] competition-picker cards found: ${pickerCount}`);
    if (pickerCount > 0) {
      console.log("[debug] clicking first competition card");
      await page.locator(pickerSel).first().click({ force: true, timeout: 5000 });
      await page.waitForTimeout(500);
    }

    // Log active page again after any comp-select.
    const activePage2 = await page.evaluate(() => {
      const p = document.querySelector(".page.active");
      return p ? p.id : "(none)";
    });
    console.log(`[debug] active page after comp-select: ${activePage2}`);

    // Try clicking #nav-leaderboard the way the probe does.
    const lbBtn = page.locator("#nav-leaderboard");
    const lbBtnCount = await lbBtn.count();
    const lbBtnVisible = lbBtnCount > 0 ? await lbBtn.first().isVisible().catch(() => false) : false;
    console.log(`[debug] #nav-leaderboard matches=${lbBtnCount} visible=${lbBtnVisible}`);
    if (lbBtnCount === 0) {
      const navHtml = await page.locator("#main-nav").evaluate(el => el ? el.outerHTML : "(no #main-nav)").catch(() => "(err)");
      console.log("[debug] #main-nav outerHTML:\n", navHtml);
      throw new Error("nav-leaderboard not found — SPA didn't build the nav bar");
    }

    console.log("[debug] clicking #nav-leaderboard (force:true, 10 s timeout — probe-equivalent)");
    const clickResult = await lbBtn.click({ force: true, timeout: 10000 })
      .then(() => "ok")
      .catch(e => `FAILED: ${e.message}`);
    console.log(`[debug] click result: ${clickResult}`);

    // Matches the probe's 500 ms passive wait after click succeeds.
    await page.waitForTimeout(500);

    const activePage3 = await page.evaluate(() => {
      const p = document.querySelector(".page.active");
      return p ? p.id : "(none)";
    });
    console.log(`[debug] active page after #nav-leaderboard click: ${activePage3}`);

    // Selector match report — immediately after click.
    const candidates = [
      ".lb-table tr, .podium .podium-slot", // THE probe's selector
      ".lb-table tr",
      ".lb-table",
      ".podium",
      ".podium .podium-slot",
      "#podium-row",
      "#lb-body",
      "#lb-body tr",
      "#leaderboard-page",
      "#leaderboard-page.active",
    ];
    await selectorReport(page, candidates, "SELECTOR MATCH REPORT (immediately after click)");

    // Second report after another 1 s — lets async render settle.
    await page.waitForTimeout(1000);
    await selectorReport(page, candidates, "SELECTOR MATCH REPORT (after additional 1 s wait)");

    // DOM snapshot of #leaderboard-page for shape analysis.
    console.log("\n[debug] ===== #leaderboard-page snapshot (first 1000 chars) =====");
    const lbHtml = await page.locator("#leaderboard-page").first().evaluate(el => {
      if (!el) return "(not found)";
      const html = el.outerHTML || "";
      return html.length > 1000 ? html.slice(0, 1000) + "\n... [truncated]" : html;
    }).catch(e => `(evaluate failed: ${e.message})`);
    console.log(lbHtml);

    // Attempt the probe's exact waitForSelector, with the same 30 s ceiling.
    // Reducing to 5 s here since we're debugging; a match within 5 s means
    // the probe would have matched, a timeout means the selector never
    // becomes visible.
    const probeSel = ".lb-table tr, .podium .podium-slot";
    console.log(`\n[debug] replaying probe: waitForSelector("${probeSel}", {timeout:5000})`);
    const t0 = Date.now();
    const probeResult = await page.waitForSelector(probeSel, { timeout: 5000 })
      .then(() => `MATCHED after ${Date.now() - t0} ms`)
      .catch(e => `FAILED after ${Date.now() - t0} ms: ${e.message}`);
    console.log(`[debug] probe selector result: ${probeResult}`);

    // If visible-state failed, also try state:'attached' — separates "not
    // in DOM" from "in DOM but hidden."
    console.log("[debug] retrying with state:'attached' (separates hidden vs missing)");
    const t1 = Date.now();
    const attachedResult = await page.waitForSelector(probeSel, { state: "attached", timeout: 5000 })
      .then(() => `ATTACHED after ${Date.now() - t1} ms`)
      .catch(e => `FAILED after ${Date.now() - t1} ms: ${e.message}`);
    console.log(`[debug] probe selector (attached) result: ${attachedResult}`);

    console.log("\n[debug] ===== DIAGNOSIS HINTS =====");
    console.log("[hint] MATCHED immediately: probe should succeed; the prod failure is environmental");
    console.log("       (asset-cascade under WAN load delays SPA hydration past the 30 s timeout).");
    console.log("[hint] ATTACHED but not visible: selector is in DOM but hidden (likely still on");
    console.log("       an earlier .page.active — click didn't route to the leaderboard view).");
    console.log("[hint] FAILED both: markup has changed and the selector is stale. Use the snapshot");
    console.log("       above to pick a new selector that DOES match the current structure.");
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error("[debug] FATAL:", e.stack || e.message || e);
  process.exit(1);
});
