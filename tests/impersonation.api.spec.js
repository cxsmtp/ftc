// @ts-check
// Participant impersonation (v7.14.0): permission tiers (regular admin
// read-only vs superadmin full access), the global write gate + its
// navigation/telemetry allowlist, solve-clock suppression, analytics exclusion
// (challenge_events.impersonated), audit trail, session interplay with
// single-session enforcement, forced-exit on target-lifecycle failure, and the
// exit/restore path. All state is created fresh in this file — the seeded
// comps/participants are never mutated (worker DBs are shared across files).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}
function dbAll(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
function dbRun(sql, ...args) {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
}

// Register (password chosen at sign-up) + verify + approve; returns the user id.
async function mkParticipant(api, H, email, nick) {
  const reg = await freshCtx();
  const r = await registerPost(reg.api, "/api/register", { headers: h(reg.csrf), data: {
    firstName: "Imp", lastName: "Target", nickname: nick, email,
    company: "Acme", title: "Engineer", avatar: "🦊",
    country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "New York",
    password: PARTICIPANT_PASS,
  }});
  if (r.status() >= 400) throw new Error(`register ${email} failed: ${r.status()} ${await r.text()}`);
  await reg.api.dispose();
  const all = await (await api.get(`/api/admin/participants?limit=1000&search=${encodeURIComponent(email)}`)).json();
  const u = (all.participants || []).find(p => p.email === email);
  if (!u) throw new Error(`could not find ${email} after register`);
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
  return u.id;
}

// Participant + promotion to a real (regular) admin account.
async function mkAdmin(api, H, email, nick) {
  const id = await mkParticipant(api, H, email, nick);
  const r = await api.post(`/api/admin/participants/${id}/role`, { headers: H, data: { role: "admin" } });
  if (r.status() !== 200) throw new Error(`promote ${email} failed: ${r.status()} ${await r.text()}`);
  return id;
}

async function mkTask(api, H, compId, title, answer) {
  const r = await api.post("/api/admin/tasks", { headers: H, data: {
    title, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: answer, explanation: "<p>e</p>", hint: "a hint", status: "published",
  }});
  const bankId = (await r.json()).id;
  const a = await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H, data: { competitionIds: [compId] } });
  if (!a.ok()) throw new Error(`assign ${title}: ${a.status()} ${await a.text()}`);
  return (await a.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what is answered in it
}

// Impersonate `targetId` from a fresh session logged in as `email`
// (superadmin builtin when email === "superadmin"). Returns the live ctx —
// caller must dispose.
async function impersonate(email, targetId, password) {
  const s = email === "superadmin" ? await apiLogin("superadmin") : await apiLogin(email, password || PARTICIPANT_PASS);
  const r = await s.api.post(`/api/admin/participants/${targetId}/impersonate`, { headers: h(s.csrf) });
  const d = await r.json().catch(() => ({}));
  // Session was regenerated — refresh the CSRF token for subsequent writes.
  const t = await (await s.api.get("/api/csrf-token")).json();
  return { api: s.api, csrf: t.csrfToken, status: r.status(), body: d };
}

let ST; // suite state, built once (fullyParallel:false — within-file serial)

test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const comp = await (await api.post("/api/admin/competitions", { headers: H, data: {
    name: `Imp Live ${stamp}`, start_time: new Date(Date.now() - 30 * 60_000).toISOString(), duration_minutes: 300,
  }})).json();
  const compId = comp.competition.id;
  const taskA = await mkTask(api, H, compId, `ImpTask A ${stamp}`, "answer-a");
  const taskB = await mkTask(api, H, compId, `ImpTask B ${stamp}`, "answer-b");

  const tgtEmail = `imp-target-${stamp}@acme.com`;
  const tgtId = await mkParticipant(api, H, tgtEmail, `imp_tgt_${stamp}`);
  const admEmail = `imp-admin-${stamp}@acme.com`;
  const admId = await mkAdmin(api, H, admEmail, `imp_adm_${stamp}`);
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [tgtId], competitionIds: [compId] } });

  ST = { stamp, compId, taskA, taskB, tgtEmail, tgtId, admEmail, admId };
  await api.dispose();
});

