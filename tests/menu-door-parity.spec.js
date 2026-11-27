// @ts-check
//
// THE TWO EVENT MENUS AGREE ON THE DOORS THEY SHARE.
//
// An event has two menus built by two functions: the Events-list row kebab
// (`compMenuItemsHtml`, features/competitions-admin.js) and the workspace
// header's ⋯ menu (`wsMenuItemsHtml`, features/event-workspace.js). Their door
// SETS differ on purpose (each workspace action has one place: Clone, Export
// everything, Sign up at the desk and Save as template live only in the header;
// Manage Participants only on the row). Every door they BOTH offer must answer
// the same for the same event and the same viewer, or one surface offers a door
// the other withholds and the route refuses one of them.
//
// Each builder re-states its predicates, so this is the lock that keeps them
// in step: a matrix of event states and viewers, both builders run in the
// browser on the same fake row, the shared doors compared by value. The matrix
// is anti-vacuous: every shared door is offered in some state and withheld in
// another, by both builders.
const { test, expect } = require("./isolated-test");
const { adminLogin } = require("./ui-admin-helpers");
const { BASE } = require("./helpers");

test.use({ baseURL: BASE });

const SHARED = [
  "comp-edit", "comp-history", "comp-organisers", "comp-delivery", "comp-export-activity",
  "comp-self-enroll", "comp-assign-challenges", "comp-start-now", "comp-end-now", "comp-delete",
  "comp-close-late-entries",
];

test("the Events-row menu and the workspace ⋯ menu offer the same shared doors in every state", async ({ page }) => {
  await adminLogin(page);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => typeof window.compMenuItemsHtml === "function" && typeof window.wsMenuItemsHtml === "function");

  const out = await page.evaluate((shared) => {
    const acts = (html) => [...String(html).matchAll(/data-action="([^"]+)"/g)].map(m => m[1]).filter(a => shared.includes(a)).sort();
    const H = 3600e3, now = Date.now();
    const rows = [];
    const saved = { sa: window.isSuperAdmin, ea: window.isEventAdmin };
    try {
      for (const status of ["upcoming", "live", "ended"]) {
        for (const timeslots of [[], [{ id: "s1", name: "S1", start_time: new Date(now + H).toISOString(), duration_minutes: 30 }]]) {
          for (const competing of [false, true]) {
            for (const late of [false, true]) {
              for (const canClose of [false, true]) {
                for (const futureEnd of [false, true]) {
                  for (const [sa, ea] of [[true, false], [false, false], [false, true]]) {
                    window.isSuperAdmin = sa; window.isEventAdmin = ea;
                    const c = {
                      id: "parity", name: "Parity", event_kind: "booth", status, timeslots, competing,
                      late_entry_window_open: late, can_close_late_entries: canClose,
                      effective_end: new Date(now + (futureEnd ? H : -H)).toISOString(),
                      start_time: new Date(now - H).toISOString(), duration_minutes: 60, tags: [],
                    };
                    rows.push({ key: JSON.stringify({ status, sessions: timeslots.length, competing, late, canClose, futureEnd, sa, ea }),
                      row: acts(window.compMenuItemsHtml(c)), ws: acts(window.wsMenuItemsHtml(c)) });
                  }
                }
              }
            }
          }
        }
      }
    } finally { window.isSuperAdmin = saved.sa; window.isEventAdmin = saved.ea; }
    return rows;
  }, SHARED);

  expect(out.length, "PRECONDITION: the matrix ran").toBeGreaterThan(100);
  const mismatched = out.filter(r => JSON.stringify(r.row) !== JSON.stringify(r.ws));
  expect(mismatched.map(r => `${r.key}\n  row: ${r.row.join(",")}\n  ws:  ${r.ws.join(",")}`), "the shared doors agree").toEqual([]);
  // ANTI-VACUITY: every shared door is offered somewhere and withheld somewhere.
  for (const door of SHARED) {
    expect(out.some(r => r.row.includes(door)), `${door} is offered in some state`).toBe(true);
    if (!["comp-history", "comp-organisers", "comp-delivery"].includes(door)) {
      expect(out.some(r => !r.row.includes(door)), `${door} is withheld in some state`).toBe(true);
    }
  }
});
