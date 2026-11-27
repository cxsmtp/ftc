// THE BUILT-IN ROLES ANSWER EVERY ADMIN ROUTE EXACTLY AS THEY DID BEFORE RBAC.
//
// tests/fixtures/rbac-legacy-routes.json is a FROZEN copy of the pre-RBAC
// event-admin route maps (EVENT_ADMIN_ROUTES / EVENT_ADMIN_FORBIDDEN, with their
// refusal sentences) and of each admin route's own guard tier (requireAdmin,
// requireGlobalAdmin, requireSuperAdmin), taken at 6d8ee76. Never regenerate it:
// it is the "today" this lock compares against. One entry is hand-amended by
// operator ruling, 14 Nov 2026 (the create refusal's sentence,
// `POST /api/admin/competitions`, which wrongly said event admins cannot create
// events at all); every other entry is the frozen copy, byte for byte.
//
// For every live admin route × every built-in role this asserts that
//   1. the global gate (lib/rbac.js guardDecision) gives the same answer the old
//      eventAdminGuard gave — pass, or the same status, code AND sentence;
//   2. the route's own guard tier is unchanged (so "gate, then route guard" —
//      what the role may actually reach — is the same);
//   3. the frozen permission sets agree with the route guards: the built-in
//      admin holds a route's permission exactly when the route is not
//      superadmin-only, and the superadmin holds every route's permission. A
//      route added after the freeze has no frozen tier, so rule 3 judges it
//      against the guard it is registered with today; one guarded by
//      requirePermission("…") must name the permission its gate asks.
// Anti-vacuity: the fixture and the live route list are each large, and every
// route of the fixture is still live (or the lock names it).
const { test, expect } = require("./isolated-test");

const DR = require("./doc-registry");
// lib/rbac.js reaches db.js (lazily, but the module-scope scanner counts the
// require), so it is required inside each test.
let RB = null;
const _rb = () => (RB = require("../lib/rbac"));
const LEGACY = require("./fixtures/rbac-legacy-routes.json");

const norm = k => { const sp = k.indexOf(" "); return DR.routeKey(k.slice(0, sp), k.slice(sp + 1)); };
const ROLES = ["event_admin", "admin", "superadmin"];

function liveAdminRoutes() {
  const regions = DR.routeRegions();
  const out = new Map();
  for (const [key, sites] of regions) {
    const path = key.slice(key.indexOf(" ") + 1);
    if (path.startsWith("/api/admin/") || path === "/metrics") out.set(key, sites);
  }
  return out;
}

function liveGuardTier(sites) {
  const head = (sites[0] && sites[0].body || "").slice(0, 600);
  return /requireSuperAdmin/.test(head) ? "superadmin" : /requireGlobalAdmin/.test(head) ? "global" : "admin";
}
/** The permission a route's own `requirePermission("…")` guard asks, or null. */
function liveGuardPermission(sites) {
  const m = (sites[0] && sites[0].body || "").slice(0, 600).match(/requirePermission\(\s*["']([^"']+)["']\s*\)/);
  return m ? m[1] : null;
}

const tierAdmits = (tier, role) =>
  tier === "superadmin" ? role === "superadmin" : tier === "global" ? (role === "admin" || role === "superadmin") : true;

// The old gate, reconstructed from the frozen maps — only an event admin was ever gated.
const legacyForbidden = new Map(Object.entries(LEGACY.eventAdminForbidden).map(([k, v]) => [norm(k), v]));
const legacyRoutes = new Map(Object.entries(LEGACY.eventAdminRoutes).map(([k, v]) => [norm(k), v]));
function legacyGate(role, nkey) {
  if (role !== "event_admin") return { next: true };
  if (legacyForbidden.has(nkey)) return { status: 403, code: "event_admin_forbidden", error: legacyForbidden.get(nkey) };
  if (legacyRoutes.has(nkey)) return { next: true };
  return { status: 403, code: "event_admin_unclassified", error: "That part of the admin panel is not available for your role." };
}

