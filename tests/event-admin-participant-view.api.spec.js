"use strict";

// v8.7.3 — THE SERVER HALF OF "AN EVENT ADMIN SWITCHES TO PARTICIPANT VIEW".
//
// Reported: an event admin pressing **Participant View** met "Could not load
// your competitions. The server did not respond correctly.", and had no way
// back to the admin panel. Two independent defects, both reproduced before
// anything was changed; this file pins the SERVER contracts the client fix
// reads. `event-admin-participant-view.spec.js` locks what the browser does.
//
// WHAT IS PINNED HERE, and why each is the assertion that can fail:
//
//   1. `POST /api/toggle-admin-view` carries `isEventAdmin`. The client does
//      `S.isEventAdmin=!!d.isEventAdmin`, so an omitted key was `!!undefined` —
//      FALSE — and one round trip through participant view silently demoted the
//      event admin's PANEL to a global admin's for the life of the tab. The
//      REGULAR-ADMIN row is the control: it must read false, or "the key is
//      present" would be satisfied by a build that hard-codes true.
//
//   2. The 400 the client now branches on really is a 400 with `missing`. The
//      whole client fix is dead code if this contract moves, and nothing else in
//      the suite asserts this endpoint's refusal shape.
//
//   3. The server does NOT block the toggle for an incomplete profile. The fix
//      is deliberately client-side (an explanatory modal that leaves the admin
//      where they are); if the server ever started refusing `mode:"participant"`
//      the modal would be unreachable and an admin could be stranded in a view
//      they cannot leave. This test states that division of labour.
//
//   4. An event admin's participant list is their OWN ENROLMENTS, never the
//      platform. v8.7.0 excludes the tier from `staff` BY ROLE precisely because
//      `listParticipantCompetitions(..., {staff:true})` is an unfiltered
//      `SELECT … FROM competitions`; a future regression that re-tagged them
//      would leak every event on the platform into their picker. The DECOY —
//      an event they administer but are not enrolled in — is what makes the
//      assertion mean something, and the REGULAR ADMIN beside them (who IS
//      staff-tagged, and therefore does see everything) is the control proving
//      the two paths are genuinely different rather than both empty.
//
// Fixtures are minted here, never the seeded alice/bob/carol —
// tests/isolated-test.js asserts in an afterAll that those three still hold
// `role: 'participant'`, so a promotion left behind fails the whole FILE.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const {
  H, makeParticipant, makeCompetition, enrol, grantEventAdmin, makeInvitedFreeEmailUser,
} = require("./event-admin-helpers");

test.use({ baseURL: BASE });

// Module scope: the scanner describe at the foot of this file needs the same
// accounts, and a second fixture builder would be a second thing to keep true.
let sa, saCsrf;
let mine, theirs, alsoMine;
let ea, plainAdmin, incompleteEa, plainParticipant;

