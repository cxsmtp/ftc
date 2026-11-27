// @ts-check
//
// OPENING ANOTHER EVENT FROM AN OVERVIEW READS ITS OVERVIEW ONCE
// (features/event-workspace.js). The command palette's event results and a
// report's deep-link button open an event while another event's Overview is on
// screen; the open renders the new event's Overview, and nothing else may render
// it a second time on the way (each render reads GET …/overview-pulse). The
// reads are counted in the page, around the open itself: every render issues its
// read before the open returns, so the count is final when it does.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const { makeCompetition } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/** Open `comp`'s workspace, once the Events model holds it, on its Overview. */
async function openOverview(page, comp) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some((c) => c.id === id), comp.id),
    { timeout: 15000, message: "PRECONDITION: the Events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: comp.id, n: comp.name });
  await expect(page.locator("#ws-title")).toHaveText(comp.name, { timeout: 15000 });
  await expect(page.locator("#admin-event-overview-tab")).toBeVisible();
}

/** Open `comp` from where the page is, counting its Overview reads. */
function openCounting(page, comp) {
  return page.evaluate(({ id, n }) => {
    let reads = 0;
    const f0 = window.fetch;
    window.fetch = function (u) {
      const url = typeof u === "string" ? u : (u && u.url) || "";
      if (url.includes(`/api/admin/competitions/${encodeURIComponent(id)}/overview-pulse`)) reads++;
      return f0.apply(this, arguments);
    };
    try { window.openEventWorkspace(id, n); } finally { window.fetch = f0; }
    return reads;
  }, { id: comp.id, n: comp.name });
}

test("opening another event from an event's Overview reads the new Overview once", async ({ page }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let first, second;
  try {
    first = await makeCompetition(sa, csrf, "switchA");
    second = await makeCompetition(sa, csrf, "switchB");
  } finally { await sa.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  // The events poll re-reads the pulse on its own: stopped, so every read below
  // is the open's.
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  await openOverview(page, first);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 15000 });

  expect(await openCounting(page, second), "one read of the new event's Overview").toBe(1);
  await expect(page.locator("#ws-title")).toHaveText(second.name, { timeout: 15000 });
  await expect(page.locator("#admin-event-overview-tab"), "on its Overview").toBeVisible();
  // CONTROL: back to the first, the same count — the counter sees the open's read.
  expect(await openCounting(page, first), "one read of the first event's Overview").toBe(1);
  await expect(page.locator("#ws-title")).toHaveText(first.name, { timeout: 15000 });
});