test.describe("Participant impersonation (v7.14.0)", () => {

  test("enter (superadmin): /api/me becomes the target + impersonation block; admin surface rejected; exit restores", async () => {
    const s = await impersonate("superadmin", ST.tgtId);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.ok).toBe(true);
    expect(s.body.readOnly, "superadmin-origin impersonation is NOT read-only").toBe(false);
    expect(s.body.target.id).toBe(ST.tgtId);

    const me = await (await s.api.get("/api/me")).json();
    expect(me.email).toBe(ST.tgtEmail);
    // v8.8.6 — the block grew two fields, and the exact-shape assertion is KEPT
    // rather than loosened: it is what pins the contract the SPA reads. The two
    // new values are the UNSCOPED ones, so this now also asserts that a superadmin
    // impersonation is not narrowed — which is the control the scope feature needs
    // and did not previously have anywhere in this file.
    // v8.12.1 — the block grew `view` and `target_role`, and the exact-shape
    // assertion is KEPT again: a participant target is always in the
    // participant view, and the role is what the client keys the banner on.
    expect(me.impersonation).toEqual({
      active: true, superadmin: true, admin_label: "superadmin",
      scoped_to_my_events: false, withheld_event_count: 0,
      view: "participant", target_role: "participant",
      // the built-in superadmin holds certificates.lookup (operator ruling, 23 Nov 2026)
      certificate_codes: true,
    });
    expect(me.isAdminView, "impersonation session must NOT read as admin view").toBe(false);
    expect(me.userRole).toBe("participant");

    // v8.12.1 — toggle-admin-view is NO LONGER blocked under impersonation: it
    // is the in-session view switch, and it CARRIES the marker through its
    // regenerate (the v7.14.0 review-fix refused it because it used to drop the
    // marker — the fix moved from refusing the door to making the door safe).
    // For a PARTICIPANT target the admin view does not exist, so `mode:"admin"`
    // is refused with the same message a participant would get, the
    // participant mode is an idempotent no-op, and in BOTH cases the marker
    // survives — asserted through every path spelling Express accepts, since a
    // variant that dropped the marker would be the old defect through a side
    // door. `tests/impersonation-event-admin-view.api.spec.js` drives the
    // admin view for the target that has one.
    for (const url of ["/api/toggle-admin-view", "/api/toggle-admin-view/", "/API/Toggle-Admin-View"]) {
      const adm = await s.api.post(url, { headers: h(s.csrf), data: { mode: "admin" } });
      expect(adm.status(), `POST ${url} (mode=admin) on a participant target`).toBe(403);
      expect((await adm.json()).error).toBe("You do not have admin access");
      const afterAdm = await (await s.api.get("/api/me")).json();
      expect(afterAdm.impersonation?.active, `the marker survives a refused admin-view switch via ${url}`).toBe(true);
      expect(afterAdm.isAdminView).toBe(false);
      const par = await s.api.post(url, { headers: h(s.csrf), data: { mode: "participant" } });
      expect(par.status(), `POST ${url} (mode=participant) is a no-op under impersonation`).toBe(200);
      const pb = await par.json();
      expect(pb.impersonation, "the toggle answers with the impersonation block").toMatchObject({ active: true, view: "participant", target_role: "participant" });
      expect(pb.isSuperAdmin, "an impersonation session never reads as superadmin").toBe(false);
      const afterPar = await (await s.api.get("/api/me")).json();
      expect(afterPar.impersonation?.active, `the marker survives a participant-view switch via ${url}`).toBe(true);
      expect(afterPar.email).toBe(ST.tgtEmail);
      // The toggle regenerates the session (privilege boundary), so the token moves.
      s.csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
    }

    // The sign-in code doors are refused under impersonation for every tier
    // (`_IMPERSONATION_BLOCKED`): an admin viewing as someone may not request a
    // code for any address, or untie one, while the session carries another
    // person's identity.
    for (const url of ["/api/auth/code/request", "/api/auth/code/request/", "/API/Auth/Code/Request", "/api/auth/code/drop-event", "/API/Auth/Code/Drop-Event/"]) {
      const sp = await s.api.post(url, { headers: h(s.csrf), data: { email: "anyone@example.com" } });
      expect(sp.status(), `POST ${url} must be refused for every impersonation tier`).toBe(403);
      expect((await sp.json()).code).toBe("impersonation_readonly");
    }

    // Admin surface is rejected outright (isAdmin unset on the session).
    const adminList = await s.api.get("/api/admin/participants?limit=1");
    expect([401, 403]).toContain(adminList.status());
    const adminMe = await s.api.get("/api/admin/me");
    expect(adminMe.status()).toBe(401);

    // Exit → superadmin restored.
    const ex = await s.api.post("/api/impersonation/exit", { headers: h(s.csrf) });
    expect(ex.status()).toBe(200);
    expect((await ex.json()).isSuperAdmin).toBe(true);
    const restored = await s.api.get("/api/admin/me");
    expect(restored.status()).toBe(200);
    expect((await restored.json()).isSuperAdmin).toBe(true);
    await s.api.dispose();
  });

  test("audit trail: impersonation_started/ended user_events on the TARGET, attributed to the acting admin", async () => {
    // v8.3.16 — DRIVE THE CYCLE THIS TEST READS. The two events were written by
    // the enter/exit test above, so this one passed only because that sibling had
    // run: alone it failed on `impersonation_started present in the target's
    // history → undefined`. A superadmin enter + manual exit is what produces the
    // exact pair asserted below (read_only:false, reason:"manual"), so doing it
    // here is also what makes those assertions about THIS test's own action.
    const cycle = await impersonate("superadmin", ST.tgtId);
    expect(cycle.status, `impersonation entered: ${JSON.stringify(cycle.body)}`).toBe(200);
    const exited = await cycle.api.post("/api/impersonation/exit", { headers: h(cycle.csrf) });
    expect(exited.status(), "impersonation exited cleanly").toBe(200);
    await cycle.api.dispose();

    const { api, csrf } = await apiLogin("superadmin");
    const evs = await (await api.get(`/api/admin/participants/${ST.tgtId}/events?limit=100`)).json();
    const rows = evs.events || [];
    const started = rows.find(e => e.event_type === "impersonation_started");
    const ended = rows.find(e => e.event_type === "impersonation_ended");
    expect(started, "impersonation_started present in the target's history").toBeTruthy();
    expect(ended, "impersonation_ended present in the target's history").toBeTruthy();
    expect(started.changed_by).toBe("superadmin");
    expect(ended.changed_by).toBe("superadmin");
    const sDet = typeof started.details === "string" ? JSON.parse(started.details) : (started.details || {});
    expect(sDet.read_only, "superadmin-origin start records read_only:false").toBe(false);
    expect(sDet.ip, "reqContext attached (identity/auth event convention)").toBeTruthy();
    const eDet = typeof ended.details === "string" ? JSON.parse(ended.details) : (ended.details || {});
    expect(eDet.reason).toBe("manual");
    expect(typeof eDet.duration_ms).toBe("number");
    await api.dispose();
  });

  test("permission tiers: privileged targets are off-limits for EVERYONE; participants can't enter; CSRF required", async () => {
    // Superadmin → admin-role target: 403.
    const sa = await apiLogin("superadmin");
    const r1 = await sa.api.post(`/api/admin/participants/${ST.admId}/impersonate`, { headers: h(sa.csrf) });
    expect(r1.status(), "even superadmin cannot impersonate a privileged account").toBe(403);
    // CSRF required.
    const r2 = await sa.api.post(`/api/admin/participants/${ST.tgtId}/impersonate`);
    expect(r2.status()).toBe(403);
    expect((await r2.json()).error).toBe("csrf_invalid");
    await sa.api.dispose();

    // Regular admin → superadmin/admin target: 403 (peer-admin doctrine).
    const adm = await apiLogin(ST.admEmail, PARTICIPANT_PASS);
    const r3 = await adm.api.post(`/api/admin/participants/${ST.admId}/impersonate`, { headers: h(adm.csrf) });
    expect(r3.status()).toBe(403);
    await adm.api.dispose();

    // Participant session: requireAdmin rejects.
    const tgt = await apiLogin(ST.tgtEmail, PARTICIPANT_PASS);
    const r4 = await tgt.api.post(`/api/admin/participants/${ST.tgtId}/impersonate`, { headers: h(tgt.csrf) });
    expect([401, 403]).toContain(r4.status());
    await tgt.api.dispose();
  });

  test("target eligibility: blocked / unapproved targets are rejected 409 with a stable reason; unverified is allowed", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${ST.stamp}-elig`;
    // Blocked.
    const blockedId = await mkParticipant(api, H, `imp-blocked-${s}@acme.com`, `imp_blk_${s}`);
    await api.post(`/api/admin/participants/${blockedId}/block`, { headers: H });
    const r1 = await api.post(`/api/admin/participants/${blockedId}/impersonate`, { headers: H });
    expect(r1.status()).toBe(409);
    expect(await r1.json()).toMatchObject({ error: "impersonation_target_inactive", reason: "blocked" });
    // Unapproved (registered, never verified/approved → not_approved reported first).
    const reg = await freshCtx();
    const uaEmail = `imp-unapproved-${s}@acme.com`;
    await registerPost(reg.api, "/api/register", { headers: h(reg.csrf), data: {
      firstName: "I", lastName: "U", nickname: `imp_ua_${s}`, email: uaEmail,
      company: "Acme", title: "E", country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
    }});
    await reg.api.dispose();
    const ua = (await (await api.get(`/api/admin/participants?limit=1000&search=${encodeURIComponent(uaEmail)}`)).json()).participants.find(p => p.email === uaEmail);
    const r2 = await api.post(`/api/admin/participants/${ua.id}/impersonate`, { headers: H });
    expect(r2.status()).toBe(409);
    expect((await r2.json()).reason).toBe("not_approved");
    // v7.15.8 — UNVERIFIED is deliberately NOT refused any more: a stuck,
    // unverified account is exactly the one an admin needs to look at, and
    // verification gates the PARTICIPANT signing in, not an admin inspecting
    // their view. blocked / denied / not-approved remain refusals above.
    const uvId = await mkParticipant(api, H, `imp-unverified-${s}@acme.com`, `imp_uv_${s}`);
    dbRun("UPDATE users SET verified=0 WHERE id=?", uvId);
    const r3 = await api.post(`/api/admin/participants/${uvId}/impersonate`, { headers: H });
    expect(r3.status(), "an unverified participant IS impersonatable").toBe(200);
    await api.dispose();
  });

  test("regular admin is READ-ONLY: every state-changing action 403s with the exact modal message and writes nothing", async () => {
    const s = await impersonate(ST.admEmail, ST.tgtId);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.readOnly).toBe(true);
    const me = await (await s.api.get("/api/me")).json();
    expect(me.impersonation).toMatchObject({ active: true, superadmin: false, admin_label: ST.admEmail });

    // Navigation IS allowed: select-competition passes the gate...
    const sel = await s.api.post("/api/select-competition", { headers: h(s.csrf), data: { competitionId: ST.compId } });
    expect(sel.status(), await sel.text()).toBe(200);
    // ...but stamps NOTHING durable (the solve clock + auto-resume are suppressed).
    const cu = dbGet("SELECT login_time, last_login_time FROM competition_users WHERE competition_id=? AND user_id=?", ST.compId, ST.tgtId);
    expect(cu.login_time, "solve clock must NOT start from an impersonated visit").toBeNull();
    expect(cu.last_login_time).toBeNull();
    expect(dbGet("SELECT active_competition_id FROM users WHERE id=?", ST.tgtId).active_competition_id).toBeNull();

    // Reads work.
    expect((await s.api.get("/api/tasks")).status()).toBe(200);
    expect((await s.api.get("/api/status")).status()).toBe(200);
    expect((await s.api.get("/api/leaderboard")).status()).toBe(200);
    expect((await s.api.get("/api/my-competitions")).status()).toBe(200);

    // State-changing actions: all rejected by the global gate, none reach a handler.
    const blocked = [
      ["POST", `/api/tasks/${ST.taskA}/submit`, { answer: "answer-a" }],
      ["POST", `/api/tasks/${ST.taskB}/hint`, {}],
      ["PUT", "/api/me", { city: "Blockedville" }],
      ["PUT", `/api/tasks/${ST.taskA}/feedback`, { rating: 5 }],
      ["POST", "/api/select-timeslot", { timeslotId: "x" }],
      ["POST", "/api/dismiss-ended", {}],
      // `POST /api/competitions/join` LEFT this list: joining is refused for
      // EVERY tier while impersonating, with its own code
      // (`impersonation_join_refused`; operator ruling, 21 Nov 2026), and is
      // asserted for both tiers in tests/impersonation-join.spec.js.
      ["POST", `/api/competitions/${ST.compId}/reminder`, {}],
      // v8.3.25 — `POST /api/competitions/:id/badge` USED to be on this list and
      // is now the read-only tier's one durable carve-out. Its own describe
      // below drives it end to end, with the controls that stop "the mint
      // works" being satisfied by a build that simply switched the tier off.
      // v8.12.1 — `POST /api/toggle-admin-view` LEFT this list: it is the
      // in-session view switch now, allowed for every tier like
      // select-competition, and asserted separately below.
    ];
    for (const [method, url, data] of blocked) {
      const r = method === "PUT"
        ? await s.api.put(url, { headers: h(s.csrf), data })
        : await s.api.post(url, { headers: h(s.csrf), data });
      const d = await r.json().catch(() => ({}));
      expect(r.status(), `${method} ${url} must be blocked`).toBe(403);
      expect(d.code, `${method} ${url} carries the impersonation_readonly code`).toBe("impersonation_readonly");
      expect(d.error).toBe("Not allowed in impersonation mode");
    }
    // Nothing was written.
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND competition_id=?", ST.tgtId, ST.compId).c).toBe(0);
    expect(dbGet("SELECT COUNT(*) c FROM hint_reveals WHERE user_id=? AND competition_id=?", ST.tgtId, ST.compId).c).toBe(0);
    expect(dbGet("SELECT city FROM users WHERE id=?", ST.tgtId).city).not.toBe("Blockedville");

    // review-fix (CRITICAL): Express routes case-INSENSITIVELY, so a
    // case-variant path reaches the same handler. The guard must normalise —
    // pre-fix `PUT /API/me` walked straight past the read-only gate and
    // rewrote the target's profile.
    for (const [method, url] of [["PUT", "/API/me"], ["POST", "/API/select-timeslot"], ["POST", `/API/tasks/${ST.taskA}/submit`]]) {
      const r = method === "PUT"
        ? await s.api.put(url, { headers: h(s.csrf), data: { city: "CaseBypass" } })
        : await s.api.post(url, { headers: h(s.csrf), data: { timeslotId: "x", answer: "answer-a" } });
      expect(r.status(), `${method} ${url} must be blocked despite the case variant`).toBe(403);
      expect((await r.json()).code).toBe("impersonation_readonly");
    }
    expect(dbGet("SELECT city FROM users WHERE id=?", ST.tgtId).city).not.toBe("CaseBypass");

    // v8.12.1 — toggle-admin-view is the in-session view switch and passes the
    // read-only gate like select-competition does. On a PARTICIPANT target the
    // admin view does not exist (403, the participant's own message), the
    // participant mode is a no-op, and the marker survives both — the v7.14.0
    // defect this used to pin (a regenerate dropping the marker) is asserted
    // as "still impersonating afterwards" rather than as a refusal.
    const tavAdm = await s.api.post("/api/toggle-admin-view", { headers: h(s.csrf), data: { mode: "admin" } });
    expect(tavAdm.status()).toBe(403);
    expect((await tavAdm.json()).error).toBe("You do not have admin access");
    const tav = await s.api.post("/api/toggle-admin-view", { headers: h(s.csrf), data: { mode: "participant" } });
    expect(tav.status(), await tav.text()).toBe(200);
    const meAfterTav = await (await s.api.get("/api/me")).json();
    expect(meAfterTav.impersonation, "the marker survives the view switch").toMatchObject({ active: true, superadmin: false, view: "participant" });
    expect(meAfterTav.email).toBe(ST.tgtEmail);
    // The toggle regenerates the session, so every later write needs the new token.
    s.csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;

    // Background telemetry stays allowed and is flagged impersonated.
    //
    // It has to stay allowed: it is fired by the SPA on a timer, and blocking it
    // would surface random error modals while an admin is merely looking. So the
    // protection is the flag, not a refusal — an admin browsing a participant's
    // challenges must not move that participant's navigated-away figure.
    const nav = await s.api.post(`/api/tasks/${ST.taskA}/navigated-away`, { headers: h(s.csrf), data: { via: "test" } });
    expect(nav.status()).toBe(200);
    const navRow = dbGet("SELECT impersonated FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='navigated_away'", ST.tgtId, ST.taskA);
    expect(navRow, "navigated_away row written").toBeTruthy();
    expect(navRow.impersonated).toBe(1);

    // Keepalive + exit stay reachable.
    expect((await s.api.post("/api/session/keepalive", { headers: h(s.csrf) })).status()).toBe(200);
    const ex = await s.api.post("/api/impersonation/exit", { headers: h(s.csrf) });
    expect(ex.status()).toBe(200);
    expect((await ex.json()).isSuperAdmin, "regular admin exits back to NON-super admin").toBe(false);
    const restored = await s.api.get("/api/admin/me");
    expect(restored.status()).toBe(200);

    // v7.21.17 — the flag must actually reach ANALYTICS. The row-level assertion
    // above proves the column is SET; it says nothing about whether the
    // aggregation reads it, which is the part an operator sees. Read AFTER the
    // exit: an impersonation session is participant-shaped, so the admin
    // endpoint is (correctly) unreachable from inside it.
    //
    // The superadmin test covers solve / incorrect / hint the same way. A
    // REGULAR admin is the tier that can produce ONLY this event — every other
    // write is refused — so the one event they CAN generate needs its own check.
    const anR = await (await s.api.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${ST.compId}&_=${Date.now()}`)).json();
    expect(anR.summary, "analytics must be readable once impersonation has ended").toBeTruthy();
    expect(anR.summary.navigated_away,
      "a regular admin browsing a participant's challenges must not move their navigated-away count").toBe(0);
    expect(anR.summary.unique_participants,
      "…and must not make the target look like an active participant").toBe(0);
    await s.api.dispose();
  });

  test("superadmin full access: real submission/hint land for the target, but analytics EXCLUDES impersonated events", async () => {
    const s = await impersonate("superadmin", ST.tgtId);
    expect(s.status).toBe(200);
    await s.api.post("/api/select-competition", { headers: h(s.csrf), data: { competitionId: ST.compId } });
    // Clock suppression holds for superadmins too.
    expect(dbGet("SELECT login_time FROM competition_users WHERE competition_id=? AND user_id=?", ST.compId, ST.tgtId).login_time).toBeNull();

    // v7.21.17 — an INCORRECT submit too. The analytics block below asserts
    // `summary.incorrect === 0`, and until now no wrong answer was ever
    // submitted under impersonation, so that assertion held whether or not
    // incorrect events were excluded — it could not fail. "Both successful and
    // unsuccessful" is the actual requirement, so both have to happen here.
    const wrong = await s.api.post(`/api/tasks/${ST.taskA}/submit`, {
      headers: h(s.csrf),
      data: { answer: "definitely-not-the-answer", gradingHash: await gradingHashFor(s.api, ST.taskA) },
    });
    expect(wrong.status(), await wrong.text()).toBe(200);
    expect((await wrong.json()).correct, "the fixture needs a genuinely WRONG answer").toBe(false);
    // It is a REAL submission — the penalty lands on the target, exactly like
    // the correct one above. Only the ANALYTICS signal is filtered.
    await expect.poll(() => {
      const row = dbGet("SELECT impersonated FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='incorrect'", ST.tgtId, ST.taskA);
      return row ? row.impersonated : -1;
    }, { timeout: 5000, intervals: [50, 100, 200, 400, 800] }).toBe(1);
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=? AND is_correct=0", ST.tgtId, ST.taskA).c,
      "the wrong answer is a real, scored submission — it is only hidden from ANALYTICS").toBeGreaterThan(0);

    // Correct submit — REAL row, attributed to the target.
    const sub = await s.api.post(`/api/tasks/${ST.taskA}/submit`, { headers: h(s.csrf), data: { answer: "answer-a" , gradingHash: await gradingHashFor(s.api, ST.taskA)} });
    expect(sub.status(), await sub.text()).toBe(200);
    expect((await sub.json()).correct).toBe(true);
    const subRow = dbGet("SELECT is_correct FROM submissions WHERE user_id=? AND task_id=? AND competition_id=?", ST.tgtId, ST.taskA, ST.compId);
    expect(subRow.is_correct).toBe(1);

    // challenge_events row is deferred — poll; must carry impersonated=1 + impersonated_by.
    await expect.poll(() => {
      const row = dbGet("SELECT impersonated, details FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='solved'", ST.tgtId, ST.taskA);
      return row ? row.impersonated : -1;
    }, { timeout: 5000, intervals: [50, 100, 200, 400, 800] }).toBe(1);
    const solvedRow = dbGet("SELECT details FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='solved'", ST.tgtId, ST.taskA);
    expect(JSON.parse(solvedRow.details).impersonated_by).toBe("superadmin");

    // Hint — real deduction row, flagged event.
    const hint = await s.api.post(`/api/tasks/${ST.taskB}/hint`, { headers: h(s.csrf) });
    expect(hint.status()).toBe(200);
    expect(dbGet("SELECT points_deducted FROM hint_reveals WHERE user_id=? AND task_id=?", ST.tgtId, ST.taskB).points_deducted).toBeGreaterThan(0);
    expect(dbGet("SELECT impersonated FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='hint_revealed'", ST.tgtId, ST.taskB).impersonated).toBe(1);

    // The submit audit events carry impersonated_by for forensics (deferred → poll).
    await expect.poll(() => {
      const rows = dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type='submission_correct'", ST.tgtId);
      return rows.some(r => (r.details || "").includes('"impersonated_by":"superadmin"'));
    }, { timeout: 5000, intervals: [50, 100, 200, 400, 800] }).toBe(true);

    // The impersonated score is REAL on the leaderboard (documented behaviour).
    const lb = await (await s.api.get("/api/leaderboard")).json();
    expect(lb.me, "target appears on the board via the impersonated solve").toBeTruthy();

    // Analytics: everything impersonated is EXCLUDED.
    await s.api.post("/api/impersonation/exit", { headers: h(s.csrf) });
    const an1 = await (await s.api.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${ST.compId}&_=${Date.now()}`)).json();
    expect(an1.summary.solved, "impersonated solve must not count").toBe(0);
    expect(an1.summary.hint_revealed, "impersonated hint must not count").toBe(0);
    expect(an1.summary.navigated_away, "impersonated nav-away must not count").toBe(0);
    expect(an1.summary.incorrect, "an impersonated WRONG answer must not count either").toBe(0);
    expect(an1.summary.unique_participants).toBe(0);

    // A REAL participant action still counts (and stamps the clock normally: on
    // entry, or at the first open where the event starts it there).
    const tgt = await apiLogin(ST.tgtEmail, PARTICIPANT_PASS);
    await tgt.api.post("/api/select-competition", { headers: h(tgt.csrf), data: { competitionId: ST.compId } });
    expect((await tgt.api.get(`/api/tasks/${ST.taskB}`)).ok()).toBeTruthy();
    expect(dbGet("SELECT login_time FROM competition_users WHERE competition_id=? AND user_id=?", ST.compId, ST.tgtId).login_time, "REAL entry and open stamp the clock").toBeTruthy();
    await tgt.api.post(`/api/tasks/${ST.taskB}/submit`, { headers: h(tgt.csrf), data: { answer: "wrong-guess" , gradingHash: await gradingHashFor(tgt.api, ST.taskB)} });
    await tgt.api.dispose();
    await expect.poll(async () => {
      const an2 = await (await s.api.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${ST.compId}&_=${Date.now()}`)).json();
      return an2.summary.incorrect;
    }, { timeout: 5000, intervals: [100, 200, 400, 800] }).toBe(1);
    const an3 = await (await s.api.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${ST.compId}&_=${Date.now()}`)).json();
    expect(an3.summary.solved, "the impersonated solve stays excluded").toBe(0);
    expect(an3.summary.unique_participants, "only the real actor counts").toBe(1);
    await s.api.dispose();
  });

  test("/api/me cache isolation: the impersonation session never shares the target's cached payload", async () => {
    // Target's real session selects the comp → their /api/me carries competitionId.
    const tgt = await apiLogin(ST.tgtEmail, PARTICIPANT_PASS);
    await tgt.api.post("/api/select-competition", { headers: h(tgt.csrf), data: { competitionId: ST.compId } });
    const meReal = await (await tgt.api.get("/api/me")).json();
    expect(meReal.competitionId).toBe(ST.compId);
    expect(meReal.impersonation).toBeUndefined();

    // Fresh impersonation session (no comp selected) — must NOT see the cached
    // competitionId from the target's own session, and vice versa.
    const s = await impersonate("superadmin", ST.tgtId);
    const meImp = await (await s.api.get("/api/me")).json();
    expect(meImp.impersonation?.active).toBe(true);
    expect(meImp.competitionId, "impersonation session has ITS OWN comp context").toBeNull();

    const meReal2 = await (await tgt.api.get("/api/me")).json();
    expect(meReal2.competitionId, "target's own session context intact").toBe(ST.compId);
    expect(meReal2.impersonation, "impersonation block never leaks to the real user").toBeUndefined();

    await s.api.post("/api/impersonation/exit", { headers: h(s.csrf) });
    await s.api.dispose();
    await tgt.api.dispose();
  });

  test("session interplay: target login does NOT kick the impersonation session; the admin's own re-login DOES", async () => {
    // (a) target logs in while impersonated → impersonation session survives,
    // and the target's fresh session works too (no mutual kicking).
    const s = await impersonate(ST.admEmail, ST.tgtId);
    expect(s.status).toBe(200);
    const tgt = await apiLogin(ST.tgtEmail, PARTICIPANT_PASS);
    const meAfterTargetLogin = await s.api.get("/api/me");
    expect(meAfterTargetLogin.status(), "target login must not destroy the admin's impersonation session").toBe(200);
    expect((await meAfterTargetLogin.json()).impersonation?.active).toBe(true);
    expect((await tgt.api.get("/api/me")).status()).toBe(200);
    await tgt.api.dispose();

    // (b) the ADMIN logging in again kills their impersonation session
    // (single-session-per-user, keyed to the impersonator).
    const admFresh = await apiLogin(ST.admEmail, PARTICIPANT_PASS);
    const meAfterAdminLogin = await s.api.get("/api/me");
    expect(meAfterAdminLogin.status(), "admin re-login must invalidate their impersonation session").toBe(401);
    await admFresh.api.dispose();
    await s.api.dispose();
  });

  test("forced exit: target blocked mid-impersonation → 403 impersonation_ended + admin session restored (never destroyed)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s2 = `${ST.stamp}-forced`;
    const victimId = await mkParticipant(api, H, `imp-forced-${s2}@acme.com`, `imp_fx_${s2}`);

    const s = await impersonate(ST.admEmail, victimId);
    expect(s.status).toBe(200);
    expect((await s.api.get("/api/me")).status()).toBe(200);

    // Block the target out-of-band (from the superadmin session).
    await api.post(`/api/admin/participants/${victimId}/block`, { headers: H });

    const r = await s.api.get("/api/me");
    expect(r.status()).toBe(403);
    const d = await r.json();
    expect(d.error).toBe("impersonation_ended");
    expect(d.reason).toBe("target_inactive");
    // The session is the ADMIN's again — not destroyed.
    const restored = await s.api.get("/api/admin/me");
    expect(restored.status()).toBe(200);
    expect((await restored.json()).isAdmin).toBe(true);
    // review-fix (MEDIUM): the forced exit is a first-class exit path, so it
    // must close the window in the target's history too — pre-fix it restored
    // the admin silently, leaving an unclosed impersonation_started (duration
    // lost, reads as still-open).
    const evs = (await (await api.get(`/api/admin/participants/${victimId}/events?limit=50`)).json()).events || [];
    expect(evs.some(e => e.event_type === "impersonation_started")).toBe(true);
    const forcedEnd = evs.find(e => e.event_type === "impersonation_ended");
    expect(forcedEnd, "forced exit records impersonation_ended").toBeTruthy();
    const fDet = typeof forcedEnd.details === "string" ? JSON.parse(forcedEnd.details) : (forcedEnd.details || {});
    expect(fDet.reason).toBe("target_inactive");
    expect(forcedEnd.changed_by).toBe(ST.admEmail);
    await s.api.dispose();
    await api.dispose();
  });

  test("logout while impersonating closes the window and never fabricates a logout on the TARGET", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s2 = `${ST.stamp}-logout`;
    const victimId = await mkParticipant(api, H, `imp-logout-${s2}@acme.com`, `imp_lo_${s2}`);
    const before = ((await (await api.get(`/api/admin/participants/${victimId}/events?limit=100`)).json()).events || [])
      .filter(e => e.event_type === "logout_manual").length;

    const s = await impersonate(ST.admEmail, victimId);
    expect(s.status).toBe(200);
    const out = await s.api.post("/api/logout", { headers: h(s.csrf) });
    expect(out.status()).toBe(200);

    const evs = (await (await api.get(`/api/admin/participants/${victimId}/events?limit=100`)).json()).events || [];
    const ended = evs.find(e => e.event_type === "impersonation_ended");
    expect(ended, "logout closes the impersonation window").toBeTruthy();
    expect((typeof ended.details === "string" ? JSON.parse(ended.details) : ended.details).reason).toBe("logout");
    expect(evs.filter(e => e.event_type === "logout_manual").length,
      "the target must NOT be credited with a sign-out they never performed").toBe(before);
    // The logout is attributed to the ADMIN instead.
    const admEvs = (await (await api.get(`/api/admin/participants/${ST.admId}/events?limit=100`)).json()).events || [];
    expect(admEvs.some(e => e.event_type === "logout_manual")).toBe(true);
    // v8.13.4 (fix-delta review) — on the admin's OWN row the seat is named
    // (`acting_as`) but the admin is never named as their own impersonator.
    const det = (e) => (typeof e.details === "string" ? JSON.parse(e.details) : (e.details || {}));
    const seatRows = admEvs.filter(e => e.event_type === "logout_manual" && det(e).acting_as);
    expect(seatRows.length, "PRECONDITION: the impersonated logout row names the seat").toBeGreaterThan(0);
    for (const e of seatRows) expect(det(e).impersonated_by, "no self-naming impersonated_by").toBeUndefined();
    await s.api.dispose();
    await api.dispose();
  });

  test("navigated-away dedup is scoped per stream — an impersonated event never swallows the participant's real one", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s3 = `${ST.stamp}-nav`;
    const uid = await mkParticipant(api, H, `imp-nav-${s3}@acme.com`, `imp_nv_${s3}`);
    await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [uid], competitionIds: [ST.compId] } });
    await api.dispose();

    // Impersonated nav-away first…
    const s = await impersonate(ST.admEmail, uid);
    await s.api.post("/api/select-competition", { headers: h(s.csrf), data: { competitionId: ST.compId } });
    const impNav = await s.api.post(`/api/tasks/${ST.taskA}/navigated-away`, { headers: h(s.csrf), data: { via: "imp" } });
    expect(impNav.status()).toBe(200);
    expect((await impNav.json()).deduped).toBeFalsy();

    // …then the REAL participant's, immediately (inside the 2s window).
    const tgt = await apiLogin(`imp-nav-${s3}@acme.com`, PARTICIPANT_PASS);
    await tgt.api.post("/api/select-competition", { headers: h(tgt.csrf), data: { competitionId: ST.compId } });
    const realNav = await tgt.api.post(`/api/tasks/${ST.taskA}/navigated-away`, { headers: h(tgt.csrf), data: { via: "real" } });
    expect(realNav.status()).toBe(200);
    expect((await realNav.json()).deduped, "the impersonated row must not swallow the real event").toBeFalsy();
    expect(dbGet("SELECT COUNT(*) c FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='navigated_away' AND impersonated=0", uid, ST.taskA).c).toBe(1);
    expect(dbGet("SELECT COUNT(*) c FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='navigated_away' AND impersonated=1", uid, ST.taskA).c).toBe(1);
    await s.api.dispose();
    await tgt.api.dispose();
  });

  // v7.14.1 — the impersonation window must be closed on EVERY path, so the
  // target's history can never keep an unclosed `impersonation_started`.
  test("v7.14.1: a purged impersonation session (admin re-login) closes the window with reason session_purged", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s4 = `${ST.stamp}-purge`;
    const victimId = await mkParticipant(api, H, `imp-purge-${s4}@acme.com`, `imp_pg_${s4}`);
    await api.dispose();

    const s = await impersonate(ST.admEmail, victimId);
    expect(s.status).toBe(200);
    // The ADMIN logs in again elsewhere → single-session enforcement purges
    // their impersonation session (it is owned by the admin, not the target).
    const admFresh = await apiLogin(ST.admEmail, PARTICIPANT_PASS);
    expect((await s.api.get("/api/me")).status(), "impersonation session was purged").toBe(401);

    const ended = dbAll("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", victimId);
    expect(ended.length, "the purge closed the window").toBe(1);
    const det = JSON.parse(ended[0].details || "{}");
    expect(det.reason).toBe("session_purged");
    expect(det.admin_user_id).toBe(ST.admId);
    expect(typeof det.duration_ms).toBe("number");
    expect(ended[0].changed_by).toBe(ST.admEmail);
    // Exactly one start and one end — the window is balanced.
    expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='impersonation_started'", victimId).c).toBe(1);
    await admFresh.api.dispose();
    await s.api.dispose();
  });

  // v7.15.2 (audit) — the last two holes in "EVERY exit path closes the window".
  // /api/login is allowlisted for both tiers as a session-replacing escape hatch,
  // and /api/admin/logout carries no requireAdmin so a superadmin-tier session
  // reaches it. Both destroyed the row carrying the `impersonator` marker before
  // invalidateOtherSessions or the expiry sweep could ever see it, so NEITHER of
  // v7.14.1's other closers fired and the target kept an unclosed window.
  test("v7.15.2: logging in FROM an impersonation session closes the window (reason: login)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const sfx = `${ST.stamp}-loginclose`;
    const victimId = await mkParticipant(api, H, `imp-lgc-${sfx}@acme.com`, `imp_lgc_${sfx}`);
    await api.dispose();

    // The emailed-code door is refused under impersonation at every tier, so the
    // allowlisted escape hatch that remains is the built-in superadmin's
    // break-glass sign-in, from a session the built-in is impersonating in.
    const s = await impersonate("superadmin", victimId);
    expect(s.status).toBe(200);
    const tok = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
    const lg = await codeLogin(s.api, "superadmin", h(tok));
    expect(lg.ok(), "login from an impersonation session succeeds").toBeTruthy();

    const ended = dbAll("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", victimId);
    expect(ended.length, "the login closed the window").toBe(1);
    const det = JSON.parse(ended[0].details || "{}");
    expect(det.reason).toBe("login");
    expect(ended[0].changed_by, "attributed to the acting admin, not the participant").toBe("superadmin");
    expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='impersonation_started'", victimId).c).toBe(1);
    await s.api.dispose();
  });

  test("v7.15.2: /api/admin/logout from a superadmin impersonation session closes the window", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const sfx = `${ST.stamp}-adminlogout`;
    const victimId = await mkParticipant(api, H, `imp-alo-${sfx}@acme.com`, `imp_alo_${sfx}`);
    await api.dispose();

    // Superadmin tier: the guard lets non-GET through, so this route is reachable.
    const s = await impersonate("superadmin", victimId);
    expect(s.status).toBe(200);
    const tok = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
    expect((await s.api.post("/api/admin/logout", { headers: h(tok) })).ok()).toBeTruthy();

    const ended = dbAll("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", victimId);
    expect(ended.length, "admin-logout closed the window").toBe(1);
    expect(JSON.parse(ended[0].details || "{}").reason).toBe("logout");
    // And the participant must NOT be credited with signing out.
    expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='logout_manual'", victimId).c,
      "no fabricated sign-out on the participant's history").toBe(0);
    await s.api.dispose();
  });

  test("v7.14.1: an EXPIRED impersonation session closes the window with reason session_expired", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s5 = `${ST.stamp}-expire`;
    const victimId = await mkParticipant(api, H, `imp-expire-${s5}@acme.com`, `imp_xp_${s5}`);
    await api.dispose();

    const s = await impersonate(ST.admEmail, victimId);
    expect(s.status).toBe(200);
    // Age this session's stored cookie past its expiry, then drive one real GC
    // pass through the test-only endpoint (the 5-minute interval is the only
    // other trigger). Aging alone does NOT stop the session authenticating —
    // express-session honours the signed cookie until the row is swept — which
    // is exactly why the sweep has to emit.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    let aged = 0;
    try {
      for (const r of db.prepare("SELECT id, data FROM express_session").all()) {
        let parsed; try { parsed = JSON.parse(r.data); } catch { continue; }
        if (parsed.impersonator && parsed.userId === victimId) {
          parsed.cookie = { ...(parsed.cookie || {}), expires: new Date(Date.now() - 60_000).toISOString() };
          db.prepare("UPDATE express_session SET data=? WHERE id=?").run(JSON.stringify(parsed), r.id);
          aged++;
        }
      }
    } finally { db.close(); }
    expect(aged, "found the impersonation session to age").toBe(1);

    const sweep = await (await s.api.post("/api/test/sweep-sessions", { headers: h(s.csrf) })).json();
    expect(sweep.ok).toBe(true);
    expect(sweep.impersonationsClosed, "the sweep closed the impersonation window").toBeGreaterThanOrEqual(1);

    const ended = dbAll("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", victimId);
    expect(ended.length).toBe(1);
    const det = JSON.parse(ended[0].details || "{}");
    expect(det.reason).toBe("session_expired");
    expect(det.admin_user_id).toBe(ST.admId);
    expect(typeof det.duration_ms).toBe("number");
    expect(ended[0].changed_by).toBe(ST.admEmail);
    // The swept session is genuinely gone.
    expect((await s.api.get("/api/me")).status()).toBe(401);
    await s.api.dispose();
  });

  test("v7.14.1: the forced-exit event carries reqContext (ip / user_agent / req_id / session_id)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s6 = `${ST.stamp}-fctx`;
    const victimId = await mkParticipant(api, H, `imp-fctx-${s6}@acme.com`, `imp_fc_${s6}`);

    const s = await impersonate(ST.admEmail, victimId);
    expect(s.status).toBe(200);
    await api.post(`/api/admin/participants/${victimId}/block`, { headers: H });
    const r = await s.api.get("/api/me");
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe("impersonation_ended");

    const ended = dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", victimId);
    expect(ended.length).toBe(1);
    const det = JSON.parse(ended[0].details || "{}");
    expect(det.reason).toBe("target_inactive");
    expect(det.ip, "reqContext ip").toBeTruthy();
    expect(det.req_id, "reqContext req_id").toBeTruthy();
    expect(det.session_id, "reqContext session_id").toBeTruthy();
    expect(det.user_agent, "reqContext user_agent").toBeTruthy();
    await s.api.dispose();
    await api.dispose();
  });

  test("exit without impersonating → 400; exit re-validates the admin's own lifecycle", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/impersonation/exit", { headers: h(csrf) });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("Not impersonating");
    await api.dispose();
  });
});

// v7.15.8 — impersonating an UNVERIFIED participant must actually WORK, not just
// be enterable. Before this, two gates had to change together: the entry check
// refused with 409 not_verified, and requireParticipant force-exited the session
// on the very next request. Fixing only one would have left the admin entering
// and being bounced straight back out — which is why this asserts a real request
// succeeds inside the session, not merely that the POST returned 200.
test.describe("Impersonating an unverified participant (v7.15.8)", () => {
  test("entry succeeds AND the session survives real requests", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const uvId = await mkParticipant(api, H, `imp-uv2-${s}@acme.com`, `imp_uv2_${s}`);
    dbRun("UPDATE users SET verified=0 WHERE id=?", uvId);
    await api.dispose();

    const sess = await impersonate("superadmin", uvId);
    expect(sess.status, "an unverified participant can be impersonated").toBe(200);

    // The session must not be force-exited by requireParticipant on the next
    // request — /api/me is the participant surface the admin came to look at.
    const me = await sess.api.get("/api/me");
    expect(me.status(), "the impersonation session survives (no forced exit)").toBe(200);
    const body = await me.json();
    expect(body.impersonation && body.impersonation.active, "banner state is present").toBe(true);
    // And it really is the unverified target's view.
    expect(body.verified, "the admin sees the target's ACTUAL verification state").toBe(false);

    // A competition-scoped participant endpoint also passes the guard rather
    // than tearing the session down.
    const mc = await sess.api.get("/api/my-competitions");
    expect(mc.status(), "participant endpoints work inside the session").toBeLessThan(500);
    expect(mc.status()).not.toBe(403);

    const ex = await sess.api.post("/api/impersonation/exit", { headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken) });
    expect(ex.ok(), "exit still restores the admin").toBeTruthy();
    await sess.api.dispose();
  });

  // v7.21.4 — v7.15.8's own note says "TWO gates had to move together". There
  // were FOUR. The two it missed are the ones the SPA hits on a timer, so the
  // feature was unusable for exactly the account type it was extended to cover:
  //
  //   GET  /api/session/status   — _sessionMonTick fires it IMMEDIATELY inside
  //        startSessionMonitor (not after 30 s). With !verified applied it
  //        returned active:false, which _classifySignout turns into "You were
  //        signed out due to inactivity" the instant the view loaded; the popup
  //        does not POST logout, so the reload re-entered and fired again.
  //   POST /api/session/keepalive — force-exited the admin and wrote a spurious
  //        impersonation_ended{target_inactive} onto the PARTICIPANT's History.
  //
  // The keepalive one was MASKED by the status one (the tick returns before its
  // keepalive block when active:false), so both must move or the fix is partial.
  test("v7.21.4: the session-status probe reports an unverified target's session ACTIVE", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const uvId = await mkParticipant(api, H, `imp-uv3-${s}@acme.com`, `imp_uv3_${s}`);
    dbRun("UPDATE users SET verified=0 WHERE id=?", uvId);
    await api.dispose();

    const sess = await impersonate("superadmin", uvId);
    expect(sess.status).toBe(200);
    const st = await sess.api.get("/api/session/status");
    expect(st.status()).toBe(200);
    const b = await st.json();
    expect(b.active,
      "an unverified TARGET must not make the ADMIN's impersonation session read as inactive — " +
      "the SPA turns active:false into a 'signed out due to inactivity' popup on arrival"
    ).toBe(true);
    await sess.api.post("/api/impersonation/exit", { headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken) }).catch(() => {});
    await sess.api.dispose();
  });

  test("v7.21.4: keepalive does not force-exit on an unverified target, and writes no spurious history", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const uvId = await mkParticipant(api, H, `imp-uv4-${s}@acme.com`, `imp_uv4_${s}`);
    dbRun("UPDATE users SET verified=0 WHERE id=?", uvId);
    await api.dispose();

    const sess = await impersonate("superadmin", uvId);
    expect(sess.status).toBe(200);
    const ka = await sess.api.post("/api/session/keepalive", { headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken) });
    expect(ka.status(),
      "keepalive must not force-exit an impersonation session merely because the TARGET is unverified"
    ).toBe(200);
    // The window is still OPEN: no impersonation_ended was written, so the
    // participant's History does not show a peek that never happened.
    expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", uvId).c,
      "a forced exit would leave a spurious impersonation_ended{target_inactive} on the TARGET's history"
    ).toBe(0);
    // Still inside the session afterwards.
    const me = await sess.api.get("/api/me");
    expect(me.status(), "the session survived the keepalive").toBe(200);
    expect((await me.json()).impersonation?.active, "still impersonating").toBe(true);

    await sess.api.post("/api/impersonation/exit", { headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken) }).catch(() => {});
    await sess.api.dispose();
  });

  test("v7.21.4: BLOCKED still force-exits — the relaxation is unverified-only", async () => {
    // The control. Without it, both tests above are satisfied by a build that
    // simply stopped checking the target's lifecycle at all.
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const vId = await mkParticipant(api, H, `imp-uv5-${s}@acme.com`, `imp_uv5_${s}`);
    await api.dispose();

    const sess = await impersonate("superadmin", vId);
    expect(sess.status).toBe(200);
    dbRun("UPDATE users SET blocked=1 WHERE id=?", vId);   // out-of-band, mid-session

    const st = await sess.api.get("/api/session/status");
    expect((await st.json()).active, "a BLOCKED target still reads inactive").toBe(false);
    const ka = await sess.api.post("/api/session/keepalive", { headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken) });
    expect(ka.status(), "a BLOCKED target still force-exits the impersonation session").toBe(403);
    expect((await ka.json()).reason).toBe("target_inactive");
    await sess.api.dispose();
  });
});



// ─────────────────────────────────────────────────────────────────────────────
// v7.21.12 — the ACTING ADMIN is re-read on every write.
//
// Every other authenticated surface re-reads its principal per request. Under
// impersonation the acting principal is the ADMIN, but the session presents the
// participant surface, so requireParticipant / keepalive / status all read the
// TARGET — `req.session.userId` IS the target. The admin's own row was therefore
// read exactly once, at entry, and the read-only-vs-full-write tier came from
// `imp.isSuperAdmin`, frozen at that moment.
//
// Route-driven revocations purge the session (invalidateOtherSessions is
// impersonation-aware), so the reachable gap is the out-of-band class this repo
// already treats as in scope: the participant-import overwrite writes
// role/blocked/verified/approved and calls no session invalidation, and direct
// SQL does the same. These drive that with SQL, which is what the import does.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v7.21.12 — the acting admin is re-validated per write", () => {
  test("a superadmin demoted to ADMIN mid-impersonation drops to the read-only tier", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const target = await mkParticipant(api, H, `imp-rv1-${s}@acme.com`, `imp_rv1_${s}`);
    // A real, user-backed superadmin (the built-in one has no users row and is
    // deliberately exempt from the re-read — same carve-out as requireAdmin).
    const boss = await mkParticipant(api, H, `imp-boss1-${s}@acme.com`, `imp_boss1_${s}`);
    await api.post(`/api/admin/participants/${boss}/role`, { headers: H, data: { role: "superadmin" } });
    await api.dispose();

    const sess = await impersonate(`imp-boss1-${s}@acme.com`, target);
    expect(sess.status, "a user-backed superadmin can impersonate").toBe(200);
    // CONTROL — the write tier works before the demotion, so the refusal below
    // is the re-read and not a broken fixture.
    const before = await sess.api.put("/api/me", {
      headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken),
      data: { city: "Before" },
    });
    expect(before.status(), "superadmin-tier writes are allowed while the role holds").toBe(200);

    // Out-of-band demotion — exactly what the participant-import overwrite does,
    // and it calls no session invalidation. superadmin → ADMIN specifically, not
    // → participant: a demotion all the way out of admin is caught by the
    // lifecycle refusal, which would mask the thing under test. This one still
    // passes the lifecycle check, so the 403 below can only come from the WRITE
    // TIER being re-derived from the live row instead of the entry snapshot.
    // (Verified: with the tier read from `imp.isSuperAdmin` again, this test
    // passed when the target was demoted to participant and fails now.)
    dbRun("UPDATE users SET role='admin' WHERE id=?", boss);

    const after = await sess.api.put("/api/me", {
      headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken),
      data: { city: "After" },
    });
    expect(after.status(),
      "the write tier was read from a snapshot frozen at entry, so an ex-superadmin who is still " +
      "an admin kept SUPERADMIN write access to the target's account for the life of the session"
    ).toBe(403);
    expect(dbGet("SELECT city FROM users WHERE id=?", target).city,
      "and the write must not have landed").toBe("Before");
    await sess.api.dispose();
  });

  test("a BLOCKED admin mid-impersonation is refused outright", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const target = await mkParticipant(api, H, `imp-rv2-${s}@acme.com`, `imp_rv2_${s}`);
    const boss = await mkParticipant(api, H, `imp-boss2-${s}@acme.com`, `imp_boss2_${s}`);
    await api.post(`/api/admin/participants/${boss}/role`, { headers: H, data: { role: "superadmin" } });
    await api.dispose();

    const sess = await impersonate(`imp-boss2-${s}@acme.com`, target);
    expect(sess.status).toBe(200);
    dbRun("UPDATE users SET blocked=1 WHERE id=?", boss);

    const r = await sess.api.put("/api/me", {
      headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken),
      data: { city: "Nope" },
    });
    expect(r.status(), "a blocked ex-admin has no identity to hand back — the session is destroyed").toBe(403);
    expect((await r.json()).error).toMatch(/admin access/i);
    await sess.api.dispose();
  });

  test("the BUILT-IN superadmin is unaffected — it has no users row to re-read", async () => {
    // The control for the carve-out: without it, the re-read would refuse the
    // built-in account on every write and the two tests above would pass for
    // entirely the wrong reason.
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const target = await mkParticipant(api, H, `imp-rv3-${s}@acme.com`, `imp_rv3_${s}`);
    await api.dispose();

    const sess = await impersonate("superadmin", target);
    expect(sess.status).toBe(200);
    const w = await sess.api.put("/api/me", {
      headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken),
      data: { city: "Builtin" },
    });
    expect(w.status(), "the built-in superadmin keeps its write tier").toBe(200);
    expect(dbGet("SELECT city FROM users WHERE id=?", target).city).toBe("Builtin");
    await sess.api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v8.3.25 — the read-only tier's ONE durable carve-out: generating a certificate
// ═══════════════════════════════════════════════════════════════════════════════
//
// Operator instruction: a REGULAR admin must be able to generate a participant's
// certificate while impersonating them, because collecting one is only possible
// from the participant's own screen and at an event the organiser is the person
// standing next to them. Everything else about the read-only tier is unchanged —
// which is what most of this block asserts, since "the mint works" is equally
// satisfied by a build that stopped enforcing the tier at all.

/**
 * An ENDED competition whose sole participant finished it, so they hold a real
 * rank-1 PLACEMENT position on a final board — the shape `_mintEligibility`
 * requires for an attempt-kind certificate.
 *
 * Sole participant on purpose: solving the only challenge fires the all-solved
 * auto-end, which is what makes the competition fully ended without a second
 * admin call — and the assertion below pins that, because a still-live
 * competition would 409 the mint and every refusal in this block would then be
 * about the lifecycle rather than about impersonation.
 */
async function mkEndedCompWithFinisher(tag) {
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  try {
    const stamp = `${tag}-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
    const comp = await (await api.post("/api/admin/competitions", { headers: H, data: {
      name: `Imp Cert ${stamp}`, start_time: new Date(Date.now() - 30 * 60_000).toISOString(), duration_minutes: 300,
    }})).json();
    const compId = comp.competition.id;
    const taskId = await mkTask(api, H, compId, `ImpCertTask ${stamp}`, "cert-answer");
    const tgtEmail = `imp-cert-${stamp}@acme.com`;
    const tgtId = await mkParticipant(api, H, tgtEmail, `impcert_${stamp}`.slice(0, 30));
    const asg = await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [tgtId], competitionIds: [compId] } });
    const asgBody = await asg.json();
    // The assign endpoint SKIPS ineligible users silently, so assert it landed —
    // without this an empty board makes every mint below refuse for a reason
    // that has nothing to do with what is under test.
    expect(asgBody.assigned, `assign failed: ${asg.status()} ${JSON.stringify(asgBody)}`).toBe(1);

    const p = await apiLogin(tgtEmail, PARTICIPANT_PASS);
    const pH = h(p.csrf);
    await p.api.post("/api/select-competition", { headers: pH, data: { competitionId: compId } });
    const sub = await p.api.post(`/api/tasks/${taskId}/submit`, {
      headers: pH, data: { answer: "cert-answer", gradingHash: await gradingHashFor(p.api, taskId) },
    });
    const subBody = await sub.json();
    expect(subBody.correct, `solve failed, no certificate would be offered: ${JSON.stringify(subBody)}`).toBe(true);
    await p.api.dispose();

    expect(dbGet("SELECT ended_at FROM competitions WHERE id=?", compId).ended_at,
      "the all-solved auto-end must have fired — an attempt-kind mint needs a fully ended event").toBeTruthy();
    return { compId, taskId, tgtEmail, tgtId };
  } finally { await api.dispose(); }
}

