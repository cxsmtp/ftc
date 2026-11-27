// v8.1.7 — three defects around JOINING and LEAVING that left the record wrong.
//
// All three are forensic rather than functional, which is why a green suite
// never saw them: the membership moved, the participant left, and every
// user-visible outcome was correct. What was wrong was what the platform SAID
// had happened.
//
//   #15  A participant enrolled through a bound GROUP who then joins via the
//        self-enroll link is PROMOTED to a direct member — durable, and
//        consequential, because `reconcileCompetitionMembership` never
//        auto-removes a direct row, so a later removal from the group quietly
//        fails to drop them from the competition. `_selfEnrollEnrollTxn` ran the
//        promotion and then returned on the already-a-member branch BEFORE
//        either emit, so it happened with no event of any kind. The v7.21.32
//        scanner cannot see this class: it checks reqContext on emits that
//        EXIST, not for emits that are absent.
//
//   #44  `POST /api/competitions/:id/leave` recorded its two events through
//        `removeUserFromCompetition`, whose signature could not accept a request
//        context — so a self-service departure carried no ip/ua/req_id, on the
//        one event class a participant may later dispute ("I never left"). The
//        JOIN route in the same file threads reqContext; the ADMIN removal emits
//        the same two event types inline WITH it.
//
//   #39  The session eviction inside that helper updates the STORED session row
//        — which on this path is the CALLER'S OWN, and is then overwritten at
//        end-of-response by express-session re-serialising the in-memory
//        session. Deterministic, not a race: the slide middleware already wrote
//        `req.session.slidAt` at request entry. So the eviction never persisted,
//        `competition_session_cleared {cleared:1}` was a false claim on the
//        participant's History, and `/api/status` — which reads
//        `req.session.competitionId` and is NOT membership-gated — kept
//        answering for the event they had just left.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `lf${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// ── fixtures (this file owns every one of them — fixture checklist #2/#3) ─────

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A LIVE, self-enroll-enabled event, plus its join token. */
async function makeEvent(api, csrf, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Ev`, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true, ...extra,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const rv = await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
  return { comp, token: rv.token };
}

// Verify + approve BEFORE any group bind: the reconciler applies the same skips
// as manual assign (staff / blocked / !approved), so an unapproved participant
// is silently not enrolled and the promotion under test would never happen.
async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Leave", lastName: "Forensic", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  expect(u, `the registration must be findable: ${email}`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// ── direct reads: the events and the session STORE ────────────────────────────
// Read from SQLite rather than through the admin event endpoints, because these
// assertions are about exact `details` fields (ip / user_agent / from_ / to_)
// and the wire shape is not what is under test.

function userEvents(userId, type) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT event_type, changed_by, details FROM user_events WHERE user_id=? AND event_type=? ORDER BY rowid")
      .all(userId, type).map(r => ({ type: r.event_type, actor: r.changed_by, d: JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}
function compEvents(compId, type) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT event_type, changed_by, details FROM competition_events WHERE competition_id=? AND event_type=? ORDER BY rowid")
      .all(compId, type).map(r => ({ type: r.event_type, actor: r.changed_by, d: JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}
function directAssigned(compId, userId) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId)?.direct_assigned;
  } finally { db.close(); }
}
/**
 * Every STORED session row belonging to this user, as its selected competition
 * id (or null). Mirrors `_sessionRowsByField` in lib/sessions.js.
 *
 * This is the observable #39 is about: the in-memory session is not the record,
 * the row is — and pre-fix the row was rewritten from memory at end-of-response.
 */
function storedSessionComps(userId) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const out = [];
    for (const r of db.prepare("SELECT data FROM express_session").all()) {
      let p; try { p = JSON.parse(r.data); } catch { continue; }
      if (p.userId !== userId) continue;
      out.push(p.competitionId || null);
    }
    return out;
  } finally { db.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.1.7 — a silent membership promotion (#15)", () => {
  test("a group-origin member who joins via the link is PROMOTED, and it is recorded under the SAME event type the admin path uses", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    // TWO participants in one bound group: one is promoted by the self-enroll
    // link (the defect), the other by the admin assign path (the incumbent), so
    // "an operator sees one concept, not two" is asserted behaviourally rather
    // than by trusting that two source literals happen to agree.
    const viaLink = await makeParticipant(api, csrf);
    const viaAdmin = await makeParticipant(api, csrf);
    const groupId = (await (await api.post("/api/admin/groups", {
      headers: H(csrf), data: { name: `${uniq()} G`, userIds: [viaLink.id, viaAdmin.id] },
    })).json()).group.id;
    const bind = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { groupIds: [groupId], competitionIds: [ev.comp.id] },
    });
    expect(bind.ok(), `bind: ${await bind.text()}`).toBeTruthy();

    // PRECONDITION. Without a genuinely group-origin row the join INSERTs a new
    // membership instead and the promotion branch is never reached — the test
    // would then fail for a reason that has nothing to do with the fix.
    expect(directAssigned(ev.comp.id, viaLink.id), "the fixture must start group-origin").toBe(0);
    expect(directAssigned(ev.comp.id, viaAdmin.id), "the fixture must start group-origin").toBe(0);
    expect(compEvents(ev.comp.id, "membership_promoted").length, "nothing yet").toBe(0);

    // THE DEFECT: joining via the self-enroll link.
    const ctx = await signIn(viaLink.email);
    const join = await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } });
    expect(join.status(), `join: ${await join.text()}`).toBe(200);
    expect((await join.json()).alreadyMember,
      "precondition: this must be the ALREADY-MEMBER branch, i.e. the promotion, not an insert").toBe(true);

    // The durable change really happened — so the emit is describing something.
    expect(directAssigned(ev.comp.id, viaLink.id), "promoted to a sticky direct membership").toBe(1);

    const ce = compEvents(ev.comp.id, "membership_promoted");
    expect(ce.length, "the self-enroll promotion is recorded").toBe(1);
    expect(ce[0].actor, "attributed to the participant who did it, not the mechanism").toBe(viaLink.email);
    expect(ce[0].d.user_id).toBe(viaLink.id);
    expect(ce[0].d.from_direct_assigned).toBe(0);
    expect(ce[0].d.to_direct_assigned).toBe(1);
    expect(ce[0].d.via, "and which path performed it").toBe("self_enroll");
    expect(ce[0].d.ip, "standing rule 2 — a user-driven event carries the source IP").toBeTruthy();
    const ue = userEvents(viaLink.id, "membership_promoted");
    expect(ue.length, "and on the participant's own History too").toBe(1);
    expect(ue[0].d.competition_id).toBe(ev.comp.id);

    // The INCUMBENT path, for the same transition on the other member.
    const promote = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [viaAdmin.id], competitionIds: [ev.comp.id] },
    });
    expect(promote.ok(), `admin promote: ${await promote.text()}`).toBeTruthy();
    const both = compEvents(ev.comp.id, "membership_promoted");
    expect(both.length, "both paths recorded").toBe(2);
    expect(both[1].type, "ONE concept: the self-enroll path must not invent a second event name")
      .toBe(both[0].type);
    expect(both[1].actor, "the admin promotion is attributed to the admin").toBe("superadmin");
  });

  test("POSITIVE CONTROL — an ordinary first-time self-enrol records its own join and claims NO promotion, and a repeat join stays silent", async () => {
    // Without this, "the promotion is recorded" is equally satisfied by a build
    // that emits `membership_promoted` on EVERY join. The repeat-join half is
    // the one that matters most in production: v7.22.8's stored-token recovery
    // re-joins on every boot, so an unconditional emit would put one line per
    // page load on the participant's History.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);

    const first = await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } });
    expect(first.status(), `join: ${await first.text()}`).toBe(200);
    expect((await first.json()).alreadyMember, "precondition: a genuinely NEW membership").toBe(false);
    expect(userEvents(u.id, "self_enrolled").length, "the join itself is still recorded").toBe(1);
    expect(userEvents(u.id, "membership_promoted").length, "a first-time join promotes nothing").toBe(0);
    expect(compEvents(ev.comp.id, "membership_promoted").length, "…on the competition either").toBe(0);

    // Re-joining an already-DIRECT membership changes nothing durable.
    const again = await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } });
    expect(again.status()).toBe(200);
    expect((await again.json()).alreadyMember, "precondition: the idempotent branch").toBe(true);
    expect(userEvents(u.id, "membership_promoted").length, "a re-join is a no-op and must stay silent").toBe(0);
    expect(compEvents(ev.comp.id, "membership_promoted").length, "…on the competition either").toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.1.7 — a self-service departure is fully attributed (#44)", () => {
  test("the leave events carry the requester's IP and user agent", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);

    // A DISTINCTIVE user agent, so the assertion proves the context came from
    // THIS request. A bare `ip` truthiness check is satisfied by a hard-coded
    // constant; a round-tripped UA is not.
    const UA = `HackArenaLeaveProbe/${uniq()}`;
    const leave = await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, {
      headers: { ...H(ctx.csrf), "user-agent": UA },
    });
    expect(leave.status(), `leave: ${await leave.text()}`).toBe(200);

    const ur = userEvents(u.id, "removed_from_competition");
    expect(ur.length, "the departure is recorded at all (the control for everything below)").toBe(1);
    expect(ur[0].actor, "attributed to the participant").toBe(u.email);
    expect(ur[0].d.via, 'and still marked as self-service').toBe("self");
    expect(ur[0].d.user_agent, "the user agent of the request that did it").toBe(UA);
    expect(ur[0].d.ip, "and its source IP — standing rule 2").toBeTruthy();
    expect(ur[0].d.req_id, "and the request id that joins it to the access log").toBeTruthy();
    expect(ur[0].d.session_id).toBeTruthy();

    const cr = compEvents(ev.comp.id, "user_removed");
    expect(cr.length, "…and on the competition's own trail").toBe(1);
    expect(cr[0].d.via).toBe("self");
    expect(cr[0].d.user_agent, "BOTH emits carry it — the ADMIN removal has always done so").toBe(UA);
    expect(cr[0].d.ip).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.1.7 — the eviction survives the response, and the record is true (#39)", () => {
  test("after a self-leave the caller's own session no longer selects the left event", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);
    expect((await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: ev.comp.id } })).ok()).toBeTruthy();

    // PRECONDITION / POSITIVE CONTROL. `/api/status` is competition-scoped and
    // NOT membership-gated, and it must genuinely answer for this event first —
    // otherwise "the server no longer answers for it" is satisfied by a build in
    // which it never answered.
    const before = await ctx.api.get("/api/status");
    expect(before.status(), `status before leaving: ${await before.text()}`).toBe(200);
    expect((await before.json()).competition_name).toBe(ev.comp.name);
    expect(storedSessionComps(u.id), "precondition: the STORED row carries the selection").toContain(ev.comp.id);

    expect((await ctx.api.post(`/api/competitions/${ev.comp.id}/leave`, { headers: H(ctx.csrf) })).status()).toBe(200);

    // DELIBERATELY NO `GET /api/me` HERE. Its straggler-catcher clears a stale
    // `competitionId` on its own, so a probe that ran it first would pass against
    // the unfixed build and prove nothing about the eviction.
    const after = await ctx.api.get("/api/status");
    expect(after.status(), `pre-fix this is still 200: ${await after.text()}`).toBe(400);
    expect((await after.json()).error, "…and it is the competition guard, not a profile refusal")
      .toMatch(/no event selected/i);

    // The durable half: the STORED row, which pre-fix was rewritten from memory
    // at end-of-response and put the selection straight back.
    await expect.poll(() => storedSessionComps(u.id), { timeout: 5000, intervals: [50, 100, 200, 400, 800] })
      .not.toContain(ev.comp.id);

    // …which is what makes this forensic line true rather than aspirational.
    const cleared = userEvents(u.id, "competition_session_cleared");
    expect(cleared.length, "the eviction is recorded").toBe(1);
    expect(cleared[0].d.cleared, "and it claims a session was cleared").toBeGreaterThan(0);
  });

  test("leaving ONE event does not evict a session selected into ANOTHER", async () => {
    // The guard on my own fix. The Leave control sits on the pending page and
    // the route takes the competition in the path, so a participant can leave A
    // while selected into B — and an unconditional `delete req.session
    // .competitionId` would throw them out of the event they are actually in.
    const { api, csrf } = await sa();
    const evA = await makeEvent(api, csrf);
    const evB = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    const ctx = await signIn(u.email);
    for (const ev of [evA, evB]) {
      expect((await ctx.api.post("/api/competitions/join", { headers: H(ctx.csrf), data: { token: ev.token } })).status()).toBe(200);
    }
    expect((await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: evB.comp.id } })).ok()).toBeTruthy();
    expect((await (await ctx.api.get("/api/status")).json()).competition_name, "precondition: selected into B").toBe(evB.comp.name);

    expect((await ctx.api.post(`/api/competitions/${evA.comp.id}/leave`, { headers: H(ctx.csrf) })).status()).toBe(200);

    const after = await ctx.api.get("/api/status");
    expect(after.status(), `B must still be selected: ${await after.text()}`).toBe(200);
    expect((await after.json()).competition_name, "leaving A left B alone").toBe(evB.comp.name);
    expect(storedSessionComps(u.id), "and the stored row still points at B").toContain(evB.comp.id);
  });
});
