"use strict";

// v8.7.0 — THE EVENT-ADMIN TIER AND ITS DEFAULT-DENY ROUTE GATE.
//
// This file covers the two halves that make every other scope check safe:
//   1. the SCOPE PRIMITIVE (lib/event-admin.js) — and in particular the
//      empty-scope branch, which is the single most likely fail-open in the
//      feature: `IN ()` is a SQLite syntax error, so a naive
//      `ids.length ? clause : ""` produces an UNFILTERED query for exactly the
//      actor who must see nothing; and
//   2. the DEFAULT-DENY GUARD — an /api/admin route that nobody has classified
//      is REFUSED, including one that does not exist yet.
//
// Every "an event admin is refused" assertion carries a GLOBAL-ADMIN CONTROL,
// because a build that broke the route for everybody satisfies the refusal just
// as well as a build that scoped it correctly.

const { test, expect, request } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");

const H = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** A fresh participant, registered + verified + approved by the superadmin. */
async function makeParticipant(sa, saCsrf, label) {
  const email = `ea-${label}-${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}@acme.com`;
  const anon = await request.newContext({ baseURL: BASE });
  const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
  const reg = await registerPost(anon, "/api/register", {
    headers: H(csrf),
    data: {
      email, password: PARTICIPANT_PASS, nickname: `ea_${label}_${Date.now() % 1000000}`,
      firstName: "Event", lastName: label, company: "Acme", title: "Engineer",
      country: "GB", timezone: "Europe/London",
    },
  });
  expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  const list = await sa.get("/api/admin/participants?limit=5000");
  const row = (await list.json()).participants.find(p => p.email === email);
  expect(row, `registered ${label} must be findable`).toBeTruthy();
  await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: H(saCsrf) });
  await anon.dispose();
  return { id: row.id, email };
}

async function makeCompetition(sa, saCsrf, name) {
  const r = await sa.post("/api/admin/competitions", {
    headers: H(saCsrf),
    data: {
      name, start_time: new Date(Date.now() - 60_000).toISOString(),
      duration_minutes: 600, event_kind: "tournament",
    },
  });
  expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  const id = d.competition?.id || d.id;
  expect(id, "create must return an id").toBeTruthy();
  return { id, name };
}

