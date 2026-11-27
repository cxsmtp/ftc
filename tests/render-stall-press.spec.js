// @ts-check
/**
 * 9.1.3 — tests/helpers.js `pressThroughRenderStall` NEVER SENDS AGAIN AN INPUT
 * THE BROWSER TOOK AND NEVER CONFIRMED.
 *
 * On the CI runner a WebKit rendering stall can sit on a click after Playwright
 * has sent it (its call log ends at `performing click action`, then the action
 * times out); Playwright sends a click's move, down and up together, so the
 * whole input is already queued in the browser, and sending it again could
 * press twice. The helper instead waits the rest of its budget for a witness in
 * the page to see the input reach the control, and fails by name if it never
 * does. The CI stall does not reproduce off the runner, so Chromium is held the
 * same way here: a control whose mousedown (or touchstart) handler keeps the
 * page's main thread busy past the helper's first 4 s, so the browser cannot
 * confirm the press until the handler returns.
 *
 * 9.1.8 — and `gotoThroughRenderStall` NEVER LETS THROUGH A DOCUMENT THE PAGE
 * HAS NOT FINISHED. Once the test has waited 4 s for `domcontentloaded`, the
 * helper asks the page's own Navigation Timing record, never `readyState`
 * ("interactive" before the deferred and module scripts run). Its other half,
 * a page that fired the event while the test never heard it, happens only on
 * the CI runner and is held by review; here a deferred script the test holds
 * keeps the event from firing while the page paints nothing.
 *
 * 9.1.10 — and a navigation that has not COMMITTED in a third of its budget is
 * sent ONCE more, said on stderr (on the runner a fresh WebKit page's first
 * navigation sat uncommitted for all 30 s, then passed on its retry). Here the
 * browser's request for the document is held unanswered.
 *
 * 9.1.12 — and a press is sent only once its witness is ARMED, waiting up to
 * half its budget for a busy page (on the runner WebKit took over 500 ms to arm
 * it, the old bound, so the press went without one and its timeout surfaced
 * bare). Here the page's main thread is kept busy as the press begins.
 *
 * 9.2.12 — and the checks in the page scroll a covered control with each of
 * Playwright's own retry alignments in turn, never "nearest" alone, which lays
 * a control the window was scrolled past under the sticky header every try.
 */
const { test, expect } = require("./isolated-test");
const { BASE, pressThroughRenderStall, gotoThroughRenderStall, settleThroughRenderStall } = require("./helpers");

/** A button counting its clicks; its first `downEvent` holds the main thread for `busyMs`. */
const heldPage = (busyMs, downEvent) => `<!doctype html><meta charset="utf-8"><button id="b" style="width:220px;height:64px">Press</button>
<script>
  window.__clicks = 0;
  const b = document.getElementById("b");
  b.addEventListener("click", () => { window.__clicks++; });
  b.addEventListener(${JSON.stringify(downEvent)}, () => { const until = Date.now() + ${Number(busyMs)}; while (Date.now() < until) {} }, { once: true });
</script>`;

/** Runs `fn`, keeping what it writes to stderr (the helper reports there, which the CI log shows). */
async function withStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { lines.push(String(chunk)); return write.call(this, chunk, ...rest); };
  try {
    return { error: null, value: await fn(), text: () => lines.join("") };
  } catch (error) {
    return { error, value: undefined, text: () => lines.join("") };
  } finally {
    process.stderr.write = write;
  }
}

/** Clicks the page counted once every input sent before this one has been handled (input is handled in order). */
async function clicksAfterInputDrains(page) {
  await page.mouse.move(2, 2);
  return page.evaluate(() => window.__clicks);
}

test("a click the browser holds past the first 4 s is waited for, and lands once", async ({ page }) => {
  await page.setContent(heldPage(6500, "mousedown"));
  const t0 = Date.now();
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "held click", "click", 20000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  // The witness of the path taken: the first 4 s ran out after the input was sent.
  expect(Date.now() - t0, "the press must have outlasted the helper's first 4 s").toBeGreaterThan(4000);
  expect(r.text()).toMatch(/\[render-stall\] held click: the click was sent and the browser never confirmed it; the control received it \([^)]*\bclick\b[^)]*\), so it is not sent again/);
  expect(await clicksAfterInputDrains(page), "the held click lands once and is never sent again").toBe(1);
});

