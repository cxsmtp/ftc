// @ts-check
//
// THE TWO EVENT MENUS AGREE ON THE DOORS THEY SHARE, AND SHARE ONLY DELETE.
//
// An event has two menus built by two functions: the Events-list row kebab
// (`compMenuItemsHtml`, features/competitions-admin.js) and the workspace
// header's ⋯ menu (`wsMenuItemsHtml`, features/event-workspace.js). Every event
// is run from its workspace, so the row menu keeps only what the LIST needs
// (owner's decision, 27 Nov 2026: "remove only true duplication"): Delete event.
// Every other door (Edit settings, History, Email delivery, Export activity,
// Add challenges, Join-link settings, Start now, End now, Close late entries
// now) is the workspace's alone, and Organisers is in neither (the Overview's
// Organisers card is the one place).
//
// Each builder re-states its predicates, so this is the lock that keeps them in
// step: a matrix of event states and viewers, both builders run in the browser
// on the same fake row. It asserts (1) the row menu offers NO door beyond
// Delete event, in any state; (2) Delete answers the same in both menus, by
// value, with the same label; (3) neither menu offers Organisers, and the
// workspace menu still offers the doors the row gave up (anti-vacuity: each is
// offered somewhere, so a builder that offers nothing cannot pass).
const { test, expect } = require("./isolated-test");
const { adminLogin } = require("./ui-admin-helpers");
const { BASE } = require("./helpers");

test.use({ baseURL: BASE });

const SHARED = ["comp-delete"];
// The doors the row menu gave up: the workspace keeps every one.
const WORKSPACE_ONLY = [
  "comp-edit", "comp-history", "comp-delivery", "comp-export-activity", "comp-self-enroll",
  "comp-assign-challenges", "comp-start-now", "comp-end-now", "comp-close-late-entries",
];

test("the Events-row menu offers only Delete event, as the workspace ⋯ menu does, in every state", async ({ page }) => {
  await adminLogin(page);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => typeof window.compMenuItemsHtml === "function" && typeof window.wsMenuItemsHtml === "function");

  const out = await page.evaluate((shared) => {
    const all = (html) => [...String(html).matchAll(/data-action="([^"]+)"/g)].map(m => m[1]).sort();
    const acts = (html) => all(html).filter(a => shared.includes(a));
    const label = (html, act) => { const m = String(html).match(new RegExp(`data-action="${act}"[^>]*>(?:<svg[\\s\\S]*?</svg>)?\\s*([^<]+)<`)); return m ? m[1].trim() : null; };
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
                    const rowHtml = window.compMenuItemsHtml(c), wsHtml = window.wsMenuItemsHtml(c);
                    rows.push({ key: JSON.stringify({ status, sessions: timeslots.length, competing, late, canClose, futureEnd, sa, ea }),
                      row: acts(rowHtml), ws: acts(wsHtml), rowAll: all(rowHtml), wsAll: all(wsHtml),
                      rowDelLabel: label(rowHtml, "comp-delete"), wsDelLabel: label(wsHtml, "comp-delete") });
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
  // (1) The row menu holds nothing but Delete event, in every state.
  const extra = out.filter(r => r.rowAll.some(a => a !== "comp-delete"));
  expect(extra.map(r => `${r.key}: ${r.rowAll.join(",")}`), "the row menu offers only Delete event").toEqual([]);
  // (2) Delete answers the same in both menus, with the same words.
  const mismatched = out.filter(r => JSON.stringify(r.row) !== JSON.stringify(r.ws));
  expect(mismatched.map(r => `${r.key}\n  row: ${r.row.join(",")}\n  ws:  ${r.ws.join(",")}`), "Delete agrees").toEqual([]);
  const labelled = out.filter(r => r.row.includes("comp-delete"));
  expect(labelled.length, "PRECONDITION: Delete is offered somewhere").toBeGreaterThan(0);
  for (const r of labelled) expect(r.rowDelLabel, `${r.key}: the same label`).toBe(r.wsDelLabel);
  expect(labelled[0].rowDelLabel).toBe("Delete event");
  expect(out.some(r => !r.row.includes("comp-delete")), "Delete is withheld in some state (a competitor)").toBe(true);
  // (3) Organisers is in neither menu (the Overview's card is the one place),
  // and the workspace keeps every door the row gave up.
  expect(out.filter(r => r.rowAll.includes("comp-organisers") || r.wsAll.includes("comp-organisers")).length, "no Organisers item").toBe(0);
  for (const door of WORKSPACE_ONLY) {
    expect(out.some(r => r.wsAll.includes(door)), `${door} is still offered by the workspace menu`).toBe(true);
  }
});
