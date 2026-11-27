// @ts-check
//
// v7.16.7 — the Phase-0 correctness fixes. Each of these was a WRONG ANSWER
// shipping, not a missing convenience, which is why they are locked separately
// from the ergonomics work that follows.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");

test.use({ baseURL: BASE });
const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test.describe("Unsubscribe list reports a TRUE total (v7.16.7)", () => {
  test("total is the row count, not the post-LIMIT count, and truncation is declared", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      const r = await api.get("/api/admin/unsubscribed");
      expect(r.ok(), `GET /api/admin/unsubscribed: ${r.status()}`).toBeTruthy();
      const d = await r.json();

      // The shape is the fix: `total` must be independent of how many rows were
      // returned. Previously it WAS rows.length, so the two could never
      // disagree and a truncated list looked complete.
      expect(d, "the payload declares how many were shown").toHaveProperty("shown");
      expect(d, "…and whether it was cut short").toHaveProperty("truncated");
      expect(d.shown, "shown matches the rows actually sent").toBe((d.entries || []).length);
      expect(d.total, "total is a count over the whole table, so it is never less than what was shown")
        .toBeGreaterThanOrEqual(d.shown);
      expect(d.truncated, "truncated is derived from the two, not guessed").toBe(d.total > d.shown);
    } finally { await api.dispose(); }
  });
});

test.describe("Competition pickers share ONE order (v7.16.7)", () => {
  test("live competitions come first, then soonest-starting — not furthest-future first", async ({ page }) => {
    // Five dialogs had four different orders between them. Descending by start
    // is actively wrong once ended competitions are excluded: it puts the
    // furthest-future competition at the top and the one starting within the
    // hour at the bottom.
    //
    // v8.12.4 — through the app's OWN comparator. The first draft sorted the
    // rows itself by start_time and never called compareCompsForPicker, so it
    // proved only that start times round-trip.
    const { adminLogin } = require("./ui-admin-helpers");
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    const made = [];
    try {
      for (const [label, offsetMs] of [["Zeta far", 30 * 864e5], ["Alpha soon", 36e5], ["Omega live", -10 * 60_000], ["Beta mid", 5 * 864e5]]) {
        const r = await api.post("/api/admin/competitions", {
          headers: h(csrf),
          data: { name: `PickOrder ${label} ${now}`, start_time: new Date(now + offsetMs).toISOString(), duration_minutes: 120 },
        });
        expect(r.ok(), `create ${label}: ${r.status()}`).toBeTruthy();
        made.push((await r.json()).competition.id);
      }
    } finally { await api.dispose(); }
    await adminLogin(page);
    await expect.poll(() => page.evaluate(ids => (window.S.adminCompetitionsData || []).filter(c => ids.includes(c.id)).length, made),
      { timeout: 20000 }).toBe(4);
    const order = await page.evaluate(ids => [...window.S.adminCompetitionsData].filter(c => ids.includes(c.id))
      .sort(window.compareCompsForPicker).map(c => c.name.split(" ").slice(1, 3).join(" ")), made);
    expect(order, "live first, then soonest start — the order every picker uses").toEqual(["Omega live", "Alpha soon", "Beta mid", "Zeta far"]);

    const { api: sa, csrf: c2 } = await apiLogin("superadmin");
    try {
      for (const id of made) {
        await sa.post(`/api/admin/competitions/${id}/end-now`, { headers: h(c2), data: {} }).catch(() => {});
        await sa.delete(`/api/admin/competitions/${id}`, { headers: { "x-csrf-token": c2 } });
      }
    } finally { await sa.dispose(); }
  });
});