test("a click held past the whole budget fails by name, and is still never sent twice", async ({ page }) => {
  await page.setContent(heldPage(9000, "mousedown"));
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "held click", "click", 6000));
  expect(r.error, "a press whose input never reaches the control must fail").not.toBeNull();
  expect(String(r.error && r.error.message)).toMatch(/^held click: the click was sent and the browser never confirmed it, and in \d+ s more it never reached the control \(.+\); it is not sent again/);
  // Once the page is free again, the one click it was holding is handled.
  await expect.poll(() => page.evaluate(() => window.__clicks), { timeout: 15000 }).toBe(1);
  expect(await clicksAfterInputDrains(page), "the helper must not have sent the click a second time").toBe(1);
});

/** Keeps the page's main thread busy for `ms` from its next task, as a loaded runner's WebKit was when a press began. */
const busyFor = (page, ms) => page.evaluate((ms) => { setTimeout(() => { const until = Date.now() + ms; while (Date.now() < until) {} }, 0); }, ms);

test("a page too busy to arm the witness at once is waited for, and the held click still lands once", async ({ page }) => {
  await page.setContent(heldPage(6500, "mousedown"));
  await busyFor(page, 1500);
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "busy click", "click", 20000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  // The witness of the path taken: arming outlasted the old 500 ms bound, then the click was held.
  expect(r.text()).toMatch(/\[render-stall\] busy click: the page took \d+\.\d s to arm the click's witness; the click was sent once it was armed/);
  expect(r.text()).toMatch(/\[render-stall\] busy click: the click was sent and the browser never confirmed it; the control received it \([^)]*\bclick\b[^)]*\), so it is not sent again/);
  expect(await clicksAfterInputDrains(page), "the held click lands once and is never sent again").toBe(1);
});

test("a page that does not answer in time to arm the witness fails by name, and the click is never sent twice", async ({ page }) => {
  await page.setContent(heldPage(6500, "mousedown"));
  await busyFor(page, 4000);
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "busy click", "click", 6000));
  expect(r.error, "a press nothing witnessed and the browser never confirmed must fail").not.toBeNull();
  expect(String(r.error && r.error.message)).toMatch(/^busy click: the click was sent and the browser never confirmed it, and its witness was never armed \(the page did not answer in \d+ s\), so nothing can tell whether it arrived; it is not sent again/);
  await expect.poll(() => page.evaluate(() => window.__clicks), { timeout: 15000 }).toBe(1);
  expect(await clicksAfterInputDrains(page), "the helper must not have sent the click a second time").toBe(1);
});

test("a tap the browser holds is waited for the same way", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true });
  try {
    const page = await ctx.newPage();
    await page.setContent(heldPage(6500, "touchstart"));
    const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "held tap", "tap", 20000));
    expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
    expect(r.text()).toMatch(/\[render-stall\] held tap: the tap was sent and the browser never confirmed it; the control received it \([^)]+\), so it is not sent again/);
    await expect.poll(() => page.evaluate(() => window.__clicks), { timeout: 5000 }).toBe(1);
    expect(await clicksAfterInputDrains(page), "the held tap lands once and is never sent again").toBe(1);
  } finally {
    await ctx.close();
  }
});

test("a trial the browser holds is answered by the in-page checks, and nothing it sent clicks", async ({ page }) => {
  // A trial's input is real, but Playwright's hit-target interceptor stops its
  // down, up and click events before any page listener sees them; it lets the
  // move through, so a busy mousemove listener holds the browser's
  // confirmation as a CI stall does.
  await page.setContent(heldPage(0, "mousedown"));
  await page.evaluate(() => window.addEventListener("mousemove", () => { const until = Date.now() + 6500; while (Date.now() < until) {} }, { capture: true, once: true }));
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "held trial", "trial", 20000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  expect(r.text()).toMatch(/\[render-stall\] held trial: the trial was sent and the browser never confirmed it; checking in the page instead/);
  expect(r.text()).toMatch(/\[render-stall\] held trial: no frame painted; checked in the page\n/);
  expect(await clicksAfterInputDrains(page), "a trial never clicks").toBe(0);
});

test("control: a click nothing holds is sent once, and the helper says nothing", async ({ page }) => {
  await page.setContent(heldPage(0, "mousedown"));
  const t0 = Date.now();
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "plain click", "click", 20000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(r.text()).not.toContain("[render-stall]");
  expect(await clicksAfterInputDrains(page)).toBe(1);
});

