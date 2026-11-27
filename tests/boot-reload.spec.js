// @ts-check
//
// v8.14.0 — A PAGE WHOSE APP SCRIPT FAILED TO LOAD RELOADS ITSELF, ONCE.
//
// The login page is static markup (#login-page carries `active`) and theme-boot.js
// sets the theme, so a load in which ONE request of the SPA's module graph fails
// still paints a page that looks usable while nothing on it works: Sign Up does
// nothing, the theme never follows the OS, the header icons never mount. That is
// how two tests failed in a full run ("register link works": #reg-first hidden;
// hover-pulse-no-fade's login test: the page never followed the OS into dark);
// injecting one aborted module request reproduces both failures exactly.
//
// public/theme-boot.js listens (capture phase) for the `error` event the browser
// fires on the entry <script type="module"> when its graph fails to fetch, and
// reloads once. What is pinned here:
//   1. one transient failure: exactly one reload, and the app boots;
//   2. a failure that persists: exactly one reload, then the notice, even when
//      each failure takes longer than the guard's window to arrive, or the stamp
//      found lies in the future (the clock was set back), or the reload's own
//      document takes that long to start (the one-shot marker); and the marker
//      is spent by the reload it was set for, so a later failure reloads again;
//   3. no sessionStorage (no guard possible): no reload at all;
//   4. CONTROL, a clean load: no reload, nothing stamped;
//   5. a broken build (a SyntaxError, not a fetch failure): no reload;
//   6. a failed CLASSIC script, and a failed module script that is not the entry:
//      no reload (the listener is scoped to the entry);
//   7. whenever the page will not reload itself (the reload already spent, or no
//      storage), #boot-failure says so, with a Reload button; never on the first
//      failure, a clean load or a broken build.
// Under MINIFY_JS=1 the failed request is the bundled entry itself (failTarget).
// The witness for "how many loads" is the main frame's navigation REQUESTS, and
// for "which document is this" its Navigation Timing type, so a reload is never
// inferred from the app having booted.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { expectSpaBooted, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const KEY = "ha:boot-reload";

/**
 * The request to fail. With raw modules (dev, test) it is a DEPENDENCY of the
 * entry, the case the full run hit (any one fails the whole graph). The
 * production bundle (MINIFY_JS=1) inlines every module into /js/core/main.js,
 * so there the entry itself is the one request that can fail.
 */
async function failTarget(page) {
  const body = await (await page.request.get("/js/core/main.js")).text();
  return /from\s*["']\.\/\.\.\/ui\/theme\.js["']/.test(body)
    ? /\/js\/ui\/theme\.js(\?|$)/
    : /\/js\/core\/main\.js(\?|$)/;
}

/** Record every main-frame navigation request the page makes. */
function trackDocuments(page) {
  const docs = [];
  page.on("request", (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) docs.push(r.url()); });
  return docs;
}
const navType = (page) => page.evaluate(() => performance.getEntriesByType("navigation")[0].type);
const stampOf = (page) => page.evaluate((k) => sessionStorage.getItem(k), KEY);
const booted = (page) => page.evaluate(() => document.documentElement.dataset.booted === "1");
const NOTICE = "#boot-failure";
const NOTICE_TEXT = "This page did not finish loading. Check your connection, then reload.";
/**
 * Record, per document, whether the notice was ever inserted: the navigation
 * type of each document that showed it. A document that reloads itself is gone
 * before the test can look, so its DOM cannot be asked afterwards.
 */
