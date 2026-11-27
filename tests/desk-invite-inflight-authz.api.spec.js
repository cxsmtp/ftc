// @ts-check
//
// v8.12.7 (EXTERNAL AUDIT F1) — THE DESK SHORTCUT, AND THE MAINTENANCE SEEDER,
// RE-ASK AUTHORISATION AT COMMIT.
//
// POST /api/admin/participants/desk-invite decided everything — the actor, the
// event, the competitor lock, the event-admin scope, the address, the admission —
// when the request HEADERS arrived, then awaited a bcrypt hash (a real yield: the
// libuv pool, shared with every login), then created a VERIFIED, APPROVED account
// and handed back a live sign-in code, all synchronously. Only the address and
// the admission were asked again. MEASURED on the unfixed tree with the request
// parked across the hash: an admin blocked, demoted, deleted, signed out, or
// narrowed out of the event there still created the account and received the
// code. POST /api/admin/perf/bulk-seed-users has the same shape one tier up — a
// superadmin demoted to plain admin during its hash still minted a row carrying
// `role: "superadmin"`.
//
// v8.12.6 recorded the desk window as a residual because "36 races landed
// nothing" and a guard no test can reach reads as protection while unlocked. The
// commit park (`POST /api/test/admin-commit-delay`, which both routes now call
// immediately before the re-check) makes the window deterministic: every PARK arm
// polls the server's own `parked` counter, acts, and releases — never a sleep.
//
// ── THREE KINDS OF ARM, AND WHY EACH ─────────────────────────────────────────
//
// PARK arms revoke through the real routes (or direct SQL, for the out-of-band
// shape) while the request is provably parked AFTER the hash. A route-driven
// revocation also tombstones the session, so on those arms the lifecycle half and
// the tombstone half both refuse; status and code tell them apart (403
// admin_access_revoked vs 401 admin_session_ended), and the SQL arm is the sole
// pin of the lifecycle half on this route.
//
// CACHE arms need no park, and are the only way to pin the scope re-ask's cache
// drop. The event-admin role and scope are cached for 2 s per user, a request of
// the actor's own fills them at its headers, and a cache HIT does not refresh the
// timestamp — so an entry filled a while ago can expire under the arm and the
// mutation that drops the invalidation would survive. Each cache arm therefore
// FLUSHES the actor's entries with an idempotent superadmin write (a re-grant, or
// the same role posted again — neither changes the role, so neither purges a
// session), WARMS them with one request of the actor's own, changes the database
// directly (no tombstone, no invalidation), and sends at once. It then asserts,
// as a named precondition, that the whole thing finished inside the 2 s window —
// or it cannot tell a fresh read from an expired entry, and says so.
//
// CONTROLS run through the same armed park with nothing done during it, so the
// re-check really runs on the success path — without them "it was refused" is
// equally satisfied by a build that refuses every desk invite, or that asks the
// superadmin tier of an admin route.
//
// Every refusal asserts the status, the machine code, the sentence where the
// server gives one, that the body carries no account and no code, and — in the
// database — that no users row, no audit row naming the address, and no
// enrolment was left behind.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, TEST_DB_PATH, TEST_DATA_DIR } = require("./helpers");
const { H, uniq, makeParticipant, grantEventAdmin, makeCompetition, enrol } = require("./event-admin-helpers");
const { signIn, sessionIdOf, makeAdmin, parked } = require("./admin-inflight-helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const PARK_MS = 1500;
const CACHE_WINDOW_MS = 1800;   // the role/scope caches live 2 s; leave margin for the response's own trip
const ACCESS_ENDED = "Your administrator access has ended, so nothing was saved.";
const SESSION_ENDED = "Your session ended before this finished, so nothing was saved. Try again — if you are asked to sign in, do that first.";
const OUT_OF_SCOPE = "You are not an organiser of this event. Ask an administrator to add you to it.";
const EVENT_CLOSED = "That event has finished and is not taking late entries.";

function dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }
function dbRun(sql, ...a) { const d = new Database(TEST_DB_PATH); try { return d.prepare(sql).run(...a); } finally { d.close(); } }
const revoked = (sid) => dbGet("SELECT 1 AS x FROM revoked_sessions WHERE id=?", sid);
const deskEmail = (label) => `desk-${uniq(label)}@acme.com`.toLowerCase();
const cuCount = (compId) => (compId ? dbGet("SELECT COUNT(*) c FROM competition_users WHERE competition_id=?", compId).c : 0);
const future = () => new Date(Date.now() + 86_400_000).toISOString();
// The competition-side audit row the desk writes on success — inside the same
// transaction, so a refusal at commit must leave none (each arm owns its event).
const deskCompEvents = (compId) => dbGet(
  "SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='user_added' AND details LIKE '%\"via\":\"desk_invite\"%'", compId).c;