// 9.2.12 — the in-page checks scroll a covered control with each of Playwright's
// own retry alignments in turn. A phone-short window had opened scrolled past a
// workspace's header, so its ⋯ button was above the window; "nearest", the only
// scroll the checks made, laid it under the sticky header every try, and the
// press failed "covered by profile-menu-btn" (CI, 24 Nov 2026), where
// Playwright's own click scrolls it clear. Here the page paints nothing (its
// requestAnimationFrame never calls back), so once a settle has found the stall
// the press goes straight to the checks in the page.
const coveredPage = `<!doctype html><meta charset="utf-8">
<header id="hdr" style="position:sticky;top:0;height:64px;z-index:100;background:#fff"><button id="acct" style="float:right;width:44px;height:44px">A</button></header>
<p style="height:40px;margin:0">top</p>
<button id="b" style="display:block;margin-left:auto;width:44px;height:44px">More</button>
<div style="height:3000px"></div>
<script>
  window.__clicks = 0; window.__acct = 0;
  document.getElementById("b").addEventListener("click", () => { window.__clicks++; });
  document.getElementById("acct").addEventListener("click", () => { window.__acct++; });
  window.requestAnimationFrame = () => 0;
</script>`;

test("a control the window was scrolled past is brought clear of a sticky header by the in-page checks, and pressed once", async ({ page }) => {
  await page.setContent(coveredPage);
  // PRECONDITION: the case the checks met. Scrolled past, "nearest" lays the
  // control under the header, where the press would land on the account button.
  const nearest = await page.evaluate(() => {
    window.scrollTo(0, 600);
    const b = document.getElementById("b");
    const above = b.getBoundingClientRect().bottom < 0;
    b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    window.scrollTo(0, 600);
    return { above, hit: hit ? hit.id : null, sy: scrollY };
  });
  expect(nearest, "PRECONDITION: above the window, and under the header once scrolled to the nearest edge").toEqual({ above: true, hit: "acct", sy: 600 });
  const settled = await withStderr(() => settleThroughRenderStall(page.locator("#b"), "covered settle", 6000));
  expect(settled.text(), "PRECONDITION: the stall was found").toContain("[render-stall] covered settle: no frame painted; not waiting for animations");
  const r = await withStderr(() => pressThroughRenderStall(page.locator("#b"), "covered click", "click", 8000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  expect(r.text(), "the press took the in-page path").toContain("[render-stall] covered click: no frame painted; checked in the page, then a forced click\n");
  expect(await clicksAfterInputDrains(page), "the control was pressed once").toBe(1);
  expect(await page.evaluate(() => window.__acct), "and the header's button never").toBe(0);
});

/** A document at `path` whose DOMContentLoaded waits on a deferred script the test holds for `holdMs`. */
async function heldDocument(page, path, holdMs) {
  await page.route(`**${path}`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>held</title><script defer src="${path}.held.js"></script><p>parsed</p>` }));
  await page.route(`**${path}.held.js`, async (route) => {
    await new Promise((r) => setTimeout(r, holdMs));
    await route.fulfill({ contentType: "text/javascript", body: "window.__deferredRan = true;" }).catch(() => {});
  });
}

/** The page's own record: its deferred script ran and DOMContentLoaded fired. */
const contentLoaded = (page) => page.evaluate(() => window.__deferredRan === true && performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd > 0);

/** Frames the page lets a script count in 300 ms (0 once `requestAnimationFrame` is stubbed out). */
const framesCounted = (page) => page.evaluate(() => new Promise((resolve) => { let n = 0; requestAnimationFrame(() => n++); setTimeout(() => resolve(n), 300); }));

test("goto: a document the page has not finished is waited for, though it paints nothing", async ({ page }) => {
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await heldDocument(page, "/__held-document", 7000);
  const t0 = Date.now();
  const r = await withStderr(() => gotoThroughRenderStall(page, `${BASE}/__held-document`, "held document", 20000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  expect(Date.now() - t0, "the deferred script was held for 7 s").toBeGreaterThan(7000);
  expect(await contentLoaded(page), "the helper must not return before the page fired DOMContentLoaded").toBe(true);
  expect(r.text(), "a page that is only slow is not a stall").not.toContain("[render-stall]");
  expect(await framesCounted(page), "precondition: the page paints nothing the helper could count").toBe(0);
});

test("goto: a document the page never finishes fails by name, saying what the page reports", async ({ page }) => {
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await heldDocument(page, "/__held-document", 15000);
  const r = await withStderr(() => gotoThroughRenderStall(page, `${BASE}/__held-document`, "held document", 8000));
  expect(r.error, "a document whose DOMContentLoaded never fires must fail").not.toBeNull();
  expect(String(r.error && r.error.message)).toMatch(/^held document: domcontentloaded never fired in 8000 ms \(the page reports readyState "interactive", DOMContentLoaded not fired\)$/);
  expect(await contentLoaded(page), "precondition: the page had not fired it").toBe(false);
});

test("goto control: a document nothing holds is reached at once, and the helper says nothing", async ({ page }) => {
  await heldDocument(page, "/__held-document", 0);
  const t0 = Date.now();
  const r = await withStderr(() => gotoThroughRenderStall(page, `${BASE}/__held-document`, "plain document", 20000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(await contentLoaded(page)).toBe(true);
  expect(r.text()).not.toContain("[render-stall]");
});

/** Counts requests for the document at `path`; each of the first `held` goes unanswered while the test runs. */
async function uncommittedDocument(page, path, held) {
  const doc = { sent: 0 };
  await page.route(`**${path}`, async (route) => {
    doc.sent++;
    if (doc.sent <= held) { await new Promise((r) => setTimeout(r, 20000)); await route.abort().catch(() => {}); return; }
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>answered ${doc.sent}</title><p>parsed</p>` }).catch(() => {});
  });
  return doc;
}