test.beforeAll(async () => {
  {
    const s = await apiLogin("superadmin");
    sa = s.api; saCsrf = s.csrf;

    mine     = await makeCompetition(sa, saCsrf, "pv-mine");
    alsoMine = await makeCompetition(sa, saCsrf, "pv-alsomine");
    theirs   = await makeCompetition(sa, saCsrf, "pv-theirs");

    ea = await makeParticipant(sa, saCsrf, "pv-ea");
    await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
    await grantEventAdmin(sa, saCsrf, alsoMine.id, ea.id);
    // Enrolled in ONE of the two events they administer. `alsoMine` is the
    // DECOY: administering an event must not put it in their participant list.
    await enrol(sa, saCsrf, mine.id, [ea.id]);

    plainAdmin = await makeParticipant(sa, saCsrf, "pv-admin");
    const rr = await sa.post(`/api/admin/participants/${plainAdmin.id}/role`, {
      headers: H(saCsrf), data: { role: "admin" },
    });
    expect(rr.ok(), `promote to admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();

    incompleteEa = await makeInvitedFreeEmailUser(sa, saCsrf, "pv-inc");
    await grantEventAdmin(sa, saCsrf, mine.id, incompleteEa.id);

    // The scanner control: an ordinary participant on the same address, who
    // must NOT be exempt.
    plainParticipant = await makeParticipant(sa, saCsrf, "pv-plain");
  }
});

test.describe("v8.7.3 — an event admin in participant view (server contracts)", () => {

  test("the view toggle tells the client the account's TIER, in both directions", async () => {
    const { api, csrf } = await apiLogin(ea.email, PARTICIPANT_PASS);

    const down = await api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "participant" } });
    expect(down.ok(), `toggle down: ${down.status()} ${await down.text()}`).toBeTruthy();
    const dBody = await down.json();
    expect(dBody.isAdmin, "the VIEW is participant").toBe(false);
    expect(dBody.isEventAdmin, "…but the TIER is still event admin").toBe(true);

    // The session regenerates on toggle, so re-fetch CSRF exactly as the SPA does.
    const csrf2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const up = await api.post("/api/toggle-admin-view", { headers: H(csrf2), data: { mode: "admin" } });
    expect(up.ok(), `toggle up: ${up.status()}`).toBeTruthy();
    const uBody = await up.json();
    expect(uBody.isAdmin, "back in the admin view").toBe(true);
    expect(uBody.isEventAdmin, "and still reported as the event-admin tier").toBe(true);
    expect(uBody.isSuperAdmin, "never a superadmin").toBe(false);
    await api.dispose();
  });

  test("CONTROL: a regular admin is reported as NOT an event admin", async () => {
    // Without this, "isEventAdmin is present and true" is satisfied by a build
    // that hard-codes it — which would hand every global admin the event-admin
    // chrome (Logs and + New Event hidden) on their next toggle.
    const { api, csrf } = await apiLogin(plainAdmin.email, PARTICIPANT_PASS);
    const down = await api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "participant" } });
    expect(down.ok()).toBeTruthy();
    const b = await down.json();
    expect(b).toHaveProperty("isEventAdmin");
    expect(b.isEventAdmin, "a global admin is not an event admin").toBe(false);
    await api.dispose();
  });

  test("an event admin's participant list is their OWN enrolments, not the platform", async () => {
    const { api } = await apiLogin(ea.email, PARTICIPANT_PASS);
    const r = await api.get("/api/my-competitions");
    expect(r.status(), `my-competitions: ${await r.text()}`).toBe(200);
    const ids = (await r.json()).map(c => c.id);

    expect(ids, "the event they are enrolled in").toContain(mine.id);
    expect(ids, "an event they ADMINISTER but are not enrolled in must not appear")
      .not.toContain(alsoMine.id);
    expect(ids, "and certainly not somebody else's event").not.toContain(theirs.id);
    await api.dispose();
  });

  test("CONTROL: a regular admin, who IS staff-tagged, still sees every event", async () => {
    // The contrast that proves the assertion above measures scoping rather than
    // an empty database: the same three events, the same request, a different
    // tier. If this ever goes red, `event_admin` has been re-tagged `staff` and
    // the picker leaks the whole platform.
    const { api } = await apiLogin(plainAdmin.email, PARTICIPANT_PASS);
    const r = await api.get("/api/my-competitions");
    expect(r.status()).toBe(200);
    const ids = (await r.json()).map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, alsoMine.id, theirs.id]));
    await api.dispose();
  });

  test("an INCOMPLETE profile is refused with a named reason, not a server error", async () => {
    // The contract the client's new branch reads. If this shape moves, the
    // honest message and the pre-toggle explanation both become dead code.
    const { api } = await apiLogin(incompleteEa.email, PARTICIPANT_PASS);

    const me = await api.get("/api/me");
    expect(me.ok()).toBeTruthy();
    const meBody = await me.json();
    expect(meBody.missing_fields, "the invited free-email account is genuinely incomplete")
      .toContain("corporate_email");
    expect(meBody.userRole, "…and is genuinely an event admin").toBe("event_admin");

    const r = await api.get("/api/my-competitions");
    expect(r.status(), "a 400, not a 5xx — the server explained itself").toBe(400);
    const body = await r.json();
    expect(body.error).toBe("profile_incomplete");
    expect(Array.isArray(body.missing) && body.missing.length,
      "…and it NAMES the fields, which is what the client renders").toBeTruthy();
    expect(body.missing).toContain("corporate_email");
    await api.dispose();
  });

  test("the SERVER still permits the toggle — the explanation is the client's job", async () => {
    // Deliberate division of labour, stated so nobody "hardens" it by refusing
    // the toggle server-side. `mode:"participant"` has no lifecycle or profile
    // gate; the client explains and stays put. Were the server to refuse here,
    // an admin already IN participant view would have no way back at all.
    const { api, csrf } = await apiLogin(incompleteEa.email, PARTICIPANT_PASS);
    const down = await api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "participant" } });
    expect(down.status(), "the toggle itself is not the enforcement point").toBe(200);
    expect((await down.json()).isEventAdmin).toBe(true);
    await api.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The scanner-block exemption. Kept in its own describe because arming the
// tracker is PROCESS-GLOBAL and blocks the whole address (127.0.0.1) that every
// other test in this worker shares — hence the disarm+reset in BOTH hooks, the
// shape `scanner-silent.api.spec.js` established.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.7.3 — a scanner-blocked venue does not lock out its organiser", () => {
  const PROBE_PATHS = [
    "/.env", "/wp-admin/setup-config.php", "/phpmyadmin/index.php", "/.git/config",
    "/config.json", "/administrator/index.php", "/.aws/credentials", "/backup.sql",
    "/adminer.php", "/owa/auth/logon.aspx", "/actuator/env", "/cgi-bin/test.cgi",
  ];
  const { freshCtx } = require("./helpers");

  async function disarm() {
    const { api } = await freshCtx();
    try {
      await api.post("/api/test/scanner-toggle", { data: { enable: false } }).catch(() => {});
      await api.post("/api/test/scanner-reset", {}).catch(() => {});
      await api.post("/api/test/clear-ip-ban-alerts", {}).catch(() => {});
    } finally { await api.dispose(); }
  }
  test.beforeEach(async () => { await disarm(); });
  test.afterEach(async () => { await disarm(); });

  test("an event admin in PARTICIPANT view is exempt; a participant on the same address is not", async () => {
    // `_scannerBlockExempt` short-circuits on the session flags first, and
    // `mode:"participant"` clears them — so this tier reaches the ROLE read,
    // which enumerated `admin` and `superadmin` only. The block is GLOBAL (it
    // precedes every route, the SPA shell included), so the organiser standing
    // in a scanner-blocked venue lost the API, the page and the reload alike
    // for fifteen minutes, while a regular admin beside them was exempt. That
    // is the state this function's own header calls "no way out at all".
    let eaApi, partApi;
    const sessions = [];
    try {
      // Establish both sessions and drop to participant view BEFORE arming the
      // tracker — logging in afterwards would itself be blocked.
      const eaLogin = await apiLogin(ea.email, PARTICIPANT_PASS);
      eaApi = eaLogin.api; sessions.push(eaApi);
      const d1 = await eaApi.post("/api/toggle-admin-view", { headers: H(eaLogin.csrf), data: { mode: "participant" } });
      expect(d1.ok(), "the event admin is in participant view").toBeTruthy();

      const pp = await apiLogin(plainParticipant.email, PARTICIPANT_PASS);
      partApi = pp.api; sessions.push(partApi);

      const { api: anon } = await freshCtx();
      sessions.push(anon);
      expect((await anon.post("/api/test/scanner-toggle", { data: { enable: true } })).ok()).toBe(true);

      let blocked = false;
      for (let i = 1; i <= 60 && !blocked; i++) {
        const r = await anon.get(PROBE_PATHS[i % PROBE_PATHS.length] + "?i=" + i);
        if (r.status() === 429) blocked = true;
      }
      expect(blocked, "precondition: the shared address really is scanner-blocked").toBe(true);

      // THE CONTROL FIRST, so "the event admin was served" cannot be satisfied
      // by a build in which the block never applied to anybody.
      expect((await partApi.get("/api/me")).status(),
        "an ordinary participant on the blocked address is refused").toBe(429);

      expect((await eaApi.get("/api/me")).status(),
        "the event admin, in participant view, is still served").toBe(200);
    } finally {
      for (const s of sessions) { try { await s.dispose(); } catch (_) {} }
    }
  });
});
