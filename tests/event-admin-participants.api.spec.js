"use strict";

// v8.7.0 — THE EVENT-ADMIN PARTICIPANTS SURFACE.
//
// "Sees only people enrolled in one of their events" is FOUR separate narrowings
// on ONE endpoint, and each is a separate leak:
//
//   1. the ROW SET             — who appears at all
//   2. the per-row COMPETITIONS array — which of their events is named beside a
//                                person the actor may legitimately see
//   3. pendingApproval         — the sidebar badge, which drives a control that
//                                exists to say "act now"
//   4. event_admin_for         — which events a person ORGANISES
//
// Jobs 2-4 are invisible to job 1: a build that filters the row set perfectly can
// still render, on a row the actor is entitled to, a directory of every event on
// the platform.
//
// EVERY negative here carries a CONTROL — the superadmin (or, where the
// superadmin's own session must not be disturbed, a purpose-built global admin)
// doing the identical thing — because "the event admin was refused" is equally
// satisfied by a build that broke the route for everybody. Every positive carries
// a DECOY (`world.theirs` and the people in it), because "the list contains my
// participant" is equally satisfied by an unfiltered list.
//
// And the ZERO-GRANT actor is tested wherever a list is narrowed: `IN ()` is a
// SQLite syntax error, so the naive `ids.length ? clause : ""` leaves the query
// UNFILTERED for exactly the actor who must see nothing.
//
// NOTE: no seedTestData() — tests/isolated-test.js re-seeds before every spec
// FILE and the seed is not idempotent (its fixed competition names 409).

