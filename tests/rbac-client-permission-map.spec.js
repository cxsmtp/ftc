"use strict";

// THE SPA'S PERMISSION MAPS, HELD TO THE SERVER'S (lib/rbac.js
// ADMIN_ROUTE_PERMISSIONS is the authority; public/js cannot import it, so the
// client keeps copies — CLAUDE.md, Client/server mirror registry):
//
//   * ui/nav.js ADMIN_NAV_PERMISSIONS — the permission each admin page's FIRST
//     read asks for, which decides whether its sidebar item is shown;
//   * features/event-workspace.js SECTION_PERMISSIONS — the same for each of an
//     event workspace's sections (its tab, the phone sheet, the palette's Go to);
//   * every `adminCan('<permission>')` in public/js — each a door's own route.
//
// Each page and section is decided here by the route its pane first reads
// (FIRST_READ tables below), in both directions: a page in the markup with no
// mapping, a mapping with no decision, or a decision for a page that no longer
// exists all fail. A permission the server's catalogue does not know fails: a
// typo answers "no" for every role and hides the door from everybody.

const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { stripJsComments } = require("./doc-registry");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The route each admin PAGE reads first (an array: the page opens for either).
// New event opens for its templates (their read) or for its blank starters,
// which read nothing and lead to the create route.
const NAV_FIRST_READ = {
  "admin-competitions-tab": ["GET /api/admin/competitions"],
  "admin-templates-tab": ["GET /api/admin/event-templates", "POST /api/admin/competitions"],
  "admin-tasks-tab": ["GET /api/admin/tasks"],
  "admin-participants-tab": ["GET /api/admin/participants"],
  "admin-groups-tab": ["GET /api/admin/groups"],
  "admin-rankings-tab": ["GET /api/admin/leaderboard"],
  "admin-submissions-tab": ["GET /api/admin/submissions"],
  "admin-analytics-tab": ["GET /api/admin/analytics/challenges"],
  "admin-marketing-tab": ["GET /api/admin/analytics/marketing"],
  "admin-logs-tab": ["GET /api/admin/logs"],
  // Settings opens for any of its cards' first reads (operator ruling, 14 Nov 2026).
  "admin-settings-tab": ["GET /api/admin/settings", "GET /api/admin/certificate-config", "GET /api/admin/alerts",
    "GET /api/admin/retention", "GET /api/admin/unsubscribed", "GET /api/admin/cxone/withdrawals"],
  "admin-users-tab": ["GET /api/admin/users"],
  "admin-audit-tab": ["GET /api/admin/audit"],
};
// Each Settings card's routes: ui/nav.js SETTINGS_CARD_PERMISSIONS shows a card
// to a role holding EVERY permission they check (operator ruling, 14 Nov 2026).
// The cards that gate themselves elsewhere are named in SELF_GATED_CARDS.
const SETTINGS_CARD_ROUTES = {
  "platform-name-card": ["GET /api/admin/settings", "PATCH /api/admin/settings"],
  "account-approval-card": ["GET /api/admin/settings", "PATCH /api/admin/settings"],
  "platform-look-card": ["GET /api/admin/settings", "PUT /api/admin/platform-look"],
  // The mail server in use is read by every Settings reader (owner decision,
  // 27 Nov 2026); its form (PUT, DELETE and the test, ops.smtp) is drawn only
  // where the read's own `can_edit` says so, everyone else reading "Only a
  // superadmin can change this." (tests/smtp-settings-ui.spec.js).
  "smtp-settings-card": ["GET /api/admin/smtp-settings"],
  "email-test-card": ["POST /api/admin/test-email"],
  "unsubscribe-card": ["GET /api/admin/unsubscribed", "DELETE /api/admin/unsubscribed/:email"],
  "cxone-card": ["GET /api/admin/settings", "PUT /api/admin/default-cxone", "DELETE /api/admin/default-cxone"],
  "cxone-withdrawals-card": ["GET /api/admin/cxone/withdrawals", "POST /api/admin/cxone/withdrawals/retry", "POST /api/admin/cxone/withdrawals/dismiss"],
  "retention-card": ["GET /api/admin/retention"],
  "alerts-card": ["GET /api/admin/alerts"],
  "system-health-card": ["GET /api/admin/system-health"],
  // The Checkmarx One API activity table: the audit trail's own read, narrowed
  // to the Checkmarx One activity.
  "cxone-audit-card": ["GET /api/admin/audit"],
};
const SELF_GATED_CARDS = {
  "cert-config-card": "certificateDesignOffered (certificates.design)",
  "team-domains-card": "features/event-team.js (settings.view)",
  "breakglass-account-card": "the break-glass session itself",
  "settings-load-failure": "the pane's own failure state",
  "release-notes-card": "docs/release-notes.md, offered by releaseNotesVisible (an admin-shaped session), as the server's docs gate serves it",
};