/**
 * v8.3.34 (external audit) — the certificate as a PRECONDITION, not as a side
 * effect of the test before.
 *
 * The publish test used to read the badge row test #1 had just minted, so run
 * alone it died on `TypeError: Cannot read properties of undefined (reading
 * 'token')` before a single assertion ran. That is v7.21.39's class: the fixture
 * becomes a create-if-missing precondition.
 *
 * IT MINTS AS THE PARTICIPANT THEMSELVES, which is the load-bearing detail. The
 * ordinary path (`requireParticipant` + `requireCompleteProfile` + CSRF) is
 * independent of the read-only carve-out that test #1 is about, so this cannot
 * pass for the reason under test.
 *
 * AND IT MUST NOT MOVE TO `beforeAll`. `POST …/badge` returns an existing badge
 * BEFORE the `badge_minted` emit, so pre-minting would turn test #1's POST into
 * an idempotent re-fetch: its attribution assertion would then read this mint's
 * event and fail — or, minted as the admin, pass while asserting nothing. Called
 * from the test body, it is a no-op in file order (test #1 minted already) and
 * the real thing in isolation.
 */
async function ensureCertificate(fx) {
  const existing = dbGet("SELECT token FROM achievement_badges WHERE user_id=? AND competition_id=?", fx.tgtId, fx.compId);
  if (existing) return existing.token;
  const p = await apiLogin(fx.tgtEmail, PARTICIPANT_PASS);
  try {
    const r = await p.api.post(`/api/competitions/${fx.compId}/badge`, { headers: h(p.csrf) });
    const body = await r.json();
    expect(r.status(), `precondition: the participant mints their own certificate — ${JSON.stringify(body)}`).toBe(200);
    expect(body.token, "precondition: the mint returned a token").toBeTruthy();
    return body.token;
  } finally { await p.api.dispose(); }
}