const { test, expect, request } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const {
  H, uniq, makeParticipant, makeCompetition, enrol, grantEventAdmin,
  buildWorld, expectRefused,
} = require("./event-admin-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Local fixtures — the two shapes `event-admin-helpers.js` deliberately does not
// build, because only this file needs them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verified but NOT approved — the only state `pendingApproval` counts.
 *
 * The shared `makeParticipant` verifies AND approves, so this is a local variant
 * rather than a helper change (other agents own that file).
 */
async function makeUnapprovedParticipant(sa, saCsrf, label) {
  const tag = uniq(label);
  const email = `ea-${tag}@acme.com`;
  const anon = await request.newContext({ baseURL: BASE });
  try {
    const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", {
      headers: H(csrf),
      data: {
        email, password: PARTICIPANT_PASS,
        nickname: `ea_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
        firstName: "Pending", lastName: String(label), company: "Acme", title: "Engineer",
        country: "GB", timezone: "Europe/London",
      },
    });
    expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  } finally { await anon.dispose(); }
  const list = await sa.get("/api/admin/participants?limit=5000");
  const row = (await list.json()).participants.find(p => p.email === email);
  expect(row, `unapproved ${label} must be findable`).toBeTruthy();
  const v = await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(saCsrf) });
  expect(v.ok(), `verify ${label}: ${v.status()} ${await v.text()}`).toBeTruthy();
  return { id: row.id, email };
}

/**
 * A desk-invited account: verified, approved, enrolled — and PASSWORDLESS, which
 * is the only thing that makes it eligible for `login-code/reveal`
 * (`password_set_at IS NULL` is the discriminator, v7.29.0). A `makeParticipant`
 * account registered with a password is permanently code-INELIGIBLE, so the
 * reveal's "permitted" arm would answer 409 for a reason unrelated to scope.
 */
async function deskInvite(api, csrf, competitionId, label) {
  const email = `ea-desk-${uniq(label)}@acme.com`;
  const r = await api.post("/api/admin/participants/desk-invite", {
    headers: H(csrf),
    data: { email, firstName: "Desk", lastName: String(label), competitionId },
  });
  expect(r.ok(), `desk-invite ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.id, "desk-invite returns the new account's id").toBeTruthy();
  return { id: d.id, email };
}

const ids = list => (list || []).map(x => x.id);

// ─────────────────────────────────────────────────────────────────────────────
// The event admin's invitation rule (routes/invitations.js POST
// /api/admin/invitations) — fixtures for the two tests that pin it arm by arm.
// ─────────────────────────────────────────────────────────────────────────────

// TWO refusals share ONE code (`event_admin_competition_required`): the "name an
// event" arm and the "nothing you named can still admit anybody" arm. A build that
// drops the first arm still answers `[]` with that code, through the SECOND arm,
// so every refusal asserts WHICH sentence answered, not only the code.
const NAME_AN_EVENT = /Choose at least one of your events/;
const NOTHING_ADMITTABLE = /None of the selected events can still take new participants/;

/**
 * A FRESH event admin organising three events: L (live), U (upcoming, +2 h) and
 * E (a plain tournament that ended an hour ago, so no late-entry window). Fresh
 * because `world.ea` must keep `event_admin_for === [mine]` for another test.
 * Every precondition is read back through the ACTOR's own competitions list.
 */
async function makeInviteOrganiser(sa, saCsrf, label) {
  const HOUR = 3600_000;
  const L = await makeCompetition(sa, saCsrf, `${label}-live`);
  const U = await makeCompetition(sa, saCsrf, `${label}-upcoming`, {
    start_time: new Date(Date.now() + 2 * HOUR).toISOString(), duration_minutes: 60,
  });
  const E = await makeCompetition(sa, saCsrf, `${label}-ended`, {
    start_time: new Date(Date.now() - 2 * HOUR).toISOString(), duration_minutes: 60,
  });
  const ea = await makeParticipant(sa, saCsrf, `${label}-ea`);
  for (const c of [L, U, E]) await grantEventAdmin(sa, saCsrf, c.id, ea.id);
  const { api, csrf } = await apiLogin(ea.email, PARTICIPANT_PASS);

  const me = await (await api.get("/api/admin/me")).json();
  expect(me.isEventAdmin, `${label}: the actor really holds the event-admin tier`).toBe(true);
  expect(me.eventAdminCompetitionCount, `${label}: …organising exactly three events`).toBe(3);
  const lr = await api.get("/api/admin/competitions");
  expect(lr.ok(), `${label}: own competitions list: ${lr.status()}`).toBeTruthy();
  const rows = await lr.json();
  expect(Array.isArray(rows), "GET /api/admin/competitions answers a bare array").toBe(true);
  const byId = Object.fromEntries(rows.map(c => [c.id, c]));
  expect(Object.keys(byId).sort(), `${label}: the actor's scope is exactly L, U, E`)
    .toEqual([L.id, U.id, E.id].sort());
  expect(byId[L.id].status, "L is live").toBe("live");
  expect(byId[U.id].status, "U is upcoming").toBe("upcoming");
  expect(byId[E.id].status, "E has ended").toBe("ended");
  expect(byId[E.id].late_entry_window_open, "…and E takes no late entries").toBeFalsy();
  for (const c of [L, U, E]) {
    // A competing actor is refused 403 competitor_cannot_edit — a different rule.
    expect(byId[c.id].competing, `${label}: the actor competes in none of them`).toBeFalsy();
  }
  return { L, U, E, api, csrf };
}

/** Every stored invitation row for `email`, read-only from THIS worker's DB. */
function invitationRows(email) {
  const Database = require("better-sqlite3");
  const db = new Database(require("./helpers").TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT competition_ids, group_ids FROM invitations WHERE email=?").all(email)
      .map(r => ({ competitionIds: JSON.parse(r.competition_ids), groupIds: JSON.parse(r.group_ids) }));
  } finally { db.close(); }
}

/** How many groups carry exactly this name. */
function groupsNamed(name) {
  const Database = require("better-sqlite3");
  const db = new Database(require("./helpers").TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT COUNT(*) AS n FROM groups WHERE name=?").get(name).n; }
  finally { db.close(); }
}

/** The shared-code refusal, plus the arm that answered it. */
async function expectCompetitionRequired(res, what, sentence) {
  const body = await res.text();
  expect(res.status(), `${what} must be refused 400: ${body}`).toBe(400);
  const d = JSON.parse(body);
  expect(d.code, `${what}: refusal code`).toBe("event_admin_competition_required");
  expect(d.error, `${what}: answered by the right arm`).toMatch(sentence);
}

test.describe("v8.7.0 — the event-admin participants surface", () => {
  /** @type {any} */ let world;
  let globalAdmin, gaApi, gaCsrf;   // a role='admin' CONTROL actor, see below

  test.beforeAll(async () => {
    world = await buildWorld();

    // JOB 2's PRECONDITION, built here rather than inside the test that needs it
    // (v7.21.39: a fixture is a precondition, never a side effect of test #1).
    // `inMine` is now in BOTH events, which is the ONLY arrangement in which the
    // per-row competitions column can be wrong while the row set is right.
    await enrol(world.sa, world.saCsrf, world.theirs.id, [world.inMine.id]);

    // A SECOND global admin exists for one reason: `POST …/impersonate` REPLACES
    // the caller's session with the target's, and single-session enforcement
    // means we cannot simply log the superadmin back in — that would kill
    // `world.sa` for every remaining test. So the impersonation CONTROL is run by
    // a disposable `role='admin'` account instead, which is the tier the doctrine
    // asks for anyway.
    globalAdmin = await makeParticipant(world.sa, world.saCsrf, "globaladmin");
    const rr = await world.sa.post(`/api/admin/participants/${globalAdmin.id}/role`, {
      headers: H(world.saCsrf), data: { role: "admin" },
    });
    expect(rr.ok(), `promote control admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    const gl = await apiLogin(globalAdmin.email, PARTICIPANT_PASS);
    gaApi = gl.api; gaCsrf = gl.csrf;
    const gme = await (await gaApi.get("/api/admin/me")).json();
    expect(gme.role, "the control actor is a GLOBAL admin, not an event admin").toBe("admin");
    expect(gme.isEventAdmin).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. THE ROW SET
  // ═══════════════════════════════════════════════════════════════════════════

  test("the row set holds only people enrolled in the actor's events — and the superadmin sees both", async () => {
    const r = await world.eaApi.get("/api/admin/participants?limit=5000");
    expect(r.ok(), `event-admin list: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const seen = ids(body.participants);

    expect(seen, "the participant in one of MY events is visible").toContain(world.inMine.id);
    // THE DECOY. With one competition a build that dropped the filter entirely
    // returns exactly the same rows as a correct one.
    expect(seen, "a participant enrolled ONLY in somebody else's event is not").not.toContain(world.inTheirs.id);
    // …and neither is the seeded population, which belongs to nobody's event here.
    expect(body.participants.map(p => p.email), "the seeded directory is not theirs either")
      .not.toContain("alice@acme.com");
    expect(body.total, "`total` counts the narrowed set, not the platform").toBe(body.participants.length);

    // THE CONTROL: an unscoped actor sees all of it, so "the event admin saw few
    // rows" cannot be satisfied by a build that returns few rows to everybody.
    const c = await world.sa.get("/api/admin/participants?limit=5000");
    const all = ids((await c.json()).participants);
    expect(all).toContain(world.inMine.id);
    expect(all).toContain(world.inTheirs.id);
  });

  test("ZERO GRANTS SEES NOBODY — the empty-scope fail-open catcher", async () => {
    // `scopedCompetitionIds` answers [] here, and `IN ()` is a SQLite syntax
    // error — so the shape this catches is a filter that degrades to "" and
    // hands this actor the WHOLE platform directory.
    const me = await world.zeroApi.get("/api/admin/me");
    expect((await me.json()).isEventAdmin, "precondition: the actor really holds the tier").toBe(true);

    const r = await world.zeroApi.get("/api/admin/participants?limit=5000");
    expect(r.ok(), `zero-grant list: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    expect(body.participants.length,
      `an event admin with no grants must see NO participants, saw ${body.participants.length}`).toBe(0);
    expect(body.total).toBe(0);
    expect(body.pendingApproval, "…and no work waiting either").toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. THE PER-ROW COMPETITIONS ARRAY
  // ═══════════════════════════════════════════════════════════════════════════

  test("the per-row competitions column names ONLY the actor's own events", async () => {
    // The operator's explicit rule, and it is invisible to the row-set test:
    // `inMine` is legitimately visible to this actor AND is enrolled in an event
    // they do not manage, so left unnarrowed this column is a directory of the
    // whole platform rendered one row at a time.
    const body = await (await world.eaApi.get("/api/admin/participants?limit=5000")).json();
    const row = body.participants.find(p => p.id === world.inMine.id);
    expect(row, "precondition: the participant is on the event admin's own list").toBeTruthy();

    const compIds = ids(row.competitions);
    expect(compIds, "their event is named").toContain(world.mine.id);
    expect(compIds, "somebody else's event is NOT — even on a row this actor may see")
      .not.toContain(world.theirs.id);
    expect(compIds.length, "exactly one event, so nothing arrives under another name").toBe(1);

    // THE CONTROL: the fixture really does hold both memberships, so "only one
    // event was listed" cannot be satisfied by a participant who is in one event.
    const sBody = await (await world.sa.get("/api/admin/participants?limit=5000")).json();
    const sRow = sBody.participants.find(p => p.id === world.inMine.id);
    const sIds = ids(sRow.competitions);
    expect(sIds, "the superadmin sees the event the actor manages").toContain(world.mine.id);
    expect(sIds, "…and the one they do not").toContain(world.theirs.id);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. pendingApproval
  // ═══════════════════════════════════════════════════════════════════════════

  test("pendingApproval counts only work this actor can act on", async () => {
    // A global count tells an event admin that N people are waiting while the
    // list they can act on shows none: a badge that cannot be cleared, counting
    // somebody else's work, on the one control that exists to say "act now".
    //
    // STATED HONESTLY: the pending participant is enrolled NOWHERE rather than in
    // `world.theirs`, because `POST /api/admin/competitions/assign` SKIPS an
    // unapproved user (`skippedUnapproved`) — there is no API path that produces
    // an enrolled-and-unapproved account. Being in no event at all is out of this
    // actor's scope by the same predicate, so the assertion is unchanged; what it
    // does not additionally prove is the enrolled-in-someone-else's-event case.
    const before = (await (await world.sa.get("/api/admin/participants?limit=1")).json()).pendingApproval;
    const pending = await makeUnapprovedParticipant(world.sa, world.saCsrf, "pendingbadge");

    // THE CONTROL: the badge really does count this person for an unscoped actor,
    // so "the event admin's count is zero" cannot be satisfied by a build whose
    // count is always zero.
    const after = (await (await world.sa.get("/api/admin/participants?limit=1")).json()).pendingApproval;
    expect(after, "the superadmin's badge counts the newly pending account").toBe(before + 1);

    const ea = await (await world.eaApi.get("/api/admin/participants?limit=1")).json();
    expect(ea.pendingApproval,
      "an event admin's badge must not count approvals outside their events").toBe(0);

    // …and the row itself is absent, which is the same rule one field over.
    const eaFull = await (await world.eaApi.get("/api/admin/participants?limit=5000")).json();
    expect(ids(eaFull.participants)).not.toContain(pending.id);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. event_admin_for
  // ═══════════════════════════════════════════════════════════════════════════

  test("event_admin_for names the events a person ORGANISES", async () => {
    // The role alone cannot answer "which of my events is she running?", and the
    // scope is the half an admin acts on — the role is granted once, the events
    // change constantly.
    const body = await (await world.sa.get("/api/admin/participants?limit=5000")).json();
    const eaRow = body.participants.find(p => p.id === world.ea.id);
    expect(eaRow, "the event admin has a row of their own").toBeTruthy();
    expect(eaRow.role, "…and it reports the real tier").toBe("event_admin");
    expect(ids(eaRow.event_admin_for), "…naming exactly the event they were granted")
      .toEqual([world.mine.id]);

    // DECOYS: a zero-grant event admin organises nothing, and an ordinary
    // participant organises nothing — so "the field was populated" cannot be
    // satisfied by a build that lists every event on every row.
    const zeroRow = body.participants.find(p => p.id === world.zero.id);
    expect(zeroRow.role, "the zero-grant actor still HOLDS the tier").toBe("event_admin");
    expect(zeroRow.event_admin_for, "…and organises nothing").toEqual([]);
    const plainRow = body.participants.find(p => p.id === world.inMine.id);
    expect(plainRow.event_admin_for, "an ordinary participant organises nothing").toEqual([]);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A NAMED EVENT IS 403, NOT AN EMPTY LIST
  // ═══════════════════════════════════════════════════════════════════════════

  test("?competitionId= is REFUSED out of scope, not silently emptied", async () => {
    // On an admin surface an empty list for an out-of-scope event is
    // indistinguishable from an event nobody has joined, so the actor reads it as
    // a fact about the event rather than about their own permissions.
    const bad = await world.eaApi.get(`/api/admin/participants?competitionId=${world.theirs.id}`);
    await expectRefused(bad, "a named out-of-scope event", "event_admin_out_of_scope");

    const good = await world.eaApi.get(`/api/admin/participants?competitionId=${world.mine.id}`);
    expect(good.ok(), `the granted event IS served: ${good.status()}`).toBeTruthy();
    expect(ids((await good.json()).participants), "…with its members").toContain(world.inMine.id);

    // THE CONTROL: the same query is served to an unscoped actor.
    const ctl = await world.sa.get(`/api/admin/participants?competitionId=${world.theirs.id}`);
    expect(ctl.ok(), `the superadmin can still scope to that event: ${ctl.status()}`).toBeTruthy();
    expect(ids((await ctl.json()).participants)).toContain(world.inTheirs.id);

    // The zero-grant actor cannot name ANY event.
    const z = await world.zeroApi.get(`/api/admin/participants?competitionId=${world.mine.id}`);
    await expectRefused(z, "a zero-grant actor naming an event", "event_admin_out_of_scope");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THE PICKER
  // ═══════════════════════════════════════════════════════════════════════════

  test("the picker refuses an out-of-scope event and serves an in-scope one", async () => {
    const bad = await world.eaApi.get(`/api/admin/participants/picker?competitionId=${world.theirs.id}`);
    await expectRefused(bad, "the picker on somebody else's event", "event_admin_out_of_scope");

    const good = await world.eaApi.get(`/api/admin/participants/picker?competitionId=${world.mine.id}`);
    expect(good.ok(), `the picker on my own event: ${good.status()} ${await good.text()}`).toBeTruthy();
    const d = await good.json();
    expect(ids(d.users), "…and it lists that event's members").toContain(world.inMine.id);

    // CONTROL + zero-grant.
    const ctl = await world.sa.get(`/api/admin/participants/picker?competitionId=${world.theirs.id}`);
    expect(ctl.ok(), `the superadmin picker on that event: ${ctl.status()}`).toBeTruthy();
    const z = await world.zeroApi.get(`/api/admin/participants/picker?competitionId=${world.mine.id}`);
    await expectRefused(z, "a zero-grant actor's picker", "event_admin_out_of_scope");
  });

  test("the picker's NON-MEMBER pool is narrowed to people already in the actor's events", async () => {
    // The pool returns the full profile column set — email, secondary email,
    // phone, company, city, LinkedIn URL — searchable. Left platform-wide, three
    // letters here read the contact details of every account on the platform.
    //
    // THIS NEEDS A TWO-EVENT ORGANISER, and that is the whole point of the
    // fixture. With a single event the non-member pool is empty BY CONSTRUCTION
    // ("not in this event" AND "in one of my events" is unsatisfiable), so
    // "`inTheirs` is absent" would pass against a build with no narrowing at all
    // — a vacuous assertion wearing a leak test's clothes. A second event gives
    // the pool a member it MUST still contain.
    const other = await makeCompetition(world.sa, world.saCsrf, "picker-other");
    const pickEa = await makeParticipant(world.sa, world.saCsrf, "pickerea");
    await grantEventAdmin(world.sa, world.saCsrf, world.mine.id, pickEa.id);
    await grantEventAdmin(world.sa, world.saCsrf, other.id, pickEa.id);
    const pickable = await makeParticipant(world.sa, world.saCsrf, "pickable");
    await enrol(world.sa, world.saCsrf, other.id, [pickable.id]);

    const pl = await apiLogin(pickEa.email, PARTICIPANT_PASS);
    const meta = await (await pl.api.get("/api/admin/me")).json();
    expect(meta.eventAdminCompetitionCount, "precondition: this organiser runs TWO events").toBe(2);

    const r = await pl.api.get(`/api/admin/participants/picker?competitionId=${world.mine.id}&limit=5000`);
    expect(r.ok(), `picker: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    const candidates = d.users.filter(u => !u.in_competition).map(u => u.id);

    // THE POSITIVE CONTROL: the pool is not merely empty.
    expect(candidates, "somebody in the organiser's OTHER event is still pickable").toContain(pickable.id);
    // THE LEAK: somebody in nobody's event of theirs is not.
    expect(candidates, "a participant in an event they do not manage is NOT a candidate")
      .not.toContain(world.inTheirs.id);
    expect(candidates, "…nor is the seeded population").not.toContain(world.zero.id);

    // THE CONTROL: an unscoped actor sees both, so the absence above is a
    // narrowing rather than an empty platform.
    const c = await world.sa.get(`/api/admin/participants/picker?competitionId=${world.mine.id}&limit=5000`);
    const saCandidates = (await c.json()).users.filter(u => !u.in_competition).map(u => u.id);
    expect(saCandidates).toContain(pickable.id);
    expect(saCandidates).toContain(world.inTheirs.id);

    await pl.api.dispose();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PER-PARTICIPANT ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  const PROBE_TAG = "ea-probe";
  // TWO DISTINCT phone numbers, because the same out-of-scope target is written
  // by the event admin (refused) and then by the superadmin control (permitted).
  // With one shared value "a refused PUT committed nothing" is UNFALSIFIABLE: the
  // control writes the identical bytes over whatever the refusal did or did not
  // do, so the column can never tell the two apart afterwards.
  const EA_PHONE = "+44 20 7946 0111";   // only an EVENT ADMIN ever sends this
  const CTL_PHONE = "+44 20 7946 0222";  // only the superadmin CONTROL ever does
  const ACTIONS = {
    unlock: (api, csrf, id) => api.post(`/api/admin/participants/${id}/unlock`, { headers: H(csrf), data: {} }),
    "login-code/email": (api, csrf, id) => api.post(`/api/admin/participants/${id}/login-code/email`, { headers: H(csrf), data: {} }),
    "tags POST": (api, csrf, id) => api.post(`/api/admin/participants/${id}/tags`, { headers: H(csrf), data: { tag: PROBE_TAG } }),
    "tags DELETE": (api, csrf, id) => api.delete(`/api/admin/participants/${id}/tags/${encodeURIComponent(PROBE_TAG)}`, { headers: H(csrf) }),
    "PUT profile": (api, csrf, id, phone = EA_PHONE) => api.put(`/api/admin/participants/${id}`, { headers: H(csrf), data: { phone } }),
    deny: (api, csrf, id) => api.post(`/api/admin/participants/${id}/deny`, { headers: H(csrf), data: { reason: "spec" } }),
    block: (api, csrf, id) => api.post(`/api/admin/participants/${id}/block`, { headers: H(csrf), data: {} }),
  };

  test("every per-participant action is refused out of scope, permitted in scope, and works for a global admin", async () => {
    // Ordered so the non-destructive actions share one pair of targets and the
    // two one-way ones (deny blocks the account; block is a TOGGLE, v8.3.28) get
    // their own — a shared target would make each assertion depend on what the
    // previous action left behind.
    const SAFE = ["unlock", "login-code/email", "tags POST", "tags DELETE", "PUT profile"];
    // `deny` is NOT here: it is only valid for a not-yet-approved account, and
    // an unapproved account cannot be enrolled at all, so neither of its arms
    // fits this shape. It has its own test below, beside `approve`.
    const ONE_WAY = ["block"];

    const safeOut = await makeParticipant(world.sa, world.saCsrf, "safeout");
    await enrol(world.sa, world.saCsrf, world.theirs.id, [safeOut.id]);
    const safeIn = await makeParticipant(world.sa, world.saCsrf, "safein");
    await enrol(world.sa, world.saCsrf, world.mine.id, [safeIn.id]);

    for (const name of SAFE) {
      const call = ACTIONS[name];
      // 1. REFUSED against somebody in an event this actor does not manage.
      await expectRefused(await call(world.eaApi, world.eaCsrf, safeOut.id, EA_PHONE),
        `${name} on an out-of-scope participant`, "event_admin_out_of_scope");
      // 1b. …AND IT WROTE NOTHING. Read back HERE, before the control runs: a 403
      //     returned AFTER the handler has already committed is a real shape (it
      //     is exactly what the approve and deny tests below exist to catch), and
      //     once the control has written the same column nothing can see it.
      if (name === "PUT profile") {
        const midOut = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
          .participants.find(p => p.id === safeOut.id);
        expect(midOut.phone, "a REFUSED profile edit must not have written the column").not.toBe(EA_PHONE);
      }
      // 2. THE CONTROL — the identical call, the identical target, an unscoped
      //    actor. Without it "refused" is satisfied by a broken route.
      const ctl = await call(world.sa, world.saCsrf, safeOut.id, CTL_PHONE);
      expect(ctl.status(), `${name} must still serve a superadmin: ${await ctl.text()}`).toBeLessThan(400);
      // 3. PERMITTED against somebody in an event this actor DOES manage —
      //    otherwise "refused" is satisfied by a build that refuses everything.
      const ok = await call(world.eaApi, world.eaCsrf, safeIn.id, EA_PHONE);
      expect(ok.status(), `${name} must be permitted in scope: ${await ok.text()}`).toBeLessThan(400);
      // 3b. A 2xx is not the tag LANDING, and without this the "the DELETE really
      //     removed it" assertion at the end of this test is satisfied just as
      //     well by a POST that stored nothing at all.
      if (name === "tags POST") {
        const midIn = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
          .participants.find(p => p.id === safeIn.id);
        expect(midIn.tags || [], "the in-scope tag POST really landed").toContain(PROBE_TAG);
      }
    }

    for (const name of ONE_WAY) {
      const call = ACTIONS[name];
      const out = await makeParticipant(world.sa, world.saCsrf, `out-${name}`);
      await enrol(world.sa, world.saCsrf, world.theirs.id, [out.id]);
      const inn = await makeParticipant(world.sa, world.saCsrf, `in-${name}`);
      await enrol(world.sa, world.saCsrf, world.mine.id, [inn.id]);

      await expectRefused(await call(world.eaApi, world.eaCsrf, out.id),
        `${name} on an out-of-scope participant`, "event_admin_out_of_scope");
      // …and the refusal did not act. `block` is a TOGGLE (v8.3.28), so a handler
      // that ran and then refused would have flipped the flag — and the control
      // below is about to set it, so this is the only moment it is observable.
      const midOne = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
        .participants.find(p => p.id === out.id);
      expect(midOne.blocked, `a refused ${name} must not have flipped the account`).toBeFalsy();
      const ctl = await call(world.sa, world.saCsrf, out.id);
      expect(ctl.status(), `${name} must still serve a superadmin: ${await ctl.text()}`).toBeLessThan(400);
      const ok = await call(world.eaApi, world.eaCsrf, inn.id);
      expect(ok.status(), `${name} must be permitted in scope: ${await ok.text()}`).toBeLessThan(400);
      // …and it really acted. `block` is a TOGGLE (v8.3.28), so the flip is the
      // only evidence that separates "permitted" from "accepted and ignored".
      if (name === "block") {
        const row = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
          .participants.find(p => p.id === inn.id);
        expect(row.blocked, "the in-scope block really landed").toBeTruthy();
      }
    }

    // A 2xx alone is a weak claim for a DELETE and for a sparse PUT — a route
    // that accepted the call and stored nothing satisfies it just as well (the
    // v8.3.37 certificate-name defect, which is exactly that shape). So read the
    // in-scope target back and assert the writes LANDED.
    const after = (await (await world.sa.get("/api/admin/participants?limit=5000")).json()).participants;
    const inRow = after.find(p => p.id === safeIn.id);
    expect(inRow.phone, "the in-scope PUT really stored the field").toBe(EA_PHONE);
    expect(inRow.tags || [], "…and the in-scope tag DELETE really removed it").not.toContain(PROBE_TAG);

    // …and the CONTROL really wrote, rather than merely answering 2xx. `block` is
    // never called on this target by anybody, so the old assertion here — that it
    // is not blocked — could not fail on any build and read as coverage.
    // (That the REFUSALS committed nothing is asserted mid-loop above, which is
    // the only point at which the control has not yet overwritten the evidence.)
    const outRow = after.find(p => p.id === safeOut.id);
    expect(outRow.phone, "the superadmin CONTROL's identical call really did write").toBe(CTL_PHONE);
  });

  test("approve is scoped — and the refusal happens before the account is touched or mailed", async () => {
    // The permitted arm can only be shown against an ALREADY-APPROVED in-scope
    // target (which answers `{ok:true, already:true}`), because there is no API
    // path that produces an enrolled-and-unapproved account: assign skips an
    // unapproved user. That still discriminates — the scope check runs BEFORE the
    // `already` short-circuit, so a wrongly-scoped build 403s here too.
    const pending = await makeUnapprovedParticipant(world.sa, world.saCsrf, "approvetarget");

    await expectRefused(
      await world.eaApi.post(`/api/admin/participants/${pending.id}/approve`, { headers: H(world.eaCsrf), data: {} }),
      "approve on someone outside every event of theirs", "event_admin_out_of_scope");

    // Nothing happened — a refused approval must not flip the row or send the
    // "you can now log in" mail.
    const mid = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === pending.id);
    expect(mid.approved, "the refusal committed nothing").toBeFalsy();

    // THE CONTROL: the same target really is approvable.
    const ctl = await world.sa.post(`/api/admin/participants/${pending.id}/approve`, { headers: H(world.saCsrf), data: {} });
    expect(ctl.ok(), `superadmin approve: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();

    // …and the in-scope arm gets past the gate.
    const ok = await world.eaApi.post(`/api/admin/participants/${world.inMine.id}/approve`, { headers: H(world.eaCsrf), data: {} });
    expect(ok.ok(), `approve in scope: ${ok.status()} ${await ok.text()}`).toBeTruthy();
  });

  test("deny is scoped — and the scope gate answers BEFORE the lifecycle one", async () => {
    // Own test for the same reason `approve` has one: denial is only valid for a
    // not-yet-approved account, and there is no API path that enrols one (assign
    // skips an unapproved user). So the two arms are asymmetric by construction —
    // and that is exactly why the in-scope arm below is worth asserting: it proves
    // the request reached the LIFECYCLE precondition, which a wrongly-scoped build
    // would never have let it do.
    const out = await makeUnapprovedParticipant(world.sa, world.saCsrf, "denyout");

    await expectRefused(
      await world.eaApi.post(`/api/admin/participants/${out.id}/deny`, { headers: H(world.eaCsrf), data: { reason: "spec" } }),
      "denying somebody outside every event of theirs", "event_admin_out_of_scope");

    // Nothing happened: deny is terminal for the account and mails the person.
    const mid = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === out.id);
    expect(mid.denied_at || mid.blocked, "a refused denial commits nothing and sends nothing").toBeFalsy();

    // THE CONTROL: the same person really is deniable.
    const ctl = await world.sa.post(`/api/admin/participants/${out.id}/deny`, {
      headers: H(world.saCsrf), data: { reason: "spec" },
    });
    expect(ctl.ok(), `superadmin deny: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();

    // IN SCOPE: refused by the lifecycle rule ("already approved"), NOT by scope —
    // a 400 here is the proof the scope gate let it through.
    const inn = await world.eaApi.post(`/api/admin/participants/${world.inMine.id}/deny`, {
      headers: H(world.eaCsrf), data: { reason: "spec" },
    });
    expect(inn.status(), "an in-scope denial reaches the lifecycle check").toBe(400);
    const ib = await inn.json();
    expect(ib.code, "…so it is NOT an event-admin refusal").toBeUndefined();
    expect(ib.error).toMatch(/already approved/i);
  });

  test("the sign-in-code reveal is scoped — the response CONTAINS a working credential", async () => {
    // Both targets are desk-invited, because a password-holding account is
    // permanently code-ineligible and would answer 409 for a reason that has
    // nothing to do with scope — a permitted arm that could never succeed.
    const out = await deskInvite(world.sa, world.saCsrf, world.theirs.id, "revealout");
    const inn = await deskInvite(world.sa, world.saCsrf, world.mine.id, "revealin");

    await expectRefused(
      await world.eaApi.post(`/api/admin/participants/${out.id}/login-code/reveal`, { headers: H(world.eaCsrf), data: {} }),
      "revealing a code for somebody in another organiser's event", "event_admin_out_of_scope");

    const ctl = await world.sa.post(`/api/admin/participants/${out.id}/login-code/reveal`, { headers: H(world.saCsrf), data: {} });
    expect(ctl.ok(), `superadmin reveal: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
    expect((await ctl.json()).code, "the control really did mint a credential").toBeTruthy();

    const ok = await world.eaApi.post(`/api/admin/participants/${inn.id}/login-code/reveal`, { headers: H(world.eaCsrf), data: {} });
    expect(ok.ok(), `reveal in scope: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    const revealed = (await ok.json()).code;
    expect(revealed, "an organiser gets a code for their own attendee").toBeTruthy();

    // THE TITLE'S OWN CLAIM, which nothing above establishes: "a code came back"
    // is satisfied by any non-empty string. This endpoint is the desk fallback —
    // an organiser reads the value off their screen and the attendee types it —
    // so the property worth locking is that it REDEEMS, not that it is truthy.
    // `/api/auth/code/redeem` answers 200 for every outcome (the 200-always
    // contract), so the verdict is the payload's own `ok`, never `r.ok()`.
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const c = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
      const red = await anon.post("/api/auth/code/redeem", {
        headers: H(c), data: { email: inn.email, code: revealed },
      });
      const rb = await red.json();
      expect(rb.ok, `the revealed code really signs the attendee in: ${JSON.stringify(rb)}`).toBe(true);
      const me = await anon.get("/api/me");
      expect(me.ok(), "…and the session it establishes is real").toBeTruthy();
      expect((await me.json()).email, "…as that attendee, not somebody else").toBe(inn.email);
    } finally { await anon.dispose(); }
  });

  test("impersonation is scoped — it assumes the identity EVERYWHERE, not just inside one event", async () => {
    // Own test because a successful impersonation REPLACES the caller's session:
    // `world.eaApi` and `world.sa` must both survive this file, so the permitted
    // arm uses a disposable second organiser and the control uses the disposable
    // global admin built in beforeAll.
    await expectRefused(
      await world.eaApi.post(`/api/admin/participants/${world.inTheirs.id}/impersonate`, { headers: H(world.eaCsrf), data: {} }),
      "impersonating somebody in another organiser's event", "event_admin_out_of_scope");
    // The refusal did not touch the caller's own session.
    const still = await (await world.eaApi.get("/api/admin/me")).json();
    expect(still.role, "a refused impersonation leaves the actor as themselves").toBe("event_admin");

    // THE CONTROL: a GLOBAL admin can impersonate that same person.
    const ctl = await gaApi.post(`/api/admin/participants/${world.inTheirs.id}/impersonate`, { headers: H(gaCsrf), data: {} });
    expect(ctl.ok(), `global-admin impersonate: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
    expect((await ctl.json()).readOnly, "a non-superadmin impersonation is read-only").toBe(true);

    // …and an organiser CAN impersonate their own attendee.
    const impEa = await makeParticipant(world.sa, world.saCsrf, "impea");
    await grantEventAdmin(world.sa, world.saCsrf, world.mine.id, impEa.id);
    const il = await apiLogin(impEa.email, PARTICIPANT_PASS);
    const ok = await il.api.post(`/api/admin/participants/${world.inMine.id}/impersonate`, { headers: H(il.csrf), data: {} });
    expect(ok.ok(), `impersonate in scope: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await ok.json()).target.id).toBe(world.inMine.id);
    await il.api.dispose();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A FELLOW ORGANISER IS NOT AN ATTENDEE — ROLES_AND_PERMISSIONS.md §9.6
  // ═══════════════════════════════════════════════════════════════════════════

  // §9.6 — the peer-tampering guard for THIS tier, and the one the pre-existing
  // guard could not cover.
  //
  // Every per-participant route already refuses an `admin` / `superadmin` target
  // for a non-superadmin actor. `event_admin` is a role that guard has never
  // heard of — and two organisers sharing an event, one of whom is also an
  // ATTENDEE of it, is the ordinary case this role was built for. Before the
  // clause in `participantDenied`, one co-organiser acting on another measured:
  // block 200, reset-password 200, tags 200, PUT profile 200, impersonate 200.
  //
  // This test was first written as a `test.fail()` against that gap, which is
  // what forced the annotation off in the same commit as the fix (v7.20.11).
  test("a fellow organiser is not an attendee — every action is refused", async () => {
    const peer = await makeParticipant(world.sa, world.saCsrf, "peerorganiser");
    await grantEventAdmin(world.sa, world.saCsrf, world.mine.id, peer.id);
    // …and they are ALSO an attendee of the event they help run, which is the
    // only thing that puts them inside `participantDenied`'s membership test.
    // Without it the refusal would be the ordinary out-of-scope one and would
    // prove nothing about the peer clause.
    await enrol(world.sa, world.saCsrf, world.mine.id, [peer.id]);

    // PRECONDITIONS asserted, or the refusals below could be about anything.
    const row = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === peer.id);
    expect(row, "precondition: the peer exists").toBeTruthy();
    expect(row.role, "precondition: the target is a fellow ORGANISER, not an ordinary attendee").toBe("event_admin");
    expect(ids(row.competitions), "precondition: …enrolled in the actor's own event").toContain(world.mine.id);
    expect(row.blocked, "precondition: they start unblocked").toBeFalsy();

    const cases = [
      ["block", () => world.eaApi.post(`/api/admin/participants/${peer.id}/block`, { headers: H(world.eaCsrf), data: {} })],
      ["login-code/email", () => world.eaApi.post(`/api/admin/participants/${peer.id}/login-code/email`, { headers: H(world.eaCsrf), data: {} })],
      ["tag", () => world.eaApi.post(`/api/admin/participants/${peer.id}/tags`, { headers: H(world.eaCsrf), data: { tag: "peer-should-not-stick" } })],
      ["edit profile", () => world.eaApi.put(`/api/admin/participants/${peer.id}`, { headers: H(world.eaCsrf), data: { company: "Hijacked" } })],
      ["impersonate", () => world.eaApi.post(`/api/admin/participants/${peer.id}/impersonate`, { headers: H(world.eaCsrf), data: {} })],
    ];
    for (const [name, call] of cases) {
      const r = await call();
      expect(r.status(), `an event admin must not ${name} a fellow organiser`).toBe(403);
      expect((await r.json()).code, `${name} names the peer rule, not merely scope`)
        .toBe("event_admin_target_privileged");
    }

    // STATE, not status: a 403 that had already written is the defect wearing a
    // refusal's clothes.
    const after = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === peer.id);
    expect(after.blocked, "…the co-organiser can still sign in").toBeFalsy();
    expect(after.tags || [], "…and carries no tag from the refused call").not.toContain("peer-should-not-stick");
    expect(after.company, "…and their profile is untouched").not.toBe("Hijacked");

    // THE CONTROL: a GLOBAL admin must still be able to manage them, or "the
    // event admin was refused" is satisfied by a build that broke these routes
    // for everybody — and demoting an event admin is a thing the operator
    // explicitly requires an ordinary admin to be able to do.
    const c = await world.sa.post(`/api/admin/participants/${peer.id}/tags`, {
      headers: H(world.saCsrf), data: { tag: "sa-control-tag" },
    });
    expect(c.ok(), `superadmin control: ${c.status()} ${await c.text()}`).toBeTruthy();
    const ctl = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === peer.id);
    expect(ctl.tags || [], "the superadmin's tag really landed").toContain("sa-control-tag");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUPERADMIN-ONLY ACTIONS STAY REFUSED
  // ═══════════════════════════════════════════════════════════════════════════

  test("verify / role / delete are refused even on the actor's OWN participant", async () => {
    // These are refused by TIER, not by scope, so the target is deliberately one
    // the actor can otherwise act on freely — anything else would leave it unclear
    // which gate answered.
    const cases = [
      ["verify", () => world.eaApi.post(`/api/admin/participants/${world.inMine.id}/verify`, { headers: H(world.eaCsrf), data: {} })],
      ["role", () => world.eaApi.post(`/api/admin/participants/${world.inMine.id}/role`, { headers: H(world.eaCsrf), data: { role: "admin" } })],
      ["delete", () => world.eaApi.delete(`/api/admin/participants/${world.inMine.id}`, { headers: H(world.eaCsrf) })],
    ];
    // WHO IS THIS SESSION? A bare `Expected 403, Received 200` cannot separate
    // "the tier gate broke" from "this context is no longer the event admin" —
    // and the second really has been observed here once, intermittently. Asserting
    // the actor first turns that ambiguity into a named precondition failure.
    const whoami = await (await world.eaApi.get("/api/admin/me")).json();
    expect(whoami.role, `precondition: the actor is still an event admin, got ${JSON.stringify(whoami)}`).toBe("event_admin");
    expect(whoami.isSuperAdmin, "precondition: …and is emphatically not a superadmin").toBeFalsy();

    for (const [name, call] of cases) {
      const r = await call();
      expect(r.status(), `${name} must be refused for an event admin (actor: ${JSON.stringify(whoami)})`).toBe(403);
      // Passed through to the route's own requireSuperAdmin deliberately, so the
      // caller gets that guard's accurate wording rather than a generic one.
      expect((await r.json()).error, `${name} names the tier that CAN do it`).toMatch(/superadmin/i);
    }
    // And the role change did not land — this is the clause that stops the role
    // self-propagating.
    const row = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === world.inMine.id);
    expect(row.role, "the target is still an ordinary participant").toBe("participant");

    // THE CONTROL, on throwaways because two of the three are one-way.
    const vTarget = await makeUnapprovedParticipant(world.sa, world.saCsrf, "ctlverify");
    // makeUnapprovedParticipant already verified them, so re-verify is the
    // idempotent form; what matters is that it is NOT a 403 about roles.
    const v = await world.sa.post(`/api/admin/participants/${vTarget.id}/verify`, { headers: H(world.saCsrf), data: {} });
    expect(v.status(), "verify still serves a superadmin").not.toBe(403);
    // …and the route RAN rather than blowing up, or "not 403" is satisfied by a 500.
    expect(v.status(), "verify is not merely broken for everybody").toBeLessThan(500);

    const rTarget = await makeParticipant(world.sa, world.saCsrf, "ctlrole");
    const rr = await world.sa.post(`/api/admin/participants/${rTarget.id}/role`, { headers: H(world.saCsrf), data: { role: "admin" } });
    expect(rr.ok(), `superadmin role change: ${rr.status()} ${await rr.text()}`).toBeTruthy();


    const dTarget = await makeParticipant(world.sa, world.saCsrf, "ctldelete");
    const dr = await world.sa.delete(`/api/admin/participants/${dTarget.id}`, { headers: H(world.saCsrf) });
    expect(dr.ok(), `superadmin delete: ${dr.status()} ${await dr.text()}`).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BULK
  // ═══════════════════════════════════════════════════════════════════════════

  test("bulk assign refuses an out-of-scope event BY NAME, and serves an in-scope one", async () => {
    // Refused rather than silently dropped: a bulk route that drops half its
    // targets and reports success is the "control that appears to work" failure,
    // and here the dropped half is the one the actor most needs told about.
    const p = await makeParticipant(world.sa, world.saCsrf, "bulkassign");

    const bad = await world.eaApi.post("/api/admin/competitions/assign", {
      headers: H(world.eaCsrf), data: { userIds: [p.id], competitionIds: [world.theirs.id] },
    });
    const b = await expectRefused(bad, "assigning into somebody else's event", "event_admin_out_of_scope");
    expect(b.error, "the refusal names the event").toContain(world.theirs.name);
    expect(b.competitionIds, "…and reports which ids were out of scope").toEqual([world.theirs.id]);

    // Nothing landed.
    const after = (await (await world.sa.get(`/api/admin/participants?competitionId=${world.theirs.id}&limit=5000`)).json());
    expect(ids(after.participants), "a refused assign enrols nobody").not.toContain(p.id);

    // PERMITTED into their own event.
    const ok = await world.eaApi.post("/api/admin/competitions/assign", {
      headers: H(world.eaCsrf), data: { userIds: [p.id], competitionIds: [world.mine.id] },
    });
    expect(ok.ok(), `assign into my own event: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await ok.json()).assigned, "…and it really enrolled them").toBe(1);

    // THE CONTROL: the superadmin can assign into the decoy event.
    const ctl = await world.sa.post("/api/admin/competitions/assign", {
      headers: H(world.saCsrf), data: { userIds: [p.id], competitionIds: [world.theirs.id] },
    });
    expect(ctl.ok(), `superadmin assign: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
  });

  test("bulk-approve SKIPS out-of-scope targets and reports the counter", async () => {
    // Skipped rather than refused, matching every other precondition on this
    // route: a mixed batch must still land the rows the actor may act on. The
    // count is reported, or the operator is told "approved 8" and never why the
    // other four are still pending (the v7.21.2 defect).
    const pending = await makeUnapprovedParticipant(world.sa, world.saCsrf, "bulkpending");

    const r = await world.eaApi.post("/api/admin/participants/bulk-approve", {
      headers: H(world.eaCsrf), data: { userIds: [pending.id] },
    });
    expect(r.ok(), `bulk-approve: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    expect(d.approved, "nothing outside the actor's events is approved").toBe(0);
    expect(d.skippedOutOfScope, "…and the skip is COUNTED, not silent").toBe(1);

    // It really did not land.
    const mid = (await (await world.sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.id === pending.id);
    expect(mid.approved, "the skipped row is still pending").toBeFalsy();

    // THE CONTROL: the same batch, an unscoped actor — so "approved 0" cannot be
    // satisfied by a build whose bulk-approve approves nobody.
    const ctl = await world.sa.post("/api/admin/participants/bulk-approve", {
      headers: H(world.saCsrf), data: { userIds: [pending.id] },
    });
    expect(ctl.ok(), `superadmin bulk-approve: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
    const cd = await ctl.json();
    expect(cd.approved, "the superadmin approves the very same person").toBe(1);
    expect(cd.skippedOutOfScope, "…and skips nobody for scope").toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // INVITATIONS + DESK-INVITE
  // ═══════════════════════════════════════════════════════════════════════════

  test("invitations may only name the actor's own events — and naming NONE is refused", async () => {
    // An invitation naming no event is a platform-wide account invitation: it
    // creates a participant who belongs to nobody's event, which is the one thing
    // the role must not be able to do.
    const mk = () => [`ea-inv-${uniq("i")}@acme.com`];

    const bad = await world.eaApi.post("/api/admin/invitations", {
      headers: H(world.eaCsrf), data: { emails: mk(), competitionIds: [world.theirs.id] },
    });
    await expectRefused(bad, "inviting into somebody else's event", "event_admin_out_of_scope");

    const none = await world.eaApi.post("/api/admin/invitations", {
      headers: H(world.eaCsrf), data: { emails: mk() },
    });
    expect(none.status(), "an event admin must name an event").toBe(400);
    expect((await none.json()).code).toBe("event_admin_competition_required");

    const ok = await world.eaApi.post("/api/admin/invitations", {
      headers: H(world.eaCsrf), data: { emails: mk(), competitionIds: [world.mine.id] },
    });
    expect(ok.ok(), `invite into my own event: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await ok.json()).invited, "…and it really created one").toBe(1);

    // THE CONTROL: a global admin may do both of the things refused above, so
    // neither refusal is satisfied by a broken invitation route.
    const c1 = await world.sa.post("/api/admin/invitations", {
      headers: H(world.saCsrf), data: { emails: mk(), competitionIds: [world.theirs.id] },
    });
    expect(c1.ok(), `superadmin invite into the decoy: ${c1.status()} ${await c1.text()}`).toBeTruthy();
    const c2 = await world.sa.post("/api/admin/invitations", { headers: H(world.saCsrf), data: { emails: mk() } });
    expect(c2.ok(), `superadmin invite with NO event is legitimate: ${c2.status()}`).toBeTruthy();
  });

  // The Invite Participants dialog makes "tick one of your events" mandatory for
  // an event admin (and locks the tick when only one is admittable). The dialog is
  // UX; the two tests below pin the server rule it mirrors, arm by arm.
  test("an event admin's invitation must name an admittable event of theirs — each refusal answers by its own arm and leaves nothing behind", async () => {
    const o = await makeInviteOrganiser(world.sa, world.saCsrf, "invref");
    const send = data => o.api.post("/api/admin/invitations", { headers: H(o.csrf), data });
    const mk = t => `ea-invr-${uniq(t)}@acme.com`;

    // 1. An empty list is "no event".
    const e1 = mk("empty");
    await expectCompetitionRequired(await send({ emails: [e1], competitionIds: [] }),
      "competitionIds: []", NAME_AN_EVENT);
    expect(invitationRows(e1), "[]: no invitation row stored").toEqual([]);

    // 2. A non-array is "no event" — a bare id string must not be read as a list.
    const e2 = mk("string");
    await expectCompetitionRequired(await send({ emails: [e2], competitionIds: o.L.id }),
      "competitionIds as a bare string", NAME_AN_EVENT);
    expect(invitationRows(e2), "bare string: no invitation row stored").toEqual([]);

    // 3. Naming only an ended event (no late window) leaves nothing to join.
    const e3 = mk("ended");
    await expectCompetitionRequired(await send({ emails: [e3], competitionIds: [o.E.id] }),
      "only an ended event", NOTHING_ADMITTABLE);
    expect(invitationRows(e3), "[E]: no invitation row stored").toEqual([]);

    // 4. Groups do not satisfy the rule, and the refusal creates no group.
    const e4 = mk("group");
    const gName = `EA inv grp ${uniq("g")}`;
    await expectCompetitionRequired(await send({ emails: [e4], newGroups: [gName] }),
      "a new group but no event", NAME_AN_EVENT);
    expect(invitationRows(e4), "newGroups only: no invitation row stored").toEqual([]);
    expect(groupsNamed(gName), "newGroups only: the refusal created no group").toBe(0);

    // CONTROL on the same actor: the identical request plus a live event of theirs
    // is accepted and DOES create the group, so the refusal above, not a broken
    // `newGroups`, is why no group appeared (and the row reader does see rows).
    const e4ok = mk("groupok");
    const okRes = await send({ emails: [e4ok], competitionIds: [o.L.id], newGroups: [gName] });
    expect(okRes.ok(), `same request plus [L]: ${okRes.status()} ${await okRes.text()}`).toBeTruthy();
    expect((await okRes.json()).invited, "same request plus [L]: one invitation").toBe(1);
    expect(groupsNamed(gName), "same request plus [L]: the group now exists").toBe(1);
    const okRows = invitationRows(e4ok);
    expect(okRows.length, "same request plus [L]: one stored row").toBe(1);
    expect(okRows[0].competitionIds, "same request plus [L]: stored events").toEqual([o.L.id]);
    expect(okRows[0].groupIds.length, "same request plus [L]: the group is on the invitation").toBe(1);

    // CONTROL: a GLOBAL admin sending [] and [E] is a legitimate platform-wide
    // invitation (the ended event silently dropped), so both refusals above are
    // the event-admin rule and not a broken route.
    //
    // The impersonation test's control leaves `gaApi` IMPERSONATING (read-only,
    // every write 403s), so sign the control admin in afresh: single-session
    // enforcement replaces that session, and this works in any test order.
    const fresh = await apiLogin(globalAdmin.email, PARTICIPANT_PASS);
    await gaApi.dispose();
    gaApi = fresh.api; gaCsrf = fresh.csrf;
    const gme = await (await gaApi.get("/api/admin/me")).json();
    expect(gme.role, "the control actor is a GLOBAL admin").toBe("admin");
    expect(gme.isEventAdmin, "…not an event admin").toBe(false);
    for (const [label, competitionIds] of [["global []", []], ["global [E]", [o.E.id]]]) {
      const email = mk("ga");
      const r = await gaApi.post("/api/admin/invitations", { headers: H(gaCsrf), data: { emails: [email], competitionIds } });
      expect(r.ok(), `${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      expect((await r.json()).invited, `${label}: one invitation`).toBe(1);
      const rows = invitationRows(email);
      expect(rows.length, `${label}: one stored row`).toBe(1);
      expect(rows[0].competitionIds, `${label}: attached to no event`).toEqual([]);
    }
  });

  test("an event admin's invitation stores exactly the admittable events it named — an upcoming one kept, an ended one dropped from a mix", async () => {
    const o = await makeInviteOrganiser(world.sa, world.saCsrf, "invok");
    const send = data => o.api.post("/api/admin/invitations", { headers: H(o.csrf), data });
    const mk = t => `ea-invk-${uniq(t)}@acme.com`;

    // 5. An upcoming event of theirs admits.
    const e5 = mk("upcoming");
    const r5 = await send({ emails: [e5], competitionIds: [o.U.id] });
    expect(r5.ok(), `[U]: ${r5.status()} ${await r5.text()}`).toBeTruthy();
    expect((await r5.json()).invited, "[U]: one invitation").toBe(1);
    const rows5 = invitationRows(e5);
    expect(rows5.length, "[U]: one stored row").toBe(1);
    expect(rows5[0].competitionIds, "[U]: stored events are exactly [U]").toEqual([o.U.id]);

    // 6. A mix keeps only the admittable ids: the ended one is dropped, not refused.
    const e6 = mk("mix");
    const r6 = await send({ emails: [e6], competitionIds: [o.E.id, o.L.id] });
    expect(r6.ok(), `[E, L]: ${r6.status()} ${await r6.text()}`).toBeTruthy();
    expect((await r6.json()).invited, "[E, L]: one invitation").toBe(1);
    const rows6 = invitationRows(e6);
    expect(rows6.length, "[E, L]: one stored row").toBe(1);
    expect(rows6[0].competitionIds, "[E, L]: stored events are exactly [L]").toEqual([o.L.id]);
  });

  test("the desk invite may only create people into the actor's own events", async () => {
    const mk = () => `ea-desk-${uniq("d")}@acme.com`;

    const bad = await world.eaApi.post("/api/admin/participants/desk-invite", {
      headers: H(world.eaCsrf), data: { email: mk(), firstName: "Walk", lastName: "Up", competitionId: world.theirs.id },
    });
    await expectRefused(bad, "desk-inviting into somebody else's event", "event_admin_out_of_scope");

    const none = await world.eaApi.post("/api/admin/participants/desk-invite", {
      headers: H(world.eaCsrf), data: { email: mk(), firstName: "Walk", lastName: "Up" },
    });
    expect(none.status(), "an account enrolled nowhere would fall outside its own creator's scope").toBe(400);
    expect((await none.json()).code).toBe("event_admin_competition_required");

    const email = mk();
    const ok = await world.eaApi.post("/api/admin/participants/desk-invite", {
      headers: H(world.eaCsrf), data: { email, firstName: "Walk", lastName: "Up", competitionId: world.mine.id },
    });
    expect(ok.ok(), `desk-invite into my own event: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    const made = await ok.json();
    expect(made.code, "…and it hands over a sign-in code").toBeTruthy();
    // The account it made really is in the actor's own list — an account created
    // outside every scope INCLUDING its creator's is the failure the 400 above
    // prevents, so prove this one is not that.
    const list = await (await world.eaApi.get("/api/admin/participants?limit=5000")).json();
    expect(ids(list.participants), "the organiser can see who they just created").toContain(made.id);

    // THE CONTROL: both refusals are legitimate for a global admin.
    const c1 = await world.sa.post("/api/admin/participants/desk-invite", {
      headers: H(world.saCsrf), data: { email: mk(), firstName: "Walk", lastName: "Up", competitionId: world.theirs.id },
    });
    expect(c1.ok(), `superadmin desk-invite into the decoy: ${c1.status()} ${await c1.text()}`).toBeTruthy();
    const c2 = await world.sa.post("/api/admin/participants/desk-invite", {
      headers: H(world.saCsrf), data: { email: mk(), firstName: "Walk", lastName: "Up" },
    });
    expect(c2.ok(), `superadmin desk-invite with NO event is legitimate: ${c2.status()}`).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THE TAG VOCABULARY
  // ═══════════════════════════════════════════════════════════════════════════

  test("GET /api/admin/tags narrows the free-text tags but ALWAYS carries staff + benchmark", async () => {
    // A platform-wide DISTINCT turns this filter menu into a directory of every
    // label any organiser has ever invented. The permanent pair is platform
    // vocabulary rather than somebody's data — the analytics filter bar renders
    // its exclusion chips from this list, so dropping them because no visible
    // participant happens to carry one removes the controls that decide who
    // counts on a board.
    const secret = `ea-secret-${uniq("t")}`.toLowerCase().slice(0, 50);
    const visible = `ea-visible-${uniq("t")}`.toLowerCase().slice(0, 50);
    const t1 = await world.sa.post(`/api/admin/participants/${world.inTheirs.id}/tags`, {
      headers: H(world.saCsrf), data: { tag: secret },
    });
    expect(t1.ok(), `tag the decoy participant: ${t1.status()} ${await t1.text()}`).toBeTruthy();
    const t2 = await world.sa.post(`/api/admin/participants/${world.inMine.id}/tags`, {
      headers: H(world.saCsrf), data: { tag: visible },
    });
    expect(t2.ok(), `tag the visible participant: ${t2.status()} ${await t2.text()}`).toBeTruthy();

    const ea = await world.eaApi.get("/api/admin/tags");
    expect(ea.ok(), `event-admin tags: ${ea.status()}`).toBeTruthy();
    const eaTags = await ea.json();
    // THE POSITIVE CONTROL: a free-text tag on somebody they CAN see is present,
    // so "the secret tag is absent" cannot be satisfied by a build that returns
    // nothing but the permanent pair.
    expect(eaTags, "a tag on a participant in one of their events IS offered").toContain(visible);
    expect(eaTags, "a tag on a participant in nobody's event of theirs is NOT").not.toContain(secret);
    expect(eaTags, "`staff` is platform vocabulary and always ships").toContain("staff");
    expect(eaTags, "…as is `benchmark`").toContain("benchmark");

    // THE CONTROL: an unscoped actor sees the secret tag, so its absence above is
    // a narrowing rather than a tag that was never written.
    const saTags = await (await world.sa.get("/api/admin/tags")).json();
    expect(saTags).toContain(secret);
    expect(saTags).toContain(visible);

    // The zero-grant actor gets the permanent pair and NOTHING else — the
    // fail-open catcher one endpoint over.
    const zeroTags = await (await world.zeroApi.get("/api/admin/tags")).json();
    expect(zeroTags.sort(), "no grants means no free-text vocabulary at all").toEqual(["benchmark", "staff"]);
  });
});