async function recordNotices(page) {
  await page.addInitScript(() => {
    const seen = () => {
      if (!document.getElementById("boot-failure")) return false;
      try {
        const list = JSON.parse(sessionStorage.getItem("t:notice-seen") || "[]");
        list.push(performance.getEntriesByType("navigation")[0].type);
        sessionStorage.setItem("t:notice-seen", JSON.stringify(list));
      } catch (_) { /* no storage: the test reads the DOM instead */ }
      return true;
    };
    const mo = new MutationObserver(() => { if (seen()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  });
}
const noticesSeen = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("t:notice-seen") || "[]"));

test.describe("v8.14.0 — a page whose app script failed to load reloads itself once", () => {
  test("one failed module request: the page reloads once, by itself, and the app boots", async ({ page }) => {
    // A stamp from a minute ago must not block the recovery (the guard is a window, not a latch).
    await page.addInitScript((k) => {
      if (!sessionStorage.getItem("d8-seeded")) { sessionStorage.setItem("d8-seeded", "1"); sessionStorage.setItem(k, String(Date.now() - 60000)); }
    }, KEY);
    await recordNotices(page);
    const docs = trackDocuments(page);
    const target = await failTarget(page);
    expect(String(target), "CONTROL: raw modules fail a dependency of the entry; only the bundle fails the entry itself")
      .toContain(process.env.MINIFY_JS === "1" ? "core" : "theme");
    let calls = 0;
    await page.route(target, (route) => (calls++ === 0 ? route.abort("failed") : route.continue()));
    const before = Date.now();
    await page.goto("/");
    await expectSpaBooted(page, "the reloaded page");
    expect(calls, "CONTROL: the module was requested twice, the failed request and the reload's").toBe(2);
    expect(docs.length, `exactly one reload: ${JSON.stringify(docs)}`).toBe(2);
    expect(await navType(page), "the document that booted is the reload").toBe("reload");
    const stamp = Number(await stampOf(page));
    expect(stamp, "the guard was re-stamped by THIS recovery, not left at the stale seed").toBeGreaterThanOrEqual(before - 1000);
    expect(await noticesSeen(page), "a page that reloads itself shows no notice, before or after").toEqual([]);
    // …and the recovered page works: the click that failed in the full run.
    await page.click("[data-action=open-event-code]");
    await expect(page.locator("#ec-code"), "the event-code link opens its dialog on the recovered page").toBeVisible();
  });

  test("a failure that persists reloads exactly once, then says so, and its Reload button reloads", async ({ page }) => {
    await recordNotices(page);
    const docs = trackDocuments(page);
    let calls = 0;
    await page.route(await failTarget(page), (route) => { calls++; return route.abort("failed"); });
    // goto resolves at the LOAD of the last document. The reload would be requested
    // from that document's error event, which fires before its load, so reaching
    // load proves the second document asked for no further reload.
    await page.goto("/", { timeout: 15000 });
    expect(calls, "CONTROL: both documents' module requests failed").toBe(2);
    expect(docs.length, `one reload and no more: ${JSON.stringify(docs)}`).toBe(2);
    expect(await navType(page), "the last document is the reload").toBe("reload");
    expect(await booted(page), "CONTROL: the failure persisted, so the app did not boot").toBe(false);
    expect(await stampOf(page), "the guard is stamped").not.toBeNull();
    expect(await noticesSeen(page), "the notice is shown by the reload only: the first failure reloads instead").toEqual(["reload"]);
    await expect(page.locator(`${NOTICE} [role=alert]`)).toHaveText(NOTICE_TEXT);
    // ON SCREEN, not merely present: a reload restores the scroll position against
    // the content below, which the inserted notice pushes down.
    await expect(page.locator(NOTICE), "the reloaded page is not scrolled past its notice").toBeInViewport({ ratio: 1 });
    const reloadBtn = page.locator(`${NOTICE} button`);
    await expect(reloadBtn).toHaveText("Reload");

    // The button reloads. Within the guard's window the failure is not retried
    // automatically, so the third document says so again and stays put.
    const loaded = page.waitForEvent("load");
    await reloadBtn.click();
    await loaded;
    expect(docs.length, `the button reloaded, once: ${JSON.stringify(docs)}`).toBe(3);
    expect(calls, "CONTROL: the third document's module request failed too").toBe(3);
    expect(await navType(page)).toBe("reload");
    await expect(page.locator(NOTICE), "the reloaded page says so again, on screen").toBeInViewport({ ratio: 1 });
    expect(await noticesSeen(page)).toEqual(["reload", "reload"]);
  });

  test("a failure that takes longer than the guard's window to arrive still reloads once, then says so", async ({ page }) => {
    // Each failure lands LATE_MS after its document began (a gateway timeout).
    // Instead of a real wait, the page's Date.now runs ahead by an offset kept
    // in sessionStorage, so it survives the reload; each failure adds LATE_MS.
    // Not page.clock: it also fakes `performance`, blinding the navigation-type witness.
    const LATE_MS = 31000;
    await page.addInitScript(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + (Number(sessionStorage.getItem("t:clock-ahead")) || 0);
      const starts = JSON.parse(sessionStorage.getItem("t:doc-starts") || "[]");
      starts.push(Date.now());
      sessionStorage.setItem("t:doc-starts", JSON.stringify(starts));
    });
    await recordNotices(page);
    const docs = trackDocuments(page);
    let calls = 0;
    // Bounded, so a build that loops ends booted rather than at the timeout. The
    // jump waits until theme-boot.js has run (it sets data-theme first): the
    // bundled entry is requested before the parser runs it, and a jump before
    // it would fake a slow theme-boot.js, not a slow failure.
    await page.route(await failTarget(page), async (route) => {
      if (++calls > 4) return route.continue();
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"), null, { polling: 25 });
      await page.evaluate((ms) => {
        sessionStorage.setItem("t:clock-ahead", String((Number(sessionStorage.getItem("t:clock-ahead")) || 0) + ms));
      }, LATE_MS);
      return route.abort("failed");
    });
    await page.goto("/", { timeout: 15000 });
    expect(docs.length, `one reload and no more: ${JSON.stringify(docs)}`).toBe(2);
    expect(calls, "CONTROL: both documents' module requests failed").toBe(2);
    expect(await navType(page), "the last document is the reload").toBe("reload");
    expect(await booted(page), "CONTROL: the failure persisted, so the app did not boot").toBe(false);
    const stamp = Number(await stampOf(page));
    const [firstStart, reloadStart] = await page.evaluate(() => JSON.parse(sessionStorage.getItem("t:doc-starts")));
    expect(stamp - firstStart, "CONTROL: the first failure arrived LATE_MS into its document").toBeGreaterThanOrEqual(LATE_MS);
    expect(reloadStart, "CONTROL: the clock kept its lead across the reload, which began after the stamp").toBeGreaterThanOrEqual(stamp);
    expect(await page.evaluate(() => Date.now()) - reloadStart, "CONTROL: the reload's own failure arrived LATE_MS into it")
      .toBeGreaterThanOrEqual(LATE_MS);
    expect(await noticesSeen(page), "the reload says so instead of reloading again").toEqual(["reload"]);
    await expect(page.locator(`${NOTICE} [role=alert]`)).toHaveText(NOTICE_TEXT);
  });

  test("a stamp from the future (the clock was set back) does not spend the reload", async ({ page }) => {
    // Seeded once, two minutes ahead of the first document. Read as "reloaded just
    // now" it would spend the reload before any happened, so this persistent
    // failure must still reload once, and only the reload says so.
    await page.addInitScript((k) => {
      const starts = JSON.parse(sessionStorage.getItem("t:doc-starts") || "[]");
      starts.push(Date.now());
      sessionStorage.setItem("t:doc-starts", JSON.stringify(starts));
      if (!sessionStorage.getItem("t:future-seed")) {
        const seed = String(Date.now() + 120000);
        sessionStorage.setItem("t:future-seed", seed);
        sessionStorage.setItem(k, seed);
      }
    }, KEY);
    await recordNotices(page);
    const docs = trackDocuments(page);
    let calls = 0;
    await page.route(await failTarget(page), (route) => { calls++; return route.abort("failed"); });
    await page.goto("/", { timeout: 15000 });
    expect(docs.length, `one reload and no more: ${JSON.stringify(docs)}`).toBe(2);
    expect(calls, "CONTROL: both documents' module requests failed").toBe(2);
    expect(await navType(page), "the last document is the reload").toBe("reload");
    expect(await noticesSeen(page), "the notice is shown by the reload only").toEqual(["reload"]);
    const seed = Number(await page.evaluate(() => sessionStorage.getItem("t:future-seed")));
    const [firstStart, reloadStart] = await page.evaluate(() => JSON.parse(sessionStorage.getItem("t:doc-starts")));
    expect(seed - firstStart, "CONTROL: the seeded stamp lay in the first document's future").toBeGreaterThan(60000);
    const stamp = Number(await stampOf(page));
    expect(stamp, "the first failure re-stamped the guard with its own time").toBeGreaterThanOrEqual(firstStart);
    expect(stamp, "…before the reload began").toBeLessThanOrEqual(reloadStart);
  });

  test("a reload whose own document starts after the guard's window still does not reload again", async ({ page }) => {
    // The window alone cannot hold this: the reload's start finds the stamp stale.
    // The one-shot marker the reload set is what refuses a second reload.
    const LATE_MS = 31000;
    // Every document after the first starts LATE_MS after the previous one's
    // failure: Date.now runs ahead by an offset kept in sessionStorage.
    await page.addInitScript((late) => {
      const n = Number(sessionStorage.getItem("t:doc-count")) || 0;
      sessionStorage.setItem("t:doc-count", String(n + 1));
      if (n > 0) sessionStorage.setItem("t:clock-ahead", String((Number(sessionStorage.getItem("t:clock-ahead")) || 0) + late));
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + (Number(sessionStorage.getItem("t:clock-ahead")) || 0);
    }, LATE_MS);
    await recordNotices(page);
    const docs = trackDocuments(page);
    let calls = 0;
    // Bounded, so the loop ends booted rather than at the timeout.
    await page.route(await failTarget(page), (route) => (++calls > 4 ? route.continue() : route.abort("failed")));
    await page.goto("/", { timeout: 15000 });
    expect(docs.length, `one reload and no more: ${JSON.stringify(docs)}`).toBe(2);
    expect(await noticesSeen(page), "the reload says so instead of reloading again").toEqual(["reload"]);
  });

  test("the marker is spent by the reload it was set for: a later failure in the same tab reloads once again", async ({ page }) => {
    // Without this, a marker that was never removed would turn every later failure
    // in the tab into the notice, and every other arm would still pass.
    await page.addInitScript(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + (Number(sessionStorage.getItem("t:clock-ahead")) || 0);
    });
    const docs = trackDocuments(page);
    let calls = 0;
    // 1st document fails, its reload boots; later the tab's next document fails,
    // and its automatic reload boots.
    await page.route(await failTarget(page), (route) => (++calls === 1 || calls === 3 ? route.abort("failed") : route.continue()));
    await page.goto("/");
    await expectSpaBooted(page, "the first recovery");
    expect(docs.length, "CONTROL: the first failure reloaded once").toBe(2);
    expect(await page.evaluate(() => sessionStorage.getItem("ha:boot-reloaded")), "the booted reload removed the marker").toBeNull();
    // Past the window, so only the marker could refuse the next reload.
    await page.evaluate(() => sessionStorage.setItem("t:clock-ahead", "31000"));
    await page.reload();
    await expectSpaBooted(page, "the second recovery");
    expect(calls, "CONTROL: the manual reload's module request failed, and its reload's did not").toBe(4);
    expect(docs.length, `the later failure reloaded once more: ${JSON.stringify(docs)}`).toBe(4);
  });

  for (const theme of ["light", "dark"]) {
    test(`the notice is readable and reachable, with no moderate+ axe violations (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem("hck-theme", t); } catch (_) {} }, theme);
      await page.route(await failTarget(page), (route) => route.abort("failed"));
      await page.goto("/", { timeout: 15000 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(NOTICE)).toBeVisible();
      const results = await new AxeBuilder({ page }).include(NOTICE).analyze();
      const gated = results.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
      expect(gated.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(" | ")}`)).toEqual([]);
      expect(results.passes.some((r) => r.id === "color-contrast"), "CONTROL: contrast was actually measured").toBe(true);
      const btn = await page.locator(`${NOTICE} button`).boundingBox();
      expect(btn.height, "the Reload button is a 44px target").toBeGreaterThanOrEqual(44);
      expect(btn.width).toBeGreaterThanOrEqual(44);
    });
  }

  test("an in-app reload's spinner mask is lifted, so the notice is not hidden behind it", async ({ page }) => {
    // ha:transition makes theme-boot.js hide the login page behind the spinner
    // until boot() routes, and boot() never runs here. A fresh stamp means this
    // failure is not retried, so this one document shows the notice.
    await page.addInitScript((k) => {
      sessionStorage.setItem("ha:transition", "1");
      sessionStorage.setItem(k, String(Date.now()));
    }, KEY);
    const docs = trackDocuments(page);
    await page.route(await failTarget(page), (route) => route.abort("failed"));
    await page.goto("/", { timeout: 15000 });
    expect(docs.length, "CONTROL: the fresh stamp spent the reload").toBe(1);
    await expect(page.locator(NOTICE)).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/booting-authed/);
    await expect(page.locator("#login-page")).toBeVisible();
    const hit = await page.locator(`${NOTICE} button`).evaluate((b) => {
      const r = b.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
    });
    expect(hit, "the Reload button is what a tap at its centre reaches, not the spinner").toBe(true);
  });

  test("at phone width the notice keeps a 16px gutter and its button stays on screen", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.route(await failTarget(page), (route) => route.abort("failed"));
    await page.goto("/", { timeout: 15000 });
    await expect(page.locator(NOTICE)).toBeInViewport({ ratio: 1 });
    const g = await page.evaluate((sel) => {
      const n = document.querySelector(sel).getBoundingClientRect();
      const b = document.querySelector(sel + " button").getBoundingClientRect();
      return { left: n.left, right: n.right, vw: document.documentElement.clientWidth, bLeft: b.left, bRight: b.right };
    }, NOTICE);
    expect(g.left, JSON.stringify(g)).toBeGreaterThanOrEqual(16);
    expect(g.vw - g.right, JSON.stringify(g)).toBeGreaterThanOrEqual(16);
    expect(g.bLeft, JSON.stringify(g)).toBeGreaterThanOrEqual(g.left);
    expect(g.bRight, JSON.stringify(g)).toBeLessThanOrEqual(g.right);
  });

  test("with no sessionStorage there is no guard, so there is no reload, and the page says so", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    });
    const docs = trackDocuments(page);
    let calls = 0;
    await page.route(await failTarget(page), (route) => { calls++; return route.abort("failed"); });
    await page.goto("/", { timeout: 15000 });
    expect(calls, "CONTROL: the module request failed").toBe(1);
    expect(await page.evaluate(() => { try { void window.sessionStorage; return "readable"; } catch (_) { return "throws"; } }),
      "CONTROL: sessionStorage really is unavailable on the page").toBe("throws");
    expect(docs.length, `no reload without a guard: ${JSON.stringify(docs)}`).toBe(1);
    expect(await booted(page), "CONTROL: the app did not boot").toBe(false);
    await expect(page.locator(`${NOTICE} [role=alert]`), "a page that will not reload itself says so").toHaveText(NOTICE_TEXT);
  });

  test("CONTROL: a clean load reloads nothing and stamps nothing", async ({ page }) => {
    const docs = trackDocuments(page);
    await page.goto("/");
    await expectSpaBooted(page, "a clean load");
    expect(docs.length, `one document: ${JSON.stringify(docs)}`).toBe(1);
    expect(await navType(page), "a first navigation, not a reload").toBe("navigate");
    expect(await stampOf(page), "nothing stamped the guard").toBeNull();
    await expect(page.locator(NOTICE)).toHaveCount(0);
  });

  test("a broken build (a SyntaxError, not a fetch failure) does not reload", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const docs = trackDocuments(page);
    let calls = 0;
    await page.route(await failTarget(page), (route) => { calls++; return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: "export const = ;" }); });
    await page.goto("/", { timeout: 15000 });
    expect(calls, "CONTROL: the broken module was served").toBe(1);
    await expect.poll(() => errors.join(" | "), { message: "CONTROL: the module really failed to PARSE" }).toMatch(/SyntaxError|Unexpected/i);
    expect(docs.length, `a code failure is not retried: ${JSON.stringify(docs)}`).toBe(1);
    expect(await booted(page), "CONTROL: the app did not boot").toBe(false);
    expect(await stampOf(page), "nothing stamped the guard").toBeNull();
    await expect(page.locator(NOTICE), "a broken build is not a connection problem").toHaveCount(0);
  });

  test("a failed classic script, or a failed module that is not the entry, does not reload", async ({ browser }) => {
    // bypassCSP: Trusted Types would otherwise refuse the injected <script src> below.
    const ctx = await browser.newContext({ baseURL: BASE, bypassCSP: true });
    try {
      const page = await ctx.newPage();
      const docs = trackDocuments(page);
      let calls = 0;
      await page.route(/\/help-renderer\.js(\?|$)/, (route) => { calls++; return route.abort("failed"); });
      await page.goto("/");
      await expectSpaBooted(page, "a load whose classic help-renderer.js failed");
      expect(calls, "CONTROL: the classic script request failed").toBe(1);
      // A module script that is not the entry, failing after boot. theme-boot.js's
      // capture listener runs BEFORE this target listener in the same dispatch, and
      // stamps the guard synchronously before it would reload — so the stamp, read
      // here, says whether it decided to reload, with no wait for a navigation.
      const seen = await page.evaluate((k) => new Promise((resolve) => {
        const s = document.createElement("script");
        s.type = "module";
        s.src = "/js/not-the-entry-" + Date.now() + ".js";
        s.addEventListener("error", () => resolve({ fired: true, stamp: sessionStorage.getItem(k) }));
        document.head.appendChild(s);
        setTimeout(() => resolve({ fired: false, stamp: sessionStorage.getItem(k) }), 10000);
      }), KEY);
      expect(seen.fired, "CONTROL: the non-entry module script fired its error event").toBe(true);
      expect(seen.stamp, "the non-entry module's failure did not trigger the recovery").toBeNull();
      expect(docs.length, `neither failure reloaded: ${JSON.stringify(docs)}`).toBe(1);
      await expect(page.locator(NOTICE), "nor the notice").toHaveCount(0);
    } finally { await ctx.close(); }
  });
});
