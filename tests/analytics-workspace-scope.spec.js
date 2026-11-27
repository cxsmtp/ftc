// @ts-check
//
// ANALYTICS INSIDE AN EVENT'S WORKSPACE IS THAT EVENT (owner's decision, 27 Nov
// 2026). The workspace's Analytics section offers no Global/Event switch and no
// event picker: its scope card names the event and, where the event has
// sessions, narrows to one. The sidebar's Analytics is the cross-event page and
// keeps the switch (the CONTROL). The requests are the witness: every one the
// workspace section sends names this event, and choosing a session sends that
// session's id.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin, viewComp } = require("./ui-admin-helpers");
const { H, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

let comp, slots = [];
test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const name = `Analytics ws ${uniq("e")}`;
    const now = Date.now();
    const r = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name, event_kind: "tournament", start_time: new Date(now + 2 * 86400e3).toISOString(), duration_minutes: 600 },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const d = await r.json();
    comp = { id: (d.competition && d.competition.id) || d.id, name };
    for (const [nm, h] of [["Morning", 50], ["Evening", 60]]) {
      const t = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(csrf), data: { name: nm, start_time: new Date(now + h * 3600e3).toISOString(), duration_minutes: 60 },
      });
      expect(t.ok(), await t.text()).toBeTruthy();
      const td = await t.json();
      slots.push({ id: (td.timeslot && td.timeslot.id) || td.id, name: nm });
    }
  } finally { await api.dispose(); }
});

test("the workspace's Analytics names its event, offers no Global/Event switch or event picker, and narrows to a session", async ({ page }) => {
  test.setTimeout(90_000);
  const asked = [];
  page.on("request", (rq) => { if (rq.url().includes("/api/admin/analytics/challenges")) asked.push(new URL(rq.url()).searchParams); });
  await adminLogin(page);
  await viewComp(page, comp.name);
  await page.locator('#ws-tabs [data-section="admin-analytics-tab"]').click();
  const bar = page.locator("#analytics-filterbar");
  await expect(bar.locator("#analytics-ws-scope")).toBeVisible({ timeout: 15000 });
  await expect(bar.locator("#analytics-ws-scope .analytics-ws-event")).toContainText(comp.name);
  await expect(bar.locator('[data-action="analytics-set-scope"]'), "no Global/Event/Session switch").toHaveCount(0);
  await expect(bar.locator('[data-action="analytics-open-comp-picker"]'), "no event picker").toHaveCount(0);
  await expect.poll(() => asked.length, { timeout: 15000, message: "the section asked for its figures" }).toBeGreaterThan(0);
  expect(asked.every(q => q.get("competitionId") === comp.id), "every request names this event").toBe(true);
  expect(asked.every(q => !q.get("timeslotId")), "the whole event first").toBe(true);

  const sel = bar.locator("#analytics-ws-slot");
  await expect(sel.locator("option")).toHaveText(["Whole event", "Morning", "Evening"]);
  const before = asked.length;
  await sel.selectOption({ label: "Evening" });
  await expect.poll(() => asked.length, { timeout: 15000 }).toBeGreaterThan(before);
  const last = asked[asked.length - 1];
  expect(last.get("competitionId")).toBe(comp.id);
  expect(last.get("timeslotId"), "the session's own figures").toBe(slots[1].id);
  await expect(sel).toHaveValue(slots[1].id);
});

test("CONTROL: the sidebar's Analytics keeps the Global / Event / Session switch", async ({ page }) => {
  await adminLogin(page);
  await page.locator("button.admin-nav-item[data-tab-id='admin-analytics-tab']").first().click();
  await expect(page.locator("#admin-analytics-tab")).toBeVisible();
  const bar = page.locator("#analytics-filterbar");
  await expect(bar.locator('[data-action="analytics-set-scope"][data-value="global"]')).toBeVisible({ timeout: 15000 });
  await expect(bar.locator('[data-action="analytics-set-scope"][data-value="competition"]')).toBeVisible();
  await expect(bar.locator("#analytics-ws-scope")).toHaveCount(0);
});