test.describe("v8.7.0 — the event-admin tier and its default-deny route gate", () => {
  let sa, saCsrf;
  let mine, theirs;              // two competitions
  let ea, eaApi, eaCsrf;         // an event admin OF `mine`
  let zero, zeroApi, zeroCsrf;   // an event admin with NO grants — the fail-open catcher

  test.beforeAll(async () => {
    // NOTE: no seedTestData() here — tests/isolated-test.js re-seeds before every
    // spec FILE, and the seed is not idempotent (its fixed competition names 409).
    const s = await apiLogin("superadmin");
    sa = s.api; saCsrf = s.csrf;

    mine = await makeCompetition(sa, saCsrf, `EA Mine ${Date.now()}`);
    theirs = await makeCompetition(sa, saCsrf, `EA Theirs ${Date.now()}`);

    ea = await makeParticipant(sa, saCsrf, "scoped");
    zero = await makeParticipant(sa, saCsrf, "zero");

    const g = await sa.post(`/api/admin/competitions/${mine.id}/admins`, {
      headers: H(saCsrf), data: { userId: ea.id },
    });
    expect(g.ok(), `grant: ${g.status()} ${await g.text()}`).toBeTruthy();
    expect((await g.json()).role_changed).toBe(true);

    // The zero-grant actor gets the ROLE and no events, via the role route.
    const r = await sa.post(`/api/admin/participants/${zero.id}/role`, {
      headers: H(saCsrf), data: { role: "event_admin" },
    });
    expect(r.ok(), `role → event_admin: ${r.status()} ${await r.text()}`).toBeTruthy();

    const l1 = await apiLogin(ea.email, PARTICIPANT_PASS); eaApi = l1.api; eaCsrf = l1.csrf;
    const l2 = await apiLogin(zero.email, PARTICIPANT_PASS); zeroApi = l2.api; zeroCsrf = l2.csrf;
  });

  // ── the tier itself ────────────────────────────────────────────────────────

  test("the granted account IS an admin tier, is NOT a superadmin, and reports its real role", async () => {
    const me = await eaApi.get("/api/admin/me");
    expect(me.ok(), "an event admin reaches /api/admin/me").toBeTruthy();
    const d = await me.json();
    expect(d.role).toBe("event_admin");        // NOT the hard-coded "admin" this endpoint used to return
    expect(d.isAdmin).toBe(true);
    expect(d.isSuperAdmin).toBe(false);
    expect(d.isEventAdmin).toBe(true);
    expect(d.eventAdminCompetitionCount).toBe(1);

    // /api/me is the endpoint the SPA actually boots from.
    const mine2 = await eaApi.get("/api/me");
    expect((await mine2.json()).isEventAdmin).toBe(true);
  });

  test("a superadmin-only route is still refused, with the SUPERADMIN message", async () => {
    const r = await eaApi.get("/api/admin/unsubscribed");
    expect(r.status()).toBe(403);
    // Passed through to requireSuperAdmin deliberately, so the caller gets that
    // guard's accurate wording rather than a generic one from the gate.
    expect((await r.json()).error).toMatch(/superadmin/i);
  });

  // ── the default-deny gate ─────────────────────────────────────────────────

  test("every FORBIDDEN route is refused with a reason — and a global admin is not", async () => {
    const forbidden = [
      ["get", "/api/admin/logs"],
      ["get", "/api/admin/logs/files"],
      ["get", "/api/admin/settings"],
      ["get", "/api/admin/settings/events"],
      ["get", "/api/admin/alerts"],
      ["get", "/api/admin/retention"],
      ["get", "/api/admin/export/competitions"],
      ["get", "/metrics"],
    ];
    for (const [verb, path] of forbidden) {
      const r = await eaApi[verb](path);
      expect(r.status(), `${verb.toUpperCase()} ${path} must be 403 for an event admin`).toBe(403);
      const b = await r.json();
      expect(b.code, `${path} carries the machine code`).toBe("event_admin_forbidden");
      expect((b.error || "").length, `${path} states a reason`).toBeGreaterThan(40);
      // THE CONTROL: the same route must still work for a superadmin, or "the
      // event admin was refused" is equally satisfied by a broken route.
      const c = await sa[verb](path);
      expect(c.status(), `${verb.toUpperCase()} ${path} must still serve a superadmin`).toBeLessThan(400);
    }
  });

  // Operator ruling, 14 Nov 2026: the refusal is about a BLANK event and names
  // the two doors this tier has (a template, a clone of one of their events).
  test("creating a blank event is forbidden, and the refusal names the doors an event admin has instead", async () => {
    const r = await eaApi.post("/api/admin/competitions", {
      headers: H(eaCsrf),
      data: { name: `Nope ${Date.now()}`, start_time: new Date().toISOString(), duration_minutes: 60 },
    });
    expect(r.status()).toBe(403);
    const b = await r.json();
    expect(b.code).toBe("event_admin_forbidden");
    expect(b.error).toMatch(/blank event/i);
    expect(b.error).toMatch(/template/i);
    expect(b.error).toMatch(/clone/i);
  });

  test("an UNCLASSIFIED /api/admin route is refused — including one that does not exist", async () => {
    // The synthetic-future-route idiom (v8.3.11 F3): this proves the gate
    // protects routes nobody has written yet, which no per-route assertion can.
    const r = await eaApi.get("/api/admin/zzz-not-a-real-route");
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("event_admin_unclassified");
    // CONTROL: for a superadmin the same path falls through to the SPA/404
    // handling — it is emphatically not a 403 about roles.
    const c = await sa.get("/api/admin/zzz-not-a-real-route");
    const cb = await c.text();
    expect(cb.includes("event_admin_unclassified"), "a superadmin never meets the gate").toBeFalsy();
  });

  test("the gate resists path variants — case and a trailing slash", async () => {
    for (const p of ["/API/admin/logs", "/api/admin/logs/", "/api//admin/logs"]) {
      const r = await eaApi.get(p);
      expect(r.status(), `${p} must not slip past the gate`).toBe(403);
      expect((await r.json()).code).toBe("event_admin_forbidden");
    }
  });

  // ── the scope ─────────────────────────────────────────────────────────────

  test("the competitions list is narrowed to granted events", async () => {
    const r = await eaApi.get("/api/admin/competitions");
    expect(r.ok(), `list: ${r.status()} ${await r.text()}`).toBeTruthy();
    // The endpoint answers a bare array.
    const names = (await r.json()).map(c => c.name);
    expect(names).toContain(mine.name);
    expect(names).not.toContain(theirs.name);
    expect(names).not.toContain("Test Live");   // the seeded fixture is not theirs
  });

  test("an out-of-scope event is refused by id, and the in-scope one is served — the CONTROL pair", async () => {
    const bad = await eaApi.get(`/api/admin/competitions/${theirs.id}/delivery`);
    expect(bad.status()).toBe(403);
    expect((await bad.json()).code).toBe("event_admin_out_of_scope");

    const good = await eaApi.get(`/api/admin/competitions/${mine.id}/delivery`);
    expect(good.ok(), "the granted event IS reachable").toBeTruthy();
  });

  test("ZERO GRANTS SEES NOTHING — the empty-scope fail-open catcher", async () => {
    // If `scopeFilterSql` degraded its empty branch to "" the list below would
    // come back with every competition on the platform. This is the assertion
    // that catches it.
    const me = await zeroApi.get("/api/admin/me");
    expect((await me.json()).isEventAdmin, "precondition: the actor really is an event admin").toBe(true);

    const r = await zeroApi.get("/api/admin/competitions");
    expect(r.ok(), `zero-grant list: ${r.status()}`).toBeTruthy();
    const comps = await r.json();
    expect(comps.length, `an event admin with no grants must see NO events, saw ${comps.length}`).toBe(0);

    // …and cannot reach a specific one either.
    const one = await zeroApi.get(`/api/admin/competitions/${mine.id}/delivery`);
    expect(one.status()).toBe(403);
  });

  // ── grant / revoke lifecycle ──────────────────────────────────────────────

  test("an event admin may NOT grant the role — that is what stops it self-propagating", async () => {
    const target = await makeParticipant(sa, saCsrf, "victim");
    const r = await eaApi.post(`/api/admin/competitions/${mine.id}/admins`, {
      headers: H(eaCsrf), data: { userId: target.id },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("event_admin_forbidden");
    // CONTROL: the superadmin can, on the same event and the same target.
    const c = await sa.post(`/api/admin/competitions/${mine.id}/admins`, {
      headers: H(saCsrf), data: { userId: target.id },
    });
    expect(c.ok(), `superadmin grant: ${c.status()} ${await c.text()}`).toBeTruthy();
  });

  test("granting refuses an existing ADMIN target — that is a demotion, and belongs on the role route", async () => {
    const target = await makeParticipant(sa, saCsrf, "peer");
    await sa.post(`/api/admin/participants/${target.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    const r = await sa.post(`/api/admin/competitions/${mine.id}/admins`, {
      headers: H(saCsrf), data: { userId: target.id },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("event_admin_target_privileged");
  });

  test("removing the LAST grant does NOT demote — zero-grant event_admin is the resting state", async () => {
    const solo = await makeParticipant(sa, saCsrf, "solo");
    await sa.post(`/api/admin/competitions/${mine.id}/admins`, { headers: H(saCsrf), data: { userId: solo.id } });

    const del = await sa.delete(`/api/admin/competitions/${mine.id}/admins/${solo.id}`, { headers: H(saCsrf) });
    expect(del.ok(), `revoke: ${del.status()} ${await del.text()}`).toBeTruthy();
    const d = await del.json();
    expect(d.removed).toBe(true);
    expect(d.remaining_events).toBe(0);

    const row = await sa.get("/api/admin/participants?limit=5000");
    const me = (await row.json()).participants.find(p => p.id === solo.id);
    expect(me.role, "the ROLE survives the last revoke — demoting is a superadmin action").toBe("event_admin");
  });

  test('"demote altogether" is the role route, and it CASCADES every grant', async () => {
    const both = await makeParticipant(sa, saCsrf, "cascade");
    await sa.post(`/api/admin/competitions/${mine.id}/admins`, { headers: H(saCsrf), data: { userId: both.id } });
    await sa.post(`/api/admin/competitions/${theirs.id}/admins`, { headers: H(saCsrf), data: { userId: both.id } });

    const r = await sa.post(`/api/admin/participants/${both.id}/role`, {
      headers: H(saCsrf), data: { role: "participant" },
    });
    expect(r.ok(), `demote: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).event_admin_grants_cleared, "both grants are cleared in the same transaction").toBe(2);

    // And the grant list on the event no longer names them.
    const list = await sa.get(`/api/admin/competitions/${mine.id}/admins`);
    expect((await list.json()).admins.map(a => a.id)).not.toContain(both.id);
  });

  test("the grant is recorded on BOTH histories — the event's and the participant's", async () => {
    const who = await makeParticipant(sa, saCsrf, "audit");
    await sa.post(`/api/admin/competitions/${mine.id}/admins`, { headers: H(saCsrf), data: { userId: who.id } });

    // _eventListResponse answers `{events,…}` when paginated and a bare array
    // otherwise, so both shapes are accepted rather than assumed.
    const rows = async res => { const b = await res.json(); return Array.isArray(b) ? b : b.events; };

    const ue = await rows(await sa.get(`/api/admin/participants/${who.id}/events`));
    expect(ue.some(e => e.event_type === "event_admin_granted"),
      "the participant's own History shows it").toBeTruthy();

    const ce = await rows(await sa.get(`/api/admin/competitions/${mine.id}/events`));
    expect(ce.some(e => e.event_type === "event_admin_granted"),
      "the event's History shows it").toBeTruthy();
  });

  test("an event admin is EXCLUDED from leaderboards — and does NOT get the staff tag", async () => {
    // The operator's decision was "excluded, like a normal admin". It is done by
    // ROLE, not by granting `staff`: that tag additionally short-circuits
    // membership (`requireParticipantInCompetition` returns next()) and makes
    // `listParticipantCompetitions` unfiltered, either of which would break
    // "an event admin's participant view is restricted to their own events".
    const row = await sa.get("/api/admin/participants?limit=5000");
    const me = (await row.json()).participants.find(p => p.id === ea.id);
    expect(me.tags || [], "no staff tag is granted").not.toContain("staff");

    // Their participant view lists only events they are ENROLLED in — which is
    // none, so certainly not the whole platform (which `staff` would have given).
    // v8.12.0 — RE-POINTED. This read `(await view.json()).competitions || []`,
    // and `/api/my-competitions` answers a BARE ARRAY, so `.competitions` was
    // always undefined, the list always `[]`, and the assertion could never
    // fail — a lock that read as coverage and was not. It asserts the array
    // shape now, and carries the CONTROL the sentence below claims: a
    // staff-TAGGED actor really does see the whole platform from this endpoint.
    const view = await eaApi.get("/api/my-competitions");
    const seen = await view.json();
    expect(Array.isArray(seen), "the participant list is a bare array").toBe(true);
    expect(seen.some(c => c.name === "Test Live"),
      "a staff-tagged actor would see every event; an event admin must not").toBeFalsy();
    const staffProbe = await makeParticipant(sa, saCsrf, "stafftag");
    await sa.post(`/api/admin/participants/${staffProbe.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
    const staffApi = (await apiLogin(staffProbe.email, PARTICIPANT_PASS)).api;
    const staffView = await (await staffApi.get("/api/my-competitions")).json();
    expect(staffView.some(c => c.name === "Test Live"),
      "CONTROL — the staff tag DOES list every event, so the absence above is the role's doing").toBeTruthy();
  });
});