test("goto: a navigation not committed in a third of its budget is sent once more, and says so", async ({ page }) => {
  const doc = await uncommittedDocument(page, "/__uncommitted-document", 1);
  const t0 = Date.now();
  const r = await withStderr(() => gotoThroughRenderStall(page, `${BASE}/__uncommitted-document`, "uncommitted document", 12000));
  expect(r.error, r.error ? String(r.error.message) : "").toBeNull();
  const ms = Date.now() - t0;
  expect(doc.sent, "sent once more, and only once").toBe(2);
  expect(ms, "the first send had a third of the 12 s").toBeGreaterThan(4000);
  expect(ms, "the second send was not kept waiting for the whole budget").toBeLessThan(8000);
  expect(r.text()).toContain('[render-stall] uncommitted document: the navigation had not committed in 4000 ms (the test still sees about:blank); sending it once more');
  expect(await page.title(), "the page shows what the second send was answered with").toBe("answered 2");
});

test("goto: a navigation that never commits fails by name, sent twice and no more", async ({ page }) => {
  const doc = await uncommittedDocument(page, "/__uncommitted-document", 2);
  const r = await withStderr(() => gotoThroughRenderStall(page, `${BASE}/__uncommitted-document`, "uncommitted document", 9000));
  expect(r.error, "a navigation that never commits must fail").not.toBeNull();
  expect(String(r.error && r.error.message)).toBe('uncommitted document: the navigation never committed in 9000 ms, sent twice (the test still saw about:blank after the first)');
  // On the CI runner Chromium cancels the second send before it reaches the
  // network (main CI, 17 Nov 2026: one request seen, on both tries), so the
  // helper's own line proves it was sent; the route proves no third request.
  expect(r.text()).toContain('[render-stall] uncommitted document: the navigation had not committed in 3000 ms (the test still sees about:blank); sending it once more');
  expect(doc.sent, "never a third request").toBeLessThanOrEqual(2);
});

// Chromium can answer the second send itself as cancelled (net::ERR_ABORTED: seen
// once on the CI runner, where the test above got that raw error instead of its
// named failure). Here it does so every time, before the request reaches the
// route; were it ever to reach it, the route aborts it as "aborted" too.
test("goto: a second send the browser cancels is waited out and fails by the same name, never sent a third time", async ({ page }) => {
  const doc = { sent: 0 };
  await page.route("**/__cancelled-document", async (route) => {
    doc.sent++;
    if (doc.sent === 1) { await new Promise((r) => setTimeout(r, 20000)); await route.abort().catch(() => {}); return; }
    await route.abort("aborted").catch(() => {});
  });
  const t0 = Date.now();
  const r = await withStderr(() => gotoThroughRenderStall(page, `${BASE}/__cancelled-document`, "cancelled document", 6000));
  expect(r.error, "a cancelled second send must fail").not.toBeNull();
  expect(String(r.error && r.error.message)).toBe('cancelled document: the navigation never committed in 6000 ms, sent twice (the test still saw about:blank after the first)');
  expect(Date.now() - t0, "the rest of the budget was waited out").toBeGreaterThan(5000);
  // Chromium often cancels the second send before it reaches the network (the
  // CI flake exactly), so the helper's own line proves it was sent; the route
  // proves no third request.
  expect(r.text()).toContain('[render-stall] cancelled document: the navigation had not committed in 2000 ms (the test still sees about:blank); sending it once more');
  expect(doc.sent, "never a third request").toBeLessThanOrEqual(2);
});
