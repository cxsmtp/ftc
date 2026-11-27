/* End-to-end runtime smoke for the v7.0.0 ESM split. Boots a REAL server in both
 * serving modes (dev = raw public/js/** modules, prod = MINIFY_JS=1 esbuild
 * entry-bundle), drives the SPA in headless Chromium, and asserts:
 *   - clean boot (no uncaught pageerror) + the anonymous login screen renders
 *   - superadmin login, every sidebar section renders, Raw logs opens from
 *     Audit, a competition can be created and its workspace's Activity opens
 *   - the Join-Link QR renders: the server's centre-coded image (the dialog falls
 *     back to the code-less vendored QR only when that request fails, and a
 *     fallback here is a failure)
 *   - the JS-request shape: many /js/** module requests in dev vs exactly one
 *     bundled /js/core/main.js in prod
 *
 * Run: `npm run smoke` (or `node scripts/smoke.cjs`). Needs the Playwright
 * chromium browser (installed with the dev deps). Override ports via
 * SMOKE_PORT_DEV / SMOKE_PORT_PROD; the chromium shared-lib path via PW_LIB_PATH.
 * Exits non-zero on any failure.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
// Optional sandbox shared-lib path (mirrors playwright.config.js); only applied
// if it actually exists, so the smoke stays portable to CI / other machines.
const LIB_PATH = process.env.PW_LIB_PATH || "/tmp/pw-libs/usr/lib/x86_64-linux-gnu";
const LAUNCH_ENV = fs.existsSync(LIB_PATH) ? { ...process.env, LD_LIBRARY_PATH: LIB_PATH } : process.env;
const PORT_DEV = parseInt(process.env.SMOKE_PORT_DEV || "4801", 10);
const PORT_PROD = parseInt(process.env.SMOKE_PORT_PROD || "4802", 10);
// The sidebar sections a superadmin must be shown (data-tab-id admin-<x>-tab;
// "tasks" is the Challenge library). Every item the page shows is opened; this
// list is the floor, so a section that vanished fails by name. Submissions and
// Logs have no sidebar item: Logs is Audit's Raw logs, Submissions an event
// workspace's Activity tab, and each is opened through that door below.
const ADMIN_TABS = ["competitions", "templates", "tasks", "rankings", "analytics", "audit", "participants", "groups", "users", "settings"];

function waitForListen(port, ms = 20000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      const req = http.get({ host: "localhost", port, path: "/api/config" }, r => { r.resume(); res(true); });
      req.on("error", () => { if (Date.now() - t0 > ms) rej(new Error("server never listened")); else setTimeout(tick, 200); });
    };
    tick();
  });
}

async function runMode(mode, port) {
  const dataDir = path.join(ROOT, `smoke-data-${mode}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  // Realistic non-test boot. TRUST_PROXY forced off: with an http:// BASE_URL a
  // trusted-proxy boot drops the session cookie (mirrors playwright.config).
  const env = { ...process.env, PORT: String(port), BASE_URL: `http://localhost:${port}`, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`, SMTP_HOST: "localhost", RATE_LIMIT_DISABLED: "1", HSTS: "0", SUPERADMIN_PASSWORD_QUIET: "1", TRUST_PROXY: "" };
  delete env.NODE_ENV;
  if (mode === "prod") env.MINIFY_JS = "1";  // esbuild entry-bundle
  else delete env.MINIFY_JS;

  const srv = spawn("node", ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let srvLog = "";
  srv.stdout.on("data", d => { srvLog += d; });
  srv.stderr.on("data", d => { srvLog += d; });
  const fail = [];
  try {
    await waitForListen(port);
    const pass = fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
    const base = `http://localhost:${port}`;
    const browser = await chromium.launch({ env: LAUNCH_ENV });

    // 1. Anonymous load (throwaway context) — login screen renders + capture the
    //    JS-request shape (raw modules in dev / single bundle in prod).
    const jsReqs = new Set();
    {
      const anonCtx = await browser.newContext({ baseURL: base });
      const anonPage = await anonCtx.newPage();
      const anonErrors = [];
      anonPage.on("pageerror", e => anonErrors.push(e.message));
      anonPage.on("request", r => { const u = r.url(); if (/\/js\/.*\.js(\?|$)/.test(u)) jsReqs.add(u.replace(/\?.*$/, "").replace(base, "")); });
      await anonPage.goto(base, { waitUntil: "networkidle" });
      const hasLogin = await anonPage.locator("#login-email, #login-form, input[type=email]").first().isVisible().catch(() => false);
      if (!hasLogin) fail.push("anonymous: login screen not visible");
      if (anonErrors.length) fail.push("anonymous pageerror(s): " + anonErrors.slice(0, 3).join(" | "));
      await anonCtx.close();
    }

    // 2. Auth context: log in via request BEFORE any page nav (so the SPA boot
    //    can't rotate the CSRF token out from under us — mirrors tests/helpers.js).
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, baseURL: base });
    const csrf = await (await context.request.get("/api/csrf-token")).json();
    const loginResp = await context.request.post("/api/login", { headers: { "x-csrf-token": csrf.csrfToken, "content-type": "application/json" }, data: { email: "superadmin", password: pass } });
    if (!loginResp.ok()) fail.push(`superadmin login failed: ${loginResp.status()} ${await loginResp.text()}`);
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(base, { waitUntil: "networkidle" });

    // 3. Admin shell + every tab (scroll the nav item into view first)
    const adminVisible = await page.locator("#admin-sidebar, .admin-nav-item").first().isVisible().catch(() => false);
    if (!adminVisible) fail.push("admin shell (#admin-sidebar) not visible after superadmin login");
    const shown = await page.locator("button.admin-nav-item[data-tab-id]").evaluateAll((els) =>
      els.filter((el) => !el.closest("[hidden]")).map((el) => el.dataset.tabId.replace(/^admin-|-tab$/g, "")));
    for (const tab of ADMIN_TABS) if (!shown.includes(tab)) fail.push(`admin tab button missing: ${tab}`);
    for (const tab of shown) {
      const btn = page.locator(`button.admin-nav-item[data-tab-id="admin-${tab}-tab"]`).first();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 6000 }).catch(e => fail.push(`tab ${tab} click threw: ${e.message.split("\n")[0]}`));
      const ok = await page.locator(`#admin-${tab}-tab`).first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
      if (!ok) fail.push(`admin tab pane not visible: ${tab}`);
    }
    // Logs: Audit's Raw logs switch.
    await page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]').first().click({ timeout: 6000 }).catch(() => {});
    await page.locator("#audit-view-raw").click({ timeout: 6000 }).catch(e => fail.push(`Raw logs click threw: ${e.message.split("\n")[0]}`));
    if (!(await page.locator("#admin-logs-tab").waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false))) fail.push("admin tab pane not visible: logs (Audit, Raw logs)");

    // 4. Create a competition + open the Join-Link (self-enroll) QR overlay under TT
    const csrf2 = await (await context.request.get("/api/csrf-token")).json();
    const start = new Date(Date.now() + 3600_000).toISOString();
    const compResp = await context.request.post("/api/admin/competitions", { headers: { "x-csrf-token": csrf2.csrfToken, "content-type": "application/json" }, data: { name: "Smoke Comp", start_time: start, duration_minutes: 60 } });
    const compRes = { ok: compResp.ok(), body: await compResp.json().catch(() => ({})) };
    if (!compRes.ok) fail.push(`create competition failed: ${compResp.status()} ${JSON.stringify(compRes.body)}`);
    else {
      // POST /api/admin/competitions responds { competition: { id, ... } }.
      const compId = (compRes.body.competition && compRes.body.competition.id) || compRes.body.id;
      // window.openSelfEnrollOverlay is exposed by the boot() global bridge.
      const opened = await page.evaluate(async (id) => {
        if (typeof window.openSelfEnrollOverlay !== "function") return "no window.openSelfEnrollOverlay";
        try { await window.openSelfEnrollOverlay(id); return "ok"; } catch (e) { return "threw: " + e.message; }
      }, compId);
      if (opened !== "ok") fail.push(`openSelfEnrollOverlay: ${opened}`);
      else {
        // The QR is the server's centre-coded image (POST /api/admin/join-qr),
        // painted as an <img>; the dialog draws the vendored, code-less QR
        // (an <svg>) only when that request failed, and says "QR unavailable"
        // when both did. Only a decoded image passes.
        await page.waitForFunction(() => {
          const q = document.getElementById("self-enroll-qr");
          if (!q) return false;
          const img = q.querySelector("img.se-qr-img");
          return !!((img && img.complete && img.naturalWidth > 0) || q.querySelector("svg") || /unavailable/i.test(q.textContent || ""));
        }, { timeout: 9000 }).catch(() => {});
        const qr = await page.evaluate(() => {
          const q = document.getElementById("self-enroll-qr");
          if (!q) return "no #self-enroll-qr";
          const img = q.querySelector("img.se-qr-img");
          if (img && img.complete && img.naturalWidth > 0) return "ok";
          if (q.querySelector("svg")) return "the code-less fallback QR (the centre-coded image request failed)";
          return `nothing drawn (container="${(q.textContent || "").slice(0, 40)}")`;
        });
        if (qr !== "ok") fail.push(`Join-Link QR image not rendered: ${qr}`);
        await page.keyboard.press("Escape").catch(() => {});
      }
      // Submissions: the event workspace's Activity tab.
      await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').first().click({ timeout: 6000 }).catch(() => {});
      await page.locator("#comp-search").fill("Smoke Comp").catch(() => {});
      const open = page.locator('#admin-comp-body tr:has-text("Smoke Comp") [data-action="comp-open"]').first();
      const reached = await open.click({ timeout: 10000 })
        .then(() => page.locator("#ws-record").waitFor({ state: "visible", timeout: 10000 }))
        .then(() => page.locator('#ws-tabs [data-section="admin-submissions-tab"]').first().click({ timeout: 6000 }))
        .then(() => page.locator("#admin-submissions-tab").waitFor({ state: "visible", timeout: 5000 }))
        .then(() => true, (e) => { fail.push(`workspace Activity (submissions) not reached: ${e.message.split("\n")[0]}`); return false; });
      void reached;
    }

    if (pageErrors.length) fail.push("pageerror(s): " + pageErrors.slice(0, 5).join(" | "));
    // ignore benign network 4xx console noise (anonymous /api/me etc.)
    const realConsole = consoleErrors.filter(t => !/Failed to load resource|401|403|the server responded/.test(t));
    if (realConsole.length) fail.push("console error(s): " + realConsole.slice(0, 5).join(" | "));

    // JS-request shape
    const moduleReqs = [...jsReqs].filter(u => u.startsWith("/js/"));
    const shape = mode === "prod"
      ? (moduleReqs.length === 1 && moduleReqs[0] === "/js/core/main.js" ? "OK (1 bundle)" : `UNEXPECTED: ${moduleReqs.length} js reqs: ${moduleReqs.slice(0, 6).join(", ")}`)
      : (moduleReqs.length >= 15 ? `OK (${moduleReqs.length} raw modules)` : `UNEXPECTED: only ${moduleReqs.length} js reqs`);
    if (shape.startsWith("UNEXPECTED")) fail.push("js-request shape: " + shape);

    await browser.close();
    return { mode, pass: fail.length === 0, fail, jsShape: shape };
  } catch (e) {
    return { mode, pass: false, fail: [...fail, "EXCEPTION: " + e.message], srvLog: srvLog.slice(-800) };
  } finally {
    srv.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  results.push(await runMode("dev", PORT_DEV));
  results.push(await runMode("prod", PORT_PROD));
  console.log("\n================ SMOKE RESULTS ================");
  let allPass = true;
  for (const r of results) {
    console.log(`\n[${r.mode.toUpperCase()}] ${r.pass ? "PASS" : "FAIL"}  | JS: ${r.jsShape || "?"}`);
    if (r.fail && r.fail.length) { r.fail.forEach(f => console.log("   - " + f)); allPass = false; }
    if (r.srvLog) console.log("   server log tail:\n" + r.srvLog.split("\n").map(l => "     " + l).join("\n"));
  }
  console.log("\n================ " + (allPass ? "ALL SMOKE CHECKS PASSED" : "SMOKE FAILURES") + " ================");
  process.exit(allPass ? 0 : 1);
})();