function desk(api, csrf, email, competitionId) {
  return api.post("/api/admin/participants/desk-invite", { headers: H(csrf),
    data: { email, firstName: "Desk", lastName: "Walkup", ...(competitionId ? { competitionId } : {}) } });
}

/**
 * The request was refused AT COMMIT and left nothing behind. `cuDelta` is the
 * number of enrolments the ARM ITSELF added to the event during the park (the
 * competitor arm enrols the admin), so the assertion stays about the desk.
 */
async function expectNothingCreated(r, want, email, compId, cuBefore, cuDelta = 0) {
  const body = await r.json().catch(() => ({}));
  expect(r.status(), `${want.what}: ${JSON.stringify(body)}`).toBe(want.status);
  // A success puts the sign-in CODE in this same key, so the refusal's machine
  // code standing there is also the "no credential was handed over" half.
  expect(body.code, `${want.what}: the machine code`).toBe(want.code);
  if (want.error !== undefined) expect(body.error, `${want.what}: the sentence`).toBe(want.error);
  expect(body.ok, `${want.what}: not a success body`).toBeUndefined();
  for (const k of ["id", "nickname", "expires_in_minutes"]) expect(body[k], `${want.what}: no ${k} in a refusal`).toBeUndefined();
  expect(dbGet("SELECT 1 AS x FROM users WHERE LOWER(email)=LOWER(?)", email), `${want.what}: no account was created`).toBeUndefined();
  expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE details LIKE ?", `%"email":"${email}"%`).c,
    `${want.what}: no audit row names the address (the create transaction rolled back)`).toBe(0);
  if (compId) {
    expect(cuCount(compId), `${want.what}: nobody was enrolled by the desk`).toBe(cuBefore + cuDelta);
    expect(deskCompEvents(compId), `${want.what}: the event's own History records no desk admission`).toBe(0);
  }
  return body;
}