test.describe("RBAC — built-in role equivalence", () => {
  test.beforeEach(() => { _rb(); });

  test("every admin route answers each built-in role exactly as before", () => {
    const rbacKeyByNorm = new Map([...RB.ADMIN_ROUTE_PERMISSIONS.keys()].map(k => [norm(k), k]));
    const live = liveAdminRoutes();
    expect(live.size, "the admin-route extraction found almost nothing").toBeGreaterThanOrEqual(140);
    expect(Object.keys(LEGACY.routeGuardTier).length, "the frozen fixture is nearly empty").toBeGreaterThanOrEqual(140);

    const gone = Object.keys(LEGACY.routeGuardTier).filter(k => !live.has(k));
    expect(gone, "a route in the frozen fixture is no longer registered — decide its successor before deleting it").toEqual([]);

    const bad = [];
    let compared = 0;
    for (const [nkey, sites] of live) {
      const rkey = rbacKeyByNorm.get(nkey) || null;
      const tierNow = liveGuardTier(sites);
      const tierThen = LEGACY.routeGuardTier[nkey];
      for (const role of ROLES) {
        const now = RB.guardDecision(role, rkey);
        if (tierThen === undefined) {
          // A route added after the freeze: it must be decided, and a built-in
          // global role must never be refused at the gate.
          if (!rkey) bad.push(`${nkey}: not in ADMIN_ROUTE_PERMISSIONS`);
          if ((role === "admin" || role === "superadmin") && !now.next) bad.push(`${nkey} ${role}: refused at the gate`);
          continue;
        }
        const then = legacyGate(role, nkey);
        compared++;
        const same = (then.next && now.next) || (!then.next && !now.next
          && then.status === now.status && then.code === now.code && then.error === now.error);
        if (!same) bad.push(`${nkey} ${role}: gate was ${JSON.stringify(then)} now ${JSON.stringify(now)}`);
        const allowedThen = !!then.next && tierAdmits(tierThen, role);
        const allowedNow = !!now.next && tierAdmits(tierNow, role);
        if (allowedThen !== allowedNow) bad.push(`${nkey} ${role}: allowed was ${allowedThen} now ${allowedNow}`);
      }
    }
    expect(compared, "nothing was compared").toBeGreaterThanOrEqual(400);
    expect(bad, "a built-in role's answer changed:\n  " + bad.join("\n  ")).toEqual([]);
  });

  // Rule 3 for one route: what the built-in sets hold for `perm` must agree
  // with the route's guard `tier`. `sets` is injectable for the planted control.
  function permTierDisagreements(k, perm, tier, sets = RB.BUILTIN_ROLE_PERMISSIONS) {
    const bad = [];
    const inline = RB.INLINE_REFUSAL_ROUTES.has(k) || perm === "breakglass.self";
    if (!inline && sets.admin.has(perm) !== (tier !== "superadmin")) {
      bad.push(`${k}: admin ${sets.admin.has(perm) ? "holds" : "lacks"} ${perm} but the route tier is ${tier}`);
    }
    if (!inline && sets.event_admin.has(perm) && tier !== "admin") {
      bad.push(`${k}: event_admin holds ${perm} but the route tier is ${tier}`);
    }
    // The gate passes an event admin through on a permission it lacks only
    // when the route's own guard refuses it — so that route must be
    // superadmin-only, or the role reaches a route it holds no permission for.
    if (!inline && !sets.event_admin.has(perm) && !RB.EVENT_ADMIN_DENY_COPY.has(k) && tier !== "superadmin") {
      bad.push(`${k}: event_admin lacks ${perm}, has no refusal copy, and the route tier is ${tier} — it would reach the route`);
    }
    if (perm !== "breakglass.self" && !sets.superadmin.has(perm)) bad.push(`${k}: superadmin lacks ${perm}`);
    return bad;
  }

  test("the frozen permission sets agree with every route's own guard", () => {
    // A frozen route is judged against its frozen tier; a route added after the
    // freeze against the guard it is registered with today, so a later route
    // whose permission a built-in admin holds cannot be superadmin-only (or the
    // reverse) without this failing.
    const live = liveAdminRoutes();
    const bad = [];
    let postFreeze = 0;
    let byPermission = 0;
    for (const [k, { perm }] of RB.ADMIN_ROUTE_PERMISSIONS) {
      const nk = norm(k);
      let tier = LEGACY.routeGuardTier[nk];
      if (tier === undefined && live.has(nk)) {
        // A route guarded by requirePermission admits exactly the roles holding
        // that permission, built-in ones included: its gate and its guard must
        // then name the same one.
        const guardPerm = liveGuardPermission(live.get(nk));
        if (guardPerm !== null) {
          byPermission++;
          if (guardPerm !== perm) bad.push(`${k}: the gate asks ${perm} but the route's requirePermission asks ${guardPerm}`);
          continue;
        }
        tier = liveGuardTier(live.get(nk)); postFreeze++;
      }
      if (tier === undefined) continue; // pending: no registration yet
      bad.push(...permTierDisagreements(k, perm, tier));
    }
    expect(postFreeze, "anti-vacuity: routes added after the freeze are judged on their live guard tier").toBeGreaterThanOrEqual(10);
    expect(byPermission, "anti-vacuity: the requirePermission routes are compared with their gate").toBeGreaterThanOrEqual(5);
    // Planted control: a permission the built-in admin holds on a superadmin-only route.
    const heldPerm = [...RB.BUILTIN_ROLE_PERMISSIONS.admin].find(p => !RB.BUILTIN_ROLE_PERMISSIONS.event_admin.has(p));
    expect(heldPerm, "a permission the admin holds and the event admin lacks").toBeTruthy();
    expect(permTierDisagreements("GET /api/admin/zz-planted", heldPerm, "superadmin"),
      "the rule flags an admin-held permission on a superadmin-only route")
      .toEqual([`GET /api/admin/zz-planted: admin holds ${heldPerm} but the route tier is superadmin`]);
    expect(permTierDisagreements("GET /api/admin/zz-planted", heldPerm, "admin"),
      "CONTROL: the same permission on an admin-tier route with no refusal copy is flagged only for the event admin reaching it")
      .toHaveLength(1);
    expect(bad, bad.join("\n")).toEqual([]);
    expect(RB.BUILTIN_ROLE_PERMISSIONS.participant.size, "a participant holds no admin permission").toBe(0);
    expect(RB.roleClass("participant")).toBe("none");
    expect(RB.roleClass("event_admin")).toBe("granted");
    expect(RB.roleClass("admin")).toBe("all");
    expect(RB.roleClass("superadmin")).toBe("all");
    // An unknown role key fails closed.
    expect(RB.roleClass("no-such-role-" + Date.now())).toBe("none");
    expect(RB.rolePermissions("no-such-role-" + Date.now()).size).toBe(0);
  });

  test("the built-in sets are frozen in code", () => {
    for (const r of ["participant", "event_admin", "admin", "superadmin"]) {
      expect(Object.isFrozen(RB.BUILTIN_ROLE_PERMISSIONS[r]), r).toBeTruthy();
      expect(() => RB.BUILTIN_ROLE_PERMISSIONS[r].add("settings.edit"), `${r} accepted a new permission`).toThrow();
      expect(() => RB.BUILTIN_ROLE_PERMISSIONS[r].delete("panel.access"), `${r} lost a permission`).toThrow();
    }
    expect(Object.isFrozen(RB.BUILTIN_ROLE_PERMISSIONS)).toBeTruthy();
  });
});