test.describe("v8.3.25 — a read-only impersonation session generates a certificate, and publishes none", () => {
  let CT;

  test.beforeAll(async () => {
    CT = await mkEndedCompWithFinisher("main");
  });

  test("a REGULAR admin mints the participant's certificate — attributed to the ADMIN, and nothing else opens up", async () => {
    const sess = await impersonate(ST.admEmail, CT.tgtId);
    expect(sess.status, JSON.stringify(sess.body)).toBe(200);
    expect(sess.body.readOnly, "this is the READ-ONLY tier — the whole point of the test").toBe(true);

    const csrf1 = (await (await sess.api.get("/api/csrf-token")).json()).csrfToken;
    const r = await sess.api.post(`/api/competitions/${CT.compId}/badge`, { headers: h(csrf1) });
    const d = await r.json().catch(() => ({}));
    expect(r.status(), `a regular admin must be able to GENERATE the certificate: ${JSON.stringify(d)}`).toBe(200);
    // Operator ruling, 23 Nov 2026: viewed as the holder by an admin who may not
    // look certificates up by code, the answer carries no code and no token.
    expect(d.token, "no token for a hand without certificates.lookup").toBeUndefined();
    expect(d.withheld).toBe(true);

    // The artefact is the PARTICIPANT'S: the row is theirs, and nothing about it
    // came from the caller.
    const row = dbGet("SELECT token, user_id, competition_id, rank, basis, public_code FROM achievement_badges WHERE user_id=? AND competition_id=? AND revoked_at IS NULL", CT.tgtId, CT.compId);
    expect(row, "a real achievement_badges row was written").toBeTruthy();
    expect(JSON.stringify(d), "neither the token nor the code is anywhere in the answer").not.toContain(row.token);
    expect(row.public_code, "PRECONDITION: a new mint carries a code").toBeTruthy();
    expect(JSON.stringify(d)).not.toContain(row.public_code);
    expect(row.user_id, "the certificate belongs to the TARGET, never to the acting admin").toBe(CT.tgtId);
    expect(row.competition_id).toBe(CT.compId);
    expect(row.rank, "rank is re-derived server-side from the final board").toBe(1);
    expect(row.basis).toBe("placement");

    // ATTRIBUTION — without this the competition History would record that the
    // participant published themselves.
    const ev = dbGet("SELECT details FROM competition_events WHERE competition_id=? AND event_type='badge_minted' ORDER BY changed_at DESC LIMIT 1", CT.compId);
    expect(ev, "a badge_minted event was recorded").toBeTruthy();
    const det = JSON.parse(ev.details);
    expect(det.impersonated_by, "the mint must name the impersonating ADMIN").toBe(ST.admEmail);
    expect(det.user_id).toBe(CT.tgtId);

    // Idempotent: the same button re-opens the same certificate rather than
    // minting a second one (the held-certificate CTA re-POSTs here).
    const csrf2 = (await (await sess.api.get("/api/csrf-token")).json()).csrfToken;
    const again = await sess.api.post(`/api/competitions/${CT.compId}/badge`, { headers: h(csrf2) });
    expect(again.status()).toBe(200);
    const againBody = await again.json();
    expect(againBody.token, "a held certificate re-opened as them keeps its token hidden too").toBeUndefined();
    expect(againBody.withheld).toBe(true);
    expect(dbGet("SELECT COUNT(*) c FROM achievement_badges WHERE user_id=? AND competition_id=?", CT.tgtId, CT.compId).c, "the mint is idempotent per (user, competition)").toBe(1);

    // ── THE CONTROL THAT CARRIES THIS WHOLE BLOCK ────────────────────────────
    // "the mint succeeded" is equally true of a build that stopped enforcing the
    // read-only tier altogether, which would be far worse than the defect being
    // fixed. The SAME session must still be refused everything else.
    const csrf3 = (await (await sess.api.get("/api/csrf-token")).json()).csrfToken;
    for (const [method, url, data] of [
      ["PUT", "/api/me", { city: "Carveoutville" }],
      ["POST", `/api/tasks/${CT.taskId}/hint`, {}],
    ]) {
      const rr = method === "PUT"
        ? await sess.api.put(url, { headers: h(csrf3), data })
        : await sess.api.post(url, { headers: h(csrf3), data });
      expect(rr.status(), `${method} ${url} must still be refused — the carve-out is ONE route`).toBe(403);
      expect((await rr.json()).code).toBe("impersonation_readonly");
    }
    expect(dbGet("SELECT city FROM users WHERE id=?", CT.tgtId).city).not.toBe("Carveoutville");
    await sess.api.dispose();
  });

  test("PUBLISHING is not in the carve-out: /badge/:token/shared stays refused for a regular admin, and a superadmin still can", async () => {
    // Generating is not publishing. For a completion certificate this call is
    // what makes the public page live at all, and the dialog's own copy promises
    // the participant that nothing is published until they press Share — so the
    // read-only tier generates and the participant (or a superadmin) publishes.
    const token = await ensureCertificate(CT);
    expect(token, "precondition: the participant holds a certificate to publish").toBeTruthy();
    expect(dbGet("SELECT shared_at FROM achievement_badges WHERE token=?", token).shared_at,
      "precondition: nothing has published it yet").toBeFalsy();

    const ro = await impersonate(ST.admEmail, CT.tgtId);
    const roCsrf = (await (await ro.api.get("/api/csrf-token")).json()).csrfToken;
    const blocked = await ro.api.post(`/badge/${token}/shared`, { headers: h(roCsrf) });
    expect(blocked.status(), "a read-only admin may generate a certificate but never publish one").toBe(403);
    expect((await blocked.json()).code).toBe("impersonation_readonly");
    expect(dbGet("SELECT shared_at FROM achievement_badges WHERE token=?", token).shared_at,
      "and the refusal really did stop the write").toBeFalsy();
    await ro.api.dispose();

    // CONTROL — the route is not simply broken: a SUPERADMIN impersonation
    // session reaches it and stamps the share, exactly as before this release.
    const su = await impersonate("superadmin", CT.tgtId);
    const suCsrf = (await (await su.api.get("/api/csrf-token")).json()).csrfToken;
    const okShare = await su.api.post(`/badge/${token}/shared`, { headers: h(suCsrf) });
    expect(okShare.status(), "the superadmin tier is unchanged").toBe(200);
    expect(dbGet("SELECT shared_at FROM achievement_badges WHERE token=?", token).shared_at).toBeTruthy();
    await su.api.dispose();
  });

  test("the carve-out is ANCHORED: a sibling under the same prefix is refused, a case/slash variant of the mint is not", async () => {
    const sess = await impersonate(ST.admEmail, CT.tgtId);
    const csrf = (await (await sess.api.get("/api/csrf-token")).json()).csrfToken;

    // A route one segment away must not inherit the carve-out. `[^/]+` with no
    // anchors would have matched `/api/competitions/<id>/badge` inside a longer
    // path; an unanchored PREFIX would have swallowed every sibling.
    for (const sib of ["reminder", "leave"]) {
      const r = await sess.api.post(`/api/competitions/${CT.compId}/${sib}`, { headers: h(csrf) });
      expect(r.status(), `POST …/${sib} is not a certificate mint`).toBe(403);
      // The CODE, not merely the status: `leave` has refusals of its own (it is
      // scoped to self-enrolled memberships), so a bare 403 would not tell a
      // widened regex from that route's own answer.
      expect((await r.json()).code, `…/${sib} must be refused BY THE GATE`).toBe("impersonation_readonly");
    }

    // …while the mint itself survives the same normalisation every other gate
    // applies: Express routes case-insensitively and non-strictly, so a
    // raw-path match here would refuse a request that reaches the handler.
    // (A doubled slash is deliberately not in this list: these are
    // `app.post("/api/…")` registrations, which do not route it at all — the
    // v7.15.16 finding was about a MOUNTED handler, `/docs//user-guide/…`.)
    for (const variant of [
      `/API/competitions/${CT.compId}/badge`,
      `/api/competitions/${CT.compId}/badge/`,
    ]) {
      const v = await sess.api.post(variant, { headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken) });
      expect(v.status(), `${variant} must reach the mint, not the read-only refusal`).toBe(200);
    }
    await sess.api.dispose();
  });

  test("the carve-out sits BELOW the per-request re-read: a blocked ex-admin cannot mint", async () => {
    // The placement is the whole of its safety. Hoisting the carve-out above the
    // v7.21.12 re-read reads as a harmless "check the cheap thing first" and
    // would hand somebody who has stopped being an admin a live certificate mint.
    const fx = await mkEndedCompWithFinisher("rev");
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const s = `${Date.now()}`;
    const admEmail = `imp-cert-adm-${s}@acme.com`;
    const admId = await mkAdmin(api, H, admEmail, `impcadm_${s}`.slice(0, 30));
    await api.dispose();

    const sess = await impersonate(admEmail, fx.tgtId);
    expect(sess.status).toBe(200);

    // Out-of-band block — what the participant-import overwrite does, with no
    // session invalidation.
    dbRun("UPDATE users SET blocked=1 WHERE id=?", admId);

    const r = await sess.api.post(`/api/competitions/${fx.compId}/badge`, {
      headers: h((await (await sess.api.get("/api/csrf-token")).json()).csrfToken),
    });
    expect(r.status(), "a blocked ex-admin has no identity to hand back — the session is destroyed").toBe(403);
    expect((await r.json()).error).toMatch(/admin access/i);
    expect(dbGet("SELECT COUNT(*) c FROM achievement_badges WHERE user_id=? AND competition_id=?", fx.tgtId, fx.compId).c,
      "and no certificate was minted").toBe(0);
    await sess.api.dispose();
  });
});