test.describe("v8.12.7 (F1) — an admin revoked while the desk shortcut hashes creates nothing and is handed no code", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  /** A signed-in global admin and a live Competition of their own to desk into. */
  async function armed(label, compExtra = {}) {
    const p = await makeAdmin(sa, saCsrf, label, "admin");
    const s = await signIn(p.email, PARTICIPANT_PASS);
    const comp = await makeCompetition(sa, saCsrf, `${label}c`, compExtra);
    return { p, ...s, sid: await sessionIdOf(s.api), comp };
  }
  /** A signed-in event admin, organiser of `comp` (granted BEFORE sign-in: a grant that moves the role purges sessions). */
  async function organiser(label, compExtra = {}) {
    const comp = await makeCompetition(sa, saCsrf, `${label}c`, compExtra);
    const ea = await makeParticipant(sa, saCsrf, label);
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
    const s = await signIn(ea.email, PARTICIPANT_PASS);
    return { p: ea, ...s, sid: await sessionIdOf(s.api), comp };
  }
  const block = (id) => async () => {
    const r = await sa.post(`/api/admin/participants/${id}/block`, { headers: H(saCsrf) });
    expect(r.ok(), `block: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).blocked, "the block TOOK (the route is a toggle)").toBe(1);
  };
  const setRole = (id, role) => async () => {
    const r = await sa.post(`/api/admin/participants/${id}/role`, { headers: H(saCsrf), data: { role } });
    expect(r.ok(), `role ${role}: ${await r.text()}`).toBeTruthy();
  };

  // ── CONTROLS: the park armed, nothing done during it ──────────────────────

  test("CONTROL: an untouched global admin's parked desk invite into an event creates the account, enrols it and hands over a code", async () => {
    const a = await armed("dkok");
    const email = deskEmail("dkok");
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), null, PARK_MS);
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(200);
      expect(body.code, "a sign-in code, formatted for reading out").toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      const row = dbGet("SELECT id, verified, approved, password_set_at, registered_via, profile_policy FROM users WHERE LOWER(email)=LOWER(?)", email);
      expect(row, "the account exists").toBeTruthy();
      expect(row).toMatchObject({ verified: 1, approved: 1, password_set_at: null, registered_via: "desk", profile_policy: "tournament" });
      expect(dbGet("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?", a.comp.id, row.id), "and it is enrolled in the event").toBeTruthy();
      // ANTI-VACUITY for every refusal's audit assertions: the two queries
      // expectNothingCreated uses DO see the rows a successful desk writes, so
      // "zero" on a refusal is an answer, not a pattern that matches nothing.
      expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE details LIKE ?", `%"email":"${email}"%`).c, "the user-side audit query sees a desk account").toBeGreaterThan(0);
      expect(deskCompEvents(a.comp.id), "the event-side audit query sees the desk admission").toBe(1);
    } finally { await a.api.dispose(); }
  });

  test("CONTROL: an untouched organiser's parked desk invite into their own event succeeds", async () => {
    const o = await organiser("dkeaok");
    const email = deskEmail("dkeaok");
    try {
      const r = await parked(sa, () => desk(o.api, o.csrf, email, o.comp.id), null, PARK_MS);
      expect(r.status(), await r.text()).toBe(200);
      const row = dbGet("SELECT id FROM users WHERE LOWER(email)=LOWER(?)", email);
      expect(row && dbGet("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?", o.comp.id, row.id), "enrolled in the organiser's event").toBeTruthy();
    } finally { await o.api.dispose(); }
  });

  test("CONTROL: the built-in superadmin (no users row — the tombstone is its only signal) still commits a parked desk invite with no event", async () => {
    const email = deskEmail("dksa");
    const r = await parked(sa, () => desk(sa, saCsrf, email, null), null, PARK_MS);
    expect(r.status(), await r.text()).toBe(200);
    expect(dbGet("SELECT registered_via FROM users WHERE LOWER(email)=LOWER(?)", email)).toEqual({ registered_via: "desk" });
  });

  // ── PARK arms: the actor ──────────────────────────────────────────────────

  test("an admin BLOCKED through the route while the desk hashes is refused at commit — no account, no code", async () => {
    const a = await armed("dkblk");
    const email = deskEmail("dkblk");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), block(a.p.id), PARK_MS);
      await expectNothingCreated(r, { what: "blocked mid-hash", status: 403, code: "admin_access_revoked", error: ACCESS_ENDED }, email, a.comp.id, before);
    } finally { await a.api.dispose(); }
  });

  // Sweep #501 (operator ruling, 23 Nov 2026): while new accounts wait for
  // approval, a role that cannot approve accounts may not sign anyone up at the
  // desk. Read live at commit (1b), so the setting switched on while the desk
  // hashes refuses it and creates nothing; the same park with the setting left
  // off is the control.
  test("sweep #501: \"Require account approval\" switched on while a role that cannot approve is at the desk refuses it at commit — nothing created", async () => {
    const rr = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `Desk enrol ${uniq("r")}`, scope_mode: "granted", permissions: ["events.view", "participants.view", "participants.enrol"] } });
    expect(rr.ok(), await rr.text()).toBeTruthy();
    const role = (await rr.json()).role;
    const comp = await makeCompetition(sa, saCsrf, "dkapprc");
    const compOk = await makeCompetition(sa, saCsrf, "dkapprokc");   // the control's own event: the refusal's checks count the event's desk admissions
    const holder = await makeParticipant(sa, saCsrf, "dkappr");
    expect((await sa.patch(`/api/admin/users/${holder.id}/role`, { headers: H(saCsrf), data: { role: role.id } })).ok()).toBeTruthy();
    await grantEventAdmin(sa, saCsrf, comp.id, holder.id);
    await grantEventAdmin(sa, saCsrf, compOk.id, holder.id);
    const s = await signIn(holder.email, PARTICIPANT_PASS);
    const setApproval = async (on) => {
      const r = await sa.patch("/api/admin/settings", { headers: H(saCsrf), data: { require_account_approval: on } });
      expect(r.ok(), await r.text()).toBeTruthy();
    };
    try {
      // CONTROL: the setting left off, the parked desk sign-up commits.
      const okEmail = deskEmail("dkapprok");
      const ok = await parked(sa, () => desk(s.api, s.csrf, okEmail, compOk.id), null, PARK_MS);
      expect(ok.status(), await ok.text()).toBe(200);
      const email = deskEmail("dkappr");
      const before = cuCount(comp.id);
      const r = await parked(sa, () => desk(s.api, s.csrf, email, comp.id), () => setApproval(true), PARK_MS);
      await expectNothingCreated(r, { what: "approval required mid-hash", status: 403, code: "desk_approval_required" }, email, comp.id, before);
    } finally { await setApproval(false); await s.api.dispose(); }
  });

  test("an OUT-OF-BAND block (direct SQL, no tombstone) is refused — the lifecycle half, the only arm that pins it on this route", async () => {
    const a = await armed("dkoob");
    const email = deskEmail("dkoob");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => { dbRun("UPDATE users SET blocked=1 WHERE id=?", a.p.id); }, PARK_MS);
      expect(a.sid, "PRECONDITION: the session id was read from the cookie").toBeTruthy();
      expect(revoked(a.sid), "PRECONDITION: THIS session was not tombstoned — only the row can refuse").toBeUndefined();
      await expectNothingCreated(r, { what: "SQL-blocked mid-hash", status: 403, code: "admin_access_revoked", error: ACCESS_ENDED }, email, a.comp.id, before);
    } finally { await a.api.dispose(); }
  });

  test("a DEMOTED admin is refused — the role is re-read, not only the block", async () => {
    const a = await armed("dkdem");
    const email = deskEmail("dkdem");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), setRole(a.p.id, "participant"), PARK_MS);
      await expectNothingCreated(r, { what: "demoted mid-hash", status: 403, code: "admin_access_revoked", error: ACCESS_ENDED }, email, a.comp.id, before);
    } finally { await a.api.dispose(); }
  });

  test("a DELETED admin cannot create an approved account", async () => {
    const a = await armed("dkdel");
    const email = deskEmail("dkdel");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => {
        const d = await sa.delete(`/api/admin/participants/${a.p.id}`, { headers: H(saCsrf) });
        expect(d.ok(), `delete: ${d.status()} ${await d.text()}`).toBeTruthy();
        expect(dbGet("SELECT 1 AS x FROM users WHERE id=?", a.p.id), "PRECONDITION: the account is gone").toBeUndefined();
      }, PARK_MS);
      await expectNothingCreated(r, { what: "deleted mid-hash", status: 403, code: "admin_access_revoked", error: ACCESS_ENDED }, email, a.comp.id, before);
    } finally { await a.api.dispose(); }
  });

  test("a sign-in ELSEWHERE ends the session and the write — the tombstone half, the account untouched, and the sentence names no upload", async () => {
    const a = await armed("dkelse");
    const email = deskEmail("dkelse");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => { const o = await signIn(a.p.email, PARTICIPANT_PASS); await o.api.dispose(); }, PARK_MS);
      expect(revoked(a.sid), "PRECONDITION: the sign-in elsewhere tombstoned THIS session").toBeTruthy();
      expect(dbGet("SELECT role, blocked FROM users WHERE id=?", a.p.id), "PRECONDITION: the account itself is untouched").toEqual({ role: "admin", blocked: 0 });
      const body = await expectNothingCreated(r, { what: "signed in elsewhere mid-hash", status: 401, code: "admin_session_ended", error: SESSION_ENDED }, email, a.comp.id, before);
      // The v8.12.6 sentence said "before your upload finished" — and an admin at
      // the desk has uploaded nothing. Asserted apart from the exact match so a
      // revert names what it got wrong.
      expect(body.error, "the session-ended sentence is action-neutral").not.toMatch(/upload/i);
    } finally { await a.api.dispose(); }
  });

  // ── PARK arms: the entity ─────────────────────────────────────────────────

  test("an organiser whose grant on the event is REVOKED while the desk hashes is refused — a revoke writes no tombstone, so only the scope re-ask can", async () => {
    const o = await organiser("dkrev");
    const email = deskEmail("dkrev");
    const before = cuCount(o.comp.id);
    try {
      const r = await parked(sa, () => desk(o.api, o.csrf, email, o.comp.id), async () => {
        const d = await sa.delete(`/api/admin/competitions/${o.comp.id}/admins/${o.p.id}`, { headers: H(saCsrf) });
        expect(d.ok(), `revoke: ${d.status()} ${await d.text()}`).toBeTruthy();
      }, PARK_MS);
      expect(revoked(o.sid), "PRECONDITION: no tombstone — only the scope re-ask can refuse").toBeUndefined();
      expect(dbGet("SELECT role FROM users WHERE id=?", o.p.id), "PRECONDITION: the role itself is unchanged").toEqual({ role: "event_admin" });
      await expectNothingCreated(r, { what: "grant revoked mid-hash", status: 403, code: "event_admin_out_of_scope", error: OUT_OF_SCOPE }, email, o.comp.id, before);
    } finally { await o.api.dispose(); }
  });

  test("an admin ENROLLED in the event (staff compete) while the desk hashes is refused by the competitor lock at commit", async () => {
    // A compete event with a future start, so the enrolment is legal for a staff
    // account (v8.12.0) and admission stays open.
    const a = await armed("dkcmp", { staff_compete: true, start_time: future() });
    const email = deskEmail("dkcmp");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => { await enrol(sa, saCsrf, a.comp.id, [a.p.id]); }, PARK_MS);
      const body = await expectNothingCreated(r, { what: "enrolled mid-hash", status: 403, code: "competitor_cannot_edit" }, email, a.comp.id, before, 1);
      expect(body.competitionId, "the refusal names the event, in refuseCompetitor's own shape").toBe(a.comp.id);
      expect(body.competitionName).toBe(a.comp.name);
      expect(body.error).toMatch(/You are competing in/);
    } finally { await a.api.dispose(); }
  });

  test("an event ENDED while the desk hashes refuses the walk-up with the pre-check's own 409 (v8.12.6's defence in depth, now locked)", async () => {
    // A Competition, not a Booth Event: a Booth Event would admit a late entrant.
    const a = await armed("dkend");
    const email = deskEmail("dkend");
    const before = cuCount(a.comp.id);
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => {
        const e = await sa.post(`/api/admin/competitions/${a.comp.id}/end-now`, { headers: H(saCsrf) });
        expect(e.ok(), `end-now: ${e.status()} ${await e.text()}`).toBeTruthy();
      }, PARK_MS);
      expect(dbGet("SELECT ended_at FROM competitions WHERE id=?", a.comp.id).ended_at, "PRECONDITION: the event really ended").toBeTruthy();
      // The pre-check's own 409 carries no `code` — so the key a success fills
      // with the sign-in code is absent, which is the no-credential half here.
      await expectNothingCreated(r, { what: "ended mid-hash", status: 409, code: undefined, error: EVENT_CLOSED }, email, a.comp.id, before);
    } finally { await a.api.dispose(); }
  });

  test("the address REGISTERED by somebody else while the desk hashes answers the named 409, not the generic conflict (v8.1.7, now locked)", async () => {
    const a = await armed("dkdup");
    const email = deskEmail("dkdup");
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => {
        const { api: anon, csrf } = await freshCtx();
        try {
          const tag = uniq("dkdupr").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
          const reg = await registerPost(anon, "/api/register", { headers: H(csrf), data: {
            email, password: PARTICIPANT_PASS, nickname: tag, firstName: "Self", lastName: "Registered",
            company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" } });
          expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
        } finally { await anon.dispose(); }
      }, PARK_MS);
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(409);
      expect(body.code, "the purpose-written refusal, not the UNIQUE fallback's `conflict`").toBe("email_taken");
      const rows = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const all = rows.prepare("SELECT registered_via FROM users WHERE LOWER(email)=LOWER(?)").all(email);
        expect(all, "exactly one account — the self-registration, not the desk's").toHaveLength(1);
        expect(all[0].registered_via).not.toBe("desk");
      } finally { rows.close(); }
      for (const k of ["ok", "id", "nickname", "expires_in_minutes"]) expect(body[k], `no ${k} in the refusal`).toBeUndefined();
      expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE details LIKE ? AND details LIKE '%desk_invite%'", `%"email":"${email}"%`).c,
        "the desk wrote no audit row for the address (its transaction rolled back)").toBe(0);
      expect(deskCompEvents(a.comp.id), "and no desk admission on the event").toBe(0);
    } finally { await a.api.dispose(); }
  });

  test("an upcoming event DELETED while the desk hashes answers the pre-check's own 404, not a misworded 409", async () => {
    const a = await armed("dkgone", { start_time: future() });
    const email = deskEmail("dkgone");
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => {
        const d = await sa.delete(`/api/admin/competitions/${a.comp.id}`, { headers: H(saCsrf) });
        expect(d.ok(), `delete event: ${d.status()} ${await d.text()}`).toBeTruthy();
        expect(dbGet("SELECT 1 AS x FROM competitions WHERE id=?", a.comp.id), "PRECONDITION: the event is gone").toBeUndefined();
      }, PARK_MS);
      // The event is gone, so there is no enrolment count to compare — the
      // cascade took the rows; `compId` is passed as null for that reason.
      await expectNothingCreated(r, { what: "event deleted mid-hash (no account — least of all one enrolled nowhere)", status: 404, code: undefined, error: "Event not found." }, email, null, 0);
    } finally { await a.api.dispose(); }
  });

  test("an event's KIND changed while the desk hashes: the account is stamped with the kind AT COMMIT, not the one read at the headers", async () => {
    // `profile_policy` is the completion gate's FALLBACK for a desk account
    // (v8.12.8: the live answer comes from `registration_competition_id`, and the
    // stamped kind takes over the day the event is deleted), so a stale kind would
    // demand, or waive, the wrong fields for the rest of that account's life.
    const a = await armed("dkkind", { start_time: future() });
    const email = deskEmail("dkkind");
    try {
      const r = await parked(sa, () => desk(a.api, a.csrf, email, a.comp.id), async () => {
        const u = await sa.put(`/api/admin/competitions/${a.comp.id}`, { headers: H(saCsrf), data: { event_kind: "booth" } });
        expect(u.ok(), `kind change: ${u.status()} ${await u.text()}`).toBeTruthy();
        expect(dbGet("SELECT event_kind FROM competitions WHERE id=?", a.comp.id), "PRECONDITION: the kind changed").toEqual({ event_kind: "booth" });
      }, PARK_MS);
      expect(r.status(), await r.text()).toBe(200);
      expect(dbGet("SELECT profile_policy FROM users WHERE LOWER(email)=LOWER(?)", email), "the policy of the event as it stood at commit").toEqual({ profile_policy: "booth" });
      // v8.12.8 — and the pointer names the event itself, so the gate reads the
      // form as it stands NOW (a kind change after the desk is reflected too).
      expect(dbGet("SELECT registration_competition_id r FROM users WHERE LOWER(email)=LOWER(?)", email), "linked to the event it was created for").toEqual({ r: a.comp.id });
    } finally { await a.api.dispose(); }
  });

  // ── CACHE arms: no park, the actor's 2 s caches flushed, warmed, then made stale ──

  /**
   * Warm the actor's role and scope caches with one request of their own (the
   * event-admin guard reads the role, the list's scope filter reads the grants),
   * returning the instant the warm-up was sent — the caches cannot have been
   * filled before it, so `Date.now() - t0` bounds their age at commit.
   */
  async function warm(api) {
    const t0 = Date.now();
    const r = await api.get("/api/admin/competitions");
    expect(r.ok(), `warm-up: ${r.status()}`).toBeTruthy();
    return t0;
  }
  const expectInsideCacheWindow = (t0) => expect(Date.now() - t0,
    "PRECONDITION: the 2 s cache window expired before the re-check — the arm cannot tell a fresh read from an expired entry " +
    "(a pathologically slow box; the source arm below still holds the ordering)").toBeLessThan(CACHE_WINDOW_MS);

  test("CACHE: an organiser's grant deleted OUT OF BAND (no tombstone, caches warm) is refused — the scope is re-read, not served from the 2 s cache", async () => {
    const o = await organiser("dkcache");
    const email = deskEmail("dkcache");
    const before = cuCount(o.comp.id);
    try {
      await grantEventAdmin(sa, saCsrf, o.comp.id, o.p.id);        // idempotent re-grant: drops the actor's cache entries, purges nothing
      const t0 = await warm(o.api);
      dbRun("DELETE FROM competition_admins WHERE competition_id=? AND user_id=?", o.comp.id, o.p.id);
      const r = await desk(o.api, o.csrf, email, o.comp.id);
      expectInsideCacheWindow(t0);
      expect(revoked(o.sid), "PRECONDITION: no tombstone").toBeUndefined();
      await expectNothingCreated(r, { what: "grant deleted out of band", status: 403, code: "event_admin_out_of_scope", error: OUT_OF_SCOPE }, email, o.comp.id, before);
    } finally { await o.api.dispose(); }
  });

  test("CACHE: a global admin narrowed to event admin OUT OF BAND must name an event — the role is re-read, and the no-event branch is re-asked", async () => {
    const a = await armed("dknarrow");
    try {
      // CONTROL first: untouched, a global admin may desk-invite with no event.
      const ok = await desk(a.api, a.csrf, deskEmail("dknarrowok"), null);
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      const email = deskEmail("dknarrow");
      await setRole(a.p.id, "admin")();                          // the same role again: drops the actor's cache entries, purges nothing
      expect(revoked(a.sid), "PRECONDITION: the same-role post purged nothing").toBeUndefined();
      const t0 = await warm(a.api);
      dbRun("UPDATE users SET role='event_admin' WHERE id=?", a.p.id);
      const r = await desk(a.api, a.csrf, email, null);
      expectInsideCacheWindow(t0);
      expect(dbGet("SELECT role FROM users WHERE id=?", a.p.id), "PRECONDITION: narrowed in the database").toEqual({ role: "event_admin" });
      expect(revoked(a.sid), "PRECONDITION: no tombstone").toBeUndefined();
      await expectNothingCreated(r, { what: "narrowed out of band, no event", status: 400, code: "event_admin_competition_required",
        error: "Choose which of your events this person is joining — an account created without one would not appear in your participants list." }, email, null, 0);
    } finally { await a.api.dispose(); }
  });

  test("CACHE: through an organiser's panel, the SEAT's grant deleted out of band is refused — the seat's caches are dropped, not the hand's", async () => {
    const comp = await makeCompetition(sa, saCsrf, "dkseatc");
    const hand = await makeAdmin(sa, saCsrf, "dkseath", "superadmin");
    const seat = await makeAdmin(sa, saCsrf, "dkseats", "event_admin");
    await grantEventAdmin(sa, saCsrf, comp.id, seat.id);
    const s = await signIn(hand.email, PARTICIPANT_PASS);
    const email = deskEmail("dkseat");
    const before = cuCount(comp.id);
    try {
      const e = await s.api.post(`/api/admin/participants/${seat.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
      expect(e.ok(), `impersonate: ${e.status()} ${await e.text()}`).toBeTruthy();
      const csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
      const sid = await sessionIdOf(s.api);
      await grantEventAdmin(sa, saCsrf, comp.id, seat.id);         // drops the SEAT's entries
      const t0 = await warm(s.api);                                // the guard and the scope filter read the SEAT
      dbRun("DELETE FROM competition_admins WHERE competition_id=? AND user_id=?", comp.id, seat.id);
      const r = await desk(s.api, csrf, email, comp.id);
      expectInsideCacheWindow(t0);
      expect(revoked(sid), "PRECONDITION: no tombstone").toBeUndefined();
      await expectNothingCreated(r, { what: "seat's grant deleted out of band", status: 403, code: "event_admin_out_of_scope", error: OUT_OF_SCOPE }, email, comp.id, before);
    } finally { await s.api.dispose(); }
  });

  // ── SOURCE: the order behaviour cannot pin on a pathologically slow box ────

  test("SOURCE: the desk re-asks actor → event → competitor → fresh scope → email → admission inside a write-locked transaction, after the hash", () => {
    // The cache arms fail loudly (a named precondition) rather than pass
    // vacuously if a box outruns the 2 s cache, so this pins what they would
    // then have stopped pinning: the cache drop precedes the scope read. And
    // `.immediate()` — taking the write lock at BEGIN, so an external writer
    // (an operator's sqlite3 session) is waited out rather than turned into a
    // SQLITE_BUSY 500 — is held here. Comments stripped first: the handler's own
    // commentary names every call this checks.
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "participants.js"), "utf8"));
    const reg = src.indexOf('app.post("/api/admin/participants/desk-invite"');
    expect(reg, "the desk-invite registration is where this scanner expects it").toBeGreaterThan(-1);
    const nextReg = src.slice(reg + 1).search(/\napp\.(get|post|put|patch|delete)\s*\(/);
    const h = nextReg < 0 ? src.slice(reg) : src.slice(reg, reg + 1 + nextReg);
    // No password is hashed any more (the account gets the NO_PASSWORD_HASH
    // placeholder), so the commit park is the only yield; the re-checks below
    // must still all sit after it.
    const hashAt = h.indexOf("NO_PASSWORD_HASH");
    const parkAt = h.indexOf("testAdminCommitPark()");
    expect(hashAt, "the placeholder hash is still in the handler").toBeGreaterThan(-1);
    expect(parkAt, "the commit park sits after the placeholder").toBeGreaterThan(hashAt);
    const txAt = h.indexOf("db.transaction(", hashAt);
    expect(txAt, "the create transaction follows the hash").toBeGreaterThan(-1);
    let i = txAt + "db.transaction(".length, depth = 0;
    for (; i < h.length; i++) { const c = h[i]; if (c === "(") depth++; else if (c === ")") { if (depth === 0) break; depth--; } }
    const body = h.slice(txAt, i);
    const at = (needle) => { const k = body.indexOf(needle); expect(k, `the transaction body calls ${needle}`).toBeGreaterThan(-1); return k; };
    const authz = at("adminAuthzDenied(req)");
    const appr = at("_deskApprovalWithheld(req)");
    const fresh = at("FROM competitions WHERE id=?");
    const cmp = at("competitorEditDenied(");
    const inval = at("invalidateEventAdminScope(");
    const scope = at("competitionDenied(");
    const noEvent = at("scopedCompetitionIds(");
    const email = at("emailIsTaken(");
    const adm = at("competitionAdmission(");
    const ins = at("INSERT INTO users");
    expect(authz, "the actor is asked first").toBeLessThan(fresh);
    expect(authz, "then whether they may approve the account (sweep #501)").toBeLessThan(appr);
    expect(appr, "before the event is re-read").toBeLessThan(fresh);
    expect(fresh, "the event is re-read before the competitor lock (a deleted event must 404, not name nobody)").toBeLessThan(cmp);
    expect(cmp, "the competitor lock precedes the scope (the v8.12.0 order)").toBeLessThan(inval);
    expect(inval, "the cache drop precedes the scope read, or the read is the stale cache").toBeLessThan(scope);
    expect(inval).toBeLessThan(noEvent);
    expect(Math.max(scope, noEvent), "scope precedes the address").toBeLessThan(email);
    expect(email).toBeLessThan(adm);
    expect(adm, "every re-check precedes the INSERT").toBeLessThan(ins);
    expect(body.slice(inval - 80, inval + 60), "the dropped caches are the SEAT's (actorId), whose scope is in question").toMatch(/actorId\(req\)/);
    expect(body.slice(0, ins), "nothing is awaited inside the transaction").not.toMatch(/\bawait\b/);
    expect(h.slice(i), "the transaction takes the write lock at BEGIN").toMatch(/\btxn\s*\.\s*immediate\s*\(\s*\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE MAINTENANCE SEEDER — the same window, one tier up
// ═══════════════════════════════════════════════════════════════════════════
//
// POST /api/admin/perf/bulk-seed-users hashes its shared password after
// requireSuperAdmin answered, then inserts up to 5000 rows that may carry any
// role. A superadmin demoted to PLAIN ADMIN during that hash still seeded — and
// the arm below asks for `role: "superadmin"`, the privilege-outliving-revocation
// shape of v8.12.6's participant-import finding. Blocking the account would not
// tell the tiers apart (the admin tier refuses a block too); only a demotion to
// admin can catch a re-check asked at the admin tier.
//
// THE MAINTENANCE-MODE TRAP: the endpoint requires DATA_DIR/.maintenance, and the
// maintenance gate sits in FRONT of every route including the test hooks, so
// everybody signs in BEFORE the file exists and every request afterwards carries
// the bypass header — `parked()` is handed it for its own hook calls. The file is
// removed in an outer `finally`, or every later request in this file 503s.
test.describe("v8.12.7 (F1) — a superadmin demoted while the maintenance seeder hashes seeds nothing", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  test("CONTROL: an untouched superadmin's parked seed mints the row it asked for; demoted to admin during the hash, the same seed mints nothing", async () => {
    const imp = await makeAdmin(sa, saCsrf, "dkseed", "superadmin");
    const s = await signIn(imp.email, PARTICIPANT_PASS);
    const sid = await sessionIdOf(s.api);
    const BYP = `dk-seed-${uniq("byp")}`;
    const MH = { "x-maintenance-bypass": BYP };
    const maint = path.join(TEST_DATA_DIR, ".maintenance");
    const seed = (email) => s.api.post("/api/admin/perf/bulk-seed-users", { headers: { ...H(s.csrf), ...MH }, data: {
      sharedPassword: "testpass123",
      users: [{ email, nickname: `dks${Date.now() % 1e7}${Math.floor(Math.random() * 1e3)}`, firstName: "Seed", lastName: "Row", role: "superadmin" }] } });
    const okEmail = deskEmail("dkseedok"), email = deskEmail("dkseedx");
    fs.writeFileSync(maint, BYP);
    try {
      const ok = await parked(sa, () => seed(okEmail), null, PARK_MS, MH);
      const okBody = await ok.json();
      expect(ok.status(), `CONTROL: ${JSON.stringify(okBody)}`).toBe(200);
      expect(okBody.inserted, "CONTROL: the untouched superadmin seeded the row").toBe(1);
      expect(dbGet("SELECT role FROM users WHERE LOWER(email)=LOWER(?)", okEmail)).toEqual({ role: "superadmin" });

      const r = await parked(sa, () => seed(email), async () => { dbRun("UPDATE users SET role='admin' WHERE id=?", imp.id); }, PARK_MS, MH);
      const body = await r.json();
      expect(revoked(sid), "PRECONDITION: no tombstone — only the superadmin-tier row check can refuse").toBeUndefined();
      expect(dbGet("SELECT role FROM users WHERE id=?", imp.id), "PRECONDITION: demoted to plain admin, still an admin").toEqual({ role: "admin" });
      expect(r.status(), JSON.stringify(body)).toBe(403);
      expect(body.code, "refused at commit, at the SUPERADMIN tier").toBe("admin_access_revoked");
      expect(body.error).toBe(ACCESS_ENDED);
      expect(body.inserted, "not a success body").toBeUndefined();
      expect(dbGet("SELECT 1 AS x FROM users WHERE LOWER(email)=LOWER(?)", email), "a demoted superadmin minted no account — superadmin or otherwise").toBeUndefined();
    } finally {
      try { fs.unlinkSync(maint); } catch (_) {}
      await s.api.dispose();
    }
  });
});
