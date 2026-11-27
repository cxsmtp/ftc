"use strict";

/**
 * v8.8.15 — ONE REVOKE STRATEGY FOR EVERY GENERATED DOWNLOAD.
 *
 * Four call sites had grown four implementations with three ideas about when to
 * release the object URL: a `setTimeout(0)`, two `pagehide` listeners, and one
 * SYNCHRONOUS revoke. v8.3.17 (F10) filed the inconsistency and this codebase
 * pushed back on the proposed remedy — its measured-Safari premise is
 * unsupported, it was internally inconsistent, and `pagehide` retention on a
 * multi-megabyte export in an SPA that never navigates is a real cost. So the
 * consolidation is deliberately NOT that remedy: `ui/download.js` revokes on a
 * generous timer OR on `pagehide`, whichever comes first, which strictly
 * dominates all three.
 *
 * THIS FILE IS THE BEHAVIOURAL HALF, and it exists because the two properties
 * that matter are invisible to any source check:
 *
 *   * the URL must still resolve AFTER the click — the synchronous revoke is
 *     the one shape with a real mechanism against it, since the click is
 *     dispatched synchronously and the browser reads the blob afterwards; and
 *   * it must eventually be released — otherwise "the download works" is
 *     satisfied by a build that leaks every blob for the life of the tab, which
 *     is the `pagehide`-only shape this replaces.
 *
 * Both are driven through a REAL export control, not a synthetic call, so the
 * assertion is about what an admin's click actually does.
 */
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

/** Watch object-URL lifetime without changing it. */
async function instrument(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__dl = { created: [], revoked: [] };
    const co = URL.createObjectURL.bind(URL), ro = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => { const u = co(b); w.__dl.created.push(u); return u; };
    URL.revokeObjectURL = (u) => { w.__dl.revoked.push(u); return ro(u); };
  });
}
const state = (page) => page.evaluate(() => /** @type {any} */ (window).__dl);

test.describe("v8.8.15 — a generated download's blob URL outlives the click", () => {
  test("the participants CSV: exactly one object URL, and NOT revoked in the same tick", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await instrument(page);

    // The real control, through the real renderer — `downloadCsv` builds the BOM
    // and hands the Blob to the shared helper.
    await page.evaluate(() => /** @type {any} */ (window).exportParticipantsCSV());

    const s = await expect.poll(async () => (await state(page)).created.length, { timeout: 10_000 })
      .toBeGreaterThan(0).then(() => state(page));
    expect(s.created.length, "the download created exactly one object URL").toBe(1);

    // THE ASSERTION THAT KILLS THE SYNCHRONOUS REVOKE. `downloadJson` used to do
    // exactly this, on the largest payload the panel produces.
    expect(s.revoked, "nothing was revoked in the same tick as the click").toEqual([]);

    // NOTE FOR WHOEVER WANTS TO STRENGTHEN THIS: fetching the blob: URL to prove
    // it still resolves does NOT work here and is not worth re-attempting — the
    // CSP is `connect-src 'self'`, which does not cover blob:, so the fetch
    // fails identically whether or not the URL was revoked. It measures the CSP,
    // not the helper. What makes the assertion above trustworthy instead is the
    // NEXT test: it shows this same recorder DOES capture a revoke when one
    // happens, so an empty list here is a real absence rather than a miss.
  });

  test("…and it IS released — pagehide fires the same one-shot release the timer would", async ({ page }) => {
    // The control for the assertion above: without it, "the URL survived the
    // click" is equally satisfied by a build that never revokes at all, which is
    // a leak rather than a fix. The 60-second timer cannot be waited out in a
    // test, so the OTHER arm of the same one-shot release is driven instead —
    // the two call the identical `release()`.
    await adminLogin(page);
    await clickTab(page, "Participants");
    await instrument(page);
    await page.evaluate(() => /** @type {any} */ (window).exportParticipantsCSV());
    await expect.poll(async () => (await state(page)).created.length, { timeout: 10_000 }).toBeGreaterThan(0);

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    const s = await state(page);
    expect(s.revoked, "the blob was released").toEqual(s.created);

    // Idempotent: the timer and the listener both call one guarded `release()`,
    // so a second pagehide must not double-revoke.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    expect((await state(page)).revoked.length, "release is one-shot").toBe(1);
  });

  test("downloadJson takes it too — the site that revoked SYNCHRONOUSLY", async ({ page }) => {
    // Named separately because it is the one with a real mechanism against it,
    // and the one carrying the biggest payload (a full challenge export).
    await adminLogin(page);
    await instrument(page);
    const ok = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      if (typeof w.downloadJson !== "function") return "no downloadJson";
      w.downloadJson({ a: 1 }, "probe.json");
      return "ok";
    });
    expect(ok, "downloadJson is reachable").toBe("ok");
    const s = await state(page);
    expect(s.created.length, "one URL").toBe(1);
    expect(s.revoked, "the synchronous revoke is gone").toEqual([]);
  });
});