// The route each workspace SECTION reads first (Settings renders the event's
// own row, which the events read brought).
const SECTION_FIRST_READ = {
  "admin-event-overview-tab": "GET /api/admin/competitions/:id/overview-pulse",
  "admin-participants-tab": "GET /api/admin/participants",
  "admin-tasks-tab": "GET /api/admin/tasks",
  "admin-rankings-tab": "GET /api/admin/leaderboard",
  "admin-submissions-tab": "GET /api/admin/submissions",
  "admin-analytics-tab": "GET /api/admin/analytics/challenges",
  "admin-event-certs-tab": "GET /api/admin/competitions/:id/certificates",
  "admin-event-team-tab": "GET /api/admin/competitions/:id/team",
  "admin-event-settings-tab": "GET /api/admin/competitions",
};

/** The object literal `const NAME = { … }` in `src` (comments stripped), evaluated. */
function objectLiteral(src, name) {
  const s = stripJsComments(src);
  const m = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\{`).exec(s);
  if (!m) return null;
  let i = m.index + m[0].length - 1, depth = 0, q = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (q) { if (ch === "\\") { j++; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return Function(`"use strict"; return (${s.slice(i, j + 1)});`)();
  }
  return null;
}

/** The disagreements between a client map and the FIRST_READ table, both ways. */
function disagreements(clientMap, firstRead, routePerm) {
  const out = [];
  for (const [key, perm] of Object.entries(clientMap)) {
    if (!(key in firstRead)) { out.push(`${key}: no FIRST_READ decision in this spec`); continue; }
    const routes = [].concat(firstRead[key]);
    const want = routes.map(routePerm);
    if (want.includes(undefined)) { out.push(`${key}: a FIRST_READ route is not in ADMIN_ROUTE_PERMISSIONS (${routes.join(", ")})`); continue; }
    const got = [].concat(perm);
    if (got.length !== want.length || got.some((p) => !want.includes(p))) out.push(`${key}: the SPA asks ${JSON.stringify(perm)}, its first read needs ${JSON.stringify(want.length === 1 ? want[0] : want)}`);
  }
  for (const key of Object.keys(firstRead)) if (!(key in clientMap)) out.push(`${key}: a FIRST_READ decision for a page the SPA does not map`);
  return out;
}

test.describe("RBAC — the SPA's permission maps agree with the server's route map", () => {
  let rbac, routePerm, navMap, sectionMap;
  test.beforeAll(() => {
    // lib/rbac.js reaches db.js only lazily, inside functions this spec never calls.
    rbac = require("../lib/rbac");
    routePerm = (route) => (rbac.ADMIN_ROUTE_PERMISSIONS.get(route) || {}).perm;
    navMap = objectLiteral(read("public/js/ui/nav.js"), "ADMIN_NAV_PERMISSIONS");
    sectionMap = objectLiteral(read("public/js/features/event-workspace.js"), "SECTION_PERMISSIONS");
  });

  test("every sidebar page asks the permission its pane first reads, and every page in the markup is mapped", () => {
    expect(navMap, "ADMIN_NAV_PERMISSIONS was found and parsed").toBeTruthy();
    expect(Object.keys(navMap).length, "anti-vacuity: the map holds the admin pages").toBeGreaterThanOrEqual(10);
    expect(disagreements(navMap, NAV_FIRST_READ, routePerm)).toEqual([]);
    const items = [...read("public/index.html").matchAll(/class="admin-nav-item"[^>]*data-tab-id="(admin-[a-z-]+)"/g)].map((m) => m[1]);
    expect(items.length, "anti-vacuity: the sidebar's items were found").toBeGreaterThanOrEqual(8);
    expect(items.filter((id) => !(id in navMap)), "every sidebar item has a permission").toEqual([]);
  });

  test("every workspace section asks the permission its pane first reads, and every section tab is mapped", () => {
    expect(sectionMap, "SECTION_PERMISSIONS was found and parsed").toBeTruthy();
    expect(disagreements(sectionMap, SECTION_FIRST_READ, routePerm)).toEqual([]);
    const tabs = [...read("public/index.html").matchAll(/class="ws-tab[^"]*"[^>]*data-section="(admin-[a-z-]+)"/g)].map((m) => m[1]);
    expect(tabs.length, "anti-vacuity: the section tabs were found").toBeGreaterThanOrEqual(8);
    expect(tabs.filter((id) => !(id in sectionMap)), "every section tab has a permission").toEqual([]);
  });

  test("every permission the SPA asks for exists in the server's catalogue", () => {
    const dir = path.join(ROOT, "public/js");
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
    walk(dir);
    const asked = [];
    for (const f of files) {
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(/\badminCan\(\s*(['"])([^'"]+)\1\s*\)/g)) asked.push({ file: path.relative(ROOT, f), perm: m[2] });
    }
    expect(asked.length, "anti-vacuity: the SPA's permission asks were found").toBeGreaterThanOrEqual(60);
    for (const v of [...Object.values(navMap), ...Object.values(sectionMap)]) for (const p of [].concat(v)) asked.push({ file: "a permission map", perm: p });
    const unknown = asked.filter((a) => !rbac.PERMISSION_IDS.has(a.perm)).map((a) => `${a.file}: ${a.perm}`);
    expect(unknown, "a permission the server does not define answers no for every role").toEqual([]);
  });

  test("every Settings card asks exactly the permissions its routes check, and every card in the markup is decided", () => {
    const cards = objectLiteral(read("public/js/ui/nav.js"), "SETTINGS_CARD_PERMISSIONS");
    expect(cards, "SETTINGS_CARD_PERMISSIONS was found and parsed").toBeTruthy();
    expect(Object.keys(cards).length, "anti-vacuity: the cards are mapped").toBeGreaterThanOrEqual(8);
    const bad = [];
    for (const [id, routes] of Object.entries(SETTINGS_CARD_ROUTES)) {
      const want = [...new Set(routes.map(routePerm))].sort();
      if (want.includes(undefined)) { bad.push(`${id}: a route is not in ADMIN_ROUTE_PERMISSIONS`); continue; }
      const got = [...new Set([].concat(cards[id] || []))].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${id}: the SPA asks ${JSON.stringify(got)}, its routes check ${JSON.stringify(want)}`);
    }
    for (const id of Object.keys(cards)) if (!(id in SETTINGS_CARD_ROUTES)) bad.push(`${id}: no SETTINGS_CARD_ROUTES decision in this spec`);
    expect(bad).toEqual([]);
    // Both ways against the markup: every Settings card is mapped or gates itself.
    const html = read("public/index.html");
    const pane = html.slice(html.indexOf('<div id="admin-settings-tab"'), html.indexOf('<div id="admin-users-tab"'));
    const inMarkup = [...pane.matchAll(/<div\b[^>]*\bclass="card settings-card[^"]*"[^>]*>/g)]
      .map((m) => (/\bid="([a-z0-9-]+)"/.exec(m[0]) || [])[1]).filter(Boolean);
    expect(inMarkup.length, "anti-vacuity: the Settings cards were found").toBeGreaterThanOrEqual(10);
    expect(inMarkup.filter((id) => !(id in cards) && !(id in SELF_GATED_CARDS)), "every Settings card is decided").toEqual([]);
    for (const id of [...Object.keys(cards), ...Object.keys(SELF_GATED_CARDS)]) expect(inMarkup, `${id} is a card in the markup`).toContain(id);
  });

  test("CONTROL — the comparison catches a wrong, a missing and a stale mapping", () => {
    // Without this, a comparison that found nothing to compare passes as well.
    const wrong = { ...navMap, "admin-groups-tab": "groups.manage" };
    expect(disagreements(wrong, NAV_FIRST_READ, routePerm).join("\n")).toContain("admin-groups-tab");
    const missing = { ...navMap }; delete missing["admin-groups-tab"];
    expect(disagreements(missing, NAV_FIRST_READ, routePerm).join("\n")).toContain("does not map");
    const stale = { ...sectionMap, "admin-gone-tab": "events.view" };
    expect(disagreements(stale, SECTION_FIRST_READ, routePerm).join("\n")).toContain("no FIRST_READ decision");
  });
});
